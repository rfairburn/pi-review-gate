/**
 * #233: checkpoint record/descriptor codecs and identity validation
 * (extracted from git-checkpoint.ts). Stable format tags, the owned ref and
 * scratch layout, strict record/descriptor encode/decode, and the pure
 * validators (OID/base64/window-id/arm-id/path/stat-identity) that malformed
 * data fails closed against.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { GitCheckpointError } from "./errors";

// ── Record format ────────────────────────────────────────────────────────────

/** Stable tag of the durable checkpoint record (bump on incompatible change). */
export const GIT_CHECKPOINT_RECORD_FORMAT = "prg-git-checkpoint/v2";

/**
 * Stable tag of the compact checkpoint descriptor (bump on incompatible
 * change). The descriptor is the only thing a sidecar must persist to be
 * able to reload and verify the full record later.
 */
export const GIT_CHECKPOINT_DESCRIPTOR_FORMAT = "prg-git-checkpoint-descriptor/v1";

/** Ref namespace owned exclusively by this module. */
export const GIT_CHECKPOINT_REF_PREFIX = "refs/pi-review-gate/checkpoints/";

/** Directory under the git directory holding per-window owned scratch. */
export const SCRATCH_SUBDIR = join("pi-review-gate", "checkpoints");

export type GitCheckpointObjectFormat = "sha1" | "sha256";

/** Exact capture of one non-ignored untracked path at arm time. */
export interface GitCheckpointUntrackedEntry {
  /** Repository-root-relative path, forward slashes. */
  path: string;
  kind: "file" | "symlink";
  /** Full st_mode at capture time. */
  mode: number;
  /** Stat identity fields for cheap re-verification at restore time. */
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Raw file bytes, base64 (files only). */
  contentB64?: string;
  /** Exact symlink target string (symlinks only). */
  target?: string;
}

/**
 * The durable checkpoint record. Small by construction: clean tracked files
 * are referenced only through the pinned base commit, and the two patches
 * carry exactly the staged and unstaged deltas (binary-safe).
 */
export interface GitCheckpointRecord {
  format: typeof GIT_CHECKPOINT_RECORD_FORMAT;
  /**
   * Unique per-arm generation nonce: names this record's owned scratch
   * directory (`arm-<armId>`) and the pin reflog entry that proves which
   * generation owns the window's pin.
   */
  armId: string;
  /** Full object id of the pinned HEAD commit at arm time. */
  base: string;
  /** Owned pin ref holding the base commit against GC until release. */
  ref: string;
  objectFormat: GitCheckpointObjectFormat;
  /** Base→index complete binary patch, base64 ("" when index equals base). */
  stagedPatchB64: string;
  /** Index→worktree complete binary patch, base64 ("" when worktree equals index). */
  unstagedPatchB64: string;
  untracked: GitCheckpointUntrackedEntry[];
}

export interface GitCheckpointArmStats {
  baseCommit: string;
  stagedPatchBytes: number;
  unstagedPatchBytes: number;
  untrackedFileCount: number;
  untrackedRawBytes: number;
  /** Byte length of the encoded record. */
  recordBytes: number;
}

// ── Identity and validation helpers ──────────────────────────────────────────

export const OID_RE_40 = /^[0-9a-f]{40}$/;
export const OID_RE_64 = /^[0-9a-f]{64}$/;

