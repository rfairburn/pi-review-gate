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
    // #452: the routine triggered lane steers at the next supported boundary.
    case "soon": return { deliverAs: "steer", triggerTurn: true };
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

/** Which watchdog the generated script runs: `ordinary` creates the job and
 *  assigns the shell root itself; `msix` adopts the job and the exact workload
 *  root handle the MSIX launcher already established (#800). */
type WatchdogRoute = "ordinary" | "msix";

/**
 * The watchdog script text (one line; see wrapWithPowerShellWatchdog for why).
 * The ordinary route is the long-standing script. The MSIX route differs in
 * exactly four places, all described inline: it adopts an inherited job handle
 * and an inherited SYNCHRONIZE handle to the exact workload root instead of
 * creating and assigning, it verifies that the adopted job really holds that
 * root with kill-on-close and no breakaway permission before it records
 * anything, it reads root liveness through that exact handle (no pid, no
 * creation-time lookup), and it writes every record atomically (temporary file
 * then replace) so no reader can observe a truncated record. Records on that
 * route carry the ` msix` route tag.
 */
function powerShellWatchdogScript(parentPid: number, pollSeconds: number, route: WatchdogRoute): string {
  const msix = route === "msix";
  const tag = msix ? " msix" : "";
  // Record writes. The ordinary route keeps its long-standing Set-Content
  // writes; the MSIX route replaces the record atomically.
  const record = (value: string): string =>
    msix ? `__pi_mark "${value}"` : `Set-Content -LiteralPath $mk -Value "${value}"`;
  const terminalRecord = (value: string): string =>
    msix ? `__pi_mark "${value}"` : `Set-Content -LiteralPath $mk -Value "${value}" -ErrorAction Stop`;
  return (
    `[Console]::SetOut([System.IO.StreamWriter]::Null); [Console]::SetError([System.IO.StreamWriter]::Null); ` +
    `$mk = __PI_MARKER__; $st = __PI_STOP__; ` +
    // kernel32 job-object surface, compiled in-process (Add-Type works on both
    // PowerShell editions; no external dependency). The class text stays ONE
    // line of C# 5 (Windows PowerShell 5.1 compiles it) inside a single-quoted
    // PowerShell string, so it carries no apostrophes and no __PI_ tokens.
    //
    // Root assignment is identity-guarded through ONE native handle (#705):
    // AssignOwnedRoot opens the root pid once, delegates to
    // AssignRootIfIdentity, and closes that handle in `finally` on every path.
    // AssignRootIfIdentity is the single guard: it reads the creation time
    // through the SAME handle (GetProcessTimes), converts it exactly as .NET
    // Process.StartTime does (DateTime.FromFileTime(...).Ticks — the format the
    // wrapper captured), and only on an exact match calls
    // AssignProcessToJobObject with that handle. A handle stays bound to the
    // process object it opened, so a pid reused between the wrapper's identity
    // capture and this open can never be adopted into the job: its creation
    // time differs and the guard refuses. An unreadable creation time, an
    // out-of-range value, or a zero handle also refuses — fail closed.
    `try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiReviewBgJobApi { ` +
    `[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a,String n); ` +
    `[DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l); ` +
    `[DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p); ` +
    `[DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j,uint e); ` +
    `[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a,bool b,int p); ` +
    `[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); ` +
    `[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long c,out long x,out long k,out long u); ` +
    `public static bool AssignRootIfIdentity(IntPtr j,IntPtr h,long t) { if (h == IntPtr.Zero) { return false; } long c; long x; long k; long u; if (!GetProcessTimes(h,out c,out x,out k,out u)) { return false; } long s; try { s = DateTime.FromFileTime(c).Ticks; } catch { return false; } if (s != t) { return false; } return AssignProcessToJobObject(j,h); } ` +
    `public static bool AssignOwnedRoot(IntPtr j,int pid,long t) { IntPtr h = OpenProcess(0x1FFFFF,false,pid); if (h == IntPtr.Zero) { return false; } try { return AssignRootIfIdentity(j,h,t); } finally { CloseHandle(h); } } ` +
    `}' } catch { exit 1 }; ` +
    (msix
      // MSIX route: the launcher created the job (kill-on-close, no breakaway),
      // created the workload root SUSPENDED with the desktop-app policy,
      // assigned that exact handle, and handed this watchdog inheritable
      // duplicates of the job handle and of a SYNCHRONIZE |
      // QUERY_LIMITED_INFORMATION handle to the root — the only handles it
      // inherits besides the null device (no Node pipe ever reaches it).
      // Before ANY record is written the adopted handles are verified: the
      // root must be a member of THIS job, and the job's limits must be
      // exactly kill-on-close without BREAKAWAY_OK (0x800) or
      // SILENT_BREAKAWAY_OK (0x1000). Anything else exits before the running
      // record, so the launcher never resumes the workload.
      ? `try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiReviewBgMsixWatch { ` +
        `[DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h,uint ms); ` +
        `[DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool m); ` +
        `[DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j,int c,byte[] b,uint n,IntPtr r); ` +
        `public static bool Owns(IntPtr j,IntPtr r) { if (j == IntPtr.Zero || r == IntPtr.Zero) { return false; } bool m; if (!IsProcessInJob(r,j,out m) || !m) { return false; } byte[] b = new byte[IntPtr.Size == 8 ? 144 : 112]; if (!QueryInformationJobObject(j,9,b,(uint)b.Length,IntPtr.Zero)) { return false; } return (BitConverter.ToUInt32(b,16) & 0x3800u) == 0x2000u; } ` +
        `public static int RootState(IntPtr r) { uint w = WaitForSingleObject(r,0); if (w == 0) { return 0; } if (w == 258) { return 1; } return -1; } ` +
        `}' -ErrorAction Stop } catch { exit 1 }; ` +
        `$job = [IntPtr][long]__PI_JOB__; $rh = [IntPtr][long]__PI_ROOT_HANDLE__; ` +
        `if (-not [PiReviewBgMsixWatch]::Owns($job, $rh)) { exit 1 }; ` +
        // Atomic record replacement: a reader sees the previous record or the
        // new one, never a truncated file. A failed write removes its own
        // temporary file and rethrows so each caller keeps its own policy.
        `function __pi_mark($v) { $t = $mk + '.' + $PID + '.part'; try { [System.IO.File]::WriteAllText($t, $v); [System.IO.File]::Move($t, $mk, $true) } catch { try { [System.IO.File]::Delete($t) } catch {}; throw } }; `
      // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000): when the last handle to the job
      // closes, the kernel terminates every member. The watchdog holds that only
      // handle, so a dead watchdog can never leave owned work behind.
      // LimitFlags sits at offset 16 of JOBOBJECT_BASIC_LIMIT_INFORMATION (after
      // the two LARGE_INTEGER time limits); it is set through
      // JobObjectExtendedLimitInformation (class 9), sized 144 bytes on 64-bit
      // and 112 on 32-bit. The rest of the zeroed buffer keeps every other limit
      // at its default, and NO breakaway flag is set: with both
      // JOB_OBJECT_LIMIT_BREAKAWAY_OK and SILENT_BREAKAWAY_OK absent, a process
      // in the job cannot create processes outside it — escape attempts fail.
      : `$job = [PiReviewBgJobApi]::CreateJobObjectW([IntPtr]::Zero, $null); if ($job -eq [IntPtr]::Zero) { exit 1 }; ` +
        `$size = 144; if ([IntPtr]::Size -eq 4) { $size = 112 }; ` +
        `$lim = [Runtime.InteropServices.GCHandle]::Alloc((New-Object byte[] $size), [Runtime.InteropServices.GCHandleType]::Pinned); ` +
        `[Runtime.InteropServices.Marshal]::WriteInt32($lim.AddrOfPinnedObject(), 16, 0x2000); ` +
        `$configured = [PiReviewBgJobApi]::SetInformationJobObject($job, 9, $lim.AddrOfPinnedObject(), $size); $lim.Free(); if (-not $configured) { exit 1 }; `) +
    // Job-accounting query used to verify the job is EMPTY before release.
    `try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiReviewBgJobQuery { [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr b,uint n,IntPtr r); }' -ErrorAction Stop } catch { exit 1 }; ` +
    // Bounded member accounting, shared by the release and stop paths:
    // ActiveProcesses in JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1;
    // offset 40, struct size 48) counts live members. __pi_active returns the
    // live member count or -1 when the query FAILS — -1 is never read as
    // empty, so a failed query can never release ownership. __pi_empty waits
    // up to the given milliseconds for the job to drain and reports whether
    // emptiness was actually observed: termination is asynchronous ("as if
    // TerminateProcess were called for each process"), so one sample cannot
    // prove the kernel finished. A timeout reports "not empty", never success.
    `function __pi_active() { $b = [Runtime.InteropServices.Marshal]::AllocHGlobal(48); try { if (-not [PiReviewBgJobQuery]::QueryInformationJobObject($job, 1, $b, 48, [IntPtr]::Zero)) { return -1 }; return [Runtime.InteropServices.Marshal]::ReadInt32($b, 40) } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($b) } }; ` +
    `function __pi_empty($ms) { $end = [DateTime]::UtcNow.AddMilliseconds($ms); while ($true) { $a = __pi_active; if ($a -eq 0) { return $true }; if ($a -lt 0) { return $false }; if ([DateTime]::UtcNow -ge $end) { return $false }; Start-Sleep -Milliseconds 100 } }; ` +
    // Assign THIS shell (root pid substituted at runtime — never a bare parent
    // pid that could be ours) to the job, guarded by the root's captured
    // creation-time identity through the same opened handle (#705). Existing
    // children (the watchdog) stay OUT of the job on purpose: it must survive
    // its own termination path. Fail-closed exception boundary: a refused
    // guard (false) and a thrown method call both leave $assigned false and
    // exit BEFORE the running record, so the wrapper never runs the command.
    // (MSIX route: the launcher already assigned the exact root, verified above.)
    (msix
      ? ""
      : `$assigned = $false; try { $assigned = [PiReviewBgJobApi]::AssignOwnedRoot($job, __PI_ROOT__, __PI_ROOT_TICKS__) } catch {}; if (-not $assigned) { exit 1 }; `) +
    // Handshake record: written only now that ownership is established.
    `try { ${record(`$PID running${tag}`)} } catch { exit 1 }; ` +
    // A stop that could not be verified sets $__pi_stopPending, and the latch
    // persists across polls (it is initialised once, before the loop): from
    // then on the stop is retried on every poll even if the stop file itself
    // disappears, and the ORDINARY release branch is skipped, so a later empty
    // job can never publish `released` (or exit through the query-failure
    // path) while an explicit stop is still unconfirmed.
    `$__pi_stopPending = $false; ` +
    `while ($true) { Start-Sleep -Seconds ${pollSeconds}; ` +
    // Heartbeat: the same record, refreshed mtime — readiness keys off the pid
    // and state, so a delayed heartbeat can never look like completion.
    `try { ${record(`$PID running${tag}`)} } catch {}; ` +
    // Explicit stop request (ShellStop / shutdown): terminate the whole job
    // through the job handle ONLY — never taskkill by pid: after the root
    // exits that pid may identify an unrelated process. BOTH the call's result
    // and the job's own accounting are checked before anything is claimed: the
    // "terminated" record is written, and this handle released, only once the
    // kernel reports the job EMPTY. A refused call or a still-populated job
    // keeps this watchdog alive — and with it the job and its kill-on-close
    // backstop — leaves the record "running" (honest: unconfirmed) and retries
    // on the next poll. Exiting on a request that was not verified would trade
    // a true termination for an assumed one.
    `if ($__pi_stopPending -or (Test-Path -LiteralPath $st)) { $__pi_stopPending = $true; $__pi_term = $false; try { $__pi_term = [PiReviewBgJobApi]::TerminateJobObject($job, 1) } catch {}; if ($__pi_term -and (__pi_empty 2000)) { try { ${terminalRecord(`$PID terminated${tag}`)} } catch {}; exit 0 } }; ` +
    // Host death: pid AND creation-time identity, so a reused pid cannot keep
    // the job alive. TerminateJobObject reaches descendants that outlived the
    // root — and again only through the job handle, never by (possibly reused)
    // pid.
    `$parentAlive = $false; try { $pp = [System.Diagnostics.Process]::GetProcessById(${parentPid}); if ($pp.StartTime.Ticks -eq __PI_TICKS__) { $parentAlive = $true }; $pp.Dispose() } catch {}; ` +
    `if (-not $parentAlive) { [void][PiReviewBgJobApi]::TerminateJobObject($job, 1); exit 0 }; ` +
    `if ($__pi_stopPending) { continue }; ` +
    // Root exited: release only when the job is EMPTY — ActiveProcesses in
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1; offset 40, struct size
    // 48) counts live members. Live descendants keep the watchdog — and with
    // it the ownership, the record, and the host-death kill — alive until they
    // are gone. A failed query cannot prove emptiness: fail closed (the
    // watchdog's death then kills every member via kill-on-close).
    // MSIX route: liveness comes from the exact inherited root handle; only a
    // signaled handle is "exited" — a failed wait is never read as exit.
    (msix
      ? `$rootAlive = ([PiReviewBgMsixWatch]::RootState($rh) -ne 0); `
      : `$rootAlive = $false; try { $rt = [System.Diagnostics.Process]::GetProcessById(__PI_ROOT__); if ($rt.StartTime.Ticks -eq __PI_ROOT_TICKS__) { $rootAlive = $true }; $rt.Dispose() } catch {}; `) +
    `if (-not $rootAlive) { $__pi_live = __pi_active; if ($__pi_live -lt 0) { exit 1 }; if ($__pi_live -eq 0) { try { ${terminalRecord(`$PID released${tag}`)} } catch {}; exit 0 } } }`
  );
}

