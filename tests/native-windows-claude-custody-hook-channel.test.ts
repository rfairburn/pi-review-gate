/**
 * #682 native Windows Claude custody — opt-in hook channel, portable tests.
 *
 * Pins the renderer's opt-in hook composition (default supervisor unchanged
 * byte for byte; protected listener before `SUP_READY`; key frame through the
 * one startup reader on the shared bootstrap deadline; run-only, stdin-first
 * serving through the immutable fixed receiver and peer held check; nonsecret
 * `SUP_CAND`) and the transport's opt-in candidate tracking against an
 * in-memory fake supervisor. Nothing is spawned; no PowerShell, PTY, pipe,
 * provider, setting, or filesystem scratch is used. Windows runtime behavior
 * (DACL read-back, pipe flags, key read) remains a later real-host fixture.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  NATIVE_WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_CHUNK_BYTES,
  attachNativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyTransportOptions,
} from "../src/session-host/native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_HOOK_CHANNEL_CONTRACT,
  WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS,
  WINDOWS_CLAUDE_CUSTODY_HOOK_PIPE_PATTERN,
  WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE,
  WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC,
  WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_CHARS,
  WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE,
  WINDOWS_CLAUDE_CUSTODY_STARTUP_FRAME_MS,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_HOOK_FAIL_STAGES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE,
  buildWindowsClaudeCustodySupervisorLaunch,
  classifyWindowsClaudeCustodySupervisorExit,
} from "../src/session-host/native-windows-claude-custody-scripts";
import {
  WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT,
  WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE,
} from "../src/session-host/native-windows-claude-hook-receiver";
import {
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE,
} from "../src/session-host/native-windows-claude-inbox-peer";

const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const CTL_PIPE = "prg682-ctl-fedcba9876543210fedcba9876543210";
const CTL_NONCE = "0123456789abcdef0123456789abcdef";
const HOOK_PIPE = "prg682-hook-00112233445566778899aabbccddeeff";
const BASE = Object.freeze({ powershellPath: POWERSHELL_PATH, ctlPipe: CTL_PIPE, ctlNonce: CTL_NONCE });
/** Default-render pins captured before the hook channel existed (#682 checkpoint 22b5b32). */
const DEFAULT_SOURCE_SHA256 = "19ebca00a80bddf364c86ac051d4cc329485844fcb45fe461c5f244effcc13da";
const DEFAULT_BOOTSTRAP_SHA256 = "35e0191f1bb903d0ce99a17124ed148b3bdb1c5a8cc0d0198d4e657ba1da40dc";

/** Synthetic, inert values only. */
const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const RUN = Object.freeze({ runId: "run-682.hook:a_b", generation: 7 });
const UUID_A = "01234567-89ab-cdef-0123-456789abcdef";
const UUID_B = "fedcba98-7654-3210-fedc-ba9876543210";
const SOURCE = "$ErrorActionPreference = 'Stop'\n# synthetic hook boot source\n";
const SUP_PID = 5100;
const WRAPPER_PID = 5204;
const CHILD_PID = 5308;

const hookLaunch = () => buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE });

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function assertOrdered(text: string, needles: readonly string[], what: string): void {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    assert.ok(at >= from, `${what}: ${JSON.stringify(needle)} follows the previous step`);
    from = at + needle.length;
  }
}

/** One rendered top-level function, from its header to the next function or the run loop. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}`);
  assert.ok(start >= 0, `${name} is rendered`);
  const ends = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nwhile($true){", start + 1)].filter((i) => i > start);
  return source.slice(start + 1, ends.length > 0 ? Math.min(...ends) : source.length);
}

function varsOf(text: string): Set<string> {
  return new Set([...text.matchAll(/\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)/gu)].map((m) => m[1]!.toLowerCase()));
}

/* ------------------------------------------------------------- renderer */

test("renderer: an omitted hookPipe renders the default supervisor byte for byte", () => {
  const launch = buildWindowsClaudeCustodySupervisorLaunch(BASE);
  assert.equal(launch.sourceSha256, DEFAULT_SOURCE_SHA256);
  assert.equal(createHash("sha256").update(launch.bootstrap).digest("hex"), DEFAULT_BOOTSTRAP_SHA256);
  for (const needle of ["Wck", "SupHook", "SupPeer", "PRG-WCK1", "prg682-hook", "SUP_CAND", "GetHandleInformation"]) {
    assert.ok(!launch.source.includes(needle), `default source has no ${needle}`);
    assert.ok(!WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.includes(needle), `default template has no ${needle}`);
  }
  // Only an omitted value selects the default; null or malformed names are refused.
  for (const hookPipe of [null, "", HOOK_PIPE.toUpperCase(), CTL_PIPE, `${HOOK_PIPE}0`, "prg682-hook-xyz", 7]) {
    assert.throws(() => buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: hookPipe as unknown as string }));
  }
  assert.ok(WINDOWS_CLAUDE_CUSTODY_HOOK_PIPE_PATTERN.test(HOOK_PIPE));
});

