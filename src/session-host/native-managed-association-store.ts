import { createHash, randomUUID } from "node:crypto";
import {
  close, constants as fsConstants, fstatSync, fsync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFile,
} from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalStableJson } from "../canonical-json";
import type { ExecutionAssociationsSnapshot, PersistedConflictGate } from "../session-state";
import type { ReattachmentBundle } from "../execution/operation-record";
import { isNativeConversationId } from "./native-conversation";
import { isValidRosterWorkspace } from "./roster-store";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";

/**
 * Private persistence of execution associations owned by ONE exact hosted native
 * (Claude/Codex) conversation (Refs #682, independent production primitive).
 *
 * A native conversation has no Pi session file, so its managed delegated-work
 * associations cannot ride the Pi session-state sidecar. This store keeps the
 * existing {@link ExecutionAssociationsSnapshot} shape — nothing new is
 * invented about what an association is — in a bounded private file inside an
 * already trusted session-host state root.
 *
 * Trust boundary:
 * - The caller (the instance manager) owns authentication. It supplies the
 *   trusted host state root and the exact owner key it has already confirmed:
 *   roster slot, native backend, confirmed provider conversation id and the
 *   canonical workspace. Nothing here is ever derived from model input, and no
 *   path is accepted from the model.
 * - The owner key selects the file (a domain-separated SHA-256 of the exact
 *   key), and the full key is also stored inside the document and compared
 *   exactly on every read and before every replacement. A different
 *   conversation in the same slot (native /new or /resume), another backend,
 *   or another workspace therefore resolves to a different file and can never
 *   load or replace a prior owner's associations.
 *
 * Fail-closed rules (mirroring the roster and session-state stores):
 * - `absent` is reported only when the owner's file (or the store directory)
 *   genuinely does not exist. Every unsafe, oversized, unreadable, changing,
 *   malformed, unsupported, integrity-failing or owner-mismatched state is
 *   `unavailable` with a fixed reason and is left exactly as found. File
 *   content is never quoted.
 * - Input associations are copied in one validating pass that reads every
 *   field once, rejects sparse arrays, and enforces a serialized-size lower
 *   bound before anything is cloned or serialized, so a save never publishes a
 *   document its own reader would reject and never allocates an unbounded copy.
 * - A save first re-validates whatever sits at the owner's path; anything
 *   other than absent or a valid document of the same exact owner refuses the
 *   save, so malformed or foreign state is never overwritten to "recover".
 * - Publication is a same-directory exclusive temp file (mode 0600) that is
 *   written, fsynced and closed. Immediately before the atomic rename the store
 *   rechecks that the state root and store directory are the same directories,
 *   that the staging entry is still this call's own file with exactly the
 *   validated bytes, and that the target is still exactly what was validated
 *   (absent stays absent; a validated document keeps its identity and bytes).
 *   Any difference refuses and leaves every entry it did not create untouched.
 *   `published` is reported only after the rename commits; on any earlier
 *   failure the staging file is removed only when it still positively
 *   identifies as this call's file in the verified directory. The directory
 *   fsync after the commit is best-effort (some platforms refuse it) and goes
 *   only through a no-follow, non-blocking descriptor verified to be the
 *   directory the save committed in; it never fails a committed save. The
 *   byte comparisons keep each file's identity, size and modification/change
 *   times, and the final path checks (both directories, the staging entry and
 *   the target entry) plus the rename then run synchronously without yielding.
 *   This is not a portable compare-and-replace: an uncooperative process can
 *   still race the final syscalls, and a same-size in-place rewrite within one
 *   timestamp tick is invisible on coarse-timestamp filesystems.
 *   Cross-process exclusivity comes from host ownership of the state root.
 *
 * Out of scope here by design: saved Review Gate settings, controller/roster
 * schemas, permission policy, cleanup or garbage collection of retired owners'
 * files, callbacks, and production startup activation.
 */

