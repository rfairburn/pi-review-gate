import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

interface PiRuntimeResult {
  file: string;
  version: string;
  source: string;
}

interface LauncherOverrides {
  getEnv?: () => NodeJS.ProcessEnv;
  platform?: string;
  nodeVersion?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  packageRoot?: string;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
  build?: (options: { packageRoot: string; agentDir: string; env: NodeJS.ProcessEnv }) => { status: number | null; error?: Error; stagingRoot?: string };
  ensureDdgs?: (homeDir: string, env: NodeJS.ProcessEnv) => { ok: boolean; python?: string; exitCode?: number };
  resolvePiRuntime?: (options: { explicit?: string; env: NodeJS.ProcessEnv; agentDir: string; cwd: string; writeError: (text: string) => void }) => PiRuntimeResult;
  isRegularFile?: (file: string) => boolean;
  loadMain?: (entry: string) => { runSessionHost(options: HostOptions): Promise<number> | number };
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
}

interface LauncherModule {
  USAGE: string;
  PI_PACKAGE_NAME: string;
  PI_MIN_VERSION: readonly number[];
  PI_PROVISION_VERSION: string;
  parseSessionHostArguments(argv: readonly string[]): ParsedArguments;
  __test: {
    runSessionHostLauncher(argv: readonly string[], overrides?: LauncherOverrides): Promise<number>;
    resolvePiRuntime(options: { explicit?: string; env: NodeJS.ProcessEnv; agentDir: string; cwd: string; writeError: (text: string) => void }): PiRuntimeResult;
    validatePiPackage(pkgDir: string, env: NodeJS.ProcessEnv, options?: { expectedFile?: string; exactVersion?: string }): { file: string; version: string };
    probePiVersion(file: string, env: NodeJS.ProcessEnv): string;
    stageSourcePackage(packageRoot: string, buildCacheRoot: string): string;
    removeOwnedStage(target: string): boolean;
  };
}

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-launcher.test.ts"));
const launcher = requireCjs("../scripts/pi-review-sessions.cjs") as LauncherModule;
const gateLauncher = requireCjs("../scripts/pi-review-gate-launcher.cjs") as { ensureDdgs(homeDir: string, env: NodeJS.ProcessEnv): { ok: boolean; python?: string; exitCode?: number } };
const SCRIPT = join(process.cwd(), "scripts", "pi-review-sessions.cjs");

function makePackageFixture(source: boolean): { root: string; packageRoot: string } {
  const root = mkdtempSync(join(process.cwd(), ".session-host-launcher-fixture-"));
  const packageRoot = join(root, "package root π");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0", scripts: { build: "tsc -p tsconfig.json" } }), "utf8");
  writeFileSync(join(packageRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }), "utf8");
  // Sentinel content: source-build tests assert the live dist survives.
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "main.js"), "LIVE DIST SENTINEL — never rebuild in place\n", "utf8");
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
    build: ({ packageRoot: root, env: setupEnv }) => {
      events.push("build");
      assert.equal(root, packageRoot);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      return { status: 0 };
    },
    resolvePiRuntime: (options) => {
      events.push("pi");
      assert.equal(options.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(options.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" };
    },
    ensureDdgs: (homeDir, setupEnv) => {
      events.push("ddgs");
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
      assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, undefined);
      void homeDir;
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
  assert.match(result.stdout, /no\s+manual Pi CLI path is needed/);
  assert.match(result.stdout, /Basic controls only;\s*terminal\s+graphics rendering is disabled/);
  assert.match(result.stdout, /native image\/model input behavior\s+stays\s+native/);
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
    assert.deepEqual(events, [], `no build/Pi/DDGS/load/run for ${entry.flag}`);
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
    assert.deepEqual(events, ["pi", "ddgs", "load", "run"], JSON.stringify(args));
    assert.deepEqual(captured[0].args, args, "native arguments are forwarded byte-for-byte");
  }
});

