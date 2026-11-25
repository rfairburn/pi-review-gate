/**
 * Portable regressions for the Windows PowerShell 5.1 readiness probe's single
 * timeout retry (#764). A fake synchronous attempt runner is injected, so no
 * PowerShell and no Windows host runs here: a passing run is portable logic
 * proof only, never Windows host proof.
 *
 * Pinned behaviour:
 *   - a healthy first attempt still runs exactly once under the unchanged 10 s
 *     bound;
 *   - only an ETIMEDOUT first attempt retries, exactly once, under a 20 s bound;
 *   - a second timeout, or any other failure, stays fail-closed;
 *   - the retry is disclosed as one bounded boolean field, and the normalized
 *     diagnostic still carries no stdout, stderr, args, env, or error message.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_PROBE_RETRY_TIMEOUT_MS,
  WINDOWS_PROBE_TIMEOUT_MS,
  runWindowsPowerShellReadinessProbe,
  type WindowsPowerShellProbeAttempt,
} from "./helpers/session-host-native-windows-harness";

const OK: WindowsPowerShellProbeAttempt = { status: 0, signal: null, stdout: "5.1.26100.1\r\n" };

/** A timed-out attempt whose raw error message, status, and signal are hostile. */
function timeoutAttempt(): WindowsPowerShellProbeAttempt {
  return {
    error: Object.assign(new Error("spawnSync C:\\Windows\\System32\\secret-powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    signal: "SIGTERM",
    stdout: "raw stdout must never surface",
  };
}

interface ProbeRun {
  readonly timeouts: number[];
  readonly attempts: number;
  readonly error?: Error;
}

/** Runs the probe against a fixed sequence of fake attempts. */
function runProbe(attempts: readonly WindowsPowerShellProbeAttempt[]): ProbeRun {
  const timeouts: number[] = [];
  let index = 0;
  let clock = 0;
  let error: Error | undefined;
  try {
    runWindowsPowerShellReadinessProbe({
      now: () => (clock += 5),
      runAttempt: (timeoutMs) => {
        timeouts.push(timeoutMs);
        const attempt = attempts[index];
        index += 1;
        assert.ok(attempt !== undefined, "the probe never runs more attempts than the fake supplies");
        return attempt;
      },
    });
  } catch (thrown) {
    error = thrown as Error;
  }
  return { timeouts, attempts: timeouts.length, error };
}

test("the readiness probe bounds are the unchanged 10 s attempt and one 20 s retry", () => {
  assert.equal(WINDOWS_PROBE_TIMEOUT_MS, 10_000, "the first attempt keeps its existing bound");
  assert.equal(WINDOWS_PROBE_RETRY_TIMEOUT_MS, 20_000, "the single retry uses the longer CI bound");
});

test("a healthy readiness attempt runs once under the unchanged bound", () => {
  const run = runProbe([OK]);
  assert.equal(run.error, undefined, "a matching PowerShell 5.1 version passes");
  assert.deepEqual(run.timeouts, [WINDOWS_PROBE_TIMEOUT_MS], "the success path still runs exactly one attempt");
});

test("an ETIMEDOUT attempt retries exactly once with the longer bound and can pass", () => {
  const run = runProbe([timeoutAttempt(), OK]);
  assert.equal(run.error, undefined, "a healthy retry passes the probe");
  assert.deepEqual(run.timeouts, [WINDOWS_PROBE_TIMEOUT_MS, WINDOWS_PROBE_RETRY_TIMEOUT_MS],
    "the retry is exactly one attempt at the 20 s bound, never a third");
});

test("a second timeout stays fail-closed and discloses that the retry happened", () => {
  const run = runProbe([timeoutAttempt(), timeoutAttempt()]);
  assert.ok(run.error, "a retried timeout still fails closed");
  assert.deepEqual(run.timeouts, [WINDOWS_PROBE_TIMEOUT_MS, WINDOWS_PROBE_RETRY_TIMEOUT_MS],
    "the double timeout consumes exactly the two bounded attempts");
  const message = run.error!.message;
  assert.ok(message.startsWith("required Windows PowerShell 5.1 readiness probe failed: "),
    "the existing fail-closed error prefix is unchanged");
  assert.match(message, /retriedAfterTimeout=true/, "the failure discloses that the retry ran");
  assert.match(message, /errno=ETIMEDOUT/, "the bounded errno token is still disclosed");
});

test("a non-timeout failure never retries and never claims a retry", () => {
  const cases: readonly { readonly name: string; readonly attempt: WindowsPowerShellProbeAttempt }[] = [
    { name: "a non-timeout spawn error", attempt: { error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }), status: null, signal: null, stdout: "" } },
    { name: "a nonzero status", attempt: { status: 1, signal: null, stdout: "5.1.26100.1\r\n" } },
    { name: "a version mismatch", attempt: { status: 0, signal: null, stdout: "7.4.1\r\n" } },
    { name: "an empty attempt", attempt: {} },
  ];
  for (const testCase of cases) {
    const run = runProbe([testCase.attempt, OK]);
    assert.ok(run.error, `${testCase.name} fails closed`);
    assert.equal(run.attempts, 1, `${testCase.name} never retries`);
    assert.deepEqual(run.timeouts, [WINDOWS_PROBE_TIMEOUT_MS], `${testCase.name} only ever ran the first bound`);
    assert.equal(run.error!.message.includes("retriedAfterTimeout"), false,
      `${testCase.name} must not claim a retry that did not happen`);
  }
});

test("the retry diagnostic stays bounded and leaks no raw output, args, env, or error message", () => {
  const run = runProbe([timeoutAttempt(), timeoutAttempt()]);
  const message = run.error!.message;
  for (const raw of ["secret-powershell", "C:\\Windows", "System32", "raw stdout", "spawnSync "]) {
    assert.equal(message.includes(raw), false, `the diagnostic must not contain ${raw}`);
  }
  assert.match(message, /^required Windows PowerShell 5\.1 readiness probe failed: elapsedMs=\d+ hadSpawnError=true errno=ETIMEDOUT status=null signal=SIGTERM stdoutVersionMatched=false retriedAfterTimeout=true$/,
    "the diagnostic is exactly the bounded field list plus the retry disclosure");
});
