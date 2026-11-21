#!/usr/bin/env node
/**
 * Run the Android native PTY input/copy acceptance fixture against ONE explicitly
 * named, owned emulator.
 *
 * Ownership rules this script does not bend:
 * - every ADB call carries `-s <serial>`; there is no default device target;
 * - the live AVD name must match `prg_native_<token>` (a fresh private AVD), or
 *   equal the `avdName` in the `--ownership-receipt` file the operator wrote, and
 *   its reported SDK must equal `--api`;
 * - it installs the two debug APKs and force-stops THIS app only. It never boots
 *   or stops an emulator, never `pm clear`s anything, never grants a permission,
 *   and never kills a process by name.
 *
 * It owns exactly two things: the owner fixture process it spawns, and the
 * instrumentation run it starts. Both are bounded, and both are awaited.
 *
 * Pairing is bound to identity, not to a display label: the instrumentation reads
 * this device's own Keystore fingerprint off the real Settings screen and reports
 * it, and this runner approves one pending key only when its fingerprint matches
 * that device exactly. The final owner report must still carry the same
 * fingerprint among its trusted peers.
 *
 * The system local-network permission dialog is answered by the instrumentation
 * itself with a real injected UI tap. This runner never uses `-g`, `pm grant`, or
 * any adoption of shell permission.
 */

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const PACKAGE = "io.github.rfairburn.pireviewgate";
const TEST_PACKAGE = `${PACKAGE}.test`;
const RUNNER = `${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;
const TEST_CLASS = "io.github.rfairburn.pireviewgate.androidtest.NativeDeviceAcceptanceTest";
const FIXTURE = path.join(ROOT, "dist-test/tests/android-native-acceptance/owner-fixture.js");
const CHILD = path.join(__dirname, "synthetic-native-cli.cjs");
const APP_APK = path.join(ROOT, "android/app/build/outputs/apk/debug/app-debug.apk");
const TEST_APK = path.join(ROOT, "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk");
const DEVICE_LABEL = "Pi Review Gate";
const OWNED_AVD_PATTERN = /^prg_native_[A-Za-z0-9_-]{4,40}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IME_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const BACKENDS = new Set(["claude", "codex"]);

/** Events the device must name a backend for, and the snapshot each one opens. */
const BACKEND_EVENTS = new Set([
  "baselineInputObserved",
  "policyDisabled",
  "beforeTypedAttemptWithPolicyOff",
  "afterTypedAttemptWithPolicyOff",
  "requestOutOfBandCopy",
  "afterOutOfBandCopyWhileOff",
  "afterReEnableBeforeFreshInput",
  "freshCopyAfterReEnable",
  "typedInputObserved",
  "copyLanded",
  // The certified clipboard-write meter reports per backend and per window.
  "clipboardWrites",
]);

/** Journal snapshots the policy phase measures against, in interval order. */
const SNAPSHOT_EVENTS = [
  "baselineInputObserved",
  "beforeTypedAttemptWithPolicyOff",
  "afterTypedAttemptWithPolicyOff",
  "afterOutOfBandCopyWhileOff",
  "afterReEnableBeforeFreshInput",
];

function usage() {
  process.stderr.write(
    "usage: node tests/android-native-acceptance/run-device-suite.cjs --serial <emulator-serial>\n"
      + "       [--api 33|37] [--app-apk <path>] [--test-apk <path>] [--skip-install]\n"
      + "       [--ownership-receipt <json file with avdName>] [--artifacts <dir>]\n"
      + "       [--phase happy|policy|both] [--instrument-timeout <seconds>]\n",
  );
}

function parseArgs(argv) {
  const options = {
    api: "37",
    skipInstall: false,
    phase: "both",
    help: false,
    instrumentTimeoutSeconds: 1_800,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--help" || arg === "-h") { options.help = true; }
    else if (arg === "--serial") { options.serial = value; index += 1; }
    else if (arg === "--api") { options.api = value; index += 1; }
    else if (arg === "--app-apk") { options.appApk = value; index += 1; }
    else if (arg === "--test-apk") { options.testApk = value; index += 1; }
    else if (arg === "--ownership-receipt") { options.ownershipReceipt = value; index += 1; }
    else if (arg === "--artifacts") { options.artifacts = value; index += 1; }
    else if (arg === "--phase") { options.phase = value; index += 1; }
    else if (arg === "--instrument-timeout") { options.instrumentTimeoutSeconds = Number(value); index += 1; }
    else if (arg === "--skip-install") { options.skipInstall = true; }
    else { throw new Error(`unknown argument: ${arg}`); }
  }
  options.appApk = options.appApk ?? APP_APK;
  options.testApk = options.testApk ?? TEST_APK;
  if (options.help) return options;
  if (!options.serial || !/^emulator-[0-9]+$/.test(options.serial)) {
    throw new Error("--serial must be the exact owned emulator serial (emulator-<port>)");
  }
  if (!["33", "37"].includes(options.api)) throw new Error("--api must be 33 or 37");
  if (!["happy", "policy", "both"].includes(options.phase)) throw new Error("--phase must be happy, policy, or both");
  if (!Number.isFinite(options.instrumentTimeoutSeconds) || options.instrumentTimeoutSeconds < 60) {
    throw new Error("--instrument-timeout must be at least 60 seconds");
  }
  return options;
}

function adb(serial, args, timeout = 120_000) {
  const result = spawnSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
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

/** The live AVD identity must be a fresh private owned AVD, or a receipt match. */
function verifyOwnedEmulator(serial, receiptPath) {
  const state = checked("adb get-state", adb(serial, ["get-state"], 20_000)).stdout.trim();
  if (state !== "device") throw new Error(`ADB target ${serial} is not in device state`);
  const qemu = checked("adb getprop ro.kernel.qemu", adb(serial, ["shell", "getprop", "ro.kernel.qemu"], 20_000))
    .stdout.trim();
  if (qemu !== "1") throw new Error(`ADB target ${serial} is not an emulator`);
  const reported = checked("adb emu avd name", adb(serial, ["emu", "avd", "name"], 20_000)).stdout
    .split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "OK");
  if (!reported) throw new Error(`ADB target ${serial} reported no AVD name`);
  let owned = OWNED_AVD_PATTERN.test(reported);
  let receipt = null;
  if (!owned && receiptPath !== undefined) {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    owned = receipt.avdName === reported
      && (receipt.serial === undefined || receipt.serial === serial);
  }
  if (!owned) {
    throw new Error(
      `ADB target ${serial} is not an owned private AVD (reported '${reported}'). `
        + "Create a fresh AVD named prg_native_<token>, or pass --ownership-receipt.",
    );
  }
  const pid = checked("adb emu pid", adb(serial, ["emu", "pid"], 20_000)).stdout.trim();
  const sdk = checked(
    "adb getprop ro.build.version.sdk",
    adb(serial, ["shell", "getprop", "ro.build.version.sdk"], 20_000),
  ).stdout.trim();
  return { avdName: reported, emulatorPid: pid, sdk, receipt };
}

/**
 * Accumulate `am instrument -r` status output into complete records.
 *
 * A status bundle arrives as many `INSTRUMENTATION_STATUS: key=value` lines closed
 * by one `INSTRUMENTATION_STATUS_CODE:` line, so a single line is never an event:
 * dispatching per line would strip every field except the one it happened to
 * contain. Nothing is discarded here — non-status lines are kept as raw output.
 */
function createStatusAccumulator(onRecord) {
  let fields = {};
  return {
    feed(line) {
      if (line.startsWith("INSTRUMENTATION_STATUS_CODE:")) {
        const code = Number(line.slice("INSTRUMENTATION_STATUS_CODE:".length).trim());
        const record = { fields, code };
        fields = {};
        if (onRecord !== undefined) onRecord(record);
        return record;
      }
      if (line.startsWith("INSTRUMENTATION_STATUS:")) {
        const body = line.slice("INSTRUMENTATION_STATUS:".length);
        const separator = body.indexOf("=");
        if (separator < 0) return null;
        const key = body.slice(0, separator).trim();
        if (key.length === 0) return null;
        fields[key] = body.slice(separator + 1).trim();
        return null;
      }
      return null;
    },
    pendingFields: () => fields,
  };
}

/** One line-delimited JSON reader over the owner fixture's stdout. */
class FixtureProcess {
  constructor(artifacts, run, marker) {
    this.lines = [];
    this.buffer = "";
    this.stderr = "";
    this.wake = null;
    this.handlers = new Map();
    this.logPath = path.join(artifacts, `fixture-${run}.log`);
    this.exited = null;
    this.child = spawn(
      process.execPath,
      [
        FIXTURE,
        "--run", run,
        "--root", path.join(artifacts, "owner"),
        "--child", CHILD,
        "--device-label", DEVICE_LABEL,
        "--marker", marker,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.on("data", (data) => this.absorb(data));
    this.child.stderr.on("data", (data) => {
      this.stderr += data;
      fs.appendFileSync(this.logPath, data);
    });
    this.exit = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exited = { code, signal };
        resolve(this.exited);
      });
    });
  }

  absorb(data) {
    fs.appendFileSync(this.logPath, data);
    this.buffer += data;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      this.lines.push(parsed);
      const handler = this.handlers.get(parsed.event);
      if (handler !== undefined) void handler(parsed);
      const wake = this.wake;
      this.wake = null;
      wake?.();
    }
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  async next(event, what, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find((line) => line.event === event);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) {
        throw new Error(`the fixture never emitted ${what}; stderr: ${this.stderr.slice(-2_000)}`);
      }
      await new Promise((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now())));
      });
    }
  }

  count(event) {
    return this.lines.filter((line) => line.event === event).length;
  }

  last(event) {
    return this.lines.filter((line) => line.event === event).at(-1);
  }

  matching(event, predicate) {
    return this.lines.filter((line) => line.event === event && predicate(line));
  }

  command(text) {
    this.child.stdin.write(`${text}\n`);
  }

  kill() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}

/**
 * Quote one instrumentation extra for the device's own shell.
 *
 * `adb shell` concatenates its arguments with spaces and lets the device shell split
 * them again, so a value containing a space would otherwise arrive as several extras and
 * the label would silently be truncated to its first word. The peer label is
 * "Pi Review Gate", which is exactly that case; values without whitespace are passed
 * through exactly as before.
 */
function deviceShellArgument(value) {
  if (!/\s/.test(value)) return value;
  // Close the quote, insert one escaped literal quote, reopen: the POSIX idiom.
  return "'" + value.split("'").join("'\\''") + "'";
}

/**
 * Start one instrumentation run, stream complete status records, and finish inside
 * a fixed deadline. On timeout only the target app is force-stopped, the owned adb
 * child is closed and awaited, and the complete output is kept.
 */
function runInstrumentation(options, classes, extras, phase, onRecord) {
  const artifacts = options.artifacts;
  const logPath = path.join(artifacts, `${phase}-instrumentation.log`);
  const args = ["shell", "am", "instrument", "-w", "-r", "-e", "class", classes.join(",")];
  for (const [key, value] of Object.entries(extras)) args.push("-e", key, deviceShellArgument(String(value)));
  args.push(RUNNER);
  return new Promise((resolve, reject) => {
    const child = spawn("adb", ["-s", options.serial, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let pending = "";
    let settled = false;
    let timedOut = false;
    const accumulator = createStatusAccumulator(onRecord);
    const absorb = (data) => {
      output += data;
      fs.appendFileSync(logPath, data);
      pending += data;
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        accumulator.feed(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Only the app under test is stopped, on the serial already verified owned.
      adb(options.serial, ["shell", "am", "force-stop", PACKAGE], 30_000);
      child.kill("SIGKILL");
    }, options.instrumentTimeoutSeconds * 1_000);
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (pending.length > 0) accumulator.feed(pending);
      pending = "";
      if (timedOut) {
        finish(new Error(
          `${phase} instrumentation exceeded ${options.instrumentTimeoutSeconds}s and was stopped; `
            + `output kept at ${logPath}`,
        ));
        return;
      }
      const failed = code !== 0
        || /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|INSTRUMENTATION_STATUS_CODE: -2/.test(output)
        || !/\bOK \(/.test(output);
      if (failed) {
        finish(new Error(
          `${phase} instrumentation did not report a passing run (exit ${code}, signal ${signal}); `
            + `output kept at ${logPath}\n${output.slice(-8_000)}`,
        ));
        return;
      }
      finish(null);
    });
  });
}

function journalOf(statusReply, backend) {
  return (statusReply?.rows ?? []).find((row) => row.backend === backend) ?? null;
}

/**
 * The device's own clipboard-write meter reports, for one backend and window.
 *
 * The meter counts entries of `ClipboardManager.setPrimaryClip` — real SDK writes —
 * and never listener notifications. Every report carries the phase's single baseline
 * and the cumulative total expected from it, so the runner checks the phase total and
 * not merely a difference the device could have resampled.
 */
function meterReports(events, backend, window) {
  return events.filter(
    (event) =>
      event.source === "device"
      && event.prgEvent === "clipboardWrites"
      && event.backend === backend
      && (window === undefined || event.window === window),
  );
}

function numberField(value, name, label) {
  if (!/^-?\d+$/.test(String(value ?? ""))) {
    fail(`${label}: ${name} is not a number: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/**
 * One meter checkpoint: `expectedWrites` since the previous checkpoint, and the
 * cumulative phase total `cumulativeExpected` above the phase baseline.
 *
 * The cumulative check is what closes the gap a resampled baseline leaves: a write
 * that arrives between two actions, or after the last one, changes the running total
 * and so fails here instead of becoming the new normal.
 */
