/*
 * Derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
// Pure logic for background shell jobs: wake rules, output buffering, and the
// bounded payload the model actually sees. No child processes and no pi
// runtime here, so every decision below is unit-testable.
//
// The problem this exists to solve: pi's `bash` is fire-and-wait, so a long job
// either blocks the turn for its whole duration or gets backgrounded and then
// POLLED — burning a turn, a slice of a small context window, and thirty
// seconds of local inference to learn that training is still on epoch 3. If a
// fine-tune runs six hours, checking every five minutes is 71 wasted turns.
//
// So the clock is not the trigger. When the model starts a job it declares what
// is worth being woken for, and the harness stays silent until one of those
// things happens. Six hours of progress bars cost nothing; a traceback at
// minute 40 costs one turn, immediately.

export type WakeKind = "exit" | "match" | "silence" | "milestone";

// ── Output bounds (finding 4) ───────────────────────────────────────────
//
// Every surface a job's output can reach — the pending partial line, the ring
// buffer, ShellLog results, and the wake payload — carries an explicit
// character bound enforced with a visible truncation marker. A character cap
// is also a byte-equivalent bound: any string of N UTF-16 code units encodes
// to at most 3N UTF-8 bytes (BMP code points ≤ 3 bytes, surrogate pairs 2
// units → ≤ 4 bytes), so the byte cost of a bounded string is bounded too.

/** Appended to anything cut short, so truncation is always visible. */
export const TRUNCATION_MARKER = "…[truncated]";

/** Character cap for a stored (ring-buffer) line. */
export const MAX_STORED_LINE_CHARS = 8_192;
/** Character cap for the pending partial line held between chunks.
 *  ≤ 96 KiB UTF-8, so multi-MB output without newlines cannot accumulate. */
export const MAX_PENDING_LINE_CHARS = 32_768;
/** Character cap for one line inside a wake payload excerpt. */
export const MAX_WAKE_EXCERPT_LINE_CHARS = 512;
/** Total character cap for a whole wake payload. */
export const MAX_WAKE_PAYLOAD_CHARS = 8_192;
/** Character cap for one line in a ShellLog result. */
export const MAX_LOG_LINE_CHARS = 2_048;
/** Total character cap for a ShellLog result. */
export const MAX_LOG_RESULT_CHARS = 32_768;
/** Character cap for a job label (stored and displayed). */
export const MAX_LABEL_CHARS = 80;
/** Character cap for the displayed command (the stored command is the
 *  executable text and is never altered). */
export const MAX_COMMAND_DISPLAY_CHARS = 512;
/** Character cap for error text returned to the model — job IDs, labels, and
 *  spawn messages interpolated into tool errors are model-supplied and must
 *  not be echoed wholesale into context. */
export const MAX_ERROR_DISPLAY_CHARS = 240;
/** Max model-supplied wake patterns per job. */
export const MAX_WAKE_PATTERNS = 16;
/** Character cap for a single model-supplied wake pattern. */
export const MAX_PATTERN_CHARS = 512;
/** Candidate-line cap before matching: patterns are evaluated against at
 *  most this many characters of any line, so matching cost is bounded even
 *  for a linear-time engine. */
export const MAX_MATCH_LINE_CHARS = 8_192;
/** Total character budget for all lines retained by a LineBuffer, on top of
 *  the line-count cap — 5000 lines of 8 KiB each would otherwise be ~80 MB. */
export const MAX_BUFFER_CHARS = 2_000_000;

/** Cut `text` down to at most `max` characters, marking the cut. At a cap
 *  too small to hold the marker itself, the plain cut wins: the bound is
 *  the invariant, the marker is best-effort. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return text.slice(0, max);
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** How urgently a wake event reaches the agent. Maps onto pi's sendMessage
 *  delivery modes — see laneDelivery(). */
export type Lane = "now" | "soon" | "idle";

export interface WakeRules {
  /** Wake when the process exits. Defaults true: an exited job the model still
   *  believes is running is the worst state to be in. */
  exit: boolean;
  /** Patterns worth waking for. Treated as regex, falling back to a literal
   *  substring when the string is not a valid regex (models write plain text
   *  like "CUDA out of memory" far more often than they write anchors). */
  match: string[];
  /** Wake if the job produced output and then went quiet for this long. */
  silenceMs?: number;
  /** Throttle a chatty pattern: only wake on every Nth match. */
  everyNMatches?: number;
}

export const DEFAULT_RULES: WakeRules = { exit: true, match: [] };

/** Lines kept per job. The buffer is the model's ability to look back, so it
 *  has to be generous — but it lives in the harness, never in the context
 *  window, so generous is cheap. */
export const MAX_BUFFER_LINES = 5000;
/** Lines of context included around a matching line in a wake payload. */
export const WAKE_CONTEXT_LINES = 12;
/** Never wake for the same job more often than this, whatever the rules say.
 *  A job that matches its own error pattern every second must not be able to
 *  drive the agent in a loop. */
export const MIN_WAKE_INTERVAL_MS = 15_000;

// ── Duration parsing ────────────────────────────────────────────────────

