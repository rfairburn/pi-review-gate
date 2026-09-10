/**
 * Expanded (Ctrl+O) detail view for the Subtasks* tool family (#59).
 *
 * One cohesive human-facing renderer for every operation result the Subtasks*
 * family returns. It is a presentation-only callback with Pi's native
 * `renderResult` signature `(value, options, theme, context?)`; the shared
 * expansion foundation from #57 — `expandableResult(collapsedRenderer,
 * expandedRenderer?)` in `src/tool-result-expansion.ts`, now landed — selects
 * it when the native `options.expanded` flag is set and keeps the collapsed
 * renderer otherwise (falling back to it if this callback throws or returns a
 * non-component). This module owns no key handlers, no expansion state, and no
 * renderResult wiring of its own; it never duplicates the shared expansion
 * machinery.
 *
 * Pi toggles each tool row's expanded state through its configured expansion
 * binding and passes that state to the registered `renderResult` as
 * `(value, { expanded, isPartial }, theme, context?)`. The Subtasks registration in
 * `src/execution/tool.ts` wires this callback as the helper's second argument —
 *
 *   renderResult: expandableResult(collapsedCallback, renderSubtaskResultExpanded),
 *
 * The collapsed callback is passed through unchanged, so #56's collapsed-card
 * rendering continues to apply untouched in every state except an explicit
 * `expanded: true`. The helper forwards the native options
 * (`{ expanded, isPartial }`) and the optional context to this
 * callback; this module's structural types mirror the helper's
 * `ToolResultTheme`/`ToolResultRenderer` exactly (they are deliberately not
 * imported here so this module compiles in trees without the #57 merge).
 *
 * Presentation contract (#59):
 * - Expansion presents only data the tool already returned. It never reruns an
 *   inspection, polls, fetches artifacts, reads logs, or widens any authority,
 *   retention, or redaction boundary. Private model reasoning is already
 *   excluded and every retained value already redacted upstream.
 * - Provenance is visibly separated: what the executor process observed
 *   (`executor_observed`), what the worker wrote in its final response
 *   (`worker_claim` — never treated as verification), reviewer verdicts
 *   (`reviewer_verdict` — official review records), and the authoritative
 *   task/landing state from durable records are rendered as distinct sections.
 * - Freshness is stated ("as of" the returned snapshot timestamp) with an
 *   explicit uncertainty note while any task is still active; unavailable
 *   sources, truncated records, and omitted ranges are disclosed, never cut
 *   silently.
 * - Simple acknowledgements (SubtasksWatch, SubtasksMarkClean) render only
 *   their returned fields — no invented detail — and an unrecognized result
 *   shape falls back to the returned summary alone.
 * - Long results stay bounded: every section is capped with an explicit
 *   omission disclosure, and deep-read chunks keep the retained text's own
 *   whitespace (line-level clipping to the render width is presentation only).
 */
import { isActiveTaskState, type BackgroundTaskState } from "./task-state";

/** Theme contract shared with the family's collapsed renderer. Structurally
 * identical to #57's `ToolResultTheme`. */
export interface SubtaskExpandedRendererTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/**
 * Native renderResult callback signature, matching #57's
 * `ToolResultRenderer` delegate contract (optional native context ignored by
 * this renderer). Directly compatible with the collapsed renderer in
 * src/execution/tool.ts, so the landed shared helper selects between them by
 * `options.expanded` without adapters.
 */
export type SubtaskExpandedResultRenderer = (
  value: unknown,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubtaskExpandedRendererTheme,
  context?: unknown,
) => unknown;

/** Tool names by operation action; kept in step with EXECUTION_TOOL_NAMES in
 * src/execution/tool.ts (imported there, not here, so the parent can wire this
 * module into tool.ts without a module cycle). */
const ACTION_TOOL_NAMES: Record<string, string> = {
  start: "SubtasksStart",
  add: "SubtasksAdd",
  inspect: "SubtasksInspect",
  watch: "SubtasksWatch",
  continue: "SubtasksContinue",
  steer: "SubtasksSteer",
  interrupt: "SubtasksInterrupt",
  force_merge: "SubtasksForceMerge",
  mark_clean: "SubtasksMarkClean",
};

/** Presentation bounds. Everything beyond a cap is disclosed, never invented. */
const MAX_RENDERED_TASKS = 24;
const MAX_TASK_COMMANDS = 6;
const MAX_TASK_ACTIVITY = 6;
const MAX_ENTRIES_PER_PROVENANCE_SECTION = 10;
const MAX_MATCH_LINES = 10;
const MAX_SOURCE_LINES = 12;
const MAX_UNAVAILABLE_LINES = 8;
const MAX_ERROR_EXECUTIONS = 4;
const MAX_TOTAL_LINES = 400;

/** Long-line clip that collapses whitespace (labels, summaries, previews of
 * already-compacted entry views), bounded by terminal display cells. */
function clipCollapsedWhitespace(value: string, width: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return clipToDisplayCells(compact, width);
}

