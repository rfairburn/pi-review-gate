/**
 * #682 native Windows Claude custody — PowerShell launch rendering (production slice).
 *
 * ## What this module is
 *
 * The PowerShell side of the custody design: it RENDERS the two scripts and the
 * exact argv for (a) the node-pty wrapper launch and (b) the supervisor launch,
 * frames the supervisor's startup source, and classifies the two processes'
 * exit codes. It is pure rendering plus closed classification:
 *
 * - it spawns nothing, wires no PTY, no host, no settings, no eligibility gate;
 * - it sends nothing to any inbox and owns no hook channel (both are out of
 *   this slice);
 * - it never resolves `powershell.exe`: the caller's production resolver passes
 *   the trusted, absolute, parent-`SystemRoot` `System32\WindowsPowerShell\v1.0\
 *   powershell.exe` path in, and this module re-validates its shape.
 *
 * The driver-side transport (`attachNativeWindowsClaudeCustodyTransport`) is
 * already implemented elsewhere and is NOT duplicated here. The wire contract
 * implemented by the rendered supervisor is exactly
 * {@link WINDOWS_CLAUDE_CUSTODY_HANDSHAKE}.
 *
 * ## Custody (unchanged from the tested PoC design)
 *
 * Wrapper (hidden ConPTY child of node-pty, stock Windows PowerShell 5.1):
 * `-NoLogo -NoProfile -NonInteractive -EncodedCommand <fixed bootstrap>`;
 * refuses unless FullLanguage / PS 5.x / Windows >= 8; defines its kernel32
 * P/Invoke table IN MEMORY (Reflection.Emit: no Add-Type, no compiler, no file,
 * no child); creates a kill-on-close, no-breakaway job and joins it itself;
 * connects the launch-specific control pipe and authenticates the peer with
 * `GetNamedPipeServerProcessId` BEFORE the target exists; duplicates its job and
 * own process handles into the supervisor; only after `GO` starts the target
 * with exact argv and no environment/shell/working-directory override, verifies
 * the retained creation handle is in the job and names the reported PID, and
 * duplicates that handle to the supervisor; ignores CTRL_C for itself only,
 * after the child exists; settles the job under a bounded deadline; exits with
 * the child's code. Job handles: the wrapper holds a handle to the job it
 * created, so its own death closes only that handle; `KILL_ON_JOB_CLOSE` takes
 * every member only when the LAST handle closes — which holds for a wrapper that
 * dies before the supervisor promotes a duplicate, and no longer holds after it.
 *
 * Supervisor (stock Windows PowerShell 5.1 spawned DIRECTLY by the driver: no
 * shell, no PTY, `windowsHide`, NOT detached, private anonymous pipes):
 * the command line carries only a SHORT fixed bootstrap that opens the private
 * stdin ONCE as the single StreamReader, reads exactly one bounded startup frame
 * (`PRG-WCS1 <8 digits>\n` + that many ASCII bytes), pins its length AND its
 * SHA-256 against values compiled into the bootstrap, parses it, and dot-sources
 * it. That same reader then serves every later command, so no byte is read ahead
 * by anyone else. Later commands are consumed one character at a time and are
 * acted on only when a COMPLETE LF-terminated ASCII run of at most 18 characters
 * arrives: a bare CR, any other control byte, an over-long unterminated run, and
 * EOF with a partial command are refusals, never commands, and `CONFIRM`'s PID
 * never carries a leading zero. It creates ONE launch-specific control pipe
 * (FIRST_PIPE_INSTANCE, max 1 instance, remote clients rejected, never closed
 * until it exits), acquires the wrapper's job/wrapper/child handles only after
 * the kernel confirms the connecting client PID and the handles match, promotes
 * them only on a `CONFIRM <pid>` that matches, and HOLDS them until it has
 * witnessed an empty job. A zero job handle is refused outright: `IsProcessInJob`
 * treats NULL as "a member of ANY job", so a null handle proves nothing and would
 * otherwise let a wrapper that belongs to some unrelated job obtain `SUP_GO`. Losing
 * the control pipe BEFORE the `run` phase is a refusal, not a wait: the supervisor
 * takes its own nonzero `ctl-closed` path, which releases only its provisional
 * duplicates when nothing was confirmed and terminates the confirmed job once
 * `CONFIRM` promoted it. EOF after `SUP_CHILD` stays compatible with a natural
 * wrapper exit and a later `SETTLE`. Diagnostics go to stderr only; stdout is reserved for
 * the closed grammar.
 *
 * The rendered `maxMs` is a STARTUP/HANDSHAKE deadline only. It bounds every
 * phase before `run` and is re-checked immediately before each promotion
 * (`SUP_WRAPPER`, the `CONFIRM` job promotion, `CHILD-OK`, and `SUP_CHILD`) and
 * once more after `SUP_CHILD` is written, right before entering `run`, so a
 * handshake still incomplete at or after the deadline is never promoted: the
 * supervisor takes its existing `deadline` refusal instead, terminating the
 * exact confirmed job even if `SUP_CHILD` was already emitted. Once the exact
 * retained child has passed every PID/job/handle check and both `CHILD-OK` and
 * `SUP_CHILD` were written, the supervisor is in `run` and the startup deadline
 * no longer applies: a healthy row lives as long as the owner keeps the
 * private stdin open. Owner stdin EOF, a protocol refusal, and `SETTLE` still
 * end it through their existing bounded paths.
 *
 * ## Who terminates the job, and who must coordinate
 *
 * Before `CONFIRM` the supervisor holds no confirmed job: a refusal releases its
 * provisional duplicates and terminates nothing, because the kernel pipe-client
 * and handle checks prove only WHICH process connected, not that the driver owns
 * it. After `CONFIRM` the supervisor holds the confirmed job handle and is the
 * only party that force-terminates that job — on `SETTLE`, on a protocol
 * refusal (including owner stdin EOF), or on its startup deadline while the
 * handshake has not yet reached `run`. So once the job is confirmed, losing
 * EITHER process alone does not stop the target: the survivor still holds a job
 * handle, and `KILL_ON_JOB_CLOSE` waits for the last one. The wrapper does not
 * watch for supervisor loss, and in `run` the supervisor cannot act on wrapper
 * loss until `SETTLE` or owner stdin EOF. Coordinated shutdown is therefore the driver's
 * obligation — `settle()`, or killing both processes so the last handle closes.
 * Wiring that coordination is deliberately out of scope for this slice.
 *
 * ## Fail-closed
 *
 * Every rendering input is validated before any byte is produced; invalid input
 * throws and renders nothing. The rendered supervisor writes no stdout record
 * outside the grammar and exits nonzero (`SUPERVISOR_FAIL_BASE + stage`) for
 * every refusal, deadline, unsettled job, or contradictory peer; the rendered
 * wrapper prints one fixed `PRG_WRAP_FAIL[_tag] <stage> <win32error>` marker and
 * exits in its own reserved range. Neither script changes execution policy,
 * falls back to a shell, or treats console output as authority.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ shared */

/** Exit-code base of the wrapper's reserved refusal range ("PRG\0"). */
export const WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE = 0x5052_4700;

/** Exit code the wrapper gives to job members it terminates during settlement. */
export const WINDOWS_CLAUDE_CUSTODY_WRAPPER_TERMINATE_EXIT_CODE = 0x30;

/** Reviewed refusal stages, plus the custody stages the wrapper adds. */
export const WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_STAGES: Readonly<Record<string, number>> = Object.freeze({
  "language-mode": 1,
  "ps-version": 2,
  "os-version": 3,
  "interop-define": 4,
  "job-create": 5,
  "job-limit": 6,
  "job-assign": 7,
  "target-invalid": 8,
  "child-start": 9,
  "child-not-in-job": 10,
  "ctrl-ignore": 11,
  "settle-query": 12,
  "settle-timeout": 13,
  "unexpected": 15,
  "custody-connect": 16,
  "custody-peer": 17,
  "custody-inherit": 18,
  "custody-open": 19,
  "custody-dup": 20,
  "custody-refused": 21,
  "custody-io": 22,
});

