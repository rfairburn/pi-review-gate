import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { promises as fs, readlink as fsReadlink, Stats } from "node:fs";
import { join, sep, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { WaveCaptureResult } from "./wave-repository";
import { integrationRefName } from "./wave-worktrees";
import { GIT_NO_LOCKS_ENV as GIT_ENV, validateSafeId } from "./wave-validation";

const execFileAsync = promisify(execFile);
const readlinkBuffer = promisify(fsReadlink);

// ── types ────────────────────────────────────────────────────────────────────

/** Git tree entry state for a single path. */
export interface TreeEntry {
  /** Blob SHA-1 (hex), or undefined if the path is absent in this tree. */
  blobId: string | undefined;
  /** Git mode string: "100644" | "100755" | "120000". */
  mode: string;
}

/** Classification of a path for landing. */
export type LandingAction = "apply" | "already_applied" | "conflict";

/** Describes a single path in the landing plan. */
export interface LandingPath {
  /** Normalized repo-relative path. */
  path: string;
  /** What to do with this path. */
  action: LandingAction;
  /** State in the base tree. */
  base: TreeEntry | null;
  /** State in the integrated (result) tree. */
  result: TreeEntry | null;
  /** Reason for conflict, or undefined if not a conflict. */
  conflictReason?: string;
}

/** Describes a conflict in detail. */
export interface LandingConflict {
  /** Normalized repo-relative path. */
  path: string;
  /** Human-readable reason. */
  reason: string;
}

/** Source HEAD drift provenance. */
export interface SourceHeadDrift {
  /** Whether the source HEAD differs from the wave base parent. */
  drifted: boolean;
  /** The captured source HEAD at wave capture time. */
  capturedHead: string | undefined;
  /** The current source HEAD. */
  currentHead: string | undefined;
}

/** Full landing plan result. */
export interface LandingPlan {
  /** All paths affected by the wave delta. */
  paths: LandingPath[];
  /** Only conflict paths. */
  conflicts: LandingConflict[];
  /** Paths that will be applied (action === "apply"). */
  changedPaths: string[];
  /** Source HEAD drift provenance. */
  headDrift: SourceHeadDrift;
  /** The integrated commit SHA. */
  integratedCommitSha: string;
  /** The integrated ref name. */
  integratedRef: string;
  /** Canonical resolved source root this plan is bound to. */
  sourceRoot: string;
  /** Base commit SHA this plan is derived from. */
  baseCommit: string;
}

// ── execution result types ───────────────────────────────────────────────────

/** A single path entry in the recovery manifest. */
export interface RecoveryPathEntry {
  /** Normalized repo-relative path. */
  path: string;
  /** Absolute destination path on the source filesystem. */
  destination: string;
  /** Absolute temporary file path (where integrated content was staged). */
  temp: string;
  /** Absolute backup path (original content preserved before overwrite), or null for additions. */
  backup: string | null;
  /** Current operation phase for crash diagnosis. */
  phase: "planned" | "backup_created" | "replacement_installed" | "rolled_back" | "cleanup";
  /** Original state before landing: "present", "absent", or "symlink". */
  originalState: "present" | "absent" | "symlink";
  /** Git mode of the integrated content. */
  mode: string;
  /** Blob SHA of the integrated content. */
  blobId: string;
  /** Blob SHA of the base content (for modifications/deletions), or null for additions. */
  baseBlobId: string | null;
}

/** Immutable identity of the source capture root (dev + ino). */
export interface SourceIdentity {
  /** Device ID of the filesystem containing the capture root. */
  dev: number;
  /** Inode number of the capture root directory. */
  ino: number;
}

/** Recovery manifest written atomically before any mutations. */
export interface RecoveryManifest {
  /** Version of the manifest format. */
  version: 1;
  /** Timestamp (ISO 8601) when the manifest was created. */
  timestamp: string;
  /** Canonical source root. */
  sourceRoot: string;
  /** Immutable identity of the source capture root (dev+ino). */
  sourceIdentity: SourceIdentity;
  /** Base commit SHA. */
  baseCommit: string;
  /** Integrated commit SHA. */
  integratedCommit: string;
  /** Integrated ref name. */
  integratedRef: string;
  /** Paths being applied. */
  paths: RecoveryPathEntry[];
  /** Parent directories created during landing (for cleanup on rollback). */
  createdDirs: string[];
  /** Current state: "in_progress", "completed", "rolled_back", or "recovery_required". */
  state: "in_progress" | "completed" | "rolled_back" | "recovery_required";
  /** HMAC-SHA256 authentication tag over canonical manifest content. */
  authTag: string;
}

/** Diagnostics for recovery_required status. */
export interface RecoveryDiagnostics {
  /** Paths that were successfully applied before failure. */
  appliedPaths: string[];
  /** Path where failure occurred. */
  failedAtPath: string | null;
  /** Error message from the failure. */
  failureReason: string;
  /** Rollback error message. */
  rollbackError: string;
  /** Absolute path to the recovery manifest. */
  manifestPath: string;
}

/** Successful landing result. */
export interface LandingExecutionSuccess {
  status: "landed";
  /** Paths that were applied. */
  appliedPaths: string[];
  /** Paths that were already applied (no-op). */
  alreadyAppliedPaths: string[];
  /** Absolute path to the completed recovery manifest. */
  manifestPath: string;
}

/** Conflict result — no mutations performed. */
export interface LandingExecutionConflict {
  status: "conflicted";
  /** Conflicts detected during revalidation. */
  conflicts: LandingConflict[];
}

/** Rollback result — all mutations reversed. */
export interface LandingExecutionRolledBack {
  status: "rolled_back";
  /** Paths that were applied before failure. */
  appliedPaths: string[];
  /** Path where failure occurred. */
  failedAtPath: string | null;
  /** Error message from the failure. */
  failureReason: string;
}

/** Recovery required — rollback failed, artifacts preserved. */
export interface LandingExecutionRecoveryRequired {
  status: "recovery_required";
  /** Diagnostics for manual recovery. */
  diagnostics: RecoveryDiagnostics;
}

/** Union of all landing execution result types. */
export type LandingExecutionResult =
  | LandingExecutionSuccess
  | LandingExecutionConflict
  | LandingExecutionRolledBack
  | LandingExecutionRecoveryRequired;

// ── recovery result types ────────────────────────────────────────────────────

/** Per-path recovery action taken. */
export type RecoveryPathAction = "restored" | "preserved" | "cleaned" | "skipped";

/** Per-path recovery detail. */
export interface RecoveryPathDetail {
  /** Normalized repo-relative path. */
  path: string;
  /** Action taken during recovery. */
  action: RecoveryPathAction;
  /** Explanation of the action. */
  reason: string;
  /** Absolute path to remaining backup artifact, if any. */
  backupRemaining?: string;
  /** Absolute path to remaining temp artifact, if any. */
  tempRemaining?: string;
}

/** Result of a successful recovery (all paths restored). */
export interface RecoveryResultSuccess {
  status: "recovered";
  /** Paths that were restored. */
  restoredPaths: string[];
  /** Paths that were cleaned up. */
  cleanedPaths: string[];
  /** Absolute path to the recovery manifest. */
  manifestPath: string;
}

/** Result when manual intervention is required. */
export interface RecoveryResultManual {
  status: "manual_required";
  /** Per-path recovery details. */
  pathDetails: RecoveryPathDetail[];
  /** Absolute path to the recovery manifest. */
  manifestPath: string;
  /** Human-readable summary of remaining artifacts. */
  summary: string;
}

/** Result when the manifest was rejected (malformed, wrong version, etc.). */
export interface RecoveryResultRejected {
  status: "rejected";
  /** Reason for rejection. */
  reason: string;
  /** Absolute path to the recovery manifest. */
  manifestPath: string;
}

/** Result when the manifest was already in a terminal state. */
export interface RecoveryResultTerminal {
  status: "terminal";
  /** The terminal state of the manifest. */
  state: "completed" | "rolled_back";
  /** Paths that were cleaned up (for completed manifests). */
  cleanedPaths?: string[];
  /** Absolute path to the recovery manifest. */
  manifestPath: string;
}

/** Union of all recovery result types. */
export type RecoveryResult =
  | RecoveryResultSuccess
  | RecoveryResultManual
  | RecoveryResultRejected
  | RecoveryResultTerminal;

export interface LandingRecoveryManifestInspection {
  manifestPath: string;
  state?: RecoveryManifest["state"];
  verified: boolean;
  sourceRoot?: string;
  paths: Array<{ path: string; phase: RecoveryPathEntry["phase"] }>;
  error?: string;
}

export async function inspectLandingRecoveryManifests(waveRoot: string): Promise<LandingRecoveryManifestInspection[]> {
  const landingDir = join(waveRoot, "landing");
  const entries = await fs.readdir(landingDir, { withFileTypes: true }).catch(() => []);
  const key = await readAuthKey(landingDir);
  const inspections: LandingRecoveryManifestInspection[] = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && /^manifest-[0-9a-zA-Z-]+\.json$/.test(candidate.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = join(landingDir, entry.name);
    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<RecoveryManifest>;
      const structurallyValid = parsed.version === 1
        && typeof parsed.sourceRoot === "string"
        && ["in_progress", "completed", "rolled_back", "recovery_required"].includes(String(parsed.state))
        && Array.isArray(parsed.paths)
        && parsed.paths.every((path) => path && typeof path.path === "string" && typeof path.phase === "string");
      const verified = Boolean(structurallyValid && key && parsed.authTag && verifyAuthTag(key, parsed as RecoveryManifest));
      inspections.push({
        manifestPath,
        state: structurallyValid ? parsed.state : undefined,
        verified,
        sourceRoot: typeof parsed.sourceRoot === "string" ? parsed.sourceRoot : undefined,
        paths: Array.isArray(parsed.paths)
          ? parsed.paths.flatMap((path) => path && typeof path.path === "string" && typeof path.phase === "string"
            ? [{ path: path.path, phase: path.phase }]
            : [])
          : [],
        error: structurallyValid ? verified ? undefined : "Manifest authentication could not be verified." : "Manifest structure is invalid.",
      });
    } catch (error) {
      inspections.push({
        manifestPath,
        verified: false,
        paths: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return inspections;
}

// ── git helpers ──────────────────────────────────────────────────────────────

async function gitOut(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
      signal,
    },
  );
  return stdout.trim();
}

/** Like gitOut but returns raw buffer output (for NUL-safe parsing). */
async function gitOutBuffer(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    args,
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      signal,
    },
  );
  return stdout;
}

