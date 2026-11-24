/**
 * #682 native Windows Claude inbox — INACTIVE LOCAL pipe ownership primitives.
 *
 * ## What this module is
 *
 * Two pure, fixed pieces that a later custody-supervisor slice needs before it
 * may ever hand a byte to a Windows Claude inbox pipe:
 *
 * 1. {@link parseWindowsClaudeInboxLocalEndpoint}: exact validation of the one
 *    proven Windows endpoint shape. Nothing is normalized.
 * 2. {@link WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE}: a FIXED Windows PowerShell
 *    5.1 function source (no placeholders, nothing rendered into it) that opens
 *    the endpoint once and proves the kernel-reported pipe server is the
 *    supervisor's retained, live, job-contained direct child.
 *
 * It is deliberately inert: no product path uses it except the dormant
 * Windows root hook relay helper, which imports only the pure endpoint
 * parser to validate a record's endpoint; it spawns nothing,
 * opens nothing from Node, renders no endpoint or token into any source,
 * argument, or environment, and adds no protocol opcode. The PowerShell
 * function has no payload, no write, no read, no retry, and no network
 * operation; the handle it returns is merely held. Wiring it into the
 * supervisor source is a later slice (see {@link WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT}).
 *
 * ## Endpoint grammar
 *
 * The real endpoint syntax proven on Windows is CASE-EXACT `\\.\pipe\LOCAL\`
 * followed by exactly ONE ASCII segment. The accepted segment is the bounded
 * class `[A-Za-z0-9._-]{1,200}`, checked against the real end of the string
 * (a final LF, CR, or any other trailing byte is a refusal, never trimmed).
 * The reserved dot segments `.` and `..` and any segment ending in `.` are
 * refused, because Win32 path processing strips or resolves them and the
 * opened object would then differ from the announced one. There is no
 * lowercasing, trimming, prefix repair, unquoting, separator conversion, or
 * other path normalization: any other namespace (`Global\`, `Session\<n>\`, a
 * bare `\\.\pipe\<name>`, a different case of `pipe` or `LOCAL`, `\\?\`, a
 * remote server, forward slashes) is refused outright.
 *
 * ## Peer-open sequence (exact reference evidence)
 *
 * The sequence follows the existing #682 Windows evidence (the inbox
 * ownership probe's "pinned target" rule and the row-observation helper's
 * open/sample/recheck order): a numeric server PID names the intended process
 * instance only while a handle to that instance has been held continuously
 * from its creation, because Windows does not reuse a PID while any handle to
 * the process is open. The function therefore requires the custody
 * supervisor's retained creation handle to the direct target, and refuses
 * every other source of identity: there is no lineage fallback, no
 * CIM/toolhelp ancestry, and no externally supplied PID authorization.
 *
 * In order:
 *
 * 1. the endpoint matches the exact grammar above (`-cnotmatch` with `\z`);
 * 2. BEFORE connecting: the retained child handle is nonzero, the established
 *    child PID is positive, the confirmed job handle is nonzero (a NULL job
 *    would make `IsProcessInJob` mean "any job"), the child is still live
 *    (`WaitForSingleObject(h, 0) == WAIT_TIMEOUT`), `GetProcessId(h)` equals
 *    the established child PID, and the child is still in the confirmed job;
 * 3. exactly ONE `CreateFileW(endpoint, GENERIC_WRITE | FILE_READ_ATTRIBUTES,
 *    0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT |
 *    SECURITY_IDENTIFICATION, NULL)`: the documented minimal access for a
 *    write-side client that also queries pipe information, a NULL security
 *    descriptor (non-inheritable handle), identification-only impersonation so
 *    the server can never impersonate the supervisor, an asynchronous handle,
 *    and no `WaitNamedPipe` and no retry of any kind;
 * 4. the opened handle is confirmed non-inheritable (`GetHandleInformation`);
 * 5. the kernel's `GetNamedPipeServerProcessId` on that SAME handle is positive
 *    and equals both `GetProcessId` of the retained handle and the established
 *    child PID;
 * 6. the retained child is rechecked (all of step 2 again) AFTER the sample;
 * 7. only then is the SAME opened handle assigned to the `[ref]` output.
 *
 * Every refusal returns one closed code ({@link WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS})
 * and leaves the output zero. Open failure is recognized ONLY by the exact
 * `CreateFileW` failure sentinel `INVALID_HANDLE_VALUE` (`-1`); every other
 * returned value is treated as an owned handle. From that point the function
 * owns it inside one `try`/`catch`/`finally`: the `finally` releases it with
 * exactly ONE `CloseHandle` unless the `[ref]` handoff itself completed, so a
 * failed check, a caught exception, or a handoff the caller's reference
 * rejects (`peer-unexpected`) all release it once. After a completed handoff
 * it is never closed here; ownership has passed to the caller.
 *
 * ## What success means
 *
 * `ok` is a CUSTODY fact only: this supervisor holds a client handle whose
 * server end the kernel attributed to its retained child while that child was
 * provably the same live, job-contained instance. It is not authentication of
 * the provider, not a claim that any message will be accepted or delivered,
 * and not permission to write. Windows-side inert identity and zero-byte
 * observations of this function remain a later runtime test.
 */

