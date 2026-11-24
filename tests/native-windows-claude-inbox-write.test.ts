/**
 * Native Windows Claude single-attempt inbox write (#682), portable tests.
 *
 * The module is pure and inactive. These tests pin the fixed PowerShell 5.1
 * source's grammar, its composition with the landed exact peer-open helper
 * (same handle, no reopen), the proof-before-auth ordering, the one owned
 * overlapped write with bounded cancellation, the closed not-sent /
 * sent-unconfirmed / unknown results, single release and conditional buffer
 * clearing, the frame bounds, and byte-for-byte equality of the framing with
 * the existing TypeScript Claude inbox sender (captured through its own test
 * seams; no socket, process, or file is created). Nothing is spawned and
 * nothing touches the filesystem except reading this repository's own source
 * files. This is NOT Windows evidence: the inert runtime proof of the
 * function remains later work.
 */

import assert from "node:assert/strict";
import type { BigIntStats } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";

import * as writeModule from "../src/session-host/native-windows-claude-inbox-write";
import {
  WINDOWS_CLAUDE_INBOX_WRITE_CANDIDATE_KEYS,
  WINDOWS_CLAUDE_INBOX_WRITE_COMPOSED_FUNCTIONS,
  WINDOWS_CLAUDE_INBOX_WRITE_FUNCTION,
  WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS,
  WINDOWS_CLAUDE_INBOX_WRITE_HELPER_FUNCTIONS,
  WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT,
  WINDOWS_CLAUDE_INBOX_WRITE_LIMITS,
  WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT,
  WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS,
  WINDOWS_CLAUDE_INBOX_WRITE_SENT,
  WINDOWS_CLAUDE_INBOX_WRITE_SOURCE,
  WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN,
  WINDOWS_CLAUDE_INBOX_WRITE_WIN32,
  classifyWindowsClaudeInboxWriteResult,
  type WindowsClaudeInboxWriteNotSent,
  type WindowsClaudeInboxWriteResult,
  type WindowsClaudeInboxWriteUnknown,
} from "../src/session-host/native-windows-claude-inbox-write";
import {
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX,
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN,
  WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS,
  WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE,
  WINDOWS_CLAUDE_INBOX_PEER_WIN32,
} from "../src/session-host/native-windows-claude-inbox-peer";
import {
  WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN,
  WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT,
  WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE,
} from "../src/session-host/native-windows-claude-hook-receiver";
import {
  CLAUDE_INBOX_MAX_FRAME_BYTES,
  CLAUDE_INBOX_MAX_TEXT_BYTES,
  createClaudeInboxSendCapability,
  sendClaudeInboxMessage,
  setClaudeInboxConnectorForTests,
  setClaudeInboxLstatForTests,
  setClaudeInboxPlatformForTests,
  type ClaudeInboxSendCapability,
} from "../src/session-host/native-claude-inbox-delivery";
import {
  WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE,
  WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE,
} from "../src/session-host/native-windows-claude-custody-scripts";

const PROJECT_ROOT = join(__dirname, "..", "..");
const MODULE_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-inbox-write.ts");
/** The custody renderer's opt-in hook CONTROL mode composes this fixed source verbatim. */
const OPT_IN_CONTROL_COMPOSER_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-custody-scripts.ts");
const SOURCE = WINDOWS_CLAUDE_INBOX_WRITE_SOURCE;
const LIMITS = WINDOWS_CLAUDE_INBOX_WRITE_LIMITS;

/* Synthetic, inert values only. */
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const ENDPOINT = `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}claude-synthetic_1.a`;
/** Exercises the PoC token alphabet beyond base64url: `+ / = . ~`. */
const TOKEN = "Syn+th/et=ic_.~-Token0";

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

function functionBody(name: string, source = SOURCE): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next + 1);
}

/** Portable emulation of the .NET `\z` (true end of input) for the shared ASCII subset. */
function emulate(pattern: string): RegExp {
  assert.ok(pattern.endsWith("\\z"));
  return new RegExp(pattern.replace(/\\z$/u, "(?![\\s\\S])"));
}

/** The single-quoted .NET pattern of one `-cnotmatch` test on the named variable. */
function sourcePattern(variable: string): string {
  const m = new RegExp(`if\\(\\$${variable} -cnotmatch '([^']+)'\\)`, "u").exec(SOURCE);
  assert.ok(m, variable);
  return m[1]!;
}

const SEND = functionBody("SupInboxSend");
const GUARD = functionBody("SupInboxGuard");

/* --------------------------------------------- JavaScript mirror of framing */

