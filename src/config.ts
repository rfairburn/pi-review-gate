import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RetainBundles = "never" | "on-failure" | "always";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface GenericCliDeciderConfig {
  id: string;
  adapter: "generic-cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CodexCliDeciderConfig {
  id: string;
  adapter: "codex-cli";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeCliDeciderConfig {
  id: string;
  adapter: "claude-cli";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  model?: string;
  timeoutMs?: number;
}

export interface LittleCoderDeciderConfig {
  id: string;
  adapter: "little-coder-model";
  model: string;
  thinkingLevel?: ThinkingLevel;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type DeciderConfig = GenericCliDeciderConfig | CodexCliDeciderConfig | ClaudeCliDeciderConfig | LittleCoderDeciderConfig;

export type ActiveExecutorSelection =
  | { source: "little-coder"; model: string; thinkingLevel?: ThinkingLevel }
  | { source: "external"; id: string }
  | null;

export type ExecutorSelection = Exclude<ActiveExecutorSelection, null>;

export interface ExecutorPoolEntry {
  entryId: string;
  selection: ExecutorSelection;
  maxConcurrent: number;
}

interface ExternalExecutorBase {
  id: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CodexExecutorConfig extends ExternalExecutorBase {
  adapter: "codex-cli";
  model?: string;
}

export interface ClaudeExecutorConfig extends ExternalExecutorBase {
  adapter: "claude-cli";
  model?: string;
}

export interface RunAsBinaryExecutorConfig extends ExternalExecutorBase {
  adapter: "run-as-binary";
  protocol: "pi-review-executor-jsonl-v1";
  command: string;
}

export type ExternalExecutorConfig = CodexExecutorConfig | ClaudeExecutorConfig | RunAsBinaryExecutorConfig;

export type ExternalAgentAdapter = "codex-cli" | "claude-cli" | "generic-cli" | "run-as-binary";

export interface ExternalAgentRoleConfig {
  args?: string[];
  env?: Record<string, string>;
  model?: string;
  timeoutMs?: number;
  protocol?: "pi-review-executor-jsonl-v1" | "pi-reviewer-json-v1";
}

export interface ExternalAgentConfig {
  id: string;
  adapter: ExternalAgentAdapter;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  model?: string;
  review?: ExternalAgentRoleConfig;
  execution?: ExternalAgentRoleConfig;
}

export type ActiveReviewerSelection =
  | { source: "little-coder"; model: string; thinkingLevel?: ThinkingLevel }
  | { source: "external"; id: string };

export interface ReviewSelectionConfig {
  activeReviewers?: ActiveReviewerSelection[];
}

export interface ExecutionRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  maxSameIncidentRepeats: number;
}

export const DEFAULT_MAX_WORKERS = 4;
export const MAX_EXECUTION_WORKERS = 16;
export const DEFAULT_EXECUTION_RETRY_POLICY: ExecutionRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  jitter: true,
  maxSameIncidentRepeats: 2,
};

export interface ExecutionConfig {
  /** Ordered executor priority pool. Earlier entries are preferred. */
  executorPool?: ExecutorPoolEntry[];
  /** Legacy single-executor selection, materialized as one pool entry when executorPool is absent. */
  activeExecutor?: ActiveExecutorSelection;
  externalExecutors?: ExternalExecutorConfig[];
  maxWorkers?: number;
  retryPolicy?: ExecutionRetryPolicy;
}

export interface ReviewGateConfig {
  enabled: boolean;
  reviewerTimeoutMs: number;
  executorTimeoutMs: number;
  maxCorrectionCycles: number;
  implementationGuidanceAfterCorrectionAttempts: number;
  maxPatchBytes: number;
  maxFileBytes: number;
  maxSnapshotBytes: number;
  /** Age after which completed, non-recovery wave roots may be garbage-collected. Zero disables GC. */
  waveArtifactTtlMs?: number;
  retainBundles: RetainBundles;
  decider?: DeciderConfig;
  reviewers?: DeciderConfig[];
  enabledReviewerIds?: string[];
  review?: ReviewSelectionConfig;
  externalAgents?: ExternalAgentConfig[];
  execution?: ExecutionConfig;
}

export interface LoadedConfig {
  config: ReviewGateConfig;
  path?: string;
  disabledReason?: string;
  globallyDisabled?: boolean;
}

export const DEFAULT_CONFIG: ReviewGateConfig = {
  enabled: true,
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 1,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  waveArtifactTtlMs: 30 * 24 * 60 * 60 * 1000,
  retainBundles: "on-failure",
};

const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000;
const REVIEWER_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const disabledVar = firstTruthyEnv(env, ["PI_REVIEW_GATE_DISABLED", "LITTLE_CODER_REVIEW_GATE_DISABLED"]);
  if (disabledVar) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      disabledReason: `${disabledVar} is set`,
      globallyDisabled: true,
    };
  }

  const path = findConfigPath(env);
  if (!path) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      disabledReason: "No review gate config file found",
    };
  }

  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return {
    config: normalizeConfig(parsed),
    path,
  };
}

