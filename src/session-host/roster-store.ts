import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  readFileSync,
  statSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

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

/**
 * Per-agent coordination entry shared with producer-owned cache reclamation.
 * It is a short-lived lock, never a second lifetime registry: it makes taking
 * host ownership mutually exclusive with destructive cache cleanup, and a stale
 * or malformed one is reclaimed rather than treated as state.
 */
export const HOST_COORDINATION_FILENAME = "host-coordination.lock";

/** Bounded wait for a busy coordination entry before continuing uncoordinated. */
const COORDINATION_POLL_MS = 25;
/**
 * A current holder is waited for without any elapsed-time bypass: while it is
 * alive it may be inside the destructive critical section that would delete this
 * host's prepared runtime, so ownership is never claimed behind its back. Only a
 * genuinely unremovable artifact (a real filesystem failure, not stale metadata)
 * ends the wait.
 */
const COORDINATION_UNREMOVABLE_DEADLINE_MS = 120_000;
/** Bounded canonical record: `<pid>\n<owner identity>\n`. */
const MAX_COORDINATION_BYTES = 192;

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

/** Fixed outcome of one exclusive private creation attempt (Refs #494). */
export type SessionHostStateDirectoryCreation =
  | { readonly outcome: "existing" }
  | { readonly outcome: "created-protected" }
  | { readonly outcome: "created-unverified"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

type StateDirectoryCreator = (stateDir: string) => unknown;

let stateDirectoryCreator: StateDirectoryCreator | null | undefined;

/**
 * Lazily load the shared dependency-free creator. Both shipped layouts keep
 * `scripts/` beside the compiled tree (`<root>/dist/src/session-host` and
 * `<root>/scripts`), exactly as the launcher resolver in `pi-invocation.ts`
 * relies on. A missing or malformed module is `null`: callers then keep their
 * previous plain creation and claim no protection.
 */
function loadStateDirectoryCreator(): StateDirectoryCreator | null {
  if (stateDirectoryCreator !== undefined) return stateDirectoryCreator;
  let loaded: unknown;
  try {
    loaded = require(resolve(__dirname, "../../../scripts/session-host-state-directory.cjs"));
  } catch {
    loaded = undefined;
  }
  const candidate = typeof loaded === "object" && loaded !== null
    ? (loaded as Record<string, unknown>).createPrivateStateDirectory
    : undefined;
  stateDirectoryCreator = typeof candidate === "function" ? (candidate as StateDirectoryCreator) : null;
  return stateDirectoryCreator;
}

/**
 * Exclusively create `<agentDir>/session-host` with private protection when it
 * is absent (POSIX `0700` with no extended ACL; Windows a protected DACL for this
 * account, LocalSystem, and built-in Administrators set at creation).
 *
 * An existing object of any kind is `existing` and is never inspected for
 * repair, chmod'd, re-ACL'd, or re-owned. `created-protected` is claimed only
 * after real evidence from the created object; `created-unverified` means the
 * directory now exists but no protection is claimed; `failed` means this call
 * created nothing. The caller owns the canonical, real agent directory; this
 * neither creates nor modifies any ancestor. Reasons are fixed strings only.
 */
export function createSessionHostStateDirectory(stateDir: string): SessionHostStateDirectoryCreation {
  const creator = loadStateDirectoryCreator();
  if (creator === null) return { outcome: "failed", reason: "protection-unsupported" };
  let raw: unknown;
  try {
    raw = creator(stateDir);
  } catch {
    raw = undefined;
  }
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const reason = typeof record.reason === "string" ? record.reason : "protection-unsupported";
  switch (record.outcome) {
    case "existing":
      return { outcome: "existing" };
    case "created-protected":
      return { outcome: "created-protected" };
    case "created-unverified":
      return { outcome: "created-unverified", reason };
    default:
      return { outcome: "failed", reason };
  }
}

/**
 * Ensure the caller's Pi agent directory is a real directory and its private
 * session-host state directory exists. A symlinked or non-directory agent or
 * state directory refuses: the store is never followed somewhere else.
 *
 * A genuinely absent state directory is created exclusively with private
 * protection (see {@link createSessionHostStateDirectory}). That protection is
 * an addition only: when it cannot be established or verified, the previous
 * plain `mkdir(0700)` behaviour and every local roster, ownership, shortcut and
 * diagnostics outcome stay exactly as before, and the protected Network stores
 * refuse the unverified directory on their own checks. An existing directory is
 * never modified.
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
  createSessionHostStateDirectory(stateDir);
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

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownerIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

type CoordinationAcquisition =
  /** This host now holds the entry and must release it when ownership exists. */
  | { status: "held"; release(): void }
  /**
   * This process already holds the entry (the launcher's coordinated
   * selection/preparation handoff). A single-threaded process cannot be running a
   * destructive pass at the same time, so ownership is claimed inside that hold
   * and the hold is handed back once the record exists.
   */
  | { status: "self" }
  /**
   * A genuine unremovable-artifact or IO failure ended the wait. Ownership still
   * proceeds: the exclusive record plus producer-side boundary rechecks remain
   * authoritative, and this is never reported as a verification gate.
   */
  | { status: "unavailable" };

/** First existing standard OS location for one required helper binary. */
function standardBinary(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next standard location.
    }
  }
  return undefined;
}

