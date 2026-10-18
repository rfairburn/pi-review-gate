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
 *   supported installation exists, an isolated Pi 1.3.0 runtime is
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
const { spawn } = require("node:child_process");
const {
  assertSessionHostStartupOptions,
  snapshotSessionHostEnvironment,
} = require("./session-host-startup-options.cjs");
const gateLauncher = require("./pi-review-gate-launcher.cjs");
const generations = require("./managed-generations.cjs");

const USAGE = `Usage: pi-review-sessions [--pi-executable <path>] [--state-root <path>] [--sidebar-key <key>] [--help] [-- <Pi arguments...>]

Alpha same-machine macOS/Linux session host with Windows source paths available
for native validation only (not a Windows readiness claim). Requires Node >=22.19.0
and Pi >=1.0.4 with a positively identified Node CLI entry. Without --pi-executable the
launcher resolves the public @earendil-works/pi-coding-agent installation
(npm global root, then PATH) and, when none is supported, provisions an
isolated Pi 1.3.0 runtime cache under the native Pi agent directory; no
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
const MIN_NODE_VERSION = [22, 19, 0];

// Public Pi runtime identity (issue 323): the supported package and its
// exact provisioned version. The floor matches the native launch contract in
// src/session-host/launch.ts (Pi 1.0.4 minimum).
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_MIN_VERSION = [1, 0, 4];
const PI_PROVISION_VERSION = "1.3.0";
const RUNTIME_CACHE_DIRNAME = ".pi-review-gate";
const PI_RUNTIME_DIRNAME = "pi-runtime";

// Bounded probe/provision limits (mirrors src/session-host/launch.ts).
const VERSION_PROBE_MAX_BYTES = 8 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const NPM_ROOT_TIMEOUT_MS = 60_000;
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const SOURCE_BUILD_TIMEOUT_MS = 600_000;
// Admitted source build/install children capture both streams so a failure has
// a cause. The captured bytes share ONE hard ceiling (runBoundedProcess
// maxOutputBytes counts stdout+stderr together), and the retained diagnostic
// text is separately sanitized and re-bounded before it is emitted.
const SOURCE_BUILD_CAPTURE_MAX_BYTES = 256 * 1024;
const BUILD_DIAGNOSTIC_TEXT_MAX_BYTES = 4 * 1024;
const BUILD_STAGE_LABELS = {
  install: "npm ci (dependency install)",
  compile: "TypeScript compile (tsc -p tsconfig.json)",
  stage: "source stage preparation",
};
const DDGS_SETUP_TIMEOUT_MS = 600_000;
const PROCESS_KILL_GRACE_MS = 500;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NODE_ENTRY_HEAD_BYTES = 512;
const MAX_SOURCE_DEPTH = 64;
const MAX_SOURCE_FILES = 100_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SOURCE_FINGERPRINT_METADATA_BYTES = 32 * 1024 * 1024;
const SOURCE_COPY_CHUNK_BYTES = 64 * 1024;
const SOURCE_CACHE_MANIFEST = ".pi-review-gate-source-build.json";
const MAX_SOURCE_CACHE_RECORD_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 100_000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CACHE_MANIFEST_BYTES = 64 * 1024 * 1024;
const CACHE_SCAN_TIMEOUT_MS = 10_000;
const MAX_TOOLCHAIN_FILE_BYTES = 512 * 1024 * 1024;
let activeBoundedProcessCount = 0;
let cachedNodeToolchainIdentity;

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

function meetsNodeFloor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if (actual[index] > MIN_NODE_VERSION[index]) return true;
    if (actual[index] < MIN_NODE_VERSION[index]) return false;
  }
  return match[4] === undefined;
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

function sourceCopyBudget(testHooks) {
  return { files: 0, bytes: 0, entries: 0, startedAt: Date.now(), directories: [], testHooks };
}

function assertSourceCopyWithinBounds(budget) {
  if (!directoryChainIsSame(budget.directories)) {
    const error = new Error("source or destination directory changed during staging");
    error.preserveStage = true;
    throw error;
  }
  if (Date.now() - budget.startedAt > SOURCE_BUILD_TIMEOUT_MS) throw new Error("source copy elapsed deadline exceeded");
}

function copySourceFile(source, destination, budget) {
  assertSourceCopyWithinBounds(budget);
  const before = lstatRegularFile(source);
  if (before.size > BigInt(MAX_SOURCE_BYTES - budget.bytes)) throw new Error("source copy byte limit exceeded");
  budget.files += 1;
  if (budget.files > MAX_SOURCE_FILES) throw new Error("source copy file limit exceeded");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  assertSourceCopyWithinBounds(budget);
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | noFollow);
  let destinationFd;
  try {
    const opened = fs.fstatSync(sourceFd, { bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(before, opened)
      || !sameFileSnapshot(before, lstatRegularFile(source))) throw new Error("source file changed during staging");
    assertSourceCopyWithinBounds(budget);
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const destinationOpened = fs.fstatSync(destinationFd, { bigint: true });
    if (!destinationOpened.isFile() || !hasPositiveIdentity(destinationOpened)
      || !sameStatIdentity(destinationOpened, lstatRegularFile(destination))) {
      throw new Error("staged file identity is unavailable");
    }
    if (typeof budget.testHooks?.beforeSourceCopyRead === "function") {
      budget.testHooks.beforeSourceCopyRead(source, destination);
    }
    const buffer = Buffer.alloc(SOURCE_COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      assertSourceCopyWithinBounds(budget);
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      if (read > MAX_SOURCE_BYTES - budget.bytes) throw new Error("source copy byte limit exceeded");
      let written = 0;
      while (written < read) {
        assertSourceCopyWithinBounds(budget);
        written += fs.writeSync(destinationFd, buffer, written, read - written);
      }
      position += read;
      budget.bytes += read;
    }
    if (typeof budget.testHooks?.afterSourceCopyRead === "function") {
      budget.testHooks.afterSourceCopyRead(source, destination);
    }
    const after = fs.fstatSync(sourceFd, { bigint: true });
    assertSourceCopyWithinBounds(budget);
    if (!sameFileSnapshot(before, after)
      || !sameFileSnapshot(after, lstatRegularFile(source))) throw new Error("source file changed during staging");
    // POSIX execute/mode bits preserve source metadata for the local build.
    // Windows uses its ordinary inherited ACLs; Node mode bits are not a
    // privacy control there and are not treated as one.
    if (process.platform !== "win32") {
      const mode = Number(before.mode & 0o777n);
      fs.fchmodSync(destinationFd, 0o600 | (mode & 0o111));
    }
    const destinationAfter = fs.fstatSync(destinationFd, { bigint: true });
    const destinationPathStats = lstatRegularFile(destination);
    if (!sameStatIdentity(destinationOpened, destinationAfter)
      || !sameFileSnapshot(destinationAfter, destinationPathStats)
      || destinationAfter.size !== before.size) {
      throw new Error("staged file changed before publication");
    }
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function copySourceDirectory(source, destination, budget, depth, ownedStage) {
  if (depth > MAX_SOURCE_DEPTH) throw new Error("source copy depth limit exceeded");
  assertSourceCopyWithinBounds(budget);
  if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
  const before = identityOfDirectory(source);
  assertSourceCopyWithinBounds(budget);
  fs.mkdirSync(destination, { mode: 0o700 });
  const destinationIdentity = identityOfDirectory(destination);
  const parents = budget.directories;
  budget.directories = [
    ...parents,
    { target: source, identity: before },
    { target: destination, identity: destinationIdentity },
  ];
  let directory;
  try {
    assertSourceCopyWithinBounds(budget);
    directory = fs.opendirSync(source);
    if (!sameDirectoryIdentity(source, before)) throw new Error("source directory changed while opening staging input");
    for (;;) {
      assertSourceCopyWithinBounds(budget);
      const entry = directory.readSync();
      assertSourceCopyWithinBounds(budget);
      if (!entry) break;
      const name = entry.name;
      budget.entries += 1;
      if (budget.entries > MAX_SOURCE_FILES) throw new Error("source copy entry limit exceeded");
      // Prune initialized Terraform trees before lstat, alias checks, or descent.
      if (name === ".terraform") continue;
      const sourceEntry = path.join(source, name);
      const destinationEntry = path.join(destination, name);
      const stats = fs.lstatSync(sourceEntry, { bigint: true });
      if (!sameDirectoryIdentity(source, before)) throw new Error("source directory changed during staging");
      if (stats.isSymbolicLink()) throw new Error("source tree contains a symlink");
      if (stats.isDirectory()) {
        copySourceDirectory(sourceEntry, destinationEntry, budget, depth + 1, ownedStage);
      } else if (stats.isFile()) {
        copySourceFile(sourceEntry, destinationEntry, budget);
      } else {
        throw new Error("source tree contains a special file");
      }
    }
    assertSourceCopyWithinBounds(budget);
  } finally {
    try {
      if (directory) closeDirectory(directory);
    } finally {
      budget.directories = parents;
    }
  }
}

function sourceFingerprintBudget(testHooks) {
  return {
    entries: 0,
    files: 0,
    bytes: 0,
    metadataBytes: 0,
    startedAt: Date.now(),
    directories: [],
    directorySnapshots: [],
    fileSnapshots: [],
    linkSnapshots: [],
    activeDirectories: [],
    testHooks,
  };
}

function addSourceFingerprintEntry(entries, budget, entry) {
  budget.metadataBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
  if (budget.metadataBytes > MAX_SOURCE_FINGERPRINT_METADATA_BYTES) throw new Error("source fingerprint metadata limit exceeded");
  entries.push(entry);
}

function assertFingerprintWithinBounds(budget) {
  if (Date.now() - budget.startedAt > CACHE_SCAN_TIMEOUT_MS) throw new Error("source fingerprint elapsed deadline exceeded");
  if (budget.entries > MAX_SOURCE_FILES || budget.files > MAX_SOURCE_FILES || budget.bytes > MAX_SOURCE_BYTES) {
    throw new Error("source fingerprint limit exceeded");
  }
  if (!directoryChainIsSame(budget.activeDirectories)) throw new Error("source directory changed during fingerprinting");
}

function sameFileSnapshot(left, right) {
  return sameStatIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function verifyFingerprintSnapshots(budget, message = "source file changed during fingerprinting") {
  for (const snapshot of budget.fileSnapshots) {
    assertFingerprintWithinBounds(budget);
    if (!directoryChainIsSame(snapshot.ancestors)) throw new Error(message);
    let current;
    try { current = lstatRegularFile(snapshot.target); } catch { throw new Error(message); }
    if (!sameFileSnapshot(snapshot.stats, current) || !directoryChainIsSame(snapshot.ancestors)) throw new Error(message);
  }
  for (const snapshot of budget.linkSnapshots) {
    assertFingerprintWithinBounds(budget);
    if (!directoryChainIsSame(snapshot.ancestors)) throw new Error("toolchain link changed during identity check");
    let current;
    try { current = fs.lstatSync(snapshot.target, { bigint: true }); } catch { throw new Error("toolchain link changed during identity check"); }
    if (!current.isSymbolicLink() || !sameFileSnapshot(snapshot.stats, current)
      || !directoryChainIsSame(snapshot.ancestors)) throw new Error("toolchain link changed during identity check");
  }
  for (const { target, stats, ancestors } of budget.directorySnapshots) {
    assertFingerprintWithinBounds(budget);
    if (!directoryChainIsSame(ancestors)) throw new Error("source directory changed during fingerprinting");
    let current;
    try { current = fs.lstatSync(target, { bigint: true }); } catch { throw new Error("source directory changed during fingerprinting"); }
    if (!sameFileSnapshot(stats, current) || !directoryChainIsSame(ancestors)) {
      throw new Error("source directory changed during fingerprinting");
    }
  }
}

/** Hash one no-follow regular file while fencing its BigInt identity and content metadata. */
function hashFileForFingerprint(file, budget) {
  assertFingerprintWithinBounds(budget);
  const before = lstatRegularFile(file);
  if (before.size > BigInt(MAX_SOURCE_BYTES - budget.bytes)) throw new Error("source fingerprint byte limit exceeded");
  budget.files += 1;
  if (budget.files > MAX_SOURCE_FILES) throw new Error("source fingerprint file limit exceeded");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFileSnapshot(before, opened)
      || !sameFileSnapshot(before, lstatRegularFile(file))) throw new Error("source file changed before fingerprinting");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.alloc(SOURCE_COPY_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      assertFingerprintWithinBounds(budget);
      const count = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (count === 0) break;
      budget.bytes += count;
      if (budget.bytes > MAX_SOURCE_BYTES) throw new Error("source fingerprint byte limit exceeded");
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(before, after)
      || !sameFileSnapshot(after, lstatRegularFile(file))) throw new Error("source file changed during fingerprinting");
    budget.fileSnapshots.push({ target: file, stats: after, ancestors: [...budget.activeDirectories] });
    if (typeof budget.testHooks?.afterSourceFileHashed === "function") {
      budget.testHooks.afterSourceFileHashed(file);
    }
    return { mode: Number(before.mode & 0o777n), size: before.size.toString(), digest: hash.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

/** Content-derived identity of precisely the package files and trees staged for a source build. */
function fingerprintSourcePackage(packageRoot, testHooks) {
  const root = path.resolve(packageRoot);
  const rootIdentity = identityOfDirectory(root);
  const budget = sourceFingerprintBudget(testHooks);
  budget.directories = [{ target: root, identity: rootIdentity }];
  budget.activeDirectories = budget.directories;
  const entries = [];
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
    assertFingerprintWithinBounds(budget);
    const file = path.join(root, name);
    const item = hashFileForFingerprint(file, budget);
    addSourceFingerprintEntry(entries, budget, { path: name, type: "file", mode: item.mode, size: item.size, digest: item.digest });
  }

  const visit = (source, relative, depth, ancestors) => {
    if (depth > MAX_SOURCE_DEPTH) throw new Error("source fingerprint depth limit exceeded");
    assertFingerprintWithinBounds(budget);
    const before = fs.lstatSync(source, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !hasPositiveIdentity(before)) {
      throw new Error("source tree contains an unsafe directory");
    }
    const identity = { dev: before.dev, ino: before.ino };
    const directoryEntry = { target: source, identity };
    const chain = [...ancestors, directoryEntry];
    const previousActiveDirectories = budget.activeDirectories;
    budget.directorySnapshots.push({ target: source, stats: before, ancestors: chain });
    budget.activeDirectories = chain;
    addSourceFingerprintEntry(entries, budget, { path: relative, type: "dir", mode: Number(before.mode & 0o777n) });
    let directory;
    try {
      assertFingerprintWithinBounds(budget);
      directory = fs.opendirSync(source);
      if (!sameDirectoryIdentity(source, identity)) throw new Error("source directory changed while fingerprinting");
      for (;;) {
        assertFingerprintWithinBounds(budget);
        const entry = directory.readSync();
        assertFingerprintWithinBounds(budget);
        if (!entry) break;
        budget.entries += 1;
        if (budget.entries > MAX_SOURCE_FILES) throw new Error("source fingerprint entry limit exceeded");
        const name = entry.name;
        // Initialized Terraform trees are deliberately irrelevant and must be pruned before lstat or descent.
        if (name === ".terraform") continue;
        if (name.includes("\\")) throw new Error("source tree contains a non-portable path");
        const child = path.join(source, name);
        const childRelative = `${relative}/${name}`;
        if (childRelative.length > MAX_PATH_LENGTH) throw new Error("source fingerprint path limit exceeded");
        const stats = fs.lstatSync(child, { bigint: true });
        if (!directoryChainIsSame(chain)) throw new Error("source directory changed during fingerprinting");
        if (stats.isSymbolicLink()) throw new Error("source tree contains a symlink");
        if (stats.isDirectory()) {
          visit(child, childRelative, depth + 1, chain);
        } else if (stats.isFile()) {
          const item = hashFileForFingerprint(child, budget);
          addSourceFingerprintEntry(entries, budget, { path: childRelative, type: "file", mode: item.mode, size: item.size, digest: item.digest });
        } else {
          throw new Error("source tree contains a special file");
        }
      }
      assertFingerprintWithinBounds(budget);
      const after = fs.lstatSync(source, { bigint: true });
      if (!sameFileSnapshot(before, after)) throw new Error("source directory changed during fingerprinting");
    } finally {
      if (directory) closeDirectory(directory);
      budget.activeDirectories = previousActiveDirectories;
    }
  };

  for (const name of ["src", "scripts", "skills"]) visit(path.join(root, name), name, 0, budget.activeDirectories);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const serializedEntries = JSON.stringify({ schema: 1, entries });
  if (Buffer.byteLength(serializedEntries, "utf8") > MAX_SOURCE_FINGERPRINT_METADATA_BYTES) {
    throw new Error("source fingerprint metadata limit exceeded");
  }
  const digest = crypto.createHash("sha256").update(serializedEntries).digest("hex");
  verifyFingerprintSnapshots(budget);
  assertFingerprintWithinBounds(budget);
  return {
    digest,
    entries: entries.length,
    files: budget.files,
    bytes: budget.bytes,
    inventory: entries,
    fence: {
      directorySnapshots: budget.directorySnapshots,
      fileSnapshots: budget.fileSnapshots,
      linkSnapshots: budget.linkSnapshots,
    },
  };
}

function stagedSourceMatchesFingerprint(sourceFingerprint, stagedFingerprint) {
  if (!sourceFingerprint || !Array.isArray(sourceFingerprint.inventory)
    || !stagedFingerprint || !Array.isArray(stagedFingerprint.inventory)
    || sourceFingerprint.inventory.length !== stagedFingerprint.inventory.length) return false;
  for (let index = 0; index < sourceFingerprint.inventory.length; index += 1) {
    const source = sourceFingerprint.inventory[index];
    const staged = stagedFingerprint.inventory[index];
    if (source.path !== staged.path || source.type !== staged.type
      || source.size !== staged.size || source.digest !== staged.digest) return false;
    if (process.platform !== "win32") {
      const expectedMode = source.type === "dir" ? 0o700 : 0o600 | (source.mode & 0o111);
      if (staged.mode !== expectedMode) return false;
    }
  }
  return true;
}

/**
 * Stage only explicit build/runtime inputs into a fresh private root. Copies
 * are bounded and reject symlinks/special files; package-lock.json is copied
 * byte-for-byte, source .terraform directories are pruned before descent, and
 * the live checkout's node_modules/dist are never followed or copied.
 */
function stageSourcePackage(packageRoot, buildCacheRoot, testHooks, warn = () => undefined) {
  const parentChain = ensureDirectoryTree(buildCacheRoot);
  const ownedStage = generations.admit(buildCacheRoot,
    () => createOwnedStage(buildCacheRoot, "pi-review-sessions-"),
    { beforeReclaim: (root) => prepareSourceCacheRetirement(root, buildCacheRoot, parentChain), warn });
  try {
    const resolvedPackageRoot = path.resolve(packageRoot);
    const packageChain = process.platform === "win32"
      ? assertDirectoryChain(path.parse(resolvedPackageRoot).root, resolvedPackageRoot)
      : [{ target: resolvedPackageRoot, identity: identityOfDirectory(resolvedPackageRoot) }];
    const budget = sourceCopyBudget(testHooks);
    budget.directories = [
      ...packageChain,
      ...ownedStage.chain,
    ];
    for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
      const source = path.join(resolvedPackageRoot, name);
      copySourceFile(source, path.join(ownedStage.root, name), budget);
    }
    for (const name of ["src", "scripts", "skills"]) {
      const source = path.join(resolvedPackageRoot, name);
      copySourceDirectory(source, path.join(ownedStage.root, name), budget, 0, ownedStage);
    }
    if (!directoryChainIsSame(packageChain) || !directoryChainIsSame(ownedStage.chain)) {
      throw new Error("source or staging root changed during copy");
    }
  } catch (cause) {
    // End this producer's setup admission; the incomplete generation itself is
    // disposable by location and is reclaimed by a later cleanup.
    ownedStage.generation.release();
    const error = new Error("could not stage the source package for building");
    // The partial generation stays on disk (disposable by location) and is
    // reclaimed by a later producer cleanup.
    error.retainedStage = true;
    throw error;
  }
  return ownedStage;
}

function stageNpmEnvironment(env, ownedStage, setupRoot = ownedStage.root) {
  if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
  const npmPaths = {
    cache: path.join(setupRoot, ".npm-cache"),
    logs: path.join(setupRoot, ".npm-logs"),
    temp: path.join(setupRoot, ".npm-tmp"),
    home: path.join(setupRoot, ".home"),
  };
  for (const directory of Object.values(npmPaths)) fs.mkdirSync(directory, { mode: 0o700 });
  const ownEnv = { ...env };
  for (const name of Object.keys(ownEnv)) {
    if (/^npm_config_/iu.test(name)) delete ownEnv[name];
  }
  Object.assign(ownEnv, {
    HOME: npmPaths.home,
    USERPROFILE: npmPaths.home,
    TMPDIR: npmPaths.temp,
    TMP: npmPaths.temp,
    TEMP: npmPaths.temp,
    npm_config_cache: npmPaths.cache,
    npm_config_logs_dir: npmPaths.logs,
    npm_config_userconfig: path.join(setupRoot, ".npmrc"),
    npm_config_globalconfig: path.join(setupRoot, ".npm-globalrc"),
  });
  return ownEnv;
}

function boundedProcessCleanupStatus({ closed, pid, platform, timedOut, outputExceeded, normalExit, groupStillExists }) {
  if (!closed) return false;
  if (pid === undefined) return true;
  if (platform === "win32") {
    // Public Node owns only the direct ChildProcess on Windows. A normal
    // successful close needs no escalation and makes no descendant claim;
    // after timeout/output termination there is no public process-tree proof.
    return timedOut || outputExceeded || !normalExit ? false : undefined;
  }
  return !groupStillExists();
}

function runBoundedProcess(file, args, options = {}) {
  const { env, cwd, timeoutMs, maxOutputBytes = 0, captureStdout = false, captureStderr = false } = options;
  const testHooks = options.testHooks;
  return new Promise((resolve) => {
    let child;
    let closed = false;
    let closeResult;
    let timedOut = false;
    let outputExceeded = false;
    let terminating = false;
    let spawnError;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let deadlineTimer;
    let killTimer;
    let finished = false;
    let cleanupDeadlineReached = false;

    const killOwnedProcess = (signal) => {
      if (!child || child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal); // direct public ChildProcess only
        else process.kill(-child.pid, signal); // the POSIX child process group owned by this spawn
      } catch (error) {
        if (error.code !== "ESRCH") spawnError ??= error;
      }
    };
    const groupStillExists = () => {
      if (!child || child.pid === undefined || process.platform === "win32") return false;
      if (testHooks && typeof testHooks.groupStillExists === "function") return Boolean(testHooks.groupStillExists(child.pid));
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code !== "ESRCH";
      }
    };
    const complete = () => {
      if (finished || (!closed && !cleanupDeadlineReached) || (terminating && killTimer !== undefined)) return;
      finished = true;
      clearTimeout(deadlineTimer);
      const normalExit = closeResult?.code === 0 && closeResult?.signal === null && !spawnError;
      const cleanupConfirmed = boundedProcessCleanupStatus({
        closed,
        pid: child.pid,
        platform: process.platform,
        timedOut,
        outputExceeded,
        normalExit,
        groupStillExists,
      });
      const naturallySettledWindowsChild = process.platform === "win32"
        && closed && !timedOut && !outputExceeded && normalExit;
      if (cleanupConfirmed === true || naturallySettledWindowsChild) {
        activeBoundedProcessCount -= 1;
      } else {
        spawnError ??= new Error("setup process cleanup was not confirmed");
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        status: closeResult?.code ?? null,
        signal: closeResult?.signal ?? null,
        error: spawnError,
        cleanupConfirmed,
        timedOut,
        outputExceeded,
        stdout: stdout.toString("utf8"),
        ...(captureStderr ? { stderr: stderr.toString("utf8") } : {}),
      });
    };
    const terminate = () => {
      if (terminating || finished) return;
      terminating = true;
      killOwnedProcess("SIGTERM");
      killTimer = setTimeout(() => {
        killOwnedProcess("SIGKILL");
        killTimer = setTimeout(() => {
          cleanupDeadlineReached = true;
          killTimer = undefined;
          complete();
        }, PROCESS_KILL_GRACE_MS);
      }, PROCESS_KILL_GRACE_MS);
    };

    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", captureStdout ? "pipe" : "ignore", captureStderr ? "pipe" : "ignore"],
      });
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        error,
        cleanupConfirmed: true,
        timedOut: false,
        outputExceeded: false,
        stdout: "",
        ...(captureStderr ? { stderr: "" } : {}),
      });
      return;
    }

    activeBoundedProcessCount += 1;
    // stdout and stderr are captured separately for provenance, but the two
    // buffers count against the same hard ceiling: a child that floods either
    // stream cannot exceed maxOutputBytes in total, and exceeding it is
    // reported as outputExceeded (a failure) rather than as successful output.
    const captureChunk = (chunk, assign) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + stderr.length + bytes.length > maxOutputBytes) {
        outputExceeded = true;
        if (killTimer === undefined) terminate();
        return;
      }
      assign(bytes);
    };
    if (captureStdout) child.stdout.on("data", (chunk) => captureChunk(chunk, (bytes) => { stdout = Buffer.concat([stdout, bytes]); }));
    if (captureStderr) child.stderr.on("data", (chunk) => captureChunk(chunk, (bytes) => { stderr = Buffer.concat([stderr, bytes]); }));
    // A captured-pipe read error is a setup failure, never a silent success or
    // an unhandled EventEmitter error: record the first one and take the
    // existing bounded termination and settlement path. Cleanup is still
    // decided by the shared cleanup status, so nothing here claims that an
    // unproven process tree is gone.
    const onStreamError = (error) => {
      spawnError ??= error instanceof Error ? error : new Error("setup stream read failed");
      if (killTimer === undefined) terminate();
    };
    if (captureStdout) child.stdout.on("error", onStreamError);
    if (captureStderr) child.stderr.on("error", onStreamError);
    if (testHooks && typeof testHooks.onStreams === "function") {
      // Synthetic seam: the controlled observer may emit a stream error once
      // the admitted listeners exist, without touching production behavior.
      testHooks.onStreams({
        stdout: captureStdout ? child.stdout : undefined,
        stderr: captureStderr ? child.stderr : undefined,
      });
    }
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      if (finished) return;
      if (testHooks && testHooks.ignoreClose === true) {
        if (typeof testHooks.onClose === "function") testHooks.onClose(code, signal);
        return;
      }
      closeResult = { code, signal };
      closed = true;
      clearTimeout(deadlineTimer);
      // POSIX can verify only its own group. Windows deliberately performs no
      // process-tree scan; abnormal direct-child settlement stays uncertain.
      if (!timedOut && !outputExceeded && groupStillExists()) terminate();
      else complete();
    });
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      if (killTimer === undefined) terminate();
    }, timeoutMs);
    deadlineTimer.unref?.();
  });
}

/**
 * Run one admitted Node JS entry through this trusted public Node, never a
 * shell, a `.bin` shim, cmd.exe, or a PATH executable lookup.
 */
function runNodeJs(entry, args, options = {}) {
  return runBoundedProcess(process.execPath, [entry, ...args], options);
}

function runNpm(npmCli, args, options = {}) {
  return runNodeJs(npmCli, args, options);
}

/**
 * Neutralize terminal control sequences and non-printing bytes in captured
 * child output so a failing child cannot rewrite or hijack the operator's
 * terminal, then keep only the printable text it actually printed. The input
 * is bounded child output only: no environment, credential, argv, or
 * parent-process state is ever added here.
 */
function sanitizeDiagnosticText(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text
    // OSC ... BEL/ST
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    // CSI ... final byte
    .replace(/\u001b\[[0-9;?<=>!]*[ -/]*[@-~]/gu, "")
    // remaining two-byte escape sequences
    .replace(/\u001b[@-Z\\-_]/gu, "")
    // C0/C1 controls and DEL except horizontal tab and newline
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

/**
 * Bound text to a UTF-8 byte ceiling, appending an explicit truncation marker
 * when clipped so a reader can tell the diagnostic is incomplete. A ceiling
 * smaller than the marker emits nothing rather than overshooting it.
 */
function boundDiagnosticText(text, limitBytes) {
  if (typeof text !== "string" || text.length === 0) return "";
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return "";
  const limit = Math.floor(limitBytes);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const marker = "[diagnostic truncated]\n";
  const budget = limit - Buffer.byteLength(marker, "utf8");
  if (budget <= 0) return "";
  const clipped = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8").replace(/\ufffd+$/u, "");
  return `${clipped}${marker}`;
}

/**
 * Bounded, sanitized, provenance-labelled diagnostics for one failed admitted
 * source build stage. Each captured stream keeps its own label so a reader can
 * tell stdout from stderr, and the blocks together share one aggregate ceiling
 * (BUILD_DIAGNOSTIC_TEXT_MAX_BYTES). Returns "" when nothing was captured.
 */
function formatBuildStageDiagnostics(result, stage) {
  const label = BUILD_STAGE_LABELS[stage] ?? BUILD_STAGE_LABELS.stage;
  const perStreamLimit = Math.max(1, Math.floor((BUILD_DIAGNOSTIC_TEXT_MAX_BYTES - 256) / 2));
  const blocks = [];
  const streams = [
    ["stdout", boundDiagnosticText(sanitizeDiagnosticText(result && result.stdout), perStreamLimit)],
    ["stderr", boundDiagnosticText(sanitizeDiagnosticText(result && result.stderr), perStreamLimit)],
  ];
  for (const [stream, text] of streams) {
    if (text.length === 0) continue;
    blocks.push(`pi-review-sessions: ${label} ${stream}:\n${text}${text.endsWith("\n") ? "" : "\n"}`);
  }
  return blocks.join("");
}

/** Bounded, sanitized diagnostic for a failure raised by the build wrapper itself. */
function formatStageErrorDiagnostics(error) {
  const message = error && typeof error.message === "string" && error.message.length > 0
    ? error.message
    : "source stage preparation failed";
  return boundDiagnosticText(sanitizeDiagnosticText(`${message}\n`), BUILD_DIAGNOSTIC_TEXT_MAX_BYTES);
}

/** Lexical containment of `target` inside `base`, both resolved first. */
function pathIsWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve the staged locked install's own TypeScript CLI. The compiler is part
 * of the staged package's installed dev dependencies (`npm ci --include=dev`),
 * so the candidate is derived only from the stage's own node_modules: a global
 * install, the parent checkout's node_modules, an SDK copy, and any PATH
 * executable lookup are never consulted. Admission is strictly lexical first:
 * every directory component from the stage root through `typescript/bin` must
 * be a real non-symlink directory and `bin/tsc` must itself be a regular
 * non-symlink file with a positive BigInt identity captured before any
 * canonicalization. An internal symlink whose target stays inside the package
 * is refused exactly like an escaping one. Canonical containment and the
 * installed package's declared `tsc` bin are additionally checked. The caller
 * re-verifies the captured entry identity and both directory chains around
 * dispatch. A missing, swapped, or linked compiler is refused (and the stage
 * retained), never substituted. These checks are not atomic openat
 * containment and claim none.
 */
function resolveStageTypeScriptCli(stagingRoot) {
  const packageDir = path.join(stagingRoot, "node_modules", "typescript");
  const binDir = path.join(packageDir, "bin");
  const candidate = path.join(binDir, "tsc");
  // Lexical admission FIRST, before any canonicalization can hide a link:
  // every directory component from the stage root through `typescript/bin`
  // must be a real non-symlink directory, and `bin/tsc` itself must be a
  // regular non-symlink file. An internal symlink whose target stays inside
  // the package is refused exactly like an escaping one, and the entry's
  // BigInt identity is captured here so it can be re-verified around dispatch.
  let chain;
  try {
    chain = assertDirectoryChain(stagingRoot, binDir);
  } catch {
    throw new Error("the staged TypeScript compiler is unavailable");
  }
  let entry;
  try {
    entry = lstatRegularFile(candidate);
  } catch {
    throw new Error("the staged TypeScript compiler is not a regular file");
  }
  const identity = { dev: entry.dev, ino: entry.ino };
  // Canonical containment is defense in depth for a symlinked ancestor above
  // the owned stage root; it is not atomic openat containment and claims none.
  let canonical;
  let canonicalStage;
  let canonicalPackageDir;
  try {
    canonical = fs.realpathSync(candidate);
    canonicalStage = fs.realpathSync(stagingRoot);
    canonicalPackageDir = fs.realpathSync(packageDir);
  } catch {
    throw new Error("the staged TypeScript compiler is unavailable");
  }
  if (!pathIsWithin(canonicalPackageDir, canonical) || !pathIsWithin(canonicalStage, canonical)) {
    throw new Error("the staged TypeScript compiler escapes the source stage");
  }
  let manifest;
  try {
    manifest = JSON.parse(readBoundedRegularFile(path.join(packageDir, "package.json"), MAX_MANIFEST_BYTES).toString("utf8"));
  } catch {
    throw new Error("the staged TypeScript package metadata is unreadable or invalid");
  }
  if (manifest === null || typeof manifest !== "object" || manifest.name !== "typescript") {
    throw new Error("the staged TypeScript package identity does not match the locked dependency");
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin && manifest.bin.tsc;
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error("the staged TypeScript package declares no tsc entry");
  }
  const declared = path.resolve(packageDir, bin);
  let declaredCanonical;
  try {
    declaredCanonical = fs.realpathSync(declared);
  } catch {
    throw new Error("the staged TypeScript tsc entry does not match the installed package");
  }
  if (declared !== candidate || declaredCanonical !== canonical) {
    throw new Error("the staged TypeScript tsc entry does not match the installed package");
  }
  // The compile receives the lexical stage paths the launcher itself uses, so
  // the captured entry identity stays meaningful for the pre/post fences.
  return { file: candidate, tsconfig: path.join(stagingRoot, "tsconfig.json"), chain, identity };
}

async function buildSourceExtension(options) {
  const { packageRoot, agentDir, env } = options;
  const executeNpm = options.runNpm || runNpm;
  const executeCompile = options.runCompile || runNodeJs;
  const forceFresh = options.forceFresh === true;
  const sourceBuildTimeoutMs = Number.isFinite(options.sourceBuildTimeoutMs)
    ? options.sourceBuildTimeoutMs
    : SOURCE_BUILD_TIMEOUT_MS;
  const buildCacheRoot = path.join(agentDir, RUNTIME_CACHE_DIRNAME, "build");
  let sourceFingerprint;
  let npmCli;
  let cacheParentChain;
  let cacheMetadata;
  let toolchainFence;
  let cacheLock;
  let mayPublish = false;
  let ownedStage;
  const warn = (message) => {
    if (typeof options.writeError === "function") options.writeError(`pi-review-sessions: ${message}.\n`);
  };
  try {
    sourceFingerprint = fingerprintSourcePackage(packageRoot);
    npmCli = findNpmCli(env);
    if (!npmCli) throw new Error("npm is unavailable");
    if (!forceFresh && sourceBuildCacheEligible(packageRoot, env)) {
      try {
        const toolchainIdentity = sourceBuildToolchainFingerprint(env, npmCli);
        toolchainFence = toolchainIdentity.fence;
        if (typeof options.testHooks?.afterToolchainFingerprint === "function") {
          options.testHooks.afterToolchainFingerprint();
        }
        const toolchainFingerprint = toolchainIdentity.fingerprint;
        const cacheKey = crypto.createHash("sha256")
          .update(JSON.stringify({ schema: 1, sourceFingerprint: sourceFingerprint.digest, toolchainFingerprint }))
          .digest("hex");
        cacheMetadata = { cacheKey, sourceFingerprint: sourceFingerprint.digest, toolchainFingerprint };
        cacheParentChain = ensureDirectoryTree(buildCacheRoot);
      } catch {
        // Unverifiable toolchain/configuration means a safe fresh build only.
        cacheMetadata = undefined;
      }
    }

    const returnCached = (cleanupReuse = true) => {
      if (!cacheMetadata || !cacheParentChain) return undefined;
      if (!verifyToolchainFence(toolchainFence)) return undefined;
      const recordPath = sourceBuildCacheRecordPath(buildCacheRoot, cacheMetadata.cacheKey);
      if (!pathExists(recordPath)) return undefined;
      let candidate;
      try {
        candidate = readSourceBuildCacheRecord(recordPath, buildCacheRoot, cacheMetadata, cacheParentChain);
      } catch { return undefined; }
      if (!candidate) return undefined;
      const candidateRoot = candidate.root;
      const chain = [...cacheParentChain, { target: candidateRoot, identity: candidate.identity }];
      const cachedStage = {
        root: candidateRoot,
        identity: candidate.identity,
        parentChain: cacheParentChain,
        chain,
      };
      // A compatible reuse advances pending cleanup instead of waiting for the
      // next fresh build: the same bounded pass runs only on cache metadata, with
      // a per-type target of five, and this launch's selected generation is never
      // a candidate. Nothing is built, installed, or recreated to trigger it.
      if (cleanupReuse) {
        try {
          generations.cleanup(buildCacheRoot, {
            keep: [candidateRoot],
            beforeReclaim: (root) => prepareSourceCacheRetirement(root, buildCacheRoot, cacheParentChain),
            warn,
          });
        } catch (error) {
          warn(`cache cleanup could not complete (${error && error.message}); the reused build is unaffected`);
        }
      }
      return {
        status: 0,
        stagingRoot: candidateRoot,
        ownedStage: cachedStage,
        sourceFingerprint: sourceFingerprint.digest,
        toolchainFingerprint: cacheMetadata.toolchainFingerprint,
        cacheKey: cacheMetadata.cacheKey,
        cacheParentChain,
        cacheHit: true,
        cachePublished: false,
        verificationEntries: candidate.manifest.entries.length,
        ...(toolchainFence ? { toolchainFence } : {}),
        ...(options.testHooks ? { testHooks: options.testHooks } : {}),
      };
    };

    let cached = returnCached();
    if (cached) return cached;
    if (cacheMetadata && cacheParentChain && !forceFresh) {
      const recordPath = sourceBuildCacheRecordPath(buildCacheRoot, cacheMetadata.cacheKey);
      if (!pathExists(recordPath)) {
        cacheLock = acquireSourceCacheLock(buildCacheRoot, cacheMetadata.cacheKey, cacheParentChain);
        if (cacheLock) {
          // The publication lock is held here, so the cleanup-only pass (which
          // takes the cache admission lock) must not run from under it.
          cached = returnCached(false);
          if (cached) {
            cacheLock.release();
            cacheLock = undefined;
            return cached;
          }
          mayPublish = !pathExists(recordPath);
        } else {
          // Another launcher owns publication. Never join its partial stage;
          // a one-time completed-cache check is safe, otherwise build privately.
          cached = returnCached(false);
          if (cached) return cached;
        }
      }
    }
  } catch (error) {
    if (cacheLock) cacheLock.release();
    return {
      status: 1,
      stage: "stage",
      error: new Error(error && error.message === "npm is unavailable"
        ? "npm is unavailable"
        : "could not fingerprint the source package for building"),
      diagnostics: formatStageErrorDiagnostics(error),
      retainedStage: false,
    };
  }

  try {
    ownedStage = stageSourcePackage(packageRoot, buildCacheRoot, options.testHooks, warn);
  } catch (error) {
    if (cacheLock) cacheLock.release();
    return { status: 1, stage: "stage", error, diagnostics: formatStageErrorDiagnostics(error), retainedStage: Boolean(error && error.retainedStage) };
  }
  const stagingRoot = ownedStage.root;
  try {
    if (typeof options.testHooks?.afterSourceStageCreated === "function") {
      options.testHooks.afterSourceStageCreated(stagingRoot);
    }
    // Setup residue lives inside the SAME counted generation.
    const buildEnv = stageNpmEnvironment(env, ownedStage);
    const stagedFingerprint = fingerprintSourcePackage(stagingRoot);
    if (!stagedSourceMatchesFingerprint(sourceFingerprint, stagedFingerprint)) {
      throw new Error("staged source inputs do not match the initially fingerprinted package");
    }
    const stagedInputFingerprint = fingerprintSourcePackage(packageRoot);
    if (stagedInputFingerprint.digest !== sourceFingerprint.digest) throw new Error("source changed while preparing the staged build");
    if (toolchainFence && !verifyToolchainFence(toolchainFence)) throw new Error("toolchain identity changed before npm ci");
    const install = await executeNpm(npmCli, ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"], {
      cwd: stagingRoot,
      env: buildEnv,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      captureStdout: true,
      captureStderr: true,
      maxOutputBytes: SOURCE_BUILD_CAPTURE_MAX_BYTES,
    });
    if (install.error || install.status !== 0 || install.signal || install.timedOut || install.outputExceeded || install.cleanupConfirmed === false) {
      const removed = false;
      return {
        status: statusCode(install),
        stage: "install",
        childStatus: install.status,
        signal: install.signal,
        cleanupConfirmed: install.cleanupConfirmed,
        timedOut: install.timedOut,
        outputExceeded: install.outputExceeded,
        error: install.error,
        diagnostics: formatBuildStageDiagnostics(install, "install"),
        retainedStage: !removed,
      };
    }
    if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
    if (toolchainFence && !verifyToolchainFence(toolchainFence)) throw new Error("toolchain identity changed during npm ci");
    if (pathExists(path.join(stagingRoot, "dist"))) throw new Error("staging root unexpectedly contains build output");
    // Compile with the staged locked install's own TypeScript CLI through
    // public Node directly: `-p <stage>/tsconfig.json`, no `npm run build`,
    // no `clean:build` recursive removal, no node_modules/.bin PATH entry,
    // and no shell. The public package build scripts stay unchanged and the
    // live checkout (or any existing output) is never touched. The compiler
    // entry and its real ancestor chain are identity-checked first; the
    // checks are not atomic openat containment and make no such claim.
    const compiler = resolveStageTypeScriptCli(stagingRoot);
    if (!directoryChainIsSame(ownedStage.chain) || !directoryChainIsSame(compiler.chain)
      || !sameFileIdentity(compiler.file, compiler.identity)) {
      throw new Error("staging directory chain changed before the TypeScript compile");
    }
    if (toolchainFence && !verifyToolchainFence(toolchainFence)) {
      throw new Error("toolchain identity changed before the TypeScript compile");
    }
    const compile = await executeCompile(compiler.file, ["-p", compiler.tsconfig], {
      cwd: stagingRoot,
      env: buildEnv,
      timeoutMs: sourceBuildTimeoutMs,
      captureStdout: true,
      captureStderr: true,
      maxOutputBytes: SOURCE_BUILD_CAPTURE_MAX_BYTES,
    });
    if (compile.error || compile.status !== 0 || compile.signal || compile.timedOut || compile.outputExceeded || compile.cleanupConfirmed === false) {
      const removed = false;
      return {
        status: statusCode(compile),
        stage: "compile",
        childStatus: compile.status,
        signal: compile.signal,
        cleanupConfirmed: compile.cleanupConfirmed,
        timedOut: compile.timedOut,
        outputExceeded: compile.outputExceeded,
        error: compile.error,
        diagnostics: formatBuildStageDiagnostics(compile, "compile"),
        retainedStage: !removed,
      };
    }
    if (!directoryChainIsSame(ownedStage.chain) || !directoryChainIsSame(compiler.chain)
      || !sameFileIdentity(compiler.file, compiler.identity)) {
      throw new Error("staging directory chain changed during the TypeScript compile");
    }
    if (toolchainFence && !verifyToolchainFence(toolchainFence)) {
      throw new Error("toolchain identity changed during the TypeScript compile");
    }
    const finalFingerprint = fingerprintSourcePackage(packageRoot);
    if (finalFingerprint.digest !== sourceFingerprint.digest) throw new Error("source changed during the staged build");
    if (toolchainFence && !verifyToolchainFence(toolchainFence)) throw new Error("toolchain identity changed during the staged build");

    let cachePublished = false;
    let verificationEntries;
    let verificationBytes;
    if (cacheMetadata && cacheParentChain && mayPublish && cacheLock) {
      let manifest;
      try {
        manifest = writeSourceBuildManifest(stagingRoot, cacheMetadata);
      } catch {
        // A cache that cannot be inventoried within strict bounds is simply
        // non-reusable; this just-built stage remains available for this run.
      }
      if (manifest) {
        const recordPath = sourceBuildCacheRecordPath(buildCacheRoot, cacheMetadata.cacheKey);
        if (directoryChainIsSame(cacheParentChain) && directoryChainIsSame(ownedStage.chain)
          && !pathExists(recordPath)) {
          try {
            if (typeof options.testHooks?.beforeCacheRecord === "function") {
              options.testHooks.beforeCacheRecord(recordPath, stagingRoot);
            }
            const recordIdentity = writeSourceBuildCacheRecord(recordPath, buildCacheRoot, cacheMetadata, ownedStage, cacheParentChain);
            const visibleRecord = readSourceBuildCacheRecord(recordPath, buildCacheRoot, cacheMetadata, cacheParentChain);
            if (!visibleRecord || visibleRecord.recordIdentity.dev !== recordIdentity.dev
              || visibleRecord.recordIdentity.ino !== recordIdentity.ino
              || visibleRecord.identity.dev !== ownedStage.identity.dev
              || visibleRecord.identity.ino !== ownedStage.identity.ino) {
              throw new Error("exclusive source cache record failed post-publication validation");
            }
            cachePublished = true;
            verificationEntries = manifest.entries.length;
            verificationBytes = manifest.entries.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
          } catch {
            // Exclusive record creation never replaces an existing target.
            // A competing or partial record is preserved with this fresh stage.
          }
        }
      }
    }
    const result = {
      status: 0,
      stagingRoot: ownedStage.root,
      ownedStage,
      sourceFingerprint: sourceFingerprint.digest,
      ...(toolchainFence ? { toolchainFence } : {}),
      ...(cacheMetadata ? {
        toolchainFingerprint: cacheMetadata.toolchainFingerprint,
        cacheKey: cacheMetadata.cacheKey,
        cacheParentChain,
      } : {}),
      cacheHit: false,
      cachePublished,
      ...(options.testHooks ? { testHooks: options.testHooks } : {}),
      ...(verificationEntries !== undefined ? { verificationEntries } : {}),
      ...(verificationBytes !== undefined ? { verificationBytes } : {}),
    };
    return result;
  } catch (error) {
    const cleanupUnconfirmed = Boolean(error && error.cleanupUnconfirmed);
    const removed = false;
    return {
      status: 1,
      stage: "stage",
      error,
      cleanupConfirmed: cleanupUnconfirmed ? false : undefined,
      diagnostics: formatStageErrorDiagnostics(error),
      retainedStage: !removed,
    };
  } finally {
    if (cacheLock) cacheLock.release();
    // Setup admission settles here, on success or failure. The generation stays
    // reusable/disposable; only the cache-cleanup mutual exclusion ends. A
    // settlement pass then retries any cleanup that contention deferred while
    // this producer was still staging, without deleting the generation it just
    // produced or is returning to this launch.
    ownedStage.generation.release();
    try {
      generations.cleanup(buildCacheRoot, {
        keep: [stagingRoot],
        beforeReclaim: (root) => prepareSourceCacheRetirement(root, buildCacheRoot, cacheParentChain),
        warn,
      });
    } catch (error) {
      warn(`cache cleanup could not complete (${error && error.message}); the prepared build is unaffected`);
    }
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

/** Resolve and validate an official npm package's public Node CLI entry. */
function validateNpmCli(candidate) {
  let canonical;
  try {
    canonical = fs.realpathSync(candidate);
    lstatRegularFile(canonical);
  } catch {
    return undefined;
  }
  let dir = path.dirname(canonical);
  for (let depth = 0; depth < 16; depth += 1) {
    const manifestPath = path.join(dir, "package.json");
    if (pathExists(manifestPath)) {
      try {
        const manifest = JSON.parse(readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES).toString("utf8"));
        if (!manifest || manifest.name !== "npm" || !parseStableVersion(manifest.version)) return undefined;
        const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin && manifest.bin.npm;
        if (typeof bin !== "string" || bin.length === 0) return undefined;
        const expected = path.resolve(dir, bin);
        const relative = path.relative(dir, expected);
        if (relative.startsWith("..") || path.isAbsolute(relative) || fs.realpathSync(expected) !== canonical) return undefined;
        const head = readHeadBytes(canonical, NODE_ENTRY_HEAD_BYTES);
        return head && isNodeEntryShebang(head) ? canonical : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Resolve PATH's ordinary npm command to its public JS bin; never execute a shim. */
function findNpmCli(env) {
  for (const rawEntry of `${env.PATH ?? ""}`.split(path.delimiter)) {
    if (!rawEntry) continue;
    const commands = process.platform === "win32" ? ["npm", "npm.cmd"] : ["npm"];
    for (const command of commands) {
      const candidate = path.join(rawEntry, command);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      const direct = validateNpmCli(candidate);
      if (direct) return direct;
      if (process.platform === "win32" && command === "npm.cmd") {
        // Standard Node distributions place the public npm package beside
        // npm.cmd. Invoke its validated JS bin with admitted Node; never run
        // cmd.exe or parse/execute the batch shim.
        const siblingCli = path.join(rawEntry, "node_modules", "npm", "bin", "npm-cli.js");
        const sibling = validateNpmCli(siblingCli);
        if (sibling) return sibling;
      }
    }
  }
  return undefined;
}

function sourceBuildNpmPackage(npmCli) {
  let directory;
  try { directory = path.dirname(fs.realpathSync(npmCli)); } catch { return undefined; }
  for (let depth = 0; depth < 16; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    if (pathExists(manifestPath)) {
      try {
        const manifest = JSON.parse(readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES).toString("utf8"));
        if (manifest && manifest.name === "npm" && parseStableVersion(manifest.version)) {
          identityOfDirectory(directory);
          return { root: directory, version: manifest.version };
        }
      } catch {
        // A malformed package manifest is not a positive npm identity.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function toolchainFileIdentity(file, maxBytes = MAX_TOOLCHAIN_FILE_BYTES) {
  const absolute = fs.realpathSync(file);
  const before = lstatRegularFile(absolute);
  if (before.size > BigInt(maxBytes)) throw new Error("toolchain file exceeds the bounded identity size");
  const cacheKey = [absolute, before.dev, before.ino, before.size, before.mode, before.mtimeNs, before.ctimeNs].join(":");
  const parentChain = assertDirectoryChain(path.parse(absolute).root, path.dirname(absolute));
  if (absolute === fs.realpathSync(process.execPath)
    && cachedNodeToolchainIdentity && cachedNodeToolchainIdentity.cacheKey === cacheKey) {
    return {
      ...cachedNodeToolchainIdentity.identity,
      fence: { target: absolute, stats: before, ancestors: parentChain },
    };
  }
  const budget = sourceFingerprintBudget();
  budget.directories = parentChain;
  budget.activeDirectories = budget.directories;
  const fileHash = hashFileForFingerprint(absolute, budget);
  const after = lstatRegularFile(absolute);
  if (!sameFileSnapshot(before, after)) throw new Error("toolchain file changed during identity check");
  verifyFingerprintSnapshots(budget, "toolchain file changed during identity check");
  const identity = {
    path: absolute,
    dev: before.dev.toString(),
    ino: before.ino.toString(),
    size: before.size.toString(),
    mode: Number(before.mode & 0o777n),
    digest: fileHash.digest,
  };
  if (absolute === fs.realpathSync(process.execPath)) cachedNodeToolchainIdentity = { cacheKey, identity };
  return { ...identity, fence: { target: absolute, stats: after, ancestors: parentChain } };
}

function fingerprintNpmImplementation(packageRoot) {
  const root = path.resolve(packageRoot);
  const rootStats = fs.lstatSync(root, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !hasPositiveIdentity(rootStats)) {
    throw new Error("npm implementation root is unsafe");
  }
  const rootChain = assertDirectoryChain(path.parse(root).root, root);
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  if (rootChain.at(-1)?.identity.dev !== rootIdentity.dev || rootChain.at(-1)?.identity.ino !== rootIdentity.ino) {
    throw new Error("npm implementation root changed while admitting its path");
  }
  const budget = sourceFingerprintBudget();
  budget.directories = rootChain;
  budget.activeDirectories = budget.directories;
  const entries = [];
  const visit = (directory, relativeDirectory, depth, ancestors) => {
    if (depth > MAX_SOURCE_DEPTH) throw new Error("npm implementation depth limit exceeded");
    assertFingerprintWithinBounds(budget);
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !hasPositiveIdentity(before)
      || (relativeDirectory === "" && !sameFileSnapshot(rootStats, before))) {
      throw new Error("npm implementation contains an unsafe or changed directory");
    }
    const current = { target: directory, identity: { dev: before.dev, ino: before.ino } };
    const chain = [...ancestors, current];
    const previousActiveDirectories = budget.activeDirectories;
    budget.activeDirectories = chain;
    budget.directorySnapshots.push({ target: directory, stats: before, ancestors: chain });
    if (relativeDirectory !== "") {
      addSourceFingerprintEntry(entries, budget, {
        path: relativeDirectory,
        type: "directory",
        mode: Number(before.mode & 0o777n),
      });
    }
    let handle;
    try {
      assertFingerprintWithinBounds(budget);
      handle = fs.opendirSync(directory);
      if (!sameDirectoryIdentity(directory, current.identity)) throw new Error("npm implementation directory changed while opening");
      for (;;) {
        assertFingerprintWithinBounds(budget);
        const entry = handle.readSync();
        assertFingerprintWithinBounds(budget);
        if (!entry) break;
        budget.entries += 1;
        if (budget.entries > MAX_SOURCE_FILES) throw new Error("npm implementation entry limit exceeded");
        const name = entry.name;
        if (name === ".terraform") throw new Error("npm implementation contains an excluded Terraform subtree");
        if (name.includes("\\")) throw new Error("npm implementation contains a non-portable path");
        const absolute = path.join(directory, name);
        const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (relative.length > MAX_PATH_LENGTH) throw new Error("npm implementation path limit exceeded");
        if (!directoryChainIsSame(chain)) throw new Error("npm implementation directory changed during fingerprinting");
        const stats = fs.lstatSync(absolute, { bigint: true });
        if (!hasPositiveIdentity(stats)) throw new Error("npm implementation entry identity is unavailable");
        if (stats.isSymbolicLink()) {
          const target = fs.readlinkSync(absolute);
          if (target.length === 0 || target.length > MAX_PATH_LENGTH || path.isAbsolute(target)
            || /[\u0000-\u001f\u007f]/u.test(target)) throw new Error("npm implementation contains an unsafe link");
          const targetPath = path.resolve(path.dirname(absolute), target);
          if (!pathIsWithin(root, targetPath)) throw new Error("npm implementation link escapes its package");
          const targetRelative = path.relative(root, targetPath).split(path.sep).join("/");
          const targetStats = lstatRegularFile(targetPath);
          const after = fs.lstatSync(absolute, { bigint: true });
          if (!sameFileSnapshot(stats, after) || !sameFileSnapshot(targetStats, lstatRegularFile(targetPath))) {
            throw new Error("npm implementation link changed during fingerprinting");
          }
          budget.linkSnapshots.push({ target: absolute, stats: after, ancestors: [...chain] });
          addSourceFingerprintEntry(entries, budget, {
            path: relative,
            type: "symlink",
            mode: Number(stats.mode & 0o777n),
            target: targetRelative,
          });
        } else if (stats.isDirectory()) {
          visit(absolute, relative, depth + 1, chain);
        } else if (stats.isFile()) {
          const item = hashFileForFingerprint(absolute, budget);
          addSourceFingerprintEntry(entries, budget, {
            path: relative,
            type: "file",
            mode: item.mode,
            size: item.size,
            digest: item.digest,
          });
        } else {
          throw new Error("npm implementation contains a special file");
        }
      }
      const after = fs.lstatSync(directory, { bigint: true });
      if (!sameFileSnapshot(before, after)) throw new Error("npm implementation directory changed during fingerprinting");
    } finally {
      if (handle) closeDirectory(handle);
      budget.activeDirectories = previousActiveDirectories;
    }
  };
  visit(root, "", 0, rootChain.slice(0, -1));
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.type === "symlink" && byPath.get(entry.target)?.type !== "file") {
      throw new Error("npm implementation link target is not a verified regular file");
    }
  }
  const serialized = JSON.stringify({ schema: 1, rootMode: Number(rootStats.mode & 0o777n), entries });
  if (Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_FINGERPRINT_METADATA_BYTES) {
    throw new Error("npm implementation fingerprint exceeds its metadata limit");
  }
  const digest = crypto.createHash("sha256").update(serialized).digest("hex");
  verifyFingerprintSnapshots(budget, "npm implementation file changed during fingerprinting");
  assertFingerprintWithinBounds(budget);
  return {
    digest,
    fence: {
      directorySnapshots: budget.directorySnapshots,
      fileSnapshots: budget.fileSnapshots,
      linkSnapshots: budget.linkSnapshots,
      entries: budget.entries,
      files: budget.files,
      bytes: budget.bytes,
    },
  };
}

function sourceBuildCacheEligible(packageRoot, env) {
  const nodeOptions = typeof env.NODE_OPTIONS === "string" ? env.NODE_OPTIONS : "";
  // Only a narrowly understood warning-only option is reusable. Arbitrary
  // --require/--import/loader hooks and future Node flags may load or execute
  // external code even when their text is unchanged.
  if (nodeOptions !== "" && nodeOptions !== "--no-warnings") return false;
  if (process.execArgv.some((arg) => /^(?:-r|--require(?:=|$)|--import(?:=|$)|--loader(?:=|$)|--experimental-loader(?:=|$))/u.test(arg))) return false;
  if (typeof env.NODE_PATH === "string" && env.NODE_PATH.length > 0) return false;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (/^(?:LD_|DYLD_)/iu.test(name) || name.toUpperCase() === "LIBPATH") return false;
    if (/^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu.test(name)) return false;
    if (/^NODE_/iu.test(name) && !["NODE_ENV", "NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())) return false;
  }
  try {
    const lock = JSON.parse(readBoundedRegularFile(path.join(packageRoot, "package-lock.json"), 32 * 1024 * 1024).toString("utf8"));
    const packages = lock && typeof lock === "object" && lock.packages && typeof lock.packages === "object" ? Object.values(lock.packages) : [];
    for (const pkg of packages) {
      if (!pkg || typeof pkg !== "object") continue;
      if (pkg.link === true || (typeof pkg.resolved === "string" && /^(?:git\+|git:|github:|file:|link:)/iu.test(pkg.resolved))) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function sourceBuildToolchainFingerprint(env, npmCli) {
  const npmPackage = sourceBuildNpmPackage(npmCli);
  if (!npmPackage) throw new Error("the public npm toolchain identity is unavailable");
  const npmVersion = npmPackage.version;
  const npmIdentity = toolchainFileIdentity(npmCli);
  const npmImplementation = fingerprintNpmImplementation(npmPackage.root);
  const nodeIdentity = toolchainFileIdentity(process.execPath);
  // PATH is intentionally excluded: this build invokes the positively
  // identified npm and Node JS entries directly, and supported shell fallback
  // may re-extract those same toolchains at a transient absolute path.
  const configNames = ["NODE_OPTIONS", "NODE_ENV", "NODE_PATH", "LANG", "LC_ALL", "TZ", "SOURCE_DATE_EPOCH"];
  const config = configNames.map((name) => {
    if (!Object.hasOwn(env, name)) return [name, null];
    const value = `${env[name]}`;
    if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw new Error("source build environment configuration exceeds its bound");
    return [name, crypto.createHash("sha256").update(value).digest("hex")];
  });
  const versions = Object.fromEntries(Object.entries(process.versions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const identity = {
    schema: 1,
    node: { digest: nodeIdentity.digest, version: process.version, versions, release: process.release, execArgv: process.execArgv },
    npm: { cliDigest: npmIdentity.digest, version: npmVersion, implementation: npmImplementation.digest },
    platform: process.platform,
    arch: process.arch,
    config,
  };
  const fence = {
    directorySnapshots: npmImplementation.fence.directorySnapshots,
    fileSnapshots: [
      { target: npmIdentity.path, stats: npmIdentity.fence.stats, ancestors: npmIdentity.fence.ancestors },
      { target: nodeIdentity.path, stats: nodeIdentity.fence.stats, ancestors: nodeIdentity.fence.ancestors },
      ...npmImplementation.fence.fileSnapshots,
    ],
    linkSnapshots: npmImplementation.fence.linkSnapshots,
  };
  return { fingerprint: crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex"), fence };
}

function verifyToolchainFence(fence) {
  if (!fence || !Array.isArray(fence.directorySnapshots)
    || !Array.isArray(fence.fileSnapshots) || !Array.isArray(fence.linkSnapshots)) return false;
  const budget = {
    startedAt: Date.now(),
    entries: 0,
    files: 0,
    bytes: 0,
    activeDirectories: [],
    directorySnapshots: fence.directorySnapshots,
    fileSnapshots: fence.fileSnapshots,
    linkSnapshots: fence.linkSnapshots,
  };
  try {
    verifyFingerprintSnapshots(budget, "toolchain identity changed during validation");
    return true;
  } catch {
    return false;
  }
}

function cacheScanBudget(root, identity, testHooks) {
  return {
    root,
    startedAt: Date.now(),
    entries: 0,
    files: 0,
    bytes: 0,
    metadataBytes: 0,
    directories: [{ target: root, identity }],
    directorySnapshots: [],
    fileSnapshots: [],
    linkSnapshots: [],
    activeDirectories: [{ target: root, identity }],
    testHooks,
  };
}

function addCacheInventoryEntry(entries, budget, entry) {
  budget.metadataBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
  if (budget.metadataBytes > MAX_CACHE_MANIFEST_BYTES - 1024) throw new Error("cached build manifest metadata limit exceeded");
  entries.push(entry);
}

function assertCacheScanWithinBounds(budget) {
  if (Date.now() - budget.startedAt > CACHE_SCAN_TIMEOUT_MS) throw new Error("cached build verification elapsed deadline exceeded");
  if (budget.entries > MAX_CACHE_ENTRIES || budget.files > MAX_CACHE_ENTRIES || budget.bytes > MAX_CACHE_BYTES) {
    throw new Error("cached build verification limit exceeded");
  }
  if (!directoryChainIsSame(budget.activeDirectories)) throw new Error("cached build directory changed during verification");
}

function verifyCacheSnapshotSet(budget) {
  for (const { target, stats, ancestors } of budget.directorySnapshots) {
    assertCacheScanWithinBounds(budget);
    if (!directoryChainIsSame(ancestors)) throw new Error("cached build directory changed during verification");
    let current;
    try { current = fs.lstatSync(target, { bigint: true }); } catch { throw new Error("cached build directory changed during verification"); }
    if (!sameFileSnapshot(stats, current) || !directoryChainIsSame(ancestors)) throw new Error("cached build directory changed during verification");
  }
  for (const [snapshots, isExpectedType] of [
    [budget.fileSnapshots, (stats) => stats.isFile()],
    [budget.linkSnapshots, (stats) => stats.isSymbolicLink()],
  ]) {
    for (const snapshot of snapshots) {
      assertCacheScanWithinBounds(budget);
      if (!directoryChainIsSame(snapshot.ancestors)) throw new Error("cached build entry changed during verification");
      let current;
      try { current = fs.lstatSync(snapshot.target, { bigint: true }); } catch { throw new Error("cached build entry changed during verification"); }
      if (!isExpectedType(current) || !sameFileSnapshot(snapshot.stats, current)
        || !directoryChainIsSame(snapshot.ancestors)) throw new Error("cached build entry changed during verification");
    }
  }
}

function cachePathName(relativePath) {
  if (path.sep !== "/" && relativePath.includes("/")) throw new Error("cached build contains a non-portable path");
  return relativePath.split(path.sep).join("/");
}

function scanBuildArtifact(root, rootIdentity, testHooks, expectedEntries) {
  const budget = cacheScanBudget(root, rootIdentity, testHooks);
  const entries = [];
  if (expectedEntries !== undefined && (!Array.isArray(expectedEntries) || expectedEntries.length > MAX_CACHE_ENTRIES)) {
    throw new Error("cached build manifest inventory is invalid");
  }
  const expectedByPath = expectedEntries === undefined ? undefined : new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const addEntry = (entry) => {
    addCacheInventoryEntry(entries, budget, entry);
    if (!expectedByPath) return;
    const expected = expectedByPath.get(entry.path);
    if (!expected || JSON.stringify(entry) !== JSON.stringify(expected)) {
      throw new Error("cached build contents do not match their manifest");
    }
    expectedByPath.delete(entry.path);
  };
  const visit = (directoryPath, relativeDirectory, depth, ancestors) => {
    if (depth > MAX_SOURCE_DEPTH) throw new Error("cached build depth limit exceeded");
    assertCacheScanWithinBounds(budget);
    const before = fs.lstatSync(directoryPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !hasPositiveIdentity(before)) {
      throw new Error("cached build contains an unsafe directory");
    }
    const identity = { dev: before.dev, ino: before.ino };
    const current = { target: directoryPath, identity };
    const chain = [...ancestors, current];
    const previousActiveDirectories = budget.activeDirectories;
    budget.directorySnapshots.push({ target: directoryPath, stats: before, ancestors: chain });
    budget.activeDirectories = chain;
    if (relativeDirectory !== "") {
      addEntry({
        path: relativeDirectory,
        type: "directory",
        mode: Number(before.mode & 0o777n),
        size: before.size.toString(),
        dev: before.dev.toString(),
        ino: before.ino.toString(),
      });
    }
    let directory;
    try {
      assertCacheScanWithinBounds(budget);
      directory = fs.opendirSync(directoryPath);
      if (!sameDirectoryIdentity(directoryPath, identity)) throw new Error("cached build directory changed while opening");
      for (;;) {
        assertCacheScanWithinBounds(budget);
        const entry = directory.readSync();
        assertCacheScanWithinBounds(budget);
        if (!entry) break;
        budget.entries += 1;
        if (budget.entries > MAX_CACHE_ENTRIES) throw new Error("cached build entry limit exceeded");
        const name = entry.name;
        // No initialized Terraform content participates in this cache; prune before lstat or descent.
        if (name === ".terraform") continue;
        if (relativeDirectory === ""
          && (name === SOURCE_CACHE_MANIFEST || name === generations.RECORD || name === generations.MARKER)) continue;
        if (name.includes("\\")) throw new Error("cached build contains a non-portable path");
        const absolute = path.join(directoryPath, name);
        const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (relative.length > MAX_PATH_LENGTH) throw new Error("cached build path limit exceeded");
        if (!directoryChainIsSame(chain)) throw new Error("cached build directory changed during verification");
        const stats = fs.lstatSync(absolute, { bigint: true });
        if (!hasPositiveIdentity(stats)) throw new Error("cached build entry identity is unavailable");
        if (stats.isSymbolicLink()) {
          if (!relative.startsWith("node_modules/.bin/")) throw new Error("cached build contains an unexpected symlink");
          const target = fs.readlinkSync(absolute);
          if (target.length === 0 || target.length > MAX_PATH_LENGTH || path.isAbsolute(target)
            || /[\u0000-\u001f\u007f]/u.test(target)) throw new Error("cached build contains an unsafe binary link");
          const targetPath = path.resolve(path.dirname(absolute), target);
          if (!pathIsWithin(root, targetPath)) throw new Error("cached build binary link escapes its stage");
          const targetRelative = cachePathName(path.relative(root, targetPath));
          const targetStats = lstatRegularFile(targetPath);
          const after = fs.lstatSync(absolute, { bigint: true });
          if (!sameFileSnapshot(stats, after) || !sameFileSnapshot(targetStats, lstatRegularFile(targetPath))) {
            throw new Error("cached build binary link changed during verification");
          }
          budget.linkSnapshots.push({ target: absolute, stats: after, ancestors: [...chain] });
          addEntry({
            path: relative,
            type: "symlink",
            mode: Number(stats.mode & 0o777n),
            size: stats.size.toString(),
            dev: stats.dev.toString(),
            ino: stats.ino.toString(),
            target: targetRelative,
          });
        } else if (stats.isDirectory()) {
          visit(absolute, relative, depth + 1, chain);
        } else if (stats.isFile()) {
          const before = lstatRegularFile(absolute);
          if (before.size > BigInt(MAX_CACHE_BYTES - budget.bytes)) throw new Error("cached build byte limit exceeded");
          budget.files += 1;
          if (budget.files > MAX_CACHE_ENTRIES) throw new Error("cached build file limit exceeded");
          const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const opened = fs.fstatSync(fd, { bigint: true });
            if (!opened.isFile() || !sameFileSnapshot(before, opened)
              || !sameFileSnapshot(before, lstatRegularFile(absolute))) throw new Error("cached build file changed before verification");
            const hash = crypto.createHash("sha256");
            const buffer = Buffer.alloc(SOURCE_COPY_CHUNK_BYTES);
            let position = 0;
            for (;;) {
              assertCacheScanWithinBounds(budget);
              const count = fs.readSync(fd, buffer, 0, buffer.length, position);
              if (count === 0) break;
              budget.bytes += count;
              if (budget.bytes > MAX_CACHE_BYTES) throw new Error("cached build byte limit exceeded");
              hash.update(buffer.subarray(0, count));
              position += count;
            }
            const after = fs.fstatSync(fd, { bigint: true });
            if (!sameFileSnapshot(before, after)
              || !sameFileSnapshot(after, lstatRegularFile(absolute))) throw new Error("cached build file changed during verification");
            budget.fileSnapshots.push({ target: absolute, stats: after, ancestors: [...chain] });
            addEntry({
              path: relative,
              type: "file",
              mode: Number(before.mode & 0o777n),
              size: before.size.toString(),
              dev: before.dev.toString(),
              ino: before.ino.toString(),
              digest: hash.digest("hex"),
            });
            if (typeof budget.testHooks?.afterArtifactFileHashed === "function") {
              budget.testHooks.afterArtifactFileHashed(absolute, relative);
            }
          } finally {
            fs.closeSync(fd);
          }
        } else {
          throw new Error("cached build contains a special file");
        }
      }
      assertCacheScanWithinBounds(budget);
      const after = fs.lstatSync(directoryPath, { bigint: true });
      if (!sameFileSnapshot(before, after)) throw new Error("cached build directory changed during verification");
    } finally {
      if (directory) closeDirectory(directory);
      budget.activeDirectories = previousActiveDirectories;
    }
  };

  visit(root, "", 0, []);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.type === "symlink" && byPath.get(entry.target)?.type !== "file") {
      throw new Error("cached build binary link target is not a verified regular file");
    }
  }
  if (byPath.get("dist/src/session-host/main.js")?.type !== "file") {
    throw new Error("cached build has no compiled native session host entry");
  }
  if (expectedByPath && expectedByPath.size !== 0) throw new Error("cached build contents do not match their manifest");
  verifyCacheSnapshotSet(budget);
  return {
    entries,
    files: budget.files,
    bytes: budget.bytes,
  };
}

function validCacheEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_CACHE_ENTRIES) return false;
  let previous = "";
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.path !== "string" || entry.path.length === 0 || entry.path.length > MAX_PATH_LENGTH
      || entry.path.startsWith("/") || entry.path.includes("\\")
      || entry.path.split("/").some((component) => component === "" || component === "." || component === "..")
      || (previous !== "" && entry.path <= previous)
      || !["directory", "file", "symlink"].includes(entry.type)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || !/^(?:0|[1-9]\d*)$/u.test(entry.size)
      || !/^(?:0|[1-9]\d*)$/u.test(entry.dev) || !/^[1-9]\d*$/u.test(entry.ino)) return false;
    const expectedKeys = entry.type === "directory"
      ? ["path", "type", "mode", "size", "dev", "ino"]
      : entry.type === "file"
        ? ["path", "type", "mode", "size", "dev", "ino", "digest"]
        : ["path", "type", "mode", "size", "dev", "ino", "target"];
    if (Object.keys(entry).sort().join(",") !== expectedKeys.sort().join(",")) return false;
    if (entry.type === "file" && !/^[a-f0-9]{64}$/u.test(entry.digest)) return false;
    if (entry.type === "symlink" && (typeof entry.target !== "string" || entry.target.length === 0
      || entry.target.startsWith("/") || entry.target.includes("\\")
      || entry.target.split("/").some((component) => component === "" || component === "." || component === ".."))) return false;
    previous = entry.path;
  }
  return true;
}

function writeSourceBuildManifest(stageRoot, metadata) {
  const identity = identityOfDirectory(stageRoot);
  const inventory = scanBuildArtifact(stageRoot, identity);
  const manifest = {
    schema: 1,
    cacheKey: metadata.cacheKey,
    sourceFingerprint: metadata.sourceFingerprint,
    toolchainFingerprint: metadata.toolchainFingerprint,
    root: { dev: identity.dev.toString(), ino: identity.ino.toString(), mode: Number(fs.lstatSync(stageRoot, { bigint: true }).mode & 0o777n) },
    entries: inventory.entries,
  };
  if (!validCacheEntries(manifest.entries)) throw new Error("cached build manifest entries are invalid");
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (bytes.length > MAX_CACHE_MANIFEST_BYTES) throw new Error("cached build manifest exceeds its bounded size");
  const file = path.join(stageRoot, SOURCE_CACHE_MANIFEST);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !hasPositiveIdentity(opened) || !sameStatIdentity(opened, lstatRegularFile(file))) {
      throw new Error("cached build manifest identity is unavailable");
    }
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameStatIdentity(opened, after) || after.size !== BigInt(bytes.length)
      || !sameStatIdentity(after, lstatRegularFile(file))) throw new Error("cached build manifest changed during publication");
  } finally {
    fs.closeSync(fd);
  }
  return manifest;
}

/**
 * Validate every file and directory that can participate in loading a staged
 * package. Cache metadata is integrity evidence, not an adversarial same-user
 * sandbox: a same-user actor able to rewrite both artifacts and manifest can
 * forge this cache, but symlinks, partial output, races, and ordinary damage
 * fail closed. Every artifact byte is rehashed under fixed count/byte/time caps.
 */
function readSourceBuildCandidate(stageRoot, metadata, expectedParentChain) {
  try {
    if (expectedParentChain && !directoryChainIsSame(expectedParentChain)) return undefined;
    const rootStats = fs.lstatSync(stageRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !hasPositiveIdentity(rootStats)) return undefined;
    if (process.platform !== "win32" && (rootStats.mode & 0o077n) !== 0n) return undefined;
    const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
    const manifestPath = path.join(stageRoot, SOURCE_CACHE_MANIFEST);
    const manifestBefore = lstatRegularFile(manifestPath);
    if (process.platform !== "win32" && (manifestBefore.mode & 0o077n) !== 0n) return undefined;
    if (manifestBefore.size > BigInt(MAX_CACHE_MANIFEST_BYTES)) return undefined;
    const manifestBytes = readBoundedRegularFile(manifestPath, MAX_CACHE_MANIFEST_BYTES);
    const manifestAfter = lstatRegularFile(manifestPath);
    if (!sameFileSnapshot(manifestBefore, manifestAfter)) return undefined;
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(",") !== ["schema", "cacheKey", "sourceFingerprint", "toolchainFingerprint", "root", "entries"].sort().join(",")
      || manifest.schema !== 1 || manifest.cacheKey !== metadata.cacheKey
      || manifest.sourceFingerprint !== metadata.sourceFingerprint
      || manifest.toolchainFingerprint !== metadata.toolchainFingerprint
      || !manifest.root || typeof manifest.root !== "object" || Array.isArray(manifest.root)
      || Object.keys(manifest.root).sort().join(",") !== ["dev", "ino", "mode"].sort().join(",")
      || manifest.root.dev !== rootStats.dev.toString() || manifest.root.ino !== rootStats.ino.toString()
      || manifest.root.mode !== Number(rootStats.mode & 0o777n)
      || !validCacheEntries(manifest.entries)) return undefined;
    if (!directoryChainIsSame(expectedParentChain ?? []) || !sameDirectoryIdentity(stageRoot, rootIdentity)
      || !sameFileSnapshot(manifestAfter, lstatRegularFile(manifestPath))) return undefined;
    return { root: stageRoot, identity: rootIdentity, manifest, manifestIdentity: manifestAfter };
  } catch {
    return undefined;
  }
}

// Keep #375's existing freshness pointer from permanently shadowing a new
// completed build of an evicted key. Only its own validated, unchanged record
// is retired, after actual generation removal; invalid/unknown records survive.
function prepareSourceCacheRetirement(root, cacheRoot, parentChain) {
  try {
    const manifest = JSON.parse(readBoundedRegularFile(path.join(root, SOURCE_CACHE_MANIFEST), MAX_CACHE_MANIFEST_BYTES).toString("utf8"));
    if (!manifest || !/^[a-f0-9]{64}$/u.test(manifest.cacheKey)) return undefined;
    const recordPath = sourceBuildCacheRecordPath(cacheRoot, manifest.cacheKey);
    const record = readSourceBuildCacheRecord(recordPath, cacheRoot, manifest, parentChain);
    if (!record || record.root !== root) return undefined;
    return () => {
      if (directoryChainIsSame(parentChain) && sameFileSnapshot(record.recordIdentity, lstatRegularFile(recordPath))) fs.unlinkSync(recordPath);
    };
  } catch { return undefined; }
}

function sourceBuildCacheRecordPath(cacheRoot, cacheKey) {
  return path.join(path.resolve(cacheRoot), `source-${cacheKey}.json`);
}

function readSourceBuildCacheRecord(recordPath, cacheRoot, metadata, expectedParentChain) {
  try {
    if (!directoryChainIsSame(expectedParentChain ?? [])) return undefined;
    const recordBefore = lstatRegularFile(recordPath);
    if (process.platform !== "win32" && (recordBefore.mode & 0o077n) !== 0n) return undefined;
    if (recordBefore.size > BigInt(MAX_SOURCE_CACHE_RECORD_BYTES)) return undefined;
    const bytes = readBoundedRegularFile(recordPath, MAX_SOURCE_CACHE_RECORD_BYTES);
    const recordAfter = lstatRegularFile(recordPath);
    if (!sameFileSnapshot(recordBefore, recordAfter)) return undefined;
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)
      || Object.keys(record).sort().join(",") !== ["schema", "cacheKey", "sourceFingerprint", "toolchainFingerprint", "stageName", "root"].sort().join(",")
      || record.schema !== 1 || record.cacheKey !== metadata.cacheKey
      || record.sourceFingerprint !== metadata.sourceFingerprint
      || record.toolchainFingerprint !== metadata.toolchainFingerprint
      || typeof record.stageName !== "string" || !/^pi-review-sessions-[a-f0-9]{32}$/u.test(record.stageName)
      || !record.root || typeof record.root !== "object" || Array.isArray(record.root)
      || Object.keys(record.root).sort().join(",") !== ["dev", "ino", "mode"].sort().join(",")
      || !/^(?:0|[1-9]\d*)$/u.test(record.root.dev) || !/^[1-9]\d*$/u.test(record.root.ino)
      || !Number.isInteger(record.root.mode) || record.root.mode < 0 || record.root.mode > 0o777) return undefined;
    const stageRoot = path.join(path.resolve(cacheRoot), record.stageName);
    if (path.dirname(stageRoot) !== path.resolve(cacheRoot)) return undefined;
    const rootStats = fs.lstatSync(stageRoot, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !hasPositiveIdentity(rootStats)
      || rootStats.dev.toString() !== record.root.dev || rootStats.ino.toString() !== record.root.ino
      || Number(rootStats.mode & 0o777n) !== record.root.mode
      || (process.platform !== "win32" && (rootStats.mode & 0o077n) !== 0n)) return undefined;
    const candidate = readSourceBuildCandidate(stageRoot, metadata, expectedParentChain);
    if (!candidate || candidate.identity.dev.toString() !== record.root.dev || candidate.identity.ino.toString() !== record.root.ino
      || !sameFileSnapshot(recordAfter, lstatRegularFile(recordPath))
      || !directoryChainIsSame(expectedParentChain ?? [])) return undefined;
    return { ...candidate, recordIdentity: recordAfter, recordPath };
  } catch {
    return undefined;
  }
}

function writeSourceBuildCacheRecord(recordPath, cacheRoot, metadata, ownedStage, cacheParentChain) {
  if (!directoryChainIsSame(cacheParentChain) || !directoryChainIsSame(ownedStage.chain)) {
    throw new Error("source cache publication ancestors changed");
  }
  const stageName = path.basename(ownedStage.root);
  if (!/^pi-review-sessions-[a-f0-9]{32}$/u.test(stageName) || path.dirname(ownedStage.root) !== path.resolve(cacheRoot)) {
    throw new Error("source cache stage name is not publishable");
  }
  const rootStats = fs.lstatSync(ownedStage.root, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !hasPositiveIdentity(rootStats)
    || rootStats.dev !== ownedStage.identity.dev || rootStats.ino !== ownedStage.identity.ino
    || (process.platform !== "win32" && (rootStats.mode & 0o077n) !== 0n)) {
    throw new Error("source cache stage identity changed before publication");
  }
  const record = {
    schema: 1,
    cacheKey: metadata.cacheKey,
    sourceFingerprint: metadata.sourceFingerprint,
    toolchainFingerprint: metadata.toolchainFingerprint,
    stageName,
    root: { dev: rootStats.dev.toString(), ino: rootStats.ino.toString(), mode: Number(rootStats.mode & 0o777n) },
  };
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.length > MAX_SOURCE_CACHE_RECORD_BYTES) throw new Error("source cache record exceeds its bounded size");
  const fd = fs.openSync(recordPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !hasPositiveIdentity(opened) || !sameStatIdentity(opened, lstatRegularFile(recordPath))) {
      throw new Error("source cache record identity is unavailable");
    }
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameStatIdentity(opened, after) || after.size !== BigInt(bytes.length)
      || !sameFileSnapshot(after, lstatRegularFile(recordPath))
      || !directoryChainIsSame(cacheParentChain) || !directoryChainIsSame(ownedStage.chain)) {
      throw new Error("source cache record changed during publication");
    }
    return { dev: after.dev, ino: after.ino };
  } finally {
    fs.closeSync(fd);
  }
}

function validateSourceBuildArtifact(stageRoot, metadata, expectedParentChain, testHooks) {
  const candidate = readSourceBuildCandidate(stageRoot, metadata, expectedParentChain);
  if (!candidate) return undefined;
  try {
    const inventory = scanBuildArtifact(stageRoot, candidate.identity, testHooks, candidate.manifest.entries);
    const manifestPath = path.join(stageRoot, SOURCE_CACHE_MANIFEST);
    if (!directoryChainIsSame(expectedParentChain ?? []) || !sameDirectoryIdentity(stageRoot, candidate.identity)
      || !sameFileSnapshot(candidate.manifestIdentity, lstatRegularFile(manifestPath))) return undefined;
    return { root: stageRoot, identity: candidate.identity, entries: inventory.entries, files: inventory.files, bytes: inventory.bytes };
  } catch {
    return undefined;
  }
}

function acquireSourceCacheLock(cacheRoot, cacheKey, parentChain) {
  const file = path.join(cacheRoot, `.source-build-${cacheKey}.lock`);
  let fd;
  try {
    if (!directoryChainIsSame(parentChain)) return undefined;
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const stats = fs.fstatSync(fd, { bigint: true });
    if (!stats.isFile() || !hasPositiveIdentity(stats) || !directoryChainIsSame(parentChain)
      || !sameStatIdentity(stats, lstatRegularFile(file))) {
      fs.closeSync(fd);
      return undefined;
    }
    fs.writeSync(fd, `${process.pid}:${cacheKey}\n`);
    fs.fsyncSync(fd);
    const identity = { dev: stats.dev, ino: stats.ino };
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          if (directoryChainIsSame(parentChain) && sameFileIdentity(file, identity)) fs.unlinkSync(file);
        } catch {
          // Unknown or changed lock contents are preserved.
        } finally {
          fs.closeSync(fd);
        }
      },
    };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error.code === "EEXIST") return undefined;
    return undefined;
  }
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
  return { ...validated, source: "isolated-cache" };
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
  // A compatible reuse or a settled provisioning pass runs the same bounded
  // cleanup-only pass: target five, and the generation this launch is using is
  // never a candidate. Nothing is installed or recreated to trigger it.
  const cleanupAround = (selectedRoot) => {
    try {
      generations.cleanup(runtimeRoot, { keep: [selectedRoot], warn });
    } catch (error) {
      warn(`cache cleanup could not complete (${error && error.message}); the runtime is unaffected`);
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
      cleanupAround(versionRoot);
      return validated;
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
        cleanupAround(versionRoot);
        return validated;
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
      }, { replacement, warn });
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
      writeError(`pi-review-sessions: installed isolated Pi ${version} runtime at ${runtimeRoot}\n`);
      published = true;
      return { ...result, source: "isolated-cache" };
    } finally {
      if (!published) {
        // Retained incomplete setup is disposable by location and is reclaimed by
        // the next producer cleanup; nothing here can block a later start.
        writeError("pi-review-sessions: retained an incomplete Pi runtime generation; the next launch reclaims excess cache generations.\n");
      }
      ownedStage.generation.release();
      // Settlement retries cleanup that contention deferred while this producer
      // was still installing, keeping the generation it just produced.
      cleanupAround(versionRoot);
    }
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
  const validated = await validate(guardedRunner);
  // A validated reuse advances pending cleanup toward the per-type target without
  // creating anything, and the generation this launch selected is never a
  // candidate. Cleanup trouble never changes the selection result.
  try {
    generations.cleanup(managed.cacheRoot, {
      keep: [managed.root],
      warn: typeof options.warn === "function" ? options.warn : undefined,
    });
  } catch (error) {
    if (typeof options.warn === "function") {
      options.warn(`cache cleanup could not complete (${error && error.message}); the selected runtime is unaffected`);
    }
  }
  return validated;
}

/**
 * Resolve the public supported Pi CLI entry (issue 323). Order: explicit
 * --pi-executable (validated, no fallback), npm global package root, PATH
 * `pi` inside the public package, isolated cache provisioning. Returns
 * { file, version, source }; throws PiRuntimeError with a bounded message.
 */
async function resolvePiRuntime(options) {
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
    }, { warn: warnCache });
  }

  const npmCli = findNpmCli(env);
  const globalRoot = npmCli ? await npmGlobalRoot(env, npmCli) : undefined;
  if (globalRoot) {
    const pkgDir = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (pathExists(pkgDir)) {
      try {
        return await withManagedPiSelection(pkgDir, processRunner, async (runner) => ({
          ...await validatePiPackage(pkgDir, env, { processRunner: runner }), source: "npm-global",
        }), { warn: warnCache });
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
        }), { warn: warnCache });
      } catch (error) {
        if (error && error.cleanupUnconfirmed) throw error;
        // Not positively identified as the public package: fall through.
      }
    }
  }

  writeError(`pi-review-sessions: no supported pi installation found; provisioning isolated Pi ${PI_PROVISION_VERSION} runtime\n`);
  return provisionPiRuntime({ env, agentDir, writeError, npmCli });
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

/**
 * Wrapper-equivalent shipped-skill provisioning for direct sidebar launches
 * (issue 378). Refreshes every file in the canonical SKILL_PUBLISH_PLAN from
 * the package root into <home>/.agents/skills/<name>/... using the shared
 * atomic per-file publication (byte-identical files are reused untouched),
 * then runs the ownership-safe pre-#151 generic-location migration. Fails
 * closed BEFORE any publication when a packaged source is missing, and a
 * failed publication or directory creation stops the launch with an
 * actionable error. The platform seam mirrors the wrapper: win32 path
 * semantics on Windows, POSIX elsewhere.
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function refreshShippedSkills(packageRoot, homeDir, platform) {
  const joinFor = platform === "win32" ? path.win32 : path.posix;
  // Fail closed before any publication when a packaged skill file is missing.
  for (const skill of gateLauncher.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = joinFor.join(packageRoot, ...file.source);
      if (!isRegularFile(source)) {
        return { ok: false, error: `packaged skill file is missing: ${source}` };
      }
    }
  }
  for (const skill of gateLauncher.SKILL_PUBLISH_PLAN) {
    const skillDir = joinFor.join(homeDir, ".agents", "skills", skill.name);
    for (const file of skill.files) {
      const source = joinFor.join(packageRoot, ...file.source);
      const destination = joinFor.join(skillDir, ...file.destination);
      try {
        fs.mkdirSync(joinFor.dirname(destination), { recursive: true });
      } catch {
        return { ok: false, error: `could not create the skill directory ${joinFor.dirname(destination)} (permission denied?)` };
      }
      if (!gateLauncher.refreshSkillFile(source, destination)) {
        return { ok: false, error: `could not refresh the shipped skill file at ${destination}; re-run the launcher` };
      }
    }
  }
  // Only after every namespaced skill published successfully: best-effort,
  // fail-safe removal of the historical generic install locations (owned
  // copies only; user-owned files are preserved).
  gateLauncher.migrateGenericSkillFiles(homeDir, platform);
  return { ok: true };
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
    build: buildSourceExtension,
    // Run the shared DDGS helper in a bounded, killable setup process group.
    // Its ordinary helper semantics stay unchanged; only its JSON result crosses
    // back, and bootstrap/restore values are absent from the setup environment.
    ensureDdgs: (homeDir, env, packageRoot) => runDdgsSetup(homeDir, env, packageRoot),
    refreshShippedSkills: (packageRoot, homeDir) => {
      // Wrapper-equivalent skill publication home (issue 378): on native
      // Windows Pi's discovery home is USERPROFILE via os.homedir() — the
      // wrapper's exact semantics — which can differ from HOME; POSIX keeps
      // the HOME-first setup home. DDGS/cache behavior is unchanged.
      const platform = process.platform;
      return refreshShippedSkills(packageRoot, platform === "win32" ? os.homedir() : homeDir, platform);
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
    deps.writeError("pi-review-sessions: Node >=22.19.0 is required.\n");
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
  // The host's runtime file lookups (extension entry, reporter, preload,
  // native skill sources) resolve against this root; a staged source build
  // redirects it to the owned stage so nothing is read from the live dist.
  let hostPackageRoot = packageRoot;
  let sourceBuildResult;
  let piRuntime;
  // Cache generations are disposable by location and are never pinned by this
  // launcher; the host's own exclusive agent-directory ownership guards active
  // sessions. No cache-lifetime handoff exists here any more.
  const finish = (status) => status;
  const sourceEntry = path.join(packageRoot, "src", "session-host", "main.ts");
  let compiledEntry = path.join(packageRoot, "dist", "src", "session-host", "main.js");
  let sourceCheckout = false;
  try {
    sourceCheckout = fs.existsSync(sourceEntry);
  } catch {
    sourceCheckout = false;
  }

  if (sourceCheckout) {
    // Source launch builds in an owned staging package root (never the live
    // checkout, whose dist/ a running extension may be using) and loads the
    // compiled host from that stage.
    let build;
    try {
      build = await deps.build({ packageRoot, agentDir, env: setupEnv, writeError: (text) => deps.writeError(text) });
    } catch {
      deps.writeError("pi-review-sessions: extension build failed.\n");
      return 1;
    }
    if (!build || build.status !== 0 || build.error || build.signal || build.timedOut || build.outputExceeded || build.cleanupConfirmed === false) {
      const detail = build && build.timedOut
        ? " (setup deadline exceeded)"
        : build && build.outputExceeded
          ? " (output limit exceeded)"
          : build && typeof build.signal === "string"
            ? ` (terminated by ${build.signal})`
            : build && build.cleanupConfirmed === false
              ? " (process cleanup was not confirmed)"
              : build && Number.isInteger(build.status)
                ? ` (exit status ${build.status})`
                : "";
      deps.writeError(`pi-review-sessions: extension build failed${detail}.\n`);
      if (build && typeof build.stage === "string") {
        deps.writeError(`pi-review-sessions: failed build stage: ${build.stage === "install" ? BUILD_STAGE_LABELS.install : build.stage === "compile" ? BUILD_STAGE_LABELS.compile : BUILD_STAGE_LABELS.stage}.\n`);
      }
      // Bounded, sanitized stderr/stdout from the owned stage child's own
      // streams only; it never carries credentials or the caller's environment.
      if (build && typeof build.diagnostics === "string" && build.diagnostics.length > 0) deps.writeError(build.diagnostics);
      if (build && build.retainedStage) deps.writeError("pi-review-sessions: an incomplete source generation was retained; the next launch reclaims excess cache generations.\n");
      return statusCode(build);
    }
    sourceBuildResult = build;
    if (typeof build.stagingRoot === "string" && build.stagingRoot.length > 0) {
      hostPackageRoot = build.stagingRoot;
      compiledEntry = path.join(build.stagingRoot, "dist", "src", "session-host", "main.js");
    }
  }

  if (!deps.isRegularFile(compiledEntry)
    && !(sourceBuildResult && (sourceBuildResult.cacheHit || sourceBuildResult.cachePublished))) {
    deps.writeError("pi-review-sessions: compiled native session host is unavailable.\n");
    return 2;
  }

  // Resolve or provision the Pi runtime BEFORE any host capability exists:
  // probes and provisioning run on the scrubbed setup env, so no bootstrap/
  // restore token reaches them, and the resolved entry is handed to the host
  // as an explicit executable (never a bare PATH name).
  try {
    piRuntime = await deps.resolvePiRuntime({
      explicit: parsed.piExecutable,
      env: setupEnv,
      agentDir,
      cwd: deps.cwd,
      writeError: (text) => deps.writeError(text),
    });
  } catch (error) {
    // The unresolved Pi producer/probe owns its own runtime state. It has not
    // consumed this prepared source build.
    const message = error instanceof PiRuntimeError ? error.message : "Pi runtime selection failed.";
    deps.writeError(`pi-review-sessions: ${message}\n`);
    return 1;
  }
  if (!piRuntime || typeof piRuntime.file !== "string" || piRuntime.file.length > MAX_PATH_LENGTH || !path.isAbsolute(piRuntime.file) || typeof piRuntime.version !== "string" || piRuntime.version.length > 64) {
    deps.writeError("pi-review-sessions: Pi runtime selection failed.\n");
    return 1;
  }
  deps.writeError(`pi-review-sessions: pi runtime: ${piRuntime.file} (v${piRuntime.version}, ${piRuntime.source})\n`);

  const sourceBuildNeedsFresh = () => {
    if (!sourceBuildResult || typeof sourceBuildResult.sourceFingerprint !== "string") return false;
    try {
      const sourceIdentity = fingerprintSourcePackage(packageRoot);
      if (sourceIdentity.digest !== sourceBuildResult.sourceFingerprint) return true;
      if (sourceBuildResult.cacheHit || sourceBuildResult.cachePublished) {
        if (typeof sourceBuildResult.cacheKey !== "string" || typeof sourceBuildResult.toolchainFingerprint !== "string"
          || !verifyToolchainFence(sourceBuildResult.toolchainFence)) return true;
        const artifact = validateSourceBuildArtifact(hostPackageRoot, {
          cacheKey: sourceBuildResult.cacheKey,
          sourceFingerprint: sourceBuildResult.sourceFingerprint,
          toolchainFingerprint: sourceBuildResult.toolchainFingerprint,
        }, sourceBuildResult.cacheParentChain, sourceBuildResult.testHooks);
        return !artifact || !verifyToolchainFence(sourceIdentity.fence)
          || !verifyToolchainFence(sourceBuildResult.toolchainFence);
      }
      return false;
    } catch {
      return true;
    }
  };

  const refreshSourceBuildIfNeeded = async () => {
    if (!sourceBuildNeedsFresh()) return { ok: true, changed: false };
    const previousRoot = hostPackageRoot;
    let freshBuild;
    try {
      freshBuild = await deps.build({ packageRoot, agentDir, env: setupEnv, forceFresh: true, writeError: (text) => deps.writeError(text) });
    } catch {
      deps.writeError("pi-review-sessions: extension build failed.\n");
      return { ok: false, changed: false };
    }
    if (!freshBuild || freshBuild.status !== 0 || freshBuild.error || freshBuild.signal
      || freshBuild.timedOut || freshBuild.outputExceeded || freshBuild.cleanupConfirmed === false
      || typeof freshBuild.stagingRoot !== "string" || freshBuild.stagingRoot.length === 0
      || freshBuild.stagingRoot === previousRoot || freshBuild.cacheHit === true) {
      deps.writeError("pi-review-sessions: extension build failed while replacing an invalid cached source build.\n");
      if (freshBuild && typeof freshBuild.diagnostics === "string" && freshBuild.diagnostics.length > 0) deps.writeError(freshBuild.diagnostics);
      return { ok: false, changed: false };
    }
    sourceBuildResult = freshBuild;
    hostPackageRoot = freshBuild.stagingRoot;
    compiledEntry = path.join(hostPackageRoot, "dist", "src", "session-host", "main.js");
    if (!deps.isRegularFile(compiledEntry)) {
      deps.writeError("pi-review-sessions: compiled native session host is unavailable.\n");
      return { ok: false, changed: false };
    }
    if (typeof freshBuild.sourceFingerprint === "string") {
      try {
        if (fingerprintSourcePackage(packageRoot).digest !== freshBuild.sourceFingerprint) {
          deps.writeError("pi-review-sessions: source changed during startup; refusing a stale source build.\n");
          return { ok: false, changed: false };
        }
      } catch {
        deps.writeError("pi-review-sessions: source changed during startup; refusing an unverifiable source build.\n");
        return { ok: false, changed: false };
      }
    }
    return { ok: true, changed: true };
  };

  // No source-cached script is invoked before its complete artifact tree is
  // verified. If the candidate is unsafe or raced, use a separate fresh stage.
  const beforeDdgs = await refreshSourceBuildIfNeeded();
  if (!beforeDdgs.ok) return 1;

  // The shared DDGS helper runs in a bounded owned Node process (a POSIX
  // group, but only the direct Windows child). setupEnv is already scrubbed.
  const ensureDdgsForRoot = async (runtimePackageRoot) => {
    const savedTokens = {};
    for (const name of HOST_ENV_TO_CLEAR) {
      if (name in process.env) {
        savedTokens[name] = process.env[name];
        delete process.env[name];
      }
    }
    let result;
    let error;
    try {
      result = await deps.ensureDdgs(homeDir, setupEnv, runtimePackageRoot);
    } catch (caught) {
      error = caught;
    } finally {
      for (const [name, value] of Object.entries(savedTokens)) process.env[name] = value;
    }
    return { result, error };
  };
  let ddgsAttempt = await ensureDdgsForRoot(hostPackageRoot);
  if (ddgsAttempt.error) {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return 1;
  }
  let ddgs = ddgsAttempt.result;
  if (!ddgs || ddgs.cleanupUnconfirmed || ddgs.ok !== true || typeof ddgs.python !== "string") {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return ddgs && Number.isInteger(ddgs.exitCode) ? ddgs.exitCode : 1;
  }
  let python = ddgs.python;
  if (python.length > MAX_PATH_LENGTH || !path.isAbsolute(python) || /[\u0000-\u001f\u007f]/u.test(python)) {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return 1;
  }

  // Coordinated selection/preparation handoff to host ownership (issue 385): take
  // the canonical per-agent coordination entry BEFORE the final selection
  // revalidation, the host-entry load, and the host's ownership claim, and hand it
  // back once the host's exclusive ownership record exists (the host releases the
  // entry it finds held by this same process). Another preparation therefore
  // cannot reclaim the selection this launch is handing over. A live destructive
  // holder is waited for, not bypassed; a genuine unremovable-artifact/IO failure
  // proceeds truthfully, because the ownership record itself stops producer
  // removals at every destructive boundary.
  const handoff = generations.holdAgentDirectory(agentDir);
  if (!handoff) {
    deps.writeError("pi-review-sessions: per-agent cache coordination was unavailable; this launch continues and the host's ownership record still stops cache reclamation once it exists.\n");
  }
  // The handoff is released only by the ownership claim itself or by this
  // launcher's own exit: an elapsed timer must never hand back the entry while
  // preparation (final rebuild, DDGS setup, runtime reselection) is still active.
  try {
    // Recheck after DDGS and before require. A changed cache is rebuilt privately;
    // DDGS is then revalidated against the replacement package root.
    const afterDdgs = await refreshSourceBuildIfNeeded();
    if (!afterDdgs.ok) return 1;
    if (afterDdgs.changed) {
      ddgsAttempt = await ensureDdgsForRoot(hostPackageRoot);
      if (ddgsAttempt.error) {
        deps.writeError("pi-review-sessions: DDGS setup failed.\n");
        return 1;
      }
      ddgs = ddgsAttempt.result;
      if (!ddgs || ddgs.cleanupUnconfirmed || ddgs.ok !== true || typeof ddgs.python !== "string") {
        deps.writeError("pi-review-sessions: DDGS setup failed.\n");
        return ddgs && Number.isInteger(ddgs.exitCode) ? ddgs.exitCode : 1;
      }
      python = ddgs.python;
      if (python.length > MAX_PATH_LENGTH || !path.isAbsolute(python) || /[\u0000-\u001f\u007f]/u.test(python)) {
        deps.writeError("pi-review-sessions: DDGS setup failed.\n");
        return 1;
      }
      if (sourceBuildNeedsFresh()) {
        deps.writeError("pi-review-sessions: source build changed during final startup validation.\n");
        return 1;
      }
    }

    // Wrapper-equivalent shipped-skill provisioning (issue 378): the direct
    // sidebar entry points prepare the discoverable skills themselves — no
    // wrapper prerequisite. Runs after the final build/DDGS revalidation so it
    // publishes from the exact package root the host will load.
    const skills = deps.refreshShippedSkills(hostPackageRoot, homeDir);
    if (!skills || skills.ok !== true) {
      const detail = skills && typeof skills.error === "string" ? `: ${skills.error}` : "";
      deps.writeError(`pi-review-sessions: shipped skill provisioning failed${detail}.\n`);
      return 1;
    }

    // Re-enter the launcher's normal validated selection for a managed Pi runtime
    // inside the same hold. The existing resolver/validator (managed generation
    // confinement, package/version validation, and the pinned CLI's own version
    // probe) rejects a partially reclaimed generation instead of trusting a
    // surviving CLI name, and a replacement is prepared through the existing
    // selection path. Installed, PATH, and user-explicit selections are unchanged,
    // no build inventory is added, and no last-moment startup refusal is created.
    // The running Node itself is already protected for this session by the
    // bootstrap producer's transient live generation marker.
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
          // The probe's termination was not confirmed: fail closed instead of
          // re-preparing (which could reclaim a still-running runtime).
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
    // Hand the entry back unless the host already took it over when it created its
    // ownership record; release is identity-guarded, so a taken-over entry is a
    // no-op here.
    handoff?.release();
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
    refreshShippedSkills,
    resolvePiRuntime,
    buildSourceExtension,
    provisionPiRuntime,
    validatePiPackage,
    probePiVersion,
    runDdgsSetup,
    stageSourcePackage,
    fingerprintSourcePackage,
    sourceBuildCacheEligible,
    verifyToolchainFence,
    readSourceBuildCandidate,
    validateSourceBuildArtifact,
    scanBuildArtifact,
    createOwnedStage,
    findNpmCli,
    findPiOnPath,
    runBoundedProcess,
    boundedProcessCleanupStatus,
    sanitizeDiagnosticText,
    boundDiagnosticText,
    formatBuildStageDiagnostics,
    activeBoundedProcessCount: () => activeBoundedProcessCount,
  },
};
