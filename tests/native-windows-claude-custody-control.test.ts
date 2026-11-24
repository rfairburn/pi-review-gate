/**
 * #682 native Windows Claude custody — opt-in hook CONTROL (bind/drop/send),
 * portable tests.
 *
 * Pins the renderer's opt-in control composition (default and candidate-only
 * hook renders unchanged byte for byte; exact `BIND`/`DROP`/`SEND` dispatch in
 * `run` only; the immutable landed peer-open and writer sources composed
 * verbatim; fixed closed replies; bound-slot clearing) and the transport's
 * opt-in control lane against an in-memory fake supervisor and one real
 * `node -e` child speaking the same grammar. Cross-grammar tests check the
 * rendered PowerShell command patterns against the transport's actual
 * frames. No PowerShell, PTY, Windows pipe, provider, setting, or filesystem
 * scratch is used; Windows runtime behavior and any host binding stay a later
 * real-host fixture.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES,
  DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_BODY_CHARS,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_COMMAND_CHARS,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES,
  attachNativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodySendCommit,
  type NativeWindowsClaudeCustodySendFence,
  type NativeWindowsClaudeCustodySendOutcome,
  type NativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyTransportOptions,
} from "../src/session-host/native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_CONTROL_CONTRACT,
  WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS,
  WINDOWS_CLAUDE_CUSTODY_CONTROL_SUPERVISOR_SOURCE_TEMPLATE,
  WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS,
  WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE,
  WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_CONTROL_FAIL_STAGES,
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
  WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE,
} from "../src/session-host/native-windows-claude-inbox-peer";
import {
  WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT,
  WINDOWS_CLAUDE_INBOX_WRITE_LIMITS,
  WINDOWS_CLAUDE_INBOX_WRITE_SOURCE,
} from "../src/session-host/native-windows-claude-inbox-write";

const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const CTL_PIPE = "prg682-ctl-fedcba9876543210fedcba9876543210";
const CTL_NONCE = "0123456789abcdef0123456789abcdef";
const HOOK_PIPE = "prg682-hook-00112233445566778899aabbccddeeff";
const BASE = Object.freeze({ powershellPath: POWERSHELL_PATH, ctlPipe: CTL_PIPE, ctlNonce: CTL_NONCE });
/** Default-render pins captured before the hook channel existed (#682 checkpoint 22b5b32). */
const DEFAULT_SOURCE_SHA256 = "19ebca00a80bddf364c86ac051d4cc329485844fcb45fe461c5f244effcc13da";
/** Candidate-only hook-render pins captured before the control mode existed (#682 checkpoint 48cc490 + hook channel). */
const HOOK_SOURCE_SHA256 = "4d6ad0de2400ca25a79c15dead2677b17502975c03425c01a35c68b8b09ea0ba";
const HOOK_BOOTSTRAP_SHA256 = "f8d6144ecc42712ce75048d09c6840de213e9ba19cb3af74e08b9a70c7aa0f42";

/** Synthetic, inert values only. */
const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const RUN = Object.freeze({ runId: "run-682.ctl:a_b", generation: 9 });
const UUID_A = "01234567-89ab-cdef-0123-456789abcdef";
const UUID_B = "fedcba98-7654-3210-fedc-ba9876543210";
const SOURCE = "$ErrorActionPreference = 'Stop'\n# synthetic control boot source\n";
const SUP_PID = 6100;
const WRAPPER_PID = 6204;
const CHILD_PID = 6308;
const TEXT = "callback: build finished \u2713 \u{1F680}\n\"quoted\" \\ end";

const controlLaunch = () => buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE, hookControl: true });

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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

/** A rendered .NET pattern literal (`'^...\z'`) as the equivalent JS pattern. */
function psPattern(source: string, prefix: string): RegExp {
  const at = source.indexOf(`'^${prefix}`);
  assert.ok(at >= 0, `pattern for ${prefix} is rendered`);
  const end = source.indexOf(String.raw`\z'`, at);
  return new RegExp(`${source.slice(at + 1, end)}$`, "u");
}

/* ------------------------------------------------------------- renderer */

test("renderer: default and candidate-only hook renders are byte-identical; hookControl is opt-in and strict", () => {
  const def = buildWindowsClaudeCustodySupervisorLaunch(BASE);
  assert.equal(def.sourceSha256, DEFAULT_SOURCE_SHA256);
  assert.equal(buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookControl: false }).sourceSha256, DEFAULT_SOURCE_SHA256);
  const hook = buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE });
  assert.equal(hook.sourceSha256, HOOK_SOURCE_SHA256);
  assert.equal(sha256(hook.bootstrap), HOOK_BOOTSTRAP_SHA256);
  assert.equal(buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE, hookControl: false }).sourceSha256, HOOK_SOURCE_SHA256);
  for (const needle of ["Wcx", "SUP_BIND", "SUP_DROP", "SUP_SENT", "SupInboxSend", "SupPeerOpen", "CreateFileW", "WriteFile", "$MaxCmd=48"]) {
    assert.ok(!def.source.includes(needle) && !hook.source.includes(needle), `no ${needle} without hookControl`);
    assert.ok(!WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE.includes(needle), `hook template has no ${needle}`);
  }
  assert.throws(() => buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookControl: true }), /requires hookPipe/u);
  for (const hookControl of [null, "true", 1, 0, {}]) {
    assert.throws(() => buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE, hookControl: hookControl as unknown as boolean }));
  }
});

test("renderer: the control body keeps every hook line in order and composes the landed sources verbatim", () => {
  const hookSrc = buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE }).source;
  const launch = controlLaunch();
  const src = launch.source;
  const lines = src.split("\n");
  let at = 0;
  for (const line of hookSrc.split("\n")) {
    let want = line;
    if (line.startsWith("function SupWckStop{")) want = line.replace("{SupWckClear;", "{SupWckClear;SupWcxUnbind;");
    if (line.startsWith("SupWckClear;$script:WckSeq++;")) want = line.replace("SupWckClear;$script:WckSeq++;", "SupWckClear;SupWcxUnbind;$script:WckSeq++;");
    while (at < lines.length && lines[at] !== want) at += 1;
    assert.ok(at < lines.length, `hook line survives in order: ${line.slice(0, 70)}`);
    at += 1;
  }
  // The landed fixed sources, once each and unaltered; the held check is defined exactly once.
  assert.equal(occurrences(src, WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE), 1);
  assert.equal(occurrences(src, WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE), 1);
  assert.equal(occurrences(src, WINDOWS_CLAUDE_INBOX_WRITE_SOURCE), 1);
  for (const name of ["SupPeerHeld", "SupPeerOpen", "SupInboxSend", "SupInboxGuard", "SupInboxPoll", "SupHookServe"]) {
    assert.equal(occurrences(src, `function ${name}(`), 1, `${name} is defined once`);
  }
  assert.doesNotMatch(src, /__[A-Z0-9_]+__/u, "no placeholder survives");
  assert.ok(!src.includes("#PRG-WCK-FIXED#"));
  assert.ok(src.length <= WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
  assert.ok(/^[\t\n\r\x20-\x7e]+$/u.test(src));
  assert.equal(launch.sourceSha256, createHash("sha256").update(src, "ascii").digest("hex"));
  assert.ok(launch.bootstrap.includes(`if($BootLen -ne ${src.length})`) && launch.bootstrap.includes(`'${launch.sourceSha256}'`));
  assert.ok(launch.commandLineLength <= WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE);
  assert.ok(!launch.bootstrap.includes("Wcx") && !launch.bootstrap.includes(HOOK_PIPE), "the bootstrap carries nothing control-specific");
  assert.ok(WINDOWS_CLAUDE_CUSTODY_CONTROL_SUPERVISOR_SOURCE_TEMPLATE.startsWith(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.slice(0, 200)));
});

