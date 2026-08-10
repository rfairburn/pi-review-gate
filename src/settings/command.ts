import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  externalAgentCatalog,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  resolveReviewers,
  type ActiveExecutorSelection,
  type ActiveReviewerSelection,
  type ExternalAgentConfig,
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
  let activeExecutor = materializeExecutorThinking(input.config.execution?.activeExecutor ?? null, input.scoped);
  let activeReviewers = materializeReviewerThinking(initialReviewerSelections(input.config), input.scoped);
  let reviewerTimeoutMs = input.config.reviewerTimeoutMs;
  let executorTimeoutMs = input.config.executorTimeoutMs;
  let maxCorrectionCycles = input.config.maxCorrectionCycles;
  let guidanceThreshold = input.config.implementationGuidanceAfterCorrectionAttempts;
  let retainBundles = input.config.retainBundles;
  let maxWorkers = input.config.execution?.maxWorkers ?? 2;
  let parallelEnabled = input.config.execution?.parallelEnabled === true;

  while (true) {
    const executorRow = settingsRow("Executor", executorSummary(activeExecutor, agents, input.scoped));
    const totalReviewerChoices = input.scoped.length + agents.filter(externalAgentSupportsReview).length;
    const reviewStatus = input.config.enabled
      ? activeReviewers.length === 0 ? " — review disabled" : ""
      : " — review disabled by master setting";
    const reviewersRow = settingsRow("Reviewers", `${activeReviewers.length}/${totalReviewerChoices} selected${reviewStatus}`);
    const timeoutsRow = settingsRow("Timeouts", `review ${formatDuration(reviewerTimeoutMs)} · executor ${formatDuration(executorTimeoutMs)}`);
    const policyRow = settingsRow("Review policy", `${maxCorrectionCycles} corrections · concrete after ${guidanceThreshold}`);
    const retentionRow = settingsRow("Bundle retention", retentionLabel(retainBundles));
    const workersRow = settingsRow("Parallel workers", String(maxWorkers));
    const parallelRow = settingsRow("Parallel execution", parallelEnabled ? "Enabled" : "Disabled");
    const choice = await input.ui.select("Review settings", [
      executorRow,
      reviewersRow,
      timeoutsRow,
      policyRow,
      retentionRow,
      workersRow,
      parallelRow,
      "Save changes",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return;
    if (choice === executorRow) {
      activeExecutor = await selectExecutor(input.ui, activeExecutor, agents, input.scoped);
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
    if (choice === parallelRow) {
      parallelEnabled = await selectParallelEnabled(input.ui, parallelEnabled);
      continue;
    }
    const error = await validateSelection(activeExecutor, activeReviewers, agents, input.config, input.scoped);
    if (error) {
      await notify(input.ui, error, "error");
      continue;
    }
    const next = await persistReviewSettings(input.configPath!, {
      activeExecutor,
      activeReviewers,
      reviewerTimeoutMs,
      executorTimeoutMs,
      maxCorrectionCycles,
      implementationGuidanceAfterCorrectionAttempts: guidanceThreshold,
      retainBundles,
      maxWorkers,
      parallelEnabled,
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
  const options = ["1", "2", "3", "4"].map((v) => `${v}${v === String(current) ? "  current" : ""}`);
  const selected = await ui.select("Parallel workers (1–4)", options);
  const parsed = Number(selected?.split(" ")[0]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : current;
}

async function selectParallelEnabled(ui: UiContext, current: boolean): Promise<boolean> {
  const options = [
    `Enabled${current ? "  current" : ""}`,
    `Disabled${!current ? "  current" : ""}`,
  ];
  const selected = await ui.select("Parallel execution", options);
  if (selected === `Enabled${current ? "  current" : ""}`) return true;
  if (selected === `Disabled${!current ? "  current" : ""}`) return false;
  return current;
}

function retentionLabel(value: RetainBundles): string {
  if (value === "on-failure") return "On failure";
  if (value === "always") return "Always";
  return "Never";
}

function settingsRow(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`;
}

function policyValueRow(label: string, value: string): string {
  return `${label.padEnd(31)}${value}`;
}

async function selectExecutor(
  ui: UiContext,
  current: ActiveExecutorSelection,
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ActiveExecutorSelection> {
  const external = agents.filter(externalAgentSupportsExecution);
  const rows: Array<{ label: string; value: ActiveExecutorSelection }> = [
    ...scoped.map((choice) => ({
      label: `${choice.label}${current?.source === "little-coder" && current.model === choice.model ? "  current" : ""}`,
      value: { source: "little-coder" as const, model: choice.model },
    })),
    ...external.map((agent) => ({
      label: `${agent.id} [${agent.adapter}]${current?.source === "external" && current.id === agent.id ? "  current" : ""}`,
      value: { source: "external" as const, id: agent.id },
    })),
    { label: `Disabled${current === null ? "  current" : ""}`, value: null },
  ];
  const options = scoped.length + external.length === 0
    ? ["No scoped internal models or execution-capable external agents configured", ...rows.map((row) => row.label)]
    : rows.map((row) => row.label);
  const selected = await ui.select("Executor", options);
  const next = cloneActiveExecutor(rows.find((row) => row.label === selected)?.value ?? current);
  if (next?.source !== "little-coder") return next;
  const choice = scoped.find((candidate) => candidate.model === next.model);
  if (!choice) return next;
  return {
    ...next,
    thinkingLevel: await selectThinkingLevel(ui, choice, effectiveThinkingLevel(next.thinkingLevel, choice)),
  };
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
    const cyclesRow = policyValueRow("Automatic correction attempts", String(maxCorrectionCycles));
    const guidanceRow = policyValueRow("Concrete guidance after", String(guidanceThreshold));
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
    const reviewerRow = policyValueRow("Reviewer timeout", formatDuration(reviewerTimeoutMs));
    const executorRow = policyValueRow("Executor timeout", formatDuration(executorTimeoutMs));
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
  active: ActiveExecutorSelection,
  reviewers: ActiveReviewerSelection[],
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): Promise<string | undefined> {
  const duplicateReviewer = duplicate(reviewers.map(reviewerKey));
  if (duplicateReviewer) return `Duplicate enabled reviewer: ${duplicateReviewer}`;
  const scopedModels = new Set(scoped.map((choice) => choice.model));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
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
  if (active?.source === "little-coder" && !scopedModels.has(active.model)) {
    return `Little-coder executor model is not currently scoped: ${active.model}`;
  }
  if (active?.source === "little-coder") {
    const choice = scoped.find((candidate) => candidate.model === active.model)!;
    if (active.thinkingLevel && !choice.supportedThinkingLevels.includes(active.thinkingLevel)) {
      return `Little-coder executor reasoning is unsupported for ${active.model}: ${active.thinkingLevel}`;
    }
  }
  if (active?.source === "external") {
    const agent = agentsById.get(active.id);
    if (!agent || !externalAgentSupportsExecution(agent)) return `External executor is unavailable: ${active.id}`;
    if (!await commandAvailable(agent.command!)) return `Executor executable is unavailable: ${agent.command}`;
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

function executorSummary(active: ActiveExecutorSelection, agents: ExternalAgentConfig[], scoped: ScopedModelChoice[]): string {
  if (!active) return "Disabled";
  if (active.source === "little-coder") {
    const choice = scoped.find((candidate) => candidate.model === active.model);
    return choice
      ? `${choice.label} · ${thinkingLevelLabel(effectiveThinkingLevel(active.thinkingLevel, choice))}`
      : `${active.model} [unavailable]`;
  }
  const agent = agents.find((candidate) => candidate.id === active.id && externalAgentSupportsExecution(candidate));
  return agent ? `${agent.id} [${agent.adapter}]` : `${active.id} [unavailable]`;
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

function cloneActiveExecutor(value: ActiveExecutorSelection | undefined): ActiveExecutorSelection {
  return value ? { ...value } : null;
}

function materializeExecutorThinking(
  value: ActiveExecutorSelection | undefined,
  scoped: ScopedModelChoice[],
): ActiveExecutorSelection {
  const cloned = cloneActiveExecutor(value);
  if (cloned?.source !== "little-coder") return cloned;
  const choice = scoped.find((candidate) => candidate.model === cloned.model);
  return choice ? { ...cloned, thinkingLevel: effectiveThinkingLevel(cloned.thinkingLevel, choice) } : cloned;
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