/** Parse "45s" / "10m" / "2h" / a bare number of seconds. Null when unparseable
 *  so a typo disables the rule loudly rather than silently meaning 0ms. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v * 1000);
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((m[2] || "s").toLowerCase()) {
    case "ms": return Math.round(n);
    case "s": return Math.round(n * 1000);
    case "m": return Math.round(n * 60_000);
    case "h": return Math.round(n * 3_600_000);
    default: return null;
  }
}

/** Build WakeRules from whatever the model passed as `wake_on`. Permissive by
 *  design: a malformed field falls back to its default rather than failing the
 *  whole call, because a job that failed to start is strictly worse than a job
 *  with one rule missing. */
export function normalizeRules(raw: any): WakeRules {
  const out: WakeRules = { exit: true, match: [] };
  if (!raw || typeof raw !== "object") return out;
  if (raw.exit === false) out.exit = false;

  const m = raw.match;
  if (typeof m === "string") out.match = [m];
  else if (Array.isArray(m)) out.match = m.filter((x: any) => typeof x === "string" && x.length > 0);
  // Untrusted model input: cap the count and the length of every pattern
  // before anything downstream sees it.
  out.match = out.match
    .slice(0, MAX_WAKE_PATTERNS)
    .map((p) => (p.length > MAX_PATTERN_CHARS ? p.slice(0, MAX_PATTERN_CHARS) : p));

  const sil = parseDuration(raw.silence);
  if (sil) out.silenceMs = sil;

  const n = raw.every_n_matches ?? raw.everyNMatches;
  if (typeof n === "number" && Number.isFinite(n) && n > 1) out.everyNMatches = Math.floor(n);

  return out;
}

// ── Linear-time matching (finding 4) ────────────────────────────────────
//
// Model-supplied wake patterns are untrusted text, and V8's RegExp engine
// backtracks: one `(a+)+$` against one unlucky line can freeze the host's
// event loop for minutes. Production therefore NEVER compiles model text with
// `new RegExp`. Patterns are evaluated by RE2 — a linear-time engine with no
// backtracking — compiled once per job via re2-wasm (pure WebAssembly, no
// native addon). Anything RE2 cannot compile (invalid syntax, unsupported
// constructs) degrades to a case-insensitive literal substring test, which is
// itself linear. The module is loaded through a guarded require: if re2-wasm
// cannot load at all (no wasm support, exotic runtime), RE2 stays null and
// every pattern degrades to the literal test — degraded matching beats a
// module-load crash.

type Re2Matcher = { test(s: string): boolean };
type Re2Constructor = new (pattern: string, flags?: string) => Re2Matcher;
let RE2: Re2Constructor | null = null;
try {
  RE2 = (require("re2-wasm") as { RE2: Re2Constructor }).RE2;
} catch {
  RE2 = null;
}

/** A compiled matcher for one pattern. */
export interface CompiledPattern {
  pattern: string;
  test: (line: string) => boolean;
}

/** Compile one pattern to a predicate. Never throws; never touches V8's
 *  RegExp on model text — invalid or unsupported syntax yields the literal
 *  substring fallback. RE2 requires the unicode flag, so patterns using
 *  non-unicode-only syntax that RE2 rejects fall back the same way. */
export function compileMatcher(pattern: string): (line: string) => boolean {
  const compiled = compilePattern(pattern);
  return compiled.test;
}

function compilePattern(pattern: string): CompiledPattern {
  if (RE2) {
    try {
      const re = new RE2(pattern, "iu");
      return {
        pattern,
        test: (line) => {
          // A construct-time-valid pattern can still fail at match time (e.g.
          // unpaired surrogates in the candidate). Fall back to the literal
          // test rather than throwing out of a stream handler.
          try {
            return re.test(line);
          } catch {
            return literalTest(pattern, line);
          }
        },
      };
    } catch {
      return { pattern, test: (line) => literalTest(pattern, line) };
    }
  }
  // re2-wasm unavailable: every pattern takes the bounded literal fallback.
  return { pattern, test: (line) => literalTest(pattern, line) };
}

/** Bounded, linear, dependency-free fallback. */
function literalTest(pattern: string, line: string): boolean {
  return line.toLowerCase().includes(pattern.toLowerCase());
}

/** All of a job's patterns, compiled once. Replaces the old per-line
 *  compile: `findMatch` used to build a fresh RegExp for every pattern on
 *  every line of output. */
export interface JobMatchers {
  patterns: readonly string[];
  /** The first pattern matching `line` (already capped to
   *  MAX_MATCH_LINE_CHARS), or null. */
  match(line: string): string | null;
}

export function compileMatchers(patterns: readonly string[]): JobMatchers {
  // Belt-and-braces: normalizeRules already caps count and length.
  const capped = patterns
    .slice(0, MAX_WAKE_PATTERNS)
    .map((p) => (p.length > MAX_PATTERN_CHARS ? p.slice(0, MAX_PATTERN_CHARS) : p));
  const compiled = capped.map(compilePattern);
  return {
    patterns: capped,
    match(line: string): string | null {
      // Candidate cap: matching cost is bounded no matter how long the line
      // is. Trade-off, documented: anchors like `$` and any content past the
      // cap are evaluated against the PREFIX only — an end-anchored pattern
      // can false-positive on a truncated line, and text beyond the cap is
      // never seen by any matcher.
      const bounded = line.length > MAX_MATCH_LINE_CHARS
        ? line.slice(0, MAX_MATCH_LINE_CHARS)
        : line;
      for (const c of compiled) {
        if (c.test(bounded)) return c.pattern;
      }
      return null;
    },
  };
}

