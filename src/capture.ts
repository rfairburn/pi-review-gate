import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readlink, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotOptions {
  maxFileBytes: number;
  maxSnapshotBytes: number;
  signal?: AbortSignal;
  /** Reuse content and hashes only when stable filesystem identity is unchanged. */
  reuseUnchangedFrom?: WorkspaceSnapshot;
  /** Explicit opt-in for retaining contents of paths outside cwd. */
  captureOutsideWorkspaceContent?: boolean;
  /** @internal Deterministic capture fault seam for regression tests. */
  captureFaults?: SnapshotCaptureFaultHooks;
}

export interface SnapshotCaptureFaultHooks {
  beforeInspectFile?: (entry: { relativePath: string; absolutePath: string }) => void | Promise<void>;
}

export type SnapshotOmissionReason = "missing" | "unreadable";
export type SnapshotOmissionKind = "file" | "directory";

/**
 * Typed, bounded record of an entry that could not be captured. "missing"
 * means the entry vanished during capture (ENOENT/ENOTDIR); "unreadable"
 * means the entry could not be read at capture time (EACCES/EPERM/ELOOP or a
 * similar concurrent/transient filesystem failure) and therefore may still
 * exist. Keeping the two apart prevents unreadable existing paths from being
 * misrepresented as deletions in later comparisons.
 */
export interface SnapshotOmission {
  /** Workspace-relative path (forward slashes; "." for the capture root itself). */
  path: string;
  kind: SnapshotOmissionKind;
  reason: SnapshotOmissionReason;
  /** Truncated errno code (e.g. "ENOENT") when one was available. */
  errorCode?: string;
}

export interface FilesystemDiscovery {
  paths: string[];
  omissions: SnapshotOmission[];
  omissionsTruncated: boolean;
}

/**
 * Map any thrown value to its capture omission reason. Deterministic and
 * unit-tested: only ENOENT/ENOTDIR count as "missing"; every other failure
 * (EACCES, EPERM, ELOOP, EIO, unknown codes, non-error values) is treated as
 * "unreadable" so existing paths are never assumed deleted.
 */
export function fsFaultReason(cause: unknown): "missing" | "unreadable" {
  const code = fsFaultCode(cause);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return "unreadable";
}

/** Extract a filesystem errno code from any thrown value shape. */
export function fsFaultCode(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

/** Cap on omission records so a mass concurrent deletion cannot grow memory without bound. */
export const MAX_SNAPSHOT_OMISSIONS = 1000;
const MAX_ERROR_CODE_LENGTH = 40;

export interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
  mode?: number;
  entryType?: "file" | "symlink" | "gitlink";
  linkTarget?: string;
  gitObjectId?: string;
  sha256: string | null;
  isBinary: boolean;
  content?: string;
  omittedReason?: "binary" | "oversized" | "snapshot_limit" | "outside_workspace" | "missing" | "unreadable";
}

export interface WorkspaceSnapshot {
  cwd: string;
  capturedAt: string;
  files: Map<string, FileSnapshot>;
  /** Best-effort ledger of entries omitted during capture. */
  omissions: SnapshotOmission[];
  /** True when the omission ledger hit its bound and is no longer complete. */
  omissionsTruncated: boolean;
}

export type ChangedFileStatus = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  binary: boolean;
  oversized: boolean;
  /** Original path for renames; rendered as `rename from`/`rename to` headers. */
  renamedFrom?: string;
  diffOmittedReason?: string;
  oldContent?: string;
  newContent?: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".tmp",
  "tmp",
  "vendor",
  ".env",
]);

