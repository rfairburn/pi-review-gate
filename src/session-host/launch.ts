import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 as win32Path } from "node:path";
import {
  PI_AGENT_DIR_ENV,
  piAgentDir,
  reviewGateConfigCandidates,
  resolveConfigPathResolution,
} from "../config-path";
import {
  isSavedSessionAdmission,
  readSavedSessionHeader,
  SavedSessionAdmission,
  validateSavedSessionLocation,
} from "./saved-sessions";
import { SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV } from "./startup-request";

/**
 * Native standalone Pi launch preparation (alpha, backend descriptor stage).
 *
 * This module is the preparatory stage of the future native session host: it
 * resolves the real Pi CLI, validates the admitted native root or legacy
 * profile, and composes the exact spawn descriptor (file, argv, environment,
 * cwd) for one native Pi TUI session. Windows descriptors run the admitted
 * JavaScript CLI through the current Node host executable; POSIX descriptors
 * retain direct CLI/shebang execution. It deliberately does NOT spawn PTYs,
 * bootstrap the session-host protocol, or run any dependency setup:
 *
 * - The outer launcher owns the single DDGS setup (`scripts/ensure-ddgs.sh` /
 *   `ensureDdgs` in scripts/pi-review-gate-launcher.cjs) BEFORE any Node host
 *   process or session token exists, so no vendor-setup descendant can
 *   inherit authorization.
 * - The future host manager supplies the session-host bootstrap token
 *   immediately at the actual PTY spawn, never earlier; this preparation
 *   strips any inherited bootstrap so setup descendants can never carry it.
 * - Ordinary launcher behavior is unchanged. Native setup reuses the native
 *   agent directory and normal config/resource discovery, initializing only
 *   the ordinary zero-model review-gate default when genuinely absent; it
 *   never recopies native resources or skills. Legacy profile mode retains
 *   its isolated config and skill publication behavior. The disabled kill
 *   switch, provider environment, and tool-policy arguments are preserved.
 * - Runtime role authorization (`PI_REVIEW_GATE_RUNTIME_ROLE` /
 *   `PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG`) is an executor-child mechanism:
 *   a delegated worker's environment must never flow into this top-level
 *   native launch, so role input is rejected fail-closed (not merely
 *   stripped, which would silently launder a role context).
 *
 * The two stable exports are `resolveNativePi` and `prepareNativeLaunch`.
 */

/** Environment name of the future session-host bootstrap token (known literal until the protocol lands). */
export const SESSION_HOST_BOOTSTRAP_ENV = "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP";

/**
 * One-shot restoration sidecar for the direct native spawn: the descriptor
 * stores the user's ORIGINAL NODE_OPTIONS as `{ original: string | null }`
 * so the session-host preload compiled at
 * <root>/dist/src/session-host/bootstrap-preload.js can synchronously restore
 * (or delete) it — and delete this sidecar and the bootstrap token — before
 * Node's Pi CLI main runs. The sidecar is consumed by the preload only; it
 * never reaches the native worker/shell/MCP descendants.
 */
export const NODE_OPTIONS_RESTORE_ENV = "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE";

/** Upper bound for the serialized session-host NODE_OPTIONS restoration frame (UTF-8 bytes, the reporter's restore-frame cap). */
export const MAX_NATIVE_NODE_OPTIONS_BYTES = 8192;

/** Executor-role markers (src/index.ts, src/execution/adapters/pi-model.ts). Reject, never forward. */
export const RUNTIME_ROLE_ENV = "PI_REVIEW_GATE_RUNTIME_ROLE";
export const EXECUTOR_TOOL_CATALOG_ENV = "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG";

/** Executor settlement/quiescence authorization markers that must never persist past preparation. */
const SETTLEMENT_ENV_SUFFIXES = ["SECRET", "PATH", "SESSION", "CHILD"] as const;

/** The compiled session-host preload staged beside the reporter (primeReporterBootstrap). */
const BOOTSTRAP_PRELOAD_RELATIVE = ["session-host", "bootstrap-preload.js"] as const;

/** Pi 1.0.4 is the supported minimum for native standalone launches. */
const MINIMUM_PI_VERSION: readonly [number, number, number] = [1, 0, 4];

/** Upper bound for the `--version` probe output; anything larger is an anomaly, never dumped. */
export const VERSION_PROBE_MAX_BYTES = 8 * 1024;

/** Upper bound for the bounded `--version` probe window. */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Upper bound for a review-gate config file accepted for a native launch (a real config is a few KiB). */
export const MAX_NATIVE_CONFIG_BYTES = 1024 * 1024;

/** Upper bound for one shipped skill file copy. */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;

/** Reserved skills root used only by the legacy profile path. */
const PROFILE_SKILLS_DIRNAME = "skills";

/**
 * Shipped-skill publication map used only by legacy profiles, mirroring
 * SKILL_PUBLISH_PLAN in scripts/pi-review-gate.sh and
 * scripts/pi-review-gate-launcher.cjs (orchestrator SKILL.md plus its
 * recovery runbook, execution, and research). Publication targets stay the
 * Pi reserved namespace (pi-review-gate-*) inside the profile's own agent
 * directory: with PI_CODING_AGENT_DIR pointing at the profile, Pi discovers
 * `<agent-dir>/skills/`, so per-instance skills live per-instance. Sources
 * are relative to the package root; destinations to the profile skills root.
 */
