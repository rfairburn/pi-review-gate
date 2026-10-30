/**
 * User-only audit diagnostics for the pre-execution tool-protection gate
 * (issue #549).
 *
 * Why this module exists: a PASS or NOT AUDITED decision describes this added
 * gate, not the tool's output. Prepending it to the acting model's tool result
 * made the model read an approval it neither asked for nor can verify, so a
 * successful or skipped audit now adds nothing at all to the canonical native
 * result. The diagnostics stay where a human can see them, in two places that
 * are both owned by the host's ordinary presentation machinery:
 *
 * - bounded in-memory state keyed by the host's own public `toolCallId`, which
 *   the tool-row decoration looks up while it renders that row, and
 * - one ordinary session entry per audited call, written with the host's
 *   `pi.appendEntry()`. A plain custom entry is durable UI state: Pi's own
 *   session projection (`sessionEntryToContextMessages`) ignores it, so it can
 *   never reach a model request, and it is rebuilt from the ACTIVE branch on
 *   `session_start` like any other branch-sensitive presentation state.
 *
 * What this state never does:
 * - it grants nothing. Admission is decided by `ToolProtectionCoordinator`
 *   before any display exists, and a restored entry is never read as an
 *   approval, a replay, a cache hit, or a decision of any kind;
 * - it stores no PASS reason, no tool arguments, no prompt, and no transport
 *   text. A nested refusal keeps its (bounded) reason because that refusal is
 *   already model-visible in the outer call's result;
 * - it changes no verdict and no coverage. `toolProtection.debug` only chooses
 *   whether the routine positive and infrastructure-exempt rows are drawn; a
 *   refusal, an audit error, and an auditor-session save failure are drawn for
 *   either value.
 *
 * Two display surfaces exist, and exactly one of them draws a call:
 * - `surface: "row"` — the tool has a native result renderer, so the gate draws
 *   its rows above that renderer's own output (never replacing its body);
 * - `surface: "entry"` — the tool has no result renderer, so the host's native
 *   result fallback keeps drawing the tool's own output untouched and the gate's
 *   rows come from the durable entry renderer instead.
 * The surface recorded on the entry is the route the host's renderer resolution
 * produced for that call at publish time. A host can resolve a renderer later,
 * or stop resolving one, so each draw re-checks that resolution and falls back
 * to the recorded surface only for a tool this runtime has not resolved. Exactly
 * one surface ever draws a call, which is what keeps a reload — or a renderer
 * appearing or disappearing — from drawing the same rows twice or dropping them.
 */

import { isRecord } from "../record-guard";
import { wrapAtWordBoundaries } from "../tool-result-wrap";
import { visibleTerminalText } from "../tool-result-text";
import type { ProtectionLevel } from "./config";

/** Custom-entry type carrying one call's user-only audit diagnostics. */
export const TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE = "pi-review-gate.tool-protection";
/**
 * Shape version of the durable display entry. Version 2 separates save-failure
 * counts by delivery population (nested refusals, whose save failure rides the
 * model-visible refusal block, versus calls that ran, whose save failure is a
 * user-only row) and carries the exact recorded root-refusal text, so a refusal
 * can be drawn and stripped from call-bound provenance rather than from
 * prefix-shaped text found inside a tool's own output.
 */
export const TOOL_PROTECTION_DISPLAY_VERSION = 2;

/** Bounds that keep display state and one session entry small; not policy budgets. */
const MAX_DISPLAY_ROWS = 64;
const MAX_DISPLAY_RECORDS = 32;
const MAX_DISPLAY_LINES = 12;
const MAX_DISPLAY_TOOL_NAME_CHARS = 120;
/**
 * Bound for the exact text this gate handed the host as a root refusal. It sits
 * just above the gate's own 6 000-character block-reason bound, so the recorded
 * provenance stays byte-comparable with what the renderer receives; a value that
 * still exceeds this bound simply stops matching and is never stripped from
 * native content.
 */
