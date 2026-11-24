/**
 * #682: Darwin-only Claude Code version evidence.
 *
 * The native launcher uses it, through
 * {@linkcode probeDarwinClaudeInboxCompatibility}, only for an explicitly
 * requested Claude inbox compatibility check on an otherwise eligible macOS
 * launch (default direct target, prepared hooks, and the managed MCP relay when
 * the request is lane-scoped); every other launch never reaches it. It adds no
 * environment marker and changes no launch argv or environment. The Linux
 * Claude probe (./native-claude-version-probe) and its
 * shared `/usr/bin/python3` execve trampoline are untouched and are not used
 * here: this module never runs Python, a shell, a PATH search, an installer, a
 * compiler, or a dependency, and it never adds an environment marker.
 *
 * What it does, and nothing else, for ONE already-resolved, trusted, direct
 * native Claude executable (never a shim, wrapper, or link):
 *
 * 1. Refuse anything uncertain before spawning: a non-Darwin host; a runtime
 *    whose spawn path is not known to avoid the ENOEXEC `/bin/sh` retry (see
 *    {@linkcode assessDarwinDirectSpawnPrecondition}); a relative,
 *    non-normalized, or over-long path; any ancestor that is a symlink, not a
 *    directory, owned by someone other than root or the current effective
 *    user, writable by group/other (unless root-owned and sticky), or whose
 *    macOS extended ACL grants more than read/traverse to others (each verdict
 *    bound to identical before/after observations, change time included); a
 *    target that
 *    is not a regular file, is owned by anyone else, is group/other writable,
 *    is setuid/setgid, is not executable by its owning class, or whose
 *    no-follow descriptor identity differs from its path identity or from the
 *    identity the caller resolved; and any target whose header is not
 *    conservatively recognized as a 64-bit Mach-O executable (thin, or a fat
 *    container whose recognized slices are themselves validated Mach-O
 *    executables). Scripts, Java class files sharing the fat magic, and other
 *    lookalikes are refused.
 * 2. Run it exactly once as `<file> --version` by direct absolute spawn with
 *    `shell: false`, stdin ignored, its own new session/process group
 *    (`detached`), a hard wall-clock bound, and a hard combined stdout+stderr
 *    byte cap (the Linux probe's bounds).
 * 3. Tear down the owned process group: on a bound crossing or an error the
 *    whole group is SIGKILLed, but ONLY while the leader is still unreaped, so
 *    its zombie pins the group id. Once the leader has been reaped nothing is
 *    ever signalled: the group id could be recycled at any instant, so the
 *    group is only observed (signal 0) until it is empty. Settlement waits,
 *    bounded, for the leader to be reaped and the group to be observed empty;
 *    when that cannot be confirmed (including a member that outlives a clean
 *    leader exit) the outcome is `cleanup-unconfirmed`, never evidence.
 * 4. Re-observe every ancestor (identity, mode, owner, and change time) and the
 *    target (also size and modification time) within the final bound after the
 *    run; any change is `target-changed`, a late observation is `timeout`.
 * 5. Parse only stdout and only the exact official form
 *    `<major>.<minor>.<patch> (Claude Code)` (the Linux grammar), and yield
 *    evidence only for a stable version at or above `CLAUDE_INBOX_MIN_CLI_VERSION`.
 *
 * Elapsed time: the checks, ACL listings, and run share one monotonic deadline
 * of {@linkcode DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS}; forced-termination
 * reap confirmation (of the version child's group or an ACL listing child) and
 * the post-run re-observation must finish by that deadline plus
 * {@linkcode DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS}, an absolute bound that a
 * late settlement never extends. The waits are bounded subject to event-loop
 * progress and the native `spawn()` call itself returning; nothing in this
 * module performs a synchronous lookup (the ACL parser's account-name lookup is
 * disabled, see {@linkcode createDarwinAclProof}).
 *
 * Change-time binding refuses conservatively: unrelated entry churn in an
 * ancestor (for example a file created in the home directory during the probe)
 * changes that directory's ctime and yields `target-changed`.
 *
 * Neither stream's contents, a path, an errno, or a mode ever appears in an
 * outcome: it is one validated version string or one fixed refusal code. The
 * probe never throws.
 *
 * Residual facts this module's portable tests do NOT prove (stated, not
 * claimed; real macOS callback acceptance remains required):
 * - every supported signed macOS Claude binary passes these checks and
 *   answers `--version` in the exact grammar within the bounds, on both arm64
 *   and x86_64 hosts, without starting group members that outlive it;
 * - the target Node runtime's libuv really enters the Apple `posix_spawn`
 *   path for this spawn (no fork/`execvp` fallback that could retry ENOEXEC
 *   through `/bin/sh`), which {@linkcode assessDarwinDirectSpawnPrecondition}
 *   only approximates from version facts;
 * - code-signature validity is not checked (no `codesign`/Security call), and
 *   check-to-exec races are detected only when the replacement is still in
 *   place after the run (Darwin has no `fexecve`).
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { release } from "node:os";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";

import { isClaudeInboxSupportedCliVersion } from "./native-claude-inbox-delivery";
import {
  CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  declineClaudeInboxCompatibility,
  type NativeClaudeInboxCompatibilityOutcome,
} from "./native-claude-version-probe";
import { parseStableCliVersion } from "./native-cli-version-floor";
import { NATIVE_HOOK_BOOTSTRAP_ENV } from "./native-hook-protocol";
import { proveExtendedAcl, type ExtendedAclVerdict } from "./network/peer-state-permissions";

/** Whole-probe wall-clock bound (checks + run), identical to the Linux probe. */
export const DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS = CLAUDE_VERSION_PROBE_TIMEOUT_MS;

/** Combined stdout+stderr byte cap, identical to the Linux probe. */
export const DARWIN_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES = CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES;