/** Subdirectory of the trusted host state root that holds one file per owner. */
export const NATIVE_MANAGED_ASSOCIATIONS_DIRNAME = "native-managed-associations";
/** Fixed document format marker. */
export const NATIVE_MANAGED_ASSOCIATIONS_FORMAT = "pi-review-gate-native-managed-associations";
/** The only document version this store reads or writes. */
export const NATIVE_MANAGED_ASSOCIATIONS_VERSION = 1;
/** Upper bound of one persisted owner document. */
export const MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES = 256 * 1024;

const MAX_SLOT_ID_CHARS = 128;
const MAX_ASSOCIATION_TEXT_CHARS = 4096;
const OWNER_KEY_DOMAIN = "pi-review-gate-native-managed-association-owner:v1";
const DOCUMENT_KEYS = ["associations", "format", "integritySha256", "owner", "revision", "savedAt", "version"];
const OWNER_KEYS = ["backend", "conversationId", "slotId", "workspace"];
const ASSOCIATION_KEYS = ["bundles", "conflictGate", "conflictGates", "groupRoots", "waveRoots"];
const BUNDLE_KEYS = ["expectedRevision", "operationId", "taskId", "version", "waveId", "waveRoot"];
const GATE_KEYS = ["activatedAt", "executionId", "manifestPath", "paths", "reason", "sidecars", "sourceRoot", "taskId"];
const SIDECAR_KEYS = ["path", "sidecarPath"];

/** The exact, already-authenticated native conversation owner. */
export interface NativeManagedAssociationOwner {
  /** Stable roster slot key of the hosted row. */
  readonly slotId: string;
  /** Native CLI backend of the row (never Pi: Pi rows use the session sidecar). */
  readonly backend: NativeCliBackend;
  /** The confirmed provider-issued conversation UUID (exact spelling). */
  readonly conversationId: string;
  /** Canonical absolute workspace of the conversation. */
  readonly workspace: string;
}

export type NativeManagedAssociationUnavailableReason =
  | "invalid-owner"
  | "invalid-state-root"
  | "unsafe-path"
  | "oversized"
  | "unreadable"
  | "changed-while-reading"
  | "malformed"
  | "unsupported-version"
  | "integrity-mismatch"
  | "owner-mismatch";

export type NativeManagedAssociationReadResult =
  | { readonly status: "absent" }
  | {
    readonly status: "loaded";
    readonly revision: number;
    readonly associations: ExecutionAssociationsSnapshot;
  }
  | { readonly status: "unavailable"; readonly reason: NativeManagedAssociationUnavailableReason };

export type NativeManagedAssociationWriteResult =
  /** The new document committed (atomic rename succeeded). */
  | { readonly status: "published"; readonly revision: number }
  /** Nothing was published: the inputs or the existing state refused the save. */
  | {
    readonly status: "refused";
    readonly reason: NativeManagedAssociationUnavailableReason | "invalid-associations";
  }
  /** Publication did not commit; the previous committed document is intact. */
  | { readonly status: "failed"; readonly reason: "publication-failed" };

/** Test-only fault injection; production callers never pass hooks. */
export interface NativeManagedAssociationPublicationHooks {
  /** Runs after the current owner document is validated, before the staging file is created. */
  readonly beforeStaging?: () => void | Promise<void>;
  /** Runs after the temp file is written, fsynced and closed, before the commit rechecks. */
  readonly beforeCommit?: (temporaryPath: string) => void | Promise<void>;
  /** Runs after the asynchronous byte comparisons, before the final synchronous path checks. */
  readonly afterCommitReads?: (temporaryPath: string) => void | Promise<void>;
  /** Runs synchronously right after the committing rename; a throw cannot undo the commit. */
  readonly afterRename?: () => void;
  /** Reports whether the post-commit directory fsync ran on the verified directory. */
  readonly afterDirectorySync?: (synced: boolean) => void;
}

