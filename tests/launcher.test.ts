import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

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
  assert.equal(
    await readFile(join(capture, "args"), "utf8"),
    `--extension\n${resolve("dist/src/index.js")}\n--append-system-prompt\n${resolve("scripts/orchestrator-system-prompt.md")}\n--model\nexample\n--tools\nread,bash\n`,
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

test("persistent launcher fails clearly when no fallback config exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-launcher-empty-"));
  const home = join(root, "home");
  await mkdir(home);

  await assert.rejects(
    execFileAsync(resolve("scripts/pi-review-gate.sh"), [], {
      env: { ...process.env, HOME: home },
    }),
    (error: unknown) => {
      assert.ok(isExecError(error));
      assert.equal(error.code, 2);
      assert.match(error.stderr, /no persistent config found/);
      return true;
    },
  );
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
