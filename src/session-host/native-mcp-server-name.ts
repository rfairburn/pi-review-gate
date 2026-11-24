/**
 * The stable Review Gate MCP server name for one sidebar host (Refs #682).
 *
 * One recognizable name per sidebar host: the fixed prefix
 * {@link NATIVE_MCP_SERVER_NAME_PREFIX} plus 32 lowercase hexadecimal digits
 * from 16 bytes of cryptographic randomness, generated once and persisted in
 * the host's own private state directory (`<agentDir>/session-host`) so it
 * survives restarts and native exact-tool approvals can stick.
 *
 * The name is an identifier only. It carries no authority: the per-launch
 * token and bootstrap stay exactly as they are, and nothing here derives,
 * stores, or logs a credential.
 *
 * Storage rules (fail closed):
 *
 * - Absent file: a new name is minted and published with an atomic
 *   no-overwrite `link(2)` of a complete, synced private temporary whose name
 *   is derived from the minted name. The link is the commit point: an
 *   interrupted creator's leftover alias is accepted as the only permitted
 *   second link, and any other hard link refuses. A competing
 *   creator that loses the link reads and adopts the winner's name, so racing
 *   opens converge on one accepted name.
 * - Valid file: loaded unchanged. Reading never rewrites it.
 * - Protection is proven with the repository's platform permission policy
 *   ({@link createPeerStatePermissionPolicy}): the state directory must be
 *   owner-controlled and the name file private (POSIX owner and exact `0600`
 *   plus the macOS ACL proof; Windows owner and protected DACL through the
 *   trusted helper). On POSIX a new temporary is set to exactly `0600` on its
 *   own descriptor, independent of the process umask. On every supported
 *   platform the policy protects and verifies it, and it is read back before
 *   publication so the next host process can read it.
 *   The outer Pi agent directory is a locator, not a permission boundary for
 *   this nonsecret name. Nothing is stored directly in it.
 * - Anything else — malformed, oversized, unsupported schema, non-regular or
 *   symlinked entry, foreign-owned or shared-writable entry or directory,
 *   unverifiable protection (including platforms the policy does not support),
 *   unreadable or inaccessible storage — refuses. The existing entry is left
 *   untouched: there is no silent rotation, no overwrite, and no fallback to a
 *   fixed name.
 *
 * This module is deliberately standalone: it is not wired into host startup,
 * settings, or launch preparation.
 */
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { PeerStatePermissionPolicy } from "./network/peer-state-permission-policy";
import { createPeerStatePermissionPolicy, proveExtendedAcl } from "./network/peer-state-permissions";
import { peerStorageRefusalDetail } from "./network/peer-storage-diagnostics";
import { ensureHostStateDir, sessionHostStateDir } from "./roster-store";

/** Fixed, recognizable prefix of every Review Gate MCP server name. */
export const NATIVE_MCP_SERVER_NAME_PREFIX = "pi_review_gate_";

/** Bytes of cryptographic randomness behind the suffix. */
export const NATIVE_MCP_SERVER_NAME_RANDOM_BYTES = 16;

/** Exact length of a valid server name (prefix + 32 hex digits). */
export const NATIVE_MCP_SERVER_NAME_LENGTH =
  NATIVE_MCP_SERVER_NAME_PREFIX.length + NATIVE_MCP_SERVER_NAME_RANDOM_BYTES * 2;

/** File inside the session-host state directory that holds the name. */
export const NATIVE_MCP_SERVER_NAME_FILENAME = "native-mcp-server-name.json";

/** Supported on-disk schema version. */
export const NATIVE_MCP_SERVER_NAME_STORE_VERSION = 1;

/** Upper bound on the stored document; a valid one is well under this. */
export const MAX_NATIVE_MCP_SERVER_NAME_FILE_BYTES = 256;

const SERVER_NAME_PATTERN = /^pi_review_gate_[0-9a-f]{32}$/;

