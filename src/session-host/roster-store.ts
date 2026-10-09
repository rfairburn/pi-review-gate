import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { MAX_NATIVE_SESSION_NAME_LENGTH, isValidNativeSessionId } from "./protocol";

/**
 * Global session-host roster store and single-host ownership (#331).
 *
 * The optional native session host remembers its sidebar roster in the
 * canonical Pi agent-data directory (`PI_CODING_AGENT_DIR`, otherwise Pi's
 * ordinary `~/.pi/agent`) under `<agentDir>/session-host/`. Nothing here reads
 * the launch cwd, `--state-root`, a config-file directory, or the npm package
 * root: the remembered roster is global agent data, exactly like the native
 * conversations it points at.
 *
 * Two files live in that private directory:
 *
 * - `roster.json` — the bounded ordered roster: for each remembered sidebar
 *   slot, the last observed CURRENT authenticated native conversation id, its
 *   explicit workspace, and optional display name/persistence evidence, plus
 *   the remembered active slot. Publication is a same-directory exclusive temp
 *   file (mode 0600) plus fsync and an atomic rename; a reader observes either
 *   the previous committed roster or the new one.
 * - `host-ownership.json` — the exclusive ownership record of the one host
 *   that may own this agent directory at a time.
 *
 * Fail-closed rules (see docs/session-host-alpha.md and docs/security.md):
 *
 * - A malformed, oversized, unsafe, symlinked, or unreadable roster is
 *   reported truthfully and left untouched. Nothing is restored from it and
 *   nothing overwrites it, so a valid roster is never silently erased by a
 *   damaged read.
 * - Exclusive ownership uses an exclusive create. An existing ownership record
 *   is never stolen, verified around, or repaired: uncertain ownership refuses
 *   with an actionable message, and no process is ever signalled or inspected.
 * - Removal of the ownership record happens only for this host's own exact
 *   record, and only when the caller has settled its owned children.
 */

/** Version of the persisted roster schema; unknown versions are refused. */
export const ROSTER_STORE_VERSION = 1;

/** Private session-host state directory name inside the Pi agent directory. */
export const HOST_STATE_DIRNAME = "session-host";

/** Persisted roster file name inside the private session-host state directory. */
export const ROSTER_FILENAME = "roster.json";

/** Exclusive ownership record file name inside the private state directory. */
export const HOST_OWNERSHIP_FILENAME = "host-ownership.json";

/** Upper bound for remembered roster entries; larger rosters are never published. */
export const MAX_ROSTER_ENTRIES = 64;

/** Upper bound for the whole published roster document. */
export const MAX_ROSTER_FILE_BYTES = 64 * 1024;

/** Upper bound for one remembered workspace path (UTF-16 code units). */
export const MAX_ROSTER_WORKSPACE_CHARS = 4096;

const MAX_SLOT_ID_CHARS = 128;
const MAX_MESSAGE_CHARS = 400;
const MAX_OWNERSHIP_RECORD_BYTES = 4096;

/** Positive native persistence evidence captured with one roster entry. */
export type RosterPersistence = "saved" | "unsaved" | "unknown";

/**
 * One remembered sidebar roster slot. Identity fields are optional because a
 * slot is remembered from the moment its row exists: a child that never reports
 * an authenticated conversation keeps a slot with no `sessionId`, and a slot
 * whose workspace is unknown keeps no `workspace`. Such a slot is never
 * restored as a session; it stays visible as a bounded error row until it is
 * explicitly removed.
 */
export interface RosterEntry {
  /** Stable slot key; survives native /new and /resume conversation changes. */
  readonly slotId: string;
  /** Last observed CURRENT authenticated native conversation id, when observed. */
  readonly sessionId?: string;
  /** Explicit workspace of the remembered conversation, when known. */
  readonly workspace?: string;
  /** Last observed native conversation name (display only). */
  readonly name?: string;
  /** Last observed native persistence evidence for this binding. */
  readonly persistence?: RosterPersistence;
}

/** The whole persisted roster document. */
export interface StoredRoster {
  readonly version: typeof ROSTER_STORE_VERSION;
  readonly entries: readonly RosterEntry[];
  /** Remembered active slot; never a manager row id from another host run. */
  readonly activeSlotId?: string;
}

function isBoundedText(value: unknown, maxChars: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value);
}

/** A publishable remembered workspace: bounded, single-line, control-free. */
export function isValidRosterWorkspace(value: unknown): value is string {
  return isBoundedText(value, MAX_ROSTER_WORKSPACE_CHARS);
}

/**
 * The native protocol's authenticated display-name bound (Unicode code points
 * and UTF-8 bytes, not UTF-16 code units): a valid supplementary-Unicode name
 * must never make the whole roster unpublishable.
 */
