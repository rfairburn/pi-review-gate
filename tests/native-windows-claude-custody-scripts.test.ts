/**
 * Native Windows Claude custody script rendering (#682), portable tests.
 *
 * The renderer is pure: it validates its inputs, renders the two PowerShell
 * scripts, frames the supervisor's startup source, and classifies exit codes.
 * These tests pin the rendered invocation, the boot framing (byte-for-byte
 * against the TypeScript transport's own boot write), the malformed-input
 * guards, and the closed status classifiers. Nothing is spawned: the only
 * transport attachment uses an in-memory fake child, and no PowerShell, PTY,
 * provider, setting, or filesystem scratch is involved.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  attachNativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyTransport,
} from "../src/session-host/native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES,
  WINDOWS_CLAUDE_CUSTODY_BOOT_LENGTH_DIGITS,
  WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC,
  WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN,
  WINDOWS_CLAUDE_CUSTODY_HANDSHAKE,
  WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE,
  WINDOWS_CLAUDE_CUSTODY_MAX_WINDOWS_COMMAND_LINE,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE,
  WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE,
  WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_STAGES,
  buildWindowsClaudeCustodySupervisorLaunch,
  buildWindowsClaudeCustodyWrapperLaunch,
  classifyWindowsClaudeCustodySupervisorExit,
  classifyWindowsClaudeCustodyWrapperOutcome,
  custodyOutcomeSuffix,
  encodeCustodyBootFrame,
  powerShellSingleQuotedBody,
  quoteWindowsArg,
  validatePowerShellPath,
  validateTargetPath,
  type WindowsClaudeCustodyWrapperLaunchInput,
} from "../src/session-host/native-windows-claude-custody-scripts";

const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const TARGET_PATH = String.raw`C:\Program Files\Claude\claude.exe`;
const CTL_NONCE = "0123456789abcdef0123456789abcdef";
const PIPE_SUFFIX = "fedcba9876543210fedcba9876543210";
const CTL_PIPE = `prg682-ctl-${PIPE_SUFFIX}`;
const OUTCOME_TAG = "00112233445566778899aabbccddeeff";
const SUPERVISOR_PID = 4812;

const WRAPPER_INPUT: WindowsClaudeCustodyWrapperLaunchInput = {
  powershellPath: POWERSHELL_PATH,
  target: TARGET_PATH,
  ctlPipe: CTL_PIPE,
  supervisorPid: SUPERVISOR_PID,
  ctlNonce: CTL_NONCE,
};

/* -------------------------------------------------------- fake process */

const CUSTODY_PID = 4100;

/** An in-memory stand-in for ONE owned supervisor process (nothing is spawned). */
class FakeSupervisor extends EventEmitter {
  pid: number | undefined = CUSTODY_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private written = Buffer.alloc(0);

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written = Buffer.concat([this.written, chunk]);
    });
  }

  get writtenBytes(): Buffer {
    return this.written;
  }

  kill(): boolean {
    void this.exit(null, "SIGTERM");
    return true;
  }

  async line(text: string): Promise<void> {
    this.stdout.write(`${text}\n`);
    await settleIo();
  }

  /** Exit, end both output pipes, then emit `close` (as Node does). */
  async exit(code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    await settleIo();
    this.stdout.end();
    this.stderr.end();
    await settleIo();
    this.emit("close", code, signal);
    await settleIo();
  }
}