/**
 * Additional bound, after the run settles, for confirming the owned process
 * group is gone and re-observing the target.
 */
export const DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS = 1_000;

/** Fixed system listing tool for macOS extended ACLs; never searched on PATH. */
export const DARWIN_ACL_LISTING_TOOL = "/bin/ls";

/** Byte cap for one ACL listing (the peer-state parser's own cap). */
const ACL_LISTING_MAX_BYTES = 64 * 1024;

/**
 * Oldest libuv release taken to spawn an absolute file on Apple platforms with
 * `posix_spawn` (never `posix_spawnp`, never fork + `execvp`): libuv 1.44.0
 * relanded "macos: use posix_spawn instead of fork" and 1.44.2 fixed its cwd
 * handling. On that path ENOEXEC is returned, never retried through `/bin/sh`;
 * only the fork fallback's `execvp` could do that. libuv falls back to fork for
 * setuid/setgid (never requested here), for a detached child when the kernel
 * major is below 19, and for a cwd when `posix_spawn_file_actions_addchdir(_np)`
 * cannot be resolved by `dlsym` — the last is not observable from JavaScript.
 * UNPROVEN for the target runtime: activation requires confirming this against
 * the libuv source bundled by the exact target Node build.
 */
export const DARWIN_MIN_POSIX_SPAWN_LIBUV: readonly [number, number, number] = Object.freeze([1, 44, 2]) as readonly [number, number, number];

/**
 * Oldest Darwin kernel major (macOS 10.15) providing `POSIX_SPAWN_SETSID` and
 * `posix_spawn_file_actions_addchdir_np`, without which libuv's Apple spawn
 * path falls back to fork for a detached child with a working directory.
 */
export const DARWIN_MIN_KERNEL_MAJOR = 19;

/** The single argument the probe ever passes. */
const VERSION_ARGS: readonly string[] = Object.freeze(["--version"]);

/** Exact official Claude Code `--version` stdout; same grammar as the Linux probe. */
const CLAUDE_VERSION_STDOUT = /^(\d{1,6}\.\d{1,6}\.\d{1,6}) \(Claude Code\)\r?\n?$/u;

/** Darwin `PATH_MAX` and `NAME_MAX`. */
const MAX_PATH_BYTES = 1024;
const MAX_COMPONENT_BYTES = 255;

const MACH_HEADER_64_BYTES = 32;
const MAX_FAT_ARCHS = 8;
/** Prefix read from offset 0: the largest accepted fat table, not a size minimum. */
const HEADER_BYTES = 8 + MAX_FAT_ARCHS * 32;
const MAX_FAT_ALIGN = 15;
const MAX_LOAD_COMMANDS = 65_536;

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_EXECUTE = 2;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const RECOGNIZED_CPU_TYPES: ReadonlySet<number> = new Set([CPU_TYPE_ARM64, CPU_TYPE_X86_64]);

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const GROUP_OTHER_WRITE = 0o022;
const SET_ID_BITS = 0o6000;
const STICKY = 0o1000;

const CLEANUP_POLL_MS = 20;

/** Closed refusal vocabulary. Never carries a path, errno, mode, or output. */
export type DarwinClaudeVersionRefusal =
  /** The host is not Darwin. */
  | "unsupported-platform"
  /** The runtime's direct-spawn path is not known to avoid an ENOEXEC shell retry. */
  | "runtime-precondition-unproven"
  /** Malformed request: path, identity, cwd, or environment shape. */
  | "invalid-request"
  /** An ancestor directory is missing, linked, untrusted, or replaceable. */
  | "untrusted-path"
  /** The target is not a trusted, non-writable, executable regular file. */
  | "untrusted-target"
  /** The target's identity differs from the caller's or between observations. */
  | "target-identity-mismatch"
  /** The target is not a recognized native Mach-O executable. */
  | "non-native-executable"
  /** An ancestor or the target changed across the probe. */
  | "target-changed"
  /** The executable could not be started. */
  | "spawn-failed"
  /** The whole-probe wall-clock bound was crossed. */
  | "timeout"
  /** Combined output exceeded the byte cap. */
  | "oversized"
  /** Nonzero exit or a signal. */
  | "abnormal-exit"
  /** An output stream failed, so captured output is incomplete. */
  | "output-failed"
  /** The owned process group could not be confirmed gone within its bound. */
  | "cleanup-unconfirmed"
  /** Clean exit, but stdout is not the exact official form. */
  | "version-unrecognized"
  /** Exact form, but not a version the inbox sender supports. */
  | "version-unsupported";

/** Only `version` is evidence; its value is one exact supported version. */
export type DarwinClaudeVersionOutcome =
  | { readonly evidence: "version"; readonly version: string }
  | { readonly evidence: "refused"; readonly reason: DarwinClaudeVersionRefusal };