test("renderer: interop adds exactly the peer-open and writer contracts' missing declarations", () => {
  const src = controlLaunch().source;
  const added = [
    "SupDef 'CreateFileW' $TI @([string],$TN,$TN,$TI,$TN,$TN,$TI)",
    "SupDef 'GetNamedPipeServerProcessId' $TF @($TI,$TA)",
    "SupDef 'CreateEventW' $TI @($TI,$TF,$TF,$TI)",
    "SupDef 'WriteFile' $TF @($TI,$TI,$TN,$TI,$TI)",
    "SupDef 'GetOverlappedResult' $TF @($TI,$TI,$TA,$TF)",
  ];
  const hookAdded = [...WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT.additionalInteropDeclarations, "SupDef 'GetHandleInformation' $TF @($TI,$TA)"];
  assert.ok(src.includes(`SupDef 'SetConsoleCtrlHandler' $TF @($TI,$TF)\n${[...hookAdded, ...added].join("\n")}\n$K=$TB.CreateType()`));
  for (const declaration of [
    ...WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.additionalInteropDeclarations,
    ...WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT.landedContractInteropDeclarations,
    ...WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT.newInteropDeclarations,
  ]) {
    assert.equal(occurrences(src, `${declaration}\n`), 1, `${declaration} declared once`);
  }
  const declared = new Set([...src.matchAll(/^SupDef '([A-Za-z]+)'/gmu)].map((m) => m[1]!));
  const called = new Set([...src.matchAll(/\$(?:K|hk|pk|qk)::([A-Za-z0-9]+)\(/gu)].map((m) => m[1]!));
  for (const name of called) assert.ok(declared.has(name), `${name} is declared`);
});

test("renderer: control commands dispatch only from SupCommand, only in run, only as exact lines", () => {
  const src = controlLaunch().source;
  const command = fn(src, "SupCommand");
  assert.ok(command.startsWith("function SupCommand([string]$cmd){\nif($cmd -cmatch '^(?:BIND|DROP|SEND) '){SupWcxCommand $cmd;return}\nif($cmd -cmatch '^CONFIRM "));
  assert.equal(occurrences(src, "SupWcxCommand $cmd"), 1, "dispatched from SupCommand only");
  const dispatch = fn(src, "SupWcxCommand");
  assertOrdered(dispatch, [
    "if($Phase -cne 'run' -or $null -eq $K -or $CH -eq $Z -or $Job -eq $Z -or $ChildPid -le 0){SupFail 'control-phase' 46}\nSupWcxRequireOwner\n",
    String.raw`'^BIND ([1-9][0-9]{0,15})\z'`,
    String.raw`'^DROP ([1-9][0-9]{0,15})\z'`,
    String.raw`'^SEND ([1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([1-9][0-9]{0,4})\z'`,
    "SupFail 'control-invalid' 47}",
  ], "SupWcxCommand");
  // The wider owner command bound is set once, after the default line, before the loop.
  assertOrdered(src, ["$InBuf=[char[]]::new(1);$InLine='';$MaxCmd=18;SupStdinArm\n$MaxCmd=48\n", "\nwhile($true){"], "MaxCmd");
  assert.equal(WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxCommandChars, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_COMMAND_CHARS);
  // Control functions are defined before the loop that can call them, after the fixed sources.
  assertOrdered(src, ["function SupInboxSend(", "function SupWckTurn{", "function SupWcxBind(", "function SupWcxCommand(", "\nwhile($true){"], "definition order");
  // SupWcxUnbind exists before SupFail, so every early refusal can call it.
  assertOrdered(src, ["function SupWcxUnbind{", "function SupWckClear{", "function SupWckStop{SupWckClear;SupWcxUnbind;", "function SupFail("], "unbind first");
});

test("renderer: bind/drop act only on the supervisor's own exact slots", () => {
  const src = controlLaunch().source;
  assertOrdered(fn(src, "SupWcxBind"), [
    "if($xseq -gt $WckSeq -or $xseq -le $WcxLastBind){SupFail 'control-invalid' 47}\n$script:WcxLastBind=$xseq\n",
    "if($WcxDead){SupOut ('SUP_BIND '+[string]$xseq+' DEAD');return}",
    "if($null -eq $WckCand -or $xseq -ne $WckSeq){SupOut ('SUP_BIND '+[string]$xseq+' STALE');return}",
    "SupWcxUnbind",
    "$script:WcxBound=$WckCand;$script:WcxBoundSeq=$xseq;$script:WckCand=$null",
    "SupOut ('SUP_BIND '+[string]$xseq+' OK')}",
  ], "SupWcxBind");
  assertOrdered(fn(src, "SupWcxDrop"), [
    "if($xseq -gt $WckSeq -or $xseq -le $WcxLastDrop){SupFail 'control-invalid' 47}\n$script:WcxLastDrop=$xseq\n",
    "if($null -ne $WcxBound -and $WcxBoundSeq -eq $xseq){SupWcxUnbind}",
    "if($null -ne $WckCand -and $WckSeq -eq $xseq){SupWckClear}",
    "SupOut ('SUP_DROP '+[string]$xseq)}",
  ], "SupWcxDrop");
  // A new candidate drops the bound one before it is announced; stop and refusal clear both.
  assertOrdered(fn(src, "SupWckTurn"), ["SupWckClear;SupWcxUnbind;$script:WckSeq++;$script:WckCand=$wgot", "SupOut ('SUP_CAND '"], "turn");
  assert.ok(fn(src, "SupSettle").startsWith("function SupSettle{\nSupWckStop\n"));
  assert.ok(fn(src, "SupFail").startsWith("function SupFail([string]$stage,[int]$code){SupWckStop;"));
  assert.ok(fn(src, "SupWcxUnbind").includes("$WcxBound.Clear()"));
  // Memory: exactly two candidate slots exist.
  assert.deepEqual([...new Set([...src.matchAll(/\$script:(Wck(?:Cand)|WcxBound)=([^;}\n]+)/gu)].map((m) => `${m[1]}=${m[2]}`))].sort(), [
    "WckCand=$null",
    "WckCand=$wgot",
    "WcxBound=$WckCand",
    "WcxBound=$null",
  ]);
});

test("renderer: SEND reads one bounded canonical body, then calls the landed writer once against the bound slot", () => {
  const src = controlLaunch().source;
  const body = fn(src, "SupWcxBody");
  assertOrdered(body, [
    "$xclock=[Diagnostics.Stopwatch]::StartNew()",
    "$xbuf=[char[]]::new($xn+1)",
    "if(-not $InTask.Wait(3000)){return $null}",
    "if([int]$InTask.Result -ne 1){return $null}",
    "$xbuf[0]=$InBuf[0]",
    "$xleft=[long]3000-$xclock.ElapsedMilliseconds",
    "$xtask=$StdIn.ReadBlockAsync($xbuf,1,$xn)",
    "if(-not $xtask.Wait([int]$xleft)){return $null}",
    "if($xtask.Result -ne $xn){return $null}",
    "if($xclock.ElapsedMilliseconds -ge 3000){return $null}",
    "if([int]$xbuf[$xn] -ne 10){return $null}",
    String.raw`if($xs -cnotmatch '^[A-Za-z0-9+/]+={0,2}\z'){return $null}`,
    "$xbytes=[Convert]::FromBase64String($xs)",
    `if($xbytes.Length -lt 1 -or $xbytes.Length -gt ${WINDOWS_CLAUDE_INBOX_WRITE_LIMITS.contentMaxBytes}){return $null}`,
    "if([Convert]::ToBase64String($xbytes) -cne $xs){return $null}",
    "$xtext=[Text.UTF8Encoding]::new($false,$true).GetString($xbytes)",
    "SupStdinArm",
    "return $xtext",
    "}catch{return $null}",
    "finally{if($null -ne $xbuf){[Array]::Clear($xbuf,0,$xbuf.Length)};if($null -ne $xbytes){[Array]::Clear($xbytes,0,$xbytes.Length)}",
  ], "SupWcxBody");
  assert.equal(occurrences(src, "$StdIn.ReadBlockAsync("), 1, "one body reader, the one startup reader");
  assert.equal(occurrences(src, "OpenStandardInput"), 0);
  const send = fn(src, "SupWcxSend");
  assertOrdered(send, [
    `if($xatt -le $WcxAttempt -or $xseq -gt $WckSeq -or $xn -gt ${WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxBodyChars} -or ($xn % 4) -ne 0){SupFail 'control-invalid' 47}`,
    "$script:WcxAttempt=$xatt",
    "$xtext=SupWcxBody $xn",
    "if($xtext -isnot [string]){$xtext=$null;SupFail 'control-body' 49}\nSupWcxRequireOwner\n",
    "if($WcxDead -or $null -eq $WcxBound -or $WcxBoundSeq -ne $xseq){$xtext=$null;SupOut ('SUP_SENT '+[string]$xatt+' STALE');return}",
    "SupInboxSend $K $CH $ChildPid $Job $WcxBound $xtext ([Diagnostics.Stopwatch]::StartNew()) ([long]4000) $xcts.Token ([ref]$xsent)",
    "$xtext=$null;$xo='UNSETTLED'",
    "if($xr -ceq 'sent-unconfirmed'){if($xsent -gt 0){$xo='SENT'}else{$xo='UNKNOWN'}}",
    "elseif(($xr -ceq 'unknown-unsettled') -or ($xr -ceq 'unknown-unexpected')){$xo='UNSETTLED'}",
    "if($xo -ceq 'UNSETTLED'){$script:WcxDead=$true;SupWcxUnbind;SupWckClear}",
    "else{if($xo -ceq 'UNKNOWN'){SupWcxUnbind};",
    "SupOut ('SUP_SENT '+[string]$xatt+' '+$xo)}",
  ], "SupWcxSend");
  assert.equal(occurrences(src, "SupInboxSend $K"), 1, "the writer is invoked once, from SupWcxSend only");
  const call = /SupInboxSend (\$K \$CH \$ChildPid \$Job) /u.exec(send)![1]!.split(" ");
  assert.deepEqual(call, WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT.arguments.slice(0, 4).map((a) => a.source));
  assert.ok(WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.sendBudgetMs <= WINDOWS_CLAUDE_INBOX_WRITE_LIMITS.budgetMaxMs);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxBlockingMs, 3000 + 4000 + WINDOWS_CLAUDE_INBOX_WRITE_LIMITS.cancelGraceMs);
  // Every send outcome word the supervisor can print is in the transport's closed grammar.
  const words = new Set([...send.matchAll(/\$xo='([A-Z]+)'/gu)].map((m) => m[1]!));
  words.add("STALE");
  assert.deepEqual([...words].sort(), ["CUSTODY", "LIMIT", "OTHER", "PEER", "SENT", "STALE", "UNKNOWN", "UNSETTLED"]);
});

