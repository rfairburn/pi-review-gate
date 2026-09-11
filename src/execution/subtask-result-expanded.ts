/**
 * Expanded (Ctrl+O / configured expansion binding) detail view for the
 * Subtasks* tool family (#93, canonical examples 6–14).
 *
 * One cohesive human-facing renderer for every operation result the Subtasks*
 * family returns. It is a presentation-only callback with Pi's native
 * `renderResult` signature `(value, options, theme, context?)`; the shared
 * expansion foundation from #57 — `expandableResult(collapsedRenderer,
 * expandedRenderer?)` in `src/tool-result-expansion.ts` — selects it when the
 * native `options.expanded` flag is set and keeps the collapsed renderer
 * otherwise (falling back to it if this callback throws or returns a
 * non-component). This module owns no key handlers, no expansion state, and no
 * renderResult wiring of its own; it never duplicates the shared expansion
 * machinery.
 *
 * The expand/collapse key hint is added centrally by the shared
 * `expandableResult` wrapper: this module emits headers and bodies only and
 * never renders its own `(ctrl+o …)` hint.
 *
 * The native `context.args` carries the actual recorded tool-call request
 * fields. Per #93 the expanded views reuse those recorded arguments rather
 * than a duplicated preview: steer/continue instructions, interrupt/force-merge
 * modes, inspect evidence selectors, and the start workspace are shown exactly
 * as the model submitted them, without a second human-only redaction layer
 * (upstream protections applied before content reached the model are separate
 * and unchanged).
 *
 * Presentation contract (#93):
 * - Expansion presents only data the tool already returned. It never reruns an
 *   inspection, polls, fetches artifacts, reads logs, or widens any authority,
 *   retention, or redaction boundary. Private model reasoning is already
 *   excluded upstream; model-visible content is shown in full.
 * - Evidence reads are mode-specific and complete: the find query and every
 *   returned match, the requested range and every returned entry, the full
 *   deep-read chunk with its own whitespace, and the actual call/result pair.
 *   No presentation-side caps replace returned content, and long lines are
 *   wrapped into width-safe rows without dropping any character.
 * - Start/Add expansion shows the submitted task definitions (instructions,
 *   acceptance criteria, relevant context) and the actual dispatch provenance:
 *   when the renderer-only live projection (or the returned record itself)
 *   carries a transport-boundary dispatch record, the full captured sent
 *   prompt, base commit, and worker worktree are shown with their capture
 *   provenance; a queued task says "not yet sent"/"not yet available"; a
 *   record that predates its own dispatch says exactly that. No prompt is ever
 *   reconstructed from the task definition or labeled exact.
 * - Steering/continuation acknowledgements are transport facts only: delivery
 *   status never establishes task compliance, and the submitted instruction is
 *   never mislabeled as the entire delivered adapter message.
 * - Provenance is visibly separated: what the executor process observed
 *   (`executor_observed`), what the worker wrote in its final response
 *   (`worker_claim` — never treated as verification), reviewer verdicts
 *   (`reviewer_verdict` — official review records), and the authoritative
 *   task/landing state from durable records are rendered as distinct sections.
 * - Freshness is stated ("as of" the returned snapshot timestamp) with an
 *   explicit uncertainty note while any task is still active; unavailable
 *   sources, truncated records, and omitted ranges are disclosed, never cut
 *   silently.
 */
import { isActiveTaskState, type BackgroundTaskState } from "./task-state";

/** Theme contract shared with the family's collapsed renderer. Structurally
 * identical to #57's `ToolResultTheme`. */
export interface SubtaskExpandedRendererTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/** Native renderResult context subset: the actual recorded tool-call
 * arguments (`args`) drive the request-field sections of the expanded views. */
export interface SubtaskExpandedRendererContext {
  readonly args?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Native renderResult callback signature, matching #57's
 * `ToolResultRenderer` delegate contract. The optional native context carries
 * `context.args` (the actual request fields); older hosts and tests may omit
 * it. Directly compatible with the collapsed renderer in src/execution/tool.ts,
 * so the landed shared helper selects between them by `options.expanded`
 * without adapters.
 */
export type SubtaskExpandedResultRenderer = (
  value: unknown,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubtaskExpandedRendererTheme,
  context?: SubtaskExpandedRendererContext,
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

/**
 * No presentation-side content cap: expanded rendering is complete. The only
 * width handling is row wrapping — every character of every returned line
 * reaches the display, split into width-safe rows without dropping or
 * compacting any character.
 */

/** Terminal display width of one code point (cell count, not UTF-16 units):
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
  /** True to preserve the text's own whitespace when wrapping. */
  preserve?: boolean;
}

class LineBuilder {
  private readonly lines: ExpandedLine[] = [];

  add(text: string, color?: string, bold = false): void {
    this.lines.push({ text, color, bold });
  }

  /** Adds a line whose whitespace is significant (submitted text, deep-read
   * chunk content, delivered continuations). */
  addPreserved(text: string, color?: string): void {
    this.lines.push({ text, color, preserve: true });
  }

  label(text: string): void {
    this.add(text, "accent");
  }

  heading(text: string): void {
    this.add(text, "toolTitle", true);
  }

