/**
 * Test-only Windows source-launcher acceptance harness.
 *
 * Unlike the direct compiled-Main harness (which hosts a runner fixture in the
 * outer ConPTY), this lane exercises the REAL shipped source wrappers:
 *
 *   cmd.exe /d /s /c <fixture>\scripts\pi-review-sessions.cmd ...
 *   powershell.exe ... -File <fixture>\scripts\pi-review-sessions-node.ps1 ...
 *
 * Each wrapper runs the real shared CJS launcher, which performs its own
 * bounded, lockfile-exact, script-free source-stage install and build before
 * loading the compiled session host and spawning real native Pi children.
 *
 * Native PTY evidence comes from the shared exact observer fixture, loaded as
 * a NODE_OPTIONS preload into the actual launcher process and wrapped at the
 * production lazy-load anchor only. The native lifecycle witness remains the
 * public session_start extension; exact-process exit evidence comes from the
 * retained PowerShell/.NET Process handle fixture.
 *
 * Quoting: the outer shell command line is not a runtime-verified quoting
 * proof. Every launcher argument is therefore a bounded, fixed fixture path or
 * literal, and any value containing shell metacharacters fails the lane loudly
 * instead of pretending the quoting was proved.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import { TerminalSurface, stripGeneratedSgr } from "../../src/session-host/terminal-surface";
import {
  frameHeaderMatches,
  isSidebarFocusedFrame,
  renderedTitleMatches,
  selectedRosterEntry,
  sidebarRosterHidden,
  SIDEBAR_COLUMNS,
} from "./session-host-native-roster-witness";
import {
  assertNativeEditorFieldEmpty,
  borderedEditorContentMatches,
  classifyFirstWorkspaceEnter,
  requireFolderCompletedObservation,
  windowsDirectoryCompletionCandidates,
  windowsQuitConfirmationFrameMatches,
} from "./session-host-native-windows-contracts";
import {
  ChangeSignal,
  NATIVE_OBSERVER_FIXTURE,
  NATIVE_PROVIDER_FIXTURE,
  WINDOWS_EVENT_TIMEOUT_MS,
  WINDOWS_KEYS,
  WindowsOwnedExitObserver,
  assertCreatedDirectoryIdentity,
  assertCredentialFreeNativeRecords,
  assertNoRoleOrCatalogMarkers,
  assertNoSavedSessionOverrides,
  assertNoUnownedNativeSessions,
  boundedJsonl,
  closeExitedOwnedConptyReader,
  createNativeAgentRoot,
  createOwnedDirectory,
  createWindowsHarnessRoot,
  identityOfRealDirectory,
  isSessionShutdownFor,
  isWindowsMainOwnerFrame,
  isWindowsOwnerDraftFrame,
  probeWindowsPowerShell,
  randomDigits,
  resolveInstalledPiRuntime,
  safeWindowsPath,
  sameFileIdentity,
  denyAmbientNativeProjectTrust,
  writeOwnedFile,
  type FileIdentity,
  type NativeJournalRecord,
  type NativePtyExit,
  type NativePtyHandle,
  type NativePtyModule,
  type PtyJournalRecord,
  type WindowsOwnedSession,
  type WindowsPowerShellPin,
} from "./session-host-native-windows-harness";
import { NODE_SECURITY_FLOOR_TEXT, stableNodeMeetsSecurityFloor } from "./node-security-floor";

export { WindowsOwnedExitObserver };
export type { NativePtyHandle };

export const LAUNCHER_REQUIRE_ENV = "PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST";
export const LAUNCHER_SOURCE_ROOT_ENV = "PI_REVIEW_GATE_LAUNCHER_SOURCE_ROOT";
export const LAUNCHER_PYTHON_ENV = "PI_REVIEW_GATE_LAUNCHER_PYTHON";
export const LAUNCHER_EXPECT_PI_VERSION = "1.5.2";
export const LAUNCHER_PTY_VERSION = "1.2.0-beta.15";
export const LAUNCHER_LEG_DEADLINE_MS = 9 * 60_000;
export const LAUNCHER_TEST_TIMEOUT_MS = 20 * 60_000;
export const LAUNCHER_STARTUP_TIMEOUT_MS = 7 * 60_000;
export const LAUNCHER_EVENT_TIMEOUT_MS = 30_000;
export const LAUNCHER_OBSERVER_TIMEOUT_SECONDS = 180;
export const LAUNCHER_OUTER_COLS = 120;
export const LAUNCHER_OUTER_ROWS = 50;
export const LAUNCHER_CLEANUP_BUDGET_MS = 20_000;
// The original cleanup budget is divided once into reserved slices for the three
// failure-cleanup steps: one short-lived graceful attempt, one bounded input-free
// observation of the exact owned outer PTY's real public onExit after the
// caller's exact-handle force, and the bounded settlement of the owned ConPTY
// reader. They grant no new grace beyond the original per-leg and whole-file
// caps, and one elapsed deadline (see `LauncherCleanupBudget`) charges every step
// against the SAME window, so the whole sequence stays inside it.
export const LAUNCHER_EXIT_OBSERVATION_BUDGET_MS = 5_000;
export const LAUNCHER_READER_SETTLEMENT_BUDGET_MS = 3_000;
export const LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS = LAUNCHER_CLEANUP_BUDGET_MS
  - LAUNCHER_EXIT_OBSERVATION_BUDGET_MS
  - LAUNCHER_READER_SETTLEMENT_BUDGET_MS;
// The cancelled body aborts this far before the node:test timeout so the bounded
// failure cleanup still completes inside the enforced per-leg deadline.
export const LAUNCHER_BODY_DEADLINE_MS = LAUNCHER_LEG_DEADLINE_MS - LAUNCHER_CLEANUP_BUDGET_MS;
export const LAUNCHER_PROVIDER_VALUE = "synthetic-provider-value";
export const LAUNCHER_LEGS = ["cmd", "direct-ps"] as const;
export type LauncherLegName = (typeof LAUNCHER_LEGS)[number];

const LAUNCHER_BASELINE = "SESSION_HOST_LAUNCHER_WINDOWS_OUTER_RESTORATION_BASELINE";
const EXPECT_NODE_OPTIONS_ENV = "PRG_SESSION_HOST_LAUNCHER_EXPECT_NODE_OPTIONS";
const EXPECT_PROVIDER_ENV = "PRG_SESSION_HOST_LAUNCHER_EXPECT_PROVIDER_VALUE";
const SOURCE_FIXTURE_FILES = ["package.json", "package-lock.json", "tsconfig.json"] as const;
const SOURCE_FIXTURE_TREES = ["src", "scripts", "skills"] as const;
const SOURCE_FIXTURE_REQUIRED = [
  join("src", "session-host", "main.ts"),
  join("scripts", "pi-review-sessions.cjs"),
  join("scripts", "pi-review-sessions.cmd"),
  join("scripts", "pi-review-sessions-node.ps1"),
] as const;
const SOURCE_FIXTURE_FORBIDDEN = ["dist", "node_modules", ".git", "tests"] as const;
/** Every build output the retained launcher stage must carry as a real file. */
export const LAUNCHER_STAGE_REQUIRED = [
  join("dist", "src", "session-host", "main.js"),
  join("dist", "src", "index.js"),
  join("dist", "src", "session-host", "reporter.js"),
  join("dist", "src", "session-host", "bootstrap-preload.js"),
  join("scripts", "pi-review-sessions.cjs"),
] as const;
/**
 * The exact directory grammar of a stage the CURRENT shared preparation
 * producer leaves behind. `scripts/application-build.cjs` stages every
 * application generation with
 * `createOwnedStage(buildCacheRoot, "pi-review-gate-app-", crypto.randomBytes)`,
 * whose exclusively created name is that prefix plus
 * `randomBytes(16).toString("hex")`, and the whole bounded install lives inside
 * that SAME counted generation (`.npm-cache`, `.npm-logs`, `.npm-tmp`,
 * `.home`). There is therefore no sibling install-scratch name left to filter,
 * and the retired `pi-review-sessions-<32 hex>` grammar is never admitted: a
 * directory that does not carry the current producer's name is not evidence of
 * this launcher's build.
 */
