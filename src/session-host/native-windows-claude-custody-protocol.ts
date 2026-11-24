/**
 * Private Windows Claude custody supervisor transport (#682), first staged
 * slice: a bounded, strict driver for ONE explicitly supplied, exact owned
 * supervisor {@linkcode ChildProcess} over its private anonymous stdin/stdout
 * pipes.
 *
 * ## Scope (what this module is and is not)
 *
 * - Transport only. It renders no PowerShell, spawns nothing, wires no PTY,
 *   launch, hook route, or product start/stop, and is not activated by any
 *   product path in this slice. The caller supplies the already-spawned
 *   supervisor process (started BEFORE the node-pty wrapper) and the boot
 *   source text; this module validates and frames them.
 * - The supervisor's stderr is drained and discarded under a byte bound. It is
 *   never parsed, retained, replayed, or surfaced; only its byte count is
 *   observable.
 * - The terminal (PTY output, screen text, a reported PTY marker) never
 *   supplies authority. The only inputs that advance custody are the
 *   supervisor's closed stdout records, the owned process's own lifecycle
 *   events, and the caller's synchronous read of node-pty's current PID.
 *
 * ## Wire contract (closed; ASCII only)
 *
 * Driver → supervisor stdin:
 *
 * 1. Bootstrap, once: the fixed 18-byte header
 *    `PRG-WCS1 ` + 8 zero-padded decimal digits (the body length) + `\n`,
 *    followed by exactly that many bytes of printable-ASCII source (plus TAB,
 *    CR, LF), at most {@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES}.
 * 2. Then single-line commands only: `CONFIRM <pid>\n` and `SETTLE\n` (the
 *    opt-in hook control mode adds `BIND`, `DROP`, and `SEND`; see below).
 *
 * Supervisor stdout → driver, one record per line (`\n`, with one optional
 * `\r` before it), each at most
 * {@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES} bytes, in exactly
 * this order. A fragment still waiting for its `\n` must already be bounded,
 * printable ASCII (a CR only as its last byte, and only after a complete
 * record), and a prefix of a syntactically valid record the current phase
 * expects, or the transport poisons before any wait
 * advances; and no command is ever written while such a fragment is pending,
 * so a late `\n` can never turn pre-command output into `SUP_GO` or
 * `SUP_SETTLED` authority:
 *
 * - `SUP_READY <pid>` — the supervisor's actual PID; must equal the owned
 *   process's PID. This is the pre-spawn readiness signal: the caller may now
 *   spawn the node-pty wrapper.
 * - `SUP_WRAPPER <pid> PROVISIONAL` — the kernel-verified peer PID of the
 *   wrapper that connected, whose handles the supervisor holds provisionally.
 * - (driver `CONFIRM <pid>`, written only when node-pty's current positive PID
 *   equals the reported wrapper PID, read synchronously at the write fence)
 * - `SUP_GO <pid>` — the supervisor released the wrapper after the match.
 * - `SUP_CHILD <pid>` — the wrapper's child is established under the
 *   supervisor's held creation handle.
 * - (driver `SETTLE`)
 * - `SUP_SETTLED ACTIVE=0 LISTED=0` — the explicit positive job-empty record.
 *   Any nonzero count is not settlement.
 * - `SUP_BYE` — then a clean close.
 *
 * ## Settlement (unknown stays unknown)
 *
 * {@linkcode NativeWindowsClaudeCustodyTransport.settle} reports `settled`
 * only when ALL of: `SUP_SETTLED ACTIVE=0 LISTED=0`, then `SUP_BYE`, then
 * stdout ended with no trailing bytes, the exact owned process exited with
 * code 0 and no signal, and the process `close` event fired (stdout drained
 * through close), with no poison at any point. A bare PID, a PTY marker, a
 * nonzero job count, or a process that merely disappeared is never settlement.
 *
 * ## Fail-closed poison
 *
 * Process death or error outside the settlement tail, a deadline, a
 * cancellation, a malformed, oversized, non-ASCII, unsolicited, duplicate, or
 * contradictory record, a stdout/stderr bound overflow, a truncated line, a
 * stream error, a missing or mismatched peer, or a nonzero job count poisons
 * the transport: it becomes terminal, writes nothing further, destroys its
 * stdin, kills the owned process if it is still running (a job configured to
 * kill on close then takes its members with it), and settles any waiter with
 * a closed code. Caller misuse (`busy`, `out-of-order`, an invalid boot
 * source) is refused without writing and without changing state.
 *
 * ## Send bridge
 *
 * Sends run against the exact run context with a per-attempt two-phase
 * prepare/commit, one attempt in flight. The per-attempt callback text is
 * supplied as a thunk that is never invoked before every current check passes
 * at commit, so a stale attempt is rejected without materializing or sending
 * anything. Without the opt-in hook control mode no wire send exists: a
 * commit that passes every check reports `not-sent` / `lane-unavailable` and
 * still never invokes the thunk.
 *
 * ## Opt-in hook candidate channel (`hookCandidates: true`)
 *
 * Without the option every byte, record, phase, bound, and result above is
 * exactly the default contract. With it (matching a supervisor rendered with
 * `hookPipe`):
 *
 * - `start()` requires `hookKey` (64 lowercase hex) and writes, in the SAME
 *   single write as the boot frame and immediately after it, exactly one key
 *   frame `PRG-WCK1 <key> <runId>\n` whose run id is this transport's pinned
 *   run. The key is validated before any byte is written, lives only in that
 *   one write buffer (zero-filled once the write completes), and is never
 *   retained, returned, logged, or surfaced; without the option a supplied
 *   key is refused (`hook-key-invalid`) and nothing is written.
 * - One extra record exists: `SUP_CAND <seq> <uuid>` (a positive sequence
 *   with no leading zero that must be exactly the previous one plus one,
 *   starting at 1, and a canonical lowercase 8-4-4-4-12 session id). It is
 *   admissible only once `SUP_CHILD` was accepted: in phase `child` and, as a
 *   genuine in-flight record, between `SETTLE` and `SUP_SETTLED` (phase
 *   `settling`) of a stop that began after `SUP_CHILD` — never in a stop
 *   from `ready`, `wrapper-reported`, or `go`.
 *   Anywhere else, a malformed one, or a sequence that is not exactly the next
 *   one poisons; partial fragments obey the same prefix rule as every other
 *   record.
 * - Only the LATEST candidate is held, as closed metadata
 *   (`{ sequence, sessionId }`), and only while it can be credited: from the
 *   moment `settle()` begins, or on any poison, the held candidate is cleared
 *   and later records are tolerated but never credited.
 *   {@linkcode NativeWindowsClaudeCustodyTransport.observeHookCandidate}
 *   returns it only for the exact current run under live custody; it never
 *   writes, waits, or changes state. A candidate is correlation metadata for
 *   a future host binding — never a binding, a callback, or ownership.
 * - Candidate records are charged per line (each within the line bound), not
 *   against the lifetime stdout bound, so a long healthy row has no
 *   candidate-count cutoff; every other record still is, and each stdout
 *   chunk is bounded by {@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_CHUNK_BYTES}.
 * - `settle()` from `child` first waits (inside its own deadline) for a
 *   pending candidate fragment to complete, so a genuine final candidate never
 *   blocks the exact bounded stop; the write fence itself is unchanged.
 *
 * ## Opt-in hook control (`hookControl: true`, requires `hookCandidates: true`)
 *
 * Without the option every byte, record, phase, bound, and result above is
 * exactly the default or candidate-only contract. With it (matching a
 * supervisor rendered with `hookPipe` and `hookControl`), and only in phase
 * `child`, the owner may write exactly three more commands, ONE unanswered
 * command at a time and never while supervisor output is mid-record:
 *
 * - `BIND <seq>\n` ({@linkcode NativeWindowsClaudeCustodyTransport.bindHookCandidate}):
 *   the caller supplies the candidate it ALREADY correlated (root/session),
 *   which must be exactly the latest credited candidate of the exact current
 *   run; its synchronous fence is read right before the write. Local write
 *   authority exists only after the exact reply `SUP_BIND <seq> OK` to that
 *   command, never from `SUP_CAND`.
 * - `DROP <seq>\n` ({@linkcode NativeWindowsClaudeCustodyTransport.dropHookCandidate}):
 *   for the exact run only (a foreign run or generation changes nothing),
 *   local authority for `<seq>` is revoked before anything else, on every path.
 * - `SEND <attempt> <boundSeq> <n>\n<n canonical base64 chars>\n` (a
 *   control-mode `commit(payload, fence)`): the payload is produced once,
 *   only after the binding, an idle lane, and the caller's fence pass; the
 *   exact current run, the fence, its abort, and every internal fact are
 *   re-read synchronously right before the single write. The body decodes to
 *   the payload's exact strict UTF-8, 1..65536 bytes (the fixed writer's
 *   cap); a payload that throws or is not such text is `payload-invalid`.
 *
 * Each verb names a sequence at most once and only in increasing order (a
 * cancelled `BIND <seq>` still spends `<seq>` for `BIND`), so no reply can be
 * matched to a later command with the same number; a repeated `DROP` revokes
 * locally and writes nothing. The replies are fixed records: `SUP_BIND <seq> OK|STALE|DEAD`,
 * `SUP_DROP <seq>`, and `SUP_SENT <attempt> SENT|UNKNOWN|UNSETTLED|STALE|PEER|CUSTODY|LIMIT|OTHER`.
 * Each is admissible only as the reply to the one unanswered command (in
 * `child`, or in flight across a stop before `SUP_SETTLED`), must echo its
 * exact sequence or attempt, and must not contradict known state; anything
 * else poisons (`frame-unsolicited`, `control-reply`). Each command has a
 * bounded reply deadline ({@linkcode NativeWindowsClaudeCustodyControlDeadlines})
 * that poisons. Reply lines are charged per line like candidates, so a long
 * healthy row has no action-count cutoff.
 *
 * Authority: a newly credited candidate, `DROP`, `settle()`, any poison, and
 * a `STALE`/`UNKNOWN` send reply clear the local binding; `UNSETTLED` also
 * clears the held candidate and refuses every later bind (`lane-poisoned`).
 * A dispatched attempt resolves `sent-unconfirmed` only for `SENT`,
 * `not-sent` only for a typed pre-write refusal, and `unknown` for anything
 * after the frame was handed over (caller abort, deadline, framing fault,
 * uncertain or unsettled write); nothing is retried. After a caller abort the
 * exact reply still drains — its authority effects apply — but it is never
 * credited to the caller or retargeted to another attempt. `settle()` stays
 * allowed with a command unanswered (its reply must precede `SUP_SETTLED`);
 * because the supervisor serves `SETTLE` only after at most one hook turn and
 * one `SEND`, the stop deadline must cover both worst cases plus the
 * supervisor's own settle budget: an omitted `settleMs` takes
 * {@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS} (paired
 * with the supervisor's default), and an explicit one is the caller's
 * coordinated budget. Exact replies are provisional until their whole stdout
 * chunk (residual included) is accepted, and a reply processed at or after
 * its command's monotonic expiry is a deadline miss even if the timer has not
 * fired yet. The callback text
 * is the only payload that crosses stdin; the inbox token, endpoint, and keys
 * never leave the supervisor.
 *
 * Privacy: every failure and diagnostic is a closed code or a count. Raw
 * stdout lines, stderr bytes, the boot source, the hook key, and send
 * payloads never appear in results, diagnostics, or errors.
 */

import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { addAbortListener } from "node:events";
import type { Readable, Writable } from "node:stream";

/* ------------------------------------------------------------------ bounds */

/** Largest accepted boot source body, in bytes. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES = 64 * 1024;
/** Largest accepted supervisor stdout line, excluding its terminator. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES = 96;
/** Total supervisor stdout bytes accepted over the transport's lifetime. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_BYTES = 1024;
/** Total supervisor stderr bytes drained (and discarded) before poisoning. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDERR_BYTES = 64 * 1024;
/** Upper bound for any per-step deadline. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS = 120_000;
/** The fixed bootstrap header magic (followed by 8 decimal digits and `\n`). */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC = "PRG-WCS1 ";
/** Exact byte length of the bootstrap header. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES = NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC.length + 8 + 1;
/** Opt-in hook key frame magic (followed by the 64-hex key, a space, the run id, and `\n`). */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC = "PRG-WCK1 ";
/** Largest opt-in key frame: magic + 64 hex + space + 128-character run id + LF. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_BYTES = NATIVE_WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC.length + 64 + 1 + 128 + 1;
/** Opt-in hook mode: largest single stdout chunk accepted (Node's default pipe read size). */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_CHUNK_BYTES = 64 * 1024;
/** Opt-in hook control: longest control command line, excluding its LF (mirrors the supervisor). */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_COMMAND_CHARS = 48;
/** Opt-in hook control: largest callback text in strict UTF-8 bytes (the fixed writer's content cap). */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES = 65_536;
/** Opt-in hook control: largest canonical base64 `SEND` body, `4 * ceil(65536 / 3)`. */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_BODY_CHARS = 4 * Math.ceil(NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES / 3);

