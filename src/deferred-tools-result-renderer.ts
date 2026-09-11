/**
 * Native result rendering for `search_tools`.
 *
 * Discovery is a loader, not an executor.  The renderer therefore reports the
 * query and the authorization/activation outcome already returned by the
 * manager, while never consulting the live tool set or pretending that a
 * loaded tool was called.  The expanded arm uses the original query from
 * Pi's native render context when it is available; the manager deliberately
 * does not echo that query into the model result just for presentation.
 * The shared expansion wrapper owns the single expansion hint; this renderer
 * never emits its own and never hard-codes a key binding.
 */

import { expandableResult, type ToolResultRenderCallback } from "./tool-result-expansion";
import { wrapPreserving } from "./tool-result-wrap";

export interface DeferredToolRendererTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

export interface DeferredToolRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

export interface DeferredToolRendererComponent {
  render(width: number): string[];
  invalidate(): void;
}

export type DeferredToolResultRenderer = (
  value: unknown,
  options: DeferredToolRenderOptions,
  theme: DeferredToolRendererTheme,
  context?: unknown,
) => DeferredToolRendererComponent;

interface RecordValue {
  [key: string]: unknown;
}

interface RenderLine {
  text: string;
  color?: string;
  bold?: boolean;
  raw?: boolean;
}

interface SearchOutcome {
  query?: string;
  matched: string[];
  activated: string[];
  alreadyActive: string[];
  /** Matches withheld upstream of this result; absent when not recorded. */
  omitted?: number;
  outcome?: string;
  error: boolean;
  partial: boolean;
  summary: string;
  /** Whether the returned details actually describe a discovery outcome. */
  known: boolean;
}

/** Compact discovery status used by the shared expansion wrapper. */
export const renderDeferredToolResult: DeferredToolResultRenderer = (value, options, theme, context) => {
  const outcome = decodeOutcome(value, options, context);
  const lines: RenderLine[] = [];

  if (outcome.partial) {
    lines.push({ text: collapsedHeader(outcome, "partial"), color: "toolTitle", bold: true });
    lines.push({ text: "Discovery result is still streaming; only returned text is shown.", color: "muted" });
    appendCompactSummary(lines, outcome.summary, "muted");
    return renderComponent(lines, theme, true);
  }

  if (outcome.error) {
    lines.push({ text: collapsedHeader(outcome, outcomeLabel(outcome)), color: "toolTitle", bold: true });
    appendCompactSummary(lines, outcome.summary, "error");
    return renderComponent(lines, theme, true);
  }

  if (!outcome.known) {
    lines.push({ text: collapsedHeader(outcome), color: "toolTitle", bold: true });
    appendCompactSummary(lines, outcome.summary, "muted");
    return renderComponent(lines, theme, true);
  }

  if (outcome.activated.length > 0) {
    lines.push({ text: collapsedHeader(outcome, `activated ${outcome.activated.join(", ")}`), color: "toolTitle", bold: true });
  } else if (outcome.alreadyActive.length > 0) {
    lines.push({ text: collapsedHeader(outcome, `already active ${outcome.alreadyActive.join(", ")}`), color: "toolTitle", bold: true });
  } else {
    lines.push({ text: collapsedHeader(outcome, "no matches"), color: "toolTitle", bold: true });
  }
  if (outcome.activated.length > 0 && outcome.alreadyActive.length > 0) {
    lines.push({ text: `Already active (${outcome.alreadyActive.length}): ${outcome.alreadyActive.join(", ")}.`, color: "muted" });
  }
  return renderComponent(lines, theme, true);
};

/**
 * Full discovery detail callback.  All arrays and the retained omitted-match
 * count in the returned outcome are rendered, and the raw query is wrapped
 * rather than shortened.  No host context other than `args.query` is
 * inspected, and expansion never performs the discovered tool's operation.
 */
export const renderExpandedDeferredToolResult: DeferredToolResultRenderer = (value, options, theme, context) => {
  const outcome = decodeOutcome(value, options, context);
  const lines: RenderLine[] = [
    { text: "search_tools", color: "toolTitle", bold: true },
  ];

  if (outcome.query !== undefined) {
    lines.push({ text: `Query: ${outcome.query}`, color: "muted", raw: true });
  } else {
    lines.push({ text: "Query: not available in the native render context.", color: "muted" });
  }

  if (outcome.partial) {
    lines.push({ text: "Outcome: partial result; only returned text is shown.", color: "muted" });
    appendRaw(lines, outcome.summary, "muted");
    return renderComponent(lines, theme, false);
  }

  if (outcome.error) {
    lines.push({ text: `Outcome: ${outcomeLabel(outcome)}`, color: "error" });
    appendRaw(lines, outcome.summary, "error");
    return renderComponent(lines, theme, false);
  }

  if (!outcome.known) {
    appendRaw(lines, outcome.summary, "muted");
    return renderComponent(lines, theme, false);
  }

  if (outcome.matched.length === 0) {
    lines.push({ text: "Outcome: no authorized tools matched; no tools were activated.", color: "muted" });
  }
  lines.push({ text: "Matched authorized tools:", color: "accent", bold: true });
  appendNames(lines, outcome.matched);
  lines.push({ text: "Newly activated:", color: "accent", bold: true });
  appendNames(lines, outcome.activated);
  if (outcome.alreadyActive.length > 0) {
    lines.push({ text: "Already active:", color: "accent", bold: true });
    appendNames(lines, outcome.alreadyActive);
  }
  if (outcome.omitted !== undefined) {
    lines.push({ text: `Omitted matches: ${outcome.omitted}`, color: "muted" });
  }

  lines.push({ text: "" });
  if (outcome.activated.length > 0) {
    lines.push({
      text: `The ${outcome.activated.length === 1 ? "tool is" : "tools are"} available on the next turn.`,
      color: "success",
    });
  } else if (outcome.alreadyActive.length > 0) {
    lines.push({
      text: `The matched ${outcome.alreadyActive.length === 1 ? "tool was" : "tools were"} already active.`,
      color: "muted",
    });
  }
  const single = outcome.activated.length === 1
    ? outcome.activated[0]!
    : outcome.activated.length === 0 && outcome.alreadyActive.length === 1
      ? outcome.alreadyActive[0]!
      : undefined;
  lines.push({
    text: single !== undefined
      ? `No ${single} operation was executed by this search.`
      : "No discovered tool operation was executed by this search.",
    color: "muted",
  });

  return renderComponent(lines, theme, false);
};