/** Boot identity for Linux starttime tokens (a reboot invalidates starttimes). */
function linuxBootIdentity(): string {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (/^[0-9a-f-]{8,64}$/u.test(id)) return id;
  } catch {
    // Fall through to the kernel boot time.
  }
  try {
    const match = /^btime\s+(\d{1,12})$/mu.exec(readFileSync("/proc/stat", "utf8"));
    if (match) return `btime-${match[1]}`;
  } catch {
    // No boot identity is available.
  }
  return "";
}

/**
 * Target single-pid process-start token in one exact per-platform format so a
 * writer and a reader agree byte for byte: `linux:<boot>:<starttime ticks>` from
 * this single pid's `/proc/<pid>/stat` (no procps `ps` needed), `darwin:<ps lstart
 * token>` from one targeted `ps` query pinned to UTC and the C locale (the
 * rendering carries no zone of its own, so a caller-local one would let the same
 * live process look like a different owner after a timezone or DST change), or
 * `win32:<StartTime round-trip>` from one targeted native PowerShell query (the
 * same facility and format the PowerShell producer uses, with its explicit UTC
 * offset). Exactly one pid, never a census, and no third-party package; an
 * empty result means the identity genuinely cannot be established.
 */
function ownerStartIdentity(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return "";
      const starttime = stat.slice(close + 1).trim().split(/\s+/u)[19];
      if (!starttime || !/^[0-9]{1,20}$/u.test(starttime)) return "";
      const boot = linuxBootIdentity();
      if (!boot) return "";
      return `linux:${boot}:${starttime}`;
    } catch {
      return "";
    }
  }
  if (process.platform === "darwin") {
    const ps = standardBinary(["/bin/ps", "/usr/bin/ps"]);
    if (!ps) return "";
    try {
      const output = execFileSync(ps, ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
        // Pinned so the token is byte-identical to the CJS and POSIX writers on
        // every host, independent of the caller's timezone or locale.
        env: { ...process.env, TZ: "UTC0", LC_ALL: "C", LANG: "C" },
      });
      const token = String(output).replace(/\s+/gu, " ").trim();
      return token.length > 0 && token.length <= MAX_COORDINATION_BYTES - 48 ? `darwin:${token}` : "";
    } catch {
      return "";
    }
  }
  if (process.platform === "win32") {
    const powershell = standardBinary([
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe`,
    ]);
    if (!powershell) return "";
    // Exactly one known numeric pid, passed as a fixed argv entry (never composed
    // into a shell string), bounded and non-interactive.
    const script = "& { param([int]$OwnerPid) try { $p = Get-Process -Id $OwnerPid -ErrorAction Stop; "
      + "[Console]::Out.Write('win32:' + $p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)) } "
      + "catch { exit 2 } }";
    try {
      const output = execFileSync(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", script, String(pid),
      ], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const token = String(output).trim();
      return /^win32:.{4,}$/u.test(token) && token.length <= MAX_COORDINATION_BYTES - 48 ? token : "";
    } catch {
      return "";
    }
  }
  return "";
}

// This process's own owner identity. The token is immutable once established, so
// a positive result is cached forever; a failed query is never cached, because a
// transient `ps`/`/proc` failure at load would otherwise permanently prevent this
// host from publishing or recognizing its own coordination hold (and would leave
// it waiting forever on a hold that is its own).
let OWN_OWNER_IDENTITY_CACHE = "";
function ownOwnerIdentity(): string {
  if (OWN_OWNER_IDENTITY_CACHE === "") {
    // Retried on every call until it succeeds: a transient failure must never
    // disable publishing or self-adoption for the rest of the host's life.
    const observed = ownerStartIdentity(process.pid);
    if (observed !== "") OWN_OWNER_IDENTITY_CACHE = observed;
  }
  return OWN_OWNER_IDENTITY_CACHE;
}
// Learn this host's identity once at load; a failure here is retried above.
OWN_OWNER_IDENTITY_CACHE = ownerStartIdentity(process.pid);

interface CoordinationRecord {
  readonly pid: number;
  /** Empty when the platform (or a Windows writer) records no start identity. */
  readonly identity: string;
}

function parseCoordinationRecord(text: string): CoordinationRecord | undefined {
  const newline = text.indexOf("\n");
  if (newline < 0) return undefined;
  const pidText = text.slice(0, newline).trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(pidText)) return undefined;
  const identity = text.slice(newline + 1).replace(/\n+$/u, "");
  if (identity.length > MAX_COORDINATION_BYTES - 32) return undefined;
  return { pid: Number(pidText), identity };
}

/**
 * True only while the record's pid is alive AND still reports the recorded start
 * identity, so an abandoned record whose pid was reused by an unrelated live
 * process is never honored forever. A record without a birth identity is never
 * honored on any platform. A birth query that temporarily fails is NOT a proven
 * mismatch: the pid is alive, so the record may still be a live holder and is
 * honored rather than stolen (stealing it mid-destructive-pass would let a second
 * actor claim ownership beside an active deletion).
 */
function coordinationOwnerIsCurrent(record: CoordinationRecord | undefined): boolean {
  if (!record || !ownerIsAlive(record.pid)) return false;
  // A record without a birth identity is never honored: pid-only metadata could
  // otherwise be pinned forever behind an unrelated live process.
  if (record.identity === "") return false;
  const observed = ownerStartIdentity(record.pid);
  if (observed === "") return true;
  return observed === record.identity;
}

/** Bounded no-follow read; a valid record is accepted at nlink 1 or 2. */
function readCoordinationRecord(entryPath: string): CoordinationRecord | undefined {
  let before: BigIntStats;
  try {
    before = lstatSync(entryPath, { bigint: true });
  } catch {
    return undefined;
  }
  if (before.isSymbolicLink() || !before.isFile()) return undefined;
  if (before.nlink !== 1n && before.nlink !== 2n) return undefined;
  if (before.size > BigInt(MAX_COORDINATION_BYTES)) return undefined;
  let fd: number;
  try {
    fd = openSync(entryPath, fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const bytes = Buffer.alloc(MAX_COORDINATION_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    return parseCoordinationRecord(bytes.subarray(0, Math.min(length, MAX_COORDINATION_BYTES)).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The parsed record stands; only the descriptor is lost.
    }
  }
}

/**
 * Prepare this process's coordination record as a private, already-complete
 * candidate. Publication is a separate atomic step, so a paused publisher can
 * never expose a half-written canonical entry.
 */
function prepareCoordinationCandidate(stateDir: string): { candidate: string; publish(entryPath: string): "published" | "lost" | "failed" } | undefined {
  const candidate = join(stateDir, `${HOST_COORDINATION_FILENAME}.${process.pid}.${randomUUID().slice(0, 8)}`);
  let fd: number | undefined;
  try {
    fd = openSync(candidate, "wx", 0o600);
    try {
      writeFileSync(fd, `${process.pid}\n${ownOwnerIdentity()}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      // Preserve the failure.
    }
    return undefined;
  }
  return {
    candidate,
    /**
     * Atomic no-overwrite publish: `link` fails with EEXIST when another holder
     * already published, so an existing entry is never overwritten and this
     * publisher never adopts it.
     */
    publish(entryPath: string): "published" | "lost" | "failed" {
      try {
        linkSync(candidate, entryPath);
        return "published";
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "lost" : "failed";
      } finally {
        try {
          unlinkSync(candidate);
        } catch {
          // A leftover candidate is private residue, never a gate.
        }
      }
    },
  };
}

