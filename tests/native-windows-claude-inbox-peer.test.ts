/**
 * Native Windows Claude inbox LOCAL pipe ownership primitives (#682), portable tests.
 *
 * The module is pure and inactive. These tests pin the exact endpoint grammar
 * (no normalization, true end-of-string), the fixed PowerShell 5.1 peer-open
 * function's grammar, proof ordering, single release, and closed result codes,
 * the absence of any payload/write/network operation, the inactive export
 * surface, and the documented host contract against the existing custody
 * supervisor primitives. Nothing is spawned and nothing touches the
 * filesystem except reading this repository's own source files. This is NOT
 * Windows evidence: the inert identity / zero-byte runtime observation of the
 * function remains a later Windows test.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import * as peerModule from "../src/session-host/native-windows-claude-inbox-peer";
import {
  WINDOWS_CLAUDE_INBOX_ENDPOINT_REFUSALS,
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX,
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN,
  WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX,
  WINDOWS_CLAUDE_INBOX_PEER_DESIRED_ACCESS,
  WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS,
  WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION,
  WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_FLAGS,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE,
  WINDOWS_CLAUDE_INBOX_PEER_WIN32,
  classifyWindowsClaudeInboxPeerOpenResult,
  parseWindowsClaudeInboxLocalEndpoint,
  type WindowsClaudeInboxEndpointRefusal,
  type WindowsClaudeInboxEndpointResult,
  type WindowsClaudeInboxLocalEndpoint,
  type WindowsClaudeInboxPeerOpenRefusal,
  type WindowsClaudeInboxPeerOpenResult,
} from "../src/session-host/native-windows-claude-inbox-peer";
import {
  WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE,
} from "../src/session-host/native-windows-claude-custody-scripts";

const PROJECT_ROOT = join(__dirname, "..", "..");
const MODULE_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-inbox-peer.ts");
/** The inactive inbox write source that composes the fixed functions (see the inactive test). */
const INACTIVE_COMPOSER_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-inbox-write.ts");
const SOURCE = WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE;
const P = WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX;

/* ------------------------------------------------------------ type checks */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const refusalUnionIsClosed: Equal<
  WindowsClaudeInboxPeerOpenRefusal,
  | "peer-endpoint"
  | "peer-pre-child-handle"
  | "peer-pre-child-pid"
  | "peer-pre-job-handle"
  | "peer-pre-child-not-live"
  | "peer-pre-child-not-in-job"
  | "peer-open"
  | "peer-inherit"
  | "peer-server-pid"
  | "peer-server-mismatch"
  | "peer-post-child-handle"
  | "peer-post-child-pid"
  | "peer-post-job-handle"
  | "peer-post-child-not-live"
  | "peer-post-child-not-in-job"
  | "peer-unexpected"
> = true;
const resultUnionIsOkPlusRefusals: Equal<WindowsClaudeInboxPeerOpenResult, "ok" | WindowsClaudeInboxPeerOpenRefusal> = true;
const endpointRefusalUnionIsClosed: Equal<
  WindowsClaudeInboxEndpointRefusal,
  "endpoint-type" | "endpoint-control" | "endpoint-grammar" | "endpoint-dot"
> = true;
// @ts-expect-error a plain string is never a validated endpoint
const unvalidatedEndpoint: WindowsClaudeInboxLocalEndpoint = `${P}claude-1`;
function endpointOf(result: WindowsClaudeInboxEndpointResult): WindowsClaudeInboxLocalEndpoint | undefined {
  // @ts-expect-error a refusal carries no endpoint until narrowed
  const unnarrowed: WindowsClaudeInboxLocalEndpoint = result.endpoint;
  void unnarrowed;
  return result.ok ? result.endpoint : undefined;
}

test("type contract: closed refusal unions and a branded endpoint only from the parser", () => {
  assert.equal(refusalUnionIsClosed, true);
  assert.equal(resultUnionIsOkPlusRefusals, true);
  assert.equal(endpointRefusalUnionIsClosed, true);
  assert.equal(typeof unvalidatedEndpoint, "string");
  const parsed = parseWindowsClaudeInboxLocalEndpoint(`${P}claude-1`);
  assert.equal(endpointOf(parsed), `${P}claude-1`);
  assert.equal(endpointOf(parseWindowsClaudeInboxLocalEndpoint("nope")), undefined);
});

/* --------------------------------------------------------------- endpoint */

const ACCEPTED: readonly string[] = [
  `${P}claude-abc_1.2`,
  `${P}a`,
  `${P}-`,
  `${P}_`,
  `${P}a.b`,
  `${P}.a`,
  `${P}...a`,
  `${P}0123456789ABCDEFabcdef`,
  `${P}${"x".repeat(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX)}`,
];

