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
 * - it sends nothing to any inbox; by default it owns no hook channel, and the
 *   OPT-IN hook mode (`hookPipe`) adds only a protected listener, run-phase
 *   authentication through the immutable fixed receiver, and nonsecret
 *   `SUP_CAND` metadata — never a binding, callback, or inbox open (see
 *   {@link WINDOWS_CLAUDE_CUSTODY_HOOK_CHANNEL_CONTRACT});
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

import {
  WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION,
  WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT,
  WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS,
  WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE,
} from "./native-windows-claude-hook-receiver";
import {
  WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION,
  WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION,
  WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE,
} from "./native-windows-claude-inbox-peer";

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

/**
 * Refusal stages that exist ONLY in the opt-in hook mode
 * ({@link WindowsClaudeCustodySupervisorLaunchInput.hookPipe}); the default
 * supervisor can never exit with them. `hook-key` and `hook-pipe` are startup
 * refusals before `SUP_READY` (nothing is confirmed yet, so nothing is
 * terminated). `hook-unsettled` is the one run-phase hook refusal that ends
 * custody: a receive whose pipe operation could not be proven settled, an
 * unexpected receive fault, or a connection that could not be disposed leaves
 * cleanup uncertain, so the supervisor takes its existing fail-closed path.
 * Every ordinary hook refusal stays isolated from custody.
 */