test("source build, Pi runtime selection, and DDGS setup precede loading the synthetic host API", async (t) => {
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
  assert.deepEqual(events, ["build", "pi", "ddgs", "load", "run"]);
  assert.equal(captured.length, 1);
  // The explicit executable is honored by the stubbed resolver seam; the
  // resolved entry (not a bare name) always reaches the host.
  assert.deepEqual(captured[0], {
    packageRoot: fixture.packageRoot,
    piExecutable: "/synthetic/pi",
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

test("production source-build runs in an owned staging root and preserves the live dist", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocation.json");
  // The fake npm simulates `npm run build`: it records the invocation and
  // writes the compiled entry under the staged prefix (never the checkout).
  writeFileSync(join(bin, "npm"), [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `if (process.argv[2] === "root") process.exit(0); // no global root in this fixture`,
    `fs.writeFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, ddgs: process.env.PI_REVIEW_GATE_DDGS_PYTHON ?? null, nodeOptions: process.env.NODE_OPTIONS, provider: process.env.ANTHROPIC_API_KEY }));`,
    `if (process.argv[2] === "--prefix") {`,
    `  const prefix = process.argv[3];`,
    `  const distDir = path.join(prefix, "dist", "src", "session-host");`,
    `  fs.mkdirSync(distDir, { recursive: true });`,
    `  fs.writeFileSync(path.join(distDir, "main.js"), "// staged build output\\n");`,
    `}`,
    "",
  ].join("\n"), "utf8");
  chmodSync(join(bin, "npm"), 0o755);

  const events: string[] = [];
  const captured: HostOptions[] = [];
  const env = makeEnvironment({
    HOME: fixture.root,
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
    resolvePiRuntime: (options) => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: (root) => { events.push("ddgs"); void root; return { ok: true, python: "/synthetic/python" }; },
    loadMain: (entry) => {
      events.push("load");
      assert.ok(existsSync(entry));
      return { runSessionHost: (options) => { events.push("run"); captured.push(options); return 0; } };
    },
    writeOut: () => undefined,
    // Only the informational pi-runtime notice may reach stderr here.
    writeError: (text) => assert.match(text, /^pi-review-sessions: pi runtime: \/synthetic\/pi \(v1\.0\.4, npm-global\)\n$/),
  });
  assert.equal(status, 0);
  // The real default build runs (no build override): its npm invocation is
  // asserted from the log below.
  assert.deepEqual(events, ["pi", "ddgs", "load", "run"]);
  const invocation = JSON.parse(readFileSync(log, "utf8")) as {
    args: string[];
    cwd: string;
    bootstrap: string | null;
    restore: string | null;
    ddgs: string | null;
    nodeOptions: string;
    provider: string;
  };
  const stagingRoot = invocation.args[1];
  // The build runs against an owned staging package root under the agent
  // directory cache — never the live checkout.
  assert.deepEqual(invocation.args, ["--prefix", stagingRoot, "run", "build"]);
  assert.equal(invocation.cwd, stagingRoot);
  const agentDir = join(fixture.root, ".pi", "agent");
  assert.ok(stagingRoot.startsWith(`${agentDir}/.pi-review-gate/build/pi-review-sessions-`), `staged root must be owned: ${stagingRoot}`);
  // The host receives the staged root so every runtime lookup stays in the stage.
  assert.equal(captured[0].packageRoot, stagingRoot);
  // The staged package carries the build and runtime inputs.
  for (const name of ["package.json", "tsconfig.json", join("src", "session-host", "main.ts")]) {
    assert.ok(existsSync(join(stagingRoot, name)), `staged package must include ${name}`);
  }
  // The live checkout dist is preserved byte-for-byte.
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
  assert.equal(invocation.bootstrap, null);
  assert.equal(invocation.restore, null);
  assert.equal(invocation.ddgs, null);
  assert.equal(invocation.nodeOptions, "--no-warnings");
  assert.equal(invocation.provider, "provider-secret");
  assert.deepEqual(captured[0].args, ["--scheduler"]);
});

test("a failed staged build preserves the live dist and removes only its owned stage", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocation.json");
  writeFileSync(join(bin, "npm"), [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `if (process.argv[2] === "root") process.exit(0);`,
    `fs.writeFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
    `process.exit(23); // simulate a failing tsc`,
    "",
  ].join("\n"), "utf8");
  chmodSync(join(bin, "npm"), 0o755);

  const env = makeEnvironment({ HOME: fixture.root, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_NPM_LOG: log });
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: (root) => { events.push("ddgs"); void root; return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 23);
  assert.deepEqual(events, [], "no Pi/DDGS/load after a failed build");
  // The live checkout dist is preserved byte-for-byte.
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
  // Only this run's owned stage exists (and was removed on failure).
  const buildCacheRoot = join(fixture.root, ".pi", "agent", ".pi-review-gate", "build");
  if (existsSync(buildCacheRoot)) {
    for (const entry of readdirNames(buildCacheRoot)) {
      assert.doesNotMatch(entry, /^pi-review-sessions-/, "owned stage is removed on build failure");
    }
  }
});

test("stageSourcePackage copies build and runtime inputs without touching the checkout", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  mkdirSync(join(fixture.packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(fixture.packageRoot, "scripts", "helper.ps1"), "# shipped helper\n", "utf8");
  const skillsDir = join(fixture.packageRoot, "skills", "pi-review-gate-execution");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, "SKILL.md"), "# skill\n", "utf8");
  // Nested initialized-Terraform directories at several depths: pruned at
  // traversal time, never copied into the stage.
  for (const dir of [join(fixture.packageRoot, "src", ".terraform"), join(fixture.packageRoot, "scripts", "nested", ".terraform"), join(skillsDir, ".terraform")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sentinel"), "do not copy\n", "utf8");
  }

  const buildCacheRoot = join(fixture.root, "build-cache");
  const stagingRoot = launcher.__test.stageSourcePackage(fixture.packageRoot, buildCacheRoot);
  assert.ok(stagingRoot.startsWith(buildCacheRoot));
  for (const name of ["package.json", "tsconfig.json", join("src", "session-host", "main.ts"), join("scripts", "helper.ps1"), join("skills", "pi-review-gate-execution", "SKILL.md")]) {
    assert.ok(existsSync(join(stagingRoot, name)), `staged package must include ${name}`);
  }
  for (const name of [join("src", ".terraform"), join("scripts", "nested", ".terraform"), join("skills", "pi-review-gate-execution", ".terraform")]) {
    assert.ok(!existsSync(join(stagingRoot, name)), `staged package must omit ${name}`);
  }
  // The checkout is untouched: its live dist sentinel and sources remain.
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), "LIVE DIST SENTINEL — never rebuild in place\n");
  assert.ok(existsSync(join(fixture.packageRoot, "src", "session-host", "main.ts")));
});

