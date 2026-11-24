/**
 * #682 native Windows Claude inbox — INACTIVE single-attempt authenticated write.
 *
 * ## What this module is
 *
 * The data-plane step a later custody-supervisor slice needs after it has
 * received one hook candidate and after its own authorization, binding,
 * scheduling, and one-shot admission have all passed: a FIXED Windows
 * PowerShell 5.1 function source ({@link WINDOWS_CLAUDE_INBOX_WRITE_SOURCE},
 * no placeholders, nothing rendered into it) that opens the candidate's inbox
 * pipe through the landed exact peer-open helper, rechecks the retained child
 * on that SAME handle, and performs AT MOST ONE overlapped write of the two
 * proven Claude inbox NDJSON lines. It also exports the closed result codes,
 * their dispositions, and the narrow host contract a later slice must satisfy
 * to call it.
 *
 * It is deliberately inert: no product path imports it, it has no imports of
 * its own, it spawns nothing, opens nothing from Node, and renders no token,
 * session id, endpoint, or message into any source, argument, environment, or
 * output. It is not a generic pipe API: the only endpoint it can reach is the
 * one in an already validated candidate, and the only bytes it can write are
 * the fixed Claude auth/user frames.
 *
 * ## Caller responsibilities (never performed here)
 *
 * Authentication of the hook record, binding the candidate to the live root
 * session, scheduling, and ONE-SHOT ADMISSION of the callback content are the
 * caller's. The caller must invoke this function at most once per admitted
 * content and must never call it again for that content after any result
 * other than a `not-sent-*` code it has chosen to handle itself; the function
 * never retries internally.
 *
 * ## Inputs (validated without coercion, before anything is opened)
 *
 * - the supervisor's interop type and its retained direct child: creation
 *   handle, established PID, and confirmed job handle (exactly the arguments
 *   the landed peer-open helper takes);
 * - the in-memory candidate hashtable with exactly the keys `SessionId`,
 *   `Endpoint`, and `Token`, each a string re-matched against the hook
 *   receiver's grammar (canonical lowercase UUID; `\\.\pipe\LOCAL\` plus one
 *   segment with the dot rule; the PoC token alphabet, 8..4096 characters);
 * - one already admitted content string: non-empty, well-formed UTF-16
 *   (a strict UTF-8 encoder refuses lone surrogates), at most 64 KiB of UTF-8;
 * - a caller-owned monotonic budget: a RUNNING `Diagnostics.Stopwatch` and an
 *   `[long]` expiry on that clock. The function's own `Stopwatch` is started
 *   FIRST, and only then is the caller's remaining time read ONCE; it must be
 *   at most 5000 ms, and the private deadline is that remaining time minus
 *   1 ms (the caller's `ElapsedMilliseconds` is truncated). Any pause between
 *   the two clock reads is therefore charged against the attempt, never
 *   granted to it, and a caller clock that is later stopped, reset, or
 *   restarted can neither extend nor freeze the attempt. The private
 *   deadline is rechecked before the candidate is touched;
 * - a genuine cancelable `CancellationToken` (one that can never be canceled
 *   is refused);
 * - a `[ref]` counter that receives the number of bytes the kernel reports
 *   written on `sent-unconfirmed` and 0 on every other result.
 *
 * ## Sequence
 *
 * 1. inputs, candidate, and content are validated; cancellation and the
 *    deadline are checked;
 * 2. the content is JSON-escaped exactly like `JSON.stringify` (backslash and
 *    quote first, then the 32 C0 controls: `\b \t \n \f \r` short forms and
 *    `\u00xx` lowercase otherwise; everything else, including DEL and U+2028,
 *    passes through as UTF-8) and the USER frame — which carries no secret —
 *    is formed and refused if it exceeds 128 KiB including its LF;
 * 3. cancellation and the deadline are checked again, and only then is the
 *    landed peer-open helper called ONCE with the candidate endpoint. Every
 *    peer refusal maps to `not-sent-<peer code>`; nothing is retried;
 * 4. guard on the SAME returned handle (no reopen): the retained child is
 *    rechecked with the landed retained-child check, the kernel server PID of
 *    that handle still equals the established child PID, and cancellation and
 *    the deadline still allow the attempt;
 * 5. only now is the AUTH frame (`{"type":"auth","token":...}`, no
 *    `session_id`) formed; both frames are encoded into one exactly sized
 *    managed buffer, copied into one unmanaged buffer that cannot move while
 *    the kernel reads it, and the managed copy is cleared at once. One
 *    manual-reset event and one zeroed `OVERLAPPED` (event at offset
 *    `2*IntPtr.Size+8`) are prepared;
 * 6. guard again, immediately before the first byte;
 * 7. exactly ONE overlapped `WriteFile` of the whole buffer on that handle.
 *    Its state is read only from the same `OVERLAPPED`: pending while
 *    `Internal` is `STATUS_PENDING` or `GetOverlappedResult` reports
 *    `ERROR_IO_INCOMPLETE`; otherwise `GetOverlappedResult` (never waiting)
 *    yields the native outcome and the transferred byte count. Pending writes
 *    are awaited on the event in 25 ms slices against the token and the
 *    function's deadline. On cancellation or timeout the function calls
 *    `CancelIoEx` for exactly that `OVERLAPPED` and waits at most 1000 ms for
 *    it to settle;
 * 8. after a completed write, cancellation and the deadline are rechecked
 *    BEFORE success is reported, and success additionally requires the native
 *    result to be success with exactly the full buffer length transferred.
 *
 * ## Transport (authorized native overlapped write)
 *
 * The one write is a native overlapped `WriteFile` on the exact handle the
 * landed peer-open helper proved, as authorized for this slice in place of
 * the PoC's `SafeFileHandle` + .NET `FileStream` write. On the .NET Framework
 * that hosts Windows PowerShell 5.1, a `FileStream` write completes NORMALLY
 * when the native write failed with `ERROR_NO_DATA` or `ERROR_BROKEN_PIPE`
 * (a closing peer) and never exposes the transferred byte count, so framework
 * task completion could mask a dropped frame. Completion evidence therefore
 * comes only from the native result and byte count on that same handle and
 * `OVERLAPPED`; framework task completion is NEVER used as proof of a write.
 * The only interop this adds to the trusted in-memory stock PS5.1 type is
 * `CreateEventW`, `WriteFile`, and `GetOverlappedResult` (see
 * {@link WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT}); there is no new binary,
 * compiler, or policy change.
 *
 * ## Results (closed; see {@link classifyWindowsClaudeInboxWriteResult})
 *
 * - `not-sent-*`: returned only before the write was invoked; nothing was
 *   handed to the pipe (the handle, if opened, is closed with zero bytes).
 * - `sent-unconfirmed`: the one write completed with native success and the
 *   full byte count, before cancellation and the deadline. The inbox returns
 *   no reply, so this is never a delivery, placement, or acknowledgment.
 * - `unknown-*`: the write was invoked and then failed (`io`: a synchronous
 *   native failure such as `ERROR_NO_DATA`, a failed completion, or a short
 *   byte count), was canceled, timed out (including a completion observed
 *   only after cancellation or the deadline), stayed pending after the grace
 *   (`unknown-unsettled`), or an unexpected exception followed the invocation
 *   (`unknown-unexpected`). Some bytes may have reached the peer; the caller
 *   must never resend that content automatically.
 *
 * The function writes nothing to stdout, stderr, the environment, argv, or any
 * file; it never throws, exits, or calls a supervisor failure path, and no
 * result ever reflects the token, session id, endpoint, or content.
 *
 * ## Ownership and cleanup
 *
 * From a successful peer open onward the function owns the pipe handle, and
 * it also owns the event handle, the `OVERLAPPED`, and the unmanaged frame
 * buffer it creates. The managed frame buffer is never given to the kernel
 * and is cleared on every path. Every other resource is released in the
 * `finally` only when no write can be pending (`$qSettled`): then the pipe and
 * the event are each closed with exactly ONE `CloseHandle`, and the unmanaged
 * buffer is zeroed and freed together with the `OVERLAPPED`.
 *
 * When settlement is unproven (`unknown-unsettled`, or `unknown-unexpected`
 * after the write was invoked) NOTHING the pending write could touch is
 * released: the exact pipe handle, event handle, `OVERLAPPED`, and unmanaged
 * buffer are deliberately retained for the life of the process — never
 * closed, freed, cleared, or reused (bounded by one frame pair and two
 * handles per poisoned invocation). `CancelIoEx` has been requested for that
 * `OVERLAPPED` exactly once on both paths: by the timeout/cancellation path
 * before its bounded grace, or — when an unexpected exception follows the
 * write's submission and no cancellation was requested yet — by the `catch`,
 * which never waits, restarts a grace, or retries the write; the caller must treat the candidate and its inbox as
 * poisoned and never reuse them. .NET strings are immutable and cannot be
 * cleared: the function drops its own references.
 *
 * Windows-side inert runtime evidence of this function remains later work.
 */