/** Opt-in hook control reply deadlines; each in 1..{@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS}. */
export interface NativeWindowsClaudeCustodyControlDeadlines {
  /** `BIND`/`DROP` written → its exact reply. */
  readonly controlMs: number;
  /** `SEND` frame written → its exact reply. */
  readonly sendMs: number;
}

/**
 * Defaults cover the supervisor's worst case: one hook turn (3000 ms) ahead
 * of the command, plus, for `SEND`, the body read, the writer budget, and its
 * cancel grace (8000 ms).
 */
export const DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES: Readonly<NativeWindowsClaudeCustodyControlDeadlines> = Object.freeze({
  controlMs: 10_000,
  sendMs: 15_000,
});

/**
 * Opt-in hook control only: the driver's stop (`settleMs`) default when the
 * caller supplies none. `SETTLE` may wait behind one hook turn (3000 ms) and
 * one `SEND` (8000 ms) before the supervisor spends its own default settle
 * budget (10000 ms), so the paired default is their sum plus a 4000 ms margin
 * for the settlement records, exit, and close. The default and
 * candidate-only modes keep {@linkcode DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES}.
 * An explicit `settleMs` is the caller's coordinated budget and is used as given.
 */
export const NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS = 3_000 + 8_000 + 10_000 + 4_000;

export interface NativeWindowsClaudeCustodyDeadlines {
  /** Bootstrap written → `SUP_READY`. */
  readonly readyMs: number;
  /** `confirmPeer` called → `SUP_WRAPPER`, and `CONFIRM` written → `SUP_GO`. */
  readonly peerMs: number;
  /** `awaitChild` called → `SUP_CHILD`. */
  readonly childMs: number;
  /** `SETTLE` written → settled record, `SUP_BYE`, and process close. */
  readonly settleMs: number;
}

export const DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES: Readonly<NativeWindowsClaudeCustodyDeadlines> = Object.freeze({
  readyMs: 15_000,
  peerMs: 15_000,
  childMs: 30_000,
  settleMs: 15_000,
});

const MAX_RUN_ID_CHARS = 128;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PID_TEXT = "([1-9][0-9]{0,9})";
const READY_LINE = new RegExp(`^SUP_READY ${PID_TEXT}$`);
const WRAPPER_LINE = new RegExp(`^SUP_WRAPPER ${PID_TEXT} PROVISIONAL$`);
const GO_LINE = new RegExp(`^SUP_GO ${PID_TEXT}$`);
const CHILD_LINE = new RegExp(`^SUP_CHILD ${PID_TEXT}$`);
const SETTLED_LINE = /^SUP_SETTLED ACTIVE=(0|[1-9][0-9]{0,9}) LISTED=(0|[1-9][0-9]{0,9})$/;
const BYE_LINE = /^SUP_BYE$/;
const CAND_LINE = /^SUP_CAND ([1-9][0-9]{0,15}) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const HOOK_KEY = /^[0-9a-f]{64}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIND_OUTCOMES = ["OK", "STALE", "DEAD"] as const;
const SENT_OUTCOMES = ["SENT", "UNKNOWN", "UNSETTLED", "STALE", "PEER", "CUSTODY", "LIMIT", "OTHER"] as const;
const BIND_LINE = /^SUP_BIND ([1-9][0-9]{0,15}) (OK|STALE|DEAD)$/;
const DROP_LINE = /^SUP_DROP ([1-9][0-9]{0,15})$/;
const SENT_LINE = /^SUP_SENT ([1-9][0-9]{0,15}) (SENT|UNKNOWN|UNSETTLED|STALE|PEER|CUSTODY|LIMIT|OTHER)$/;
const MAX_PID = 0xffff_ffff;
/** Canonical lowercase UUID shape, position by position: `h` hex digit, `-` hyphen. */
const UUID_SHAPE = "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh";

/* ------------------------------------------------------------------ inputs */

/** The exact run this transport's custody belongs to. Host state, never a payload. */
export interface NativeWindowsClaudeCustodyRun {
  readonly runId: string;
  readonly generation: number;
}

export interface NativeWindowsClaudeCustodyTransportOptions {
  /**
   * The exact owned supervisor process, spawned by the caller with private
   * anonymous `pipe` stdin/stdout/stderr and not read by anyone else.
   */
  readonly child: ChildProcess;
  /** The exact run this custody belongs to. */
  readonly run: NativeWindowsClaudeCustodyRun;
  /**
   * Synchronous, nonblocking host read: `run` is still the current run. It is
   * consulted at the send bridge's prepare and commit fences.
   */
  readonly isRunCurrent: () => boolean;
  /** Aborting poisons the transport (`cancelled`). */
  readonly signal?: AbortSignal;
  /** Per-step deadlines; each in 1..{@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS}. */
  readonly deadlines?: Partial<NativeWindowsClaudeCustodyDeadlines>;
  /**
   * OPT-IN hook candidate channel (default off), for a supervisor rendered
   * with `hookPipe`. Off keeps the default grammar exactly.
   */
  readonly hookCandidates?: boolean;
  /**
   * OPT-IN hook control (default off; requires `hookCandidates: true`), for a
   * supervisor rendered with `hookPipe` and `hookControl`. Off keeps the
   * candidate-only (or default) behavior exactly.
   */
  readonly hookControl?: boolean;
  /** Opt-in hook control only: reply deadlines (see {@linkcode DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES}). */
  readonly controlDeadlines?: Partial<NativeWindowsClaudeCustodyControlDeadlines>;
}

export interface NativeWindowsClaudeCustodyStepOptions {
  /** Aborting the step poisons the whole transport (`cancelled`). */
  readonly signal?: AbortSignal;
}

export interface NativeWindowsClaudeCustodyStartOptions extends NativeWindowsClaudeCustodyStepOptions {
  /**
   * Opt-in hook mode only, and then required: the per-run 64-lowercase-hex
   * key, written once in the key frame and never retained.
   */
  readonly hookKey?: string;
}

/* ----------------------------------------------------------------- results */

export type NativeWindowsClaudeCustodyAttachRefusal =
  /** Options are not a usable child, run, predicate, and deadlines. */
  | "options-invalid"
  /** The child has no positive PID or already exited. */
  | "child-not-running"
  /** stdin/stdout/stderr are not private pipes this transport can own exclusively. */
  | "stdio-unavailable"
  /** A transport was already attached to this child. */
  | "already-attached";

export type NativeWindowsClaudeCustodyAttach =
  | { readonly status: "attached"; readonly transport: NativeWindowsClaudeCustodyTransport }
  | { readonly status: "refused"; readonly code: NativeWindowsClaudeCustodyAttachRefusal };

/** Why the transport poisoned. Terminal; closed codes only. */
export type NativeWindowsClaudeCustodyPoisonCode =
  | "pid-mismatch"
  | "peer-missing"
  | "peer-mismatch"
  | "pty-pid-unavailable"
  | "frame-invalid"
  | "frame-unsolicited"
  | "frame-duplicate"
  | "frame-oversized"
  | "stdout-overflow"
  | "stdout-truncated"
  | "stdout-closed"
  | "stderr-overflow"
  | "stream-error"
  | "stdin-error"
  | "process-exited"
  | "process-error"
  | "exit-abnormal"
  | "job-not-empty"
  | "timeout"
  | "cancelled"
  | "disposed"
  /** Opt-in hook mode: a `SUP_CAND` sequence that is not exactly the next one. */
  | "candidate-sequence"
  /**
   * Opt-in hook control: a reply naming another sequence or attempt, or one
   * that contradicts what the transport already knows (a bind accepted after
   * a newer candidate, a delivery outcome after the binding was superseded,
   * a settlement record while a command is unanswered).
   */
  | "control-reply";

/** Caller misuse refused without writing and without changing state. */
export type NativeWindowsClaudeCustodyMisuseCode = "busy" | "out-of-order" | "source-invalid" | "hook-key-invalid";

export type NativeWindowsClaudeCustodyFailure =
  | { readonly status: "failed"; readonly code: NativeWindowsClaudeCustodyPoisonCode; readonly poisoned: true }
  | { readonly status: "failed"; readonly code: NativeWindowsClaudeCustodyMisuseCode; readonly poisoned: false };

export type NativeWindowsClaudeCustodyStartResult =
  | { readonly status: "ready-for-pty-spawn"; readonly supervisorPid: number }
  | NativeWindowsClaudeCustodyFailure;

export type NativeWindowsClaudeCustodyConfirmResult =
  | { readonly status: "peer-confirmed"; readonly wrapperPid: number }
  | NativeWindowsClaudeCustodyFailure;

export type NativeWindowsClaudeCustodyChildResult =
  | { readonly status: "child-established"; readonly childPid: number }
  | NativeWindowsClaudeCustodyFailure;

export interface NativeWindowsClaudeCustodySettlementWitness {
  readonly supervisorPid: number;
  readonly jobActive: 0;
  readonly jobListed: 0;
  readonly exitCode: 0;
}

export type NativeWindowsClaudeCustodySettleResult =
  | { readonly status: "settled"; readonly witness: NativeWindowsClaudeCustodySettlementWitness }
  | NativeWindowsClaudeCustodyFailure;

export type NativeWindowsClaudeCustodyDrainResult =
  | { readonly status: "closed" }
  | { readonly status: "not-closed"; readonly code: "timeout" | "cancelled" };

export type NativeWindowsClaudeCustodyPhase =
  | "attached"
  | "booting"
  | "ready"
  | "wrapper-reported"
  | "confirming"
  | "go"
  | "child"
  | "settling"
  | "settled-record"
  | "bye"
  | "settled"
  | "poisoned";

/** Counts and closed codes only — never raw bytes. */
export interface NativeWindowsClaudeCustodyDiagnostics {
  readonly phase: NativeWindowsClaudeCustodyPhase;
  readonly poisonCode: NativeWindowsClaudeCustodyPoisonCode | null;
  readonly recordsAccepted: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly processExited: boolean;
  readonly processClosed: boolean;
  /** Close registrations still held by pending `drain` calls. */
  readonly pendingDrains: number;
  /** Opt-in hook mode: candidates credited (always 0 when off). */
  readonly hookCandidatesCredited: number;
  /** Opt-in hook mode: genuine candidates tolerated after `settle()` began, never credited. */
  readonly hookCandidatesUncredited: number;
  /** Opt-in hook control: exact replies accepted (always 0 when off). */
  readonly hookControlReplies: number;
  /** Opt-in hook control: exact replies drained after their caller stopped waiting. */
  readonly hookControlDrained: number;
  /** Opt-in hook control: whether local write authority is currently bound. */
  readonly hookControlBound: boolean;
}

/* ------------------------------------------------------- hook candidates */

/** Closed, nonsecret correlation metadata for the latest credited candidate. */
export interface NativeWindowsClaudeCustodyHookCandidate {
  /** Positive, per-run, exactly +1 per announced candidate. */
  readonly sequence: number;
  /** Canonical lowercase 8-4-4-4-12 UUID. */
  readonly sessionId: string;
}

export type NativeWindowsClaudeCustodyHookCandidateObservation =
  | { readonly status: "candidate"; readonly candidate: NativeWindowsClaudeCustodyHookCandidate }
  | { readonly status: "none" }
  | {
      readonly status: "refused";
      readonly code: "hook-disabled" | "run-not-current" | "custody-not-current";
    };

/* ------------------------------------------------------------- send bridge */