/** 6-bit base64 index of each ASCII character (-1 outside the alphabet). */
const BASE64_INDEX: Int8Array = (() => {
  const table = new Int8Array(256).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

/**
 * Linear-time strict base64 validation for durable record fields. The
 * previous group-repetition regex stack-overflows on the multi-megabyte
 * patch and untracked payloads this module reloads (8+ MiB base64); this
 * scan accepts exactly what `Buffer.toString("base64")` emits: the empty
 * string, or a multiple of four characters over [A-Za-z0-9+/] with at most
 * two trailing "=" padding characters.
 */
export function isStrictBase64(value: string): boolean {
  const len = value.length;
  if (len % 4 !== 0) return false;
  let i = 0;
  for (; i < len; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 61 /* "=" */) break; // padding begins here
    if (code >= BASE64_INDEX.length || BASE64_INDEX[code] < 0) return false;
  }
  // Padding may only occupy the final one or two positions.
  if (i < len - 2) return false;
  for (; i < len; i += 1) {
    if (value.charCodeAt(i) !== 61 /* "=" */) return false;
  }
  return true;
}

function isObjectFormat(value: unknown): value is GitCheckpointObjectFormat {
  return value === "sha1" || value === "sha256";
}

export function oidMatchesFormat(oid: string, format: GitCheckpointObjectFormat): boolean {
  return format === "sha1" ? OID_RE_40.test(oid) : OID_RE_64.test(oid);
}

/** Window ids become ref path segments; keep them to an unambiguous charset. */
export function isSafeWindowId(windowId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(windowId)
    && !windowId.includes("..")
    && !windowId.endsWith(".");
}

/**
 * Arm generation nonces are 8 random bytes as lowercase hex. They become a
 * scratch directory suffix and part of the pin's reflog message, so the
 * charset is fixed to exactly what this module generates.
 */
export function isSafeArmId(armId: string): boolean {
  return /^[0-9a-f]{16}$/.test(armId);
}

/** Owned ref for one review window's baseline pin. */
export function checkpointRefForWindow(windowId: string): string {
  return `${GIT_CHECKPOINT_REF_PREFIX}${windowId}/base`;
}

export function windowIdFromRef(ref: string): string | undefined {
  if (!ref.startsWith(GIT_CHECKPOINT_REF_PREFIX) || !ref.endsWith("/base")) return undefined;
  const id = ref.slice(GIT_CHECKPOINT_REF_PREFIX.length, ref.length - "/base".length);
  return isSafeWindowId(id) ? id : undefined;
}

/** Repository-relative path as emitted by Git: no absolute, no traversal. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) return false;
  // Raw Git path bytes are decoded lossily as UTF-8; an invalid sequence
  // becomes U+FFFD, which cannot be mapped back to the real worktree entry
  // (and would be materialized as a stray file). Refuse it, per the
  // fail-closed contract.
  if (path.includes("\uFFFD")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Exact path or a slash-delimited descendant; `a` never selects `ab`. */
export function isPathSelected(path: string, selectors: ReadonlySet<string>): boolean {
  if (selectors.has(path)) return true;
  let slash = path.indexOf("/");
  while (slash >= 0) {
    if (selectors.has(path.slice(0, slash))) return true;
    slash = path.indexOf("/", slash + 1);
  }
  return false;
}

/** Stat identity used to prove a captured entry is still the same entry. */
export interface StatIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

export function statIdentityOf(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; mode: number }): StatIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode };
}

export function sameStatIdentity(actual: StatIdentity, expected: StatIdentity): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && actual.mode === expected.mode;
}

/** Exact Git blob object id for raw bytes under the repository's format. */
export function blobObjectId(objectFormat: GitCheckpointObjectFormat, bytes: Buffer): string {
  const hash = createHash(objectFormat);
  hash.update(`blob ${bytes.length}`);
  hash.update("\0");
  hash.update(bytes);
  return hash.digest("hex");
}

// ── Record encode/decode (malformed pins fail closed) ────────────────────────

/**
 * Compact durable descriptor for ONE arm generation. It is sufficient —
 * together with the repository itself — to reload and verify the full
 * checkpoint record in a fresh process, but it never contains patch or
 * untracked content: identity (window id, per-arm nonce), repository
 * association (git dir real path), pin coordinates (base, ref, object
 * format), and the SHA-256 integrity digest of the published record bytes.
 */
export interface GitCheckpointDescriptor {
  format: typeof GIT_CHECKPOINT_DESCRIPTOR_FORMAT;
  /** Safe checkpoint window id. */
  windowId: string;
  /** Unique per-arm generation nonce (the owner token). */
  armId: string;
  /** Real path of the repository's git directory at arm time. */
  gitDir: string;
  /** Full object id of the pinned base commit. */
  base: string;
  /** Owned pin ref holding the base commit against GC until release. */
  ref: string;
  objectFormat: GitCheckpointObjectFormat;
  /** SHA-256 hex digest of the exact published record bytes (UTF-8). */
  digest: string;
}

