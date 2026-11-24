/**
 * #682 native Windows Claude hook receive side — INACTIVE supervisor helper.
 *
 * ## What this module is
 *
 * The custody supervisor's counterpart of the landed Windows Claude hook
 * forwarding client: a FIXED Windows PowerShell 5.1 function source
 * ({@link WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE}, no placeholders, nothing
 * rendered into it) that services exactly ONE already accepted,
 * supervisor-owned hook pipe connection in the supervisor's confirmed `run`
 * phase, plus the closed result codes and the narrow host contract a later
 * slice must satisfy to call it.
 *
 * It is deliberately inert: no product path imports it, it spawns nothing,
 * creates no pipe, sets no DACL, registers no hook, writes no inbox byte,
 * forwards no token, and renders no key, run id, nonce, or endpoint into any
 * source, argument, or environment. Listener creation, the accept loop,
 * bootstrap wiring, key provenance, and every use of a returned candidate are
 * later slices (see {@link WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT}).
 *
 * ## Same-connection sequence (fixed grammar, no dialects, no retry)
 *
 * 1. inputs are validated without coercion: a genuine cancelable
 *    `CancellationToken` (a token that can never be canceled is refused), a
 *    finite integer budget of 1..5000 ms measured on one monotonic
 *    `Stopwatch`, the custody run-id grammar, the 64-character lowercase hex
 *    key, and an async, connected `NamedPipeServerStream`;
 * 2. the retained direct child (`$CH`/`$ChildPid`/`$Job`) is still the same
 *    live, job-contained instance (nonzero, non-pseudo handles; a NULL job
 *    would make `IsProcessInJob` mean "any job");
 * 3. the kernel's `GetNamedPipeClientProcessId` on THAT connection names a
 *    positive PID that is neither the retained child nor the wrapper; the
 *    function then opens it ONCE with `SYNCHRONIZE |
 *    PROCESS_QUERY_LIMITED_INFORMATION` and RETAINS that handle for the whole
 *    exchange. A numeric PID alone never authorizes anything;
 * 4. guard: the connection's client PID is re-sampled and still equal, the
 *    retained client handle is live, names that PID, and is in the confirmed
 *    job, and the retained child is rechecked;
 * 5. exactly `HELLO1 <32 lowercase hex>\n` (40 bytes) is read with every read
 *    capped at the bytes still missing from that frame, so no later byte is
 *    ever consumed before the proof is written; a CR, any other byte, EOF, or
 *    a byte already queued behind the frame (`PeekNamedPipe`) is a refusal;
 * 6. guard again, immediately before the proof;
 * 7. exactly `PROOF <64 lowercase hex>\n` (71 bytes) is written: HMAC-SHA256
 *    keyed by the 64-character key used AS ASCII TEXT (never hex-decoded),
 *    over the ASCII message `prg682-hook-v1|<runId>|<nonce>`;
 * 8. only after that write completed is one record read: printable ASCII
 *    terminated by one LF, at most 16384 bytes including the LF (the
 *    forwarder's shared record bound). The LF alone completes the frame,
 *    while the connection may still be live: the function never waits for
 *    EOF, so the client's own shutdown is not on the success path. A CR,
 *    control or non-ASCII byte, EOF before the LF, or an oversize frame is a
 *    refusal;
 * 9. trailing bytes are refused at one fixed observation boundary: any byte
 *    after the LF in data already read, and any byte still queued in the pipe
 *    when the frame completes (`PeekNamedPipe` reports a nonzero count). A
 *    peer that already closed with nothing queued (`PeekNamedPipe` fails with
 *    exactly `ERROR_BROKEN_PIPE`) has no trailing bytes; every other peek
 *    failure is a refusal. Bytes that arrive after that observation are never
 *    read by this function (the caller disposes the connection);
 * 10. the record must be the fixed canonical candidate
 *     ({@link WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN}) whose `runId` equals
 *     the caller's run id exactly, and whose socket endpoint passes the
 *     shared `\\.\pipe\LOCAL\<one segment>` grammar and dot rule;
 * 11. guard a final time — the retained client must STILL be live and in the
 *     job (a client that already exited is refused, never accepted), and the
 *     retained child rechecked — then cancellation and the deadline are
 *     rechecked, and only then is the candidate assigned to the caller's
 *     `[ref]`.
 *
 * Every read and write is one overlapped .NET pipe operation awaited in short
 * slices against the cancellation token and the monotonic deadline. On
 * cancellation or timeout the function calls `CancelIoEx` on the connection
 * and waits at most 1000 ms for that operation to settle; a settled operation
 * yields `hook-cancelled`/`hook-timeout`, an operation that is still pending
 * yields `hook-unsettled`. Nothing is ever retried.
 *
 * ## Candidate (the only accepted record)
 *
 * The PoC's wire format: one fixed ASCII JSON object, no whitespace, fields
 * in this exact order and nothing else, followed by one LF:
 *
 * `{"v":1,"runId":"<runId>","event":"SessionStart","sessionId":"<uuid>","socket":"<escaped endpoint>","token":"<token>"}`
 *
 * - `runId`: the custody run-id grammar, equal to the caller's run id;
 * - `sessionId`: a canonical lowercase 8-4-4-4-12 UUID;
 * - `socket` (returned in memory as `Endpoint`): `\\.\pipe\LOCAL\` plus one
 *   `[A-Za-z0-9._-]{1,200}` segment, each backslash written as the JSON
 *   escape `\\` and nothing else (no `\/`, no `\u` escapes); the endpoint is
 *   rebuilt from the fixed prefix and the matched segment, then rechecked
 *   against the shared grammar;
 * - `token`: the PoC alphabet `[A-Za-z0-9+/=_.~-]`, 8..4096 characters (none
 *   of which JSON escapes; an escaped `\/` is refused).
 *
 * There is no general JSON parser and no coercion: duplicate, reordered,
 * missing, or extra fields, other escapes, other numbers or literals, and
 * trailing text all fail the one anchored, case-sensitive (`\z`) match.
 *
 * ## Results and ownership
 *
 * The function returns exactly one closed code
 * ({@link WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS} or `candidate`) and writes
 * nothing to stdout, stderr, the environment, argv, or any file; it never
 * throws, exits, or calls a supervisor failure path. On every refusal the
 * `[ref]` output is `$null`. On `candidate` the output holds a fresh
 * hashtable `@{SessionId;Endpoint;Token}` in caller-owned memory only.
 *
 * The retained client process handle is always closed exactly once by the
 * function itself. The key bytes and digest are cleared on every path; the
 * HELLO, proof, and record buffers are cleared only after every
 * started pipe operation is KNOWN to have completed (never after
 * `hook-unsettled` or an unexpected exception, when the kernel might still
 * write into them). .NET strings are immutable and cannot be cleared: the
 * function drops its own references to them.
 *
 * `candidate` means only: a process the kernel attributes to this
 * connection, retained by handle and live in the confirmed job, presented one
 * well-formed candidate after this supervisor proved the per-run key on the
 * same connection. It is NOT delivery, NOT acceptance by any provider, NOT
 * ownership of the root conversation, and NOT a binding. The existing
 * authenticated broker status, the exact live root/session/CWD match, and a
 * subsequent generation are still required before any binding; `/clear`
 * re-arming and revocation of an old owner are later slices. Windows-side
 * inert reciprocal handshake evidence also remains a later runtime test.
 */