export type NativeWindowsClaudeCustodySendRefusal =
  /** Another attempt is prepared, or dispatched and unanswered. */
  | "attempt-in-flight"
  /** The context is not the transport's exact run, or the host says it is no longer current. */
  | "run-not-current"
  /** The child is not (or no longer) established under live, unpoisoned custody. */
  | "custody-not-current"
  /** This attempt was already committed or abandoned. */
  | "attempt-spent"
  /** Every check passed, but this transport has no wire send lane (hook control is off). */
  | "lane-unavailable"
  /**
   * Opt-in hook control: no exact local binding, the fence names another
   * binding, a newer candidate superseded it, or the caller's synchronous
   * binding read returned anything but `true` (or threw).
   */
  | "binding-not-current"
  /** Opt-in hook control: another control command is unanswered, or supervisor output is mid-record. */
  | "control-busy"
  /** Opt-in hook control: the payload source threw or produced no valid 1..65536-byte well-formed text. */
  | "payload-invalid"
  /** Opt-in hook control: the fence signal was aborted before any byte was written. */
  | "cancelled";

/**
 * Supplies the per-attempt callback text. Invoked at most once, only at
 * commit, only in the opt-in hook control mode, and only after every current
 * check (including the caller's binding fence) passed. Never invoked
 * otherwise.
 */
export type NativeWindowsClaudeCustodySendPayloadSource = () => string;

/**
 * Opt-in hook control: the caller's synchronous fence for one exact binding.
 * Consulted immediately before the payload is produced and again immediately
 * before any byte is committed.
 */
export interface NativeWindowsClaudeCustodyHookBindingFence {
  /** Synchronous host read: the caller's correlation for this exact binding is still current. Only `true` passes. */
  readonly isBindingCurrent: () => boolean;
  /**
   * Aborting before the command is written refuses it without writing;
   * aborting after makes the caller's result `unknown` (the exact reply still
   * drains, and is never retargeted or credited).
   */
  readonly signal?: AbortSignal;
}

/** Opt-in hook control: the send fence names the exact binding the caller authorizes. */
export interface NativeWindowsClaudeCustodySendFence extends NativeWindowsClaudeCustodyHookBindingFence {
  readonly binding: NativeWindowsClaudeCustodyHookCandidate;
}

/**
 * The closed outcome of one dispatched attempt. `sent-unconfirmed` only when
 * the supervisor reports the fixed writer's full native write; `not-sent`
 * only for the supervisor's typed refusal before the writer wrote anything;
 * every other ending after the frame was handed to the supervisor —
 * cancellation, a deadline, a framing fault, an ambiguous or unsettled write
 * — is `unknown`. Never retried.
 */
export type NativeWindowsClaudeCustodySendOutcome =
  | { readonly status: "sent-unconfirmed"; readonly attemptId: number }
  | { readonly status: "not-sent"; readonly attemptId: number; readonly code: "stale" | "peer" | "custody" | "limit" | "other" }
  | {
      readonly status: "unknown";
      readonly attemptId: number;
      readonly code: "write-uncertain" | "write-unsettled" | "cancelled" | "timeout" | "transport-failed";
    };

export type NativeWindowsClaudeCustodySendCommit =
  | { readonly status: "not-sent"; readonly code: NativeWindowsClaudeCustodySendRefusal }
  /** Opt-in hook control only: the frame was handed to the supervisor; `outcome` never rejects. */
  | { readonly status: "dispatched"; readonly attemptId: number; readonly outcome: Promise<NativeWindowsClaudeCustodySendOutcome> };

export interface NativeWindowsClaudeCustodySendAttempt {
  readonly attemptId: number;
  /**
   * Re-proves every check synchronously, then — only in the opt-in hook
   * control mode with an exact current binding and `fence` — produces the
   * payload once and dispatches exactly one `SEND`; otherwise rejects without
   * sending (and, without hook control, without ever invoking the payload).
   */
  commit(payload: NativeWindowsClaudeCustodySendPayloadSource, fence?: NativeWindowsClaudeCustodySendFence): NativeWindowsClaudeCustodySendCommit;
  /** Releases the in-flight slot without materializing anything. Idempotent. */
  abandon(): void;
}

export type NativeWindowsClaudeCustodySendPrepare =
  | { readonly status: "prepared"; readonly attempt: NativeWindowsClaudeCustodySendAttempt }
  | { readonly status: "refused"; readonly code: "attempt-in-flight" | "run-not-current" | "custody-not-current" };

/* ---------------------------------------------------------- hook control */

/** Opt-in hook control: closed refusals of a command that was never written. */
export type NativeWindowsClaudeCustodyControlRefusal =
  | "control-disabled"
  | "options-invalid"
  | "run-not-current"
  | "custody-not-current"
  | "binding-not-current"
  | "already-bound"
  | "control-busy"
  | "lane-poisoned"
  | "cancelled";

export type NativeWindowsClaudeCustodyBindResult =
  /** The supervisor bound exactly this candidate and local write authority now names it. */
  | { readonly status: "bound"; readonly binding: NativeWindowsClaudeCustodyHookCandidate }
  /** Nothing was written. */
  | { readonly status: "refused"; readonly code: NativeWindowsClaudeCustodyControlRefusal }
  /** Written and answered, but nothing is bound locally. */
  | { readonly status: "not-bound"; readonly code: "stale" | "stopping" }
  /** Written; the caller stopped waiting. The exact reply drains and is never credited. */
  | { readonly status: "unknown"; readonly code: "cancelled" }
  | NativeWindowsClaudeCustodyFailure;

export type NativeWindowsClaudeCustodyDropResult =
  | { readonly status: "dropped"; readonly sequence: number }
  /** Nothing was written; local authority for the sequence was revoked anyway. */
  | { readonly status: "refused"; readonly code: NativeWindowsClaudeCustodyControlRefusal }
  /** Written; the caller stopped waiting. Local authority was revoked before the write. */
  | { readonly status: "unknown"; readonly code: "cancelled" }
  | NativeWindowsClaudeCustodyFailure;

export type NativeWindowsClaudeCustodyHookBindingObservation =
  | { readonly status: "bound"; readonly binding: NativeWindowsClaudeCustodyHookCandidate }
  | { readonly status: "none" }
  | { readonly status: "refused"; readonly code: "control-disabled" | "run-not-current" | "custody-not-current" };

/* --------------------------------------------------------------- transport */