export function encodeGitCheckpointDescriptor(descriptor: GitCheckpointDescriptor): string {
  return JSON.stringify(descriptor);
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Strictly validate a decoded descriptor value; throws malformed_descriptor. */
export function assertValidDescriptor(value: unknown): GitCheckpointDescriptor {
  const malformed = (why: string): never => {
    throw new GitCheckpointError(`malformed checkpoint descriptor: ${why}`, "malformed_descriptor");
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("not an object");
  const raw = value as Record<string, unknown>;
  if (raw.format !== GIT_CHECKPOINT_DESCRIPTOR_FORMAT) {
    return malformed(`unknown format tag ${JSON.stringify(raw.format)}`);
  }
  if (typeof raw.windowId !== "string" || !isSafeWindowId(raw.windowId)) {
    return malformed(`unsafe window id ${JSON.stringify(raw.windowId)}`);
  }
  if (typeof raw.armId !== "string" || !isSafeArmId(raw.armId)) {
    return malformed(`unsafe arm id ${JSON.stringify(raw.armId)}`);
  }
  if (
    typeof raw.gitDir !== "string"
    || raw.gitDir.length === 0
    || !isAbsolute(raw.gitDir)
    || raw.gitDir.includes("\0")
  ) {
    return malformed(`gitDir is not an absolute path: ${JSON.stringify(raw.gitDir)}`);
  }
  const objectFormat = raw.objectFormat;
  if (!isObjectFormat(objectFormat)) return malformed(`unknown object format ${JSON.stringify(objectFormat)}`);
  if (typeof raw.base !== "string" || !oidMatchesFormat(raw.base, objectFormat)) {
    return malformed("base is not a full lowercase hex object id for the declared format");
  }
  if (typeof raw.ref !== "string" || raw.ref !== checkpointRefForWindow(raw.windowId)) {
    return malformed(`ref ${JSON.stringify(raw.ref)} does not match window id ${raw.windowId}`);
  }
  if (typeof raw.digest !== "string" || !SHA256_HEX_RE.test(raw.digest)) {
    return malformed("digest is not a sha256 hex digest");
  }
  return {
    format: GIT_CHECKPOINT_DESCRIPTOR_FORMAT,
    windowId: raw.windowId,
    armId: raw.armId,
    gitDir: raw.gitDir,
    base: raw.base,
    ref: raw.ref,
    objectFormat,
    digest: raw.digest,
  };
}

/**
 * Strictly decode and validate a persisted checkpoint descriptor. Any
 * structural or encoding violation rejects with reason "malformed_descriptor"
 * — a corrupted sidecar is never partially trusted.
 */
export function decodeGitCheckpointDescriptor(json: string): GitCheckpointDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new GitCheckpointError("malformed checkpoint descriptor: not valid JSON", "malformed_descriptor");
  }
  return assertValidDescriptor(value);
}

export function encodeGitCheckpointRecord(record: GitCheckpointRecord): string {
  return JSON.stringify(record);
}

/**
 * Strictly decode and validate a durable checkpoint record. Any structural,
 * encoding, or consistency violation rejects with reason "malformed_record"
 * — a corrupted pin is never partially trusted.
 */
