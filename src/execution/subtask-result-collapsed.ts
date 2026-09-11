/**
 * Collapsed (default) result card for the Subtasks* tool family (#93,
 * canonical examples 6–14).
 *
 * A presentation-only callback with Pi's native `renderResult` signature
 * `(value, options, theme, context?)`. It is the collapsed half of the shared
 * `expandableResult(collapsedRenderer, expandedRenderer?)` wiring from #57:
 * the parent registration combines it as
 *
 *   renderResult: expandableResult(renderSubtaskResultCollapsed, renderSubtaskResultExpanded),
 *
 * so the native `options.expanded` flag selects the expanded detail view and
 * this callback owns every non-expanded state (pending, completed, error).
 * The expand/collapse key hint is added centrally by the shared wrapper: this
 * module emits headers and bodies only and never renders its own
 * `(ctrl+o …)` hint.
 *
 * The native `context.args` carries the actual recorded tool-call request
 * fields; the card derives its concise header and body from those request
 * fields plus the already-returned result details. Model-submitted content is
 * not re-redacted beyond bounded single-line display clipping, with one
 * #56-established exception: free-text evidence selectors (find queries,
 * call/entry ids) are shown through the same sensitive-text redaction the
 * call cards use, so a secret-shaped selector never reaches the card. The
 * expanded view shows every such field exactly as submitted.
 */
import { isActiveTaskState, type BackgroundTaskState } from "./task-state";
import { redactSensitiveText } from "../redaction";

/** Theme contract shared with the family's expanded renderer. Structurally
 * identical to #57's `ToolResultTheme`. */
export interface SubtaskCollapsedRendererTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