/** Exact private mode of the name file and its temporary. */
const PRIVATE_FILE_MODE = 0o600;

/**
 * POSIX platforms whose private-file proof is exact mode plus the shared
 * extended-ACL proof. Only these may accept this protocol's own two-link state.
 */
const POSIX_PROOF_PLATFORMS: readonly NodeJS.Platform[] = ["linux", "darwin"];

declare const nativeMcpServerNameBrand: unique symbol;

/** A server name that passed {@link isNativeMcpServerName}. */
export type NativeMcpServerName = string & { readonly [nativeMcpServerNameBrand]: true };

/** Strict grammar check: exactly `pi_review_gate_` followed by 32 lowercase hex digits. */
export function isNativeMcpServerName(value: unknown): value is NativeMcpServerName {
  return typeof value === "string"
    && value.length === NATIVE_MCP_SERVER_NAME_LENGTH
    && SERVER_NAME_PATTERN.test(value);
}

/** Validate an untrusted value; `undefined` for anything outside the grammar. */
export function parseNativeMcpServerName(value: unknown): NativeMcpServerName | undefined {
  return isNativeMcpServerName(value) ? value : undefined;
}

/** Lexical location of the persisted name (diagnostics and tests only). */
export function nativeMcpServerNamePath(agentDir: string): string {
  return join(sessionHostStateDir(agentDir), NATIVE_MCP_SERVER_NAME_FILENAME);
}

/** Fixed refusal reasons; messages never include the name, paths, or credentials. */
export type NativeMcpServerNameRefusalReason =
  | "state-unavailable"
  | "unsafe-storage"
  | "unsafe-entry"
  | "oversized"
  | "unreadable"
  | "malformed"
  | "publish-failed";

export type NativeMcpServerNameReadResult =
  | { readonly status: "absent" }
  | { readonly status: "loaded"; readonly serverName: NativeMcpServerName }
  | {
    readonly status: "refused";
    readonly reason: NativeMcpServerNameRefusalReason;
    readonly message: string;
  };

export type NativeMcpServerNameResult =
  | { readonly status: "loaded"; readonly serverName: NativeMcpServerName }
  | { readonly status: "created"; readonly serverName: NativeMcpServerName }
  | {
    readonly status: "refused";
    readonly reason: NativeMcpServerNameRefusalReason;
    readonly message: string;
  };

type Refusal = Extract<NativeMcpServerNameResult, { status: "refused" }>;

const REFUSAL_MESSAGES: Readonly<Record<NativeMcpServerNameRefusalReason, string>> = {
  "state-unavailable": "the session-host state directory could not be safely accessed.",
  "unsafe-storage": "the session-host state directory is not verifiably owner-controlled by this account.",
  "unsafe-entry": "the stored Review Gate MCP server name is not a verifiably private regular file owned by this account.",
  oversized: `the stored Review Gate MCP server name exceeds ${MAX_NATIVE_MCP_SERVER_NAME_FILE_BYTES} bytes.`,
  unreadable: "the stored Review Gate MCP server name could not be read.",
  malformed: "the stored Review Gate MCP server name is malformed or has an unsupported schema.",
  "publish-failed": "a new Review Gate MCP server name could not be safely published.",
};

function refuse(reason: NativeMcpServerNameRefusalReason): Refusal {
  return {
    status: "refused",
    reason,
    message: `Session host refused: ${REFUSAL_MESSAGES[reason]} `
      + "Nothing was overwritten; fix or move the entry before restarting.",
  };
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function sameIdentity(stats: BigIntStats, identity: FileIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // A close failure never replaces the bounded result.
  }
}

/**
 * Cheap POSIX pre-check: owned by this account and not group/other writable.
 * It is never the whole proof — the platform permission policy always runs as
 * well, and on Windows (no numeric owner or mode bits) the policy's DACL proof
 * is the check.
 */
