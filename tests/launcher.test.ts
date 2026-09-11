import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  primaryConfigPath: string;
  fallbackConfigPath: string;
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
    primaryConfigPath: join(home, ".config", "pi-review-gate", "config.json"),
    fallbackConfigPath: join(home, ".config", "pi", "review-gate.json"),
  };
}

function launcherEnv(fixture: LauncherFixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Sanitize inherited gate variables so the tests observe the launcher's own
  // resolution (and role-sensitive behavior stays at its default).
  delete env.PI_REVIEW_GATE_CONFIG;
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

async function runLauncher(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(resolve("scripts/pi-review-gate.sh"), args, { env });
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

async function assertNoTempLitter(dir: string): Promise<void> {
  const entries = await readdir(dir);
  assert.ok(
    !entries.some((entry) => entry.startsWith(".config.json.")),
    `temporary config files left behind in ${dir}: ${entries.join(", ")}`,
  );
}

test("persistent launcher uses the Pi fallback config and forwards arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-launcher-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  const ddgsVenv = join(root, "ddgs");
  await Promise.all([
    mkdir(join(home, ".config", "pi"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(capture, { recursive: true }),
    mkdir(join(ddgsVenv, "bin"), { recursive: true }),
  ]);
  const configPath = join(home, ".config", "pi", "review-gate.json");
  await writeFile(configPath, "{}\n", "utf8");
  const npmPath = join(bin, "npm");
  const piPath = join(bin, "pi");
  const ddgsPythonPath = join(ddgsVenv, "bin", "python");
  await writeFile(npmPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(ddgsPythonPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s' \"${PI_REVIEW_GATE_DISABLED:-unset}\" > \"$CAPTURE_DIR/disabled-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await Promise.all([chmod(npmPath, 0o755), chmod(piPath, 0o755), chmod(ddgsPythonPath, 0o755)]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CAPTURE_DIR: capture,
    PI_REVIEW_GATE_DDGS_VENV: ddgsVenv,
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
  };
  // Enabled case must be deterministic even if the surrounding environment
  // happens to carry the kill switch.
  delete env.PI_REVIEW_GATE_DISABLED;

  const result = await execFileAsync(resolve("scripts/pi-review-gate.sh"), ["--model", "example", "--tools", "read,bash"], { env });

  assert.match(result.stdout, new RegExp(escapeRegExp(configPath)));
  assert.doesNotMatch(result.stdout, /will not activate/);
  assert.equal(await readFile(join(capture, "config-env"), "utf8"), configPath);
  assert.equal(await readFile(join(capture, "disabled-env"), "utf8"), "unset");
  assert.equal(
    await readFile(join(home, ".agents", "skills", "orchestrator", "SKILL.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(join(home, ".agents", "skills", "orchestrator", "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/orchestrator/references/recovery.md"), "utf8"),
  );
  // The launcher no longer bakes the orchestrator prompt in with
  // --append-system-prompt: the extension owns the operating-mode segment.
  assert.equal(
    await readFile(join(capture, "args"), "utf8"),
    `--extension\n${resolve("dist/src/index.js")}\n--model\nexample\n--tools\nread,bash\n`,
  );
});

test("persistent launcher honors the PI_REVIEW_GATE_DISABLED kill switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-launcher-disabled-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  const ddgsVenv = join(root, "ddgs");
  await Promise.all([
    mkdir(join(home, ".config", "pi"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(capture, { recursive: true }),
    mkdir(join(ddgsVenv, "bin"), { recursive: true }),
  ]);
  const configPath = join(home, ".config", "pi", "review-gate.json");
  await writeFile(configPath, "{}\n", "utf8");
  const npmPath = join(bin, "npm");
  const piPath = join(bin, "pi");
  const ddgsPythonPath = join(ddgsVenv, "bin", "python");
  await writeFile(npmPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(ddgsPythonPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s' \"${PI_REVIEW_GATE_DISABLED:-unset}\" > \"$CAPTURE_DIR/disabled-env\"",
  ].join("\n"), "utf8");
  await Promise.all([chmod(npmPath, 0o755), chmod(piPath, 0o755), chmod(ddgsPythonPath, 0o755)]);

  const result = await execFileAsync(resolve("scripts/pi-review-gate.sh"), ["--model", "example"], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CAPTURE_DIR: capture,
      PI_REVIEW_GATE_DDGS_VENV: ddgsVenv,
      // Inherited from a parent session: sanitization must still override it
      // even with the kill switch active.
      PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
      // Kill switch set by the user:
      PI_REVIEW_GATE_DISABLED: "1",
    },
  });

  assert.match(result.stdout, /PI_REVIEW_GATE_DISABLED is set; the review gate will not activate/);
  // The kill switch must reach the pi child (and therefore the extension),
  // which disables the gate; the launcher must no longer strip it.
  assert.equal(await readFile(join(capture, "disabled-env"), "utf8"), "1");
  // Persistent config resolution/sanitization still applies while disabled.
  assert.equal(await readFile(join(capture, "config-env"), "utf8"), configPath);
});

test("persistent launcher refreshes a stale installed orchestrator skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-launcher-skill-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  const ddgsVenv = join(root, "ddgs");
  const installedSkill = join(home, ".agents", "skills", "orchestrator", "SKILL.md");
  const installedRecovery = join(home, ".agents", "skills", "orchestrator", "references", "recovery.md");
  await Promise.all([
    mkdir(join(home, ".config", "pi"), { recursive: true }),
    mkdir(join(home, ".agents", "skills", "orchestrator", "references"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(capture, { recursive: true }),
    mkdir(join(ddgsVenv, "bin"), { recursive: true }),
  ]);
  await writeFile(join(home, ".config", "pi", "review-gate.json"), "{}\n", "utf8");
  await writeFile(installedSkill, "stale\n", "utf8");
  await writeFile(installedRecovery, "stale recovery\n", "utf8");
  await writeFile(join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(join(bin, "pi"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  const ddgsPythonPath = join(ddgsVenv, "bin", "python");
  await writeFile(ddgsPythonPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await Promise.all([
    chmod(join(bin, "npm"), 0o755),
    chmod(join(bin, "pi"), 0o755),
    chmod(ddgsPythonPath, 0o755),
  ]);

  await execFileAsync(resolve("scripts/pi-review-gate.sh"), [], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CAPTURE_DIR: capture,
      PI_REVIEW_GATE_DDGS_VENV: ddgsVenv,
    },
  });

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

test("persistent launcher first launch creates a private zero-model default config and continues", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-first-");

  // An inherited PI_REVIEW_GATE_CONFIG must not redirect the first launch:
  // sanitization still applies, and initialization targets the primary path.
  const result = await runLauncher(["--model", "example"], launcherEnv(fixture, {
    PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
  }));

  assert.match(result.stderr, /no persistent config found; created default zero-model config at/);
  assert.match(result.stderr, /no reviewers or workers are selected yet; configure them with \/review-settings/);
  assert.equal(await capturedConfigPath(fixture), fixture.primaryConfigPath);
  assert.match(result.stdout, new RegExp(escapeRegExp(fixture.primaryConfigPath)));

  const fileStat = await stat(fixture.primaryConfigPath);
  assert.ok(fileStat.isFile(), "primary config must be a regular file");
  assert.equal(fileStat.mode & 0o777, 0o600, "new config file must be private (0600)");
  const dirStat = await stat(join(fixture.home, ".config", "pi-review-gate"));
  assert.ok(dirStat.isDirectory());
  assert.equal(dirStat.mode & 0o777, 0o700, "new config directory must be private (0700)");

  const generated = JSON.parse(await readFile(fixture.primaryConfigPath, "utf8")) as unknown;
  assert.deepEqual(generated, zeroModelDefaultConfig);
  assert.equal(await stat(fixture.fallbackConfigPath).then(() => true, () => false), false,
    "first launch must not create the fallback config");
  await assertNoTempLitter(join(fixture.home, ".config", "pi-review-gate"));
});

test("persistent launcher subsequent launch preserves an existing primary config", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-second-");
  const prior = '{"enabled":true,"retainBundles":"always","reviewerTimeoutMs":123456}\n';
  await mkdir(join(fixture.home, ".config", "pi-review-gate"), { recursive: true });
  await writeFile(fixture.primaryConfigPath, prior, "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.doesNotMatch(result.stderr, /created default zero-model config/);
  assert.equal(await capturedConfigPath(fixture), fixture.primaryConfigPath);
  assert.equal(await readFile(fixture.primaryConfigPath, "utf8"), prior, "existing config must not be rewritten");
  const entries = await readdir(join(fixture.home, ".config", "pi-review-gate"));
  assert.deepEqual(entries, ["config.json"]);
});

test("persistent launcher keeps fallback discovery and does not initialize when a fallback exists", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-fallback-keep-");
  const prior = '{"enabled":true,"marker":"fallback"}\n';
  await mkdir(join(fixture.home, ".config", "pi"), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, prior, "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await capturedConfigPath(fixture), fixture.fallbackConfigPath);
  assert.equal(await readFile(fixture.fallbackConfigPath, "utf8"), prior);
  assert.equal(
    await stat(join(fixture.home, ".config", "pi-review-gate")).then(() => true, () => false),
    false,
    "a present fallback config must not trigger primary initialization",
  );
});

test("persistent launcher prefers the primary config over the fallback", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-precedence-");
  await mkdir(join(fixture.home, ".config", "pi-review-gate"), { recursive: true });
  await mkdir(join(fixture.home, ".config", "pi"), { recursive: true });
  await writeFile(fixture.primaryConfigPath, '{"enabled":true,"marker":"primary"}\n', "utf8");
  await writeFile(fixture.fallbackConfigPath, '{"enabled":true,"marker":"fallback"}\n', "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await capturedConfigPath(fixture), fixture.primaryConfigPath);
});

test("persistent launcher never replaces a malformed existing config", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-malformed-");
  const malformed = "{not json";
  await mkdir(join(fixture.home, ".config", "pi-review-gate"), { recursive: true });
  await writeFile(fixture.primaryConfigPath, malformed, "utf8");

  // The launcher does not parse the config; it must still hand the malformed
  // file through untouched so the extension reports its own config error.
  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await capturedConfigPath(fixture), fixture.primaryConfigPath);
  assert.equal(await readFile(fixture.primaryConfigPath, "utf8"), malformed, "malformed config must be preserved");
});

test("first-launch default config validates under normalization with zero reviewers and workers", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-zero-model-");
  await runLauncher([], launcherEnv(fixture));

  const raw = await readFile(fixture.primaryConfigPath, "utf8");
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
  const loaded = loadConfig({ PI_REVIEW_GATE_CONFIG: fixture.primaryConfigPath });
  assert.equal(loaded.path, fixture.primaryConfigPath);
  assert.equal(loaded.config.enabled, true);
  assert.equal(automaticReviewEnabled(loaded.config), false);
});

test("first-launch default config stays usable for settings persistence", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-settings-");
  await runLauncher([], launcherEnv(fixture));

  // /review-settings writes through the same atomic update path; the
  // zero-model file must round-trip without gaining any model selection.
  const saved = await persistSubtasksViewPreference(fixture.primaryConfigPath, true);
  assert.equal(saved.ui?.subtasksViewExpanded, true);
  assert.deepEqual(resolveReviewers(saved).reviewers, []);
  assert.deepEqual(resolvedWorkerResources(saved), []);

  const updated = JSON.parse(await readFile(fixture.primaryConfigPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(updated.review, { activeReviewers: [] });
  assert.equal((await stat(fixture.primaryConfigPath)).mode & 0o777, 0o600,
    "settings persistence must keep the private file mode");
});

test("persistent launcher fails closed when the config directory is not writable", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-perm-");
  const configDir = join(fixture.home, ".config", "pi-review-gate");
  await mkdir(configDir, { recursive: true });
  await chmod(configDir, 0o500);
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
    const entries = await readdir(configDir);
    assert.deepEqual(entries, [], "no partial config or temp file may be left behind");
  } finally {
    await chmod(configDir, 0o755);
  }
});

test("persistent launcher fails closed over an existing invalid path at the primary location", async () => {
  // A directory where the config file belongs.
  const fixture = await makeLauncherFixture("pi-review-launcher-nonreg-");
  await mkdir(fixture.primaryConfigPath, { recursive: true });
  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /exists but is not a regular file/);
      return true;
    },
  );
  assert.ok((await stat(fixture.primaryConfigPath)).isDirectory(), "the non-regular path must not be removed");

  // A plain file where the .config directory belongs.
  const blocked = await makeLauncherFixture("pi-review-launcher-dotcfg-");
  await writeFile(join(blocked.home, ".config"), "not a directory\n", "utf8");
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
  const configDirs = logged.filter((line) => line.startsWith(join(fixture.home, ".config")));
  assert.ok(configDirs.length >= 2, `expected the created config directories to be recorded: ${logged.join(" | ")}`);
  for (const line of configDirs) {
    const [path, mode] = line.split("\t");
    assert.equal(parseInt(mode, 8) & 0o777, 0o700,
      `config directory ${path} must be private from the instant of creation despite umask 0`);
  }
  assert.equal((await stat(join(fixture.home, ".config"))).mode & 0o777, 0o700,
    "newly created .config must be private despite umask 0");
  assert.equal((await stat(join(fixture.home, ".config", "pi-review-gate"))).mode & 0o777, 0o700,
    "newly created gate directory must be private despite umask 0");
  assert.equal((await stat(fixture.primaryConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fixture.primaryConfigPath, "utf8")), zeroModelDefaultConfig);
});

test("first launch preserves permissions of directories created by a competing process", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-dirmode-");
  // Simulate the creation race deterministically: every directory the launcher
  // tries to create already exists (created at 0755 by the shim, standing in
  // for a concurrent launch) before the real mkdir runs and fails with EEXIST.
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

  assert.equal((await stat(join(fixture.home, ".config"))).mode & 0o777, 0o755,
    "a .config directory created by another process must keep its permissions");
  assert.equal((await stat(join(fixture.home, ".config", "pi-review-gate"))).mode & 0o777, 0o755,
    "a gate directory created by another process must not be chmodded by initialization");
  assert.equal((await stat(fixture.primaryConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fixture.primaryConfigPath, "utf8")), zeroModelDefaultConfig);
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

  const configDir = join(fixture.home, ".config", "pi-review-gate");
  assert.ok((await stat(fixture.primaryConfigPath)).isDirectory(), "the racing directory must not be removed");
  assert.deepEqual(await readdir(fixture.primaryConfigPath), [], "no file may be linked into the directory");
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
  await mkdir(join(fixture.home, ".config", "pi"), { recursive: true });
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
  await mkdir(join(fixture.home, ".config", "pi"), { recursive: true });
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
    assert.equal(await readFile(join(capture, "config-env"), "utf8"), fixture.primaryConfigPath,
      "every racer must resolve the same primary config");
  }

  const fileStat = await stat(fixture.primaryConfigPath);
  assert.ok(fileStat.isFile());
  assert.equal(fileStat.mode & 0o777, 0o600);
  const generated = JSON.parse(await readFile(fixture.primaryConfigPath, "utf8")) as unknown;
  assert.deepEqual(generated, zeroModelDefaultConfig, "the surviving config must be the complete default");
  await assertNoTempLitter(join(fixture.home, ".config", "pi-review-gate"));

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
    "{ printf 'CALL\\t'; printf '%s\\t' \"$@\"; printf '\\n'; } \u003e\u003e \"$CAPTURE_DIR/python-calls\"",
    'if [[ "$1" == "-I" && "$2" == "-c" ]]; then',
    '  count=$(cat "$CAPTURE_DIR/check-count" 2>/dev/null || echo 0)',
    '  count=$((count + 1))',
    '  printf \'%s\\n\' "$count" \u003e "$CAPTURE_DIR/check-count"',
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

function isExecError(value: unknown): value is Error & { code: number; stderr: string } {
  return typeof value === "object" && value !== null && "code" in value && "stderr" in value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