test("renderer: the hook body keeps every default line in order and composes the fixed sources verbatim", () => {
  const def = buildWindowsClaudeCustodySupervisorLaunch(BASE).source;
  const launch = hookLaunch();
  const src = launch.source;
  // Every default line survives, in order (the hook mode only adds lines; SupFail gains a prefix call).
  const hookLines = src.split("\n");
  let at = 0;
  for (const line of def.split("\n")) {
    const want = line.startsWith("function SupFail(") ? line.replace("{SupDiag", "{SupWckStop;SupDiag") : line;
    while (at < hookLines.length && hookLines[at] !== want) at += 1;
    assert.ok(at < hookLines.length, `default line survives in order: ${line.slice(0, 60)}`);
    at += 1;
  }
  // Immutable fixed sources: the whole receiver, and only the peer's held check.
  assert.equal(occurrences(src, WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE), 1);
  const held = WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.slice(0, WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.indexOf("\nfunction SupPeerOpen("));
  assert.ok(held.startsWith("function SupPeerHeld(") && held.endsWith("return 'ok'}"));
  assert.equal(occurrences(src, held), 1);
  for (const absent of ["SupPeerOpen", "CreateFileW", "WriteFile", "SupInboxWrite", "function SupHookServe(", "#PRG-WCK-FIXED#"]) {
    assert.equal(occurrences(src, absent), absent === "function SupHookServe(" ? 1 : 0, `${absent}`);
  }
  assert.doesNotMatch(src, /__[A-Z0-9_]+__/u, "no placeholder survives");
  // Bounded, ASCII, and pinned by the unchanged bootstrap.
  assert.ok(src.length <= WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
  assert.ok(/^[\t\n\r\x20-\x7e]+$/u.test(src));
  assert.equal(launch.sourceSha256, createHash("sha256").update(src, "ascii").digest("hex"));
  assert.ok(launch.bootstrap.includes(`if($BootLen -ne ${src.length})`));
  assert.ok(launch.bootstrap.includes(`'${launch.sourceSha256}'`));
  assert.ok(launch.commandLineLength <= WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE);
  assert.ok(!launch.bootstrap.includes("Wck") && !launch.bootstrap.includes(HOOK_PIPE), "the bootstrap carries nothing hook-specific");
  assert.ok(src.includes(`$WckName='${HOOK_PIPE}'`), "the nonsecret pipe name is the only hook render parameter");
  assert.ok(WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE.startsWith(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.slice(0, 200)));
});

test("renderer: interop adds exactly the receiver contract plus GetHandleInformation, never an inbox open", () => {
  const src = hookLaunch().source;
  const added = [...WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT.additionalInteropDeclarations, "SupDef 'GetHandleInformation' $TF @($TI,$TA)"];
  assert.ok(src.includes(`SupDef 'SetConsoleCtrlHandler' $TF @($TI,$TF)\n${added.join("\n")}\n$K=$TB.CreateType()`));
  const declared = new Set([...src.matchAll(/^SupDef '([A-Za-z]+)'/gmu)].map((m) => m[1]!));
  const called = new Set([...src.matchAll(/\$(?:K|hk|pk)::([A-Za-z0-9]+)\(/gu)].map((m) => m[1]!));
  for (const name of called) assert.ok(declared.has(name), `${name} is declared`);
  assert.ok(!declared.has("CreateFileW") && !declared.has("WriteFile"));
});

test("renderer: key frame is read once, through the startup reader, on the shared bootstrap deadline, before READY", () => {
  const src = hookLaunch().source;
  assertOrdered(src, [
    "$K=$TB.CreateType()",
    "if(-not $K::SetConsoleCtrlHandler($Z,$true)){SupFail 'ctrl-ignore' 6}",
    "if($BootClock -isnot [Diagnostics.Stopwatch]){SupFail 'hook-key' 42}",
    `$WckBuf=[char[]]::new(${WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_CHARS})`,
    `$WckLeft=[long]${WINDOWS_CLAUDE_CUSTODY_STARTUP_FRAME_MS}-$BootClock.ElapsedMilliseconds`,
    "$WckTask=$StdIn.ReadAsync($WckBuf,$WckLen,1)",
    "if([int]$WckBuf[$WckLen-1] -eq 10){break}}",
    `if($BootClock.ElapsedMilliseconds -ge ${WINDOWS_CLAUDE_CUSTODY_STARTUP_FRAME_MS}){$WckOk=$false}`,
    String.raw`'^PRG-WCK1 ([0-9a-f]{64}) ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\n\z'`,
    "[Array]::Clear($WckBuf,0,$WckBuf.Length)",
    "SupFail 'hook-key' 42}",
    "$WckKey=$WckM.Groups[1].Value;$WckRun=$WckM.Groups[2].Value;$WckM=$null",
    "$Ctl=SupPipe $CtlName",
    "SupWckArm $true",
    "SupOut ('SUP_READY '",
    "$InBuf=[char[]]::new(1);$InLine='';$MaxCmd=18;SupStdinArm",
  ], "key then listener then READY");
  // One reader, one char at a time; no fresh clock and no second stdin consumer.
  assert.equal(occurrences(src, "$StdIn.ReadAsync("), 2, "the key read and SupStdinArm share the one startup reader");
  assert.equal(occurrences(src, "OpenStandardInput"), 0);
  assert.equal(occurrences(src, "$WckClock"), 0, "no fresh key-frame stopwatch");
  assert.equal(WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC, NATIVE_WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_CHARS, NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_BYTES);
});

test("renderer: the key never reaches stdout, stderr, the pipe name, or anything but the receiver", () => {
  const src = hookLaunch().source;
  const uses = src.split("\n").filter((line) => /\$(?:script:)?WckKey\b/u.test(line));
  assert.deepEqual(uses.map((line) => (line.match(/\$(?:script:)?WckKey[^;]*/gu) ?? []).join(" | ")), [
    "$WckKey=$null",
    "$script:WckKey=$null",
    "$WckKey=$WckM.Groups[1].Value",
    "$WckKey 2000 $wcts.Token ([ref]$wgot)}catch{$wcode='hook-unexpected'}",
  ]);
  for (const line of src.split("\n")) {
    if (/SupOut|SupDiag|Write-|Console\]::/u.test(line)) {
      assert.doesNotMatch(line, /WckKey|WckBuf|WckM\b|Token|Endpoint|WckRun/u, `no secret in output line: ${line.slice(0, 80)}`);
    }
  }
  // SUP_CAND carries only the sequence and the session id.
  assert.deepEqual(
    [...src.matchAll(/SupOut \(?'([A-Z_]+)/gu)].map((m) => m[1]),
    ["SUP_READY", "SUP_WRAPPER", "SUP_CHILD", "SUP_SETTLED", "SUP_SETTLED", "SUP_BYE", "SUP_GO", "SUP_CAND"],
  );
  assert.ok(src.includes("SupOut ('SUP_CAND '+[string]$WckSeq+' '+[string]$WckCand.SessionId)"));
});

test("renderer: protected, non-inheritable, first-instance, max-one listener; the control pipe is unchanged", () => {
  const src = hookLaunch().source;
  const pipe = fn(src, "SupWckPipe");
  assertOrdered(pipe, [
    "[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "[Security.AccessControl.RawSecurityDescriptor]::new('D:P(A;;GA;;;'+$wu.Value+')')",
    "$wsz=3*[IntPtr]::Size",
    "for($wi=0;$wi -lt $wsz;$wi+=4){[Runtime.InteropServices.Marshal]::WriteInt32($wap,$wi,0)}",
    "[Runtime.InteropServices.Marshal]::WriteInt32($wap,0,$wsz)",
    "[Runtime.InteropServices.Marshal]::WriteIntPtr($wap,[IntPtr]::Size,$wsp)",
    "$K::CreateNamedPipeW('\\\\.\\pipe\\'+$WckName,0x40080003,8,1,4096,4096,0,$wap)",
    "if([long]$wph -le 0)",
    "$K::GetHandleInformation($wph,$wfl) -and ($wfl[0] -band 1) -eq 0",
    "$wowner=[Microsoft.Win32.SafeHandles.SafePipeHandle]::new($wph,$true)",
    "$wph=$Z",
    "$wps=[IO.Pipes.NamedPipeServerStream]::new([IO.Pipes.PipeDirection]::InOut,$true,$false,$wowner)",
    "$wowner=$null",
    "$wacl=$wps.GetAccessControl()",
    "$wacl.AreAccessRulesProtected -and $wrs.Count -eq 1",
    "[Security.AccessControl.AccessControlType]::Allow -and -not $wrs[0].IsInherited -and $wrs[0].IdentityReference.Value -ceq $wu.Value -and $wps.IsAsync -and -not $wps.IsConnected",
    "}catch{return $null}",
    "finally{",
    "$wclean=$true",
    "if($null -ne $wps){$wps.Dispose()}",
    "elseif($null -ne $wowner){$wowner.Dispose()}",
    "elseif($wph -ne $Z){$wclean=$K::CloseHandle($wph)}",
    "}catch{$wclean=$false}",
    "FreeHGlobal($wap)",
    "FreeHGlobal($wsp)",
    "if(-not $wclean){SupFail 'hook-unsettled' 45}}}",
  ], "SupWckPipe");
  // Exactly one owner at each step: the SafePipeHandle is never built inline, the raw slot is
  // cleared as soon as it owns the handle, and the raw handle is closed only on its own branch.
  assert.equal(occurrences(pipe, "SafePipeHandle]::new("), 1);
  assert.equal(occurrences(pipe, "CloseHandle("), 1);
  assert.ok(pipe.includes("if([long]$wph -le 0){$wph=$Z;return $null}"), "a failed create leaves no raw owner");
  assert.equal(occurrences(pipe, "$wph=$Z\n"), 1, "the raw slot is cleared exactly at the transfer");
  assert.ok(pipe.includes("$wout=$wps;$wps=$null;return $wout"), "a returned stream is never disposed by cleanup");
  // bInheritHandle (offset 2*IntPtr.Size) is only ever zeroed; nothing writes a nonzero value there.
  assert.equal(occurrences(pipe, "WriteInt32($wap,"), 2);
  // Startup failure refuses; a run-phase re-arm only retries.
  const arm = fn(src, "SupWckArm");
  assert.ok(arm.includes("if($null -eq $wnp){if($wstart){SupFail 'hook-pipe' 43};return}"));
  assert.ok(arm.includes("$war=$wnp.BeginWaitForConnection($null,$null)"));
  assert.ok(arm.includes("try{$wnp.Dispose()}catch{SupFail 'hook-unsettled' 45}"), "a failed release fails closed");
  // The control pipe keeps its exact flags and default security.
  assert.ok(src.includes("function SupPipe([string]$name){$h=$K::CreateNamedPipeW('\\\\.\\pipe\\'+$name,0x40080003,8,1,4096,4096,0,$Z);"));
  assert.equal(occurrences(src, "$Ctl=SupPipe $CtlName"), 1);
});

test("renderer: hook connections are served only in run, behind pending owner stdin, then disposed and re-armed", () => {
  const src = hookLaunch().source;
  const loop = src.slice(src.indexOf("\nwhile($true){"));
  assert.ok(loop.includes(
    "if($Phase -ceq 'run' -and $InLine -ceq '' -and -not $InTask.IsCompleted){if($null -ne $WckAr){if($WckAr.IsCompleted){$busy=$true;SupWckTurn}}elseif($null -ne $WckRetry -and $WckRetry.ElapsedMilliseconds -ge 250){SupWckArm $false}}\nif(-not $busy){[Threading.Thread]::Sleep(20)}",
  ));
  // stdin is processed first in every iteration, and hook work is the last step before the idle sleep.
  assertOrdered(loop, ["if($InTask.IsCompleted)", "if($null -ne $CtlAr -and $CtlAr.IsCompleted)", "SupWckTurn", "Sleep(20)"], "loop order");
  assert.equal(occurrences(src, "SupWckTurn"), 2, "defined once, called only from the run-gated loop step");
  assert.equal(occurrences(src, "SupHookServe $K"), 1, "the receiver is invoked once, from SupWckTurn only");
  const turn = fn(src, "SupWckTurn");
  const call = /SupHookServe ([^(]+)\(\[ref\]\$wgot\)/u.exec(turn)![1]!.trim().split(" ");
  assert.deepEqual(call.slice(0, 5), WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT.arguments.slice(0, 5).map((a) => a.source));
  assert.deepEqual(call.slice(5), ["$wc", "$WckRun", "$WckKey", "2000", "$wcts.Token"]);
  assertOrdered(turn, [
    "$wc.EndWaitForConnection($wa)",
    "$wcts=[Threading.CancellationTokenSource]::new()",
    "SupHookServe",
    "$wcts.Dispose()",
    "$wc.Dispose()",
    "($wcode -ceq 'hook-unsettled') -or ($wcode -ceq 'hook-unexpected') -or -not $wdisp",
    "SupFail 'hook-unsettled' 45",
    "($wcode -ceq 'candidate') -and ($wgot -is [hashtable]) -and ((SupPeerHeld $K $CH $ChildPid $Job) -ceq 'ok')",
    "SupWckClear;$script:WckSeq++;$script:WckCand=$wgot",
    "SupOut ('SUP_CAND '",
    "else{if($null -ne $wgot){try{$wgot.Clear()}catch{}};$wgot=$null}",
    "SupWckArm $false}",
  ], "SupWckTurn");
  assert.ok(!turn.includes("SupDiag"), "ordinary refusals are silent: no stderr bytes per hostile connection");
  // Accept is armed before READY (hence before GO); nothing before run touches it.
  assert.equal(occurrences(src, "EndWaitForConnection($wa)"), 1);
  // Settlement and every refusal stop the channel and clear the one held candidate first.
  assert.ok(fn(src, "SupSettle").startsWith("function SupSettle{\nSupWckStop\nif($Job -eq $Z)"));
  assert.ok(fn(src, "SupFail").startsWith("function SupFail([string]$stage,[int]$code){SupWckStop;SupDiag ("));
  assert.ok(fn(src, "SupWckStop").includes("SupWckClear;$script:WckKey=$null;$script:WckRun=$null"));
  assert.ok(fn(src, "SupWckClear").includes("$WckCand.Clear()"));
  // The startup deadline still has exactly its one default route; nothing hook-related reads it.
  assert.equal(occurrences(src, "SupLeft"), 2);
  assert.equal(occurrences(src, "SupStartCheck"), 7);
});

test("renderer: hook names never collide with supervisor, receiver, peer, or automatic variables", () => {
  const src = hookLaunch().source;
  // Bootstrap variables the dot-sourced body may read: the one startup reader and its clock.
  const bootstrapReads = new Set(["stdin", "bootclock"]);
  const hookOnly = [...varsOf(src)].filter((n) => !varsOf(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE).has(n)
    && !varsOf(WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE).has(n) && !varsOf(WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE).has(n)
    && !bootstrapReads.has(n) && !["true", "false", "null"].includes(n));
  assert.ok(hookOnly.length > 10);
  assert.ok(varsOf(src).has("bootclock"), "the key read shares the bootstrap clock");
  const others = new Set([
    ...varsOf(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE),
    ...varsOf(WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE),
    ...varsOf(WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE),
    // bootstrap variables visible to the dot-sourced body
    "supblock", "bootenc", "stdin", "bootclock", "boothead", "boottask", "bootm", "bootlen", "bootleft", "bootsrc", "boottext", "bootsha",
    "pid", "input", "args", "matches", "error", "host", "this", "_", "home", "psitem", "env", "lastexitcode",
  ]);
  for (const name of hookOnly) {
    assert.match(name, /^w[a-z0-9]+$/u, `${name} uses the hook w-prefix`);
    assert.ok(!others.has(name), `${name} is distinct`);
  }
});

test("renderer: hook refusal stages are closed, distinct, and classified", () => {
  const all = [
    ...Object.values(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES),
    ...Object.values(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES),
    WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE,
  ];
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_HOOK_FAIL_STAGES));
  for (const [stage, code] of Object.entries(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_HOOK_FAIL_STAGES)) {
    assert.ok(!all.includes(code), `${stage} has a fresh code`);
    assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE + code), { kind: "failed", stage, code });
    assert.ok(!buildWindowsClaudeCustodySupervisorLaunch(BASE).source.includes(`'${stage}'`), `${stage} is hook-mode only`);
  }
  const contract = WINDOWS_CLAUDE_CUSTODY_HOOK_CHANNEL_CONTRACT;
  assert.ok(Object.isFrozen(contract) && Object.isFrozen(contract.futureBindSend));
  assert.equal(contract.serve.maxBlockingMs, WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS);
  assert.ok(contract.futureBindSend.some((rule) => rule.startsWith("never bind, send, or open an inbox from SUP_CAND")));
});

/* ------------------------------------------------------------ transport */

class FakeSupervisor extends EventEmitter {
  pid: number | undefined = SUP_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  private written = Buffer.alloc(0);
  /** The exact Buffer objects handed to stdin.write (to observe post-write scrubbing). */
  readonly handed: Buffer[] = [];

  constructor() {
    super();
    const write = this.stdin.write.bind(this.stdin) as (...args: unknown[]) => boolean;
    (this.stdin as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(chunk)) {
        this.handed.push(chunk);
        this.written = Buffer.concat([this.written, chunk]);
      }
      return write(chunk, ...rest);
    };
    this.stdin.resume();
  }

  get writtenText(): string {
    return this.written.toString("latin1");
  }

  kill(): boolean {
    this.kills += 1;
    void this.exit(null, "SIGTERM");
    return true;
  }

  async line(text: string): Promise<void> {
    await this.raw(`${text}\n`);
  }

  async raw(bytes: string | Buffer): Promise<void> {
    this.stdout.write(bytes);
    await settleIo();
  }

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

function attach(fake: FakeSupervisor, overrides: Partial<NativeWindowsClaudeCustodyTransportOptions> = {}): NativeWindowsClaudeCustodyTransport {
  const result = attachNativeWindowsClaudeCustodyTransport({
    child: fake as unknown as ChildProcess,
    run: RUN,
    isRunCurrent: () => true,
    deadlines: { readyMs: 200, peerMs: 200, childMs: 200, settleMs: 200 },
    hookCandidates: true,
    ...overrides,
  });
  assert.equal(result.status, "attached");
  return result.status === "attached" ? result.transport : (undefined as never);
}

function bootBytes(source: string): string {
  return `PRG-WCS1 ${String(source.length).padStart(8, "0")}\n${source}`;
}

const keyFrame = `PRG-WCK1 ${KEY} ${RUN.runId}\n`;

/** `hookKey: null` starts without any key (default mode). */
async function toChild(fake: FakeSupervisor, transport: NativeWindowsClaudeCustodyTransport, hookKey: string | null = KEY): Promise<void> {
  const started = transport.start(SOURCE, hookKey === null ? undefined : { hookKey });
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  assert.deepEqual(await started, { status: "ready-for-pty-spawn", supervisorPid: SUP_PID });
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await fake.line(`SUP_GO ${WRAPPER_PID}`);
  assert.deepEqual(await confirmed, { status: "peer-confirmed", wrapperPid: WRAPPER_PID });
  await fake.line(`SUP_CHILD ${CHILD_PID}`);
  assert.deepEqual(await transport.awaitChild(), { status: "child-established", childPid: CHILD_PID });
}

async function settleClean(fake: FakeSupervisor, transport: NativeWindowsClaudeCustodyTransport): Promise<void> {
  const settled = transport.settle();
  await settleIo();
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fake.line("SUP_BYE");
  await fake.exit(0);
  assert.equal((await settled).status, "settled");
}

test("transport default mode: unchanged grammar, a key is refused, nothing is tracked", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake, { hookCandidates: undefined });
  assert.deepEqual(await transport.start(SOURCE, { hookKey: KEY }), { status: "failed", code: "hook-key-invalid", poisoned: false });
  assert.equal(fake.writtenText, "", "nothing written");
  assert.equal(transport.phase, "attached");
  await toChild(fake, transport, null);
  assert.equal(fake.writtenText, `${bootBytes(SOURCE)}CONFIRM ${WRAPPER_PID}\n`);
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "hook-disabled" });
  await fake.line(`SUP_CAND 1 ${UUID_A}`);
  assert.equal(transport.diagnostics().poisonCode, "frame-invalid", "SUP_CAND is not a default record");
  assert.equal(transport.diagnostics().hookCandidatesCredited, 0);
  await transport.drain();

  for (const value of ["yes", 1, null]) {
    const refused = attachNativeWindowsClaudeCustodyTransport({
      child: new FakeSupervisor() as unknown as ChildProcess,
      run: RUN,
      isRunCurrent: () => true,
      hookCandidates: value as unknown as boolean,
    });
    assert.deepEqual(refused, { status: "refused", code: "options-invalid" });
  }
});

