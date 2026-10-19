"use strict";

/*
 * Native Windows entry point for the persistent pi-review-gate launcher
 * (issue 108), plus the shared Pi-launch resolver both the helper and the
 * extension use.
 *
 * Since issue 344 this helper owns NO freshness, build, DDGS, or skill logic:
 * scripts/prepare-application.cjs decides whether the prepared application is
 * current (a fraction of a second on a warm start), prepares it automatically
 * only on a genuine miss, and returns the compiled root plus the ready DDGS
 * interpreter and skill paths. The POSIX launcher shares exactly the same
 * authority, so no wrapper maintains an independent update algorithm.
 *
 * This file keeps only the Pi-specific concerns:
 * - Pi management verbs pass straight through to pi with no setup at all.
 * - The persistent config is re-resolved (an inherited PI_REVIEW_GATE_CONFIG
 *   is dropped, PI_REVIEW_GATE_DISABLED and PI_CODING_AGENT_DIR are honored)
 *   and a private zero-model default is published atomically on first launch.
 * - --scheduler is consumed into PI_REVIEW_GATE_SCHEDULER and the codemode
 *   default is exported, both for normal launches only.
 * - pi itself is spawned through the resolver that also serves Pi child
 *   processes: a native pi.exe directly, or the resolved pi.cmd through the
 *   parent's validated absolute SystemRoot\System32\cmd.exe. Pi's shim is
 *   never inspected, and normal batch parsing applies.
 * - A consumer lease keeps a running launch's prepared generation alive while
 *   another checkout of the same agent directory prepares an update.
 *
 * Keep the Pi agent-directory semantics in sync with src/config-path.ts; the
 * shared implementation lives in scripts/prepare-application.cjs.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const prepare = require("./prepare-application.cjs");

const { joinForPlatform } = prepare;
const DDGS_VERSION = prepare.DDGS_VERSION;

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

// Mirrors the passthrough list the POSIX launcher applies: Pi package
// management plus Pi 1.0's native `pi mcp` management, which remains Pi-owned.
const MANAGEMENT_VERBS = new Set(["update", "install", "remove", "uninstall", "list", "config", "auth", "mcp"]);

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

function removeQuietly(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // rm -f parity: a missing or already-removed temporary file is fine.
  }
}

/**
 * Fail-closed candidate selection: candidates are inspected in precedence order
 * for existence — including dangling symlinks — and any present candidate must
 * be a usable regular file. An invalid candidate is never bypassed in favor of a
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
 * First-launch initialization: when neither candidate exists, create a private
 * zero-model default config at the default location and continue normal
 * startup. The compatibility fallback is never created. Initialization never
 * overwrites an existing or malformed config, never exposes partial JSON at the
 * final path, and never clobbers a config that a concurrent launch created in
 * the same window. Returns the selected path, or null after writing fail-closed
 * diagnostics.
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
    // Mirrors the explicit chmod: the published path must be private even when
    // the creation umask stripped bits.
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

/**
 * Quote one argument for a cmd.exe command line: bare when it carries no
 * special characters, otherwise wrapped in double quotes with embedded quotes
 * DOUBLED (cmd toggles its quote state at every quote character and does not
 * honor backslash escaping, so \"-style escaping would end cmd's quoted region
 * and let & | < > ( ) ^ operate; "" keeps cmd inside quotes while the
 * receiving program's argv parser reads the pair as one literal quote).
 * Backslash runs immediately before a quote or the closing quote are doubled
 * for the argv parser's backslash-quote rule.
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

/** Resolve the default Pi executable without inspecting a .cmd shim. */
function resolvePiInvocation(env, platform) {
  if (platform !== "win32") return { kind: "path" };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const pathEnv = env.PATH ?? (pathKey ? env[pathKey] : "") ?? "";
  const exe = findOnPath("pi", [".exe"], pathEnv);
  if (exe) return { kind: "direct", file: path.resolve(exe) };
  const shim = findOnPath("pi", [".cmd"], pathEnv);
  if (shim) return { kind: "cmd", file: path.resolve(shim) };
  return { kind: "missing" };
}

