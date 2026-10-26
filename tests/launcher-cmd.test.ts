import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { extensionFromArgs, isCompiledExtension, writeFakeNpm, writeRequiredOutputs } from "./launcher-prepare-fixtures";
import { piAgentConfigPath, reviewGateConfigCandidates } from "../src/config-path";

const execFileAsync = promisify(execFile);

// Production entry points under test (issue 108): the native Windows .cmd
// launcher and its Node helper. The helper is the production implementation of
// everything the POSIX launcher (scripts/pi-review-gate.sh) does except the
// management passthrough, which the .cmd performs natively; the pipeline tests
// below run the helper as a real subprocess on every supported platform, and
// the win32-only tests additionally drive the actual .cmd entry point through
// cmd.exe and PowerShell on native Windows.
const helperPath = resolve("scripts/pi-review-gate-launcher.cjs");
const cmdPath = resolve("scripts/pi-review-gate.cmd");
const isWindows = process.platform === "win32";

// The helper is CommonJS on purpose (the launcher must resolve paths before a
// build exists); requiring it provides unit seams without running its main().
const helperModule = require(helperPath) as {
  DDGS_VERSION: string;
  MANAGEMENT_VERBS: Set<string>;
  SKILL_MIGRATION_PLAN: Array<{ installed: string[]; source: string[]; historicalSha256: string }>;
  SKILL_PUBLISH_RETRY_ATTEMPTS: number;
  SKILL_PUBLISH_RETRY_DELAY_MS: number;
  cmdQuote: (arg: string) => string;
  compatibilityFallbackConfigPath: (resolution: { homeDir: string; platform: string }) => string;
  ddgsPythonPath: (venv: string, platform: string) => string;
  initializeDefaultReviewGateConfig: (primary: string, fallback: string) => string | null;
  normalizeWindowsShellPath: (filePath: string) => string;
  piAgentConfigPath: (env: NodeJS.ProcessEnv, resolution: { homeDir: string; platform: string }) => string;
  renameIntoPlaceWithContentionRetry: (
    rename: () => void,
    options?: {
      destination?: string;
      attempts?: number;
      delayMs?: number;
      sleep?: (ms: number) => void;
      platform?: string;
      isDirectory?: () => boolean;
    },
  ) => { published: boolean; attempts: number; lastError: (Error & { code?: string }) | null };
  resolvePiAgentDir: (env: NodeJS.ProcessEnv, resolution: { homeDir: string; platform: string }) => string;
  resolveLauncherPiInvocation: (env: NodeJS.ProcessEnv, platform: string) =>
    { kind: string; file?: string };
  resolvePiChildSpawnSpec: (command: string, args: string[], env: NodeJS.ProcessEnv, platform: string) =>
    | { ok: true; file: string; args: string[]; windowsVerbatimArguments?: true }
    | { ok: false; kind: string; error: string };
  selectReviewGateConfig: (candidates: string[]) => { status: number; path?: string };
};

/**
 * The shared preparation authority the helper itself requires. Only its
 * `applicationStateRoot` is used: the coordination diagnostic must scope itself
 * to the exact synthetic state directory the product resolves, so the scope can
 * never drift from the launcher's own layout. Requiring it reuses the module
 * instance the helper already loaded.
 */
const prepareModule = require(resolve("scripts/prepare-application.cjs")) as {
  applicationStateRoot: (agentDir: string) => string;
};

interface SimulatedWindowsSpawnCase {
  args: string[];
  env: NodeJS.ProcessEnv;
  parentSystemRoot?: string;
  parentSystemRootKey?: string;
  expectedCmd?: string;
  cmdFileKind: "regular" | "directory" | "missing";
}

function resolveSimulatedWindowsSpecs(cases: SimulatedWindowsSpawnCase[]) {
  const invocationModulePath = resolve(__dirname, "../src/pi-invocation.js");
  const source = `
    const fs = require("node:fs");
    const cases = ${JSON.stringify(cases)};
    const helper = require(${JSON.stringify(helperPath)});
    const typed = require(${JSON.stringify(invocationModulePath)});
    const realStatSync = fs.statSync;
    let active;
    fs.statSync = function (candidate, ...args) {
      if (typeof candidate === "string" && /(?:^|[\\\\/])System32[\\\\/]cmd\\.exe$/i.test(candidate)) {
        active.statPaths.push(candidate);
        if (candidate.toLowerCase() === active.expectedCmd?.toLowerCase()) {
          if (active.cmdFileKind === "missing") {
            const error = new Error("fixture cmd.exe is missing");
            error.code = "ENOENT";
            throw error;
          }
          return { isFile: () => active.cmdFileKind === "regular" };
        }
        return { isFile: () => false };
      }
      return realStatSync.call(this, candidate, ...args);
    };
    const results = [];
    for (const item of cases) {
      for (const key of Object.keys(process.env)) {
        if (key.toLowerCase() === "systemroot") delete process.env[key];
      }
      if (item.parentSystemRoot !== undefined) {
        process.env[item.parentSystemRootKey ?? "SystemRoot"] = item.parentSystemRoot;
      }
      item.statPaths = [];
      active = item;
      const direct = helper.resolvePiChildSpawnSpec("pi", item.args, item.env, "win32");
      const child = typed.resolvePiChildSpawn("pi", item.args, item.env, "win32");
      results.push({ direct, child, statPaths: item.statPaths });
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, `isolated Windows resolver failed: ${result.stderr}`);
  return JSON.parse(result.stdout ?? "[]") as Array<{
    direct: ReturnType<typeof helperModule.resolvePiChildSpawnSpec>;
    child: ReturnType<typeof helperModule.resolvePiChildSpawnSpec>;
    statPaths: string[];
  }>;
}

/** The exact zero-model default the launcher writes on first launch (issue 32). */
const zeroModelDefaultConfig = {
  enabled: true,
  review: { activeReviewers: [] },
  externalAgents: {},
  execution: {
    workerResources: {},
    routes: { execute: [], research: [] },
  },
};

interface Fixture {
  root: string;
  home: string;
  bin: string;
  capture: string;
  ddgsVenv: string;
  /** Native Pi agent directory: the default (primary) config location. */
  agentDir: string;
  /** Default (primary) config: the native Pi agent directory + review-gate.json. */
  defaultConfigPath: string;
  /** Sole implicit compatibility fallback (issue 94). */
  fallbackConfigPath: string;
  /** The pre-#94 location: removed, never discovered or initialized. */
  removedConfigPath: string;
}

async function makeFixture(prefix: string, options: { skipNpmShim?: boolean; emptyDdgsVenv?: boolean } = {}): Promise<Fixture> {
  // The home directory deliberately contains spaces: paths-with-spaces must
  // survive every launcher seam (resolution, publication, export, pi spawn).
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home dir with spaces");
  const bin = join(root, "bin dir with spaces");
  const capture = join(root, "capture dir with spaces");
  const ddgsVenv = join(root, "ddgs venv");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(capture, { recursive: true });

  // Fake pi: records the forwarded arguments and the gate environment the
  // launcher exported, then exits with PI_EXIT_CODE. POSIX execution is a
  // plain execvp of the PATH entry; Windows invokes the full pi.cmd path.
  // Use a simple shim with no npm-style target for the regression: the
  // launcher must run the command itself, not parse its implementation.
  const fakePiEntry = join(bin, "pi-launcher.js");
  await writeFile(fakePiEntry, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  configEnv: process.env.PI_REVIEW_GATE_CONFIG ?? null,",
    "  disabledEnv: process.env.PI_REVIEW_GATE_DISABLED ?? null,",
    "  codemodeEnv: process.env.PI_REVIEW_GATE_CODEMODE_DEFAULT ?? null,",
    "  agentDirEnv: process.env.PI_CODING_AGENT_DIR ?? null,",
    "  ddgsEnv: process.env.PI_REVIEW_GATE_DDGS_PYTHON ?? null,",
    "}));",
    "process.exit(Number(process.env.PI_EXIT_CODE ?? '0'));",
  ].join("\n"), "utf8");
  if (isWindows) {
    await writeFile(join(bin, "pi.cmd"), '@ECHO off\r\nnode "%~dp0pi-launcher.js" %*\r\n', "utf8");
  } else {
    const piPath = join(bin, "pi");
    await writeFile(piPath, `#!/usr/bin/env bash\nexec node "${fakePiEntry}" "$@"\n`, "utf8");
    await chmod(piPath, 0o755);
  }

  if (!options.skipNpmShim) {
    // Fake npm the shared preparation engine resolves exactly like a real
    // installation: PATH's npm entry resolves into an npm package whose
    // manifest declares the public JS CLI. The CLI records its arguments,
    // stages a synthetic TypeScript compiler, and propagates NPM_EXIT_CODE.
    await writeFakeNpm(bin, { recordFile: join(capture, "npm-args") });
    if (isWindows) {
      // The Windows resolver looks for npm/npm.cmd first; the sibling package
      // CLI beside them is the validated entry used directly.
      await writeFile(join(bin, "npm.cmd"), "@ECHO off\r\nrem resolved through the sibling npm package CLI\r\n", "utf8");
    }
  }

  if (isWindows) {
    // Native Windows tests share one really provisioned DDGS venv (created in
    // before()) so no test pays the pip install again.
    await mkdir(ddgsVenv, { recursive: true });
  } else if (options.emptyDdgsVenv) {
    // Empty venv: the helper must take the fresh-provisioning path.
    await mkdir(ddgsVenv, { recursive: true });
  } else {
    await writePosixDdgsPythonStub(ddgsVenv);
  }

  return {
    root,
    home,
    bin,
    capture,
    ddgsVenv,
    agentDir: join(home, ".pi", "agent"),
    defaultConfigPath: join(home, ".pi", "agent", "review-gate.json"),
    fallbackConfigPath: join(home, ".config", "pi-review-gate", "config.json"),
    removedConfigPath: join(home, ".config", "pi", "review-gate.json"),
  };
}

/** An npm-generated Windows batch shim shape, as npm's cmd-shim writes it. */
function npmCmdShim(targetRelative: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    // npm keeps this on one line so _prog/dp0 expand before endLocal.
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${targetRelative}" %*`,
    "",
  ].join("\r\n");
}

/**
 * A POSIX stub venv python that records its invocations and succeeds at every
 * probe the helper makes (isolated-mode version check and pip check), so the
 * venv counts as a valid cached environment.
 */
async function writePosixDdgsPythonStub(venv: string): Promise<void> {
  await mkdir(join(venv, "bin"), { recursive: true });
  const pythonPath = join(venv, "bin", "python");
  await writeFile(pythonPath, [
    "#!/usr/bin/env bash",
    "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
    "exit 0",
    "",
  ].join("\n"), "utf8");
  await chmod(pythonPath, 0o755);
}

/**
 * Present a valid cached DDGS venv at an arbitrary location through the same
 * seam the helper resolves: a POSIX stub interpreter on POSIX, and a junction
 * to the really provisioned shared venv on native Windows (real python.exe,
 * real pinned install — no pip cost beyond the once-per-run before() hook).
 */
async function stageValidDdgsVenvAt(venv: string): Promise<void> {
  if (isWindows) {
    if (!sharedWindowsVenv) throw new Error("the shared Windows DDGS venv must be provisioned in before()");
    await mkdir(dirname(venv), { recursive: true });
    await symlink(sharedWindowsVenv, venv, "junction");
  } else {
    await writePosixDdgsPythonStub(venv);
  }
}

/** The venv the default fixture environment directs the helper at. */
function fixtureDdgsVenv(fixture: Fixture): string {
  return isWindows ? sharedWindowsVenv ?? fixture.ddgsVenv : fixture.ddgsVenv;
}

function fixtureEnv(fixture: Fixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Sanitize inherited gate variables so the tests observe the helper's own
  // resolution (and role-sensitive behavior stays at its default).
  delete env.PI_REVIEW_GATE_CONFIG;
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete env.PI_REVIEW_GATE_DISABLED;
  // Hermeticity for the wrapper-owned codemode default (tests that verify the
  // helper's export set it explicitly, including its inherited-value override).
  delete env.PI_REVIEW_GATE_CODEMODE_DEFAULT;
  delete env.PI_REVIEW_GATE_DDGS_PYTHON;
  delete env.PI_REVIEW_GATE_DDGS_VENV;
  // On POSIX node's os.homedir() honors HOME; on win32 it honors USERPROFILE
  // first, so both point at the fixture home.
  env.HOME = fixture.home;
  if (isWindows) env.USERPROFILE = fixture.home;
  env.PATH = `${fixture.bin}${isWindows ? ";" : ":"}${process.env.PATH ?? ""}`;
  env.CAPTURE_DIR = fixture.capture;
  env.CAPTURE_FILE = join(fixture.capture, "pi.json");
  // Native Windows tests share one really provisioned venv; POSIX tests use a
  // stub python at the same seam the helper resolves (Scripts\ vs bin\).
  env.PI_REVIEW_GATE_DDGS_VENV = fixtureDdgsVenv(fixture);
  return { ...env, ...overrides };
}

async function runHelper(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return execFileAsync(process.execPath, [helperPath, ...args], { env, ...(cwd ? { cwd } : {}) });
}

function runHelperExpectingFailure(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return runStagedHelperExpectingFailure(helperPath, args, env, cwd);
}