/** Exit-code base of the supervisor's reserved refusal range ("PRH\0"). */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE = 0x5052_4800;

/** Terminate code the supervisor passes to `TerminateJobObject` for members. */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE = 0x30;

/** Supervisor runtime refusal stages (each exits `BASE + code`, nonzero). */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES: Readonly<Record<string, number>> = Object.freeze({
  "language-mode": 1,
  "ps-version": 2,
  "os-version": 3,
  "interop-define": 4,
  "pipe-create": 5,
  "ctrl-ignore": 6,
  "startup-reader": 7,
  deadline: 9,
  "stdin-closed": 10,
  "command-invalid": 11,
  unexpected: 15,
  "settle-no-job": 40,
  unsettled: 41,
  "child-unverified": 14,
  "hello-invalid": 16,
  "wrapper-handle-pid": 17,
  "wrapper-not-in-job": 18,
  "child-invalid": 19,
  "ctl-client-pid": 20,
  "ctl-unexpected": 21,
  "confirm-out-of-phase": 22,
  "confirm-pid-mismatch": 23,
  "go-write-failed": 24,
  "child-ok-write-failed": 25,
  "ctl-closed": 26,
});

/**
 * Fixed-bootstrap refusal stages. `startup-language-mode` is emitted by the
 * ConstrainedLanguage-safe branch (property read + `Write-Error` to STDERR +
 * literal exit code only); the rest by `SupBootFail`. None of them writes to
 * stdout: the production grammar reserves the supervisor's stdout entirely.
 */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES: Readonly<Record<string, number>> = Object.freeze({
  "startup-language-mode": 50,
  "startup-frame-timeout": 51,
  "startup-frame-missing": 52,
  "startup-frame-header": 53,
  "startup-frame-oversize": 54,
  "startup-frame-length": 55,
  "startup-frame-short": 56,
  "startup-frame-hash": 57,
  "startup-parse": 58,
  "startup-error": 59,
});

/** Largest accepted supervisor boot source body, in bytes (mirrors the transport). */
export const WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES = 64 * 1024;
/** Largest accepted supervisor stdout record, excluding its terminator (mirrors the transport). */
export const WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES = 96;
/** Fixed bootstrap header magic, followed by 8 decimal digits and `\n` (mirrors the transport). */
export const WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC = "PRG-WCS1 ";
/** Decimal digits in the bootstrap header's length field. */
export const WINDOWS_CLAUDE_CUSTODY_BOOT_LENGTH_DIGITS = 8;
/** Exact byte length of the bootstrap header. */
export const WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES =
  WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC.length + WINDOWS_CLAUDE_CUSTODY_BOOT_LENGTH_DIGITS + 1;
/** Bootstrap written → startup frame read (supervisor-side). */
export const WINDOWS_CLAUDE_CUSTODY_STARTUP_FRAME_MS = 15_000;

/** CreateProcess command-line bound (wrapper). */
export const WINDOWS_CLAUDE_CUSTODY_MAX_WINDOWS_COMMAND_LINE = 32_767;
/**
 * Measured bound for the supervisor's `-EncodedCommand` argument: a ~31.5K
 * command line threw EPERM, ~10.8K started fine. The bootstrap is kept far
 * below this; the supervisor SOURCE never travels on the command line.
 */
export const WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE = 8_192;

/**
 * How the driver must spawn the supervisor: private anonymous pipes (only the
 * driver holds the other ends), hidden, NOT detached (a detached PowerShell was
 * measured to exit 0 silently), never through a shell.
 */
export interface WindowsClaudeCustodySpawnOptions {
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
  readonly detached: false;
  readonly shell: false;
}

export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS: WindowsClaudeCustodySpawnOptions = Object.freeze({
  stdio: Object.freeze(["pipe", "pipe", "pipe"] as const),
  windowsHide: true,
  detached: false,
  shell: false,
});

/** Launch-specific control pipe name (local only; one instance per launch). */
export const WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN = /^prg682-ctl-[0-9a-f]{32}$/u;
/** Per-launch control nonce, echoed on every control-pipe frame. */
export const WINDOWS_CLAUDE_CUSTODY_NONCE_PATTERN = /^[0-9a-f]{32}$/u;
/** Optional per-launch suffix on the wrapper's terminal markers. */
export const WINDOWS_CLAUDE_CUSTODY_OUTCOME_TAG_PATTERN = /^[0-9a-f]{32}$/u;
/** Trusted Windows PowerShell 5.1 executable shape (the resolver supplies it). */
export const WINDOWS_CLAUDE_CUSTODY_POWERSHELL_PATTERN =
  /^[A-Za-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu;
/** Target executable shape accepted by the wrapper. */
export const WINDOWS_CLAUDE_CUSTODY_TARGET_PATTERN = /^[A-Za-z]:\\[^"*?<>|]+\.exe$/iu;

/* ------------------------------------------------------ handshake contract */

export type WindowsClaudeCustodyRecordKind = "ready" | "wrapper" | "go" | "child" | "settled" | "bye";

export interface WindowsClaudeCustodyHandshakeStep {
  readonly seq: number;
  readonly direction: "driver-to-supervisor" | "supervisor-to-driver";
  readonly kind: string;
  /** Exact literal or documented frame shape. */
  readonly wire: string;
  /** Closed pattern for a supervisor record; null for a driver frame. */
  readonly pattern: RegExp | null;
  /** What must be true before this is written or emitted. */
  readonly precondition: string;
}

/**
 * The complete, closed order of dialogue. Anything else — extra records,
 * reordering, duplicates, unsolicited text, a nonzero job count — is a
 * transport poison, never a success.
 */
export const WINDOWS_CLAUDE_CUSTODY_HANDSHAKE: readonly WindowsClaudeCustodyHandshakeStep[] = Object.freeze([
  Object.freeze({
    seq: 1,
    direction: "driver-to-supervisor" as const,
    kind: "boot",
    wire: "PRG-WCS1 <8 zero-padded decimal byte length>\\n<source bytes>",
    pattern: null,
    precondition:
      "supervisor already spawned with private anonymous stdio pipes, not detached, hidden; source is printable ASCII (plus TAB, CR, LF), 1..64 KiB; its length and SHA-256 are pinned in the supervisor's own command line",
  }),
  Object.freeze({
    seq: 2,
    direction: "supervisor-to-driver" as const,
    kind: "ready",
    wire: "SUP_READY <pid>",
    pattern: /^SUP_READY ([1-9][0-9]{0,9})$/u,
    precondition:
      "FullLanguage, PowerShell 5.x, Windows >= 8, control pipe created as the first and only instance with remote clients rejected, CTRL_C ignored for the supervisor itself; <pid> is this process's own PID and must equal the owned process's PID",
  }),
  Object.freeze({
    seq: 3,
    direction: "supervisor-to-driver" as const,
    kind: "wrapper",
    wire: "SUP_WRAPPER <pid> PROVISIONAL",
    pattern: /^SUP_WRAPPER ([1-9][0-9]{0,9}) PROVISIONAL$/u,
    precondition:
      "wrapper connected the launch-specific control pipe before its target existed; GetNamedPipeClientProcessId names <pid>; the duplicated wrapper handle's GetProcessId equals <pid>; that wrapper is a member of the duplicated job — a zero job handle is refused, because IsProcessInJob treats NULL as 'any job'; handles are held PROVISIONALLY and are never settled, queried, or terminated as a confirmed job",
  }),
  Object.freeze({
    seq: 4,
    direction: "driver-to-supervisor" as const,
    kind: "confirm",
    wire: "CONFIRM <pid>\\n",
    pattern: null,
    precondition:
      "written only when node-pty's current positive PID, read synchronously at the write fence, equals the reported wrapper PID; the supervisor acts on it only as a complete LF-terminated ASCII command of at most 18 characters, and <pid> never carries a leading zero",
  }),
  Object.freeze({
    seq: 5,
    direction: "supervisor-to-driver" as const,
    kind: "go",
    wire: "SUP_GO <pid>",
    pattern: /^SUP_GO ([1-9][0-9]{0,9})$/u,
    precondition:
      "CONFIRM named exactly the provisional wrapper PID; the provisional job and wrapper handles are now the held handles and the wrapper was told to create its target",
  }),
  Object.freeze({
    seq: 6,
    direction: "supervisor-to-driver" as const,
    kind: "child",
    wire: "SUP_CHILD <pid>",
    pattern: /^SUP_CHILD ([1-9][0-9]{0,9})$/u,
    precondition:
      "wrapper created the target inside the job with exact argv; its retained creation handle's GetProcessId equals <pid>, the handle is a job member, and the process is still alive; <pid> differs from the wrapper and supervisor PIDs",
  }),
  Object.freeze({
    seq: 7,
    direction: "driver-to-supervisor" as const,
    kind: "settle",
    wire: "SETTLE\\n",
    pattern: null,
    precondition: "the driver wants custody ended and witnessed; arrives as the same complete LF-terminated ASCII command, and nothing further is ever written afterwards",
  }),
  Object.freeze({
    seq: 8,
    direction: "supervisor-to-driver" as const,
    kind: "settled",
    wire: "SUP_SETTLED ACTIVE=<n> LISTED=<n>",
    pattern: /^SUP_SETTLED ACTIVE=(0|[1-9][0-9]{0,9}) LISTED=(0|[1-9][0-9]{0,9})$/u,
    precondition:
      "the wrapper's process handle was waited on, the job was force-terminated if it still had members, and both counts come from the kernel's own job queries inside the deadline; ONLY ACTIVE=0 LISTED=0 is settlement",
  }),
  Object.freeze({
    seq: 9,
    direction: "supervisor-to-driver" as const,
    kind: "bye",
    wire: "SUP_BYE",
    pattern: /^SUP_BYE$/u,
    precondition: "held job, wrapper, and child handles closed after the empty-job witness; then the supervisor exits 0",
  }),
]);

/* ------------------------------------------------------------- rendering */

/** Control characters (including NUL, CR, LF) can never be carried. */
function hasControl(text: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(text);
}

/**
 * A lone UTF-16 surrogate half is not a character. The script is encoded as
 * UTF-16LE for `-EncodedCommand`, so an unpaired half would travel as an
 * invalid code unit that the target host may repair, drop, or reject
 * unpredictably. Under the `u` flag this class matches ONLY unpaired halves:
 * a valid supplementary pair is one code point outside the range.
 */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDFFF]/u.test(text);
}

