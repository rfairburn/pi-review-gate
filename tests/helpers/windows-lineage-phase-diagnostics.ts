/**
 * Test-only bounded phase diagnostics for the native Windows lineage proof
 * (Refs #446).
 *
 * Diagnosis only. One required Windows run reported `query-timeout` for the
 * genuine-descendant proof, and the existing evidence cannot say WHERE those
 * five seconds went. This helper observes the same single bounded query child
 * from outside the production module — through the existing `execute` test seam,
 * delegating to the real native `execFile` with the production executable,
 * arguments, and options — and prints one fixed-vocabulary line of integer
 * elapsed times. The parent side sees the child's own `spawn` notification, first
 * stdout, first stderr, `exit`, `close`, and the executor callback; the script side
 * is observed by fixed marker lines written to STDERR only, around the two bounded
 * CIM phases and the parent-walk entry, so stdout keeps carrying exactly the proof
 * bytes.
 *
 * Nothing here can change a proof decision: the wrapper forwards the callback
 * arguments verbatim, never adds a retry, never touches the deadline, and prints
 * a fixed `delegation=` status that says whether what it received was still the
 * production query shape. It never takes or prints stdout, stderr, error text,
 * commands, scripts, PIDs, paths, or host inventory — only allowlisted phase
 * names and bounded integers, in one canonical record, so it can never route
 * private content into a CI log.
 *
 * A phase observation is a parent-side timestamp of when THIS process noticed
 * something. Stream delivery latency, scheduler pauses, and the extra stderr
 * writes themselves perturb these values, so they locate a delay boundary for
 * further investigation and never by themselves establish a root cause.
 */
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  MAX_QUERY_OUTPUT_BYTES,
  isWindowsLineageRefusalReason,
  type WindowsLineageQueryChild,
  type WindowsLineageQueryExecutor,
  type WindowsLineageQueryOptions,
  type WindowsLineageVerification,
} from "../../src/execution/windows-process-lineage";

/** The only text a script-side marker line may carry after this prefix. */
export const WINDOWS_LINEAGE_PHASE_MARKER_PREFIX = "PRG-LINEAGE-PHASE:";

/**
 * The complete closed vocabulary. `child-spawn`, `stdout-first`, `stderr-first`,
 * `child-exit`, `child-close`, and `query-callback` are observed by this helper
 * (`child-spawn` only from the child's own `spawn` event, never from the executor
 * returning a child object, so a spawn failure can never be reported as a spawn);
 * the rest come from stderr markers inside the script. Order is the canonical
 * print order: process creation, PowerShell entry, the bounded CIM phases, then
 * settlement.
 */
export const WINDOWS_LINEAGE_PHASES = [
  "child-spawn",
  "script-entry",
  "initial-query-start",
  "initial-query-end",
  "walk-start",
  "ancestor-lookup",
  "snapshot-start",
  "snapshot-end",
  "evidence-written",
  "walk-depth-limit",
  "stdout-first",
  "stderr-first",
  "child-exit",
  "child-close",
  "query-callback",
] as const;

export type WindowsLineagePhase = (typeof WINDOWS_LINEAGE_PHASES)[number];

/** Total cap on one printed diagnostic line. */
export const WINDOWS_LINEAGE_DIAGNOSTIC_MAX_CHARS = 1_200;

/** Repeated observations of one phase aggregate into one canonical record. */
const MAX_PHASE_COUNT = 999;
const MAX_UNRECOGNIZED_COUNT = 999;
/** The child's own per-stream bound is the most stderr this helper will ever scan. */
const MAX_MARKER_SCAN_BYTES = MAX_QUERY_OUTPUT_BYTES;
/** Fixed-vocabulary label, so a caller cannot inject arbitrary text into the line. */
const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const PHASE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const POWERSHELL_EXECUTABLE = /(?:^|[\\/])powershell\.exe$/i;
/** Production's own fixed argument vector, checked as shape and never printed. */
const PRODUCTION_ARGUMENTS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] as const;
/**
 * The per-ancestor marker repeats once per walked hop, so it is guarded by the
 * script's own step variable and stays bounded no matter how long the chain is.
 */
const MAX_INSTRUMENTED_ANCESTOR_MARKERS = 2;
const MAX_INSTRUMENTED_MARKER_LINES = 12;

export function isWindowsLineagePhase(value: unknown): value is WindowsLineagePhase {
  return typeof value === "string" && (WINDOWS_LINEAGE_PHASES as readonly string[]).includes(value);
}

/**
 * One stderr line, or `undefined`. Only the exact prefix plus an allowlisted
 * phase name is a phase; unknown marker text, other prefixes, and everything
 * else a host may write to stderr are simply not phases and are never retained.
 */
