"use strict";

/*
 * The single shared current/freshness authority for every pi-review-gate
 * launcher entry point (issue 344): Pi (scripts/pi-review-gate.sh,
 * scripts/pi-review-gate.cmd, scripts/pi-review-gate-launcher.cjs), the sidebar
 * (scripts/pi-review-sessions.sh/.cmd/.ps1 and scripts/pi-review-sessions.cjs),
 * and the web CLI wrapper (scripts/pi-review-web.sh).
 *
 * Design contract:
 * - ONE decision algorithm. The wrappers contain no independent freshness
 *   logic: they call `prepareApplication()` (in-process, or through the
 *   `--prepare` CLI mode) and use the prepared root it returns.
 * - The current decision is cheap. It reads one small bounded marker file per
 *   component and stats only paths that marker already names. There is no
 *   recursive walk of the package, no dependency/runtime inventory, and no
 *   content re-hash while the recorded metadata still matches.
 * - Development checkouts are identified by a bounded index of the application
 *   inputs — package.json, package-lock.json, tsconfig.json, src/, scripts/,
 *   skills/ — captured DURING preparation. A later start stats exactly those
 *   files and directories: a touched file or a changed directory timestamp is
 *   the only thing that can trigger the small app-input checksum, which then
 *   distinguishes a real edit from a touch-only change. node_modules, dist,
 *   .git, docs, tests, private notes, and caches are never scanned or hashed.
 * - Packaged installs do not need any of that: their full exact package version
 *   (for example 0.1.0-dev.180, a valid SemVer prerelease) identifies the
 *   prebuilt code, so an installed package is current without compiling.
 * - An update is automatic, single-producer, and isolated: it runs in a fresh
 *   inactive generation owned by the managed build cache, publishes the marker
 *   only after install/compile/provisioning succeeded and the source inputs
 *   were still coherent, and never deletes live or unknown data.
 * - Consumers publish a small pid+birth lease before they use a prepared root,
 *   so an update's cleanup preserves code a live Pi/sidebar/web process is
 *   still running. A lease is published under the coordination of the agent
 *   whose managed cache OWNS the root, so a launcher started from another
 *   agent's completed generation is protected too; the caller's own config and
 *   component state stay scoped to the caller. The marker is completed local
 *   freshness state; it is not a cryptographic sandbox against another process
 *   of the same user.
 * - Component readiness (DDGS, shipped skills) is gated the same way: a marker
 *   naming the pinned version and the installed paths makes a current start
 *   skip Python entirely, and validation/provisioning runs only when a
 *   component is genuinely missing or outdated.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const build = require("./application-build.cjs");
const generations = require("./managed-generations.cjs");

const APPLICATION_SCHEMA = 1;
const RUNTIME_DIRNAME = ".pi-review-gate";
const APPLICATION_DIRNAME = "application";
const BUILD_DIRNAME = "build";
const MARKER_NAME = "current.json";
const LOCK_NAME = "prepare.lock";
const CLEANUP_LOCK_NAME = "cleanup.lock";
const CONSUMERS_DIRNAME = "consumers";
const DDGS_MARKER_NAME = "ddgs.json";
const SKILLS_MARKER_NAME = "skills.json";

const MAX_MARKER_BYTES = 64 * 1024;
// The application marker carries the bounded application-input index. It is
// capped well above any real checkout (a large repository's few hundred input
// files is tens of KiB) so a big but valid index is never truncated and can
// never cause a perpetual re-preparation.
const MAX_APPLICATION_MARKER_BYTES = 4 * 1024 * 1024;
const PREPARED_GENERATION_PATTERN = /^pi-review-gate-app-[A-Za-z0-9]+$/u;
// Completion receipt written INSIDE a prepared generation only after its
// compile, input coherence, and containment all succeeded. Naming convention
// plus some emitted JavaScript never proves an installation completed: a
// failed or in-progress compiler can emit every required entry before dying.
const GENERATION_RECEIPT_NAME = ".pi-review-gate-complete.json";
const MAX_INPUT_FILES = 50_000;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PATH_LENGTH = 2048;
const INPUT_SCAN_TIMEOUT_MS = 20_000;
const INPUT_HASH_CHUNK_BYTES = 64 * 1024;
const PREPARE_LOCK_WAIT_MS = 15 * 60 * 1000;
const CLEANUP_LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 100;
/** The cleanup lock's own poll cadence, unchanged. */
const CLEANUP_LOCK_POLL_MS = LOCK_POLL_MS / 2;
/**
 * The abort/escalation/join reserve held back INSIDE the existing cleanup wait
 * for the one owned birth probe: two of the cleanup poll ticks above. The probe
 * can never spend more than the remaining wait minus this reserve, so the wait
 * always keeps enough of its own budget to take the lock or give up cleanly.
 */
const CLEANUP_LOCK_PROBE_RESERVE_MS = CLEANUP_LOCK_POLL_MS * 2;
const DDGS_VERSION = "9.16.1";
const MAX_CONSUMER_LEASES = 256;

function out(text) {
  fs.writeSync(1, text);
}

function note(text) {
  fs.writeSync(2, text);
}

// ---------------------------------------------------------------------------
// Shared launcher path resolution (moved here from the gate helper so the
// marker, CLI, and both Pi wrappers resolve the same Pi agent directory).
// ---------------------------------------------------------------------------

function joinForPlatform(platform, ...segments) {
  return (platform === "win32" ? path.win32 : path.posix).join(...segments);
}

/**
 * Convert Git Bash, MSYS, Cygwin, and WSL drive paths to the form native
 * Windows APIs accept. Parity with Pi's normalizeWindowsShellPath and
 * src/config-path.ts.
 */
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2] ? match[2].replaceAll("/", "\\") : "";
  return `${match[1].toUpperCase()}:\\${suffix}`;
}

/**
 * The native Pi agent directory: PI_CODING_AGENT_DIR with Pi's native
 * semantics when set to a non-empty value, otherwise <homeDir>/.pi/agent.
 * Mirror of piAgentDir() in src/config-path.ts.
 */
function resolvePiAgentDir(env, resolution) {
  const override = env.PI_CODING_AGENT_DIR;
  if (!override) {
    return joinForPlatform(resolution.platform, resolution.homeDir, ".pi", "agent");
  }
  const expanded = resolution.platform === "win32" ? normalizeWindowsShellPath(override) : override;
  if (expanded === "~") return resolution.homeDir;
  if (expanded.startsWith("~/") || (resolution.platform === "win32" && expanded.startsWith("~\\"))) {
    return joinForPlatform(resolution.platform, resolution.homeDir, expanded.slice(2));
  }
  return expanded;
}

/** Default (primary) config path: native Pi agent directory + review-gate.json. */
function piAgentConfigPath(env, resolution) {
  return joinForPlatform(resolution.platform, resolvePiAgentDir(env, resolution), "review-gate.json");
}

/** Sole implicit compatibility fallback: the historical XDG location. */
function compatibilityFallbackConfigPath(resolution) {
  return joinForPlatform(resolution.platform, resolution.homeDir, ".config", "pi-review-gate", "config.json");
}

// ---------------------------------------------------------------------------
// State directories
// ---------------------------------------------------------------------------

function runtimeRoot(agentDir) {
  return path.join(path.resolve(agentDir), RUNTIME_DIRNAME);
}

function applicationStateRoot(agentDir) {
  return path.join(runtimeRoot(agentDir), APPLICATION_DIRNAME);
}

function buildCacheRoot(agentDir) {
  return path.join(runtimeRoot(agentDir), BUILD_DIRNAME);
}

function consumersRoot(stateRoot) {
  return path.join(stateRoot, CONSUMERS_DIRNAME);
}

/**
 * Create one of this application's own state directories. Every component from
 * the boundary down to the target must be a real (non-symlink) directory; the
 * user's ancestors above the boundary (for example macOS's /var symlink) are not
 * this module's to police. Creation is private from the instant it happens.
 */
/** Create (if needed) and validate this agent's application state directory. */
function ensureApplicationStateDirectory(agentDir) {
  try {
    return ensureStateDirectory(applicationStateRoot(agentDir), path.resolve(agentDir));
  } catch {
    return undefined;
  }
}

