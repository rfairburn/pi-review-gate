import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

type InstallResult = { status: number | null; signal?: NodeJS.Signals | null; error?: unknown };
type EnsureOptions = {
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  exists?: (path: string) => boolean;
  install?: () => InstallResult;
  write?: (message: string) => void;
};
type EnsureModule = {
  SKIP_CHROMIUM_ENV: string;
  ensurePlaywrightChromium(options?: EnsureOptions): { status: string; reason?: string };
};

const setup = require(join(__dirname, "..", "..", "scripts", "ensure-playwright-chromium.cjs")) as EnsureModule;

test("postinstall skip avoids browser provisioning and explains the deferred setup", () => {
  const messages: string[] = [];
  const result = setup.ensurePlaywrightChromium({
    env: { [setup.SKIP_CHROMIUM_ENV]: "1" },
    exists: () => false,
    install: () => {
      throw new Error("install should not be called when provisioning is skipped");
    },
    write: (message) => messages.push(message),
  });

  assert.equal(result.status, "skipped");
  assert.match(messages.join(""), new RegExp(`skipping.*${setup.SKIP_CHROMIUM_ENV}`));
  assert.match(messages.join(""), /BrowserExtract requires Chromium to be installed separately/);
});

test("postinstall leaves an already-installed browser untouched", () => {
  let installCalls = 0;
  const result = setup.ensurePlaywrightChromium({
    env: {},
    executablePath: "/fake/playwright/chromium",
    exists: () => true,
    install: () => {
      installCalls += 1;
      return { status: 0 };
    },
    write: () => undefined,
  });

  assert.equal(result.status, "present");
  assert.equal(installCalls, 0);
});

test("postinstall reports success after the installer provisions the browser", () => {
  let available = false;
  let installCalls = 0;
  const result = setup.ensurePlaywrightChromium({
    env: {},
    executablePath: "/fake/playwright/chromium",
    exists: () => available,
    install: () => {
      installCalls += 1;
      available = true;
      return { status: 0 };
    },
    write: () => undefined,
  });

  assert.equal(result.status, "installed");
  assert.equal(installCalls, 1);
});

test("postinstall reports the signal when the installer is killed", () => {
  const messages: string[] = [];
  const result = setup.ensurePlaywrightChromium({
    env: {},
    executablePath: "/fake/playwright/chromium",
    exists: () => false,
    install: () => ({ status: null, signal: "SIGKILL" }),
    write: (message) => messages.push(message),
  });

  assert.equal(result.status, "failed");
  assert.match(messages.join(""), /warning: Playwright Chromium is unavailable/);
  assert.match(messages.join(""), /terminated by SIGKILL/);
  assert.match(messages.join(""), /Package installation will continue/);
});

test("postinstall warns and succeeds when browser installation fails", () => {
  const messages: string[] = [];
  const result = setup.ensurePlaywrightChromium({
    env: {},
    executablePath: "/fake/playwright/chromium",
    exists: () => false,
    install: () => ({ status: 1 }),
    write: (message) => messages.push(message),
  });

  assert.equal(result.status, "failed");
  assert.match(messages.join(""), /warning: Playwright Chromium is unavailable/);
  assert.match(messages.join(""), /Package installation will continue/);
  assert.match(messages.join(""), /npx playwright install chromium/);
});
