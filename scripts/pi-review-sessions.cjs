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
 * - Source checkouts are copied to a fresh stage, install unchanged
 *   package-lock dependencies with npm ci, then build there. DDGS
 *   provisioning uses the shared Node helper (ensureDdgs in scripts/
 *   pi-review-gate-launcher.cjs) in a bounded owned process. Automatic stage
 *   cleanup is disabled because root identity does not prove ownership of
 *   npm/build/runtime descendants and complete per-entry creation receipts
 *   with BigInt identities are not recorded.
 * - Runtime selection resolves the public @earendil-works/pi-coding-agent
 *   CLI without parsing or executing opaque shims: an explicit
 *   --pi-executable Node entry is honored when valid; otherwise the npm
 *   global package root's declared bin entry is validated (package name,
 *   stable version floor, bin containment, regular readable positive Node
 *   entry), then a PATH `pi` that resolves into such a package. When no
 *   supported installation exists, an isolated Pi 1.0.4 runtime is
 *   provisioned under the native Pi agent directory's cache
 *   (<agent-dir>/.pi-review-gate/pi-runtime) with npm --ignore-scripts and
 *   re-validated before publication. Global installs and existing user
 *   files are never modified; failed or unknown cache resources are
 *   preserved, and staging trees are retained without complete per-entry
 *   creation receipts.
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

const USAGE = `Usage: pi-review-sessions [--pi-executable <path>] [--state-root <path>] [--sidebar-key <key>] [--help] [-- <Pi arguments...>]

Alpha same-machine macOS/Linux session host with Windows source paths available
for native validation only (not a Windows readiness claim). Requires Node >=22.19.0
and Pi >=1.0.4 with a positively identified Node CLI entry. Without --pi-executable the
launcher resolves the public @earendil-works/pi-coding-agent installation
(npm global root, then PATH) and, when none is supported, provisions an
isolated Pi 1.0.4 runtime cache under the native Pi agent directory; no
manual Pi CLI path is needed. Starts an empty welcome/sidebar picker; choose
a workspace explicitly in the UI.
The startup working directory is not selected as a workspace.
Basic controls only; terminal graphics rendering is disabled.
Native image/model input behavior stays native. The sidebar toggle defaults
to alt+left. Parent startup session overrides
(--continue/-c, --resume/-r, --session, --session-id, --fork, --session-dir,
--no-session, PI_CODING_AGENT_SESSION_DIR) are not accepted: every instance
starts a new native conversation using Pi's normal session storage.`;

