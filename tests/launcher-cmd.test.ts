import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
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
  cmdQuote: (arg: string) => string;
  compatibilityFallbackConfigPath: (resolution: { homeDir: string; platform: string }) => string;
  ddgsPythonPath: (venv: string, platform: string) => string;
  initializeDefaultReviewGateConfig: (primary: string, fallback: string) => string | null;
  normalizeWindowsShellPath: (filePath: string) => string;
  piAgentConfigPath: (env: NodeJS.ProcessEnv, resolution: { homeDir: string; platform: string }) => string;
  resolveCmdShimTarget: (shimPath: string) => string | null;
  resolvePiAgentDir: (env: NodeJS.ProcessEnv, resolution: { homeDir: string; platform: string }) => string;
  resolvePiInvocation: (env: NodeJS.ProcessEnv, platform: string) =>
    { kind: string; file?: string; shim?: string };
  selectReviewGateConfig: (candidates: string[]) => { status: number; path?: string };
};

/** The exact zero-model default the launcher writes on first launch (issue 32). */
const zeroModelDefaultConfig = {
  enabled: true,
  review: { activeReviewers: [] },
  execution: {
    workerResources: [],
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
  // plain execvp of the PATH entry; Windows execution resolves the npm pi.cmd
  // shim's JavaScript entry point (an exact npm cmd-shim shape) and spawns
  // this Node binary directly — both without any shell reparse of arguments.
  const fakePiEntry = join(bin, "fake-pi-entry.cjs");
  await writeFile(fakePiEntry, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  configEnv: process.env.PI_REVIEW_GATE_CONFIG ?? null,",
    "  disabledEnv: process.env.PI_REVIEW_GATE_DISABLED ?? null,",
    "  agentDirEnv: process.env.PI_CODING_AGENT_DIR ?? null,",
    "  ddgsEnv: process.env.PI_REVIEW_GATE_DDGS_PYTHON ?? null,",
    "}));",
    "process.exit(Number(process.env.PI_EXIT_CODE ?? '0'));",
  ].join("\n"), "utf8");
  if (isWindows) {
    await writeFile(join(bin, "pi.cmd"), npmCmdShim("fake-pi-entry.cjs"), "utf8");
  } else {
    const piPath = join(bin, "pi");
    await writeFile(piPath, `#!/usr/bin/env bash\nexec node "${fakePiEntry}" "$@"\n`, "utf8");
    await chmod(piPath, 0o755);
  }

  if (!options.skipNpmShim) {
    // Fake npm: records its arguments and exits with NPM_EXIT_CODE. The
    // helper's development-launch branch resolves npm through the platform
    // loader (POSIX execvp; Windows: the npm.cmd shim's JavaScript entry
    // point through this Node binary) with a fixed argument array — never a
    // shell.
    const npmCapture = join(bin, "npm-capture.cjs");
    await writeFile(npmCapture, [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.CAPTURE_DIR + '/npm-args', JSON.stringify(process.argv.slice(2)));",
      "process.exit(Number(process.env.NPM_EXIT_CODE ?? '0'));",
    ].join("\n"), "utf8");
    if (isWindows) {
      await writeFile(join(bin, "npm.cmd"), npmCmdShim("npm-capture.cjs"), "utf8");
    } else {
      const npmPath = join(bin, "npm");
      await writeFile(npmPath, `#!/usr/bin/env bash\nexec node "${npmCapture}" "$@"\n`, "utf8");
      await chmod(npmPath, 0o755);
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
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & goto :_undefined_#',
    `"%_prog%"  "%dp0%\\${targetRelative}" %*`,
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

interface LaunchCapture {
  args: string[];
  configEnv: string | null;
  disabledEnv: string | null;
  agentDirEnv: string | null;
  ddgsEnv: string | null;
}

function capturedLaunch(fixture: Fixture): Promise<LaunchCapture> {
  return readFile(join(fixture.capture, "pi.json"), "utf8").then(JSON.parse) as Promise<LaunchCapture>;
}

async function launchStarted(fixture: Fixture): Promise<boolean> {
  return stat(join(fixture.capture, "pi.json")).then(() => true, () => false);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
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
  assert.match(result.stdout, new RegExp(escapeRegExp(resolve("dist/src/index.js"))));

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

  const result = await runHelper(["--model", "example", "--tools", "read,bash"], fixtureEnv(fixture));

  const launch = await capturedLaunch(fixture);
  const extensionPath = resolve("dist/src/index.js");
  assert.deepEqual(launch.args, ["--extension", extensionPath, "--model", "example", "--tools", "read,bash"]);
  assert.equal(launch.configEnv, fixture.defaultConfigPath,
    "the helper must export the resolved persistent config for pi");
  assert.equal(launch.disabledEnv, null);
  assert.equal(launch.agentDirEnv, null);
  assert.ok(launch.ddgsEnv, "the DDGS python must be exported for the extension's web search");
  assert.equal(launch.ddgsEnv, helperModule.ddgsPythonPath(fixtureDdgsVenv(fixture), process.platform),
    "the exported interpreter must come from the venv the environment requested");
  assert.match(result.stdout, new RegExp(`pi-review-gate config: ${escapeRegExp(fixture.defaultConfigPath)}`));
  assert.match(result.stdout, new RegExp(`pi-review-gate extension: ${escapeRegExp(extensionPath)}`));
  assert.match(result.stdout,
    new RegExp(`pi-review-gate orchestrator skill: ${escapeRegExp(join(fixture.home, ".agents", "skills", "orchestrator", "SKILL.md"))}`));
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
  assert.equal(await pathExists(fixture.agentDir), false,
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

test("launcher helper development launch rebuilds dist and forwards the fresh extension", async () => {
  const fixture = await makeFixture("pi-review-cmd-rebuild-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  const result = await runHelper(["--model", "example"], fixtureEnv(fixture));

  const npmArgs = JSON.parse(await readFile(join(fixture.capture, "npm-args"), "utf8")) as string[];
  assert.deepEqual(npmArgs, ["--prefix", resolve(""), "run", "build"],
    "a source checkout must rebuild dist through npm --prefix before launching");
  const launch = await capturedLaunch(fixture);
  assert.deepEqual(launch.args.slice(0, 2), ["--extension", resolve("dist/src/index.js")]);
  assert.match(result.stdout, new RegExp(escapeRegExp(resolve("dist/src/index.js"))));
});

test("launcher helper fails closed on a build failure and never launches a stale extension", async () => {
  const fixture = await makeFixture("pi-review-cmd-buildfail-");
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
    await mkdir(join(stage, "scripts"), { recursive: true });
    await mkdir(join(stage, "skills", "orchestrator", "references"), { recursive: true });
    await copyFile(helperPath, join(stage, "scripts", "pi-review-gate-launcher.cjs"));
    if (isWindows) await copyFile(cmdPath, join(stage, "scripts", "pi-review-gate.cmd"));
    await copyFile(resolve("skills/orchestrator/SKILL.md"), join(stage, "skills/orchestrator/SKILL.md"));
    await copyFile(
      resolve("skills/orchestrator/references/recovery.md"),
      join(stage, "skills/orchestrator/references/recovery.md"),
    );

    const missingFixture = await makeFixture("pi-review-cmd-packmiss-");
    // The staged tree has no src and no dist: packaged failure, exit 2.
    const missing = await runStagedHelperExpectingFailure(join(stage, "scripts", "pi-review-gate-launcher.cjs"), [], fixtureEnv(missingFixture));
    // Node resolves module paths through realpath, so the staged helper's
    // own root (and therefore its exported extension path) is the real path
    // of the stage (e.g. /private/var vs /var symlinks on macOS).
    const realStage = await realpath(stage);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /packaged extension is missing/);
    assert.equal(await launchStarted(missingFixture), false);

    // With the packaged artifact present the helper uses it and never builds.
    await mkdir(join(stage, "dist", "src"), { recursive: true });
    await writeFile(join(stage, "dist", "src", "index.js"), "module.exports = { activate() {} };\n", "utf8");
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
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("launcher helper preserves literal arguments and metacharacters to pi without a shell", async () => {
  const fixture = await makeFixture("pi-review-cmd-args-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  // pi is spawned with an argument array and no shell on every platform, so
  // every byte — including combinations of embedded quotes with shell
  // metacharacters and literal %VAR% text — must reach pi exactly as the
  // caller provided it.
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
  assert.deepEqual(launch.args, ["--extension", resolve("dist/src/index.js"), ...forwarded]);
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

test("launcher helper management verbs pass straight through to pi without setup", async () => {
  for (const verb of helperModule.MANAGEMENT_VERBS) {
    const fixture = await makeFixture(`pi-review-cmd-verb-${verb}-`);
    const inherited = join(fixture.root, "inherited.json");
    await writeFile(inherited, "{}\n", "utf8");

    await runHelper([verb], fixtureEnv(fixture, { PI_REVIEW_GATE_CONFIG: inherited }));

    const launch = await capturedLaunch(fixture);
    assert.deepEqual(launch.args, [verb],
      "passthrough must forward the verb without the extension flag");
    assert.equal(launch.configEnv, inherited,
      "passthrough keeps the inherited environment (exec pi \"$@\" parity)");
    assert.equal(await pathExists(fixture.agentDir), false, "no config initialization on passthrough");
    assert.equal(await pathExists(join(fixture.home, ".agents")), false, "no skill publication on passthrough");
    assert.equal(await pathExists(join(fixture.capture, "npm-args")), false, "no build on passthrough");
    assert.equal(await pathExists(join(fixture.capture, "python-calls")), false, "no DDGS provisioning on passthrough");
  }
});

test("launcher helper refreshes a stale installed orchestrator skill", async () => {
  const fixture = await makeFixture("pi-review-cmd-skill-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const skillDir = join(fixture.home, ".agents", "skills", "orchestrator");
  const installedSkill = join(skillDir, "SKILL.md");
  const installedRecovery = join(skillDir, "references", "recovery.md");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await writeFile(installedSkill, "stale\n", "utf8");
  await writeFile(installedRecovery, "stale recovery\n", "utf8");

  await runHelper([], fixtureEnv(fixture));

  assert.equal(
    await readFile(installedSkill, "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(installedRecovery, "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
  );
  if (!isWindows) {
    assert.equal(await posixMode(installedSkill), 0o644, "published skill must keep the contracted 0644 mode");
    assert.equal(await posixMode(installedRecovery), 0o644);
  }
  await assertNoTempLitter(skillDir);
  assert.deepEqual(await readdir(join(skillDir, "references")), ["recovery.md"],
    "no temporary skill files may be left behind");
});

test("launcher helper fails closed when a directory appears at a skill path before publication", async () => {
  // A directory occupying the exact skill destination (as a concurrent launch
  // or interference would leave behind) must be rejected by the atomic
  // rename instead of being published into, and no pi launch may follow.
  const fixture = await makeFixture("pi-review-cmd-skill-dir-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const skillDir = join(fixture.home, ".agents", "skills", "orchestrator");
  await mkdir(join(skillDir, "SKILL.md"), { recursive: true });

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a replaceable regular file/);
  assert.ok((await stat(join(skillDir, "SKILL.md"))).isDirectory(), "the racing directory must not be removed");
  assert.deepEqual(await readdir(join(skillDir, "SKILL.md")), [], "no file may be published into the directory");
  await assertNoTempLitter(skillDir);
  assert.equal(await launchStarted(fixture), false, "the helper must not start pi when skill publication fails");
});

test("concurrent first launches never clobber or expose partial JSON", async () => {
  const fixture = await makeFixture("pi-review-cmd-race-");
  const racers = await Promise.all(
    Array.from({ length: 8 }, async (_value, index) => {
      const capture = join(fixture.root, `capture-${index + 1}`);
      await mkdir(capture, { recursive: true });
      const env = fixtureEnv(fixture);
      env.CAPTURE_DIR = capture;
      env.CAPTURE_FILE = join(capture, "pi.json");
      const outcome = await runHelperExpectingFailure([], env);
      return { outcome };
    }),
  );

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
  const skillDir = join(fixture.home, ".agents", "skills", "orchestrator");
  assert.equal(
    await readFile(join(skillDir, "SKILL.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
    "the surviving skill must be complete and current",
  );
  assert.equal(
    await readFile(join(skillDir, "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
  );
  await assertNoTempLitter(skillDir);
});

// ---------------------------------------------------------------------------
// DDGS provisioning parity (POSIX execution seam with stubbed python; the
// native Windows provisioning itself is covered by the win32-only tests).
// ---------------------------------------------------------------------------

/** Honest evidence boundary for the POSIX bash-stub DDGS tests on Windows. */
const posixDdgsSkipReason =
  "POSIX bash-stub coverage; the native Windows equivalents below drive the real helper, .cmd entry point and Python";

const venvPythonStub = (behavior: "valid" | "fail-first" | "refuse") => [
  "#!/usr/bin/env bash",
  "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
  'if [[ "$1" == "-I" && "$2" == "-c" ]]; then',
  ...(behavior === "valid" ? [] : [
    '  count=$(cat "$CAPTURE_DIR/check-count" 2>/dev/null || echo 0)',
    '  count=$((count + 1))',
    "  printf '%s\\n' \"$count\" > \"$CAPTURE_DIR/check-count\"",
    ...(behavior === "refuse" ? [] : ['  [[ "$count" -ge 2 ]] && exit 0']),
    "  exit 1",
  ]),
  "fi",
  "exit 0",
  "",
].join("\n");

test("helper uses a valid cached DDGS venv without provisioning", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-cached-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/,
    "a valid cached venv must be neither created nor reinstalled");
  const calls = (await readFile(join(fixture.capture, "python-calls"), "utf8")).split("\n").filter(Boolean);
  assert.ok(calls.some((call) => call.includes("-c")), "expected a version validation invocation");
  assert.ok(calls.some((call) => call.includes("check")), "expected a pip check invocation");
  assert.ok(!calls.some((call) => call.includes("venv")), "no venv creation for a cached venv");
  assert.ok(!calls.some((call) => call.includes("install")), "no reinstall for a cached valid venv");
  for (const call of calls) assert.equal(call.split("\t")[1], "-I", `not isolated: ${call}`);
});

test("helper repairs an invalid cached venv and continues", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-repair-");
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");
  const venvPythonPath = join(fixture.ddgsVenv, "bin", "python");
  await writeFile(venvPythonPath, venvPythonStub("fail-first"), "utf8");
  await chmod(venvPythonPath, 0o755);

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0, `repair must let the launch continue: ${result.stderr}`);
  assert.match(result.stderr, /installing DDGS/);
  const calls = (await readFile(join(fixture.capture, "python-calls"), "utf8")).split("\n").filter(Boolean);
  assert.ok(calls.some((call) => call.includes("install")), "expected a pip install invocation");
  assert.ok(calls.some((call) => call.includes("check")), "expected a pip check invocation");
  assert.ok(calls.some((call) => call.includes("-c")), "expected a version validation invocation");
  for (const call of calls) assert.equal(call.split("\t")[1], "-I", `not isolated: ${call}`);
  assert.equal(await launchStarted(fixture), true, "a repaired venv must let the launch continue");
  assert.equal((await capturedLaunch(fixture)).ddgsEnv, join(fixture.ddgsVenv, "bin", "python"));
});

test("helper refuses to continue when the DDGS venv stays broken", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-refuse-");
  const venvPythonPath = join(fixture.ddgsVenv, "bin", "python");
  await writeFile(venvPythonPath, venvPythonStub("refuse"), "utf8");
  await chmod(venvPythonPath, 0o755);

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is unavailable or has inconsistent dependencies; refusing to continue/);
  assert.equal(await launchStarted(fixture), false, "a broken venv must stop the launch");
});

test("helper provisions a fresh DDGS venv without Bash", { skip: isWindows ? posixDdgsSkipReason : false }, async () => {
  const fixture = await makeFixture("pi-review-cmd-ddgs-fresh-", { emptyDdgsVenv: true });
  // The venv starts empty: the helper must find an interpreter (python3 first,
  // then python), create the venv, install, validate, and export the python.
  // The shim passes the probe (`-c "import sys"`), fails the first ddgs
  // validation (forcing the install path), then succeeds.
  const python3Shim = join(fixture.bin, "python3");
  await writeFile(python3Shim, [
    "#!/usr/bin/env bash",
    "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
    'if [[ "$3" == "import sys" ]]; then exit 0; fi',
    'if [[ "$3" == "venv" ]]; then',
    '  mkdir -p "$4/bin"',
    '  cat > "$4/bin/python" <<\'STUB\'\n#!/usr/bin/env bash\n{ printf \'CALL\\t\'; printf \'%s\\t\' "$@"; printf \'\\n\'; } >> "$CAPTURE_DIR/python-calls"\nif [[ "$1" == "-I" && "$2" == "-c" ]]; then\n  count=$(cat "$CAPTURE_DIR/check-count" 2>/dev/null || echo 0)\n  count=$((count + 1))\n  printf \'%s\\n\' "$count" > "$CAPTURE_DIR/check-count"\n  [[ "$count" -ge 2 ]] && exit 0\n  exit 1\nfi\nexit 0\nSTUB',
    '  chmod +x "$4/bin/python"',
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"), "utf8");
  await chmod(python3Shim, 0o755);

  const result = await runHelperExpectingFailure([], fixtureEnv(fixture));

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /creating DDGS/);
  assert.match(result.stderr, /installing DDGS/);
  assert.equal((await capturedLaunch(fixture)).ddgsEnv, join(fixture.ddgsVenv, "bin", "python"));
  const calls = (await readFile(join(fixture.capture, "python-calls"), "utf8")).split("\n").filter(Boolean);
  assert.ok(calls.some((call) => call.includes("venv")), "expected a venv creation invocation");
  assert.ok(calls.some((call) => call.includes("install")), "expected a pinned ddgs install invocation");
  assert.ok(
    calls.some((call) => call.includes(`ddgs==${helperModule.DDGS_VERSION}`)),
    "the pinned ddgs version must be installed",
  );
  for (const call of calls) assert.equal(call.split("\t")[1], "-I", `not isolated: ${call}`);
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
  assert.match(result.stderr, /Python 3 is required to provision the DDGS web-search dependency/);
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

test("helper resolves npm cmd-shim JavaScript entry points without a shell", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-shim-"));
  try {
    // An exact npm cmd-shim shape pointing at an existing target resolves.
    // The shim lives in a .bin directory and references its target through
    // "%dp0%", mirroring the real node_modules/.bin layout.
    const targetDir = join(scratch, "pkg", "bin");
    await mkdir(targetDir, { recursive: true });
    const binDir = join(scratch, ".bin");
    await mkdir(binDir, { recursive: true });
    const target = join(targetDir, "entry.cjs");
    await writeFile(target, "process.exit(0);\n", "utf8");
    const shim = join(binDir, "pi.cmd");
    await writeFile(shim, npmCmdShim("..\\pkg\\bin\\entry.cjs"), "utf8");
    assert.equal(helperModule.resolveCmdShimTarget(shim), target);

    // A shim whose target does not exist resolves to null (fail closed).
    const danglingShim = join(binDir, "dangling.cmd");
    await writeFile(danglingShim, npmCmdShim("..\\pkg\\bin\\missing.cjs"), "utf8");
    assert.equal(helperModule.resolveCmdShimTarget(danglingShim), null);

    // A shim with no .js/.cjs target resolves to null.
    const opaqueShim = join(scratch, "opaque.cmd");
    await writeFile(opaqueShim, "@echo off\r\nsome-tool %*\r\n", "utf8");
    assert.equal(helperModule.resolveCmdShimTarget(opaqueShim), null);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("helper resolves the pi invocation strategy without shell reparsing", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-cmd-piresolve-"));
  try {
    const bin = join(scratch, ".bin");
    await mkdir(bin, { recursive: true });
    const targetDir = join(scratch, "pkg", "bin");
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, "pi-entry.cjs");
    await writeFile(target, "process.exit(0);\n", "utf8");
    await writeFile(join(bin, "pi.cmd"), npmCmdShim("..\\pkg\\bin\\pi-entry.cjs"), "utf8");

    const env: NodeJS.ProcessEnv = { PATH: bin };
    const resolved = helperModule.resolvePiInvocation(env, "win32");
    assert.equal(resolved.kind, "node");
    assert.ok("file" in resolved && resolved.file === target,
      "the pi.cmd shim must resolve to its JavaScript entry point");

    // An unresolvable shim must fail closed rather than route arguments
    // through cmd.exe.
    await writeFile(join(bin, "pi.cmd"), "@echo off\r\nrem opaque\r\n", "utf8");
    const unresolved = helperModule.resolvePiInvocation(env, "win32");
    assert.equal(unresolved.kind, "unresolved");

    // A missing pi must fail closed.
    assert.equal(helperModule.resolvePiInvocation({ PATH: join(scratch, "empty") }, "win32").kind, "missing");

    // POSIX uses plain execvp of the PATH entry.
    assert.deepEqual(helperModule.resolvePiInvocation(env, "linux"), { kind: "path" });
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
    helperModule.ddgsPythonPath("C:\\cache\\ddgs-9.15.0", "win32"),
    "C:\\cache\\ddgs-9.15.0\\Scripts\\python.exe",
  );
  assert.equal(
    helperModule.ddgsPythonPath("/home/r/.cache/ddgs-9.15.0", "linux"),
    "/home/r/.cache/ddgs-9.15.0/bin/python",
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

if (isWindows) {
  test("native .cmd entry point performs first launch from cmd.exe", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-first-");
    const result = runCmd("scripts\\pi-review-gate.cmd --model example", fixtureEnv(fixture));

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.deepEqual(launch.args, ["--extension", resolve("dist/src/index.js"), "--model", "example"]);
    assert.equal(launch.configEnv, fixture.defaultConfigPath);
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
    assert.deepEqual(launch.args, [
      "--extension", resolve("dist/src/index.js"),
      "--tools", "read,bash",
      "--label", "a&b",
      "--quote", 'say "hi"',
    ]);
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
      fixtureEnv(fixture, { PI_REVIEW_GATE_CONFIG: inherited, PI_EXIT_CODE: "9" }),
    );

    assert.equal(result.status, 9, `pi's nonzero exit status must propagate: ${result.stderr}`);
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.deepEqual(launch.args, [
      "list",
      "--label", "a&b|c^d",
      "--caret", "a^b",
      "--quote", 'say "&hi"',
      "--pct", "100%PI%",
    ], "management arguments must reach pi byte for byte without a cmd re-parsing pass");
    assert.equal(launch.configEnv, inherited,
      "the passthrough must keep the inherited environment");
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
    assert.deepEqual(launch.args, ["--extension", resolve("dist/src/index.js"), "--model", "example model"]);
    assert.equal(launch.configEnv, fixture.defaultConfigPath);
  });

  test("native .cmd forwards embedded quotes combined with metacharacters literally from cmd.exe", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-combo-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

    // Production entrypoint regression (review finding): arguments combining
    // embedded quotes with cmd metacharacters must reach pi byte for byte.
    // pi is resolved from its npm shim and spawned with an argument array, so
    // no shell reparses the arguments — an injection would surface as a
    // "not recognized" error or a wrong capture.
    const result = runCmd(
      'scripts\\pi-review-gate.cmd --label "a&b|c^d" --quote "say ""&hi""" --paren "(x)" --empty ""',
      fixtureEnv(fixture),
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotMatch(String(result.stderr), /is not recognized|is not an internal|not found/,
      "no injected command may execute");
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.deepEqual(launch.args, [
      "--extension", resolve("dist/src/index.js"),
      "--label", "a&b|c^d",
      "--quote", 'say "&hi"',
      "--paren", "(x)",
      "--empty", "",
    ]);
  });

  test("native .cmd preserves literal percent text received from PowerShell", async () => {
    const fixture = await makeFixture("pi-review-cmd-native-percent-");
    await mkdir(fixture.agentDir, { recursive: true });
    await writeFile(fixture.defaultConfigPath, '{"enabled":true}\n', "utf8");

    // Check literal percent text and protected metacharacters through a real
    // PowerShell-to-batch invocation. The helper must not add another cmd.exe
    // parsing pass before pi; caller-side shell expansion remains separate.
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
    assert.deepEqual(launch.args, [
      "--extension", resolve("dist/src/index.js"),
      "--pct", "100%PI%",
      "--label", "a&b|c^d",
    ]);
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
      await mkdir(join(stage, "scripts"), { recursive: true });
      await mkdir(join(stage, "skills", "orchestrator", "references"), { recursive: true });
      await copyFile(helperPath, join(stage, "scripts", "pi-review-gate-launcher.cjs"));
      await copyFile(cmdPath, join(stage, "scripts", "pi-review-gate.cmd"));
      await copyFile(resolve("skills/orchestrator/SKILL.md"), join(stage, "skills/orchestrator/SKILL.md"));
      await copyFile(
        resolve("skills/orchestrator/references/recovery.md"),
        join(stage, "skills/orchestrator/references/recovery.md"),
      );

      const missingFixture = await makeFixture("pi-review-cmd-native-packmiss-");
      const missing = runCmd(
        `"${join(stage, "scripts", "pi-review-gate.cmd")}" --model example`,
        fixtureEnv(missingFixture),
      );
      assert.equal(missing.status, 2, `stderr: ${missing.stderr}`);
      assert.match(String(missing.stderr), /packaged extension is missing/);
      assert.equal(await launchStarted(missingFixture), false);

      await mkdir(join(stage, "dist", "src"), { recursive: true });
      await writeFile(join(stage, "dist", "src", "index.js"), "module.exports = { activate() {} };\n", "utf8");
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

    const result = runCmd(
      "scripts\\pi-review-gate.cmd --model example",
      fixtureEnv(fixture, { PI_REVIEW_GATE_DDGS_VENV: brokenVenv }),
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(String(result.stderr), /installing DDGS/);
    assert.doesNotMatch(String(result.stderr), /creating DDGS/,
      "an existing venv python must never trigger venv re-creation");
    const launch = JSON.parse(await readFile(join(fixture.capture, "pi.json"), "utf8"));
    assert.equal(launch.ddgsEnv, join(brokenVenv, "Scripts", "python.exe"));
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
      await mkdir(join(stage, "scripts"), { recursive: true });
      await mkdir(join(stage, "skills", "orchestrator", "references"), { recursive: true });
      await copyFile(helperPath, join(stage, "scripts", "pi-review-gate-launcher.cjs"));
      await copyFile(cmdPath, join(stage, "scripts", "pi-review-gate.cmd"));
      await copyFile(resolve("skills/orchestrator/SKILL.md"), join(stage, "skills/orchestrator/SKILL.md"));
      await copyFile(
        resolve("skills/orchestrator/references/recovery.md"),
        join(stage, "skills/orchestrator/references/recovery.md"),
      );
      await mkdir(join(stage, "dist", "src"), { recursive: true });
      await writeFile(join(stage, "dist", "src", "index.js"), "module.exports = { activate() {} };\n", "utf8");

      const fixture = await makeFixture("pi-review-cmd-native-nopy-fix-");
      const env = fixtureEnv(fixture);
      // Only the fake pi shim is on PATH: no python3, no python, no npm.
      env.PATH = fixture.bin;
      delete env.XDG_CACHE_HOME;
      env.PI_REVIEW_GATE_DDGS_VENV = join(fixture.root, "missing ddgs venv");

      const outcome = await runStagedHelperExpectingFailure(
        join(stage, "scripts", "pi-review-gate-launcher.cjs"), ["--model", "example"], env, scratch,
      );

      assert.equal(outcome.status, 1);
      assert.match(outcome.stderr, /Python 3 is required to provision the DDGS web-search dependency/);
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