/**
 * MSDN / CommandLineToArgvW quoting for ONE argument, i.e. the rules
 * CreateProcess hands to the target's argv parser.
 */
export function quoteWindowsArg(arg: string): string {
  if (typeof arg !== "string" || hasControl(arg) || hasLoneSurrogate(arg)) throw new Error("argument must be a printable string without unpaired surrogates");
  if (arg.length > 0 && !/[\s"]/u.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return out + "\\".repeat(backslashes * 2) + '"';
}

/** Body of a PowerShell single-quoted literal (`'` doubled, incl. Unicode quote look-alikes). */
export function powerShellSingleQuotedBody(text: string): string {
  if (hasControl(text) || hasLoneSurrogate(text)) throw new Error("PowerShell literal must not contain control characters or unpaired surrogates");
  return text.replace(/['‘’‚‛]/gu, (q) => q + q);
}

/** The trusted, resolver-supplied absolute System32 Windows PowerShell 5.1 path. */
export function validatePowerShellPath(powershellPath: unknown): string {
  if (typeof powershellPath !== "string" || hasControl(powershellPath) || hasLoneSurrogate(powershellPath)) {
    throw new Error("powershellPath must be a printable string without unpaired surrogates");
  }
  if (!WINDOWS_CLAUDE_CUSTODY_POWERSHELL_PATTERN.test(powershellPath)) {
    throw new Error("powershellPath must be the SystemRoot Windows PowerShell 5.1 executable");
  }
  return powershellPath;
}

/** Absolute drive-letter path to an existing `.exe`, no wildcard metacharacters. */
export function validateTargetPath(target: unknown): string {
  if (typeof target !== "string" || hasControl(target) || hasLoneSurrogate(target)) throw new Error("target must be a printable string without unpaired surrogates");
  if (!WINDOWS_CLAUDE_CUSTODY_TARGET_PATTERN.test(target)) {
    throw new Error("target must be an absolute drive-letter path to a .exe");
  }
  return target;
}

/** `""` (untagged) or `_<32 lowercase hex>`; anything else is refused. */
export function custodyOutcomeSuffix(tag: unknown): string {
  if (tag === "" || tag === undefined) return "";
  if (typeof tag !== "string" || !WINDOWS_CLAUDE_CUSTODY_OUTCOME_TAG_PATTERN.test(tag)) {
    throw new Error("invalid outcome tag");
  }
  return `_${tag}`;
}

function checkPid(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new Error(`${what} must be a positive 31-bit integer`);
  }
  return value;
}

function checkMs(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${what} out of range`);
  }
  return value;
}

function checkHex32(value: unknown, what: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${what} is malformed`);
  return value;
}

/**
 * Single-pass placeholder substitution: a substituted literal can never be
 * re-scanned as a placeholder, and an unknown or leftover placeholder is a bug.
 */
function render(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const out = template.replace(/__([A-Z0-9_]+)__/gu, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`unbound placeholder ${match}`);
    used.add(key);
    return value;
  });
  for (const key of Object.keys(values)) {
    if (!used.has(key)) throw new Error(`unused placeholder value ${key}`);
  }
  return out.trim();
}

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function commandLineLength(powershellPath: string, args: readonly string[]): number {
  // node-pty appends arguments unquoted when they contain no space or quote;
  // every argument rendered here qualifies.
  return `"${powershellPath}" `.length + args.join(" ").length;
}

/* ------------------------------------------------------------ the wrapper */

/**
 * The wrapper's fixed bootstrap: the reviewed bootstrap plus the four custody
 * insertions, kept verbatim and in order. Placeholders:
 *
 * `__SMOKE__` `$true`/`$false`, `__FAIL_BASE__`/`__SETTLE_MS__`/`__SUP_PID__`/
 * `__CTL_CONNECT_MS__`/`__CTL_REPLY_MS__` decimal integers, `__TARGET__`/
 * `__ARGS__` PowerShell single-quoted literal bodies, `__OUTCOME_SUFFIX__` `""`
 * or `_<32 hex>`, `__CTL_PIPE__`/`__CTL_NONCE__` validated hex names.
 *
 * PowerShell 5.1 syntax only; no backticks, no `${...}`; every variable name is
 * distinct ignoring case.
 */
