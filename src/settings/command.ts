import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  MAX_EXECUTION_WORKERS,
  externalAgentCatalog,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  executorEntryId,
  executorSelectionKey,
  resolvedExecutorPool,
  resolveReviewers,
  type ActiveReviewerSelection,
  type ExecutorPoolEntry,
  type ExecutorSelection,
  type ExternalAgentConfig,
  type ExecutionRetryPolicy,
  type RetainBundles,
  type ReviewGateConfig,
  type ThinkingLevel,
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
    description: "Configure delegated execution, reviewers, reasoning, review policy, and bundle retention.",
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
  let executorPool = materializeExecutorPool(resolvedExecutorPool(input.config), input.scoped);
  let activeReviewers = materializeReviewerThinking(initialReviewerSelections(input.config), input.scoped);
  let reviewerTimeoutMs = input.config.reviewerTimeoutMs;
  let executorTimeoutMs = input.config.executorTimeoutMs;
  let maxCorrectionCycles = input.config.maxCorrectionCycles;
  let guidanceThreshold = input.config.implementationGuidanceAfterCorrectionAttempts;
  let retainBundles = input.config.retainBundles;
  let maxWorkers = input.config.execution?.maxWorkers ?? DEFAULT_MAX_WORKERS;
  let retryPolicy = { ...(input.config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY) };

  while (true) {
    const totalReviewerChoices = input.scoped.length + agents.filter(externalAgentSupportsReview).length;
    const reviewStatus = input.config.enabled
      ? activeReviewers.length === 0 ? " — review disabled" : ""
      : " — review disabled by master setting";
    const [executorRow, reviewersRow, timeoutsRow, policyRow, retentionRow, workersRow, retryRow] = alignedSettingsRows([
      ["Executor pool", executorPoolSummary(executorPool)],
      ["Reviewers", `${activeReviewers.length}/${totalReviewerChoices} selected${reviewStatus}`],
      ["Timeouts", `review ${formatDuration(reviewerTimeoutMs)} · executor ${formatDuration(executorTimeoutMs)}`],
      ["Review policy", `${maxCorrectionCycles} corrections · concrete after ${guidanceThreshold}`],
      ["Bundle retention", retentionLabel(retainBundles)],
      ["Global concurrency", String(maxWorkers)],
      ["Retry policy", `${retryPolicy.maxRetries} retries · ${formatDuration(retryPolicy.baseDelayMs)} base`],
    ]);
    const choice = await input.ui.select("Review settings", [
      executorRow,
      reviewersRow,
      timeoutsRow,
      policyRow,
      retentionRow,
      workersRow,
      retryRow,
      "Save changes",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return;
    if (choice === executorRow) {
      executorPool = await selectExecutorPool(input.ui, executorPool, agents, input.scoped);
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
    const error = await validateSelection(executorPool, activeReviewers, agents, input.config, input.scoped);
    if (error) {
      await notify(input.ui, error, "error");
      continue;
    }
    const next = await persistReviewSettings(input.configPath!, {
      executorPool,
      activeReviewers,
      reviewerTimeoutMs,
      executorTimeoutMs,
      maxCorrectionCycles,
      implementationGuidanceAfterCorrectionAttempts: guidanceThreshold,
      retainBundles,
      maxWorkers,
      retryPolicy,
    });
    replaceConfig(input.config, next);
    await input.onSaved?.(input.config);
    await notify(input.ui, "Review settings saved.", "info");
    return;
  }
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
    const choice = await ui.select("Executor pool — priority order", [...entryRows, "Add executor", "Back"]);
    if (!choice || choice === "Back") return pool;
    if (choice === "Add executor") {
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
    const [modelRow, thinkingRow, capacityRow] = alignedSettingsRows([
      ["Model", executorSelectionLabel(entry.selection, agents, scoped)],
      ["Thinking", executorThinkingSummary(entry.selection, scoped)],
      ["Maximum concurrency", String(entry.maxConcurrent)],
    ]);
    const moveUp = "Move up";
    const moveDown = "Move down";
    const remove = "Remove";
    const choice = await ui.select(`Executor ${index + 1}`, [
      modelRow,
      thinkingRow,
      capacityRow,
      ...(index > 0 ? [moveUp] : []),
      ...(index < pool.length - 1 ? [moveDown] : []),
      remove,
      "Back",
    ]);
    if (!choice || choice === "Back") return pool;
    if (choice === modelRow) {
      const selection = await selectExecutorModel(ui, entry.selection, pool.filter((_, candidate) => candidate !== index), agents, scoped);
      if (selection) pool[index] = { ...entry, entryId: executorEntryId(selection), selection };
      continue;
    }
    if (choice === thinkingRow) {
      const selection = entry.selection;
      if (selection.source === "little-coder") {
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (model) {
          pool[index] = {
            ...entry,
            selection: {
              ...selection,
              thinkingLevel: await selectThinkingLevel(
                ui,
                model,
                effectiveThinkingLevel(selection.thinkingLevel, model),
              ),
            },
          };
        }
      }
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
      selection: { source: "little-coder" as const, model: model.model },
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
  if (!found.model) return { ...found.selection };
  const previousThinking = current?.source === "little-coder" && current.model === found.model.model
    ? current.thinkingLevel
    : undefined;
  return {
    source: "little-coder",
    model: found.model.model,
    thinkingLevel: await selectThinkingLevel(
      ui,
      found.model,
      effectiveThinkingLevel(previousThinking, found.model),
    ),
  };
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
      key: reviewerKey({ source: "little-coder", model: choice.model }),
      value: { source: "little-coder" as const, model: choice.model },
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
      if (row.value.source !== "little-coder" || !hasReviewer(selected, row.value)) return [];
      const model = row.value.model;
      const selection = selected.find((candidate) => reviewerKey(candidate) === row.key);
      const choice = scoped.find((candidate) => candidate.model === model);
      if (!selection || selection.source !== "little-coder" || !choice) return [];
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
        if (row.value.source !== "little-coder") return cloneReviewerSelection(row.value);
        const model = row.value.model;
        const modelChoice = scoped.find((candidate) => candidate.model === model)!;
        const existing = selected.find((candidate) => reviewerKey(candidate) === row.key);
        const existingLevel = existing?.source === "little-coder" ? existing.thinkingLevel : undefined;
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
      } else if (value.source === "little-coder") {
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

async function validateSelection(
  executorPool: ExecutorPoolEntry[],
  reviewers: ActiveReviewerSelection[],
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): Promise<string | undefined> {
  const duplicateReviewer = duplicate(reviewers.map(reviewerKey));
  if (duplicateReviewer) return `Duplicate enabled reviewer: ${duplicateReviewer}`;
  const scopedModels = new Set(scoped.map((choice) => choice.model));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const duplicateExecutor = duplicate(executorPool.map((entry) => executorSelectionKey(entry.selection)));
  if (duplicateExecutor) return `Duplicate executor pool selection: ${duplicateExecutor}`;
  for (const entry of executorPool) {
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1 || entry.maxConcurrent > MAX_EXECUTION_WORKERS) {
      return `Executor maximum concurrency must be between 1 and ${MAX_EXECUTION_WORKERS}: ${entry.entryId}`;
    }
    const selection = entry.selection;
    if (selection.source === "little-coder") {
      const choice = scoped.find((candidate) => candidate.model === selection.model);
      if (!choice) return `Little-coder executor model is not currently scoped: ${selection.model}`;
      if (selection.thinkingLevel && !choice.supportedThinkingLevels.includes(selection.thinkingLevel)) {
        return `Little-coder executor reasoning is unsupported for ${selection.model}: ${selection.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("little-coder")) return "Executor executable is unavailable: little-coder";
      continue;
    }
    const agent = agentsById.get(selection.id);
    if (!agent || !externalAgentSupportsExecution(agent)) return `External executor is unavailable: ${selection.id}`;
    if (!await commandAvailable(agent.command!)) return `Executor executable is unavailable: ${agent.command}`;
  }
  for (const reviewer of reviewers) {
    if (reviewer.source === "little-coder") {
      const choice = scoped.find((candidate) => candidate.model === reviewer.model);
      if (!scopedModels.has(reviewer.model) || !choice) return `Little-coder reviewer model is not currently scoped: ${reviewer.model}`;
      if (reviewer.thinkingLevel && !choice.supportedThinkingLevels.includes(reviewer.thinkingLevel)) {
        return `Little-coder reviewer reasoning is unsupported for ${reviewer.model}: ${reviewer.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("little-coder")) return "Reviewer executable is unavailable: little-coder";
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
  return resolveReviewers(config).reviewers.map((reviewer) => reviewer.adapter === "little-coder-model"
    ? { source: "little-coder" as const, model: reviewer.model, thinkingLevel: reviewer.thinkingLevel }
    : { source: "external" as const, id: reviewer.id });
}

function executorPoolSummary(pool: ExecutorPoolEntry[]): string {
  const slots = pool.reduce((total, entry) => total + entry.maxConcurrent, 0);
  return `${pool.length} ${pool.length === 1 ? "model" : "models"} · ${slots} ${slots === 1 ? "slot" : "slots"}`;
}

function executorPoolEntrySummary(entry: ExecutorPoolEntry, agents: ExternalAgentConfig[], scoped: ScopedModelChoice[]): string {
  return `${executorSelectionLabel(entry.selection, agents, scoped)} · ${executorThinkingSummary(entry.selection, scoped)} · max ${entry.maxConcurrent}`;
}

function executorSelectionLabel(selection: ExecutorSelection, agents: ExternalAgentConfig[], scoped: ScopedModelChoice[]): string {
  if (selection.source === "little-coder") {
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
  return selection.source === "little-coder" ? selection.model : selection.id;
}

function reviewerKey(selection: ActiveReviewerSelection): string {
  return selection.source === "little-coder" ? `little-coder:${selection.model}` : `external:${selection.id}`;
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

function materializeExecutorPool(
  entries: ExecutorPoolEntry[],
  scoped: ScopedModelChoice[],
): ExecutorPoolEntry[] {
  return entries.map((entry) => {
    const cloned = cloneExecutorPoolEntry(entry);
    const selection = cloned.selection;
    if (selection.source !== "little-coder") return cloned;
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
    if (value.source !== "little-coder") return cloneReviewerSelection(value);
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