/** The command and its status capture, shared verbatim by the ordinary
 *  wrapper and the MSIX workload so both map exit status identically. */
function commandStatusLines(command: string): string[] {
  return [
    // Child scope: the call operator runs the command in a CHILD scope —
    // ordinary variable assignments stay out of the wrapper's state (and an
    // explicit `exit` still ends the whole shell, with that code). The one
    // exception is the status holder below: an array is a reference object,
    // so element mutation from the child scope reaches the caller.
    `$__pi_review_status = @($null, $null)`,
    `& {`,
    command,
    // The block's LAST statements (nothing may run between the command and
    // them): capture the command's own success and native exit status from
    // INSIDE the child scope — one scope out, `$?` reflects the block
    // invocation's completion rather than the command's result, and plain
    // assignments would not survive the block's return at all. An explicit
    // `exit` in the command still ends the whole shell before these lines.
    `$__pi_review_status[0] = $?`,
    `$__pi_review_status[1] = $LASTEXITCODE`,
    `}`,
    // An early return skips the block-tail capture. Read invocation status
    // immediately, before any statement can overwrite it, and use that pair
    // only when the command did not reach its normal in-scope capture.
    `$__pi_review_invocation_ok = $?`,
    `if ($null -eq $__pi_review_status[0]) { $__pi_review_status[0] = $__pi_review_invocation_ok; $__pi_review_status[1] = $LASTEXITCODE }`,
    // Map the captured pair: a failed cmdlet (false success, no native status)
    // becomes 1; a native failure keeps its own code.
    `if ($null -eq $__pi_review_status[1]) { $__pi_review_status[1] = 0 }`,
    `if (-not $__pi_review_status[0] -and $__pi_review_status[1] -eq 0) { $__pi_review_status[1] = 1 }`,
    `exit $__pi_review_status[1]`,
  ];
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
 *   it with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (LimitFlags 0x2000, written at
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
 *   dead pipe can never block it). Its script text travels as an
 *   -EncodedCommand (base64 of UTF-16LE): the ONLY transport that cannot be
 *   mangled by command-line quote/backslash re-interpretation — a raw script
 *   in a -Command argument must be C-style escaped, and any escape slip lets
 *   the host's argument splitter end the string early (a `"` sequence read as
 *   end-of-string truncates the watchdog at its first quote). Encoded form is
 *   byte-exact on both editions (the flag exists since PowerShell 3.0). It
 *   runs plain PowerShell, identically on PowerShell 7 and Windows PowerShell
 *   5.1 — no threads, no cross-thread runspace dependence.
 * - Identity is creation-time, not just a pid: before anything else the wrapper
 *   records the parent's AND its own StartTime ticks and fails closed (exit 1,
 *   command never runs) when it cannot; the watchdog then treats the parent as
 *   gone unless the pid exists AND its creation time still matches, so a reused
 *   pid cannot keep the job alive. The same root identity also guards the
 *   initial job assignment: the watchdog opens the root pid ONCE, reads that
 *   handle's creation time, and assigns exactly that handle only when it
 *   matches the captured ticks (closing the handle on every path), so a pid
 *   reused before the watchdog runs can never be adopted into the job — a
 *   mismatch or unreadable identity aborts before the running record.
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
 * evidence (which must stay blocking, not clear), and writes a bounded,
 * stage-named diagnostic to stderr so ShellLog shows WHY the job aborted
 * instead of a bare exit 1. Diagnostics use [Console]::Error.WriteLine rather
 * than stream redirection: PowerShell reserves `1>&2` ("The '1>&2' operator is
 * reserved for future use") — only OTHER streams may be redirected onto the
 * success stream, so redirecting output to stderr that way is a parse error
 * that kills the whole wrapper before any line of it runs.
 *
 * Exit status is preserved: the command runs in a child scope (`& { ... }`),
 * and its own `$?` / `$LASTEXITCODE` are captured as the block's last
 * statements, pushed into a wrapper-owned array — a reference object, so
 * element mutation crosses the scope boundary while plain variable
 * assignments would not. (One scope out, `$?` reflects the block invocation's
 * completion, so capturing there would read a failed cmdlet (non-terminating
 * error) as success.) The captured pair then maps: a failed cmdlet (false
 * success, no native status) becomes 1,
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
  // watchdog script uses only single-quoted strings so its runtime substitution
  // stays plain string replacement; the finished script travels to the watchdog
  // as an -EncodedCommand (base64 of UTF-16LE), which is byte-exact on both
  // editions and needs no command-line quote/backslash escaping at all. Per-job
  // file paths are substituted into the watchdog command at RUNTIME (.Replace),
  // never embedded in the here-string text, so a hostile path cannot terminate
  // the here-string.
  const watchdog = powerShellWatchdogScript(parentPid, pollSeconds, "ordinary");
  return [
    POWERSHELL_UTF8_PREFIX,
    // Defined first so EVERY pre-command failure path can record it.
    `$__pi_review_marker = ${psLiteral(ownership.markerPath)}`,
    // The fail helper records '0 failed' (so readiness can distinguish "nothing
    // ran" from lost evidence), names the failing stage on stderr so ShellLog
    // is actionable instead of a bare exit 1, and aborts before any execution.
    `function __pi_review_fail($stage) { try { Set-Content -LiteralPath $__pi_review_marker -Value '0 failed' } catch {}; try { [Console]::Error.WriteLine("pi-review-gate: ShellStart aborted before running the command (stage '$stage'); nothing ran under ownership.") } catch {}; exit 1 }`,
    // Establish the parent's creation-time identity BEFORE anything else runs;
    // without it the watchdog cannot tell the real host from a pid reuse, so
    // the job fails to start rather than running unwatched.
    `try { $__pi_review_parent_process = [System.Diagnostics.Process]::GetProcessById(${parentPid}) } catch { __pi_review_fail 'parent-identity' }`,
    `try { $__pi_review_parent_start = $__pi_review_parent_process.StartTime } catch { __pi_review_fail 'parent-identity' }`,
    `$__pi_review_self = (Get-Process -Id $PID).Path`,
    `if (-not $__pi_review_self) { __pi_review_fail 'self-path' }`,
    // This shell's own creation-time identity: the watchdog must not mistake a
    // reused pid for the root it owns.
    `try { $__pi_review_root_ticks = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.Ticks } catch { __pi_review_fail 'root-identity' }`,
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
    // The watchdog script travels as an -EncodedCommand (base64 of UTF-16LE):
    // byte-exact on both editions, and immune to command-line quote/backslash
    // re-interpretation — a raw script in a -Command argument must be C-style
    // escaped, and an even run of backslashes before a quote makes the host's
    // argument splitter end the string there (the old inline escape produced
    // exactly that at the Add-Type block's first quote).
    `$__psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($__pi_review_watchdog_command))`,
    `$__psi.UseShellExecute = $false`,
    `$__psi.CreateNoWindow = $true`,
    `$__psi.RedirectStandardInput = $true`,
    `$__psi.RedirectStandardOutput = $true`,
    `$__psi.RedirectStandardError = $true`,
    `try { $__pi_review_watchdog = [System.Diagnostics.Process]::Start($__psi) } catch { __pi_review_fail 'watchdog-spawn' }`,
    `if (-not $__pi_review_watchdog -or $__pi_review_watchdog.Id -le 0) { __pi_review_fail 'watchdog-alive' }`,
    // Verify the watchdog actually started: a healthy shell is still running
    // after this grace window; one that already exited gives no protection, so
    // fail closed before the user command runs.
    `if ($__pi_review_watchdog.WaitForExit(300)) { __pi_review_fail 'watchdog-alive' }`,
    `[void]$__pi_review_watchdog.BeginOutputReadLine()`,
    `[void]$__pi_review_watchdog.BeginErrorReadLine()`,
    // Ownership handshake: the record appears only AFTER the job object exists
    // and this shell is assigned to it. Without it, descendants would run
    // unprotected — fail closed before the user command runs. A watchdog that
    // exits first means the handshake cannot succeed: stop waiting immediately.
    `$__pi_review_ready = $false; $__pi_review_waited = 0`,
    `while (-not $__pi_review_ready -and $__pi_review_waited -lt ${readyTimeoutMs}) { if (Test-Path -LiteralPath $__pi_review_marker) { $__pi_review_ready = $true } elseif ($__pi_review_watchdog.HasExited) { break } else { Start-Sleep -Milliseconds 250; $__pi_review_waited += 250 } }`,
    // stderr, not stream redirection: `1>&2` is a PowerShell parse error
    // ("reserved for future use") that would kill this whole script at parse
    // time — before any line of it runs and before any marker exists.
    `if (-not $__pi_review_ready) { try { [Console]::Error.WriteLine('pi-review-gate: descendant ownership could not be established (the job-object watchdog did not confirm); the command was NOT run.') } catch {}; __pi_review_fail 'ownership-handshake' }`,
    // Strict handshake validation BEFORE any execution: a stop request that
    // arrived during startup aborts the job, and the record must be exactly
    // this watchdog's "<pid> running" — anything else (missing, failed,
    // terminal, or a dead watchdog) means ownership is not established, so
    // the command never runs.
    // Strict validation failures are also "nothing ran" paths: record it and
    // say why. (If the watchdog already died, kill-on-close may have taken this
    // shell with the job — the writes are best-effort, the exit is not.)
    `if (Test-Path -LiteralPath ${psLiteral(ownership.stopPath)}) { __pi_review_fail 'stop-during-startup' }`,
    `try { $__pi_review_record = (Get-Content -LiteralPath $__pi_review_marker -Raw -ErrorAction Stop).Trim() } catch { __pi_review_fail 'record-unreadable' }`,
    `if ($__pi_review_watchdog.HasExited -or $__pi_review_record -ne ([string]$__pi_review_watchdog.Id + ' running')) { __pi_review_fail 'record-mismatch' }`,
    // The watchdog is deliberately NOT killed after the command: it keeps
    // holding the job object for descendants that outlive this shell and
    // releases itself when none remain.
    ...commandStatusLines(command),
  ].join("\n");
}