const MAX_DISPLAY_REFUSAL_TEXT_CHARS = 6_100;
/**
 * A nested refusal's reason is the acting model's failure context: the exact
 * block text this gate handed the host for that child, already model-visible
 * inside the outer call's result at the auditor decision's own reason bound. The
 * display path reuses the gate's recorded-refusal bound instead of inventing a
 * shorter presentation budget, and stores the value without trimming, so the
 * user's row and the model's refusal carry the same words.
 */
const MAX_DISPLAY_REASON_CHARS = MAX_DISPLAY_REFUSAL_TEXT_CHARS;
/**
 * A save-failure disclosure is this gate's own text, and it rides the refusal
 * block it belongs to, so it stays inside the same recorded-refusal bound rather
 * than a shorter budget that would cut a disclosure into a different statement.
 */
const MAX_DISPLAY_WARNING_CHARS = MAX_DISPLAY_REFUSAL_TEXT_CHARS;

/** Verdict of one audited call, as presented to the user. */
export type AuditDisplayKind = "pass" | "not-audited" | "not-audited-discovery" | "blocked";

/** Which surface draws a call's rows. */
export type AuditDisplaySurface = "row" | "entry";

/** One audited call's bounded diagnostic metadata. No PASS reason is ever stored. */
export interface AuditDisplayRecord {
  kind: AuditDisplayKind;
  toolName: string;
  level: ProtectionLevel;
  /** True for a nested child decision aggregated onto its root's row. */
  nested: boolean;
  durationMs?: number;
  /** Bounded refusal text; only ever present on a refusal record. */
  reason?: string;
  /** Bounded disclosure that this invocation's saved auditor session is incomplete. */
  recordWarning?: string;
}

/** One audited root call's display state, and the durable entry payload. */
export interface AuditDisplayData {
  version: number;
  /** The host-issued tool call id whose row (or entry) carries these rows. */
  callId: string;
  toolName: string;
  surface: AuditDisplaySurface;
  /** Every nested decision observed for this root, including unretained ones. */
  nestedTotal: number;
  /** Refusal records observed, counted independently of the retained set. */
  refusalTotal: number;
  /**
   * Nested save failures observed, counted independently of the retained set,
   * for calls that were not refused. Their disclosure is user-only: a recording
   * problem on a call that ran never becomes model-visible content.
   */
  nestedWarningCount: number;
  /**
   * Nested save failures attached to a refused nested call, counted
   * independently of the retained set. Their disclosure rides the one
   * model-visible refusal block, so it is never counted again in a user row.
   */
  nestedRefusalWarningCount: number;
  /**
   * The exact refusal text this gate handed the host for this call, recorded at
   * the moment of refusal. It is provenance, not a guess from tool output: the
   * row decoration draws it and strips it from the renderer's copy only when the
   * content carries that same text byte-for-byte.
   */
  rootRefusalText?: string;
  records: AuditDisplayRecord[];
}

/**
 * The gate's own auditor-session recording failures, in each form they take: a
 * per-call warning, and the bounded nested summary's aggregate count.
 */
const SAVE_WARNING_PATTERN = /Tool protection: the auditor session (?:could not be saved|was only partially saved)|WARNING: \d+ auditor session\(s\) could not be fully saved/;

/**
 * Refusal text this gate recorded itself. Styling reads the verdict from this
 * gate's own recorded line, never from a tool's output.
 */
const GATE_REFUSAL_PATTERN = /^Tool protection: (FAIL \u2014|unavailable \u2014|audit unavailable \u2014|auditor unavailable \u2014|required causal evidence unavailable \u2014|invalid auditor response \u2014|audit invalidated \u2014|audit cancelled \u2014|\d+ nested call\(s\) refused)/;

/** Theme subset the audit-status rows use; matches Pi's `theme.fg()` contract. */
export type AuditDisplayColor = "accent" | "error" | "muted" | "success" | "warning";

