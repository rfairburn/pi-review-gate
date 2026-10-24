#!/usr/bin/env node
"use strict";

/**
 * Shared setup and runtime selection for the one-command session host
 * launchers (issue 323). The POSIX script and installed
 * `pi-review-sessions` bin dispatch here; the .cmd entry point also dispatches
 * here. Windows setup and host admission use public Node APIs, but source-level
 * implementation is not proof of native runtime support; real ConPTY and
 * lifecycle validation remains a parent-owned Windows task.
 *
 * - Source checkouts use a content-derived identity of the exact staged
 *   package/source paths and build toolchain. A completed privately staged
 *   build can be reused only after bounded no-follow manifest and content
 *   validation; otherwise inputs are copied to a fresh stage, locked
 *   dependencies are installed with npm ci, and the stage's own TypeScript
 *   CLI compiles through public Node directly. Untracked Node preload/loader
 *   hooks and external dependency modes bypass reuse. The package's own build
 *   script is never run, so recursive `clean:build` cannot touch the stage or
 *   live checkout. DDGS provisioning uses the shared Node helper (ensureDdgs
 *   in scripts/pi-review-gate-launcher.cjs) in a bounded owned process.
 *   Each disposable build and Pi cache independently targets five generations,
 *   including setup residue. These designated cache trees are disposable by
 *   location, so excess generations are reclaimed regardless of who created a
 *   descendant or whether legacy lifetime metadata exists. Reclamation is best
 *   effort: a busy lock or partial filesystem failure is reported and startup
 *   continues, never stopped by cache capacity. Active sessions stay guarded by
 *   the session host's own exclusive agent-directory ownership record.
 * - Runtime selection resolves the public @earendil-works/pi-coding-agent
 *   CLI without parsing or executing opaque shims: an explicit
 *   --pi-executable Node entry is honored when valid; otherwise the npm
 *   global package root's declared bin entry is validated (package name,
 *   stable version floor, bin containment, regular readable positive Node
 *   entry), then a PATH `pi` that resolves into such a package. When no
 *   supported installation exists, an isolated Pi 1.4.0 runtime is
 *   provisioned under the native Pi agent directory's cache
 *   (<agent-dir>/.pi-review-gate/pi-runtime) with npm --ignore-scripts and
 *   re-validated before publication. Global installs and existing user
 *   files are never modified. Provisioning installs inside its own version
 *   generation so a half-install is never reused.
 * - Shipped-skill provisioning (issue 378) gives the direct sidebar entry
 *   points wrapper-equivalent setup without a wrapper prerequisite: every file
 *   in the canonical SKILL_PUBLISH_PLAN (scripts/pi-review-gate-launcher.cjs)
 *   is refreshed into the native discovery home's .agents/skills/ under the
 *   pi-review-gate- namespace — USERPROFILE via os.homedir() on Windows
 *   (which can differ from HOME), HOME-first elsewhere — orchestrator with its
 *   recovery runbook, execution, research, and completion — using the shared
 *   atomic per-file publication, followed by the ownership-safe pre-#151
 *   generic-location migration. A missing packaged source or a failed
 *   publication stops startup with an actionable error; byte-identical
 *   installed files are left untouched on repeat launches.
 * - Probes and provisioning occur BEFORE the host broker/token exists, on a
 *   scrubbed setup environment (bootstrap/restore/settlement markers removed,
 *   role authorization rejected earlier), while trusted provider variables and
 *   the user's original NODE_OPTIONS are preserved for the actual native
 *   launch. Diagnostics are bounded: fixed names and paths, never command
 *   output or environment content.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertSessionHostStartupOptions,
  snapshotSessionHostEnvironment,
} = require("./session-host-startup-options.cjs");
const gateLauncher = require("./pi-review-gate-launcher.cjs");
const generations = require("./managed-generations.cjs");
// Shared source-preparation engine and current/update authority (issue 344).
// Every launcher uses exactly these implementations: this file no longer owns a
// build pipeline, fingerprint, cache record, or artifact scan of its own.
const applicationBuildModule = require("./application-build.cjs");
const {
  boundedProcessCleanupStatus,
  boundDiagnosticText,
  findNpmCli,
  formatBuildStageDiagnostics,
  runBoundedProcess,
  runNpm,
  sanitizeDiagnosticText,
  stageNpmEnvironment,
} = require("./application-build.cjs");
const { prepareLaunch } = require("./prepare-application.cjs");
const {
  acquireCleanupLock: sharedAcquireCleanupLock,
  applicationStateRoot: sharedApplicationStateRoot,
  ensureApplicationStateDirectory: sharedEnsureApplicationStateDirectory,
  leasedRoots: sharedLeasedRoots,
  publishConsumerLease: publishSharedConsumerLease,
  readMarker: sharedReadMarker,
  writeMarker: sharedWriteMarker,
  APPLICATION_SCHEMA: sharedApplicationSchema,
} = require("./prepare-application.cjs");

const USAGE = `Usage: pi-review-sessions [--pi-executable <path>] [--state-root <path>] [--sidebar-key <key>] [--help] [-- <Pi arguments...>]

Alpha same-machine macOS/Linux session host with Windows source paths available
for native validation only (not a Windows readiness claim). Requires Node >=22.23.4
with the per-line security minimums Node 24 >=24.22.1 and Node 26 >=26.12.1, and
Pi >=1.0.4 with a positively identified Node CLI entry. Without --pi-executable the
launcher resolves the public @earendil-works/pi-coding-agent installation
(npm global root, then PATH) and, when none is supported, provisions an
isolated Pi 1.4.0 runtime cache under the native Pi agent directory; no
manual Pi CLI path is needed. Starts an empty welcome/sidebar picker; choose
a workspace explicitly in the UI.
The startup working directory is not selected as a workspace.
Basic controls only; bounded native Kitty PNG rendering targets direct Ghostty
(TERM_PROGRAM=ghostty, TERM=xterm-ghostty, no tmux/screen).
Unsupported image display uses native-style text where metadata is available.
Physical Ghostty acceptance remains pending; see docs/session-host-alpha.md.
Native image/model input behavior stays native. Host toggle/roster-return shortcuts default
to alt+left/alt+right and can be configured in session-host/keybindings.json. Parent startup session overrides
(--continue/-c, --resume/-r, --session, --session-id, --fork, --session-dir,
--no-session, PI_CODING_AGENT_SESSION_DIR) are not accepted: every instance
starts a new native conversation using Pi's normal session storage.`;

const MAX_PATH_LENGTH = 2048;
const MAX_TOGGLE_KEY_LENGTH = 80;
const HOST_ENV_TO_CLEAR = [
  "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP",
  "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE",
  "PI_REVIEW_GATE_NODE_GENERATION",
  "PI_REVIEW_GATE_NODE_HOLDER",
  "PI_REVIEW_GATE_DDGS_PYTHON",
  ...["SECRET", "PATH", "SESSION", "CHILD"].flatMap((suffix) => [
    `PI_REVIEW_GATE_SETTLEMENT_${suffix}`,
    `PI_REVIEW_GATE_QUIESCENCE_${suffix}`,
  ]),
];
const ROLE_ENV_NAMES = [
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
];
// Per-release-line Node security minimums (issue 489). A listed line must meet
// its own floor; any other major inherits the floor of the nearest listed lower
// line, so an unlisted newer major (23, 25, 27, ...) keeps the existing
// newer-major policy while every release below Node 22 stays refused. Mirrored
// by node_version_supported (pi-review-sessions.sh), Test-NodeFloor
// (pi-review-sessions-node.ps1), stableNodeVersion (src/session-host/main.ts),
// and the package engines range.
const NODE_LINE_FLOORS = Object.freeze([
  Object.freeze([22, 23, 4]),
  Object.freeze([24, 22, 1]),
  Object.freeze([26, 12, 1]),
]);
const NODE_FLOOR_REQUIREMENT = "Node >=22.23.4 (Node 24 >=24.22.1, Node 26 >=26.12.1)";

// Public Pi runtime identity (issue 323): the supported package and its
// exact provisioned version. The floor matches the native launch contract in
// src/session-host/launch.ts (Pi 1.0.4 minimum).
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_MIN_VERSION = [1, 0, 4];
const PI_PROVISION_VERSION = "1.4.0";
// Discovery identity of the provisioned default (see validatePiDiscovery): the
// source a managed-default selection is recorded under.
const PI_MANAGED_DEFAULT_SOURCE = "isolated-cache";
const RUNTIME_CACHE_DIRNAME = ".pi-review-gate";
const PI_RUNTIME_DIRNAME = "pi-runtime";

// Bounded probe/provision limits (mirrors src/session-host/launch.ts).
const VERSION_PROBE_MAX_BYTES = 8 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const NPM_ROOT_TIMEOUT_MS = 60_000;
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const DDGS_SETUP_TIMEOUT_MS = 600_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NODE_ENTRY_HEAD_BYTES = 512;

class SessionHostArgumentError extends Error {}
class PiRuntimeError extends Error {}

function canonicalSessionHostShortcut(value) {
  const symbols = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?"]);
  const navigation = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
  const modifierOrder = ["ctrl", "shift", "alt", "super"];
  const fail = () => { throw new SessionHostArgumentError("Invalid value for --sidebar-key."); };
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOGGLE_KEY_LENGTH
    || /[\u0000-\u001f\u007f-\u009f\s]/u.test(value)) fail();
  const parts = value.toLowerCase().split("+");
  const base = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!base || modifiers.some((modifier) => !modifierOrder.includes(modifier))
    || new Set(modifiers).size !== modifiers.length) fail();
  if (base === "escape" || base === "esc" || (base === "[" && modifiers.includes("ctrl"))
    || (base === "c" && modifiers.length === 1 && modifiers[0] === "ctrl")
     || ((base === "m" || base === "j") && modifiers.length === 1 && modifiers[0] === "ctrl")
    || (base === "q" && (modifiers.length === 0 || (modifiers.length === 1 && modifiers[0] === "shift")))) fail();
  if (/^f(?:1[0-2]|[1-9])$/u.test(base)) {
    if (modifiers.length !== 0) fail();
    return base;
  }
  const printable = /^[a-z0-9]$/u.test(base) || symbols.has(base);
  if (printable) {
    if (!modifiers.some((modifier) => modifier !== "shift")) fail();
  } else if (navigation.has(base)) {
    if (modifiers.length === 0) fail();
  } else {
    fail();
  }
  const canonicalBase = base === "pageup" ? "pageUp" : base === "pagedown" ? "pageDown" : base;
  return [...modifierOrder.filter((modifier) => modifiers.includes(modifier)), canonicalBase].join("+");
}

/** Parse only wrapper-owned options; every byte after `--` belongs to Pi. */
function parseSessionHostArguments(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw new SessionHostArgumentError("Invalid pi-review-sessions arguments.");
  }

  let help = false;
  let piExecutable;
  let stateRoot;
  let toggleKey;
  const seen = new Set();
  let separator = false;
  const args = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (separator) {
      args.push(token);
      continue;
    }
    if (token === "--") {
      separator = true;
      continue;
    }

    let option;
    let canonical;
    if (token === "--help" || token === "-h") {
      option = "help";
      canonical = "help";
    } else if (token === "--pi-executable") {
      option = "pi-executable";
      canonical = option;
    } else if (token === "--state-root") {
      option = "state-root";
      canonical = option;
    } else if (token === "--sidebar-key") {
      option = "sidebar-key";
      canonical = option;
    } else if (token.startsWith("-")) {
      throw new SessionHostArgumentError("Unknown pi-review-sessions option.");
    } else {
      throw new SessionHostArgumentError("Unexpected argument before '--'.");
    }

    if (seen.has(canonical)) {
      throw new SessionHostArgumentError("Duplicate pi-review-sessions option.");
    }
    seen.add(canonical);

    if (canonical === "help") {
      help = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) {
      throw new SessionHostArgumentError(`Missing value for --${option}.`);
    }
    index += 1;

    const limit = canonical === "sidebar-key" ? MAX_TOGGLE_KEY_LENGTH : MAX_PATH_LENGTH;
    if (value.length === 0 || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      throw new SessionHostArgumentError(`Invalid value for --${option}.`);
    }
    if (canonical === "pi-executable") piExecutable = value;
    else if (canonical === "state-root") stateRoot = value;
    else toggleKey = canonicalSessionHostShortcut(value);
  }

  const result = { help };
  if (piExecutable !== undefined) result.piExecutable = piExecutable;
  if (stateRoot !== undefined) result.stateRoot = stateRoot;
  if (toggleKey !== undefined) result.toggleKey = toggleKey;
  result.args = args;
  return result;
}

