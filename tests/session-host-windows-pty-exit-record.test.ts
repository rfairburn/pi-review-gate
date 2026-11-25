/**
 * Portable unit coverage for the shared Windows PTY exit-record assertion
 * (#764). No Windows host, PowerShell, or PTY runs here: these cases pin the
 * contract the real-host acceptance lanes rely on.
 *
 * The pinned `@lydell/node-pty` can emit its Windows `exit` event from the
 * conout socket close before its native exit callback sets the code, so the
 * event may carry no exit code. The assertion therefore requires the record, no
 * signal, and a zero code only when a code is reported; an omitted code becomes
 * a diagnostic, because the exit code is proven independently by each lane's
 * retained OS-level process observer witness.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWindowsPtyExitRecord,
  type WindowsPtyExitRecord,
} from "./helpers/session-host-native-windows-harness";

interface Check {
  readonly diagnostics: string[];
  readonly failure?: Error;
}

/** Runs the shared assertion against one record and captures both outcomes. */
function checkExit(exit: WindowsPtyExitRecord | undefined, overrides: { readonly label?: string; readonly recordMessage?: string; readonly codeMessage?: string; readonly signalMessage?: string } = {}): Check {
  const diagnostics: string[] = [];
  try {
    assertWindowsPtyExitRecord({
      exit,
      label: overrides.label ?? "A-12345678",
      diagnostic: (message) => {
        diagnostics.push(message);
      },
      recordMessage: overrides.recordMessage,
      codeMessage: overrides.codeMessage,
      signalMessage: overrides.signalMessage,
    });
  } catch (thrown) {
    return { diagnostics, failure: thrown as Error };
  }
  return { diagnostics };
}

test("a node-pty exit record reporting code zero passes without a diagnostic", () => {
  const result = checkExit({ exitCode: 0, signal: null });
  assert.equal(result.failure, undefined, "code zero with no signal passes");
  assert.deepEqual(result.diagnostics, [], "the ordinary pass emits no diagnostic");
  assert.equal(checkExit({ exitCode: 0 }).failure, undefined, "an absent signal field is still no signal");
  assert.equal(checkExit({ exitCode: 0, signal: 0 }).failure, undefined, "a zero signal is still no signal");
});

test("a node-pty exit record reporting a nonzero code fails", () => {
  for (const exitCode of [1, 259, -1]) {
    const result = checkExit({ exitCode, signal: null });
    assert.ok(result.failure, `exit code ${exitCode} must fail`);
    assert.match(result.failure!.message, /actual public PTY exited with code zero/);
    assert.deepEqual(result.diagnostics, [], "a reported nonzero code is never excused as the known race");
  }
});

test("a node-pty exit record carrying a signal fails", () => {
  for (const signal of ["SIGTERM", 9]) {
    const result = checkExit({ exitCode: 0, signal });
    assert.ok(result.failure, `signal ${String(signal)} must fail even alongside code zero`);
    assert.match(result.failure!.message, /has no signal/);
  }
});

test("a missing node-pty exit record fails", () => {
  const result = checkExit(undefined);
  assert.ok(result.failure, "the exact-pid onExit record stays required");
  assert.match(result.failure!.message, /A-12345678 has its actual public node-pty onExit record/);
  assert.deepEqual(result.diagnostics, []);
});

test("an omitted node-pty exit code passes once and reports the #764 diagnostic", () => {
  const result = checkExit({ exitCode: undefined, signal: null });
  assert.equal(result.failure, undefined, "the known upstream race is not a test failure");
  assert.equal(result.diagnostics.length, 1, "exactly one diagnostic is emitted");
  const line = result.diagnostics[0]!;
  assert.ok(line.includes("A-12345678"), "the diagnostic names the session label");
  assert.ok(line.includes("#764"), "the diagnostic names the upstream race");
  assert.match(line, /no exit code/i, "the diagnostic says node-pty carried no exit code");
  assert.match(line, /observer/i, "the diagnostic points at the OS-level observer witness");
});

test("any other unusable node-pty exit code fails instead of matching the race", () => {
  for (const exitCode of [null, "0", NaN, false, {}, []]) {
    const result = checkExit({ exitCode, signal: null });
    assert.ok(result.failure, `exit code ${String(exitCode)} (${typeof exitCode}) must fail`);
    assert.match(result.failure!.message, /not a usable numeric exit code/);
    assert.deepEqual(result.diagnostics, [], "an unexpected value never becomes the excused diagnostic path");
  }
});

test("each site keeps its own assertion wording through the shared helper", () => {
  const missing = checkExit(undefined, { recordMessage: "the public PTY handle's own onExit record exists" });
  assert.equal(missing.failure!.message, "the public PTY handle's own onExit record exists");
  const nonzero = checkExit({ exitCode: 3, signal: null }, { codeMessage: "the real public PTY exited with code zero" });
  assert.ok(nonzero.failure!.message.startsWith("the real public PTY exited with code zero"),
    "the site's own code message is used");
  const signaled = checkExit({ exitCode: 0, signal: 1 }, { signalMessage: "the real public PTY exit carries no signal" });
  assert.ok(signaled.failure!.message.startsWith("the real public PTY exit carries no signal"),
    "the site's own signal message is used");
  const labeled = checkExit({ exitCode: undefined }, { label: "the real public ConPTY child (pid 4242)" });
  assert.equal(labeled.diagnostics.length, 1);
  assert.ok(labeled.diagnostics[0]!.includes("the real public ConPTY child (pid 4242)"));
});
