import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { loadReleaseModule, projectRoot } from "./helpers/release-scripts";
import type { PackagingModule, ReleaseCommon } from "./helpers/release-scripts";

const common = loadReleaseModule<ReleaseCommon>("common.cjs");
const packaging = loadReleaseModule<PackagingModule>("packaging.cjs");

const ROOT = projectRoot();
const DEV_VERSION = "0.1.0-dev.1";

test("staged package metadata rewrites only the version fields", () => {
  const sourcePackageJson = readFileSync(join(ROOT, "package.json"), "utf8");
  const derived = JSON.parse(packaging.derivePackageJson(sourcePackageJson, DEV_VERSION));
  assert.equal(derived.version, DEV_VERSION);
  assert.equal(derived.name, "pi-review-gate");
  const source = JSON.parse(sourcePackageJson);
  assert.deepEqual(derived, { ...source, version: DEV_VERSION });

  const lock = JSON.parse(
    packaging.deriveLockfile(readFileSync(join(ROOT, "package-lock.json"), "utf8"), "pi-review-gate", DEV_VERSION),
  );
  assert.equal(lock.version, DEV_VERSION);
  assert.equal(lock.packages[""].version, DEV_VERSION);
  const sourceLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.deepEqual(lock, { ...sourceLock, version: DEV_VERSION, packages: { ...sourceLock.packages, "": { ...sourceLock.packages[""], version: DEV_VERSION } } });
});

test("provenance is deterministic (stable SHAs, no run timestamps)", () => {
  const options = {
    repository: common.REPOSITORY,
    target: "a".repeat(40),
    baseline: common.BASELINE_SHA,
    n: 3,
    tag: "b3",
    version: DEV_VERSION,
    prNumber: 12,
    prMergeCommitSha: "a".repeat(40),
    tarballFilename: "pi-review-gate-0.1.0-dev.1.tgz",
    tarballSha256: "f".repeat(64),
    tarballSize: 1234,
  };
  const first = JSON.stringify(packaging.buildProvenance(options), null, 2);
  const second = JSON.stringify(packaging.buildProvenance(options), null, 2);
  assert.equal(first, second);
  const provenance = JSON.parse(first) as Record<string, unknown>;
  assert.equal(provenance.schema, packaging.PROVENANCE_SCHEMA);
  assert.equal((provenance.source as Record<string, unknown>).sha, options.target);
  assert.equal((provenance.source as Record<string, unknown>).baseline, common.BASELINE_SHA);
  assert.equal((provenance.source as Record<string, unknown>).firstParentDistance, 3);
  assert.equal((provenance.package as Record<string, unknown>).version, DEV_VERSION);
  assert.ok(!first.toLowerCase().includes("timestamp"), "provenance must not embed run timestamps");
});