export const WINDOWS_CLAUDE_CUSTODY_WRAPPER_BOOTSTRAP_TEMPLATE = String.raw`
$ErrorActionPreference='Stop'
$Smoke=__SMOKE__;$FailBase=__FAIL_BASE__
function PrgFail([string]$stage,[int]$code,[int]$err){Write-Host "PRG_WRAP_FAIL__OUTCOME_SUFFIX__ $stage $err";exit ($FailBase+$code)}
if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){PrgFail 'language-mode' 1 0}
if($PSVersionTable.PSVersion.Major -ne 5){PrgFail 'ps-version' 2 0}
trap{PrgFail 'unexpected' 15 0}
if([Environment]::OSVersion.Version -lt [Version]'6.2'){PrgFail 'os-version' 3 0}
function PrgLastErr{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
try{
$Asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('PrgWrap'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$TB=$Asm.DefineDynamicModule('PrgWrap').DefineType('PrgWrapK',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$DI=[Runtime.InteropServices.DllImportAttribute]
$DC=$DI.GetConstructor([Type[]]@([string]))
$DF=[Reflection.FieldInfo[]]@($DI.GetField('SetLastError'),$DI.GetField('EntryPoint'))
function PrgDef([string]$name,[Type]$ret,[Type[]]$parms){$mb=$TB.DefineMethod($name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$ret,$parms);$mb.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($DC,[object[]]@('kernel32.dll'),$DF,[object[]]@($true,$name)))}
$TI=[IntPtr];$TY=[byte[]];$TN=[int];$TF=[bool]
PrgDef 'CreateJobObjectW' $TI @($TI,$TI)
PrgDef 'SetInformationJobObject' $TF @($TI,$TN,$TY,$TN)
PrgDef 'QueryInformationJobObject' $TF @($TI,$TN,$TY,$TN,$TI)
PrgDef 'AssignProcessToJobObject' $TF @($TI,$TI)
PrgDef 'IsProcessInJob' $TF @($TI,$TI,[int[]])
PrgDef 'OpenProcess' $TI @($TN,$TF,$TN)
PrgDef 'TerminateProcess' $TF @($TI,$TN)
PrgDef 'CloseHandle' $TF @($TI)
PrgDef 'SetConsoleCtrlHandler' $TF @($TI,$TF)
PrgDef 'GetProcessId' $TN @($TI)
PrgDef 'GetNamedPipeServerProcessId' $TF @($TI,[int[]])
PrgDef 'DuplicateHandle' $TF @($TI,$TI,$TI,[IntPtr[]],$TN,$TF,$TN)
PrgDef 'GetCurrentProcess' $TI @()
PrgDef 'GetHandleInformation' $TF @($TI,[int[]])
$K=$TB.CreateType()
}catch{PrgFail 'interop-define' 4 0}
$Is64=[IntPtr]::Size -eq 8
$LimLen=if($Is64){144}else{112};$LimApOff=if($Is64){40}else{28}
function PrgLimit([int]$flags,[int]$activeMax){$lb=[byte[]]::new($LimLen);[BitConverter]::GetBytes($flags).CopyTo($lb,16);[BitConverter]::GetBytes($activeMax).CopyTo($lb,$LimApOff);$K::SetInformationJobObject($Job,9,$lb,$LimLen)}
$Job=$K::CreateJobObjectW([IntPtr]::Zero,[IntPtr]::Zero)
if($Job -eq [IntPtr]::Zero){PrgFail 'job-create' 5 (PrgLastErr)}
if(-not (PrgLimit 0x2000 0)){PrgFail 'job-limit' 6 (PrgLastErr)}
if(-not $K::AssignProcessToJobObject($Job,[IntPtr](-1))){PrgFail 'job-assign' 7 (PrgLastErr)}
$Target='__TARGET__';$ArgTail='__ARGS__'
if(-not ($Target -match '^[A-Za-z]:\\[^"*?<>|]+\.exe$' -and [IO.File]::Exists($Target))){PrgFail 'target-invalid' 8 0}
$CusName='__CTL_PIPE__';$CusSup=__SUP_PID__;$CusNonce='__CTL_NONCE__';$CusKill=$false
function PrgCusFail([string]$stage,[int]$code,[int]$err){if($CusKill){PrgKillChild};PrgFail $stage $code $err}
$CusPipe=$null
try{$CusPipe=[IO.Pipes.NamedPipeClientStream]::new('.',$CusName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous,[Security.Principal.TokenImpersonationLevel]::Identification,[IO.HandleInheritability]::None);$CusPipe.Connect(__CTL_CONNECT_MS__)}catch{PrgFail 'custody-connect' 16 0}
$CusH=$CusPipe.SafePipeHandle.DangerousGetHandle();$CusOut=[int[]]::new(1)
if(-not ($K::GetNamedPipeServerProcessId($CusH,$CusOut) -and $CusOut[0] -eq $CusSup)){PrgFail 'custody-peer' 17 (PrgLastErr)}
$CusOut[0]=1
if(-not ($K::GetHandleInformation($CusH,$CusOut) -and ($CusOut[0] -band 1) -eq 0)){PrgFail 'custody-inherit' 18 0}
$CusProc=$K::OpenProcess(0x40,$false,$CusSup)
if($CusProc -eq [IntPtr]::Zero){PrgFail 'custody-open' 19 (PrgLastErr)}
$CusSelf=$K::GetCurrentProcess()
function PrgDup([IntPtr]$src){$dst=[IntPtr[]]::new(1);if(-not $K::DuplicateHandle($CusSelf,$src,$CusProc,$dst,0,$false,2)){PrgCusFail 'custody-dup' 20 (PrgLastErr)};$dst[0].ToInt64()}
$CusEnc=[Text.UTF8Encoding]::new($false)
$CusW=[IO.StreamWriter]::new($CusPipe,$CusEnc);$CusW.AutoFlush=$true;$CusR=[IO.StreamReader]::new($CusPipe,$CusEnc)
function PrgSend([string]$line){try{$CusW.WriteLine($line)}catch{PrgCusFail 'custody-io' 22 0}}
function PrgRecv([string]$want){$got=$null;try{$task=$CusR.ReadLineAsync();if($task.Wait(__CTL_REPLY_MS__)){$got=$task.Result}}catch{$got=$null};if($got -cne $want){PrgCusFail 'custody-refused' 21 0}}
$CusJobDup=PrgDup $Job;$CusSelfDup=PrgDup $CusSelf
PrgSend ('HELLO '+$CusNonce+' '+$PID+' '+$CusJobDup+' '+$CusSelfDup)
PrgRecv ('GO '+$CusNonce)
$StartInfo=[Diagnostics.ProcessStartInfo]::new()
$StartInfo.FileName=$Target;$StartInfo.Arguments=$ArgTail;$StartInfo.UseShellExecute=$false
$Child=$null
try{$Child=[Diagnostics.Process]::Start($StartInfo)}catch{$Child=$null}
if($null -eq $Child){PrgFail 'child-start' 9 0}
$ChildHandle=$Child.Handle;$ChildId=$Child.Id
$InJob=[int[]]::new(1)
function PrgKillChild{[void]$K::TerminateProcess($ChildHandle,$FailBase+0x30);[void]$Child.WaitForExit(5000)}
if(-not $K::SetConsoleCtrlHandler([IntPtr]::Zero,$true)){$ctrlErr=PrgLastErr;PrgKillChild;PrgFail 'ctrl-ignore' 11 $ctrlErr}
if(-not ($K::IsProcessInJob($ChildHandle,$Job,$InJob) -and $InJob[0] -ne 0 -and $K::GetProcessId($ChildHandle) -eq $ChildId)){PrgKillChild;PrgFail 'child-not-in-job' 10 0}
$CusKill=$true
$CusChildDup=PrgDup $ChildHandle
PrgSend ('CHILD '+$CusNonce+' '+$ChildId+' '+$CusChildDup)
PrgRecv ('CHILD-OK '+$CusNonce)
if($Smoke){Write-Host "PRG_WRAP_STARTED wrapper=$PID child=$ChildId injob=1"}
$Child.WaitForExit()
$ChildExit=$Child.ExitCode
$Clock=[Diagnostics.Stopwatch]::StartNew();$Terminated=0;$Settled=$false
$Cap=[int](PrgLimit 0x2008 1)
$IdSize=if($Is64){8}else{4};$MaxIds=1024;$IdList=[byte[]]::new(8+$MaxIds*$IdSize);$Acct=[byte[]]::new(48)
while($Clock.ElapsedMilliseconds -lt __SETTLE_MS__){
if(-not $K::QueryInformationJobObject($Job,1,$Acct,48,[IntPtr]::Zero)){PrgFail 'settle-query' 12 (PrgLastErr)}
if($Clock.ElapsedMilliseconds -ge __SETTLE_MS__){break}
if([BitConverter]::ToInt32($Acct,40) -eq 1){$Settled=$true;break}
[void]$K::QueryInformationJobObject($Job,3,$IdList,$IdList.Length,[IntPtr]::Zero)
$IdCount=[Math]::Min([BitConverter]::ToInt32($IdList,4),$MaxIds)
for($ix=0;$ix -lt $IdCount -and $Clock.ElapsedMilliseconds -lt __SETTLE_MS__;$ix++){
$memberId=if($Is64){[BitConverter]::ToInt64($IdList,8+$ix*8)}else{[BitConverter]::ToUInt32($IdList,8+$ix*4)}
if($memberId -le 0 -or $memberId -eq $PID -or $memberId -gt 0x7fffffff){continue}
$memberHandle=$K::OpenProcess(0x1001,$false,[int]$memberId)
if($memberHandle -ne [IntPtr]::Zero){$InJob[0]=0;if($K::IsProcessInJob($memberHandle,$Job,$InJob) -and $InJob[0] -ne 0){if($K::TerminateProcess($memberHandle,$FailBase+0x30)){$Terminated++}};[void]$K::CloseHandle($memberHandle)}
}
$Remaining=[long]__SETTLE_MS__-$Clock.ElapsedMilliseconds
if($Remaining -gt 0){[Threading.Thread]::Sleep([int][Math]::Min([long]25,$Remaining))}
}
if(-not $Settled){PrgFail 'settle-timeout' 13 $Terminated}
try{$CusW.WriteLine('DONE '+$CusNonce+' exit='+$ChildExit+' terminated='+$Terminated)}catch{}
if($Smoke){Write-Host "PRG_WRAP_OUTCOME__OUTCOME_SUFFIX__ exit=$ChildExit settled=1 terminated=$Terminated cap=$Cap"}
exit $ChildExit
`;

