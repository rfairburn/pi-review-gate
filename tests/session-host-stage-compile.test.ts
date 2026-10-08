// Focused source contract for the staged source compile phase: the staged
// launcher must install the locked dependencies with npm ci and then compile
// with the stage's own installed TypeScript CLI through public Node directly
// (`tsc -p <stage>/tsconfig.json`). It must never invoke a package build
// lifecycle (`npm run build`), its recursive `clean:build` removal, a
// node_modules/.bin PATH shim, a shell, or the live checkout's output.
//
// These are source/plan contracts with bounded, inert, retained fixtures.
// Every injected runner here is SYNTHETIC: a synthetic success proves the
// launcher's invocation plan and nothing about a genuine native compile.
// Native compiler/contracts acceptance remains parent-owned and is required
// after this change lands.
//
// Fixtures are never recursively cleaned: they are created with exclusive
// writes under the git-ignored node_modules tree and retained on success and
// on failure.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { delimiter, join, sep } from "node:path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import nodeTest from "node:test";

interface BoundedProcessResult {
  status: number | null;
  signal: string | null;
  error?: Error;
  cleanupConfirmed?: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  stderr?: string;
}

interface BuildResult {
  status: number | null;
  stage?: "install" | "compile" | "stage";
  diagnostics?: string;
  childStatus?: number | null;
  error?: Error;
  signal?: string | null;
  cleanupConfirmed?: boolean;
  timedOut?: boolean;
  outputExceeded?: boolean;
  retainedStage?: boolean;
  stagingRoot?: string;
}

interface BuildOptions {
  packageRoot: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  sourceBuildTimeoutMs?: number;
  runNpm?: (npmCli: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>;
  runCompile?: (compilerCli: string, args: string[], options: Record<string, unknown>) => Promise<BoundedProcessResult>;
}

interface LauncherModule {
  __test: {
    buildSourceExtension(options: BuildOptions): Promise<BuildResult>;
  };
}

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-stage-compile.test.ts"));
const launcher = requireCjs("../scripts/pi-review-sessions.cjs") as LauncherModule;

// POSIX-owned stage fixtures. Windows source paths exist but native Windows
// acceptance is a separate parent-owned task; this file makes no claim there.
const posixSkip = process.platform === "win32"
  ? "POSIX-owned stage fixtures; Windows native acceptance is parent-owned"
  : false;

const LOCKED_CI_ARGS = ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"];
const MAX_FIXTURE_FILES = 32;
const MAX_FIXTURE_BYTES = 256 * 1024;
const LIVE_DIST_SENTINEL = "LIVE DIST SENTINEL — never rebuilt in place\n";
const SYNTHETIC_NODE_OPTIONS = [process.env.NODE_OPTIONS, "--no-warnings"].filter((value) => value !== undefined && value !== "").join(" ");

interface FixtureBudget {
  files: number;
  bytes: number;
}

interface StageFixture {
  root: string;
  packageRoot: string;
  agentDir: string;
  bin: string;
  budget: FixtureBudget;
}

/** Exclusive bounded fixture writes: <=32 files and <=256 KiB per fixture. */
function writeInertFile(budget: FixtureBudget, file: string, data: string): void {
  budget.files += 1;
  budget.bytes += Buffer.byteLength(data, "utf8");
  assert.ok(budget.files <= MAX_FIXTURE_FILES, "fixture file budget exceeded");
  assert.ok(budget.bytes <= MAX_FIXTURE_BYTES, "fixture byte budget exceeded");
  writeFileSync(file, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function makeStageFixture(prefix: string): StageFixture {
  const base = join(process.cwd(), "node_modules");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, prefix));
  const budget: FixtureBudget = { files: 0, bytes: 0 };
  const packageRoot = join(root, "package root π");
  for (const directory of [
    join(packageRoot, "src", "session-host"),
    join(packageRoot, "scripts"),
    join(packageRoot, "skills"),
    join(packageRoot, "dist", "src", "session-host"),
  ]) mkdirSync(directory, { recursive: true });
  writeInertFile(budget, join(packageRoot, "package.json"), JSON.stringify({
    name: "pi-review-gate",
    version: "0.1.0",
    scripts: { "clean:build": "node -e \"rmSync dist\"", build: "npm run clean:build && tsc -p tsconfig.json" },
  }));
  writeInertFile(budget, join(packageRoot, "package-lock.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0", lockfileVersion: 3 }));
  writeInertFile(budget, join(packageRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }));
  writeInertFile(budget, join(packageRoot, "src", "session-host", "main.ts"), "// synthetic source marker\n");
  writeInertFile(budget, join(packageRoot, "dist", "src", "session-host", "main.js"), LIVE_DIST_SENTINEL);
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  writeInertFile(budget, join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }));
  writeInertFile(budget, join(bin, "npm"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  return { root, packageRoot, agentDir: join(root, "agent"), bin, budget };
}

function fixtureEnv(fixture: StageFixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: SYNTHETIC_NODE_OPTIONS,
    ANTHROPIC_API_KEY: "provider-secret",
    ...extra,
  };
}

