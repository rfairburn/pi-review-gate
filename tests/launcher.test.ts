import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
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
import { extensionFromArgs, isCompiledExtension, writeFakeNpm } from "./launcher-prepare-fixtures";

const execFileAsync = promisify(execFile);

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
  const piPath = join(bin, "pi");
  const ddgsPythonPath = join(ddgsVenv, "bin", "python");
  await writeFile(ddgsPythonPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  // The shared preparation engine resolves PATH's npm through its public JS
  // entry; this synthetic installation behaves like a real locked install.
  await writeFakeNpm(bin);
  await Promise.all([chmod(piPath, 0o755), chmod(ddgsPythonPath, 0o755)]);
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
  // Hermeticity for the wrapper-owned codemode default: tests that verify the
  // export set it explicitly (including its inherited-value override).
  delete env.PI_REVIEW_GATE_CODEMODE_DEFAULT;
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

/**
 * Pre-#151 migration fixtures: byte-exact historical content except the
 * redacted execution fixture, whose original published digest remains pinned
 * in the launcher. Independent of later shipped-skill edits such as #179's.
 */
async function historicalFixture(installedPath: string): Promise<string> {
  return readFile(join(resolve("tests", "fixtures", "skill-migration"), ...installedPath.split("/")), "utf8");
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
    await readFile(join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "references", "recovery.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/references/recovery.md"), "utf8"),
  );
  assert.equal(
    await readFile(join(fixture.home, ".agents", "skills", "pi-review-gate-completion", "SKILL.md"), "utf8"),
    await readFile(resolve("skills/pi-review-gate-completion/SKILL.md"), "utf8"),
    "the completion skill must be installed from its packaged source",
  );
  // The launcher no longer bakes the orchestrator prompt in with
  // --append-system-prompt: the extension owns the operating-mode segment.
  const launch = extensionFromArgs(await readFile(join(fixture.capture, "args"), "utf8"));
  assert.equal(isCompiledExtension(launch.extension), true, "the prepared extension entry is passed to pi");
  assert.deepEqual(launch.forwarded, ["--model", "example", "--tools", "read,bash"]);
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

test("persistent launcher clears an inherited scheduler flag and honors --scheduler", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-scheduler-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const piPath = join(fixture.bin, "pi");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_SCHEDULER:-unset}\" > \"$CAPTURE_DIR/scheduler-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await chmod(piPath, 0o755);

  // Hermetic base: the host environment never contributes the flag.
  const envFor = (overrides: NodeJS.ProcessEnv = {}) => {
    const base = launcherEnv(fixture);
    delete base.PI_REVIEW_GATE_SCHEDULER;
    return { ...base, ...overrides };
  };

  // Inherited from a parent launched with --scheduler: an unflagged launch
  // must start Off — the inherited value is cleared, never forwarded.
  await runLauncher(["--model", "example"], envFor({ PI_REVIEW_GATE_SCHEDULER: "1" }));
  assert.equal(
    await readFile(join(fixture.capture, "scheduler-env"), "utf8"),
    "unset",
    "an inherited scheduler flag must not leak into an unflagged launch",
  );

  // The explicit flag opts in for exactly this launch, with or without an
  // inherited value, and is never forwarded to pi.
  const assertFlaggedLaunch = async (label: string) => {
    assert.equal(
      await readFile(join(fixture.capture, "scheduler-env"), "utf8"),
      "1",
      `--scheduler exports the flag for this launch (${label})`,
    );
    const launch = extensionFromArgs(await readFile(join(fixture.capture, "args"), "utf8"));
    assert.equal(isCompiledExtension(launch.extension), true);
    assert.deepEqual(
      launch.forwarded,
      ["--model", "example"],
      "--scheduler is consumed by the launcher and never forwarded to pi",
    );
  };

  await runLauncher(["--scheduler", "--model", "example"], envFor({ PI_REVIEW_GATE_SCHEDULER: "1" }));
  await assertFlaggedLaunch("inherited value present");

  await runLauncher(["--scheduler", "--model", "example"], envFor());
  await assertFlaggedLaunch("no inherited value");
});

