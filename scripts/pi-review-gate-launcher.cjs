#!/usr/bin/env node
"use strict";

/*
 * Native Windows implementation of the persistent pi-review-gate launcher
 * (issue 108), paired with scripts/pi-review-gate.cmd.
 *
 * scripts/pi-review-gate.sh stays the launcher on macOS/Linux; this helper
 * mirrors its observable behavior on native Windows without Bash, WSL, or
 * PowerShell script execution, and the .cmd entry point keeps the batch layer
 * thin: Pi management verbs pass straight through to pi there, everything else
 * is delegated here — including the final pi execution, so environment
 * sanitization and the exit status propagate exactly as the POSIX launcher's
 * `exec pi` does.
 *
 * Behavioral contract (mirrors scripts/pi-review-gate.sh):
 * - Deletes an inherited PI_REVIEW_GATE_CONFIG and re-resolves the persistent
 *   config, so a parent pi session cannot redirect the gate; deliberately does
 *   NOT touch PI_REVIEW_GATE_DISABLED (the documented kill switch, with a
 *   truthy-value warning) or PI_CODING_AGENT_DIR (Pi's own agent directory).
 * - Selects the first existing config candidate: the native Pi agent
 *   directory's review-gate.json (honoring PI_CODING_AGENT_DIR with Pi's
 *   native semantics mirrored from src/config-path.ts), then the sole
 *   compatibility fallback ~/.config/pi-review-gate/config.json. A present
 *   candidate must be a usable regular file (dangling symlinks and
 *   directories included) or the launcher fails closed. On first launch, when
 *   neither exists, a private zero-model default config is created at the
 *   default location, staged in a temporary file and published with
 *   exact-destination link(2) semantics so concurrent first launches never
 *   clobber each other or expose partial JSON.
 * - Rebuilds dist when src/index.ts is present (normal development launch);
 *   in packaged mode uses the packaged dist/src/index.js and fails closed
 *   when it is missing. A build failure exits with the build's status before
 *   anything is launched, so a stale extension is never started.
 * - Provisions the pinned DDGS web-search dependency, mirroring
 *   scripts/ensure-ddgs.sh (isolated-mode Python, version validation, pip
 *   check, binary-only install) with the Windows venv layout
 *   Scripts\python.exe and a python3 -> python interpreter probe, then
 *   exports PI_REVIEW_GATE_DDGS_PYTHON for the extension.
 * - Refreshes the discoverable shipped skills under
 *   ~/.agents/skills/ (pi-review-gate-orchestrator with its recovery runbook,
 *   pi-review-gate-execution, and pi-review-gate-research; namespaced by
 *   issue 151) from the packaged sources, staged to temporary files and
 *   published with atomic renames so concurrent launches replace whole files
 *   only. On
 *   Windows the rename-replace can transiently fail with EPERM/EACCES/EBUSY
 *   while an external holder (an antivirus or indexing filter scanning
 *   freshly closed files) keeps the staged file or destination open, so the
 *   rename alone is retried with a short bounded backoff; every other error
 *   and every unsafe path still fails closed. After publication, prior
 *   generic install copies (pre-#151 orchestrator/execution/research) are
 *   removed only when proven to be unmodified package-owned files; anything
 *   else there is preserved untouched.
 * - Prints the same launch diagnostics and forwards all remaining arguments
 *   to `pi --extension <dist/src/index.js>`.
 *
 * POSIX permission modes (0700/0600/0644) are requested for parity and are a
 * no-op under Windows ACLs; the fail-closed publication structure is what the
 * launcher preserves. To keep forwarded arguments and paths byte-exact, the
 * helper never reparses them through a shell: publication runs in-process
 * (fs.linkSync / fs.renameSync), Python is spawned directly with argument
 * arrays, and pi/npm are executed by resolving their npm `.cmd` shim's
 * JavaScript entry point and spawning this Node binary directly (POSIX uses
 * plain execvp). The only cmd.exe pass left is the fixed-token development
 * build fallback. Management verbs are dispatched here before any setup, so
 * the .cmd entry point stays a thin single `%*` passthrough and every
 * argument — management or launch — avoids cmd re-parsing; cmd.exe itself
 * expands a literal %VAR% on the user's command line before the batch sees
 * it (the helper receives and forwards such arguments literally).
 *
 * Keep in sync with src/config-path.ts (Pi agent-dir semantics) and
 * scripts/ensure-ddgs.sh (DDGS provisioning); the mirrors are deliberate so
 * the launcher can resolve paths before dist exists.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DDGS_VERSION = "9.15.0";

/** The exact zero-model default the launcher writes on first launch (issue 32). */
const DEFAULT_CONFIG_CONTENT = `{
  "enabled": true,
  "review": {
    "activeReviewers": []
  },
  "externalAgents": {},
  "execution": {
    "workerResources": {},
    "routes": {
      "execute": [],
      "research": []
    }
  }
}
`;

// Mirrors the passthrough list in scripts/pi-review-gate.sh and the batch
// checks in scripts/pi-review-gate.cmd; keep all three in sync.
const MANAGEMENT_VERBS = new Set(["update", "install", "remove", "uninstall", "list", "config", "auth"]);