/** Device/inode identity the caller observed when it resolved the target. */
export interface DarwinExecutableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Normalized no-follow observation of one filesystem object. */
export interface DarwinFileFacts {
  readonly dev: bigint;
  readonly ino: bigint;
  /** Full `st_mode`, including the type bits. */
  readonly mode: number;
  readonly uid: number;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** One descriptor opened with `O_NOFOLLOW`. */
export interface DarwinFileHandle {
  stat(): Promise<DarwinFileFacts>;
  /**
   * Read up to `length` bytes at `position`; a short result means end of file.
   * `checkDeadline`, when given, runs (and may throw) before every underlying
   * read, including short-read retries, so abandoned work issues no more I/O.
   */
  read(position: number, length: number, checkDeadline?: () => void): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Filesystem seam. Production uses no-follow `lstat` and `open`. */
export interface DarwinProbeFileSystem {
  lstat(path: string): Promise<DarwinFileFacts>;
  openNoFollow(path: string): Promise<DarwinFileHandle>;
}

/** Minimal child surface the runner uses. */
export type DarwinProbeChild = Pick<ChildProcess, "pid" | "stdout" | "stderr" | "on" | "unref">;

/** Spawn seam: exact `(file, args, options)` of the one direct spawn. */
export type DarwinProbeSpawn = (file: string, args: readonly string[], options: SpawnOptions) => DarwinProbeChild;

/**
 * ACL proof outcome: a parser verdict, or `cleanup-unconfirmed` when a forced
 * listing child could not be confirmed reaped within its cleanup window.
 */
export type DarwinAclResult = ExtendedAclVerdict | "cleanup-unconfirmed";

/**
 * ACL proof whose listing runs until `deadline` (monotonic ms); forced cleanup
 * after that has its own separate, bounded window.
 */
export type DarwinAclProof = (path: string, deadline: number) => Promise<DarwinAclResult>;

/** Runtime facts the spawn precondition is assessed from. */
export interface DarwinRuntimeFacts {
  readonly platform: NodeJS.Platform;
  /** `process.versions.uv`. */
  readonly uvVersion: string | undefined;
  /** `os.release()`: the Darwin kernel release on macOS. */
  readonly osRelease: string;
}

/** Test seams. Production omits every field. Bounds may only be tightened. */
export interface DarwinClaudeVersionProbeDeps {
  readonly runtime?: DarwinRuntimeFacts;
  readonly effectiveUid?: () => number;
  readonly fs?: DarwinProbeFileSystem;
  /**
   * Extended-ACL proof for one object, settling by the absolute monotonic
   * `deadline`; defaults to {@linkcode createDarwinAclProof}.
   */
  readonly acl?: DarwinAclProof;
  readonly spawn?: DarwinProbeSpawn;
  /** `process.kill`; a negative pid addresses a process group. */
  readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cleanupMs?: number;
  readonly maxOutputBytes?: number;
}

export interface DarwinClaudeVersionProbeRequest {
  /** Absolute, normalized, already-resolved path of the direct native executable. */
  readonly file: string;
  /** Identity observed when the caller resolved `file`. */
  readonly identity: DarwinExecutableIdentity;
  /** Absolute working directory for the probe child. */
  readonly cwd: string;
  /** Probe environment; must carry no per-launch hook bootstrap marker. */
  readonly env: NodeJS.ProcessEnv;
  readonly deps?: DarwinClaudeVersionProbeDeps;
}

function refused(reason: DarwinClaudeVersionRefusal): DarwinClaudeVersionOutcome {
  return Object.freeze({ evidence: "refused", reason });
}

class Refusal {
  constructor(readonly reason: DarwinClaudeVersionRefusal) {}
}

function refuse(reason: DarwinClaudeVersionRefusal): never {
  throw new Refusal(reason);
}

// ---------------------------------------------------------------------------
// Runtime precondition

function parseTriple(value: string | undefined): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/u.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const a = actual[index] ?? 0;
    const m = minimum[index] ?? 0;
    if (a !== m) return a > m;
  }
  return true;
}

/**
 * Fail-closed precondition for a direct spawn: Darwin, a libuv release taken to
 * use the Apple `posix_spawn` path, and a kernel providing the setsid/chdir
 * spawn features that path needs for this detached child. `posix_spawn` has no
 * ENOEXEC `/bin/sh` retry; the fork + `execvp` fallback could. Anything this
 * cannot parse is `unproven`. Version facts only approximate the real code
 * path: confirming it on the target runtime remains an activation requirement.
 */
export function assessDarwinDirectSpawnPrecondition(facts: DarwinRuntimeFacts): "satisfied" | "unproven" {
  if (facts === null || typeof facts !== "object" || facts.platform !== "darwin") return "unproven";
  const uv = parseTriple(facts.uvVersion);
  if (uv === null || !atLeast(uv, DARWIN_MIN_POSIX_SPAWN_LIBUV)) return "unproven";
  const kernel = parseTriple(typeof facts.osRelease === "string" ? facts.osRelease : undefined);
  if (kernel === null || kernel[0] < DARWIN_MIN_KERNEL_MAJOR) return "unproven";
  return "satisfied";
}

// ---------------------------------------------------------------------------
// Request validation

/** `/a/b/c` → `["/", "/a", "/a/b"]`, or `null` when not absolute and normalized. */
function ancestorsOf(file: unknown): string[] | null {
  if (typeof file !== "string" || file.length < 2 || file.includes("\0")) return null;
  if (Buffer.byteLength(file) >= MAX_PATH_BYTES) return null;
  if (!file.startsWith("/") || file.endsWith("/") || posix.normalize(file) !== file) return null;
  const parts = file.slice(1).split("/");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === ".." || Buffer.byteLength(part) > MAX_COMPONENT_BYTES) return null;
  }
  const ancestors = ["/"];
  for (let index = 1; index < parts.length; index += 1) ancestors.push(`/${parts.slice(0, index).join("/")}`);
  return ancestors;
}

function validCwd(cwd: unknown): cwd is string {
  return typeof cwd === "string" && cwd.startsWith("/") && !cwd.includes("\0") && Buffer.byteLength(cwd) < MAX_PATH_BYTES;
}

function validIdentity(identity: unknown): identity is DarwinExecutableIdentity {
  if (identity === null || typeof identity !== "object") return false;
  const { dev, ino } = identity as DarwinExecutableIdentity;
  return typeof dev === "bigint" && typeof ino === "bigint" && dev >= 0n && ino > 0n;
}

/** A plain copy of string entries, or `null` for any malformed or marked entry. */
function copyEnvironment(env: unknown): Record<string, string> | null {
  if (env === null || typeof env !== "object" || Array.isArray(env)) return null;
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (typeof value !== "string" || key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) return null;
    if (key === NATIVE_HOOK_BOOTSTRAP_ENV) return null;
    copy[key] = value;
  }
  return copy;
}