/* ------------------------------------------------------------- constants */

/** Domain-separation prefix of the proof message `prg682-hook-v1|<runId>|<nonce>`. */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_PROOF_CONTEXT = "prg682-hook-v1";

/** Fixed byte and time limits; each appears as a literal in the fixed source. */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS = Object.freeze({
  /** `HELLO1 ` + 32 lowercase hex + LF. */
  helloBytes: 40,
  /** `PROOF ` + 64 lowercase hex + LF. */
  proofBytes: 71,
  /** Largest record including its LF; the forwarder's shared record bound. */
  recordMaxBytes: 16384,
  /** Largest accepted caller budget for the whole exchange, in milliseconds. */
  budgetMaxMs: 5000,
  /** Longest wait for a canceled pipe operation to settle, in milliseconds. */
  cancelGraceMs: 1000,
  /** Longest single wait slice between cancellation/deadline checks. */
  waitSliceMs: 25,
  tokenMinChars: 8,
  tokenMaxChars: 4096,
});

/** Candidate field names, in their only accepted order. */
export const WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS = Object.freeze([
  "v",
  "runId",
  "event",
  "sessionId",
  "socket",
  "token",
] as const);

/**
 * The candidate grammar for the .NET regex engine (`[regex]::Match`, which is
 * case-sensitive by default). It ends with `\z`: in .NET, `$` would also match
 * before a final `\n`. Groups: 1 runId, 2 sessionId, 3 socket endpoint segment, 4 token.
 */