export function normalizeConfig(value: unknown): ReviewGateConfig {
  if (!isRecord(value)) {
    throw new Error("review gate config must be a JSON object");
  }

  const reviewerTimeoutMs = positiveIntegerOrDefault(value.reviewerTimeoutMs, DEFAULT_CONFIG.reviewerTimeoutMs, "reviewerTimeoutMs");
  const executorTimeoutMs = positiveIntegerOrDefault(value.executorTimeoutMs, DEFAULT_CONFIG.executorTimeoutMs, "executorTimeoutMs");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (value.reviewers !== undefined && !Array.isArray(value.reviewers)) {
    throw new Error("reviewers must be an array");
  }
  const config: ReviewGateConfig = {
    ...DEFAULT_CONFIG,
    enabled: value.enabled ?? DEFAULT_CONFIG.enabled,
    reviewerTimeoutMs,
    executorTimeoutMs,
    maxCorrectionCycles: nonNegativeIntegerOrDefault(value.maxCorrectionCycles, DEFAULT_CONFIG.maxCorrectionCycles, "maxCorrectionCycles"),
    implementationGuidanceAfterCorrectionAttempts: nonNegativeIntegerOrDefault(
      value.implementationGuidanceAfterCorrectionAttempts,
      DEFAULT_CONFIG.implementationGuidanceAfterCorrectionAttempts,
      "implementationGuidanceAfterCorrectionAttempts",
    ),
    maxPatchBytes: nonNegativeIntegerOrDefault(value.maxPatchBytes, DEFAULT_CONFIG.maxPatchBytes, "maxPatchBytes"),
    maxFileBytes: nonNegativeIntegerOrDefault(value.maxFileBytes, DEFAULT_CONFIG.maxFileBytes, "maxFileBytes"),
    maxSnapshotBytes: nonNegativeIntegerOrDefault(value.maxSnapshotBytes, DEFAULT_CONFIG.maxSnapshotBytes, "maxSnapshotBytes"),
    waveArtifactTtlMs: nonNegativeIntegerOrDefault(
      value.waveArtifactTtlMs,
      DEFAULT_CONFIG.waveArtifactTtlMs ?? 0,
      "waveArtifactTtlMs",
    ),
    retainBundles: normalizeRetainBundles(value.retainBundles),
    decider: value.decider === undefined ? undefined : normalizeDecider(value.decider, reviewerTimeoutMs),
    reviewers: Array.isArray(value.reviewers) ? value.reviewers.map((reviewer) => normalizeDecider(reviewer, reviewerTimeoutMs)) : undefined,
    enabledReviewerIds: value.enabledReviewerIds === undefined
      ? undefined
      : normalizeIdList(value.enabledReviewerIds, "enabledReviewerIds"),
    review: value.review === undefined ? undefined : normalizeReviewSelection(value.review),
    externalAgents: value.externalAgents === undefined ? undefined : normalizeExternalAgents(value.externalAgents),
    execution: value.execution === undefined ? undefined : normalizeExecution(value.execution, executorTimeoutMs),
  };

  if (config.reviewers) {
    validateUniqueReviewerIds(config.reviewers);
  }

  return config;
}

export interface ReviewerResolution {
  reviewers: DeciderConfig[];
  unknownIds: string[];
  duplicateEnabledIds: string[];
}

export function resolveReviewers(config: ReviewGateConfig, scopedModels: string[] = []): ReviewerResolution {
  if (config.review?.activeReviewers !== undefined) {
    return resolveSelectedReviewers(config, scopedModels);
  }
  const catalog = config.reviewers && config.reviewers.length > 0
    ? config.reviewers
    : config.decider
      ? [config.decider]
      : [];
  const selected = config.enabledReviewerIds ?? catalog.map((reviewer) => reviewer.id);
  const counts = new Map<string, number>();
  for (const id of selected) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const selectedSet = new Set(selected);
  const catalogIds = new Set(catalog.map((reviewer) => reviewer.id));
  return {
    reviewers: catalog.filter((reviewer) => selectedSet.has(reviewer.id)),
    unknownIds: [...selectedSet].filter((id) => !catalogIds.has(id)),
    duplicateEnabledIds: [...counts].filter(([, count]) => count > 1).map(([id]) => id),
  };
}

