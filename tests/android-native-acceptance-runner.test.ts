/**
 * Focused parser test for the Android device runner's instrumentation reader.
 *
 * `am instrument -r` reports one status bundle as many
 * `INSTRUMENTATION_STATUS: key=value` lines closed by one
 * `INSTRUMENTATION_STATUS_CODE:` line. This fixture proves the runner accumulates
 * a whole bundle and dispatches it once, so an event never arrives stripped of the
 * backend, run token, or copied text that correlates it with the child journal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

interface StatusRecord {
  readonly fields: Record<string, string>;
  readonly code: number;
}

interface StatusAccumulator {
  feed(line: string): unknown;
  pendingFields(): Record<string, string>;
}

interface RunnerModule {
  createStatusAccumulator(onRecord: (record: StatusRecord) => void): StatusAccumulator;
  parseArgs(argv: readonly string[]): Record<string, unknown>;
  deviceShellArgument(value: string): string;
}

const runner = require(join(__dirname, "..", "..", "tests", "android-native-acceptance", "run-device-suite.cjs")) as RunnerModule;

/** Representative `am instrument -w -r` output for one instrumented test. */
const REPRESENTATIVE = [
  "INSTRUMENTATION_RESULT: shortMsg=Process started.",
  "INSTRUMENTATION_STATUS: class=io.github.rfairburn.pireviewgate.androidtest.NativeDeviceAcceptanceTest",
  "INSTRUMENTATION_STATUS: current=1",
  "INSTRUMENTATION_STATUS: id=AndroidJUnitRunner",
  "INSTRUMENTATION_STATUS: test=viewerPolicyOffBlocksTypedInputAndOutOfBandCopy",
  "INSTRUMENTATION_STATUS: monitorCode=0",
  "INSTRUMENTATION_STATUS: stream=",
  "INSTRUMENTATION_STATUS_CODE: -3",
  "INSTRUMENTATION_STATUS: class=io.github.rfairburn.pireviewgate.androidtest.NativeDeviceAcceptanceTest",
  "INSTRUMENTATION_STATUS: current=1",
  "INSTRUMENTATION_STATUS: id=AndroidJUnitRunner",
  "INSTRUMENTATION_STATUS: test=viewerPolicyOffBlocksTypedInputAndOutOfBandCopy",
  "INSTRUMENTATION_STATUS: prgEvent=deviceIdentity",
  "INSTRUMENTATION_STATUS: fixtureRun=prgmd0abcd12",
  "INSTRUMENTATION_STATUS: fingerprint=Y3JlYW0tcGxhY2Vob2xkZXItdmFsdWUtZm9yLXRoaXM=",
  "INSTRUMENTATION_STATUS: stream=io.github.rfairburn.pireviewgate.androidtest.NativeDeviceAcceptanceTest:",
  "INSTRUMENTATION_STATUS_CODE: 1",
  "INSTRUMENTATION_STATUS: class=io.github.rfairburn.pireviewgate.androidtest.NativeDeviceAcceptanceTest",
  "INSTRUMENTATION_STATUS: current=1",
  "INSTRUMENTATION_STATUS: id=AndroidJUnitRunner",
  "INSTRUMENTATION_STATUS: test=viewerPolicyOffBlocksTypedInputAndOutOfBandCopy",
  "INSTRUMENTATION_STATUS: prgEvent=requestOutOfBandCopy",
  "INSTRUMENTATION_STATUS: backend=codex",
  "INSTRUMENTATION_STATUS: fixtureRun=prgmd0abcd12",
  "INSTRUMENTATION_STATUS: stream=",
  "INSTRUMENTATION_STATUS_CODE: 1",
  "INSTRUMENTATION_STATUS: class=io.github.rfairburn.pireviewgate.androidtest.NativeDeviceAcceptanceTest",
  "INSTRUMENTATION_STATUS: current=1",
  "INSTRUMENTATION_STATUS: id=AndroidJUnitRunner",
  "INSTRUMENTATION_STATUS: test=viewerPolicyOffBlocksTypedInputAndOutOfBandCopy",
  "INSTRUMENTATION_STATUS: prgEvent=freshCopyAfterReEnable",
  "INSTRUMENTATION_STATUS: backend=claude",
  "INSTRUMENTATION_STATUS: fixtureRun=prgmd0abcd12",
  "INSTRUMENTATION_STATUS: text=PRGCOPY-claude-prgmd0abcd12-typed-2",
  "INSTRUMENTATION_STATUS: stream=",
  "INSTRUMENTATION_STATUS_CODE: 1",
  "INSTRUMENTATION_STATUS: stream=OK (1 test)",
  "INSTRUMENTATION_STATUS_CODE: -1",
  "",
].join("\n");

