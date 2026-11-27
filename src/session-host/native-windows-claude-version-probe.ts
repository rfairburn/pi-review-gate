/**
 * #682: Windows-only Claude Code version evidence for one exact,
 * already-verified direct native executable.
 *
 * ## What this module is
 *
 * The Windows counterpart of the Darwin version evidence
 * (./native-darwin-claude-version-probe): it decides whether ONE
 * already-resolved, already-verified direct native `.exe`, intended for ONE
 * exact launch row, reports a stable Claude Code version at or above the shared
 * inbox floor (`CLAUDE_INBOX_MIN_CLI_VERSION`). Its one product caller is the
 * native CLI launcher (./native-cli-launch), through
 * {@linkcode probeWindowsClaudeInboxCompatibility}, only for an explicitly
 * requested, otherwise eligible Windows default Claude launch (the prepared
 * root hook and managed MCP lane, a direct `.exe`); it registers nothing and
 * changes no manager, custody, hook, inbox, auth, settings, or other platform
 * behavior. The Linux probe and its `/usr/bin/python3` trampoline, the Darwin
 * probe, and the Windows custody PowerShell supervisor are not used here. The
 * module itself never spawns anything: it has no process API import, never runs a
 * shell, PowerShell, `cmd.exe`, a PATH search, an installer, a compiler, or a
 * new binary, and it changes no policy.
 *
 * ## Admission (all before any runner is invoked)
 *
 * - The host is `win32`, the bounds are the shared Claude probe bounds or
 *   tighter, an exact-image runner (below) is supplied, and the caller's row
 *   predicate reports the row current.
 * - The target record names route `direct-native-exe`, a row id, the exact
 *   file, and the verification-time fingerprint (`dev`, `ino`, `size`,
 *   `mtimeNs`, `ctimeNs`) the caller observed when it resolved and verified that
 *   file. A zero change time is not a fingerprint and is refused. There is no
 *   other route: a `.cmd` or `.bat`, a shim, a wrapper, a link, a bare name, or
 *   anything that would need a search or a fallback is refused, never repaired.
 * - The file is a drive-absolute, already-normalized Win32 path ending in
 *   `.exe`, at most 255 UTF-16 units, with no UNC, `\\?\` or device namespace,
 *   no alternate data stream, no forward slash, no `.`/`..`/empty component, no
 *   trailing dot or space, no reserved device name, no 8.3 short-name alias
 *   (`~<digit>`), no control character, and no unpaired surrogate.
 * - Every ancestor is a directory observed without following (a symlink,
 *   junction, or App Execution Alias reports as a link and is refused); the
 *   target is a regular file whose path fingerprint, opened-handle fingerprint,
 *   and verification-time fingerprint all agree (so an in-place change since
 *   verification is refused even when it preserves file id, size, and mtime),
 *   and whose header is a 64-bit (AMD64 or ARM64) PE32+ console executable
 *   image (not a DLL, script, or other lookalike).
 * - Defense in depth only: libuv-style extension fallback names
 *   (`<file>.com`, `<file>.exe`) must be absent before and after the run. This
 *   does NOT tie a launch to the image; the runner's before-resume check does.
 *
 * The probe does NOT re-prove ownership, ACLs, or code signatures: those belong
 * to the caller's prior verification of the exact file ("already verified").
 *
 * ## The exact-image runner contract
 *
 * Pathname snapshots cannot bind a launch: a pathname-based spawn (Node's
 * `child_process.spawn`, i.e. libuv `CreateProcessW` after its own extension
 * search) can start a different image if the path changes between the last
 * check and process creation, and a later refusal cannot undo that start. The
 * probe therefore NEVER spawns by itself. It invokes only a supplied
 * {@linkcode WindowsExactImageVersionRunner} that declares
 * `binding: "exact-image-no-fallback"` and receives the expected image, cwd,
 * and ancestor identities. Such a runner must, at the approved same-user trust
 * boundary (the documented suspended-image check):
 *
 * - start exactly `spec.file` with exactly `spec.args`, `spec.cwd`, and
 *   `spec.env`, with no shell, search, or fallback, from held handles on the
 *   exact executable and on every cwd/ancestor directory that it protects
 *   against rename, removal, and (for the executable) writes, whose identities
 *   equal the expected ones;
 * - create the child suspended and already assigned (at creation) to an owned
 *   kill-on-close, non-breakaway job; before it runs, confirm that membership,
 *   require the native image name read from the exact suspended child handle
 *   to equal the protected executable's NT path, and recheck the held handles;
 *   it reports
 *   `launch: "suspended-image-name-matched"` only when all of that held before
 *   resume, and `terminated-before-resume` when it terminated the never-resumed
 *   child instead. This does not independently verify the child's working
 *   directory and does not sandbox an attacker running as the same user;
 * - enforce one combined stdout+stderr byte window and the run deadline, and
 *   report the combined byte count and the monotonic time capture completed;
 * - terminate, when needed, only the exact owned process handle or owned job,
 *   never a PID; report `exited` only after observing that handle's exit
 *   receipt AND closing every process, job, and pipe handle owned by this
 *   invocation (`ownedHandles: "closed"`), otherwise `unsettled`; an exit or a
 *   tree-empty witness establishes process state, not handle release; and
 *   report descendants `witnessed-empty` only from a kernel witness on the
 *   owned job handle.
 *
 * ./native-windows-claude-version-runner implements this contract with stock
 * Windows PowerShell 5.1 and in-memory kernel32 calls; this module never
 * imports it and has no default runner (the launcher supplies it). With no runner the probe refuses
 * `runner-unavailable` before any filesystem access, and nothing is started.
 * The probe does not trust a receipt's claims beyond their literal shape: its
 * budget starts before the first row predicate, it re-checks the deadline
 * after every predicate and on the exact start sample handed to the runner
 * (refusing at or past the deadline), it refuses before invoking the runner
 * when its own executable handle fails to close, races the runner against the
 * final bound, decodes each receipt field exactly once (a throwing or
 * malformed receipt, or one whose decoding finishes past the final bound, is
 * `unsettled`), and requires a completed receipt to show capture completion
 * before the run deadline and stdout (alone, and with stderr) within the byte
 * cap.
 *
 * ## Effects and rechecks
 *
 * The runner receives `file`, the single argument `--version`, the fixed working
 * directory (the executable's own parent, part of the rechecked ancestor chain),
 * and an environment built from an allowlist (see
 * {@linkcode buildWindowsClaudeVersionEnvironment}); no provider, credential,
 * hook, custody, bootstrap, or other marker value can reach it, and a request
 * whose source environment carries the native hook bootstrap marker in any
 * casing is refused outright. Around that one effect the ancestor chain, target
 * fingerprint, fallback-name absence, and row currency are rechecked immediately
 * before the runner is invoked and again after the exact child's exit receipt,
 * within the final bound.
 *
 * ## One bounded window
 *
 * Checks and run share one monotonic deadline
 * ({@linkcode WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS}) and one combined
 * stdout+stderr byte cap ({@linkcode WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES});
 * exit confirmation and the post-run recheck must finish by that deadline plus
 * {@linkcode WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS}, which a late settlement
 * never extends. Only stdout is parsed, only in the exact official form
 * `<major>.<minor>.<patch> (Claude Code)` (the Linux/Darwin grammar), and only a
 * stable version at or above the shared floor is evidence. Neither stream's
 * contents, a path, an errno, nor any raw error ever appears in an outcome; the
 * probe never throws.
 *
 * ## Production composition
 *
 * The probe itself still has no default runner. The launcher composes it with
 * the reviewed exact-image runner over the trusted System32 Windows PowerShell
 * 5.1 resolver (./native-windows-claude-host-composition); when no trusted
 * PowerShell resolves, no runner exists and the probe refuses
 * `runner-unavailable`, starting nothing (the launch proceeds without
 * callback). Node's own process API is not a runner: it spawns by pathname
 * (with libuv's extension search) and exposes no owned job, so a PID, an exit
 * code, a parent close, or stdio EOF is never accepted as proof that
 * descendants are gone. The runner was observed on real Windows (stock
 * PowerShell 5.1) before wiring; the portable tests prove neither the
 * PowerShell script's behavior nor any live Claude build.
 *
 * Accepted limitation (stated, not hidden): the check protects the exact local
 * executable and cwd/ancestor handles and matches the suspended child's native
 * image name to the protected file's NT path; it makes no claim of an
 * independently verified child cwd or of sandboxing an attacker running as the
 * same user.
 *
 * Residual facts the portable tests do NOT prove (stated, not claimed): live
 * Windows compatibility of any Claude build with these checks, that NTFS (or
 * any other volume) change time is a reliable fingerprint for every in-place
 * change, and the libuv behaviors cited above for the target Node build.
 */