async function settleIo(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function attach(fake: FakeSupervisor): NativeWindowsClaudeCustodyTransport {
  const result = attachNativeWindowsClaudeCustodyTransport({
    child: fake as unknown as ChildProcess,
    run: { runId: "run-682-scripts", generation: 1 },
    isRunCurrent: () => true,
    deadlines: { readyMs: 200, peerMs: 200, childMs: 200, settleMs: 200 },
  });
  assert.equal(result.status, "attached");
  return result.status === "attached" ? result.transport : (undefined as never);
}

function rejects(operation: () => unknown): void {
  assert.throws(operation, Error);
}

/* -------------------------------------------------------------- renderer */

test("wrapper launch renders the exact node-pty argv and validated literals", () => {
  const launch = buildWindowsClaudeCustodyWrapperLaunch({
    ...WRAPPER_INPUT,
    args: ["--flag", "", 'a "b"', "C:\\x\\"],
    outcomeTag: OUTCOME_TAG,
    smoke: true,
    settleMs: 2500,
    connectMs: 900,
    replyMs: 1100,
  });

  assert.equal(launch.file, POWERSHELL_PATH);
  assert.equal(launch.args.length, 5);
  assert.deepEqual(launch.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  // The one encoded argument is the rendered script, UTF-16LE then base64.
  assert.equal(Buffer.from(launch.args[4]!, "base64").toString("utf16le"), launch.script);

  assert.ok(launch.script.startsWith("$ErrorActionPreference='Stop'"));
  assert.ok(launch.script.includes(String.raw`$Target='C:\Program Files\Claude\claude.exe'`));
  assert.ok(launch.script.includes(String.raw`$ArgTail='--flag "" "a \"b\"" C:\x\'`));
  assert.ok(launch.script.includes(`PRG_WRAP_FAIL_${OUTCOME_TAG} `));
  assert.ok(launch.script.includes("$Smoke=$true;"));
  assert.ok(
    launch.script.includes(`$CusName='${CTL_PIPE}';$CusSup=${SUPERVISOR_PID};$CusNonce='${CTL_NONCE}';`),
    "launch-specific pipe, supervisor PID, and nonce are rendered",
  );
  assert.ok(launch.script.includes("$CusPipe.Connect(900)"));
  assert.ok(launch.script.includes("$task.Wait(1100)"));
  assert.ok(launch.script.includes("while($Clock.ElapsedMilliseconds -lt 2500)"));
  assert.ok(!launch.script.includes("__"), "no placeholder survives rendering");
  // PowerShell 5.1: no backtick escaping and no subexpression interpolation.
  assert.ok(!launch.script.includes("`"));
  assert.ok(!launch.script.includes("${"));

  assert.equal(launch.commandLineLength, `"${POWERSHELL_PATH}" `.length + launch.args.join(" ").length);
  assert.ok(launch.commandLineLength + 1 <= WINDOWS_CLAUDE_CUSTODY_MAX_WINDOWS_COMMAND_LINE);
  assert.ok(Object.isFrozen(launch));
  assert.ok(Object.isFrozen(launch.args));
});

test("wrapper launch doubles single quotes in literal bodies", () => {
  const launch = buildWindowsClaudeCustodyWrapperLaunch({
    ...WRAPPER_INPUT,
    target: String.raw`C:\R&D\O'Brien\claude.exe`,
    args: ["a'b"],
  });
  assert.ok(launch.script.includes(String.raw`$Target='C:\R&D\O''Brien\claude.exe'`));
  assert.equal(powerShellSingleQuotedBody("a'b‘c’d"), "a''b‘‘c’’d");
});

test("quoteWindowsArg applies the CreateProcess argv quoting rules", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("a b"), '"a b"');
  assert.equal(quoteWindowsArg("C:\\dir\\"), "C:\\dir\\");
  assert.equal(quoteWindowsArg("C:\\a b\\"), String.raw`"C:\a b\\"`);
  assert.equal(quoteWindowsArg("C:\\a b\\\\"), String.raw`"C:\a b\\\\"`);
  assert.equal(quoteWindowsArg(String.raw`a\"b`), String.raw`"a\\\"b"`);
  // A valid supplementary pair is one code point: it is not an unpaired half.
  assert.equal(quoteWindowsArg("a 😀 b"), '"a 😀 b"');
  rejects(() => quoteWindowsArg("a\nb"));
  rejects(() => quoteWindowsArg("a\u0000b"));
  rejects(() => quoteWindowsArg("a\uD800b"));
  rejects(() => quoteWindowsArg("a\uDC00b"));
  rejects(() => quoteWindowsArg(7 as unknown as string));
});