const REFUSED: readonly (readonly [unknown, WindowsClaudeInboxEndpointRefusal])[] = [
  [undefined, "endpoint-type"],
  [null, "endpoint-type"],
  [42, "endpoint-type"],
  [new String(`${P}a`), "endpoint-type"],
  [[`${P}a`], "endpoint-type"],
  // Final newline and every other control byte, anywhere: never trimmed.
  [`${P}a\n`, "endpoint-control"],
  [`${P}a\r\n`, "endpoint-control"],
  [`${P}a\r`, "endpoint-control"],
  [`${P}a\u0000`, "endpoint-control"],
  [`${P}a\u0000b`, "endpoint-control"],
  [`${P}a\tb`, "endpoint-control"],
  [`${P}a\u007f`, "endpoint-control"],
  [`${P}a\u001b`, "endpoint-control"],
  [`\n${P}a`, "endpoint-control"],
  // Prefix only / empty / over-long segment.
  ["", "endpoint-grammar"],
  [P, "endpoint-grammar"],
  [`${P}${"x".repeat(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX + 1)}`, "endpoint-grammar"],
  // Case-exact: no lowercasing or uppercasing of `pipe` or `LOCAL`.
  ["\\\\.\\pipe\\local\\a", "endpoint-grammar"],
  ["\\\\.\\pipe\\Local\\a", "endpoint-grammar"],
  ["\\\\.\\PIPE\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\.\\Pipe\\LOCAL\\a", "endpoint-grammar"],
  // Other namespaces and spellings: refused, never repaired.
  ["\\\\.\\pipe\\a", "endpoint-grammar"],
  ["\\\\.\\pipe\\claude-abc_1.2", "endpoint-grammar"],
  ["\\\\.\\pipe\\Global\\a", "endpoint-grammar"],
  ["\\\\.\\pipe\\Session\\1\\a", "endpoint-grammar"],
  ["\\\\.\\pipe\\LOCAL\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\?\\pipe\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\server\\pipe\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\localhost\\pipe\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\\\.\\pipe\\LOCAL\\a", "endpoint-grammar"],
  ["\\.\\pipe\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\.\\pipe\\\\LOCAL\\a", "endpoint-grammar"],
  ["\\\\.\\pipe\\LOCAL\\\\a", "endpoint-grammar"],
  ["//./pipe/LOCAL/a", "endpoint-grammar"],
  ["\\\\./pipe/LOCAL/a", "endpoint-grammar"],
  ["\\\\.\\pipe\\LOCAL/a", "endpoint-grammar"],
  ["\\\\.\\GLOBALROOT\\Device\\NamedPipe\\LOCAL\\a", "endpoint-grammar"],
  ["/tmp/cc-socks/1.sock", "endpoint-grammar"],
  ["LOCAL\\a", "endpoint-grammar"],
  ["a", "endpoint-grammar"],
  // More than one segment.
  [`${P}a\\b`, "endpoint-grammar"],
  [`${P}a/b`, "endpoint-grammar"],
  [`${P}a\\`, "endpoint-grammar"],
  [`${P}..\\a`, "endpoint-grammar"],
  // No trimming of spaces, no unquoting.
  [` ${P}a`, "endpoint-grammar"],
  [`${P}a `, "endpoint-grammar"],
  [`${P} a`, "endpoint-grammar"],
  [`"${P}a"`, "endpoint-grammar"],
  [`'${P}a'`, "endpoint-grammar"],
  [`${P}a"`, "endpoint-grammar"],
  [`${P}a'`, "endpoint-grammar"],
  // Characters outside the bounded ASCII class.
  [`${P}a:b`, "endpoint-grammar"],
  [`${P}a*`, "endpoint-grammar"],
  [`${P}a?`, "endpoint-grammar"],
  [`${P}a+b`, "endpoint-grammar"],
  [`${P}a%20`, "endpoint-grammar"],
  [`${P}é`, "endpoint-grammar"],
  [`${P}ａ`, "endpoint-grammar"],
  [`${P}a `, "endpoint-grammar"],
  [`${P}a​`, "endpoint-grammar"],
  [`${P}a `, "endpoint-grammar"],
  [`${P}😀`, "endpoint-grammar"],
  [`${P}\ud800`, "endpoint-grammar"],
  ["\\\\.\\pipe\\KOCAL\\a", "endpoint-grammar"],
  // Reserved dot segments and a trailing dot.
  [`${P}.`, "endpoint-dot"],
  [`${P}..`, "endpoint-dot"],
  [`${P}a.`, "endpoint-dot"],
  [`${P}a..`, "endpoint-dot"],
  [`${P}...`, "endpoint-dot"],
  [`${P}${"x".repeat(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX - 1)}.`, "endpoint-dot"],
];

