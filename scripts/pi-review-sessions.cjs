#!/usr/bin/env node
"use strict";

/**
 * Shared setup and runtime selection for the one-command session host
 * launchers (issue 323). scripts/pi-review-sessions.sh (POSIX) and
 * scripts/pi-review-sessions.cmd (native Windows entry point) both dispatch
 * here, as does the installed `pi-review-sessions` bin. The user runs one
 * launcher command with NO manual Pi CLI path:
 *
 * - Setup is shared with the ordinary review-gate launchers: a source
 *   checkout rebuilds through the fixed npm build command, and DDGS
 *   provisioning uses the shared Node helper (ensureDdgs in scripts/
 *   pi-review-gate-launcher.cjs) instead of a Bash-only call, so the same
 *   host setup can run from the .cmd entry point.
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
 *   preserved, and staging is removed only when positively owned by this
 *   run.
 * - Probes and provisioning occur BEFORE the host broker/token exists, on a
 *   scrubbed setup environment (bootstrap/restore markers removed, role
 *   authorization rejected earlier), while trusted provider variables and
 *   the user's original NODE_OPTIONS are preserved for the actual native
 *   launch. Diagnostics are bounded: fixed names and paths, never command
 *   output or environment content.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertSessionHostStartupOptions } = require("./session-host-startup-options.cjs");
const gateLauncher = require("./pi-review-gate-launcher.cjs");

const USAGE = `Usage: pi-review-sessions [--pi-executable <path>] [--state-root <path>] [--sidebar-key <key>] [--help] [-- <Pi arguments...>]

Alpha POSIX macOS/Linux session host. Requires Node >=22.19.0 and Pi >=1.0.4
with a positively identified Node CLI entry. Without --pi-executable the
launcher resolves the public @earendil-works/pi-coding-agent installation
(npm global root, then PATH) and, when none is supported, provisions an
isolated Pi 1.0.4 runtime cache under the native Pi agent directory; no
manual Pi CLI path is needed. Starts an empty welcome/sidebar picker; choose
a label, workspace, and profile explicitly in the UI. The startup working
directory is not selected as a workspace. Basic controls only; terminal
graphics rendering is disabled; native image/model input behavior stays
native. The sidebar toggle defaults to alt+left. Parent startup session
overrides (--continue/-c, --resume/-r, --session, --session-id, --fork,
--session-dir, --no-session, PI_CODING_AGENT_SESSION_DIR) are not accepted:
every instance starts a new native chat in its own profile-owned storage.`;

const MAX_PATH_LENGTH = 2048;
const MAX_TOGGLE_KEY_LENGTH = 80;
const HOST_ENV_TO_CLEAR = [
  "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP",
  "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE",
  "PI_REVIEW_GATE_DDGS_PYTHON",
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
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NODE_ENTRY_HEAD_BYTES = 512;

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
  return result && Number.isInteger(result.status) ? result.status : fallback;
}

/**
 * Remove an owned staging root without ever descending into or deleting a
 * directory named `.terraform` (initialized Terraform dependencies can be
 * arbitrarily large and are never this launcher's to manage). Symlinks are
 * unlinked, never followed. Returns true when the target is fully removed;
 * a preserved `.terraform` subtree keeps its ancestors in place.
 */
function removeOwnedStage(target) {
  if (path.basename(target) === ".terraform") return false;
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fs.unlinkSync(target);
    return true;
  }
  let empty = true;
  for (const name of fs.readdirSync(target)) {
    if (!removeOwnedStage(path.join(target, name))) empty = false;
  }
  if (empty) fs.rmdirSync(target);
  return empty;
}

/**
 * Stage the source checkout's build inputs into an owned package root under
 * the agent directory's cache (issue 323, source-build safety contract):
 * `npm run build` deletes and rewrites dist/, so it must never run against
 * the live checkout — a running extension may be using that dist. The stage
 * carries everything the build and the compiled host need from the package:
 * package.json (build script), tsconfig.json, src/ (compiled), scripts/ and
 * skills/ (shipped helpers and native profile skill sources). Directories
 * named `.terraform` are pruned at traversal time and never copied. The
 * original checkout, including its live dist/, is never modified.
 */
