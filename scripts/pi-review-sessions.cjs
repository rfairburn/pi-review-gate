#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertSessionHostStartupOptions } = require("./session-host-startup-options.cjs");

const USAGE = `Usage: pi-review-sessions [--pi-executable <path-or-PATH-name>] [--state-root <path>] [--sidebar-key <key>] [--help] [-- <Pi arguments...>]

Alpha POSIX macOS/Linux session host. Requires Node >=22.19.0 and Pi >=1.0.4
with a positively identified Node CLI entry. Starts an empty welcome/sidebar
picker; choose a label, workspace, and profile explicitly in the UI. The
startup working directory is not selected as a workspace. Basic controls only;
terminal graphics rendering is disabled; native image/model input behavior
stays native. The sidebar toggle defaults to alt+left. Parent startup session
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
const MAX_DDGS_STDOUT_BYTES = 8192;

class SessionHostArgumentError extends Error {}

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

function safeInterpreterPath(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_DDGS_STDOUT_BYTES) return undefined;
  if (!stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) return undefined;
  const interpreter = stdout.slice(0, -1);
  if (
    interpreter.length === 0
    || interpreter.length > MAX_PATH_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(interpreter)
    || !path.isAbsolute(interpreter)
  ) return undefined;
  return interpreter;
}

function buildSourceExtension(packageRoot, env) {
  // Fixed npm command; the package root is a positional argument, never shell text.
  return spawnSync("npm", ["--prefix", packageRoot, "run", "build"], {
    cwd: packageRoot,
    env,
    stdio: "inherit",
  });
}

function ensureDdgs(packageRoot, env) {
  const scriptPath = path.join(packageRoot, "scripts", "ensure-ddgs.sh");
  let scriptIsFile = false;
  try {
    scriptIsFile = fs.statSync(scriptPath).isFile();
  } catch {
    // A missing packaged helper is a fail-closed setup error.
  }
  if (!scriptIsFile) return { ok: false, exitCode: 1 };

  // The command is fixed and all paths are positional shell parameters. The
  // setup runs from the package root, never the caller's startup workspace.
  const command = 'set -e; source "$1"; printf "%s\\n" "$PI_REVIEW_GATE_DDGS_PYTHON"';
  const result = spawnSync("/bin/bash", ["-c", command, "pi-review-sessions", scriptPath], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    maxBuffer: MAX_DDGS_STDOUT_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error || result.status !== 0) {
    return { ok: false, exitCode: statusCode(result) };
  }
  const python = safeInterpreterPath(result.stdout);
  if (!python) return { ok: false, exitCode: 1 };
  return { ok: true, python };
}

function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultDependencies() {
  return {
    getEnv: () => process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    packageRoot: path.resolve(__dirname, ".."),
    build: buildSourceExtension,
    ensureDdgs,
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

  // Reject parent startup session overrides before any setup (build, DDGS,
  // profile, token, PTY): every created instance would inherit them and open
  // the same old chat/storage instead of a new native chat of its own.
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

  // Scrub inherited host bootstrap/status values before build and provisioning
  // descendants, and before loading the compiled host. Preserve every other
  // user environment setting, including NODE_OPTIONS and provider variables.
  const setupEnv = { ...inheritedEnv };
  for (const name of HOST_ENV_TO_CLEAR) delete setupEnv[name];
  if (inheritedEnv === deps.processEnv) {
    for (const name of HOST_ENV_TO_CLEAR) delete deps.processEnv[name];
  }

  const packageRoot = path.resolve(deps.packageRoot);
  const sourceEntry = path.join(packageRoot, "src", "session-host", "main.ts");
  const compiledEntry = path.join(packageRoot, "dist", "src", "session-host", "main.js");
  let sourceCheckout = false;
  try {
    sourceCheckout = fs.existsSync(sourceEntry);
  } catch {
    sourceCheckout = false;
  }

  if (sourceCheckout) {
    let build;
    try {
      build = deps.build(packageRoot, setupEnv);
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
  }

  if (!deps.isRegularFile(compiledEntry)) {
    deps.writeError("pi-review-sessions: compiled native session host is unavailable.\n");
    return 2;
  }

  let ddgs;
  try {
    ddgs = deps.ensureDdgs(packageRoot, setupEnv);
  } catch {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return 1;
  }
  if (!ddgs || ddgs.ok !== true || typeof ddgs.python !== "string") {
    deps.writeError("pi-review-sessions: DDGS setup failed.\n");
    return ddgs && Number.isInteger(ddgs.exitCode) ? ddgs.exitCode : 1;
  }
  const python = safeInterpreterPath(`${ddgs.python}\n`);
  if (!python) {
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
    packageRoot,
    ...(parsed.piExecutable !== undefined ? { piExecutable: parsed.piExecutable } : {}),
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
  parseSessionHostArguments,
  // This seam is intentionally not consulted by the CLI and does not provide
  // an environment-variable bypass for role or preflight checks.
  __test: { runSessionHostLauncher, ensureDdgs },
};
