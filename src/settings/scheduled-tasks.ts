/**
 * The Scheduled tasks settings submenu: one staged entry per independent
 * scheduled task, keyed by its stable generated identity, with per-field
 * editing, worker/review overrides, save-time workspace expansion, and
 * save-time scheduled-task validation. The image-provenance map is owned
 * by the root menu's staged session; this module only records
 * observation-only provenance for accepted instruction edits.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  cloneScheduledTaskCatalog,
  workerResourceSupportsResearch,
  type ExternalAgentConfig,
  type ReviewGateConfig,
  type ScheduledTaskCatalog,
  type ScheduledTaskDestination,
  type ScheduledTaskEntryConfig,
  type ScheduledTaskKind,
  type ScheduledTaskReviewOverride,
  type WorkerResourceCatalog,
} from "../config";
import { expandHomePath } from "../apply-patch/paths";
import { parseCronExpression } from "../scheduling/cron";
import type { ScopedModelChoice } from "./models";
import { setCatalogKey } from "./catalog-key";
import { selectReviewers } from "./review";
import { editSettingText } from "./text-input";
import { alignedSettingsRows, notify, type UiContext } from "./ui";
import { validateSelection, type SettingsValidationPolicy } from "./validation";
import { executorSelectionLabel, sortedCatalogKeys } from "./workers";
import { retainedSelect } from "./menu";

/** One-line state of the staged scheduled-task catalog for the root row. */
export function scheduledSummary(catalog: ScheduledTaskCatalog): string {
  const ids = Object.keys(catalog);
  if (ids.length === 0) return "None";
  const enabled = ids.filter((id) => catalog[id]!.enabled).length;
  return `${enabled} of ${ids.length} enabled`;
}

/** One-line state of one staged scheduled task for the list rows. */
function scheduledTaskEntrySummary(entry: ScheduledTaskEntryConfig): string {
  const name = entry.name.trim() || "(unnamed)";
  const state = entry.enabled ? "enabled" : "disabled";
  // Issue #222: the destination is shown in place of the subtask kind for
  // orchestrator-turn entries, since the existing agent performs the turn
  // itself; the staged kind still applies if the entry is switched back.
  if ((entry.destination ?? "subtask") !== "subtask") {
    return `${name} — ${entry.cron || "(no schedule)"} — orchestrator turn — ${state}`;
  }
  return `${name} — ${entry.cron || "(no schedule)"} — ${scheduledTaskKindLabel(entry.kind)} — ${state}`;
}

function scheduledTaskKindLabel(kind: ScheduledTaskKind): string {
  return kind === "research" ? "research" : kind === "inplace" ? "in-place" : "execute";
}

/** Issue #222: editor row label for the per-entry schedule destination. */
function scheduledTaskDestinationLabel(destination: ScheduledTaskDestination | undefined): string {
  return destination === "orchestrator-turn" ? "Orchestrator turn" : "Subtask";
}

/** Issue #222 (correction): workspace row summary for the editor. */
function scheduledTaskWorkspaceSummary(entry: ScheduledTaskEntryConfig): string {
  if ((entry.destination ?? "subtask") !== "subtask") {
    const workspace = entry.workspace ?? "";
    return workspace.trim() ? `${workspace} (unused for orchestrator turns)` : "(not needed for orchestrator turns)";
  }
  return entry.workspace || "(not set)";
}

/** Selection options for the destination picker, with the current marked. */
function scheduledTaskDestinationOptions(entry: ScheduledTaskEntryConfig): string[] {
  const orchestrator = (entry.destination ?? "subtask") === "orchestrator-turn";
  return [
    `Subtask — isolated scheduled subtask (default)${orchestrator ? "" : "  current"}`,
    `Orchestrator turn — deliver to the existing agent${orchestrator ? "  current" : ""}`,
  ];
}

/** Compact display preview; never persisted or interpreted. */
function previewText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 48 ? `${singleLine.slice(0, 45)}…` : singleLine || "(not set)";
}

function scheduledTaskWorkerSummary(
  entry: ScheduledTaskEntryConfig,
  workerResources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): string {
  if ((entry.destination ?? "subtask") !== "subtask") return "unused for orchestrator turns";
  if (entry.workerResourceId === undefined) return "Inherit global route";
  const resource = Object.prototype.hasOwnProperty.call(workerResources, entry.workerResourceId)
    ? workerResources[entry.workerResourceId]
    : undefined;
  return resource
    ? executorSelectionLabel(resource.selection, config, scoped)
    : `${entry.workerResourceId} [unavailable]`;
}