/** Inert synthetic `node_modules/typescript` layout inside one owned stage. */
function writeInertCompiler(budget: FixtureBudget, stageRoot: string, compilerSource = "// inert synthetic compiler: never executed\n"): void {
  const packageDir = join(stageRoot, "node_modules", "typescript");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeInertFile(budget, join(packageDir, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }));
  writeInertFile(budget, join(packageDir, "bin", "tsc"), compilerSource);
}

function ok(overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "", ...overrides };
}

interface CompilePlan {
  compilerCli: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Run one staged build with an install seam that writes the compiler fixture. */
async function runStagedBuild(
  fixture: StageFixture,
  options: {
    npmCalls?: string[][];
    compilePlans?: CompilePlan[];
    install?: (stageRoot: string) => void;
    compile?: (stageRoot: string) => Promise<BoundedProcessResult>;
    useDefaultCompile?: boolean;
  } = {},
): Promise<BuildResult> {
  const buildOptions: BuildOptions = {
    packageRoot: fixture.packageRoot,
    agentDir: fixture.agentDir,
    env: fixtureEnv(fixture),
    runNpm: async (_npmCli, args, processOptions) => {
      options.npmCalls?.push(args);
      const stageRoot = String(processOptions.cwd);
      if (options.install) options.install(stageRoot);
      else writeInertCompiler(fixture.budget, stageRoot);
      return ok();
    },
  };
  if (!options.useDefaultCompile) {
    buildOptions.runCompile = async (compilerCli, args, processOptions) => {
      const stageRoot = String(processOptions.cwd);
      options.compilePlans?.push({ compilerCli, args, cwd: stageRoot, env: processOptions.env as NodeJS.ProcessEnv });
      if (options.compile) return options.compile(stageRoot);
      return ok();
    };
  }
  return launcher.__test.buildSourceExtension(buildOptions);
}

nodeTest("the staged compile plan is a direct installed-TypeScript invocation with no package build lifecycle", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-plan-");
  const npmCalls: string[][] = [];
  const compilePlans: CompilePlan[] = [];
  const result = await runStagedBuild(fixture, { npmCalls, compilePlans });

  assert.equal(result.status, 0);
  assert.equal(result.stage, undefined, "a successful build reports no failing stage");
  assert.deepEqual(npmCalls, [LOCKED_CI_ARGS], "the only npm invocation is the locked ci install");
  assert.ok(
    !npmCalls.flat().some((arg) => arg === "run" || arg === "build" || arg === "clean:build"),
    "no package build or recursive clean lifecycle is ever invoked",
  );

  const stage = result.stagingRoot;
  assert.ok(typeof stage === "string" && stage.length > 0);
  assert.equal(compilePlans.length, 1, "the compile phase is exactly one direct compiler invocation");
  const plan = compilePlans[0];
  assert.equal(plan.cwd, stage);
  assert.equal(plan.compilerCli, join(stage, "node_modules", "typescript", "bin", "tsc"),
    "the compile uses the stage's own installed TypeScript CLI, never a global/SDK/parent copy");
  assert.equal(plan.compilerCli.startsWith(`${stage}${sep}`), true, "the compiler stays inside the owned stage");
  assert.ok(!plan.compilerCli.includes(`${sep}.bin${sep}`) && !plan.compilerCli.endsWith(".cmd"),
    "the compiler entry is the real JS file, never a .bin or cmd shell shim");
  assert.deepEqual(plan.args, ["-p", join(stage, "tsconfig.json")],
    "the compile is a direct tsc project invocation, never `npm run build`");
  assert.doesNotMatch(String(plan.env.PATH ?? ""), /node_modules[/\\]\.bin/u, "the compile PATH never gains a node_modules/.bin entry");
  assert.equal(plan.env.NODE_OPTIONS, SYNTHETIC_NODE_OPTIONS, "the original caller startup options plus the synthetic fixture flag are preserved for the compile");
  assert.equal(plan.env.ANTHROPIC_API_KEY, "provider-secret", "trusted provider variables are preserved for the compile");
  assert.equal(existsSync(join(stage, "dist")), false, "no output exists before the compiled stage runs");
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), LIVE_DIST_SENTINEL,
    "the live checkout is never rebuilt in place");
  assert.ok(fixture.budget.files <= MAX_FIXTURE_FILES && fixture.budget.bytes <= MAX_FIXTURE_BYTES);
});

