/**
 * #682 native Windows Claude hook forwarding client — INACTIVE.
 *
 * One hook invocation hands one caller-prepared outbound record to the
 * custody supervisor's launch-specific hook pipe, but only after the peer on
 * that SAME connection has proven knowledge of the per-run key. No product
 * path imports this module; launch/hook configuration, environment plumbing,
 * provider JSON parsing, stdout status, and the supervisor counterpart are
 * later slices.
 *
 * ## Wire sequence (fixed grammar, no dialects)
 *
 * 1. exactly one connection to the exact caller-validated pipe
 *    `\\.\pipe\prg682-hook-<32 lowercase hex>` (no retry, no fallback);
 * 2. the client writes `HELLO1 <nonce>\n`, where `<nonce>` is 16 fresh random
 *    bytes as 32 lowercase hex characters;
 * 3. the peer must answer with exactly `PROOF <64 lowercase hex>\n` and
 *    nothing else in that turn. The proof is HMAC-SHA256, keyed by the 64
 *    character lowercase hex key used AS ASCII TEXT (not hex-decoded), over
 *    the exact ASCII message `prg682-hook-v1|<runId>|<nonce>`, rendered as
 *    lowercase hex and compared with `timingSafeEqual`;
 * 4. only after a complete valid proof, and immediately after the caller's
 *    synchronous currency fence still returns `true`, the record function is
 *    called once, the fence is rechecked, and the returned bytes are written
 *    verbatim on the same connection.
 *
 * The proof line ends with LF or CRLF, nothing else; a bare CR, a missing
 * terminator (EOF/close), or any trailing byte in the same turn is a refusal.
 * A complete proof stays provisional until the current I/O turn ends, so a
 * trailing byte is refused whether it shares the proof's chunk or not.
 *
 * Every synchronous call-out (fence, record producer) is followed by a
 * recheck of settlement, cancellation, and a monotonic deadline, so a
 * call-out that cancels, overruns the deadline, or settles the invocation
 * re-entrantly can never lead to materialization or a write.
 *
 * ## Results
 *
 * Every invocation settles exactly once with a closed result:
 *
 * - `not-sent`: no record byte was ever passed to the connection (the record
 *   function may not even have been called);
 * - `handed-off`: the record write completed locally. This is NOT a claim that
 *   the supervisor read, accepted, or acted on it;
 * - `unknown`: the record write began but did not complete cleanly, so the
 *   bytes may or may not have left. Callers must not retry automatically.
 *
 * Results carry only closed codes: never the key, run id, nonce, proof,
 * record bytes, peer bytes, or raw error text.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect } from "node:net";

/* --------------------------------------------------------------- grammar */

/*
 * Each shared constant is declared once as a module-local binding and
 * exported under its public name, so runtime validation reads exactly the
 * bound callers see, never a reassignable property of CommonJS `exports`.
 */

/** The only accepted hook pipe prefix, case-exact; 32 lowercase hex characters follow. */
const PIPE_PREFIX = "\\\\.\\pipe\\prg682-hook-";

/** Domain-separation prefix of the proof message `prg682-hook-v1|<runId>|<nonce>`. */
const PROOF_CONTEXT = "prg682-hook-v1";

/**
 * Largest accepted outbound record, in bytes. Shared bound for the caller's
 * already capped record: it fits one root SessionStart record whose token is
 * at most 4096 characters, with room for the provider's envelope fields.
 */
const RECORD_MAX_BYTES = 16384;

/** One deadline for the whole invocation: connect, proof, and record write. */
const TIMEOUT_MS = 5000;

export {
  PIPE_PREFIX as WINDOWS_CLAUDE_HOOK_PIPE_PREFIX,
  PROOF_CONTEXT as WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT,
  RECORD_MAX_BYTES as WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES,
  TIMEOUT_MS as WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS,
};

/* ---------------------------------------------------------------- results */