function out(text) {
  fs.writeSync(1, text);
}

function note(text) {
  fs.writeSync(2, text);
}

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
 * Transient Windows rename-contention errnos. On Windows, fs.renameSync is
 * MoveFileExW(..., MOVEFILE_REPLACE_EXISTING), which — unlike POSIX
 * rename(2)'s unconditional replacement — must open and delete both the
 * staged source and the destination; while anything holds either open
 * without FILE_SHARE_DELETE — briefly, as external file scanners (antivirus,
 * indexing filters) are known to do with freshly closed files — the move
 * fails with one of these errnos. (The PR112 Windows CI failure hit exactly
 * this rename under concurrent first launches; the specific errno and holder
 * could not be confirmed off Windows, so no single cause is claimed.)
 * Node itself
 * always opens files with FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
 * so plain concurrent launchers never block each other; only these brief
 * external holders do. Such contention clears on its own, so these — and
 * only these — errnos are retried with a bounded backoff (graceful-fs
 * practice); every other errno stays an immediate fail-closed publication
 * failure.
 */
const SKILL_PUBLISH_TRANSIENT_ERRNOS = new Set(["EPERM", "EACCES", "EBUSY"]);
const SKILL_PUBLISH_RETRY_ATTEMPTS = 5;
const SKILL_PUBLISH_RETRY_DELAY_MS = 50;

const skillPublishSleepSignal = new Int32Array(new SharedArrayBuffer(4));

/**
 * Move a staged file into place with rename-replace, retrying only the
 * transient Windows rename-contention errnos (see the constant above) while
 * the destination is not a directory: each retry re-runs the same single
 * atomic rename after a short bounded sleep, so a contended but normal
 * concurrent launch still publishes one complete whole file, and readers
 * never observe a missing or partially written file at any point. POSIX
 * rename(2) has no sharing violations, so no retry happens off win32. Every
 * other errno (including a directory occupying the destination), a
 * destination that turns out to be a directory, and exhaustion of the
 * bounded backoff fail closed immediately: nothing is published and the
 * caller receives the last error for its diagnostics. Only the rename step
 * is retried — staging, permissions, and validation errors are never
 * retried or masked.
 */
function renameIntoPlaceWithContentionRetry(rename, options = {}) {
  const attempts = options.attempts ?? SKILL_PUBLISH_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? SKILL_PUBLISH_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms) => {
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
      // The rename is the single atomic publication step: success means the
      // complete file is in place, however many contention retries it took.
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
      sleep(delayMs);
    }
  }
}

function joinForPlatform(platform, ...segments) {
  return (platform === "win32" ? path.win32 : path.posix).join(...segments);
}

/**
 * Convert Git Bash, MSYS, Cygwin, and WSL drive paths to the form native
 * Windows APIs accept. Parity with Pi's normalizeWindowsShellPath and
 * src/config-path.ts: a lone leading drive path such as /c/Users, /mnt/c/Users
 * or /cygdrive/c/Users becomes C:\Users; everything else is returned unchanged.
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
 * semantics when set to a non-empty value (tilde expansion against the
 * resolved home, plus Windows drive-path normalization on win32), otherwise
 * <homeDir>/.pi/agent. Mirror of piAgentDir() in src/config-path.ts.
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

/**
 * Sole implicit compatibility fallback: the historical XDG location. Only
 * selected when the Pi-agent default does not exist; never created by
 * initialization.
 */
function compatibilityFallbackConfigPath(resolution) {
  return joinForPlatform(resolution.platform, resolution.homeDir, ".config", "pi-review-gate", "config.json");
}

/**
 * Fail-closed candidate selection, mirroring select_review_gate_config in
 * scripts/pi-review-gate.sh: candidates are inspected in precedence order for
 * existence — including dangling symlinks — and any present candidate must be
 * a usable regular file. An invalid candidate is never bypassed in favor of a
 * lower-priority path or replaced by initialization.
 * Status codes: 0 = selected (path set), 3 = no candidate exists,
 * 1 = invalid candidate (diagnostics on stderr).
 */
function selectReviewGateConfig(candidates) {
  for (const candidate of candidates) {
    if (pathIsPresent(candidate)) {
      if (isUsableRegularFile(candidate)) return { status: 0, path: candidate };
      note(`pi-review-gate: ${candidate} exists but is not a regular file; refusing to continue\n`);
      note("pi-review-gate: move or rename that path, or create a config manually\n");
      return { status: 1 };
    }
  }
  return { status: 3 };
}

/**
 * First-launch initialization, mirroring initialize_default_review_gate_config
 * in scripts/pi-review-gate.sh: when neither candidate exists, create a
 * private zero-model default config at the default location and continue
 * normal startup. The compatibility fallback is never created. Initialization
 * never overwrites an existing or malformed config, never exposes partial JSON
 * at the final path, and never clobbers a config that a concurrent launch
 * created in the same window. Returns the selected path, or null after
 * writing fail-closed diagnostics.
 */
