import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_SIDEBAR_APPEARANCE,
  normalizeSidebarAppearance,
  parseAppearanceConfig,
  type SidebarAppearance,
} from "./sidebar-theme";
import { ensureHostStateDir, sessionHostStateDir } from "./roster-store";

/**
 * The dedicated per-native-agent appearance file. It is deliberately its own
 * file: Network and host-keybinding settings keep their existing shapes, and
 * nothing here reads or writes Pi's own configuration.
 */
export const APPEARANCE_FILENAME = "appearance.json";
export const MAX_APPEARANCE_FILE_BYTES = 4096;

export function appearancePath(agentDir: string): string {
  return join(sessionHostStateDir(agentDir), APPEARANCE_FILENAME);
}

export type AppearanceConfigReadResult =
  | { readonly status: "absent"; readonly appearance: SidebarAppearance }
  | { readonly status: "loaded"; readonly appearance: SidebarAppearance }
  | { readonly status: "unavailable"; readonly message: string };

type OpenResult =
  | { readonly fd: number; readonly stats: BigIntStats }
  | { readonly reason: "absent" | "unsafe" | "oversized" | "unreadable" };

function openExistingRegularFile(path: string): OpenResult {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    return { reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { reason: "unsafe" };
  if (before.size > BigInt(MAX_APPEARANCE_FILE_BYTES)) return { reason: "oversized" };
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { reason: "unreadable" };
  }
  let opened: BigIntStats;
  try {
    opened = fstatSync(fd, { bigint: true });
  } catch {
    try { closeSync(fd); } catch { /* preserve the refusal */ }
    return { reason: "unreadable" };
  }
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
    try { closeSync(fd); } catch { /* preserve the refusal */ }
    return { reason: "unsafe" };
  }
  if (opened.size > BigInt(MAX_APPEARANCE_FILE_BYTES)) {
    try { closeSync(fd); } catch { /* preserve the refusal */ }
    return { reason: "oversized" };
  }
  return { fd, stats: opened };
}

function readAll(fd: number, size: number): Buffer | undefined {
  const result = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    let count: number;
    try {
      count = readSync(fd, result, offset, size - offset, offset);
    } catch {
      return undefined;
    }
    if (count <= 0) break;
    offset += count;
  }
  return offset === size ? result : undefined;
}

function unavailable(message: string): AppearanceConfigReadResult {
  return { status: "unavailable", message: `Session host refused: ${message} The file was left untouched; fix or move it before restarting.` };
}

/**
 * Read the dedicated appearance file. Absence is the only condition that
 * selects the default, and reading never creates the file.
 */
