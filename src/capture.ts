import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, readlink, readdir } from "node:fs/promises";
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

    const contentEligible = fileStat.size <= options.maxFileBytes
      && capturedBytes + fileStat.size <= options.maxSnapshotBytes;
    const inspected = await inspectFile(absolutePath, contentEligible, options.signal);
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

    if (inspected.isBinary) {
      files.set(relativePath, { ...base, omittedReason: "binary" });
      continue;
    }

    if (fileStat.size > options.maxFileBytes) {
      files.set(relativePath, { ...base, omittedReason: "oversized" });
      continue;
    }

    if (capturedBytes + fileStat.size > options.maxSnapshotBytes) {
      files.set(relativePath, { ...base, omittedReason: "snapshot_limit" });
      continue;
    }

    capturedBytes += fileStat.size;
    files.set(relativePath, {
      ...base,
      content: inspected.content,
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

  const withinWorkspace = isPathWithin(root, absolutePath);
  const contentEligible = (withinWorkspace || options.captureOutsideWorkspaceContent === true)
    && fileStat.size <= options.maxFileBytes;
  const inspected = await inspectFile(absolutePath, contentEligible, options.signal);
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

interface InspectedFile {
  sha256: string;
  isBinary: boolean;
  content?: string;
}

const BINARY_SAMPLE_BYTES = 8192;

/** Hash a file exactly once while retaining content only when it is bounded text. */
async function inspectFile(path: string, retainTextContent: boolean, signal?: AbortSignal): Promise<InspectedFile> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  const contentChunks: Buffer[] = [];
  const sampleChunks: Buffer[] = [];
  let sampleBytes = 0;
  let binary: boolean | undefined;
  await new Promise<void>((resolvePromise, reject) => {
    // Bound the undecided prefix retained for binary classification. Once the
    // prefix is classified, binary content is discarded while hashing continues.
    const stream = createReadStream(path, { highWaterMark: BINARY_SAMPLE_BYTES });
    const onAbort = () => stream.destroy(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    stream.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
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