function stageSourcePackage(packageRoot, buildCacheRoot) {
  const stagingRoot = path.join(buildCacheRoot, `pi-review-sessions-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
    for (const name of ["package.json", "tsconfig.json"]) {
      const source = path.join(packageRoot, name);
      const stats = fs.statSync(source);
      if (!stats.isFile()) throw new Error(`missing ${name}`);
      fs.copyFileSync(source, path.join(stagingRoot, name));
    }
    for (const name of ["src", "scripts", "skills"]) {
      const source = path.join(packageRoot, name);
      if (fs.existsSync(source)) {
        fs.cpSync(source, path.join(stagingRoot, name), {
          recursive: true,
          // Prune initialized Terraform contents at traversal time.
          filter: (candidate) => path.basename(candidate) !== ".terraform",
        });
      }
    }
    // The build resolves its dev dependencies (tsc, @types) from the
    // checkout's own node_modules. A symlink keeps that use read-only:
    // nothing is installed into, or written through, the checkout.
    const checkoutNodeModules = path.join(packageRoot, "node_modules");
    if (fs.existsSync(checkoutNodeModules)) {
      fs.symlinkSync(checkoutNodeModules, path.join(stagingRoot, "node_modules"), "junction");
    }
  } catch {
    // Positively owned by this run: created moments ago under a random name.
    try {
      removeOwnedStage(stagingRoot);
    } catch {
      // Preserve what cannot be removed; the build will fail closed below.
    }
    throw new Error("could not stage the source package for building");
  }
  return stagingRoot;
}

function buildSourceExtension(options) {
  const { packageRoot, agentDir, env } = options;
  let stagingRoot;
  try {
    stagingRoot = stageSourcePackage(packageRoot, path.join(agentDir, RUNTIME_CACHE_DIRNAME, "build"));
  } catch {
    return { status: 1, error: new Error("could not stage the source package for building"), stagingRoot: undefined };
  }
  // tsc resolves from the checkout's own dev dependencies (read-only use);
  // nothing is installed into or modified in the checkout.
  const buildEnv = { ...env, PATH: `${path.join(packageRoot, "node_modules", ".bin")}:${env.PATH ?? ""}` };
  // Fixed npm command against the staged root; the root is a positional
  // argument, never shell text. The live checkout's dist/ is untouched.
  const result = spawnSync("npm", ["--prefix", stagingRoot, "run", "build"], {
    cwd: stagingRoot,
    env: buildEnv,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    // Remove this run's owned stage on failure; a successful stage is kept
    // because the launched host keeps loading from it.
    try {
      removeOwnedStage(stagingRoot);
    } catch {
      // Preserve what cannot be removed; the launch fails closed anyway.
    }
    return { status: result.status ?? 1, error: result.error, stagingRoot: undefined };
  }
  return { status: 0, stagingRoot };
}

function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
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
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof value === "string" ? value : "");
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

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Bounded first-bytes read (never a whole-file scan; O_NONBLOCK, fstat-checked). */
function readHeadBytes(file, bytes) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) return undefined; // special file: never probe it
      const head = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < head.length) {
        const bytesRead = fs.readSync(fd, head, offset, head.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
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
 * exactly `#!<interpreter>` with basename `node` and no flags, or
 * `#!<env> node` naming precisely the bare `node` argument. Opaque shell
 * shims, exotic interpreters, and extra tokens reject.
 */
function isNodeEntryShebang(head) {
  const lineEnd = head.indexOf(0x0a);
  if (lineEnd === -1 && head.length === NODE_ENTRY_HEAD_BYTES) return false; // incomplete bounded first line
  const firstLine = (lineEnd === -1 ? head : head.subarray(0, lineEnd)).toString("utf8").trim();
  const match = firstLine.match(/^#![ \t]*(\S+)(?:[ \t]+(\S+))?[ \t]*$/);
  if (!match) return false;
  const [, interpreter, argumentMaybe] = match;
  const interpreterBasename = interpreter.slice(interpreter.lastIndexOf("/") + 1);
  if (interpreterBasename === "node") return argumentMaybe === undefined;
  if (interpreterBasename === "env") return argumentMaybe === "node";
  return false;
}

/** Strict bounded --version probe: only the official stdout format parses. */
function probePiVersion(file, env) {
  let result;
  try {
    result = spawnSync(file, ["--version"], {
      env,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: VERSION_PROBE_MAX_BYTES,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    throw new PiRuntimeError(`the pi version probe could not run: ${file}`);
  }
  if (result.error) {
    const errno = result.error.code;
    if (errno === "ENOENT") throw new PiRuntimeError(`the pi executable is missing: ${file}`);
    if (errno === "ENOBUFS") throw new PiRuntimeError(`the pi --version output exceeded the probe limit; refusing to use it: ${file}`);
    if (errno === "ETIMEDOUT") throw new PiRuntimeError(`the pi version probe did not answer within ${Math.round(VERSION_PROBE_TIMEOUT_MS / 1000)}s; refusing to use ${file}`);
    const detail = errno ? ` (${String(errno)})` : "";
    throw new PiRuntimeError(`the pi version probe failed${detail}: ${file}`);
  }
  if (result.signal) {
    throw new PiRuntimeError(`the pi version probe did not answer within ${Math.round(VERSION_PROBE_TIMEOUT_MS / 1000)}s; refusing to use ${file}`);
  }
  if (result.status !== 0) {
    throw new PiRuntimeError(`the pi version probe exited with status ${String(result.status)}: ${file}`);
  }
  const parsed = `${result.stdout ?? ""}`.trim().match(/^(?:pi\s+)?v?(\d+\.\d+\.\d+)$/);
  if (!parsed) {
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
 * regular readable executable Node-entry file, and a live bounded version
 * probe that must agree with the package metadata.
 * When expectedFile is given (the PATH case), the declared bin must resolve
 * to exactly that file.
 */
function validatePiPackage(pkgDir, env, options = {}) {
  const { expectedFile, exactVersion } = options;
  const manifestPath = path.join(pkgDir, "package.json");
  let manifest;
  try {
    const stats = fs.statSync(manifestPath);
    if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) throw new PiRuntimeError("bad manifest");
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new PiRuntimeError(`the pi package metadata at ${pkgDir} is unreadable or invalid`);
  }
  if (manifest === null || typeof manifest !== "object" || manifest.name !== PI_PACKAGE_NAME) {
    throw new PiRuntimeError(`the package at ${pkgDir} is not the public pi package (${PI_PACKAGE_NAME})`);
  }
  const version = parseStableVersion(manifest.version);
  if (!version || compareVersions(version, PI_MIN_VERSION) < 0) {
    throw new PiRuntimeError(`the installed pi version ${String(manifest.version)} is unsupported (requires >= ${PI_MIN_VERSION.join(".")})`);
  }
  if (exactVersion !== undefined && manifest.version !== exactVersion) {
    throw new PiRuntimeError(`the cached pi runtime version ${String(manifest.version)} does not match the pinned provision version ${exactVersion}`);
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
  let canonical;
  try {
    const stats = fs.statSync(entry);
    if (!stats.isFile()) throw new PiRuntimeError("not a file");
    fs.accessSync(entry, fs.constants.R_OK | fs.constants.X_OK);
    canonical = fs.realpathSync(entry);
  } catch {
    throw new PiRuntimeError(`the pi CLI entry is not a regular readable executable file: ${entry}`);
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
  const probed = probePiVersion(canonical, env);
  // Metadata/probe agreement: the live entry must report exactly the version
  // its package metadata declares; a mismatched pair is never trusted.
  if (probed !== String(manifest.version)) {
    throw new PiRuntimeError(`the pi version probe (${probed}) disagrees with the package metadata (${String(manifest.version)}) at ${pkgDir}`);
  }
  return { file: canonical, version: probed };
}

/** The npm global package root (single absolute line), or undefined. */
function npmGlobalRoot(env) {
  let result;
  try {
    result = spawnSync("npm", ["root", "-g"], {
      env,
      encoding: "utf8",
      timeout: NPM_ROOT_TIMEOUT_MS,
      maxBuffer: VERSION_PROBE_MAX_BYTES,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    return undefined;
  }
  if (result.error || result.status !== 0) return undefined;
  const line = `${result.stdout ?? ""}`.trim();
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

/** First PATH entry holding an executable regular file named `pi`, realpathed. */
function findPiOnPath(env) {
  for (const rawEntry of `${env.PATH ?? ""}`.split(path.posix.delimiter)) {
    if (!rawEntry) continue; // an empty PATH entry would mean the current directory: never searched
    const candidate = path.join(rawEntry, "pi");
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
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
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
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
 * Provision the isolated Pi 1.0.4 runtime under the native agent directory's
 * cache. An existing target is validated and reused or preserved-and-failed;
 * a fresh install stages under an owned `.staging-*` directory, validates,
 * and publishes with a single rename. Stale staging from interrupted runs is
 * removed by positive name-pattern ownership only; everything else in the
 * cache area is preserved untouched.
 */
function provisionPiRuntime(options) {
  const { env, agentDir, writeError } = options;
  const runtimeRoot = path.join(agentDir, RUNTIME_CACHE_DIRNAME, PI_RUNTIME_DIRNAME);
  const versionDirName = `pi-${PI_PROVISION_VERSION}`;
  const targetNodeModules = path.join(runtimeRoot, versionDirName, "node_modules");
  const targetPkgDir = path.join(targetNodeModules, "@earendil-works", "pi-coding-agent");

  if (pathExists(targetPkgDir)) {
    try {
      return { ...validatePiPackage(targetPkgDir, env, { exactVersion: PI_PROVISION_VERSION }), source: "isolated-cache" };
    } catch {
      throw new PiRuntimeError(`the cached pi runtime at ${targetPkgDir} is invalid; remove that directory and re-run the launcher`);
    }
  }

  // Pre-existing staging directories are never removed: a name proves neither
  // ownership nor inactivity, and another launch may be mid-install. Only
  // this run's own stage (random suffix, created below) is cleaned up.
  const stagingRoot = path.join(runtimeRoot, `.staging-pi-${PI_PROVISION_VERSION}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    fs.mkdirSync(stagingRoot, { recursive: true });
  } catch {
    throw new PiRuntimeError(`could not create the pi runtime staging directory under ${runtimeRoot} (permission denied?)`);
  }
  try {
    const install = spawnSync("npm", [
      "install",
      "--prefix", stagingRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry", "https://registry.npmjs.org",
      `${PI_PACKAGE_NAME}@${PI_PROVISION_VERSION}`,
    ], {
      env,
      cwd: stagingRoot,
      stdio: "inherit",
      timeout: NPM_INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (install.error || install.status !== 0) {
      throw new PiRuntimeError("pi runtime provisioning failed (npm install); re-run the launcher");
    }
    const stagedPkgDir = path.join(stagingRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const validated = validatePiPackage(stagedPkgDir, env, { exactVersion: PI_PROVISION_VERSION });
    try {
      fs.mkdirSync(path.join(runtimeRoot, versionDirName), { recursive: true });
      fs.renameSync(path.join(stagingRoot, "node_modules"), targetNodeModules);
    } catch {
      // A concurrent launch may have published the same runtime meanwhile.
      try {
        return { ...validatePiPackage(targetPkgDir, env, { exactVersion: PI_PROVISION_VERSION }), source: "isolated-cache" };
      } catch {
        throw new PiRuntimeError(`the cached pi runtime at ${targetPkgDir} is invalid; remove that directory and re-run the launcher`);
      }
    }
    // Re-validate the published location (not the staged path): the host
    // receives exactly the entry that survived the rename.
    const published = validatePiPackage(targetPkgDir, env, { exactVersion: PI_PROVISION_VERSION });
    writeError(`pi-review-sessions: installed isolated Pi ${PI_PROVISION_VERSION} runtime at ${runtimeRoot}\n`);
    return { ...published, source: "isolated-cache" };
  } finally {
    // Positively owned by this run: the staging root (leftover package-lock
    // after a successful rename, or the whole failed stage).
    try {
      removeOwnedStage(stagingRoot);
    } catch {
      // Preserve what cannot be removed; the published runtime is unaffected.
    }
  }
}

/**
 * Resolve the public supported Pi CLI entry (issue 323). Order: explicit
 * --pi-executable (validated, no fallback), npm global package root, PATH
 * `pi` inside the public package, isolated cache provisioning. Returns
 * { file, version, source }; throws PiRuntimeError with a bounded message.
 */
function resolvePiRuntime(options) {
  const { explicit, env, agentDir, cwd, writeError } = options;

  if (explicit !== undefined) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
    let canonical;
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) throw new PiRuntimeError("not a file");
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
      canonical = fs.realpathSync(candidate);
    } catch {
      throw new PiRuntimeError(`the configured pi executable is not a regular readable executable file: ${candidate}`);
    }
    const head = readHeadBytes(canonical, NODE_ENTRY_HEAD_BYTES);
    if (!head || head.length < 2 || !isNodeEntryShebang(head)) {
      throw new PiRuntimeError(`the configured pi executable is not a positive Node entry (expected the standard npm-installed pi CLI entry file): ${canonical}`);
    }
    const version = probePiVersion(canonical, env);
    return { file: canonical, version, source: "explicit" };
  }

  const globalRoot = npmGlobalRoot(env);
  if (globalRoot) {
    const pkgDir = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (isDirectory(pkgDir)) {
      try {
        return { ...validatePiPackage(pkgDir, env), source: "npm-global" };
      } catch {
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
        return { ...validatePiPackage(pkgDir, env, { expectedFile: onPath }), source: "path" };
      } catch {
        // Not positively identified as the public package: fall through.
      }
    }
  }

  writeError(`pi-review-sessions: no supported pi installation found; provisioning isolated Pi ${PI_PROVISION_VERSION} runtime\n`);
  return provisionPiRuntime({ env, agentDir, writeError });
}

// ---------------------------------------------------------------------------
// Launcher flow
// ---------------------------------------------------------------------------

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
    // Shared Node DDGS provisioning (scripts/pi-review-gate-launcher.cjs):
    // replaces the Bash-only ensure-ddgs.sh call so the same host setup can
    // run from the .cmd entry point.
    ensureDdgs: (homeDir, env) => gateLauncher.ensureDdgs(homeDir, env),
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

  const inheritedEnv = deps.getEnv();

  // Reject parent startup session overrides before any setup (build, Pi
  // runtime, DDGS, profile, token, PTY): every created instance would inherit
  // them and open the same old chat/storage instead of a new native chat of
  // its own.
  try {
    assertSessionHostStartupOptions(parsed.args, inheritedEnv);
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
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    deps.writeError("pi-review-sessions: the alpha session host supports POSIX macOS/Linux only.\n");
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

  // Scrub inherited host bootstrap/status values before build, Pi runtime
  // probes/provisioning, DDGS, and loading the compiled host. Preserve every
  // other user environment setting, including NODE_OPTIONS and provider
  // variables.
  const setupEnv = { ...inheritedEnv };
  for (const name of HOST_ENV_TO_CLEAR) delete setupEnv[name];
  if (inheritedEnv === deps.processEnv) {
    for (const name of HOST_ENV_TO_CLEAR) delete deps.processEnv[name];
  }

  // Native Pi agent directory (honors PI_CODING_AGENT_DIR with Pi's native
  // semantics via the shared launcher helper): owns the isolated runtime
  // cache and the generated profile state.
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
  // The host's runtime file lookups (extension entry, reporter, preload,
  // native skill sources) resolve against this root; a staged source build
  // redirects it to the owned stage so nothing is read from the live dist.
  let hostPackageRoot = packageRoot;
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
      build = deps.build({ packageRoot, agentDir, env: setupEnv });
    } catch {
      deps.writeError("pi-review-sessions: extension build failed.\n");
      return 1;
    }
    if (build && build.error) {
      deps.writeError("pi-review-sessions: extension build failed.\n");
      return 1;
    }
    if (!build || build.status !== 0) {
      deps.writeError("pi-review-sessions: extension build failed.\n");
      return statusCode(build);
    }
    if (typeof build.stagingRoot === "string" && build.stagingRoot.length > 0) {
      hostPackageRoot = build.stagingRoot;
      compiledEntry = path.join(build.stagingRoot, "dist", "src", "session-host", "main.js");
    }
  }

  if (!deps.isRegularFile(compiledEntry)) {
    deps.writeError("pi-review-sessions: compiled native session host is unavailable.\n");
    return 2;
  }

  // Resolve or provision the Pi runtime BEFORE any host capability exists:
  // probes and provisioning run on the scrubbed setup env, so no bootstrap/
  // restore token reaches them, and the resolved entry is handed to the host
  // as an explicit executable (never a bare PATH name).
  let piRuntime;
  try {
    piRuntime = deps.resolvePiRuntime({
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
  if (!piRuntime || typeof piRuntime.file !== "string" || !path.isAbsolute(piRuntime.file) || typeof piRuntime.version !== "string") {
    deps.writeError("pi-review-sessions: Pi runtime selection failed.\n");
    return 1;
  }
  deps.writeError(`pi-review-sessions: pi runtime: ${piRuntime.file} (v${piRuntime.version}, ${piRuntime.source})\n`);

  // The shared DDGS helper spawns Python children that inherit the process
  // environment; keep the host bootstrap/restore tokens out of those
  // descendants for the duration of setup (fail-closed invariant) and
  // restore the caller's environment afterward.
  const savedTokens = {};
  for (const name of HOST_ENV_TO_CLEAR) {
    if (name in process.env) {
      savedTokens[name] = process.env[name];
      delete process.env[name];
    }
  }
  let ddgs;
  try {
    ddgs = deps.ensureDdgs(homeDir, setupEnv);
  } catch {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return 1;
  } finally {
    for (const [name, value] of Object.entries(savedTokens)) process.env[name] = value;
  }
  if (!ddgs || ddgs.ok !== true || typeof ddgs.python !== "string") {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return ddgs && Number.isInteger(ddgs.exitCode) ? ddgs.exitCode : 1;
  }
  const python = ddgs.python;
  if (!path.isAbsolute(python) || /[\u0000-\u001f\u007f]/u.test(python)) {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
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
  __test: { runSessionHostLauncher, resolvePiRuntime, validatePiPackage, probePiVersion, stageSourcePackage, removeOwnedStage },
};
