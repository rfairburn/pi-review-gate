/*
 * Derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { accessSync, constants } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import {
  POWERSHELL_ARGS,
  msixWorkloadScript,
  msixWorkloadVariableName,
  wrapWithMsixPowerShellLauncher,
  wrapWithParentWatchdog,
  wrapWithPowerShellWatchdog,
} from "./jobs";
import { createBackgroundJobOwnership, type BackgroundJobOwnership } from "./ownership";

/**
 * Fixed platform shell contract (#99): the background job's shell is decided
 * by the platform and never by a tool argument or configuration value.
 *
 * - macOS/Linux: `/bin/bash` with the existing detached process-group contract,
 *   unchanged (wrapWithParentWatchdog + negative-pid group signalling).
 * - Windows: PowerShell, discovered in exactly Pi 1.6.0's order (dist/utils/
 *   shell.js `getPowerShellConfig`): `where pwsh.exe`, then the PowerShell 7
 *   install location `%ProgramFiles%\PowerShell\7\pwsh.exe`, then `where
 *   powershell.exe`, then the Windows PowerShell install location
 *   `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (#405).
 *   Every existence test is `accessSync(path, F_OK)` — Pi deliberately avoids
 *   `existsSync()` there because its extra stat check rejects runnable
 *   Microsoft Store app-execution aliases (nodejs/node#36790). The single
 *   intentional difference from Pi (#405): when a `where` lookup TIMES OUT
 *   (`ETIMEDOUT`), it is retried once with a longer bound, because `where` on
 *   CI Windows runners sometimes exceeds the 5 s bound and one slow lookup must
 *   not silently read as "not installed" (a lookup that also exceeds the
 *   retry bound still counts as not found, exactly as in Pi). Nothing found — after that one retry —
 *   still means a clear error BEFORE any job is started: fail closed, no job,
 *   no shell. There is no per-call shell parameter, no arbitrary
 *   executable/argument interface, and discovering a different interpreter is
 *   not permission to retry a failed command under it.
 *   That lazy finder is Pi's interactive discovery and is unchanged. Which
 *   PowerShell HOSTS a background job is chosen separately by
 *   selectWindowsPowerShellForJobs (#800): ordinary PowerShell 7 first, a
 *   Store/MSIX PowerShell 7 next on its dedicated launcher route, then
 *   Windows PowerShell 5.1 on the ordinary route.
 */

/** Bound for one `where <executable>` lookup, matching Pi 1.6.0. */
export const WINDOWS_WHERE_TIMEOUT_MS = 5000;

/** Bound for the single retry of a `where` lookup that timed out (#405). */
export const WINDOWS_WHERE_RETRY_TIMEOUT_MS = 15000;

/** One observed `where <executable>` invocation, shaped as spawnSync reports
 *  it, so the discovery chain is unit-testable without spawning anything. */
export interface WindowsWhereProbe {
  /** Spawn-level failure or timeout; undefined when the process ran to exit. */
  error?: NodeJS.ErrnoException;
  status: number | null;
  stdout: string;
}

/** Injectable discovery dependencies, each with a production default:
 *  the `where` runner (real spawnSync), the path-existence check
 *  (accessSync F_OK), and the environment record (process.env). */
