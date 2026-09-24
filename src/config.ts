import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { ConfigPathResolution } from "./config-path";
import { reviewGateConfigCandidates, resolveConfigPathResolution } from "./config-path";
import { parseCronExpression } from "./scheduling/cron";

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

/**
 * Independently selectable managed-browser permission toggles (issue #27).
 *
 * The `model*` fields constrain model-driven browser actions only: human
 * credential/form submission and file uploads remain allowed regardless of
 * them. `localNetworks` applies to human and model navigation alike. `yolo`
 * is the master override that enables every capability and bypasses per-action
 * approval prompts. Every field defaults to false, so default browser behavior
 * is unchanged unless a capability is explicitly enabled. Unknown keys in this
 * object are ignored and never grant capabilities.
 */
export interface WebBrowserPermissions {
  /** Model may enter values into password/credential fields. */
  modelCredentialEntry: boolean;
  /** Model may submit forms containing credentials. Human submission is unaffected. */
  modelCredentialSubmission: boolean;
  /** Model may upload files; selection and side effects follow the interaction-approval policy. */
  modelUploads: boolean;
  /** Model may save downloads to disk; selection and side effects follow the interaction-approval policy. */
  modelDownloadSaving: boolean;
  /** Model may read from and write to the host clipboard. */
  modelClipboard: boolean;
  /** Model-driven browser sessions may use the camera. Grants capability, not forced activation. */
  modelCamera: boolean;
  /** Model-driven browser sessions may use the microphone. Grants capability, not forced activation. */
  modelMicrophone: boolean;
  /** Model-driven browser sessions may request geolocation. */
  modelGeolocation: boolean;
  /** Service workers are allowed in the managed browser. Grants capability, not forced registration. */
  modelServiceWorkers: boolean;
  /** The current popup restriction is lifted for the managed browser. Grants capability, not forced activation. */
  modelPopupRestrictionOverride: boolean;
  /** Human and model navigation may reach loopback, private, and link-local addresses (including cloud metadata endpoints). */
  localNetworks: boolean;
  /** Master override: enables every browser capability and bypasses per-action approval prompts. */
  yolo: boolean;
}

/** Stable field order of the a-la-carte browser permission toggles. */
export const BROWSER_PERMISSION_FIELDS = [
  "modelCredentialEntry",
  "modelCredentialSubmission",
  "modelUploads",
  "modelDownloadSaving",
  "modelClipboard",
  "modelCamera",
  "modelMicrophone",
  "modelGeolocation",
  "modelServiceWorkers",
  "modelPopupRestrictionOverride",
  "localNetworks",
  "yolo",
] as const;
export type BrowserPermissionField = (typeof BROWSER_PERMISSION_FIELDS)[number];

/** All browser permission toggles off: default behavior is unchanged. */
export const DEFAULT_BROWSER_PERMISSIONS: WebBrowserPermissions = {
  modelCredentialEntry: false,
  modelCredentialSubmission: false,
  modelUploads: false,
  modelDownloadSaving: false,
  modelClipboard: false,
  modelCamera: false,
  modelMicrophone: false,
  modelGeolocation: false,
  modelServiceWorkers: false,
  modelPopupRestrictionOverride: false,
  localNetworks: false,
  yolo: false,
};

