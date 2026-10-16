import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecFileException } from "node:child_process";
import type { Readable } from "node:stream";
import {
  awaitPiSettlementReceipt,
  createPiSettlementBootstrap,
  type PiSettlementBootstrap,
} from "../src/execution/pi-settlement-receipt";
import {
  MAX_QUERY_OUTPUT_BYTES,
  MAX_WINDOWS_PROCESS_ID,
  WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS,
  WINDOWS_LINEAGE_REFUSAL_REASONS,
  classifyWindowsAncestryEvidence,
  classifyWindowsLineageQueryFailure,
  isVerifiedWindowsAncestryEvidence,
  isWindowsLineageRefusalReason,
  verifyWindowsProcessLineage,
  type WindowsLineageQueryChild,
  type WindowsLineageQueryExecutor,
  type WindowsLineageQueryOptions,
} from "../src/execution/windows-process-lineage";

/**
 * Issue #335 diagnosis: the ORIGINAL Windows lineage verification invocation
 * now reports WHICH bounded stage refused, through one fixed sanitized stage
 * code appended to the existing settlement refusal. These regressions drive the
 * production orchestration (preflight → one bounded query child → native
 * sentinel / evidence validation → final owned-root liveness) with a mocked
 * query child plus the original boolean acceptance validator, and prove that
 * nothing about acceptance, bounds, ownership, timing, or privacy changed.
 */

const BASE_REFUSAL = "Pi executor settlement acknowledgement PID is not a verified live descendant of its owned shell.";
const FAKE_SECRET = "SUP3RSECRET-token-value";
const FAKE_PRIVATE_PATH = "C:\\Users\\vic\\secrets\\powershell.exe";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function evidenceRows(records: Array<{
  pid: number;
  parentPid: number;
  creationTicks: number;
  observedTicks?: number;
}>): string {
  const ticks = (value: number): string => String(value).padStart(19, "0");
  return records.map((record) => [
    record.pid,
    record.parentPid,
    ticks(record.observedTicks ?? record.creationTicks),
    ticks(record.creationTicks),
  ].join(",")).join(";");
}

const CANDIDATE_PID = 67890;
const OWNED_ROOT_PID = 4321;