function applicableNodeFloor(major) {
  for (let index = NODE_LINE_FLOORS.length - 1; index >= 0; index -= 1) {
    if (NODE_LINE_FLOORS[index][0] <= major) return NODE_LINE_FLOORS[index];
  }
  return NODE_LINE_FLOORS[0];
}

function meetsNodeFloor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const floor = applicableNodeFloor(actual[0]);
  for (let index = 0; index < floor.length; index += 1) {
    if (actual[index] > floor[index]) return true;
    if (actual[index] < floor[index]) return false;
  }
  return match[4] === undefined;
}

/** Truthful, bounded refusal naming the applicable line minimum when parseable. */
function nodeFloorRefusal(version) {
  const match = typeof version === "string" ? /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z.-]{1,64})?$/u.exec(version) : null;
  if (!match) return `pi-review-sessions: ${NODE_FLOOR_REQUIREMENT} is required.\n`;
  const floor = applicableNodeFloor(Number(match[1])).join(".");
  return `pi-review-sessions: Node ${version} is below the ${floor} security minimum for its release line; ${NODE_FLOOR_REQUIREMENT} is required.\n`;
}

function isNonempty(value) {
  return typeof value === "string" && value.length > 0;
}

function statusCode(result, fallback = 1) {
  if (result && result.timedOut) return 124;
  if (result && (result.error || result.outputExceeded || result.cleanupConfirmed === false)) return fallback;
  if (result && typeof result.signal === "string") {
    const signalNumber = os.constants.signals[result.signal];
    if (Number.isInteger(signalNumber)) return 128 + signalNumber;
  }
  if (result && Number.isInteger(result.status)) return result.status;
  return fallback;
}

function hasPositiveIdentity(stats) {
  return typeof stats.dev === "bigint" && stats.dev >= 0n
    && typeof stats.ino === "bigint" && stats.ino > 0n;
}

function identityOfDirectory(target) {
  const stats = fs.lstatSync(target, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !hasPositiveIdentity(stats)) {
    throw new Error("directory identity is unavailable or unsafe");
  }
  return { dev: stats.dev, ino: stats.ino };
}

