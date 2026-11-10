#!/usr/bin/env node
/**
 * Run the focused Android instrumented checks against one already-booted,
 * explicitly named owned emulator. This script never boots, stops, or enumerates
 * devices without a serial, never uses a default ADB target, and never touches
 * an AVD outside the two owned review-gate fixtures.
 *
 * It also starts and stops the synthetic peer fixture it owns. A failure prints
 * the exact phase and exits nonzero; a passing run prints one SUITE_RESULT line.
 */

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const PACKAGE = "io.github.rfairburn.pireviewgate";
const TEST_PACKAGE = `${PACKAGE}.test`;
const RUNNER = `${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;
const ALLOWED_AVDS = new Set(["PiReviewGateAndroid13", "PiReviewGateAndroid17"]);
const CLIENT_LABEL = "android-fixture-phone";
const FIXTURE = path.join(ROOT, "dist-test/tests/android-peer-fixture/fixture.js");
const DEFAULT_APP_APK = path.join(ROOT, "android/app/build/outputs/apk/debug/app-debug.apk");
const DEFAULT_TEST_APK = path.join(
  ROOT,
  "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
);
let activeSerial = null;

function usage() {
  process.stderr.write(
    "usage: node tests/android-peer-fixture/run-api-suite.cjs --serial <emulator-serial> "
      + "[--api 33|37] [--app-apk <path>] [--test-apk <path>] [--skip-install]\n",
  );
}

function parseArgs(argv) {
  const options = { api: "unknown", skipInstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--serial") {
      options.serial = value;
      index += 1;
    } else if (arg === "--api") {
      options.api = value;
      index += 1;
    } else if (arg === "--app-apk") {
      options.appApk = value;
      index += 1;
    } else if (arg === "--test-apk") {
      options.testApk = value;
      index += 1;
    } else if (arg === "--skip-install") {
      options.skipInstall = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  options.appApk = options.appApk ?? DEFAULT_APP_APK;
  options.testApk = options.testApk ?? DEFAULT_TEST_APK;
  if (!options.serial || !/^emulator-[0-9]+$/.test(options.serial)) {
    throw new Error("--serial must be the exact owned emulator serial (emulator-<port>)");
  }
  return options;
}

function adb(serial, args, timeout = 120_000) {
  const result = spawnSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function checked(label, result) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (status ${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function printLogcatDiagnostics(serial) {
  if (!serial) return;
  const result = spawnSync("adb", ["-s", serial, "logcat", "-d", "-v", "brief"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const pattern = /CryptoUpcalls|NONEwithECDSA|Incompatible digest|KeyStoreException|PeerTransportException|keystore2|NativeCrypto/;
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split(/\r?\n/)
    .filter((line) => pattern.test(line))
    .slice(-200);
  if (lines.length > 0) {
    process.stdout.write(`--- logcat-diagnostics ---\n${lines.join("\n")}\n`);
  }
}

function verifyOwnedEmulator(serial) {
  const state = checked("adb get-state", adb(serial, ["get-state"], 20_000)).stdout.trim();
  if (state !== "device") throw new Error(`ADB target ${serial} is not in device state`);
  const qemu = checked("adb getprop ro.kernel.qemu", adb(serial, ["shell", "getprop", "ro.kernel.qemu"], 20_000))
    .stdout.trim();
  if (qemu !== "1") throw new Error(`ADB target ${serial} is not an emulator`);
  const avdOutput = checked("adb emu avd name", adb(serial, ["emu", "avd", "name"], 20_000)).stdout;
  const avdName = avdOutput.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "OK");
  if (!avdName || !ALLOWED_AVDS.has(avdName)) {
    throw new Error(`ADB target ${serial} is not an owned review-gate AVD (reported: ${avdName ?? "unknown"})`);
  }
  return avdName;
}

function runInstrumentation(serial, classNames, extras, phase) {
  const args = ["shell", "am", "instrument", "-w", "-r", "-e", "class", classNames.join(",")];
  for (const [key, value] of Object.entries(extras)) {
    args.push("-e", key, String(value));
  }
  args.push(RUNNER);
  const result = adb(serial, args, 300_000);
  const output = `${result.stdout}\n${result.stderr}`;
  process.stdout.write(`--- ${phase} ---\n${output}\n`);
  if (
    result.status !== 0 ||
    /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -2/.test(output) ||
    !/\bOK \(/.test(output)
  ) {
    throw new Error(`${phase} instrumentation did not report a passing run`);
  }
  return output;
}

function fixturePath() {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(
      "fixture build is missing; build tests/android-peer-fixture/tsconfig.json into dist-test first",
    );
  }
  return FIXTURE;
}

function startFixture(mode, clientKeyId) {
  const child = spawn(
    process.execPath,
    [fixturePath(), "--mode", mode, "--client-key-id", clientKeyId, "--client-label", CLIENT_LABEL],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = [];
  let buffer = "";
  let wake = null;
  let stderr = "";
  child.stdout.on("data", (data) => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      try {
        lines.push(JSON.parse(buffer.slice(0, index)));
      } catch {
        // A non-JSON line is not part of the fixture protocol.
      }
      buffer = buffer.slice(index + 1);
      wake?.();
      wake = null;
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const nextLine = async (label) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const line = lines.shift();
      if (line !== undefined) return line;
      if (Date.now() >= deadline) throw new Error(`fixture did not emit ${label}: ${stderr}`);
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 250);
      });
    }
  };
  return {
    child,
    nextLine,
    async stop() {
      if (child.exitCode === null) child.stdin.write("report\n");
      const report = await nextLine("report");
      await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", resolve);
        setTimeout(resolve, 20_000);
      });
      return { report, exitCode: child.exitCode };
    },
    kill() {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

async function withFixture(mode, clientKeyId, body) {
  const fixture = startFixture(mode, clientKeyId);
  let phaseError = null;
  try {
    const ready = await fixture.nextLine("ready");
    process.stdout.write(`FIXTURE_READY ${JSON.stringify(ready)}\n`);
    await body(ready);
  } catch (error) {
    phaseError = error;
  }
  let report = null;
  try {
    const stopped = await fixture.stop();
    report = stopped.report;
    process.stdout.write(`FIXTURE_REPORT ${JSON.stringify(report)}\n`);
    if (!report.ok) phaseError = phaseError ?? new Error(`fixture invariants failed: ${report.problems.join("; ")}`);
    if (stopped.exitCode !== 0) phaseError = phaseError ?? new Error(`fixture exited ${stopped.exitCode}`);
  } catch (error) {
    fixture.kill();
    phaseError = phaseError ?? error;
  }
  if (phaseError) throw phaseError;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const avdName = verifyOwnedEmulator(options.serial);
  // Diagnostics may target only an emulator whose owned-AVD identity was
  // verified. A rejected or unknown serial must never reach the adb logcat path.
  activeSerial = options.serial;
  process.stdout.write(`OWNED_AVD ${avdName} API ${options.api}\n`);

  if (!options.skipInstall) {
    checked("install app APK", adb(options.serial, ["install", "-r", "-t", options.appApk], 300_000));
    checked("install test APK", adb(options.serial, ["install", "-r", "-t", options.testApk], 300_000));
  }

  // The API 37 local-network permission is exercised only on the owned fixture
  // app. This is explicitly a pre-granted fixture setup, not a native prompt test.
  const grant = adb(options.serial, [
    "shell",
    "pm",
    "grant",
    PACKAGE,
    "android.permission.ACCESS_LOCAL_NETWORK",
  ], 30_000);
  process.stdout.write(`LOCAL_NETWORK_PERMISSION ${grant.status === 0 ? "PREGRANTED" : "NOT_PREGRANTED"}\n`);

  checked("force-stop target app", adb(options.serial, ["shell", "am", "force-stop", PACKAGE], 30_000));

  const nonce = `api${options.api}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  let phaseError = null;
  try {
    runInstrumentation(
      options.serial,
      [
        "io.github.rfairburn.pireviewgate.androidtest.AndroidPrivateStorageLifecycleTest",
        "io.github.rfairburn.pireviewgate.androidtest.AndroidKeyStorePeerIdentityTest",
      ],
      { fixtureNonce: nonce },
      "storage-identity",
    );

    const setup = runInstrumentation(
      options.serial,
      ["io.github.rfairburn.pireviewgate.androidtest.AndroidFixtureIdentitySetupTest"],
      { fixtureNonce: nonce },
      "identity-setup",
    );
    const match = setup.match(/INSTRUMENTATION_STATUS: fixtureClientKeyId=(.+)/);
    if (!match) throw new Error("identity setup did not report fixtureClientKeyId");
    const fixtureClientKeyId = match[1].trim();
    process.stdout.write(`FIXTURE_CLIENT_KEY_ID ${fixtureClientKeyId}\n`);

    await withFixture("mismatch", fixtureClientKeyId, async (ready) => {
      runInstrumentation(
        options.serial,
        ["io.github.rfairburn.pireviewgate.androidtest.AndroidKeystoreTransportMismatchTest"],
        {
          fixtureNonce: nonce,
          fixtureClientKeyId,
          fixtureHost: "10.0.2.2",
          fixturePort: ready.port,
          fixtureServerKeyId: ready.hostKeyId,
        },
        "pin-mismatch",
      );
    });

    await withFixture("happy", fixtureClientKeyId, async (ready) => {
      runInstrumentation(
        options.serial,
        ["io.github.rfairburn.pireviewgate.androidtest.AndroidKeystoreTransportLanesTest"],
        {
          fixtureNonce: nonce,
          fixtureClientKeyId,
          fixtureHost: "10.0.2.2",
          fixturePort: ready.port,
          fixtureServerKeyId: ready.hostKeyId,
        },
        "mtls-lanes",
      );
    });
  } catch (error) {
    phaseError = error;
  } finally {
    let cleanupError = null;
    try {
      runInstrumentation(
        options.serial,
        ["io.github.rfairburn.pireviewgate.androidtest.AndroidFixtureCleanupTest"],
        { fixtureNonce: nonce },
        "fixture-cleanup",
      );
    } catch (error) {
      cleanupError = error;
      process.stdout.write(`CLEANUP_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
    }
    adb(options.serial, ["shell", "am", "force-stop", PACKAGE], 30_000);
    if (cleanupError !== null) {
      // A failed cleanup is a suite failure even when every check passed. Keep
      // the original phase failure as the primary reason when both occurred.
      phaseError = phaseError === null
        ? cleanupError
        : new Error(
          `${phaseError instanceof Error ? phaseError.message : String(phaseError)}; `
            + `cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
    }
  }

  if (phaseError !== null) throw phaseError;
  process.stdout.write(`SUITE_RESULT PASS API=${options.api} AVD=${avdName}\n`);
}

main().catch((error) => {
  printLogcatDiagnostics(activeSerial);
  process.stderr.write(`SUITE_RESULT FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