export async function createWorkspaceSnapshot(cwd: string, options: SnapshotOptions): Promise<WorkspaceSnapshot> {
  throwIfAborted(options.signal);
  const root = resolve(cwd);
  const discovered = await discoverFiles(root, options.signal);
  const omissions: SnapshotOmission[] = [...discovered.omissions];
  let omissionsTruncated = discovered.omissionsTruncated;
  let capturedBytes = 0;
  const files = new Map<string, FileSnapshot>();

  for (const relativePath of discovered.paths.sort()) {
    throwIfAborted(options.signal);
    const absolutePath = resolve(root, relativePath);
    try {
      let fileStat: Stats;
      try {
        fileStat = await lstat(absolutePath);
      } catch (error) {
        throwIfAborted(options.signal);
        omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, "file", relativePath, error);
        if (fsFaultReason(error) !== "missing") {
          // The entry may still exist (permissions lost, symlink loop, or a
          // transient failure); keep a presence record so later comparisons
          // never misreport an unverifiable path as deleted.
          files.set(relativePath, unreadableSnapshot(relativePath, absolutePath));
        }
        continue;
      }

      if (fileStat.isDirectory()) {
        try {
          const gitlink = await createGitlinkSnapshot(root, relativePath, absolutePath, fileStat, options.signal);
          if (gitlink) files.set(relativePath, gitlink);
        } catch (error) {
          throwIfAborted(options.signal);
          // The directory was verified present by lstat, but its gitlink
          // metadata could not be inspected; record an unreadable presence
          // entry so it is never misreported as deleted.
          omissionsTruncated = recordSnapshotOmission(
            omissions,
            omissionsTruncated,
            "directory",
            relativePath,
            unreadableFault(error),
          );
          files.set(relativePath, unreadableSnapshot(relativePath, absolutePath, fileStat, "gitlink"));
        }
        continue;
      }
      if (!fileStat.isFile() && !fileStat.isSymbolicLink()) continue;

      if (fileStat.isSymbolicLink()) {
        let linkTarget: string;
        try {
          linkTarget = await readlink(absolutePath);
        } catch (error) {
          throwIfAborted(options.signal);
          omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, "file", relativePath, error);
          if (fsFaultReason(error) === "missing") continue;
          files.set(relativePath, unreadableSnapshot(relativePath, absolutePath, fileStat, "symlink"));
          continue;
        }
        files.set(relativePath, symlinkSnapshot(relativePath, absolutePath, fileStat, linkTarget));
        continue;
      }

      const reusable = options.reuseUnchangedFrom?.files.get(relativePath);
      if (
        reusable?.exists
        // An unreadable record has no verified hash; re-inspect it so a
        // transient read failure cannot become sticky across chained captures.
        && reusable.omittedReason !== "unreadable"
        && reusable.absolutePath === absolutePath
        && reusable.size === fileStat.size
        && reusable.mtimeMs === fileStat.mtimeMs
        && reusable.ctimeMs === fileStat.ctimeMs
        && reusable.dev === fileStat.dev
        && reusable.ino === fileStat.ino
        && reusable.mode === fileStat.mode
        && reusable.entryType !== "symlink"
      ) {
        files.set(relativePath, reusable);
        if (reusable.content !== undefined) capturedBytes += reusable.size;
        continue;
      }

      const contentEligible = fileStat.size <= options.maxFileBytes
        && capturedBytes + fileStat.size <= options.maxSnapshotBytes;
      const base: FileSnapshot = {
        relativePath,
        absolutePath,
        exists: true,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ctimeMs: fileStat.ctimeMs,
        dev: fileStat.dev,
        ino: fileStat.ino,
        mode: fileStat.mode,
        entryType: "file",
        sha256: null,
        isBinary: false,
      };

      let inspected: InspectedFile;
      try {
        await options.captureFaults?.beforeInspectFile?.({ relativePath, absolutePath });
        inspected = await inspectFile(absolutePath, contentEligible, options.signal, fileStat, root);
      } catch (error) {
        throwIfAborted(options.signal);
        omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, "file", relativePath, error);
        if (fsFaultReason(error) === "missing") continue;
        // The file existed at lstat time but could not be read; keep its real
        // identity with existence marked true and no content.
        files.set(relativePath, { ...base, omittedReason: "unreadable" });
        continue;
      }

      if (inspected.isBinary) {
        files.set(relativePath, { ...base, sha256: inspected.sha256, isBinary: true, omittedReason: "binary" });
        continue;
      }

      if (fileStat.size > options.maxFileBytes) {
        files.set(relativePath, { ...base, sha256: inspected.sha256, isBinary: false, omittedReason: "oversized" });
        continue;
      }

      if (capturedBytes + fileStat.size > options.maxSnapshotBytes) {
        files.set(relativePath, { ...base, sha256: inspected.sha256, isBinary: false, omittedReason: "snapshot_limit" });
        continue;
      }

      capturedBytes += fileStat.size;
      files.set(relativePath, {
        ...base,
        sha256: inspected.sha256,
        isBinary: false,
        content: inspected.content,
      });
    } catch (error) {
      // Per-entry safety net: an unexpected failure for one candidate must
      // never reject the whole snapshot. Abort semantics are preserved above.
      throwIfAborted(options.signal);
      omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, "file", relativePath, error);
      if (fsFaultReason(error) !== "missing") {
        files.set(relativePath, unreadableSnapshot(relativePath, absolutePath));
      }
    }
  }

  return {
    cwd: root,
    capturedAt: new Date().toISOString(),
    files,
    omissions,
    omissionsTruncated,
  };
}

