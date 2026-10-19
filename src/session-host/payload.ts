/**
 * Exact private staged-payload transport for SessionSpawn (issue #447).
 *
 * The public tool and host callback contract still carry an ordinary prompt
 * string, but that string never travels through a bounded wire frame or a
 * one-shot environment value. Instead the producer (the reporter for
 * reporter-to-host, or the manager for host-to-child startup) writes the exact
 * JSON-encoded value into a fresh host-owned payload namespace with an
 * exclusive `0600` file, then advertises only a strict basename, byte size, and
 * SHA-256 digest. The consumer verifies the namespace confinement, no-follow
 * regular-file descriptor identity, exact declared size, and digest before it
 * decodes UTF-8 JSON and consumes that exact inode.
 *
 * Safety contract (fail closed):
 *
 * - The namespace must be a real directory owned by this process with mode
 *   `0700` on POSIX. Windows keeps the existing default-ACL caveat: this module
 *   makes no custom ACL claim beyond the private mkdtemp directory.
 * - Names are strict single-segment helper-generated basenames; no supplied
 *   path is joined without that validation.
 * - Files are opened with `O_NOFOLLOW | O_NONBLOCK` and must be regular files
 *   whose path identity matches the opened descriptor. Short reads, extra
 *   bytes, a replaced inode, and wrong digests are rejected. Identity
 *   comparisons use exact `bigint` device/inode values, so a rounded `number`
 *   can never masquerade as the same object.
 * - A staged file keeps a positively owned kernel continuity pin (the creation
 *   descriptor on POSIX, a private hard link where a retained handle would make
 *   the name unreplaceable) for its whole ownership lifetime, so a filesystem
 *   can never hand that inode number to a replacement entry while the producer
 *   still owns the original. Ownership release additionally re-verifies the
 *   unchanged declared size and digest, so a foreign entry that only shares
 *   device/inode metadata is preserved rather than deleted. A pin that can
 *   neither be created nor verified refuses or preserves, never guesses.
 * - Successful reads consume only the exact file inode they verified. A
 *   replaced, foreign, or modified entry is preserved. Directory removal
 *   belongs to the broker that created the namespace, and only when its
 *   identity still matches and it is empty.
 * - JSON-encoding the value preserves exact JavaScript text, including lone
 *   surrogates that UTF-8 alone would replace. NUL content policy is unchanged
 *   and enforced by the prompt/startup validators, never waived here.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

import { parseSessionHostPayloadRef, type SessionHostPayloadRef } from "./protocol";

export type SessionHostPayloadFailure =
  | "invalid-descriptor"
  | "unsafe-directory"
  | "unavailable"
  | "not-regular-file"
  | "size-mismatch"
  | "digest-mismatch"
  | "replaced"
  | "decode-failed";

/** Bounded failure kind; the message never includes a path, digest, or payload text. */
export class SessionHostPayloadError extends Error {
  readonly reason: SessionHostPayloadFailure;

  constructor(reason: SessionHostPayloadFailure) {
    super(`session-host payload ${reason}`);
    this.name = "SessionHostPayloadError";
    this.reason = reason;
  }
}

export interface StagedSessionHostPayload {
  readonly descriptor: SessionHostPayloadRef;
  /** Namespace inode identity observed by the producer at staging time. */
  readonly directoryIdentity: SessionHostPayloadDirectoryIdentity;
  /**
   * Releases this staging call's ownership exactly once: removes the file only
   * while its pinned identity and its unchanged declared size and digest still
   * match, then releases the retained continuity pin. Idempotent; a consumed,
   * missing, replaced, foreign, or modified entry is preserved.
   */
  discard(): void;
}

/** Exact decimal directory identity, safe to carry through JSON on every platform. */
export interface SessionHostPayloadDirectoryIdentity {
  readonly dev: string;
  readonly ino: string;
}

/**
 * Exact kernel file identity. `bigint` stats keep device/inode equality exact
 * on filesystems whose numbers exceed `Number.MAX_SAFE_INTEGER`, so float
 * rounding can never masquerade as the same object.
 */
interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface PayloadDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

const PAYLOAD_FILE_PREFIX = "p-";
const PAYLOAD_FILE_SUFFIX = ".json";
/** Continuity-pin names are deliberately not parseable payload references. */
const PAYLOAD_PIN_PREFIX = "pin-";
const PAYLOAD_PIN_SUFFIX = ".pin";
const PAYLOAD_FLAGS_READ = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
/** Exclusive creation also reads back its own bytes for the ownership pin. */
const PAYLOAD_FLAGS_WRITE = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Which kernel continuity proof pins the staged object for its ownership
 * lifetime. Both keep the owned inode allocated, so a just-unlinked number can
 * never be handed to an unlinked-and-recreated entry:
 *
 * - POSIX: the retained creation descriptor (no extra namespace entry).
 * - Windows: a private hard link, because Node opens files with
 *   `FILE_SHARE_DELETE` and a retained handle leaves a removed name
 *   delete-pending. An independent owner could then no longer replace the entry
 *   while the producer still holds its stale handle — replacement behavior the
 *   transport must keep tolerating on that platform. A hard link pins the inode
 *   without holding it open, so the staged name stays removable/recreatable
 *   while no replacement can reuse the owned identity.
 */
const PAYLOAD_OWNERSHIP_PIN_SUPPORTED = process.platform !== "win32";

/** Narrow seam for deterministic replaced-namespace regressions; absent in production. */
let directoryObservationHookForTests: ((phase: "canonical" | "before-commit") => void) | undefined;
/** Narrow seam for deterministic unpinned-ownership regressions; absent in production. */
let ownershipPinOverrideForTests: boolean | undefined;

/** The platform pin decision, overridable only by the bounded test seam above. */
function ownershipPinSupported(): boolean {
  return ownershipPinOverrideForTests ?? PAYLOAD_OWNERSHIP_PIN_SUPPORTED;
}

export const __test = Object.freeze({
  setDirectoryObservationHookForTests(
    hook: ((phase: "canonical" | "before-commit") => void) | undefined,
  ): void {
    directoryObservationHookForTests = hook;
  },
  setOwnershipPinForTests(enabled: boolean | undefined): void {
    ownershipPinOverrideForTests = enabled;
  },
});

function assertPrivateDirectory(stats: { isDirectory(): boolean; isSymbolicLink(): boolean; mode: bigint; uid: bigint }): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SessionHostPayloadError("unsafe-directory");
  if (process.platform !== "win32") {
    if ((stats.mode & 0o777n) !== 0o700n) throw new SessionHostPayloadError("unsafe-directory");
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    if (uid !== undefined && stats.uid !== uid) throw new SessionHostPayloadError("unsafe-directory");
  }
}

/** Validate one canonical nonnegative decimal identifier without Number conversion. */
function isCanonicalIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return false;
  try {
    return BigInt(value).toString() === value;
  } catch {
    return false;
  }
}

/** Shared decoder for the private JSON handoff; numeric or lossy aliases are refused. */
export function parseSessionHostPayloadDirectoryIdentity(value: unknown): SessionHostPayloadDirectoryIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { dev, ino } = value as Record<string, unknown>;
  return isCanonicalIdentifier(dev) && isCanonicalIdentifier(ino) ? { dev, ino } : undefined;
}

/** Encode native bigint identities exactly, including large NTFS file identifiers. */
export function encodeSessionHostPayloadDirectoryIdentity(identity: FileIdentity): SessionHostPayloadDirectoryIdentity {
  if (identity.dev < 0n || identity.ino < 0n) throw new SessionHostPayloadError("unsafe-directory");
  return { dev: identity.dev.toString(), ino: identity.ino.toString() };
}

/** Exact comparison with the canonical decimal identity carried through JSON. */
function matchesDirectoryIdentity(
  actual: FileIdentity,
  expected: SessionHostPayloadDirectoryIdentity | undefined,
): boolean {
  if (expected === undefined) return true;
  const parsed = parseSessionHostPayloadDirectoryIdentity(expected);
  return parsed !== undefined && actual.dev === BigInt(parsed.dev) && actual.ino === BigInt(parsed.ino);
}