export interface WebConfig {
  enabled: boolean;
  browserInteractionApproval: BrowserInteractionApproval;
  browserIdleExpiryMinutes: number;
  /**
   * Maximum retained unsaved downloads per interactive-browser session
   * (issue #27); 0 disables count-based eviction entirely. Saved files are
   * never counted or affected.
   */
  browserDownloadRetention: number;
  /** Interactive browser window visibility; false (default) keeps the headless QA browser. */
  browserVisible: boolean;
  /** Independently selectable managed-browser permissions (issue #27); all off by default. */
  browserPermissions: WebBrowserPermissions;
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
export interface WorkerResourceValue {
  selection: ExecutorSelection;
  maxConcurrent: number;
}

/**
 * Unordered worker catalog keyed by stable resource ID. The key is the
 * resource's identity; ordered route lists reference keys, never positions.
 */
export type WorkerResourceCatalog = Record<string, WorkerResourceValue>;

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

/** Stored form of one external agent definition; the catalog key carries the id. */
export type ExternalAgentValue = Omit<ExternalAgentConfig, "id">;

/** Unordered external-agent catalog keyed by stable agent ID. */
export type ExternalAgentCatalog = Record<string, ExternalAgentValue>;

export type ActiveReviewerSelection =
  | { source: "pi"; model: string; thinkingLevel?: ThinkingLevel }
  | { source: "external"; id: string };

/** Which review layer a selection, resolution, or enablement flag applies to. */
export type ReviewLayer = "primary" | "subtask";

/** Default automatic-review enablement for the primary layer (issue #175). */
export const REVIEW_PRIMARY_ENABLED_DEFAULT = true;
/** Default automatic-review enablement for the subtask layer (issue #175). */
export const REVIEW_SUBTASK_ENABLED_DEFAULT = true;
/** Default landed-change re-review posture: landed changes stay checkpointed out of the primary window. */
export const REVIEW_LANDED_CHANGES_DEFAULT = false;

export interface ReviewSelectionConfig {
  /**
   * Legacy single reviewer set (pre-#175 records). It is never the effective
   * state by itself: `effectiveReviewSettings` imports it into both split
   * sets in memory on load. Save removes the key; loading never rewrites it.
   */
  activeReviewers?: ActiveReviewerSelection[];
  /** Automatic review of the primary assistant's own changes (shared by Execute and Orchestrate). */
  primaryReviewers?: ActiveReviewerSelection[];
  /** Automatic review of subtask results before ordinary accepted landing. */
  subtaskReviewers?: ActiveReviewerSelection[];
  /**
   * Automatic primary review is on. Controls automatic review only: manual
   * `/review-now` and `/ask-reviewer` stay usable while reviewers remain
   * selected. Defaults on (preserves pre-split behavior).
   */
  primaryEnabled?: boolean;
  /** Automatic subtask review is on. Defaults on (preserves pre-split behavior). */
  subtaskEnabled?: boolean;
  /**
   * Changes landed into the primary review window stay pending in that
   * window's diff instead of being checkpointed out. Inactive while
   * `primaryEnabled` is off. Defaults off (preserves current behavior).
   */
  reviewLandedChanges?: boolean;
}

/**
 * Effective, layer-resolved review settings derived from one configuration
 * (issue #175). Field names match the canonical stored `review.*` fields
 * one-for-one; this is the shared seam later runtime integration consumes.
 */
export interface EffectiveReviewSettings {
  /** Reviewer set for the primary assistant's own changes (Execute + Orchestrate). */
  primaryReviewers: ActiveReviewerSelection[];
  /** Reviewer set for subtask review before ordinary accepted landing. */
  subtaskReviewers: ActiveReviewerSelection[];
  /** Automatic primary review on (manual review commands are unaffected). */
  primaryEnabled: boolean;
  /** Automatic subtask review on. */
  subtaskEnabled: boolean;
  /** Landed-change re-review choice; inactive while `primaryEnabled` is off. */
  reviewLandedChanges: boolean;
}

function cloneReviewerSelections(values: readonly ActiveReviewerSelection[] | undefined): ActiveReviewerSelection[] {
  return (values ?? []).map((selection) => ({ ...selection }));
}

/**
 * The single derivation seam for the #175 reviewer split.
 *
 * - A configuration that stores either split set (`primaryReviewers` or
 *   `subtaskReviewers`) is a split configuration: its saved choices are
 *   authoritative, a coexisting legacy `activeReviewers` copy is ignored
 *   without a rewrite (the same doubled-record precedence as the
 *   pre-cutover fields), and it is never re-imported over saved choices.
 * - A legacy configuration that stores only `activeReviewers` is imported
 *   in memory on every load: the same selections become both effective
 *   sets, so menus and resolution see them immediately while the stored
 *   record stays byte-identical until the next save. The import is
 *   stateless and idempotent, so Cancel keeps the file (and the session
 *   keeps the effective sets) and re-loading the unchanged file re-imports
 *   identically.
 *
 * Returned arrays are fresh clones; callers may mutate them freely.
 */
export function effectiveReviewSettings(config: ReviewGateConfig): EffectiveReviewSettings {
  const review = config.review ?? {};
  const primaryEnabled = review.primaryEnabled ?? REVIEW_PRIMARY_ENABLED_DEFAULT;
  const subtaskEnabled = review.subtaskEnabled ?? REVIEW_SUBTASK_ENABLED_DEFAULT;
  const reviewLandedChanges = review.reviewLandedChanges ?? REVIEW_LANDED_CHANGES_DEFAULT;
  if (review.primaryReviewers !== undefined || review.subtaskReviewers !== undefined) {
    return {
      primaryReviewers: cloneReviewerSelections(review.primaryReviewers),
      subtaskReviewers: cloneReviewerSelections(review.subtaskReviewers),
      primaryEnabled,
      subtaskEnabled,
      reviewLandedChanges,
    };
  }
  const legacy = cloneReviewerSelections(review.activeReviewers);
  return {
    primaryReviewers: cloneReviewerSelections(legacy),
    subtaskReviewers: cloneReviewerSelections(legacy),
    primaryEnabled,
    subtaskEnabled,
    reviewLandedChanges,
  };
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
  /** Unordered shared-capacity catalog keyed by resource ID; routes reference keys. */
  workerResources?: WorkerResourceCatalog;
  /** Independent ordered resource eligibility for execution and research. */
  routes?: WorkerRoutesConfig;
  maxWorkers?: number;
  retryPolicy?: ExecutionRetryPolicy;
  subtaskNotifications?: SubtaskNotificationMode;
  /** Defer Pi-native schemas until search_tools activation. Defaults on. */
  deferredPiTools?: boolean;
}

/** What a scheduled task runs: a write-capable subtask or a read-only research one. */
export type ScheduledTaskKind = "execute" | "research";

/**
 * A task-local review override (issue #26). `off` runs the task's subtasks
 * without any review — including write-capable tasks — and never fabricates a
 * verdict; `selected` reviews the task's runs with exactly the listed set.
 * An absent override inherits the live global subtask review settings.
 */
export type ScheduledTaskReviewOverride =
  | { mode: "off" }
  | { mode: "selected"; reviewers: ActiveReviewerSelection[] };

/**
 * One independently scheduled task entry (issue #26). Stored once, keyed by
 * its stable identity; every field is self-contained and no inherited global
 * value is ever copied into the entry — omitted optional fields inherit the
 * current global subtask settings at each future run.
 */
export interface ScheduledTaskEntryConfig {
  /** Human label, editable without changing the entry's stable identity. */
  name: string;
  /** Standard 5-field Unix cron expression, interpreted in machine-local time. */
  cron: string;
  /** Disabled entries stay configured but are never dispatched. */
  enabled: boolean;
  kind: ScheduledTaskKind;
  /** Instructions carried verbatim to the scheduled subtask. */
  instructions: string;
  /** Explicit authorized target workspace directory for the scheduled run. */
  workspace: string;
  /**
   * Explicit worker resource id override from `execution.workerResources`.
   * Never requires a global-route membership: the independent catalog is the
   * source, though research capability is still enforced for research tasks.
   * Omitted, the kind's live global route applies at each future run.
   */
  workerResourceId?: string;
  /** Task-local review choice; omitted inherits live global subtask review settings. */
  review?: ScheduledTaskReviewOverride;
}

/** Unordered scheduled-task catalog keyed by stable task identity. */
export type ScheduledTaskCatalog = Record<string, ScheduledTaskEntryConfig>;

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
  externalAgents?: ExternalAgentCatalog;
  execution?: ExecutionConfig;
  /** Independently scheduled task entries (issue #26); the only canonical copy. */
  scheduledTasks?: ScheduledTaskCatalog;
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
    browserVisible: false,
    browserIdleExpiryMinutes: 15,
    browserDownloadRetention: 8,
    browserPermissions: { ...DEFAULT_BROWSER_PERMISSIONS },
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

/**
 * Load the review-gate configuration.
 *
 * Path resolution (issue 94): the explicit `PI_REVIEW_GATE_CONFIG` override
 * always wins; otherwise the first existing of the Pi-agent default
 * (`PI_CODING_AGENT_DIR`-aware `<agentDir>/review-gate.json`) and the sole
 * compatibility fallback `~/.config/pi-review-gate/config.json` is loaded.
 * The removed `~/.config/pi/review-gate.json` location is never discovered.
 * The optional second parameter is an explicit resolution seam for tests;
 * production callers use the real home directory and platform.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  resolution: Partial<ConfigPathResolution> = {},
): LoadedConfig {
  const disabledVar = firstTruthyEnv(env, ["PI_REVIEW_GATE_DISABLED"]);
  if (disabledVar) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      disabledReason: `${disabledVar} is set`,
      globallyDisabled: true,
    };
  }

  const path = findConfigPath(env, resolution);
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
  const containers = new Set(["web", "web.search", "web.fetch", "web.browserPermissions", "ui", "review",
    "execution", "execution.retryPolicy", "execution.routes",
    "execution.workerResources", "externalAgents", "scheduledTasks"]);
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
    // Resources must precede routes; the scheduled-task catalog must follow
    // execution and externalAgents, so its worker-resource cross-references
    // validate against the recovered catalog instead of the key order deciding
    // whether valid worker-pinned entries survive recovery.
    const last = new Set(["routes", "decider", "reviewers", "enabledReviewerIds", "activeExecutor", "executorPool", "externalExecutors", "scheduledTasks"]);
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
    scheduledTasks: value.scheduledTasks === undefined ? undefined : normalizeScheduledTasks(value.scheduledTasks),
    ui: value.ui === undefined ? undefined : normalizeUi(value.ui),
    web: normalizeWeb(value.web),
  };

  validateScheduledTaskReferences(config);
  return config;
}

/**
 * Cross-checks of the scheduled-task catalog against the worker resources it
 * may name. An explicit worker override is independent of the global role
 * routes by design (issue #26): catalog membership, not route membership, is
 * what authorizes the selection — route membership would defeat the entry's
 * independence from later route edits. Research capability is still enforced,
 * because a scheduled research task must not dispatch to an executor resource
 * that cannot perform research.
 */
function validateScheduledTaskReferences(config: ReviewGateConfig): void {
  const scheduledTasks = config.scheduledTasks;
  if (!scheduledTasks) return;
  for (const [id, entry] of Object.entries(scheduledTasks)) {
    if (entry.workerResourceId === undefined) continue;
    const resource = resolvedWorkerResource(config, entry.workerResourceId);
    if (!resource) {
      throw new Error(`scheduledTasks.${id} references unknown worker resource ${entry.workerResourceId}`);
    }
    if (entry.kind === "research" && !workerResourceSupportsResearch(config, resource.selection)) {
      throw new Error(`scheduledTasks.${id} worker resource is not research-capable: ${entry.workerResourceId}`);
    }
  }
}

/**
 * Canonical form is an object keyed by stable task identity. Required fields
 * stay required, `enabled` defaults to true, `kind` defaults to execute, and
 * the cron expression is validated by the shared grammar parser. Optional
 * override fields stay absent when not provided: absence is the single
 * discriminator for inheritance, so no inherited global value is ever copied
 * into the entry (issue #26: exactly one durable copy of every setting).
 */
function normalizeScheduledTasks(value: unknown): ScheduledTaskCatalog {
  if (!isRecord(value)) throw new Error("scheduledTasks must be an object");
  const catalog: ScheduledTaskCatalog = {};
  for (const [id, entry] of Object.entries(value)) {
    validateConfiguredId(id, "scheduled task");
    if (!isRecord(entry)) throw new Error(`scheduledTasks.${id} must be an object`);
    const name = requireNonEmptyString(entry.name, `scheduledTasks.${id}.name`);
    const cron = parseCronExpression(entry.cron, `scheduledTasks.${id}.cron`).expression;
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      throw new Error(`scheduledTasks.${id}.enabled must be a boolean`);
    }
    const kind = entry.kind === undefined ? "execute" : entry.kind;
    if (kind !== "execute" && kind !== "research") {
      throw new Error(`scheduledTasks.${id}.kind must be execute or research`);
    }
    const instructions = requireNonEmptyString(entry.instructions, `scheduledTasks.${id}.instructions`);
    const workspace = requireNonEmptyString(entry.workspace, `scheduledTasks.${id}.workspace`);
    let workerResourceId: string | undefined;
    if (entry.workerResourceId !== undefined) {
      workerResourceId = normalizeOptionalNonEmptyString(entry.workerResourceId, `scheduledTasks.${id}.workerResourceId`);
      validateConfiguredId(workerResourceId!, "scheduled task worker resource");
    }
    const review = entry.review === undefined
      ? undefined
      : normalizeScheduledTaskReviewOverride(entry.review, `scheduledTasks.${id}`);
    defineOwnKey(catalog, id, {
      name,
      cron,
      enabled: entry.enabled ?? true,
      kind,
      instructions,
      workspace,
      ...(workerResourceId !== undefined ? { workerResourceId } : {}),
      ...(review !== undefined ? { review } : {}),
    });
  }
  return catalog;
}