test("persistent launcher exports the wrapper codemode default without rewriting tool arguments", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-codemode-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const piPath = join(fixture.bin, "pi");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CODEMODE_DEFAULT:-unset}\" > \"$CAPTURE_DIR/codemode-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await chmod(piPath, 0o755);

  const result = await runLauncher(
    ["--model", "example", "--tools", "read,bash", "--exclude-tools", "bash", "--no-extensions"],
    // An inherited value must not survive: the wrapper owns the normal-launch
    // default (the same scoped overwriting as PI_REVIEW_GATE_CONFIG).
    launcherEnv(fixture, { PI_REVIEW_GATE_CODEMODE_DEFAULT: "0" }),
  );

  assert.equal(
    await readFile(join(fixture.capture, "codemode-env"), "utf8"),
    "1",
    "normal launches must export the wrapper's scoped codemode default",
  );
  // Tool restrictions reach pi byte-exact: the wrapper default must never
  // append or replace a pi tool argument (Pi's --tools replaces the
  // selection; the extension enables codemode only when Pi's
  // policy-filtered tool set still contains it).
  const launch = extensionFromArgs(await readFile(join(fixture.capture, "args"), "utf8"));
  assert.equal(isCompiledExtension(launch.extension), true);
  assert.deepEqual(launch.forwarded, ["--model", "example", "--tools", "read,bash", "--exclude-tools", "bash", "--no-extensions"]);
  assert.doesNotMatch(result.stdout, /--tools/, "the wrapper must not inject pi tool flags");
});

test("persistent launcher management passthrough (including native pi mcp) skips setup and never sets the codemode flag", async () => {
  // Every management-invocation form, including Pi 1.0's native `pi mcp`
  // management (`pi mcp` shell commands do not load extensions), must behave
  // exactly like `exec pi` before any wrapper setup: no config resolution or
  // initialization, no build, no DDGS or skill publication, and never the
  // launcher's codemode export.
  const forms: string[][] = [
    ["list"],
    ["mcp"],
    ["mcp", "add", "docs", "--url", "https://example.com/mcp"],
  ];
  for (const args of forms) {
    const fixture = await makeLauncherFixture(`pi-review-launcher-mgmt-${args[0]}-`);
    const piPath = join(fixture.bin, "pi");
    await writeFile(piPath, [
      "#!/usr/bin/env bash",
      "printf '%s' \"${PI_REVIEW_GATE_CODEMODE_DEFAULT:-unset}\" > \"$CAPTURE_DIR/codemode-env\"",
      "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
    ].join("\n"), "utf8");
    await chmod(piPath, 0o755);

    // exec pi parity for the environment: an inherited value reaches pi
    // untouched (the passthrough never rewrites it, never exports the
    // default, and never strips it).
    await runLauncher(args, launcherEnv(fixture, { PI_REVIEW_GATE_CODEMODE_DEFAULT: "0" }));
    assert.equal(
      await readFile(join(fixture.capture, "codemode-env"), "utf8"),
      "0",
      `management passthrough keeps the inherited environment (${args.join(" ")})`,
    );
    assert.equal(
      await readFile(join(fixture.capture, "args"), "utf8"),
      `${args.join("\n")}\n`,
      "management passthrough forwards the arguments untouched (no extension flag)",
    );
    assert.equal(
      await pathExists(join(fixture.home, ".pi")),
      false,
      "management passthrough must not initialize the config",
    );
    assert.equal(
      await pathExists(join(fixture.home, ".agents")),
      false,
      "management passthrough must not publish the skills",
    );
  }

  // With no inherited value the passthrough exports nothing: the launcher
  // itself never sets the flag for a management invocation.
  const fixture = await makeLauncherFixture("pi-review-launcher-mgmt-clean-");
  const piPath = join(fixture.bin, "pi");
  await writeFile(piPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CODEMODE_DEFAULT:-unset}\" > \"$CAPTURE_DIR/codemode-env\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await chmod(piPath, 0o755);
  await runLauncher(["list"], launcherEnv(fixture));
  assert.equal(
    await readFile(join(fixture.capture, "codemode-env"), "utf8"),
    "unset",
    "a clean management invocation must not gain the codemode default",
  );
});

test("persistent launcher refreshes stale installed orchestrator and completion skills", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-");
  const installedSkill = join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md");
  const installedRecovery = join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "references", "recovery.md");
  const installedCompletion = join(fixture.home, ".agents", "skills", "pi-review-gate-completion", "SKILL.md");
  await Promise.all([
    mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true }),
    mkdir(join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "references"), { recursive: true }),
    mkdir(join(fixture.home, ".agents", "skills", "pi-review-gate-completion"), { recursive: true }),
  ]);
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  await writeFile(installedSkill, "stale\n", "utf8");
  await writeFile(installedRecovery, "stale recovery\n", "utf8");
  await writeFile(installedCompletion, "stale completion skill\n", "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(
    await readFile(installedSkill, "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(installedRecovery, "utf8"),
    await readFile(resolve("skills/pi-review-gate-orchestrator/references/recovery.md"), "utf8"),
  );
  assert.equal(
    await readFile(installedCompletion, "utf8"),
    await readFile(resolve("skills/pi-review-gate-completion/SKILL.md"), "utf8"),
    "a stale completion skill must be atomically refreshed from its packaged source",
  );
  for (const name of ["pi-review-gate-execution", "pi-review-gate-research"]) {
    assert.equal(
      await readFile(join(fixture.home, ".agents", "skills", name, "SKILL.md"), "utf8"),
      await readFile(resolve(`skills/${name}/SKILL.md`), "utf8"),
      `the ${name} skill must be provisioned alongside the orchestrator skill`,
    );
  }
  assert.match(result.stdout, /pi-review-gate orchestrator skill: /);
  assert.match(result.stdout, /pi-review-gate execution skill: /);
  assert.match(result.stdout, /pi-review-gate research skill: /);
  assert.match(result.stdout, /pi-review-gate completion skill: /);
});