/* ------------------------------------------------------------- constants */

/** Fixed byte and time limits; each appears as a literal in the fixed source. */
export const WINDOWS_CLAUDE_INBOX_WRITE_LIMITS = Object.freeze({
  /** Largest admitted content, in UTF-8 bytes (the TS sender's text bound). */
  contentMaxBytes: 65536,
  /** Largest single frame line including its LF (the TS sender's frame bound). */
  frameMaxBytes: 131072,
  /** Largest total write: two frames. */
  totalMaxBytes: 262144,
  /** Largest remaining caller budget accepted at entry, in milliseconds. */
  budgetMaxMs: 5000,
  /** Longest wait for a canceled write to settle, in milliseconds. */
  cancelGraceMs: 1000,
  /** Longest single wait slice between cancellation/deadline checks. */
  waitSliceMs: 25,
  tokenMinChars: 8,
  tokenMaxChars: 4096,
});

/** Candidate keys, the only ones accepted (the hook receiver's in-memory output). */
export const WINDOWS_CLAUDE_INBOX_WRITE_CANDIDATE_KEYS = Object.freeze(["SessionId", "Endpoint", "Token"] as const);

/** Win32 constants used by the fixed function (documented values). */
export const WINDOWS_CLAUDE_INBOX_WRITE_WIN32 = Object.freeze({
  /** `CreateFileW` failure sentinel, never an owned handle. */
  INVALID_HANDLE_VALUE: -1,
  /** `WriteFile` returned FALSE with this error: the write is pending. */
  ERROR_IO_PENDING: 997,
  /** `GetOverlappedResult(bWait=FALSE)` on a write that is still pending. */
  ERROR_IO_INCOMPLETE: 996,
  /** `OVERLAPPED.Internal` while the write is pending (`HasOverlappedIoCompleted`). */
  STATUS_PENDING: 0x103,
});