export const WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN = String.raw`^\{"v":1,"runId":"([A-Za-z0-9][A-Za-z0-9._:-]{0,127})","event":"SessionStart","sessionId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","socket":"\\\\\\\\\.\\\\pipe\\\\LOCAL\\\\([A-Za-z0-9._-]{1,200})","token":"([A-Za-z0-9+/=_.~-]{8,4096})"\}\z`;

/** Win32 constants used by the fixed function (documented values). */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32 = Object.freeze({
  SYNCHRONIZE: 0x0010_0000,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x0000_1000,
  WAIT_TIMEOUT: 258,
  /** The only peek failure after a complete record that means "peer closed, nothing queued". */
  ERROR_BROKEN_PIPE: 109,
});

/** `dwDesiredAccess` of the single client `OpenProcess`: query + wait, nothing else. */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_CLIENT_ACCESS =
  WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.SYNCHRONIZE | WINDOWS_CLAUDE_HOOK_RECEIVE_WIN32.PROCESS_QUERY_LIMITED_INFORMATION;

/* ---------------------------------------------------------------- results */

/** Retained-process check codes; each appears with a `hook-client-` and a `hook-child-` prefix. */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS = Object.freeze([
  "handle",
  "pid",
  "job-handle",
  "not-live",
  "not-in-job",
] as const);

type HeldCheck = (typeof WINDOWS_CLAUDE_HOOK_RECEIVE_HELD_CHECKS)[number];

/** The closed refusal codes the fixed function can return (everything except `candidate`). */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS = Object.freeze([
  "hook-input",
  "hook-conn",
  "hook-cancelled",
  "hook-timeout",
  "hook-unsettled",
  "hook-child-handle",
  "hook-child-pid",
  "hook-child-job-handle",
  "hook-child-not-live",
  "hook-child-not-in-job",
  "hook-client-sample",
  "hook-client-role",
  "hook-client-open",
  "hook-client-mismatch",
  "hook-client-handle",
  "hook-client-pid",
  "hook-client-job-handle",
  "hook-client-not-live",
  "hook-client-not-in-job",
  "hook-hello-io",
  "hook-hello-eof",
  "hook-hello-malformed",
  "hook-hello-trailing",
  "hook-proof-io",
  "hook-record-io",
  "hook-record-eof",
  "hook-record-byte",
  "hook-record-oversize",
  "hook-record-trailing",
  "hook-candidate-malformed",
  "hook-candidate-run",
  "hook-candidate-endpoint",
  "hook-unexpected",
] as const) satisfies readonly (
  | "hook-input"
  | "hook-conn"
  | "hook-cancelled"
  | "hook-timeout"
  | "hook-unsettled"
  | `hook-child-${HeldCheck}`
  | "hook-client-sample"
  | "hook-client-role"
  | "hook-client-open"
  | "hook-client-mismatch"
  | `hook-client-${HeldCheck}`
  | `hook-hello-${"io" | "eof" | "malformed" | "trailing"}`
  | "hook-proof-io"
  | `hook-record-${"io" | "eof" | "byte" | "oversize" | "trailing"}`
  | `hook-candidate-${"malformed" | "run" | "endpoint"}`
  | "hook-unexpected"
)[];

