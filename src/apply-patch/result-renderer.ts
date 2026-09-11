/**
 * Native result renderers for ApplyPatch.
 *
 * The renderer deliberately has two different jobs.  The collapsed arm is the
 * canonical compact status card: one `ApplyPatch · N file(s) updated` header
 * plus a bounded per-file inventory (`M src/status.ts · +1 −1`).  The expanded
 * arm is an honest transcript of the data already retained by the call: it
 * gets the original arguments from Pi's render context and renders the
 * complete requested patch, the applied operations, and the retained final
 * diff without imposing a second content or line budget.  It never reads the
 * workspace or re-runs a patch.
 */

export type ApplyPatchThemeColor =
  | "accent"
  | "error"
  | "muted"
  | "success"
  | "toolDiffAdded"
  | "toolDiffContext"
  | "toolDiffRemoved"
  | "toolTitle";

export interface ApplyPatchRendererTheme {
  bold(text: string): string;
  fg(color: ApplyPatchThemeColor, text: string): string;
}

export interface ApplyPatchRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

export interface ApplyPatchRenderContext {
  readonly args?: unknown;
  readonly [key: string]: unknown;
}

export interface ApplyPatchRendererComponent {
  render(width: number): string[];
  invalidate(): void;
}

export type ApplyPatchResultRenderer = (
  value: unknown,
  options: ApplyPatchRenderOptions,
  theme: ApplyPatchRendererTheme,
  context?: unknown,
) => ApplyPatchRendererComponent;

interface RecordValue {
  [key: string]: unknown;
}

interface RenderLine {
  text: string;
  color?: ApplyPatchThemeColor;
  bold?: boolean;
  /** Raw returned text keeps its line breaks and whitespace. */
  raw?: boolean;
}

interface OperationValue extends RecordValue {
  operation?: unknown;
  path?: unknown;
  moveTo?: unknown;
  absolutePath?: unknown;
  changed?: unknown;
  addedLines?: unknown;
  removedLines?: unknown;
  bytes?: unknown;
  mutated?: unknown;
}

/**
 * Compact renderer used as the collapsed arm of the shared expansion helper.
 * It intentionally does not use the original call arguments: a collapsed row
 * should remain an actionable status card rather than another copy of a long
 * patch, and it carries no legacy diff previews.  Full input and retained
 * output belong to the expanded arm below.  The shared expansion wrapper owns
 * the expansion hint; this renderer never emits one.
 */
export const renderApplyPatchResult: ApplyPatchResultRenderer = (value, options, theme) => {
  const record = asRecord(value);
  const failed = isErrorResult(record);
  const summary = resultText(record, failed);
  const details = detailsRecord(record);
  const lines: RenderLine[] = [];

  const operations = operationRecords(details);
  lines.push({ text: collapsedHeader(failed, options.isPartial === true, operations), color: "toolTitle", bold: true });

  if (options.isPartial === true) {
    lines.push({
      text: "ApplyPatch is still running; the returned result may be partial.",
      color: "muted",
    });
  }

  if (failed) {
    // A failure's complete returned diagnostic is the primary compact
    // evidence: it names the failed operation, every applied operation, and
    // every operation that was not attempted.  It is shown unfiltered.
    appendSummary(lines, summary, "error", true);
    appendCompactFailureDetails(lines, details);
    // Failure rows wrap rather than compact-clip so a partial-failure
    // diagnostic cannot be hidden behind a single truncated summary.
    return renderComponent(lines, theme);
  }

  if (operations.length > 0) {
    // Canonical per-file inventory; the raw success summary is fully
    // represented by these rows, so it is not duplicated here.
    for (const operation of operations) {
      lines.push({ text: `  ${operationMarkRow(operation)}`, color: "muted", raw: true });
    }
    return renderComponent(lines, theme);
  }

  // No structured inventory was retained with this result (legacy or
  // synthetic rows); the returned summary is the truthful compact fallback.
  appendSummary(lines, summary, "success", summary.includes("\n"));
  return renderComponent(lines, theme);
};

/**
 * Full ApplyPatch detail callback used by `expandableResult`.
 *
 * `context.args` is the authoritative source for the original call.  The
 * execution details intentionally retain only a legacy bounded requestedDiff
 * fallback, so an expanded row must prefer the context rather than presenting
 * that 4 KiB copy as though it were the original patch.  The complete
 * requested patch, all applied operations, full partial-failure accounting,
 * and the complete retained final diff are rendered without a content or line
 * budget.  Width wrapping is presentation-only and does not drop characters.
 */
