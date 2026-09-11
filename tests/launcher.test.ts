import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  automaticReviewEnabled,
  externalAgentCatalog,
  loadConfig,
  normalizeConfig,
  resolveReviewers,
  resolvedWorkerResources,
  resolvedWorkerRoute,
} from "../src/config";
import { persistSubtasksViewPreference } from "../src/settings/persistence";
import { piAgentConfigPath, reviewGateConfigCandidates } from "../src/config-path";

const execFileAsync = promisify(execFile);

/** The exact zero-model default the launcher writes on first launch (issue 32). */
const zeroModelDefaultConfig = {
  enabled: true,
  review: { activeReviewers: [] },
  execution: {
    workerResources: [],
    routes: { execute: [], research: [] },
  },
};

interface LauncherFixture {
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

async function makeLauncherFixture(prefix: string): Promise<LauncherFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  const ddgsVenv = join(root, "ddgs");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(capture, { recursive: true }),
    mkdir(join(ddgsVenv, "bin"), { recursive: true }),
  ]);
  const npmPath = join(bin, "npm");
  const piPath = join(bin, "pi");
  const ddgsPythonPath = join(ddgsVenv, "bin", "python");
  await writeFile(npmPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(ddgsPythonPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await Promise.all([chmod(npmPath, 0o755), chmod(piPath, 0o755), chmod(ddgsPythonPath, 0o755)]);
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

function launcherEnv(fixture: LauncherFixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Sanitize inherited gate variables so the tests observe the launcher's own
  // resolution (and role-sensitive behavior stays at its default).
  delete env.PI_REVIEW_GATE_CONFIG;
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete env.PI_REVIEW_GATE_DISABLED;
  return {
    ...env,
    HOME: fixture.home,
    PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
    CAPTURE_DIR: fixture.capture,
    PI_REVIEW_GATE_DDGS_VENV: fixture.ddgsVenv,
    ...overrides,
  };
}

async function runLauncher(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolve("scripts/pi-review-gate.sh"), args, { env, ...(cwd ? { cwd } : {}) });
}

async function runLauncherWithUmask(
  umask: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "bash",
    ["-c", "umask \"$1\"; exec bash \"$2\" \"${@:3}\"", "launcher", umask, resolve("scripts/pi-review-gate.sh"), ...args],
    { env },
  );
}

async function capturedConfigPath(fixture: LauncherFixture): Promise<string> {
  return readFile(join(fixture.capture, "config-env"), "utf8");
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function assertNoTempLitter(dir: string): Promise<void> {
  const entries = await readdir(dir);
  assert.ok(
    !entries.some((entry) => entry.startsWith(".config.json.")),
    `temporary config files left behind in ${dir}: ${entries.join(", ")}`,
  );
}

/** Creates the pre-#94 config at the removed location; negative coverage only. */
async function writeRemovedConfig(fixture: LauncherFixture, body = "{}\n"): Promise<void> {
  await mkdir(join(fixture.removedConfigPath, ".."), { recursive: true });
  await writeFile(fixture.removedConfigPath, body, "utf8");
}

test("persistent launcher uses the compatibility fallback config and forwards arguments", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-fallback-use-");
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");
  const piPath = join(fixture.bin, "pi");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s' \"${PI_REVIEW_GATE_DISABLED:-unset}\" > \"$CAPTURE_DIR/disabled-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await chmod(piPath, 0o755);

  const result = await runLauncher(["--model", "example", "--tools", "read,bash"], launcherEnv(fixture, {
    // Inherited from a parent session: sanitization must still override it.
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
  }));

  assert.match(result.stdout, new RegExp(escapeRegExp(fixture.fallbackConfigPath)));
  assert.doesNotMatch(result.stdout, /will not activate/);
  assert.equal(await readFile(join(fixture.capture, "config-env"), "utf8"), fixture.fallbackConfigPath);
  assert.equal(await readFile(join(fixture.capture, "disabled-env"), "utf8"), "unset");
  assert.equal(
    await readFile(join(fixture.home, ".agents", "skills", "orchestrator", "SKILL.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(join(fixture.home, ".agents", "skills", "orchestrator", "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
  );
  // The launcher no longer bakes the orchestrator prompt in with
  // --append-system-prompt: the extension owns the operating-mode segment.
  assert.equal(
    await readFile(join(fixture.capture, "args"), "utf8"),
    `--extension\n${resolve("dist/src/index.js")}\n--model\nexample\n--tools\nread,bash\n`,
  );
});

test("persistent launcher honors the PI_REVIEW_GATE_DISABLED kill switch", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-disabled-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const piPath = join(fixture.bin, "pi");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s' \"${PI_REVIEW_GATE_DISABLED:-unset}\" > \"$CAPTURE_DIR/disabled-env\"",
  ].join("\n"), "utf8");
  await chmod(piPath, 0o755);

  const result = await runLauncher(["--model", "example"], launcherEnv(fixture, {
    // Inherited from a parent session: sanitization must still override it
    // even with the kill switch active.
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
    // Kill switch set by the user:
    PI_REVIEW_GATE_DISABLED: "1",
  }));

  assert.match(result.stdout, /PI_REVIEW_GATE_DISABLED is set; the review gate will not activate/);
  // The kill switch must reach the pi child (and therefore the extension),
  // which disables the gate; the launcher must no longer strip it.
  assert.equal(await readFile(join(fixture.capture, "disabled-env"), "utf8"), "1");
  // Persistent config resolution/sanitization still applies while disabled.
  assert.equal(await readFile(join(fixture.capture, "config-env"), "utf8"), fixture.fallbackConfigPath);
});

