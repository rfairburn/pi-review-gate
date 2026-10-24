/**
 * Pure bounded formatter for the Windows real-Main startup diagnostic (Refs #494).
 *
 * Diagnosis only. Every value is re-validated against the runner trace's fixed
 * vocabulary (tests/fixtures/session-host-windows-startup-trace.cjs) and the
 * fixed MainResult flag set before it is printed; anything else is dropped or
 * reported as `?`. It never takes terminal text, argv, environment, paths, or
 * transcripts, so it can never route private content into CI logs.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

interface TraceVocabulary {
  readonly STAGES: readonly string[];
  readonly CHILD_KINDS: readonly string[];
  readonly ARG_SHAPES: readonly string[];
  readonly CHILD_APIS: readonly string[];
  readonly SIGNAL_CLASSES: readonly string[];
  readonly ERROR_CODES: readonly string[];
  readonly ERROR_NAMES: readonly string[];
  readonly TRACE_SCHEMA_VERSION: number;
}

const vocabulary = createRequire(join(process.cwd(), "package.json"))(
  join(process.cwd(), "tests", "fixtures", "session-host-windows-startup-trace.cjs"),
) as TraceVocabulary;

export const STARTUP_DIAGNOSTIC_MAX_CHARS = 3_000;
const HEAD_RECORDS = 12;
const TAIL_RECORDS = 16;

/** Fixed MainResult fields that may be printed, by expected primitive type. */
const RESULT_BOOLEAN_FIELDS = ["threw", "forceAttempted", "journalFailed", "stdinIsTTY", "stdoutIsTTY",
  "sameInputStream", "sameOutputStream", "rawBefore", "rawAfter"] as const;
const RESULT_INTEGER_FIELDS = ["status", "unresolvedSpawns", "unexitedSpawns"] as const;

export interface StartupDiagnosticInput {
  readonly elapsedMs: number;
  readonly outerExit: { readonly exitCode: number; readonly signal?: number } | undefined;
  readonly outerPidKnown: boolean;
  readonly dataChunks: number;
  readonly dataChars: number;
  readonly firstDataMs: number | undefined;
  readonly lastDataMs: number | undefined;
  readonly alternateEnter: boolean;
  readonly alternateLeave: boolean;
  readonly baselineVisible: boolean;
  readonly cursorReportReplies: number;
  readonly deviceAttributeReplies: number;
  readonly ptySpawnRecords: number | "unreadable";
  readonly nativeRecords: number | "unreadable";
  /** Parsed main-result.json (`undefined` when absent, `"unreadable"` when not a bounded JSON object). */
  readonly result: Record<string, unknown> | undefined | "unreadable";
  /** Parsed trace records (`"unreadable"` when the journal failed its bounded read). */
  readonly trace: readonly Record<string, unknown>[] | "unreadable";
}

function integer(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 2 ** 31 ? String(value) : "?";
}

function fixed(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "?";
}

function nullableFixed(value: unknown, allowed: readonly string[]): string {
  return value === null || value === undefined ? "-" : fixed(value, allowed);
}

function nullableInteger(value: unknown): string {
  return value === null || value === undefined ? "-" : integer(value);
}

/** One fixed-vocabulary trace record. */
export function formatTraceRecord(record: Record<string, unknown>): string {
  const stage = fixed(record.stage, vocabulary.STAGES);
  const at = `@${integer(record.ms)}`;
  if (stage === "child-begin" || stage === "child-end") {
    const what = `${fixed(record.api, vocabulary.CHILD_APIS)}:${fixed(record.kind, vocabulary.CHILD_KINDS)}/${fixed(record.shape, vocabulary.ARG_SHAPES)}#${integer(record.id)}`;
    if (stage === "child-begin") return `${stage}(${what})${at}`;
    return `${stage}(${what} ${integer(record.durationMs)}ms threw=${record.threw === true} status=${nullableInteger(record.status)}`
      + ` signal=${nullableFixed(record.signal, vocabulary.SIGNAL_CLASSES)} code=${nullableFixed(record.code, vocabulary.ERROR_CODES)})${at}`;
  }
  if (stage === "loop-gap") return `${stage}(${integer(record.gapMs)}ms)${at}`;
  const flags: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (["v", "seq", "stage", "ms"].includes(key)) continue;
    if (!/^[A-Za-z]{1,24}$/u.test(key)) continue;
    if (typeof value === "boolean" || value === null) flags.push(`${key}=${String(value)}`);
    else if (typeof value === "number") flags.push(`${key}=${integer(value)}`);
    else if (key === "errorName") flags.push(`${key}=${fixed(value, vocabulary.ERROR_NAMES)}`);
  }
  return `${stage}${flags.length > 0 ? `(${flags.join(",")})` : ""}${at}`;
}