/* ------------------------------------------------------------- endpoint */

/** The only accepted endpoint prefix, case-exact: `\\.\pipe\LOCAL\`. */
export const WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PREFIX = "\\\\.\\pipe\\LOCAL\\";

/** Largest accepted segment length (characters, all ASCII). */
export const WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_SEGMENT_MAX = 200;

/**
 * The same grammar for the .NET regex engine used by PowerShell `-cnotmatch`.
 * It ends with `\z`: in .NET, `$` would also match before a final `\n`.
 */
export const WINDOWS_CLAUDE_INBOX_LOCAL_PIPE_PS_PATTERN = String.raw`^\\\\\.\\pipe\\LOCAL\\[A-Za-z0-9._-]{1,200}\z`;

declare const WINDOWS_CLAUDE_INBOX_LOCAL_ENDPOINT_BRAND: unique symbol;

/** An endpoint string that passed {@link parseWindowsClaudeInboxLocalEndpoint} unchanged. */
export type WindowsClaudeInboxLocalEndpoint = string & { readonly [WINDOWS_CLAUDE_INBOX_LOCAL_ENDPOINT_BRAND]: true };

/** Closed endpoint refusal codes. */
export const WINDOWS_CLAUDE_INBOX_ENDPOINT_REFUSALS = Object.freeze([
  "endpoint-type",
  "endpoint-control",
  "endpoint-grammar",
  "endpoint-dot",
] as const);

export type WindowsClaudeInboxEndpointRefusal = (typeof WINDOWS_CLAUDE_INBOX_ENDPOINT_REFUSALS)[number];

export type WindowsClaudeInboxEndpointResult =
  | { readonly ok: true; readonly endpoint: WindowsClaudeInboxLocalEndpoint }
  | { readonly ok: false; readonly refusal: WindowsClaudeInboxEndpointRefusal };

/*
 * Module-private matcher state. The parser deliberately uses no RegExp (whose
 * object or prototype a consumer could reconfigure) and no exported mutable
 * value: only frozen code units and plain comparisons.
 * (CommonJS output reads exported consts through the mutable `exports`
 * object, so the parser never reads the exported prefix or bound either.)
 */
const LOCAL_PIPE_SEGMENT_MAX = 200;
const LOCAL_PIPE_PREFIX_CODES: readonly number[] = Object.freeze(
  // `\\.\pipe\LOCAL\` as UTF-16 code units.
  [0x5c, 0x5c, 0x2e, 0x5c, 0x70, 0x69, 0x70, 0x65, 0x5c, 0x4c, 0x4f, 0x43, 0x41, 0x4c, 0x5c],
);

function isSegmentCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x2d // -
  );
}

function refuseEndpoint(refusal: WindowsClaudeInboxEndpointRefusal): WindowsClaudeInboxEndpointResult {
  return Object.freeze({ ok: false as const, refusal });
}

