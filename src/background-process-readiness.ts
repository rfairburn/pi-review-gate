export interface TrackedBackgroundProcess {
  id: string;
  label: string;
  pid: number;
  processGroupId: number;
}

export interface BackgroundReadinessSnapshot {
  running: TrackedBackgroundProcess[];
  unverifiable: string[];
}

const SHELL_START_RESULT = /Started\s+"([^"]*)"\s+as\s+(\S+)\s+\(pid\s+(\d+)\)\./i;

/**
 * Best-effort readiness tracking for Little Coder's ShellStart tool. The
 * detached child pid is also its process-group id, so group liveness remains
 * authoritative even when the shell leader exits before a descendant.
 */
export class BackgroundProcessReadiness {
  private readonly processes = new Map<number, TrackedBackgroundProcess>();
  private readonly unverifiable = new Set<string>();

  observeToolResult(toolName: string, result: unknown, isError = false): TrackedBackgroundProcess | undefined {
    if (toolName !== "ShellStart" || isError) return undefined;
    const text = textFromToolResult(result);
    if (!/\bStarted\b/i.test(text)) return undefined;
    const match = text.match(SHELL_START_RESULT);
    if (!match) {
      this.unverifiable.add(singleLine(text).slice(0, 500) || "ShellStart returned an unparseable success result.");
      return undefined;
    }
    const pid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32") {
      this.unverifiable.add(singleLine(text).slice(0, 500));
      return undefined;
    }
    const tracked = {
      id: match[2],
      label: match[1] || match[2],
      pid,
      processGroupId: pid,
    };
    this.processes.set(pid, tracked);
    return tracked;
  }

  snapshot(): BackgroundReadinessSnapshot {
    for (const [processGroupId] of this.processes) {
      if (!processGroupIsAlive(processGroupId)) this.processes.delete(processGroupId);
    }
    return {
      running: [...this.processes.values()],
      unverifiable: [...this.unverifiable],
    };
  }

  clear(): void {
    this.processes.clear();
    this.unverifiable.clear();
  }
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

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