test("transport hook mode: the key frame follows the boot frame in one write, is validated first, scrubbed, and never surfaced", async () => {
  for (const bad of [undefined, "", KEY.toUpperCase(), KEY.slice(1), `${KEY}0`, `${KEY.slice(0, 63)}g`, 42]) {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    const result = await transport.start(SOURCE, bad === undefined ? undefined : { hookKey: bad as unknown as string });
    assert.deepEqual(result, { status: "failed", code: "hook-key-invalid", poisoned: false });
    assert.equal(fake.writtenText, "");
    assert.equal(transport.phase, "attached");
    transport.dispose();
  }
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE, { hookKey: KEY });
  await settleIo();
  assert.equal(fake.handed.length, 1, "boot and key frames travel in exactly one write");
  assert.equal(fake.writtenText, `${bootBytes(SOURCE)}${keyFrame}`);
  assert.ok(fake.handed[0]!.every((byte) => byte === 0), "the only transport copy holding the key is zero-filled after the write");
  await fake.line(`SUP_READY ${SUP_PID}`);
  const result = await started;
  assert.deepEqual(result, { status: "ready-for-pty-spawn", supervisorPid: SUP_PID });
  assert.ok(!JSON.stringify([result, transport.diagnostics(), transport.run, transport.observeHookCandidate(RUN)]).includes(KEY));
  assert.ok(!Object.values(transport as unknown as Record<string, unknown>).some((v) => typeof v === "string" && v.includes(KEY)));
  // Strict startup poisoning still holds in hook mode: a candidate before SUP_CHILD is unsolicited.
  await fake.line(`SUP_CAND 1 ${UUID_A}`);
  assert.equal(transport.diagnostics().poisonCode, "frame-unsolicited");
  await transport.drain();
});