export interface NativeWindowsClaudeCustodyTransport {
  readonly phase: NativeWindowsClaudeCustodyPhase;
  readonly run: NativeWindowsClaudeCustodyRun;
  /**
   * Write the fixed-header bootstrap and wait for `SUP_READY` naming the owned
   * process's own PID. Success is the pre-spawn readiness signal.
   */
  start(source: string, options?: NativeWindowsClaudeCustodyStartOptions): Promise<NativeWindowsClaudeCustodyStartResult>;
  /**
   * Wait for the supervisor's kernel-verified provisional wrapper PID, then,
   * synchronously at the write fence, read node-pty's current PID and write
   * `CONFIRM` only when it is a positive integer equal to the reported PID;
   * then wait for the matching `SUP_GO`. A missing or mismatched peer poisons
   * without writing `CONFIRM`.
   */
  confirmPeer(
    readPtyPid: () => unknown,
    options?: NativeWindowsClaudeCustodyStepOptions,
  ): Promise<NativeWindowsClaudeCustodyConfirmResult>;
  /** Wait for `SUP_CHILD`: the child is established under the held creation handle. */
  awaitChild(options?: NativeWindowsClaudeCustodyStepOptions): Promise<NativeWindowsClaudeCustodyChildResult>;
  /** Write `SETTLE` and wait for the full witnessed settlement (see module docs). */
  settle(options?: NativeWindowsClaudeCustodyStepOptions): Promise<NativeWindowsClaudeCustodySettleResult>;
  /** Send bridge, phase one: exact-run and custody checks, one attempt in flight. */
  prepareSend(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodySendPrepare;
  /**
   * Opt-in hook mode: the latest credited candidate's closed metadata, only
   * for the exact current run under live, unsettled custody. Synchronous and
   * read-only: it never writes, waits, poisons, or consumes the candidate.
   */
  observeHookCandidate(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyHookCandidateObservation;
  /**
   * Opt-in hook control: ask the supervisor to bind the caller's ALREADY
   * CORRELATED candidate. It must be exactly the latest credited candidate
   * (sequence and session id) of the exact current run under live, unsettled
   * custody, with no command in flight; `fence` is read synchronously right
   * before `BIND` is written. Local write authority exists only after the
   * exact `SUP_BIND <seq> OK` reply to this command — never from `SUP_CAND`.
   */
  bindHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    binding: NativeWindowsClaudeCustodyHookCandidate,
    fence: NativeWindowsClaudeCustodyHookBindingFence,
  ): Promise<NativeWindowsClaudeCustodyBindResult>;
  /**
   * Opt-in hook control: for the exact run only (a foreign run or generation
   * is refused before any slot is touched), revoke local authority for an
   * announced sequence immediately (on every later path), then ask the
   * supervisor to drop it.
   */
  dropHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    sequence: number,
    options?: NativeWindowsClaudeCustodyStepOptions,
  ): Promise<NativeWindowsClaudeCustodyDropResult>;
  /** Opt-in hook control: the current local binding, read-only. */
  observeHookBinding(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyHookBindingObservation;
  /** Poison (`disposed`) unless terminal, then wait for the owned process to close. Never kills twice. */
  drain(options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<NativeWindowsClaudeCustodyDrainResult>;
  /** Poison (`disposed`) unless already terminal. Idempotent. */
  dispose(): void;
  diagnostics(): NativeWindowsClaudeCustodyDiagnostics;
}

/* -------------------------------------------------------------- validation */

const attachedChildren = new WeakSet<object>();

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PID;
}

function validRun(run: unknown): run is NativeWindowsClaudeCustodyRun {
  if (typeof run !== "object" || run === null) return false;
  const { runId, generation } = run as Record<string, unknown>;
  return typeof runId === "string"
    && runId.length >= 1
    && runId.length <= MAX_RUN_ID_CHARS
    && RUN_ID_PATTERN.test(runId)
    && typeof generation === "number"
    && Number.isSafeInteger(generation)
    && generation > 0;
}

function resolveDeadlines(input: unknown): NativeWindowsClaudeCustodyDeadlines | undefined {
  if (input === undefined) return DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES;
  if (typeof input !== "object" || input === null) return undefined;
  const out: Record<string, number> = { ...DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES };
  for (const key of Object.keys(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS) {
      return undefined;
    }
    out[key] = value;
  }
  return out as unknown as NativeWindowsClaudeCustodyDeadlines;
}

function isExclusiveReadable(stream: unknown): stream is Readable {
  if (typeof stream !== "object" || stream === null) return false;
  const readable = stream as Readable;
  return typeof readable.on === "function"
    && readable.readable === true
    && readable.destroyed !== true
    && readable.readableFlowing === null
    && readable.readableEncoding === null
    && readable.listenerCount("data") === 0
    && readable.listenerCount("readable") === 0;
}

function isOwnedWritable(stream: unknown): stream is Writable {
  if (typeof stream !== "object" || stream === null) return false;
  const writable = stream as Writable;
  return typeof writable.write === "function"
    && writable.writable === true
    && writable.destroyed !== true
    && writable.writableEnded !== true;
}

/** Bounded printable ASCII plus TAB, CR, LF; nonempty. */
function encodeBootSource(source: unknown): Buffer | undefined {
  if (typeof source !== "string" || source.length === 0 || source.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES) {
    return undefined;
  }
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (!(code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e))) return undefined;
  }
  const header = `${NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC}${String(source.length).padStart(8, "0")}\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(source, "ascii")]);
}

/**
 * The opt-in key frame `PRG-WCK1 <key> <runId>\n`, or undefined for a key
 * that is not exactly 64 lowercase hex. The run id already passed the run
 * grammar (the supervisor's exact pattern) at attach.
 */
function encodeKeyFrame(key: unknown, runId: string): Buffer | undefined {
  if (typeof key !== "string" || !HOOK_KEY.test(key)) return undefined;
  const frame = Buffer.from(`${NATIVE_WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC}${key} ${runId}\n`, "ascii");
  return frame.length <= NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_KEY_FRAME_BYTES ? frame : undefined;
}

function resolveControlDeadlines(input: unknown): NativeWindowsClaudeCustodyControlDeadlines | undefined {
  if (input === undefined) return DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES;
  if (typeof input !== "object" || input === null) return undefined;
  const out: Record<string, number> = { ...DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES };
  for (const key of Object.keys(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEADLINES)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS) {
      return undefined;
    }
    out[key] = value;
  }
  return out as unknown as NativeWindowsClaudeCustodyControlDeadlines;
}

/** A positive safe integer: a candidate sequence or a send attempt (at most 16 digits). */
function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A frozen copy of a well-formed `{ sequence, sessionId }`, or undefined. */
function copyBinding(value: unknown): NativeWindowsClaudeCustodyHookCandidate | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { sequence, sessionId } = value as Record<string, unknown>;
  if (!isSequence(sequence) || typeof sessionId !== "string" || !UUID_TEXT.test(sessionId)) return undefined;
  return Object.freeze({ sequence, sessionId });
}

function validFence(value: unknown): value is NativeWindowsClaudeCustodyHookBindingFence {
  if (typeof value !== "object" || value === null) return false;
  const { isBindingCurrent, signal } = value as Record<string, unknown>;
  return typeof isBindingCurrent === "function" && (signal === undefined || signal instanceof AbortSignal);
}

/** Caller code: only an exact `true` passes; a throw is a refusal. */
function readFence(fence: NativeWindowsClaudeCustodyHookBindingFence): boolean {
  try {
    return fence.isBindingCurrent() === true;
  } catch {
    return false;
  }
}

/** Nonempty, at most the content cap, and well-formed UTF-16 (no lone surrogate half). */
function isSendableText(text: unknown): text is string {
  if (typeof text !== "string" || text.length === 0 || text.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES) return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * The exact `SEND <attempt> <boundSeq> <n>\n<base64>\n` frame, or undefined.
 * Node's base64 encoder is canonical (padding, zero unused bits); the decoded
 * body is the exact strict UTF-8 of `text`, 1..65536 bytes.
 */
function encodeSendFrame(attemptId: number, boundSeq: number, text: unknown): Buffer | undefined {
  if (!isSequence(attemptId) || !isSequence(boundSeq) || !isSendableText(text)) return undefined;
  const utf8 = Buffer.from(text, "utf8");
  try {
    if (utf8.length < 1 || utf8.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_CONTENT_BYTES) return undefined;
    const body = utf8.toString("base64");
    if (body.length < 4 || body.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_BODY_CHARS || body.length % 4 !== 0) return undefined;
    const header = `SEND ${attemptId} ${boundSeq} ${body.length}`;
    if (header.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_MAX_COMMAND_CHARS) return undefined;
    return Buffer.from(`${header}\n${body}\n`, "ascii");
  } finally {
    utf8.fill(0);
  }
}

function parsePid(text: string): number | undefined {
  const value = Number(text);
  return isPositivePid(value) ? value : undefined;
}

/* -------------------------------------------------------------- the driver */

/**
 * Opt-in hook control: `null` when the line is not a control record at all,
 * `undefined` when it claims to be one but is not exact, else the reply.
 */
function classifyControlReply(line: string): ControlReply | undefined | null {
  const number = (text: string): number | undefined => {
    const value = Number(text);
    return isSequence(value) ? value : undefined;
  };
  if (line.startsWith("SUP_BIND ")) {
    const match = BIND_LINE.exec(line);
    const sequence = match ? number(match[1]!) : undefined;
    return match && sequence !== undefined ? { kind: "bind", sequence, outcome: match[2] as (typeof BIND_OUTCOMES)[number] } : undefined;
  }
  if (line.startsWith("SUP_DROP ")) {
    const match = DROP_LINE.exec(line);
    const sequence = match ? number(match[1]!) : undefined;
    return match && sequence !== undefined ? { kind: "drop", sequence } : undefined;
  }
  if (line.startsWith("SUP_SENT ")) {
    const match = SENT_LINE.exec(line);
    const sequence = match ? number(match[1]!) : undefined;
    return match && sequence !== undefined ? { kind: "sent", sequence, outcome: match[2] as (typeof SENT_OUTCOMES)[number] } : undefined;
  }
  return null;
}

type RecordKind = "ready" | "wrapper" | "go" | "child" | "settled" | "bye" | "cand" | ControlReplyKind;
/** Opt-in hook control reply records. */
type ControlReplyKind = "bind" | "drop" | "sent";

/** Which record each phase accepts; every other record is unsolicited (or a duplicate). */
const EXPECTED: Readonly<Partial<Record<NativeWindowsClaudeCustodyPhase, RecordKind>>> = {
  booting: "ready",
  ready: "wrapper",
  confirming: "go",
  go: "child",
  settling: "settled",
  "settled-record": "bye",
};

/**
 * Token grammar of each record, mirroring the complete-line patterns above:
 * literals, `pid` fields (`[1-9][0-9]{0,9}`, at most 0xFFFFFFFF), and `count`
 * fields (`0|[1-9][0-9]{0,9}`). Used to decide whether a buffered fragment can
 * still become a syntactically valid record.
 */
/** `oneOf`: a closed outcome word; always the record's final token. */
type RecordToken = string | "#pid" | "#count" | "#seq" | "#uuid" | { readonly oneOf: readonly string[] };
const RECORD_GRAMMAR: Readonly<Record<RecordKind, readonly RecordToken[]>> = {
  ready: ["SUP_READY ", "#pid"],
  wrapper: ["SUP_WRAPPER ", "#pid", " PROVISIONAL"],
  go: ["SUP_GO ", "#pid"],
  child: ["SUP_CHILD ", "#pid"],
  settled: ["SUP_SETTLED ACTIVE=", "#count", " LISTED=", "#count"],
  bye: ["SUP_BYE"],
  // Opt-in hook mode only; admissible only where `candidateAdmissible` says so.
  cand: ["SUP_CAND ", "#seq", " ", "#uuid"],
  // Opt-in hook control only; admissible only as the reply to the one unanswered command.
  bind: ["SUP_BIND ", "#seq", " ", { oneOf: BIND_OUTCOMES }],
  drop: ["SUP_DROP ", "#seq"],
  sent: ["SUP_SENT ", "#seq", " ", { oneOf: SENT_OUTCOMES }],
};

/** Every default record kind; `cand` exists only in the opt-in hook mode. */
const DEFAULT_RECORD_KINDS: readonly RecordKind[] = ["ready", "wrapper", "go", "child", "settled", "bye"];
/** Opt-in hook mode record kinds (candidate-only); control adds its replies. */
const HOOK_RECORD_KINDS: readonly RecordKind[] = [...DEFAULT_RECORD_KINDS, "cand"];
const CONTROL_RECORD_KINDS: readonly RecordKind[] = [...HOOK_RECORD_KINDS, "bind", "drop", "sent"];

/**
 * `complete`: `text` is exactly a valid record of this kind. `prefix`: some
 * continuation makes it one. `invalid`: no continuation can.
 */
function matchRecordGrammar(text: string, tokens: readonly RecordToken[]): "complete" | "prefix" | "invalid" {
  let i = 0;
  for (const token of tokens) {
    if (i === text.length) return "prefix";
    if (typeof token === "object") {
      const rest = text.slice(i);
      if (token.oneOf.includes(rest)) {
        i = text.length;
        continue;
      }
      return token.oneOf.some((word) => word.startsWith(rest)) ? "prefix" : "invalid";
    }
    if (token === "#seq") {
      let j = i;
      while (j < text.length && j - i < 16 && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x39) j += 1;
      const digits = text.slice(i, j);
      if (digits.length === 0 || digits[0] === "0" || !Number.isSafeInteger(Number(digits))) return "invalid";
      i = j;
      continue;
    }
    if (token === "#uuid") {
      let j = 0;
      for (; j < UUID_SHAPE.length && i + j < text.length; j += 1) {
        const code = text.charCodeAt(i + j);
        const ok = UUID_SHAPE[j] === "-" ? code === 0x2d : (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
        if (!ok) return "invalid";
      }
      if (j < UUID_SHAPE.length) return "prefix";
      i += j;
      continue;
    }
    if (token === "#pid" || token === "#count") {
      let j = i;
      while (j < text.length && j - i < 10 && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x39) j += 1;
      const digits = text.slice(i, j);
      if (digits.length === 0) return "invalid";
      if (token === "#pid" && (digits[0] === "0" || Number(digits) > MAX_PID)) return "invalid";
      if (token === "#count" && digits[0] === "0" && digits.length > 1) return "invalid";
      i = j;
      continue;
    }
    const rest = text.slice(i);
    if (rest.length < token.length) return token.startsWith(rest) ? "prefix" : "invalid";
    if (!rest.startsWith(token)) return "invalid";
    i += token.length;
  }
  return i === text.length ? "complete" : "invalid";
}

/**
 * Whether a buffered fragment can still become a valid record of `kind`. A
 * fragment ending in CR must already be a complete record (only LF may follow).
 */
function fragmentViable(text: string, trailingCr: boolean, kind: RecordKind): boolean {
  const match = matchRecordGrammar(text, RECORD_GRAMMAR[kind]);
  return trailingCr ? match === "complete" : match !== "invalid";
}

/**
 * Opt-in hook mode: where a `SUP_CAND` record may arrive — only once an
 * accepted `SUP_CHILD` established the child (`childPid`), in `child`, and as
 * a genuine in-flight record between `SETTLE` and `SUP_SETTLED`. A stop that
 * began before `SUP_CHILD` (from `ready`, `wrapper-reported`, or `go`) never
 * earned a hook turn, so `settling` alone grants nothing.
 */
function candidateAdmissible(phase: NativeWindowsClaudeCustodyPhase, childPid: number | null): boolean {
  return childPid !== null && (phase === "child" || phase === "settling");
}

/** Phases in which the owned process may exit without poisoning (the settlement tail). */
const EXIT_TOLERANT: ReadonlySet<NativeWindowsClaudeCustodyPhase> = new Set(["settling", "settled-record", "bye"]);

interface Waiter {
  /** Re-evaluated on every state change; a defined value resolves the waiter. */
  readonly check: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly fail: (code: NativeWindowsClaudeCustodyPoisonCode) => void;
}

/** Opt-in hook control: one exact, parsed reply. */
type ControlReply =
  | { readonly kind: "bind"; readonly sequence: number; readonly outcome: (typeof BIND_OUTCOMES)[number] }
  | { readonly kind: "drop"; readonly sequence: number }
  | { readonly kind: "sent"; readonly sequence: number; readonly outcome: (typeof SENT_OUTCOMES)[number] };

/** How one control command ended for its caller. */
type ControlEnd =
  | { readonly type: "reply"; readonly reply: ControlReply }
  | { readonly type: "poison"; readonly code: NativeWindowsClaudeCustodyPoisonCode }
  | { readonly type: "cancelled" };

/** Opt-in hook control: the ONE written, unanswered command. */
interface ControlOp {
  readonly replyKind: ControlReplyKind;
  /** The number its reply must echo: the sequence (bind/drop) or the attempt (send). */
  readonly echo: number;
  /** The candidate sequence it names (bind/drop) or the bound sequence (send). */
  readonly sequence: number;
  /** Bind only: the caller's correlated session id. */
  readonly sessionId: string | null;
  /** Resolves the caller once; null once the caller stopped waiting (the reply then drains). */
  finish: ((end: ControlEnd) => void) | null;
  timer: NodeJS.Timeout | undefined;
  /** Absolute monotonic expiry (`performance.now()`): a reply processed at or after it is a deadline miss. */
  expiresAt: number;
}

/** Opt-in hook control: the closed outcome of one dispatched attempt. */
function sendOutcome(attemptId: number, end: ControlEnd): NativeWindowsClaudeCustodySendOutcome {
  if (end.type === "cancelled") return { status: "unknown", attemptId, code: "cancelled" };
  if (end.type === "poison") {
    const code = end.code === "timeout" ? "timeout" : end.code === "cancelled" ? "cancelled" : "transport-failed";
    return { status: "unknown", attemptId, code };
  }
  if (end.reply.kind !== "sent") return { status: "unknown", attemptId, code: "transport-failed" };
  switch (end.reply.outcome) {
    case "SENT":
      return { status: "sent-unconfirmed", attemptId };
    case "UNKNOWN":
      return { status: "unknown", attemptId, code: "write-uncertain" };
    case "UNSETTLED":
      return { status: "unknown", attemptId, code: "write-unsettled" };
    case "STALE":
      return { status: "not-sent", attemptId, code: "stale" };
    case "PEER":
      return { status: "not-sent", attemptId, code: "peer" };
    case "CUSTODY":
      return { status: "not-sent", attemptId, code: "custody" };
    case "LIMIT":
      return { status: "not-sent", attemptId, code: "limit" };
    case "OTHER":
      return { status: "not-sent", attemptId, code: "other" };
  }
}

class PoisonedError extends Error {
  constructor(readonly code: NativeWindowsClaudeCustodyPoisonCode) {
    super("native windows claude custody transport poisoned");
  }
}

/**
 * Attach the transport to ONE exact owned supervisor process. Refuses (without
 * touching the process) when the options are malformed, the process is not
 * running, its stdio is not a set of private pipes nobody else is reading, or
 * a transport is already attached to it.
 */
export function attachNativeWindowsClaudeCustodyTransport(
  options: NativeWindowsClaudeCustodyTransportOptions,
): NativeWindowsClaudeCustodyAttach {
  if (typeof options !== "object" || options === null) return { status: "refused", code: "options-invalid" };
  const { child, run, isRunCurrent, signal, hookCandidates, hookControl } = options;
  const resolved = resolveDeadlines(options.deadlines);
  const controlDeadlines = resolveControlDeadlines(options.controlDeadlines);
  // Control mode only: an omitted stop deadline takes the paired control default.
  const deadlines = resolved !== undefined && hookControl === true
    && (options.deadlines === undefined || (options.deadlines as Partial<NativeWindowsClaudeCustodyDeadlines>).settleMs === undefined)
    ? Object.freeze({ ...resolved, settleMs: NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS })
    : resolved;
  if (
    typeof child !== "object" || child === null || typeof child.on !== "function"
    || !validRun(run) || typeof isRunCurrent !== "function" || deadlines === undefined
    || (signal !== undefined && !(signal instanceof AbortSignal))
    // Only an omitted option means "off"; anything but a boolean is refused.
    || (hookCandidates !== undefined && typeof hookCandidates !== "boolean")
    || (hookControl !== undefined && typeof hookControl !== "boolean")
    // Control exists only on top of the candidate channel, and its deadlines only with it.
    || (hookControl === true && hookCandidates !== true)
    || (hookControl !== true && options.controlDeadlines !== undefined)
    || controlDeadlines === undefined
  ) {
    return { status: "refused", code: "options-invalid" };
  }
  if (attachedChildren.has(child)) return { status: "refused", code: "already-attached" };
  if (!isPositivePid(child.pid) || child.exitCode !== null || child.signalCode !== null) {
    return { status: "refused", code: "child-not-running" };
  }
  if (!isOwnedWritable(child.stdin) || !isExclusiveReadable(child.stdout) || !isExclusiveReadable(child.stderr)) {
    return { status: "refused", code: "stdio-unavailable" };
  }
  attachedChildren.add(child);
  const transport = new CustodyTransport(
    child,
    Object.freeze({ runId: run.runId, generation: run.generation }),
    isRunCurrent,
    deadlines,
    hookCandidates === true,
    hookControl === true,
    controlDeadlines,
  );
  transport.arm(signal);
  return { status: "attached", transport };
}

class CustodyTransport implements NativeWindowsClaudeCustodyTransport {
  private currentPhase: NativeWindowsClaudeCustodyPhase = "attached";
  private poison: NativeWindowsClaudeCustodyPoisonCode | null = null;
  private busy = false;
  private readonly seen = new Set<RecordKind>();
  private recordsAccepted = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private partial: Buffer = Buffer.alloc(0);
  private stdoutEnded = false;
  private exitFacts: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
  private processClosed = false;
  private killed = false;
  private readonly waiters = new Set<Waiter>();
  /** Removable close registrations (drain); each is called once on `close`. */
  private readonly closeWaiters = new Set<() => void>();
  private abortCleanup: (() => void) | null = null;
  /** The attachment signal; also checked directly at every fence. */
  private attachSignal: AbortSignal | undefined;

  private supervisorPid: number | null = null;
  private wrapperPid: number | null = null;
  private goPid: number | null = null;
  private childPid: number | null = null;
  private settledRecord = false;
  private bye = false;

  private sendAttemptSeq = 0;
  private sendInFlight: number | null = null;

  /** Opt-in hook control: local write authority — set ONLY by the exact `SUP_BIND <seq> OK` reply. */
  private bound: NativeWindowsClaudeCustodyHookCandidate | null = null;
  /** Opt-in hook control: the one written, unanswered command. */
  private controlOp: ControlOp | null = null;
  /** Opt-in hook control: an exact reply parsed from the current chunk, delivered only once the chunk is accepted. */
  private completed: { readonly finish: (end: ControlEnd) => void; readonly reply: ControlReply } | null = null;
  /** Opt-in hook control: an unsettled write was reported; no bind is ever written again. */
  private laneDead = false;
  private controlReplies = 0;
  private controlDrained = 0;
  /**
   * Opt-in hook control: the last sequence written per verb. Each verb names a
   * sequence at most once (even if its caller stopped waiting), so a reply can
   * never be matched to a later command with the same number.
   */
  private lastBindSeq = 0;
  private lastDropSeq = 0;

  /** Opt-in hook mode: last accepted `SUP_CAND` sequence (credited or not). */
  private candidateSeq = 0;
  /** Opt-in hook mode: the ONLY held candidate; cleared on settle() and on poison. */
  private latestCandidate: NativeWindowsClaudeCustodyHookCandidate | null = null;
  /** Stdout bytes of accepted candidate (and control reply) lines, excluded from the lifetime grammar bound. */
  private candidateBytes = 0;
  private candidatesCredited = 0;
  private candidatesUncredited = 0;
  /** Set when settle() begins: no candidate is credited after that. */
  private settleRequested = false;

  constructor(
    private readonly child: ChildProcess,
    readonly run: NativeWindowsClaudeCustodyRun,
    private readonly isRunCurrent: () => boolean,
    private readonly deadlines: NativeWindowsClaudeCustodyDeadlines,
    private readonly hookMode: boolean,
    private readonly controlMode: boolean,
    private readonly controlDeadlines: NativeWindowsClaudeCustodyControlDeadlines,
  ) {}

  get phase(): NativeWindowsClaudeCustodyPhase {
    return this.currentPhase;
  }

  /** Install every listener once. Called exactly once, right after construction. */
  arm(signal: AbortSignal | undefined): void {
    const child = this.child;
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    const stderr = child.stderr!;
    // Listeners stay attached for the process's lifetime: errors are always
    // consumed so a late broken pipe can never crash the host.
    const listen = (emitter: NodeJS.EventEmitter, event: string, handler: (...args: never[]) => void): void => {
      emitter.on(event, handler as (...args: unknown[]) => void);
    };
    listen(stdin, "error", () => this.poisonWith("stdin-error"));
    listen(stdout, "error", () => this.poisonWith("stream-error"));
    listen(stderr, "error", () => this.poisonWith("stream-error"));
    listen(stdout, "data", (chunk: Buffer) => this.onStdout(chunk));
    listen(stdout, "end", () => this.onStdoutEnd());
    listen(stderr, "data", (chunk: Buffer) => this.onStderr(chunk));
    listen(child, "error", () => this.poisonWith("process-error"));
    listen(child, "exit", (code: number | null, sig: NodeJS.Signals | null) => this.onExit(code, sig));
    listen(child, "close", () => this.onClose());
    this.attachSignal = signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        this.poisonWith("cancelled");
      } else {
        // addAbortListener still runs when an earlier consumer of a shared
        // signal stops immediate propagation.
        const subscription = addAbortListener(signal, () => this.poisonWith("cancelled"));
        this.abortCleanup = () => subscription[Symbol.dispose]();
      }
    }
  }

  /* ------------------------------------------------------------- inbound */

  private onStderr(chunk: Buffer): void {
    // Drained and discarded: never parsed, retained, or replayed.
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDERR_BYTES) this.poisonWith("stderr-overflow");
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.length;
    if (this.poison !== null || this.currentPhase === "settled") return; // drained, discarded
    // Default: one lifetime bound over every byte. Opt-in hook mode: a
    // per-chunk bound up front, and the lifetime bound over every byte that
    // is not an accepted candidate line (checked once the chunk is parsed).
    if (
      this.hookMode
        ? chunk.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_CHUNK_BYTES
        : this.stdoutBytes > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_BYTES
    ) {
      this.poisonWith("stdout-overflow");
      return;
    }
    let buffer = this.partial.length === 0 ? chunk : Buffer.concat([this.partial, chunk]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      let end = newline;
      if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(newline + 1);
      if (line.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES) {
        this.poisonWith("frame-oversized");
        return;
      }
      const candidate = this.onLine(line);
      if (this.poison !== null) return;
      if (candidate) this.candidateBytes += newline + 1;
    }
    if (this.hookMode && this.stdoutBytes - this.candidateBytes > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_BYTES) {
      this.poisonWith("stdout-overflow");
      return;
    }
    // Validate the buffered residual BEFORE any wait advances: a record
    // fragment must already be admissible in the current phase, so a late LF
    // can never complete a record that predates the command soliciting it.
    const residualCode = this.residualFault(buffer);
    if (residualCode !== undefined) {
      this.poisonWith(residualCode);
      return;
    }
    this.partial = Buffer.from(buffer);
    // The whole chunk is accepted: a provisional control reply is now final.
    const completed = this.completed;
    this.completed = null;
    completed?.finish({ type: "reply", reply: completed.reply });
    // Waits advance only once the whole chunk, residual included, is accepted.
    this.notify();
  }

  /**
   * A buffered partial line is acceptable only if it fits the line bound,
   * is printable ASCII (one CR allowed only as its final byte), and is
   * compatible with the record the current phase expects.
   */
  private residualFault(residual: Buffer): NativeWindowsClaudeCustodyPoisonCode | undefined {
    if (residual.length === 0) return undefined;
    const trailingCr = residual[residual.length - 1] === 0x0d;
    const content = trailingCr ? residual.subarray(0, residual.length - 1) : residual;
    if (content.length > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_LINE_BYTES) return "frame-oversized";
    for (const byte of content) {
      if (byte < 0x20 || byte > 0x7e) return "frame-invalid";
    }
    const text = content.toString("ascii");
    if (this.hookMode && candidateAdmissible(this.currentPhase, this.childPid) && fragmentViable(text, trailingCr, "cand")) return undefined;
    const replyKind = this.admissibleReplyKind();
    if (replyKind !== undefined && fragmentViable(text, trailingCr, replyKind)) return undefined;
    const expected = EXPECTED[this.currentPhase];
    if (expected === undefined) return "frame-unsolicited";
    // Must be a prefix of a syntactically valid record for THIS phase — not
    // merely share its header.
    if (fragmentViable(text, trailingCr, expected)) return undefined;
    for (const kind of this.controlMode ? CONTROL_RECORD_KINDS : this.hookMode ? HOOK_RECORD_KINDS : DEFAULT_RECORD_KINDS) {
      if (text.length > 0 && fragmentViable(text, trailingCr, kind)) {
        return this.seen.has(kind) ? "frame-duplicate" : "frame-unsolicited";
      }
    }
    return "frame-invalid";
  }

  /** Parse one complete line; true only for an accepted (opt-in) candidate or control reply record. */
  private onLine(raw: Buffer): boolean {
    for (const byte of raw) {
      if (byte < 0x20 || byte > 0x7e) {
        this.poisonWith("frame-invalid");
        return false;
      }
    }
    const line = raw.toString("ascii");
    const parsed = this.classify(line);
    if (parsed === undefined) {
      this.poisonWith("frame-invalid");
      return false;
    }
    if (parsed.kind === "cand") return this.onCandidate(parsed.sequence, parsed.sessionId);
    if (parsed.kind === "bind" || parsed.kind === "drop" || parsed.kind === "sent") return this.onControlReply(parsed);
    // Every command is answered before SETTLE is read: a settlement record
    // while one is still unanswered contradicts the supervisor's order.
    if (parsed.kind === "settled" && this.controlOp !== null) {
      this.poisonWith("control-reply");
      return false;
    }
    const expected = EXPECTED[this.currentPhase];
    if (expected !== parsed.kind) {
      this.poisonWith(this.seen.has(parsed.kind) ? "frame-duplicate" : "frame-unsolicited");
      return false;
    }
    // A live record from a process already known to have exited is only
    // acceptable inside the settlement tail (buffered before the exit).
    if (this.exitFacts !== null && !EXIT_TOLERANT.has(this.currentPhase)) {
      this.poisonWith("process-exited");
      return false;
    }
    this.seen.add(parsed.kind);
    const fault = this.applyRecord(parsed);
    if (fault !== undefined) {
      this.poisonWith(fault);
      return false;
    }
    this.recordsAccepted += 1;
    // Waiters are notified by onStdout once the rest of the chunk is accepted.
    return false;
  }

  /**
   * Opt-in hook mode: one complete `SUP_CAND`. Admissible only in `child`
   * and (in flight) `settling`, from a live process, with exactly the next
   * sequence. Credited — replacing the one held candidate — only before
   * settle() began; otherwise tolerated and counted, never credited.
   */
  private onCandidate(sequence: number, sessionId: string): boolean {
    if (!candidateAdmissible(this.currentPhase, this.childPid)) {
      this.poisonWith("frame-unsolicited");
      return false;
    }
    if (this.exitFacts !== null && !EXIT_TOLERANT.has(this.currentPhase)) {
      this.poisonWith("process-exited");
      return false;
    }
    if (sequence !== this.candidateSeq + 1) {
      this.poisonWith("candidate-sequence");
      return false;
    }
    this.candidateSeq = sequence;
    // A newly accepted candidate invalidates local write authority until an
    // exact rebind (the supervisor drops its bound candidate the same way).
    this.bound = null;
    if (this.settleRequested || this.currentPhase !== "child") {
      this.candidatesUncredited += 1;
    } else {
      this.latestCandidate = Object.freeze({ sequence, sessionId });
      this.candidatesCredited += 1;
    }
    return true;
  }

  /**
   * Opt-in hook control: the reply kind admissible right now — only for the
   * one written, unanswered command, once `SUP_CHILD` established the child,
   * in `child` or (in flight across a stop) `settling`.
   */
  private admissibleReplyKind(): ControlReplyKind | undefined {
    const op = this.controlOp;
    if (!this.controlMode || op === null || this.childPid === null) return undefined;
    return this.currentPhase === "child" || this.currentPhase === "settling" ? op.replyKind : undefined;
  }

  /**
   * Opt-in hook control: one complete reply. It must answer the one
   * unanswered command exactly (kind and echoed number) and must not
   * contradict what the transport already knows; anything else poisons. Its
   * authority effects always apply, even when the caller stopped waiting
   * (the reply then drains): it is never retargeted to another command.
   */
  private onControlReply(reply: ControlReply): boolean {
    const op = this.controlOp;
    if (this.admissibleReplyKind() !== reply.kind || op === null) {
      this.poisonWith("frame-unsolicited");
      return false;
    }
    if (this.exitFacts !== null && !EXIT_TOLERANT.has(this.currentPhase)) {
      this.poisonWith("process-exited");
      return false;
    }
    if (reply.sequence !== op.echo) {
      this.poisonWith("control-reply");
      return false;
    }
    if (performance.now() >= op.expiresAt) {
      this.poisonWith("timeout");
      return false;
    }
    if (reply.kind === "bind") {
      // The supervisor binds only its latest announced candidate and answers
      // DEAD only after an unsettled write this transport already saw.
      if (reply.outcome === "DEAD" || (reply.outcome === "OK" && (op.sequence !== this.candidateSeq || this.laneDead))) {
        this.poisonWith("control-reply");
        return false;
      }
      const latest = this.latestCandidate;
      if (
        reply.outcome === "OK" && op.finish !== null && !this.settleRequested && this.currentPhase === "child"
        && latest !== null && latest.sequence === op.sequence && latest.sessionId === op.sessionId
      ) {
        this.bound = Object.freeze({ sequence: op.sequence, sessionId: op.sessionId! });
      }
    } else if (reply.kind === "sent") {
      // A delivery outcome other than STALE means the supervisor still held
      // this binding: no newer candidate can have been announced before it.
      if (reply.outcome !== "STALE" && op.sequence !== this.candidateSeq) {
        this.poisonWith("control-reply");
        return false;
      }
      if (reply.outcome === "UNSETTLED") {
        this.laneDead = true;
        this.bound = null;
        this.latestCandidate = null;
      } else if ((reply.outcome === "UNKNOWN" || reply.outcome === "STALE") && this.bound?.sequence === op.sequence) {
        this.bound = null;
      }
      if (this.sendInFlight === op.echo) this.sendInFlight = null;
    }
    clearTimeout(op.timer);
    this.controlOp = null;
    this.controlReplies += 1;
    // Provisional: the caller learns the reply only once the WHOLE chunk,
    // residual included, is accepted (see onStdout); a same-chunk fault
    // turns it into the poison ending instead.
    if (op.finish === null) this.controlDrained += 1;
    else this.completed = { finish: op.finish, reply };
    return true;
  }

  /**
   * Opt-in hook control: write one command and track it as THE unanswered
   * command. Undefined when the write fence refuses (nothing was written).
   * The reply deadline poisons; a caller abort only stops the caller's wait.
   */
  private issueControl(
    replyKind: ControlReplyKind,
    echo: number,
    sequence: number,
    sessionId: string | null,
    bytes: Buffer,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onWritten?: () => void,
  ): Promise<ControlEnd> | undefined {
    let resolveEnd: (end: ControlEnd) => void = () => undefined;
    const ended = new Promise<ControlEnd>((resolve) => {
      resolveEnd = resolve;
    });
    let release: Disposable | undefined;
    const op: ControlOp = { replyKind, echo, sequence, sessionId, finish: null, timer: undefined, expiresAt: Number.POSITIVE_INFINITY };
    this.controlOp = op;
    if (!this.write(bytes, onWritten)) {
      this.controlOp = null;
      return undefined;
    }
    op.finish = (end) => {
      op.finish = null;
      release?.[Symbol.dispose]();
      release = undefined;
      resolveEnd(end);
    };
    // The timer covers silence; the stored expiry decides a reply that is
    // processed after the deadline but before the timer callback runs.
    op.expiresAt = performance.now() + timeoutMs;
    op.timer = setTimeout(() => this.poisonWith("timeout"), timeoutMs);
    if (signal !== undefined) release = addAbortListener(signal, () => op.finish?.({ type: "cancelled" }));
    return ended;
  }

  /** Opt-in hook control: synchronous state every command needs (no caller code). */
  private controlStateRefusal(): NativeWindowsClaudeCustodyControlRefusal | undefined {
    if (this.poison !== null || this.currentPhase !== "child" || this.settleRequested || this.exitFacts !== null || this.childPid === null) {
      return "custody-not-current";
    }
    if (this.controlOp !== null || this.partial.length > 0) return "control-busy";
    return undefined;
  }

  private applyRecord(
    parsed:
      | { readonly kind: "ready" | "wrapper" | "go" | "child"; readonly pid: number }
      | { readonly kind: "settled"; readonly active: number; readonly listed: number }
      | { readonly kind: "bye" },
  ): NativeWindowsClaudeCustodyPoisonCode | undefined {
    switch (parsed.kind) {
      case "ready":
        if (parsed.pid !== this.child.pid) return "pid-mismatch";
        this.supervisorPid = parsed.pid;
        this.currentPhase = "ready";
        break;
      case "wrapper":
        if (parsed.pid === this.supervisorPid) return "peer-mismatch";
        this.wrapperPid = parsed.pid;
        this.currentPhase = "wrapper-reported";
        break;
      case "go":
        if (parsed.pid !== this.wrapperPid) return "pid-mismatch";
        this.goPid = parsed.pid;
        this.currentPhase = "go";
        break;
      case "child":
        if (parsed.pid === this.supervisorPid || parsed.pid === this.wrapperPid) return "pid-mismatch";
        this.childPid = parsed.pid;
        this.currentPhase = "child";
        break;
      case "settled":
        if (parsed.active !== 0 || parsed.listed !== 0) return "job-not-empty";
        this.settledRecord = true;
        this.currentPhase = "settled-record";
        break;
      case "bye":
        this.bye = true;
        this.currentPhase = "bye";
        // Our side is done; ending stdin lets the supervisor exit cleanly.
        this.endStdin();
        break;
    }
    return undefined;
  }

  private classify(line: string):
    | { readonly kind: "ready" | "wrapper" | "go" | "child"; readonly pid: number }
    | { readonly kind: "settled"; readonly active: number; readonly listed: number }
    | { readonly kind: "bye" }
    | { readonly kind: "cand"; readonly sequence: number; readonly sessionId: string }
    | ControlReply
    | undefined {
    if (this.controlMode) {
      const control = classifyControlReply(line);
      if (control !== null) return control;
    }
    if (this.hookMode && line.startsWith("SUP_CAND ")) {
      const match = CAND_LINE.exec(line);
      if (!match) return undefined;
      const sequence = Number(match[1]);
      return Number.isSafeInteger(sequence) && sequence > 0 ? { kind: "cand", sequence, sessionId: match[2]! } : undefined;
    }
    const pidRecord = (kind: "ready" | "wrapper" | "go" | "child", pattern: RegExp) => {
      const match = pattern.exec(line);
      if (!match) return undefined;
      const pid = parsePid(match[1]!);
      return pid === undefined ? undefined : { kind, pid };
    };
    if (line.startsWith("SUP_READY ")) return pidRecord("ready", READY_LINE);
    if (line.startsWith("SUP_WRAPPER ")) return pidRecord("wrapper", WRAPPER_LINE);
    if (line.startsWith("SUP_GO ")) return pidRecord("go", GO_LINE);
    if (line.startsWith("SUP_CHILD ")) return pidRecord("child", CHILD_LINE);
    const settled = SETTLED_LINE.exec(line);
    if (settled) {
      const active = Number(settled[1]);
      const listed = Number(settled[2]);
      if (!Number.isSafeInteger(active) || !Number.isSafeInteger(listed)) return undefined;
      return { kind: "settled", active, listed };
    }
    if (BYE_LINE.test(line)) return { kind: "bye" };
    return undefined;
  }

  private onStdoutEnd(): void {
    this.stdoutEnded = true;
    if (this.poison !== null || this.currentPhase === "settled") return;
    if (this.partial.length > 0) return this.poisonWith("stdout-truncated");
    if (this.currentPhase !== "bye") return this.poisonWith("stdout-closed");
    this.notify();
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitFacts = { code, signal };
    if (this.poison !== null || this.currentPhase === "settled") return;
    if (!EXIT_TOLERANT.has(this.currentPhase)) return this.poisonWith("process-exited");
    if (code !== 0 || signal !== null) return this.poisonWith("exit-abnormal");
    this.notify();
  }

  private onClose(): void {
    this.processClosed = true;
    if (this.exitFacts === null) this.exitFacts = { code: this.child.exitCode, signal: this.child.signalCode };
    if (this.poison === null && this.currentPhase !== "settled") {
      if (this.partial.length > 0) this.poisonWith("stdout-truncated");
      else if (this.currentPhase !== "bye" || !this.stdoutEnded) this.poisonWith(EXIT_TOLERANT.has(this.currentPhase) ? "stdout-closed" : "process-exited");
      else if (this.exitFacts.code !== 0 || this.exitFacts.signal !== null) this.poisonWith("exit-abnormal");
      else this.notify();
    }
    // The abort hook is NOT released here: a clean close only resolves the
    // settlement wait, and a transport-wide abort before settle() commits
    // must still poison. poisonWith() and the settled transition release it.
    const closeWaiters = [...this.closeWaiters];
    this.closeWaiters.clear();
    for (const waiter of closeWaiters) waiter();
    this.notify();
  }

  /* ------------------------------------------------------------ outbound */

  /** Synchronous write fence: the only path bytes take to the supervisor. */
  private write(bytes: Buffer, onWritten?: () => void): boolean {
    const stdin = this.child.stdin;
    if (
      this.poison !== null || this.exitFacts !== null || stdin === null
      || stdin.destroyed || stdin.writableEnded || !stdin.writable
      // Output already pending before this command can never answer it.
      || this.partial.length > 0
    ) {
      return false;
    }
    stdin.write(bytes, (error) => {
      onWritten?.();
      if (error) this.poisonWith("stdin-error");
    });
    return true;
  }

  private endStdin(): void {
    const stdin = this.child.stdin;
    if (stdin !== null && !stdin.destroyed && !stdin.writableEnded) {
      try {
        stdin.end();
      } catch {
        /* the stdin error listener poisons when relevant */
      }
    }
  }

  /* -------------------------------------------------------------- poison */

  private poisonWith(code: NativeWindowsClaudeCustodyPoisonCode): void {
    if (this.poison !== null || this.currentPhase === "settled") return;
    this.poison = code;
    this.currentPhase = "poisoned";
    this.sendInFlight = null;
    this.latestCandidate = null;
    this.bound = null;
    const op = this.controlOp;
    this.controlOp = null;
    if (op !== null) {
      clearTimeout(op.timer);
      op.finish?.({ type: "poison", code });
    }
    // A reply from a chunk that then failed validation is never credited.
    const completed = this.completed;
    this.completed = null;
    completed?.finish({ type: "poison", code });
    const stdin = this.child.stdin;
    if (stdin !== null && !stdin.destroyed) stdin.destroy();
    // Keep draining (and discarding) so the process can exit and close.
    this.child.stdout?.resume();
    this.child.stderr?.resume();
    if (!this.killed && this.child.exitCode === null && this.child.signalCode === null) {
      this.killed = true;
      try {
        this.child.kill();
      } catch {
        /* exit/close still report the outcome */
      }
    }
    this.releaseListeners();
    for (const waiter of [...this.waiters]) waiter.fail(code);
    this.waiters.clear();
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      const value = waiter.check();
      if (value !== undefined) {
        this.waiters.delete(waiter);
        waiter.resolve(value);
      }
    }
  }

  /**
   * Wait until `check` yields a value. A deadline poisons the transport;
   * poison rejects with its code. `deadlineCode` names a deadline miss (e.g.
   * `peer-missing` while awaiting the wrapper record). Step cancellation is
   * armed by {@link step} for the whole step, not per wait.
   *
   * Resolution is provisional: the rest of a stdout chunk (or a later
   * listener) may poison before the continuation runs, so every caller must
   * pass through {@link fence} after awaiting.
   */
  private until<T>(
    check: () => T | undefined,
    timeoutMs: number,
    deadlineCode: NativeWindowsClaudeCustodyPoisonCode = "timeout",
  ): Promise<T> {
    if (this.poison !== null) return Promise.reject(new PoisonedError(this.poison));
    const immediate = check();
    if (immediate !== undefined) return Promise.resolve(immediate);
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      const waiter: Waiter = {
        check,
        resolve: (value) => {
          finish();
          resolve(value as T);
        },
        fail: (code) => {
          finish();
          reject(new PoisonedError(code));
        },
      };
      this.waiters.add(waiter);
      timer = setTimeout(() => this.poisonWith(deadlineCode), timeoutMs);
    });
  }

  /** Synchronous post-wait fence: a poison (including a step abort) since the wait resolved wins. */
  private fence(signal: AbortSignal | undefined): void {
    if (signal?.aborted || this.attachSignal?.aborted) this.poisonWith("cancelled");
    if (this.poison !== null) throw new PoisonedError(this.poison);
  }

  private poisoned(code: NativeWindowsClaudeCustodyPoisonCode): NativeWindowsClaudeCustodyFailure {
    return { status: "failed", code, poisoned: true };
  }

  private misuse(code: NativeWindowsClaudeCustodyMisuseCode): NativeWindowsClaudeCustodyFailure {
    return { status: "failed", code, poisoned: false };
  }

  /** Run one step with the one-in-flight guard and poison mapping. */
  private async step<T>(
    allowed: readonly NativeWindowsClaudeCustodyPhase[],
    options: NativeWindowsClaudeCustodyStepOptions | undefined,
    body: (signal: AbortSignal | undefined) => Promise<T | NativeWindowsClaudeCustodyFailure>,
  ): Promise<T | NativeWindowsClaudeCustodyFailure> {
    if (this.poison !== null) return this.poisoned(this.poison);
    if (this.busy) return this.misuse("busy");
    if (!allowed.includes(this.currentPhase)) return this.misuse("out-of-order");
    const signal = options?.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return this.misuse("out-of-order");
    if (signal?.aborted) {
      this.poisonWith("cancelled");
      return this.poisoned("cancelled");
    }
    this.busy = true;
    // Cancellation stays armed for the WHOLE step, including the gaps between
    // a resolved wait and its continuation.
    const subscription = signal === undefined ? undefined : addAbortListener(signal, () => this.poisonWith("cancelled"));
    try {
      const result = await body(signal);
      // A success is only reported if nothing poisoned meanwhile. (A witnessed
      // settlement has already made the transport terminal, so poison cannot
      // land after it.)
      if (this.poison !== null) return this.poisoned(this.poison);
      return result;
    } catch (error) {
      if (error instanceof PoisonedError) return this.poisoned(error.code);
      // Any unexpected fault is fail-closed; its content is never surfaced.
      this.poisonWith("process-error");
      return this.poisoned(this.poison ?? "process-error");
    } finally {
      subscription?.[Symbol.dispose]();
      this.busy = false;
    }
  }

  /* ------------------------------------------------------------- methods */

  async start(source: string, options?: NativeWindowsClaudeCustodyStartOptions): Promise<NativeWindowsClaudeCustodyStartResult> {
    return this.step(["attached"], options, async (signal) => {
      // Validated before any byte is written; a refusal changes nothing.
      const boot = encodeBootSource(source);
      if (boot === undefined) return this.misuse("source-invalid");
      let bytes = boot;
      if (this.hookMode) {
        // Opt-in: exactly one key frame, in the SAME write right after the
        // boot frame, naming this transport's pinned run.
        const keyFrame = encodeKeyFrame(options?.hookKey, this.run.runId);
        if (keyFrame === undefined) return this.misuse("hook-key-invalid");
        bytes = Buffer.concat([boot, keyFrame]);
        keyFrame.fill(0);
      } else if (options?.hookKey !== undefined) {
        return this.misuse("hook-key-invalid");
      }
      this.currentPhase = "booting";
      // The only copy holding the key is zero-filled once the write completes
      // (or is refused here without being written).
      const scrub = this.hookMode ? () => bytes.fill(0) : undefined;
      if (!this.write(bytes, scrub)) {
        scrub?.();
        throw new PoisonedError(this.failWrite());
      }
      const pid = await this.until(() => this.supervisorPid ?? undefined, this.deadlines.readyMs);
      this.fence(signal);
      return { status: "ready-for-pty-spawn", supervisorPid: pid } as const;
    });
  }

  async confirmPeer(
    readPtyPid: () => unknown,
    options?: NativeWindowsClaudeCustodyStepOptions,
  ): Promise<NativeWindowsClaudeCustodyConfirmResult> {
    return this.step(["ready", "wrapper-reported"], options, async (signal) => {
      if (typeof readPtyPid !== "function") return this.misuse("out-of-order");
      const wrapperPid = await this.until(() => this.wrapperPid ?? undefined, this.deadlines.peerMs, "peer-missing");
      this.fence(signal);
      // Write fence: read node-pty's CURRENT pid and write CONFIRM with no await between.
      let ptyPid: unknown;
      try {
        ptyPid = readPtyPid();
      } catch {
        ptyPid = undefined;
      }
      // The read ran caller code: re-check cancellation and poison at the fence.
      this.fence(signal);
      if (!isPositivePid(ptyPid)) throw new PoisonedError(this.poisonNow("pty-pid-unavailable"));
      if (ptyPid !== wrapperPid || this.currentPhase !== "wrapper-reported") throw new PoisonedError(this.poisonNow("peer-mismatch"));
      this.currentPhase = "confirming";
      if (!this.write(Buffer.from(`CONFIRM ${wrapperPid}\n`, "ascii"))) throw new PoisonedError(this.failWrite());
      await this.until(() => this.goPid ?? undefined, this.deadlines.peerMs);
      this.fence(signal);
      return { status: "peer-confirmed", wrapperPid } as const;
    });
  }

  async awaitChild(options?: NativeWindowsClaudeCustodyStepOptions): Promise<NativeWindowsClaudeCustodyChildResult> {
    return this.step(["go", "child"], options, async (signal) => {
      const childPid = await this.until(() => this.childPid ?? undefined, this.deadlines.childMs);
      this.fence(signal);
      return { status: "child-established", childPid } as const;
    });
  }

  async settle(options?: NativeWindowsClaudeCustodyStepOptions): Promise<NativeWindowsClaudeCustodySettleResult> {
    return this.step(["ready", "wrapper-reported", "go", "child"], options, async (signal) => {
      const started = performance.now();
      let settleMs = this.deadlines.settleMs;
      // From here on no candidate is credited, none is held, and no local
      // write authority exists; an unanswered command still drains its reply.
      this.settleRequested = true;
      this.latestCandidate = null;
      this.bound = null;
      if (this.hookMode && this.currentPhase === "child" && this.partial.length > 0) {
        // Opt-in: a genuine final candidate fragment (the only admissible
        // residual in `child`) completes first, inside this stop's deadline,
        // so the unchanged write fence never meets it.
        await this.until(() => (this.partial.length === 0 ? true : undefined), this.deadlines.settleMs);
        this.fence(signal);
        if (this.currentPhase !== "child" || this.partial.length > 0) throw new PoisonedError(this.poisonNow("process-error"));
        // The rest of the stop shares the same deadline.
        settleMs = Math.max(1, Math.floor(this.deadlines.settleMs - (performance.now() - started)));
      }
      this.currentPhase = "settling";
      this.sendInFlight = null;
      if (!this.write(Buffer.from("SETTLE\n", "ascii"))) throw new PoisonedError(this.failWrite());
      await this.until(() => (this.isWitnessed() ? true : undefined), settleMs);
      this.fence(signal);
      // Revalidate the COMPLETE witness synchronously right before the
      // terminal transition; anything since the wait resolved could void it.
      if (!this.isWitnessed()) throw new PoisonedError(this.poisonNow("process-error"));
      this.currentPhase = "settled";
      this.releaseListeners();
      return {
        status: "settled",
        witness: { supervisorPid: this.supervisorPid!, jobActive: 0, jobListed: 0, exitCode: 0 },
      } as const;
    });
  }

  private isWitnessed(): boolean {
    return this.poison === null
      && this.currentPhase === "bye"
      && this.settledRecord
      && this.bye
      && this.stdoutEnded
      && this.partial.length === 0
      && this.processClosed
      && this.exitFacts !== null
      && this.exitFacts.code === 0
      && this.exitFacts.signal === null
      && this.supervisorPid !== null;
  }

  prepareSend(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodySendPrepare {
    // Checked before the host predicate runs, so a reentrant prepare from that
    // predicate (or from a committing attempt's predicate) is refused.
    if (this.sendInFlight !== null) return { status: "refused", code: "attempt-in-flight" };
    const refusal = this.sendRefusal(context);
    if (refusal !== undefined) return { status: "refused", code: refusal };
    if (this.sendInFlight !== null) return { status: "refused", code: "attempt-in-flight" };
    this.sendAttemptSeq += 1;
    const attemptId = this.sendAttemptSeq;
    this.sendInFlight = attemptId;
    let spent = false;
    const attempt: NativeWindowsClaudeCustodySendAttempt = Object.freeze({
      attemptId,
      commit: (
        payload: NativeWindowsClaudeCustodySendPayloadSource,
        fence?: NativeWindowsClaudeCustodySendFence,
      ): NativeWindowsClaudeCustodySendCommit => {
        if (spent) return { status: "not-sent", code: "attempt-spent" } as const;
        spent = true;
        // The slot stays held through every commit-time check (the host
        // predicate is caller code and may reenter prepareSend) and is
        // released only if this attempt still owns it — unless a dispatched
        // SEND now holds it until its exact reply (or poison) ends it.
        let dispatched = false;
        try {
          // A malformed payload source spends the attempt without invoking anything.
          if (typeof payload !== "function") return { status: "not-sent", code: "attempt-spent" } as const;
          if (this.sendInFlight !== attemptId) return { status: "not-sent", code: "custody-not-current" } as const;
          const late = this.sendRefusal(context);
          if (late !== undefined) return { status: "not-sent", code: late } as const;
          if (this.sendInFlight !== attemptId) return { status: "not-sent", code: "custody-not-current" } as const;
          // Without opt-in hook control no wire send lane exists, so the
          // payload source is deliberately never invoked.
          if (!this.controlMode) return { status: "not-sent", code: "lane-unavailable" } as const;
          const result = this.dispatchSend(attemptId, context, payload, fence);
          dispatched = result.status === "dispatched";
          return result;
        } finally {
          if (!dispatched && this.sendInFlight === attemptId) this.sendInFlight = null;
        }
      },
      abandon: (): void => {
        if (spent) return;
        spent = true;
        if (this.sendInFlight === attemptId) this.sendInFlight = null;
      },
    });
    return { status: "prepared", attempt };
  }

  /**
   * Opt-in hook control: the send lane behind a commit whose run and custody
   * checks already passed. Order: exact local binding and an idle lane; the
   * caller's fence; the payload, produced once and framed; then the run and
   * the caller's fence AGAIN and a synchronous re-read of every internal
   * fact, with no await before the one write. Any refusal is `not-sent` with
   * no byte written.
   */
  private dispatchSend(
    attemptId: number,
    context: NativeWindowsClaudeCustodyRun,
    payload: NativeWindowsClaudeCustodySendPayloadSource,
    fence: NativeWindowsClaudeCustodySendFence | undefined,
  ): NativeWindowsClaudeCustodySendCommit {
    const notSent = (code: NativeWindowsClaudeCustodySendRefusal) => ({ status: "not-sent", code } as const);
    const wanted = validFence(fence) ? copyBinding(fence.binding) : undefined;
    if (fence === undefined || wanted === undefined) return notSent("binding-not-current");
    const bound = this.bound;
    const refusal = (): NativeWindowsClaudeCustodySendRefusal | undefined => {
      if (this.sendInFlight !== attemptId) return "custody-not-current";
      const state = this.controlStateRefusal();
      if (state !== undefined) return state === "control-busy" ? "control-busy" : "custody-not-current";
      if (
        this.laneDead || bound === null || this.bound !== bound
        || bound.sequence !== wanted.sequence || bound.sessionId !== wanted.sessionId || bound.sequence !== this.candidateSeq
      ) {
        return "binding-not-current";
      }
      return undefined;
    };
    /**
     * One fence boundary: the caller's binding read (caller code), then — because
     * that code may have changed anything — the exact current run (caller code
     * too), then every internal fact and the abort, all synchronously.
     */
    const boundary = (): NativeWindowsClaudeCustodySendRefusal | undefined => {
      if (fence.signal?.aborted) return "cancelled";
      if (!readFence(fence)) return "binding-not-current";
      const run = this.sendRefusal(context);
      if (run !== undefined) return run;
      const state = refusal();
      if (state !== undefined) return state;
      return fence.signal?.aborted ? "cancelled" : undefined;
    };
    const early = refusal();
    if (early !== undefined) return notSent(early);
    // Before producing anything.
    const beforePayload = boundary();
    if (beforePayload !== undefined) return notSent(beforePayload);
    let frame: Buffer | undefined;
    try {
      frame = encodeSendFrame(attemptId, bound!.sequence, payload());
    } catch {
      frame = undefined;
    }
    if (frame === undefined) return notSent("payload-invalid");
    const bytes = frame;
    let handed = false;
    try {
      // Immediately before committing (the payload ran caller code): the
      // exact current run first, then the same boundary again; no await
      // between it and the one write.
      const late = this.sendRefusal(context);
      if (late !== undefined) return notSent(late);
      const final = boundary();
      if (final !== undefined) return notSent(final);
      const ended = this.issueControl(
        "sent", attemptId, bound!.sequence, null, bytes, fence.signal, this.controlDeadlines.sendMs, () => bytes.fill(0),
      );
      if (ended === undefined) return notSent("custody-not-current");
      handed = true;
      return { status: "dispatched", attemptId, outcome: ended.then((end) => sendOutcome(attemptId, end)) } as const;
    } finally {
      if (!handed) bytes.fill(0);
    }
  }

  async bindHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    binding: NativeWindowsClaudeCustodyHookCandidate,
    fence: NativeWindowsClaudeCustodyHookBindingFence,
  ): Promise<NativeWindowsClaudeCustodyBindResult> {
    const refused = (code: NativeWindowsClaudeCustodyControlRefusal) => ({ status: "refused", code } as const);
    if (!this.controlMode) return refused("control-disabled");
    if (!validFence(fence)) return refused("options-invalid");
    const target = copyBinding(binding);
    if (target === undefined) return refused("binding-not-current");
    const refusal = (): NativeWindowsClaudeCustodyControlRefusal | undefined => {
      const state = this.controlStateRefusal();
      if (state !== undefined) return state;
      if (this.laneDead) return "lane-poisoned";
      const latest = this.latestCandidate;
      if (latest === null || latest.sequence !== target.sequence || latest.sessionId !== target.sessionId || target.sequence !== this.candidateSeq) {
        return "binding-not-current";
      }
      if (this.bound !== null && this.bound.sequence === target.sequence) return "already-bound";
      if (target.sequence <= this.lastBindSeq) return "binding-not-current";
      return undefined;
    };
    const run = this.sendRefusal(context);
    if (run !== undefined) return refused(run);
    const early = refusal();
    if (early !== undefined) return refused(early);
    if (fence.signal?.aborted) return refused("cancelled");
    if (!readFence(fence)) return refused("binding-not-current");
    // Caller code ran: re-read the exact current run, then every internal
    // fact synchronously; no await before the write.
    const lateRun = this.sendRefusal(context);
    if (lateRun !== undefined) return refused(lateRun);
    const late = refusal();
    if (late !== undefined) return refused(late);
    if (fence.signal?.aborted) return refused("cancelled");
    const ended = this.issueControl(
      "bind", target.sequence, target.sequence, target.sessionId,
      Buffer.from(`BIND ${target.sequence}\n`, "ascii"), fence.signal, this.controlDeadlines.controlMs,
    );
    if (ended === undefined) return refused("custody-not-current");
    this.lastBindSeq = target.sequence;
    const end = await ended;
    if (end.type === "poison") return this.poisoned(end.code);
    if (end.type === "cancelled") return { status: "unknown", code: "cancelled" } as const;
    if (end.reply.kind !== "bind" || end.reply.outcome !== "OK") return { status: "not-bound", code: "stale" } as const;
    // Re-read after the await: a later record in the same chunk may have poisoned or superseded it.
    if (this.poison !== null) return this.poisoned(this.poison);
    const now = this.bound;
    if (now === null || now.sequence !== target.sequence || now.sessionId !== target.sessionId) {
      return { status: "not-bound", code: "stopping" } as const;
    }
    return { status: "bound", binding: now } as const;
  }

  async dropHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    sequence: number,
    options?: NativeWindowsClaudeCustodyStepOptions,
  ): Promise<NativeWindowsClaudeCustodyDropResult> {
    const refused = (code: NativeWindowsClaudeCustodyControlRefusal) => ({ status: "refused", code } as const);
    if (!this.controlMode) return refused("control-disabled");
    // A DROP for another run (or generation) never touches this run's slots.
    if (!validRun(context) || context.runId !== this.run.runId || context.generation !== this.run.generation) {
      return refused("run-not-current");
    }
    if (!isSequence(sequence) || sequence > this.candidateSeq) return refused("binding-not-current");
    // For this exact run, revocation is local and immediate, on every path below.
    if (this.bound?.sequence === sequence) this.bound = null;
    if (this.latestCandidate?.sequence === sequence) this.latestCandidate = null;
    if (options !== undefined && (typeof options !== "object" || options === null)) return refused("options-invalid");
    const signal = options?.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return refused("options-invalid");
    const run = this.sendRefusal(context);
    if (run !== undefined) return refused(run);
    if (signal?.aborted) return refused("cancelled");
    const state = this.controlStateRefusal();
    if (state !== undefined) return refused(state);
    // Local revocation above already happened; the wire names a sequence once per verb.
    if (sequence <= this.lastDropSeq) return refused("binding-not-current");
    const ended = this.issueControl(
      "drop", sequence, sequence, null, Buffer.from(`DROP ${sequence}\n`, "ascii"), signal, this.controlDeadlines.controlMs,
    );
    if (ended === undefined) return refused("custody-not-current");
    this.lastDropSeq = sequence;
    const end = await ended;
    if (end.type === "poison") return this.poisoned(end.code);
    if (end.type === "cancelled") return { status: "unknown", code: "cancelled" } as const;
    return { status: "dropped", sequence } as const;
  }

  observeHookBinding(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyHookBindingObservation {
    if (!this.controlMode) return { status: "refused", code: "control-disabled" };
    const refusal = this.sendRefusal(context);
    if (refusal !== undefined) return { status: "refused", code: refusal };
    if (this.settleRequested || this.poison !== null || this.currentPhase !== "child") {
      return { status: "refused", code: "custody-not-current" };
    }
    const bound = this.bound;
    return bound === null ? { status: "none" } : { status: "bound", binding: bound };
  }

  observeHookCandidate(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyHookCandidateObservation {
    if (!this.hookMode) return { status: "refused", code: "hook-disabled" };
    const refusal = this.sendRefusal(context);
    if (refusal !== undefined) return { status: "refused", code: refusal };
    // The host predicate is caller code: re-read state after it ran.
    if (this.settleRequested || this.poison !== null || this.currentPhase !== "child") {
      return { status: "refused", code: "custody-not-current" };
    }
    const candidate = this.latestCandidate;
    return candidate === null ? { status: "none" } : { status: "candidate", candidate };
  }

  private sendRefusal(context: NativeWindowsClaudeCustodyRun): "run-not-current" | "custody-not-current" | undefined {
    if (
      !validRun(context)
      || context.runId !== this.run.runId
      || context.generation !== this.run.generation
    ) {
      return "run-not-current";
    }
    let current = false;
    try {
      current = this.isRunCurrent() === true;
    } catch {
      current = false;
    }
    if (!current) return "run-not-current";
    if (this.poison !== null || this.currentPhase !== "child" || this.exitFacts !== null || this.childPid === null) {
      return "custody-not-current";
    }
    return undefined;
  }

  async drain(options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<NativeWindowsClaudeCustodyDrainResult> {
    if (this.currentPhase !== "settled") this.poisonWith("disposed");
    if (this.processClosed) return { status: "closed" };
    const timeoutMs = options?.timeoutMs ?? this.deadlines.settleMs;
    const signal = options?.signal;
    if (signal?.aborted) return { status: "not-closed", code: "cancelled" };
    // One removable registration: close, timeout, and cancellation each release it.
    return new Promise<NativeWindowsClaudeCustodyDrainResult>((resolve) => {
      let subscription: Disposable | undefined;
      const finish = (outcome: NativeWindowsClaudeCustodyDrainResult): void => {
        clearTimeout(timer);
        subscription?.[Symbol.dispose]();
        this.closeWaiters.delete(onClose);
        resolve(outcome);
      };
      const onClose = (): void => finish({ status: "closed" });
      const onAbort = (): void => finish({ status: "not-closed", code: "cancelled" });
      const timer = setTimeout(
        () => finish({ status: "not-closed", code: "timeout" }),
        Math.max(1, Math.min(timeoutMs, NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS)),
      );
      this.closeWaiters.add(onClose);
      if (signal !== undefined) subscription = addAbortListener(signal, onAbort);
    });
  }

  dispose(): void {
    this.poisonWith("disposed");
  }

  diagnostics(): NativeWindowsClaudeCustodyDiagnostics {
    return Object.freeze({
      phase: this.currentPhase,
      poisonCode: this.poison,
      recordsAccepted: this.recordsAccepted,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      processExited: this.exitFacts !== null,
      processClosed: this.processClosed,
      pendingDrains: this.closeWaiters.size,
      hookCandidatesCredited: this.candidatesCredited,
      hookCandidatesUncredited: this.candidatesUncredited,
      hookControlReplies: this.controlReplies,
      hookControlDrained: this.controlDrained,
      hookControlBound: this.bound !== null,
    });
  }

  /* ------------------------------------------------------------- helpers */

  private poisonNow(code: NativeWindowsClaudeCustodyPoisonCode): NativeWindowsClaudeCustodyPoisonCode {
    this.poisonWith(code);
    return this.poison ?? code;
  }

  /** A refused write fence: the process exited or stdin is gone. */
  private failWrite(): NativeWindowsClaudeCustodyPoisonCode {
    if (this.poison !== null) return this.poison;
    if (this.partial.length > 0) return this.poisonNow("frame-unsolicited");
    return this.poisonNow(this.exitFacts !== null ? "process-exited" : "stdin-error");
  }

  /** On terminal success or terminal poison: drop the external abort hook. */
  private releaseListeners(): void {
    const cleanup = this.abortCleanup;
    this.abortCleanup = null;
    cleanup?.();
  }
}
