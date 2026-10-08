import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { ensureIgnoredFixtureRoot } from "./helpers/ignored-fixture-root";

// Focused contract tests for .github/workflows/session-host-alpha.yml — the
// separate fail-closed Windows alpha runtime matrix. Like ci-workflow.test.ts,
// these pin the invariants CI correctness depends on with targeted structural
// assertions (no YAML parser dependency): read-only triggers on every enforced
// path, immutable action pins matching ci.yml, finite bounds, fresh exclusive
// runner-temp roots without cleanup, the opt-in fail-closed Main acceptance,
// and explicit focused test selection instead of the broad suite glob.
// Synthetic helper fixtures are allocated under the ignored own-root
// node_modules subtree with explicit names and retained: no default-temp
// allocation and no recursive cleanup of entries this test cannot positively
// identify as its own.

const projectRoot = join(dirname(__dirname), "..");
const alphaPath = join(projectRoot, ".github", "workflows", "session-host-alpha.yml");
const ciPath = join(projectRoot, ".github", "workflows", "ci.yml");

function readAlpha(): string {
  return readFileSync(alphaPath, "utf8");
}

function readCi(): string {
  return readFileSync(ciPath, "utf8");
}

/** Pinned `owner/repo@<sha>` references appearing in a workflow source. */
function pinnedActions(source: string): Set<string> {
  return new Set([...source.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map((match) => match[1]));
}

/** The body of the top-level `on:` block. */
function onBlock(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "on:");
  assert.ok(start !== -1, "expected an on: block");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") { body.push(line); continue; }
    if (line.length - line.trimStart().length <= 0) break;
    body.push(line);
  }
  return body.join("\n");
}

/** The body of the single acceptance job block. */
function jobBlock(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "  windows-acceptance:");
  assert.ok(start !== -1, "expected the windows-acceptance job");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") { body.push(line); continue; }
    if (line.length - line.trimStart().length <= 2) break;
    body.push(line);
  }
  return body.join("\n");
}

/** The body of the named step: from its entry to the next step entry of any kind. */
function stepOf(job: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = job.indexOf(marker);
  assert.ok(start !== -1, `expected the named step ${name}`);
  const after = job.slice(start + 1);
  const nextStep = after.search(/^      - /m);
  return nextStep === -1 ? after : after.slice(0, nextStep);
}

test("alpha workflow triggers cover pull requests, main pushes, and manual dispatch", () => {
  const source = readAlpha();
  const on = onBlock(source);
  assert.match(on, /^  pull_request:$/m, "pull_request must be enabled and unrestricted");
  assert.match(on, /^  workflow_dispatch:$/m, "manual dispatch must be enabled");
  assert.match(on, /^  push:$/m, "push must be enabled");
  const push = on.slice(on.indexOf("  push:"));
  assert.match(push, /^    branches:$/m);
  assert.match(push, /^      - main$/m, "push must be limited to main");
  assert.doesNotMatch(source, /pull_request_target|workflow_run|schedule:/,
    "no alternate trigger path may reach the alpha matrix");
});

test("alpha workflow keeps least-privilege read-only permissions", () => {
  const source = readAlpha();
  assert.match(source, /^permissions:\n  contents: read$/m, "the root permission must stay read-only");
  assert.equal((source.match(/^permissions:/gm) ?? []).length, 1,
    "no job may carry its own permissions block");
  assert.doesNotMatch(source, /contents:\s*write|packages:|id-token|deployments|secrets:\s*inherit/,
    "no write-scoped permission or inherited secret is allowed");
});

test("alpha concurrency groups never collide across event types or distinct PRs", () => {
  const source = readAlpha();
  const concurrency = source.slice(source.indexOf("concurrency:"), source.indexOf("\njobs:"));
  assert.match(concurrency,
    /group: session-host-alpha-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/,
    "groups must be separated by event type and keyed by PR number for pull requests, falling back to the commit SHA");
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.doesNotMatch(source, /cancel-in-progress: *true/, "cancellation must stay limited to pull_request events");
  assert.doesNotMatch(concurrency, /github\.head_ref/, "grouping by head branch name lets same-named fork branches cancel each other's runs");
});