test("renderer: replies carry only a number and a closed word; no secret reaches any output", () => {
  const src = controlLaunch().source;
  // Every argument handed to stdout or stderr, in the whole control body.
  const outputs = [...src.matchAll(/(?:SupOut|SupDiag) (\([^;{}]*\)|'[^']*')/gu)].map((m) => m[1]!);
  assert.ok(outputs.length > 20);
  for (const arg of outputs) {
    assert.doesNotMatch(arg, /WckKey|WckBuf|WckM\b|Token|Endpoint|WckRun|WcxBound\b|xtext|xbuf|xbytes|\$xs\b|\$xr\b/u, `no secret in output: ${arg.slice(0, 80)}`);
  }
  assert.equal(occurrences(src, "[Console]::Out"), 2, "stdout is written only by SupOut");
  assert.deepEqual(
    [...src.matchAll(/SupOut \(?'([A-Z_]+)/gu)].map((m) => m[1]).filter((r) => /^SUP_(BIND|DROP|SENT)$/u.test(r!)),
    ["SUP_BIND", "SUP_BIND", "SUP_BIND", "SUP_DROP", "SUP_SENT", "SUP_SENT"],
  );
  // Rendered reply shapes match the transport's closed patterns.
  const bind = /^SUP_BIND ([1-9][0-9]{0,15}) (OK|STALE|DEAD)$/u;
  for (const word of ["OK", "STALE", "DEAD"]) assert.ok(src.includes(`SupOut ('SUP_BIND '+[string]$xseq+' ${word}')`) && bind.test(`SUP_BIND 7 ${word}`));
});

test("renderer: control names never collide with supervisor, hook, receiver, peer, writer, or automatic variables", () => {
  const src = controlLaunch().source;
  const hookSrc = buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE }).source;
  const fixed = [WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE, WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE, WINDOWS_CLAUDE_INBOX_WRITE_SOURCE];
  const others = new Set([
    ...varsOf(hookSrc),
    ...fixed.flatMap((text) => [...varsOf(text)]),
    "supblock", "bootenc", "stdin", "bootclock", "boothead", "boottask", "bootm", "bootlen", "bootleft", "bootsrc", "boottext", "bootsha",
    "pid", "input", "args", "error", "host", "this", "_", "home", "psitem", "env", "lastexitcode",
  ]);
  const controlText = [
    src.slice(src.indexOf("function SupWcxRequireOwner{"), src.indexOf("\nwhile($true){")),
    fn(src, "SupWcxUnbind"),
    src.split("\n").find((line) => line.startsWith("$WcxBound="))!,
  ].join("\n");
  const shared = new Set(["matches", "intask", "inbuf", "stdin", "wckseq", "wckcand", "phase", "ch", "childpid", "job", "k", "z", "true", "false", "null"]);
  const names = [...varsOf(controlText)];
  const own = names.filter((n) => /^(?:x[a-z0-9]+|wcx[a-z0-9]+)$/u.test(n));
  assert.ok(own.length >= 22);
  for (const name of own) assert.ok(!others.has(name), `${name} is distinct from every other name`);
  for (const name of names.filter((n) => !own.includes(n))) assert.ok(shared.has(name), `${name} is a documented shared read`);
  for (const name of shared) if (!["true", "false", "null"].includes(name)) assert.ok(names.includes(name), `control reads ${name}`);
});

test("renderer: control refusal stages are fresh, classified, and control-only", () => {
  const taken = [
    ...Object.values(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES),
    ...Object.values(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES),
    ...Object.values(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_HOOK_FAIL_STAGES),
    WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE,
  ];
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_CONTROL_FAIL_STAGES));
  const hookSrc = buildWindowsClaudeCustodySupervisorLaunch({ ...BASE, hookPipe: HOOK_PIPE }).source;
  const src = controlLaunch().source;
  for (const [stage, code] of Object.entries(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_CONTROL_FAIL_STAGES)) {
    assert.ok(!taken.includes(code), `${stage} has a fresh code`);
    assert.deepEqual(classifyWindowsClaudeCustodySupervisorExit(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE + code), { kind: "failed", stage, code });
    assert.ok(!hookSrc.includes(`'${stage}'`), `${stage} is control-only`);
    assert.ok(src.includes(`SupFail '${stage}' ${code}`), `${stage} is rendered with its code`);
  }
  const contract = WINDOWS_CLAUDE_CUSTODY_CONTROL_CONTRACT;
  assert.ok(Object.isFrozen(contract) && Object.isFrozen(contract.send.outcomes) && Object.isFrozen(contract.memory.cleared));
  assert.equal(contract.send.maxBlockingMs, WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxBlockingMs);
  // The transport's default reply deadlines cover the supervisor's worst case ahead of each reply.
  assert.ok(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES.controlMs > WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS);
  assert.ok(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES.sendMs > WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS + WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxBlockingMs);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxBodyChars, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_BODY_CHARS);
  assert.equal(WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.contentMaxBytes, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES);
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

  constructor() {
    super();
    const write = this.stdin.write.bind(this.stdin) as (...args: unknown[]) => boolean;
    (this.stdin as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(chunk)) this.written = Buffer.concat([this.written, chunk]);
      return write(chunk, ...rest);
    };
    this.stdin.resume();
  }

  get writtenText(): string {
    return this.written.toString("latin1");
  }

  /** Everything written after the boot and key frames. */
  get commands(): string {
    const text = this.writtenText;
    const at = text.indexOf(`PRG-WCK1 ${KEY} ${RUN.runId}\n`);
    return at < 0 ? text : text.slice(at + `PRG-WCK1 ${KEY} ${RUN.runId}\n`.length);
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

interface Harness {
  readonly fake: FakeSupervisor;
  readonly transport: NativeWindowsClaudeCustodyTransport;
  current: boolean;
}

function attach(overrides: Partial<NativeWindowsClaudeCustodyTransportOptions> = {}): Harness {
  const fake = new FakeSupervisor();
  const harness = { fake, current: true } as Harness;
  const result = attachNativeWindowsClaudeCustodyTransport({
    child: fake as unknown as ChildProcess,
    run: RUN,
    isRunCurrent: () => harness.current,
    deadlines: { readyMs: 500, peerMs: 500, childMs: 500, settleMs: 500 },
    hookCandidates: true,
    hookControl: true,
    controlDeadlines: { controlMs: 500, sendMs: 500 },
    ...overrides,
  });
  assert.equal(result.status, "attached");
  (harness as { transport: NativeWindowsClaudeCustodyTransport }).transport = result.status === "attached" ? result.transport : (undefined as never);
  return harness;
}

async function toChild(h: Harness, hookKey: string | null = KEY): Promise<void> {
  const started = h.transport.start(SOURCE, hookKey === null ? undefined : { hookKey });
  await settleIo();
  await h.fake.line(`SUP_READY ${SUP_PID}`);
  assert.equal((await started).status, "ready-for-pty-spawn");
  await h.fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = h.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await h.fake.line(`SUP_GO ${WRAPPER_PID}`);
  assert.equal((await confirmed).status, "peer-confirmed");
  await h.fake.line(`SUP_CHILD ${CHILD_PID}`);
  assert.equal((await h.transport.awaitChild()).status, "child-established");
}

const yes = Object.freeze({ isBindingCurrent: () => true });

/** Drive to child, announce candidate 1, and bind it exactly. */
async function bound(h: Harness, sessionId = UUID_A): Promise<void> {
  await toChild(h);
  await h.fake.line(`SUP_CAND 1 ${sessionId}`);
  const pending = h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId }, yes);
  await settleIo();
  assert.ok(h.fake.commands.endsWith("BIND 1\n"));
  await h.fake.line("SUP_BIND 1 OK");
  assert.deepEqual(await pending, { status: "bound", binding: { sequence: 1, sessionId } });
}

function fence(sessionId = UUID_A, sequence = 1, extra: Partial<NativeWindowsClaudeCustodySendFence> = {}): NativeWindowsClaudeCustodySendFence {
  return { binding: { sequence, sessionId }, isBindingCurrent: () => true, ...extra };
}

function sendFrame(attemptId: number, boundSeq: number, text: string): string {
  const body = Buffer.from(text, "utf8").toString("base64");
  return `SEND ${attemptId} ${boundSeq} ${body.length}\n${body}\n`;
}