test("persistent launcher refreshes a stale installed orchestrator skill", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-");
  const installedSkill = join(fixture.home, ".agents", "skills", "orchestrator", "SKILL.md");
  const installedRecovery = join(fixture.home, ".agents", "skills", "orchestrator", "references", "recovery.md");
  await Promise.all([
    mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true }),
    mkdir(join(fixture.home, ".agents", "skills", "orchestrator", "references"), { recursive: true }),
  ]);
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  await writeFile(installedSkill, "stale\n", "utf8");
  await writeFile(installedRecovery, "stale recovery\n", "utf8");

  await runLauncher([], launcherEnv(fixture));

  assert.equal(
    await readFile(installedSkill, "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(installedRecovery, "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
  );
});

test("orchestrator prompt names the operation-specific tools and current steering contract", async () => {
  const prompt = await readFile(resolve("scripts/orchestrator-system-prompt.md"), "utf8");
  assert.match(prompt, /`SubtasksStart`/);
  assert.match(prompt, /kind: "research"/);
  assert.match(prompt, /`SubtasksInspect`/);
  assert.match(prompt, /`SubtasksWatch`/);
  assert.match(prompt, /`SubtasksContinue`/);
  assert.match(prompt, /`SubtasksSteer`/);
  assert.match(prompt, /separate, isolated Git worktree/);
  assert.match(prompt, /guarded three-way merge\/integration/);
  assert.match(prompt, /captured base, the current main workspace, and the accepted task result/);
  assert.doesNotMatch(prompt, /ExecuteSubtasks/);
  assert.doesNotMatch(prompt, /`dispatch`/);
  assert.match(prompt, /durably queued for the next executor handoff/);
  assert.doesNotMatch(prompt, /execute_subtasks/);
  assert.doesNotMatch(prompt, /live-turn-only/);
  assert.doesNotMatch(prompt, /delegation overhead/);
  assert.doesNotMatch(prompt, /You may directly handle/);
});

test("orchestrator skill explains worktree isolation and three-way landing", async () => {
  const skill = await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8");
  assert.match(skill, /separate, isolated Git worktree/);
  assert.match(skill, /Siblings do not share a working directory/);
  assert.match(skill, /guarded three-way merge\/integration/);
  assert.match(skill, /captured base, the current main workspace, and the accepted worker result/);
  assert.match(skill, /diff3 conflict markers/);
  assert.match(skill, /references\/recovery\.md/);
});

test("orchestrator recovery reference covers recoverable execution states", async () => {
  const recovery = await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8");
  for (const phrase of [
    "SubtasksInspect",
    "SubtasksContinue",
    "SubtasksSteer",
    "SubtasksInterrupt",
    "SubtasksForceMerge",
    "SubtasksMarkClean",
    "paused_recoverable",
    "stopped_for_application_exit",
    "recovery_required",
    "interrupt_with_merge",
    "three-way",
    "diff3",
    "same session file",
  ]) assert.match(recovery, new RegExp(phrase));
});

test("persistent launcher first launch creates a private zero-model default config in the Pi agent directory", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-first-");

  // Pi's own agent-directory contents must stay untouched by initialization.
  const piSettings = join(fixture.home, ".pi", "settings.json");
  await mkdir(join(fixture.home, ".pi"), { recursive: true });
  await writeFile(piSettings, '{"pi":"owns this"}\n', "utf8");
  const preExistingPiMode = (await stat(join(fixture.home, ".pi"))).mode & 0o777;

  // An inherited PI_REVIEW_GATE_CONFIG must not redirect the first launch:
  // sanitization still applies, and initialization targets the default path.
  const result = await runLauncher(["--model", "example"], launcherEnv(fixture, {
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
  }));

  assert.match(result.stderr, /no persistent config found; created default zero-model config at/);
  assert.match(result.stderr, /no reviewers or workers are selected yet; configure them with \/review-settings/);
  assert.equal(await capturedConfigPath(fixture), fixture.defaultConfigPath);
  assert.match(result.stdout, new RegExp(escapeRegExp(fixture.defaultConfigPath)));

  const fileStat = await stat(fixture.defaultConfigPath);
  assert.ok(fileStat.isFile(), "default config must be a regular file");
  assert.equal(fileStat.mode & 0o777, 0o600, "new config file must be private (0600)");
  const agentDirStat = await stat(fixture.agentDir);
  assert.ok(agentDirStat.isDirectory());
  assert.equal(agentDirStat.mode & 0o777, 0o700, "new agent directory must be private (0700)");
  // A pre-existing .pi (Pi's own directory) keeps its mode: initialization
  // only creates missing levels and never re-chmods existing ones.
  assert.equal((await stat(join(fixture.home, ".pi"))).mode & 0o777, preExistingPiMode);
  // Unrelated Pi contents must be preserved untouched.
  assert.equal(await readFile(piSettings, "utf8"), '{"pi":"owns this"}\n');

  const generated = JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")) as unknown;
  assert.deepEqual(generated, zeroModelDefaultConfig);
  assert.equal(await pathExists(fixture.fallbackConfigPath), false,
    "first launch must not create the compatibility fallback config");
  assert.equal(await pathExists(fixture.removedConfigPath), false,
    "first launch must not create the removed ~/.config/pi/review-gate.json location");
  await assertNoTempLitter(fixture.agentDir);
});

test("persistent launcher subsequent launch preserves an existing default config", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-second-");
  const prior = '{"enabled":true,"retainBundles":"always","reviewerTimeoutMs":123456}\n';
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, prior, "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.doesNotMatch(result.stderr, /created default zero-model config/);
  assert.equal(await capturedConfigPath(fixture), fixture.defaultConfigPath);
  assert.equal(await readFile(fixture.defaultConfigPath, "utf8"), prior, "existing config must not be rewritten");
  const entries = await readdir(fixture.agentDir);
  assert.deepEqual(entries, ["review-gate.json"]);
});