export function parseWindowsLineagePhaseMarker(line: string): WindowsLineagePhase | undefined {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith(WINDOWS_LINEAGE_PHASE_MARKER_PREFIX)) return undefined;
  const name = text.slice(WINDOWS_LINEAGE_PHASE_MARKER_PREFIX.length);
  if (!PHASE_NAME_PATTERN.test(name)) return undefined;
  return isWindowsLineagePhase(name) ? name : undefined;
}

const markerLine = (phase: WindowsLineagePhase, indent = ""): string =>
  `${indent}[Console]::Error.WriteLine('${WINDOWS_LINEAGE_PHASE_MARKER_PREFIX}${phase}')`;

/** One fixed production script line this helper may attach markers to. */
interface ScriptAnchor {
  /** Exact prefix of the production line, matched line-wise and required to be unique. */
  prefix: string;
  before?: readonly WindowsLineagePhase[];
  after?: readonly WindowsLineagePhase[];
  /** Only the per-ancestor lookup: repeats per hop, so it is step-guarded. */
  perHop?: boolean;
}

const SCRIPT_ANCHORS: readonly ScriptAnchor[] = [
  { prefix: "$ErrorActionPreference = 'Stop'", before: ["script-entry"] },
  { prefix: "$initial = @(Get-CimInstance", before: ["initial-query-start"], after: ["initial-query-end"] },
  { prefix: "for ($step = 0; $step -lt ", before: ["walk-start"] },
  { prefix: "  $current = Get-CimInstance", perHop: true },
  { prefix: "    $liveProcesses = @(Get-CimInstance", before: ["snapshot-start"], after: ["snapshot-end"] },
  { prefix: "      [Console]::Out.WriteLine(($evidence -join ';'))", after: ["evidence-written"] },
  { prefix: "[Console]::Out.WriteLine('PI_REVIEW_GATE_LINEAGE_NO:chain-depth-limit')", before: ["walk-depth-limit"] },
];

export type WindowsLineageScriptInstrumentation =
  | { instrumented: true; script: string; markers: number }
  | { instrumented: false; script: string; reason: "anchors-missing" | "marker-limit" };

/**
 * Insert stderr-only phase markers into a lineage script.
 *
 * Fail-closed and non-destructive: every production line is copied verbatim in
 * its original order and only whole marker lines are added, so every decision,
 * every CIM request, and every stdout write (`[Console]::Out`) is byte-identical
 * to what the production module emitted. If any fixed anchor is missing or
 * ambiguous — i.e. the production script is not the shape this helper was written
 * for — the ORIGINAL script is returned untouched with a fixed reason, so
 * diagnostics can never edit a proof into a different shape.
 */
export function instrumentWindowsLineageScript(script: string): WindowsLineageScriptInstrumentation {
  const lines = script.split("\n");
  const before = new Map<number, string[]>();
  const after = new Map<number, string[]>();
  let markers = 0;
  for (const anchor of SCRIPT_ANCHORS) {
    const matches = lines
      .map((line, index) => (line.startsWith(anchor.prefix) ? index : -1))
      .filter((index) => index >= 0);
    if (matches.length !== 1) return { instrumented: false, script, reason: "anchors-missing" };
    const index = matches[0]!;
    const added: string[] = [];
    if (anchor.perHop === true) {
      added.push(`  if ($step -lt ${MAX_INSTRUMENTED_ANCESTOR_MARKERS}) { ${markerLine("ancestor-lookup")} }`);
    } else {
      for (const phase of anchor.before ?? []) added.push(markerLine(phase, leadingIndent(lines[index]!)));
      for (const phase of anchor.after ?? []) after.set(index, [...(after.get(index) ?? []), markerLine(phase, leadingIndent(lines[index]!))]);
    }
    if (added.length > 0) before.set(index, [...(before.get(index) ?? []), ...added]);
    markers += added.length + (after.get(index)?.length ?? 0);
  }
  if (markers > MAX_INSTRUMENTED_MARKER_LINES) return { instrumented: false, script, reason: "marker-limit" };
  const output: string[] = [];
  lines.forEach((line, index) => {
    output.push(...(before.get(index) ?? []));
    output.push(line);
    output.push(...(after.get(index) ?? []));
  });
  return { instrumented: true, script: output.join("\n"), markers };
}