export const NATIVE_SKILL_PUBLISH_PLAN: readonly {
  name: string;
  files: readonly { source: readonly string[]; destination: readonly string[] }[];
}[] = [
  {
    name: "pi-review-gate-orchestrator",
    files: [
      { source: ["skills", "pi-review-gate-orchestrator", "SKILL.md"], destination: ["SKILL.md"] },
      { source: ["skills", "pi-review-gate-orchestrator", "references", "recovery.md"], destination: ["references", "recovery.md"] },
    ],
  },
  {
    name: "pi-review-gate-execution",
    files: [{ source: ["skills", "pi-review-gate-execution", "SKILL.md"], destination: ["SKILL.md"] }],
  },
  {
    name: "pi-review-gate-research",
    files: [{ source: ["skills", "pi-review-gate-research", "SKILL.md"], destination: ["SKILL.md"] }],
  },
];

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableRegularFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate);
    // Actual caller access (X_OK), not merely an execute bit: a caller-owned
    // file with e.g. mode 0645 shows an execute bit yet is not executable by
    // the caller, and must never be selected over a usable PATH entry.
    if (!stats.isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows admits readable JS CLI files; the trusted host Node supplies execution. */
function isReadableRegularFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isAdmissiblePiFile(candidate: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? isReadableRegularFile(candidate)
    : isExecutableRegularFile(candidate);
}

function isExplicitExecutablePath(executable: string, platform: NodeJS.Platform): boolean {
  if (executable.includes("/")) return true;
  if (platform !== "win32") return false;
  // Windows path forms are filenames, never command strings: recognize drive
  // paths, UNC/rooted paths, and relative paths containing native separators.
  return win32Path.isAbsolute(executable) || /^[A-Za-z]:/.test(executable) || executable.includes("\\");
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/** Bounded first-bytes read (never a whole-file or directory scan; O_NONBLOCK, fstat-checked). */
function readHeadBytes(file: string, bytes: number): Buffer | undefined {
  try {
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return undefined; // special file: never probe it
      const head = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < head.length) {
        const bytesRead = readSync(fd, head, offset, head.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return head.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const NATIVE_BINARY_MAGICS: readonly Buffer[] = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64-bit little-endian
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]), // Mach-O 32-bit big-endian (on-disk order)
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O universal/fat
  Buffer.from([0x4d, 0x5a]), // PE (MZ)
];

const NODE_ENTRY_HEAD_BYTES = 512;

/**
 * Positive Node-entry shebang check on the bounded, fstat-checked first-line
 * head read. Exactly two forms establish a Node entry without parsing or
 * trusting anything else in the file:
 *
 * - `#!<interpreter-path>` whose basename is exactly `node` (no added flags),
 * - `#!<env-path> node` — `/usr/bin/env` style dispatch naming precisely the
 *   bare `node` argument (env flags like `-S`, or extra tokens, have no
 *   actual evidence and reject).
 *
 * A shell `-c node` re-execution or a fake `nodefoo` basename never matches;
 * any other shebang (opaque shell shims, exotic interpreters) rejects with a
 * generic, body-free diagnostic: an opaque shim's own startup helpers could
 * spawn descendants that inherit the bootstrap before exec reaches Node, the
 * same early-capability-leak class the policy protects against for user
 * preloads. A managed/custom install must pass its actual Node Pi CLI entry
 * file via the explicit executable option instead.
 */
function isNodeEntryShebang(head: Buffer): boolean {
  const lineEnd = head.indexOf(0x0a);
  if (lineEnd === -1 && head.length === NODE_ENTRY_HEAD_BYTES) return false; // incomplete bounded first line: no positive evidence
  const firstLine = (lineEnd === -1 ? head : head.subarray(0, lineEnd)).toString("utf8").trim();
  const match = firstLine.match(/^#![ \t]*(\S+)(?:[ \t]+(\S+))?[ \t]*$/);
  if (!match) return false;
  const [, interpreter, argumentMaybe] = match;
  const interpreterBasename = interpreter.slice(interpreter.lastIndexOf("/") + 1);
  // A direct Node interpreter is supported only with no extra shebang flags;
  // env dispatch is supported only for the exact single argument `node`.
  // `env -S`, flags, and additional arguments have no positive evidence here.
  if (interpreterBasename === "node") return argumentMaybe === undefined;
  if (interpreterBasename === "env") return argumentMaybe === "node";
  return false;
}

/**
 * Alpha executable policy for direct native launches: the resolved pi file
 * must be a POSITIVE Node ENTRY (see isNodeEntryShebang) — the NODE_OPTIONS
 * `--require` staging reaches a real Node process only when exec reaches Node
 * with no intermediate helpers. The file body is never read or dumped (a
 * bounded, non-blocking, fstat-checked head read only), and the probe runs
 * only after this check. An unreadable/empty head and known native binary
 * magics get their precise diagnostics; every other first line rejects with
 * the generic Node-entry failure (opaque shell shims included). The
 * explicitly trusted managed shim is not special-cased: pass its actual Node
 * entry file explicitly instead.
 */
function rejectNonNodeCliExecutable(file: string): void {
  const head = readHeadBytes(file, NODE_ENTRY_HEAD_BYTES);
  if (head === undefined || head.length < 2) {
    throw new Error(
      `pi-review-gate: the native pi executable is unreadable or empty; refusing to prepare a launch around it: ${file}`,
    );
  }
  if (head[0] === 0x23 && head[1] === 0x21) {
    // '#!': only a positive Node-entry interpreter line is supported
    // (see isNodeEntryShebang); every other first line — opaque shell shims,
    // env flags, exotic interpreters — rejects before any probe and without
    // reading or dumping the file body.
    if (!isNodeEntryShebang(head)) {
      throw new Error(
        `pi-review-gate: ${file} does not start with a positive Node-entry shebang (the bare Node interpreter or '#!/usr/bin/env node'); this alpha stages the session-host preload only when exec reaches Node directly — pass the actual Node Pi CLI entry file via the explicit executable option instead`,
      );
    }
    return;
  }
  if (NATIVE_BINARY_MAGICS.some((magic) => head.subarray(0, magic.length).equals(magic))) {
    throw new Error(
      `pi-review-gate: ${file} is a native/SEA binary; this alpha supports only the standard Node-based Pi CLI (npm install -g @earendil-works/pi)`,
    );
  }
  throw new Error(
    `pi-review-gate: ${file} does not start with a positive Node-entry shebang; this alpha stages the session-host preload only around the standard Node-based Pi CLI entry`,
  );
}

/**
 * Quote a NODE_OPTIONS `--require` value the way Node's own NODE_OPTIONS
 * parser expects: the clause is wrapped in double quotes with backslashes and
 * double quotes escaped with backslashes, so a whitespace- or quote-bearing
 * path stays a single argument for that parser (no shell is ever involved).
 */
function quoteNodeOptionsRequire(path: string): string {
  return `--require="${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Control characters can never cross the NODE_OPTIONS parser or env safely. */
function containsEnvControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** Minimal typed view of the launcher helper's rename helper (single shared implementation). */
interface RenameOutcome {
  published: boolean;
  attempts: number;
  lastError?: { code?: string; message?: string };
}

interface LauncherHelper {
  renameIntoPlaceWithContentionRetry(
    rename: () => void,
    options?: { destination?: string },
  ): RenameOutcome;
}

let cachedLauncherHelper: LauncherHelper | undefined;

/**
 * Load the shipped launcher helper lazily (its CLI entry point is guarded by
 * `require.main === module`, so requiring it only defines the helpers). Both
 * shipped layouts keep scripts/ beside the compiled extension: a source
 * checkout's dist/src/session-host and a packaged dist/src/session-host both
 * find scripts/ by walking upward to the enclosing package root — which also
 * covers the dist-test test tree.
 */
function loadLauncherHelper(): LauncherHelper {
  if (cachedLauncherHelper) return cachedLauncherHelper;
  let helperModule: unknown;
  for (let dir = __dirname; ; dir = dirname(dir)) {
    const candidate = join(dir, "scripts", "pi-review-gate-launcher.cjs");
    if (isRegularFile(candidate)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      helperModule = require(candidate);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("pi-review-gate: the shipped launcher helper scripts/pi-review-gate-launcher.cjs was not found beside the compiled extension");
    }
  }
  const helper = helperModule as LauncherHelper;
  if (typeof helper.renameIntoPlaceWithContentionRetry !== "function") {
    throw new Error("pi-review-gate: the shipped launcher helper is missing renameIntoPlaceWithContentionRetry");
  }
  cachedLauncherHelper = helper;
  return helper;
}

/** Minimal typed view of the shared startup-options admission helper (single shared implementation). */
interface SessionHostStartupOptionsHelper {
  assertSessionHostStartupOptions(args: readonly string[], env?: NodeJS.ProcessEnv): void;
  composeFreshSessionSpawnArgs(args: readonly string[], title: string): string[];
}

let cachedStartupOptionsHelper: SessionHostStartupOptionsHelper | undefined;

/**
 * Load the shipped shared startup-options helper lazily (its module is pure:
 * requiring it defines constants and one function, with no fs, process/env,
 * PTY, or setup side effects). Every declared compiled layout places this
 * module at <packageRoot>/dist/src/session-host (source checkout),
 * <packageRoot>/dist-test/src/session-host (compiled tests), or the same dist
 * path inside an installed package, so the OWN package root is exactly three
 * levels up and the helper must come from that package's scripts/ directory.
 * There is deliberately no ancestor fallback: a missing owned helper rejects
 * fail-closed with a bounded diagnostic instead of loading an unrelated
 * parent/root/tmp script.
 */
function loadStartupOptionsHelper(): SessionHostStartupOptionsHelper {
  if (cachedStartupOptionsHelper) return cachedStartupOptionsHelper;
  const candidate = join(__dirname, "..", "..", "..", "scripts", "session-host-startup-options.cjs");
  // Diagnostics are wrapped by prepareNativeLaunch with the pi-review-gate
  // prefix; keep them bounded (fixed filename, no path).
  if (!isRegularFile(candidate)) {
    throw new Error("the shared session host startup options helper scripts/session-host-startup-options.cjs is missing from the own compiled package");
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const helperModule: unknown = require(candidate);
  const helper = helperModule as SessionHostStartupOptionsHelper;
  if (typeof helper.assertSessionHostStartupOptions !== "function"
    || typeof helper.composeFreshSessionSpawnArgs !== "function") {
    throw new Error("the shared session host startup options helper is missing a required startup-options operation");
  }
  cachedStartupOptionsHelper = helper;
  return helper;
}

/** Compose a fresh child's inherited native settings without inheriting parent messages or @files. */
export function composeFreshSessionSpawnArgs(args: readonly string[], title: string): string[] {
  return loadStartupOptionsHelper().composeFreshSessionSpawnArgs(args, title);
}

function unsupportedPlatformDiagnostic(platform: string): string {
  return `pi-review-gate: native standalone Pi launch preparation supports macOS/Linux direct CLI and Windows Node-host descriptor preparation only; ${platform} must launch pi through the standard pi-review-gate wrapper`;
}

function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(unsupportedPlatformDiagnostic(platform));
  }
}

/** Windows has case-insensitive environment names; these stale capabilities are dropped in every casing. */
function isStaleHostCapabilityName(name: string): boolean {
  if (name === SESSION_HOST_BOOTSTRAP_ENV || name === NODE_OPTIONS_RESTORE_ENV
    || name === SESSION_HOST_STARTUP_REQUEST_ENV || name === SESSION_HOST_TITLE_COLUMNS_ENV) return true;
  return SETTLEMENT_ENV_SUFFIXES.some((suffix) =>
    name === `PI_REVIEW_GATE_SETTLEMENT_${suffix}` || name === `PI_REVIEW_GATE_QUIESCENCE_${suffix}`,
  );
}

/** Snapshot Windows env names case-insensitively without silently choosing conflicting values. */
export function snapshotNativeEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...source }; // POSIX environment names remain case-sensitive.

  const valuesByName = new Map<string, (string | undefined)[]>();
  for (const [rawName, value] of Object.entries(source)) {
    const name = rawName.toUpperCase();
    const values = valuesByName.get(name) ?? [];
    values.push(value);
    valuesByName.set(name, values);
  }

  const snapshot: NodeJS.ProcessEnv = {};
  for (const [name, values] of valuesByName) {
    if (isStaleHostCapabilityName(name)) continue;
    if (name === RUNTIME_ROLE_ENV || name === EXECUTOR_TOOL_CATALOG_ENV) {
      // Preserve any nonempty spelling for the ordinary fail-closed role
      // rejection below; never let an empty alias shadow a worker marker.
      snapshot[name] = values.find((value) => value !== undefined && value.length > 0) ?? values[0];
      continue;
    }
    const [value, ...aliases] = values;
    if (aliases.some((alias) => alias !== value)) {
      throw new Error(
        "pi-review-gate: conflicting case variants in the Windows environment; refusing to select one value.",
      );
    }
    // Uppercase keys give the rest of this module one canonical spelling for
    // PATH, NODE_OPTIONS, native Pi settings, and unrelated provider values.
    snapshot[name] = value;
  }
  return snapshot;
}

/** Reject real worker authorization, then remove stale host-only capabilities before any probe/child. */
function rejectAndStripInheritedHostCapabilities(env: NodeJS.ProcessEnv): void {
  if (env[RUNTIME_ROLE_ENV]) {
    throw new Error(
      `pi-review-gate: refusing to prepare a native launch while ${RUNTIME_ROLE_ENV} is set; runtime role authorization comes only from the delegated execution adapter.`,
    );
  }
  if (env[EXECUTOR_TOOL_CATALOG_ENV]) {
    throw new Error(
      `pi-review-gate: refusing to prepare a native launch while ${EXECUTOR_TOOL_CATALOG_ENV} is set; executor tool catalogs belong to executor-role children only.`,
    );
  }
  delete env[RUNTIME_ROLE_ENV];
  delete env[EXECUTOR_TOOL_CATALOG_ENV];
  delete env[SESSION_HOST_BOOTSTRAP_ENV];
  delete env[SESSION_HOST_STARTUP_REQUEST_ENV];
  delete env[SESSION_HOST_TITLE_COLUMNS_ENV];
  delete env[NODE_OPTIONS_RESTORE_ENV];
  for (const suffix of SETTLEMENT_ENV_SUFFIXES) delete env[`PI_REVIEW_GATE_SETTLEMENT_${suffix}`];
  for (const suffix of SETTLEMENT_ENV_SUFFIXES) delete env[`PI_REVIEW_GATE_QUIESCENCE_${suffix}`];
}

/** Numeric component-wise semantic-version comparison: negative/zero/positive. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < right.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index];
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Strict version extraction from the bounded probe output. Only the known
 * official `--version` formats parse: a bare stable triple (`1.0.4`), a
 * v-prefixed one (`v1.0.4`), or the CLI-prefixed form (`pi 1.0.4`) as stdout,
 * with the whole (trimmed) stdout exactly one such value — stderr is never a
 * parse source. Anything else — noise,
 * multiple/embedded numbers (e.g. a Node runtime banner like
 * `node 24.1.0\npi 1.0.3`, where a loose first-number scan would wrongly
 * accept 24.1.0), a pre-release suffix (an unstable build can never count as
 * a stable floor), build metadata, or empty output — returns null and the
 * probe fails closed.
 */
function extractPiVersion(output: string): string | null {
  const match = output.trim().match(/^(?:pi\s+)?v?(\d+\.\d+\.\d+)$/);
  return match?.[1] ?? null;
}

/**
 * Resolve the real native Pi CLI executable and probe its exact version.
 *
 * - Default `pi`: a narrow PATH filename lookup (env override supported), the
 *   first PATH entry holding an admissible regular file with that exact
 *   name (readable on Windows, executable on POSIX), canonically resolved to
 *   an absolute file so the descriptor is cwd-independent. Windows splits
 *   PATH on `;`; POSIX uses `:`. Shell aliases and command strings are never
 *   consulted (aliases are a shell feature a child cannot see), and a bare name that
 *   contains whitespace or shell metacharacters is rejected — an exact
 *   filename is required, not a shell command line. No global directory or
 *   process scan happens: PATH filename checks only, never a home or
 *   Terraform recursion.
 * - An explicit executable path is honored for installed managed or custom Pi
 *   builds: it is validated and resolved to an absolute regular file exactly
 *   as a whole filename (POSIX also requires X_OK; Windows requires read
 *   access because Node executes the JS file). Drive/UNC/backslash Windows
 *   paths and spaces/quotes/parentheses in real paths are filename input, not
 *   shell command strings; invalid paths fail file validation and are never
 *   executed.
 *   A positive Node-entry shebang is required and the path is used as-is:
 *   this module never parses shims or invents an implementation path behind
 *   them.
 *
 * The chosen file is probed with `--version` (bounded 10 s window, bounded
 * 8 KiB output, no shell; Windows runs it as `process.execPath <file>`):
 * builds older than Pi 1.0.4, unparseable versions,
 * exit failures, timeouts, and oversized output fail closed with a bounded
 * safe diagnostic that never includes the command output itself. There is no
 * old-compatibility scaffold: unsupported Pi versions must fail.
 *
 * POSIX retains direct executable probing; Windows probes the admitted JS
 * entry through the running Node host. Other platforms fail closed.
 */
export function resolveNativePi(
  options: { executable?: string; env?: NodeJS.ProcessEnv } = {},
): { file: string; version: string } {
  const platform = process.platform;
  assertSupportedPlatform(platform);
  // Worker authorization is rejected, never laundered, before any child
  // probe. Stale host/settlement capabilities are stripped from the probe
  // environment while ordinary NODE_OPTIONS and provider settings survive.
  const env = snapshotNativeEnvironment(options.env ?? process.env, platform);
  rejectAndStripInheritedHostCapabilities(env);
  const executable = options.executable ?? "pi";

  let file: string;
  if (isExplicitExecutablePath(executable, platform)) {
    // An explicit path is a complete filename for installed managed or custom
    // Pi builds: it is validated and canonicalized as a whole (no shell is
    // ever involved, so spaces, quotes, or parentheses in the path are
    // legitimate and never command-string input). Windows drive, UNC, and
    // backslash-bearing paths reach this path branch without being parsed as
    // shell syntax.
    const candidate = isAbsolute(executable) || (platform === "win32" && win32Path.isAbsolute(executable))
      ? executable
      : resolve(process.cwd(), executable);
    if (!isAdmissiblePiFile(candidate, platform)) {
      const requirement = platform === "win32" ? "a readable" : "an executable";
      throw new Error(
        `pi-review-gate: the configured native pi executable is not ${requirement} regular file (no shell command is ever executed; the path cannot be resolved): ${candidate}`,
      );
    }
    file = realpathSync(candidate);
  } else {
    // A bare name must be a single filename: shell command strings, aliases,
    // and metacharacters are rejected up front (aliases are a shell feature a
    // child cannot see, and a whitespace-bearing "name" is a command line,
    // never an executable).
    if (/\s/.test(executable) || /[|&;$<>()`\\'"]/.test(executable)) {
      throw new Error(
        `pi-review-gate: the native pi executable must be a single exact filename, not a shell command string: ${JSON.stringify(executable)}`,
      );
    }
    const found = findOnPath(executable, env.PATH ?? "", platform);
    if (!found) {
      throw new Error(
        `pi-review-gate: the native pi executable "${executable}" was not found on PATH; install Pi (npm install -g @earendil-works/pi) or pass an explicit executable path.`,
      );
    }
    file = found;
  }

  // The alpha strategy stages the session-host preload through NODE_OPTIONS
  // `--require`, which only the standard Node-based Pi CLI honors; a native
  // or SEA binary would silently ignore it, so it is rejected up front.
  rejectNonNodeCliExecutable(file);

  const version = probePiVersion(file, env, platform);
  return { file, version };
}

/** First PATH entry holding an admissible regular file with the exact name, realpathed. */
function findOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): string | undefined {
  for (const rawEntry of pathEnv.split(pathDelimiter(platform))) {
    if (!rawEntry) continue; // an empty PATH entry would mean the current directory: never searched
    const candidate = join(rawEntry, name);
    if (!isAdmissiblePiFile(candidate, platform)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Bounded --version probe with fail-closed diagnostics that never dump output. */
function probePiVersion(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  let result;
  try {
    const command = platform === "win32" ? process.execPath : file;
    const args = platform === "win32" ? [file, "--version"] : ["--version"];
    result = spawnSync(command, args, {
      env,
      shell: false,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      // SIGKILL is non-ignorable: an executable (or wrapper) that handles or
      // ignores SIGTERM can otherwise block this probe far past the bound.
      // Empirically the bounded wait returns once the direct child is
      // SIGKILLed, even when a descendant briefly holds the output pipes.
      killSignal: "SIGKILL",
      maxBuffer: VERSION_PROBE_MAX_BYTES,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    // spawnSync validation errors may include rejected environment values
    // (including NODE_OPTIONS/provider credentials); diagnostics are path-only.
    throw new Error(`pi-review-gate: the native pi version probe could not run: ${file}`);
  }
  if (result.error) {
    const errno = (result.error as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      throw new Error(`pi-review-gate: the native pi executable is missing: ${file}`);
    }
    if (errno === "ENOBUFS") {
      throw new Error(
        `pi-review-gate: the native pi --version output exceeded the ${Math.floor(VERSION_PROBE_MAX_BYTES / 1024)} KiB probe limit; refusing to parse it: ${file}`,
      );
    }
    if (errno === "ETIMEDOUT") {
      throw new Error(
        `pi-review-gate: the native pi version probe did not answer within ${Math.round(VERSION_PROBE_TIMEOUT_MS / 1000)}s; refusing to launch ${file}`,
      );
    }
    const detail = errno ? ` (${String(errno)})` : "";
    throw new Error(`pi-review-gate: the native pi version probe failed${detail}: ${file}`);
  }
  if (result.signal) {
    throw new Error(
      `pi-review-gate: the native pi version probe did not answer within ${Math.round(VERSION_PROBE_TIMEOUT_MS / 1000)}s (terminated with signal ${result.signal}); refusing to launch ${file}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`pi-review-gate: the native pi version probe exited with status ${String(result.status)}: ${file}`);
  }
  // Only the official STDOUT format is parsed; there is deliberately no
  // stderr rescue: a stale/noisy stdout (e.g. an older version on stdout and
  // a valid-looking newer one on stderr) identifies an unsupported CLI and
  // must fail closed, and neither stream is ever echoed.
  const parsed = extractPiVersion(`${result.stdout ?? ""}`);
  if (!parsed) {
    throw new Error(
      `pi-review-gate: the native pi --version stdout is not an exact official version format; refusing to launch from ${file}`,
    );
  }
  const components = parsed.split(".").map((part) => Number(part));
  if (compareVersions(components, MINIMUM_PI_VERSION) < 0) {
    const [minMajor, minMinor, minPatch] = MINIMUM_PI_VERSION;
    throw new Error(
      `pi-review-gate: native standalone launch requires Pi ${minMajor}.${minMinor}.${minPatch} or newer; found ${parsed} at ${file}`,
    );
  }
  return parsed;
}

/** A prepared direct native Pi launch: everything the future host manager needs to spawn one session. */
export interface NativeLaunchDescriptor {
  /** POSIX: canonical Pi CLI; Windows: the current Node host process executable. */
  file: string;
  /** Full native argv: Windows starts with the canonical Pi CLI script, then extensions and forwarded args. */
  args: string[];
  /** Cloned, sanitized environment; the caller's env is never mutated. */
  env: NodeJS.ProcessEnv;
  /** Canonical working directory: the per-instance workspace. */
  cwd: string;
}

export interface NativeLaunchOptions {
  /**
   * Select the ordinary shared Pi agent directory instead of a legacy private
   * profile. Production Main must pass `true`; omission remains legacy-only
   * for internal callers and existing isolated-profile tests.
   */
  nativeSetup?: boolean;
  /** Already-built gate package root (owning dist/src/index.js). */
  packageRoot: string;
  /** Admitted native agent directory or legacy profile directory, as selected by nativeSetup. */
  agentDir: string;
  /** Per-instance workspace directory the native Pi session runs in. */
  workspace: string;
  /** Pi executable (already resolved and version-probed by resolveNativePi). */
  piExecutable: string;
  /**
   * Native pi arguments, forwarded byte-for-byte in order (--scheduler is
   * consumed as the wrapper does). Parent startup session overrides
   * (--continue/-c, --resume/-r, --session[=v], --session-id[=v], --fork[=v],
   * --session-dir[=v], --no-session) reject fail-closed: startup selection
   * cannot attach a child to a parent/live conversation. Native session
   * storage itself remains at Pi's ordinary configured location.
   */
  args?: readonly string[];
  /**
   * Deliberate per-child saved-session selection: an admission receipt minted
   * by admitSavedSession (src/session-host/saved-sessions.ts) from the
   * read-only native saved-conversation catalog. Only `nativeSetup: true`
   * launches accept it (legacy profile mode rejects it so no cross-setup
   * copies happen). The receipt is revalidated against the accepted native
   * agent directory and live file identity (dev/ino plus first-line header
   * id/cwd) BEFORE spawn, then composed as the exact `--session <file>`
   * option in the argument position the native CLI recognizes before any
   * forwarded `--`. Caller args can never carry `--session`: the startup
   * options guard rejects it first, and no env path admits a session.
   */
  savedSession?: SavedSessionAdmission;
  /** Environment to clone (defaults to process.env); never mutated. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Prepare one direct native Pi session descriptor with ordinary
 * standalone-policy gate semantics and no inherited status capability:
 *
 * - Environment is a clone; the caller's env is never mutated. Inherited
 *   status authorization is removed or rejected fail-closed:
 *   `PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP` is stripped (the future host
 *   manager supplies it only at the actual PTY spawn), executor/worker role
 *   input (`PI_REVIEW_GATE_RUNTIME_ROLE`, `PI_REVIEW_GATE_EXECUTOR_TOOL_
 *   CATALOG`) is rejected outright, and executor settlement/quiescence
 *   authorization markers are stripped so no delegated-worker token can
 *   outlive preparation.
 * - Legacy profile mode pins `PI_CODING_AGENT_DIR` and `PI_REVIEW_GATE_CONFIG`
 *   to the admitted private profile. With `nativeSetup: true`, the admitted
 *   directory must equal Pi's native environment-resolved agent directory;
 *   the canonical root is passed to Pi, while `PI_REVIEW_GATE_CONFIG` and
 *   all ordinary native config fallback behavior are left untouched. The
 *   registry initializes the ordinary zero-model default only when no
 *   explicit override, native config, or compatibility config exists, and
 *   never overwrites an existing file.
 * - Legacy profile mode applies the alpha `PI_IMAGE_PROTOCOL=none` and
 *   `PI_REVIEW_GATE_CODEMODE_DEFAULT=1` defaults. Native mode supplies those
 *   only when absent, preserving explicit native environment choices. The
 *   `PI_REVIEW_GATE_DISABLED` kill switch, provider environment, and inherited
 *   tool filters remain intact. Native arguments are forwarded byte-for-byte
 *   except `--scheduler`; native mode preserves an inherited scheduler value
 *   unless that flag explicitly enables it. Startup session-selection args
 *   (see scripts/session-host-startup-options.cjs) still reject before any
 *   filesystem mutation, while native `PI_CODING_AGENT_SESSION_DIR` remains
 *   available as ordinary shared Pi setup. The one deliberate exception is
 *   the per-child `savedSession` admission receipt (native mode only): it is
 *   revalidated against the accepted agent directory and live file identity
 *   before spawn and composed as the exact `--session <file>` option before
 *   any forwarded `--`; legacy profile mode rejects it.
 * - The user's ORIGINAL NODE_OPTIONS is preserved exactly and handed to the
 *   session-host preload (compiled at
 *   <root>/dist/src/session-host/bootstrap-preload.js) through the one-shot
 *   `PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE` sidecar; the
 *   descriptor NODE_OPTIONS PREPENDS a safely Node-quoted
 *   `--require=<bootstrap-preload.js>` clause before the original value, so
 *   our auth-cleaning preload always runs before any `--require` preload the
 *   original value stages (whose startup could spawn descendants first). The preload synchronously
 *   restores (or deletes) the original NODE_OPTIONS and deletes this sidecar
 *   and the bootstrap token before Node's Pi CLI main runs, so nothing but
 *   that own sticky metadata propagates to the native worker/shell/MCP
 *   descendants. Unbounded values and control-character injection reject
 *   fail-closed; option contents are never dumped in diagnostics.
 * - The compiled gate extension (index.js), session-host reporter, and the
 *   bootstrap preload must all already exist in the package root before any
 *   validation or publication runs. The argv loads the reporter extension
 *   FIRST, then the gate extension, then the native arguments.
 * - Legacy profile mode refreshes the standard shipped skills into its
 *   reserved `pi-review-gate-*` directories. Native setup does not republish
 *   skills: Pi and the ordinary launcher discover the user's existing native
 *   skill locations naturally.
 *
 * POSIX descriptors execute the validated CLI directly. Windows descriptors
 * run the same validated JS CLI through process.execPath, with its exact
 * canonical path as argv[0]; unsupported platforms get a clear diagnostic.
 */
export function prepareNativeLaunch(options: NativeLaunchOptions): NativeLaunchDescriptor {
  const platform = process.platform;
  assertSupportedPlatform(platform);
  // Snapshot Windows environment names case-insensitively before either the
  // parent startup preflight or later role/capability checks.
  const env = snapshotNativeEnvironment(options.env ?? process.env, platform);

  // Reject parent startup session arguments before any filesystem mutation,
  // profile work, or bootstrap injection. Saved-session selection remains an
  // ordinary native Pi operation; this host does not attach a child to a live
  // conversation. Native setup may preserve Pi's configured session storage
  // directory, so omit only that env field from the legacy preflight check.
  // The caller env is never mutated.
  try {
    const startupEnv = { ...env };
    if (options.nativeSetup) delete startupEnv.PI_CODING_AGENT_SESSION_DIR;
    loadStartupOptionsHelper().assertSessionHostStartupOptions(options.args ?? [], startupEnv);
  } catch (error) {
    throw new Error(`pi-review-gate: ${error instanceof Error ? error.message : "invalid session host startup options"}`);
  }

  // Explicit worker/executor authorization is rejected rather than laundered;
  // stale host capabilities and settlement markers are then stripped.
  rejectAndStripInheritedHostCapabilities(env);

  const packageRoot = canonicalPackageRoot(options.packageRoot);

  const indexExtension = join(packageRoot, "dist", "src", "index.js");
  const reporterExtension = join(packageRoot, "dist", "src", "session-host", "reporter.js");
  const bootstrapPreload = join(packageRoot, "dist", "src", ...BOOTSTRAP_PRELOAD_RELATIVE);
  // Required compiled files exist before any descriptor is composed. The
  // session-host preload (compiled bootstrap-preload.js) is required here as
  // a file for descriptor tests; its early-env behavior itself is owned by
  // the reporter/protocol sibling, never re-implemented in this module.
  validateCompiledExtensionFiles([indexExtension, reporterExtension, bootstrapPreload]);

  const agentDir = canonicalAdmittedAgentDir(options.agentDir);
  const workspace = canonicalWorkspace(options.workspace);
  const piExecutable = validatePiExecutable(options.piExecutable, platform);

  // Deliberate per-child saved-session selection: validated BEFORE any config
  // validation, publication, or descriptor composition. Legacy profile mode
  // rejects it outright (no cross-setup copies); native mode revalidates the
  // branded receipt against this launch's accepted agent directory, live file
  // identity, and the admitted workspace before spawn.
  let savedSessionFile: string | undefined;
  if (options.savedSession !== undefined) {
    if (!options.nativeSetup) {
      throw new Error(
        "pi-review-gate: legacy profile mode does not accept a native saved-session selection",
      );
    }
    if (!isSavedSessionAdmission(options.savedSession)) {
      throw new Error(
        "pi-review-gate: the saved-session selection is not a valid admission receipt; select from the current saved-conversation catalog",
      );
    }
    if (options.savedSession.agentDir !== agentDir) {
      throw new Error(
        "pi-review-gate: the saved-session admission belongs to a different native agent directory; re-select from this root's catalog",
      );
    }
    savedSessionFile = revalidateSavedSessionAdmission(options.savedSession, agentDir, workspace);
  }

  if (options.nativeSetup) {
    if (canonicalNativeAgentDirFromEnv(env) !== agentDir) {
      throw new Error(
        `pi-review-gate: native setup agent directory does not match the directory resolved from PI_CODING_AGENT_DIR: ${agentDir}`,
      );
    }
    validateNativeResolvedConfig(env, agentDir, workspace);
  }
  const configPath = options.nativeSetup ? undefined : validateProfileConfig(agentDir);

  // The wrapper-only --scheduler flag is consumed. Legacy profiles clear a
  // stale inherited scheduler value; native setup otherwise preserves the
  // user's existing native environment. All other arguments are forwarded
  // byte-for-byte, in order, with no tool-policy rewrite.
  let schedulerEnabled = false;
  const forwardedArgs: string[] = [];
  for (const arg of options.args ?? []) {
    if (arg === "--scheduler") schedulerEnabled = true;
    else forwardedArgs.push(arg);
  }
  if (!options.nativeSetup) delete env.PI_REVIEW_GATE_SCHEDULER;
  if (schedulerEnabled) env.PI_REVIEW_GATE_SCHEDULER = "1";

  // Pin the canonical shared root so a relative PI_CODING_AGENT_DIR cannot
  // resolve differently after the child changes cwd to its workspace.
  env.PI_CODING_AGENT_DIR = agentDir;
  if (!options.nativeSetup) {
    env.PI_REVIEW_GATE_CONFIG = configPath;
    env.PI_IMAGE_PROTOCOL = "none";
    env.PI_REVIEW_GATE_CODEMODE_DEFAULT = "1";
  } else {
    // Native mode preserves every user choice and supplies only ordinary
    // defaults that are truly absent (an explicit empty value is intentional).
    if (env.PI_IMAGE_PROTOCOL === undefined) env.PI_IMAGE_PROTOCOL = "none";
    if (env.PI_REVIEW_GATE_CODEMODE_DEFAULT === undefined) env.PI_REVIEW_GATE_CODEMODE_DEFAULT = "1";
  }

  // NODE_OPTIONS: the preload require clause is PREPENDED before the user's
  // ORIGINAL value (which is preserved exactly and restored synchronously by
  // the session-host preload before Pi's main runs, via the one-shot
  // restoration sidecar). Order is load-bearing: our preload must run before
  // any `--require` preload the original value may stage, since a user
  // preload's startup can spawn descendants first. This is also why the
  // reporter extension loads FIRST in the argv below: the preload env is
  // already consumed there, so the reporter also observes the gate extension's
  // SessionStart widget updates before an initially-false known state is read.
  const originalNodeOptions = env.NODE_OPTIONS ?? null;
  if (originalNodeOptions !== null) {
    if (containsEnvControlCharacter(originalNodeOptions)) {
      throw new Error(
        "pi-review-gate: the inherited NODE_OPTIONS contains control characters and cannot be prepared for a native launch",
      );
    }
  }
  const preloadRequire = quoteNodeOptionsRequire(bootstrapPreload);
  if (containsEnvControlCharacter(bootstrapPreload)) {
    throw new Error(
      `pi-review-gate: the compiled preload path contains control characters and cannot be staged for the native launch: ${bootstrapPreload}`,
    );
  }
  delete env[NODE_OPTIONS_RESTORE_ENV]; // one-shot: never inherited, only rewritten whole here
  env[NODE_OPTIONS_RESTORE_ENV] = JSON.stringify({ original: originalNodeOptions });
  // The bound covers the SERIALIZED restoration frame in real UTF-8 bytes
  // (quoting and escaping can inflate it well past the original's plain byte
  // count) and must fit the reporter's 8 KiB restore cap exactly, so the
  // preload can always restore the original environment. Oversized frames
  // reject without echoing any option content.
  if (Buffer.byteLength(env[NODE_OPTIONS_RESTORE_ENV], "utf8") > MAX_NATIVE_NODE_OPTIONS_BYTES) {
    throw new Error(
      `pi-review-gate: the inherited NODE_OPTIONS restoration frame exceeds the ${MAX_NATIVE_NODE_OPTIONS_BYTES}-Byte (UTF-8) restore cap; refusing to prepare the native launch`,
    );
  }
  env.NODE_OPTIONS = originalNodeOptions === null ? preloadRequire : `${preloadRequire} ${originalNodeOptions}`;

  if (!options.nativeSetup) {
    refreshNativeProfileSkills(packageRoot, join(agentDir, PROFILE_SKILLS_DIRNAME));
  }

  return {
    file: platform === "win32" ? process.execPath : piExecutable,
    // On Windows Node receives the exact canonical public CLI as its first
    // argument; it is never launched through cmd.exe or a shell. POSIX keeps
    // the direct executable/shebang descriptor. The reporter extension loads
    // first: its preload requirement is consumed from NODE_OPTIONS before the
    // gate extension factory runs, and it can observe SessionStart updates.
    // The authorized `--session <file>` pair is composed AFTER the complete extension pairs
    // and BEFORE any ordinary caller args: that position is always an option
    // position for the native parser, so a caller arg that merely LOOKS like
    // a separator (e.g. `--model --`) can never consume or shadow it. Native
    // args follow byte-for-byte.
    args: [
      ...(platform === "win32" ? [piExecutable] : []),
      "--extension", reporterExtension,
      "--extension", indexExtension,
      ...(savedSessionFile !== undefined ? ["--session", savedSessionFile] : []),
      ...forwardedArgs,
    ],
    env,
    cwd: workspace,
  };
}

/** Require a real, canonical package root that owns the compiled gate extension. */
function canonicalPackageRoot(packageRoot: string): string {
  if (!isAbsolute(packageRoot)) {
    throw new Error(`pi-review-gate: the native launch package root must be an absolute path: ${packageRoot}`);
  }
  if (!isDirectory(packageRoot)) {
    throw new Error(`pi-review-gate: the native launch package root is not a directory: ${packageRoot}`);
  }
  return realpathSync(packageRoot);
}

/** Compiled extension files must already exist; preparation never composes a stale descriptor. */
function validateCompiledExtensionFiles(compiledFiles: readonly string[]): void {
  for (const compiled of compiledFiles) {
    if (!isRegularFile(compiled)) {
      throw new Error(`pi-review-gate: the native launch requires a compiled extension file that is missing: ${compiled}`);
    }
  }
}

/** Validate the admitted native or legacy agent directory: absolute, existing, and canonical. */
function canonicalAdmittedAgentDir(agentDir: string): string {
  if (!isAbsolute(agentDir)) {
    throw new Error(`pi-review-gate: the profile agent directory must be an absolute path: ${agentDir}`);
  }
  if (!isDirectory(agentDir)) {
    throw new Error(
      `pi-review-gate: the agent directory does not exist; the selected registry owns its setup: ${agentDir}`,
    );
  }
  return realpathSync(agentDir);
}

/** Resolve Pi-native path defaults from the same explicit child environment snapshot. */
function nativeConfigPathResolution(env: NodeJS.ProcessEnv): ReturnType<typeof resolveConfigPathResolution> {
  const homeDir = process.platform === "win32"
    ? env.USERPROFILE ?? env.HOME
    : env.HOME;
  return resolveConfigPathResolution(homeDir === undefined ? {} : { homeDir });
}

/** Resolve the common native Pi root from the same explicit child environment snapshot. */
function canonicalNativeAgentDirFromEnv(env: NodeJS.ProcessEnv): string {
  const path = resolve(piAgentDir(env, nativeConfigPathResolution(env)));
  if (!isDirectory(path)) {
    throw new Error(`pi-review-gate: the native Pi agent directory resolved from PI_CODING_AGENT_DIR is not a directory: ${path}`);
  }
  return realpathSync(path);
}

/** Validate only bounded regular-file access; native Pi retains JSON recovery and warning behavior. */
function validateNativeResolvedConfig(env: NodeJS.ProcessEnv, agentDir: string, workspace: string): void {
  const explicit = env.PI_REVIEW_GATE_CONFIG;
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(workspace, explicit);
    if (nativeConfigPathExists(path)) validateNativeConfigFile(path);
    return;
  }
  const configEnv = { ...env, [PI_AGENT_DIR_ENV]: agentDir };
  for (const candidate of reviewGateConfigCandidates(configEnv, nativeConfigPathResolution(env))) {
    if (nativeConfigPathExists(candidate)) {
      validateNativeConfigFile(candidate);
      return;
    }
  }
}

function nativeConfigPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw new Error(`pi-review-gate: the native review-gate config path could not be inspected: ${path}`);
  }
}

/** Bounded nonblocking check that never parses, rewrites, or logs native config bytes. */
function validateNativeConfigFile(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    throw new Error(`pi-review-gate: the native review-gate config is present but not a readable regular file: ${path}`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error(`pi-review-gate: the native review-gate config is not a regular file: ${path}`);
    }
    if (stats.size > MAX_NATIVE_CONFIG_BYTES) {
      throw new Error(`pi-review-gate: the native review-gate config exceeds the ${MAX_NATIVE_CONFIG_BYTES}-byte bound: ${path}`);
    }
    const buffer = Buffer.alloc(MAX_NATIVE_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_NATIVE_CONFIG_BYTES) {
      throw new Error(`pi-review-gate: the native review-gate config exceeds the ${MAX_NATIVE_CONFIG_BYTES}-byte bound: ${path}`);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask bounded validation or native warnings.
    }
  }
}

/**
 * Revalidate an admitted saved-session receipt against this launch's
 * accepted native agent directory, live file identity, and workspace BEFORE
 * spawn: branded receipt, same agent directory, sessions root and project
 * directory still real directories containing the file directly, regular
 * non-symlink file with unchanged bigint dev/ino, a parseable first-line
 * header whose id/cwd still match the admission, and the admitted workspace
 * still resolving to the launch workspace. Diagnostics are bounded (fixed
 * strings; no transcript or header content).
 */
function revalidateSavedSessionAdmission(
  admission: SavedSessionAdmission,
  agentDir: string,
  launchWorkspace: string,
): string {
  const structureIssue = validateSavedSessionLocation(agentDir, admission.file);
  if (structureIssue !== undefined) {
    throw new Error(
      structureIssue === "missing-file"
        ? "pi-review-gate: the saved-session file is missing; re-select a saved conversation"
        : "pi-review-gate: the saved-session file is outside the native agent sessions root; re-select a saved conversation",
    );
  }
  let stats;
  try {
    stats = lstatSync(admission.file, { bigint: true });
  } catch {
    throw new Error("pi-review-gate: the saved-session file is missing; re-select a saved conversation");
  }
  if (stats.isSymbolicLink()) {
    throw new Error("pi-review-gate: the saved-session file is a symlink; refusing to launch from it");
  }
  if (!stats.isFile()) {
    throw new Error("pi-review-gate: the saved-session file is not a regular file; re-select a saved conversation");
  }
  if (stats.dev !== admission.dev || stats.ino !== admission.ino) {
    throw new Error(
      "pi-review-gate: the saved-session file changed since admission; re-select a saved conversation",
    );
  }
  const header = readSavedSessionHeader(admission.file);
  if (header === undefined) {
    throw new Error("pi-review-gate: the saved-session file header is unreadable; re-select a saved conversation");
  }
  if (header.id !== admission.sessionId || header.cwd !== admission.cwd) {
    throw new Error(
      "pi-review-gate: the saved-session file no longer matches its admission; re-select a saved conversation",
    );
  }
  // The admitted workspace must still exist and resolve to the exact
  // canonical workspace bound at admission, which must equal THIS launch's
  // workspace: a receipt for workspace A never launches in workspace B.
  let workspaceReal;
  try {
    workspaceReal = realpathSync(admission.cwd);
  } catch {
    throw new Error("pi-review-gate: the saved-session workspace is unavailable; re-select a saved conversation");
  }
  if (workspaceReal !== admission.workspace) {
    throw new Error(
      "pi-review-gate: the saved-session workspace changed since admission; re-select a saved conversation",
    );
  }
  if (workspaceReal !== launchWorkspace) {
    throw new Error(
      "pi-review-gate: the saved-session selection belongs to a different workspace than this launch; select a saved conversation from this workspace",
    );
  }
  return admission.file;
}

/** Validate and canonicalize the per-instance workspace (existing directory). */
function canonicalWorkspace(workspace: string): string {
  if (!isAbsolute(workspace)) {
    throw new Error(`pi-review-gate: the native launch workspace must be an absolute path: ${workspace}`);
  }
  if (!isDirectory(workspace)) {
    throw new Error(`pi-review-gate: the native launch workspace is not a directory: ${workspace}`);
  }
  return realpathSync(workspace);
}

/**
 * Validate the caller-provided Pi CLI: an absolute regular file (X_OK on
 * POSIX; readable on Windows, where the host Node executable runs it).
 */
function validatePiExecutable(piExecutable: string, platform: NodeJS.Platform): string {
  if (!isAbsolute(piExecutable)) {
    throw new Error(`pi-review-gate: the native pi executable must be an absolute path: ${piExecutable}`);
  }
  if (!isAdmissiblePiFile(piExecutable, platform)) {
    const requirement = platform === "win32" ? "a readable" : "an executable";
    throw new Error(`pi-review-gate: the native pi executable is not ${requirement} regular file: ${piExecutable}`);
  }
  const canonical = realpathSync(piExecutable);
  // Belt and braces: descriptors are normally built from resolveNativePi
  // output, which already rejected native/SEA binaries; keep the same
  // fail-closed check on the prepared path.
  rejectNonNodeCliExecutable(canonical);
  return canonical;
}

/**
 * Validate the profile's local review-gate config: it must already exist as a
 * readable JSON object read through a bounded, non-blocking, fstat-checked
 * file descriptor (a regular-target symlink admitted by the profile registry
 * is followed safely; a FIFO, a dangling/special link, or an over-cap file
 * rejects without ever blocking or reading whole). Parse failures produce
 * generic path-only diagnostics: modern V8 JSON.parse errors embed input
 * snippets, and config content is never echoed. No compatibility fallback and
 * no creation: the profile registry owns the file.
 */
function validateProfileConfig(agentDir: string): string {
  const configPath = join(agentDir, "review-gate.json");
  if (!existsThroughNonBlockSafeOpen(configPath)) {
    throw new Error(
      `pi-review-gate: the profile review-gate config is missing or not a regular file; the profile registry owns its creation: ${configPath}`,
    );
  }
  let text: string;
  try {
    const fd = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) {
        throw new Error(
          `pi-review-gate: the profile review-gate config is not a regular file: ${configPath}`,
        );
      }
      const buffer = Buffer.alloc(MAX_NATIVE_CONFIG_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_NATIVE_CONFIG_BYTES) {
        throw new Error(
          `pi-review-gate: the profile review-gate config exceeds the ${Math.floor(MAX_NATIVE_CONFIG_BYTES / (1024 * 1024))} MiB size bound: ${configPath}`,
        );
      }
      text = buffer.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("pi-review-gate:")) throw error;
    throw new Error(
      `pi-review-gate: the profile review-gate config could not be read: ${configPath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Generic, path-only: parse diagnostics must never echo config content.
    throw new Error(`pi-review-gate: the profile review-gate config is not valid JSON: ${configPath}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`pi-review-gate: the profile review-gate config must be a JSON object: ${configPath}`);
  }
  return configPath;
}

/**
 * True only when opening the path (non-blocking, race-safe) yields a regular
 * file: a dangling link or a special-file (FIFO) target is rejected without
 * blocking.
 */
function existsThroughNonBlockSafeOpen(path: string): boolean {
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      return fstatSync(fd).isFile();
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Bounded, type-safe read of a real regular file: the file must exist as a
 * lstat-regular entry (a symlinked source is never read through), the size
 * bound is checked on lstat before any allocation, and the read itself is
 * capped (never allocates or blocks beyond the bound; O_NONBLOCK keeps a
 * raced special file from ever stalling the preparation).
 */
function readBoundedRegularFileSync(path: string, maxBytes: number): Buffer {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new Error(
      `pi-review-gate: the bounded file read failed: ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!stats.isFile()) {
    const kind = stats.isSymbolicLink()
      ? "a symlink"
      : stats.isDirectory()
        ? "a directory"
        : "a special file";
    throw new Error(`pi-review-gate: the bounded file read requires a real regular file, but ${path} is ${kind}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(`pi-review-gate: ${path} exceeds the ${maxBytes}-byte bound; refusing to read it whole`);
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    throw new Error(
      `pi-review-gate: the bounded file read failed: ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`pi-review-gate: the bounded file read requires a real regular file: ${path}`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`pi-review-gate: ${path} exceeds the ${maxBytes}-byte bound; refusing to read it whole`);
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Bounded parity probe for destinations: any failure (absent, non-regular, over-cap) means "republish". */
function tryReadBoundedRegularFileSync(path: string, maxBytes: number): Buffer | undefined {
  try {
    return readBoundedRegularFileSync(path, maxBytes);
  } catch {
    return undefined;
  }
}

/** Strict bounded load of one shipped packaged file, with fail-closed diagnostics. */
function requireBoundedShippedFile(path: string): Buffer {
  try {
    lstatSync(path);
  } catch {
    throw new Error(`pi-review-gate: the packaged skill file is missing: ${path}`);
  }
  try {
    return readBoundedRegularFileSync(path, MAX_SKILL_FILE_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("exceeds")) {
      throw new Error(`pi-review-gate: the packaged skill file exceeds the publication size bound: ${path}`);
    }
    throw new Error(
      `pi-review-gate: the packaged skill file could not be loaded (${message}): ${path}`,
    );
  }
}

/**
 * Refresh the standard shipped skill files into the profile's reserved
 * namespaced skill directories (`<agentDir>/skills/pi-review-gate-*`).
 *
 * Validation is fail-closed and ordered for safety: every validation pass
 * (sources, all existing path components of every destination, destination
 * leaves) completes before ANY directory creation or file write, so a
 * validation failure leaves the profile completely untouched. Publication
 * itself is per-file atomic, not a transaction: if a later I/O step fails
 * mid-publication, files already published stay published and the parent
 * host can safely re-run this idempotent preparation.
 *
 * 1. Every shipped source is verified as a bounded regular file before
 *    anything is written (mirrors the launcher's fail-closed pre-check).
 * 2. Every EXISTING path component from the profile agent directory
 *    (including the skills root itself) down to each destination is checked
 *    with lstat BEFORE any directory is created: a symlinked intermediate
 *    directory — even one aliased to an external target — rejects the whole
 *    preparation before any mkdir runs, so mkdir can never fire through an
 *    alias into an unknown external tree (e.g. creating external/
 *    references/ under a symlinked skill directory). Only then are missing
 *    directories created one level at a time (each creation fails closed on
 *    any interloper appearing meanwhile), and an existing
 *    directory/special-file at a destination rejects before any file is
 *    published.
 * 3. Each file is published atomically through the shipped launcher helper's
 *    `renameIntoPlaceWithContentionRetry` (the production rename
 *    implementation shared with the ordinary launchers). Content identical to
 *    the shipped source is left byte-untouched; a stale destination is
 *    replaced whole via rename(2), which replaces a symlinked leaf itself —
 *    never the target it points at. Unrelated files under the skills root are
 *    never touched, and nothing is ever written to the caller's cwd/workspace.
 *
 * The pre-#151 generic-location migration deliberately does not apply here:
 * `migrateGenericSkillFiles` pins the user-home `~/.agents/skills` layout the
 * ordinary launchers publish into, while a per-profile agent directory holds
 * no legacy generic entries and none are ever created by this module.
 */
/** Every directory component from the admitted profile agent directory through the destination's parent. */
function skillDirectoryComponents(agentDir: string, destination: string): string[] {
  let current = agentDir;
  const components = [agentDir];
  for (const part of relative(agentDir, dirname(destination)).split(sep).filter(Boolean)) {
    current = join(current, part);
    components.push(current);
  }
  return components;
}

function refreshNativeProfileSkills(packageRoot: string, skillsRoot: string): void {
  // Pass 1: stage every source's exact shipped bytes, strictly bounded and
  // type-safe: a source must be a real regular file (a symlinked source is
  // never read through), the size bound is enforced on lstat before any
  // allocation, and the capped read itself can never block on a FIFO or
  // allocate beyond the bound.
  const staged: { source: string; destination: string; bytes: Buffer }[] = [];
  for (const skill of NATIVE_SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(packageRoot, ...file.source);
      const destination = join(skillsRoot, skill.name, ...file.destination);
      staged.push({ source, destination, bytes: requireBoundedShippedFile(source) });
    }
  }

  // Pass 2a: pre-validate BEFORE any creation. Walk every existing component
  // of every destination from the canonical agent directory (including the
  // skills root itself) downward using lstat: a symlinked intermediate
  // component — even one aliased to an external target without the expected
  // children — rejects the whole preparation before any mkdir runs, so mkdir
  // can never create directories through an alias into an unknown external
  // tree ("unknown target untouched"). A component that is missing ends the
  // walk for that destination (everything below will be created componentwise
  // after all pre-validation): deeper components cannot exist below a missing
  // directory. No home scan, no Terraform recursion: only the validated
  // per-profile agent tree is inspected.
  const agentDirReal = realpathSync(dirname(skillsRoot));
  for (const stage of staged) {
    if (relative(agentDirReal, stage.destination).startsWith("..") || isAbsolute(relative(agentDirReal, stage.destination))) {
      throw new Error(`pi-review-gate: the native skill publication path escaped the profile agent directory: ${stage.destination}`);
    }
    for (const current of skillDirectoryComponents(agentDirReal, stage.destination)) {
      let stats;
      try {
        stats = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break; // absent: created later, after all pre-checks
        throw new Error(
          `pi-review-gate: the native skill publication path could not be inspected: ${current} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (stats.isSymbolicLink()) {
        throw new Error(
          `pi-review-gate: refusing to publish the native skills through a symlinked path component: ${current}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new Error(
          `pi-review-gate: the native skill publication needs a directory at ${current}, but a non-directory occupies the path`,
        );
      }
    }
    // Destination leaf: must be absent, a real regular file, or a symlink
    // (replaced itself by the atomic rename below, never read through). Any
    // other kind — a directory, a FIFO, a socket, a device — rejects the
    // whole preparation before any publication; a special file could
    // otherwise block a bounded parity read forever.
    let leafStats;
    try {
      leafStats = lstatSync(stage.destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `pi-review-gate: the native skill publication path could not be inspected: ${stage.destination} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      continue; // absent destination leaf: fine, the rename will create it
    }
    if (!leafStats.isSymbolicLink() && !leafStats.isFile()) {
      throw new Error(
        `pi-review-gate: the native skill publication destination exists but is not a replaceable regular file (a directory or special file appeared there?); move or rename it and re-run the host`,
      );
    }
  }

  // Pass 2b: create only known-missing directories, one level at a time,
  // strictly below the pre-validated canonical agent directory. mkdirSync in
  // non-recursive mode fails closed (EEXIST) if any interloper appeared
  // between pre-validation and creation, so an aliased path can never sneak a
  // mkdir through between the checks.
  for (const stage of staged) {
    for (const current of skillDirectoryComponents(agentDirReal, stage.destination)) {
      let stats;
      try {
        stats = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            mkdirSync(current, { recursive: false });
          } catch (mkdirError) {
            throw new Error(
              `pi-review-gate: could not create the native skill directory ${current} (${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)})`,
            );
          }
          continue;
        }
        throw new Error(
          `pi-review-gate: the native skill publication path could not be inspected: ${current} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `pi-review-gate: refusing to publish the native skills through a changed (symlinked or non-directory) path component: ${current}`,
        );
      }
    }
  }

  // Pass 3: atomic bounded publication of the staged shipped bytes. Parity
  // compares only bounded regular files: a symlink leaf is always republished
  // (replacing the link itself) without ever reading its target, and an
  // unreadable or over-cap destination is simply republished — never scanned
  // whole and never blocked on a special file (already rejected above).
  const helper = loadLauncherHelper();
  for (const stage of staged) {
    if (tryReadBoundedRegularFileSync(stage.destination, MAX_SKILL_FILE_BYTES)
      ?.equals(stage.bytes) === true) continue; // byte-identical: never re-written

    const dir = dirname(stage.destination);
    const tmp = join(dir, `.skill-publish.${Math.random().toString(36).slice(2, 18)}`);
    let fd: number;
    try {
      fd = openSync(tmp, "wx", 0o644);
    } catch (error) {
      throw new Error(
        `pi-review-gate: could not stage the native skill file in ${dir} (${error instanceof Error ? error.message : String(error)}); ${stage.destination} cannot be refreshed`,
      );
    }
    try {
      writeFileSync(fd, stage.bytes);
      chmodSync(tmp, 0o644);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort staging cleanup.
      }
      throw new Error(
        `pi-review-gate: could not write the staged native skill file in ${dir} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    closeSync(fd);
    // Single atomic publication step: rename(2) replaces an existing regular
    // file or a symlink leaf in place (never the symlink's target), and a
    // directory destination fails immediately (already rejected above).
    const outcome = helper.renameIntoPlaceWithContentionRetry(
      () => renameSync(tmp, stage.destination),
      { destination: stage.destination },
    );
    if (!outcome.published) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort staging cleanup.
      }
      const detail = outcome.lastError?.code
        ? ` (${outcome.lastError.code}: ${outcome.lastError.message ?? ""})`
        : "";
      throw new Error(`pi-review-gate: unexpected failure publishing the native skill file to ${stage.destination}${detail}`);
    }
  }
}