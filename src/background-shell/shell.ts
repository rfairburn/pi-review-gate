/*
 * Derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { accessSync, constants } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import { POWERSHELL_ARGS, wrapWithParentWatchdog, wrapWithPowerShellWatchdog } from "./jobs";
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
 *   CI Windows runners sometimes exceeds the 5 s bound and a timeout must not
 *   silently read as "not installed". Nothing found — after that one retry —
 *   still means a clear error BEFORE any job is started: fail closed, no job,
 *   no shell. There is no per-call shell parameter, no arbitrary
 *   executable/argument interface, and discovering a different interpreter is
 *   not permission to retry a failed command under it.
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
  const pathExists = deps.pathExists ?? windowsPathExists;
  const env = deps.env ?? process.env;

  const pwsh = findWindowsExecutable("pwsh.exe", deps);
  if (pwsh) return pwsh;
  const programFiles = env.ProgramFiles;
  if (programFiles) {
    const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
    if (existsOrFalse(pathExists, pwsh7)) return pwsh7;
  }

  const windowsPowerShell = findWindowsExecutable("powershell.exe", deps);
  if (windowsPowerShell) return windowsPowerShell;
  const systemRoot = env.SystemRoot;
  if (systemRoot) {
    const wps = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsOrFalse(pathExists, wps)) return wps;
  }
  return null;
}

/**
 * Resolve the Windows PowerShell executable for background jobs. Throws with an
 * actionable prerequisite error when no edition resolves at all, so ShellStart
 * can report the failure without starting a job. The diagnostic covers both
 * Pi's PATH lookups and its standard install locations.
 */
export function resolveWindowsPowerShell(deps: WindowsPowerShellDiscoveryDeps = {}): string {
  const shell = findWindowsPowerShell(deps);
  if (!shell) {
    throw new Error(
      "No PowerShell executable found: pwsh.exe and powershell.exe are not on PATH, and neither the " +
        "PowerShell 7 install location (%ProgramFiles%\\PowerShell\\7\\pwsh.exe) nor the Windows PowerShell " +
        "install location (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe) exists. " +
        "Install PowerShell 7 or Windows PowerShell, or add it to PATH; ShellStart cannot start a job without one.",
    );
  }
  return shell;
}

/** A started background job plus, on Windows, the per-job ownership identity
 *  (job-object record/stop paths) that keeps descendants accounted for and
 *  cleanable after the shell root exits. */
export interface SpawnedBackgroundJob {
  proc: ChildProcess;
  /** Windows only; undefined on macOS/Linux (process groups already cover
   *  descendants there). */
  ownership?: BackgroundJobOwnership;
}

/**
 * The single production spawn point for background jobs — ShellStart and the
 * tests both go through here, so what is tested is what runs.
 *
 * Windows: spawn the resolved PowerShell directly with Pi's exact argument
 * list plus the watchdog-wrapped command as one -Command string (Node passes
 * it verbatim; no cmd.exe layer). No `detached` — Windows has no POSIX process
 * group; instead the wrapper hands the whole tree to a job object owned by a
 * per-job watchdog that outlives the shell root (see
 * wrapWithPowerShellWatchdog and ownership.ts); the per-job stop file is the
 * stop request, and the watchdog terminates the job object on its next poll.
 *
 * macOS/Linux: unchanged — the Bash watchdog wrapper through /bin/bash in its
 * own detached process group.
 */
export function spawnBackgroundJob(command: string, parentPid: number, pollSeconds = 5): SpawnedBackgroundJob {
  if (process.platform === "win32") {
    const executable = resolveWindowsPowerShell(); // throws before any job is started
    // Ownership identity created BEFORE the shell starts: the wrapper fails
    // closed without it, and the record/stop paths must already be agreed.
    const ownership = createBackgroundJobOwnership();
    return {
      proc: spawn(
        executable,
        [...POWERSHELL_ARGS, wrapWithPowerShellWatchdog(command, parentPid, pollSeconds, ownership)],
        {
          stdio: ["pipe", "pipe", "pipe"],
          // No console window for background jobs.
          windowsHide: true,
        },
      ),
      ownership,
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
