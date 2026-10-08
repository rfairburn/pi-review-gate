/**
 * Pure, no-I/O observation helpers for the Windows Main ConPTY acceptance
 * harness (`session-host-native-windows-harness.ts`).
 *
 * Two independent concerns live here, each deterministic and free of process,
 * filesystem, network, environment, and terminal dependencies:
 *
 * 1. Mode witnessing — a bounded ledger of genuine *post-parse* outer VT
 *    input-mode observations. The harness fills it exclusively from the real
 *    outer `TerminalSurface` `onChange` callback (which runs after xterm
 *    finished parsing a write) and from one flush-completed read before the
 *    pre-quit assertions. Storage is bounded by the eight truth classes of the
 *    three existing `assertBeforeQuitModes` predicates, never by data-chunk
 *    count, so a later genuine negotiation cannot be silently dropped and no
 *    pre-parse or synthetic mode state becomes acceptance evidence.
 *
 * 2. PowerShell readiness-probe failure normalization — a bounded,
 *    metadata-only string (numeric/boolean fields plus allowlisted errno and
 *    signal tokens) for the existing probe failure throw. It never carries
 *    stdout, stderr, arguments, environment, or `error.message`, and it asserts
 *    no timeout cause.
 */

import type { TerminalInputModes } from "../../src/session-host/terminal-surface";

/**
 * The exact truth-class signature of the three existing pre-quit mode
 * predicates: bracketed paste, mouse tracking with SGR encoding, and any
 * non-baseline keyboard mode. Two genuine observations with the same signature
 * are interchangeable for every existing predicate, so retaining at most one
 * representative per signature (eight possible) preserves each predicate's
 * `some(...)` semantics exactly while keeping storage bounded.
 */
export interface ModeWitnessSignature {
  /** `assertBeforeQuitModes` predicate 1: bracketed-paste negotiation. */
  readonly bracketedPaste: boolean;
  /** `assertBeforeQuitModes` predicate 2: tracking active with SGR encoding. */
  readonly mouseTrackingSgr: boolean;
  /** `assertBeforeQuitModes` predicate 3: any non-baseline keyboard mode. */
  readonly nonBaselineKeyboard: boolean;
}

/** Fixed number of truth classes for the three existing predicates. */
export const MODE_WITNESS_CLASS_LIMIT = 8;

/**
 * Computes the truth-class signature using the exact boolean logic of the
 * three existing `assertBeforeQuitModes` predicates. It never rewrites the
 * observed modes themselves.
 */
export function modeWitnessSignature(modes: TerminalInputModes): ModeWitnessSignature {
  return {
    bracketedPaste: modes.bracketedPaste === true,
    mouseTrackingSgr: modes.mouseTracking !== "none" && modes.mouseEncoding === "sgr",
    nonBaselineKeyboard: modes.kittyFlags > 0
      || modes.applicationCursorKeys === true
      || modes.applicationKeypad === true
      || modes.modifyOtherKeys > 0,
  };
}

/** Stable bounded key for one truth class; exactly eight distinct values. */
export function modeWitnessKey(signature: ModeWitnessSignature): string {
  return `${signature.bracketedPaste ? "1" : "0"}`
    + `${signature.mouseTrackingSgr ? "1" : "0"}`
    + `${signature.nonBaselineKeyboard ? "1" : "0"}`;
}

/**
 * Bounded ledger of genuine mode observations. The caller is responsible for
 * recording only observations taken from the real outer `TerminalSurface`
 * after its parse completed; this class never synthesizes fields, defaults, or
 * fabricated representatives. The first exact observation of each truth class
 * is retained unmodified, and a new class can be retained at any time, so a
 * later genuine witness is never dropped by a chunk-count cap. At most
 * {@link MODE_WITNESS_CLASS_LIMIT} representatives are held.
 */
export class ModeWitnessLedger {
  private readonly keys = new Set<string>();
  private readonly retained: TerminalInputModes[] = [];

  /** Retains the first genuine observation of a class; returns whether it was new. */
  record(modes: TerminalInputModes): boolean {
    const key = modeWitnessKey(modeWitnessSignature(modes));
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    this.retained.push(modes);
    return true;
  }

