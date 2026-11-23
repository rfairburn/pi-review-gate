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
 * 2. Then single-line commands only: `CONFIRM <pid>\n` and `SETTLE\n`.
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
 * ## Send bridge (contract only in this slice)
 *
 * Future sends run against the exact run context with a per-attempt two-phase
 * prepare/commit, one attempt in flight. The per-attempt token/auth payload is
 * supplied as a thunk that is never invoked before every current check passes
 * at commit, so a stale attempt is rejected without materializing or sending
 * anything. No wire send exists yet: a commit that passes every check reports
 * `not-sent` / `lane-unavailable` and still never invokes the thunk.
 *
 * Privacy: every failure and diagnostic is a closed code or a count. Raw
 * stdout lines, stderr bytes, the boot source, and send payloads never appear
 * in results, diagnostics, or errors.
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
const MAX_PID = 0xffff_ffff;

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
}

export interface NativeWindowsClaudeCustodyStepOptions {
  /** Aborting the step poisons the whole transport (`cancelled`). */
  readonly signal?: AbortSignal;
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
  | "disposed";

/** Caller misuse refused without writing and without changing state. */
export type NativeWindowsClaudeCustodyMisuseCode = "busy" | "out-of-order" | "source-invalid";

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
}

/* ------------------------------------------------------------- send bridge */

export type NativeWindowsClaudeCustodySendRefusal =
  /** Another attempt is prepared and not yet committed or abandoned. */
  | "attempt-in-flight"
  /** The context is not the transport's exact run, or the host says it is no longer current. */
  | "run-not-current"
  /** The child is not (or no longer) established under live, unpoisoned custody. */
  | "custody-not-current"
  /** This attempt was already committed or abandoned. */
  | "attempt-spent"
  /** Every check passed, but no wire send lane exists in this slice. */
  | "lane-unavailable";

/**
 * Supplies the per-attempt token/auth payload. Invoked only after every
 * current check passes at commit — and, in this slice, never.
 */
export type NativeWindowsClaudeCustodySendPayloadSource = () => string;

export type NativeWindowsClaudeCustodySendCommit = {
  readonly status: "not-sent";
  readonly code: NativeWindowsClaudeCustodySendRefusal;
};

export interface NativeWindowsClaudeCustodySendAttempt {
  readonly attemptId: number;
  /** Re-proves every check synchronously, then hands off the payload — or rejects without sending. */
  commit(payload: NativeWindowsClaudeCustodySendPayloadSource): NativeWindowsClaudeCustodySendCommit;
  /** Releases the in-flight slot without materializing anything. Idempotent. */
  abandon(): void;
}

export type NativeWindowsClaudeCustodySendPrepare =
  | { readonly status: "prepared"; readonly attempt: NativeWindowsClaudeCustodySendAttempt }
  | { readonly status: "refused"; readonly code: Exclude<NativeWindowsClaudeCustodySendRefusal, "attempt-spent" | "lane-unavailable"> };

/* --------------------------------------------------------------- transport */

