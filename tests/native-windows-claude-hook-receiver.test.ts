/**
 * Native Windows Claude hook receive side (#682), portable tests.
 *
 * The module is inactive and pure. These tests pin the fixed PowerShell 5.1
 * receive function's grammar: input validation without coercion, the retained
 * kernel client handle and child/job guards before anything is accepted, the
 * exact HELLO1/PROOF framing and HMAC key interpretation (reciprocally against
 * the landed forwarding client over an in-memory fake socket), proof-before-
 * record ordering, bounded and cancelable I/O with no retry, the one canonical
 * candidate grammar, closed result codes, single release and buffer clearing,
 * the absence of any output or secret channel, the inactive export surface,
 * and the documented host contract. Keys, run ids, tokens, and sessions are
 * synthetic. Nothing is spawned, no PowerShell runs, and nothing touches the
 * filesystem except reading this repository's own sources. This is NOT
 * Windows evidence: an inert reciprocal handshake on Windows remains a later
 * runtime test.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import * as receiverModule from "../src/session-host/native-windows-claude-hook-receiver";
import {
  WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS,
  WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN,
  WINDOWS_CLAUDE_HOOK_RECEIVE_CLIENT_ACCESS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION,
  WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_HELPER_FUNCTIONS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT,
  WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_PROOF_CONTEXT,
  WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE,
  WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32,
  classifyWindowsClaudeHookReceiveResult,
  type WindowsClaudeHookReceiveRefusal,
  type WindowsClaudeHookReceiveResult,
} from "../src/session-host/native-windows-claude-hook-receiver";
import {
  WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS,
  WINDOWS_CLAUDE_HOOK_PIPE_PREFIX,
  WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT,
  WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES,
  forwardWindowsClaudeHookRecordOnce,
  type WindowsClaudeHookForwardResult,
  type WindowsClaudeHookSocket,
} from "../src/session-host/native-windows-claude-hook-forwarder";
import {
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX,
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE,
  parseWindowsClaudeInboxLocalEndpoint,
} from "../src/session-host/native-windows-claude-inbox-peer";
import {
  WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE,
} from "../src/session-host/native-windows-claude-custody-scripts";

const PROJECT_ROOT = join(__dirname, "..", "..");
const MODULE_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-hook-receiver.ts");
/** The custody renderer composes (never redefines) the fixed source, only in its opt-in hook mode. */
const OPT_IN_COMPOSER_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-custody-scripts.ts");
const SOURCE = WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE;
const LIMITS = WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS;

/* Synthetic, inert values only. */
const KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const RUN_ID = "run-7.synthetic:a_b";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const ENDPOINT = `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}claude-synthetic_1.a`;
/** Exercises the PoC token alphabet beyond base64url: `+ / = . ~`. */
const TOKEN = "Syn+th/et=ic_.~-Token0";
const HOOK_PIPE = `${WINDOWS_CLAUDE_HOOK_PIPE_PREFIX}00112233445566778899aabbccddeeff`;

/**
 * An independent, hand-written synthetic record in the PoC wire format
 * (`SupHookClient`): field order v, runId, event, sessionId, socket, token;
 * each endpoint backslash is the JSON escape `\\\\`; the token uses the PoC
 * alphabet `[A-Za-z0-9+/=_.~-]`. It is NOT produced by the test's own helper.
 */
const POC_LITERAL = String.raw`{"v":1,"runId":"run-7.synthetic:a_b","event":"SessionStart","sessionId":"01234567-89ab-cdef-0123-456789abcdef","socket":"\\\\.\\pipe\\LOCAL\\claude-synthetic_1.a","token":"AZaz09+/=_.~-AZaz09+/=_.~-"}`;
/** The receiver's earlier, incompatible format (event before runId, `endpoint` name). */
const OLD_RECEIVER_LITERAL = String.raw`{"v":1,"event":"SessionStart","runId":"run-7.synthetic:a_b","sessionId":"01234567-89ab-cdef-0123-456789abcdef","endpoint":"\\\\.\\pipe\\LOCAL\\claude-synthetic_1.a","token":"AZaz09_-AZaz09_-"}`;

/* --------------------------------------------------------------- helpers */

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

function indexOnce(needle: string, haystack = SOURCE): number {
  assert.equal(count(haystack, needle), 1, `exactly one occurrence of ${needle}`);
  return haystack.indexOf(needle);
}

function assertOrdered(haystack: string, ...needles: string[]): void {
  const at = needles.map((needle) => indexOnce(needle, haystack));
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i - 1]! < at[i]!, `${needles[i - 1]} before ${needles[i]}`);
}

function functionBody(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = SOURCE.indexOf("\nfunction ", start + 1);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next + 1);
}

/** Extract one fixed `[byte[]](...)` literal from the source. */
function byteLiteral(variable: string): number[] {
  const m = new RegExp(`\\$${variable}=\\[byte\\[\\]\\]\\(([0-9,]+)\\)`, "u").exec(SOURCE);
  assert.ok(m, variable);
  return m[1]!.split(",").map(Number);
}

/** Portable emulation of the .NET `\z` (true end of input) for the shared ASCII subset. */
function emulate(pattern: string): RegExp {
  assert.ok(pattern.endsWith("\\z"));
  return new RegExp(pattern.replace(/\\z$/u, "(?![\\s\\S])"));
}

function candidate(overrides: Partial<Record<(typeof WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS)[number], unknown>> = {}): string {
  return JSON.stringify({
    v: 1,
    runId: RUN_ID,
    event: "SessionStart",
    sessionId: SESSION_ID,
    socket: ENDPOINT,
    token: TOKEN,
    ...overrides,
  });
}

/**
 * JavaScript mirror of the fixed function's proof computation, built from the
 * byte literals and expressions pinned in the source below.
 */
function mirrorProof(nonce: string, key: string | Buffer = Buffer.from(KEY, "ascii"), runId = RUN_ID): Buffer {
  const digits = byteLiteral("hDigits");
  const lead = byteLiteral("hProofLead");
  const sum = createHmac("sha256", key).update(Buffer.from(`${WINDOWS_CLAUDE_HOOK_RECEIVE_PROOF_CONTEXT}|${runId}|${nonce}`, "ascii")).digest();
  const proof = Buffer.alloc(LIMITS.proofBytes);
  for (let i = 0; i < lead.length; i += 1) proof[i] = lead[i]!;
  for (let i = 0; i < 32; i += 1) {
    proof[6 + 2 * i] = digits[sum[i]! >> 4]!;
    proof[7 + 2 * i] = digits[sum[i]! & 15]!;
  }
  proof[70] = 10;
  return proof;
}

/** JavaScript mirror of the fixed function's HELLO1 byte checks. */
function mirrorHelloNonce(frame: Buffer): string | undefined {
  const lead = byteLiteral("hHelloLead");
  if (frame.length !== LIMITS.helloBytes) return undefined;
  for (let i = 0; i < 7; i += 1) if (frame[i] !== lead[i]) return undefined;
  for (let i = 7; i < 39; i += 1) {
    const b = frame[i]!;
    if (!((b >= 48 && b <= 57) || (b >= 97 && b <= 102))) return undefined;
  }
  if (frame[39] !== 10) return undefined;
  return frame.toString("ascii", 7, 39);
}

/** JavaScript mirror of the fixed function's record byte scan (single chunk). */
function mirrorRecordFrame(record: Buffer): "ok" | "eof" | "trailing" | "byte" | "oversize" {
  if (record.length > LIMITS.recordMaxBytes) return "oversize";
  for (let i = 0; i < record.length; i += 1) {
    const b = record[i]!;
    if (b === 10) return i === record.length - 1 ? "ok" : "trailing";
    if (b < 32 || b > 126) return "byte";
  }
  return record.length >= LIMITS.recordMaxBytes ? "oversize" : "eof";
}