test("persistent launcher keeps fallback discovery and does not initialize when a fallback exists", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-fallback-keep-");
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await capturedConfigPath(fixture), fixture.fallbackConfigPath);
  assert.equal(await readFile(fixture.fallbackConfigPath, "utf8"), prior);
  assert.equal(
    await pathExists(fixture.agentDir),
    false,
    "a present fallback config must not trigger default initialization",
  );
});

test("persistent launcher prefers the default config over the compatibility fallback", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-precedence-");
  await mkdir(fixture.agentDir, { recursive: true });
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.defaultConfigPath, '{"enabled":true,"marker":"default"}\n', "utf8");
  await writeFile(fixture.fallbackConfigPath, '{"enabled":true,"marker":"fallback"}\n', "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await capturedConfigPath(fixture), fixture.defaultConfigPath);
});

test("the removed ~/.config/pi/review-gate.json location is never discovered or initialized", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-removed-");
  // Negative coverage only: a config left behind by a pre-#94 installation
  // must be ignored (no positive support remains), with no migration.
  const prior = '{"enabled":true,"marker":"removed"}\n';
  await writeRemovedConfig(fixture, prior);

  const result = await runLauncher([], launcherEnv(fixture));

  // Neither candidate exists, so the launcher initializes the Pi-agent
  // default instead of falling back to the removed location.
  assert.match(result.stderr, /created default zero-model config at/);
  assert.equal(await capturedConfigPath(fixture), fixture.defaultConfigPath);
  assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
  assert.equal(await readFile(fixture.removedConfigPath, "utf8"), prior,
    "the removed location's file must be left untouched");
  assert.equal(await pathExists(fixture.fallbackConfigPath), false,
    "the compatibility fallback must not be created either");
});

test("persistent launcher honors PI_CODING_AGENT_DIR with native tilde semantics", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-agentdir-");
  const agentDir = join(fixture.home, "custom agent dir");
  const overrideConfigPath = join(agentDir, "review-gate.json");

  const piPath = join(fixture.bin, "pi");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s' \"${PI_CODING_AGENT_DIR:-unset}\" > \"$CAPTURE_DIR/agentdir-env\"",
  ].join("\n"), "utf8");
  await chmod(piPath, 0o755);

  const result = await runLauncher([], launcherEnv(fixture, { PI_CODING_AGENT_DIR: "~/custom agent dir" }));

  assert.equal(await readFile(join(fixture.capture, "agentdir-env"), "utf8"), "~/custom agent dir",
    "PI_CODING_AGENT_DIR must pass through to pi untouched");
  assert.equal(await capturedConfigPath(fixture), overrideConfigPath);
  assert.match(result.stdout, new RegExp(escapeRegExp(overrideConfigPath)));
  assert.equal((await stat(agentDir)).mode & 0o777, 0o700);
  assert.equal((await stat(overrideConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(overrideConfigPath, "utf8")), zeroModelDefaultConfig);
  // The default location under $HOME must stay untouched.
  assert.equal(await pathExists(join(fixture.home, ".pi")), false);
  await assertNoTempLitter(agentDir);
});

test("persistent launcher resolves a native Windows PI_CODING_AGENT_DIR override for discovery", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-win-agentdir-");
  // Deterministic Windows seams: the launcher probes `uname -s` through PATH
  // (standing in for Git Bash/MINGW64) and maps native drive paths into the
  // fixture through a cygpath shim, exactly as real cygpath would map
  // C:\Users\r onto /c/Users/r inside the MSYS tree. Native Windows execution
  // itself is not claimed; this exercises the launcher's Windows branch,
  // shell/native interoperation, and the native-form export end to end.
  await writeWindowsShims(fixture);

  const prior = '{"enabled":true,"marker":"win"}\n';
  const shellAgentDir = join(fixture.root, "c", "Users", "r", ".pi", "agent");
  await mkdir(shellAgentDir, { recursive: true });
  await writeFile(join(shellAgentDir, "review-gate.json"), prior, "utf8");

  const result = await runLauncher([], launcherEnv(fixture, {
    PI_CODING_AGENT_DIR: "C:\\Users\\r\\.pi\\agent",
    CYGPATH_ROOT: fixture.root,
  }), fixture.root);

  assert.equal(await capturedConfigPath(fixture), "C:\\Users\\r\\.pi\\agent\\review-gate.json");
  assert.match(result.stdout, /pi-review-gate config: C:\\Users\\r\\.pi\\agent\\review-gate\.json/);
  assert.equal(await readFile(join(shellAgentDir, "review-gate.json"), "utf8"), prior,
    "the discovered config must be used, not rewritten");
  assert.equal(await pathExists(join(fixture.home, ".pi")), false,
    "the POSIX default location must not be created when the override resolves");
});

test("persistent launcher initializes fresh default config for a native Windows override with a missing agent directory", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-win-init-");
  await writeWindowsShims(fixture);

  // Native (backslash) form override whose agent directory does not exist:
  // directory derivation, private mode creation and publication must all
  // happen in the shell form mapped by cygpath, never against a path MSYS
  // cannot split.
  const result = await runLauncher([], launcherEnv(fixture, {
    PI_CODING_AGENT_DIR: "C:\\Users\\r\\.pi\\agent",
    CYGPATH_ROOT: fixture.root,
  }), fixture.root);

  const shellAgentDir = join(fixture.root, "c", "Users", "r", ".pi", "agent");
  assert.equal(await capturedConfigPath(fixture), "C:\\Users\\r\\.pi\\agent\\review-gate.json");
  assert.match(result.stderr, /created default zero-model config at/);
  assert.equal((await stat(shellAgentDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(shellAgentDir, "review-gate.json"))).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(join(shellAgentDir, "review-gate.json"), "utf8")),
    zeroModelDefaultConfig,
  );
  await assertNoTempLitter(shellAgentDir);
});