/** Shared native expansion wiring for the one deferred discovery tool. */
export const deferredToolSearchRenderResult = expandableResult(
  renderDeferredToolResult,
  renderExpandedDeferredToolResult,
) as ToolResultRenderCallback;

/** Descriptive aliases for tests and callers that use the registered name. */
export const renderSearchToolsResult = renderDeferredToolResult;
export const renderExpandedSearchToolsResult = renderExpandedDeferredToolResult;
export const searchToolsRenderResult = deferredToolSearchRenderResult;

function collapsedHeader(outcome: SearchOutcome, suffix?: string): string {
  const parts = ["search_tools"];
  if (outcome.query !== undefined) parts.push(`"${compactWhitespace(outcome.query)}"`);
  if (suffix !== undefined && suffix.length > 0) parts.push(suffix);
  return parts.join(" · ");
}

function decodeOutcome(value: unknown, options: DeferredToolRenderOptions, context: unknown): SearchOutcome {
  const record = isRecord(value) ? value : undefined;
  const details = record && isRecord(record.details) ? record.details : undefined;
  const query = queryFromContext(context) ?? stringField(details, "query");
  const matched = stringArrayField(details, "matched");
  const activated = stringArrayField(details, "activated");
  const explicitAlreadyActive = stringArrayField(details, "alreadyActive");
  const alreadyActive = explicitAlreadyActive.length > 0
    ? explicitAlreadyActive
    : matched.filter((name) => !activated.includes(name));
  const omitted = integerField(details, "omitted");
  const summary = resultText(record);
  const error = record?.isError === true;
  const partial = options.isPartial === true;
  const outcome = stringField(details, "outcome");
  const known = details !== undefined
    && (Array.isArray(details.matched)
      || Array.isArray(details.activated)
      || Array.isArray(details.alreadyActive)
      || outcome !== undefined);
  return { query, matched, activated, alreadyActive, omitted, outcome, error, partial, summary, known };
}

function queryFromContext(context: unknown): string | undefined {
  if (!isRecord(context) || !isRecord(context.args)) return undefined;
  const args = context.args;
  return typeof args.query === "string" ? args.query : undefined;
}

function resultText(record: RecordValue | undefined): string {
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
  return "No search_tools result returned.";
}

function outcomeLabel(outcome: SearchOutcome): string {
  if (outcome.outcome === "unavailable" || /unavailable until session startup/i.test(outcome.summary)) return "unavailable";
  if (outcome.outcome === "invalid" || /^Invalid search_tools request:/i.test(outcome.summary)) return "invalid request";
  return outcome.outcome ?? "failed";
}

function stringField(record: RecordValue | undefined, key: string): string | undefined {
  return record && typeof record[key] === "string" ? record[key] as string : undefined;
}

function integerField(record: RecordValue | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function stringArrayField(record: RecordValue | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function appendNames(lines: RenderLine[], names: readonly string[]): void {
  if (names.length === 0) {
    lines.push({ text: "  (none)", color: "muted" });
    return;
  }
  for (const name of names) appendRaw(lines, `  ${name}`, "toolDiffContext");
}

function appendCompactSummary(lines: RenderLine[], summary: string, color: string): void {
  const text = summary.length > 0 ? summary : "No search_tools result returned.";
  for (const line of text.split("\n")) lines.push({ text: line, color, raw: true });
}

function appendRaw(lines: RenderLine[], text: string, color: string): void {
  for (const line of text.split("\n")) lines.push({ text: line, color, raw: true });
}

function renderComponent(
  lines: readonly RenderLine[],
  theme: DeferredToolRendererTheme,
  compact: boolean,
): DeferredToolRendererComponent {
  return {
    render(width: number): string[] {
      const available = width === Number.POSITIVE_INFINITY
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(Number.isFinite(width) ? width - 2 : 80));
      const output: string[] = [];
      for (const line of lines) {
        const chunks = compact
          ? [compactLine(line.text, available)]
          : wrapPreserving(line.text, available);
        for (const chunk of chunks) {
          const styled = line.bold ? theme.bold(chunk) : chunk;
          output.push(line.color ? theme.fg(line.color, styled) : styled);
        }
      }
      return output;
    },
    invalidate() {},
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactLine(value: string, width: number): string {
  const compact = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  if (compact.length <= width) return compact;
  return `${compact.slice(0, Math.max(1, width - 1))}…`;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}