export function decodeGitCheckpointRecord(json: string): GitCheckpointRecord {
  const malformed = (why: string): never => {
    throw new GitCheckpointError(`malformed checkpoint record: ${why}`, "malformed_record");
  };
  // Unpaired UTF-16 surrogates have no UTF-8 encoding; fs would silently
  // substitute EF BF BD bytes, so such strings are not representable.
  const utf8RoundTrips = (value: string): boolean => Buffer.from(value, "utf8").toString("utf8") === value;

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return malformed("not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("not an object");
  const raw = value as Record<string, unknown>;

  if (raw.format !== GIT_CHECKPOINT_RECORD_FORMAT) return malformed(`unknown format tag ${JSON.stringify(raw.format)}`);
  if (typeof raw.armId !== "string" || !isSafeArmId(raw.armId)) {
    return malformed(`armId is not a valid arm generation nonce: ${JSON.stringify(raw.armId)}`);
  }
  if (typeof raw.base !== "string" || !(OID_RE_40.test(raw.base) || OID_RE_64.test(raw.base))) {
    return malformed("base is not a full lowercase hex object id");
  }
  const objectFormat = raw.objectFormat;
  if (!isObjectFormat(objectFormat)) return malformed(`unknown object format ${JSON.stringify(objectFormat)}`);
  if (!oidMatchesFormat(raw.base, objectFormat)) return malformed("base length does not match the declared object format");
  if (typeof raw.ref !== "string" || !raw.ref.startsWith(GIT_CHECKPOINT_REF_PREFIX)) {
    return malformed(`ref is outside the owned namespace ${GIT_CHECKPOINT_REF_PREFIX}`);
  }
  if (windowIdFromRef(raw.ref) === undefined) return malformed("ref is not a well-formed checkpoint pin ref");

  const stagedPatchB64 = decodeStrictBase64(raw.stagedPatchB64, "stagedPatchB64", malformed);
  const unstagedPatchB64 = decodeStrictBase64(raw.unstagedPatchB64, "unstagedPatchB64", malformed);

  if (!Array.isArray(raw.untracked)) return malformed("untracked is not an array");
  const untracked: GitCheckpointUntrackedEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.untracked) {
    if (typeof item !== "object" || item === null) return malformed("untracked entry is not an object");
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== "string" || !isSafeRelativePath(entry.path)) {
      return malformed(`unsafe untracked path ${JSON.stringify(entry.path)}`);
    }
    if (!utf8RoundTrips(entry.path)) {
      return malformed(`untracked path ${JSON.stringify(entry.path)} is not valid Unicode`);
    }
    if (seen.has(entry.path)) return malformed(`duplicate untracked path ${entry.path}`);
    seen.add(entry.path);
    const mode = entry.mode;
    if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777777) {
      return malformed(`invalid untracked mode for ${entry.path}`);
    }
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const) {
      const v = entry[field];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return malformed(`invalid ${field} for ${entry.path}`);
    }
    const base: GitCheckpointUntrackedEntry = {
      path: entry.path,
      kind: "file",
      mode,
      dev: entry.dev as number,
      ino: entry.ino as number,
      size: entry.size as number,
      mtimeMs: entry.mtimeMs as number,
      ctimeMs: entry.ctimeMs as number,
    };
    if (entry.kind === "file") {
      const contentB64 = decodeStrictBase64(entry.contentB64, `contentB64 for ${entry.path}`, malformed);
      base.kind = "file";
      base.contentB64 = contentB64;
      if (Buffer.byteLength(contentB64, "base64") !== entry.size) {
        return malformed(`content size mismatch for ${entry.path}`);
      }
    } else if (entry.kind === "symlink") {
      if (typeof entry.target !== "string" || entry.target.length === 0) {
        return malformed(`missing symlink target for ${entry.path}`);
      }
      // U+FFFD marks a lossy UTF-8 decode of raw target bytes; such a target
      // cannot be recreated exactly, so the record is malformed.
      if (entry.target.includes("\uFFFD")) {
        return malformed(`symlink target for ${entry.path} is not valid UTF-8`);
      }
      if (!utf8RoundTrips(entry.target)) {
        return malformed(`symlink target for ${entry.path} is not valid Unicode`);
      }
      base.kind = "symlink";
      base.target = entry.target;
    } else {
      return malformed(`unknown untracked kind for ${entry.path}`);
    }
    untracked.push(base);
  }

  return {
    format: GIT_CHECKPOINT_RECORD_FORMAT,
    armId: raw.armId as string,
    base: raw.base,
    ref: raw.ref,
    objectFormat,
    stagedPatchB64,
    unstagedPatchB64,
    untracked,
  };
}

function decodeStrictBase64(
  value: unknown,
  label: string,
  malformed: (why: string) => never,
): string {
  if (typeof value !== "string" || !isStrictBase64(value)) return malformed(`${label} is not valid base64`);
  return value;
}

/**
 * Strict plus canonical: the unused low bits of the final data character
 * must be zero, so the encoding is exactly what `Buffer.toString("base64")`
 * would emit for its decoded bytes. Linear-time like isStrictBase64.
 */
export function isCanonicalBase64(value: string): boolean {
  if (!isStrictBase64(value)) return false;
  const len = value.length;
  if (len === 0) return true;
  if (value.charCodeAt(len - 1) !== 61 /* "=" */) return true; // no padding: fully canonical
  if (value.charCodeAt(len - 2) === 61 /* "=" */) {
    // "XX==": the low 4 bits of the last data character must be zero.
    const index = BASE64_INDEX[value.charCodeAt(len - 3)];
    return index >= 0 && (index & 0x0f) === 0;
  }
  // "XXX=": the low 2 bits of the last data character must be zero.
  const index = BASE64_INDEX[value.charCodeAt(len - 2)];
  return index >= 0 && (index & 0x03) === 0;
}