export const renderExpandedApplyPatchResult: ApplyPatchResultRenderer = (value, options, theme, context) => {
  const record = asRecord(value);
  const failed = isErrorResult(record);
  const summary = resultText(record, failed);
  const details = detailsRecord(record);
  const operations = operationRecords(details);
  const lines: RenderLine[] = [
    { text: expandedHeader(failed, options.isPartial === true), color: "toolTitle", bold: true },
  ];

  if (options.isPartial === true) {
    lines.push({ text: "Result is still streaming; only data returned so far is shown.", color: "muted" });
  }

  // Failure diagnostics are unique retained evidence (uncertain effects and
  // the exact thrown wording); show the complete returned text.
  if (failed || operations.length === 0) {
    appendSummary(lines, summary, failed ? "error" : undefined, true);
  }
  if (failed) lines.push({ text: "" });

  appendRequestedPatch(lines, context, details);
  appendOperations(lines, details);
  appendFailure(lines, details);
  appendRetainedFinalDiff(lines, details);

  if (!details && !originalInput(context)) {
    lines.push({ text: "" });
    lines.push({
      text: "No structured ApplyPatch details were retained with this result; only the returned summary is shown.",
      color: "muted",
    });
  }

  return renderComponent(lines, theme);
};

/** Alias for callers that name the tool rather than the family. */
export const renderApplyPatchExpandedResult = renderExpandedApplyPatchResult;

// ---------------------------------------------------------------------------
// Shared summary rendering
// ---------------------------------------------------------------------------

function appendSummary(
  lines: RenderLine[],
  summary: string,
  color: ApplyPatchThemeColor | undefined,
  preserveLines: boolean,
): void {
  const source = summary.length > 0 ? summary : "No ApplyPatch result.";
  const summaryLines = source.split("\n");
  if (preserveLines) {
    for (const line of summaryLines) lines.push({ text: line, color, raw: true });
    return;
  }
  lines.push({ text: source, color });
}

// ---------------------------------------------------------------------------
// Canonical collapsed card
// ---------------------------------------------------------------------------

function collapsedHeader(
  failed: boolean,
  partial: boolean,
  operations: readonly OperationValue[],
): string {
  if (failed) return "ApplyPatch · failed";
  if (partial) return "ApplyPatch · partial";
  return `ApplyPatch · ${collapsedOutcomePhrase(operations)}`;
}

function collapsedOutcomePhrase(operations: readonly OperationValue[]): string {
  if (operations.length === 0) return "succeeded";
  const counts = countOperations(operations);
  const total = operations.length;
  if (counts.update === total) return fileCountPhrase(total, "updated");
  if (counts.create === total) return fileCountPhrase(total, "created");
  if (counts.delete === total) return fileCountPhrase(total, "deleted");
  return [
    counts.create > 0 ? fileCountPhrase(counts.create, "created") : "",
    counts.update > 0 ? fileCountPhrase(counts.update, "updated") : "",
    counts.delete > 0 ? fileCountPhrase(counts.delete, "deleted") : "",
  ].filter(Boolean).join(", ");
}

function fileCountPhrase(count: number, verb: string): string {
  return `${count} ${count === 1 ? "file" : "files"} ${verb}`;
}

/** Canonical per-file row: `M src/status.ts · +1 −1`, `A`/`D` for create/delete. */
function operationMarkRow(operation: OperationValue): string {
  const mark = operation.operation === "create_file"
    ? "A"
    : operation.operation === "delete_file"
      ? "D"
      : "M";
  const path = typeof operation.path === "string" ? operation.path : "(path unavailable)";
  const moveTo = typeof operation.moveTo === "string" ? ` → ${operation.moveTo}` : "";
  const added = integerField(operation, "addedLines");
  const removed = integerField(operation, "removedLines");
  const delta = added !== undefined || removed !== undefined ? ` · +${added ?? 0} −${removed ?? 0}` : "";
  return `${mark} ${path}${moveTo}${delta}`;
}

function appendCompactFailureDetails(lines: RenderLine[], details: RecordValue | undefined): void {
  const operations = operationRecords(details);
  for (const operation of operations) {
    lines.push({ text: `  ${operationMarkRow(operation)}`, color: "muted", raw: true });
  }

  const failure = recordField(details, "failed");
  if (failure) {
    lines.push({ text: `Failed operation: ${failedOperationLabel(failure)}`, color: "error" });
    const error = stringField(failure, "error");
    if (error) lines.push({ text: `Failure: ${error}`, color: "error", raw: true });
    for (const effect of stringArrayField(failure, "uncertainEffects")) {
      lines.push({ text: `Uncertain effect: ${effect}`, color: "error", raw: true });
    }
  }

  const notAttempted = stringArrayField(details, "notAttempted");
  if (notAttempted.length > 0) {
    lines.push({ text: `Not attempted (${notAttempted.length}): ${notAttempted.join(", ")}.`, color: "muted", raw: true });
  }
}