test("transport hook mode: latest-only candidate, exact +1 sequence, exact current run only", async () => {
  const fake = new FakeSupervisor();
  let current = true;
  const transport = attach(fake, { isRunCurrent: () => current });
  await toChild(fake, transport);
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "none" });
  await fake.line(`SUP_CAND 1 ${UUID_A}`);
  const first = transport.observeHookCandidate(RUN);
  assert.deepEqual(first, { status: "candidate", candidate: { sequence: 1, sessionId: UUID_A } });
  assert.ok(first.status === "candidate" && Object.isFrozen(first.candidate));
  await fake.raw(`SUP_CAND 2 ${UUID_B}\r\n`);
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "candidate", candidate: { sequence: 2, sessionId: UUID_B } });
  assert.deepEqual(transport.observeHookCandidate({ runId: RUN.runId, generation: RUN.generation + 1 }), { status: "refused", code: "run-not-current" });
  assert.deepEqual(transport.observeHookCandidate({ runId: "other", generation: RUN.generation }), { status: "refused", code: "run-not-current" });
  current = false;
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "run-not-current" });
  current = true;
  // Observation is read-only: it never writes or consumes.
  const before = fake.writtenText;
  assert.equal(transport.observeHookCandidate(RUN).status, "candidate");
  assert.equal(fake.writtenText, before);
  assert.equal(transport.diagnostics().hookCandidatesCredited, 2);
  assert.equal(transport.diagnostics().recordsAccepted, 4, "candidates are not handshake records");
  // A send attempt is still never a send: no binding or callback is enabled by a candidate.
  const prepared = transport.prepareSend(RUN);
  assert.ok(prepared.status === "prepared");
  assert.deepEqual(prepared.attempt.commit(() => assert.fail("payload must never be materialized")), { status: "not-sent", code: "lane-unavailable" });
  await settleClean(fake, transport);
});