/** Row backgrounds Pi's own tool row uses; matches `theme.bg()` tokens. */
export type AuditDisplayBackground = "toolErrorBg" | "toolPendingBg" | "toolSuccessBg";

export interface AuditDisplayTheme {
  fg(color: AuditDisplayColor, text: string): string;
  /**
   * The row background Pi's own tool row paints. A tool that draws its own row
   * shell (`renderShell: "self"`, the native edit tool) gets no host framing, so
   * the gate paints its rows with this token to keep the themed card continuous
   * (#547). A theme without the token leaves rows unpainted.
   */
  bg?(color: AuditDisplayBackground, text: string): string;
}

/**
 * The theme Pi hands to `renderResult` and to an entry renderer, when the host
 * supplies one. Lightweight compatibility mocks without a theme keep the plain
 * rows.
 */
export function auditDisplayTheme(value: unknown): AuditDisplayTheme | undefined {
  if (!isRecord(value) || typeof value.fg !== "function") return undefined;
  return value as unknown as AuditDisplayTheme;
}

/**
 * A nested decision row's verdict token. The tool name is matched up to the
 * first `: ` (Pi tool names carry no whitespace or colon) and the verdict must
 * be the token immediately after it, so verdict-shaped text inside the
 * auditor's reason cannot change the row's tone. The alternation is ordered so
 * the earliest token wins when a reason quotes another verdict.
 */
const NESTED_VERDICT_PATTERN = /^- nested [^\s:]+: (NOT AUDITED|FAIL\/BLOCKED before execution|PASS)\b/;

/**
 * Semantic tone of one gate display row, read from the gate's own line text.
 * The verdict always comes from the annotation itself — never from the tool's
 * completion — so a nested refusal, a NOT AUDITED row, or a recording warning is
 * never presented as success merely because the tool returned normally.
 */
export function auditDisplayColor(line: string): AuditDisplayColor {
  const nestedVerdict = NESTED_VERDICT_PATTERN.exec(line)?.[1];
  // A verdict outranks a recording warning appended to the same line.
  if (GATE_REFUSAL_PATTERN.test(line) || nestedVerdict === "FAIL/BLOCKED before execution") {
    return "error";
  }
  if (SAVE_WARNING_PATTERN.test(line)) return "warning";
  if (/^Tool protection: NOT AUDITED\b/.test(line) || nestedVerdict === "NOT AUDITED") return "warning";
  if (/^Tool protection: PASS\b/.test(line) || nestedVerdict === "PASS") return "success";
  if (/^- RETENTION LOSS:/.test(line)) return "warning";
  if (/^- \d+ earlier nested (decision|refusal)\(s\) omitted/.test(line)) return "muted";
  return "accent";
}

/**
 * One gate row drawn for the user: sanitize and wrap first, then style each
 * physical row. Wrapping goes through the shared host-aware word-boundary
 * wrapper (#547), so a gate row never breaks mid-word or exceeds the card while
 * wide glyphs and theme escapes stay out of the width count. `indent` is the
 * card's own horizontal inset (`context.outputPad`), added only by a surface
 * that owns its padding; rows are measured and padded to the full width by the
 * caller that paints the row background.
 */
export function auditDisplayRows(
  lines: readonly string[],
  theme: AuditDisplayTheme | undefined,
  width: number,
  indent = 0,
): string[] {
  return lines.flatMap((line) => {
    const color = auditDisplayColor(line);
    return wrapAtWordBoundaries(visibleTerminalText(line), width)
      .map((chunk) => `${" ".repeat(Math.max(0, indent))}${theme === undefined ? chunk : theme.fg(color, chunk)}`);
  });
}

function clampText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

/**
 * Bound one display string before it is stored or drawn, so the durable entry,
 * the row, and the model-visible refusal line are built from the same text.
 */
export function clampAuditDisplayText(value: string, maximum: number): string {
  return clampText(value, maximum) ?? "";
}