  /** The exact, unmodified observations retained so far (at most eight). */
  get representatives(): readonly TerminalInputModes[] {
    return this.retained;
  }

  /** Number of distinct truth classes retained (at most eight). */
  get classCount(): number {
    return this.keys.size;
  }
}

/** Bounded counts of fixed-known outer VT mode sequences in the retained tail. */
export interface ModeNegotiationCounts {
  readonly tailBytes: number;
  readonly alternateBufferEnter: number;
  readonly alternateBufferLeave: number;
  readonly bracketedPasteSet: number;
  readonly bracketedPasteReset: number;
  readonly mouseTrackingSet: number;
  readonly mouseTrackingReset: number;
  /** DECSET/DECRST 1006 only: the SGR encoding the existing predicate checks. */
  readonly mouseSgrEncodingSet: number;
  readonly mouseSgrEncodingReset: number;
  /** DECSET/DECRST 1016 only: SGR-pixels, a different encoding from 1006. */
  readonly mouseSgrPixelsEncodingSet: number;
  readonly mouseSgrPixelsEncodingReset: number;
  readonly applicationCursorKeysSet: number;
  readonly applicationCursorKeysReset: number;
  readonly applicationKeypadSet: number;
  readonly applicationKeypadReset: number;
  readonly modifyOtherKeysSet: number;
  readonly modifyOtherKeysReset: number;
  /** Kitty keyboard push (`CSI > ... u`) requests, a presence count only. */
  readonly kittyKeyboardPush: number;
  /** Kitty keyboard set/remove (`CSI = ... u`) requests, a presence count only. */
  readonly kittyKeyboardSet: number;
  /** Kitty keyboard pop (`CSI < ... u`) requests, a presence count only. */
  readonly kittyKeyboardPop: number;
}