/** Per-job environment variable that carries the MSIX workload script from
 *  Node to the launcher and from the launcher to the suspended workload. Both
 *  remove it before anything else runs, so neither the watchdog nor the user
 *  command (nor anything it starts) ever sees it. */
export function msixWorkloadVariableName(token: string): string {
  return `PI_REVIEW_BG_WORKLOAD_${token}`;
}

/**
 * The script the MSIX workload root runs: the same UTF-8 prefix, child-scope
 * command, and exit-status mapping as the ordinary wrapper — only without any
 * ownership code, because the launcher and watchdog established ownership
 * before this process was ever resumed.
 */
export function msixWorkloadScript(command: string): string {
  return [POWERSHELL_UTF8_PREFIX, ...commandStatusLines(command)].join("\n");
}

/**
 * Inline launcher for the Store/MSIX PowerShell 7 workload (#800). One line of
 * C# compiled by Add-Type inside the MSIX `pwsh.exe` that Node spawned (the
 * same executable; no packaged helper binary). Nothing in it is ever applied
 * to an ordinary PowerShell: Identify() requires this process to have a
 * package identity, and the workload must report the SAME package full name
 * and image before it is resumed.
 *
 * Prepare(): fresh job with exactly KILL_ON_JOB_CLOSE (no breakaway), then
 * CreateProcessW of this package's own image with STARTUPINFOEX carrying
 * PROC_THREAD_ATTRIBUTE_HANDLE_LIST (0x20002: inheritable duplicates of this
 * process's three standard handles — Node's pipes — and nothing else) and
 * PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY (0x20012) =
 * PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE (2), created
 * CREATE_SUSPENDED | CREATE_NO_WINDOW (a background job never gets a visible
 * console of its own; its stdio stays Node's pipes); the exact returned handle
 * is assigned to the job and its membership read back through the same handle. PROC_THREAD_ATTRIBUTE_JOB_LIST
 * is deliberately NOT used: it is refused for this package. Environment and
 * working directory are inherited unchanged.
 *
 * PrepareWatchdogHandles()/StartWatchdog(): the watchdog inherits ONLY an
 * inheritable duplicate of the job handle, a SYNCHRONIZE |
 * QUERY_LIMITED_INFORMATION duplicate of the exact root handle, and the null
 * device as its standard handles (HANDLE_LIST again), so it can never hold a
 * Node pipe open. Resume(): the watchdog must still be alive; the launcher
 * closes its own job handle (the watchdog becomes the sole holder, so
 * kill-on-close is its backstop) and resumes the root. Abort(): before
 * resume only — terminate the exact suspended root through its own handle,
 * wait a bounded time, and report whether it was observed gone. It never
 * resumes anything and never targets a pid.
 */