/**
 * Bound recorded text without trimming or reformatting it. Recorded provenance
 * has to stay byte-comparable with what the host received, so this only shortens
 * an over-long value; a shortened value simply stops matching and is never
 * stripped from native content.
 */
function clampExact(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= maximum ? value : value.slice(0, maximum);
}

/**
 * Bound a recorded statement without trimming it or discarding an intentionally
 * empty one. A supplied reason is the auditor's own text; whitespace and an
 * empty string are part of what was supplied, and only an absent field is
 * omission.
 */
function clampVerbatim(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= maximum ? value : value.slice(0, maximum);
}

/** Bound a refusal reason for presentation without shortening the model's context. */
export function clampAuditDisplayReason(value: string): string {
  return clampVerbatim(value, MAX_DISPLAY_REASON_CHARS) ?? "";
}

/** Bound a save-failure disclosure for presentation without cutting it short. */
export function clampAuditDisplayWarning(value: string): string {
  return clampVerbatim(value, MAX_DISPLAY_WARNING_CHARS) ?? "";
}

function displayLevel(value: unknown): ProtectionLevel {
  return value === "dangerous" || value === "aligned" || value === "workspace" ? (value as ProtectionLevel) : "off";
}

/** Defensive read of one durable record; a hand-edited session file cannot widen it. */
function normalizeDisplayRecord(value: unknown): AuditDisplayRecord | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "pass" && kind !== "not-audited" && kind !== "not-audited-discovery" && kind !== "blocked") return undefined;
  const toolName = clampText(value.toolName, MAX_DISPLAY_TOOL_NAME_CHARS);
  if (!toolName) return undefined;
  const reason = kind === "blocked" ? clampVerbatim(value.reason, MAX_DISPLAY_REASON_CHARS) : undefined;
  const recordWarning = clampExact(value.recordWarning, MAX_DISPLAY_WARNING_CHARS);
  return {
    kind,
    toolName,
    level: displayLevel(value.level),
    nested: value.nested === true,
    ...(typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? { durationMs: value.durationMs } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(recordWarning === undefined ? {} : { recordWarning }),
  };
}

/**
 * Bound the retained records for one call without ever dropping the root record.
 * The same rule is applied when publishing and when restoring a durable entry, so
 * a root status row — and the save failure recorded on it — survives a full
 * nested set instead of being the record a `slice(-N)` removes.
 */
export function boundAuditDisplayRecords(
  root: AuditDisplayRecord | undefined,
  nested: readonly AuditDisplayRecord[],
): AuditDisplayRecord[] {
  const limit = MAX_DISPLAY_RECORDS - (root === undefined ? 0 : 1);
  let kept: readonly AuditDisplayRecord[] = nested;
  if (nested.length > limit) {
    // Prefer refusals (an earlier denial must not be the record dropped), then
    // the most recent remaining records, always kept in their original order.
    const refusals = nested.filter((record) => record.kind === "blocked").slice(0, limit);
    const room = Math.max(0, limit - refusals.length);
    // `slice(-0)` would keep the entire array, so an exhausted refusal budget must
    // select no positive record at all.
    const positives = room === 0 ? [] : nested.filter((record) => record.kind !== "blocked").slice(-room);
    const chosen = new Set<AuditDisplayRecord>([...refusals, ...positives]);
    kept = nested.filter((record) => chosen.has(record));
  }
  return root === undefined ? [...kept] : [root, ...kept];
}

/**
 * Defensive read of one durable display entry. Anything that is not exactly the
 * shape this gate writes is treated as no display state at all: a restored
 * entry can only ever redraw rows, never authorize or decide.
 */