/** Native renderResult context subset: the actual recorded tool-call args. */
export interface SubtaskCollapsedRendererContext {
  readonly args?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Native renderResult callback signature, directly compatible with #57's
 * `ToolResultRenderer` delegate contract (optional native context).
 */
export type SubtaskCollapsedResultRenderer = (
  value: unknown,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: SubtaskCollapsedRendererTheme,
  context?: SubtaskCollapsedRendererContext,
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

/** Compact collapsed card: at most a handful of concise rows. */
const MAX_CARD_LINES = 12;

/** Bounded inline task rendering for Start/Add cards (#56 disclosure bound). */
const MAX_INLINE_TASKS = 8;

interface CardSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

interface CardLine {
  /** Pre-joined plain segments for single-style lines. */
  text?: string;
  color?: string;
  bold?: boolean;
  /** Multi-style line (headers: bold tool title + accent summary). */
  parts?: CardSegment[];
}

/**
 * The collapsed renderer callback for the Subtasks* family, wired as
 * `expandableResult`'s collapsed renderer in src/execution/tool.ts; the
 * expanded callback selects on the native `expanded` flag.
 */
export const renderSubtaskResultCollapsed: SubtaskCollapsedResultRenderer = (value, options, theme, context) => {
  const record = isRecord(value) ? value : undefined;
  const details = record && isRecord(record.details) ? record.details : undefined;
  const isError = record?.isError === true;
  const summary = summaryText(record);
  const args = argsOf(context);

  if (isRecord(options) && options.isPartial === true) {
    return cardComponent([{ text: `${operationLabel(details)} …`, color: "warning" }], theme);
  }

  const action = details && typeof details.action === "string" ? details.action : undefined;
  const toolName = action ? ACTION_TOOL_NAMES[action] ?? action : operationLabel(details);

  if (isError) {
    return cardComponent([
      ...headerLines(toolName, "failed"),
      ...bodyLines([`diagnostic: ${stringOr(details?.diagnostic, "(no diagnostic returned)")}`], "error", 2),
    ], theme);
  }

  if (!details) {
    return cardComponent([{ text: summaryText(record), color: isError ? "error" : undefined }], theme);
  }

  const lines = renderByAction(action, details, args);
  if (lines) return cardComponent(lines, theme);

  // A returned details record we do not recognize: show the returned summary
  // only — nothing invented.
  return cardComponent([{ text: summary, color: undefined }], theme);
};

function renderByAction(action: string | undefined, details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] | undefined {
  if (action === "start" || action === "add") return startAddCard(details, args);
  if (action === "inspect") return inspectCard(details, args);
  if (action === "watch") return watchCard(details, args);
  if (action === "continue" || action === "steer") return instructionCard(action, details, args);
  if (action === "interrupt") return interruptCard(details, args);
  if (action === "force_merge") return forceMergeCard(details, args);
  // SubtasksMarkClean returns { cleared, paths } with no action tag.
  if (typeof details.cleared === "boolean" && Array.isArray(details.paths)) return markCleanCard(details);
  // Restored or legacy envelopes may omit the action tag: a task inventory
  // still renders as the inspect card rather than dropping to summary-only text.
  if (Array.isArray(details.tasks)) return inspectCard(details, args);
  return undefined;
}

// ---------------------------------------------------------------------------
// SubtasksStart / SubtasksAdd
// ---------------------------------------------------------------------------

/**
 * #93: the Start/Add card is the original dispatch-lifecycle card. The
 * renderer-only `details.dispatchView` projection (attached by the parent's
 * dispatch lifecycle preparation from the controller's authoritative in-memory
 * records) wins over the returned snapshot: when an actual dispatch event has
 * arrived, the same retained result re-renders with the live task state and
 * the transport-boundary dispatch provenance. Nothing is fetched here — the
 * projection arrives with the render.
 */
function startAddCard(details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] {
  const allTasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  // #93: an Add result carries the WHOLE execution inventory plus the exact
  // task ids this call created; the card identifies its own tasks by those
  // ids (never by title or instruction matching), so a group with eight older
  // tasks cannot push the newly added one out of the bounded preview.
  const addedIds = Array.isArray(details.addedTaskIds)
    ? details.addedTaskIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  const tasks = details.action === "add" && addedIds && addedIds.length > 0
    ? allTasks.filter((task) => addedIds.includes(task.taskId))
    : allTasks;
  const kind = details.kind === "research" ? "research" : "execution";
  const dispatchView = isRecord(details.dispatchView) ? details.dispatchView : undefined;
  // The target checkout, never the execution's temporary record-storage
  // directory (details.root): the live projection carries the resolved target,
  // and details.cwd is the persisted selected target for restored envelopes.
  const target = stringOr(dispatchView?.targetWorkspace, stringOr(details.cwd, stringOr(args?.workspace, "")));
  const lines: CardLine[] = [];
  if (details.action === "add") {
    // The number of ADDED tasks comes from the exact assigned ids when the
    // result carries them, else from the actual recorded request.
    const addedCount = addedIds && addedIds.length > 0
      ? addedIds.length
      : Array.isArray(args?.tasks) ? args.tasks.length : tasks.length;
    lines.push(...headerLines("SubtasksAdd", `${stringOr(details.executionId, "?")} · ${addedCount} task(s) added`));
  } else {
    lines.push(...headerLines("SubtasksStart", `${tasks.length} ${kind} task(s) · ${aggregateStateWord(tasks, dispatchView)}`));
  }
  if (target) lines.push(...bodyLines([`Target: ${target}`], undefined, 1));
  // Bounded inline rendering with explicit disclosure (#56): the collapsed
  // card stays concise even for a full 16-task group.
  const shown = tasks.slice(0, MAX_INLINE_TASKS);
  for (const task of shown) {
    const live = dispatchViewEntry(dispatchView, task.taskId);
    lines.push(...bodyLines([taskLine(task, live)], undefined, 1));
    // #93 dispatch provenance, driven by actual dispatch events: only data
    // captured at the transport boundary is shown; a task without a record
    // says "not yet sent" and nothing is fabricated. A settled task absent
    // from the live projection keeps its static snapshot untouched.
    const dispatch = dispatchRecordOf(live, task);
    if (dispatch) {
      const initial = initialDispatchRecordOf(live, task);
      const redispatched = Boolean(
        initial
        && typeof initial.sentPrompt === "string"
        && typeof dispatch.sentPrompt === "string"
        && initial.sentPrompt !== dispatch.sentPrompt,
      );
      const base = typeof dispatch.baseCommit === "string" ? dispatch.baseCommit.slice(0, 12) : "";
      lines.push(...bodyLines([
        `dispatch: prompt delivered to transport · worker worktree ${stringOr(dispatch.worktreeRoot, "(unrecorded)")}`
        + ` · captured base ${base || "(unrecorded)"} · turn ${typeof dispatch.executorTurn === "number" ? dispatch.executorTurn : "?"}`
        + (redispatched ? " · re-dispatched after recovery (latest actual dispatch shown)" : ""),
      ], undefined, 2));
    } else if ((live?.state ?? task.state) === "queued") {
      // Only a task that is effectively still queued can honestly say its
      // prompt was not sent: it has not dispatched yet.
      lines.push(...bodyLines(["dispatch: not yet sent (no prompt, worktree, or captured base available yet)"], "dim", 2));
    } else {
      // Past queued without a persisted capture (e.g. restored historical
      // tasks): acknowledge missing provenance instead of claiming
      // non-delivery — the live projection establishes current state, not
      // whether historical delivery occurred.
      lines.push(...bodyLines(["dispatch: no capture available in this record; delivery status is unrecorded"], "dim", 2));
    }
  }
  // Finding 15 (review pass 2): compact rendering is explicitly bounded, so it
  // must disclose what it omits — both unrendered inline tasks and archive-only
  // settled history.
  if (tasks.length > shown.length) {
    lines.push(...bodyLines([`… ${tasks.length - shown.length} additional inline task(s) omitted from this compact rendering.`], "dim", 1));
  }
  const archivedCount = typeof details.archivedCount === "number" ? details.archivedCount : 0;
  if (archivedCount > 0) {
    lines.push(...bodyLines([`… ${archivedCount} earlier settled task(s) are archived; inspect by taskId for exact history.`], "dim", 1));
  }
  return lines;
}

/** Merged per-task state word: the live projection wins when present (it is
 * the authoritative current record), otherwise the returned snapshot stands on
 * its own. Queued states keep the dispatch-detail nuance. */
function taskStateWord(live: Record<string, any> | undefined, task: Record<string, any>): string {
  const queuedState = (dispatchState: unknown) => dispatchState === "assigned_starting"
    ? "queued (executor assigned/startup)"
    : "queued (executor capacity wait)";
  if (live && typeof live.state === "string") {
    return live.state === "queued" ? queuedState(live.dispatchState) : live.state;
  }
  if (task.state === "queued") return queuedState(task.dispatchState);
  return stringOr(task.state, "unknown");
}

/** Aggregate state word for the header: first active task's merged state, else
 * the first task's; the live projection wins per task. */
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
// SubtasksInspect
// ---------------------------------------------------------------------------

function inspectCard(details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] {
  const evidence = isRecord(details.evidence) ? details.evidence : undefined;
  const taskId = stringOr(args?.taskId, "?");
  if (evidence) {
    const lines: CardLine[] = headerLines("SubtasksInspect", `task ${taskId} · ${evidenceModeSummary(args, evidence)}`);
    lines.push(...evidenceOutcomeLines(evidence));
    return lines.slice(0, MAX_CARD_LINES);
  }
  const mode = args && (args.offset !== undefined || args.lines !== undefined)
    ? `activity offset=${typeof args.offset === "number" ? args.offset : 0}`
    : "status";
  const lines = headerLines("SubtasksInspect", `task ${taskId} · ${mode}`);
  const tasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  // With an explicit taskId the card names that one task; without it the card
  // shows the bounded group inventory with the same disclosure rules as the
  // Start/Add cards.
  const selected = typeof args?.taskId === "string" && args.taskId !== ""
    ? tasks.find((task) => task.taskId === args.taskId)
    : undefined;
  if (selected) {
    lines.push(...bodyLines([taskLine(selected)], undefined, 1));
  } else {
    const shown = tasks.slice(0, MAX_INLINE_TASKS);
    for (const task of shown) {
      lines.push(...bodyLines([taskLine(task)], undefined, 1));
    }
    if (tasks.length > shown.length) {
      lines.push(...bodyLines([`… ${tasks.length - shown.length} additional inline task(s) omitted from this compact rendering.`], "dim", 1));
    }
  }
  // Bounded rendering discloses archive-only settled history (#56).
  const archivedCount = typeof details.archivedCount === "number" ? details.archivedCount : 0;
  if (archivedCount > 0) {
    lines.push(...bodyLines([`… ${archivedCount} earlier settled task(s) are archived; inspect by taskId for exact history.`], "dim", 1));
  }
  return lines;
}

/** One bounded task line: taskId · state · submitted title, plus a clipped
 * durable summary when one is recorded. The same field order as the Start/Add
 * card lines, so a row reads identically in both places. */
function taskLine(task: Record<string, any>, live?: Record<string, any>): string {
  const definition = isRecord(task.definition) ? task.definition : undefined;
  const title = stringOr(definition?.title, "(untitled)");
  return `${stringOr(task.taskId, "(unrecorded handle)")} · ${taskStateWord(live, task)} · ${clipLine(title, 96)}`
    + (typeof task.summary === "string" && task.summary.trim() ? ` · ${clipLine(task.summary, 96)}` : "");
}

/** #56: bounded, redacted display of one free-text evidence selector. Opaque
 * tokens (cursors, long ids) are clipped so a card never dumps them; the same
 * treatment the call cards use. */
function safeSelector(value: string, maxChars = 48): string {
  const redacted = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, Math.max(1, maxChars - 1))}…`;
}

const PROVENANCE_SHORT: Record<string, (count: number) => string> = {
  executor_observed: () => "observed",
  worker_claim: (count) => count === 1 ? "claim" : "claims",
  reviewer_verdict: (count) => count === 1 ? "review verdict" : "review verdicts",
};

/** Compact provenance/truncation mix for a set of returned entries. Provenance
 * is shown only when the read mixes kinds, so a uniform read stays undisturbed
 * while observed-versus-claimed versus reviewer evidence never blurs together.
 */
function entryMixSuffix(entries: Array<Record<string, any>>): string {
  const provenance = new Map<string, number>();
  let truncated = 0;
  for (const entry of entries) {
    if (typeof entry.provenance === "string") provenance.set(entry.provenance, (provenance.get(entry.provenance) ?? 0) + 1);
    if (entry.truncatedContent === true) truncated += 1;
  }
  const parts: string[] = [];
  if (provenance.size > 1) {
    parts.push([...provenance.entries()].map(([name, count]) => `${count} ${PROVENANCE_SHORT[name]?.(count) ?? name}`).join(", "));
  }
  if (truncated > 0) parts.push(`${truncated} truncated at retention`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/** #56: mode-specific collapsed outcome rows for one evidence read. Reports the
 * returned range/count or match total, available continuations, and important
 * empty/unavailable/truncated outcomes — never raw content, cursor tokens, or
 * private reasoning. */
function evidenceOutcomeLines(evidence: Record<string, any>): CardLine[] {
  const mode = stringOr(evidence.mode, "");
  const entries = Array.isArray(evidence.entries) ? evidence.entries.filter(isRecord) : [];
  const lines: CardLine[] = [];
  switch (mode) {
    case "find": {
      const summary = isRecord(evidence.matchSummary) ? evidence.matchSummary : undefined;
      const query = typeof summary?.query === "string" ? safeSelector(summary.query) : "";
      const total = typeof summary?.totalMatches === "number" ? summary.totalMatches : 0;
      if (total === 0) {
        lines.push(...bodyLines([`no matches for "${query}"`], "warning", 1));
      } else {
        const shown = Array.isArray(evidence.matches) ? evidence.matches.length : 0;
        const parts: NonNullable<CardLine["parts"]> = [{ text: ` ${total} match${total === 1 ? "" : "es"} for "${query}"`, color: "success" }];
        if (summary?.matchesTruncated === true || shown < total) {
          parts.push({ text: ` (${shown} shown)`, color: "dim" });
        }
        lines.push({ parts });
      }
      break;
    }
    case "range": {
      if (entries.length === 0) {
        lines.push(...bodyLines(["no entries in this read"], "warning", 1));
      } else {
        const first = entries[0];
        const last = entries[entries.length - 1];
        const from = typeof first?.index === "number" ? first.index : 0;
        const to = typeof last?.index === "number" ? last.index : from;
        // A cursor is issued only for unfiltered range reads, so its presence
        // identifies the sequence total as the read's own base length.
        const snapshot = isRecord(evidence.snapshot) ? evidence.snapshot : undefined;
        const total = typeof evidence.cursor === "string" && typeof snapshot?.totalEntries === "number"
          ? ` of ${snapshot.totalEntries}`
          : "";
        const parts: NonNullable<CardLine["parts"]> = [{ text: ` entries ${from}–${to}${total}`, color: "success" }];
        const mix = entryMixSuffix(entries);
        if (mix) parts.push({ text: mix, color: "dim" });
        lines.push({ parts });
      }
      const continuation: string[] = [];
      if (typeof evidence.nextIndex === "number") continuation.push(`next page at index=${evidence.nextIndex}`);
      if (typeof evidence.cursor === "string") continuation.push("incremental cursor available");
      if (continuation.length > 0) lines.push(...bodyLines([continuation.join(" · ")], "dim", 1));
      break;
    }
    case "cursor": {
      if (entries.length > 0) {
        const parts: NonNullable<CardLine["parts"]> = [{ text: ` ${entries.length} newer entr${entries.length === 1 ? "y" : "ies"}`, color: "success" }];
        const mix = entryMixSuffix(entries);
        if (mix) parts.push({ text: mix, color: "dim" });
        lines.push({ parts });
      } else {
        lines.push(...bodyLines(["no newer entries"], "warning", 1));
      }
      if (typeof evidence.cursor === "string") lines.push(...bodyLines(["updated cursor issued for the next continuation"], "dim", 1));
      break;
    }
    case "call": {
      const pair = isRecord(evidence.callPair) ? evidence.callPair : undefined;
      const callId = typeof pair?.call?.callId === "string" ? pair.call.callId
        : typeof pair?.result?.callId === "string" ? pair.result.callId
          : "";
      const label = callId ? `call ${safeSelector(callId)}` : "call";
      if (pair?.status === "returned") {
        lines.push(...bodyLines([`${label} · result returned`], "success", 1));
      } else if (isRecord(pair?.result)) {
        // readCall reports an observed source-scoped result without a validated
        // pair as in_flight: the result record exists, only the pairing is
        // unresolved — never claim it was absent.
        lines.push(...bodyLines([`${label} · result observed, pairing unresolved`], "warning", 1));
      } else {
        lines.push(...bodyLines([`${label} · in flight, result not observed yet`], "warning", 1));
      }
      break;
    }
    case "entry": {
      const deep = isRecord(evidence.deepContent) ? evidence.deepContent : undefined;
      const entryId = typeof deep?.entryId === "string" ? safeSelector(deep.entryId) : "";
      const chunkIndex = typeof deep?.chunkIndex === "number" ? deep.chunkIndex : 0;
      const chars = typeof deep?.content === "string" ? deep.content.length : 0;
      lines.push(...bodyLines([`entry ${entryId} · chunk ${chunkIndex} · ${chars} char${chars === 1 ? "" : "s"}`], "success", 1));
      if (deep?.hasMore === true && typeof deep?.nextChunk === "number") {
        lines.push(...bodyLines([`more chunks (next: ${deep.nextChunk})`], "dim", 1));
      }
      if (deep?.truncatedContent === true) {
        lines.push(...bodyLines(["source record truncated at retention cap"], "warning", 1));
      } else if (typeof deep?.note === "string" && deep.note.trim() !== "") {
        lines.push(...bodyLines([clipLine(deep.note, 120)], "warning", 1));
      }
      break;
    }
    default:
      lines.push(...bodyLines([mode ? `evidence read (${mode})` : "evidence read"], "success", 1));
  }
  const snapshot = isRecord(evidence.snapshot) ? evidence.snapshot : undefined;
  const capability = isRecord(snapshot?.capability) ? snapshot.capability : undefined;
  if (capability?.toolEvidence === "unavailable") {
    lines.push(...bodyLines([`tool evidence unavailable: ${safeSelector(String(capability.reason ?? "no tool records"))}`], "warning", 1));
  } else if (Array.isArray(snapshot?.unavailable) && snapshot.unavailable.length > 0) {
    const notes = snapshot.unavailable;
    const reasons = [...new Set(notes.filter(isRecord).map((item) => (typeof item.reason === "string" ? item.reason : "unknown")))];
    lines.push(...bodyLines([`${notes.length} unavailable source note(s): ${reasons.slice(0, 3).join(", ")}${reasons.length > 3 ? ` +${reasons.length - 3} more` : ""}`], "dim", 1));
  }
  return lines;
}

function evidenceModeSummary(args: Record<string, any> | undefined, evidence: Record<string, any>): string {
  const selector = args && isRecord(args.evidence) ? args.evidence : undefined;
  const mode = stringOr(evidence.mode, "");
  if (selector && typeof selector.find === "string" && selector.find) return `find "${clipLine(selector.find, 48)}"`;
  if (selector && typeof selector.callId === "string" && selector.callId) return `call ${clipLine(selector.callId, 24)}`;
  if (selector && typeof selector.entryId === "string" && selector.entryId) return `entry ${clipLine(selector.entryId, 24)}`;
  if (selector && typeof selector.cursor === "string" && selector.cursor) return "cursor continuation";
  return mode;
}

// ---------------------------------------------------------------------------
// SubtasksWatch
// ---------------------------------------------------------------------------

function watchCard(details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] {
  const afterMs = typeof details.afterMs === "number" && Number.isFinite(details.afterMs) ? details.afterMs : 0;
  const lines = headerLines("SubtasksWatch", `${stringOr(details.executionId, "?")} · checkpoint armed`);
  lines.push(...bodyLines([`After ${durationWords(afterMs)}${typeof args?.after === "string" ? ` (requested as "${args.after}")` : ""}`], undefined, 1));
  return lines;
}

// ---------------------------------------------------------------------------
// SubtasksSteer / SubtasksContinue
// ---------------------------------------------------------------------------

function instructionCard(action: "continue" | "steer", details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] {
  const tasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  const requested = typeof args?.taskId === "string" ? args.taskId : undefined;
  const task = (requested ? tasks.find((candidate) => candidate.taskId === requested) : undefined) ?? tasks[0];
  const command = matchingCommand(details, args);
  const status = stringOr(command?.status, "unknown");
  const word = action === "continue"
    ? (status === "failed" ? "continuation failed" : status === "queued" ? "continuation queued" : "continuation accepted")
    : (status === "failed" ? "failed" : status === "queued" ? "queued" : status === "delivered" ? "delivered" : status === "acknowledged" ? "acknowledged" : status);
  const lines = headerLines(action === "continue" ? "SubtasksContinue" : "SubtasksSteer", `${stringOr(task?.taskId ?? args?.taskId, "?")} · ${word}`);
  const instruction = firstNonEmpty([
    typeof args?.instructions === "string" ? args.instructions : undefined,
    typeof command?.text === "string" ? command.text : undefined,
  ], "");
  if (instruction) {
    lines.push(...bodyLines([firstLine(instruction)], undefined, 1));
  }
  if (args?.interrupt === true || command?.interrupt === true) {
    lines.push(...bodyLines(["Interrupt first: yes"], undefined, 1));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// SubtasksInterrupt / SubtasksForceMerge
// ---------------------------------------------------------------------------

function interruptCard(details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] {
  const task = taskForRequest(details, args);
  const command = matchingCommand(details, args);
  const state = task ? stringOr(task.state, "unknown") : undefined;
  const mergeMode = firstNonEmpty([
    typeof args?.interruptMode === "string" ? args.interruptMode : undefined,
    typeof command?.mode === "string" ? command.mode : undefined,
    typeof task?.interruptionMode === "string" ? task.interruptionMode : undefined,
  ], "");
  const outcome = state === "interrupted" || state === "failed"
    ? mergeMode === "interrupt_with_merge" ? "checkpoint landing attempted" : "stopped without landing"
    : state === "conflicted"
      ? "stopped; conflicts materialized in main"
      : state && isActiveTaskState(state as BackgroundTaskState)
        ? "interruption pending"
        : stringOr(state, "outcome not established");
  const lines = headerLines("SubtasksInterrupt", `${stringOr(task?.taskId ?? args?.taskId, "?")} · ${outcome}`);
  if (state === "conflicted") {
    lines.push(...bodyLines(["Manual resolution and SubtasksMarkClean required"], "warning", 1));
  }
  return lines;
}

function forceMergeCard(details: Record<string, any>, args: Record<string, any> | undefined): CardLine[] {
  const task = taskForRequest(details, args);
  const state = task ? stringOr(task.state, "unknown") : undefined;
  const outcome = state === "conflicted"
    ? "conflicts materialized"
    : state === "landed" || state === "reported"
      ? "landed"
      : state && isActiveTaskState(state as BackgroundTaskState)
        ? "in progress"
        : stringOr(state, "outcome not established");
  const lines = headerLines("SubtasksForceMerge", `${stringOr(task?.taskId ?? args?.taskId, "?")} · ${outcome}`);
  if (state === "conflicted") {
    lines.push(...bodyLines(["Manual resolution required"], "warning", 1));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// SubtasksMarkClean
// ---------------------------------------------------------------------------

function markCleanCard(details: Record<string, any>): CardLine[] {
  if (details.cleared === true) {
    const paths = Array.isArray(details.paths) ? details.paths.filter((entry: unknown) => typeof entry === "string" && entry.trim()) : [];
    const lines = headerLines("SubtasksMarkClean", "conflict gate cleared");
    if (paths.length > 0) lines.push(...bodyLines([paths.join(", ")], undefined, 1));
    return lines;
  }
  return headerLines("SubtasksMarkClean", "no active conflict gate");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function headerLines(toolName: string, rest: string): CardLine[] {
  return [{ parts: [
    { text: toolName, color: "toolTitle", bold: true },
    { text: ` · ${rest}`, color: "accent" },
  ] }];
}

function bodyLines(texts: string[], color: string | undefined, indent: number): CardLine[] {
  return texts.map((text) => ({ text: `${" ".repeat(indent)}${text}`, color }));
}

function taskForRequest(details: Record<string, any>, args: Record<string, any> | undefined): Record<string, any> | undefined {
  const tasks = Array.isArray(details.tasks) ? details.tasks.filter(isRecord) : [];
  const requested = typeof args?.taskId === "string" ? args.taskId : undefined;
  if (requested) return tasks.find((task) => task.taskId === requested);
  return tasks.length === 1 ? tasks[0] : undefined;
}

function matchingCommand(details: Record<string, any>, args: Record<string, any> | undefined): Record<string, any> | undefined {
  const task = taskForRequest(details, args);
  const commands = task && Array.isArray(task.commands) ? task.commands.filter(isRecord) : [];
  if (commands.length === 0) return undefined;
  const requestedId = typeof args?.instructionId === "string" ? args.instructionId : undefined;
  if (requestedId) {
    const matched = commands.find((command) => command.instructionId === requestedId);
    if (matched) return matched;
  }
  // Fall back to the newest returned control command for this task (the
  // request's own record when no idempotency handle was supplied).
  return commands.filter((command) => ["continue", "steer", "interrupt", "force_merge"].includes(stringOr(command.action, "?"))).at(-1);
}

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

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function firstNonEmpty(values: Array<string | undefined>, fallback: string): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim().length > 0) ?? "";
}

/** Bounded display clip for one collapsed-card field: collapses whitespace and
 * clips by length only — no content redaction (the model already saw it). */
function clipLine(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text-component contract shared with the other tool renderers: every line
 * fits the supplied width (no minimum floor), narrow rows never receive
 * over-width lines. */
function cardComponent(lines: readonly CardLine[], theme: SubtaskCollapsedRendererTheme) {
  return {
    render: (width: number): string[] => {
      const bounded = Math.max(0, Math.min(width, width - 2));
      return lines.map((line) => {
        if (line.parts) {
          let used = 0;
          const rendered: string[] = [];
          for (const part of line.parts) {
            const clipped = clipToDisplayCells(compactLine(part.text), Math.max(0, bounded - used));
            used += displayWidthOf(clipped);
            rendered.push(part.color === undefined && !part.bold
              ? clipped
              : theme.fg(part.color ?? "toolTitle", part.bold ? theme.bold(clipped) : clipped));
          }
          return rendered.join("");
        }
        const clipped = clipToDisplayCells(compactLine(line.text ?? ""), bounded);
        if (line.color === undefined && !line.bold) return clipped;
        return theme.fg(line.color ?? "toolTitle", line.bold ? theme.bold(clipped) : clipped);
      });
    },
    invalidate() {},
  };
}

function displayWidthOf(value: string): number {
  let width = 0;
  for (const character of value) width += characterWidth(character);
  return width;
}

/** Collapsed card lines carry no ANSI of their own; collapse whitespace runs
 * but keep deliberate leading indentation. */
function compactLine(value: string): string {
  return value.replace(/\s+/g, " ");
}

function clipToDisplayCells(value: string, cells: number): string {
  if (cells <= 0) return "";
  let used = 0;
  let clipped = "";
  for (const character of value) {
    const width = characterWidth(character);
    if (used + width > cells) return `${clipped}…`;
    clipped += character;
    used += width;
  }
  return clipped;
}

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

function characterWidth(character: string): number {
  const code = character.codePointAt(0)!;
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff
    || (code >= 0x0300 && code <= 0x036f)
    || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (EMOJI_PRESENTATION.test(character)) return 2;
  if ((code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}