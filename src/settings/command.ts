import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  DEFAULT_DEFERRED_PI_TOOLS,
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  MAX_EXECUTION_WORKERS,
  externalAgentCatalog,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  executorEntryId,
  executorSelectionKey,
  resolvedWorkerResources,
  resolvedWorkerRoute,
  workerResourceSupportsResearch,
  resolveReviewers,
  type ActiveReviewerSelection,
  type BrowserInteractionApproval,
  type ExecutorPoolEntry,
  type ExecutorSelection,
  type ExternalAgentConfig,
  type ExecutionRetryPolicy,
  type RetainBundles,
  type ReviewGateConfig,
  type SubtaskNotificationMode,
  type ThinkingLevel,
  type WorkerRouteEntry,
} from "../config";
import { sendNotice } from "../pi";
import { scopedModelChoices, type ScopedModelChoice } from "./models";
import { persistReviewSettings, replaceConfig } from "./persistence";

interface RegisterSettingsInput {
  pi: unknown;
  config: ReviewGateConfig;
  configPath?: string;
  onSaved?: (config: ReviewGateConfig) => void | Promise<void>;
  onScopedModels?: (models: string[]) => void;
}

interface UiContext {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export function registerReviewSettings(input: RegisterSettingsInput): void {
  if (!isRecord(input.pi) || typeof input.pi.registerCommand !== "function") return;
  input.pi.registerCommand("review-settings", {
    description: "Configure delegated execution, deferred Pi tools, reviewers, review policy, web tools, and retention.",
    handler: async (_args: string, ctx: unknown) => {
      const ui = extractUi(ctx);
      if (!ui) {
        await sendNotice(ctx, "review gate: /review-settings requires an interactive selector UI");
        return;
      }
      if (!input.configPath) {
        await notify(ui, "No persistent review-gate config file is loaded.", "error");
        return;
      }
      const scoped = scopedModelChoices(ctx) ?? [];
      input.onScopedModels?.(scoped.map((choice) => choice.model));
      await runSettingsMenu({ ...input, ui, scoped });
    },
  });
}

async function runSettingsMenu(input: RegisterSettingsInput & { ui: UiContext; scoped: ScopedModelChoice[] }): Promise<void> {
  const agents = externalAgentCatalog(input.config);
  let workerResources = materializeExecutorPool(resolvedWorkerResources(input.config), input.scoped);
  let executeRoute = initialWorkerRoute(input.config, "execute", workerResources);
  let researchRoute = initialWorkerRoute(input.config, "research", workerResources);
  workerResources = workerResources.map(withoutResourceThinking);
  let activeReviewers = materializeReviewerThinking(initialReviewerSelections(input.config), input.scoped);
  let reviewerTimeoutMs = input.config.reviewerTimeoutMs;
  let executorTimeoutMs = input.config.executorTimeoutMs;
  let maxCorrectionCycles = input.config.maxCorrectionCycles;
  let guidanceThreshold = input.config.implementationGuidanceAfterCorrectionAttempts;
  let retainBundles = input.config.retainBundles;
  let maxWorkers = input.config.execution?.maxWorkers ?? DEFAULT_MAX_WORKERS;
  let retryPolicy = { ...(input.config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY) };
  let subtaskNotifications = input.config.execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE;
  let deferredPiTools = input.config.execution?.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS;
  let subtasksViewExpanded = input.config.ui?.subtasksViewExpanded === true;
  let webMaxDownloadBytes = input.config.web!.fetch.maxDownloadBytes;
  let browserInteractionApproval = input.config.web!.browserInteractionApproval ?? "ask";

  while (true) {
    const totalReviewerChoices = input.scoped.length + agents.filter(externalAgentSupportsReview).length;
    const reviewStatus = input.config.enabled
      ? activeReviewers.length === 0 ? " — review disabled" : ""
      : " — review disabled by master setting";
    const [resourcesRow, executeRouteRow, researchRouteRow, reviewersRow, timeoutsRow, policyRow, retentionRow, workersRow, retryRow, notificationsRow, deferredToolsRow, subtasksViewRow, webRow] = alignedSettingsRows([
      ["Worker resources", executorPoolSummary(workerResources)],
      ["Execution priority", workerRouteSummary(executeRoute, workerResources, agents, input.scoped)],
      ["Research priority", workerRouteSummary(researchRoute, workerResources, agents, input.scoped)],
      ["Reviewers", `${activeReviewers.length}/${totalReviewerChoices} selected${reviewStatus}`],
      ["Timeouts", `review ${formatDuration(reviewerTimeoutMs)} · executor ${formatDuration(executorTimeoutMs)}`],
      ["Review policy", `${maxCorrectionCycles} corrections · concrete after ${guidanceThreshold}`],
      ["Bundle retention", retentionLabel(retainBundles)],
      ["Global concurrency", String(maxWorkers)],
      ["Retry policy", `${retryPolicy.maxRetries} retries · ${formatDuration(retryPolicy.baseDelayMs)} base`],
      ["Subtask notifications", subtaskNotifications === "quiet" ? "Quiet" : "Noisy"],
      ["Deferred Pi tools", `${deferredPiTools ? "On" : "Off"} · local now, new subtasks`],
      ["Subtasks view", subtasksViewExpanded ? "Expanded" : "Collapsed"],
      ["Web", `${formatByteSize(webMaxDownloadBytes)} max download`],
    ]);
    const choice = await input.ui.select("Review settings", [
      resourcesRow,
      executeRouteRow,
      researchRouteRow,
      reviewersRow,
      timeoutsRow,
      policyRow,
      retentionRow,
      workersRow,
      retryRow,
      notificationsRow,
      deferredToolsRow,
      subtasksViewRow,
      webRow,
      "Save changes",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return;
    if (choice === resourcesRow) {
      const priorResourceIds = new Set(workerResources.map((entry) => entry.entryId));
      workerResources = await selectExecutorPool(input.ui, workerResources, agents, input.scoped);
      executeRoute = reconcileWorkerRoute(executeRoute, workerResources);
      researchRoute = reconcileWorkerRoute(
        researchRoute,
        workerResources.filter((entry) => workerResourceSupportsResearch(input.config, entry)),
      );
      for (const resource of workerResources) {
        if (priorResourceIds.has(resource.entryId)) continue;
        const routeEntry = defaultWorkerRouteEntry(resource, input.scoped);
        executeRoute.push({ ...routeEntry });
        if (workerResourceSupportsResearch(input.config, resource)) researchRoute.push({ ...routeEntry });
      }
      continue;
    }
    if (choice === executeRouteRow) {
      executeRoute = await selectWorkerRoute(input.ui, "Execution priority", executeRoute, workerResources, agents, input.scoped);
      continue;
    }
    if (choice === researchRouteRow) {
      researchRoute = await selectWorkerRoute(
        input.ui,
        "Research priority",
        researchRoute,
        workerResources.filter((entry) => workerResourceSupportsResearch(input.config, entry)),
        agents,
        input.scoped,
      );
      continue;
    }
    if (choice === reviewersRow) {
      activeReviewers = await selectReviewers(input.ui, activeReviewers, agents, input.scoped);
      continue;
    }
    if (choice === timeoutsRow) {
      ({ reviewerTimeoutMs, executorTimeoutMs } = await selectTimeouts(
        input.ui,
        reviewerTimeoutMs,
        executorTimeoutMs,
      ));
      continue;
    }
    if (choice === policyRow) {
      ({ maxCorrectionCycles, guidanceThreshold } = await selectReviewPolicy(
        input.ui,
        maxCorrectionCycles,
        guidanceThreshold,
      ));
      continue;
    }
    if (choice === retentionRow) {
      retainBundles = await selectBundleRetention(input.ui, retainBundles);
      continue;
    }
    if (choice === workersRow) {
      maxWorkers = await selectMaxWorkers(input.ui, maxWorkers);
      continue;
    }
    if (choice === retryRow) {
      retryPolicy = await selectRetryPolicy(input.ui, retryPolicy);
      continue;
    }
    if (choice === notificationsRow) {
      subtaskNotifications = await selectSubtaskNotifications(input.ui, subtaskNotifications);
      continue;
    }
    if (choice === deferredToolsRow) {
      deferredPiTools = !deferredPiTools;
      continue;
    }
    if (choice === subtasksViewRow) {
      subtasksViewExpanded = !subtasksViewExpanded;
      continue;
    }
    if (choice === webRow) {
      ({ maxDownloadBytes: webMaxDownloadBytes, browserInteractionApproval } = await selectWebSettings(
        input.ui, webMaxDownloadBytes, browserInteractionApproval,
      ));
      continue;
    }
    const error = await validateSelection(workerResources, activeReviewers, agents, input.config, input.scoped, executeRoute, researchRoute);
    if (error) {
      await notify(input.ui, error, "error");
      continue;
    }
    const next = await persistReviewSettings(input.configPath!, {
      workerResources,
      executeRoute,
      researchRoute,
      activeReviewers,
      reviewerTimeoutMs,
      executorTimeoutMs,
      maxCorrectionCycles,
      implementationGuidanceAfterCorrectionAttempts: guidanceThreshold,
      retainBundles,
      maxWorkers,
      retryPolicy,
      subtaskNotifications,
      deferredPiTools,
      subtasksViewExpanded,
      webMaxDownloadBytes,
      browserInteractionApproval,
    });
    replaceConfig(input.config, next);
    await input.onSaved?.(input.config);
    await notify(input.ui, "Review settings saved.", "info");
    return;
  }
}

const BROWSER_APPROVAL_CHOICES: Record<BrowserInteractionApproval, string> = {
  ask: "Ask",
  "automatically-accept": "Automatically Accept",
  "automatically-deny": "Automatically Deny",
};

async function selectWebSettings(
  ui: UiContext,
  initialMaxDownloadBytes: number,
  initialApproval: BrowserInteractionApproval,
): Promise<{ maxDownloadBytes: number; browserInteractionApproval: BrowserInteractionApproval }> {
  let maxDownloadBytes = initialMaxDownloadBytes;
  let browserInteractionApproval = initialApproval;
  while (true) {
    const [downloadRow, approvalRow] = alignedSettingsRows([
      ["Maximum download", formatByteSize(maxDownloadBytes)],
      ["Browser interaction approval", BROWSER_APPROVAL_CHOICES[browserInteractionApproval]],
    ]);
    const choice = await ui.select("Web settings", [downloadRow, approvalRow, "Back"]);
    if (!choice || choice === "Back") return { maxDownloadBytes, browserInteractionApproval };
    if (choice === approvalRow) {
      await notify(ui, "Only confirmation-required actions: Ask prompts (no UI rejects); Automatically Accept approves without UI; Automatically Deny rejects. Already-permitted observations/local actions stay permitted; hard safety and role restrictions remain. Saved changes apply locally now and to newly launched workers.", "info");
      const selected = await ui.select("Browser interaction approval", Object.values(BROWSER_APPROVAL_CHOICES));
      const entry = Object.entries(BROWSER_APPROVAL_CHOICES).find(([, label]) => label === selected);
      if (entry) browserInteractionApproval = entry[0] as BrowserInteractionApproval;
      continue;
    }
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const entered = await ui.input("Maximum download size in MiB", String(maxDownloadBytes / (1024 * 1024)));
    if (entered === undefined) continue;
    const mebibytes = Number(entered.trim());
    if (!Number.isSafeInteger(mebibytes) || mebibytes < 1 || mebibytes > 2_048) {
      await notify(ui, "Enter a whole number from 1 through 2048 MiB.", "error");
      continue;
    }
    maxDownloadBytes = mebibytes * 1024 * 1024;
  }
}

async function selectSubtaskNotifications(
  ui: UiContext,
  current: SubtaskNotificationMode,
): Promise<SubtaskNotificationMode> {
  const rows: Array<{ label: string; value: SubtaskNotificationMode }> = [
    { label: "Quiet — terminal and recovery events", value: "quiet" },
    { label: "Noisy — include running and reviewing", value: "noisy" },
  ];
  const options = rows.map((row) => `${row.label}${row.value === current ? "  current" : ""}`);
  const selected = await ui.select("Subtask notifications", options);
  return rows.find((row) => selected === `${row.label}${row.value === current ? "  current" : ""}`)?.value ?? current;
}

async function selectBundleRetention(ui: UiContext, current: RetainBundles): Promise<RetainBundles> {
  const rows: Array<{ label: string; value: RetainBundles }> = [
    { label: "On failure", value: "on-failure" },
    { label: "Always", value: "always" },
    { label: "Never", value: "never" },
  ];
  const options = rows.map((row) => `${row.label}${row.value === current ? "  current" : ""}`);
  const selected = await ui.select("Bundle retention", options);
  return rows.find((row) => selected === `${row.label}${row.value === current ? "  current" : ""}`)?.value ?? current;
}

async function selectMaxWorkers(ui: UiContext, current: number): Promise<number> {
  const options = Array.from({ length: MAX_EXECUTION_WORKERS }, (_, index) => String(index + 1))
    .map((v) => `${v}${v === String(current) ? "  current" : ""}`);
  const selected = await ui.select(`Global concurrency (1–${MAX_EXECUTION_WORKERS})`, options);
  const parsed = Number(selected?.split(" ")[0]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_EXECUTION_WORKERS ? parsed : current;
}

async function selectRetryPolicy(ui: UiContext, initial: ExecutionRetryPolicy): Promise<ExecutionRetryPolicy> {
  let policy = { ...initial };
  while (true) {
    const [retriesRow, baseRow, maxRow, repeatsRow, jitterRow] = alignedSettingsRows([
      ["Retries after initial attempt", String(policy.maxRetries)],
      ["Base delay", formatDuration(policy.baseDelayMs)],
      ["Maximum delay", formatDuration(policy.maxDelayMs)],
      ["Same-incident repeat limit", String(policy.maxSameIncidentRepeats)],
      ["Delay jitter", policy.jitter ? "Enabled" : "Disabled"],
    ]);
    const choice = await ui.select("Executor retry policy", [retriesRow, baseRow, maxRow, repeatsRow, jitterRow, "Back"]);
    if (!choice || choice === "Back") return policy;
    if (choice === jitterRow) {
      policy.jitter = !policy.jitter;
      continue;
    }
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const isDelay = choice === baseRow || choice === maxRow;
    const current = choice === retriesRow
      ? policy.maxRetries
      : choice === baseRow
        ? policy.baseDelayMs
        : choice === maxRow
          ? policy.maxDelayMs
          : policy.maxSameIncidentRepeats;
    const entered = await ui.input(isDelay ? "Delay in milliseconds" : "Retry limit", String(current));
    if (entered === undefined) continue;
    const parsed = Number(entered.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      await notify(ui, "Enter a non-negative whole number.", "error");
      continue;
    }
    const next = { ...policy };
    if (choice === retriesRow) next.maxRetries = parsed;
    else if (choice === baseRow) next.baseDelayMs = parsed;
    else if (choice === maxRow) next.maxDelayMs = parsed;
    else next.maxSameIncidentRepeats = parsed;
    if (next.maxDelayMs < next.baseDelayMs) {
      await notify(ui, "Maximum delay must be greater than or equal to base delay.", "error");
      continue;
    }
    policy = next;
  }
}

function retentionLabel(value: RetainBundles): string {
  if (value === "on-failure") return "On failure";
  if (value === "always") return "Always";
  return "Never";
}

function alignedSettingsRows(entries: ReadonlyArray<readonly [label: string, value: string]>): string[] {
  const labelWidth = Math.max(0, ...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
}

async function selectExecutorPool(
  ui: UiContext,
  initial: ExecutorPoolEntry[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ExecutorPoolEntry[]> {
  let pool = initial.map(cloneExecutorPoolEntry);
  while (true) {
    const entryRows = pool.map((entry, index) => `${index + 1}. ${executorPoolEntrySummary(entry, agents, scoped)}`);
    const choice = await ui.select("Worker resources — shared capacity", [...entryRows, "Add worker resource", "Back"]);
    if (!choice || choice === "Back") return pool;
    if (choice === "Add worker resource") {
      const selection = await selectExecutorModel(ui, undefined, pool, agents, scoped);
      if (!selection) continue;
      const maxConcurrent = await selectExecutorCapacity(ui, 1);
      pool.push({ entryId: executorEntryId(selection), selection, maxConcurrent });
      continue;
    }
    const index = entryRows.indexOf(choice);
    if (index < 0) continue;
    pool = await editExecutorPoolEntry(ui, pool, index, agents, scoped);
  }
}

function initialWorkerRoute(
  config: ReviewGateConfig,
  kind: "execute" | "research",
  resources: ExecutorPoolEntry[],
): WorkerRouteEntry[] {
  const configured = config.execution?.routes?.[kind];
  if (configured) return configured.map((entry) => ({ ...entry }));
  const resolved = resolvedWorkerRoute(config, kind);
  return resolved.flatMap((entry) => resources.some((resource) => resource.entryId === entry.entryId)
    ? [{
        resourceId: entry.entryId,
        thinkingLevel: entry.selection.source === "pi" ? entry.selection.thinkingLevel : undefined,
      }]
    : []);
}

function reconcileWorkerRoute(route: WorkerRouteEntry[], resources: ExecutorPoolEntry[]): WorkerRouteEntry[] {
  const available = new Set(resources.map((entry) => entry.entryId));
  return route.filter((entry) => available.has(entry.resourceId));
}

function defaultWorkerRouteEntry(resource: ExecutorPoolEntry, scoped: ScopedModelChoice[]): WorkerRouteEntry {
  const selection = resource.selection;
  const choice = selection.source === "pi"
    ? scoped.find((candidate) => candidate.model === selection.model)
    : undefined;
  return {
    resourceId: resource.entryId,
    thinkingLevel: choice ? effectiveThinkingLevel(undefined, choice) : undefined,
  };
}

async function selectWorkerRoute(
  ui: UiContext,
  title: string,
  initial: WorkerRouteEntry[],
  resources: ExecutorPoolEntry[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<WorkerRouteEntry[]> {
  let route = reconcileWorkerRoute(initial.map((entry) => ({ ...entry })), resources);
  while (true) {
    const rows = route.map((entry, index) => `${index + 1}. ${workerRouteEntrySummary(entry, resources, agents, scoped)}`);
    const choice = await ui.select(title, [...rows, "Add resource", "Back"]);
    if (!choice || choice === "Back") return route;
    if (choice === "Add resource") {
      const used = new Set(route.map((entry) => entry.resourceId));
      const available = resources.filter((entry) => !used.has(entry.entryId));
      const labels = available.map((entry) => executorSelectionLabel(entry.selection, agents, scoped));
      const selected = await ui.select(`${title} — add`, labels.length ? [...labels, "Back"] : ["No additional resources", "Back"]);
      const index = labels.indexOf(selected ?? "");
      if (index >= 0) {
        const resource = available[index]!;
        route.push({
          resourceId: resource.entryId,
          thinkingLevel: resource.selection.source === "pi" ? resource.selection.thinkingLevel : undefined,
        });
      }
      continue;
    }
    let index = rows.indexOf(choice);
    if (index < 0) continue;
    while (route[index]) {
      const entry = route[index]!;
      const resource = resources.find((candidate) => candidate.entryId === entry.resourceId)!;
      const [thinkingRow] = alignedSettingsRows([
        ["Thinking", routeThinkingSummary(entry, resource, scoped)],
      ]);
      const options = [
        ...(resource.selection.source === "pi" ? [thinkingRow] : []),
        ...(index > 0 ? ["Move up"] : []),
        ...(index < route.length - 1 ? ["Move down"] : []),
        "Exclude from this route",
        "Back",
      ];
      const edit = await ui.select(`${title} — ${executorSelectionLabel(resource.selection, agents, scoped)}`, options);
      if (!edit || edit === "Back") break;
      if (edit === thinkingRow && resource.selection.source === "pi") {
        const selection = resource.selection;
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (model) entry.thinkingLevel = await selectThinkingLevel(
          ui,
          model,
          effectiveThinkingLevel(entry.thinkingLevel ?? selection.thinkingLevel, model),
        );
      } else if (edit === "Move up" && index > 0) {
        [route[index - 1], route[index]] = [route[index]!, route[index - 1]!];
        index -= 1;
      } else if (edit === "Move down" && index < route.length - 1) {
        [route[index], route[index + 1]] = [route[index + 1]!, route[index]!];
        index += 1;
      } else if (edit === "Exclude from this route") {
        route.splice(index, 1);
        break;
      }
    }
  }
}

async function editExecutorPoolEntry(
  ui: UiContext,
  initial: ExecutorPoolEntry[],
  index: number,
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ExecutorPoolEntry[]> {
  let pool = initial.map(cloneExecutorPoolEntry);
  while (pool[index]) {
    const entry = pool[index]!;
    const [modelRow, capacityRow] = alignedSettingsRows([
      ["Model", executorSelectionLabel(entry.selection, agents, scoped)],
      ["Maximum concurrency", String(entry.maxConcurrent)],
    ]);
    const moveUp = "Move up";
    const moveDown = "Move down";
    const remove = "Remove";
    const choice = await ui.select(`Executor ${index + 1}`, [
      modelRow,
      capacityRow,
      ...(index > 0 ? [moveUp] : []),
      ...(index < pool.length - 1 ? [moveDown] : []),
      remove,
      "Back",
    ]);
    if (!choice || choice === "Back") return pool;
    if (choice === modelRow) {
      const selection = await selectExecutorModel(ui, entry.selection, pool.filter((_, candidate) => candidate !== index), agents, scoped);
      if (selection) pool[index] = { ...entry, selection };
      continue;
    }
    if (choice === capacityRow) {
      pool[index] = { ...entry, maxConcurrent: await selectExecutorCapacity(ui, entry.maxConcurrent) };
      continue;
    }
    if (choice === moveUp && index > 0) {
      [pool[index - 1], pool[index]] = [pool[index]!, pool[index - 1]!];
      index -= 1;
      continue;
    }
    if (choice === moveDown && index < pool.length - 1) {
      [pool[index], pool[index + 1]] = [pool[index + 1]!, pool[index]!];
      index += 1;
      continue;
    }
    if (choice === remove) {
      pool.splice(index, 1);
      return pool;
    }
  }
  return pool;
}

async function selectExecutorModel(
  ui: UiContext,
  current: ExecutorSelection | undefined,
  existing: ExecutorPoolEntry[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ExecutorSelection | undefined> {
  const unavailable = new Set(existing.map((entry) => executorSelectionKey(entry.selection)));
  const choices: Array<{ label: string; selection: ExecutorSelection; model?: ScopedModelChoice }> = [
    ...scoped.map((model) => ({
      label: model.label,
      selection: { source: "pi" as const, model: model.model },
      model,
    })),
    ...agents.filter(externalAgentSupportsExecution).map((agent) => ({
      label: `${agent.id} [${agent.adapter}]`,
      selection: { source: "external" as const, id: agent.id },
    })),
  ].filter((choice) => !unavailable.has(executorSelectionKey(choice.selection)));
  const rows = choices.map((choice) => `${choice.label}${current && executorSelectionKey(current) === executorSelectionKey(choice.selection) ? "  current" : ""}`);
  const selected = await ui.select("Executor model", rows.length > 0 ? [...rows, "Back"] : ["No additional executors available", "Back"]);
  if (!selected || selected === "Back") return undefined;
  const found = choices.find((_choice, index) => selected === rows[index]);
  if (!found) return undefined;
  return { ...found.selection };
}

async function selectExecutorCapacity(ui: UiContext, current: number): Promise<number> {
  const values = Array.from({ length: MAX_EXECUTION_WORKERS }, (_, index) => index + 1);
  const rows = values.map((value) => `${value}${value === current ? "  current" : ""}`);
  const selected = await ui.select(`Maximum concurrency (1–${MAX_EXECUTION_WORKERS})`, rows);
  return values.find((_value, index) => selected === rows[index]) ?? current;
}

async function selectReviewers(
  ui: UiContext,
  initial: ActiveReviewerSelection[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ActiveReviewerSelection[]> {
  let selected = initial.map(cloneReviewerSelection);
  const availableRows = (): Array<{ key: string; value: ActiveReviewerSelection; label: string }> => [
    ...scoped.map((choice) => ({
      key: reviewerKey({ source: "pi", model: choice.model }),
      value: { source: "pi" as const, model: choice.model },
      label: choice.label,
    })),
    ...agents.filter(externalAgentSupportsReview).map((agent) => ({
      key: reviewerKey({ source: "external", id: agent.id }),
      value: { source: "external" as const, id: agent.id },
      label: `${agent.id} [${agent.adapter}]`,
    })),
  ];
  while (true) {
    const rows = availableRows();
    const availableKeys = new Set(rows.map((row) => row.key));
    const unavailable = selected.filter((selection) => !availableKeys.has(reviewerKey(selection)));
    const reasoningRows = rows.flatMap((row) => {
      if (row.value.source !== "pi" || !hasReviewer(selected, row.value)) return [];
      const model = row.value.model;
      const selection = selected.find((candidate) => reviewerKey(candidate) === row.key);
      const choice = scoped.find((candidate) => candidate.model === model);
      if (!selection || selection.source !== "pi" || !choice) return [];
      const level = effectiveThinkingLevel(selection.thinkingLevel, choice);
      return [{ label: `Reasoning · ${row.label}  ${thinkingLevelLabel(level)}`, selection, choice }];
    });
    const options = [
      ...rows.map((row) => `${row.label} ${hasReviewer(selected, row.value) ? "✓" : "✗"}`),
      ...unavailable.map((selection) => `${reviewerSelectionLabel(selection)} [unavailable] ✓`),
      ...reasoningRows.map((row) => row.label),
      "Enable all",
      "Clear all",
      "Back",
    ];
    const choice = await ui.select(`Reviewers — Enter toggles — ${selected.length}/${rows.length} selected`, options);
    if (!choice || choice === "Back") return selected;
    if (choice === "Enable all") {
      selected = rows.map((row) => {
        if (row.value.source !== "pi") return cloneReviewerSelection(row.value);
        const model = row.value.model;
        const modelChoice = scoped.find((candidate) => candidate.model === model)!;
        const existing = selected.find((candidate) => reviewerKey(candidate) === row.key);
        const existingLevel = existing?.source === "pi" ? existing.thinkingLevel : undefined;
        return { ...row.value, thinkingLevel: effectiveThinkingLevel(existingLevel, modelChoice) };
      });
      continue;
    }
    if (choice === "Clear all") {
      selected = [];
      continue;
    }
    const row = rows.find((candidate) => choice === `${candidate.label} ${hasReviewer(selected, candidate.value) ? "✓" : "✗"}`);
    const unavailableRow = unavailable.find((candidate) => choice === `${reviewerSelectionLabel(candidate)} [unavailable] ✓`);
    const reasoningRow = reasoningRows.find((candidate) => choice === candidate.label);
    if (reasoningRow) {
      const thinkingLevel = await selectThinkingLevel(
        ui,
        reasoningRow.choice,
        effectiveThinkingLevel(reasoningRow.selection.thinkingLevel, reasoningRow.choice),
      );
      selected = selected.map((candidate) => reviewerKey(candidate) === reviewerKey(reasoningRow.selection)
        ? { ...candidate, thinkingLevel }
        : candidate);
      continue;
    }
    const value = row?.value ?? unavailableRow;
    if (value) {
      if (hasReviewer(selected, value)) {
        selected = selected.filter((candidate) => reviewerKey(candidate) !== reviewerKey(value));
      } else if (value.source === "pi") {
        const modelChoice = scoped.find((candidate) => candidate.model === value.model);
        const thinkingLevel = modelChoice
          ? await selectThinkingLevel(ui, modelChoice, effectiveThinkingLevel(value.thinkingLevel, modelChoice))
          : value.thinkingLevel;
        selected = [...selected, { ...value, thinkingLevel }];
      } else {
        selected = [...selected, cloneReviewerSelection(value)];
      }
    }
  }
}

async function selectThinkingLevel(
  ui: UiContext,
  model: ScopedModelChoice,
  current: ThinkingLevel,
): Promise<ThinkingLevel> {
  const options = model.supportedThinkingLevels.map((level) =>
    `${thinkingLevelLabel(level)}${level === current ? "  current" : ""}`
  );
  const selected = await ui.select(`Reasoning — ${model.label}`, options);
  return model.supportedThinkingLevels.find((level) =>
    selected === `${thinkingLevelLabel(level)}${level === current ? "  current" : ""}`
  ) ?? current;
}

async function selectReviewPolicy(
  ui: UiContext,
  initialCycles: number,
  initialThreshold: number,
): Promise<{ maxCorrectionCycles: number; guidanceThreshold: number }> {
  let maxCorrectionCycles = initialCycles;
  let guidanceThreshold = initialThreshold;
  while (true) {
    const [cyclesRow, guidanceRow] = alignedSettingsRows([
      ["Automatic correction attempts", String(maxCorrectionCycles)],
      ["Concrete guidance after", String(guidanceThreshold)],
    ]);
    const choice = await ui.select("Review policy", [cyclesRow, guidanceRow, "Back"]);
    if (!choice || choice === "Back") return { maxCorrectionCycles, guidanceThreshold };
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const current = choice === cyclesRow ? maxCorrectionCycles : guidanceThreshold;
    const entered = await ui.input(
      choice === cyclesRow ? "Automatic correction attempts" : "Concrete guidance after correction attempts",
      String(current),
    );
    if (entered === undefined) continue;
    const parsed = Number(entered.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      await notify(ui, "Enter a non-negative whole number.", "error");
      continue;
    }
    if (choice === cyclesRow) maxCorrectionCycles = parsed;
    else guidanceThreshold = parsed;
  }
}

async function selectTimeouts(
  ui: UiContext,
  initialReviewerTimeoutMs: number,
  initialExecutorTimeoutMs: number,
): Promise<{ reviewerTimeoutMs: number; executorTimeoutMs: number }> {
  let reviewerTimeoutMs = initialReviewerTimeoutMs;
  let executorTimeoutMs = initialExecutorTimeoutMs;
  while (true) {
    const [reviewerRow, executorRow] = alignedSettingsRows([
      ["Reviewer timeout", formatDuration(reviewerTimeoutMs)],
      ["Executor timeout", formatDuration(executorTimeoutMs)],
    ]);
    const choice = await ui.select("Timeouts", [reviewerRow, executorRow, "Back"]);
    if (!choice || choice === "Back") return { reviewerTimeoutMs, executorTimeoutMs };
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const currentMs = choice === reviewerRow ? reviewerTimeoutMs : executorTimeoutMs;
    const entered = await ui.input(
      choice === reviewerRow ? "Reviewer timeout in minutes" : "Executor timeout in minutes",
      String(currentMs / 60_000),
    );
    if (entered === undefined) continue;
    const minutes = Number(entered.trim());
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60_000 > Number.MAX_SAFE_INTEGER) {
      await notify(ui, "Enter a positive number of minutes.", "error");
      continue;
    }
    const timeoutMs = Math.round(minutes * 60_000);
    if (choice === reviewerRow) reviewerTimeoutMs = timeoutMs;
    else executorTimeoutMs = timeoutMs;
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function formatByteSize(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

async function validateSelection(
  executorPool: ExecutorPoolEntry[],
  reviewers: ActiveReviewerSelection[],
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  executeRoute: WorkerRouteEntry[] = [],
  researchRoute: WorkerRouteEntry[] = [],
): Promise<string | undefined> {
  const duplicateReviewer = duplicate(reviewers.map(reviewerKey));
  if (duplicateReviewer) return `Duplicate enabled reviewer: ${duplicateReviewer}`;
  const scopedModels = new Set(scoped.map((choice) => choice.model));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const duplicateExecutor = duplicate(executorPool.map((entry) => executorSelectionKey(entry.selection)));
  if (duplicateExecutor) return `Duplicate executor pool selection: ${duplicateExecutor}`;
  const resources = new Set(executorPool.map((entry) => entry.entryId));
  for (const [kind, route] of [["Execution", executeRoute], ["Research", researchRoute]] as const) {
    const duplicateResource = duplicate(route.map((entry) => entry.resourceId));
    if (duplicateResource) return `${kind} priority contains duplicate resource: ${duplicateResource}`;
    for (const entry of route) {
      if (!resources.has(entry.resourceId)) return `${kind} priority references missing worker resource: ${entry.resourceId}`;
      const resource = executorPool.find((candidate) => candidate.entryId === entry.resourceId)!;
      if (kind === "Research" && !workerResourceSupportsResearch(config, resource)) {
        return `Research priority resource is not research-capable: ${entry.resourceId}`;
      }
      if (entry.thinkingLevel && resource.selection.source !== "pi") {
        return `${kind} priority cannot override thinking for external resource: ${entry.resourceId}`;
      }
      if (entry.thinkingLevel && resource.selection.source === "pi") {
        const selection = resource.selection;
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (!model?.supportedThinkingLevels.includes(entry.thinkingLevel)) {
          return `${kind} priority reasoning is unsupported for ${selection.model}: ${entry.thinkingLevel}`;
        }
      }
    }
  }
  for (const entry of executorPool) {
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1 || entry.maxConcurrent > MAX_EXECUTION_WORKERS) {
      return `Executor maximum concurrency must be between 1 and ${MAX_EXECUTION_WORKERS}: ${entry.entryId}`;
    }
    const selection = entry.selection;
    if (selection.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === selection.model);
      if (!choice) return `Pi executor model is not currently scoped: ${selection.model}`;
      if (selection.thinkingLevel && !choice.supportedThinkingLevels.includes(selection.thinkingLevel)) {
        return `Pi executor reasoning is unsupported for ${selection.model}: ${selection.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("pi")) return "Executor executable is unavailable: pi";
      continue;
    }
    const agent = agentsById.get(selection.id);
    if (!agent || !externalAgentSupportsExecution(agent)) return `External executor is unavailable: ${selection.id}`;
    if (!await commandAvailable(agent.command!)) return `Executor executable is unavailable: ${agent.command}`;
  }
  for (const reviewer of reviewers) {
    if (reviewer.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === reviewer.model);
      if (!scopedModels.has(reviewer.model) || !choice) return `Pi reviewer model is not currently scoped: ${reviewer.model}`;
      if (reviewer.thinkingLevel && !choice.supportedThinkingLevels.includes(reviewer.thinkingLevel)) {
        return `Pi reviewer reasoning is unsupported for ${reviewer.model}: ${reviewer.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("pi")) return "Reviewer executable is unavailable: pi";
      continue;
    }
    const agent = agentsById.get(reviewer.id);
    if (!agent || !externalAgentSupportsReview(agent)) return `External reviewer is unavailable: ${reviewer.id}`;
    if (config.enabled && !await commandAvailable(agent.command!)) return `Reviewer executable is unavailable: ${agent.command} (${agent.id})`;
  }
  return undefined;
}

function initialReviewerSelections(config: ReviewGateConfig): ActiveReviewerSelection[] {
  if (config.review?.activeReviewers !== undefined) {
    return config.review.activeReviewers.map(cloneReviewerSelection);
  }
  return resolveReviewers(config).reviewers.map((reviewer) => reviewer.adapter === "pi-model"
    ? { source: "pi" as const, model: reviewer.model, thinkingLevel: reviewer.thinkingLevel }
    : { source: "external" as const, id: reviewer.id });
}

function executorPoolSummary(pool: ExecutorPoolEntry[]): string {
  const slots = pool.reduce((total, entry) => total + entry.maxConcurrent, 0);
  return `${pool.length} ${pool.length === 1 ? "model" : "models"} · ${slots} ${slots === 1 ? "slot" : "slots"}`;
}

function workerRouteSummary(
  route: WorkerRouteEntry[],
  resources: ExecutorPoolEntry[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): string {
  if (route.length === 0) return "Disabled (no resources)";
  return route.map((entry) => {
    const resource = resources.find((candidate) => candidate.entryId === entry.resourceId);
    return resource ? executorSelectionLabel(resource.selection, agents, scoped).split(" [")[0] : `${entry.resourceId} [missing]`;
  }).join(" → ");
}

function workerRouteEntrySummary(
  route: WorkerRouteEntry,
  resources: ExecutorPoolEntry[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): string {
  const resource = resources.find((entry) => entry.entryId === route.resourceId);
  if (!resource) return `${route.resourceId} [missing]`;
  return `${executorSelectionLabel(resource.selection, agents, scoped)} · ${routeThinkingSummary(route, resource, scoped)} · shared max ${resource.maxConcurrent}`;
}

function routeThinkingSummary(route: WorkerRouteEntry, resource: ExecutorPoolEntry, scoped: ScopedModelChoice[]): string {
  if (resource.selection.source === "external") return "Configured by agent";
  const selection = { ...resource.selection, thinkingLevel: route.thinkingLevel ?? resource.selection.thinkingLevel };
  return executorThinkingSummary(selection, scoped);
}

function executorPoolEntrySummary(entry: ExecutorPoolEntry, agents: ExternalAgentConfig[], scoped: ScopedModelChoice[]): string {
  return `${executorSelectionLabel(entry.selection, agents, scoped)} · shared max ${entry.maxConcurrent}`;
}

function executorSelectionLabel(selection: ExecutorSelection, agents: ExternalAgentConfig[], scoped: ScopedModelChoice[]): string {
  if (selection.source === "pi") {
    return scoped.find((candidate) => candidate.model === selection.model)?.label ?? `${selection.model} [unavailable]`;
  }
  const agent = agents.find((candidate) => candidate.id === selection.id && externalAgentSupportsExecution(candidate));
  return agent ? `${agent.id} [${agent.adapter}]` : `${selection.id} [unavailable]`;
}

function executorThinkingSummary(selection: ExecutorSelection, scoped: ScopedModelChoice[]): string {
  if (selection.source === "external") return "Configured by agent";
  const model = scoped.find((candidate) => candidate.model === selection.model);
  return model
    ? thinkingLevelLabel(effectiveThinkingLevel(selection.thinkingLevel, model))
    : selection.thinkingLevel ? thinkingLevelLabel(selection.thinkingLevel) : "Unavailable";
}

function reviewerSelectionLabel(selection: ActiveReviewerSelection): string {
  return selection.source === "pi" ? selection.model : selection.id;
}

function reviewerKey(selection: ActiveReviewerSelection): string {
  return selection.source === "pi" ? `pi:${selection.model}` : `external:${selection.id}`;
}

function hasReviewer(values: ActiveReviewerSelection[], target: ActiveReviewerSelection): boolean {
  return values.some((value) => reviewerKey(value) === reviewerKey(target));
}

function cloneReviewerSelection(value: ActiveReviewerSelection): ActiveReviewerSelection {
  return { ...value };
}

function cloneExecutorPoolEntry(entry: ExecutorPoolEntry): ExecutorPoolEntry {
  return { ...entry, selection: { ...entry.selection } };
}

function withoutResourceThinking(entry: ExecutorPoolEntry): ExecutorPoolEntry {
  const cloned = cloneExecutorPoolEntry(entry);
  if (cloned.selection.source === "pi") delete cloned.selection.thinkingLevel;
  return cloned;
}

function materializeExecutorPool(
  entries: ExecutorPoolEntry[],
  scoped: ScopedModelChoice[],
): ExecutorPoolEntry[] {
  return entries.map((entry) => {
    const cloned = cloneExecutorPoolEntry(entry);
    const selection = cloned.selection;
    if (selection.source !== "pi") return cloned;
    const choice = scoped.find((candidate) => candidate.model === selection.model);
    return choice
      ? {
        ...cloned,
        selection: {
          ...selection,
          thinkingLevel: effectiveThinkingLevel(selection.thinkingLevel, choice),
        },
      }
      : cloned;
  });
}

function materializeReviewerThinking(
  values: ActiveReviewerSelection[],
  scoped: ScopedModelChoice[],
): ActiveReviewerSelection[] {
  return values.map((value) => {
    if (value.source !== "pi") return cloneReviewerSelection(value);
    const choice = scoped.find((candidate) => candidate.model === value.model);
    return choice ? { ...value, thinkingLevel: effectiveThinkingLevel(value.thinkingLevel, choice) } : { ...value };
  });
}

function effectiveThinkingLevel(value: ThinkingLevel | undefined, model: ScopedModelChoice): ThinkingLevel {
  if (value && model.supportedThinkingLevels.includes(value)) return value;
  if (model.pinnedThinkingLevel && model.supportedThinkingLevels.includes(model.pinnedThinkingLevel)) {
    return model.pinnedThinkingLevel;
  }
  if (model.supportedThinkingLevels.includes("high")) return "high";
  return model.supportedThinkingLevels.at(-1) ?? "off";
}

function thinkingLevelLabel(value: ThinkingLevel): string {
  return value === "xhigh" ? "X-high" : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

async function commandAvailable(command: string): Promise<boolean> {
  if (isAbsolute(command) || command.includes("/")) {
    return access(command, constants.X_OK).then(() => true, () => false);
  }
  for (const path of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await access(join(path, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}

function extractUi(ctx: unknown): UiContext | undefined {
  return isRecord(ctx) && isRecord(ctx.ui) && typeof ctx.ui.select === "function" ? ctx.ui as unknown as UiContext : undefined;
}

async function notify(ui: UiContext, message: string, type: "info" | "warning" | "error"): Promise<void> {
  ui.notify?.(message, type);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