// ---------------------------------------------------------------------------
// Expanded view
// ---------------------------------------------------------------------------

function expandedHeader(failed: boolean, partial: boolean): string {
  if (failed) return "ApplyPatch · failed";
  if (partial) return "ApplyPatch · partial";
  return "ApplyPatch · succeeded";
}

function appendRequestedPatch(lines: RenderLine[], context: unknown, details: RecordValue | undefined): void {
  const original = originalInput(context);
  if (original !== undefined) {
    lines.push({ text: "Requested patch:", color: "accent", bold: true });
    appendRaw(lines, original, "toolDiffContext");
    return;
  }

  const retained = stringField(details, "requestedDiff");
  if (retained) {
    // This is only a fallback for restored/synthetic rows without native call
    // args.  Its execution-time truncation marker is retained honestly rather
    // than being mistaken for the original full input.
    lines.push({ text: "Requested patch retained with the result (no native call context was available):", color: "accent", bold: true });
    appendRaw(lines, retained, "toolDiffContext");
    return;
  }

  lines.push({ text: "Requested patch was not available in the native render context.", color: "muted" });
}

function appendOperations(lines: RenderLine[], details: RecordValue | undefined): void {
  const operations = operationRecords(details);
  if (operations.length === 0) return;
  lines.push({ text: "" });
  lines.push({ text: "Applied operations:", color: "accent", bold: true });
  for (const operation of operations) {
    lines.push({ text: operationMarkRow(operation), color: "muted", raw: true });
    const absolutePath = stringField(operation, "absolutePath");
    if (absolutePath) lines.push({ text: `  absolute path: ${absolutePath}`, color: "muted", raw: true });
    const changed = operation.changed;
    if (changed === false) lines.push({ text: "  changed: false", color: "muted" });
    const mutated = operation.mutated;
    if (mutated === false) lines.push({ text: "  mutated: false", color: "muted" });
    const bytes = integerField(operation, "bytes");
    if (bytes !== undefined) lines.push({ text: `  bytes: ${bytes}`, color: "muted" });
  }
}

function appendFailure(lines: RenderLine[], details: RecordValue | undefined): void {
  const failure = recordField(details, "failed");
  const notAttempted = stringArrayField(details, "notAttempted");
  if (!failure && notAttempted.length === 0) return;

  lines.push({ text: "" });
  if (failure) {
    lines.push({ text: "Failure accounting", color: "accent", bold: true });
    const index = integerField(failure, "index");
    lines.push({ text: `Stopped at operation ${index === undefined ? "?" : index + 1}: ${failedOperationLabel(failure)}`, color: "error" });
    const error = stringField(failure, "error");
    if (error) lines.push({ text: "Failure diagnostic:", color: "error", bold: true });
    if (error) appendRaw(lines, error, "error");
    const effects = stringArrayField(failure, "uncertainEffects");
    if (effects.length > 0) {
      lines.push({ text: "Uncertain effects of the failed operation:", color: "error", bold: true });
      for (const effect of effects) appendRaw(lines, effect, "error");
    }
  }

  if (notAttempted.length > 0) {
    lines.push({ text: `Not attempted (${notAttempted.length})`, color: "accent", bold: true });
    for (const operation of notAttempted) appendRaw(lines, `  ${operation}`, "muted");
  }
}

function appendRetainedFinalDiff(lines: RenderLine[], details: RecordValue | undefined): void {
  const finalDiff = stringField(details, "finalDiff");
  if (!finalDiff) return;
  lines.push({ text: "" });
  lines.push({ text: "Final diff:", color: "accent", bold: true });
  appendRaw(lines, finalDiff, "toolDiffContext", true);
}

function appendRaw(
  lines: RenderLine[],
  text: string,
  color: ApplyPatchThemeColor,
  diffColors = false,
): void {
  const logicalLines = text.split("\n");
  for (const line of logicalLines) {
    lines.push({ text: line, color: diffColors ? diffColor(line) : color, raw: true });
  }
}

// ---------------------------------------------------------------------------
// Result/context decoding
// ---------------------------------------------------------------------------

function asRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorResult(record: RecordValue | undefined): boolean {
  return record?.isError === true;
}