/** Prepare and commit; returns the commit and how many times the payload ran. */
/** `f: null` commits with the fence argument omitted entirely. */
function commit(h: Harness, text: unknown = TEXT, f: NativeWindowsClaudeCustodySendFence | null = fence()): { result: NativeWindowsClaudeCustodySendCommit; calls: number } {
  const prepared = h.transport.prepareSend(RUN);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") throw new Error("unreachable");
  let calls = 0;
  const payload = (): string => {
    calls += 1;
    return text as string;
  };
  const result = f === null ? prepared.attempt.commit(payload) : prepared.attempt.commit(payload, f);
  return { result, calls };
}

function outcomeOf(result: NativeWindowsClaudeCustodySendCommit): Promise<NativeWindowsClaudeCustodySendOutcome> {
  assert.equal(result.status, "dispatched");
  return result.status === "dispatched" ? result.outcome : (undefined as never);
}

async function settleClean(h: Harness): Promise<void> {
  const settled = h.transport.settle();
  await settleIo();
  await h.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.fake.line("SUP_BYE");
  await h.fake.exit(0);
  assert.deepEqual(await settled, { status: "settled", witness: { supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 } });
}

test("transport attach: hookControl needs hookCandidates; control deadlines need hookControl; bad values are refused", () => {
  const bad: Record<string, unknown>[] = [
    { hookCandidates: undefined },
    { hookCandidates: false },
    { hookControl: "yes" },
    { hookControl: undefined, controlDeadlines: { controlMs: 100 } },
    { hookControl: false, controlDeadlines: { controlMs: 100 } },
    { controlDeadlines: { controlMs: 0 } },
    { controlDeadlines: { sendMs: 120_001 } },
    { controlDeadlines: { sendMs: 1.5 } },
    { controlDeadlines: null },
  ];
  for (const overrides of bad) {
    const fake = new FakeSupervisor();
    const options = { child: fake, run: RUN, isRunCurrent: () => true, hookCandidates: true, hookControl: true, ...overrides };
    assert.deepEqual(
      attachNativeWindowsClaudeCustodyTransport(options as unknown as NativeWindowsClaudeCustodyTransportOptions),
      { status: "refused", code: "options-invalid" },
      JSON.stringify(overrides),
    );
    assert.equal(fake.writtenText, "");
  }
  const fake = new FakeSupervisor();
  assert.equal(attachNativeWindowsClaudeCustodyTransport({ child: fake as unknown as ChildProcess, run: RUN, isRunCurrent: () => true, hookCandidates: true, hookControl: true }).status, "attached");
});

test("transport without hookControl: no control lane, commit never invokes the payload, grammar unchanged", async () => {
  const h = attach({ hookControl: undefined, controlDeadlines: undefined });
  await toChild(h);
  await h.fake.line(`SUP_CAND 1 ${UUID_A}`);
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes), { status: "refused", code: "control-disabled" });
  assert.deepEqual(await h.transport.dropHookCandidate(RUN, 1), { status: "refused", code: "control-disabled" });
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "refused", code: "control-disabled" });
  const { result, calls } = commit(h);
  assert.deepEqual(result, { status: "not-sent", code: "lane-unavailable" });
  assert.equal(calls, 0, "the payload is never invoked without hook control");
  assert.equal(h.fake.commands, `CONFIRM ${WRAPPER_PID}\n`);
  // A control reply is not part of the candidate-only grammar.
  await h.fake.line("SUP_BIND 1 OK");
  assert.equal(h.transport.diagnostics().poisonCode, "frame-invalid");
});

test("transport: exact bind, one SEND frame, sent-unconfirmed only for SENT, then clean exact settlement", async () => {
  const h = attach();
  await bound(h);
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "bound", binding: { sequence: 1, sessionId: UUID_A } });
  assert.equal(h.transport.diagnostics().hookControlBound, true);
  const before = h.fake.commands;
  const { result, calls } = commit(h);
  assert.equal(calls, 1);
  assert.equal(result.status, "dispatched");
  const outcome = outcomeOf(result);
  await settleIo();
  const frame = h.fake.commands.slice(before.length);
  assert.equal(frame, sendFrame(1, 1, TEXT), "exactly one SEND frame");
  const [header, body, tail] = frame.split("\n");
  assert.equal(tail, "");
  assert.match(header!, psPattern(controlLaunch().source, "SEND "), "the rendered supervisor pattern accepts the header");
  assert.ok(header!.length <= NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_COMMAND_CHARS);
  assert.match(body!, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.equal(Buffer.from(body!, "base64").toString("base64"), body, "canonical base64");
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(body!, "base64")), TEXT);
  // One attempt in flight: no second prepare, no bind/drop while unanswered.
  assert.deepEqual(h.transport.prepareSend(RUN), { status: "refused", code: "attempt-in-flight" });
  assert.deepEqual(await h.transport.dropHookCandidate(RUN, 1), { status: "refused", code: "control-busy" });
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" }, "the busy DROP still revoked local authority");
  await h.fake.line("SUP_SENT 1 SENT");
  assert.deepEqual(await outcome, { status: "sent-unconfirmed", attemptId: 1 });
  // Exactly the written bytes: no key, token, or endpoint is ever re-emitted.
  assert.equal(h.fake.commands, `CONFIRM ${WRAPPER_PID}\nBIND 1\n${sendFrame(1, 1, TEXT)}`);
  assert.equal(occurrences(h.fake.writtenText, KEY), 1, "the key exists only in its one key frame");
  await settleClean(h);
  assert.deepEqual(h.transport.diagnostics().hookControlReplies, 2);
});

test("transport: a fresh binding allows later attempts with strictly increasing ids; DROP revokes", async () => {
  const h = attach();
  await bound(h);
  const first = commit(h);
  await settleIo();
  await h.fake.line("SUP_SENT 1 PEER");
  assert.deepEqual(await outcomeOf(first.result), { status: "not-sent", attemptId: 1, code: "peer" });
  // A prepared-then-abandoned attempt spends its id.
  const abandoned = h.transport.prepareSend(RUN);
  assert.equal(abandoned.status, "prepared");
  if (abandoned.status === "prepared") abandoned.attempt.abandon();
  const third = commit(h, "second callback");
  await settleIo();
  assert.ok(h.fake.commands.endsWith(sendFrame(3, 1, "second callback")));
  await h.fake.line("SUP_SENT 3 SENT");
  assert.deepEqual(await outcomeOf(third.result), { status: "sent-unconfirmed", attemptId: 3 });
  const dropped = h.transport.dropHookCandidate(RUN, 1);
  await settleIo();
  assert.ok(h.fake.commands.endsWith("DROP 1\n"));
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" });
  await h.fake.line("SUP_DROP 1");
  assert.deepEqual(await dropped, { status: "dropped", sequence: 1 });
  const after = commit(h);
  assert.deepEqual(after.result, { status: "not-sent", code: "binding-not-current" });
  assert.equal(after.calls, 0);
  assert.deepEqual(await h.transport.dropHookCandidate(RUN, 2), { status: "refused", code: "binding-not-current" }, "an unannounced sequence");
  await settleClean(h);
});