function scheduledTaskReviewSummary(entry: ScheduledTaskEntryConfig): string {
  if ((entry.destination ?? "subtask") !== "subtask") return "unused for orchestrator turns";
  if (entry.review === undefined) return "Inherit global subtask review";
  if (entry.review.mode === "off") return "Off (no review)";
  return `${entry.review.reviewers.length} reviewer${entry.review.reviewers.length === 1 ? "" : "s"} selected`;
}

/** Stable generated identity for a new scheduled task; uniqueness is checked. */
function generateScheduledTaskId(catalog: ScheduledTaskCatalog): string {
  let id = `task-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  while (Object.prototype.hasOwnProperty.call(catalog, id)) {
    id = `task-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
  return id;
}

/** Title shared by every surface of the scheduled-task workspace field. */
const WORKSPACE_DIRECTORY_TITLE = "Authorized target workspace directory";

/**
 * Cron editor title (issue #26): a compact heading rendered above the
 * editable prefilled cron text that maps all five fields in order, states
 * the machine-local time basis, and explains the canonical wildcard line.
 */
const CRON_EXPRESSION_TITLE = [
  "Cron expression — 5 fields, machine-local time",
  "minute  hour  day-of-month  month  day-of-week",
  "* * * * * = every minute",
].join("\n");

/**
 * The Scheduled tasks submenu (issue #26): one staged entry per independent
 * scheduled task, keyed by its stable generated identity. Entries are always
 * visible and editable here regardless of the process-local scheduler runtime
 * toggle — defining a schedule and executing it are independent decisions, and
 * saving from an instance whose runtime is off preserves every entry.
 */