function initializeDefaultReviewGateConfig(primary, fallback) {
  const missing = [];

  // Re-check discovery: another launch (or the user) may have created a config
  // between the first pass and now. Preserve the same precedence and the same
  // fail-closed validity rule.
  for (const candidate of [primary, fallback]) {
    if (pathIsPresent(candidate)) {
      if (isUsableRegularFile(candidate)) return candidate;
      note(`pi-review-gate: ${candidate} appeared during initialization but is not a regular file; refusing to continue\n`);
      return null;
    }
  }

  const dir = path.dirname(primary);
  // Collect the missing directory levels (leaf first) without touching any
  // level that already exists, so pre-existing directories keep their mode.
  let probe = dir;
  for (;;) {
    if (isDirectory(probe)) break;
    missing.push(probe);
    const parent = path.dirname(probe);
    if (parent === probe) break;
    let parentPresent = false;
    try {
      fs.statSync(parent);
      parentPresent = true;
    } catch {
      parentPresent = false;
    }
    if (parentPresent && !isDirectory(parent)) {
      note(`pi-review-gate: ${parent} exists but is not a directory; cannot create ${dir} for the default config\n`);
      note(`pi-review-gate: move or rename that path, or create a config manually at ${primary} or ${fallback}\n`);
      return null;
    }
    probe = parent;
  }
  // Create top-down. Each level is created private from the instant of
  // creation (mode 0700; a umask can only remove bits), so no level ever
  // exists in a permissive state; if a concurrent launch wins the creation
  // race, mkdir fails with EEXIST and its permissions are left untouched.
  // On Windows the mode is a no-op under ACLs; the directory inherits the
  // profile's default (per-user) permissions.
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    const level = missing[index];
    try {
      fs.mkdirSync(level, { mode: 0o700 });
    } catch {
      if (isDirectory(level)) continue; // a concurrent launch created it; keep its mode
      note(`pi-review-gate: could not create directory ${level} (permission denied?); check write access to your home directory, or create a config manually at ${primary} or ${fallback}\n`);
      return null;
    }
  }

  if (pathIsPresent(primary)) {
    // It appeared after the discovery re-check; only a regular file is usable.
    if (isUsableRegularFile(primary)) return primary;
    note(`pi-review-gate: ${primary} exists but is not a regular file; refusing to initialize over it\n`);
    note(`pi-review-gate: move or rename that path, or create a config manually at ${fallback}\n`);
    return null;
  }

  const tmp = path.join(dir, `.config.json.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    // Exclusive create (mktemp semantics): the requested 0600 mode cannot be
    // widened by the umask, so the file is private from the instant of
    // creation.
    fd = fs.openSync(tmp, "wx", 0o600);
  } catch {
    note(`pi-review-gate: could not create a temporary file in ${dir} (permission denied?); check write access to your home directory, or create a config manually at ${primary} or ${fallback}\n`);
    return null;
  }
  try {
    fs.writeFileSync(fd, DEFAULT_CONFIG_CONTENT);
  } catch {
    fs.closeSync(fd);
    removeQuietly(tmp);
    note(`pi-review-gate: could not write the default config content to ${dir} (permission denied? or disk full?); create a config manually at ${primary} or ${fallback}\n`);
    return null;
  }
  fs.closeSync(fd);
  try {
    // Mirrors the launcher's explicit chmod: the published path must be
    // private even when the creation umask stripped bits.
    fs.chmodSync(tmp, 0o600);
  } catch {
    removeQuietly(tmp);
    note("pi-review-gate: could not set private permissions on the new default config; refusing to continue with a non-private config file\n");
    return null;
  }

  // Publish atomically with exact-destination link(2) semantics (Node's
  // fs.linkSync): the call fails when the target already exists in any form —
  // file, directory, or symlink — so a concurrent first launch can never be
  // clobbered and the final path never holds partial JSON.
  try {
    fs.linkSync(tmp, primary);
    removeQuietly(tmp);
    note(`pi-review-gate: no persistent config found; created default zero-model config at ${primary}\n`);
    note("pi-review-gate: no reviewers or workers are selected yet; configure them with /review-settings\n");
    return primary;
  } catch {
    removeQuietly(tmp);
  }
  if (isUsableRegularFile(primary)) {
    // A concurrent launch won the race; its config is authoritative from here.
    return primary;
  }
  if (pathIsPresent(primary)) {
    note(`pi-review-gate: ${primary} appeared during initialization but is not a regular file; refusing to continue\n`);
    return null;
  }
  note(`pi-review-gate: unexpected failure publishing the default config to ${primary} (the target path changed mid-initialization?); re-run the launcher or create a config manually at ${primary}\n`);
  return null;
}

function removeQuietly(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // rm -f parity: a missing or already-removed temporary file is fine.
  }
}

/**
 * Quote one argument for a cmd.exe command line: bare when it carries no
 * special characters, otherwise wrapped in double quotes with embedded quotes
 * DOUBLED (cmd toggles its quote state at every quote character and does not
 * honor backslash escaping, so \"-style escaping would end cmd's quoted region
 * and let & | < > ( ) ^ operate; "" keeps cmd inside quotes while the
 * receiving program's argv parser reads the pair as one literal quote).
 * Backslash runs immediately before a quote or the closing quote are doubled
 * for the argv parser's backslash-quote rule. This is used only for the
 * fixed-token build fallback; a literal %VAR% would still be expanded by cmd.
 */
function cmdQuote(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  const escaped = arg
    .replace(/"/g, '""')
    .replace(/(\\+)(?="|$)/g, "$1$1");
  return `"${escaped}"`;
}

/**
 * Find an executable on PATH for a bare program name, trying extensions in
 * PATHEXT-like order (exe before cmd).
 */
function findOnPath(name, extensions, pathEnv = process.env.PATH || "") {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = joinForPlatform(process.platform, dir, `${name}${extension}`);
      if (isUsableRegularFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the JavaScript entry point an npm-generated Windows batch shim
 * (pi.cmd, npm.cmd) refers to, so the launcher can spawn it through this Node
 * binary with an argument array instead of reparsing arguments through
 * cmd.exe. npm shims reference the target as a quoted "%dp0%"-relative path;
 * the last such token ending in .js/.cjs wins.
 */
function resolveCmdShimTarget(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const matches = [...content.matchAll(/"%(?:dp0|~dp0)%([^"\r\n]*)"/g)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const relative = matches[index][1];
    if (!/\.(?:c?js)$/i.test(relative)) continue;
    // Backslashes are normalized to slashes so the same resolver is
    // verifiable off Windows; the shim's reference is relative to its own
    // directory ("%dp0%"), so a leading separator is stripped before join.
    const relativeHost = relative.replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.normalize(path.join(path.dirname(shimPath), relativeHost));
    if (isUsableRegularFile(target)) return target;
  }
  return null;
}

/**
 * Decide how to execute pi without reparsing arguments through a shell:
 * - POSIX: plain execvp of `pi` (the PATH entry; scripts with shebangs work).
 * - Windows: the installed pi.exe directly, or the npm pi.cmd shim's resolved
 *   JavaScript entry point through this Node binary.
 * No fallback through cmd.exe exists for user-supplied arguments: when the
 * shim cannot be resolved, the launcher fails closed with a diagnostic.
 */
function resolvePiInvocation(env, platform) {
  if (platform !== "win32") return { kind: "path" };
  const pathEnv = env.PATH || "";
  const exe = findOnPath("pi", [".exe"], pathEnv);
  if (exe) return { kind: "direct", file: exe };
  const shim = findOnPath("pi", [".cmd"], pathEnv);
  if (shim) {
    const target = resolveCmdShimTarget(shim);
    if (target) return { kind: "node", file: target };
    return { kind: "unresolved", shim };
  }
  return { kind: "missing" };
}

/**
 * Execute pi with the given arguments (with or without the extension flag),
 * inheriting the environment and stdio, and return pi's exit status.
 */
function launchPi(argv, extensionPath, env) {
  const forwarded = extensionPath ? ["--extension", extensionPath, ...argv] : [...argv];
  const invocation = resolvePiInvocation(env, process.platform);
  let result;
  if (invocation.kind === "direct") {
    result = spawnSync(invocation.file, forwarded, { stdio: "inherit", env });
  } else if (invocation.kind === "node") {
    result = spawnSync(process.execPath, [invocation.file, ...forwarded], { stdio: "inherit", env });
  } else if (invocation.kind === "path") {
    result = spawnSync("pi", forwarded, { stdio: "inherit", env });
  } else if (invocation.kind === "unresolved") {
    note(`pi-review-gate: could not resolve the pi entry point from the npm shim at ${invocation.shim}; reinstall Pi (npm install -g @earendil-works/pi) or launch it directly with --extension ${extensionPath ?? "(none requested)"}\n`);
    return 127;
  } else {
    note("pi-review-gate: pi was not found on PATH; install Pi (npm install -g @earendil-works/pi) and re-run the launcher\n");
    return 127;
  }
  if (result.error) {
    note(`pi-review-gate: could not execute pi (${result.error.message})\n`);
    return 127;
  }
  return result.status ?? 1;
}

/**
 * Development launch rebuild: run the package's build script through npm with
 * --prefix anchored to this checkout, without reparsing user arguments
 * (there are none: the command tokens are fixed and only the root is
 * substituted).
 */
function buildExtension(root) {
  if (process.platform === "win32") {
    const shim = findOnPath("npm", [".cmd"]);
    if (shim) {
      const entry = resolveCmdShimTarget(shim);
      if (entry) {
        return spawnSync(process.execPath, [entry, "--prefix", root, "run", "build"], { stdio: "inherit" });
      }
    }
    // Fallback for exotic npm installations: fixed tokens plus one quoted
    // path (quotes are illegal in Windows file names, so the path cannot
    // break cmd's quoted region; a % in the install path would be expanded by
    // cmd — visible corruption, never attacker-controlled).
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `npm --prefix ${cmdQuote(root)} run build`], { stdio: "inherit" });
  }
  return spawnSync("npm", ["--prefix", root, "run", "build"], { stdio: "inherit" });
}

/**
 * DDGS python executable for a virtual environment, mirroring the platform
 * venv layout (Scripts\python.exe on Windows, bin/python elsewhere) that
 * `python -m venv` creates.
 */
function ddgsPythonPath(venv, platform) {
  return joinForPlatform(platform, venv, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
}

/**
 * Provision the pinned DDGS dependency, mirroring scripts/ensure-ddgs.sh:
 * create the virtual environment when its python is missing, validate the
 * installed version and dependency consistency in isolated mode, install the
 * pinned wheel-only distribution when invalid, and revalidate. Returns
 * { ok: true, python } with the interpreter to export as
 * PI_REVIEW_GATE_DDGS_PYTHON, or { ok: false, exitCode } after writing
 * fail-closed diagnostics.
 */
function ensureDdgs(homeDir, env) {
  const platform = process.platform;
  // Cache-root parity with scripts/ensure-ddgs.sh: ${XDG_CACHE_HOME:-$HOME/.cache}
  // + /pi-review-gate, with the pinned venv as the default member of that
  // dedicated cache directory. An explicit PI_REVIEW_GATE_DDGS_VENV still wins.
  const cacheRoot = joinForPlatform(
    platform,
    env.XDG_CACHE_HOME || joinForPlatform(platform, homeDir, ".cache"),
    "pi-review-gate",
  );
  const venv = env.PI_REVIEW_GATE_DDGS_VENV || joinForPlatform(platform, cacheRoot, `ddgs-${DDGS_VERSION}`);
  const python = ddgsPythonPath(venv, platform);

  if (!fs.existsSync(python)) {
    note(`pi-review-gate: creating DDGS ${DDGS_VERSION} environment\n`);
    try {
      fs.mkdirSync(cacheRoot, { recursive: true });
    } catch (error) {
      note(`pi-review-gate: could not create the DDGS cache directory ${cacheRoot} (${error.message})\n`);
      return { ok: false, exitCode: 1 };
    }
    const interpreter = findPythonInterpreter();
    if (!interpreter) {
      note("pi-review-gate: Python 3 is required to provision the DDGS web-search dependency (install Python 3.9 or newer and put it on PATH)\n");
      return { ok: false, exitCode: 1 };
    }
    // Every Python invocation below runs in isolated mode (-I) with argument
    // arrays and no shell: Python must not place the launcher's working
    // directory (which may be an untrusted reviewed repository) on sys.path.
    const created = spawnSync(interpreter, ["-I", "-m", "venv", venv], { stdio: "inherit" });
    if ((created.status ?? 1) !== 0) {
      note(`pi-review-gate: could not create the DDGS ${DDGS_VERSION} virtual environment at ${venv}\n`);
      return { ok: false, exitCode: created.status ?? 1 };
    }
  }

  // Isolated-mode validation mirroring ddgs_environment_is_valid: the pinned
  // version must be importable and the dependency graph consistent.
  const DDGS_VERSION_CHECK = "import ddgs, importlib.metadata as metadata, sys; sys.exit(0 if metadata.version('ddgs') == sys.argv[1] else 1)";
  const isValid = () => {
    const versionCheck = spawnSync(python, ["-I", "-c", DDGS_VERSION_CHECK, DDGS_VERSION], { stdio: "ignore" });
    if ((versionCheck.status ?? 1) !== 0) return false;
    const pipCheck = spawnSync(python, ["-I", "-m", "pip", "check"], { stdio: "ignore" });
    return (pipCheck.status ?? 1) === 0;
  };

  if (!isValid()) {
    note(`pi-review-gate: installing DDGS ${DDGS_VERSION}\n`);
    // These resolver options apply to DDGS and its full transitive dependency
    // graph; pip failing keeps the launcher from continuing with a bad venv
    // (set -e parity: exit with the install's own status).
    const install = spawnSync(python, [
      "-I", "-m", "pip", "install",
      "--disable-pip-version-check", "--no-cache-dir", "--no-input",
      "--only-binary=:all:", "--quiet", "--upgrade", "--upgrade-strategy", "eager",
      `ddgs==${DDGS_VERSION}`,
    ], { stdio: "inherit" });
    if ((install.status ?? 1) !== 0) return { ok: false, exitCode: install.status ?? 1 };
  }
  if (!isValid()) {
    note(`pi-review-gate: DDGS ${DDGS_VERSION} is unavailable or has inconsistent dependencies; refusing to continue\n`);
    return { ok: false, exitCode: 1 };
  }
  return { ok: true, python };
}

/**
 * Probe a usable isolated-mode Python 3 interpreter: python3 first (parity
 * with scripts/ensure-ddgs.sh), then python — on Windows python3 is often the
 * Microsoft Store alias, which exits non-zero for real arguments.
 */
function findPythonInterpreter() {
  for (const candidate of ["python3", "python"]) {
    // Direct spawn with an argument array: PATH resolution happens in the
    // platform's loader (execvp / SearchPathW), never through a shell, so the
    // probe result depends only on the interpreter's own exit status.
    const probe = spawnSync(candidate, ["-I", "-c", "import sys"], { stdio: "ignore" });
    if (!probe.error && (probe.status ?? 1) === 0) return candidate;
  }
  return null;
}

/**
 * Skill provisioning manifest (issue 23): every shipped skill file with its
 * installed destination relative to ~/.agents/skills/<name>. Keep in sync with
 * SKILL_PUBLISH_PLAN in scripts/pi-review-gate.sh.
 */
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
];

/**
 * One-time migration manifest for the pre-#151 generic install locations
 * (issue 151). Each entry names the
 * prior generic installed file (relative to ~/.agents/skills), the packaged
 * copy that replaced it, and the recorded namespacing edits ("old -> new")
 * that turned the prior generic copy into the packaged copy.
 *
 * Ownership proof: the installed file is compared against the EXPECTED
 * HISTORICAL BYTES by digest — its own SHA-256 must equal `historicalSha256`,
 * the digest of the true pre-#151 package-owned bytes, which are preserved as
 * immutable fixtures under tests/fixtures/skill-migration/ (mirroring the
 * generic install layout). The installed content is never normalized or
 * transformed: a transform before comparing would be non-injective and could
 * classify customized content (for example a file that already carries the
 * namespaced name, or a partially namespaced orchestrator) as unmodified. An
 * exact digest match positively identifies an unmodified package-owned copy
 * from before the namespacing and nothing else; any deviation — modified,
 * ambiguous, or user-owned content, a directory, a dangling symlink, anything
 * unreadable — fails to match and is preserved untouched, as is every
 * unrelated file under the old directories: the generic name or path alone is
 * never treated as ownership. Only whole files from this manifest are ever
 * removed; directories are never touched.
 *
 * Matching deliberately does NOT reconstruct historical bytes from the current
 * packaged text: that derivation silently stops matching once any later
 * release edits a shipped skill file (as issue 179 did), degrading genuine old
 * installs to preservation forever. Anchoring on the immutable digest keeps
 * old-install migration working across future shipped-skill edits; the
 * fixtures and their digests are the identity, and the shipped-skills test
 * enforces that coupling so drift cannot pass silently.
 *
 * `renames` is documentary only: it records the namespacing diff between the
 * historical copy and the first namespaced release for human readers. The
 * matching algorithm never applies it.
 *
 * `pairedWith` (optional) names another manifest entry whose proven removal
 * is a precondition: the orchestrator recovery.md is removed only when the
 * sibling generic orchestrator SKILL.md was proven unmodified and actually
 * removed in the same run, so a customized (preserved) generic SKILL.md never
 * loses the recovery runbook its links still point at.
 *
 * This manifest is the single canonical migration identity set;
 * scripts/pi-review-gate.sh invokes it through the --migrate-prior-skill-files
 * mode below (passing the home directory it published skills under) instead
 * of carrying a second copy of the data or the algorithm.
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
 * Delete proven unmodified package-owned copies at the prior generic
 * locations. The installed content is never transformed: its own SHA-256 must
 * equal the entry's recorded historical digest — the immutable identity of
 * the true pre-#151 package-owned bytes — and only that exact match, a
 * positively identified pre-namespacing package-owned copy, is removed.
 * Anything else — modified or user-owned content, a directory, a dangling
 * symlink, anything unreadable — is left in place. Entries with `pairedWith`
 * are removed only when the paired entry was proven and actually removed
 * earlier in this same pass, so a preserved (customized) generic orchestrator
 * SKILL.md keeps its recovery.md. Best effort and fail-safe: any read,
 * comparison, or removal error preserves the file, because deleting user
 * content is never the safe direction.
 */
function migrateGenericSkillFiles(homeDir, platform = process.platform) {
  const provenRemovals = new Set();
  const skillsRoot = joinForPlatform(platform, homeDir, ".agents", "skills");
  const dirnameFor = platform === "win32" ? path.win32.dirname : path.posix.dirname;
  for (const entry of SKILL_MIGRATION_PLAN) {
    const installedPath = joinForPlatform(platform, homeDir, ".agents", "skills", ...entry.installed);
    // Never delete through a symlink: a legacy path — or any directory below
    // the skills root — that the user aliased to the namespaced location
    // (for example ~/.agents/skills/orchestrator ->
    // pi-review-gate-orchestrator) would make the unlink below resolve the
    // alias and remove the freshly published namespaced file itself, and a
    // symlinked legacy file is user-owned indirection that no content match
    // makes ours. Walk every component between the installed path and the
    // skills root (not just the direct parent, so a recovery.md entry
    // reached through an aliased legacy directory is caught too) and
    // preserve everything when any is a symlink or cannot be inspected
    // (fail safe).
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
    // A paired entry (the orchestrator recovery.md) is removed only when its
    // paired file was proven unmodified and actually removed earlier in this
    // same pass: a preserved generic orchestrator SKILL.md may still link to
    // the generic recovery.md, and deleting that support file under a
    // customized skill is never the safe direction.
    if (entry.pairedWith) {
      const pairedPath = joinForPlatform(platform, homeDir, ".agents", "skills", ...entry.pairedWith);
      if (!provenRemovals.has(pairedPath)) continue;
    }
    let installed;
    try {
      installed = fs.readFileSync(installedPath);
    } catch {
      continue; // missing, unreadable, or a directory: nothing proven to remove
    }
    // The installed bytes must hash to the entry's recorded historical digest.
    // That digest is the immutable identity of the true pre-#151 package-owned
    // bytes (preserved under tests/fixtures/skill-migration/), so an exact
    // match positively identifies an unmodified prior copy and nothing else.
    // The check never depends on the current packaged text — later releases
    // may edit shipped skill files without changing what a genuine old install
    // looks like — and no transform of the installed content is ever applied,
    // so customized, ambiguous, or user-owned bytes can only ever fail to
    // match (preservation), never match wrongly.
    let matchesRecordedIdentity = false;
    try {
      matchesRecordedIdentity =
        crypto.createHash("sha256").update(installed).digest("hex") === entry.historicalSha256;
    } catch {
      matchesRecordedIdentity = false;
    }
    if (matchesRecordedIdentity) {
      removeQuietly(installedPath);
      // removeQuietly swallows unlink errors; the note must claim removal
      // only when the prior copy is actually gone, and the pairing gate
      // above must only trust removals that actually happened.
      if (!fs.existsSync(installedPath)) {
        provenRemovals.add(installedPath);
        note(`pi-review-gate: removed the unmodified prior copy at ${installedPath} (the shipped skills are now provisioned under the pi-review-gate- namespace)\n`);
      }
    }
  }
}

/**
 * Publish one shipped skill file atomically, mirroring
 * publish_skill_file in scripts/pi-review-gate.sh: the content is
 * staged in a temporary file inside the destination directory and moved into
 * place with an atomic rename (fs.renameSync). rename() replaces an existing
 * regular destination in a single step, so concurrent launches publishing the
 * same skill cannot fail over each other, and readers never observe a missing
 * or partially written skill file. A destination directory is rejected instead
 * of published into. On Windows the rename alone can transiently fail while
 * anything briefly holds the staged file or destination open (external
 * file scanners are a known such holder; see
 * renameIntoPlaceWithContentionRetry); only that step is retried, and every
 * staging, permission, and unexpected failure still fails closed with the
 * underlying filesystem error reported.
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
  // Set the final mode before the rename so the published path never exists
  // in any other state (POSIX no-op under Windows ACLs).
  try {
    fs.chmodSync(tmp, 0o644);
  } catch {
    removeQuietly(tmp);
    note(`pi-review-gate: could not set permissions on the staged skill file in ${dir}; refusing to continue\n`);
    return false;
  }
  // Atomic rename with exact whole-file replacement semantics: rename()
  // replaces an existing regular destination in a single step, so concurrent
  // launches publishing the same skill cannot fail over each other and
  // readers never observe a missing or partially written skill file. Only the
  // rename is retried, and only for the transient Windows contention errnos
  // with a bounded backoff; a recovered publication is reported on stderr so
  // the contention stays visible, and any final failure keeps the original
  // fail-closed diagnostics — now including the underlying OS error.
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

/**
 * Refresh a shipped skill file only when the installed file is missing or
 * differs from the source (cmp -s parity).
 */
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
 * Main entry: argv are the forwarded pi arguments (the .cmd passes %*).
 * Returns the process exit status. Mirrors scripts/pi-review-gate.sh end to
 * end (management verbs aside, which the .cmd entry point forwards itself).
 */
function main(argv) {
  const root = path.resolve(__dirname, "..");
  const extensionPath = joinForPlatform(process.platform, root, "dist", "src", "index.js");
  const resolution = { homeDir: os.homedir(), platform: process.platform };

  // Issue #26: --scheduler enables the process-local scheduled-execution
  // runtime for this launch only. The flag is consumed here and handed to the
  // extension through PI_REVIEW_GATE_SCHEDULER; it is never forwarded to pi,
  // which would reject the unknown option. Processes started without the flag
  // start Off (the live /review-settings toggle can still turn them on). An
  // inherited PI_REVIEW_GATE_SCHEDULER (e.g. from a parent launched with
  // --scheduler) is cleared before parsing so the explicit opt-in contract
  // holds for nested and fresh launches: the variable reaches pi only when
  // THIS launch passed the flag.
  const forwardedArgs = [];
  let schedulerEnabled = false;
  for (const arg of argv) {
    if (arg === "--scheduler") schedulerEnabled = true;
    else forwardedArgs.push(arg);
  }
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  if (schedulerEnabled) process.env.PI_REVIEW_GATE_SCHEDULER = "1";

  // Deliberate environment sanitization (POSIX launcher parity): the
  // persistent config is re-resolved below and re-exported, so an inherited
  // PI_REVIEW_GATE_CONFIG (e.g. from a parent pi session) cannot silently
  // redirect the gate to another config file. PI_REVIEW_GATE_DISABLED and
  // PI_CODING_AGENT_DIR are deliberately NOT deleted (see the module comment).
  delete process.env.PI_REVIEW_GATE_CONFIG;

  const primary = piAgentConfigPath(process.env, resolution);
  const fallback = compatibilityFallbackConfigPath(resolution);

  const selection = selectReviewGateConfig([primary, fallback]);
  let selected;
  if (selection.status === 0) {
    selected = selection.path;
  } else if (selection.status === 3) {
    selected = initializeDefaultReviewGateConfig(primary, fallback);
    if (!selected) return 2;
  } else {
    return 2; // invalid candidate; diagnostics already on stderr
  }

  if (isUsableRegularFile(joinForPlatform(process.platform, root, "src", "index.ts"))) {
    // Normal development launch: rebuild dist each time (npm --prefix keeps
    // the build anchored to this checkout). A failure must stop the launch so
    // a stale extension is never started.
    const build = buildExtension(root);
    if (build.error) {
      note(`pi-review-gate: could not run the extension build (${build.error.message})\n`);
      return 127;
    }
    if (build.status !== 0) return build.status ?? 1;
  } else if (!isUsableRegularFile(extensionPath)) {
    note(`pi-review-gate: packaged extension is missing: ${extensionPath}\n`);
    return 2;
  }

  const ddgs = ensureDdgs(resolution.homeDir, process.env);
  if (!ddgs.ok) return ddgs.exitCode;
  process.env.PI_REVIEW_GATE_DDGS_PYTHON = ddgs.python;

  // Fail closed before any publication when a packaged skill file is missing.
  for (const skill of SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = joinForPlatform(process.platform, root, ...file.source);
      if (!isUsableRegularFile(source)) {
        note(`pi-review-gate: packaged skill file is missing: ${source}\n`);
        return 2;
      }
    }
  }
  for (const skill of SKILL_PUBLISH_PLAN) {
    const skillDir = joinForPlatform(resolution.platform, resolution.homeDir, ".agents", "skills", skill.name);
    for (const file of skill.files) {
      const source = joinForPlatform(process.platform, root, ...file.source);
      const destination = joinForPlatform(process.platform, skillDir, ...file.destination);
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
      } catch {
        return 2;
      }
      if (!refreshSkillFile(source, destination)) {
        return 2;
      }
    }
    out(`pi-review-gate ${skill.label} skill: ${joinForPlatform(resolution.platform, skillDir, "SKILL.md")}\n`);
  }

  // Ownership-safe migration of the pre-#151 generic install locations
  // (issue 151), only after every namespaced skill published successfully.
  migrateGenericSkillFiles(resolution.homeDir);

  // The exported path is already the native Windows form (the helper runs on
  // native Windows); off Windows it is the platform's own form.
  process.env.PI_REVIEW_GATE_CONFIG = selected;

  // Same truthy values the extension uses (loadConfig/firstTruthyEnv in
  // src/config.ts): warn loudly when the kill switch is on. Keep this list in
  // sync with isTruthy there and with scripts/pi-review-gate.sh.
  const disabled = process.env.PI_REVIEW_GATE_DISABLED;
  if (disabled === "1" || disabled === "true" || disabled === "yes") {
    out("pi-review-gate: PI_REVIEW_GATE_DISABLED is set; the review gate will not activate\n");
  }

  out(`pi-review-gate config: ${selected}\n`);
  out(`pi-review-gate extension: ${extensionPath}\n`);

  // Execute pi with the extension and the forwarded arguments, inheriting the
  // sanitized environment and stdio; the helper's exit status is pi's. pi is
  // spawned without any shell reparse of the arguments (see launchPi).
  return launchPi(forwardedArgs, extensionPath, process.env);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--migrate-prior-skill-files") {
    // Dedicated migration-only invocation: scripts/pi-review-gate.sh runs
    // this mode after publishing the namespaced skills so the pre-#151
    // generic-location migration has exactly one canonical implementation
    // (manifest and matching algorithm) shared by both launchers. The POSIX
    // launcher passes the home directory it published skills under (its own
    // $HOME, which under MSYS may legitimately differ from Node's
    // os.homedir()/USERPROFILE); without an argument the native Windows
    // helper semantics apply (os.homedir()). The migration is best effort
    // and fail-safe by contract, so the exit status is always 0; nothing
    // here may abort a launch that already published.
    migrateGenericSkillFiles(argv[1] || os.homedir());
    process.exitCode = 0;
  } else if (argv.length > 0 && MANAGEMENT_VERBS.has(argv[0])) {
    // Direct helper invocation (the .cmd entry point forwards %* here
    // unconditionally): management verbs are forwarded to pi untouched, with
    // the inherited environment and no setup, mirroring the POSIX launcher's
    // early passthrough — and, unlike a `call pi %*` batch dispatch, without
    // any cmd re-parsing of carets or percent expansions.
    process.exitCode = launchPi(argv, null, process.env);
  } else {
    process.exitCode = main(argv) ?? 0;
  }
}

module.exports = {
  DDGS_VERSION,
  MANAGEMENT_VERBS,
  SKILL_MIGRATION_PLAN,
  SKILL_PUBLISH_RETRY_ATTEMPTS,
  SKILL_PUBLISH_RETRY_DELAY_MS,
  cmdQuote,
  compatibilityFallbackConfigPath,
  ddgsPythonPath,
  initializeDefaultReviewGateConfig,
  normalizeWindowsShellPath,
  piAgentConfigPath,
  renameIntoPlaceWithContentionRetry,
  migrateGenericSkillFiles,
  resolveCmdShimTarget,
  resolvePiAgentDir,
  resolvePiInvocation,
  selectReviewGateConfig,
};