const MSIX_LAUNCHER_CLASS =
  "using System; using System.Runtime.InteropServices; using System.Text; " +
  "public sealed class PiReviewMsixLaunch { " +
  "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int cb; public IntPtr reserved; public IntPtr desktop; public IntPtr title; public int x; public int y; public int xSize; public int ySize; public int xChars; public int yChars; public int fill; public int flags; public short show; public short reserved2; public IntPtr reserved3; public IntPtr stdInput; public IntPtr stdOutput; public IntPtr stdError; } " +
  "[StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; } " +
  "[StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process; public IntPtr thread; public int pid; public int tid; } " +
  "[DllImport(\"kernel32.dll\")] static extern IntPtr GetCurrentProcess(); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern IntPtr GetStdHandle(int which); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool SetStdHandle(int which, IntPtr handle); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool CloseHandle(IntPtr handle); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned); " +
  "[DllImport(\"kernel32.dll\")] static extern void DeleteProcThreadAttributeList(IntPtr list); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo info); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security, string name); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, byte[] info, int length); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern uint ResumeThread(IntPtr thread); " +
  "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name); " +
  "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint length); " +
  "IntPtr job; IntPtr root; IntPtr rootThread; IntPtr watchdog; IntPtr inheritJob; IntPtr inheritRoot; IntPtr nul; bool resumed; " +
  "public string Stage = \"\"; public int LastError; public string Package; public string Image; public int RootPid; public int WatchdogPid; public long JobForWatchdog; public long RootForWatchdog; " +
  "bool Fail(string stage) { LastError = Marshal.GetLastWin32Error(); Stage = stage; return false; } " +
  "static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } } " +
  "static string PackageOf(IntPtr process) { uint length = 0; int result = process == IntPtr.Zero ? GetCurrentPackageFullName(ref length, null) : GetPackageFullName(process, ref length, null); if (result != 122 || length == 0 || length > 4096) { return null; } StringBuilder name = new StringBuilder((int)length); result = process == IntPtr.Zero ? GetCurrentPackageFullName(ref length, name) : GetPackageFullName(process, ref length, name); return result == 0 && name.Length > 0 ? name.ToString() : null; } " +
  "static string ImageOf(IntPtr process) { StringBuilder name = new StringBuilder(32768); uint length = (uint)name.Capacity; return QueryFullProcessImageNameW(process, 0, name, ref length) && length > 0 ? name.ToString(0, (int)length) : null; } " +
  "public bool Identify() { Package = PackageOf(IntPtr.Zero); if (Package == null) { return Fail(\"package-identity\"); } Image = ImageOf(GetCurrentProcess()); if (Image == null) { return Fail(\"self-image\"); } return true; } " +
  "bool Launch(string arguments, IntPtr[] inherited, IntPtr[] std, bool desktopPolicy, uint flags, string stage, out ProcessInfo info) { info = new ProcessInfo(); IntPtr list = IntPtr.Zero; IntPtr handles = IntPtr.Zero; IntPtr policy = IntPtr.Zero; bool initialized = false; int count = desktopPolicy ? 2 : 1; " +
  "try { IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size); if (size == IntPtr.Zero) { return Fail(\"attribute-list\"); } list = Marshal.AllocHGlobal(size); if (!InitializeProcThreadAttributeList(list, count, 0, ref size)) { return Fail(\"attribute-list\"); } initialized = true; " +
  "handles = Marshal.AllocHGlobal(inherited.Length * IntPtr.Size); for (int i = 0; i < inherited.Length; i++) { Marshal.WriteIntPtr(handles, i * IntPtr.Size, inherited[i]); } " +
  "if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20002, handles, (IntPtr)(inherited.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) { return Fail(\"handle-list\"); } " +
  "if (desktopPolicy) { policy = Marshal.AllocHGlobal(4); Marshal.WriteInt32(policy, 2); if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20012, policy, (IntPtr)4, IntPtr.Zero, IntPtr.Zero)) { return Fail(\"desktop-app-policy\"); } } " +
  "StartupInfoEx startup = new StartupInfoEx(); startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx)); startup.info.flags = 0x100; startup.info.stdInput = std[0]; startup.info.stdOutput = std[1]; startup.info.stdError = std[2]; startup.attributes = list; " +
  "if (!CreateProcessW(Image, new StringBuilder(\"\\\"\" + Image + \"\\\" \" + arguments), IntPtr.Zero, IntPtr.Zero, true, flags | 0x00080000, IntPtr.Zero, null, ref startup, out info)) { return Fail(stage); } return true; " +
  "} finally { if (initialized) { DeleteProcThreadAttributeList(list); } if (list != IntPtr.Zero) { Marshal.FreeHGlobal(list); } if (handles != IntPtr.Zero) { Marshal.FreeHGlobal(handles); } if (policy != IntPtr.Zero) { Marshal.FreeHGlobal(policy); } } } " +
  "public bool Prepare(string arguments) { job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) { return Fail(\"job-create\"); } byte[] limits = new byte[IntPtr.Size == 8 ? 144 : 112]; BitConverter.GetBytes(0x2000).CopyTo(limits, 16); if (!SetInformationJobObject(job, 9, limits, limits.Length)) { return Fail(\"job-limit\"); } " +
  "IntPtr self = GetCurrentProcess(); IntPtr[] std = new IntPtr[3]; " +
  "try { for (int i = 0; i < 3; i++) { IntPtr handle = GetStdHandle(-10 - i); if (handle == IntPtr.Zero || handle == new IntPtr(-1)) { return Fail(\"stdio-missing\"); } if (!DuplicateHandle(self, handle, self, out std[i], 0, true, 2)) { return Fail(\"stdio-duplicate\"); } } " +
  "ProcessInfo info; if (!Launch(arguments, std, std, true, 0x08000004, \"workload-create\", out info)) { return false; } root = info.process; rootThread = info.thread; RootPid = info.pid; " +
  "} finally { for (int i = 0; i < 3; i++) { Close(ref std[i]); } } " +
  "if (!AssignProcessToJobObject(job, root)) { return Fail(\"workload-assign\"); } bool member; if (!IsProcessInJob(root, job, out member) || !member) { return Fail(\"workload-membership\"); } " +
  "string rootPackage = PackageOf(root); string rootImage = ImageOf(root); if (rootPackage == null || rootImage == null || !String.Equals(rootPackage, Package, StringComparison.Ordinal) || !String.Equals(rootImage, Image, StringComparison.OrdinalIgnoreCase)) { return Fail(\"workload-identity\"); } return true; } " +
  "public bool PrepareWatchdogHandles() { IntPtr self = GetCurrentProcess(); if (!DuplicateHandle(self, job, self, out inheritJob, 0, true, 2)) { return Fail(\"watchdog-job-handle\"); } if (!DuplicateHandle(self, root, self, out inheritRoot, 0x00101000, true, 0)) { return Fail(\"watchdog-root-handle\"); } " +
  "IntPtr device = CreateFileW(\"NUL\", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); if (device == new IntPtr(-1) || device == IntPtr.Zero) { return Fail(\"watchdog-null-device\"); } bool duplicated = DuplicateHandle(self, device, self, out nul, 0, true, 2); int error = Marshal.GetLastWin32Error(); CloseHandle(device); if (!duplicated) { LastError = error; Stage = \"watchdog-null-device\"; return false; } " +
  "JobForWatchdog = inheritJob.ToInt64(); RootForWatchdog = inheritRoot.ToInt64(); return true; } " +
  "public bool StartWatchdog(string arguments) { try { ProcessInfo info; if (!Launch(arguments, new IntPtr[] { inheritJob, inheritRoot, nul }, new IntPtr[] { nul, nul, nul }, false, 0x08000000, \"watchdog-spawn\", out info)) { return false; } watchdog = info.process; WatchdogPid = info.pid; CloseHandle(info.thread); return true; } finally { Close(ref inheritJob); Close(ref inheritRoot); Close(ref nul); } } " +
  "public bool ReleaseLauncherInput() { IntPtr input = GetStdHandle(-10); if (input == IntPtr.Zero || input == new IntPtr(-1) || !SetStdHandle(-10, IntPtr.Zero) || !CloseHandle(input)) { return Fail(\"launcher-stdin-release\"); } return true; } " +
  "public bool WatchdogAlive() { return watchdog != IntPtr.Zero && WaitForSingleObject(watchdog, 0) == 258; } " +
  "public bool Resume() { if (!WatchdogAlive()) { return Fail(\"watchdog-alive\"); } Close(ref job); if (ResumeThread(rootThread) != 1) { return Fail(\"workload-resume\"); } resumed = true; Close(ref rootThread); return true; } " +
  "public int WaitRoot() { WaitForSingleObject(root, 0xFFFFFFFF); uint code; if (!GetExitCodeProcess(root, out code)) { return 1; } return unchecked((int)code); } " +
  "public bool Abort() { if (resumed) { return false; } bool gone = true; if (root != IntPtr.Zero) { if (WaitForSingleObject(root, 0) != 0) { TerminateProcess(root, 1); } gone = WaitForSingleObject(root, 5000) == 0; } Close(ref job); if (!gone) { gone = WaitForSingleObject(root, 2000) == 0; } if (watchdog != IntPtr.Zero) { if (WaitForSingleObject(watchdog, 0) != 0) { TerminateProcess(watchdog, 1); } if (WaitForSingleObject(watchdog, 5000) != 0) { gone = false; } } Close(ref rootThread); Close(ref inheritJob); Close(ref inheritRoot); Close(ref nul); return gone; } " +
  "}";