/** Hash a blob using the repository's Git object format. */
function hashBlob(data: Buffer, algorithm: "sha1" | "sha256"): string {
  const header = `blob ${data.length}\0`;
  return createHash(algorithm).update(header).update(data).digest("hex");
}

function objectHashForOid(oid: string): "sha1" | "sha256" {
  if (/^[0-9a-f]{40}$/.test(oid)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(oid)) return "sha256";
  throw new Error(`Unsupported Git object ID: ${oid}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

// ── tree entry lookup ────────────────────────────────────────────────────────

/**
 * Look up a single path in a Git tree and return its entry.
 * Returns null if the path does not exist in the tree.
 * Rejects directories and special entries (gitlinks, submodules).
 *
 * Uses NUL-delimited output (-z) so filenames containing newlines, tabs,
 * and other special characters are parsed correctly.
 */
async function lookupTreeEntry(
  repoPath: string,
  treeSha: string,
  path: string,
  signal?: AbortSignal,
): Promise<TreeEntry | null> {
  // Use :(literal) path magic so filenames with glob metacharacters (*, ?, [)
  // are treated as literal paths, not patterns. Use -z for NUL-delimited output
  // so filenames with newlines or tabs are parsed correctly.
  const output = await gitOutBuffer(
    ["ls-tree", "-z", treeSha, `:(literal)${path}`],
    repoPath,
    signal,
  );

  if (!output) {
    return null;
  }

  // Parse the NUL-delimited ls-tree output: "mode type sha\tname\0"
  // The metadata and filename are separated by a tab; NUL terminates the record.
  // Strip the trailing NUL.
  const trimmed = output.endsWith("\0") ? output.slice(0, -1) : output;
  const tabIdx = trimmed.indexOf("\t");
  if (tabIdx < 0) {
    return null;
  }

  const metaPart = trimmed.slice(0, tabIdx);
  // Parse the metadata: "mode type sha"
  const metaMatch = metaPart.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40}|[0-9a-f]{64})$/);
  if (!metaMatch) {
    return null;
  }

  const mode = metaMatch[1];
  const type = metaMatch[2];
  const blobId = metaMatch[3];

  // Reject directories (type "tree") and gitlinks (type "commit").
  if (type === "tree") {
    throw new Error(`Path "${path}" is a directory, not a file.`);
  }
  if (type === "commit") {
    throw new Error(`Path "${path}" is a gitlink (submodule), not a file.`);
  }

  // Only accept blob entries with valid modes.
  if (type !== "blob") {
    throw new Error(`Path "${path}" has unexpected Git type "${type}".`);
  }
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new Error(`Path "${path}" has unexpected Git mode "${mode}".`);
  }

  return { blobId, mode };
}

// ── filesystem inspection ────────────────────────────────────────────────────

/**
 * Inspect a file on the source filesystem and return its state.
 * Returns null if the file does not exist.
 * Rejects directories, special entries, and symlinked ancestors.
 */
async function inspectSourceFile(
  sourceRoot: string,
  relPath: string,
  objectHash: "sha1" | "sha256",
  signal?: AbortSignal,
): Promise<{ blobId: string; mode: string } | null> {
  throwIfAborted(signal);
  const fullPath = join(sourceRoot, relPath);

  // Validate ancestor directories: reject symlinked or special ancestors
  // that could cause the path to resolve outside sourceRoot.
  // Iterate by index to handle repeated segment names correctly (e.g., "a/a/file.txt").
  const segments = relPath.split("/");
  const ancestorCount = segments.length - 1;
  for (let i = 0; i < ancestorCount; i++) {
    throwIfAborted(signal);
    const ancestor = segments[i];
    if (!ancestor) continue;
    const ancestorPath = join(sourceRoot, ...segments.slice(0, i + 1));
    let ancestorStat: Stats;
    try {
      ancestorStat = await fs.lstat(ancestorPath);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        // Ancestor doesn't exist — the file can't exist either.
        return null;
      }
      throw err;
    }
    if (ancestorStat.isSymbolicLink()) {
      throw new Error(
        `Ancestor "${ancestor}" is a symbolic link; refusing to follow symlinks outside source root.`,
      );
    }
    if (!ancestorStat.isDirectory()) {
      throw new Error(
        `Ancestor "${ancestor}" is not a directory on the source filesystem.`,
      );
    }
  }

  let lstat: Stats;
  try {
    lstat = await fs.lstat(fullPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return null;
    }
    if (nodeErr?.code === "ENOTDIR") {
      // A parent component is not a directory — this is an error, not absence.
      throw new Error(`Path "${relPath}" has a non-directory ancestor.`);
    }
    throw err;
  }

  // Reject directories and special entries.
  if (lstat.isDirectory()) {
    throw new Error(
      `Path "${relPath}" is a directory on the source filesystem.`,
    );
  }
  if (!lstat.isFile() && !lstat.isSymbolicLink()) {
    throw new Error(
      `Path "${relPath}" is a special file on the source filesystem.`,
    );
  }

  if (lstat.isSymbolicLink()) {
    // Symlink: hash the raw target without resolving (avoids dangling/external
    // symlink failures and allows exact comparison with Git tree entries).
    const targetBuffer = (await readlinkBuffer(fullPath, { encoding: null })) as unknown as Buffer;
    const blobId = hashBlob(targetBuffer, objectHash);
    return { blobId, mode: "120000" };
  } else {
    // Regular file: verify the resolved path stays under sourceRoot.
    const resolvedPath = await fs.realpath(fullPath);
    if (!resolvedPath.startsWith(sourceRoot + sep) && resolvedPath !== sourceRoot) {
      throw new Error(
        `Path "${relPath}" resolves outside source root via symlink traversal.`,
      );
    }
    const data = await fs.readFile(fullPath, { signal });
    const blobId = hashBlob(data, objectHash);
    const isExecutable = (lstat.mode & 0o111) !== 0;
    const mode = isExecutable ? "100755" : "100644";
    return { blobId, mode };
  }
}

// ── path safety ──────────────────────────────────────────────────────────────

/**
 * Validate that a path is safe (no traversal, no absolute, no special chars).
 * Only rejects actual ".." path segments — harmless names like "file..txt" are allowed.
 */
export function validatePathSafe(path: string): void {
  if (isAbsolute(path)) {
    throw new Error(`Path "${path}" is absolute.`);
  }
  if (path.includes("\0")) {
    throw new Error(`Path "${path}" contains NUL character.`);
  }
  // Normalize separators.
  const normalized = path.split(sep).join("/");
  if (normalized !== path) {
    throw new Error(`Path "${path}" contains non-POSIX separators.`);
  }
  // Check for actual ".." path segments (not just the substring "..").
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`Path "${path}" contains path traversal.`);
    }
  }
}

// ── main planning function ───────────────────────────────────────────────────

/**
 * Plan a guarded landing of an integrated wave into the source filesystem.
 *
 * This is a read-only planning operation. It:
 * 1. Verifies the integrated ref points to the expected commit.
 * 2. Derives the exact wave-owned delta from base to integrated (no renames).
 * 3. For each affected path, loads base and result tree entries.
 * 4. Inspects the current source filesystem directly.
 * 5. Classifies every path as apply, already_applied, or conflict.
 * 6. Records source HEAD drift without blocking.
 *
 * Does NOT: write, chmod, rename, stage, reset, or touch the source index.
 * Does NOT: invoke git apply or patch.
 */
export async function planWaveLanding(
  capture: WaveCaptureResult,
  integratedCommitSha: string,
  sourceRoot: string,
  signal?: AbortSignal,
): Promise<LandingPlan> {
  throwIfAborted(signal);
  const { waveId, repositoryPath, baseCommit } = capture;

  // Validate IDs.
  validateSafeId(waveId, "waveId");

  // ── Bind to canonical capture root identity (dev+ino) ──
  // Verify the current sourceRoot is the same non-symlink directory identity
  // as the one captured. This rejects path retarget/replacement attacks where
  // the original directory is renamed and a symlink is planted at the old path.
  const resolvedSourceRoot = await fs.realpath(sourceRoot);
  const currentRootStat = await fs.stat(resolvedSourceRoot);
  const capturedIdentity = capture.sourceIdentity;
  if (currentRootStat.dev !== capturedIdentity.dev || currentRootStat.ino !== capturedIdentity.ino) {
    throw new Error(
      `Source root identity mismatch: current dev=${currentRootStat.dev},ino=${currentRootStat.ino} ` +
      `does not match captured dev=${capturedIdentity.dev},ino=${capturedIdentity.ino}. ` +
      `Planning must be bound to the exact captured source root.`,
    );
  }

  // ── Step 1: Verify integrated ref points to the expected commit ──
  const integratedRef = integrationRefName(waveId);
  const refSha = await gitOut(
    ["rev-parse", "--verify", integratedRef],
    repositoryPath,
    signal,
  ).catch((error) => {
    if (signal?.aborted) throw error;
    return null;
  });

  if (!refSha) {
    throw new Error(
      `Integrated ref ${integratedRef} does not exist. ` +
      `The wave must be integrated before landing.`,
    );
  }
  if (refSha !== integratedCommitSha) {
    throw new Error(
      `Integrated ref ${integratedRef} points to ${refSha}, ` +
      `expected ${integratedCommitSha}. Ref mismatch.`,
    );
  }

  // ── Step 2: Derive the exact wave-owned delta (base..integrated, no renames) ──
  const rawPaths = await gitOutBuffer(
    ["diff", "--name-only", "-z", "--no-renames", baseCommit, integratedCommitSha],
    repositoryPath,
    signal,
  );
  const changedPaths = rawPaths
    .split("\0")
    .filter(Boolean)
    .sort();

  // Validate all paths are safe.
  for (const path of changedPaths) {
    throwIfAborted(signal);
    validatePathSafe(path);
  }

  // ── Step 3: Load base and result tree entries for each path ──
  const baseTreeSha = await gitOut(
    ["rev-parse", `${baseCommit}^{tree}`],
    repositoryPath,
    signal,
  );
  const resultTreeSha = await gitOut(
    ["rev-parse", `${integratedCommitSha}^{tree}`],
    repositoryPath,
    signal,
  );

  const baseEntries = new Map<string, TreeEntry | null>();
  const resultEntries = new Map<string, TreeEntry | null>();

  for (const path of changedPaths) {
    throwIfAborted(signal);
    const baseEntry = await lookupTreeEntry(repositoryPath, baseTreeSha, path, signal);
    const resultEntry = await lookupTreeEntry(repositoryPath, resultTreeSha, path, signal);
    baseEntries.set(path, baseEntry);
    resultEntries.set(path, resultEntry);
  }

  // ── Step 4: Inspect source filesystem and classify each path ──
  const paths: LandingPath[] = [];
  const conflicts: LandingConflict[] = [];
  const changedPathsList: string[] = [];

  for (const path of changedPaths) {
    throwIfAborted(signal);
    const baseEntry = baseEntries.get(path)!;
    const resultEntry = resultEntries.get(path)!;

    // Inspect the current source filesystem.
    let current: { blobId: string; mode: string } | null;
    try {
      current = await inspectSourceFile(resolvedSourceRoot, path, objectHashForOid(baseCommit), signal);
    } catch (err) {
      if (err instanceof Error && (
        err.message.includes("directory") ||
        err.message.includes("special file") ||
        err.message.includes("symbolic link") ||
        err.message.includes("symlink")
      )) {
        // Directory, special file, or symlink ancestor — conflict.
        const conflictPath: LandingPath = {
          path,
          action: "conflict",
          base: baseEntry,
          result: resultEntry,
          conflictReason: err.message,
        };
        paths.push(conflictPath);
        conflicts.push({ path, reason: err.message });
        continue;
      }
      throw err;
    }

    // ── Classify the path ──
    let action: LandingAction;
    let conflictReason: string | undefined;

    if (current === null) {
      // File does not exist on source filesystem.
      if (baseEntry === null) {
        // Base: absent, Result: present → new file, source doesn't have it → apply.
        action = "apply";
      } else {
        // Base: present, Result: absent → delete, source doesn't have it → already deleted → already_applied.
        // Base: present, Result: present → modify, source doesn't have it → already deleted → conflict.
        if (resultEntry === null) {
          action = "already_applied";
        } else {
          action = "conflict";
          conflictReason = "File exists in base and result but is absent on source filesystem.";
        }
      }
    } else {
      // File exists on source filesystem.
      if (baseEntry === null) {
        // Base: absent, Result: present → new file.
        // Source has the file → check if it matches the result.
        const currentMatchesResult =
          current.blobId === resultEntry.blobId && current.mode === resultEntry.mode;
        if (currentMatchesResult) {
          // Source has the exact result content → already applied.
          action = "already_applied";
        } else {
          // Source has different content → newly created path collision.
          action = "conflict";
          conflictReason = "Newly created path already exists on source filesystem.";
        }
      } else if (resultEntry === null) {
        // Base: present, Result: absent → delete.
        // Source has the file → check if it matches base before deleting.
        const currentMatchesBase =
          current.blobId === baseEntry!.blobId && current.mode === baseEntry!.mode;
        if (currentMatchesBase) {
          // Source matches base → safe to delete.
          action = "apply";
        } else {
          // Source differs from base → locally modified file that wave deletes → conflict.
          action = "conflict";
          conflictReason = "File is deleted by the wave but locally modified on source.";
        }
      } else {
        // Base: present, Result: present → modify or mode change.
        // Compare current to base and result.
        const currentMatchesBase =
          current.blobId === baseEntry.blobId && current.mode === baseEntry.mode;
        const currentMatchesResult =
          current.blobId === resultEntry.blobId && current.mode === resultEntry.mode;

        if (currentMatchesResult) {
          // Current == result → already applied → no-op.
          action = "already_applied";
        } else if (currentMatchesBase) {
          // Current == base → safe to apply.
          action = "apply";
        } else {
          // Current differs from both base and result → conflict.
          const reasons: string[] = [];
          if (current.blobId !== baseEntry.blobId) {
            reasons.push("content differs from base");
          }
          if (current.mode !== baseEntry.mode) {
            reasons.push("mode differs from base");
          }
          if (current.blobId !== resultEntry.blobId) {
            reasons.push("content differs from result");
          }
          if (current.mode !== resultEntry.mode) {
            reasons.push("mode differs from result");
          }
          action = "conflict";
          conflictReason = `Source state differs from both base and result: ${reasons.join(", ")}.`;
        }
      }
    }

    const landingPath: LandingPath = {
      path,
      action,
      base: baseEntry,
      result: resultEntry,
      conflictReason,
    };
    paths.push(landingPath);

    if (action === "conflict") {
      conflicts.push({ path, reason: conflictReason! });
    } else if (action === "apply") {
      changedPathsList.push(path);
    }
  }

  // ── Step 5: Record source HEAD drift ──
  const capturedHead = capture.discovery.headCommit;
  let currentHead: string | undefined;
  try {
    currentHead = await gitOut(["rev-parse", "HEAD"], resolvedSourceRoot, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Source may not be a Git repo or HEAD may be unborn.
    currentHead = undefined;
  }

  const headDrift: SourceHeadDrift = {
    drifted: capturedHead !== currentHead,
    capturedHead,
    currentHead,
  };

  return {
    paths,
    conflicts,
    changedPaths: changedPathsList,
    headDrift,
    integratedCommitSha,
    integratedRef,
    sourceRoot: resolvedSourceRoot,
    baseCommit,
  };
}

// ── transactional execution ──────────────────────────────────────────────────

/** @internal Per-invocation fault hooks used by landing regression tests. */
export interface WaveLandingHooks {
  failAfterNPaths?: number;
  failAfterBackupOf?: string;
  afterApplyPath?: (relPath: string, destPath: string) => Promise<void> | void;
}

/**
 * Unlink a file, ignoring ENOENT but rethrowing other errors.
 */
async function unlinkIfAbsent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Atomically update a JSON file by writing to a temp file and renaming.
 * Cleans up temp files on error and fsyncs the final file where practical.
 */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${randomUUID()}`;
  let created = false;
  try {
    const fd = await fs.open(tmp, "wx");
    created = true;
    await fd.writeFile(JSON.stringify(data, null, 2));
    await fd.datasync();
    await fd.close();
    await fs.rename(tmp, path);
    // fsync the directory containing the file to ensure durability.
    const dir = path.substring(0, path.lastIndexOf("/"));
    try {
      const dirFd = await fs.open(dir, "r");
      await dirFd.datasync();
      await dirFd.close();
    } catch (_fsyncErr) {
      // fsync is best-effort; ignore failures.
    }
  } catch (_writeErr) {
    // Clean up temp file only if this invocation created it.
    if (created) {
      await unlinkIfAbsent(tmp).catch(() => {});
    }
    throw _writeErr;
  }
}

/**
 * Generate a unique transaction-scoped suffix for temp/backup names.
 * Uses randomUUID for collision resistance.
 */
function txId(): string {
  return randomUUID();
}

/**
 * Create a collision-safe artifact key from a path by hashing it.
 * This avoids collisions for paths like "a/b" vs "a_b".
 */
function artifactKey(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

// ── manifest authentication ──────────────────────────────────────────────────

/** Sidecar filename for the authentication key. */
const AUTH_KEY_FILENAME = ".auth-key";

/**
 * Generate a random authentication key and write it with owner-only permissions.
 * The key is stored under the landing artifact directory, never under sourceRoot.
 */
export async function generateAuthKey(landingDir: string): Promise<string> {
  const key = randomBytes(32);
  const keyPath = join(landingDir, AUTH_KEY_FILENAME);
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  return key.toString("hex");
}

/**
 * Read the authentication key from the landing directory.
 */
export async function readAuthKey(landingDir: string): Promise<Buffer | null> {
  const keyPath = join(landingDir, AUTH_KEY_FILENAME);
  try {
    return await fs.readFile(keyPath);
  } catch {
    return null;
  }
}

/**
 * Compute canonical JSON content for HMAC signing.
 * Strips the authTag field and produces deterministic output.
 */
function canonicalManifestContent(manifest: RecoveryManifest): string {
  const { authTag, ...rest } = manifest;
  return JSON.stringify(rest, null, 2);
}

/**
 * Compute HMAC-SHA256 tag over canonical manifest content.
 */
function computeAuthTag(key: Buffer, manifest: RecoveryManifest): string {
  const canonical = canonicalManifestContent(manifest);
  return createHmac("sha256", key).update(canonical).digest("hex");
}

/**
 * Verify the HMAC-SHA256 tag of a manifest against the auth key.
 */
function verifyAuthTag(key: Buffer, manifest: RecoveryManifest): boolean {
  const expected = computeAuthTag(key, manifest);
  return expected === manifest.authTag;
}

/**
 * Sign a manifest with the given key and write it atomically.
 */
async function signAndWriteManifest(
  manifestPath: string,
  manifest: RecoveryManifest,
  key: Buffer,
): Promise<void> {
  manifest.authTag = computeAuthTag(key, manifest);
  await atomicWriteJson(manifestPath, manifest);
}

/**
 * Atomically update the phase of a single path entry in the recovery manifest.
 * Recomputes the HMAC authentication tag after the update.
 */
async function updateManifestPhase(
  manifestPath: string,
  relPath: string,
  phase: "planned" | "backup_created" | "replacement_installed" | "rolled_back" | "cleanup",
  key: Buffer,
): Promise<void> {
  const data = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const entry = data.paths.find((e: RecoveryPathEntry) => e.path === relPath);
  if (entry) {
    entry.phase = phase;
  }
  await signAndWriteManifest(manifestPath, data, key);
}

/**
 * Execute a transactional landing of a conflict-free LandingPlan.
 *
 * This function:
 * 1. Revalidates the plan binding (sourceRoot, ref, commit) against the
 *    capture, and reruns full preflight immediately before writes.
 * 2. If any conflict appears during revalidation, returns conflicted without
 *    mutation.
 * 3. For apply paths, materializes exact integrated Git blobs and modes into
 *    unique same-directory temporary entries (including symlinks at temp paths).
 * 4. Creates parent directories as needed, tracking only newly-created dirs.
 * 5. Writes an atomic recovery manifest under <waveRoot>/landing before
 *    replacing anything.
 * 6. Applies each path with same-directory rename backups and just-in-time
 *    state revalidation; journals mutations before the second rename.
 * 7. On any I/O failure, rolls back all journal-mutated paths in reverse
 *    using backups, removes staged temps/new empty directories, and reports
 *    rolled_back.
 * 8. If safe rollback cannot complete, preserves recovery artifacts and returns
 *    recovery_required with diagnostics.
 * 9. On success, removes temporary backups, marks the manifest completed
 *    atomically, leaves changes uncommitted, and never touches source Git
 *    index/HEAD.
 *
 * Does NOT: use git apply, patch, stash, reset, staging, or write to source repo.
 */
export async function executeWaveLanding(
  plan: LandingPlan,
  capture: WaveCaptureResult,
  signal?: AbortSignal,
  hooks: WaveLandingHooks = {},
): Promise<LandingExecutionResult> {
  const { sourceRoot, baseCommit, integratedCommitSha, integratedRef } = plan;
  const { repositoryPath, waveRoot } = capture;

  // ── Step 0: Bind plan to capture ──
  // Verify the plan's baseCommit and integratedRef match the capture.
  if (baseCommit !== capture.baseCommit) {
    return {
      status: "conflicted",
      conflicts: [{
        path: "<plan>",
        reason: `Plan baseCommit ${baseCommit} does not match capture baseCommit ${capture.baseCommit}.`,
      }],
    };
  }
  const expectedRef = integrationRefName(capture.waveId);
  if (integratedRef !== expectedRef) {
    return {
      status: "conflicted",
      conflicts: [{
        path: "<plan>",
        reason: `Plan integratedRef ${integratedRef} does not match expected ${expectedRef}.`,
      }],
    };
  }

  // Validate all plan paths are safe.
  for (const lp of plan.paths) {
    validatePathSafe(lp.path);
  }

  // ── Step 1: Revalidate plan binding ──
  const refSha = await gitOut(
    ["rev-parse", "--verify", integratedRef],
    repositoryPath,
    signal,
  ).catch((error) => {
    if (signal?.aborted) throw error;
    return null;
  });

  if (!refSha) {
    return {
      status: "conflicted",
      conflicts: [{ path: "<ref>", reason: `Integrated ref ${integratedRef} does not exist.` }],
    };
  }
  if (refSha !== integratedCommitSha) {
    return {
      status: "conflicted",
      conflicts: [{
        path: "<ref>",
        reason: `Integrated ref ${integratedRef} points to ${refSha}, expected ${integratedCommitSha}.`,
      }],
    };
  }

  // Verify source root identity still matches (dev+ino).
  const resolvedSourceRoot = await fs.realpath(sourceRoot);
  const execRootStat = await fs.stat(resolvedSourceRoot);
  const execCapturedIdentity = capture.sourceIdentity;
  if (execRootStat.dev !== execCapturedIdentity.dev || execRootStat.ino !== execCapturedIdentity.ino) {
    return {
      status: "conflicted",
      conflicts: [{
        path: "<root>",
        reason: `Source root identity mismatch: current dev=${execRootStat.dev},ino=${execRootStat.ino} ` +
          `does not match captured dev=${execCapturedIdentity.dev},ino=${execCapturedIdentity.ino}.`,
      }],
    };
  }

  // ── Step 2: Reject plans with conflicts ──
  if (plan.conflicts.length > 0) {
    return {
      status: "conflicted",
      conflicts: plan.conflicts,
    };
  }

  // ── Step 2.5: Re-derive the tree delta from Git and compare ──
  // This prevents a mutable plan from landing a different blob/path delta.
  const freshPlan = await planWaveLanding(capture, integratedCommitSha, resolvedSourceRoot, signal);
  if (freshPlan.conflicts.length > 0) {
    return {
      status: "conflicted",
      conflicts: freshPlan.conflicts,
    };
  }
  // Compare the tree delta: every path's base/result blobId and mode must match.
  const planDelta = new Map(plan.paths.map((p) => [
    p.path,
    `${p.base?.blobId ?? "null"}/${p.base?.mode ?? "null"}=>${p.result?.blobId ?? "null"}/${p.result?.mode ?? "null"}`,
  ]));
  const freshDelta = new Map(freshPlan.paths.map((p) => [
    p.path,
    `${p.base?.blobId ?? "null"}/${p.base?.mode ?? "null"}=>${p.result?.blobId ?? "null"}/${p.result?.mode ?? "null"}`,
  ]));
  if (planDelta.size !== freshDelta.size) {
    return {
      status: "conflicted",
      conflicts: [{ path: "<plan>", reason: "Plan path set does not match the bound Git commits." }],
    };
  }
  for (const [path, delta] of planDelta) {
    if (freshDelta.get(path) !== delta) {
      return {
        status: "conflicted",
        conflicts: [{ path, reason: "Plan tree delta does not match the bound Git commits." }],
      };
    }
  }

  // Use the freshly validated plan for execution.
  const executionPaths = freshPlan.paths;

  // ── Step 3: Rerun full preflight — revalidate every path ──
  const applyPaths = executionPaths.filter((p) => p.action === "apply");
  const alreadyAppliedPaths = executionPaths.filter((p) => p.action === "already_applied");

  // Re-inspect every path (apply + already_applied) on the source filesystem.
  const revalidatedApply: LandingPath[] = [];
  const revalidatedAlreadyApplied: LandingPath[] = [];

  for (const lp of [...applyPaths, ...alreadyAppliedPaths]) {
    let current: { blobId: string; mode: string } | null;
    try {
      current = await inspectSourceFile(resolvedSourceRoot, lp.path, objectHashForOid(freshPlan.baseCommit), signal);
    } catch (err) {
      if (err instanceof Error && (
        err.message.includes("directory") ||
        err.message.includes("special file") ||
        err.message.includes("symbolic link") ||
        err.message.includes("symlink")
      )) {
        return {
          status: "conflicted",
          conflicts: [{ path: lp.path, reason: err.message }],
        };
      }
      throw err;
    }

    // Re-classify.
    if (lp.result === null) {
      // Deletion.
      if (current === null) {
        // Already deleted — no-op.
        revalidatedAlreadyApplied.push(lp);
        continue;
      }
      if (current.blobId !== lp.base!.blobId || current.mode !== lp.base!.mode) {
        return {
          status: "conflicted",
          conflicts: [{
            path: lp.path,
            reason: "File is deleted by the wave but locally modified on source.",
          }],
        };
      }
      revalidatedApply.push(lp);
    } else if (lp.base === null) {
      // Addition.
      if (current !== null) {
        if (current.blobId === lp.result.blobId && current.mode === lp.result.mode) {
          // Already applied.
          revalidatedAlreadyApplied.push(lp);
          continue;
        }
        return {
          status: "conflicted",
          conflicts: [{
            path: lp.path,
            reason: "Newly created path already exists on source filesystem.",
          }],
        };
      }
      revalidatedApply.push(lp);
    } else {
      // Modification.
      if (current === null) {
        return {
          status: "conflicted",
          conflicts: [{
            path: lp.path,
            reason: "File exists in base and result but is absent on source filesystem.",
          }],
        };
      }
      if (current.blobId === lp.result.blobId && current.mode === lp.result.mode) {
        // Already applied.
        revalidatedAlreadyApplied.push(lp);
        continue;
      }
      if (current.blobId !== lp.base.blobId || current.mode !== lp.base.mode) {
        return {
          status: "conflicted",
          conflicts: [{
            path: lp.path,
            reason: "Source state differs from base.",
          }],
        };
      }
      revalidatedApply.push(lp);
    }
  }

  const effectiveApplyPaths = revalidatedApply;
  // Deduplicate already-applied paths by path key.
  const allAlreadyApplied = Array.from(
    new Map(revalidatedAlreadyApplied.map((p) => [p.path, p])).values(),
  );

  // If nothing to apply, return success immediately.
  if (effectiveApplyPaths.length === 0) {
    // Check abort before returning success.
    if (signal?.aborted) {
      throw new Error("Abort signal received during landing");
    }
    return {
      status: "landed",
      appliedPaths: [],
      alreadyAppliedPaths: allAlreadyApplied.map((p) => p.path),
      manifestPath: "",
    };
  }

  // ── Step 4: Materialize integrated blobs into same-directory temp entries ──
  const tx = txId();
  const tempFiles: Map<string, string> = new Map();
  const createdDirs: string[] = [];

  try {
    for (const lp of effectiveApplyPaths) {
      if (lp.result === null) {
        // Deletion: no temp file needed.
        continue;
      }

      const destPath = join(resolvedSourceRoot, lp.path);
      const dir = destPath.substring(0, destPath.lastIndexOf("/"));

      // Create parent directories if needed, tracking only newly-created ones.
      if (dir && dir !== resolvedSourceRoot) {
        const segments = dir.substring(resolvedSourceRoot.length + 1).split("/");
        let accumulated = resolvedSourceRoot;
        for (const seg of segments) {
          accumulated = join(accumulated, seg);
          try {
            await fs.stat(accumulated);
            // Already exists — don't track.
          } catch {
            // Doesn't exist — create and track.
            await fs.mkdir(accumulated, { recursive: false });
            createdDirs.push(accumulated);
          }
        }
      }

      // Generate a unique temp file name using a hash of the path.
      const tempName = `.pi-landing-tmp-${tx}-${artifactKey(lp.path)}`;
      const tempPath = join(dir, tempName);

      if (lp.result.mode === "120000") {
        // Symlink: validate target is confined to source root before creating.
        const blobData = await gitCatFileBlob(repositoryPath, lp.result.blobId!, signal);
        const symlinkTarget = blobData.toString("utf8");
        if (!isSymlinkTargetSafe(symlinkTarget, dir, resolvedSourceRoot)) {
          // Clean up temp files and directories created so far.
          for (const tempPath of tempFiles.values()) {
            await unlinkIfAbsent(tempPath).catch(() => {});
          }
          for (let i = createdDirs.length - 1; i >= 0; i--) {
            try { await fs.rmdir(createdDirs[i]).catch(() => {}); } catch { /* not empty */ }
          }
          return {
            status: "conflicted",
            conflicts: [{
              path: lp.path,
              reason: `Symlink target escapes source root: ${symlinkTarget}`,
            }],
          };
        }
        await fs.symlink(symlinkTarget, tempPath);
      } else {
        // Regular file: materialize blob content with exclusive write.
        const blobData = await gitCatFileBlob(repositoryPath, lp.result.blobId!, signal);
        await fs.writeFile(tempPath, blobData, { flag: "wx" });
        // Set the correct mode.
        if (lp.result.mode === "100755") {
          await fs.chmod(tempPath, 0o755);
        } else {
          await fs.chmod(tempPath, 0o644);
        }
      }

      tempFiles.set(lp.path, tempPath);
    }

    // ── Step 5: Write atomic recovery manifest with authentication ──
    const landingDir = join(waveRoot, "landing");
    await fs.mkdir(landingDir, { recursive: true });

    // Generate a transaction-scoped authentication key stored under landing dir.
    const authKeyHex = await generateAuthKey(landingDir);
    const authKey = Buffer.from(authKeyHex, "hex");

    // Build manifest path entries.
    const manifestPathEntries: RecoveryPathEntry[] = [];
    for (const lp of effectiveApplyPaths) {
      const destPath = join(resolvedSourceRoot, lp.path);
      const tempPath = tempFiles.get(lp.path) || "";
      const backupName = `.pi-backup-${tx}-${artifactKey(lp.path)}`;
      const backup = `${destPath}${backupName}`;
      let originalState: "present" | "absent" | "symlink";

      if (lp.result === null) {
        // Deletion: derive originalState from base mode.
        originalState = lp.base?.mode === "120000" ? "symlink" : "present";
      } else {
        try {
          const stat = await fs.lstat(destPath);
          originalState = stat.isSymbolicLink() ? "symlink" : "present";
        } catch {
          originalState = "absent";
        }
      }

      manifestPathEntries.push({
        path: lp.path,
        destination: destPath,
        temp: tempPath,
        backup: lp.result === null || originalState !== "absent" ? backup : null,
        phase: "planned",
        originalState,
        mode: lp.result?.mode ?? "",
        blobId: lp.result?.blobId ?? "",
        baseBlobId: lp.base?.blobId ?? null,
      });
    }

    const manifest: RecoveryManifest = {
      version: 1,
      timestamp: new Date().toISOString(),
      sourceRoot: resolvedSourceRoot,
      sourceIdentity: capture.sourceIdentity,
      baseCommit,
      integratedCommit: integratedCommitSha,
      integratedRef,
      paths: manifestPathEntries,
      createdDirs: [...createdDirs],
      state: "in_progress",
      authTag: "",
    };

    // Use transaction-scoped manifest path to prevent concurrent executions from overwriting.
    const manifestPath = join(landingDir, `manifest-${tx}.json`);
    await signAndWriteManifest(manifestPath, manifest, authKey);

    // ── Step 6: Apply each path with backups and just-in-time revalidation ──
    // Journal: tracks paths that have been mutated (backup done) for rollback.
    const journal: Array<{ path: string; lp: LandingPath; backupPath: string | null }> = [];
    // Track the current path being processed for accurate failedAtPath diagnostics.
    let activePath: string | null = null;

    try {
      for (const lp of effectiveApplyPaths) {
        // Check abort signal before each path mutation.
        if (signal?.aborted) {
          throw new Error("Abort signal received during landing");
        }
        activePath = lp.path;
        const destPath = join(resolvedSourceRoot, lp.path);

        // Just-in-time state revalidation before mutation.
        let current: { blobId: string; mode: string } | null;
        try {
          current = await inspectSourceFile(resolvedSourceRoot, lp.path, objectHashForOid(freshPlan.baseCommit), signal);
        } catch (err) {
          if (err instanceof Error && (
            err.message.includes("directory") ||
            err.message.includes("special file") ||
            err.message.includes("symbolic link") ||
            err.message.includes("symlink")
          )) {
            throw new Error(`Path drift detected for ${lp.path}: ${err.message}`);
          }
          throw err;
        }

        // Revalidate state matches what we expect.
        if (lp.result === null) {
          if (current === null) continue;
          if (current.blobId !== lp.base!.blobId || current.mode !== lp.base!.mode) {
            throw new Error(`Path drift: ${lp.path} no longer matches base.`);
          }
        } else if (lp.base === null) {
          if (current !== null) {
            if (current.blobId === lp.result.blobId && current.mode === lp.result.mode) continue;
            throw new Error(`Path drift: ${lp.path} now exists with different content.`);
          }
        } else {
          if (current === null) throw new Error(`Path drift: ${lp.path} is now absent.`);
          if (current.blobId !== lp.base.blobId || current.mode !== lp.base.mode) {
            throw new Error(`Path drift: ${lp.path} no longer matches base.`);
          }
        }

        // ── Test seam: inject failure after N paths ──
        if (hooks.failAfterNPaths !== undefined && journal.length >= hooks.failAfterNPaths) {
          throw new Error(`failAfterNPaths: injected failure after ${hooks.failAfterNPaths} paths`);
        }

        // Perform the actual mutation.
        const backupName = `.pi-backup-${tx}-${artifactKey(lp.path)}`;
        const backupPath = `${destPath}${backupName}`;

        if (lp.result === null) {
          // Deletion: backup then remove.
          await fs.rename(destPath, backupPath);
          // Journal immediately after backup rename so rollback knows about this path
          // even if the manifest phase update below fails.
          journal.push({ path: lp.path, lp, backupPath });
          await updateManifestPhase(manifestPath, lp.path, "backup_created", authKey);
        } else if (lp.result.mode === "120000") {
          // Symlink: backup existing (if any), then rename temp symlink into place.
          if (current !== null) {
            await fs.rename(destPath, backupPath);
            // Journal immediately after backup rename so rollback knows about this path
            // even if the manifest phase update below fails.
            journal.push({ path: lp.path, lp, backupPath });
            await updateManifestPhase(manifestPath, lp.path, "backup_created", authKey);
          } else {
            // Addition: journal before the replacement rename.
            journal.push({ path: lp.path, lp, backupPath: null });
          }

          // ── Test seam: inject failure after backup rename ──
          if (hooks.failAfterBackupOf === lp.path) {
            throw new Error(`failAfterBackupOf: injected failure after backup of ${lp.path}`);
          }

          const tempPath = tempFiles.get(lp.path);
          if (tempPath) {
            await fs.rename(tempPath, destPath);
            await updateManifestPhase(manifestPath, lp.path, "replacement_installed", authKey);
          }
        } else {
          // Regular file: backup existing (if any), then rename temp into place.
          if (current !== null) {
            await fs.rename(destPath, backupPath);
            // Journal immediately after backup rename so rollback knows about this path
            // even if the manifest phase update below fails.
            journal.push({ path: lp.path, lp, backupPath });
            await updateManifestPhase(manifestPath, lp.path, "backup_created", authKey);
          } else {
            // Addition: journal before the replacement rename.
            journal.push({ path: lp.path, lp, backupPath: null });
          }

          // ── Test seam: inject failure after backup rename ──
          if (hooks.failAfterBackupOf === lp.path) {
            throw new Error(`failAfterBackupOf: injected failure after backup of ${lp.path}`);
          }

          const tempPath = tempFiles.get(lp.path);
          if (tempPath) {
            await fs.rename(tempPath, destPath);
            await updateManifestPhase(manifestPath, lp.path, "replacement_installed", authKey);
          }
        }

        // ── Test seam: simulate concurrent modification after apply ──
        if (hooks.afterApplyPath !== undefined) {
          await hooks.afterApplyPath(lp.path, destPath);
        }

        // ── Check abort signal after each applied-path callback ──
        if (signal?.aborted) {
          throw new Error("Abort signal received during landing");
        }
      }
      // Clear activePath so a post-loop manifest-write failure is not attributed to the last path.
      activePath = null;

      // ── Abort check immediately before marking landing completed ──
      if (signal?.aborted) {
        throw new Error("Abort signal received during landing");
      }

      // ── Step 7: Success — mark completed BEFORE cleanup ──
      // Mark manifest as completed (atomically) while backups still exist.
      // This ensures a crash never leaves an "in_progress" manifest without backups.
      const completedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      completedManifest.state = "completed";
      await signAndWriteManifest(manifestPath, completedManifest, authKey);

      // Strict cleanup after durable completion.
      try {
        // Remove backup files.
        for (const entry of journal) {
          if (entry.backupPath) {
            await unlinkIfAbsent(entry.backupPath);
          }
        }

        // Remove any remaining temp files.
        for (const tempPath of tempFiles.values()) {
          await unlinkIfAbsent(tempPath);
        }

        // Clean up empty created directories (in reverse order).
        for (let i = createdDirs.length - 1; i >= 0; i--) {
          try {
            await fs.rmdir(createdDirs[i]).catch(() => {});
          } catch {
            // Not empty — leave it.
          }
        }
      } catch (cleanupErr) {
        // Cleanup failed after completion — manifest is durable, return landed.
        // The cleanup artifacts are harmless leftovers.
      }

      return {
        status: "landed",
        appliedPaths: journal.map((e) => e.path),
        alreadyAppliedPaths: allAlreadyApplied.map((p) => p.path),
        manifestPath,
      };
    } catch (err) {
      // ── Step 8: Safe rollback on failure ──
      const failureReason = err instanceof Error ? err.message : String(err);
      const failedAtPath = activePath;

      try {
        // Read the current manifest to get per-path phases.
        const manifestData = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        const phaseMap = new Map(manifestData.paths.map((e: RecoveryPathEntry) => [e.path, e.phase]));

        // Rollback in reverse journal order.
        // For each path, inspect the destination before restoring:
        // - If the phase is "replacement_installed", the transaction set this destination — restore it.
        // - If the phase is "backup_created" or "planned", the transaction did NOT set this destination.
        //   Check if it matches the transaction result (concurrent coincidence) or differs (concurrent mod).
        // - If changed concurrently (phase not replacement_installed and dest differs from result) →
        //   stop rollback, preserve everything, mark recovery_required.
        for (let i = journal.length - 1; i >= 0; i--) {
          const entry = journal[i];
          const destPath = join(resolvedSourceRoot, entry.path);
          const currentPhase = phaseMap.get(entry.path) ?? "planned";

          // Inspect the current destination state.
          let currentDest: { blobId: string; mode: string } | null;
          try {
            currentDest = await inspectSourceFile(resolvedSourceRoot, entry.path, objectHashForOid(plan.baseCommit));
          } catch (inspectErr) {
            const inspectErrNode = inspectErr as NodeJS.ErrnoException;
            if (inspectErrNode?.code === "ENOENT") {
              currentDest = null;
            } else {
              // Unexpected inspection error — treat as concurrent modification.
              throw new Error(`Rollback inspection failed for ${entry.path}: ${inspectErrNode?.message ?? String(inspectErr)}`);
            }
          }

          if (entry.lp.result === null) {
            // Deletion: restore from backup.
            if (entry.backupPath) {
              // Destination should be absent (we deleted it). If present, it's concurrent.
              if (currentDest !== null) {
                // Concurrent modification: destination was recreated after our deletion.
                throw new Error(
                  `Concurrent modification detected during rollback: ${entry.path} was deleted by ` +
                  `this transaction but now exists with different content. Preserving all artifacts.`,
                );
              }
              await fs.rename(entry.backupPath, destPath);
            }
          } else if (currentPhase === "replacement_installed") {
            // The transaction successfully installed the replacement.
            // Check if the destination still matches what we installed.
            const destMatchesResult =
              currentDest !== null &&
              currentDest.blobId === entry.lp.result!.blobId &&
              currentDest.mode === entry.lp.result!.mode;

            if (currentDest === null) {
              // Destination absent — safe: restore backup or leave absent.
              if (entry.backupPath) {
                await fs.rename(entry.backupPath, destPath);
              }
              // Addition with no backup: already absent, nothing to do.
            } else if (destMatchesResult) {
              // Destination still matches our installed content — safe to restore.
              if (entry.backupPath) {
                await unlinkIfAbsent(destPath);
                await fs.rename(entry.backupPath, destPath);
              } else {
                // Addition: remove the installed file.
                await unlinkIfAbsent(destPath);
              }
            } else {
              // Destination was modified after we installed it — concurrent modification.
              throw new Error(
                `Concurrent modification detected during rollback: ${entry.path} was modified ` +
                `after the transaction installed it. Preserving all artifacts.`,
              );
            }
          } else {
            // Phase is "backup_created" or "planned" — the transaction may or may not have
            // installed the replacement (phase update could have failed after the rename).
            // Use artifact presence to disambiguate:
            // - If backup exists and destination matches result → phase update likely failed after
            //   the replacement rename; restore from backup.
            // - If backup exists and destination differs from result → concurrent modification.
            // - If no backup (addition) and destination matches result → phase update likely failed;
            //   remove the installed file.
            // - If no backup and destination differs → concurrent modification.
            if (entry.backupPath) {
              const destMatchesResult =
                currentDest !== null &&
                currentDest.blobId === entry.lp.result!.blobId &&
                currentDest.mode === entry.lp.result!.mode;

              if (currentDest === null) {
                // Destination absent — safe to restore from backup.
                await fs.rename(entry.backupPath, destPath);
              } else if (destMatchesResult) {
                // Backup exists and destination matches result → phase update likely failed after
                // the replacement rename. Restore from backup to undo the transaction.
                await unlinkIfAbsent(destPath);
                await fs.rename(entry.backupPath, destPath);
              } else {
                // Destination differs from transaction result — concurrent modification.
                throw new Error(
                  `Concurrent modification detected during rollback: ${entry.path} differs from ` +
                  `the transaction's integrated result. Preserving all artifacts.`,
                );
              }
            } else {
              // No backup (addition). Check if destination matches result.
              const destMatchesResult =
                currentDest !== null &&
                currentDest.blobId === entry.lp.result!.blobId &&
                currentDest.mode === entry.lp.result!.mode;

              if (currentDest === null) {
                // Already absent — nothing to do.
              } else if (destMatchesResult) {
                // Phase update likely failed after the addition rename. Remove the installed file.
                await unlinkIfAbsent(destPath);
              } else {
                // Concurrent modification on an addition.
                throw new Error(
                  `Concurrent modification detected during rollback: ${entry.path} (addition) ` +
                  `differs from the transaction's integrated result. Preserving all artifacts.`,
                );
              }
            }
          }

          // Update manifest phase to rolled_back.
          await updateManifestPhase(manifestPath, entry.path, "rolled_back", authKey);
        }

        // Remove staged temp files.
        for (const tempPath of tempFiles.values()) {
          await unlinkIfAbsent(tempPath);
        }

        // Remove empty created directories (in reverse order).
        for (let i = createdDirs.length - 1; i >= 0; i--) {
          try {
            await fs.rmdir(createdDirs[i]).catch(() => {});
          } catch {
            // Not empty — leave it.
          }
        }

        // Mark manifest as rolled_back (atomically).
        const rolledBackManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        rolledBackManifest.state = "rolled_back";
        await signAndWriteManifest(manifestPath, rolledBackManifest, authKey);

        return {
          status: "rolled_back",
          appliedPaths: journal.map((e) => e.path),
          failedAtPath,
          failureReason,
        };
      } catch (rollbackErr) {
        // Rollback failed — preserve artifacts and return recovery_required.
        const rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);

        // Mark manifest as recovery_required (atomically).
        try {
          const recoveryManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
          recoveryManifest.state = "recovery_required";
          await signAndWriteManifest(manifestPath, recoveryManifest, authKey);
        } catch {
          // Can't update manifest — artifacts are preserved.
        }

        return {
          status: "recovery_required",
          diagnostics: {
            appliedPaths: journal.map((e) => e.path),
            failedAtPath,
            failureReason,
            rollbackError,
            manifestPath,
          },
        };
      }
    }
  } catch (err) {
    // Pre-apply failure (e.g., blob materialization failed).
    // Clean up any temps and dirs we created.
    const failureReason = err instanceof Error ? err.message : String(err);
    for (const tempPath of tempFiles.values()) {
      await unlinkIfAbsent(tempPath).catch(() => {});
    }
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      try {
        await fs.rmdir(createdDirs[i]).catch(() => {});
      } catch {
        // Not empty.
      }
    }
    return {
      status: "rolled_back",
      appliedPaths: [],
      failedAtPath: null,
      failureReason,
    };
  }
}