/** Return whether a path has a fully qualified Windows drive or UNC root. */
function isFullyQualifiedWindowsPath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) return false;
  const normalized = path.win32.normalize(candidate);
  if (!path.win32.isAbsolute(normalized)) return false;
  const root = path.win32.parse(normalized).root;
  return /^[a-z]:\\$/i.test(root)
    || /^\\\\[^\\]+\\[^\\]+\\$/.test(root)
    || /^\\\\\?\\[a-z]:\\$/i.test(root)
    || /^\\\\\?\\UNC\\[^\\]+\\[^\\]+\\$/i.test(root);
}

/**
 * Resolve only the parent's OS-provided SystemRoot. The supplied child env,
 * ComSpec, PATH, and working directory are deliberately irrelevant: a default
 * Pi batch shim must never select its interpreter from any of them.
 */
function resolveTrustedWindowsCmd() {
  const systemRootKey = Object.keys(process.env).find((key) => key.toLowerCase() === "systemroot");
  const systemRoot = systemRootKey ? process.env[systemRootKey] : undefined;
  if (!isFullyQualifiedWindowsPath(systemRoot)) return null;
  const candidate = path.win32.join(path.win32.normalize(systemRoot), "System32", "cmd.exe");
  if (!isFullyQualifiedWindowsPath(candidate) || !isUsableRegularFile(candidate)) return null;
  return candidate;
}

/**
 * Authoritative shared spawn-spec resolver for the launcher and extension Pi
 * children. Pi's own .cmd implementation is opaque and invoked as a batch
 * command with cmd.exe's normal argument processing.
 */