test("persistent launcher resolves its home from USERPROFILE with native Node semantics on Windows", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-userprofile-");
  await writeWindowsShims(fixture);

  // HOME and USERPROFILE deliberately differ: node's os.homedir() uses
  // USERPROFILE on win32, so the launcher must derive the default, the
  // compatibility fallback and tilde expansion from USERPROFILE and leave the
  // HOME tree untouched. The exported path must equal what the runtime would
  // compute natively for the same environment.
  const result = await runLauncher([], launcherEnv(fixture, {
    HOME: join(fixture.root, "not-the-windows-home"),
    USERPROFILE: "C:\\Users\\r",
    CYGPATH_ROOT: fixture.root,
  }), fixture.root);

  const expected = reviewGateConfigCandidates({}, { homeDir: "C:\\Users\\r", platform: "win32" })[0];
  assert.equal(await capturedConfigPath(fixture), expected,
    "launcher export must agree with the runtime's native resolution");
  assert.equal(expected, "C:\\Users\\r\\.pi\\agent\\review-gate.json");
  assert.match(result.stderr, /created default zero-model config at/);
  const shellAgentDir = join(fixture.root, "c", "Users", "r", ".pi", "agent");
  assert.equal((await stat(join(shellAgentDir, "review-gate.json"))).mode & 0o777, 0o600);
  assert.equal(await pathExists(join(fixture.root, "not-the-windows-home", ".pi")), false,
    "the Git Bash HOME must not be used for config resolution");
});

test("persistent launcher resolves USERPROFILE-based tilde overrides and the compatibility fallback", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-userprofile-fallback-");
  await writeWindowsShims(fixture);

  // The compatibility fallback lives under the native home (USERPROFILE), not
  // under the Git Bash HOME; when it exists it is discovered there and the
  // default location is left uninitialized.
  const shellFallbackDir = join(fixture.root, "c", "Users", "r", ".config", "pi-review-gate");
  await mkdir(shellFallbackDir, { recursive: true });
  const prior = '{"enabled":true,"marker":"userprofile-fallback"}\n';
  await writeFile(join(shellFallbackDir, "config.json"), prior, "utf8");

  const fallbackResult = await runLauncher([], launcherEnv(fixture, {
    HOME: join(fixture.root, "not-the-windows-home"),
    USERPROFILE: "C:\\Users\\r",
    CYGPATH_ROOT: fixture.root,
  }), fixture.root);

  const expectedFallback = reviewGateConfigCandidates({}, { homeDir: "C:\\Users\\r", platform: "win32" })[1];
  assert.equal(await capturedConfigPath(fixture), expectedFallback);
  assert.equal(expectedFallback, "C:\\Users\\r\\.config\\pi-review-gate\\config.json");
  assert.equal(await readFile(join(shellFallbackDir, "config.json"), "utf8"), prior);
  assert.equal(await pathExists(join(fixture.root, "c", "Users", "r", ".pi")), false,
    "a present fallback must not trigger default initialization");

  // A tilde override expands against the native home too.
  const fixture2 = await makeLauncherFixture("pi-review-launcher-userprofile-tilde-");
  await writeWindowsShims(fixture2);
  const tildeResult = await runLauncher([], launcherEnv(fixture2, {
    HOME: join(fixture2.root, "not-the-windows-home"),
    USERPROFILE: "C:\\Users\\r",
    PI_CODING_AGENT_DIR: "~\\agent-x",
    CYGPATH_ROOT: fixture2.root,
  }), fixture2.root);

  const expectedTilde = piAgentConfigPath(
    { PI_CODING_AGENT_DIR: "~\\agent-x" },
    { homeDir: "C:\\Users\\r", platform: "win32" },
  );
  assert.equal(await capturedConfigPath(fixture2), expectedTilde);
  assert.equal(expectedTilde, "C:\\Users\\r\\agent-x\\review-gate.json");
  assert.equal((await stat(join(fixture2.root, "c", "Users", "r", "agent-x"))).mode & 0o777, 0o700);
});

test("persistent launcher normalizes /mnt and /cygdrive PI_CODING_AGENT_DIR overrides like the runtime", async () => {
  // Pi resolves both alternate drive forms to the native C-drive path before
  // anything else; real cygpath does not interpret /mnt or /cygdrive as drive
  // mounts, so the launcher must apply the same normalization before handing
  // the override to cygpath. Fresh initialization and export must agree with
  // the runtime's computation for both forms.
  for (const override of ["/mnt/c/Users/r/agent", "/cygdrive/c/Users/r/agent"] as const) {
    const fixture = await makeLauncherFixture(`pi-review-launcher-${override.includes("mnt") ? "mnt" : "cygdrive"}-`);
    await writeWindowsShims(fixture);

    const result = await runLauncher([], launcherEnv(fixture, {
      HOME: join(fixture.root, "not-the-windows-home"),
      USERPROFILE: "C:\\Users\\r",
      PI_CODING_AGENT_DIR: override,
      CYGPATH_ROOT: fixture.root,
    }), fixture.root);

    const expected = piAgentConfigPath(
      { PI_CODING_AGENT_DIR: override },
      { homeDir: "C:\\Users\\r", platform: "win32" },
    );
    assert.equal(expected, "C:\\Users\\r\\agent\\review-gate.json");
    assert.equal(await capturedConfigPath(fixture), expected,
      `launcher export must agree with the runtime for ${override}`);
    assert.match(result.stderr, /created default zero-model config at/);
    const shellAgentDir = join(fixture.root, "c", "Users", "r", "agent");
    assert.equal((await stat(shellAgentDir)).mode & 0o777, 0o700,
      "initialization must target the normalized drive directory");
    assert.equal((await stat(join(shellAgentDir, "review-gate.json"))).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(await readFile(join(shellAgentDir, "review-gate.json"), "utf8")),
      zeroModelDefaultConfig,
    );
    assert.equal(await pathExists(join(fixture.root, "not-the-windows-home", ".pi")), false);
    await assertNoTempLitter(shellAgentDir);
  }
});

