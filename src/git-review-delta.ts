import { BINARY_SAMPLE_BYTES, looksBinary, type ChangedFile, type ChangedFileStatus } from "./capture";
import { buildUnifiedPatch, type PatchBuildResult } from "./diff";
import type {
  GitCheckpointComparisonReport,
  GitCheckpointTrackedChange,
  GitCheckpointUntrackedChange,
  GitCheckpointUntrackedState,
} from "./git-checkpoint";

export interface GitReviewLimits {
  maxFileBytes: number;
  maxSnapshotBytes: number;
  maxPatchBytes: number;
}

export interface GitReviewDelta {
  changes: ChangedFile[];
  patch: PatchBuildResult;
}

/**
 * Review only changed entries from a verified Git checkpoint comparison. The
 * checkpoint record, not this bounded presentation, remains the recoverable
 * source of truth. In particular, no clean tracked content is materialized or
 * copied into the review window or its session sidecar.
 */
export function buildGitReviewDelta(report: GitCheckpointComparisonReport, limits: GitReviewLimits): GitReviewDelta {
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid Git review limit: ${name}`);
  }
  if (!Array.isArray(report.trackedChanges) || !Array.isArray(report.untrackedChanges)) {
    throw new Error("Git checkpoint comparison is missing changed-entry details");
  }
  const byPath = new Map<string, ReviewEntry>();
  for (const entry of [...report.trackedChanges.map(trackedReviewChange), ...report.untrackedChanges.map(untrackedReviewChange)]) {
    if (!entry.path) throw new Error("Git checkpoint comparison contains a missing changed path");
    const prior = byPath.get(entry.path);
    if (!prior) {
      byPath.set(entry.path, entry);
      continue;
    }
    // A path can legitimately transition from tracked to untracked (or the
    // reverse). Two old states or two new states at one path are inconsistent.
    if (prior.old && entry.old || prior.next && entry.next) {
      throw new Error("Git checkpoint comparison contains a duplicate changed path");
    }
    const old = prior.old ?? entry.old;
    const next = prior.next ?? entry.next;
    byPath.set(entry.path, {
      path: entry.path, old, next,
      status: old && next ? "modified" : old ? "deleted" : "added",
    });
  }
  const changed = [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  let retained = 0;
  const changes: ChangedFile[] = changed.map((entry) => {
    const old = reviewContent(entry.old, limits.maxFileBytes);
    const next = reviewContent(entry.next, limits.maxFileBytes);
    let reason = old.reason ?? next.reason;
    const required = (old.content === undefined ? 0 : Buffer.byteLength(old.content, "utf8"))
      + (next.content === undefined ? 0 : Buffer.byteLength(next.content, "utf8"));
    if (!reason && required > limits.maxSnapshotBytes - retained) reason = "snapshot_limit";
    if (!reason) retained += required;
    const change: ChangedFile = {
      path: entry.path,
      status: entry.status,
      binary: old.reason === "binary" || next.reason === "binary",
      oversized: old.reason === "oversized" || next.reason === "oversized",
      oldGitMode: entry.old?.mode,
      newGitMode: entry.next?.mode,
      oldTracking: entry.old?.tracking,
      newTracking: entry.next?.tracking,
    };
    if (reason) change.diffOmittedReason = reason;
    else {
      change.oldContent = old.content;
      change.newContent = next.content;
    }
    return change;
  });
  return { changes, patch: buildUnifiedPatch(changes, limits.maxPatchBytes) };
}

interface ReviewState {
  kind: "file" | "symlink";
  tracking: "tracked" | "untracked";
  mode: string;
  bytes?: Buffer;
  target?: string;
}

interface ReviewEntry {
  path: string;
  status: ChangedFileStatus;
  old?: ReviewState;
  next?: ReviewState;
}

function mode(kind: "file" | "symlink" | undefined, bits: number | undefined, path: string): string | undefined {
  if (!kind) return undefined;
  if (kind === "symlink") return "120000";
  if (!Number.isInteger(bits) || bits === undefined || bits < 0 || bits > 0o777) {
    throw new Error(`Git checkpoint comparison has invalid file mode for ${path}`);
  }
  return `100${bits.toString(8).padStart(3, "0")}`;
}

function trackedReviewChange(change: GitCheckpointTrackedChange): ReviewEntry {
  if (change.status !== "added" && change.status !== "modified" && change.status !== "deleted") {
    throw new Error("Git checkpoint comparison has invalid tracked status");
  }
  const oldMode = mode(change.oldKind, change.oldMode, change.path);
  const newMode = mode(change.newKind, change.newMode, change.path);
  if (change.status !== "added" && (!oldMode || !Buffer.isBuffer(change.oldBytes))) {
    throw new Error(`Git checkpoint comparison lacks old tracked content for ${change.path}`);
  }
  if (change.status !== "deleted" && (!newMode || !Buffer.isBuffer(change.newBytes))) {
    throw new Error(`Git checkpoint comparison lacks new tracked content for ${change.path}`);
  }
  return {
    path: change.path,
    status: change.status,
    old: oldMode ? { kind: change.oldKind!, tracking: "tracked", mode: oldMode, bytes: change.oldBytes } : undefined,
    next: newMode ? { kind: change.newKind!, tracking: "tracked", mode: newMode, bytes: change.newBytes } : undefined,
  };
}

function untrackedState(state: GitCheckpointUntrackedState | undefined, path: string): ReviewState | undefined {
  if (!state) return undefined;
  if (state.kind !== "file" && state.kind !== "symlink") throw new Error(`Git checkpoint comparison has invalid untracked kind for ${path}`);
  if (!Number.isInteger(state.mode) || state.mode < 0) throw new Error(`Git checkpoint comparison has invalid untracked mode for ${path}`);
  const bits = state.mode & 0o777;
  const fileMode = mode(state.kind, bits, path);
  if (!fileMode) throw new Error(`Git checkpoint comparison lacks untracked mode for ${path}`);
  if (state.kind === "file" && !Buffer.isBuffer(state.content)) {
    throw new Error(`Git checkpoint comparison lacks untracked file content for ${path}`);
  }
  if (state.kind === "symlink" && typeof state.target !== "string") {
    throw new Error(`Git checkpoint comparison lacks untracked symlink target for ${path}`);
  }
  return { kind: state.kind, tracking: "untracked", mode: fileMode, bytes: state.content, target: state.target };
}

function untrackedReviewChange(change: GitCheckpointUntrackedChange): ReviewEntry {
  const status = change.change === "removed" ? "deleted" : change.change === "added" ? "added" : change.change === "modified" ? "modified" : undefined;
  if (!status) throw new Error("Git checkpoint comparison has invalid untracked status");
  const old = untrackedState(change.old, change.path);
  const next = untrackedState(change.new, change.path);
  if (status !== "added" && !old || status !== "deleted" && !next) {
    throw new Error(`Git checkpoint comparison lacks untracked state for ${change.path}`);
  }
  return { path: change.path, status, old, next };
}

function reviewContent(state: ReviewState | undefined, maxFileBytes: number): { content?: string; reason?: string } {
  if (!state) return {};
  if (state.kind === "symlink") {
    // Tracked symlink targets are raw Git blob bytes, not file bytes reached by
    // following a link. Untracked targets are exact arm-time/current strings.
    if (state.target === undefined && !state.bytes) throw new Error("Git checkpoint comparison lacks changed symlink target");
    const text = state.target ?? new TextDecoder("utf-8", { fatal: true }).decode(state.bytes);
    return Buffer.byteLength(text, "utf8") > maxFileBytes ? { reason: "oversized" } : { content: text };
  }
  if (!state.bytes) throw new Error("Git checkpoint comparison lacks changed content");
  if (looksBinary(state.bytes, state.bytes.length > BINARY_SAMPLE_BYTES)) return { reason: "binary" };
  if (state.bytes.length > maxFileBytes) return { reason: "oversized" };
  return { content: state.bytes.toString("utf8") };
}