function assertMeterWrites(events, { backend, window, expectedWrites, cumulativeExpected, what }) {
  const found = meterReports(events, backend, window);
  const label = `${what}: clipboard writes for ${backend}${window === undefined ? "" : ` (window ${window})`}`;
  if (found.length !== 1) {
    fail(`${label}: expected exactly one meter report, saw ${found.length}`);
  }
  const report = found[0];
  if (report.expectedWrites !== String(expectedWrites)) {
    fail(`${label}: the device expected ${JSON.stringify(report.expectedWrites)} writes, not ${expectedWrites}`);
  }
  const baseline = numberField(report.phaseBaselineWrites, "phaseBaselineWrites", label);
  const sinceLast = numberField(report.writesSinceLastCheckpoint, "writesSinceLastCheckpoint", label);
  const observedTotal = numberField(report.observedTotalWrites, "observedTotalWrites", label);
  const expectedTotal = numberField(report.expectedTotalWrites, "expectedTotalWrites", label);
  if (sinceLast !== expectedWrites) {
    fail(`${label}: the meter counted ${sinceLast} SDK clipboard writes since the last checkpoint, expected `
      + `${expectedWrites}; meter status ${JSON.stringify(report.meterStatus)}`);
  }
  if (expectedTotal !== baseline + cumulativeExpected) {
    fail(`${label}: the device's cumulative expectation is ${expectedTotal}, not the phase baseline ${baseline} `
      + `plus ${cumulativeExpected} committed write(s)`);
  }
  if (observedTotal !== expectedTotal) {
    fail(`${label}: the meter's cumulative total is ${observedTotal}, expected ${expectedTotal} `
      + `(baseline ${baseline} + ${cumulativeExpected}); meter status ${JSON.stringify(report.meterStatus)}`);
  }
  process.stdout.write(
    `METER ${JSON.stringify({
      what,
      backend,
      window: window ?? null,
      expectedWrites,
      writesSinceLastCheckpoint: sinceLast,
      phaseBaselineWrites: baseline,
      expectedTotalWrites: expectedTotal,
      observedTotalWrites: observedTotal,
      listenerNotifications: report.listenerNotifications,
    })}\n`,
  );
}

