import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

interface ParsedArguments {
  help: boolean;
  piExecutable?: string;
  stateRoot?: string;
  toggleKey?: string;
  args: string[];
}

interface HostOptions {
  packageRoot: string;
  piExecutable?: string;
  stateRoot?: string;
  toggleKey?: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

interface LauncherOverrides {
  getEnv?: () => NodeJS.ProcessEnv;
  platform?: string;
  nodeVersion?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  packageRoot?: string;
  processEnv?: NodeJS.ProcessEnv;
  build?: (packageRoot: string, env: NodeJS.ProcessEnv) => { status: number | null; error?: Error };
  ensureDdgs?: (packageRoot: string, env: NodeJS.ProcessEnv) => { ok: boolean; python?: string; exitCode?: number };
  isRegularFile?: (file: string) => boolean;
  loadMain?: (entry: string) => { runSessionHost(options: HostOptions): Promise<number> | number };
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
}

interface LauncherModule {
  USAGE: string;
  parseSessionHostArguments(argv: readonly string[]): ParsedArguments;
  __test: {
    runSessionHostLauncher(argv: readonly string[], overrides?: LauncherOverrides): Promise<number>;
    ensureDdgs(packageRoot: string, env: NodeJS.ProcessEnv): { ok: boolean; python?: string; exitCode?: number };
  };
}

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-launcher.test.ts"));
const launcher = requireCjs("../scripts/pi-review-sessions.cjs") as LauncherModule;
const SCRIPT = join(process.cwd(), "scripts", "pi-review-sessions.cjs");

function makePackageFixture(source: boolean): { root: string; packageRoot: string } {
  const root = mkdtempSync(join(process.cwd(), ".session-host-launcher-fixture-"));
  const packageRoot = join(root, "package root π");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "main.js"), "// fake host entry\n", "utf8");
  if (source) {
    mkdirSync(join(packageRoot, "src", "session-host"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "session-host", "main.ts"), "// source marker\n", "utf8");
  }
  return { root, packageRoot };
}

function cleanupFixture(t: TestContext, fixture: { root: string }): void {
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
}

function makeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.cwd(),
    ...overrides,
  };
}

function baseOverrides(
  packageRoot: string,
  env: NodeJS.ProcessEnv,
  events: string[],
  hostOptions: HostOptions[],
  overrides: LauncherOverrides = {},
): LauncherOverrides {
  return {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot,
    build: (root, setupEnv) => {
      events.push("build");
      assert.equal(root, packageRoot);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      return { status: 0 };
    },
    ensureDdgs: (root, setupEnv) => {
      events.push("ddgs");
      assert.equal(root, packageRoot);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      return { ok: true, python: "/synthetic/ddgs/bin/python" };
    },
    loadMain: (entry) => {
      events.push("load");
      assert.equal(entry, join(packageRoot, "dist", "src", "session-host", "main.js"));
      return {
        runSessionHost(options) {
          events.push("run");
          hostOptions.push(options);
          return 0;
        },
      };
    },
    writeOut: () => undefined,
    writeError: () => undefined,
    ...overrides,
  };
}

test("parser forwards exact native bytes only after -- and leaves argv untouched", () => {
  const argv = [
    "--pi-executable", "/Applications/Pi Tools/π pi",
    "--state-root", "./private state/用户",
    "--sidebar-key", "ctrl+shift+right",
    "--", "--scheduler", "--help", "--tools", "read,edit", "a 'quoted' value", "雪",
  ];
  const before = argv.slice();
  assert.deepEqual(launcher.parseSessionHostArguments(argv), {
    help: false,
    piExecutable: "/Applications/Pi Tools/π pi",
    stateRoot: "./private state/用户",
    toggleKey: "ctrl+shift+right",
    args: ["--scheduler", "--help", "--tools", "read,edit", "a 'quoted' value", "雪"],
  });
  assert.deepEqual(argv, before);

  const forwardedHelp = launcher.parseSessionHostArguments(["--", "--help"]);
  assert.equal(forwardedHelp.help, false);
  assert.deepEqual(forwardedHelp.args, ["--help"]);
  assert.deepEqual(launcher.parseSessionHostArguments([]), {
    help: false,
    args: [],
  });
});