/**
 * Read a blob's raw content from the Git repository.
 */
async function gitCatFileBlob(
  repoPath: string,
  blobId: string,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "-p", blobId], {
      cwd: repoPath,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
      signal: abortSignal,
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", () => {}); // ignore stderr
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0 || signal) {
        reject(new Error(`git cat-file failed for blob ${blobId} with code ${code} signal ${signal}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

// ── symlink safety ───────────────────────────────────────────────────────────

/**
 * Check that a symlink target resolves within the allowed root.
 * Rejects absolute targets and targets that escape via .. traversal.
 */
function isSymlinkTargetSafe(target: string, linkDir: string, allowedRoot: string): boolean {
  // Reject absolute symlink targets.
  if (isAbsolute(target)) {
    return false;
  }
  // Resolve the target relative to the directory containing the symlink.
  const resolved = join(linkDir, target);
  // Normalize and check it stays within the allowed root.
  const normalized = resolved.replace(/\/+/g, "/");
  const root = allowedRoot.replace(/\/+/g, "/");
  return normalized.startsWith(root + "/") || normalized === root;
}

// ── crash recovery entrypoint ────────────────────────────────────────────────

/**
 * Recover a landing manifest after process death.
 *
 * This is a public entrypoint for post-crash recovery. Given a manifest path
 * under `<waveRoot>/landing`, it safely recovers an `in_progress` or
 * `recovery_required` transaction. For `completed` manifests it cleans stale
 * backups/temps. For `rolled_back` manifests it cleans stale temps only.
 *
 * Safety guarantees:
 * - Revalidates manifest structure/version before any mutation.
 * - Verifies source root identity (dev+ino) matches the manifest.
 * - Confirms every destination/temp/backup path is confined to source root.
 * - For each path in reverse order, infers state from manifest phase plus
 *   artifact presence and exact blob/mode comparison.
 * - Restores the original backup only when destination is absent or still
 *   exactly transaction-owned. Never overwrites a concurrent user change.
 * - On ambiguity, preserves all artifacts, atomically marks recovery_required,
 *   and returns diagnostics.
 * - Handles additions, modifications, deletions, regular/binary/executable
 *   files, and symlinks.
 * - Never invokes source Git mutation/staging commands.
 * - Atomically journals per-path recovery phases and final state.
 * - Removes only transaction-created empty directories.
 *
 * @param manifestPath - Absolute path to the recovery manifest JSON file.
 * @returns RecoveryResult describing what was done and what remains.
 */
export async function recoverLandingManifest(
  manifestPath: string,
): Promise<RecoveryResult> {
  // ── Step 1: Read and validate manifest structure ──
  let manifest: RecoveryManifest;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);

    // Validate version.
    if (parsed.version !== 1) {
      return {
        status: "rejected",
        reason: `Unsupported manifest version: ${parsed.version}. Only version 1 is supported.`,
        manifestPath,
      };
    }

    // Validate required fields.
    if (!parsed.sourceRoot || !parsed.baseCommit || !parsed.integratedCommit || !parsed.integratedRef) {
      return {
        status: "rejected",
        reason: "Manifest is missing required fields (sourceRoot, baseCommit, integratedCommit, integratedRef).",
        manifestPath,
      };
    }

    // Validate sourceIdentity.
    if (!parsed.sourceIdentity || typeof parsed.sourceIdentity.dev !== "number" || typeof parsed.sourceIdentity.ino !== "number") {
      return {
        status: "rejected",
        reason: "Manifest is missing or has invalid sourceIdentity (dev/ino).",
        manifestPath,
      };
    }

    // Validate paths array.
    if (!Array.isArray(parsed.paths) || parsed.paths.length === 0) {
      return {
        status: "rejected",
        reason: "Manifest has no paths to recover.",
        manifestPath,
      };
    }

    // Validate each path entry.
    const VALID_PHASES = ["planned", "backup_created", "replacement_installed", "rolled_back", "cleanup"];
    for (const entry of parsed.paths) {
      if (!entry.path || !entry.destination || !entry.phase) {
        return {
          status: "rejected",
          reason: `Manifest has invalid path entry: missing path, destination, or phase.`,
          manifestPath,
        };
      }
      // Validate path safety.
      try {
        validatePathSafe(entry.path);
      } catch (err) {
        return {
          status: "rejected",
          reason: `Manifest has unsafe path: ${(err as Error).message}`,
          manifestPath,
        };
      }
      // Validate phase is a known value.
      if (!VALID_PHASES.includes(entry.phase)) {
        return {
          status: "rejected",
          reason: `Manifest has invalid phase: ${entry.phase}`,
          manifestPath,
        };
      }
    }

    // Validate manifest state is a known value.
    const VALID_STATES = ["in_progress", "completed", "rolled_back", "recovery_required"];
    if (!VALID_STATES.includes(parsed.state)) {
      return {
        status: "rejected",
        reason: `Manifest has invalid state: ${parsed.state}`,
        manifestPath,
      };
    }

    manifest = parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        status: "rejected",
        reason: `Manifest is malformed JSON: ${err.message}`,
        manifestPath,
      };
    }
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      return {
        status: "rejected",
        reason: `Manifest not found: ${manifestPath}`,
        manifestPath,
      };
    }
    throw err;
  }

  // ── Step 1.5: Verify controller authentication (HMAC-SHA256) ──
  // The auth key is stored in the landing directory (parent of manifest).
  const landingDir = manifestPath.substring(0, manifestPath.lastIndexOf("/"));
  const authKey = await readAuthKey(landingDir);
  if (!authKey) {
    return {
      status: "rejected",
      reason: "Missing authentication key; manifest cannot be verified.",
      manifestPath,
    };
  }
  if (!manifest.authTag || !verifyAuthTag(authKey, manifest)) {
    return {
      status: "rejected",
      reason: "Authentication tag mismatch; manifest is not from a trusted controller.",
      manifestPath,
    };
  }

  // ── Step 2: Verify source root identity (dev+ino) ──
  const resolvedSourceRoot = await fs.realpath(manifest.sourceRoot).catch(() => null);
  if (!resolvedSourceRoot) {
    return {
      status: "rejected",
      reason: `Source root does not exist: ${manifest.sourceRoot}`,
      manifestPath,
    };
  }

  const currentRootStat = await fs.stat(resolvedSourceRoot).catch(() => null);
  if (!currentRootStat) {
    return {
      status: "rejected",
      reason: `Cannot stat source root: ${manifest.sourceRoot}`,
      manifestPath,
    };
  }

  if (currentRootStat.dev !== manifest.sourceIdentity.dev || currentRootStat.ino !== manifest.sourceIdentity.ino) {
    return {
      status: "rejected",
      reason: `Source root identity mismatch: current dev=${currentRootStat.dev},ino=${currentRootStat.ino} ` +
        `does not match manifest dev=${manifest.sourceIdentity.dev},ino=${manifest.sourceIdentity.ino}.`,
      manifestPath,
    };
  }

  // ── Step 3: Validate path confinement and consistency ──
  // Every destination, temp, and backup path must be confined to source root.
  // Destination must match join(sourceRoot, path) to prevent path redirection.
  for (const entry of manifest.paths) {
    // Validate destination matches the expected path.
    const expectedDest = join(resolvedSourceRoot, entry.path);
    if (entry.destination !== expectedDest) {
      return {
        status: "rejected",
        reason: `Manifest destination does not match path: expected ${expectedDest}, got ${entry.destination}`,
        manifestPath,
      };
    }

    const checkConfinement = (path: string, label: string) => {
      if (!path) return;
      if (!isAbsolute(path)) {
        throw new Error(`${label} is not absolute: ${path}`);
      }
      // Normalize with resolve() to collapse ".." and "." segments before the prefix check.
      const normalized = resolve(path);
      if (!normalized.startsWith(resolvedSourceRoot + sep) && normalized !== resolvedSourceRoot) {
        throw new Error(`${label} escapes source root: ${path}`);
      }
    };

    try {
      checkConfinement(entry.destination, `Destination for ${entry.path}`);
      if (entry.temp) checkConfinement(entry.temp, `Temp for ${entry.path}`);
      if (entry.backup) checkConfinement(entry.backup, `Backup for ${entry.path}`);
    } catch (err) {
      return {
        status: "rejected",
        reason: `Path confinement violation: ${(err as Error).message}`,
        manifestPath,
      };
    }
  }

  // ── Step 3.5: Strict transaction artifact validation ──
  // Derive the transaction ID from the manifest filename and validate that
  // every temp/backup path is exactly the controller-generated path for that
  // entry. Reject before mutation if any differs.
  const manifestBasename = manifestPath.substring(manifestPath.lastIndexOf(sep) + 1);
  const txMatch = manifestBasename.match(/^manifest-([0-9a-zA-Z-]+)\.json$/);
  if (!txMatch) {
    return {
      status: "rejected",
      reason: `Manifest filename does not match expected format manifest-<tx>.json: ${manifestBasename}`,
      manifestPath,
    };
  }
  const txId = txMatch[1];

  for (const entry of manifest.paths) {
    const ak = artifactKey(entry.path);
    const destPath = entry.destination;

    // Validate temp path: must be exactly the controller-generated path or empty/null.
    if (entry.temp) {
      const expectedTemp = join(destPath.substring(0, destPath.lastIndexOf("/")), `.pi-landing-tmp-${txId}-${ak}`);
      if (entry.temp !== expectedTemp) {
        return {
          status: "rejected",
          reason: `Manifest temp path does not match expected transaction artifact: expected ${expectedTemp}, got ${entry.temp}`,
          manifestPath,
        };
      }
    }

    // Validate backup path: must be exactly the controller-generated path or null/empty.
    if (entry.backup) {
      const expectedBackup = `${destPath}.pi-backup-${txId}-${ak}`;
      if (entry.backup !== expectedBackup) {
        return {
          status: "rejected",
          reason: `Manifest backup path does not match expected transaction artifact: expected ${expectedBackup}, got ${entry.backup}`,
          manifestPath,
        };
      }
    }
  }

  // ── Step 4: Handle terminal states ──
  if (manifest.state === "completed") {
    // Clean stale backups/temps after verifying transaction completion.
    return await cleanupCompletedManifest(manifest, manifestPath);
  }
  if (manifest.state === "rolled_back") {
    // Clean stale temps only — never delete user files.
    return await cleanupRolledBackManifest(manifest, manifestPath);
  }

  // ── Step 5: Recover in_progress or recovery_required ──
  // Process paths in reverse order (last mutated first).
  const pathDetails: RecoveryPathDetail[] = [];
  const restoredPaths: string[] = [];
  let manualRequired = false;
  const manualReasons: string[] = [];

  // Build a phase map from the manifest.
  const phaseMap = new Map(manifest.paths.map((e) => [e.path, e.phase]));

  for (let i = manifest.paths.length - 1; i >= 0; i--) {
    const entry = manifest.paths[i];
    const currentPhase = phaseMap.get(entry.path) ?? "planned";
    const destPath = entry.destination;
    const backupPath = entry.backup;
    const tempPath = entry.temp;

    try {
      const detail = await recoverSinglePath(
        entry, currentPhase, destPath, backupPath, tempPath,
        resolvedSourceRoot,
      );
      pathDetails.push(detail);

      if (detail.action === "restored") {
        restoredPaths.push(entry.path);
      } else if (detail.action === "preserved") {
        manualRequired = true;
        manualReasons.push(`${entry.path}: ${detail.reason}`);
      }

      // Update the manifest phase to reflect recovery.
      if (detail.action === "restored") {
        await updateManifestPhase(manifestPath, entry.path, "rolled_back", authKey);
      }
    } catch (err) {
      manualRequired = true;
      manualReasons.push(`${entry.path}: error during recovery: ${(err as Error).message}`);
      pathDetails.push({
        path: entry.path,
        action: "preserved",
        reason: `Error during recovery: ${(err as Error).message}`,
      });
    }
  }

  // ── Step 6: Clean up temp files ──
  // When manual recovery is required, preserve ALL artifacts (temps, dirs)
  // for diagnosis. Only clean exact validated temps when recovery fully succeeds.
  // Never remove manifest.createdDirs: the manifest is untrusted and there is
  // no durable proof an empty directory was transaction-created.
  const cleanedPaths: string[] = [];
  if (!manualRequired) {
    for (const entry of manifest.paths) {
      if (entry.temp) {
        try {
          await unlinkIfAbsent(entry.temp);
          cleanedPaths.push(entry.path);
        } catch {
          // Temp file already gone — ignore.
        }
      }
    }
  }

  // ── Step 7: Finalize manifest state ──
  if (manualRequired) {
    // Mark as recovery_required and return diagnostics.
    try {
      const currentManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      currentManifest.state = "recovery_required";
      await signAndWriteManifest(manifestPath, currentManifest, authKey);
    } catch {
      // Can't update manifest — artifacts are preserved.
    }

    const summary = [
      `Manual recovery required for ${manualReasons.length} path(s):`,
      ...manualReasons.map((r) => `  - ${r}`),
      `\nRemaining artifacts:`,
      ...pathDetails.filter((d) => d.backupRemaining || d.tempRemaining).map((d) => {
        const parts: string[] = [];
        if (d.backupRemaining) parts.push(`backup: ${d.backupRemaining}`);
        if (d.tempRemaining) parts.push(`temp: ${d.tempRemaining}`);
        return `  - ${d.path}: ${parts.join(", ")}`;
      }),
    ].join("\n");

    return {
      status: "manual_required",
      pathDetails,
      manifestPath,
      summary,
    };
  }

  // All paths recovered successfully — mark manifest as rolled_back.
  try {
    const currentManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    currentManifest.state = "rolled_back";
    await signAndWriteManifest(manifestPath, currentManifest, authKey);
  } catch {
    // Can't update manifest — artifacts are preserved.
  }

  return {
    status: "recovered",
    restoredPaths,
    cleanedPaths,
    manifestPath,
  };
}

/**
 * Recover a single path from a manifest entry.
 */
async function recoverSinglePath(
  entry: RecoveryPathEntry,
  currentPhase: string,
  destPath: string,
  backupPath: string | null,
  tempPath: string,
  resolvedSourceRoot: string,
): Promise<RecoveryPathDetail> {
  // Deletions have no result blob. Inspect an existing destination using the
  // base object's hash format so recovery can determine whether deletion had
  // happened before the crash.
  const isDeletion = !entry.blobId;
  const comparisonOid = isDeletion ? entry.baseBlobId : entry.blobId;
  if (!comparisonOid) {
    throw new Error(`Recovery entry for "${entry.path}" has no blob ID for filesystem comparison.`);
  }

  // Inspect current destination state.
  let currentDest: { blobId: string; mode: string } | null;
  try {
    currentDest = await inspectSourceFile(resolvedSourceRoot, entry.path, objectHashForOid(comparisonOid));
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      currentDest = null;
    } else {
      throw err;
    }
  }

  // Check if backup exists.
  let backupExists = false;
  if (backupPath) {
    try {
      await fs.stat(backupPath);
      backupExists = true;
    } catch {
      backupExists = false;
    }
  }

  // Check if temp exists.
  let tempExists = false;
  if (tempPath) {
    try {
      await fs.stat(tempPath);
      tempExists = true;
    } catch {
      tempExists = false;
    }
  }

  // ── Deletion case: the wave wanted to delete the file ──
  // For crash recovery, we UNDO the transaction, not complete it.
  // Disambiguate by backup presence and base blobId match (not mode, which is "" for deletions).
  if (isDeletion) {
    if (currentDest !== null) {
      // Destination exists.
      if (backupExists && backupPath) {
        // Backup exists — check if destination matches base (deletion not performed)
        // or differs (concurrent recreation after deletion).
        const destMatchesBase =
          entry.baseBlobId &&
          currentDest.blobId === entry.baseBlobId;

        if (destMatchesBase) {
          // Destination has original content — deletion was never performed.
          // Clean up the stale backup.
          await fs.unlink(backupPath);
          return {
            path: entry.path,
            action: "cleaned",
            reason: "Deletion was not performed; cleaned stale backup.",
          };
        }
        // Destination differs from base — concurrent recreation after deletion.
        return {
          path: entry.path,
          action: "preserved",
          reason: "Concurrent modification: destination recreated after deletion backup.",
          backupRemaining: backupPath,
        };
      }
      // No backup — the deletion was never performed. Leave the file alone.
      return {
        path: entry.path,
        action: "skipped",
        reason: "Deletion was not performed; destination still has original content.",
      };
    } else {
      // Destination absent — deletion was performed.
      // For crash recovery, undo the deletion by restoring from backup.
      if (backupExists && backupPath) {
        await fs.rename(backupPath, destPath);
        return {
          path: entry.path,
          action: "restored",
          reason: "Deletion was performed; restored from backup to undo.",
        };
      }
      return {
        path: entry.path,
        action: "skipped",
        reason: "Deletion was already successful.",
      };
    }
  }

  // ── Modification/Addition case ──
  // Check if destination matches the transaction result.
  const destMatchesResult =
    currentDest !== null &&
    currentDest.blobId === entry.blobId &&
    currentDest.mode === entry.mode;

  if (currentPhase === "replacement_installed") {
    // The transaction successfully installed the replacement.
    if (currentDest === null) {
      // Destination absent — restore from backup if available.
      if (backupExists && backupPath) {
        await fs.rename(backupPath, destPath);
        return {
          path: entry.path,
          action: "restored",
          reason: "Destination absent after replacement_installed; restored from backup.",
        };
      }
      // Addition with no backup — destination absent is correct.
      return {
        path: entry.path,
        action: "skipped",
        reason: "Addition: destination absent, no backup to restore.",
      };
    } else if (destMatchesResult) {
      // Destination still matches our installed content — safe to restore.
      if (backupExists && backupPath) {
        await fs.unlink(destPath);
        await fs.rename(backupPath, destPath);
        return {
          path: entry.path,
          action: "restored",
          reason: "Destination matches transaction result; restored from backup.",
        };
      }
      // Addition: remove the installed file.
      await fs.unlink(destPath);
      return {
        path: entry.path,
        action: "restored",
        reason: "Addition: removed transaction-installed file.",
      };
    } else {
      // Destination was modified after we installed it — concurrent modification.
      return {
        path: entry.path,
        action: "preserved",
        reason: "Concurrent modification: destination differs from transaction result. Preserving both.",
        backupRemaining: backupExists && backupPath ? backupPath : undefined,
      };
    }
  } else if (currentPhase === "backup_created") {
    // Backup was created but replacement was not installed.
    if (backupExists && backupPath) {
      if (currentDest === null) {
        // Destination absent — restore from backup.
        await fs.rename(backupPath, destPath);
        return {
          path: entry.path,
          action: "restored",
          reason: "Destination absent after backup_created; restored from backup.",
        };
      } else if (destMatchesResult) {
        // Destination matches result — phase update likely failed after rename.
        // Restore from backup to undo the transaction.
        await fs.unlink(destPath);
        await fs.rename(backupPath, destPath);
        return {
          path: entry.path,
          action: "restored",
          reason: "Phase update likely failed after replacement; restored from backup.",
        };
      } else {
        // Check if destination matches base (original content).
        // Compare content only — entry.mode is the result mode, not the base mode.
        // For mode-change transactions (e.g. 100644→100755), the destination still
        // has the base mode, so comparing against entry.mode would misclassify.
        const destMatchesBase =
          entry.baseBlobId !== null &&
          currentDest.blobId === entry.baseBlobId;

        if (destMatchesBase) {
          // Destination still has original content — transaction didn't mutate it.
          // Clean up the stale backup.
          await fs.unlink(backupPath);
          return {
            path: entry.path,
            action: "cleaned",
            reason: "Destination matches base; cleaned stale backup.",
          };
        }
        // Destination differs from both base and result — concurrent modification.
        return {
          path: entry.path,
          action: "preserved",
          reason: "Concurrent modification: destination differs from both base and result. Preserving both.",
          backupRemaining: backupPath,
        };
      }
    }
    // No backup — nothing to restore.
    return {
      path: entry.path,
      action: "skipped",
      reason: "No backup available for backup_created phase.",
    };
  } else {
    // Phase is "planned" — no mutations were performed per the manifest,
    // but the backup rename may have happened before the phase update.
    if (backupExists && backupPath && currentDest === null) {
      // Backup exists and destination absent — restore from backup.
      await fs.rename(backupPath, destPath);
      return {
        path: entry.path,
        action: "restored",
        reason: "Backup exists and destination absent; restored from backup.",
      };
    }
    if (tempExists && tempPath) {
      // Temp exists — clean it up.
      await fs.unlink(tempPath);
      return {
        path: entry.path,
        action: "cleaned",
        reason: "Cleaned stale temp file from planned phase.",
      };
    }
    // Detect addition killed after temp→destination rename while phase still planned.
    // Gate on the controller's addition signature (originalState === "absent" && baseBlobId === null)
    // to prevent a crafted manifest from deleting arbitrary in-root files.
    if (entry.originalState === "absent" && entry.baseBlobId === null && destMatchesResult && !backupExists && !tempExists) {
      // This is a transaction-owned addition — remove it.
      await fs.unlink(destPath);
      return {
        path: entry.path,
        action: "cleaned",
        reason: "Planned-phase addition detected after rename; removed transaction-owned file.",
      };
    }
    return {
      path: entry.path,
      action: "skipped",
      reason: "No mutations performed (planned phase).",
    };
  }
}

/**
 * Clean up stale backups and temps for a completed manifest.
 * Only removes transaction-created artifacts — never touches landed files.
 */
async function cleanupCompletedManifest(
  manifest: RecoveryManifest,
  manifestPath: string,
): Promise<RecoveryResultTerminal> {
  const cleanedPaths: string[] = [];

  // Remove backup files.
  for (const entry of manifest.paths) {
    if (entry.backup) {
      try {
        await unlinkIfAbsent(entry.backup);
        cleanedPaths.push(entry.path);
      } catch {
        // Backup already gone — ignore.
      }
    }
    if (entry.temp) {
      try {
        await unlinkIfAbsent(entry.temp);
        if (!cleanedPaths.includes(entry.path)) {
          cleanedPaths.push(entry.path);
        }
      } catch {
        // Temp already gone — ignore.
      }
    }
  }

  // Do NOT remove manifest.createdDirs: the manifest is untrusted and there is
  // no durable proof an empty directory was transaction-created. Harmless empty
  // directories may remain.

  return {
    status: "terminal",
    state: "completed",
    cleanedPaths,
    manifestPath,
  };
}

/**
 * Clean up stale temps for a rolled_back manifest.
 * Never deletes user files — only transaction-created temps.
 */
async function cleanupRolledBackManifest(
  manifest: RecoveryManifest,
  manifestPath: string,
): Promise<RecoveryResultTerminal> {
  const cleanedPaths: string[] = [];

  // Remove temp files only — never backups (those are original user content).
  for (const entry of manifest.paths) {
    if (entry.temp) {
      try {
        await unlinkIfAbsent(entry.temp);
        cleanedPaths.push(entry.path);
      } catch {
        // Temp already gone — ignore.
      }
    }
  }

  // Do NOT remove manifest.createdDirs: the manifest is untrusted and there is
  // no durable proof an empty directory was transaction-created. Harmless empty
  // directories may remain.

  return {
    status: "terminal",
    state: "rolled_back",
    cleanedPaths,
    manifestPath,
  };
}

// ── test-safe manifest writer ────────────────────────────────────────────────

/**
 * TEST-ONLY: Create a properly signed recovery manifest for testing.
 * This is the only safe way for tests to create manifests that will be
 * accepted by recoverLandingManifest. It generates a real auth key and
 * HMAC-SHA256 tag.
 *
 * @param landingDir - The landing directory where the manifest and auth key are stored.
 * @param manifest - The manifest data (without authTag).
 * @param txId - Optional transaction ID for the manifest filename. Generated if omitted.
 * @returns The manifest path and auth key buffer.
 */
export async function createTestSignedManifest(
  landingDir: string,
  manifest: Omit<RecoveryManifest, "authTag">,
  txId?: string,
): Promise<{ manifestPath: string; authKey: Buffer }> {
  const tx = txId ?? randomUUID();
  const authKey = await generateAuthKey(landingDir);
  const authKeyBuffer = Buffer.from(authKey, "hex");
  const signedManifest: RecoveryManifest = {
    ...manifest,
    authTag: computeAuthTag(authKeyBuffer, { ...manifest, authTag: "" }),
  };
  const manifestPath = join(landingDir, `manifest-${tx}.json`);
  await atomicWriteJson(manifestPath, signedManifest);
  return { manifestPath, authKey: authKeyBuffer };
}