export interface WindowsClaudeCustodyWrapperLaunchInput {
  /** Trusted absolute System32 Windows PowerShell 5.1 path, from the resolver. */
  readonly powershellPath: string;
  /** Absolute drive-letter `.exe` to launch as the wrapper's direct child. */
  readonly target: string;
  /** Exact target argv, quoted here; never a shell string. */
  readonly args?: readonly string[];
  /** Emit the smoke markers (inert child verification launches only). */
  readonly smoke?: boolean;
  /** Job settlement deadline, 100..60000 ms. */
  readonly settleMs?: number;
  /** `""` or a 32-hex per-launch tag on the terminal markers. */
  readonly outcomeTag?: string;
  /** Launch-specific control pipe name, `prg682-ctl-<32 hex>`. */
  readonly ctlPipe: string;
  /** The supervisor PID the driver spawned (from `SUP_READY`). */
  readonly supervisorPid: number;
  /** Per-launch control nonce, 32 lowercase hex. */
  readonly ctlNonce: string;
  /** Control-pipe connect deadline, 500..60000 ms. */
  readonly connectMs?: number;
  /** Control-pipe reply deadline, 500..120000 ms. */
  readonly replyMs?: number;
}

export interface WindowsClaudeCustodyWrapperLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly script: string;
  readonly encoded: string;
  readonly commandLineLength: number;
}

/**
 * Render the custody wrapper bootstrap and the exact node-pty argv. Everything
 * is validated before anything is rendered; a throw produces no output.
 */
export function buildWindowsClaudeCustodyWrapperLaunch(
  input: WindowsClaudeCustodyWrapperLaunchInput,
): WindowsClaudeCustodyWrapperLaunch {
  const powershellPath = validatePowerShellPath(input.powershellPath);
  const target = validateTargetPath(input.target);
  // Only an OMITTED option (undefined) takes its default. An explicit null is an
  // invalid value and must be rejected, never silently coerced into "no arguments"
  // or "the default deadline".
  const { args = [], smoke = false } = input;
  if (!Array.isArray(args)) throw new Error("args must be an array");
  if (typeof smoke !== "boolean") throw new Error("smoke must be a boolean");
  const { settleMs: settle = 5_000, connectMs: connect = 10_000, replyMs: reply = 15_000 } = input;
  const settleMs = checkMs(settle, "settleMs", 100, 60_000);
  const connectMs = checkMs(connect, "connectMs", 500, 60_000);
  const replyMs = checkMs(reply, "replyMs", 500, 120_000);
  const ctlPipe = checkHex32(input.ctlPipe, "ctlPipe must be prg682-ctl-<32 hex>", WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN);
  const ctlNonce = checkHex32(input.ctlNonce, "ctlNonce must be 32 lowercase hex", WINDOWS_CLAUDE_CUSTODY_NONCE_PATTERN);
  const supervisorPid = checkPid(input.supervisorPid, "supervisorPid");
  const argTail = [...args].map(quoteWindowsArg).join(" ");
  const values: Record<string, string> = {
    OUTCOME_SUFFIX: custodyOutcomeSuffix(input.outcomeTag),
    SMOKE: smoke ? "$true" : "$false",
    FAIL_BASE: String(WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE),
    SETTLE_MS: String(settleMs),
    TARGET: powerShellSingleQuotedBody(target),
    ARGS: powerShellSingleQuotedBody(argTail),
    CTL_PIPE: ctlPipe,
    SUP_PID: String(supervisorPid),
    CTL_NONCE: ctlNonce,
    CTL_CONNECT_MS: String(connectMs),
    CTL_REPLY_MS: String(replyMs),
  };
  const script = render(WINDOWS_CLAUDE_CUSTODY_WRAPPER_BOOTSTRAP_TEMPLATE, values);
  const encoded = encodedCommand(script);
  const ptyArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  const length = commandLineLength(powershellPath, ptyArgs);
  // CreateProcess's limit counts the terminating NUL as well as the text.
  if (length + 1 > WINDOWS_CLAUDE_CUSTODY_MAX_WINDOWS_COMMAND_LINE) {
    throw new Error(`custody wrapper command line too long (${length})`);
  }
  return Object.freeze({ file: powershellPath, args: Object.freeze(ptyArgs.slice()), script, encoded, commandLineLength: length });
}

/* ----------------------------------------------------------- the supervisor */

/**
 * The ONLY script on the supervisor's command line. It reads one bounded
 * startup frame from the private stdin, pins its exact length and SHA-256
 * against values compiled in here, parses it, and dot-sources it. Its first
 * check works in ConstrainedLanguage too, where .NET method calls such as
 * `[Console]::Error.WriteLine` are blocked: that branch uses only a property
 * read, a cmdlet with a string literal, and a literal exit code — and it writes
 * to STDERR, never to the grammar's stdout.
 */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_BOOTSTRAP_TEMPLATE = String.raw`
$ErrorActionPreference='Stop'
if($ExecutionContext.SessionState.LanguageMode -cne 'FullLanguage'){Write-Error -ErrorAction Continue 'PRG-WCS1-BOOT language-mode';exit __LANG_EXIT__}
function SupBootFail([string]$stage,[int]$code){try{[Console]::Error.WriteLine('PRG-WCS1-BOOT '+$stage)}catch{};exit (__FAIL_BASE__+$code)}
$SupBlock=$null
try{
$BootEnc=[Text.UTF8Encoding]::new($false)
$StdIn=[IO.StreamReader]::new([Console]::OpenStandardInput(),$BootEnc,$false,4096)
$BootClock=[Diagnostics.Stopwatch]::StartNew()
$BootHead=[char[]]::new(__HEAD_LEN__);$BootTask=$StdIn.ReadBlockAsync($BootHead,0,__HEAD_LEN__)
if(-not $BootTask.Wait(__FRAME_MS__)){SupBootFail 'startup-frame-timeout' 51}
if($BootTask.Result -ne __HEAD_LEN__){SupBootFail 'startup-frame-missing' 52}
$BootM=[regex]::Match([string]::new($BootHead),'^PRG-WCS1 ([0-9]{8})\n$')
if(-not $BootM.Success){SupBootFail 'startup-frame-header' 53}
$BootLen=[int]$BootM.Groups[1].Value
if($BootLen -gt __MAX_SRC__){SupBootFail 'startup-frame-oversize' 54}
if($BootLen -ne __SRC_LEN__){SupBootFail 'startup-frame-length' 55}
$BootLeft=[int](__FRAME_MS__-$BootClock.ElapsedMilliseconds)
if($BootLeft -le 0){SupBootFail 'startup-frame-timeout' 51}
$BootSrc=[char[]]::new($BootLen);$BootTask=$StdIn.ReadBlockAsync($BootSrc,0,$BootLen)
if(-not $BootTask.Wait($BootLeft)){SupBootFail 'startup-frame-timeout' 51}
if($BootTask.Result -ne $BootLen){SupBootFail 'startup-frame-short' 56}
$BootText=[string]::new($BootSrc)
$BootSha=[Security.Cryptography.SHA256]::Create()
if((-join($BootSha.ComputeHash($BootEnc.GetBytes($BootText))|%{$_.ToString('x2')})) -cne '__SRC_SHA__'){SupBootFail 'startup-frame-hash' 57}
try{$SupBlock=[ScriptBlock]::Create($BootText)}catch{SupBootFail 'startup-parse' 58}
}catch{SupBootFail 'startup-error' 59}
if($null -eq $SupBlock){SupBootFail 'startup-error' 59}
$BootText=$null;$BootSrc=$null
. $SupBlock
`;