/** Test-only fault injection for reads; production callers never pass hooks. */
export interface NativeManagedAssociationReadHooks {
  /** Runs after the store directory is validated, before the owner file is looked up. */
  readonly beforeFileLookup?: () => void | Promise<void>;
}

interface PersistedOwnerDocument {
  format: typeof NATIVE_MANAGED_ASSOCIATIONS_FORMAT;
  version: typeof NATIVE_MANAGED_ASSOCIATIONS_VERSION;
  revision: number;
  owner: NativeManagedAssociationOwner;
  savedAt: string;
  associations: ExecutionAssociationsSnapshot;
  integritySha256: string;
}

type FileIdentity = { readonly dev: bigint; readonly ino: bigint };
type FileStamp = FileIdentity & { readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint };

type ExistingState =
  | { readonly status: "absent" }
  | {
    readonly status: "loaded";
    readonly document: PersistedOwnerDocument;
    readonly identity: FileIdentity;
    readonly bytes: Buffer;
  }
  | { readonly status: "unavailable"; readonly reason: NativeManagedAssociationUnavailableReason };

/** True for one exact, publishable owner key. */
export function isValidNativeManagedAssociationOwner(value: unknown): value is NativeManagedAssociationOwner {
  return copyOwner(value) !== undefined;
}

/**
 * Read each owner field exactly once, validate those values, and return a
 * detached key. Every operation binds to this copy before its first await, so
 * later mutation of the caller's object can never switch the owner mid-flight.
 */
function copyOwner(value: unknown): NativeManagedAssociationOwner | undefined {
  if (!isRecord(value) || !hasExactKeys(value, OWNER_KEYS)) return undefined;
  const { slotId, backend, conversationId, workspace } = value;
  return isBoundedLine(slotId, MAX_SLOT_ID_CHARS)
    && isNativeCliBackend(backend)
    && isNativeConversationId(conversationId)
    && isValidRosterWorkspace(workspace)
    && isAbsolute(workspace)
    && resolve(workspace) === workspace
    ? { slotId, backend, conversationId, workspace }
    : undefined;
}

/**
 * Lexical location of one owner's document (diagnostics and tests only). The
 * file name is a digest of the exact owner key; the owner is never a path
 * component, so no owner field can steer the location.
 */
export function nativeManagedAssociationPath(stateRoot: string, owner: NativeManagedAssociationOwner): string {
  return join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME, `${ownerDigest(owner)}.json`);
}

/**
 * Read the exact owner's persisted associations without modifying anything.
 */
export async function readNativeManagedAssociations(
  stateRoot: string,
  owner: NativeManagedAssociationOwner,
  hooks: NativeManagedAssociationReadHooks = {},
): Promise<NativeManagedAssociationReadResult> {
  const exactOwner = copyOwner(owner);
  if (exactOwner === undefined) return { status: "unavailable", reason: "invalid-owner" };
  const rootIdentity = await stateRootIdentity(stateRoot);
  if (rootIdentity === undefined) return { status: "unavailable", reason: "invalid-state-root" };
  const existing = await readExisting(stateRoot, exactOwner, hooks);
  // Neither a snapshot nor absence is reported from a root that replaced the
  // validated one while the read was in progress.
  if (!await sameDirectory(stateRoot, rootIdentity)) return { status: "unavailable", reason: "changed-while-reading" };
  if (existing.status !== "loaded") return existing;
  return { status: "loaded", revision: existing.document.revision, associations: existing.document.associations };
}

/**
 * Replace the exact owner's persisted associations with `associations`.
 *
 * The owner key and the associations are validated and copied synchronously
 * at call time, so later caller mutation cannot change what is saved. Saves for
 * one owner file are then serialized within this process in invocation order;
 * the caller owns cross-process exclusivity through host ownership of the
 * state root.
 */