test("parser accepts bounded Unicode paths and key IDs, rejects malformed wrapper options safely", () => {
  const path2048 = "x".repeat(2048);
  const key80 = "k".repeat(80);
  assert.equal(launcher.parseSessionHostArguments(["--state-root", path2048]).stateRoot, path2048);
  assert.equal(launcher.parseSessionHostArguments(["--sidebar-key", key80]).toggleKey, key80);

  const invalid: Array<{ argv: string[]; diagnostic: string; secret?: string }> = [
    { argv: ["--state-root"], diagnostic: "Missing value for --state-root." },
    { argv: ["--pi-executable", "--help"], diagnostic: "Missing value for --pi-executable." },
    { argv: ["-h", "--help"], diagnostic: "Duplicate pi-review-sessions option." },
    { argv: ["--state-root", "one", "--state-root", "two"], diagnostic: "Duplicate pi-review-sessions option." },
    { argv: ["--access-token=do-not-print-this"], diagnostic: "Unknown pi-review-sessions option.", secret: "do-not-print-this" },
    { argv: ["--version"], diagnostic: "Unknown pi-review-sessions option." },
    { argv: ["--workspace", "/private/workspace"], diagnostic: "Unknown pi-review-sessions option.", secret: "/private/workspace" },
    { argv: ["--scheduler"], diagnostic: "Unknown pi-review-sessions option." },
    { argv: ["credential-must-not-appear"], diagnostic: "Unexpected argument before '--'.", secret: "credential-must-not-appear" },
    { argv: ["--state-root", ""], diagnostic: "Invalid value for --state-root." },
    { argv: ["--state-root", `bad\npath`], diagnostic: "Invalid value for --state-root." },
    { argv: ["--pi-executable", "x".repeat(2049)], diagnostic: "Invalid value for --pi-executable." },
    { argv: ["--sidebar-key", "k".repeat(81)], diagnostic: "Invalid value for --sidebar-key." },
    { argv: ["--sidebar-key", "ctrl\u0000left"], diagnostic: "Invalid value for --sidebar-key." },
    { argv: ["--sidebar-key=a"], diagnostic: "Unknown pi-review-sessions option." },
  ];
  for (const entry of invalid) {
    assert.throws(
      () => launcher.parseSessionHostArguments(entry.argv),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(entry.diagnostic));
        if (entry.secret) assert.ok(!error.message.includes(entry.secret));
        return true;
      },
    );
  }
});

test("--help works in the real CLI without TTY, role setup, build, or provisioning", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: makeEnvironment({ PI_REVIEW_GATE_RUNTIME_ROLE: "private-role-marker" }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Alpha POSIX macOS\/Linux/);
  assert.match(result.stdout, /Node >=22\.19\.0/);
  assert.match(result.stdout, /Pi >=1\.0\.4/);
  assert.match(result.stdout, /Basic controls only;\s+terminal graphics rendering is disabled/);
  assert.match(result.stdout, /native image\/model input behavior\s+stays native/);
  assert.match(result.stdout, /startup session\s+overrides \(--continue\/-c[^)]*\) are not accepted/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-role-marker/);
});