/** The fixed frame literals, read from the source so the mirror cannot drift. */
const USER_LITERAL = /\$qUser='([^']*)'\+\$qSid\+'([^']*)'\+\$qEsc\+'([^']*)'\+\[string\]\[char\]10\n/u.exec(SOURCE);
const AUTH_LITERAL = /\$qAuth='([^']*)'\+\$qTok\+'([^']*)'\+\[string\]\[char\]10\n/u.exec(SOURCE);

/** The escape statements the mirror reproduces, pinned verbatim. */
const ESCAPE_STATEMENTS = [
  "$qEsc=([string]$qText).Replace('\\','\\\\').Replace('\"','\\\"')",
  "for($qI=0;$qI -lt 32;$qI++){",
  "if($qI -eq 8){$qR='\\b'}elseif($qI -eq 9){$qR='\\t'}elseif($qI -eq 10){$qR='\\n'}elseif($qI -eq 12){$qR='\\f'}elseif($qI -eq 13){$qR='\\r'}else{$qR='\\u'+$qI.ToString('x4')}",
  "$qEsc=$qEsc.Replace([string][char]$qI,$qR)}",
];

/** Ordinal replace-all, like .NET `String.Replace(string,string)`. */
function replaceAll(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

function mirrorEscape(text: string): string {
  let esc = replaceAll(replaceAll(text, "\\", "\\\\"), "\"", "\\\"");
  const short: Record<number, string> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
  for (let i = 0; i < 32; i += 1) {
    esc = replaceAll(esc, String.fromCharCode(i), short[i] ?? `\\u${i.toString(16).padStart(4, "0")}`);
  }
  return esc;
}

function mirrorUserFrame(sessionId: string, text: string): string {
  assert.ok(USER_LITERAL);
  return `${USER_LITERAL[1]}${sessionId}${USER_LITERAL[2]}${mirrorEscape(text)}${USER_LITERAL[3]}\n`;
}

function mirrorAuthFrame(token: string): string {
  assert.ok(AUTH_LITERAL);
  return `${AUTH_LITERAL[1]}${token}${AUTH_LITERAL[2]}\n`;
}

/** Lone UTF-16 surrogates are refused by the strict UTF-8 encoder. */
function isWellFormed(text: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text);
}

type Candidate = Record<string, unknown>;

/**
 * Mirror of the fixed function's pure pre-open checks, in source order:
 * candidate, content, then the user frame bound. Returns the not-sent code or
 * the frames it would write after a successful peer open and guard.
 */
function mirrorPreOpen(candidate: unknown, text: unknown): WindowsClaudeInboxWriteNotSent | { auth: Buffer; user: Buffer } {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return "not-sent-candidate";
  const keys = Object.keys(candidate);
  if (keys.length !== 3) return "not-sent-candidate";
  for (const key of WINDOWS_CLAUDE_INBOX_WRITE_CANDIDATE_KEYS) if (!keys.includes(key)) return "not-sent-candidate";
  const { SessionId: sid, Endpoint: endpoint, Token: token } = candidate as Candidate;
  if (typeof sid !== "string" || typeof endpoint !== "string" || typeof token !== "string") return "not-sent-candidate";
  if (!emulate(sourcePattern("qSid")).test(sid)) return "not-sent-candidate";
  if (!emulate(sourcePattern("qEndpoint")).test(endpoint)) return "not-sent-candidate";
  if (endpoint.endsWith(".")) return "not-sent-candidate";
  if (!emulate(sourcePattern("qTok")).test(token)) return "not-sent-candidate";
  if (typeof text !== "string" || text.length === 0) return "not-sent-content";
  if (text.length > LIMITS.contentMaxBytes) return "not-sent-oversize";
  if (!isWellFormed(text)) return "not-sent-content";
  if (Buffer.byteLength(text, "utf8") > LIMITS.contentMaxBytes) return "not-sent-oversize";
  const user = Buffer.from(mirrorUserFrame(sid, text), "utf8");
  if (user.length > LIMITS.frameMaxBytes) return "not-sent-oversize";
  const auth = Buffer.from(mirrorAuthFrame(token), "utf8");
  if (auth.length > LIMITS.frameMaxBytes) return "not-sent-oversize";
  return { auth, user };
}

function candidate(overrides: Candidate = {}): Candidate {
  return { SessionId: SESSION_ID, Endpoint: ENDPOINT, Token: TOKEN, ...overrides };
}

/** The frames the existing TypeScript sender would write, as JSON.stringify builds them. */
function referenceFrames(sessionId: string, token: string, text: string): { auth: Buffer; user: Buffer } {
  return {
    auth: Buffer.from(`${JSON.stringify({ type: "auth", token })}\n`, "utf8"),
    user: Buffer.from(`${JSON.stringify({ type: "user", session_id: sessionId, message: { role: "user", content: text } })}\n`, "utf8"),
  };
}

/* ------------------------------------------------------------ type checks */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const resultUnion: Equal<
  WindowsClaudeInboxWriteResult,
  WindowsClaudeInboxWriteNotSent | "sent-unconfirmed" | WindowsClaudeInboxWriteUnknown
> = true;
// @ts-expect-error "ok" is not a write result: success is only the explicit unconfirmed code
const okIsNotAResult: WindowsClaudeInboxWriteResult = "ok";
// @ts-expect-error "sent" or "delivered" is never a result
const deliveredIsNotAResult: WindowsClaudeInboxWriteResult = "delivered";

test("type contract and constants: closed results, bounds shared with the TS sender, and composed code lists", () => {
  assert.equal(resultUnion, true);
  assert.equal(typeof okIsNotAResult, "string");
  assert.equal(typeof deliveredIsNotAResult, "string");
  assert.equal(LIMITS.contentMaxBytes, CLAUDE_INBOX_MAX_TEXT_BYTES);
  assert.equal(LIMITS.frameMaxBytes, CLAUDE_INBOX_MAX_FRAME_BYTES);
  assert.equal(LIMITS.totalMaxBytes, 2 * LIMITS.frameMaxBytes);
  assert.equal(LIMITS.budgetMaxMs, WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS.budgetMaxMs);
  assert.equal(LIMITS.cancelGraceMs, WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS.cancelGraceMs);
  assert.equal(LIMITS.waitSliceMs, WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS.waitSliceMs);
  assert.equal(LIMITS.tokenMinChars, WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS.tokenMinChars);
  assert.equal(LIMITS.tokenMaxChars, WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS.tokenMaxChars);
  assert.equal(WINDOWS_CLAUDE_INBOX_WRITE_WIN32.INVALID_HANDLE_VALUE, WINDOWS_CLAUDE_INBOX_PEER_WIN32.INVALID_HANDLE_VALUE);
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(WINDOWS_CLAUDE_INBOX_WRITE_WIN32));
  assert.equal(WINDOWS_CLAUDE_INBOX_WRITE_WIN32.ERROR_IO_PENDING, 997);
  assert.equal(WINDOWS_CLAUDE_INBOX_WRITE_WIN32.ERROR_IO_INCOMPLETE, 996);
  assert.equal(WINDOWS_CLAUDE_INBOX_WRITE_WIN32.STATUS_PENDING, 259);
  // Every limit is a literal in the fixed source.
  for (const literal of [
    `if($qText.Length -gt ${LIMITS.contentMaxBytes}){return 'not-sent-oversize'}`,
    `if($qN -gt ${LIMITS.contentMaxBytes}){return 'not-sent-oversize'}`,
    `if($qUserN -gt ${LIMITS.frameMaxBytes}){return 'not-sent-oversize'}`,
    `if($qAuthN -gt ${LIMITS.frameMaxBytes}){return 'not-sent-oversize'}`,
    `if($qRem -gt ${LIMITS.budgetMaxMs}){return 'not-sent-input'}`,
    `$qLeft=${LIMITS.cancelGraceMs}-$qGrace.ElapsedMilliseconds`,
    `[Math]::Min(${LIMITS.waitSliceMs},$qLeft)`,
    `$qErr -ne ${WINDOWS_CLAUDE_INBOX_WRITE_WIN32.ERROR_IO_PENDING})`,
    `if($qE -eq ${WINDOWS_CLAUDE_INBOX_WRITE_WIN32.ERROR_IO_INCOMPLETE}){return 'pending'}`,
    `ReadIntPtr($qOv,0) -eq ${WINDOWS_CLAUDE_INBOX_WRITE_WIN32.STATUS_PENDING}){return 'pending'}`,
    `{${LIMITS.tokenMinChars},${LIMITS.tokenMaxChars}}`,
  ]) {
    assert.ok(SOURCE.includes(literal), literal);
  }
  // The repeated landed code lists are exactly the peer module's.
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS], [...WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS]);
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS], [...WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS]);
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT], [
    "not-sent-input",
    "not-sent-cancelled",
    "not-sent-timeout",
    "not-sent-candidate",
    "not-sent-content",
    "not-sent-oversize",
    ...WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS.map((code) => `not-sent-${code}`),
    ...WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS.map((code) => `not-sent-held-${code}`),
    "not-sent-server",
    "not-sent-event",
    "not-sent-unexpected",
  ]);
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN], ["unknown-io", "unknown-cancelled", "unknown-timeout", "unknown-unsettled", "unknown-unexpected"]);
  assert.equal(WINDOWS_CLAUDE_INBOX_WRITE_SENT, "sent-unconfirmed");
  for (const list of [WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT, WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN, WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS, WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS, WINDOWS_CLAUDE_INBOX_WRITE_CANDIDATE_KEYS]) {
    assert.ok(Object.isFrozen(list));
    assert.equal(new Set(list).size, list.length);
  }
});

/* ------------------------------------------------- fixed source grammar */

const GUARD_HEADER =
  "function SupInboxGuard([Type]$qk,[IntPtr]$qPipe,[IntPtr]$qChild,[int]$qChildPid,[IntPtr]$qJob,[Diagnostics.Stopwatch]$qOwn,[long]$qEnd,[Threading.CancellationToken]$qCancel){";
const POLL_HEADER = "function SupInboxPoll([Type]$qk,[IntPtr]$qPipe,[IntPtr]$qOv,[int[]]$qDone){";
const SEND_HEADER =
  "function SupInboxSend([Type]$qk,[IntPtr]$qChild,[int]$qChildPid,[IntPtr]$qJob,[object]$qCand,[object]$qText,[object]$qClock,[object]$qUntil,[object]$qCancel,[ref]$qSent){";
const FUNCTION_ORDER = [...WINDOWS_CLAUDE_INBOX_WRITE_HELPER_FUNCTIONS, WINDOWS_CLAUDE_INBOX_WRITE_FUNCTION];

