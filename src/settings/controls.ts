/**
 * Top-level scalar settings pickers for the root menu: operating mode,
 * the mode-cycle hotkey, bundle retention, global concurrency, the retry
 * policy, subtask notifications, and the review policy and timeout
 * duration pairs. Each returns only its edited slice.
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
import { alignedSettingsRows, formatDuration, notify, type UiContext } from "./ui";
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

export async function selectOperatingMode(ui: UiContext, current: OperatingMode): Promise<OperatingMode> {
  const options = OPERATING_MODES.map((mode) => `${OPERATING_MODE_LABELS[mode]}${mode === current ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Operating mode", options);
  return OPERATING_MODES.find((mode) => selected === `${OPERATING_MODE_LABELS[mode]}${mode === current ? "  current" : ""}`) ?? current;
}

export async function selectModeCycleShortcut(ui: UiContext, current: string): Promise<string> {
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
    if (!Number.isInteger(parsed) || parsed < 0) {
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