export function isValidRosterName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim() === value
    && Array.from(value).length <= MAX_NATIVE_SESSION_NAME_LENGTH
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_SESSION_NAME_LENGTH * 4
    && !/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value);
}

function isPersistence(value: unknown): value is RosterPersistence {
  return value === "saved" || value === "unsaved" || value === "unknown";
}

/**
 * Validate one persisted roster document. Any unknown version, malformed
 * entry, duplicate slot, oversized value, or missing active slot refuses the
 * whole document: a partially understood roster is never trusted or rewritten.
 */
export function parseStoredRoster(value: unknown): StoredRoster | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== ROSTER_STORE_VERSION) return undefined;
  if (!Array.isArray(record.entries) || record.entries.length > MAX_ROSTER_ENTRIES) return undefined;
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const raw of record.entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    if (!isBoundedText(entry.slotId, MAX_SLOT_ID_CHARS) || seen.has(entry.slotId)) return undefined;
    if (entry.sessionId !== undefined && !isValidNativeSessionId(entry.sessionId)) return undefined;
    if (entry.workspace !== undefined && !isValidRosterWorkspace(entry.workspace)) return undefined;
    if (entry.name !== undefined && !isValidRosterName(entry.name)) return undefined;
    if (entry.persistence !== undefined && !isPersistence(entry.persistence)) return undefined;
    seen.add(entry.slotId);
    entries.push({
      slotId: entry.slotId,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.workspace !== undefined ? { workspace: entry.workspace } : {}),
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.persistence !== undefined ? { persistence: entry.persistence } : {}),
    });
  }
  if (record.activeSlotId !== undefined) {
    if (!isBoundedText(record.activeSlotId, MAX_SLOT_ID_CHARS) || !seen.has(record.activeSlotId)) return undefined;
  }
  return {
    version: ROSTER_STORE_VERSION,
    entries,
    ...(record.activeSlotId !== undefined ? { activeSlotId: record.activeSlotId } : {}),
  };
}

/** The private session-host state directory for one canonical Pi agent directory. */
export function sessionHostStateDir(agentDir: string): string {
  return join(agentDir, HOST_STATE_DIRNAME);
}

/** Lexical location of the persisted roster (diagnostics and tests only). */
export function rosterStorePath(agentDir: string): string {
  return join(sessionHostStateDir(agentDir), ROSTER_FILENAME);
}

/** Lexical location of the exclusive ownership record (diagnostics and tests only). */
export function hostOwnershipPath(agentDir: string): string {
  return join(sessionHostStateDir(agentDir), HOST_OWNERSHIP_FILENAME);
}

/**
 * Ensure the caller's Pi agent directory is a real directory and its private
 * session-host state directory exists (mode 0700 when created). A symlinked or
 * non-directory agent or state directory refuses: the store is never followed
 * somewhere else.
 */
export function ensureHostStateDir(agentDir: string): string {
  if (typeof agentDir !== "string" || agentDir === "" || !isAbsolute(agentDir)) {
    throw new Error("session-host: the native Pi agent directory must be an absolute path");
  }
  let agentStats: Stats;
  try {
    agentStats = lstatSync(agentDir);
  } catch {
    throw new Error("session-host: the native Pi agent directory does not exist");
  }
  if (agentStats.isSymbolicLink() || !agentStats.isDirectory()) {
    throw new Error("session-host: the native Pi agent directory is not a real directory");
  }
  const canonical = realpathSync(agentDir);
  const stateDir = join(canonical, HOST_STATE_DIRNAME);
  try {
    mkdirSync(stateDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw new Error("session-host: the session-host state directory could not be created");
    }
  }
  let stateStats: Stats;
  try {
    stateStats = lstatSync(stateDir);
  } catch {
    throw new Error("session-host: the session-host state directory could not be inspected");
  }
  if (stateStats.isSymbolicLink() || !stateStats.isDirectory()) {
    throw new Error("session-host: the session-host state directory is not a real directory");
  }
  return stateDir;
}

function syncDirectoryBestEffort(directory: string): void {
  try {
    const fd = openSync(directory, fsConstants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some platforms/filesystems do not permit directory fsync.
  }
}

/** Durable atomic publication of one roster document inside its owned state directory. */
function publishRoster(stateDir: string, roster: StoredRoster): void {
  const body = `${JSON.stringify(roster)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_ROSTER_FILE_BYTES) {
    throw new Error("session-host: the session-host roster exceeds the supported size");
  }
  const path = join(stateDir, ROSTER_FILENAME);
  // An unknown, foreign, symlinked, or special entry at the roster path is never
  // silently overwritten: publication refuses and the existing entry is kept.
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("session-host: the session-host roster path is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.tmp.${randomUUID()}`;
  let fd: number | undefined;
  let ownsTemp = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    ownsTemp = true;
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // The rename is the commit point; the previous committed roster stays
    // intact until it succeeds.
    renameSync(temporary, path);
    ownsTemp = false;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the publication error.
      }
    }
    if (ownsTemp) {
      try {
        unlinkSync(temporary);
      } catch {
        // The owned unpublished temporary file remains; publication still failed.
      }
    }
    throw error;
  }
  syncDirectoryBestEffort(stateDir);
}