test("validated path helpers accept only the trusted canonical shapes", () => {
  assert.equal(validatePowerShellPath(POWERSHELL_PATH), POWERSHELL_PATH);
  assert.equal(validateTargetPath(TARGET_PATH), TARGET_PATH);
  assert.equal(validatePowerShellPath(String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\POWERSHELL.EXE`), String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\POWERSHELL.EXE`);
  assert.equal(validateTargetPath(String.raw`C:\x\claude.EXE`), String.raw`C:\x\claude.EXE`);

  rejects(() => validatePowerShellPath(String.raw`C:\Temp\powershell.exe`));
  rejects(() => validatePowerShellPath(String.raw`C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`));
  rejects(() => validatePowerShellPath(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\pwsh.exe`));
  rejects(() => validatePowerShellPath(`${POWERSHELL_PATH}\u0000`));
  rejects(() => validatePowerShellPath(`${POWERSHELL_PATH}\uD800`));
  rejects(() => validatePowerShellPath(42 as unknown as string));

  rejects(() => validateTargetPath("claude.exe"));
  rejects(() => validateTargetPath(String.raw`\\server\share\claude.exe`));
  rejects(() => validateTargetPath(String.raw`C:\dir\claude.bat`));
  rejects(() => validateTargetPath(String.raw`C:\dir\a*b.exe`));
  rejects(() => validateTargetPath(String.raw`C:\dir\a|b.exe`));
  rejects(() => validateTargetPath(`${TARGET_PATH}\u0000`));
  rejects(() => validateTargetPath(`${TARGET_PATH}\uDC00`));
  rejects(() => validateTargetPath(null));
});

test("outcome tags are untagged or exactly 32 lowercase hex characters", () => {
  assert.equal(custodyOutcomeSuffix(undefined), "");
  assert.equal(custodyOutcomeSuffix(""), "");
  assert.equal(custodyOutcomeSuffix(OUTCOME_TAG), `_${OUTCOME_TAG}`);
  rejects(() => custodyOutcomeSuffix(OUTCOME_TAG.toUpperCase()));
  rejects(() => custodyOutcomeSuffix(OUTCOME_TAG.slice(0, 31)));
  rejects(() => custodyOutcomeSuffix(`${OUTCOME_TAG}0`));
  rejects(() => custodyOutcomeSuffix("-_"));
  rejects(() => custodyOutcomeSuffix(5 as unknown as string));
});

test("rendering refuses malformed launch inputs before producing any byte", () => {
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, powershellPath: String.raw`C:\Temp\powershell.exe` }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, target: "claude.exe" }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, target: "" }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, args: "--flag" as unknown as readonly string[] }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, args: null as unknown as readonly string[] }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, args: ["a\nb"] }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, args: ["a\uD800"] }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, smoke: "true" as unknown as boolean }));
  rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, smoke: null as unknown as boolean }));

  for (const settleMs of [99, 60_001, 2.5, null as unknown as number]) {
    rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, settleMs }));
  }
  for (const connectMs of [499, 60_001, Number.NaN]) {
    rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, connectMs }));
  }
  for (const replyMs of [499, 120_001, "1100" as unknown as number]) {
    rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, replyMs }));
  }
  for (const supervisorPid of [0, -1, 1.5, 0x8000_0000, "4812" as unknown as number]) {
    rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, supervisorPid }));
  }

  for (const ctlPipe of [
    `prg682-ctl-${PIPE_SUFFIX.toUpperCase()}`,
    `prg682-ctl-${PIPE_SUFFIX.slice(0, 31)}`,
    `prg682-ctl-${PIPE_SUFFIX}0`,
    `PRG682-ctl-${PIPE_SUFFIX}`,
    `prg682-ctl-${PIPE_SUFFIX.slice(0, 31)}g`,
    "",
    null as unknown as string,
  ]) {
    rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, ctlPipe }));
  }
  for (const ctlNonce of [
    CTL_NONCE.toUpperCase(),
    CTL_NONCE.slice(0, 31),
    `${CTL_NONCE}0`,
    "",
    5 as unknown as string,
  ]) {
    rejects(() => buildWindowsClaudeCustodyWrapperLaunch({ ...WRAPPER_INPUT, ctlNonce }));
  }
});

test("supervisor launch pins the source length and SHA-256 in a short bootstrap", () => {
  const launch = buildWindowsClaudeCustodySupervisorLaunch({
    powershellPath: POWERSHELL_PATH,
    ctlPipe: CTL_PIPE,
    ctlNonce: CTL_NONCE,
  });

  assert.equal(launch.file, POWERSHELL_PATH);
  assert.equal(launch.args.length, 5);
  assert.deepEqual(launch.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(Buffer.from(launch.args[4]!, "base64").toString("utf16le"), launch.bootstrap);
  assert.equal(launch.args[4], launch.encoded);

  assert.equal(launch.sourceSha256, createHash("sha256").update(launch.source, "ascii").digest("hex"));
  assert.ok(launch.bootstrap.includes(`'${launch.sourceSha256}'`));
  assert.ok(launch.bootstrap.includes(`if($BootLen -ne ${launch.source.length})`));
  assert.ok(!launch.bootstrap.includes("$StartMs="), "the body holds the startup deadline, not the bootstrap");
  assert.ok(launch.bootstrap.includes("$BootLen -gt 65536"));
  assert.ok(launch.bootstrap.includes(`exit ${WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE + 50}`));
  assert.ok(launch.bootstrap.includes(String.raw`'^PRG-WCS1 ([0-9]{8})\n$'`));
  assert.ok(!launch.bootstrap.includes("$SupBase="), "the body never travels on the command line");

  assert.ok(launch.source.startsWith("$ErrorActionPreference='Stop'"));
  assert.ok(
    launch.source.includes(`$SupBase=${WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE};$CtlName='${CTL_PIPE}';$Nonce='${CTL_NONCE}';`),
  );
  assert.ok(launch.source.includes("$StartMs=900000;$SettleMs=10000"));
  assert.ok(!launch.source.includes("__"), "no placeholder survives rendering");

  assert.deepEqual(launch.spawnOptions, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
    shell: false,
  });
  assert.equal(launch.spawnOptions, WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS);
  assert.ok(Object.isFrozen(launch.spawnOptions));
  assert.ok(Object.isFrozen(launch.spawnOptions.stdio));
  assert.ok(Object.isFrozen(launch));

  const frame = launch.startupFrame;
  const header = frame.subarray(0, WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES).toString("ascii");
  assert.equal(header, `PRG-WCS1 ${String(launch.source.length).padStart(8, "0")}\n`);
  assert.equal(frame.length, WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES + launch.source.length);
  assert.equal(frame.subarray(WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES).toString("ascii"), launch.source);
  assert.deepEqual(launch.startupFrame, encodeCustodyBootFrame(launch.source));

  assert.equal(launch.commandLineLength, `"${POWERSHELL_PATH}" `.length + launch.args.join(" ").length);
  assert.ok(launch.commandLineLength <= WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE);
});

test("supervisor launch refuses malformed inputs", () => {
  const valid = { powershellPath: POWERSHELL_PATH, ctlPipe: CTL_PIPE, ctlNonce: CTL_NONCE };
  rejects(() => buildWindowsClaudeCustodySupervisorLaunch({ ...valid, powershellPath: String.raw`C:\Temp\powershell.exe` }));
  for (const maxMs of [9_999, 2 * 60 * 60 * 1000 + 1, 1.5, null as unknown as number, "900000" as unknown as number]) {
    rejects(() => buildWindowsClaudeCustodySupervisorLaunch({ ...valid, maxMs }));
  }
  for (const settleMs of [999, 60_001, Number.NaN]) {
    rejects(() => buildWindowsClaudeCustodySupervisorLaunch({ ...valid, settleMs }));
  }
  rejects(() => buildWindowsClaudeCustodySupervisorLaunch({ ...valid, ctlPipe: `prg682-ctl-${PIPE_SUFFIX.toUpperCase()}` }));
  rejects(() => buildWindowsClaudeCustodySupervisorLaunch({ ...valid, ctlNonce: CTL_NONCE.toUpperCase() }));
});

/** The one rendered supervisor function `name`, from its header to the next top-level function. */
function supervisorFunction(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}`);
  assert.ok(start >= 0, `${name} is rendered`);
  const next = source.indexOf("\nfunction ", start + 1);
  const loop = source.indexOf("\nwhile($true){", start + 1);
  const ends = [next, loop].filter((index) => index > start);
  return source.slice(start + 1, ends.length > 0 ? Math.min(...ends) : source.length);
}

/** Assert each needle occurs in `text`, in this exact order. */
function assertOrdered(text: string, needles: readonly string[], what: string): void {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    assert.ok(at >= from, `${what}: ${JSON.stringify(needle)} follows the previous step`);
    from = at + needle.length;
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("supervisor maxMs is a startup/handshake deadline, never a healthy run-phase lifetime", () => {
  const defaults = buildWindowsClaudeCustodySupervisorLaunch({ powershellPath: POWERSHELL_PATH, ctlPipe: CTL_PIPE, ctlNonce: CTL_NONCE });
  const shortened = buildWindowsClaudeCustodySupervisorLaunch({
    powershellPath: POWERSHELL_PATH,
    ctlPipe: CTL_PIPE,
    ctlNonce: CTL_NONCE,
    maxMs: 10_000,
    settleMs: 1_000,
  });
  assert.ok(defaults.source.includes("$StartMs=900000;$SettleMs=10000"), "default startup deadline is unchanged (15 minutes)");
  assert.ok(shortened.source.includes("$StartMs=10000;$SettleMs=1000"), "the dormant maxMs input still renders the startup bound");
  assert.ok(!defaults.source.includes("$MaxMs"), "no lifetime ceiling survives in the body");

  for (const source of [defaults.source, shortened.source]) {
    // The only reader of the startup clock is the startup check itself.
    assert.equal(occurrences(source, "SupLeft"), 2, "SupLeft is defined once and read only by SupStartCheck");
    assert.ok(source.includes("function SupLeft{[long]$StartMs-$Clock.ElapsedMilliseconds}"));
    assert.ok(source.includes("function SupStartCheck{if((SupLeft) -le 0){SupFail 'deadline' 9}}"));
    assert.equal(occurrences(source, "SupFail 'deadline' 9"), 1, "the deadline refusal has exactly one route");

    // The loop applies the deadline only before the run phase.
    const loop = source.slice(source.indexOf("\nwhile($true){"));
    assert.ok(loop.startsWith("\nwhile($true){\nif($Phase -cne 'run'){SupStartCheck}\n$busy=$false"), "loop deadline is gated on the pre-run phases");
    assert.equal(occurrences(loop, "SupStartCheck"), 1, "the loop has no ungated deadline check");
    assert.equal(occurrences(loop, "SupLeft"), 0);

    // Every startup check sits at a pre-run promotion fence: 1 definition + loop + hello + confirm + 3 in child.
    assert.equal(occurrences(source, "SupStartCheck"), 7);

    // SUP_WRAPPER is announced only after the PID/job checks and a fresh deadline check.
    assertOrdered(supervisorFunction(source, "SupHello"), [
      "SupFail 'wrapper-handle-pid' 17",
      "SupFail 'wrapper-not-in-job' 18",
      "$script:ProvJob=$jobH;$script:ProvW=$wrapH",
      "SupStartCheck",
      "SupOut ('SUP_WRAPPER '",
      "$script:Phase='confirm'",
    ], "SupHello");

    // CONFIRM promotes the provisional job only inside the startup deadline.
    assertOrdered(supervisorFunction(source, "SupCommand"), [
      "SupFail 'confirm-out-of-phase' 22",
      "SupFail 'confirm-pid-mismatch' 23",
      "SupStartCheck",
      "$script:Job=$ProvJob;$script:WH=$ProvW",
      "SupSend ('GO '+$Nonce)",
      "SupOut ('SUP_GO '",
      "$script:Phase='child'",
    ], "CONFIRM");

    // The run phase is reached only after every child check, CHILD-OK, SUP_CHILD,
    // and a deadline check before each promotion write.
    const child = supervisorFunction(source, "SupChild");
    assertOrdered(child, [
      "SupFail 'child-invalid' 19",
      "$K::GetProcessId($childH) -ne $claimed",
      "-not (SupInJob $childH)",
      "$K::WaitForSingleObject($childH,0) -ne 258",
      "SupFail 'child-unverified' 14",
      "SupStartCheck",
      "$script:CH=$childH",
      "SupSend ('CHILD-OK '+$Nonce)",
      "SupFail 'child-ok-write-failed' 25",
      "SupStartCheck",
      "SupOut ('SUP_CHILD '",
      "SupStartCheck",
      "$script:Phase='run'",
    ], "SupChild");
    // The run phase is entered immediately after the post-SUP_CHILD deadline check, with nothing in between.
    assert.ok(child.includes("SupOut ('SUP_CHILD '+[string]$claimed)\nSupStartCheck\n$script:Phase='run'}"));
    assert.equal(occurrences(source, "$script:Phase='run'"), 1, "SupChild is the only way into the run phase");
  }
});

test("supervisor run phase keeps its existing owner-stdin, protocol, and settlement termination routes", () => {
  const { source } = buildWindowsClaudeCustodySupervisorLaunch({ powershellPath: POWERSHELL_PATH, ctlPipe: CTL_PIPE, ctlNonce: CTL_NONCE });
  const loop = source.slice(source.indexOf("\nwhile($true){"));

  // Owner stdin EOF is ungated by phase and still a bounded refusal.
  assert.ok(loop.includes("if($n -le 0){if($InLine -ceq ''){SupFail 'stdin-closed' 10}else{SupFail 'command-invalid' 11}}"));
  assert.ok(loop.includes("elseif($ci -lt 32 -or $ci -gt 126 -or $InLine.Length -ge $MaxCmd){SupFail 'command-invalid' 11}"));
  // Every refusal terminates only the exact confirmed job under the existing 3s wait and releases provisional handles.
  assert.ok(
    source.includes(
      "if($Job -ne $Z){[void]$K::TerminateJobObject($Job,($SupBase+0x30));$left=SupWaitEmpty 3000;if($left -ne 0){SupDiag ('fail job-left='+[string]$left)}};SupReleaseProvisional};exit ($SupBase+$code)}",
    ),
  );
  // Explicit SETTLE keeps its normal/forced bounds and its exact witness.
  assert.ok(source.includes("if($cmd -ceq 'SETTLE'){SupSettle}"));
  const settle = supervisorFunction(source, "SupSettle");
  assertOrdered(settle, [
    "$NaturalMs=[int][Math]::Min(4000,[Math]::Floor($SettleMs/2))",
    "$WrapperMs=[int][Math]::Max(0,[Math]::Min(2000,",
    "$K::WaitForSingleObject($WH,$WrapperMs) -eq 0",
    "[void]$K::TerminateJobObject($Job,($SupBase+0x30))",
    "$Left=[int][Math]::Max(0,($SettleMs-$Budget.ElapsedMilliseconds))",
    "if($Budget.ElapsedMilliseconds -ge $SettleMs)",
    "SupOut 'SUP_SETTLED ACTIVE=0 LISTED=0'",
    "SupOut 'SUP_BYE'",
  ], "SupSettle");
  assert.ok(!settle.includes("SupStartCheck") && !settle.includes("SupLeft"), "settlement is bounded by settleMs, not the startup deadline");
  // A natural wrapper exit in run closes the control pipe without refusing; before run it is still a refusal.
  assert.ok(loop.includes("if($null -eq $line){if($Phase -ceq 'run'){SupDiag 'ctl closed';$script:CtlTask=$null}else{SupFail 'ctl-closed' 26}}"));
  assert.ok(loop.includes("elseif($Phase -ceq 'run'){if($line -cnotmatch '^DONE '){SupFail 'ctl-unexpected' 21}}"));
  // A late CONFIRM in run is still out of phase.
  assert.ok(source.includes("if($Phase -cne 'confirm'){SupFail 'confirm-out-of-phase' 22}"));
  // No new grammar records, timers, or stage codes.
  assert.deepEqual(
    [...source.matchAll(/SupOut \(?'([A-Z_]+)/gu)].map((match) => match[1]),
    ["SUP_READY", "SUP_WRAPPER", "SUP_CHILD", "SUP_SETTLED", "SUP_SETTLED", "SUP_BYE", "SUP_GO"],
  );
  assert.equal(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES.deadline, 9);
});

/* --------------------------------------------------------------- framing */

test("boot framing is canonical and mirrors the transport constants", () => {
  assert.equal(WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC, NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES, NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES, NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES, NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES, WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC.length + WINDOWS_CLAUDE_CUSTODY_BOOT_LENGTH_DIGITS + 1);

  const one = encodeCustodyBootFrame("x");
  assert.equal(one.subarray(0, WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES).toString("ascii"), "PRG-WCS1 00000001\n");
  assert.equal(one.length, WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES + 1);

  // TAB, CR, and LF travel; everything else must be printable ASCII.
  const controls = encodeCustodyBootFrame("a\tb\r\nc");
  assert.equal(controls.subarray(WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES).toString("ascii"), "a\tb\r\nc");

  const largest = "x".repeat(NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
  const largestFrame = encodeCustodyBootFrame(largest);
  assert.equal(
    largestFrame.subarray(0, WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES).toString("ascii"),
    "PRG-WCS1 00065536\n",
    "the length field is exactly 8 zero-padded decimal digits",
  );

  rejects(() => encodeCustodyBootFrame(""));
  rejects(() => encodeCustodyBootFrame(5 as unknown as string));
  rejects(() => encodeCustodyBootFrame(`${largest}x`));
  rejects(() => encodeCustodyBootFrame("a\u0000b"));
  rejects(() => encodeCustodyBootFrame("a\u0001b"));
  rejects(() => encodeCustodyBootFrame("a\u007fb"));
  rejects(() => encodeCustodyBootFrame("a\u0080b"));
  rejects(() => encodeCustodyBootFrame("a😀b"));
  rejects(() => encodeCustodyBootFrame("a\uD800b"));
});

test("renderer startup frame is byte-identical to the transport boot write", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const launch = buildWindowsClaudeCustodySupervisorLaunch({
    powershellPath: POWERSHELL_PATH,
    ctlPipe: CTL_PIPE,
    ctlNonce: CTL_NONCE,
  });

  const started = transport.start(launch.source);
  await settleIo();
  assert.deepEqual(fake.writtenBytes, launch.startupFrame, "one frame, exactly the renderer's bytes");
  assert.deepEqual(
    fake.writtenBytes.subarray(0, WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES),
    Buffer.from(`PRG-WCS1 ${String(launch.source.length).padStart(8, "0")}\n`, "ascii"),
  );
  await fake.line(`SUP_READY ${CUSTODY_PID}`);
  assert.deepEqual(await started, { status: "ready-for-pty-spawn", supervisorPid: CUSTODY_PID });

  transport.dispose();
  const drained = transport.drain({ timeoutMs: 200 });
  await settleIo();
  await fake.exit(0);
  assert.deepEqual(await drained, { status: "closed" });
});

/* -------------------------------------------------------- classification */

test("wrapper output classification is tag-scoped and marker-driven", () => {
  const failText = `PRG_WRAP_FAIL job-create 5`;
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(
      WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE + WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_STAGES["job-create"]!,
      failText,
    ),
    { kind: "wrapper-failed", stage: "job-create", detail: 5, exitCodeMatchesStage: true },
  );
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(
      WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE + WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_STAGES["custody-peer"]!,
      `noise\r\nPRG_WRAP_FAIL custody-peer 17\r\nmore`,
    ),
    { kind: "wrapper-failed", stage: "custody-peer", detail: 17, exitCodeMatchesStage: true },
  );
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(0, failText),
    { kind: "wrapper-failed", stage: "job-create", detail: 5, exitCodeMatchesStage: false },
  );

  const taggedFail = `PRG_WRAP_FAIL_${OUTCOME_TAG} settle-timeout 13`;
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(
      WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE + WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_STAGES["settle-timeout"]!,
      taggedFail,
      OUTCOME_TAG,
    ),
    { kind: "wrapper-failed", stage: "settle-timeout", detail: 13, exitCodeMatchesStage: true },
  );
  // A differently tagged or untagged look-alike printed by the child is ignored.
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(0, taggedFail, ""),
    { kind: "unknown", exitCode: 0 },
  );
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(0, failText, OUTCOME_TAG),
    { kind: "unknown", exitCode: 0 },
  );

  const outcome = "PRG_WRAP_OUTCOME exit=0 settled=1 terminated=0 cap=1";
  assert.deepEqual(classifyWindowsClaudeCustodyWrapperOutcome(0, outcome), {
    kind: "child-exited",
    childExit: 0,
    settled: true,
    terminated: 0,
    capApplied: true,
    exitCodePassedThrough: true,
  });
  assert.deepEqual(classifyWindowsClaudeCustodyWrapperOutcome(0xffff_ffff, "PRG_WRAP_OUTCOME exit=-1 settled=0 terminated=3 cap=0"), {
    kind: "child-exited",
    childExit: -1,
    settled: false,
    terminated: 3,
    capApplied: false,
    exitCodePassedThrough: true,
  });
  assert.deepEqual(classifyWindowsClaudeCustodyWrapperOutcome(0, `PRG_WRAP_OUTCOME_${OUTCOME_TAG} exit=2 settled=1 terminated=1 cap=1`, OUTCOME_TAG), {
    kind: "child-exited",
    childExit: 2,
    settled: true,
    terminated: 1,
    capApplied: true,
    exitCodePassedThrough: false,
  });

  assert.deepEqual(classifyWindowsClaudeCustodyWrapperOutcome(3, ""), { kind: "unknown", exitCode: 3 });
  assert.deepEqual(
    classifyWindowsClaudeCustodyWrapperOutcome(-1, "PRG_WRAP_FAIL job-create 5"),
    { kind: "wrapper-failed", stage: "job-create", detail: 5, exitCodeMatchesStage: false },
  );
});

test("supervisor exit classification is closed over its reserved ranges", () => {
  assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(0), { kind: "clean" });
  const base = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE;

  for (const [stage, code] of Object.entries(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES)) {
    assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(base + code), { kind: "failed", stage, code });
  }
  for (const [stage, code] of Object.entries(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES)) {
    assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(base + code), { kind: "failed", stage, code });
  }
  assert.deepEqual(
    classifyWindowsClaudeCustodySupervisorExit(base + WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE),
    { kind: "terminated-job-member" },
  );
  assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(-1), { kind: "unknown", exitCode: 0xffff_ffff });
  assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(base - 1), { kind: "unknown", exitCode: base - 1 });
  assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(base + 0x100), { kind: "unknown", exitCode: base + 0x100 });
  assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(base + 0xff), { kind: "unknown", exitCode: base + 0xff });
});

