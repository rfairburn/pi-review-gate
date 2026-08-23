#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

const executable = chromium.executablePath();
if (existsSync(executable)) process.exit(0);

process.stderr.write("pi-review-gate: installing Playwright Chromium for BrowserExtract\n");
const packageRoot = dirname(require.resolve("playwright/package.json"));
const result = spawnSync(process.execPath, [join(packageRoot, "cli.js"), "install", "chromium"], {
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`pi-review-gate: Chromium installation failed: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0 || !existsSync(executable)) {
  process.stderr.write("pi-review-gate: Playwright Chromium is still unavailable after installation\n");
  process.exit(result.status || 1);
}