/**
 * The supervisor's body. It travels ONLY as the startup frame on private stdin.
 *
 * stdout is reserved for the closed grammar (every write goes through `SupOut`,
 * and only these six records exist). Diagnostics go through `SupDiag` to
 * STDERR, which the driver drains, counts, and discards. There is no hook
 * pipe, no key, and no inbox send in this slice.
 */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE = String.raw`
$ErrorActionPreference='Stop'
$SupBase=__FAIL_BASE__;$CtlName='__CTL_PIPE__';$Nonce='__CTL_NONCE__';$StartMs=__START_MS__;$SettleMs=__SETTLE_MS__
$Z=[IntPtr]::Zero;$Job=$Z;$WH=$Z;$CH=$Z;$ProvJob=$Z;$ProvW=$Z;$K=$null;$WPid=0;$ChildPid=0
$Phase='accept';$CtlAr=$null;$CtlTask=$null;$CtlR=$null;$CtlW=$null
$Clock=[Diagnostics.Stopwatch]::StartNew()
function SupOut([string]$line){[Console]::Out.WriteLine($line);[Console]::Out.Flush()}
function SupDiag([string]$text){try{[Console]::Error.WriteLine('PRG-WCS1-SUP '+$text);[Console]::Error.Flush()}catch{}}
function SupWin32Err{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
function SupLeft{[long]$StartMs-$Clock.ElapsedMilliseconds}
function SupStartCheck{if((SupLeft) -le 0){SupFail 'deadline' 9}}
function SupActive{if($Job -eq $Z){return -1};$acct=[byte[]]::new(48);if(-not $K::QueryInformationJobObject($Job,1,$acct,48,$Z)){return -1};[BitConverter]::ToInt32($acct,40)}
function SupListed{if($Job -eq $Z){return -1};$ids=[byte[]]::new(8200);if(-not $K::QueryInformationJobObject($Job,3,$ids,$ids.Length,$Z)){return -1};[BitConverter]::ToInt32($ids,0)}
function SupWaitEmpty([long]$ms){$until=[Diagnostics.Stopwatch]::StartNew();$seen=-1;while($until.ElapsedMilliseconds -lt $ms){$seen=SupActive;if($until.ElapsedMilliseconds -ge $ms){return -2};if($seen -eq 0){return 0};[Threading.Thread]::Sleep(25)};$seen}
function SupSend([string]$line){if($null -eq $CtlW){return $false};try{$CtlW.WriteLine($line);$CtlW.Flush();$true}catch{$false}}
function SupReply([string]$line){[void](SupSend $line)}
function SupReleaseProvisional{if($ProvJob -ne $Z){[void]$K::CloseHandle($ProvJob);[void]$K::CloseHandle($ProvW);$script:ProvJob=$Z;$script:ProvW=$Z}}
function SupStdinArm{$script:InTask=$StdIn.ReadAsync($script:InBuf,0,1)}
function SupFail([string]$stage,[int]$code){SupDiag ('fail stage='+$stage+' err='+[string](SupWin32Err));SupReply ('NO '+$Nonce);if($null -ne $K){if($Job -ne $Z){[void]$K::TerminateJobObject($Job,($SupBase+0x30));$left=SupWaitEmpty 3000;if($left -ne 0){SupDiag ('fail job-left='+[string]$left)}};SupReleaseProvisional};exit ($SupBase+$code)}
if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){SupFail 'language-mode' 1}
if($PSVersionTable.PSVersion.Major -ne 5){SupFail 'ps-version' 2}
trap{SupFail 'unexpected' 15}
if([Environment]::OSVersion.Version -lt [Version]'6.2'){SupFail 'os-version' 3}
if($StdIn -isnot [IO.StreamReader]){SupFail 'startup-reader' 7}
try{
$Asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('PrgSup'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$TB=$Asm.DefineDynamicModule('PrgSup').DefineType('PrgSupK',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$DI=[Runtime.InteropServices.DllImportAttribute]
$DC=$DI.GetConstructor([Type[]]@([string]))
$DF=[Reflection.FieldInfo[]]@($DI.GetField('SetLastError'),$DI.GetField('EntryPoint'),$DI.GetField('CharSet'))
function SupDef([string]$name,[Type]$ret,[Type[]]$parms){$mb=$TB.DefineMethod($name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$ret,$parms);$mb.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($DC,[object[]]@('kernel32.dll'),$DF,[object[]]@($true,$name,[Runtime.InteropServices.CharSet]::Unicode)))}
$TI=[IntPtr];$TY=[byte[]];$TN=[int];$TF=[bool];$TA=[int[]]
SupDef 'CreateNamedPipeW' $TI @([string],$TN,$TN,$TN,$TN,$TN,$TN,$TI)
SupDef 'GetNamedPipeClientProcessId' $TF @($TI,$TA)
SupDef 'QueryInformationJobObject' $TF @($TI,$TN,$TY,$TN,$TI)
SupDef 'TerminateJobObject' $TF @($TI,$TN)
SupDef 'IsProcessInJob' $TF @($TI,$TI,$TA)
SupDef 'GetProcessId' $TN @($TI)
SupDef 'WaitForSingleObject' $TN @($TI,$TN)
SupDef 'CloseHandle' $TF @($TI)
SupDef 'SetConsoleCtrlHandler' $TF @($TI,$TF)
$K=$TB.CreateType()
}catch{SupFail 'interop-define' 4}
if(-not $K::SetConsoleCtrlHandler($Z,$true)){SupFail 'ctrl-ignore' 6}
function SupPipe([string]$name){$h=$K::CreateNamedPipeW('\\.\pipe\'+$name,0x40080003,8,1,4096,4096,0,$Z);if([long]$h -le 0){SupFail 'pipe-create' 5};[IO.Pipes.NamedPipeServerStream]::new([IO.Pipes.PipeDirection]::InOut,$true,$false,[Microsoft.Win32.SafeHandles.SafePipeHandle]::new($h,$true))}
$Ctl=SupPipe $CtlName
$Enc=[Text.UTF8Encoding]::new($false)
SupOut ('SUP_READY '+[string]$PID)
$InBuf=[char[]]::new(1);$InLine='';$MaxCmd=18;SupStdinArm
$CtlAr=$Ctl.BeginWaitForConnection($null,$null)
function SupInJob([IntPtr]$h){if($Job -eq $Z){return $false};$flag=[int[]]::new(1);($K::IsProcessInJob($h,$Job,$flag) -and $flag[0] -ne 0)}
function SupHello([string]$line){
$m=[regex]::Match($line,'^HELLO ([0-9a-f]{32}) ([0-9]{1,10}) ([0-9]{1,19}) ([0-9]{1,19})$')
if(-not $m.Success -or $m.Groups[1].Value -cne $Nonce -or [long]$m.Groups[2].Value -ne $WPid){SupFail 'hello-invalid' 16}
$jobH=[IntPtr][long]$m.Groups[3].Value;$wrapH=[IntPtr][long]$m.Groups[4].Value
if($jobH -eq $Z){SupFail 'wrapper-not-in-job' 18}
if($K::GetProcessId($wrapH) -ne $WPid){SupFail 'wrapper-handle-pid' 17}
$flag=[int[]]::new(1)
if(-not ($K::IsProcessInJob($wrapH,$jobH,$flag) -and $flag[0] -ne 0)){SupFail 'wrapper-not-in-job' 18}
$script:ProvJob=$jobH;$script:ProvW=$wrapH
SupStartCheck
SupOut ('SUP_WRAPPER '+[string]$WPid+' PROVISIONAL');$script:Phase='confirm'}
function SupChild([string]$line){
$m=[regex]::Match($line,'^CHILD ([0-9a-f]{32}) ([0-9]{1,10}) ([0-9]{1,19})$')
if(-not $m.Success -or $m.Groups[1].Value -cne $Nonce){SupFail 'child-invalid' 19}
$claimed=[long]$m.Groups[2].Value;$childH=[IntPtr][long]$m.Groups[3].Value
if($claimed -eq $WPid -or $K::GetProcessId($childH) -ne $claimed -or -not (SupInJob $childH) -or $K::WaitForSingleObject($childH,0) -ne 258){SupFail 'child-unverified' 14}
SupStartCheck
$script:CH=$childH;$script:ChildPid=[int]$claimed
if(-not (SupSend ('CHILD-OK '+$Nonce))){SupFail 'child-ok-write-failed' 25}
SupStartCheck
SupOut ('SUP_CHILD '+[string]$claimed)
SupStartCheck
$script:Phase='run'}
function SupCtlAccept{
$Ctl.EndWaitForConnection($CtlAr);$script:CtlAr=$null
$cp=[int[]]::new(1)
if(-not $K::GetNamedPipeClientProcessId($Ctl.SafePipeHandle.DangerousGetHandle(),$cp)){SupFail 'ctl-client-pid' 20}
$script:WPid=$cp[0]
$script:CtlR=[IO.StreamReader]::new($Ctl,$Enc,$false,4096,$true)
$script:CtlW=[IO.StreamWriter]::new($Ctl,$Enc,4096,$true);$script:CtlW.AutoFlush=$true
$script:CtlTask=$script:CtlR.ReadLineAsync()
$script:Phase='hello'}
function SupSettle{
if($Job -eq $Z){SupDiag 'settle stage=settle-no-job';exit ($SupBase+40)}
$Budget=[Diagnostics.Stopwatch]::StartNew()
$NaturalMs=[int][Math]::Min(4000,[Math]::Floor($SettleMs/2))
$WrapperMs=[int][Math]::Max(0,[Math]::Min(2000,($NaturalMs-$Budget.ElapsedMilliseconds)))
$Empty=$false
if($WH -ne $Z -and $K::WaitForSingleObject($WH,$WrapperMs) -eq 0){
$Grace=[int][Math]::Max(0,[Math]::Min(2000,($NaturalMs-$Budget.ElapsedMilliseconds)))
$Empty=(SupWaitEmpty $Grace) -eq 0}
if(-not $Empty){
[void]$K::TerminateJobObject($Job,($SupBase+0x30))
$Left=[int][Math]::Max(0,($SettleMs-$Budget.ElapsedMilliseconds))
[void](SupWaitEmpty $Left)}
if($Budget.ElapsedMilliseconds -ge $SettleMs){SupDiag ('settle deadline elapsed='+[string]$Budget.ElapsedMilliseconds);exit ($SupBase+41)}
$active=SupActive;$listed=SupListed
if($Budget.ElapsedMilliseconds -ge $SettleMs){SupDiag ('settle deadline after-query elapsed='+[string]$Budget.ElapsedMilliseconds);exit ($SupBase+41)}
if($active -lt 0 -or $listed -lt 0){SupDiag ('settle query-failed active='+[string]$active+' listed='+[string]$listed);exit ($SupBase+41)}
if($active -ne 0 -or $listed -ne 0){SupOut ('SUP_SETTLED ACTIVE='+[string]$active+' LISTED='+[string]$listed);SupDiag 'settle not-empty';exit ($SupBase+41)}
SupOut 'SUP_SETTLED ACTIVE=0 LISTED=0'
if($CH -ne $Z){[void]$K::CloseHandle($CH)}
if($WH -ne $Z){[void]$K::CloseHandle($WH)}
[void]$K::CloseHandle($Job)
SupOut 'SUP_BYE'
exit 0}
function SupCommand([string]$cmd){
if($cmd -cmatch '^CONFIRM ([1-9][0-9]{0,9})\z'){
if($Phase -cne 'confirm'){SupFail 'confirm-out-of-phase' 22}
if([long]$Matches[1] -ne $WPid){SupFail 'confirm-pid-mismatch' 23}
SupStartCheck
$script:Job=$ProvJob;$script:WH=$ProvW;$script:ProvJob=$Z;$script:ProvW=$Z
if(-not (SupSend ('GO '+$Nonce))){SupFail 'go-write-failed' 24}
SupOut ('SUP_GO '+[string]$WPid);$script:Phase='child';return}
if($cmd -ceq 'SETTLE'){SupSettle}
SupFail 'command-invalid' 11}
while($true){
if($Phase -cne 'run'){SupStartCheck}
$busy=$false
if($InTask.IsCompleted){$busy=$true;$n=0;try{$n=[int]$InTask.Result}catch{$n=0}
if($n -le 0){if($InLine -ceq ''){SupFail 'stdin-closed' 10}else{SupFail 'command-invalid' 11}}
$ci=[int]$InBuf[0]
if($ci -eq 10){$cmd=$InLine;$InLine='';SupStdinArm;SupCommand $cmd}
elseif($ci -lt 32 -or $ci -gt 126 -or $InLine.Length -ge $MaxCmd){SupFail 'command-invalid' 11}
else{$InLine+=[string][char]$ci;SupStdinArm}}
if($null -ne $CtlAr -and $CtlAr.IsCompleted){$busy=$true;SupCtlAccept}
if($null -ne $CtlTask -and $CtlTask.IsCompleted){$busy=$true;$line=$null;try{$line=$CtlTask.Result}catch{$line=$null}
if($null -eq $line){if($Phase -ceq 'run'){SupDiag 'ctl closed';$script:CtlTask=$null}else{SupFail 'ctl-closed' 26}}
else{$script:CtlTask=$CtlR.ReadLineAsync()
if($Phase -ceq 'hello'){SupHello $line}
elseif($Phase -ceq 'child'){SupChild $line}
elseif($Phase -ceq 'run'){if($line -cnotmatch '^DONE '){SupFail 'ctl-unexpected' 21}}
else{SupFail 'ctl-unexpected' 21}}}
if(-not $busy){[Threading.Thread]::Sleep(20)}
}
`;