import { lstat, open } from "node:fs/promises";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

import { isClaudeInboxSupportedCliVersion } from "./native-claude-inbox-delivery";
import {
  CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  declineClaudeInboxCompatibility,
  type NativeClaudeInboxCompatibilityOutcome,
  type NativeClaudeWindowsImage,
} from "./native-claude-version-probe";
import { parseStableCliVersion } from "./native-cli-version-floor";
import { NATIVE_HOOK_BOOTSTRAP_ENV } from "./native-hook-protocol";
import { NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV } from "./native-review-hook-protocol";

/* --------------------------------------------------------------- constants */

/** Whole-probe wall-clock bound (checks + run), identical to the Linux probe. */
export const WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS = CLAUDE_VERSION_PROBE_TIMEOUT_MS;

/** Combined stdout+stderr byte cap, identical to the Linux probe. */
export const WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES = CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES;

/** Additional bound for exit confirmation and the post-run recheck. */
export const WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS = 1_000;

/** The single argument the probe ever passes. */
export const WINDOWS_CLAUDE_VERSION_ARGS: readonly string[] = Object.freeze(["--version"]);

/** The only admitted target route. */
export const WINDOWS_CLAUDE_VERSION_ROUTE = "direct-native-exe";

/**
 * Source-environment names copied (validated) into the probe environment. All
 * are host system locations; none is provider, credential, or marker data.
 */
export const WINDOWS_CLAUDE_VERSION_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
]);

/**
 * libuv adds each of its required Windows variables (HOMEDRIVE, HOMEPATH,
 * LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME,
 * USERPROFILE, WINDIR) from the HOST environment when the supplied environment
 * lacks it. Every required name not passed through is therefore pinned to an
 * empty value so no host value (notably PATH or a profile location) is imported.
 */
export const WINDOWS_CLAUDE_VERSION_ENV_PINNED_EMPTY: readonly string[] = Object.freeze([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
]);

/** Exact official Claude Code `--version` stdout; same grammar as the Linux and Darwin probes. */
const CLAUDE_VERSION_STDOUT = /^(\d{1,6}\.\d{1,6}\.\d{1,6}) \(Claude Code\)\r?\n?$/u;