test("transport hook mode: malformed, skipped, repeated, or out-of-phase candidates poison and clear the held one", async () => {
  const cases: readonly { readonly lines: readonly string[]; readonly code: string }[] = [
    { lines: [`SUP_CAND 1 ${UUID_A}`, `SUP_CAND 3 ${UUID_A}`], code: "candidate-sequence" },
    { lines: [`SUP_CAND 1 ${UUID_A}`, `SUP_CAND 1 ${UUID_B}`], code: "candidate-sequence" },
    { lines: [`SUP_CAND 2 ${UUID_A}`], code: "candidate-sequence" },
    { lines: [`SUP_CAND 0 ${UUID_A}`], code: "frame-invalid" },
    { lines: [`SUP_CAND 01 ${UUID_A}`], code: "frame-invalid" },
    { lines: [`SUP_CAND 1 ${UUID_A.toUpperCase()}`], code: "frame-invalid" },
    { lines: [`SUP_CAND 1 ${UUID_A} x`], code: "frame-invalid" },
    { lines: [`SUP_CAND 1  ${UUID_A}`], code: "frame-invalid" },
    { lines: [`SUP_CAND 99999999999999999 ${UUID_A}`], code: "frame-invalid" },
    { lines: [`SUP_CAND 1 ${UUID_A}`, `SUP_CHILD ${CHILD_PID}`], code: "frame-duplicate" },
  ];
  for (const { lines, code } of cases) {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    await toChild(fake, transport);
    for (const line of lines) await fake.line(line);
    assert.equal(transport.diagnostics().poisonCode, code, lines.join(" / "));
    assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
    assert.ok(fake.kills >= 1 || fake.exitCode !== null || fake.signalCode !== null);
    await transport.drain();
  }
  // Strict partial-line rule: in `child` (where no handshake record is expected) a fragment that
  // can no longer become a candidate is unsolicited at once, exactly like the default mode.
  for (const [fragment, code] of [["SUP_CAND 01", "frame-unsolicited"], [`SUP_CAND 1 ${UUID_B.slice(0, 5).toUpperCase()}`, "frame-unsolicited"], ["SUP_CHILD", "frame-unsolicited"], ["SUP_CAND 1 \r", "frame-unsolicited"], ["SUP_CA\u0001", "frame-invalid"]] as const) {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    await toChild(fake, transport);
    await fake.raw(fragment);
    assert.equal(transport.diagnostics().poisonCode, code, fragment);
    await transport.drain();
  }
});

