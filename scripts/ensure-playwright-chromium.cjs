#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

// Keep these in sync with PLAYWRIGHT_CHROMIUM_SKIP_ENV and
// PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND in src/web/browser.ts; this script runs
// pre-build during postinstall, so the values cannot be imported from src.
const SKIP_CHROMIUM_ENV = "PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM";
const INSTALL_COMMAND = "npx playwright install chromium";

/**
 * Ensure Chromium when package installation is allowed to provision it.
 *
 * The dependency hooks make the normal install path easy to exercise without
 * downloading a browser: callers can provide all side effects as options.
 * Provisioning is deliberately best-effort because BrowserExtract is an
 * optional tool and must not make the core package impossible to install.
 */
function ensurePlaywrightChromium(options = {}) {
  const env = options.env || process.env;
  const write = options.write || ((message) => process.stderr.write(message));

  if (isTruthy(env[SKIP_CHROMIUM_ENV])) {
    write(
      `pi-review-gate: skipping Playwright Chromium provisioning because ${SKIP_CHROMIUM_ENV} is set; `
      + `BrowserExtract requires Chromium to be installed separately if it is not already available (for example, with \`${INSTALL_COMMAND}\`).\n`,
    );
    return { status: "skipped" };
  }

  const exists = options.exists || existsSync;
  let executable = options.executablePath;
  try {
    executable = executable || (options.chromium || require("playwright").chromium).executablePath();
    if (exists(executable)) return { status: "present", executablePath: executable };
  } catch (error) {
    return reportFailure(write, executable, `could not inspect the Playwright browser: ${messageOf(error)}`);
  }

  write("pi-review-gate: installing Playwright Chromium for BrowserExtract\n");
  let result;
  try {
    result = options.install ? options.install() : installChromium();
  } catch (error) {
    return reportFailure(write, executable, `the installer could not start: ${messageOf(error)}`);
  }
  if (result && result.error) {
    return reportFailure(write, executable, `the installer could not start: ${messageOf(result.error)}`);
  }
  if (!result || (result.status === null && !result.signal) || result.status === undefined) {
    return reportFailure(write, executable, "the installer exited with an unknown result");
  }
  if (result.status !== 0) {
    return reportFailure(
      write,
      executable,
      result.signal
        ? `the installer was terminated by ${result.signal}`
        : `the installer exited with status ${result.status}`,
    );
  }
  if (!executable || !exists(executable)) {
    return reportFailure(write, executable, "the installer completed, but the browser executable is still unavailable");
  }
  return { status: "installed", executablePath: executable };
}

function installChromium() {
  const packageRoot = dirname(require.resolve("playwright/package.json"));
  return spawnSync(process.execPath, [join(packageRoot, "cli.js"), "install", "chromium"], {
    stdio: "inherit",
  });
}

function reportFailure(write, executable, reason) {
  const expectedPath = executable ? ` Expected executable: ${executable}.` : "";
  write(
    `pi-review-gate: warning: Playwright Chromium is unavailable because ${reason}.${expectedPath} `
    + "Package installation will continue; BrowserExtract will report setup guidance when invoked. "
    + `Install it later with \`${INSTALL_COMMAND}\`.\n`,
  );
  return { status: "failed", ...(executable ? { executablePath: executable } : {}), reason };
}

function isTruthy(value) {
  if (value === undefined || value === null) return false;
  return !new Set(["", "0", "false", "no", "off"]).has(String(value).trim().toLowerCase());
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  INSTALL_COMMAND,
  SKIP_CHROMIUM_ENV,
  ensurePlaywrightChromium,
  isTruthy,
};

if (require.main === module) ensurePlaywrightChromium();