const MAX_PATH_LENGTH = 2048;
const MAX_TOGGLE_KEY_LENGTH = 80;
const HOST_ENV_TO_CLEAR = [
  "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP",
  "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE",
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
const PI_PROVISION_VERSION = "1.0.4";
const RUNTIME_CACHE_DIRNAME = ".pi-review-gate";
const PI_RUNTIME_DIRNAME = "pi-runtime";

// Bounded probe/provision limits (mirrors src/session-host/launch.ts).
const VERSION_PROBE_MAX_BYTES = 8 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const NPM_ROOT_TIMEOUT_MS = 60_000;
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const SOURCE_BUILD_TIMEOUT_MS = 600_000;
const DDGS_SETUP_TIMEOUT_MS = 600_000;
const PROCESS_KILL_GRACE_MS = 500;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NODE_ENTRY_HEAD_BYTES = 512;
const MAX_SOURCE_DEPTH = 64;
const MAX_SOURCE_FILES = 100_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const SOURCE_COPY_CHUNK_BYTES = 64 * 1024;
let activeBoundedProcessCount = 0;

class SessionHostArgumentError extends Error {}
class PiRuntimeError extends Error {}

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
    else toggleKey = value;
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

/**
 * Root identity does not prove creation ownership of descendants written by
 * npm, the build, or runtime provisioning. No complete per-entry creation
 * receipts with BigInt identities are recorded, so retain stages without
 * enumerating or deleting any part of them, even after their setup process has
 * settled.
 */
function removeOwnedStage() {
  return false;
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

function sourceCopyBudget() {
  return { files: 0, bytes: 0, entries: 0, startedAt: Date.now(), directories: [] };
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
    if (!opened.isFile() || !sameStatIdentity(before, opened)
      || !sameStatIdentity(before, lstatRegularFile(source))) throw new Error("source file changed during staging");
    assertSourceCopyWithinBounds(budget);
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const destinationOpened = fs.fstatSync(destinationFd, { bigint: true });
    if (!destinationOpened.isFile() || !hasPositiveIdentity(destinationOpened)
      || !sameStatIdentity(destinationOpened, lstatRegularFile(destination))) {
      throw new Error("staged file identity is unavailable");
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
    const after = fs.fstatSync(sourceFd, { bigint: true });
    assertSourceCopyWithinBounds(budget);
    if (!sameStatIdentity(before, after)
      || !sameStatIdentity(after, lstatRegularFile(source))
      || before.size !== after.size) throw new Error("source file changed during staging");
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
      || !sameStatIdentity(destinationAfter, destinationPathStats)
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

/**
 * Stage only explicit build/runtime inputs into a fresh private root. Copies
 * are bounded and reject symlinks/special files; package-lock.json is copied
 * byte-for-byte, source .terraform directories are pruned before descent, and
 * the live checkout's node_modules/dist are never followed or copied.
 */
function stageSourcePackage(packageRoot, buildCacheRoot) {
  const ownedStage = createOwnedStage(buildCacheRoot, "pi-review-sessions-");
  try {
    const resolvedPackageRoot = path.resolve(packageRoot);
    const packageChain = process.platform === "win32"
      ? assertDirectoryChain(path.parse(resolvedPackageRoot).root, resolvedPackageRoot)
      : [{ target: resolvedPackageRoot, identity: identityOfDirectory(resolvedPackageRoot) }];
    const budget = sourceCopyBudget();
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
    const preserveStage = Boolean(cause && (cause.preserveStage || cause.retainedStage));
    const removed = ownedStage
      ? (!preserveStage && removeOwnedStage(ownedStage))
      : !preserveStage;
    const error = new Error("could not stage the source package for building");
    error.retainedStage = !removed;
    throw error;
  }
  return ownedStage;
}

function stageNpmEnvironment(env, ownedStage) {
  if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
  const npmPaths = {
    cache: path.join(ownedStage.root, ".npm-cache"),
    logs: path.join(ownedStage.root, ".npm-logs"),
    temp: path.join(ownedStage.root, ".npm-tmp"),
    home: path.join(ownedStage.root, ".home"),
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
    npm_config_userconfig: path.join(ownedStage.root, ".npmrc"),
    npm_config_globalconfig: path.join(ownedStage.root, ".npm-globalrc"),
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
  const { env, cwd, timeoutMs, maxOutputBytes = 0, captureStdout = false } = options;
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
      }
      resolve({
        status: closeResult?.code ?? null,
        signal: closeResult?.signal ?? null,
        error: spawnError,
        cleanupConfirmed,
        timedOut,
        outputExceeded,
        stdout: stdout.toString("utf8"),
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
        stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
      });
    } catch (error) {
      resolve({ status: null, signal: null, error, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "" });
      return;
    }

    activeBoundedProcessCount += 1;
    if (captureStdout) {
      child.stdout.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stdout.length + bytes.length > maxOutputBytes) {
          outputExceeded = true;
          if (killTimer === undefined) terminate();
          return;
        }
        stdout = Buffer.concat([stdout, bytes]);
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

function runNpm(npmCli, args, options = {}) {
  return runBoundedProcess(process.execPath, [npmCli, ...args], options);
}

async function buildSourceExtension(options) {
  const { packageRoot, agentDir, env } = options;
  const executeNpm = options.runNpm || runNpm;
  const sourceBuildTimeoutMs = Number.isFinite(options.sourceBuildTimeoutMs)
    ? options.sourceBuildTimeoutMs
    : SOURCE_BUILD_TIMEOUT_MS;
  let ownedStage;
  try {
    ownedStage = stageSourcePackage(packageRoot, path.join(agentDir, RUNTIME_CACHE_DIRNAME, "build"));
  } catch (error) {
    return { status: 1, error: new Error("could not stage the source package for building"), retainedStage: Boolean(error && error.retainedStage) };
  }
  const stagingRoot = ownedStage.root;
  try {
    const buildEnv = stageNpmEnvironment(env, ownedStage);
    const npmCli = findNpmCli(env);
    if (!npmCli) throw new Error("npm is unavailable");
    const install = await executeNpm(npmCli, ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"], {
      cwd: stagingRoot,
      env: buildEnv,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
    });
    if (install.error || install.status !== 0 || install.signal || install.timedOut || install.outputExceeded || install.cleanupConfirmed === false) {
      const removed = install.cleanupConfirmed !== false && removeOwnedStage(ownedStage);
      return {
        status: statusCode(install),
        childStatus: install.status,
        signal: install.signal,
        cleanupConfirmed: install.cleanupConfirmed,
        timedOut: install.timedOut,
        outputExceeded: install.outputExceeded,
        error: install.error,
        retainedStage: !removed,
      };
    }
    if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
    if (pathExists(path.join(stagingRoot, "dist"))) throw new Error("staging root unexpectedly contains build output");
    const build = await executeNpm(npmCli, ["--prefix", stagingRoot, "run", "build"], {
      cwd: stagingRoot,
      env: { ...buildEnv, PATH: `${path.join(stagingRoot, "node_modules", ".bin")}${path.delimiter}${env.PATH ?? ""}` },
      timeoutMs: sourceBuildTimeoutMs,
    });
    if (build.error || build.status !== 0 || build.signal || build.timedOut || build.outputExceeded || build.cleanupConfirmed === false) {
      const removed = build.cleanupConfirmed !== false && removeOwnedStage(ownedStage);
      return {
        status: statusCode(build),
        childStatus: build.status,
        signal: build.signal,
        cleanupConfirmed: build.cleanupConfirmed,
        timedOut: build.timedOut,
        outputExceeded: build.outputExceeded,
        error: build.error,
        retainedStage: !removed,
      };
    }
    if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
    return { status: 0, stagingRoot, ownedStage };
  } catch (error) {
    const cleanupUnconfirmed = Boolean(error && error.cleanupUnconfirmed);
    const removed = !cleanupUnconfirmed && removeOwnedStage(ownedStage);
    return { status: 1, error, cleanupConfirmed: cleanupUnconfirmed ? false : undefined, retainedStage: !removed };
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
async function validateCachedPiRuntime(versionRoot, targetPkgDir, env, expectedIdentity, expectedParentChain, processRunner = runBoundedProcess) {
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
    validated = await validatePiPackage(targetPkgDir, env, { exactVersion: PI_PROVISION_VERSION, processRunner });
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
  const validatePackage = options.validatePiPackage || ((pkgDir, validationEnv, validationOptions = {}) => validatePiPackage(
    pkgDir,
    validationEnv,
    { ...validationOptions, processRunner },
  ));
  const runtimeRoot = path.join(agentDir, RUNTIME_CACHE_DIRNAME, PI_RUNTIME_DIRNAME);
  const versionRoot = path.join(runtimeRoot, `pi-${PI_PROVISION_VERSION}`);
  const targetNodeModules = path.join(versionRoot, "node_modules");
  const targetPkgDir = path.join(targetNodeModules, "@earendil-works", "pi-coding-agent");

  let runtimeChain;
  try {
    runtimeChain = ensureDirectoryTree(runtimeRoot);
  } catch {
    throw new PiRuntimeError(`could not access the isolated pi runtime cache under ${runtimeRoot}`);
  }
  if (pathExists(versionRoot)) {
    return validateCachedPiRuntime(versionRoot, targetPkgDir, env, undefined, runtimeChain, processRunner);
  }
  if (!npmCli) throw new PiRuntimeError("the public npm Node CLI is not available on PATH; cannot provision Pi");

  // No stale stage is inspected or removed. The captured directory identity
  // identifies only the root, not descendants produced by npm.
  let ownedStage;
  let preserveStage = false;
  try {
    ownedStage = createOwnedStage(runtimeRoot, `.staging-pi-${PI_PROVISION_VERSION}-`);
    if (!directoryChainIsSame(runtimeChain) || !directoryChainIsSame(ownedStage.parentChain)) {
      const error = new PiRuntimeError(`the pi runtime cache parent changed during staging under ${runtimeRoot}`);
      error.cleanupUnconfirmed = true;
      throw error;
    }
  } catch (error) {
    if (error && error.cleanupUnconfirmed) throw error;
    if (error && error.retainedStage) {
      const retained = new PiRuntimeError("the Pi runtime staging directory identity could not be confirmed; preserving the stage");
      retained.cleanupUnconfirmed = true;
      throw retained;
    }
    throw new PiRuntimeError(`could not create the pi runtime staging directory under ${runtimeRoot} (permission denied?)`);
  }
  try {
    const stagingRoot = ownedStage.root;
    const installEnv = stageNpmEnvironment(env, ownedStage);
    const install = await executeNpm(npmCli, [
      "install",
      "--prefix", stagingRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry", "https://registry.npmjs.org",
      `${PI_PACKAGE_NAME}@${PI_PROVISION_VERSION}`,
    ], {
      env: installEnv,
      cwd: stagingRoot,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
    });
    preserveStage = install.cleanupConfirmed === false;
    if (install.error || install.status !== 0 || install.signal || install.timedOut || install.outputExceeded || preserveStage) {
      let result = "could not start";
      if (preserveStage) result = "cleanup was not confirmed";
      else if (install.timedOut) result = "timed out";
      else if (install.signal) result = `was terminated by ${install.signal}`;
      else if (Number.isInteger(install.status)) result = `exited with status ${install.status}`;
      throw new PiRuntimeError(`pi runtime provisioning failed (npm install ${result}); re-run the launcher`);
    }
    if (!directoryChainIsSame(ownedStage.chain)) throw new PiRuntimeError("the pi runtime staging directory chain changed during installation");
    const stagedPkgDir = path.join(stagingRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const stagedPackageChain = assertDirectoryChain(stagingRoot, stagedPkgDir);
    const stagedNodeModulesPath = path.join(stagingRoot, "node_modules");
    const stagedNodeModulesEntry = stagedPackageChain.find(({ target }) => target === stagedNodeModulesPath);
    if (!stagedNodeModulesEntry) throw new PiRuntimeError("the staged pi package has no positively identified node_modules root");
    await validatePackage(stagedPkgDir, env, { exactVersion: PI_PROVISION_VERSION });
    if (!directoryChainIsSame(ownedStage.chain) || !directoryChainIsSame(stagedPackageChain)) {
      throw new PiRuntimeError("the pi runtime staging identity changed during validation");
    }

    if (pathExists(versionRoot)) {
      // Another process may have completed publication while npm ran. Reuse
      // only a fully validated result; partial/unknown resources are preserved.
      return validateCachedPiRuntime(versionRoot, targetPkgDir, env, undefined, runtimeChain, processRunner);
    }

    let ownedVersionRoot;
    try {
      // mkdir is exclusive: unlike rename-over-empty-dir, it cannot replace a
      // preexisting empty or partially populated version destination.
      if (!directoryChainIsSame(runtimeChain)) throw new Error("runtime cache parent changed");
      if (typeof beforeVersionRootMkdir === "function") beforeVersionRootMkdir(versionRoot);
      fs.mkdirSync(versionRoot, { mode: 0o700 });
      const versionIdentity = identityOfDirectory(versionRoot);
      const publicationChain = [...runtimeChain, { target: versionRoot, identity: versionIdentity }];
      ownedVersionRoot = { root: versionRoot, identity: versionIdentity, chain: publicationChain };
      if (!directoryChainIsSame(publicationChain) || pathExists(targetNodeModules)) {
        throw new Error("publication target is not fresh");
      }
      if (!directoryChainIsSame(ownedStage.chain) || !directoryChainIsSame(stagedPackageChain)) {
        throw new Error("staging identity changed");
      }
      fs.renameSync(stagedNodeModulesPath, targetNodeModules);
      if (!directoryChainIsSame(publicationChain)
        || !sameDirectoryIdentity(targetNodeModules, stagedNodeModulesEntry.identity)) {
        throw new Error("published node_modules identity changed");
      }
    } catch {
      if (ownedVersionRoot) {
        if (!pathExists(targetNodeModules)) removeOwnedStage(ownedVersionRoot);
        throw new PiRuntimeError(`the owned pi runtime publication changed under ${versionRoot}; preserving unknown resources`);
      }
      if (pathExists(versionRoot)) return await validateCachedPiRuntime(versionRoot, targetPkgDir, env, undefined, runtimeChain, processRunner);
      throw new PiRuntimeError(`pi runtime provisioning failed while publishing under ${runtimeRoot}`);
    }

    // Validate the published location against the exclusive version root.
    if (!ownedVersionRoot) throw new PiRuntimeError(`the cached pi runtime at ${versionRoot} changed during publication; preserving it`);
    const published = await validateCachedPiRuntime(versionRoot, targetPkgDir, env, ownedVersionRoot.identity, runtimeChain, processRunner);
    writeError(`pi-review-sessions: installed isolated Pi ${PI_PROVISION_VERSION} runtime at ${runtimeRoot}\n`);
    return { ...published, source: "isolated-cache" };
  } catch (error) {
    if (error && error.cleanupUnconfirmed) preserveStage = true;
    throw error;
  } finally {
    if (preserveStage || !removeOwnedStage(ownedStage)) writeError("pi-review-sessions: preserving a Pi runtime staging tree because per-entry descendant creation receipts are unavailable.\n");
  }
}

/**
 * Resolve the public supported Pi CLI entry (issue 323). Order: explicit
 * --pi-executable (validated, no fallback), npm global package root, PATH
 * `pi` inside the public package, isolated cache provisioning. Returns
 * { file, version, source }; throws PiRuntimeError with a bounded message.
 */
async function resolvePiRuntime(options) {
  const { explicit, env, agentDir, cwd, writeError } = options;

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
    const head = readHeadBytes(canonical, NODE_ENTRY_HEAD_BYTES);
    if (!head || head.length < 2 || !isNodeEntryShebang(head)) {
      throw new PiRuntimeError(`the configured pi executable is not a positive Node entry (expected the standard npm-installed pi CLI entry file): ${canonical}`);
    }
    const version = await probePiVersion(canonical, env);
    return { file: canonical, version, source: "explicit" };
  }

  const npmCli = findNpmCli(env);
  const globalRoot = npmCli ? await npmGlobalRoot(env, npmCli) : undefined;
  if (globalRoot) {
    const pkgDir = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (pathExists(pkgDir)) {
      try {
        return { ...await validatePiPackage(pkgDir, env), source: "npm-global" };
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
        return { ...await validatePiPackage(pkgDir, env, { expectedFile: onPath }), source: "path" };
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
  let ownedSourceStage;
  let sourceStageHostStarted = false;
  let sourceStageSetupUnconfirmed = false;
  const finish = (status) => {
    if (ownedSourceStage) {
      if (sourceStageSetupUnconfirmed) {
        deps.writeError("pi-review-sessions: preserving the source stage because setup cleanup was not confirmed and per-entry descendant creation receipts are unavailable.\n");
      } else if (sourceStageHostStarted && status !== 0) {
        deps.writeError("pi-review-sessions: preserving the source stage because native shutdown was not confirmed and per-entry descendant creation receipts are unavailable.\n");
      } else {
        const removed = removeOwnedStage(ownedSourceStage);
        if (!removed) deps.writeError("pi-review-sessions: preserving the source stage because per-entry descendant creation receipts are unavailable.\n");
      }
      ownedSourceStage = undefined;
    }
    return status;
  };
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
      build = await deps.build({ packageRoot, agentDir, env: setupEnv });
    } catch {
      deps.writeError("pi-review-sessions: extension build failed.\n");
      return 1;
    }
    if (!build || build.status !== 0 || build.error || build.signal || build.timedOut || build.outputExceeded || build.cleanupConfirmed === false) {
      const detail = build && build.timedOut
        ? " (setup deadline exceeded)"
        : build && typeof build.signal === "string"
          ? ` (terminated by ${build.signal})`
          : build && Number.isInteger(build.status)
            ? ` (exit status ${build.status})`
            : "";
      deps.writeError(`pi-review-sessions: extension build failed${detail}.\n`);
      if (build && build.retainedStage) deps.writeError("pi-review-sessions: a source stage was retained because per-entry descendant creation receipts are unavailable.\n");
      return statusCode(build);
    }
    if (typeof build.stagingRoot === "string" && build.stagingRoot.length > 0) {
      hostPackageRoot = build.stagingRoot;
      compiledEntry = path.join(build.stagingRoot, "dist", "src", "session-host", "main.js");
      if (build.ownedStage && build.ownedStage.root === build.stagingRoot) ownedSourceStage = build.ownedStage;
    }
  }

  if (!deps.isRegularFile(compiledEntry)) {
    deps.writeError("pi-review-sessions: compiled native session host is unavailable.\n");
    return finish(2);
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
    sourceStageSetupUnconfirmed = Boolean(error && error.cleanupUnconfirmed);
    const message = error instanceof PiRuntimeError ? error.message : "Pi runtime selection failed.";
    deps.writeError(`pi-review-sessions: ${message}\n`);
    return finish(1);
  }
  if (!piRuntime || typeof piRuntime.file !== "string" || piRuntime.file.length > MAX_PATH_LENGTH || !path.isAbsolute(piRuntime.file) || typeof piRuntime.version !== "string" || piRuntime.version.length > 64) {
    deps.writeError("pi-review-sessions: Pi runtime selection failed.\n");
    return finish(1);
  }
  deps.writeError(`pi-review-sessions: pi runtime: ${piRuntime.file} (v${piRuntime.version}, ${piRuntime.source})\n`);

  // The shared DDGS helper runs in a bounded owned Node process (a POSIX
  // group, but only the direct Windows child). setupEnv is already scrubbed.
  const savedTokens = {};
  for (const name of HOST_ENV_TO_CLEAR) {
    if (name in process.env) {
      savedTokens[name] = process.env[name];
      delete process.env[name];
    }
  }
  let ddgs;
  try {
    ddgs = await deps.ensureDdgs(homeDir, setupEnv, hostPackageRoot);
  } catch (error) {
    sourceStageSetupUnconfirmed = Boolean(error && error.cleanupUnconfirmed);
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return finish(1);
  } finally {
    for (const [name, value] of Object.entries(savedTokens)) process.env[name] = value;
  }
  sourceStageSetupUnconfirmed = Boolean(ddgs && ddgs.cleanupUnconfirmed);
  if (!ddgs || ddgs.cleanupUnconfirmed || ddgs.ok !== true || typeof ddgs.python !== "string") {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return finish(ddgs && Number.isInteger(ddgs.exitCode) ? ddgs.exitCode : 1);
  }
  const python = ddgs.python;
  if (python.length > MAX_PATH_LENGTH || !path.isAbsolute(python) || /[\u0000-\u001f\u007f]/u.test(python)) {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return finish(1);
  }

  const hostEnv = { ...setupEnv, PI_REVIEW_GATE_DDGS_PYTHON: python };
  let hostModule;
  try {
    hostModule = deps.loadMain(compiledEntry);
  } catch {
    deps.writeError("pi-review-sessions: native session host startup failed.\n");
    return finish(1);
  }
  if (!hostModule || typeof hostModule.runSessionHost !== "function") {
    deps.writeError("pi-review-sessions: native session host startup failed.\n");
    return finish(1);
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
    sourceStageHostStarted = true;
    const status = await hostModule.runSessionHost(hostOptions);
    if (Number.isInteger(status)) return finish(status);
  } catch {
    // Do not expose arbitrary errors, argv, or native credentials in startup output.
  }
  deps.writeError("pi-review-sessions: native session host startup failed.\n");
  return finish(1);
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
    resolvePiRuntime,
    buildSourceExtension,
    provisionPiRuntime,
    validatePiPackage,
    probePiVersion,
    runDdgsSetup,
    stageSourcePackage,
    createOwnedStage,
    removeOwnedStage,
    findNpmCli,
    findPiOnPath,
    runBoundedProcess,
    boundedProcessCleanupStatus,
    activeBoundedProcessCount: () => activeBoundedProcessCount,
  },
};