/* ---------------------------------------------------------------- results */

/**
 * The landed peer-open helper's refusal codes, repeated here so this module
 * has no imports; the tests pin equality with the peer module.
 */
export const WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS = Object.freeze([
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
] as const);

/** The landed retained-child check codes (everything except `ok`). */
export const WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS = Object.freeze([
  "child-handle",
  "child-pid",
  "job-handle",
  "child-not-live",
  "child-not-in-job",
] as const);

type PeerRefusal = (typeof WINDOWS_CLAUDE_INBOX_WRITE_PEER_REFUSALS)[number];
type HeldCheck = (typeof WINDOWS_CLAUDE_INBOX_WRITE_HELD_CHECKS)[number];

/** Results returned only before the write was invoked: nothing was handed to the pipe. */
export const WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT = Object.freeze([
  "not-sent-input",
  "not-sent-cancelled",
  "not-sent-timeout",
  "not-sent-candidate",
  "not-sent-content",
  "not-sent-oversize",
  "not-sent-peer-endpoint",
  "not-sent-peer-pre-child-handle",
  "not-sent-peer-pre-child-pid",
  "not-sent-peer-pre-job-handle",
  "not-sent-peer-pre-child-not-live",
  "not-sent-peer-pre-child-not-in-job",
  "not-sent-peer-open",
  "not-sent-peer-inherit",
  "not-sent-peer-server-pid",
  "not-sent-peer-server-mismatch",
  "not-sent-peer-post-child-handle",
  "not-sent-peer-post-child-pid",
  "not-sent-peer-post-job-handle",
  "not-sent-peer-post-child-not-live",
  "not-sent-peer-post-child-not-in-job",
  "not-sent-peer-unexpected",
  "not-sent-held-child-handle",
  "not-sent-held-child-pid",
  "not-sent-held-job-handle",
  "not-sent-held-child-not-live",
  "not-sent-held-child-not-in-job",
  "not-sent-server",
  "not-sent-event",
  "not-sent-unexpected",
] as const) satisfies readonly (
  | `not-sent-${"input" | "cancelled" | "timeout" | "candidate" | "content" | "oversize"}`
  | `not-sent-${PeerRefusal}`
  | `not-sent-held-${HeldCheck}`
  | `not-sent-${"server" | "event" | "unexpected"}`
)[];

