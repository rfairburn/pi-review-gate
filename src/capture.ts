import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, readlink, readdir, readFile } from "node:fs/promises";
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
}

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
  omittedReason?: "binary" | "oversized" | "snapshot_limit" | "outside_workspace" | "missing";
}

export interface WorkspaceSnapshot {
  cwd: string;
  capturedAt: string;
  files: Map<string, FileSnapshot>;
}

export type ChangedFileStatus = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  binary: boolean;
  oversized: boolean;
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
  const candidates = await discoverFiles(root, options.signal);
  let capturedBytes = 0;
  const files = new Map<string, FileSnapshot>();

  for (const relativePath of candidates.sort()) {
    throwIfAborted(options.signal);
    const absolutePath = resolve(root, relativePath);
    const fileStat = await lstat(absolutePath).catch(() => undefined);
    if (!fileStat) {
      continue;
    }

    if (fileStat.isDirectory()) {
      const gitlink = await createGitlinkSnapshot(root, relativePath, absolutePath, fileStat, options.signal);
      if (gitlink) files.set(relativePath, gitlink);
      continue;
    }
    if (!fileStat.isFile() && !fileStat.isSymbolicLink()) continue;

    if (fileStat.isSymbolicLink()) {
      const linkTarget = await readlink(absolutePath);
      files.set(relativePath, symlinkSnapshot(relativePath, absolutePath, fileStat, linkTarget));
      continue;
    }

    const reusable = options.reuseUnchangedFrom?.files.get(relativePath);
    if (
      reusable?.exists
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

    const sha256 = await hashFile(absolutePath, options.signal);
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
      sha256,
      isBinary: false,
    };

    if (fileStat.size > options.maxFileBytes) {
      files.set(relativePath, { ...base, omittedReason: "oversized" });
      continue;
    }

    if (capturedBytes + fileStat.size > options.maxSnapshotBytes) {
      files.set(relativePath, { ...base, omittedReason: "snapshot_limit" });
      continue;
    }

    const buffer = await readFile(absolutePath, { signal: options.signal });
    const isBinary = looksBinary(buffer);
    if (isBinary) {
      files.set(relativePath, { ...base, isBinary: true, omittedReason: "binary" });
      continue;
    }

    capturedBytes += fileStat.size;
    files.set(relativePath, {
      ...base,
      content: buffer.toString("utf8"),
    });
  }

  return {
    cwd: root,
    capturedAt: new Date().toISOString(),
    files,
  };
}

export async function createPathSnapshot(cwd: string, pathLike: string, options: SnapshotOptions): Promise<FileSnapshot> {
  throwIfAborted(options.signal);
  const root = resolve(cwd);
  const absolutePath = isAbsolute(pathLike) ? resolve(pathLike) : resolve(root, pathLike);
  const relativePath = pathLabel(root, absolutePath);
  const fileStat = await lstat(absolutePath).catch(() => undefined);
  if (!fileStat || (!fileStat.isFile() && !fileStat.isSymbolicLink())) {
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

  if (fileStat.isSymbolicLink()) {
    const linkTarget = await readlink(absolutePath);
    return symlinkSnapshot(relativePath, absolutePath, fileStat, linkTarget);
  }

  const sha256 = await hashFile(absolutePath, options.signal);
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
    sha256,
    isBinary: false,
  };

  if (!isPathWithin(root, absolutePath) && options.captureOutsideWorkspaceContent !== true) {
    return { ...base, omittedReason: "outside_workspace" };
  }

  if (fileStat.size > options.maxFileBytes) {
    return { ...base, omittedReason: "oversized" };
  }

  const buffer = await readFile(absolutePath, { signal: options.signal });
  const isBinary = looksBinary(buffer);
  if (isBinary) {
    return { ...base, isBinary: true, omittedReason: "binary" };
  }

  return {
    ...base,
    content: buffer.toString("utf8"),
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
      changed.push(fileChange(path, "deleted", oldFile, undefined));
    } else if (oldFile && newFile && !sameSnapshotEntry(oldFile, newFile)) {
      changed.push(fileChange(path, "modified", oldFile, newFile));
    }
  }

  return changed;
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

export async function discoverFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const gitFiles = await discoverGitFiles(cwd, signal);
  if (gitFiles) {
    return gitFiles;
  }
  return discoverFilesystemFiles(cwd, signal);
}

async function discoverGitFiles(cwd: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
      signal,
    });
    return stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(normalizeRelativePath);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function discoverFilesystemFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    throwIfAborted(signal);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        result.push(normalizeRelativePath(relative(cwd, absolute)));
      }
    }
  }

  await walk(cwd);
  return result;
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

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    const onAbort = () => stream.destroy(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error) => {
      cleanup();
      reject(error);
    });
    stream.on("end", () => {
      cleanup();
      resolvePromise();
    });
  });
  return hash.digest("hex");
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
  const sampleLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return buffer.toString("utf8", 0, sampleLength).includes("\uFFFD");
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
  let indexObjectId: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--stage", "-z", "--", relativePath],
      { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024, signal },
    );
    const record = stdout.toString("utf8").split("\0", 1)[0] ?? "";
    const match = record.match(/^160000 ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/);
    if (!match?.[1]) return undefined;
    indexObjectId = match[1];
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }

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