/** Keep an inserted marker visually inside the script block it annotates. */
function leadingIndent(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

export interface WindowsLineagePhaseRecord {
  phase: WindowsLineagePhase;
  /** Whole milliseconds since this probe's single query started. */
  elapsedMs: number;
  /** Repeated observations of one phase, aggregated instead of duplicated. */
  count: number;
}

export type WindowsLineageInstrumentStatus =
  | "not-started"
  | "ok"
  | "unexpected-script"
  | "anchors-missing"
  | "marker-limit";

export type WindowsLineageDelegationStatus = "not-started" | "production" | "changed";

/** The one canonical record of one query's phase observations. */
export interface WindowsLineagePhaseTimeline {
  label: string;
  result: WindowsLineageVerification;
  elapsedMs: number;
  /** Query children started through this wrapper. */
  calls: number;
  /**
   * Completion callbacks witnessed, taken from the one canonical `query-callback`
   * phase record (so it saturates at `MAX_PHASE_COUNT` like every other phase
   * count). Production settles through exactly one.
   */
  callbacks: number;
  instrument: WindowsLineageInstrumentStatus;
  delegation: WindowsLineageDelegationStatus;
  unrecognizedMarkers: number;
  scanTruncated: boolean;
  phases: readonly WindowsLineagePhaseRecord[];
}

function boundedInteger(value: number): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 31 - 1
    ? String(value)
    : "?";
}

/** A refusal stage is printable only when it is one of production's fixed codes. */
function resultToken(result: WindowsLineageVerification): string {
  if (result.verified === true) return "verified";
  return isWindowsLineageRefusalReason(result.reason) ? result.reason : "unknown";
}

/**
 * Render the single bounded diagnostic line. Phases are re-validated against the
 * closed vocabulary, de-duplicated into the canonical fixed order, and printed as
 * `phase@<elapsedMs>` with an `x<count>` suffix only when a phase repeated; a
 * line that would exceed the cap drops trailing phases and reports how many were
 * withheld. No free-form value can reach the output.
 */
export function formatWindowsLineagePhaseDiagnostic(timeline: WindowsLineagePhaseTimeline): string {
  const head = [
    "prg-lineage-phases",
    "v=1",
    `label=${LABEL_PATTERN.test(timeline.label) ? timeline.label : "?"}`,
    `result=${resultToken(timeline.result)}`,
    `delegation=${timeline.delegation}`,
    `instrument=${timeline.instrument}`,
    `calls=${boundedInteger(timeline.calls)}`,
    `callbacks=${boundedInteger(timeline.callbacks)}`,
    `unrecognized=${boundedInteger(timeline.unrecognizedMarkers)}`,
    `scanTruncated=${timeline.scanTruncated === true}`,
    `elapsedMs=${boundedInteger(timeline.elapsedMs)}`,
  ].join(" ");
  const first = new Map<WindowsLineagePhase, WindowsLineagePhaseRecord>();
  for (const record of timeline.phases) {
    if (!isWindowsLineagePhase(record.phase) || first.has(record.phase)) continue;
    first.set(record.phase, record);
  }
  const entries = WINDOWS_LINEAGE_PHASES
    .filter((phase) => first.has(phase))
    .map((phase) => {
      const record = first.get(phase)!;
      const count = record.count > 1 ? `x${boundedInteger(record.count)}` : "";
      return `${phase}@${boundedInteger(record.elapsedMs)}${count}`;
    });
  for (let keep = entries.length; keep > 0; keep -= 1) {
    const withheld = entries.length - keep;
    const shown = withheld > 0 ? [...entries.slice(0, keep), `+${withheld}`] : entries;
    const text = `${head} phases=[${shown.join(",")}]`;
    if (text.length <= WINDOWS_LINEAGE_DIAGNOSTIC_MAX_CHARS) return text;
  }
  return `${head} phases=[${entries.length > 0 ? `+${entries.length}` : ""}]`.slice(0, WINDOWS_LINEAGE_DIAGNOSTIC_MAX_CHARS);
}

/** Shape-only check that what this wrapper received is still production's query. */
function isProductionDelegation(file: string, args: readonly string[], options: WindowsLineageQueryOptions): boolean {
  if (!POWERSHELL_EXECUTABLE.test(file)) return false;
  if (args.length !== PRODUCTION_ARGUMENTS.length + 1) return false;
  for (let index = 0; index < PRODUCTION_ARGUMENTS.length; index += 1) {
    if (args[index] !== PRODUCTION_ARGUMENTS[index]) return false;
  }
  return options.encoding === "utf8"
    && options.maxBuffer === MAX_QUERY_OUTPUT_BYTES
    && options.windowsHide === true
    && !("timeout" in options);
}

export interface WindowsLineagePhaseProbe {
  /** Pass as the existing `WindowsLineageQueryProbe.execute` seam. */
  readonly execute: WindowsLineageQueryExecutor;
  /** The canonical bounded record for this probe's query. */
  readonly timeline: (label: string, result: WindowsLineageVerification) => WindowsLineagePhaseTimeline;
  /** The one bounded diagnostic line for this probe's query. */
  readonly diagnostic: (label: string, result: WindowsLineageVerification) => string;
}

/**
 * Wrap the real native query executor with read-only phase observation.
 *
 * The delegate defaults to the same `execFile` call the production module uses.
 * The wrapper passes the executable, the first four arguments, and the options
 * object through unchanged, substitutes only the script argument with an
 * instrumented copy (and not even that when instrumentation fails closed), and
 * forwards the completion callback's arguments verbatim. It adds listeners only.
 */