/**
 * Wrap a background job for the Store/MSIX PowerShell 7 route (#800).
 *
 * The process Node spawns runs THIS launcher, not the command. The launcher
 * stays the Node-facing root: it exits only when the actual workload root
 * exits, with that root's exit status, and it writes nothing to stdout. The
 * command itself (msixWorkloadScript) arrives in the per-job environment
 * variable `ownership.workloadVariable`, so no user text is part of this
 * script.
 *
 * Fail-closed startup, in order — every failure aborts with exit 1, records
 * `0 failed` only when nothing can still run, names the stage on stderr, and
 * is NEVER followed by an uncontained retry on this or any other shell:
 *
 * 1. parent creation-time identity (as on the ordinary route);
 * 2. the workload text is present;
 * 3. launcher interop compiles and THIS process has a package identity (the
 *    desktop-app policy is applied only to an identified MSIX PowerShell);
 * 4. no stop request is pending;
 * 5. job + suspended policy-launched workload + exact-handle assignment +
 *    membership + same package and image (PiReviewMsixLaunch.Prepare);
 * 6. the independent per-job watchdog starts with only the job, root, and
 *    null-device handles and writes `<pid> running msix` — only after it
 *    re-verified membership and kill-on-close through the inherited handles;
 * 7. a stop request that arrived meanwhile, an unreadable record, a record
 *    that is not exactly that watchdog's, or a dead watchdog all abort;
 * 8. resume — the only point where user code can start.
 *
 * Before step 8 an abort terminates the suspended workload through its exact
 * handle and never resumes it, then ends the already-started watchdog through
 * ITS exact handle (both bounded waits), so `0 failed` and any watchdog record
 * are mutually exclusive: `failed` is written only once neither can still
 * run or write the record, and the watchdog's own temporary record file is
 * removed. If either cannot be confirmed gone the `0 failed` record is
 * withheld, so missing evidence stays unverifiable. Records are written
 * atomically. After the workload exits, the launcher exits with the workload's
 * OWN status; ownership confirmation is separate — it comes only from the
 * watchdog's terminal record, which the host reads (ownershipVerdict). A
 * watchdog that has already gone without one is reported on stderr, and the
 * host keeps the job unverifiable rather than complete.
 */