export function normalizeAuditDisplayData(value: unknown): AuditDisplayData | undefined {
  if (!isRecord(value) || value.version !== TOOL_PROTECTION_DISPLAY_VERSION) return undefined;
  const callId = clampText(value.callId, 200);
  const toolName = clampText(value.toolName, MAX_DISPLAY_TOOL_NAME_CHARS);
  if (!callId || !toolName) return undefined;
  const nestedRecords: AuditDisplayRecord[] = [];
  let root: AuditDisplayRecord | undefined;
  if (Array.isArray(value.records)) {
    for (const candidate of value.records) {
      const record = normalizeDisplayRecord(candidate);
      if (!record) continue;
      if (!record.nested) {
        // The root record is preserved independently of the bounded nested set.
        // Filling the nested budget must never drop the root's own status, and
        // with it a root auditor-session save failure.
        root ??= record;
        continue;
      }
      nestedRecords.push(record);
    }
  }
  const count = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  const nestedWarningCount = count(value.nestedWarningCount);
  const nestedRefusalWarningCount = Math.min(count(value.nestedRefusalWarningCount), nestedWarningCount);
  const kept = boundAuditDisplayRecords(root, nestedRecords);
  if (kept.length === 0) return undefined;
  const rootRefusalText = clampExact(value.rootRefusalText, MAX_DISPLAY_REFUSAL_TEXT_CHARS);
  return {
    version: TOOL_PROTECTION_DISPLAY_VERSION,
    callId,
    toolName,
    surface: value.surface === "entry" ? "entry" : "row",
    nestedTotal: count(value.nestedTotal),
    refusalTotal: count(value.refusalTotal),
    nestedWarningCount,
    nestedRefusalWarningCount,
    ...(rootRefusalText === undefined ? {} : { rootRefusalText }),
    records: kept,
  };
}

function ownStatusLine(record: AuditDisplayRecord): string {
  if (record.kind === "not-audited-discovery") {
    return `Tool protection: NOT AUDITED — ${record.toolName} is the tool-discovery loader, which this gate never audits. No auditor was consulted and no audit approval was needed for this call; the existing native authorization, permission, and liveness guards still applied and could still refuse it. This is not a pass.`;
  }
  if (record.kind === "not-audited") {
    return `Tool protection: NOT AUDITED — ${record.toolName} is outside the configured toolProtection.scope "selected" audit subset, so the auditor did not evaluate it. The gate did not check this call; only the existing native guards applied.`;
  }
  const timing = record.durationMs !== undefined ? `, ${record.durationMs} ms` : "";
  return `Tool protection: PASS — the auditor approved this ${record.toolName} call before execution (level "${record.level}"${timing}). This is an audit decision, not a claim that the tool succeeded.`;
}

function nestedLine(record: AuditDisplayRecord): string {
  if (record.kind === "not-audited") {
    return `- nested ${record.toolName}: NOT AUDITED — outside the configured audit subset; not checked by the gate.`;
  }
  if (record.kind === "not-audited-discovery") {
    return `- nested ${record.toolName}: NOT AUDITED — discovery loader, never audited by this gate; native guards still applied.`;
  }
  if (record.kind === "blocked") {
    return `- nested ${record.toolName}: FAIL/BLOCKED before execution — ${record.reason ?? "no reason supplied"}`;
  }
  return `- nested ${record.toolName}: PASS — approved before execution.`;
}

function withWarning(line: string, record: AuditDisplayRecord): string {
  return record.recordWarning === undefined ? line : `${line} ${record.recordWarning}`;
}

/**
 * The model-visible half of a call's diagnostics: nested refusals and nothing
 * else. A PASS, a NOT AUDITED decision, and a recording problem on a call that
 * ran never add content to the acting model's result, and the header counts
 * refusals rather than every audited call, so a bounded summary can never
 * present an all-call total as a failure total.
 *
 * Save failures are accounted for only within the refusal population: a nested
 * call that was refused has its save failure disclosed here, because its
 * decision line is disclosed here. A save failure on a call that ran belongs to
 * a decision the model is never told about, and stays user-only.
 */
