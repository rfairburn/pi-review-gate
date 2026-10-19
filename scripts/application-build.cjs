"use strict";

/*
 * Shared source-preparation engine for every pi-review-gate launcher entry
 * point (issue 344).
 *
 * This module owns exactly one thing: turning a source checkout into a complete,
 * private, compiled application generation. It is NOT a freshness authority —
 * scripts/prepare-application.cjs decides whether preparation is needed at all,
 * and calls this engine only on a genuine miss. Nothing here runs on a current
 * startup.
 *
 * Behavioral contract:
 * - Preparation is isolated: only the explicit application inputs
 *   (package.json, package-lock.json, tsconfig.json, src/, scripts/, skills/)
 *   are copied into a fresh private generation under the managed build cache.
 *   The live checkout's dist/ and node_modules/ are never read through, copied,
 *   written, or removed, so a running extension that uses them is unaffected.
 * - Copies are bounded (files, bytes, depth, elapsed time), reject symlinks and
 *   special files, and prune initialized `.terraform` trees before descent.
 * - Installation runs the locked dependency graph (`npm ci --include=dev
 *   --ignore-scripts`) with the staged install's own private npm cache, logs,
 *   temp, and home directories. The compiler is the staged install's own
 *   TypeScript CLI invoked through this Node — never a PATH lookup, a `.bin`
 *   shim, `npm run build`, or a shell.
 * - Setup children run in an owned process group with an elapsed deadline, an
 *   output ceiling, and settlement evidence; an unproven cleanup fails closed.
 * - The returned generation is complete only when its directory chain is still
 *   the same one this engine created and the required compiled entries exist.
 *   Publishing it as current state is the caller's (preparation authority's)
 *   decision.
 *
 * The retired pre-#344 machinery — whole-artifact parallel re-hashing, npm
 * implementation and toolchain content fingerprints, and per-startup cache
 * record scans — is deliberately gone. A current startup performs none of that.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const generations = require("./managed-generations.cjs");

const MAX_SOURCE_DEPTH = 64;
const MAX_SOURCE_FILES = 100_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const SOURCE_COPY_CHUNK_BYTES = 64 * 1024;
const SOURCE_BUILD_TIMEOUT_MS = 600_000;
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const SOURCE_BUILD_CAPTURE_MAX_BYTES = 256 * 1024;
const BUILD_DIAGNOSTIC_TEXT_MAX_BYTES = 4 * 1024;
const PROCESS_KILL_GRACE_MS = 500;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NODE_ENTRY_HEAD_BYTES = 512;
const BUILD_STAGE_LABELS = {
  stage: "source stage preparation",
  install: "npm ci (dependency install)",
  compile: "TypeScript compile (tsc -p tsconfig.json)",
};

/** Application inputs staged for a source build, relative to the package root. */
const SOURCE_INPUT_FILES = ["package.json", "package-lock.json", "tsconfig.json"];
const SOURCE_INPUT_TREES = ["src", "scripts", "skills"];

/** Compiled entries that must exist before a generation may be published. */
const REQUIRED_COMPILED_ENTRIES = [
  ["dist", "src", "index.js"],
  ["dist", "src", "session-host", "main.js"],
  ["dist", "src", "web", "cli.js"],
];

let activeBoundedProcessCount = 0;