function runStagedHelperExpectingFailure(helper: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return execFileAsync(process.execPath, [helper, ...args], { env, ...(cwd ? { cwd } : {}) })
    .then(
      (result) => ({ status: 0, stdout: result.stdout, stderr: result.stderr }),
      (error: Error & { code: number | string; stdout?: string; stderr?: string }) => ({
        status: typeof error.code === "number" ? error.code : -1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );
}

/**
 * Copy the launcher and every shared module it requires into a staged package
 * tree. The preparation authority and build engine are ordinary shipped scripts,
 * so a staged package (exactly like a real npm install) contains all of them.
 */
async function stageLauncherScripts(stage: string): Promise<void> {
  await mkdir(join(stage, "scripts"), { recursive: true });
  for (const name of [
    "pi-review-gate-launcher.cjs",
    "prepare-application.cjs",
    "application-build.cjs",
    "managed-generations.cjs",
  ]) {
    await copyFile(resolve("scripts", name), join(stage, "scripts", name));
  }
}

/** Copy the real shipped skills into a staged package tree. */
async function stageShippedSkills(stage: string): Promise<void> {
  await cp(resolve("skills"), join(stage, "skills"), { recursive: true });
}

interface LaunchCapture {
  args: string[];
  configEnv: string | null;
  disabledEnv: string | null;
  codemodeEnv: string | null;
  agentDirEnv: string | null;
  ddgsEnv: string | null;
}

function capturedLaunch(fixture: Fixture): Promise<LaunchCapture> {
  return readFile(join(fixture.capture, "pi.json"), "utf8").then(JSON.parse) as Promise<LaunchCapture>;
}

/**
 * Assert that a launch forwarded the prepared extension (a compiled entry whose
 * root is the automatically prepared generation or the installed package) plus
 * exactly the caller's arguments.
 */
function assertExtensionLaunch(args: string[], forwarded: string[], message?: string): void {
  assert.equal(args[0], "--extension", message);
  assert.equal(isCompiledExtension(args[1] ?? ""), true, message ?? `unexpected extension: ${args[1]}`);
  assert.deepEqual(args.slice(2), forwarded, message);
}

async function launchStarted(fixture: Fixture): Promise<boolean> {
  return stat(join(fixture.capture, "pi.json")).then(() => true, () => false);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/**
 * Immutable pre-#151 historical fixture bytes (digest-anchored in
 * tests/shipped-skills.test.ts): the true prior generic package-owned content,
 * independent of later shipped-skill edits such as issue 179's.
 */
async function historicalFixture(installedPath: string): Promise<string> {
  return readFile(join(resolve("tests", "fixtures", "skill-migration"), ...installedPath.split("/")), "utf8");
}

async function posixMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function assertNoTempLitter(dir: string): Promise<void> {
  const entries = await readdir(dir);
  assert.ok(
    !entries.some((entry) => entry.startsWith(".config.json.") || entry.startsWith(".skill-publish.")),
    `temporary launcher files left behind in ${dir}: ${entries.join(", ")}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Shared DDGS venv for native Windows tests: the helper provisions DDGS like
// scripts/ensure-ddgs.sh does, and one real venv (python -m venv + pip install
// of the pinned wheel) exercises that parity natively exactly once per run.
// ---------------------------------------------------------------------------

let windowsDdgsBase: string | undefined;
let sharedWindowsVenv: string | undefined;

before(async () => {
  if (!isWindows) return;
  windowsDdgsBase = await mkdtemp(join(tmpdir(), "pi-review-cmd-ddgs-"));
  sharedWindowsVenv = join(windowsDdgsBase, "ddgs");
  const create = spawnSync(`python -I -m venv "${sharedWindowsVenv}"`, { shell: true, stdio: "pipe" });
  assert.equal(create.status, 0, `python -m venv must work on native Windows: ${String(create.stderr)}`);
  const venvPython = join(sharedWindowsVenv, "Scripts", "python.exe");
  assert.ok(
    spawnSync(`"${venvPython}" -I -c "import sys"`, { shell: true, stdio: "ignore" }).status === 0,
    "the provisioned venv python must run in isolated mode",
  );
  const install = spawnSync(
    `"${venvPython}" -I -m pip install --disable-pip-version-check --no-cache-dir --no-input --only-binary=:all: --quiet "ddgs==${helperModule.DDGS_VERSION}"`,
    { shell: true, stdio: "pipe" },
  );
  assert.equal(install.status, 0, `pip install ddgs must succeed on native Windows: ${String(install.stderr)}`);
});

after(async () => {
  if (windowsDdgsBase) await rm(windowsDdgsBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pipeline tests: the production helper, run as a real subprocess on every
// supported platform (fake pi/npm/ddgs shims resolve through the platform
// shell exactly as production resolution does).
// ---------------------------------------------------------------------------

test("launcher helper first launch creates a private zero-model default config in the Pi agent directory", async () => {
  const fixture = await makeFixture("pi-review-cmd-first-");

  // Pi's own agent-directory contents must stay untouched by initialization.
  const piSettings = join(fixture.home, ".pi", "settings.json");
  await mkdir(join(fixture.home, ".pi"), { recursive: true });
  await writeFile(piSettings, '{"pi":"owns this"}\n', "utf8");

  // An inherited PI_REVIEW_GATE_CONFIG must not redirect the first launch:
  // sanitization still applies, and initialization targets the default path.
  const result = await runHelper(["--model", "example"], fixtureEnv(fixture, {
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
  }));

  assert.match(result.stderr, /no persistent config found; created default zero-model config at/);
  assert.match(result.stderr, /no reviewers or workers are selected yet; configure them with \/review-settings/);
  assert.match(result.stdout, new RegExp(escapeRegExp(fixture.defaultConfigPath)));
  assert.match(result.stdout, /pi-review-gate extension: .*dist[\\/]src[\\/]index\.js/);

  const generated = JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")) as unknown;
  assert.deepEqual(generated, zeroModelDefaultConfig);
  assert.equal(await pathExists(fixture.fallbackConfigPath), false,
    "first launch must not create the compatibility fallback config");
  assert.equal(await pathExists(fixture.removedConfigPath), false,
    "first launch must not create the removed ~/.config/pi/review-gate.json location");
  assert.equal(await readFile(piSettings, "utf8"), '{"pi":"owns this"}\n',
    "unrelated Pi contents must be preserved untouched");
  if (!isWindows) {
    assert.equal(await posixMode(fixture.defaultConfigPath), 0o600, "new config file must be private (0600)");
    assert.equal(await posixMode(fixture.agentDir), 0o700, "new agent directory must be private (0700)");
    // A pre-existing .pi (Pi's own directory, created by the fixture) keeps its
    // mode: initialization only creates missing levels and never re-chmods.
    assert.equal(await posixMode(join(fixture.home, ".pi")), 0o755);
  }
  await assertNoTempLitter(fixture.agentDir);
});

test("launcher helper resolves, exports and forwards on a normal launch", async () => {
  const fixture = await makeFixture("pi-review-cmd-forward-");
  await mkdir(fixture.agentDir, { recursive: true });
  const prior = '{"enabled":true,"marker":"default"}\n';
  await writeFile(fixture.defaultConfigPath, prior, "utf8");

  const result = await runHelper(["--model", "example", "--tools", "read,bash"], fixtureEnv(fixture, {
    // An inherited value must not survive: the wrapper owns the normal-launch
    // default (the same scoped overwriting as PI_REVIEW_GATE_CONFIG).
    PI_REVIEW_GATE_CODEMODE_DEFAULT: "0",
  }));

  const launch = await capturedLaunch(fixture);
  assertExtensionLaunch(launch.args, ["--model", "example", "--tools", "read,bash"]);
  assert.equal(launch.configEnv, fixture.defaultConfigPath,
    "the helper must export the resolved persistent config for pi");
  assert.equal(launch.disabledEnv, null);
  assert.equal(launch.codemodeEnv, "1",
    "normal launches export the wrapper's scoped codemode default, overriding any inherited value");
  assert.equal(launch.agentDirEnv, null);
  assert.ok(launch.ddgsEnv, "the DDGS python must be exported for the extension's web search");
  assert.equal(launch.ddgsEnv, helperModule.ddgsPythonPath(fixtureDdgsVenv(fixture), process.platform),
    "the exported interpreter must come from the venv the environment requested");
  assert.match(result.stdout, new RegExp(`pi-review-gate config: ${escapeRegExp(fixture.defaultConfigPath)}`));
  assert.match(result.stdout, /pi-review-gate extension: .*dist[\\/]src[\\/]index\.js/);
  assert.match(result.stdout,
    new RegExp(`pi-review-gate orchestrator skill: ${escapeRegExp(join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md"))}`));
  assert.match(result.stdout,
    new RegExp(`pi-review-gate execution skill: ${escapeRegExp(join(fixture.home, ".agents", "skills", "pi-review-gate-execution", "SKILL.md"))}`));
  assert.match(result.stdout,
    new RegExp(`pi-review-gate research skill: ${escapeRegExp(join(fixture.home, ".agents", "skills", "pi-review-gate-research", "SKILL.md"))}`));
  assert.doesNotMatch(result.stderr, /created default zero-model config/);
  assert.doesNotMatch(result.stderr, /creating DDGS/,
    "a valid cached venv must not be provisioned again");
  assert.equal(await readFile(fixture.defaultConfigPath, "utf8"), prior,
    "existing config must not be rewritten");
  if (!isWindows) {
    // The cached venv path: only validation runs, in Python isolated mode.
    const calls = (await readFile(join(fixture.capture, "python-calls"), "utf8")).split("\n").filter(Boolean);
    assert.ok(calls.length >= 2, `expected ddgs validation invocations: ${calls.join(" | ")}`);
    for (const call of calls) assert.equal(call.split("\t")[1], "-I", `not isolated: ${call}`);
    assert.ok(!calls.some((call) => call.includes("install")), "a valid cached venv must not be reinstalled");
  }
});

test("launcher helper keeps the compatibility fallback and never initializes beside it", async () => {
  const fixture = await makeFixture("pi-review-cmd-fallback-");
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");

  const result = await runHelper([], fixtureEnv(fixture, {
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
  }));

  const launch = await capturedLaunch(fixture);
  assert.equal(launch.configEnv, fixture.fallbackConfigPath);
  assert.equal(await readFile(fixture.fallbackConfigPath, "utf8"), prior,
    "an existing fallback config must be preserved unchanged");
  assert.doesNotMatch(result.stderr, /created default zero-model config/);
  assert.equal(await pathExists(fixture.defaultConfigPath), false,
    "a present fallback config must not trigger default initialization");
});

test("launcher helper prefers the default config over the compatibility fallback", async () => {
  const fixture = await makeFixture("pi-review-cmd-precedence-");
  await mkdir(fixture.agentDir, { recursive: true });
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true,"marker":"default"}\n', "utf8");
  await writeFile(fixture.fallbackConfigPath, '{"enabled":true,"marker":"fallback"}\n', "utf8");

  await runHelper([], fixtureEnv(fixture));

  assert.equal((await capturedLaunch(fixture)).configEnv, fixture.defaultConfigPath);
  assert.equal(await readFile(fixture.fallbackConfigPath, "utf8"), '{"enabled":true,"marker":"fallback"}\n',
    "the fallback must stay untouched");
});

test("the removed ~/.config/pi/review-gate.json location is never discovered or initialized", async () => {
  const fixture = await makeFixture("pi-review-cmd-removed-");
  await mkdir(join(fixture.removedConfigPath, ".."), { recursive: true });
  const prior = '{"enabled":true,"marker":"removed"}\n';
  await writeFile(fixture.removedConfigPath, prior, "utf8");

  const result = await runHelper([], fixtureEnv(fixture));

  assert.match(result.stderr, /created default zero-model config at/);
  assert.equal((await capturedLaunch(fixture)).configEnv, fixture.defaultConfigPath);
  assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
  assert.equal(await readFile(fixture.removedConfigPath, "utf8"), prior,
    "the removed location's file must be left untouched");
  assert.equal(await pathExists(fixture.fallbackConfigPath), false,
    "the compatibility fallback must not be created either");
});

test("launcher helper honors PI_CODING_AGENT_DIR with native tilde semantics", async () => {
  const fixture = await makeFixture("pi-review-cmd-agentdir-");
  const overrideConfigPath = join(fixture.home, "custom agent dir", "review-gate.json");

  const result = await runHelper([], fixtureEnv(fixture, { PI_CODING_AGENT_DIR: "~/custom agent dir" }));

  const launch = await capturedLaunch(fixture);
  assert.equal(launch.agentDirEnv, "~/custom agent dir",
    "PI_CODING_AGENT_DIR must pass through to pi untouched");
  assert.equal(launch.configEnv, overrideConfigPath);
  assert.match(result.stdout, new RegExp(escapeRegExp(overrideConfigPath)));
  assert.deepEqual(JSON.parse(await readFile(overrideConfigPath, "utf8")), zeroModelDefaultConfig);
  assert.equal(await pathExists(join(fixture.home, ".pi")), false,
    "the default location under the home must stay untouched");
  await assertNoTempLitter(join(fixture.home, "custom agent dir"));
});

test("launcher helper never replaces a malformed existing config", async () => {
  const fixture = await makeFixture("pi-review-cmd-malformed-");
  const malformed = "{not json";
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, malformed, "utf8");

  const result = await runHelper([], fixtureEnv(fixture));

  assert.equal((await capturedLaunch(fixture)).configEnv, fixture.defaultConfigPath,
    "the launcher does not parse the config; it must hand the malformed file through");
  assert.equal(await readFile(fixture.defaultConfigPath, "utf8"), malformed,
    "malformed config must be preserved");
  assert.doesNotMatch(result.stderr, /created default zero-model config/);
});

test("launcher helper fails closed over an invalid default config even when the fallback is valid", async () => {
  const fixture = await makeFixture("pi-review-cmd-invalid-primary-");
  await mkdir(fixture.defaultConfigPath, { recursive: true });
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /exists but is not a regular file/);
  assert.match(result.stderr, new RegExp(escapeRegExp(fixture.defaultConfigPath)));
  assert.equal(await launchStarted(fixture), false, "the helper must not start pi over an invalid candidate");
  assert.equal(await readFile(fixture.fallbackConfigPath, "utf8"), prior,
    "the fallback must not be used or rewritten");
  assert.ok((await stat(fixture.defaultConfigPath)).isDirectory(), "the invalid path must not be removed");
});

test("launcher helper fails closed over an invalid fallback and never initializes a competing default", async () => {
  // The default is absent; the compatibility fallback exists but is not a
  // usable regular file. Initialization at the default location would silently
  // create a competing default and must be refused.
  const fixture = await makeFixture("pi-review-cmd-invalid-fallback-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await mkdir(fixture.fallbackConfigPath, { recursive: true });

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /exists but is not a regular file/);
  assert.match(result.stderr, new RegExp(escapeRegExp(fixture.fallbackConfigPath)));
  assert.equal(await pathExists(fixture.agentDir), false,
    "initialization must not create a competing default beside an invalid fallback");
  assert.equal(await launchStarted(fixture), false);
});

test("launcher helper prepares once for a source checkout and is current on the next launch", async () => {
  const fixture = await makeFixture("pi-review-cmd-prepare-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  const result = await runHelper(["--model", "example"], fixtureEnv(fixture));

  // The shared preparation engine ran one locked install in an isolated staged
  // generation; it never ran the package build lifecycle in the checkout.
  const npmArgs = JSON.parse(await readFile(join(fixture.capture, "npm-args"), "utf8")) as string[];
  assert.deepEqual(npmArgs.slice(0, 1), ["ci"], "the only install is the locked ci install");
  assert.ok(!npmArgs.includes("run") && !npmArgs.includes("build"),
    "no package build lifecycle is ever invoked");
  const launch = await capturedLaunch(fixture);
  assertExtensionLaunch(launch.args, ["--model", "example"]);
  assert.match(result.stdout, /pi-review-gate extension: .*dist[\\/]src[\\/]index\.js/);

  // The next launch is current: no install, no compiler, no staging.
  await rm(join(fixture.capture, "npm-args"), { force: true });
  await runHelper(["--model", "example"], fixtureEnv(fixture));
  assert.equal(await pathExists(join(fixture.capture, "npm-args")), false,
    "a current launch performs no install");
  assertExtensionLaunch((await capturedLaunch(fixture)).args, ["--model", "example"]);
});

test("launcher helper fails closed on a preparation failure and never launches a stale extension", async () => {
  const fixture = await makeFixture("pi-review-cmd-prepare-fail-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  const result = await runHelperExpectingFailure(["--model", "example"], fixtureEnv(fixture, {
    NPM_EXIT_CODE: "5",
  }));

  assert.equal(result.status, 5, "the build's own exit status must propagate");
  assert.equal(await launchStarted(fixture), false, "pi must not be started after a failed build");
  assert.doesNotMatch(result.stdout, /pi-review-gate config:/,
    "no launch diagnostics may precede a failed build");
});

test("launcher helper packaged mode uses the packaged artifact and fails closed when missing", async () => {
  // Stage a realistic packaged layout (no src/) in a scratch path containing
  // spaces, using the real production helper and skill sources.
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-package-"));
  try {
    const stage = join(scratch, "package dir with spaces");
    await stageLauncherScripts(stage);
    if (isWindows) await copyFile(cmdPath, join(stage, "scripts", "pi-review-gate.cmd"));
    await stageShippedSkills(stage);

    const missingFixture = await makeFixture("pi-review-cmd-packmiss-");
    // The staged tree has no src and no dist: packaged failure, exit 2.
    const missing = await runStagedHelperExpectingFailure(join(stage, "scripts", "pi-review-gate-launcher.cjs"), [], fixtureEnv(missingFixture));
    // Node resolves module paths through realpath, so the staged helper's
    // own root (and therefore its exported extension path) is the real path
    // of the stage (e.g. /private/var vs /var symlinks on macOS).
    const realStage = await realpath(stage);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /packaged extension output is missing/);
    assert.equal(await launchStarted(missingFixture), false);

    // With the packaged artifact present the helper uses it and never builds.
    writeRequiredOutputs(stage);
    const fixture = await makeFixture("pi-review-cmd-package-");
    const result = await runStagedHelperExpectingFailure(join(stage, "scripts", "pi-review-gate-launcher.cjs"), ["--model", "example"], fixtureEnv(fixture), scratch).then((outcome) => {
      assert.equal(outcome.status, 0, `stderr: ${outcome.stderr}`);
      return outcome;
    });
    assert.equal(await pathExists(join(fixture.capture, "npm-args")), false,
      "packaged mode must not invoke npm");
    const launch = await capturedLaunch(fixture);
    assert.equal(launch.args[0], "--extension");
    // Compare through realpath: the staged helper's __dirname and the test's
    // scratch path may surface different spellings of the same directory
    // (/private/var vs /var on macOS; 8.3 short names like RUNNER~1 in the
    // Windows CI temp dir), but realpath normalizes both to one form.
    assert.equal(await realpath(launch.args[1]), join(realStage, "dist", "src", "index.js"),
      "packaged mode must use the staged artifact");

    // Any missing manifest source must fail closed before publication and
    // before pi is launched, never with partially provisioned skills.
    await rm(join(stage, "skills", "pi-review-gate-completion", "SKILL.md"));
    const missingSkillFixture = await makeFixture("pi-review-cmd-package-skillmiss-");
    const missingSkill = await runStagedHelperExpectingFailure(
      join(stage, "scripts", "pi-review-gate-launcher.cjs"), ["--model", "example"], fixtureEnv(missingSkillFixture), scratch,
    );
    assert.equal(missingSkill.status, 2, `stderr: ${missingSkill.stderr}`);
    assert.match(missingSkill.stderr, /packaged skill file is missing: .*completion.SKILL\.md/);
    assert.equal(await launchStarted(missingSkillFixture), false);
    assert.equal(
      await pathExists(join(missingSkillFixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md")),
      false,
      "the source check must precede publication: no skill may be provisioned",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("launcher helper quotes spaces, empty arguments and metacharacters for pi", async () => {
  const fixture = await makeFixture("pi-review-cmd-args-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  // POSIX uses an argument array; Windows quotes these arguments for the
  // resolved batch command. Shell metacharacters must remain arguments.
  const forwarded = [
    "--model", "example model",
    "--tools", "read,bash",
    "--label", "a&b",
    "--pipe", "a|b",
    "--caret", "a^b",
    "--empty", "",
    "--quote", 'say "hi"',
    "--combo", 'say "&hi"',
    "--paren", "(priority)",
    "--percent", "100%PI%",
  ];
  await runHelper(forwarded, fixtureEnv(fixture));

  const launch = await capturedLaunch(fixture);
  assertExtensionLaunch(launch.args, forwarded);
});

test("launcher helper propagates the launched pi exit status", async () => {
  const fixture = await makeFixture("pi-review-cmd-exit-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  const result = await runHelperExpectingFailure(["--model", "example"], fixtureEnv(fixture, {
    PI_EXIT_CODE: "7",
  }));

  assert.equal(result.status, 7, "the helper's exit status must be pi's exit status");
});

test("launcher helper forwards the kill switch and warns loudly", async () => {
  const fixture = await makeFixture("pi-review-cmd-disabled-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, "{}\n", "utf8");

  const result = await runHelper([], fixtureEnv(fixture, { PI_REVIEW_GATE_DISABLED: "1" }));

  assert.match(result.stdout, /PI_REVIEW_GATE_DISABLED is set; the review gate will not activate/);
  const launch = await capturedLaunch(fixture);
  assert.equal(launch.disabledEnv, "1",
    "the kill switch must reach pi (and therefore the extension), never be stripped");
  assert.equal(launch.configEnv, fixture.defaultConfigPath,
    "persistent config resolution still applies while disabled");
});

test("launcher helper clears an inherited scheduler flag and honors --scheduler", async () => {
  const fixture = await makeFixture("pi-review-cmd-scheduler-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, "{}\n", "utf8");

  // Capture the scheduler env seam exactly as pi's child would see it.
  const fakePiEntry = join(fixture.bin, "pi-launcher.js");
  await writeFile(fakePiEntry, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  schedulerEnv: process.env.PI_REVIEW_GATE_SCHEDULER ?? null,",
    "}));",
  ].join("\n"), "utf8");

  // Hermetic base: the host environment never contributes the flag.
  const envFor = (overrides: NodeJS.ProcessEnv = {}) => {
    const base = fixtureEnv(fixture);
    delete base.PI_REVIEW_GATE_SCHEDULER;
    return { ...base, ...overrides };
  };
  const capturedScheduler = async (): Promise<{ args: string[]; schedulerEnv: string | null }> =>
    JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8")) as { args: string[]; schedulerEnv: string | null };

  // Inherited from a parent launched with --scheduler: an unflagged launch
  // must start Off — the inherited value is cleared, never forwarded.
  await runHelper(["--model", "example"], envFor({ PI_REVIEW_GATE_SCHEDULER: "1" }));
  assert.equal(
    (await capturedScheduler()).schedulerEnv,
    null,
    "an inherited scheduler flag must not leak into an unflagged launch",
  );

  // The explicit flag opts in for exactly this launch, with or without an
  // inherited value, and is never forwarded to pi.
  await runHelper(["--scheduler", "--model", "example"], envFor({ PI_REVIEW_GATE_SCHEDULER: "1" }));
  let capture = await capturedScheduler();
  assert.equal(capture.schedulerEnv, "1", "--scheduler exports the flag for this launch (inherited value present)");
  assertExtensionLaunch(
    capture.args,
    ["--model", "example"],
    "--scheduler is consumed by the helper and never forwarded to pi",
  );

  await runHelper(["--scheduler", "--model", "example"], envFor());
  capture = await capturedScheduler();
  assert.equal(capture.schedulerEnv, "1", "--scheduler exports the flag for this launch (no inherited value)");
});

test("launcher helper management verbs pass straight through to pi without setup", async () => {
  for (const verb of helperModule.MANAGEMENT_VERBS) {
    const fixture = await makeFixture(`pi-review-cmd-verb-${verb}-`);
    const inherited = join(fixture.root, "inherited.json");
    await writeFile(inherited, "{}\n", "utf8");

    await runHelper([verb], fixtureEnv(fixture, { PI_REVIEW_GATE_CONFIG: inherited, PI_REVIEW_GATE_CODEMODE_DEFAULT: "0" }));

    const launch = await capturedLaunch(fixture);
    assert.deepEqual(launch.args, [verb],
      "passthrough must forward the verb without the extension flag");
    assert.equal(launch.configEnv, inherited,
      "passthrough keeps the inherited environment (exec pi \"$@\" parity)");
    assert.equal(launch.codemodeEnv, "0",
      "management passthrough keeps the inherited codemode value and never exports the wrapper default");
    assert.equal(await pathExists(fixture.agentDir), false, "no config initialization on passthrough");
    assert.equal(await pathExists(join(fixture.home, ".agents")), false, "no skill publication on passthrough");
    assert.equal(await pathExists(join(fixture.capture, "npm-args")), false, "no build on passthrough");
    assert.equal(await pathExists(join(fixture.capture, "python-calls")), false, "no DDGS provisioning on passthrough");
  }
});

test("launcher helper refreshes stale installed orchestrator and completion skills", async () => {
  const fixture = await makeFixture("pi-review-cmd-skill-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const skillDir = join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator");
  const installedSkill = join(skillDir, "SKILL.md");
  const installedRecovery = join(skillDir, "references", "recovery.md");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await writeFile(installedSkill, "stale\n", "utf8");
  await writeFile(installedRecovery, "stale recovery\n", "utf8");

  await runHelper([], fixtureEnv(fixture));

  assert.equal(
    await readFile(installedSkill, "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(installedRecovery, "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/references/recovery.md"), "utf8"),
  );
  if (!isWindows) {
    assert.equal(await posixMode(installedSkill), 0o644, "published skill must keep the contracted 0644 mode");
    assert.equal(await posixMode(installedRecovery), 0o644);
  }
  await assertNoTempLitter(skillDir);
  assert.deepEqual(await readdir(join(skillDir, "references")), ["recovery.md"],
    "no temporary skill files may be left behind");
  const completionDir = join(fixture.home, ".agents", "skills", "pi-review-gate-completion");
  await mkdir(completionDir, { recursive: true });
  await writeFile(join(completionDir, "SKILL.md"), "stale completion skill\n", "utf8");
  await runHelper([], fixtureEnv(fixture));

  assert.equal(
    await readFile(join(completionDir, "SKILL.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-completion/SKILL.md"), "utf8"),
    "a stale completion skill must be atomically refreshed from its packaged source",
  );
  if (!isWindows) assert.equal(await posixMode(join(completionDir, "SKILL.md")), 0o644);
  await assertNoTempLitter(completionDir);
  for (const name of ["pi-review-gate-execution", "pi-review-gate-research"]) {
    const dir = join(fixture.home, ".agents", "skills", name);
    assert.equal(
      await readFile(join(dir, "SKILL.md"), "utf8"),
      await readFile(resolve(`skills/${name}/SKILL.md`), "utf8"),
      `the ${name} skill must be provisioned alongside the orchestrator skill`,
    );
    if (!isWindows) {
      assert.equal(await posixMode(join(dir, "SKILL.md")), 0o644);
    }
    await assertNoTempLitter(dir);
  }
});

test("launcher helper preserves unrelated custom skills under ~/.agents/skills", async () => {
  const fixture = await makeFixture("pi-review-cmd-custom-skill-");
  const customSkill = join(fixture.home, ".agents", "skills", "my-custom-skill", "SKILL.md");
  const customContent = "---\nname: my-custom-skill\ndescription: user-owned skill\n---\nuser-owned\n";
  await Promise.all([
    mkdir(join(customSkill, ".."), { recursive: true }),
    mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true }),
  ]);
  await writeFile(customSkill, customContent, "utf8");
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const result = await runHelper([], fixtureEnv(fixture));

  assert.equal(
    await readFile(customSkill, "utf8"),
    customContent,
    "unrelated custom skills must be preserved untouched by provisioning",
  );
  for (const name of ["pi-review-gate-orchestrator", "pi-review-gate-execution", "pi-review-gate-research", "pi-review-gate-completion"]) {
    assert.equal(
      await readFile(join(fixture.home, ".agents", "skills", name, "SKILL.md"), "utf8"),
      await readFile(resolve(`skills/${name}/SKILL.md`), "utf8"),
      `the ${name} skill must still be provisioned alongside the custom skill`,
    );
  }
  // Issue 151: a fresh launch installs the namespaced skills only — the
  // generic pre-#151 locations are never created by provisioning.
  for (const generic of ["orchestrator", "execution", "research", "completion"]) {
    assert.equal(
      await pathExists(join(fixture.home, ".agents", "skills", generic)),
      false,
      `a fresh launch must not create the generic ${generic} skill location`,
    );
  }
  assert.match(result.stdout, /pi-review-gate orchestrator skill: /);
  assert.match(result.stdout, /pi-review-gate execution skill: /);
  assert.match(result.stdout, /pi-review-gate research skill: /);
});

test("launcher helper migrates proven pre-#151 generic skill copies and preserves modified or unrelated files (#151)", async () => {
  const fixture = await makeFixture("pi-review-cmd-skill-migration-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const skillsDir = join(fixture.home, ".agents", "skills");
  // Proven unmodified package-owned copies at the pre-#151 generic
  // locations: historical fixtures are byte-exact except the redacted
  // execution fixture, which must be preserved because its digest differs
  // from the originally published execution copy.
  const priorOrchestrator = join(skillsDir, "orchestrator", "SKILL.md");
  const priorRecovery = join(skillsDir, "orchestrator", "references", "recovery.md");
  const priorExecution = join(skillsDir, "execution", "SKILL.md");
  const modifiedResearch = join(skillsDir, "research", "SKILL.md");
  const unrelatedFile = join(skillsDir, "execution", "user-notes.md");
  await Promise.all([
    mkdir(join(skillsDir, "orchestrator", "references"), { recursive: true }),
    mkdir(join(skillsDir, "execution"), { recursive: true }),
    mkdir(join(skillsDir, "research"), { recursive: true }),
  ]);
  const researchContent = (await historicalFixture("research/SKILL.md")) + "\nuser customized this copy\n";
  await Promise.all([
    writeFile(priorOrchestrator, await historicalFixture("orchestrator/SKILL.md"), "utf8"),
    writeFile(priorRecovery, await historicalFixture("orchestrator/references/recovery.md"), "utf8"),
    writeFile(priorExecution, await historicalFixture("execution/SKILL.md"), "utf8"),
    writeFile(modifiedResearch, researchContent, "utf8"),
    writeFile(unrelatedFile, "user notes\n", "utf8"),
  ]);

  await runHelper([], fixtureEnv(fixture));

  for (const name of ["pi-review-gate-orchestrator", "pi-review-gate-execution", "pi-review-gate-research", "pi-review-gate-completion"]) {
    assert.equal(
      await readFile(join(fixture.home, ".agents", "skills", name, "SKILL.md"), "utf8"),
      await readFile(resolve(`skills/${name}/SKILL.md`), "utf8"),
      `the ${name} skill must be provisioned during the migration launch`,
    );
  }
  for (const removed of [priorOrchestrator, priorRecovery]) {
    assert.equal(await pathExists(removed), false, `the proven prior copy must be migrated away: ${removed}`);
  }
  assert.equal(await readFile(priorExecution, "utf8"), await historicalFixture("execution/SKILL.md"),
    "the redacted fixture is not the originally published execution copy and must be preserved");
  assert.equal(await readFile(modifiedResearch, "utf8"), researchContent, "a modified generic copy must be preserved");
  assert.equal(await readFile(unrelatedFile, "utf8"), "user notes\n", "unrelated files under old skill directories must be preserved");
  assert.equal(await pathExists(join(skillsDir, "orchestrator")), true, "old directories are never removed");
});

test("launcher helper preserves customized generic copies that normalize to shipped content and keeps recovery.md for a customized orchestrator (#154)", async () => {
  const fixture = await makeFixture("pi-review-cmd-skill-ownership-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const skillsDir = join(fixture.home, ".agents", "skills");
  // Regression cases for the ownership proof (issue 154): content that a
  // transform-before-compare proof would wrongly classify as unmodified.
  const fullyRenamedExecution = join(skillsDir, "execution", "SKILL.md");
  const partiallyRenamedOrchestrator = join(skillsDir, "orchestrator", "SKILL.md");
  const genericRecovery = join(skillsDir, "orchestrator", "references", "recovery.md");
  await Promise.all([
    mkdir(join(skillsDir, "orchestrator", "references"), { recursive: true }),
    mkdir(join(skillsDir, "execution"), { recursive: true }),
  ]);
  // Fully renamed: the user placed the current namespaced execution skill
  // content at the generic path themselves (normalizes under the old rename
  // transform, but is not the historical generic copy).
  const executionCopy = await readFile(resolve("skills/pi-review-gate-execution/SKILL.md"), "utf8");
  // Partially renamed and customized: namespaced name and one namespaced
  // link, but the other link and an added note are user customization.
  const orchestratorCustom = (await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"))
    .split("name: pi-review-gate-orchestrator").join("name: orchestrator")
    .split("../pi-review-gate-execution/SKILL.md").join("../execution/SKILL.md")
    + "\nuser customized this copy\n";
  // The true historical recovery bytes (recovery.md carried no namespacing
  // edits, so the fixture is byte-exact) support the customized generic
  // orchestrator SKILL.md above: deleting them would break the customized
  // skill's reference, so the pairing gate must preserve them.
  const recoveryCopy = await historicalFixture("orchestrator/references/recovery.md");
  await Promise.all([
    writeFile(fullyRenamedExecution, executionCopy, "utf8"),
    writeFile(partiallyRenamedOrchestrator, orchestratorCustom, "utf8"),
    writeFile(genericRecovery, recoveryCopy, "utf8"),
  ]);

  const result = await runHelper([], fixtureEnv(fixture));

  assert.equal(await readFile(fullyRenamedExecution, "utf8"), executionCopy, "a fully renamed generic copy must be preserved");
  assert.equal(await readFile(partiallyRenamedOrchestrator, "utf8"), orchestratorCustom, "a partially renamed customized generic copy must be preserved");
  assert.equal(await readFile(genericRecovery, "utf8"), recoveryCopy, "recovery.md must be preserved while the customized generic orchestrator SKILL.md remains");
  assert.doesNotMatch(result.stderr, /removed the unmodified prior copy/);
});

test("launcher helper removes recovery.md together with a proven generic orchestrator SKILL.md (#154)", async () => {
  const fixture = await makeFixture("pi-review-cmd-skill-paired-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const skillsDir = join(fixture.home, ".agents", "skills");
  // Historical generic orchestrator pair (immutable fixtures): when the
  // SKILL.md is proven unmodified and removed, the proven recovery.md goes
  // with it.
  const priorOrchestrator = join(skillsDir, "orchestrator", "SKILL.md");
  const priorRecovery = join(skillsDir, "orchestrator", "references", "recovery.md");
  await mkdir(join(skillsDir, "orchestrator", "references"), { recursive: true });
  await Promise.all([
    writeFile(priorOrchestrator, await historicalFixture("orchestrator/SKILL.md"), "utf8"),
    writeFile(priorRecovery, await historicalFixture("orchestrator/references/recovery.md"), "utf8"),
  ]);

  const result = await runHelper([], fixtureEnv(fixture));

  assert.equal(await pathExists(priorOrchestrator), false, "the proven generic orchestrator SKILL.md must be migrated away");
  assert.equal(await pathExists(priorRecovery), false, "the proven generic recovery.md must be removed with its paired SKILL.md");
  assert.match(result.stderr, /removed the unmodified prior copy/);
});

test("launcher helper preserves generic copies whose bytes differ from the shipped historical bytes (CRLF)", async () => {
  // The ownership proof is an exact match between the installed bytes and the
  // recorded historical digest — the immutable LF bytes the package shipped
  // (preserved under tests/fixtures/skill-migration/). Content that only
  // normalizes to the historical text under a line-ending transform — for
  // example a CRLF copy, which is exactly what a Windows checkout with
  // core.autocrlf=true produces for files not pinned in .gitattributes (the
  // PR 169 Windows launcher CI failure) — is not the proven package-owned
  // copy and must be preserved fail-closed. Recognizing it would require
  // transforming the installed content before comparing, which is
  // non-injective and could classify customized bytes as unmodified; the
  // checkout itself is pinned LF instead (.gitattributes: skills/**/*.md and
  // the fixture pin).
  const fixture = await makeFixture("pi-review-cmd-skill-crlf-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const skillsDir = join(fixture.home, ".agents", "skills");
  const crlf = (content: string): string => content.replace(/\r\n|\n/g, "\r\n");
  // CRLF versions of the true historical bytes (immutable fixtures): a
  // line-ending transform is not the proven package-owned copy and must be
  // preserved fail-closed.
  const priorOrchestrator = join(skillsDir, "orchestrator", "SKILL.md");
  const priorRecovery = join(skillsDir, "orchestrator", "references", "recovery.md");
  const orchestratorCrlf = crlf(await historicalFixture("orchestrator/SKILL.md"));
  const recoveryCrlf = crlf(await historicalFixture("orchestrator/references/recovery.md"));
  await mkdir(join(skillsDir, "orchestrator", "references"), { recursive: true });
  await Promise.all([
    writeFile(priorOrchestrator, orchestratorCrlf, "utf8"),
    writeFile(priorRecovery, recoveryCrlf, "utf8"),
  ]);

  const result = await runHelper([], fixtureEnv(fixture));

  assert.equal(await readFile(priorOrchestrator, "utf8"), orchestratorCrlf,
    "a generic copy whose bytes differ from the shipped historical bytes must be preserved byte for byte");
  assert.equal(await readFile(priorRecovery, "utf8"), recoveryCrlf,
    "the paired recovery.md must stay with its preserved generic orchestrator");
  assert.doesNotMatch(result.stderr, /removed the unmodified prior copy/);
  // The namespaced skills are still provisioned alongside the preserved
  // generic copies.
  assert.equal(
    await readFile(join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"),
    "the namespaced orchestrator skill must be provisioned",
  );
});

test("shipped skill and migration-fixture markdown are pinned LF in every checkout", async () => {
  // The pre-#151 migration identity is anchored to the immutable historical
  // fixtures (tests/fixtures/skill-migration/), not to the packaged skill
  // bytes: without the fixture pin, a Windows core.autocrlf=true checkout
  // would turn the fixture bytes into CRLF, the recorded digests would stop
  // matching, and the migration silently degrades to preservation (the PR
  // 169 Windows launcher CI failure). The skills pin keeps the shipped and
  // provisioned bytes canonical LF for the same class of reason. Assert both
  // pins and the actual bytes so a dropped .gitattributes rule fails fast on
  // every platform with a clear cause instead of only surfacing in the
  // Windows job.
  const attrs = await readFile(resolve(".gitattributes"), "utf8");
  assert.match(attrs, /^skills\/\*\*\/\*\.md text eol=lf$/m,
    ".gitattributes must pin skills/**/*.md to LF: the shipped skill bytes are provisioned verbatim from the checkout");
  assert.match(attrs, /^tests\/fixtures\/skill-migration\/\*\*\/\*\.md text eol=lf$/m,
    ".gitattributes must pin the historical fixtures to LF: the migration digest anchor consumes their bytes verbatim");
  for (const entry of helperModule.SKILL_MIGRATION_PLAN) {
    const fixturePath = join("tests", "fixtures", "skill-migration", ...entry.installed);
    const bytes = await readFile(resolve(fixturePath));
    assert.equal(bytes.includes(0x0d), false,
      `the historical fixture must hold canonical LF bytes: ${fixturePath}; ` +
      `re-clone, or force a re-checkout after a line-ending policy change ` +
      `(git add --renormalize . only restages the index; git checkout-index -f -a rewrites the working tree)`);
  }
  for (const source of helperModule.SKILL_MIGRATION_PLAN.map((entry) => entry.source.join("/"))) {
    const bytes = await readFile(resolve(source));
    assert.equal(bytes.includes(0x0d), false,
      `the shipped skill file must hold canonical LF bytes: ${source}; ` +
      `re-clone, or force a re-checkout after a line-ending policy change ` +
      `(git add --renormalize . only restages the index; git checkout-index -f -a rewrites the working tree)`);
  }
});

test("launcher helper never deletes through a symlinked legacy skill path (#151)", async () => {
  const fixture = await makeFixture("pi-review-cmd-skill-alias-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const skillsDir = join(fixture.home, ".agents", "skills");
  // User alias: the legacy orchestrator directory points at the namespaced
  // one (a natural way to keep the old discoverable name working). The
  // publication then writes the namespaced files the alias resolves to.
  await mkdir(skillsDir, { recursive: true });
  const namespacedDir = join(skillsDir, "pi-review-gate-orchestrator");
  // A Windows junction target must be a directory; create it first so this
  // test does not depend on junction creation with a dangling target.
  await mkdir(namespacedDir, { recursive: true });
  await symlink(namespacedDir, join(skillsDir, "orchestrator"), isWindows ? "junction" : "dir");

  const result = await runHelper([], fixtureEnv(fixture));

  // The freshly published namespaced files must survive the migration: no
  // deletion may land on them through the alias.
  assert.equal(
    await readFile(join(skillsDir, "pi-review-gate-orchestrator", "SKILL.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"),
    "the namespaced skill must not be deleted through the aliased legacy path",
  );
  assert.equal(
    await readFile(join(skillsDir, "pi-review-gate-orchestrator", "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/references/recovery.md"), "utf8"),
    "the namespaced recovery runbook must not be deleted through the aliased legacy path",
  );
  // The alias itself is user-owned indirection: preserved untouched.
  assert.equal((await lstat(join(skillsDir, "orchestrator"))).isSymbolicLink(), true, "the user's alias symlink must be preserved");
  // No migration may claim a removal in this state.
  assert.doesNotMatch(result.stderr, /removed the unmodified prior copy/);
});

test("launcher helper fails closed when a directory appears at a skill path before publication", async () => {
  // A directory occupying the exact skill destination (as a concurrent launch
  // or interference would leave behind) must be rejected by the atomic
  // rename instead of being published into, and no pi launch may follow.
  const fixture = await makeFixture("pi-review-cmd-skill-dir-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const skillDir = join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator");
  await mkdir(join(skillDir, "SKILL.md"), { recursive: true });

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a replaceable regular file/);
  assert.ok((await stat(join(skillDir, "SKILL.md"))).isDirectory(), "the racing directory must not be removed");
  assert.deepEqual(await readdir(join(skillDir, "SKILL.md")), [], "no file may be published into the directory");
  await assertNoTempLitter(skillDir);
  assert.equal(await launchStarted(fixture), false, "the helper must not start pi when skill publication fails");
});

// ---------------------------------------------------------------------------
// Skill publication rename: transient Windows contention (deterministic seam
// regression). The native concurrent-launch test above exercises the real
// publication on every platform, but the Windows rename-contention window
// (an external scanner briefly holding a freshly closed file open without
// FILE_SHARE_DELETE, failing the MoveFileExW replace with EPERM/EACCES/EBUSY)
// is not reproducible off Windows, so the bounded retry contract itself is
// pinned through the production helper's injected seam.
// ---------------------------------------------------------------------------

const errnoError = (code: string) =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test("skill publication rename publishes whole on the first uncontended attempt", () => {
  let renames = 0;
  const sleeps: number[] = [];
  const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
    renames += 1;
  }, { sleep: () => {} });

  assert.equal(outcome.published, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.lastError, null, "an uncontended rename must report no contention");
  assert.equal(renames, 1);
});

test("skill publication rename retries transient Windows contention and publishes whole", () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
    if (calls.filter((call) => call === "rename").length < 2) {
      calls.push("rename");
      throw errnoError(calls.length === 1 ? "EPERM" : "EBUSY");
    }
    calls.push("rename");
  }, { platform: "win32", sleep: (ms) => delays.push(ms) });

  assert.equal(outcome.published, true, "a transiently contended launch must still publish");
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.lastError?.code, "EBUSY", "the contended attempt's error must be reported");
  assert.deepEqual(calls, ["rename", "rename", "rename"], "the same atomic rename is retried");
  assert.deepEqual(delays, [helperModule.SKILL_PUBLISH_RETRY_DELAY_MS, helperModule.SKILL_PUBLISH_RETRY_DELAY_MS],
    "retries must use the contracted bounded backoff");
});

test("skill publication rename fails closed after bounded retries under persistent contention", () => {
  let renames = 0;
  let sleeps = 0;
  const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
    renames += 1;
    throw errnoError("EACCES");
  }, { platform: "win32", sleep: () => { sleeps += 1; } });

  assert.equal(outcome.published, false, "persistent contention must not publish");
  assert.equal(outcome.attempts, helperModule.SKILL_PUBLISH_RETRY_ATTEMPTS, "the backoff must stay bounded");
  assert.equal(sleeps, helperModule.SKILL_PUBLISH_RETRY_ATTEMPTS - 1);
  assert.equal(outcome.lastError?.code, "EACCES", "the final error must be surfaced for diagnostics");
  assert.ok(renames === helperModule.SKILL_PUBLISH_RETRY_ATTEMPTS);
});

test("skill publication rename never retries when a directory occupies the destination", () => {
  // win32 is set explicitly so the directory exclusion — not the platform
  // guard — is what stops the retry, deterministically on every host.
  let renames = 0;
  let sleeps = 0;
  const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
    renames += 1;
    throw errnoError("EPERM");
  }, { platform: "win32", isDirectory: () => true, sleep: () => { sleeps += 1; } });

  assert.equal(outcome.published, false, "a directory at the destination must fail closed");
  assert.equal(renames, 1, "a directory race is not transient contention and must not be retried");
  assert.equal(sleeps, 0);
});

test("skill publication rename does not retry non-transient errnos", () => {
  // win32 is set explicitly so the errno filter — not the platform guard —
  // is what rejects these codes, deterministically on every host.
  for (const code of ["ENOTEMPTY", "EISDIR", "ENOENT", "EINVAL"]) {
    let renames = 0;
    let sleeps = 0;
    const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
      renames += 1;
      throw errnoError(code);
    }, { platform: "win32", sleep: () => { sleeps += 1; } });

    assert.equal(outcome.published, false, `${code} must fail closed`);
    assert.equal(renames, 1, `${code} must not be retried`);
    assert.equal(sleeps, 0, `${code} must fail immediately`);
  }
});