export interface WindowsPowerShellDiscoveryDeps {
  runWhere?: (executable: string, timeoutMs: number) => WindowsWhereProbe;
  /** Asynchronous `where` runner used by ShellStart's job-shell selection
   *  (selectWindowsPowerShellForJobsAsync), so discovery never blocks the
   *  host's event loop. Same probe shape and bounds as runWhere. */
  runWhereAsync?: (executable: string, timeoutMs: number) => Promise<WindowsWhereProbe>;
  pathExists?: (path: string) => boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Pi's `shellPathExists`: `accessSync(path, F_OK)`, false on any throw.
 *  Deliberately not `existsSync()` — the extra stat check rejects runnable
 *  Microsoft Store app-execution aliases (nodejs/node#36790). */
function windowsPathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Production `where` runner: one bounded, window-hidden synchronous lookup. */
function runWhereSync(executable: string, timeoutMs: number): WindowsWhereProbe {
  const result = spawnSync("where", [executable], {
    encoding: "utf-8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    error: result.error as NodeJS.ErrnoException | undefined,
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

/** Captured `where` output is bounded: a few PATH matches are a few hundred
 *  bytes, and a lookup must never accumulate unbounded output. */
const MAX_WHERE_OUTPUT_CHARS = 65_536;

/**
 * Production asynchronous `where` runner: the same bounded, window-hidden
 * lookup as runWhereSync, off the event loop. A lookup that exceeds its bound
 * is ended through its own ChildProcess handle and reported as ETIMEDOUT,
 * exactly the shape spawnSync gives a timed-out lookup.
 */
function runWhereAsync(executable: string, timeoutMs: number): Promise<WindowsWhereProbe> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn("where", [executable], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      resolve({ error: err as NodeJS.ErrnoException, status: null, stdout: "" });
      return;
    }
    const finish = (probe: WindowsWhereProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      const error = Object.assign(new Error(`where ${executable} timed out`), { code: "ETIMEDOUT" }) as NodeJS.ErrnoException;
      finish({ error, status: null, stdout });
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_WHERE_OUTPUT_CHARS) stdout += chunk;
    });
    child.on("error", (err) => finish({ error: err as NodeJS.ErrnoException, status: null, stdout: "" }));
    child.on("close", (code) => finish({ status: code, stdout }));
  });
}

/** The selected existence check with Pi's fail-closed behavior: an exception —
 *  from the default filesystem check or from an injected one — is a refused
 *  candidate, never an error that escapes discovery and stops the chain from
 *  trying the next candidate. */
function existsOrFalse(exists: (path: string) => boolean, path: string): boolean {
  try {
    return exists(path);
  } catch {
    return false;
  }
}

/**
 * Find an executable the way Pi's `findExecutableOnPath` does on Windows:
 * `where` can report paths that do not exist, so the first reported line must
 * be verified by the existence check before it is trusted. A lookup that
 * timed out is retried exactly once with the longer bound (#405) — the one
 * intentional difference from Pi. Like Pi, an unexpected throw from the lookup
 * is caught and counts as a failed attempt (a throw is not a timeout, so it is
 * never retried), and an existence check that throws only refuses that one
 * candidate. Returns null when absent — including when `where` itself is
 * missing, throws, times out twice, or reports an unusable path (fail closed
 * for the caller: no shell, no job).
 */
export function findWindowsExecutable(
  executable: string,
  deps: WindowsPowerShellDiscoveryDeps = {},
): string | null {
  const runWhere = deps.runWhere ?? runWhereSync;
  const pathExists = deps.pathExists ?? windowsPathExists;
  // Pi wraps the lookup so an unexpected throw reads as "not found" instead of
  // escaping discovery. A throw is not a timeout, so it is never retried.
  const attempt = (timeoutMs: number): WindowsWhereProbe => {
    try {
      return runWhere(executable, timeoutMs);
    } catch {
      return { status: null, stdout: "" };
    }
  };
  const first = attempt(WINDOWS_WHERE_TIMEOUT_MS);
  // Only a timeout is retried, and only once: exit 1 is `where` answering
  // "not found", and any other outcome is already an answer.
  const resolved = first.error?.code === "ETIMEDOUT"
    ? attempt(WINDOWS_WHERE_RETRY_TIMEOUT_MS)
    : first;
  // A timed-out lookup is not an answer even when the same result also carries
  // exit status 0 and captured output: Node reports those fields separately, so
  // neither makes the lookup successful, and the chain must keep going.
  if (resolved.error?.code === "ETIMEDOUT") return null;
  if (resolved.status === 0 && resolved.stdout) {
    const firstMatch = resolved.stdout.trim().split(/\r?\n/)[0];
    if (firstMatch && existsOrFalse(pathExists, firstMatch)) return firstMatch;
  }
  return null;
}

/**
 * Resolve the Windows PowerShell executable exactly as Pi 1.6.0's
 * `getPowerShellConfig` does, without throwing: `where pwsh.exe`, then the
 * PowerShell 7 install location under `%ProgramFiles%` (only when that
 * variable is set and the file exists), then `where powershell.exe`, then the
 * System32 Windows PowerShell location under `%SystemRoot%` (same conditions).
 * Returns null when nothing resolves. Nothing escapes here: a failing lookup or
 * a throwing existence check refuses that candidate and the chain continues,
 * so the only error this module raises is resolveWindowsPowerShell's
 * prerequisite error.
 */