/* ------------------------------------------------------------ type checks */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const resultUnionIsCandidatePlusRefusals: Equal<WindowsClaudeHookReceiveResult, "candidate" | WindowsClaudeHookReceiveRefusal> = true;
// @ts-expect-error "ok" is not a receive result: success is only the explicit candidate code
const okIsNotAResult: WindowsClaudeHookReceiveResult = "ok";

test("type contract and constants: closed results, shared bounds, and documented Win32 values", () => {
  assert.equal(resultUnionIsCandidatePlusRefusals, true);
  assert.equal(typeof okIsNotAResult, "string");
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_PROOF_CONTEXT, WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT);
  assert.equal(LIMITS.recordMaxBytes, WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES);
  assert.equal(LIMITS.budgetMaxMs, WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS);
  assert.equal(LIMITS.helloBytes, "HELLO1 ".length + 32 + 1);
  assert.equal(LIMITS.proofBytes, "PROOF ".length + 64 + 1);
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32));
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.SYNCHRONIZE, 0x00100000);
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.PROCESS_QUERY_LIMITED_INFORMATION, 0x1000);
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.WAIT_TIMEOUT, 258);
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.ERROR_BROKEN_PIPE, 109);
  assert.ok(SOURCE.includes(`$hPeekErr -ne ${WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.ERROR_BROKEN_PIPE}`));
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_CLIENT_ACCESS, 0x00101000);
  // Every limit is a literal in the fixed source.
  for (const literal of [
    `(${LIMITS.helloBytes}-$hGot)`,
    `[byte[]]::new(${LIMITS.helloBytes})`,
    `[byte[]]::new(${LIMITS.proofBytes})`,
    `$true $hProof 0 ${LIMITS.proofBytes} `,
    `[byte[]]::new(${LIMITS.recordMaxBytes})`,
    `(${LIMITS.recordMaxBytes}-$hGot)`,
    `if($hGot -ge ${LIMITS.recordMaxBytes}){return 'hook-record-oversize'}`,
    `$hBudgetMs -gt ${LIMITS.budgetMaxMs}`,
    `$hLeft=${LIMITS.cancelGraceMs}-$hGrace.ElapsedMilliseconds`,
    `[Math]::Min(${LIMITS.waitSliceMs},$hLeft)`,
    `{${LIMITS.tokenMinChars},${LIMITS.tokenMaxChars}}`,
  ]) {
    assert.ok(SOURCE.includes(literal), literal);
  }
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT.maxBlockingMs, LIMITS.budgetMaxMs + LIMITS.cancelGraceMs);
});

/* ------------------------------------------------- fixed source grammar */

const SERVE_HEADER =
  "function SupHookServe([Type]$hk,[IntPtr]$hChild,[int]$hChildPid,[IntPtr]$hJob,[int]$hWrapperPid,[object]$hConn,[object]$hRunId,[object]$hKey,[object]$hBudgetMs,[object]$hCancel,[ref]$hOut){";
const FUNCTION_ORDER = [...WINDOWS_CLAUDE_HOOK_RECEIVE_HELPER_FUNCTIONS, WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION];