// Synthetic plumbing proof only: the default (non-injected) compile runner is
// observed executing the stage's compiler entry through public Node with the
// tsconfig argument. This is NOT a genuine compiler acceptance result.
nodeTest("the default compile runner executes the stage compiler through public Node with the tsconfig argument", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-default-");
  const marker = join(fixture.root, "compile-marker.json");
  const compilerSource = `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }), { flag: "wx", mode: 0o600 });\n`;

  const result = await runStagedBuild(fixture, {
    useDefaultCompile: true,
    install: (stageRoot) => {
      writeInertCompiler(fixture.budget, stageRoot, compilerSource);
      // Account for the one exclusive child-produced marker before dispatch.
      fixture.budget.files += 1;
      fixture.budget.bytes += Buffer.byteLength(JSON.stringify({ argv: ["-p", join(stageRoot, "tsconfig.json")], cwd: stageRoot }), "utf8");
      assert.ok(fixture.budget.files <= MAX_FIXTURE_FILES && fixture.budget.bytes <= MAX_FIXTURE_BYTES);
    },
  });

  assert.equal(result.status, 0, "the synthetic compiler child exits zero");
  const stage = result.stagingRoot;
  assert.ok(typeof stage === "string" && stage.length > 0);
  const observed = JSON.parse(readFileSync(marker, "utf8")) as { argv: string[]; cwd: string };
  assert.deepEqual(observed.argv, ["-p", join(stage, "tsconfig.json")], "public Node receives the direct tsc project argument");
  assert.equal(observed.cwd, stage);
  assert.ok(fixture.budget.files <= MAX_FIXTURE_FILES && fixture.budget.bytes <= MAX_FIXTURE_BYTES);
});

nodeTest("a stage that already contains output refuses the compile before any compiler runs and keeps that output", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-existing-");
  const compilePlans: CompilePlan[] = [];
  let stagedOutput = "";
  const result = await runStagedBuild(fixture, {
    compilePlans,
    install: (stageRoot) => {
      writeInertCompiler(fixture.budget, stageRoot);
      const distDir = join(stageRoot, "dist", "src", "session-host");
      mkdirSync(distDir, { recursive: true });
      stagedOutput = join(distDir, "main.js");
      writeInertFile(fixture.budget, stagedOutput, "// pre-existing staged output\n");
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.status, 1);
  assert.equal(result.retainedStage, true, "the refused stage is retained, never cleaned");
  assert.match(result.diagnostics ?? "", /staging root unexpectedly contains build output/);
  assert.equal(compilePlans.length, 0, "no compiler is invoked over an existing output");
  assert.equal(readFileSync(stagedOutput, "utf8"), "// pre-existing staged output\n", "existing output is never overwritten or removed");
  assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), LIVE_DIST_SENTINEL);
});

nodeTest("a missing installed compiler refuses the compile and retains the stage", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-missing-");
  const compilePlans: CompilePlan[] = [];
  const result = await runStagedBuild(fixture, {
    compilePlans,
    install: (stageRoot) => mkdirSync(join(stageRoot, "node_modules"), { recursive: true }),
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.status, 1);
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /the staged TypeScript compiler is unavailable/);
  assert.equal(compilePlans.length, 0, "no compiler runs when the installed one is missing");
});