export function findWindowsPowerShell(deps: WindowsPowerShellDiscoveryDeps = {}): string | null {
  // LAZY ON PURPOSE, and pinned by windows-powershell-discovery.test.ts: the
  // chain stops at its first hit, so a resolvable `pwsh.exe` never triggers a
  // `where powershell.exe` lookup and an earlier install location is never
  // stat-ed. Discovery cost and lookup order are part of Pi parity.
  const pwsh = findWindowsExecutable("pwsh.exe", deps);
  if (pwsh) return pwsh;
  const pwsh7 = programFilesPwsh7Location(deps);
  if (pwsh7) return pwsh7;
  const windowsPowerShell = findWindowsExecutable("powershell.exe", deps);
  if (windowsPowerShell) return windowsPowerShell;
  return systemRootWindowsPowerShellLocation(deps);
}

/** `%ProgramFiles%\PowerShell\7\pwsh.exe` when it exists, else null. */
function programFilesPwsh7Location(deps: WindowsPowerShellDiscoveryDeps): string | null {
  const pathExists = deps.pathExists ?? windowsPathExists;
  const programFiles = (deps.env ?? process.env).ProgramFiles;
  if (!programFiles) return null;
  const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
  return existsOrFalse(pathExists, pwsh7) ? pwsh7 : null;
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` when it
 *  exists, else null. */
function systemRootWindowsPowerShellLocation(deps: WindowsPowerShellDiscoveryDeps): string | null {
  const pathExists = deps.pathExists ?? windowsPathExists;
  const systemRoot = (deps.env ?? process.env).SystemRoot;
  if (!systemRoot) return null;
  const wps = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsOrFalse(pathExists, wps) ? wps : null;
}

/** The single prerequisite failure for "no PowerShell at all", shared by the
 *  lazy discovery API and the job-shell selection so both keep the exact
 *  message. */
function noWindowsPowerShellError(): Error {
  return new Error(
    "No PowerShell executable found: pwsh.exe and powershell.exe are not on PATH, and neither the " +
      "PowerShell 7 install location (%ProgramFiles%\\PowerShell\\7\\pwsh.exe) nor the Windows PowerShell " +
      "install location (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe) exists. " +
      "Install PowerShell 7 or Windows PowerShell, or add it to PATH; ShellStart cannot start a job without one.",
  );
}

/**
 * Resolve the Windows PowerShell executable exactly as Pi's lazy finder does.
 * Throws with an actionable prerequisite error when no edition resolves at
 * all. The diagnostic covers both Pi's PATH lookups and its standard install
 * locations.
 */
export function resolveWindowsPowerShell(deps: WindowsPowerShellDiscoveryDeps = {}): string {
  const shell = findWindowsPowerShell(deps);
  if (!shell) throw noWindowsPowerShellError();
  return shell;
}

/**
 * Background-job shell selection (#800).
 *
 * Which PowerShell HOSTS a background job is decided here, separately from
 * Pi's lazy interactive finder above (which stays exactly as it is). Measured
 * on native Windows 11: a Microsoft Store (MSIX) PowerShell 7 accepts
 * assignment to a job object and is itself a member, yet by default every
 * process it creates is created outside the desktop-app runtime and joins no
 * job at all, so no job handle can reach or stop it. The identical build run
 * unpackaged, and Windows PowerShell 5.1, contain their children normally.
 *
 * The order is therefore:
 *
 * 1. an ordinary (unpackaged) PowerShell 7 — EVERY `where pwsh.exe` line is
 *    considered, not only the first, so an app-execution alias earlier on PATH
 *    cannot hide an installed ZIP/MSI PowerShell 7 later on PATH, followed by
 *    the `%ProgramFiles%\PowerShell\7\pwsh.exe` install location;
 * 2. a Store/MSIX PowerShell 7 (its alias or its WindowsApps package path),
 *    which runs the job through the dedicated MSIX launcher
 *    (wrapWithMsixPowerShellLauncher) — the only route that applies the
 *    desktop-app launch policy, and only after that launcher has positively
 *    confirmed its own package identity;
 * 3. Windows PowerShell 5.1 exactly as Pi resolves it (`where powershell.exe`
 *    first line, then the System32 install location), on the unchanged
 *    ordinary route.
 *
 * Nothing here runs a candidate: classification is by path only, it never
 * probes a shell, and an unclassifiable path is treated as ordinary (the
 * workaround is never applied on inference). The launcher's runtime package
 * check is what decides whether the workaround actually applies.
 */
export type WindowsJobShellRoute = "ordinary" | "msix";

export interface WindowsShellSelection {
  executable: string;
  route: WindowsJobShellRoute;
}

/** `<Name>_<PublisherId>`: a package family name (alias subdirectory). */
const PACKAGE_FAMILY_NAME = /^[a-z0-9.-]+_[a-z0-9]{13}$/i;
/** `<Name>_<Version>_<Architecture>_<ResourceId>_<PublisherId>`: a package
 *  full name (package install directory). */
const PACKAGE_FULL_NAME = /^[a-z0-9.-]+_\d+\.\d+\.\d+\.\d+_(x86|x64|arm|arm64|neutral)_[a-z0-9.~-]*_[a-z0-9]{13}$/i;

/**
 * True for a path with the shape of an actual Windows package location — never
 * for a directory merely NAMED `WindowsApps` (an unpackaged ZIP at
 * `D:\Tools\WindowsApps\pwsh.exe` stays ordinary). Two shapes are recognised,
 * and both run the same actual package:
 *
 * - an app-execution alias: a file directly in the per-user alias directory
 *   `...\AppData\Local\Microsoft\WindowsApps` (or `%LOCALAPPDATA%\Microsoft\
 *   WindowsApps` when LOCALAPPDATA is elsewhere), or in a package-family
 *   subdirectory of it (`...\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\`);
 * - a direct package image: a file directly in `<anything>\WindowsApps\
 *   <PackageFullName>\` (`%ProgramFiles%\WindowsApps\...`, or another volume's
 *   `WindowsApps` package root).
 *
 * A path-only classification by design — it starts no process and decides
 * only preference order; the MSIX launcher re-checks package identity on the
 * live process before it applies anything, and fails closed without one.
 */
export function isWindowsAppsPackagePath(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const lower = segments.map((segment) => segment.toLowerCase());
  const n = segments.length;
  if (n < 3) return false;
  // Direct package image: ...\WindowsApps\<PackageFullName>\<file>.
  if (lower[n - 3] === "windowsapps" && PACKAGE_FULL_NAME.test(segments[n - 2])) return true;
  // App-execution alias: <alias dir>\<file> or <alias dir>\<family>\<file>.
  const localAppData = env.LOCALAPPDATA
    ? env.LOCALAPPDATA.split(/[\\/]+/).filter((segment) => segment.length > 0).map((segment) => segment.toLowerCase())
    : [];
  const isAliasDir = (end: number): boolean => {
    // `end` is the index of the `WindowsApps` segment.
    if (end < 1 || lower[end] !== "windowsapps" || lower[end - 1] !== "microsoft") return false;
    const base = lower.slice(0, end - 1);
    if (base.length >= 2 && base[base.length - 2] === "appdata" && base[base.length - 1] === "local") return true;
    return localAppData.length > 0 && base.length === localAppData.length && base.every((s, i) => s === localAppData[i]);
  };
  if (isAliasDir(n - 2)) return true;
  return PACKAGE_FAMILY_NAME.test(segments[n - 2]) && isAliasDir(n - 3);
}

/**
 * Every path `where <executable>` reports that the existence check accepts, in
 * order, with the same single retry-on-timeout and fail-closed rules as
 * findWindowsExecutable. Used only by job-shell selection; Pi's finder keeps
 * its first-line-only rule.
 */
export function findWindowsExecutableMatches(
  executable: string,
  deps: WindowsPowerShellDiscoveryDeps = {},
): string[] {
  const runWhere = deps.runWhere ?? runWhereSync;
  const pathExists = deps.pathExists ?? windowsPathExists;
  const attempt = (timeoutMs: number): WindowsWhereProbe => {
    try {
      return runWhere(executable, timeoutMs);
    } catch {
      return { status: null, stdout: "" };
    }
  };
  const first = attempt(WINDOWS_WHERE_TIMEOUT_MS);
  const resolved = first.error?.code === "ETIMEDOUT" ? attempt(WINDOWS_WHERE_RETRY_TIMEOUT_MS) : first;
  return whereMatches(resolved, pathExists);
}

/** Every existing, de-duplicated line of one resolved `where` probe; a timed
 *  out or unsuccessful probe has none. Shared by both runners. */
function whereMatches(resolved: WindowsWhereProbe, pathExists: (path: string) => boolean): string[] {
  if (resolved.error?.code === "ETIMEDOUT") return [];
  if (resolved.status !== 0 || !resolved.stdout) return [];
  const matches: string[] = [];
  for (const line of resolved.stdout.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (matches.some((seen) => seen.toLowerCase() === candidate.toLowerCase())) continue;
    if (existsOrFalse(pathExists, candidate)) matches.push(candidate);
  }
  return matches;
}

/** One `where` lookup through the asynchronous runner, with the same single
 *  retry-on-timeout and throw-is-a-failed-attempt rules as the sync path. */
async function whereAsyncWithRetry(executable: string, deps: WindowsPowerShellDiscoveryDeps): Promise<WindowsWhereProbe> {
  const runWhere = deps.runWhereAsync ?? runWhereAsync;
  const attempt = async (timeoutMs: number): Promise<WindowsWhereProbe> => {
    try {
      return await runWhere(executable, timeoutMs);
    } catch {
      return { status: null, stdout: "" };
    }
  };
  const first = await attempt(WINDOWS_WHERE_TIMEOUT_MS);
  return first.error?.code === "ETIMEDOUT" ? attempt(WINDOWS_WHERE_RETRY_TIMEOUT_MS) : first;
}

/** findWindowsExecutableMatches through the asynchronous runner. */
export async function findWindowsExecutableMatchesAsync(
  executable: string,
  deps: WindowsPowerShellDiscoveryDeps = {},
): Promise<string[]> {
  return whereMatches(await whereAsyncWithRetry(executable, deps), deps.pathExists ?? windowsPathExists);
}

/** findWindowsExecutable (Pi's first-line rule) through the asynchronous runner. */
async function findWindowsExecutableAsync(
  executable: string,
  deps: WindowsPowerShellDiscoveryDeps,
): Promise<string | null> {
  const resolved = await whereAsyncWithRetry(executable, deps);
  if (resolved.error?.code === "ETIMEDOUT") return null;
  if (resolved.status === 0 && resolved.stdout) {
    const firstMatch = resolved.stdout.trim().split(/\r?\n/)[0];
    if (firstMatch && existsOrFalse(deps.pathExists ?? windowsPathExists, firstMatch)) return firstMatch;
  }
  return null;
}

/**
 * Select the PowerShell that hosts a background job, in the order documented
 * above. Lazy where it can be: an ordinary PowerShell 7 on the first `where`
 * line ends the search, and `powershell.exe` is looked up only when no
 * PowerShell 7 of either form exists. Throws the prerequisite error (before
 * any job starts) when nothing resolves at all.
 */
export function selectWindowsPowerShellForJobs(deps: WindowsPowerShellDiscoveryDeps = {}): WindowsShellSelection {
  const seven = selectPowerShell7(findWindowsExecutableMatches("pwsh.exe", deps), deps);
  if (seven) return seven;
  return selectWindowsPowerShell51(findWindowsExecutable("powershell.exe", deps), deps);
}

/**
 * selectWindowsPowerShellForJobs with every `where` lookup run asynchronously
 * (same order, bounds, retry, and laziness), so ShellStart never blocks the
 * host's event loop on discovery. This is what production ShellStart uses.
 */
export async function selectWindowsPowerShellForJobsAsync(
  deps: WindowsPowerShellDiscoveryDeps = {},
): Promise<WindowsShellSelection> {
  const seven = selectPowerShell7(await findWindowsExecutableMatchesAsync("pwsh.exe", deps), deps);
  if (seven) return seven;
  return selectWindowsPowerShell51(await findWindowsExecutableAsync("powershell.exe", deps), deps);
}

/** Steps 1-2 of the selection order, from the `where pwsh.exe` matches. */
function selectPowerShell7(pwshMatches: string[], deps: WindowsPowerShellDiscoveryDeps): WindowsShellSelection | null {
  const env = deps.env ?? process.env;
  let packaged: string | null = null;
  for (const candidate of pwshMatches) {
    if (!isWindowsAppsPackagePath(candidate, env)) return { executable: candidate, route: "ordinary" };
    packaged ??= candidate;
  }
  const installed = programFilesPwsh7Location(deps);
  if (installed && !isWindowsAppsPackagePath(installed, env)) return { executable: installed, route: "ordinary" };
  return packaged ? { executable: packaged, route: "msix" } : null;
}

/** Step 3: Windows PowerShell exactly as Pi resolves it, or the prerequisite error. */
function selectWindowsPowerShell51(whereMatch: string | null, deps: WindowsPowerShellDiscoveryDeps): WindowsShellSelection {
  const windowsPowerShell = whereMatch ?? systemRootWindowsPowerShellLocation(deps);
  if (windowsPowerShell) return { executable: windowsPowerShell, route: "ordinary" };
  throw noWindowsPowerShellError();
}

/** A started background job plus, on Windows, the per-job ownership identity
 *  (job-object record/stop paths) that keeps descendants accounted for and
 *  cleanable after the shell root exits. */
export interface SpawnedBackgroundJob {
  proc: ChildProcess;
  /** Windows only; undefined on macOS/Linux (process groups already cover
   *  descendants there). */
  ownership?: BackgroundJobOwnership;
  /** Windows only: which shell hosts the job and on which route, so the caller
   *  can explain the Store/MSIX route in user-facing text. */
  shellSelection?: WindowsShellSelection;
}

/**
 * The single production spawn point for background jobs — ShellStart and the
 * tests both go through here, so what is tested is what runs.
 *
 * Windows, ordinary route (unchanged): spawn the selected PowerShell directly
 * with Pi's exact argument list plus the watchdog-wrapped command as one
 * -Command string (Node passes it verbatim; no cmd.exe layer). No `detached` —
 * Windows has no POSIX process group; instead the wrapper hands the whole tree
 * to a job object owned by a per-job watchdog that outlives the shell root
 * (see wrapWithPowerShellWatchdog and ownership.ts); the per-job stop file is
 * the stop request, and the watchdog terminates the job object on its next
 * poll.
 *
 * Windows, Store/MSIX route: the same executable runs the MSIX launcher
 * instead (wrapWithMsixPowerShellLauncher). The command text travels in a
 * per-job environment variable that the launcher and the workload remove
 * before the command runs, so no user text is ever embedded in launcher
 * script text. Pipes, cwd, and window hiding are the ordinary ones.
 *
 * macOS/Linux: unchanged — the Bash watchdog wrapper through /bin/bash in its
 * own detached process group.
 */
export function spawnBackgroundJob(
  command: string,
  parentPid: number,
  pollSeconds = 5,
  selection?: WindowsShellSelection,
): SpawnedBackgroundJob {
  if (process.platform === "win32") {
    // Throws (before any job is started) when nothing resolves at all.
    const chosen = selection ?? selectWindowsPowerShellForJobs();
    // Ownership identity created BEFORE the shell starts: the wrapper fails
    // closed without it, and the record/stop paths must already be agreed.
    const ownership = createBackgroundJobOwnership();
    if (chosen.route === "msix") {
      const workloadVariable = msixWorkloadVariableName(ownership.token);
      return {
        proc: spawn(
          chosen.executable,
          [...POWERSHELL_ARGS, wrapWithMsixPowerShellLauncher(parentPid, pollSeconds, { ...ownership, workloadVariable })],
          {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, [workloadVariable]: msixWorkloadScript(command) },
          },
        ),
        ownership,
        shellSelection: chosen,
      };
    }
    return {
      proc: spawn(
        chosen.executable,
        [...POWERSHELL_ARGS, wrapWithPowerShellWatchdog(command, parentPid, pollSeconds, ownership)],
        {
          stdio: ["pipe", "pipe", "pipe"],
          // No console window for background jobs.
          windowsHide: true,
        },
      ),
      ownership,
      shellSelection: chosen,
    };
  }
  return {
    proc: spawn(wrapWithParentWatchdog(command, parentPid, pollSeconds), {
      shell: "/bin/bash",
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  };
}