export async function createPathSnapshot(cwd: string, pathLike: string, options: SnapshotOptions): Promise<FileSnapshot> {
  throwIfAborted(options.signal);
  const root = resolve(cwd);
  const absolutePath = isAbsolute(pathLike) ? resolve(pathLike) : resolve(root, pathLike);
  const relativePath = pathLabel(root, absolutePath);

  let fileStat: Stats | undefined;
  let lstatError: unknown;
  try {
    fileStat = await lstat(absolutePath);
  } catch (error) {
    throwIfAborted(options.signal);
    lstatError = error;
  }

  // A path that cannot be verified as absent is kept with exists: true so
  // later comparisons never misreport an unreadable existing path as deleted.
  if (!fileStat || (!fileStat.isFile() && !fileStat.isSymbolicLink())) {
    const unreadable = fileStat === undefined && fsFaultReason(lstatError) === "unreadable";
    return {
      relativePath,
      absolutePath,
      exists: unreadable,
      size: 0,
      mtimeMs: 0,
      sha256: null,
      isBinary: false,
      omittedReason: unreadable ? "unreadable" : "missing",
    };
  }

  if (fileStat.isSymbolicLink()) {
    try {
      const linkTarget = await readlink(absolutePath);
      return symlinkSnapshot(relativePath, absolutePath, fileStat, linkTarget);
    } catch (error) {
      throwIfAborted(options.signal);
      if (fsFaultReason(error) === "missing") {
        return {
          relativePath,
          absolutePath,
          exists: false,
          size: 0,
          mtimeMs: 0,
          sha256: null,
          isBinary: false,
          omittedReason: "missing",
        };
      }
      return unreadableSnapshot(relativePath, absolutePath, fileStat, "symlink");
    }
  }

  const withinWorkspace = isPathWithin(root, absolutePath);
  const contentEligible = (withinWorkspace || options.captureOutsideWorkspaceContent === true)
    && fileStat.size <= options.maxFileBytes;
  let inspected: InspectedFile;
  try {
    await options.captureFaults?.beforeInspectFile?.({ relativePath, absolutePath });
    inspected = await inspectFile(
      absolutePath,
      contentEligible,
      options.signal,
      fileStat,
      withinWorkspace ? root : undefined,
    );
  } catch (error) {
    throwIfAborted(options.signal);
    if (fsFaultReason(error) === "missing") {
      // The file vanished between lstat and read; it is absent at capture time.
      return {
        relativePath,
        absolutePath,
        exists: false,
        size: 0,
        mtimeMs: 0,
        sha256: null,
        isBinary: false,
        omittedReason: "missing",
      };
    }
    return unreadableSnapshot(relativePath, absolutePath, fileStat);
  }
  const base: FileSnapshot = {
    relativePath,
    absolutePath,
    exists: true,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    mode: fileStat.mode,
    entryType: "file",
    sha256: inspected.sha256,
    isBinary: inspected.isBinary,
  };

  if (!withinWorkspace && options.captureOutsideWorkspaceContent !== true) {
    return { ...base, omittedReason: "outside_workspace" };
  }

  if (inspected.isBinary) {
    return { ...base, omittedReason: "binary" };
  }

  if (fileStat.size > options.maxFileBytes) {
    return { ...base, omittedReason: "oversized" };
  }

  return {
    ...base,
    content: inspected.content,
  };
}

export function compareSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ChangedFile[] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changed: ChangedFile[] = [];

  for (const path of [...paths].sort()) {
    const oldFile = before.files.get(path);
    const newFile = after.files.get(path);

    if (!oldFile && newFile) {
      changed.push(fileChange(path, "added", undefined, newFile));
    } else if (oldFile && !newFile) {
      // A path missing from the after capture may simply sit under a directory
      // that could not be read; without this guard the unreadable directory
      // would misreport every child as deleted even though the children may
      // still exist on disk.
      if (isHiddenByUnreadableDirectory(after, path)) continue;
      changed.push(fileChange(path, "deleted", oldFile, undefined));
    } else if (oldFile && newFile && !sameSnapshotEntry(oldFile, newFile)) {
      changed.push(fileChange(path, "modified", oldFile, newFile));
    }
  }

  return changed;
}

function isHiddenByUnreadableDirectory(snapshot: WorkspaceSnapshot, path: string): boolean {
  for (const omission of snapshot.omissions) {
    if (omission.kind !== "directory" || omission.reason !== "unreadable") continue;
    const dirPath = omission.path === "." ? "" : omission.path;
    if (dirPath === "" || path === dirPath || path.startsWith(`${dirPath}/`)) return true;
  }
  return false;
}