export function auditDisplayModelLines(data: AuditDisplayData): string[] {
  const refusals = data.records.filter((record) => record.nested && record.kind === "blocked");
  if (refusals.length === 0) return [];
  // Every retained refusal stays visible even when the line budget is smaller
  // than the retained set; an earlier denial must not hide behind later rows.
  const shown = refusals.slice(0, MAX_DISPLAY_LINES);
  // The count comes from the aggregate, which is incremented before any
  // retention limit, so an evicted or omitted refusal never hides its save
  // failure, and a save failure that is already carried by a displayed refusal
  // is never counted twice.
  const shownWarnings = shown.filter((record) => record.recordWarning !== undefined).length;
  const hiddenWarnings = Math.max(0, data.nestedRefusalWarningCount - shownWarnings);
  const saveWarning = hiddenWarnings > 0
    ? ` WARNING: ${hiddenWarnings} auditor session(s) could not be fully saved; their decision lines are omitted here. The gate decisions are unchanged.`
    : "";
  const total = Math.max(data.refusalTotal, refusals.length);
  const lines = [
    `Tool protection: ${total} nested call(s) refused before execution during this tool's execution:${saveWarning}`,
    ...shown.map((record) => withWarning(nestedLine(record), record)),
  ];
  if (refusals.length > shown.length) {
    lines.push(`- ${refusals.length - shown.length} earlier nested refusal(s) omitted from this summary.`);
  }
  if (data.nestedTotal > data.records.filter((record) => record.nested).length) {
    lines.push(`- RETENTION LOSS: ${data.nestedTotal - data.records.filter((record) => record.nested).length} nested decision record(s) are not retained in this summary (bounded runtime state). Refusals are retained preferentially; this count is disclosed rather than presented as complete.`);
  }
  return lines;
}

/**
 * The user-only half of a call's diagnostics: everything the model is not told.
 * `debug` chooses whether the routine positive and infrastructure-exempt rows
 * are drawn; every auditor-session save failure is drawn for either value.
 *
 * Each save failure is accounted for in exactly one population: a refused nested
 * call's failure is carried by the model-visible refusal block (drawn by the row
 * decoration from there), a call that ran discloses its own row or joins the
 * bounded user-only count, and the root call's failure is drawn with the root
 * row, which normalization always retains.
 *
 * The recorded root refusal is redrawn only on the surface that is drawing this
 * call right now. On the entry surface the host's native result fallback keeps
 * drawing that same block reason and the entry renderer has no copy of it to
 * strip, so that surface stays reserved for diagnostics the native fallback does
 * not already show.
 *
 * `surface` is the display route in effect for this draw — the host's current
 * renderer resolution for the tool, falling back to the surface recorded on the
 * call — not a second copy of the recorded value.
 */