function boundedOverride(value: number | undefined, ceiling: number): number | null {
  if (value === undefined) return ceiling;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > ceiling) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Native executable recognition

function u32le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function u64be(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, false);
}

/**
 * Validate one `mach_header_64` occupying `sliceSize` bytes: little-endian
 * 64-bit magic, a recognized CPU type (optionally the one a fat entry named),
 * `MH_EXECUTE`, and load commands that fit inside the slice. Load commands are
 * not interpreted further.
 */
function isMachExecuteHeader(bytes: Uint8Array, sliceSize: bigint, expectedCpu?: number): boolean {
  if (bytes.byteLength < MACH_HEADER_64_BYTES) return false;
  if (u32le(bytes, 0) !== MH_MAGIC_64) return false;
  const cputype = u32le(bytes, 4);
  if (!RECOGNIZED_CPU_TYPES.has(cputype)) return false;
  if (expectedCpu !== undefined && cputype !== expectedCpu) return false;
  if (u32le(bytes, 12) !== MH_EXECUTE) return false;
  const ncmds = u32le(bytes, 16);
  const sizeofcmds = u32le(bytes, 20);
  if (ncmds === 0 || ncmds > MAX_LOAD_COMMANDS || sizeofcmds < ncmds * 8) return false;
  return BigInt(MACH_HEADER_64_BYTES + sizeofcmds) <= sliceSize;
}

/** Reader seam: bytes at `position`, short only at end of file. */
export type DarwinHeaderReader = (position: number, length: number) => Promise<Uint8Array>;

/**
 * Conservatively recognize a native 64-bit Mach-O executable.
 *
 * - Thin: the header itself must be a valid `MH_EXECUTE` header.
 * - Fat (`0xcafebabe` / `0xcafebabf`, big-endian): 1–8 architecture entries.
 *   Java class files share `0xcafebabe`, but their following word is the class
 *   version (major ≥ 45), so they fail the entry bound. Every entry must lie
 *   inside the file after the entry table, be aligned to its declared power of
 *   two (≤ 2^15), and not overlap another; at least one entry must name arm64
 *   or x86_64, and each such entry's slice must itself begin with a validated
 *   `MH_EXECUTE` header of that CPU type. Other entries are bounds-checked only.
 * - Anything else — `#!` scripts, text, 32-bit or big-endian Mach-O, dylibs,
 *   bundles, object files, archives — is `null`.
 */
export async function classifyDarwinNativeExecutable(
  read: DarwinHeaderReader,
  size: bigint,
): Promise<"mach-o" | "fat-mach-o" | null> {
  if (typeof size !== "bigint" || size < BigInt(MACH_HEADER_64_BYTES)) return null;
  // Read only what the formats need, capped by the file: a compact executable
  // need not fill a page, while header and load commands must still fit in it.
  const headLength = size < BigInt(HEADER_BYTES) ? Number(size) : HEADER_BYTES;
  const head = await read(0, headLength);
  if (!(head instanceof Uint8Array) || head.byteLength !== headLength) return null;
  if (isMachExecuteHeader(head, size)) return "mach-o";
  const magic = u32be(head, 0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return null;
  const wide = magic === FAT_MAGIC_64;
  const count = u32be(head, 4);
  if (count < 1 || count > MAX_FAT_ARCHS) return null;
  const entryBytes = wide ? 32 : 20;
  const tableEnd = 8 + count * entryBytes;
  if (tableEnd > head.byteLength) return null;
  const slices: Array<{ cputype: number; offset: bigint; size: bigint }> = [];
  for (let index = 0; index < count; index += 1) {
    const at = 8 + index * entryBytes;
    const cputype = u32be(head, at);
    const offset = wide ? u64be(head, at + 8) : BigInt(u32be(head, at + 8));
    const sliceSize = wide ? u64be(head, at + 16) : BigInt(u32be(head, at + 12));
    const align = u32be(head, at + (wide ? 24 : 16));
    if (align > MAX_FAT_ALIGN) return null;
    if (offset < BigInt(tableEnd) || sliceSize === 0n || offset + sliceSize > size) return null;
    if (offset % (1n << BigInt(align)) !== 0n) return null;
    slices.push({ cputype, offset, size: sliceSize });
  }
  const ordered = [...slices].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    if (previous.offset + previous.size > ordered[index]!.offset) return null;
  }
  const recognized = slices.filter((slice) => RECOGNIZED_CPU_TYPES.has(slice.cputype));
  if (recognized.length === 0) return null;
  for (const slice of recognized) {
    if (slice.offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const sliceHead = await read(Number(slice.offset), MACH_HEADER_64_BYTES);
    if (!(sliceHead instanceof Uint8Array) || !isMachExecuteHeader(sliceHead, slice.size, slice.cputype)) return null;
  }
  return "fat-mach-o";
}

// ---------------------------------------------------------------------------
// Filesystem trust

const kindOf = (mode: number): number => mode & S_IFMT;

function sameObject(a: DarwinFileFacts, b: DarwinFileFacts): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
}

/**
 * Same object with the same trust-relevant state. A mode, owner, or ACL change
 * updates `st_ctime`, so an ACL verdict taken between two observations that
 * agree here describes both of them.
 */
function sameTrust(a: DarwinFileFacts, b: DarwinFileFacts): boolean {
  return sameObject(a, b) && a.ctimeNs === b.ctimeNs;
}