export function compareFileSnapshots(before: FileSnapshot, after: FileSnapshot): ChangedFile | null {
  if (!before.exists && after.exists) {
    return fileChange(after.relativePath, "added", undefined, after);
  }
  if (before.exists && !after.exists) {
    return fileChange(before.relativePath, "deleted", before, undefined);
  }
  if (before.exists && after.exists && !sameSnapshotEntry(before, after)) {
    return fileChange(after.relativePath, "modified", before, after);
  }
  return null;
}

export async function discoverFiles(cwd: string, signal?: AbortSignal): Promise<FilesystemDiscovery> {
  throwIfAborted(signal);
  const gitFiles = await discoverGitFiles(cwd, signal);
  if (gitFiles) {
    const omissions: SnapshotOmission[] = [];
    let omissionsTruncated = false;
    for (const warning of gitFiles.unreadableEntries) {
      // Git enumerated the rest of the workspace but could not read this
      // entry, so its children are absent from the listing without being
      // absent from disk. Record the scope so later comparisons never
      // misreport those children as deleted. Note: Git's warning paths are
      // relative to the repository top level while ls-files output is
      // relative to cwd, so these may carry a prefix when cwd is a
      // subdirectory; the audit below re-records everything cwd-relative.
      omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, warning.kind, warning.path, unreadableFault());
    }
    if (gitFiles.hadWarnings) {
      // Git printed at least one warning. Always audit from cwd (readdir only,
      // never reading file content) so every unreadable directory is also
      // recorded in cwd-relative form, covering the top-level-relative parsed
      // paths when cwd is a repository subdirectory.
      const audit = await auditUnreadableDirectories(cwd, signal);
      for (const omission of audit.omissions) {
        const key = `${omission.kind}:${omission.path}`;
        const existingIndex = omissions.findIndex((existing) => `${existing.kind}:${existing.path}` === key);
        if (existingIndex >= 0) {
          // Prefer the audit record when it carries an errno code that the
          // parsed git warning lacks, keeping the ledger more informative.
          if (omission.errorCode !== undefined && omissions[existingIndex]!.errorCode === undefined) {
            omissions[existingIndex] = omission;
          }
          continue;
        }
        omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, omission.kind, omission.path, { code: omission.errorCode });
      }
      omissionsTruncated ||= audit.omissionsTruncated;
    }
    return { paths: gitFiles.paths, omissions, omissionsTruncated };
  }
  return discoverFilesystemFiles(cwd, signal);
}

/** A cause that classifies as "unreadable" without fabricating an errno code. */
function unreadableFault(cause?: unknown): Error {
  const fault = new Error("git could not inspect this workspace entry");
  // Command-level ENOENT/ENOTDIR do not prove the already-lstat'd directory
  // disappeared, so they are stripped to keep the fault classified unreadable.
  const code = fsFaultCode(cause);
  if (code !== undefined && code !== "ENOENT" && code !== "ENOTDIR") {
    Object.assign(fault, { code });
  }
  return fault;
}

interface GitDiscovery {
  paths: string[];
  hadWarnings: boolean;
  unreadableEntries: Array<{ path: string; kind: SnapshotOmissionKind }>;
}

async function discoverGitFiles(cwd: string, signal?: AbortSignal): Promise<GitDiscovery | null> {
  try {
    const [listing, location] = await Promise.all([
      execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
        cwd,
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
        signal,
      }),
      execFileAsync("git", ["rev-parse", "--show-prefix"], {
        cwd,
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
        signal,
      }),
    ]);
    const { stdout, stderr } = listing;
    const stderrText = stderr.toString("utf8");
    const cwdPrefix = location.stdout.toString("utf8").trim();
    return {
      paths: stdout
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map(normalizeRelativePath),
      hadWarnings: stderrText.trim().length > 0,
      unreadableEntries: parseGitDirectoryWarnings(stderrText).flatMap((entry) => {
        // Git warning paths are repository-top-relative while snapshot keys
        // are cwd-relative: normalize to cwd and drop anything outside it so
        // a prefixed entry can never suppress an unrelated sibling deletion.
        const path = gitWarningPathRelativeToCwd(entry.path, cwdPrefix);
        return path === undefined ? [] : [{ ...entry, path }];
      }),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    // Without a trusted warning namespace, fall back to the omission-aware
    // filesystem walk rather than recording un-rebased repository-relative
    // paths that could suppress unrelated sibling deletions.
    return null;
  }
}