test("every alpha action is pinned to an immutable commit SHA matching ci.yml", () => {
  const source = readAlpha();
  const uses = [...source.matchAll(/uses: (\S+?@([0-9a-f]{40}))(?:\s+#\s*(\S+))?/g)]
    .map((match) => [match[1], match[3] ?? ""] as const);
  assert.ok(uses.length >= 2, "expected pinned checkout and setup-node");
  for (const [reference, comment] of uses) {
    assert.match(reference, /^[^@]+@[0-9a-f]{40}$/, `not an immutable SHA pin: ${reference}`);
    assert.match(comment, /^v\d/, `missing human version comment for ${reference}`);
  }
  const alphaPins = pinnedActions(source);
  const ciPins = pinnedActions(readCi());
  for (const reference of alphaPins) {
    assert.ok(ciPins.has(reference), `${reference} must match a SHA pinned in ci.yml`);
  }
  const ciCheckout = [...ciPins].find((pin) => pin.startsWith("actions/checkout@"));
  const ciSetupNode = [...ciPins].find((pin) => pin.startsWith("actions/setup-node@"));
  assert.ok(ciCheckout && alphaPins.has(ciCheckout), "checkout must use the exact ci.yml pin");
  assert.ok(ciSetupNode && alphaPins.has(ciSetupNode), "setup-node must use the exact ci.yml pin");
  assert.doesNotMatch(source, /uses: \S+@v\d/, "no floating version tags are allowed");
});

test("alpha matrix runs windows-latest on both supported Node lines", () => {
  const job = jobBlock(readAlpha());
  assert.match(job, /runs-on: windows-latest/, "the acceptance needs a genuinely native Windows runner");
  assert.match(job, /node-version: \[22\.19\.0, 24\.x\]/, "both supported Node lines stay in the matrix");
  assert.match(job, /fail-fast: false/);
});

test("alpha runtime is bounded by independent job and step timeouts", () => {
  const source = readAlpha();
  const job = jobBlock(source);
  const jobCap = job.match(/^    timeout-minutes: (\d+)\s*$/m);
  assert.ok(jobCap, "the acceptance job must carry an active, job-scoped cap");
  assert.ok(Number(jobCap![1]) <= 30, "the job cap must stay finite and bounded");
  const mainStep = stepOf(job, "Real public Windows ConPTY Main acceptance (opt-in, fail-closed)");
  const stepCap = mainStep.match(/^        timeout-minutes: (\d+)\s*$/m);
  assert.ok(stepCap, "the opt-in Main acceptance step must carry its own active cap");
  assert.ok(Number(stepCap![1]) <= 10, "the Main acceptance step cap must stay below the job budget");
  assert.doesNotMatch(source, /continue-on-error/, "no step may tolerate failure: missing prerequisites fail loudly");
});

test("alpha workflow publishes nothing and merges nothing", () => {
  const source = readAlpha();
  assert.doesNotMatch(source, /gh (release|pr merge|workflow run|repo deploy)/,
    "the alpha matrix must not publish, merge, or trigger other workflows");
  assert.doesNotMatch(source, /workflows:\s*write/, "no workflow write grant");
});

test("alpha job runs on every enforced trigger path with no hidden skip", () => {
  const source = readAlpha();
  assert.doesNotMatch(source, /^ *if:/m,
    "no job or step condition may skip an enforced trigger path or a missing prerequisite");
});

test("alpha roots are fresh exclusive runner-temp children, never cleaned or replaced", () => {
  const source = readAlpha();
  assert.match(source, /node scripts\/ci\/session-host-windows-acceptance\.cjs create-root \$env:RUNNER_TEMP/,
    "the alpha roots must be allocated as unique fresh children of RUNNER_TEMP by the acceptance helper");
  assert.doesNotMatch(source, /CreateTempSubdirectory/,
    "the .NET CreateTempSubdirectory string overload takes a name prefix, not a parent path; do not regress to it");
  assert.match(source, /if \(\[string\]::IsNullOrEmpty\(\$alpha\) -or -not \[System\.IO\.Path\]::IsPathRooted\(\$alpha\)\) \{ throw/,
    "a missing or non-absolute allocation must fail the step, not fall back to a relative path");
  assert.doesNotMatch(source, /Remove-Item[\s\S]{0,80}-Recurse|rm -rf/,
    "no recursive cleanup or existing-tree replacement is allowed");
});

const ACCEPTANCE_HELPER = join(projectRoot, "scripts", "ci", "session-host-windows-acceptance.cjs");

// Explicitly named synthetic fixture root under the ignored own-root
// node_modules subtree. The backing chain is validated without following
// links, each invocation allocates a fresh exclusive parent, and everything
// created below it is retained: no default temp allocation, no recursive
// deletion, no cleanup at all.
const FIXTURE_REL_PATH = "node_modules/.prg-alpha-workflow-fixtures";

function fixtureRoot(): string {
  return ensureIgnoredFixtureRoot(projectRoot, FIXTURE_REL_PATH);
}

function allocateRoot(parent: string): string {
  return execFileSync(process.execPath, [ACCEPTANCE_HELPER, "create-root", parent], { encoding: "utf8" }).trim();
}

test("create-root allocates distinct exclusive children under the supplied parent", () => {
  // A fresh exclusive parent per invocation: O_EXCL mkdtemp cannot be
  // prepopulated, so no sentinel or child can pre-exist.
  const parent = allocateRoot(fixtureRoot());
  const preExisting = join(parent, "pre-existing.txt");
  writeFileSync(preExisting, "keep", { flag: "wx" });
  const first = allocateRoot(parent);
  const second = allocateRoot(parent);
  assert.notEqual(first, second, "each allocation must be a distinct fresh root");
  for (const root of [first, second]) {
    assert.ok(isAbsolute(root), "the allocated root must be absolute");
    const rel = relative(parent, root);
    assert.match(rel, new RegExp(`^session-host-alpha-[A-Za-z0-9]+$`),
      "the root must be a direct child of the supplied parent");
    assert.ok(lstatSync(root).isDirectory(), "the allocated root must be a real directory");
  }
  assert.equal(readFileSync(preExisting, "utf8"), "keep", "existing parent content must survive untouched");
  assert.ok(readdirSync(parent).includes("pre-existing.txt"), "the parent keeps its pre-existing entries");
  assert.ok(existsSync(first) && existsSync(second),
    "allocated fixture roots are retained under the ignored own-root subtree, never cleaned up");
});

test("create-root fails closed when the parent is missing", () => {
  const missing = join(fixtureRoot(), "missing-parent");
  assert.throws(() => allocateRoot(missing), /cannot stat parent directory/,
    "a missing parent must fail the allocation, not create it implicitly");
});

test("fixture allocation refuses a prepopulated symlink without modifying it or its target", () => {
  // The link and its target live inside a fresh validated fixture parent so
  // a pre-existing node_modules redirect cannot move these writes.
  const parent = allocateRoot(fixtureRoot());
  const linkPath = join(parent, "backing-link");
  const linkRelPath = relative(projectRoot, linkPath).replaceAll("\\", "/");
  const target = join(parent, "target");
  // Plant (and retain) a symlink where a fixture backing component would be.
  mkdirSync(target);
  writeFileSync(join(target, "sentinel.txt"), "keep", { flag: "wx" });
  symlinkSync(target, linkPath, "junction");
  const before = lstatSync(linkPath, { bigint: true });
  assert.throws(() => ensureIgnoredFixtureRoot(projectRoot, linkRelPath),
    /refusing symlinked or non-directory fixture backing path/,
    "a symlinked backing component must fail closed instead of redirecting creation");
  const after = lstatSync(linkPath, { bigint: true });
  assert.equal(after.dev, before.dev, "the planted link must remain in place");
  assert.equal(after.ino, before.ino, "the planted link must remain in place");
  assert.equal(readFileSync(join(target, "sentinel.txt"), "utf8"), "keep",
    "the link target must survive untouched");
});

test("fixture allocation rejects a replaced backing ancestor without cleanup or sentinel modification", () => {
  // A fresh exclusive ancestor per invocation keeps the test re-runnable on
  // top of retained fixtures.
  const ancestorRoot = allocateRoot(ensureIgnoredFixtureRoot(projectRoot, "node_modules/.prg-alpha-ancestor"));
  writeFileSync(join(ancestorRoot, "sentinel.txt"), "keep", { flag: "wx" });
  const relPath = relative(projectRoot, join(ancestorRoot, "a")).replaceAll("\\", "/");
  // Replace the validated ancestor with a different real directory while the
  // helper creates the next component; the receipt chain must reject it.
  const fsReal = require("node:fs") as typeof import("node:fs");
  const realMkdirSync = fsReal.mkdirSync;
  fsReal.mkdirSync = ((p: string) => {
    if (p === join(ancestorRoot, "a")) {
      renameSync(ancestorRoot, `${ancestorRoot}-moved`);
      realMkdirSync(ancestorRoot);
    }
    return realMkdirSync(p);
  }) as typeof realMkdirSync;
  try {
    assert.throws(() => ensureIgnoredFixtureRoot(projectRoot, relPath),
      /fixture backing directory was replaced/,
      "a replaced backing ancestor must fail closed instead of being followed");
  } finally {
    fsReal.mkdirSync = realMkdirSync;
  }
  assert.equal(readFileSync(join(`${ancestorRoot}-moved`, "sentinel.txt"), "utf8"), "keep",
    "the sentinel in the moved original must survive untouched");
  assert.ok(existsSync(ancestorRoot), "the replacing directory must be retained, not cleaned up");
});

test("alpha installs the locked Pi UI runtime with real exit propagation", () => {
  const job = jobBlock(readAlpha());
  const install = stepOf(job, "Install pinned Pi UI runtime (fresh runner-temp root)");
  assert.match(install, /Copy-Item scripts\/ci\/pi-ui-runtime\/package\.json, scripts\/ci\/pi-ui-runtime\/package-lock\.json/,
    "the native install must use the canonical locked manifest");
  assert.match(install, /npm ci --ignore-scripts --no-audit --no-fund/,
    "the runtime install must be a lockfile-exact ci with no lifecycle scripts");
  assert.match(install, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/,
    "the npm ci exit code must propagate for real");
  const manifest = JSON.parse(readFileSync(join(projectRoot, "scripts", "ci", "pi-ui-runtime", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], "1.0.4",
    "the UI runtime must be pinned to exact Pi 1.0.4 in the canonical manifest");
  const lock = JSON.parse(readFileSync(join(projectRoot, "scripts", "ci", "pi-ui-runtime", "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version, "1.0.4",
    "the lock must freeze exact Pi 1.0.4, not a drifted version");
});

test("alpha root dependency install is lockfile-exact, script-free, and bounded", () => {
  const job = jobBlock(readAlpha());
  const install = stepOf(job, "Install dependencies");
  assert.match(install, /^        timeout-minutes: \d+\s*$/m,
    "the root install must carry its own active step cap");
  assert.match(install, /npm ci --ignore-scripts/,
    "the root install must be lockfile-exact with no lifecycle scripts");
  assert.match(install, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/,
    "the npm ci exit code must propagate for real");
});

test("alpha check name is stable without claiming configured branch settings", () => {
  const source = readAlpha();
  assert.doesNotMatch(source, /do not rename without updating branch settings|no required-check branch setting is configured today/i,
    "the workflow must not guess externally configured branch-protection state");
  assert.match(source, /workflow does not configure branch protection/,
    "the check-name comment describes this workflow's bounded authority, not external settings");
  assert.match(source, /name: Windows session host alpha \(Node \$\{\{ matrix\.node-version \}\}\)/,
    "both matrix instances retain the stable check-name contract");
});

test("alpha exports the pinned agent, canonical JS CLI, and staged candidate entry", () => {
  const job = jobBlock(readAlpha());
  const exportStep = stepOf(job, "Export pinned Pi runtime and staged candidate pins");
  assert.match(exportStep, /Join-Path \$env:PRG_ALPHA_PI_RUNTIME "node_modules\\@earendil-works\\pi-coding-agent"/,
    "the installed agent root must be the locked package directory");
  assert.match(exportStep, /Join-Path \$agent "dist\\bundle\\cli\.js"/,
    "the CLI pin must be the installed package's canonical readable JS entry");
  assert.match(exportStep, /PI_REVIEW_GATE_INSTALLED_AGENT=\$agent/,
    "the harness must receive the explicit installed agent root");
  assert.match(exportStep, /PI_REVIEW_GATE_INSTALLED_PI_BIN=\$cli/,
    "the harness must receive the canonical CLI pin");
  assert.match(exportStep, /PI_REVIEW_GATE_EXPECT_PI_VERSION=1\.0\.4/,
    "the acceptance must assert exact Pi 1.0.4");
  assert.match(exportStep, /Join-Path \$env:PRG_ALPHA_CANDIDATE "dist\\src\\index\.js"/,
    "the candidate entry must be the staged scratch build");
  assert.match(exportStep, /PI_REVIEW_GATE_CANDIDATE_ENTRY=\$entry/,
    "the harness must receive the staged candidate entry");
});

test("alpha stages the candidate in fresh scratch without live dist or dependency links", () => {
  const job = jobBlock(readAlpha());
  const compile = stepOf(job, "Compile candidate extension into fresh scratch (never live dist)");
  assert.match(compile, /npx tsc -p tsconfig\.json --outDir "\$env:PRG_ALPHA_CANDIDATE\\dist"/,
    "the candidate must be compiled into the fresh runner-temp scratch root");
  const scripts = stepOf(job, "Copy packaged scripts into fresh candidate (bounded copier)");
  assert.match(scripts, /node scripts\/ci\/session-host-windows-acceptance\.cjs copy-scripts scripts "\$env:PRG_ALPHA_CANDIDATE\\scripts"/,
    "the packaged scripts must be copied by the bounded copier");
  assert.ok(existsSync(join(projectRoot, "scripts", "ci", "session-host-windows-acceptance.cjs")),
    "the bounded copier must exist in the repository");
  const source = readAlpha();
  assert.doesNotMatch(source, /ln -sfn|SymbolicLink/,
    "no node_modules or scripts symlink may stand in for the staged candidate tree");
});

test("alpha compiles tests directly and runs only explicit focused test files", () => {
  const job = jobBlock(readAlpha());
  const build = stepOf(job, "Compile test bundle (direct tsc, no clean)");
  assert.match(build, /npx tsc -p tsconfig\.test\.json/,
    "the test bundle must compile directly from tsconfig.test.json");
  assert.doesNotMatch(build, /clean:test|build:test/, "no clean step may precede the direct compile");

  const components = stepOf(job, "Named-pipe broker/reporter/protocol component tests");
  assert.match(components, /node --test dist-test\/tests\/session-host-broker\.test\.js dist-test\/tests\/session-host-reporter\.test\.js/,
    "the named-pipe broker and reporter component tests must run as explicit compiled files");
  const helper = stepOf(job, "Pure Windows helper-contract tests");
  assert.match(helper, /node --test dist-test\/tests\/session-host-native-windows-helper-contract\.test\.js/,
    "the pure Windows helper-contract test must run as an explicit compiled file");

  const mainStep = stepOf(job, "Real public Windows ConPTY Main acceptance (opt-in, fail-closed)");
  assert.match(mainStep, /node --test dist-test\/tests\/session-host-native-windows-main\.test\.js/,
    "the opt-in real Main/ConPTY test must run as an explicit compiled file");
  assert.match(mainStep, /PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST: "1"/,
    "missing Pi/ConPTY/PowerShell prerequisites must hard-fail, never skip");

  const source = readAlpha();
  assert.doesNotMatch(source, /dist-test\/tests\/\*\.test\.js/,
    "the alpha matrix must stay focused; the broad suite glob belongs to ordinary CI");
  for (const line of source.split("\n").filter((candidate) => candidate.includes("run:"))) {
    assert.doesNotMatch(line, /npm (?:run )?test(?![\w:-])/, `unsafe test command: ${line.trim()}`);
    assert.doesNotMatch(line, /npm run build(?![\w:-])/, "CI must not rebuild live dist");
  }
});

test("alpha installs no .NET SDK or external toolchain", () => {
  const source = readAlpha();
  assert.doesNotMatch(source, /\bdotnet\b|choco install|winget install/,
    "the builtin PowerShell public Process observer needs no SDK install");
});

test("the opt-in Main test fails closed without its Windows prerequisites", () => {
  const source = readFileSync(join(projectRoot, "tests", "session-host-native-windows-main.test.ts"), "utf8");
  assert.match(source, /skip: optIn \? false : `\$\{WINDOWS_REQUIRE_ENV\}=1 is required; this is not Windows host proof`/,
    "without the opt-in env the test must skip, and the skip must say it is not Windows host proof");
  assert.match(source, /resolveWindowsRuntime\(\)/,
    "the opted-in test must resolve its pinned runtime before any harness work");
  const harness = readFileSync(join(projectRoot, "tests", "helpers", "session-host-native-windows-harness.ts"), "utf8");
  assert.match(harness, /required real Windows Main acceptance was requested on a non-Windows host/,
    "the runtime resolver must fail closed off Windows");
  assert.match(harness, /Windows native Main acceptance requires explicit staged candidate and pinned public Pi runtime env/,
    "missing pinned runtime/candidate env must fail closed after opt-in");
});
