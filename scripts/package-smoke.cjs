#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-package-smoke-"));
try {
  const cache = path.join(scratch, "npm-cache");
  // Stage the packaged inputs in scratch so the smoke never depends on (or
  // touches) the checkout's ignored live dist. CI runs test:fast before
  // test:package, which produces only dist-test; there is no production dist to
  // pack, so we compile fresh output into the staging tree below.
  const stage = path.join(scratch, "package");
  fs.mkdirSync(stage);
  for (const entry of [
    "package.json",
    "README.md",
    // Root governance docs that ship in the npm package (source-only files such as
    // AGENTS.md and .github/ are deliberately not staged or shipped).
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "LICENSES",
    "scripts",
    "skills",
    "examples",
    "docs",
  ]) {
    fs.cpSync(path.join(projectRoot, entry), path.join(stage, entry), { recursive: true });
  }

  // Build production output only into the staging tree. The --outDir override
  // keeps the checkout's dist absent or untouched; source is read from the
  // project (rootDir in tsconfig.json) and written to stage/dist.
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      path.join(projectRoot, "tsconfig.json"),
      "--outDir",
      path.join(stage, "dist"),
    ],
    { cwd: projectRoot, stdio: "pipe" },
  );

  // --ignore-scripts disables the prepack lifecycle script so packing cannot
  // clean or rebuild the live dist; the staged production output is already present.
  const packedName = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", scratch],
    {
      cwd: stage,
      env: { ...process.env, npm_config_cache: cache },
      encoding: "utf8",
    },
  ).trim().split(/\r?\n/).at(-1);
  assert.ok(packedName, "npm pack did not report a tarball");
  const tarball = path.join(scratch, packedName);
  const consumer = path.join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true}\n');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumer,
    env: { ...process.env, npm_config_cache: cache },
    stdio: "pipe",
  });
  const installed = path.join(consumer, "node_modules", "pi-review-gate");
  for (const required of [
    "dist/src/index.js",
    "scripts/pi-review-gate.sh",
    "scripts/ensure-ddgs.sh",
    "scripts/ddgs-search.py",
    "scripts/orchestrator-system-prompt.md",
    "scripts/check-docs.cjs",
    "skills/orchestrator/SKILL.md",
    "skills/orchestrator/references/recovery.md",
    "scripts/fake-reviewer.cjs",
    "LICENSES/Apache-2.0.txt",
    "NOTICE",
    // Root governance docs (required to ship in the npm package so README links
    // resolve in the installed layout).
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    // Public documentation tree (required to ship in the npm package).
    "docs/README.md",
    "docs/getting-started.md",
    "docs/configuration.md",
    "docs/review-workflow.md",
    "docs/delegated-execution.md",
    "docs/web-tools.md",
    "docs/security-model.md",
    "docs/recovery.md",
    "docs/development.md",
    "docs/troubleshooting.md",
  ]) {
    assert.ok(fs.statSync(path.join(installed, required)).isFile(), `missing packed file: ${required}`);
  }
  // Validate the installed package layout with the same deterministic docs rules
  // (links, anchors, reachability, fenced JSON, referenced paths) used in-repo.
  execFileSync(
    process.execPath,
    [path.join(projectRoot, "scripts", "check-docs.cjs"), installed],
    { stdio: "pipe" },
  );
  // Source-only governance must not leak into the installed package.
  assert.ok(
    !fs.existsSync(path.join(installed, ".github")),
    "source-only .github directory must not ship in the package",
  );
  fs.accessSync(path.join(consumer, "node_modules", ".bin", "pi-review-gate"), fs.constants.X_OK);
  process.stdout.write(`package smoke passed: ${packedName}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