test("source grammar: a fixed, placeholder-free PS5.1 source defining exactly three functions and nothing else", () => {
  assert.equal(WINDOWS_CLAUDE_INBOX_WRITE_FUNCTION, "SupInboxSend");
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_HELPER_FUNCTIONS], ["SupInboxGuard", "SupInboxPoll"]);
  assert.match(SOURCE, /^[\x20-\x7e\n]+$/u, "printable ASCII and LF only");
  assert.doesNotMatch(SOURCE, /__[A-Z0-9_]+__/u, "no render placeholders");
  assert.doesNotMatch(SOURCE, /`|\$\{|@'|@"/u, "no backticks, ${...}, or here-strings");
  assert.equal(count(SOURCE, "function "), 3);
  assert.deepEqual([...SOURCE.matchAll(/^function ([A-Za-z]+)\(/gmu)].map((m) => m[1]), FUNCTION_ORDER);
  assert.ok(SOURCE.startsWith(GUARD_HEADER));
  indexOnce(POLL_HEADER);
  indexOnce(SEND_HEADER);
  // Braces and parentheses balance outside single-quoted strings; depth returns to zero only at
  // the three function ends, so nothing runs at top level when the source is dot-sourced.
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
  assert.equal(closes.length, 3);
  assert.equal(closes[2], SOURCE.length - 1);
  for (let i = 0; i < 2; i += 1) {
    assert.ok(SOURCE.slice(closes[i]! + 1).startsWith(`\nfunction ${FUNCTION_ORDER[i + 1]}(`), `function ${i + 1} ends before the next`);
  }
});

test("source grammar: variables use the reserved q-prefix and collide with no supervisor, peer, receiver, or automatic name", () => {
  const constants = new Set(["true", "false", "null"]);
  const varsOf = (text: string): Set<string> =>
    new Set([...text.matchAll(/\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)/gu)].map((m) => m[1]!.toLowerCase()));
  const names = varsOf(SOURCE);
  assert.deepEqual([...names].filter((n) => constants.has(n)).sort(), ["false", "null", "true"]);
  const others = [WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE, WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE, WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE].map(varsOf);
  const automatic = new Set(["pid", "input", "args", "matches", "error", "host", "this", "_", "home", "psitem", "env", "lastexitcode"]);
  for (const name of names) {
    if (constants.has(name)) continue;
    assert.match(name, /^q[a-z0-9]+$/u, `${name} uses the reserved q-prefix`);
    for (const other of others) assert.ok(!other.has(name), `${name} is distinct from existing fixed-source variables`);
    assert.ok(!automatic.has(name), `${name} is not an automatic variable`);
  }
  assert.doesNotMatch(SOURCE, /\$script:|\$global:|Set-Variable|New-Variable/iu, "no non-local state");
  for (const fn of FUNCTION_ORDER) {
    for (const other of [WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE, WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE, WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE]) {
      assert.ok(!other.toLowerCase().includes(fn.toLowerCase()), `${fn} is new and not wired`);
    }
  }
});

/* ------------------------------------------ composition with the peer helper */

test("composition: the landed peer-open is called once with the retained child and candidate endpoint; never redefined", () => {
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_COMPOSED_FUNCTIONS], ["SupPeerHeld", "SupPeerOpen"]);
  for (const fn of WINDOWS_CLAUDE_INBOX_WRITE_COMPOSED_FUNCTIONS) {
    assert.equal(count(WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE, `function ${fn}(`), 1, `${fn} is defined by the landed source`);
    assert.ok(!SOURCE.includes(`function ${fn}`), `${fn} is never redefined here`);
  }
  // Exactly one open, through the landed helper only, with its exact argument order and a [ref] output.
  assert.equal(count(SOURCE, "SupPeerOpen"), 1);
  indexOnce("$qPeer=SupPeerOpen $qk $qChild $qChildPid $qJob $qEndpoint ([ref]$qPipe)\n", SEND);
  assert.ok(WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.includes("function SupPeerOpen([Type]$pk,[IntPtr]$pChild,[int]$pChildPid,[IntPtr]$pJob,[object]$pEndpoint,[ref]$pOut){"));
  // Peer refusals are passed through as closed not-sent codes; anything else is unexpected.
  assertOrdered(
    SEND,
    "if($qPeer -isnot [string]){return 'not-sent-unexpected'}",
    "if($qPeer -cne 'ok'){return ('not-sent-'+$qPeer)}",
    "if([long]$qPipe -eq 0 -or [long]$qPipe -eq -1){return 'not-sent-unexpected'}",
  );
  // The retained-child recheck is the landed check, used only by the guard, on the SAME handle.
  assert.equal(count(SOURCE, "SupPeerHeld"), 1);
  assert.ok(GUARD.includes("$qHeld=SupPeerHeld $qk $qChild $qChildPid $qJob\nif($qHeld -cne 'ok'){return ('not-sent-held-'+$qHeld)}"));
  assert.ok(WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.includes("function SupPeerHeld([Type]$pk,[IntPtr]$pChild,[int]$pChildPid,[IntPtr]$pJob){"));
  const GUARD_CALL = "$qG=SupInboxGuard $qk $qPipe $qChild $qChildPid $qJob $qOwn $qEnd $qCancel\nif($qG -cne 'ok'){return $qG}";
  assert.equal(count(SEND, GUARD_CALL), 2);
  assertOrdered(
    GUARD,
    "$qHeld=SupPeerHeld",
    "if(-not ($qk::GetNamedPipeServerProcessId($qPipe,$qServer) -and $qServer[0] -eq $qChildPid)){return 'not-sent-server'}",
    "if($qCancel.IsCancellationRequested){return 'not-sent-cancelled'}",
    "if($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}",
    "return 'ok'}",
  );
  // No reopen and no other route to a pipe: no CreateFile, WaitNamedPipe, client stream, or process open.
  assert.doesNotMatch(SOURCE, /CreateFile|WaitNamedPipe|NamedPipeClientStream|NamedPipeServerStream|OpenProcess|DuplicateHandle|\[IO\.File\]::|File\]::Open/u);
  // The one write targets that same handle; completion is read only from that handle and OVERLAPPED.
  indexOnce("$qk::WriteFile($qPipe,$qMem,$qLen,[IntPtr]::Zero,$qOv)", SEND);
  assert.ok(functionBody("SupInboxPoll").includes("$qk::GetOverlappedResult($qPipe,$qOv,$qDone,$false)"));
  // Cancellation targets only that OVERLAPPED: once on the timeout/cancel path, once (if not yet) on the catch path.
  assert.equal(count(SEND, "try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}"), 2);
  // $qPipe is assigned only by its zero initialization and the peer-open [ref].
  assert.equal([...SEND.matchAll(/\$qPipe=/gu)].length, 1);
});

/* -------------------------------------------------- inputs and ordering */

test("ordering: inputs, time, and candidate/content proof precede the open; the auth frame follows the held-pipe guard", () => {
  const PRE =
    "try{$qSent.Value=0}catch{return 'not-sent-unexpected'}\n$qPipe=[IntPtr]::Zero;$qEvt=[IntPtr]::Zero;$qOv=[IntPtr]::Zero;$qMem=[IntPtr]::Zero;$qLen=0;$qBuf=$null;$qStarted=$false;$qSettled=$true;$qCxl=$false;$qTok=$null;$qEsc=$null;$qUser=$null;$qAuth=$null\ntry{\n";
  assert.equal(SEND.slice(SEND_HEADER.length + 1, SEND_HEADER.length + 1 + PRE.length), PRE);
  assertOrdered(
    SEND,
    "if($qCancel -isnot [Threading.CancellationToken]){return 'not-sent-input'}",
    "if(-not $qCancel.CanBeCanceled){return 'not-sent-input'}",
    "if($qClock -isnot [Diagnostics.Stopwatch]){return 'not-sent-input'}",
    "if(-not $qClock.IsRunning){return 'not-sent-input'}",
    "if($qUntil -isnot [long]){return 'not-sent-input'}",
    // The private clock starts BEFORE the caller's budget is sampled, the truncated sample loses 1 ms,
    // and the private deadline is rechecked before the candidate is touched.
    "$qOwn=[Diagnostics.Stopwatch]::StartNew()\n$qRem=$qUntil-$qClock.ElapsedMilliseconds\nif($qRem -gt 5000){return 'not-sent-input'}\nif($qCancel.IsCancellationRequested){return 'not-sent-cancelled'}\nif($qRem -le 1){return 'not-sent-timeout'}\n$qEnd=[long]$qRem-1\nif($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}\n",
    "if($qCand -isnot [hashtable]){return 'not-sent-candidate'}",
    "if($qCand.Count -ne 3){return 'not-sent-candidate'}",
    "if(-not ($qCand.ContainsKey('SessionId') -and $qCand.ContainsKey('Endpoint') -and $qCand.ContainsKey('Token'))){return 'not-sent-candidate'}",
    "$qSid=$qCand['SessionId'];$qEndpoint=$qCand['Endpoint'];$qTok=$qCand['Token']",
    "if($qSid -isnot [string] -or $qEndpoint -isnot [string] -or $qTok -isnot [string]){return 'not-sent-candidate'}",
    "if($qSid -cnotmatch ",
    "if($qEndpoint -cnotmatch ",
    "if($qEndpoint.EndsWith('.',[StringComparison]::Ordinal)){return 'not-sent-candidate'}",
    "if($qTok -cnotmatch ",
    "if($qText -isnot [string]){return 'not-sent-content'}",
    "if($qText.Length -eq 0){return 'not-sent-content'}",
    "if($qText.Length -gt 65536){return 'not-sent-oversize'}",
    "$qUtf8=[Text.UTF8Encoding]::new($false,$true)",
    "try{$qN=$qUtf8.GetByteCount([string]$qText)}catch{return 'not-sent-content'}",
    "if($qN -gt 65536){return 'not-sent-oversize'}",
    ESCAPE_STATEMENTS[0]!,
    "$qUser='",
    "if($qUserN -gt 131072){return 'not-sent-oversize'}",
    "$qPeer=SupPeerOpen",
    "$qAuth='",
    "$qLen=$qAuthN+$qUserN\n$qBuf=[byte[]]::new($qLen)",
    "$qEvt=$qk::CreateEventW([IntPtr]::Zero,$true,$false,[IntPtr]::Zero)",
    "$qMem=[Runtime.InteropServices.Marshal]::AllocHGlobal($qLen)",
    "$qStarted=$true",
    "$qOk=$qk::WriteFile(",
  );
  // The caller's clock is read exactly once, at entry; every later time check uses the function's own clock.
  assert.equal(count(SOURCE, "$qClock.ElapsedMilliseconds"), 1);
  assert.equal(count(SOURCE, "$qUntil"), 3, "parameter, type check, and the one entry read");
  assert.equal(count(SOURCE, "$qOwn=[Diagnostics.Stopwatch]::StartNew()"), 1);
  assert.ok(SEND.indexOf("$qOwn=[Diagnostics.Stopwatch]::StartNew()") < SEND.indexOf("$qClock.ElapsedMilliseconds"), "private clock first");
  // The entry recheck plus the pre-open check: the private deadline is tested before the candidate and before the open.
  assert.equal(count(SEND, "if($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}\n"), 2);
  assert.doesNotMatch(SOURCE, /\$qOwn\.(?:Stop|Reset|Restart|Start)\(/u, "the own clock is never stopped or reset");
  // Cancellation and the deadline are checked at entry, again immediately before the open, and in both guards.
  const timeChecks = "if($qCancel.IsCancellationRequested){return 'not-sent-cancelled'}\nif($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}\n";
  assert.equal(count(SEND, timeChecks), 1);
  assert.ok(SEND.includes(`${timeChecks}$qPeer=SupPeerOpen`), "time is rechecked right before the open");
  // The first guard sits between the open and the auth frame; the second immediately precedes the write.
  const GUARD_CALL = "$qG=SupInboxGuard $qk $qPipe $qChild $qChildPid $qJob $qOwn $qEnd $qCancel\nif($qG -cne 'ok'){return $qG}\n";
  const first = SEND.indexOf(GUARD_CALL);
  assert.ok(SEND.indexOf("$qPeer=SupPeerOpen") < first && first < SEND.indexOf("$qAuth='"), "auth is formed only after the held-pipe guard");
  assert.ok(SEND.includes(`[Array]::Clear($qBuf,0,$qLen)\n${GUARD_CALL}$qStarted=$true\n$qOk=$qk::WriteFile(`));
  // The token is read once from the candidate, matched, and otherwise used only in the auth frame.
  // Uses: initialization, read, type check, grammar, auth frame, and the finally drop.
  assert.equal([...SEND.matchAll(/\$qTok\b/gu)].length, 6);
  assert.equal(count(SEND, "$qTok=$null"), 2, "initialized and dropped in finally");
  assert.ok(!SEND.slice(0, SEND.indexOf("$qPeer=SupPeerOpen")).includes("$qAuth='"), "no auth before the open");
});

test("candidate and content: re-matched against the receiver's grammar with no coercion; bounded before any work", () => {
  // The candidate grammar is exactly the hook receiver's (session id, endpoint, token) and the shared endpoint grammar.
  const receiverGroups = /"sessionId":"\(([^)]+)\)".*"token":"\(([^)]+)\)"/u.exec(WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN);
  assert.ok(receiverGroups);
  assert.equal(sourcePattern("qSid"), `^${receiverGroups[1]}\\z`);
  assert.equal(sourcePattern("qTok"), `^${receiverGroups[2]}\\z`);
  assert.equal(sourcePattern("qEndpoint"), WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN);
  assert.ok(WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE.includes("$hOut.Value=@{SessionId=$hM.Groups[2].Value;Endpoint=$hEndpoint;Token=$hM.Groups[4].Value}"), "same keys as the receiver output");
  assert.deepEqual([...WINDOWS_CLAUDE_INBOX_WRITE_CANDIDATE_KEYS], ["SessionId", "Endpoint", "Token"]);
  // The accepted session id and token alphabets never need JSON escaping, so their frames are literal.
  for (const value of [SESSION_ID, TOKEN, "AZaz09+/=_.~-AZaz09+/=_.~-"]) assert.equal(JSON.stringify(value), `"${value}"`);

  const ok = mirrorPreOpen(candidate(), "hello");
  assert.equal(typeof ok, "object");
  const refusals: [unknown, unknown, WindowsClaudeInboxWriteNotSent][] = [
    [null, "x", "not-sent-candidate"],
    ["candidate", "x", "not-sent-candidate"],
    [{ ...candidate(), Extra: "1" }, "x", "not-sent-candidate"],
    [{ SessionId: SESSION_ID, Endpoint: ENDPOINT }, "x", "not-sent-candidate"],
    [{ SessionId: SESSION_ID, Endpoint: ENDPOINT, Tok: TOKEN }, "x", "not-sent-candidate"],
    [candidate({ SessionId: SESSION_ID.toUpperCase() }), "x", "not-sent-candidate"],
    [candidate({ SessionId: `${SESSION_ID}\n` }), "x", "not-sent-candidate"],
    [candidate({ SessionId: 1 }), "x", "not-sent-candidate"],
    [candidate({ Endpoint: "\\\\.\\pipe\\Global\\claude" }), "x", "not-sent-candidate"],
    [candidate({ Endpoint: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}a.` }), "x", "not-sent-candidate"],
    [candidate({ Endpoint: `${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX}..` }), "x", "not-sent-candidate"],
    [candidate({ Endpoint: `${ENDPOINT}\n` }), "x", "not-sent-candidate"],
    [candidate({ Token: "short" }), "x", "not-sent-candidate"],
    [candidate({ Token: "x".repeat(4097) }), "x", "not-sent-candidate"],
    [candidate({ Token: `${TOKEN}"` }), "x", "not-sent-candidate"],
    [candidate({ Token: `${TOKEN}\\` }), "x", "not-sent-candidate"],
    [candidate({ Token: `${TOKEN} ` }), "x", "not-sent-candidate"],
    [candidate(), "", "not-sent-content"],
    [candidate(), 5, "not-sent-content"],
    [candidate(), "lone \ud800 surrogate", "not-sent-content"],
    [candidate(), "\udc00", "not-sent-content"],
    [candidate(), "a".repeat(65537), "not-sent-oversize"],
    // 21846 three-byte characters: within 65536 UTF-16 units but over 65536 UTF-8 bytes.
    [candidate(), "€".repeat(21846), "not-sent-oversize"],
    // 65536 NULs fit the content bound but escape to 6 bytes each: the user frame exceeds 128 KiB.
    [candidate(), "\u0000".repeat(65536), "not-sent-oversize"],
  ];
  for (const [cand, text, expected] of refusals) assert.equal(mirrorPreOpen(cand, text), expected, `${expected}: ${JSON.stringify(cand)?.slice(0, 80)}`);
  // Bounds are inclusive at exactly the limits.
  assert.equal(typeof mirrorPreOpen(candidate(), "a".repeat(65536)), "object");
  assert.equal(typeof mirrorPreOpen(candidate({ Token: "A".repeat(4096) }), "a"), "object");
  assert.equal(typeof mirrorPreOpen(candidate({ Token: "A".repeat(8) }), "a"), "object");
  // The worst accepted frames stay within the per-frame cap and the finite total.
  // 65536 quotes escape to 131072 bytes of content alone: refused by the per-frame cap, like the TS sender.
  assert.equal(mirrorPreOpen(candidate(), "\"".repeat(65536)), "not-sent-oversize");
  // The user frame's fixed overhead is 107 bytes: 65482 quotes give 131071 bytes, one more exceeds the cap.
  assert.equal(mirrorPreOpen(candidate(), "\"".repeat(65483)), "not-sent-oversize");
  const worst = mirrorPreOpen(candidate({ Token: "A".repeat(4096) }), "\"".repeat(65482));
  assert.ok(typeof worst === "object" && worst.user.length === LIMITS.frameMaxBytes - 1);
  assert.ok(typeof worst === "object" && worst.user.length <= LIMITS.frameMaxBytes && worst.auth.length <= LIMITS.frameMaxBytes);
  assert.ok(worst.user.length + worst.auth.length <= LIMITS.totalMaxBytes);
  // Inputs are checked by type without coercion.
  for (const fragment of ["-isnot [Threading.CancellationToken]", "-isnot [Diagnostics.Stopwatch]", "-isnot [long]", "-isnot [hashtable]", "$qText -isnot [string]"]) {
    assert.ok(SEND.includes(fragment), fragment);
  }
  assert.doesNotMatch(SEND, /\[int\]\$qUntil|\[string\]\$qCand|-as \[|ConvertFrom-Json|ConvertTo-Json|JavaScriptSerializer|Trim\(|ToLower|ToUpper/u);
});

