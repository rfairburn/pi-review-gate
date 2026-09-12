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
 * - Refreshes the discoverable orchestrator skill at
 *   ~/.agents/skills/orchestrator/SKILL.md (and its recovery runbook) from
 *   the packaged sources, staged to a temporary file and published with an
 *   atomic rename so concurrent launches replace whole files only.
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
  "execution": {
    "workerResources": [],
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
  const cacheRoot = env.XDG_CACHE_HOME || path.join(homeDir, ".cache");
  const venv = env.PI_REVIEW_GATE_DDGS_VENV || path.join(cacheRoot, `ddgs-${DDGS_VERSION}`);
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
 * Publish one orchestrator skill file atomically, mirroring
 * publish_orchestrator_skill_file in scripts/pi-review-gate.sh: the content is
 * staged in a temporary file inside the destination directory and moved into
 * place with an atomic rename (fs.renameSync). rename() replaces an existing
 * regular destination in a single step, so concurrent launches publishing the
 * same skill cannot fail over each other, and readers never observe a missing
 * or partially written skill file. A destination directory is rejected instead
 * of published into.
 */
function publishOrchestratorSkillFile(skillSource, skillDestination) {
  const dir = path.dirname(skillDestination);
  const tmp = path.join(dir, `.skill-publish.${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o644);
  } catch {
    note(`pi-review-gate: could not create a temporary file in ${dir} (permission denied?); the orchestrator skill cannot be published to ${skillDestination}\n`);
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
    note(`pi-review-gate: could not set permissions on the staged orchestrator skill file in ${dir}; refusing to continue\n`);
    return false;
  }
  // Atomic rename with exact whole-file replacement semantics: rename()
  // replaces an existing regular destination in a single step, so concurrent
  // launches publishing the same skill cannot fail over each other and
  // readers never observe a missing or partially written skill file.
  try {
    fs.renameSync(tmp, skillDestination);
    return true;
  } catch {
    removeQuietly(tmp);
    if (isDirectory(skillDestination)) {
      note(`pi-review-gate: ${skillDestination} exists but is not a replaceable regular file (a directory appeared there?); move or rename that path and re-run the launcher\n`);
    } else {
      note(`pi-review-gate: unexpected failure publishing the orchestrator skill to ${skillDestination}; re-run the launcher\n`);
    }
    return false;
  }
}

/**
 * Refresh the orchestrator skill only when the installed file is missing or
 * differs from the source (cmp -s parity).
 */
function refreshOrchestratorSkillFile(skillSource, skillDestination) {
  try {
    const installed = fs.readFileSync(skillDestination);
    if (installed.equals(fs.readFileSync(skillSource))) return true;
  } catch {
    // Missing or unreadable destination: republish below.
  }
  return publishOrchestratorSkillFile(skillSource, skillDestination);
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

  const orchestratorSkillSource = joinForPlatform(process.platform, root, "skills", "orchestrator", "SKILL.md");
  const orchestratorRecoverySource = joinForPlatform(
    process.platform, root, "skills", "orchestrator", "references", "recovery.md",
  );
  const orchestratorSkillDir = joinForPlatform(resolution.platform, resolution.homeDir, ".agents", "skills", "orchestrator");
  if (!isUsableRegularFile(orchestratorSkillSource)) {
    note(`pi-review-gate: packaged orchestrator skill is missing: ${orchestratorSkillSource}\n`);
    return 2;
  }
  if (!isUsableRegularFile(orchestratorRecoverySource)) {
    note(`pi-review-gate: packaged orchestrator recovery reference is missing: ${orchestratorRecoverySource}\n`);
    return 2;
  }
  try {
    fs.mkdirSync(joinForPlatform(process.platform, orchestratorSkillDir, "references"), { recursive: true });
  } catch {
    return 2;
  }
  if (!refreshOrchestratorSkillFile(orchestratorSkillSource, joinForPlatform(process.platform, orchestratorSkillDir, "SKILL.md"))) {
    return 2;
  }
  if (!refreshOrchestratorSkillFile(
    orchestratorRecoverySource,
    joinForPlatform(process.platform, orchestratorSkillDir, "references", "recovery.md"),
  )) {
    return 2;
  }

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
  out(`pi-review-gate orchestrator skill: ${joinForPlatform(process.platform, orchestratorSkillDir, "SKILL.md")}\n`);

  // Execute pi with the extension and the forwarded arguments, inheriting the
  // sanitized environment and stdio; the helper's exit status is pi's. pi is
  // spawned without any shell reparse of the arguments (see launchPi).
  return launchPi(argv, extensionPath, process.env);
}

if (require.main === module) {
  // Direct helper invocation (the .cmd entry point forwards %* here
  // unconditionally): management verbs are forwarded to pi untouched, with
  // the inherited environment and no setup, mirroring the POSIX launcher's
  // early passthrough — and, unlike a `call pi %*` batch dispatch, without
  // any cmd re-parsing of carets or percent expansions.
  const argv = process.argv.slice(2);
  process.exitCode = argv.length > 0 && MANAGEMENT_VERBS.has(argv[0])
    ? launchPi(argv, null, process.env)
    : main(argv) ?? 0;
}

module.exports = {
  DDGS_VERSION,
  MANAGEMENT_VERBS,
  cmdQuote,
  compatibilityFallbackConfigPath,
  ddgsPythonPath,
  initializeDefaultReviewGateConfig,
  normalizeWindowsShellPath,
  piAgentConfigPath,
  resolveCmdShimTarget,
  resolvePiAgentDir,
  resolvePiInvocation,
  selectReviewGateConfig,
};