export function automaticReviewEnabled(config: ReviewGateConfig, scopedModels: string[] = []): boolean {
  const resolved = resolveReviewers(config, scopedModels);
  return config.enabled && resolved.reviewers.length > 0
    && resolved.unknownIds.length === 0
    && resolved.duplicateEnabledIds.length === 0;
}

export function configWithReviewers(config: ReviewGateConfig, reviewers: DeciderConfig[], enabled: boolean): ReviewGateConfig {
  return {
    ...config,
    enabled,
    review: undefined,
    decider: undefined,
    reviewers: reviewers.map(cloneDecider),
    enabledReviewerIds: reviewers.map((reviewer) => reviewer.id),
  };
}

export function materializeReviewConfig(config: ReviewGateConfig, scopedModels: string[]): ReviewGateConfig {
  const resolution = resolveReviewers(config, scopedModels);
  return configWithReviewers(
    config,
    resolution.reviewers,
    config.enabled && resolution.reviewers.length > 0
      && resolution.unknownIds.length === 0
      && resolution.duplicateEnabledIds.length === 0,
  );
}

export function activeExternalExecutor(
  config: ReviewGateConfig,
  selection: ExecutorSelection | undefined = config.execution?.activeExecutor ?? undefined,
): ExternalExecutorConfig | undefined {
  const active = selection;
  if (active?.source !== "external") return undefined;
  const agent = externalAgentCatalog(config).find((candidate) => candidate.id === active.id);
  return agent ? executorFromExternalAgent(agent, config.executorTimeoutMs) : undefined;
}

export function resolvedExecutorPool(config: ReviewGateConfig): ExecutorPoolEntry[] {
  if (config.execution?.executorPool !== undefined) {
    return config.execution.executorPool.map(cloneExecutorPoolEntry);
  }
  const active = config.execution?.activeExecutor;
  if (!active) return [];
  return [{
    entryId: executorEntryId(active),
    selection: cloneExecutorSelection(active),
    maxConcurrent: config.execution?.maxWorkers ?? DEFAULT_MAX_WORKERS,
  }];
}

export function executorEntryId(selection: ExecutorSelection): string {
  return selection.source === "external"
    ? `external-${selection.id}`
    : `little-coder-${Buffer.from(selection.model).toString("base64url")}`;
}

export function executorSelectionKey(selection: ExecutorSelection): string {
  return selection.source === "external" ? `external:${selection.id}` : `little-coder:${selection.model}`;
}

export function externalAgentCatalog(config: ReviewGateConfig): ExternalAgentConfig[] {
  const agents = (config.externalAgents ?? []).map(cloneExternalAgent);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const executor of config.execution?.externalExecutors ?? []) {
    const existing = byId.get(executor.id);
    if (existing) continue;
    const agent = externalAgentFromLegacyExecutor(executor);
    agents.push(agent);
    byId.set(agent.id, agent);
  }
  const legacyReviewers = config.reviewers?.length ? config.reviewers : config.decider ? [config.decider] : [];
  for (const reviewer of legacyReviewers) {
    if (reviewer.adapter === "little-coder-model") continue;
    const existing = byId.get(reviewer.id);
    if (existing && existing.adapter === reviewer.adapter) {
      existing.review ??= roleFromLegacyReviewer(reviewer);
      continue;
    }
    if (!existing) {
      const agent = externalAgentFromLegacyReviewer(reviewer);
      agents.push(agent);
      byId.set(agent.id, agent);
    }
  }
  return agents;
}

export function externalAgentSupportsReview(agent: ExternalAgentConfig): boolean {
  return agent.review !== undefined;
}

export function externalAgentSupportsExecution(agent: ExternalAgentConfig): boolean {
  return agent.execution !== undefined && agent.adapter !== "generic-cli";
}

export function internalReviewerId(model: string): string {
  return `little-coder-${Buffer.from(model).toString("base64url")}`;
}

export function reviewerDisplayLabel(reviewer: DeciderConfig): string {
  if (reviewer.adapter === "little-coder-model") {
    return reviewer.thinkingLevel
      ? `${reviewer.model} (${reviewer.thinkingLevel})`
      : reviewer.model;
  }
  if ((reviewer.adapter === "codex-cli" || reviewer.adapter === "claude-cli") && reviewer.model) {
    return `${reviewer.id} [${reviewer.adapter}/${reviewer.model}]`;
  }
  return reviewer.id;
}

export function reviewerDisplayLabels(reviewers: DeciderConfig[]): Record<string, string> {
  return Object.fromEntries(
    reviewers.map((reviewer) => [reviewer.id, reviewerDisplayLabel(reviewer)]),
  );
}

function findConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PI_REVIEW_GATE_CONFIG) {
    return env.PI_REVIEW_GATE_CONFIG;
  }
  if (env.LITTLE_CODER_REVIEW_CONFIG) {
    return env.LITTLE_CODER_REVIEW_CONFIG;
  }

  const candidates = [
    join(homedir(), ".config", "pi-review-gate", "config.json"),
    join(homedir(), ".config", "pi", "review-gate.json"),
    join(homedir(), ".config", "little-coder", "review-gate.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function normalizeDecider(value: unknown, defaultTimeoutMs = DEFAULT_REVIEWER_TIMEOUT_MS): DeciderConfig {
  if (!isRecord(value)) {
    throw new Error("decider must be an object");
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("decider requires id");
  }
  if (!REVIEWER_ID_PATTERN.test(value.id) || value.id === "." || value.id === "..") {
    throw new Error("reviewer id may contain only letters, numbers, underscores, periods, and hyphens");
  }
  if (value.adapter === "generic-cli") {
    if (typeof value.command !== "string" || !value.command.trim()) {
      throw new Error("generic-cli decider requires command");
    }
    const env = normalizeStringRecord(value.env, "generic-cli reviewer env");
    return {
      id: value.id,
      adapter: "generic-cli",
      command: value.command,
      args: normalizeStringArray(value.args, "generic-cli reviewer args"),
      ...(env ? { env } : {}),
      timeoutMs: positiveIntegerOrDefault(value.timeoutMs, defaultTimeoutMs, "generic-cli reviewer timeoutMs"),
    };
  }
  if (value.adapter === "codex-cli") {
    const env = normalizeStringRecord(value.env, "codex reviewer env");
    return {
      id: value.id,
      adapter: "codex-cli",
      command: normalizeOptionalNonEmptyString(value.command, "codex reviewer command") ?? "codex",
      args: normalizeStringArray(value.args, "codex reviewer args"),
      ...(env ? { env } : {}),
      model: normalizeOptionalNonEmptyString(value.model, "codex reviewer model"),
      timeoutMs: positiveIntegerOrDefault(value.timeoutMs, defaultTimeoutMs, "codex reviewer timeoutMs"),
    };
  }
  if (value.adapter === "claude-cli") {
    const env = normalizeStringRecord(value.env, "claude reviewer env");
    return {
      id: value.id,
      adapter: "claude-cli",
      command: normalizeOptionalNonEmptyString(value.command, "claude reviewer command") ?? "claude",
      args: normalizeStringArray(value.args, "claude reviewer args"),
      ...(env ? { env } : {}),
      model: normalizeOptionalNonEmptyString(value.model, "claude reviewer model"),
      timeoutMs: positiveIntegerOrDefault(value.timeoutMs, defaultTimeoutMs, "claude reviewer timeoutMs"),
    };
  }
  if (value.adapter === "little-coder-model") {
    if (typeof value.model !== "string" || !value.model.trim()) {
      throw new Error("little-coder-model decider requires model");
    }
    const env = normalizeStringRecord(value.env, "little-coder reviewer env");
    const thinkingLevel = normalizeOptionalThinkingLevel(value.thinkingLevel, "little-coder reviewer thinkingLevel");
    return {
      id: value.id,
      adapter: "little-coder-model",
      model: value.model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      command: normalizeOptionalNonEmptyString(value.command, "little-coder reviewer command") ?? "little-coder",
      args: normalizeStringArray(value.args, "little-coder reviewer args"),
      ...(env ? { env } : {}),
      timeoutMs: positiveIntegerOrDefault(value.timeoutMs, defaultTimeoutMs, "little-coder reviewer timeoutMs"),
    };
  }
  throw new Error("unsupported decider adapter");
}

function normalizeReviewSelection(value: unknown): ReviewSelectionConfig {
  if (!isRecord(value)) {
    throw new Error("review must be an object");
  }
  return {
    activeReviewers: value.activeReviewers === undefined
      ? undefined
      : normalizeActiveReviewers(value.activeReviewers),
  };
}

function normalizeActiveReviewers(value: unknown): ActiveReviewerSelection[] {
  if (!Array.isArray(value)) {
    throw new Error("review.activeReviewers must be an array");
  }
  return value.map((selection) => {
    if (!isRecord(selection)) {
      throw new Error("review.activeReviewers entries must be objects");
    }
    if (selection.source === "little-coder") {
      if (typeof selection.model !== "string" || !selection.model.trim()) {
        throw new Error("little-coder reviewer selection requires model");
      }
      const thinkingLevel = normalizeOptionalThinkingLevel(selection.thinkingLevel, "little-coder reviewer thinkingLevel");
      return {
        source: "little-coder",
        model: selection.model.trim(),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      };
    }
    if (selection.source === "external") {
      if (typeof selection.id !== "string" || !selection.id.trim()) {
        throw new Error("external reviewer selection requires id");
      }
      validateConfiguredId(selection.id, "external reviewer");
      return { source: "external", id: selection.id };
    }
    throw new Error("unsupported review.activeReviewers source");
  });
}

function normalizeExternalAgents(value: unknown): ExternalAgentConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("externalAgents must be an array");
  }
  const agents = value.map(normalizeExternalAgent);
  validateUniqueConfiguredIds(agents, "external agent");
  return agents;
}