function statusCode(result, fallback = 1) {
  if (result && result.timedOut) return 124;
  if (result && (result.error || result.outputExceeded || result.cleanupConfirmed === false)) return fallback;
  if (result && typeof result.signal === "string") {
    const signalNumber = require("node:os").constants.signals[result.signal];
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

/**
 * Create missing parent components one at a time; never follow a directory
 * symlink. With an explicit `boundary`, only components at or below it are
 * created and fenced: the user's own ancestors above this application's state
 * directory (for example macOS's /var symlink) are legitimate and are not this
 * module's to police.
 */
function ensureDirectoryTree(target, boundary) {
  const absolute = path.resolve(target);
  const resolvedBoundary = boundary === undefined ? undefined : path.resolve(boundary);
  if (resolvedBoundary !== undefined) {
    const relative = path.relative(resolvedBoundary, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("directory escapes its boundary");
  }
  let start = parsedStart(absolute, resolvedBoundary);
  if (resolvedBoundary !== undefined) {
    try {
      identityOfDirectory(start);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // The boundary (this application's Pi agent directory) may not exist yet
      // on a first launch; create it privately, then fence it like any other
      // managed component.
      fs.mkdirSync(start, { recursive: true, mode: 0o700 });
      identityOfDirectory(start);
    }
  }
  const chain = [{ target: start, identity: identityOfDirectory(start) }];
  for (const component of path.relative(start, absolute).split(path.sep).filter(Boolean)) {
    const current = path.join(start, component);
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
    start = current;
  }
  return chain;
}

/** The directory a bounded creation chain starts from: the boundary, or the filesystem root. */
function parsedStart(absolute, boundary) {
  return boundary === undefined ? path.parse(absolute).root : boundary;
}

/**
 * Exclusively create a fresh private directory and retain its filesystem
 * identity. A random name is only collision resistance; it never proves
 * ownership. Existing paths are not adopted, removed, or traversed.
 */
function createOwnedStage(parent, prefix, randomBytes = crypto.randomBytes, preparedParentChain) {
  const absoluteParent = path.resolve(parent);
  const parentChain = preparedParentChain || ensureDirectoryTree(absoluteParent);
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

function sameFileSnapshot(left, right) {
  return sameStatIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
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

/**
 * Stage only explicit build/runtime inputs into a fresh private root. Copies
 * are bounded and reject symlinks/special files; package-lock.json is copied
 * byte-for-byte, source .terraform directories are pruned before descent, and
 * the live checkout's node_modules/dist are never followed or copied.
 */
function stageSourcePackage(packageRoot, buildCacheRoot, testHooks, warn = () => undefined, boundary) {
  const parentChain = ensureDirectoryTree(buildCacheRoot, boundary);
  const ownedStage = generations.admit(buildCacheRoot,
    () => createOwnedStage(buildCacheRoot, "pi-review-gate-app-", crypto.randomBytes, parentChain),
    {
      warn,
      // Application preparation does not reclaim anything at admission: the
      // coordinated, lease-aware cleanup runs once after the completed
      // generation is published and leased. Reclaiming here would delete
      // generations whose live consumers are only visible under that separate
      // coordination boundary.
      reclaim: false,
    });
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
    for (const name of SOURCE_INPUT_FILES) {
      const source = path.join(resolvedPackageRoot, name);
      copySourceFile(source, path.join(ownedStage.root, name), budget);
    }
    for (const name of SOURCE_INPUT_TREES) {
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

/** Private npm/home/temp environment so installation never touches the user's. */
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

/**
 * A natural direct exit is a close with an integer exit status, no signal, and
 * no spawn error. The status may be zero or nonzero: a setup child's own
 * failure is still a natural exit, and must not be confused with a cleanup or
 * spawn failure that only has the generic fallback status.
 */
function naturalDirectExit(closeResult, spawnError) {
  return !spawnError && closeResult?.signal === null && Number.isInteger(closeResult?.code);
}

function boundedProcessCleanupStatus({ closed, pid, platform, timedOut, outputExceeded, naturalExit, groupStillExists }) {
  if (!closed) return false;
  if (pid === undefined) return true;
  if (platform === "win32") {
    // Public Node owns only the direct ChildProcess on Windows. A natural
    // direct close — any integer exit status, success or failure — needs no
    // escalation and makes no descendant claim, so it is never evidence of
    // settlement. After a forced timeout/output termination, a signal, a
    // spawn error, or an unknown close there is no public process-tree proof.
    return timedOut || outputExceeded || !naturalExit ? false : undefined;
  }
  return !groupStillExists();
}

/**
 * Run one setup child in an owned process group with a deadline, an output
 * ceiling, and settlement evidence. A child whose termination cannot be
 * confirmed is never reported as a clean success.
 */
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
      // A natural direct exit is distinct from success: a setup child's
      // legitimate nonzero status must reach preparation instead of collapsing
      // to the generic unconfirmed-cleanup failure status.
      const naturalExit = naturalDirectExit(closeResult, spawnError);
      const cleanupConfirmed = boundedProcessCleanupStatus({
        closed,
        pid: child.pid,
        platform: process.platform,
        timedOut,
        outputExceeded,
        naturalExit,
        groupStillExists,
      });
      const naturallySettledWindowsChild = process.platform === "win32"
        && closed && !timedOut && !outputExceeded && naturalExit;
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

/** Run one admitted Node JS entry through this trusted public Node, never a shell or a `.bin` shim. */
function runNodeJs(entry, args, options = {}) {
  return runBoundedProcess(process.execPath, [entry, ...args], options);
}

function runNpm(npmCli, args, options = {}) {
  return runNodeJs(npmCli, args, options);
}

/**
 * Neutralize terminal control sequences and non-printing bytes in captured
 * child output so a failing child cannot rewrite or hijack the operator's
 * terminal, then keep only the printable text it actually printed.
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

/** Bound text to a UTF-8 byte ceiling, appending an explicit truncation marker when clipped. */
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

/** Bounded, sanitized, provenance-labelled diagnostics for one failed preparation stage. */
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
    blocks.push(`pi-review-gate: ${label} ${stream}:\n${text}${text.endsWith("\n") ? "" : "\n"}`);
  }
  return blocks.join("");
}

/** Bounded, sanitized diagnostic for a failure raised by the preparation engine itself. */
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
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) return null;
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isNodeEntryShebang(head) {
  if (!head || head.length < 2) return false;
  const text = head.toString("utf8");
  if (text.startsWith("#!")) {
    const line = text.split(/\r?\n/u, 1)[0];
    return /\bnode(?:\.exe)?\b/u.test(line);
  }
  // A compiled JS module without a shebang is still a Node entry when it starts
  // with the CommonJS wrapper's strict-mode/comment or `"use strict"` preamble.
  return text.startsWith("\"use strict\"") || text.startsWith("'use strict'") || /^\s*(?:\/\/|\/\*)/u.test(text);
}

/** Bounded read of one regular non-symlink file. */
function readBoundedRegularFile(file, maxBytes) {
  const stats = lstatRegularFile(file);
  if (stats.size > BigInt(maxBytes)) throw new Error("file exceeds the bounded read size");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(stats, opened)) throw new Error("file changed during the bounded read");
    const buffer = Buffer.alloc(Number(stats.size));
    let position = 0;
    while (position < buffer.length) {
      const read = fs.readSync(fd, buffer, position, buffer.length - position, position);
      if (read === 0) break;
      position += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(after, opened) || position !== buffer.length) throw new Error("file changed during the bounded read");
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function parseStableVersion(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

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

/**
 * Resolve PATH's ordinary npm command to its public JS bin; never execute a
 * shim, and never parse a batch file. On Windows the standard distribution's
 * npm package sits beside npm.cmd, so its validated JS entry is used directly.
 */
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
        const siblingCli = path.join(rawEntry, "node_modules", "npm", "bin", "npm-cli.js");
        const sibling = validateNpmCli(siblingCli);
        if (sibling) return sibling;
      }
    }
  }
  return undefined;
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
  return { file: candidate, tsconfig: path.join(stagingRoot, "tsconfig.json"), chain, identity };
}

/**
 * Prepare one complete compiled application generation from a source checkout.
 *
 * Returns `{ ok: true, root, ... }` only for a generation whose install,
 * compile, and required entries all succeeded while its own directory chain
 * stayed identical. Any failure returns `{ ok: false, status, stage, ... }`
 * with bounded diagnostics; nothing live is deleted, and an incomplete
 * generation stays disposable for a later cleanup pass.
 */
async function prepareStagedApplication(options) {
  const { packageRoot, agentDir, env } = options;
  const executeNpm = options.runNpm || runNpm;
  const executeCompile = options.runCompile || runNodeJs;
  const sourceBuildTimeoutMs = Number.isFinite(options.sourceBuildTimeoutMs)
    ? options.sourceBuildTimeoutMs
    : SOURCE_BUILD_TIMEOUT_MS;
  const buildCacheRoot = path.join(agentDir, ".pi-review-gate", "build");
  const warn = (message) => {
    if (typeof options.writeError === "function") options.writeError(`pi-review-gate: ${message}.\n`);
  };
  let npmCli;
  try {
    npmCli = findNpmCli(env);
  } catch {
    npmCli = undefined;
  }
  if (!npmCli) {
    return {
      ok: false,
      status: 127,
      stage: "install",
      diagnostics: formatStageErrorDiagnostics(new Error("npm is unavailable; install Node.js with npm and re-run")),
      retainedStage: false,
    };
  }
  let ownedStage;
  try {
    ownedStage = stageSourcePackage(packageRoot, buildCacheRoot, options.testHooks, warn, agentDir);
  } catch (error) {
    return {
      ok: false,
      status: 1,
      stage: "stage",
      error,
      diagnostics: formatStageErrorDiagnostics(error),
      retainedStage: Boolean(error && error.retainedStage),
    };
  }
  const stagingRoot = ownedStage.root;
  const fail = (result) => {
    try { ownedStage.generation.release(); } catch { /* already settled */ }
    return result;
  };
  try {
    if (typeof options.testHooks?.afterSourceStageCreated === "function") {
      options.testHooks.afterSourceStageCreated(stagingRoot);
    }
    // Setup residue lives inside the SAME counted generation.
    const buildEnv = stageNpmEnvironment(env, ownedStage);
    const install = await executeNpm(npmCli, ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"], {
      cwd: stagingRoot,
      env: buildEnv,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      captureStdout: true,
      captureStderr: true,
      maxOutputBytes: SOURCE_BUILD_CAPTURE_MAX_BYTES,
    });
    if (install.error || install.status !== 0 || install.signal || install.timedOut || install.outputExceeded || install.cleanupConfirmed === false) {
      return fail({
        ok: false,
        status: statusCode(install),
        stage: "install",
        childStatus: install.status,
        signal: install.signal,
        cleanupConfirmed: install.cleanupConfirmed,
        timedOut: install.timedOut,
        outputExceeded: install.outputExceeded,
        error: install.error,
        diagnostics: formatBuildStageDiagnostics(install, "install"),
        retainedStage: true,
      });
    }
    if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed");
    if (pathExists(path.join(stagingRoot, "dist"))) throw new Error("staging root unexpectedly contains build output");
    // Compile with the staged locked install's own TypeScript CLI through
    // public Node directly: `-p <stage>/tsconfig.json`, no `npm run build`, no
    // `clean:build` recursive removal, no node_modules/.bin PATH entry, and no
    // shell. The public package build scripts stay unchanged and the live
    // checkout (or any existing output) is never touched. The compiler entry
    // and its real ancestor chain are identity-checked first; the checks are
    // not atomic openat containment and make no such claim.
    const compiler = resolveStageTypeScriptCli(stagingRoot);
    if (!directoryChainIsSame(ownedStage.chain) || !directoryChainIsSame(compiler.chain)
      || !sameFileIdentity(compiler.file, compiler.identity)) {
      throw new Error("staging directory chain changed before the TypeScript compile");
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
      return fail({
        ok: false,
        status: statusCode(compile),
        stage: "compile",
        childStatus: compile.status,
        signal: compile.signal,
        cleanupConfirmed: compile.cleanupConfirmed,
        timedOut: compile.timedOut,
        outputExceeded: compile.outputExceeded,
        error: compile.error,
        diagnostics: formatBuildStageDiagnostics(compile, "compile"),
        retainedStage: true,
      });
    }
    if (!directoryChainIsSame(ownedStage.chain) || !directoryChainIsSame(compiler.chain)
      || !sameFileIdentity(compiler.file, compiler.identity)) {
      throw new Error("staging directory chain changed during the TypeScript compile");
    }
    for (const entry of REQUIRED_COMPILED_ENTRIES) {
      const compiled = path.join(stagingRoot, ...entry);
      let stats;
      try {
        stats = lstatRegularFile(compiled);
      } catch {
        throw new Error(`the staged compile did not produce ${entry.join("/")}`);
      }
      if (stats.size === 0n) throw new Error(`the staged compile produced an empty ${entry.join("/")}`);
    }
    if (!directoryChainIsSame(ownedStage.chain)) throw new Error("staging directory chain changed after the TypeScript compile");
    // The preparation authority releases this producer marker only after it has
    // published the completed generation; until then a concurrent cleanup sees
    // an in-flight generation and leaves it alone.
    return {
      ok: true,
      status: 0,
      root: stagingRoot,
      identity: ownedStage.identity,
      parentChain: ownedStage.parentChain,
      cacheRoot: buildCacheRoot,
      generation: ownedStage.generation,
      ...(options.testHooks ? { testHooks: options.testHooks } : {}),
    };
  } catch (error) {
    return fail({
      ok: false,
      status: 1,
      stage: "compile",
      error,
      diagnostics: formatStageErrorDiagnostics(error),
      retainedStage: true,
    });
  }
}

module.exports = {
  SOURCE_INPUT_FILES,
  SOURCE_INPUT_TREES,
  REQUIRED_COMPILED_ENTRIES,
  MAX_SOURCE_FILES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_DEPTH,
  SOURCE_BUILD_TIMEOUT_MS,
  assertDirectoryChain,
  boundDiagnosticText,
  boundedProcessCleanupStatus,
  copySourceDirectory,
  copySourceFile,
  createOwnedStage,
  directoryChainIsSame,
  ensureDirectoryTree,
  findNpmCli,
  formatBuildStageDiagnostics,
  formatStageErrorDiagnostics,
  identityOfDirectory,
  lstatRegularFile,
  naturalDirectExit,
  pathExists,
  pathIsWithin,
  prepareStagedApplication,
  readBoundedRegularFile,
  resolveStageTypeScriptCli,
  runBoundedProcess,
  runNodeJs,
  runNpm,
  sameDirectoryIdentity,
  sameFileIdentity,
  sanitizeDiagnosticText,
  sourceCopyBudget,
  stageNpmEnvironment,
  stageSourcePackage,
  statusCode,
  activeBoundedProcessCount: () => activeBoundedProcessCount,
};