test("skill publication rename does not retry on POSIX", () => {
  // POSIX rename(2) has no sharing violations: an EPERM there is a real
  // failure and must stay a single fail-closed attempt.
  let renames = 0;
  const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
    renames += 1;
    throw errnoError("EPERM");
  }, { platform: "linux", sleep: () => { throw new Error("no POSIX retry may sleep"); } });

  assert.equal(outcome.published, false);
  assert.equal(renames, 1);
});

test("skill publication rename probes the real destination for the directory fail-closed check", () => {
  // The production default (no isDirectory override) must inspect the real
  // destination: a genuine directory there stops the retry and fails closed.
  // win32 is set explicitly so the real-filesystem exclusion — not the
  // platform guard — executes, deterministically on every host.
  const scratch = mkdtempSync(join(tmpdir(), "pi-review-cmd-rename-dir-"));
  try {
    const occupied = join(scratch, "SKILL.md");
    mkdirSync(occupied);
    let renames = 0;
    const outcome = helperModule.renameIntoPlaceWithContentionRetry(() => {
      renames += 1;
      throw errnoError("EPERM");
    }, { destination: occupied, platform: "win32", sleep: () => { throw new Error("a directory destination must not be retried"); } });

    assert.equal(outcome.published, false);
    assert.equal(renames, 1);

    // A destination that is absent or a regular file keeps the transient
    // retry available (the normal concurrent-launch state).
    const absent = join(scratch, "absent.md");
    const retryable = helperModule.renameIntoPlaceWithContentionRetry(() => {
      renames += 1;
      throw errnoError("EPERM");
    }, { destination: absent, platform: "win32", attempts: 2, delayMs: 1, sleep: () => {} });
    assert.equal(retryable.published, false);
    assert.equal(renames, 3, "an absent destination must keep the bounded retry");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Coordination diagnostics for the concurrent first-launch race.
//
// The eight-racer test below is the one place launch coordination contention is
// reproducible, and its busy-path message alone says nothing about which branch
// produced it. A test-only observational preload
// (tests/fixtures/launcher-coordination-diagnostic.cjs) is appended to the
// racers' inherited NODE_OPTIONS. It keeps bounded fixed-code evidence about the
// fixture's own synthetic application state directory and the native PowerShell
// owner-birth probe, and it changes nothing the launcher observes. The evidence
// is printed as `t.diagnostic` records BEFORE the first status assertion so a
// failing racer's log keeps every racer's report. These records are evidence
// about a failure, never a pass/fail signal; a missing or unusable report is
// reported as `unknown`.
//
// Evidence limits, stated honestly: the aggregate counters discriminate what was
// OBSERVED — a non-EEXIST filesystem refusal, an unexpected state-root kind, or
// repeated canonical-entry contention whose owner-record probes consumed the
// bounded wait — plus whether the exact initial-selection busy message was
// written (the later publication-busy message is not classified). They are not
// proof of the branch the product finally returned, and this test neither
// claims a root cause nor treats a green diagnostic run as resolving the race.
// ---------------------------------------------------------------------------

const coordinationDiagnosticPreload = resolve("tests/fixtures/launcher-coordination-diagnostic.cjs");
const coordinationDiagnosticDirEnv = "PRG_LAUNCHER_COORDINATION_DIAGNOSTIC_DIR";
const coordinationDiagnosticStateRootEnv = "PRG_LAUNCHER_COORDINATION_DIAGNOSTIC_STATE_ROOT";
const coordinationDiagnosticSchema = "prg-launcher-coordination-diagnostic/1";
const coordinationDiagnosticMaxReportBytes = 8192;
const coordinationDiagnosticMaxReports = 4;
const coordinationBusyMessage = "application state coordination is busy right now";

/**
 * Append the diagnostic preload to a racer's environment without disturbing an
 * inherited NODE_OPTIONS (the same portable encoding the spawn recorder uses).
 */
function coordinationDiagnosticEnv(
  env: NodeJS.ProcessEnv,
  diagnosticDir: string,
  stateRoot: string,
): NodeJS.ProcessEnv {
  const inherited = env.NODE_OPTIONS === undefined || env.NODE_OPTIONS.length === 0 ? "" : `${env.NODE_OPTIONS} `;
  return {
    ...env,
    NODE_OPTIONS: `${inherited}${nodeOptionsPreload(coordinationDiagnosticPreload)}`,
    [coordinationDiagnosticDirEnv]: diagnosticDir,
    [coordinationDiagnosticStateRootEnv]: stateRoot,
  };
}

/**
 * Read one racer's bounded reports as a compact fixed-shape summary. A missing,
 * corrupt, oversized, or unexpected report is summarized as `unknown` with a
 * fixed reason code and is never summarized as success. Passing racers keep only
 * their aggregate counters; a racer that did not exit 0 keeps its bounded event
 * tail (and birth-probe samples) as the evidence for that failure.
 */
async function readCoordinationDiagnostics(directory: string, includeEvents: boolean): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /^report-[0-9]{1,10}\.json$/u.test(name)).sort();
  } catch {
    return "unknown(no-report-directory)";
  }
  if (names.length === 0) return "unknown(no-report-written)";
  const summaries: string[] = [];
  for (const name of names.slice(0, coordinationDiagnosticMaxReports)) {
    try {
      const file = join(directory, name);
      const info = await lstat(file);
      if (!info.isFile()) {
        summaries.push("unknown(not-a-regular-file)");
        continue;
      }
      if (info.size > coordinationDiagnosticMaxReportBytes) {
        summaries.push("unknown(report-too-large)");
        continue;
      }
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (
        parsed === null
        || typeof parsed !== "object"
        || (parsed as { schema?: unknown }).schema !== coordinationDiagnosticSchema
      ) {
        summaries.push("unknown(unexpected-schema)");
        continue;
      }
      const report = parsed as Record<string, unknown>;
      const reportedEvents = report.events;
      if (!includeEvents && Array.isArray(reportedEvents)) {
        summaries.push(JSON.stringify({ ...report, events: [], omittedEvents: reportedEvents.length }));
        continue;
      }
      summaries.push(JSON.stringify(report));
    } catch {
      summaries.push("unknown(corrupt-report)");
    }
  }
  const extra = names.length > coordinationDiagnosticMaxReports
    ? `;unknown(${names.length - coordinationDiagnosticMaxReports}-more-reports)`
    : "";
  return `${summaries.join(";")}${extra}`;
}