/**
 * Canonicalizes and verifies the host-owned private namespace. The supplied
 * final path component must not be a symlink, and the canonical target must
 * have the same directory inode that was observed before canonicalization.
 * Parent-component symlinks (for example macOS `/var` -> `/private/var`) are
 * accepted only through that identity fence. This rejects a replaced or
 * redirecting namespace; it is a best-effort same-user check, not an atomic
 * sandbox against a racing process that owns the same directories.
 */
function canonicalPayloadDirectory(
  dir: string,
  expectedIdentity?: SessionHostPayloadDirectoryIdentity,
): PayloadDirectory {
  if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0") || !isAbsolute(dir)) {
    throw new SessionHostPayloadError("unsafe-directory");
  }
  let initial;
  try {
    initial = lstatSync(dir, { bigint: true });
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  assertPrivateDirectory(initial);
  if (!matchesDirectoryIdentity(initial, expectedIdentity)) {
    throw new SessionHostPayloadError("replaced");
  }
  directoryObservationHookForTests?.("canonical");
  let canonical: string;
  let final;
  try {
    canonical = realpathSync(dir);
    final = lstatSync(canonical, { bigint: true });
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  assertPrivateDirectory(final);
  if (final.dev !== initial.dev || final.ino !== initial.ino
    || !matchesDirectoryIdentity(final, expectedIdentity)) {
    throw new SessionHostPayloadError("replaced");
  }
  return { path: canonical, identity: { dev: final.dev, ino: final.ino } };
}

/** Rechecks that the namespace is still the exact directory this operation validated. */
function assertPayloadDirectoryUnchanged(directory: PayloadDirectory): void {
  directoryObservationHookForTests?.("before-commit");
  let current;
  try {
    current = lstatSync(directory.path, { bigint: true });
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== directory.identity.dev || current.ino !== directory.identity.ino) {
    throw new SessionHostPayloadError("replaced");
  }
}

function payloadFilePath(directory: string, descriptor: SessionHostPayloadRef): string {
  const parsed = parseSessionHostPayloadRef(descriptor);
  if (!parsed || parsed.name !== descriptor.name) throw new SessionHostPayloadError("invalid-descriptor");
  return join(directory, parsed.name);
}

/** True while the opened descriptor still holds exactly the staged bytes. */
function descriptorHoldsStagedBytes(
  fd: number,
  identity: FileIdentity,
  descriptor: SessionHostPayloadRef,
): boolean {
  let stats;
  try {
    stats = fstatSync(fd, { bigint: true });
  } catch {
    return false;
  }
  if (!stats.isFile() || stats.dev !== identity.dev || stats.ino !== identity.ino) return false;
  if (stats.size !== BigInt(descriptor.size)) return false;
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(descriptor.size, 1)));
  let offset = 0;
  while (offset < descriptor.size) {
    const wanted = Math.min(chunk.length, descriptor.size - offset);
    let read: number;
    try {
      read = readSync(fd, chunk, 0, wanted, offset);
    } catch {
      return false;
    }
    if (read <= 0) return false;
    hash.update(chunk.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex") === descriptor.sha256;
}

/**
 * The kernel continuity proof held for one staged object: a retained
 * descriptor, or a private hard link to the same inode. Both are created by the
 * staged call itself and prove afterwards that the owned inode is still the one
 * allocated for that identity.
 */
type StagedOwnershipPin =
  | { readonly kind: "descriptor"; readonly fd: number }
  | { readonly kind: "link"; readonly path: string };

/**
 * Releases one staged ownership handle. Removal happens only while the pinned
 * identity and the unchanged declared size and digest all still match, and the
 * pin is released exactly once on every path — including an entry a consumer
 * already consumed. An unverifiable pin preserves the entry (fail closed).
 */
function releaseOwnedPayloadFile(
  path: string,
  identity: FileIdentity,
  descriptor: SessionHostPayloadRef,
  pin: StagedOwnershipPin,
): void {
  if (pin.kind === "descriptor") {
    // The retained descriptor keeps this inode allocated, so the entry is
    // either this exact object or gone. Unlink while still pinned, then close.
    try {
      if (descriptorHoldsStagedBytes(pin.fd, identity, descriptor)) removeOwnedPayloadFile(path, identity);
    } finally {
      try {
        closeSync(pin.fd);
      } catch {
        // The discard decision remains authoritative.
      }
    }
    return;
  }
  releaseLinkedPayloadFile(path, pin.path, identity, descriptor);
}

/**
 * Releases an ownership handle pinned by a private hard link. The link keeps
 * the owned inode allocated, so an entry at the payload path that reports the
 * same exact identity is provably the same original object — never a recycled
 * one — even when its bytes would otherwise match. The payload entry is removed
 * first, while the pin link still holds the inode, then the pin link itself.
 */
function releaseLinkedPayloadFile(
  path: string,
  pinPath: string,
  identity: FileIdentity,
  descriptor: SessionHostPayloadRef,
): void {
  let fd: number | undefined;
  let pinIsOwned = false;
  try {
    try {
      fd = openSync(pinPath, PAYLOAD_FLAGS_READ);
    } catch {
      // The pin entry is gone or unreadable: ownership is unproven, so the
      // payload entry stays preserved and no foreign entry is touched.
      return;
    }
    // The pin link is ours only while it still reports the staged identity; a
    // replaced pin proves nothing and both entries stay preserved.
    const pinned = fstatSync(fd, { bigint: true });
    if (!pinned.isFile() || pinned.dev !== identity.dev || pinned.ino !== identity.ino) return;
    pinIsOwned = true;
    // Unchanged declared size and digest authorize removing the payload entry.
    if (descriptorHoldsStagedBytes(fd, identity, descriptor)) removeOwnedPayloadFile(path, identity);
  } catch {
    // Fail closed: an unverifiable pin never authorizes a deletion.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The discard decision remains authoritative.
      }
    }
    if (pinIsOwned) removeOwnedPayloadFile(pinPath, identity);
  }
}