const VALID_EVIDENCE = evidenceRows([
  { pid: CANDIDATE_PID, parentPid: 54321, creationTicks: 300 },
  { pid: 54321, parentPid: OWNED_ROOT_PID, creationTicks: 200 },
  { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
]);

/** A live owned cmd.exe root as the verifier observes it (`null` = no PID yet). */
function fakeOwnedRoot(pid: number | null = OWNED_ROOT_PID): ChildProcess {
  return { pid: pid ?? undefined, exitCode: null, signalCode: null } as unknown as ChildProcess;
}

function markRootExited(ownedRoot: ChildProcess): void {
  (ownedRoot as { exitCode: number | null }).exitCode = 0;
}

type FakeQueryBehavior =
  | { kind: "output"; output: string }
  | { kind: "error"; error: unknown }
  | { kind: "chunked"; stdoutChunks: string[]; stderrChunks: string[]; error: unknown };

interface FakeQuery {
  execute: WindowsLineageQueryExecutor;
  calls: Array<{ file: string; args: string[]; options: WindowsLineageQueryOptions }>;
  killCount: () => number;
}

/**
 * One mocked bounded query child. It settles asynchronously so the verifier
 * attaches its own output accounting first. `kill()` only signals the child: as
 * with a real `execFile` child, the query settles on its own completion callback,
 * never on the signal itself.
 */
function fakeQuery(
  behavior: FakeQueryBehavior,
  hooks: { beforeSettle?: () => void } = {},
): FakeQuery {
  const calls: FakeQuery["calls"] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = 0;
  let settled = false;
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const settle = (error: unknown, output = ""): void => {
    if (settled || !callback) return;
    settled = true;
    hooks.beforeSettle?.();
    callback(error as ExecFileException | null, output, "");
  };
  const child: WindowsLineageQueryChild = {
    kill: () => {
      killed += 1;
      return true;
    },
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
  };
  const execute: WindowsLineageQueryExecutor = (file, args, options, cb) => {
    calls.push({ file, args, options });
    callback = cb;
    if (behavior.kind === "output") setImmediate(() => settle(null, behavior.output));
    if (behavior.kind === "error") setImmediate(() => settle(behavior.error));
    if (behavior.kind === "chunked") {
      setImmediate(() => {
        for (const chunk of behavior.stdoutChunks) stdout.emit("data", chunk);
        for (const chunk of behavior.stderrChunks) stderr.emit("data", chunk);
        settle(behavior.error);
      });
    }
    return child;
  };
  return { execute, calls, killCount: () => killed };
}

/**
 * A query child that never settles on its own: the test decides when and how it
 * ends, so a refusal can only be attributed to a timeout when the verifier's own
 * deadline callback is what killed it.
 */
function fakeDeferredQuery(): FakeQuery & { settle: (error: unknown, output?: string) => void } {
  const calls: FakeQuery["calls"] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = 0;
  let settled = false;
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const execute: WindowsLineageQueryExecutor = (file, args, options, cb) => {
    calls.push({ file, args, options });
    callback = cb;
    const child: WindowsLineageQueryChild = {
      kill: () => {
        killed += 1;
        return true;
      },
      stdout: stdout as unknown as Readable,
      stderr: stderr as unknown as Readable,
    };
    return child;
  };
  return {
    execute,
    calls,
    killCount: () => killed,
    settle: (error, output = "") => {
      if (settled) return;
      settled = true;
      callback?.(error as ExecFileException | null, output, "");
    },
  };
}

interface ControllableQuery {
  execute: WindowsLineageQueryExecutor;
  calls: Array<{ file: string; args: string[]; options: WindowsLineageQueryOptions }>;
  killCount: () => number;
  /** Fire the executor's own completion callback, exactly as a real child would. */
  report: (error?: unknown, output?: string) => void;
}

/**
 * A query child whose whole lifecycle the test drives: `kill()` only counts (or
 * throws, for the failed-signal regression), and the executor callback runs only
 * when the test says so. That is the real `execFile` shape — signalling a child
 * and the callback that settles the query are two separate events.
 */
function fakeControllableQuery(hooks: { killThrows?: boolean } = {}): ControllableQuery {
  const calls: ControllableQuery["calls"] = [];
  let killCount = 0;
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const execute: WindowsLineageQueryExecutor = (file, args, options, cb) => {
    calls.push({ file, args, options });
    callback = cb;
    return {
      kill: () => {
        if (hooks.killThrows) throw new Error(`cannot signal the query child at ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`);
        killCount += 1;
        return true;
      },
      stdout: new EventEmitter() as unknown as Readable,
      stderr: new EventEmitter() as unknown as Readable,
    };
  };
  return {
    execute,
    calls,
    killCount: () => killCount,
    report: (error = null, output = "") => callback?.(error as ExecFileException | null, output, ""),
  };
}

/** Run every queued microtask and immediate, so a settled promise would be observed. */
function flushAsync(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

/** Drive the production verifier on a mocked win32 host with a mocked query child. */
async function verifyWithMockedQuery(
  query: FakeQuery,
  ownedRoot: ChildProcess = fakeOwnedRoot(),
  candidatePid: number = CANDIDATE_PID,
): Promise<{ verified: boolean; reason?: string }> {
  return await verifyWindowsProcessLineage(ownedRoot, candidatePid, { platform: "win32", execute: query.execute });
}

/** A SystemRoot the cross-host tests can control; production reads the parent's. */
async function withSystemRoot<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const savedRoot = process.env.SystemRoot;
  const savedWindir = process.env.WINDIR;
  if (value === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = value;
  delete process.env.WINDIR;
  try {
    return await fn();
  } finally {
    if (savedRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = savedRoot;
    if (savedWindir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = savedWindir;
  }
}

async function writeSignedReceipt(
  bootstrap: PiSettlementBootstrap,
  pid: number,
  settlement: number,
  corruptMac = false,
): Promise<void> {
  const unsigned = { version: 2, sessionId: bootstrap.sessionId, childId: bootstrap.childId, settlement, pid };
  const oneShot = createHmac("sha256", bootstrap.secret)
    .update(`pi-review-gate-live-browser-settlement-key:v2:${settlement}`)
    .digest();
  const mac = createHmac("sha256", oneShot)
    .update(JSON.stringify([unsigned.version, unsigned.sessionId, unsigned.childId, unsigned.settlement, unsigned.pid]))
    .digest("base64url");
  const writtenMac = corruptMac ? `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}` : mac;
  await mkdir(join(bootstrap.path, ".."), { recursive: true });
  await writeFile(bootstrap.path, `${JSON.stringify({ ...unsigned, mac: writtenMac })}\n`);
}

async function withReceiptRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "prg-lineage-diagnostics-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The refusal message one settlement wait produced, or an acceptance failure. */
async function refusalMessage(parent: PiSettlementBootstrap): Promise<string> {
  return await awaitPiSettlementReceipt(parent, 0, 100).then(
    () => { throw new Error("an unverified PID must never be accepted"); },
    (error: unknown) => (error as Error).message,
  );
}

// ---------------------------------------------------------------------------
// Production lineage orchestration through a mocked bounded query child
// ---------------------------------------------------------------------------

test("the original acceptance conditions are unchanged and report no refusal stage", async () => {
  const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
  assert.deepEqual(result, { verified: true }, "authentic bounded evidence still verifies");
  assert.equal(query.calls.length, 1, "exactly one bounded query child runs, never a retry");
  assert.equal(query.calls[0].file, join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.deepEqual(query.calls[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.deepEqual(query.calls[0].options, { encoding: "utf8", maxBuffer: 4096, windowsHide: true },
    "the query keeps its 4KiB output bound and stays hidden");
  assert.ok(!("timeout" in query.calls[0].options),
    "the verifier owns the deadline callback, so timeout evidence is positively witnessed");
  const script = query.calls[0].args[4];
  assert.match(script, /for \(\$step = 0; \$step -lt 64; \$step\+\+\)/, "the parent walk stays bounded to 64 steps");
  assert.ok(script.includes("PI_REVIEW_GATE_LINEAGE_NO:"), "every native refusal carries a fixed stage");
  assert.ok(!script.includes("CommandLine") && !script.includes("Get-Process"),
    "the bounded query still inspects no command lines, paths, or shim contents");
  assert.equal(isVerifiedWindowsAncestryEvidence(VALID_EVIDENCE, CANDIDATE_PID, OWNED_ROOT_PID), true,
    "the boolean acceptance view agrees with the typed result");
});

test("preflight refusals are fixed stages and never start a query child", async () => {
  const cases: Array<{ name: string; ownedRoot: ChildProcess; candidatePid: number; platform: NodeJS.Platform; expected: string }> = [
    { name: "non-win32 host", ownedRoot: fakeOwnedRoot(), candidatePid: CANDIDATE_PID, platform: "darwin", expected: "preflight-not-win32" },
    { name: "missing root pid", ownedRoot: fakeOwnedRoot(null), candidatePid: CANDIDATE_PID, platform: "win32", expected: "preflight-identity-invalid" },
    { name: "candidate equals the owned root", ownedRoot: fakeOwnedRoot(), candidatePid: OWNED_ROOT_PID, platform: "win32", expected: "preflight-identity-invalid" },
    { name: "non-positive candidate", ownedRoot: fakeOwnedRoot(), candidatePid: 0, platform: "win32", expected: "preflight-identity-invalid" },
    { name: "unsafe candidate", ownedRoot: fakeOwnedRoot(), candidatePid: Number.MAX_SAFE_INTEGER, platform: "win32", expected: "preflight-identity-invalid" },
  ];
  for (const testCase of cases) {
    const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
    const result = await verifyWindowsProcessLineage(testCase.ownedRoot, testCase.candidatePid, {
      platform: testCase.platform,
      execute: query.execute,
    });
    assert.equal(result.verified, false, `${testCase.name} must refuse`);
    assert.equal(result.verified === false && result.reason, testCase.expected, testCase.name);
    assert.equal(query.calls.length, 0, `${testCase.name} must not start a query child`);
  }

  // An already-exited owned root is refused before any query.
  const exitedRoot = fakeOwnedRoot();
  markRootExited(exitedRoot);
  const exitedQuery = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  const exited = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(exitedQuery, exitedRoot));
  assert.deepEqual(exited, { verified: false, reason: "preflight-owned-root-exited" });
  assert.equal(exitedQuery.calls.length, 0, "a dead owned root is never queried");

  // A missing or non-absolute SystemRoot is refused before any query.
  for (const value of [undefined, "not-absolute"]) {
    const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
    const result = await withSystemRoot(value, () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: "preflight-host-root-invalid" }, `SystemRoot ${String(value)}`);
    assert.equal(query.calls.length, 0, "an unvalidated host root is never queried");
  }
});

test("the owned deadline callback is the only source of timeout evidence", async (t) => {
  // A query that only the verifier's own deadline can end.
  const query = fakeDeferredQuery();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    t.mock.timers.tick(4_999);
    assert.equal(query.killCount(), 0, "the query is not killed before its full 5s bound");
    t.mock.timers.tick(1);
    // Authentic evidence that only lands after the owned deadline still refuses.
    query.settle(null, VALID_EVIDENCE);
    const result = await pending;
    assert.deepEqual(result, { verified: false, reason: "query-timeout" },
      "the fired owned timer callback is the positive timeout evidence, and a later result cannot be accepted");
    assert.equal(query.killCount(), 1, "the deadline callback still kills the one bounded child");
    assert.equal(query.calls.length, 1, "the timed-out query is never re-issued");
  } finally {
    t.mock.timers.reset();
  }

  // A normal completion clears the owned deadline instead of leaking it.
  const query2 = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const accepted = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query2));
    assert.deepEqual(accepted, { verified: true });
    // A cleared deadline cannot fire later: nothing kills a settled query.
    t.mock.timers.tick(60_000);
    assert.equal(query2.killCount(), 0, "the armed deadline is cleared once the query settles");
  } finally {
    t.mock.timers.reset();
  }
});

test("the owned deadline signals the one child, but only the query callback settles it", async (t) => {
  const query = fakeControllableQuery();
  let settled = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withSystemRoot("/fake-windows", () =>
      verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: query.execute }));
    void pending.then(() => { settled = true; });

    t.mock.timers.tick(4_999);
    await flushAsync();
    assert.equal(query.calls.length, 1, "exactly one bounded query child is started");
    assert.equal(query.killCount(), 0, "the child is not signalled before its full 5s bound");
    assert.equal(settled, false, "an unfinished query never settles the verification");

    t.mock.timers.tick(1);
    await flushAsync();
    assert.equal(query.killCount(), 1, "the owned deadline callback signals exactly the one bounded child");
    assert.equal(settled, false,
      "signalling is not settlement: the verification stays pending until the query's own completion callback runs");

    // Authentic evidence that only lands after the deadline can never be accepted.
    query.report(null, VALID_EVIDENCE);
    const result = await pending;
    assert.deepEqual(result, { verified: false, reason: "query-timeout" },
      "the positively witnessed timeout is final even when the callback arrives with no error");
    assert.equal(query.killCount(), 1, "the timed-out child is signalled once, never repeatedly");
    assert.equal(query.calls.length, 1, "a timed-out query is never re-issued");
  } finally {
    t.mock.timers.reset();
  }

  // A query that completes on its own clears the armed deadline instead of leaking it.
  const completed = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.deepEqual(await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(completed)), { verified: true });
    t.mock.timers.tick(60_000);
    assert.equal(completed.killCount(), 0, "the owned deadline is cleared once the query callback settles the query");
  } finally {
    t.mock.timers.reset();
  }
});