  build(): ExpandedLine[] {
    return this.lines;
  }
}

/** Wraps one plain (unstyled) line into width-safe display rows without
 * dropping or altering any character: no whitespace compaction, no ellipsis.
 * Zero or negative budgets yield a single empty row (a narrow row still renders). */
function wrapByDisplayCells(value: string, cells: number): string[] {
  if (cells <= 0) return [""];
  if (displayWidth(value) <= cells) return [value];
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const character of value) {
    const width = codePointWidth(character.codePointAt(0)!);
    if (width > cells) {
      // A single code point wider than the row cannot fit anywhere: emit it
      // alone rather than dropping it or looping.
      if (row) rows.push(row);
      rows.push(character);
      row = "";
      used = 0;
      continue;
    }
    if (used + width > cells) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += character;
    used += width;
  }
  if (row || rows.length === 0) rows.push(row);
  return rows;
}

/**
 * The expanded renderer callback for the Subtasks* family, wired as
 * `expandableResult`'s expanded renderer in src/execution/tool.ts; the
 * collapsed renderer stays untouched for the collapsed state.
 */
export const renderSubtaskResultExpanded: SubtaskExpandedResultRenderer = (value, options, theme, context) => {
  const lines = new LineBuilder();
  const record = isRecord(value) ? value : undefined;
  const isError = record?.isError === true;
  const summary = summaryText(record);
  const details = record && isRecord(record.details) ? record.details : undefined;
  const args = argsOf(context);

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

  if (isError) {
    renderErrorResult(lines, action ? ACTION_TOOL_NAMES[action] ?? action : "Subtasks", details);
    return expandedComponent(lines.build(), theme);
  }

  if (action === "watch") {
    renderWatch(lines, details, args);
  } else if (action === "continue") {
    renderContinueOperation(lines, details, args);
  } else if (action === "steer") {
    renderSteer(lines, details, args);
  } else if (action === "interrupt") {
    renderInterrupt(lines, details, args);
  } else if (action === "force_merge") {
    renderForceMerge(lines, details, args);
  } else if (typeof details.cleared === "boolean" && Array.isArray(details.paths)) {
    // SubtasksMarkClean returns { cleared, paths } with no action tag.
    renderMarkClean(lines, details);
  } else if (action === "inspect") {
    renderInspect(lines, details, args);
  } else if (action === "start" || action === "add") {
    renderLifecycle(lines, details, args);
  } else {
    // A returned details record we do not recognize: present only what was
    // returned, never an operation-shaped guess.
    lines.heading(operationLabel(details));
    lines.add(summary);
    lines.add("No expandable Subtasks details were returned; only the returned summary is shown.", "muted");
  }
  return expandedComponent(lines.build(), theme);
};

function argsOf(context: unknown): Record<string, any> | undefined {
  return isRecord(context) && isRecord(context.args) ? context.args : undefined;
}

function summaryText(record: Record<string, any> | undefined): string {
  const content = record && Array.isArray(record.content) ? record.content[0] : undefined;
  if (isRecord(content) && typeof content.text === "string" && content.text.trim()) return content.text;
  return "No execution result.";
}

function operationLabel(details: unknown): string {
  const action = isRecord(details) && typeof details.action === "string" ? details.action : undefined;
  return action ? ACTION_TOOL_NAMES[action] ?? action : "Subtasks tool";
}

/** Text-component contract shared with the other tool renderers. Every line is
 * rendered losslessly: logical lines are split on their own newlines and each
 * segment is wrapped into width-safe display rows without compacting,
 * trimming, or dropping any character — acceptance criteria, queries,
 * previews, outcomes, and submitted text keep their exact whitespace. Long
 * lines wrap; nothing is clipped. */
