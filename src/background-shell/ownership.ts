/*
 * Windows descendant ownership for background shell jobs (#99 follow-up).
 *
 * Windows has no process groups: once the PowerShell shell root exits, a tree
 * walk rooted at its pid can no longer reach descendants that were launched
 * detached (for example through Start-Process with redirected output) and
 * outlived the shell — and after the root exits that pid may even be reused by
 * an unrelated process, so pid-based kills are off the table entirely. The
 * production wrapper therefore hands every job's process tree to a Windows job
 * object (JOB_OBJECT_LIMIT_DIE_ON_CLOSE: the kernel terminates every member
 * when the last handle closes) before the user command runs, and a per-job
 * watchdog process holds the only handle to that job for as long as owned
 * processes remain — including after the shell root has exited. Cleanup always
 * goes through the job handle (TerminateJobObject) or the stop file the
 * watchdog reads; never through a pid.
 *
 * This module owns the small file-based contract between the three parties
 * that must agree on the same paths: the wrapper/watchdog (PowerShell), this
 * extension (Node, in the Pi host), and the review-gate harness
 * (BackgroundProcessReadiness, which reads the marker path out of the
 * structured ShellStart result).
 *
 * Verdict discipline (fail closed): "running" requires positive evidence —
 * either the shell root is alive or the record names a live watchdog that holds
 * the job. A terminal record state, or a dead watchdog pid in a `running`
 * record, is VERIFIED completion: with kill-on-close set and the watchdog as
 * sole handle holder, the kernel kills every member the moment the watchdog
 * process dies, so a dead watchdog cannot leave owned work behind. A missing or
 * unparseable record after the root has exited is NOT completion — it is
 * unverifiable and must keep readiness blocked (a paused or killed watchdog
 * with live descendants, clock skew, or an unreadable file must never look
 * like "done"). The token makes every path unique per job, so concurrent jobs,
 * stale files from crashed sessions, and pid reuse can never be confused.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Per-job ownership identity. All paths derive from one random token so every
 *  consumer (wrapper, extension, harness) agrees without IPC. */
export interface BackgroundJobOwnership {
  /** Random 16-hex-char job token; never reused, never derivable by a job. */
  token: string;
  /** The ownership record file the watchdog maintains (`<pid> <state>`). */
  markerPath: string;
  /** Written by the extension to request a forced tree kill (ShellStop,
   *  shutdown); read by the watchdog on its next poll. */
  stopPath: string;
}

/** The states the ownership record can carry. `running` is live-held ownership;
 *  `released` is the watchdog's verified-empty acknowledgement and `failed`
 *  the wrapper's "nothing ran" record; `terminated` is parsed defensively but
 *  no longer written by production code (stop/parent-death paths terminate the
 *  job and let the watchdog's own death prove completion via kill-on-close). */
export type OwnershipState = "running" | "released" | "terminated" | "failed";

export interface OwnershipRecord {
  /** The watchdog's pid (0 in the wrapper-written `failed` record, where no
   *  watchdog exists). */
  pid: number;
  state: OwnershipState;
}

/** Create a fresh per-job ownership identity. `tmpdir()` is %TEMP% on Windows,
 *  the same directory both PowerShell and Node resolve, so all parties agree
 *  on the location without passing paths through the command line. */
export function createBackgroundJobOwnership(): BackgroundJobOwnership {
  const token = randomBytes(8).toString("hex");
  return {
    token,
    markerPath: join(tmpdir(), `pi-review-bg-${token}.job`),
    stopPath: join(tmpdir(), `pi-review-bg-${token}.stop`),
  };
}

/**
 * Parse the ownership record. Returns undefined for a missing, unreadable, or
 * malformed file — callers must treat that as ABSENT EVIDENCE, never as
 * completion. The mtime heartbeat is deliberately not part of the verdict: a
 * delayed (but alive) watchdog must keep its job accounted for, and a fresh
 * file written by anything other than the owning watchdog proves nothing.
 */
export function readOwnershipRecord(markerPath: string): OwnershipRecord | undefined {
  try {
    const text = readFileSync(markerPath, "utf8").trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) return undefined;
    const pid = Number(parts[0]);
    const state = parts[1];
    if (!Number.isSafeInteger(pid) || pid < 0) return undefined;
    if (state !== "running" && state !== "released" && state !== "terminated" && state !== "failed") {
      return undefined;
    }
    // A `running` record must name the live watchdog; only the wrapper-written
    // failure record (and terminal states) may carry pid 0.
    if (state === "running" && pid <= 0) return undefined;
    return { pid, state };
  } catch {
    return undefined;
  }
}

/** The three states readiness can reach for a tracked Windows job. */
export type OwnershipVerdict = "running" | "clear" | "unverifiable";

/**
 * Decide whether a root-exited-or-running Windows job still owns live work.
 *
 * - Root alive: running. This also covers the startup window before the first
 *   record exists, and any later loss of the record while the shell lives.
 * - Root dead + terminal record (`released` / `terminated` / `failed`):
 *   verified clear — ownership confirmed no remaining processes (job empty),
 *   or proves the command never ran.
 * - Root dead + `running` record: running while the named watchdog is alive;
 *   a dead watchdog pid is verified clear because kill-on-close makes the
 *   kernel kill every member when the watchdog's (sole) handle closes.
 * - Root dead + no readable record: UNVERIFIABLE. Missing evidence after the
 *   root exited is never completion; it blocks readiness until something
 *   verifies the tree gone.
 */
export function ownershipVerdict(
  markerPath: string,
  rootAlive: boolean,
  isAlive: (pid: number) => boolean,
): OwnershipVerdict {
  if (rootAlive) return "running";
  const record = readOwnershipRecord(markerPath);
  if (!record) return "unverifiable";
  if (record.state !== "running") return "clear";
  return isAlive(record.pid) ? "running" : "clear";
}

/**
 * Request the job's watchdog to terminate its whole process tree. Best-effort
 * and synchronous (also safe from a process `exit` hook): this is the ONLY
 * cleanup request the extension makes on Windows — it never targets a pid, so
 * a reused root pid can never identify an unrelated process. The watchdog
 * acts on the stop file within one poll; its parent-death check remains the
 * backstop if the host dies before it does.
 */
export function requestWindowsOwnershipStop(ownership: BackgroundJobOwnership | undefined): void {
  if (!ownership) return;
  try {
    writeFileSync(ownership.stopPath, "stop\n");
  } catch {
    /* the watchdog's parent-death check remains the backstop */
  }
}