test("endpoint: the exact case-exact LOCAL shape is accepted and returned as the same string", () => {
  assert.equal(P, "\\\\.\\pipe\\LOCAL\\");
  assert.equal(P.length, 15);
  for (const value of ACCEPTED) {
    const result = parseWindowsClaudeInboxLocalEndpoint(value);
    assert.equal(result.ok, true, JSON.stringify(value));
    assert.ok(result.ok);
    assert.equal(result.endpoint, value);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result).sort(), ["endpoint", "ok"]);
  }
});

test("endpoint: foreign namespaces, alternate spellings, dot segments, controls and final newlines are refused", () => {
  for (const [value, refusal] of REFUSED) {
    const result = parseWindowsClaudeInboxLocalEndpoint(value);
    assert.deepEqual(result, { ok: false, refusal }, JSON.stringify(String(value)));
    assert.ok(Object.isFrozen(result));
    // A refusal never echoes the input.
    assert.deepEqual(Object.keys(result).sort(), ["ok", "refusal"]);
  }
  assert.deepEqual(
    [...new Set(REFUSED.map(([, refusal]) => refusal))].sort(),
    [...WINDOWS_CLAUDE_INBOX_ENDPOINT_REFUSALS].sort(),
    "every closed endpoint refusal is exercised",
  );
});

test("endpoint: every control byte is refused at every position", () => {
  for (let code = 0; code <= 0x1f; code += 1) {
    const ch = String.fromCharCode(code);
    for (const value of [`${ch}${P}a`, `${P}${ch}a`, `${P}a${ch}`, `${P}a${ch}b`]) {
      assert.deepEqual(parseWindowsClaudeInboxLocalEndpoint(value), { ok: false, refusal: "endpoint-control" });
    }
  }
  assert.deepEqual(parseWindowsClaudeInboxLocalEndpoint(`${P}a\u007f`), { ok: false, refusal: "endpoint-control" });
});

test("endpoint: the parser owns its matcher; reconfiguring RegExp or the exported constants cannot widen it", () => {
  const regexpProto = RegExp.prototype as unknown as Record<string, unknown>;
  const saved = {
    exec: RegExp.prototype.exec,
    test: RegExp.prototype.test,
    match: regexpProto[Symbol.match as unknown as string],
  };
  const exportsObject = peerModule as unknown as Record<string, unknown>;
  const savedPrefix = exportsObject.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX;
  const savedMax = exportsObject.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX;
  let exportsMutable = true;
  try {
    // A hostile consumer makes every regex "match".
    RegExp.prototype.exec = function exec(this: RegExp, input: string): RegExpExecArray {
      return Object.assign([input, input], { index: 0, input, groups: undefined }) as unknown as RegExpExecArray;
    };
    RegExp.prototype.test = () => true;
    try {
      exportsObject.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX = "\\\\.\\pipe\\";
      exportsObject.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX = 100_000;
    } catch {
      exportsMutable = false;
    }
    for (const [value, refusal] of REFUSED) {
      assert.deepEqual(parseWindowsClaudeInboxLocalEndpoint(value), { ok: false, refusal }, JSON.stringify(String(value)));
    }
    for (const value of ACCEPTED) assert.equal(parseWindowsClaudeInboxLocalEndpoint(value).ok, true);
  } finally {
    RegExp.prototype.exec = saved.exec;
    RegExp.prototype.test = saved.test;
    if (exportsMutable) {
      exportsObject.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX = savedPrefix;
      exportsObject.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX = savedMax;
    }
  }
  assert.equal(RegExp.prototype.exec, saved.exec);
  assert.equal(regexpProto[Symbol.match as unknown as string], saved.match);
  assert.equal(peerModule.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX, P);
  assert.equal(peerModule.WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX, 200);
  // The parser body itself contains no RegExp and reads no exported value.
  const moduleText = readFileSync(MODULE_SOURCE_PATH, "utf8");
  const parserStart = moduleText.indexOf("export function parseWindowsClaudeInboxLocalEndpoint(");
  const parserText = moduleText.slice(parserStart, moduleText.indexOf("\n}\n", parserStart));
  assert.ok(parserStart > 0);
  assert.doesNotMatch(parserText, /RegExp|\/[^/\n*]+\/[a-z]*\.(?:test|exec)|\.match\(|WINDOWS_CLAUDE_INBOX_/u);
});

test("endpoint: the .NET pattern is the same grammar anchored with \\z, and the fixed function uses it case-sensitively", () => {
  assert.ok(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN.endsWith("\\z"));
  assert.ok(!WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN.includes("$"), ".NET `$` also matches before a final LF");
  assert.equal(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN, String.raw`^\\\\\.\\pipe\\LOCAL\\[A-Za-z0-9._-]{1,200}\z`);
  // Portable emulation of `\z` (true end of input) for the shared ASCII subset.
  const emulated = new RegExp(WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN.replace(/\\z$/u, "(?![\\s\\S])"));
  for (const value of [...ACCEPTED, ...REFUSED.map(([v]) => v).filter((v): v is string => typeof v === "string")]) {
    // The fixed function's endpoint gate is the .NET pattern plus the trailing-dot rule.
    const psAccepts = emulated.test(value) && !value.endsWith(".");
    assert.equal(psAccepts, parseWindowsClaudeInboxLocalEndpoint(value).ok, JSON.stringify(value));
  }
  // Exactly one grammar check, case-sensitive, single-quoted, never `-match`/`-like`.
  assert.equal(count(SOURCE, `-cnotmatch '${WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN}'`), 1);
  assert.doesNotMatch(SOURCE, /-(?:i?not)?(?:match|like)\b|-imatch|-clike|-ilike/u);
  // The dot rule mirrors the TypeScript parser, with an ordinal comparison.
  assert.equal(count(SOURCE, `$pSeg=$pEndpoint.Substring(${P.length})`), 1);
  assert.equal(
    count(SOURCE, "if($pSeg -ceq '.' -or $pSeg -ceq '..' -or $pSeg.EndsWith('.',[StringComparison]::Ordinal)){return 'peer-endpoint'}"),
    1,
  );
});

/* ------------------------------------------------- fixed helper grammar */

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

function indexOnce(needle: string): number {
  assert.equal(count(SOURCE, needle), 1, `exactly one occurrence of ${needle}`);
  return SOURCE.indexOf(needle);
}

function assertOrdered(...needles: string[]): void {
  const at = needles.map(indexOnce);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i - 1]! < at[i]!, `${needles[i - 1]} before ${needles[i]}`);
}