function resultText(record: RecordValue | undefined, failed: boolean): string {
  if (record) {
    const content = record.content;
    if (Array.isArray(content)) {
      const text = content
        .filter(isRecord)
        .map((entry) => typeof entry.text === "string" ? entry.text : "")
        .filter((text) => text.length > 0)
        .join("\n");
      if (text.length > 0) return text;
    } else if (typeof content === "string") {
      return content;
    }
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
  }
  return failed ? "ApplyPatch failed." : "No ApplyPatch result.";
}

function detailsRecord(record: RecordValue | undefined): RecordValue | undefined {
  if (record && isRecord(record.details)) return record.details;
  // A host may wrap a thrown extension error in an error/result field.  These
  // fallbacks only consume explicitly supplied details records; they never
  // read live state or reconstruct a request.
  if (record && isRecord(record.result) && isRecord(record.result.details)) return record.result.details;
  if (record && isRecord(record.error) && isRecord(record.error.details)) return record.error.details;
  // Direct request packets are useful to renderer tests and to hosts that
  // preserve the request result rather than nesting it under `details`.
  if (record && (Array.isArray(record.operations) || Array.isArray(record.applied))
    && (record.finalDiff === undefined || typeof record.finalDiff === "string")) return record;
  return undefined;
}

function originalInput(context: unknown): string | undefined {
  if (!isRecord(context)) return undefined;
  const args = context.args;
  if (typeof args === "string") return args;
  if (!isRecord(args)) return undefined;

  if (typeof args.patch === "string") return args.patch;
  if (Object.hasOwn(args, "operation")) {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return undefined;
    }
  }
  // For invalid calls, retaining the actual argument object is more honest
  // than inventing a patch body.  Only the call args are considered; context
  // state, cwd, and other host metadata are intentionally ignored.
  if (Object.hasOwn(args, "patch")) {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringField(record: RecordValue | undefined, key: string): string | undefined {
  return record && typeof record[key] === "string" ? record[key] as string : undefined;
}

function integerField(record: RecordValue | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function recordField(record: RecordValue | undefined, key: string): RecordValue | undefined {
  return record && isRecord(record[key]) ? record[key] : undefined;
}

function stringArrayField(record: RecordValue | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function operationRecords(details: RecordValue | undefined): OperationValue[] {
  const candidate = details?.operations;
  if (Array.isArray(candidate)) return candidate.filter(isRecord) as OperationValue[];
  const applied = details?.applied;
  if (Array.isArray(applied)) return applied.filter(isRecord) as OperationValue[];
  return [];
}

function failedOperationLabel(failure: RecordValue): string {
  const action = typeof failure.operation === "string" ? failure.operation : "operation";
  const path = typeof failure.path === "string" ? failure.path : "(path unavailable)";
  const moveTo = typeof failure.moveTo === "string" ? ` (moveTo ${failure.moveTo})` : "";
  return `${action} ${path}${moveTo}`;
}

function countOperations(operations: readonly OperationValue[]): { create: number; update: number; delete: number } {
  let create = 0;
  let update = 0;
  let del = 0;
  for (const operation of operations) {
    if (operation.operation === "create_file") create += 1;
    else if (operation.operation === "delete_file") del += 1;
    else update += 1;
  }
  return { create, update, delete: del };
}

function diffColor(line: string): ApplyPatchThemeColor {
  return line.startsWith("+")
    ? "toolDiffAdded"
    : line.startsWith("-")
      ? "toolDiffRemoved"
      : "toolDiffContext";
}

// ---------------------------------------------------------------------------
// Component and display wrapping
// ---------------------------------------------------------------------------

function renderComponent(
  lines: readonly RenderLine[],
  theme: ApplyPatchRendererTheme,
): ApplyPatchRendererComponent {
  return {
    render(width: number): string[] {
      const available = width === Number.POSITIVE_INFINITY
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(Number.isFinite(width) ? width - 2 : 80));
      const output: string[] = [];
      for (const line of lines) {
        for (const chunk of wrapPreserving(line.text, available)) {
          const styled = line.bold ? theme.bold(chunk) : chunk;
          const colored = line.color ? theme.fg(line.color, styled) : styled;
          output.push(colored);
        }
      }
      return output;
    },
    invalidate() {},
  };
}

/** Wraps without clipping: every code point remains in the returned rows. */
function wrapPreserving(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  if (width <= 0) return [value];

  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (current.length > 0 && characterWidth > 0 && currentWidth + characterWidth > width) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += character;
    currentWidth += characterWidth;
  }
  if (current.length > 0) rows.push(current);
  return rows.length > 0 ? rows : [""];
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    if ((code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x1f000 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}