function normalizeExternalAgent(value: unknown): ExternalAgentConfig {
  if (!isRecord(value)) {
    throw new Error("external agent must be an object");
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("external agent requires id");
  }
  validateConfiguredId(value.id, "external agent");
  if (typeof value.adapter !== "string" || !["codex-cli", "claude-cli", "generic-cli", "run-as-binary"].includes(value.adapter)) {
    throw new Error("unsupported external agent adapter");
  }
  const adapter = value.adapter as ExternalAgentAdapter;
  const configuredCommand = normalizeOptionalNonEmptyString(value.command, "external agent command");
  const command = configuredCommand
    ?? (adapter === "codex-cli" ? "codex" : adapter === "claude-cli" ? "claude" : undefined);
  if (!command) {
    throw new Error(`${adapter} external agent requires command`);
  }
  const review = normalizeExternalAgentRole(value.review, "review");
  const execution = normalizeExternalAgentRole(value.execution, "execution");
  if (!review && !execution) {
    throw new Error(`external agent requires review or execution role: ${value.id}`);
  }
  if (adapter === "generic-cli" && execution) {
    throw new Error("generic-cli external agents support only the review role");
  }
  if (adapter === "run-as-binary") {
    if (execution?.protocol !== "pi-review-executor-jsonl-v1") {
      if (execution) throw new Error("run-as-binary execution role requires protocol pi-review-executor-jsonl-v1");
    }
    if (review?.protocol !== "pi-reviewer-json-v1") {
      if (review) throw new Error("run-as-binary review role requires protocol pi-reviewer-json-v1");
    }
  }
  return {
    id: value.id,
    adapter,
    command,
    args: normalizeStringArray(value.args, "external agent args"),
    env: normalizeStringRecord(value.env, "external agent env"),
    model: normalizeOptionalNonEmptyString(value.model, "external agent model"),
    review,
    execution,
  };
}

function normalizeExternalAgentRole(value: unknown, role: "review" | "execution"): ExternalAgentRoleConfig | undefined {
  if (value === undefined || value === false) return undefined;
  if (!isRecord(value)) {
    throw new Error(`external agent ${role} role must be an object`);
  }
  const protocol = value.protocol === "pi-review-executor-jsonl-v1" || value.protocol === "pi-reviewer-json-v1"
    ? value.protocol
    : undefined;
  if (value.protocol !== undefined && !protocol) {
    throw new Error(`unsupported external agent ${role} protocol`);
  }
  return {
    args: normalizeStringArray(value.args, `external agent ${role} args`),
    env: normalizeStringRecord(value.env, `external agent ${role} env`),
    model: normalizeOptionalNonEmptyString(value.model, `external agent ${role} model`),
    ...(value.timeoutMs === undefined ? {} : {
      timeoutMs: positiveIntegerOrDefault(
        value.timeoutMs,
        role === "review" ? DEFAULT_REVIEWER_TIMEOUT_MS : DEFAULT_CONFIG.executorTimeoutMs,
        `external agent ${role} timeoutMs`,
      ),
    }),
    protocol,
  };
}

function normalizeExecution(value: unknown, defaultTimeoutMs = DEFAULT_CONFIG.executorTimeoutMs): ExecutionConfig {
  if (!isRecord(value)) {
    throw new Error("execution must be an object");
  }
  const activeExecutor = value.activeExecutor === undefined
    ? undefined
    : normalizeActiveExecutor(value.activeExecutor);
  const executorPool = value.executorPool === undefined
    ? undefined
    : normalizeExecutorPool(value.executorPool);
  const externalExecutors = value.externalExecutors === undefined
    ? undefined
    : normalizeExternalExecutors(value.externalExecutors, defaultTimeoutMs);
  const maxWorkers = normalizeMaxWorkers(value.maxWorkers);
  const retryPolicy = normalizeExecutionRetryPolicy(value.retryPolicy);
  return {
    activeExecutor,
    executorPool,
    externalExecutors,
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    retryPolicy,
  };
}