export function writeNativeManagedAssociations(
  stateRoot: string,
  owner: NativeManagedAssociationOwner,
  associations: ExecutionAssociationsSnapshot,
  hooks: NativeManagedAssociationPublicationHooks = {},
): Promise<NativeManagedAssociationWriteResult> {
  const exactOwner = copyOwner(owner);
  if (exactOwner === undefined) return Promise.resolve({ status: "refused", reason: "invalid-owner" });
  const copied = copyAssociations(associations, false);
  if (copied === "invalid") return Promise.resolve({ status: "refused", reason: "invalid-associations" });
  if (copied === "oversized") return Promise.resolve({ status: "refused", reason: "oversized" });
  const key = typeof stateRoot === "string" ? nativeManagedAssociationPath(stateRoot, exactOwner) : "";
  const previous = writeTails.get(key) ?? Promise.resolve();
  const operation = previous.then(() => writeSerialized(stateRoot, exactOwner, copied, hooks))
    .catch((): NativeManagedAssociationWriteResult => ({ status: "failed", reason: "publication-failed" }));
  const tail = operation.then(() => undefined);
  writeTails.set(key, tail);
  return operation.finally(() => {
    if (writeTails.get(key) === tail) writeTails.delete(key);
  });
}

const writeTails = new Map<string, Promise<void>>();
const writeStaging = promisify(writeFile);
const syncStaging = promisify(fsync);
const closeStaging = promisify(close);