function ensureStateDirectory(target, boundary) {
  const resolvedTarget = path.resolve(target);
  const resolvedBoundary = boundary === undefined ? undefined : path.resolve(boundary);
  if (resolvedBoundary !== undefined) {
    const relative = path.relative(resolvedBoundary, resolvedTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("state directory escapes its boundary");
  }
  fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
  let probe = resolvedTarget;
  for (;;) {
    const stats = fs.lstatSync(probe, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("state directory component is unsafe");
    if (resolvedBoundary === undefined || probe === resolvedBoundary) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return resolvedTarget;
}

function removeQuietly(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // Already gone, or not ours to remove.
  }
}

// ---------------------------------------------------------------------------
// Bounded reads and atomic marker publication
// ---------------------------------------------------------------------------

/** Read one small regular non-symlink file, or return null. */
function readSmallFile(file, maxBytes) {
  let stats;
  try {
    stats = fs.lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  if (stats.size > BigInt(maxBytes)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino
      || opened.size !== stats.size || opened.mtimeNs !== stats.mtimeNs) return null;
    const buffer = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < buffer.length) {
      const read = fs.readSync(fd, buffer, position, buffer.length - position, position);
      if (read === 0) break;
      position += read;
    }
    return position === buffer.length ? buffer : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read and parse one bounded marker; malformed, incomplete, or oversized markers are misses. */
function readMarker(stateRoot, name, validate, maxBytes = MAX_MARKER_BYTES) {
  const raw = readSmallFile(path.join(stateRoot, name), maxBytes);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  try {
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Publish one marker atomically: complete bytes in a private temp file, then rename. */
function writeMarker(stateRoot, name, value, maxBytes = MAX_MARKER_BYTES) {
  const directory = path.dirname(path.join(stateRoot, name));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error("marker exceeds its bounded size");
  const temporary = path.join(directory, `.${name}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, path.join(directory, name));
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    removeQuietly(temporary);
    throw error;
  }
}

/**
 * Observe one small file together with the identity captured while reading it.
 * A stale-record reclaim compares this identity immediately before unlinking,
 * so it can never delete a replacement that another caller just published.
 */
function observeSmallFile(file, maxBytes) {
  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) return null;
    const buffer = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < buffer.length) {
      const read = fs.readSync(fd, buffer, position, buffer.length - position, position);
      if (read === 0) break;
      position += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (position !== buffer.length || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return null;
    return { buffer, identity: after };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** True while the path still holds exactly the observed file (never a replacement). */
function sameObservedFile(file, identity, options = {}) {
  try {
    const current = fs.lstatSync(file, { bigint: true });
    return current.isFile() && !current.isSymbolicLink()
      && current.dev === identity.dev
      && current.ino === identity.ino
      && current.size === identity.size
      && current.mtimeNs === identity.mtimeNs
      && (options.ignoreCtime === true || current.ctimeNs === identity.ctimeNs);
  } catch {
    return false;
  }
}

function isHexDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveIntegerString(value) {
  return typeof value === "string" && /^[0-9]{1,20}$/u.test(value);
}

function isSafeAbsolutePath(value) {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_INPUT_PATH_LENGTH
    && path.isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compatibilityScalars(platform = process.platform) {
  return {
    platform,
    arch: process.arch,
    abi: process.versions.modules,
  };
}

function compatibilityMatches(left) {
  const current = compatibilityScalars();
  return isPlainObject(left)
    && left.platform === current.platform
    && left.arch === current.arch
    && left.abi === current.abi;
}

/** Every compiled entry a prepared root must contain to be usable by any consumer. */
function requiredOutputs(preparedRoot) {
  return build.REQUIRED_COMPILED_ENTRIES.map((entry) => path.join(preparedRoot, ...entry));
}

function outputsArePresent(preparedRoot) {
  for (const required of requiredOutputs(preparedRoot)) {
    try {
      const stats = fs.lstatSync(required, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0n) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * A prepared root is only ever a directory this application may load code from:
 * a bounded absolute path, a real (non-symlink) directory, and — for a source
 * generation — an immediate child of the managed build cache.
 */
function preparedRootIsSafe(preparedRoot, expectedParent) {
  if (!isSafeAbsolutePath(preparedRoot)) return false;
  if (path.dirname(path.resolve(preparedRoot)) !== path.resolve(expectedParent)) return false;
  try {
    const stats = fs.lstatSync(preparedRoot, { bigint: true });
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Application input identity (development checkouts)
// ---------------------------------------------------------------------------

/**
 * Walk exactly the application inputs once, bounded, and return both the
 * metadata index (for cheap later change detection) and a content digest (to
 * tell a real edit from a metadata-only touch). Symlinks and special files are
 * refused.
 */
function computeInputIdentity(packageRoot, testHooks) {
  const root = path.resolve(packageRoot);
  const startedAt = Date.now();
  const budget = { files: 0, bytes: 0, entries: 0, metadataBytes: 0, startedAt };
  const files = [];
  const directories = [];
  const entries = [];

  const checkBounds = () => {
    if (Date.now() - startedAt > INPUT_SCAN_TIMEOUT_MS) throw new Error("application input scan exceeded its elapsed deadline");
    if (budget.files > MAX_INPUT_FILES || budget.entries > MAX_INPUT_FILES) throw new Error("application input file limit exceeded");
    if (budget.bytes > MAX_INPUT_BYTES) throw new Error("application input byte limit exceeded");
    if (budget.metadataBytes > MAX_INPUT_METADATA_BYTES) throw new Error("application input metadata limit exceeded");
  };
  const addEntry = (entry) => {
    budget.metadataBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    checkBounds();
    entries.push(entry);
  };

  const hashFile = (file, relative) => {
    checkBounds();
    const before = build.lstatRegularFile(file);
    if (before.size > BigInt(MAX_INPUT_BYTES - budget.bytes)) throw new Error("application input byte limit exceeded");
    budget.files += 1;
    checkBounds();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
        throw new Error("application input changed before it was read");
      }
      const hash = crypto.createHash("sha256");
      const chunk = Buffer.alloc(INPUT_HASH_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        checkBounds();
        const read = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (read === 0) break;
        budget.bytes += read;
        checkBounds();
        hash.update(chunk.subarray(0, read));
        position += read;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
        throw new Error("application input changed while it was read");
      }
      files.push({
        path: relative,
        size: before.size.toString(),
        mtimeNs: before.mtimeNs.toString(),
        ctimeNs: before.ctimeNs.toString(),
        ino: before.ino.toString(),
        dev: before.dev.toString(),
        mode: Number(before.mode & 0o777n).toString(),
      });
      // Executable bits are part of the staged input identity: staging preserves
      // them, so a chmod-only change must produce a new generation rather than a
      // touch-only reuse of the previous staged modes.
      addEntry({
        path: relative,
        type: "file",
        size: before.size.toString(),
        mode: Number(before.mode & 0o111n).toString(),
        digest: hash.digest("hex"),
      });
    } finally {
      fs.closeSync(fd);
    }
  };

  const visit = (directory, relative, depth) => {
    if (depth > build.MAX_SOURCE_DEPTH) throw new Error("application input depth limit exceeded");
    checkBounds();
    const before = build.identityOfDirectory(directory);
    const stats = fs.lstatSync(directory, { bigint: true });
    directories.push({
      path: relative,
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
      ino: before.ino.toString(),
      dev: stats.dev.toString(),
      mode: Number(stats.mode & 0o777n).toString(),
    });
    addEntry({ path: relative, type: "dir" });
    let handle;
    try {
      handle = fs.opendirSync(directory);
      if (!build.sameDirectoryIdentity(directory, before)) throw new Error("application input directory changed during the scan");
      for (;;) {
        checkBounds();
        const entry = handle.readSync();
        if (!entry) break;
        budget.entries += 1;
        checkBounds();
        if (entry.name.includes("\\")) throw new Error("application input contains a non-portable path");
        const child = path.join(directory, entry.name);
        const childRelative = `${relative}/${entry.name}`;
        if (childRelative.length > MAX_INPUT_PATH_LENGTH) throw new Error("application input path limit exceeded");
        const childStats = fs.lstatSync(child, { bigint: true });
        if (!build.sameDirectoryIdentity(directory, before)) throw new Error("application input directory changed during the scan");
        if (childStats.isSymbolicLink()) throw new Error("application input tree contains a symlink");
        if (childStats.isDirectory()) visit(child, childRelative, depth + 1);
        else if (childStats.isFile()) hashFile(child, childRelative);
        else throw new Error("application input tree contains a special file");
      }
      const after = fs.lstatSync(directory, { bigint: true });
      if (after.mtimeNs !== stats.mtimeNs || !build.sameDirectoryIdentity(directory, before)) {
        throw new Error("application input directory changed during the scan");
      }
      if (typeof testHooks?.afterInputDirectory === "function") testHooks.afterInputDirectory(directory);
    } finally {
      if (handle) {
        try { handle.closeSync(); } catch { /* already closed */ }
      }
    }
  };

  for (const name of build.SOURCE_INPUT_FILES) hashFile(path.join(root, name), name);
  for (const name of build.SOURCE_INPUT_TREES) visit(path.join(root, name), name, 0);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({ schema: APPLICATION_SCHEMA, entries }))
    .digest("hex");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  directories.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { digest, files, directories, fileCount: budget.files, byteCount: budget.bytes };
}

/**
 * A recorded application-input path is always a simple relative path inside the
 * package root: no absolute form, no `..` segment, no separator/control trick,
 * and no Windows backslash. Validating the recorded path before touching the
 * filesystem keeps a marker from steering a stat outside the package.
 */
function validIndexPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INPUT_PATH_LENGTH) return false;
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split("/");
  return !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function validateInputIndex(index) {
  if (!isPlainObject(index) || !Array.isArray(index.files) || !Array.isArray(index.directories)) return false;
  if (index.files.length > MAX_INPUT_FILES || index.directories.length > MAX_INPUT_FILES) return false;
  for (const entry of index.files) {
    if (!isPlainObject(entry) || !validIndexPath(entry.path)) return false;
    for (const field of ["size", "mtimeNs", "ctimeNs", "ino", "dev", "mode"]) {
      if (!isPositiveIntegerString(entry[field])) return false;
    }
  }
  for (const entry of index.directories) {
    if (!isPlainObject(entry) || !validIndexPath(entry.path)) return false;
    for (const field of ["mtimeNs", "ctimeNs", "ino", "dev", "mode"]) {
      if (!isPositiveIntegerString(entry[field])) return false;
    }
  }
  return true;
}

/**
 * Stat only the paths the marker already names. Additions and deletions show up
 * as a changed directory timestamp; edits, touches, permission changes, and
 * same-size rewrites (which still change the inode change time) show up in the
 * recorded file metadata. This stays O(application inputs) with no traversal and
 * no content read; only a metadata change is worth the small input checksum.
 */
function inputMetadataIsUnchanged(packageRoot, index) {
  if (!validateInputIndex(index)) return false;
  const root = path.resolve(packageRoot);
  for (const entry of index.files) {
    let stats;
    try {
      stats = fs.lstatSync(path.join(root, entry.path), { bigint: true });
    } catch {
      return false;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    if (stats.size.toString() !== entry.size
      || stats.mtimeNs.toString() !== entry.mtimeNs
      || stats.ctimeNs.toString() !== entry.ctimeNs
      || stats.ino.toString() !== entry.ino
      || stats.dev.toString() !== entry.dev
      || Number(stats.mode & 0o777n).toString() !== entry.mode) return false;
  }
  for (const entry of index.directories) {
    let stats;
    try {
      stats = fs.lstatSync(path.join(root, entry.path), { bigint: true });
    } catch {
      return false;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    if (stats.mtimeNs.toString() !== entry.mtimeNs
      || stats.ctimeNs.toString() !== entry.ctimeNs
      || stats.ino.toString() !== entry.ino
      || stats.dev.toString() !== entry.dev
      || Number(stats.mode & 0o777n).toString() !== entry.mode) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Application marker
// ---------------------------------------------------------------------------

function readPackageIdentity(packageRoot) {
  const raw = readSmallFile(path.join(packageRoot, "package.json"), 1024 * 1024);
  if (raw === null) return null;
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(manifest) || manifest.name !== "pi-review-gate" || typeof manifest.version !== "string") return null;
  return { version: manifest.version };
}

/**
 * A source checkout is detected by its own TypeScript entries, never by a build
 * output. Any of the application entries identifies it, so the sidebar-only and
 * web-only layouts are recognized exactly like the full checkout.
 */
function isSourceCheckout(packageRoot, platform = process.platform) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  for (const entry of [["src", "index.ts"], ["src", "session-host", "main.ts"], ["src", "web", "cli.ts"]]) {
    try {
      const stats = fs.lstatSync(join(packageRoot, ...entry));
      if (stats.isFile() && !stats.isSymbolicLink()) return true;
    } catch {
      // Try the next application entry.
    }
  }
  return false;
}

/**
 * Structural recognition of a prepared generation: an immediate
 * `pi-review-gate-app-*` child of a `.pi-review-gate/build` directory that is a
 * real directory whose package metadata is ours. Recognition deliberately does
 * NOT claim completeness — a generation containing a copy of src/ must never be
 * mistaken for the mutable checkout (that would rebuild recursively), but only a
 * valid completion receipt makes it usable.
 */
function isPreparedGenerationRoot(packageRoot) {
  const resolved = path.resolve(packageRoot);
  const name = path.basename(resolved);
  if (!PREPARED_GENERATION_PATTERN.test(name)) return false;
  const cacheRoot = path.dirname(resolved);
  if (path.basename(cacheRoot) !== BUILD_DIRNAME) return false;
  if (path.basename(path.dirname(cacheRoot)) !== RUNTIME_DIRNAME) return false;
  try {
    const stats = fs.lstatSync(resolved, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return readPackageIdentity(resolved) !== null;
}

/**
 * Read and validate one generation's completion receipt. The receipt records the
 * generation's own directory identity and the exact package version it was built
 * from, so a reused or replaced directory, an incompatible build, or a failed /
 * in-progress compiler that happened to emit every required entry is never
 * accepted as a completed installation.
 */
function readGenerationReceipt(preparedRoot) {
  const receipt = readMarker(preparedRoot, GENERATION_RECEIPT_NAME, (value) => isPlainObject(value)
    && value.schema === APPLICATION_SCHEMA
    && compatibilityMatches(value.compat)
    && typeof value.packageVersion === "string"
    && isHexDigest(value.sourceDigest)
    && directoryIdentityMatches(preparedRoot, value.rootIdentity));
  return receipt || null;
}

/** Publish a generation's completion receipt atomically inside the generation. */
function writeGenerationReceipt(preparedRoot, options) {
  const identity = directoryIdentityOf(preparedRoot);
  if (!identity) throw new Error("the prepared generation identity is unavailable");
  writeMarker(preparedRoot, GENERATION_RECEIPT_NAME, {
    schema: APPLICATION_SCHEMA,
    rootIdentity: identity,
    packageVersion: options.packageVersion,
    sourceDigest: options.sourceDigest,
    compat: compatibilityScalars(),
    completedAt: new Date().toISOString(),
  });
}

/** The application mode of one package root: the checkout, a completed generation, or an install. */
function applicationModeOf(packageRoot, platform = process.platform) {
  if (isPreparedGenerationRoot(packageRoot)) return "generation";
  return isSourceCheckout(packageRoot, platform) ? "development" : "packaged";
}

/**
 * The agent whose managed build cache OWNS one prepared generation. A
 * generation's location is fixed by construction —
 * `<agentDir>/.pi-review-gate/build/pi-review-gate-app-*` — so the cleanup that
 * may reclaim it (and therefore the coordination this consumer's lease must be
 * published under) is derived from the validated root itself, never from the
 * caller's agent directory. Returns undefined for any root that is not a
 * recognized prepared generation.
 */
function generationOwnerScope(preparedRoot) {
  const resolved = path.resolve(preparedRoot);
  if (!isPreparedGenerationRoot(resolved)) return undefined;
  const cacheRoot = path.dirname(resolved);
  const agentDir = path.dirname(path.dirname(cacheRoot));
  if (!isSafeAbsolutePath(agentDir)) return undefined;
  return { agentDir, cacheRoot, stateRoot: applicationStateRoot(agentDir) };
}

/**
 * The finite managed directory chain from the agent boundary through the
 * application state and build cache must consist of real (non-symlink)
 * directories. Replacing `<agentDir>/.pi-review-gate` (or a deeper managed
 * component) with an alias would otherwise let marker and direct-child checks
 * accept and execute a generation through a redirected parent.
 */
function managedAncestorsAreSafe(agentDir) {
  const boundary = path.resolve(agentDir);
  for (const target of [
    boundary,
    path.join(boundary, RUNTIME_DIRNAME),
    path.join(boundary, RUNTIME_DIRNAME, APPLICATION_DIRNAME),
    path.join(boundary, RUNTIME_DIRNAME, BUILD_DIRNAME),
  ]) {
    let stats;
    try {
      stats = fs.lstatSync(target, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return false;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  }
  return true;
}

/** Recorded identity of the prepared root, so a replaced/symlinked root is never reused. */
function directoryIdentityOf(target) {
  try {
    const stats = fs.lstatSync(target, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
    return {
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      mode: Number(stats.mode & 0o777n).toString(),
    };
  } catch {
    return null;
  }
}

function directoryIdentityMatches(target, identity) {
  if (!isPlainObject(identity)
    || !isPositiveIntegerString(identity.dev)
    || !isPositiveIntegerString(identity.ino)
    || !isPositiveIntegerString(identity.mode)) return false;
  const current = directoryIdentityOf(target);
  return current !== null
    && current.dev === identity.dev
    && current.ino === identity.ino
    && current.mode === identity.mode;
}

/**
 * Every ancestor from the prepared root down to each required entry's parent is
 * a real, non-symlink directory. This is a bounded, finite check (one lstat per
 * component of a handful of fixed entries), not an artifact inventory, and it
 * stops a retargeted `dist/src` junction from redirecting the entry.
 */
function requiredEntriesAreContained(preparedRoot) {
  for (const entry of build.REQUIRED_COMPILED_ENTRIES) {
    let current = path.resolve(preparedRoot);
    for (const component of entry.slice(0, -1)) {
      current = path.join(current, component);
      let stats;
      try {
        stats = fs.lstatSync(current, { bigint: true });
      } catch {
        return false;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
  }
  return true;
}

function outputsAreContainedAndPresent(preparedRoot) {
  return requiredEntriesAreContained(preparedRoot) && outputsArePresent(preparedRoot);
}

function validateApplicationMarker(marker) {
  if (!isPlainObject(marker) || marker.schema !== APPLICATION_SCHEMA) return false;
  if (marker.mode !== "development" && marker.mode !== "packaged") return false;
  if (!compatibilityMatches(marker.compat)) return false;
  if (!isSafeAbsolutePath(marker.preparedRoot)) return false;
  if (typeof marker.packageVersion !== "string") return false;
  if (!directoryIdentityMatches(marker.preparedRoot, marker.preparedRootIdentity)) return false;
  if (marker.mode === "development") {
    if (!isHexDigest(marker.sourceDigest)) return false;
    if (!validateInputIndex(marker.sourceIndex)) return false;
    if (!isSafeAbsolutePath(marker.buildCacheRoot)) return false;
    if (directoryIdentityOf(marker.buildCacheRoot) === null) return false;
  } else if (marker.sourceDigest !== undefined && !isHexDigest(marker.sourceDigest)) {
    // A packaged marker may record the source digest it was prepared from; when
    // present it must still be a well-formed digest.
    return false;
  }
  return true;
}

/** A packaged root is the installed package itself; a source root is a build-cache child. */
function preparedRootMatchesMode(mode, preparedRoot, packageRoot, agentDir) {
  if (!isSafeAbsolutePath(preparedRoot)) return false;
  if (mode === "packaged") {
    if (path.resolve(preparedRoot) !== path.resolve(packageRoot)) return false;
    return directoryIdentityOf(preparedRoot) !== null;
  }
  if (mode === "generation") return path.resolve(preparedRoot) === path.resolve(packageRoot);
  return preparedRootIsSafe(preparedRoot, buildCacheRoot(agentDir));
}

let applicationStatusReads = 0;

/** Number of freshness decisions this process has made (test seam; never a bypass). */
function applicationStatusReadCount() {
  return applicationStatusReads;
}

/**
 * Decide whether the prepared application is already current for this package
 * root and agent directory. Reads one bounded marker and stats only recorded
 * paths; it never runs a child process, installs, compiles, or scans a tree.
 *
 * `computedIdentity` is returned when a metadata change forced the small input
 * checksum, so the caller can reuse it instead of hashing again.
 */
function applicationStatus(options) {
  applicationStatusReads += 1;
  const packageRoot = path.resolve(options.packageRoot);
  const stateRoot = options.stateRoot || applicationStateRoot(options.agentDir);
  const platform = options.platform || process.platform;
  const mode = applicationModeOf(packageRoot, platform);
  const reject = (reason) => ({ current: false, reason, mode, stateRoot });
  if (!managedAncestorsAreSafe(options.agentDir)) return reject("unsafe-state-path");
  // A prepared generation is immutable installed code, but it is NOT exempt from
  // cleanup: it is leased like any other managed root. It is current only when a
  // completion receipt proves its own compile finished against coherent inputs,
  // its recorded identity still matches this directory, and its required entries
  // are present and contained. No global marker is read or written for it, so
  // launching from one never overwrites the original checkout's state.
  if (mode === "generation") {
    if (!outputsAreContainedAndPresent(packageRoot)) return reject("generation-incomplete");
    const receipt = readGenerationReceipt(packageRoot);
    if (!receipt) return reject("generation-incomplete");
    const localIdentity = readPackageIdentity(packageRoot);
    if (!localIdentity || localIdentity.version !== receipt.packageVersion) return reject("generation-incomplete");
    return { current: true, mode, stateRoot, preparedRoot: packageRoot, reusedPreparedRoot: false, immutable: true, receipt };
  }
  const identity = readPackageIdentity(packageRoot);
  const marker = readMarker(stateRoot, MARKER_NAME, validateApplicationMarker, MAX_APPLICATION_MARKER_BYTES);
  if (!marker) return reject("no-marker");
  if (marker.mode !== mode) return reject("mode-changed");
  if (!identity) return reject("package-metadata-unreadable");
  if (marker.packageVersion !== identity.version) return reject("version-changed");
  if (mode === "development") {
    const expectedCache = buildCacheRoot(options.agentDir);
    if (path.resolve(marker.buildCacheRoot) !== path.resolve(expectedCache)) return reject("cache-root-changed");
    if (!preparedRootIsSafe(marker.preparedRoot, expectedCache)) return reject("prepared-root-invalid");
    if (!outputsAreContainedAndPresent(marker.preparedRoot)) return reject("prepared-output-missing");
    if (inputMetadataIsUnchanged(packageRoot, marker.sourceIndex)) {
      return { current: true, mode, stateRoot, marker, preparedRoot: marker.preparedRoot, reusedPreparedRoot: false };
    }
    // Metadata moved: only now is the small app-input checksum worth computing,
    // to distinguish a real edit from a touch-only or otherwise irrelevant one.
    let computed;
    try {
      computed = computeInputIdentity(packageRoot, options.testHooks);
    } catch {
      return reject("input-identity-unavailable");
    }
    if (computed.digest !== marker.sourceDigest) return reject("source-changed");
    return { current: true, mode, stateRoot, marker, preparedRoot: marker.preparedRoot, reusedPreparedRoot: true, computedIdentity: computed };
  }
  // Packaged consumers: the full exact version identifies the prebuilt code.
  if (!preparedRootMatchesMode("packaged", marker.preparedRoot, packageRoot, options.agentDir)) return reject("prepared-root-invalid");
  if (!outputsAreContainedAndPresent(marker.preparedRoot)) return reject("prepared-output-missing");
  return { current: true, mode, stateRoot, marker, preparedRoot: marker.preparedRoot, reusedPreparedRoot: false };
}

// ---------------------------------------------------------------------------
// Preparation lock (one producer) and consumer leases (live code protection)
// ---------------------------------------------------------------------------

let ownBirthIdentityCache;

/** This process's targeted birth identity. Immutable for this process; memoized. */
function ownBirthIdentity() {
  if (ownBirthIdentityCache === undefined) {
    try {
      ownBirthIdentityCache = generations.coordinationInternals.ownOwnerIdentity() || "";
    } catch {
      ownBirthIdentityCache = "";
    }
  }
  return ownBirthIdentityCache;
}

function ownerBirthIdentity(pid) {
  if (pid === process.pid) return ownBirthIdentity();
  try {
    return generations.coordinationInternals.ownerStartIdentity(pid);
  } catch {
    return "";
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockRecord(pid, birth) {
  return `${JSON.stringify({
    schema: APPLICATION_SCHEMA,
    pid,
    birth: typeof birth === "string" ? birth : "",
    nonce: crypto.randomBytes(8).toString("hex"),
    createdAt: new Date().toISOString(),
  })}\n`;
}

function parseOwnerRecord(buffer) {
  if (buffer === null) return null;
  try {
    const record = JSON.parse(buffer.toString("utf8"));
    if (!isPlainObject(record)) return null;
    if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * A record is honored whenever its owner may still be current. An unknown or
 * unavailable birth token is NOT proof of mismatch: a live pid always preserves
 * the record conservatively. Only a pid that is gone, or a pid whose birth token
 * is available and differs from the recorded one (the number was reused), makes
 * the record stale.
 */
function ownerRecordIsLive(record) {
  if (record === null) return false;
  if (!processIsAlive(record.pid)) return false;
  if (typeof record.birth !== "string" || record.birth.length === 0) return true;
  const currentBirth = ownerBirthIdentity(record.pid);
  if (currentBirth.length === 0) return true;
  return currentBirth === record.birth;
}

/**
 * One atomic publication attempt of a complete lock record: the body is written
 * and fsynced in a private candidate, then published with a no-overwrite hard
 * link. Returns `{ status: "published", identity }` when this process owns the
 * entry, `{ status: "raced" }` when another record owns it, and
 * `{ status: "failed" }` for a real filesystem error. Both lock waits share this
 * one protocol so their ownership semantics cannot drift apart.
 */
function publishLockRecord(file, directory, body) {
  const candidate = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  try {
    const fd = fs.openSync(candidate, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Atomic no-overwrite publication. EEXIST means somebody already owns it.
    fs.linkSync(candidate, file);
    const candidateStats = fs.lstatSync(candidate, { bigint: true });
    const publishedStats = fs.lstatSync(file, { bigint: true });
    if (candidateStats.dev !== publishedStats.dev || candidateStats.ino !== publishedStats.ino) {
      // The link target was replaced between our link and our check: this
      // record is not the one at the canonical path, so we do not own it.
      throw Object.assign(new Error("lock publication raced"), { code: "EEXIST" });
    }
    return { status: "published", identity: publishedStats };
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") return { status: "raced" };
    return { status: "failed" };
  } finally {
    removeQuietly(candidate);
  }
}

/**
 * Ownership of one published record. Release stays guarded by the identity
 * observed at publication: dev/ino/size/mtime identify this exact record, and
 * ctime is excluded because publishing the link itself legitimately changes it.
 */
function lockHandle(file, identity) {
  return {
    file,
    identity,
    release() {
      if (sameObservedFile(file, identity, { ignoreCtime: true })) removeQuietly(file);
    },
  };
}

/**
 * Acquire one exclusive coordination file using the same complete-candidate +
 * atomic no-overwrite publication protocol as the session host's ownership
 * entry: the full `pid` + birth body is written and fsynced in a private
 * candidate, then published with link(2), so a reader never observes an empty
 * or half-written lock and a publisher that loses the link race simply does not
 * own the entry. An abandoned record is reclaimed only after revalidating the
 * exact observed file identity immediately before unlinking, so a contender's
 * fresh record is never deleted. Returns null when the wait deadline elapses.
 */
async function acquireLockFile(file, options = {}) {
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : PREPARE_LOCK_WAIT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : LOCK_POLL_MS;
  const deadline = Date.now() + waitMs;
  const directory = path.dirname(file);
  const body = lockRecord(process.pid, ownerBirthIdentity(process.pid));
  for (;;) {
    const attempt = publishLockRecord(file, directory, body);
    if (attempt.status === "failed") return null;
    if (attempt.status === "published") return lockHandle(file, attempt.identity);
    // Somebody owns the entry: reclaim only a provably abandoned record, and
    // only while the canonical path still holds exactly that observed file.
    const observed = observeSmallFile(file, 4096);
    if (observed !== null && !ownerRecordIsLive(parseOwnerRecord(observed.buffer))) {
      if (sameObservedFile(file, observed.identity)) removeQuietly(file);
      continue;
    }
    if (Date.now() >= deadline) return null;
    if (typeof options.onWait === "function") options.onWait();
    // Async wait: a same-process caller must never block the event loop (the
    // producer it is waiting for may be an in-process preparation in tests).
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
}

/**
 * Ask the coordination module for the ONE bounded owned birth probe. The caller's
 * ABSOLUTE deadlines are handed to the helper so its signal, escalation, and
 * confirmation all land inside this same wait. A missing or failing seam simply
 * means no query is available, which is honored exactly like an unavailable
 * synchronous query: the observed record is preserved, never reclaimed.
 */
function startOwnerProbe(pid, queryDeadline, confirmDeadline) {
  try {
    const started = generations.coordinationInternals.startOwnerIdentityProbe(pid, {
      queryDeadlineMs: queryDeadline,
      confirmDeadlineMs: confirmDeadline,
    });
    return started === null || typeof started !== "object" ? { status: "unsupported" } : started;
  } catch {
    return { status: "unsupported" };
  }
}

/**
 * True while an owned helper this process started has a close that could not be
 * confirmed. Lock success is fenced by it: this process never presents itself as
 * the cleanup owner while a helper it launched may still be running.
 */
function ownerProbeUnconfirmed() {
  try {
    return generations.coordinationInternals.ownerProbeSlotState() === "unconfirmed";
  } catch {
    return true;
  }
}

/**
 * Revalidate one observed record — file identity AND content — immediately
 * before an unlink that only a positively closed birth mismatch authorized, so a
 * replacement published while the helper was running is never deleted.
 */
function observedRecordStillPresent(file, observed, record) {
  if (sameObservedFile(file, observed.identity) !== true) return false;
  const current = observeSmallFile(file, 4096);
  if (current === null) return false;
  const parsed = parseOwnerRecord(current.buffer);
  return parsed !== null
    && parsed.pid === record.pid
    && parsed.birth === record.birth
    && parsed.nonce === record.nonce;
}

/**
 * The cleanup lock's bounded wait. Same canonical protocol, the same 2s budget
 * and 50ms cadence, and the same identity-guarded release as `acquireLockFile`,
 * with one difference: a foreign owner's targeted birth query runs as ONE owned
 * asynchronous helper instead of gating the retry loop, so a holder that
 * releases its lock is seen on the next atomic publication attempt rather than
 * after a multi-hundred-millisecond synchronous `ps`/PowerShell call.
 *
 * One absolute deadline governs every branch, a stale reclaim included: no
 * publication attempt, reclaim, or hand-back of success starts after it. Lock
 * success is handed back only after EVERY helper this wait started — including one
 * cancelled because its record was replaced — has positively closed, and an
 * unknown, busy, late, or unconfirmed answer always preserves the observed record.
 * A closed verdict is consumed once against the exact record it asked about and
 * then retired, so a transient unknown can recover while budget remains; helper
 * allocations remain serial and bounded by the poll cadence and deadline.
 */
async function acquireCleanupLockFile(file, options = {}) {
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : CLEANUP_LOCK_WAIT_MS;
  if (!(waitMs > 0)) {
    // Nothing can gate a wait that never happens: a zero-budget attempt stays on
    // the ordinary path, which already answers immediately.
    return acquireLockFile(file, options);
  }
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : CLEANUP_LOCK_POLL_MS;
  const deadline = Date.now() + waitMs;
  const directory = path.dirname(file);
  const body = lockRecord(process.pid, ownerBirthIdentity(process.pid));
  /** The owned helper this wait is currently asking about, bound to one record. */
  let probe;
  /**
   * Every helper this wait started and has not yet seen close. A cancelled helper
   * stays here: cancelling is not closing, and an owned helper this process is
   * still responsible for is never dropped on the floor while it is alive.
   */
  const openHelpers = new Set();

  const pruneClosedHelpers = () => {
    for (const handle of openHelpers) {
      if (handle.state === "closed") openHelpers.delete(handle);
    }
  };

  /** Stop depending on our own helpers. They stay owned until their close lands. */
  const abandonProbe = () => {
    if (probe !== undefined) {
      probe.handle.cancel();
      probe = undefined;
    }
    for (const handle of openHelpers) handle.cancel();
    return null;
  };

  /**
   * True only when every helper this wait started has positively closed by the
   * absolute deadline, and no other helper in this process is unconfirmed.
   */
  async function helpersClosedBy(deadlineAt) {
    pruneClosedHelpers();
    const open = [...openHelpers];
    probe = undefined;
    if (open.length > 0) {
      for (const handle of open) handle.cancel();
      const remaining = Math.max(0, deadlineAt - Date.now());
      // A positive close is the only confirmation; the reserve cannot become a
      // grace period, because this race stops at the same absolute deadline.
      // The deadline timer is cleared whichever side wins: `Promise.race` does not
      // cancel its loser, and a referenced timer left behind after a prompt close
      // would keep this process alive for the rest of the cleanup budget.
      let joinTimer;
      let confirmed;
      try {
        confirmed = await Promise.race([
          Promise.all(open.map((handle) => handle.close)).then(() => true),
          new Promise((resolveJoin) => {
            joinTimer = setTimeout(() => resolveJoin(false), remaining);
          }),
        ]);
      } finally {
        if (joinTimer !== undefined) clearTimeout(joinTimer);
      }
      if (confirmed !== true) return false;
      for (const handle of open) openHelpers.delete(handle);
    }
    return ownerProbeUnconfirmed() !== true;
  }

  /**
   * The bounded owner decision for one observed record. It mirrors
   * `ownerRecordIsLive` exactly except for the single case that needs a foreign
   * birth query, which asks the owned helper instead of running the query
   * inline: a pending, busy, or unknown answer HONORS the record just as an
   * unavailable query does, and only a positively closed different birth for
   * this exact record reports it stale. Never blocks and never queries inline.
   * Returns "cheap" for the existing reclaim guard, "verified" for a positively
   * closed mismatch, and "" while the owner may still be current.
   */
  function observedRecordIsStale(observed, record) {
    if (record === null) return "cheap";
    if (!processIsAlive(record.pid)) return "cheap";
    // A record without a usable recorded birth is honored exactly as the generic
    // owner decision honors it, THIS pid included: an unavailable recorded
    // identity is not a mismatch, and a known identity of one's own never turns it
    // into evidence of staleness.
    if (typeof record.birth !== "string" || record.birth.length === 0) return "";
    if (record.pid === process.pid) {
      // This process's own record: its identity is memoized and never queried.
      const own = ownBirthIdentity();
      return own !== "" && own !== record.birth ? "cheap" : "";
    }
    const key = `${observed.identity.dev}:${observed.identity.ino}:${observed.identity.size}`
      + `:${observed.identity.mtimeNs}:${record.pid}:${record.birth}:${record.nonce}`;
    if (probe !== undefined && probe.key !== key) {
      // The record was replaced while the helper was running. That verdict
      // belongs to a different file and can never be applied here, so the helper
      // is signalled — and it stays in `openHelpers`, because a cancelled helper
      // is still an alive helper this process owns until its close lands.
      probe.handle.cancel();
      probe = undefined;
    }
    if (probe === undefined) {
      const remaining = deadline - Date.now();
      // Preserve the reserve inside this wait's absolute deadline.
      if (remaining <= CLEANUP_LOCK_PROBE_RESERVE_MS) return "";
      const started = startOwnerProbe(record.pid, deadline - CLEANUP_LOCK_PROBE_RESERVE_MS, deadline);
      if (started.status === "settled") {
        const identity = typeof started.identity === "string" ? started.identity : "";
        if (identity === "") {
          // Unknown is not stale; a later poll may retry while budget remains.
          return "";
        }
        // A definitive answer obtained without allocating a child (Linux reads one
        // `/proc` entry): compared against this exact record.
        return identity !== record.birth ? "verified" : "";
      }
      // Busy means the one owned helper is already alive somewhere: make no new
      // allocation and honor the observed owner.
      if (started.status !== "started") return "";
      probe = { handle: started.probe, key };
      openHelpers.add(started.probe);
      return "";
    }
    if (probe.handle.state !== "closed") return "";
    // Consume this closed verdict exactly once, for this exact record, and retire
    // the handle. A closed probe is never a cached answer for the rest of the
    // wait: an unknown that was only transient must be able to recover on a later
    // iteration while budget remains.
    const closed = probe;
    probe = undefined;
    openHelpers.delete(closed.handle);
    const verdict = closed.handle.verdict;
    const identity = verdict !== undefined && typeof verdict.identity === "string" ? verdict.identity : "";
    if (identity === "") return "";
    return identity === record.birth ? "" : "verified";
  }

  for (;;) {
    // The same absolute deadline governs every branch below: no attempt, reclaim,
    // grace period, or final bonus publication happens after it.
    if (Date.now() >= deadline) return abandonProbe();
    pruneClosedHelpers();
    const attempt = publishLockRecord(file, directory, body);
    if (attempt.status === "failed") return abandonProbe();
    if (attempt.status === "published") {
      const handle = lockHandle(file, attempt.identity);
      if (!(await helpersClosedBy(deadline))) {
        // A helper this process started is still alive or unconfirmed: release
        // exactly the record just published, under the ordinary identity guard,
        // and stay unavailable rather than hand back uncontested ownership.
        handle.release();
        return abandonProbe();
      }
      if (Date.now() >= deadline) {
        // Joining the helper consumed the last of the budget. Success is never
        // handed back past the deadline, so this attempt gives its own record
        // back and leaves the entry exactly as it found it.
        handle.release();
        return abandonProbe();
      }
      return handle;
    }
    // Somebody owns the entry.
    const observed = observeSmallFile(file, 4096);
    if (observed !== null) {
      const record = parseOwnerRecord(observed.buffer);
      const stale = observedRecordIsStale(observed, record);
      if (stale !== "") {
        // Reclaim only while the canonical path still holds exactly the record
        // that was judged stale; a verified reclaim re-reads the content too.
        const stillObserved = stale === "verified"
          ? observedRecordStillPresent(file, observed, record)
          : sameObservedFile(file, observed.identity);
        if (stillObserved) {
          // A reclaim earns no extra time either: it never starts past the
          // deadline the wait was given.
          if (Date.now() >= deadline) return abandonProbe();
          removeQuietly(file);
          // The entry is genuinely free now, so retry publication immediately
          // instead of waiting out another tick.
          continue;
        }
        // Somebody replaced the record between observing and unlinking, so
        // nothing was reclaimed. Fall through to the ordinary poll tick rather
        // than spinning publication attempts against a record that keeps moving.
      }
    }
    if (typeof options.onWait === "function") options.onWait();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return abandonProbe();
    // Async wait: a same-process caller must never block the event loop (the
    // producer it is waiting for may be an in-process preparation in tests), and
    // the last tick is trimmed to the deadline instead of sleeping past it.
    await new Promise((resolve) => { setTimeout(resolve, Math.min(pollMs, remaining)); });
  }
}

/** Publish this consumer's lease so an update's cleanup preserves the code it loaded. */
function publishConsumerLease(stateRoot, preparedRoot, leasePid = process.pid) {
  const directory = consumersRoot(stateRoot);
  try {
    ensureStateDirectory(directory, stateRoot);
  } catch {
    return undefined;
  }
  const file = path.join(directory, `${leasePid}-${crypto.randomBytes(8).toString("hex")}.json`);
  const body = `${JSON.stringify({
    schema: APPLICATION_SCHEMA,
    // The lease names the process that will actually run the prepared code. A
    // shell wrapper passes its own pid because it execs the launcher, so the
    // protection lasts exactly as long as the launched application.
    pid: leasePid,
    birth: ownerBirthIdentity(leasePid),
    root: preparedRoot,
    createdAt: new Date().toISOString(),
  })}\n`;
  // Publish the lease already complete: the full record is written and fsynced
  // in a private candidate, then renamed onto its unique final name. A
  // concurrent cleanup therefore never observes an empty or half-written lease
  // and treats it as a live consumer it cannot read.
  const temporary = `${file}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  let identity;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    identity = fs.lstatSync(file, { bigint: true });
  } catch {
    removeQuietly(temporary);
    removeQuietly(file);
    return undefined;
  }
  return {
    file,
    release() {
      if (sameObservedFile(file, identity)) removeQuietly(file);
    },
  };
}

/**
 * Roots currently leased by a live consumer.
 *
 * `complete` is false whenever the inventory could not be fully and
 * unambiguously inspected: more entries than the bound, an unreadable
 * directory, or an entry this module cannot positively identify as one of its
 * own lease records. A caller must then skip destructive cleanup rather than
 * ignore consumers it could not see. Unknown or malformed entries are preserved
 * untouched — they are never deleted merely because they failed to parse.
 */
function leasedRoots(stateRoot) {
  const directory = consumersRoot(stateRoot);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return { roots: new Set(), complete: true };
    return { roots: new Set(), complete: false };
  }
  if (names.length > MAX_CONSUMER_LEASES) return { roots: new Set(), complete: false };
  const roots = new Set();
  let complete = true;
  for (const name of names) {
    const file = path.join(directory, name);
    const observed = observeSmallFile(file, 4096);
    const record = observed === null ? null : parseOwnerRecord(observed.buffer);
    const valid = record !== null
      && record.schema === APPLICATION_SCHEMA
      && isSafeAbsolutePath(record.root);
    if (!valid) {
      // Not positively one of our lease records: preserve it and refuse to make
      // destructive decisions against an incomplete consumer view.
      complete = false;
      continue;
    }
    if (ownerRecordIsLive(record)) {
      roots.add(path.resolve(record.root));
      continue;
    }
    // A provably stale lease of ours: remove only the exact observed file.
    if (observed !== null && sameObservedFile(file, observed.identity)) removeQuietly(file);
  }
  return { roots, complete };
}

/**
 * Serialize the short state transition (marker publication + lease snapshot)
 * against consumers publishing their leases. It is never held for a long
 * install/compile: the producer holds the separate preparation lock for that.
 *
 * This is the only caller of the bounded wait: its 2s budget is short enough
 * that one synchronous foreign birth query could otherwise consume most of it
 * and report a busy coordination state while the holder had already released.
 */
function acquireCleanupLock(stateRoot, options = {}) {
  return acquireCleanupLockFile(path.join(stateRoot, CLEANUP_LOCK_NAME), {
    waitMs: CLEANUP_LOCK_WAIT_MS,
    pollMs: CLEANUP_LOCK_POLL_MS,
    // Narrow test/diagnostic seam: the wait is otherwise opaque, and a
    // coordination regression needs to observe exactly when a contender is
    // waiting without polling the filesystem.
    onWait: typeof options.onWait === "function" ? options.onWait : undefined,
  });
}

/**
 * Reclaim obsolete prepared generations. Destructive work only ever runs while
 * the caller holds the cleanup lock, with the selected root and every live
 * consumer preserved. When the consumer view is incomplete, cleanup is skipped
 * conservatively: an unseen consumer is never assumed absent.
 */
function cleanupPreparedGenerations(options) {
  const cacheRoot = buildCacheRoot(options.agentDir);
  const keep = Array.isArray(options.keep) ? options.keep : [];
  const preserve = typeof options.preserve === "function" ? options.preserve : () => false;
  const warnings = [];
  if (options.consumerViewComplete === false) {
    warnings.push("the consumer lease inventory was incomplete; leaving prepared generations untouched");
  } else {
    try {
      generations.cleanup(cacheRoot, {
        keep,
        preserve,
        warn: (message) => warnings.push(message),
      });
    } catch (error) {
      warnings.push(`cache cleanup could not complete (${error && error.message}); the prepared application is unaffected`);
    }
  }
  if (typeof options.writeError === "function") {
    for (const warning of warnings) options.writeError(`pi-review-gate: ${warning}.\n`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Preparation orchestration
// ---------------------------------------------------------------------------

/**
 * The default preparation engine: compile a fresh inactive generation from a
 * source checkout, or confirm a packaged install's compiled outputs. Called only
 * on a genuine miss, inside the single-producer lock.
 */
async function defaultPrepare(options) {
  const packageRoot = path.resolve(options.packageRoot);
  const mode = applicationModeOf(packageRoot);
  if (mode === "generation") {
    return {
      ok: false,
      status: 2,
      stage: "generation",
      diagnostics: "pi-review-gate: this prepared generation is incomplete and cannot be rebuilt in place; reinstall or re-prepare from a source checkout.\n",
    };
  }
  if (mode === "packaged") {
    if (!outputsAreContainedAndPresent(packageRoot)) {
      return {
        ok: false,
        status: 2,
        stage: "packaged",
        diagnostics: "pi-review-gate: the packaged extension output is missing; reinstall the package.\n",
      };
    }
    return { ok: true, status: 0, root: packageRoot };
  }
  return build.prepareStagedApplication({
    packageRoot,
    agentDir: options.agentDir,
    env: options.env,
    writeError: options.writeError,
    testHooks: options.testHooks,
    runNpm: options.runNpm,
    runCompile: options.runCompile,
    sourceBuildTimeoutMs: options.sourceBuildTimeoutMs,
  });
}

function buildApplicationMarker(options) {
  const packageRoot = path.resolve(options.packageRoot);
  const mode = options.mode;
  const identity = readPackageIdentity(packageRoot) || { version: "" };
  const marker = {
    schema: APPLICATION_SCHEMA,
    mode,
    compat: compatibilityScalars(),
    packageVersion: identity.version,
    preparedRoot: options.preparedRoot,
    preparedRootIdentity: directoryIdentityOf(options.preparedRoot),
    preparedAt: new Date().toISOString(),
  };
  if (mode === "development") {
    marker.sourceDigest = options.sourceIdentity.digest;
    marker.buildCacheRoot = buildCacheRoot(options.agentDir);
    marker.sourceIndex = {
      files: options.sourceIdentity.files,
      directories: options.sourceIdentity.directories,
    };
  } else {
    marker.outputs = requiredOutputs(options.preparedRoot);
  }
  return marker;
}

/**
 * Select the current application root and publish this consumer's lease in the
 * same short cleanup-lock section. That makes "the marker still names the root
 * I am using" and "an update's cleanup must preserve it" one atomic step: a
 * concurrent publication either happens entirely before (we read and lease the
 * new root) or entirely after (it sees our lease).
 *
 * There is deliberately NO lockless fallback. The lock holder may already be
 * performing recursive deletion after taking its own lease snapshot, and no
 * recheck can revoke that deletion authority. When the bounded wait elapses the
 * result is `coordinationUnavailable`, and the caller fails safely instead of
 * using uncoordinated code.
 */
async function selectCurrentApplication(options) {
  const callerStateRoot = options.stateRoot || applicationStateRoot(options.agentDir);
  // A completed generation is reclaimed by the cleanup of the agent whose
  // managed build cache OWNS it. This consumer's lease — and the cleanup lock
  // that makes "select and lease" one atomic step — therefore belongs under
  // THAT cache's coordination, even when the launcher was invoked with another
  // agent directory. The caller's own `status.stateRoot` still scopes its
  // config, DDGS, skills, and readiness markers, so a cross-agent launch never
  // rewrites the owning checkout's state.
  const owner = generationOwnerScope(options.packageRoot);
  const stateRoot = owner ? owner.stateRoot : callerStateRoot;
  if (owner && !managedAncestorsAreSafe(owner.agentDir)) {
    return { coordinationUnavailable: true, status: { current: false, reason: "coordination-unavailable", stateRoot: callerStateRoot } };
  }
  let stateDirectory;
  try {
    stateDirectory = fs.lstatSync(stateRoot, { bigint: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { coordinationUnavailable: true, status: { current: false, reason: "coordination-unavailable", stateRoot: callerStateRoot } };
    }
    // No shared state yet: there is no marker to adopt and no cleanup to
    // coordinate, so this is an ordinary miss rather than an unavailable
    // coordination entry. A completed generation, however, cannot exist without
    // the owning agent's application state; a missing owner entry is an
    // unavailable coordination boundary, never a miss that could hand back
    // unprotected code.
    if (owner) {
      return { coordinationUnavailable: true, status: { current: false, reason: "coordination-unavailable", stateRoot: callerStateRoot } };
    }
    return { status: { current: false, reason: "no-state", stateRoot: callerStateRoot } };
  }
  if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink()) {
    return { coordinationUnavailable: true, status: { current: false, reason: "coordination-unavailable", stateRoot: callerStateRoot } };
  }
  const lock = await acquireCleanupLock(stateRoot, { onWait: options.onCoordinationWait });
  if (!lock) {
    return { coordinationUnavailable: true, status: { current: false, reason: "coordination-unavailable", stateRoot: callerStateRoot } };
  }
  try {
    if (!managedAncestorsAreSafe(options.agentDir)) {
      return { status: { current: false, reason: "unsafe-state-path", stateRoot: callerStateRoot } };
    }
    // The owning chain was validated before the asynchronous wait; revalidate it
    // inside the acquired coordination entry, immediately before the status read
    // and lease publication. A directory renamed and aliased while this consumer
    // waited would otherwise hand back code through an unsafe managed ancestor,
    // even though the generation's receipt and directory identity still match.
    if (owner && !managedAncestorsAreSafe(owner.agentDir)) {
      return { coordinationUnavailable: true, status: { current: false, reason: "coordination-unavailable", stateRoot: callerStateRoot } };
    }
    // The decision is made against the caller's component scope, and revalidated
    // here, inside the owning cache's coordination entry, immediately before the
    // lease is published.
    const status = applicationStatus(options);
    if (!status.current) return { status };
    // Every managed prepared root (a source generation, or a completed
    // generation a launcher was itself started from) is leased for as long as
    // this consumer runs: cleanup may reclaim those roots. A packaged install
    // is never a cleanup candidate, so it needs no lease.
    if (status.mode === "packaged") return { status, lease: undefined };
    const lease = publishConsumerLease(stateRoot, status.preparedRoot, options.leasePid);
    if (lease === undefined) {
      return { status: { ...status, current: false, reason: "lease-unavailable" } };
    }
    return { status, lease };
  } finally {
    lock.release();
  }
}

/**
 * Ensure the application is current, preparing it once when it is not, and
 * attach this consumer to the root it will use.
 *
 * Returns `{ mode: "current", lease }` (nothing was installed, compiled,
 * staged, scanned, or cleaned) or `{ mode: "prepared", preparedRoot, lease }`.
 * The lease must be released when the consumer settles. Failures return
 * `{ mode: "failed" }` with a status and diagnostics; a failed or cancelled
 * preparation never publishes current state.
 */
async function prepareApplication(options) {
  const packageRoot = path.resolve(options.packageRoot);
  const agentDir = path.resolve(options.agentDir);
  const env = options.env || process.env;
  const writeError = typeof options.writeError === "function" ? options.writeError : () => undefined;
  const stateRoot = applicationStateRoot(agentDir);
  const initial = await selectCurrentApplication({
    packageRoot,
    agentDir,
    stateRoot,
    leasePid: options.leasePid,
    testHooks: options.testHooks,
    onCoordinationWait: options.onCoordinationWait,
  });
  if (initial.coordinationUnavailable) {
    writeError("pi-review-gate: application state coordination is busy right now; try again.\n");
    return { mode: "failed", status: 1, stage: "coordination" };
  }
  if (initial.status.reason === "lease-unavailable") {
    writeError("pi-review-gate: could not publish this launch's consumer lease; refusing to use prepared code.\n");
    return { mode: "failed", status: 1, stage: "lease" };
  }
  if (initial.status.reason === "unsafe-state-path") {
    writeError("pi-review-gate: the application state path is not a safe directory chain; refusing to use prepared code.\n");
    return { mode: "failed", status: 2, stage: "state" };
  }
  const status = initial.status;
  if (status.current && !status.reusedPreparedRoot) {
    return {
      mode: "current",
      preparedRoot: status.preparedRoot,
      applicationMode: status.mode,
      marker: status.marker,
      receipt: status.receipt,
      stateRoot,
      lease: initial.lease,
    };
  }
  if (status.current && status.reusedPreparedRoot) {
    // Touch-only change: refresh the recorded metadata so the next start is
    // stat-only again. Best effort and never fatal to a launch.
    let refreshedMarker;
    const refreshLock = await acquireLockFile(path.join(stateRoot, LOCK_NAME), { waitMs: 0, pollMs: 0 });
    if (refreshLock) {
      try {
        const recheck = applicationStatus({ packageRoot, agentDir, stateRoot });
        if (recheck.current && recheck.mode === "development") {
          refreshedMarker = buildApplicationMarker({
            packageRoot,
            agentDir,
            mode: "development",
            preparedRoot: recheck.preparedRoot,
            sourceIdentity: status.computedIdentity || computeInputIdentity(packageRoot),
          });
          writeMarker(stateRoot, MARKER_NAME, refreshedMarker, MAX_APPLICATION_MARKER_BYTES);
        }
      } catch {
        // A marker that cannot be refreshed is simply re-hashed next time.
      } finally {
        refreshLock.release();
      }
    }
    return {
      mode: "current",
      preparedRoot: status.preparedRoot,
      applicationMode: status.mode,
      marker: refreshedMarker || status.marker,
      receipt: status.receipt,
      stateRoot,
      lease: initial.lease,
    };
  }
  try {
    ensureStateDirectory(stateRoot, agentDir);
  } catch {
    writeError(`pi-review-gate: the application state directory is unavailable: ${stateRoot}\n`);
    return { mode: "failed", status: 2, stage: "state" };
  }
  const lock = await acquireLockFile(path.join(stateRoot, LOCK_NAME), {
    waitMs: Number.isFinite(options.lockWaitMs) ? options.lockWaitMs : PREPARE_LOCK_WAIT_MS,
    pollMs: LOCK_POLL_MS,
    onWait: () => {
      // Another producer may have finished while this launcher waited. Adopting
      // its completed state is the whole point of the lock; it never joins a
      // partial installation.
      if (typeof options.onWait === "function") options.onWait();
    },
  });
  if (!lock) {
    writeError("pi-review-gate: another launcher is still preparing the application; try again.\n");
    return { mode: "failed", status: 1, stage: "lock" };
  }
  let producerGeneration;
  try {
    const recheck = applicationStatus({ packageRoot, agentDir, stateRoot });
    if (recheck.current) {
      const current = await selectCurrentApplication({ packageRoot, agentDir, stateRoot, leasePid: options.leasePid, onCoordinationWait: options.onCoordinationWait });
      if (current.coordinationUnavailable || current.status.reason === "lease-unavailable") {
        writeError("pi-review-gate: application state coordination is unavailable; try again.\n");
        return { mode: "failed", status: 1, stage: "coordination" };
      }
      return {
        mode: "current",
        preparedRoot: current.status.preparedRoot,
        applicationMode: current.status.mode,
        marker: current.status.marker,
        receipt: current.status.receipt,
        stateRoot,
        lease: current.lease,
      };
    }
    const mode = recheck.mode;
    // A completed prepared generation is immutable installed code. If its own
    // compiled entries are incomplete it is refused outright: rebuilding "in
    // place" would mutate a generation another launcher may be running, and
    // there is no source checkout here to build from.
    if (mode === "generation") {
      writeError("pi-review-gate: this prepared generation is incomplete; run the launcher from a source checkout or reinstall the package.\n");
      return { mode: "failed", status: 2, stage: "generation" };
    }
    let sourceIdentity;
    if (mode === "development") {
      try {
        sourceIdentity = computeInputIdentity(packageRoot, options.testHooks);
      } catch (error) {
        writeError(`pi-review-gate: could not read the application inputs (${error && error.message}).\n`);
        return { mode: "failed", status: 1, stage: "input" };
      }
    }
    const prepare = typeof options.prepare === "function" ? options.prepare : defaultPrepare;
    let result;
    try {
      result = await prepare({
        packageRoot,
        agentDir,
        env,
        stateRoot,
        writeError,
        sourceIdentity,
        testHooks: options.testHooks,
        runNpm: options.runNpm,
        runCompile: options.runCompile,
        sourceBuildTimeoutMs: options.sourceBuildTimeoutMs,
      });
    } catch (error) {
      writeError(`pi-review-gate: application preparation failed (${error && error.message}).\n`);
      return { mode: "failed", status: 1, stage: "prepare" };
    }
    if (!result || result.ok !== true) {
      const detail = result && typeof result.diagnostics === "string" ? result.diagnostics : "";
      if (detail.length > 0) writeError(detail);
      const stage = result && typeof result.stage === "string" ? result.stage : "prepare";
      const status_ = result && Number.isInteger(result.status) ? result.status : 1;
      return { mode: "failed", status: status_, stage };
    }
    producerGeneration = result.generation;
    const preparedRoot = path.resolve(result.root);
    // A preparation is publishable only when its own inputs are still coherent.
    if (mode === "development") {
      let after;
      try {
        after = computeInputIdentity(packageRoot);
      } catch (error) {
        writeError(`pi-review-gate: the application inputs changed during preparation (${error && error.message}).\n`);
        return { mode: "failed", status: 1, stage: "input" };
      }
      if (after.digest !== sourceIdentity.digest) {
        writeError("pi-review-gate: the application inputs changed during preparation; the prepared generation was not published.\n");
        return { mode: "failed", status: 1, stage: "input" };
      }
      if (!preparedRootIsSafe(preparedRoot, buildCacheRoot(agentDir))) {
        writeError("pi-review-gate: the prepared application generation is unsafe; refusing to publish it.\n");
        return { mode: "failed", status: 1, stage: "publish" };
      }
    } else if (!preparedRootMatchesMode(mode, preparedRoot, packageRoot, agentDir)) {
      writeError("pi-review-gate: the prepared application root is unsafe; refusing to publish it.\n");
      return { mode: "failed", status: 1, stage: "publish" };
    }
    if (!outputsAreContainedAndPresent(preparedRoot)) {
      writeError("pi-review-gate: the prepared application is incomplete; refusing to publish it.\n");
      return { mode: "failed", status: 1, stage: "publish" };
    }
    // Publication, the completion receipt, and this consumer's lease happen
    // together under the cleanup lock. No deletion authority exists outside it,
    // and the producer's own in-flight marker stays until the generation is both
    // receipted and leased; when the lock or the lease cannot be taken, nothing
    // is published and no managed code is handed back.
    const publicationLock = await acquireCleanupLock(stateRoot);
    if (!publicationLock) {
      writeError("pi-review-gate: application state coordination is busy; the prepared generation was not published. Try again.\n");
      return { mode: "failed", status: 1, stage: "coordination" };
    }
    let lease;
    let publishedMarker;
    try {
      if (mode === "development") {
        writeGenerationReceipt(preparedRoot, {
          packageVersion: (readPackageIdentity(packageRoot) || { version: "" }).version,
          sourceDigest: sourceIdentity.digest,
        });
      }
      lease = publishConsumerLease(stateRoot, preparedRoot, options.leasePid);
      if (lease === undefined) {
        writeError("pi-review-gate: could not publish this launch's consumer lease; the prepared generation was not published.\n");
        return { mode: "failed", status: 1, stage: "lease" };
      }
      publishedMarker = buildApplicationMarker({
        packageRoot,
        agentDir,
        mode,
        preparedRoot,
        sourceIdentity,
      });
      writeMarker(stateRoot, MARKER_NAME, publishedMarker, MAX_APPLICATION_MARKER_BYTES);
      // The completed generation is now receipted, leased, and published, so this
      // producer's in-flight protection can settle before reclamation runs (which
      // needs the cache admission entry this producer has been holding).
      try { producerGeneration?.release(); } catch { /* already settled */ }
      producerGeneration = undefined;
      if (mode === "development") {
        const preserved = leasedRoots(stateRoot);
        cleanupPreparedGenerations({
          agentDir,
          keep: [preparedRoot],
          preserve: (root) => preserved.roots.has(path.resolve(root)),
          consumerViewComplete: preserved.complete,
          writeError,
        });
      }
    } finally {
      publicationLock.release();
    }
    return {
      mode: "prepared",
      preparedRoot,
      applicationMode: mode,
      marker: publishedMarker,
      // A development generation carries the same source identity as its
      // checkout; the receipt written above is the durable form of it.
      receipt: mode === "development"
        ? { sourceDigest: sourceIdentity.digest, packageVersion: publishedMarker.packageVersion }
        : undefined,
      stateRoot,
      lease,
    };
  } finally {
    // A failed or cancelled preparation settles its own in-flight marker here;
    // a successful one has already been published and leased.
    try { producerGeneration?.release(); } catch { /* already settled */ }
    lock.release();
  }
}

/**
 * Attach this consumer to a prepared root it is about to use, outside a
 * selection decision. Prefer the lease returned by `prepareApplication`; this
 * helper exists for callers that already know the root (and for tests).
 */
function attachConsumer(options) {
  const preparedRoot = path.resolve(options.preparedRoot);
  // A prepared generation is protected under its owning cache's coordination,
  // so its lease is never filed under an unrelated calling agent's state.
  const owner = generationOwnerScope(preparedRoot);
  const stateRoot = owner ? owner.stateRoot : options.stateRoot || applicationStateRoot(options.agentDir);
  let lease;
  try {
    lease = publishConsumerLease(stateRoot, preparedRoot);
  } catch {
    lease = undefined;
  }
  return lease;
}

// ---------------------------------------------------------------------------
// DDGS component readiness
// ---------------------------------------------------------------------------

function ddgsPythonPath(venv, platform) {
  return joinForPlatform(platform, venv, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
}

function ddgsVenvPath(homeDir, env, platform = process.platform) {
  const cacheRoot = joinForPlatform(
    platform,
    env.XDG_CACHE_HOME || joinForPlatform(platform, homeDir, ".cache"),
    "pi-review-gate",
  );
  return env.PI_REVIEW_GATE_DDGS_VENV || joinForPlatform(platform, cacheRoot, `ddgs-${DDGS_VERSION}`);
}

function validateDdgsMarker(marker) {
  return isPlainObject(marker)
    && marker.schema === APPLICATION_SCHEMA
    && marker.version === DDGS_VERSION
    && isSafeAbsolutePath(marker.venv)
    && isSafeAbsolutePath(marker.python)
    && isPlainObject(marker.identity)
    && (marker.identity.kind === "file" || marker.identity.kind === "symlink")
    && isPositiveIntegerString(marker.identity.dev)
    && isPositiveIntegerString(marker.identity.ino)
    && isPositiveIntegerString(marker.identity.size)
    && isPositiveIntegerString(marker.identity.mtimeNs)
    && (marker.identity.kind !== "symlink" || isSafeAbsolutePath(marker.identity.target))
    && Array.isArray(marker.components)
    && marker.components.length > 0
    && marker.components.length <= 8
    && marker.components.every((component) => isPlainObject(component)
      && isSafeAbsolutePath(component.path)
      && isPositiveIntegerString(component.dev)
      && isPositiveIntegerString(component.ino)
      && isPositiveIntegerString(component.mtimeNs));
}

/**
 * The installed DDGS distribution paths a completed environment must still
 * contain. The interpreter alone does not prove the environment is usable:
 * `pip uninstall ddgs`, a manually removed package directory, or missing
 * distribution metadata leaves the Python executable unchanged.
 */
function ddgsComponentPaths(venv) {
  if (!isSafeAbsolutePath(venv)) return null;
  const candidates = [];
  try {
    for (const name of fs.readdirSync(path.join(venv, "lib"))) {
      if (!/^python\d/u.test(name)) continue;
      candidates.push(path.join(venv, "lib", name, "site-packages"));
    }
  } catch {
    // Fall through to the Windows layout.
  }
  candidates.push(path.join(venv, "Lib", "site-packages"));
  for (const sitePackages of candidates) {
    const packageDir = path.join(sitePackages, "ddgs");
    const distInfo = path.join(sitePackages, `ddgs-${DDGS_VERSION}.dist-info`);
    const metadata = path.join(distInfo, "METADATA");
    const required = [sitePackages, packageDir, distInfo, metadata];
    const records = [];
    let complete = true;
    for (const target of required) {
      let stats;
      try {
        stats = fs.lstatSync(target, { bigint: true });
      } catch {
        complete = false;
        break;
      }
      if (stats.isSymbolicLink() || !(stats.isDirectory() || stats.isFile())) {
        complete = false;
        break;
      }
      records.push({
        path: target,
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
        mtimeNs: stats.mtimeNs.toString(),
      });
    }
    if (complete) return records;
  }
  return null;
}

function recordedComponentsStillMatch(components) {
  if (!Array.isArray(components)) return false;
  for (const component of components) {
    let stats;
    try {
      stats = fs.lstatSync(component.path, { bigint: true });
    } catch {
      return false;
    }
    if (stats.isSymbolicLink() || !(stats.isDirectory() || stats.isFile())) return false;
    if (stats.dev.toString() !== component.dev
      || stats.ino.toString() !== component.ino
      || stats.mtimeNs.toString() !== component.mtimeNs) return false;
  }
  return true;
}

/**
 * Identity of a provisioned interpreter path. A virtual environment's
 * `bin/python` is normally a symlink to the base interpreter, so this records
 * the link's own identity plus its resolved target and never treats the shared
 * base interpreter as ours: nothing is ever written, chmodded, or repaired
 * here, and only the already-provisioned path is executed.
 */
function interpreterIdentity(python) {
  let stats;
  try {
    stats = fs.lstatSync(python, { bigint: true });
  } catch {
    return null;
  }
  const identity = {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  };
  if (stats.isSymbolicLink()) {
    let target;
    try {
      target = fs.realpathSync(python);
    } catch {
      return null;
    }
    let targetStats;
    try {
      targetStats = fs.statSync(target, { bigint: true });
    } catch {
      return null;
    }
    if (!targetStats.isFile()) return null;
    return { kind: "symlink", target, ...identity };
  }
  if (!stats.isFile()) return null;
  return { kind: "file", ...identity };
}

function recordedInterpreterStillMatches(python, identity) {
  const current = interpreterIdentity(python);
  if (!current) return false;
  if (current.kind !== identity.kind
    || current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.size !== identity.size
    || current.mtimeNs !== identity.mtimeNs) return false;
  return current.kind !== "symlink" || current.target === identity.target;
}

/** A current, completed DDGS environment: no Python process is started at all. */
function currentDdgs(options) {
  const stateRoot = options.stateRoot || applicationStateRoot(options.agentDir);
  const marker = readMarker(stateRoot, DDGS_MARKER_NAME, validateDdgsMarker);
  if (!marker) return null;
  // An explicit or otherwise changed venv selection invalidates the marker: the
  // environment the caller asks for is the one that must be ready.
  if (options.homeDir !== undefined) {
    const expectedVenv = ddgsVenvPath(options.homeDir, options.env || process.env, options.platform || process.platform);
    if (path.resolve(marker.venv) !== path.resolve(expectedVenv)) return null;
  }
  if (!recordedInterpreterStillMatches(marker.python, marker.identity)) return null;
  if (!recordedComponentsStillMatch(marker.components)) return null;
  return marker;
}

function recordDdgs(stateRoot, python, venv) {
  const identity = interpreterIdentity(python);
  if (!identity) throw new Error("the DDGS interpreter is not usable");
  const components = ddgsComponentPaths(venv);
  if (!components) throw new Error("the provisioned DDGS distribution is not present in the environment");
  writeMarker(stateRoot, DDGS_MARKER_NAME, {
    schema: APPLICATION_SCHEMA,
    version: DDGS_VERSION,
    venv,
    python,
    identity,
    components,
  });
}

/**
 * Ensure the pinned DDGS dependency is ready. A completed marker makes this a
 * single small-file read; validation and installation run only when the
 * environment is missing or outdated, and a failure never publishes readiness.
 */
async function ensureDdgsReady(options) {
  const stateRoot = options.stateRoot || applicationStateRoot(options.agentDir);
  const done = currentDdgs({
    stateRoot,
    agentDir: options.agentDir,
    homeDir: options.homeDir,
    env: options.env,
    platform: options.platform,
  });
  if (done) return { ok: true, python: done.python, provisioned: false };
  let result;
  try {
    result = await options.provision();
  } catch (error) {
    return { ok: false, exitCode: 1, error };
  }
  if (!result || result.ok !== true || typeof result.python !== "string") {
    return { ok: false, exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : 1 };
  }
  if (!isSafeAbsolutePath(result.python)) {
    return { ok: false, exitCode: 1 };
  }
  try {
    recordDdgs(stateRoot, result.python, ddgsVenvPath(options.homeDir, options.env || process.env, options.platform));
  } catch {
    // A provisioner that reports a usable interpreter this module cannot record
    // (an injected producer in focused flows) still yields a working export; the
    // missing marker simply means readiness is revalidated next time.
    return { ok: true, python: result.python, provisioned: true, recorded: false };
  }
  return { ok: true, python: result.python, provisioned: true, recorded: true };
}

/**
 * Provision the pinned DDGS dependency in-process (moved from the gate helper so
 * every launcher shares one implementation). Mirrors scripts/ensure-ddgs.sh:
 * isolated-mode Python, pinned-version validation, pip consistency check,
 * binary-only install of exactly the pinned wheel.
 */
function ensureDdgs(homeDir, env, platform = process.platform) {
  const venv = ddgsVenvPath(homeDir, env, platform);
  const python = ddgsPythonPath(venv, platform);
  const spawn = (file, args, options = {}) => spawnSync(file, args, { stdio: "ignore", ...options });
  if (!fs.existsSync(python)) {
    note(`pi-review-gate: creating DDGS ${DDGS_VERSION} environment\n`);
    try {
      fs.mkdirSync(path.dirname(venv), { recursive: true });
    } catch (error) {
      note(`pi-review-gate: could not create the DDGS cache directory ${path.dirname(venv)} (${error.message})\n`);
      return { ok: false, exitCode: 1 };
    }
    const interpreter = findPythonInterpreter();
    if (!interpreter) {
      note("pi-review-gate: Python 3 is required to provision the DDGS web-search dependency (install Python 3.10 or newer and put it on PATH)\n");
      return { ok: false, exitCode: 1 };
    }
    const created = spawnSync(interpreter.file, [...interpreter.prefixArgs, "-I", "-m", "venv", venv], { stdio: "inherit" });
    if ((created.status ?? 1) !== 0) {
      note(`pi-review-gate: could not create the DDGS ${DDGS_VERSION} virtual environment at ${venv}\n`);
      return { ok: false, exitCode: created.status ?? 1 };
    }
  }
  // Isolated-mode validation mirroring ddgs_environment_is_valid: the pinned
  // version must be importable and the dependency graph consistent.
  const DDGS_VERSION_CHECK = "import ddgs, importlib.metadata as metadata, sys; sys.exit(0 if metadata.version('ddgs') == sys.argv[1] else 1)";
  const isValid = () => {
    const versionCheck = spawn(python, ["-I", "-c", DDGS_VERSION_CHECK, DDGS_VERSION]);
    if ((versionCheck.status ?? 1) !== 0) return false;
    const pipCheck = spawn(python, ["-I", "-m", "pip", "check"]);
    return (pipCheck.status ?? 1) === 0;
  };
  if (!isValid()) {
    note(`pi-review-gate: installing DDGS ${DDGS_VERSION}\n`);
    const install = spawnSync(python, [
      "-I", "-m", "pip", "install",
      "--disable-pip-version-check", "--no-cache-dir", "--no-input",
      "--only-binary=:all:", "--quiet", "--upgrade", "--upgrade-strategy", "eager",
      `ddgs==${DDGS_VERSION}`,
    ], { stdio: "inherit" });
    if ((install.status ?? 1) !== 0) return { ok: false, exitCode: install.status ?? 1 };
    if (!isValid()) {
      note(`pi-review-gate: DDGS ${DDGS_VERSION} is unavailable or has inconsistent dependencies; refusing to continue\n`);
      return { ok: false, exitCode: 1 };
    }
  }
  return { ok: true, python };
}

/**
 * Candidate isolated-mode Python 3 interpreters: python3 first (parity with
 * scripts/ensure-ddgs.sh), then python. On Windows the `py` launcher is the
 * documented way to reach an installed Python when the `python`/`python3` PATH
 * entries are the Microsoft Store execution aliases (which exit non-zero for
 * real arguments); `py -3` is tried last and only on win32.
 */
function pythonInterpreters(platform = process.platform) {
  const candidates = [
    { file: "python3", prefixArgs: [] },
    { file: "python", prefixArgs: [] },
  ];
  if (platform === "win32") candidates.push({ file: "py", prefixArgs: ["-3"] });
  return candidates;
}

function findPythonInterpreter(platform = process.platform) {
  for (const candidate of pythonInterpreters(platform)) {
    const probe = spawnSync(candidate.file, [...candidate.prefixArgs, "-I", "-c", "import sys"], { stdio: "ignore" });
    if (!probe.error && (probe.status ?? 1) === 0) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shipped skill component readiness
// ---------------------------------------------------------------------------

/** Skill provisioning manifest: every shipped skill file with its install destination. */
const SKILL_PUBLISH_PLAN = [
  {
    name: "pi-review-gate-orchestrator",
    label: "orchestrator",
    files: [
      { source: ["skills", "pi-review-gate-orchestrator", "SKILL.md"], destination: ["SKILL.md"] },
      { source: ["skills", "pi-review-gate-orchestrator", "references", "recovery.md"], destination: ["references", "recovery.md"] },
    ],
  },
  { name: "pi-review-gate-execution", label: "execution", files: [{ source: ["skills", "pi-review-gate-execution", "SKILL.md"], destination: ["SKILL.md"] }] },
  { name: "pi-review-gate-research", label: "research", files: [{ source: ["skills", "pi-review-gate-research", "SKILL.md"], destination: ["SKILL.md"] }] },
  { name: "pi-review-gate-completion", label: "completion", files: [{ source: ["skills", "pi-review-gate-completion", "SKILL.md"], destination: ["SKILL.md"] }] },
];

const SKILL_PUBLISH_TRANSIENT_ERRNOS = new Set(["EPERM", "EACCES", "EBUSY"]);
const SKILL_PUBLISH_RETRY_ATTEMPTS = 5;
const SKILL_PUBLISH_RETRY_DELAY_MS = 50;

const skillPublishSleepSignal = new Int32Array(new SharedArrayBuffer(4));

function isUsableRegularFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathIsPresent(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move a staged file into place with rename-replace, retrying only the transient
 * Windows rename-contention errnos while the destination is not a directory.
 * POSIX rename(2) has no sharing violations, so no retry happens off win32.
 */
function renameIntoPlaceWithContentionRetry(rename, options = {}) {
  const attempts = options.attempts ?? SKILL_PUBLISH_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? SKILL_PUBLISH_RETRY_DELAY_MS;
  const sleepFor = options.sleep ?? ((ms) => {
    Atomics.wait(skillPublishSleepSignal, 0, 0, ms);
  });
  const platform = options.platform ?? process.platform;
  const destinationOccupiedByDirectory = options.isDirectory
    ?? (options.destination === undefined
      ? () => false
      : () => isDirectory(options.destination));
  let lastError = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename();
      return { published: true, attempts: attempt, lastError: attempt > 1 ? lastError : null };
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" ? error.code : undefined;
      const retriable = attempt < attempts
        && platform === "win32"
        && typeof code === "string"
        && SKILL_PUBLISH_TRANSIENT_ERRNOS.has(code)
        && !destinationOccupiedByDirectory();
      if (!retriable) return { published: false, attempts: attempt, lastError };
      sleepFor(delayMs);
    }
  }
}

/**
 * Publish one shipped skill file atomically: stage complete bytes in a private
 * temporary file inside the destination directory, then move it into place with
 * one atomic rename. Readers never observe a missing or partial file, concurrent
 * launches cannot fail over each other, and a destination directory is rejected
 * instead of published into.
 */
function publishSkillFile(skillSource, skillDestination) {
  const dir = path.dirname(skillDestination);
  const tmp = path.join(dir, `.skill-publish.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o644);
  } catch {
    note(`pi-review-gate: could not create a temporary file in ${dir} (permission denied?); the skill file cannot be published to ${skillDestination}\n`);
    return false;
  }
  try {
    fs.writeFileSync(fd, fs.readFileSync(skillSource));
  } catch {
    fs.closeSync(fd);
    removeQuietly(tmp);
    note(`pi-review-gate: could not stage ${skillSource} for publication to ${skillDestination} (disk full?)\n`);
    return false;
  }
  fs.closeSync(fd);
  try {
    fs.chmodSync(tmp, 0o644);
  } catch {
    removeQuietly(tmp);
    note(`pi-review-gate: could not set permissions on the staged skill file in ${dir}; refusing to continue\n`);
    return false;
  }
  const outcome = renameIntoPlaceWithContentionRetry(
    () => fs.renameSync(tmp, skillDestination),
    { destination: skillDestination },
  );
  if (outcome.published) {
    if (outcome.attempts > 1) {
      note(`pi-review-gate: publishing the skill file to ${skillDestination} was contended (${outcome.lastError.code}: ${outcome.lastError.message}); published whole after ${outcome.attempts} attempts\n`);
    }
    return true;
  }
  removeQuietly(tmp);
  if (isDirectory(skillDestination)) {
    note(`pi-review-gate: ${skillDestination} exists but is not a replaceable regular file (a directory appeared there?); move or rename that path and re-run the launcher\n`);
  } else {
    const detail = outcome.lastError && typeof outcome.lastError === "object" && outcome.lastError.code
      ? ` (${outcome.lastError.code}: ${outcome.lastError.message})`
      : "";
    note(`pi-review-gate: unexpected failure publishing the skill file to ${skillDestination}${detail}; re-run the launcher\n`);
  }
  return false;
}

/** Refresh a shipped skill file only when the installed file is missing or differs from the source. */
function refreshSkillFile(skillSource, skillDestination) {
  try {
    const installed = fs.readFileSync(skillDestination);
    if (installed.equals(fs.readFileSync(skillSource))) return true;
  } catch {
    // Missing or unreadable destination: republish below.
  }
  return publishSkillFile(skillSource, skillDestination);
}

/**
 * One-time migration manifest for the pre-#151 generic install locations. The
 * installed file is compared against the EXPECTED HISTORICAL BYTES by digest;
 * anything else is preserved untouched. `renames` is documentary only.
 */
const SKILL_MIGRATION_PLAN = [
  {
    installed: ["orchestrator", "SKILL.md"],
    source: ["skills", "pi-review-gate-orchestrator", "SKILL.md"],
    historicalSha256: "4dadaf85c56070a4e7026d90b8ebb786968435f0d412c312eff2ef5b1898934f",
    renames: [
      ["name: orchestrator", "name: pi-review-gate-orchestrator"],
      ["../execution/SKILL.md", "../pi-review-gate-execution/SKILL.md"],
      ["../research/SKILL.md", "../pi-review-gate-research/SKILL.md"],
    ],
  },
  {
    installed: ["orchestrator", "references", "recovery.md"],
    source: ["skills", "pi-review-gate-orchestrator", "references", "recovery.md"],
    historicalSha256: "59ffd05775dcdbdce75d329aeee53b5d792c7c8153000ca9058c4ea19bff7400",
    renames: [],
    pairedWith: ["orchestrator", "SKILL.md"],
  },
  {
    installed: ["execution", "SKILL.md"],
    source: ["skills", "pi-review-gate-execution", "SKILL.md"],
    historicalSha256: "d01c322f83c3b246d910aaa57f84ca8e5700a7e9f4dc8c8009491d304436b298",
    renames: [["name: execution", "name: pi-review-gate-execution"]],
  },
  {
    installed: ["research", "SKILL.md"],
    source: ["skills", "pi-review-gate-research", "SKILL.md"],
    historicalSha256: "b50bb6eaa013ba36952d5d6663cb7b278c86d18daa6117b7c0c0cb9f61eeb4d8",
    renames: [["name: research", "name: pi-review-gate-research"]],
  },
];

/**
 * Delete proven unmodified package-owned copies at the prior generic locations.
 * Only an exact historical digest match is removed; anything else — modified or
 * user-owned content, a directory, a dangling symlink, anything unreadable — is
 * preserved. Best effort and fail-safe.
 */
function migrateGenericSkillFiles(homeDir, platform = process.platform) {
  const provenRemovals = new Set();
  const skillsRoot = joinForPlatform(platform, homeDir, ".agents", "skills");
  const dirnameFor = platform === "win32" ? path.win32.dirname : path.posix.dirname;
  for (const entry of SKILL_MIGRATION_PLAN) {
    const installedPath = joinForPlatform(platform, homeDir, ".agents", "skills", ...entry.installed);
    let probe = installedPath;
    let aliased = false;
    while (probe.length > skillsRoot.length) {
      let stats;
      try {
        stats = fs.lstatSync(probe);
      } catch {
        aliased = true;
        break;
      }
      if (stats.isSymbolicLink()) {
        aliased = true;
        break;
      }
      probe = dirnameFor(probe);
    }
    if (aliased) continue;
    if (entry.pairedWith) {
      const pairedPath = joinForPlatform(platform, homeDir, ".agents", "skills", ...entry.pairedWith);
      if (!provenRemovals.has(pairedPath)) continue;
    }
    let installed;
    try {
      installed = fs.readFileSync(installedPath);
    } catch {
      continue;
    }
    let matchesRecordedIdentity = false;
    try {
      matchesRecordedIdentity =
        crypto.createHash("sha256").update(installed).digest("hex") === entry.historicalSha256;
    } catch {
      matchesRecordedIdentity = false;
    }
    if (matchesRecordedIdentity) {
      removeQuietly(installedPath);
      if (!fs.existsSync(installedPath)) {
        provenRemovals.add(installedPath);
        note(`pi-review-gate: removed the unmodified prior copy at ${installedPath} (the shipped skills are now provisioned under the pi-review-gate- namespace)\n`);
      }
    }
  }
}

function validateSkillsMarker(marker) {
  return isPlainObject(marker)
    && marker.schema === APPLICATION_SCHEMA
    && typeof marker.applicationIdentity === "string"
    && Array.isArray(marker.files)
    && marker.files.every((file) => isPlainObject(file)
      && isSafeAbsolutePath(file.destination)
      && isPositiveIntegerString(file.size)
      && isPositiveIntegerString(file.mtimeNs)
      && isPositiveIntegerString(file.ino));
}

/**
 * Ensure every shipped skill file is installed and current. A completed marker
 * keyed to the application identity (source digest for a checkout, exact package
 * version for an installed package) plus each destination's recorded metadata
 * makes a current start perform no copy, no comparison, and no source read.
 */
function ensureShippedSkills(options) {
  const stateRoot = options.stateRoot || applicationStateRoot(options.agentDir);
  const platform = options.platform || process.platform;
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const applicationIdentity = options.applicationIdentity;
  const homeDir = options.homeDir;
  // Readiness is judged against THIS invocation's complete destination plan:
  // the marker must describe exactly the files this launch would publish (same
  // HOME, every manifest entry, in order). A marker from a previous HOME, or an
  // empty/partial file list, is never accepted as ready.
  const expectedFiles = SKILL_PUBLISH_PLAN.flatMap((skill) => skill.files.map((file) =>
    join(homeDir, ".agents", "skills", skill.name, ...file.destination)));
  const expectedSkills = SKILL_PUBLISH_PLAN.map((skill) => ({
    label: skill.label,
    path: join(homeDir, ".agents", "skills", skill.name, "SKILL.md"),
  }));
  const marker = readMarker(stateRoot, SKILLS_MARKER_NAME, validateSkillsMarker);
  if (marker && marker.applicationIdentity === applicationIdentity
    && marker.files.length === expectedFiles.length
    && marker.files.every((file, index) => file.destination === expectedFiles[index])) {
    let current = true;
    for (const file of marker.files) {
      try {
        const stats = fs.lstatSync(file.destination, { bigint: true });
        if (!stats.isFile() || stats.isSymbolicLink()
          || stats.size.toString() !== file.size
          || stats.mtimeNs.toString() !== file.mtimeNs
          || stats.ino.toString() !== file.ino) {
          current = false;
          break;
        }
      } catch {
        current = false;
        break;
      }
    }
    if (current) return { ok: true, published: false, skills: expectedSkills };
  }
  const packageRoot = path.resolve(options.packageRoot);
  // Fail closed before any publication when a packaged skill file is missing.
  for (const skill of SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(packageRoot, ...file.source);
      if (!isUsableRegularFile(source)) {
        return { ok: false, error: `packaged skill file is missing: ${source}` };
      }
    }
  }
  const installed = [];
  const recorded = [];
  for (const skill of SKILL_PUBLISH_PLAN) {
    const skillDir = join(homeDir, ".agents", "skills", skill.name);
    for (const file of skill.files) {
      const source = join(packageRoot, ...file.source);
      const destination = join(skillDir, ...file.destination);
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
      } catch {
        return { ok: false, error: `could not create the skill directory ${path.dirname(destination)} (permission denied?)` };
      }
      if (!refreshSkillFile(source, destination)) {
        return { ok: false, error: `could not refresh the shipped skill file at ${destination}; re-run the launcher` };
      }
      const stats = fs.lstatSync(destination, { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return { ok: false, error: `the published skill file at ${destination} is not a regular file` };
      }
      recorded.push({
        destination,
        size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(),
        ino: stats.ino.toString(),
      });
    }
    // One diagnostic entry per shipped skill, not per published file.
    installed.push({ label: skill.label, path: join(skillDir, "SKILL.md") });
  }
  // Only after every namespaced skill published successfully: ownership-safe
  // migration of the pre-#151 generic locations (best effort, fail-safe).
  migrateGenericSkillFiles(homeDir, platform);
  try {
    writeMarker(stateRoot, SKILLS_MARKER_NAME, {
      schema: APPLICATION_SCHEMA,
      applicationIdentity,
      files: recorded,
      installed,
      publishedAt: new Date().toISOString(),
    });
  } catch {
    // A marker that cannot be written simply means the next preparation
    // revalidates byte-for-byte; the published files are still correct.
  }
  return { ok: true, published: true, skills: installed };
}

function applicationIdentityOf(status) {
  const mode = status.applicationMode || status.mode;
  if (mode === "development") {
    const digest = (status.marker && status.marker.sourceDigest)
      || (status.receipt && status.receipt.sourceDigest);
    return typeof digest === "string" ? `source:${digest}` : `source:${status.preparedRoot}`;
  }
  if (mode === "generation") {
    // A prepared generation keeps the SAME source identity as the checkout it was
    // built from, so crossing checkout -> prepared script does not republish the
    // shipped skills merely because the mode label differs. The generation never
    // shares or rewrites the checkout's global marker.
    const digest = status.receipt && status.receipt.sourceDigest;
    return typeof digest === "string" ? `source:${digest}` : `generation:${path.basename(status.preparedRoot)}`;
  }
  const version = status.marker && status.marker.packageVersion;
  return `package:${typeof version === "string" ? version : ""}`;
}

/**
 * Complete launch preparation shared by every wrapper: make the application
 * current, then gate the DDGS and shipped-skill components. A current start
 * performs exactly ONE freshness decision, no install, compile, staging,
 * inventory, Python probe, rebuild, or cleanup; each component is validated only
 * when its own marker misses.
 *
 * Versioned resources (shipped skills, the DDGS helper) are always loaded from
 * the SELECTED prepared root that this launch holds a lease for — never from the
 * mutable checkout and never from a newer global marker. A concurrent update may
 * publish another generation while this launch runs; its code and resources stay
 * paired.
 */
async function prepareLaunch(options) {
  const packageRoot = path.resolve(options.packageRoot);
  const agentDir = path.resolve(options.agentDir);
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const writeError = typeof options.writeError === "function" ? options.writeError : () => undefined;
  const status = await prepareApplication({
    packageRoot,
    agentDir,
    env,
    writeError,
    prepare: options.prepare,
    testHooks: options.testHooks,
    lockWaitMs: options.lockWaitMs,
    leasePid: options.leasePid,
    runNpm: options.runNpm,
    runCompile: options.runCompile,
    sourceBuildTimeoutMs: options.sourceBuildTimeoutMs,
  });
  if (status.mode === "failed") return status;
  const preparedResourcesRoot = status.preparedRoot;
  const applicationIdentity = applicationIdentityOf(status);
  const homeDir = options.homeDir;
  const provision = typeof options.provisionDdgs === "function"
    ? () => options.provisionDdgs(preparedResourcesRoot)
    : () => ensureDdgs(homeDir, env, platform);
  const ddgs = await ensureDdgsReady({
    stateRoot: status.stateRoot,
    agentDir,
    homeDir,
    env,
    platform,
    provision,
  });
  if (!ddgs.ok) {
    status.lease?.release();
    writeError("pi-review-gate: DDGS setup failed.\n");
    return { mode: "failed", status: ddgs.exitCode ?? 1, stage: "ddgs" };
  }
  const skills = typeof options.publishSkills === "function"
    // Private component seam (tests/diagnostics): the same prepared root is
    // supplied, and the shared identity/lease rules still govern the application.
    ? options.publishSkills(preparedResourcesRoot)
    : ensureShippedSkills({
      stateRoot: status.stateRoot,
      agentDir,
      packageRoot: preparedResourcesRoot,
      homeDir,
      platform,
      applicationIdentity,
    });
  if (!skills.ok) {
    status.lease?.release();
    writeError(`pi-review-gate: shipped skill provisioning failed: ${skills.error}\n`);
    // A missing packaged source, an unwritable destination, or a blocked
    // publication is a setup failure (the historical exit status), never a
    // partially provisioned launch.
    return { mode: "failed", status: 2, stage: "skills" };
  }
  return {
    mode: status.mode,
    preparedRoot: preparedResourcesRoot,
    applicationMode: status.applicationMode,
    applicationIdentity,
    extension: joinForPlatform(platform, preparedResourcesRoot, "dist", "src", "index.js"),
    ddgsPython: ddgs.python,
    skills: skills.skills,
    // The lease was published together with the selection/publication decision.
    lease: status.lease,
    stateRoot: status.stateRoot,
  };
}

// ---------------------------------------------------------------------------
// CLI (thin shell wrappers call this instead of carrying their own logic)
// ---------------------------------------------------------------------------

function parseCliArguments(argv) {
  const options = { mode: "", homeDir: "", root: "", agentDir: "", leasePid: undefined };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--prepare") options.mode = "prepare";
    else if (argument === "--ensure-ddgs") options.mode = "ensure-ddgs";
    else if (argument === "--migrate-prior-skill-files") options.mode = "migrate";
    else if (argument === "--lease-for") {
      const value = Number(argv[index + 1]);
      index += 1;
      if (!Number.isInteger(value) || value <= 0) throw new Error("--lease-for requires a positive process id");
      options.leasePid = value;
    } else if (argument === "--home" || argument === "--root" || argument === "--agent-dir") {
      const value = argv[index + 1];
      index += 1;
      if (typeof value !== "string" || value.length === 0) throw new Error(`${argument} requires a value`);
      if (argument === "--home") options.homeDir = value;
      else if (argument === "--root") options.root = value;
      else options.agentDir = value;
    } else if (argument.length > 0 && argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (options.mode === "migrate" && options.homeDir.length === 0 && positional.length > 0) {
    options.homeDir = positional[0];
  }
  if (options.mode === "ensure-ddgs" && options.homeDir.length === 0 && positional.length > 0) {
    options.homeDir = positional[0];
  }
  return options;
}

async function runCli(argv) {
  let options;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    note(`pi-review-gate: ${error.message}\n`);
    return 2;
  }
  const platform = process.platform;
  const homeDir = options.homeDir.length > 0 ? options.homeDir : os.homedir();
  const packageRoot = options.root.length > 0 ? path.resolve(options.root) : path.resolve(__dirname, "..");
  if (options.mode === "migrate") {
    migrateGenericSkillFiles(homeDir, platform);
    return 0;
  }
  if (options.mode === "ensure-ddgs") {
    const result = ensureDdgs(homeDir, process.env, platform);
    out(`${JSON.stringify(result && result.ok === true
      ? { ok: true, python: result.python }
      : { ok: false, exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : 1 })}\n`);
    return result && result.ok === true ? 0 : 1;
  }
  if (options.mode !== "prepare") {
    note("pi-review-gate: usage: prepare-application.cjs --prepare [--home <dir>] [--root <dir>] [--agent-dir <dir>] [--lease-for <pid>]\n");
    return 2;
  }
  const agentDir = options.agentDir.length > 0
    ? path.resolve(options.agentDir)
    : path.resolve(resolvePiAgentDir(process.env, { homeDir, platform }));
  const result = await prepareLaunch({
    packageRoot,
    agentDir,
    homeDir,
    env: process.env,
    platform,
    // The lease names the invoking parent's NATIVE pid: a POSIX wrapper execs
    // pi/node, which preserves that pid, while a numeric Bash/MSYS `$$` is not
    // trusted as a native process identity. An explicit --lease-for still wins
    // for tests/diagnostics.
    leasePid: options.leasePid ?? (Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : process.pid),
    writeError: (text) => note(text),
  });
  if (result.mode === "failed") return result.status ?? 1;
  const lines = [`mode\t${result.mode}`];
  lines.push(`root\t${result.preparedRoot}`);
  lines.push(`extension\t${result.extension}`);
  lines.push(`ddgs\t${result.ddgsPython}`);
  for (const skill of result.skills || []) lines.push(`skill\t${skill.label}\t${skill.path}`);
  out(`${lines.join("\n")}\n`);
  return 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    note(`pi-review-gate: application preparation failed (${error && error.message}).\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPLICATION_SCHEMA,
  DDGS_VERSION,
  MARKER_NAME,
  DDGS_MARKER_NAME,
  SKILLS_MARKER_NAME,
  SKILL_MIGRATION_PLAN,
  SKILL_PUBLISH_PLAN,
  SKILL_PUBLISH_RETRY_ATTEMPTS,
  SKILL_PUBLISH_RETRY_DELAY_MS,
  applicationIdentityOf,
  applicationStateRoot,
  applicationStatus,
  attachConsumer,
  buildCacheRoot,
  compatibilityScalars,
  compatibilityFallbackConfigPath,
  computeInputIdentity,
  currentDdgs,
  ddgsPythonPath,
  ddgsVenvPath,
  ensureApplicationStateDirectory,
  ensureDdgs,
  ensureDdgsReady,
  ensureShippedSkills,
  inputMetadataIsUnchanged,
  isPreparedGenerationRoot,
  isSourceCheckout,
  applicationModeOf,
  validateInputIndex,
  acquireCleanupLock,
  joinForPlatform,
  leasedRoots,
  migrateGenericSkillFiles,
  normalizeWindowsShellPath,
  piAgentConfigPath,
  prepareApplication,
  prepareLaunch,
  publishSkillFile,
  publishConsumerLease,
  readMarker,
  refreshSkillFile,
  renameIntoPlaceWithContentionRetry,
  resolvePiAgentDir,
  runtimeRoot,
  writeMarker,
  __test: {
    acquireCleanupLock,
    acquireLockFile,
    applicationStatusReadCount,
    cleanupPreparedGenerations,
    defaultPrepare,
    observeSmallFile,
    readGenerationReceipt,
    pythonInterpreters,
    readSmallFile,
    runCli,
    selectCurrentApplication,
    validateApplicationMarker,
    writeGenerationReceipt,
    resetApplicationStatusReads: () => { applicationStatusReads = 0; },
  },
};
