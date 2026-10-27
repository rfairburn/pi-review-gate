/**
 * Canonical native Pi session references (#533).
 *
 * Every Pi session this project spawns — reviewers, execute/research/inplace
 * workers, and any other project-owned Pi child — is stored by Pi itself in the
 * standard native session store the CHILD resolves (`--session-dir` >
 * `PI_CODING_AGENT_SESSION_DIR` > the `sessionDir` setting >
 * `<agentDir>/sessions/<encoded cwd>`). The gate never redirects that store,
 * never mirrors a transcript, and never re-implements Pi's store precedence.
 *
 * What the gate keeps for each spawned session is exactly ONE canonical
 * association inside the session owner's own artifact directory:
 *
 *   `<ownerArtifactDir>/pi-sessions/<session-id>.json`
 *   `{ "id": "<native session id>", "file": "<absolute jsonl path>", "cwd": "<absolute workspace>" }`
 *
 * - `file` and `cwd` are always absolute and `resolve()`-normalized. A relative
 *   path is never recorded, never handed to `--session` (Pi would resolve it
 *   against the NEW process cwd and silently fork history into a second file),
 *   and never used as a deletion target.
 * - One reference per owner/session, keyed by session id — never a per-turn
 *   duplicate file and never a second registry of the same path state.
 * - References come from authoritative sources only: the child's RPC
 *   `get_state` identity, or the gate-owned reporter extension
 *   (`src/pi-session-reference-reporter.ts`) reading `ctx.sessionManager`.
 *   There is no shared-store scan, `list`/`listAll`, glob, or re-resolution
 *   behind this module.
 *
 * The same surface is what a later opt-in cleanup consumer needs: enumerate the
 * owner's own `pi-sessions/` directory, read each reference, and validate the
 * referenced file's native header identity before touching it. Nothing here
 * deletes anything and nothing here inspects the shared session store.
 */
import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readSavedSessionHeader } from "./session-header";
import { readBoundedTextFile } from "./bounded-file";
import { atomicWrite } from "./execution/durable-write";
import { isRecord } from "./record-guard";

/** Owner-artifact subdirectory holding this owner's canonical session references. */
export const PI_SESSION_REFERENCE_DIRNAME = "pi-sessions";

/** A reference record is a tiny JSON object; anything larger is refused unread. */
export const PI_SESSION_REFERENCE_MAX_BYTES = 8 * 1024;

/** Pi's own session-id character set (letters, digits, `.`, `_`, `-`). */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Control characters never appear in a path or id this module will record. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const MAX_REFERENCE_FIELD_LENGTH = 4096;

/** The one canonical reference shape: native id, absolute session file, absolute cwd. */
export interface PiSessionReference {
  id: string;
  file: string;
  cwd: string;
}

export interface PiSessionReferenceIssue {
  reason: "invalid" | "conflict" | "write-failed";
  message: string;
}

export type PiSessionReferenceResult<T> = { ok: true; value: T } | ({ ok: false } & PiSessionReferenceIssue);

/** Why a reference does not describe a resumable native session. */
export type PiSessionReferenceVerification =
  | { ok: true; header: { id: string; cwd: string } }
  | { ok: false; reason: PiSessionReferenceFailureReason; message: string };

export type PiSessionReferenceFailureReason =
  | "file-missing"
  | "not-regular-file"
  | "header-unreadable"
  | "id-mismatch"
  | "cwd-mismatch";

function isUsableSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REFERENCE_FIELD_LENGTH
    && !CONTROL_CHARACTERS.test(value)
    && PI_SESSION_ID_PATTERN.test(value)
    && /^[A-Za-z0-9]/.test(value)
    && /[A-Za-z0-9]$/.test(value);
}

function isUsablePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REFERENCE_FIELD_LENGTH
    && !CONTROL_CHARACTERS.test(value);
}

/** Absolute-path equality with a realpath fallback (`/var` → `/private/var`). */
export function piSessionPathsMatch(left: string, right: string): boolean {
  return pathsMatch(left, right);
}

