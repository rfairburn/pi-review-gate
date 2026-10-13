/*
 * Optional-prerequisite probe for the native PowerShell 7 (pwsh.exe) coverage
 * (#406). Two ShellStart cases in background-shell-windows.test.ts exercise
 * pwsh-specific behavior; they run only when pwsh.exe is genuinely on PATH.
 * A verified absence skips them with a truthful reason, while a failed,
 * timed-out, or malformed lookup fails with diagnostics instead of
 * masquerading as absence. Production discovery (findWindowsExecutable) is
 * unchanged: this probe only decides whether the optional prerequisite is met,
 * and its 5 s bound mirrors the production lookup.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** One observed `where pwsh.exe` invocation, shaped as the production lookup
 *  (findWindowsExecutable) observes it. */
export interface PwshWhereProbe {
  /** Spawn-level failure or timeout; undefined when the process ran to exit. */
  error?: Error;
  status: number | null;
  stdout: string;
}

/** The optional-prerequisite outcome for pwsh.exe coverage. */
export type PwshPrerequisite =
  | { kind: "present"; path: string }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

/** Injectable lookup runner; the default runs the real `where pwsh.exe` with
 *  the same 5 s bound as production discovery. */
export type PwshWhereRunner = () => PwshWhereProbe;

const defaultPwshWhereRunner: PwshWhereRunner = () => {
  const result = spawnSync("where", ["pwsh.exe"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  return { error: result.error ?? undefined, status: result.status, stdout: result.stdout ?? "" };
};

/**
 * Classify one `where pwsh.exe` observation:
 * - exit 0 whose first reported path exists and is named pwsh.exe => present;
 * - exit 1 (where's not-found code) reporting no paths => verified absent;
 * - spawn failure/timeout, missing exit status, or any other or malformed
 *   output => error (a diagnostic failure, never a skip).
 */
export function classifyPwshLookup(
  probe: PwshWhereProbe,
  exists: (path: string) => boolean = existsSync,
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

/** Probe the optional pwsh prerequisite, with an injectable lookup runner. */
export function probePwshPrerequisite(runner: PwshWhereRunner = defaultPwshWhereRunner): PwshPrerequisite {
  return classifyPwshLookup(runner());
}