/**
 * Deterministic Windows seams for the launcher: `uname -s` (Git Bash/MINGW64)
 * and a cygpath shim that maps native drive paths into the fixture root
 * exactly as real cygpath maps C:\Users\r onto /c/Users/r inside the MSYS
 * tree. The launcher must prefer cygpath when it is available.
 */
async function writeWindowsShims(fixture: LauncherFixture): Promise<void> {
  const unameShim = join(fixture.bin, "uname");
  await writeFile(unameShim, "#!/usr/bin/env bash\necho MINGW64_NT-10.0-19045\n", "utf8");
  await chmod(unameShim, 0o755);
  const cygpathShim = join(fixture.bin, "cygpath");
  await writeFile(cygpathShim, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'root="${CYGPATH_ROOT:?}"',
    'mode="$1"',
    'p="$2"',
    'case "$mode" in',
    "  -u)",
    "    p=\"$(printf '%s' \"$p\" | tr '\\\\' '/')\"",
    "    if [[ \"$p\" =~ ^([A-Za-z]):/?(.*)$ ]]; then",
    "      d=\"$(printf '%s' \"${BASH_REMATCH[1]}\" | tr '[:upper:]' '[:lower:]')\"",
    "      rest=\"${BASH_REMATCH[2]}\"",
    "      if [[ -n \"$rest\" ]]; then printf '%s\\n' \"$root/$d/$rest\"; else printf '%s\\n' \"$root/$d\"; fi",
    "    else",
    "      printf '%s\\n' \"$p\"",
    "    fi",
    "    ;;",
    "  -w)",
    "    if [[ \"$p\" == \"$root\"/* ]]; then",
    "      rel=\"${p#\"$root\"/}\"",
    "      d=\"$(printf '%s' \"${rel:0:1}\" | tr '[:lower:]' '[:upper:]')\"",
    "      rest=\"${rel:1}\"",
    "      rest=\"$(printf '%s' \"$rest\" | tr '/' '\\\\')\"",
    "      if [[ -n \"$rest\" ]]; then printf '%s\\n' \"${d}:${rest}\"; else printf '%s\\n' \"${d}:\\\\\"; fi",
    "    else",
    "      printf '%s\\n' \"$p\"",
    "    fi",
    "    ;;",
    "  *)",
    "    echo \"cygpath shim: unsupported mode\" >&2",
    "    exit 2",
    "    ;;",
    "esac",
  ].join("\n"), "utf8");
  await chmod(cygpathShim, 0o755);
}

test("persistent launcher never replaces a malformed existing config", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-malformed-");
  const malformed = "{not json";
  await mkdir(fixture.agentDir, { recursive: true });
  await writeFile(fixture.defaultConfigPath, malformed, "utf8");

  // The launcher does not parse the config; it must still hand the malformed
  // file through untouched so the extension reports its own config error.
  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await capturedConfigPath(fixture), fixture.defaultConfigPath);
  assert.equal(await readFile(fixture.defaultConfigPath, "utf8"), malformed, "malformed config must be preserved");
});

test("first-launch default config validates under normalization with zero reviewers and workers", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-zero-model-");
  await runLauncher([], launcherEnv(fixture));

  const raw = await readFile(fixture.defaultConfigPath, "utf8");
  const normalized = normalizeConfig(JSON.parse(raw) as unknown);
  assert.equal(normalized.enabled, true);

  // Explicitly empty selections: nothing resolves, so no model is invoked and
  // no provider or credential is requested until the user configures one.
  const resolution = resolveReviewers(normalized);
  assert.deepEqual(resolution.reviewers, []);
  assert.deepEqual(resolution.unknownIds, []);
  assert.equal(automaticReviewEnabled(normalized), false);
  assert.deepEqual(resolvedWorkerResources(normalized), []);
  assert.deepEqual(resolvedWorkerRoute(normalized, "execute"), []);
  assert.deepEqual(resolvedWorkerRoute(normalized, "research"), []);
  assert.deepEqual(externalAgentCatalog(normalized), []);

  // The actual loader entry point used at extension startup accepts the file.
  const loaded = loadConfig({ PI_REVIEW_GATE_CONFIG: fixture.defaultConfigPath });
  assert.equal(loaded.path, fixture.defaultConfigPath);
  assert.equal(loaded.config.enabled, true);
  assert.equal(automaticReviewEnabled(loaded.config), false);
});

test("first-launch default config stays usable for settings persistence", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-settings-");
  await runLauncher([], launcherEnv(fixture));

  // /review-settings writes through the same atomic update path; the
  // zero-model file must round-trip without gaining any model selection.
  const saved = await persistSubtasksViewPreference(fixture.defaultConfigPath, true);
  assert.equal(saved.ui?.subtasksViewExpanded, true);
  assert.deepEqual(resolveReviewers(saved).reviewers, []);
  assert.deepEqual(resolvedWorkerResources(saved), []);

  const updated = JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(updated.review, { activeReviewers: [] });
  assert.equal((await stat(fixture.defaultConfigPath)).mode & 0o777, 0o600,
    "settings persistence must keep the private file mode");
});

test("persistent launcher fails closed when the agent directory is not writable", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-perm-");
  await mkdir(fixture.agentDir, { recursive: true });
  await chmod(fixture.agentDir, 0o500);

  try {
    await assert.rejects(
      runLauncher([], launcherEnv(fixture)),
      (error: unknown) => {
        assert.ok(isExecError(error));
        assert.equal(error.code, 2);
        assert.match(error.stderr, /could not create a temporary file/);
        return true;
      },
    );
    const entries = await readdir(fixture.agentDir);
    assert.deepEqual(entries, [], "no partial config or temp file may be left behind");
  } finally {
    await chmod(fixture.agentDir, 0o755);
  }
});