test("concurrent first launches never clobber or expose partial JSON", async (t) => {
  const fixture = await makeFixture("pi-review-cmd-race-");
  const diagnosticRoot = join(fixture.root, "coordination-diagnostics");
  const stateRoot = prepareModule.applicationStateRoot(fixture.agentDir);
  const racers = await Promise.all(
    Array.from({ length: 8 }, async (_value, index) => {
      const capture = join(fixture.root, `capture-${index + 1}`);
      await mkdir(capture, { recursive: true });
      const diagnosticDir = join(diagnosticRoot, `racer-${index + 1}`);
      await mkdir(diagnosticDir, { recursive: true });
      const env = fixtureEnv(fixture);
      env.CAPTURE_DIR = capture;
      env.CAPTURE_FILE = join(capture, "pi.json");
      const outcome = await runHelperExpectingFailure(
        [],
        coordinationDiagnosticEnv(env, diagnosticDir, stateRoot),
      );
      return { outcome, diagnosticDir };
    }),
  );

  // Diagnostic-only evidence, emitted before the first status assertion so a
  // failing racer's CI log keeps all eight bounded reports. No assertion below
  // is added, relaxed, or reordered for these records.
  const diagnostics = await Promise.all(
    racers.map((racer) => readCoordinationDiagnostics(racer.diagnosticDir, racer.outcome.status !== 0)),
  );
  racers.forEach((racer, index) => {
    t.diagnostic(
      `coordination racer ${index + 1}: status=${racer.outcome.status} `
      + `busyMessage=${racer.outcome.stderr.includes(coordinationBusyMessage)} `
      + `diagnostic=${diagnostics[index]}`,
    );
  });

  for (const { outcome } of racers) {
    assert.equal(outcome.status, 0, `a racer failed: ${outcome.stderr}`);
    assert.doesNotMatch(
      outcome.stderr,
      /refusing to|could not (create|write|set)|unexpected failure/,
      "racers must not report initialization failures",
    );
  }
  const fileStat = await stat(fixture.defaultConfigPath);
  assert.ok(fileStat.isFile());
  if (!isWindows) {
    assert.equal(await posixMode(fixture.defaultConfigPath), 0o600);
  }
  const generated = JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")) as unknown;
  assert.deepEqual(generated, zeroModelDefaultConfig, "the surviving config must be the complete default");
  await assertNoTempLitter(fixture.agentDir);
  const skillDir = join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator");
  assert.equal(
    await readFile(join(skillDir, "SKILL.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"),
    "the surviving skill must be complete and current",
  );
  assert.equal(
    await readFile(join(skillDir, "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/references/recovery.md"), "utf8"),
  );
  await assertNoTempLitter(skillDir);
});

/**
 * The fixed, bounded schema the coordination diagnostic preload writes. Every
 * field is a number, a boolean, a null, or a fixed code; there are no free-form
 * strings, and no path, argument, token, lock body, or environment value.
 */
interface CoordinationDiagnosticReport {
  schema: string;
  pid: number;
  nodeVersion: string;
  platform: string;
  entry: "launcher-helper" | "descendant" | "unknown-entry";
  stateRoot: {
    kind: string;
    errno: string | null;
    firstKind: string;
    firstErrno: string | null;
    lstatAttempts: number;
  };
  ops: Record<"lstat" | "open" | "link" | "write" | "fsync" | "unlink" | "close", number>;
  errno: Array<{ op: string; code: string; count: number }>;
  errnoOverflow: number;
  scopedOps: number;
  cleanupLock: {
    attempts: number;
    acquired: number;
    eexist: number;
    ownerRecordReads: number;
    released: number;
    reclaimUnlinks: number;
    holdMsTotal: number;
    holdMsMax: number;
    heldAtExit: boolean;
  };
  birthProbe: {
    calls: number;
    self: number;
    foreign: number;
    ok: number;
    failed: number;
    timedOut: number;
    totalMs: number;
    maxMs: number;
    lastErrno: string | null;
    lastSignal: string | null;
    probes: Array<{ atMs: number; ms: number; self: boolean; code: string | null }>;
  };
  events: Array<{ op: string; target: string; code: string | null; atMs: number; ms: number }>;
  truncated: boolean;
  droppedEvents: number;
  unknown: string[];
}

const coordinationDiagnosticEventOps = ["lstat", "open", "link", "write", "fsync", "unlink", "close"];
const coordinationDiagnosticEventTargets = ["state-root", "cleanup-lock", "lock-candidate", "state-other"];

/** A driver that exercises the exact wrapped calls without the launcher. */
const coordinationDiagnosticDriver = [
  '"use strict";',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const stateRoot = process.env.PRG_DIAGNOSTIC_CONTRACT_ROOT;',
  'const fingerprint = [];',
  'const record = (op, run) => {',
  '  try {',
  '    const value = run();',
  '    fingerprint.push({ op, ok: true, kind: value === undefined ? "undefined" : typeof value });',
  '  } catch (error) {',
  '    fingerprint.push({',
  '      op,',
  '      ok: false,',
  '      name: error && error.name,',
  '      code: (error && error.code) ?? null,',
  '      syscall: (error && error.syscall) ?? null,',
  '      keepsPath: typeof (error && error.path) === "string",',
  '    });',
  '  }',
  '};',
  'const nested = path.join(stateRoot, "nested");',
  'const missing = path.join(stateRoot, "missing.json");',
  'const candidate = path.join(stateRoot, ".cleanup.lock.1234.abcdef");',
  'const lockFile = path.join(stateRoot, "cleanup.lock");',
  'const outside = path.join(path.dirname(stateRoot), "outside", "unscoped.txt");',
  'record("mkdir", () => fs.mkdirSync(nested, { recursive: true }));',
  'record("mkdir-outside", () => fs.mkdirSync(path.dirname(outside), { recursive: true }));',
  'record("lstat-directory", () => fs.lstatSync(nested, { bigint: true }).isDirectory());',
  'record("lstat-missing", () => fs.lstatSync(missing, { bigint: true }).isFile());',
  'record("open-candidate", () => {',
  '  const fd = fs.openSync(candidate, "wx", 0o600);',
  '  fs.writeFileSync(fd, "observation-body\\n");',
  '  fs.fsyncSync(fd);',
  '  fs.closeSync(fd);',
  '  return fd;',
  '});',
  'record("link", () => { fs.linkSync(candidate, lockFile); });',
  'record("link-again", () => { fs.linkSync(candidate, lockFile); });',
  'record("open-missing", () => fs.openSync(path.join(stateRoot, "absent.lock"), "r"));',
  'record("unlink-candidate", () => { fs.unlinkSync(candidate); });',
  'record("unlink-lock", () => { fs.unlinkSync(lockFile); });',
  'record("lstat-outside", () => { fs.writeFileSync(outside, "unscoped\\n"); return fs.lstatSync(outside).isFile(); });',
  'fs.writeFileSync(process.env.PRG_DIAGNOSTIC_CONTRACT_OUTPUT, JSON.stringify(fingerprint));',
  "",
].join("\n");

/**
 * The observational preload is only acceptable if it is exactly that. This
 * contract test runs the same driver twice — once with the preload and once
 * without — and requires identical observable behavior (return shapes plus each
 * thrown error's name, errno, syscall, and `path` presence), then validates that
 * the report is bounded and made only of fixed fields.
 *
 * The honest limit: this proves observable equivalence against the unwrapped
 * implementation. It cannot distinguish a wrapper that rethrew a lookalike error
 * object carrying identical fields, which is why the fixture returns and rethrows
 * the original call's value/error directly instead of reconstructing them.
 */
test("coordination diagnostic preload observes without changing filesystem behavior", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-diagnostic-contract-"));
  try {
    const diagnosticDir = join(scratch, "diagnostic");
    await mkdir(diagnosticDir, { recursive: true });

    const runDriver = async (withPreload: boolean) => {
      const runRoot = join(scratch, withPreload ? "instrumented" : "control");
      const stateRoot = join(runRoot, "application");
      await mkdir(stateRoot, { recursive: true });
      const output = join(runRoot, "fingerprint.json");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PRG_DIAGNOSTIC_CONTRACT_ROOT: stateRoot,
        PRG_DIAGNOSTIC_CONTRACT_OUTPUT: output,
      };
      delete env.NODE_OPTIONS;
      if (withPreload) {
        env.NODE_OPTIONS = nodeOptionsPreload(coordinationDiagnosticPreload);
        env[coordinationDiagnosticDirEnv] = diagnosticDir;
        env[coordinationDiagnosticStateRootEnv] = stateRoot;
      }
      const result = spawnSync(process.execPath, ["-e", coordinationDiagnosticDriver], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `diagnostic contract driver failed: ${result.stderr}`);
      return JSON.parse(await readFile(output, "utf8")) as unknown;
    };

    const control = await runDriver(false);
    const instrumented = await runDriver(true);
    assert.deepEqual(
      instrumented,
      control,
      "the diagnostic wrappers must leave every return value, error identity field, and errno unchanged",
    );

    const reports = (await readdir(diagnosticDir)).filter((name) => /^report-[0-9]{1,10}\.json$/u.test(name));
    assert.equal(reports.length, 1, "an instrumented process writes exactly one bounded report");
    const raw = await readFile(join(diagnosticDir, reports[0]), "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") <= coordinationDiagnosticMaxReportBytes,
      "the report must stay within its bounded size");
    const report = JSON.parse(raw) as CoordinationDiagnosticReport;

    assert.equal(report.schema, coordinationDiagnosticSchema);
    assert.ok(Number.isInteger(report.pid) && report.pid > 0);
    assert.match(report.nodeVersion, /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u);
    assert.equal(report.platform, process.platform);
    assert.notEqual(report.entry, "launcher-helper", "a -e driver is not the launcher helper");

    // Scoping is exact: the directory probe and the linked lock record are
    // observed; the sibling unscoped file is not.
    assert.deepEqual(report.ops, { lstat: 2, open: 2, link: 2, write: 1, fsync: 1, unlink: 1, close: 0 });
    assert.deepEqual(report.errno, [
      { op: "lstat", code: "ENOENT", count: 1 },
      { op: "link", code: "EEXIST", count: 1 },
      { op: "open", code: "ENOENT", count: 1 },
    ]);
    assert.equal(report.errnoOverflow, 0);
    assert.equal(report.scopedOps, 9);

    // The state root itself was never probed by this driver, and the preload
    // says so instead of inventing a kind.
    assert.deepEqual(report.stateRoot, {
      kind: "not-observed",
      errno: null,
      firstKind: "not-observed",
      firstErrno: null,
      lstatAttempts: 0,
    });
    assert.equal(report.cleanupLock.attempts, 2);
    assert.equal(report.cleanupLock.acquired, 1);
    assert.equal(report.cleanupLock.eexist, 1);
    assert.equal(report.cleanupLock.released, 1);
    assert.equal(report.cleanupLock.reclaimUnlinks, 0);
    assert.equal(report.cleanupLock.heldAtExit, false);
    assert.ok(Number.isInteger(report.cleanupLock.holdMsTotal) && report.cleanupLock.holdMsTotal >= 0);
    assert.equal(report.birthProbe.calls, 0, "no PowerShell birth probe runs outside native Windows");
    assert.deepEqual(report.birthProbe.probes, []);

    assert.equal(report.truncated, false);
    assert.equal(report.droppedEvents, 0);
    assert.deepEqual(report.unknown, []);
    assert.ok(report.events.length <= 32, "the event tail must stay bounded");
    assert.equal(report.events.length, 9);
    for (const event of report.events) {
      assert.ok(coordinationDiagnosticEventOps.includes(event.op), `fixed op code: ${String(event.op)}`);
      assert.ok(coordinationDiagnosticEventTargets.includes(event.target), `fixed target code: ${String(event.target)}`);
      assert.ok(
        event.code === null || (typeof event.code === "string" && /^[A-Z][A-Z0-9_]{0,15}$/u.test(event.code)),
        `bounded safe errno code: ${String(event.code)}`,
      );
      assert.ok(Number.isInteger(event.atMs) && event.atMs >= 0);
      assert.ok(Number.isInteger(event.ms) && event.ms >= 0);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DDGS provisioning parity (POSIX execution seam with stubbed python; the
// native Windows provisioning itself is covered by the win32-only tests).
// ---------------------------------------------------------------------------

/** Honest evidence boundary for the POSIX bash-stub DDGS tests on Windows. */
const posixDdgsSkipReason =
  "POSIX bash-stub coverage; the native Windows equivalents below drive the real helper, .cmd entry point and Python";

/**
 * Scenario for the POSIX stub venv interpreter used by the helper's DDGS
 * provisioning tests. Each scenario records every invocation and applies only
 * the provisioning behavior it names, so the recorded sequence proves exactly
 * which validations and repairs ran (issue 344: one warm validation pair).
 */
type DdgsStubScenario =
  | "valid"
  | "version-fail-first"
  | "pip-fail-first"
  | "version-always-invalid"
  | "post-repair-pip-invalid"
  | "install-fails";

/**
 * A POSIX stub venv python. "invalid until repaired" scenarios become valid
 * only after the stub itself served the pinned pip install, so a launch that
 * continues proves the helper revalidated the repaired environment from
 * scratch instead of trusting the install that just ran.
 */
function venvPythonStub(scenario: DdgsStubScenario): string {
  const repaired = '[[ -f "$CAPTURE_DIR/ddgs-installed" ]]';
  const versionCheck: Record<DdgsStubScenario, string[]> = {
    valid: ["exit 0"],
    "version-fail-first": [`${repaired} && exit 0`, "exit 1"],
    "pip-fail-first": ["exit 0"],
    "version-always-invalid": ["exit 1"],
    "post-repair-pip-invalid": [`${repaired} && exit 0`, "exit 1"],
    "install-fails": ["exit 1"],
  };
  const pipCheck: Record<DdgsStubScenario, string[]> = {
    valid: ["exit 0"],
    "version-fail-first": ["exit 0"],
    "pip-fail-first": [`${repaired} && exit 0`, "exit 1"],
    "version-always-invalid": ["exit 0"],
    "post-repair-pip-invalid": ["exit 1"],
    "install-fails": ["exit 0"],
  };
  return [
    "#!/usr/bin/env bash",
    "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
    'if [[ "$1" == "-I" && "$2" == "-c" ]]; then',
    ...versionCheck[scenario].map((line) => `  ${line}`),
    'elif [[ "$1" == "-I" && "$2" == "-m" && "$3" == "pip" && "$4" == "install" ]]; then',
    '  : > "$CAPTURE_DIR/ddgs-installed"',
    `  exit ${scenario === "install-fails" ? 7 : 0}`,
    'elif [[ "$1" == "-I" && "$2" == "-m" && "$3" == "pip" && "$4" == "check" ]]; then',
    ...pipCheck[scenario].map((line) => `  ${line}`),
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** Classify one recorded python invocation by the DDGS step it represents. */
function ddgsCallKind(args: string[]): "version" | "pip-check" | "install" | "venv" | "probe" | "other" {
  if (args[0] !== "-I") return "other";
  if (args[1] === "-c" && args[2]?.includes("import ddgs")) return "version";
  if (args[1] === "-c" && args[2] === "import sys") return "probe";
  if (args[1] === "-m" && args[2] === "pip" && args[3] === "check") return "pip-check";
  if (args[1] === "-m" && args[2] === "pip" && args[3] === "install") return "install";
  if (args[1] === "-m" && args[2] === "venv") return "venv";
  return "other";
}

/** One recorded stub invocation, classified by the DDGS step it represents. */
interface DdgsPythonCall {
  args: string[];
  kind: ReturnType<typeof ddgsCallKind>;
}

function classifyDdgsCalls(calls: Array<{ args: string[] }>): DdgsPythonCall[] {
  return calls.map((call) => ({ args: call.args, kind: ddgsCallKind(call.args) }));
}

function ddgsPythonCalls(raw: string): DdgsPythonCall[] {
  const lines = raw.split("\n").filter(Boolean);
  return classifyDdgsCalls(lines.map((line) => ({ args: line.split("\t").slice(1) })));
}

async function recordedDdgsCalls(fixture: Fixture): Promise<DdgsPythonCall[]> {
  return ddgsPythonCalls(await readFile(join(fixture.capture, "python-calls"), "utf8"));
}

function callKinds(calls: DdgsPythonCall[]): string[] {
  return calls.map((call) => call.kind);
}

function assertIsolatedPythonCalls(calls: DdgsPythonCall[]): void {
  for (const call of calls) {
    assert.equal(call.args[0], "-I", `Python invocation not in isolated mode: ${call.args.join(" ")}`);
  }
}

async function stageDdgsStubScenario(fixture: Fixture, scenario: DdgsStubScenario): Promise<void> {
  const venvPythonPath = join(fixture.ddgsVenv, "bin", "python");
  await writeFile(venvPythonPath, venvPythonStub(scenario), "utf8");
  await chmod(venvPythonPath, 0o755);
}

test("shell and native provisioning select the same DDGS version", async () => {
  const script = await readFile(resolve("scripts/ensure-ddgs.sh"), "utf8");
  assert.equal(/^DDGS_VERSION="([^"]+)"/m.exec(script)?.[1], helperModule.DDGS_VERSION);
});

test("helper validates a valid cached DDGS venv exactly once without provisioning", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-cached-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  await stageDdgsStubScenario(fixture, "valid");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/,
    "a valid cached venv must be neither created nor reinstalled");
  const calls = await recordedDdgsCalls(fixture);
  // A warm launch runs the full isolated validation once: the pinned version
  // import followed by the dependency check. The former duplicate second
  // validation pair (four python invocations) is deliberately gone, and this
  // count is the issue-344 contract rather than incidental output.
  assert.deepEqual(callKinds(calls), ["version", "pip-check"],
    "a warm launch must run exactly one version import and one pip check");
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), true, "a validated cached venv must let the launch continue");
});