test("persistent launcher preserves unrelated custom skills under ~/.agents/skills", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-custom-skill-");
  const customSkill = join(fixture.home, ".agents", "skills", "my-custom-skill", "SKILL.md");
  const customContent = "---\nname: my-custom-skill\ndescription: user-owned skill\n---\nuser-owned\n";
  await Promise.all([
    mkdir(join(customSkill, ".."), { recursive: true }),
    mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true }),
  ]);
  await writeFile(customSkill, customContent, "utf8");
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const result = await runLauncher([], launcherEnv(fixture));

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
  assert.match(result.stdout, /pi-review-gate completion skill: /);
});

test("persistent launcher migrates proven pre-#151 generic skill copies and preserves modified or unrelated files (#151)", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-migration-");
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

  const result = await runLauncher([], launcherEnv(fixture));

  // The namespaced skills are provisioned regardless.
  for (const name of ["pi-review-gate-orchestrator", "pi-review-gate-execution", "pi-review-gate-research", "pi-review-gate-completion"]) {
    assert.equal(
      await readFile(join(fixture.home, ".agents", "skills", name, "SKILL.md"), "utf8"),
      await readFile(resolve(`skills/${name}/SKILL.md`), "utf8"),
      `the ${name} skill must be provisioned during the migration launch`,
    );
  }
  // Only proven unmodified package-owned copies are removed.
  for (const removed of [priorOrchestrator, priorRecovery]) {
    assert.equal(await pathExists(removed), false, `the proven prior copy must be migrated away: ${removed}`);
  }
  assert.equal(await readFile(priorExecution, "utf8"), await historicalFixture("execution/SKILL.md"),
    "the redacted fixture is not the originally published execution copy and must be preserved");
  // A modified old copy is ambiguous or user-owned: preserved untouched.
  assert.equal(await readFile(modifiedResearch, "utf8"), researchContent, "a modified generic copy must be preserved");
  // Unrelated files under the old directories are preserved, and no
  // directory is ever removed.
  assert.equal(await readFile(unrelatedFile, "utf8"), "user notes\n", "unrelated files under old skill directories must be preserved");
  assert.equal(await pathExists(join(skillsDir, "orchestrator")), true, "old directories are never removed");
  assert.match(result.stderr, /removed the unmodified prior copy/);
  assert.match(result.stdout, /pi-review-gate orchestrator skill: /);
});

test("persistent launcher preserves customized generic copies that normalize to shipped content and keeps recovery.md for a customized orchestrator (#154)", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-ownership-");
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
  // content at the generic path themselves. It normalizes to the shipped
  // text under the old rename transform, but its bytes are not the
  // historical generic copy (whose frontmatter name was `execution`), so it
  // must be preserved.
  const executionCopy = await readFile(resolve("skills/pi-review-gate-execution/SKILL.md"), "utf8");
  // Partially renamed and customized: the frontmatter name already carries
  // the namespace, one role-skill link was already namespaced, but the other
  // link and an added note are user customization. No proof of historical
  // identity exists, so it must be preserved.
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

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await readFile(fullyRenamedExecution, "utf8"), executionCopy, "a fully renamed generic copy must be preserved");
  assert.equal(await readFile(partiallyRenamedOrchestrator, "utf8"), orchestratorCustom, "a partially renamed customized generic copy must be preserved");
  assert.equal(await readFile(genericRecovery, "utf8"), recoveryCopy, "recovery.md must be preserved while the customized generic orchestrator SKILL.md remains");
  assert.doesNotMatch(result.stderr, /removed the unmodified prior copy/);
});

test("persistent launcher removes recovery.md together with a proven generic orchestrator SKILL.md (#154)", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-paired-");
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

  const result = await runLauncher([], launcherEnv(fixture));

  assert.equal(await pathExists(priorOrchestrator), false, "the proven generic orchestrator SKILL.md must be migrated away");
  assert.equal(await pathExists(priorRecovery), false, "the proven generic recovery.md must be removed with its paired SKILL.md");
  assert.match(result.stderr, /removed the unmodified prior copy/);
});