/** Closed `not-sent` reasons: no record byte was passed to the connection. */
export const WINDOWS_CLAUDE_HOOK_NOT_SENT_REASONS = Object.freeze([
  "input-invalid",
  "stale",
  "cancelled",
  "connect-failed",
  "connection-lost",
  "proof-absent",
  "proof-malformed",
  "proof-mismatch",
  "timeout",
  "record-invalid",
] as const);

/** Closed `unknown` reasons: the record write began but did not complete cleanly. */
export const WINDOWS_CLAUDE_HOOK_UNKNOWN_REASONS = Object.freeze([
  "write-failed",
  "connection-lost",
  "timeout",
  "cancelled",
] as const);

export type WindowsClaudeHookNotSentReason = (typeof WINDOWS_CLAUDE_HOOK_NOT_SENT_REASONS)[number];
export type WindowsClaudeHookUnknownReason = (typeof WINDOWS_CLAUDE_HOOK_UNKNOWN_REASONS)[number];

export type WindowsClaudeHookForwardResult =
  | { readonly disposition: "not-sent"; readonly reason: WindowsClaudeHookNotSentReason }
  | { readonly disposition: "handed-off"; readonly reason: "write-completed" }
  | { readonly disposition: "unknown"; readonly reason: WindowsClaudeHookUnknownReason };

/* ------------------------------------------------------------------ input */

export interface WindowsClaudeHookForwardRequest {
  /** Exact hook pipe, `\\.\pipe\prg682-hook-<32 lowercase hex>`. */
  readonly pipe: string;
  /** The caller-validated opaque run id bound into the proof message. */
  readonly runId: string;
  /** Private 64-character lowercase hex key, used as ASCII text for HMAC. */
  readonly key: string;
  /** Synchronous currency fence; anything other than `true` (or a throw) is stale. */
  readonly isCurrent: () => boolean;
  /**
   * Lazily produces the caller's already validated, capped record bytes. It
   * is called at most once, and only after a complete valid proof.
   */
  readonly record: () => Uint8Array;
  /** Optional cancellation. */
  readonly signal?: AbortSignal;
}

/** The minimal socket surface used; `net.Socket` satisfies it. */
export interface WindowsClaudeHookSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  write(data: string | Uint8Array, callback: (error?: Error | null) => void): unknown;
  end(): unknown;
  destroy(): unknown;
}

/** Test seams only; product callers pass nothing. */
export interface WindowsClaudeHookForwardSeams {
  readonly connect?: (pipe: string) => WindowsClaudeHookSocket;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Monotonic clock in milliseconds. */
  readonly now?: () => number;
}

/*
 * Module-private constants. The checks use code-unit comparisons only (no
 * RegExp), checked to the true end of the string.
 */
const RUN_ID_MAX_CHARS = 128;
const KEY_CHARS = 64;
const PIPE_HEX_CHARS = 32;
const PROOF_PREFIX = "PROOF ";
const PROOF_HEX_CHARS = 64;
/** Offset of the terminator: LF there completes the frame; CR there must be followed by LF. */
const PROOF_TERMINATOR_AT = PROOF_PREFIX.length + PROOF_HEX_CHARS;

/*
 * Intrinsic %TypedArray%.prototype accessors, captured at load. They read the
 * internal slots, so a record cannot misreport its brand or length by
 * shadowing `byteLength`/`buffer`, and a non-typed-array receiver throws
 * (caught) instead of passing.
 */
const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const typedArraySet = (TYPED_ARRAY_PROTOTYPE as { set?: unknown }).set;

/**
 * Copy a genuine, non-empty, bounded Uint8Array into a fresh private Buffer,
 * using only internal slots; anything else is `undefined`.
 */