test("helper validation counts are observable through the spawn recorder", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  // Exercises the exact spawn-recording seam the win32-only real-Python count
  // tests rely on, so a recorder defect surfaces on every platform instead of
  // only on native Windows CI.
  const fixture = await makeFixture("pi-review-cmd-ddgs-recorder-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  await stageDdgsStubScenario(fixture, "valid");
  const recorder = await writeSpawnRecorder(fixture);
  const venvPython = join(fixture.ddgsVenv, "bin", "python");

  const result = await execFileAsync(process.execPath, ["--require", recorder, helperPath], { env: fixtureEnv(fixture) });

  assert.equal(await launchStarted(fixture), true, `stderr: ${result.stderr}`);
  const calls = await recordedPythonSpawns(fixture, venvPython);
  assert.deepEqual(callKinds(calls), ["version", "pip-check"],
    `the helper must spawn exactly one validation pair: ${JSON.stringify(callKinds(calls))}`);
  assertIsolatedPythonCalls(calls);
});

test("helper keeps DDGS validation isolated when the working directory shadows modules", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-shadow-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  await stageDdgsStubScenario(fixture, "valid");
  // An untrusted reviewed repository as the helper's working directory: every
  // validation still has to run in isolated mode (-I). The real-Python
  // counterpart of this guard (a shadow module that would actually execute)
  // lives in tests/launcher.test.ts for scripts/ensure-ddgs.sh.
  const untrusted = join(fixture.root, "untrusted reviewed checkout");
  await mkdir(untrusted, { recursive: true });
  for (const name of ["ddgs.py", "pip.py", "venv.py"]) {
    await writeFile(join(untrusted, name), "raise SystemExit('a reviewed repository shadow module must never run')\n", "utf8");
  }

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture), untrusted);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const calls = await recordedDdgsCalls(fixture);
  assert.deepEqual(callKinds(calls), ["version", "pip-check"]);
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), true);
});