test("transport: bind refusals write nothing (stale, foreign, superseded, fence false/throw, aborted, busy)", async () => {
  const h = attach();
  await toChild(h);
  const base = h.fake.commands;
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes), { status: "refused", code: "binding-not-current" }, "nothing announced");
  await h.fake.line(`SUP_CAND 1 ${UUID_A}`);
  await h.fake.line(`SUP_CAND 2 ${UUID_B}`);
  const cases: [unknown, unknown, string][] = [
    [{ sequence: 1, sessionId: UUID_A }, yes, "binding-not-current"],
    [{ sequence: 2, sessionId: UUID_A }, yes, "binding-not-current"],
    [{ sequence: 3, sessionId: UUID_B }, yes, "binding-not-current"],
    [{ sequence: 2, sessionId: UUID_B.toUpperCase() }, yes, "binding-not-current"],
    [{ sequence: "2", sessionId: UUID_B }, yes, "binding-not-current"],
    [{ sequence: 2, sessionId: UUID_B }, { isBindingCurrent: () => false }, "binding-not-current"],
    [{ sequence: 2, sessionId: UUID_B }, { isBindingCurrent: () => 1 }, "binding-not-current"],
    [{ sequence: 2, sessionId: UUID_B }, { isBindingCurrent: () => { throw new Error("x"); } }, "binding-not-current"],
    [{ sequence: 2, sessionId: UUID_B }, { isBindingCurrent: () => true, signal: AbortSignal.abort() }, "cancelled"],
    [{ sequence: 2, sessionId: UUID_B }, {}, "options-invalid"],
    [{ sequence: 2, sessionId: UUID_B }, null, "options-invalid"],
  ];
  for (const [binding, f, code] of cases) {
    assert.deepEqual(
      await h.transport.bindHookCandidate(RUN, binding as never, f as never),
      { status: "refused", code },
      JSON.stringify(binding),
    );
  }
  h.current = false;
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 2, sessionId: UUID_B }, yes), { status: "refused", code: "run-not-current" });
  h.current = true;
  assert.deepEqual(await h.transport.bindHookCandidate({ ...RUN, generation: 10 }, { sequence: 2, sessionId: UUID_B }, yes), { status: "refused", code: "run-not-current" });
  // Reentrancy: a fence that itself issues a DROP is re-read against; only the DROP is written.
  let nested: Promise<unknown> | undefined;
  const reentrant = { isBindingCurrent: () => { nested ??= h.transport.dropHookCandidate(RUN, 2); return true; } };
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 2, sessionId: UUID_B }, reentrant), { status: "refused", code: "control-busy" });
  await settleIo();
  assert.equal(h.fake.commands, `${base}DROP 2\n`);
  await h.fake.line("SUP_DROP 2");
  assert.deepEqual(await nested, { status: "dropped", sequence: 2 });
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 2, sessionId: UUID_B }, yes), { status: "refused", code: "binding-not-current" }, "a dropped candidate");
  // Supervisor output mid-record blocks every command.
  await h.fake.raw("SUP_CAND 3");
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 2, sessionId: UUID_B }, yes), { status: "refused", code: "control-busy" });
  await h.fake.raw(` ${UUID_A}\n`);
  // A fence that flips the run is re-read against before the write.
  let fenced = 0;
  assert.deepEqual(
    await h.transport.bindHookCandidate(RUN, { sequence: 3, sessionId: UUID_A }, { isBindingCurrent: () => { fenced += 1; h.current = false; return true; } }),
    { status: "refused", code: "run-not-current" },
  );
  assert.equal(fenced, 1);
  h.current = true;
  await h.fake.line(`SUP_CAND 4 ${UUID_A}`);
  assert.equal(h.fake.commands, `${base}DROP 2\n`, "no BIND was written");
  // Busy: one unanswered bind blocks the next.
  const first = h.transport.bindHookCandidate(RUN, { sequence: 4, sessionId: UUID_A }, yes);
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 4, sessionId: UUID_A }, yes), { status: "refused", code: "control-busy" });
  await settleIo();
  await h.fake.line("SUP_BIND 4 OK");
  assert.equal((await first).status, "bound");
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 4, sessionId: UUID_A }, yes), { status: "refused", code: "already-bound" });
  assert.equal(h.fake.commands, `${base}DROP 2\nBIND 4\n`);
  await settleClean(h);
});

test("transport: commit refusals before the write never send a byte (stale/foreign/superseded/false/throw/abort/payload)", async () => {
  const h = attach();
  await toChild(h);
  await h.fake.line(`SUP_CAND 1 ${UUID_A}`);
  const unbound = commit(h);
  assert.deepEqual(unbound.result, { status: "not-sent", code: "binding-not-current" });
  assert.equal(unbound.calls, 0);
  const pending = h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
  await settleIo();
  await h.fake.line("SUP_BIND 1 OK");
  assert.equal((await pending).status, "bound");
  const base = h.fake.commands;
  const refusals: [NativeWindowsClaudeCustodySendFence | null, string][] = [
    [null, "binding-not-current"],
    [fence(UUID_B), "binding-not-current"],
    [fence(UUID_A, 2), "binding-not-current"],
    [fence(UUID_A, 1, { isBindingCurrent: () => false }), "binding-not-current"],
    [fence(UUID_A, 1, { isBindingCurrent: () => { throw new Error("boom"); } }), "binding-not-current"],
    [fence(UUID_A, 1, { signal: AbortSignal.abort() }), "cancelled"],
    [{ binding: { sequence: 1, sessionId: UUID_A } } as unknown as NativeWindowsClaudeCustodySendFence, "binding-not-current"],
  ];
  for (const [f, code] of refusals) {
    const { result, calls } = commit(h, TEXT, f);
    assert.deepEqual(result, { status: "not-sent", code }, JSON.stringify(f));
    assert.equal(calls, 0, "the payload is never produced");
  }
  for (const text of ["", "\ud800 lone", "x".repeat(NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES + 1), "\u00e9".repeat(32_769), 7, null]) {
    const { result, calls } = commit(h, text);
    assert.deepEqual(result, { status: "not-sent", code: "payload-invalid" });
    assert.equal(calls, 1);
  }
  const prepared = h.transport.prepareSend(RUN);
  assert.equal(prepared.status, "prepared");
  if (prepared.status === "prepared") {
    assert.deepEqual(prepared.attempt.commit(() => { throw new Error("secret-ish"); }, fence()), { status: "not-sent", code: "payload-invalid" });
    assert.deepEqual(prepared.attempt.commit(() => TEXT, fence()), { status: "not-sent", code: "attempt-spent" }, "one attempt per commit");
  }
  // The second fence (after the payload) is authoritative: a flip there sends nothing.
  let reads = 0;
  const flip = commit(h, TEXT, fence(UUID_A, 1, { isBindingCurrent: () => (reads += 1) === 1 }));
  assert.deepEqual(flip.result, { status: "not-sent", code: "binding-not-current" });
  assert.deepEqual([flip.calls, reads], [1, 2]);
  const aborter = new AbortController();
  const aborted = h.transport.prepareSend(RUN);
  if (aborted.status === "prepared") {
    assert.deepEqual(aborted.attempt.commit(() => { aborter.abort(); return TEXT; }, fence(UUID_A, 1, { signal: aborter.signal })), { status: "not-sent", code: "cancelled" });
  }
  const runFlip = h.transport.prepareSend(RUN);
  if (runFlip.status === "prepared") {
    assert.deepEqual(runFlip.attempt.commit(() => { h.current = false; return TEXT; }, fence()), { status: "not-sent", code: "run-not-current" });
    h.current = true;
  }
  // A reentrant prepare from inside the fence is refused; the outer attempt still decides alone.
  let nested: unknown;
  const reentrant = commit(h, TEXT, fence(UUID_A, 1, { isBindingCurrent: () => { nested ??= h.transport.prepareSend(RUN); return true; } }));
  assert.deepEqual(nested, { status: "refused", code: "attempt-in-flight" });
  const outcome = outcomeOf(reentrant.result);
  const attemptId = reentrant.result.status === "dispatched" ? reentrant.result.attemptId : 0;
  assert.equal(attemptId, 19, "every prepared attempt spent its own id");
  assert.equal(h.fake.commands.slice(base.length), sendFrame(attemptId, 1, TEXT), "only the one dispatched frame was written");
  await h.fake.line(`SUP_SENT ${attemptId} LIMIT`);
  assert.deepEqual(await outcome, { status: "not-sent", attemptId, code: "limit" });
  // Superseded: a newer candidate invalidates local authority until an exact rebind.
  await h.fake.line(`SUP_CAND 2 ${UUID_A}`);
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" });
  assert.deepEqual(commit(h).result, { status: "not-sent", code: "binding-not-current" });
  assert.deepEqual(commit(h, TEXT, fence(UUID_A, 2)).result, { status: "not-sent", code: "binding-not-current" });
  await settleClean(h);
});

test("transport: every SUP_SENT word maps to one closed outcome and its authority effect", async () => {
  const expected: Record<string, [NativeWindowsClaudeCustodySendOutcome["status"], string | null, boolean]> = {
    SENT: ["sent-unconfirmed", null, true],
    PEER: ["not-sent", "peer", true],
    CUSTODY: ["not-sent", "custody", true],
    LIMIT: ["not-sent", "limit", true],
    OTHER: ["not-sent", "other", true],
    STALE: ["not-sent", "stale", false],
    UNKNOWN: ["unknown", "write-uncertain", false],
    UNSETTLED: ["unknown", "write-unsettled", false],
  };
  for (const [word, [status, code, keeps]] of Object.entries(expected)) {
    const h = attach();
    await bound(h);
    const { result } = commit(h);
    const outcome = outcomeOf(result);
    await settleIo();
    await h.fake.line(`SUP_SENT 1 ${word}`);
    assert.deepEqual(await outcome, code === null ? { status, attemptId: 1 } : { status, attemptId: 1, code }, word);
    assert.equal(h.transport.observeHookBinding(RUN).status, keeps ? "bound" : "none", `${word} binding`);
    if (word === "UNSETTLED") {
      // The candidate and inbox are poisoned: no later bind is ever written.
      await h.fake.line(`SUP_CAND 2 ${UUID_B}`);
      const base = h.fake.commands;
      assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 2, sessionId: UUID_B }, yes), { status: "refused", code: "lane-poisoned" });
      assert.equal(h.fake.commands, base);
    }
    await settleClean(h);
  }
});