/** Long-line clip that preserves the text's own whitespace (deep-read chunks:
 * newlines, indentation, tabs, and blank lines must survive presentation),
 * bounded by terminal display cells. */
function clipPreservingWhitespace(value: string, width: number): string {
  return clipToDisplayCells(value, width);
}

/**
 * Terminal display width of one code point (cell count, not UTF-16 units):
 * East Asian Wide/Fullwidth characters and default-emoji-presentation
 * characters (Unicode's Emoji_Presentation property, e.g. 🚀) occupy two
 * cells, combining marks and zero-width joiners occupy none, everything else
 * one. Ordinary returned evidence can carry CJK text or emoji, so clipping
 * must measure cells — a hand-picked range table alone misses emoji that
 * gained default-wide presentation later.
 */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

function codePointWidth(code: number): number {
  if (code === 0x200b
    || code === 0x200c
    || code === 0x200d
    || code === 0xfeff
    || (code >= 0x0300 && code <= 0x036f) // combining diacritical marks
    || (code >= 0xfe00 && code <= 0xfe0f)) { // variation selectors
    return 0;
  }
  if (EMOJI_PRESENTATION.test(String.fromCodePoint(code))) return 2;
  if ((code >= 0x1100 && code <= 0x115f) // Hangul Jamo
    || (code >= 0x2e80 && code <= 0x303e) // CJK radicals, symbols, punctuation
    || (code >= 0x3041 && code <= 0x33ff) // Hiragana..CJK compatibility
    || (code >= 0x3400 && code <= 0x4dbf) // CJK ext A
    || (code >= 0x4e00 && code <= 0x9fff) // CJK unified
    || (code >= 0xa000 && code <= 0xa4cf) // Yi
    || (code >= 0xac00 && code <= 0xd7a3) // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60) // fullwidth forms
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f) // emoji pictographs
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)) { // CJK ext B+
    return 2;
  }
  return 1;
}

/** Display width of a string in terminal cells. */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += codePointWidth(character.codePointAt(0)!);
  }
  return width;
}

/**
 * Clips a plain (unstyled) line to the supplied terminal cell budget with an
 * explicit ellipsis. Never returns a line wider than `cells` (zero or
 * negative budgets yield an empty line) and never assumes a minimum width.
 */