test("source grammar: a fixed, placeholder-free PS5.1 source defining exactly five functions and nothing else", () => {
  assert.equal(WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION, "SupHookServe");
  assert.deepEqual([...WINDOWS_CLAUDE_HOOK_RECEIVE_HELPER_FUNCTIONS], ["SupHookHeld", "SupHookGuard", "SupHookXfer", "SupHookXferCode"]);
  assert.match(SOURCE, /^[\x20-\x7e\n]+$/u, "printable ASCII and LF only");
  assert.doesNotMatch(SOURCE, /__[A-Z0-9_]+__/u, "no render placeholders");
  assert.doesNotMatch(SOURCE, /`|\$\{|@'|@"/u, "no backticks, ${...}, or here-strings");
  assert.equal(count(SOURCE, "function "), 5);
  const headers = [...SOURCE.matchAll(/^function ([A-Za-z]+)\(/gmu)].map((m) => m[1]);
  assert.deepEqual(headers, FUNCTION_ORDER);
  assert.ok(SOURCE.startsWith("function SupHookHeld("));
  indexOnce(SERVE_HEADER);
  // Braces and parentheses balance outside single-quoted strings, and depth returns to zero only
  // at the five function ends: nothing runs at top level when the source is dot-sourced.
  let depth = 0;
  let paren = 0;
  let inQuote = false;
  const closes: number[] = [];
  for (let i = 0; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === "'") inQuote = !inQuote;
    if (inQuote || ch === "'") continue;
    if (ch === "(") paren += 1;
    if (ch === ")") paren -= 1;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) closes.push(i);
    }
    assert.ok(depth >= 0 && paren >= 0, `balanced at ${i}`);
  }
  assert.equal(inQuote, false);
  assert.equal(depth, 0);
  assert.equal(paren, 0);
  assert.equal(closes.length, 5);
  assert.equal(closes[4], SOURCE.length - 1);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(SOURCE.slice(closes[i]! + 1).startsWith(`\nfunction ${FUNCTION_ORDER[i + 1]}(`), `function ${i + 1} ends before the next`);
  }
});

test("source grammar: variables use the reserved h-prefix and never collide with supervisor or automatic variables", () => {
  const constants = new Set(["true", "false", "null"]);
  const names = new Set([...SOURCE.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/gu)].map((m) => m[1]!.toLowerCase()));
  assert.deepEqual([...names].filter((n) => constants.has(n)).sort(), ["false", "null", "true"]);
  const supervisorVars = new Set(
    [...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.matchAll(/\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)/gu)].map((m) =>
      m[1]!.toLowerCase(),
    ),
  );
  const automatic = new Set(["pid", "input", "args", "matches", "error", "host", "this", "_", "home", "psitem", "env", "lastexitcode"]);
  for (const name of names) {
    if (constants.has(name)) continue;
    assert.match(name, /^h[a-z0-9]+$/u, `${name} uses the reserved h-prefix`);
    assert.ok(!supervisorVars.has(name), `${name} is distinct from the supervisor's variables`);
    assert.ok(!automatic.has(name), `${name} is not an automatic variable`);
  }
  assert.doesNotMatch(SOURCE, /\$script:|\$global:|Set-Variable|New-Variable/iu, "no non-local state");
  for (const fn of FUNCTION_ORDER) {
    assert.ok(!WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.toLowerCase().includes(fn.toLowerCase()), `${fn} is not wired`);
    assert.ok(!WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.includes(`function ${fn}(`), `${fn} does not shadow the peer helpers`);
  }
});

/* ------------------------------------------- input and custody guards */

test("inputs: validated by type and exact grammar without coercion, and a cancelable token is required", () => {
  const serve = functionBody("SupHookServe");
  assertOrdered(
    serve,
    "try{$hOut.Value=$null}catch{return 'hook-unexpected'}",
    "if($hCancel -isnot [Threading.CancellationToken]){return 'hook-input'}",
    "if(-not $hCancel.CanBeCanceled){return 'hook-input'}",
    "if($hBudgetMs -isnot [int]){return 'hook-input'}",
    "if($hBudgetMs -lt 1 -or $hBudgetMs -gt 5000){return 'hook-input'}",
    "if($hRunId -isnot [string]){return 'hook-input'}",
    "if($hRunId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z'){return 'hook-input'}",
    "if($hKey -isnot [string]){return 'hook-input'}",
    "if($hKey -cnotmatch '^[0-9a-f]{64}\\z'){return 'hook-input'}",
    "if($hConn -isnot [IO.Pipes.NamedPipeServerStream]){return 'hook-conn'}",
    "$hClock=[Diagnostics.Stopwatch]::StartNew();$hUntil=[long]$hBudgetMs",
    "if(-not ($hConn.IsConnected -and $hConn.IsAsync)){return 'hook-conn'}",
    "$hRaw=$hConn.SafePipeHandle.DangerousGetHandle()",
    "if([long]$hRaw -eq 0 -or [long]$hRaw -eq -1){return 'hook-conn'}",
  );
  // Untyped [object] parameters keep the caller's value: no implicit PowerShell conversion.
  for (const p of ["$hConn", "$hRunId", "$hKey", "$hBudgetMs", "$hCancel"]) assert.ok(SERVE_HEADER.includes(`[object]${p}`), p);
  // The run-id and key grammars are the forwarder's, anchored at the true end of input.
  const runId = emulate("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z");
  const key = emulate("^[0-9a-f]{64}\\z");
  for (const ok of [RUN_ID, "a", `a${"b".repeat(127)}`]) assert.ok(runId.test(ok), ok);
  for (const bad of ["", ".a", `a${"b".repeat(128)}`, "a\n", "a b", "a/b", "é"]) assert.ok(!runId.test(bad), JSON.stringify(bad));
  assert.ok(key.test(KEY));
  for (const bad of [KEY.toUpperCase(), `${KEY}\n`, KEY.slice(1), `${KEY}0`, `${KEY.slice(0, 63)}g`]) assert.ok(!key.test(bad), bad);
  // Matching uses case-sensitive operators only.
  assert.doesNotMatch(SOURCE, /\s-(?:i?not)?(?:match|like|eq|ne)\s'/u, "string comparisons are case-sensitive (-c*)");
  assert.doesNotMatch(SOURCE, /-imatch|-clike|-ilike|-like\b/u);
});

test("custody: retained child checked first, exact kernel client PID, retained query+wait handle, three guards", () => {
  const serve = functionBody("SupHookServe");
  assertOrdered(
    serve,
    "if([long]$hRaw -eq 0 -or [long]$hRaw -eq -1){return 'hook-conn'}",
    "$hHeld=SupHookHeld $hk $hChild $hChildPid $hJob\nif($hHeld -cne 'ok'){return ('hook-child-'+$hHeld)}",
    "if(-not ($hk::GetNamedPipeClientProcessId($hRaw,$hCp) -and $hCp[0] -gt 0)){return 'hook-client-sample'}",
    "$hClientPid=$hCp[0]",
    "if($hClientPid -eq $hChildPid -or $hClientPid -eq $hWrapperPid){return 'hook-client-role'}",
    "$hProc=$hk::OpenProcess(0x00101000,$false,$hClientPid)",
    "if([long]$hProc -eq 0 -or [long]$hProc -eq -1){return 'hook-client-open'}",
  );
  // One open with exactly query-limited + synchronize, non-inheritable, no other access right.
  assert.equal(count(SOURCE, "OpenProcess"), 1);
  assert.ok(SOURCE.includes(`OpenProcess(0x${WINDOWS_CLAUDE_HOOK_RECEIVE_CLIENT_ACCESS.toString(16).padStart(8, "0")},$false,`));
  assert.doesNotMatch(SOURCE, /0x1fffff|0x001f0fff|PROCESS_ALL|DuplicateHandle|TerminateProcess|TerminateJobObject/iu);
  // The guard re-samples the SAME connection's client PID, then the retained client, then the retained child.
  const guard = functionBody("SupHookGuard");
  assertOrdered(
    guard,
    "if(-not ($hk::GetNamedPipeClientProcessId($hRaw,$hSample) -and $hSample[0] -eq $hClientPid)){return 'hook-client-mismatch'}",
    "$hHeld=SupHookHeld $hk $hProc $hClientPid $hJob\nif($hHeld -cne 'ok'){return ('hook-client-'+$hHeld)}",
    "$hHeld=SupHookHeld $hk $hChild $hChildPid $hJob\nif($hHeld -cne 'ok'){return ('hook-child-'+$hHeld)}",
    "return 'ok'}",
  );
  // Each held check: real (non-NULL, non-pseudo) handle, positive PID, bound job, live, same PID, in the job.
  const held = functionBody("SupHookHeld");
  assertOrdered(
    held,
    "if($hProc -eq [IntPtr]::Zero -or [long]$hProc -eq -1){return 'handle'}",
    "if($hProcPid -le 0){return 'pid'}",
    "if($hJob -eq [IntPtr]::Zero -or [long]$hJob -eq -1){return 'job-handle'}",
    "if($hk::WaitForSingleObject($hProc,0) -ne 258){return 'not-live'}",
    "if($hk::GetProcessId($hProc) -ne $hProcPid){return 'pid'}",
    "if(-not ($hk::IsProcessInJob($hProc,$hJob,$hFlag) -and $hFlag[0] -ne 0)){return 'not-in-job'}",
    "return 'ok'}",
  );
  // Guards run exactly three times: before HELLO, immediately before the proof, and immediately before handoff.
  const GUARD = "$hG=SupHookGuard $hk $hRaw $hProc $hClientPid $hChild $hChildPid $hJob\nif($hG -cne 'ok'){return $hG}";
  assert.equal(count(serve, GUARD), 3);
  const guards: number[] = [];
  for (let at = serve.indexOf(GUARD); at !== -1; at = serve.indexOf(GUARD, at + 1)) guards.push(at);
  const firstHelloRead = serve.indexOf("$false $hHello");
  const proofWrite = indexOnce("$true $hProof 0 71", serve);
  const handoff = indexOnce("$hOut.Value=@{", serve);
  assert.ok(indexOnce("$hProc=$hk::OpenProcess(", serve) < guards[0]! && guards[0]! < firstHelloRead);
  assert.ok(indexOnce("$hProof[70]=10", serve) < guards[1]! && guards[1]! < proofWrite);
  assert.ok(indexOnce("if($hSeg -ceq '.'", serve) < guards[2]! && guards[2]! < handoff);
  // Nothing between the last guard and the handoff but the cancellation and deadline rechecks.
  assert.equal(
    serve.slice(guards[2]! + GUARD.length, handoff),
    "\nif($hCancel.IsCancellationRequested){return 'hook-cancelled'}\nif($hClock.ElapsedMilliseconds -ge $hUntil){return 'hook-timeout'}\n",
  );
  // No lineage or name-based identity source, and no numeric-PID-only authorization.
  assert.doesNotMatch(SOURCE, /Toolhelp|Process32|Get-CimInstance|Get-WmiObject|Win32_Process|ParentProcess|Get-Process|GetNamedPipeServerProcessId/iu);
});

/* --------------------------------------------- framing, order, and HMAC */

test("framing: HELLO1 reads are capped at the missing frame bytes, the proof precedes every record read, LF completes it", () => {
  const serve = functionBody("SupHookServe");
  // Reads and writes exist only inside the one bounded transfer helper.
  assert.equal(count(SOURCE, "ReadAsync("), 1);
  assert.equal(count(SOURCE, "WriteAsync("), 1);
  assert.ok(functionBody("SupHookXfer").includes("ReadAsync(") && functionBody("SupHookXfer").includes("WriteAsync("));
  // Exactly three transfers: HELLO reads, the one proof write, record reads. No EOF probe.
  const transfers = [...serve.matchAll(/\$hX=SupHookXfer \$hk \$hConn \$hRaw (\$true|\$false) (\$h[A-Za-z]+) ([^ ]+) (\([^)]*\)|[0-9]+) \$hClock \$hUntil \$hCancel \(\[ref\]\$hN\)\n/gu)];
  assert.deepEqual(
    transfers.map((m) => [m[1], m[2], m[3], m[4]]),
    [
      ["$false", "$hHello", "$hGot", "(40-$hGot)"],
      ["$true", "$hProof", "0", "71"],
      ["$false", "$hRec", "$hGot", "(16384-$hGot)"],
    ],
  );
  assert.equal(count(serve, "SupHookXfer "), 3);
  const at = transfers.map((m) => m.index!);
  assert.ok(at[0]! < at[1]! && at[1]! < at[2]!, "HELLO, then proof, then record");
  // The HELLO frame: 7 lead bytes, 32 lowercase hex, LF; nothing queued behind it.
  assert.deepEqual(byteLiteral("hHelloLead"), [...Buffer.from("HELLO1 ", "ascii")]);
  assertOrdered(
    serve,
    "while($hGot -lt 40){",
    "if($hN -eq 0){return 'hook-hello-eof'}",
    "for($hI=0;$hI -lt 7;$hI++){if($hHello[$hI] -ne $hHelloLead[$hI]){return 'hook-hello-malformed'}}",
    "for($hI=7;$hI -lt 39;$hI++){$hB=$hHello[$hI];if(-not (($hB -ge 48 -and $hB -le 57) -or ($hB -ge 97 -and $hB -le 102))){return 'hook-hello-malformed'}}",
    "if($hHello[39] -ne 10){return 'hook-hello-malformed'}",
    "if(-not ($hk::PeekNamedPipe($hRaw,[IntPtr]::Zero,0,[IntPtr]::Zero,$hAvail,[IntPtr]::Zero) -and $hAvail[0] -eq 0)){return 'hook-hello-trailing'}",
    "$hNonce=[Text.Encoding]::ASCII.GetString($hHello,7,32)",
  );
  // The record: printable ASCII to one LF that ends the data read so far, bounded. The LF alone
  // completes the frame: the loop ends on it and no read follows, so peer shutdown is never awaited.
  const PEEK =
    "$hAvail[0]=-1\n$hPeek=$hk::PeekNamedPipe($hRaw,[IntPtr]::Zero,0,[IntPtr]::Zero,$hAvail,[IntPtr]::Zero);$hPeekErr=[Runtime.InteropServices.Marshal]::GetLastWin32Error()\nif($hPeek){if($hAvail[0] -ne 0){return 'hook-record-trailing'}}elseif($hPeekErr -ne 109){return 'hook-record-io'}\n";
  assertOrdered(
    serve,
    "$hGot=0;$hLf=-1;$hRec=[byte[]]::new(16384)",
    "while($hLf -lt 0){\nif($hGot -ge 16384){return 'hook-record-oversize'}",
    "if($hN -eq 0){return 'hook-record-eof'}",
    "if($hB -eq 10){if($hI -ne ($hGot+$hN-1)){return 'hook-record-trailing'};$hLf=$hI}",
    "elseif($hB -lt 32 -or $hB -gt 126){return 'hook-record-byte'}}",
    PEEK,
    "$hText=[Text.Encoding]::ASCII.GetString($hRec,0,$hLf)",
  );
  // The trailing-byte observation boundary sits directly after the frame loop: bytes already read
  // after the LF, or still queued at that instant, are refused; a closed peer with nothing queued
  // (exactly ERROR_BROKEN_PIPE) is not a trailer. Nothing reads the connection after this point.
  const loopEnd = indexOnce("$hGot+=$hN}\n$hAvail[0]=-1\n", serve);
  assert.equal(serve.slice(loopEnd + "$hGot+=$hN}\n".length).startsWith(PEEK), true);
  assert.doesNotMatch(serve.slice(loopEnd), /SupHookXfer|ReadAsync|hTail/u);
  assert.doesNotMatch(SOURCE, /hTail|EOF|WaitForExit|HasExited/u);
  // No line reader, no unbounded or truncating read, no CR handling, no text decoding of raw input.
  assert.doesNotMatch(
    SOURCE,
    /ReadLine|ReadToEnd|ReadByte|ReadBlock|StreamReader|StreamWriter|BinaryReader|\.Read\(|\.Write\(|Flush|UTF8|Unicode|GetEncoding|Default\b|\\r|\b13\b/u,
  );
  assert.equal(count(SOURCE, "GetString("), 2, "only the validated nonce and the validated record become text");
});

test("framing: the mirrored byte rules accept exact frames and refuse CR, controls, truncation, oversize and trailers", () => {
  assert.equal(mirrorHelloNonce(Buffer.from(`HELLO1 ${"a".repeat(32)}\n`)), "a".repeat(32));
  for (const bad of [
    `HELLO1 ${"a".repeat(32)}\r\n`,
    `HELLO1 ${"a".repeat(31)}\n`,
    `HELLO1 ${"A".repeat(32)}\n`,
    `HELLO2 ${"a".repeat(32)}\n`,
    `hello1 ${"a".repeat(32)}\n`,
    `HELLO1  ${"a".repeat(31)}\n`,
    `HELLO1 ${"a".repeat(32)}\r`,
    `HELLO1 ${"a".repeat(32)}`,
  ]) {
    assert.equal(mirrorHelloNonce(Buffer.from(bad, "latin1")), undefined, JSON.stringify(bad));
  }
  const ok = Buffer.from(`${candidate()}\n`, "ascii");
  assert.equal(mirrorRecordFrame(ok), "ok");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\r\n`)), "byte");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\n\n`)), "trailing");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\nx`)), "trailing");
  assert.equal(mirrorRecordFrame(Buffer.from(candidate())), "eof");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\u0000\n`, "latin1")), "byte");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\u00e9\n`, "utf8")), "byte");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\t\n`)), "byte");
  assert.equal(mirrorRecordFrame(Buffer.from(`${candidate()}\u007f\n`)), "byte");
  assert.equal(mirrorRecordFrame(Buffer.alloc(LIMITS.recordMaxBytes, 0x61)), "oversize");
  const atBound = Buffer.alloc(LIMITS.recordMaxBytes, 0x61);
  atBound[LIMITS.recordMaxBytes - 1] = 10;
  assert.equal(mirrorRecordFrame(atBound), "ok", "the LF counts inside the shared bound");
  // The largest canonical candidate fits the shared bound with its LF.
  const largest = candidate({
    runId: `R${"r".repeat(127)}`,
    socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${"s".repeat(200)}`,
    token: "t".repeat(LIMITS.tokenMaxChars),
  });
  assert.ok(Buffer.byteLength(largest) + 1 <= LIMITS.recordMaxBytes);
});

test("HMAC: the key is used as ASCII text over prg682-hook-v1|<runId>|<nonce> and rendered as 64 lowercase hex", () => {
  const serve = functionBody("SupHookServe");
  assertOrdered(
    serve,
    "$hKeyBytes=[Text.Encoding]::ASCII.GetBytes([string]$hKey)",
    "$hMac=[Security.Cryptography.HMACSHA256]::new($hKeyBytes)",
    "$hSum=$hMac.ComputeHash([Text.Encoding]::ASCII.GetBytes('prg682-hook-v1|'+[string]$hRunId+'|'+$hNonce))",
    "if($hSum.Length -ne 32){return 'hook-unexpected'}",
    "for($hI=0;$hI -lt 6;$hI++){$hProof[$hI]=$hProofLead[$hI]}",
    "for($hI=0;$hI -lt 32;$hI++){$hProof[6+2*$hI]=$hDigits[$hSum[$hI] -shr 4];$hProof[7+2*$hI]=$hDigits[$hSum[$hI] -band 15]}",
    "$hProof[70]=10",
  );
  assert.ok(serve.includes(`'${WINDOWS_CLAUDE_HOOK_RECEIVE_PROOF_CONTEXT}|'`));
  assert.deepEqual(byteLiteral("hDigits"), [...Buffer.from("0123456789abcdef", "ascii")]);
  assert.deepEqual(byteLiteral("hProofLead"), [...Buffer.from("PROOF ", "ascii")]);
  // Never hex-decoded, never another digest, never string formatting of the digest.
  assert.doesNotMatch(SOURCE, /FromHex|ToByte\(|Convert\]|HexString|HMACSHA1|HMACSHA384|HMACSHA512|HMACMD5|SHA256\]::Create|ToString\(/u);
  // The mirror equals the forwarder dialect: Node HMAC with the key's ASCII bytes, lowercase hex.
  const nonce = "0123456789abcdef0123456789abcdef";
  const expected = `PROOF ${createHmac("sha256", Buffer.from(KEY, "ascii")).update(`prg682-hook-v1|${RUN_ID}|${nonce}`, "ascii").digest("hex")}\n`;
  assert.equal(mirrorProof(nonce).toString("ascii"), expected);
  assert.notEqual(mirrorProof(nonce, Buffer.from(KEY, "hex")).toString("ascii"), expected, "hex-decoding the key is a different dialect");
});

/* -------------------------------------- reciprocal check with the client */

class FakeSocket extends EventEmitter implements WindowsClaudeHookSocket {
  readonly writes: Buffer[] = [];
  ended = 0;
  destroyed = 0;

  write(data: string | Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data));
    queueMicrotask(() => callback(null));
    return true;
  }

  end(): this {
    this.ended += 1;
    return this;
  }

  destroy(): this {
    this.destroyed += 1;
    return this;
  }
}

async function exchange(
  respond: (hello: Buffer) => Buffer,
  record: () => Uint8Array,
): Promise<{ result: WindowsClaudeHookForwardResult; socket: FakeSocket; hello: Buffer; recordCalls: number }> {
  const socket = new FakeSocket();
  let recordCalls = 0;
  const promise = forwardWindowsClaudeHookRecordOnce(
    {
      pipe: HOOK_PIPE,
      runId: RUN_ID,
      key: KEY,
      isCurrent: () => true,
      record: () => {
        recordCalls += 1;
        return record();
      },
    },
    { connect: () => socket },
  );
  socket.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  const hello = socket.writes[0]!;
  // The supervisor side has written nothing and consumed no record before its proof.
  assert.equal(recordCalls, 0);
  socket.emit("data", respond(hello));
  const result = await promise;
  return { result, socket, hello, recordCalls };
}

test("reciprocal: the landed client's HELLO1 passes the receive rules and accepts the mirrored proof", async () => {
  const record = Buffer.from(`${candidate()}\n`, "ascii");
  const { result, socket, hello, recordCalls } = await exchange((frame) => {
    const nonce = mirrorHelloNonce(frame);
    assert.ok(nonce !== undefined, "the client HELLO1 matches the receive grammar byte for byte");
    return mirrorProof(nonce);
  }, () => record);
  assert.equal(hello.length, LIMITS.helloBytes);
  assert.deepEqual(result, { disposition: "handed-off", reason: "write-completed" });
  assert.equal(recordCalls, 1);
  // The record the client hands off satisfies the receive frame and candidate grammar.
  const written = socket.writes[1]!;
  assert.ok(written.equals(record));
  assert.equal(mirrorRecordFrame(written), "ok");
  const m = emulate(WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN).exec(written.toString("ascii", 0, written.length - 1));
  assert.ok(m);
  assert.equal(m[1], RUN_ID);
  assert.equal(`${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${m[3]}`, ENDPOINT);
  // The client ends and destroys its connection right after the local write and resolves without
  // waiting for the receiver; the receiver therefore completes the frame at LF, never at EOF.
  assert.ok(socket.ended >= 1 && socket.destroyed >= 1);
});

test("reciprocal: a foreign key, a hex-decoded key, another run, or a stale nonce never obtains the record", async () => {
  const variants: Array<[string, (nonce: string) => Buffer]> = [
    ["hex-decoded key", (n) => mirrorProof(n, Buffer.from(KEY, "hex"))],
    ["foreign key", (n) => mirrorProof(n, Buffer.from("e".repeat(64), "ascii"))],
    ["foreign run", (n) => mirrorProof(n, Buffer.from(KEY, "ascii"), "run-8")],
    ["stale nonce", () => mirrorProof("f".repeat(32))],
  ];
  for (const [label, make] of variants) {
    const { result, recordCalls, socket } = await exchange((frame) => make(mirrorHelloNonce(frame)!), () => Buffer.from("x\n"));
    assert.deepEqual(result, { disposition: "not-sent", reason: "proof-mismatch" }, label);
    assert.equal(recordCalls, 0, label);
    assert.equal(socket.writes.length, 1, label);
  }
});

/* ---------------------------------------------- bounded, cancelable I/O */

test("I/O: one overlapped operation per transfer, sliced waits against token and monotonic deadline, CancelIoEx, no retry", () => {
  const xfer = functionBody("SupHookXfer");
  assert.ok(
    xfer.startsWith(
      "function SupHookXfer([Type]$hk,[object]$hConn,[IntPtr]$hRaw,[bool]$hWrite,[byte[]]$hBuf,[int]$hOff,[int]$hCount,[Diagnostics.Stopwatch]$hClock,[long]$hUntil,[Threading.CancellationToken]$hCancel,[ref]$hDone){",
    ),
  );
  assertOrdered(
    xfer,
    "$hDone.Value=-1",
    "if($hCount -le 0 -or $hOff -lt 0 -or ($hOff+$hCount) -gt $hBuf.Length){return 'io'}",
    "if($hCancel.IsCancellationRequested){return 'cancelled'}",
    "if($hClock.ElapsedMilliseconds -ge $hUntil){return 'timeout'}",
    "try{if($hWrite){$hTask=$hConn.WriteAsync($hBuf,$hOff,$hCount)}else{$hTask=$hConn.ReadAsync($hBuf,$hOff,$hCount)}}catch{return 'io'}",
    "if($hTask -isnot [Threading.Tasks.Task]){return 'io'}",
    "while(-not $hTask.IsCompleted){\nif($hCancel.IsCancellationRequested){$hWhy='cancelled';break}",
    "$hLeft=$hUntil-$hClock.ElapsedMilliseconds",
    "if($hLeft -le 0){$hWhy='timeout';break}",
    "try{[void]$hTask.Wait([int][Math]::Min(25,$hLeft))}catch{}}\nif($hWhy -cne 'ok'){",
    "try{[void]$hk::CancelIoEx($hRaw,[IntPtr]::Zero)}catch{}",
    // The grace wait is capped by the remaining grace, so it never exceeds the declared 1000 ms.
    "$hGrace=[Diagnostics.Stopwatch]::StartNew()\nwhile(-not $hTask.IsCompleted){\n$hLeft=1000-$hGrace.ElapsedMilliseconds\nif($hLeft -le 0){break}\ntry{[void]$hTask.Wait([int][Math]::Min(25,$hLeft))}catch{}}\nif($hTask.IsCompleted){return $hWhy}",
    "return 'unsettled'}",
    "if($hTask.Status -ne [Threading.Tasks.TaskStatus]::RanToCompletion){return 'io'}",
    "if($hWrite){$hDone.Value=$hCount;return 'ok'}",
    "$hGot=[int]$hTask.Result",
    "if($hGot -lt 0 -or $hGot -gt $hCount){return 'io'}",
    "$hDone.Value=$hGot",
  );
  // Exactly one CancelIoEx, only on the cancellation/timeout path; no unbounded wait, sleep, or default token.
  assert.equal(count(SOURCE, "CancelIoEx"), 1);
  assert.doesNotMatch(SOURCE, /\.Wait\(\)|Wait\(-1\)|Infinite|Sleep|Start-Sleep|CancellationToken\]::None|WaitNamedPipe|ConnectNamedPipe|WaitForConnection/u);
  // No retry: every transfer result is examined once and any non-ok result returns immediately.
  const serve = functionBody("SupHookServe");
  const RESULT = /\$hX=SupHookXfer [^\n]+\nif\(\$hX -cne 'ok'\)\{if\(\$hX -ceq 'unsettled'\)\{\$hSettled=\$false\};return \(SupHookXferCode \$hX 'hook-(hello|proof|record)-io'\)\}\n/gu;
  assert.equal([...serve.matchAll(RESULT)].length, 3);
  assert.deepEqual(
    [...functionBody("SupHookXferCode").matchAll(/return '([a-z-]+)'/gu)].map((m) => m[1]),
    ["hook-cancelled", "hook-timeout", "hook-unsettled"],
  );
  // Loops are bounded: HELLO by its fixed length, the record by its bound, waits by the deadline and grace.
  assert.deepEqual(
    [...SOURCE.matchAll(/while\(([^{]*)\)\{/gu)].map((m) => m[1]),
    ["-not $hTask.IsCompleted", "-not $hTask.IsCompleted", "$hGot -lt 40", "$hLf -lt 0"],
  );
  assert.doesNotMatch(SOURCE, /\bforeach\b|\bdo\s*\{|\buntil\b|\bcontinue\b/u);
});

/* ------------------------------------------------------------ candidate */

const CANDIDATE = emulate(WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN);

function acceptsCandidate(text: string): boolean {
  const m = CANDIDATE.exec(text);
  if (!m || m[1] !== RUN_ID) return false;
  const endpoint = `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${m[3]}`;
  // The fixed function's endpoint gate: the shared .NET grammar plus the dot rule.
  return emulate(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN).test(endpoint) && !m[3]!.endsWith(".");
}

test("candidate: only the PoC's canonical root SessionStart v1 JSON with the exact run, UUID, LOCAL socket and token", () => {
  assert.deepEqual([...WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS], ["v", "runId", "event", "sessionId", "socket", "token"]);
  // The independent PoC literal is accepted, and the helper reproduces the same canonical shape.
  assert.ok(acceptsCandidate(POC_LITERAL), "the PoC wire format is accepted");
  assert.equal(candidate({ token: "AZaz09+/=_.~-AZaz09+/=_.~-" }), POC_LITERAL);
  assert.deepEqual(Object.keys(JSON.parse(POC_LITERAL) as object), [...WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS]);
  assert.ok(!acceptsCandidate(OLD_RECEIVER_LITERAL), "the earlier incompatible format is refused");
  assert.ok(!acceptsCandidate(OLD_RECEIVER_LITERAL.replace('"endpoint"', '"socket"')), "event-before-runId order is refused");
  assert.ok(!acceptsCandidate(POC_LITERAL.replace('"socket"', '"endpoint"')), "the endpoint field name is refused");
  const accepted = [
    POC_LITERAL,
    candidate(),
    candidate({ token: "a".repeat(LIMITS.tokenMinChars) }),
    candidate({ token: "Z".repeat(LIMITS.tokenMaxChars) }),
    candidate({ token: "AZaz09_-AZaz09_-" }),
    candidate({ token: "++++////====....~~~~----____" }),
    candidate({ token: "abcdefg=" }),
    candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}a` }),
    candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}.a` }),
    candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${"x".repeat(200)}` }),
    candidate({ sessionId: "00000000-0000-0000-0000-000000000000" }),
  ];
  for (const text of accepted) {
    assert.ok(acceptsCandidate(text), text.slice(0, 160));
    // JSON semantics agree with the rebuilt values: the escaped endpoint decodes to prefix + segment.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const m = CANDIDATE.exec(text)!;
    assert.equal(`${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${m[3]}`, parsed.socket);
    assert.equal(parseWindowsClaudeInboxLocalEndpoint(parsed.socket).ok, true);
    assert.equal(m[2], parsed.sessionId);
    assert.equal(m[4], parsed.token);
    assert.deepEqual(Object.keys(parsed), [...WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS]);
  }
  const c = candidate();
  const refused: Array<[string, string]> = [
    ["empty", ""],
    ["leading space", ` ${c}`],
    ["trailing space", `${c} `],
    ["trailing LF inside text", `${c}\n`],
    ["BOM", `\ufeff${c}`],
    ["pretty", JSON.stringify(JSON.parse(c), null, 1)],
    ["space after colon", c.replace('"v":1', '"v": 1')],
    ["v string", c.replace('"v":1', '"v":"1"')],
    ["v float", c.replace('"v":1', '"v":1.0')],
    ["v zero-padded", c.replace('"v":1', '"v":01')],
    ["v 2", c.replace('"v":1', '"v":2')],
    ["other event", candidate({ event: "SessionEnd" })],
    ["lowercase event", candidate({ event: "sessionstart" })],
    ["reordered", JSON.stringify({ v: 1, event: "SessionStart", runId: RUN_ID, sessionId: SESSION_ID, socket: ENDPOINT, token: TOKEN })],
    ["endpoint name", JSON.stringify({ v: 1, runId: RUN_ID, event: "SessionStart", sessionId: SESSION_ID, endpoint: ENDPOINT, token: TOKEN })],
    ["both names", c.replace(`,"token"`, `,"endpoint":${JSON.stringify(ENDPOINT)},"token"`)],
    ["missing token", c.replace(`,"token":"${TOKEN}"`, "")],
    ["extra trailing field", c.replace(/\}$/u, ',"cwd":"C:\\\\x"}')],
    ["extra leading field", c.replace('{"v":1', '{"x":0,"v":1')],
    ["duplicate token", c.replace(/\}$/u, `,"token":"${TOKEN}"}`)],
    ["duplicate runId", c.replace(`"sessionId"`, `"runId":"${RUN_ID}","sessionId"`)],
    ["trailing comma", c.replace(/\}$/u, ",}")],
    ["two objects", `${c}${c}`],
    ["array", `[${c}]`],
    ["foreign run", candidate({ runId: "run-8" })],
    ["run prefix", candidate({ runId: `${RUN_ID}x` })],
    ["uppercase uuid", candidate({ sessionId: SESSION_ID.toUpperCase() })],
    ["braced uuid", candidate({ sessionId: `{${SESSION_ID}}` })],
    ["unhyphenated uuid", candidate({ sessionId: SESSION_ID.replace(/-/gu, "") })],
    ["short uuid", candidate({ sessionId: SESSION_ID.slice(1) })],
    ["global endpoint", candidate({ socket: "\\\\.\\pipe\\Global\\a" })],
    ["bare endpoint", candidate({ socket: "\\\\.\\pipe\\a" })],
    ["lowercase local", candidate({ socket: "\\\\.\\pipe\\local\\a" })],
    ["two segments", candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}a\\b` })],
    ["dot segment", candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}..` })],
    ["trailing dot", candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}a.` })],
    ["long segment", candidate({ socket: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${"x".repeat(201)}` })],
    ["slash escape", c.replace("\\\\pipe", "\\/pipe")],
    ["unicode escape backslash", c.replace("\\\\pipe", "\\u005cpipe")],
    ["unicode escape token", candidate({ token: "abcdefgh" }).replace("abcdefgh", "\\u0061bcdefgh")],
    ["short token", candidate({ token: "a".repeat(LIMITS.tokenMinChars - 1) })],
    ["long token", candidate({ token: "a".repeat(LIMITS.tokenMaxChars + 1) })],
    ["empty token", candidate({ token: "" })],
    ["token space", candidate({ token: "abcd efgh" })],
    ["token escaped slash", candidate({ token: "abcd/efgh" }).replace("abcd/efgh", "abcd\\/efgh")],
    ["token backslash", candidate({ token: "abcd\\efgh" })],
    ["token quote", candidate({ token: 'abcd"efgh' })],
    ...[..."!*%:@,;#$&?'()[]{}<>|^`"].map((ch): [string, string] => [`token ${ch}`, candidate({ token: `abcd${ch}efgh` })]),
    ["token non-ascii", candidate({ token: "abcd\u00e9efgh" })],
    ["token number", c.replace(`"token":"${TOKEN}"`, '"token":12345678')],
    ["null token", c.replace(`"token":"${TOKEN}"`, '"token":null')],
    ["single quotes", c.replace(/"/gu, "'")],
  ];
  for (const [label, text] of refused) assert.ok(!acceptsCandidate(text), label);
  // Segments the shared TypeScript parser refuses are refused by the fixed gate, and vice versa.
  for (const seg of ["a", "a.b", ".a", "...a", "-", "_", "a.", ".", "..", "...", "x".repeat(200)]) {
    const endpoint = `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}${seg}`;
    assert.equal(acceptsCandidate(candidate({ socket: endpoint })), parseWindowsClaudeInboxLocalEndpoint(endpoint).ok, seg);
  }
});