function expandedComponent(lines: readonly ExpandedLine[], theme: SubtaskExpandedRendererTheme) {
  return {
    render: (width: number): string[] => {
      const bounded = Math.max(0, Math.min(width, width - 2));
      const rows: string[] = [];
      for (const line of lines) {
        const wrapped = line.text.split("\n").flatMap((text) => wrapByDisplayCells(text, bounded));
        for (const row of wrapped) {
          if (line.color === undefined && !line.bold) rows.push(row);
          else rows.push(theme.fg(line.color ?? "toolTitle", line.bold ? theme.bold(row) : row));
        }
      }
      return rows;
    },
    invalidate() {},
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** Human-readable duration ("30 minutes") for requested checkpoints. */
function durationWords(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0 && milliseconds > 0) {
    const hours = milliseconds / 3_600_000;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (milliseconds % 60_000 === 0 && milliseconds > 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round((milliseconds / 1_000) * 10) / 10;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Aggregate state word for a set of task records: the first active task's
 * merged state (the live projection wins per task), else the first task's. */
function aggregateStateWord(tasks: Array<Record<string, any>>, dispatchView?: Record<string, any>): string {
  const states = tasks.map((task) => {
    const live = dispatchViewEntry(dispatchView, task.taskId);
    return (live && typeof live.state === "string" ? live.state : task.state) as unknown;
  });
  // isActiveTaskState is a Set lookup: unknown strings simply report inactive.
  const activeIndex = states.findIndex((state) => typeof state === "string" && isActiveTaskState(state as BackgroundTaskState));
  if (activeIndex >= 0) return stringOr(states[activeIndex], "active");
  if (states.length > 0) return stringOr(states[0], "settled");
  return "no tasks";
}

/** One task's entry in the renderer-only dispatch projection, by exact task
 * identity — concurrent Start/Add rows for different executions never share a
 * row-local state key, and a projection entry always belongs to its own task. */
function dispatchViewEntry(view: Record<string, any> | undefined, taskId: unknown): Record<string, any> | undefined {
  if (!view || !Array.isArray(view.tasks)) return undefined;
  const entry = view.tasks.find((candidate) => isRecord(candidate) && candidate.taskId === taskId);
  return isRecord(entry) ? entry : undefined;
}

/** The actual dispatch record for one task: the live projection wins, then the
 * returned record's own snapshot. Absent means not yet sent — never inferred. */
function dispatchRecordOf(live: Record<string, any> | undefined, task: Record<string, any>): Record<string, any> | undefined {
  if (live && isRecord(live.dispatch)) return live.dispatch;
  return isRecord(task.dispatch) ? task.dispatch : undefined;
}

/** The FIRST actual dispatch record for one task (kept immutable across
 * recovery re-dispatches), same precedence as {@link dispatchRecordOf}. */
function initialDispatchRecordOf(live: Record<string, any> | undefined, task: Record<string, any>): Record<string, any> | undefined {
  if (live && isRecord(live.initialDispatch)) return live.initialDispatch;
  return isRecord(task.initialDispatch) ? task.initialDispatch : undefined;
}

// ---------------------------------------------------------------------------
// SubtasksStart / SubtasksAdd: submitted definitions and dispatch provenance
// ---------------------------------------------------------------------------

/**
 * Start/Add expanded view: the actual submitted task definitions and the
 * truthful dispatch provenance.
 *
 * #93 dispatch record integration: the renderer-only `details.dispatchView`
 * projection — attached by the parent's dispatch lifecycle preparation from
 * the controller's authoritative in-memory task records and refreshed on every
 * render after a dispatch event invalidates the row — carries each task's
 * actual transport-boundary dispatch record (captured sent prompt, base
 * commit, worker worktree) and current state. The projection wins over the
 * returned snapshot per task; absent entries fall back to the snapshot and
 * state honestly what it does and does not carry. No prompt is reconstructed
 * and expansion fetches nothing.
 */
function renderLifecycle(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  const toolName = ACTION_TOOL_NAMES[details.action] ?? "Subtasks";
  const allTasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  // #93: an Add result carries the whole execution inventory plus the exact
  // task ids this call created; identify the added tasks by those ids (never
  // by title or instruction matching), mirroring the collapsed card.
  const addedIds = Array.isArray(details.addedTaskIds)
    ? details.addedTaskIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  const tasks = details.action === "add" && addedIds && addedIds.length > 0
    ? allTasks.filter((task) => addedIds.includes(task.taskId))
    : allTasks;
  const dispatchView = isRecord(details.dispatchView) ? details.dispatchView : undefined;
  lines.heading(`${toolName} · ${stringOr(details.executionId, "?")} · ${aggregateStateWord(tasks, dispatchView)}`);
  // The target checkout, never the execution's temporary record-storage
  // directory (details.root): the live projection carries the resolved target,
  // and details.cwd is the persisted selected target for restored envelopes.
  lines.add(`Target workspace: ${stringOr(dispatchView?.targetWorkspace, stringOr(details.cwd, stringOr(args?.workspace, "(unrecorded)")))}`);

  for (const task of tasks) {
    lines.add("");
    renderSubmittedTask(lines, task, dispatchViewEntry(dispatchView, task.taskId));
  }

  const scheduling = isRecord(details.scheduling) ? details.scheduling : undefined;
  if (scheduling && count(scheduling.dispatchPending) > 0) {
    lines.add("");
    lines.add(
      `Dispatch pending: ${count(scheduling.dispatchPending)} task(s) in this execution, ${count(scheduling.globallyDispatchPending)} globally; dispatch events will update the original tool card with the captured prompt.`,
      "muted",
    );
  }
}

/** The exact model-visible submitted definition — instructions, acceptance
 * criteria, and relevant context — shared by the Start/Add lifecycle blocks
 * and every inspect task block (status and activity modes alike). All three
 * fields are already returned by the tool; expansion shows them in full,
 * verbatim. */
function renderSubmittedDefinition(lines: LineBuilder, definition: Record<string, any> | undefined): void {
  const instructions = typeof definition?.instructions === "string" ? definition.instructions : undefined;
  lines.label("Submitted instructions:");
  if (instructions) {
    for (const line of instructions.split("\n")) lines.addPreserved(line);
  } else {
    lines.add("(not returned by this record)", "muted");
  }

  const criteria = Array.isArray(definition?.acceptanceCriteria) ? definition.acceptanceCriteria.filter((entry: unknown) => typeof entry === "string" && entry.trim()) : [];
  if (criteria.length > 0) {
    lines.label("Acceptance criteria:");
    for (const criterion of criteria) lines.add(`- ${criterion}`);
  }

  const relevantContext = typeof definition?.relevantContext === "string" && definition.relevantContext.trim()
    ? definition.relevantContext
    : undefined;
  if (relevantContext) {
    lines.label("Relevant context:");
    for (const line of relevantContext.split("\n")) lines.addPreserved(line);
  }
}

/** One submitted task: the exact model-visible definition plus the truthful
 * dispatch/worker provenance. `live` is this task's entry in the renderer-only
 * dispatch projection (undefined when no projection covers it). */
function renderSubmittedTask(lines: LineBuilder, task: Record<string, any>, live?: Record<string, any>): void {
  const definition = isRecord(task.definition) ? task.definition : undefined;
  const title = stringOr(definition?.title, "(untitled)");
  lines.heading(`Task: ${stringOr(task.taskId, "(unrecorded handle)")} · ${title}`);
  // The authoritative live state wins when the projection is available, so the
  // original card reflects dispatch-driven state; otherwise the returned
  // snapshot stands on its own.
  const state = stringOr(live?.state ?? task.state, "unknown");
  lines.add(`State: ${state}`);
  renderSubmittedDefinition(lines, definition);

  // Durable outcome and lifecycle provenance.
  if (typeof task.summary === "string" && task.summary.trim()) {
    lines.add(`Authoritative outcome: ${task.summary.trim()}`);
  }
  if (typeof task.error === "string" && task.error.trim()) lines.add(`Error: ${task.error.trim()}`, "error");

  // #93 dispatch provenance: the actual record captured at the executor's
  // transport boundary. The live projection wins, then the returned record's
  // own snapshot. Neither is ever reconstructed from the task definition or
  // later configuration, and nothing here claims turn acknowledgement or task
  // compliance — those are separate facts recorded elsewhere.
  const dispatch = dispatchRecordOf(live, task);
  if (dispatch) {
    renderDispatchRecord(lines, dispatch, initialDispatchRecordOf(live, task));
  } else if (state === "queued") {
    lines.add("Dispatch: not yet started", "muted");
    lines.add("Captured base commit: not yet available", "muted");
    lines.add(typeof task.waveRoot === "string" && task.waveRoot ? `Worker worktree: ${task.waveRoot}` : "Worker worktree: not yet created", "muted");
    lines.add("Prompt sent to worker: not yet sent", "muted");
  } else {
    // The task had left the queued state when this record was returned, but
    // the capture is not part of it: say exactly that. Never claim a prompt
    // was sent (or not) without the record.
    lines.add("Dispatch: no capture in this returned record (the task was past queued when it returned)", "muted");
    lines.add("Captured base commit: not available in this record", "muted");
    lines.add(typeof task.waveRoot === "string" && task.waveRoot ? `Worker worktree: ${task.waveRoot}` : "Worker worktree: not recorded in this record", "muted");
    lines.add("Prompt sent to worker: not recorded in this inspection (captured at dispatch; dispatch events update the original card)", "muted");
  }

  // Returned command history with the full recorded instruction text.
  const commands = Array.isArray(task.commands) ? task.commands.filter(isRecord) : [];
  for (const command of commands) {
    lines.add("");
    lines.label(`Command record: ${stringOr(command.action, "?")} ${stringOr(command.instructionId, "?")} · ${stringOr(command.status, "?")}`);
    if (command.interrupt === true) lines.add("  interrupt requested before delivery", "muted");
    if (typeof command.mode === "string" && command.mode) lines.add(`  mode: ${command.mode}`, "muted");
    if (typeof command.text === "string" && command.text) {
      lines.add("  Recorded instruction text:", "muted");
      for (const line of command.text.split("\n")) lines.addPreserved(`  ${line}`);
    }
    if (typeof command.error === "string" && command.error.trim()) lines.add(`  error: ${command.error.trim()}`, "error");
  }
  if (typeof task.interruptionMode === "string") {
    lines.add(`Interruption mode: ${task.interruptionMode}`, "muted");
  }
  if (typeof task.reportPath === "string") lines.add(`Research report: ${task.reportPath}`);
}

/** The full actual dispatch record for one task, rendered without any
 * presentation cap or human-view filter: the exact prompt text handed to the
 * executor transport (whitespace preserved), the captured base commit, and the
 * isolated worker worktree. A recovery re-dispatch is distinguished from the
 * captured original when both records are available — the latest actual
 * dispatch is what the task is running on, and the original stays shown, not
 * replaced silently. */
function renderDispatchRecord(lines: LineBuilder, dispatch: Record<string, any>, initial: Record<string, any> | undefined): void {
  const turn = typeof dispatch.executorTurn === "number" ? dispatch.executorTurn : "?";
  lines.add(`Dispatch: dispatched to executor transport (turn ${turn})`);
  lines.add(`Captured base commit: ${stringOr(dispatch.baseCommit, "(unrecorded)")}`);
  lines.add(`Worker worktree: ${stringOr(dispatch.worktreeRoot, "(unrecorded)")}`);
  lines.add("Prompt provenance: captured at dispatch", "muted");
  const sentPrompt = typeof dispatch.sentPrompt === "string" ? dispatch.sentPrompt : undefined;
  const initialSentPrompt = initial && typeof initial.sentPrompt === "string" ? initial.sentPrompt : undefined;
  const redispatched = Boolean(
    initialSentPrompt !== undefined
    && sentPrompt !== undefined
    && initialSentPrompt !== sentPrompt,
  );
  if (redispatched) {
    const initialTurn = initial && typeof initial.executorTurn === "number" ? initial.executorTurn : "?";
    lines.add(`Re-dispatched after recovery: the latest actual dispatch is shown below; the captured original was turn ${initialTurn}.`, "muted");
    lines.add("");
    lines.label(`Initial dispatch (turn ${initialTurn}) — prompt sent to worker:`);
    if (initialSentPrompt !== undefined) {
      for (const line of initialSentPrompt.split("\n")) lines.addPreserved(line);
    } else {
      lines.add("(not recorded)", "muted");
    }
    lines.add("");
    lines.label(`Latest actual dispatch (turn ${turn}) — prompt sent to worker:`);
    if (sentPrompt !== undefined) {
      for (const line of sentPrompt.split("\n")) lines.addPreserved(line);
    } else {
      lines.add("(not recorded)", "muted");
    }
  } else {
    lines.label("Prompt sent to worker:");
    if (sentPrompt !== undefined) {
      for (const line of sentPrompt.split("\n")) lines.addPreserved(line);
    } else {
      lines.add("(not recorded)", "muted");
    }
  }
}

// ---------------------------------------------------------------------------
// SubtasksInspect: mode-specific expansion
// ---------------------------------------------------------------------------

function renderInspect(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  const evidence = isRecord(details.evidence) ? details.evidence : undefined;
  if (evidence) {
    renderEvidenceRead(lines, evidence, details, args);
    return;
  }
  if (args && (args.offset !== undefined || args.lines !== undefined)) {
    lines.heading(`SubtasksInspect · ${stringOr(args.taskId, "?")} · activity range`);
    lines.label("Requested activity range:");
    lines.add(`  offset: ${typeof args.offset === "number" ? args.offset : 0}`);
    lines.add(`  lines: ${typeof args.lines === "number" ? args.lines : "(default)"}`);
  } else {
    lines.heading(`SubtasksInspect · ${stringOr(args?.taskId, "?")} · status`);
  }
  lines.add(
    `Snapshot as of ${typeof details.updatedAt === "string" ? details.updatedAt : "an unrecorded time"}${anyActiveWarning(details)} — a point-in-time read; live work may have advanced.`,
    "muted",
  );
  lines.add(
    `execution ${stringOr(details.executionId, "?")} (${stringOr(details.kind, "background")}) · revision ${count(details.revision)}`,
  );
  // details.cwd is the persisted selected execution target (details.root is
  // only the temporary record-storage directory).
  if (typeof details.cwd === "string" && details.cwd.trim()) {
    lines.add(`Target workspace: ${details.cwd}`);
  }
  renderConflictGate(lines, details.conflictGate);
  renderTasks(lines, details);
}

/** Task blocks: stable handles, submitted definitions, lifecycle/control
 * outcomes, and diagnostics. Everything the tool returned is rendered —
 * expansion adds no presentation cap on top of the returned page. */
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
  for (const task of tasks) renderTask(lines, task);
}

function renderTask(lines: LineBuilder, task: Record<string, any>): void {
  lines.add(`${stringOr(task.taskId, "(unrecorded handle)")} · ${stringOr(task.definition?.title, "(untitled)")} · ${stringOr(task.state, "unknown")}`);
  if (task.state === "queued") {
    lines.add(
      `  dispatch: ${task.dispatchState === "assigned_starting" ? "executor assigned; startup in progress" : "waiting for executor capacity"}`,
      "muted",
    );
  }
  if (typeof task.waveRoot === "string" && task.waveRoot) {
    lines.add(`  worker worktree: ${task.waveRoot}`);
  }
  // The submitted definition is part of every inspect task block: status and
  // activity modes show what the model actually asked this task to do.
  renderSubmittedDefinition(lines, isRecord(task.definition) ? task.definition : undefined);
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
  if (typeof task.summary === "string" && task.summary.trim()) {
    lines.add(`  current authoritative outcome: ${task.summary.trim()}`);
  }
  if (typeof task.error === "string" && task.error.trim()) lines.add(`  error: ${task.error.trim()}`, "error");
  if (typeof task.reportPath === "string") lines.add(`  research report: ${task.reportPath}`);
  if (typeof task.interruptionMode === "string") {
    lines.add(`  interruption mode: ${task.interruptionMode}`, "muted");
  }
  const commands = Array.isArray(task.commands) ? task.commands.filter(isRecord) : [];
  for (const command of commands) {
    lines.add(
      `  command ${stringOr(command.action, "?")} ${stringOr(command.instructionId, "?")} · ${stringOr(command.status, "?")}`
      + `${command.interrupt === true ? " · interrupt requested before delivery" : ""}`
      + `${typeof command.mode === "string" && command.mode ? ` · mode ${command.mode}` : ""}`
      + `${typeof command.error === "string" && command.error.trim() ? ` · ${command.error.trim()}` : ""}`,
    );
    if (typeof command.text === "string" && command.text) {
      for (const line of command.text.split("\n")) lines.addPreserved(`    ${line}`);
    }
  }
  if (typeof task.artifactDir === "string") lines.add(`  artifacts: ${task.artifactDir}`);
  const activity = Array.isArray(task.activity) ? task.activity.filter(isRecord) : [];
  if (activity.length > 0) {
    lines.add(`  activity (returned for this read, oldest first):`, "muted");
    for (const event of activity) {
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

function anyActiveWarning(details: Record<string, any>): string {
  const active = Array.isArray(details.tasks)
    && details.tasks.some((task: unknown) => isRecord(task) && isActiveTaskState(task.state));
  return active ? " — freshness uncertain: at least one task is still active" : "";
}

function renderConflictGate(lines: LineBuilder, gate: unknown): void {
  if (!isRecord(gate)) return;
  lines.label("Conflict gate (automatic landings are blocked until markers are resolved and SubtasksMarkClean validates them):");
  lines.add(`  source ${stringOr(gate.sourceRoot, "?")} · activated ${stringOr(gate.activatedAt, "?")}`);
  lines.add(`  paths: ${Array.isArray(gate.paths) ? gate.paths.join(", ") : "(none recorded)"}`);
  if (typeof gate.reason === "string") lines.add(`  reason: ${gate.reason}`);
}

// ---------------------------------------------------------------------------
// Evidence reads (inspect with the evidence selector)
// ---------------------------------------------------------------------------

function renderEvidenceRead(lines: LineBuilder, evidence: unknown, details: Record<string, any>, args: Record<string, any> | undefined): void {
  if (!isRecord(evidence)) return;
  const mode = stringOr(evidence.mode, "unknown");
  const selector = args && isRecord(args.evidence) ? args.evidence : undefined;
  lines.heading(`SubtasksInspect · ${stringOr(evidence.taskId, "?")} · ${evidenceModeLabel(mode, selector)}`);

  // The actual request selector: the exact model-submitted navigation fields,
  // shown without a second human-only filter (the model already saw them).
  lines.label("Request:");
  lines.add(`  Task: ${stringOr(evidence.taskId, "?")}`);
  lines.add(`  Evidence selector: ${evidenceSelectorDescription(selector, evidence)}`);
  if (mode === "range" || mode === "cursor") {
    lines.add(
      `  Requested range: index=${typeof selector?.index === "number" ? selector.index : 0}`
      + ` limit=${typeof selector?.limit === "number" ? selector.limit : "(default)"}`,
    );
  }
  lines.add(
    `execution ${stringOr(details.executionId, "?")} (${stringOr(details.kind, "background")}) · revision ${count(details.revision)}`,
  );
  if (typeof details.updatedAt === "string") {
    lines.add(
      `Snapshot as of ${details.updatedAt}${anyActiveWarning(details)} — a point-in-time read; live work may have advanced.`,
      "muted",
    );
  }
  // details.cwd is the persisted selected execution target (details.root is
  // only the temporary record-storage directory).
  if (typeof details.cwd === "string" && details.cwd.trim()) {
    lines.add(`Target workspace: ${details.cwd}`);
  }

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
    for (const source of sources) {
      lines.add(
        `  source ${stringOr(source.sourceId, "?")} · ${stringOr(source.adapter, "?")}/${stringOr(source.stream, "?")} · ${count(source.records)} record(s)`
        + `${typeof source.firstAt === "string" && typeof source.lastAt === "string" ? ` · ${source.firstAt.slice(0, 19)} → ${source.lastAt.slice(0, 19)}` : ""}`
        + `${typeof source.file === "string" ? ` · ${source.file}` : ""}`,
      );
    }
    const unavailable = Array.isArray(snapshot.unavailable) ? snapshot.unavailable.filter(isRecord) : [];
    if (unavailable.length > 0) {
      lines.add(`  unavailable (disclosed gaps; upstream retention, not display clipping):`, "warning");
      for (const item of unavailable) {
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
    for (const entry of sectionEntries) renderEvidenceEntry(lines, entry, section.color);
  }
  const other = entries.filter((entry) => sections.every((section) => section.provenance !== entry.provenance));
  if (other.length > 0) {
    lines.label("Other returned entries (provenance not in the observed/claim/verdict trio):");
    for (const entry of other) renderEvidenceEntry(lines, entry, undefined);
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
    for (const match of matches) {
      lines.addPreserved(`  match [${count(match.index)}] ${stringOr(match.entryId, "?")} (${stringOr(match.kind, "?")}): ${stringOr(match.snippet, "")}`);
    }
    lines.add("  (matches carry entry kind only; deep-read an entryId for its retained content and provenance.)", "muted");
  }

  renderCallPair(lines, evidence.callPair);
  renderDeepContent(lines, evidence.deepContent);
  renderContinuation(lines, evidence);
  renderAuthoritativeContext(lines, evidence.context, details);
}

/** The evidence navigation selector as the model actually requested it, in the
 * same precedence the navigation read uses. Length-clipped for display only;
 * content is never re-redacted (the model already saw these fields). */
function evidenceSelectorDescription(selector: Record<string, any> | undefined, evidence: Record<string, any>): string {
  if (!selector) {
    const mode = stringOr(evidence.mode, "");
    return mode === "find" && isRecord(evidence.matchSummary)
      ? `find "${stringOr(evidence.matchSummary.query, "?")}"`
      : `mode ${mode}`;
  }
  if (typeof selector.find === "string" && selector.find) return `find "${selector.find}"`;
  if (typeof selector.entryId === "string" && selector.entryId) {
    return `entryId ${selector.entryId} · chunkIndex ${typeof selector.chunkIndex === "number" ? selector.chunkIndex : 0}`;
  }
  if (typeof selector.callId === "string" && selector.callId) return `callId ${selector.callId}`;
  if (typeof selector.cursor === "string" && selector.cursor) return `cursor ${selector.cursor}`;
  const index = typeof selector.index === "number" ? selector.index : 0;
  const limit = typeof selector.limit === "number" ? selector.limit : "(default)";
  const filter = typeof selector.filter === "string" ? ` · filter ${selector.filter}` : "";
  return `index ${index} · limit ${limit}${filter}`;
}

function evidenceModeLabel(mode: string, selector: Record<string, any> | undefined): string {
  if (selector && typeof selector.find === "string" && selector.find) return `find "${selector.find}"`;
  if (selector && typeof selector.callId === "string" && selector.callId) return `call ${selector.callId}`;
  if (selector && typeof selector.entryId === "string" && selector.entryId) {
    return `entry ${selector.entryId} · chunk ${typeof selector.chunkIndex === "number" ? selector.chunkIndex : 0}`;
  }
  return mode;
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
    lines.addPreserved(`    result [${count(result.index)}] ${stringOr(result.entryId, "?")} · ${stringOr(result.status, "unknown")}: ${stringOr(result.preview, "")}`);
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
// SubtasksSteer / SubtasksContinue: full sent instructions, transport-only acks
// ---------------------------------------------------------------------------

function renderSteer(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  const task = taskForRequest(details, args);
  lines.heading(`SubtasksSteer · ${stringOr(task?.taskId ?? args?.taskId, "?")}`);

  const instructions = firstNonEmpty([
    typeof args?.instructions === "string" ? args.instructions : undefined,
    matchingCommand(details, args)?.text,
  ], "");
  // The submitted text is labeled by its origin, never as already sent: queued
  // steering (no live executor to deliver to) has not reached any worker.
  lines.label("Submitted instructions:");
  if (instructions) {
    for (const line of instructions.split("\n")) lines.addPreserved(line);
  } else {
    lines.add("(not recorded by this result)", "muted");
  }

  const command = matchingCommand(details, args);
  const interruptRequested = args?.interrupt === true || command?.interrupt === true;
  lines.add(`Interrupt first: ${interruptRequested ? "yes" : "no"}`);
  lines.add(`Delivery: ${deliveryLine(command)}`);
  if (!command || command.status === "queued") {
    lines.add("Instruction sent to the worker: not yet sent (queued for transport)", "muted");
  }
  if (command?.status === "acknowledged" || command?.status === "delivered") {
    lines.add("Instruction sent to the worker: yes (see delivery above)", "muted");
    lines.add("Task compliance: not established by acknowledgment", "muted");
  }
  renderTaskOutcome(lines, task);
}

function renderContinueOperation(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  const task = taskForRequest(details, args);
  lines.heading(`SubtasksContinue · ${stringOr(task?.taskId ?? args?.taskId, "?")}`);

  const submitted = firstNonEmpty([
    typeof args?.instructions === "string" ? args.instructions : undefined,
    matchingCommand(details, args)?.text,
  ], "");
  lines.label("Submitted continuation:");
  if (submitted) {
    for (const line of submitted.split("\n")) lines.addPreserved(line);
  } else {
    lines.add("(not recorded by this result)", "muted");
  }

  const command = matchingCommand(details, args);
  const delivered = typeof command?.text === "string" && command.text && command.text !== submitted ? command.text : undefined;
  if (delivered) {
    // The adapter-delivered message may differ from the submitted text
    // (appended isolation instructions, rewritten paths). Never mislabel the
    // submitted text as the entire delivered message.
    lines.label("Adapter-delivered continuation (recorded at admission):");
    for (const line of delivered.split("\n")) lines.addPreserved(line);
  } else {
    lines.add("Delivered message: not separately recorded by this result (the recorded instruction text matches the submitted continuation).", "muted");
  }
  lines.add(`Delivery: ${deliveryLine(command)}`);
  renderTaskOutcome(lines, task);
}

/** Truthful lifecycle summary of the targeted task's durable record. */
function renderTaskOutcome(lines: LineBuilder, task: Record<string, any> | undefined): void {
  if (!task) {
    lines.add("Resulting task outcome: not yet available in this record", "muted");
    return;
  }
  const state = stringOr(task.state, "unknown");
  lines.add(`Resulting task outcome: ${state}${isActiveTaskState(state as BackgroundTaskState) ? " (still in progress)" : ""}`, "muted");
  if (typeof task.summary === "string" && task.summary.trim()) {
    lines.add(`Authoritative outcome: ${task.summary.trim()}`);
  }
  if (typeof task.error === "string" && task.error.trim()) lines.add(`Error: ${task.error.trim()}`, "error");
}

/** Resolves the task record the request targeted (explicit args handle, or the
 * single returned task). Never inferred beyond the returned inventory. */
function taskForRequest(details: Record<string, any>, args: Record<string, any> | undefined): Record<string, any> | undefined {
  const tasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  const requested = typeof args?.taskId === "string" ? args.taskId : undefined;
  if (requested) return tasks.find((task) => task.taskId === requested);
  return tasks.length === 1 ? tasks[0] : undefined;
}

/** The returned command record for this request, matched by the actual
 * instructionId (or the most recent matching action as a fallback). */
function matchingCommand(details: Record<string, any>, args: Record<string, any> | undefined): Record<string, any> | undefined {
  const task = taskForRequest(details, args);
  const commands = task && Array.isArray(task.commands) ? task.commands.filter(isRecord) : [];
  if (commands.length === 0) return undefined;
  const requestedId = typeof args?.instructionId === "string" ? args.instructionId : undefined;
  if (requestedId) {
    const matched = commands.find((command) => command.instructionId === requestedId);
    if (matched) return matched;
  }
  const byAction = commands.filter((command) => ["continue", "steer", "interrupt", "force_merge"].includes(stringOr(command.action, "?")));
  return byAction.at(-1);
}

/** Transport status of a steer/continue command record, never overstated. */
function deliveryLine(command: Record<string, any> | undefined): string {
  if (!command) return "not recorded by this result";
  switch (command.status) {
    case "acknowledged": return "transport acknowledged";
    case "delivered": return "delivered by transport";
    case "queued": return "queued for transport (not yet delivered)";
    case "failed": return `failed: ${stringOr(command.error, "transport rejected the instruction")}`;
    default: return `status ${stringOr(command.status, "unknown")}`;
  }
}

function firstNonEmpty(values: Array<string | undefined>, fallback: string): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// SubtasksInterrupt / SubtasksForceMerge: exact request modes, established
// outcomes only
// ---------------------------------------------------------------------------

function renderInterrupt(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  const task = taskForRequest(details, args);
  const command = matchingCommand(details, args);
  const mode = firstNonEmpty([
    typeof args?.interruptMode === "string" ? args.interruptMode : undefined,
    typeof command?.mode === "string" ? command.mode : undefined,
    typeof task?.interruptionMode === "string" ? task.interruptionMode : undefined,
  ], "(not recorded)");
  lines.heading(`SubtasksInterrupt · ${stringOr(task?.taskId ?? args?.taskId, "?")}`);
  lines.add(`Requested mode: ${mode}`);
  const state = task ? stringOr(task.state, "unknown") : undefined;
  if (state && !isActiveTaskState(state as BackgroundTaskState)) {
    lines.add("Executor: stopped");
  } else if (state) {
    lines.add(`Executor: still active (state ${state}); interruption pending`, "warning");
  } else {
    lines.add("Executor: not established by this record", "muted");
  }
  if (state === "landed" || state === "reported") {
    lines.add("Workspace changes: landed");
  } else if (state === "conflicted") {
    lines.add("Workspace changes: conflict markers materialized in main", "warning");
  } else {
    lines.add("Workspace changes: not landed");
  }
  if (isRecord(task?.bundle)) {
    lines.add(
      `Recovery: retained checkpoint available (operation ${stringOr(task.bundle.operationId, "?")}, revision ${count(task.bundle.expectedRevision)})`,
    );
  } else {
    lines.add("Recovery: none recorded", "muted");
  }
  if (typeof task?.summary === "string" && task.summary.trim()) {
    lines.add(`Authoritative outcome: ${task.summary.trim()}`);
  }
  if (typeof task?.error === "string" && task.error.trim()) lines.add(`Error: ${task.error.trim()}`, "error");
}

function renderForceMerge(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  const task = taskForRequest(details, args);
  lines.heading(`SubtasksForceMerge · ${stringOr(task?.taskId ?? args?.taskId, "?")}`);
  lines.add("Request: merge the retained checkpoint");
  const mergeAnyhow = args?.mergeAnyhow === true;
  lines.add(`mergeAnyhow: ${mergeAnyhow ? "true" : "false"}`);
  // details.cwd is the persisted selected execution target (details.root is
  // only the temporary record-storage directory).
  if (typeof details.cwd === "string" && details.cwd.trim()) {
    lines.add(`Target: ${details.cwd}`);
  }
  const state = task ? stringOr(task.state, "unknown") : undefined;
  if (state === "conflicted") {
    lines.add("Result: conflicts materialized", "warning");
    renderConflictGate(lines, details.conflictGate);
    lines.add("Required action: resolve and verify the conflict before marking the workspace clean; this does not establish that the task requirements are satisfied.");
  } else if (state === "landed" || state === "reported") {
    lines.add("Result: landed");
    lines.add("Manual workspace inspection is still required; a mechanical landing never proves the requested changes are present or correct.", "muted");
  } else if (state && !isActiveTaskState(state as BackgroundTaskState)) {
    lines.add(`Result: ${state} (landing attempt did not complete)`, "warning");
    lines.add("Manual workspace inspection is still required; a mechanical landing never proves the requested changes are present or correct.", "muted");
  } else if (state) {
    lines.add(`Result: in progress (state ${state})`, "warning");
  } else {
    lines.add("Result: not established by this record", "muted");
  }
  if (typeof task?.summary === "string" && task.summary.trim()) {
    lines.add(`Authoritative outcome: ${task.summary.trim()}`);
  }
  if (typeof task?.error === "string" && task.error.trim()) lines.add(`Error: ${task.error.trim()}`, "error");
}

// ---------------------------------------------------------------------------
// Simple acknowledgements: only returned/request fields, nothing invented
// ---------------------------------------------------------------------------

function renderWatch(lines: LineBuilder, details: Record<string, any>, args: Record<string, any> | undefined): void {
  lines.heading(`SubtasksWatch · ${stringOr(details.executionId, "?")}`);
  lines.add(`Requested checkpoint: after ${durationWords(count(details.afterMs))}${typeof args?.after === "string" ? ` (requested as "${args.after}")` : ""}`);
  lines.add("Watch: armed");
  lines.add("Kind: one-shot notification");
  lines.add("Task completion/failure notifications: independent of this watch", "muted");
  if (typeof details.armedAt === "string") lines.add(`Armed at: ${details.armedAt}`, "muted");
  if (typeof details.dueAt === "string") lines.add(`Due at: ${details.dueAt}`, "muted");
  lines.add(`Replaced the prior watch for this execution: ${details.replaced === true ? "yes" : "no"}`);
}

function renderMarkClean(lines: LineBuilder, details: Record<string, any>): void {
  lines.heading("SubtasksMarkClean");
  if (details.cleared === true) {
    lines.add("Conflict check: passed");
    lines.add("Conflict gate: cleared");
  } else {
    lines.add("Conflict gate: none active");
  }
  const paths = Array.isArray(details.paths) ? details.paths.filter((entry: unknown) => typeof entry === "string" && entry.trim()) : [];
  lines.add(`Validated paths: ${paths.length > 0 ? paths.join(", ") : "(none)"}`);
  // The acknowledgement does not name the validated workspaces; the actual
  // operation data (the resolved conflict-marker paths) is exposed instead of
  // guessing a workspace identity.
  lines.add("Workspace identity: not named by this acknowledgement; the validated conflict-marker paths above are the returned operation data.", "muted");
}

// ---------------------------------------------------------------------------
// Error results
// ---------------------------------------------------------------------------

function renderErrorResult(lines: LineBuilder, toolName: string, details: Record<string, any>): void {
  lines.heading(`${toolName} · failed`);
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
    lines.label("Durable execution state as of the failure:");
    for (const inspection of executions) {
      if (!isRecord(inspection)) continue;
      lines.add(`execution ${stringOr(inspection.executionId, "?")} (${stringOr(inspection.kind, "?")}) · revision ${count(inspection.revision)} · updated ${stringOr(inspection.updatedAt, "?")}`);
      renderTasks(lines, inspection);
      renderConflictGate(lines, inspection.conflictGate);
    }
  }
}