const HELD_HEADER = "function SupPeerHeld([Type]$pk,[IntPtr]$pChild,[int]$pChildPid,[IntPtr]$pJob){";
const OPEN_HEADER =
  "function SupPeerOpen([Type]$pk,[IntPtr]$pChild,[int]$pChildPid,[IntPtr]$pJob,[object]$pEndpoint,[ref]$pOut){";
const CREATE_CALL = "$pk::CreateFileW($pEndpoint,0x40000080,0,[IntPtr]::Zero,3,0x40110000,[IntPtr]::Zero)";

test("helper grammar: a fixed, placeholder-free PS5.1 source defining exactly two functions and nothing else", () => {
  assert.equal(WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION, "SupPeerOpen");
  assert.equal(WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION, "SupPeerHeld");
  assert.match(SOURCE, /^[\x20-\x7e\n]+$/u, "printable ASCII and LF only");
  assert.doesNotMatch(SOURCE, /__[A-Z0-9_]+__/u, "no render placeholders");
  assert.doesNotMatch(SOURCE, /`|\$\{|@'|@"/u, "no backticks, ${...}, or here-strings");
  assert.ok(SOURCE.startsWith(HELD_HEADER));
  assert.equal(indexOnce(OPEN_HEADER) > indexOnce(HELD_HEADER), true);
  assert.equal(count(SOURCE, "function "), 2);
  // Braces and parentheses balance, and depth returns to zero only at the two function ends:
  // nothing runs at top level when the source is dot-sourced.
  let depth = 0;
  let paren = 0;
  const closes: number[] = [];
  let inQuote = false;
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
  assert.equal(closes.length, 2);
  assert.equal(closes[1], SOURCE.length - 1);
  assert.equal(SOURCE[closes[0]! + 1], "\n");
  assert.ok(SOURCE.slice(closes[0]! + 2).startsWith(OPEN_HEADER));
});

test("helper grammar: parameter names never collide with supervisor script variables or automatic variables", () => {
  const constants = new Set(["true", "false", "null"]);
  const params = [...SOURCE.matchAll(/\$([A-Za-z][A-Za-z0-9]*)/gu)].map((m) => m[1]!.toLowerCase()).filter((n) => !constants.has(n));
  assert.deepEqual(
    [...new Set([...SOURCE.matchAll(/\$([A-Za-z][A-Za-z0-9]*)/gu)].map((m) => m[1]!.toLowerCase()).filter((n) => constants.has(n)))].sort(),
    ["false", "true"],
    "only the $false/$true constants (for $pHanded) are used",
  );
  const supervisorVars = new Set(
    [...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.matchAll(/\$(?:script:)?([A-Za-z][A-Za-z0-9]*)/gu)].map((m) =>
      m[1]!.toLowerCase(),
    ),
  );
  const automatic = new Set(["pid", "input", "args", "matches", "error", "host", "this", "_", "home", "true", "false", "null"]);
  for (const name of new Set(params)) {
    assert.ok(name.startsWith("p"), `${name} uses the reserved p-prefix`);
    assert.ok(!supervisorVars.has(name), `${name} is distinct from the supervisor's variables`);
    assert.ok(!automatic.has(name), `${name} is not an automatic variable`);
  }
  for (const fn of ["SupPeerHeld", "SupPeerOpen"]) {
    assert.ok(!WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE.toLowerCase().includes(fn.toLowerCase()), `${fn} is not wired`);
  }
});