test("removeOwnedStage removes an owned stage but preserves .terraform subtrees", (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const stage = join(fixture.root, "stage");
  mkdirSync(join(stage, "src", ".terraform"), { recursive: true });
  writeFileSync(join(stage, "src", ".terraform", "sentinel"), "preserve me\n", "utf8");
  writeFileSync(join(stage, "src", "main.ts"), "removable\n", "utf8");
  writeFileSync(join(stage, "package.json"), "{}\n", "utf8");

  const removed = launcher.__test.removeOwnedStage(stage);
  assert.equal(removed, false, "a preserved .terraform subtree keeps its ancestors");
  assert.equal(readFileSync(join(stage, "src", ".terraform", "sentinel"), "utf8"), "preserve me\n", ".terraform contents are never deleted");
  assert.ok(!existsSync(join(stage, "src", "main.ts")), "ordinary stage contents are removed");
  assert.ok(!existsSync(join(stage, "package.json")), "ordinary stage contents are removed");

  // With no .terraform present the whole owned stage is removed.
  const plain = join(fixture.root, "plain-stage");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "file"), "x\n", "utf8");
  assert.equal(launcher.__test.removeOwnedStage(plain), true);
  assert.ok(!existsSync(plain));
});

test("a relative PI_CODING_AGENT_DIR anchors staging and host paths against the startup cwd", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const bin = join(fixture.root, "fake-bin");
  mkdirSync(bin);
  const log = join(fixture.root, "npm-invocation.json");
  writeFileSync(join(bin, "npm"), [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `if (process.argv[2] === "root") process.exit(0);`,
    `fs.writeFileSync(process.env.TEST_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
    `if (process.argv[2] === "--prefix") {`,
    `  const distDir = path.join(process.argv[3], "dist", "src", "session-host");`,
    `  fs.mkdirSync(distDir, { recursive: true });`,
    `  fs.writeFileSync(path.join(distDir, "main.js"), "// staged build output\\n");`,
    `}`,
    "",
  ].join("\n"), "utf8");
  chmodSync(join(bin, "npm"), 0o755);

  const startupCwd = join(fixture.root, "startup cwd");
  mkdirSync(startupCwd);
  const env = makeEnvironment({
    HOME: fixture.root,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TEST_NPM_LOG: log,
    PI_CODING_AGENT_DIR: "./agent dir π",
  });
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const status = await launcher.__test.runSessionHostLauncher(["--", "--scheduler"], {
    getEnv: () => env,
    processEnv: {},
    platform: "linux",
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    cwd: startupCwd,
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: (root) => { events.push("ddgs"); void root; return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: (options) => { events.push("run"); captured.push(options); return 0; } }; },
    writeOut: () => undefined,
    writeError: () => undefined,
  });
  assert.equal(status, 0);
  const anchoredAgentDir = join(startupCwd, "agent dir π");
  // The real default build runs against an absolute staged prefix under the
  // anchored agent directory.
  const invocation = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; cwd: string };
  const stagingRoot = invocation.args[1];
  assert.ok(isAbsolute(stagingRoot), `npm prefix must be absolute: ${stagingRoot}`);
  assert.equal(invocation.cwd, stagingRoot);
  assert.ok(stagingRoot.startsWith(`${anchoredAgentDir}/.pi-review-gate/build/pi-review-sessions-`), `staged root must be anchored: ${stagingRoot}`);
  // The host receives an absolute package root and the anchored override.
  assert.equal(captured[0].packageRoot, stagingRoot);
  assert.ok(isAbsolute(captured[0].packageRoot));
  assert.equal(captured[0].env.PI_CODING_AGENT_DIR, anchoredAgentDir);
});

test("packaged compiled path skips source build and always hands a resolved pi entry to the host", async (t) => {
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
  assert.deepEqual(events, ["pi", "ddgs", "run"]);
  assert.deepEqual(captured[0].args, ["--help"]);
  // No manual path: the automatic resolver's entry always reaches the host.
  assert.equal(captured[0].piExecutable, "/synthetic/pi");
  assert.equal(Object.hasOwn(captured[0], "stateRoot"), false);
  assert.equal(Object.hasOwn(captured[0], "toggleKey"), false);
});

test("shared Node DDGS provisioning uses the synthetic venv and sanitized production env", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const venv = join(fixture.root, "synthetic venv");
  const pythonDir = join(venv, "bin");
  mkdirSync(pythonDir, { recursive: true });
  const log = join(fixture.root, "fake-python-log.jsonl");
  const fakePython = join(pythonDir, "python");
  writeFileSync(fakePython, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.TEST_DDGS_LOG, JSON.stringify({ argv: process.argv.slice(2), bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, provider: process.env.ANTHROPIC_API_KEY ?? null }) + "\\n");\n`, "utf8");
  chmodSync(fakePython, 0o755);

  // Production-like env seam: the launcher scrubs process.env in place, and
  // the shared helper's Python children inherit exactly that scrubbed env.
  const saved: Record<string, string | undefined> = {};
  for (const name of ["PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP", "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE", "NODE_OPTIONS", "ANTHROPIC_API_KEY", "TEST_DDGS_LOG", "PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG", "PI_REVIEW_GATE_DDGS_VENV"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP = "bootstrap-secret";
  process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE = "restore-secret";
  process.env.NODE_OPTIONS = "--no-warnings";
  process.env.ANTHROPIC_API_KEY = "provider-secret";
  process.env.TEST_DDGS_LOG = log;
  process.env.PI_REVIEW_GATE_DDGS_VENV = venv;

  const env = makeEnvironment({
    HOME: fixture.root,
    XDG_CACHE_HOME: join(fixture.root, "cache"),
    PI_REVIEW_GATE_DDGS_VENV: venv,
  });
  const events: string[] = [];
  const captured: HostOptions[] = [];
  const result = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, captured, {
    getEnv: () => process.env,
    processEnv: process.env,
    ensureDdgs: (homeDir, setupEnv) => { events.push("ddgs"); return gateLauncher.ensureDdgs(homeDir, setupEnv); },
  }));
  assert.equal(result, 0);
  assert.deepEqual(events, ["pi", "ddgs", "load", "run"]);
  assert.equal(captured[0].env.PI_REVIEW_GATE_DDGS_PYTHON, fakePython);
  assert.equal(captured[0].env.NODE_OPTIONS, "--no-warnings");
  assert.equal(captured[0].env.ANTHROPIC_API_KEY, "provider-secret");
  const pythonCalls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    argv: string[];
    bootstrap: string | null;
    restore: string | null;
    nodeOptions: string | null;
    provider: string | null;
  });
  // The shared helper validates twice by design (pre-install decision and
  // final gate): version check + pip check per pass.
  assert.equal(pythonCalls.length, 4, "a valid cached venv runs two validation passes");
  for (const call of pythonCalls) {
    assert.equal(call.bootstrap, null, "the bootstrap token never reaches DDGS descendants");
    assert.equal(call.restore, null, "the restore marker never reaches DDGS descendants");
    assert.equal(call.nodeOptions, "--no-warnings", "the original NODE_OPTIONS is preserved");
    assert.equal(call.provider, "provider-secret", "trusted provider variables are preserved");
  }
});