test("helper repairs an invalid cached venv and revalidates the full contract", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-repair-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  await stageDdgsStubScenario(fixture, "version-fail-first");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0, `repair must let the launch continue: ${result.stderr}`);
  assert.match(result.stderr, /installing DDGS/);
  const calls = await recordedDdgsCalls(fixture);
  // One failed initial validation, one pinned install, then the complete
  // post-repair contract: version import and dependency check.
  assert.deepEqual(callKinds(calls), ["version", "install", "version", "pip-check"],
    `repair must revalidate the full contract once: ${JSON.stringify(callKinds(calls))}`);
  const install = calls.find((call) => call.kind === "install");
  assert.ok(install, "expected a pip install invocation");
  assert.ok(install.args.includes(`ddgs==${helperModule.DDGS_VERSION}`),
    "the pinned ddgs version must be installed");
  for (const flag of ["--only-binary=:all:", "--no-cache-dir", "--no-input", "--disable-pip-version-check"]) {
    assert.ok(install.args.includes(flag), `the pinned resolver flags must be unchanged: missing ${flag}`);
  }
  assert.ok(install.args.includes("--upgrade"), "repair must upgrade the selected dependency graph");
  assert.equal(install.args[install.args.indexOf("--upgrade-strategy") + 1], "eager",
    "repair must eagerly resolve compatible transitive upgrades");
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), true, "a repaired venv must let the launch continue");
  assert.equal((await capturedLaunch(fixture)).ddgsEnv, join(fixture.ddgsVenv, "bin", "python"));
});

test("helper repairs an inconsistent dependency graph and revalidates the full contract", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-repair-graph-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  await stageDdgsStubScenario(fixture, "pip-fail-first");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0, `a repaired dependency graph must let the launch continue: ${result.stderr}`);
  assert.match(result.stderr, /installing DDGS/);
  const calls = await recordedDdgsCalls(fixture);
  // The version import passes but the dependency graph is inconsistent, so the
  // repair still runs and is followed by both post-repair checks.
  assert.deepEqual(callKinds(calls), ["version", "pip-check", "install", "version", "pip-check"],
    `a pip-graph repair must revalidate fully: ${JSON.stringify(callKinds(calls))}`);
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), true,
    "a repaired dependency graph must let the launch continue");
  assert.equal((await capturedLaunch(fixture)).ddgsEnv, join(fixture.ddgsVenv, "bin", "python"));
});

test("helper refuses to continue when the DDGS venv stays broken", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-refuse-");
  await stageDdgsStubScenario(fixture, "version-always-invalid");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is unavailable or has inconsistent dependencies; refusing to continue/);
  const calls = await recordedDdgsCalls(fixture);
  // The failed version import short-circuits the dependency check, and the
  // post-repair validation fails the same way: no acceptance, no launch.
  assert.deepEqual(callKinds(calls), ["version", "install", "version"],
    `a failed post-repair version import must refuse: ${JSON.stringify(callKinds(calls))}`);
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), false, "a broken venv must stop the launch");
});

test("helper refuses when a repair leaves the dependency graph inconsistent", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-refuse-graph-");
  await stageDdgsStubScenario(fixture, "post-repair-pip-invalid");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is unavailable or has inconsistent dependencies; refusing to continue/);
  const calls = await recordedDdgsCalls(fixture);
  // A successful install is never acceptance on its own: the post-repair pip
  // check still fails, so the helper must refuse.
  assert.deepEqual(callKinds(calls), ["version", "install", "version", "pip-check"],
    `a failed post-repair pip check must refuse: ${JSON.stringify(callKinds(calls))}`);
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), false, "an inconsistently repaired venv must stop the launch");
});

test("helper propagates a failing pinned install without accepting the venv", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-install-fail-");
  await stageDdgsStubScenario(fixture, "install-fails");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 7, "the install's own exit status must propagate");
  assert.match(result.stderr, /installing DDGS/);
  assert.doesNotMatch(result.stderr, /refusing to continue/,
    "a failing install exits with its own status instead of the post-repair refusal");
  const calls = await recordedDdgsCalls(fixture);
  assert.deepEqual(callKinds(calls), ["version", "install"],
    `a failed install must never be accepted: ${JSON.stringify(callKinds(calls))}`);
  assertIsolatedPythonCalls(calls);
  assert.equal(await launchStarted(fixture), false, "a failed install must stop the launch");
});

/**
 * A python3 stub at the creation seam: it answers the helper's isolated-mode
 * probe, and `-m venv` creates the requested environment with a venv python
 * that applies the given DDGS scenario.
 */
async function stagePosixPython3Creator(fixture: Fixture, scenario: DdgsStubScenario): Promise<void> {
  const python3Shim = join(fixture.bin, "python3");
  await writeFile(python3Shim, [
    "#!/usr/bin/env bash",
    "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
    'if [[ "$3" == "import sys" ]]; then exit 0; fi',
    'if [[ "$3" == "venv" ]]; then',
    '  mkdir -p "$4/bin"',
    `  cat > "$4/bin/python" <<'STUB'`,
    venvPythonStub(scenario),
    "STUB",
    '  chmod +x "$4/bin/python"',
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"), "utf8");
  await chmod(python3Shim, 0o755);
}

test("helper provisions a fresh DDGS venv without Bash", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-fresh-", { emptyDdgsVenv: true });
  // The venv starts empty: the helper must find an interpreter (python3 first,
  // then python), create the venv, install, and export the python. The created
  // venv python fails the first ddgs validation (forcing the install path) and
  // only becomes valid after the install, so the recorded sequence proves the
  // full post-repair validation ran.
  await stagePosixPython3Creator(fixture, "version-fail-first");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /creating DDGS/);
  assert.match(result.stderr, /installing DDGS/);
  assert.equal((await capturedLaunch(fixture)).ddgsEnv, join(fixture.ddgsVenv, "bin", "python"));
  const calls = await recordedDdgsCalls(fixture);
  assert.deepEqual(callKinds(calls), ["probe", "venv", "version", "install", "version", "pip-check"],
    `creation must end in one full validation pair: ${JSON.stringify(callKinds(calls))}`);
  assert.ok(calls.some((call) => call.kind === "install" && call.args.includes(`ddgs==${helperModule.DDGS_VERSION}`)),
    "the pinned ddgs version must be installed");
  assertIsolatedPythonCalls(calls);
});

test("helper accepts a freshly created venv that is already valid without installing", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-fresh-valid-", { emptyDdgsVenv: true });
  await stagePosixPython3Creator(fixture, "valid");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /creating DDGS/);
  assert.doesNotMatch(result.stderr, /installing DDGS/,
    "a created venv that already validates must not be reinstalled");
  const calls = await recordedDdgsCalls(fixture);
  assert.deepEqual(callKinds(calls), ["probe", "venv", "version", "pip-check"],
    `a created valid venv needs exactly one validation pair: ${JSON.stringify(callKinds(calls))}`);
  assertIsolatedPythonCalls(calls);
  assert.equal((await capturedLaunch(fixture)).ddgsEnv, join(fixture.ddgsVenv, "bin", "python"));
});

test("helper fails closed when no isolated-mode Python interpreter is available", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-nopython-", { emptyDdgsVenv: true });
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  // Both probe candidates refuse: python3 (bash parity) and python (Windows
  // Store-alias reality) are unusable.
  for (const name of ["python3", "python"] as const) {
    const shimPath = join(fixture.bin, name);
    await writeFile(shimPath, "#!/usr/bin/env bash\nexit 1\n", "utf8");
    await chmod(shimPath, 0o755);
  }

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python 3 is required to provision the DDGS web-search dependency \(install Python 3\.10 or newer/);
  assert.equal(await launchStarted(fixture), false);
});

test("helper propagates a failing venv creation", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-venvfail-", { emptyDdgsVenv: true });
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  const python3Shim = join(fixture.bin, "python3");
  await writeFile(python3Shim, "#!/usr/bin/env bash\n[[ \"$3\" == \"import sys\" ]] && exit 0\nexit 3\n", "utf8");
  await chmod(python3Shim, 0o755);

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 3, "the venv toolchain's own exit status must propagate");
  assert.match(result.stderr, /could not create the DDGS/);
  assert.equal(await launchStarted(fixture), false);
});

// ---------------------------------------------------------------------------
// DDGS cache-root parity with scripts/ensure-ddgs.sh (real helper entrypoint,
// no path algorithm in the test): the default cache root must carry the
// pi-review-gate component, XDG_CACHE_HOME must relocate it, and an explicit
// PI_REVIEW_GATE_DDGS_VENV must keep winning over both.
// ---------------------------------------------------------------------------

async function ddgsCacheFixture(prefix: string): Promise<Fixture> {
  const fixture = await makeFixture(prefix);
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  return fixture;
}

test("helper provisions DDGS in the launcher's default pi-review-gate cache root", async () => {
  const fixture = await ddgsCacheFixture("pi-review-cmd-ddgs-cacheroot-");
  // A valid venv at the Bash launcher's default location
  // ${XDG_CACHE_HOME:-$HOME/.cache}/pi-review-gate/ddgs-<version> must be
  // discovered, validated (never re-provisioned) and exported as-is.
  const defaultVenv = join(fixture.home, ".cache", "pi-review-gate", `ddgs-${helperModule.DDGS_VERSION}`);
  await stageValidDdgsVenvAt(defaultVenv);
  const env = fixtureEnv(fixture);
  delete env.XDG_CACHE_HOME;
  delete env.PI_REVIEW_GATE_DDGS_VENV;

  const result = await runHelperExpectingFailure([], env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/,
    "the venv at the default pi-review-gate cache root must be treated as cached");
  const launch = await capturedLaunch(fixture);
  assert.equal(launch.ddgsEnv, helperModule.ddgsPythonPath(defaultVenv, process.platform),
    "the exported interpreter must live inside the default pi-review-gate cache root");
});

test("helper honors XDG_CACHE_HOME for the DDGS cache root", async () => {
  const fixture = await ddgsCacheFixture("pi-review-cmd-ddgs-xdg-");
  const xdgRoot = join(fixture.root, "xdg cache with spaces");
  const xdgVenv = join(xdgRoot, "pi-review-gate", `ddgs-${helperModule.DDGS_VERSION}`);
  await stageValidDdgsVenvAt(xdgVenv);
  const env = fixtureEnv(fixture, { XDG_CACHE_HOME: xdgRoot });
  delete env.PI_REVIEW_GATE_DDGS_VENV;

  const result = await runHelperExpectingFailure([], env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/,
    "the venv under XDG_CACHE_HOME/pi-review-gate must be treated as cached");
  const launch = await capturedLaunch(fixture);
  assert.equal(launch.ddgsEnv, helperModule.ddgsPythonPath(xdgVenv, process.platform));
  assert.equal(await pathExists(join(fixture.home, ".cache")), false,
    "the default cache root must stay untouched when XDG_CACHE_HOME relocates it");
});

test("an explicit PI_REVIEW_GATE_DDGS_VENV wins over the default and XDG cache roots", async () => {
  const fixture = await ddgsCacheFixture("pi-review-cmd-ddgs-explicit-");
  // A fresh location (makeFixture pre-creates its default venv directory, and
  // a junction cannot occupy an existing path on Windows).
  const explicitVenv = join(fixture.root, "explicit ddgs venv");
  await stageValidDdgsVenvAt(explicitVenv);
  const env = fixtureEnv(fixture, {
    XDG_CACHE_HOME: join(fixture.root, "xdg ignored"),
    PI_REVIEW_GATE_DDGS_VENV: explicitVenv,
  });

  const result = await runHelperExpectingFailure([], env);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/);
  const launch = await capturedLaunch(fixture);
  assert.equal(launch.ddgsEnv, helperModule.ddgsPythonPath(explicitVenv, process.platform),
    "the explicit override must win over every implicit cache root");
  assert.equal(await pathExists(join(fixture.root, "xdg ignored")), false,
    "an explicit venv override must not provision anything under XDG_CACHE_HOME");
});

// ---------------------------------------------------------------------------
// Windows-specific unit seams (run on every platform): the helper's Windows
// path/argument logic must agree with the runtime's native resolution
// (src/config-path.ts) and quote correctly for cmd.exe.
// ---------------------------------------------------------------------------