function sameDirectoryIdentity(target, identity) {
  try {
    const current = identityOfDirectory(target);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

/** Create missing parent components one at a time; never follow a directory symlink. */
function ensureDirectoryTree(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const chain = [{ target: current, identity: identityOfDirectory(current) }];
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      identityOfDirectory(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
    }
    chain.push({ target: current, identity: identityOfDirectory(current) });
    if (!directoryChainIsSame(chain)) throw new Error("directory chain changed during setup");
  }
  return chain;
}

/**
 * Exclusively create a fresh private directory and retain its filesystem
 * identity. A random name is only collision resistance; it never proves
 * ownership. Existing paths are not adopted, removed, or traversed.
 */
function createOwnedStage(parent, prefix, randomBytes = crypto.randomBytes) {
  const absoluteParent = path.resolve(parent);
  const parentChain = ensureDirectoryTree(absoluteParent);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomBytes(16).toString("hex");
    const root = path.join(absoluteParent, `${prefix}${suffix}`);
    try {
      fs.mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    // Capture identity immediately after successful exclusive creation, then
    // fence the whole public-Node-observed parent chain before returning it.
    // If identity itself is unavailable, ownership cannot be proven and this
    // fresh stage is retained rather than unlinked by name.
    let identity;
    try {
      identity = identityOfDirectory(root);
    } catch (cause) {
      cause.retainedStage = true;
      throw cause;
    }
    const chain = [...parentChain, { target: root, identity }];
    if (!directoryChainIsSame(chain)) {
      const error = new Error("staging directory identity changed during creation");
      error.retainedStage = true;
      throw error;
    }
    return { root, identity, parentChain, chain };
  }
  throw new Error("could not exclusively create a unique staging directory");
}

function directoryChainIsSame(chain) {
  return chain.every(({ target, identity }) => sameDirectoryIdentity(target, identity));
}

function closeDirectory(directory) {
  try {
    directory.closeSync();
  } catch (error) {
    if (error.code !== "ERR_DIR_CLOSED") throw error;
  }
}

function sameStatIdentity(left, right) {
  return hasPositiveIdentity(left) && hasPositiveIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function lstatRegularFile(file) {
  const stats = fs.lstatSync(file, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || !hasPositiveIdentity(stats)) {
    throw new Error("file identity is unavailable or unsafe");
  }
  return stats;
}

/** A regular non-symlink file still matches its captured BigInt identity. */
function sameFileIdentity(file, identity) {
  try {
    const current = lstatRegularFile(file);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

function isRegularFile(file) {
  try {
    const stats = fs.lstatSync(file);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pi runtime selection (issue 323): positive identity only. No opaque shim
// is ever parsed or executed; every candidate must be a regular readable
// file with a positive Node-entry shebang inside the public package, and its
// exact version comes from a bounded --version probe on the scrubbed env.
// ---------------------------------------------------------------------------

function parseStableVersion(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let index = 0; index < right.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index];
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function pathExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function assertDirectoryChain(base, target) {
  const canonicalBase = path.resolve(base);
  const canonicalTarget = path.resolve(target);
  const relative = path.relative(canonicalBase, canonicalTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes directory root");
  const chain = [{ target: canonicalBase, identity: identityOfDirectory(canonicalBase) }];
  let current = canonicalBase;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    chain.push({ target: current, identity: identityOfDirectory(current) });
    if (!directoryChainIsSame(chain)) throw new Error("path identity changed during validation");
  }
  return chain;
}

/** Bounded first-bytes read with no-follow open and descriptor identity checks. */
function readHeadBytes(file, bytes) {
  try {
    const before = lstatRegularFile(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameStatIdentity(before, opened)
        || !sameStatIdentity(before, lstatRegularFile(file))) return undefined;
      const head = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < head.length) {
        const bytesRead = fs.readSync(fd, head, offset, head.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (!sameStatIdentity(before, after)
        || !sameStatIdentity(after, lstatRegularFile(file))) return undefined;
      return head.subarray(0, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Positive Node-entry shebang check (mirrors src/session-host/launch.ts):
 * exactly `#!<interpreter>` with basename `node[.exe]` and no flags, or
 * `#!<env> node[.exe]` naming precisely the bare Node argument. Opaque shell
 * shims, exotic interpreters, and extra tokens reject.
 */
function isNodeEntryShebang(head) {
  const lineEnd = head.indexOf(0x0a);
  if (lineEnd === -1 && head.length === NODE_ENTRY_HEAD_BYTES) return false; // incomplete bounded first line
  const firstLine = (lineEnd === -1 ? head : head.subarray(0, lineEnd)).toString("utf8").trim();
  const match = firstLine.match(/^#![ \t]*(\S+)(?:[ \t]+(\S+))?[ \t]*$/);
  if (!match) return false;
  const [, interpreter, argumentMaybe] = match;
  const normalizedInterpreter = interpreter.replace(/\\/gu, "/");
  const interpreterBasename = normalizedInterpreter.slice(normalizedInterpreter.lastIndexOf("/") + 1).toLowerCase();
  const nodeNames = new Set(["node", "node.exe"]);
  if (nodeNames.has(interpreterBasename)) return argumentMaybe === undefined;
  if (interpreterBasename === "env") return nodeNames.has(`${argumentMaybe ?? ""}`.toLowerCase());
  return false;
}

function readBoundedRegularFile(file, maxBytes) {
  const before = lstatRegularFile(file);
  if (before.size > BigInt(maxBytes)) throw new Error("file exceeds bounded read size");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStatIdentity(before, opened)
      || !sameStatIdentity(before, lstatRegularFile(file)) || opened.size > BigInt(maxBytes)) {
      throw new Error("file changed during bounded read");
    }
    const chunks = [];
    let total = 0;
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error("file exceeds bounded read size");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameStatIdentity(before, after)
      || !sameStatIdentity(after, lstatRegularFile(file))
      || before.size !== after.size) throw new Error("file changed during bounded read");
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

/** Run the public Node CLI through this admitted Node, never its shebang shim. */
async function probePiVersion(file, env, processRunner = runBoundedProcess) {
  const result = await processRunner(process.execPath, [file, "--version"], {
    env,
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
    maxOutputBytes: VERSION_PROBE_MAX_BYTES,
    captureStdout: true,
  });
  if (result.cleanupConfirmed === false) {
    const error = new PiRuntimeError("the pi version probe cleanup was not confirmed; preserving its runtime");
    error.cleanupUnconfirmed = true;
    throw error;
  }
  if (result.timedOut) {
    throw new PiRuntimeError(`the pi version probe exceeded ${Math.round(VERSION_PROBE_TIMEOUT_MS / 1000)}s; refusing to use ${file}`);
  }
  if (result.outputExceeded) throw new PiRuntimeError(`the pi --version output exceeded the probe limit; refusing to use it: ${file}`);
  if (result.error) {
    const errno = result.error.code;
    const detail = errno ? ` (${String(errno)})` : "";
    throw new PiRuntimeError(`the pi version probe could not run${detail}: ${file}`);
  }
  if (result.signal) throw new PiRuntimeError(`the pi version probe was terminated by ${result.signal}: ${file}`);
  if (result.status !== 0) throw new PiRuntimeError(`the pi version probe exited with status ${String(result.status)}: ${file}`);
  const parsed = result.stdout.trim().match(/^(?:pi\s+)?v?(\d+\.\d+\.\d+)$/);
  if (!parsed || parsed[1].length > 64) {
    throw new PiRuntimeError(`the pi --version output is not an exact official version format; refusing to use ${file}`);
  }
  const components = parsed[1].split(".").map((part) => Number(part));
  if (compareVersions(components, PI_MIN_VERSION) < 0) {
    throw new PiRuntimeError(`native session host launch requires Pi ${PI_MIN_VERSION.join(".")} or newer; found ${parsed[1]} at ${file}`);
  }
  return parsed[1];
}

/**
 * Validate one @earendil-works/pi-coding-agent package directory and return
 * its probed CLI entry. Every check is positive: manifest name, stable
 * version floor (or exactly the pinned provision version when exactVersion
 * is given — staged and cached provisions never accept a newer build),
 * declared `pi` bin contained in the package both lexically AND after
 * realpath (an in-package symlink that resolves outside is never executed),
 * regular readable Node-entry file (also executable on POSIX), and a live bounded version
 * probe that must agree with the package metadata.
 * When expectedFile is given (the PATH case), the declared bin must resolve
 * to exactly that file.
 */
async function validatePiPackage(pkgDir, env, options = {}) {
  const { expectedFile, exactVersion } = options;
  const processRunner = options.processRunner || runBoundedProcess;
  const manifestPath = path.join(pkgDir, "package.json");
  let manifest;
  try {
    const packageStats = fs.lstatSync(pkgDir);
    if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) throw new PiRuntimeError("bad package directory");
    manifest = JSON.parse(readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES).toString("utf8"));
  } catch {
    throw new PiRuntimeError(`the pi package metadata at ${pkgDir} is unreadable or invalid`);
  }
  if (manifest === null || typeof manifest !== "object" || manifest.name !== PI_PACKAGE_NAME) {
    throw new PiRuntimeError(`the package at ${pkgDir} is not the public pi package (${PI_PACKAGE_NAME})`);
  }
  const version = parseStableVersion(manifest.version);
  const boundedVersionLabel = typeof manifest.version === "string" ? manifest.version.slice(0, 64) : "invalid";
  if (!version || compareVersions(version, PI_MIN_VERSION) < 0) {
    throw new PiRuntimeError(`the installed pi version ${boundedVersionLabel} is unsupported (requires >= ${PI_MIN_VERSION.join(".")})`);
  }
  if (exactVersion !== undefined && manifest.version !== exactVersion) {
    throw new PiRuntimeError(`the cached pi runtime version ${boundedVersionLabel} does not match the pinned provision version ${exactVersion}`);
  }
  const binEntry = manifest.bin && typeof manifest.bin === "object" ? manifest.bin.pi : undefined;
  if (typeof binEntry !== "string" || binEntry.length === 0) {
    throw new PiRuntimeError(`the pi package at ${pkgDir} declares no pi bin entry`);
  }
  const entry = path.resolve(pkgDir, binEntry);
  const contained = path.relative(pkgDir, entry);
  if (contained.startsWith("..") || path.isAbsolute(contained)) {
    throw new PiRuntimeError(`the pi package bin entry escapes the package directory: ${pkgDir}`);
  }
  if (process.platform === "win32") {
    try {
      assertDirectoryChain(pkgDir, path.dirname(entry));
    } catch {
      throw new PiRuntimeError(`the pi package bin entry has an unsafe directory chain: ${pkgDir}`);
    }
  }
  let canonical;
  try {
    canonical = fs.realpathSync(entry);
    // POSIX npm bins may be symlinks; validate their canonical target. On
    // Windows, keep the stronger no-symlink policy on the declared entry.
    lstatRegularFile(process.platform === "win32" ? entry : canonical);
    const access = fs.constants.R_OK | (process.platform === "win32" ? 0 : fs.constants.X_OK);
    fs.accessSync(canonical, access);
  } catch {
    throw new PiRuntimeError(`the pi CLI entry is not a regular readable file: ${entry}`);
  }
  // Canonical containment: the lexical check above cannot stop an in-package
  // symlink from resolving outside the public package; the canonical entry
  // must remain inside the canonical package root or it is never executed.
  let pkgRootCanonical;
  try {
    pkgRootCanonical = fs.realpathSync(pkgDir);
  } catch {
    throw new PiRuntimeError(`the pi package directory could not be resolved: ${pkgDir}`);
  }
  const canonicalContainment = path.relative(pkgRootCanonical, canonical);
  if (canonicalContainment.startsWith("..") || path.isAbsolute(canonicalContainment)) {
    throw new PiRuntimeError(`the pi package bin entry resolves outside the package directory: ${pkgDir}`);
  }
  const head = readHeadBytes(canonical, NODE_ENTRY_HEAD_BYTES);
  if (!head || head.length < 2 || !isNodeEntryShebang(head)) {
    throw new PiRuntimeError(`the pi CLI entry is not a positive Node entry (expected the standard npm-installed pi CLI): ${canonical}`);
  }
  if (expectedFile !== undefined) {
    let expectedCanonical;
    try {
      expectedCanonical = fs.realpathSync(expectedFile);
    } catch {
      throw new PiRuntimeError(`the pi package bin entry does not match the resolved PATH file: ${pkgDir}`);
    }
    if (expectedCanonical !== canonical) {
      throw new PiRuntimeError(`the pi package bin entry does not match the resolved PATH file: ${pkgDir}`);
    }
  }
  const probed = await probePiVersion(canonical, env, processRunner);
  // Metadata/probe agreement: the live entry must report exactly the version
  // its package metadata declares; a mismatched pair is never trusted.
  if (probed !== String(manifest.version)) {
    throw new PiRuntimeError(`the pi version probe (${probed}) disagrees with the package metadata (${String(manifest.version)}) at ${pkgDir}`);
  }
  return { file: canonical, version: probed };
}

/** The npm global package root (single bounded absolute line), or undefined. */
async function npmGlobalRoot(env, npmCli) {
  const result = await runNpm(npmCli, ["root", "-g"], {
    env,
    timeoutMs: NPM_ROOT_TIMEOUT_MS,
    maxOutputBytes: VERSION_PROBE_MAX_BYTES,
    captureStdout: true,
  });
  if (result.cleanupConfirmed === false) {
    const error = new PiRuntimeError("the npm global-root probe cleanup was not confirmed; refusing to continue setup");
    error.cleanupUnconfirmed = true;
    throw error;
  }
  if (result.error || result.status !== 0 || result.signal || result.timedOut || result.outputExceeded) return undefined;
  const line = result.stdout.trim();
  if (
    line.length === 0
    || line.length > MAX_PATH_LENGTH
    || line.includes("\n")
    || !path.isAbsolute(line)
    || /[\u0000-\u001f\u007f]/u.test(line)
  ) {
    return undefined;
  }
  return line;
}

/** First PATH entry holding a readable regular file named `pi`, realpathed. */
function findPiOnPath(env) {
  for (const rawEntry of `${env.PATH ?? ""}`.split(path.delimiter)) {
    if (!rawEntry) continue; // an empty PATH entry would mean the current directory: never searched
    const candidate = path.join(rawEntry, "pi");
    try {
      // POSIX npm bin entries are commonly symlinks. Canonicalize first, then
      // positively validate the regular target; the package/bin checks below
      // still decide whether that target is the public Pi CLI.
      const canonical = fs.realpathSync(candidate);
      lstatRegularFile(canonical);
      fs.accessSync(canonical, fs.constants.R_OK);
      return canonical;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The enclosing public pi package of a resolved PATH file: the first
 * package.json walking up from the file's directory must name the public pi
 * package. Bounded depth; no directory scans.
 */
function enclosingPiPackage(file) {
  let dir = path.dirname(file);
  for (let depth = 0; depth < 16; depth += 1) {
    const manifestPath = path.join(dir, "package.json");
    if (pathExists(manifestPath)) {
      try {
        const manifest = JSON.parse(readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES).toString("utf8"));
        if (manifest && manifest.name === PI_PACKAGE_NAME) return dir;
      } catch {
        // An unreadable manifest is not a positive identity: stop here.
      }
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Provision a pinned isolated Pi runtime. Existing partial or invalid version
 * roots remain untouched. Fresh staging is exclusively created and identity
 * checked; publication is admitted only after validating the resulting public
 * package and never replaces an existing version root.
 */
async function validateCachedPiRuntime(versionRoot, targetPkgDir, env, expectedIdentity, expectedParentChain, processRunner = runBoundedProcess, version = PI_PROVISION_VERSION) {
  if (expectedParentChain && !directoryChainIsSame(expectedParentChain)) {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} has a changed parent identity; preserving it`);
  }
  let identity;
  try {
    identity = identityOfDirectory(versionRoot);
  } catch {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} is partial or unsafe; preserving it`);
  }
  if (expectedIdentity && !sameDirectoryIdentity(versionRoot, expectedIdentity)) {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} changed before validation; preserving it`);
  }
  if (!pathExists(targetPkgDir)) {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} is partial or unknown; preserving it`);
  }
  let packageDirectoryChain;
  try {
    packageDirectoryChain = assertDirectoryChain(versionRoot, path.dirname(targetPkgDir));
  } catch {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} is partial or unsafe; preserving it`);
  }
  let validated;
  try {
    validated = await validatePiPackage(targetPkgDir, env, { exactVersion: version, processRunner });
  } catch (error) {
    if (error && error.cleanupUnconfirmed) throw error;
    throw new PiRuntimeError(`the cached pi runtime at ${targetPkgDir} is invalid; preserving it`);
  }
  if (!sameDirectoryIdentity(versionRoot, identity)
    || (expectedIdentity && !sameDirectoryIdentity(versionRoot, expectedIdentity))
    || !directoryChainIsSame(packageDirectoryChain)
    || (expectedParentChain && !directoryChainIsSame(expectedParentChain))) {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} changed during validation; preserving it`);
  }
  try {
    assertDirectoryChain(versionRoot, path.dirname(targetPkgDir));
  } catch {
    throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} is partial or unsafe; preserving it`);
  }
  return { ...validated, source: PI_MANAGED_DEFAULT_SOURCE };
}

async function provisionPiRuntime(options) {
  const { env, agentDir, writeError, npmCli, beforeVersionRootMkdir } = options;
  const executeNpm = options.runNpm || runNpm;
  const processRunner = options.processRunner || runBoundedProcess;
  // Internal version-upgrade fixture seam; the CLI remains pinned.
  const version = options.provisionVersion || PI_PROVISION_VERSION;
  if (!parseStableVersion(version)) throw new PiRuntimeError("invalid isolated Pi runtime version");
  const validatePackage = options.validatePiPackage || ((pkgDir, validationEnv, validationOptions = {}) => validatePiPackage(
    pkgDir,
    validationEnv,
    { ...validationOptions, processRunner },
  ));
  const runtimeRoot = path.join(agentDir, RUNTIME_CACHE_DIRNAME, PI_RUNTIME_DIRNAME);

  let runtimeChain;
  try {
    runtimeChain = ensureDirectoryTree(runtimeRoot);
  } catch {
    throw new PiRuntimeError(`could not access the isolated pi runtime cache under ${runtimeRoot}`);
  }
  const warn = (message) => writeError(`pi-review-sessions: ${message}.\n`);
  const leaseStateRoot = sharedApplicationStateRoot(agentDir);
  // A compatible reuse or a settled provisioning pass runs the same bounded,
  // coordinated cleanup-only pass: target five, the generation this launch is
  // using is never a candidate, and leases are snapshotted while holding the
  // same coordination entry every consumer publishes under.
  const cleanupAround = async (selectedRoot) => {
    if (sharedEnsureApplicationStateDirectory(agentDir) === undefined) {
      warn("the Pi runtime state directory is unavailable; leaving Pi runtime generations untouched");
      return;
    }
    const lock = await sharedAcquireCleanupLock(leaseStateRoot);
    if (!lock) {
      warn("cleanup coordination was unavailable; leaving Pi runtime generations untouched");
      return;
    }
    try {
      const leased = sharedLeasedRoots(leaseStateRoot);
      if (!leased.complete) {
        warn("the consumer lease inventory was incomplete; leaving Pi runtime generations untouched");
        return;
      }
      generations.cleanup(runtimeRoot, {
        keep: [selectedRoot],
        preserve: (root) => leased.roots.has(path.resolve(root)),
        warn,
      });
    } catch (error) {
      warn(`cache cleanup could not complete (${error && error.message}); the runtime is unaffected`);
    } finally {
      lock.release();
    }
  };
  const fixedBase = `pi-${version}`;
  const numberedIndex = (name) => (name === fixedBase ? -1 : Number(name.slice(fixedBase.length + 1)));
  // Compatible reuse first: any existing valid generation for this exact
  // version is reused (fixed name preferred, then numbered fallbacks). This is
  // a read-only selection and never creates or removes anything.
  let reusableNames = [];
  try {
    reusableNames = fs.readdirSync(runtimeRoot)
      .filter((name) => name === fixedBase
        || (name.startsWith(`${fixedBase}.`) && /^\d+$/u.test(name.slice(fixedBase.length + 1))))
      .sort((left, right) => numberedIndex(left) - numberedIndex(right));
  } catch {
    // A best-effort reuse scan; provisioning below still runs.
  }
  for (const name of reusableNames) {
    const versionRoot = path.join(runtimeRoot, name);
    let existing;
    try {
      existing = identityOfDirectory(versionRoot);
    } catch {
      continue;
    }
    try {
      const validated = await validateCachedPiRuntime(
        versionRoot,
        path.join(versionRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
        env,
        existing,
        runtimeChain,
        processRunner,
        version,
      );
      const lease = await leaseManagedPiRuntime(versionRoot, { leasePid: options.leasePid, warn });
      await cleanupAround(versionRoot);
      return { ...validated, lease, managedRoot: versionRoot };
    } catch (error) {
      if (error.cleanupUnconfirmed) throw error;
    }
  }
  // Provisioning: the fixed root is preferred, then confined numbered
  // generations without a fixed candidate limit. Cache residue and cleanup
  // uncertainty therefore cannot stop startup.
  for (let index = 0; ; index += 1) {
    const candidateName = index === 0 ? fixedBase : `${fixedBase}.${index}`;
    const versionRoot = path.join(runtimeRoot, candidateName);
    const targetNodeModules = path.join(versionRoot, "node_modules");
    const targetPkgDir = path.join(targetNodeModules, "@earendil-works", "pi-coding-agent");
    let replacement;
    if (pathExists(versionRoot)) {
      let existing;
      try {
        existing = identityOfDirectory(versionRoot);
      } catch {
        // An unsafe/foreign version root is preserved and fails closed rather
        // than being silently replaced by another generation.
        throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} is partial or unsafe; preserving it`);
      }
      try {
        const validated = await validateCachedPiRuntime(versionRoot, targetPkgDir, env, existing, runtimeChain, processRunner, version);
        const lease = await leaseManagedPiRuntime(versionRoot, { leasePid: options.leasePid, warn });
        await cleanupAround(versionRoot);
        return { ...validated, lease, managedRoot: versionRoot };
      } catch (error) {
        if (error.cleanupUnconfirmed) throw error;
        // A published runtime (or one that cannot be retried without npm) is
        // preserved with its truthful validation error. Only a settled
        // incomplete setup root is retried, and possibly replaced by a fallback.
        if (!npmCli || pathExists(targetNodeModules)) throw error;
        replacement = {
          root: versionRoot,
          identity: existing,
          eligible: () => {
            try { fs.lstatSync(targetNodeModules); return false; }
            catch (cause) { return cause.code === "ENOENT"; }
          },
        };
      }
    }
    if (!npmCli) throw new PiRuntimeError("the public npm Node CLI is not available on PATH; cannot provision Pi");

    let ownedStage;
    let published = false;
    try {
      ownedStage = generations.admit(runtimeRoot, () => {
        if (!directoryChainIsSame(runtimeChain)) throw new Error("runtime parent changed");
        if (typeof beforeVersionRootMkdir === "function") beforeVersionRootMkdir(versionRoot);
        fs.mkdirSync(versionRoot, { mode: 0o700 });
        const identity = identityOfDirectory(versionRoot);
        return { root: versionRoot, identity, parentChain: runtimeChain, chain: [...runtimeChain, { target: versionRoot, identity }] };
      // Admission never reclaims: a lease snapshot taken here could miss a
      // consumer that publishes while the admission entry is held. The
      // coordinated, lease-aware settlement pass below runs after the fresh
      // runtime is published and leased (same boundary as application prep).
      }, { replacement, warn, reclaim: false });
      if (!directoryChainIsSame(runtimeChain) || !directoryChainIsSame(ownedStage.parentChain)) {
        const error = new PiRuntimeError(`the pi runtime cache parent changed during staging under ${runtimeRoot}`);
        error.cleanupUnconfirmed = true;
        throw error;
      }
    } catch (error) {
      if (error && error.cleanupUnconfirmed) throw error;
      if (error && error.code === "EEXIST") {
        // The destination still exists because cleanup could not reclaim it;
        // try the next confined generation rather than stopping startup.
        warn(`could not reclaim ${versionRoot}; provisioning a fresh confined Pi generation`);
        continue;
      }
      if (error && error.retainedStage) {
        const retained = new PiRuntimeError("the Pi runtime staging directory identity could not be confirmed; preserving the stage");
        retained.cleanupUnconfirmed = true;
        throw retained;
      }
      throw new PiRuntimeError(`could not reserve pi runtime generation: ${error.message}`);
    }
    try {
      // Keep npm's partial node_modules invisible to cache-hit selection until
      // validation and atomic in-generation publication. This is NOT another
      // capacity root; all residue stays within the single reserved generation.
      const stagingRoot = path.join(ownedStage.root, ".setup");
      fs.mkdirSync(stagingRoot, { mode: 0o700 });
      const setupIdentity = identityOfDirectory(stagingRoot);
      const setupStage = { root: stagingRoot, chain: [...ownedStage.chain, { target: stagingRoot, identity: setupIdentity }] };
      const installEnv = stageNpmEnvironment(env, setupStage);
      const install = await executeNpm(npmCli, [
        "install",
        "--prefix", stagingRoot,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry", "https://registry.npmjs.org",
        `${PI_PACKAGE_NAME}@${version}`,
      ], {
        env: installEnv,
        cwd: stagingRoot,
        timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      });
      if (install.error || install.status !== 0 || install.signal || install.timedOut || install.outputExceeded || install.cleanupConfirmed === false) {
        let result = "could not start";
        if (install.cleanupConfirmed === false) result = "cleanup was not confirmed";
        else if (install.timedOut) result = "timed out";
        else if (install.signal) result = `was terminated by ${install.signal}`;
        else if (Number.isInteger(install.status)) result = `exited with status ${install.status}`;
        throw new PiRuntimeError(`pi runtime provisioning failed (npm install ${result}); re-run the launcher`);
      }
      if (!directoryChainIsSame(setupStage.chain)) {
        throw new PiRuntimeError("the pi runtime staging directory chain changed during installation");
      }
      const stagedPkgDir = path.join(stagingRoot, "node_modules", "@earendil-works", "pi-coding-agent");
      const stagedPackageChain = assertDirectoryChain(stagingRoot, stagedPkgDir);
      const stagedNodeModulesPath = path.join(stagingRoot, "node_modules");
      const stagedNodeModulesEntry = stagedPackageChain.find(({ target }) => target === stagedNodeModulesPath);
      if (!stagedNodeModulesEntry) throw new PiRuntimeError("the staged pi package has no positively identified node_modules root");
      await validatePackage(stagedPkgDir, env, { exactVersion: version });
      if (!directoryChainIsSame(setupStage.chain) || !directoryChainIsSame(stagedPackageChain) || pathExists(targetNodeModules)) {
        throw new PiRuntimeError("the pi runtime staging identity changed during validation");
      }
      fs.renameSync(stagedNodeModulesPath, targetNodeModules);
      if (!directoryChainIsSame(ownedStage.chain) || !sameDirectoryIdentity(targetNodeModules, stagedNodeModulesEntry.identity)) {
        throw new PiRuntimeError("the pi runtime publication identity changed");
      }

      const result = await validateCachedPiRuntime(versionRoot, targetPkgDir, env, ownedStage.identity, runtimeChain, processRunner, version);
      // Publish this consumer's lease before the producer's in-flight protection
      // is released, so there is no instant where the fresh runtime is both
      // unprotected and reclaimable.
      const lease = await leaseManagedPiRuntime(versionRoot, { leasePid: options.leasePid, warn });
      writeError(`pi-review-sessions: installed isolated Pi ${version} runtime at ${runtimeRoot}\n`);
      published = true;
      return { ...result, source: PI_MANAGED_DEFAULT_SOURCE, lease, managedRoot: versionRoot };
    } finally {
      if (!published) {
        // Retained incomplete setup is disposable by location and is reclaimed by
        // the next producer cleanup; nothing here can block a later start.
        writeError("pi-review-sessions: retained an incomplete Pi runtime generation; the next launch reclaims excess cache generations.\n");
      }
      ownedStage.generation.release();
      // Settlement retries cleanup that contention deferred while this producer
      // was still installing, keeping the generation it just produced.
      await cleanupAround(versionRoot);
    }
  }
}

// ---------------------------------------------------------------------------
// Completed Pi discovery (issue 344): a current launch must not run `npm root
// -g`, a `pi --version` probe, or a managed-runtime cleanup. The completed
// selection is cached with bounded package/path metadata and validated cheaply.
// A managed-default record additionally carries this build's provisioned pin
// (validatePiDiscovery), so moving the default invalidates only that stale
// implicit fallback and never an explicit, global, or PATH selection.
// ---------------------------------------------------------------------------

const PI_DISCOVERY_MARKER = "pi-runtime.json";
const MAX_PI_DISCOVERY_BYTES = 16 * 1024;

/** The agent directory that owns one managed Pi cache (cross-agent safe). */
function managedPiOwnerStateRoot(managedRoot) {
  const agentDirectory = path.dirname(path.dirname(path.dirname(path.resolve(managedRoot))));
  return sharedApplicationStateRoot(agentDirectory);
}

function piDiscoveryKey(explicit, env, platform, cwd = process.cwd()) {
  return {
    platform,
    explicit: explicit === undefined ? null : explicit,
    path: String(env.PATH ?? ""),
    // A relative explicit path means different files from different working
    // directories, and a PATH alias can be retargeted without changing PATH.
    // Both are part of the selection identity.
    cwd: path.resolve(cwd),
    pathSelection: explicit === undefined ? (findPiOnPath(env) ?? null) : null,
  };
}

function fileIdentityOf(file) {
  try {
    const stats = fs.lstatSync(file, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return {
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
    };
  } catch {
    return null;
  }
}

function identityMatchesRecord(identity, record) {
  return identity !== null
    && record !== null
    && typeof record === "object"
    && identity.dev === record.dev
    && identity.ino === record.ino
    && identity.size === record.size
    && identity.mtimeNs === record.mtimeNs;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePiDiscovery(value, key) {
  return isRecord(value)
    && value.schema === sharedApplicationSchema
    && value.platform === key.platform
    && value.explicit === key.explicit
    && value.path === key.path
    && value.cwd === key.cwd
    && value.pathSelection === key.pathSelection
    && typeof value.file === "string"
    && path.isAbsolute(value.file)
    && typeof value.version === "string"
    && value.version.length <= 64
    && typeof value.source === "string"
    && isRecord(value.identity)
    && (value.managedRoot === undefined || (typeof value.managedRoot === "string" && path.isAbsolute(value.managedRoot)))
    // A completed managed-default discovery stands for this build's own
    // provisioned pin, so its version is part of its identity: a record written
    // under an older default must not silently keep launching that older
    // runtime. Explicit, npm-global, and PATH records are user-owned selections
    // and keep their own cached identity, so a valid older explicit selection
    // still reuses. Nothing is purged: the next launch revalidates, provisions
    // the current pin, and republishes the record.
    && (value.source !== PI_MANAGED_DEFAULT_SOURCE || value.version === PI_PROVISION_VERSION);
}

/**
 * Lease one managed runtime under its OWNING cache's coordination domain, so a
 * cross-agent selection is protected too. Selection + lease publication are
 * atomic against every destructive Pi cleanup route, which takes the same
 * entry before snapshotting leases and deleting. A lease that cannot be
 * published is a hard failure: unprotected runtime code is never used.
 */
async function leaseManagedPiRuntime(managedRoot, options = {}) {
  const agentDirectory = path.dirname(path.dirname(path.dirname(path.resolve(managedRoot))));
  const stateRoot = managedPiOwnerStateRoot(managedRoot);
  if (sharedEnsureApplicationStateDirectory(agentDirectory) === undefined) {
    const error = new PiRuntimeError("the managed Pi runtime state directory is unavailable; refusing to use an unprotected runtime");
    error.leaseUnavailable = true;
    throw error;
  }
  const lock = await sharedAcquireCleanupLock(stateRoot);
  if (!lock) {
    const error = new PiRuntimeError("the managed Pi runtime coordination entry is unavailable; refusing to use an unprotected runtime");
    error.leaseUnavailable = true;
    throw error;
  }
  try {
    // The selection was validated before awaiting this entry; a concurrent
    // cleanup may have reclaimed it in the meantime. Revalidate inside the
    // lock, immediately before publication.
    const changedBeforeLeasing = () => {
      // A selection that changed after validation must fail the launch, never be
      // treated as a cache miss that silently falls back to another selection.
      const error = new PiRuntimeError("the selected managed Pi runtime changed before leasing");
      error.leaseUnavailable = true;
      return error;
    };
    try {
      assertDirectoryChain(agentDirectory, managedRoot);
    } catch {
      throw changedBeforeLeasing();
    }
    if (typeof options.revalidate === "function" && options.revalidate() !== true) {
      throw changedBeforeLeasing();
    }
    const lease = publishSharedConsumerLease(stateRoot, managedRoot, options.leasePid ?? process.pid);
    if (!lease) {
      const error = new PiRuntimeError("the managed Pi runtime could not be leased; refusing to use an unprotected runtime");
      error.leaseUnavailable = true;
      throw error;
    }
    return lease;
  } finally {
    lock.release();
  }
}

/** One coordinated, lease-aware Pi runtime cleanup pass. */
async function cleanupManagedPiRuntime(managedRoot, options = {}) {
  const managed = managedPiGeneration(managedRoot);
  if (!managed) return;
  const agentDirectory = path.dirname(path.dirname(path.dirname(path.resolve(managedRoot))));
  const stateRoot = managedPiOwnerStateRoot(managedRoot);
  if (sharedEnsureApplicationStateDirectory(agentDirectory) === undefined) {
    if (typeof options.warn === "function") options.warn("the Pi runtime state directory is unavailable; leaving Pi runtime generations untouched");
    return;
  }
  const lock = await sharedAcquireCleanupLock(stateRoot);
  if (!lock) {
    if (typeof options.warn === "function") options.warn("cleanup coordination was unavailable; leaving Pi runtime generations untouched");
    return;
  }
  try {
    const leased = sharedLeasedRoots(stateRoot);
    if (!leased.complete) {
      if (typeof options.warn === "function") options.warn("the consumer lease inventory was incomplete; leaving Pi runtime generations untouched");
      return;
    }
    generations.cleanup(managed.cacheRoot, {
      keep: [managedRoot],
      preserve: (root) => leased.roots.has(path.resolve(root)),
      warn: typeof options.warn === "function" ? options.warn : undefined,
    });
  } catch (error) {
    if (typeof options.warn === "function") {
      options.warn(`cache cleanup could not complete (${error && error.message}); the selected runtime is unaffected`);
    }
  } finally {
    lock.release();
  }
}

/** Validate a completed discovery without spawning anything. */
async function readCompletedPiDiscovery(options) {
  const { explicit, env, agentDir, platform } = options;
  const stateRoot = sharedApplicationStateRoot(agentDir);
  const key = piDiscoveryKey(explicit, env, platform, options.cwd);
  let record;
  try {
    record = sharedReadMarker(stateRoot, PI_DISCOVERY_MARKER, (value) => validatePiDiscovery(value, key), MAX_PI_DISCOVERY_BYTES);
  } catch {
    record = undefined;
  }
  if (!record && typeof explicit === "string" && path.isAbsolute(explicit)) {
    // The ownership handoff re-selects the already validated managed CLI by its
    // explicit path. Reuse that completed discovery rather than running another
    // npm-root/version probe, while still re-checking the file identity and
    // package metadata under the hold.
    try {
      record = sharedReadMarker(stateRoot, PI_DISCOVERY_MARKER, (value) => isRecord(value)
        && value.schema === sharedApplicationSchema
        && value.file === explicit
        && typeof value.version === "string"
        && typeof value.source === "string"
        && isRecord(value.identity)
        && (value.managedRoot === undefined || path.isAbsolute(value.managedRoot)), MAX_PI_DISCOVERY_BYTES);
    } catch {
      record = undefined;
    }
  }
  if (!record) return null;
  const revalidate = () => {
    try {
      if (record.managedRoot !== undefined) {
        assertDirectoryChain(record.managedRoot, path.dirname(record.file));
      }
      if (!identityMatchesRecord(fileIdentityOf(record.file), record.identity)) return false;
      const pkgDir = enclosingPiPackage(record.file);
      if (!pkgDir) return false;
      const manifest = JSON.parse(readBoundedRegularFile(path.join(pkgDir, "package.json"), MAX_MANIFEST_BYTES).toString("utf8"));
      return Boolean(manifest && manifest.name === PI_PACKAGE_NAME && manifest.version === record.version);
    } catch {
      return false;
    }
  };
  if (!revalidate()) return null;
  if (record.managedRoot !== undefined) {
    const managed = managedPiGeneration(record.file);
    if (!managed || path.resolve(managed.root) !== path.resolve(record.managedRoot)) return null;
    const lease = await leaseManagedPiRuntime(record.managedRoot, { leasePid: options.leasePid, revalidate });
    return { file: record.file, version: record.version, source: record.source, lease, managedRoot: record.managedRoot };
  }
  return { file: record.file, version: record.version, source: record.source };
}

/** Publish the completed discovery atomically (best effort; never blocks a launch). */
function writeCompletedPiDiscovery(options, resolved) {
  let identity;
  try {
    identity = fileIdentityOf(resolved.file);
  } catch {
    return;
  }
  if (!identity) return;
  const managed = resolved.managedRoot
    ? { managedRoot: resolved.managedRoot }
    : (managedPiGeneration(resolved.file) ? { managedRoot: managedPiGeneration(resolved.file).root } : {});
  try {
    sharedWriteMarker(sharedApplicationStateRoot(options.agentDir), PI_DISCOVERY_MARKER, {
      schema: sharedApplicationSchema,
      ...piDiscoveryKey(options.explicit, options.env, options.platform, options.cwd),
      file: resolved.file,
      identity,
      version: resolved.version,
      source: resolved.source,
      ...managed,
      completedAt: new Date().toISOString(),
    }, MAX_PI_DISCOVERY_BYTES);
  } catch {
    // A discovery record that cannot be written simply means the next launch
    // revalidates; the selection itself is unaffected.
  }
}

// Recognize only ancestors of the selected canonical path, never a global
// cache inventory. This also covers an explicitly selected generation in a
// different agent directory and global/PATH aliases into a managed runtime.
function managedPiGeneration(candidate) {
  let root = path.resolve(candidate);
  const nameIs = (value, expected) => process.platform === "win32"
    ? value.toLowerCase() === expected.toLowerCase() : value === expected;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = path.dirname(root);
    if (nameIs(path.basename(parent), PI_RUNTIME_DIRNAME)
      && nameIs(path.basename(path.dirname(parent)), RUNTIME_CACHE_DIRNAME)) return { root, cacheRoot: parent };
    if (parent === root) break;
    root = parent;
  }
  return undefined;
}

async function withManagedPiSelection(candidate, processRunner, validate, options = {}) {
  let canonical;
  try { canonical = fs.realpathSync(candidate); }
  catch { canonical = path.resolve(candidate); } // Missing paths still fail the existing validator.
  const managed = managedPiGeneration(canonical);
  if (!managed) return validate(processRunner);
  let selected;
  try {
    selected = generations.pin(managed.cacheRoot, () => ({
      root: managed.root,
      identity: identityOfDirectory(managed.root),
      chain: assertDirectoryChain(path.parse(managed.root).root, managed.root),
    }));
  } catch {
    throw new PiRuntimeError("the selected managed Pi runtime is unavailable or outside its cache; preserving it");
  }
  // Protect the selected generation before any validation work. The lease is
  // published under the owning cache's coordination entry, the same boundary
  // every destructive Pi cleanup takes before snapshotting leases, so a
  // concurrent cleanup cannot delete a runtime between selection and leasing.
  const lease = await leaseManagedPiRuntime(managed.root, {
    leasePid: options.leasePid,
    warn: options.warn,
  });
  const guardedRunner = (file, args, options) => {
    // Validate aliases against the selected root again at the actual execution
    // boundary. A retargeted global/package alias cannot probe a sibling
    // generation. Existing package/version validation stays authoritative.
    const cli = fs.realpathSync(args[0]);
    const relative = path.relative(managed.root, cli);
    if (!sameDirectoryIdentity(managed.root, selected.selected.identity)
      || !directoryChainIsSame(selected.selected.chain)
      || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PiRuntimeError("the selected managed Pi runtime changed before its version probe; preserving it");
    }
    return processRunner(file, args, options);
  };
  let validated;
  try {
    validated = await validate(guardedRunner);
  } catch (error) {
    lease.release();
    throw error;
  }
  // A validated reuse advances pending cleanup toward the per-type target under
  // the coordinated lease snapshot; the selected generation is never a candidate.
  await cleanupManagedPiRuntime(managed.root, { warn: options.warn });
  return { ...validated, lease, managedRoot: managed.root };
}

/**
 * Resolve the public supported Pi CLI entry (issue 323). Order: explicit
 * --pi-executable (validated, no fallback), npm global package root, PATH
 * `pi` inside the public package, isolated cache provisioning. Returns
 * { file, version, source }; throws PiRuntimeError with a bounded message.
 */
async function resolvePiRuntimeUncached(options) {
  const { explicit, env, agentDir, cwd, writeError } = options;
  const processRunner = options.processRunner || runBoundedProcess;
  const warnCache = (message) => writeError(`pi-review-sessions: ${message}.\n`);

  if (explicit !== undefined) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
    let canonical;
    try {
      const stats = fs.lstatSync(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new PiRuntimeError("not a regular file");
      const access = fs.constants.R_OK | (process.platform === "win32" ? 0 : fs.constants.X_OK);
      fs.accessSync(candidate, access);
      canonical = fs.realpathSync(candidate);
    } catch {
      throw new PiRuntimeError(`the configured pi executable is not a regular readable file: ${candidate}`);
    }
    return withManagedPiSelection(canonical, processRunner, async (runner) => {
      const head = readHeadBytes(canonical, NODE_ENTRY_HEAD_BYTES);
      if (!head || head.length < 2 || !isNodeEntryShebang(head)) {
        throw new PiRuntimeError(`the configured pi executable is not a positive Node entry (expected the standard npm-installed pi CLI entry file): ${canonical}`);
      }
      // A selection inside a managed `pi-runtime` generation is validated by the
      // same package authority used for installed packages: a partially reclaimed
      // generation that still has a runnable CLI must not be accepted. Unmanaged
      // explicit selections keep the CLI/version behavior unchanged.
      const managed = managedPiGeneration(canonical);
      if (managed) {
        const pkgDir = path.join(managed.root, "node_modules", "@earendil-works", "pi-coding-agent");
        assertDirectoryChain(managed.root, path.dirname(pkgDir));
        return {
          ...await validatePiPackage(pkgDir, env, { expectedFile: canonical, processRunner: runner }),
          source: "explicit",
        };
      }
      const version = await probePiVersion(canonical, env, runner);
      return { file: canonical, version, source: "explicit" };
    }, { warn: warnCache, agentDir, leasePid: options.leasePid });
  }

  const npmCli = findNpmCli(env);
  const globalRoot = npmCli ? await npmGlobalRoot(env, npmCli) : undefined;
  if (globalRoot) {
    const pkgDir = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (pathExists(pkgDir)) {
      try {
        return await withManagedPiSelection(pkgDir, processRunner, async (runner) => ({
          ...await validatePiPackage(pkgDir, env, { processRunner: runner }), source: "npm-global",
        }), { warn: warnCache, agentDir, leasePid: options.leasePid });
      } catch (error) {
        if (error && error.cleanupUnconfirmed) throw error;
        // An unsupported or corrupt global install falls through to PATH and
        // then to the isolated cache; it is never modified.
      }
    }
  }

  const onPath = findPiOnPath(env);
  if (onPath) {
    const pkgDir = enclosingPiPackage(onPath);
    if (pkgDir) {
      try {
        return await withManagedPiSelection(onPath, processRunner, async (runner) => ({
          ...await validatePiPackage(pkgDir, env, { expectedFile: onPath, processRunner: runner }), source: "path",
        }), { warn: warnCache, agentDir, leasePid: options.leasePid });
      } catch (error) {
        if (error && error.cleanupUnconfirmed) throw error;
        // Not positively identified as the public package: fall through.
      }
    }
  }

  writeError(`pi-review-sessions: no supported pi installation found; provisioning isolated Pi ${PI_PROVISION_VERSION} runtime\n`);
  return provisionPiRuntime({ env, agentDir, writeError, npmCli, leasePid: options.leasePid });
}

/**
 * Resolve the supported Pi CLI, reusing a completed discovery without spawning
 * anything when the recorded selection is still current for this exact
 * explicit/PATH/platform context. A cache miss falls back to full validation
 * and provisioning; the completed result (including any managed-runtime lease)
 * is then recorded for later launches.
 */
async function resolvePiRuntime(options) {
  const platform = options.platform || process.platform;
  let cached = null;
  try {
    cached = await readCompletedPiDiscovery({ ...options, platform });
  } catch (error) {
    if (error && error.leaseUnavailable) throw error;
    cached = null;
  }
  if (cached) return cached;
  const resolved = await resolvePiRuntimeUncached(options);
  writeCompletedPiDiscovery({ ...options, platform }, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Launcher flow
// ---------------------------------------------------------------------------

async function runDdgsSetup(homeDir, env, packageRoot, processRunner = runBoundedProcess) {
  const helperPath = path.join(packageRoot, "scripts", "pi-review-gate-launcher.cjs");
  const wrapper = [
    'const helper = require(process.argv[1]);',
    'const result = helper.ensureDdgs(process.argv[2], process.env);',
    'const safe = result && result.ok === true',
    '  ? { ok: true, python: result.python }',
    '  : { ok: false, exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : 1 };',
    'process.stdout.write(JSON.stringify(safe));',
  ].join("\n");
  const result = await processRunner(process.execPath, ["-e", wrapper, helperPath, homeDir], {
    cwd: packageRoot,
    env,
    timeoutMs: DDGS_SETUP_TIMEOUT_MS,
    maxOutputBytes: 8 * 1024,
    captureStdout: true,
  });
  if (result.cleanupConfirmed === false) return { ok: false, exitCode: statusCode(result), cleanupUnconfirmed: true };
  if (result.timedOut) return { ok: false, exitCode: 124 };
  if (result.outputExceeded) return { ok: false, exitCode: 1 };
  if (result.error || result.signal || result.status !== 0) return { ok: false, exitCode: statusCode(result) };
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && parsed.ok === true && typeof parsed.python === "string" && path.isAbsolute(parsed.python)) {
      return { ok: true, python: parsed.python };
    }
    if (parsed && parsed.ok === false && Number.isInteger(parsed.exitCode) && parsed.exitCode >= 0 && parsed.exitCode <= 255) {
      return { ok: false, exitCode: parsed.exitCode };
    }
  } catch {
    // A malformed result is a bounded setup failure, never a native exit.
  }
  return { ok: false, exitCode: 1 };
}

function defaultDependencies() {
  return {
    getEnv: () => process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    packageRoot: path.resolve(__dirname, ".."),
    cwd: process.cwd(),
    // One shared current/update decision for every launcher (issue 344). The
    // application, DDGS environment, and shipped skills are current or are
    // prepared automatically inside this single call; a current start does no
    // install, build, staging, inventory, Python probe, skill copy, or cleanup.
    prepareApplication: (options) => {
      // Wrapper-equivalent component home (issue 344/378): on native Windows the
      // wrapper resolves the skills/DDGS home with Pi's own os.homedir()
      // semantics (USERPROFILE), which can differ from the flow's HOME. POSIX
      // keeps the setup HOME.
      const componentHome = options.platform === "win32" ? os.homedir() : options.homeDir;
      return prepareLaunch({
        ...options,
        ...(typeof options.prepare === "function" ? { prepare: options.prepare } : {}),
        homeDir: componentHome,
        // DDGS provisioning keeps its bounded, killable setup-process semantics:
        // only the helper's JSON result crosses back, and bootstrap/restore values
        // are absent from the setup environment. The helper itself comes from the
        // SELECTED prepared root, so code and resources stay paired.
        provisionDdgs: options.provisionDdgs
          ?? ((preparedRoot) => runDdgsSetup(componentHome, options.env, preparedRoot)),
      });
    },
    resolvePiRuntime: (options) => resolvePiRuntime(options),
    isRegularFile,
    loadMain: (entry) => require(entry),
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    processEnv: process.env,
  };
}

/** Private orchestration seam used by tests; the public CLI never accepts dependency overrides. */
async function runSessionHostLauncher(argv, overrides = {}) {
  const deps = { ...defaultDependencies(), ...overrides };
  // Positive handoff only; the native wrapper still holds its Node pin until
  // the exact CJS process exits. Never expose this one-shot context to children.
  let parsed;
  try {
    parsed = parseSessionHostArguments(argv);
  } catch (error) {
    const message = error instanceof SessionHostArgumentError ? error.message : "Invalid pi-review-sessions arguments.";
    deps.writeError(`pi-review-sessions: ${message}\n`);
    return 2;
  }

  if (parsed.help) {
    deps.writeOut(`${USAGE}\n`);
    return 0;
  }

  const rawInheritedEnv = deps.getEnv();
  let inheritedEnv;
  try {
    // Snapshot Windows names case-insensitively before storage/role checks,
    // process.env scrubbing, or any setup child. Conflicting ordinary aliases
    // reject; nonempty role markers remain present for fail-closed rejection.
    inheritedEnv = snapshotSessionHostEnvironment(rawInheritedEnv, deps.platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid session host environment.";
    deps.writeError(`pi-review-sessions: ${message}\n`);
    return 1;
  }

  // Reject parent startup session overrides before any setup (build, Pi
  // runtime, DDGS, token, PTY): every created instance would inherit
  // them and open the same old chat/storage instead of a new native chat of
  // its own.
  try {
    assertSessionHostStartupOptions(parsed.args, inheritedEnv, deps.platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid pi-review-sessions startup options.";
    deps.writeError(`pi-review-sessions: ${message}\n`);
    return 2;
  }

  for (const name of ROLE_ENV_NAMES) {
    if (isNonempty(inheritedEnv[name])) {
      deps.writeError(`pi-review-sessions: unsupported role context (${name}).\n`);
      return 1;
    }
  }
  if (deps.platform !== "darwin" && deps.platform !== "linux" && deps.platform !== "win32") {
    deps.writeError("pi-review-sessions: the alpha session host supports macOS/Linux and Windows source admission only.\n");
    return 1;
  }
  if (!meetsNodeFloor(deps.nodeVersion)) {
    deps.writeError(nodeFloorRefusal(deps.nodeVersion));
    return 1;
  }
  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) {
    deps.writeError("pi-review-sessions: an interactive stdin and stdout are required.\n");
    return 1;
  }

  // Scrub inherited host bootstrap/restore/settlement values before build, Pi runtime
  // probes/provisioning, DDGS, and loading the compiled host. Preserve every
  // other user environment setting, including NODE_OPTIONS and provider
  // variables.
  const setupEnv = { ...inheritedEnv };
  for (const name of HOST_ENV_TO_CLEAR) delete setupEnv[name];
  if (rawInheritedEnv === deps.processEnv) {
    const hostEnvToClear = new Set(HOST_ENV_TO_CLEAR.map((name) => name.toUpperCase()));
    for (const name of Object.keys(deps.processEnv)) {
      if (hostEnvToClear.has(name.toUpperCase())) delete deps.processEnv[name];
    }
  }

  // Native Pi agent directory (honors PI_CODING_AGENT_DIR with Pi's native
  // semantics via the shared launcher helper): owns the isolated runtime
  // cache. The native Pi root and its normal storage semantics remain intact.
  const homeDir = isNonempty(inheritedEnv.HOME) ? inheritedEnv.HOME : os.homedir();
  // Anchor the agent directory against the startup cwd: a relative
  // PI_CODING_AGENT_DIR override must resolve to the same absolute location
  // for staging, provisioning, and every native child (which may change its
  // own working directory). A supplied override is normalized in setupEnv so
  // descendants inherit the anchored form.
  const agentDir = path.resolve(
    deps.cwd,
    gateLauncher.resolvePiAgentDir(setupEnv, { homeDir, platform: deps.platform }),
  );
  if (isNonempty(setupEnv.PI_CODING_AGENT_DIR)) {
    setupEnv.PI_CODING_AGENT_DIR = agentDir;
  }

  const packageRoot = path.resolve(deps.packageRoot);
  if ([homeDir, agentDir, packageRoot].some((value) => value.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(value))) {
    deps.writeError("pi-review-sessions: a required setup path is invalid or too long.\n");
    return 1;
  }
  // Issue 344: ONE shared current/update decision, identical to the Pi and web
  // wrappers. A current start reads the completed marker and stats only the
  // recorded application inputs — no install, build, staging, artifact scan,
  // Python validation, skill copy, or cache cleanup happens here. On a genuine
  // miss the shared authority prepares one isolated generation, publishes it
  // atomically after install/compile/provisioning succeeded, and hands back a
  // consumer lease so a concurrent update cannot reclaim the code this host is
  // running.
  let prepared;
  try {
    prepared = await deps.prepareApplication({
      packageRoot,
      agentDir,
      homeDir,
      platform: deps.platform,
      env: setupEnv,
      // Private producer/component seams (tests/diagnostics only): a supplied
      // build engine and component publisher still go through the shared
      // coherence, receipt, lease, and publication rules.
      ...(typeof deps.build === "function" ? { prepare: deps.build } : {}),
      ...(typeof deps.ensureDdgs === "function"
        ? { provisionDdgs: (preparedRoot) => deps.ensureDdgs(homeDir, setupEnv, preparedRoot) }
        : {}),
      ...(typeof deps.refreshShippedSkills === "function"
        ? { publishSkills: () => deps.refreshShippedSkills(packageRoot, homeDir) }
        : {}),
      writeError: (text) => deps.writeError(text),
    });
  } catch {
    deps.writeError("pi-review-sessions: application preparation failed.\n");
    return 1;
  }
  const preparedLease = prepared && prepared.lease;
  // A managed Pi runtime selected by this launcher is leased for the same
  // lifetime as the prepared generation it runs with.
  let piRuntimeLease;
  try {
    if (!prepared || prepared.mode === "failed") {
      deps.writeError("pi-review-sessions: application preparation failed.\n");
      return prepared && Number.isInteger(prepared.status) ? prepared.status : 1;
    }
    // The host's runtime file lookups (extension entry, reporter, preload,
    // native skill sources) resolve against this prepared root: a source
    // checkout's generation, or the installed package in packaged mode. The
    // live checkout's dist/ is never loaded or built into.
    const hostPackageRoot = prepared.preparedRoot;
    const compiledEntry = path.join(hostPackageRoot, "dist", "src", "session-host", "main.js");
    if (!deps.isRegularFile(compiledEntry)) {
      deps.writeError("pi-review-sessions: compiled native session host is unavailable.\n");
      return 2;
    }
    const python = prepared.ddgsPython;
    if (typeof python !== "string" || python.length > MAX_PATH_LENGTH || !path.isAbsolute(python) || /[\u0000-\u001f\u007f]/u.test(python)) {
      deps.writeError("pi-review-sessions: DDGS setup failed.\n");
      return 1;
    }

    // Resolve or provision the Pi runtime BEFORE any host capability exists:
    // probes and provisioning run on the scrubbed setup env, so no bootstrap/
    // restore token reaches them, and the resolved entry is handed to the host
    // as an explicit executable (never a bare PATH name).
    let piRuntime;
    try {
      piRuntime = await deps.resolvePiRuntime({
        explicit: parsed.piExecutable,
        env: setupEnv,
        agentDir,
        cwd: deps.cwd,
        writeError: (text) => deps.writeError(text),
      });
    } catch (error) {
      const message = error instanceof PiRuntimeError ? error.message : "Pi runtime selection failed.";
      deps.writeError(`pi-review-sessions: ${message}\n`);
      return 1;
    }
    if (!piRuntime || typeof piRuntime.file !== "string" || piRuntime.file.length > MAX_PATH_LENGTH || !path.isAbsolute(piRuntime.file) || typeof piRuntime.version !== "string" || piRuntime.version.length > 64) {
      deps.writeError("pi-review-sessions: Pi runtime selection failed.\n");
      return 1;
    }
    piRuntimeLease = piRuntime.lease;
    deps.writeError(`pi-review-sessions: pi runtime: ${piRuntime.file} (v${piRuntime.version}, ${piRuntime.source})\n`);

    // Coordinated selection/preparation handoff to host ownership (issue 385):
    // take the canonical per-agent coordination entry BEFORE the host-entry load
    // and the host's ownership claim, and hand it back once the host's exclusive
    // ownership record exists. Another preparation therefore cannot reclaim the
    // selection this launch is handing over. A live destructive holder is waited
    // for, not bypassed.
    const handoff = generations.holdAgentDirectory(agentDir);
    if (!handoff) {
      deps.writeError("pi-review-sessions: per-agent cache coordination was unavailable; this launch continues and the host's ownership record still stops cache reclamation once it exists.\n");
    }
    try {
      // Re-enter the launcher's normal validated selection for a managed Pi
      // runtime inside the same hold. The existing resolver/validator (managed
      // generation confinement, package/version validation, and the pinned CLI's
      // own version probe) rejects a partially reclaimed generation instead of
      // trusting a surviving CLI name. Installed, PATH, and user-explicit
      // selections are unchanged.
      if (managedPiGeneration(piRuntime.file)) {
        deps.writeError("pi-review-sessions: validating and preparing the Pi runtime again inside the ownership handoff\n");
        let resolved;
        try {
          resolved = await deps.resolvePiRuntime({
            explicit: piRuntime.file,
            env: setupEnv,
            agentDir,
            cwd: deps.cwd,
            writeError: (text) => deps.writeError(text),
          });
        } catch (error) {
          if (error && error.cleanupUnconfirmed) {
            deps.writeError("pi-review-sessions: Pi runtime validation cleanup was not confirmed; preserving its runtime.\n");
            return 1;
          }
          resolved = undefined;
        }
        if (!resolved) {
          try {
            resolved = await deps.resolvePiRuntime({
              explicit: parsed.piExecutable,
              env: setupEnv,
              agentDir,
              cwd: deps.cwd,
              writeError: (text) => deps.writeError(text),
            });
          } catch (error) {
            const message = error instanceof PiRuntimeError ? error.message : "Pi runtime selection failed.";
            deps.writeError(`pi-review-sessions: ${message}\n`);
            return 1;
          }
        }
        piRuntime = resolved;
        piRuntimeLease?.release();
        piRuntimeLease = resolved.lease;
      }
      if (!piRuntime || typeof piRuntime.file !== "string" || piRuntime.file.length > MAX_PATH_LENGTH
        || !path.isAbsolute(piRuntime.file) || typeof piRuntime.version !== "string" || piRuntime.version.length > 64) {
        deps.writeError("pi-review-sessions: Pi runtime selection failed.\n");
        return 1;
      }

      const hostEnv = { ...setupEnv, PI_REVIEW_GATE_DDGS_PYTHON: python };
      let hostModule;
      try {
        hostModule = deps.loadMain(compiledEntry);
      } catch {
        deps.writeError("pi-review-sessions: native session host startup failed.\n");
        return 1;
      }
      if (!hostModule || typeof hostModule.runSessionHost !== "function") {
        deps.writeError("pi-review-sessions: native session host startup failed.\n");
        return 1;
      }

      const hostOptions = {
        packageRoot: hostPackageRoot,
        piExecutable: piRuntime.file,
        ...(parsed.stateRoot !== undefined ? { stateRoot: parsed.stateRoot } : {}),
        ...(parsed.toggleKey !== undefined ? { toggleKey: parsed.toggleKey } : {}),
        args: Object.freeze(parsed.args.slice()),
        env: hostEnv,
      };
      try {
        const status = await hostModule.runSessionHost(hostOptions);
        if (Number.isInteger(status)) return status;
      } catch {
        // Do not expose arbitrary errors, argv, or native credentials in startup output.
      }
      deps.writeError("pi-review-sessions: native session host startup failed.\n");
      return 1;
    } finally {
      handoff?.release();
    }
  } finally {
    // Release these consumer leases only after the host they protect has exited.
    piRuntimeLease?.release();
    preparedLease?.release();
  }
}


if (require.main === module) {
  runSessionHostLauncher(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  }).catch(() => {
    process.stderr.write("pi-review-sessions: native session host startup failed.\n");
    process.exitCode = 1;
  });
}

module.exports = {
  USAGE,
  PI_PACKAGE_NAME,
  PI_MIN_VERSION,
  PI_PROVISION_VERSION,
  parseSessionHostArguments,
  // This seam is intentionally not consulted by the CLI and does not provide
  // an environment-variable bypass for role or preflight checks.
  __test: {
    runSessionHostLauncher,
    // Shared engine seams (issue 344): the same authoritative implementations the
    // launchers use, not a second path.
    buildSourceExtension: applicationBuildModule.prepareStagedApplication,
    stageSourcePackage: applicationBuildModule.stageSourcePackage,
    createOwnedStage: applicationBuildModule.createOwnedStage,
    activeBoundedProcessCount: applicationBuildModule.activeBoundedProcessCount,
    resolvePiRuntime,
    provisionPiRuntime,
    validatePiPackage,
    probePiVersion,
    runDdgsSetup,
    createOwnedStage,
    findNpmCli,
    findPiOnPath,
    runBoundedProcess,
    boundedProcessCleanupStatus,
    sanitizeDiagnosticText,
    boundDiagnosticText,
    formatBuildStageDiagnostics,
  },
};