/** Results after the write was invoked: some bytes may have reached the peer. */
export const WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN = Object.freeze([
  "unknown-io",
  "unknown-cancelled",
  "unknown-timeout",
  "unknown-unsettled",
  "unknown-unexpected",
] as const);

/** The only success: the one write completed locally, unconfirmed by the peer. */
export const WINDOWS_CLAUDE_INBOX_WRITE_SENT = "sent-unconfirmed";

export type WindowsClaudeInboxWriteNotSent = (typeof WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT)[number];
export type WindowsClaudeInboxWriteUnknown = (typeof WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN)[number];

/** Every value the fixed function returns. */
export type WindowsClaudeInboxWriteResult =
  | WindowsClaudeInboxWriteNotSent
  | typeof WINDOWS_CLAUDE_INBOX_WRITE_SENT
  | WindowsClaudeInboxWriteUnknown;

export type WindowsClaudeInboxWriteDisposition = "not_sent" | "sent_unconfirmed" | "unknown";

/**
 * A classified result. `settled` is false only when a write may still be
 * pending (`unknown-unsettled`) or its state is unproven after an unexpected
 * exception (`unknown-unexpected`); the frame buffer was then left uncleared
 * and the caller must poison the candidate and inbox, never reusing them.
 */
export interface WindowsClaudeInboxWriteClassification {
  readonly code: WindowsClaudeInboxWriteResult;
  readonly disposition: WindowsClaudeInboxWriteDisposition;
  readonly settled: boolean;
}

/** Closed classification of a value returned by the fixed function; anything else is `undefined`. */
export function classifyWindowsClaudeInboxWriteResult(value: unknown): WindowsClaudeInboxWriteClassification | undefined {
  if (typeof value !== "string") return undefined;
  if (value === WINDOWS_CLAUDE_INBOX_WRITE_SENT) {
    return Object.freeze({ code: WINDOWS_CLAUDE_INBOX_WRITE_SENT, disposition: "sent_unconfirmed" as const, settled: true });
  }
  if ((WINDOWS_CLAUDE_INBOX_WRITE_NOT_SENT as readonly string[]).includes(value)) {
    return Object.freeze({ code: value as WindowsClaudeInboxWriteNotSent, disposition: "not_sent" as const, settled: true });
  }
  if ((WINDOWS_CLAUDE_INBOX_WRITE_UNKNOWN as readonly string[]).includes(value)) {
    const settled = value !== "unknown-unsettled" && value !== "unknown-unexpected";
    return Object.freeze({ code: value as WindowsClaudeInboxWriteUnknown, disposition: "unknown" as const, settled });
  }
  return undefined;
}

/* ---------------------------------------------------------- fixed source */

/** Name of the fixed entry function defined by {@link WINDOWS_CLAUDE_INBOX_WRITE_SOURCE}. */
export const WINDOWS_CLAUDE_INBOX_WRITE_FUNCTION = "SupInboxSend";

/** Names of the fixed private helpers it defines, in definition order. */
export const WINDOWS_CLAUDE_INBOX_WRITE_HELPER_FUNCTIONS = Object.freeze(["SupInboxGuard", "SupInboxPoll"] as const);