test("transport: wrong sequence, wrong attempt, wrong kind, and contradictory replies poison", async () => {
  const run = async (script: (h: Harness) => Promise<unknown>, code: string): Promise<Harness> => {
    const h = attach();
    await toChild(h);
    await h.fake.line(`SUP_CAND 1 ${UUID_A}`);
    await script(h);
    assert.equal(h.transport.diagnostics().poisonCode, code);
    assert.equal(h.fake.kills, 1, "poison kills the owned supervisor");
    assert.equal(h.transport.diagnostics().hookControlBound, false);
    return h;
  };
  await run(async (h) => h.fake.line("SUP_BIND 1 OK"), "frame-unsolicited");
  await run(async (h) => h.fake.line("SUP_SENT 1 SENT"), "frame-unsolicited");
  await run(async (h) => {
    const bind = h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
    await settleIo();
    await h.fake.line("SUP_BIND 2 OK");
    assert.deepEqual(await bind, { status: "failed", code: "control-reply", poisoned: true });
  }, "control-reply");
  await run(async (h) => {
    void h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
    await settleIo();
    await h.fake.line("SUP_DROP 1");
  }, "frame-unsolicited");
  await run(async (h) => {
    void h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
    await settleIo();
    await h.fake.line("SUP_BIND 1 DEAD");
  }, "control-reply");
  await run(async (h) => {
    void h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
    await settleIo();
    await h.fake.line("SUP_BIND 1 MAYBE");
  }, "frame-invalid");
  await run(async (h) => {
    // The supervisor binds only its latest candidate: OK after a newer one contradicts it.
    const bind = h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
    await settleIo();
    await h.fake.line(`SUP_CAND 2 ${UUID_B}`);
    await h.fake.line("SUP_BIND 1 OK");
    assert.equal((await bind).status, "failed");
  }, "control-reply");
  const sendCase = async (lines: readonly string[], code: string, outcomeCode: string): Promise<void> => {
    await run(async (h) => {
      const bind = h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
      await settleIo();
      await h.fake.line("SUP_BIND 1 OK");
      assert.equal((await bind).status, "bound");
      const outcome = outcomeOf(commit(h).result);
      await settleIo();
      for (const line of lines) await h.fake.line(line);
      assert.deepEqual(await outcome, { status: "unknown", attemptId: 1, code: outcomeCode });
    }, code);
  };
  await sendCase(["SUP_SENT 2 SENT"], "control-reply", "transport-failed");
  await sendCase(["SUP_SENT 01 SENT"], "frame-invalid", "transport-failed");
  await sendCase(["SUP_SENT 1 SENT extra"], "frame-invalid", "transport-failed");
  await sendCase([`SUP_CAND 2 ${UUID_B}`, "SUP_SENT 1 SENT"], "control-reply", "transport-failed");
  await sendCase(["SUP_BIND 1 OK"], "frame-unsolicited", "transport-failed");
  // A genuine STALE after a newer candidate is the consistent answer, not a contradiction.
  const h = attach();
  await bound(h);
  const outcome = outcomeOf(commit(h).result);
  await settleIo();
  await h.fake.line(`SUP_CAND 2 ${UUID_B}`);
  await h.fake.line("SUP_SENT 1 STALE");
  assert.deepEqual(await outcome, { status: "not-sent", attemptId: 1, code: "stale" });
  assert.equal(h.transport.diagnostics().poisonCode, null);
  await settleClean(h);
});

test("transport: after-frame cancellation is unknown; the exact late reply drains and is never retargeted", async () => {
  const h = attach();
  await bound(h);
  const aborter = new AbortController();
  const outcome = outcomeOf(commit(h, TEXT, fence(UUID_A, 1, { signal: aborter.signal })).result);
  await settleIo();
  aborter.abort();
  assert.deepEqual(await outcome, { status: "unknown", attemptId: 1, code: "cancelled" });
  // Still one operation in flight until the exact reply drains.
  assert.deepEqual(h.transport.prepareSend(RUN), { status: "refused", code: "attempt-in-flight" });
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes), { status: "refused", code: "control-busy" });
  await h.fake.line("SUP_SENT 1 SENT");
  assert.equal(h.transport.diagnostics().hookControlDrained, 1);
  assert.equal(h.transport.diagnostics().poisonCode, null);
  // The next attempt is a new id; the drained reply never answered it.
  const next = outcomeOf(commit(h).result);
  await settleIo();
  assert.ok(h.fake.commands.endsWith(sendFrame(2, 1, TEXT)));
  await h.fake.line("SUP_SENT 2 UNKNOWN");
  assert.deepEqual(await next, { status: "unknown", attemptId: 2, code: "write-uncertain" });
  // A cancelled bind drains too, and a late OK never creates local authority.
  await h.fake.line(`SUP_CAND 2 ${UUID_B}`);
  const bindAbort = new AbortController();
  const bind = h.transport.bindHookCandidate(RUN, { sequence: 2, sessionId: UUID_B }, { isBindingCurrent: () => true, signal: bindAbort.signal });
  await settleIo();
  bindAbort.abort();
  assert.deepEqual(await bind, { status: "unknown", code: "cancelled" });
  await h.fake.line("SUP_BIND 2 OK");
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" }, "acceptance is never inferred");
  assert.equal(h.transport.diagnostics().hookControlDrained, 2);
  await settleClean(h);
});

test("transport: a reply deadline poisons; the dispatched attempt is unknown, never retried", async () => {
  const h = attach({ controlDeadlines: { controlMs: 500, sendMs: 30 } });
  await bound(h);
  const outcome = outcomeOf(commit(h).result);
  assert.deepEqual(await outcome, { status: "unknown", attemptId: 1, code: "timeout" });
  assert.equal(h.transport.diagnostics().poisonCode, "timeout");
  assert.equal(h.fake.kills, 1);
  assert.equal(occurrences(h.fake.commands, "SEND "), 1, "never retried");
  const b = attach({ controlDeadlines: { controlMs: 30 } });
  await toChild(b);
  await b.fake.line(`SUP_CAND 1 ${UUID_A}`);
  assert.deepEqual(await b.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes), { status: "failed", code: "timeout", poisoned: true });
});

test("transport: stop with a pending send drains its exact reply before the witnessed settlement", async () => {
  const h = attach();
  await bound(h);
  const outcome = outcomeOf(commit(h).result);
  await settleIo();
  const settled = h.transport.settle();
  await settleIo();
  assert.ok(h.fake.commands.endsWith(`${sendFrame(1, 1, TEXT)}SETTLE\n`), "SETTLE follows the unanswered SEND");
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "refused", code: "custody-not-current" });
  assert.deepEqual(h.transport.prepareSend(RUN), { status: "refused", code: "custody-not-current" });
  await h.fake.line("SUP_SENT 1 SENT");
  assert.deepEqual(await outcome, { status: "sent-unconfirmed", attemptId: 1 });
  await h.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.fake.line("SUP_BYE");
  await h.fake.exit(0);
  assert.deepEqual(await settled, { status: "settled", witness: { supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 } });
});

test("transport: a pending reply fragment completes inside the stop; SETTLED before the reply poisons", async () => {
  const h = attach();
  await bound(h);
  const outcome = outcomeOf(commit(h).result);
  await settleIo();
  await h.fake.raw("SUP_SENT 1 SE");
  const settled = h.transport.settle();
  await settleIo();
  assert.ok(!h.fake.commands.endsWith("SETTLE\n"), "no SETTLE while the reply is mid-record");
  await h.fake.raw("NT\n");
  assert.deepEqual(await outcome, { status: "sent-unconfirmed", attemptId: 1 });
  await settleIo();
  assert.ok(h.fake.commands.endsWith("SETTLE\n"));
  await h.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.fake.line("SUP_BYE");
  await h.fake.exit(0);
  assert.equal((await settled).status, "settled");

  const p = attach();
  await bound(p);
  const lost = outcomeOf(commit(p).result);
  await settleIo();
  const stop = p.transport.settle();
  await settleIo();
  await p.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  assert.deepEqual(await lost, { status: "unknown", attemptId: 1, code: "transport-failed" });
  assert.deepEqual(await stop, { status: "failed", code: "control-reply", poisoned: true });
});

test("transport: EOF, process exit, and dispose with a pending send are unknown and clear authority", async () => {
  for (const end of ["eof", "exit", "dispose"] as const) {
    const h = attach();
    await bound(h);
    const outcome = outcomeOf(commit(h).result);
    await settleIo();
    if (end === "eof") h.fake.stdout.end();
    if (end === "exit") void h.fake.exit(0);
    if (end === "dispose") h.transport.dispose();
    assert.deepEqual(await outcome, { status: "unknown", attemptId: 1, code: "transport-failed" }, end);
    assert.equal(h.transport.diagnostics().hookControlBound, false);
    assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "refused", code: "custody-not-current" });
    assert.deepEqual(await h.transport.drain({ timeoutMs: 500 }), { status: "closed" });
  }
});

test("transport: the largest body is exact and bounded; reply lines have no lifetime count cutoff", async () => {
  const h = attach();
  await bound(h);
  const max = "a".repeat(NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES);
  const outcome = outcomeOf(commit(h, max).result);
  await settleIo();
  assert.ok(h.fake.commands.endsWith(`SEND 1 1 ${NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_BODY_CHARS}\n${Buffer.from(max).toString("base64")}\n`));
  await h.fake.line("SUP_SENT 1 SENT");
  assert.equal((await outcome).status, "sent-unconfirmed");
  // Far more reply bytes than the lifetime grammar bound, all exact replies.
  for (let attempt = 2; attempt <= 120; attempt += 1) {
    const next = outcomeOf(commit(h, `cb ${attempt}`).result);
    await settleIo();
    await h.fake.line(`SUP_SENT ${attempt} SENT`);
    assert.equal((await next).status, "sent-unconfirmed");
  }
  assert.equal(h.transport.diagnostics().poisonCode, null);
  assert.ok(h.transport.diagnostics().stdoutBytes > 1024);
  await settleClean(h);
});