/**
 * Re-base a repository-top-relative Git warning path to the capture cwd.
 * Returns undefined when the path is absolute, escapes cwd, or simply lives
 * outside the capture cwd, so it can never be recorded as a snapshot key.
 */
export function gitWarningPathRelativeToCwd(path: string, cwdPrefix: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const value = normalizeRelativePath(path).replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  const prefix = normalizeRelativePath(cwdPrefix).replace(/^\.\//, "").replace(/\/+$/, "");
  if (value === ".." || value.startsWith("../")) return undefined;
  if (!prefix) return value;
  if (value === prefix) return ".";
  return value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : undefined;
}

/**
 * Extract entry paths Git reported it could not enumerate (it warns and
 * exits successfully, silently omitting them from the listing). "could not
 * open directory" refers to directories; "unable to access" comes from
 * warn_on_fopen_errors for unreadable files such as exclude files, so it is
 * recorded with kind "file". Paths are relative to the repository top level;
 * callers re-base them to the capture cwd via gitWarningPathRelativeToCwd.
 */
export function parseGitDirectoryWarnings(stderr: string): Array<{ path: string; kind: SnapshotOmissionKind }> {
  const entries = new Map<string, SnapshotOmissionKind>();
  const pattern = /(?:could not open directory|unable to access) '([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    const isDirectory = match[0]!.startsWith("could not open directory");
    const path = match[1]!.replace(/\/+$/, "");
    entries.set(path === "" ? "." : path, isDirectory ? "directory" : "file");
  }
  return [...entries].map(([path, kind]) => ({ path, kind }));
}

/**
 * Best-effort readdir-only audit that records unreadable directories without
 * collecting file paths, used as a conservative backstop when Git discovery
 * emits warnings that cannot be attributed to specific directories. Gitignored
 * top-level directories known to be bulky are skipped, matching the plain
 * filesystem walk.
 */
async function auditUnreadableDirectories(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ omissions: SnapshotOmission[]; omissionsTruncated: boolean }> {
  const omissions: SnapshotOmission[] = [];
  let omissionsTruncated = false;

  async function walk(dir: string, relativeDir: string): Promise<void> {
    throwIfAborted(signal);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throwIfAborted(signal);
      omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, "directory", relativeDir || ".", error);
      return;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      await walk(resolve(dir, entry.name), relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
    }
  }

  await walk(cwd, "");
  return { omissions, omissionsTruncated };
}

async function discoverFilesystemFiles(cwd: string, signal?: AbortSignal): Promise<FilesystemDiscovery> {
  const result: string[] = [];
  const omissions: SnapshotOmission[] = [];
  let omissionsTruncated = false;

  async function walk(dir: string, relativeDir: string): Promise<void> {
    throwIfAborted(signal);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throwIfAborted(signal);
      omissionsTruncated = recordSnapshotOmission(omissions, omissionsTruncated, "directory", relativeDir || ".", error);
      return;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(normalizeRelativePath(relative(cwd, absolute)));
      }
    }
  }

  await walk(cwd, "");
  return { paths: result, omissions, omissionsTruncated };
}

function fileChange(
  path: string,
  status: ChangedFileStatus,
  oldFile: FileSnapshot | undefined,
  newFile: FileSnapshot | undefined,
): ChangedFile {
  const binary = Boolean(oldFile?.isBinary || newFile?.isBinary);
  const oldOmitted = oldFile?.omittedReason;
  const newOmitted = newFile?.omittedReason;
  const diffOmittedReason = binary ? "binary" : oldOmitted ?? newOmitted;

  return {
    path,
    status,
    binary,
    oversized: oldOmitted === "oversized" || newOmitted === "oversized",
    diffOmittedReason,
    oldContent: snapshotDisplayContent(oldFile),
    newContent: snapshotDisplayContent(newFile),
  };
}

function recordPathOmission(
  omissions: SnapshotOmission[],
  kind: SnapshotOmissionKind,
  path: string,
  cause: unknown,
): { truncated: boolean } {
  if (omissions.length >= MAX_SNAPSHOT_OMISSIONS) {
    const unreadableDirectory = kind === "directory" && fsFaultReason(cause) === "unreadable";
    if (unreadableDirectory) {
      // The ledger overflowed, but deletion suppression must still hold: an
      // unrecorded unreadable directory would let its children be reported as
      // deleted. Collapse coverage into a root-level sentinel (path ".", which
      // conservatively covers every path) in place of the last record.
      markUnreadableDirectorySentinel(omissions);
    }
    return { truncated: true };
  }
  const errorCode = fsFaultCode(cause);
  omissions.push({
    path,
    kind,
    reason: fsFaultReason(cause),
    ...(errorCode !== undefined ? { errorCode: errorCode.slice(0, MAX_ERROR_CODE_LENGTH) } : {}),
  });
  return { truncated: false };
}