/** Publish a validated roster for one canonical Pi agent directory. Throws on failure. */
export function writeRosterStore(agentDir: string, roster: StoredRoster): void {
  const parsed = parseStoredRoster(roster);
  if (parsed === undefined) {
    throw new Error("session-host: the session-host roster to publish is not a valid bounded roster");
  }
  publishRoster(ensureHostStateDir(agentDir), parsed);
}

export type RosterReadResult =
  | { status: "absent" }
  | { status: "loaded"; roster: StoredRoster }
  | { status: "unavailable"; reason: string };

/**
 * Open one existing entry read-only without ever blocking: the type is checked
 * BEFORE the open (an unconditional read open of a FIFO blocks forever) and the
 * open itself is non-blocking and no-follow where the platform supports it.
 * Returns the descriptor plus the pre-open identity for a post-open recheck.
 */
function openExistingRegularFile(path: string, maxBytes: number):
  | { fd: number; preStats: BigIntStats }
  | { reason: "absent" | "unsafe" | "oversized" | "unreadable" } {
  let preStats: BigIntStats;
  try {
    preStats = lstatSync(path, { bigint: true });
  } catch (error) {
    return { reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  // A symlink, FIFO, socket, device, or directory is never opened: the read
  // open of a FIFO would block indefinitely before any type check could run.
  if (preStats.isSymbolicLink() || !preStats.isFile()) return { reason: "unsafe" };
  if (preStats.size > BigInt(maxBytes)) return { reason: "oversized" };
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { reason: "unreadable" };
  }
  // The opened descriptor must be the SAME regular file that was inspected: a
  // regular-file replacement between lstat and open is refused, and a special
  // file swapped in cannot reach the bounded read.
  let stats: BigIntStats;
  try {
    stats = fstatSync(fd, { bigint: true });
  } catch {
    try {
      closeSync(fd);
    } catch {
      // Preserve the refusal.
    }
    return { reason: "unreadable" };
  }
  if (!stats.isFile() || stats.dev !== preStats.dev || stats.ino !== preStats.ino) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the refusal.
    }
    return { reason: "unsafe" };
  }
  if (stats.size > BigInt(maxBytes)) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the refusal.
    }
    return { reason: "oversized" };
  }
  return { fd, preStats: stats };
}

/** Bounded descriptor read; undefined when the file changed size while reading. */
function readAll(fd: number, size: number): Buffer | undefined {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    let read: number;
    try {
      read = readSync(fd, buffer, offset, size - offset, offset);
    } catch {
      return undefined;
    }
    if (read <= 0) break;
    offset += read;
  }
  return offset === size ? buffer : undefined;
}

/**
 * Read the persisted roster without touching it. A missing roster is honestly
 * absent; every other unreadable, unsafe, oversized, or malformed state is
 * reported with a bounded truthful reason and left exactly as found.
 */
export function readRosterStore(agentDir: string): RosterReadResult {
  const path = rosterStorePath(agentDir);
  const opened = openExistingRegularFile(path, MAX_ROSTER_FILE_BYTES);
  if (!("fd" in opened)) {
    switch (opened.reason) {
      case "absent":
        return { status: "absent" };
      case "unsafe":
        return { status: "unavailable", reason: "The session-host roster is not a regular file; it was left untouched." };
      case "oversized":
        return {
          status: "unavailable",
          reason: `The session-host roster exceeds the ${MAX_ROSTER_FILE_BYTES}-byte supported size; it was left untouched.`,
        };
      default:
        return { status: "unavailable", reason: "The session-host roster could not be read; it was left untouched." };
    }
  }
  const { fd } = opened;
  try {
    const buffer = readAll(fd, Number(opened.preStats.size));
    if (buffer === undefined) {
      return { status: "unavailable", reason: "The session-host roster changed while it was read; it was left untouched." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      return { status: "unavailable", reason: "The session-host roster is malformed JSON; it was left untouched." };
    }
    const roster = parseStoredRoster(parsed);
    if (roster === undefined) {
      return {
        status: "unavailable",
        reason: "The session-host roster has an unsupported or malformed schema; it was left untouched.",
      };
    }
    return { status: "loaded", roster };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not replace the bounded read result.
    }
  }
}

function summarizePath(path: string): string {
  return path.length <= 80 ? path : `…${path.slice(-79)}`;
}