/** Longest admitted target path, so `<file>.com` and `<file>.exe` stay below `MAX_PATH` (260). */
const MAX_FILE_CHARS = 255;
const MAX_ENV_PATH_CHARS = 259;
const ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DRIVE_ROOT = /^[A-Za-z]:\\/u;
const FORBIDDEN_COMPONENT_CHAR = /[\u0000-\u001f<>:"/\\|?*]/u;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const RESERVED_DEVICE_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])$/iu;
const SHORT_NAME_ALIAS = /~\d/u;
const ENV_DRIVE_PATH = /^[A-Za-z]:\\[^\u0000-\u001f"<>|?*]*$/u;
const ENV_DRIVE = /^[A-Za-z]:$/u;

/* PE recognition. */
const PE_HEAD_BYTES = 4096;
const DOS_HEADER_BYTES = 0x40;
const MZ = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_DLL = 0x2000;
const PE32_PLUS_MAGIC = 0x20b;
const PE32_PLUS_MIN_OPTIONAL_HEADER = 112;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
const MAX_SECTIONS = 96;
const SECTION_HEADER_BYTES = 40;

/* ------------------------------------------------------------------- types */

/** Closed refusal vocabulary. Never carries a path, errno, raw error, or output. */
export type WindowsClaudeVersionRefusal =
  /** The host is not Windows. */
  | "unsupported-platform"
  /** Malformed request: route, row id, path, fingerprint, predicate, environment, or bounds. */
  | "invalid-request"
  /** No exact-image, no-fallback runner was supplied; nothing was started. */
  | "runner-unavailable"
  /** The row predicate did not report the row current (or threw). */
  | "context-changed"
  /** An ancestor is missing, a link, or not a directory. */
  | "untrusted-path"
  /** The target is missing, a link, or not a regular file. */
  | "untrusted-target"
  /** The target's fingerprint differs from the verification-time one or between path and handle. */
  | "target-identity-mismatch"
  /** An extension-fallback name (`<file>.com` / `<file>.exe`) exists or is unknowable. */
  | "target-ambiguous"
  /** The target is not a 64-bit PE32+ console executable image. */
  | "non-native-executable"
  /** An ancestor, the target, or a fallback name changed across the probe. */
  | "target-changed"
  /** The runner created no process. */
  | "spawn-failed"
  /** The suspended child failed the before-resume proof and was terminated without running. */
  | "launch-unverified"
  /** The whole-probe wall-clock bound was crossed (including a capture completed too late). */
  | "timeout"
  /** Combined output, or stdout alone, exceeded the byte cap. */
  | "oversized"
  /** Nonzero exit or a signal. */
  | "abnormal-exit"
  /** An output stream or the child failed, or the capture receipt is inconsistent. */
  | "output-failed"
  /** The exact child exited cleanly, but no owned-job witness proved its process tree gone. */
  | "teardown-unproven"
  /** Clean run, but stdout is not the exact official form. */
  | "version-unrecognized"
  /** Exact form, but not a stable version at or above the shared floor. */
  | "version-unsupported"
  /** An unexpected internal failure. */
  | "internal-failure";

/** Why a probe could not settle its exact child. */
export type WindowsClaudeVersionUnsettledReason =
  /** A runner was invoked and the exact child's fate is unknown (late, rejected, or malformed receipt). */
  | "cleanup-unconfirmed"
  /** The runner itself reported (or threw) a start it cannot exclude. */
  | "spawn-uncertain";

/** Descendant teardown fact reported by a runner; only `witnessed-empty` is proof. */
export type WindowsDescendantTeardown = "witnessed-empty" | "unproven";

/** Verification-time fingerprint of the target, observed when the caller resolved and verified it. */
export interface WindowsExecutableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  /** Change time; updated by any in-place content or metadata change. Must be positive. */
  readonly ctimeNs: bigint;
}

/** The already-resolved, already-verified direct native target for one exact row. */
export interface WindowsClaudeVersionTarget {
  readonly route: typeof WINDOWS_CLAUDE_VERSION_ROUTE;
  readonly rowId: string;
  readonly file: string;
  readonly identity: WindowsExecutableIdentity;
}

/**
 * Outcome. Only `version` is evidence: the exact observed stable version for
 * the exact row, file, and fingerprint, after a launch whose suspended image
 * name matched the protected executable before resume, an owned clean
 * lifecycle, and a witnessed-empty process tree. `refused` is a
 * clean refusal: either nothing was started (`process: "none"`) or the exact
 * child's exit receipt was observed. `unsettled` means a runner was invoked and
 * the child's fate is unknown: the caller must treat the row as poisoned and
 * must never assume its process tree is gone.
 */
export type WindowsClaudeVersionOutcome =
  | {
      readonly evidence: "version";
      readonly version: string;
      readonly rowId: string;
      readonly file: string;
      readonly identity: WindowsExecutableIdentity;
      readonly lifecycle: {
        readonly launch: "suspended-image-name-matched";
        readonly exactChild: "exited-clean";
        readonly descendants: "witnessed-empty";
      };
    }
  | { readonly evidence: "refused"; readonly reason: WindowsClaudeVersionRefusal; readonly process: "none" }
  | {
      readonly evidence: "refused";
      readonly reason: WindowsClaudeVersionRefusal;
      readonly process: "exact-child-exited";
      readonly descendants: WindowsDescendantTeardown;
    }
  | { readonly evidence: "unsettled"; readonly reason: WindowsClaudeVersionUnsettledReason; readonly descendants: "unproven" };

/** Normalized no-follow observation of one filesystem object. */
export interface WindowsFileFacts {
  readonly kind: "file" | "directory" | "link" | "other";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

/** One opened target descriptor. */
export interface WindowsFileHandle {
  stat(): Promise<WindowsFileFacts>;
  /** Up to `length` bytes at `position`; short only at end of file. `checkDeadline` runs before every read. */
  read(position: number, length: number, checkDeadline?: () => void): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Filesystem seam. `lstat` rejects with an error whose `code` is `ENOENT` when absent. */
export interface WindowsProbeFileSystem {
  lstat(path: string): Promise<WindowsFileFacts>;
  open(path: string): Promise<WindowsFileHandle>;
}

/**
 * Fingerprint the runner must find on its protected executable handle before
 * creation and again before resume.
 */
export interface WindowsExpectedImage {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

/**
 * Identity the runner must find on a held, rename-protected directory handle.
 * For the cwd this keeps the passed path bound; the child's actual working
 * directory is not independently verified.
 */
export interface WindowsExpectedDirectory {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

/** The exact launch the runner performs, with the identities its held handles must show. */
export interface WindowsExactImageRunSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly image: WindowsExpectedImage;
  readonly cwdIdentity: WindowsExpectedDirectory;
  /** Every ancestor of `file`, drive root first; the last one is `cwdIdentity`. */
  readonly ancestorIdentities: readonly WindowsExpectedDirectory[];
}

/** Absolute monotonic bounds for one run. */
export interface WindowsDirectVersionRunBounds {
  /** Run deadline (monotonic ms); capture must complete before it. */
  readonly deadline: number;
  /** Forced-termination confirmation window, ending at `min(settle, deadline) + cleanupMs`. */
  readonly cleanupMs: number;
  /** Combined stdout+stderr byte cap. */
  readonly maxOutputBytes: number;
}

/** How an exited run ended. */
export type WindowsDirectVersionRunKind = "completed" | "timeout" | "oversized" | "abnormal-exit" | "output-failed";

/**
 * A runner's receipt. `exited` requires the exact child's exit receipt from its
 * owned handle, `launch: "suspended-image-name-matched"` (the before-resume
 * proof held), and `ownedHandles: "closed"` after releasing every handle the
 * invocation owned; `stdout` is meaningful only for `completed`, which must
 * also carry the combined captured byte count and the monotonic time capture
 * completed. `descendants` may be `witnessed-empty` only from a kernel witness
 * on the owned job handle. `terminated-before-resume` means the suspended
 * child failed that proof, never ran, and was terminated, with its exit, the
 * empty job, and every owned handle's release observed.
 */
export type WindowsDirectVersionRunReceipt =
  | { readonly exactChild: "not-created" }
  | {
      readonly exactChild: "exited";
      readonly launch: "suspended-image-name-matched";
      readonly ownedHandles: "closed";
      readonly kind: WindowsDirectVersionRunKind;
      readonly stdout: string;
      readonly outputBytes: number;
      readonly captureCompletedAt: number;
      readonly descendants: WindowsDescendantTeardown;
    }
  | {
      readonly exactChild: "terminated-before-resume";
      readonly ownedHandles: "closed";
      readonly descendants: "witnessed-empty";
    }
  | { readonly exactChild: "unsettled" }
  | { readonly exactChild: "spawn-uncertain" };

/**
 * Restrictive runner seam (see the module header for the full contract). The
 * only implementation is ./native-windows-claude-version-runner;
 * never a general command runner.
 */
export interface WindowsExactImageVersionRunner {
  readonly binding: "exact-image-no-fallback";
  readonly run: (
    spec: WindowsExactImageRunSpec,
    bounds: WindowsDirectVersionRunBounds,
    now: () => number,
  ) => Promise<WindowsDirectVersionRunReceipt>;
}

/** Seams. Bounds may only be tightened. Without `runner`, nothing is ever started. */
export interface WindowsClaudeVersionProbeDeps {
  readonly platform?: NodeJS.Platform;
  readonly fs?: WindowsProbeFileSystem;
  readonly runner?: WindowsExactImageVersionRunner;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cleanupMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WindowsClaudeVersionProbeRequest {
  readonly target: WindowsClaudeVersionTarget;
  /** Row currency predicate; must return exactly `true` around every effect. */
  readonly isCurrent: () => boolean;
  /** Source environment; only allowlisted system names are used. */
  readonly env: NodeJS.ProcessEnv;
  readonly deps?: WindowsClaudeVersionProbeDeps;
}

/* -------------------------------------------------------------- refusals */

class Refusal {
  constructor(readonly reason: WindowsClaudeVersionRefusal) {}
}

function refuse(reason: WindowsClaudeVersionRefusal): never {
  throw new Refusal(reason);
}

function refusedBeforeStart(reason: WindowsClaudeVersionRefusal): WindowsClaudeVersionOutcome {
  return Object.freeze({ evidence: "refused", reason, process: "none" });
}

function refusedAfterExit(reason: WindowsClaudeVersionRefusal, descendants: WindowsDescendantTeardown): WindowsClaudeVersionOutcome {
  return Object.freeze({ evidence: "refused", reason, process: "exact-child-exited", descendants });
}

function unsettled(reason: WindowsClaudeVersionUnsettledReason): WindowsClaudeVersionOutcome {
  return Object.freeze({ evidence: "unsettled", reason, descendants: "unproven" });
}

/* ------------------------------------------------------ request validation */

/**
 * `C:\a\b\c.exe` → `["C:\", "C:\a", "C:\a\b"]`, or `null` when the path is not
 * an admitted drive-absolute direct `.exe` (see the module header).
 */
export function windowsClaudeTargetAncestors(file: unknown): string[] | null {
  if (typeof file !== "string" || file.length < 8 || file.length > MAX_FILE_CHARS) return null;
  if (LONE_SURROGATE.test(file) || !DRIVE_ROOT.test(file)) return null;
  if (win32.normalize(file) !== file) return null;
  const root = file.slice(0, 3);
  const parts = file.slice(3).split("\\");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === "..") return null;
    if (FORBIDDEN_COMPONENT_CHAR.test(part) || part.endsWith(".") || part.endsWith(" ")) return null;
    if (SHORT_NAME_ALIAS.test(part)) return null;
    const stem = part.split(".")[0]!.replace(/ +$/u, "");
    if (RESERVED_DEVICE_STEM.test(stem)) return null;
  }
  const name = parts[parts.length - 1]!;
  if (!/^[^.].*\.exe$/iu.test(name)) return null;
  const ancestors = [root];
  for (let index = 1; index < parts.length; index += 1) ancestors.push(`${root}${parts.slice(0, index).join("\\")}`);
  return ancestors;
}

/** A frozen copy of a well-formed verification-time fingerprint, or `null`. Each field is read once. */
function copyIdentity(identity: unknown): WindowsExecutableIdentity | null {
  if (identity === null || typeof identity !== "object") return null;
  const { dev, ino, size, mtimeNs, ctimeNs } = identity as WindowsExecutableIdentity;
  const valid = typeof dev === "bigint" && typeof ino === "bigint" && typeof size === "bigint"
    && typeof mtimeNs === "bigint" && typeof ctimeNs === "bigint"
    && dev >= 0n && ino > 0n && size > 0n && mtimeNs >= 0n && ctimeNs > 0n;
  return valid ? Object.freeze({ dev, ino, size, mtimeNs, ctimeNs }) : null;
}

function boundedOverride(value: number | undefined, ceiling: number): number | null {
  if (value === undefined) return ceiling;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > ceiling) return null;
  return value;
}

/**
 * The exact probe environment, or `null` when the source is malformed, carries
 * the native hook bootstrap marker or the separate native REVIEW bootstrap marker
 * (#736) in any casing, has conflicting case variants of an allowlisted name, lacks
 * a drive-absolute `SystemRoot`, or carries a malformed allowlisted value. Only {@linkcode WINDOWS_CLAUDE_VERSION_ENV_PASSTHROUGH}
 * names are copied (under their canonical spelling); every
 * {@linkcode WINDOWS_CLAUDE_VERSION_ENV_PINNED_EMPTY} name, and any passthrough
 * name other than `SystemRoot` that is absent, is set to `""`. Nothing else —
 * no provider, credential, hook, custody, or bootstrap value — is ever copied.
 */
export function buildWindowsClaudeVersionEnvironment(source: unknown): Readonly<Record<string, string>> | null {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
  const marker = NATIVE_HOOK_BOOTSTRAP_ENV.toUpperCase();
  // #736: the SEPARATE review-family marker is refused by the same rule, in every
  // casing. A bounded `--version` probe authenticates nothing, so neither hook
  // family's secret ever travels to it.
  const reviewMarker = NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV.toUpperCase();
  const allowed = new Map(WINDOWS_CLAUDE_VERSION_ENV_PASSTHROUGH.map((name) => [name.toUpperCase(), name] as const));
  const picked = new Map<string, string>();
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === marker || upper === reviewMarker) return null;
    const canonical = allowed.get(upper);
    if (canonical === undefined) continue;
    if (typeof value !== "string" || LONE_SURROGATE.test(value)) return null;
    const previous = picked.get(canonical);
    if (previous !== undefined && previous !== value) return null;
    picked.set(canonical, value);
  }
  const env: Record<string, string> = {};
  for (const name of WINDOWS_CLAUDE_VERSION_ENV_PASSTHROUGH) {
    const value = picked.get(name);
    if (value === undefined) {
      if (name === "SystemRoot") return null;
      env[name] = "";
      continue;
    }
    const valid = name === "SystemDrive"
      ? ENV_DRIVE.test(value)
      : value.length <= MAX_ENV_PATH_CHARS && ENV_DRIVE_PATH.test(value);
    if (!valid) return null;
    env[name] = value;
  }
  for (const name of WINDOWS_CLAUDE_VERSION_ENV_PINNED_EMPTY) env[name] = "";
  return Object.freeze(env);
}