export function auditDisplayUserLines(
  data: AuditDisplayData,
  debug: boolean,
  surface: AuditDisplaySurface = data.surface,
): string[] {
  const lines: string[] = [];
  const routineNested: Array<{ line: string; warned: boolean }> = [];
  // Only the nested population this function can omit is counted here. The root
  // record is always retained and always drawn, so its save failure can never
  // join — or hide — the bounded nested count.
  let drawnNestedWarnings = 0;
  const root = data.records.find((record) => !record.nested);
  // A refusal this gate issued for this call, drawn from the text recorded when
  // the refusal was made. Only the surface that draws the call's own row redraws
  // it: the row decoration removes the same text from its renderer-only copy,
  // while on the entry surface the host's own native result fallback keeps
  // drawing the block reason and no copy of it can be stripped. Repeating it
  // there would show the refusal — and any save-failure disclosure carried
  // inside it — twice.
  if (data.rootRefusalText !== undefined) {
    if (surface === "row") lines.push(...data.rootRefusalText.split("\n"));
  } else if (root !== undefined && root.kind === "blocked") {
    // A root refusal whose recorded text is unavailable (an older entry, or a
    // value over the recorded bound) is not redrawn from a guess; the host's own
    // block reason stays the user-visible refusal.
    if (surface === "row" && root.recordWarning !== undefined) lines.push(root.recordWarning);
  } else if (root !== undefined) {
    if (!debug && root.recordWarning !== undefined) {
      // A save failure is disclosed even when the routine row it belongs to
      // stays hidden; the disclosure never changes the verdict.
      lines.push(root.recordWarning);
    } else if (debug) {
      lines.push(withWarning(ownStatusLine(root), root));
    }
  }
  for (const record of data.records) {
    if (!record.nested) continue;
    const routine = record.kind === "pass" || record.kind === "not-audited" || record.kind === "not-audited-discovery";
    if (!routine) continue;
    // A nested refusal is already model-visible in the outer result, and the row
    // decoration draws it from there; drawing it again would duplicate it.
    if (!debug) {
      if (record.recordWarning !== undefined) {
        lines.push(`- nested ${record.toolName}: ${record.recordWarning}`);
        drawnNestedWarnings += 1;
      }
      continue;
    }
    routineNested.push({ line: withWarning(nestedLine(record), record), warned: record.recordWarning !== undefined });
  }
  const shown = routineNested.slice(-MAX_DISPLAY_LINES);
  drawnNestedWarnings += shown.filter((row) => row.warned).length;
  lines.push(...shown.map((row) => row.line));
  if (routineNested.length > shown.length) {
    lines.push(`- ${routineNested.length - shown.length} earlier nested decision(s) omitted from this summary.`);
  }
  // Only the population this function is responsible for is counted here: save
  // failures on calls that ran. Refused nested calls' failures are carried by
  // the refusal block, and the root call's failure is drawn with the root row,
  // so neither joins this count and neither can hide an omitted nested failure.
  const positiveWarnings = Math.max(0, data.nestedWarningCount - data.nestedRefusalWarningCount);
  const undrawn = Math.max(0, positiveWarnings - drawnNestedWarnings);
  if (undrawn > 0) {
    lines.push(`WARNING: ${undrawn} auditor session(s) could not be fully saved; their decision rows are omitted here. The gate decisions are unchanged.`);
  }
  return lines;
}

/**
 * One call's recorded presentation among the entries the host hands back, found
 * by the host's own call id. Used only for the active branch, and only to redraw
 * rows: a recovered record is never an approval, a replay, or a cache hit for
 * anything else. Text is never matched against a tool's own output.
 */
export function findAuditDisplayData(
  entries: readonly unknown[],
  callId: string,
): AuditDisplayData | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE) continue;
    const data = normalizeAuditDisplayData(entry.data);
    if (data && data.callId === callId) return data;
  }
  return undefined;
}

/**
 * Rows this gate draws for either `debug` value: a refusal, an audit error, or a
 * recorded auditor-session save failure. These are the rows a user was already
 * shown, so restoring a bounded set keeps them ahead of routine debug-only rows.
 */
function isUserVisibleDisplayData(data: AuditDisplayData): boolean {
  if (data.rootRefusalText !== undefined || data.refusalTotal > 0) return true;
  return data.records.some((record) => record.kind === "blocked" || record.recordWarning !== undefined);
}

export interface AuditDisplayStateOptions {
  /** Durable write through the host's own session entry API, when it has one. */
  appendEntry?: (customType: string, data: AuditDisplayData) => void;
  maxRows?: number;
}

/**
 * Bounded, current-session display state. It is an observer only: nothing here
 * is consulted to admit a call, and every lookup is keyed by the host's public
 * tool call id.
 */
export class AuditDisplayState {
  private rows = new Map<string, AuditDisplayData>();
  /** True once this runtime has published any display state at all. */
  private publishedAnyRecord = false;
  /**
   * Per-tool capability learned from the host's own renderer resolution: does
   * this tool have a result renderer whose body the gate may draw rows above?
   * Unknown defaults to "row", which keeps the durable entry silent rather than
   * drawing a second copy in a host that has no chat UI at all.
   */
  private resultRenderers = new Map<string, boolean>();
  private readonly maxRows: number;