test("helper grammar: one non-inheritable, identification-SQOS, async CreateFileW with the documented minimal access", () => {
  const w = WINDOWS_CLAUDE_INBOX_PEER_WIN32;
  assert.equal(w.GENERIC_WRITE, 0x40000000);
  assert.equal(w.FILE_READ_ATTRIBUTES, 0x80);
  assert.equal(w.OPEN_EXISTING, 3);
  assert.equal(w.FILE_FLAG_OVERLAPPED, 0x40000000);
  assert.equal(w.SECURITY_SQOS_PRESENT, 0x00100000);
  assert.equal(w.SECURITY_IDENTIFICATION, 1 << 16);
  assert.equal(w.WAIT_TIMEOUT, 258);
  assert.equal(w.HANDLE_FLAG_INHERIT, 1);
  assert.equal(WINDOWS_CLAUDE_INBOX_PEER_DESIRED_ACCESS, 0x40000080);
  assert.equal(WINDOWS_CLAUDE_INBOX_PEER_OPEN_FLAGS, 0x40110000);
  assert.equal(count(SOURCE, "CreateFileW"), 1, "exactly one open, no retry");
  indexOnce(CREATE_CALL);
  assert.ok(CREATE_CALL.includes(`0x${WINDOWS_CLAUDE_INBOX_PEER_DESIRED_ACCESS.toString(16)}`));
  assert.ok(CREATE_CALL.includes(`0x${WINDOWS_CLAUDE_INBOX_PEER_OPEN_FLAGS.toString(16)}`));
  // Hex literals stay below 0x80000000, so PowerShell types them as positive Int32 arguments.
  assert.ok(WINDOWS_CLAUDE_INBOX_PEER_DESIRED_ACCESS < 0x80000000 && WINDOWS_CLAUDE_INBOX_PEER_OPEN_FLAGS < 0x80000000);
  // No GENERIC_READ, no GENERIC_ALL, no share mode, no wait or loop.
  assert.doesNotMatch(SOURCE, /0x80000000|0x10000000|0x1f01ff|WaitNamedPipe|Sleep|\bfor\s*\(|\bforeach\b|\bwhile\b|\bdo\s*\{|\buntil\b/iu);
  assert.equal(count(SOURCE, "WaitForSingleObject($pChild,0) -ne 258"), 1, "liveness is a zero-timeout probe, never a wait");
  assert.equal(indexOnce("if(-not ($pk::GetHandleInformation($pPipe,$pInfo) -and ($pInfo[0] -band 1) -eq 0)){$pCode='peer-inherit'}") > 0, true);
});

test("proof ordering: endpoint, retained child pre-check, single open, kernel server PID, recheck, then the SAME handle", () => {
  assertOrdered(
    "try{$pOut.Value=[IntPtr]::Zero}catch{return 'peer-unexpected'}",
    "if($pEndpoint -isnot [string]){return 'peer-endpoint'}",
    "-cnotmatch",
    "$pSeg=$pEndpoint.Substring(15)",
    "try{$pPre=SupPeerHeld $pk $pChild $pChildPid $pJob}catch{return 'peer-unexpected'}",
    "if($pPre -cne 'ok'){return ('peer-pre-'+$pPre)}",
    CREATE_CALL,
    "if([long]$pPipe -eq -1){return 'peer-open'}",
    "$pCode='peer-unexpected';$pHanded=$false",
    "GetHandleInformation",
    "if(-not ($pk::GetNamedPipeServerProcessId($pPipe,$pServer) -and $pServer[0] -gt 0)){$pCode='peer-server-pid'}",
    "elseif(($pServer[0] -ne $pk::GetProcessId($pChild)) -or ($pServer[0] -ne $pChildPid)){$pCode='peer-server-mismatch'}",
    "else{$pPost=SupPeerHeld $pk $pChild $pChildPid $pJob;if($pPost -ceq 'ok'){$pCode='ok'}else{$pCode='peer-post-'+$pPost}}}",
    "if($pCode -ceq 'ok'){$pOut.Value=$pPipe;$pHanded=$true}",
    "}catch{$pCode='peer-unexpected'}",
    "finally{if(-not $pHanded){try{[void]$pk::CloseHandle($pPipe)}catch{}}}",
    "if($pHanded){return 'ok'}",
    "if($pCode -ceq 'ok'){return 'peer-unexpected'}",
    "return $pCode}",
  );
  // The retained-child check: nonzero handle, positive PID, nonzero job, live, same PID, in the confirmed job.
  assertOrdered(
    "if($pChild -eq [IntPtr]::Zero){return 'child-handle'}",
    "if($pChildPid -le 0){return 'child-pid'}",
    "if($pJob -eq [IntPtr]::Zero){return 'job-handle'}",
    "if($pk::WaitForSingleObject($pChild,0) -ne 258){return 'child-not-live'}",
    "if($pk::GetProcessId($pChild) -ne $pChildPid){return 'child-pid'}",
    "if(-not ($pk::IsProcessInJob($pChild,$pJob,$pFlag) -and $pFlag[0] -ne 0)){return 'child-not-in-job'}",
    "return 'ok'}\nfunction SupPeerOpen(",
  );
  // The retained check runs exactly twice: once before the open, once after the server sample.
  assert.equal(count(SOURCE, "SupPeerHeld $pk $pChild $pChildPid $pJob"), 2);
  // The server PID is compared to the retained handle's PID and the established PID; no other identity source.
  assert.doesNotMatch(SOURCE, /OpenProcess|Toolhelp|Process32|Get-CimInstance|Get-WmiObject|Win32_Process|ParentProcess|Get-Process|GetNamedPipeClient/iu);
});

test("release: open failure is only the exact sentinel; every later path releases once unless the handoff completed", () => {
  assert.equal(WINDOWS_CLAUDE_INBOX_PEER_WIN32.INVALID_HANDLE_VALUE, -1);
  assert.equal(count(SOURCE, "CloseHandle"), 1);
  const VALID = "if([long]$pPipe -eq -1){return 'peer-open'}";
  const OWN = "$pCode='peer-unexpected';$pHanded=$false\ntry{\n";
  const HANDOFF = "if($pCode -ceq 'ok'){$pOut.Value=$pPipe;$pHanded=$true}\n";
  const CATCH = "}catch{$pCode='peer-unexpected'}\n";
  const FINALLY = "finally{if(-not $pHanded){try{[void]$pk::CloseHandle($pPipe)}catch{}}}\n";
  const TAIL = "if($pHanded){return 'ok'}\nif($pCode -ceq 'ok'){return 'peer-unexpected'}\nreturn $pCode}";
  const open = indexOnce(CREATE_CALL);
  const valid = indexOnce(VALID);
  // Nothing but the exact sentinel counts as "nothing opened": no sign test, no zero test on the pipe.
  assert.doesNotMatch(SOURCE, /\$pPipe -(?:le|lt|ge|gt) |\$pPipe -eq \[IntPtr\]::Zero|\$pPipe -eq 0/u);
  // Before ownership starts, the only exits are the open's own catch and the sentinel refusal.
  const preValid = SOURCE.slice(open, valid + VALID.length);
  assert.equal(count(preValid, "return"), 2, "the catch on the open and the sentinel refusal");
  // Ownership begins immediately after the sentinel check: one try whose finally holds the only close.
  assert.equal(SOURCE.slice(valid + VALID.length, valid + VALID.length + 1 + OWN.length), `\n${OWN}`);
  const ownStart = valid + VALID.length + 1;
  const handoff = indexOnce(HANDOFF);
  const catcher = indexOnce(CATCH);
  const releaser = indexOnce(FINALLY);
  assert.ok(ownStart < handoff && handoff < catcher && catcher < releaser);
  // The [ref] handoff is the LAST statement inside the protected block, and $pHanded is set only after it.
  assert.equal(handoff + HANDOFF.length, catcher);
  assert.equal(count(SOURCE, "$pHanded=$true"), 1);
  assert.ok(HANDOFF.indexOf("$pOut.Value=$pPipe") < HANDOFF.indexOf("$pHanded=$true"));
  // Inside the protected block nothing returns, throws, exits, or jumps past the finally.
  const owned = SOURCE.slice(ownStart, catcher);
  assert.doesNotMatch(owned, /\breturn\b|\bthrow\b|\bexit\b|\bbreak\b|\bcontinue\b|CloseHandle/u);
  assert.equal(count(owned, "try{"), 1);
  assert.equal(SOURCE.slice(catcher + CATCH.length, catcher + CATCH.length + FINALLY.length), FINALLY);
  // After the finally: success only when the handoff completed; an incomplete handoff is peer-unexpected.
  assert.equal(SOURCE.slice(releaser + FINALLY.length), TAIL);
  // The output is zeroed (guarded) first and receives the handle in exactly one place.
  assert.equal(count(SOURCE, "$pOut.Value="), 2);
  assert.equal(indexOnce("try{$pOut.Value=[IntPtr]::Zero}catch{return 'peer-unexpected'}") < open, true);
  // The function never ends the host, never throws, and never calls a supervisor failure path.
  assert.doesNotMatch(SOURCE, /\bexit\b|\bthrow\b|SupFail|SupBootFail|PrgFail|trap/u);
});

test("closed codes: every value the function can return is ok or one closed refusal, and all refusals are reachable", () => {
  const openBody = SOURCE.slice(SOURCE.indexOf(OPEN_HEADER));
  const heldBody = SOURCE.slice(0, SOURCE.indexOf(OPEN_HEADER));
  const heldReturns = new Set([...heldBody.matchAll(/return '([a-z-]+)'/gu)].map((m) => m[1]!));
  assert.deepEqual([...heldReturns].sort(), ["ok", ...WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS].sort());
  const produced = new Set<string>();
  for (const m of openBody.matchAll(/return '([a-z-]+)'|\$pCode='([a-z-]+)'(?!\+)/gu)) produced.add((m[1] ?? m[2])!);
  for (const prefix of ["peer-pre-", "peer-post-"]) {
    assert.ok(openBody.includes(`'${prefix}'+$p`), `${prefix} composition`);
    for (const held of WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS) produced.add(`${prefix}${held}`);
  }
  // `return ('peer-pre-'+$pPre)` and `$pCode='peer-post-'+$pPost` are the only computed results.
  assert.equal([...openBody.matchAll(/return \(/gu)].length, 1);
  assert.equal([...openBody.matchAll(/\$pCode='[a-z-]+'\+/gu)].length, 1);
  assert.equal(count(openBody, "return $pCode}"), 1);
  assert.deepEqual([...produced].sort(), ["ok", ...WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS].sort());
  assert.equal(new Set(WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS).size, WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS.length);
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS));
  for (const code of ["ok", ...WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS]) {
    assert.equal(classifyWindowsClaudeInboxPeerOpenResult(code), code);
  }
  for (const other of [undefined, null, 0, "", "OK", "ok ", "ok\n", "peer-", "peer-pre-ok", "peer-post-ok", "peer-pre-unexpected", "SUP_GO 1", {}]) {
    assert.equal(classifyWindowsClaudeInboxPeerOpenResult(other), undefined, JSON.stringify(other));
  }
});

test("no payload: the function never writes, reads, waits, retries, or reaches any network or environment surface", () => {
  assert.doesNotMatch(
    SOURCE,
    /write|\bread|flush|send|recv|WriteFile|ReadFile|TransactNamedPipe|CallNamedPipe|ConnectNamedPipe|PeekNamedPipe|SetNamedPipeHandleState|NamedPipeClientStream|NamedPipeServerStream|StreamWriter|StreamReader|FileStream|\.Connect|Socket|TcpClient|\bNet\.|Http|WebClient|WebRequest|Invoke-RestMethod|Uri\b|Dns/iu,
  );
  assert.doesNotMatch(
    SOURCE,
    /\$env:|Environment|CLAUDE|MESSAGING|token|auth|nonce|SupOut|SupSend|SupReply|SupDiag|Console|Out-|Start-Process|Process\]::Start|TerminateProcess|TerminateJobObject|DuplicateHandle|Add-Type|Reflection|DefineDynamic|Invoke-Expression|\biex\b|ScriptBlock|\. \$|&\s*\$/iu,
  );
  assert.doesNotMatch(SOURCE, /ToLower|ToUpper|Trim|Replace|GetFullPath|Normalize|Combine|Join-Path|Resolve-Path|Split-Path/iu);
  // The endpoint itself is never rendered into the source.
  assert.ok(!SOURCE.includes(P));
  assert.ok(!SOURCE.toLowerCase().includes("\\\\.\\pipe\\local\\"));
  // Interop surface: exactly the documented existing and additional kernel32 methods.
  const called = new Set([...SOURCE.matchAll(/\$pk::([A-Za-z0-9]+)\(/gu)].map((m) => m[1]!));
  const declared = WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.additionalInteropDeclarations.map((d) => /^SupDef '([A-Za-z]+)'/u.exec(d)![1]!);
  assert.deepEqual([...called].sort(), [...WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.existingInterop, ...declared].sort());
  assert.doesNotMatch(SOURCE, /\[[A-Za-z.]+\]::(?!Zero\b|new\(|Ordinal\b)/u, "no other static .NET call");
});

/* ------------------------------------------------------ host contract */

test("host contract: documented against the existing supervisor custody primitives, and not wired yet", () => {
  const sup = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE;
  const contract = WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT;
  assert.ok(Object.isFrozen(contract));
  assert.equal(contract.interopType, "$K");
  assert.ok(sup.includes("$K=$TB.CreateType()"));
  assert.ok(sup.includes("[Runtime.InteropServices.CharSet]::Unicode"), "SupDef already marshals strings as UTF-16");
  for (const name of contract.existingInterop) assert.ok(sup.includes(`SupDef '${name}' `), `${name} already declared`);
  for (const declaration of contract.additionalInteropDeclarations) {
    assert.match(declaration, /^SupDef '[A-Za-z]+' \$T[IFN] @\((?:\[string\]|\$T[IAN])(?:,(?:\$T[IAN]))*\)$/u);
    const name = /^SupDef '([A-Za-z]+)'/u.exec(declaration)![1]!;
    assert.ok(!sup.includes(`SupDef '${name}'`), `${name} is not declared in the supervisor yet`);
  }
  for (const alias of ["$TI=[IntPtr]", "$TN=[int]", "$TF=[bool]", "$TA=[int[]]"]) assert.ok(sup.includes(alias), alias);
  // Argument mapping matches the function header and the supervisor's custody state.
  const header = /^function SupPeerOpen\(([^)]*)\)\{/mu.exec(SOURCE)![1]!;
  const headerParams = header.split(",").map((p) => p.replace(/^\[[A-Za-z]+\]/u, ""));
  assert.deepEqual(contract.arguments.map((a) => a.parameter), headerParams);
  assert.deepEqual(contract.arguments.slice(0, 4).map((a) => a.source), ["$K", "$CH", "$ChildPid", "$Job"]);
  assert.ok(sup.includes("$script:CH=$childH;$script:ChildPid=[int]$claimed"), "set only by SupChild");
  assert.ok(sup.includes("$script:Job=$ProvJob;"), "set only by a matching CONFIRM");
  assert.ok(sup.includes("$script:Phase='run'"));
  assert.equal(contract.phase, "run");
  // The fixed source could later travel in the existing startup frame without exceeding its bound.
  assert.ok(sup.length + 1 + SOURCE.length <= WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES);
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
  assert.deepEqual(Object.keys(peerModule).sort(), [
    "WINDOWS_CLAUDE_INBOX_ENDPOINT_REFUSALS",
    "WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX",
    "WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN",
    "WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX",
    "WINDOWS_CLAUDE_INBOX_PEER_DESIRED_ACCESS",
    "WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS",
    "WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION",
    "WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT",
    "WINDOWS_CLAUDE_INBOX_PEER_OPEN_FLAGS",
    "WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION",
    "WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS",
    "WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE",
    "WINDOWS_CLAUDE_INBOX_PEER_WIN32",
    "classifyWindowsClaudeInboxPeerOpenResult",
    "parseWindowsClaudeInboxLocalEndpoint",
  ]);
  const functions = Object.entries(peerModule).filter(([, value]) => typeof value === "function").map(([name]) => name);
  assert.deepEqual(functions.sort(), ["classifyWindowsClaudeInboxPeerOpenResult", "parseWindowsClaudeInboxLocalEndpoint"]);
  const moduleText = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(moduleText.endsWith("\n") && !moduleText.endsWith("\n\n"));
  assert.doesNotMatch(moduleText, /^\s*import\b|\brequire\(|\bimport\(/mu, "no imports at all");
  assert.doesNotMatch(moduleText, /child_process|node:net|node:fs|process\.env|\bspawn\(|(?<![.\w])exec\(|\bfetch\(|new Function|\beval\(/u);
  // No product source imports or names this module: it stays inactive until a later slice wires it.
  // The one exception is the equally inactive single-attempt inbox write source, which composes
  // (calls, never defines) the fixed functions; its own tests pin that it has no product caller.
  const srcRoot = join(PROJECT_ROOT, "src");
  // The #682 Windows root hook relay helper imports only the pure endpoint
  // parser (never the fixed functions) to validate a record's endpoint.
  const relayHelper = join(srcRoot, "session-host", "native-windows-claude-hook-relay.ts");
  for (const file of listTs(srcRoot)) {
    if (file === MODULE_SOURCE_PATH) continue;
    const text = readFileSync(file, "utf8");
    if (file === relayHelper) {
      const imports = [...text.matchAll(/^import \{([^}]*)\} from "\.\/native-windows-claude-inbox-peer";$/gmu)].map((m) => m[1].trim());
      assert.deepEqual(imports, ["parseWindowsClaudeInboxLocalEndpoint"], "the relay helper imports only the endpoint parser");
      assert.ok(!text.includes("SupPeerOpen") && !text.includes("SupPeerHeld"), `${file} must not wire the fixed function`);
      continue;
    }
    assert.ok(!text.includes("native-windows-claude-inbox-peer"), `${file} must not import the inactive module`);
    if (file === INACTIVE_COMPOSER_PATH) {
      assert.doesNotMatch(text, /function SupPeer(?:Open|Held)\b/u, "the composer never redefines the fixed functions");
      continue;
    }
    assert.ok(!text.includes("SupPeerOpen") && !text.includes("SupPeerHeld"), `${file} must not wire the fixed function`);
  }
});