export function createWindowsLineagePhaseProbe(
  delegate: WindowsLineageQueryExecutor = (file, args, options, callback) => execFile(file, args, options, callback),
): WindowsLineagePhaseProbe {
  const observed = new Map<WindowsLineagePhase, { firstMs: number; count: number }>();
  let startedAt = 0;
  let calls = 0;
  let unrecognized = 0;
  let instrument: WindowsLineageInstrumentStatus = "not-started";
  let delegation: WindowsLineageDelegationStatus = "not-started";
  let pendingStderr = "";
  let scanTruncated = false;

  // `calls > 0` is the only "a query started" state and `observed` is the only
  // observation ledger: whether a first-chunk phase already happened is read back
  // from the ledger instead of a parallel flag, and the completion-callback count
  // is the `query-callback` record itself instead of a second counter.
  const elapsed = (): number => (calls > 0 ? Math.max(0, Math.round(performance.now() - startedAt)) : 0);
  const record = (phase: WindowsLineagePhase): void => {
    const seen = observed.get(phase);
    if (seen === undefined) observed.set(phase, { firstMs: elapsed(), count: 1 });
    else if (seen.count < MAX_PHASE_COUNT) seen.count += 1;
  };

  /** Scan stderr lines for markers only; the text itself is never kept. */
  const scanStderr = (chunk: string | Buffer): void => {
    if (scanTruncated) return;
    pendingStderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(pendingStderr) > MAX_MARKER_SCAN_BYTES) {
      scanTruncated = true;
      pendingStderr = "";
      return;
    }
    for (;;) {
      const newline = pendingStderr.indexOf("\n");
      if (newline < 0) return;
      const line = pendingStderr.slice(0, newline);
      pendingStderr = pendingStderr.slice(newline + 1);
      const phase = parseWindowsLineagePhaseMarker(line);
      if (phase !== undefined) record(phase);
      else if (line.trim().length > 0 && unrecognized < MAX_UNRECOGNIZED_COUNT) unrecognized += 1;
    }
  };

  const execute: WindowsLineageQueryExecutor = (file, args, options, callback) => {
    calls += 1;
    if (calls === 1) startedAt = performance.now();
    // Only the script argument may ever differ, and only when the fixed marker
    // anchors were found; every other argument and the options object go through
    // untouched, and the status below says so.
    const script = typeof args[4] === "string" ? args[4] : undefined;
    const outcome = script === undefined ? undefined : instrumentWindowsLineageScript(script);
    if (calls === 1) {
      instrument = outcome === undefined ? "unexpected-script" : outcome.instrumented ? "ok" : outcome.reason;
      delegation = isProductionDelegation(file, args, options) ? "production" : "changed";
    }
    const child: WindowsLineageQueryChild = delegate(
      file,
      outcome?.instrumented === true ? args.map((arg, index) => (index === 4 ? outcome.script : arg)) : args,
      options,
      (error, stdout, stderr) => {
        record("query-callback");
        callback(error, stdout, stderr);
      },
    );
    child?.stdout?.on("data", () => {
      if (observed.has("stdout-first")) return;
      record("stdout-first");
    });
    child?.stderr?.on("data", (chunk: string | Buffer) => {
      if (!observed.has("stderr-first")) record("stderr-first");
      scanStderr(chunk);
    });
    const events = child as unknown as { once?: (event: "spawn" | "exit" | "close", listener: () => void) => unknown };
    if (typeof events?.once === "function") {
      // `spawn` is the child's own notification that it really started. The
      // delegate returning a child object is not that evidence: an ENOENT or other
      // asynchronous spawn failure returns the same way and never emits `spawn`, so
      // recording on return would hand the diagnosis spawn evidence the host never
      // produced.
      events.once("spawn", () => record("child-spawn"));
      events.once("exit", () => record("child-exit"));
      events.once("close", () => record("child-close"));
    }
    return child;
  };

  const timeline = (label: string, result: WindowsLineageVerification): WindowsLineagePhaseTimeline => ({
    label,
    result,
    elapsedMs: elapsed(),
    calls,
    callbacks: observed.get("query-callback")?.count ?? 0,
    instrument,
    delegation,
    unrecognizedMarkers: unrecognized,
    scanTruncated,
    phases: WINDOWS_LINEAGE_PHASES
      .filter((phase) => observed.has(phase))
      .map((phase) => {
        const seen = observed.get(phase)!;
        return { phase, elapsedMs: seen.firstMs, count: seen.count };
      }),
  });

  return { execute, timeline, diagnostic: (label, result) => formatWindowsLineagePhaseDiagnostic(timeline(label, result)) };
}