/**
 * The landed functions this source calls but never defines; their fixed
 * source must already be dot-sourced in the same supervisor scope.
 */
export const WINDOWS_CLAUDE_INBOX_WRITE_COMPOSED_FUNCTIONS = Object.freeze(["SupPeerHeld", "SupPeerOpen"] as const);

/**
 * The fixed Windows PowerShell 5.1 source: three function definitions and
 * nothing else (no top-level statement runs when it is dot-sourced). It has no
 * placeholders; the candidate, content, clock, and token arrive only as
 * runtime arguments and nothing is ever printed. Printable ASCII and LF only,
 * so it can later travel inside the supervisor's existing startup frame.
 *
 * PowerShell 5.1 syntax only; no backticks, no `${...}`; every variable uses
 * the reserved `q` prefix and is distinct (ignoring case) from every
 * supervisor script variable and from the automatic variables.
 */
export const WINDOWS_CLAUDE_INBOX_WRITE_SOURCE = String.raw`
function SupInboxGuard([Type]$qk,[IntPtr]$qPipe,[IntPtr]$qChild,[int]$qChildPid,[IntPtr]$qJob,[Diagnostics.Stopwatch]$qOwn,[long]$qEnd,[Threading.CancellationToken]$qCancel){
$qHeld=SupPeerHeld $qk $qChild $qChildPid $qJob
if($qHeld -cne 'ok'){return ('not-sent-held-'+$qHeld)}
$qServer=[int[]]::new(1)
if(-not ($qk::GetNamedPipeServerProcessId($qPipe,$qServer) -and $qServer[0] -eq $qChildPid)){return 'not-sent-server'}
if($qCancel.IsCancellationRequested){return 'not-sent-cancelled'}
if($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}
return 'ok'}
function SupInboxPoll([Type]$qk,[IntPtr]$qPipe,[IntPtr]$qOv,[int[]]$qDone){
$qDone[0]=-1
if([long][Runtime.InteropServices.Marshal]::ReadIntPtr($qOv,0) -eq 259){return 'pending'}
$qR=$qk::GetOverlappedResult($qPipe,$qOv,$qDone,$false);$qE=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
if($qR){return 'done'}
if($qE -eq 996){return 'pending'}
return 'failed'}
function SupInboxSend([Type]$qk,[IntPtr]$qChild,[int]$qChildPid,[IntPtr]$qJob,[object]$qCand,[object]$qText,[object]$qClock,[object]$qUntil,[object]$qCancel,[ref]$qSent){
try{$qSent.Value=0}catch{return 'not-sent-unexpected'}
$qPipe=[IntPtr]::Zero;$qEvt=[IntPtr]::Zero;$qOv=[IntPtr]::Zero;$qMem=[IntPtr]::Zero;$qLen=0;$qBuf=$null;$qStarted=$false;$qSettled=$true;$qCxl=$false;$qTok=$null;$qEsc=$null;$qUser=$null;$qAuth=$null
try{
if($qCancel -isnot [Threading.CancellationToken]){return 'not-sent-input'}
if(-not $qCancel.CanBeCanceled){return 'not-sent-input'}
if($qClock -isnot [Diagnostics.Stopwatch]){return 'not-sent-input'}
if(-not $qClock.IsRunning){return 'not-sent-input'}
if($qUntil -isnot [long]){return 'not-sent-input'}
$qOwn=[Diagnostics.Stopwatch]::StartNew()
$qRem=$qUntil-$qClock.ElapsedMilliseconds
if($qRem -gt 5000){return 'not-sent-input'}
if($qCancel.IsCancellationRequested){return 'not-sent-cancelled'}
if($qRem -le 1){return 'not-sent-timeout'}
$qEnd=[long]$qRem-1
if($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}
if($qCand -isnot [hashtable]){return 'not-sent-candidate'}
if($qCand.Count -ne 3){return 'not-sent-candidate'}
if(-not ($qCand.ContainsKey('SessionId') -and $qCand.ContainsKey('Endpoint') -and $qCand.ContainsKey('Token'))){return 'not-sent-candidate'}
$qSid=$qCand['SessionId'];$qEndpoint=$qCand['Endpoint'];$qTok=$qCand['Token']
if($qSid -isnot [string] -or $qEndpoint -isnot [string] -or $qTok -isnot [string]){return 'not-sent-candidate'}
if($qSid -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'){return 'not-sent-candidate'}
if($qEndpoint -cnotmatch '^\\\\\.\\pipe\\LOCAL\\[A-Za-z0-9._-]{1,200}\z'){return 'not-sent-candidate'}
if($qEndpoint.EndsWith('.',[StringComparison]::Ordinal)){return 'not-sent-candidate'}
if($qTok -cnotmatch '^[A-Za-z0-9+/=_.~-]{8,4096}\z'){return 'not-sent-candidate'}
if($qText -isnot [string]){return 'not-sent-content'}
if($qText.Length -eq 0){return 'not-sent-content'}
if($qText.Length -gt 65536){return 'not-sent-oversize'}
$qUtf8=[Text.UTF8Encoding]::new($false,$true)
$qN=-1
try{$qN=$qUtf8.GetByteCount([string]$qText)}catch{return 'not-sent-content'}
if($qN -lt 1){return 'not-sent-content'}
if($qN -gt 65536){return 'not-sent-oversize'}
$qEsc=([string]$qText).Replace('\','\\').Replace('"','\"')
for($qI=0;$qI -lt 32;$qI++){
if($qI -eq 8){$qR='\b'}elseif($qI -eq 9){$qR='\t'}elseif($qI -eq 10){$qR='\n'}elseif($qI -eq 12){$qR='\f'}elseif($qI -eq 13){$qR='\r'}else{$qR='\u'+$qI.ToString('x4')}
$qEsc=$qEsc.Replace([string][char]$qI,$qR)}
$qUser='{"type":"user","session_id":"'+$qSid+'","message":{"role":"user","content":"'+$qEsc+'"}}'+[string][char]10
$qUserN=$qUtf8.GetByteCount($qUser)
if($qUserN -gt 131072){return 'not-sent-oversize'}
if($qCancel.IsCancellationRequested){return 'not-sent-cancelled'}
if($qOwn.ElapsedMilliseconds -ge $qEnd){return 'not-sent-timeout'}
$qPeer=SupPeerOpen $qk $qChild $qChildPid $qJob $qEndpoint ([ref]$qPipe)
if($qPeer -isnot [string]){return 'not-sent-unexpected'}
if($qPeer -cne 'ok'){return ('not-sent-'+$qPeer)}
if([long]$qPipe -eq 0 -or [long]$qPipe -eq -1){return 'not-sent-unexpected'}
$qG=SupInboxGuard $qk $qPipe $qChild $qChildPid $qJob $qOwn $qEnd $qCancel
if($qG -cne 'ok'){return $qG}
$qAuth='{"type":"auth","token":"'+$qTok+'"}'+[string][char]10
$qAuthN=$qUtf8.GetByteCount($qAuth)
if($qAuthN -gt 131072){return 'not-sent-oversize'}
$qLen=$qAuthN+$qUserN
$qBuf=[byte[]]::new($qLen)
if($qUtf8.GetBytes($qAuth,0,$qAuth.Length,$qBuf,0) -ne $qAuthN){return 'not-sent-unexpected'}
if($qUtf8.GetBytes($qUser,0,$qUser.Length,$qBuf,$qAuthN) -ne $qUserN){return 'not-sent-unexpected'}
$qEvt=$qk::CreateEventW([IntPtr]::Zero,$true,$false,[IntPtr]::Zero)
if([long]$qEvt -eq 0){return 'not-sent-event'}
$qOvN=3*[IntPtr]::Size+8
$qOv=[Runtime.InteropServices.Marshal]::AllocHGlobal($qOvN)
[Runtime.InteropServices.Marshal]::Copy([byte[]]::new($qOvN),0,$qOv,$qOvN)
[Runtime.InteropServices.Marshal]::WriteIntPtr($qOv,2*[IntPtr]::Size+8,$qEvt)
$qMem=[Runtime.InteropServices.Marshal]::AllocHGlobal($qLen)
[Runtime.InteropServices.Marshal]::Copy($qBuf,0,$qMem,$qLen)
[Array]::Clear($qBuf,0,$qLen)
$qG=SupInboxGuard $qk $qPipe $qChild $qChildPid $qJob $qOwn $qEnd $qCancel
if($qG -cne 'ok'){return $qG}
$qStarted=$true
$qOk=$qk::WriteFile($qPipe,$qMem,$qLen,[IntPtr]::Zero,$qOv);$qErr=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
if(-not $qOk -and $qErr -ne 997){return 'unknown-io'}
$qDone=[int[]]::new(1);$qWhy='ok'
$qP=SupInboxPoll $qk $qPipe $qOv $qDone
while($qP -ceq 'pending'){
if($qCancel.IsCancellationRequested){$qWhy='cancelled';break}
$qLeft=$qEnd-$qOwn.ElapsedMilliseconds
if($qLeft -le 0){$qWhy='timeout';break}
[void]$qk::WaitForSingleObject($qEvt,[int][Math]::Min(25,$qLeft))
$qP=SupInboxPoll $qk $qPipe $qOv $qDone}
if($qWhy -cne 'ok'){
$qCxl=$true;try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}
$qGrace=[Diagnostics.Stopwatch]::StartNew()
$qP=SupInboxPoll $qk $qPipe $qOv $qDone
while($qP -ceq 'pending'){
$qLeft=1000-$qGrace.ElapsedMilliseconds
if($qLeft -le 0){break}
[void]$qk::WaitForSingleObject($qEvt,[int][Math]::Min(25,$qLeft))
$qP=SupInboxPoll $qk $qPipe $qOv $qDone}
if($qP -ceq 'pending'){$qSettled=$false;return 'unknown-unsettled'}
return ('unknown-'+$qWhy)}
if($qCancel.IsCancellationRequested){return 'unknown-cancelled'}
if($qOwn.ElapsedMilliseconds -ge $qEnd){return 'unknown-timeout'}
if($qP -cne 'done'){return 'unknown-io'}
if($qDone[0] -ne $qLen){return 'unknown-io'}
$qSent.Value=$qLen
return 'sent-unconfirmed'
}catch{try{$qSent.Value=0}catch{};if($qStarted){$qSettled=$false;if(-not $qCxl){$qCxl=$true;try{[void]$qk::CancelIoEx($qPipe,$qOv)}catch{}};return 'unknown-unexpected'};return 'not-sent-unexpected'}
finally{
if($null -ne $qBuf){try{[Array]::Clear($qBuf,0,$qBuf.Length)}catch{}}
if($qSettled){
if([long]$qPipe -ne 0 -and [long]$qPipe -ne -1){try{[void]$qk::CloseHandle($qPipe)}catch{}}
if([long]$qEvt -ne 0){try{[void]$qk::CloseHandle($qEvt)}catch{}}
if([long]$qMem -ne 0){try{[Runtime.InteropServices.Marshal]::Copy([byte[]]::new($qLen),0,$qMem,$qLen)}catch{};try{[Runtime.InteropServices.Marshal]::FreeHGlobal($qMem)}catch{}}
if([long]$qOv -ne 0){try{[Runtime.InteropServices.Marshal]::FreeHGlobal($qOv)}catch{}}}
$qTok=$null;$qAuth=$null;$qUser=$null;$qEsc=$null}}
`.trim();