nodeTest("a compiler entry that is an internal symlink is refused", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-symlink-");
  const compilePlans: CompilePlan[] = [];
  const result = await runStagedBuild(fixture, {
    compilePlans,
    install: (stageRoot) => {
      const packageDir = join(stageRoot, "node_modules", "typescript");
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      mkdirSync(join(packageDir, "lib"), { recursive: true });
      writeInertFile(fixture.budget, join(packageDir, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }));
      // A real target inside the same package: still refused because the
      // admitted entry itself must be a regular non-symlink file.
      writeInertFile(fixture.budget, join(packageDir, "lib", "tsc.js"), "// substituted in-package target\n");
      symlinkSync(join(packageDir, "lib", "tsc.js"), join(packageDir, "bin", "tsc"));
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /the staged TypeScript compiler is not a regular file/);
  assert.equal(compilePlans.length, 0, "no compiler runs through a symlinked entry");
});

nodeTest("a symlinked installed-package ancestor is refused", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-ancestor-symlink-");
  const compilePlans: CompilePlan[] = [];
  const result = await runStagedBuild(fixture, {
    compilePlans,
    install: (stageRoot) => {
      const nodeModules = join(stageRoot, "node_modules");
      const realPackage = join(nodeModules, "typescript-real");
      mkdirSync(join(realPackage, "bin"), { recursive: true });
      writeInertFile(fixture.budget, join(realPackage, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }));
      writeInertFile(fixture.budget, join(realPackage, "bin", "tsc"), "// inert synthetic compiler\n");
      symlinkSync(realPackage, join(nodeModules, "typescript"));
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /the staged TypeScript compiler is unavailable/);
  assert.equal(compilePlans.length, 0, "no compiler runs through a symlinked ancestor");
});

nodeTest("a compiler entry whose real ancestor chain changes during the compile is refused and retained", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-ancestor-");
  const result = await runStagedBuild(fixture, {
    compile: async (stageRoot) => {
      // The compile "succeeds", but the compiler's real ancestor identity is
      // swapped underneath it; the post-compile fence must refuse the stage.
      renameSync(join(stageRoot, "node_modules", "typescript", "bin"), join(stageRoot, "node_modules", "typescript", "bin-moved"));
      return ok();
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.status, 1);
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /staging directory chain changed during the TypeScript compile/);
});