export async function selectScheduledTasks(
  ui: UiContext,
  initial: ScheduledTaskCatalog,
  workerResources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  agents: ExternalAgentConfig[],
  /** Native-paste provenance per task id; consumed at Save (image assets). */
  imageProvenance: Map<string, string[]>,
  /**
   * Issue #306: entry ids whose already-run state the user EXPLICITLY
   * toggled in this staged session. Save uses it to tell a manual re-arm
   * apart from a stale snapshot: only an explicit toggle may change the
   * scheduler-recorded alreadyRun; anything else preserves the latest.
   */
  alreadyRunEdited: Set<string>,
): Promise<ScheduledTaskCatalog> {
  const catalog = cloneScheduledTaskCatalog(initial);
  // Caller-local last selection for this loop only (issue #140): keys are the
  // stable task ids, so an edited entry stays highlighted across re-shows.
  let lastKey: string | undefined;
  while (true) {
    const ids = Object.keys(catalog);
    const entryRows = ids.map((id, index) => `${index + 1}. ${scheduledTaskEntrySummary(catalog[id]!)}`);
    const choice = await retainedSelect(ui, {
      title: "Scheduled tasks",
      rows: [
        ...ids.map((id, index) => ({ key: id, label: entryRows[index]! })),
        { key: "action:add", label: "Add scheduled task" },
        { key: "action:back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "action:back") return catalog;
    lastKey = choice;
    if (choice === "action:add") {
      const entered = await editSettingText(
        ui,
        "Scheduled task name",
        "",
        "This UI does not support text input; scheduled tasks cannot be added here.",
      );
      if (entered === undefined) continue;
      const name = entered.trim();
      if (!name) {
        await notify(ui, "Enter a non-empty name, or cancel.", "error");
        continue;
      }
      // Required fields start unset so Save's validation names exactly what is
      // still missing; no default schedule or workspace is ever invented.
      const id = generateScheduledTaskId(catalog);
      setCatalogKey(catalog, id, { name, cron: "", enabled: true, kind: "execute", instructions: "", workspace: "" });
      await editScheduledTaskEntry(ui, catalog, id, workerResources, config, scoped, agents, imageProvenance, alreadyRunEdited);
      continue;
    }
    // Action keys contain ":", which validateConfiguredId rejects, so a
    // configured task id can never collide with them: a hand-edited id like
    // "add" stays editable instead of being shadowed by the Add action, and
    // an unknown value remains a no-op re-show.
    if (Object.prototype.hasOwnProperty.call(catalog, choice)) {
      await editScheduledTaskEntry(ui, catalog, choice, workerResources, config, scoped, agents, imageProvenance, alreadyRunEdited);
    }
  }
}

/**
 * Edit one scheduled task by its stable identity. Name and schedule are
 * display attributes; the identity never changes, so saved references stay
 * valid across renames.
 */
async function editScheduledTaskEntry(
  ui: UiContext,
  catalog: ScheduledTaskCatalog,
  id: string,
  workerResources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  agents: ExternalAgentConfig[],
  imageProvenance: Map<string, string[]>,
  alreadyRunEdited: Set<string>,
): Promise<void> {
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (Object.prototype.hasOwnProperty.call(catalog, id)) {
    const entry = catalog[id]!;
    const [nameRow, cronRow, kindRow, destinationRow, instructionsRow, workspaceRow, workerRow, reviewRow, enabledRow, oneShotRow, alreadyRunRow] = alignedSettingsRows([
      ["Name", entry.name],
      ["Schedule (cron)", entry.cron || "(not set)"],
      ["Kind", scheduledTaskKindLabel(entry.kind)],
      ["Destination", scheduledTaskDestinationLabel(entry.destination)],
      ["Instructions", previewText(entry.instructions)],
      ["Workspace", scheduledTaskWorkspaceSummary(entry)],
      ["Worker", scheduledTaskWorkerSummary(entry, workerResources, config, scoped)],
      ["Review", scheduledTaskReviewSummary(entry)],
      ["Enabled", entry.enabled ? "On" : "Off"],
      // Issue #306: one-shot mode is always editable; the already-run state
      // is editable only for one-shot entries (recurring entries ignore it).
      ["One shot", entry.oneShot === true ? "On" : "Off"],
      ["Already run", entry.oneShot === true ? (entry.alreadyRun === true ? "Yes" : "No") : "n/a (not one-shot)"],
    ]);
    const choice = await retainedSelect(ui, {
      title: `Scheduled task ${id}`,
      rows: [
        { key: "name", label: nameRow },
        { key: "cron", label: cronRow },
        { key: "kind", label: kindRow },
        { key: "destination", label: destinationRow },
        { key: "instructions", label: instructionsRow },
        { key: "workspace", label: workspaceRow },
        { key: "worker", label: workerRow },
        { key: "review", label: reviewRow },
        { key: "enabled", label: enabledRow },
        { key: "oneShot", label: oneShotRow },
        { key: "alreadyRun", label: alreadyRunRow },
        { key: "remove", label: "Remove" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return;
    lastKey = choice;
    if (choice === "name") {
      const entered = await editSettingText(ui, "Scheduled task name", entry.name);
      if (entered === undefined) continue;
      const name = entered.trim();
      if (!name) {
        await notify(ui, "Name must be a non-empty string.", "error");
        continue;
      }
      setCatalogKey(catalog, id, { ...entry, name });
      continue;
    }
    if (choice === "cron") {
      // The heading renders above the editable prefilled cron text: all five
      // fields in order, the machine-local time basis, and the canonical
      // wildcard line (issue #26).
      const entered = await editSettingText(ui, CRON_EXPRESSION_TITLE, entry.cron);
      if (entered === undefined) continue;
      try {
        setCatalogKey(catalog, id, { ...entry, cron: parseCronExpression(entered, "cron expression").expression });
      } catch (error) {
        await notify(ui, error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }
    if (choice === "kind") {
      const kindOptions = [
        `Execute — write-capable subtask${entry.kind === "execute" ? "  current" : ""}`,
        `Research — read-only subtask${entry.kind === "research" ? "  current" : ""}`,
        `In-place — write in a selected directory (no capture/landing)${entry.kind === "inplace" ? "  current" : ""}`,
      ];
      const selected = await ui.select((entry.destination ?? "subtask") === "subtask"
        ? "Scheduled task kind"
        : "Scheduled task kind (used when the destination is Subtask)", kindOptions);
      if (selected?.startsWith("Execute")) setCatalogKey(catalog, id, { ...entry, kind: "execute" });
      else if (selected?.startsWith("Research")) setCatalogKey(catalog, id, { ...entry, kind: "research" });
      else if (selected?.startsWith("In-place")) setCatalogKey(catalog, id, { ...entry, kind: "inplace" });
      continue;
    }
    if (choice === "destination") {
      const options = scheduledTaskDestinationOptions(entry);
      const selected = await ui.select("Schedule destination", options);
      if (selected?.startsWith("Subtask")) {
        // Absence is the subtask default: the stored entry never carries a
        // redundant "subtask" destination key (issue #26 inheritance rule).
        const next: ScheduledTaskEntryConfig = { ...entry };
        delete next.destination;
        setCatalogKey(catalog, id, next);
      } else if (selected?.startsWith("Orchestrator turn")) {
        setCatalogKey(catalog, id, { ...entry, destination: "orchestrator-turn" });
      }
      continue;
    }
    if (choice === "instructions") {
      // Shared host-wired editor in the TUI, non-interactive editor fallback;
      // the same seam as every other typed settings field (issue #26). In the
      // TUI the bridge's observation-only onHostInsert seam records exactly
      // what Pi's own handlers insert (an image paste inserts the temp file
      // path), so Save can verify provenance, validate the actual image, and
      // copy it into the durable managed store. Observation only: no
      // clipboard access, no path interpretation, no asset copying here.
      const pastedInserts: string[] = [];
      const entered = await editSettingText(
        ui,
        "Instructions for the scheduled subtask",
        entry.instructions,
        undefined,
        { onHostInsert: (text) => pastedInserts.push(text) },
      );
      if (entered === undefined) continue;
      if (!entered.trim()) {
        await notify(ui, "Instructions must be a non-empty string.", "error");
        continue;
      }
      // Only accepted edits carry provenance forward: a cancelled field
      // stages nothing, so its observations are discarded.
      if (pastedInserts.length > 0) {
        imageProvenance.set(id, [...(imageProvenance.get(id) ?? []), ...pastedInserts]);
      }
      setCatalogKey(catalog, id, { ...entry, instructions: entered.trim() });
      continue;
    }
    if (choice === "workspace") {
      // One shared field surface like every other text field: in the
      // interactive TUI the host-wired native editor bridge, on
      // non-interactive hosts the public editor prefill, then the legacy
      // input (issue #26). Native absolute-path completion is shared by
      // every field through the bridge: a first-line leading-slash token
      // lists filesystem directories through the host's own provider —
      // never slash commands; the main chat prompt is untouched.
      // Issue #222 (correction): an orchestrator-turn entry never dispatches
      // into a workspace, so its field may be cleared; a subtask entry
      // still requires a non-empty path (Save validates it exists).
      const orchestratorDestination = (entry.destination ?? "subtask") !== "subtask";
      const entered = await editSettingText(ui, WORKSPACE_DIRECTORY_TITLE, entry.workspace ?? "");
      if (entered === undefined) continue;
      if (!entered.trim() && !orchestratorDestination) {
        await notify(ui, "Workspace must be a non-empty string.", "error");
        continue;
      }
      // Expand a leading `~`/`~/...` against the user's home and stage its
      // absolute spelling for Save. Every other spelling is kept verbatim.
      setCatalogKey(catalog, id, { ...entry, workspace: expandHomePath(entered.trim()) });
      continue;
    }
    if (choice === "worker") {
      const next: ScheduledTaskEntryConfig = { ...entry, workerResourceId: await selectScheduledTaskWorker(ui, entry, workerResources, config, scoped) };
      setCatalogKey(catalog, id, next);
      continue;
    }
    if (choice === "review") {
      const override = await selectScheduledTaskReview(ui, entry, agents, scoped);
      if (override !== "unchanged") {
        // Inherit is represented by absence, never by a stored null (issue #26).
        const next: ScheduledTaskEntryConfig = { ...entry };
        if (override === undefined) delete next.review;
        else next.review = override;
        setCatalogKey(catalog, id, next);
      }
      continue;
    }
    if (choice === "enabled") {
      setCatalogKey(catalog, id, { ...entry, enabled: !entry.enabled });
      continue;
    }
    if (choice === "oneShot") {
      // Issue #306: toggling one-shot off keeps any stored alreadyRun value
      // in place (it is ignored for recurring entries and never auto-
      // updated); absence is the false default, so turning it off removes
      // the key rather than storing a redundant false.
      const next: ScheduledTaskEntryConfig = { ...entry };
      if (entry.oneShot === true) delete next.oneShot;
      else next.oneShot = true;
      setCatalogKey(catalog, id, next);
      continue;
    }
    if (choice === "alreadyRun") {
      // Issue #306: only one-shot entries have an editable already-run
      // state. A manual false re-arms the entry for its next matching
      // FUTURE occurrence under its current enabled+cron — never immediate,
      // never catch-up (the runtime's future-only sampling enforces that).
      if (entry.oneShot !== true) {
        await notify(ui, "Only one-shot entries have an already-run state. Enable One shot first.", "error");
        continue;
      }
      alreadyRunEdited.add(id);
      const next: ScheduledTaskEntryConfig = { ...entry };
      if (entry.alreadyRun === true) delete next.alreadyRun; // manual re-arm
      else next.alreadyRun = true; // manual disarm
      setCatalogKey(catalog, id, next);
      continue;
    }
    if (choice === "remove") {
      delete catalog[id];
      // Removed entries keep no provenance: they cannot be saved, and a
      // re-added entry gets a fresh identity and fresh observations.
      imageProvenance.delete(id);
      return;
    }
  }
}

/**
 * Worker override picker. The choices come from the worker resource catalog —
 * never from the global role routes: an explicit task-local selection must not
 * require global-route membership (issue #26), because that would defeat the
 * entry's independence. Research tasks can only pick research-capable
 * resources, matching the stored-record validation.
 */
async function selectScheduledTaskWorker(
  ui: UiContext,
  entry: ScheduledTaskEntryConfig,
  workerResources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): Promise<string | undefined> {
  // The staged catalog is authoritative for this staged session: a resource
  // added earlier in the same unsaved visit is pickable, and one removed
  // earlier is not offered, matching what Save will persist.
  const eligible = Object.entries(workerResources)
    .filter(([, value]) => entry.kind === "execute" || entry.kind === "inplace" || workerResourceSupportsResearch(config, value.selection));
  const rows = sortedCatalogKeys(Object.fromEntries(eligible) as WorkerResourceCatalog, config, scoped);
  const options = [
    `Inherit global route (current at run time)${entry.workerResourceId === undefined ? "  current" : ""}`,
    ...rows.map((resourceId) => {
      const resource = workerResources[resourceId]!;
      return `${executorSelectionLabel(resource.selection, config, scoped)}${entry.workerResourceId === resourceId ? "  current" : ""}`;
    }),
  ];
  const selected = await ui.select(`Worker for scheduled task — ${entry.name}`, options);
  if (selected === undefined) return entry.workerResourceId;
  if (selected.startsWith("Inherit global route")) return undefined;
  const index = options.indexOf(selected);
  // Options 1..n map to the eligible resource rows in order.
  return index >= 1 ? rows[index - 1]! : entry.workerResourceId;
}

/**
 * Review override picker: inherit the live global subtask settings, run the
 * task's subtasks without review (explicit Off, allowed for write-capable
 * tasks too), or pick a task-local reviewer set. A chosen-but-empty reviewer
 * set is rejected instead of being silently reinterpreted as inherit or Off.
 * None of these choices touch the global or parent review state.
 */
async function selectScheduledTaskReview(
  ui: UiContext,
  entry: ScheduledTaskEntryConfig,
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ScheduledTaskReviewOverride | undefined | "unchanged"> {
  const inheritLabel = "Inherit global subtask review settings (current at run time)";
  const offLabel = "Off — run this task's subtasks without review";
  const reviewersLabel = "Select reviewers…";
  const options = [
    `${inheritLabel}${entry.review === undefined ? `  current` : ""}`,
    `${offLabel}${entry.review?.mode === "off" ? `  current` : ""}`,
    `${reviewersLabel} — ${scheduledTaskReviewSummary(entry)}`,
  ];
  const selected = await ui.select("Review for scheduled task — " + entry.name, options);
  if (selected === undefined) return "unchanged";
  if (selected.startsWith(inheritLabel)) return undefined;
  if (selected.startsWith(offLabel)) return { mode: "off" };
  if (selected.startsWith(reviewersLabel)) {
    if (entry.review?.mode === "selected") {
      // Keep the existing selections when the picker opens; a re-shown picker
      // starts from what the task already stages.
      const selectedReviewers = await selectReviewers(ui, entry.review.reviewers, agents, scoped);
      if (selectedReviewers.length === 0) {
        await notify(ui, "Select at least one reviewer, or choose Inherit or Off; the task's review override is unchanged.", "error");
        return "unchanged";
      }
      return { mode: "selected", reviewers: selectedReviewers };
    }
    const selectedReviewers = await selectReviewers(ui, [], agents, scoped);
    if (selectedReviewers.length === 0) {
      await notify(ui, "Select at least one reviewer, or choose Inherit or Off; the task's review override is unchanged.", "error");
      return "unchanged";
    }
    return { mode: "selected", reviewers: selectedReviewers };
  }
  return "unchanged";
}

/**
 * Expand the staged catalog's home-prefixed workspaces before persistence
 * (issue #26). A leading `~`/`~/...` becomes an absolute home path in the
 * saved file; the runtime separately resolves the target's realpath. Every
 * other spelling is untouched — relative paths keep their session-cwd anchor,
 * and `~user` is never reinterpreted.
 */
export function expandScheduledTaskWorkspaces(catalog: ScheduledTaskCatalog): ScheduledTaskCatalog {
  const out: ScheduledTaskCatalog = {};
  for (const [id, entry] of Object.entries(catalog)) {
    // Prototype-safe own-key write (setCatalogKey): an id of "__proto__" (the
    // id grammar accepts it; JSON.parse creates it as own data) must survive
    // this Save-path boundary — a plain assignment would invoke the prototype
    // setter, drop the entry from the staged catalog, and make the merge in
    // persistReviewSettings classify it as staged-then-removed and delete it
    // from the config file.
    setCatalogKey(out, id, { ...entry, workspace: expandHomePath(entry.workspace ?? "") });
  }
  return out;
}

/**
 * Save-time validation for the staged scheduled-task catalog. Every entry
 * must be complete and consistent: a real cron expression, non-empty
 * instructions, an existing authorized workspace directory for the subtask
 * destination (a leading `~`/`~/...` is already expanded to its absolute home
 * path by the save boundary; an orchestrator-turn entry never dispatches into
 * a workspace, so it saves without one), a worker override that resolves in
 * the independent catalog (research-capable for research tasks), and a
 * task-local reviewer set that resolves like any global one.
 */
export async function validateScheduledTasks(
  catalog: ScheduledTaskCatalog,
  workerResources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  sessionCwd?: string,
  policy: SettingsValidationPolicy = {},
): Promise<string | undefined> {
  for (const [id, entry] of Object.entries(catalog)) {
    if (!entry.name.trim()) return `Scheduled task ${id} has no name`;
    try {
      parseCronExpression(entry.cron, `scheduled task "${entry.name}"`);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (!entry.instructions.trim()) return `Scheduled task ${id} has no instructions`;
    // Issue #222: orchestrator-turn entries resolve no workspace, worker
    // resource, or task-local review at dispatch time (the existing agent
    // runs in its current Pi cwd and brings its own model/tools/review), so
    // those stored values are validated only when the entry is dispatched as
    // (or switched back to) the subtask destination.
    if ((entry.destination ?? "subtask") !== "subtask") continue;
    const workspace = entry.workspace?.trim() ?? "";
    if (!workspace) return `Scheduled task ${id} has no workspace`;
    // Pi's native completion and the eventual subtask start both anchor
    // relative paths to this session cwd, not the extension process cwd.
    const candidate = sessionCwd && !isAbsolute(workspace) ? resolve(sessionCwd, workspace) : workspace;
    if (!await directoryExists(candidate)) {
      return `Scheduled task ${id} workspace is not an existing directory: ${entry.workspace}`;
    }
    if (entry.workerResourceId !== undefined) {
      const resource = Object.prototype.hasOwnProperty.call(workerResources, entry.workerResourceId)
        ? workerResources[entry.workerResourceId]
        : undefined;
      if (!resource) return `Scheduled task ${id} references missing worker resource: ${entry.workerResourceId}`;
      if (entry.kind === "research" && !workerResourceSupportsResearch(config, resource.selection)) {
        return `Scheduled task ${id} worker resource is not research-capable: ${entry.workerResourceId}`;
      }
    }
    if (entry.review?.mode === "selected") {
      if (entry.review.reviewers.length === 0) {
        return `Scheduled task ${id} review override selects no reviewers; choose Inherit or Off`;
      }
      const reviewerError = await validateSelection(workerResources, entry.review.reviewers, config, scoped, [], [], policy);
      if (reviewerError) return `Scheduled task ${id}: ${reviewerError}`;
    }
  }
  return undefined;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
