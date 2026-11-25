/**
 * Portable regressions for the #764 journal boundary: the test-only Windows PTY
 * journal writers must not collapse "node-pty reported no exit code" and "the
 * event carried a malformed exit code" into the same journaled value, because
 * the shared real-host assertion (`assertWindowsPtyExitRecord`) excuses only the
 * first.
 *
 * Both writers are driven with a real exit callback / real record builder and the
 * exact JSON boundary they cross (`JSON.stringify` on write, `JSON.parse` on
 * read), then every parsed record is checked through the shared assertion:
 *   - an actually-absent code is omitted from the record and becomes a
 *     diagnostic, never a failure;
 *   - a finite code is preserved (zero passes, nonzero fails);
 *   - null, a string, and NaN become the bounded `null` marker and still fail.
 *
 * No Windows host, PowerShell, or native PTY runs here: this is portable
 * serialization proof only, never Windows host proof.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { types as nodeUtilTypes } from "node:util";
import { runInNewContext } from "node:vm";

import { assertWindowsPtyExitRecord } from "./helpers/session-host-native-windows-harness";

const OBSERVER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-windows-pty-observer.cjs");
const READER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-windows-conpty-reader-helper.cjs");
const SYNTHETIC_PID = 4242;

interface JournalRecord {
  readonly [key: string]: unknown;
}

/** Exactly what one journaled line stores, as the reader-side JSON.parse sees it. */
function throughJson(record: JournalRecord): JournalRecord {
  return JSON.parse(JSON.stringify(record)) as JournalRecord;
}

interface Outcome {
  readonly record: JournalRecord;
  readonly diagnostics: string[];
  readonly failure?: Error;
}

/** Runs one parsed journal record through the shared real-host assertion. */
function assertRecord(record: JournalRecord): Outcome {
  const diagnostics: string[] = [];
  try {
    assertWindowsPtyExitRecord({
      exit: record,
      label: "SYNTHETIC-4242",
      diagnostic: (message) => {
        diagnostics.push(message);
      },
    });
  } catch (thrown) {
    return { record, diagnostics, failure: thrown as Error };
  }
  return { record, diagnostics };
}

/**
 * Installs the shared Main/launcher observer fixture over a synthetic public PTY
 * module and returns a driver for the fixture's own real `onExit` callback. The
 * journal sink applies the same JSON round trip the fixture's `appendMetadata`
 * and the harness's JSONL reader perform.
 */
function installSharedObserver(): (event: unknown) => JournalRecord {
  const source = readFileSync(OBSERVER_FIXTURE, "utf8");
  const declaration = source.slice(source.indexOf("function observePtyModule("), source.indexOf("module.exports"));
  assert.ok(declaration.startsWith("function observePtyModule("), "the shared observer declaration is locatable in its own fixture");
  const journaled: JournalRecord[] = [];
  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((event: unknown) => void)[] = [];
  let pid = 0;
  const handle: Record<string, unknown> = {
    get pid() {
      return pid;
    },
    onData(listener: (data: string) => void) {
      dataListeners.push(listener);
      return { dispose() { /* synthetic subscription */ } };
    },
    kill() {
      return "SYNTHETIC kill return";
    },
  };
  Object.defineProperty(handle, "onExit", {
    configurable: false,
    get: () => (listener: (event: unknown) => void) => {
      exitListeners.push(listener);
      return { dispose() { /* synthetic subscription */ } };
    },
  });
  const install = runInNewContext(`${declaration}\nobservePtyModule`, {
    process: { platform: "win32", on: () => { /* the synthetic exit hook is never armed */ } },
    types: nodeUtilTypes,
    appendMetadata: (_destination: string, record: JournalRecord) => {
      journaled.push(throughJson(record));
    },
  }) as (nodePty: { spawn: (...spawnArgs: unknown[]) => unknown }, journal: string) => unknown;
  const spawnArguments: unknown[][] = [];
  const nodePty = { spawn: (...spawnArgs: unknown[]) => { spawnArguments.push(spawnArgs); return handle; } };
  assert.ok(install(nodePty, "/synthetic/journal") !== undefined,
    "the shared observer installs over a synthetic public PTY module");
  // Everything below runs through the fixture's own wrapper, never around it.
  assert.equal(Reflect.apply(nodePty.spawn, nodePty, ["SYNTHETIC-node", ["SYNTHETIC-cli"], { cwd: "/synthetic/workspace" }]), handle,
    "the fixture returns the identical public handle");
  assert.equal(spawnArguments.length, 1, "the fixture forwards exactly one spawn");
  // The fixture only publishes the public PID through real public data delivery.
  pid = SYNTHETIC_PID;
  for (const listener of [...dataListeners]) listener("SYNTHETIC ignored terminal data");
  assert.equal(journaled.some((record) => record.type === "pty_spawn" && record.pid === SYNTHETIC_PID), true,
    "the synthetic handle published its positive public PID before any exit");
  assert.equal(exitListeners.length, 1, "the fixture subscribes to the read-only public onExit once");
  return (event: unknown) => {
    journaled.length = 0;
    for (const listener of exitListeners) listener(event);
    const exits = journaled.filter((record) => record.type === "pty_exit");
    assert.equal(exits.length, 1, "the driven onExit callback journaled exactly one pty_exit record");
    return exits[0]!;
  };
}

/** The ConPTY reader helper's exported bounded builders, required without starting it. */
interface ReaderFixture {
  journaledExitCode(value: unknown): JournalRecord;
  ptyExitRecord(pid: unknown, event: unknown): JournalRecord;
}