function ownedAndNotShared(stats: BigIntStats): boolean {
  if (typeof process.getuid !== "function") return true;
  if (stats.uid !== BigInt(process.getuid())) return false;
  return (stats.mode & 0o022n) === 0n;
}

/** Run one policy proof; `undefined` on success, else the fixed refusal detail. */
function policyRefusal(check: () => void): { reason: string; scope: string } | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return peerStorageRefusalDetail(error) ?? { reason: "protection-unsupported", scope: "target" };
  }
}

function trustedStateDirectory(stateDir: string, permissions: PeerStatePermissionPolicy): FileIdentity | undefined {
  let stats: BigIntStats;
  try {
    stats = lstatSync(stateDir, { bigint: true });
  } catch {
    return undefined;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || !ownedAndNotShared(stats)) return undefined;
  if (policyRefusal(() => permissions.assertOwnerControlledDirectory(stateDir)) !== undefined) return undefined;
  let after: BigIntStats;
  try {
    after = lstatSync(stateDir, { bigint: true });
  } catch {
    return undefined;
  }
  if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(after, stats)) return undefined;
  return { dev: stats.dev, ino: stats.ino };
}

/** Cheap identity fence before publication (the full policy proof ran at resolve). */
function stateDirectoryUnchanged(stateDir: string, identity: FileIdentity): boolean {
  try {
    const current = lstatSync(stateDir, { bigint: true });
    return !current.isSymbolicLink() && current.isDirectory() && sameIdentity(current, identity)
      && ownedAndNotShared(current);
  } catch {
    return false;
  }
}

function resolveStateDirectory(
  agentDir: string,
  permissions: PeerStatePermissionPolicy,
): { stateDir: string; identity: FileIdentity } | Refusal {
  let stateDir: string;
  try {
    if (typeof agentDir !== "string" || !isAbsolute(agentDir)) return refuse("state-unavailable");
    const agent = lstatSync(agentDir, { bigint: true });
    if (agent.isSymbolicLink() || !agent.isDirectory()) return refuse("state-unavailable");
    const canonical = realpathSync(agentDir);
    stateDir = ensureHostStateDir(canonical);
  } catch {
    return refuse("state-unavailable");
  }
  const identity = trustedStateDirectory(stateDir, permissions);
  if (identity === undefined) return refuse("unsafe-storage");
  return { stateDir, identity };
}

/** Strict document parse: exactly `{ version: 1, serverName }` and nothing else. */
function parseDocument(bytes: Buffer): NativeMcpServerName | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("version") || !keys.includes("serverName")) return undefined;
  if (record.version !== NATIVE_MCP_SERVER_NAME_STORE_VERSION) return undefined;
  const serverName = parseNativeMcpServerName(record.serverName);
  if (serverName === undefined) return undefined;
  // JSON.parse keeps only the last of duplicate members, so a parsed two-key
  // record can hide a conflicting earlier value. This module is the only
  // writer: accept exactly its canonical bytes and nothing ambiguous.
  return bytes.equals(Buffer.from(serializeDocument(serverName), "utf8")) ? serverName : undefined;
}

function serializeDocument(serverName: NativeMcpServerName): string {
  return `${JSON.stringify({ version: NATIVE_MCP_SERVER_NAME_STORE_VERSION, serverName })}\n`;
}

function lstatEntry(path: string): BigIntStats | "absent" | "unreadable" {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable";
  }
}

/**
 * The publication alias is derived from the validated name it carries. The
 * `link(2)` to the final path is the commit point; if the creator pauses or
 * exits before retiring this exact alias, a reader can still prove the second
 * link is the protocol's own alias for the same inode, without scanning or
 * deleting anything.
 */
function publicationTemporary(stateDir: string, name: NativeMcpServerName): string {
  return join(stateDir, `.${NATIVE_MCP_SERVER_NAME_FILENAME}.tmp.${name}`);
}