/**
 * Record an omission and merge the truncation flag. Always evaluates the
 * recording, unlike `truncated ||= recordPathOmission(...)` which would
 * short-circuit and skip the unreadable-directory sentinel once truncation
 * has already flipped true.
 */
export function recordSnapshotOmission(
  omissions: SnapshotOmission[],
  alreadyTruncated: boolean,
  kind: SnapshotOmissionKind,
  path: string,
  cause: unknown,
): boolean {
  const { truncated } = recordPathOmission(omissions, kind, path, cause);
  return alreadyTruncated || truncated;
}

/** Install (or keep) the conservative root-level unreadable-directory sentinel. */
function markUnreadableDirectorySentinel(omissions: SnapshotOmission[]): void {
  const isSentinel = (omission: SnapshotOmission) =>
    omission.path === "." && omission.kind === "directory" && omission.reason === "unreadable";
  if (omissions.some(isSentinel)) return;
  const sentinel: SnapshotOmission = { path: ".", kind: "directory", reason: "unreadable" };
  if (omissions.length >= MAX_SNAPSHOT_OMISSIONS) {
    omissions[omissions.length - 1] = sentinel;
  } else {
    omissions.push(sentinel);
  }
}

/**
 * Presence record for an entry that could not be captured but is not verified
 * absent: exists stays true (identity from any stat available) so later
 * comparisons classify it as unavailable rather than deleted.
 */
function unreadableSnapshot(
  relativePath: string,
  absolutePath: string,
  stat?: Stats,
  entryType: "file" | "symlink" | "gitlink" = "file",
): FileSnapshot {
  return {
    relativePath,
    absolutePath,
    exists: true,
    size: stat?.size ?? 0,
    mtimeMs: stat?.mtimeMs ?? 0,
    ctimeMs: stat?.ctimeMs,
    dev: stat?.dev,
    ino: stat?.ino,
    mode: stat?.mode,
    entryType,
    sha256: null,
    isBinary: false,
    omittedReason: "unreadable",
  };
}

interface InspectedFile {
  sha256: string;
  isBinary: boolean;
  content?: string;
}

const BINARY_SAMPLE_BYTES = 8192;

/** Hash a file exactly once while retaining content only when it is bounded text. */
async function inspectFile(
  path: string,
  retainTextContent: boolean,
  signal?: AbortSignal,
  expectedStat?: Stats,
  workspaceRoot?: string,
): Promise<InspectedFile> {
  throwIfAborted(signal);
  if (workspaceRoot) await assertCanonicalPathWithinWorkspace(workspaceRoot, path);
  // Open without following a final-component symlink so a concurrent
  // file-to-symlink replacement cannot redirect the read outside the
  // workspace; the stat identity check then proves this is still the entry
  // that was lstat'd, closing the remaining swap window.
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile()
      || (expectedStat !== undefined && !sameCaptureStat(openedStat, expectedStat))
    ) {
      throw captureRaceError("workspace entry changed during capture");
    }
    const inspected = await inspectFileHandle(handle, retainTextContent, signal, expectedStat?.size);
    if (expectedStat !== undefined && !sameCaptureStat(await handle.stat(), expectedStat)) {
      throw captureRaceError("workspace entry changed during capture");
    }
    return inspected;
  } finally {
    await handle.close();
  }
}

/**
 * Reject paths whose canonical location falls outside the canonical workspace
 * root, so a symlinked intermediate directory introduced during capture cannot
 * redirect reads outside the workspace. Containment (not string equality) is
 * used because native realpath returns the on-disk case/normalization on
 * case-insensitive filesystems, and an in-workspace canonical path never
 * crosses the capture boundary.
 */
async function assertCanonicalPathWithinWorkspace(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (canonicalPath === canonicalRoot || !isPathWithin(canonicalRoot, canonicalPath)) {
    throw captureRaceError("workspace entry resolves outside the workspace");
  }
}

/**
 * An error for a detected capture race. Deliberately carries no errno code:
 * fsFaultReason classifies code-less errors as "unreadable", and the omission
 * ledger must not report a fabricated errno for a non-filesystem condition.
 */
function captureRaceError(message: string): Error {
  return new Error(message);
}

/** Stable identity across capture: the entry read must be the entry lstat'd. */
function sameCaptureStat(actual: Stats, expected: Stats): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && actual.mode === expected.mode;
}