test("transport hook mode: a healthy row has no candidate-count cutoff, yet chunks and other bytes stay bounded", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  await toChild(fake, transport);
  const count = 300;
  for (let seq = 1; seq <= count; seq += 1) {
    const id = `${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000`;
    // Split some records across chunks: fragments obey the same prefix rule.
    if (seq % 7 === 0) {
      await fake.raw(`SUP_CAND ${seq} ${id.slice(0, 10)}`);
      await fake.raw(`${id.slice(10)}\n`);
    } else {
      await fake.line(`SUP_CAND ${seq} ${id}`);
    }
  }
  const diag = transport.diagnostics();
  assert.ok(diag.stdoutBytes > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_BYTES * 10, "far past the default lifetime bound");
  assert.equal(diag.poisonCode, null);
  assert.equal(diag.hookCandidatesCredited, count);
  const latest = transport.observeHookCandidate(RUN);
  assert.ok(latest.status === "candidate" && latest.candidate.sequence === count);
  await settleClean(fake, transport);

  const big = new FakeSupervisor();
  const flooded = attach(big);
  await toChild(big, flooded);
  await big.raw(Buffer.alloc(NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_CHUNK_BYTES + 1, 0x41));
  assert.equal(flooded.diagnostics().poisonCode, "stdout-overflow");
  await flooded.drain();
});