async function writeSerialized(
  stateRoot: string,
  owner: NativeManagedAssociationOwner,
  associations: ExecutionAssociationsSnapshot,
  hooks: NativeManagedAssociationPublicationHooks,
): Promise<NativeManagedAssociationWriteResult> {
  const rootIdentity = await stateRootIdentity(stateRoot);
  if (rootIdentity === undefined) return { status: "refused", reason: "invalid-state-root" };
  // Every path mutation (mkdir, exclusive create, unlink, rename) runs
  // synchronously right after a synchronous check that both directories are
  // still the validated ones, so no await can separate check and mutation.
  if (!sameDirectoryNow(stateRoot, rootIdentity)) return { status: "refused", reason: "unsafe-path" };
  const directory = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") return { status: "failed", reason: "publication-failed" };
  }
  const directoryIdentity = directoryIdentityNow(directory);
  if (directoryIdentity === undefined) return { status: "refused", reason: "unsafe-path" };
  const inOriginalDirectories = (): boolean => sameDirectoryNow(stateRoot, rootIdentity)
    && sameDirectoryNow(directory, directoryIdentity);
  const existing = await readExisting(stateRoot, owner);
  if (existing.status === "unavailable") return { status: "refused", reason: existing.reason };
  const prior = existing.status === "loaded" ? existing.document.revision : 0;
  if (prior >= Number.MAX_SAFE_INTEGER) return { status: "refused", reason: "unsupported-version" };
  const revision = prior + 1;
  // Bounded by the copy's size budget; the round trip makes the signed value
  // exactly what a reader will parse back.
  const unsigned = JSON.parse(JSON.stringify({
    format: NATIVE_MANAGED_ASSOCIATIONS_FORMAT,
    version: NATIVE_MANAGED_ASSOCIATIONS_VERSION,
    revision,
    owner,
    savedAt: new Date().toISOString(),
    associations,
  })) as unknown;
  const body = `${JSON.stringify({ ...(unsigned as Record<string, unknown>), integritySha256: integrityOf(unsigned) })}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES) {
    return { status: "refused", reason: "oversized" };
  }
  const path = nativeManagedAssociationPath(stateRoot, owner);
  const temporary = `${path}.tmp.${randomUUID()}`;
  let file: number | undefined;
  let staged: FileIdentity | undefined;
  const removeOwnStaging = (): void => {
    // Synchronous: remove only an entry that still positively identifies as
    // this call's staging file inside the verified directories; anything else
    // is kept.
    if (staged === undefined || !inOriginalDirectories()) return;
    try {
      const stats = lstatSync(temporary, { bigint: true });
      if (stats.isFile() && !stats.isSymbolicLink() && stats.dev === staged.dev && stats.ino === staged.ino) {
        unlinkSync(temporary);
      }
    } catch {
      // Unverifiable or already gone: leave it.
    }
  };
  try {
    await hooks.beforeStaging?.();
    if (!inOriginalDirectories()) return { status: "refused", reason: "unsafe-path" };
    file = openSync(temporary, "wx", 0o600);
    const stats = fstatSync(file, { bigint: true });
    staged = { dev: stats.dev, ino: stats.ino };
    try {
      // Written and synced through the descriptor, never the pathname.
      await writeStaging(file, body, "utf8");
      await syncStaging(file);
    } finally {
      const opened = file;
      file = undefined;
      await closeStaging(opened);
    }
    await hooks.beforeCommit?.(temporary);
    if (!inOriginalDirectories()) {
      removeOwnStaging();
      return { status: "refused", reason: "unsafe-path" };
    }
    const stagingVersion = await checkedStaging(temporary, staged, body);
    const targetVersion = await checkedTarget(path, existing);
    await hooks.afterCommitReads?.(temporary);
    // No await from here to the rename: the entries the byte comparisons
    // examined must still be exactly what both paths name right now.
    if (stagingVersion === undefined || targetVersion === undefined
      || !inOriginalDirectories()
      || !sameFileAtCommit(temporary, stagingVersion)
      || !sameFileAtCommit(path, targetVersion)) {
      removeOwnStaging();
      return { status: "refused", reason: "unsafe-path" };
    }
    renameSync(temporary, path);
  } catch {
    if (file !== undefined) await closeStaging(file).catch(() => undefined);
    removeOwnStaging();
    return { status: "failed", reason: "publication-failed" };
  }
  try {
    hooks.afterRename?.();
  } catch {
    // The rename already committed.
  }
  const synced = inOriginalDirectories() && await syncVerifiedDirectory(directory, directoryIdentity);
  try {
    hooks.afterDirectorySync?.(synced);
  } catch {
    // The rename already committed.
  }
  return { status: "published", revision };
}

/**
 * Best-effort fsync of the directory this save committed in. The pathname is
 * opened no-follow and non-blocking (a FIFO or symlink swapped in can neither
 * redirect nor stall it), and only a descriptor whose identity matches the
 * validated directory is synced. Every failure is swallowed: a directory-sync
 * problem can never turn a committed rename into a failure. Returns whether
 * the verified directory was synced.
 */
async function syncVerifiedDirectory(path: string, expected: FileIdentity): Promise<boolean> {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isDirectory() || stats.dev !== expected.dev || stats.ino !== expected.ino) return false;
    await syncStaging(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) await closeStaging(fd).catch(() => undefined);
  }
}

/** Stamp of the staging entry when it is still this call's own file with exactly the written bytes. */
async function checkedStaging(temporary: string, staged: FileIdentity, body: string): Promise<FileStamp | undefined> {
  const read = await readRegularFileBounded(temporary);
  return read.status === "read" && read.identity.dev === staged.dev && read.identity.ino === staged.ino
    && read.bytes.equals(Buffer.from(body, "utf8"))
    ? read.identity : undefined;
}

/**
 * Expected target at commit: `null` when it was validated absent (absence is
 * verified at commit), otherwise the stamp of the validated document when it
 * still has its identity and exact bytes; `undefined` refuses.
 */
async function checkedTarget(path: string, existing: ExistingState): Promise<FileStamp | null | undefined> {
  if (existing.status === "absent") return null;
  if (existing.status !== "loaded") return undefined;
  const read = await readRegularFileBounded(path);
  return read.status === "read" && read.identity.dev === existing.identity.dev
    && read.identity.ino === existing.identity.ino && read.bytes.equals(existing.bytes)
    ? read.identity : undefined;
}

function directoryIdentityNow(path: string): FileIdentity | undefined {
  try {
    const stats = lstatSync(path, { bigint: true });
    return stats.isDirectory() && !stats.isSymbolicLink() ? { dev: stats.dev, ino: stats.ino } : undefined;
  } catch {
    return undefined;
  }
}

function sameDirectoryNow(path: string, expected: FileIdentity): boolean {
  const current = directoryIdentityNow(path);
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

function sameFileAtCommit(path: string, expected: FileStamp | null): boolean {
  try {
    const stats = lstatSync(path, { bigint: true });
    return expected !== null && stats.isFile() && !stats.isSymbolicLink()
      && stats.dev === expected.dev && stats.ino === expected.ino && stats.size === expected.size
      && stats.mtimeNs === expected.mtimeNs && stats.ctimeNs === expected.ctimeNs;
  } catch (error) {
    return expected === null && errorCode(error) === "ENOENT";
  }
}

/** Identity of a valid trusted state root: an absolute, canonical, real directory. */
async function stateRootIdentity(stateRoot: unknown): Promise<FileIdentity | undefined> {
  if (typeof stateRoot !== "string" || stateRoot === "" || !isAbsolute(stateRoot)) return undefined;
  const identity = await realDirectoryIdentity(stateRoot);
  if (identity === undefined) return undefined;
  try {
    return await realpath(stateRoot) === stateRoot ? identity : undefined;
  } catch {
    return undefined;
  }
}

async function realDirectoryIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    return stats.isDirectory() && !stats.isSymbolicLink() ? { dev: stats.dev, ino: stats.ino } : undefined;
  } catch {
    return undefined;
  }
}

async function sameDirectory(path: string, identity: FileIdentity): Promise<boolean> {
  const current = await realDirectoryIdentity(path);
  return current !== undefined && current.dev === identity.dev && current.ino === identity.ino;
}

async function readExisting(
  stateRoot: string,
  owner: NativeManagedAssociationOwner,
  hooks: NativeManagedAssociationReadHooks = {},
): Promise<ExistingState> {
  const directory = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  let directoryIdentity: FileIdentity;
  try {
    const stats = await lstat(directory, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { status: "unavailable", reason: "unsafe-path" };
    directoryIdentity = { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "absent" } : { status: "unavailable", reason: "unreadable" };
  }
  await hooks.beforeFileLookup?.();
  const read = await readRegularFileBounded(nativeManagedAssociationPath(stateRoot, owner));
  // The file (or its absence) must come from the directory that was validated:
  // a replaced store directory is unavailable, never absent or another copy.
  if (!await sameDirectory(directory, directoryIdentity)) return { status: "unavailable", reason: "changed-while-reading" };
  if (read.status !== "read") return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { status: "unavailable", reason: "malformed" };
  }
  if (!isRecord(parsed) || parsed.format !== NATIVE_MANAGED_ASSOCIATIONS_FORMAT) {
    return { status: "unavailable", reason: "malformed" };
  }
  if (parsed.version !== NATIVE_MANAGED_ASSOCIATIONS_VERSION) return { status: "unavailable", reason: "unsupported-version" };
  if (!hasExactKeys(parsed, DOCUMENT_KEYS)
    || !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) <= 0
    || !isValidNativeManagedAssociationOwner(parsed.owner)
    || typeof parsed.savedAt !== "string" || parsed.savedAt.length > 64
    || typeof parsed.integritySha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.integritySha256)) {
    return { status: "unavailable", reason: "malformed" };
  }
  const associations = copyAssociations(parsed.associations, true);
  if (typeof associations === "string") return { status: "unavailable", reason: "malformed" };
  const { integritySha256, ...unsigned } = parsed;
  if (integritySha256 !== integrityOf(unsigned)) return { status: "unavailable", reason: "integrity-mismatch" };
  if (!sameOwner(parsed.owner, owner)) return { status: "unavailable", reason: "owner-mismatch" };
  return {
    status: "loaded",
    document: {
      format: NATIVE_MANAGED_ASSOCIATIONS_FORMAT,
      version: NATIVE_MANAGED_ASSOCIATIONS_VERSION,
      revision: parsed.revision as number,
      owner: parsed.owner,
      savedAt: parsed.savedAt,
      associations,
      integritySha256,
    },
    identity: read.identity,
    bytes: read.bytes,
  };
}

/**
 * Never-blocking bounded read of one existing regular file: the type is checked
 * before the open (opening a FIFO for read would block), the open is no-follow
 * and non-blocking where supported, the descriptor must be the inspected file,
 * and growth while reading is detected.
 */
async function readRegularFileBounded(path: string): Promise<
  | { readonly status: "read"; readonly text: string; readonly bytes: Buffer; readonly identity: FileStamp }
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly reason: NativeManagedAssociationUnavailableReason }
> {
  let pre;
  try {
    pre = await lstat(path, { bigint: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "absent" } : { status: "unavailable", reason: "unreadable" };
  }
  if (pre.isSymbolicLink() || !pre.isFile()) return { status: "unavailable", reason: "unsafe-path" };
  if (pre.size > BigInt(MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES)) return { status: "unavailable", reason: "oversized" };
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { status: "unavailable", reason: "unreadable" };
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.dev !== pre.dev || stats.ino !== pre.ino) return { status: "unavailable", reason: "unsafe-path" };
    if (stats.size > BigInt(MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES)) return { status: "unavailable", reason: "oversized" };
    const size = Number(stats.size);
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) return { status: "unavailable", reason: "changed-while-reading" };
    const bytes = Buffer.from(buffer.subarray(0, size));
    // Rechecks compare raw bytes. The decoder also keeps a leading BOM (which
    // the writer never emits), so a BOM-prefixed document parses as malformed
    // instead of silently decoding equal to the original.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return {
      status: "read", text, bytes,
      identity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs },
    };
  } catch (error) {
    return error instanceof TypeError ? { status: "unavailable", reason: "malformed" } : { status: "unavailable", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const INVALID = Symbol("invalid");
const OVERSIZED = Symbol("oversized");

interface CopyContext {
  readonly strict: boolean;
  /** Remaining lower bound of serialized bytes; each string/array charge is a minimum. */
  remaining: number;
}

/**
 * Validate and detach an association snapshot in ONE pass that reads every
 * field exactly once (the same fields the session-state sidecar accepts).
 * Sparse arrays are rejected at every level, and a serialized-size lower bound
 * (one byte per UTF-16 unit and per array slot) is charged before each array
 * is walked or copied, so an oversized input is refused without being cloned,
 * iterated in full, or serialized. `strict` (the reader) additionally rejects
 * unknown keys, which this store's writer never emits. Roots are deduplicated
 * exactly as session-state's clone does.
 */
function copyAssociations(input: unknown, strict: boolean): ExecutionAssociationsSnapshot | "invalid" | "oversized" {
  const context: CopyContext = { strict, remaining: MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES };
  try {
    const value = record(input, ASSOCIATION_KEYS, context);
    const waveRoots = denseArray(value.waveRoots, context).map((entry) => text(entry, context));
    const bundles = denseArray(value.bundles, context).map((entry) => bundle(entry, context));
    const groupRootsInput = value.groupRoots;
    const groupRoots = groupRootsInput === undefined
      ? undefined
      : denseArray(groupRootsInput, context).map((entry) => text(entry, context));
    const conflictGateInput = value.conflictGate;
    const conflictGate = conflictGateInput === undefined ? undefined : gate(conflictGateInput, context);
    const conflictGatesInput = value.conflictGates;
    const conflictGates = conflictGatesInput === undefined
      ? undefined
      : denseArray(conflictGatesInput, context).map((entry) => gate(entry, context));
    return {
      waveRoots: [...new Set(waveRoots)],
      bundles,
      ...(groupRoots ? { groupRoots: [...new Set(groupRoots)] } : {}),
      ...(conflictGate ? { conflictGate } : {}),
      ...(conflictGates ? { conflictGates } : {}),
    };
  } catch (error) {
    return error === OVERSIZED ? "oversized" : "invalid";
  }
}

function bundle(input: unknown, context: CopyContext): ReattachmentBundle {
  const value = record(input, BUNDLE_KEYS, context);
  const version = value.version;
  const expectedRevision = value.expectedRevision;
  if (context.strict && !hasExactKeys(value, BUNDLE_KEYS)) throw INVALID;
  if (version !== 1 || !Number.isSafeInteger(expectedRevision)) throw INVALID;
  return {
    version: 1,
    operationId: text(value.operationId, context),
    waveId: text(value.waveId, context),
    taskId: text(value.taskId, context),
    waveRoot: text(value.waveRoot, context),
    expectedRevision: expectedRevision as number,
  };
}

function gate(input: unknown, context: CopyContext): PersistedConflictGate {
  const value = record(input, GATE_KEYS, context);
  const sidecarsInput = value.sidecars;
  const copied: PersistedConflictGate = {
    executionId: text(value.executionId, context),
    taskId: text(value.taskId, context),
    sourceRoot: text(value.sourceRoot, context),
    paths: denseArray(value.paths, context).map((entry) => text(entry, context)),
    activatedAt: text(value.activatedAt, context),
    manifestPath: text(value.manifestPath, context),
    reason: text(value.reason, context),
  };
  if (sidecarsInput !== undefined) {
    copied.sidecars = denseArray(sidecarsInput, context).map((entry) => {
      const sidecar = record(entry, SIDECAR_KEYS, context);
      const sidecarPath = sidecar.sidecarPath;
      return {
        path: text(sidecar.path, context),
        ...(sidecarPath !== undefined ? { sidecarPath: text(sidecarPath, context) } : {}),
      };
    });
  }
  return copied;
}

function record(input: unknown, allowed: readonly string[], context: CopyContext): Record<string, unknown> {
  if (!isRecord(input)) throw INVALID;
  if (context.strict && !Object.keys(input).every((key) => allowed.includes(key))) throw INVALID;
  charge(context, 2);
  return input;
}

/** Charge the array's minimum serialized size before walking it; reject holes. */
function denseArray(input: unknown, context: CopyContext): unknown[] {
  if (!Array.isArray(input)) throw INVALID;
  const length = input.length;
  charge(context, length + 2);
  const copied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(input, index)) throw INVALID;
    copied.push(input[index]);
  }
  return copied;
}

function text(input: unknown, context: CopyContext): string {
  if (typeof input !== "string" || input.length > MAX_ASSOCIATION_TEXT_CHARS) throw INVALID;
  charge(context, input.length + 2);
  return input;
}

function charge(context: CopyContext, bytes: number): void {
  context.remaining -= bytes;
  if (context.remaining < 0) throw OVERSIZED;
}

function ownerDigest(owner: NativeManagedAssociationOwner): string {
  return createHash("sha256").update(canonicalStableJson({
    domain: OWNER_KEY_DOMAIN,
    slotId: owner.slotId,
    backend: owner.backend,
    conversationId: owner.conversationId,
    workspace: owner.workspace,
  })).digest("hex");
}

function sameOwner(a: NativeManagedAssociationOwner, b: NativeManagedAssociationOwner): boolean {
  return a.slotId === b.slotId && a.backend === b.backend
    && a.conversationId === b.conversationId && a.workspace === b.workspace;
}

function integrityOf(unsigned: unknown): string {
  return createHash("sha256").update(canonicalStableJson(unsigned)).digest("hex");
}

/** Bounded, non-empty, single-line text without C0/C1 controls or line/paragraph separators. */
function isBoundedLine(value: unknown, maxChars: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}