function collect(text: string): StatusRecord[] {
  const records: StatusRecord[] = [];
  const accumulator = runner.createStatusAccumulator((record) => records.push(record));
  for (const line of text.split("\n")) accumulator.feed(line);
  return records;
}

test("one status bundle becomes exactly one record carrying every field", () => {
  const records = collect(REPRESENTATIVE);
  assert.equal(records.length, 5, "each INSTRUMENTATION_STATUS_CODE closes one record");
  const events = records.filter((record) => record.fields.prgEvent !== undefined);
  assert.deepEqual(
    events.map((record) => [record.fields.prgEvent, record.fields.backend ?? null]),
    [
      ["deviceIdentity", null],
      ["requestOutOfBandCopy", "codex"],
      ["freshCopyAfterReEnable", "claude"],
    ],
    "the out-of-band event keeps the backend the phone actually named",
  );
  const outOfBand = events.find((record) => record.fields.prgEvent === "requestOutOfBandCopy");
  assert.equal(outOfBand?.fields.fixtureRun, "prgmd0abcd12");
  const fresh = events.find((record) => record.fields.prgEvent === "freshCopyAfterReEnable");
  assert.equal(fresh?.fields.text, "PRGCOPY-claude-prgmd0abcd12-typed-2");
});

test("fields never leak from one bundle into the next", () => {
  const records = collect(REPRESENTATIVE);
  assert.equal(records[0]?.fields.prgEvent, undefined);
  assert.equal(records[1]?.fields.text, undefined);
  assert.equal(records[2]?.fields.fingerprint, undefined, "the identity bundle's key stays in its own record");
  assert.equal(records[4]?.fields.prgEvent, undefined, "the closing OK bundle is not an event");
  assert.equal(records[4]?.fields.stream, "OK (1 test)");
});

test("non-status output is ignored rather than mistaken for an event", () => {
  const records = collect("Tests run to failure.\n\nINSTRUMENTATION_FAILED: crash\n");
  assert.equal(records.length, 0);
});

test("an incomplete bundle is still pending and is never dispatched early", () => {
  const seen: StatusRecord[] = [];
  const accumulator = runner.createStatusAccumulator((record) => seen.push(record));
  accumulator.feed("INSTRUMENTATION_STATUS: prgEvent=copyLanded");
  accumulator.feed("INSTRUMENTATION_STATUS: backend=claude");
  assert.equal(seen.length, 0, "no event is invented before its bundle closes");
  assert.deepEqual(accumulator.pendingFields(), { prgEvent: "copyLanded", backend: "claude" });
  accumulator.feed("INSTRUMENTATION_STATUS_CODE: 1");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.fields, { prgEvent: "copyLanded", backend: "claude" });
  assert.equal(seen[0]?.code, 1);
});

test("the runner still refuses to guess a device serial", () => {
  assert.throws(() => runner.parseArgs([]), /--serial/);
  assert.throws(() => runner.parseArgs(["--serial", "emulator-x"]), /emulator-<port>/);
  assert.equal(runner.parseArgs(["--serial", "emulator-5554"]).serial, "emulator-5554");
});

test("an instrumentation extra with spaces survives the device shell as one value", () => {
  // `adb shell` joins its arguments with spaces and lets the device shell split them
  // again, so the peer label must reach the device already quoted.
  assert.equal(runner.deviceShellArgument("Pi Review Gate"), "'Pi Review Gate'");
  assert.equal(runner.deviceShellArgument("prg-owner"), "prg-owner");
  assert.equal(runner.deviceShellArgument("a b'c"), `'a b'\\''c'`);
});