function sameContent(a: DarwinFileFacts, b: DarwinFileFacts): boolean {
  return sameTrust(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function trustedAncestor(facts: DarwinFileFacts, owners: ReadonlySet<number>): boolean {
  if (kindOf(facts.mode) !== S_IFDIR || !owners.has(facts.uid)) return false;
  if ((facts.mode & GROUP_OTHER_WRITE) === 0) return true;
  // A root-owned sticky directory (`/private/tmp`) lets others add entries but
  // not rename or remove the trusted entry beneath it.
  return facts.uid === 0 && (facts.mode & STICKY) !== 0;
}

function trustedTarget(facts: DarwinFileFacts, owners: ReadonlySet<number>, euid: number): boolean {
  if (kindOf(facts.mode) !== S_IFREG || !owners.has(facts.uid)) return false;
  if ((facts.mode & (GROUP_OTHER_WRITE | SET_ID_BITS)) !== 0) return false;
  const executeBit = facts.uid === euid ? 0o100 : 0o001;
  return (facts.mode & executeBit) !== 0;
}

/** Everything the post-run re-observation compares against. */
interface TrustSnapshot {
  readonly ancestors: ReadonlyArray<{ readonly path: string; readonly facts: DarwinFileFacts }>;
  readonly target: DarwinFileFacts;
}

/**
 * Observe every ancestor and the target, in order. `checkDeadline` runs before
 * each `lstat`, so once the phase is past its deadline (or abandoned) no further
 * stat is ever issued; its refusal propagates. Any other failure is `null`.
 */
async function observeChain(
  fs: DarwinProbeFileSystem,
  ancestors: readonly string[],
  file: string,
  checkDeadline: () => void,
): Promise<TrustSnapshot | null> {
  try {
    const observed: Array<{ path: string; facts: DarwinFileFacts }> = [];
    for (const path of ancestors) {
      checkDeadline();
      observed.push({ path, facts: await fs.lstat(path) });
    }
    checkDeadline();
    return { ancestors: observed, target: await fs.lstat(file) };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return null;
  }
}

function unchanged(before: TrustSnapshot, after: TrustSnapshot | null): boolean {
  if (after === null || after.ancestors.length !== before.ancestors.length) return false;
  for (let index = 0; index < before.ancestors.length; index += 1) {
    if (!sameTrust(before.ancestors[index]!.facts, after.ancestors[index]!.facts)) return false;
  }
  return sameContent(before.target, after.target);
}

// ---------------------------------------------------------------------------
// Production seams

function factsOf(stats: import("node:fs").BigIntStats): DarwinFileFacts {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

const productionFileSystem: DarwinProbeFileSystem = {
  lstat: async (path) => factsOf(await lstat(path, { bigint: true })),
  openNoFollow: async (path) => {
    // O_NONBLOCK: a FIFO swapped in after the lstat can never block the open.
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
    return {
      stat: async () => factsOf(await handle.stat({ bigint: true })),
      read: async (position, length, checkDeadline) => {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          checkDeadline?.();
          const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      },
      close: () => handle.close(),
    };
  },
};

const productionSpawn: DarwinProbeSpawn = (file, args, options) => spawn(file, [...args], options);

/**
 * Build the asynchronous, deadline-bounded ACL proof. It runs the fixed
 * {@linkcode DARWIN_ACL_LISTING_TOOL} as `ls -lde <path>` directly (no shell,
 * stdin ignored, stderr discarded, a fixed `C` locale and nothing else from the
 * host environment) and caps its stdout.
 *
 * When the deadline, the cap, or an error forces termination, its pipes are
 * closed and it is SIGKILLed — only before its exit is observed, so its pid
 * cannot have been recycled — and its reap is awaited within `cleanupMs`. A
 * reaped child yields `unprovable`; one not reaped within that window yields
 * `cleanup-unconfirmed` and is unref'd so it cannot hold the host.
 *
 * A completed listing is classified by the existing peer-state ACL parser
 * ({@linkcode proveExtendedAcl}), so an incomplete, failed, or not fully
 * understood listing is `unprovable`. The parser's account-name lookup
 * (synchronous `os.userInfo()`, which can block on directory services) is
 * disabled: rights are accepted for `owner@` and, as read-only grants, for any
 * other principal, and ownership is never inferred from a named account.
 * Never rejects.
 */
export function createDarwinAclProof(
  spawnChild: DarwinProbeSpawn = productionSpawn,
  now: () => number = () => performance.now(),
  cleanupMs: number = DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS,
): DarwinAclProof {
  return (path, deadline) => new Promise<DarwinAclResult>((resolve) => {
    if (now() >= deadline) { resolve("unprovable"); return; }
    let settled = false;
    let exited = false;
    let stopping = false;
    let stopBy = 0;
    let timer: NodeJS.Timeout | undefined;
    let child: DarwinProbeChild & { kill?: (signal?: NodeJS.Signals) => boolean };
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (verdict: DarwinAclResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (verdict === "cleanup-unconfirmed") {
        try { child.unref(); } catch { /* nothing further to release */ }
      }
      resolve(verdict);
    };
    const stop = (): void => {
      if (settled || stopping) return;
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      if (exited || child.pid === undefined) { finish("unprovable"); return; }
      stopBy = Math.min(now(), deadline) + cleanupMs;
      child.stdout?.destroy();
      child.stderr?.destroy();
      try { child.kill?.("SIGKILL"); } catch { /* the reap or the window decides */ }
      if (!settled) timer = setTimeout(() => finish("cleanup-unconfirmed"), Math.max(0, stopBy - now()));
    };
    const reaped = (): void => {
      exited = true;
      if (stopping) finish(now() < stopBy ? "unprovable" : "cleanup-unconfirmed");
    };
    try {
      child = spawnChild(DARWIN_ACL_LISTING_TOOL, ["-lde", path], {
        env: { LC_ALL: "C", LANG: "C" },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve("unprovable");
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || stopping) return;
      total += chunk.length;
      if (total > ACL_LISTING_MAX_BYTES) { stop(); return; }
      chunks.push(chunk);
    });
    child.stdout?.on("error", stop);
    child.on("error", stop);
    child.on("exit", reaped);
    child.on("close", (status: number | null) => {
      if (settled) return;
      if (stopping) { reaped(); return; }
      exited = true;
      if (now() >= deadline) { finish("unprovable"); return; }
      const listing = { status, stdout: Buffer.concat(chunks).toString("utf8") };
      let verdict: ExtendedAclVerdict;
      try {
        verdict = proveExtendedAcl(path, "parent", "darwin", {
          resolveTool: () => DARWIN_ACL_LISTING_TOOL,
          execute: () => listing,
          accountName: () => "",
        });
      } catch {
        verdict = "unprovable";
      }
      finish(verdict);
    });
    timer = setTimeout(stop, Math.max(0, deadline - now()));
  });
}

/**
 * Await `work` until the absolute monotonic `at`; past it, refuse with
 * `timeout` and run `onAbandon` so abandoned work starts nothing further.
 */
async function withinDeadline<T>(work: Promise<T>, at: number, now: () => number, onAbandon?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onAbandon?.();
      reject(new Refusal("timeout"));
    }, Math.max(0, at - now()));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    work.catch(() => { /* a late refusal after the deadline is already decided */ });
  }
}