function pathsMatch(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    // Both operands are paths the caller already owns; a missing path simply
    // fails the comparison rather than throwing.
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Canonicalize one authoritative session identity into a reference.
 *
 * `file` may be RELATIVE: Pi reports a relative `getSessionFile()` and a
 * relative `get_state.sessionFile` whenever the effective `sessionDir` is
 * relative, and the child resolves it against ITS OWN cwd. `relativeTo` is that
 * child/session cwd, never the gate's cwd. The result is absolute or the
 * reference is refused — a relative reference is invalid by construction here.
 */
export function canonicalPiSessionReference(input: {
  id: unknown;
  file: unknown;
  cwd: unknown;
  relativeTo?: string;
}): PiSessionReferenceResult<PiSessionReference> {
  if (!isUsableSessionId(input.id)) {
    return { ok: false, reason: "invalid", message: 'Reference field "id" is not a usable Pi session id.' };
  }
  if (!isUsablePath(input.file)) {
    return { ok: false, reason: "invalid", message: 'Reference field "file" is not a usable path.' };
  }
  if (!isUsablePath(input.cwd)) {
    return { ok: false, reason: "invalid", message: 'Reference field "cwd" is not a usable path.' };
  }
  const cwd = isAbsolute(input.cwd)
    ? resolve(input.cwd)
    : input.relativeTo !== undefined
      ? resolve(input.relativeTo, input.cwd)
      : undefined;
  if (cwd === undefined || !isAbsolute(cwd)) {
    return { ok: false, reason: "invalid", message: 'Reference field "cwd" must be absolute or resolvable against the session cwd.' };
  }
  const file = isAbsolute(input.file)
    ? resolve(input.file)
    : resolve(cwd, input.file);
  if (!isAbsolute(file)) {
    return { ok: false, reason: "invalid", message: 'Reference field "file" must be absolute after resolving against the session cwd.' };
  }
  return { ok: true, value: { id: input.id, file, cwd } };
}

/** Exact owner-artifact path of one session's reference. */
export function piSessionReferencePath(ownerArtifactDir: string, sessionId: string): string {
  if (!isUsableSessionId(sessionId)) {
    throw new Error(`Cannot derive a session reference path from ${JSON.stringify(sessionId)}.`);
  }
  return join(ownerArtifactDir, PI_SESSION_REFERENCE_DIRNAME, `${sessionId}.json`);
}

/**
 * Parse a STORED record.
 *
 * Stored records are already canonical: `canonicalPiSessionReference` resolved
 * the authoritative child identity when the record was written. A relative or
 * non-normalized path here is a malformed association, so it is refused as-is —
 * never quietly re-resolved against some other cwd and repointed.
 */
function parseStoredReference(text: string): PiSessionReference | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { id, file, cwd } = parsed;
  if (!isUsableSessionId(id)) return undefined;
  if (!isUsablePath(file) || !isAbsolute(file) || resolve(file) !== file) return undefined;
  if (!isUsablePath(cwd) || !isAbsolute(cwd) || resolve(cwd) !== cwd) return undefined;
  return { id, file, cwd };
}

type StoredReference =
  | { kind: "missing" }
  | { kind: "reference"; reference: PiSessionReference }
  | { kind: "unreadable"; detail: string };

/** Distinguish "no record" from "a record this module cannot honour". */
async function inspectReferenceAt(path: string): Promise<StoredReference> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return { kind: "missing" };
  if (!info.isFile()) return { kind: "unreadable", detail: "the reference path is not a regular file" };
  const read = await readBoundedTextFile(path, PI_SESSION_REFERENCE_MAX_BYTES).catch(() => undefined);
  if (!read) return { kind: "unreadable", detail: "the reference file could not be read" };
  if (read.truncated) {
    return { kind: "unreadable", detail: `the reference file exceeds ${PI_SESSION_REFERENCE_MAX_BYTES} bytes and was refused unread` };
  }
  const reference = parseStoredReference(read.text);
  return reference
    ? { kind: "reference", reference }
    : { kind: "unreadable", detail: "the reference file is not a canonical {id,file,cwd} record with absolute normalized paths" };
}

function sameReference(left: PiSessionReference, right: PiSessionReference): boolean {
  return left.id === right.id && left.file === right.file && left.cwd === right.cwd;
}

/**
 * Read one reference at an exact path. Missing, oversized, malformed, or
 * non-canonical content is an unavailable reference, never a partial one.
 */