/** Match cache so the per-call entry point stays cheap when a caller has not
 *  pre-compiled (tests, one-off callers). Production compiles once per job. */
const matcherCache = new WeakMap<WakeRules, JobMatchers>();

// ── Ring buffer ─────────────────────────────────────────────────────────

/** Line buffer with a hard cap. Keeps a running count of everything ever
 *  written so ShellLog offsets stay stable after old lines are dropped. */
export class LineBuffer {
  private lines: string[] = [];
  private dropped = 0;
  private chars = 0;

  constructor(
    private max = MAX_BUFFER_LINES,
    private maxChars = MAX_BUFFER_CHARS,
    private maxLineChars = MAX_STORED_LINE_CHARS,
  ) {}

  push(line: string): void {
    // Bound the stored length of a single line; the cut is visible. A custom
    // total budget smaller than the normal line cap must still be honored by
    // a buffer containing only one line.
    const stored = truncateText(line, Math.min(this.maxLineChars, this.maxChars));
    this.lines.push(stored);
    this.chars += stored.length;
    if (this.lines.length > this.max) {
      this.dropped += this.lines.length - this.max;
      this.lines = this.lines.slice(-this.max);
      this.recountChars();
    }
    // Byte-equivalent accumulation bound: drop oldest lines until the retained
    // text fits the character budget. `total`/`droppedCount`/offsets stay
    // stable because dropped lines only ever move into `dropped`.
    while (this.chars > this.maxChars && this.lines.length > 1) {
      this.chars -= this.lines[0].length;
      this.lines.shift();
      this.dropped += 1;
    }
  }

  private recountChars(): void {
    this.chars = 0;
    for (const l of this.lines) this.chars += l.length;
  }

  /** Total lines ever written, including dropped ones. */
  get total(): number {
    return this.dropped + this.lines.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** The last `n` lines. */
  tail(n: number): string[] {
    return this.lines.slice(-Math.max(0, n));
  }

  /** Lines from absolute index `from` (in `total` coordinates), up to `limit`.
   *  Clamps into whatever is still retained. */
  slice(from: number, limit: number): { lines: string[]; from: number; nextOffset: number } {
    const start = Math.max(from, this.dropped);
    const localStart = start - this.dropped;
    const lines = this.lines.slice(localStart, localStart + Math.max(0, limit));
    return { lines, from: start, nextOffset: start + lines.length };
  }

  /** The last `context` lines ending at the most recent line. */
  around(context: number): string[] {
    return this.tail(context);
  }
}

/**
 * Bounded accumulator for a job's pending partial line.
 *
 * A job that emits multi-MB output without newlines (base64 dump, progress
 * bar) must not grow host memory without bound, and capping the ring buffer
 * alone does not help because the bytes sit in the partial line first. Once
 * the partial exceeds MAX_PENDING_LINE_CHARS it is cut short with a visible
 * marker and the rest of THAT line is discarded; newlines still complete the
 * line, and the next line starts fresh.
 */
export class PendingLineBuffer {
  private text = "";
  private over = false;

  constructor(private cap = MAX_PENDING_LINE_CHARS) {}

  /** Feed one decoded chunk; returns every complete line it contains. */
  push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl === -1) break;
      lines.push(this.complete(rest.slice(0, nl)));
      rest = rest.slice(nl + 1);
    }
    this.append(rest);
    return lines;
  }

  /** The remaining partial line when the job closes; resets the accumulator.
   *  Empty string when there is no trailing partial. */
  flush(): string {
    const text = this.text;
    this.text = "";
    this.over = false;
    return text;
  }

  private append(part: string): void {
    if (this.over) return; // this line is already capped and marked; drop the rest
    const combined = this.text + part;
    if (combined.length <= this.cap) {
      this.text = combined;
      return;
    }
    this.text = truncateText(combined, this.cap);
    this.over = true;
  }

  private complete(part: string): string {
    if (this.over) {
      const line = this.text;
      this.text = "";
      this.over = false;
      return line;
    }
    const combined = this.text + part;
    this.text = "";
    return truncateText(combined, this.cap);
  }
}

// ── Wake decisions ──────────────────────────────────────────────────────

export interface JobWakeState {
  /** Matches seen so far, for every_n_matches throttling. */
  matchCount: number;
  /** When we last woke the agent for this job. */
  lastWakeAt: number;
  /** Whether a stall wake has already fired for the current quiet period. */
  stallNotified: boolean;
}

export interface WakeEvent {
  kind: WakeKind;
  lane: Lane;
  /** Short human reason, e.g. `matched "Traceback"`. */
  reason: string;
}