function normalizeScheduledTaskReviewOverride(value: unknown, field: string): ScheduledTaskReviewOverride {
  if (!isRecord(value)) throw new Error(`${field}.review must be an object`);
  if (value.mode === "off") return { mode: "off" };
  if (value.mode === "selected") {
    return { mode: "selected", reviewers: normalizeActiveReviewers(value.reviewers, `${field}.review.reviewers`) };
  }
  throw new Error(`${field}.review.mode must be "off" or "selected"`);
}

/** Required, non-empty-after-trim string value. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
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
  const canonical = isRecord(value.review)
    && (Array.isArray(value.review.activeReviewers)
      || Array.isArray(value.review.primaryReviewers)
      || Array.isArray(value.review.subtaskReviewers));
  if (canonical) return; // doubled record: the canonical selection wins
  throw new Error(
    `unsupported legacy reviewer configuration: ${legacy.join(", ")} is no longer accepted; ` +
    "select reviewers with review.primaryReviewers/review.subtaskReviewers and define external harnesses in externalAgents",
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
  if (value.browserVisible !== undefined && typeof value.browserVisible !== "boolean") throw new Error("web.browserVisible must be a boolean");
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
    browserVisible: value.browserVisible === undefined ? defaults.browserVisible : value.browserVisible,
    browserIdleExpiryMinutes: nonNegativeIntegerOrDefault(
      value.browserIdleExpiryMinutes, defaults.browserIdleExpiryMinutes, "web.browserIdleExpiryMinutes",
    ),
    browserDownloadRetention: nonNegativeIntegerOrDefault(
      value.browserDownloadRetention, defaults.browserDownloadRetention, "web.browserDownloadRetention",
    ),
    browserPermissions: value.browserPermissions === undefined
      ? { ...DEFAULT_BROWSER_PERMISSIONS }
      : normalizeBrowserPermissions(value.browserPermissions),
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

/**
 * Strict per-field validation for the a-la-carte browser permission toggles.
 * Every known field must be an explicit boolean when present; anything else
 * rejects loading rather than silently granting (or dropping) authority. Keys
 * outside the stable field list are ignored: unknown config can never enable a
 * capability, and no acknowledgment token is invented for file-level values.
 */
