import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const launchAllowedTools = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "glob", "webfetch", "websearch",
  "EvidenceAdd", "EvidenceGet", "EvidenceList",
  "BrowserNavigate", "BrowserClick", "BrowserType", "BrowserScroll", "BrowserExtract", "BrowserBack", "BrowserHistory",
  "dispatch",
  "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop",
  "ShellSessionCwd", "ShellSessionReset",
  "ExecuteSubtasks",
];

test("persistent launcher uses fallback config, clears overrides, and preserves extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-launcher-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  await Promise.all([
    mkdir(join(home, ".config", "little-coder"), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(capture, { recursive: true }),
  ]);
  const configPath = join(home, ".config", "little-coder", "review-gate.json");
  await writeFile(configPath, "{}\n", "utf8");
  const npmPath = join(bin, "npm");
  const littleCoderPath = join(bin, "little-coder");
  await writeFile(npmPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(littleCoderPath, [
    "#!/usr/bin/env bash",
    "printf '%s' \"${PI_REVIEW_GATE_CONFIG:-unset}\" > \"$CAPTURE_DIR/config-env\"",
    "printf '%s' \"${PI_REVIEW_GATE_DISABLED:-unset}\" > \"$CAPTURE_DIR/disabled-env\"",
    "printf '%s' \"${LITTLE_CODER_THINKING_BUDGET:-unset}\" > \"$CAPTURE_DIR/thinking-budget\"",
    "printf '%s' \"${LITTLE_CODER_EXTRA_EXTENSIONS:-}\" > \"$CAPTURE_DIR/extensions\"",
    "printf '%s' \"${LITTLE_CODER_ALLOWED_TOOLS:-}\" > \"$CAPTURE_DIR/allowed-tools\"",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
  ].join("\n"), "utf8");
  await Promise.all([chmod(npmPath, 0o755), chmod(littleCoderPath, 0o755)]);

  const result = await execFileAsync(resolve("scripts/little-coder-review-gate.sh"), ["--model", "example"], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CAPTURE_DIR: capture,
      PI_REVIEW_GATE_CONFIG: "/wrong/config.json",
      PI_REVIEW_GATE_DISABLED: "1",
      LITTLE_CODER_THINKING_BUDGET: "4096",
      LITTLE_CODER_EXTRA_EXTENSIONS: "/other/extension.js",
      LITTLE_CODER_ALLOWED_TOOLS: "ShellSession",
    },
  });

  assert.match(result.stdout, new RegExp(escapeRegExp(configPath)));
  assert.equal(await readFile(join(capture, "config-env"), "utf8"), "unset");
  assert.equal(await readFile(join(capture, "disabled-env"), "utf8"), "unset");
  assert.equal(await readFile(join(capture, "thinking-budget"), "utf8"), "16384");
  const extensions = await readFile(join(capture, "extensions"), "utf8");
  assert.match(extensions, /dist\/src\/index\.js/);
  assert.match(extensions, /\/other\/extension\.js/);
  assertLaunchToolPolicy(await readFile(join(capture, "allowed-tools"), "utf8"));
  assert.equal(
    await readFile(join(capture, "args"), "utf8"),
    `--tui-mode\nfullscreen\n--append-system-prompt\n${resolve("scripts/orchestrator-system-prompt.md")}\n--tools\n${launchAllowedTools.join(",")}\n--model\nexample\n`,
  );
});

test("preset launcher appends the orchestrator prompt and preserves forwarded arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-preset-launcher-"));
  const bin = join(root, "bin");
  const capture = join(root, "capture");
  await Promise.all([mkdir(bin), mkdir(capture)]);

  const npmPath = join(bin, "npm");
  const littleCoderPath = join(bin, "little-coder");
  await writeFile(npmPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(littleCoderPath, [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_DIR/args\"",
    "printf '%s' \"$PI_REVIEW_GATE_CONFIG\" > \"$CAPTURE_DIR/config-path\"",
    "printf '%s' \"${LITTLE_CODER_THINKING_BUDGET:-unset}\" > \"$CAPTURE_DIR/thinking-budget\"",
    "printf '%s' \"${LITTLE_CODER_ALLOWED_TOOLS:-}\" > \"$CAPTURE_DIR/allowed-tools\"",
    "node -e 'const fs=require(\"node:fs\");process.stdout.write((fs.statSync(process.argv[1]).mode & 0o777).toString(8))' \"$PI_REVIEW_GATE_CONFIG\" > \"$CAPTURE_DIR/config-mode\"",
  ].join("\n"), "utf8");
  await Promise.all([chmod(npmPath, 0o755), chmod(littleCoderPath, 0o755)]);

  await execFileAsync(resolve("scripts/little-coder-review.sh"), ["codex", "--model", "example"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CAPTURE_DIR: capture,
      TMPDIR: root,
      LITTLE_CODER_THINKING_BUDGET: "4096",
      LITTLE_CODER_ALLOWED_TOOLS: "ShellSession",
    },
  });

  assert.equal(
    await readFile(join(capture, "args"), "utf8"),
    `--tui-mode\nfullscreen\n--append-system-prompt\n${resolve("scripts/orchestrator-system-prompt.md")}\n--tools\n${launchAllowedTools.join(",")}\n--model\nexample\n`,
  );
  const temporaryConfig = await readFile(join(capture, "config-path"), "utf8");
  assert.match(temporaryConfig, /pi-review-gate\.[^/]+\/review\.json$/);
  assert.equal(await readFile(join(capture, "config-mode"), "utf8"), "600");
  assert.equal(await readFile(join(capture, "thinking-budget"), "utf8"), "16384");
  assertLaunchToolPolicy(await readFile(join(capture, "allowed-tools"), "utf8"));
  await assert.rejects(readFile(temporaryConfig, "utf8"), /ENOENT/);
});

test("persistent launcher fails clearly when no fallback config exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-launcher-empty-"));
  const home = join(root, "home");
  await mkdir(home);

  await assert.rejects(
    execFileAsync(resolve("scripts/little-coder-review-gate.sh"), [], {
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

function isExecError(value: unknown): value is Error & { code: number; stderr: string } {
  return typeof value === "object" && value !== null && "code" in value && "stderr" in value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertLaunchToolPolicy(value: string): void {
  const actual = value.split(",").filter(Boolean);
  assert.deepEqual(actual, launchAllowedTools);
  assert.equal(actual.includes("ShellSession"), false);
}