/* ----------------------------------------------------------- wire framing */

test("framing: the escape and frame statements are pinned and reproduce JSON.stringify for every code unit and injection", () => {
  for (const statement of ESCAPE_STATEMENTS) indexOnce(statement, SEND);
  assert.ok(USER_LITERAL && AUTH_LITERAL);
  assert.deepEqual(USER_LITERAL.slice(1), ['{"type":"user","session_id":"', '","message":{"role":"user","content":"', '"}}']);
  assert.deepEqual(AUTH_LITERAL.slice(1), ['{"type":"auth","token":"', '"}']);
  // The auth frame carries no session id; the user frame carries exactly the candidate's.
  assert.ok(!AUTH_LITERAL[0].includes("session") && !AUTH_LITERAL[0].includes("$qSid"));
  // Every BMP code unit that is not a surrogate, alone and embedded.
  for (let code = 0; code <= 0xffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = String.fromCharCode(code);
    const text = `a${ch}b${ch}`;
    assert.equal(mirrorUserFrame(SESSION_ID, text), `${JSON.stringify({ type: "user", session_id: SESSION_ID, message: { role: "user", content: text } })}\n`, `U+${code.toString(16)}`);
  }
  const samples = [
    "plain",
    "SECRET-MESSAGE-682\nsecond line é \u{1f600} \"quoted\"",
    "\u{1f511}\u{10ffff}\u{10000}",
    "\\\"\\\\\"\\n",
    "\\u0000 literal",
    '","session_id":"00000000-0000-0000-0000-000000000000","x":"',
    '"}}\n{"type":"auth","token":"forged"}\n',
    "\r\n  \u007f\u0000\u001f\u000b",
    "</script><!-- ${x} `y` $(z) @'q'@",
  ];
  for (const text of samples) {
    const frames = mirrorPreOpen(candidate(), text);
    assert.ok(typeof frames === "object", text);
    const reference = referenceFrames(SESSION_ID, TOKEN, text);
    assert.deepEqual(frames.user, reference.user);
    assert.deepEqual(frames.auth, reference.auth);
    // Each frame is exactly one line, and parsing returns the exact fields with nothing injected.
    for (const frame of [frames.auth, frames.user]) {
      const line = frame.toString("utf8");
      assert.equal(line.indexOf("\n"), line.length - 1);
      assert.ok(!line.includes("\r"));
    }
    assert.deepEqual(JSON.parse(frames.auth.toString("utf8")), { type: "auth", token: TOKEN });
    assert.deepEqual(JSON.parse(frames.user.toString("utf8")), { type: "user", session_id: SESSION_ID, message: { role: "user", content: text } });
  }
});