test("helper Windows agent-dir resolution mirrors the runtime contract", () => {
  const homeDir = "C:\\Users\\r";
  const resolution = { homeDir, platform: "win32" };
  for (const override of [
    undefined,
    "C:\\Users\\r\\.pi\\agent",
    "/c/Users/r/agent",
    "/mnt/c/Users/r/agent",
    "/cygdrive/c/Users/r/agent",
    "~",
    "~/agent-x",
    "~\\agent-x",
    "D:\\data dir\\agent",
  ] as const) {
    const env: NodeJS.ProcessEnv = override ? { PI_CODING_AGENT_DIR: override } : {};
    const expected = piAgentConfigPath(env, { homeDir, platform: "win32" });
    assert.equal(helperModule.piAgentConfigPath(env, resolution), expected,
      `agent-dir resolution must agree with src/config-path.ts for ${override ?? "the default"}`);
    assert.equal(helperModule.piAgentConfigPath(env, resolution), reviewGateConfigCandidates(env, { homeDir, platform: "win32" })[0]);
  }
  assert.equal(
    helperModule.compatibilityFallbackConfigPath({ homeDir, platform: "win32" }),
    reviewGateConfigCandidates({}, { homeDir, platform: "win32" })[1],
  );
  assert.equal(
    helperModule.compatibilityFallbackConfigPath({ homeDir, platform: "win32" }),
    "C:\\Users\\r\\.config\\pi-review-gate\\config.json",
  );
});

test("helper drive-path normalization matches the runtime and Pi's normalizeWindowsShellPath", () => {
  for (const [input, expected] of [
    ["/c/Users/r", "C:\\Users\\r"],
    ["/mnt/c/Users/r", "C:\\Users\\r"],
    ["/cygdrive/c/Users/r", "C:\\Users\\r"],
    ["/C", "C:\\"],
    ["//server/share", "//server/share"],
    ["C:\\back\\slash", "C:\\back\\slash"],
    ["/plain/posix", "/plain/posix"],
    ["~/home", "~/home"],
  ] as const) {
    assert.equal(helperModule.normalizeWindowsShellPath(input), expected, `input: ${input}`);
  }
});

test("helper cmd quoting survives cmd.exe's quote toggling without metachar injection", () => {
  assert.equal(helperModule.cmdQuote("example"), "example");
  assert.equal(helperModule.cmdQuote(""), '""');
  assert.equal(helperModule.cmdQuote("example model"), '"example model"');
  assert.equal(helperModule.cmdQuote("a&b"), '"a&b"');
  assert.equal(helperModule.cmdQuote("a^b"), '"a^b"');
  assert.equal(helperModule.cmdQuote("(priority)"), '"(priority)"');
  // Embedded quotes are DOUBLED, never backslash-escaped: cmd toggles its
  // quote state at every quote character and ignores backslashes, so \"
  // would end cmd's quoted region and leave & | < > ( ) ^ operating on the
  // remainder of the command line. The doubled form keeps cmd inside quotes
  // while the receiving argv parser reads the pair as one literal quote.
  assert.equal(helperModule.cmdQuote('say "hi"'), '"say ""hi"""');
  assert.equal(helperModule.cmdQuote('say "&hi"'), '"say ""&hi"""');
  assert.equal(helperModule.cmdQuote('a"b|c'), '"a""b|c"');
  // Backslash runs immediately before a quote or the closing quote are
  // doubled for the argv parser's backslash-quote rule.
  assert.equal(helperModule.cmdQuote('a"b\\'), '"a""b\\\\"');
  // A trailing backslash carries no cmd metacharacter: bare is safe (backslash
  // escaping only matters adjacent to a quote character).
  assert.equal(helperModule.cmdQuote("C:\\dir\\"), "C:\\dir\\");
  // A comma is not a cmd metacharacter for child-argv purposes: bare is safe.
  assert.equal(helperModule.cmdQuote("read,bash"), "read,bash");
});