test("persistent launcher fails closed over an existing invalid path at the default location", async () => {
  // A directory where the config file belongs.
  const fixture = await makeLauncherFixture("pi-review-launcher-nonreg-");
  await mkdir(fixture.defaultConfigPath, { recursive: true });
  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exists but is not a regular file/);
      return true;
    },
  );
  assert.ok((await stat(fixture.defaultConfigPath)).isDirectory(), "the non-regular path must not be removed");

  // A plain file where the .pi directory belongs.
  const blocked = await makeLauncherFixture("pi-review-launcher-dotpi-");
  await writeFile(join(blocked.home, ".pi"), "not a directory\n", "utf8");
  await assert.rejects(
    runLauncher([], launcherEnv(blocked)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exists but is not a directory/);
      return true;
    },
  );
});

test("first launch creates private paths even under a permissive umask", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-umask-");
  // Record the mode of every directory the launcher's mkdir creates, observed
  // immediately after creation, so a transient permissive state is caught.
  // Measure with Node (fs.statSync): it prints exactly one octal value on
  // every platform, unlike stat(1), whose -f flag means "file system" in GNU
  // coreutils and can print filesystem info to stdout before failing.
  const mkdirShim = join(fixture.bin, "mkdir");
  await writeFile(mkdirShim, [
    "#!/usr/bin/env bash",
    "tab=$'\\t'",
    '/bin/mkdir "$@"',
    "status=$?",
    'for a in "$@"; do',
    '  [[ "$a" == "$HOME/"* && -d "$a" ]] || continue',
    '  if ! grep -qF "${a}${tab}" "$CAPTURE_DIR/mkdir-modes" 2>/dev/null; then',
    "    printf '%s\\t%s\\n' \"$a\" \"$(node -e 'process.stdout.write((require(\"node:fs\").statSync(process.argv[1]).mode&0o777).toString(8))' \"$a\")\" >> \"$CAPTURE_DIR/mkdir-modes\"",
    "  fi",
    "done",
    "exit $status",
  ].join("\n"), "utf8");
  await chmod(mkdirShim, 0o755);

  // With umask 0, naively created directories would be world-writable; every
  // config level the launcher creates must be private from the instant of
  // creation.
  await runLauncherWithUmask("0", [], launcherEnv(fixture));

  const logged = (await readFile(join(fixture.capture, "mkdir-modes"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const configDirs = logged.filter((line) => line.startsWith(join(fixture.home, ".pi")));
  assert.ok(configDirs.length >= 2, `expected the created config directories to be recorded: ${logged.join(" | ")}`);
  for (const line of configDirs) {
    const [path, mode] = line.split("\t");
    assert.equal(parseInt(mode, 8) & 0o777, 0o700,
      `config directory ${path} must be private from the instant of creation despite umask 0`);
  }
  assert.equal((await stat(join(fixture.home, ".pi"))).mode & 0o777, 0o700,
    "newly created .pi must be private despite umask 0");
  assert.equal((await stat(fixture.agentDir)).mode & 0o777, 0o700,
    "newly created agent directory must be private despite umask 0");
  assert.equal((await stat(fixture.defaultConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
});

test("first launch preserves permissions of directories created by a competing process", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-dirmode-");
  // Simulate the creation race deterministically: every directory the launcher
  // tries to create already exists (created at 0755 by the shim, standing in
  // for a concurrent launch — or for Pi's own pre-existing .pi directory)
  // before the real mkdir runs and fails with EEXIST.
  const mkdirShim = join(fixture.bin, "mkdir");
  await writeFile(mkdirShim, [
    "#!/usr/bin/env bash",
    'for a in "$@"; do',
    '  [[ "$a" == "$HOME/"* ]] || continue',
    '/bin/mkdir -m 755 -p "$a" 2>/dev/null || true',
    "done",
    'exec /bin/mkdir "$@"',
  ].join("\n"), "utf8");
  await chmod(mkdirShim, 0o755);

  // A directory created by another process keeps its permissions:
  // initialization must only create what is missing, never re-chmod a level
  // it did not create itself.
  await runLauncher([], launcherEnv(fixture));

  assert.equal((await stat(join(fixture.home, ".pi"))).mode & 0o777, 0o755,
    "a .pi directory created by another process (as Pi would have) must keep its permissions");
  assert.equal((await stat(fixture.agentDir)).mode & 0o777, 0o755,
    "an agent directory created by another process must not be chmodded by initialization");
  assert.equal((await stat(fixture.defaultConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
});

test("persistent launcher fails closed when a directory appears at the config path before publication", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-dir-race-");
  // Deterministically race the publish step: intercept the launcher's node
  // invocation and create a directory at the exact destination before the
  // linkSync call runs. Exact-destination link semantics must reject it.
  const nodeShim = join(fixture.bin, "node");
  await writeFile(nodeShim, [
    "#!/usr/bin/env bash",
    'if [[ "$1" == "-e" && "$2" == *linkSync* ]]; then',
    '  mkdir -p "$4" 2>/dev/null || true',
    "fi",
    `exec "${process.execPath}" "$@"`,
  ].join("\n"), "utf8");
  await chmod(nodeShim, 0o755);

  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /appeared during initialization but is not a regular file/);
      return true;
    },
  );

  const configDir = fixture.agentDir;
  assert.ok((await stat(fixture.defaultConfigPath)).isDirectory(), "the racing directory must not be removed");
  assert.deepEqual(await readdir(fixture.defaultConfigPath), [], "no file may be linked into the directory");
  await assertNoTempLitter(configDir);
  assert.equal(
    await readFile(join(fixture.capture, "config-env"), "utf8").then(() => true, () => false),
    false,
    "the launcher must not start pi when publication fails",
  );
});

test("persistent launcher publishes skills over a concurrently published destination (#97)", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-race-");
  // A pre-existing fallback config focuses the test on skill publication.
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  // Deterministic seam for the CI race: intercept the launcher's renameSync
  // publication call and plant a stale destination first, exactly as a
  // concurrent first launch would have published it between this launch's
  // content check and its publication. The old install-based publication hit
  // GNU "cannot create regular file ... File exists" in precisely this state.
  // The shim records every destination it intercepts so the test fails if the
  // launcher ever stops publishing through this seam (e.g. a revert to a
  // non-node publisher would bypass the plant and pass silently).
  const plantedLog = join(fixture.capture, "planted-destinations");
  const nodeShim = join(fixture.bin, "node");
  await writeFile(nodeShim, [
    "#!/usr/bin/env bash",
    'if [[ "$1" == "-e" && "$2" == *renameSync* ]]; then',
    "  printf 'stale concurrent publication\\n' > \"$4\"",
    "  printf '%s\\n' \"$4\" >> \"$CAPTURE_DIR/planted-destinations\"",
    "fi",
    `exec "${process.execPath}" "$@"`,
  ].join("\n"), "utf8");
  await chmod(nodeShim, 0o755);

  const result = await runLauncher([], launcherEnv(fixture));

  assert.doesNotMatch(
    result.stderr,
    /refusing to|could not (create|write|set)|unexpected failure|File exists/,
    "publication over an already-published destination must not fail",
  );
  assert.match(result.stdout, new RegExp(escapeRegExp(fixture.fallbackConfigPath)));
  assert.equal(await capturedConfigPath(fixture), fixture.fallbackConfigPath);

  const skillDir = join(fixture.home, ".agents", "skills", "orchestrator");
  // The atomic rename must have replaced the concurrently published (stale)
  // destination with the complete current content, at the contracted mode.
  assert.equal(
    await readFile(join(skillDir, "SKILL.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
    "the skill must be complete and current, not the stale planted content",
  );
  assert.equal(
    await readFile(join(skillDir, "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
    "the recovery reference must be complete and current",
  );
  for (const file of [join(skillDir, "SKILL.md"), join(skillDir, "references", "recovery.md")]) {
    assert.equal((await stat(file)).mode & 0o777, 0o644, `${file} must keep the contracted 0644 mode`);
  }
  for (const dir of [skillDir, join(skillDir, "references")]) {
    const entries = await readdir(dir);
    assert.ok(
      !entries.some((entry) => entry.startsWith(".skill-publish.")),
      `temporary skill files left behind in ${dir}: ${entries.join(", ")}`,
    );
  }
  assert.deepEqual(await readdir(join(skillDir, "references")), ["recovery.md"]);

  // The seam must have actually intercepted both publications; without this
  // the stale-destination precondition would never be in effect.
  const planted = (await readFile(plantedLog, "utf8")).split("\n").filter((line) => line.length > 0);
  assert.deepEqual(planted, [
    join(skillDir, "SKILL.md"),
    join(skillDir, "references", "recovery.md"),
  ], "the seam must have planted both skill destinations before publication");
});

test("persistent launcher fails closed when a directory appears at a skill path before publication (#97)", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-dir-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  // Deterministically race the skill publish step: intercept the launcher's
  // node invocation and create a directory at the exact destination before
  // the renameSync call runs. Exact-destination rename semantics must reject
  // it instead of moving the staged file into the directory.
  const nodeShim = join(fixture.bin, "node");
  await writeFile(nodeShim, [
    "#!/usr/bin/env bash",
    'if [[ "$1" == "-e" && "$2" == *renameSync* ]]; then',
    '  mkdir -p "$4" 2>/dev/null || true',
    "fi",
    `exec "${process.execPath}" "$@"`,
  ].join("\n"), "utf8");
  await chmod(nodeShim, 0o755);

  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /not a replaceable regular file/);
      return true;
    },
  );

  const skillDir = join(fixture.home, ".agents", "skills", "orchestrator");
  assert.ok((await stat(join(skillDir, "SKILL.md"))).isDirectory(), "the racing directory must not be removed");
  assert.deepEqual(await readdir(join(skillDir, "SKILL.md")), [], "no file may be published into the directory");
  const entries = await readdir(skillDir);
  assert.ok(
    !entries.some((entry) => entry.startsWith(".skill-publish.")),
    `temporary skill files left behind in ${skillDir}: ${entries.join(", ")}`,
  );
  assert.equal(
    await readFile(join(fixture.capture, "config-env"), "utf8").then(() => true, () => false),
    false,
    "the launcher must not start pi when skill publication fails",
  );
});

test("concurrent first launches never clobber or expose partial JSON", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-race-");
  const racerCount = 8;
  const racers = Array.from({ length: racerCount }, async (_value, index) => {
    const capture = join(fixture.root, `capture-${index + 1}`);
    await mkdir(capture, { recursive: true });
    const env = launcherEnv({ ...fixture, capture });
    const result = await runLauncher([], env);
    return { result, capture };
  });

  const settled = await Promise.all(racers);
  for (const { result, capture } of settled) {
    assert.doesNotMatch(
      result.stderr,
      /refusing to|could not (create|write|set)|unexpected failure/,
      "racers must not report initialization failures",
    );
    assert.equal(await readFile(join(capture, "config-env"), "utf8"), fixture.defaultConfigPath,
      "every racer must resolve the same default config");
  }

  const fileStat = await stat(fixture.defaultConfigPath);
  assert.ok(fileStat.isFile());
  assert.equal(fileStat.mode & 0o777, 0o600);
  const generated = JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")) as unknown;
  assert.deepEqual(generated, zeroModelDefaultConfig, "the surviving config must be the complete default");
  await assertNoTempLitter(fixture.agentDir);

  // Issue 97: every racer also publishes the orchestrator skill; all of them
  // must complete and leave the complete current skill content (the old
  // install-based publication raced into a GNU EEXIST failure on Linux).
  const skillDir = join(fixture.home, ".agents", "skills", "orchestrator");
  assert.equal(
    await readFile(join(skillDir, "SKILL.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
    "the surviving skill must be complete and current",
  );
  assert.equal(
    await readFile(join(skillDir, "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
    "the surviving recovery reference must be complete and current",
  );
  for (const dir of [skillDir, join(skillDir, "references")]) {
    const entries = await readdir(dir);
    assert.ok(
      !entries.some((entry) => entry.startsWith(".skill-publish.")),
      `temporary skill files left behind in ${dir}: ${entries.join(", ")}`,
    );
  }
});

test("ensure-ddgs provisions and validates Python in isolated mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-ddgs-provision-"));
  const home = join(root, "home");
  const capture = join(root, "capture");
  const ddgsVenv = join(root, "ddgs");
  await Promise.all([
    mkdir(capture, { recursive: true }),
    mkdir(join(ddgsVenv, "bin"), { recursive: true }),
  ]);
  const callsPath = join(capture, "python-calls");
  // Recording stub: fails the first version validation so the install path
  // also runs, then succeeds; pip invocations always succeed.
  const ddgsPythonPath = join(ddgsVenv, "bin", "python");
  await writeFile(ddgsPythonPath, [
    "#!/usr/bin/env bash",
    "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
    'if [[ "$1" == "-I" && "$2" == "-c" ]]; then',
    '  count=$(cat "$CAPTURE_DIR/check-count" 2>/dev/null || echo 0)',
    '  count=$((count + 1))',
    '  printf \'%s\\n\' "$count" > "$CAPTURE_DIR/check-count"',
    '  [[ "$count" -ge 2 ]] && exit 0',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n"), "utf8");
  await chmod(ddgsPythonPath, 0o755);

  await execFileAsync("bash", [resolve("scripts/ensure-ddgs.sh")], {
    env: {
      ...process.env,
      HOME: home,
      CAPTURE_DIR: capture,
      PI_REVIEW_GATE_DDGS_VENV: ddgsVenv,
    },
  });

  const calls = (await readFile(callsPath, "utf8")).split("\n").filter((line) => line.length > 0);
  // The stub fails the first validation, so all three command shapes run:
  // version validation (-c), pip install, and pip check (plus revalidation).
  assert.ok(calls.length >= 4, `expected all Python invocations to be recorded, got: ${calls.join(" | ")}`);
  for (const call of calls) {
    const args = call.split("\t").slice(1);
    // Isolated mode must come first: the launcher's working directory may be
    // an untrusted reviewed repository, so cwd must not be on sys.path.
    assert.equal(args[0], "-I", `Python invocation not in isolated mode: ${call}`);
  }
  const pipCalls = calls.filter((call) => call.includes("\tpip\t"));
  assert.ok(pipCalls.some((call) => call.includes("\tinstall\t")), "expected a pip install invocation");
  assert.ok(pipCalls.some((call) => call.includes("\tcheck\t")), "expected a pip check invocation");
  assert.ok(calls.some((call) => call.includes("\t-c\t")), "expected a -c validation invocation");
});

test("persistent launcher fails closed over an invalid default config even when the fallback is valid", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-invalid-primary-");
  // A directory where the default config belongs must never be bypassed in
  // favor of the lower-priority compatibility fallback.
  await mkdir(fixture.defaultConfigPath, { recursive: true });
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");

  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exists but is not a regular file/);
      assert.match(error.stderr, new RegExp(escapeRegExp(fixture.defaultConfigPath)));
      return true;
    },
  );
  assert.equal(
    await readFile(join(fixture.capture, "config-env"), "utf8").then(() => true, () => false),
    false,
    "the launcher must not start pi over an invalid candidate",
  );
  assert.equal(await readFile(fixture.fallbackConfigPath, "utf8"), prior,
    "the fallback must not be used or rewritten");
  assert.ok((await stat(fixture.defaultConfigPath)).isDirectory(), "the invalid path must not be removed");
});