test("persistent launcher never deletes through a symlinked legacy skill path (#151)", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-alias-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");

  const skillsDir = join(fixture.home, ".agents", "skills");
  // User alias: the legacy orchestrator directory points at the namespaced
  // one (a natural way to keep the old discoverable name working). The
  // publish loop then writes the namespaced files the alias resolves to.
  await mkdir(skillsDir, { recursive: true });
  await symlink(join(skillsDir, "pi-review-gate-orchestrator"), join(skillsDir, "orchestrator"), "dir");

  const result = await runLauncher([], launcherEnv(fixture));

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
  assert.match(prompt, /pass that checkout as the group's `workspace`/);
  assert.match(prompt, /must never instruct the worker to check it out or commit on it/);
  assert.match(prompt, /detached-HEAD managed worktrees at synthetic captured bases/);
  assert.match(prompt, /the harness owns checkpointing and landing/);
  assert.doesNotMatch(prompt, /live-turn-only/);
  assert.doesNotMatch(prompt, /delegation overhead/);
  assert.doesNotMatch(prompt, /You may directly handle/);
});

test("orchestrator skill explains worktree isolation and three-way landing", async () => {
  const skill = await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8");
  assert.match(skill, /separate, isolated Git worktree/);
  assert.match(skill, /Siblings do not share a working directory/);
  assert.match(skill, /guarded three-way merge\/integration/);
  assert.match(skill, /captured base, the current main workspace, and the accepted worker result/);
  assert.match(skill, /diff3 conflict markers/);
  assert.match(skill, /references\/recovery\.md/);
  // Branch ownership stays with the target checkout; workers stay detached.
  assert.match(skill, /prepare the task's named issue branch there/);
  assert.match(skill, /Never instruct a worker to check out, create, or switch to that branch/);
  assert.match(skill, /detached HEAD at a synthetic captured base/);
  assert.match(skill, /the harness owns checkpointing and landing/);
  assert.match(skill, /commits, checkpoints, and landings are harness-owned/);
});

test("orchestrator guidance favors beneficial parallelism and bounded tasks without forcing concurrency", async () => {
  // Policy-presence check on the shipped orchestrator surfaces. These checks
  // validate wording and wiring only; they are not evidence that a model
  // consistently chooses beneficial parallelism.
  const skill = await readFile(resolve("skills/pi-review-gate-orchestrator/SKILL.md"), "utf8");
  for (const phrase of [
    "Shape concurrency from dependencies and benefit, not from available capacity",
    "not a utilization target",
    "no minimum task count",
    "waiting or serial execution is correct when no useful independent work is ready",
    "one concrete, coherent outcome per subtask",
    "without assuming advance knowledge of which model will serve the worker",
    "shared contracts are settled",
    "not automatic cancellation or a rigid limit",
  ]) {
    assert.ok(skill.includes(phrase), `orchestrator skill missing: ${phrase}`);
  }
  const prompt = await readFile(resolve("scripts/orchestrator-system-prompt.md"), "utf8");
  for (const phrase of [
    "opportunity, not a utilization target",
    "one concrete, coherent outcome",
    "without assuming which model will serve the worker",
    "shared contracts are settled",
  ]) {
    assert.ok(prompt.includes(phrase), `orchestrator prompt missing: ${phrase}`);
  }
  // Prose wraps at the column limit, so match on whitespace-normalized text.
  const docs = (await readFile(resolve("docs/delegated-execution.md"), "utf8")).replace(/\s+/g, " ");
  for (const phrase of [
    "## Task construction and parallelism",
    "there is no minimum task count",
    "do not prove a model consistently chooses beneficial parallelism",
    "declining slot-filling, redundant research, speculative artifacts",
    "legitimate waiting when nothing useful is ready",
  ]) {
    assert.ok(docs.includes(phrase), `delegated-execution docs missing: ${phrase}`);
  }
  // The guidance must not introduce the anti-patterns it forbids: mandated
  // task counts, mandatory research, or timeout-based cancellation.
  for (const [name, text] of [["skill", skill], ["prompt", prompt]] as const) {
    assert.doesNotMatch(text, /at least \d+ tasks|minimum of \d+ tasks/i, `${name} mandates a task count`);
    assert.doesNotMatch(text, /mandatory research/i, `${name} mandates research`);
    assert.doesNotMatch(text, /cancels? after \d+/i, `${name} introduces timeout cancellation`);
  }
  assert.doesNotMatch(docs, /at least \d+ tasks|minimum of \d+ tasks/i, "docs mandate a task count");
  assert.doesNotMatch(docs, /mandatory research/i, "docs mandate research");
});

test("orchestrator recovery reference covers recoverable execution states", async () => {
  const recovery = await readFile(resolve("skills/pi-review-gate-orchestrator/references/recovery.md"), "utf8");
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
    // Detached-worktree branch-checkout damage: verified current-capability salvage.
    "detached HEAD was replaced by a branch checkout",
    "refs/pi-review-gate/waves/<waveId>/base",
    "moves HEAD and the working tree to that commit's tree",
    "Branch creation without a start point",
    "update-ref refs/pi-review-gate/waves/<waveId>/salvage/<taskId>",
    "salvage/<taskId>-stash <stashSha>",
    "stash push --include-untracked",
    "stash show --binary -p <stashSha>",
    "the stash still records the index state in its second parent",
    "diff --binary <stashSha>\\^1 <stashSha>\\^2",
    "show --binary <stashSha>\\^3",
    "diff --binary <runStartCommit> <runTipCommit>",
    "fails with \"unknown revision\"",
    "the only path for salvaged uncommitted content is the user-authorized manual application",
    "bare form: detaches at the current commit; the working tree does not change",
    "Never use `git checkout --detach <sha>` here",
    "exporting alone has placed nothing anywhere",
    "must never be applied into the target checkout",
    "checkout --detach",
    "does not create, verify, or revalidate any durable harness checkpoint",
    "Manual mechanical salvage",
    "user-authorized manual recovery",
    "git merge-base HEAD <baseCommit>",
    "Never run `git reset --hard`",
    // Failed checkpoint staging (#179): pre-review failure class, in-place
    // continuation versus mechanical salvage, and the sample instruction
    // contract with its explicit prohibitions.
    "## Recover a failed checkpoint staging",
    "Staging happens \\*\\*before review of that turn\\*\\*",
    "the task stops at the checkpointing stage with no newly verified candidate",
    "No recovery step may claim to have read or restored hidden model state",
    "`SubtasksContinue` with explicit `inPlace: true`",
    "attempts to finish a stopped execute task in its exact retained worktree",
    "A `failed_critical` state is",
    "session is genuinely available; otherwise a fresh turn sees the retained",
    "transfers the identified retained work into main for manual inspection",
    "It never asserts review success,",
    "it never replaces inspecting main afterward",
    "### Sample task instructions for checkpoint-sensitive work",
    "Treat everything you did not create as unknown",
    "positively identify as a disposable artifact this task created",
    "Do not run blanket `git clean`, `git reset --hard`, or any branch checkout in",
    "Then finish only the remaining requested work; do not redo completed parts.",
    "Run the validation that actually covers your change before reporting it.",
    "recheck ownership before each removal and report any file whose ownership is",
    "and never delete unknown or user-owned files.",
    "Do not claim recovered hidden model state",
    "failed checkpoint staging has its own runbook below",
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
  const entries = (await readdir(fixture.agentDir))
    .filter((name) => name !== ".pi-review-gate" && name !== "session-host");
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
    await pathExists(fixture.defaultConfigPath),
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
    const entries = (await readdir(fixture.agentDir))
      .filter((name) => name !== ".pi-review-gate" && name !== "session-host");
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
  // With umask 0, naively created directories would be world-writable; every
  // directory the launcher creates (config levels and the shared application
  // state) must be private from the instant of creation.
  await runLauncherWithUmask("0", [], launcherEnv(fixture));

  assert.equal((await stat(join(fixture.home, ".pi"))).mode & 0o777, 0o700,
    "newly created .pi must be private despite umask 0");
  assert.equal((await stat(fixture.agentDir)).mode & 0o777, 0o700,
    "newly created agent directory must be private despite umask 0");
  assert.equal((await stat(join(fixture.agentDir, ".pi-review-gate"))).mode & 0o777, 0o700,
    "the shared state directory must be private despite umask 0");
  assert.equal((await stat(join(fixture.agentDir, ".pi-review-gate", "application"))).mode & 0o777, 0o700);
  assert.equal((await stat(fixture.defaultConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
});

test("config initialization preserves directories created by another process", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-dirmode-");
  // A directory created by another process (as Pi itself would) keeps its
  // permissions: initialization only creates what is missing and never chmods a
  // level it did not create.
  await mkdir(fixture.agentDir, { recursive: true });
  await chmod(join(fixture.home, ".pi"), 0o755);
  await chmod(fixture.agentDir, 0o755);

  await runLauncher([], launcherEnv(fixture));

  assert.equal((await stat(join(fixture.home, ".pi"))).mode & 0o777, 0o755,
    "a .pi directory created by another process (as Pi would have) must keep its permissions");
  assert.equal((await stat(fixture.agentDir)).mode & 0o777, 0o755,
    "an agent directory created by another process must not be chmodded by initialization");
  assert.equal((await stat(fixture.defaultConfigPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(fixture.defaultConfigPath, "utf8")), zeroModelDefaultConfig);
});

test("a directory at a shipped-skill destination fails closed before pi starts", async () => {
  const fixture = await makeLauncherFixture("pi-review-launcher-skill-dir-");
  await mkdir(join(fixture.fallbackConfigPath, ".."), { recursive: true });
  await writeFile(fixture.fallbackConfigPath, "{}\n", "utf8");
  const blocked = join(fixture.home, ".agents", "skills", "pi-review-gate-orchestrator", "SKILL.md");
  await mkdir(blocked, { recursive: true });

  await assert.rejects(
    runLauncher([], launcherEnv(fixture)),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /pi-review-gate-orchestrator/u);
      return true;
    },
  );
  assert.ok((await stat(blocked)).isDirectory(), "the racing directory must not be removed");
  assert.deepEqual(await readdir(blocked), [], "no file may be published into the directory");
  assert.equal(
    await readFile(join(fixture.capture, "config-env"), "utf8").then(() => true, () => false),
    false,
    "the launcher must not start pi when skill provisioning fails",
  );
});

// ---------------------------------------------------------------------------
// scripts/ensure-ddgs.sh provisioning contracts (the POSIX launcher mechanism):
// one full isolated validation pair on a warm launch, the same full validation
// after a repair, and fail-closed behavior at every failure point.
// ---------------------------------------------------------------------------

/**
 * Scenario for the recording stub venv interpreter used to drive
 * scripts/ensure-ddgs.sh. "invalid until repaired" scenarios become valid only
 * after the stub itself served the pinned pip install, so a successful launch
 * proves the script revalidated the repaired environment instead of trusting
 * the install.
 */
type EnsureDdgsScenario = "valid" | "version-fail-first" | "post-repair-pip-invalid" | "install-fails";

function ddgsValidationStub(scenario: EnsureDdgsScenario): string {
  const repaired = '[[ -f "$CAPTURE_DIR/ddgs-installed" ]]';
  const versionCheck: Record<EnsureDdgsScenario, string[]> = {
    valid: ["exit 0"],
    "version-fail-first": [`${repaired} && exit 0`, "exit 1"],
    "post-repair-pip-invalid": [`${repaired} && exit 0`, "exit 1"],
    "install-fails": ["exit 1"],
  };
  const pipCheck: Record<EnsureDdgsScenario, string[]> = {
    valid: ["exit 0"],
    "version-fail-first": ["exit 0"],
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

/** Classify one recorded Python invocation by the DDGS step it represents. */
function ensureDdgsCallKind(args: string[]): "version" | "pip-check" | "install" | "other" {
  if (args[0] !== "-I") return "other";
  if (args[1] === "-c" && args[2]?.includes("import ddgs")) return "version";
  if (args[1] === "-m" && args[2] === "pip" && args[3] === "check") return "pip-check";
  if (args[1] === "-m" && args[2] === "pip" && args[3] === "install") return "install";
  return "other";
}

interface EnsureDdgsCall {
  args: string[];
  kind: ReturnType<typeof ensureDdgsCallKind>;
}

interface EnsureDdgsFixture {
  root: string;
  home: string;
  capture: string;
  venv: string;
}

async function makeEnsureDdgsFixture(prefix: string, scenario: EnsureDdgsScenario): Promise<EnsureDdgsFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const capture = join(root, "capture");
  const venv = join(root, "ddgs");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(capture, { recursive: true }),
    mkdir(join(venv, "bin"), { recursive: true }),
  ]);
  const ddgsPython = join(venv, "bin", "python");
  await writeFile(ddgsPython, ddgsValidationStub(scenario), "utf8");
  await chmod(ddgsPython, 0o755);
  return { root, home, capture, venv };
}

async function runEnsureDdgs(fixture: EnsureDdgsFixture, cwd?: string) {
  return execFileAsync("bash", [resolve("scripts/ensure-ddgs.sh")], {
    env: { ...process.env, HOME: fixture.home, CAPTURE_DIR: fixture.capture, PI_REVIEW_GATE_DDGS_VENV: fixture.venv },
    ...(cwd ? { cwd } : {}),
  }).then(
    (result) => ({ status: 0, stdout: result.stdout, stderr: result.stderr }),
    (error: Error & { code?: number | string; stdout?: string; stderr?: string }) => ({
      status: typeof error.code === "number" ? error.code : -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

async function recordedEnsureDdgsCalls(fixture: EnsureDdgsFixture): Promise<EnsureDdgsCall[]> {
  const raw = await readFile(join(fixture.capture, "python-calls"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => {
    const args = line.split("\t").slice(1);
    return { args, kind: ensureDdgsCallKind(args) };
  });
}

function ensureDdgsKinds(calls: EnsureDdgsCall[]): string[] {
  return calls.map((call) => call.kind);
}

function assertIsolatedEnsureDdgsCalls(calls: EnsureDdgsCall[]): void {
  for (const call of calls) {
    // Isolated mode must come first: the launcher's working directory may be an
    // untrusted reviewed repository, so cwd must not be on sys.path.
    assert.equal(call.args[0], "-I", `Python invocation not in isolated mode: ${call.args.join(" ")}`);
  }
}

async function pinnedDdgsVersion(): Promise<string> {
  const script = await readFile(resolve("scripts/ensure-ddgs.sh"), "utf8");
  const match = /^DDGS_VERSION="([^"]+)"/m.exec(script);
  assert.ok(match, "scripts/ensure-ddgs.sh must declare a quoted DDGS_VERSION pin");
  return match[1];
}

test("ensure-ddgs validates a warm environment exactly once and installs nothing", async () => {
  const fixture = await makeEnsureDdgsFixture("pi-review-ddgs-warm-", "valid");

  const result = await runEnsureDdgs(fixture);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/,
    "a warm environment must be neither created nor reinstalled");
  const calls = await recordedEnsureDdgsCalls(fixture);
  // The full isolated validation runs once: the pinned version import then the
  // dependency check. The former duplicate second pair is gone, and this exact
  // count is the contract rather than incidental output.
  assert.deepEqual(ensureDdgsKinds(calls), ["version", "pip-check"],
    "a warm launch must run exactly one version import and one pip check");
  assertIsolatedEnsureDdgsCalls(calls);
});

test("ensure-ddgs repairs an invalid environment and revalidates the full contract", async () => {
  const fixture = await makeEnsureDdgsFixture("pi-review-ddgs-provision-", "version-fail-first");
  const version = await pinnedDdgsVersion();

  const result = await runEnsureDdgs(fixture);

  assert.equal(result.status, 0, `repair must be accepted only after revalidation: ${result.stderr}`);
  assert.match(result.stderr, /installing DDGS/);
  const calls = await recordedEnsureDdgsCalls(fixture);
  assert.deepEqual(ensureDdgsKinds(calls), ["version", "install", "version", "pip-check"],
    `repair must revalidate the full contract once: ${JSON.stringify(ensureDdgsKinds(calls))}`);
  const install = calls.find((call) => call.kind === "install");
  assert.ok(install, "expected a pip install invocation");
  assert.ok(install.args.includes(`ddgs==${version}`), "the pinned ddgs version must be installed");
  for (const flag of ["--only-binary=:all:", "--no-cache-dir", "--no-input", "--disable-pip-version-check"]) {
    assert.ok(install.args.includes(flag), `the pinned resolver flags must be unchanged: missing ${flag}`);
  }
  assertIsolatedEnsureDdgsCalls(calls);
});

test("ensure-ddgs refuses when a repair leaves the dependency graph inconsistent", async () => {
  const fixture = await makeEnsureDdgsFixture("pi-review-ddgs-refuse-graph-", "post-repair-pip-invalid");

  const result = await runEnsureDdgs(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is unavailable or has inconsistent dependencies; refusing to continue/);
  const calls = await recordedEnsureDdgsCalls(fixture);
  // A successful install is never acceptance on its own: the post-repair pip
  // check still fails, so the script must refuse.
  assert.deepEqual(ensureDdgsKinds(calls), ["version", "install", "version", "pip-check"],
    `a failed post-repair pip check must refuse: ${JSON.stringify(ensureDdgsKinds(calls))}`);
  assertIsolatedEnsureDdgsCalls(calls);
});

test("ensure-ddgs propagates a failing pinned install without accepting the environment", async () => {
  const fixture = await makeEnsureDdgsFixture("pi-review-ddgs-install-fail-", "install-fails");

  const result = await runEnsureDdgs(fixture);

  // set -e parity: the install's own status propagates and no post-repair
  // validation or refusal message is fabricated for it.
  assert.equal(result.status, 7, "the install's own exit status must propagate");
  assert.match(result.stderr, /installing DDGS/);
  assert.doesNotMatch(result.stderr, /refusing to continue/);
  const calls = await recordedEnsureDdgsCalls(fixture);
  assert.deepEqual(ensureDdgsKinds(calls), ["version", "install"],
    `a failed install must never be accepted: ${JSON.stringify(ensureDdgsKinds(calls))}`);
  assertIsolatedEnsureDdgsCalls(calls);
});

/**
 * Build a genuinely usable venv with a hand-written pinned DDGS distribution,
 * so the isolated-mode shadow guard below runs real Python without any
 * package-index access. The stand-in distribution is only metadata plus an
 * empty module: `pip check` has nothing to report, and the version check reads
 * the metadata version exactly as it does for the real wheel.
 */
async function syntheticDdgsVenv(root: string): Promise<string> {
  const version = await pinnedDdgsVersion();
  const venv = join(root, "real venv");
  const created = spawnSync("python3", ["-I", "-m", "venv", venv], { encoding: "utf8" });
  assert.equal(created.status, 0, `python3 -I -m venv must work: ${created.stderr}`);
  const python = join(venv, "bin", "python");
  const purelib = spawnSync(python, ["-I", "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
    encoding: "utf8",
  });
  assert.equal(purelib.status, 0, `the venv site-packages must resolve: ${purelib.stderr}`);
  const sitePackages = purelib.stdout.trim();
  await mkdir(join(sitePackages, "ddgs"), { recursive: true });
  await writeFile(join(sitePackages, "ddgs", "__init__.py"), `__version__ = "${version}"\n`, "utf8");
  await mkdir(join(sitePackages, `ddgs-${version}.dist-info`), { recursive: true });
  await writeFile(
    join(sitePackages, `ddgs-${version}.dist-info`, "METADATA"),
    `Metadata-Version: 2.1\nName: ddgs\nVersion: ${version}\n`,
    "utf8",
  );
  return venv;
}

/**
 * This guard needs a Python that can build a *pip-capable* venv: `python3 -m
 * venv` requires both the `venv` module and `ensurepip` (Debian/Ubuntu package
 * python3-venv ships the latter separately), and the guard's `pip check` needs
 * the pip that ensurepip installs. The probe itself runs in isolated, no-bytecode
 * mode so a read-only capability check never writes into an interpreter tree.
 * Python provisioning is an optional local prerequisite, so a Python without
 * that capability skips the guard instead of failing the suite.
 */
function python3CanBuildVenv(): boolean {
  const probe = spawnSync("python3", ["-B", "-I", "-c", "import sys, ensurepip, venv"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

test("ensure-ddgs keeps validation isolated from working-directory shadow modules", {
  skip: python3CanBuildVenv()
    ? false
    : "python3 with the venv and ensurepip modules is required for a real isolated-mode shadow-module guard",
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-ddgs-shadow-"));
  const home = join(root, "home");
  const capture = join(root, "capture");
  const untrusted = join(root, "untrusted reviewed checkout");
  const ddgsShadowMarker = join(root, "ddgs-shadow-ran");
  const pipShadowMarker = join(root, "pip-shadow-ran");
  const venv = await syntheticDdgsVenv(root);
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(capture, { recursive: true }),
    mkdir(untrusted, { recursive: true }),
  ]);
  // Modules that would execute on import from the working directory. A reviewed
  // repository is untrusted input, so neither validation may reach them.
  const shadow = (marker: string) => `import pathlib\npathlib.Path(${JSON.stringify(marker)}).touch()\n`;
  await writeFile(join(untrusted, "ddgs.py"), shadow(ddgsShadowMarker), "utf8");
  await writeFile(join(untrusted, "pip.py"), shadow(pipShadowMarker), "utf8");
  const fixture: EnsureDdgsFixture = { root, home, capture, venv };

  const result = await runEnsureDdgs(fixture, untrusted);

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /creating DDGS|installing DDGS/,
    "the synthetic warm venv must validate without provisioning");
  assert.equal(await pathExists(join(capture, "python-calls")), false,
    "real Python drives this guard, so the recording stub must not be involved");
  assert.equal(await pathExists(ddgsShadowMarker), false,
    "the pinned version import must not import a reviewed repository's ddgs shadow module");
  assert.equal(await pathExists(pipShadowMarker), false,
    "the pip check must not resolve a reviewed repository's pip shadow module");

  // Negative control: the same shadows do execute without isolated mode, so the
  // assertions above are meaningful rather than vacuous.
  const control = spawnSync(join(venv, "bin", "python"), ["-c", "import ddgs"], { cwd: untrusted, encoding: "utf8" });
  assert.equal(control.status, 0, `the non-isolated control must import the shadow: ${control.stderr}`);
  assert.equal(await pathExists(ddgsShadowMarker), true,
    "the shadow module must execute when the interpreter is not isolated");
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