/** One link, or exactly two where the other is this name's own publication alias. */
function hasOnlyPublicationLinks(path: string, opened: BigIntStats, name: NativeMcpServerName): boolean {
  const alias = lstatEntry(publicationTemporary(dirname(path), name));
  // Check the final path last: the publisher may have just retired the alias.
  const current = lstatEntry(path);
  if (typeof current === "string" || current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, opened)) {
    return false;
  }
  if (current.nlink === 1n) return true;
  return current.nlink === 2n && typeof alias !== "string"
    && !alias.isSymbolicLink() && alias.isFile() && sameIdentity(alias, opened);
}

function readExisting(path: string, permissions: PeerStatePermissionPolicy): NativeMcpServerNameReadResult {
  const before = lstatEntry(path);
  if (before === "absent") return { status: "absent" };
  if (before === "unreadable") return refuse("unreadable");
  // A symlink, FIFO, socket, device, or directory is never opened.
  if (before.isSymbolicLink() || !before.isFile() || !ownedAndNotShared(before)) return refuse("unsafe-entry");
  if (before.size > BigInt(MAX_NATIVE_MCP_SERVER_NAME_FILE_BYTES)) return refuse("oversized");
  if (before.nlink !== 1n && before.nlink !== 2n) return refuse("unsafe-entry");
  if (before.nlink === 2n && POSIX_PROOF_PLATFORMS.includes(process.platform)) {
    // The shared POSIX file policy requires one link. Only this protocol's own
    // alias (verified after the read below) is eligible for the two-link case;
    // owner (above), exact private mode, and the extended-ACL proof still apply.
    const acl = proveExtendedAcl(path, "private-file");
    if ((before.mode & 0o7777n) !== BigInt(PRIVATE_FILE_MODE) || (acl !== "no-acl" && acl !== "owner-only")) {
      return refuse("unsafe-entry");
    }
  } else {
    const protection = policyRefusal(() => permissions.assertPrivateFile(path));
    if (protection !== undefined) return refuse(protection.reason === "unreadable" ? "unreadable" : "unsafe-entry");
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return refuse("unreadable");
  }
  try {
    let opened: BigIntStats;
    try {
      opened = fstatSync(fd, { bigint: true });
    } catch {
      return refuse("unreadable");
    }
    if (!opened.isFile() || !sameIdentity(opened, before) || !ownedAndNotShared(opened)
      || (opened.nlink !== 1n && opened.nlink !== 2n)
      || (typeof process.getuid === "function" && (opened.mode & 0o7777n) !== BigInt(PRIVATE_FILE_MODE))) {
      return refuse("unsafe-entry");
    }
    if (opened.size > BigInt(MAX_NATIVE_MCP_SERVER_NAME_FILE_BYTES)) return refuse("oversized");
    const buffer = readAllFrom(fd, Number(opened.size));
    if (buffer === undefined) return refuse("unreadable");
    const serverName = parseDocument(buffer);
    if (serverName === undefined) return refuse("malformed");
    if (!hasOnlyPublicationLinks(path, opened, serverName)) return refuse("unsafe-entry");
    return { status: "loaded", serverName };
  } finally {
    closeQuietly(fd);
  }
}

/** Bounded positional read; `undefined` when the file is short or unreadable. */
function readAllFrom(fd: number, size: number): Buffer | undefined {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    let count: number;
    try {
      count = readSync(fd, buffer, offset, size - offset, offset);
    } catch {
      return undefined;
    }
    if (count <= 0) break;
    offset += count;
  }
  return offset === size ? buffer : undefined;
}

/**
 * Prove the complete temporary is readable by this account through a fresh
 * no-follow open of the same inode, and that it holds exactly the bytes written.
 */