async function inspectFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  retainTextContent: boolean,
  signal?: AbortSignal,
  expectedBytes?: number,
): Promise<InspectedFile> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  const contentChunks: Buffer[] = [];
  const sampleChunks: Buffer[] = [];
  let sampleBytes = 0;
  let bytesRead = 0;
  let binary: boolean | undefined;
  await new Promise<void>((resolvePromise, reject) => {
    // Bound the undecided prefix retained for binary classification. Once the
    // prefix is classified, binary content is discarded while hashing continues.
    const stream = handle.createReadStream({ highWaterMark: BINARY_SAMPLE_BYTES, autoClose: false });
    const onAbort = () => stream.destroy(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    stream.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      // Enforce the lstat'd size while streaming so in-place growth cannot
      // bypass the byte bounds or buffer unbounded content.
      if (expectedBytes !== undefined && bytesRead + bytes.length > expectedBytes) {
        stream.destroy(captureRaceError("workspace entry grew during capture"));
        return;
      }
      bytesRead += bytes.length;
      hash.update(bytes);
      if (retainTextContent && binary !== true) contentChunks.push(bytes);
      if (binary !== undefined || sampleBytes >= BINARY_SAMPLE_BYTES) return;
      const remaining = BINARY_SAMPLE_BYTES - sampleBytes;
      const sample = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining);
      sampleChunks.push(sample);
      sampleBytes += sample.length;
      if (sampleBytes >= BINARY_SAMPLE_BYTES) {
        binary = looksBinary(Buffer.concat(sampleChunks, sampleBytes));
        if (binary) contentChunks.length = 0;
      }
    });
    stream.on("error", (error) => {
      cleanup();
      reject(error);
    });
    stream.on("end", () => {
      cleanup();
      if (expectedBytes !== undefined && bytesRead !== expectedBytes) {
        reject(captureRaceError("workspace entry shrank during capture"));
        return;
      }
      resolvePromise();
    });
  });
  if (binary === undefined) {
    binary = looksBinary(Buffer.concat(sampleChunks, sampleBytes));
    if (binary) contentChunks.length = 0;
  }
  return {
    sha256: hash.digest("hex"),
    isBinary: binary,
    content: retainTextContent && !binary ? Buffer.concat(contentChunks).toString("utf8") : undefined,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function looksBinary(buffer: Buffer): boolean {
  if (hasKnownBinaryMagic(buffer)) return true;
  const sampleLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return buffer.toString("utf8", 0, sampleLength).includes("\uFFFD");
}

function hasKnownBinaryMagic(buffer: Buffer): boolean {
  const starts = (...bytes: number[]) => buffer.length >= bytes.length
    && bytes.every((byte, index) => buffer[index] === byte);
  const ascii = (value: string, offset = 0) => {
    if (buffer.length < offset + value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (buffer[offset + index] !== value.charCodeAt(index)) return false;
    }
    return true;
  };
  const bzip2 = ascii("BZh") && buffer.length >= 10
    && buffer[3]! >= 0x31 && buffer[3]! <= 0x39
    && ascii("1AY&SY", 4);
  const portableExecutable = ascii("MZ") && buffer.length >= 0x40
    && (() => {
      const peOffset = buffer.readUInt32LE(0x3c);
      return peOffset + 4 <= buffer.length && ascii("PE\0\0", peOffset);
    })();
  const bitmap = ascii("BM") && buffer.length >= 14
    && buffer.subarray(6, 10).every((byte) => byte === 0)
    && buffer.readUInt32LE(10) >= 14;
  const riff = ascii("RIFF") && buffer.length >= 12
    && ["WAVE", "AVI ", "WEBP", "ACON", "CDXA"].some((kind) => ascii(kind, 8));
  const id3 = ascii("ID3") && buffer.length >= 10
    && buffer[3]! >= 2 && buffer[3]! <= 4
    && buffer[4] !== 0xff
    && buffer.subarray(6, 10).every((byte) => (byte & 0x80) === 0);
  const isoBaseMedia = ascii("ftyp", 4) && buffer.length >= 8
    && buffer.readUInt32BE(0) >= 8 && buffer.readUInt32BE(0) <= 4096;

  return (
    // Archives and compressed streams.
    starts(0x50, 0x4b, 0x03, 0x04) // zip and ZIP-based formats
    || starts(0x50, 0x4b, 0x05, 0x06)
    || starts(0x50, 0x4b, 0x07, 0x08)
    || starts(0x1f, 0x8b) // gzip
    || bzip2
    || starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) // xz
    || starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) // 7z
    || starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07) // rar
    || starts(0x28, 0xb5, 0x2f, 0xfd) // zstd
    || ascii("ustar", 257) // tar
    || ascii("!<arch>\n") // Unix archive / static library

    // Executables, bytecode, and object formats.
    || starts(0x7f, 0x45, 0x4c, 0x46) // ELF
    || portableExecutable
    || starts(0x00, 0x61, 0x73, 0x6d) // WebAssembly
    || starts(0xfe, 0xed, 0xfa, 0xce) // Mach-O, both widths/endian orders
    || starts(0xce, 0xfa, 0xed, 0xfe)
    || starts(0xfe, 0xed, 0xfa, 0xcf)
    || starts(0xcf, 0xfa, 0xed, 0xfe)
    || starts(0xca, 0xfe, 0xba, 0xbe) // Mach-O universal / Java class
    || starts(0xbe, 0xba, 0xfe, 0xca)

    // Images and document containers.
    || starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) // PNG
    || starts(0xff, 0xd8, 0xff) // JPEG
    || ascii("GIF87a")
    || ascii("GIF89a")
    || bitmap
    || starts(0x49, 0x49, 0x2a, 0x00) // TIFF
    || starts(0x4d, 0x4d, 0x00, 0x2a)
    || starts(0x00, 0x00, 0x01, 0x00) // ICO
    || ascii("8BPS") // Photoshop
    || ascii("%PDF-")

    // Audio/video containers and fonts.
    || riff
    || ascii("OggS")
    || ascii("fLaC")
    || id3
    || isoBaseMedia // ISO base media: MP4, HEIF/HEIC, AVIF, etc.
    || ascii("wOFF")
    || ascii("wOF2")
    || ascii("OTTO")
    || ascii("ttcf")
    || starts(0x00, 0x01, 0x00, 0x00) // TrueType

    // Recognizable binary stores.
    || ascii("SQLite format 3\0")
  );
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function symlinkSnapshot(
  relativePath: string,
  absolutePath: string,
  fileStat: Stats,
  linkTarget: string,
): FileSnapshot {
  return {
    relativePath,
    absolutePath,
    exists: true,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    mode: fileStat.mode,
    entryType: "symlink",
    linkTarget,
    sha256: createHash("sha256").update(linkTarget).digest("hex"),
    isBinary: false,
  };
}