export const LAUNCHER_BUILT_STAGE_DIRNAME = /^pi-review-gate-app-[0-9a-f]{32}$/;

export interface LauncherRuntimePin {
  readonly sourceRoot: string;
  readonly agentDir: string;
  readonly piExecutable: string;
  readonly version: "1.5.2";
  readonly python: string;
  readonly cmd: string;
  readonly powershell: string;
  readonly systemRoot: string;
  readonly pty: NativePtyModule;
  readonly ptyModulePath: string;
  readonly preloadFixture: string;
}

export interface LauncherLegLayout {
  readonly leg: LauncherLegName;
  readonly root: string;
  readonly home: string;
  readonly temporary: string;
  readonly cache: string;
  readonly stateRoot: string;
  readonly fixtureState: string;
  readonly observerDirectory: string;
  readonly exitObserverRoot: string;
  readonly nativeAgentDir: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

function assertAbsoluteRealFile(value: string, label: string): string {
  const canonical = realpathSync(value);
  const stats = lstatSync(canonical);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`required Windows launcher input is not a regular file: ${label}`);
  return canonical;
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

function assertPythonPrerequisite(python: string): void {
  const probe = spawnSync(python, ["-I", "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error("the Windows alpha launcher acceptance requires Python 3.9 or newer at the pinned interpreter");
  }
}

/** Fails closed after opt-in; no ambient source/runtime fallback is allowed. */
export function resolveLauncherRuntime(): LauncherRuntimePin {
  if (process.platform !== "win32") throw new Error("required real Windows source-launcher acceptance was requested on a non-Windows host");
  const nodeVersion = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node);
  if (!nodeVersion) throw new Error("stable Node version could not be established for the Windows launcher host");
  if (!stableNodeMeetsSecurityFloor(process.versions.node)) {
    throw new Error(`Windows source-launcher acceptance requires stable ${NODE_SECURITY_FLOOR_TEXT}`);
  }

  assertNoRoleOrCatalogMarkers(process.env);
  const agentPin = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  const binPin = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN?.trim();
  const versionPin = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  const sourcePin = process.env[LAUNCHER_SOURCE_ROOT_ENV]?.trim();
  const pythonPin = process.env[LAUNCHER_PYTHON_ENV]?.trim();
  if (!agentPin || !binPin || !versionPin || !sourcePin || !pythonPin) {
    throw new Error("Windows source-launcher acceptance requires explicit source fixture, Python, and pinned public Pi runtime env");
  }
  if (versionPin !== LAUNCHER_EXPECT_PI_VERSION) {
    throw new Error(`Windows source-launcher acceptance requires exact public Pi ${LAUNCHER_EXPECT_PI_VERSION}`);
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable for ConPTY/PowerShell");

  const { agentDir, piExecutable } = resolveInstalledPiRuntime(agentPin, binPin, versionPin);
  const sourceRoot = realpathSync(sourcePin);
  if (!isAbsolute(sourceRoot)) throw new Error("the launcher source fixture root must be absolute");
  assertCompleteSourceFixture(sourceRoot);

  const python = assertAbsoluteRealFile(pythonPin, "pinned Python interpreter");
  assertPythonPrerequisite(python);

  const projectRequire = createRequire(join(process.cwd(), "package.json"));
  const ptyModulePath = projectRequire.resolve("@lydell/node-pty");
  const pty = projectRequire("@lydell/node-pty") as NativePtyModule;
  if (!pty || typeof pty.spawn !== "function") throw new Error("public @lydell/node-pty spawn API is unavailable");

  const cmd = assertAbsoluteRealFile(join(systemRoot, "System32", "cmd.exe"), "trusted cmd.exe");
  const powershell = assertAbsoluteRealFile(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "trusted Windows PowerShell");
  const preloadFixture = assertAbsoluteRealFile(join(process.cwd(), "tests", "fixtures", "session-host-windows-launcher-preload.cjs"), "launcher preload fixture");
  for (const fixture of [NATIVE_OBSERVER_FIXTURE, NATIVE_PROVIDER_FIXTURE]) assertAbsoluteRealFile(fixture, "native observer/provider fixture");

  return {
    sourceRoot,
    agentDir,
    piExecutable,
    version: LAUNCHER_EXPECT_PI_VERSION,
    python,
    cmd,
    powershell,
    systemRoot,
    pty,
    ptyModulePath,
    preloadFixture,
  };
}

/** One fresh per-leg confined layout; no production profile/auth material is copied. */
export function createLauncherLegLayout(leg: LauncherLegName): LauncherLegLayout {
  const root = createWindowsHarnessRoot();
  const workspaces = createOwnedDirectory(root, "workspaces");
  const layout: LauncherLegLayout = {
    leg,
    root,
    home: createOwnedDirectory(root, "home"),
    temporary: createOwnedDirectory(root, "tmp"),
    cache: createOwnedDirectory(root, "cache"),
    stateRoot: createOwnedDirectory(root, "state"),
    fixtureState: createOwnedDirectory(root, "fixture-state"),
    observerDirectory: createOwnedDirectory(root, "observer"),
    exitObserverRoot: createOwnedDirectory(root, "exit-observers"),
    nativeAgentDir: createNativeAgentRoot(root),
    workspaceA: createOwnedDirectory(workspaces, "a"),
    workspaceB: createOwnedDirectory(workspaces, "b"),
  };
  // Pi gates these owned workspaces behind its interactive "Trust project
  // folder?" prompt (untrusted real-home `.agents/skills` ancestor under the
  // harness's disposable fake HOME). Deny project trust in this task-created
  // synthetic agent root so the child never prompts and never loads or trusts
  // ambient user resources.
  denyAmbientNativeProjectTrust(layout.nativeAgentDir);
  for (const ownedDirectory of [layout.root, layout.home, layout.temporary, layout.cache, layout.stateRoot,
    layout.fixtureState, layout.observerDirectory, layout.exitObserverRoot, layout.nativeAgentDir,
    workspaces, layout.workspaceA, layout.workspaceB]) assertCreatedDirectoryIdentity(ownedDirectory);
  return layout;
}

function assertShellSafeArguments(values: readonly string[]): void {
  for (const value of values) {
    if (value.length === 0 || /[\s"&|<>^()%!;`,]/.test(value) || value.includes("\n")) {
      throw new Error("the bounded launcher acceptance cannot safely quote this argument without a runtime-verified Windows quoting proof; refusing to fake one");
    }
  }
}

/**
 * One enforced per-leg deadline. Every driver input and wait is gated on `assertOpen`
 * or cancelled through `signal`, so a cancelled leg performs no further input or
 * observer creation. A linked external signal (the node:test timeout signal) aborts
 * the same controller.
 */
export class LegDeadline {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private readonly onExternalAbort = (): void => this.controller.abort();

  constructor(budgetMs: number, external?: AbortSignal) {
    if (Number.isFinite(budgetMs) && budgetMs > 0) {
      this.timer = setTimeout(() => this.controller.abort(), budgetMs);
      // Keep pending guarded waits alive until cancellation or dispose().
    } else {
      this.controller.abort();
    }
    if (external) {
      if (external.aborted) this.controller.abort();
      else external.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private refusal(stage: string): Error {
    return new Error(`source-launcher leg deadline reached; refusing further ${stage}`);
  }

  assertOpen(stage: string): void {
    if (this.controller.signal.aborted) throw this.refusal(stage);
  }

  /** Race a promise against the deadline so a cancelled wait settles promptly. */
  guard<T>(stage: string, promise: Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) return Promise.reject(this.refusal(stage));
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(this.refusal(stage));
      };
      const cleanup = (): void => this.controller.signal.removeEventListener("abort", onAbort);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}

/**
 * One absolute elapsed failure-cleanup deadline. Every cleanup step receives its
 * reserved slice AND whatever this same deadline still allows, so the graceful
 * attempt, the exact force-to-onExit observation, and the owned ConPTY reader
 * settlement together can never exceed the original cleanup budget, and no step
 * (including the reader settlement) can wait past the deadline.
 */
export class LauncherCleanupBudget {
  private readonly deadlineAt: number;

  constructor(budgetMs: number) {
    this.deadlineAt = performance.now() + (Number.isSafeInteger(budgetMs) && budgetMs > 0 ? budgetMs : 0);
  }

  /** Remaining time for one step, never above that step's reserved slice. */
  remaining(capMs: number): number {
    const left = this.deadlineAt - performance.now();
    return Math.max(0, Math.min(capMs, left));
  }

  get expired(): boolean {
    return this.deadlineAt - performance.now() <= 0;
  }
}

/** Bounded settlement outcome for one owned failure-cleanup resource. */
export type LauncherSettlement = "closed" | "skipped" | "uncertain";

/**
 * Await one owned-resource settlement without ever waiting past the remaining
 * cleanup budget. The observed-outer-exit guard is never relaxed: while the outer
 * exit is unconfirmed the transport may still be live and the closer is never
 * invoked. Any finite positive duration is accepted — the shared cleanup window
 * reports fractional milliseconds, so a leftover below a step's cap is still real
 * time and is waited on. A delayed, never-settling, or throwing settlement is
 * reported as `uncertain` at the budget instead of hanging the failure hook or
 * escaping as a new error, so the failed result stands unchanged while the
 * uncertainty stays visible.
 */
export async function settleOwnedConptyReader(
  exitObserved: boolean,
  remainingMs: number,
  close: () => Promise<void>,
): Promise<LauncherSettlement> {
  if (!exitObserved) return "skipped";
  const settling = close().then(
    () => "closed" as const,
    () => "uncertain" as const,
  );
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "uncertain";
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settling,
      new Promise<LauncherSettlement>((resolve) => { timer = setTimeout(() => resolve("uncertain"), remainingMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fixed metadata for a bounded frame-wait failure; terminal content is never
 * included. The optional fields carry only already-journaled fixed evidence: the
 * exact owned outer PTY's reported exit code/signal once its public onExit
 * fired, and presence-only witnesses (plus that summary's fixed fields) from the
 * journals the launcher preload already writes. An absent optional field means
 * the evidence was unavailable, and it is reported as such rather than guessed.
 */
export interface FrameWaitMetadata {
  readonly frameRevision: number;
  readonly after: number;
  readonly exitObserved: boolean;
  readonly aborted: boolean;
  readonly outerExitCode?: number | null;
  readonly outerExitSignal?: number | string | null;
  readonly launcherEntry?: boolean;
  readonly ptyModule?: boolean;
  readonly launcherSummary?: boolean;
  readonly summaryExitCode?: number | null;
  readonly summaryForceAttempted?: boolean | null;
  readonly summaryJournalFailed?: boolean | null;
  readonly summaryUnresolvedSpawns?: number | null;
  readonly summaryUnexitedSpawns?: number | null;
}

/** Mutable builder shape for one bounded frame-wait evidence record. */
type MutableFrameWaitEvidence = { -readonly [K in keyof FrameWaitMetadata]: FrameWaitMetadata[K] };

function diagnosticYesNo(value: boolean | undefined): string {
  return value === undefined ? "uncertain" : value ? "yes" : "no";
}

function diagnosticNumber(value: number | string | null | undefined): string {
  return typeof value === "number" ? String(value) : typeof value === "string" && value.length > 0 ? value : "unreported";
}

function diagnosticFlag(value: boolean | null | undefined): string {
  return value === undefined ? "uncertain" : value === null ? "unreported" : value ? "yes" : "no";
}

/**
 * Build a bounded frame-wait diagnostic from fixed stage identifiers and
 * numeric/boolean status only. It deliberately takes no terminal text, so a
 * transcript or draft can never reach CI diagnostics.
 */
export function frameWaitFailure(stage: string, metadata: FrameWaitMetadata, terminalContent?: string): Error {
  // `terminalContent` is accepted only so a caller cannot accidentally route it
  // into the message; it is deliberately never read.
  void terminalContent;
  const parts = [
    `revision=${metadata.frameRevision}`,
    `after=${metadata.after}`,
    `exit=${metadata.exitObserved}`,
    `aborted=${metadata.aborted}`,
  ];
  if (metadata.exitObserved) {
    parts.push(`outerExitCode=${diagnosticNumber(metadata.outerExitCode)}`);
    parts.push(`outerExitSignal=${diagnosticNumber(metadata.outerExitSignal)}`);
  }
  if (metadata.launcherEntry !== undefined) parts.push(`entry=${diagnosticYesNo(metadata.launcherEntry)}`);
  if (metadata.ptyModule !== undefined) parts.push(`module=${diagnosticYesNo(metadata.ptyModule)}`);
  if (metadata.launcherSummary !== undefined) {
    parts.push(`summary=${diagnosticYesNo(metadata.launcherSummary)}`);
    if (metadata.launcherSummary) {
      parts.push(`summaryExitCode=${diagnosticNumber(metadata.summaryExitCode)}`);
      parts.push(`summaryForce=${diagnosticFlag(metadata.summaryForceAttempted)}`);
      parts.push(`summaryJournalFailed=${diagnosticFlag(metadata.summaryJournalFailed)}`);
      parts.push(`summaryUnresolved=${diagnosticNumber(metadata.summaryUnresolvedSpawns)}`);
      parts.push(`summaryUnexited=${diagnosticNumber(metadata.summaryUnexitedSpawns)}`);
    }
  }
  return new Error(`${stage}: bounded frame wait failed (${parts.join(", ")})`);
}

/**
 * The launcher lane's shared strict owner-and-pane witness for an explicit
 * activation or a typed draft: the exact owner header, that owner's single
 * highlight, the complete Main-focused roster footer, and the width-correct
 * bordered native editor whose content row is EXACTLY `expectedDraft` — or, for
 * the first activation before any draft exists, the width-correct bordered
 * EMPTY editor. The outer header repaints before the native pane, so a header
 * alone is never accepted: a freshly moved header over the previous owner's
 * draft, over an empty or mid-repaint pane, or beside an appended, altered,
 * partial, or wrong-width editor never satisfies it.
 */
export function launcherOwnerDraftFrame(text: string, ownerLabel: string, expectedDraft: string): boolean {
  return expectedDraft.length === 0
    ? isWindowsMainOwnerFrame(text, ownerLabel)
    : isWindowsOwnerDraftFrame(text, ownerLabel, expectedDraft);
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
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function selectedRosterLabel(frame: string): string | undefined {
  return selectedRosterEntry(frame, 32)?.label;
}

/**
 * The observer-recorded canonical display caption for one native session. A
 * session's startup caption may begin unavailable and settle to the public
 * stored name or Pi's no-messages fallback; a missing caption is never guessed.
 */
function requireLauncherDisplayName(record: NativeJournalRecord, description: string): string {
  const displayName = record.displayName;
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${description}: native observer recorded no canonical display caption`);
  }
  return displayName;
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

/**
 * The exact source fixture remains a source fixture: the real launcher builds
 * only in its own retained stage, never in the fixture root.
 */
export function assertSourceFixtureUnchanged(runtime: LauncherRuntimePin): void {
  assertCompleteSourceFixture(runtime.sourceRoot);
}

export interface LauncherStageEvidence {
  readonly stage: string;
  readonly ptyModulePath: string;
}

/** One retained-stage observation boundary: the shared build cache, the exact
 * locked source fixture the stage must match, and the exact pinned public PTY. */
export interface LauncherStageProbe {
  readonly buildRoot: string;
  readonly sourceRoot: string;
  readonly ptyVersion: string;
}

/**
 * Assert one — and only one — launcher-owned retained build stage under
 * `buildRoot`, cross-bound to the exact locked `sourceRoot`: the current
 * producer's stage grammar, a real non-symlink directory, every required build
 * output as a real non-symlink file, a lockfile byte-identical to the source
 * fixture, and the exact pinned public @lydell/node-pty installed from it. No
 * observation is relaxed for a fixture: the real Windows legs and the synthetic
 * negative controls share this one implementation.
 */
export function assertRetainedLauncherStage(probe: LauncherStageProbe): LauncherStageEvidence {
  const entries = readdirSync(probe.buildRoot);
  const stages = entries.filter((entry) => LAUNCHER_BUILT_STAGE_DIRNAME.test(entry));
  assert.equal(stages.length, 1, "exactly one retained launcher-owned source build stage exists for the fresh per-leg agent root");
  const stage = join(probe.buildRoot, stages[0]!);
  const stageStats = lstatSync(stage);
  assert.ok(stageStats.isDirectory() && !stageStats.isSymbolicLink(), "the retained launcher stage is a real directory");
  for (const required of LAUNCHER_STAGE_REQUIRED) {
    const stats = lstatSync(join(stage, required));
    assert.ok(stats.isFile() && !stats.isSymbolicLink(), `retained launcher stage is missing a real build output: ${required}`);
  }
  const sourceLock = readFileSync(join(probe.sourceRoot, "package-lock.json"));
  const stageLock = readFileSync(join(stage, "package-lock.json"));
  assert.ok(sourceLock.equals(stageLock), "the retained stage lockfile is byte-identical to the locked source fixture");
  const ptyPackage = JSON.parse(readFileSync(join(stage, "node_modules", "@lydell", "node-pty", "package.json"), "utf8")) as { version?: string };
  assert.equal(ptyPackage.version, probe.ptyVersion, "the retained stage installed the exact pinned public @lydell/node-pty");
  return { stage, ptyModulePath: join(stage, "node_modules", "@lydell", "node-pty") };
}

/** Assert the real launcher-owned retained build stage after graceful shutdown. */
export function assertLauncherStageEvidence(runtime: LauncherRuntimePin, layout: LauncherLegLayout): LauncherStageEvidence {
  return assertRetainedLauncherStage({
    buildRoot: join(layout.nativeAgentDir, ".pi-review-gate", "build"),
    sourceRoot: runtime.sourceRoot,
    ptyVersion: LAUNCHER_PTY_VERSION,
  });
}

export function assertLauncherSummary(summary: Record<string, unknown>): void {
  assert.equal(summary.exitCode, 0, "the actual launcher process exited zero through its own return code");
  assert.equal(summary.forceAttempted, false, "no exact owned native public PTY kill was attempted");
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

export class LauncherPtyDriver {
  readonly pty: NativePtyHandle;
  /**
   * The bundled-ConPTY option requested by this driver's public outer spawn.
   * This records the request, not independent runtime backend activation.
   */
  readonly outerUseConptyDll: boolean;
  readonly leg: LauncherLegName;
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
  deadline: LegDeadline;
  exitEvent?: NativePtyExit;
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
  /**
   * The one elapsed failure-cleanup deadline. Every cleanup step (graceful
   * attempt, exact outer-exit observation, owned ConPTY reader settlement) is
   * charged against this SAME window and against its own reserved slice, so the
   * whole sequence stays inside the original cleanup budget.
   */
  private cleanupBudget?: LauncherCleanupBudget;

  private constructor(options: {
    pty: NativePtyHandle;
    outerUseConptyDll: boolean;
    leg: LauncherLegName;
    root: string;
    observerFile: string;
    providerJournal: string;
    ptyJournal: string;
    forceJournal: string;
    deadline: LegDeadline;
    logWatcher: FSWatcher;
    nativeWatcher: FSWatcher;
    providerWatcher: FSWatcher;
  }) {
    this.pty = options.pty;
    this.outerUseConptyDll = options.outerUseConptyDll;
    this.leg = options.leg;
    this.root = options.root;
    this.observerFile = options.observerFile;
    this.providerJournal = options.providerJournal;
    this.ptyJournal = options.ptyJournal;
    this.forceJournal = options.forceJournal;
    this.deadline = options.deadline;
    this.logWatcher = options.logWatcher;
    this.nativeWatcher = options.nativeWatcher;
    this.providerWatcher = options.providerWatcher;
    this.surface = new TerminalSurface(LAUNCHER_OUTER_COLS, LAUNCHER_OUTER_ROWS, {
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
    this.logWatcher.on("change", () => this.journalSignal.notify());
    this.nativeWatcher.on("change", () => this.journalSignal.notify());
    this.providerWatcher.on("change", () => this.journalSignal.notify());
  }

  static start(options: {
    readonly runtime: LauncherRuntimePin;
    readonly layout: LauncherLegLayout;
    readonly nonce: string;
    readonly deadline: LegDeadline;
  }): LauncherPtyDriver {
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
    assertShellSafeArguments([runtime.sourceRoot, runtime.piExecutable, layout.stateRoot, ...wrapperArgs]);

    const pythonDirectory = dirname(runtime.python);
    const expectedNodeOptions = launcherNodeOptions(runtime.preloadFixture, process.env.NODE_OPTIONS);
    const env: NodeJS.ProcessEnv = {
      PATH: `${pythonDirectory}${delimiter}${safeWindowsPath(runtime.systemRoot)}`,
      // PowerShell needs PATHEXT to invoke/capture node.exe as an executable.
      // CMD seeds it itself; the direct-PowerShell root needs it explicitly.
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: runtime.systemRoot,
      WINDIR: runtime.systemRoot,
      USERPROFILE: layout.home,
      HOME: layout.home,
      TEMP: layout.temporary,
      TMP: layout.temporary,
      TMPDIR: layout.temporary,
      APPDATA: join(layout.home, "AppData", "Roaming"),
      LOCALAPPDATA: join(layout.home, "AppData", "Local"),
      XDG_CACHE_HOME: layout.cache,
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: layout.nativeAgentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_PROVIDER_TEST_KEY: LAUNCHER_PROVIDER_VALUE,
      NODE_OPTIONS: expectedNodeOptions,
      [EXPECT_NODE_OPTIONS_ENV]: expectedNodeOptions,
      [EXPECT_PROVIDER_ENV]: LAUNCHER_PROVIDER_VALUE,
      PRG_SESSION_HOST_LAUNCHER_SOURCE_ROOT: runtime.sourceRoot,
      PRG_SESSION_HOST_LAUNCHER_NONCE: options.nonce,
      PRG_SESSION_HOST_LAUNCHER_PTY_JOURNAL: ptyJournal,
      PRG_SESSION_HOST_LAUNCHER_BASELINE: LAUNCHER_BASELINE,
      PRG_SESSION_HOST_LAUNCHER_NATIVE_AGENT: runtime.agentDir,
      PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE: observerFile,
      PRG_FIXTURE_AGENT_DIR: runtime.agentDir,
      PRG_FIXTURE_STATE_DIR: layout.fixtureState,
      PRG_FIXTURE_NO_AUTO_MODEL: "1",
    };
    assertNoRoleOrCatalogMarkers(env);
    assert.deepEqual(Object.keys(env).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
      "allowlisted launcher child environment contains no credential-like variable names");

    const launcherEntry = join(runtime.sourceRoot, "scripts", "pi-review-sessions.cjs");
    const cmdEntry = join(runtime.sourceRoot, "scripts", "pi-review-sessions.cmd");
    const psEntry = join(runtime.sourceRoot, "scripts", "pi-review-sessions-node.ps1");
    let file: string;
    let args: string[];
    if (options.layout.leg === "cmd") {
      file = runtime.cmd;
      args = ["/d", "/s", "/c", cmdEntry, ...wrapperArgs];
    } else {
      file = runtime.powershell;
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psEntry, ...wrapperArgs];
    }
    assertShellSafeArguments([file, ...args]);
    assert.ok(existsSync(launcherEntry), `source launcher entry exists: ${launcherEntry}`);

    const logWatcher = watch(layout.root);
    const nativeWatcher = watch(layout.observerDirectory);
    const providerWatcher = watch(layout.fixtureState);
    // Request the same public bundled-ConPTY option as the shipped source path.
    // Retain the requested boolean, without treating it as independent proof of
    // backend activation or successful mouse/device-attributes behavior.
    const outerSpawnOptions = {
      name: "xterm-256color",
      cols: LAUNCHER_OUTER_COLS,
      rows: LAUNCHER_OUTER_ROWS,
      cwd: process.cwd(),
      env,
      encoding: "utf8" as const,
      useConptyDll: true,
    };
    let pty: NativePtyHandle;
    try {
      pty = runtime.pty.spawn(file, args, outerSpawnOptions);
    } catch (error) {
      logWatcher.close();
      nativeWatcher.close();
      providerWatcher.close();
      throw new Error(`public Windows launcher ConPTY spawn failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    // Public ConPTY publishes pid asynchronously after its data pipe connects.
    // Wire the exact returned handle immediately, including failure teardown.
    try {
      return new LauncherPtyDriver({ pty, outerUseConptyDll: outerSpawnOptions.useConptyDll, leg: options.layout.leg, root: layout.root, observerFile, providerJournal, ptyJournal, forceJournal, deadline: options.deadline, logWatcher, nativeWatcher, providerWatcher });
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
      this.parserError = new Error("actual launcher ConPTY output could not be parsed by the public terminal surface");
    }
  }

  private refreshFrame(): void {
    try {
      this.currentFrame = frameText(this.surface);
      this.frameRevision += 1;
      this.frameSignal.notify();
    } catch {
      this.parserError = new Error("actual launcher ConPTY frame could not be read");
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

  async waitFrame(predicate: (frame: string) => boolean, stage: string, after = -1, timeoutMs = LAUNCHER_EVENT_TIMEOUT_MS, signal: AbortSignal = this.deadline.signal): Promise<void> {
    await this.frameSignal.waitFor(() => {
      if (this.exitEvent && !(this.frameRevision > after && predicate(this.currentText()))) {
        throw new Error("launcher outer ConPTY exited before the expected frame");
      }
      return this.frameRevision > after && predicate(this.currentText());
    }, timeoutMs, stage, signal).catch((error: unknown) => {
      // Fixed stage identifier and status metadata only: terminal content,
      // drafts, and preserved-preload output never reach diagnostics.
      if (error instanceof Error && /leg deadline|cancelled before completion/.test(error.message)) throw error;
      throw frameWaitFailure(stage, this.waitFailureEvidence(after, signal));
    });
  }

  /**
   * Bounded, transcript-free evidence for one frame-wait failure: the fixed
   * revision/after/abort status, the exact owned outer PTY's reported exit
   * code/signal once its public onExit fired, and presence-only witnesses from
   * the journals the launcher preload already writes (the actual launcher entry,
   * the staged production module anchor, the launcher exit summary) with that
   * summary's fixed fields. A journal that cannot be read leaves those witnesses
   * unreported rather than claiming they are absent; no frame text, draft,
   * argument, environment value, or path is ever included.
   */
  private waitFailureEvidence(after: number, signal: AbortSignal): FrameWaitMetadata {
    const evidence: MutableFrameWaitEvidence = {
      frameRevision: this.frameRevision,
      after,
      exitObserved: this.exitEvent !== undefined,
      aborted: signal.aborted,
    };
    if (this.exitEvent) {
      evidence.outerExitCode = this.exitEvent.exitCode;
      evidence.outerExitSignal = this.exitEvent.signal ?? 0;
    }
    let records: PtyJournalRecord[];
    try {
      records = this.ptyRecords();
    } catch {
      return evidence;
    }
    evidence.launcherEntry = records.some((record) => record.type === "launcher_entry");
    evidence.ptyModule = records.some((record) => record.type === "pty_module");
    const summary = records.filter((record) => record.type === "launcher_summary").at(-1);
    evidence.launcherSummary = summary !== undefined;
    if (summary !== undefined) {
      evidence.summaryExitCode = typeof summary.exitCode === "number" ? summary.exitCode : null;
      evidence.summaryForceAttempted = typeof summary.forceAttempted === "boolean" ? summary.forceAttempted : null;
      evidence.summaryJournalFailed = typeof summary.journalFailed === "boolean" ? summary.journalFailed : null;
      evidence.summaryUnresolvedSpawns = typeof summary.unresolvedSpawns === "number" ? summary.unresolvedSpawns : null;
      evidence.summaryUnexitedSpawns = typeof summary.unexitedSpawns === "number" ? summary.unexitedSpawns : null;
    }
    return evidence;
  }

  async waitForNative(predicate: (records: NativeJournalRecord[]) => boolean, stage: string, timeoutMs = LAUNCHER_EVENT_TIMEOUT_MS): Promise<NativeJournalRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.records()), timeoutMs, stage, this.deadline.signal);
    return this.records();
  }

  async waitForPty(predicate: (records: PtyJournalRecord[]) => boolean, stage: string, timeoutMs = LAUNCHER_EVENT_TIMEOUT_MS): Promise<PtyJournalRecord[]> {
    await this.journalSignal.waitFor(() => predicate(this.ptyRecords()), timeoutMs, stage, this.deadline.signal);
    return this.ptyRecords();
  }

  async waitForProvider(predicate: (records: Record<string, unknown>[]) => boolean, stage: string, timeoutMs = LAUNCHER_EVENT_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
    await this.journalSignal.waitFor(() => predicate(this.providerRecords()), timeoutMs, stage, this.deadline.signal);
    return this.providerRecords();
  }

  async waitForExit(timeoutMs = LAUNCHER_EVENT_TIMEOUT_MS, signal: AbortSignal = this.deadline.signal): Promise<NativePtyExit> {
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
    this.write(WINDOWS_KEYS.f8, "sidebar toggle");
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
      this.write(WINDOWS_KEYS.escape, "cancel incomplete sidebar form");
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
      this.write(WINDOWS_KEYS.down, "sidebar selection advance");
      await this.waitFrame((frame) => selectedRosterLabel(frame) !== beforeLabel,
        "sidebar selection advances", before);
    }
    assert.equal(selectedRosterLabel(this.currentText()), label, "actual launcher Main sidebar selected the requested row");
  }

  async createNativeSession(workspace: string, label: string): Promise<WindowsOwnedSession> {
    const canonicalWorkspace = realpathSync(workspace);
    await this.ensureSidebarFocus();
    await this.moveRosterTo("New session");
    await this.send(WINDOWS_KEYS.enter, "Workspace-only New form opens", (frame) => frame.includes("New session") && frame.includes("Workspace:")
      && !frame.includes("Label:") && !frame.includes("Profile:"));
    this.focus = "form";
    if (!workspaceFieldEmpty(this.currentText())) {
      const before = this.frameRevision;
      this.write(WINDOWS_KEYS.ctrlC, "clear workspace field");
      await this.waitFrame(workspaceFieldEmpty, "public Workspace clear binding empties the New Editor content row", before);
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
    this.write("\t", "accept workspace completion");
    await this.waitFrame((frame) => {
      try {
        requireFolderCompletedObservation(classifyFirstWorkspaceEnter(frame, expectedCompletions));
        return true;
      } catch {
        return false;
      }
    }, "forced Tab accepts the owned native directory completion", beforeFirstEnter);
    const firstEnterObservation = classifyFirstWorkspaceEnter(this.currentText(), expectedCompletions);
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
    this.write(WINDOWS_KEYS.enter, "submit accepted workspace");
    await this.waitFrame((frame) => frame.includes("Starting (request ") || !frame.includes("Workspace:"),
      "distinct second Enter submits the accepted directory", beforeSubmit);
    const afterFirstEnter = this.currentText();
    assert.ok(afterFirstEnter.includes("Starting (request ") || !afterFirstEnter.includes("Workspace:"),
      `${label} New request reached its submitted/closed state before lifecycle ownership is claimed`);
    const matchingRecords = await this.waitForNative((records) => records.some((record) => record.type === "session_start"
      && samePath(record.cwd ?? "", canonicalWorkspace)
      && typeof record.sessionId === "string" && record.sessionId.length > 0),
    "real public session_start");
    const record = matchingRecords.filter((candidate) => candidate.type === "session_start"
      && samePath(candidate.cwd ?? "", canonicalWorkspace)
      && typeof candidate.sessionId === "string").at(-1);
    assert.ok(record, `${label} has a native public session_start record`);
    assert.ok(Number.isSafeInteger(record.pid) && record.pid! > 1, `${label} has its exact native process PID`);
    assert.equal(record.tty, true, `${label} public session_start confirms native Pi TTY mode`);
    assert.ok(record.sessionFile && isAbsolute(record.sessionFile), `${label} has a public absolute planned session path`);
    const spawnRecords = await this.waitForPty((entries) => entries.some((entry) => entry.type === "pty_spawn"
      && entry.pid === record!.pid && samePath(entry.cwd ?? "", canonicalWorkspace)),
    "actual public node-pty spawn ownership");
    const matchingSpawns = spawnRecords.filter((entry) => entry.type === "pty_spawn"
      && entry.pid === record!.pid && samePath(entry.cwd ?? "", canonicalWorkspace));
    assert.equal(matchingSpawns.length, 1, `${label} journal PID/cwd cross-binds to exactly one actual PTY spawn`);
    assert.ok(this.ptyRecords().every((entry) => !(entry.type === "pty_exit" && entry.pid === record!.pid)),
      `${label} remains a live Main-owned PTY after session_start`);
    // A successful explicit New submission activates the created child as the
    // Main input owner without a second host-row Enter (the sidebar stays visible
    // exactly as it was): the active outer header is that child's own observed
    // canonical caption, its row is the single highlight, and the complete
    // Main-focused footer with the width-correct bordered empty native editor
    // proves the ownership transfer really happened.
    const startupCaption = requireLauncherDisplayName(record, `${label} new Workspace-only New`);
    await this.waitFrame((frame) => isWindowsMainOwnerFrame(frame, startupCaption),
      `${label} New completion activates the exact created child ${startupCaption} as the Main input owner with a complete Main-focused frame`);
    this.focus = "main";
    await this.renameSelectedNativeSession(record, label, startupCaption);
    return { label, workspace: canonicalWorkspace, record };
  }

  /**
   * Rename the freshly created row through the real host Edit form. The row is
   * the active Main owner (its New activated it and nothing else was selected
   * since), so this is always an active-owner rename: the owner header must
   * follow the new caption. A welcome or startup header that never moved is not
   * rename evidence.
   */
  private async renameSelectedNativeSession(record: NativeJournalRecord, label: string, startupCaption: string): Promise<void> {
    await this.ensureSidebarFocus();
    assert.ok(renderedTitleMatches(selectedRosterLabel(this.currentText()), startupCaption),
      "the observed target row is the single highlight for the public Edit key");
    const beforeEdit = this.frameRevision;
    this.write("e", "open Edit form");
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
    this.write(WINDOWS_KEYS.enter, "submit replacement name");
    const nameRecords = await this.waitForNative((records) => records.some((entry) => entry.type === "native_session_name"
      && entry.pid === record.pid && entry.sessionId === record.sessionId && entry.storedName === label
      && typeof entry.displayName === "string"),
    "public native observer sees the live SessionManager display-name value");
    const nameRecord = nameRecords.filter((entry) => entry.type === "native_session_name"
      && entry.pid === record.pid && entry.sessionId === record.sessionId && entry.storedName === label
      && typeof entry.displayName === "string").at(-1);
    assert.ok(nameRecord, "the actual stored-name event includes its canonical bounded display caption");
    const displayName = requireLauncherDisplayName(nameRecord, `${label} public Edit replacement`);
    await this.waitFrame((frame) => renderedTitleMatches(selectedRosterLabel(frame), displayName)
        && frameHeaderMatches(frame, displayName),
      "the renamed active owner reports its new caption as the owner header");
    assert.ok(frameHeaderMatches(this.currentText(), displayName),
      "renaming the active owner keeps that same child as the active Main owner under its new caption");
    this.focus = "sidebar";
  }

  /**
   * Explicitly activate one native row and admit only the complete fresh witness
   * that this exact child owns Main input together with its own native pane: the
   * owner header, that owner's single highlight, the complete Main-focused roster
   * footer, and the width-correct bordered native editor whose content row is
   * exactly `expectedDraft` — or, for the first activation before any draft is
   * typed, the width-correct bordered EMPTY editor. The header repaints before
   * the native pane, so a header-only observation is never activation evidence.
   */
  async activate(label: string, expectedDraft: string): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo(label);
    const before = this.frameRevision;
    this.write(WINDOWS_KEYS.enter, "activate native row");
    this.focus = "main";
    await this.waitFrame((frame) => launcherOwnerDraftFrame(frame, label, expectedDraft),
      `public Enter explicitly activates native row ${label} with its own complete owner frame`, before);
  }

  /**
   * Type into the active native child and admit only the complete fresh witness
   * that THIS owner's bordered native editor now shows exactly this draft. An
   * unrelated substring elsewhere in the composed frame is never draft evidence.
   */
  async writeDraft(ownerLabel: string, value: string): Promise<void> {
    assert.ok(ownerLabel.length > 0 && value.length > 0, "the draft witness requires the exact owner caption and a non-empty draft");
    const before = this.frameRevision;
    this.write(value, "type native draft");
    await this.waitFrame((frame) => launcherOwnerDraftFrame(frame, ownerLabel, value),
      `native session ${ownerLabel} displays its own exact bordered draft in a complete owner frame`, before);
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
      "actual outer ConPTY answered the real public device-attributes query");
    assert.ok(this.replyLog.some((reply) => /^\x1b\[\?\d+u$/.test(reply)),
      "actual outer ConPTY answered the real public Kitty keyboard-state query");
  }

  async waitForNormalExit(): Promise<NativePtyExit> {
    const exit = await this.waitForExit();
    await this.surface.flush();
    assert.equal(exit.exitCode, 0, "real source launcher outer PTY exited zero");
    assert.ok(!exit.signal, "outer launcher exited normally without signal termination");
    assert.ok(this.sawAlternateLeave, "actual launcher Main output left the outer VT alternate buffer");
    assert.ok(this.outputTail.lastIndexOf("\x1b[?1049l") > this.outputTail.lastIndexOf("\x1b[?1049h"),
      "last observed outer VT alternate-buffer transition restored the normal buffer");
    assert.ok(frameText(this.surface).includes(LAUNCHER_BASELINE),
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

  async confirmQuit(): Promise<void> {
    await this.ensureSidebarFocus();
    await this.moveRosterTo("Quit host");
    const before = this.frameRevision;
    this.write(WINDOWS_KEYS.enter, "request quit confirmation");
    await this.waitFrame((frame) => windowsQuitConfirmationFrameMatches(
      frame, 2, SIDEBAR_COLUMNS, LAUNCHER_OUTER_ROWS - 1, LAUNCHER_OUTER_ROWS),
      "Quit with both live native children requires the real public confirmation pane", before);
    assert.equal(this.ptyRecords().filter((entry) => entry.type === "pty_exit").length, 0,
      "confirmed Quit is requested while both actual native PTY handles are still live");
    this.write(WINDOWS_KEYS.enter, "confirm quit host");
    this.focus = "main";
  }

  /**
   * Start the single elapsed failure-cleanup deadline (idempotent). The caller
   * invokes this once at the top of its bounded failure cleanup so that the
   * graceful attempt, the exact force-to-onExit observation, and the owned ConPTY
   * reader settlement all share one window instead of each getting a fresh budget.
   */
  beginFailureCleanup(): void {
    this.cleanupBudget ??= new LauncherCleanupBudget(LAUNCHER_CLEANUP_BUDGET_MS);
  }

  /** Remaining cleanup time for one step, never above that step's reserved slice. */
  private cleanupRemaining(capMs: number): number {
    this.beginFailureCleanup();
    return this.cleanupBudget!.remaining(capMs);
  }

  /**
   * Bounded failure cleanup only: a short-lived cleanup deadline replaces the
   * (possibly already exhausted) leg deadline for one best-effort graceful
   * attempt, then the caller forces the exact owned outer handle. That attempt is
   * capped by its reserved slice AND by the one elapsed cleanup deadline, so no
   * wait here can exceed the original cleanup budget, and no input is sent after
   * the budget.
   */
  async tryGracefulQuitAfterFailure(): Promise<void> {
    if (this.exitEvent) return;
    // If the leg deadline already fired, send no further input at all: cleanup
    // goes straight to the caller's exact-handle force.
    if (this.deadline.signal.aborted) return;
    const previous = this.deadline;
    const cleanup = new LegDeadline(this.cleanupRemaining(LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS));
    this.deadline = cleanup;
    try {
      if (this.currentText().trim().length === 0) return;
      await this.ensureSidebarFocus();
      await this.moveRosterTo("Quit host");
      const before = this.frameRevision;
      this.write(WINDOWS_KEYS.enter, "cleanup request quit confirmation");
      await this.waitFrame((frame) => frame.includes("Quit host?") || this.exitEvent !== undefined,
        "failed-test cleanup reaches the public quit confirmation", before, 5_000);
      if (!this.exitEvent && this.currentText().includes("Quit host?")) this.write(WINDOWS_KEYS.enter, "cleanup confirm quit host");
      await this.waitForExit(5_000);
    } catch {
      // A failed case remains failed; the caller uses exact-handle cleanup.
    } finally {
      this.deadline = previous;
      cleanup.dispose();
    }
  }

  forceKillOuterAfterFailure(): void {
    if (this.exitEvent || this.forced) return;
    this.forced = true;
    writeMetadata(this.forceJournal, { type: "outer_pty_force_attempt", pid: Number(this.pty.pid) });
    this.pty.kill(); // Exact public outer PTY handle, no signal argument.
  }

  /**
   * One bounded, input-free observation of the exact owned outer PTY's real
   * public onExit after the caller's exact-handle force. It runs on a finite
   * timer inside the reserved slice of the one elapsed cleanup deadline: the
   * often already exhausted leg deadline never gates it, and it never sends
   * further input. Returns false while the actual exit remains unobserved, so the
   * caller retains and reports the witness tree instead of declaring cleanup
   * success and the owned ConPTY reader is never closed over a possibly-live
   * transport.
   */
  async observeOuterExitAfterForce(): Promise<boolean> {
    if (this.exitEvent) return true;
    const budgetMs = this.cleanupRemaining(LAUNCHER_EXIT_OBSERVATION_BUDGET_MS);
    if (budgetMs <= 0) return false;
    try {
      await this.exitSignal.waitFor(() => this.exitEvent !== undefined, budgetMs, "forced outer public PTY exit");
    } catch {
      // An unobserved exit is reported by the caller; the failed case stays failed.
    }
    return this.exitEvent !== undefined;
  }

  /**
   * Settle every owned parent resource. The owned ConPTY reader is closed only
   * behind a positively observed outer exit (the guard is never relaxed) and only
   * under the remaining cleanup budget, so a delayed or never-settling reader
   * cleanup can never hold the failure hook past the deadline: it is reported as
   * `uncertain` and the leg's own failed result stands unchanged.
   */
  async settleSubscriptions(): Promise<LauncherSettlement> {
    try { this.dataSubscription.dispose(); } catch { /* exact outer PTY data subscription */ }
    try { this.exitSubscription.dispose(); } catch { /* exact outer PTY exit subscription */ }
    try { this.surface.dispose(); } catch { /* owned terminal model */ }
    try { this.logWatcher.close(); } catch { /* task-owned root watch */ }
    try { this.nativeWatcher.close(); } catch { /* task-owned journal watch */ }
    try { this.providerWatcher.close(); } catch { /* task-owned provider fixture watch */ }
    return settleOwnedConptyReader(
      this.exitEvent !== undefined,
      this.cleanupRemaining(LAUNCHER_READER_SETTLEMENT_BUDGET_MS),
      () => closeExitedOwnedConptyReader(this.pty),
    );
  }

  get forcedCleanup(): boolean {
    return this.forced;
  }

  get terminalOutputTail(): string {
    return this.outputTail;
  }
}

export function assertLegArithmetic(): void {
  assert.ok(LAUNCHER_LEG_DEADLINE_MS < LAUNCHER_TEST_TIMEOUT_MS, "each leg deadline is bounded below the whole-file budget");
  assert.ok(LAUNCHER_STARTUP_TIMEOUT_MS < LAUNCHER_LEG_DEADLINE_MS, "the real staged build/startup wait is bounded below the leg deadline");
  assert.ok(LAUNCHER_CLEANUP_BUDGET_MS > 0 && LAUNCHER_BODY_DEADLINE_MS > LAUNCHER_STARTUP_TIMEOUT_MS,
    "the cancelled body aborts early enough for bounded cleanup inside the leg deadline");
  assert.ok(LAUNCHER_LEG_DEADLINE_MS * LAUNCHER_LEGS.length <= LAUNCHER_TEST_TIMEOUT_MS,
    "all legs together fit the whole-file 20-minute budget");
  assert.ok(LAUNCHER_EXIT_OBSERVATION_BUDGET_MS > 0
      && LAUNCHER_READER_SETTLEMENT_BUDGET_MS > 0
      && LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS > 0
      && LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS + LAUNCHER_EXIT_OBSERVATION_BUDGET_MS + LAUNCHER_READER_SETTLEMENT_BUDGET_MS === LAUNCHER_CLEANUP_BUDGET_MS,
    "failure cleanup reserves its exact outer-exit observation and bounded reader settlement inside the original cleanup budget, never beyond it");
  assert.ok(LAUNCHER_EVENT_TIMEOUT_MS < LAUNCHER_OBSERVER_TIMEOUT_SECONDS * 1000,
    "event waits are bounded below the exact-process observer timeout");
  assert.equal(LAUNCHER_OUTER_COLS, 120);
  assert.equal(LAUNCHER_OUTER_ROWS, 50);
}

export { randomDigits };

export type { NativeJournalRecord, PtyJournalRecord, WindowsOwnedSession, WindowsPowerShellPin };
export { assertCreatedDirectoryIdentity, assertCredentialFreeNativeRecords, assertNoUnownedNativeSessions, identityOfRealDirectory, isSessionShutdownFor, probeWindowsPowerShell, sameFileIdentity, WindowsOwnedExitObserver as WindowsLegExitObserver };
export type { FileIdentity };