export async function readPiSessionReferenceAt(path: string): Promise<PiSessionReference | undefined> {
  const stored = await inspectReferenceAt(path);
  return stored.kind === "reference" ? stored.reference : undefined;
}

/** Read the owner's reference for one session id. */
export async function readPiSessionReference(ownerArtifactDir: string, sessionId: string): Promise<PiSessionReference | undefined> {
  // Throws for an unusable id exactly as the path derivation always has.
  piSessionReferencePath(ownerArtifactDir, sessionId);
  const owned = await verifyPiSessionReferenceDirectoryOwnership(ownerArtifactDir);
  if (!owned.ok || !owned.referenceDirectory) return undefined;
  return readPiSessionReferenceAt(join(owned.referenceDirectory, `${sessionId}.json`));
}

/**
 * Prove that an owner artifact's `pi-sessions/` directory is really the OWNER's.
 *
 * That directory is the only thing making a set of references belong to this
 * artifact, so it is never followed through a symlink: neither the reference
 * directory itself nor its canonical target may leave the canonical owner
 * artifact. Native header verification cannot detect an ownership substitution —
 * another artifact's records are perfectly well-formed — so this containment IS
 * the ownership check, and it stays separate from any consumer-specific
 * traversal bound (evidence bounds, cleanup bounds).
 *
 * `{ ok: true }` with no `referenceDirectory` means the owner simply has no
 * references; that is an empty result, not a refusal.
 */
export async function verifyPiSessionReferenceDirectoryOwnership(
  ownerArtifactDir: string,
): Promise<{ ok: true; referenceDirectory?: string } | { ok: false; message: string }> {
  const ownerRoot = await realpath(ownerArtifactDir).catch(() => undefined);
  if (!ownerRoot) return await absentOwnerReferenceDirectory(ownerArtifactDir);
  const candidate = join(ownerRoot, PI_SESSION_REFERENCE_DIRNAME);
  const info = await lstat(candidate).catch(() => undefined);
  if (!info) return { ok: true };
  if (info.isSymbolicLink()) {
    return {
      ok: false,
      message: `${candidate} is a symlink; a session reference directory must be a real directory inside the owner artifact, so nothing was read through it`,
    };
  }
  if (!info.isDirectory()) {
    return { ok: false, message: `${candidate} is not a directory, so no session references were read from it` };
  }
  const real = await realpath(candidate).catch(() => undefined);
  if (!real) {
    return { ok: false, message: `${candidate} could not be resolved, so no session references were read from it` };
  }
  if (real !== ownerRoot && !real.startsWith(ownerRoot.endsWith(sep) ? ownerRoot : `${ownerRoot}${sep}`)) {
    return {
      ok: false,
      message: `${candidate} resolves to ${real}, outside the owner artifact ${ownerRoot}; no session references were read from it`,
    };
  }
  return { ok: true, referenceDirectory: real };
}

/**
 * An owner artifact that does not exist yet has no references — that is an
 * empty result and a legitimate first write, not a refusal. Anything else at
 * that path (a file, or a directory that cannot be canonicalized) is refused.
 */
async function absentOwnerReferenceDirectory(ownerArtifactDir: string): Promise<{ ok: true; referenceDirectory?: string } | { ok: false; message: string }> {
  const info = await lstat(ownerArtifactDir).catch(() => undefined);
  if (!info) return { ok: true };
  return {
    ok: false,
    message: info.isDirectory()
      ? `the owner artifact directory ${ownerArtifactDir} could not be canonicalized`
      : `the owner artifact path ${ownerArtifactDir} is not a directory`,
  };
}

/**
 * Record one canonical reference at an exact owner-owned path.
 *
 * Idempotent for the same identity. Anything already at that path which is not
 * the identical canonical record — a different file or cwd for the same id (the
 * duplicate-native-id hazard) or a foreign/malformed association — is preserved
 * untouched and reported. This module never repairs or repoints an existing
 * association.
 */