/** Patterns that mean "this is broken", which get the urgent lane even when the
 *  model listed them as ordinary matches. Anything the model explicitly asked
 *  about is relevant; these are the subset that invalidate what it believes. */
const ERROR_ISH = /traceback|out of memory|oom|fatal|panic|segmentation fault|\berror\b|exception/i;

/** The first configured pattern this line matches, or null. Exported so the
 *  caller can decide-once: whether a line matched drives BOTH the match counter
 *  and the wake decision, and computing it twice with two different notions of
 *  "matches" is how every_n_matches quietly stops lining up with reality.
 *
 *  Pass the job's pre-compiled matchers in production; without them the rules'
 *  matchers are compiled once and cached on the rules object. */
export function findMatch(line: string, rules: WakeRules, matchers?: JobMatchers): string | null {
  const m = matchers ?? cacheMatchers(rules);
  return m.match(line);
}

function cacheMatchers(rules: WakeRules): JobMatchers {
  let m = matcherCache.get(rules);
  if (!m) {
    m = compileMatchers(rules.match);
    matcherCache.set(rules, m);
  }
  return m;
}

/**
 * Decide whether a matched line should wake the agent.
 *
 * `matchCount` is the count INCLUDING this match — the caller increments first,
 * so throttling counts every occurrence even when the wake is suppressed.
 * Otherwise a throttled pattern could never reach N and would wake either
 * always or never.
 */
export function evaluateMatch(
  hit: string,
  line: string,
  rules: WakeRules,
  state: JobWakeState,
  matchCount: number,
  now: number,
): WakeEvent | null {
  if (rules.everyNMatches && matchCount % rules.everyNMatches !== 0) return null;
  // The loop guard: a job that matches its own error pattern every second must
  // not be able to drive the agent in circles.
  if (now - state.lastWakeAt < MIN_WAKE_INTERVAL_MS) return null;

  const errorish = ERROR_ISH.test(line);
  return {
    kind: rules.everyNMatches ? "milestone" : "match",
    lane: errorish ? "now" : "soon",
    reason: `matched ${JSON.stringify(hit)}`,
  };
}

/** Decide the lane for a process exit. A non-zero exit is urgent because every
 *  subsequent step the model takes rests on a false premise until it knows. */
export function evaluateExit(exitCode: number | null, rules: WakeRules): WakeEvent | null {
  if (!rules.exit) return null;
  const failed = exitCode !== 0;
  return {
    kind: "exit",
    lane: failed ? "now" : "soon",
    reason: failed ? `exited ${exitCode}` : "exited 0",
  };
}

/** Decide whether a quiet job counts as stalled. Only fires once per quiet
 *  period, and only for a job that produced output first — a job that is
 *  legitimately silent from the start (a compile) is not stalled. */
export function evaluateSilence(
  rules: WakeRules,
  state: JobWakeState,
  lastOutputAt: number | null,
  now: number,
): WakeEvent | null {
  if (!rules.silenceMs || state.stallNotified || lastOutputAt === null) return null;
  if (now - lastOutputAt < rules.silenceMs) return null;
  return {
    kind: "silence",
    lane: "soon",
    reason: `no output for ${Math.round((now - lastOutputAt) / 1000)}s`,
  };
}

/** pi sendMessage delivery options for a lane.
 *
 *  "steer"    — after the current tool calls, before the next LLM call.
 *  "followUp" — once the agent has no more tool calls.
 *  "nextTurn" — queued; interrupts nothing and triggers nothing. */
export function laneDelivery(lane: Lane): { deliverAs: string; triggerTurn?: boolean } {
  switch (lane) {
    case "now": return { deliverAs: "steer", triggerTurn: true };
    case "soon": return { deliverAs: "followUp", triggerTurn: true };
    case "idle": return { deliverAs: "nextTurn" };
  }
}

// ── Payload ─────────────────────────────────────────────────────────────

/**
 * Wrap a command so the job kills itself when pi-review-gate goes away.
 *
 * Signal handlers cover a clean exit and ctrl+c, but they cannot cover SIGKILL,
 * a crash, or a terminal that vanishes — and an orphaned training run holds GPU
 * memory on a box whose entire constraint is 8GB of it. So the guarantee is
 * pushed into the job: a watchdog polls for the parent pid and takes the whole
 * process group down with it when the parent disappears.
 *
 * This requires the job to be its OWN process group (spawn detached), which is
 * why `kill -TERM 0` is safe here — it signals the job's group, never
 * pi-review-gate's. The watchdog is killed on the normal path so a finished job
 * leaves nothing behind, and the command's exit status is preserved.
 */
