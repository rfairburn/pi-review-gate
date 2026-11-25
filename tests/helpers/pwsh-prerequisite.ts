/*
 * Optional-prerequisite probe for the native PowerShell 7 (pwsh.exe) coverage
 * (#406, #405). Two ShellStart cases in background-shell-windows.test.ts
 * exercise pwsh-specific behavior; they run only when production would really
 * launch PowerShell 7. A verified absence skips them with a truthful reason,
 * while a failed, timed-out, or malformed lookup fails with diagnostics
 * instead of masquerading as absence.
 *
 * The probe mirrors production discovery (findWindowsPowerShell) in the two
 * ways that decide this prerequisite: the default `where pwsh.exe` runner
 * applies the same single retry when the lookup times out, using the same
 * exported bounds as production, and a `where` miss is followed by the same
 * `%ProgramFiles%\PowerShell\7\pwsh.exe` install-location check with the same
 * existence rule — production would launch that executable too. Everything
 * is injectable so every outcome is unit-testable on any platform without
 * spawning `where`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";
import { WINDOWS_WHERE_RETRY_TIMEOUT_MS, WINDOWS_WHERE_TIMEOUT_MS } from "../../src/background-shell/shell";

/** One observed `where pwsh.exe` invocation, shaped as the production lookup
 *  (findWindowsExecutable) observes it. */
export interface PwshWhereProbe {
  /** Spawn-level failure or timeout; undefined when the process ran to exit. */
  error?: NodeJS.ErrnoException;
  status: number | null;
  stdout: string;
}

/** The optional-prerequisite outcome for pwsh.exe coverage. */
export type PwshPrerequisite =
  | { kind: "present"; path: string }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

/** Injectable lookup runner; the default runs the real `where pwsh.exe` with
 *  production's timeout bounds, including its single timeout retry. */
export type PwshWhereRunner = () => PwshWhereProbe;

/** Injectable dependencies for the install-location fallback and the
 *  require-PowerShell-7 decision; each defaults to production behavior. */