test("a broken DDGS venv stops the launch before loading the host", { skip: process.platform === "win32" }, async (t) => {
  const fixture = makePackageFixture(false);
  cleanupFixture(t, fixture);
  const venv = join(fixture.root, "broken venv");
  const pythonDir = join(venv, "bin");
  mkdirSync(pythonDir, { recursive: true });
  const fakePython = join(pythonDir, "python");
  // Validation always fails; the install step succeeds but cannot repair it.
  // The venv python is invoked as `python -I -c ...`, so `-c` is argv[3]
  // in the child (argv[1] is the script itself).
  writeFileSync(fakePython, `#!${process.execPath}\nif (process.argv[3] === "-c") process.exit(1);\n`, "utf8");
  chmodSync(fakePython, 0o755);

  const env = makeEnvironment({
    HOME: fixture.root,
    XDG_CACHE_HOME: join(fixture.root, "cache"),
    PI_REVIEW_GATE_DDGS_VENV: venv,
  });
  const events: string[] = [];
  let stderr = "";
  const result = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
    ensureDdgs: (homeDir, setupEnv) => { events.push("ddgs"); return gateLauncher.ensureDdgs(homeDir, setupEnv); },
    writeError: (text) => { stderr += text; },
  }));
  assert.equal(result, 1);
  assert.deepEqual(events, ["pi", "ddgs"]);
  // The helper's fail-closed diagnostics go to fd 2 directly; the launcher
  // must still stop before loading the host and report a bounded failure.
  assert.match(stderr, /DDGS setup failed/);
});