function ownershipRefusal(agentDir: string, ownershipPath: string): string {
  return `Session host refused: another session host already owns the Pi agent directory `
    + `${summarizePath(agentDir)}. Close that host and let it finish; only remove `
    + `${summarizePath(ownershipPath)} once you have established that none of its owned sessions are still running.`;
}

function boundedMessage(message: string): string {
  return message.length <= MAX_MESSAGE_CHARS ? message : `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * One successfully opened global host state: exclusive ownership of the
 * canonical Pi agent directory plus its persisted roster.
 */
export interface HostStateHandle {
  /** Canonical real path of the owned Pi agent directory. */
  readonly agentDir: string;
  /** This host's ownership id. */
  readonly hostId: string;
  /** Location of the ownership record this host created. */
  readonly ownershipPath: string;
  /** Persisted roster observed at open; absent when none existed. */
  readonly roster: StoredRoster | undefined;
  /**
   * Bounded truthful problem with the persisted store. When set, the roster is
   * not restored and persistence is disabled so untouched user data is never
   * overwritten.
   */
  readonly problem: string | undefined;
  /** Persist the roster; false on any failure (never throws). */
  persist(roster: StoredRoster): boolean;
  /**
   * Remove this host's own ownership record. Returns true only when it was
   * positively removed (or already released by this handle); a foreign or
   * unreadable record is preserved and reports false.
   */
  release(): boolean;
}

export type HostStateOpenResult =
  | { status: "opened"; state: HostStateHandle }
  | { status: "refused"; message: string };

/**
 * Acquire exclusive ownership of one canonical Pi agent directory and read its
 * persisted roster. Ownership is established before any roster entry or child
 * exists, and an existing or uncertain ownership record refuses instead of
 * being stolen or verified around.
 */
export function openHostState(options: { agentDir: string; hostId: string }): HostStateOpenResult {
  const hostId = options?.hostId;
  if (typeof hostId !== "string" || hostId === "") {
    return { status: "refused", message: "Session host refused: the session host ownership id is unavailable." };
  }
  let stateDir: string;
  let canonicalAgentDir: string;
  try {
    stateDir = ensureHostStateDir(options.agentDir);
    canonicalAgentDir = realpathSync(options.agentDir);
  } catch (error) {
    return {
      status: "refused",
      message: boundedMessage(error instanceof Error
        ? error.message
        : "session-host: the native Pi agent directory is unavailable"),
    };
  }
  const ownershipPath = join(stateDir, HOST_OWNERSHIP_FILENAME);
  try {
    const fd = openSync(ownershipPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({
        version: 1,
        hostId,
        pid: process.pid,
        agentDir: canonicalAgentDir,
        startedAt: new Date().toISOString(),
      })}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectoryBestEffort(stateDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return { status: "refused", message: boundedMessage(ownershipRefusal(canonicalAgentDir, ownershipPath)) };
    }
    return {
      status: "refused",
      message: boundedMessage(`Session host refused: exclusive ownership of the Pi agent directory could not be `
        + `established (${typeof code === "string" ? code : "unknown error"}).`),
    };
  }

  const read = readRosterStore(canonicalAgentDir);
  let released = false;
  const state: HostStateHandle = {
    agentDir: canonicalAgentDir,
    hostId,
    ownershipPath,
    roster: read.status === "loaded" ? read.roster : undefined,
    problem: read.status === "unavailable" ? read.reason : undefined,
    persist(roster: StoredRoster): boolean {
      if (read.status === "unavailable") return false;
      const parsed = parseStoredRoster(roster);
      if (parsed === undefined) return false;
      try {
        publishRoster(stateDir, parsed);
        return true;
      } catch {
        return false;
      }
    },
    release(): boolean {
      if (released) return true;
      // The ownership record is read with the same never-blocking rule as the
      // roster: a replaced, symlinked, oversized, or special entry is preserved
      // and reports an unconfirmed release instead of being opened or removed.
      const opened = openExistingRegularFile(ownershipPath, MAX_OWNERSHIP_RECORD_BYTES);
      if (!("fd" in opened)) return false;
      let ownsRecord = false;
      try {
        const buffer = readAll(opened.fd, Number(opened.preStats.size));
        if (buffer !== undefined) {
          try {
            const parsed: unknown = JSON.parse(buffer.toString("utf8"));
            ownsRecord = typeof parsed === "object" && parsed !== null
              && (parsed as { hostId?: unknown }).hostId === hostId;
          } catch {
            ownsRecord = false;
          }
        }
      } finally {
        try {
          closeSync(opened.fd);
        } catch {
          // A close failure never turns an unverified record into ours.
        }
      }
      if (!ownsRecord) return false;
      try {
        unlinkSync(ownershipPath);
        released = true;
      } catch {
        return false;
      }
      syncDirectoryBestEffort(stateDir);
      return true;
    },
  };
  return { status: "opened", state };
}
