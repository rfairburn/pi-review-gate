/**
 * #292: one informational startup notice for a positively non-Git workspace.
 *
 * Evidence capture works best in a Git worktree, and the gate's Git and non-Git
 * capture paths stay exactly as they are. This module only classifies the LIVE
 * session cwd for a single user-only warning: one bounded read-only Git
 * discovery probe plus an ancestor marker check. It never invokes capture,
 * never enumerates or snapshots the workspace, never writes anything, and never
 * creates a repository or steers the user toward Git.
 */

import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import { gitCheckpointDiscoveryEnv } from "../checkpoint/run-git";
import { sendLocalWarning } from "../pi";

/** Exact user-visible text for #292. Deliberately broad: it names no specific
 *  accuracy or performance failure and never presents non-Git capture as
 *  unsupported. Do not reword it. */
export const NON_GIT_WORKSPACE_WARNING
  = "Warning: Evidence capture works best in a Git worktree. Capture may be degraded in this workspace.";

/** Only `non-git` is actionable. `unknown` — missing or unrunnable Git,
 *  malformed or inaccessible metadata, an unresolvable path, an exhausted
 *  settlement budget, or an ambient repository redirect — is never reported as
 *  a non-Git workspace. */
export type WorkspaceGitKind = "git" | "non-git" | "unknown";

/** Settlement deadline for one whole classification — path resolution, the
 *  child probe, and the ancestor marker walk together. `execFile`'s own timeout
 *  only signals the child and then waits for it, so a wrapper that ignores the
 *  signal could hold startup indefinitely; this budget kills the owned child
 *  and resolves indeterminate instead, and any later settlement is ignored. */
const CLASSIFICATION_BUDGET_MS = 2_000;
/** First-stage gentle termination of the owned child, inside the overall budget. */
const CHILD_TERM_MS = 1_500;

export interface WorkspaceGitProbeSeams {
  /** Marker-read seam for focused stalled-filesystem coverage; production uses
   *  a plain `lstat`. */
  statMarker?: (path: string) => Promise<unknown>;
}

export interface NonGitWorkspaceNoticeOptions {
  /** The live session cwd for this `session_start`, never a cached root. */
  cwd: string;
  /** Notice target: the event context when present, else the API object. */
  target: unknown;
  /** False once the asking session has retired (shutdown, switch, or a newer
   *  `session_start` in the same process). */
  isCurrent: () => boolean;
  /** Test seam for the classification step; production uses the real probe. */
  probe?: (cwd: string) => Promise<WorkspaceGitKind>;
}

/**
 * Deliver the warning once per top-level `session_start`, and only for
 * a positively non-Git workspace. Every failure path stays silent: neither the
 * probe nor the notice can block startup, and a session that retires while the
 * probe is in flight receives no stale notice.
 */
export async function sendNonGitWorkspaceWarning(options: NonGitWorkspaceNoticeOptions): Promise<void> {
  try {
    if (!options.isCurrent()) return;
    const kind = await (options.probe ?? probeWorkspaceGitKind)(options.cwd);
    // The classification awaited: recheck retirement before any delivery.
    if (!options.isCurrent() || kind !== "non-git") return;
    await sendLocalWarning(options.target, NON_GIT_WORKSPACE_WARNING);
  } catch {
    // Informational only: a failed probe or a throwing notice transport never
    // reaches the caller and never changes what the session does next.
  }
}

/** Classify one workspace with a single bounded read-only Git discovery probe. */
export async function probeWorkspaceGitKind(
  cwd: string,
  seams: WorkspaceGitProbeSeams = {},
): Promise<WorkspaceGitKind> {
  // An ambient repository/worktree redirect makes Git answer about the
  // redirected repository rather than this cwd: indeterminate, never a verdict.
  if (process.env.GIT_DIR !== undefined || process.env.GIT_WORK_TREE !== undefined) return "unknown";
  const deadline = startClassificationDeadline();
  const classification = classifyWorkspace(cwd, deadline, seams);
  // Nothing may settle unhandled after the budget is abandoned — including the
  // rejection from the child this deadline kills.
  classification.catch(() => undefined);
  try {
    return await Promise.race([classification, deadline.expired]);
  } catch {
    // Missing or unrunnable Git, a missing or unresolvable cwd, or any other
    // spawn failure: the absence of an answer is never evidence of a non-Git tree.
    return "unknown";
  } finally {
    deadline.settle();
  }
}

