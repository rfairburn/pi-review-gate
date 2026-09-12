/*
 * Derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { POWERSHELL_ARGS, wrapWithParentWatchdog, wrapWithPowerShellWatchdog } from "./jobs";
import { createBackgroundJobOwnership, type BackgroundJobOwnership } from "./ownership";

/**
 * Fixed platform shell contract (#99): the background job's shell is decided
 * by the platform and never by a tool argument or configuration value.
 *
 * - macOS/Linux: `/bin/bash` with the existing detached process-group contract,
 *   unchanged (wrapWithParentWatchdog + negative-pid group signalling).
 * - Windows: PowerShell — `pwsh.exe` first, then `powershell.exe` on PATH,
 *   matching Pi's native powershell-tool discovery (Pi docs/windows.md and
 *   dist/utils/shell.js getPowerShellConfig). Neither present => a clear error
 *   BEFORE any job is started. There is no per-call shell parameter, no
 *   arbitrary executable/argument interface, and discovering a different
 *   interpreter is not permission to retry a failed command under it.
 */

/**
 * Find an executable on the Windows PATH, mirroring Pi's findExecutableOnPath:
 * `where` can report paths that do not exist, so the first match must be
 * verified with existsSync before it is trusted. Returns null when absent —
 * including when `where` itself is missing or times out (fail closed for the
 * caller: no shell, no job).
 */
export function findWindowsExecutable(executable: string): string | null {
  try {
    const result = spawnSync("where", [executable], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch && existsSync(firstMatch)) return firstMatch;
    }
  } catch {
    /* where unavailable or timed out: treat as not found */
  }
  return null;
}

/**
 * Resolve the Windows PowerShell executable for background jobs. Throws with an
 * actionable prerequisite error when neither edition is on PATH, so ShellStart
 * can report the failure without starting a job. The diagnostic mirrors Pi's
 * own message for the same discovery failure.
 */
export function resolveWindowsPowerShell(): string {
  const shell = findWindowsExecutable("pwsh.exe") ?? findWindowsExecutable("powershell.exe");
  if (!shell) {
    throw new Error(
      "No PowerShell executable found on PATH (looked for pwsh.exe, then powershell.exe). " +
        "Install PowerShell 7 or add Windows PowerShell to PATH; ShellStart cannot start a job without one.",
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