export function wrapWithParentWatchdog(command: string, parentPid: number, pollSeconds = 5): string {
  return [
    `__pi_review_parent=${parentPid}`,
    // The watchdog's stdio is redirected away from the job's pipes. Otherwise
    // its `sleep` inherits them, and since killing the subshell does not kill
    // that sleep, the pipes stay open after the command finishes — Node's
    // `close` fires only once stdio is done, so the exit wake would arrive
    // seconds late or, if the sleep outlives us, not at all.
    `( __pi_review_sleep=; trap 'if [ -n "$__pi_review_sleep" ]; then kill "$__pi_review_sleep" 2>/dev/null; fi; exit 0' TERM; while kill -0 "$__pi_review_parent" 2>/dev/null; do sleep ${pollSeconds} & __pi_review_sleep=$!; wait "$__pi_review_sleep"; __pi_review_sleep=; done; trap - TERM; kill -TERM 0 2>/dev/null ) >/dev/null 2>&1 </dev/null &`,
    `__pi_review_watchdog=$!`,
    // Run arbitrary user text in a child shell so an explicit `exit` cannot
    // skip the watchdog cleanup below. The delimiters remain newline-separated
    // because a comment, heredoc, or trailing backslash may end the command.
    `(`,
    command,
    `)`,
    `__pi_review_rc=$?`,
    `kill "$__pi_review_watchdog" 2>/dev/null`,
    // Bash can defer terminating the watchdog while it waits for its current
    // sleep child. Waiting here keeps the process group authoritative: the
    // ShellStart exit event is not emitted until the watchdog tree is gone.
    `wait "$__pi_review_watchdog" 2>/dev/null`,
    `exit $__pi_review_rc`,
  ].join("\n");
}

/** Argument list for the Windows background shell — identical to Pi's native
 *  powershell tool (dist/core/tools/powershell.js + dist/utils/shell.js):
 *  non-interactive, profile-free, execution-policy bypassed, one -Command. */
export const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
] as const;

/** Best-effort UTF-8 console-output initialization, byte-identical to the
 *  prefix Pi's powershell tool prepends before every command. Administrator-
 *  enforced execution policies and console code pages can still take
 *  precedence; the try/catch makes the prefix best-effort by design. */
export const POWERSHELL_UTF8_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}";

/** Quote a value as a PowerShell single-quoted string literal (the only escape
 *  that form needs is doubling the quote). Used to embed per-job file paths in
 *  generated scripts without any interpolation hazard. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wrap a command so the job kills itself when pi-review-gate goes away — the
 * Windows counterpart of wrapWithParentWatchdog.
 *
 * The guarantee is the same (a job must die when the host dies by ANY means,
 * and owned work must stay accounted for after the shell root exits), but
 * Windows has no process groups and no portable signals, so the mechanism
 * differs in five ways:
 *
 * - Ownership is a Windows JOB OBJECT, not a tree walk. The watchdog creates
 *   it with JOB_OBJECT_LIMIT_DIE_ON_CLOSE (LimitFlags 0x2000, written at
 *   offset 16 of JOBOBJECT_BASIC_LIMIT_INFORMATION via
 *   JobObjectExtendedLimitInformation) and assigns THIS shell to it before the
 *   user command runs; every process the shell then creates — including
 *   Start-Process grandchildren — joins the job automatically, and no
 *   breakaway flag is set, so a process in the job cannot create processes
 *   outside it (escape attempts fail). The watchdog holds the only handle:
 *   while it lives, the tree is owned; if it dies for any reason, the kernel
 *   terminates every member immediately (fail closed — work may be lost,
 *   orphans never are).
 * - Ownership SURVIVES THE ROOT'S EXIT. The wrapper deliberately does NOT kill
 *   the watchdog when the shell exits: the watchdog keeps holding the job as
 *   long as owned processes remain (recording its pid and state in
 *   `ownership.markerPath` so readiness and the extension can see that),
 *   releases itself within one poll once the job's accounting query verifies
 *   it empty, and terminates the whole job — TerminateJobObject through the
 *   job handle ONLY, never taskkill by pid (after the root exits that pid may
 *   identify an unrelated process) — when the host disappears or the stop file
 *   (`ownership.stopPath`) appears. That is what keeps descendants cleanable
 *   and non-surviving past host death even though a tree walk from the root
 *   pid can no longer reach them once that pid is gone.
 * - The watchdog is a SEPARATE PROCESS of the same shell edition (launched via
 *   .NET ProcessStartInfo from inside the wrapper: hidden window, its own stdio
 *   pipes so it can never hold the job's pipes open after the command
 *   finishes; console output additionally redirected to the null stream so a
 *   dead pipe can never block it). It runs plain PowerShell, identically on
 *   PowerShell 7 and Windows PowerShell 5.1 — no threads, no cross-thread
 *   runspace dependence.
 * - Identity is creation-time, not just a pid: before anything else the wrapper
 *   records the parent's AND its own StartTime ticks and fails closed (exit 1,
 *   command never runs) when it cannot; the watchdog then treats the parent as
 *   gone unless the pid exists AND its creation time still matches, so a reused
 *   pid cannot keep the job alive.
 * - The user command runs in a child scope (`& { ... }`) so assignments in the
 *   command cannot leak into wrapper state (the Bash version uses a subshell
 *   for the same reason).
 *
 * Fail-closed handshake: the watchdog writes `ownership.markerPath` only AFTER
 * the job object exists and this shell is assigned to it; the wrapper waits for
 * that marker (bounded by `readyTimeoutMs`, failing fast if the watchdog exits
 * first) before running the command, so a failure to establish lifecycle
 * ownership aborts the job with exit 1 and no unprotected execution. Every
 * pre-command failure also records `0 failed` in the marker so readiness can
 * distinguish "ownership was never established, nothing ran" from lost
 * evidence (which must stay blocking, not clear).
 *
 * Exit status is preserved: `$?` is captured as the FIRST statement after the
 * command block (any earlier statement would overwrite it), then combined with
 * `$LASTEXITCODE`: a failed cmdlet (false `$?`, no native status) maps to 1,
 * a native failure keeps its own code, and an explicit `exit N` ends the shell
 * directly with N, like Bash. The watchdog is intentionally left running on
 * every exit path — it releases itself within one poll once no owned process
 * remains, so a finished job still leaves nothing behind.
 *
 * The script stays Windows-PowerShell-5.1 compatible (no `??`, no ternary),
 * because discovery may fall back to the built-in edition.
 */