test("candidate: one anchored case-sensitive match, exact run equality, shared endpoint grammar, no JSON coercion", () => {
  const serve = functionBody("SupHookServe");
  assert.ok(WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN.startsWith("^") && !WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN.includes("$"));
  assertOrdered(
    serve,
    `$hM=[regex]::Match($hText,'${WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN}')`,
    "if(-not $hM.Success){return 'hook-candidate-malformed'}",
    "if($hM.Groups[1].Value -cne [string]$hRunId){return 'hook-candidate-run'}",
    "$hSeg=$hM.Groups[3].Value",
    "$hEndpoint='\\\\.\\pipe\\LOCAL\\'+$hSeg",
    `if($hEndpoint -cnotmatch '${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN}'){return 'hook-candidate-endpoint'}`,
    "if($hSeg -ceq '.' -or $hSeg -ceq '..' -or $hSeg.EndsWith('.',[StringComparison]::Ordinal)){return 'hook-candidate-endpoint'}",
  );
  assert.equal(count(SOURCE, "[regex]::"), 1);
  assert.ok(SOURCE.includes(`'${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}'+$hSeg`));
  assert.doesNotMatch(SOURCE, /ConvertFrom-Json|JavaScriptSerializer|DataContractJson|Newtonsoft|Json\b|RegexOptions|IgnoreCase|ToLower|ToUpper|Trim|Replace|Normalize|Unescape/iu);
});