test("Pi runtime resolution failure stops the launch before DDGS and host load", async (t) => {
  const fixture = makePackageFixture(true);
  cleanupFixture(t, fixture);
  const env = makeEnvironment();
  const events: string[] = [];
  let stderr = "";
  const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
    // A non-PiRuntimeError must be sanitized: no resolver detail may leak.
    resolvePiRuntime: () => { throw new Error("the pi runtime at /synthetic/secret is unavailable"); },
    writeError: (text) => { stderr += text; },
  }));
  assert.equal(status, 1);
  assert.deepEqual(events, ["build"]);
  assert.match(stderr, /Pi runtime selection failed\./);
  assert.doesNotMatch(stderr, /secret/);
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
      resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
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
  assert.match(output, /terminal\s+graphics rendering is disabled/);
  assert.match(output, /native image\/model input behavior\s+stays\s+native/);
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
      events: ["build", "pi", "ddgs"],
    },
  ]) {
    const events: string[] = [];
    let stderr = "";
    const status = await launcher.__test.runSessionHostLauncher([], baseOverrides(fixture.packageRoot, env, events, [], {
      build: ({ env: setupEnv }) => {
        events.push("build");
        assert.equal(setupEnv.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, undefined);
        return failure.build();
      },
      ensureDdgs: () => { events.push("ddgs"); return failure.ensure(); },
      loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
      writeError: (text) => { stderr += text; },
    }));
    assert.equal(status, failure.expected, failure.label);
    assert.deepEqual(events, failure.events, failure.label);
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
    if (mode === "bad-python") assert.deepEqual(events, ["pi", "ddgs"]);
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
    resolvePiRuntime: () => { events.push("pi"); return { file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }; },
    ensureDdgs: () => { events.push("ddgs"); return { ok: true, python: "/synthetic/python" }; },
    loadMain: () => { events.push("load"); return { runSessionHost: () => 0 }; },
    writeOut: () => undefined,
    writeError: (text) => { stderr += text; },
  });
  assert.equal(status, 2);
  assert.deepEqual(events, []);
  assert.match(stderr, /compiled native session host is unavailable/);
});

// ---------------------------------------------------------------------------
// Pi runtime selection (issue 323): synthetic OWNROOT package metadata,
// npm shims, and runtime cache directories. No real HOME, SDK, or global
// npm root is ever touched.
// ---------------------------------------------------------------------------

interface RuntimeFixture {
  root: string;
  bin: string;
  agentDir: string;
  globalRoot: string;
  npmLog: string;
}

function makeRuntimeFixture(prefix: string): RuntimeFixture {
  const root = mkdtempSync(join(process.cwd(), prefix));
  const fixture = {
    root,
    bin: join(root, "bin"),
    agentDir: join(root, "agent dir π"),
    // The npm global root is the bare node_modules directory; the resolver
    // appends the scoped package path itself.
    globalRoot: join(root, "global root"),
    npmLog: join(root, "npm-invocations.jsonl"),
  };
  mkdirSync(fixture.bin, { recursive: true });
  return fixture;
}