export interface PwshPrerequisiteDeps {
  /** Existence rule (production's accessSync F_OK check). */
  pathExists?: (path: string) => boolean;
  /** Environment record (process.env). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Production's existence rule: `accessSync(path, F_OK)`, false on any throw —
 *  deliberately not `existsSync()`, whose extra stat check rejects runnable
 *  Microsoft Store app-execution aliases (nodejs/node#36790). */
function windowsPathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** One bounded `where pwsh.exe` lookup under `timeoutMs`. */
function spawnWherePwsh(timeoutMs: number): PwshWhereProbe {
  const result = spawnSync("where", ["pwsh.exe"], { encoding: "utf-8", timeout: timeoutMs, windowsHide: true });
  return {
    error: result.error as NodeJS.ErrnoException | undefined,
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

/**
 * Production's retry policy for one `where pwsh.exe` lookup (#405): a lookup
 * that timed out (`ETIMEDOUT`) is retried exactly once with the longer bound;
 * every other outcome — including a second timeout — is returned as observed.
 * Extracted so the retry itself is unit-testable with an injected spawn.
 */
export function runPwshWhereWithRetry(spawnWhere: (timeoutMs: number) => PwshWhereProbe): PwshWhereProbe {
  const first = spawnWhere(WINDOWS_WHERE_TIMEOUT_MS);
  if (first.error?.code !== "ETIMEDOUT") return first;
  return spawnWhere(WINDOWS_WHERE_RETRY_TIMEOUT_MS);
}

const defaultPwshWhereRunner: PwshWhereRunner = () => runPwshWhereWithRetry(spawnWherePwsh);

/**
 * Classify one `where pwsh.exe` observation:
 * - exit 0 whose first reported path exists and is named pwsh.exe => present;
 * - exit 1 (where's not-found code) reporting no paths => verified absent;
 * - spawn failure/timeout, missing exit status, or any other or malformed
 *   output => error (a diagnostic failure, never a skip).
 */
export function classifyPwshLookup(
  probe: PwshWhereProbe,
  exists: (path: string) => boolean = windowsPathExists,
): PwshPrerequisite {
  if (probe.error) {
    const detail =
      (probe.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? "timed out"
        : `failed to run: ${probe.error.message}`;
    return { kind: "error", reason: `where pwsh.exe ${detail}` };
  }
  if (probe.status === null) {
    return { kind: "error", reason: "where pwsh.exe did not exit normally" };
  }
  const lines = probe.stdout.trim().split(/\r?\n/).filter((line) => line.trim() !== "");
  if (probe.status === 0) {
    const first = lines[0];
    if (!first) return { kind: "error", reason: "where pwsh.exe exited 0 but reported no path" };
    // Final-segment check across both separator styles: `where` reports
    // Windows paths, and this classifier must classify them identically on
    // every platform the focused tests run on.
    const finalSegment = first.split(/[\\/]/).pop()?.toLowerCase();
    if (finalSegment !== "pwsh.exe") {
      return { kind: "error", reason: `where pwsh.exe reported a non-pwsh.exe path: ${first}` };
    }
    if (!exists(first)) {
      return { kind: "error", reason: `where pwsh.exe reported a path that does not exist: ${first}` };
    }
    return { kind: "present", path: first };
  }
  if (probe.status === 1) {
    if (lines.length > 0) {
      return { kind: "error", reason: `where pwsh.exe exited 1 but reported paths: ${lines.join(", ")}` };
    }
    return { kind: "absent" };
  }
  return { kind: "error", reason: `where pwsh.exe exited with unexpected status ${probe.status}` };
}

/** The PowerShell 7 install location production checks after `where pwsh.exe`
 *  fails, or null when `%ProgramFiles%` is unset. */
export function pwsh7ProgramFilesPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const programFiles = env.ProgramFiles;
  if (!programFiles) return null;
  return win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
}

/**
 * Probe the optional pwsh prerequisite: the `where pwsh.exe` observation
 * first, then — when it does not prove presence — the same PowerShell 7
 * install-location fallback production discovery would use. Only a `where`
 * observation that is itself an error is reported as an error.
 */
export function probePwshPrerequisite(
  runner: PwshWhereRunner = defaultPwshWhereRunner,
  deps: PwshPrerequisiteDeps = {},
): PwshPrerequisite {
  const exists = deps.pathExists ?? windowsPathExists;
  const lookup = classifyPwshLookup(runner(), exists);
  if (lookup.kind === "present") return lookup;
  const fallback = pwsh7ProgramFilesPath(deps.env ?? process.env);
  if (fallback !== null && exists(fallback)) return { kind: "present", path: fallback };
  return lookup;
}

/** How a pwsh-specific test records its skip (node:test's `t.skip`). */
export type PwshSkip = (message?: string) => void;

/**
 * Turn one prerequisite outcome into the pwsh-specific test's decision
 * (#405, #406):
 * - `present` => continue (returns true);
 * - `error` => always fail with the lookup diagnostics;
 * - `absent` => fail when `PI_REVIEW_GATE_REQUIRE_PWSH` is exactly "1" (the
 *   Windows shell CI job's runner image provides PowerShell 7, so its absence
 *   there is a failure rather than a silent loss of coverage), otherwise take
 *   the optional skip through `skip` and return false.
 */
export function resolvePwshPrerequisite(
  prereq: PwshPrerequisite,
  skip: PwshSkip,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (prereq.kind === "error") throw new Error(`pwsh prerequisite lookup failed: ${prereq.reason}`);
  if (prereq.kind === "present") return true;
  if (env.PI_REVIEW_GATE_REQUIRE_PWSH === "1") {
    throw new Error(
      "PowerShell 7 (pwsh.exe) is required on this CI job (PI_REVIEW_GATE_REQUIRE_PWSH=1): the Windows " +
        "runner image provides it, so its absence is a prerequisite failure, not a skip. Neither " +
        "`where pwsh.exe` nor the %ProgramFiles%\\PowerShell\\7\\pwsh.exe install location resolved it.",
    );
  }
  skip("PowerShell 7 (pwsh.exe) is not on PATH; optional prerequisite for pwsh-specific coverage");
  return false;
}