export async function writePiSessionReferenceAt(path: string, reference: PiSessionReference): Promise<PiSessionReferenceResult<{ path: string; created: boolean }>> {
  const canonical = canonicalPiSessionReference(reference);
  if (!canonical.ok) return canonical;
  const value = canonical.value;
  const expectedName = `${value.id}.json`;
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base !== expectedName) {
    return {
      ok: false,
      reason: "invalid",
      message: `Reference path "${path}" is not the canonical "${expectedName}" name for session ${value.id}.`,
    };
  }
  const existing = await inspectReferenceAt(path);
  if (existing.kind === "unreadable") {
    return {
      ok: false,
      reason: "conflict",
      message: `An existing session reference at ${path} was preserved untouched because ${existing.detail}; it was not overwritten.`,
    };
  }
  if (existing.kind === "reference") {
    if (sameReference(existing.reference, value)) return { ok: true, value: { path, created: false } };
    return {
      ok: false,
      reason: "conflict",
      message: `A different native session reference is already recorded for session ${existing.reference.id} (${existing.reference.file}); the existing reference was preserved.`,
    };
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, `${JSON.stringify({ id: value.id, file: value.file, cwd: value.cwd }, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      message: `Could not record the native session reference: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, value: { path, created: true } };
}

/** Record one canonical reference in the owner's `pi-sessions/` directory. */
export function writePiSessionReference(
  ownerArtifactDir: string,
  reference: PiSessionReference,
): Promise<PiSessionReferenceResult<{ path: string; created: boolean }>> {
  return (async () => {
    let path: string;
    try {
      path = piSessionReferencePath(ownerArtifactDir, reference.id);
    } catch (error) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // Never record through a reference directory that is not the owner's own,
    // and never create one that would shadow a foreign path.
    const owned = await verifyPiSessionReferenceDirectoryOwnership(ownerArtifactDir);
    if (!owned.ok) {
      return {
        ok: false as const,
        reason: "write-failed" as const,
        message: `The native session reference was not recorded: ${owned.message}.`,
      };
    }
    return await writePiSessionReferenceAt(
      owned.referenceDirectory ? join(owned.referenceDirectory, `${reference.id}.json`) : path,
      reference,
    );
  })();
}

export interface PiSessionReferenceEntry {
  /** Directory entry name, e.g. `<session-id>.json`. */
  name: string;
  /** Exact path of this owner's reference entry. */
  path: string;
  /** Present only for a canonical record whose name matches its recorded id. */
  reference?: PiSessionReference;
  /** Present whenever `reference` is absent — never a silent skip. */
  detail?: string;
}

/**
 * Stream this owner's `pi-sessions/` references one entry at a time (never the
 * shared native store, never a recursive walk, never another artifact subtree).
 *
 * The directory handle is read incrementally and closed when the consumer stops
 * iterating, so callers that only need the references for already-selected
 * artifacts never allocate a full listing. There is deliberately NO entry cap
 * here: an owner's cleanup must be able to reach every session its artifacts
 * reference. Consumers with their own bounds (evidence indexing) stop early and
 * disclose the stop themselves.
 */
export async function* iteratePiSessionReferences(ownerArtifactDir: string): AsyncGenerator<PiSessionReferenceEntry> {
  const owned = await verifyPiSessionReferenceDirectoryOwnership(ownerArtifactDir);
  if (!owned.ok) {
    // Ownership failure is reported, never skipped silently: a consumer must
    // see that this artifact's references could not be trusted.
    yield {
      name: PI_SESSION_REFERENCE_DIRNAME,
      path: join(ownerArtifactDir, PI_SESSION_REFERENCE_DIRNAME),
      detail: `The session reference directory is not owned by this artifact: ${owned.message}.`,
    };
    return;
  }
  if (!owned.referenceDirectory) return;
  yield* iteratePiSessionReferenceDirectory(owned.referenceDirectory);
}

/**
 * Iterate one ALREADY-RESOLVED reference directory. Evidence indexing uses this
 * form after its own containment/regular-directory validation, so the same
 * per-entry rules apply without re-deriving the path.
 *
 * `shouldInspectEntry` is consulted for EVERY directory entry — before the
 * filename filter and before any read — so a consumer with its own bound can
 * stop traversal of a directory full of irrelevant names instead of walking all
 * of them. Returning false ends enumeration. Cleanup callers pass nothing and
 * stay uncapped.
 */