test("a deadline kill that throws cannot crash the session and never fakes settlement", async (t) => {
  const query = fakeControllableQuery({ killThrows: true });
  let settled = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withSystemRoot("/fake-windows", () =>
      verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: query.execute }));
    void pending.then(() => { settled = true; });

    t.mock.timers.tick(4_999);
    assert.doesNotThrow(() => t.mock.timers.tick(1),
      "a child that refuses to be signalled cannot turn the owned deadline callback into an uncaught exception");
    await flushAsync();
    assert.equal(settled, false, "a failed signal is not settlement and is never reported as a completed query");

    query.report(null, VALID_EVIDENCE);
    const result = await pending;
    assert.deepEqual(result, { verified: false, reason: "query-timeout" },
      "the witnessed deadline still refuses, and the state stays the truthful unconfirmed timeout");
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic"),
      `the thrown signal leaks nothing: ${reported}`);
  } finally {
    t.mock.timers.reset();
  }
});

test("a kill from any other source is never reported as a timeout", async () => {
  // The exact shape of Node's own kill error, without this module's timer firing.
  const killedError = Object.assign(new Error("child process terminated"), { killed: true, signal: "SIGTERM" });
  const query = fakeQuery({ kind: "error", error: killedError });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
  assert.deepEqual(result, { verified: false, reason: "query-failed" },
    "killed/signal/elapsed are never consulted, so an outside kill is not a timeout");
});

test("output-cap refusals come from the witnessed bound or the child's maxBuffer error", async () => {
  const maxBufferError = Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
  const byCode = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(fakeQuery({ kind: "error", error: maxBufferError })));
  assert.deepEqual(byCode, { verified: false, reason: "query-output-cap" });

  const oversized = "y".repeat(MAX_QUERY_OUTPUT_BYTES + 904);
  const byStdoutWitness = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({
      kind: "chunked",
      stdoutChunks: ["x".repeat(2048), "y".repeat(2048), "z".repeat(904)],
      stderrChunks: [],
      error: new Error("child process terminated"),
    }),
  ));
  assert.deepEqual(byStdoutWitness, { verified: false, reason: "query-output-cap" },
    "the verifier's own stdout accounting positively witnesses the 4KiB bound being crossed");

  const byStderrWitness = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({
      kind: "chunked",
      stdoutChunks: [],
      stderrChunks: [oversized],
      error: new Error("child process terminated"),
    }),
  ));
  assert.deepEqual(byStderrWitness, { verified: false, reason: "query-output-cap" },
    "the child's bound applies to each stream, so an oversized stderr alone is a witnessed cap");

  // Split-stream regression: two streams that are EACH within the bound are not
  // an output cap. Their combined size must never override the real cause.
  const splitStreams = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({
      kind: "chunked",
      stdoutChunks: ["x".repeat(3000)],
      stderrChunks: ["y".repeat(3000)],
      error: Object.assign(new Error(`Command failed: ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`), { code: 1 }),
    }),
  ));
  assert.deepEqual(splitStreams, { verified: false, reason: "query-nonzero-exit" },
    "two below-bound streams (6000 bytes combined) never claim an output cap the child never hit");

  // Below the bound, the same accounting must not invent a cap refusal.
  const small = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({ kind: "chunked", stdoutChunks: ["x".repeat(512)], stderrChunks: ["y".repeat(512)], error: new Error("child process terminated") }),
  ));
  assert.deepEqual(small, { verified: false, reason: "query-failed" });

  assert.equal(classifyWindowsLineageQueryFailure(new Error("boom"), { timedOut: false, stdoutBytes: MAX_QUERY_OUTPUT_BYTES, stderrBytes: MAX_QUERY_OUTPUT_BYTES }), "query-failed",
    "exactly at the bound on both streams is not over it");
  assert.equal(classifyWindowsLineageQueryFailure(new Error("boom"), { timedOut: false, stdoutBytes: MAX_QUERY_OUTPUT_BYTES + 1, stderrBytes: 0 }), "query-output-cap");
  assert.equal(classifyWindowsLineageQueryFailure(new Error("boom"), { timedOut: false, stdoutBytes: 0, stderrBytes: MAX_QUERY_OUTPUT_BYTES + 1 }), "query-output-cap");
  assert.equal(classifyWindowsLineageQueryFailure({ code: 1 }, { timedOut: false, stdoutBytes: 3000, stderrBytes: 3000 }), "query-nonzero-exit",
    "the classifier never combines streams into a cap");
  assert.equal(classifyWindowsLineageQueryFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, { timedOut: true, stdoutBytes: 0, stderrBytes: 0 }), "query-timeout",
    "a witnessed timeout outranks a concurrent kill cause");
});