/** Capture the exact bytes the existing TypeScript sender writes, through its own test seams only. */
async function captureTsSender(sessionId: string, token: string, text: string): Promise<Buffer> {
  const uid = process.getuid!();
  const stat = (kind: "dir" | "socket"): BigIntStats =>
    ({
      isDirectory: () => kind === "dir",
      isSocket: () => kind === "socket",
      uid: BigInt(uid),
      dev: 7n,
      ino: kind === "socket" ? 9n : 8n,
      mode: kind === "dir" ? 0o40700n : 0o140600n,
    }) as unknown as BigIntStats;
  const chunks: Buffer[] = [];
  const created = createClaudeInboxSendCapability({
    launchId: "launch-682",
    sessionId,
    socketPath: "/r/c.sock",
    endpoint: { dev: 7n, ino: 9n, uid },
    hookToken: token,
    claudeVersion: "2.1.330",
    isCurrent: () => true,
  });
  assert.equal(created.ok, true);
  try {
    setClaudeInboxPlatformForTests("linux");
    setClaudeInboxLstatForTests(async (path) => stat(path === "/r/c.sock" ? "socket" : "dir"));
    setClaudeInboxConnectorForTests(() => {
      const duplex = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      process.nextTick(() => duplex.emit("connect"));
      return duplex;
    });
    const result = await sendClaudeInboxMessage((created as { capability: ClaudeInboxSendCapability }).capability, text, { deadlineMs: 5000 });
    assert.equal(result.disposition, "sent_unconfirmed");
  } finally {
    setClaudeInboxConnectorForTests(undefined);
    setClaudeInboxLstatForTests(undefined);
    setClaudeInboxPlatformForTests(undefined);
  }
  return Buffer.concat(chunks);
}

test("framing: the buffer equals the bytes the existing TypeScript Claude inbox sender writes", { skip: typeof process.getuid !== "function" }, async () => {
  for (const text of ["hello", "SECRET-MESSAGE-682\nsecond line é \u{1f600} \"quoted\"", '"}}\n{"type":"auth"', "\u0000\u001f\u007f ", "x".repeat(65536)]) {
    const frames = mirrorPreOpen(candidate(), text);
    assert.ok(typeof frames === "object");
    const buffer = Buffer.concat([frames.auth, frames.user]);
    assert.deepEqual(buffer, await captureTsSender(SESSION_ID, TOKEN, text));
  }
  // The buffer is allocated at exactly the two encoded frame lengths: auth then user, nothing else.
  indexOnce("if($qUtf8.GetBytes($qAuth,0,$qAuth.Length,$qBuf,0) -ne $qAuthN){return 'not-sent-unexpected'}", SEND);
  indexOnce("if($qUtf8.GetBytes($qUser,0,$qUser.Length,$qBuf,$qAuthN) -ne $qUserN){return 'not-sent-unexpected'}", SEND);
  indexOnce("$qBuf=[byte[]]::new($qLen)", SEND);
  // The only other byte arrays are the zero fills for the OVERLAPPED and for wiping the native buffer.
  assert.deepEqual([...SEND.matchAll(/\[byte\[\]\]::new\(([^)]*)\)/gu)].map((m) => m[1]), ["$qLen", "$qOvN", "$qLen"]);
});

/* --------------------------------------------------------------- the write */

/** The completion decision after the write settled, in its only order. */
const COMPLETION =
  "if($qCancel.IsCancellationRequested){return 'unknown-cancelled'}\nif($qOwn.ElapsedMilliseconds -ge $qEnd){return 'unknown-timeout'}\nif($qP -cne 'done'){return 'unknown-io'}\nif($qDone[0] -ne $qLen){return 'unknown-io'}\n$qSent.Value=$qLen\nreturn 'sent-unconfirmed'\n}catch{";