export function readAppearanceConfig(agentDir: string): AppearanceConfigReadResult {
  let path: string;
  try {
    const stateDir = ensureHostStateDir(agentDir);
    path = join(stateDir, APPEARANCE_FILENAME);
  } catch {
    return unavailable("appearance settings could not be safely accessed.");
  }
  const opened = openExistingRegularFile(path);
  if (!("fd" in opened)) {
    switch (opened.reason) {
      case "absent":
        return { status: "absent", appearance: DEFAULT_SIDEBAR_APPEARANCE };
      case "unsafe":
        return unavailable("appearance settings are not a regular file.");
      case "oversized":
        return unavailable(`appearance settings exceed ${MAX_APPEARANCE_FILE_BYTES} bytes.`);
      default:
        return unavailable("appearance settings could not be read.");
    }
  }

  try {
    const bytes = readAll(opened.fd, Number(opened.stats.size));
    if (bytes === undefined) return unavailable("appearance settings changed while being read.");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return unavailable("appearance settings contain malformed JSON.");
    }
    try {
      return { status: "loaded", appearance: parseAppearanceConfig(value) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the schema is invalid.";
      return unavailable(`appearance settings are invalid (${reason}).`);
    }
  } finally {
    try { closeSync(opened.fd); } catch { /* close failure does not change the bounded result */ }
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function sameIdentity(stats: BigIntStats, identity: FileIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

interface DestinationEntry extends FileIdentity {
  readonly size: number;
  /** Timestamps close most of the window between validation and publication. */
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function existingDestination(path: string): DestinationEntry | undefined {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("appearance settings path is not a regular file; it was not overwritten");
    }
    return {
      dev: stats.dev,
      ino: stats.ino,
      size: Number(stats.size),
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A save may replace only an absent entry or one the host could actually read.
 * Startup deliberately continues after a refused appearance read, so the
 * operator's malformed, schema-invalid, oversized, or unreadable file must
 * survive a later deliberate theme change: the save refuses, the file stays
 * byte-identical, and the bounded notice is not quietly cleared by success.
 */
function assertExistingRecordReplaceable(path: string, size: number): void {
  if (size > MAX_APPEARANCE_FILE_BYTES) {
    throw new Error(`existing appearance settings exceed ${MAX_APPEARANCE_FILE_BYTES} bytes; `
      + "fix or remove them before saving; the existing file was not replaced");
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("existing appearance settings could not be read; "
      + "fix or remove them before saving; the existing file was not replaced");
  }
  try {
    const bytes = readAll(fd, size);
    if (bytes === undefined) {
      throw new Error("existing appearance settings changed while being read; the existing file was not replaced");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("existing appearance settings contain malformed JSON; "
        + "fix or remove them before saving; the existing file was not replaced");
    }
    try {
      parseAppearanceConfig(value);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the schema is invalid";
      throw new Error(`existing appearance settings are invalid (${reason}); `
        + "fix or remove them before saving; the existing file was not replaced");
    }
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* the bounded refusal stands */ }
  }
}

function assertDestinationUnchanged(path: string, expected: DestinationEntry | undefined): void {
  const current = existingDestination(path);
  if (expected === undefined ? current !== undefined
    : current === undefined || current.dev !== expected.dev || current.ino !== expected.ino
      || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs
      || current.ctimeNs !== expected.ctimeNs) {
    throw new Error("appearance settings path changed during save; the existing entry was not overwritten");
  }
}

function syncDirectoryBestEffort(directory: string): void {
  try {
    const fd = openSync(directory, fsConstants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

/**
 * Atomically save one validated appearance record in the same per-agent
 * session-host scope as the other host-owned settings. An unsafe path is
 * refused rather than replaced, an existing record the host cannot read is
 * preserved instead of overwritten, and a refused save changes nothing on disk.
 */
export function writeAppearanceConfig(agentDir: string, proposed: SidebarAppearance): SidebarAppearance {
  const appearance = normalizeSidebarAppearance(proposed);
  const stateDir = ensureHostStateDir(agentDir);
  const stateStats = lstatSync(stateDir, { bigint: true });
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink()) {
    throw new Error("appearance settings directory is not a real directory");
  }
  const path = join(stateDir, APPEARANCE_FILENAME);
  const destination = existingDestination(path);
  if (destination !== undefined) assertExistingRecordReplaceable(path, destination.size);
  const temporary = `${path}.tmp.${randomUUID()}`;
  const body = `${JSON.stringify({ version: 1, theme: appearance.theme })}\n`;
  let fd: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let ownsTemporary = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    ownsTemporary = true;
    const opened = fstatSync(fd, { bigint: true });
    temporaryIdentity = { dev: opened.dev, ino: opened.ino };
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    const currentState = lstatSync(stateDir, { bigint: true });
    if (!currentState.isDirectory() || currentState.isSymbolicLink()
      || !sameIdentity(currentState, { dev: stateStats.dev, ino: stateStats.ino })) {
      throw new Error("appearance settings directory changed during save; no settings were replaced");
    }
    assertDestinationUnchanged(path, destination);
    renameSync(temporary, path);
    ownsTemporary = false;
    syncDirectoryBestEffort(stateDir);
    return appearance;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the publication error */ }
    }
    if (ownsTemporary && temporaryIdentity !== undefined) {
      try {
        const current = lstatSync(temporary, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, temporaryIdentity)) {
          unlinkSync(temporary);
        }
      } catch {
        // An unverified temp entry is preserved rather than removed by name.
      }
    }
    if (error instanceof Error) throw error;
    throw new Error("appearance settings could not be saved");
  }
}