const readerFixture = createRequire(join(process.cwd(), "package.json"))(READER_FIXTURE) as ReaderFixture;

interface ExitCase {
  readonly name: string;
  readonly event: unknown;
  readonly expected: "pass" | "diagnostic" | "fail";
}

/** Only an actually-absent code is the #764 race; everything else stays strict. */
const EXIT_CASES: readonly ExitCase[] = [
  { name: "an omitted exitCode property", event: { signal: 0 }, expected: "diagnostic" },
  { name: "an explicitly undefined exitCode", event: { exitCode: undefined, signal: 0 }, expected: "diagnostic" },
  { name: "exit code zero", event: { exitCode: 0, signal: 0 }, expected: "pass" },
  { name: "a nonzero exit code", event: { exitCode: 3, signal: 0 }, expected: "fail" },
  { name: "a null exit code", event: { exitCode: null, signal: 0 }, expected: "fail" },
  { name: "a string exit code", event: { exitCode: "0", signal: 0 }, expected: "fail" },
  { name: "a NaN exit code", event: { exitCode: NaN, signal: 0 }, expected: "fail" },
];

function assertWriterCase(outcome: Outcome, testCase: ExitCase, writer: string): void {
  const { record } = outcome;
  assert.equal(record.type, "pty_exit", `${writer} ${testCase.name}: the journaled record type`);
  assert.equal(record.pid, SYNTHETIC_PID, `${writer} ${testCase.name}: the exact-pid witness survives serialization`);
  assert.equal(record.signal, 0, `${writer} ${testCase.name}: the no-signal witness survives serialization`);
  switch (testCase.expected) {
    case "pass":
      assert.equal(outcome.failure, undefined, `${writer} ${testCase.name}: a zero code must pass`);
      assert.deepEqual(outcome.diagnostics, [], `${writer} ${testCase.name}: a passing record emits no diagnostic`);
      assert.equal(record.exitCode, 0, `${writer} ${testCase.name}: a finite zero code is preserved exactly`);
      return;
    case "diagnostic":
      assert.equal(outcome.failure, undefined, `${writer} ${testCase.name}: the known race must not fail the lane`);
      assert.equal(outcome.diagnostics.length, 1, `${writer} ${testCase.name}: the known race emits one diagnostic`);
      assert.ok(outcome.diagnostics[0]!.includes("#764"), `${writer} ${testCase.name}: the diagnostic names #764`);
      assert.equal(Object.hasOwn(record, "exitCode"), false,
        `${writer} ${testCase.name}: an absent code is omitted, never journaled as a value`);
      return;
    case "fail":
      assert.ok(outcome.failure, `${writer} ${testCase.name}: a malformed or nonzero code must never be excused`);
      assert.deepEqual(outcome.diagnostics, [], `${writer} ${testCase.name}: a failure is never downgraded to a diagnostic`);
      if (testCase.name.includes("nonzero")) {
        assert.equal(record.exitCode, 3, `${writer} ${testCase.name}: a finite nonzero code is preserved exactly`);
      } else {
        assert.equal(record.exitCode, null, `${writer} ${testCase.name}: a malformed code becomes the bounded null marker`);
      }
      return;
  }
}

test("the shared Main/launcher PTY journal writer keeps an absent code distinguishable from a malformed one", () => {
  const driveExit = installSharedObserver();
  for (const testCase of EXIT_CASES) {
    assertWriterCase(assertRecord(driveExit(testCase.event)), testCase, "shared observer");
  }
});

test("the ConPTY reader helper keeps an absent code distinguishable from a malformed one", () => {
  for (const testCase of EXIT_CASES) {
    const record = throughJson(readerFixture.ptyExitRecord(SYNTHETIC_PID, testCase.event));
    assertWriterCase(assertRecord(record), testCase, "reader helper");
  }
});

test("requiring the reader helper fixture starts no owning helper and exports its bounded builder", () => {
  assert.equal(typeof readerFixture.ptyExitRecord, "function");
  assert.equal(typeof readerFixture.journaledExitCode, "function");
  assert.deepEqual(readerFixture.journaledExitCode(undefined), {}, "an absent code is omitted");
  assert.deepEqual(readerFixture.journaledExitCode(0), { exitCode: 0 }, "zero is a real code");
  assert.deepEqual(readerFixture.journaledExitCode(null), { exitCode: null }, "null is the rejection marker");
  assert.deepEqual(readerFixture.journaledExitCode(NaN), { exitCode: null }, "NaN is the rejection marker");
});

/**
 * The reader helper's callback itself cannot be driven portably (it spawns a real
 * ConPTY child), so this pins that its real `onExit` callback journals through the
 * builder tested above instead of building an exit-code field inline and drifting.
 */
test("the ConPTY reader helper's real onExit callback journals through the tested builder", () => {
  const source = readFileSync(READER_FIXTURE, "utf8");
  const start = source.indexOf("pty.onExit((event) => {");
  assert.ok(start > 0, "the owning helper subscribes to the public onExit callback");
  const callback = source.slice(start, start + 400);
  assert.ok(callback.includes("journal(journalFile, ptyExitRecord(pty.pid, event));"),
    "the real callback journals the tested bounded record builder, never an inline exit-code expression");
  assert.equal(callback.includes("exitCode"), false,
    "the callback builds no exit-code field of its own, so it cannot drift from the tested mapper");
});