test("forbidden parent startup session overrides reject before any setup with bounded diagnostics", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  const cases: Array<{ argv: string[]; flag: string; secret?: string }> = [
    { argv: ["--", "--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
    { argv: ["--", "--session=/sensitive/path"], flag: "--session", secret: "/sensitive/path" },
    { argv: ["--", "--continue"], flag: "--continue" },
    { argv: ["--", "-c"], flag: "-c" },
    { argv: ["--", "--resume"], flag: "--resume" },
    { argv: ["--", "-r"], flag: "-r" },
    { argv: ["--", "--session-id", "id-secret"], flag: "--session-id", secret: "id-secret" },
    { argv: ["--", "--fork", "id-secret"], flag: "--fork", secret: "id-secret" },
    { argv: ["--", "--session-dir", "/storage/secret"], flag: "--session-dir", secret: "/storage/secret" },
    { argv: ["--", "--no-session"], flag: "--no-session" },
    // --scheduler removal shifts native boundaries: Pi would see
    // `--system-prompt -- --session …` with a live session option.
    { argv: ["--", "--system-prompt", "--scheduler", "--", "--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
  ];
  for (const entry of cases) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher(entry.argv, baseOverrides(fixture.packageRoot, env, events, [], {
      writeError: (text) => { stderr += text; },
    }));
    assert.equal(status, 2, entry.flag);
    assert.deepEqual(events, [], `no build/DDGS/load/run for ${entry.flag}`);
    assert.match(stderr, new RegExp(entry.flag));
    if (entry.secret) assert.doesNotMatch(stderr, new RegExp(entry.secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("nonempty inherited PI_CODING_AGENT_SESSION_DIR rejects before any setup", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment({ PI_CODING_AGENT_SESSION_DIR: "/private/storage" });
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher(["--", "-p", "hello"], baseOverrides(fixture.packageRoot, env, events, [], {
    writeError: (text) => { stderr += text; },
  }));
  assert.equal(status, 2);
  assert.deepEqual(events, []);
  assert.match(stderr, /PI_CODING_AGENT_SESSION_DIR/);
  assert.doesNotMatch(stderr, /\/private\/storage/);
});

test("ordinary native arguments and value lookalikes pass the startup preflight byte-for-byte", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  for (const args of [
    ["--model", "--session"],
    ["--system-prompt", "--session"],
    ["--", "--session", "/tmp/old.jsonl"],
    ["-p", "hello"],
  ]) {
    const events: string[] = [];
    const captured: HostOptions[] = [];
    const status = await launcher.__test.runSessionHostLauncher(["--", ...args], baseOverrides(fixture.packageRoot, env, events, captured));
    assert.equal(status, 0, JSON.stringify(args));
    assert.deepEqual(events, ["ddgs", "load", "run"], JSON.stringify(args));
    assert.deepEqual(captured[0].args, args, "native arguments are forwarded byte-for-byte");
  }
});

test("source build and DDGS setup precede loading the synthetic host API", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const env = makeEnvironment({
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/stale/python",
    NODE_OPTIONS: "--no-warnings",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  const overrides = baseOverrides(fixture.packageRoot, env, events, captured, {
    loadMain: (entry) => {
      events.push("load");
      assert.ok(existsSync(entry));
      return {
        runSessionHost(options) {
          events.push("run");
          captured.push(options);
          return 27;
        },
      };
    },
  });
  const argv = ["--pi-executable", "/pi path/π", "--state-root", "./state dir", "--", "--scheduler", "--", "雪"];
  const before = argv.slice();
  assert.equal(await launcher.__test.runSessionHostLauncher(argv, overrides), 27);
  assert.deepEqual(argv, before);
  assert.deepEqual(events, ["build", "ddgs", "load", "run"]);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    packageRoot: fixture.packageRoot,
    piExecutable: "/pi path/π",
    stateRoot: "./state dir",
    args: ["--scheduler", "--", "雪"],
    env: {
      PATH: process.env.PATH,
      HOME: process.cwd(),
      NODE_OPTIONS: "--no-warnings",
      ANTHROPIC_API_KEY: "provider-secret",
      PI_REVIEW_GATE_DDGS_PYTHON: "/synthetic/ddgs/bin/python",
    },
  });
  assert.equal(Object.isFrozen(captured[0].args), true);
  assert.equal(env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, "bootstrap-secret", "the caller-owned env object is not mutated");
  assert.equal(env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, "restore-secret");
});

test("production source-build command is fixed, package-rooted, and receives scrubbed setup env", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocation.json");
  const fakeNpm = join(bin, "npm");
  writeFileSync(fakeNpm, [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `fs.writeFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, ddgs: process.env.PI_REVIEW_GATE_DDGS_PYTHON ?? null, nodeOptions: process.env.NODE_OPTIONS, provider: process.env.ANTHROPIC_API_KEY }));`,
    "",
  ].join("\n"), "utf8");
  chmodSync(fakeNpm, 0o755);

  const events: string[] = [];
  const captured: HostOptions[] = [];
  const env = makeEnvironment({
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TEST_NPM_LOG: log,
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/stale/python",
    NODE_OPTIONS: "--no-warnings",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    ensureDdgs: (root) => { events.push("ddgs"); assert.equal(root, fixture.packageRoot); return { ok: true, python: "/synthetic/python" }; },
    loadMain: (entry) => {
      events.push("load");
      assert.ok(existsSync(entry));
      return { runSessionHost: (options) => { events.push("run"); captured.push(options); return 0; } };
    },
    writeOut: () => undefined,
    writeError: (text) => assert.fail(text),
  });
  assert.equal(status, 0);
  assert.deepEqual(events, ["ddgs", "load", "run"]);
  const invocation = JSON.parse(readFileSync(log, "utf8")) as {
    args: string[];
    cwd: string;
    bootstrap: string | null;
    restore: string | null;
    ddgs: string | null;
    nodeOptions: string;
    provider: string;
  };
  assert.deepEqual(invocation.args, ["--prefix", fixture.packageRoot, "run", "build"]);
  assert.equal(invocation.cwd, fixture.packageRoot);
  assert.equal(invocation.bootstrap, null);
  assert.equal(invocation.restore, null);
  assert.equal(invocation.ddgs, null);
  assert.equal(invocation.nodeOptions, "--no-warnings");
  assert.equal(invocation.provider, "provider-secret");
  assert.deepEqual(captured[0].args, ["--scheduler"]);
});

test("packaged compiled path skips source build and forwards only optional settings", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const env = makeEnvironment();
  const overrides = baseOverrides(fixture.packageRoot, env, events, captured, {
    build: () => {
      events.push("build");
      return { status: 0 };
    },
    loadMain: () => ({
      runSessionHost(options) {
        events.push("run");
        captured.push(options);
        return 19;
      },
    }),
  });
  assert.equal(await launcher.__test.runSessionHostLauncher(["--", "--help"], overrides), 19);
  assert.deepEqual(events, ["ddgs", "run"]);
  assert.deepEqual(captured[0].args, ["--help"]);
  assert.equal(Object.hasOwn(captured[0], "piExecutable"), false);
  assert.equal(Object.hasOwn(captured[0], "stateRoot"), false);
  assert.equal(Object.hasOwn(captured[0], "toggleKey"), false);
});

test("real ensure-ddgs.sh uses the synthetic venv, sanitized env, and package cwd only", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const scriptSource = readFileSync(join(process.cwd(), "scripts", "ensure-ddgs.sh"), "utf8");
  writeFileSync(join(fixture.packageRoot, "scripts", "ensure-ddgs.sh"), scriptSource, "utf8");
  const venv = join(fixture.root, "synthetic venv");
  const pythonDir = join(venv, "bin");
  mkdirSync(pythonDir, { recursive: true });
  const log = join(fixture.root, "fake-python-log.jsonl");
  const fakePython = join(pythonDir, "python");
  writeFileSync(fakePython, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.TEST_DDGS_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, nodeOptions: process.env.NODE_OPTIONS, provider: process.env.ANTHROPIC_API_KEY }) + "\\n");\n`, "utf8");
  chmodSync(fakePython, 0o755);

  const env = makeEnvironment({
    HOME: fixture.root,
    XDG_CACHE_HOME: join(fixture.root, "cache"),
    PI_REVIEW_GATE_DDGS_VENV: venv,
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/stale/python",
    NODE_OPTIONS: "--no-warnings",
    ANTHROPIC_API_KEY: "provider-secret",
    TEST_DDGS_LOG: log,
  });
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const result = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, captured, {
    ensureDdgs: (root, setupEnv) => {
      events.push("ddgs");
      return launcher.__test.ensureDdgs(root, setupEnv);
    },
  }));
  assert.equal(result, 0);
  assert.deepEqual(events, ["build", "ddgs", "load", "run"]);
  assert.equal(captured[0].env.PI_REVIEW_GATE_DDGS_PYTHON, fakePython);
  assert.equal(captured[0].env.NODE_OPTIONS, "--no-warnings");
  assert.equal(captured[0].env.ANTHROPIC_API_KEY, "provider-secret");
  const pythonCalls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    argv: string[];
    cwd: string;
    bootstrap: string | null;
    restore: string | null;
    nodeOptions: string;
    provider: string;
  });
  assert.equal(pythonCalls.length, 4, "the sourced helper performs two version/pip validation checks");
  assert.equal(pythonCalls.filter((call) => call.argv[1] === "-c").length, 2);
  assert.equal(pythonCalls.filter((call) => call.argv[1] === "-m" && call.argv[3] === "check").length, 2);
  for (const call of pythonCalls) {
    assert.equal(call.cwd, fixture.packageRoot);
    assert.equal(call.bootstrap, null);
    assert.equal(call.restore, null);
    assert.equal(call.nodeOptions, "--no-warnings");
    assert.equal(call.provider, "provider-secret");
  }
});

test("DDGS provisioning failure cannot be masked by a later successful validation", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const marker = join(fixture.root, "provisioning-marker.txt");
  writeFileSync(join(fixture.packageRoot, "scripts", "ensure-ddgs.sh"), [
    "set -euo pipefail",
    'printf "provision-failed\\n" >> "$TEST_DDGS_MARKER"',
    "false",
    'printf "later-validation-succeeded\\n" >> "$TEST_DDGS_MARKER"',
    'export PI_REVIEW_GATE_DDGS_PYTHON="/synthetic/python"',
    "",
  ].join("\n"), "utf8");
  const env = makeEnvironment({ TEST_DDGS_MARKER: marker });
  const events: string[] = [];
  const result = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
    ensureDdgs: (root, setupEnv) => {
      events.push("ddgs");
      return launcher.__test.ensureDdgs(root, setupEnv);
    },
    loadMain: () => {
      events.push("load");
      return { runSessionHost: () => { events.push("run"); return 0; } };
    },
  }));
  assert.notEqual(result, 0);
  assert.deepEqual(events, ["build", "ddgs"]);
  assert.equal(readFileSync(marker, "utf8"), "provision-failed\n");
});

test("role, platform, Node floor, and TTY failures stop before setup without leaking values", async () => {
  const failures: Array<{ env: NodeJS.ProcessEnv; overrides: Partial<LauncherOverrides>; expected: RegExp; secret?: string }> = [
    {
      env: makeEnvironment({ PI_REVIEW_GATE_RUNTIME_ROLE: "private-role-secret" }),
      overrides: {},
      expected: /PI_REVIEW_GATE_RUNTIME_ROLE/,
      secret: "private-role-secret",
    },
    {
      env: makeEnvironment({ PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: "private-catalog-secret" }),
      overrides: {},
      expected: /PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG/,
      secret: "private-catalog-secret",
    },
    { env: makeEnvironment(), overrides: { platform: "win32" }, expected: /POSIX macOS\/Linux only/ },
    { env: makeEnvironment(), overrides: { nodeVersion: "22.18.9" }, expected: /Node >=22\.19\.0/ },
    { env: makeEnvironment(), overrides: { nodeVersion: "22.19.0-rc.1" }, expected: /Node >=22\.19\.0/ },
    { env: makeEnvironment(), overrides: { stdinIsTTY: false }, expected: /interactive stdin and stdout/ },
    { env: makeEnvironment(), overrides: { stdoutIsTTY: false }, expected: /interactive stdin and stdout/ },
  ];
  for (const failure of failures) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], {
      getEnv: () => failure.env,
      processEnv: {},
      platform: "linux",
      nodeVersion: "22.19.0",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      packageRoot: process.cwd(),
      build: () => { events.push("build"); return { status: 0 }; },
      ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/tmp/python" }; },
      loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
      writeOut: () => undefined,
      writeError: (text) => { stderr += text; },
      ...failure.overrides,
    });
    assert.notEqual(status, 0);
    assert.deepEqual(events, []);
    assert.match(stderr, failure.expected);
    if (failure.secret) assert.doesNotMatch(stderr, new RegExp(failure.secret));
  }
});

test("help bypasses the startup override check as well as all environment and TTY preflight", async () => {
  let envRead = false;
  let output = "";
  const status = await launcher.__test.runSessionHostLauncher(["--help", "--", "--session", "/tmp/old.jsonl"], {
    getEnv: () => { envRead = true; throw new Error("must not inspect environment"); },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    platform: "win32",
    nodeVersion: "1.0.0",
    writeOut: (text) => { output = text; },
    writeError: (text) => { output += text; },
  });
  assert.equal(status, 0);
  assert.equal(envRead, false);
  assert.match(output, /startup session\s+overrides/);
});

test("help bypasses all environment and TTY preflight", async () => {
  let envRead = false;
  let output = "";
  const status = await launcher.__test.runSessionHostLauncher(["--help"], {
    getEnv: () => { envRead = true; throw new Error("must not inspect environment"); },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    platform: "win32",
    nodeVersion: "1.0.0",
    writeOut: (text) => { output = text; },
    writeError: (text) => { output += text; },
  });
  assert.equal(status, 0);
  assert.equal(envRead, false);
  assert.match(output, /terminal graphics rendering is disabled/);
  assert.match(output, /native image\/model input behavior\s+stays native/);
});

test("build and DDGS failures propagate safely and prevent loading the host", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const env = makeEnvironment({ PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "never-print-this" });

  for (const failure of [
    {
      label: "build status",
      build: () => ({ status: 23 }),
      ensure: () => ({ ok: true, python: "/synthetic/python" }),
      expected: 23,
      events: ["build"],
    },
    {
      label: "build spawn error",
      build: () => ({ status: null, error: new Error("never-print-this") }),
      ensure: () => ({ ok: true, python: "/synthetic/python" }),
      expected: 1,
      events: ["build"],
    },
    {
      label: "DDGS status",
      build: () => ({ status: 0 }),
      ensure: () => ({ ok: false, exitCode: 17 }),
      expected: 17,
      events: ["build", "ddgs"],
    },
  ]) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
      build: (root, setupEnv) => {
        events.push("build");
        assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
        return failure.build();
      },
      ensureDdgs: () => { events.push("ddgs"); return failure.ensure(); },
      loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
      writeError: (text) => { stderr += text; },
    }));
    assert.equal(status, failure.expected, failure.label);
    assert.deepEqual(events, failure.events);
    assert.doesNotMatch(stderr, /never-print-this/);
  }
});

test("host-module failures and invalid DDGS paths fail closed with bounded diagnostics", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  for (const mode of ["module-load", "missing-api", "runtime-reject", "bad-python"] as const) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
      ensureDdgs: () => {
        events.push("ddgs");
        return { ok: true, python: mode === "bad-python" ? "relative/python" : "/synthetic/python" };
      },
      loadMain: () => {
        events.push("load");
        if (mode === "module-load") throw new Error("credential-must-not-appear");
        if (mode === "missing-api") return {} as { runSessionHost(options: HostOptions): number };
        if (mode === "runtime-reject") {
          return { runSessionHost: async () => { throw new Error("credential-must-not-appear"); } };
        }
        return { runSessionHost: () => 0 };
      },
      writeError: (text) => { stderr += text; },
    }));
    assert.notEqual(status, 0, mode);
    assert.doesNotMatch(stderr, /credential-must-not-appear/);
    if (mode === "bad-python") assert.deepEqual(events, ["ddgs"]);
  }
});

test("missing compiled host never falls back to the review-gate entry", async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  rmSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"));
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher([], {
    getEnv: () => makeEnvironment(),
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    build: () => { events.push("build"); return { status: 0 }; },
    ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 2);
  assert.deepEqual(events, []);
  assert.match(stderr, /compiled native session host is unavailable/);
});
