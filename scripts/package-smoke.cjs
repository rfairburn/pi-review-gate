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
  const packedName = execFileSync("npm", ["pack", "--silent", "--pack-destination", scratch], {
    cwd: projectRoot,
    env: { ...process.env, npm_config_cache: cache },
    encoding: "utf8",
  }).trim().split(/\r?\n/).at(-1);
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
    "scripts/orchestrator-system-prompt.md",
    "scripts/fake-reviewer.cjs",
  ]) {
    assert.ok(fs.statSync(path.join(installed, required)).isFile(), `missing packed file: ${required}`);
  }
  fs.accessSync(path.join(consumer, "node_modules", ".bin", "pi-review-gate"), fs.constants.X_OK);
  process.stdout.write(`package smoke passed: ${packedName}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