/** Aggregates every child record so a bounded record window cannot hide repeated calls. */
function childSummary(records: readonly Record<string, unknown>[]): string {
  const groups = new Map<string, { calls: number; ended: number; totalMs: number; maxMs: number; timeouts: number }>();
  for (const record of records) {
    if (record.stage !== "child-begin" && record.stage !== "child-end") continue;
    const key = `${fixed(record.api, vocabulary.CHILD_APIS)}:${fixed(record.kind, vocabulary.CHILD_KINDS)}/${fixed(record.shape, vocabulary.ARG_SHAPES)}`;
    const group = groups.get(key) ?? { calls: 0, ended: 0, totalMs: 0, maxMs: 0, timeouts: 0 };
    if (record.stage === "child-begin") group.calls += 1;
    else {
      group.ended += 1;
      const duration = typeof record.durationMs === "number" && Number.isSafeInteger(record.durationMs) ? record.durationMs : 0;
      group.totalMs += duration;
      group.maxMs = Math.max(group.maxMs, duration);
      if (record.code === "ETIMEDOUT" || record.signal !== null && record.signal !== undefined) group.timeouts += 1;
    }
    groups.set(key, group);
  }
  if (groups.size === 0) return "none";
  return [...groups].slice(0, 12).map(([key, group]) =>
    `${key}x${group.calls}(open=${group.calls - group.ended},total=${group.totalMs}ms,max=${group.maxMs}ms,timeoutOrSignal=${group.timeouts})`).join(" ");
}

function resultSummary(result: StartupDiagnosticInput["result"]): string {
  if (result === undefined) return "absent";
  if (result === "unreadable") return "unreadable";
  const parts: string[] = [];
  for (const field of RESULT_INTEGER_FIELDS) if (field in result) parts.push(`${field}=${nullableInteger(result[field])}`);
  for (const field of RESULT_BOOLEAN_FIELDS) {
    if (!(field in result)) continue;
    const value = result[field];
    parts.push(`${field}=${typeof value === "boolean" || value === null ? String(value) : "?"}`);
  }
  return `{${parts.join(",")}}`;
}

/** The complete bounded startup diagnostic for one failed real-Main frame wait. */
export function formatWindowsStartupDiagnostic(input: StartupDiagnosticInput): string {
  const exit = input.outerExit === undefined
    ? "alive"
    : `exited(code=${integer(input.outerExit.exitCode)},signal=${nullableInteger(input.outerExit.signal)})`;
  const head = [
    `elapsedMs=${integer(Math.round(input.elapsedMs))}`,
    `outer=${exit}`,
    `pidKnown=${input.outerPidKnown}`,
    `chunks=${integer(input.dataChunks)}`,
    `chars=${integer(input.dataChars)}`,
    `firstDataMs=${nullableInteger(input.firstDataMs === undefined ? undefined : Math.round(input.firstDataMs))}`,
    `lastDataMs=${nullableInteger(input.lastDataMs === undefined ? undefined : Math.round(input.lastDataMs))}`,
    `altEnter=${input.alternateEnter}`,
    `altLeave=${input.alternateLeave}`,
    `baselineVisible=${input.baselineVisible}`,
    `cprReplies=${integer(input.cursorReportReplies)}`,
    `daReplies=${integer(input.deviceAttributeReplies)}`,
    `ptyRecords=${input.ptySpawnRecords === "unreadable" ? "unreadable" : integer(input.ptySpawnRecords)}`,
    `nativeRecords=${input.nativeRecords === "unreadable" ? "unreadable" : integer(input.nativeRecords)}`,
    `result=${resultSummary(input.result)}`,
  ].join(" ");
  const format = (headCount: number, tailCount: number): string => {
    if (input.trace === "unreadable") return `startup{${head} trace=unreadable}`;
    const records = input.trace.filter((record) => record.v === vocabulary.TRACE_SCHEMA_VERSION);
    const window = records.length <= headCount + tailCount
      ? records.map(formatTraceRecord)
      : [...records.slice(0, headCount).map(formatTraceRecord),
        `...${records.length - headCount - tailCount} more...`,
        ...records.slice(records.length - tailCount).map(formatTraceRecord)];
    return `startup{${head} trace=records=${records.length} children=[${childSummary(records)}] [${window.join(" ")}]}`;
  };
  // The newest records locate a stall, so a long trace keeps a shorter head first.
  for (const [headCount, tailCount] of [[HEAD_RECORDS, TAIL_RECORDS], [4, 10], [0, 4]] as const) {
    const text = format(headCount, tailCount);
    if (text.length <= STARTUP_DIAGNOSTIC_MAX_CHARS) return text;
  }
  return `${format(0, 1).slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS - 4)}...}`;
}