test("transport hook mode: settle stops crediting at once, completes an in-flight fragment, then writes SETTLE", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  await toChild(fake, transport);
  await fake.line(`SUP_CAND 1 ${UUID_A}`);
  await fake.raw(`SUP_CAND 2 ${UUID_B.slice(0, 20)}`);
  const settled = transport.settle();
  await settleIo();
  assert.ok(!fake.writtenText.includes("SETTLE"), "SETTLE waits for the pending genuine fragment");
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  await fake.raw(`${UUID_B.slice(20)}\n`);
  assert.ok(fake.writtenText.endsWith("SETTLE\n"));
  assert.equal(transport.phase, "settling");
  // A genuine candidate already in flight before SUP_SETTLED is tolerated, never credited.
  await fake.line(`SUP_CAND 3 ${UUID_A}`);
  assert.equal(transport.diagnostics().poisonCode, null);
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  // After the settled record no candidate is admissible.
  await fake.raw("SUP_BYE\n");
  await fake.exit(0);
  assert.deepEqual(await settled, { status: "settled", witness: { supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 } });
  const diag = transport.diagnostics();
  assert.equal(diag.hookCandidatesCredited, 1);
  assert.equal(diag.hookCandidatesUncredited, 2);
  assert.equal(fake.writtenText, `${bootBytes(SOURCE)}${keyFrame}CONFIRM ${WRAPPER_PID}\nSETTLE\n`);
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
});

