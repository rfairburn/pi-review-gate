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
  assertHostShortcutsDistinct,
  DEFAULT_HOST_SHORTCUTS,
  normalizeHostShortcutBindings,
  normalizeHostShortcutKey,
  parseHostShortcutConfig,
  type HostShortcutBindings,
} from "./host-shortcuts";
import { ensureHostStateDir, sessionHostStateDir } from "./roster-store";

export const HOST_SHORTCUTS_FILENAME = "keybindings.json";
export const MAX_HOST_SHORTCUTS_FILE_BYTES = 4096;

export function hostShortcutsPath(agentDir: string): string {
  return join(sessionHostStateDir(agentDir), HOST_SHORTCUTS_FILENAME);
}

export type HostShortcutConfigReadResult =
  | { readonly status: "absent"; readonly bindings: HostShortcutBindings }
  | { readonly status: "loaded"; readonly bindings: HostShortcutBindings }
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
  if (before.size > BigInt(MAX_HOST_SHORTCUTS_FILE_BYTES)) return { reason: "oversized" };
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
  if (opened.size > BigInt(MAX_HOST_SHORTCUTS_FILE_BYTES)) {
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

function unavailable(message: string): HostShortcutConfigReadResult {
  return { status: "unavailable", message: `Session host refused: ${message} The file was left untouched; fix or move it before restarting.` };
}

/** Read the dedicated host file; absence is the only condition that selects defaults. */
export function readHostShortcutConfig(agentDir: string): HostShortcutConfigReadResult {
  let path: string;
  try {
    const stateDir = ensureHostStateDir(agentDir);
    path = join(stateDir, HOST_SHORTCUTS_FILENAME);
  } catch {
    return unavailable("host shortcut settings could not be safely accessed.");
  }
  const opened = openExistingRegularFile(path);
  if (!("fd" in opened)) {
    switch (opened.reason) {
      case "absent":
        return { status: "absent", bindings: DEFAULT_HOST_SHORTCUTS };
      case "unsafe":
        return unavailable("host shortcut settings are not a regular file.");
      case "oversized":
        return unavailable(`host shortcut settings exceed ${MAX_HOST_SHORTCUTS_FILE_BYTES} bytes.`);
      default:
        return unavailable("host shortcut settings could not be read.");
    }
  }

  try {
    const bytes = readAll(opened.fd, Number(opened.stats.size));
    if (bytes === undefined) return unavailable("host shortcut settings changed while being read.");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return unavailable("host shortcut settings contain malformed JSON.");
    }
    try {
      return { status: "loaded", bindings: parseHostShortcutConfig(value) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the schema or shortcut chord is invalid.";
      return unavailable(`host shortcut settings are invalid (${reason}).`);
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

function existingDestination(path: string): FileIdentity | undefined {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("host shortcut settings path is not a regular file; it was not overwritten");
    }
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDestinationUnchanged(path: string, expected: FileIdentity | undefined): void {
  const current = existingDestination(path);
  if (expected === undefined ? current !== undefined
    : current === undefined || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error("host shortcut settings path changed during save; the existing entry was not overwritten");
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

/** Atomically save one validated host configuration without replacing unsafe paths. */
export function writeHostShortcutConfig(
  agentDir: string,
  proposed: HostShortcutBindings,
  legacyToggleOverride?: string,
): HostShortcutBindings {
  const bindings = normalizeHostShortcutBindings(proposed);
  if (legacyToggleOverride !== undefined) {
    const effectiveToggle = normalizeHostShortcutKey(legacyToggleOverride, "toggle");
    assertHostShortcutsDistinct(effectiveToggle, bindings.returnToMain);
  }
  const stateDir = ensureHostStateDir(agentDir);
  const stateStats = lstatSync(stateDir, { bigint: true });
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink()) {
    throw new Error("host shortcut settings directory is not a real directory");
  }
  const path = join(stateDir, HOST_SHORTCUTS_FILENAME);
  const destination = existingDestination(path);
  const temporary = `${path}.tmp.${randomUUID()}`;
  const body = `${JSON.stringify({ version: 1, ...bindings })}\n`;
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
      throw new Error("host shortcut settings directory changed during save; no settings were replaced");
    }
    assertDestinationUnchanged(path, destination);
    renameSync(temporary, path);
    ownsTemporary = false;
    syncDirectoryBestEffort(stateDir);
    return bindings;
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
    throw new Error("host shortcut settings could not be saved");
  }
}