/* --------------------------------------------------------- host contract */

/**
 * The explicit, narrow host contract a later slice must satisfy to call the
 * fixed function from the custody supervisor
 * (`WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE`). It is documentation
 * data only: nothing here is rendered, appended, or wired yet.
 */
export const WINDOWS_CLAUDE_INBOX_WRITE_HOST_CONTRACT = Object.freeze({
  /** The supervisor's existing in-memory kernel32 type (`$K`, built by `SupDef`). */
  interopType: "$K",
  /** Existing supervisor declarations this source calls directly, unchanged. */
  existingInterop: Object.freeze(["CloseHandle", "WaitForSingleObject"] as const),
  /**
   * Declarations this source calls directly that the supervisor does not have
   * yet and that the landed peer-open and hook-receive host contracts already
   * require, verbatim, in the supervisor's type aliases.
   */
  landedContractInteropDeclarations: Object.freeze([
    "SupDef 'GetNamedPipeServerProcessId' $TF @($TI,$TA)",
    "SupDef 'CancelIoEx' $TF @($TI,$TI)",
  ] as const),
  /**
   * Declarations only this source needs, in the same aliases: the event, the
   * one overlapped write, and its non-waiting completion query.
   */
  newInteropDeclarations: Object.freeze([
    "SupDef 'CreateEventW' $TI @($TI,$TF,$TF,$TI)",
    "SupDef 'WriteFile' $TF @($TI,$TI,$TN,$TI,$TI)",
    "SupDef 'GetOverlappedResult' $TF @($TI,$TI,$TA,$TF)",
  ] as const),
  /**
   * Completion is classified with `GetLastWin32Error` read in the same
   * statement line as `WriteFile`/`GetOverlappedResult`, relying on the
   * existing `SupDef` attribute `SetLastError=true`.
   */
  lastError: "supdef-setlasterror-read-immediately-after-call",
  /**
   * The landed peer-open fixed source (`WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE`)
   * must be dot-sourced first, with its own host contract satisfied; this
   * source calls its functions and never redefines them.
   */
  composedSource: "WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE",
  /**
   * The authorized transport (see the module comment): one native overlapped
   * `WriteFile` on the peer-open handle in place of `SafeFileHandle`/
   * `FileStream`, with completion evidence only from that same handle.
   */
  transport: "authorized-native-overlapped-writefile-same-handle-native-completion-evidence",
  /**
   * Arguments, in order. `$CH`/`$ChildPid` are set only by `SupChild`;
   * `$Job` only by a matching `CONFIRM`. The candidate, content, and clock are
   * runtime values that are never rendered into any source, argument, or
   * environment.
   */
  arguments: Object.freeze([
    Object.freeze({ parameter: "$qk", source: "$K" }),
    Object.freeze({ parameter: "$qChild", source: "$CH" }),
    Object.freeze({ parameter: "$qChildPid", source: "$ChildPid" }),
    Object.freeze({ parameter: "$qJob", source: "$Job" }),
    Object.freeze({ parameter: "$qCand", source: "the hook receive helper's in-memory candidate, already authenticated and bound by the caller" }),
    Object.freeze({ parameter: "$qText", source: "one callback content string already admitted once by the caller" }),
    Object.freeze({ parameter: "$qClock", source: "caller-owned running [Diagnostics.Stopwatch]" }),
    Object.freeze({ parameter: "$qUntil", source: "[long] expiry on that clock, at most 5000 ms ahead and within the supervisor's remaining deadline" }),
    Object.freeze({ parameter: "$qCancel", source: "cancelable [Threading.CancellationToken] owned by the caller" }),
    Object.freeze({ parameter: "$qSent", source: "[ref] to a caller-owned counter variable" }),
  ] as const),
  /** Only in the supervisor's `run` phase (after `SUP_CHILD`), never earlier. */
  phase: "run",
  /** Auth, binding, scheduling, and one-shot admission are the caller's; one call per admitted content. */
  admission: "caller-admits-once-and-calls-at-most-once",
  /**
   * The pipe handle is opened and owned inside and never handed back; it is
   * closed exactly once when settled, and retained (never closed) otherwise.
   */
  pipeHandle: "opened-owned-inside-closed-once-when-settled-retained-when-unsettled",
  /** The deadline is the entry budget carried on the function's own monotonic clock. */
  deadline: "entry-budget-snapshot-on-own-stopwatch",
  /**
   * After `unknown-unsettled` or `unknown-unexpected` the exact unmanaged
   * buffer, `OVERLAPPED`, event handle, and pipe handle stay allocated and
   * open, and the caller poisons the candidate and inbox.
   */
  unsettled: "buffer-overlapped-event-and-pipe-retained-caller-poisons-and-never-reuses",
  /** Worst-case blocking time: the entry budget plus one cancellation grace. */
  maxBlockingMs: 5000 + 1000,
});