/** A positive Node CLI entry that reports a fixed version and logs its env. */
function writePiEntry(file: string, version: string, logEnv = false): string {
  mkdirSync(join(file, ".."), { recursive: true });
  const lines = [`#!${process.execPath}`];
  if (logEnv) {
    lines.push(
      `const fs = require("node:fs");`,
      `if (process.argv[2] === "--version" && process.env.PI_PROBE_LOG) fs.writeFileSync(process.env.PI_PROBE_LOG, JSON.stringify({ bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? null, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, provider: process.env.ANTHROPIC_API_KEY ?? null }));`,
    );
  }
  lines.push(`if (process.argv[2] === "--version") console.log("pi ${version}");`);
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function writePiPackage(pkgDir: string, version = "1.0.4", name = launcher.PI_PACKAGE_NAME): string {
  const entry = join(pkgDir, "dist", "bundle", "cli.js");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name,
    version,
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  writePiEntry(entry, version);
  return entry;
}

function writeFakeNpm(fixture: RuntimeFixture, behavior: "global" | "install" = "global"): void {
  const fakeNpm = join(fixture.bin, "npm");
  const lines = [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(process.env.PI_NPM_LOG, JSON.stringify({ args }) + "\\n");`,
  ];
  if (behavior === "global") {
    lines.push(`if (args[0] === "root") { if (process.env.PI_FAKE_GLOBAL_ROOT) console.log(process.env.PI_FAKE_GLOBAL_ROOT); process.exit(0); }`);
    lines.push(`process.exit(1);`);
  } else {
    // install --prefix <staging> --ignore-scripts --no-audit --no-fund
    // --registry https://registry.npmjs.org @earendil-works/pi-coding-agent@1.0.4
    lines.push(`if (process.env.PI_FAKE_NPM_FAIL) process.exit(7);`);
    lines.push(`if (args[0] === "install") {`);
    lines.push(`  const prefix = args[args.indexOf("--prefix") + 1];`);
    lines.push(`  const pkgDir = require("node:path").join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");`);
    lines.push(`  fs.mkdirSync(require("node:path").join(pkgDir, "dist", "bundle"), { recursive: true });`);
    lines.push(`  fs.writeFileSync(require("node:path").join(pkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.4", bin: { pi: "dist/bundle/cli.js" } }));`);
    lines.push(`  const entry = require("node:path").join(pkgDir, "dist", "bundle", "cli.js");`);
    lines.push(`  fs.writeFileSync(entry, "#!${process.execPath}\\nif (process.argv[2] === '--version') console.log('pi 1.0.4');\\n");`);
    lines.push(`  fs.chmodSync(entry, 0o755);`);
    lines.push(`}`);
    lines.push(`process.exit(0);`);
  }
  writeFileSync(fakeNpm, `${lines.join("\n")}\n`, "utf8");
  chmodSync(fakeNpm, 0o755);
}

function runtimeEnv(fixture: RuntimeFixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Fixture-only PATH: automatic-resolution tests must never reach the real
  // npm, a real global Pi install, or any system tool outside the fixture.
  return makeEnvironment({
    PATH: fixture.bin,
    HOME: fixture.root,
    PI_NPM_LOG: fixture.npmLog,
    ...overrides,
  });
}

test("explicit executable is honored when valid and rejected fail-closed otherwise", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-explicit-");
  cleanupFixture(t, fixture);
  const env = runtimeEnv(fixture);
  const goodEntry = writePiEntry(join(fixture.root, "explicit tools/π pi.js"), "1.0.4");

  const ok = launcher.__test.resolvePiRuntime({ explicit: goodEntry, env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.deepEqual(ok, { file: goodEntry, version: "1.0.4", source: "explicit" });

  const shellShim = join(fixture.root, "shell pi.sh");
  writeFileSync(shellShim, "#!/bin/sh\necho shim\n", "utf8");
  chmodSync(shellShim, 0o755);
  const failures: Array<{ explicit: string; diagnostic: RegExp }> = [
    { explicit: join(fixture.root, "missing pi"), diagnostic: /not a regular readable executable file/ },
    { explicit: shellShim, diagnostic: /not a positive Node entry/ },
    { explicit: writePiEntry(join(fixture.root, "old pi.js"), "1.0.3"), diagnostic: /found 1\.0\.3/ },
  ];
  for (const failure of failures) {
    assert.throws(
      () => launcher.__test.resolvePiRuntime({ explicit: failure.explicit, env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined }),
      failure.diagnostic,
    );
  }
});

test("npm global package root is resolved by metadata with bin containment and a live probe", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-global-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.globalRoot, "@earendil-works", "pi-coding-agent");
  writePiPackage(pkgDir);
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, { PI_FAKE_GLOBAL_ROOT: fixture.globalRoot });

  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "npm-global");
  assert.equal(result.version, "1.0.4");
  assert.equal(result.file, join(pkgDir, "dist", "bundle", "cli.js"));
});