/* ------------------------------------------------------ PE recognition */

/** Reader seam: bytes at `position`, short only at end of file. */
export type WindowsHeaderReader = (position: number, length: number) => Promise<Uint8Array>;

/**
 * Conservatively recognize a 64-bit native Windows console executable image:
 * `MZ`, an in-range `e_lfanew` naming `PE\0\0`, machine AMD64 or ARM64, 1–96
 * sections, `IMAGE_FILE_EXECUTABLE_IMAGE` set and `IMAGE_FILE_DLL` clear, a
 * PE32+ optional header large enough to hold its subsystem, subsystem
 * `WINDOWS_CUI`, and section headers that fit in the file. Anything else —
 * scripts, batch files renamed `.exe`, DLLs, GUI images, 32-bit images — is
 * `null`.
 */
export async function classifyWindowsNativeExecutable(read: WindowsHeaderReader, size: bigint): Promise<"pe32-plus-console" | null> {
  if (typeof size !== "bigint" || size < BigInt(DOS_HEADER_BYTES)) return null;
  const headLength = size < BigInt(PE_HEAD_BYTES) ? Number(size) : PE_HEAD_BYTES;
  const head = await read(0, headLength);
  if (!(head instanceof Uint8Array) || head.byteLength !== headLength) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint16(0, true) !== MZ) return null;
  const peOffset = view.getUint32(0x3c, true);
  const optionalOffset = peOffset + 24;
  if (peOffset < DOS_HEADER_BYTES || optionalOffset + PE32_PLUS_MIN_OPTIONAL_HEADER > head.byteLength) return null;
  if (view.getUint32(peOffset, true) !== PE_SIGNATURE) return null;
  const machine = view.getUint16(peOffset + 4, true);
  if (machine !== IMAGE_FILE_MACHINE_AMD64 && machine !== IMAGE_FILE_MACHINE_ARM64) return null;
  const sections = view.getUint16(peOffset + 6, true);
  if (sections < 1 || sections > MAX_SECTIONS) return null;
  const optionalSize = view.getUint16(peOffset + 20, true);
  const characteristics = view.getUint16(peOffset + 22, true);
  if ((characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) === 0 || (characteristics & IMAGE_FILE_DLL) !== 0) return null;
  if (optionalSize < PE32_PLUS_MIN_OPTIONAL_HEADER) return null;
  if (view.getUint16(optionalOffset, true) !== PE32_PLUS_MAGIC) return null;
  if (view.getUint16(optionalOffset + 68, true) !== IMAGE_SUBSYSTEM_WINDOWS_CUI) return null;
  const headersEnd = BigInt(optionalOffset + optionalSize + sections * SECTION_HEADER_BYTES);
  return headersEnd <= size ? "pe32-plus-console" : null;
}

