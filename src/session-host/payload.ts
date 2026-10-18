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
 *   bytes, a replaced inode, and wrong digests are rejected.
 * - Successful reads consume only the exact file inode they verified. A
 *   replaced or foreign entry is preserved. Directory removal belongs to the
 *   broker that created the namespace, and only when its identity still
 *   matches and it is empty.
 * - JSON-encoding the value preserves exact JavaScript text, including lone
 *   surrogates that UTF-8 alone would replace. NUL content policy is unchanged
 *   and enforced by the prompt/startup validators, never waived here.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
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
   * Removes exactly the file this staging call created, only while its path
   * identity still matches. Idempotent; a replaced entry is preserved.
   */
  discard(): void;
}

/** Stable directory inode identity captured when a namespace is created. */
export interface SessionHostPayloadDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileIdentity extends SessionHostPayloadDirectoryIdentity {}

interface PayloadDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

const PAYLOAD_FILE_PREFIX = "p-";
const PAYLOAD_FILE_SUFFIX = ".json";
const PAYLOAD_FLAGS_READ = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const PAYLOAD_FLAGS_WRITE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

/** Narrow seam for deterministic replaced-namespace regressions; absent in production. */
let directoryObservationHookForTests: ((phase: "canonical" | "before-commit") => void) | undefined;

export const __test = Object.freeze({
  setDirectoryObservationHookForTests(
    hook: ((phase: "canonical" | "before-commit") => void) | undefined,
  ): void {
    directoryObservationHookForTests = hook;
  },
});

function assertPrivateDirectory(stats: { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SessionHostPayloadError("unsafe-directory");
  if (process.platform !== "win32") {
    if ((stats.mode & 0o777) !== 0o700) throw new SessionHostPayloadError("unsafe-directory");
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (typeof uid === "number" && stats.uid !== uid) throw new SessionHostPayloadError("unsafe-directory");
  }
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
    initial = lstatSync(dir);
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  assertPrivateDirectory(initial);
  if (expectedIdentity !== undefined
    && (initial.dev !== expectedIdentity.dev || initial.ino !== expectedIdentity.ino)) {
    throw new SessionHostPayloadError("replaced");
  }
  directoryObservationHookForTests?.("canonical");
  let canonical: string;
  let final;
  try {
    canonical = realpathSync(dir);
    final = lstatSync(canonical);
  } catch {
    throw new SessionHostPayloadError("unavailable");
  }
  assertPrivateDirectory(final);
  if (final.dev !== initial.dev || final.ino !== initial.ino
    || (expectedIdentity !== undefined
      && (final.dev !== expectedIdentity.dev || final.ino !== expectedIdentity.ino))) {
    throw new SessionHostPayloadError("replaced");
  }
  return { path: canonical, identity: { dev: final.dev, ino: final.ino } };
}

/** Rechecks that the namespace is still the exact directory this operation validated. */
function assertPayloadDirectoryUnchanged(directory: PayloadDirectory): void {
  directoryObservationHookForTests?.("before-commit");
  let current;
  try {
    current = lstatSync(directory.path);
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

/** Removes only the exact regular-file inode this process verified or created. */
function removeOwnedPayloadFile(path: string, identity: FileIdentity): void {
  try {
    const stats = lstatSync(path);
    if (stats.isFile() && !stats.isSymbolicLink() && stats.dev === identity.dev && stats.ino === identity.ino) {
      unlinkSync(path);
    }
  } catch {
    // Already absent, or replaced/unknown: preserve it fail closed.
  }
}

function toIdentity(stats: { dev: number; ino: number }): FileIdentity {
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
  opened: { isFile(): boolean; size: number; dev: number; ino: number; isSymbolicLink(): boolean },
  descriptor: SessionHostPayloadRef,
  path: string,
): FileIdentity {
  if (!opened.isFile() || opened.isSymbolicLink()) throw new SessionHostPayloadError("not-regular-file");
  if (opened.size !== descriptor.size) throw new SessionHostPayloadError("size-mismatch");
  let entry;
  try {
    entry = lstatSync(path);
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
 * host-owned private namespace. A partial write, short file, or replaced
 * inode fails and removes only this call's exact file.
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
  const bytes = Buffer.from(jsonText, "utf8");
  const name = `${PAYLOAD_FILE_PREFIX}${randomBytes(16).toString("hex")}${PAYLOAD_FILE_SUFFIX}`;
  const path = join(root.path, name);
  let fd: number | undefined;
  let identity: FileIdentity | undefined;
  try {
    fd = openSync(path, PAYLOAD_FLAGS_WRITE, 0o600);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new SessionHostPayloadError("not-regular-file");
    identity = toIdentity(opened);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!(written > 0)) throw new SessionHostPayloadError("unavailable");
      offset += written;
    }
    const finished = fstatSync(fd);
    if (!finished.isFile() || finished.size !== bytes.length) throw new SessionHostPayloadError("size-mismatch");
    if (finished.dev !== identity.dev || finished.ino !== identity.ino) throw new SessionHostPayloadError("replaced");
    closeSync(fd);
    fd = undefined;
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()
      || entry.dev !== identity.dev || entry.ino !== identity.ino) {
      throw new SessionHostPayloadError("replaced");
    }
    assertPayloadDirectoryUnchanged(root);
    const descriptor: SessionHostPayloadRef = {
      name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const owned = identity;
    return {
      descriptor,
      directoryIdentity: root.identity,
      discard: () => removeOwnedPayloadFile(path, owned),
    };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write failure remains authoritative.
      }
    }
    if (identity !== undefined) removeOwnedPayloadFile(path, identity);
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
    const opened = await handle.stat();
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
    const finished = await handle.stat();
    if (finished.size !== parsed.size || finished.dev !== identity.dev || finished.ino !== identity.ino) {
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
    const opened = fstatSync(fd);
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
    const finished = fstatSync(fd);
    if (finished.size !== parsed.size || finished.dev !== identity.dev || finished.ino !== identity.ino) {
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