/* --------------------------------------------- results, output, cleanup */

test("closed codes: every value the function can return is candidate or one closed refusal, all reachable", () => {
  const produced = new Set<string>();
  const serve = functionBody("SupHookServe");
  const guard = functionBody("SupHookGuard");
  for (const body of [serve, guard]) for (const m of body.matchAll(/return '([a-z-]+)'/gu)) produced.add(m[1]!);
  for (const m of serve.matchAll(/SupHookXferCode \$hX '([a-z-]+)'/gu)) produced.add(m[1]!);
  for (const m of functionBody("SupHookXferCode").matchAll(/return '([a-z-]+)'/gu)) produced.add(m[1]!);
  for (const prefix of ["hook-client-", "hook-child-"]) {
    assert.ok(guard.includes(`return ('${prefix}'+$hHeld)`), prefix);
    for (const held of WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS) produced.add(`${prefix}${held}`);
  }
  produced.delete("ok"); // the guard's internal success, consumed as `if($hG -cne 'ok'){return $hG}`
  assert.ok(serve.includes("return ('hook-child-'+$hHeld)"));
  // The only computed returns are the held compositions, the guard result, and the transfer mapping.
  assert.equal([...serve.matchAll(/return \(/gu)].length, 1 + 3);
  assert.equal(count(serve, "return $hG}"), 3);
  const held = new Set([...functionBody("SupHookHeld").matchAll(/return '([a-z-]+)'/gu)].map((m) => m[1]!));
  assert.deepEqual([...held].sort(), ["ok", ...WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS].sort());
  assert.deepEqual([...produced].sort(), ["candidate", ...WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS].sort());
  assert.equal(new Set(WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS).size, WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS.length);
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS) && Object.isFrozen(WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS));
  for (const code of ["candidate", ...WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS]) assert.equal(classifyWindowsClaudeHookReceiveResult(code), code);
  for (const other of [undefined, null, 0, "", "ok", "OK", "candidate ", "candidate\n", "hook-", "hook-client-ok", "hook-child-mismatch", "io", "unsettled", {}]) {
    assert.equal(classifyWindowsClaudeHookReceiveResult(other), undefined, JSON.stringify(other));
  }
});