export interface WindowsClaudeCustodySupervisorLaunchInput {
  /** Trusted absolute System32 Windows PowerShell 5.1 path, from the resolver. */
  readonly powershellPath: string;
  /** Launch-specific control pipe name, `prg682-ctl-<32 hex>`. */
  readonly ctlPipe: string;
  /** Per-launch control nonce, 32 lowercase hex. */
  readonly ctlNonce: string;
  /**
   * Startup/handshake deadline, 10s..2h (default 15 minutes). Until the exact
   * retained child reaches the `run` phase the supervisor refuses past this
   * (terminating a confirmed job); it never bounds a healthy running row.
   */
  readonly maxMs?: number;
  /** Post-terminate job-empty wait, 1000..60000 ms. */
  readonly settleMs?: number;
}

export interface WindowsClaudeCustodySupervisorLaunch {
  readonly file: string;
  readonly args: readonly string[];
  /** The short, fixed script on the command line. */
  readonly bootstrap: string;
  /** The supervisor body that travels only as the startup frame. */
  readonly source: string;
  /** Exact bytes to write to the supervisor's stdin first. */
  readonly startupFrame: Buffer;
  readonly sourceSha256: string;
  readonly encoded: string;
  readonly commandLineLength: number;
  readonly spawnOptions: WindowsClaudeCustodySpawnOptions;
}