/** Removes only the exact regular-file inode this process verified or created. */
function removeOwnedPayloadFile(path: string, identity: FileIdentity): void {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isFile() && !stats.isSymbolicLink() && stats.dev === identity.dev && stats.ino === identity.ino) {
      unlinkSync(path);
    }
  } catch {
    // Already absent, or replaced/unknown: preserve it fail closed.
  }
}

function toIdentity(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function decodePayloadBytes(bytes: Buffer, descriptor: SessionHostPayloadRef): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256) throw new SessionHostPayloadError("digest-mismatch");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SessionHostPayloadError("decode-failed");
  }
}

function verifyOpenedPayload(
  opened: { isFile(): boolean; size: bigint; dev: bigint; ino: bigint; isSymbolicLink(): boolean },
  descriptor: SessionHostPayloadRef,
  path: string,
): FileIdentity {
  if (!opened.isFile() || opened.isSymbolicLink()) throw new SessionHostPayloadError("not-regular-file");
  if (opened.size !== BigInt(descriptor.size)) throw new SessionHostPayloadError("size-mismatch");
  let entry;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  if (!entry.isFile() || entry.isSymbolicLink()
    || entry.dev !== opened.dev || entry.ino !== opened.ino) {
    throw new SessionHostPayloadError("replaced");
  }
  return toIdentity(opened);
}

/**
 * Writes the exact JSON text into a fresh exclusive `0600` file in the
 * host-owned private namespace and retains its ownership pin. A partial write,
 * short file, or replaced inode fails and releases only this call's exact file.
 */