/* -------------------------------------------------------- filesystem trust */

function sameContent(a: WindowsFileFacts, b: WindowsFileFacts): boolean {
  return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

function sameDirectory(a: WindowsFileFacts, b: WindowsFileFacts): boolean {
  return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

interface ChainSnapshot {
  readonly ancestors: readonly WindowsFileFacts[];
  readonly target: WindowsFileFacts;
}

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Observe every ancestor and the target; a missing or failing object is the given refusal. */
async function observeChain(
  fs: WindowsProbeFileSystem,
  ancestors: readonly string[],
  file: string,
  checkDeadline: () => void,
): Promise<ChainSnapshot> {
  const observed: WindowsFileFacts[] = [];
  for (const path of ancestors) {
    checkDeadline();
    let facts: WindowsFileFacts;
    try { facts = await fs.lstat(path); } catch { refuse("untrusted-path"); }
    if (facts.kind !== "directory") refuse("untrusted-path");
    observed.push(facts);
  }
  checkDeadline();
  let target: WindowsFileFacts;
  try { target = await fs.lstat(file); } catch { refuse("untrusted-target"); }
  if (target.kind !== "file") refuse("untrusted-target");
  return { ancestors: observed, target };
}

/** Both libuv extension-fallback siblings must be positively absent (ENOENT). */
async function requireSiblingsAbsent(fs: WindowsProbeFileSystem, file: string, checkDeadline: () => void): Promise<void> {
  for (const sibling of [`${file}.com`, `${file}.exe`]) {
    checkDeadline();
    let present = true;
    try {
      await fs.lstat(sibling);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") present = false;
    }
    if (present) refuse("target-ambiguous");
  }
}

function unchanged(before: ChainSnapshot, after: ChainSnapshot): boolean {
  if (after.ancestors.length !== before.ancestors.length) return false;
  for (let index = 0; index < before.ancestors.length; index += 1) {
    if (!sameDirectory(before.ancestors[index]!, after.ancestors[index]!)) return false;
  }
  return sameContent(before.target, after.target);
}

/* -------------------------------------------------------- production seams */

function factsOf(stats: import("node:fs").BigIntStats): WindowsFileFacts {
  const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  return {
    kind,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  };
}

const productionFileSystem: WindowsProbeFileSystem = {
  lstat: async (path) => factsOf(await lstat(path, { bigint: true })),
  open: async (path) => {
    const handle = await open(path, "r");
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

/** Await `work` until the absolute monotonic `at`; past it, refuse `timeout` and run `onAbandon`. */
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

/* ------------------------------------------------------------------ probe */

const RUN_KINDS: ReadonlySet<string> = new Set(["completed", "timeout", "oversized", "abnormal-exit", "output-failed"]);
const TEARDOWN_FACTS: ReadonlySet<string> = new Set(["witnessed-empty", "unproven"]);

/**
 * A frozen snapshot of a strictly shaped receipt, or `null` when its shape is
 * unknown or reading it throws. Every field is read exactly once, so the
 * validated values are the values used.
 */
function decodeReceipt(receipt: unknown): WindowsDirectVersionRunReceipt | null {
  try {
    if (receipt === null || typeof receipt !== "object") return null;
    const value = receipt as Record<string, unknown>;
    const exactChild = value.exactChild;
    if (exactChild === "not-created" || exactChild === "unsettled" || exactChild === "spawn-uncertain") {
      return Object.freeze({ exactChild });
    }
    if (exactChild === "terminated-before-resume") {
      const ownedHandles = value.ownedHandles;
      const descendants = value.descendants;
      if (ownedHandles !== "closed" || descendants !== "witnessed-empty") return null;
      return Object.freeze({ exactChild, ownedHandles, descendants });
    }
    if (exactChild !== "exited") return null;
    const launch = value.launch;
    const ownedHandles = value.ownedHandles;
    const kind = value.kind;
    const stdout = value.stdout;
    const outputBytes = value.outputBytes;
    const captureCompletedAt = value.captureCompletedAt;
    const descendants = value.descendants;
    if (launch !== "suspended-image-name-matched" || ownedHandles !== "closed") return null;
    if (typeof kind !== "string" || !RUN_KINDS.has(kind)) return null;
    if (typeof stdout !== "string") return null;
    if (typeof outputBytes !== "number" || !Number.isSafeInteger(outputBytes) || outputBytes < 0) return null;
    if (typeof captureCompletedAt !== "number" || !Number.isFinite(captureCompletedAt)) return null;
    if (typeof descendants !== "string" || !TEARDOWN_FACTS.has(descendants)) return null;
    return Object.freeze({
      exactChild: "exited",
      launch,
      ownedHandles,
      kind: kind as WindowsDirectVersionRunKind,
      stdout,
      outputBytes,
      captureCompletedAt,
      descendants: descendants as WindowsDescendantTeardown,
    });
  } catch {
    return null;
  }
}

/** The decoded receipt if the runner settles by `at`; otherwise (late, rejected, malformed) `null`. Never rejects. */
function receiptWithin(work: Promise<unknown>, at: number, now: () => number): Promise<WindowsDirectVersionRunReceipt | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: WindowsDirectVersionRunReceipt | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), Math.max(0, at - now()));
    work.then(
      (value) => {
        let decoded: WindowsDirectVersionRunReceipt | null = null;
        try {
          if (now() <= at) {
            decoded = decodeReceipt(value);
            // Receipt reads run synchronously and the timer cannot interrupt them:
            // a snapshot whose decoding finished past the bound is not trusted.
            if (decoded !== null && now() > at) decoded = null;
          }
        } catch {
          decoded = null;
        }
        settle(decoded);
      },
      () => settle(null),
    ).catch(() => settle(null));
  });
}

