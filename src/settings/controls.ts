/**
 * Top-level scalar settings pickers for the root menu: operating mode,
 * the mode-cycle hotkey, bundle retention, the wave artifact cleanup age,
 * global concurrency, the retry policy, the grouped Subtasks submenu (issue
 * #659) and its subtask notifications choice, and the review policy and
 * timeout duration pairs. Each returns only its edited slice.
 */
import {
  MAX_EXECUTION_WORKERS,
  normalizeModeCycleShortcut,
  OPERATING_MODES,
  type ExecutionRetryPolicy,
  type OperatingMode,
  type RetainBundles,
  type SubtaskNotificationMode,
} from "../config";
import { OPERATING_MODE_LABELS } from "../operating-mode";
import { findOccupiedHostBindings } from "../host-keybindings";
import {
  alignedSettingsRows,
  formatDuration,
  notify,
  withSettingsSectionHelp,
  type SettingsSectionHelp,
  type UiContext,
} from "./ui";
import { retainedChoice, retainedSelect } from "./menu";
import { editSettingText } from "./text-input";

export async function selectSubtaskNotifications(
  ui: UiContext,
  current: SubtaskNotificationMode,
): Promise<SubtaskNotificationMode> {
  const rows: Array<{ label: string; value: SubtaskNotificationMode }> = [
    { label: "Quiet — terminal and recovery events", value: "quiet" },
    { label: "Noisy — include running and reviewing", value: "noisy" },
  ];
  const options = rows.map((row) => `${row.label}${row.value === current ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Subtask notifications", options);
  return rows.find((row) => selected === `${row.label}${row.value === current ? "  current" : ""}`)?.value ?? current;
}

/** The short label one notification mode carries on a menu row. */
function subtaskNotificationLabel(mode: SubtaskNotificationMode): string {
  return mode === "quiet" ? "Quiet" : "Noisy";
}

/**
 * The staged slice of the three subtask notification/display controls
 * grouped under one root **Subtasks** row (issue #659). These are the root
 * menu's existing locals moved into the submenu: the same canonical staged
 * fields, the same defaults, and the same effects — this record is a
 * parameter/return shape only and never a second copy of the settings state.
 */
export interface SubtaskSettingsState {
  subtaskNotifications: SubtaskNotificationMode;
  subtasksViewExpanded: boolean;
  showSubtaskTaskIds: boolean;
}

/**
 * The root **Subtasks** row summary: the same three displayed values the
 * submenu shows, in submenu order.
 */
export function subtasksRootSummary(state: SubtaskSettingsState): string {
  return `${subtaskNotificationLabel(state.subtaskNotifications)} · ${
    state.subtasksViewExpanded ? "Expanded" : "Collapsed"
  } · IDs ${state.showSubtaskTaskIds ? "shown" : "hidden"}`;
}

/**
 * The **Subtasks** submenu (issue #659): the three subtask notification and
 * display controls that previously sat as separate root rows — the
 * notification-mode choice, the expanded/collapsed view toggle, and the
 * task-ID display toggle. Each keeps its previous row label, displayed
 * value, default, and effect; only their grouping moved. Like every other
 * submenu here, it stages into the root menu's single Save/root-Escape/Cancel
 * transaction and returns only its own slice: it never persists, applies, or
 * activates anything, and Back (or Escape) leaves the staged values with the
 * root exactly as before.
 */
export async function selectSubtaskSettings(
  ui: UiContext,
  initial: SubtaskSettingsState,
): Promise<SubtaskSettingsState> {
  let subtaskNotifications = initial.subtaskNotifications;
  let subtasksViewExpanded = initial.subtasksViewExpanded;
  let showSubtaskTaskIds = initial.showSubtaskTaskIds;
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [notificationsRow, viewRow, taskIdsRow] = alignedSettingsRows([
      ["Subtask notifications", subtaskNotificationLabel(subtaskNotifications)],
      ["Subtasks view", subtasksViewExpanded ? "Expanded" : "Collapsed"],
      ["Subtask task IDs", showSubtaskTaskIds ? "Shown" : "Hidden"],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Subtasks",
      rows: [
        { key: "notifications", label: notificationsRow },
        { key: "subtasksView", label: viewRow },
        { key: "subtaskTaskIds", label: taskIdsRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { subtaskNotifications, subtasksViewExpanded, showSubtaskTaskIds };
    lastKey = choice;
    if (choice === "notifications") {
      subtaskNotifications = await selectSubtaskNotifications(ui, subtaskNotifications);
      continue;
    }
    if (choice === "subtasksView") {
      subtasksViewExpanded = !subtasksViewExpanded;
      continue;
    }
    if (choice === "subtaskTaskIds") showSubtaskTaskIds = !showSubtaskTaskIds;
  }
}

export async function selectOperatingMode(ui: UiContext, current: OperatingMode): Promise<OperatingMode> {
  const options = OPERATING_MODES.map((mode) => `${OPERATING_MODE_LABELS[mode]}${mode === current ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Operating mode", options);
  return OPERATING_MODES.find((mode) => selected === `${OPERATING_MODE_LABELS[mode]}${mode === current ? "  current" : ""}`) ?? current;
}

/** Options for the mode-cycle shortcut editor. */
export interface SelectModeCycleShortcutOptions {
  /**
   * Whether this host's live Pi bindings may veto the chord. Default true, so
   * the Local editor and the in-Pi menu keep refusing an occupied chord. The
   * remote Review editor passes false: that config belongs to another host, so
   * the requester validates syntax only and the OWNER applies its own
   * destination keybinding occupancy on Save (#716).
   */
  readonly checkHostOccupancy?: boolean;
}

export async function selectModeCycleShortcut(
  ui: UiContext,
  current: string,
  options: SelectModeCycleShortcutOptions = {},
): Promise<string> {
  while (true) {
    const entered = await editSettingText(
      ui,
      "Mode cycle hotkey (modifiers + key, e.g. alt+m)",
      current,
      "This UI does not support text input; the mode cycle hotkey cannot be edited here.",
    );
    if (entered === undefined) return current;
    const trimmed = entered.trim();
    if (trimmed.length === 0) {
      await notify(ui, "Enter a shortcut such as alt+m, or cancel to keep the current one.", "error");
      continue;
    }
    let normalized: string;
    try {
      normalized = normalizeModeCycleShortcut(trimmed);
    } catch (error) {
      await notify(ui, error instanceof Error ? error.message : String(error), "error");
      continue;
    }
    if (options.checkHostOccupancy !== false) {
      // Never steal an occupied host binding: a key that Pi's live resolution
      // shows as a built-in binding is rejected and re-prompted, so the built-in
      // action keeps working. Conflicts with other extensions are not detectable
      // here (Pi reports those itself at startup) and are not claimed to be.
      const occupancy = findOccupiedHostBindings(normalized);
      if (occupancy.resolved && occupancy.bindings.length > 0) {
        await notify(
          ui,
          `'${normalized}' is also used by built-in Pi binding(s) (${occupancy.bindings.join(", ")}); pick a different key so the built-in action keeps working.`,
          "error",
        );
        continue;
      }
    }
    return normalized;
  }
}

export async function selectBundleRetention(ui: UiContext, current: RetainBundles): Promise<RetainBundles> {
  const rows: Array<{ label: string; value: RetainBundles }> = [
    { label: "On failure", value: "on-failure" },
    { label: "Always", value: "always" },
    { label: "Never", value: "never" },
  ];
  const options = rows.map((row) => `${row.label}${row.value === current ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Bundle retention", options);
  return rows.find((row) => selected === `${row.label}${row.value === current ? "  current" : ""}`)?.value ?? current;
}

/**
 * The Retention submenu's help (issue #729): what each of the three controls
 * governs, and the precedence that keeps an age-based wave collection from
 * running while Bundle retention is **Always**. Pi hosts get the full text as
 * one notice on entry; a single-notice host (the sidebar) gets the concise
 * summary in its own notice slot, which wraps and opens whole in its reader —
 * a narrow row label is never the only place this is explained.
 */
const RETENTION_SECTION_HELP: SettingsSectionHelp = {
  full: "Retention has three independent controls. Bundle retention decides which review bundles are kept: never, on failure, or always. Wave artifact cleanup age is the age after which completed, non-recoverable wave artifact roots are collected; enter a whole number of milliseconds or a whole number with an ms, s, m, h, or d suffix, and 0 disables age-based collection. While Bundle retention is always, age-based wave collection stays suppressed whatever this threshold says: the configured age is kept and becomes effective again once Bundle retention is not always, and choosing always never changes it. Spawned Pi sessions deletes only the native Pi sessions this extension spawned, and only at cleanup points that already exist. Saving or applying any of these never runs a cleanup or purge: cleanup timing, artifact eligibility, and the recovery protections are unchanged.",
  summary: "Retention: bundle retention, the wave artifact cleanup age (0 disables age-based collection), and spawned-session deletion. Bundle retention Always suppresses age-based wave cleanup whatever the saved age says, and the configured age is kept. Details: docs/settings.md#review-settings (Retention).",
};

/**
 * The Retention submenu: the existing bundle-retention choice, the existing
 * wave artifact cleanup age (issue #729), and the opt-in deletion of the
 * native Pi sessions this extension spawned (issue #533). Every edit returns
 * only when the caller leaves the submenu, and the submenu's help carries the
 * Always precedence explanation. `waveArtifactTtlMsEdited` reports an accepted
 * age entry, which is what makes a later Save persist the age; an untouched or
 * rejected one leaves the stored threshold to the persistence boundary.
 */
export async function selectRetention(
  ui: UiContext,
  initialRetention: RetainBundles,
  initialWaveArtifactTtlMs: number,
  initialDeleteSessions: boolean,
): Promise<{
  retainBundles: RetainBundles;
  waveArtifactTtlMs: number;
  waveArtifactTtlMsEdited: boolean;
  deleteSpawnedPiSessions: boolean;
}> {
  return await withSettingsSectionHelp(ui, RETENTION_SECTION_HELP, async () => {
    let retainBundles = initialRetention;
    let waveArtifactTtlMs = initialWaveArtifactTtlMs;
    let waveArtifactTtlMsEdited = false;
    let deleteSpawnedPiSessions = initialDeleteSessions;
    // Caller-local last selection for this loop only (issue #140).
    let lastKey: string | undefined;
    while (true) {
      const [bundlesRow, waveRow, sessionsRow] = alignedSettingsRows([
        ["Bundle retention", retentionLabel(retainBundles)],
        ["Wave artifact cleanup age", waveArtifactAgeSummary(waveArtifactTtlMs, retainBundles)],
        ["Spawned Pi sessions", deleteSpawnedPiSessions ? "Deleted on cleanup" : "Retained"],
      ]);
      const choice = await retainedSelect(ui, {
        title: "Retention",
        rows: [
          { key: "bundles", label: bundlesRow },
          { key: "waveArtifactAge", label: waveRow },
          { key: "sessions", label: sessionsRow },
          { key: "back", label: "Back" },
        ],
        initialKey: lastKey,
      });
      if (!choice || choice === "back") return { retainBundles, waveArtifactTtlMs, waveArtifactTtlMsEdited, deleteSpawnedPiSessions };
      lastKey = choice;
      if (choice === "bundles") {
        retainBundles = await selectBundleRetention(ui, retainBundles);
        continue;
      }
      if (choice === "waveArtifactAge") {
        // The existing canonical field is edited in place: an accepted entry is
        // staged like every other retention choice, an invalid or cancelled one
        // leaves the staged age unchanged, and neither path runs a cleanup. The
        // prefill is the same duration the row shows, in its parseable spelling,
        // so reopening a six-hour age offers `6h` rather than a bare number.
        const entered = await editSettingText(
          ui,
          WAVE_ARTIFACT_AGE_FIELD_PROMPT,
          waveArtifactAgeInput(waveArtifactTtlMs),
        );
        if (entered === undefined) continue;
        const parsed = parseWaveArtifactAge(entered);
        if (parsed === undefined) {
          await notify(
            ui,
            "Enter a whole number of milliseconds (for example 21600000) or a duration with a unit such as 6h, 45m, 30d; 0 disables age-based cleanup.",
            "error",
          );
          continue;
        }
        waveArtifactTtlMs = parsed;
        waveArtifactTtlMsEdited = true;
        continue;
      }
      deleteSpawnedPiSessions = !deleteSpawnedPiSessions;
    }
  });
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The accepted unit suffixes for one wave artifact cleanup age entry. */
const WAVE_ARTIFACT_AGE_UNITS: Record<string, number> = {
  ms: 1,
  s: SECOND_MS,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
};

/** The row prompt the wave artifact cleanup age field shows. */
const WAVE_ARTIFACT_AGE_FIELD_PROMPT =
  "Wave artifact cleanup age in milliseconds or with a unit suffix (6h, 45m, 30d; 0 disables age-based cleanup)";

/**
 * How one wave artifact cleanup age reads on the Retention row: the age with
 * clear units, the zero-as-disabled wording, and — when bundle retention is
 * **Always** — the existing precedence that suppresses age-based collection
 * whatever this threshold says. The staged threshold itself is never changed
 * by a retention choice.
 */
export function waveArtifactAgeSummary(waveArtifactTtlMs: number, retainBundles: RetainBundles): string {
  const age = formatWaveArtifactAge(waveArtifactTtlMs);
  if (retainBundles === "always") return `${age} · suppressed while Bundle retention is Always`;
  return age;
}

/**
 * One wave artifact cleanup age with clear units: the largest whole unit is
 * shown, so the 30-day default reads `30 days`, six hours reads `6h`, and a
 * sub-second threshold keeps its exact millisecond value. Zero reads as the
 * disabled state it means.
 */
export function formatWaveArtifactAge(milliseconds: number): string {
  if (milliseconds === 0) return "0 · age-based cleanup disabled";
  if (milliseconds % DAY_MS === 0) {
    const days = milliseconds / DAY_MS;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (milliseconds % HOUR_MS === 0) return `${milliseconds / HOUR_MS}h`;
  if (milliseconds % MINUTE_MS === 0) return `${milliseconds / MINUTE_MS}m`;
  if (milliseconds % SECOND_MS === 0) return `${milliseconds / SECOND_MS}s`;
  return `${milliseconds}ms`;
}

/**
 * The editor prefill for one wave artifact cleanup age: the same duration the
 * row shows, in the parseable spelling {@link parseWaveArtifactAge} accepts —
 * `6h`, `30d`, `2500ms`, `0` — so a reopened field names the current value
 * instead of leaving the user to read a bare number.
 */
export function waveArtifactAgeInput(milliseconds: number): string {
  if (milliseconds === 0) return "0";
  if (milliseconds % DAY_MS === 0) return `${milliseconds / DAY_MS}d`;
  if (milliseconds % HOUR_MS === 0) return `${milliseconds / HOUR_MS}h`;
  if (milliseconds % MINUTE_MS === 0) return `${milliseconds / MINUTE_MS}m`;
  if (milliseconds % SECOND_MS === 0) return `${milliseconds / SECOND_MS}s`;
  return `${milliseconds}ms`;
}

/**
 * Parse one wave artifact cleanup age entry: a bare non-negative whole number
 * of milliseconds (the canonical `waveArtifactTtlMs` spelling), or a whole
 * number with an `ms`, `s`, `m`, `h`, or `d` unit suffix. Anything else —
 * empty, negative, fractional, or a value beyond the canonical safe-integer
 * range the config validation accepts — returns undefined so the caller keeps
 * the staged age and re-prompts.
 */
export function parseWaveArtifactAge(entry: string): number | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(trimmed);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return undefined;
  const unitMs = match[2] === undefined ? 1 : WAVE_ARTIFACT_AGE_UNITS[match[2].toLowerCase()];
  if (unitMs === undefined) return undefined;
  const milliseconds = amount * unitMs;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export async function selectMaxWorkers(ui: UiContext, current: number): Promise<number> {
  const options = Array.from({ length: MAX_EXECUTION_WORKERS }, (_, index) => String(index + 1))
    .map((v) => `${v}${v === String(current) ? "  current" : ""}`);
  const selected = await retainedChoice(ui, `Global concurrency (1–${MAX_EXECUTION_WORKERS})`, options);
  const parsed = Number(selected?.split(" ")[0]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_EXECUTION_WORKERS ? parsed : current;
}

export async function selectRetryPolicy(ui: UiContext, initial: ExecutionRetryPolicy): Promise<ExecutionRetryPolicy> {
  let policy = { ...initial };
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [retriesRow, baseRow, maxRow, repeatsRow, jitterRow] = alignedSettingsRows([
      ["Retries after initial attempt", String(policy.maxRetries)],
      ["Base delay", formatDuration(policy.baseDelayMs)],
      ["Maximum delay", formatDuration(policy.maxDelayMs)],
      ["Same-incident repeat limit", String(policy.maxSameIncidentRepeats)],
      ["Delay jitter", policy.jitter ? "Enabled" : "Disabled"],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Executor retry policy",
      rows: [
        { key: "retries", label: retriesRow },
        { key: "base", label: baseRow },
        { key: "max", label: maxRow },
        { key: "repeats", label: repeatsRow },
        { key: "jitter", label: jitterRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return policy;
    lastKey = choice;
    if (choice === "jitter") {
      policy.jitter = !policy.jitter;
      continue;
    }
    const isDelay = choice === "base" || choice === "max";
    const current = choice === "retries"
      ? policy.maxRetries
      : choice === "base"
        ? policy.baseDelayMs
        : choice === "max"
          ? policy.maxDelayMs
          : policy.maxSameIncidentRepeats;
    const entered = await editSettingText(
      ui,
      isDelay ? "Delay in milliseconds" : "Retry limit",
      String(current),
      "This UI does not support numeric input.",
    );
    if (entered === undefined) continue;
    const parsed = Number(entered.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      await notify(ui, "Enter a non-negative whole number.", "error");
      continue;
    }
    const next = { ...policy };
    if (choice === "retries") next.maxRetries = parsed;
    else if (choice === "base") next.baseDelayMs = parsed;
    else if (choice === "max") next.maxDelayMs = parsed;
    else next.maxSameIncidentRepeats = parsed;
    if (next.maxDelayMs < next.baseDelayMs) {
      await notify(ui, "Maximum delay must be greater than or equal to base delay.", "error");
      continue;
    }
    policy = next;
  }
}

export function retentionLabel(value: RetainBundles): string {
  if (value === "on-failure") return "On failure";
  if (value === "always") return "Always";
  return "Never";
}

/** Root-row summary; unchanged wording while session deletion stays Off. */
export function retentionSummary(retainBundles: RetainBundles, deleteSpawnedPiSessions: boolean): string {
  return deleteSpawnedPiSessions ? `${retentionLabel(retainBundles)} · sessions deleted` : retentionLabel(retainBundles);
}

export async function selectReviewPolicy(
  ui: UiContext,
  initialCycles: number,
  initialThreshold: number,
): Promise<{ maxCorrectionCycles: number; guidanceThreshold: number }> {
  let maxCorrectionCycles = initialCycles;
  let guidanceThreshold = initialThreshold;
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [cyclesRow, guidanceRow] = alignedSettingsRows([
      ["Automatic correction attempts", String(maxCorrectionCycles)],
      ["Concrete guidance after", String(guidanceThreshold)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Review policy",
      rows: [
        { key: "cycles", label: cyclesRow },
        { key: "guidance", label: guidanceRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { maxCorrectionCycles, guidanceThreshold };
    lastKey = choice;
    const current = choice === "cycles" ? maxCorrectionCycles : guidanceThreshold;
    const entered = await editSettingText(
      ui,
      choice === "cycles" ? "Automatic correction attempts" : "Concrete guidance after correction attempts",
      String(current),
      "This UI does not support numeric input.",
    );
    if (entered === undefined) continue;
    const parsed = Number(entered.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      await notify(ui, "Enter a non-negative whole number.", "error");
      continue;
    }
    if (choice === "cycles") maxCorrectionCycles = parsed;
    else guidanceThreshold = parsed;
  }
}

export async function selectTimeouts(
  ui: UiContext,
  initialReviewerTimeoutMs: number,
  initialExecutorTimeoutMs: number,
): Promise<{ reviewerTimeoutMs: number; executorTimeoutMs: number }> {
  let reviewerTimeoutMs = initialReviewerTimeoutMs;
  let executorTimeoutMs = initialExecutorTimeoutMs;
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [reviewerRow, executorRow] = alignedSettingsRows([
      ["Reviewer timeout", formatDuration(reviewerTimeoutMs)],
      ["Executor timeout", formatDuration(executorTimeoutMs)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Timeouts",
      rows: [
        { key: "reviewer", label: reviewerRow },
        { key: "executor", label: executorRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { reviewerTimeoutMs, executorTimeoutMs };
    lastKey = choice;
    const currentMs = choice === "reviewer" ? reviewerTimeoutMs : executorTimeoutMs;
    const entered = await editSettingText(
      ui,
      choice === "reviewer" ? "Reviewer timeout in minutes" : "Executor timeout in minutes",
      String(currentMs / 60_000),
      "This UI does not support numeric input.",
    );
    if (entered === undefined) continue;
    const minutes = Number(entered.trim());
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60_000 > Number.MAX_SAFE_INTEGER) {
      await notify(ui, "Enter a positive number of minutes.", "error");
      continue;
    }
    const timeoutMs = Math.round(minutes * 60_000);
    if (choice === "reviewer") reviewerTimeoutMs = timeoutMs;
    else executorTimeoutMs = timeoutMs;
  }
}
