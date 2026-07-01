import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotOptions {
  maxFileBytes: number;
  maxSnapshotBytes: number;
}

export interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  sha256: string | null;
  isBinary: boolean;
  content?: string;
  omittedReason?: "binary" | "oversized" | "snapshot_limit" | "missing";
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
  const root = resolve(cwd);
  const candidates = await discoverFiles(root);
  let capturedBytes = 0;
  const files = new Map<string, FileSnapshot>();

  for (const relativePath of candidates.sort()) {
    const absolutePath = resolve(root, relativePath);
    const fileStat = await stat(absolutePath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      continue;
    }

    const sha256 = await hashFile(absolutePath);
    const base: FileSnapshot = {
      relativePath,
      absolutePath,
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
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

    const buffer = await readFile(absolutePath);
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
  const root = resolve(cwd);
  const absolutePath = isAbsolute(pathLike) ? resolve(pathLike) : resolve(root, pathLike);
  const relativePath = pathLabel(root, absolutePath);
  const fileStat = await stat(absolutePath).catch(() => undefined);
  if (!fileStat?.isFile()) {
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

  const sha256 = await hashFile(absolutePath);
  const base: FileSnapshot = {
    relativePath,
    absolutePath,
    exists: true,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256,
    isBinary: false,
  };

  if (fileStat.size > options.maxFileBytes) {
    return { ...base, omittedReason: "oversized" };
  }

  const buffer = await readFile(absolutePath);
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
    } else if (oldFile && newFile && oldFile.sha256 !== newFile.sha256) {
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
  if (before.exists && after.exists && before.sha256 !== after.sha256) {
    return fileChange(after.relativePath, "modified", before, after);
  }
  return null;
}

export async function discoverFiles(cwd: string): Promise<string[]> {
  const gitFiles = await discoverGitFiles(cwd);
  if (gitFiles) {
    return gitFiles;
  }
  return discoverFilesystemFiles(cwd);
}

async function discoverGitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(normalizeRelativePath);
  } catch {
    return null;
  }
}

async function discoverFilesystemFiles(cwd: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
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
    oldContent: oldFile?.content,
    newContent: newFile?.content,
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
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

function pathLabel(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return normalizeRelativePath(rel);
  }
  return normalizeRelativePath(absolutePath);
}
