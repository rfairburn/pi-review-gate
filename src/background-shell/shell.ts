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
 *   CI Windows runners sometimes exceeds the 5 s bound and one slow lookup must
 *   not silently read as "not installed" (a lookup that also exceeds the
 *   retry bound still counts as not found, exactly as in Pi). Nothing found — after that one retry —
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

/**
 * Every Windows PowerShell candidate in Pi's discovery order, with the standard
 * install locations expanded in place: `pwsh.exe` on PATH, the PowerShell 7
 * install location, `powershell.exe` on PATH, then the Windows PowerShell
 * install location. The first entry is always what the lazy chain above
 * resolves, so this list adds no discovery behaviour of its own; it exists so
 * the containment preflight can consider the NEXT edition when the preferred
 * one cannot contain its children. Duplicates collapse case-insensitively, so
 * one executable is never probed twice.
 */
export function findWindowsPowerShellCandidates(deps: WindowsPowerShellDiscoveryDeps = {}): string[] {
  const candidates: string[] = [];
  const add = (candidate: string | null): void => {
    if (!candidate) return;
    if (candidates.some((seen) => seen.toLowerCase() === candidate.toLowerCase())) return;
    candidates.push(candidate);
  };
  add(findWindowsExecutable("pwsh.exe", deps));
  add(programFilesPwsh7Location(deps));
  add(findWindowsExecutable("powershell.exe", deps));
  add(systemRootWindowsPowerShellLocation(deps));
  return candidates;
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

/**
 * Containment preflight (#800).
 *
 * A background job is only cleanable while the processes it starts actually
 * join its job object. That is a property of the SHELL INSTALLATION, not of the
 * job: measured on native Windows 11, a packaged (Microsoft Store/MSIX)
 * `pwsh.exe` accepts `AssignProcessToJobObject` and is itself a member, yet
 * every process it creates lands in NO job at all — the kernel never enrols
 * them, so no job handle can ever reach them. The identical 7.7.0 build run
 * from the downloaded zip, and `powershell.exe` 5.1, both contain their
 * children normally. Launching the packaged binary directly instead of through
 * its app-execution alias makes no difference, so this cannot be fixed by
 * resolving a different path: the installation form decides it.
 *
 * The observable we need is therefore behavioural and one hop deep: create a
 * job, join it, create one child, and ask whether that child joined. A root
 * self-check cannot detect this (the root IS a member); only a child probe can.
 *
 * Cost is paid once per executable per host process — the verdict is cached —
 * and the preflight is warmed at session start, so starting a job adds nothing.
 * An inconclusive probe reports "unknown" and changes nothing.
 */
export type WindowsContainmentVerdict = "contained" | "uncontained" | "unknown";

/** Bound for one probe process (it starts a shell plus one short-lived child). */
export const WINDOWS_CONTAINMENT_PROBE_TIMEOUT_MS = 8000;

/** Injectable probe dependency; the production default runs the real probe. */
export interface WindowsContainmentDeps {
  runProbe?: (executable: string) => WindowsContainmentVerdict;
}

/** The probe body. It creates a job, joins it with its own identity, creates
 *  exactly one child through the direct creation path, reads that child's
 *  membership through the handle it already holds, terminates that child
 *  through the same handle (never a pid lookup) and reports the verdict.
 *  Windows PowerShell 5.1 and PowerShell 7 both run it. */
export const WINDOWS_CONTAINMENT_PROBE_SCRIPT =
  "try { Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
  "public static class PiContainmentProbe{" +
  "[DllImport(\"kernel32.dll\",SetLastError=true)]public static extern IntPtr CreateJobObjectW(IntPtr a,string n);" +
  "[DllImport(\"kernel32.dll\",SetLastError=true)]public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);" +
  "[DllImport(\"kernel32.dll\",SetLastError=true)]public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool m);" +
  "[DllImport(\"kernel32.dll\")]public static extern IntPtr OpenProcess(uint a,bool b,int p);" +
  "[DllImport(\"kernel32.dll\")]public static extern bool CloseHandle(IntPtr h);" +
  "[DllImport(\"kernel32.dll\")]public static extern bool TerminateProcess(IntPtr h,uint c);" +
  "public static int InJob(IntPtr h,IntPtr j){bool m;if(!IsProcessInJob(h,j,out m)){return -1;}return m?1:0;}}' " +
  "-ErrorAction Stop } catch { [Console]::Out.WriteLine('PRG-CONTAINMENT=unknown'); exit 0 }; " +
  "$job=[PiContainmentProbe]::CreateJobObjectW([IntPtr]::Zero,$null); " +
  "if($job -eq [IntPtr]::Zero){'PRG-CONTAINMENT=unknown';exit 0}; " +
  "$self=[PiContainmentProbe]::OpenProcess(0x1FFFFF,$false,$PID); " +
  "$ok=[PiContainmentProbe]::AssignProcessToJobObject($job,$self); " +
  "[void][PiContainmentProbe]::CloseHandle($self); " +
  "if(-not $ok){'PRG-CONTAINMENT=unknown';[void][PiContainmentProbe]::CloseHandle($job);exit 0}; " +
  "$psi=New-Object System.Diagnostics.ProcessStartInfo; " +
  "$psi.FileName=$env:ComSpec; $psi.Arguments='/c ping -n 4 127.0.0.1'; " +
  "$psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; " +
  "$p=[System.Diagnostics.Process]::Start($psi); " +
  "$m=-1; try { $m=[PiContainmentProbe]::InJob($p.Handle,$job) } catch { $m=-1 }; " +
  "try { [void][PiContainmentProbe]::TerminateProcess($p.Handle,1) } catch {}; " +
  "try { [void]$p.WaitForExit(5000) } catch {}; " +
  "[void][PiContainmentProbe]::CloseHandle($job); " +
  "if($m -eq 1){'PRG-CONTAINMENT=contained'}elseif($m -eq 0){'PRG-CONTAINMENT=uncontained'}else{'PRG-CONTAINMENT=unknown'}; exit 0";

/** One cached verdict per executable (case-insensitive), for the lifetime of
 *  the host process: which job a shell installation joins its children to is
 *  not a per-job property, so a repeat probe would only add latency. */
const containmentVerdicts = new Map<string, WindowsContainmentVerdict>();

/** Parse one probe run's output. Anything unrecognized is "unknown" — never
 *  "uncontained", so a broken probe cannot demote a working shell. */
function parseContainmentProbeOutput(output: string): WindowsContainmentVerdict {
  const match = /PRG-CONTAINMENT=(contained|uncontained)\b/.exec(output);
  if (!match) return "unknown";
  return match[1] === "contained" ? "contained" : "uncontained";
}

/** Production probe: one hidden shell, bounded, stdout only. */
function runContainmentProbe(executable: string): WindowsContainmentVerdict {
  const result = spawnSync(executable, [...POWERSHELL_ARGS, WINDOWS_CONTAINMENT_PROBE_SCRIPT], {
    encoding: "utf-8",
    timeout: WINDOWS_CONTAINMENT_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return parseContainmentProbeOutput(result.stdout ?? "");
}

/** Async variant used by the session-start warm-up so every candidate is probed
 *  concurrently instead of paying each shell's startup cost in sequence. */
function runContainmentProbeAsync(executable: string): Promise<WindowsContainmentVerdict> {
  return new Promise<WindowsContainmentVerdict>((resolve) => {
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (verdict: WindowsContainmentVerdict): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(verdict);
    };
    let child: ChildProcess;
    try {
      child = spawn(executable, [...POWERSHELL_ARGS, WINDOWS_CONTAINMENT_PROBE_SCRIPT], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve("unknown");
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* judged by the verdict below */ }
      finish("unknown");
    }, WINDOWS_CONTAINMENT_PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.once("error", () => finish("unknown"));
    child.once("close", () => finish(parseContainmentProbeOutput(output)));
  });
}

/** Cached verdict for one executable, probing only when it is genuinely
 *  unknown. A probe failure or throw is "unknown", never "uncontained". */
function containmentVerdictFor(
  executable: string,
  runProbe: (executable: string) => WindowsContainmentVerdict,
): WindowsContainmentVerdict {
  const key = executable.toLowerCase();
  const cached = containmentVerdicts.get(key);
  if (cached !== undefined) return cached;
  let verdict: WindowsContainmentVerdict;
  try {
    verdict = runProbe(executable);
  } catch {
    verdict = "unknown";
  }
  containmentVerdicts.set(key, verdict);
  return verdict;
}

/** How the job's shell was chosen. */
export interface WindowsShellSelection {
  executable: string;
  /** `verified`: the first discovery candidate contained its children.
   *  `fallback`: an earlier candidate did not contain, so a later one was used.
   *  `unverified`: no candidate was shown to contain; the preferred candidate
   *  is used unchanged and a stop reports an unconfirmed outcome honestly. */
  containment: "verified" | "fallback" | "unverified";
  /** Candidates that reported "uncontained", in discovery order. */
  rejected: string[];
}

/**
 * Choose the shell that will HOST a background job: the first discovery
 * candidate whose children join a job object. Discovery order is otherwise
 * untouched, so a host whose preferred shell contains behaves exactly as
 * before. When nothing is shown to contain, the preferred candidate is still
 * used — ShellStart never refuses a job over this — and the caller reports the
 * unverified state instead of implying a whole-tree stop it cannot make.
 */
export function selectWindowsPowerShellForJobs(
  deps: WindowsPowerShellDiscoveryDeps & WindowsContainmentDeps = {},
): WindowsShellSelection {
  const candidates = findWindowsPowerShellCandidates(deps);
  if (candidates.length === 0) {
    // Reuse the prerequisite error (and its message) of the single-shell API.
    resolveWindowsPowerShell(deps);
    throw new Error("No PowerShell executable found.");
  }
  const runProbe = deps.runProbe ?? runContainmentProbe;
  const rejected: string[] = [];
  for (const candidate of candidates) {
    const verdict = containmentVerdictFor(candidate, runProbe);
    if (verdict === "contained") {
      return { executable: candidate, containment: rejected.length > 0 ? "fallback" : "verified", rejected };
    }
    if (verdict === "uncontained") rejected.push(candidate);
  }
  return { executable: candidates[0], containment: "unverified", rejected };
}

/**
 * Warm the containment cache at session start, concurrently, and never throw:
 * this only moves the one-time probe cost off the first `ShellStart`. Sessions
 * that never start a Windows job still pay one short shell startup per
 * candidate, bounded by `WINDOWS_CONTAINMENT_PROBE_TIMEOUT_MS`.
 */
export async function warmWindowsContainment(
  deps: WindowsPowerShellDiscoveryDeps & WindowsContainmentDeps = {},
): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const candidates = findWindowsPowerShellCandidates(deps);
    const pending = candidates.filter((candidate) => containmentVerdicts.get(candidate.toLowerCase()) === undefined);
    const runProbe = deps.runProbe;
    await Promise.all(pending.map(async (candidate) => {
      let verdict: WindowsContainmentVerdict = "unknown";
      try {
        verdict = runProbe ? runProbe(candidate) : await runContainmentProbeAsync(candidate);
      } catch {
        verdict = "unknown";
      }
      containmentVerdicts.set(candidate.toLowerCase(), verdict);
    }));
  } catch {
    /* the preflight is an optimisation; a cold cache is handled on demand */
  }
}

/** A started background job plus, on Windows, the per-job ownership identity
 *  (job-object record/stop paths) that keeps descendants accounted for and
 *  cleanable after the shell root exits. */
export interface SpawnedBackgroundJob {
  proc: ChildProcess;
  /** Windows only; undefined on macOS/Linux (process groups already cover
   *  descendants there). */
  ownership?: BackgroundJobOwnership;
  /** Windows only: how the job's shell was chosen, so the caller can report an
   *  edition fallback (or an unverified containment) instead of implying a
   *  whole-tree stop it cannot deliver. */
  shellSelection?: WindowsShellSelection;
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
    // Containment-aware selection: keeps discovery order and only moves to the
    // next candidate when the preferred shell's children do not join a job.
    // Throws (before any job is started) when nothing resolves at all.
    const selection = selectWindowsPowerShellForJobs();
    const executable = selection.executable;
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
      shellSelection: selection,
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