function temporaryReadsBack(temporary: string, identity: FileIdentity, body: Buffer): boolean {
  let fd: number;
  try {
    fd = openSync(temporary, fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return false;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, identity) || opened.size !== BigInt(body.length)) return false;
    const bytes = readAllFrom(fd, body.length);
    return bytes !== undefined && bytes.equals(body);
  } catch {
    return false;
  } finally {
    closeQuietly(fd);
  }
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
    // Directory fsync is not available on every supported filesystem.
  }
}

/** Mint one fresh name from exactly 16 bytes of randomness; refuses a short source. */
function mintServerName(randomBytes: (size: number) => Buffer): NativeMcpServerName | undefined {
  let bytes: Buffer;
  try {
    bytes = randomBytes(NATIVE_MCP_SERVER_NAME_RANDOM_BYTES);
  } catch {
    return undefined;
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== NATIVE_MCP_SERVER_NAME_RANDOM_BYTES) return undefined;
  return parseNativeMcpServerName(`${NATIVE_MCP_SERVER_NAME_PREFIX}${bytes.toString("hex")}`);
}

interface ReadSeams {
  /** Platform protection proof (production: {@link createPeerStatePermissionPolicy}). */
  readonly permissions: PeerStatePermissionPolicy;
}

interface CreateSeams extends ReadSeams {
  readonly randomBytes: (size: number) => Buffer;
  /** Test-only pause between the complete temporary and its publication. */
  readonly beforePublish?: () => void;
}

/**
 * Publish a freshly minted name with no-overwrite semantics. The temporary is
 * exclusively created and, on POSIX, set to `0600` on its own descriptor (so the
 * process umask cannot leave it unreadable). It is protected and verified by the
 * platform policy, written, synced, and read back before `link(2)` exposes it;
 * a reader therefore never observes a partial or unreadable document. `EEXIST`
 * means a competing creator won: its name is read back and adopted.
 */
function publishNew(
  stateDir: string,
  identity: FileIdentity,
  path: string,
  seams: CreateSeams,
): NativeMcpServerNameResult {
  // The temporary's directory entry carries the minted name, and file modes do
  // not hide names: prove the directory private before minting anything. The
  // owner-controlled check at resolve deliberately admits listable directories.
  if (policyRefusal(() => seams.permissions.assertPrivateDirectory(stateDir)) !== undefined) {
    return refuse("unsafe-storage");
  }
  const serverName = mintServerName(seams.randomBytes);
  if (serverName === undefined) return refuse("publish-failed");
  if (!stateDirectoryUnchanged(stateDir, identity)) return refuse("unsafe-storage");
  const body = Buffer.from(serializeDocument(serverName), "utf8");
  const temporary = publicationTemporary(stateDir, serverName);
  let fd: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  try {
    try {
      fd = openSync(temporary, fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) return refuse("publish-failed");
      temporaryIdentity = { dev: opened.dev, ino: opened.ino };
      // Windows privacy is the DACL that protectCreatedFile establishes and
      // verifies below; a descriptor chmod there proves nothing and needs
      // attribute access a write-only handle does not carry.
      if (process.platform !== "win32") fchmodSync(fd, PRIVATE_FILE_MODE);
    } catch {
      return refuse("publish-failed");
    }
    const protection = policyRefusal(() => seams.permissions.protectCreatedFile(temporary));
    if (protection !== undefined) return refuse(protection.scope === "parent" ? "unsafe-storage" : "publish-failed");
    try {
      const protectedStats = lstatSync(temporary, { bigint: true });
      if (protectedStats.isSymbolicLink() || !protectedStats.isFile()
        || !sameIdentity(protectedStats, temporaryIdentity) || protectedStats.size !== 0n) {
        return refuse("publish-failed");
      }
      let offset = 0;
      while (offset < body.length) offset += writeSync(fd, body, offset, body.length - offset);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch {
      return refuse("publish-failed");
    }
    if (!temporaryReadsBack(temporary, temporaryIdentity, body)) return refuse("publish-failed");
    seams.beforePublish?.();
    if (!stateDirectoryUnchanged(stateDir, identity)) return refuse("unsafe-storage");
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return refuse("publish-failed");
      // Lost the race: converge on the winner's name, or refuse if it is bad.
      const winner = readExisting(path, seams.permissions);
      if (!stateDirectoryUnchanged(stateDir, identity)) return refuse("unsafe-storage");
      return winner.status === "absent" ? refuse("publish-failed") : winner;
    }
    // The final link is the commit point: it stays valid even if this exact
    // alias cannot be retired (readers accept only that alias as a second link).
    if (retireTemporary(temporary, temporaryIdentity)) temporaryIdentity = undefined;
    syncDirectoryBestEffort(stateDir);
    const published = readExisting(path, seams.permissions);
    if (!stateDirectoryUnchanged(stateDir, identity)) return refuse("unsafe-storage");
    if (published.status === "loaded" && published.serverName === serverName) {
      return { status: "created", serverName };
    }
    return published.status === "refused" ? published : refuse("publish-failed");
  } finally {
    if (fd !== undefined) closeQuietly(fd);
    if (temporaryIdentity !== undefined) retireTemporary(temporary, temporaryIdentity);
  }
}