function copyRecord(value: unknown): Buffer | undefined {
  try {
    if (typedArrayTag === undefined || typedArrayByteLength === undefined || typeof typedArraySet !== "function") return undefined;
    if (typeof value !== "object" || value === null) return undefined;
    if (Reflect.apply(typedArrayTag, value, []) !== "Uint8Array") return undefined;
    const length: unknown = Reflect.apply(typedArrayByteLength, value, []);
    if (typeof length !== "number" || length < 1 || length > RECORD_MAX_BYTES) return undefined;
    const copy = Buffer.alloc(length);
    Reflect.apply(typedArraySet, copy, [value, 0]);
    return copy;
  } catch {
    return undefined;
  }
}

function isLowerHexCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
}

function isLowerHexText(value: string, from: number, count: number): boolean {
  if (value.length !== from + count) return false;
  for (let i = from; i < value.length; i += 1) if (!isLowerHexCode(value.charCodeAt(i))) return false;
  return true;
}

function isHookPipe(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length !== PIPE_PREFIX.length + PIPE_HEX_CHARS) return false;
  for (let i = 0; i < PIPE_PREFIX.length; i += 1) if (value.charCodeAt(i) !== PIPE_PREFIX.charCodeAt(i)) return false;
  return isLowerHexText(value, PIPE_PREFIX.length, PIPE_HEX_CHARS);
}

/** The existing custody run-id grammar: `[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 128 characters. */
function isRunId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > RUN_ID_MAX_CHARS) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const alnum = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (alnum) continue;
    if (i === 0) return false;
    if (code !== 0x2e && code !== 0x5f && code !== 0x3a && code !== 0x2d) return false;
  }
  return true;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && isLowerHexText(value, 0, KEY_CHARS);
}

type Result = WindowsClaudeHookForwardResult;

function notSent(reason: WindowsClaudeHookNotSentReason): Result {
  return Object.freeze({ disposition: "not-sent" as const, reason });
}

function unknownResult(reason: WindowsClaudeHookUnknownReason): Result {
  return Object.freeze({ disposition: "unknown" as const, reason });
}

function fenceHolds(fence: () => boolean): boolean {
  try {
    return fence() === true;
  } catch {
    return false;
  }
}

function noop(): void {}

/*
 * Native cancellation operations, captured at load. The `aborted` accessor
 * brand-checks its receiver (anything but a genuine AbortSignal throws), and
 * the EventTarget methods cannot be shadowed by the caller's signal object.
 */
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
/*
 * `AbortSignal.any`, captured at load. The forwarder subscribes to a private
 * dependent signal, never to the caller's shared one: dependent signals are
 * aborted independently of the source's event dispatch, so an earlier
 * listener on the caller's signal (e.g. `stopImmediatePropagation`) cannot
 * suppress cancellation and cleanup.
 */
const abortSignalAny = AbortSignal.any;

/** Throws for anything that is not a genuine AbortSignal. */
function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (abortedGetter === undefined) throw new TypeError("no native aborted accessor");
  return Reflect.apply(abortedGetter, signal, []) === true;
}

/* -------------------------------------------------------------- forwarder */

/**
 * Forward one record over one authenticated connection. Never rejects; the
 * promise settles exactly once with a closed {@link WindowsClaudeHookForwardResult}.
 */