test("output: the candidate leaves only through the caller's [ref], after every check; refusals leave it null", () => {
  const serve = functionBody("SupHookServe");
  assert.equal(count(SOURCE, "$hOut.Value="), 3);
  assert.equal(count(serve, "$hOut.Value=$null"), 2, "zeroed first and again on an unexpected exception");
  const HANDOFF = "$hOut.Value=@{SessionId=$hM.Groups[2].Value;Endpoint=$hEndpoint;Token=$hM.Groups[4].Value}\nreturn 'candidate'\n}catch{";
  indexOnce(HANDOFF, serve);
  assert.equal(count(SOURCE, "return 'candidate'"), 1);
  // No stdout/stderr/host/env/argv/file/process channel, no failure path of the host, no exceptions out.
  assert.doesNotMatch(
    SOURCE,
    /Console|Write-|Out-|SupOut|SupDiag|SupReply|SupSend|SupFail|SupBootFail|\$env:|Environment|Set-Content|Add-Content|New-Item|\[IO\.File|FileStream|Start-Process|Process\]::Start|Invoke-Expression|\biex\b|ScriptBlock|Add-Type|Reflection|\bexit\b|\bthrow\b|\btrap\b|Export-|Tee-|Register-|Net\.Sockets|TcpClient|UdpClient|Http|WebClient|Dns/iu,
  );
  // The run id, key, and nonce are never part of any returned or output value.
  assert.doesNotMatch(HANDOFF, /hKey|hRunId|hNonce|hSum|hProof|hMac/u);
});