  constructor(private readonly options: AuditDisplayStateOptions = {}) {
    this.maxRows = Math.max(1, options.maxRows ?? MAX_DISPLAY_ROWS);
  }

  /** Record what the host's renderer resolution produced for one tool name. */
  noteToolRenderer(toolName: string, hasResultRenderer: boolean): void {
    if (!toolName) return;
    this.resultRenderers.set(toolName, hasResultRenderer);
    while (this.resultRenderers.size > this.maxRows) {
      const oldest = this.resultRenderers.keys().next().value;
      if (oldest === undefined) break;
      this.resultRenderers.delete(oldest);
    }
  }

  /** The surface that will draw this tool's rows. */
  surfaceFor(toolName: string): AuditDisplaySurface {
    return this.resultRenderers.get(toolName) === false ? "entry" : "row";
  }

  /**
   * The surface the host's own renderer resolution produces for this tool right
   * now, or `undefined` when this runtime has not resolved the tool at all. A
   * renderer can be added or removed after a call was audited, so a draw follows
   * this answer rather than a stale recorded surface, and falls back to the
   * recorded value only while the answer is unknown.
   */
  currentSurfaceFor(toolName: string): AuditDisplaySurface | undefined {
    const hasResultRenderer = this.resultRenderers.get(toolName);
    return hasResultRenderer === undefined ? undefined : hasResultRenderer ? "row" : "entry";
  }

  /** Store one call's display state and persist it as ordinary session UI state. */
  publish(data: AuditDisplayData): void {
    this.publishedAnyRecord = true;
    this.remember(data);
    const append = this.options.appendEntry;
    if (!append) return;
    try {
      append(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, data);
    } catch {
      // Presentation persistence is never a decision input and never a failure
      // source: a host without a usable entry API simply keeps the in-memory rows.
    }
  }

  /**
   * Put one record into the same bounded lookup without any durable write: the
   * entry already exists in the session, and this only re-enters what an
   * on-demand active-branch recovery read found. The bound is unchanged.
   */
  remember(data: AuditDisplayData): void {
    this.rows.delete(data.callId);
    this.rows.set(data.callId, data);
    while (this.rows.size > this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }

  /** Whether this runtime ever published display state (so a branch read can find any). */
  get publishedAny(): boolean {
    return this.publishedAnyRecord;
  }

  /** Display state for one host call id, when it is still retained. */
  dataFor(callId: string): AuditDisplayData | undefined {
    return this.rows.get(callId);
  }

  /** Rebuild retained rows from the active branch only, like any branch state. */
  restore(entries: readonly unknown[]): void {
    this.rows.clear();
    // Walk back from the newest entry, and stop once the bound is full of rows
    // the user sees for either `debug` value: an ordinary long session is never
    // fully held for presentation. Rows carrying a refusal, an audit error, or a
    // save failure are kept ahead of the routine debug-only rows, so reloading a
    // long active branch never erases a failure the user was already shown just
    // because newer routine rows filled the bound.
    const userVisible: AuditDisplayData[] = [];
    const routine: AuditDisplayData[] = [];
    for (let index = entries.length - 1; index >= 0 && userVisible.length < this.maxRows; index -= 1) {
      const entry = entries[index];
      if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE) continue;
      const data = normalizeAuditDisplayData(entry.data);
      if (!data) continue;
      // The active branch holds display entries, so a later bounded-cache miss
      // is worth recovering from that branch rather than treating as no rows.
      this.publishedAnyRecord = true;
      if (isUserVisibleDisplayData(data)) {
        userVisible.push(data);
      } else if (routine.length < this.maxRows) {
        routine.push(data);
      }
    }
    const kept = userVisible.slice(0, this.maxRows);
    if (kept.length < this.maxRows) kept.push(...routine.slice(0, this.maxRows - kept.length));
    for (const data of kept.reverse()) this.rows.set(data.callId, data);
  }

  reset(): void {
    this.rows.clear();
    this.publishedAnyRecord = false;
  }
}