export function wrapWithPowerShellWatchdog(
  command: string,
  parentPid: number,
  pollSeconds = 5,
  ownership: { markerPath: string; stopPath: string },
  readyTimeoutMs = 30_000,
): string {
  // One line on purpose: it sits inside a single-quoted here-string below, and
  // a line starting with `'@` would terminate that here-string early. The
  // watchdog script uses only single-quoted strings so embedding it in the
  // -Command argument needs no inner double-quote escaping. Per-job file paths
  // are substituted into the watchdog command at RUNTIME (.Replace), never
  // embedded in the here-string text, so a hostile path cannot terminate the
  // here-string.
  const watchdog =
    `[Console]::SetOut([System.IO.StreamWriter]::Null); [Console]::SetError([System.IO.StreamWriter]::Null); ` +
    `$mk = __PI_MARKER__; $st = __PI_STOP__; ` +
    // kernel32 job-object surface, compiled in-process (Add-Type works on both
    // PowerShell editions; no external dependency).
    `try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiReviewBgJobApi { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a,String n); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j,uint e); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a,bool b,int p); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }' } catch { exit 1 }; ` +
    // JOB_OBJECT_LIMIT_DIE_ON_CLOSE (0x2000): when the last handle to the job
    // closes, the kernel terminates every member. The watchdog holds that only
    // handle, so a dead watchdog can never leave owned work behind.
    // LimitFlags sits at offset 16 of JOBOBJECT_BASIC_LIMIT_INFORMATION (after
    // the two LARGE_INTEGER time limits); it is set through
    // JobObjectExtendedLimitInformation (class 9), sized 144 bytes on 64-bit
    // and 112 on 32-bit. The rest of the zeroed buffer keeps every other limit
    // at its default, and NO breakaway flag is set: with both
    // JOB_OBJECT_LIMIT_BREAKAWAY_OK and SILENT_BREAKAWAY_OK absent, a process
    // in the job cannot create processes outside it — escape attempts fail.
    `$job = [PiReviewBgJobApi]::CreateJobObjectW([IntPtr]::Zero, $null); if ($job -eq [IntPtr]::Zero) { exit 1 }; ` +
    `$size = 144; if ([IntPtr]::Size -eq 4) { $size = 112 }; ` +
    `$lim = [Runtime.InteropServices.GCHandle]::Alloc((New-Object byte[] $size), [Runtime.InteropServices.GCHandleType]::Pinned); ` +
    `[Runtime.InteropServices.Marshal]::WriteInt32($lim.AddrOfPinnedObject(), 16, 0x2000); ` +
    `$configured = [PiReviewBgJobApi]::SetInformationJobObject($job, 9, $lim.AddrOfPinnedObject(), $size); $lim.Free(); if (-not $configured) { exit 1 }; ` +
    // Job-accounting query used to verify the job is EMPTY before release.
    `try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiReviewBgJobQuery { [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr b,uint n,IntPtr r); }' -ErrorAction Stop } catch { exit 1 }; ` +
    // Assign THIS shell (root pid substituted at runtime — never a bare parent
    // pid that could be ours) to the job. Existing children (the watchdog)
    // stay OUT of the job on purpose: it must survive its own termination path.
    `$rp = [PiReviewBgJobApi]::OpenProcess(0x1FFFFF, $false, __PI_ROOT__); if ($rp -eq [IntPtr]::Zero) { exit 1 }; ` +
    `if (-not [PiReviewBgJobApi]::AssignProcessToJobObject($job, $rp)) { exit 1 }; ` +
    `[void][PiReviewBgJobApi]::CloseHandle($rp); ` +
    // Handshake record: written only now that ownership is established.
    `try { Set-Content -LiteralPath $mk -Value "$PID running" } catch { exit 1 }; ` +
    `while ($true) { Start-Sleep -Seconds ${pollSeconds}; ` +
    // Heartbeat: the same record, refreshed mtime — readiness keys off the pid
    // and state, so a delayed heartbeat can never look like completion.
    `try { Set-Content -LiteralPath $mk -Value "$PID running" } catch {}; ` +
    // Explicit stop request (ShellStop / shutdown): terminate the whole job
    // through the job handle ONLY — never taskkill by pid: after the root
    // exits that pid may identify an unrelated process. The record stays
    // "running"; the watchdog's own death then proves completion via
    // kill-on-close (a dead watchdog cannot leave members alive).
    `if (Test-Path -LiteralPath $st) { [void][PiReviewBgJobApi]::TerminateJobObject($job, 1); exit 0 }; ` +
    // Host death: pid AND creation-time identity, so a reused pid cannot keep
    // the job alive. TerminateJobObject reaches descendants that outlived the
    // root — and again only through the job handle, never by (possibly reused)
    // pid.
    `$parentAlive = $false; try { $pp = [System.Diagnostics.Process]::GetProcessById(${parentPid}); if ($pp.StartTime.Ticks -eq __PI_TICKS__) { $parentAlive = $true }; $pp.Dispose() } catch {}; ` +
    `if (-not $parentAlive) { [void][PiReviewBgJobApi]::TerminateJobObject($job, 1); exit 0 }; ` +
    // Root exited: release only when the job is EMPTY — ActiveProcesses in
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1; offset 40, struct size
    // 48) counts live members. Live descendants keep the watchdog — and with
    // it the ownership, the record, and the host-death kill — alive until they
    // are gone. A failed query cannot prove emptiness: fail closed (the
    // watchdog's death then kills every member via kill-on-close).
    `$rootAlive = $false; try { $rt = [System.Diagnostics.Process]::GetProcessById(__PI_ROOT__); if ($rt.StartTime.Ticks -eq __PI_ROOT_TICKS__) { $rootAlive = $true }; $rt.Dispose() } catch {}; ` +
    `if (-not $rootAlive) { $accounting = [Runtime.InteropServices.Marshal]::AllocHGlobal(48); try { if (-not [PiReviewBgJobQuery]::QueryInformationJobObject($job, 1, $accounting, 48, [IntPtr]::Zero)) { exit 1 }; $active = [Runtime.InteropServices.Marshal]::ReadInt32($accounting, 40) } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($accounting) }; if ($active -eq 0) { try { Set-Content -LiteralPath $mk -Value "$PID released" -ErrorAction Stop } catch {}; exit 0 } } }`;
  return [
    POWERSHELL_UTF8_PREFIX,
    // Defined first so EVERY pre-command failure path can record it.
    `$__pi_review_marker = ${psLiteral(ownership.markerPath)}`,
    `function __pi_review_fail { try { Set-Content -LiteralPath $__pi_review_marker -Value '0 failed' } catch {}; exit 1 }`,
    // Establish the parent's creation-time identity BEFORE anything else runs;
    // without it the watchdog cannot tell the real host from a pid reuse, so
    // the job fails to start rather than running unwatched.
    `try { $__pi_review_parent_process = [System.Diagnostics.Process]::GetProcessById(${parentPid}) } catch { __pi_review_fail }`,
    `try { $__pi_review_parent_start = $__pi_review_parent_process.StartTime } catch { __pi_review_fail }`,
    `$__pi_review_self = (Get-Process -Id $PID).Path`,
    `if (-not $__pi_review_self) { __pi_review_fail }`,
    // This shell's own creation-time identity: the watchdog must not mistake a
    // reused pid for the root it owns.
    `try { $__pi_review_root_ticks = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.Ticks } catch { __pi_review_fail }`,
    `# Watchdog: same shell edition, hidden, isolated stdio (it must never hold the job's pipes open). It owns the job object for this whole tree.`,
    `$__pi_review_watchdog_command = @'`,
    watchdog,
    `'@`,
    // Root pid and both creation-time identities are substituted from runtime
    // values (numeric — no quoting needed). The per-job file paths need DOUBLE
    // quoting: the outer psLiteral quotes the argument to .Replace in THIS
    // script, and the inner one becomes part of the watchdog script text, so
    // `$mk = <path>` there stays a string assignment even for paths with
    // spaces or apostrophes.
    `$__pi_review_watchdog_command = $__pi_review_watchdog_command.Replace('__PI_TICKS__', [string]$__pi_review_parent_start.Ticks).Replace('__PI_ROOT__', [string]$PID).Replace('__PI_ROOT_TICKS__', [string]$__pi_review_root_ticks).Replace('__PI_MARKER__', ${psLiteral(psLiteral(ownership.markerPath))}).Replace('__PI_STOP__', ${psLiteral(psLiteral(ownership.stopPath))})`,
    `$__psi = New-Object System.Diagnostics.ProcessStartInfo`,
    `$__psi.FileName = $__pi_review_self`,
    `$__psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + ($__pi_review_watchdog_command -replace '"', '\\"') + '"'`,
    `$__psi.UseShellExecute = $false`,
    `$__psi.CreateNoWindow = $true`,
    `$__psi.RedirectStandardInput = $true`,
    `$__psi.RedirectStandardOutput = $true`,
    `$__psi.RedirectStandardError = $true`,
    `try { $__pi_review_watchdog = [System.Diagnostics.Process]::Start($__psi) } catch { __pi_review_fail }`,
    `if (-not $__pi_review_watchdog -or $__pi_review_watchdog.Id -le 0) { __pi_review_fail }`,
    // Verify the watchdog actually started: a healthy shell is still running
    // after this grace window; one that already exited gives no protection, so
    // fail closed before the user command runs.
    `if ($__pi_review_watchdog.WaitForExit(300)) { __pi_review_fail }`,
    `[void]$__pi_review_watchdog.BeginOutputReadLine()`,
    `[void]$__pi_review_watchdog.BeginErrorReadLine()`,
    // Ownership handshake: the record appears only AFTER the job object exists
    // and this shell is assigned to it. Without it, descendants would run
    // unprotected — fail closed before the user command runs. A watchdog that
    // exits first means the handshake cannot succeed: stop waiting immediately.
    `$__pi_review_ready = $false; $__pi_review_waited = 0`,
    `while (-not $__pi_review_ready -and $__pi_review_waited -lt ${readyTimeoutMs}) { if (Test-Path -LiteralPath $__pi_review_marker) { $__pi_review_ready = $true } elseif ($__pi_review_watchdog.HasExited) { break } else { Start-Sleep -Milliseconds 250; $__pi_review_waited += 250 } }`,
    `if (-not $__pi_review_ready) { Write-Output 'pi-review-gate: descendant ownership could not be established (the job-object watchdog did not confirm); the command was NOT run.' 1>&2; __pi_review_fail }`,
    // Strict handshake validation BEFORE any execution: a stop request that
    // arrived during startup aborts the job, and the record must be exactly
    // this watchdog's "<pid> running" — anything else (missing, failed,
    // terminal, or a dead watchdog) means ownership is not established, so
    // the command never runs.
    `if (Test-Path -LiteralPath ${psLiteral(ownership.stopPath)}) { exit 1 }`,
    `try { $__pi_review_record = (Get-Content -LiteralPath $__pi_review_marker -Raw -ErrorAction Stop).Trim() } catch { exit 1 }`,
    `if ($__pi_review_watchdog.HasExited -or $__pi_review_record -ne ([string]$__pi_review_watchdog.Id + ' running')) { exit 1 }`,
    // Child scope: ordinary variable assignments stay out of the wrapper's
    // state (an explicit `exit` still ends the whole shell, with that code).
    // The watchdog is deliberately NOT killed here: it keeps holding the job
    // object for descendants that outlive this shell and releases itself when
    // none remain.
    `& {`,
    command,
    `}`,
    // FIRST statement after the command block: any earlier statement would
    // overwrite `$?` and a failed cmdlet would look like success.
    `$__pi_review_ok = $?`,
    `$__pi_review_rc = $LASTEXITCODE`,
    `if ($null -eq $__pi_review_rc) { $__pi_review_rc = 0 }`,
    `if (-not $__pi_review_ok -and $__pi_review_rc -eq 0) { $__pi_review_rc = 1 }`,
    `exit $__pi_review_rc`,
  ].join("\n");
}