test("release: the retained client handle closes exactly once; secret buffers clear; I/O buffers clear only when settled", () => {
  const serve = functionBody("SupHookServe");
  assert.equal(count(SOURCE, "CloseHandle"), 1);
  const CATCH = "}catch{$hSettled=$false;try{$hOut.Value=$null}catch{};return 'hook-unexpected'}\nfinally{\n";
  const FINALLY_BODY = [
    "if([long]$hProc -ne 0 -and [long]$hProc -ne -1){try{[void]$hk::CloseHandle($hProc)}catch{}}",
    "if($null -ne $hMac){try{$hMac.Dispose()}catch{}}",
    "if($null -ne $hKeyBytes){try{[Array]::Clear($hKeyBytes,0,$hKeyBytes.Length)}catch{}}",
    "if($null -ne $hSum){try{[Array]::Clear($hSum,0,$hSum.Length)}catch{}}",
    "if($hSettled){",
    "if($null -ne $hHello){try{[Array]::Clear($hHello,0,$hHello.Length)}catch{}}",
    "if($null -ne $hProof){try{[Array]::Clear($hProof,0,$hProof.Length)}catch{}}",
    "if($null -ne $hRec){try{[Array]::Clear($hRec,0,$hRec.Length)}catch{}}}",
    "$hText=$null;$hM=$null}}",
  ].join("\n");
  const catcher = indexOnce(CATCH, serve);
  assert.equal(serve.slice(catcher + CATCH.length), FINALLY_BODY);
  // Every tracked variable exists before the protected block, so the finally never reads an unset name.
  const PRE =
    "try{$hOut.Value=$null}catch{return 'hook-unexpected'}\n$hProc=[IntPtr]::Zero;$hSettled=$true;$hKeyBytes=$null;$hMac=$null;$hSum=$null;$hHello=$null;$hProof=$null;$hRec=$null;$hText=$null;$hM=$null\ntry{\n";
  assert.equal(serve.slice(SERVE_HEADER.length + 1, SERVE_HEADER.length + 1 + PRE.length), PRE);
  // Exactly one protected block in the entry function, wrapping everything after the pre-assignments.
  assert.equal(count(serve, "\ntry{\n"), 1);
  // $hProc is assigned only by the single OpenProcess; the pseudo handle is never closed.
  assert.equal([...serve.matchAll(/\$hProc=/gu)].length, 2);
  // Settlement is lost on every unsettled transfer and on any unexpected exception.
  assert.equal(count(serve, "if($hX -ceq 'unsettled'){$hSettled=$false}"), 3);
  assert.equal(count(serve, "$hSettled=$false"), 4);
  // Dispose is the HMAC's only; the connection is never disposed or closed here.
  assert.equal(count(SOURCE, ".Dispose()"), 1);
  assert.doesNotMatch(SOURCE, /\$hConn\.(?:Dispose|Close|Disconnect)|DisconnectNamedPipe/u);
});

