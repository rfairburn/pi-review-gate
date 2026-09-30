import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  compareSnapshots,
  createWorkspaceSnapshot,
  type ChangedFile,
  type FileSnapshot,
  type WorkspaceSnapshot,
} from "../../capture";
import type { ReviewGateConfig } from "../../config";

// ── launch-time baseline and attribution ─────────────────────────────────────

/**
 * The durable attribution basis captured at dispatch time. `git` mode records
 * the observed HEAD; `non_git` mode declares that no repository anchor exists.
 * The content snapshot is the only cross-mode change basis. Everything here is
 * observed state at launch — never reconstructed later.
 */
export interface InPlaceBaseline {
  workspaceRoot: string;
  mode: "git" | "non_git";
  capturedAt: string;
  /** Git only: HEAD commit observed at launch (undefined for an unborn HEAD). */
  gitHead?: string;
  /** Git only: repository top level, which may contain the workspace root as a subdirectory. */
  gitRepositoryRoot?: string;
  snapshot: WorkspaceSnapshot;
}

async function inPlaceGit(root: string, args: string[]): Promise<string | undefined> {
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.toString().trim();
  } catch {
    return undefined;
  }
}

/**
 * Capture the launch-time attribution basis for an in-place task: whether the
 * workspace root sits inside a Git repository (HEAD and top level observed),
 * plus a bounded content snapshot. Snapshot omissions are retained on the
 * snapshot and disclosed wherever its comparisons are surfaced.
 */
export async function createInPlaceBaseline(
  workspaceRoot: string,
  config: ReviewGateConfig,
  signal?: AbortSignal,
): Promise<InPlaceBaseline> {
  const root = resolve(workspaceRoot);
  const gitTop = await inPlaceGit(root, ["rev-parse", "--show-toplevel"]);
  const snapshot = await createWorkspaceSnapshot(root, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    signal,
  });
  if (gitTop === undefined) {
    return { workspaceRoot: root, mode: "non_git", capturedAt: new Date().toISOString(), snapshot };
  }
  const head = await inPlaceGit(root, ["rev-parse", "HEAD"]);
  return {
    workspaceRoot: root,
    mode: "git",
    capturedAt: new Date().toISOString(),
    ...(head !== undefined && head !== "" ? { gitHead: head } : {}),
    gitRepositoryRoot: gitTop,
    snapshot,
  };
}

export interface InPlaceAttribution {
  baseline: InPlaceBaseline;
  /** Content delta between the launch snapshot and the current workspace. */
  changes: ChangedFile[];
  /** Git only: true when HEAD moved after launch (for example the worker created a commit). */
  gitHeadMoved?: boolean;
  gitCurrentHead?: string;
  snapshotAfter: WorkspaceSnapshot;
}

/**
 * Compute the current workspace delta against the launch baseline. The delta
 * records what changed since launch — never proof of who changed it: a
 * concurrent writer's changes appear here exactly like the worker's own.
 */
export async function computeInPlaceAttribution(
  baseline: InPlaceBaseline,
  config: ReviewGateConfig,
  signal?: AbortSignal,
): Promise<InPlaceAttribution> {
  const snapshotAfter = await createWorkspaceSnapshot(baseline.workspaceRoot, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    reuseUnchangedFrom: baseline.snapshot,
    signal,
  });
  const changes = compareSnapshots(baseline.snapshot, snapshotAfter);
  if (baseline.mode !== "git" || baseline.gitHead === undefined) {
    return { baseline, changes, snapshotAfter };
  }
  const currentHead = await inPlaceGit(baseline.workspaceRoot, ["rev-parse", "HEAD"]);
  return {
    baseline,
    changes,
    gitHeadMoved: currentHead !== baseline.gitHead,
    gitCurrentHead: currentHead ?? undefined,
    snapshotAfter,
  };
}

/**
 * Content-anchored identity of one snapshot entry. Mirrors the captured
 * snapshot's own equivalence fields (hash, entry type, mode, link target,
 * Git object id, and the omission class when content was not retained) so a
 * later turn that changes an already-changed path's CONTENT always produces a
 * different identity, and a byte-identical workspace never does.
 */
function snapshotEntryId(entry: FileSnapshot | undefined): string {
  if (!entry || entry.exists === false) return "absent";
  return [
    entry.sha256 ?? "nohash",
    entry.entryType ?? "file",
    entry.mode ?? "-",
    entry.gitObjectId ?? "-",
    entry.linkTarget ? createHash("sha256").update(entry.linkTarget).digest("hex").slice(0, 16) : "-",
    entry.omittedReason ?? "-",
    entry.isBinary ? "binary" : "text",
  ].join("/");
}

/**
 * Content-anchored identity of a recorded workspace delta: per changed path,
 * both the launch-state and current-state content identities. Status and path
 * alone are NOT sufficient identity: a correction that rewrites a
 * already-changed file must be observable, and a pass confirmation that
 * changes what was reviewed must never settle the task as reviewed.
 */
export function inPlaceDeltaIdentity(attribution: InPlaceAttribution): string {
  const identity = attribution.changes.map((change) => {
    const beforeId = snapshotEntryId(attribution.baseline.snapshot.files.get(change.path));
    const afterId = snapshotEntryId(attribution.snapshotAfter.files.get(change.path));
    return `${change.status}:${change.path}:${beforeId}=>${afterId}`;
  }).sort();
  return identity.join("|");
}
