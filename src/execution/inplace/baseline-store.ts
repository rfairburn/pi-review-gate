import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileSnapshot, WorkspaceSnapshot } from "../../capture";
import { atomicWriteExclusive } from "../durable-write";
import type { InPlaceBaseline } from "./basis";

// ── durable launch baseline (#220 review pass 1) ───────────────────────────

/**
 * The durable launch baseline document. Captured ONCE, before the executor's
 * first dispatch, and restored (verified) for every continuation: writes made
 * before a pause are part of the original attribution basis and must never
 * silently become part of a RE-baselined continuation. File content is
 * retained up to the launch snapshot's existing maxSnapshotBytes bound; mount
 * metadata (inode/dev, absolute paths, timestamps) is intentionally dropped —
 * it is not part of either the snapshot's content equivalence or the
 * attribution identity, and stale device/inode values would block legitimate
 * snapshot reuse on the restored session's filesystem.
 */
interface PersistedInPlaceBaselineDoc {
  version: 1;
  taskId: string;
  workspaceRoot: string;
  mode: "git" | "non_git";
  capturedAt: string;
  gitHead?: string;
  gitRepositoryRoot?: string;
  omissions: Array<{ path: string; kind: string; reason: string }>;
  omissionsTruncated: boolean;
  files: Array<PersistedFileSnapshot>;
  integritySha256: string;
}

interface PersistedFileSnapshot {
  path: string;
  exists: boolean;
  size: number;
  mode?: number;
  entryType?: FileSnapshot["entryType"];
  linkTarget?: string;
  gitObjectId?: string;
  sha256: string | null;
  isBinary: boolean;
  content?: string;
  omittedReason?: string;
}

export const INPLACE_BASELINE_FILE = "baseline.json";

/** Serialize the launch baseline for durable retention (exact, self-hashed doc). */
function serializeInPlaceBaseline(baseline: InPlaceBaseline, taskId: string): PersistedInPlaceBaselineDoc {
  const unsigned = {
    version: 1 as const,
    taskId,
    workspaceRoot: baseline.workspaceRoot,
    mode: baseline.mode,
    capturedAt: baseline.capturedAt,
    ...(baseline.gitHead ? { gitHead: baseline.gitHead } : {}),
    ...(baseline.gitRepositoryRoot ? { gitRepositoryRoot: baseline.gitRepositoryRoot } : {}),
    omissions: baseline.snapshot.omissions.map((omission) => ({
      path: omission.path,
      kind: omission.kind,
      reason: omission.reason,
    })),
    omissionsTruncated: baseline.snapshot.omissionsTruncated,
    files: [...baseline.snapshot.files.entries()].map(([path, entry]) => ({
      path,
      exists: entry.exists,
      size: entry.size,
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      ...(entry.entryType ? { entryType: entry.entryType } : {}),
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
      ...(entry.gitObjectId !== undefined ? { gitObjectId: entry.gitObjectId } : {}),
      sha256: entry.sha256,
      isBinary: entry.isBinary,
      ...(entry.content !== undefined ? { content: entry.content } : {}),
      ...(entry.omittedReason !== undefined ? { omittedReason: entry.omittedReason } : {}),
    })),
  };
  return {
    ...unsigned,
    integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}

/**
 * Persist the launch baseline durably BEFORE the executor dispatches, at the
 * task's artifact directory (which always lives outside the workspace). One
 * document per task; a later dispatch overwrites only via an explicit,
 * verified re-persist — continuations must load and verify instead.
 */
export async function persistInPlaceBaseline(baseline: InPlaceBaseline, taskId: string, artifactDir: string): Promise<string> {
  const doc = serializeInPlaceBaseline(baseline, taskId);
  const path = join(artifactDir, INPLACE_BASELINE_FILE);
  await atomicWriteExclusive(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}

/**
 * Restore the original launch baseline for a continuation and verify it: the
 * integrity hash, the task identity, and the workspace root's canonical path
 * must all match. A missing, tampered, or mis-rooted document fails closed
 * with an actionable refusal — never a silently re-baselined continuation.
 */
export async function loadInPlaceBaseline(taskId: string, artifactDir: string, workspaceRoot: string): Promise<InPlaceBaseline> {
  const path = join(artifactDir, INPLACE_BASELINE_FILE);
  let doc: PersistedInPlaceBaselineDoc;
  try {
    doc = JSON.parse(await readFile(path, "utf8")) as PersistedInPlaceBaselineDoc;
  } catch (error) {
    throw new Error(
      `In-place continuation refused: the launch baseline document ${path} could not be read (${error instanceof Error ? error.message : String(error)}). The original launch state cannot be verified, so the task is not continued; inspect the workspace and its artifacts manually.`,
    );
  }
  const { integritySha256, ...unsigned } = doc;
  const actual = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (doc.version !== 1 || !integritySha256 || integritySha256 !== actual || doc.taskId !== taskId) {
    throw new Error(
      `In-place continuation refused: the persisted launch baseline for task ${taskId} is malformed or tampered; the original launch state cannot be verified, so the task is not continued.`,
    );
  }
  if (resolve(doc.workspaceRoot) !== resolve(workspaceRoot)) {
    throw new Error(
      `In-place continuation refused: the persisted launch baseline names workspace ${doc.workspaceRoot}, not ${workspaceRoot}; continuing would review the wrong basis.`,
    );
  }
  const files = new Map<string, FileSnapshot>();
  for (const entry of doc.files) {
    const rebuilt: FileSnapshot = {
      relativePath: entry.path,
      absolutePath: resolve(workspaceRoot, entry.path),
      exists: entry.exists,
      // Restored records never carry live mount identity: they exist to
      // anchor attribution identity and review diffs. Stale mtime/absent
      // stat fields simply make snapshot REUSE ineligible (fresh re-inspection
      // with identical hashing) rather than untrusted.
      size: entry.size,
      mtimeMs: 0,
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      ...(entry.entryType ? { entryType: entry.entryType } : {}),
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
      ...(entry.gitObjectId !== undefined ? { gitObjectId: entry.gitObjectId } : {}),
      sha256: entry.sha256,
      isBinary: entry.isBinary,
      ...(entry.content !== undefined ? { content: entry.content } : {}),
      ...(entry.omittedReason !== undefined ? { omittedReason: entry.omittedReason as FileSnapshot["omittedReason"] } : {}),
    };
    files.set(entry.path, rebuilt);
  }
  const snapshot: WorkspaceSnapshot = {
    cwd: resolve(workspaceRoot),
    capturedAt: doc.capturedAt,
    files,
    omissions: doc.omissions.map((omission) => ({
      kind: omission.kind,
      path: omission.path,
      reason: omission.reason,
    })) as WorkspaceSnapshot["omissions"],
    omissionsTruncated: doc.omissionsTruncated,
  };
  return {
    workspaceRoot: resolve(doc.workspaceRoot),
    mode: doc.mode,
    capturedAt: doc.capturedAt,
    ...(doc.gitHead ? { gitHead: doc.gitHead } : {}),
    ...(doc.gitRepositoryRoot ? { gitRepositoryRoot: doc.gitRepositoryRoot } : {}),
    snapshot,
  };
}