test("query spawn, nonzero-exit, and unclassified failures are distinct fixed stages", async () => {
  const spawnError = Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} ENOENT ${FAKE_SECRET}`), { code: "ENOENT" });
  const nonzeroError = Object.assign(new Error(`Command failed: ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`), { code: 1 });
  const opaqueError = new Error(`powershell.exe exited oddly ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`);
  const cases: Array<[unknown, string]> = [
    [spawnError, "query-spawn-failed"],
    [nonzeroError, "query-nonzero-exit"],
    [opaqueError, "query-failed"],
  ];
  for (const [error, expected] of cases) {
    const query = fakeQuery({ kind: "error", error });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: expected });
    assert.equal(query.calls.length, 1, "a failed query is never retried");
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic"),
      `the ${expected} stage carries no error text or host path: ${reported}`);
  }
});

test("an unknown string error code is never attributed to a spawn failure", async () => {
  // Only a known OS spawn errno can claim the child never started. Node-internal
  // `ERR_*` codes, host- or library-supplied codes, and near-miss spellings say
  // nothing about whether the child started, so they stay unclassified.
  const unsupportedCodes = [
    "ERR_INVALID_ARG_TYPE",
    "ERR_CHILD_PROCESS_IPC_REQUIRED",
    "ERR_UNKNOWN_SYSCALL_CODE",
    "ENOENTISH",
    "ENOENT-ish",
    "not-a-code",
    "",
  ];
  for (const code of unsupportedCodes) {
    const error = Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} ${code} ${FAKE_SECRET}`), { code });
    assert.equal(classifyWindowsLineageQueryFailure(error, { timedOut: false, stdoutBytes: 0, stderrBytes: 0 }), "query-failed",
      `${JSON.stringify(code)} is not a known spawn errno, so no spawn cause may be claimed`);

    const query = fakeQuery({ kind: "error", error });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: "query-failed" }, JSON.stringify(code));
    assert.equal(query.calls.length, 1, "an unclassified query failure is never retried");
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic") && !reported.includes("ERR_"),
      `the ${JSON.stringify(code)} stage carries no raw code, error text, or host path: ${reported}`);
  }

  // The known spawn errnos keep their existing attribution.
  for (const code of ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ENOEXEC"]) {
    assert.equal(classifyWindowsLineageQueryFailure(Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} failed`), { code }),
      { timedOut: false, stdoutBytes: 0, stderrBytes: 0 }), "query-spawn-failed", code);
  }
  // A witnessed timeout and a real maxBuffer error still outrank any code.
  assert.equal(classifyWindowsLineageQueryFailure({ code: "ERR_CHILD_PROCESS_IPC_REQUIRED" }, { timedOut: true, stdoutBytes: 0, stderrBytes: 0 }), "query-timeout");
  assert.equal(classifyWindowsLineageQueryFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, { timedOut: false, stdoutBytes: 0, stderrBytes: 0 }), "query-output-cap");
});

test("every native sentinel stage is reported verbatim and an unknown sentinel fails closed", async () => {
  for (const stage of WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS) {
    const query = fakeQuery({ kind: "output", output: `PI_REVIEW_GATE_LINEAGE_NO:${stage}\n` });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: stage }, `native sentinel ${stage}`);
    assert.equal(isVerifiedWindowsAncestryEvidence(`PI_REVIEW_GATE_LINEAGE_NO:${stage}`, CANDIDATE_PID, OWNED_ROOT_PID), false);
  }
  for (const output of [
    "PI_REVIEW_GATE_LINEAGE_NO",
    "PI_REVIEW_GATE_LINEAGE_NO:not-a-stage",
    `PI_REVIEW_GATE_LINEAGE_NO:${FAKE_PRIVATE_PATH}`,
  ]) {
    const query = fakeQuery({ kind: "output", output });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: "sentinel-unrecognized" }, output);
    assert.ok(!JSON.stringify(result).includes("vic"), "an unrecognizable sentinel reports no payload");
  }
});

test("the evidence validator refuses each malformed or unrelated shape with its fixed stage", () => {
  const cases: Array<{ name: string; output: string; candidate: number; root: number; expected: string }> = [
    { name: "empty output", output: "", candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-bound-violation" },
    {
      name: "single row",
      output: evidenceRows([{ pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 300 }]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-bound-violation",
    },
    {
      name: "beyond 64 parent steps",
      output: evidenceRows([
        { pid: 90000, parentPid: 90001, creationTicks: 5000 },
        ...Array.from({ length: 64 }, (_, index) => ({
          pid: 90001 + index,
          parentPid: index === 63 ? OWNED_ROOT_PID : 90002 + index,
          creationTicks: 4999 - index,
        })),
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 900 },
      ]),
      candidate: 90000, root: OWNED_ROOT_PID, expected: "evidence-bound-violation",
    },
    {
      name: "extra evidence field",
      output: `67890,54321,${"0".repeat(18)}1,${"0".repeat(18)}1,extra;4321,4,${"0".repeat(18)}1,${"0".repeat(18)}1`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "short creation ticks",
      output: `67890,4321,123,123;4321,4,456,456`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "ticks beyond DateTime.MaxValue",
      output: `67890,4321,3155378976000000000,3155378976000000000;4321,4,1,1`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "non-numeric pid token",
      output: `67a90,4321,${"0".repeat(18)}1,${"0".repeat(18)}1;4321,4,${"0".repeat(18)}1,${"0".repeat(18)}1`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "unstable creation snapshot",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 100, observedTicks: 101 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-snapshot-unstable",
    },
    { name: "candidate is not the chain head", output: VALID_EVIDENCE, candidate: 54321, root: OWNED_ROOT_PID, expected: "evidence-candidate-mismatch" },
    { name: "chain ends at another root", output: VALID_EVIDENCE, candidate: CANDIDATE_PID, root: 10000, expected: "evidence-owned-root-mismatch" },
    { name: "candidate equals the owned root", output: VALID_EVIDENCE, candidate: OWNED_ROOT_PID, root: OWNED_ROOT_PID, expected: "evidence-identity-invalid" },
    { name: "candidate pid zero", output: VALID_EVIDENCE, candidate: 0, root: OWNED_ROOT_PID, expected: "evidence-identity-invalid" },
    {
      name: "duplicated pid (cycle)",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 300 },
        { pid: OWNED_ROOT_PID, parentPid: OWNED_ROOT_PID, creationTicks: 200 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-duplicate-pid",
    },
    {
      name: "broken parent link",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: 54321, creationTicks: 300 },
        { pid: 999, parentPid: OWNED_ROOT_PID, creationTicks: 200 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-chain-broken",
    },
    {
      name: "recycled parent created after its child",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 100 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 200 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-creation-order-invalid",
    },
  ];
  for (const testCase of cases) {
    const result = classifyWindowsAncestryEvidence(testCase.output, testCase.candidate, testCase.root);
    assert.equal(result.verified, false, `${testCase.name} must refuse`);
    assert.equal(result.verified === false && result.reason, testCase.expected, testCase.name);
    assert.equal(isVerifiedWindowsAncestryEvidence(testCase.output, testCase.candidate, testCase.root), false,
      `${testCase.name} must not be accepted by the boolean view either`);
    assert.ok(result.verified === false && isWindowsLineageRefusalReason(result.reason), `${testCase.name} reports a fixed stage`);
  }
  assert.deepEqual(classifyWindowsAncestryEvidence(VALID_EVIDENCE, CANDIDATE_PID, OWNED_ROOT_PID), { verified: true });
});

test("the owned root exiting during the query refuses at the final liveness check", async () => {
  const ownedRoot = fakeOwnedRoot();
  const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE }, { beforeSettle: () => markRootExited(ownedRoot) });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query, ownedRoot));
  assert.deepEqual(result, { verified: false, reason: "owned-root-exited-after-query" },
    "authentic evidence cannot bind a PID to an owned root that already exited");
  assert.equal(query.calls.length, 1, "the race is observed, never re-queried");
});

test("every refusal stage is a fixed code and carries no output, path, PID, or error text", async () => {
  const leakingError = Object.assign(new Error(`powershell at ${FAKE_PRIVATE_PATH} failed with ${FAKE_SECRET}`), { code: 3 });
  const leakyOutput = `${FAKE_PRIVATE_PATH};pid=999;secret=${FAKE_SECRET}`;
  const behaviors: FakeQueryBehavior[] = [
    { kind: "error", error: leakingError },
    { kind: "output", output: leakyOutput },
    { kind: "output", output: "PI_REVIEW_GATE_LINEAGE_NO" },
    { kind: "chunked", stdoutChunks: ["x".repeat(9000)], stderrChunks: [], error: leakingError },
    { kind: "chunked", stdoutChunks: ["x".repeat(3000)], stderrChunks: ["y".repeat(3000)], error: leakingError },
  ];
  for (const behavior of behaviors) {
    const query = fakeQuery(behavior);
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.equal(result.verified, false, JSON.stringify(result));
    assert.ok(result.verified === false && isWindowsLineageRefusalReason(result.reason), behavior.kind);
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic") && !reported.includes("999"),
      `${behavior.kind} leaked a sanitized value: ${reported}`);
  }
  // The stage list itself is closed: only these literals can ever be reported.
  for (const stage of WINDOWS_LINEAGE_REFUSAL_REASONS) {
    assert.equal(isWindowsLineageRefusalReason(stage), true, stage);
  }
  for (const notAStage of ["", "unknown", "verifier-error", FAKE_SECRET, FAKE_PRIVATE_PATH, 42, null]) {
    assert.equal(isWindowsLineageRefusalReason(notAStage), false, String(notAStage));
  }
});

// ---------------------------------------------------------------------------
// The refusal the settlement receipt actually reports
// ---------------------------------------------------------------------------

test("typed lineage acceptance binds the verified PID on the unchanged success path", async () => {
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "typed-lineage-session");
    const seen: number[] = [];
    parent.verifySpawnedPid = async (pid) => {
      seen.push(pid);
      return { verified: isVerifiedWindowsAncestryEvidence(VALID_EVIDENCE, pid, OWNED_ROOT_PID) };
    };
    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.deepEqual(seen, [CANDIDATE_PID]);
    assert.equal(parent.pid, CANDIDATE_PID, "the verified actual Pi PID is bound after lineage proof");
  });
});

test("a typed lineage refusal appends only the fixed stage to the recognizable wording", async () => {
  for (const stage of ["chain-cycle", "query-timeout", "query-output-cap", "snapshot-creation-mismatch", "owned-root-exited-after-query"]) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, `refusal-${stage}`);
      parent.verifySpawnedPid = async () => ({ verified: false, reason: stage });
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      const message = await refusalMessage(parent);
      assert.ok(message.startsWith(BASE_REFUSAL), `base refusal wording stays recognizable: ${message}`);
      assert.equal(message, `${BASE_REFUSAL} [lineage stage: ${stage}]`);
      assert.equal(parent.pid, undefined, `${stage} must not bind a PID`);
    });
  }
});

test("legacy boolean lineage callers keep the exact original refusal wording", async () => {
  for (const verify of [() => false as boolean, async () => false as boolean]) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, "boolean-lineage");
      parent.verifySpawnedPid = verify;
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      assert.equal(await refusalMessage(parent), BASE_REFUSAL, "boolean callers report no stage");
      assert.equal(parent.pid, undefined);
    });
  }
});

test("a truthy lineage result is never acceptance", async () => {
  const refused: unknown[] = ["true", 1, {}, [], { verified: "true" }, { verified: 1 }, { verified: false }, new Date(0)];
  for (const value of refused) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, "truthy-lineage");
      parent.verifySpawnedPid = () => value as { verified: boolean };
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      const message = await refusalMessage(parent);
      assert.equal(message, `${BASE_REFUSAL} [lineage stage: unknown]`, JSON.stringify(String(value)));
      assert.equal(parent.pid, undefined, `${String(value)} must never bind a PID`);
    });
  }
  // Only strict `verified === true` accepts, even when a stage rides along.
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "strict-truthy-lineage");
    parent.verifySpawnedPid = async () => ({ verified: true, reason: "chain-cycle" });
    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.equal(parent.pid, CANDIDATE_PID);
  });
});

test("a malformed or private stage value is replaced by the fixed unknown stage", async () => {
  for (const reason of [`${FAKE_PRIVATE_PATH}\\${FAKE_SECRET}`, FAKE_SECRET, 42, { nested: FAKE_SECRET }, null, undefined, ""]) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, "malformed-stage");
      parent.verifySpawnedPid = async () => ({ verified: false, reason });
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      const message = await refusalMessage(parent);
      assert.equal(message, `${BASE_REFUSAL} [lineage stage: unknown]`);
      assert.ok(!message.includes(FAKE_SECRET) && !message.includes("vic"), message);
      assert.equal(parent.pid, undefined);
    });
  }
});

test("a thrown lineage verifier reports the fixed verifier-error stage without the thrown value", async () => {
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "throwing-lineage");
    parent.verifySpawnedPid = () => {
      throw new Error(`lineage query could not run ${FAKE_PRIVATE_PATH} token=${FAKE_SECRET}`);
    };
    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    const message = await refusalMessage(parent);
    assert.equal(message, `${BASE_REFUSAL} [lineage stage: verifier-error]`);
    assert.ok(!message.includes(FAKE_SECRET) && !message.includes("vic"), message);
    assert.equal(parent.pid, undefined, "a verifier exception never binds a PID");
  });
});

test("the receipt signature is authenticated before the lineage verifier runs", async () => {
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "hmac-first");
    let calls = 0;
    parent.verifySpawnedPid = () => {
      calls += 1;
      return { verified: true };
    };
    await writeSignedReceipt(parent, CANDIDATE_PID, 1, true);
    await assert.rejects(awaitPiSettlementReceipt(parent, 0, 100), /signature is invalid/);
    assert.equal(calls, 0, "an unauthenticated PID never reaches the lineage verifier");
    assert.equal(parent.pid, undefined, "a bad HMAC never binds a PID and never reports a lineage stage");

    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.equal(calls, 1);
    assert.equal(parent.pid, CANDIDATE_PID);

    await writeSignedReceipt(parent, CANDIDATE_PID + 1, 2);
    await assert.rejects(awaitPiSettlementReceipt(parent, 1, 100), /does not match/);
    assert.equal(calls, 1, "later receipt PIDs use the bound identity, not another lineage proof");
    assert.equal(parent.pid, CANDIDATE_PID);
  });
});

// ---------------------------------------------------------------------------
// Owned-process identity handshake (cross-platform; used by the win32 fixture)
// ---------------------------------------------------------------------------

/**
 * A native fixture ownership frame is exactly one newline-terminated line that
 * is either `PRG-PID:<pid>` or `PRG-ERR:<reason>`. Nothing else is interpretable,
 * so a partial chunk, a truncated stream, or a failed inner spawn can never be
 * mistaken for a process identity that cleanup later signals.
 */
const OWNED_PID_LINE = /^PRG-PID:([1-9]\d{0,9})$/;
const OWNED_ABSENT_LINE = /^PRG-ERR:([A-Za-z0-9._-]{1,64})$/;
const OWNED_PID_TEXT = /^([1-9]\d{0,9})$/;
const MAX_OWNED_FRAME_BYTES = 256;

/** Parse one owned PID text into a usable PID, or refuse. Never a guess. */
function parseOwnedPid(text: string): number | undefined {
  const match = OWNED_PID_TEXT.exec(text.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_WINDOWS_PROCESS_ID ? pid : undefined;
}

interface OwnedPidHandshake {
  /** Feed raw stdout text; a PID is adopted only from one complete frame. */
  feed(chunk: string): void;
  /** Record a transport-level failure (early exit, spawn error, expired bound). */
  fail(reason: string): void;
  readonly pid: number | undefined;
  readonly failure: string | undefined;
  /** True only when the owned root positively reported it has no descendant. */
  readonly reportedAbsent: boolean;
  readonly settled: boolean;
}

function createOwnedPidHandshake(): OwnedPidHandshake {
  let buffer = "";
  let pid: number | undefined;
  let failure: string | undefined;
  let reportedAbsent = false;
  let settled = false;
  const stop = (reason?: string, adopted?: number): void => {
    settled = true;
    if (reason !== undefined) failure = reason;
    if (adopted !== undefined) pid = adopted;
  };
  return {
    feed(chunk: string): void {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > MAX_OWNED_FRAME_BYTES) {
        stop(`ownership frame exceeded ${MAX_OWNED_FRAME_BYTES} bytes without a complete line`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      const pidLine = OWNED_PID_LINE.exec(line);
      if (pidLine) {
        const adopted = parseOwnedPid(pidLine[1] ?? "");
        if (adopted !== undefined) stop(undefined, adopted);
        else stop(`ownership frame ${JSON.stringify(line)} is not a usable process id`);
        return;
      }
      const absentLine = OWNED_ABSENT_LINE.exec(line);
      if (absentLine) {
        reportedAbsent = true;
        stop(`owned root reported ${absentLine[1]}`);
        return;
      }
      stop(`malformed ownership frame ${JSON.stringify(line)}`);
    },
    fail(reason: string): void {
      if (!settled) stop(reason);
    },
    get pid(): number | undefined {
      return pid;
    },
    get failure(): string | undefined {
      return failure;
    },
    get reportedAbsent(): boolean {
      return reportedAbsent;
    },
    get settled(): boolean {
      return settled;
    },
  };
}

/** Bounded poll until the handshake settles; expiry is a recorded failure. */
async function waitForHandshake(handshake: OwnedPidHandshake, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!handshake.settled) {
    if (Date.now() > deadline) {
      handshake.fail("the owned root did not report an ownership frame within the bounded wait");
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

test("a split ownership frame yields a PID only once it is complete and validated", () => {
  const split = createOwnedPidHandshake();
  split.feed("PRG-PI");
  assert.equal(split.pid, undefined, "a partial frame prefix is not an identity");
  assert.equal(split.settled, false);
  split.feed("D:4242");
  assert.equal(split.pid, undefined, "a complete PID without its terminator is not an identity");
  assert.equal(split.settled, false);
  split.feed("\n");
  assert.equal(split.pid, 4242, "one complete validated frame adopts the PID");
  assert.equal(split.failure, undefined);
  assert.equal(split.settled, true);
  split.feed("PRG-PID:9999\n");
  assert.equal(split.pid, 4242, "a settled handshake never adopts a second identity");
});

test("missing, malformed, and truncated ownership messages never yield a PID", () => {
  const malformed = [
    "4242\n",
    "PRG-PID:abc\n",
    "PRG-PID:undefined\n",
    "PRG-PID:NaN\n",
    "PRG-PID:0\n",
    "PRG-PID:-7\n",
    "PRG-PID:12.5\n",
    "PRG-PID:1234567890123\n",
    "PRG-PID:9999999999\n",
    "PRG-PID:4242",
    "\n",
    "PRG-ERR:not a frame token\n",
  ];
  for (const chunk of malformed) {
    const handshake = createOwnedPidHandshake();
    handshake.feed(chunk);
    assert.equal(handshake.pid, undefined, `${JSON.stringify(chunk)} must never adopt a PID`);
    if (!chunk.endsWith("\n")) {
      assert.equal(handshake.settled, false, `${JSON.stringify(chunk)} is incomplete, not malformed`);
      continue;
    }
    assert.equal(handshake.settled, true, `${JSON.stringify(chunk)} settles as a refusal`);
    assert.ok(handshake.failure !== undefined, `${JSON.stringify(chunk)} reports why it refused`);
  }

  // A usable PID above the process-id bound is refused, not truncated.
  const oversizedPid = createOwnedPidHandshake();
  oversizedPid.feed("PRG-PID:4294967296\n");
  assert.equal(oversizedPid.pid, undefined);
  assert.match(oversizedPid.failure ?? "", /not a usable process id/);

  // Partial digits then a lost stream: the identity was never complete.
  const truncated = createOwnedPidHandshake();
  truncated.feed("PRG-PID:12");
  truncated.fail("the owned root exited early with 1");
  assert.equal(truncated.pid, undefined, "a truncated PID is never signalled as a process");
  assert.match(truncated.failure ?? "", /exited early/);

  // An unframed flood fails closed instead of scanning for digits.
  const flooded = createOwnedPidHandshake();
  flooded.feed("x".repeat(MAX_OWNED_FRAME_BYTES + 32));
  assert.equal(flooded.pid, undefined);
  assert.match(flooded.failure ?? "", /exceeded/);

  // Positive absence is distinguishable from a lost handshake.
  const absent = createOwnedPidHandshake();
  absent.feed("PRG-ERR:descendant-spawn-failed\n");
  assert.equal(absent.pid, undefined);
  assert.equal(absent.reportedAbsent, true, "the root positively reported no descendant");
  const lost = createOwnedPidHandshake();
  lost.fail("the bounded wait expired");
  assert.equal(lost.pid, undefined);
  assert.equal(lost.reportedAbsent, false, "a lost handshake must be treated as a possible orphan");
});

test("ownership PID files are only read as complete validated identities", () => {
  assert.equal(parseOwnedPid("4242"), 4242);
  assert.equal(parseOwnedPid("  4242\n"), 4242);
  for (const text of ["", "   ", "abc", "NaN", "undefined", "0", "-7", "12.5", "4242 extra", "99999999999", "4294967296"]) {
    assert.equal(parseOwnedPid(text), undefined, `${JSON.stringify(text)} is not a usable PID`);
  }
});

// ---------------------------------------------------------------------------
// Owned fixture teardown (cross-platform contract, used by the win32 fixture)
// ---------------------------------------------------------------------------

/** An unusable identity is never "live", so cleanup can never signal NaN. */
function pidIsLive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_WINDOWS_PROCESS_ID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Never let fixture teardown become an unbounded wait. */
async function bounded<T>(what: string, promise: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded wait for a positively-owned fixture PID to be gone. */
async function waitForPidGone(
  pid: number,
  isLive: (pid: number) => boolean = pidIsLive,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isLive(pid)) {
    if (Date.now() > deadline) throw new Error(`owned fixture pid ${pid} never settled`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

/**
 * A close wait settles only on the child's own `close` event. An `error` event is
 * not closure evidence — a failed signal or a stream failure says nothing about
 * whether the process is gone — so treating its rejection as settlement would
 * let teardown delete ownership records for a process that may still be running.
 */
function closeSettled(child: { once: (event: "close", listener: () => void) => unknown }): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
  });
}

interface OwnedFixtureChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill: () => boolean;
}

interface OwnedFixtureCleanupPlan {
  fixtureDir: string;
  direct: Array<{ label: string; child: OwnedFixtureChild; closed: Promise<void> }>;
  /** The fixture whose descendants must be terminated as a tree, if any. */
  ownedTreeRoot?: OwnedFixtureChild;
  descendantPids: Iterable<number>;
  /** True when a validated identity was adopted, or absence was positively reported. */
  ownershipConfirmed: boolean;
  terminateOwnedTree?: (rootPid: number) => string[];
  isLive?: (pid: number) => boolean;
  signalPid?: (pid: number) => void;
  boundMs?: number;
}

interface OwnedFixtureCleanupResult {
  problems: string[];
  /** Set whenever settlement stayed unconfirmed and the records were kept. */
  retainedFixtureDir: string | undefined;
}

const terminateOwnedWindowsTree = (rootPid: number): string[] => {
  if (process.platform !== "win32") return [];
  const tree = spawnSync("taskkill", ["/T", "/F", "/PID", String(rootPid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (tree.error || (tree.status ?? 1) !== 0) {
    return [`owned tree termination reported ${String(tree.status ?? tree.error?.message ?? "unknown")}`];
  }
  return [];
};

/**
 * Teardown for the native lineage fixture. Every step is individually guarded and
 * individually bounded, so one failure can never strand another fixture; the
 * ownership records are removed only after both direct fixtures actually closed,
 * every recorded descendant actually stopped being live, and descendant ownership
 * was confirmed or positively reported absent. Otherwise the directory is
 * retained and reported, because deleting the only ownership evidence while a
 * fixture may still be running is the worse failure.
 */
async function cleanupOwnedFixtures(plan: OwnedFixtureCleanupPlan): Promise<OwnedFixtureCleanupResult> {
  const problems: string[] = [];
  const isLive = plan.isLive ?? pidIsLive;
  const signalPid = plan.signalPid ?? ((pid: number): void => { process.kill(pid); });
  const boundMs = plan.boundMs ?? 20_000;
  const descendants = [...plan.descendantPids].filter((pid) => Number.isSafeInteger(pid) && pid > 0);

  // Terminate the owned tree while its root is still alive: on Windows a signal
  // to the Node root does not terminate its descendants.
  const root = plan.ownedTreeRoot;
  if (root !== undefined && root.pid !== undefined && root.exitCode === null && root.signalCode === null) {
    const treeProblems = (plan.terminateOwnedTree ?? terminateOwnedWindowsTree)(root.pid);
    problems.push(...treeProblems);
    if (treeProblems.length > 0) {
      try {
        root.kill();
      } catch (error) {
        problems.push(`owned root signal failed: ${String(error)}`);
      }
    }
  }
  for (const pid of descendants) {
    if (!isLive(pid)) continue;
    try {
      signalPid(pid);
    } catch (error) {
      problems.push(`descendant pid ${pid} signal failed: ${String(error)}`);
    }
  }
  for (const { label, child } of plan.direct) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch (error) {
        problems.push(`${label} signal failed: ${String(error)}`);
      }
    }
  }

  let settled = true;
  for (const { label, closed } of plan.direct) {
    try {
      await bounded(`${label} close`, closed, boundMs);
    } catch (error) {
      settled = false;
      problems.push(String(error));
    }
  }
  for (const pid of descendants) {
    try {
      await bounded(`descendant pid ${pid} exit`, waitForPidGone(pid, isLive, boundMs), boundMs + 1_000);
    } catch (error) {
      settled = false;
      problems.push(String(error));
    }
  }
  if (!plan.ownershipConfirmed) {
    settled = false;
    problems.push("descendant ownership could not be confirmed: no validated frame or ownership record, and no positive absence report");
  }

  if (!settled) {
    return {
      problems: [...problems, `fixture directory retained pending confirmed process settlement: ${plan.fixtureDir}`],
      retainedFixtureDir: plan.fixtureDir,
    };
  }
  try {
    await rm(plan.fixtureDir, { recursive: true, force: true });
  } catch (error) {
    problems.push(`fixture directory cleanup failed: ${String(error)}`);
  }
  return { problems, retainedFixtureDir: undefined };
}

test("a close wait settles only on close, never on an error or exit event", async () => {
  const child = new EventEmitter();
  // Exactly the real fixture's shape: an error listener exists so a failed signal
  // is handled, while closure is proven only by `close`.
  child.on("error", () => undefined);
  const closed = closeSettled(child as unknown as Parameters<typeof closeSettled>[0]);
  let settled = false;
  void closed.then(() => { settled = true; });

  child.emit("error", new Error("signal failed"));
  child.emit("exit", 1, null);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(settled, false, "an error or exit event is not process closure evidence");

  child.emit("close", 1, null);
  await bounded("close wait", closed, 1_000);
  assert.equal(settled, true, "only the close event settles the wait");
});

async function withScratchFixtureDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "prg-lineage-teardown-"));
  await writeFile(join(dir, "root-seen-pid.txt"), "4242");
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const settledClose = (): Promise<void> => Promise.resolve();

/** Live for the first check (so the descendant is signalled), gone afterwards. */
const liveOnce = (): (() => boolean) => {
  let checks = 0;
  return () => (checks += 1) === 1;
};

test("teardown removes ownership records only after every fixture settles", async () => {
  await withScratchFixtureDir(async (fixtureDir) => {
    const signals: Array<number | string> = [];
    const root = { pid: 4242, exitCode: null, signalCode: null, kill: () => { signals.push("root"); return true; } };
    const unrelated = { pid: 4300, exitCode: 0, signalCode: null, kill: () => { signals.push("unrelated"); return true; } };
    const result = await cleanupOwnedFixtures({
      fixtureDir,
      direct: [
        { label: "owned root", child: root, closed: settledClose() },
        { label: "unrelated fixture", child: unrelated, closed: settledClose() },
      ],
      ownedTreeRoot: root,
      descendantPids: [4243],
      ownershipConfirmed: true,
      terminateOwnedTree: (pid) => { signals.push(`tree:${pid}`); return []; },
      isLive: liveOnce(),
      signalPid: (pid) => { signals.push(pid); },
      boundMs: 200,
    });
    assert.deepEqual(result.problems, [], "a fully settled teardown reports nothing wrong");
    assert.equal(result.retainedFixtureDir, undefined);
    assert.deepEqual(signals, ["tree:4242", 4243, "root"],
      "the owned tree is terminated first, then the live descendant, then the still-running root");
    await assert.rejects(readFile(join(fixtureDir, "root-seen-pid.txt"), "utf8"), { code: "ENOENT" },
      "records are removed only once settlement is confirmed");
  });
});

test("an unconfirmed close or descendant exit retains the ownership records", async () => {
  const never = new Promise<void>(() => undefined);
  const cases: Array<{ name: string; plan: (fixtureDir: string) => OwnedFixtureCleanupPlan }> = [
    {
      name: "close wait timeout",
      plan: (fixtureDir) => ({
        fixtureDir,
        direct: [
          {
            label: "owned root",
            child: { pid: 4242, exitCode: null, signalCode: null, kill: () => true },
            closed: never,
          },
        ],
        descendantPids: [],
        ownershipConfirmed: true,
        terminateOwnedTree: () => [],
        isLive: () => false,
        signalPid: () => undefined,
        boundMs: 40,
      }),
    },
    {
      name: "descendant exit timeout",
      plan: (fixtureDir) => ({
        fixtureDir,
        direct: [
          {
            label: "owned root",
            child: { pid: 4242, exitCode: null, signalCode: null, kill: () => true },
            closed: settledClose(),
          },
        ],
        descendantPids: [4243],
        ownershipConfirmed: true,
        terminateOwnedTree: () => [],
        isLive: () => true,
        signalPid: () => undefined,
        boundMs: 40,
      }),
    },
    {
      name: "unconfirmed ownership",
      plan: (fixtureDir) => ({
        fixtureDir,
        direct: [
          {
            label: "owned root",
            child: { pid: 4242, exitCode: 1, signalCode: null, kill: () => true },
            closed: settledClose(),
          },
        ],
        descendantPids: [],
        ownershipConfirmed: false,
        terminateOwnedTree: () => [],
        isLive: () => false,
        signalPid: () => undefined,
        boundMs: 40,
      }),
    },
  ];

  for (const testCase of cases) {
    await withScratchFixtureDir(async (fixtureDir) => {
      const result = await cleanupOwnedFixtures(testCase.plan(fixtureDir));
      assert.equal(result.retainedFixtureDir, fixtureDir, `${testCase.name} must retain the records`);
      assert.ok(result.problems.some((problem) => problem.includes("retained pending confirmed process settlement")),
        `${testCase.name} reports the retained directory: ${result.problems.join("; ")}`);
      assert.equal(await readFile(join(fixtureDir, "root-seen-pid.txt"), "utf8"), "4242",
        `${testCase.name} keeps the ownership record while a fixture may still be running`);
    });
  }
});

test("a failed owned-tree termination is reported and falls back without stranding other fixtures", async () => {
  await withScratchFixtureDir(async (fixtureDir) => {
    const signals: Array<number | string> = [];
    const root = { pid: 4242, exitCode: null, signalCode: null, kill: () => { signals.push("root"); return true; } };
    const unrelated = { pid: 4300, exitCode: null, signalCode: null, kill: () => { signals.push("unrelated"); return true; } };
    const result = await cleanupOwnedFixtures({
      fixtureDir,
      direct: [
        { label: "owned root", child: root, closed: settledClose() },
        { label: "unrelated fixture", child: unrelated, closed: settledClose() },
      ],
      ownedTreeRoot: root,
      descendantPids: [4243],
      ownershipConfirmed: true,
      terminateOwnedTree: (pid) => { signals.push(`tree:${pid}`); return ["owned tree termination reported 128"]; },
      isLive: liveOnce(),
      signalPid: (pid) => { signals.push(pid); },
      boundMs: 200,
    });
    assert.ok(result.problems.some((problem) => problem.includes("owned tree termination reported 128")),
      "the failed tree termination is reported instead of swallowed");
    assert.equal(result.retainedFixtureDir, undefined,
      "confirmed closure still releases the records when the tree step alone failed");
    assert.deepEqual(signals, ["tree:4242", "root", 4243, "root", "unrelated"],
      "the fallback signal plus every remaining fixture step still runs");
  });
});

// ---------------------------------------------------------------------------
// Native Windows production query (win32 only; real processes, no mocks)
// ---------------------------------------------------------------------------

if (process.platform === "win32") {
  const SLEEP_BODY = "setInterval(() => {}, 1000);";

  /** Bounded read of one ownership PID file; absence or junk is not an identity. */
  async function readOwnedPidFile(path: string, timeoutMs = 3_000): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const parsed = parseOwnedPid(await readFile(path, "utf8"));
        if (parsed !== undefined) return parsed;
      } catch {
        if (Date.now() > deadline) return undefined;
      }
      if (Date.now() > deadline) return undefined;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  test("native Windows lineage proof accepts a real descendant and refuses an unrelated PID", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "prg-lineage-native-"));
    // Two independent ownership channels: the root records the PID it saw, and
    // the descendant reports its own PID as its first action. Teardown uses every
    // validated identity it can find, so a lost stdout frame cannot orphan it.
    const rootSeenPidFile = join(fixtureDir, "root-seen-pid.txt");
    const selfReportedPidFile = join(fixtureDir, "self-reported-pid.txt");
    const descendantBody = [
      "try { require('node:fs').writeFileSync(",
      JSON.stringify(selfReportedPidFile) + ", String(process.pid)); } catch {}",
      SLEEP_BODY,
    ].join("");
    const rootBody = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantBody)}], { stdio: 'ignore', windowsHide: true });`,
      "const pid = child.pid;",
      "if (Number.isSafeInteger(pid) && pid > 0) {",
      `  fs.writeFileSync(${JSON.stringify(rootSeenPidFile)}, String(pid));`,
      "  process.stdout.write('PRG-PID:' + pid + '\\n');",
      "} else {",
      "  process.stdout.write('PRG-ERR:descendant-spawn-failed\\n');",
      "  process.exit(1);",
      "}",
      `setInterval(() => {}, ${120_000});`,
    ].join("");

    const ownedRoot = spawn(process.execPath, ["-e", rootBody], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const unrelated = spawn(process.execPath, ["-e", SLEEP_BODY], { stdio: "ignore", windowsHide: true });
    // Attached before any kill so a fast exit can never be missed, and an error
    // event can never become an unhandled 'error' event. Both waits settle only on
    // their own `close` event: an error is not closure evidence.
    const rootClosed = closeSettled(ownedRoot);
    const unrelatedClosed = closeSettled(unrelated);
    unrelated.on("error", () => undefined);

    const handshake = createOwnedPidHandshake();
    ownedRoot.stdout?.setEncoding("utf8");
    ownedRoot.stdout?.on("data", (chunk: string) => handshake.feed(chunk));
    ownedRoot.on("error", (error) => handshake.fail(`the owned root reported an error: ${error.message}`));
    ownedRoot.once("exit", () => {
      if (!handshake.settled) {
        handshake.fail(`the owned root exited early with ${String(ownedRoot.exitCode ?? ownedRoot.signalCode)}`);
      }
    });

    let bodyError: unknown;
    try {
      await waitForHandshake(handshake);
      const descendantPid = handshake.pid;
      if (descendantPid === undefined) {
        throw new Error(`the owned root did not report a validated descendant PID (${handshake.failure ?? "no frame"})`);
      }
      assert.deepEqual(await verifyWindowsProcessLineage(ownedRoot, descendantPid), { verified: true },
        "the real bounded native query must still prove a genuine descendant");

      assert.ok(unrelated.pid, "the unrelated fixture process must exist");
      const outsider = await verifyWindowsProcessLineage(ownedRoot, unrelated.pid);
      assert.equal(outsider.verified, false, "a process outside the owned tree never verifies");
      assert.ok(outsider.verified === false && isWindowsLineageRefusalReason(outsider.reason),
        "the native refusal reports a fixed stage");
      assert.ok(outsider.verified === false
        && !outsider.reason.startsWith("preflight-")
        && !outsider.reason.startsWith("query-"),
      `an unrelated PID must be refused by the native chain/evidence stages, got ${
        outsider.verified === false ? outsider.reason : "accepted"}`);
    } catch (error) {
      bodyError = error;
    }

    // Teardown runs even when setup or the assertions failed, and it keeps the
    // ownership records whenever settlement stays unconfirmed.
    const ownedPids = new Set<number>();
    if (handshake.pid !== undefined) ownedPids.add(handshake.pid);
    for (const path of [rootSeenPidFile, selfReportedPidFile]) {
      const recorded = await readOwnedPidFile(path);
      if (recorded !== undefined) ownedPids.add(recorded);
    }
    const { problems } = await cleanupOwnedFixtures({
      fixtureDir,
      direct: [
        { label: "owned root", child: ownedRoot, closed: rootClosed },
        { label: "unrelated fixture", child: unrelated, closed: unrelatedClosed },
      ],
      ownedTreeRoot: ownedRoot,
      descendantPids: ownedPids,
      ownershipConfirmed: ownedPids.size > 0 || handshake.reportedAbsent,
    });

    if (bodyError !== undefined && problems.length > 0) {
      throw new AggregateError(
        [bodyError, new Error(`owned fixture cleanup: ${problems.join("; ")}`)],
        "native lineage fixture failed and its owned cleanup is incomplete",
      );
    }
    if (bodyError !== undefined) throw bodyError;
    if (problems.length > 0) throw new Error(`owned fixture cleanup incomplete: ${problems.join("; ")}`);
  });
}
