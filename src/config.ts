import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RetainBundles = "never" | "on-failure" | "always";
/**
 * Top-level operating posture for the primary assistant. `orchestrate` is the
 * historical default (the launcher's permanent orchestrator prompt); it keeps
 * existing behavior for configs that predate the field.
 */
export const OPERATING_MODES = ["execute", "orchestrate", "plan-research"] as const;
export type OperatingMode = typeof OPERATING_MODES[number];
export const DEFAULT_OPERATING_MODE: OperatingMode = "orchestrate";
/** Default direct operating-mode cycle hotkey (execute → orchestrate → plan-research → execute). */
export const DEFAULT_MODE_CYCLE_SHORTCUT = "alt+m";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface WebSearchConfig {
  provider: "ddgs";
  timeoutMs: number;
  maxResults: number;
}

export interface WebFetchConfig {
  timeoutMs: number;
  maxDownloadBytes: number;
  maxOutputChars: number;
  cacheMaxBytes: number;
  cacheMaxEntries: number;
  userAgent: string;
}

export type BrowserInteractionApproval = "ask" | "automatically-accept" | "automatically-deny";

export interface WebConfig {
  enabled: boolean;
  browserInteractionApproval: BrowserInteractionApproval;
  browserIdleExpiryMinutes: number;
  search: WebSearchConfig;
  fetch: WebFetchConfig;
}

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

export interface PiDeciderConfig {
  id: string;
  adapter: "pi-model";
  model: string;
  thinkingLevel?: ThinkingLevel;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type DeciderConfig = GenericCliDeciderConfig | CodexCliDeciderConfig | ClaudeCliDeciderConfig | PiDeciderConfig;

export type ActiveExecutorSelection =
  | { source: "pi"; model: string; thinkingLevel?: ThinkingLevel }
  | { source: "external"; id: string }
  | null;

export type ExecutorSelection = Exclude<ActiveExecutorSelection, null>;

export interface ExecutorPoolEntry {
  entryId: string;
  selection: ExecutorSelection;
  maxConcurrent: number;
}

/** One physical/provider capacity bucket shared by every background-task kind. */
export interface WorkerResourceEntry {
  resourceId: string;
  selection: ExecutorSelection;
  maxConcurrent: number;
}

/** A role-specific ordered reference to a shared worker resource. */
export interface WorkerRouteEntry {
  resourceId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface WorkerRoutesConfig {
  execute?: WorkerRouteEntry[];
  research?: WorkerRouteEntry[];
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
  model?: string;
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
  | { source: "pi"; model: string; thinkingLevel?: ThinkingLevel }
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
/** Maximum number of results a single web search may request. */
export const MAX_WEB_SEARCH_RESULTS = 100;
/** Maximum number of characters a single web fetch may return. */
export const MAX_WEB_OUTPUT_CHARS = 100_000;
/** Maximum aggregate bytes retained by a web page cache. */
export const MAX_WEB_CACHE_BYTES = 256 * 1024 * 1024;
/** Maximum number of pages retained by a web page cache. */
export const MAX_WEB_CACHE_ENTRIES = 256;
export type SubtaskNotificationMode = "quiet" | "noisy";
export const DEFAULT_SUBTASK_NOTIFICATION_MODE: SubtaskNotificationMode = "quiet";
export const DEFAULT_DEFERRED_PI_TOOLS = true;
export function deferredPiToolsEnabled(config: Pick<ReviewGateConfig, "execution">): boolean {
  return config.execution?.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS;
}
export const DEFAULT_EXECUTION_RETRY_POLICY: ExecutionRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  jitter: true,
  maxSameIncidentRepeats: 2,
};

export interface ExecutionConfig {
  /** Shared physical/provider capacity. Route lists never create extra slots. */
  workerResources?: WorkerResourceEntry[];
  /** Independent ordered resource eligibility for execution and research. */
  routes?: WorkerRoutesConfig;
  maxWorkers?: number;
  retryPolicy?: ExecutionRetryPolicy;
  subtaskNotifications?: SubtaskNotificationMode;
  /** Defer Pi-native schemas until search_tools activation. Defaults on. */
  deferredPiTools?: boolean;
}

export interface ReviewGateUiConfig {
  subtasksViewExpanded?: boolean;
}

export interface ReviewGateConfig {
  enabled: boolean;
  /** Top-level operating posture; hot-replaces the mode prompt on the next run. */
  operatingMode: OperatingMode;
  /** Human hotkey that directly cycles operating modes in canonical order. */
  modeCycleShortcut: string;
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
  review?: ReviewSelectionConfig;
  externalAgents?: ExternalAgentConfig[];
  execution?: ExecutionConfig;
  ui?: ReviewGateUiConfig;
  web?: WebConfig;
}

export interface LoadedConfig {
  config: ReviewGateConfig;
  path?: string;
  disabledReason?: string;
  globallyDisabled?: boolean;
  warnings?: string[];
}

export const DEFAULT_CONFIG: ReviewGateConfig = {
  enabled: true,
  operatingMode: DEFAULT_OPERATING_MODE,
  modeCycleShortcut: DEFAULT_MODE_CYCLE_SHORTCUT,
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 1,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  waveArtifactTtlMs: 30 * 24 * 60 * 60 * 1000,
  retainBundles: "on-failure",
  web: {
    enabled: true,
    browserInteractionApproval: "ask",
    browserIdleExpiryMinutes: 15,
    search: { provider: "ddgs", timeoutMs: 20_000, maxResults: 10 },
    fetch: {
      timeoutMs: 30_000,
      maxDownloadBytes: 50 * 1024 * 1024,
      maxOutputChars: 12_000,
      cacheMaxBytes: 64 * 1024 * 1024,
      cacheMaxEntries: 32,
      userAgent: "pi-review-gate/0.1 (+native web research)",
    },
  },
};

const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000;
const REVIEWER_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const disabledVar = firstTruthyEnv(env, ["PI_REVIEW_GATE_DISABLED"]);
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

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return { ...recoverConfig(parsed), path };
  } catch {
    // An unreadable document has no recoverable individual settings. Never
    // overwrite it, expose its contents in an error, or skip tool registration.
    return { config: normalizeConfig({}), path, warnings: ["Configuration could not be read or parsed; using built-in defaults."] };
  }
}