/** The runner's `run` function when it declares the exact-image binding; `null` otherwise. Read once. */
function exactImageRun(runner: unknown): WindowsExactImageVersionRunner["run"] | null {
  try {
    if (runner === null || typeof runner !== "object") return null;
    const { binding, run } = runner as WindowsExactImageVersionRunner;
    if (binding !== "exact-image-no-fallback" || typeof run !== "function") return null;
    return run.bind(runner);
  } catch {
    return null;
  }
}

/**
 * Probe one already-resolved, already-verified direct native Claude `.exe` for
 * one exact row and return exact version evidence, a clean refusal, or an
 * explicit `unsettled` result. Never throws. Without an exact-image runner it
 * starts nothing.
 */
export async function probeWindowsClaudeVersion(request: WindowsClaudeVersionProbeRequest): Promise<WindowsClaudeVersionOutcome> {
  const state = { started: false };
  try {
    return await probe(request, state);
  } catch (error) {
    if (state.started) return unsettled("cleanup-unconfirmed");
    return refusedBeforeStart(error instanceof Refusal ? error.reason : "internal-failure");
  }
}

async function probe(request: WindowsClaudeVersionProbeRequest, state: { started: boolean }): Promise<WindowsClaudeVersionOutcome> {
  if (request === null || typeof request !== "object") return refusedBeforeStart("invalid-request");
  const deps = request.deps ?? {};
  if ((deps.platform ?? process.platform) !== "win32") return refusedBeforeStart("unsupported-platform");

  const timeoutMs = boundedOverride(deps.timeoutMs, WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS);
  const cleanupMs = boundedOverride(deps.cleanupMs, WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS);
  const maxOutputBytes = boundedOverride(deps.maxOutputBytes, WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES);
  if (timeoutMs === null || cleanupMs === null || maxOutputBytes === null) return refusedBeforeStart("invalid-request");

  const target = request.target;
  if (target === null || typeof target !== "object" || target.route !== WINDOWS_CLAUDE_VERSION_ROUTE) {
    return refusedBeforeStart("invalid-request");
  }
  const rowId = target.rowId;
  const file = target.file;
  const ancestors = windowsClaudeTargetAncestors(file);
  const env = buildWindowsClaudeVersionEnvironment(request.env);
  const identity = copyIdentity(target.identity);
  const isCurrent = request.isCurrent;
  if (typeof rowId !== "string" || !ROW_ID_PATTERN.test(rowId) || ancestors === null || env === null
    || identity === null || typeof isCurrent !== "function") {
    return refusedBeforeStart("invalid-request");
  }
  // No exact-image, no-fallback runner: nothing may be started, so nothing is checked either.
  const run = exactImageRun(deps.runner);
  if (run === null) return refusedBeforeStart("runner-unavailable");

  const filePath = file;
  const current = (): boolean => {
    try { return isCurrent() === true; } catch { return false; }
  };
  const fs = deps.fs ?? productionFileSystem;
  const now = deps.now ?? (() => performance.now());
  const cwd = ancestors[ancestors.length - 1]!;
  const deadline = now() + timeoutMs;
  let abandoned = false;
  const pastDeadline = (): void => {
    if (abandoned || now() >= deadline) refuse("timeout");
  };
  // The budget already runs: a slow first predicate consumes it rather than receiving a fresh one.
  if (!current()) return refusedBeforeStart("context-changed");
  pastDeadline();

  const checks = (async (): Promise<ChainSnapshot> => {
    const before = await observeChain(fs, ancestors, filePath, pastDeadline);
    const observed = before.target;
    if (observed.dev !== identity.dev || observed.ino !== identity.ino || observed.size !== identity.size
      || observed.mtimeNs !== identity.mtimeNs || observed.ctimeNs !== identity.ctimeNs) {
      refuse("target-identity-mismatch");
    }
    await requireSiblingsAbsent(fs, filePath, pastDeadline);
    pastDeadline();
    let handle: WindowsFileHandle;
    try { handle = await fs.open(filePath); } catch { refuse("untrusted-target"); }
    try {
      pastDeadline();
      let opened: WindowsFileFacts;
      try { opened = await handle.stat(); } catch { refuse("untrusted-target"); }
      pastDeadline();
      if (!sameContent(opened, observed)) refuse("target-identity-mismatch");
      let format: Awaited<ReturnType<typeof classifyWindowsNativeExecutable>>;
      try {
        format = await classifyWindowsNativeExecutable((position, length) => {
          pastDeadline();
          return handle.read(position, length, pastDeadline);
        }, opened.size);
      } catch (error) {
        if (error instanceof Refusal) throw error;
        format = null;
      }
      pastDeadline();
      if (format === null) refuse("non-native-executable");
    } finally {
      // The probe's own descriptor must be released before anything is started.
      try { await handle.close(); } catch { refuse("internal-failure"); }
    }
    return before;
  })();
  const before = await withinDeadline(checks, deadline, now, () => { abandoned = true; });

  // Immediately before the one effect: the same chain, the fallback names, and the row.
  const recheck = (async (): Promise<ChainSnapshot> => {
    const again = await observeChain(fs, ancestors, filePath, pastDeadline);
    await requireSiblingsAbsent(fs, filePath, pastDeadline);
    return again;
  })();
  let rechecked: ChainSnapshot;
  try {
    rechecked = await withinDeadline(recheck, deadline, now, () => { abandoned = true; });
  } catch (error) {
    if (error instanceof Refusal && error.reason !== "timeout") refuse("target-changed");
    throw error;
  }
  pastDeadline();
  if (!unchanged(before, rechecked)) return refusedBeforeStart("target-changed");
  if (!current()) return refusedBeforeStart("context-changed");
  // The predicate may itself be slow: the deadline is rechecked after it, immediately before the runner.
  pastDeadline();

  const expectedTarget = before.target;
  const expectedCwd = before.ancestors[before.ancestors.length - 1]!;
  const spec: WindowsExactImageRunSpec = Object.freeze({
    file: filePath,
    args: WINDOWS_CLAUDE_VERSION_ARGS,
    cwd,
    env,
    image: Object.freeze({
      dev: expectedTarget.dev,
      ino: expectedTarget.ino,
      size: expectedTarget.size,
      mtimeNs: expectedTarget.mtimeNs,
      ctimeNs: expectedTarget.ctimeNs,
      birthtimeNs: expectedTarget.birthtimeNs,
    }),
    cwdIdentity: Object.freeze({ dev: expectedCwd.dev, ino: expectedCwd.ino, birthtimeNs: expectedCwd.birthtimeNs }),
    ancestorIdentities: Object.freeze(before.ancestors.map((facts) =>
      Object.freeze({ dev: facts.dev, ino: facts.ino, birthtimeNs: facts.birthtimeNs }))),
  });
  const finalDeadline = deadline + cleanupMs;
  const bounds: WindowsDirectVersionRunBounds = Object.freeze({ deadline, cleanupMs, maxOutputBytes });
  // The exact start sample handed to the runner must itself be inside the window.
  const startedAt = now();
  if (abandoned || startedAt >= deadline) return refusedBeforeStart("timeout");
  state.started = true;
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(run(spec, bounds, now));
  } catch {
    return unsettled("spawn-uncertain");
  }
  const receipt = await receiptWithin(pending, finalDeadline, now);
  const receivedAt = now();
  if (receipt === null || receipt.exactChild === "unsettled") return unsettled("cleanup-unconfirmed");
  if (receipt.exactChild === "spawn-uncertain") return unsettled("spawn-uncertain");
  if (receipt.exactChild === "not-created") {
    state.started = false;
    return refusedBeforeStart("spawn-failed");
  }
  if (receipt.exactChild === "terminated-before-resume") return refusedAfterExit("launch-unverified", receipt.descendants);

  // From here the exact child's exit receipt was reported: refusals are clean.
  const descendants = receipt.descendants;
  try {
    if (receipt.kind !== "completed") return refusedAfterExit(receipt.kind, descendants);
    // The capture itself must be substantiated within the one window.
    const captured = receipt.captureCompletedAt;
    if (captured < startedAt || captured > receivedAt) return refusedAfterExit("output-failed", descendants);
    if (captured >= deadline) return refusedAfterExit("timeout", descendants);
    const stdoutBytes = Buffer.byteLength(receipt.stdout, "utf8");
    if (stdoutBytes > maxOutputBytes || receipt.outputBytes > maxOutputBytes) return refusedAfterExit("oversized", descendants);
    if (stdoutBytes > receipt.outputBytes) return refusedAfterExit("output-failed", descendants);

    const pastFinalDeadline = (): void => {
      if (abandoned || now() >= finalDeadline) refuse("timeout");
    };
    const afterWork = (async (): Promise<ChainSnapshot> => {
      const after = await observeChain(fs, ancestors, filePath, pastFinalDeadline);
      await requireSiblingsAbsent(fs, filePath, pastFinalDeadline);
      return after;
    })();
    let after: ChainSnapshot;
    try {
      after = await withinDeadline(afterWork, finalDeadline, now, () => { abandoned = true; });
    } catch (error) {
      if (error instanceof Refusal && error.reason === "timeout") return refusedAfterExit("timeout", descendants);
      return refusedAfterExit("target-changed", descendants);
    }
    if (now() >= finalDeadline) return refusedAfterExit("timeout", descendants);
    if (!unchanged(before, after)) return refusedAfterExit("target-changed", descendants);
    if (!current()) return refusedAfterExit("context-changed", descendants);
    if (descendants !== "witnessed-empty") return refusedAfterExit("teardown-unproven", descendants);
    const match = CLAUDE_VERSION_STDOUT.exec(receipt.stdout);
    if (match === null) return refusedAfterExit("version-unrecognized", descendants);
    const version = match[1]!;
    if (parseStableCliVersion(version) === undefined) return refusedAfterExit("version-unrecognized", descendants);
    if (!isClaudeInboxSupportedCliVersion(version)) return refusedAfterExit("version-unsupported", descendants);
    if (now() >= finalDeadline) return refusedAfterExit("timeout", descendants);
    return Object.freeze({
      evidence: "version",
      version,
      rowId,
      file: filePath,
      identity,
      lifecycle: Object.freeze({ launch: "suspended-image-name-matched", exactChild: "exited-clean", descendants: "witnessed-empty" }),
    });
  } catch {
    return refusedAfterExit("internal-failure", descendants);
  }
}