function productionEffectiveUid(): number {
  if (typeof process.geteuid !== "function") return -1;
  return process.geteuid();
}

// ---------------------------------------------------------------------------
// Bounded run with owned process-group teardown

type RunKind = "completed" | "spawn-failed" | "timeout" | "oversized" | "abnormal-exit" | "output-failed";

interface RunResult {
  readonly kind: RunKind;
  readonly stdout: string;
  readonly cleanup: "confirmed" | "unconfirmed";
}

interface RunBounds {
  readonly deadline: number;
  readonly cleanupMs: number;
  readonly maxOutputBytes: number;
}

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * Spawn `file --version` directly and settle only after the owned group's fate
 * is known (or its bounded confirmation window has passed). Never rejects.
 */
function runVersionChild(
  file: string,
  options: SpawnOptions,
  bounds: RunBounds,
  spawnChild: DarwinProbeSpawn,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
  now: () => number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: DarwinProbeChild;
    try {
      child = spawnChild(file, VERSION_ARGS, options);
    } catch {
      // Synchronous validation failure: no process was created.
      resolve({ kind: "spawn-failed", stdout: "", cleanup: "confirmed" });
      return;
    }
    const pid = typeof child.pid === "number" && Number.isInteger(child.pid) && child.pid > 1 ? child.pid : undefined;
    let outcome: RunKind | undefined;
    let leaderReaped = false;
    let resolved = false;
    let runTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let cleanupDeadline = 0;
    const stdout: Buffer[] = [];
    let total = 0;

    const done = (cleanup: "confirmed" | "unconfirmed"): void => {
      if (resolved) return;
      resolved = true;
      if (runTimer !== undefined) clearTimeout(runTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (cleanup === "unconfirmed") {
        try { child.unref(); } catch { /* nothing further to release */ }
      }
      resolve({ kind: outcome ?? "spawn-failed", stdout: outcome === "completed" ? Buffer.concat(stdout).toString("utf8") : "", cleanup });
    };

    /** `true` gone, `false` present, `null` unknown (for example EPERM). */
    const groupGone = (): boolean | null => {
      if (pid === undefined) return true;
      try {
        kill(-pid, 0);
        return false;
      } catch (error) {
        return errnoOf(error) === "ESRCH" ? true : null;
      }
    };

    const killGroup = (): void => {
      // Signal ONLY while the leader is unreaped: its (possibly zombie) process
      // pins the group id, which therefore cannot name anyone else's group.
      // Node emits `exit` synchronously with the reap, so no code of ours runs
      // between the reap and `leaderReaped` turning true. After the reap a
      // successful signal-0 check proves nothing durable — the last member may
      // exit and the id be recycled before a signal lands — so nothing is ever
      // sent then; the group is only observed until confirmation or the bound.
      if (pid === undefined || leaderReaped) return;
      try { kill(-pid, "SIGKILL"); } catch { /* confirmation below decides */ }
    };

    const confirm = (): void => {
      if (resolved) return;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      // Absolute bound: a reap or an empty group observed late is not confirmation.
      if (now() >= cleanupDeadline) { done("unconfirmed"); return; }
      const gone = (leaderReaped || pid === undefined) && groupGone() === true;
      // The observation itself may land late (the host can be descheduled
      // during it): an answer seen past the bound is not confirmation.
      if (now() >= cleanupDeadline) { done("unconfirmed"); return; }
      if (gone) {
        done("confirmed");
        return;
      }
      pollTimer = setTimeout(confirm, CLEANUP_POLL_MS);
    };

    const settle = (kind: RunKind): void => {
      if (outcome !== undefined) return;
      outcome = kind;
      if (runTimer !== undefined) clearTimeout(runTimer);
      // Cleanup ends at the run deadline plus the cleanup window, even when the
      // settlement itself is observed late.
      cleanupDeadline = Math.min(now(), bounds.deadline) + bounds.cleanupMs;
      if (!leaderReaped) killGroup();
      // Stop reading: nothing after settlement is evidence, and a member that
      // inherited a pipe cannot hold the run open.
      child.stdout?.destroy();
      child.stderr?.destroy();
      cleanupTimer = setTimeout(() => done("unconfirmed"), Math.max(0, cleanupDeadline - now()));
      confirm();
    };

    const account = (chunk: Buffer, keep: boolean): void => {
      if (outcome !== undefined) return;
      total += chunk.length;
      if (total > bounds.maxOutputBytes) {
        settle("oversized");
        return;
      }
      if (keep) stdout.push(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => account(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => account(chunk, false));
    child.stdout?.on("error", () => settle("output-failed"));
    child.stderr?.on("error", () => settle("output-failed"));
    child.on("error", () => settle(pid === undefined ? "spawn-failed" : "output-failed"));
    child.on("exit", () => {
      leaderReaped = true;
      if (outcome !== undefined) confirm();
    });
    child.on("close", (status: number | null, signal: NodeJS.Signals | null) => {
      leaderReaped = true;
      if (now() >= bounds.deadline) { settle("timeout"); return; }
      settle(status === 0 && signal === null ? "completed" : "abnormal-exit");
    });
    if (pid === undefined) {
      // No process exists; an `error` event normally follows. Bound the wait anyway.
      leaderReaped = true;
    }
    runTimer = setTimeout(() => settle("timeout"), Math.max(0, bounds.deadline - now()));
  });
}

// ---------------------------------------------------------------------------
// Probe

/**
 * Probe one already-resolved, trusted, direct native Claude executable on
 * Darwin and return exact version evidence or one fixed refusal. Never throws.
 */
export async function probeDarwinClaudeVersion(request: DarwinClaudeVersionProbeRequest): Promise<DarwinClaudeVersionOutcome> {
  try {
    return await probe(request);
  } catch (error) {
    return refused(error instanceof Refusal ? error.reason : "spawn-failed");
  }
}

async function probe(request: DarwinClaudeVersionProbeRequest): Promise<DarwinClaudeVersionOutcome> {
  if (request === null || typeof request !== "object") return refused("invalid-request");
  const deps = request.deps ?? {};
  const runtime = deps.runtime ?? { platform: process.platform, uvVersion: process.versions.uv, osRelease: release() };
  if (runtime.platform !== "darwin") return refused("unsupported-platform");
  if (assessDarwinDirectSpawnPrecondition(runtime) !== "satisfied") return refused("runtime-precondition-unproven");

  const timeoutMs = boundedOverride(deps.timeoutMs, DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS);
  const cleanupMs = boundedOverride(deps.cleanupMs, DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS);
  const maxOutputBytes = boundedOverride(deps.maxOutputBytes, DARWIN_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES);
  if (timeoutMs === null || cleanupMs === null || maxOutputBytes === null) return refused("invalid-request");

  const file = request.file;
  const ancestors = ancestorsOf(file);
  const env = copyEnvironment(request.env);
  if (ancestors === null || env === null || !validCwd(request.cwd) || !validIdentity(request.identity)) {
    return refused("invalid-request");
  }
  const identity = request.identity;
  const fs = deps.fs ?? productionFileSystem;
  const now = deps.now ?? (() => performance.now());
  const productionAcl = createDarwinAclProof(productionSpawn, now, cleanupMs);
  const euid = (deps.effectiveUid ?? productionEffectiveUid)();
  if (!Number.isInteger(euid) || euid < 0) return refused("untrusted-target");
  const owners: ReadonlySet<number> = new Set([0, euid]);
  const deadline = now() + timeoutMs;

  // Pre-spawn checks race the same whole-probe deadline: a hung filesystem
  // call can never hold the caller, and an abandoned check never spawns.
  let abandoned = false;
  const pastDeadline = (): void => {
    if (abandoned || now() >= deadline) refuse("timeout");
  };
  const checks = (async (): Promise<TrustSnapshot> => {
    const before = await observeChain(fs, ancestors, file, pastDeadline);
    pastDeadline();
    if (before === null) refuse("untrusted-path");
    for (const { facts } of before.ancestors) {
      if (!trustedAncestor(facts, owners)) refuse("untrusted-path");
    }
    if (!trustedTarget(before.target, owners, euid)) refuse("untrusted-target");
    if (before.target.dev !== identity.dev || before.target.ino !== identity.ino) refuse("target-identity-mismatch");

    let handle: DarwinFileHandle;
    try {
      handle = await fs.openNoFollow(file);
    } catch {
      refuse("untrusted-target");
    }
    try {
      pastDeadline();
      let opened: DarwinFileFacts;
      try { opened = await handle.stat(); } catch { refuse("untrusted-target"); }
      pastDeadline();
      if (!sameContent(opened, before.target)) refuse("target-identity-mismatch");
      let format: Awaited<ReturnType<typeof classifyDarwinNativeExecutable>>;
      try {
        format = await classifyDarwinNativeExecutable((position, length) => {
          pastDeadline();
          return handle.read(position, length, pastDeadline);
        }, opened.size);
      } catch (error) {
        // A deadline refusal stops the header reads; it is not a format verdict.
        if (error instanceof Refusal) throw error;
        format = null;
      }
      pastDeadline();
      if (format === null) refuse("non-native-executable");
    } finally {
      try { await handle.close(); } catch { /* descriptor already released */ }
    }

    return before;
  })();
  const before = await withinDeadline(checks, deadline, now, () => { abandoned = true; });

  // macOS extended ACLs can grant replacement independently of mode bits. Each
  // verdict is fenced by the observation before it and the identical (ctime
  // included) re-observation after it. The production proof owns its listing
  // deadline and its own forced-cleanup window, so the outer timer never hides
  // a `cleanup-unconfirmed`; an injected proof is raced against the deadline.
  const verifyAcl = async (path: string, refusal: "untrusted-path" | "untrusted-target"): Promise<void> => {
    pastDeadline();
    const verdict: DarwinAclResult = deps.acl === undefined
      ? await productionAcl(path, deadline)
      : await withinDeadline(deps.acl(path, deadline), deadline, now);
    if (verdict === "cleanup-unconfirmed") refuse("cleanup-unconfirmed");
    pastDeadline();
    if (verdict !== "no-acl" && verdict !== "owner-only") refuse(refusal);
  };
  for (const { path } of before.ancestors) await verifyAcl(path, "untrusted-path");
  await verifyAcl(file, "untrusted-target");

  // Re-observe immediately before the spawn.
  const rechecked = await withinDeadline(observeChain(fs, ancestors, file, pastDeadline), deadline, now, () => { abandoned = true; });
  pastDeadline();
  if (!unchanged(before, rechecked)) return refused("target-changed");

  const run = await runVersionChild(file, {
    cwd: request.cwd,
    env,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }, { deadline, cleanupMs, maxOutputBytes }, deps.spawn ?? productionSpawn, deps.kill ?? ((pid, signal) => { process.kill(pid, signal); }), now);

  if (run.cleanup !== "confirmed") return refused("cleanup-unconfirmed");
  if (run.kind !== "completed") return refused(run.kind);
  // The post-run re-observation shares the final bound; an observation that
  // hangs or lands after it is never evidence.
  const finalDeadline = deadline + cleanupMs;
  const pastFinalDeadline = (): void => {
    if (abandoned || now() >= finalDeadline) refuse("timeout");
  };
  const after = await withinDeadline(observeChain(fs, ancestors, file, pastFinalDeadline), finalDeadline, now, () => { abandoned = true; });
  pastFinalDeadline();
  if (!unchanged(before, after)) return refused("target-changed");
  const match = CLAUDE_VERSION_STDOUT.exec(run.stdout);
  if (match === null) return refused("version-unrecognized");
  const version = match[1]!;
  if (!isClaudeInboxSupportedCliVersion(version)) return refused("version-unsupported");
  pastFinalDeadline();
  return Object.freeze({ evidence: "version", version });
}

// ---------------------------------------------------------------------------
// Launcher adapter

/** The probe entry point; a seam so launcher tests never spawn anything. */
export type DarwinClaudeVersionProbe = (request: DarwinClaudeVersionProbeRequest) => Promise<DarwinClaudeVersionOutcome>;

/** No-follow identity of the resolved executable; a seam for tests only. */
export type DarwinExecutableIdentityReader = (file: string) => Promise<DarwinExecutableIdentity | undefined>;

async function productionExecutableIdentity(file: string): Promise<DarwinExecutableIdentity | undefined> {
  const stats = await lstat(file, { bigint: true });
  return stats.isFile() ? { dev: stats.dev, ino: stats.ino } : undefined;
}

/**
 * #682: launcher adapter. Takes the identity of the EXACT resolved executable
 * `file` (canonical, the one the descriptor spawns) by a no-follow lstat, runs
 * {@linkcode probeDarwinClaudeVersion} for that file and identity only, and maps
 * the result onto the shared compatibility outcome: only exact evidence of a
 * stable supported version is `verified`. `version-unrecognized` and
 * `version-unsupported` keep their meaning; every other refusal (untrusted path
 * or target, non-native or replaced executable, unproven runtime, spawn, bound,
 * or cleanup failure) is `version-unavailable`. There is no fallback to the
 * Linux runner, a shim, a PATH or global tool, or an environment value. The
 * identity lookup and the probe share one deadline (the probe's own bound): a
 * lookup that has not answered by then is `version-unavailable` and its late
 * answer starts nothing. Never throws.
 */
export async function probeDarwinClaudeInboxCompatibility(input: {
  readonly file: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly probe?: DarwinClaudeVersionProbe;
  readonly identity?: DarwinExecutableIdentityReader;
  /** Test seam: a tighter whole-check bound; never above the probe's own. */
  readonly timeoutMs?: number;
}): Promise<NativeClaudeInboxCompatibilityOutcome> {
  // One whole-check deadline: the identity lookup runs under it, and the probe
  // receives only what is left, so a stalled lookup can never hold the ordinary
  // launch past the probe's bound.
  const timeoutMs = boundedOverride(input.timeoutMs, DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS);
  if (timeoutMs === null) return declineClaudeInboxCompatibility("version-unavailable");
  const deadline = performance.now() + timeoutMs;
  const identity = await identityWithin(input.identity ?? productionExecutableIdentity, input.file, deadline);
  if (!validIdentity(identity)) return declineClaudeInboxCompatibility("version-unavailable");
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return declineClaudeInboxCompatibility("version-unavailable");
  let outcome: DarwinClaudeVersionOutcome;
  try {
    outcome = await (input.probe ?? probeDarwinClaudeVersion)({
      file: input.file,
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      cwd: input.cwd,
      env: input.env,
      deps: Object.freeze({ timeoutMs: remaining }),
    });
  } catch {
    return declineClaudeInboxCompatibility("version-unavailable");
  }
  if (outcome === null || typeof outcome !== "object") return declineClaudeInboxCompatibility("version-unavailable");
  if (outcome.evidence === "version") {
    const version = outcome.version;
    if (typeof version !== "string" || parseStableCliVersion(version) === undefined) {
      return declineClaudeInboxCompatibility("version-unrecognized");
    }
    if (!isClaudeInboxSupportedCliVersion(version)) return declineClaudeInboxCompatibility("version-unsupported");
    return Object.freeze({ compatibility: "verified", version });
  }
  if (outcome.evidence === "refused" && outcome.reason === "version-unrecognized") {
    return declineClaudeInboxCompatibility("version-unrecognized");
  }
  if (outcome.evidence === "refused" && outcome.reason === "version-unsupported") {
    return declineClaudeInboxCompatibility("version-unsupported");
  }
  return declineClaudeInboxCompatibility("version-unavailable");
}

/**
 * The identity reader's answer if it settles before `deadline`, else
 * `undefined`. A late answer (or rejection) is discarded and starts nothing.
 */
function identityWithin(
  reader: DarwinExecutableIdentityReader,
  file: string,
  deadline: number,
): Promise<DarwinExecutableIdentity | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: DarwinExecutableIdentity | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(undefined), Math.max(0, Math.ceil(deadline - performance.now())));
    let pending: Promise<DarwinExecutableIdentity | undefined>;
    try {
      pending = Promise.resolve(reader(file));
    } catch {
      settle(undefined);
      return;
    }
    pending.then(
      (value) => settle(performance.now() < deadline ? value : undefined),
      () => settle(undefined),
    );
  });
}