function clipToDisplayCells(value: string, cells: number): string {
  if (cells <= 0) return "";
  if (displayWidth(value) <= cells) return value;
  const budget = cells - 1; // reserve one cell for the ellipsis
  let used = 0;
  let clipped = "";
  for (const character of value) {
    const cells_ = codePointWidth(character.codePointAt(0)!);
    if (used + cells_ > budget) break;
    clipped += character;
    used += cells_;
  }
  return `${clipped}…`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ExpandedLine {
  text: string;
  color?: string;
  bold?: boolean;
  /** True to clip by length only, preserving the text's own whitespace. */
  preserve?: boolean;
}

class LineBuilder {
  private readonly lines: ExpandedLine[] = [];
  private truncatedNotice = false;

  add(text: string, color?: string, bold = false): void {
    if (this.lines.length >= MAX_TOTAL_LINES) {
      this.discloseTruncation();
      return;
    }
    this.lines.push({ text, color, bold });
  }

  /** Adds a line whose whitespace is significant (deep-read chunk content). */
  addPreserved(text: string, color?: string): void {
    if (this.lines.length >= MAX_TOTAL_LINES) {
      this.discloseTruncation();
      return;
    }
    this.lines.push({ text, color, preserve: true });
  }

  label(text: string): void {
    this.add(text, "accent");
  }

  heading(text: string): void {
    this.add(text, "toolTitle", true);
  }

  private discloseTruncation(): void {
    if (!this.truncatedNotice) {
      this.truncatedNotice = true;
      // Push past the cap by one so the disclosure itself is visible.
      this.lines.push({ text: "… expanded view truncated for bounded rendering; the complete returned result stays in the model transcript." });
    }
  }

  build(): ExpandedLine[] {
    return this.lines;
  }
}

/**
 * The expanded renderer callback for the Subtasks* family, wired as
 * `expandableResult`'s expanded renderer in src/execution/tool.ts; the
 * collapsed renderer stays untouched for the collapsed state.
 */
export const renderSubtaskResultExpanded: SubtaskExpandedResultRenderer = (value, options, theme) => {
  const lines = new LineBuilder();
  const record = isRecord(value) ? value : undefined;
  const isError = record?.isError === true;
  const summary = summaryText(record);
  const details = record && isRecord(record.details) ? record.details : undefined;

  if (isRecord(options) && options.isPartial === true) {
    // Native lifecycle: a still-streaming result must never be expanded from a
    // half-shaped payload; render the bounded pending view only.
    lines.heading(`${operationLabel(record?.details)} — result still streaming`);
    lines.add(summary, isError ? "error" : "warning");
    lines.add("Expanded detail becomes available once the operation returns.", "muted");
    return expandedComponent(lines.build(), theme);
  }

  if (!details) {
    // Not a recognized Subtasks* envelope (or a bare acknowledgement with no
    // details): show only the returned summary — nothing invented.
    lines.heading(operationLabel(details));
    lines.add(summary, isError ? "error" : undefined);
    if (record) {
      lines.add("No expandable Subtasks details were returned; only the returned summary is shown.", "muted");
    }
    return expandedComponent(lines.build(), theme);
  }

  const action = typeof details.action === "string" ? details.action : undefined;
  const toolName = action ? ACTION_TOOL_NAMES[action] ?? action : "Subtasks";

  if (isError) {
    renderErrorResult(lines, toolName, details);
    return expandedComponent(lines.build(), theme);
  }

  lines.heading(`${toolName} — expanded result`);
  lines.add(summary, isError ? "error" : undefined);
  if (action === "watch") {
    renderWatchAcknowledgement(lines, details);
  } else if (typeof details.cleared === "boolean" && Array.isArray(details.paths)) {
    renderMarkCleanAcknowledgement(lines, details);
  } else if (isRecord(details.evidence)) {
    // renderInspection appends the evidence sections itself below.
    renderInspection(lines, details);
    renderEvidenceRead(lines, details.evidence, details);
  } else if (Array.isArray(details.tasks) || typeof details.executionId === "string") {
    renderInspection(lines, details);
  } else {
    // A returned details record we do not recognize: present only what was
    // returned, never an inspection-shaped guess.
    lines.add("No expandable Subtasks details were returned; only the returned summary is shown.", "muted");
  }
  return expandedComponent(lines.build(), theme);
};

function summaryText(record: Record<string, any> | undefined): string {
  const content = record && Array.isArray(record.content) ? record.content[0] : undefined;
  if (isRecord(content) && typeof content.text === "string" && content.text.trim()) return content.text;
  return "No execution result.";
}

function operationLabel(details: unknown): string {
  const action = isRecord(details) && typeof details.action === "string" ? details.action : undefined;
  return action ? ACTION_TOOL_NAMES[action] ?? action : "Subtasks tool";
}

/** Text-component contract shared with the other tool renderers. The TUI
 * contract requires every rendered line to fit the supplied width: the
 * component honors the exact width (minus the shell padding) with no minimum
 * floor, so narrow rows never receive over-width lines. */
function expandedComponent(lines: readonly ExpandedLine[], theme: SubtaskExpandedRendererTheme) {
  return {
    render: (width: number): string[] => {
      const bounded = Math.max(0, Math.min(width, width - 2));
      return lines.map((line) => {
        const clipped = line.preserve
          ? clipPreservingWhitespace(line.text, bounded)
          : clipCollapsedWhitespace(line.text, bounded);
        if (line.color === undefined && !line.bold) return clipped;
        return theme.fg(line.color ?? "toolTitle", line.bold ? theme.bold(clipped) : clipped);
      });
    },
    invalidate() {},
  };
}

// ---------------------------------------------------------------------------
// Inspection results (start/add/inspect/continue/steer/interrupt/force_merge)
// ---------------------------------------------------------------------------

/** Renders a BackgroundInspection spread into the result details. */
function renderInspection(lines: LineBuilder, details: Record<string, any>): void {
  const updatedAt = typeof details.updatedAt === "string" ? details.updatedAt : undefined;
  lines.add(
    `Snapshot as of ${updatedAt ?? "an unrecorded time"}${anyActiveWarning(details)} — a point-in-time read; live work may have advanced.`,
    "muted",
  );
  lines.add(
    `execution ${stringOr(details.executionId, "?")} (${stringOr(details.kind, "background")}) · revision ${count(details.revision)} · root ${stringOr(details.root, "(unrecorded)")}`,
  );
  const scheduling = isRecord(details.scheduling) ? details.scheduling : undefined;
  if (scheduling) {
    lines.add(
      `Scheduler: ${count(scheduling.activeWorkers)}/${count(scheduling.configuredWorkerLimit)} workers active; `
      + `${count(scheduling.activePoolLeases)}/${count(scheduling.configuredPoolCapacity)} pool leases active; `
      + `${count(scheduling.dispatchPending)} task(s) pending dispatch here, ${count(scheduling.globallyDispatchPending)} globally; `
      + `${count(scheduling.estimatedImmediatelyAvailableSlots)} immediate slot(s) estimated.`,
      "muted",
    );
  }
  renderConflictGate(lines, details.conflictGate);
  renderTasks(lines, details);
}

function anyActiveWarning(details: Record<string, any>): string {
  const active = Array.isArray(details.tasks)
    && details.tasks.some((task: unknown) => isRecord(task) && isActiveTaskState(task.state));
  return active ? " — freshness uncertain: at least one task is still active" : "";
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function renderConflictGate(lines: LineBuilder, gate: unknown): void {
  if (!isRecord(gate)) return;
  lines.label("Conflict gate (automatic landings are blocked until markers are resolved and SubtasksMarkClean validates them):");
  lines.add(`  source ${stringOr(gate.sourceRoot, "?")} · activated ${stringOr(gate.activatedAt, "?")}`);
  lines.add(`  paths: ${Array.isArray(gate.paths) ? gate.paths.join(", ") : "(none recorded)"}`);
  if (typeof gate.reason === "string") lines.add(`  reason: ${gate.reason}`);
}

/** Task blocks: stable handles, lifecycle/control outcomes, and diagnostics. */
function renderTasks(lines: LineBuilder, details: Record<string, any>): void {
  const tasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  if (tasks.length === 0 && count(details.historicalCount) === 0) return;
  lines.label("Tasks (stable handles — retain for SubtasksSteer, SubtasksInterrupt, and SubtasksInspect):");
  if (count(details.archivedCount) > 0) {
    lines.add(
      `  (${count(details.archivedCount)} earlier settled task(s) are archived and not listed; SubtasksInspect with their taskId loads the integrity-checked archive.)`,
      "muted",
    );
  }
  const shown = tasks.slice(0, MAX_RENDERED_TASKS);
  for (const task of shown) renderTask(lines, task);
  if (tasks.length > shown.length) {
    lines.add(`  … ${tasks.length - shown.length} returned task(s) omitted from this expanded view.`, "muted");
  }
}

function renderTask(lines: LineBuilder, task: Record<string, any>): void {
  lines.add(`${stringOr(task.taskId, "(unrecorded handle)")} · ${stringOr(task.definition?.title, "(untitled)")} · ${stringOr(task.state, "unknown")}`);
  if (task.state === "queued") {
    lines.add(
      `  dispatch: ${task.dispatchState === "assigned_starting" ? "executor assigned; startup in progress" : "waiting for executor capacity"}`,
      "muted",
    );
  }
  lines.add(`  executor: ${executorLine(task)}`, "muted");
  const control = task.liveControl;
  if (isRecord(control)) {
    lines.add(
      `  live control: steer ${control.steer ? "yes" : "no"}, interrupt ${control.interrupt ? "yes" : "no"}`
      + `${typeof control.adapter === "string" ? ` (adapter ${control.adapter}, generation ${count(control.generation)})` : ""}`,
    );
  } else if (typeof task.liveControl === "undefined" && !isActiveTaskState(task.state)) {
    lines.add("  live control: none (task is not active)", "muted");
  } else {
    lines.add("  live control: not registered yet", "muted");
  }
  if (isRecord(task.bundle)) {
    lines.add(
      `  checkpoint bundle: operation ${stringOr(task.bundle.operationId, "?")} revision ${count(task.bundle.expectedRevision)} at ${stringOr(task.bundle.waveRoot, "?")} (verified checkpoint; SubtasksContinue may resume from it)`,
    );
  }
  const timing = isRecord(task.timing) ? task.timing : undefined;
  if (timing) {
    lines.add(
      `  timing (ms): total ${count(timing.totalMs)}; queued ${count(timing.queueMs)}; capture ${count(timing.captureMs)}; execution ${count(timing.executionMs)}; review ${count(timing.reviewMs)}; landing ${count(timing.landingMs)}`,
      "muted",
    );
  }
  if (typeof task.updatedAt === "string") lines.add(`  updated: ${task.updatedAt}`, "muted");
  if (typeof task.summary === "string" && task.summary.trim()) {
    lines.add(`  current authoritative outcome: ${task.summary.trim()}`);
  }
  if (typeof task.error === "string" && task.error.trim()) lines.add(`  error: ${task.error.trim()}`, "error");
  if (typeof task.reportPath === "string") lines.add(`  research report: ${task.reportPath}`);
  if (typeof task.interruptionMode === "string") {
    lines.add(`  interruption mode: ${task.interruptionMode}`, "muted");
  }
  const commands = Array.isArray(task.commands) ? task.commands.filter(isRecord) : [];
  if (commands.length > 0) {
    lines.add(`  commands (returned, newest ${Math.min(commands.length, MAX_TASK_COMMANDS)} of ${commands.length}):`, "muted");
    for (const command of commands.slice(-MAX_TASK_COMMANDS)) {
      lines.add(
        `    ${stringOr(command.action, "?")} ${stringOr(command.instructionId, "?")} · ${stringOr(command.status, "?")}`
        + `${command.interrupt === true ? " · interrupt requested before delivery" : ""}`
        + `${typeof command.error === "string" && command.error.trim() ? ` · ${command.error.trim()}` : ""}`,
      );
    }
  }
  if (typeof task.artifactDir === "string") lines.add(`  artifacts: ${task.artifactDir}`);
  const activity = Array.isArray(task.activity) ? task.activity.filter(isRecord) : [];
  if (activity.length > 0) {
    lines.add(`  activity (returned tail, newest last; earlier phases may be superseded):`, "muted");
    for (const event of activity.slice(-MAX_TASK_ACTIVITY)) {
      lines.add(`    - ${count(event.sequence)} · ${stringOr(event.phase, "?")} · ${stringOr(event.message, "")}`);
    }
  }
}

function executorLine(task: Record<string, any>): string {
  // Immutable identity reported by the actual invocation wins, then the
  // authoritative recorded selection, then the legacy entry id — exactly the
  // collapsed renderer's precedence, never a current-config inference.
  if (typeof task.executorModel === "string" && task.executorModel) {
    return `${task.executorModel} (reported by the actual invocation)`;
  }
  const selection = isRecord(task.executorSelection) ? task.executorSelection : undefined;
  if (selection) {
    if (selection.source === "pi" && typeof selection.model === "string") return `${selection.model} (recorded selection)`;
    if (typeof selection.id === "string" && selection.id) return `${selection.id} (recorded selection)`;
  }
  if (typeof task.executorEntryId === "string" && task.executorEntryId) {
    return `${task.executorEntryId} (legacy recorded entry)`;
  }
  return "executor pending";
}

// ---------------------------------------------------------------------------
// Evidence reads (inspect with the evidence selector)
// ---------------------------------------------------------------------------

function renderEvidenceRead(lines: LineBuilder, evidence: unknown, details: Record<string, any>): void {
  if (!isRecord(evidence)) return;
  const mode = stringOr(evidence.mode, "unknown");
  lines.label(`Evidence read (mode: ${mode}) — bounded, indexed navigation over already-redacted retained artifacts; private model reasoning is excluded:`);
  const snapshot = isRecord(evidence.snapshot) ? evidence.snapshot : undefined;
  if (snapshot) {
    const total = count(snapshot.totalEntries);
    const sources = Array.isArray(snapshot.sources) ? snapshot.sources.filter(isRecord) : [];
    lines.add(`  ${total} indexed ${total === 1 ? "entry" : "entries"} across ${sources.length} source(s); streams are observed data, worker claims never imply verification.`);
    const capability = isRecord(snapshot.capability) ? snapshot.capability : undefined;
    if (capability?.toolEvidence === "unavailable") {
      lines.add(`  tool evidence unavailable: ${stringOr(capability.reason, "no tool records")}`, "warning");
    }
    const diagnostics = isRecord(snapshot.diagnostics) ? snapshot.diagnostics : undefined;
    if (diagnostics) {
      const bounds = [
        `scanned ${count(diagnostics.recordsScanned)} record(s)`,
        `${count(diagnostics.oversizedRecords)} oversized`,
        `${count(diagnostics.skippedRecords)} skipped`,
      ];
      if (diagnostics.recordsOmitted !== undefined) bounds.push(`${count(diagnostics.recordsOmitted)} record(s) omitted by rolling windows/budgets`);
      if (diagnostics.entryCapReached === true) bounds.push("entry cap reached");
      if (diagnostics.contentRetentionExhausted === true) bounds.push("content retention exhausted");
      if (diagnostics.rawRetentionExhausted === true) bounds.push("raw retention budget exhausted");
      lines.add(`  indexing diagnostics: ${bounds.join("; ")}`, "muted");
    }
    const shownSources = sources.slice(0, MAX_SOURCE_LINES);
    for (const source of shownSources) {
      lines.add(
        `  source ${stringOr(source.sourceId, "?")} · ${stringOr(source.adapter, "?")}/${stringOr(source.stream, "?")} · ${count(source.records)} record(s)`
        + `${typeof source.firstAt === "string" && typeof source.lastAt === "string" ? ` · ${source.firstAt.slice(0, 19)} → ${source.lastAt.slice(0, 19)}` : ""}`
        + `${typeof source.file === "string" ? ` · ${source.file}` : ""}`,
      );
    }
    if (sources.length > shownSources.length) {
      lines.add(`  … ${sources.length - shownSources.length} returned source(s) omitted from this expanded view.`, "muted");
    }
    const unavailable = Array.isArray(snapshot.unavailable) ? snapshot.unavailable.filter(isRecord) : [];
    if (unavailable.length > 0) {
      lines.add(`  unavailable (disclosed gaps; ${Math.min(unavailable.length, MAX_UNAVAILABLE_LINES)} of ${unavailable.length} shown):`, "warning");
      for (const item of unavailable.slice(0, MAX_UNAVAILABLE_LINES)) {
        lines.add(`    ${stringOr(item.source, "task")} · ${stringOr(item.reason, "?")} · ${stringOr(item.detail, "")}`, "warning");
      }
    }
  }

  // Provenance-separated entry sections: what was observed, what the worker
  // wrote, and what reviewers decided are never merged into one narrative.
  const entries = Array.isArray(evidence.entries) ? evidence.entries.filter(isRecord) : [];
  const sections: Array<{ provenance: string; label: string; color: string }> = [
    { provenance: "executor_observed", label: "Observed evidence (executor_observed — what the executor process actually recorded; not verification by itself)", color: "muted" },
    { provenance: "worker_claim", label: "Worker claims (worker_claim — statements from the worker's final responses; never treated as verification)", color: "warning" },
    { provenance: "reviewer_verdict", label: "Reviewer verdicts (reviewer_verdict — official review records)", color: "accent" },
  ];
  for (const section of sections) {
    const sectionEntries = entries.filter((entry) => entry.provenance === section.provenance);
    if (sectionEntries.length === 0) continue;
    lines.label(section.label);
    const shown = sectionEntries.slice(0, MAX_ENTRIES_PER_PROVENANCE_SECTION);
    for (const entry of shown) renderEvidenceEntry(lines, entry, section.color);
    if (sectionEntries.length > shown.length) {
      lines.add(`  … ${sectionEntries.length - shown.length} ${section.provenance} ${sectionEntries.length - shown.length === 1 ? "entry" : "entries"} in this read omitted from the expanded view (the full page stays in the model result).`, "muted");
    }
  }
  const other = entries.filter((entry) => sections.every((section) => section.provenance !== entry.provenance));
  if (other.length > 0) {
    lines.label("Other returned entries (provenance not in the observed/claim/verdict trio):");
    for (const entry of other.slice(0, MAX_ENTRIES_PER_PROVENANCE_SECTION)) renderEvidenceEntry(lines, entry, undefined);
  }
  if (entries.length === 0 && mode !== "find" && mode !== "call" && mode !== "entry") {
    lines.add("  no entries were returned by this read", "muted");
  }

  const matches = Array.isArray(evidence.matches) ? evidence.matches.filter(isRecord) : [];
  if (matches.length > 0) {
    const summary = isRecord(evidence.matchSummary) ? evidence.matchSummary : undefined;
    if (summary) {
      lines.label(`Matches for "${stringOr(summary.query, "?")}": ${count(summary.totalMatches)} total${summary.matchesTruncated === true ? " (list truncated)" : ""}`);
    }
    const shown = matches.slice(0, MAX_MATCH_LINES);
    for (const match of shown) {
      lines.add(`  match [${count(match.index)}] ${stringOr(match.entryId, "?")} (${stringOr(match.kind, "?")}): ${stringOr(match.snippet, "")}`);
    }
    if (matches.length > shown.length) {
      lines.add(`  … ${matches.length - shown.length} returned match(es) omitted from this expanded view.`, "muted");
    }
    lines.add("  (matches carry entry kind only; deep-read an entryId for its retained content and provenance.)", "muted");
  }

  renderCallPair(lines, evidence.callPair);
  renderDeepContent(lines, evidence.deepContent);
  renderContinuation(lines, evidence);
  renderAuthoritativeContext(lines, evidence.context, details);
}

function renderEvidenceEntry(lines: LineBuilder, entry: Record<string, any>, color: string | undefined): void {
  const meta = [
    stringOr(entry.kind, "?"),
    typeof entry.toolName === "string" ? entry.toolName : undefined,
    typeof entry.status === "string" ? entry.status : undefined,
    typeof entry.provenance === "string" ? entry.provenance : undefined,
    typeof entry.at === "string" ? entry.at.slice(0, 19) : undefined,
  ].filter((value) => value !== undefined).join(" · ");
  lines.add(
    `  [${count(entry.index)}] ${stringOr(entry.entryId, "?")} — ${meta}`
    + `${typeof entry.callId === "string" ? ` · callId ${entry.callId}` : ""}`
    + `${entry.truncatedContent === true ? " · source record truncated at retention cap" : ""}`,
    color,
  );
  if (typeof entry.preview === "string") {
    // Previews are already whitespace-compacted upstream; clip by length only
    // so the compaction the model received is shown unchanged.
    lines.addPreserved(`    ${entry.preview}`, color);
  }
  if (typeof entry.pairedWith === "string") {
    lines.add(`    paired with: ${entry.pairedWith}${entry.pairingScopedToSource === true ? " (pairing decided by this entry's own source stream)" : ""}`, "muted");
  }
  if (isRecord(entry.source) && typeof entry.source.sourceId === "string") {
    lines.add(`    source: ${entry.source.sourceId} · ${stringOr(entry.source.adapter, "?")}/${stringOr(entry.source.stream, "?")}`, "muted");
  }
}

function renderCallPair(lines: LineBuilder, pair: unknown): void {
  if (!isRecord(pair)) return;
  lines.label("Call/result link (callId navigation; a call without an observed result stays in flight):");
  const call = isRecord(pair.call) ? pair.call : undefined;
  const callId = call ? stringOr(call.callId, "?") : "?";
  lines.add(`  call ${callId}: status ${stringOr(pair.status, "unknown")}${call ? "" : " · no call record found"}`);
  if (call) {
    lines.add(`    call [${count(call.index)}] ${stringOr(call.entryId, "?")}: ${stringOr(call.preview, "")}`);
  }
  const result = isRecord(pair.result) ? pair.result : undefined;
  if (result) {
    lines.add(`    result [${count(result.index)}] ${stringOr(result.entryId, "?")} · ${stringOr(result.status, "unknown")}: ${stringOr(result.preview, "")}`);
  } else {
    lines.add("    result: not observed yet (in flight). A later in-flight status is never evidence of success.", "warning");
  }
}

function renderDeepContent(lines: LineBuilder, deep: unknown): void {
  if (!isRecord(deep)) return;
  lines.label(
    `Retained content chunk (deep read ${stringOr(deep.entryId, "?")} · chunk ${count(deep.chunkIndex)} · ${count(deep.contentBytes)} retained byte(s)`
    + `${deep.truncatedContent === true ? " · source record truncated at retention cap" : ""}) — verbatim whitespace:`,
  );
  const content = typeof deep.content === "string" ? deep.content : "";
  for (const contentLine of content.split("\n")) lines.addPreserved(`    ${contentLine}`);
  if (typeof deep.note === "string") lines.add(`  note: ${deep.note}`, "muted");
  if (deep.hasMore === true) {
    lines.add(`  more content: continue with entryId=${stringOr(deep.entryId, "?")} chunkIndex=${count(deep.nextChunk)}.`, "muted");
  }
}

function renderContinuation(lines: LineBuilder, evidence: Record<string, any>): void {
  if (evidence.nextIndex !== undefined) {
    lines.add(`  more entries available: continue the ranged read with index=${count(evidence.nextIndex)}.`, "muted");
  }
  if (typeof evidence.cursor === "string") {
    lines.add(
      `  incremental cursor (pass back in a later inspect for only newer entries; expired/replaced cursors are rejected explicitly): ${evidence.cursor}`,
      "muted",
    );
  }
}

function renderAuthoritativeContext(lines: LineBuilder, context: unknown, details: Record<string, any>): void {
  if (!isRecord(context)) return;
  lines.label("Authoritative context (durable records — independent of the evidence streams above):");
  if (typeof context.state === "string") {
    lines.add(`  authoritative state: ${context.state}${isActiveTaskState(context.state as BackgroundTaskState) ? " (still active — freshness uncertain)" : ""}`);
  }
  const current = isRecord(context.currentCommand) ? context.currentCommand : undefined;
  if (current) {
    lines.add(
      `  current command (in flight; result NOT yet observed): ${stringOr(current.toolName, "tool")} ${stringOr(current.preview, "")}`
      + `${current.elapsedMs !== undefined ? ` · running ~${Math.round(count(current.elapsedMs) / 1000)}s` : ""}`
      + `${typeof current.entryId === "string" ? ` · entry ${current.entryId}` : ""}`,
      "warning",
    );
  }
  const assignment = isRecord(context.assignment) ? context.assignment : undefined;
  if (assignment && Array.isArray(assignment.history) && assignment.history.length > 0) {
    const currentPart = isRecord(assignment.current)
      ? `current: ${stringOr(assignment.current.adapter, "?")}${typeof assignment.current.model === "string" ? `/${assignment.current.model}` : ""}; `
      : "";
    const history = assignment.history
      .map((item: unknown) => isRecord(item)
        ? `${stringOr(item.reason, "?")}@${stringOr(item.at, "?").slice(0, 19)} (${stringOr(item.adapter, "?")})`
        : "")
      .filter(Boolean)
      .join(", ");
    lines.add(`  assignments: ${currentPart}${history}`);
  }
  const attempts = Array.isArray(context.attempts) ? context.attempts.filter(isRecord) : [];
  if (attempts.length > 0) {
    lines.add(`  attempts: ${attempts.map((attempt) => `#${count(attempt.attempt)}/turn ${count(attempt.turn)}${typeof attempt.outcome === "string" ? ` ${attempt.outcome}` : ""}`).join(", ")}`);
  }
  const steering = Array.isArray(context.steering) ? context.steering.filter(isRecord) : [];
  if (steering.length > 0) {
    lines.add(`  steering: ${steering.map((item) => `${stringOr(item.action, "?")} ${stringOr(item.instructionId, "?")} · ${stringOr(item.status, "?")}`).join(", ")}`);
  }
  const changed = isRecord(context.changedFiles) ? context.changedFiles : undefined;
  if (changed) {
    const tracked = Array.isArray(changed.trackedPaths) ? changed.trackedPaths : [];
    const untracked = Array.isArray(changed.untrackedPaths) ? changed.untrackedPaths : [];
    const paths = untracked.length > 0
      ? `[tracked: ${tracked.join(", ")} | untracked task files: ${untracked.join(", ")}]`
      : `paths: ${tracked.join(", ") || "(none recorded)"}`;
    lines.add(`  changed files (${stringOr(changed.landingStatus, "?")}, authoritative landing state): ${paths} — ${stringOr(changed.note, "")}`);
  }
  const review = isRecord(context.review) ? context.review : undefined;
  if (review) {
    const reviewers = Array.isArray(review.reviewers) ? review.reviewers.filter(isRecord) : [];
    lines.add(
      `  review (official verdicts): aggregate ${stringOr(review.aggregate, "?")} over ${count(review.cycles)} ${count(review.cycles) === 1 ? "cycle" : "cycle(s)"}`
      + `; latest reviewers: ${reviewers.map((reviewer) => `${stringOr(reviewer.reviewerId, "?")}=${stringOr(reviewer.verdict, "?")}`).join(", ") || "none recorded"}`,
    );
    if (typeof review.caveat === "string") {
      lines.add(`  review caveat (completeness not guaranteed): ${review.caveat}`, "warning");
    }
  }
  // The inspected task's durable record stays the landing truth in evidence
  // mode: name its state and outcome beside the evidence page.
  const evidenceTaskId = isRecord(details.evidence) ? details.evidence.taskId : undefined;
  if (typeof evidenceTaskId === "string") {
    const tasks = Array.isArray(details.tasks) ? details.tasks : [];
    const task = tasks.find((candidate: unknown) => isRecord(candidate) && candidate.taskId === evidenceTaskId);
    if (isRecord(task)) {
      lines.add(`  inspected task ${evidenceTaskId} · durable state ${stringOr(task.state, "unknown")} · summary ${stringOr(task.summary, "(none recorded)")}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Error results
// ---------------------------------------------------------------------------

function renderErrorResult(lines: LineBuilder, toolName: string, details: Record<string, any>): void {
  lines.heading(`${toolName} — expanded error result`);
  lines.add(`diagnostic: ${stringOr(details.diagnostic, "(no diagnostic returned)")}`, "error");
  if (details.evidenceSelectorError === true) {
    // #61: read-only selector failures are task-scoped by design; the expanded
    // view must not render anything beyond the returned diagnostic and its
    // bounded navigation hint.
    lines.add("Task-scoped evidence navigation failure: no other execution's state is included by design.", "muted");
    return;
  }
  const source = isRecord(details.sourceWorkspace) ? details.sourceWorkspace : undefined;
  if (source) {
    lines.add(`source workspace: ${stringOr(source.disposition, "?")} — ${stringOr(source.instruction, "")}`);
  }
  const recovery = Array.isArray(details.recovery) ? details.recovery.filter(isRecord) : [];
  if (recovery.length > 0) {
    lines.label("Recovery guidance (returned with the failure):");
    for (const item of recovery) {
      lines.add(`  - ${stringOr(item.action, "?")}: ${stringOr(item.instruction, "")}`);
    }
  }
  const executions = Array.isArray(details.executions) ? details.executions.filter(isRecord) : [];
  if (executions.length > 0) {
    lines.label(`Durable execution state as of the failure (${Math.min(executions.length, MAX_ERROR_EXECUTIONS)} of ${executions.length} shown):`);
    for (const inspection of executions.slice(0, MAX_ERROR_EXECUTIONS)) {
      if (!isRecord(inspection)) continue;
      lines.add(`execution ${stringOr(inspection.executionId, "?")} (${stringOr(inspection.kind, "?")}) · revision ${count(inspection.revision)} · updated ${stringOr(inspection.updatedAt, "?")}`);
      renderTasks(lines, inspection);
      renderConflictGate(lines, inspection.conflictGate);
    }
    if (executions.length > MAX_ERROR_EXECUTIONS) {
      lines.add(`  … ${executions.length - MAX_ERROR_EXECUTIONS} returned execution group(s) omitted from this expanded view.`, "muted");
    }
  }
}

// ---------------------------------------------------------------------------
// Simple acknowledgements: only returned fields, nothing invented
// ---------------------------------------------------------------------------

function renderWatchAcknowledgement(lines: LineBuilder, details: Record<string, any>): void {
  lines.add("Returned watch acknowledgement (one-shot checkpoint; expansion adds no data beyond what was returned):", "muted");
  lines.add(`  execution: ${stringOr(details.executionId, "?")}`);
  lines.add(`  checkpoint after: ${formatDuration(count(details.afterMs))}`);
  if (typeof details.armedAt === "string") lines.add(`  armed at: ${details.armedAt}`);
  if (typeof details.dueAt === "string") lines.add(`  due at: ${details.dueAt}`);
  lines.add(`  replaced the prior watch for this execution: ${details.replaced === true ? "yes" : "no"}`);
}

function renderMarkCleanAcknowledgement(lines: LineBuilder, details: Record<string, any>): void {
  lines.add("Returned acknowledgement (expansion adds no data beyond what was returned):", "muted");
  lines.add(`  conflict gate cleared: ${details.cleared === true ? "yes" : "no"}`);
  lines.add(`  paths: ${Array.isArray(details.paths) && details.paths.length > 0 ? details.paths.join(", ") : "(none)"}`);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0 && milliseconds > 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0 && milliseconds > 0) return `${milliseconds / 60_000}m`;
  return `${milliseconds / 1_000}s`;
}