function sameSnapshotEntry(before: FileSnapshot, after: FileSnapshot): boolean {
  return before.sha256 === after.sha256
    && before.entryType === after.entryType
    && before.mode === after.mode
    && before.linkTarget === after.linkTarget
    && before.gitObjectId === after.gitObjectId;
}

function snapshotDisplayContent(snapshot: FileSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.entryType === "symlink") return snapshot.linkTarget;
  if (snapshot.entryType === "gitlink") return `Subproject commit ${snapshot.gitObjectId ?? "unknown"}\n`;
  return snapshot.content;
}

async function createGitlinkSnapshot(
  root: string,
  relativePath: string,
  absolutePath: string,
  fileStat: Stats,
  signal?: AbortSignal,
): Promise<FileSnapshot | undefined> {
  // Only reachable for entries Git itself listed (git mode) or after lstat
  // verified a directory, so a command failure here can never establish that
  // the entry is absent. Every non-abort failure propagates to the caller,
  // which records a typed unreadable-directory omission and a gitlink
  // presence snapshot instead of silently dropping an existing entry.
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--stage", "-z", "--", relativePath],
    { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024, signal },
  );
  const record = stdout.toString("utf8").split("\0", 1)[0] ?? "";
  const match = record.match(/^160000 ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/);
  if (!match?.[1]) return undefined;
  const indexObjectId = match[1];

  // A checked-out submodule may be ahead of or behind the index. Record its
  // current commit when readable so ordinary snapshots detect that state too.
  let gitObjectId = indexObjectId;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel", "HEAD"], {
      cwd: absolutePath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      signal,
    });
    const lines = stdout.trim().split(/\r?\n/);
    const nestedRoot = lines[0];
    const candidate = lines[1];
    if (nestedRoot && resolve(nestedRoot) === resolve(absolutePath)
      && candidate && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate)) {
      gitObjectId = candidate;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  return {
    relativePath,
    absolutePath,
    exists: true,
    size: 0,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    mode: fileStat.mode,
    entryType: "gitlink",
    gitObjectId,
    sha256: createHash("sha256").update(gitObjectId).digest("hex"),
    isBinary: false,
  };
}

function pathLabel(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return normalizeRelativePath(rel);
  }
  return normalizeRelativePath(absolutePath);
}