export function forwardWindowsClaudeHookRecordOnce(
  request: WindowsClaudeHookForwardRequest,
  seams?: WindowsClaudeHookForwardSeams,
): Promise<WindowsClaudeHookForwardResult> {
  // Read every field exactly once; nothing is reread later.
  let pipe: unknown;
  let runId: unknown;
  let key: unknown;
  let isCurrent: unknown;
  let recordFn: unknown;
  let signal: unknown;
  let connect: unknown;
  let setTimer: unknown;
  let clearTimer: unknown;
  let now: unknown;
  try {
    if (typeof request !== "object" || request === null) return Promise.resolve(notSent("input-invalid"));
    ({ pipe, runId, key, isCurrent, record: recordFn, signal } = request);
    if (seams !== undefined) {
      if (typeof seams !== "object" || seams === null) return Promise.resolve(notSent("input-invalid"));
      ({ connect, setTimer, clearTimer, now } = seams);
    }
  } catch {
    return Promise.resolve(notSent("input-invalid"));
  }
  if (
    !isHookPipe(pipe)
    || !isRunId(runId)
    || !isKey(key)
    || typeof isCurrent !== "function"
    || typeof recordFn !== "function"
    || (connect !== undefined && typeof connect !== "function")
    || (setTimer !== undefined && typeof setTimer !== "function")
    || (clearTimer !== undefined && typeof clearTimer !== "function")
    || (now !== undefined && typeof now !== "function")
  ) {
    return Promise.resolve(notSent("input-invalid"));
  }
  const abortSignal = signal as AbortSignal | undefined;
  const fence = isCurrent as () => boolean;
  try {
    // Brand-checks the signal: a non-AbortSignal value is input-invalid.
    if (isAborted(abortSignal)) return Promise.resolve(notSent("cancelled"));
    if (!fenceHolds(fence)) return Promise.resolve(notSent("stale"));
    // The fence is a synchronous call-out: it may itself have cancelled.
    if (isAborted(abortSignal)) return Promise.resolve(notSent("cancelled"));
  } catch {
    return Promise.resolve(notSent("input-invalid"));
  }

  return new Promise<Result>((resolve) => {
    const connectFn = (connect as ((p: string) => WindowsClaudeHookSocket) | undefined) ?? ((p: string) => netConnect({ path: p }));
    const startTimer = (setTimer as ((cb: () => void, ms: number) => unknown) | undefined) ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    const stopTimer = (clearTimer as ((h: unknown) => void) | undefined) ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const clock = (now as (() => number) | undefined) ?? (() => performance.now());
    let deadline = Number.NaN;

    type Phase = "connecting" | "awaiting-proof" | "materializing" | "writing" | "done";
    let phase: Phase = "connecting";
    let socket: WindowsClaudeHookSocket | undefined;
    let subscribedSignal: AbortSignal | undefined; // the private dependent signal, while subscribed
    let timer: unknown;
    let timerArmed = false;
    let nonce = "";
    let received = 0;
    let frameBytes = 0; // total frame length, known once the terminator starts (LF: 71, CRLF: 72)
    // A complete proof stays provisional until the current I/O turn ends, so
    // trailing bytes delivered in a later same-turn chunk are still refused.
    let proofTurn: ReturnType<typeof setImmediate> | undefined;
    const proofHex = Buffer.alloc(PROOF_HEX_CHARS);

    /** Fail closed: an unreadable or non-finite clock counts as expired. */
    const expired = (): boolean => {
      try {
        const t: unknown = clock();
        return !(typeof t === "number" && t < deadline);
      } catch {
        return true;
      }
    };

    const onConnect = (): void => {
      if (phase !== "connecting" || socket === undefined) return;
      phase = "awaiting-proof";
      try {
        socket.write(`HELLO1 ${nonce}\n`, (error) => {
          if (error && (phase === "awaiting-proof" || phase === "connecting")) finish(notSent("connection-lost"));
        });
      } catch {
        finish(notSent("connection-lost"));
      }
    };
    const onData = (chunk: unknown): void => {
      if (phase === "writing" || phase === "done") return; // inbound bytes after the handoff are not read
      if (phase !== "awaiting-proof" || !Buffer.isBuffer(chunk)) {
        finish(notSent("proof-malformed"));
        return;
      }
      for (let i = 0; i < chunk.length; i += 1) {
        const pos = received;
        const byte = chunk[i];
        received += 1;
        let ok: boolean;
        if (pos < PROOF_PREFIX.length) ok = byte === PROOF_PREFIX.charCodeAt(pos);
        else if (pos < PROOF_TERMINATOR_AT) {
          ok = isLowerHexCode(byte);
          if (ok) proofHex[pos - PROOF_PREFIX.length] = byte;
        } else if (pos === PROOF_TERMINATOR_AT) {
          // LF completes the frame; CR is accepted only as the first byte of CRLF.
          ok = byte === 0x0a || byte === 0x0d;
          if (ok) frameBytes = byte === 0x0a ? PROOF_TERMINATOR_AT + 1 : PROOF_TERMINATOR_AT + 2;
        } else ok = pos === PROOF_TERMINATOR_AT + 1 && frameBytes === PROOF_TERMINATOR_AT + 2 && byte === 0x0a;
        if (!ok) {
          finish(notSent("proof-malformed"));
          return;
        }
      }
      if (frameBytes !== 0 && received === frameBytes && proofTurn === undefined) {
        proofTurn = setImmediate(() => {
          proofTurn = undefined;
          if (phase !== "awaiting-proof") return;
          try {
            handoff();
          } catch {
            // Unexpected throw: closed result, conservative about a started write.
            finish((phase as Phase) === "writing" ? unknownResult("write-failed") : notSent("record-invalid"));
          }
        });
      }
    };
    const onEnd = (): void => {
      if (phase === "writing") finish(unknownResult("connection-lost"));
      else if (phase !== "done") finish(notSent(received === 0 ? "proof-absent" : "proof-malformed"));
    };
    const onClose = (): void => {
      if (phase === "writing") finish(unknownResult("connection-lost"));
      else if (phase === "connecting") finish(notSent("connect-failed"));
      else if (phase !== "done") finish(notSent(received === 0 ? "proof-absent" : "proof-malformed"));
    };
    const onError = (): void => {
      if (phase === "writing") finish(unknownResult("connection-lost"));
      else if (phase === "connecting") finish(notSent("connect-failed"));
      else if (phase !== "done") finish(notSent("connection-lost"));
    };
    const onAbort = (): void => {
      if (phase === "writing") finish(unknownResult("cancelled"));
      else if (phase !== "done") finish(notSent("cancelled"));
    };
    const onTimeout = (): void => {
      timerArmed = false;
      if (phase === "writing") finish(unknownResult("timeout"));
      else if (phase !== "done") finish(notSent("timeout"));
    };

    function finish(result: Result): void {
      if (phase === "done") return;
      phase = "done";
      if (proofTurn !== undefined) {
        clearImmediate(proofTurn);
        proofTurn = undefined;
      }
      if (timerArmed) {
        timerArmed = false;
        try {
          stopTimer(timer);
        } catch {
          // A failing seam must not prevent the single terminal result.
        }
      }
      if (subscribedSignal !== undefined) {
        const subscribed = subscribedSignal;
        subscribedSignal = undefined;
        try {
          Reflect.apply(nativeRemoveEventListener, subscribed, ["abort", onAbort]);
        } catch {
          // Cancellation cleanup must never prevent socket teardown or settlement.
        }
      }
      const owned = socket;
      socket = undefined;
      if (owned !== undefined) {
        try {
          // A swallowing error listener stays attached for the socket's
          // remaining life, so a late error after teardown is never unhandled.
          owned.on("error", noop);
          owned.removeListener("connect", onConnect);
          owned.removeListener("data", onData);
          owned.removeListener("end", onEnd);
          owned.removeListener("close", onClose);
          owned.removeListener("error", onError);
          owned.destroy();
        } catch {
          // Teardown is best effort; the result is already decided.
        }
      }
      resolve(result);
    }

    /**
     * After every synchronous call-out: stop if the invocation already
     * settled, settle `cancelled` or `timeout` if either now applies.
     */
    function interrupted(): boolean {
      if (phase !== "materializing") return true;
      let cancelled: boolean;
      try {
        cancelled = isAborted(abortSignal);
      } catch {
        cancelled = true;
      }
      if (cancelled) {
        finish(notSent("cancelled"));
        return true;
      }
      if (expired()) {
        finish(notSent("timeout"));
        return true;
      }
      return false;
    }

    function handoff(): void {
      phase = "materializing";
      let valid = false;
      try {
        const expected = Buffer.from(
          createHmac("sha256", Buffer.from(key as string, "ascii"))
            .update(`${PROOF_CONTEXT}|${runId as string}|${nonce}`, "ascii")
            .digest("hex"),
          "ascii",
        );
        valid = expected.length === proofHex.length && timingSafeEqual(expected, proofHex);
      } catch {
        valid = false;
      }
      if (!valid) return finish(notSent("proof-mismatch"));
      if (interrupted()) return;
      if (!fenceHolds(fence)) return finish(notSent("stale"));
      if (interrupted()) return; // the fence may have cancelled, overrun, or settled
      let produced: unknown;
      try {
        produced = (recordFn as () => unknown)();
      } catch {
        return finish(notSent("record-invalid"));
      }
      if (interrupted()) return; // the producer may have cancelled, overrun, or settled
      const record = copyRecord(produced);
      produced = undefined;
      if (record === undefined) return finish(notSent("record-invalid"));
      if (!fenceHolds(fence)) return finish(notSent("stale"));
      if (interrupted()) return;
      if (socket === undefined) return finish(notSent("connection-lost"));
      const target = socket;
      phase = "writing";
      try {
        target.write(record, (error) => {
          if (phase !== "writing") return;
          if (error) return finish(unknownResult("write-failed"));
          try {
            target.end();
          } catch {
            // The record write already completed locally.
          }
          finish(Object.freeze({ disposition: "handed-off" as const, reason: "write-completed" as const }));
        });
      } catch {
        finish(unknownResult("write-failed"));
      }
    }

    try {
      nonce = randomBytes(16).toString("hex");
    } catch {
      return finish(notSent("input-invalid"));
    }
    try {
      const started: unknown = clock();
      if (typeof started !== "number" || !Number.isFinite(started)) return finish(notSent("input-invalid"));
      deadline = started + TIMEOUT_MS;
    } catch {
      return finish(notSent("input-invalid"));
    }
    try {
      timer = startTimer(onTimeout, TIMEOUT_MS);
      if ((phase as Phase) === "done") {
        // The timer settled synchronously: release its exact handle, subscribe and connect nothing.
        try {
          stopTimer(timer);
        } catch {
          // Already settled.
        }
        return;
      }
      timerArmed = true;
    } catch {
      return finish(notSent("input-invalid"));
    }
    try {
      if (abortSignal !== undefined) {
        const privateSignal = Reflect.apply(abortSignalAny, AbortSignal, [[abortSignal]]) as AbortSignal;
        if ((phase as Phase) !== "connecting") return;
        if (isAborted(abortSignal) || isAborted(privateSignal)) return finish(notSent("cancelled"));
        subscribedSignal = privateSignal;
        Reflect.apply(nativeAddEventListener, privateSignal, ["abort", onAbort, { once: true }]);
      }
    } catch {
      return finish(notSent("input-invalid"));
    }
    if (phase !== "connecting") return;
    let created: WindowsClaudeHookSocket;
    try {
      created = connectFn(pipe as string);
    } catch {
      return finish(notSent("connect-failed"));
    }
    if (phase !== "connecting") {
      // Settled while connecting (e.g. a seam fired the timer): release the socket unowned.
      try {
        created.on("error", noop);
        created.destroy();
      } catch {
        // Best effort.
      }
      return;
    }
    try {
      // The error listener is attached first, before anything can destroy the socket.
      created.on("error", onError);
      socket = created;
      created.on("connect", onConnect);
      created.on("data", onData);
      created.on("end", onEnd);
      created.on("close", onClose);
    } catch {
      socket = created;
      return finish(notSent("connect-failed"));
    }
  });
}