/* -------------------------------------------------------- launcher adapter */

/** The probe entry point; a seam so launcher tests never spawn anything. */
export type WindowsClaudeVersionProbe = (request: WindowsClaudeVersionProbeRequest) => Promise<WindowsClaudeVersionOutcome>;

/** No-follow verification-time fingerprint of the resolved executable; a seam for tests only. */
export type WindowsExecutableIdentityReader = (file: string) => Promise<WindowsExecutableIdentity | undefined>;

/**
 * The launcher's view of one Windows probe: the shared compatibility outcome,
 * or `unsettled` when a runner was invoked and the exact child's fate is
 * unknown. `unsettled` is never a decline: the caller must not start a
 * competing launch for that attempt.
 */
export type WindowsClaudeInboxCompatibilityResult =
  | NativeClaudeInboxCompatibilityOutcome
  | { readonly compatibility: "unsettled" };

const UNSETTLED_COMPATIBILITY: WindowsClaudeInboxCompatibilityResult = Object.freeze({ compatibility: "unsettled" });

async function productionExecutableIdentity(file: string): Promise<WindowsExecutableIdentity | undefined> {
  const stats = await lstat(file, { bigint: true });
  return stats.isFile()
    ? { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs }
    : undefined;
}

/** The identity reader's answer if it settles before `deadline`, else `undefined`. Never throws. */
function windowsIdentityWithin(
  reader: WindowsExecutableIdentityReader,
  file: string,
  deadline: number,
): Promise<WindowsExecutableIdentity | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: WindowsExecutableIdentity | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), Math.max(0, deadline - performance.now()));
    try {
      Promise.resolve(reader(file)).then((value) => settle(copyIdentity(value)), () => settle(null));
    } catch {
      settle(null);
    }
  });
}