/* ------------------------------------------------------ host contract */

test("host contract: documented against the existing supervisor primitives, interop surface exact, not wired", () => {
  const sup = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE;
  const contract = WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT;
  assert.ok(Object.isFrozen(contract));
  assert.equal(contract.interopType, "$K");
  assert.ok(sup.includes("$K=$TB.CreateType()"));
  for (const name of contract.existingInterop) assert.ok(sup.includes(`SupDef '${name}' `), `${name} already declared`);
  const declared: string[] = [];
  for (const declaration of contract.additionalInteropDeclarations) {
    assert.match(declaration, /^SupDef '[A-Za-z]+' \$T[IFN] @\((?:\[string\]|\$T[IAFN])(?:,(?:\$T[IAFN]))*\)$/u);
    const name = /^SupDef '([A-Za-z]+)'/u.exec(declaration)![1]!;
    assert.ok(!sup.includes(`SupDef '${name}'`), `${name} is not declared in the supervisor yet`);
    declared.push(name);
  }
  for (const alias of ["$TI=[IntPtr]", "$TN=[int]", "$TF=[bool]", "$TA=[int[]]"]) assert.ok(sup.includes(alias), alias);
  const called = new Set([...SOURCE.matchAll(/\$hk::([A-Za-z0-9]+)\(/gu)].map((m) => m[1]!));
  assert.deepEqual([...called].sort(), [...contract.existingInterop, ...declared].sort());
  // Static .NET use is limited to this fixed allowlist.
  const statics = new Set([...SOURCE.matchAll(/\[([A-Za-z0-9.]+(?:\[\])?)\]::([A-Za-z0-9]+)/gu)].map((m) => `[${m[1]}]::${m[2]}`));
  assert.deepEqual([...statics].sort(), [
    "[Array]::Clear",
    "[Diagnostics.Stopwatch]::StartNew",
    "[IntPtr]::Zero",
    "[Math]::Min",
    "[Runtime.InteropServices.Marshal]::GetLastWin32Error",
    "[Security.Cryptography.HMACSHA256]::new",
    "[StringComparison]::Ordinal",
    "[Text.Encoding]::ASCII",
    "[Threading.Tasks.TaskStatus]::RanToCompletion",
    "[byte[]]::new",
    "[int[]]::new",
    "[regex]::Match",
  ]);
  // Argument mapping matches the entry header and the supervisor's custody state.
  const header = /^function SupHookServe\(([^)]*)\)\{/mu.exec(SOURCE)![1]!;
  assert.deepEqual(
    contract.arguments.map((a) => a.parameter),
    header.split(",").map((p) => p.replace(/^\[[A-Za-z.]+\]/u, "")),
  );
  assert.deepEqual(contract.arguments.slice(0, 5).map((a) => a.source), ["$K", "$CH", "$ChildPid", "$Job", "$WPid"]);
  assert.ok(sup.includes("$script:CH=$childH;$script:ChildPid=[int]$claimed"), "set only by SupChild");
  assert.ok(sup.includes("$script:Job=$ProvJob;"), "set only by a matching CONFIRM");
  assert.ok(sup.includes("$script:WPid=$cp[0]"), "set only from the control pipe's kernel client PID");
  assert.ok(sup.includes("$script:Phase='run'"));
  assert.equal(contract.phase, "run");
  assert.equal(contract.connectionDisposal, "caller-disposes-after-every-result");
  assert.equal(contract.clientHandle, "opened-retained-and-closed-once-inside");
  assert.equal(contract.lastError, "supdef-setlasterror-read-immediately-after-peek");
  assert.ok(sup.includes("[object[]]@($true,$name,[Runtime.InteropServices.CharSet]::Unicode)"), "SupDef sets SetLastError=true");
  // The supervisor has no hook pipe, key, or listener today; nothing here adds one.
  assert.doesNotMatch(sup, /prg682-hook|HELLO1|PROOF|HMAC/u);
  // The fixed source could later travel in the existing startup frame alongside the peer helper.
  assert.ok(sup.length + 1 + WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.length + 1 + SOURCE.length <= WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
});

/* ------------------------------------------------- inactive module surface */

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("inactive: closed export surface, no imports, no runtime capability, and no product caller", () => {
  assert.deepEqual(Object.keys(receiverModule).sort(), [
    "WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS",
    "WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_CLIENT_ACCESS",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_HELPER_FUNCTIONS",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_PROOF_CONTEXT",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE",
    "WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32",
    "classifyWindowsClaudeHookReceiveResult",
  ]);
  const functions = Object.entries(receiverModule).filter(([, value]) => typeof value === "function").map(([name]) => name);
  assert.deepEqual(functions, ["classifyWindowsClaudeHookReceiveResult"]);
  const moduleText = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(moduleText.endsWith("\n") && !moduleText.endsWith("\n\n"));
  assert.doesNotMatch(moduleText, /^\s*import\b|\brequire\(|\bimport\(/mu, "no imports at all");
  assert.doesNotMatch(moduleText, /child_process|node:net|node:fs|process\.|console\.|\bspawn\(|(?<![.\w])exec\(|\bfetch\(|new Function|\beval\(/u);
  // It names neither inactive sibling module, so their own no-caller checks stay green.
  assert.ok(!moduleText.includes("native-windows-claude-hook-forwarder") && !moduleText.includes("native-windows-claude-inbox-peer"));
  assert.ok(!moduleText.includes("SupPeerOpen") && !moduleText.includes("SupPeerHeld"));
  // No product source imports or names this module, except the custody renderer's opt-in hook
  // mode, which composes the fixed source verbatim, calls only the entry function, and never
  // redefines it; the default supervisor template stays hook-free.
  for (const file of listTs(join(PROJECT_ROOT, "src"))) {
    if (file === MODULE_SOURCE_PATH) continue;
    const text = readFileSync(file, "utf8");
    if (file === OPT_IN_COMPOSER_PATH) {
      assert.doesNotMatch(text, /function SupHook(?:Serve|Held|Guard|Xfer)/u, "the composer never redefines the fixed functions");
      assert.doesNotMatch(text, /SupHook(?:Held|Guard|Xfer)/u, "the composer calls only the entry function");
      assert.ok(!WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.includes("SupHook"), "the default template stays hook-free");
      continue;
    }
    assert.ok(!text.includes("native-windows-claude-hook-receiver"), `${file} must not import the inactive module`);
    assert.ok(!/SupHook(?:Serve|Held|Guard|Xfer)/u.test(text), `${file} must not wire the fixed function`);
  }
});