test("helper resolves the full pi.cmd path without inspecting shim contents", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-piresolve-"));
  try {
    const bin = join(scratch, ".bin");
    await mkdir(bin, { recursive: true });
    const targetDir = join(scratch, "pkg", "bin");
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, "pi-entry.cjs");
    await writeFile(target, "process.exit(0);\n", "utf8");
    await writeFile(join(bin, "pi.cmd"), npmCmdShim("..\\pkg\\bin\\pi-entry.cjs"), "utf8");
    await writeFile(join(bin, "cmd.exe"), "path shadow stand-in\n", "utf8");
    await writeFile(join(bin, "cmd.cmd"), "@echo off\r\necho shadowed\r\n", "utf8");

    const env: NodeJS.ProcessEnv = {
      PATH: bin,
      SystemRoot: "C:\\child-controlled-root",
      ComSpec: "C:\\child-controlled-root\\System32\\cmd.exe",
    };
    const resolved = helperModule.resolveLauncherPiInvocation(env, "win32");
    assert.deepEqual(resolved, { kind: "cmd", file: join(bin, "pi.cmd") });
    const originalArgs = ["--model", "example model", "--label", "a&b|c"];
    const trustedCmd = "Z:\\Trusted Windows Root\\System32\\cmd.exe";
    const command = [join(bin, "pi.cmd"), ...originalArgs].map(helperModule.cmdQuote).join(" ");
    const [spec] = resolveSimulatedWindowsSpecs([{
      args: originalArgs,
      env,
      parentSystemRoot: "Z:\\Trusted Windows Root",
      parentSystemRootKey: "sYsTeMrOoT",
      expectedCmd: trustedCmd,
      cmdFileKind: "regular",
    }]);
    assert.deepEqual(spec.direct, {
      ok: true,
      file: trustedCmd,
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    }, "the shared launcher spec must use the absolute parent-SystemRoot cmd.exe, not childenv, PATH, or CWD shadows");
    assert.deepEqual(spec.child, spec.direct,
      "the TypeScript child resolver and launcher must use the same production spawn-spec route");
    assert.deepEqual(spec.statPaths, [trustedCmd, trustedCmd],
      "both shared routes validate the same trusted regular System32 cmd.exe");
    assert.deepEqual(helperModule.resolvePiChildSpawnSpec("custom-pi", originalArgs, env, "win32"), {
      ok: true,
      file: "custom-pi",
      args: originalArgs,
    }, "custom commands retain exact spawn semantics");

    // The command's implementation is irrelevant, even without a JS target.
    await writeFile(join(bin, "pi.cmd"), "@echo off\r\nrem opaque\r\n", "utf8");
    assert.deepEqual(helperModule.resolveLauncherPiInvocation(env, "win32"), resolved);

    // A missing pi must fail closed.
    assert.equal(helperModule.resolveLauncherPiInvocation({ PATH: join(scratch, "empty") }, "win32").kind, "missing");

    // POSIX uses plain execvp of the PATH entry.
    assert.deepEqual(helperModule.resolveLauncherPiInvocation(env, "linux"), { kind: "path" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("shared Windows Pi resolver fails closed when parent SystemRoot or its cmd.exe is unusable", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-unavailable-"));
  try {
    const bin = join(scratch, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "pi.cmd"), "@echo off\r\n", "utf8");
    const childEnv: NodeJS.ProcessEnv = {
      PATH: bin,
      SystemRoot: "C:\\child-controlled-root",
      ComSpec: "C:\\child-controlled-root\\System32\\cmd.exe",
    };
    const validRoot = "Q:\\TrustedWindows";
    const cases: SimulatedWindowsSpawnCase[] = [
      { args: [], env: childEnv, cmdFileKind: "regular" },
      { args: [], env: childEnv, parentSystemRoot: "relative\\Windows", expectedCmd: undefined, cmdFileKind: "regular" },
      { args: [], env: childEnv, parentSystemRoot: "Q:Windows", expectedCmd: undefined, cmdFileKind: "regular" },
      { args: [], env: childEnv, parentSystemRoot: "\\Windows", expectedCmd: undefined, cmdFileKind: "regular" },
      {
        args: [], env: childEnv, parentSystemRoot: validRoot,
        expectedCmd: `${validRoot}\\System32\\cmd.exe`, cmdFileKind: "missing",
      },
      {
        args: [], env: childEnv, parentSystemRoot: validRoot,
        expectedCmd: `${validRoot}\\System32\\cmd.exe`, cmdFileKind: "directory",
      },
    ];
    const results = resolveSimulatedWindowsSpecs(cases);
    for (const [index, result] of results.entries()) {
      for (const spec of [result.direct, result.child]) {
        assert.ok(!spec.ok, `scenario ${index} must not produce a spawnable fallback: ${JSON.stringify(spec)}`);
        if (!spec.ok) {
          assert.equal(spec.kind, "cmd-unavailable");
          assert.match(spec.error, /SystemRoot/);
        }
      }
      if (index < 4) {
        assert.deepEqual(result.statPaths, [], `invalid parent root ${index} must fail before probing a relative path`);
      } else {
        assert.deepEqual(result.statPaths, [cases[index].expectedCmd, cases[index].expectedCmd]);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("launcher initialization rejects a destination occupied by a directory", async () => {
  // In-process unit test of the production publication: a directory at the
  // exact destination — the state a concurrent launch can create inside the
  // discovery-to-publication window — must never be linked into and no
  // temporary file may remain.
  for (const blocked of ["primary", "fallback"] as const) {
    const fixture = await makeFixture(`pi-review-cmd-init-race-${blocked}-`, { skipNpmShim: true });
    if (blocked === "primary") {
      await mkdir(fixture.defaultConfigPath, { recursive: true });
    } else {
      await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
      await mkdir(fixture.fallbackConfigPath, { recursive: true });
    }

    const selected = helperModule.initializeDefaultReviewGateConfig(fixture.defaultConfigPath, fixture.fallbackConfigPath);

    assert.equal(selected, null, `initialization must refuse when the ${blocked} destination is occupied`);
    assert.equal(await pathExists(fixture.defaultConfigPath), blocked === "primary",
      "no config may be created beside an occupied candidate");
    const probeDir = blocked === "primary" ? fixture.agentDir : join(fixture.home, ".config", "pi-review-gate");
    await assertNoTempLitter(probeDir);
    const occupied = blocked === "primary" ? fixture.defaultConfigPath : fixture.fallbackConfigPath;
    assert.deepEqual(await readdir(occupied), [], "no file may be linked into the directory");
  }
});

test("helper ddgs python path follows the platform venv layout", () => {
  assert.equal(
    helperModule.ddgsPythonPath("C:\\cache\\ddgs-9.16.1", "win32"),
    "C:\\cache\\ddgs-9.16.1\\Scripts\\python.exe",
  );
  assert.equal(
    helperModule.ddgsPythonPath("/home/r/.cache/ddgs-9.16.1", "linux"),
    "/home/r/.cache/ddgs-9.16.1/bin/python",
  );
});

test(".cmd entry point delegates unconditionally to the helper with raw passthrough", async () => {
  const source = await readFile(cmdPath, "utf8");
  assert.ok(source.includes("\r\n"), "the batch file must keep CRLF line endings");
  // The batch must stay thin and shell-free: every argument (management verbs
  // included) is dispatched by the helper, so `call pi %*`'s extra cmd
  // re-parsing pass must never return.
  assert.match(source, /^node "%~dp0pi-review-gate-launcher\.cjs" %\*$/m,
    "the .cmd must delegate unconditionally to the helper with raw argument passthrough");
  assert.match(source, /^exit \/b %ERRORLEVEL%$/m, "the .cmd must propagate the helper's exit status");
  assert.doesNotMatch(source, /call pi|goto passthrough|if "%~1"/,
    "no batch-side verb dispatch or shell reparsing may remain");
});

// ---------------------------------------------------------------------------
// Native Windows coverage (runs on windows-latest in CI; skipped elsewhere).
// These drive the actual production .cmd entry point through cmd.exe and
// PowerShell — the paths no POSIX simulation can exercise.
// ---------------------------------------------------------------------------

function runCmd(command: string, env: NodeJS.ProcessEnv, cwd = resolve("")) {
  // windowsVerbatimArguments: the command string is already quoted exactly as
  // cmd.exe expects it; Node's default argument encoding would escape the
  // embedded quotes as \" — and cmd.exe does not honor backslash escaping, so
  // the .cmd would receive extra literal quote characters (observed on native
  // Windows CI). /c without /s lets cmd.exe preserve a fully quoted
  // executable path (its quote-preservation rule) while executing unquoted
  // command strings verbatim.
  return spawnSync("cmd.exe", ["/d", "/c", command], { env, cwd, encoding: "utf8", windowsVerbatimArguments: true });
}

/**
 * A NODE_OPTIONS preload for the helper process that records every
 * child_process.spawnSync it makes (file plus argument array), so the native
 * tests can count the real Python validations a launch runs instead of only
 * observing its output.
 */
async function writeSpawnRecorder(fixture: Fixture): Promise<string> {
  const recorder = join(fixture.root, "spawn-recorder.cjs");
  await writeFile(recorder, [
    'const cp = require("node:child_process");',
    'const fs = require("node:fs");',
    "const spawnSync = cp.spawnSync;",
    "cp.spawnSync = function (file, args, options) {",
    "  try {",
    '    fs.appendFileSync(process.env.CAPTURE_DIR + "/spawn-calls", JSON.stringify({ file: String(file), args: Array.isArray(args) ? args.map(String) : [] }) + "\\n");',
    "  } catch {}",
    "  return spawnSync.apply(this, arguments);",
    "};",
    "",
  ].join("\n"), "utf8");
  return recorder;
}

/**
 * Serialize a recorder path as a NODE_OPTIONS preload token.
 *
 * Node parses NODE_OPTIONS with its own shell-like quoting rules, where a bare
 * backslash is an escape character: a native Windows path such as
 * `C:\Users\runner\AppData\Local\Temp\spawn-recorder.cjs` would otherwise be
 * reduced to `C:UsersrunnerAppData...` and the preload would never load (the
 * reported native CI failure: "Cannot find module 'C:Users...spawn-recorder.cjs'").
 * JSON.stringify emits the doubled backslashes Node's parser unescapes back to
 * the exact native path, and keeps the one quoted token's spaces intact.
 */
function nodeOptionsPreload(recorder: string): string {
  return `--require ${JSON.stringify(recorder)}`;
}

test("the recorder preload encoding keeps native separators and spaces through NODE_OPTIONS", { skip: isWindows ? posixDdgsSkipReason : false }, () => {
  // A synthetic native-Windows spelling: the literal backslashes are exactly
  // what NODE_OPTIONS parsing would consume as escapes. Requiring the missing
  // module makes Node report the path it actually parsed, so this asserts the
  // encoding round-trips instead of only observing a passed-through string.
  const windowsStyle = "C:\\Users\\run ner\\AppData\\Local\\Temp\\spawn-recorder.cjs";
  const result = spawnSync(process.execPath, ["-e", "0"], {
    env: { ...process.env, NODE_OPTIONS: nodeOptionsPreload(windowsStyle) },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "the synthetic preload does not exist, so Node must fail to load it");
  assert.match(String(result.stderr), /Cannot find module/,
    "the preload must actually be attempted, not silently dropped");
  assert.ok(String(result.stderr).includes(windowsStyle),
    `the preload path must survive NODE_OPTIONS parsing intact: ${String(result.stderr)}`);
});

/** Classify the recorded spawns that invoked exactly this Python interpreter. */
async function recordedPythonSpawns(fixture: Fixture, python: string): Promise<DdgsPythonCall[]> {
  const raw = await readFile(join(fixture.capture, "spawn-calls"), "utf8");
  const spawns = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { file: string; args: string[] });
  return classifyDdgsCalls(spawns.filter((spawn) => spawn.file === python));
}

if (isWindows) {
  test("native launcher invokes both simple and npm pi.cmd implementations", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-shapes-");
    for (const shim of [
      '@ECHO off\r\nnode "%~dp0pi-launcher.js" %*\r\n',
      npmCmdShim("pi-launcher.js"),
    ]) {
      await writeFile(join(fixture.bin, "pi.cmd"), shim, "utf8");
      assert.equal(helperModule.resolveLauncherPiInvocation(fixtureEnv(fixture), "win32").file,
        join(fixture.bin, "pi.cmd"));
      const result = runCmd('scripts\\pi-review-gate.cmd --model "example model"',
        fixtureEnv(fixture, { PI_EXIT_CODE: "7" }));
      assert.equal(result.status, 7, `stderr: ${result.stderr}`);
      assertExtensionLaunch((await capturedLaunch(fixture)).args, ["--model", "example model"]);
    }
  });

  test("native .cmd entry point performs first launch from cmd.exe", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-first-");
    const result = runCmd("scripts\\pi-review-gate.cmd --model example", fixtureEnv(fixture));

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assertExtensionLaunch(launch.args, ["--model", "example"]);
    assert.equal(launch.configEnv, fixture.defaultConfigPath);
    assert.equal(launch.codemodeEnv, "1", "the native launch must export the codemode default");
    assert.equal(launch.ddgsEnv, join(sharedWindowsVenv ?? "", "Scripts", "python.exe"),
      "the native launch must export the provisioned DDGS python for web search");
    assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
    assert.match(String(result.stdout), /pi-review-gate config:/);
    assert.match(String(result.stderr), /created default zero-model config at/);
    await assertNoTempLitter(fixture.agentDir);
  });

  test("native .cmd repeat launch preserves the existing config and passes paths with spaces", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-repeat-");
    await mkdir(fixture.agentDir, { recursive: true });
    const prior = '{"enabled":true,"marker":"native-repeat"}\n';
    await writeFile(fixture.defaultConfigPath, prior, "utf8");

    const result = runCmd(
      'scripts\\pi-review-gate.cmd --tools "read,bash" --label "a&b" --quote "say ""hi"""',
      fixtureEnv(fixture),
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assertExtensionLaunch(launch.args, ["--tools", "read,bash", "--label", "a&b", "--quote", 'say "hi"']);
    assert.equal(launch.configEnv, fixture.defaultConfigPath);
    assert.equal(await readFile(fixture.defaultConfigPath, "utf8"), prior,
      "existing config must not be rewritten on a repeat launch");
    assert.doesNotMatch(String(result.stderr), /created default zero-model config|creating DDGS|installing DDGS/);
  });

  test("native .cmd forwards management verbs directly to pi without setup", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-verb-");
    const result = runCmd("scripts\\pi-review-gate.cmd list", fixtureEnv(fixture));

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.deepEqual(launch.args, ["list"], "the verb must pass through without the extension flag");
    assert.equal(await pathExists(fixture.agentDir), false, "no config initialization on passthrough");
    assert.equal(await pathExists(join(fixture.home, ".agents")), false, "no skill publication on passthrough");
  });

  test("native .cmd forwards management verbs with literal arguments, inherited environment and no setup", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-verb-");
    // The inherited temporary config must flow through the management
    // passthrough untouched (the helper dispatches verbs before sanitization,
    // exec-pi parity), while no setup may run.
    const inherited = join(fixture.root, "inherited.json");
    await writeFile(inherited, "{}\n", "utf8");

    const result = runCmd(
      'scripts\\pi-review-gate.cmd list --label "a&b|c^d" --caret "a^b" --quote "say ""&hi""" --pct "100%PI%"',
      fixtureEnv(fixture, { PI_REVIEW_GATE_CONFIG: inherited, PI_EXIT_CODE: "9", PI_REVIEW_GATE_CODEMODE_DEFAULT: "0" }),
    );

    assert.equal(result.status, 9, `pi's nonzero exit status must propagate: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.deepEqual(launch.args, [
      "list",
      "--label", "a&b|c^d",
      "--caret", "a^b",
      "--quote", 'say "&hi"',
      "--pct", "100%PI%",
    ], "quoted management arguments must reach the resolved pi.cmd");
    assert.equal(launch.configEnv, inherited,
      "the passthrough must keep the inherited environment");
    assert.equal((launch as { codemodeEnv?: string | null }).codemodeEnv, "0",
      "the management passthrough must not export the wrapper codemode default");
    assert.equal(await pathExists(fixture.agentDir), false, "no config initialization on passthrough");
    assert.equal(await pathExists(join(fixture.home, ".agents")), false, "no skill publication on passthrough");
    assert.equal(await pathExists(join(fixture.capture, "npm-args")), false, "no build on passthrough");
    assert.doesNotMatch(String(result.stderr), /is not recognized|is not an internal/,
      "no injected command may execute");
  });

  test("native .cmd propagates pi exit codes and stops on build failure", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-exit-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    const exited = runCmd("scripts\\pi-review-gate.cmd --model example", fixtureEnv(fixture, { PI_EXIT_CODE: "9" }));
    assert.equal(exited.status, 9, "pi's exit status must propagate through the batch entry point");

    const failedFixture = await makeFixture("pi-review-cmd-native-buildfail-");
    await mkdir(failedFixture.agentDir, { recursive: true });
    await writeFile(failedFixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    const failed = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(failedFixture, { NPM_EXIT_CODE: "5" }),
    );
    assert.equal(failed.status, 5, "the build's exit status must propagate through the batch entry point");
    assert.equal(await launchStarted(failedFixture), false,
      "pi must not be started after a failed build");
  });

  test("native .cmd works from PowerShell", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-ps-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "& '.\\scripts\\pi-review-gate.cmd' --model 'example model'; exit $LASTEXITCODE"],
      { env: fixtureEnv(fixture), cwd: resolve(""), encoding: "utf8" },
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assertExtensionLaunch(launch.args, ["--model", "example model"]);
    assert.equal(launch.configEnv, fixture.defaultConfigPath);
  });

  test("native .cmd forwards embedded quotes combined with metacharacters literally from cmd.exe", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-combo-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

    // Production entrypoint regression (review finding): arguments combining
    // embedded quotes with cmd metacharacters must reach pi byte for byte.
    // The resolved pi.cmd receives quoted arguments. An unprotected shell
    // metacharacter would surface as a "not recognized" error or wrong capture.
    const result = runCmd(
      'scripts\\pi-review-gate.cmd --label "a&b|c^d" --quote "say ""&hi""" --paren "(x)" --empty ""',
      fixtureEnv(fixture),
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(String(result.stderr), /is not recognized|is not an internal|not found/,
      "no injected command may execute");
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assertExtensionLaunch(launch.args, ["--label", "a&b|c^d", "--quote", 'say "&hi"', "--paren", "(x)", "--empty", ""]);
  });

  test("native .cmd preserves literal percent text received from PowerShell", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-percent-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

    // Check literal percent text and protected metacharacters through a real
    // PowerShell-to-batch invocation. Undefined percent variables in these
    // arguments remain literal under normal Windows command parsing.
    // PowerShell's single quotes delimit its string, but are not forwarded to
    // cmd.exe. Include literal double quotes around the metacharacter argument
    // so it stays protected both on batch entry and when %* is forwarded to
    // Node. A single layer of caret escaping is consumed on entry, exposing
    // the metacharacters during forwarding (observed on native Windows CI).
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "& '.\\scripts\\pi-review-gate.cmd' --pct '100%PI%' --label '\"a&b|c^d\"'; exit $LASTEXITCODE"],
      { env: fixtureEnv(fixture), cwd: resolve(""), encoding: "utf8" },
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assertExtensionLaunch(launch.args, ["--pct", "100%PI%", "--label", "a&b|c^d"]);
  });

  test("native helper validates a real cached DDGS venv exactly once without provisioning", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-ddgs-warm-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    // The shared venv really contains the pinned wheel, so this is a warm
    // launch driven natively through the .cmd entry point and real Python. The
    // recorder preload counts the helper's own spawns, which is what the
    // one-validation-pair contract is about (no network work is possible for a
    // valid environment: no install is spawned).
    const recorder = await writeSpawnRecorder(fixture);
    const venvPython = join(fixtureDdgsVenv(fixture), "Scripts", "python.exe");

    const result = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(fixture, { NODE_OPTIONS: nodeOptionsPreload(recorder) }),
    );

    assert.equal(result.status, 0, `stderr: ${String(result.stderr)}`);
    assert.doesNotMatch(String(result.stderr), /creating DDGS|installing DDGS/,
      "a valid shared venv must be neither created nor reinstalled");
    const calls = await recordedPythonSpawns(fixture, venvPython);
    assert.deepEqual(callKinds(calls), ["version", "pip-check"],
      `a warm native launch must run exactly one validation pair: ${JSON.stringify(callKinds(calls))}`);
    assertIsolatedPythonCalls(calls);
    assert.equal(await launchStarted(fixture), true, "a validated cached venv must let the launch continue");
  });

  test("native helper provisions DDGS from scratch without Bash", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-ddgs-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    // Point the venv override at the fixture's empty directory: the helper
    // must probe an interpreter, create the venv (Scripts\python.exe), install
    // the pinned wheel, validate it, and export the interpreter — natively.
    const freshVenv = fixture.ddgsVenv;
    const result = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(fixture, { PI_REVIEW_GATE_DDGS_VENV: freshVenv }),
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(String(result.stderr), /creating DDGS/);
    assert.match(String(result.stderr), /installing DDGS/);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.equal(launch.ddgsEnv, join(freshVenv, "Scripts", "python.exe"));
    assert.ok(await pathExists(join(freshVenv, "Scripts", "python.exe")), "the venv python must exist");
  });

  test("native .cmd packaged mode in a path with spaces uses the artifact or fails closed", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-native-package-"));
    try {
      const stage = join(scratch, "package dir with spaces");
      await stageLauncherScripts(stage);
      await copyFile(cmdPath, join(stage, "scripts", "pi-review-gate.cmd"));
      await stageShippedSkills(stage);

      const missingFixture = await makeFixture("pi-review-cmd-native-packmiss-");
      const missing = runCmd(
        `"${join(stage, "scripts", "pi-review-gate.cmd")}" --model example`,
        fixtureEnv(missingFixture),
      );
      assert.equal(missing.status, 2, `stderr: ${missing.stderr}`);
      assert.match(String(missing.stderr), /packaged extension output is missing/);
      assert.equal(await launchStarted(missingFixture), false);

      writeRequiredOutputs(stage);
      const fixture = await makeFixture("pi-review-cmd-native-packaged-");
      const result = runCmd(`"${join(stage, "scripts", "pi-review-gate.cmd")}" --model example`, fixtureEnv(fixture));
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(await pathExists(join(fixture.capture, "npm-args")), false,
        "packaged mode must not invoke npm");
      const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
      assert.equal(launch.args[0], "--extension");
      // realpath comparison: the Windows CI temp dir surfaces 8.3 short names
      // (RUNNER~1) in one spelling and not the other; realpath normalizes.
      assert.equal(await realpath(launch.args[1]), join(await realpath(stage), "dist", "src", "index.js"),
        "packaged mode must use the staged artifact through the .cmd entry point");
      assert.equal(
        await readFile(join(fixture.home, ".agents", "skills", "pi-review-gate-completion", "SKILL.md"), "utf8"),
        await readFile(resolve("skills/pi-review-gate-completion/SKILL.md"), "utf8"),
        "the native .cmd launcher must publish the completion skill from its packaged source",
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("native helper repairs an invalid cached venv by installing the pinned wheel", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-repair-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    // A really created venv without ddgs installed: a valid python at the
    // exact seam the helper resolves, but an invalid cached environment. The
    // helper must install the pinned wheel into it and continue — the native
    // counterpart of the POSIX repair stub.
    const brokenVenv = fixture.ddgsVenv;
    const create = spawnSync(`python -I -m venv "${brokenVenv}"`, { shell: true, stdio: "pipe" });
    assert.equal(create.status, 0, `python -m venv must work natively: ${String(create.stderr)}`);
    const recorder = await writeSpawnRecorder(fixture);
    const venvPython = join(brokenVenv, "Scripts", "python.exe");

    const result = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(fixture, { PI_REVIEW_GATE_DDGS_VENV: brokenVenv, NODE_OPTIONS: nodeOptionsPreload(recorder) }),
    );

    assert.equal(result.status, 0, `stderr: ${String(result.stderr)}`);
    assert.match(String(result.stderr), /installing DDGS/);
    assert.doesNotMatch(String(result.stderr), /creating DDGS/,
      "an existing venv python must never trigger venv re-creation");
    // One failed initial validation, the pinned install, then the complete
    // post-repair validation pair against the real installed distribution.
    const calls = await recordedPythonSpawns(fixture, venvPython);
    assert.deepEqual(callKinds(calls), ["version", "install", "version", "pip-check"],
      `native repair must revalidate the full contract: ${JSON.stringify(callKinds(calls))}`);
    assertIsolatedPythonCalls(calls);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.equal(launch.ddgsEnv, venvPython);
  });

  test("native helper fails closed when the broken venv cannot be repaired", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-refuse-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    // A venv-shaped directory whose interpreter is not Python (the Node binary
    // deterministically rejects the -I flag): validation fails, the pinned
    // install fails, and the helper must exit with the toolchain's own status
    // without launching pi.
    await mkdir(join(fixture.ddgsVenv, "Scripts"), { recursive: true });
    await copyFile(process.execPath, join(fixture.ddgsVenv, "Scripts", "python.exe"));

    const result = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(fixture, { PI_REVIEW_GATE_DDGS_VENV: fixture.ddgsVenv }),
    );

    assert.equal(result.status, 9, "the failing interpreter's own exit status must propagate");
    assert.match(String(result.stderr), /installing DDGS/);
    assert.equal(await launchStarted(fixture), false);
  });

  test("native helper fails closed when no isolated-mode Python interpreter is available", async () => {
    // Staged packaged layout: no src/index.ts, so no build runs and the
    // restricted PATH cannot break npm resolution before the DDGS probe.
    const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-native-nopy-"));
    try {
      const stage = join(scratch, "package dir with spaces");
      await stageLauncherScripts(stage);
      await copyFile(cmdPath, join(stage, "scripts", "pi-review-gate.cmd"));
      await stageShippedSkills(stage);
      await copyFile(resolve("package.json"), join(stage, "package.json"));
      writeRequiredOutputs(stage);

      const fixture = await makeFixture("pi-review-cmd-native-nopy-fix-");
      const env = fixtureEnv(fixture);
      // PATH alone cannot hide a system-installed py.exe. Refuse only Python
      // probes in this child, preserving real Node/OS ownership helpers.
      const noPython = join(fixture.home, "no-python-probes.cjs");
      await writeFile(noPython, [
        'const cp = require("node:child_process");',
        'const path = require("node:path");',
        'const fs = require("node:fs");',
        'const original = cp.spawnSync;',
        'cp.spawnSync = function (file, args, options) {',
        '  const name = path.basename(String(file)).toLowerCase();',
        '  if (/^(python3?|py)(\\.exe)?$/.test(name)) {',
        '    fs.appendFileSync(path.join(process.env.CAPTURE_DIR, "refused-python"), name + "\\n");',
        '    return { status: 1, signal: null, stdout: "", stderr: "fixture: no isolated Python" };',
        '  }',
        '  return original.apply(this, arguments);',
        '};',
      ].join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
      env.NODE_OPTIONS = nodeOptionsPreload(noPython);
      delete env.XDG_CACHE_HOME;
      env.PI_REVIEW_GATE_DDGS_VENV = join(fixture.root, "missing ddgs venv");

      const outcome = await runStagedHelperExpectingFailure(
        join(stage, "scripts", "pi-review-gate-launcher.cjs"), ["--model", "example"], env, scratch,
      );

      assert.equal(outcome.status, 1);
      assert.match(outcome.stderr, /Python 3 is required to provision the DDGS web-search dependency \(install Python 3\.10 or newer/);
      assert.deepEqual((await readFile(join(fixture.capture, "refused-python"), "utf8")).trim().split("\n"),
        ["python3", "python", "py"], "every supported Windows Python probe was refused");
      assert.equal(await launchStarted(fixture), false, "a missing interpreter must stop the launch");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("native helper propagates a failing venv creation", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-venvfail-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
    // An existing regular file at the venv target makes the real toolchain's
    // `python -I -m venv` fail; the helper must propagate that status and
    // never launch pi over a failed provisioning.
    const blocked = join(fixture.root, "venv path is a file");
    await writeFile(blocked, "not a venv\n", "utf8");

    const result = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(fixture, { PI_REVIEW_GATE_DDGS_VENV: blocked }),
    );

    assert.equal(result.status, 1, "the venv toolchain's own exit status must propagate");
    assert.match(String(result.stderr), /could not create the DDGS/);
    assert.equal(await launchStarted(fixture), false);
  });
}