test("tarball verification rejects unexpected and secret-shaped contents", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-package-reject-"));
  try {
    const stage = join(scratch, "package");
    mkdirSync(join(stage, "dist", "src"), { recursive: true });
    writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "pi-review-gate", version: DEV_VERSION, files: ["dist/src"] }));
    writeFileSync(join(stage, "dist", "src", "index.js"), "module.exports = {};");
    const tarball = join(scratch, "bad.tgz");
    const cases: Array<[string, RegExp]> = [
      ["unexpected-entry.txt", /unexpected tarball entry/],
      [join("dist", "src", "secrets.env"), /secret-shaped file name/],
      [join("dist", "src", "notes.md"), /secret-shaped content/],
    ];
    for (const [name, pattern] of cases) {
      const filePath = join(stage, name);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(
        filePath,
        name.endsWith(".md") ? "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n" : "placeholder",
      );
      rmSync(tarball, { force: true });
      execFileSync("tar", ["-czf", tarball, "-C", stage, "."]);
      rmSync(join(stage, name), { force: true });
      assert.throws(() => packaging.verifyTarball({ tarballPath: tarball, extractDir: join(scratch, "extract") }), pattern);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("install smoke child environment strips GitHub publication tokens", () => {
  const child = packaging.installSmokeChildEnv({
    GITHUB_TOKEN: "secret-token",
    GH_TOKEN: "secret-token-2",
    GH_ENTERPRISE_TOKEN: "secret-token-3",
    GITHUB_PAT: "secret-token-4",
    PATH: "/usr/bin:/bin",
    npm_config_cache: "/tmp/cache",
    HOME: "/tmp/home",
  });
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.GH_TOKEN, undefined);
  assert.equal(child.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(child.GITHUB_PAT, undefined);
  assert.equal(child.PATH, "/usr/bin:/bin");
  assert.equal(child.npm_config_cache, "/tmp/cache");
  assert.equal(child.HOME, "/tmp/home");
});

// Recursively record path -> "<size>:<sha256>" content identity, or null when
// the directory does not exist. Used to prove staging never creates or
// modifies the checkout's live dist (presence AND content identity).
function snapshotTree(root: string): Map<string, string> | null {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return null;
  const snapshot = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, child.name);
      if (child.isDirectory()) visit(full);
      else if (child.isFile()) {
        const content = readFileSync(full);
        snapshot.set(relative(root, full), `${content.length}:${createHash("sha256").update(content).digest("hex")}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

// A cheap deterministic project root whose docs checker always succeeds, so
// entry-point-focused tests neither pay for nor depend on the real checker.
function fakeDocsProjectRoot(scratch: string): string {
  const fakeRoot = join(scratch, "fake-project");
  mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
  writeFileSync(join(fakeRoot, "scripts", "check-docs.cjs"), '"use strict";\nprocess.exit(0);\n');
  return fakeRoot;
}

function packTinyStage(scratch: string, entryPointSource: string): string {
  const stage = join(scratch, "package");
  mkdirSync(join(stage, "dist", "src"), { recursive: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({
      name: "pi-review-gate",
      version: DEV_VERSION,
      files: ["dist/src", "scripts"],
      bin: { "pi-review-gate": "scripts/pi-review-gate.sh", "pi-review-web": "scripts/pi-review-web.sh" },
    }),
  );
  writeFileSync(join(stage, "dist", "src", "index.js"), entryPointSource);
  for (const bin of ["pi-review-gate.sh", "pi-review-web.sh"]) {
    writeFileSync(join(stage, "scripts", bin), "#!/bin/sh\nexit 0\n");
  }
  return packaging.packStage({ stage, packDestination: scratch });
}

test("install smoke rejects a tarball that does not match the expected name/version", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-name-"));
  try {
    const tarball = packTinyStage(scratch, "module.exports = { activate() {} };");
    // Expecting a different version than the tarball carries must fail before
    // any child process or consumer directory is created.
    assert.throws(
      () => packaging.verifyInstalledTarball({
        tarballPath: tarball,
        scratchRoot: scratch,
        projectRoot: ROOT,
        packageName: "pi-review-gate",
        version: "0.1.0-dev.9",
      }),
      /expected pi-review-gate-0\.1\.0-dev\.9\.tgz/,
    );
    assert.ok(!statSync(join(scratch, "install-smoke"), { throwIfNoEntry: false }), "no consumer directory may be created for a mismatched tarball");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("install smoke fails closed on an artifact whose entry point is broken", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-broken-"));
  try {
    const tarball = packTinyStage(scratch, "throw new Error('broken entry');");
    assert.throws(
      () => packaging.verifyInstalledTarball({
        tarballPath: tarball,
        scratchRoot: scratch,
        projectRoot: ROOT,
        packageName: "pi-review-gate",
        version: DEV_VERSION,
      }),
      /install smoke verification failed[\s\S]*entry point/,
      "a loadable-but-broken entry point must fail the install smoke",
    );
    assert.ok(!statSync(join(scratch, "install-smoke"), { throwIfNoEntry: false }), "the scratch consumer must be cleaned up after a failed smoke");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("install smoke fails closed on an entry point that loads but does not expose activate", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-activate-"));
  try {
    const tarball = packTinyStage(scratch, "module.exports = {};");
    assert.throws(
      () => packaging.verifyInstalledTarball({
        tarballPath: tarball,
        scratchRoot: scratch,
        projectRoot: fakeDocsProjectRoot(scratch),
        packageName: "pi-review-gate",
        version: DEV_VERSION,
      }),
      /install smoke verification failed[\s\S]*does not expose activate/,
      "an entry point without activate() must fail the install smoke",
    );
    assert.ok(!statSync(join(scratch, "install-smoke"), { throwIfNoEntry: false }), "the scratch consumer must be cleaned up after a failed smoke");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A zero child exit is not success on its own: an entry point (or a dependency
// it loads) that calls process.exit(0) during module init would terminate the
// bounded child before the activate assertion and still look clean. The smoke
// requires the child's per-run success acknowledgment, which the child emits
// only after its activate check passes, so such a load is rejected and the
// scratch consumer is cleaned up.
test("install smoke rejects an entry point that exits zero during load without confirming activate", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-exit-"));
  try {
    const tarball = packTinyStage(scratch, "process.exit(0);");
    assert.throws(
      () => packaging.verifyInstalledTarball({
        tarballPath: tarball,
        scratchRoot: scratch,
        projectRoot: fakeDocsProjectRoot(scratch),
        packageName: "pi-review-gate",
        version: DEV_VERSION,
      }),
      /install smoke verification failed[\s\S]*entry point/,
      "a process.exit(0) during load must fail the install smoke even though the child exits zero",
    );
    assert.ok(!statSync(join(scratch, "install-smoke"), { throwIfNoEntry: false }), "the scratch consumer must be cleaned up after a rejected smoke");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The installed entry point must execute in a token-stripped child process,
// never via require() inside the (potentially credentialed) publisher process.
// The fixture entry point hard-fails if any GitHub publication-token variable
// is visible and writes a report of what it saw, so the old in-parent require()
// behavior (token present in this process's env) would fail the smoke, while
// the child boundary passes. The parent environment must retain its markers
// untouched: stripping is scoped to the child, never mutates the caller.
test("installed entry point runs in a token-stripped child; parent env keeps its tokens", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-entry-"));
  const tokenVars = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_PAT"];
  const marker = "synthetic-publication-token-marker";
  const reportPath = join(scratch, "entry-child-report.json");
  const previous: Record<string, string | undefined> = {};
  try {
    const entrySource = [
      '"use strict";',
      'const fs = require("node:fs");',
      `const tokenVars = ${JSON.stringify(tokenVars)};`,
      "const leaked = tokenVars.filter((name) => process.env[name] !== undefined);",
      "if (leaked.length > 0) {",
      '  throw new Error("publication tokens leaked into the entry-point child: " + leaked.join(","));',
      "}",
      "if (process.env.ENTRY_POINT_CHILD_REPORT) {",
      '  fs.writeFileSync(process.env.ENTRY_POINT_CHILD_REPORT, JSON.stringify({ tokens: Object.fromEntries(tokenVars.map((name) => [name, process.env[name] === undefined ? null : "present"])) }));',
      "}",
      "module.exports = { activate() {} };",
    ].join("\n");
    for (const name of [...tokenVars, "ENTRY_POINT_CHILD_REPORT"]) previous[name] = process.env[name];
    try {
      tokenVars.forEach((name) => { process.env[name] = marker; });
      process.env.ENTRY_POINT_CHILD_REPORT = reportPath;
      const tarball = packTinyStage(scratch, entrySource);
      packaging.verifyInstalledTarball({
        tarballPath: tarball,
        scratchRoot: scratch,
        projectRoot: fakeDocsProjectRoot(scratch),
        packageName: "pi-review-gate",
        version: DEV_VERSION,
      });
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as { tokens: Record<string, string | null> };
      for (const name of tokenVars) {
        assert.equal(report.tokens[name], null, `the entry-point child must not see ${name}`);
      }
      for (const name of tokenVars) {
        assert.equal(process.env[name], marker, `the parent environment must retain ${name} untouched`);
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A hanging entry-point load must be bounded by the child's finite timeout. The
// test injects a short timeout through the bounded test-only override instead
// of waiting any real minute-scale interval; production keeps its own finite
// default.
test("install smoke bounds a hanging entry-point load via the child timeout", { timeout: 60_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-hang-"));
  try {
    const tarball = packTinyStage(scratch, "setInterval(() => {}, 1000);\nmodule.exports = { activate() {} };");
    // Typed as a standalone variable so the test-only override survives
    // TypeScript's structural check of the declared packaging module type.
    const hangingOptions = {
      tarballPath: tarball,
      scratchRoot: scratch,
      projectRoot: fakeDocsProjectRoot(scratch),
      packageName: "pi-review-gate",
      version: DEV_VERSION,
      entryPointTimeoutMs: 2_000,
    };
    const startedAt = Date.now();
    assert.throws(
      () => packaging.verifyInstalledTarball(hangingOptions),
      /install smoke verification failed[\s\S]*entry point failed to load/,
      "a hanging entry-point load must fail the install smoke when the child timeout fires",
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 30_000, `the hanging load must be bounded well below a minute (took ${elapsed}ms)`);
    assert.ok(!statSync(join(scratch, "install-smoke"), { throwIfNoEntry: false }), "the scratch consumer must be cleaned up after a timed-out load");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The docs-check child must be spawned with the same token-stripped environment
// as the npm child. A fake project root whose checker reports its ACTUAL spawn
// environment proves the real subprocess invocation is sanitized, not just the
// filtering helper.
test("install smoke docs-check subprocess receives no GitHub publication tokens", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-smoke-env-"));
  const tokenVars = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_PAT"];
  const previous: Record<string, string | undefined> = {};
  try {
    const fakeRoot = join(scratch, "fake-project");
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
    const reportPath = join(scratch, "check-docs-env-report.json");
    writeFileSync(
      join(fakeRoot, "scripts", "check-docs.cjs"),
      [
        '"use strict";',
        'const fs = require("node:fs");',
        "const reportPath = process.env.CHECK_DOCS_ENV_REPORT;",
        "if (reportPath) {",
        `  const tokenVars = ${JSON.stringify(tokenVars)};`,
        "  fs.writeFileSync(reportPath, JSON.stringify({",
        "    tokens: Object.fromEntries(tokenVars.map((name) => [name, process.env[name] === undefined ? null : \"present\"])),",
        "    hasPath: Boolean(process.env.PATH),",
        "  }));",
        "}",
        "process.exit(0);",
      ].join("\n"),
    );
    for (const name of [...tokenVars, "CHECK_DOCS_ENV_REPORT"]) previous[name] = process.env[name];
    try {
      tokenVars.forEach((name, index) => { process.env[name] = `secret-${index}`; });
      process.env.CHECK_DOCS_ENV_REPORT = reportPath;
      const tarball = packTinyStage(scratch, "module.exports = { activate() {} };");
      packaging.verifyInstalledTarball({
        tarballPath: tarball,
        scratchRoot: scratch,
        projectRoot: fakeRoot,
        packageName: "pi-review-gate",
        version: DEV_VERSION,
      });
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as { tokens: Record<string, string | null>; hasPath: boolean };
      for (const name of tokenVars) {
        assert.equal(report.tokens[name], null, `the docs-check child must not receive ${name}`);
      }
      assert.equal(report.hasPath, true, "the sanitized environment must keep PATH so the checker can run");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Structural pin: every subprocess the install smoke spawns must be created with
// the token-stripped environment (covers the npm install, the entry-point child
// that loads the installed code, and the docs-check calls).
test("every install-smoke subprocess invocation uses the token-stripped environment", () => {
  const source = readFileSync(join(ROOT, "scripts", "release", "packaging.cjs"), "utf8");
  const start = source.indexOf("function verifyInstalledTarball(");
  assert.notEqual(start, -1, "verifyInstalledTarball must exist in packaging.cjs");
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  const callSites = body.match(/execFileSync\(/g) ?? [];
  assert.ok(callSites.length >= 3, "the install smoke must spawn the npm install, entry-point child, and docs-check subprocesses");
  const sanitizedEnvs = body.match(/installSmokeChildEnv\(process\.env\)/g) ?? [];
  assert.equal(
    sanitizedEnvs.length,
    callSites.length,
    "every install-smoke subprocess must be spawned with the token-stripped environment",
  );
});

test("the real staged tarball packs, verifies, installs, and exposes the dev version and entry points", { timeout: 300_000 }, () => {
  // Snapshot the live dist BEFORE staging: the build must neither create nor
  // modify it, whether or not a dist already exists in the checkout.
  const distSnapshot = snapshotTree(join(ROOT, "dist"));
  const scratch = mkdtempSync(join(tmpdir(), "release-package-e2e-"));
  try {
    const stage = packaging.stagePackage({ projectRoot: ROOT, stageRoot: scratch, version: DEV_VERSION });
    // The staged package.json carries the dev version; the checkout is untouched.
    assert.equal(JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).version, DEV_VERSION);
    const sourceVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
    assert.equal(sourceVersion, "0.1.0");
    assert.deepEqual(
      snapshotTree(join(ROOT, "dist")),
      distSnapshot,
      "staging must neither create nor modify the checkout's live dist",
    );

    const tarballPath = packaging.packStage({ stage, packDestination: scratch });
    const { entries } = packaging.verifyTarball({ tarballPath, extractDir: join(scratch, "extract") });
    for (const required of [
      "dist/src/index.js",
      "scripts/pi-review-gate.sh",
      "scripts/pi-review-web.sh",
      "skills/orchestrator/SKILL.md",
      "docs/releases.md",
      "README.md",
      "LICENSE",
    ]) {
      assert.ok(entries.includes(required), `tarball missing ${required}`);
    }
    assert.ok(!entries.some((entry) => entry.startsWith("dist-test/") || entry.includes("node_modules")));

    // Install the ACTUAL generated tarball into a scratch consumer and verify
    // exact identity (name/version), a loadable compiled entry point exposing
    // `activate`, linked bins, and shipped docs validated with the checkout's
    // own docs checker — the same bounded gate the production publisher runs
    // before any publication.
    packaging.verifyInstalledTarball({
      tarballPath,
      scratchRoot: scratch,
      projectRoot: ROOT,
      packageName: "pi-review-gate",
      version: DEV_VERSION,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