function normalizeBrowserPermissions(value: unknown): WebBrowserPermissions {
  if (!isRecord(value)) throw new Error("web.browserPermissions must be an object");
  const permissions = {} as WebBrowserPermissions;
  for (const field of BROWSER_PERMISSION_FIELDS) {
    const raw = value[field];
    if (raw !== undefined && typeof raw !== "boolean") {
      throw new Error(`web.browserPermissions.${field} must be a boolean`);
    }
    permissions[field] = raw === true;
  }
  return permissions;
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
 * Resolve one review layer's reviewer selection (issue #175).
 *
 * The selections come from `effectiveReviewSettings`: the layer's stored set
 * for a split configuration, or the legacy `review.activeReviewers` import
 * for a pre-split one. Omitting the layer resolves the primary set, which
 * preserves pre-split runtime behavior until dedicated runtime integration.
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
export function resolveReviewers(
  config: ReviewGateConfig,
  scopedModels?: string[],
  layer: ReviewLayer = "primary",
): ReviewerResolution {
  const settings = effectiveReviewSettings(config);
  const selections = layer === "primary" ? settings.primaryReviewers : settings.subtaskReviewers;
  const scoped = new Set(scopedModels ?? []);
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
    const agent = resolvedExternalAgent(config, selection.id);
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
  layer: ReviewLayer = "primary",
): { activeReviewers: ActiveReviewerSelection[]; externalAgents: ExternalAgentCatalog } {
  const unknown = new Set(resolution.unknownIds);
  const settings = effectiveReviewSettings(config);
  const selections = layer === "primary" ? settings.primaryReviewers : settings.subtaskReviewers;
  const activeReviewers = selections
    .filter((selection) => !unknown.has(reviewerSelectionKey(selection)))
    .map((selection) => ({ ...selection }));
  const needed = new Set(
    activeReviewers.filter((selection): selection is { source: "external"; id: string } => selection.source === "external")
      .map((selection) => selection.id),
  );
  const catalog = config.externalAgents ?? {};
  const externalAgents: ExternalAgentCatalog = {};
  for (const id of needed) {
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) continue;
    defineOwnKey(externalAgents, id, cloneExternalAgentValue(catalog[id]!));
  }
  return { activeReviewers, externalAgents };
}