export type WindowsClaudeHookReceiveRefusal = (typeof WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS)[number];

/** Every value the fixed function returns: `candidate` or one closed refusal. */
export type WindowsClaudeHookReceiveResult = "candidate" | WindowsClaudeHookReceiveRefusal;

/** Closed classification of a value returned by the fixed function; anything else is `undefined`. */
export function classifyWindowsClaudeHookReceiveResult(value: unknown): WindowsClaudeHookReceiveResult | undefined {
  if (value === "candidate") return "candidate";
  return typeof value === "string" && (WINDOWS_CLAUDE_HOOK_RECEIVE_REFUSALS as readonly string[]).includes(value)
    ? (value as WindowsClaudeHookReceiveRefusal)
    : undefined;
}

/* ---------------------------------------------------------- fixed source */

/** Name of the fixed entry function defined by {@link WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE}. */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION = "SupHookServe";

/** Names of the fixed private helpers it uses, in definition order. */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_HELPER_FUNCTIONS = Object.freeze([
  "SupHookHeld",
  "SupHookGuard",
  "SupHookXfer",
  "SupHookXferCode",
] as const);

/**
 * The fixed Windows PowerShell 5.1 source: five function definitions and
 * nothing else (no top-level statement runs when it is dot-sourced). It has no
 * placeholders; the key, run id, connection, and budget arrive only as runtime
 * arguments and nothing is ever printed. Printable ASCII and LF only, so it
 * can later travel inside the supervisor's existing startup frame.
 *
 * PowerShell 5.1 syntax only; no backticks, no `${...}`; every variable uses
 * the reserved `h` prefix and is distinct (ignoring case) from every
 * supervisor script variable and from the automatic variables.
 */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE = String.raw`
function SupHookHeld([Type]$hk,[IntPtr]$hProc,[int]$hProcPid,[IntPtr]$hJob){
if($hProc -eq [IntPtr]::Zero -or [long]$hProc -eq -1){return 'handle'}
if($hProcPid -le 0){return 'pid'}
if($hJob -eq [IntPtr]::Zero -or [long]$hJob -eq -1){return 'job-handle'}
if($hk::WaitForSingleObject($hProc,0) -ne 258){return 'not-live'}
if($hk::GetProcessId($hProc) -ne $hProcPid){return 'pid'}
$hFlag=[int[]]::new(1)
if(-not ($hk::IsProcessInJob($hProc,$hJob,$hFlag) -and $hFlag[0] -ne 0)){return 'not-in-job'}
return 'ok'}
function SupHookGuard([Type]$hk,[IntPtr]$hRaw,[IntPtr]$hProc,[int]$hClientPid,[IntPtr]$hChild,[int]$hChildPid,[IntPtr]$hJob){
$hSample=[int[]]::new(1)
if(-not ($hk::GetNamedPipeClientProcessId($hRaw,$hSample) -and $hSample[0] -eq $hClientPid)){return 'hook-client-mismatch'}
$hHeld=SupHookHeld $hk $hProc $hClientPid $hJob
if($hHeld -cne 'ok'){return ('hook-client-'+$hHeld)}
$hHeld=SupHookHeld $hk $hChild $hChildPid $hJob
if($hHeld -cne 'ok'){return ('hook-child-'+$hHeld)}
return 'ok'}
function SupHookXfer([Type]$hk,[object]$hConn,[IntPtr]$hRaw,[bool]$hWrite,[byte[]]$hBuf,[int]$hOff,[int]$hCount,[Diagnostics.Stopwatch]$hClock,[long]$hUntil,[Threading.CancellationToken]$hCancel,[ref]$hDone){
$hDone.Value=-1
if($hCount -le 0 -or $hOff -lt 0 -or ($hOff+$hCount) -gt $hBuf.Length){return 'io'}
if($hCancel.IsCancellationRequested){return 'cancelled'}
if($hClock.ElapsedMilliseconds -ge $hUntil){return 'timeout'}
$hTask=$null
try{if($hWrite){$hTask=$hConn.WriteAsync($hBuf,$hOff,$hCount)}else{$hTask=$hConn.ReadAsync($hBuf,$hOff,$hCount)}}catch{return 'io'}
if($hTask -isnot [Threading.Tasks.Task]){return 'io'}
$hWhy='ok'
while(-not $hTask.IsCompleted){
if($hCancel.IsCancellationRequested){$hWhy='cancelled';break}
$hLeft=$hUntil-$hClock.ElapsedMilliseconds
if($hLeft -le 0){$hWhy='timeout';break}
try{[void]$hTask.Wait([int][Math]::Min(25,$hLeft))}catch{}}
if($hWhy -cne 'ok'){
try{[void]$hk::CancelIoEx($hRaw,[IntPtr]::Zero)}catch{}
$hGrace=[Diagnostics.Stopwatch]::StartNew()
while(-not $hTask.IsCompleted){
$hLeft=1000-$hGrace.ElapsedMilliseconds
if($hLeft -le 0){break}
try{[void]$hTask.Wait([int][Math]::Min(25,$hLeft))}catch{}}
if($hTask.IsCompleted){return $hWhy}
return 'unsettled'}
if($hTask.Status -ne [Threading.Tasks.TaskStatus]::RanToCompletion){return 'io'}
if($hWrite){$hDone.Value=$hCount;return 'ok'}
$hGot=[int]$hTask.Result
if($hGot -lt 0 -or $hGot -gt $hCount){return 'io'}
$hDone.Value=$hGot
return 'ok'}
function SupHookXferCode([string]$hX,[string]$hIo){
if($hX -ceq 'cancelled'){return 'hook-cancelled'}
if($hX -ceq 'timeout'){return 'hook-timeout'}
if($hX -ceq 'unsettled'){return 'hook-unsettled'}
return $hIo}
function SupHookServe([Type]$hk,[IntPtr]$hChild,[int]$hChildPid,[IntPtr]$hJob,[int]$hWrapperPid,[object]$hConn,[object]$hRunId,[object]$hKey,[object]$hBudgetMs,[object]$hCancel,[ref]$hOut){
try{$hOut.Value=$null}catch{return 'hook-unexpected'}
$hProc=[IntPtr]::Zero;$hSettled=$true;$hKeyBytes=$null;$hMac=$null;$hSum=$null;$hHello=$null;$hProof=$null;$hRec=$null;$hText=$null;$hM=$null
try{
if($hCancel -isnot [Threading.CancellationToken]){return 'hook-input'}
if(-not $hCancel.CanBeCanceled){return 'hook-input'}
if($hBudgetMs -isnot [int]){return 'hook-input'}
if($hBudgetMs -lt 1 -or $hBudgetMs -gt 5000){return 'hook-input'}
if($hRunId -isnot [string]){return 'hook-input'}
if($hRunId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z'){return 'hook-input'}
if($hKey -isnot [string]){return 'hook-input'}
if($hKey -cnotmatch '^[0-9a-f]{64}\z'){return 'hook-input'}
if($hConn -isnot [IO.Pipes.NamedPipeServerStream]){return 'hook-conn'}
$hClock=[Diagnostics.Stopwatch]::StartNew();$hUntil=[long]$hBudgetMs
if($hCancel.IsCancellationRequested){return 'hook-cancelled'}
if(-not ($hConn.IsConnected -and $hConn.IsAsync)){return 'hook-conn'}
$hRaw=$hConn.SafePipeHandle.DangerousGetHandle()
if([long]$hRaw -eq 0 -or [long]$hRaw -eq -1){return 'hook-conn'}
$hHeld=SupHookHeld $hk $hChild $hChildPid $hJob
if($hHeld -cne 'ok'){return ('hook-child-'+$hHeld)}
$hCp=[int[]]::new(1)
if(-not ($hk::GetNamedPipeClientProcessId($hRaw,$hCp) -and $hCp[0] -gt 0)){return 'hook-client-sample'}
$hClientPid=$hCp[0]
if($hClientPid -eq $hChildPid -or $hClientPid -eq $hWrapperPid){return 'hook-client-role'}
$hProc=$hk::OpenProcess(0x00101000,$false,$hClientPid)
if([long]$hProc -eq 0 -or [long]$hProc -eq -1){return 'hook-client-open'}
$hG=SupHookGuard $hk $hRaw $hProc $hClientPid $hChild $hChildPid $hJob
if($hG -cne 'ok'){return $hG}
$hN=0;$hGot=0;$hHello=[byte[]]::new(40)
while($hGot -lt 40){
$hX=SupHookXfer $hk $hConn $hRaw $false $hHello $hGot (40-$hGot) $hClock $hUntil $hCancel ([ref]$hN)
if($hX -cne 'ok'){if($hX -ceq 'unsettled'){$hSettled=$false};return (SupHookXferCode $hX 'hook-hello-io')}
if($hN -eq 0){return 'hook-hello-eof'}
$hGot+=$hN}
$hHelloLead=[byte[]](72,69,76,76,79,49,32)
for($hI=0;$hI -lt 7;$hI++){if($hHello[$hI] -ne $hHelloLead[$hI]){return 'hook-hello-malformed'}}
for($hI=7;$hI -lt 39;$hI++){$hB=$hHello[$hI];if(-not (($hB -ge 48 -and $hB -le 57) -or ($hB -ge 97 -and $hB -le 102))){return 'hook-hello-malformed'}}
if($hHello[39] -ne 10){return 'hook-hello-malformed'}
$hAvail=[int[]]::new(1);$hAvail[0]=-1
if(-not ($hk::PeekNamedPipe($hRaw,[IntPtr]::Zero,0,[IntPtr]::Zero,$hAvail,[IntPtr]::Zero) -and $hAvail[0] -eq 0)){return 'hook-hello-trailing'}
$hNonce=[Text.Encoding]::ASCII.GetString($hHello,7,32)
$hKeyBytes=[Text.Encoding]::ASCII.GetBytes([string]$hKey)
$hMac=[Security.Cryptography.HMACSHA256]::new($hKeyBytes)
$hSum=$hMac.ComputeHash([Text.Encoding]::ASCII.GetBytes('prg682-hook-v1|'+[string]$hRunId+'|'+$hNonce))
if($hSum.Length -ne 32){return 'hook-unexpected'}
$hDigits=[byte[]](48,49,50,51,52,53,54,55,56,57,97,98,99,100,101,102)
$hProofLead=[byte[]](80,82,79,79,70,32)
$hProof=[byte[]]::new(71)
for($hI=0;$hI -lt 6;$hI++){$hProof[$hI]=$hProofLead[$hI]}
for($hI=0;$hI -lt 32;$hI++){$hProof[6+2*$hI]=$hDigits[$hSum[$hI] -shr 4];$hProof[7+2*$hI]=$hDigits[$hSum[$hI] -band 15]}
$hProof[70]=10
$hG=SupHookGuard $hk $hRaw $hProc $hClientPid $hChild $hChildPid $hJob
if($hG -cne 'ok'){return $hG}
$hX=SupHookXfer $hk $hConn $hRaw $true $hProof 0 71 $hClock $hUntil $hCancel ([ref]$hN)
if($hX -cne 'ok'){if($hX -ceq 'unsettled'){$hSettled=$false};return (SupHookXferCode $hX 'hook-proof-io')}
$hGot=0;$hLf=-1;$hRec=[byte[]]::new(16384)
while($hLf -lt 0){
if($hGot -ge 16384){return 'hook-record-oversize'}
$hX=SupHookXfer $hk $hConn $hRaw $false $hRec $hGot (16384-$hGot) $hClock $hUntil $hCancel ([ref]$hN)
if($hX -cne 'ok'){if($hX -ceq 'unsettled'){$hSettled=$false};return (SupHookXferCode $hX 'hook-record-io')}
if($hN -eq 0){return 'hook-record-eof'}
for($hI=$hGot;$hI -lt ($hGot+$hN);$hI++){$hB=$hRec[$hI]
if($hB -eq 10){if($hI -ne ($hGot+$hN-1)){return 'hook-record-trailing'};$hLf=$hI}
elseif($hB -lt 32 -or $hB -gt 126){return 'hook-record-byte'}}
$hGot+=$hN}
$hAvail[0]=-1
$hPeek=$hk::PeekNamedPipe($hRaw,[IntPtr]::Zero,0,[IntPtr]::Zero,$hAvail,[IntPtr]::Zero);$hPeekErr=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
if($hPeek){if($hAvail[0] -ne 0){return 'hook-record-trailing'}}elseif($hPeekErr -ne 109){return 'hook-record-io'}
$hText=[Text.Encoding]::ASCII.GetString($hRec,0,$hLf)
$hM=[regex]::Match($hText,'^\{"v":1,"runId":"([A-Za-z0-9][A-Za-z0-9._:-]{0,127})","event":"SessionStart","sessionId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","socket":"\\\\\\\\\.\\\\pipe\\\\LOCAL\\\\([A-Za-z0-9._-]{1,200})","token":"([A-Za-z0-9+/=_.~-]{8,4096})"\}\z')
if(-not $hM.Success){return 'hook-candidate-malformed'}
if($hM.Groups[1].Value -cne [string]$hRunId){return 'hook-candidate-run'}
$hSeg=$hM.Groups[3].Value
$hEndpoint='\\.\pipe\LOCAL\'+$hSeg
if($hEndpoint -cnotmatch '^\\\\\.\\pipe\\LOCAL\\[A-Za-z0-9._-]{1,200}\z'){return 'hook-candidate-endpoint'}
if($hSeg -ceq '.' -or $hSeg -ceq '..' -or $hSeg.EndsWith('.',[StringComparison]::Ordinal)){return 'hook-candidate-endpoint'}
$hG=SupHookGuard $hk $hRaw $hProc $hClientPid $hChild $hChildPid $hJob
if($hG -cne 'ok'){return $hG}
if($hCancel.IsCancellationRequested){return 'hook-cancelled'}
if($hClock.ElapsedMilliseconds -ge $hUntil){return 'hook-timeout'}
$hOut.Value=@{SessionId=$hM.Groups[2].Value;Endpoint=$hEndpoint;Token=$hM.Groups[4].Value}
return 'candidate'
}catch{$hSettled=$false;try{$hOut.Value=$null}catch{};return 'hook-unexpected'}
finally{
if([long]$hProc -ne 0 -and [long]$hProc -ne -1){try{[void]$hk::CloseHandle($hProc)}catch{}}
if($null -ne $hMac){try{$hMac.Dispose()}catch{}}
if($null -ne $hKeyBytes){try{[Array]::Clear($hKeyBytes,0,$hKeyBytes.Length)}catch{}}
if($null -ne $hSum){try{[Array]::Clear($hSum,0,$hSum.Length)}catch{}}
if($hSettled){
if($null -ne $hHello){try{[Array]::Clear($hHello,0,$hHello.Length)}catch{}}
if($null -ne $hProof){try{[Array]::Clear($hProof,0,$hProof.Length)}catch{}}
if($null -ne $hRec){try{[Array]::Clear($hRec,0,$hRec.Length)}catch{}}}
$hText=$null;$hM=$null}}
`.trim();