/* --------------------------------------------- review-pass regressions */

test("renderer: a completed owner EOF or read fault is checked without waiting at control entry and after the SEND body", () => {
  const src = controlLaunch().source;
  const owner = fn(src, "SupWcxRequireOwner");
  assert.equal(owner, [
    "function SupWcxRequireOwner{",
    "if(-not $InTask.IsCompleted){return}",
    "$xread=0;try{$xread=[int]$InTask.Result}catch{$xread=0}",
    "if($xread -ne 1){SupFail 'stdin-closed' 10}}",
  ].join("\n"));
  // Non-blocking and non-consuming: no Wait, no re-arm, no buffer read, so a queued SETTLE stays queued.
  assert.doesNotMatch(owner, /Wait\(|SupStdinArm|InBuf|ReadAsync|ReadBlockAsync/u);
  assert.equal(occurrences(src, "SupWcxRequireOwner\n"), 2, "called at control entry and after the SEND body only");
  assertOrdered(fn(src, "SupWcxCommand"), ["SupFail 'control-phase' 46}", "SupWcxRequireOwner", "'^BIND "], "entry guard");
  assertOrdered(fn(src, "SupWcxSend"), ["$xtext=SupWcxBody $xn", "SupFail 'control-body' 49}", "SupWcxRequireOwner", "SupOut ('SUP_SENT '+[string]$xatt+' STALE')", "SupInboxSend $K"], "post-body guard before the writer");
  // The body reader re-arms the one-character read before returning, so the post-body guard observes it.
  assertOrdered(fn(src, "SupWcxBody"), ["$xtext=[Text.UTF8Encoding]::new($false,$true).GetString($xbytes)", "SupStdinArm", "return $xtext"], "re-arm");
  assert.equal(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES["stdin-closed"], 10);
  assert.ok(src.includes("$WcxLastBind=[long]0;$WcxLastDrop=[long]0"));
});

test("transport: BIND and DROP each spend a sequence once, even when their caller stopped waiting", async () => {
  const h = attach();
  await toChild(h);
  await h.fake.line(`SUP_CAND 1 ${UUID_A}`);
  const aborter = new AbortController();
  const bind = h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, { isBindingCurrent: () => true, signal: aborter.signal });
  await settleIo();
  aborter.abort();
  assert.deepEqual(await bind, { status: "unknown", code: "cancelled" });
  await h.fake.line("SUP_BIND 1 OK");
  assert.equal(h.transport.diagnostics().hookControlDrained, 1);
  const base = h.fake.commands;
  // A second BIND for the spent sequence is refused without writing.
  assert.deepEqual(await h.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes), { status: "refused", code: "binding-not-current" });
  assert.equal(h.fake.commands, base);
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" });
  // A duplicate or delayed OK can never establish authority: it is unsolicited.
  await h.fake.line("SUP_BIND 1 OK");
  assert.equal(h.transport.diagnostics().poisonCode, "frame-unsolicited");
  assert.equal(h.transport.diagnostics().hookControlBound, false);

  const d = attach();
  await bound(d);
  const dropped = d.transport.dropHookCandidate(RUN, 1);
  await settleIo();
  await d.fake.line("SUP_DROP 1");
  assert.deepEqual(await dropped, { status: "dropped", sequence: 1 });
  const after = d.fake.commands;
  // A repeated DROP still revokes locally (nothing left to revoke) and writes nothing.
  assert.deepEqual(await d.transport.dropHookCandidate(RUN, 1), { status: "refused", code: "binding-not-current" });
  assert.equal(d.fake.commands, after);
  assert.equal(occurrences(d.fake.commands, "DROP 1\n"), 1);
  // A later, higher sequence is still droppable once.
  await d.fake.line(`SUP_CAND 2 ${UUID_B}`);
  const second = d.transport.dropHookCandidate(RUN, 2);
  await settleIo();
  await d.fake.line("SUP_DROP 2");
  assert.deepEqual(await second, { status: "dropped", sequence: 2 });
  assert.deepEqual(d.transport.observeHookCandidate(RUN), { status: "none" });
  await settleClean(d);
});

test("transport: a repeated DROP of a still-bound lower sequence revokes locally before refusing the wire", async () => {
  const h = attach();
  await bound(h);
  // DROP 1 cannot be written while another command is unanswered, but it revokes at once.
  const outcome = outcomeOf(commit(h).result);
  assert.deepEqual(await h.transport.dropHookCandidate(RUN, 1), { status: "refused", code: "control-busy" });
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" });
  await settleIo();
  await h.fake.line("SUP_SENT 1 SENT");
  assert.equal((await outcome).status, "sent-unconfirmed");
  // It was never written, so the sequence is not spent: the retry writes it once.
  const retry = h.transport.dropHookCandidate(RUN, 1);
  await settleIo();
  await h.fake.line("SUP_DROP 1");
  assert.deepEqual(await retry, { status: "dropped", sequence: 1 });
  assert.equal(occurrences(h.fake.commands, "DROP 1\n"), 1);
  await settleClean(h);
});

test("transport: a run invalidated inside either fence call produces no payload (first) and no SEND byte (both)", async () => {
  const h = attach();
  await bound(h);
  const base = h.fake.commands;
  // First fence call (before the payload): the run goes stale while the fence still says true.
  let reads = 0;
  const first = commit(h, TEXT, fence(UUID_A, 1, { isBindingCurrent: () => { reads += 1; h.current = false; return true; } }));
  assert.deepEqual(first.result, { status: "not-sent", code: "run-not-current" });
  assert.deepEqual([first.calls, reads], [0, 1], "the stale attempt never produces its payload");
  h.current = true;
  // Second fence call (after the payload, right before the write).
  reads = 0;
  const second = commit(h, TEXT, fence(UUID_A, 1, { isBindingCurrent: () => { reads += 1; if (reads === 2) h.current = false; return true; } }));
  assert.deepEqual(second.result, { status: "not-sent", code: "run-not-current" });
  assert.deepEqual([second.calls, reads], [1, 2]);
  h.current = true;
  await settleIo();
  assert.equal(h.fake.commands, base, "no SEND byte was written for a stale run");
  assert.equal(occurrences(h.fake.commands, "SEND "), 0);
  await settleClean(h);
});

test("transport: an exact reply followed by a fault in the same chunk is never credited", async () => {
  // SEND: exact success, then an unsolicited duplicate in one receipt.
  const s = attach();
  await bound(s);
  const outcome = outcomeOf(commit(s).result);
  await settleIo();
  await s.fake.raw("SUP_SENT 1 SENT\nSUP_SENT 1 SENT\n");
  assert.deepEqual(await outcome, { status: "unknown", attemptId: 1, code: "transport-failed" });
  assert.equal(s.transport.diagnostics().poisonCode, "frame-unsolicited");
  // SEND: exact success, then an invalid residual fragment in one receipt.
  const r = attach();
  await bound(r);
  const residual = outcomeOf(commit(r).result);
  await settleIo();
  await r.fake.raw("SUP_SENT 1 SENT\nGARBAGE");
  assert.deepEqual(await residual, { status: "unknown", attemptId: 1, code: "transport-failed" });
  assert.equal(r.transport.diagnostics().poisonCode, "frame-unsolicited", "no record fragment is admissible after the reply");
  // BIND: never acknowledged when its chunk fails.
  const b = attach();
  await toChild(b);
  await b.fake.line(`SUP_CAND 1 ${UUID_A}`);
  const bind = b.transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes);
  await settleIo();
  await b.fake.raw("SUP_BIND 1 OK\nSUP_BIND 1 OK\n");
  assert.deepEqual(await bind, { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.equal(b.transport.diagnostics().hookControlBound, false);
  // DROP: never acknowledged when its chunk fails.
  const d = attach();
  await bound(d);
  const drop = d.transport.dropHookCandidate(RUN, 1);
  await settleIo();
  await d.fake.raw("SUP_DROP 1\nSUP_DROP 1\n");
  assert.deepEqual(await drop, { status: "failed", code: "frame-unsolicited", poisoned: true });
});

test("transport: a reply processed after its monotonic expiry is a deadline miss even before the timer fires", async () => {
  const h = attach({ controlDeadlines: { controlMs: 500, sendMs: 20 } });
  await bound(h);
  const outcome = outcomeOf(commit(h).result);
  // Block the event loop past the expiry, then deliver the exact reply before
  // any timer callback can run (stream delivery runs ahead of the timers phase).
  const until = performance.now() + 40;
  while (performance.now() < until) { /* spin */ }
  h.fake.stdout.write("SUP_SENT 1 SENT\n");
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => process.nextTick(resolve));
  assert.equal(h.transport.diagnostics().poisonCode, "timeout", "decided by the stored expiry, not the timer");
  assert.equal(h.transport.diagnostics().hookControlReplies, 1, "the reply was not credited");
  assert.deepEqual(await outcome, { status: "unknown", attemptId: 1, code: "timeout" });
});