function resolvePiChildSpawnSpec(command, args, env, platform) {
  const forwarded = [...args];
  if (command !== "pi") return { ok: true, file: command, args: forwarded };
  const invocation = resolvePiInvocation(env, platform);
  if (invocation.kind === "path") return { ok: true, file: command, args: forwarded };
  if (invocation.kind === "direct") return { ok: true, file: invocation.file, args: forwarded };
  if (invocation.kind === "cmd") {
    const cmdExe = resolveTrustedWindowsCmd();
    if (!cmdExe) {
      return {
        ok: false,
        kind: "cmd-unavailable",
        error: "A valid regular cmd.exe was not found under the parent process's absolute Windows SystemRoot\\System32; refusing to launch pi.cmd.",
      };
    }
    const commandLine = [invocation.file, ...forwarded].map(cmdQuote).join(" ");
    return {
      ok: true,
      file: cmdExe,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return {
    ok: false,
    kind: "missing",
    error: "The default pi command was not found on PATH; install Pi (npm install -g @earendil-works/pi) or configure an explicit command.",
  };
}

/**
 * Execute pi with the given arguments (with or without the extension flag),
 * inheriting the environment and stdio, and return pi's exit status.
 */
function launchPi(argv, extensionPath, env) {
  const forwarded = extensionPath ? ["--extension", extensionPath, ...argv] : [...argv];
  const invocation = resolvePiChildSpawnSpec("pi", forwarded, env, process.platform);
  if (!invocation.ok) {
    if (invocation.kind === "cmd-unavailable") note(`pi-review-gate: ${invocation.error}\n`);
    else note("pi-review-gate: pi was not found on PATH; install Pi (npm install -g @earendil-works/pi) and re-run the launcher\n");
    return 127;
  }
  const result = spawnSync(invocation.file, invocation.args, {
    stdio: "inherit",
    env,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (result.error) {
    note(`pi-review-gate: could not execute pi (${result.error.message})\n`);
    return 127;
  }
  return result.status ?? 1;
}

/**
 * Main entry: argv are the forwarded pi arguments (the .cmd passes %*).
 * Returns the process exit status.
 */
async function main(argv) {
  const root = path.resolve(__dirname, "..");
  const resolution = { homeDir: os.homedir(), platform: process.platform };

  // Issue #26: --scheduler enables the process-local scheduled-execution
  // runtime for this launch only. The flag is consumed here and handed to the
  // extension through PI_REVIEW_GATE_SCHEDULER; it is never forwarded to pi,
  // which would reject the unknown option. An inherited
  // PI_REVIEW_GATE_SCHEDULER (e.g. from a parent launched with --scheduler) is
  // cleared before parsing so the explicit opt-in contract holds for nested and
  // fresh launches.
  const forwardedArgs = [];
  let schedulerEnabled = false;
  for (const arg of argv) {
    if (arg === "--scheduler") schedulerEnabled = true;
    else forwardedArgs.push(arg);
  }
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  if (schedulerEnabled) process.env.PI_REVIEW_GATE_SCHEDULER = "1";

  // Deliberate environment sanitization: the persistent config is re-resolved
  // below and re-exported, so an inherited PI_REVIEW_GATE_CONFIG (e.g. from a
  // parent pi session) cannot silently redirect the gate to another config
  // file. PI_REVIEW_GATE_DISABLED and PI_CODING_AGENT_DIR are deliberately NOT
  // deleted: the first is the documented kill switch and the second is Pi's own
  // agent directory, which the gate must resolve against.
  delete process.env.PI_REVIEW_GATE_CONFIG;

  const primary = prepare.piAgentConfigPath(process.env, resolution);
  const fallback = prepare.compatibilityFallbackConfigPath(resolution);

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

  const agentDir = path.resolve(prepare.resolvePiAgentDir(process.env, resolution));

  // The one shared current/update decision (issue 344). On a warm start this is
  // a bounded marker read plus a stat of the recorded paths: no install, build,
  // staging, inventory, Python probe, skill copy, or cleanup happens here.
  const prepared = await prepare.prepareLaunch({
    packageRoot: root,
    agentDir,
    homeDir: resolution.homeDir,
    env: process.env,
    platform: resolution.platform,
    writeError: note,
  });
  if (prepared.mode === "failed") return prepared.status ?? 1;
  const extensionPath = prepared.extension;
  process.env.PI_REVIEW_GATE_DDGS_PYTHON = prepared.ddgsPython;

  process.env.PI_REVIEW_GATE_CONFIG = selected;

  // Wrapper-only codemode default: normal launches export
  // PI_REVIEW_GATE_CODEMODE_DEFAULT=1 so the extension can enable Pi's
  // registered native codemode tool without rewriting any pi tool argument;
  // --tools/--exclude-tools/--no-tools/--no-extensions reach pi untouched and
  // Pi's policy-filtered getAllTools stays authoritative.
  process.env.PI_REVIEW_GATE_CODEMODE_DEFAULT = "1";

  // Same truthy values the extension uses (loadConfig/firstTruthyEnv in
  // src/config.ts): warn loudly when the kill switch is on.
  const disabled = process.env.PI_REVIEW_GATE_DISABLED;
  if (disabled === "1" || disabled === "true" || disabled === "yes") {
    out("pi-review-gate: PI_REVIEW_GATE_DISABLED is set; the review gate will not activate\n");
  }

  out(`pi-review-gate config: ${selected}\n`);
  out(`pi-review-gate extension: ${extensionPath}\n`);
  for (const skill of prepared.skills || []) {
    out(`pi-review-gate ${skill.label} skill: ${skill.path}\n`);
  }

  // The consumer lease must stay held exactly as long as this launch runs: pi
  // executes in the foreground and the prepared generation is released only
  // after it exits.
  try {
    return launchPi(forwardedArgs, extensionPath, process.env);
  } finally {
    prepared.lease?.release();
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--migrate-prior-skill-files") {
    // Compatibility invocation kept for the POSIX launcher and packaged
    // consumers: the migration itself is the shared implementation.
    prepare.migrateGenericSkillFiles(argv[1] || os.homedir());
    process.exitCode = 0;
  } else if (argv[0] === "--ensure-ddgs") {
    // Bounded-process DDGS setup seam used by the session host launcher.
    const result = prepare.ensureDdgs(argv[1] || os.homedir(), process.env);
    out(`${JSON.stringify(result && result.ok === true
      ? { ok: true, python: result.python }
      : { ok: false, exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : 1 })}\n`);
    process.exitCode = result && result.ok === true ? 0 : 1;
  } else if (argv[0] === "--resolve-config") {
    // Shared persistent-config resolution for the POSIX wrapper: it must not
    // carry a second copy of the candidate order, validity rules, or first-launch
    // publication.
    delete process.env.PI_REVIEW_GATE_CONFIG;
    const resolution = { homeDir: os.homedir(), platform: process.platform };
    const primary = prepare.piAgentConfigPath(process.env, resolution);
    const fallback = prepare.compatibilityFallbackConfigPath(resolution);
    const selection = selectReviewGateConfig([primary, fallback]);
    let selected = null;
    if (selection.status === 0) selected = selection.path;
    else if (selection.status === 3) selected = initializeDefaultReviewGateConfig(primary, fallback);
    if (!selected) {
      process.exitCode = 2;
    } else {
      out(`${selected}\n`);
      process.exitCode = 0;
    }
  } else if (argv.length > 0 && MANAGEMENT_VERBS.has(argv[0])) {
    // Direct helper invocation (the .cmd entry point forwards %* here
    // unconditionally): management verbs are forwarded to pi untouched, with
    // the inherited environment and no setup.
    process.exitCode = launchPi(argv, null, process.env);
  } else {
    main(argv).then((status) => {
      process.exitCode = status;
    }).catch((error) => {
      note(`pi-review-gate: launch failed (${error && error.message}).\n`);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  DDGS_VERSION,
  DEFAULT_CONFIG_CONTENT,
  MANAGEMENT_VERBS,
  // The shared component manifests and publication helpers are re-exported so
  // existing consumers (the session host launcher and the extension) keep a
  // single source of truth rather than a second copy.
  SKILL_MIGRATION_PLAN: prepare.SKILL_MIGRATION_PLAN,
  SKILL_PUBLISH_PLAN: prepare.SKILL_PUBLISH_PLAN,
  SKILL_PUBLISH_RETRY_ATTEMPTS: prepare.SKILL_PUBLISH_RETRY_ATTEMPTS,
  SKILL_PUBLISH_RETRY_DELAY_MS: prepare.SKILL_PUBLISH_RETRY_DELAY_MS,
  main,
  cmdQuote,
  compatibilityFallbackConfigPath: prepare.compatibilityFallbackConfigPath,
  ddgsPythonPath: prepare.ddgsPythonPath,
  ensureDdgs: prepare.ensureDdgs,
  initializeDefaultReviewGateConfig,
  migrateGenericSkillFiles: prepare.migrateGenericSkillFiles,
  normalizeWindowsShellPath: prepare.normalizeWindowsShellPath,
  piAgentConfigPath: prepare.piAgentConfigPath,
  publishSkillFile: prepare.publishSkillFile,
  refreshSkillFile: prepare.refreshSkillFile,
  renameIntoPlaceWithContentionRetry: prepare.renameIntoPlaceWithContentionRetry,
  resolvePiAgentDir: prepare.resolvePiAgentDir,
  resolvePiInvocation,
  resolvePiChildSpawnSpec,
  // Kept as a compatibility seam for launcher tests and consumers of this
  // helper; it is the same authoritative resolver, not a second path.
  resolveLauncherPiInvocation: resolvePiInvocation,
  selectReviewGateConfig,
};