test("handshake contract is frozen and its patterns accept only canonical records", () => {
  assert.equal(WINDOWS_CLAUDE_CUSTODY_HANDSHAKE.length, 9);
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_CUSTODY_HANDSHAKE));
  for (const [index, step] of WINDOWS_CLAUDE_CUSTODY_HANDSHAKE.entries()) {
    assert.equal(step.seq, index + 1);
    assert.ok(Object.isFrozen(step));
  }

  const expected = new Map<number, { readonly canonical: readonly string[]; readonly rejected: readonly string[] }>();
  expected.set(2, { canonical: ["SUP_READY 4100"], rejected: ["SUP_READY 04100", "SUP_READY 0", "SUP_READY"] });
  expected.set(3, {
    canonical: ["SUP_WRAPPER 4204 PROVISIONAL"],
    rejected: ["SUP_WRAPPER 04204 PROVISIONAL", "SUP_WRAPPER 4204 CONFIRMED"],
  });
  expected.set(5, { canonical: ["SUP_GO 4204"], rejected: ["SUP_GO 04204", "SUP_GO 4204 "] });
  expected.set(6, { canonical: ["SUP_CHILD 4308"], rejected: ["SUP_CHILD 04308", "SUP_CHILD 4308 1"] });
  expected.set(8, {
    canonical: ["SUP_SETTLED ACTIVE=0 LISTED=0", "SUP_SETTLED ACTIVE=3 LISTED=12"],
    rejected: ["SUP_SETTLED ACTIVE=00 LISTED=0", "SUP_SETTLED ACTIVE=0 LISTED=00", "SUP_SETTLED ACTIVE= LISTED=0"],
  });
  expected.set(9, { canonical: ["SUP_BYE"], rejected: ["SUP_BYE ", "SUP_BYE 0"] });

  for (const step of WINDOWS_CLAUDE_CUSTODY_HANDSHAKE) {
    const cases = expected.get(step.seq);
    if (cases === undefined) {
      assert.equal(step.direction, "driver-to-supervisor", `step ${step.seq} is a driver frame`);
      assert.equal(step.pattern, null);
      continue;
    }
    assert.ok(step.pattern !== null, `step ${step.seq} carries a record pattern`);
    for (const wire of cases.canonical) assert.ok(step.pattern.test(wire), `${wire} is canonical`);
    for (const wire of cases.rejected) assert.ok(!step.pattern.test(wire), `${wire} is refused`);
  }
  assert.equal(WINDOWS_CLAUDE_CUSTODY_HANDSHAKE[8]!.wire, "SUP_BYE");

  assert.ok(WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN.test(CTL_PIPE));
  assert.ok(!WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN.test(CTL_PIPE.toUpperCase()));
});