test("persistent launcher fails closed over a dangling default config symlink even when the fallback is valid", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-dangling-primary-");
  await mkdir(fixture.agentDir, { recursive: true });
  await symlink("/nonexistent/review-gate-target", fixture.defaultConfigPath);
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");

  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exists but is not a regular file/);
      return true;
    },
  );
  assert.equal(
    await readFile(join(fixture.capture, "config-env"), "utf8").then(() => true, () => false),
    false,
    "a dangling higher-priority candidate must not be bypassed",
  );
});

test("persistent launcher fails closed over an invalid fallback and never initializes a competing default", async () => {
  // The default is absent; the compatibility fallback exists but is not a
  // usable regular file. Initialization at the default location would silently
  // create a competing default and must be refused.
  for (const kind of ["directory", "dangling-symlink"] as const) {
    const fixture = await makeLauncherFixture(`pi-review-launcher-invalid-fallback-${kind}-`);
    if (kind === "directory") {
      await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
      await mkdir(fixture.fallbackConfigPath, { recursive: true });
    } else {
      await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
      await symlink("/nonexistent/config-target", fixture.fallbackConfigPath);
    }

    await assert.rejects(
      runLauncher([], launcherEnv(fixture)),
      (error: unknown) => {
        assert.ok(isExecError(error));
        assert.equal(error.code, 2);
        assert.match(error.stderr, /exists but is not a regular file/);
        assert.match(error.stderr, new RegExp(escapeRegExp(fixture.fallbackConfigPath)));
        return true;
      },
    );
    assert.equal(
      await pathExists(fixture.agentDir),
      false,
      "initialization must not create a competing default beside an invalid fallback",
    );
    assert.equal(
      await readFile(join(fixture.capture, "config-env"), "utf8").then(() => true, () => false),
      false,
      "the launcher must not start pi over an invalid fallback",
    );
  }
});

function isExecError(value: unknown): value is Error & { code: number; stderr: string } {
  return typeof value === "object" && value !== null && "code" in value && "stderr" in value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}