/** Remove the temporary only while it is still this creator's exact inode. */
function retireTemporary(temporary: string, identity: FileIdentity): boolean {
  try {
    const current = lstatSync(temporary, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, identity)) return false;
    unlinkSync(temporary);
    return true;
  } catch {
    // An unverified leftover temporary is private residue, never removed by name.
    return false;
  }
}

function readWith(agentDir: string, seams: ReadSeams): NativeMcpServerNameReadResult {
  const resolved = resolveStateDirectory(agentDir, seams.permissions);
  if ("status" in resolved) return resolved;
  const result = readExisting(join(resolved.stateDir, NATIVE_MCP_SERVER_NAME_FILENAME), seams.permissions);
  return result.status === "refused" || stateDirectoryUnchanged(resolved.stateDir, resolved.identity)
    ? result
    : refuse("unsafe-storage");
}

function readOrCreateWith(agentDir: string, seams: CreateSeams): NativeMcpServerNameResult {
  const resolved = resolveStateDirectory(agentDir, seams.permissions);
  if ("status" in resolved) return resolved;
  const path = join(resolved.stateDir, NATIVE_MCP_SERVER_NAME_FILENAME);
  const existing = readExisting(path, seams.permissions);
  if (existing.status === "refused") return existing;
  if (!stateDirectoryUnchanged(resolved.stateDir, resolved.identity)) return refuse("unsafe-storage");
  if (existing.status === "loaded") return existing;
  return publishNew(resolved.stateDir, resolved.identity, path, seams);
}

/**
 * Read the persisted name without ever creating, repairing, or rewriting it.
 * `absent` only when no entry exists; every other non-valid state refuses.
 */
export function readNativeMcpServerName(agentDir: string): NativeMcpServerNameReadResult {
  return readWith(agentDir, { permissions: createPeerStatePermissionPolicy() });
}

/**
 * Return this sidebar host's stable Review Gate MCP server name, minting and
 * persisting it exactly once when no entry exists.
 *
 * `agentDir` is the canonical native Pi agent directory the host owns; the
 * name lives in its private `session-host` state directory. Never throws.
 * `loaded` and `created` both carry a validated name; `refused` means no name
 * is available and nothing existing was changed — callers must not substitute
 * a fixed or freshly generated name.
 */
export function readOrCreateNativeMcpServerName(agentDir: string): NativeMcpServerNameResult {
  return readOrCreateWith(agentDir, {
    randomBytes: cryptoRandomBytes,
    permissions: createPeerStatePermissionPolicy(),
  });
}

/** Test seams only; production callers use the exported functions above. */
export const __test = {
  readWith,
  readOrCreateWith,
  mintServerName,
};
