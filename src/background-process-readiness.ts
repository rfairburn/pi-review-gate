import { ownershipVerdict } from "./background-shell/ownership";

export interface TrackedBackgroundProcess {
  id: string;
  label: string;
  pid: number;
  processGroupId: number;
  /** Windows only: the job-object ownership record path (from ShellStart
   *  details). Present when the extension that started the job uses the
   *  job-object watchdog; its verdict then bounds the job, not the root pid. */
  ownershipMarker?: string;
}

export interface BackgroundReadinessSnapshot {
  revision: number;
  running: TrackedBackgroundProcess[];
  unverifiable: string[];
}

const SHELL_START_RESULT = /Started\s+"([^"]*)"\s+as\s+(\S+)\s+\(pid\s+(\d+)\)(?:[.;]|(?=\s|$))/i;

/**
 * Best-effort readiness tracking for the ShellStart tool contract. On
 * macOS/Linux the detached child pid is also its process-group id, so group
 * liveness remains authoritative even when the shell leader exits before a
 * descendant.
 *
 * Windows has no process groups, so the extension instead hands each job's
 * whole tree to a Windows job object (KILL_ON_JOB_CLOSE) held by a per-job
 * watchdog that outlives the shell root and records its state in a marker file
 * whose path travels in the ShellStart details (`ownershipMarker`). The verdict
 * is liveness-based, not freshness-based: while the root is alive the job runs;
 * after the root exits, a `running` record naming a live watchdog keeps it
 * running, a terminal record (`released`/`terminated`/`failed`) or a dead
 * watchdog pid verifies it clear (KILL_ON_JOB_CLOSE makes the kernel kill every
 * member when the watchdog's sole handle closes), and a missing or unreadable
 * record is UNVERIFIABLE — it keeps readiness blocked rather than claiming
 * completion from absent evidence.
 *
 * Honest bounds: results that carry no ownership marker (older extension,
 * text-only fallback) degrade to root-pid liveness on Windows, which cannot see
 * descendants that outlive the shell; and a `running` record can over-report by
 * at most one watchdog poll after its last refresh.
 */
export class BackgroundProcessReadiness {
  private readonly processes = new Map<number, TrackedBackgroundProcess>();
  private readonly unverifiable = new Set<string>();
  private revision = 0;

  observeToolResult(toolName: string, result: unknown, isError = false): TrackedBackgroundProcess | undefined {
    if (toolName !== "ShellStart" || isError) return undefined;
    const structured = structuredShellStart(result);
    if (structured) {
      this.processes.set(structured.processGroupId, structured);
      this.revision += 1;
      return structured;
    }
    const text = textFromToolResult(result);
    if (!/\bStarted\b/i.test(text)) return undefined;
    const match = text.match(SHELL_START_RESULT);
    if (!match) {
      this.unverifiable.add(singleLine(text).slice(0, 500) || "ShellStart returned an unparseable success result.");
      this.revision += 1;
      return undefined;
    }
    const pid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      this.unverifiable.add(singleLine(text).slice(0, 500));
      this.revision += 1;
      return undefined;
    }
    const tracked = {
      id: match[2],
      label: match[1] || match[2],
      pid,
      processGroupId: pid,
    };
    this.processes.set(tracked.processGroupId, tracked);
    this.revision += 1;
    return tracked;
  }

  snapshot(): BackgroundReadinessSnapshot {
    for (const [processGroupId, tracked] of this.processes) {
      let alive: boolean;
      if (process.platform === "win32" && tracked.ownershipMarker) {
        // Job-object ownership bounds the job, not the root pid: keep a
        // root-exited job accounted for until its record verifies completion,
        // and treat missing evidence as blocking (it stays in `running` —
        // fail closed), never as clear.
        alive = ownershipVerdict(tracked.ownershipMarker, processIsAlive(tracked.pid), processIsAlive) !== "clear";
      } else {
        alive = process.platform === "win32"
          ? processIsAlive(tracked.pid)
          : processGroupIsAlive(processGroupId);
      }
      if (!alive) {
        this.processes.delete(processGroupId);
        this.revision += 1;
      }
    }
    return {
      revision: this.revision,
      running: [...this.processes.values()],
      unverifiable: [...this.unverifiable],
    };
  }

  clear(): void {
    if (this.processes.size > 0 || this.unverifiable.size > 0) this.revision += 1;
    this.processes.clear();
    this.unverifiable.clear();
  }
}

function structuredShellStart(value: unknown): TrackedBackgroundProcess | undefined {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): TrackedBackgroundProcess | undefined => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const found = visit(entry);
        if (found) return found;
      }
      return undefined;
    }
    const record = candidate as Record<string, unknown>;
    if (record.kind === "pi-review-bg-shell" && record.event === "started") {
      const id = typeof record.id === "string" ? record.id : undefined;
      const label = typeof record.label === "string" ? record.label : undefined;
      const pid = typeof record.pid === "number" ? record.pid : undefined;
      // Windows details carry no process group; the root pid stands in for it.
      const processGroupId = typeof record.processGroupId === "number" ? record.processGroupId : pid;
      const ownershipMarker = typeof record.ownershipMarker === "string" ? record.ownershipMarker : undefined;
      if (id && label && positiveSafeInteger(pid) && positiveSafeInteger(processGroupId)) {
        return { id, label, pid, processGroupId, ...(ownershipMarker ? { ownershipMarker } : {}) };
      }
      return undefined;
    }
    for (const key of ["result", "details", "content"]) {
      const found = visit(record[key]);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function textFromToolResult(value: unknown): string {
  const seen = new Set<unknown>();
  const texts: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      texts.push(candidate);
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.text === "string") texts.push(record.text);
    for (const key of ["result", "content", "message", "output"]) {
      if (record[key] !== undefined) visit(record[key]);
    }
  };
  visit(value);
  return texts.join("\n");
}

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/** Single-process liveness (Windows: no process groups to query). EPERM means
 *  the process exists but is not ours to signal — alive, not dead. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