/* --------------------------------------------------------- host contract */

/**
 * The explicit, narrow host contract a later slice must satisfy to call the
 * fixed function from the custody supervisor
 * (`WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE`). It is documentation
 * data only: nothing here is rendered, appended, or wired yet.
 */
export const WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT = Object.freeze({
  /**
   * The supervisor's existing in-memory kernel32 type (`$K`, built by `SupDef`
   * with `SetLastError` and `CharSet.Unicode`) and the existing methods the
   * function relies on, unchanged.
   */
  interopType: "$K",
  existingInterop: Object.freeze([
    "GetNamedPipeClientProcessId",
    "WaitForSingleObject",
    "GetProcessId",
    "IsProcessInJob",
    "CloseHandle",
  ] as const),
  /**
   * The three declarations a later slice must add to that same `SupDef` table,
   * in the supervisor's existing type aliases (`$TI` IntPtr, `$TN` int, `$TF`
   * bool, `$TA` int[]). None exists in the supervisor today.
   */
  additionalInteropDeclarations: Object.freeze([
    "SupDef 'OpenProcess' $TI @($TN,$TF,$TN)",
    "SupDef 'CancelIoEx' $TF @($TI,$TI)",
    "SupDef 'PeekNamedPipe' $TF @($TI,$TI,$TN,$TI,$TA,$TI)",
  ] as const),
  /**
   * Arguments, in order, mapped to the supervisor's existing custody state.
   * `$CH`/`$ChildPid` are set only by `SupChild` after the kernel checks behind
   * `SUP_CHILD`; `$Job` only by a matching `CONFIRM`; `$WPid` only by the
   * control pipe's kernel client PID. The run id and key are runtime values
   * that are never rendered into any source, argument, or environment; how
   * the supervisor obtains the key is a later slice.
   */
  arguments: Object.freeze([
    Object.freeze({ parameter: "$hk", source: "$K" }),
    Object.freeze({ parameter: "$hChild", source: "$CH" }),
    Object.freeze({ parameter: "$hChildPid", source: "$ChildPid" }),
    Object.freeze({ parameter: "$hJob", source: "$Job" }),
    Object.freeze({ parameter: "$hWrapperPid", source: "$WPid" }),
    Object.freeze({ parameter: "$hConn", source: "one accepted supervisor-owned hook NamedPipeServerStream (later slice)" }),
    Object.freeze({ parameter: "$hRunId", source: "runtime run id (never rendered)" }),
    Object.freeze({ parameter: "$hKey", source: "runtime per-run key (never rendered; provenance is a later slice)" }),
    Object.freeze({ parameter: "$hBudgetMs", source: "[int] 1..5000, at most the supervisor's remaining deadline" }),
    Object.freeze({ parameter: "$hCancel", source: "cancelable [Threading.CancellationToken] owned by the caller" }),
    Object.freeze({ parameter: "$hOut", source: "[ref] to a caller-owned variable" }),
  ] as const),
  /** Only in the supervisor's `run` phase (after `SUP_CHILD`), never earlier. */
  phase: "run",
  /**
   * What the caller must already guarantee about `$hConn`: created by the
   * supervisor itself (async, first instance, one instance, remote clients
   * rejected, protected DACL — all later slices), accepted exactly once, with
   * no other pending operation on it, and serviced by exactly one call.
   */
  connection: "caller-accepted-async-single-use-no-other-pending-io",
  /**
   * The function never disposes the connection; after any result the caller
   * disposes it and never reuses it (after `hook-unsettled`, disposing it is
   * what completes the abandoned operation).
   */
  connectionDisposal: "caller-disposes-after-every-result",
  /**
   * The post-record peek classification relies on the existing `SupDef`
   * attribute `SetLastError=true`; the error is read with
   * `[Runtime.InteropServices.Marshal]::GetLastWin32Error()` in the same
   * statement line as the `PeekNamedPipe` call, and only `ERROR_BROKEN_PIPE`
   * means "peer closed, nothing queued".
   */
  lastError: "supdef-setlasterror-read-immediately-after-peek",
  /** The retained client process handle never leaves the function. */
  clientHandle: "opened-retained-and-closed-once-inside",
  /** On `candidate` only: a fresh `@{SessionId;Endpoint;Token}` in the caller's `[ref]`. */
  output: "candidate-hashtable-in-caller-ref-only",
  /** Worst-case blocking time: the budget plus one cancellation grace. */
  maxBlockingMs: 5000 + 1000,
});