export function wrapWithMsixPowerShellLauncher(
  parentPid: number,
  pollSeconds: number,
  ownership: { markerPath: string; stopPath: string; workloadVariable: string },
  readyTimeoutMs = 30_000,
): string {
  const watchdog = powerShellWatchdogScript(parentPid, pollSeconds, "msix");
  const variable = psLiteral(ownership.workloadVariable);
  // The workload's own first statements: read the command text from the
  // per-job variable and remove it from the process environment before the
  // command (or anything it starts) can observe it. Dot-sourcing keeps the
  // command's scope layout identical to the ordinary wrapper.
  const bootstrap =
    `$__pi_review_workload = [Environment]::GetEnvironmentVariable(${variable}); ` +
    `[Environment]::SetEnvironmentVariable(${variable}, $null); ` +
    `if ([string]::IsNullOrEmpty($__pi_review_workload)) { [Console]::Error.WriteLine('pi-review-gate: the Store PowerShell workload received no command text; nothing ran.'); exit 1 }; ` +
    `. ([scriptblock]::Create($__pi_review_workload))`;
  const encodedBootstrap = Buffer.from(bootstrap, "utf16le").toString("base64");
  return [
    POWERSHELL_UTF8_PREFIX,
    `$__pi_review_marker = ${psLiteral(ownership.markerPath)}`,
    `$__pi_review_launch = $null`,
    // Atomic record replacement (temporary file, then replace): no reader can
    // observe a truncated record on this route.
    `function __pi_review_record($value) { $t = $__pi_review_marker + '.' + $PID + '.part'; try { [System.IO.File]::WriteAllText($t, $value); [System.IO.File]::Move($t, $__pi_review_marker, $true); return $true } catch { try { [System.IO.File]::Delete($t) } catch {}; return $false } }`,
    `function __pi_review_fail($stage, $code = 0) { $settled = $true; if ($null -ne $__pi_review_launch) { try { $settled = $__pi_review_launch.Abort() } catch { $settled = $false } }; if ($settled) { if ($null -ne $__pi_review_launch -and $__pi_review_launch.WatchdogPid -gt 0) { try { [System.IO.File]::Delete($__pi_review_marker + '.' + $__pi_review_launch.WatchdogPid + '.part') } catch {} }; [void](__pi_review_record '0 failed') }; $note = ''; if ($code -ne 0) { $note = " (Windows error $code)" }; if (-not $settled) { $note = $note + ' The suspended workload and its job-object owner could not both be confirmed terminated, so no completion was recorded.' }; try { [Console]::Error.WriteLine("pi-review-gate: ShellStart aborted before running the command (stage '$stage')$note; nothing ran under ownership. Store PowerShell route: the command is never run without its job object and is not retried on another shell.") } catch {}; exit 1 }`,
    `try { $__pi_review_parent_process = [System.Diagnostics.Process]::GetProcessById(${parentPid}) } catch { __pi_review_fail 'parent-identity' }`,
    `try { $__pi_review_parent_start = $__pi_review_parent_process.StartTime } catch { __pi_review_fail 'parent-identity' }`,
    `if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable(${variable}))) { __pi_review_fail 'workload-text' }`,
    `try { Add-Type -TypeDefinition '${MSIX_LAUNCHER_CLASS}' -ErrorAction Stop } catch { __pi_review_fail 'launcher-interop' }`,
    `$__pi_review_identity = New-Object PiReviewMsixLaunch`,
    `if (-not $__pi_review_identity.Identify()) { __pi_review_fail $__pi_review_identity.Stage }`,
    `if (Test-Path -LiteralPath ${psLiteral(ownership.stopPath)}) { __pi_review_fail 'stop-during-startup' }`,
    `$__pi_review_launch = $__pi_review_identity`,
    `if (-not $__pi_review_launch.Prepare('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedBootstrap}')) { __pi_review_fail $__pi_review_launch.Stage $__pi_review_launch.LastError }`,
    // The workload now holds its own copy of the job's stdin; the launcher
    // never reads it. Release the launcher's original stdin handle so the
    // workload is the ONLY reader: when the workload closes its input, a
    // ShellSend fails as it does on the ordinary route, instead of flushing
    // into a pipe nobody reads. Stdout/stderr stay (launcher diagnostics).
    `if (-not $__pi_review_launch.ReleaseLauncherInput()) { __pi_review_fail $__pi_review_launch.Stage $__pi_review_launch.LastError }`,
    // The workload's environment block was copied at creation; the watchdog
    // created next must not inherit the command text.
    `[Environment]::SetEnvironmentVariable(${variable}, $null)`,
    `if (-not $__pi_review_launch.PrepareWatchdogHandles()) { __pi_review_fail $__pi_review_launch.Stage $__pi_review_launch.LastError }`,
    `$__pi_review_watchdog_command = @'`,
    watchdog,
    `'@`,
    `$__pi_review_watchdog_command = $__pi_review_watchdog_command.Replace('__PI_TICKS__', [string]$__pi_review_parent_start.Ticks).Replace('__PI_JOB__', [string]$__pi_review_launch.JobForWatchdog).Replace('__PI_ROOT_HANDLE__', [string]$__pi_review_launch.RootForWatchdog).Replace('__PI_MARKER__', ${psLiteral(psLiteral(ownership.markerPath))}).Replace('__PI_STOP__', ${psLiteral(psLiteral(ownership.stopPath))})`,
    `if (-not $__pi_review_launch.StartWatchdog('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($__pi_review_watchdog_command)))) { __pi_review_fail $__pi_review_launch.Stage $__pi_review_launch.LastError }`,
    `$__pi_review_ready = $false; $__pi_review_waited = 0`,
    `while (-not $__pi_review_ready -and $__pi_review_waited -lt ${readyTimeoutMs}) { if (Test-Path -LiteralPath $__pi_review_marker) { $__pi_review_ready = $true } elseif (-not $__pi_review_launch.WatchdogAlive()) { break } else { Start-Sleep -Milliseconds 250; $__pi_review_waited += 250 } }`,
    `if (-not $__pi_review_ready) { __pi_review_fail 'ownership-handshake' }`,
    `if (Test-Path -LiteralPath ${psLiteral(ownership.stopPath)}) { __pi_review_fail 'stop-during-startup' }`,
    `try { $__pi_review_record = [System.IO.File]::ReadAllText($__pi_review_marker).Trim() } catch { __pi_review_fail 'record-unreadable' }`,
    `if (-not $__pi_review_launch.WatchdogAlive() -or $__pi_review_record -ne ([string]$__pi_review_launch.WatchdogPid + ' running msix')) { __pi_review_fail 'record-mismatch' }`,
    `if (-not $__pi_review_launch.Resume()) { __pi_review_fail $__pi_review_launch.Stage $__pi_review_launch.LastError }`,
    // From here on the workload runs; the launcher only mirrors its exit.
    `$__pi_review_code = $__pi_review_launch.WaitRoot()`,
    `if (-not $__pi_review_launch.WatchdogAlive()) { $__pi_review_ack = ''; try { $__pi_review_ack = [System.IO.File]::ReadAllText($__pi_review_marker).Trim() } catch {}; if ($__pi_review_ack -ne ([string]$__pi_review_launch.WatchdogPid + ' released msix') -and $__pi_review_ack -ne ([string]$__pi_review_launch.WatchdogPid + ' terminated msix')) { try { [Console]::Error.WriteLine('pi-review-gate: the job-object owner exited before acknowledging this Store PowerShell job; its processes are not confirmed gone. The reported exit status is the workload''s own.') } catch {} } }`,
    `exit $__pi_review_code`,
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