async function classifyWorkspace(
  cwd: string,
  deadline: ClassificationDeadline,
  seams: WorkspaceGitProbeSeams,
): Promise<WorkspaceGitKind> {
  // Git discovers ancestors from the PHYSICAL directory, so a symlinked alias
  // into a repository must be resolved the same way or a real `.git` above the
  // target is missed. A failed resolution is indeterminate.
  const physical = await realpath(cwd);
  if (deadline.fired()) return "unknown";
  const probe = await runDiscoveryProbe(physical, deadline);
  if (deadline.fired()) return "unknown";
  if (probe.code === 0) {
    // "true" covers a Git root, any subdirectory of one, a linked worktree, and
    // a repository with an unborn HEAD. Any other success shape is not a verdict.
    return probe.stdout.trim() === "true" ? "git" : "unknown";
  }
  // Only Git's own explicit verdict counts, and only when no Git marker exists
  // in the workspace's ancestors: malformed or unreadable metadata reports the
  // same words as a genuinely non-Git directory.
  if (!probe.stderr.includes("not a git repository")) return "unknown";
  return (await hasWorkspaceGitMarker(physical, deadline, seams)) ? "unknown" : "non-git";
}

function runDiscoveryProbe(cwd: string, deadline: ClassificationDeadline): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveProbe, rejectProbe) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      settle();
    };
    const child = execFile(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd,
        // The same isolated discovery environment capture uses: no ambient Git
        // configuration, no inherited repository/worktree redirect, no prompting.
        env: gitCheckpointDiscoveryEnv(),
        timeout: CHILD_TERM_MS,
        maxBuffer: 8 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        finish(() => {
          if (!error) {
            resolveProbe({ code: 0, stdout, stderr });
            return;
          }
          const code = (error as { code?: unknown }).code;
          // A numeric exit code is Git's own answer. ENOENT, a kill, or any
          // other non-exit failure means Git answered nothing at all.
          if (typeof code === "number") resolveProbe({ code, stdout, stderr });
          else rejectProbe(error);
        });
      },
    );
    // The budget owns termination: a child that ignores the gentle signal is
    // killed, and startup is released without waiting for its callback.
    deadline.onAbort(() => {
      finish(() => rejectProbe(new Error("review gate: workspace Git discovery budget exhausted")));
      try {
        child.kill("SIGKILL");
      } catch {
        // The owned child is already gone.
      }
    });
    child.on("error", () => {
      finish(() => rejectProbe(new Error("review gate: workspace Git discovery unavailable")));
    });
  });
}

/** Ancestor-only marker check: path depth, never directory enumeration. */
async function hasWorkspaceGitMarker(
  cwd: string,
  deadline: ClassificationDeadline,
  seams: WorkspaceGitProbeSeams,
): Promise<boolean> {
  const statMarker = seams.statMarker ?? ((path: string) => lstat(path).then(() => undefined));
  const ceilings = new Set(
    (process.env.GIT_CEILING_DIRECTORIES ?? "")
      .split(delimiter)
      .filter((part) => part !== "")
      .map((part) => resolve(part)),
  );
  let dir = cwd;
  for (;;) {
    // The budget covers the filesystem calls too: an abandoned walk is never a
    // non-Git verdict.
    if (deadline.fired()) return true;
    try {
      await statMarker(join(dir, ".git"));
      return true;
    } catch (error) {
      // An unreadable ancestor cannot prove that no Git metadata exists.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(dir);
    if (parent === dir || ceilings.has(parent)) return false;
    dir = parent;
  }
}

interface ClassificationDeadline {
  /** Resolves `unknown` once the budget is exhausted. */
  readonly expired: Promise<WorkspaceGitKind>;
  /** True once the budget is exhausted; late work must be abandoned. */
  fired(): boolean;
  /** Register the owned-child killer; runs at once if already expired. */
  onAbort(kill: () => void): void;
  /** Clear the timer once classification settled normally. */
  settle(): void;
}

function startClassificationDeadline(): ClassificationDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kill: (() => void) | undefined;
  let isFired = false;
  let resolveExpired: (kind: WorkspaceGitKind) => void = () => undefined;
  const expired = new Promise<WorkspaceGitKind>((resolveBudget) => {
    resolveExpired = resolveBudget;
  });
  const fire = (): void => {
    if (isFired) return;
    isFired = true;
    timer = undefined;
    try {
      kill?.();
    } catch {
      // The owned child is already gone.
    }
    resolveExpired("unknown");
  };
  timer = setTimeout(fire, CLASSIFICATION_BUDGET_MS);
  timer.unref?.();
  const runKill = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Termination is best effort; the classification is already abandoned.
    }
  };
  return {
    expired,
    fired: () => isFired,
    onAbort: (fn) => {
      if (isFired) runKill(fn);
      else kill = fn;
    },
    settle: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