test("an unsupported global install falls through to PATH discovery", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-fallthrough-");
  cleanupFixture(t, fixture);
  const globalPkgDir = join(fixture.globalRoot, "@earendil-works", "pi-coding-agent");
  writePiPackage(globalPkgDir, "1.0.3");
  const pathPkgDir = join(fixture.root, "path install", "@earendil-works", "pi-coding-agent");
  const pathEntry = writePiPackage(pathPkgDir);
  // PATH pi: a symlink into the public package's declared bin entry.
  mkdirSync(join(fixture.bin), { recursive: true });
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  symlinkSync(pathEntry, join(fixture.bin, "pi"));
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, { PI_FAKE_GLOBAL_ROOT: fixture.globalRoot });

  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "path");
  assert.equal(result.file, pathEntry);
  assert.equal(result.version, "1.0.4");
});

test("a PATH pi outside the public package is never trusted", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-untrusted-");
  cleanupFixture(t, fixture);
  // A positive Node entry named `pi` that is NOT inside the public package:
  // no enclosing package.json identifies it, so provisioning must be chosen.
  const strayEntry = writePiEntry(join(fixture.bin, "pi"), "1.0.4");
  void strayEntry;
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "isolated-cache");
  assert.ok(result.file.startsWith(join(fixture.agentDir, ".pi-review-gate", "pi-runtime")));
});

test("absent or unsupported Pi provisions the isolated cache with exact npm arguments", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-provision-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  let notice = "";
  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: (text) => { notice += text; } });
  assert.equal(result.source, "isolated-cache");
  assert.equal(result.version, "1.0.4");
  const expectedPkgDir = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent");
  assert.equal(result.file, join(expectedPkgDir, "dist", "bundle", "cli.js"));
  assert.ok(existsSync(result.file));
  assert.match(notice, /provisioning isolated Pi/);
  assert.match(notice, /installed isolated Pi/);

  const invocations = readFileSync(fixture.npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] });
  const installs = invocations.filter((invocation) => invocation.args[0] === "install");
  assert.equal(installs.length, 1, "exactly one npm install for a fresh provision");
  assert.deepEqual(installs[0].args, [
    "install",
    "--prefix", installs[0].args[2],
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry", "https://registry.npmjs.org",
    `${launcher.PI_PACKAGE_NAME}@${launcher.PI_PROVISION_VERSION}`,
  ]);
  assert.ok(installs[0].args[2].startsWith(join(fixture.agentDir, ".pi-review-gate", "pi-runtime", ".staging-pi-1.0.4-")));
  // Staging is removed after publication; the published runtime remains.
  const runtimeRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime");
  for (const entry of readdirNames(runtimeRoot)) {
    assert.doesNotMatch(entry, /^\.staging-pi-1\.0\.4-/);
  }
});

function readdirNames(dir: string): string[] {
  return require("node:fs").readdirSync(dir) as string[];
}

test("a valid cached runtime is reused without any npm invocation", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-cached-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent");
  writePiPackage(pkgDir);
  writeFakeNpm(fixture, "install");
  const env = runtimeEnv(fixture);

  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "isolated-cache");
  assert.equal(result.file, join(pkgDir, "dist", "bundle", "cli.js"));
  // Only the global-root probe may run; a valid cached runtime is never
  // reinstalled.
  const invocations = existsSync(fixture.npmLog)
    ? readFileSync(fixture.npmLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[] })
    : [];
  for (const invocation of invocations) {
    assert.notDeepEqual(invocation.args[0], "install", "no npm install for a valid cached runtime");
  }
});

test("an invalid cached runtime is preserved and fails closed", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-badcache-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", `pi-${launcher.PI_PROVISION_VERSION}`, "node_modules", "@earendil-works", "pi-coding-agent");
  writePiPackage(pkgDir, "1.0.4", "some-other-package");
  const marker = join(fixture.agentDir, ".pi-review-gate", "pi-runtime", "unknown-resource.txt");
  writeFileSync(marker, "preserve me\n", "utf8");
  // Fixture-only npm: the global-root probe must stay inside the fixture.
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture);

  assert.throws(
    () => launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined }),
    /cached pi runtime .* is invalid/,
  );
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n", "unknown cache resources are preserved");
});