/** Bounded human summary of a job's wake rules, shared by the ShellStart
 *  result text and the expanded result views. Empty string when no rule is
 *  active; the model-facing text appends "nothing" itself. */
export function describeWakeRules(rules: WakeRules): string {
  return [
    rules.exit ? "exit" : null,
    rules.match.length > 0 ? `match ${rules.match.map((m) => JSON.stringify(m)).join(", ")}` : null,
    rules.silenceMs ? `silence ${formatElapsed(rules.silenceMs)}` : null,
    rules.everyNMatches ? `every ${rules.everyNMatches} matches` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export interface WakePayloadInput {
  id: string;
  label: string;
  command: string;
  event: WakeEvent;
  elapsedMs: number;
  exitCode?: number | null;
  lines: string[];
  totalLines: number;
}

/**
 * The bounded message the model receives. Deliberately NOT the whole log: a
 * progress bar can be a hundred thousand lines, and dumping it would destroy
 * the context window this project exists to conserve. Same principle as the
 * sub-coder report — the child's full transcript stays out, only a digest goes
 * in — and the model can always pull more with ShellLog if the digest warrants.
 */
export function formatWakePayload(p: WakePayloadInput): string {
  // Every display field and excerpt line is individually bounded, and the
  // whole payload has a total cap with a visible cut, so a wake can never
  // inject an unbounded blob into model context.
  const head = [
    `background job "${truncateText(p.label, MAX_LABEL_CHARS)}" (${p.id}) — ${p.event.reason}`,
    `command: ${truncateText(p.command, MAX_COMMAND_DISPLAY_CHARS)}`,
    `running: ${formatElapsed(p.elapsedMs)}${
      p.exitCode !== undefined && p.exitCode !== null ? ` · exit ${p.exitCode}` : ""
    }`,
  ];
  const boundedLines = p.lines.map((l) => truncateText(l, MAX_WAKE_EXCERPT_LINE_CHARS));
  const body = boundedLines.length > 0
    ? [`last ${boundedLines.length} of ${p.totalLines} lines:`, "```", ...boundedLines, "```"]
    : ["(no output)"];
  const tail =
    p.event.kind === "exit"
      ? []
      : [`ShellLog({"id":"${p.id}"}) for more. The job is still running.`];
  const out = [...head, "", ...body, ...tail].join("\n");
  return truncateText(out, MAX_WAKE_PAYLOAD_CHARS);
}