export function stageSessionHostPayload(
  directory: string,
  jsonText: string,
  expectedIdentity?: SessionHostPayloadDirectoryIdentity,
): StagedSessionHostPayload {
  if (typeof jsonText !== "string" || jsonText.length === 0) {
    throw new SessionHostPayloadError("invalid-descriptor");
  }
  const root = canonicalPayloadDirectory(directory, expectedIdentity);
  const directoryIdentity = encodeSessionHostPayloadDirectoryIdentity(root.identity);
  const bytes = Buffer.from(jsonText, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${PAYLOAD_FILE_PREFIX}${randomBytes(16).toString("hex")}${PAYLOAD_FILE_SUFFIX}`;
  const path = join(root.path, name);
  let fd: number | undefined;
  let pin: StagedOwnershipPin | undefined;
  let pinPath: string | undefined;
  let identity: FileIdentity | undefined;
  try {
    const creation = openSync(path, PAYLOAD_FLAGS_WRITE, 0o600);
    fd = creation;
    const opened = fstatSync(creation, { bigint: true });
    if (!opened.isFile()) throw new SessionHostPayloadError("not-regular-file");
    identity = toIdentity(opened);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(creation, bytes, offset, bytes.length - offset);
      if (!(written > 0)) throw new SessionHostPayloadError("unavailable");
      offset += written;
    }
    const finished = fstatSync(creation, { bigint: true });
    if (!finished.isFile() || finished.size !== BigInt(bytes.length)) throw new SessionHostPayloadError("size-mismatch");
    if (finished.dev !== identity.dev || finished.ino !== identity.ino) throw new SessionHostPayloadError("replaced");
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()
      || entry.dev !== identity.dev || entry.ino !== identity.ino) {
      throw new SessionHostPayloadError("replaced");
    }
    assertPayloadDirectoryUnchanged(root);
    // Establish the kernel continuity pin only after every staging check
    // succeeded. Both forms keep the owned inode allocated for the ownership
    // lifetime, so a replacement entry can never alias it.
    if (ownershipPinSupported()) {
      pin = { kind: "descriptor", fd: creation };
      fd = undefined;
    } else {
      pinPath = join(root.path, `${PAYLOAD_PIN_PREFIX}${randomBytes(16).toString("hex")}${PAYLOAD_PIN_SUFFIX}`);
      linkSync(path, pinPath);
      const linked = lstatSync(pinPath, { bigint: true });
      if (!linked.isFile() || linked.dev !== identity.dev || linked.ino !== identity.ino) {
        throw new SessionHostPayloadError("replaced");
      }
      closeSync(creation);
      fd = undefined;
      pin = { kind: "link", path: pinPath };
    }
    const descriptor: SessionHostPayloadRef = { name, size: bytes.length, sha256 };
    const owned = identity;
    const ownedPin = pin;
    let released = false;
    return {
      descriptor,
      directoryIdentity,
      discard: () => {
        if (released) return;
        released = true;
        releaseOwnedPayloadFile(path, owned, descriptor, ownedPin);
      },
    };
  } catch (error) {
    // Remove the staged name and any continuity pin while this call's
    // descriptor or link still references the exact inode, then close.
    if (identity !== undefined) removeOwnedPayloadFile(path, identity);
    if (pinPath !== undefined && identity !== undefined) removeOwnedPayloadFile(pinPath, identity);
    if (pin?.kind === "descriptor") {
      try {
        closeSync(pin.fd);
      } catch {
        // The staging failure remains authoritative.
      }
    }
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The staging failure remains authoritative.
      }
    }
    if (error instanceof SessionHostPayloadError) throw error;
    throw new SessionHostPayloadError("unavailable");
  }
}

/**
 * Verifies and reads the exact declared payload, consuming that file inode
 * only after the full identity/size/digest verification succeeds.
 */
export async function readSessionHostPayload(
  directory: string,
  descriptor: SessionHostPayloadRef,
  expectedIdentity?: SessionHostPayloadDirectoryIdentity,
): Promise<string> {
  const parsed = parseSessionHostPayloadRef(descriptor);
  if (!parsed) throw new SessionHostPayloadError("invalid-descriptor");
  const root = canonicalPayloadDirectory(directory, expectedIdentity);
  const path = payloadFilePath(root.path, parsed);
  let handle: FileHandle;
  try {
    handle = await openFile(path, PAYLOAD_FLAGS_READ);
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  let text: string | undefined;
  let identity: FileIdentity | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    identity = verifyOpenedPayload(opened, parsed, path);
    const bytes = Buffer.alloc(parsed.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) throw new SessionHostPayloadError("size-mismatch");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, bytes.length);
    if (extraBytes !== 0) throw new SessionHostPayloadError("size-mismatch");
    const finished = await handle.stat({ bigint: true });
    if (finished.size !== BigInt(parsed.size) || finished.dev !== identity.dev || finished.ino !== identity.ino) {
      throw new SessionHostPayloadError("replaced");
    }
    text = decodePayloadBytes(bytes, parsed);
    assertPayloadDirectoryUnchanged(root);
  } finally {
    try {
      await handle.close();
    } catch {
      // The verified result or the bounded failure remains authoritative.
    }
  }
  if (identity !== undefined) {
    // Consume only after the verified descriptor is closed, so Windows can
    // delete it and a replaced entry is still preserved by identity check.
    removeOwnedPayloadFile(path, identity);
  }
  if (text === undefined) throw new SessionHostPayloadError("unavailable");
  return text;
}

/**
 * Consumes exactly one verified payload without using its text. This is the
 * broker/reporter cleanup primitive for a request that was definitely
 * rejected before the host callback: it removes only a file whose registered
 * namespace identity, no-follow file identity, size, hash, and UTF-8 value all
 * verify. Missing, tampered, replaced, or foreign entries stay preserved.
 */
export async function discardSessionHostPayload(
  directory: string,
  descriptor: SessionHostPayloadRef,
  expectedIdentity?: SessionHostPayloadDirectoryIdentity,
): Promise<void> {
  await readSessionHostPayload(directory, descriptor, expectedIdentity);
}

/** Synchronous variant for the pre-main child startup handshake (no event loop yet). */
export function readSessionHostPayloadSync(
  directory: string,
  descriptor: SessionHostPayloadRef,
  expectedIdentity?: SessionHostPayloadDirectoryIdentity,
): string {
  const parsed = parseSessionHostPayloadRef(descriptor);
  if (!parsed) throw new SessionHostPayloadError("invalid-descriptor");
  const root = canonicalPayloadDirectory(directory, expectedIdentity);
  const path = payloadFilePath(root.path, parsed);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(path, PAYLOAD_FLAGS_READ);
    } catch {
      throw new SessionHostPayloadError("unavailable");
    }
    const opened = fstatSync(fd, { bigint: true });
    const identity = verifyOpenedPayload(opened, parsed, path);
    const bytes = Buffer.alloc(parsed.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new SessionHostPayloadError("size-mismatch");
      offset += read;
    }
    const extra = Buffer.alloc(1);
    const extraBytes = readSync(fd, extra, 0, 1, bytes.length);
    if (extraBytes !== 0) throw new SessionHostPayloadError("size-mismatch");
    const finished = fstatSync(fd, { bigint: true });
    if (finished.size !== BigInt(parsed.size) || finished.dev !== identity.dev || finished.ino !== identity.ino) {
      throw new SessionHostPayloadError("replaced");
    }
    closeSync(fd);
    fd = undefined;
    const text = decodePayloadBytes(bytes, parsed);
    assertPayloadDirectoryUnchanged(root);
    removeOwnedPayloadFile(path, identity);
    return text;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The verified result or the bounded failure remains authoritative.
      }
    }
  }
}

/**
 * Decodes one staged JSON string value exactly. JSON preserves lone
 * surrogates and all other JavaScript text that a raw UTF-8 round-trip would
 * not. NUL policy is unchanged: a staged prompt must not contain NUL.
 */
export function decodeSessionHostPayloadJsonString(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "string" || parsed.length === 0 || parsed.includes("\0")) return undefined;
  return parsed;
}