/**
 * Remove exactly the observed coordination entry name; a link is unlinked itself
 * (never followed, and one hard link's removal never touches another name's
 * bytes), and a directory shape is removed only when empty.
 */
function reclaimCoordinationEntry(entryPath: string, observedIdentity: string): "reclaimed" | "kept" | "failed" {
  let stat: BigIntStats;
  try {
    stat = lstatSync(entryPath, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "reclaimed" : "failed";
  }
  if (`${stat.dev}:${stat.ino}` !== observedIdentity) return "kept";
  try {
    if (stat.isDirectory() && !stat.isSymbolicLink()) rmdirSync(entryPath);
    else unlinkSync(entryPath);
    return "reclaimed";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "reclaimed" : "failed";
  }
}

/**
 * Publish this process's coordination record for diagnostics and deterministic
 * regressions (the same complete candidate plus atomic no-overwrite link the
 * ownership acquisition uses). Returns false when the record could not be
 * published, including when the owner identity is genuinely unavailable.
 */
export function publishHostCoordinationRecord(stateDir: string): boolean {
  if (ownOwnerIdentity() === "") return false;
  const candidate = prepareCoordinationCandidate(stateDir);
  if (!candidate) return false;
  return candidate.publish(join(stateDir, HOST_COORDINATION_FILENAME)) === "published";
}

/**
 * Hand back a coordination entry this same process holds, once ownership exists.
 * Only this process's own published record is removed.
 */
function releaseSelfCoordination(stateDir: string): void {
  const entryPath = join(stateDir, HOST_COORDINATION_FILENAME);
  const record = readCoordinationRecord(entryPath);
  if (!record || record.pid !== process.pid || record.identity !== ownOwnerIdentity()) return;
  try {
    unlinkSync(entryPath);
  } catch {
    // A replaced or already-removed entry is not ours to remove.
  }
}

/**
 * Take the canonical per-agent coordination mutex that producer cache
 * reclamation also takes. A current holder is honored (this host waits for the
 * whole bounded destructive pass), stale/reused-pid/malformed metadata is
 * reclaimed confined to the entry, and only a genuine unremovable artifact ends
 * the wait.
 */
function acquireHostCoordination(stateDir: string): CoordinationAcquisition {
  const entryPath = join(stateDir, HOST_COORDINATION_FILENAME);
  let malformed = 0;
  let malformedIdentity: string | undefined;
  let unremovableSince: number | undefined;
  for (;;) {
    const ownIdentity = ownOwnerIdentity();
    if (ownIdentity === "") {
      // Honest failure: a pid-only record would pin a later start behind a reused
      // pid forever, so no record is published at all.
      return { status: "unavailable" };
    }
    const candidate = prepareCoordinationCandidate(stateDir);
    if (!candidate) return { status: "unavailable" };
    const outcome = candidate.publish(entryPath);
    if (outcome === "published") {
      let created: BigIntStats;
      try {
        created = lstatSync(entryPath, { bigint: true });
      } catch {
        return { status: "unavailable" };
      }
      const createdIdentity = `${created.dev}:${created.ino}`;
      return {
        status: "held",
        release(): void {
          const record = readCoordinationRecord(entryPath);
          if (!record || record.pid !== process.pid) return;
          let observed: BigIntStats;
          try {
            observed = lstatSync(entryPath, { bigint: true });
          } catch {
            return;
          }
          if (`${observed.dev}:${observed.ino}` !== createdIdentity) return;
          try {
            unlinkSync(entryPath);
          } catch {
            // A replaced or already-removed entry is not ours to remove.
          }
        },
      };
    }
    if (outcome === "failed") return { status: "unavailable" };
    let observed: BigIntStats;
    try {
      observed = lstatSync(entryPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Another holder settled it between attempts; retry publication.
        malformed = 0;
        malformedIdentity = undefined;
        continue;
      }
      return { status: "unavailable" };
    }
    const observedIdentity = `${observed.dev}:${observed.ino}`;
    const record = readCoordinationRecord(entryPath);
    if (record && record.pid === process.pid) {
      // A record naming this very pid can only be this process's own hold or a
      // predecessor's residue with a reused number; no other live process can
      // hold it. Self-adoption requires a matching birth identity so a pid-only or
      // unverifiable record is never adopted, and it is never waited on either —
      // waiting on ourselves would deadlock the launcher/host handoff forever.
      if (record.identity === ownIdentity) return { status: "self" };
    } else if (coordinationOwnerIsCurrent(record)) {
      malformed = 0;
      malformedIdentity = undefined;
      unremovableSince = undefined;
      sleepSync(COORDINATION_POLL_MS);
      continue;
    }
    if (record === undefined) {
      if (observedIdentity !== malformedIdentity) {
        malformed = 0;
        malformedIdentity = observedIdentity;
      }
      malformed += 1;
      if (malformed < 3) {
        sleepSync(COORDINATION_POLL_MS);
        continue;
      }
      malformed = 0;
      malformedIdentity = undefined;
    }
    const reclaimed = reclaimCoordinationEntry(entryPath, observedIdentity);
    if (reclaimed === "failed") {
      if (unremovableSince === undefined) unremovableSince = performance.now();
      if (performance.now() - unremovableSince >= COORDINATION_UNREMOVABLE_DEADLINE_MS) {
        return { status: "unavailable" };
      }
      sleepSync(COORDINATION_POLL_MS);
      continue;
    }
    unremovableSince = undefined;
  }
}

/**
 * Acquire exclusive ownership of one canonical Pi agent directory and read its
 * persisted roster. Ownership is established before any roster entry or child
 * exists, and an existing or uncertain ownership record refuses instead of being
 * stolen or verified around. Ownership acquisition takes the per-agent
 * coordination boundary that destructive cache reclamation also takes, so an
 * already-authorized cleanup can never delete this host's prepared runtime while
 * it becomes the owner. When this process already holds that boundary — the
 * launcher's coordinated selection/preparation handoff — ownership is claimed
 * inside the existing hold and the boundary is handed back once the ownership
 * record exists, so no last-moment artifact proof or new startup refusal is
 * needed.
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
  // Take the per-agent coordination boundary for the exclusive create only, and
  // release it as soon as this host's record exists: a producer waiting on it
  // then sees the ownership record and leaves this host's cache alone. A live
  // holder is waited for, because it may be inside the destructive pass that
  // would delete the prepared runtime; only a genuinely unremovable artifact
  // ends that wait, and then ownership is not claimed at all.
  const coordination = acquireHostCoordination(stateDir);
  // A genuine unremovable-artifact/IO failure is not a verification gate: this
  // host still takes its existing exclusive ownership record, and producer
  // cleanup rechecks that record at every destructive boundary. Stale or
  // malformed metadata has already been reclaimed above.
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
  } finally {
    if (coordination.status === "held") coordination.release();
    // The launcher's coordinated handoff: this process already held the entry,
    // and ownership now exists, so the hold ends exactly here.
    else if (coordination.status === "self") releaseSelfCoordination(stateDir);
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