function normalizeExecutorPool(value: unknown): ExecutorPoolEntry[] {
  if (!Array.isArray(value)) throw new Error("execution.executorPool must be an array");
  const entries = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`execution.executorPool[${index}] must be an object`);
    const selection = normalizeActiveExecutor(entry.selection);
    if (!selection) throw new Error(`execution.executorPool[${index}].selection cannot be null`);
    const entryId = typeof entry.entryId === "string" && entry.entryId.trim()
      ? entry.entryId.trim()
      : executorEntryId(selection);
    validateConfiguredId(entryId, `execution.executorPool[${index}].entryId`);
    const maxConcurrent = normalizeRequiredWorkerCount(
      entry.maxConcurrent,
      `execution.executorPool[${index}].maxConcurrent`,
    );
    return { entryId, selection, maxConcurrent };
  });
  validateUniqueConfiguredIds(entries.map((entry) => ({ id: entry.entryId })), "executor pool entry");
  const selections = new Set<string>();
  for (const entry of entries) {
    const key = executorSelectionKey(entry.selection);
    if (selections.has(key)) throw new Error(`duplicate executor pool selection: ${key}`);
    selections.add(key);
  }
  return entries;
}

function normalizeExecutionRetryPolicy(value: unknown): ExecutionRetryPolicy {
  if (value === undefined) return { ...DEFAULT_EXECUTION_RETRY_POLICY };
  if (!isRecord(value)) throw new Error("execution.retryPolicy must be an object");
  const maxRetries = nonNegativeIntegerOrDefault(
    value.maxRetries,
    DEFAULT_EXECUTION_RETRY_POLICY.maxRetries,
    "execution.retryPolicy.maxRetries",
  );
  const baseDelayMs = nonNegativeIntegerOrDefault(
    value.baseDelayMs,
    DEFAULT_EXECUTION_RETRY_POLICY.baseDelayMs,
    "execution.retryPolicy.baseDelayMs",
  );
  const maxDelayMs = nonNegativeIntegerOrDefault(
    value.maxDelayMs,
    DEFAULT_EXECUTION_RETRY_POLICY.maxDelayMs,
    "execution.retryPolicy.maxDelayMs",
  );
  if (maxDelayMs < baseDelayMs) {
    throw new Error("execution.retryPolicy.maxDelayMs must be greater than or equal to baseDelayMs");
  }
  if (value.jitter !== undefined && typeof value.jitter !== "boolean") {
    throw new Error("execution.retryPolicy.jitter must be a boolean");
  }
  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    jitter: value.jitter ?? DEFAULT_EXECUTION_RETRY_POLICY.jitter,
    maxSameIncidentRepeats: nonNegativeIntegerOrDefault(
      value.maxSameIncidentRepeats,
      DEFAULT_EXECUTION_RETRY_POLICY.maxSameIncidentRepeats,
      "execution.retryPolicy.maxSameIncidentRepeats",
    ),
  };
}

function normalizeActiveExecutor(value: unknown): ActiveExecutorSelection {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("execution.activeExecutor must be an object or null");
  }
  if (value.source === "little-coder") {
    if (typeof value.model !== "string" || !value.model.trim()) {
      throw new Error("little-coder active executor requires model");
    }
    const thinkingLevel = normalizeOptionalThinkingLevel(value.thinkingLevel, "little-coder executor thinkingLevel");
    return {
      source: "little-coder",
      model: value.model.trim(),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }
  if (value.source === "external") {
    if (typeof value.id !== "string" || !value.id.trim()) {
      throw new Error("external active executor requires id");
    }
    validateConfiguredId(value.id, "external executor");
    return { source: "external", id: value.id };
  }
  throw new Error("unsupported execution.activeExecutor source");
}

function normalizeRequiredWorkerCount(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  const count = value as number;
  if (count < 1 || count > MAX_EXECUTION_WORKERS) {
    throw new Error(`${field} must be between 1 and ${MAX_EXECUTION_WORKERS}`);
  }
  return count;
}

function normalizeExternalExecutors(value: unknown, defaultTimeoutMs: number): ExternalExecutorConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("execution.externalExecutors must be an array");
  }
  const executors = value.map((executor) => normalizeExternalExecutor(executor, defaultTimeoutMs));
  validateUniqueConfiguredIds(executors, "external executor");
  return executors;
}

