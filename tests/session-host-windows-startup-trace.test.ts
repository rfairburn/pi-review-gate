/**
 * Pure regressions for the Windows real-Main startup trace and its bounded
 * diagnostic formatter (Refs #494). No real Main, PTY, or Windows host is used;
 * a passing run here is not Windows host proof.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STARTUP_DIAGNOSTIC_MAX_CHARS,
  formatWindowsStartupDiagnostic,
  type StartupDiagnosticInput,
} from "./helpers/session-host-windows-startup-trace-contract";

interface StartupTrace {
  stage(name: string, fields?: Record<string, unknown>): void;
  observeChildProcess(childProcess: Record<string, unknown>): () => boolean;
  observeLoop(timers: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void }): () => void;
}

const traceModule = createRequire(join(process.cwd(), "package.json"))(
  join(process.cwd(), "tests", "fixtures", "session-host-windows-startup-trace.cjs"),
) as { createStartupTrace(options: Record<string, unknown>): StartupTrace };

function withJournal(run: (journal: string, read: () => Record<string, unknown>[]) => void): void {
  const root = mkdtempSync(join(tmpdir(), "prg-startup-trace-"));
  try {
    const journal = join(root, "runner-stages.jsonl");
    writeFileSync(journal, "");
    run(journal, () => readFileSync(journal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function baseInput(overrides: Partial<StartupDiagnosticInput> = {}): StartupDiagnosticInput {
  return {
    elapsedMs: 30_001, outerExit: undefined, outerPidKnown: true, dataChunks: 2, dataChars: 120,
    firstDataMs: 40, lastDataMs: 90, alternateEnter: false, alternateLeave: false, baselineVisible: true,
    cursorReportReplies: 1, deviceAttributeReplies: 0, ptySpawnRecords: 0, nativeRecords: 0,
    result: undefined, trace: [], ...overrides,
  };
}

test("the startup trace forwards synchronous child calls exactly and records only fixed metadata", () => {
  withJournal((journal, read) => {
    let clock = 0;
    const trace = traceModule.createStartupTrace({ journal, fs: require("node:fs"), now: () => clock });
    const returned = { status: null, signal: "SIGKILL", error: Object.assign(new Error("C:\\private\\path"), { code: "ETIMEDOUT" }) };
    const thrown = Object.assign(new Error("secret argv"), { status: 2, code: "EPIPE-like" });
    const receivers: unknown[] = [];
    const calls: unknown[][] = [];
    const childProcess: Record<string, unknown> = {
      spawnSync(this: unknown, ...args: unknown[]) { receivers.push(this); calls.push(args); clock += 15_000; return returned; },
      execFileSync(this: unknown, ...args: unknown[]) { receivers.push(this); calls.push(args); clock += 7; throw thrown; },
    };
    const originalSpawn = childProcess.spawnSync;
    const restore = trace.observeChildProcess(childProcess);
    assert.notEqual(childProcess.spawnSync, originalSpawn);
    const args = ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-EncodedCommand", "QUJD"], { input: "{\"path\":\"C:\\\\secret\"}" }];
    assert.equal((childProcess.spawnSync as (...a: unknown[]) => unknown).apply(childProcess, args), returned);
    assert.throws(() => (childProcess.execFileSync as (...a: unknown[]) => unknown).call(childProcess, "C:\\node.exe", ["C:\\pi\\cli.js", "--version"]),
      (error) => error === thrown);
    assert.deepEqual(calls[0], args, "the original receives the identical arguments");
    assert.deepEqual(receivers, [childProcess, childProcess], "the original receives the identical receiver");
    assert.equal(restore(), true);
    assert.equal(childProcess.spawnSync, originalSpawn, "restore reinstates the exact original");

    const records = read();
    const text = JSON.stringify(records);
    for (const forbidden of ["private", "secret", "QUJD", "cli.js", "Windows\\\\System32", "EPIPE"]) {
      assert.equal(text.includes(forbidden), false, `no ${forbidden} content is journaled`);
    }
    const ends = records.filter((record) => record.stage === "child-end");
    assert.deepEqual(ends.map((record) => [record.api, record.kind, record.shape, record.durationMs, record.status, record.signal, record.code, record.threw]), [
      ["spawnSync", "powershell", "encoded-command", 15_000, null, "SIGKILL", "ETIMEDOUT", false],
      ["execFileSync", "node", "version", 7, 2, null, "other", true],
    ]);
    assert.equal(records.filter((record) => record.stage === "child-begin").length, 2);
    assert.equal("stdoutWrites" in ends[0]!, false, "the trace reads no stdout census");
  });
});

test("a replaced child slot is never restored over, and a missing journal keeps the trace inert", () => {
  withJournal((journal) => {
    const trace = traceModule.createStartupTrace({ journal, fs: require("node:fs") });
    const childProcess: Record<string, unknown> = { spawnSync: () => "ok" };
    const restore = trace.observeChildProcess(childProcess);
    const foreign = () => "foreign";
    childProcess.spawnSync = foreign;
    assert.equal(restore(), false);
    assert.equal(childProcess.spawnSync, foreign);
  });
  const inert = traceModule.createStartupTrace({ journal: join(tmpdir(), "prg-absent-trace-journal.jsonl"), fs: require("node:fs") });
  const childProcess: Record<string, unknown> = { spawnSync: () => "ok" };
  const original = childProcess.spawnSync;
  inert.observeChildProcess(childProcess)();
  assert.equal(childProcess.spawnSync, original, "an inert trace installs nothing");
  inert.stage("runner-start");
});

test("stage fields keep only booleans, bounded integers, and fixed error names; loop gaps are reported", () => {
  withJournal((journal, read) => {
    let clock = 0;
    const trace = traceModule.createStartupTrace({ journal, fs: require("node:fs"), now: () => clock });
    trace.stage("main-threw", { errorName: "TypeError", message: "C:\\secret", status: 1.5, ok: true });
    trace.stage("not-a-stage");
    let tick: (() => void) | undefined;
    let cleared = false;
    const stop = trace.observeLoop({ setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => { cleared = true; } });
    clock = 250; tick!();
    clock = 12_250; tick!();
    stop();
    assert.equal(cleared, true);
    const records = read();
    assert.deepEqual(records.map((record) => record.stage), ["main-threw", "loop-gap"]);
    assert.equal(records[0]!.errorName, "TypeError");
    assert.equal(records[0]!.ok, true);
    assert.equal(records[0]!.status, null);
    assert.equal("message" in records[0]!, false);
    assert.equal(records[1]!.gapMs, 11_750);
  });
});

test("the startup diagnostic is fixed-vocabulary, bounded, and keeps the newest records", () => {
  const records: Record<string, unknown>[] = [{ v: 1, seq: 1, stage: "runner-start", ms: 2 }];
  for (let index = 0; index < 400; index += 1) {
    records.push({ v: 1, seq: records.length + 1, stage: "child-begin", ms: index * 10, id: index, api: "execFileSync", kind: "powershell", shape: "command" });
    records.push({ v: 1, seq: records.length + 1, stage: "child-end", ms: index * 10 + 5, id: index, api: "execFileSync", kind: "powershell",
      shape: "command", durationMs: 5, threw: false, status: 0, signal: null, code: null });
  }
  records.push({ v: 1, seq: 999, stage: "child-begin", ms: 9_999, id: 999, api: "spawnSync", kind: "powershell", shape: "encoded-command" });
  records.push({ v: 1, seq: 1000, stage: "C:\\private\\stage", ms: 1, injected: "S-1-5-21-secret" });
  const text = formatWindowsStartupDiagnostic(baseInput({
    trace: records,
    result: { status: 1, threw: true, rawBefore: false, stdinIsTTY: "C:\\secret", path: "C:\\private" },
  }));
  assert.ok(text.length <= STARTUP_DIAGNOSTIC_MAX_CHARS);
  for (const forbidden of ["private", "secret", "S-1-5"]) assert.equal(text.includes(forbidden), false, `no ${forbidden} content is printed`);
  assert.match(text, /outer=alive/);
  assert.match(text, /result=\{status=1,threw=true,stdinIsTTY=\?,rawBefore=false\}/);
  assert.match(text, /execFileSync:powershell\/commandx400\(open=0,total=2000ms,max=5ms,timeoutOrSignal=0\)/);
  assert.match(text, /spawnSync:powershell\/encoded-commandx1\(open=1/);
  assert.match(text, /child-begin\(spawnSync:powershell\/encoded-command#999\)@9999/, "the newest open call is shown");
  assert.match(text, /\?@1/, "an unknown stage is printed only as ?");

  const exited = formatWindowsStartupDiagnostic(baseInput({ outerExit: { exitCode: 1 }, result: "unreadable", trace: "unreadable", ptySpawnRecords: "unreadable" }));
  assert.match(exited, /outer=exited\(code=1,signal=-\)/);
  assert.match(exited, /result=unreadable/);
  assert.match(exited, /trace=unreadable/);
});

test("startup tracing between a split mode write never invalidates the real acceptance census", () => {
  const census = createRequire(join(process.cwd(), "package.json"))(
    join(process.cwd(), "tests", "fixtures", "session-host-windows-stdout-census.cjs"),
  ) as {
    createStdoutModeCensus(): unknown;
    installStdoutWriteCensus(stream: object, census: unknown, options: { streamIdentity: () => object }): {
      snapshot(): Record<string, unknown>;
      restore(): boolean;
    };
  };
  withJournal((journal, read) => {
    let clock = 0;
    const written: string[] = [];
    const stream = { write(chunk: string) { written.push(chunk); return true; } };
    const handle = census.installStdoutWriteCensus(stream, census.createStdoutModeCensus(), { streamIdentity: () => stream });
    const trace = traceModule.createStartupTrace({ journal, fs: require("node:fs"), now: () => clock });
    const childProcess: Record<string, unknown> = { spawnSync: () => ({ status: 0, signal: null }) };
    const restore = trace.observeChildProcess(childProcess);
    let tick: (() => void) | undefined;
    const stop = trace.observeLoop({ setInterval: (fn) => { tick = fn; return {}; }, clearInterval: () => undefined });

    stream.write("\x1b[?100");
    trace.stage("main-called");
    (childProcess.spawnSync as (...args: unknown[]) => unknown)("powershell.exe", ["-Command", "x"]);
    clock = 5_000; tick!();
    stream.write("6h");
    stop();
    restore();

    assert.deepEqual(read().map((record) => record.stage), ["main-called", "child-begin", "child-end", "loop-gap"],
      "every trace event ran between the prefix and the suffix");
    const snapshot = handle.snapshot();
    assert.equal(snapshot.observationComplete, true, "the acceptance census stays complete");
    assert.equal(snapshot.writeCalls, 2);
    assert.equal(snapshot.mouseSgrSet, 1, "the split mode request is counted exactly once");
    assert.deepEqual(written, ["\x1b[?100", "6h"]);
    assert.equal(handle.restore(), true);
  });
  const runner = readFileSync(join(process.cwd(), "tests", "fixtures", "session-host-windows-main-runner.cjs"), "utf8");
  assert.equal(runner.split("censusHandle.snapshot()").length - 1, 1,
    "only the explicit acceptance reply takes the stateful census snapshot");
});