test("transport hook mode: a stop begun before SUP_CHILD admits no candidate line or fragment", async () => {
  // From GO (complete line with a valid tail, and a bare fragment), and from READY.
  for (const [fromGo, payload] of [
    [true, `SUP_CAND 1 ${UUID_A}\nSUP_SETTLED ACTIVE=0 LISTED=0\nSUP_BYE\n`],
    [true, `SUP_CAND 1 ${UUID_A.slice(0, 8)}`],
    [true, "SUP_CA"],
    [false, `SUP_CAND 1 ${UUID_A}\n`],
  ] as const) {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    const started = transport.start(SOURCE, { hookKey: KEY });
    await settleIo();
    await fake.line(`SUP_READY ${SUP_PID}`);
    assert.equal((await started).status, "ready-for-pty-spawn");
    if (fromGo) {
      await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
      const confirmed = transport.confirmPeer(() => WRAPPER_PID);
      await settleIo();
      await fake.line(`SUP_GO ${WRAPPER_PID}`);
      assert.equal((await confirmed).status, "peer-confirmed");
    }
    const settled = transport.settle();
    await settleIo();
    assert.ok(fake.writtenText.endsWith("SETTLE\n"));
    await fake.raw(payload);
    const expected = "frame-unsolicited";
    assert.equal(transport.diagnostics().poisonCode, expected, payload);
    assert.equal(transport.diagnostics().hookCandidatesUncredited, 0);
    assert.deepEqual(await settled, { status: "failed", code: expected, poisoned: true });
    await transport.drain();
  }
});

test("transport hook mode: late, stalled, and truncated candidates around settlement fail closed", async () => {
  // A candidate after SUP_SETTLED is unsolicited.
  {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    await toChild(fake, transport);
    const settled = transport.settle();
    await settleIo();
    await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
    await fake.line(`SUP_CAND 1 ${UUID_A}`);
    assert.deepEqual(await settled, { status: "failed", code: "frame-unsolicited", poisoned: true });
    await transport.drain();
  }
  // A fragment that never completes ends the stop on its own deadline without writing SETTLE.
  {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    await toChild(fake, transport);
    await fake.raw("SUP_CAND 1 0123");
    const startedAt = Date.now();
    assert.deepEqual(await transport.settle(), { status: "failed", code: "timeout", poisoned: true });
    assert.ok(Date.now() - startedAt < 2_000, "bounded by the settle deadline");
    assert.ok(!fake.writtenText.includes("SETTLE"));
    await transport.drain();
  }
  // EOF with a partial candidate is truncation; process exit in child clears the held candidate.
  {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    await toChild(fake, transport);
    await fake.line(`SUP_CAND 1 ${UUID_A}`);
    await fake.raw("SUP_CAND 2 fe");
    fake.stdout.end();
    await settleIo();
    assert.equal(transport.diagnostics().poisonCode, "stdout-truncated");
    assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
    await transport.drain();
  }
  {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    await toChild(fake, transport);
    await fake.line(`SUP_CAND 1 ${UUID_A}`);
    await fake.exit(0);
    assert.equal(transport.diagnostics().poisonCode, "process-exited");
    assert.deepEqual(transport.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
    assert.deepEqual(await transport.settle(), { status: "failed", code: "process-exited", poisoned: true });
  }
});

test("renderer and transport agree byte for byte on the opt-in startup write", async () => {
  const launch = hookLaunch();
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(launch.source, { hookKey: KEY });
  await settleIo();
  assert.equal(fake.writtenText, `${launch.startupFrame.toString("latin1")}${keyFrame}`);
  transport.dispose();
  assert.equal((await started).status, "failed");
  await transport.drain();
});