function normalizeExternalExecutor(value: unknown, defaultTimeoutMs: number): ExternalExecutorConfig {
  if (!isRecord(value)) {
    throw new Error("external executor must be an object");
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("external executor requires id");
  }
  validateConfiguredId(value.id, "external executor");
  const common = {
    id: value.id,
    args: normalizeStringArray(value.args, "external executor args"),
    env: normalizeStringRecord(value.env, "external executor env"),
    timeoutMs: positiveIntegerOrDefault(value.timeoutMs, defaultTimeoutMs, "external executor timeoutMs"),
  };
  if (value.adapter === "codex-cli") {
    return {
      ...common,
      adapter: "codex-cli",
      command: normalizeOptionalNonEmptyString(value.command, "codex executor command") ?? "codex",
      model: normalizeOptionalNonEmptyString(value.model, "codex executor model"),
    };
  }
  if (value.adapter === "claude-cli") {
    return {
      ...common,
      adapter: "claude-cli",
      command: normalizeOptionalNonEmptyString(value.command, "claude executor command") ?? "claude",
      model: normalizeOptionalNonEmptyString(value.model, "claude executor model"),
    };
  }
  if (value.adapter === "run-as-binary") {
    if (value.protocol !== "pi-review-executor-jsonl-v1") {
      throw new Error("run-as-binary external executor requires protocol pi-review-executor-jsonl-v1");
    }
    if (typeof value.command !== "string" || !value.command.trim()) {
      throw new Error("run-as-binary external executor requires command");
    }
    return {
      ...common,
      adapter: "run-as-binary",
      protocol: "pi-review-executor-jsonl-v1",
      command: value.command,
    };
  }
  throw new Error("unsupported external executor adapter");
}

function resolveSelectedReviewers(config: ReviewGateConfig, scopedModels: string[]): ReviewerResolution {
  const selections = config.review?.activeReviewers ?? [];
  const scoped = new Set(scopedModels);
  const agents = new Map(externalAgentCatalog(config).map((agent) => [agent.id, agent]));
  const reviewers: DeciderConfig[] = [];
  const unknownIds: string[] = [];
  const counts = new Map<string, number>();
  for (const selection of selections) {
    const key = selection.source === "little-coder" ? `little-coder:${selection.model}` : `external:${selection.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (selection.source === "little-coder") {
      if (!scoped.has(selection.model)) {
        unknownIds.push(key);
        continue;
      }
      reviewers.push({
        id: internalReviewerId(selection.model),
        adapter: "little-coder-model",
        model: selection.model,
        ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
        command: "little-coder",
        args: [],
        timeoutMs: config.reviewerTimeoutMs,
      });
      continue;
    }
    const agent = agents.get(selection.id);
    const reviewer = agent ? reviewerFromExternalAgent(agent, config.reviewerTimeoutMs) : undefined;
    if (!reviewer) {
      unknownIds.push(key);
      continue;
    }
    reviewers.push(reviewer);
  }
  return {
    reviewers,
    unknownIds: [...new Set(unknownIds)],
    duplicateEnabledIds: [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  };
}

function reviewerFromExternalAgent(agent: ExternalAgentConfig, defaultTimeoutMs: number): DeciderConfig | undefined {
  const role = agent.review;
  if (!role) return undefined;
  const common = mergedAgentRole(agent, role, defaultTimeoutMs);
  if (agent.adapter === "codex-cli") {
    return { id: agent.id, adapter: "codex-cli", ...common, command: agent.command ?? "codex" };
  }
  if (agent.adapter === "claude-cli") {
    return { id: agent.id, adapter: "claude-cli", ...common, command: agent.command ?? "claude" };
  }
  return {
    id: agent.id,
    adapter: "generic-cli",
    command: agent.command!,
    args: common.args,
    env: {
      ...common.env,
      ...(agent.adapter === "run-as-binary" ? { PI_REVIEW_AGENT_PROTOCOL: "pi-reviewer-json-v1" } : {}),
    },
    timeoutMs: common.timeoutMs,
  };
}

function executorFromExternalAgent(agent: ExternalAgentConfig, defaultTimeoutMs: number): ExternalExecutorConfig | undefined {
  const role = agent.execution;
  if (!role || agent.adapter === "generic-cli") return undefined;
  const common = mergedAgentRole(agent, role, defaultTimeoutMs);
  if (agent.adapter === "codex-cli") {
    return { id: agent.id, adapter: "codex-cli", ...common, command: agent.command ?? "codex" };
  }
  if (agent.adapter === "claude-cli") {
    return { id: agent.id, adapter: "claude-cli", ...common, command: agent.command ?? "claude" };
  }
  return {
    id: agent.id,
    adapter: "run-as-binary",
    command: agent.command!,
    args: common.args,
    env: common.env,
    timeoutMs: common.timeoutMs,
    protocol: "pi-review-executor-jsonl-v1",
  };
}

function mergedAgentRole(agent: ExternalAgentConfig, role: ExternalAgentRoleConfig, fallbackTimeout: number): {
  args: string[];
  env?: Record<string, string>;
  model?: string;
  timeoutMs: number;
} {
  return {
    args: [...(agent.args ?? []), ...(role.args ?? [])],
    env: { ...(agent.env ?? {}), ...(role.env ?? {}) },
    model: role.model ?? agent.model,
    timeoutMs: role.timeoutMs ?? fallbackTimeout,
  };
}

function externalAgentFromLegacyExecutor(executor: ExternalExecutorConfig): ExternalAgentConfig {
  return {
    id: executor.id,
    adapter: executor.adapter,
    command: executor.command,
    model: "model" in executor ? executor.model : undefined,
    args: [],
    env: undefined,
    execution: {
      args: executor.args ? [...executor.args] : [],
      env: executor.env ? { ...executor.env } : undefined,
      timeoutMs: executor.timeoutMs,
      protocol: executor.adapter === "run-as-binary" ? executor.protocol : undefined,
    },
  };
}

function externalAgentFromLegacyReviewer(reviewer: Exclude<DeciderConfig, LittleCoderDeciderConfig>): ExternalAgentConfig {
  return {
    id: reviewer.id,
    adapter: reviewer.adapter,
    command: reviewer.command,
    model: "model" in reviewer ? reviewer.model : undefined,
    args: [],
    env: undefined,
    review: roleFromLegacyReviewer(reviewer),
  };
}

function roleFromLegacyReviewer(reviewer: DeciderConfig): ExternalAgentRoleConfig {
  return {
    args: reviewer.args ? [...reviewer.args] : [],
    env: reviewer.env ? { ...reviewer.env } : undefined,
    model: "model" in reviewer ? reviewer.model : undefined,
    timeoutMs: reviewer.timeoutMs,
    protocol: reviewer.adapter === "generic-cli" ? "pi-reviewer-json-v1" : undefined,
  };
}

function cloneExternalAgent(agent: ExternalAgentConfig): ExternalAgentConfig {
  return {
    ...agent,
    args: agent.args ? [...agent.args] : undefined,
    env: agent.env ? { ...agent.env } : undefined,
    review: agent.review ? {
      ...agent.review,
      args: agent.review.args ? [...agent.review.args] : undefined,
      env: agent.review.env ? { ...agent.review.env } : undefined,
    } : undefined,
    execution: agent.execution ? {
      ...agent.execution,
      args: agent.execution.args ? [...agent.execution.args] : undefined,
      env: agent.execution.env ? { ...agent.execution.env } : undefined,
    } : undefined,
  };
}

function normalizeIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field} entries must be non-empty strings`);
    }
    validateConfiguredId(item, field);
    return item;
  });
}

function normalizeStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item !== "string") {
      throw new Error(`${field} values must be strings`);
    }
    return [key, item];
  }));
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function normalizeOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateConfiguredId(id: string, label: string): void {
  if (!REVIEWER_ID_PATTERN.test(id) || id === "." || id === "..") {
    throw new Error(`${label} id may contain only letters, numbers, underscores, periods, and hyphens`);
  }
}

function validateUniqueConfiguredIds(values: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new Error(`${label} id must be unique: ${value.id}`);
    }
    seen.add(value.id);
  }
}

function cloneDecider(decider: DeciderConfig): DeciderConfig {
  return {
    ...decider,
    args: decider.args ? [...decider.args] : undefined,
    env: decider.env ? { ...decider.env } : undefined,
  };
}

function cloneExecutorSelection(selection: ExecutorSelection): ExecutorSelection {
  return selection.source === "external"
    ? { source: "external", id: selection.id }
    : {
      source: "little-coder",
      model: selection.model,
      ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    };
}

function cloneExecutorPoolEntry(entry: ExecutorPoolEntry): ExecutorPoolEntry {
  return {
    entryId: entry.entryId,
    selection: cloneExecutorSelection(entry.selection),
    maxConcurrent: entry.maxConcurrent,
  };
}

function normalizeRetainBundles(value: unknown): RetainBundles {
  if (value === undefined) return DEFAULT_CONFIG.retainBundles;
  if (value === "never" || value === "always" || value === "on-failure") return value;
  throw new Error("retainBundles must be one of: never, on-failure, always");
}

function normalizeOptionalThinkingLevel(value: unknown, field: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel;
  }
  throw new Error(`${field} must be one of: ${THINKING_LEVELS.join(", ")}`);
}

function validateUniqueReviewerIds(reviewers: DeciderConfig[]): void {
  const seen = new Set<string>();
  for (const reviewer of reviewers) {
    if (seen.has(reviewer.id)) {
      throw new Error(`reviewer id must be unique: ${reviewer.id}`);
    }
    seen.add(reviewer.id);
  }
}

function positiveIntegerOrDefault(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeMaxWorkers(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("execution.maxWorkers must be an integer");
  }
  if (value < 1 || value > MAX_EXECUTION_WORKERS) {
    throw new Error(`execution.maxWorkers must be between 1 and ${MAX_EXECUTION_WORKERS}`);
  }
  return value;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function firstTruthyEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  return names.find((name) => isTruthy(env[name]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