/**
 * Validate one announced endpoint exactly. On success the returned endpoint is
 * the SAME string value (never a repaired copy); on refusal only a closed code
 * is returned, never the input.
 */
export function parseWindowsClaudeInboxLocalEndpoint(value: unknown): WindowsClaudeInboxEndpointResult {
  if (typeof value !== "string") return refuseEndpoint("endpoint-type");
  const length = value.length;
  // Every C0 control byte (NUL, TAB, CR, LF, ...) and DEL, anywhere — a final newline is never trimmed.
  for (let i = 0; i < length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return refuseEndpoint("endpoint-control");
  }
  // Case-exact prefix, compared code unit by code unit: no lowercasing, no repair.
  const prefixLength = LOCAL_PIPE_PREFIX_CODES.length;
  const segmentLength = length - prefixLength;
  if (segmentLength < 1 || segmentLength > LOCAL_PIPE_SEGMENT_MAX) return refuseEndpoint("endpoint-grammar");
  for (let i = 0; i < prefixLength; i += 1) {
    if (value.charCodeAt(i) !== LOCAL_PIPE_PREFIX_CODES[i]) return refuseEndpoint("endpoint-grammar");
  }
  // One segment of [A-Za-z0-9._-], running to the true end of the string.
  for (let i = prefixLength; i < length; i += 1) {
    if (!isSegmentCode(value.charCodeAt(i))) return refuseEndpoint("endpoint-grammar");
  }
  // Reserved `.`/`..` and any trailing dot (every reserved dot segment ends in `.`).
  if (value.charCodeAt(length - 1) === 0x2e) return refuseEndpoint("endpoint-dot");
  return Object.freeze({ ok: true as const, endpoint: value as WindowsClaudeInboxLocalEndpoint });
}

/* ------------------------------------------------------------ peer open */

/** Win32 constants used by the fixed function (documented values). */
export const WINDOWS_CLAUDE_INBOX_PEER_WIN32 = Object.freeze({
  GENERIC_WRITE: 0x4000_0000,
  FILE_READ_ATTRIBUTES: 0x0000_0080,
  OPEN_EXISTING: 3,
  FILE_FLAG_OVERLAPPED: 0x4000_0000,
  SECURITY_SQOS_PRESENT: 0x0010_0000,
  /** `SecurityIdentification << 16`. */
  SECURITY_IDENTIFICATION: 0x0001_0000,
  HANDLE_FLAG_INHERIT: 0x0000_0001,
  /** `CreateFileW` failure sentinel; the only value treated as "nothing opened". */
  INVALID_HANDLE_VALUE: -1,
  WAIT_TIMEOUT: 258,
});

/** `dwDesiredAccess` passed to the single `CreateFileW`. */
export const WINDOWS_CLAUDE_INBOX_PEER_DESIRED_ACCESS =
  WINDOWS_CLAUDE_INBOX_PEER_WIN32.GENERIC_WRITE | WINDOWS_CLAUDE_INBOX_PEER_WIN32.FILE_READ_ATTRIBUTES;

/** `dwFlagsAndAttributes` passed to the single `CreateFileW`. */
export const WINDOWS_CLAUDE_INBOX_PEER_OPEN_FLAGS =
  WINDOWS_CLAUDE_INBOX_PEER_WIN32.FILE_FLAG_OVERLAPPED |
  WINDOWS_CLAUDE_INBOX_PEER_WIN32.SECURITY_SQOS_PRESENT |
  WINDOWS_CLAUDE_INBOX_PEER_WIN32.SECURITY_IDENTIFICATION;

/** Retained-child check codes; each appears with a `peer-pre-` and a `peer-post-` prefix. */
export const WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS = Object.freeze([
  "child-handle",
  "child-pid",
  "job-handle",
  "child-not-live",
  "child-not-in-job",
] as const);

type HeldCheck = (typeof WINDOWS_CLAUDE_INBOX_PEER_HELD_CHECKS)[number];