/** Kitty keyboard push (`CSI > ... u`) requests. */
const KITTY_KEYBOARD_PUSH = /\x1b\[>([0-9;]*)u/;
/** Kitty keyboard set/remove (`CSI = ... u`) requests. */
const KITTY_KEYBOARD_SET = /\x1b\[=([0-9;]*)u/;
/** Kitty keyboard pop (`CSI < ... u`) requests. */
const KITTY_KEYBOARD_POP = /\x1b\[<([0-9;]*)u/;

function countAny(text: string, needles: readonly string[]): number {
  let total = 0;
  for (const needle of needles) {
    let index = text.indexOf(needle);
    while (index !== -1) {
      total += 1;
      index = text.indexOf(needle, index + needle.length);
    }
  }
  return total;
}

function countMatches(text: string, pattern: RegExp): number {
  const regex = new RegExp(pattern.source, "g");
  let count = 0;
  while (regex.exec(text) !== null) {
    count += 1;
  }
  return count;
}

/**
 * True when the tail shows a Kitty keyboard request that could enable a
 * non-baseline keyboard mode: a push with nonzero flags, or a set/remove with
 * nonzero flags and a mode other than 3 (remove). Pops and zero/reset requests
 * are never treated as keyboard negotiation.
 */
function kittyKeyboardRequested(text: string): boolean {
  for (const pattern of [KITTY_KEYBOARD_PUSH, KITTY_KEYBOARD_SET]) {
    const regex = new RegExp(pattern.source, "g");
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      const params = (match[1] ?? "").split(";").map((value) => Number(value));
      const flags = params[0] ?? 0;
      const mode = params[1] ?? 1;
      if (Number.isSafeInteger(flags) && flags > 0 && mode !== 3) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Counts only fixed-known mode-negotiation sequences in an already-bounded
 * outer PTY tail. It never returns the tail's raw bytes, so a diagnostic built
 * from it carries no frame, transcript, prompt, path, environment, or native
 * user string.
 */
export function summarizeModeNegotiation(outputTail: string): ModeNegotiationCounts {
  return {
    tailBytes: Buffer.byteLength(outputTail, "utf8"),
    alternateBufferEnter: countAny(outputTail, ["\x1b[?1049h"]),
    alternateBufferLeave: countAny(outputTail, ["\x1b[?1049l"]),
    bracketedPasteSet: countAny(outputTail, ["\x1b[?2004h"]),
    bracketedPasteReset: countAny(outputTail, ["\x1b[?2004l"]),
    mouseTrackingSet: countAny(outputTail, ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h"]),
    mouseTrackingReset: countAny(outputTail, ["\x1b[?1000l", "\x1b[?1002l", "\x1b[?1003l"]),
    mouseSgrEncodingSet: countAny(outputTail, ["\x1b[?1006h"]),
    mouseSgrEncodingReset: countAny(outputTail, ["\x1b[?1006l"]),
    mouseSgrPixelsEncodingSet: countAny(outputTail, ["\x1b[?1016h"]),
    mouseSgrPixelsEncodingReset: countAny(outputTail, ["\x1b[?1016l"]),
    applicationCursorKeysSet: countAny(outputTail, ["\x1b[?1h"]),
    applicationCursorKeysReset: countAny(outputTail, ["\x1b[?1l"]),
    applicationKeypadSet: countAny(outputTail, ["\x1b[?66h", "\x1b="]),
    applicationKeypadReset: countAny(outputTail, ["\x1b[?66l", "\x1b>"]),
    modifyOtherKeysSet: countAny(outputTail, ["\x1b[>4;1m", "\x1b[>4;2m"]),
    modifyOtherKeysReset: countAny(outputTail, ["\x1b[>4;0m"]),
    kittyKeyboardPush: countMatches(outputTail, KITTY_KEYBOARD_PUSH),
    kittyKeyboardSet: countMatches(outputTail, KITTY_KEYBOARD_SET),
    kittyKeyboardPop: countMatches(outputTail, KITTY_KEYBOARD_POP),
  };
}

export interface ModeWitnessDiagnosticInput {
  /** The existing bounded outer PTY tail (never emitted verbatim). */
  readonly outputTail: string;
  /** Genuine post-parse mode representatives retained so far. */
  readonly representatives: readonly TerminalInputModes[];
  readonly deviceAttributesReplies: number;
  readonly kittyQueryReplies: number;
  readonly alternateBufferEntered: boolean;
  readonly alternateBufferLeft: boolean;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * Builds a bounded, metadata-only line for a failed pre-quit mode assertion.
 * It reports the retained truth classes and fixed-known mode-sequence counts of
 * the existing bounded tail, plus *sequence-presence hints* (a sequence appears
 * in the retained tail) rather than negotiated-mode or causal claims. A set
 * followed by a reset in the same parse batch need not produce an observed
 * positive state, and absence from this bounded tail does not prove absence
 * earlier in the stream. The metadata supports diagnosis, not acceptance.
 * It emits no raw frame,
 * transcript, environment, path, prompt, or user string, and asserts no cause.
 */
export function formatModeWitnessDiagnostic(input: ModeWitnessDiagnosticInput): string {
  const counts = summarizeModeNegotiation(input.outputTail);
  const signatures = input.representatives.map((modes) => modeWitnessKey(modeWitnessSignature(modes)));
  const bracketedPastePresent = counts.bracketedPasteSet > 0;
  // Only 1006 is the SGR encoding the existing predicate checks; 1016 is the
  // distinct SGR-pixels encoding and never satisfies that predicate.
  const trackingSgrPresent = counts.mouseTrackingSet > 0 && counts.mouseSgrEncodingSet > 0;
  const keyboardPresent = counts.applicationCursorKeysSet > 0
    || counts.applicationKeypadSet > 0
    || counts.modifyOtherKeysSet > 0
    || kittyKeyboardRequested(input.outputTail);
  return [
    "modeWitnessDiag{",
    `classes=${signatures.length}/${MODE_WITNESS_CLASS_LIMIT}`,
    `signatures=${signatures.join("|") || "none"}`,
    `altEnter=${input.alternateBufferEntered}`,
    `altLeave=${input.alternateBufferLeft}`,
    `daReplies=${boundedCount(input.deviceAttributesReplies)}`,
    `kittyReplies=${boundedCount(input.kittyQueryReplies)}`,
    `tailBytes=${boundedCount(counts.tailBytes)}`,
    `seqCounts{altEnter=${counts.alternateBufferEnter} altLeave=${counts.alternateBufferLeave}`,
    `bracketSet=${counts.bracketedPasteSet} bracketReset=${counts.bracketedPasteReset}`,
    `trackSet=${counts.mouseTrackingSet} trackReset=${counts.mouseTrackingReset}`,
    `sgr1006Set=${counts.mouseSgrEncodingSet} sgr1006Reset=${counts.mouseSgrEncodingReset}`,
    `sgr1016Set=${counts.mouseSgrPixelsEncodingSet} sgr1016Reset=${counts.mouseSgrPixelsEncodingReset}`,
    `cursorKeysSet=${counts.applicationCursorKeysSet} cursorKeysReset=${counts.applicationCursorKeysReset}`,
    `keypadSet=${counts.applicationKeypadSet} keypadReset=${counts.applicationKeypadReset}`,
    `modifySet=${counts.modifyOtherKeysSet} modifyReset=${counts.modifyOtherKeysReset}`,
    `kittyPush=${counts.kittyKeyboardPush} kittySet=${counts.kittyKeyboardSet} kittyPop=${counts.kittyKeyboardPop}}`,
    `sequencePresence{bracketedPaste=${bracketedPastePresent}`,
    `trackingSgr=${trackingSgrPresent}`,
    `keyboard=${keyboardPresent}}`,
    "}",
  ].join(" ");
}

/** Generic observation for the existing PowerShell readiness-probe failure throw. */
export interface WindowsProbeFailureObservation {
  readonly hadSpawnError: boolean;
  /** `error.code` only; never `error.message`. */
  readonly errorCode: unknown;
  readonly status: unknown;
  readonly signal: unknown;
  readonly stdoutVersionMatched: boolean;
  readonly elapsedMs: number;
}

/** Errno tokens a Windows `spawnSync` failure can report; anything else is "other". */
const PROBE_ERRNO_ALLOWLIST = new Set<string>([
  "EACCES", "EAGAIN", "EBADF", "E2BIG", "EINVAL", "EIO", "EINTR", "EISDIR", "EMFILE",
  "ENFILE", "ENOENT", "ENOEXEC", "ENOMEM", "ENOSPC", "ENOTDIR", "EPERM", "EPIPE",
  "ESRCH", "ETIMEDOUT", "UNKNOWN",
]);

/** POSIX signal names a child can report; anything else is "other". */
const PROBE_SIGNAL_ALLOWLIST = new Set<string>([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE",
  "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM",
  "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG",
  "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGSYS",
]);

/**
 * Normalizes a failed PowerShell readiness probe into a bounded line of
 * generic numeric/boolean state: elapsed milliseconds, whether a spawn error
 * was present, an allowlisted errno token (else "other"), the integer/null
 * status, an allowlisted signal name (else "other", or "null"), and whether the
 * stdout version matched. It never reads or emits stdout/stderr content, args,
 * env, or `error.message`, and it asserts no timeout cause.
 */
export function normalizeWindowsProbeFailure(observation: WindowsProbeFailureObservation): string {
  const elapsedMs = Number.isSafeInteger(observation.elapsedMs) && observation.elapsedMs >= 0
    ? observation.elapsedMs
    : -1;
  const errno = typeof observation.errorCode === "string" && PROBE_ERRNO_ALLOWLIST.has(observation.errorCode)
    ? observation.errorCode
    : "other";
  const status = typeof observation.status === "number" && Number.isSafeInteger(observation.status)
    ? observation.status
    : "null";
  const signal = observation.signal === null || observation.signal === undefined
    ? "null"
    : typeof observation.signal === "string" && PROBE_SIGNAL_ALLOWLIST.has(observation.signal)
      ? observation.signal
      : "other";
  return `elapsedMs=${elapsedMs} hadSpawnError=${observation.hadSpawnError === true}`
    + ` errno=${errno} status=${status} signal=${signal}`
    + ` stdoutVersionMatched=${observation.stdoutVersionMatched === true}`;
}