/**
 * Automatic review is enabled for a layer when the gate is on and at least
 * one of the layer's reviewers resolves. Unresolvable or duplicated
 * selections no longer disable the whole gate: they produce explicit bounded
 * outcomes at run time while every resolvable reviewer still runs (issue 15
 * reconciliation semantics).
 *
 * This predicate describes reviewer availability, not the human-controlled
 * automatic-review policy switch. Manual `/review-now` and `/ask-reviewer`
 * share it with review-window materialization, so they remain usable with
 * selected primary reviewers even when `primaryEnabled` is off. Automatic
 * primary settlement and subtask lifecycles apply their respective switches
 * from `effectiveReviewSettings` at their own review boundaries.
 */
export function automaticReviewEnabled(
  config: ReviewGateConfig,
  scopedModels?: string[],
  layer: ReviewLayer = "primary",
): boolean {
  const resolved = resolveReviewers(config, scopedModels, layer);
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
  selection: { activeReviewers: readonly ActiveReviewerSelection[]; externalAgents: ExternalAgentCatalog },
  enabled: boolean,
): ReviewGateConfig {
  const { ui: _ui, ...reviewRelevantConfig } = config;
  return {
    ...reviewRelevantConfig,
    enabled,
    review: { activeReviewers: selection.activeReviewers.map((s) => ({ ...s })) },
    externalAgents: cloneExternalAgentCatalog(selection.externalAgents),
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
  const agent = resolvedExternalAgent(config, selection.id);
  return agent ? executorFromExternalAgent(agent, config.executorTimeoutMs) : undefined;
}

export function resolvedExecutorPool(config: ReviewGateConfig): ExecutorPoolEntry[] {
  return resolvedWorkerRoute(config, "execute");
}

/** Direct keyed lookup of one worker resource; keys are data, not property names. */
export function resolvedWorkerResource(config: ReviewGateConfig, resourceId: string): ExecutorPoolEntry | undefined {
  const catalog = config.execution?.workerResources;
  if (!catalog) return undefined;
  const value = Object.prototype.hasOwnProperty.call(catalog, resourceId) ? catalog[resourceId] : undefined;
  if (!value) return undefined;
  return {
    entryId: resourceId,
    selection: cloneExecutorSelection(value.selection),
    maxConcurrent: value.maxConcurrent,
  };
}

/** Keyed clone of the worker catalog, for settings and other keyed consumers. */
export function resolvedWorkerCatalog(config: ReviewGateConfig): WorkerResourceCatalog {
  return cloneWorkerCatalog(config.execution?.workerResources ?? {});
}

/** Derived capacity list of the keyed catalog, for shared-capacity accounting. */
export function resolvedWorkerResources(config: ReviewGateConfig): ExecutorPoolEntry[] {
  const catalog = config.execution?.workerResources;
  if (!catalog) return [];
  return Object.keys(catalog).map((resourceId) => {
    const value = catalog[resourceId]!;
    return {
      entryId: resourceId,
      selection: cloneExecutorSelection(value.selection),
      maxConcurrent: value.maxConcurrent,
    };
  });
}

/**
 * Resolve one role's ordered route against the keyed catalog. Missing or empty
 * routes mean no models for that role; there is no fallback to catalog order.
 * Research additionally enforces capability: an explicit route entry cannot
 * widen what the research role may use, so unsupported selections are omitted
 * even when a route names them directly.
 */
export function resolvedWorkerRoute(config: ReviewGateConfig, kind: "execute" | "research"): ExecutorPoolEntry[] {
  const configured = config.execution?.routes?.[kind];
  if (!configured || configured.length === 0) return [];
  return configured.flatMap((route) => {
    const resource = resolvedWorkerResource(config, route.resourceId);
    if (!resource) return [];
    if (kind === "research" && !workerResourceSupportsResearch(config, resource.selection)) return [];
    const selection = resource.selection.source === "pi" && route.thinkingLevel
      ? { ...resource.selection, thinkingLevel: route.thinkingLevel }
      : resource.selection;
    return [{ ...resource, selection }];
  });
}

/** Research is enforced by Pi and initially best-effort for Codex/Claude. */
export function workerResourceSupportsResearch(config: ReviewGateConfig, selection: ExecutorSelection): boolean {
  if (selection.source === "pi") return true;
  const agent = resolvedExternalAgent(config, selection.id);
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
  const agent = resolvedExternalAgent(config, selection.id);
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

/** Direct keyed lookup of one external agent; keys are data, not property names. */
export function resolvedExternalAgent(config: ReviewGateConfig, id: string): ExternalAgentConfig | undefined {
  const catalog = config.externalAgents;
  if (!catalog) return undefined;
  const value = Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
  if (!value) return undefined;
  return { ...cloneExternalAgentValue(value), id };
}

/** Derived alphabetical list of the keyed agent catalog, for display and enumeration. */
export function externalAgentCatalog(config: ReviewGateConfig): ExternalAgentConfig[] {
  const catalog = config.externalAgents;
  if (!catalog) return [];
  return Object.keys(catalog).sort().map((id) => ({ ...cloneExternalAgentValue(catalog[id]!), id }));
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

function findConfigPath(
  env: NodeJS.ProcessEnv,
  resolution: Partial<ConfigPathResolution>,
): string | undefined {
  if (env.PI_REVIEW_GATE_CONFIG) {
    return env.PI_REVIEW_GATE_CONFIG;
  }
  const candidates = reviewGateConfigCandidates(env, resolveConfigPathResolution(resolution));
  // Fail-closed precedence: a candidate counts as present when it exists in
  // any form, including dangling symlinks. A dangling or unreadable primary
  // is therefore returned for loadConfig to handle (its existing unreadable-
  // config recovery) instead of being bypassed in favor of a lower-priority
  // candidate; only true absence selects the next candidate.
  return candidates.find((candidate) => {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

function normalizeReviewSelection(value: unknown): ReviewSelectionConfig {
  if (!isRecord(value)) {
    throw new Error("review must be an object");
  }
  for (const field of ["primaryEnabled", "subtaskEnabled", "reviewLandedChanges"] as const) {
    const flag = value[field];
    if (flag !== undefined && typeof flag !== "boolean") {
      throw new Error(`review.${field} must be a boolean`);
    }
  }
  return {
    activeReviewers: value.activeReviewers === undefined
      ? undefined
      : normalizeActiveReviewers(value.activeReviewers),
    primaryReviewers: value.primaryReviewers === undefined
      ? undefined
      : normalizeActiveReviewers(value.primaryReviewers, "review.primaryReviewers"),
    subtaskReviewers: value.subtaskReviewers === undefined
      ? undefined
      : normalizeActiveReviewers(value.subtaskReviewers, "review.subtaskReviewers"),
    ...(value.primaryEnabled !== undefined ? { primaryEnabled: value.primaryEnabled as boolean } : {}),
    ...(value.subtaskEnabled !== undefined ? { subtaskEnabled: value.subtaskEnabled as boolean } : {}),
    ...(value.reviewLandedChanges !== undefined ? { reviewLandedChanges: value.reviewLandedChanges as boolean } : {}),
  };
}

function normalizeActiveReviewers(value: unknown, field = "review.activeReviewers"): ActiveReviewerSelection[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((selection) => {
    if (!isRecord(selection)) {
      throw new Error(`${field} entries must be objects`);
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
    throw new Error(`unsupported ${field} source`);
  });
}

/**
 * Canonical form is an object keyed by agent ID. The legacy array form is
 * deprecated but still imported at load: each entry's id becomes its key.
 * Duplicate ids fail validation instead of silently overwriting.
 */
function normalizeExternalAgents(value: unknown): ExternalAgentCatalog {
  const rawEntries: Array<readonly [string, unknown]> = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (!isRecord(entry)) throw new Error(`externalAgents[${index}] must be an object`);
      if (typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error(`externalAgents[${index}] requires id`);
      }
      rawEntries.push([entry.id.trim(), entry]);
    }
  } else {
    if (!isRecord(value)) throw new Error("externalAgents must be an object");
    rawEntries.push(...Object.entries(value));
  }
  const catalog: ExternalAgentCatalog = {};
  for (const [id, entry] of rawEntries) {
    validateConfiguredId(id, "external agent");
    if (Object.prototype.hasOwnProperty.call(catalog, id)) {
      throw new Error(`external agent id must be unique: ${id}`);
    }
    defineOwnKey(catalog, id, normalizeExternalAgent(entry, id));
  }
  return catalog;
}

function normalizeExternalAgent(value: unknown, id: string): ExternalAgentValue {
  if (!isRecord(value)) {
    throw new Error("external agent must be an object");
  }
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
    throw new Error(`external agent requires review or execution role: ${id}`);
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
    : normalizeWorkerRoutes(value.routes, workerResources ?? {});
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

/**
 * Canonical form is an object keyed by stable resource ID. The legacy array
 * form is deprecated but still imported at load: each entry's resourceId (or
 * its established generated id when omitted) becomes its key. Duplicate ids
 * and duplicate selections fail validation instead of silently overwriting.
 */
function normalizeWorkerResources(value: unknown): WorkerResourceCatalog {
  const rawEntries: Array<readonly [string, unknown]> = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (!isRecord(entry)) throw new Error(`execution.workerResources[${index}] must be an object`);
      const selection = normalizeActiveExecutor(entry.selection);
      if (!selection) throw new Error(`execution.workerResources[${index}].selection cannot be null`);
      const resourceId = typeof entry.resourceId === "string" && entry.resourceId.trim()
        ? entry.resourceId.trim()
        : executorEntryId(selection);
      rawEntries.push([resourceId, entry]);
    }
  } else {
    if (!isRecord(value)) throw new Error("execution.workerResources must be an object");
    rawEntries.push(...Object.entries(value));
  }
  const catalog: WorkerResourceCatalog = {};
  const selections = new Set<string>();
  for (const [resourceId, entry] of rawEntries) {
    validateConfiguredId(resourceId, "worker resource");
    if (Object.prototype.hasOwnProperty.call(catalog, resourceId)) {
      throw new Error(`worker resource id must be unique: ${resourceId}`);
    }
    if (!isRecord(entry)) throw new Error(`execution.workerResources.${resourceId} must be an object`);
    const selection = normalizeActiveExecutor(entry.selection);
    if (!selection) throw new Error(`execution.workerResources.${resourceId}.selection cannot be null`);
    const key = executorSelectionKey(selection);
    if (selections.has(key)) throw new Error(`duplicate worker resource selection: ${key}`);
    selections.add(key);
    defineOwnKey(catalog, resourceId, {
      selection,
      maxConcurrent: normalizeRequiredWorkerCount(entry.maxConcurrent, `execution.workerResources.${resourceId}.maxConcurrent`),
    });
  }
  return catalog;
}

function normalizeWorkerRoutes(value: unknown, catalog: WorkerResourceCatalog): WorkerRoutesConfig {
  if (!isRecord(value)) throw new Error("execution.routes must be an object");
  const normalizeRoute = (candidate: unknown, field: string): WorkerRouteEntry[] | undefined => {
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate)) throw new Error(`${field} must be an array`);
    const route = candidate.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object`);
      const resourceId = normalizeOptionalNonEmptyString(entry.resourceId, `${field}[${index}].resourceId`);
      if (!resourceId) throw new Error(`${field}[${index}].resourceId is required`);
      if (!Object.prototype.hasOwnProperty.call(catalog, resourceId)) {
        throw new Error(`${field}[${index}] references unknown worker resource ${resourceId}`);
      }
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

function cloneExternalAgentValue(value: ExternalAgentValue): ExternalAgentValue {
  return {
    ...value,
    args: value.args ? [...value.args] : undefined,
    env: value.env ? { ...value.env } : undefined,
    review: value.review ? {
      ...value.review,
      args: value.review.args ? [...value.review.args] : undefined,
      env: value.review.env ? { ...value.review.env } : undefined,
    } : undefined,
    execution: value.execution ? {
      ...value.execution,
      args: value.execution.args ? [...value.execution.args] : undefined,
      env: value.execution.env ? { ...value.execution.env } : undefined,
    } : undefined,
  };
}

export function cloneExternalAgentCatalog(catalog: ExternalAgentCatalog): ExternalAgentCatalog {
  const out: ExternalAgentCatalog = {};
  for (const [id, value] of Object.entries(catalog)) {
    defineOwnKey(out, id, cloneExternalAgentValue(value));
  }
  return out;
}

export function cloneWorkerCatalog(catalog: WorkerResourceCatalog): WorkerResourceCatalog {
  const out: WorkerResourceCatalog = {};
  for (const [resourceId, value] of Object.entries(catalog)) {
    defineOwnKey(out, resourceId, {
      selection: cloneExecutorSelection(value.selection),
      maxConcurrent: value.maxConcurrent,
    });
  }
  return out;
}

/** Deep clone of the scheduled-task catalog; no inherited global values are ever synthesized. */
export function cloneScheduledTaskCatalog(catalog: ScheduledTaskCatalog): ScheduledTaskCatalog {
  const out: ScheduledTaskCatalog = {};
  for (const [id, entry] of Object.entries(catalog)) {
    defineOwnKey(out, id, {
      ...entry,
      ...(entry.review !== undefined ? { review: cloneScheduledTaskReviewOverride(entry.review) } : {}),
    });
  }
  return out;
}

function cloneScheduledTaskReviewOverride(override: ScheduledTaskReviewOverride): ScheduledTaskReviewOverride {
  return override.mode === "off"
    ? { mode: "off" }
    : { mode: "selected", reviewers: override.reviewers.map((reviewer) => ({ ...reviewer })) };
}

/** Define an own data property even for keys like "__proto__" or "constructor". */
function defineOwnKey<K extends string>(target: Record<K, unknown>, key: K, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
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