/** Startup recovery only. Explicit configuration writes still validate strictly. */
export function recoverConfig(value: unknown): Pick<LoadedConfig, "config" | "warnings"> {
  try {
    return { config: normalizeConfig(value) };
  } catch {
    // Reuse the strict validator rather than maintaining a second schema.
  }
  const candidate: Record<string, unknown> = Object.create(null);
  const warnings: string[] = [];
  // Only these objects contain independently defaultable settings. Selections,
  // agent definitions and route/resource entries remain atomic: never invent
  // a model, reasoning pair, command or authorization reference to repair one.
  const containers = new Set(["web", "web.search", "web.fetch", "ui", "review",
    "execution", "execution.retryPolicy", "execution.routes"]);
  const recover = (parent: Record<string, unknown>, key: string, input: unknown, path: string): void => {
    const attempt = (replacement: unknown): boolean => {
      const previous = Object.getOwnPropertyDescriptor(parent, key);
      Object.defineProperty(parent, key, { value: replacement, configurable: true, enumerable: true, writable: true });
      try {
        normalizeConfig(candidate);
        return true;
      } catch {
        if (previous) Object.defineProperty(parent, key, previous);
        else delete parent[key];
        return false;
      }
    };
    if (attempt(input)) return;
    if (containers.has(path) && isRecord(input)) {
      const object: Record<string, unknown> = Object.create(null);
      if (attempt(object)) {
        recoverObject(object, input, path);
        return;
      }
    }
    if (Array.isArray(input)) {
      const items: unknown[] = [];
      if (attempt(items)) {
        for (let i = 0; i < input.length; i++) {
          items.push(input[i]);
          try { normalizeConfig(candidate); }
          catch {
            items.pop();
            warnings.push(`${path}[${i}] is invalid; entry omitted.`);
          }
        }
        return;
      }
    }
    warnings.push(`${path} is invalid or unsupported; using its default.`);
  };
  const recoverObject = (target: Record<string, unknown>, input: Record<string, unknown>, prefix: string): void => {
    // Resources must precede routes; canonical fields must precede obsolete
    // copies so a malformed unrelated field does not change their precedence.
    const last = new Set(["routes", "decider", "reviewers", "enabledReviewerIds", "activeExecutor", "executorPool", "externalExecutors"]);
    const entries = Object.entries(input).sort(([a], [b]) => Number(last.has(a)) - Number(last.has(b)));
    if (prefix === "execution.retryPolicy") {
      // Delay bounds are coupled; testing either against the other's default
      // could incorrectly discard a valid configured pair.
      const pair = { baseDelayMs: input.baseDelayMs, maxDelayMs: input.maxDelayMs };
      Object.assign(target, pair);
      try { normalizeConfig(candidate); }
      catch {
        delete target.baseDelayMs;
        delete target.maxDelayMs;
        warnings.push(`${prefix} delay bounds are invalid; using default bounds.`);
      }
    }
    for (const [key, item] of entries) {
      if (prefix === "execution.retryPolicy" && (key === "baseDelayMs" || key === "maxDelayMs")) continue;
      recover(target, key, item, prefix ? `${prefix}.${key}` : key);
    }
  };
  if (isRecord(value)) recoverObject(candidate, value, "");
  else warnings.push("Configuration must be an object; using built-in defaults.");
  return { config: normalizeConfig(candidate), warnings };
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
  rejectLegacyReviewFields(value);
  if (isRecord(value.execution)) {
    rejectLegacyExecutionFields(value.execution);
  }
  const config: ReviewGateConfig = {
    ...DEFAULT_CONFIG,
    enabled: value.enabled ?? DEFAULT_CONFIG.enabled,
    operatingMode: normalizeOperatingMode(value.operatingMode),
    modeCycleShortcut: normalizeModeCycleShortcut(value.modeCycleShortcut),
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
    review: value.review === undefined ? undefined : normalizeReviewSelection(value.review),
    externalAgents: value.externalAgents === undefined ? undefined : normalizeExternalAgents(value.externalAgents),
    execution: value.execution === undefined ? undefined : normalizeExecution(value.execution),
    ui: value.ui === undefined ? undefined : normalizeUi(value.ui),
    web: normalizeWeb(value.web),
  };

  return config;
}