/**
 * The meter must have armed once and closed once, and the closed snapshot must be
 * the phase's whole expected total: the phase baseline plus `expectedFinalWrites`.
 *
 * A meter that failed to arm, never closed, closed with a failed teardown (-1), or
 * closed on a count that does not match the whole phase makes the phase unproven.
 * This is the check that catches a write landing after the last in-test assertion.
 */
function assertMeterLifecycle(events, what, expectedFinalWrites) {
  const armed = events.filter((event) => event.source === "device" && event.prgEvent === "clipboardWriteMeterReady");
  const closed = events.filter((event) => event.source === "device" && event.prgEvent === "clipboardWriteMeterClosed");
  if (armed.length !== 1) {
    fail(`${what}: the clipboard-write meter armed ${armed.length} times, expected exactly 1`);
  }
  if (closed.length !== 1) {
    fail(`${what}: the clipboard-write meter reported a closed snapshot ${closed.length} times, expected exactly 1`);
  }
  const baseline = numberField(armed[0].phaseBaselineWrites, "phaseBaselineWrites", `${what}: armed meter`);
  const finalTotal = numberField(closed[0].finalTotalWrites, "finalTotalWrites", `${what}: closed meter`);
  const expectedFinal = baseline + expectedFinalWrites;
  if (closed[0].expectedFinalTotalWrites !== String(expectedFinal)) {
    fail(`${what}: the device expected a closed total of ${JSON.stringify(closed[0].expectedFinalTotalWrites)}, `
      + `not the phase baseline ${baseline} plus ${expectedFinalWrites}`);
  }
  if (finalTotal !== expectedFinal) {
    fail(`${what}: the closed meter snapshot is ${finalTotal} writes, expected ${expectedFinal} `
      + `(baseline ${baseline} + ${expectedFinalWrites}); the phase either wrote more or lost a write`
      + `; meter status ${JSON.stringify(closed[0].meterStatus)}`);
  }
  process.stdout.write(
    `METER ${JSON.stringify({
      what,
      target: armed[0].target,
      armed: armed[0].meterStatus,
      phaseBaselineWrites: baseline,
      expectedClosedTotalWrites: expectedFinal,
      closedTotalWrites: finalTotal,
      closed: closed[0].meterStatus,
    })}\n`,
  );
}