/** The closed refusal codes the fixed function can return (everything except `ok`). */
export const WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS = Object.freeze([
  "peer-endpoint",
  "peer-pre-child-handle",
  "peer-pre-child-pid",
  "peer-pre-job-handle",
  "peer-pre-child-not-live",
  "peer-pre-child-not-in-job",
  "peer-open",
  "peer-inherit",
  "peer-server-pid",
  "peer-server-mismatch",
  "peer-post-child-handle",
  "peer-post-child-pid",
  "peer-post-job-handle",
  "peer-post-child-not-live",
  "peer-post-child-not-in-job",
  "peer-unexpected",
] as const) satisfies readonly (
  | "peer-endpoint"
  | `peer-pre-${HeldCheck}`
  | "peer-open"
  | "peer-inherit"
  | "peer-server-pid"
  | "peer-server-mismatch"
  | `peer-post-${HeldCheck}`
  | "peer-unexpected"
)[];

export type WindowsClaudeInboxPeerOpenRefusal = (typeof WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS)[number];

/** Every value the fixed function returns: `ok` or one closed refusal. */
export type WindowsClaudeInboxPeerOpenResult = "ok" | WindowsClaudeInboxPeerOpenRefusal;

/** Closed classification of a value returned by the fixed function; anything else is `undefined`. */
export function classifyWindowsClaudeInboxPeerOpenResult(value: unknown): WindowsClaudeInboxPeerOpenResult | undefined {
  if (value === "ok") return "ok";
  return typeof value === "string" && (WINDOWS_CLAUDE_INBOX_PEER_OPEN_REFUSALS as readonly string[]).includes(value)
    ? (value as WindowsClaudeInboxPeerOpenRefusal)
    : undefined;
}

/** Name of the fixed peer-open function defined by {@link WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE}. */
export const WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION = "SupPeerOpen";

/** Name of the fixed retained-child check it uses before and after the sample. */
export const WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION = "SupPeerHeld";

/**
 * The fixed Windows PowerShell 5.1 source: two function definitions and
 * nothing else (no top-level statement runs when it is dot-sourced). It has no
 * placeholders; the endpoint arrives only as a runtime argument and the
 * function never sees, stores, or emits any token. Printable ASCII and LF only,
 * so it can later travel inside the supervisor's existing startup frame.
 *
 * PowerShell 5.1 syntax only; no backticks, no `${...}`; parameter names are
 * distinct (ignoring case) from every supervisor script variable and from the
 * automatic variables.
 */
export const WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE = String.raw`
function SupPeerHeld([Type]$pk,[IntPtr]$pChild,[int]$pChildPid,[IntPtr]$pJob){
if($pChild -eq [IntPtr]::Zero){return 'child-handle'}
if($pChildPid -le 0){return 'child-pid'}
if($pJob -eq [IntPtr]::Zero){return 'job-handle'}
if($pk::WaitForSingleObject($pChild,0) -ne 258){return 'child-not-live'}
if($pk::GetProcessId($pChild) -ne $pChildPid){return 'child-pid'}
$pFlag=[int[]]::new(1)
if(-not ($pk::IsProcessInJob($pChild,$pJob,$pFlag) -and $pFlag[0] -ne 0)){return 'child-not-in-job'}
return 'ok'}
function SupPeerOpen([Type]$pk,[IntPtr]$pChild,[int]$pChildPid,[IntPtr]$pJob,[object]$pEndpoint,[ref]$pOut){
try{$pOut.Value=[IntPtr]::Zero}catch{return 'peer-unexpected'}
if($pEndpoint -isnot [string]){return 'peer-endpoint'}
if($pEndpoint -cnotmatch '^\\\\\.\\pipe\\LOCAL\\[A-Za-z0-9._-]{1,200}\z'){return 'peer-endpoint'}
$pSeg=$pEndpoint.Substring(15)
if($pSeg -ceq '.' -or $pSeg -ceq '..' -or $pSeg.EndsWith('.',[StringComparison]::Ordinal)){return 'peer-endpoint'}
$pPre='unexpected'
try{$pPre=SupPeerHeld $pk $pChild $pChildPid $pJob}catch{return 'peer-unexpected'}
if($pPre -cne 'ok'){return ('peer-pre-'+$pPre)}
$pPipe=[IntPtr]::Zero
try{$pPipe=$pk::CreateFileW($pEndpoint,0x40000080,0,[IntPtr]::Zero,3,0x40110000,[IntPtr]::Zero)}catch{return 'peer-open'}
if([long]$pPipe -eq -1){return 'peer-open'}
$pCode='peer-unexpected';$pHanded=$false
try{
$pInfo=[int[]]::new(1);$pInfo[0]=1
if(-not ($pk::GetHandleInformation($pPipe,$pInfo) -and ($pInfo[0] -band 1) -eq 0)){$pCode='peer-inherit'}
else{
$pServer=[int[]]::new(1)
if(-not ($pk::GetNamedPipeServerProcessId($pPipe,$pServer) -and $pServer[0] -gt 0)){$pCode='peer-server-pid'}
elseif(($pServer[0] -ne $pk::GetProcessId($pChild)) -or ($pServer[0] -ne $pChildPid)){$pCode='peer-server-mismatch'}
else{$pPost=SupPeerHeld $pk $pChild $pChildPid $pJob;if($pPost -ceq 'ok'){$pCode='ok'}else{$pCode='peer-post-'+$pPost}}}
if($pCode -ceq 'ok'){$pOut.Value=$pPipe;$pHanded=$true}
}catch{$pCode='peer-unexpected'}
finally{if(-not $pHanded){try{[void]$pk::CloseHandle($pPipe)}catch{}}}
if($pHanded){return 'ok'}
if($pCode -ceq 'ok'){return 'peer-unexpected'}
return $pCode}
`.trim();