function sameWindowsIdentity(a: WindowsExecutableIdentity, b: WindowsExecutableIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** The JSON-safe receipt form of one verified image. */
export function windowsImageOf(file: string, identity: WindowsExecutableIdentity): NativeClaudeWindowsImage {
  return Object.freeze({
    file,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
    size: identity.size.toString(10),
    mtimeNs: identity.mtimeNs.toString(10),
    ctimeNs: identity.ctimeNs.toString(10),
  });
}

/**
 * #682: launcher adapter for ONE already-resolved, already-verified direct
 * native Claude `.exe` (the exact canonical `file` the descriptor spawns). It
 * takes that file's verification-time fingerprint by a no-follow lstat, runs
 * {@linkcode probeWindowsClaudeVersion} for that file and fingerprint only,
 * with the caller's exact-image runner (absent: `runner-unavailable`, nothing
 * started), and maps the result onto the shared compatibility outcome. Only
 * exact evidence of a stable supported version for that same file is
 * `verified`, and it carries that exact image (file and fingerprint) as
 * `windowsImage`; `version-unrecognized` and `version-unsupported` keep their
 * meaning; every other clean refusal is `version-unavailable`. An `unsettled`
 * probe — or a probe seam that throws or answers malformed, whose effect
 * cannot be excluded — is `unsettled`. There is no fallback to another
 * runner, a shim, a PATH or global tool, or an environment value. The
 * identity lookup and the probe share one deadline (the probe's own bound).
 * Never throws.
 *
 * The launcher has no row predicate of its own: `isCurrent` holds for the
 * whole launch attempt, and the manager's own fences decide whether the
 * descriptor carrying this result is ever used.
 */
export async function probeWindowsClaudeInboxCompatibility(input: {
  readonly file: string;
  /** The launch row's id (the hook bootstrap's instance id). */
  readonly rowId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runner: WindowsExactImageVersionRunner | undefined;
  readonly probe?: WindowsClaudeVersionProbe;
  readonly identity?: WindowsExecutableIdentityReader;
}): Promise<WindowsClaudeInboxCompatibilityResult> {
  const deadline = performance.now() + WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS;
  const identity = await windowsIdentityWithin(input.identity ?? productionExecutableIdentity, input.file, deadline);
  if (identity === null) return declineClaudeInboxCompatibility("version-unavailable");
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return declineClaudeInboxCompatibility("version-unavailable");
  let outcome: WindowsClaudeVersionOutcome;
  try {
    outcome = await (input.probe ?? probeWindowsClaudeVersion)({
      target: Object.freeze({ route: WINDOWS_CLAUDE_VERSION_ROUTE, rowId: input.rowId, file: input.file, identity }),
      isCurrent: () => true,
      env: input.env,
      deps: Object.freeze({
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        timeoutMs: remaining,
      }),
    });
  } catch {
    return UNSETTLED_COMPATIBILITY;
  }
  if (outcome === null || typeof outcome !== "object") return UNSETTLED_COMPATIBILITY;
  if (outcome.evidence === "unsettled") return UNSETTLED_COMPATIBILITY;
  if (outcome.evidence === "version") {
    const version = outcome.version;
    // The evidence must name the exact file and fingerprint this adapter probed.
    const verified = copyIdentity(outcome.identity);
    if (outcome.file !== input.file || verified === null || !sameWindowsIdentity(verified, identity)) {
      return declineClaudeInboxCompatibility("version-unavailable");
    }
    if (typeof version !== "string" || parseStableCliVersion(version) === undefined) {
      return declineClaudeInboxCompatibility("version-unrecognized");
    }
    if (!isClaudeInboxSupportedCliVersion(version)) return declineClaudeInboxCompatibility("version-unsupported");
    // The receipt carries the verified image, so the owner can refuse callbacks
    // for any other image the wrapper might later start by the same pathname.
    return Object.freeze({ compatibility: "verified", version, windowsImage: windowsImageOf(input.file, verified) });
  }
  if (outcome.evidence === "refused") {
    if (outcome.reason === "version-unrecognized") return declineClaudeInboxCompatibility("version-unrecognized");
    if (outcome.reason === "version-unsupported") return declineClaudeInboxCompatibility("version-unsupported");
    return declineClaudeInboxCompatibility("version-unavailable");
  }
  return UNSETTLED_COMPATIBILITY;
}