/**
 * The pre-cutover reviewer fields (`decider`, `reviewers`,
 * `enabledReviewerIds`) are no longer accepted. A record that carries them
 * alongside the canonical `review.activeReviewers` selection is doubled: the
 * canonical data alone is authoritative and the obsolete copies are ignored
 * without rewriting the record. An old-only record is rejected with an
 * actionable diagnostic instead of being silently read as an empty or
 * review-disabled configuration.
 */
function rejectLegacyReviewFields(value: Record<string, unknown>): void {
  const legacy = ["decider", "reviewers", "enabledReviewerIds"].filter((field) => value[field] !== undefined);
  if (legacy.length === 0) return;
  const canonical = isRecord(value.review) && Array.isArray(value.review.activeReviewers);
  if (canonical) return; // doubled record: the canonical selection wins
  throw new Error(
    `unsupported legacy reviewer configuration: ${legacy.join(", ")} is no longer accepted; ` +
    "select reviewers with review.activeReviewers and define external harnesses in externalAgents",
  );
}

/**
 * The pre-cutover execution fields (`activeExecutor`, `executorPool`,
 * `externalExecutors`) are no longer accepted. Doubled records (canonical
 * `execution.workerResources` present) consume the canonical data alone and
 * ignore the obsolete copies; old-only records fail with an actionable
 * diagnostic rather than materializing guessed pool entries.
 */
function rejectLegacyExecutionFields(execution: Record<string, unknown>): void {
  const legacy = ["activeExecutor", "executorPool", "externalExecutors"].filter((field) => execution[field] !== undefined);
  if (legacy.length === 0) return;
  if (execution.workerResources !== undefined) return; // doubled record: workerResources wins
  throw new Error(
    `unsupported legacy executor configuration: ${legacy.join(", ")} is no longer accepted; ` +
    "configure execution with execution.workerResources and externalAgents",
  );
}

function normalizeWeb(value: unknown): WebConfig {
  const defaults = DEFAULT_CONFIG.web!;
  if (value === undefined) return structuredClone(defaults);
  if (!isRecord(value)) throw new Error("web must be an object");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("web.enabled must be a boolean");
  const browserInteractionApproval = value.browserInteractionApproval === undefined
    ? defaults.browserInteractionApproval : value.browserInteractionApproval;
  if (!["ask", "automatically-accept", "automatically-deny"].includes(browserInteractionApproval as string)) {
    throw new Error("web.browserInteractionApproval must be ask, automatically-accept, or automatically-deny");
  }
  const search = value.search === undefined ? {} : value.search;
  const fetch = value.fetch === undefined ? {} : value.fetch;
  if (!isRecord(search)) throw new Error("web.search must be an object");
  if (!isRecord(fetch)) throw new Error("web.fetch must be an object");
  const configuredProvider = search.provider ?? defaults.search.provider;
  if (configuredProvider !== "ddgs" && configuredProvider !== "duckduckgo") throw new Error("web.search.provider must be ddgs");
  const provider = "ddgs" as const;
  const userAgent = fetch.userAgent ?? defaults.fetch.userAgent;
  if (typeof userAgent !== "string" || userAgent.trim().length === 0) throw new Error("web.fetch.userAgent must be a non-empty string");
  return {
    enabled: value.enabled ?? defaults.enabled,
    browserInteractionApproval: browserInteractionApproval as BrowserInteractionApproval,
    browserIdleExpiryMinutes: positiveIntegerOrDefault(
      value.browserIdleExpiryMinutes, defaults.browserIdleExpiryMinutes, "web.browserIdleExpiryMinutes",
    ),
    search: {
      provider,
      timeoutMs: positiveIntegerOrDefault(search.timeoutMs, defaults.search.timeoutMs, "web.search.timeoutMs"),
      maxResults: boundedPositiveIntegerOrDefault(
        search.maxResults,
        defaults.search.maxResults,
        MAX_WEB_SEARCH_RESULTS,
        "web.search.maxResults",
      ),
    },
    fetch: {
      timeoutMs: positiveIntegerOrDefault(fetch.timeoutMs, defaults.fetch.timeoutMs, "web.fetch.timeoutMs"),
      maxDownloadBytes: positiveIntegerOrDefault(fetch.maxDownloadBytes, defaults.fetch.maxDownloadBytes, "web.fetch.maxDownloadBytes"),
      maxOutputChars: boundedPositiveIntegerOrDefault(
        fetch.maxOutputChars,
        defaults.fetch.maxOutputChars,
        MAX_WEB_OUTPUT_CHARS,
        "web.fetch.maxOutputChars",
      ),
      cacheMaxBytes: boundedPositiveIntegerOrDefault(
        fetch.cacheMaxBytes,
        defaults.fetch.cacheMaxBytes,
        MAX_WEB_CACHE_BYTES,
        "web.fetch.cacheMaxBytes",
      ),
      cacheMaxEntries: boundedPositiveIntegerOrDefault(
        fetch.cacheMaxEntries,
        defaults.fetch.cacheMaxEntries,
        MAX_WEB_CACHE_ENTRIES,
        "web.fetch.cacheMaxEntries",
      ),
      userAgent: userAgent.trim(),
    },
  };
}