export interface NativeWindowsClaudeCustodyTransport {
  readonly phase: NativeWindowsClaudeCustodyPhase;
  readonly run: NativeWindowsClaudeCustodyRun;
  /**
   * Write the fixed-header bootstrap and wait for `SUP_READY` naming the owned
   * process's own PID. Success is the pre-spawn readiness signal.
   */
  start(source: string, options?: NativeWindowsClaudeCustodyStepOptions): Promise<NativeWindowsClaudeCustodyStartResult>;
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

function parsePid(text: string): number | undefined {
  const value = Number(text);
  return isPositivePid(value) ? value : undefined;
}

/* -------------------------------------------------------------- the driver */

type RecordKind = "ready" | "wrapper" | "go" | "child" | "settled" | "bye";

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
type RecordToken = string | "#pid" | "#count";
const RECORD_GRAMMAR: Readonly<Record<RecordKind, readonly RecordToken[]>> = {
  ready: ["SUP_READY ", "#pid"],
  wrapper: ["SUP_WRAPPER ", "#pid", " PROVISIONAL"],
  go: ["SUP_GO ", "#pid"],
  child: ["SUP_CHILD ", "#pid"],
  settled: ["SUP_SETTLED ACTIVE=", "#count", " LISTED=", "#count"],
  bye: ["SUP_BYE"],
};

/**
 * `complete`: `text` is exactly a valid record of this kind. `prefix`: some
 * continuation makes it one. `invalid`: no continuation can.
 */
function matchRecordGrammar(text: string, tokens: readonly RecordToken[]): "complete" | "prefix" | "invalid" {
  let i = 0;
  for (const token of tokens) {
    if (i === text.length) return "prefix";
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

/** Phases in which the owned process may exit without poisoning (the settlement tail). */
const EXIT_TOLERANT: ReadonlySet<NativeWindowsClaudeCustodyPhase> = new Set(["settling", "settled-record", "bye"]);

interface Waiter {
  /** Re-evaluated on every state change; a defined value resolves the waiter. */
  readonly check: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly fail: (code: NativeWindowsClaudeCustodyPoisonCode) => void;
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
  const { child, run, isRunCurrent, signal } = options;
  const deadlines = resolveDeadlines(options.deadlines);
  if (
    typeof child !== "object" || child === null || typeof child.on !== "function"
    || !validRun(run) || typeof isRunCurrent !== "function" || deadlines === undefined
    || (signal !== undefined && !(signal instanceof AbortSignal))
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
  const transport = new CustodyTransport(child, Object.freeze({ runId: run.runId, generation: run.generation }), isRunCurrent, deadlines);
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

  constructor(
    private readonly child: ChildProcess,
    readonly run: NativeWindowsClaudeCustodyRun,
    private readonly isRunCurrent: () => boolean,
    private readonly deadlines: NativeWindowsClaudeCustodyDeadlines,
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
    if (this.stdoutBytes > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDOUT_BYTES) {
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
      this.onLine(line);
      if (this.poison !== null) return;
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
    const expected = EXPECTED[this.currentPhase];
    if (expected === undefined) return "frame-unsolicited";
    const text = content.toString("ascii");
    // Must be a prefix of a syntactically valid record for THIS phase — not
    // merely share its header.
    if (fragmentViable(text, trailingCr, expected)) return undefined;
    for (const kind of Object.keys(RECORD_GRAMMAR) as RecordKind[]) {
      if (text.length > 0 && fragmentViable(text, trailingCr, kind)) {
        return this.seen.has(kind) ? "frame-duplicate" : "frame-unsolicited";
      }
    }
    return "frame-invalid";
  }

  private onLine(raw: Buffer): void {
    for (const byte of raw) {
      if (byte < 0x20 || byte > 0x7e) {
        this.poisonWith("frame-invalid");
        return;
      }
    }
    const line = raw.toString("ascii");
    const parsed = this.classify(line);
    if (parsed === undefined) {
      this.poisonWith("frame-invalid");
      return;
    }
    const expected = EXPECTED[this.currentPhase];
    if (expected !== parsed.kind) {
      this.poisonWith(this.seen.has(parsed.kind) ? "frame-duplicate" : "frame-unsolicited");
      return;
    }
    // A live record from a process already known to have exited is only
    // acceptable inside the settlement tail (buffered before the exit).
    if (this.exitFacts !== null && !EXIT_TOLERANT.has(this.currentPhase)) {
      this.poisonWith("process-exited");
      return;
    }
    this.seen.add(parsed.kind);
    switch (parsed.kind) {
      case "ready":
        if (parsed.pid !== this.child.pid) return this.poisonWith("pid-mismatch");
        this.supervisorPid = parsed.pid;
        this.currentPhase = "ready";
        break;
      case "wrapper":
        if (parsed.pid === this.supervisorPid) return this.poisonWith("peer-mismatch");
        this.wrapperPid = parsed.pid;
        this.currentPhase = "wrapper-reported";
        break;
      case "go":
        if (parsed.pid !== this.wrapperPid) return this.poisonWith("pid-mismatch");
        this.goPid = parsed.pid;
        this.currentPhase = "go";
        break;
      case "child":
        if (parsed.pid === this.supervisorPid || parsed.pid === this.wrapperPid) return this.poisonWith("pid-mismatch");
        this.childPid = parsed.pid;
        this.currentPhase = "child";
        break;
      case "settled":
        if (parsed.active !== 0 || parsed.listed !== 0) return this.poisonWith("job-not-empty");
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
    this.recordsAccepted += 1;
    // Waiters are notified by onStdout once the rest of the chunk is accepted.
  }

  private classify(line: string):
    | { readonly kind: "ready" | "wrapper" | "go" | "child"; readonly pid: number }
    | { readonly kind: "settled"; readonly active: number; readonly listed: number }
    | { readonly kind: "bye" }
    | undefined {
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
  private write(bytes: Buffer): boolean {
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

  async start(source: string, options?: NativeWindowsClaudeCustodyStepOptions): Promise<NativeWindowsClaudeCustodyStartResult> {
    return this.step(["attached"], options, async (signal) => {
      // Validated before any byte is written; a refusal changes nothing.
      const boot = encodeBootSource(source);
      if (boot === undefined) return this.misuse("source-invalid");
      this.currentPhase = "booting";
      if (!this.write(boot)) throw new PoisonedError(this.failWrite());
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
      this.currentPhase = "settling";
      this.sendInFlight = null;
      if (!this.write(Buffer.from("SETTLE\n", "ascii"))) throw new PoisonedError(this.failWrite());
      await this.until(() => (this.isWitnessed() ? true : undefined), this.deadlines.settleMs);
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
      commit: (payload: NativeWindowsClaudeCustodySendPayloadSource): NativeWindowsClaudeCustodySendCommit => {
        if (spent) return { status: "not-sent", code: "attempt-spent" } as const;
        spent = true;
        // The slot stays held through every commit-time check (the host
        // predicate is caller code and may reenter prepareSend) and is
        // released only if this attempt still owns it.
        try {
          // A malformed payload source spends the attempt without invoking anything.
          if (typeof payload !== "function") return { status: "not-sent", code: "attempt-spent" } as const;
          if (this.sendInFlight !== attemptId) return { status: "not-sent", code: "custody-not-current" } as const;
          const late = this.sendRefusal(context);
          if (late !== undefined) return { status: "not-sent", code: late } as const;
          if (this.sendInFlight !== attemptId) return { status: "not-sent", code: "custody-not-current" } as const;
          // Every check passed. No wire send lane exists in this slice, so the
          // payload source is deliberately never invoked.
          return { status: "not-sent", code: "lane-unavailable" } as const;
        } finally {
          if (this.sendInFlight === attemptId) this.sendInFlight = null;
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