test("write: exactly one overlapped WriteFile from pinned unmanaged memory, sliced bounded waits, CancelIoEx, no retry", () => {
  assert.equal(count(SOURCE, "WriteFile"), 1);
  // No .NET stream: on .NET Framework its task completes normally after ERROR_NO_DATA/ERROR_BROKEN_PIPE.
  assert.doesNotMatch(SOURCE, /FileStream|SafeFileHandle|PipeStream|WriteAsync|Threading\.Tasks|IsCompleted|\.Wait\(/u);
  assertOrdered(
    SEND,
    "$qEvt=$qk::CreateEventW([IntPtr]::Zero,$true,$false,[IntPtr]::Zero)\nif([long]$qEvt -eq 0){return 'not-sent-event'}",
    "$qOvN=3*[IntPtr]::Size+8\n$qOv=[Runtime.InteropServices.Marshal]::AllocHGlobal($qOvN)\n[Runtime.InteropServices.Marshal]::Copy([byte[]]::new($qOvN),0,$qOv,$qOvN)\n[Runtime.InteropServices.Marshal]::WriteIntPtr($qOv,2*[IntPtr]::Size+8,$qEvt)",
    "$qMem=[Runtime.InteropServices.Marshal]::AllocHGlobal($qLen)\n[Runtime.InteropServices.Marshal]::Copy($qBuf,0,$qMem,$qLen)\n[Array]::Clear($qBuf,0,$qLen)",
    "$qStarted=$true\n$qOk=$qk::WriteFile($qPipe,$qMem,$qLen,[IntPtr]::Zero,$qOv);$qErr=[Runtime.InteropServices.Marshal]::GetLastWin32Error()\nif(-not $qOk -and $qErr -ne 997){return 'unknown-io'}",
    "$qDone=[int[]]::new(1);$qWhy='ok'\n$qP=SupInboxPoll $qk $qPipe $qOv $qDone\nwhile($qP -ceq 'pending'){\nif($qCancel.IsCancellationRequested){$qWhy='cancelled';break}\n$qLeft=$qEnd-$qOwn.ElapsedMilliseconds\nif($qLeft -le 0){$qWhy='timeout';break}\n[void]$qk::WaitForSingleObject($qEvt,[int][Math]::Min(25,$qLeft))\n$qP=SupInboxPoll $qk $qPipe $qOv $qDone}",
    "if($qWhy -cne 'ok'){\n$qCxl=$true;try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}",
    "$qGrace=[Diagnostics.Stopwatch]::StartNew()\n$qP=SupInboxPoll $qk $qPipe $qOv $qDone\nwhile($qP -ceq 'pending'){\n$qLeft=1000-$qGrace.ElapsedMilliseconds\nif($qLeft -le 0){break}\n[void]$qk::WaitForSingleObject($qEvt,[int][Math]::Min(25,$qLeft))\n$qP=SupInboxPoll $qk $qPipe $qOv $qDone}",
    "if($qP -ceq 'pending'){$qSettled=$false;return 'unknown-unsettled'}\nreturn ('unknown-'+$qWhy)}",
    COMPLETION,
  );
  // The OVERLAPPED is sized for the platform: Internal, InternalHigh (pointer-sized), two DWORDs, then hEvent.
  for (const pointer of [4, 8]) assert.equal(3 * pointer + 8, pointer === 8 ? 32 : 20);
  // State comes only from the same OVERLAPPED: pending while Internal is STATUS_PENDING or the
  // non-waiting query reports ERROR_IO_INCOMPLETE; otherwise the native result and byte count.
  assert.equal(
    functionBody("SupInboxPoll"),
    `${POLL_HEADER}\n$qDone[0]=-1\nif([long][Runtime.InteropServices.Marshal]::ReadIntPtr($qOv,0) -eq 259){return 'pending'}\n$qR=$qk::GetOverlappedResult($qPipe,$qOv,$qDone,$false);$qE=[Runtime.InteropServices.Marshal]::GetLastWin32Error()\nif($qR){return 'done'}\nif($qE -eq 996){return 'pending'}\nreturn 'failed'}\n`,
  );
  assert.ok(!SOURCE.includes("GetOverlappedResult($qPipe,$qOv,$qDone,$true)"), "never a blocking wait");
  // At most one cancellation request per invocation: the flag is set before each request and checked by the catch.
  assert.equal(count(SOURCE, "CancelIoEx"), 2);
  assert.equal(count(SEND, "$qCxl=$true;try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}"), 2);
  assert.deepEqual([...SEND.matchAll(/\$qCxl=(\$true|\$false)/gu)].map((m) => m[1]), ["$false", "$true", "$true"]);
  // No other I/O on the pipe and no unbounded wait.
  assert.doesNotMatch(SOURCE, /ReadFile|ReadAsync|\.Read\(|Flush|\.Write\(|BeginWrite|StreamWriter|CopyTo|PeekNamedPipe|TransactNamedPipe|WriteFileEx|WaitForSingleObject\(\$qEvt,-1\)|INFINITE|Sleep|Start-Sleep|CancellationToken\]::None/u);
  assert.equal(count(SOURCE, "WaitForSingleObject("), 2);
  // Loops are bounded: the 32 control escapes, and waits by the own deadline and the grace.
  assert.deepEqual(
    [...SOURCE.matchAll(/(?:while|for)\(([^{]*)\)\{/gu)].map((m) => m[1]),
    ["$qI=0;$qI -lt 32;$qI++", "$qP -ceq 'pending'", "$qP -ceq 'pending'"],
  );
  assert.doesNotMatch(SOURCE, /\bforeach\b|\bdo\s*\{|\buntil\b|\bcontinue\b|ForEach-Object|%\{/u);
  // The write is not inside any loop, and nothing after it can reach the peer-open or the write again.
  const write = SEND.indexOf("WriteFile");
  assert.ok(SEND.indexOf("for($qI=0;") < SEND.indexOf("$qPeer=SupPeerOpen"));
  assert.ok(SEND.indexOf("while(") > write);
  assert.ok(!SEND.slice(write).includes("SupPeerOpen"));
});

interface CompletionCase {
  readonly label: string;
  readonly writeOk: boolean;
  readonly writeErr: number;
  /** Poll states observed in order; the last repeats. */
  readonly polls: readonly ("pending" | "done" | "failed")[];
  readonly transferred: number;
  readonly cancelAfterPolls?: number;
  readonly expireAfterPolls?: number;
  readonly cancelledAtCompletion?: boolean;
  readonly expiredAtCompletion?: boolean;
  /** 1-based poll call that throws (an unexpected exception after the write was submitted). */
  readonly throwAtPoll?: number;
}

/**
 * JavaScript mirror of the pinned write/completion statements above (WriteFile result, the
 * pending loop, cancel+grace, and the completion decision), driven by a scripted kernel.
 */
function mirrorCompletion(c: CompletionCase, length: number): { code: string; sent: number; settled: boolean; cancels: number } {
  if (!c.writeOk && c.writeErr !== 997) return { code: "unknown-io", sent: 0, settled: true, cancels: 0 };
  let polls = 0;
  let cxl = false;
  let cancels = 0;
  const cancel = (): void => { cxl = true; cancels += 1; };
  const poll = (): string => {
    polls += 1;
    if (c.throwAtPoll === polls) throw new Error("poll");
    return c.polls[Math.min(polls - 1, c.polls.length - 1)]!;
  };
  try {
    let why = "ok";
    let p = poll();
    while (p === "pending") {
      if (c.cancelAfterPolls !== undefined && polls >= c.cancelAfterPolls) { why = "cancelled"; break; }
      if (c.expireAfterPolls !== undefined && polls >= c.expireAfterPolls) { why = "timeout"; break; }
      p = poll();
    }
    if (why !== "ok") {
      cancel();
      p = poll();
      if (p === "pending") return { code: "unknown-unsettled", sent: 0, settled: false, cancels };
      return { code: `unknown-${why}`, sent: 0, settled: true, cancels };
    }
    if (c.cancelledAtCompletion) return { code: "unknown-cancelled", sent: 0, settled: true, cancels };
    if (c.expiredAtCompletion) return { code: "unknown-timeout", sent: 0, settled: true, cancels };
    if (p !== "done") return { code: "unknown-io", sent: 0, settled: true, cancels };
    if (c.transferred !== length) return { code: "unknown-io", sent: 0, settled: true, cancels };
    return { code: "sent-unconfirmed", sent: length, settled: true, cancels };
  } catch {
    // The write was submitted: settlement is unproven, so request cancellation once if not yet requested.
    if (!cxl) cancel();
    return { code: "unknown-unexpected", sent: 0, settled: false, cancels };
  }
}

test("completion: success needs native success, the full byte count, and a live token and deadline at completion", () => {
  indexOnce(COMPLETION, SEND);
  const L = 300;
  const cases: [CompletionCase, string, number, boolean][] = [
    [{ label: "synchronous full write", writeOk: true, writeErr: 0, polls: ["done"], transferred: L }, "sent-unconfirmed", L, true],
    [{ label: "pending then full write", writeOk: false, writeErr: 997, polls: ["pending", "pending", "done"], transferred: L }, "sent-unconfirmed", L, true],
    // A closing peer: .NET Framework's FileStream would have reported this as a normal completion.
    [{ label: "ERROR_NO_DATA at the call", writeOk: false, writeErr: 232, polls: ["done"], transferred: 0 }, "unknown-io", 0, true],
    [{ label: "ERROR_BROKEN_PIPE at the call", writeOk: false, writeErr: 109, polls: ["done"], transferred: 0 }, "unknown-io", 0, true],
    [{ label: "pending then failed completion", writeOk: false, writeErr: 997, polls: ["pending", "failed"], transferred: 0 }, "unknown-io", 0, true],
    [{ label: "short byte count", writeOk: true, writeErr: 0, polls: ["done"], transferred: L - 1 }, "unknown-io", 0, true],
    [{ label: "zero bytes reported as success", writeOk: true, writeErr: 0, polls: ["done"], transferred: 0 }, "unknown-io", 0, true],
    // Completion observed only after the final slice: the deadline is rechecked before success.
    [{ label: "completed after the deadline", writeOk: false, writeErr: 997, polls: ["pending", "done"], transferred: L, expiredAtCompletion: true }, "unknown-timeout", 0, true],
    [{ label: "completed after cancellation", writeOk: false, writeErr: 997, polls: ["pending", "done"], transferred: L, cancelledAtCompletion: true }, "unknown-cancelled", 0, true],
    [{ label: "synchronous success but already expired", writeOk: true, writeErr: 0, polls: ["done"], transferred: L, expiredAtCompletion: true }, "unknown-timeout", 0, true],
    [{ label: "timeout, settles in grace", writeOk: false, writeErr: 997, polls: ["pending", "pending", "done"], transferred: L, expireAfterPolls: 2 }, "unknown-timeout", 0, true],
    [{ label: "cancel, settles in grace", writeOk: false, writeErr: 997, polls: ["pending", "failed"], transferred: 0, cancelAfterPolls: 1 }, "unknown-cancelled", 0, true],
    [{ label: "timeout, still pending after grace", writeOk: false, writeErr: 997, polls: ["pending"], transferred: 0, expireAfterPolls: 1 }, "unknown-unsettled", 0, false],
  ];
  for (const [c, code, sent, settled] of cases) {
    const result = mirrorCompletion(c, L);
    assert.deepEqual({ code: result.code, sent: result.sent, settled: result.settled }, { code, sent, settled }, c.label);
    const classified = classifyWindowsClaudeInboxWriteResult(result.code);
    assert.ok(classified && classified.settled === settled, c.label);
    assert.equal(classified.disposition === "sent_unconfirmed", sent === L, c.label);
  }
  // A pending write followed by an unexpected exception is canceled exactly once, never retried, never freed.
  for (const [c, cancels] of [
    [{ label: "pending, first poll throws", writeOk: false, writeErr: 997, polls: ["pending"], transferred: 0, throwAtPoll: 1 }, 1],
    [{ label: "pending, a later poll throws", writeOk: false, writeErr: 997, polls: ["pending"], transferred: 0, throwAtPoll: 3 }, 1],
    // The timeout path already requested cancellation; the grace poll then throws: no second request.
    [{ label: "timeout, grace poll throws", writeOk: false, writeErr: 997, polls: ["pending"], transferred: 0, expireAfterPolls: 1, throwAtPoll: 2 }, 1],
  ] as [CompletionCase, number][]) {
    assert.deepEqual(mirrorCompletion(c, L), { code: "unknown-unexpected", sent: 0, settled: false, cancels }, c.label);
    assert.deepEqual(classifyWindowsClaudeInboxWriteResult("unknown-unexpected"), { code: "unknown-unexpected", disposition: "unknown", settled: false });
  }
  // Every other case requests cancellation only on the timeout/cancel path, at most once.
  for (const [c] of cases) assert.equal(mirrorCompletion(c, L).cancels, c.cancelAfterPolls !== undefined || c.expireAfterPolls !== undefined ? 1 : 0, c.label);
  // The catch never waits, polls, restarts a grace, or writes again.
  const catchBody = SEND.slice(SEND.indexOf("}catch{try{$qSent.Value=0}"), SEND.indexOf("\nfinally{"));
  assert.doesNotMatch(catchBody, /WaitForSingleObject|SupInboxPoll|StartNew|WriteFile|GetOverlappedResult|FreeHGlobal|CloseHandle/u);
  // The counter is set only on the one success line, from the kernel-verified length.
  assert.equal(count(SEND, "$qSent.Value=$qLen"), 1);
  assert.doesNotMatch(SEND, /\$qSent\.Value=\$qDone/u);
});

/* ------------------------------------------------------------ results */

test("closed codes: every return is one closed result; not-sent only before the write, unknown only after", () => {
  const produced = new Set<string>();
  for (const body of [SEND, GUARD]) for (const m of body.matchAll(/return '([a-z-]+)'/gu)) produced.add(m[1]!);
  produced.delete("ok"); // the guard's internal success, consumed as `if($qG -cne 'ok'){return $qG}`
  for (const code of WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS) produced.add(`not-sent-${code}`);
  for (const code of WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS) produced.add(`not-sent-held-${code}`);
  for (const why of ["cancelled", "timeout"]) produced.add(`unknown-${why}`);
  // The only computed returns are the peer mapping, the held mapping, the guard result, and the settled cancel/timeout.
  assert.deepEqual([...SEND.matchAll(/return \(([^)]*)\)/gu)].map((m) => m[1]), ["'not-sent-'+$qPeer", "'unknown-'+$qWhy"]);
  assert.deepEqual([...GUARD.matchAll(/return \(([^)]*)\)/gu)].map((m) => m[1]), ["'not-sent-held-'+$qHeld"]);
  assert.equal(count(SEND, "return $qG}"), 2);
  assert.deepEqual([...SEND.matchAll(/\$qWhy='([a-z]+)'/gu)].map((m) => m[1]), ["ok", "cancelled", "timeout"]);
  const held = new Set([...functionBody("SupPeerHeld", WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE).matchAll(/return '([a-z-]+)'/gu)].map((m) => m[1]!));
  assert.deepEqual([...held].sort(), ["ok", ...WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS].sort());
  assert.deepEqual(
    [...produced].sort(),
    [...WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT, WINDOWS_CLAUDE_INBOX_WRITE_SENT, ...WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN].sort(),
  );
  // Before `$qStarted=$true` only not-sent results exist; after it, none (except the catch's own branch).
  const started = SEND.indexOf("$qStarted=$true");
  const catcher = SEND.indexOf("}catch{try{$qSent.Value=0}catch{};");
  assert.doesNotMatch(SEND.slice(0, started), /'unknown-|'sent-unconfirmed'/u);
  assert.doesNotMatch(SEND.slice(started, catcher), /'not-sent-|return \$qG/u);
  indexOnce("}catch{try{$qSent.Value=0}catch{};if($qStarted){$qSettled=$false;if(-not $qCxl){$qCxl=$true;try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}};return 'unknown-unexpected'};return 'not-sent-unexpected'}\nfinally{", SEND);
  assert.equal(count(SOURCE, "'sent-unconfirmed'"), 1);
  // Classification: dispositions and settlement are closed; anything else is undefined.
  for (const code of WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT) assert.deepEqual(classifyWindowsClaudeInboxWriteResult(code), { code, disposition: "not_sent", settled: true });
  assert.deepEqual(classifyWindowsClaudeInboxWriteResult("sent-unconfirmed"), { code: "sent-unconfirmed", disposition: "sent_unconfirmed", settled: true });
  for (const code of WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN) {
    const settled = code !== "unknown-unsettled" && code !== "unknown-unexpected";
    assert.deepEqual(classifyWindowsClaudeInboxWriteResult(code), { code, disposition: "unknown", settled });
  }
  assert.ok(Object.isFrozen(classifyWindowsClaudeInboxWriteResult("unknown-io")));
  for (const other of [undefined, null, 0, "", "ok", "sent", "delivered", "sent_unconfirmed", "not-sent-", "not-sent-peer-ok", "not-sent-held-ok", "unknown-", "unknown-ok", "peer-open", "candidate", "SENT-UNCONFIRMED", "sent-unconfirmed\n", {}]) {
    assert.equal(classifyWindowsClaudeInboxWriteResult(other), undefined, JSON.stringify(other));
  }
});

test("output: only closed codes and a byte counter leave the function; nothing reflects the token, content, or endpoint", () => {
  assert.equal(count(SOURCE, "$qSent.Value="), 3);
  assert.equal(count(SEND, "$qSent.Value=0"), 2, "zeroed first and again in the catch");
  indexOnce("$qSent.Value=$qLen\nreturn 'sent-unconfirmed'", SEND);
  // Every return is a literal code, a closed composition, or the guard code; no variable holding input is returned.
  for (const m of SOURCE.matchAll(/return ([^}\n;]+)/gu)) {
    assert.match(m[1]!, /^(?:'[a-z-]+'|\('(?:not-sent-|not-sent-held-|unknown-)'\+\$q(?:Peer|Held|Why)\)|\$qG)$/u, m[1]!);
  }
  // No stdout/stderr/host/env/argv/file/process channel, no failure path of the host, no exceptions out.
  assert.doesNotMatch(
    SOURCE,
    /Console|Write-|Out-|SupOut|SupDiag|SupReply|SupSend\b|SupFail|SupBootFail|\$env:|Environment|Set-Content|Add-Content|New-Item|\[IO\.File\]|Start-Process|Process\]::Start|Invoke-Expression|\biex\b|ScriptBlock|Add-Type|Reflection|\bexit\b|\bthrow\b|\btrap\b|Export-|Tee-|Register-|Net\.Sockets|TcpClient|UdpClient|Http|WebClient|Dns|Base64|Convert\]::/iu,
  );
});

test("release: pipe, event, OVERLAPPED, and native buffer are released once only when settled, retained otherwise", () => {
  assert.equal(count(SOURCE, "CloseHandle"), 2);
  assert.equal(count(SOURCE, "CloseHandle($qPipe)"), 1);
  assert.equal(count(SOURCE, "CloseHandle($qEvt)"), 1);
  const FINALLY = [
    "finally{",
    "if($null -ne $qBuf){try{[Array]::Clear($qBuf,0,$qBuf.Length)}catch{}}",
    "if($qSettled){",
    "if([long]$qPipe -ne 0 -and [long]$qPipe -ne -1){try{[void]$qk::CloseHandle($qPipe)}catch{}}",
    "if([long]$qEvt -ne 0){try{[void]$qk::CloseHandle($qEvt)}catch{}}",
    "if([long]$qMem -ne 0){try{[Runtime.InteropServices.Marshal]::Copy([byte[]]::new($qLen),0,$qMem,$qLen)}catch{};try{[Runtime.InteropServices.Marshal]::FreeHGlobal($qMem)}catch{}}",
    "if([long]$qOv -ne 0){try{[Runtime.InteropServices.Marshal]::FreeHGlobal($qOv)}catch{}}}",
    "$qTok=$null;$qAuth=$null;$qUser=$null;$qEsc=$null}}",
  ].join("\n");
  assert.ok(SEND.endsWith(FINALLY), "the finally is the function's last block");
  // One protected block wraps everything after the pre-assignments, so the finally never reads an unset name.
  assert.equal(count(SEND, "\ntry{\n"), 1);
  // Native memory is allocated once each, and freed only inside the settled branch.
  assert.equal(count(SOURCE, "AllocHGlobal("), 2);
  assert.equal(count(SOURCE, "FreeHGlobal("), 2);
  // Every handle close and every free sits inside the settled branch; only the managed copy is cleared outside it.
  const settledAt = FINALLY.indexOf("if($qSettled){");
  for (const release of ["CloseHandle($qPipe)", "CloseHandle($qEvt)", "FreeHGlobal($qMem)", "FreeHGlobal($qOv)", "Copy([byte[]]::new($qLen),0,$qMem,$qLen)"]) {
    assert.ok(FINALLY.indexOf(release) > settledAt, `${release} only when settled`);
  }
  assert.equal(count(SOURCE, "CloseHandle("), 2, "no other close anywhere, so an unsettled write keeps both handles");
  // The managed copy never reaches the kernel: it is cleared right after the native copy and again in finally.
  assert.equal(count(SEND, "[Array]::Clear($qBuf,"), 2);
  // Handles and memory are assigned only by their zero initialization and their single creation.
  assert.equal([...SEND.matchAll(/\$qEvt=/gu)].length, 2);
  assert.equal([...SEND.matchAll(/\$qMem=/gu)].length, 2);
  assert.equal([...SEND.matchAll(/\$qOv=/gu)].length, 2);
  // Settlement is lost only for a write still pending after the grace, or an exception after the write was invoked.
  assert.equal(count(SEND, "$qSettled=$false"), 2);
  assert.ok(SEND.includes("if($qP -ceq 'pending'){$qSettled=$false;return 'unknown-unsettled'}"));
  assert.ok(SEND.includes("if($qStarted){$qSettled=$false;if(-not $qCxl){$qCxl=$true;try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}};return 'unknown-unexpected'}"));
  assert.equal(count(SEND, "$qStarted=$true"), 1);
  assert.doesNotMatch(SOURCE, /\.Dispose\(\)|DangerousGetHandle|SetHandleAsInvalid/u);
});

/* ------------------------------------------------------ host contract */

test("host contract: documented against the existing supervisor and landed helpers, interop surface exact, not wired", () => {
  const sup = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE;
  const contract = WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT;
  assert.ok(Object.isFrozen(contract));
  assert.equal(contract.interopType, "$K");
  assert.equal(contract.interopType, WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.interopType);
  for (const name of contract.existingInterop) assert.ok(sup.includes(`SupDef '${name}' `), `${name} already declared`);
  // Each landed-contract declaration is already required, verbatim, by a landed helper contract.
  const landed = new Set<string>([
    ...WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.additionalInteropDeclarations,
    ...WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT.additionalInteropDeclarations,
  ]);
  const declared: string[] = [];
  for (const declaration of contract.landedContractInteropDeclarations) {
    assert.ok(landed.has(declaration), `${declaration} matches a landed contract`);
    const name = /^SupDef '([A-Za-z]+)'/u.exec(declaration)![1]!;
    assert.ok(!sup.includes(`SupDef '${name}'`), `${name} is not declared in the supervisor yet`);
    declared.push(name);
  }
  for (const declaration of contract.newInteropDeclarations) {
    assert.match(declaration, /^SupDef '[A-Za-z]+' \$T[IFN] @\((?:\$T[IAFN])(?:,(?:\$T[IAFN]))*\)$/u);
    const name = /^SupDef '([A-Za-z]+)'/u.exec(declaration)![1]!;
    assert.ok(!sup.includes(`SupDef '${name}'`), `${name} is not declared in the supervisor yet`);
    assert.ok(![...landed].some((d) => d.includes(`'${name}'`)), `${name} is new to this source`);
    declared.push(name);
  }
  assert.deepEqual([...contract.newInteropDeclarations], [
    "SupDef 'CreateEventW' $TI @($TI,$TF,$TF,$TI)",
    "SupDef 'WriteFile' $TF @($TI,$TI,$TN,$TI,$TI)",
    "SupDef 'GetOverlappedResult' $TF @($TI,$TI,$TA,$TF)",
  ]);
  assert.equal(contract.lastError, "supdef-setlasterror-read-immediately-after-call");
  assert.ok(sup.includes("[object[]]@($true,$name,[Runtime.InteropServices.CharSet]::Unicode)"), "SupDef sets SetLastError=true");
  // Each last-error read sits on the same line as its call.
  for (const call of ["$qk::WriteFile(", "$qk::GetOverlappedResult("]) {
    const line = SOURCE.split("\n").find((l) => l.includes(call))!;
    assert.ok(line.endsWith("=[Runtime.InteropServices.Marshal]::GetLastWin32Error()"), call);
  }
  const called = new Set([...SOURCE.matchAll(/\$qk::([A-Za-z0-9]+)\(/gu)].map((m) => m[1]!));
  assert.deepEqual([...called].sort(), [...contract.existingInterop, ...declared].sort());
  // Static .NET use is limited to this fixed allowlist.
  const statics = new Set([...SOURCE.matchAll(/\[([A-Za-z0-9.]+(?:\[\])?)\]::([A-Za-z0-9]+)/gu)].map((m) => `[${m[1]}]::${m[2]}`));
  assert.deepEqual([...statics].sort(), [
    "[Array]::Clear",
    "[Diagnostics.Stopwatch]::StartNew",
    "[IntPtr]::Size",
    "[IntPtr]::Zero",
    "[Math]::Min",
    "[Runtime.InteropServices.Marshal]::AllocHGlobal",
    "[Runtime.InteropServices.Marshal]::Copy",
    "[Runtime.InteropServices.Marshal]::FreeHGlobal",
    "[Runtime.InteropServices.Marshal]::GetLastWin32Error",
    "[Runtime.InteropServices.Marshal]::ReadIntPtr",
    "[Runtime.InteropServices.Marshal]::WriteIntPtr",
    "[StringComparison]::Ordinal",
    "[Text.UTF8Encoding]::new",
    "[byte[]]::new",
    "[int[]]::new",
  ]);
  assert.equal(contract.composedSource, "WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE");
  // Argument mapping matches the entry header and the supervisor's custody state.
  const header = /^function SupInboxSend\(([^)]*)\)\{/mu.exec(SOURCE)![1]!;
  assert.deepEqual(contract.arguments.map((a) => a.parameter), header.split(",").map((p) => p.replace(/^\[[A-Za-z.]+\]/u, "")));
  assert.deepEqual(contract.arguments.slice(0, 4).map((a) => a.source), ["$K", ...WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.arguments.slice(1, 4).map((a) => a.source)]);
  assert.ok(sup.includes("$script:CH=$childH;$script:ChildPid=[int]$claimed"), "set only by SupChild");
  assert.ok(sup.includes("$script:Job=$ProvJob;"), "set only by a matching CONFIRM");
  assert.equal(contract.phase, "run");
  assert.equal(contract.pipeHandle, "opened-owned-inside-closed-once-when-settled-retained-when-unsettled");
  assert.equal(contract.admission, "caller-admits-once-and-calls-at-most-once");
  assert.equal(contract.unsettled, "buffer-overlapped-event-and-pipe-retained-caller-poisons-and-never-reuses");
  assert.equal(contract.deadline, "entry-budget-snapshot-on-own-stopwatch");
  // The authorized native transport is pinned: same-handle native evidence, never framework task completion.
  assert.equal(contract.transport, "authorized-native-overlapped-writefile-same-handle-native-completion-evidence");
  const moduleDoc = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(moduleDoc.includes("## Transport (authorized native overlapped write)"));
  assert.ok(moduleDoc.includes("framework task completion is NEVER used as proof of a write"));
  assert.equal(contract.maxBlockingMs, LIMITS.budgetMaxMs + LIMITS.cancelGraceMs);
  // The supervisor has no inbox write today; nothing here adds one.
  assert.doesNotMatch(sup, /SupInbox|"type":"auth"|GetOverlappedResult|CreateEventW/u);
  // The fixed source could later travel in the existing startup frame alongside the landed helpers.
  assert.ok(sup.length + 1 + WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE.length + 1 + WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE.length + 1 + SOURCE.length <= WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
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
  assert.deepEqual(Object.keys(writeModule).sort(), [
    "WINDOWS_CLAUDE_INBOX_WRITE_CANDIDATE_KEYS",
    "WINDOWS_CLAUDE_INBOX_WRITE_COMPOSED_FUNCTIONS",
    "WINDOWS_CLAUDE_INBOX_WRITE_FUNCTION",
    "WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS",
    "WINDOWS_CLAUDE_INBOX_WRITE_HELPER_FUNCTIONS",
    "WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT",
    "WINDOWS_CLAUDE_INBOX_WRITE_LIMITS",
    "WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT",
    "WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS",
    "WINDOWS_CLAUDE_INBOX_WRITE_SENT",
    "WINDOWS_CLAUDE_INBOX_WRITE_SOURCE",
    "WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN",
    "WINDOWS_CLAUDE_INBOX_WRITE_WIN32",
    "classifyWindowsClaudeInboxWriteResult",
  ]);
  const functions = Object.entries(writeModule).filter(([, value]) => typeof value === "function").map(([name]) => name);
  assert.deepEqual(functions, ["classifyWindowsClaudeInboxWriteResult"]);
  const moduleText = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(moduleText.endsWith("\n") && !moduleText.endsWith("\n\n"));
  assert.doesNotMatch(moduleText, /^\s*import\b|\brequire\(|\bimport\(/mu, "no imports at all");
  assert.doesNotMatch(moduleText, /child_process|node:net|node:fs|process\.|console\.|\bspawn\(|(?<![.\w])exec\(|\bfetch\(|new Function|\beval\(/u);
  // It names no sibling module and none of the hook receiver's fixed functions, so their own
  // no-caller checks stay meaningful; it only composes (calls) the two landed peer functions.
  for (const sibling of ["native-windows-claude-hook-forwarder", "native-windows-claude-hook-receiver", "native-windows-claude-inbox-peer", "native-claude-inbox-delivery"]) {
    assert.ok(!moduleText.includes(sibling), sibling);
  }
  assert.doesNotMatch(moduleText, /SupHook(?:Serve|Held|Guard|Xfer)|forwardWindowsClaudeHookRecordOnce|sendClaudeInboxMessage/u);
  // No product source imports or names this module, except the custody renderer's opt-in hook
  // CONTROL mode, which composes the fixed source verbatim, calls only the entry function, and
  // never redefines it; the default and candidate-only hook supervisor templates stay writer-free.
  for (const file of listTs(join(PROJECT_ROOT, "src"))) {
    if (file === MODULE_SOURCE_PATH) continue;
    const text = readFileSync(file, "utf8");
    if (file === OPT_IN_CONTROL_COMPOSER_PATH) {
      assert.doesNotMatch(text, /function SupInbox(?:Send|Guard|Poll)\b/u, "the composer never redefines the fixed functions");
      assert.doesNotMatch(text, /SupInbox(?:Guard|Poll)/u, "the composer calls only the entry function");
      assert.ok(!WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.includes("SupInbox"), "the default template stays writer-free");
      assert.ok(!WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE.includes("SupInbox"), "the candidate-only hook template stays writer-free");
      continue;
    }
    assert.ok(!text.includes("native-windows-claude-inbox-write"), `${file} must not import the inactive module`);
    assert.ok(!/SupInbox(?:Send|Guard)/u.test(text), `${file} must not wire the fixed function`);
  }
});