/**
 * The explicit, narrow host contract a later slice must satisfy to call the
 * fixed function from the custody supervisor
 * (`WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE`). It is documentation
 * data only: nothing here is rendered, appended, or wired yet.
 */
export const WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT = Object.freeze({
  /**
   * The supervisor's existing in-memory kernel32 type (`$K`, built by `SupDef`
   * with `SetLastError` and `CharSet.Unicode`) and the existing methods the
   * function relies on, unchanged.
   */
  interopType: "$K",
  existingInterop: Object.freeze(["WaitForSingleObject", "GetProcessId", "IsProcessInJob", "CloseHandle"] as const),
  /**
   * The three declarations a later slice must add to that same `SupDef` table,
   * in the supervisor's existing type aliases (`$TI` IntPtr, `$TN` int, `$TF`
   * bool, `$TA` int[]). None exists in the supervisor today.
   */
  additionalInteropDeclarations: Object.freeze([
    "SupDef 'CreateFileW' $TI @([string],$TN,$TN,$TI,$TN,$TN,$TI)",
    "SupDef 'GetHandleInformation' $TF @($TI,$TA)",
    "SupDef 'GetNamedPipeServerProcessId' $TF @($TI,$TA)",
  ] as const),
  /**
   * Arguments, in order, mapped to the supervisor's existing custody state.
   * `$CH`/`$ChildPid` are set only by `SupChild` after the kernel checks behind
   * `SUP_CHILD`; `$Job` only by a matching `CONFIRM`. The endpoint is a runtime
   * value that already passed the exact grammar; it is never rendered into any
   * source, argument, or environment.
   */
  arguments: Object.freeze([
    Object.freeze({ parameter: "$pk", source: "$K" }),
    Object.freeze({ parameter: "$pChild", source: "$CH" }),
    Object.freeze({ parameter: "$pChildPid", source: "$ChildPid" }),
    Object.freeze({ parameter: "$pJob", source: "$Job" }),
    Object.freeze({ parameter: "$pEndpoint", source: "runtime endpoint value (never rendered)" }),
    Object.freeze({ parameter: "$pOut", source: "[ref] to a caller-owned [IntPtr] variable" }),
  ] as const),
  /** Only in the supervisor's `run` phase (after `SUP_CHILD`), never earlier. */
  phase: "run",
  /** On `ok`, the caller owns exactly the returned handle and must close it exactly once. */
  ownership: "caller-owns-returned-handle-on-ok-only",
});