export async function* iteratePiSessionReferenceDirectory(
  referenceDirectory: string,
  shouldInspectEntry?: () => boolean,
): AsyncGenerator<PiSessionReferenceEntry> {
  const dir = referenceDirectory;
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await opendir(dir);
  } catch {
    return;
  }
  try {
    while (true) {
      const entry = await handle.read();
      if (!entry) return;
      if (shouldInspectEntry && !shouldInspectEntry()) return;
      if (!entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name);
      const expectedId = entry.name.slice(0, -".json".length);
      if (!isUsableSessionId(expectedId)) {
        yield {
          name: entry.name,
          path,
          detail: 'File name is not a canonical "<session-id>.json" reference name; it was not read.',
        };
        continue;
      }
      const stored = await inspectReferenceAt(path);
      if (stored.kind !== "reference") {
        yield {
          name: entry.name,
          path,
          detail: stored.kind === "missing"
            ? "The reference entry disappeared during enumeration."
            : `Reference is unusable: ${stored.detail}.`,
        };
        continue;
      }
      if (stored.reference.id !== expectedId) {
        yield {
          name: entry.name,
          path,
          detail: `Reference records session "${stored.reference.id}", which does not match its file name; it was not used.`,
        };
        continue;
      }
      yield { name: entry.name, path, reference: stored.reference };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Validate a reference against the native session file it points at: a regular
 * non-symlink file whose first-line `SessionHeader` id and cwd match the
 * reference (and the caller's expected identity when supplied). Read-only and
 * bounded — the transcript itself is never copied or parsed here.
 */
export function verifyPiSessionReference(
  reference: PiSessionReference,
  expected?: { id?: string; cwd?: string },
): PiSessionReferenceVerification {
  const header = readSavedSessionHeader(reference.file);
  if (!header) {
    let reason: PiSessionReferenceFailureReason = "header-unreadable";
    let detail = "it has no readable regular-file session header";
    try {
      const info = lstatSync(reference.file);
      if (!info.isFile()) detail = "it is not a regular file";
    } catch (error) {
      reason = "file-missing";
      detail = `it is unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
    return { ok: false, reason, message: `Native session reference ${reference.file} is not usable: ${detail}.` };
  }
  const expectedId = expected?.id ?? reference.id;
  if (header.id !== reference.id || header.id !== expectedId) {
    return {
      ok: false,
      reason: "id-mismatch",
      message: `Native session file ${reference.file} records session "${header.id}", not the referenced "${expectedId}".`,
    };
  }
  const expectedCwd = expected?.cwd ?? reference.cwd;
  if (!pathsMatch(header.cwd, reference.cwd) || !pathsMatch(header.cwd, expectedCwd)) {
    return {
      ok: false,
      reason: "cwd-mismatch",
      message: `Native session file ${reference.file} records workspace "${header.cwd}", not the expected workspace "${expectedCwd}".`,
    };
  }
  return { ok: true, header };
}

/**
 * Resolve the verified absolute native session file for a continuation.
 *
 * Returns the exact `--session` path only when the owner's reference exists and
 * the referenced file's native header proves this session id and the intended
 * workspace. Every other outcome (no reference, moved or deleted file, foreign
 * id, relocated workspace) is an explicit refusal, so the caller takes the
 * existing fresh-session handoff instead of `--session-id` reuse — which Pi
 * answers with a silently empty duplicate-id session when the cwd differs.
 */
export async function resolveVerifiedPiSessionFile(input: {
  ownerArtifactDir: string;
  sessionId: string;
  cwd: string;
}): Promise<{ ok: true; reference: PiSessionReference } | { ok: false; message: string }> {
  const reference = await readPiSessionReference(input.ownerArtifactDir, input.sessionId).catch(() => undefined);
  if (!reference) {
    const owned = await verifyPiSessionReferenceDirectoryOwnership(input.ownerArtifactDir);
    if (!owned.ok) {
      return {
        ok: false,
        message: `The native session reference for session ${input.sessionId} was not used: ${owned.message}.`,
      };
    }
    return {
      ok: false,
      message: `No canonical native session reference is recorded for session ${input.sessionId} under ${join(input.ownerArtifactDir, PI_SESSION_REFERENCE_DIRNAME)}.`,
    };
  }
  const verified = verifyPiSessionReference(reference, { id: input.sessionId, cwd: input.cwd });
  return verified.ok
    ? { ok: true, reference }
    : { ok: false, message: verified.message };
}
