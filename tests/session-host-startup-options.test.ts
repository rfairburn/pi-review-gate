import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-startup-options.test.ts"));
const helper = requireCjs("../scripts/session-host-startup-options.cjs") as {
  assertSessionHostStartupOptions(args: readonly string[], env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): void;
  composeFreshSessionSpawnArgs(args: readonly string[], title: string): string[];
  snapshotSessionHostEnvironment(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
  SessionHostStartupOptionError: new (message: string) => Error;
  SESSION_DIR_ENV: string;
};

function assertAdmitted(args: readonly string[], env?: NodeJS.ProcessEnv): void {
  helper.assertSessionHostStartupOptions(args, env);
}

function assertRejected(
  args: readonly string[],
  flagName: string,
  secret?: string,
  env?: NodeJS.ProcessEnv,
): void {
  assert.throws(
    () => helper.assertSessionHostStartupOptions(args, env),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(flagName));
      if (secret) assert.ok(!error.message.includes(secret), `diagnostic must not leak ${flagName} content`);
      return true;
    },
  );
}

test("rejects every blocked parent startup session option (bare and =value forms)", () => {
  const cases: Array<{ args: readonly string[]; flag: string; secret?: string }> = [
    { args: ["--continue"], flag: "--continue" },
    { args: ["-c"], flag: "-c" },
    { args: ["--resume"], flag: "--resume" },
    { args: ["-r"], flag: "-r" },
    { args: ["--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
    { args: ["--session=/sensitive/path"], flag: "--session", secret: "/sensitive/path" },
    { args: ["--session-id", "id-secret"], flag: "--session-id", secret: "id-secret" },
    { args: ["--session-id=id-secret"], flag: "--session-id", secret: "id-secret" },
    { args: ["--fork", "id-secret"], flag: "--fork", secret: "id-secret" },
    { args: ["--fork=id-secret"], flag: "--fork", secret: "id-secret" },
    { args: ["--session-dir", "/storage/secret"], flag: "--session-dir", secret: "/storage/secret" },
    { args: ["--session-dir=/storage/secret"], flag: "--session-dir", secret: "/storage/secret" },
    { args: ["--no-session"], flag: "--no-session" },
    { args: ["--continue=x"], flag: "--continue" },
    { args: ["--resume=x"], flag: "--resume" },
    { args: ["--no-session=x"], flag: "--no-session" },
  ];
  for (const entry of cases) {
    assertRejected(entry.args, entry.flag, entry.secret);
  }
});

test("rejects a missing forbidden option value too", () => {
  assertRejected(["--session"], "--session");
  assertRejected(["--session-id"], "--session-id");
  assertRejected(["--fork"], "--fork");
  assertRejected(["--session-dir"], "--session-dir");
});

test("does not reject lookalike prefixes or unknown extension flags", () => {
  for (const args of [
    ["--sessions", "x"],
    ["--session-x"],
    ["--continue2"],
    ["--resume-all"],
    ["--forklift"],
    ["--no-session-dir"],
    ["--custom-flag", "value"],
    ["--custom-flag=value"],
  ]) {
    assertAdmitted(args);
  }
});

test("honors the native -- separator: tokens after it are message/file data", () => {
  assertAdmitted(["--", "--session", "/tmp/old.jsonl"]);
  assertAdmitted(["--", "-c"]);
  assertAdmitted(["--", "--no-session"]);
  // An option BEFORE the separator is still an option.
  assertRejected(["--session", "--", "x"], "--session");
});

test("treats blocked names as value data after known value-taking flags", () => {
  for (const args of [
    ["--model", "--session"],
    ["--system-prompt", "--session"],
    ["--provider", "-c"],
    ["--api-key", "--resume"],
    ["-e", "--fork"],
    ["--tools", "-r"],
    ["--append-system-prompt", "--no-session"],
  ]) {
    assertAdmitted(args);
  }
  // A `--flag=value` spelling of a known flag is an unknown extension flag in
  // Pi 1.0.4 and consumes nothing: the following option is still an option.
  assertRejected(["--model=x", "--session"], "--session");
});

test("scans the effective native sequence after --scheduler removal", () => {
  // prepareNativeLaunch removes every exact --scheduler token, which shifts
  // option boundaries: the prompt value becomes the separator and --session
  // is a real option Pi would honor. Must reject.
  assertRejected(["--system-prompt", "--scheduler", "--", "--session", "/tmp/old.jsonl"], "--session", "/tmp/old.jsonl");
  // After removal, --tools consumes --session as its value: no override.
  assertAdmitted(["--tools", "--scheduler", "--session"]);
  // The wrapper opt-in contract itself stays admitted...
  assertAdmitted(["--scheduler", "-p", "plan"]);
  // ...and the caller's array is never mutated by the removal view.
  const args = ["--system-prompt", "--scheduler", "--", "--session"];
  const before = args.slice();
  assert.throws(() => helper.assertSessionHostStartupOptions(args));
  assert.deepEqual(args, before);
});

test("keeps scanning after positional messages and @file data", () => {
  assertAdmitted(["hello", "--verbose"]);
  assertAdmitted(["@file.txt", "world"]);
  assertRejected(["hello", "--continue"], "--continue");
  assertRejected(["@prompt.md", "-r"], "-r");
});

test("unknown extension flags do not consume option-looking tokens", () => {
  assertAdmitted(["--custom", "value"]);
  assertRejected(["--custom", "--session"], "--session");
  assertRejected(["--custom=value", "--resume"], "--resume");
});

test("allows ordinary native arguments unchanged", () => {
  for (const args of [
    [],
    ["-p", "hello"],
    ["--tools", "read,edit"],
    ["--scheduler"],
    ["--verbose", "--offline"],
    ["message with spaces"],
    ["--", "a", "b"],
  ]) {
    assertAdmitted(args);
  }
});

test("fresh sibling argument composition preserves Pi options and drops inherited messages, files, and names", () => {
  const args = [
    "--provider", "openai",
    "--model", "--session", // unconditional native value; admission rejects only actual session options
    "-n", "old title",
    "--name", "--model", // Pi consumes the flag-looking value as the old title
    "before options",
    "--print", "parent print message",
    "@parent.md",
    "--custom", "extension value",
    "--custom=attached",
    "--list-models", "@model-file",
    "--mode", "@not-a-cli-file",
    "--theme", "@theme-option-value",
    "--scheduler", "--system-prompt", "--scheduler", // scheduler removal shifts the exact boundary
    "after options",
    "--", "--session", "@literal-parent-file",
  ];
  const before = args.slice();
  assert.deepEqual(helper.composeFreshSessionSpawnArgs(args, " exact child title "), [
    "--provider", "openai",
    "--model", "--session",
    "--print",
    "--custom", "extension value",
    "--custom=attached",
    "--list-models",
    "--mode", "@not-a-cli-file",
    "--theme", "@theme-option-value",
    "--system-prompt", "after options",
    "--name", " exact child title ",
  ]);
  assert.deepEqual(args, before, "composition must not mutate the user's launch snapshot");
});

test("fresh sibling composition drops positionals after Pi's known valueless long options", () => {
  for (const option of [
    "--help",
    "--version",
    "--no-session",
    "--no-tools",
    "--no-builtin-tools",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--offline",
    "--approve",
    "--no-approve",
    "--verbose",
  ]) {
    assert.deepEqual(
      helper.composeFreshSessionSpawnArgs([option, "parent prompt"], "child"),
      [option, "--name", "child"],
      `${option} must not make Pi's following positional message look like an extension option value`,
    );
  }
  assert.deepEqual(
    helper.composeFreshSessionSpawnArgs(["--custom-extension-option", "extension-value", "parent prompt"], "child"),
    ["--custom-extension-option", "extension-value", "--name", "child"],
    "unknown extension flags retain their own optional value without inheriting later positional text",
  );
  assert.deepEqual(
    helper.composeFreshSessionSpawnArgs(["--json", "extension-value", "parent prompt"], "child"),
    ["--json", "extension-value", "--name", "child"],
    "Pi 1.1.0 parses --json as an unknown extension flag with an optional value",
  );
});

test("fresh sibling composition mirrors conditional Pi message consumption and scheduler boundaries", () => {
  assert.deepEqual(helper.composeFreshSessionSpawnArgs([
    "-p", "--model", "sonnet", // -p does not consume a flag-looking token
    "--use-theme", "theme-name",
    "--list-models", "sonnet",
    "--tui-mode", "unknown-mode", // Pi consumes invalid non-option values
    "--name", "parent",
    "--scheduler", "--system-prompt", "--scheduler", "--", "--name", "parent prompt",
  ], "child"), [
    "-p", "--model", "sonnet",
    "--use-theme", "theme-name",
    "--list-models", "sonnet",
    "--tui-mode", "unknown-mode",
    "--system-prompt", "--",
    "--name", "child",
  ]);
});

test("rejects a nonempty inherited session-dir env override; empty/absent is benign", () => {
  assertRejected([], "PI_CODING_AGENT_SESSION_DIR", "/private/storage", { PI_CODING_AGENT_SESSION_DIR: "/private/storage" });
  assertAdmitted([], { PI_CODING_AGENT_SESSION_DIR: "" });
  assertAdmitted([], {});
  assertAdmitted([]);
});

test("Windows environment snapshots canonicalize aliases, drop only stale host capabilities, and preserve ordinary security values", () => {
  const env: NodeJS.ProcessEnv = {
    Path: "/synthetic/bin",
    PATH: "/synthetic/bin",
    node_options: "--no-warnings --require=trusted-loader",
    NODE_OPTIONS: "--no-warnings --require=trusted-loader",
    Anthropic_Api_Key: "provider-secret",
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "old-bootstrap",
    pi_review_gate_session_host_bootstrap: "conflicting-old-bootstrap",
    PI_REVIEW_GATE_SETTLEMENT_SECRET: "old-settlement",
    pi_review_gate_quiescence_child: "old-quiescence",
    PI_REVIEW_GATE_RUNTIME_ROLE: "",
    pi_review_gate_runtime_role: "worker-secret",
    PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: "",
    pi_review_gate_executor_tool_catalog: "catalog-secret",
    PI_REVIEW_GATE_RESEARCH_CEILING: "frozen-research-ceiling",
    PI_REVIEW_GATE_CAPTURE_CEILING: "frozen-capture-ceiling",
  };
  const before = { ...env };
  const snapshot = helper.snapshotSessionHostEnvironment(env, "win32");
  assert.deepEqual(snapshot, {
    PATH: "/synthetic/bin",
    NODE_OPTIONS: "--no-warnings --require=trusted-loader",
    ANTHROPIC_API_KEY: "provider-secret",
    PI_REVIEW_GATE_RUNTIME_ROLE: "worker-secret",
    PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: "catalog-secret",
    PI_REVIEW_GATE_RESEARCH_CEILING: "frozen-research-ceiling",
    PI_REVIEW_GATE_CAPTURE_CEILING: "frozen-capture-ceiling",
  });
  assert.deepEqual(env, before, "the caller's source environment is never mutated");
  assert.equal(snapshot.PI_REVIEW_GATE_RUNTIME_ROLE, "worker-secret",
    "a nonempty role marker is retained, not laundered by an empty alias");
});

test("Windows startup admission rejects ambiguous ordinary aliases and sees mixed-case storage overrides", () => {
  assert.throws(
    () => helper.snapshotSessionHostEnvironment({ PATH: "one", Path: "two" }, "win32"),
    /[Cc]onflicting case variants in the Windows environment/,
  );
  assert.throws(
    () => helper.snapshotSessionHostEnvironment({ NODE_OPTIONS: "--no-warnings", node_options: "--trace-warnings" }, "win32"),
    /[Cc]onflicting case variants in the Windows environment/,
  );
  assert.throws(
    () => helper.assertSessionHostStartupOptions([], { pi_coding_agent_session_dir: "/private/storage" }, "win32"),
    /PI_CODING_AGENT_SESSION_DIR/,
  );
  helper.assertSessionHostStartupOptions([], { PI_CODING_AGENT_SESSION_DIR: "" }, "win32");
});

test("never mutates its inputs", () => {
  const args = ["--model", "--session"];
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", PI_CODING_AGENT_SESSION_DIR: "" };
  const argsBefore = args.slice();
  const envBefore = { ...env };
  assertAdmitted(args, env);
  assert.deepEqual(args, argsBefore);
  assert.deepEqual(env, envBefore);

  const hostileArgs = ["--session", "/tmp/old.jsonl"];
  const hostileEnv: NodeJS.ProcessEnv = { PI_CODING_AGENT_SESSION_DIR: "/private/storage" };
  const hostileArgsBefore = hostileArgs.slice();
  const hostileEnvBefore = { ...hostileEnv };
  assert.throws(() => helper.assertSessionHostStartupOptions(hostileArgs, hostileEnv));
  assert.deepEqual(hostileArgs, hostileArgsBefore);
  assert.deepEqual(hostileEnv, hostileEnvBefore);
});

test("invalid argument arrays fail with a generic diagnostic", () => {
  for (const invalid of [42, "not-an-array", ["ok", 7], [null]] as unknown[]) {
    assert.throws(
      () => helper.assertSessionHostStartupOptions(invalid as readonly string[]),
      /Invalid session host startup arguments/,
    );
  }
});

test("import is side-effect free (no env mutation, no setup)", () => {
  const helperPath = join(process.cwd(), "scripts", "session-host-startup-options.cjs");
  const result = execFileSync(
    process.execPath,
    ["-e", [
      `const sentinel = "startup-options-sentinel";`,
      `process.env[sentinel] = "keep-me";`,
      `const helper = require(${JSON.stringify(helperPath)});`,
      `helper.assertSessionHostStartupOptions([], {});`,
      `if (process.env[sentinel] !== "keep-me") process.exit(3);`,
      `if (typeof helper.assertSessionHostStartupOptions !== "function") process.exit(4);`,
      `console.log("ok");`,
    ].join("\n")],
    { encoding: "utf8" },
  );
  assert.match(result, /ok/);
});