test("failed provisioning preserves foreign staging and unknown resources, removing only its own stage", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-fail-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const runtimeRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const marker = join(runtimeRoot, "unknown-resource.txt");
  writeFileSync(marker, "preserve me\n", "utf8");
  // A staging directory from another (possibly concurrent) launch: a name
  // proves neither ownership nor inactivity, so it must be preserved.
  const foreignStage = join(runtimeRoot, ".staging-pi-1.0.4-concurrent-launch");
  mkdirSync(foreignStage, { recursive: true });
  writeFileSync(join(foreignStage, "active-download"), "in progress\n", "utf8");
  const env = runtimeEnv(fixture, { PI_FAKE_NPM_FAIL: "1" });

  assert.throws(
    () => launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined }),
    /pi runtime provisioning failed/,
  );
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n", "unknown resources are preserved");
  assert.equal(readFileSync(join(foreignStage, "active-download"), "utf8"), "in progress\n", "foreign staging is preserved");
  for (const entry of readdirNames(runtimeRoot)) {
    if (entry === ".staging-pi-1.0.4-concurrent-launch") continue;
    assert.doesNotMatch(entry, /^\.staging-pi-1\.0\.4-/, "this run's own stage is removed on failure");
  }
});

test("a concurrent launch's staging survives a successful provision", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-concurrent-");
  cleanupFixture(t, fixture);
  writeFakeNpm(fixture, "install");
  const runtimeRoot = join(fixture.agentDir, ".pi-review-gate", "pi-runtime");
  const foreignStage = join(runtimeRoot, ".staging-pi-1.0.4-other-launch");
  mkdirSync(foreignStage, { recursive: true });
  writeFileSync(join(foreignStage, "active-download"), "in progress\n", "utf8");
  const env = runtimeEnv(fixture);

  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "isolated-cache");
  assert.ok(existsSync(result.file), "the provisioned runtime is published");
  assert.equal(readFileSync(join(foreignStage, "active-download"), "utf8"), "in progress\n", "foreign staging is untouched");
});

test("version probes run on the scrubbed env with provider variables preserved", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-probe-env-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.globalRoot, "@earendil-works", "pi-coding-agent");
  const probeLog = join(fixture.root, "probe-env.json");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  writePiEntry(join(pkgDir, "dist", "bundle", "cli.js"), "1.0.4", true);
  writeFakeNpm(fixture, "global");
  const env = runtimeEnv(fixture, {
    PI_FAKE_GLOBAL_ROOT: fixture.globalRoot,
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    NODE_OPTIONS: "--no-warnings",
    ANTHROPIC_API_KEY: "provider-secret",
    PI_PROBE_LOG: probeLog,
  });

  const result = launcher.__test.resolvePiRuntime({ env, agentDir: fixture.agentDir, cwd: fixture.root, writeError: () => undefined });
  assert.equal(result.source, "npm-global");
  const probe = JSON.parse(readFileSync(probeLog, "utf8")) as {
    bootstrap: string | null;
    restore: string | null;
    nodeOptions: string | null;
    provider: string | null;
  };
  assert.equal(probe.bootstrap, "bootstrap-secret", "the resolver receives the caller env; the CJS scrubs it before calling");
  assert.equal(probe.nodeOptions, "--no-warnings", "the original NODE_OPTIONS is preserved for probes");
  assert.equal(probe.provider, "provider-secret", "trusted provider variables are preserved for probes");
});

test("bin containment rejects a package whose pi entry escapes the package directory", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-escape-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "escaping package", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "../../outside-cli.js" },
  }), "utf8");
  const outside = join(fixture.root, "escaping package", "outside-cli.js");
  writePiEntry(outside, "1.0.4");

  assert.throws(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture)),
    /bin entry escapes the package directory/,
  );
});

test("an in-package bin symlink that resolves outside is never executed", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-symlink-escape-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "symlink package", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  // Lexically inside the package, canonically outside it.
  const outside = join(fixture.root, "symlink package", "outside-cli.js");
  writePiEntry(outside, "1.0.4");
  symlinkSync(outside, join(pkgDir, "dist", "bundle", "cli.js"));

  assert.throws(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture)),
    /resolves outside the package directory/,
  );
});

test("a probe that disagrees with the package metadata is rejected", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-mismatch-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "mismatch package", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: launcher.PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "dist/bundle/cli.js" },
  }), "utf8");
  // The entry reports a different version than its metadata declares.
  writePiEntry(join(pkgDir, "dist", "bundle", "cli.js"), "1.2.3");

  assert.throws(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture)),
    /disagrees with the package metadata/,
  );
});

test("staged and cached provisions require exactly the pinned provision version", (t) => {
  const fixture = makeRuntimeFixture(".session-host-pi-runtime-wrongversion-");
  cleanupFixture(t, fixture);
  const pkgDir = join(fixture.root, "newer package", "@earendil-works", "pi-coding-agent");
  // Above the floor, but not the pinned provision version.
  writePiPackage(pkgDir, "1.0.5");

  assert.throws(
    () => launcher.__test.validatePiPackage(pkgDir, runtimeEnv(fixture), { exactVersion: launcher.PI_PROVISION_VERSION }),
    /does not match the pinned provision version/,
  );
});