nodeTest("a directory masquerading as the installed compiler entry is refused", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-notfile-");
  const compilePlans: CompilePlan[] = [];
  const result = await runStagedBuild(fixture, {
    compilePlans,
    install: (stageRoot) => {
      const packageDir = join(stageRoot, "node_modules", "typescript");
      mkdirSync(join(packageDir, "bin", "tsc"), { recursive: true });
      writeInertFile(fixture.budget, join(packageDir, "package.json"), JSON.stringify({ name: "typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }));
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /the staged TypeScript compiler is not a regular file/);
  assert.equal(compilePlans.length, 0);
});

nodeTest("a compiler entry replaced in place during the compile is refused and retained", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-entry-swap-");
  const result = await runStagedBuild(fixture, {
    compile: async (stageRoot) => {
      // Only the entry changes: its parent directory identity is untouched, so
      // only the captured entry identity can catch the substitution.
      const binDir = join(stageRoot, "node_modules", "typescript", "bin");
      renameSync(join(binDir, "tsc"), join(binDir, "tsc-original"));
      writeInertFile(fixture.budget, join(binDir, "tsc"), "// substituted compiler entry\n");
      return ok();
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.status, 1);
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /staging directory chain changed during the TypeScript compile/);
});

nodeTest("an installed package whose identity is not TypeScript is refused", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-identity-");
  const compilePlans: CompilePlan[] = [];
  const result = await runStagedBuild(fixture, {
    compilePlans,
    install: (stageRoot) => {
      const packageDir = join(stageRoot, "node_modules", "typescript");
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      writeInertFile(fixture.budget, join(packageDir, "package.json"), JSON.stringify({ name: "not-typescript", version: "5.7.2", bin: { tsc: "./bin/tsc" } }));
      writeInertFile(fixture.budget, join(packageDir, "bin", "tsc"), "// inert\n");
    },
  });

  assert.equal(result.stage, "stage");
  assert.equal(result.retainedStage, true);
  assert.match(result.diagnostics ?? "", /the staged TypeScript package identity does not match the locked dependency/);
  assert.equal(compilePlans.length, 0);
});

nodeTest("a failing compile reports the compile stage with bounded sanitized diagnostics and retains the stage", { skip: posixSkip }, async () => {
  const fixture = makeStageFixture(".session-host-stage-compile-failure-");
  const result = await runStagedBuild(fixture, {
    compile: async () => ok({
      status: 2,
      stdout: `\u001b[31m${"o".repeat(20000)}`,
      stderr: "\u001b[31mTS1005: ';' expected.\u001b[0m\n",
    }),
  });

  assert.equal(result.stage, "compile");
  assert.equal(result.status, 2, "the true compiler status is preserved");
  assert.equal(result.childStatus, 2);
  assert.equal(result.retainedStage, true);
  assert.ok(Buffer.byteLength(result.diagnostics ?? "", "utf8") <= 4096, "diagnostics share one aggregate ceiling");
  assert.doesNotMatch(result.diagnostics ?? "", /\u001b/u, "terminal controls never reach the operator");
  assert.match(result.diagnostics ?? "", /TypeScript compile \(tsc -p tsconfig\.json\)/);
  assert.match(result.diagnostics ?? "", /TS1005: ';' expected\./);
  assert.ok(result.stagingRoot === undefined);
});

nodeTest("a signaled compile, an expired compile, and an unsettled compile child all fail closed and retain", { skip: posixSkip }, async () => {
  const expectedSignalStatus = 137; // 128 + SIGKILL(9)
  const cases: Array<{ name: string; compile: () => Promise<BoundedProcessResult>; assertResult: (result: BuildResult) => void }> = [
    {
      name: "signaled",
      compile: async () => ok({ status: null, signal: "SIGKILL", stdout: "" }),
      assertResult: (result) => {
        assert.equal(result.status, expectedSignalStatus);
        assert.equal(result.signal, "SIGKILL");
        assert.equal(result.timedOut, false);
      },
    },
    {
      name: "expired",
      compile: async () => ok({ status: null, signal: "SIGTERM", timedOut: true }),
      assertResult: (result) => {
        assert.equal(result.status, 124, "an expired compile keeps the deadline status");
        assert.equal(result.timedOut, true);
      },
    },
    {
      name: "unsettled",
      compile: async () => ok({ status: 0, cleanupConfirmed: false }),
      assertResult: (result) => {
        assert.equal(result.status, 1, "an unconfirmed compile cleanup is never green");
        assert.equal(result.cleanupConfirmed, false);
      },
    },
  ];

  for (const scenario of cases) {
    const fixture = makeStageFixture(`.session-host-stage-compile-${scenario.name}-`);
    const result = await runStagedBuild(fixture, { compile: scenario.compile });
    assert.equal(result.stage, "compile", scenario.name);
    assert.equal(result.retainedStage, true, `${scenario.name}: the stage is retained`);
    scenario.assertResult(result);
    assert.ok(existsSync(fixture.agentDir), `${scenario.name}: the owned stage cache remains`);
    assert.equal(readFileSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js"), "utf8"), LIVE_DIST_SENTINEL,
      `${scenario.name}: the live checkout output is preserved`);
  }
});

// A retained fixture is only ever observed here; nothing in this file removes
// a stage, a descendant, or a fixture tree.
nodeTest("the retained compile fixtures are real directories that were never recursively cleaned", { skip: posixSkip }, () => {
  const fixture = makeStageFixture(".session-host-stage-compile-retained-");
  assert.equal(lstatSync(fixture.root).isDirectory(), true);
  assert.equal(existsSync(join(fixture.packageRoot, "package.json")), true);
  assert.equal(existsSync(join(fixture.packageRoot, "dist", "src", "session-host", "main.js")), true);
});