function normalizeUi(value: unknown): ReviewGateUiConfig {
  if (!isRecord(value)) {
    throw new Error("ui must be an object");
  }
  if (value.subtasksViewExpanded !== undefined && typeof value.subtasksViewExpanded !== "boolean") {
    throw new Error("ui.subtasksViewExpanded must be a boolean");
  }
  return {
    ...(value.subtasksViewExpanded !== undefined
      ? { subtasksViewExpanded: value.subtasksViewExpanded }
      : {}),
  };
}

export interface ReviewerResolution {
  reviewers: DeciderConfig[];
  unknownIds: string[];
  duplicateEnabledIds: string[];
}

/**
 * Resolve the canonical `review.activeReviewers` selection.
 *
 * `scopedModels` distinguishes the two resolution domains:
 * - a live configuration is resolved against the currently scoped Pi models
 *   (an array, possibly empty before any model is known): an out-of-scope pi
 *   selection is unresolvable until its model is scoped again;
 * - a materialized (frozen) configuration is self-contained and is resolved
 *   without scoping: it carries only selections that were resolvable when it
 *   was frozen, its pi selections are exact model+reasoning pairs, and its
 *   external references resolve against the agent definitions frozen beside
 *   them. Later settings or scope changes never re-resolve a frozen config.
 */