function fail(message) {
  throw new Error(message);
}

function assertJournal(label, row, expectations) {
  if (row === null) fail(`${label}: the fixture reported no journal for this backend`);
  const actual = (name) => {
    const value = row[name];
    if (typeof value !== "number") fail(`${label}: journal field ${name} is not a number (${JSON.stringify(value)})`);
    return value;
  };
  if (!row.launchJournaled) fail(`${label}: the owned child journaled no launch record`);
  if (expectations.stdinAtLeast !== undefined && actual("stdinRecords") < expectations.stdinAtLeast) {
    fail(`${label}: expected at least ${expectations.stdinAtLeast} raw stdin records, saw ${actual("stdinRecords")}`);
  }
  if (expectations.stdinEquals !== undefined && actual("stdinRecords") !== expectations.stdinEquals) {
    fail(`${label}: expected exactly ${expectations.stdinEquals} raw stdin records, saw ${actual("stdinRecords")}`);
  }
  if (expectations.markerHitsAtLeast !== undefined && actual("markerHits") < expectations.markerHitsAtLeast) {
    fail(`${label}: expected the child journal to witness the run marker at least ${expectations.markerHitsAtLeast} time(s), saw ${actual("markerHits")}`);
  }
  if (expectations.osc52AtLeast !== undefined && actual("osc52Emitted") < expectations.osc52AtLeast) {
    fail(`${label}: expected at least ${expectations.osc52AtLeast} child OSC 52 emission(s), saw ${actual("osc52Emitted")}`);
  }
  if (expectations.controlCopiesAtLeast !== undefined && actual("osc52ViaControl") < expectations.controlCopiesAtLeast) {
    fail(`${label}: expected at least ${expectations.controlCopiesAtLeast} child out-of-band emission(s), saw ${actual("osc52ViaControl")}`);
  }
  if (expectations.controlCopiesEquals !== undefined && actual("osc52ViaControl") !== expectations.controlCopiesEquals) {
    fail(`${label}: expected exactly ${expectations.controlCopiesEquals} child out-of-band emission(s), saw ${actual("osc52ViaControl")}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  for (const file of [FIXTURE, CHILD]) {
    if (!fs.existsSync(file)) throw new Error(`missing fixture build: ${file}`);
  }
  const identity = verifyOwnedEmulator(options.serial, options.ownershipReceipt);
  if (identity.sdk !== options.api) {
    throw new Error(
      `the owned emulator ${identity.avdName} reports SDK ${identity.sdk}, but --api ${options.api} was requested`,
    );
  }
  const run = `prg${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  // Only lowercase letters: every character must exist on the installed IME's main
  // layer so the instrumentation can really tap it.
  const marker = Array.from({ length: 8 }, () => IME_LETTERS[crypto.randomInt(IME_LETTERS.length)]).join("");
  const artifacts = path.resolve(options.artifacts ?? path.join(os.tmpdir(), `prg-android-acceptance-${run}`));
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  options.artifacts = artifacts;
  process.stdout.write(`OWNED_AVD ${identity.avdName} pid ${identity.emulatorPid} SDK ${identity.sdk}\n`);
  process.stdout.write(`RUN ${run} MARKER ${marker} ARTIFACTS ${artifacts}\n`);

  if (!options.skipInstall) {
    for (const [label, apk] of [["app APK", options.appApk], ["test APK", options.testApk]]) {
      if (!fs.existsSync(apk)) throw new Error(`missing ${label}: ${apk}`);
      checked(`install ${label}`, adb(options.serial, ["install", "-r", "-t", apk], 600_000));
    }
  }
  checked("force-stop target app", adb(options.serial, ["shell", "am", "force-stop", PACKAGE], 30_000));
  // The soft IME must be present for real injected key taps. This is a normal
  // emulator display setting; it grants no permission.
  adb(options.serial, ["shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1"], 30_000);
  adb(options.serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], 30_000);
  adb(options.serial, ["shell", "wm", "dismiss-keyguard"], 30_000);

  const fixture = new FixtureProcess(artifacts, run, marker);
  const events = [];
  const violations = [];
  const snapshots = new Map();
  let snapshotQueue = Promise.resolve();
  let deviceIdentity = null;
  let pairingApprovals = 0;
  let approvedPeerFingerprint = null;
  let phaseError = null;

  /** Ask the fixture for a fresh status reply and return it. */
  const requestStatus = async () => {
    const before = fixture.count("status");
    fixture.command("status");
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (fixture.count("status") > before) return fixture.last("status");
      if (Date.now() > deadline) throw new Error("the fixture did not answer a status request");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** Read the journal once per event, in event order, without interleaving. */
  const takeSnapshot = (event, backend) => {
    snapshotQueue = snapshotQueue.then(async () => {
      try {
        const reply = await requestStatus();
        const row = journalOf(reply, backend);
        snapshots.set(event, { event, backend, row, at: Date.now() });
        process.stdout.write(`JOURNAL_SNAPSHOT ${JSON.stringify({ event, backend, row })}\n`);
      } catch (error) {
        violations.push(`journal snapshot for ${event} failed: ${error.message}`);
      }
    });
    return snapshotQueue;
  };

  fixture.on("pairing-pending", async (pending) => {
    events.push({ at: Date.now(), ...pending });
    if (pending.label !== DEVICE_LABEL) {
      violations.push(`pairing offered an unexpected label: ${JSON.stringify(pending.label)}`);
      fixture.command(`deny ${pending.consentId}`);
      return;
    }
    if (!FINGERPRINT_PATTERN.test(String(pending.fingerprint ?? ""))) {
      violations.push(`pairing offered no canonical fingerprint: ${JSON.stringify(pending.fingerprint)}`);
      fixture.command(`deny ${pending.consentId}`);
      return;
    }
    // The device reports its own identity before it dials, so this wait is short.
    const identityDeadline = Date.now() + 60_000;
    while (deviceIdentity === null && Date.now() < identityDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (deviceIdentity === null) {
      violations.push("pairing arrived before this device reported its own identity; nothing was approved");
      fixture.command(`deny ${pending.consentId}`);
      return;
    }
    if (pending.fingerprint !== deviceIdentity) {
      violations.push(
        "the pending key is not this device's identity: approved pairing requires an exact fingerprint match",
      );
      fixture.command(`deny ${pending.consentId}`);
      return;
    }
    if (pairingApprovals >= 1) {
      violations.push(`a second pairing was offered for the same identity: ${pending.consentId}`);
      fixture.command(`deny ${pending.consentId}`);
      return;
    }
    pairingApprovals += 1;
    approvedPeerFingerprint = pending.fingerprint;
    fixture.command(`approve ${pending.consentId}`);
    process.stdout.write(`PAIRING_APPROVED ${JSON.stringify({ consentId: pending.consentId, fingerprint: pending.fingerprint })}\n`);
  });
  for (const event of ["pairing-decided", "pairing-refused", "copy-requested-out-of-band", "viewers", "control-refused"]) {
    fixture.on(event, (value) => {
      events.push({ at: Date.now(), source: "owner", ...value });
      process.stdout.write(`FIXTURE_EVENT ${JSON.stringify(value)}\n`);
    });
  }

  const onRecord = (record) => {
    const fields = record.fields;
    if (fields.prgEvent === undefined) return;
    if (fields.fixtureRun !== run) {
      violations.push(`device event ${fields.prgEvent} carried run ${JSON.stringify(fields.fixtureRun)}, not ${run}`);
      return;
    }
    if (BACKEND_EVENTS.has(fields.prgEvent) && !BACKENDS.has(fields.backend)) {
      violations.push(`device event ${fields.prgEvent} named no valid backend: ${JSON.stringify(fields.backend)}`);
      return;
    }
    events.push({ at: Date.now(), source: "device", code: record.code, ...fields });
    process.stdout.write(`DEVICE_EVENT ${JSON.stringify({ code: record.code, ...fields })}\n`);
    if (fields.prgEvent === "deviceIdentity") {
      if (!FINGERPRINT_PATTERN.test(String(fields.fingerprint ?? ""))) {
        violations.push("the device identity event carried no canonical fingerprint");
        return;
      }
      if (deviceIdentity !== null && deviceIdentity !== fields.fingerprint) {
        violations.push("the device reported two different identities in one run");
        return;
      }
      deviceIdentity = fields.fingerprint;
      return;
    }
    if (fields.prgEvent === "requestOutOfBandCopy") {
      // Only a verified backend name reaches the owner: no silent default.
      fixture.command(`copy ${fields.backend}`);
      return;
    }
    if (SNAPSHOT_EVENTS.includes(fields.prgEvent)) void takeSnapshot(fields.prgEvent, fields.backend);
  };

  const ready = await fixture.next("ready", "the owner fixture's ready line", 120_000);
  process.stdout.write(`FIXTURE_READY ${JSON.stringify(ready)}\n`);
  const rowIds = Object.fromEntries((ready.rows ?? []).map((row) => [row.backend, row.rowId]));
  if (rowIds.claude === undefined || rowIds.codex === undefined) {
    throw new Error("the owner fixture did not stage both canonical backend rows");
  }

  const extras = {
    fixtureRun: run,
    fixturePort: ready.port,
    fixtureHostFingerprint: ready.hostFingerprint,
    fixtureMarker: marker,
    // Production pairs with the saved host-record label as its peer display label
    // (`HostConnectionRegistry` passes `plan.label`, and the transport sends it as the
    // peer label header), so the form's label has to be the same value both this runner
    // and the owner fixture fence on. Identity stays the reported fingerprint.
    fixtureHostLabel: DEVICE_LABEL,
    fixtureClaudeRow: rowIds.claude,
    fixtureCodexRow: rowIds.codex,
  };

  try {
    if (options.phase !== "policy") {
      const happyStart = events.length;
      await runInstrumentation(
        options,
        [`${TEST_CLASS}#typedInputAndTextCopyReachTheRealOwnerOnBothBackends`],
        extras,
        "typed-input-and-copy",
        onRecord,
      );
      const happyEvents = events.slice(happyStart);
      const afterHappy = await requestStatus();
      for (const backend of ["claude", "codex"]) {
        const row = journalOf(afterHappy, backend);
        assertJournal(`${backend} happy path`, row, {
          stdinAtLeast: 2,
          markerHitsAtLeast: 1,
          osc52AtLeast: 1,
          controlCopiesEquals: 0,
        });
        if ((row.typedTriggerHits ?? 0) < 1) {
          fail(`${backend}: the child never saw its own typed copy trigger`);
        }
        if (!events.some((event) => event.source === "device" && event.prgEvent === "copyLanded" && event.backend === backend)) {
          fail(`${backend}: the phone never reported a copy landing in its real clipboard`);
        }
      }
      // The copy is proven as a write, not as a notification: the test-only meter
      // counted entries of the SDK setter, one per backend, cumulatively from one
      // phase baseline, and closed on exactly that total. A meter that never armed or
      // never closed, or closed on another count, leaves the phase unproven.
      assertMeterLifecycle(happyEvents, "typed input and copy", 2);
      assertMeterWrites(happyEvents, {
        backend: "claude",
        expectedWrites: 1,
        cumulativeExpected: 1,
        what: "typed input and copy",
      });
      assertMeterWrites(happyEvents, {
        backend: "codex",
        expectedWrites: 1,
        cumulativeExpected: 2,
        what: "typed input and copy",
      });
      process.stdout.write("PHASE typed-input-and-copy PASS\n");
    }

    if (options.phase !== "happy") {
      const policyStart = events.length;
      await runInstrumentation(
        options,
        [`${TEST_CLASS}#viewerPolicyOffBlocksTypedInputAndOutOfBandCopy`],
        extras,
        "policy-off-and-no-replay",
        onRecord,
      );
      const policyEvents = events.slice(policyStart);
      await snapshotQueue;
      const afterPolicy = await requestStatus();
      const backend = "claude";
      const baseline = snapshots.get("baselineInputObserved")?.row ?? null;
      const beforeAttempt = snapshots.get("beforeTypedAttemptWithPolicyOff")?.row ?? null;
      const afterAttempt = snapshots.get("afterTypedAttemptWithPolicyOff")?.row ?? null;
      const afterOutOfBand = snapshots.get("afterOutOfBandCopyWhileOff")?.row ?? null;
      const afterReEnable = snapshots.get("afterReEnableBeforeFreshInput")?.row ?? null;
      const endRow = journalOf(afterPolicy, backend);
      for (const [name, row] of [
        ["baseline", baseline],
        ["before typed attempt", beforeAttempt],
        ["after typed attempt", afterAttempt],
        ["after out-of-band copy", afterOutOfBand],
        ["after re-enable", afterReEnable],
        ["end", endRow],
      ]) {
        if (row === null) fail(`policy phase: no journal snapshot for ${name}`);
      }
      // A real, accepted phone input exists before anything is disabled.
      assertJournal("policy baseline input", baseline, { stdinAtLeast: 1, markerHitsAtLeast: 1 });
      if (baseline.osc52ViaControl !== 0) {
        fail(`policy baseline: ${baseline.osc52ViaControl} out-of-band copies happened before the phase began`);
      }
      // The whole Off interval: no new child bytes at any point.
      assertJournal("policy: journal at the start of the Off interval", beforeAttempt, { stdinEquals: baseline.stdinRecords });
      assertJournal("policy: typed attempt with policy Off", afterAttempt, { stdinEquals: baseline.stdinRecords });
      assertJournal("policy: re-enable before fresh input", afterReEnable, { stdinEquals: baseline.stdinRecords });
      // The child really did emit out of band, while policy stayed Off and while
      // this phone's clipboard kept its sentinel.
      assertJournal("policy: out-of-band child emission", afterOutOfBand, {
        controlCopiesAtLeast: baseline.osc52ViaControl + 1,
        osc52AtLeast: baseline.osc52Emitted + 1,
        stdinEquals: baseline.stdinRecords,
      });
      // Owner-side forwarding is reported apart from the child's own emission.
      const ownerOutOfBandRequests = fixture.matching(
        "copy-requested-out-of-band",
        (line) => line.backend === backend,
      ).length;
      process.stdout.write(`OBSERVATION ${JSON.stringify({
        ownerOutOfBandRequests,
        childControlCopies: afterOutOfBand.osc52ViaControl,
        childOsc52Emitted: afterOutOfBand.osc52Emitted,
      })}\n`);
      if (ownerOutOfBandRequests < 1) {
        fail("policy phase: the owner never issued the out-of-band copy request the device asked for");
      }
      // Only a fresh actual input may produce the next copy.
      if (endRow.stdinRecords <= baseline.stdinRecords) {
        fail("policy phase: the fresh copy after re-enabling never produced real input");
      }
      // The same is proven on the phone: the meter's cumulative count stayed at the
      // sentinel through the whole Off window including re-enable, and rose by exactly
      // one only for the fresh copy after a fresh actual input. The closed snapshot
      // must be baseline + sentinel + that one fresh copy.
      assertMeterLifecycle(policyEvents, "policy Off", 2);
      assertMeterWrites(policyEvents, {
        backend: "claude",
        window: "policyOffThroughReEnable",
        expectedWrites: 0,
        cumulativeExpected: 1,
        what: "policy Off",
      });
      assertMeterWrites(policyEvents, {
        backend: "claude",
        window: "freshCopyAfterReEnable",
        expectedWrites: 1,
        cumulativeExpected: 2,
        what: "policy Off",
      });
      process.stdout.write("PHASE policy-off-and-no-replay PASS\n");
    }
  } catch (error) {
    phaseError = error;
  } finally {
    adb(options.serial, ["shell", "am", "force-stop", PACKAGE], 30_000);
    fixture.command("report");
  }

  let report = null;
  try {
    report = await fixture.next("report", "the fixture's report line", 180_000);
  } catch (error) {
    phaseError = phaseError ?? error;
  }
  // The owner process is awaited, not abandoned.
  try {
    await fixture.exit;
  } catch {
    /* the exit promise never rejects; recorded below if it never happened */
  }
  if (report !== null) {
    fs.writeFileSync(
      path.join(artifacts, `report-${run}.json`),
      `${JSON.stringify({ report, events, snapshots: [...snapshots.values()], violations }, null, 2)}\n`,
    );
    process.stdout.write(`FIXTURE_REPORT ${JSON.stringify(report)}\n`);
    if (!report.ok && phaseError === null) {
      phaseError = new Error(`fixture invariants failed: ${(report.problems ?? []).join("; ")}`);
    }
    // The approved identity must still be the trusted peer the owner reports.
    const trusted = (report.trustedPeers ?? []).map((peer) => peer.fingerprint);
    if (approvedPeerFingerprint === null || !trusted.includes(approvedPeerFingerprint)) {
      if (phaseError === null) {
        phaseError = new Error(
          "the approved pairing fingerprint is absent from the owner's final trusted peers: "
            + `${JSON.stringify(approvedPeerFingerprint)}`,
        );
      }
    }
  }
  if (pairingApprovals !== 1) {
    phaseError = phaseError ?? new Error(`expected exactly one approved pairing for this run, got ${pairingApprovals}`);
  }
  if (violations.length > 0 && phaseError === null) {
    phaseError = new Error(`protocol violations: ${violations.join("; ")}`);
  }
  if (phaseError !== null) throw phaseError;
  process.stdout.write(
    `SUITE_RESULT PASS API=${options.api} AVD=${identity.avdName} RUN=${run} `
      + `DEVICE_IDENTITY=${deviceIdentity} FIXTURE_EXIT=${JSON.stringify(fixture.exited)} ARTIFACTS=${artifacts}\n`,
  );
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`SUITE_RESULT FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = { createStatusAccumulator, parseArgs, deviceShellArgument };