/**
 * The one startup frame: fixed 18-byte header + exact ASCII source. Mirrors the
 * transport's framing byte for byte, so `startupFrame` and `transport.start()`
 * are interchangeable.
 */
export function encodeCustodyBootFrame(source: unknown): Buffer {
  if (typeof source !== "string" || source.length === 0) throw new Error("supervisor source must be a non-empty string");
  if (source.length > WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES) {
    throw new Error(`supervisor source too large (${source.length})`);
  }
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (!(code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e))) {
      throw new Error("supervisor source must be printable ASCII (TAB, CR, LF allowed)");
    }
  }
  const header = `${WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC}${String(source.length).padStart(WINDOWS_CLAUDE_CUSTODY_BOOT_LENGTH_DIGITS, "0")}\n`;
  if (header.length !== WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES) throw new Error("startup header length");
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(source, "ascii")]);
}

/** Render the supervisor body from the validated per-launch values. */
function renderSupervisorSource(values: {
  readonly ctlPipe: string;
  readonly ctlNonce: string;
  readonly maxMs: number;
  readonly settleMs: number;
}): string {
  return render(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE, {
    FAIL_BASE: String(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE),
    CTL_PIPE: values.ctlPipe,
    CTL_NONCE: values.ctlNonce,
    START_MS: String(values.maxMs),
    SETTLE_MS: String(values.settleMs),
  });
}

/**
 * Render the supervisor's short bootstrap, its startup frame, and the exact
 * `child_process.spawn` argv. The body never appears on the command line: its
 * exact length and SHA-256 are compiled into the bootstrap instead.
 */
export function buildWindowsClaudeCustodySupervisorLaunch(
  input: WindowsClaudeCustodySupervisorLaunchInput,
): WindowsClaudeCustodySupervisorLaunch {
  const powershellPath = validatePowerShellPath(input.powershellPath);
  const ctlPipe = checkHex32(input.ctlPipe, "ctlPipe must be prg682-ctl-<32 hex>", WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN);
  const ctlNonce = checkHex32(input.ctlNonce, "ctlNonce must be 32 lowercase hex", WINDOWS_CLAUDE_CUSTODY_NONCE_PATTERN);
  const { maxMs: max = 15 * 60 * 1000, settleMs: settle = 10_000 } = input;
  const maxMs = checkMs(max, "maxMs", 10_000, 2 * 60 * 60 * 1000);
  const settleMs = checkMs(settle, "settleMs", 1_000, 60_000);
  const source = renderSupervisorSource({ ctlPipe, ctlNonce, maxMs, settleMs });
  const startupFrame = encodeCustodyBootFrame(source);
  const sourceSha256 = createHash("sha256").update(source, "ascii").digest("hex");
  const bootstrap = render(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_BOOTSTRAP_TEMPLATE, {
    FAIL_BASE: String(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE),
    LANG_EXIT: String(
      WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE + WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES["startup-language-mode"],
    ),
    HEAD_LEN: String(WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES),
    FRAME_MS: String(WINDOWS_CLAUDE_CUSTODY_STARTUP_FRAME_MS),
    MAX_SRC: String(WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES),
    SRC_LEN: String(source.length),
    SRC_SHA: sourceSha256,
  });
  const encoded = encodedCommand(bootstrap);
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  const length = commandLineLength(powershellPath, args);
  if (length > WINDOWS_CLAUDE_CUSTODY_MAX_SUPERVISOR_COMMAND_LINE) {
    throw new Error(`supervisor command line too long (${length})`);
  }
  return Object.freeze({
    file: powershellPath,
    args: Object.freeze(args.slice()),
    bootstrap,
    source,
    startupFrame,
    sourceSha256,
    encoded,
    commandLineLength: length,
    spawnOptions: WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS,
  });
}

/* ---------------------------------------------------------- classification */

export type WindowsClaudeCustodyWrapperOutcome =
  | { readonly kind: "wrapper-failed"; readonly stage: string; readonly detail: number; readonly exitCodeMatchesStage: boolean }
  | {
      readonly kind: "child-exited";
      readonly childExit: number;
      readonly settled: boolean;
      readonly terminated: number;
      readonly capApplied: boolean;
      readonly exitCodePassedThrough: boolean;
    }
  | { readonly kind: "unknown"; readonly exitCode: number };

/**
 * Classify a wrapper's PTY exit code plus output. Only markers carrying THIS
 * launch's `outcomeTag` suffix count: untagged or differently tagged
 * look-alikes printed by the child are ignored. Console output is a
 * disambiguator only and never supplies custody authority.
 */
export function classifyWindowsClaudeCustodyWrapperOutcome(
  exitCode: number,
  outputText: string,
  outcomeTag = "",
): WindowsClaudeCustodyWrapperOutcome {
  const suffix = custodyOutcomeSuffix(outcomeTag);
  const unsigned = Number(exitCode) >>> 0;
  const text = typeof outputText === "string" ? outputText : "";
  const fail = new RegExp(`PRG_WRAP_FAIL${suffix} ([a-z-]+) (-?\\d+)`, "u").exec(text);
  if (fail) {
    const stageCode = WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_STAGES[fail[1]!];
    return {
      kind: "wrapper-failed",
      stage: fail[1]!,
      detail: Number(fail[2]),
      exitCodeMatchesStage: stageCode !== undefined && unsigned === WINDOWS_CLAUDE_CUSTODY_WRAPPER_FAIL_BASE + stageCode,
    };
  }
  const outcome = new RegExp(
    `PRG_WRAP_OUTCOME${suffix} exit=(-?\\d+) settled=([01]) terminated=(\\d+) cap=([01])`,
    "u",
  ).exec(text);
  if (outcome) {
    const childExit = Number(outcome[1]);
    return {
      kind: "child-exited",
      childExit,
      settled: outcome[2] === "1",
      terminated: Number(outcome[3]),
      capApplied: outcome[4] === "1",
      exitCodePassedThrough: (childExit >>> 0) === unsigned,
    };
  }
  return { kind: "unknown", exitCode: unsigned };
}

export type WindowsClaudeCustodySupervisorExit =
  /** The witnessed settlement tail: `SUP_SETTLED ACTIVE=0 LISTED=0`, `SUP_BYE`. */
  | { readonly kind: "clean" }
  | { readonly kind: "failed"; readonly stage: string; readonly code: number }
  /** The exit code the supervisor gives to job members it terminates. */
  | { readonly kind: "terminated-job-member" }
  | { readonly kind: "unknown"; readonly exitCode: number };

/**
 * Map a supervisor exit code into a closed outcome. Anything that is not a
 * clean exit or a code in the supervisor's reserved range is unknown, and the
 * driver must treat unknown as "no witness".
 */
export function classifyWindowsClaudeCustodySupervisorExit(
  exitCode: number,
): WindowsClaudeCustodySupervisorExit {
  const unsigned = Number(exitCode) >>> 0;
  if (unsigned === 0) return { kind: "clean" };
  const base = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE;
  if (unsigned < base || unsigned > base + 0xff) return { kind: "unknown", exitCode: unsigned };
  const code = unsigned - base;
  if (code === WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_TERMINATE_EXIT_CODE) return { kind: "terminated-job-member" };
  for (const [stage, stageCode] of Object.entries({
    ...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_STAGES,
    ...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_STARTUP_FAIL_STAGES,
  })) {
    if (stageCode === code) return { kind: "failed", stage, code };
  }
  return { kind: "unknown", exitCode: unsigned };
}