export function resolveReviewers(config: ReviewGateConfig, scopedModels?: string[]): ReviewerResolution {
  const selections = config.review?.activeReviewers ?? [];
  const scoped = new Set(scopedModels ?? []);
  const agents = new Map(externalAgentCatalog(config).map((agent) => [agent.id, agent]));
  const reviewers: DeciderConfig[] = [];
  const unknownIds: string[] = [];
  const counts = new Map<string, number>();
  for (const selection of selections) {
    const key = reviewerSelectionKey(selection);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (selection.source === "pi") {
      if (scopedModels !== undefined && !scoped.has(selection.model)) {
        unknownIds.push(key);
        continue;
      }
      reviewers.push({
        id: internalReviewerId(selection.model),
        adapter: "pi-model",
        model: selection.model,
        ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
        command: "pi",
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

export function reviewerSelectionKey(selection: ActiveReviewerSelection): string {
  return selection.source === "pi" ? `pi:${selection.model}` : `external:${selection.id}`;
}

/**
 * The canonical frozen form of a live configuration's reviewer selection:
 * the resolvable selections (exact pi model+reasoning pairs and external
 * agent references, duplicates retained so duplicate-only changes stay
 * digest-visible) plus the canonical agent definitions those references need.
 * Unresolvable selections are not frozen; they remain reported through the
 * resolution's unknownIds and the selection bookkeeping beside the config.
 */
export function frozenReviewerSelection(
  config: ReviewGateConfig,
  resolution: ReviewerResolution,
): { activeReviewers: ActiveReviewerSelection[]; externalAgents: ExternalAgentConfig[] } {
  const unknown = new Set(resolution.unknownIds);
  const activeReviewers = (config.review?.activeReviewers ?? [])
    .filter((selection) => !unknown.has(reviewerSelectionKey(selection)))
    .map((selection) => ({ ...selection }));
  const needed = new Set(
    activeReviewers.filter((selection): selection is { source: "external"; id: string } => selection.source === "external")
      .map((selection) => selection.id),
  );
  return {
    activeReviewers,
    externalAgents: externalAgentCatalog(config)
      .filter((agent) => needed.has(agent.id))
      .map(cloneExternalAgent),
  };
}

/**
 * Automatic review is enabled when the gate is on and at least one reviewer
 * resolves. Unresolvable or duplicated selections no longer disable the whole
 * gate: they produce explicit bounded outcomes at run time while every
 * resolvable reviewer still runs (issue 15 reconciliation semantics).
 */
export function automaticReviewEnabled(config: ReviewGateConfig, scopedModels?: string[]): boolean {
  const resolved = resolveReviewers(config, scopedModels);
  return config.enabled && resolved.reviewers.length > 0;
}

/**
 * Freeze one canonical configuration representation for a review window:
 * the base config's evidence-affecting settings plus the canonical reviewer
 * selection (with the exact external agent definitions it needs). The result
 * is self-contained: resolving it never consults live settings, so an
 * in-flight invocation keeps the exact reviewers it started with.
 */
export function configWithReviewers(
  config: ReviewGateConfig,
  selection: { activeReviewers: readonly ActiveReviewerSelection[]; externalAgents: readonly ExternalAgentConfig[] },
  enabled: boolean,
): ReviewGateConfig {
  const { ui: _ui, ...reviewRelevantConfig } = config;
  return {
    ...reviewRelevantConfig,
    enabled,
    review: { activeReviewers: selection.activeReviewers.map((s) => ({ ...s })) },
    externalAgents: selection.externalAgents.map(cloneExternalAgent),
  };
}

/**
 * Materialized (frozen) configurations carry only the resolvable reviewer
 * subset, so the selections that could not be resolved are remembered beside
 * the config object itself. Keying by the config object keeps an in-flight
 * invocation bound to the exact selection it started with: reconciling a
 * window later swaps in a new config object and never mutates this one.
 */
const unresolvedReviewerSelectionsByConfig = new WeakMap<ReviewGateConfig, string[]>();

export function rememberUnresolvedReviewerSelections(config: ReviewGateConfig, selections: readonly string[]): void {
  unresolvedReviewerSelectionsByConfig.set(config, [...selections]);
}

export function unresolvedReviewerSelectionsFor(config: ReviewGateConfig): string[] {
  return unresolvedReviewerSelectionsByConfig.get(config) ?? [];
}

/**
 * Duplicated selections of a materialized (frozen) configuration. Like the
 * unresolved selections, this metadata is typed, non-secret identity data that
 * only exists beside the config object: materialization collapses duplicates
 * into the resolvable subset, so without it a duplicate-only settings change
 * would be invisible in persisted digests.
 */
const duplicateReviewerSelectionsByConfig = new WeakMap<ReviewGateConfig, string[]>();

export function rememberDuplicateReviewerSelections(config: ReviewGateConfig, selections: readonly string[]): void {
  duplicateReviewerSelectionsByConfig.set(config, [...selections]);
}

export function duplicateReviewerSelectionsFor(config: ReviewGateConfig): string[] {
  return duplicateReviewerSelectionsByConfig.get(config) ?? [];
}

/**
 * Materialize the reviewers a live configuration would run. Must stay
 * consistent with review-window freeze semantics: unresolvable selections do
 * not disable the gate, they produce bounded outcomes at run time while every
 * resolvable reviewer still runs.
 */
export function materializeReviewConfig(config: ReviewGateConfig, scopedModels: string[]): ReviewGateConfig {
  const resolution = resolveReviewers(config, scopedModels);
  const materialized = configWithReviewers(
    config,
    frozenReviewerSelection(config, resolution),
    automaticReviewEnabled(config, scopedModels),
  );
  rememberUnresolvedReviewerSelections(materialized, resolution.unknownIds);
  rememberDuplicateReviewerSelections(materialized, resolution.duplicateEnabledIds);
  return materialized;
}

export function activeExternalExecutor(
  config: ReviewGateConfig,
  selection: ExecutorSelection | undefined,
): ExternalExecutorConfig | undefined {
  if (selection?.source !== "external") return undefined;
  const agent = externalAgentCatalog(config).find((candidate) => candidate.id === selection.id);
  return agent ? executorFromExternalAgent(agent, config.executorTimeoutMs) : undefined;
}

export function resolvedExecutorPool(config: ReviewGateConfig): ExecutorPoolEntry[] {
  return resolvedWorkerRoute(config, "execute");
}

export function resolvedWorkerResources(config: ReviewGateConfig): ExecutorPoolEntry[] {
  if (config.execution?.workerResources === undefined) return [];
  return config.execution.workerResources.map((entry) => ({
    entryId: entry.resourceId,
    selection: cloneExecutorSelection(entry.selection),
    maxConcurrent: entry.maxConcurrent,
  }));
}

export function resolvedWorkerRoute(config: ReviewGateConfig, kind: "execute" | "research"): ExecutorPoolEntry[] {
  const resources = resolvedWorkerResources(config);
  const configured = config.execution?.routes?.[kind];
  // Existing installations remain immediately usable for both roles until a
  // role-specific route is saved. Once present, omission from the list is an
  // explicit exclusion.
  const eligible = kind === "research"
    ? resources.filter((entry) => workerResourceSupportsResearch(config, entry))
    : resources;
  if (configured === undefined) return eligible;
  const byId = new Map(eligible.map((entry) => [entry.entryId, entry]));
  return configured.flatMap((route) => {
    const resource = byId.get(route.resourceId);
    if (!resource) return [];
    const selection = resource.selection.source === "pi" && route.thinkingLevel
      ? { ...resource.selection, thinkingLevel: route.thinkingLevel }
      : cloneExecutorSelection(resource.selection);
    return [{ ...resource, selection }];
  });
}

/** Research is enforced by Pi and initially best-effort for Codex/Claude. */
export function workerResourceSupportsResearch(config: ReviewGateConfig, entry: ExecutorPoolEntry): boolean {
  const selection = entry.selection;
  if (selection.source === "pi") return true;
  const agent = externalAgentCatalog(config).find((candidate) => candidate.id === selection.id);
  return agent?.adapter === "codex-cli" || agent?.adapter === "claude-cli";
}

export function executorEntryId(selection: ExecutorSelection): string {
  return selection.source === "external"
    ? `external-${selection.id}`
    : `pi-${Buffer.from(selection.model).toString("base64url")}`;
}

export function executorSelectionKey(selection: ExecutorSelection): string {
  return selection.source === "external" ? `external:${selection.id}` : `pi:${selection.model}`;
}

/**
 * Stable identity of what an executor selection actually resolves to under the
 * current configuration. A pi selection carries its own model, so the
 * selection key already proves compatibility; an external agent id is a
 * mutable handle into the agent catalog, and only this fingerprint records
 * which adapter/command/args/env/model that id served when a session was
 * created. The material is the fully merged invocation — inherited
 * (agent-level) args concatenated with role args and agent env overridden by
 * role env exactly as executorFromExternalAgent resolves them — encoded as
 * canonical JSON and reduced to a full SHA-256 digest, so delimiter-bearing
 * values cannot collide across command/args/env boundaries and no raw
 * configuration value ever crosses into persisted identity.
 */
export function executorAgentFingerprint(config: ReviewGateConfig, selection: ExecutorSelection): string {
  if (selection.source === "pi") return `pi:${selection.model}`;
  const agent = externalAgentCatalog(config).find((candidate) => candidate.id === selection.id);
  if (!agent) return `external:missing:${selection.id}`;
  const merged = mergedAgentRole(agent, agent.execution ?? {}, config.executorTimeoutMs);
  const resolved: Record<string, unknown> = {
    adapter: agent.adapter,
    command: agent.command
      ?? (agent.adapter === "codex-cli" ? "codex" : agent.adapter === "claude-cli" ? "claude" : ""),
    args: merged.args,
    env: merged.env,
    model: merged.model ?? "",
  };
  if (agent.adapter === "run-as-binary") resolved.protocol = "pi-review-executor-jsonl-v1";
  return `external:${createHash("sha256").update(canonicalStableJson(resolved)).digest("hex")}`;
}

export function externalAgentCatalog(config: ReviewGateConfig): ExternalAgentConfig[] {
  return (config.externalAgents ?? []).map(cloneExternalAgent);
}

export function externalAgentSupportsReview(agent: ExternalAgentConfig): boolean {
  return agent.review !== undefined;
}

export function externalAgentSupportsExecution(agent: ExternalAgentConfig): boolean {
  return agent.execution !== undefined && agent.adapter !== "generic-cli";
}

export function internalReviewerId(model: string): string {
  return `pi-${Buffer.from(model).toString("base64url")}`;
}

export function reviewerDisplayLabel(reviewer: DeciderConfig): string {
  if (reviewer.adapter === "pi-model") {
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

/**
 * One-way SHA-256 fingerprint of the effective reviewer configuration that ran
 * an invocation. The full canonical decider identity (id, adapter, model and
 * thinking level where applicable, command, args, env, timeout) is hashed
 * internally so a same-id replacement with different command/args/adapter/
 * parameters is distinguishable after reload, while no raw configuration value
 * ever crosses into persisted result metadata — only this digest does, the
 * same privacy boundary as configDigest. The fingerprint is not reversible to
 * a raw configuration snapshot.
 */
export function reviewerConfigFingerprint(reviewer: DeciderConfig): string {
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reviewer)) {
    if (value !== undefined) canonical[key] = value;
  }
  return createHash("sha256").update(canonicalStableJson(canonical)).digest("hex");
}

function canonicalStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalStableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function findConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PI_REVIEW_GATE_CONFIG) {
    return env.PI_REVIEW_GATE_CONFIG;
  }
  const candidates = [
    join(homedir(), ".config", "pi-review-gate", "config.json"),
    join(homedir(), ".config", "pi", "review-gate.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
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
    if (selection.source === "pi") {
      if (typeof selection.model !== "string" || !selection.model.trim()) {
        throw new Error("pi reviewer selection requires model");
      }
      const thinkingLevel = normalizeOptionalThinkingLevel(selection.thinkingLevel, "pi reviewer thinkingLevel");
      return {
        source: "pi",
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

function normalizeExecution(value: unknown): ExecutionConfig {
  if (!isRecord(value)) {
    throw new Error("execution must be an object");
  }
  const workerResources = value.workerResources === undefined
    ? undefined
    : normalizeWorkerResources(value.workerResources);
  const routes = value.routes === undefined
    ? undefined
    : normalizeWorkerRoutes(value.routes, workerResources ?? []);
  const maxWorkers = normalizeMaxWorkers(value.maxWorkers);
  const retryPolicy = normalizeExecutionRetryPolicy(value.retryPolicy);
  const subtaskNotifications = normalizeSubtaskNotificationMode(value.subtaskNotifications);
  if (value.deferredPiTools !== undefined && typeof value.deferredPiTools !== "boolean") {
    throw new Error("execution.deferredPiTools must be a boolean");
  }
  return {
    workerResources,
    routes,
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    retryPolicy,
    subtaskNotifications,
    deferredPiTools: value.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS,
  };
}

function normalizeWorkerResources(value: unknown): WorkerResourceEntry[] {
  if (!Array.isArray(value)) throw new Error("execution.workerResources must be an array");
  const entries = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`execution.workerResources[${index}] must be an object`);
    const selection = normalizeActiveExecutor(entry.selection);
    if (!selection) throw new Error(`execution.workerResources[${index}].selection cannot be null`);
    const resourceId = typeof entry.resourceId === "string" && entry.resourceId.trim()
      ? entry.resourceId.trim()
      : executorEntryId(selection);
    validateConfiguredId(resourceId, `execution.workerResources[${index}].resourceId`);
    return {
      resourceId,
      selection,
      maxConcurrent: normalizeRequiredWorkerCount(entry.maxConcurrent, `execution.workerResources[${index}].maxConcurrent`),
    };
  });
  validateUniqueConfiguredIds(entries.map((entry) => ({ id: entry.resourceId })), "worker resource");
  const selections = new Set<string>();
  for (const entry of entries) {
    const key = executorSelectionKey(entry.selection);
    if (selections.has(key)) throw new Error(`duplicate worker resource selection: ${key}`);
    selections.add(key);
  }
  return entries;
}

function normalizeWorkerRoutes(value: unknown, resources: readonly (WorkerResourceEntry | ExecutorPoolEntry)[]): WorkerRoutesConfig {
  if (!isRecord(value)) throw new Error("execution.routes must be an object");
  const resourceIds = new Set(resources.map((entry) => "resourceId" in entry ? entry.resourceId : entry.entryId));
  const normalizeRoute = (candidate: unknown, field: string): WorkerRouteEntry[] | undefined => {
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate)) throw new Error(`${field} must be an array`);
    const route = candidate.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object`);
      const resourceId = normalizeOptionalNonEmptyString(entry.resourceId, `${field}[${index}].resourceId`);
      if (!resourceId) throw new Error(`${field}[${index}].resourceId is required`);
      if (!resourceIds.has(resourceId)) throw new Error(`${field}[${index}] references unknown worker resource ${resourceId}`);
      return {
        resourceId,
        thinkingLevel: normalizeOptionalThinkingLevel(entry.thinkingLevel, `${field}[${index}].thinkingLevel`),
      };
    });
    validateUniqueConfiguredIds(route.map((entry) => ({ id: entry.resourceId })), `${field} resource`);
    return route;
  };
  return {
    execute: normalizeRoute(value.execute, "execution.routes.execute"),
    research: normalizeRoute(value.research, "execution.routes.research"),
  };
}

function normalizeSubtaskNotificationMode(value: unknown): SubtaskNotificationMode {
  if (value === undefined) return DEFAULT_SUBTASK_NOTIFICATION_MODE;
  if (value !== "quiet" && value !== "noisy") {
    throw new Error("execution.subtaskNotifications must be quiet or noisy");
  }
  return value;
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
    throw new Error("executor selection must be an object or null");
  }
  if (value.source === "pi") {
    if (typeof value.model !== "string" || !value.model.trim()) {
      throw new Error("pi executor selection requires model");
    }
    const thinkingLevel = normalizeOptionalThinkingLevel(value.thinkingLevel, "pi executor thinkingLevel");
    return {
      source: "pi",
      model: value.model.trim(),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }
  if (value.source === "external") {
    if (typeof value.id !== "string" || !value.id.trim()) {
      throw new Error("external executor selection requires id");
    }
    validateConfiguredId(value.id, "external executor");
    return { source: "external", id: value.id };
  }
  throw new Error("unsupported executor selection source");
}

function normalizeRequiredWorkerCount(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  const count = value as number;
  if (count < 1 || count > MAX_EXECUTION_WORKERS) {
    throw new Error(`${field} must be between 1 and ${MAX_EXECUTION_WORKERS}`);
  }
  return count;
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
    model: common.model,
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

function cloneExecutorSelection(selection: ExecutorSelection): ExecutorSelection {
  return selection.source === "external"
    ? { source: "external", id: selection.id }
    : {
      source: "pi",
      model: selection.model,
      ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    };
}

function normalizeOperatingMode(value: unknown): OperatingMode {
  if (value === undefined) return DEFAULT_OPERATING_MODE;
  if (typeof value === "string" && (OPERATING_MODES as readonly string[]).includes(value)) {
    return value as OperatingMode;
  }
  throw new Error(`operatingMode must be one of: ${OPERATING_MODES.join(", ")}`);
}

/** Parsed chord: canonical modifier names (given order) plus canonical key. */
interface ModeCycleChordParts {
  modifiers: string[];
  key: string;
}

function parseModeCycleChord(value: string): ModeCycleChordParts {
  const parts = value.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error(
      "modeCycleShortcut must be a key, optionally preceded by ctrl, shift, alt, or super, e.g. alt+m",
    );
  }
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = part.toLowerCase();
    if (!(MODE_CYCLE_MODIFIERS as readonly string[]).includes(modifier) || modifiers.includes(modifier)) {
      throw new Error(
        `modeCycleShortcut modifiers must be ctrl, shift, alt, or super (each at most once); got "${part}"`,
      );
    }
    modifiers.push(modifier);
  }
  return { modifiers, key: canonicalModeCycleKey(parts[parts.length - 1]!) };
}

/**
 * Pi shortcut form: optional modifiers plus one key (letter, digit,
 * function key, named special, or symbol), e.g. "alt+m" or "f6".
 * Modifier order is preserved; casing and alias names (esc, return, pageup)
 * are canonicalized. Invalid values fail strictly at explicit writes and are
 * defaulted with a warning at startup recovery.
 */
export function normalizeModeCycleShortcut(value: unknown): string {
  if (value === undefined) return DEFAULT_MODE_CYCLE_SHORTCUT;
  if (typeof value !== "string") {
    throw new Error(`modeCycleShortcut must be a string like "alt+m"`);
  }
  const chord = parseModeCycleChord(value);
  return `${[...chord.modifiers, chord.key].join("+")}`;
}

/**
 * Modifier-order- and alias-insensitive chord identity used for host-binding
 * occupancy comparisons (issue #20): "shift+ctrl+r" and "ctrl+shift+r" are
 * the same physical chord and must compare equal. Returns undefined for
 * strings outside the supported grammar (which then simply cannot collide).
 */
export function canonicalModeCycleChord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const chord = parseModeCycleChord(value);
    return [...chord.modifiers.sort(), chord.key].join("+");
  } catch {
    return undefined;
  }
}

const MODE_CYCLE_MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;

const MODE_CYCLE_SPECIAL_KEYS: Record<string, string> = {
  escape: "escape",
  esc: "escape",
  enter: "enter",
  return: "enter",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  clear: "clear",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pagedown: "pageDown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

const MODE_CYCLE_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+",
  "|", "~", "{", "}", ":", "<", ">", "?",
]);

function canonicalModeCycleKey(raw: string): string {
  const key = raw.toLowerCase();
  if (key.length === 1) {
    if (/[a-z0-9]/.test(key) || MODE_CYCLE_SYMBOL_KEYS.has(key)) return key;
    throw new Error(`modeCycleShortcut key must be a letter, digit, symbol, or named key; got "${raw}"`);
  }
  const special = Object.hasOwn(MODE_CYCLE_SPECIAL_KEYS, key) ? MODE_CYCLE_SPECIAL_KEYS[key] : undefined;
  if (special) return special;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key;
  throw new Error(
    `modeCycleShortcut key must be a letter, digit, symbol, f1-f12, or a named key (enter, tab, escape, space, backspace, delete, insert, home, end, pageUp, pageDown, up, down, left, right); got "${raw}"`,
  );
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

function positiveIntegerOrDefault(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function boundedPositiveIntegerOrDefault(value: unknown, fallback: number, maximum: number, field: string): number {
  const normalized = positiveIntegerOrDefault(value, fallback, field);
  if (normalized > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum}`);
  }
  return normalized;
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

// Shared truthiness for PI_REVIEW_GATE_* kill switches. The launcher
// (scripts/pi-review-gate.sh) duplicates this list for its warning; keep the
// two in sync.
function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function firstTruthyEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  return names.find((name) => isTruthy(env[name]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