test("transport: a DROP naming another run or generation leaves this run's binding and candidate unchanged", async () => {
  const h = attach();
  await bound(h);
  const base = h.fake.commands;
  for (const context of [{ ...RUN, generation: RUN.generation + 1 }, { ...RUN, runId: "run-682-other" }, { runId: "", generation: 1 }]) {
    assert.deepEqual(await h.transport.dropHookCandidate(context, 1), { status: "refused", code: "run-not-current" });
  }
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "bound", binding: { sequence: 1, sessionId: UUID_A } });
  assert.deepEqual(h.transport.observeHookCandidate(RUN), { status: "candidate", candidate: { sequence: 1, sessionId: UUID_A } });
  assert.equal(h.fake.commands, base);
  // The exact run still revokes immediately even when its DROP cannot be written.
  h.current = false;
  assert.deepEqual(await h.transport.dropHookCandidate(RUN, 1), { status: "refused", code: "run-not-current" });
  h.current = true;
  assert.deepEqual(h.transport.observeHookBinding(RUN), { status: "none" });
  assert.equal(h.fake.commands, base);
  await settleClean(h);
});

test("transport: the paired control-mode stop default covers hook + SEND + supervisor settlement; other modes unchanged", async (t) => {
  const supervisorSettleMs = Number(/\$SettleMs=([0-9]+)\n/u.exec(controlLaunch().source)![1]);
  assert.equal(supervisorSettleMs, 10_000, "the renderer's default supervisor settle budget");
  const worst = WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS + WINDOWS_CLAUDE_CUSTODY_CONTROL_LIMITS.maxBlockingMs + supervisorSettleMs;
  assert.ok(NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS >= worst + 2_000, "margin for records, exit, and close");
  assert.ok(NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS <= 120_000);
  assert.equal(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES.settleMs, 15_000, "the default/candidate-only stop default is unchanged");

  const effectiveStop = async (overrides: Partial<NativeWindowsClaudeCustodyTransportOptions>, tickMs: number): Promise<string | null> => {
    const h = attach({ deadlines: { readyMs: 500, peerMs: 500, childMs: 500 }, ...overrides });
    await toChild(h);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const settled = h.transport.settle();
      await settleIo();
      t.mock.timers.tick(tickMs);
      await settleIo();
      const code = h.transport.diagnostics().poisonCode;
      if (code === null) {
        await h.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
        await h.fake.line("SUP_BYE");
        await h.fake.exit(0);
        assert.equal((await settled).status, "settled");
      } else {
        assert.equal((await settled).status, "failed");
      }
      return code;
    } finally {
      t.mock.timers.reset();
    }
  };
  // Control mode, no settleMs: still waiting at the candidate-only default and just before its own.
  assert.equal(await effectiveStop({}, DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES.settleMs), null);
  assert.equal(await effectiveStop({}, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS - 1), null);
  assert.equal(await effectiveStop({}, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS), "timeout");
  // Candidate-only mode keeps its unchanged default.
  assert.equal(await effectiveStop({ hookControl: undefined, controlDeadlines: undefined }, DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES.settleMs), "timeout");
  // An explicit settleMs is the caller's coordinated budget, used as given.
  assert.equal(await effectiveStop({ deadlines: { readyMs: 500, peerMs: 500, childMs: 500, settleMs: 1_000 } }, 1_000), "timeout");
});

/* -------------------------------------------- real child (genuine pipes) */

/**
 * A JS stand-in that speaks the rendered control grammar strictly: exact
 * command lines, `SEND` body read by exact length + LF, canonical base64 and
 * fatal UTF-8. It answers with the closed records only and exits nonzero on
 * any violation (mirroring the supervisor's fail-closed route).
 */
const REAL_SUPERVISOR = String.raw`
"use strict";
const UUID = "${UUID_A}";
let buf = Buffer.alloc(0);
let stage = "boot";
let want = 0;
let pending = null;
let bound = 0;
let last = 0;
const out = (s) => process.stdout.write(s);
const fail = (code) => process.exit(code);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (stage === "boot") {
      if (buf.length < 18) return;
      const m = /^PRG-WCS1 ([0-9]{8})\n$/.exec(buf.subarray(0, 18).toString("ascii"));
      if (!m) fail(3);
      const len = Number(m[1]);
      if (buf.length < 18 + len) return;
      buf = buf.subarray(18 + len);
      stage = "key";
      continue;
    }
    if (stage === "body") {
      if (buf.length < want + 1) return;
      const body = buf.subarray(0, want).toString("latin1");
      if (buf[want] !== 10) fail(49);
      buf = buf.subarray(want + 1);
      stage = "cmd";
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) fail(49);
      const bytes = Buffer.from(body, "base64");
      if (bytes.toString("base64") !== body || bytes.length < 1 || bytes.length > 65536) fail(49);
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(49); }
      out("SUP_SENT " + pending.attempt + " " + (pending.seq === bound && text.length > 0 ? "SENT" : "STALE") + "\n");
      continue;
    }
    const nl = buf.indexOf(10);
    if (nl < 0) { if (stage === "cmd" && buf.length > 48) fail(11); return; }
    const line = buf.subarray(0, nl).toString("latin1");
    buf = buf.subarray(nl + 1);
    if (stage === "key") {
      if (!/^PRG-WCK1 [0-9a-f]{64} [A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(line)) fail(42);
      stage = "cmd";
      out("SUP_READY " + process.pid + "\nSUP_WRAPPER 424242 PROVISIONAL\n");
      continue;
    }
    let m;
    if (line === "CONFIRM 424242") out("SUP_GO 424242\nSUP_CHILD 434343\nSUP_CAND 1 " + UUID + "\n");
    else if ((m = /^BIND ([1-9][0-9]{0,15})$/.exec(line))) { if (Number(m[1]) !== 1) fail(47); bound = 1; out("SUP_BIND 1 OK\n"); }
    else if ((m = /^SEND ([1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([1-9][0-9]{0,4})$/.exec(line))) {
      const attempt = Number(m[1]);
      if (attempt <= last || Number(m[3]) % 4 !== 0 || Number(m[3]) > 87384) fail(47);
      last = attempt;
      pending = { attempt, seq: Number(m[2]) };
      want = Number(m[3]);
      stage = "body";
    }
    else if (line === "SETTLE") out("SUP_SETTLED ACTIVE=0 LISTED=0\nSUP_BYE\n");
    else fail(11);
  }
});
process.stdin.on("end", () => process.exit(stage === "cmd" && buf.length === 0 ? 0 : 10));
`;

function spawnReal(t: TestContext): ChildProcess {
  const child = spawn(process.execPath, ["-e", REAL_SUPERVISOR], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("close", resolve));
  });
  return child;
}

test("real child: bind, a maximal multi-chunk SEND, and witnessed settlement over genuine pipes", async (t) => {
  const child = spawnReal(t);
  const attached = attachNativeWindowsClaudeCustodyTransport({
    child,
    run: RUN,
    isRunCurrent: () => true,
    deadlines: { readyMs: 20_000, peerMs: 20_000, childMs: 20_000, settleMs: 20_000 },
    hookCandidates: true,
    hookControl: true,
    controlDeadlines: { controlMs: 20_000, sendMs: 20_000 },
  });
  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;
  const transport = attached.transport;
  assert.deepEqual(await transport.start(SOURCE, { hookKey: KEY }), { status: "ready-for-pty-spawn", supervisorPid: child.pid });
  assert.equal((await transport.confirmPeer(() => 424242)).status, "peer-confirmed");
  assert.equal((await transport.awaitChild()).status, "child-established");
  // Candidate 1 arrives right after SUP_CHILD; wait for it to be credited.
  for (let i = 0; i < 200 && transport.observeHookCandidate(RUN).status !== "candidate"; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(transport.observeHookCandidate(RUN), { status: "candidate", candidate: { sequence: 1, sessionId: UUID_A } });
  assert.deepEqual(await transport.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, yes), { status: "bound", binding: { sequence: 1, sessionId: UUID_A } });
  const big = "\u00e9\u{1F680}".repeat(10_000) + "z".repeat(5_536);
  assert.equal(Buffer.byteLength(big), 65_536);
  const prepared = transport.prepareSend(RUN);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  const result = prepared.attempt.commit(() => big, fence());
  assert.deepEqual(await outcomeOf(result), { status: "sent-unconfirmed", attemptId: prepared.attempt.attemptId });
  assert.deepEqual(await transport.settle(), { status: "settled", witness: { supervisorPid: child.pid, jobActive: 0, jobListed: 0, exitCode: 0 } });
  assert.equal(child.exitCode, 0);
});