export const WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_HOOK_FAIL_STAGES: Readonly<Record<string, number>> = Object.freeze({
  "hook-key": 42,
  "hook-pipe": 43,
  "hook-unsettled": 45,
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
/**
 * Opt-in hook pipe name (local only; one protected instance at a time). A
 * NONSECRET render parameter: knowing it grants nothing without the per-run
 * key, which never travels on any command line, source, or environment.
 */
export const WINDOWS_CLAUDE_CUSTODY_HOOK_PIPE_PATTERN = /^prg682-hook-[0-9a-f]{32}$/u;
/** Opt-in hook key frame magic: `PRG-WCK1 <64 lowercase hex key> <runId>\n`. */
export const WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC = "PRG-WCK1 ";
/** Largest key frame: magic + 64 hex + space + 128-character run id + LF. */
export const WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_CHARS = WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC.length + 64 + 1 + 128 + 1;
/** Per-connection receive budget handed to the fixed receiver (its own limit is 5000). */
export const WINDOWS_CLAUDE_CUSTODY_HOOK_SERVE_BUDGET_MS = 2_000;
/** Worst-case run-loop blocking per hook connection: the budget plus the receiver's cancel grace. */
export const WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS =
  WINDOWS_CLAUDE_CUSTODY_HOOK_SERVE_BUDGET_MS + WINDOWS_CLAUDE_HOOK_RECEIVE_LIMITS.cancelGraceMs;
/** Minimum spacing between run-phase attempts to re-create the hook listener. */
export const WINDOWS_CLAUDE_CUSTODY_HOOK_REARM_MS = 250;
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
 * STDERR, which the driver drains, counts, and discards. This DEFAULT body has
 * no hook pipe, no key, and no inbox send; the opt-in hook body
 * ({@link WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE}) is this text
 * plus anchored insertions, and still never sends to an inbox.
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

/* ------------------------------------------------- opt-in hook channel */

/**
 * The landed peer module's fixed retained-child check, byte-for-byte: the
 * first function of `WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE`, up to (never
 * including) its inbox-opening function. The hook mode composes ONLY this
 * check: it never defines, calls, or declares the interop for any inbox open.
 * A changed fixed-source shape refuses at load, never silently.
 */
const PEER_HELD_SOURCE: string = (() => {
  const source = WINDOWS_CLAUDE_INBOX_PEER_OPEN_SOURCE;
  const end = source.indexOf(`\nfunction ${WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION}(`);
  const held = end > 0 ? source.slice(0, end) : "";
  if (
    !held.startsWith(`function ${WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION}(`)
    || !held.endsWith("return 'ok'}")
    || held.includes("\nfunction ")
    || held.includes(WINDOWS_CLAUDE_INBOX_PEER_OPEN_FUNCTION)
  ) {
    throw new Error("fixed peer held-check source shape changed");
  }
  return held;
})();

/**
 * The interop the hook mode adds to the supervisor's existing `SupDef` table:
 * exactly the receiver host contract's three declarations plus the peer
 * contract's `GetHandleInformation` (used to prove the hook listener handle is
 * not inheritable). The peer contract's inbox-open declaration is deliberately absent.
 */
const HOOK_INTEROP_DECLARATIONS: readonly string[] = (() => {
  const handleInfo = WINDOWS_CLAUDE_INBOX_PEER_HOST_CONTRACT.additionalInteropDeclarations.filter((declaration) =>
    declaration.startsWith("SupDef 'GetHandleInformation' "),
  );
  if (handleInfo.length !== 1) throw new Error("peer host contract shape changed");
  return Object.freeze([...WINDOWS_CLAUDE_HOOK_RECEIVE_HOST_CONTRACT.additionalInteropDeclarations, handleInfo[0]!]);
})();

/** Post-render marker replaced, exactly once, by the immutable fixed sources. */
const HOOK_FIXED_MARKER = "#PRG-WCK-FIXED#";

/** Hook state; distinct (ignoring case) from every supervisor, receiver (`h`), and peer (`p`) name. */
const HOOK_STATE = String.raw`$WckName='__HOOK_PIPE__';$WckKey=$null;$WckRun=$null;$WckSeq=[long]0;$WckCand=$null;$WckPipe=$null;$WckAr=$null;$WckRetry=$null`;

/** Clear the one retained candidate; stop the listener and drop the key. Never throws. */
const HOOK_STOP = String.raw`
function SupWckClear{if($null -ne $WckCand){try{$WckCand.Clear()}catch{}};$script:WckCand=$null}
function SupWckStop{SupWckClear;$script:WckKey=$null;$script:WckRun=$null;$script:WckAr=$null;if($null -ne $WckPipe){try{$WckPipe.Dispose()}catch{}};$script:WckPipe=$null}
`.trim();

/**
 * The key frame, read ONCE through the bootstrap's own `$StdIn` reader (the
 * only reader of the private stdin), one character per read so nothing after
 * its LF is consumed here: the next character the reader yields is the first
 * byte of the first command. It shares the bootstrap's startup-frame budget
 * on the bootstrap's own `$BootClock` (never a fresh clock), rechecked after
 * the final LF. The frame is matched whole against one exact case-sensitive
 * pattern; the buffer is cleared before any refusal, and no path prints it.
 */
const HOOK_KEY_READ = String.raw`
if($BootClock -isnot [Diagnostics.Stopwatch]){SupFail 'hook-key' 42}
$WckBuf=[char[]]::new(__KEY_FRAME_MAX__);$WckLen=0;$WckOk=$true
while($WckOk){
if($WckLen -ge __KEY_FRAME_MAX__){$WckOk=$false;break}
$WckLeft=[long]__KEY_FRAME_MS__-$BootClock.ElapsedMilliseconds
if($WckLeft -le 0){$WckOk=$false;break}
$WckTask=$StdIn.ReadAsync($WckBuf,$WckLen,1)
if(-not $WckTask.Wait([int]$WckLeft)){$WckOk=$false;break}
if($WckTask.Result -ne 1){$WckOk=$false;break}
$WckLen++
if([int]$WckBuf[$WckLen-1] -eq 10){break}}
if($BootClock.ElapsedMilliseconds -ge __KEY_FRAME_MS__){$WckOk=$false}
$WckM=$null
if($WckOk){$WckM=[regex]::Match([string]::new($WckBuf,0,$WckLen),'^PRG-WCK1 ([0-9a-f]{64}) ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\n\z')}
[Array]::Clear($WckBuf,0,$WckBuf.Length);$WckBuf=$null;$WckTask=$null
if($null -eq $WckM -or -not $WckM.Success){$WckM=$null;SupFail 'hook-key' 42}
$WckKey=$WckM.Groups[1].Value;$WckRun=$WckM.Groups[2].Value;$WckM=$null
`.trim();

/**
 * The protected hook listener: one async, FIRST_PIPE_INSTANCE, max-one,
 * remote-rejecting byte pipe (the control pipe's exact flags) created with a
 * PROTECTED DACL holding exactly one allow ACE for the current user's SID and
 * a non-inheritable handle (`bInheritHandle = FALSE`). Before it is used the
 * handle is proven non-inheritable and the DACL is read back: protected, one
 * explicit allow rule, for exactly that SID. The raw handle has exactly one
 * owner at every step: the raw slot until the `SafePipeHandle` takes it (and
 * the slot is cleared), that owner until the stream takes it, then the
 * stream; cleanup releases only the current owner. Any ordinary failure
 * releases everything and yields `$null`; `SupWckArm $true` (startup) turns
 * that into the `hook-pipe` refusal, while a run-phase re-arm only retries
 * later. A release that itself fails leaves the handle state uncertain and
 * takes the fail-closed `hook-unsettled` path in either phase.
 */
const HOOK_PIPE = String.raw`
function SupWckPipe{
$wph=$Z;$wsp=$Z;$wap=$Z;$wps=$null;$wowner=$null
try{
$wu=[Security.Principal.WindowsIdentity]::GetCurrent().User
if($null -eq $wu){return $null}
$wsd=[Security.AccessControl.RawSecurityDescriptor]::new('D:P(A;;GA;;;'+$wu.Value+')')
$wsb=[byte[]]::new($wsd.BinaryLength);$wsd.GetBinaryForm($wsb,0)
$wsz=3*[IntPtr]::Size
$wsp=[Runtime.InteropServices.Marshal]::AllocHGlobal($wsb.Length)
[Runtime.InteropServices.Marshal]::Copy($wsb,0,$wsp,$wsb.Length)
$wap=[Runtime.InteropServices.Marshal]::AllocHGlobal($wsz)
for($wi=0;$wi -lt $wsz;$wi+=4){[Runtime.InteropServices.Marshal]::WriteInt32($wap,$wi,0)}
[Runtime.InteropServices.Marshal]::WriteInt32($wap,0,$wsz)
[Runtime.InteropServices.Marshal]::WriteIntPtr($wap,[IntPtr]::Size,$wsp)
$wph=$K::CreateNamedPipeW('\\.\pipe\'+$WckName,0x40080003,8,1,4096,4096,0,$wap)
if([long]$wph -le 0){$wph=$Z;return $null}
$wfl=[int[]]::new(1);$wfl[0]=1
if(-not ($K::GetHandleInformation($wph,$wfl) -and ($wfl[0] -band 1) -eq 0)){return $null}
$wowner=[Microsoft.Win32.SafeHandles.SafePipeHandle]::new($wph,$true)
$wph=$Z
$wps=[IO.Pipes.NamedPipeServerStream]::new([IO.Pipes.PipeDirection]::InOut,$true,$false,$wowner)
$wowner=$null
$wacl=$wps.GetAccessControl()
$wrs=@($wacl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if(-not ($wacl.AreAccessRulesProtected -and $wrs.Count -eq 1 -and $wrs[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not $wrs[0].IsInherited -and $wrs[0].IdentityReference.Value -ceq $wu.Value -and $wps.IsAsync -and -not $wps.IsConnected)){return $null}
$wout=$wps;$wps=$null;return $wout
}catch{return $null}
finally{
$wclean=$true
try{
if($null -ne $wps){$wps.Dispose()}
elseif($null -ne $wowner){$wowner.Dispose()}
elseif($wph -ne $Z){$wclean=$K::CloseHandle($wph)}
}catch{$wclean=$false}
if($wap -ne $Z){try{[Runtime.InteropServices.Marshal]::FreeHGlobal($wap)}catch{}}
if($wsp -ne $Z){try{[Runtime.InteropServices.Marshal]::FreeHGlobal($wsp)}catch{}}
if(-not $wclean){SupFail 'hook-unsettled' 45}}}
function SupWckArm([bool]$wstart){
$script:WckRetry=[Diagnostics.Stopwatch]::StartNew()
$wnp=SupWckPipe;$war=$null
if($null -ne $wnp){try{$war=$wnp.BeginWaitForConnection($null,$null)}catch{$war=$null}
if($null -eq $war){try{$wnp.Dispose()}catch{SupFail 'hook-unsettled' 45};$wnp=$null}}
if($null -eq $wnp){if($wstart){SupFail 'hook-pipe' 43};return}
$script:WckPipe=$wnp;$script:WckAr=$war}
SupWckArm $true
`.trim();

/**
 * One hook connection, serviced only in `run`: accept it, hand it ONCE to the
 * fixed receiver with the exact retained custody state, a fresh cancelable
 * token, and the fixed budget, then ALWAYS dispose it. `hook-unsettled`,
 * `hook-unexpected`, or a failed dispose leave cleanup uncertain and take the
 * existing fail-closed path; every other refusal is isolated and silent (no
 * stdout record and no stderr byte, so a noisy local client can neither
 * spend the transport's lifetime stderr bound nor reach the grammar). A
 * candidate is retained only after the composed peer held check, replacing
 * (and clearing) the previous one, and announced as `SUP_CAND <seq> <uuid>`:
 * the session id and a forward sequence number, never the token or endpoint.
 * The listener is then re-created as a fresh first instance.
 */
const HOOK_TURN = String.raw`
function SupWckTurn{
$wa=$WckAr;$wc=$WckPipe;$script:WckAr=$null;$script:WckPipe=$null
$wcode='hook-conn';$wgot=$null;$wcts=$null;$wacc=$true
try{$wc.EndWaitForConnection($wa)}catch{$wacc=$false}
if($wacc){
try{$wcts=[Threading.CancellationTokenSource]::new();$wcode=SupHookServe $K $CH $ChildPid $Job $WPid $wc $WckRun $WckKey __HOOK_BUDGET_MS__ $wcts.Token ([ref]$wgot)}catch{$wcode='hook-unexpected'}
if($null -ne $wcts){try{$wcts.Dispose()}catch{}}}
$wdisp=$true;try{$wc.Dispose()}catch{$wdisp=$false}
if(($wcode -ceq 'hook-unsettled') -or ($wcode -ceq 'hook-unexpected') -or -not $wdisp){if($null -ne $wgot){try{$wgot.Clear()}catch{}};$wgot=$null;SupFail 'hook-unsettled' 45}
if(($wcode -ceq 'candidate') -and ($wgot -is [hashtable]) -and ((SupPeerHeld $K $CH $ChildPid $Job) -ceq 'ok')){
SupWckClear;$script:WckSeq++;$script:WckCand=$wgot;$wgot=$null
SupOut ('SUP_CAND '+[string]$WckSeq+' '+[string]$WckCand.SessionId)}
else{if($null -ne $wgot){try{$wgot.Clear()}catch{}};$wgot=$null}
SupWckArm $false}
`.trim();

/**
 * Run-loop step: accept only in `run` (before it an armed early client just
 * waits, buffered), and only when owner stdin has nothing pending — no
 * completed read and no partial command — so a stop command is never queued
 * behind more than the one turn already running.
 */
const HOOK_LOOP = String.raw`if($Phase -ceq 'run' -and $InLine -ceq '' -and -not $InTask.IsCompleted){if($null -ne $WckAr){if($WckAr.IsCompleted){$busy=$true;SupWckTurn}}elseif($null -ne $WckRetry -and $WckRetry.ElapsedMilliseconds -ge __HOOK_REARM_MS__){SupWckArm $false}}`;

/** Insert `text` before/after (or replace) the ONE occurrence of `anchor`. */
function spliceOnce(template: string, anchor: string, text: string, where: "before" | "after"): string {
  const at = template.indexOf(anchor);
  if (at < 0 || template.indexOf(anchor, at + 1) >= 0) throw new Error("hook splice anchor is not unique");
  return where === "before"
    ? template.slice(0, at) + text + template.slice(at)
    : template.slice(0, at + anchor.length) + text + template.slice(at + anchor.length);
}

/**
 * The opt-in hook supervisor template: the UNCHANGED default template plus
 * anchored insertions. Every default line survives verbatim and in order, so
 * the custody grammar, deadlines, refusal routes, and settlement witness are
 * the default ones; the hook mode only adds.
 */
export const WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE: string = (() => {
  let t = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE;
  t = spliceOnce(t, "$Phase='accept';$CtlAr=$null;$CtlTask=$null;$CtlR=$null;$CtlW=$null\n", `${HOOK_STATE}\n`, "after");
  t = spliceOnce(t, "function SupFail([string]$stage,[int]$code){", `${HOOK_STOP}\n`, "before");
  t = spliceOnce(t, "function SupFail([string]$stage,[int]$code){", "SupWckStop;", "after");
  t = spliceOnce(t, "SupDef 'SetConsoleCtrlHandler' $TF @($TI,$TF)\n", `${HOOK_INTEROP_DECLARATIONS.join("\n")}\n`, "after");
  t = spliceOnce(t, "if(-not $K::SetConsoleCtrlHandler($Z,$true)){SupFail 'ctrl-ignore' 6}\n", `${HOOK_KEY_READ}\n`, "after");
  t = spliceOnce(t, "$Ctl=SupPipe $CtlName\n", `${HOOK_PIPE}\n`, "after");
  t = spliceOnce(t, "function SupSettle{\n", "SupWckStop\n", "after");
  t = spliceOnce(t, "\nwhile($true){\n", `\n${HOOK_FIXED_MARKER}\n${HOOK_TURN}`, "before");
  t = spliceOnce(t, "if(-not $busy){[Threading.Thread]::Sleep(20)}\n", `${HOOK_LOOP}\n`, "before");
  return t;
})();

/**
 * Compose the immutable fixed sources into a rendered hook supervisor body,
 * after placeholder rendering, so neither is ever scanned or altered.
 */
function composeHookFixedSources(rendered: string): string {
  const fixed = `${WINDOWS_CLAUDE_HOOK_RECEIVE_SOURCE}\n${PEER_HELD_SOURCE}`;
  const at = rendered.indexOf(HOOK_FIXED_MARKER);
  if (at < 0 || rendered.indexOf(HOOK_FIXED_MARKER, at + 1) >= 0) throw new Error("hook fixed-source marker is not unique");
  return rendered.slice(0, at) + fixed + rendered.slice(at + HOOK_FIXED_MARKER.length);
}

/**
 * The ONE implementation contract of the opt-in hook channel, for the future
 * bind/send work (documentation data; nothing here activates anything).
 *
 * Today the channel is: a protected listener created before `SUP_READY`,
 * authentication only under live `SUP_CHILD` custody, at most one retained
 * candidate in supervisor memory, and a nonsecret `SUP_CAND` record. It is
 * NOT a binding, NOT delivery, NOT callback enablement, and NOT ownership.
 */
export const WINDOWS_CLAUDE_CUSTODY_HOOK_CHANNEL_CONTRACT = Object.freeze({
  /** Opt-in only: `hookPipe` on the renderer AND `hookCandidates` on the transport. */
  activation: "renderer-hookPipe-and-transport-hookCandidates",
  keyFrame: Object.freeze({
    wire: "PRG-WCK1 <64 lowercase hex key> <runId>\\n",
    /** Written by the transport in the SAME write as the boot frame, read by the bootstrap's own `$StdIn`. */
    reader: "bootstrap-startup-reader-only",
    order: "after-hashed-startup-source-before-SUP_READY",
    /** The bootstrap's own `$BootClock` startup-frame budget, shared with the source read and rechecked after the LF. */
    deadline: "shared-bootstrap-startup-frame-budget",
    /** Equal to the transport's pinned run; the receiver matches candidates against it. */
    runId: "transport-pinned-run",
    /** The key exists only in the transport's one write buffer (zeroed after the write) and supervisor memory. */
    keyResidence: "write-buffer-then-supervisor-memory-only",
  }),
  listener: Object.freeze({
    name: "\\\\.\\pipe\\prg682-hook-<32 lowercase hex>",
    flags: "PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE; PIPE_REJECT_REMOTE_CLIENTS; max 1 instance",
    dacl: "protected; exactly one explicit allow ACE (GENERIC_ALL) for the current user SID; read back before use",
    inheritance: "bInheritHandle FALSE; proven with GetHandleInformation",
    created: "before-SUP_READY",
    armed: "before-GO",
    /**
     * After each connection: dispose, then a fresh first instance. An ordinary
     * run-phase creation/arm failure retries and never ends custody; a failed
     * release of a listener handle fails closed (`hook-unsettled`).
     */
    rearm: "dispose-then-new-first-instance",
    handleOwnership: "single-owner-transfer-raw-then-safehandle-then-stream",
  }),
  serve: Object.freeze({
    phase: "run",
    function: WINDOWS_CLAUDE_HOOK_RECEIVE_FUNCTION,
    budgetMs: WINDOWS_CLAUDE_CUSTODY_HOOK_SERVE_BUDGET_MS,
    maxBlockingMs: WINDOWS_CLAUDE_CUSTODY_HOOK_MAX_BLOCKING_MS,
    /**
     * A new turn starts only with no owner stdin pending, so `SETTLE` waits
     * behind at most one running turn: the driver's settle deadline must cover
     * `maxBlockingMs` plus the supervisor's `settleMs`.
     */
    stdinPriority: "no-new-turn-while-stdin-read-complete-or-command-partial",
    /** Only these end custody; every other refusal is isolated and silent. */
    failClosed: Object.freeze(["hook-unsettled", "hook-unexpected", "dispose-failed"] as const),
    heldCheck: WINDOWS_CLAUDE_INBOX_PEER_HELD_FUNCTION,
  }),
  candidate: Object.freeze({
    record: "SUP_CAND <positive forward sequence> <canonical lowercase UUID>",
    /** Only the latest candidate exists; a new one clears and replaces it; settle/refusal/exit clear it. */
    retention: "latest-only-supervisor-memory",
    sequence: "per-run, starts at 1, exactly +1 per announced candidate",
    /** The transport credits candidates only before settle() starts; a genuine in-flight one is tolerated, uncredited. */
    transport: "latest-closed-metadata-only-before-settle",
  }),
  /**
   * What future bind/send work must add, in order, and what it must never do.
   * A host binding requires the authenticated broker status, the exact live
   * root/session/CWD match for `sessionId`, and a subsequent generation; only
   * then may a new closed driver command name the EXACT latest sequence, and
   * the supervisor may act only if that sequence still names its retained
   * candidate. Sending composes the inbox-write source against that retained
   * candidate under the same live custody. Nothing binds, sends, or opens an
   * inbox from `SUP_CAND` alone, and the token and endpoint never leave the
   * supervisor.
   */
  futureBindSend: Object.freeze([
    "host correlates SUP_CAND sessionId with authenticated broker status and exact live root/session/CWD",
    "host requires a subsequent generation before any binding",
    "a new closed driver command names the exact latest sequence; a stale or superseded sequence is refused",
    "supervisor sends only via the inbox-write composition against its retained candidate under live SUP_CHILD custody",
    "never bind, send, or open an inbox from SUP_CAND metadata alone; token and endpoint never leave the supervisor",
  ] as const),
});

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
  /**
   * OPT-IN hook channel: the nonsecret `prg682-hook-<32 lowercase hex>` pipe
   * name. Omitted (the default) renders the unchanged default supervisor,
   * byte for byte. When present, the supervisor additionally reads one key
   * frame before `SUP_READY`, creates the protected listener before
   * `SUP_READY`, arms it before `GO`, and services it only in `run` (see
   * {@link WINDOWS_CLAUDE_CUSTODY_HOOK_CHANNEL_CONTRACT}). The transport must
   * then be attached with `hookCandidates: true` and started with the key.
   */
  readonly hookPipe?: string;
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
  readonly hookPipe: string | null;
}): string {
  const common = {
    FAIL_BASE: String(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_FAIL_BASE),
    CTL_PIPE: values.ctlPipe,
    CTL_NONCE: values.ctlNonce,
    START_MS: String(values.maxMs),
    SETTLE_MS: String(values.settleMs),
  };
  if (values.hookPipe === null) return render(WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SOURCE_TEMPLATE, common);
  return composeHookFixedSources(render(WINDOWS_CLAUDE_CUSTODY_HOOK_SUPERVISOR_SOURCE_TEMPLATE, {
    ...common,
    HOOK_PIPE: values.hookPipe,
    HOOK_BUDGET_MS: String(WINDOWS_CLAUDE_CUSTODY_HOOK_SERVE_BUDGET_MS),
    HOOK_REARM_MS: String(WINDOWS_CLAUDE_CUSTODY_HOOK_REARM_MS),
    KEY_FRAME_MAX: String(WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_CHARS),
    KEY_FRAME_MS: String(WINDOWS_CLAUDE_CUSTODY_STARTUP_FRAME_MS),
  }));
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
  // Only an OMITTED hookPipe selects the default supervisor; null or any
  // malformed value is refused, never coerced into "no hook".
  const hookPipe = input.hookPipe === undefined
    ? null
    : checkHex32(input.hookPipe, "hookPipe must be prg682-hook-<32 hex>", WINDOWS_CLAUDE_CUSTODY_HOOK_PIPE_PATTERN);
  const source = renderSupervisorSource({ ctlPipe, ctlNonce, maxMs, settleMs, hookPipe });
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
    ...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_HOOK_FAIL_STAGES,
  })) {
    if (stageCode === code) return { kind: "failed", stage, code };
  }
  return { kind: "unknown", exitCode: unsigned };
}