/**
 * The editable data boundary for REVIEW SETTINGS of another host (issue #716).
 *
 * The shared persisted settings editor is owned by the config's host, but its
 * menu can run anywhere. This module is the pure translation between that
 * menu and the owner, with no UI, transport, filesystem, session cache, or live
 * effect:
 *
 * - {@link projectRemoteReviewSettingsOpening} turns the owner's retained
 *   opening `ReviewGateConfig` into the menu-facing config. It projects ONLY
 *   the editable values and safe presentation metadata, never a worker
 *   command/argv/env, a config-resolution path, raw load diagnostics, unknown
 *   raw configuration keys, or an owner baseline. Legacy native argv is
 *   imported with the existing reasoning source of truth, so the menu sees the
 *   same typed effort / unresolved state and content-free counts without any
 *   token crossing the boundary.
 * - {@link encodeRemoteReviewSettingsSaveIntent} turns the client's internal
 *   staged Save into that closed editable intent. It carries only the values
 *   the menu can edit plus the external-worker operation lineage (never a
 *   baseline, owner path, image provenance, or private definition field).
 * - {@link decodeRemoteReviewSettingsSaveIntent} validates that untrusted
 *   intent against the OWNER-retained opening config and reconstructs the
 *   canonical `PersistedSaveSelection` and menu `draftConfig` the shared
 *   `preparePersistedSave`/`commitPersistedSave` backend consumes. Owner-held
 *   hidden env is reattached for surviving roles exactly like a native menu
 *   edit, owner opening ids derive every staged/opening baseline, optimistic
 *   external-worker reference baselines are recomputed from the owner's
 *   opening config, and explicit already-run edits are derived only over task
 *   ids the owner knew at open. No caller-supplied baseline, opening path, or
 *   image provenance is accepted.
 *
 * External-worker lineage is replayed through the shared staging helper: a
 * same-id re-creation is encoded as a deletion plus creation and composed back
 * on the owner, so no caller baseline or hidden-env flag is trusted.
 *
 * The intent is a closed schema: unknown fields at every level, forged private
 * definition fields (`command`/`args`/`env`/`protocol`), forged owner baselines,
 * unsupported adapter edits, and mismatched operation shapes are rejected.
 * Structural/category checks run first, then the canonical config normalizers
 * validate the assembled editable sections (external agents, workers/routes,
 * reviewers, web/browser permissions, tools, tool protection, scheduled
 * entries). Scheduled entries that the menu may still be completing (cron,
 * instructions, or workspace not entered yet) are structurally validated here
 * and left for the shared save-time validation, so the remote menu keeps its
 * existing "stay open with the exact error" behavior.
 */
import {
  BROWSER_PERMISSION_FIELDS,
  DEFAULT_CONFIG,
  DEFAULT_DEFERRED_PI_TOOLS,
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  cloneExternalAgentCatalog,
  cloneScheduledTaskCatalog,
  cloneWorkerCatalog,
  effectiveReviewEvidenceSettings,
  effectiveReviewSettings,
  executorEntryId,
  normalizeConfig,
  resolvedWorkerCatalog,
  type ActiveReviewerSelection,
  type BrowserInteractionApproval,
  type ExecutionRetryPolicy,
  type ExternalAgentCatalog,
  type ExternalAgentConfig,
  type ExternalAgentRoleConfig,
  type ExternalAgentValue,
  type OperatingMode,
  type RetainBundles,
  type ReviewEvidenceConfig,
  type ReviewGateConfig,
  type ReviewGateToolsConfig,
  type ScheduledTaskCatalog,
  type ScheduledTaskEntryConfig,
  type ScheduledTaskReviewOverride,
  type SubtaskNotificationMode,
  type ThinkingLevel,
  type WebBrowserPermissions,
  type WorkerResourceCatalog,
  type WorkerRouteEntry,
  type YouShouldKnowConfig,
} from "../config";
import type { HostKeybindingCheck } from "../host-keybindings";
import {
  importNativeReasoning,
  validateNativeReasoning,
  type NativeReasoningEffort,
  type ReasoningImport,
  type ReasoningImportPresentation,
  type ScopeReasoningImport,
} from "../external-agent-reasoning";
import { setCatalogKey } from "../settings/catalog-key";
import {
  captureExternalAgentReferenceBaseline,
  type ExternalAgentOperation,
  type ExternalAgentReferenceBaseline,
} from "../settings/external-agent-catalog";
import { EXTERNAL_AGENT_MODEL_CATALOG, type GuidedExternalAgentAdapter } from "../settings/external-agent-models";
import { nativeExternalAgentCommand } from "../settings/external-agents";
import type { ScopedModelChoice } from "../settings/models";
import type { PersistedSaveSelection, StagedPersistedSave } from "../settings/persisted-save";
import { stagedToolProtectionSettings } from "../settings/tool-protection";
import { withoutResourceThinkingCatalog } from "../settings/workers";
import { isToolProtectionDiscoveryLoaderExempt, type ToolProtectionConfig } from "../tool-protection/config";

/** Wire version of the projected opening and editable save intent. */
export const REMOTE_REVIEW_SETTINGS_DATA_VERSION = 1;

/** A rejected/undecodable remote settings payload (never a UI or save result). */
export class RemoteReviewSettingsDataError extends Error {
  constructor(message: string) {
    super(`review gate: remote review settings ${message}`);
    this.name = "RemoteReviewSettingsDataError";
  }
}

/** The owner opening projected for the existing menu. */
export interface RemoteReviewSettingsOpening {
  version: typeof REMOTE_REVIEW_SETTINGS_DATA_VERSION;
  /**
   * The menu-facing opening config. External-worker definitions carry only
   * editable values plus an optional presentation-only
   * `legacyReasoningImport`; hidden command/argv/env and role protocol are
   * omitted. Non-editable fields are safe defaults, never owner paths or raw
   * configuration. The menu treats this as its opening `ReviewGateConfig`;
   * pass it through unchanged — a canonical normalization of the whole config
   * would drop the presentation-only reasoning markers and the projected
   * definitions have no command by design.
   */
  config: ReviewGateConfig;
}

/** One editable external-worker role (presence expresses the role). */
export interface RemoteExternalAgentRoleIntent {
  model?: string;
  reasoningEffort?: NativeReasoningEffort;
  timeoutMs?: number;
  /**
   * This role was created in the client session (added, or removed and
   * re-added). It has no opening role, so the owner must not inherit that
   * opening role's private env or unresolved legacy argv.
   */
  fresh?: boolean;
  /**
   * The editor explicitly chose "Inherit shared reasoning" for this role.
   * This distinguishes an intentional no-typed-effort result from an
   * unresolved omission the native editor would still block.
   */
  inheritsReasoning?: boolean;
}

/** One editable external-worker definition; hidden fields are never accepted. */
export interface RemoteExternalAgentIntent {
  adapter: GuidedExternalAgentAdapter;
  model?: string;
  reasoningEffort?: NativeReasoningEffort;
  review?: RemoteExternalAgentRoleIntent;
  execution?: RemoteExternalAgentRoleIntent;
}

/**
 * One external-worker lineage step. `id`/`nextId`/definition mirror the internal
 * staged operation. There is deliberately no baseline (or `created`) field: the
 * owner derives an edit baseline from its own opening definition, and treats a
 * step whose current lineage definition is absent as a creation. A same-id
 * re-creation is encoded as an explicit deletion followed by its creation, so
 * the owner can reconstruct the native composed operation without any
 * client-supplied baseline.
 */
export interface RemoteExternalAgentOperationIntent {
  id: string;
  nextId?: string;
  definition?: RemoteExternalAgentIntent;
}

/**
 * The closed editable save intent. It is the menu-owned value set only:
 * required fields mirror what the shared menu always stages, `waveArtifactTtlMs`
 * is present only when Retention was explicitly edited, and no config path,
 * working directory, owner baseline, scoped-model inventory, image provenance,
 * live effect, or function can cross it.
 */
export interface RemoteReviewSettingsSaveIntent {
  version: typeof REMOTE_REVIEW_SETTINGS_DATA_VERSION;
  operatingMode: OperatingMode;
  modeCycleShortcut: string;
  workerResources: WorkerResourceCatalog;
  executeRoute: WorkerRouteEntry[];
  researchRoute: WorkerRouteEntry[];
  primaryReviewers: ActiveReviewerSelection[];
  subtaskReviewers: ActiveReviewerSelection[];
  primaryEnabled: boolean;
  subtaskEnabled: boolean;
  reviewLandedChanges: boolean;
  evidence: ReviewEvidenceConfig;
  reviewerTimeoutMs: number;
  executorTimeoutMs: number;
  maxCorrectionCycles: number;
  implementationGuidanceAfterCorrectionAttempts: number;
  retainBundles: RetainBundles;
  waveArtifactTtlMs?: number;
  deleteSpawnedPiSessionsOnCleanup: boolean;
  maxWorkers: number;
  retryPolicy: ExecutionRetryPolicy;
  subtaskNotifications: SubtaskNotificationMode;
  deferredPiTools: boolean;
  subtasksViewExpanded: boolean;
  showSubtaskTaskIds: boolean;
  scheduledTasks: ScheduledTaskCatalog;
  scheduledTasksAlreadyRunEdited: string[];
  externalAgents: RemoteExternalAgentOperationIntent[];
  webMaxDownloadBytes: number;
  browserInteractionApproval: BrowserInteractionApproval;
  browserIdleExpiryMinutes: number;
  browserDownloadRetention: number;
  browserVisible: boolean;
  webBrowserPermissions: WebBrowserPermissions;
  webUrlBlocklist: string[];
  youShouldKnow: YouShouldKnowConfig;
  tools: Required<Pick<ReviewGateToolsConfig, "topLevelDeny" | "executorDeny">>;
  toolProtection: ToolProtectionConfig;
}

/** The owner-side reconstruction the shared persisted-save backend consumes. */
export interface RemoteReviewSettingsDecodedSave {
  /** The canonical staged selection, with owner-held baselines restored. */
  selection: PersistedSaveSelection;
  /** The menu-local draft config carrying the staged cascade/values. */
  draftConfig: ReviewGateConfig;
}

/** One projected external-worker role, plus legacy-argv presentation metadata. */
type ProjectedRole = ExternalAgentRoleConfig & { legacyReasoningImport?: ReasoningImportPresentation };
/** One projected external-worker definition (never command/argv/env/protocol). */
type ProjectedAgentValue = ExternalAgentValue & {
  legacyReasoningImport?: ReasoningImportPresentation;
  review?: ProjectedRole;
  execution?: ProjectedRole;
};

/** See the module comment: editable data only, with safe metadata. */
export function projectRemoteReviewSettingsOpening(config: ReviewGateConfig): RemoteReviewSettingsOpening {
  const review = effectiveReviewSettings(config);
  const evidence = effectiveReviewEvidenceSettings(config);
  const execution = config.execution;
  const web = config.web;
  const ui = config.ui;
  const youShouldKnow = config.youShouldKnow ?? DEFAULT_CONFIG.youShouldKnow!;
  const tools = config.tools ?? {};
  const protection = stagedToolProtectionSettings(config);
  const defaults = DEFAULT_CONFIG.web!;
  const projected: ReviewGateConfig = {
    enabled: config.enabled,
    operatingMode: config.operatingMode,
    modeCycleShortcut: config.modeCycleShortcut,
    reviewerTimeoutMs: config.reviewerTimeoutMs,
    executorTimeoutMs: config.executorTimeoutMs,
    maxCorrectionCycles: config.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: config.implementationGuidanceAfterCorrectionAttempts,
    // Non-editable fields are safe defaults, never owner paths or raw settings.
    maxPatchBytes: DEFAULT_CONFIG.maxPatchBytes,
    maxFileBytes: DEFAULT_CONFIG.maxFileBytes,
    maxSnapshotBytes: DEFAULT_CONFIG.maxSnapshotBytes,
    waveArtifactTtlMs: config.waveArtifactTtlMs ?? DEFAULT_CONFIG.waveArtifactTtlMs,
    retainBundles: config.retainBundles,
    deleteSpawnedPiSessionsOnCleanup: config.deleteSpawnedPiSessionsOnCleanup === true,
    review: {
      primaryReviewers: review.primaryReviewers.map(cloneReviewer),
      subtaskReviewers: review.subtaskReviewers.map(cloneReviewer),
      primaryEnabled: review.primaryEnabled,
      subtaskEnabled: review.subtaskEnabled,
      reviewLandedChanges: review.reviewLandedChanges,
      evidence: cloneEvidence(evidence),
    },
    externalAgents: projectExternalAgents(config.externalAgents ?? {}),
    execution: {
      // Match the menu's opening pool exactly: resource-level Pi thinking is a
      // presentation of the route entry, not a second persisted value.
      workerResources: withoutResourceThinkingCatalog(resolvedWorkerCatalog(config)),
      routes: {
        execute: (execution?.routes?.execute ?? []).map(cloneRouteEntry),
        research: (execution?.routes?.research ?? []).map(cloneRouteEntry),
      },
      maxWorkers: execution?.maxWorkers ?? DEFAULT_MAX_WORKERS,
      retryPolicy: cloneRetryPolicy(execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY),
      subtaskNotifications: execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE,
      deferredPiTools: execution?.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS,
    },
    scheduledTasks: projectScheduledTasks(config.scheduledTasks ?? {}),
    ui: {
      subtasksViewExpanded: ui?.subtasksViewExpanded === true,
      showSubtaskTaskIds: ui?.showSubtaskTaskIds === true,
    },
    youShouldKnow: { enabled: youShouldKnow.enabled, completionGuidance: youShouldKnow.completionGuidance },
    tools: {
      topLevelDeny: [...(tools.topLevelDeny ?? [])],
      executorDeny: [...(tools.executorDeny ?? [])],
    },
    toolProtection: {
      level: protection.level,
      auditor: protection.auditor === null ? null : cloneReviewer(protection.auditor),
      scope: protection.scope,
      toolNames: [...protection.toolNames],
      timeoutMs: protection.timeoutMs,
      maxContextChars: protection.maxContextChars,
      retainAuditorSessions: protection.retainAuditorSessions,
      debug: protection.debug,
    },
    web: {
      enabled: defaults.enabled,
      browserInteractionApproval: web?.browserInteractionApproval ?? defaults.browserInteractionApproval,
      browserIdleExpiryMinutes: web?.browserIdleExpiryMinutes ?? defaults.browserIdleExpiryMinutes,
      browserDownloadRetention: web?.browserDownloadRetention ?? defaults.browserDownloadRetention,
      browserVisible: web?.browserVisible ?? defaults.browserVisible,
      browserPermissions: projectBrowserPermissions(web?.browserPermissions),
      urlBlocklist: [...(web?.urlBlocklist ?? [])],
      search: { ...defaults.search },
      fetch: {
        ...defaults.fetch,
        maxDownloadBytes: web?.fetch?.maxDownloadBytes ?? defaults.fetch.maxDownloadBytes,
      },
    },
  };
  return { version: REMOTE_REVIEW_SETTINGS_DATA_VERSION, config: projected };
}

function projectExternalAgents(catalog: ExternalAgentCatalog): ExternalAgentCatalog {
  const projected: Record<string, ProjectedAgentValue> = {};
  for (const [id, value] of Object.entries(catalog)) setCatalogKey(projected, id, projectExternalAgent(value));
  return projected;
}

/**
 * Project one definition for the editor. The guided native adapters import
 * their legacy argv through the shared reasoning parser so the menu sees the
 * same typed effort, unresolved flags, counts, and warning codes; the tokens
 * themselves never leave the owner. Unsupported adapters stay visible with
 * their adapter/roles but no command or protocol, which the menu already
 * presents as Delete/Back only.
 */
function projectExternalAgent(value: ExternalAgentValue): ProjectedAgentValue {
  const imported = isGuidedAdapter(value.adapter)
    ? importNativeReasoning(value.adapter, { ...value, id: "" } as ExternalAgentConfig)
    : [];
  const byLocation = new Map(imported.map((entry) => [entry.location, entry] as const));
  const projected: ProjectedAgentValue = {
    adapter: value.adapter,
    ...(value.model !== undefined ? { model: value.model } : {}),
  };
  applyReasoningPresentation(projected, byLocation.get("shared"));
  if (value.review !== undefined) projected.review = projectRole(value.review, byLocation.get("review"));
  if (value.execution !== undefined) projected.execution = projectRole(value.execution, byLocation.get("execution"));
  return projected;
}

function projectRole(value: ExternalAgentRoleConfig, presentation: ScopeReasoningImport | undefined): ProjectedRole {
  const projected: ProjectedRole = {
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
  };
  applyReasoningPresentation(projected, presentation);
  return projected;
}

/**
 * Carry the menu-visible reasoning semantics without any argv token: a
 * recognized effort becomes the typed value the editor imports, while
 * unresolved state and content-free counts/codes travel as presentation
 * metadata. `importNativeReasoning` reads that metadata for a projected scope.
 */
function applyReasoningPresentation(
  target: { reasoningEffort?: NativeReasoningEffort; legacyReasoningImport?: ReasoningImportPresentation },
  presentation: ScopeReasoningImport | undefined,
): void {
  if (presentation === undefined) return;
  if (presentation.reasoning.kind === "value" || presentation.reasoning.kind === "structured") {
    target.reasoningEffort = presentation.reasoning.value;
  }
  if (
    presentation.reasoning.kind === "unresolved"
    || presentation.recognizedSettingCount > 0
    || presentation.droppedOtherTokenCount > 0
    || presentation.warnings.length > 0
  ) {
    target.legacyReasoningImport = {
      // A structured typed effort is already carried by reasoningEffort; the
      // marker is present only for the content-free counts/warnings, and
      // importNativeReasoning keeps the typed value authoritative.
      reasoning: presentation.reasoning.kind === "structured" ? { kind: "absent" } : cloneReasoningImport(presentation.reasoning),
      recognizedSettingCount: presentation.recognizedSettingCount,
      droppedOtherTokenCount: presentation.droppedOtherTokenCount,
      warnings: [...presentation.warnings],
    };
  }
}

function projectScheduledTasks(catalog: ScheduledTaskCatalog): ScheduledTaskCatalog {
  const projected: ScheduledTaskCatalog = {};
  for (const [id, entry] of Object.entries(catalog)) setCatalogKey(projected, id, projectScheduledTask(entry));
  return projected;
}

/** Known editable entry fields only; no raw unknown key is forwarded. */
function projectScheduledTask(entry: ScheduledTaskEntryConfig): ScheduledTaskEntryConfig {
  return {
    name: entry.name,
    cron: entry.cron,
    enabled: entry.enabled,
    kind: entry.kind,
    ...(entry.destination !== undefined ? { destination: entry.destination } : {}),
    instructions: entry.instructions,
    workspace: entry.workspace ?? "",
    ...(entry.workerResourceId !== undefined ? { workerResourceId: entry.workerResourceId } : {}),
    ...(entry.review !== undefined ? { review: cloneScheduledReview(entry.review) } : {}),
    ...(entry.oneShot === true ? { oneShot: true } : {}),
    ...(entry.alreadyRun === true ? { alreadyRun: true } : {}),
  };
}

function projectBrowserPermissions(value: WebBrowserPermissions | undefined): WebBrowserPermissions {
  const projected = {} as WebBrowserPermissions;
  for (const field of BROWSER_PERMISSION_FIELDS) projected[field] = value?.[field] === true;
  return projected;
}

/**
 * Encode the client's internal staged Save as the closed editable intent.
 * This is the only direction that sees the staged payload, and it deliberately
 * maps just the menu-owned values. Image provenance is refused rather than
 * silently dropped: an attached native image has no remote representation, so
 * a save that contains one fails closed instead of persisting an unverified
 * temporary path.
 */
export function encodeRemoteReviewSettingsSaveIntent(staged: StagedPersistedSave): RemoteReviewSettingsSaveIntent {
  if (staged.scheduledImageProvenance.size > 0) {
    fail("cannot be saved remotely: scheduled-task image attachments are not transferable");
  }
  const selection = staged.selection;
  if (selection.externalAgentAdditions !== undefined && Object.keys(selection.externalAgentAdditions).length > 0) {
    fail("cannot be saved remotely: external-worker additions must be staged as editable lineage steps");
  }
  const tools = required(selection.tools, "staged tool denials");
  const protection = required(selection.toolProtection, "staged tool protection");
  const externalAgents = (selection.externalAgentOperations ?? []).flatMap(encodeExternalAgentOperations);
  const intent: RemoteReviewSettingsSaveIntent = {
    version: REMOTE_REVIEW_SETTINGS_DATA_VERSION,
    operatingMode: selection.operatingMode,
    modeCycleShortcut: selection.modeCycleShortcut,
    workerResources: withoutResourceThinkingCatalog(cloneWorkerCatalog(selection.workerResources)),
    executeRoute: required(selection.executeRoute, "staged execute priorities").map(cloneRouteEntry),
    researchRoute: required(selection.researchRoute, "staged research priorities").map(cloneRouteEntry),
    primaryReviewers: selection.primaryReviewers.map(cloneReviewer),
    subtaskReviewers: selection.subtaskReviewers.map(cloneReviewer),
    primaryEnabled: selection.primaryEnabled,
    subtaskEnabled: selection.subtaskEnabled,
    reviewLandedChanges: selection.reviewLandedChanges,
    evidence: cloneEvidence(required(selection.evidence, "staged review evidence")),
    reviewerTimeoutMs: selection.reviewerTimeoutMs,
    executorTimeoutMs: selection.executorTimeoutMs,
    maxCorrectionCycles: selection.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: selection.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: selection.retainBundles,
    ...(selection.waveArtifactTtlMs !== undefined ? { waveArtifactTtlMs: selection.waveArtifactTtlMs } : {}),
    deleteSpawnedPiSessionsOnCleanup: required(selection.deleteSpawnedPiSessionsOnCleanup, "staged spawned-session cleanup"),
    maxWorkers: selection.maxWorkers,
    retryPolicy: cloneRetryPolicy(selection.retryPolicy),
    subtaskNotifications: selection.subtaskNotifications,
    deferredPiTools: required(selection.deferredPiTools, "staged deferred Pi tools"),
    subtasksViewExpanded: selection.subtasksViewExpanded,
    showSubtaskTaskIds: required(selection.showSubtaskTaskIds, "staged subtask id display"),
    scheduledTasks: projectScheduledTasks(required(selection.scheduledTasks, "staged scheduled tasks")),
    scheduledTasksAlreadyRunEdited: [...(selection.scheduledTasksAlreadyRunEdited ?? [])],
    externalAgents,
    webMaxDownloadBytes: required(selection.webMaxDownloadBytes, "staged web download size"),
    browserInteractionApproval: required(selection.browserInteractionApproval, "staged browser interaction approval"),
    browserIdleExpiryMinutes: required(selection.browserIdleExpiryMinutes, "staged browser idle expiry"),
    browserDownloadRetention: required(selection.browserDownloadRetention, "staged browser download retention"),
    browserVisible: required(selection.browserVisible, "staged browser visibility"),
    webBrowserPermissions: projectBrowserPermissions(required(selection.webBrowserPermissions, "staged browser permissions")),
    webUrlBlocklist: [...required(selection.webUrlBlocklist, "staged URL blocklist")],
    youShouldKnow: cloneYouShouldKnow(required(selection.youShouldKnow, "staged YouShouldKnow settings")),
    tools: {
      topLevelDeny: [...(tools.topLevelDeny ?? [])],
      executorDeny: [...(tools.executorDeny ?? [])],
    },
    toolProtection: {
      level: protection.level,
      auditor: protection.auditor === null ? null : cloneReviewer(protection.auditor),
      scope: protection.scope,
      toolNames: [...protection.toolNames],
      timeoutMs: protection.timeoutMs,
      maxContextChars: protection.maxContextChars,
      retainAuditorSessions: protection.retainAuditorSessions,
      debug: protection.debug,
    },
  };
  return structuredClone(intent);
}

/**
 * Map one internal operation to editable lineage steps. A net create-then-delete
 * (baseline-less no-op) disappears. A same-id re-creation is emitted as the
 * deletion it staged plus a creation, so the owner reconstructs the opening
 * baseline and the fresh definition without trusting a hidden-private-field
 * flag. Creations that were then renamed keep their creation lineage.
 */
function encodeExternalAgentOperations(operation: ExternalAgentOperation): RemoteExternalAgentOperationIntent[] {
  if (operation.definition === undefined) {
    if (operation.nextId !== undefined) fail("cannot encode an external-worker step with a destination but no definition");
    if (operation.baseline === undefined) return [];
    return [{ id: operation.id }];
  }
  if (operation.nextId === undefined) fail("cannot encode an external-worker definition without a destination id");
  if (!isGuidedAdapter(operation.definition.adapter)) fail("cannot encode an edit of an unsupported external-worker adapter");
  const definition = encodeExternalAgentDefinition(operation.definition);
  if (operation.baseline === undefined) {
    return [{ id: operation.id, nextId: operation.nextId, definition }];
  }
  if (operation.createdInTransaction === true) {
    return [
      { id: operation.id },
      { id: operation.id, nextId: operation.nextId, definition },
    ];
  }
  return [{ id: operation.id, nextId: operation.nextId, definition }];
}

function encodeExternalAgentDefinition(definition: ExternalAgentValue): RemoteExternalAgentIntent {
  return {
    adapter: definition.adapter as GuidedExternalAgentAdapter,
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.reasoningEffort !== undefined ? { reasoningEffort: definition.reasoningEffort } : {}),
    ...(definition.review !== undefined ? { review: encodeRole(definition.review) } : {}),
    ...(definition.execution !== undefined ? { execution: encodeRole(definition.execution) } : {}),
  };
}

function encodeRole(role: ExternalAgentRoleConfig): RemoteExternalAgentRoleIntent {
  const presented = role as ExternalAgentRoleConfig & { legacyReasoningInherited?: boolean; roleCreatedInSession?: boolean };
  return {
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.reasoningEffort !== undefined ? { reasoningEffort: role.reasoningEffort } : {}),
    ...(role.timeoutMs !== undefined ? { timeoutMs: role.timeoutMs } : {}),
    ...(presented.roleCreatedInSession === true ? { fresh: true } : {}),
    ...(presented.legacyReasoningInherited === true ? { inheritsReasoning: true } : {}),
  };
}

/**
 * Validate an untrusted save intent against the owner's retained opening and
 * reconstruct the canonical save inputs. Owner-held values are derived here,
 * always on the destination: external-worker baselines come from the opening
 * definitions, reference baselines are recomputed by the shared capture rule,
 * staged-from ids are the owner opening's task ids, and hidden env is
 * reattached to surviving roles like the native edit dialog. `offeredPiModels`
 * and `offeredToolNames` are trusted owner/menu inventories used only for
 * membership checks; they are never read from the intent.
 */
export function decodeRemoteReviewSettingsSaveIntent(
  value: unknown,
  opening: ReviewGateConfig,
  offeredPiModels: readonly Pick<ScopedModelChoice, "model" | "supportedThinkingLevels">[] = [],
  offeredToolNames: { deny?: readonly string[]; audit?: readonly string[] } = {},
  /**
   * Trusted owner host-key occupancy predicate (normally
   * `findOccupiedHostBindings` from src/host-keybindings.ts). Consulted only
   * when the save changes the opening shortcut; an identical opening value is
   * retained without host inspection.
   */
  hostKeyOccupancy?: (shortcut: string) => HostKeybindingCheck,
): RemoteReviewSettingsDecodedSave {
  const intent = closedRecord(value, "save intent", INTENT_FIELDS);
  if (intent.version !== REMOTE_REVIEW_SETTINGS_DATA_VERSION) {
    fail(`save intent has an unsupported version`);
  }

  // Scalars: the shared normalizer owns their canonical grammar/ranges.
  const waveArtifactTtlMs = intent.waveArtifactTtlMs;
  const scalars = canonical("scalar settings", () => normalizeConfig({
    operatingMode: requiredValue(intent.operatingMode, "operatingMode"),
    modeCycleShortcut: requiredValue(intent.modeCycleShortcut, "modeCycleShortcut"),
    reviewerTimeoutMs: requiredValue(intent.reviewerTimeoutMs, "reviewerTimeoutMs"),
    executorTimeoutMs: requiredValue(intent.executorTimeoutMs, "executorTimeoutMs"),
    maxCorrectionCycles: requiredValue(intent.maxCorrectionCycles, "maxCorrectionCycles"),
    implementationGuidanceAfterCorrectionAttempts: requiredValue(intent.implementationGuidanceAfterCorrectionAttempts, "implementationGuidanceAfterCorrectionAttempts"),
    retainBundles: requiredValue(intent.retainBundles, "retainBundles"),
    deleteSpawnedPiSessionsOnCleanup: requiredValue(intent.deleteSpawnedPiSessionsOnCleanup, "deleteSpawnedPiSessionsOnCleanup"),
    ...(waveArtifactTtlMs !== undefined ? { waveArtifactTtlMs } : {}),
  }));
  assertEditableModeCycleShortcut(opening, scalars.modeCycleShortcut, hostKeyOccupancy);

  // Review layers and evidence.
  const review = canonical("review settings", () => normalizeConfig({
    review: {
      primaryReviewers: readReviewers(requiredValue(intent.primaryReviewers, "primaryReviewers"), "primaryReviewers"),
      subtaskReviewers: readReviewers(requiredValue(intent.subtaskReviewers, "subtaskReviewers"), "subtaskReviewers"),
      primaryEnabled: requiredValue(intent.primaryEnabled, "primaryEnabled"),
      subtaskEnabled: requiredValue(intent.subtaskEnabled, "subtaskEnabled"),
      reviewLandedChanges: requiredValue(intent.reviewLandedChanges, "reviewLandedChanges"),
      evidence: readEvidence(requiredValue(intent.evidence, "evidence")),
    },
  }).review!);

  // Workers and routes.
  const execution = canonical("execution settings", () => normalizeConfig({
    execution: {
      workerResources: readWorkerResources(requiredValue(intent.workerResources, "workerResources"), resolvedWorkerCatalog(opening)),
      routes: {
        execute: readRoutes(requiredValue(intent.executeRoute, "executeRoute"), "executeRoute"),
        research: readRoutes(requiredValue(intent.researchRoute, "researchRoute"), "researchRoute"),
      },
      maxWorkers: requiredValue(intent.maxWorkers, "maxWorkers"),
      retryPolicy: readRetryPolicy(requiredValue(intent.retryPolicy, "retryPolicy")),
      subtaskNotifications: requiredValue(intent.subtaskNotifications, "subtaskNotifications"),
      deferredPiTools: requiredValue(intent.deferredPiTools, "deferredPiTools"),
    },
  }).execution!);

  // Web/browser and the remaining top-level editable blocks.
  const web = canonical("web settings", () => normalizeConfig({
    web: {
      browserInteractionApproval: requiredValue(intent.browserInteractionApproval, "browserInteractionApproval"),
      browserIdleExpiryMinutes: requiredValue(intent.browserIdleExpiryMinutes, "browserIdleExpiryMinutes"),
      browserDownloadRetention: requiredValue(intent.browserDownloadRetention, "browserDownloadRetention"),
      browserVisible: requiredValue(intent.browserVisible, "browserVisible"),
      browserPermissions: readBrowserPermissions(requiredValue(intent.webBrowserPermissions, "webBrowserPermissions")),
      urlBlocklist: readStringArray(requiredValue(intent.webUrlBlocklist, "webUrlBlocklist"), "webUrlBlocklist"),
      fetch: { maxDownloadBytes: requiredValue(intent.webMaxDownloadBytes, "webMaxDownloadBytes") },
    },
  }).web!);
  assertEditableWebDownloadCap(opening, web.fetch.maxDownloadBytes);
  const ui = canonical("display settings", () => normalizeConfig({
    ui: {
      subtasksViewExpanded: requiredValue(intent.subtasksViewExpanded, "subtasksViewExpanded"),
      showSubtaskTaskIds: requiredValue(intent.showSubtaskTaskIds, "showSubtaskTaskIds"),
    },
  }).ui!);
  const youShouldKnow = canonical("YouShouldKnow settings", () => normalizeConfig({
    youShouldKnow: readYouShouldKnow(requiredValue(intent.youShouldKnow, "youShouldKnow")),
  }).youShouldKnow!);
  const tools = canonical("tool denial settings", () => normalizeConfig({
    tools: readTools(requiredValue(intent.tools, "tools")),
  }).tools!);
  const toolProtection = canonical("tool protection settings", () => normalizeConfig({
    toolProtection: readToolProtection(requiredValue(intent.toolProtection, "toolProtection")),
  }).toolProtection!);
  assertEditablePiAuditor(opening, toolProtection.auditor, offeredPiModels);
  assertEditableToolNames("tools.topLevelDeny", tools.topLevelDeny ?? [], opening.tools?.topLevelDeny ?? [], offeredToolNames.deny ?? []);
  assertEditableToolNames("tools.executorDeny", tools.executorDeny ?? [], opening.tools?.executorDeny ?? [], offeredToolNames.deny ?? []);
  const openingAuditNames = stagedToolProtectionSettings(opening).toolNames;
  assertEditableToolNames(
    "toolProtection.toolNames",
    toolProtection.toolNames,
    openingAuditNames,
    (offeredToolNames.audit ?? []).filter((name) => !isToolProtectionDiscoveryLoaderExempt(name)),
  );
  // The reserved loader row is informational; the picker never toggles it.
  // Preserve legacy membership because a non-owned tool using that name is
  // still subject to the selected-name check at runtime.
  if (openingAuditNames.some((name) => isToolProtectionDiscoveryLoaderExempt(name) && !toolProtection.toolNames.includes(name))) {
    fail("toolProtection.toolNames must retain the opening discovery loader name");
  }
  // The native picker refuses to remove the last auditable name. Switching
  // to All calls preserves the subset, so it cannot be used to clear that
  // last name either. An unchanged legacy loader-only opening remains
  // representable.
  if (openingAuditNames.some((name) => !isToolProtectionDiscoveryLoaderExempt(name))
    && toolProtection.toolNames.every(isToolProtectionDiscoveryLoaderExempt)) {
    fail("toolProtection.toolNames must retain at least one auditable name");
  }

  // Scheduled tasks: structure/type validation here; incomplete menu entries
  // stay for the shared save-time validation (which reports the exact user
  // error and keeps the menu open), exactly as a local menu Save does.
  const openingScheduledTasks = opening.scheduledTasks ?? {};
  const knownTaskIds = new Set(Object.keys(openingScheduledTasks));
  const scheduledTasks = readScheduledTasks(requiredValue(intent.scheduledTasks, "scheduledTasks"), openingScheduledTasks);
  const alreadyRunEdited = [...new Set(readStringArray(requiredValue(intent.scheduledTasksAlreadyRunEdited, "scheduledTasksAlreadyRunEdited"), "scheduledTasksAlreadyRunEdited"))]
    .filter((id) => knownTaskIds.has(id));

  // External-worker lineage is replayed over the owner opening. Baselines are
  // derived by the shared staging rule from the owner's own definitions and
  // the operation order, never accepted from the payload.
  const external = replayExternalAgentOperations(
    opening,
    readExternalAgentOperations(requiredValue(intent.externalAgents, "externalAgents")),
  );

  const draftConfig: ReviewGateConfig = {
    ...structuredClone(opening),
    operatingMode: scalars.operatingMode,
    modeCycleShortcut: scalars.modeCycleShortcut,
    reviewerTimeoutMs: scalars.reviewerTimeoutMs,
    executorTimeoutMs: scalars.executorTimeoutMs,
    maxCorrectionCycles: scalars.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: scalars.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: scalars.retainBundles,
    ...(waveArtifactTtlMs !== undefined ? { waveArtifactTtlMs: scalars.waveArtifactTtlMs } : {}),
    deleteSpawnedPiSessionsOnCleanup: scalars.deleteSpawnedPiSessionsOnCleanup,
    review: {
      primaryReviewers: review.primaryReviewers!.map(cloneReviewer),
      subtaskReviewers: review.subtaskReviewers!.map(cloneReviewer),
      primaryEnabled: review.primaryEnabled!,
      subtaskEnabled: review.subtaskEnabled!,
      reviewLandedChanges: review.reviewLandedChanges!,
      evidence: cloneEvidence(review.evidence!),
    },
    externalAgents: external.catalog,
    execution: { ...structuredClone(opening.execution ?? {}), ...execution },
    scheduledTasks: cloneScheduledTaskCatalog(scheduledTasks),
    ui: { ...structuredClone(opening.ui ?? {}), ...ui },
    youShouldKnow: { ...youShouldKnow },
    tools: {
      topLevelDeny: [...(tools.topLevelDeny ?? [])],
      executorDeny: [...(tools.executorDeny ?? [])],
    },
    toolProtection: cloneToolProtection(toolProtection),
    web: mergeEditableWeb(opening.web, web),
  };

  const selection: PersistedSaveSelection = {
    operatingMode: draftConfig.operatingMode,
    modeCycleShortcut: draftConfig.modeCycleShortcut,
    workerResources: cloneWorkerCatalog(execution.workerResources!),
    executeRoute: (execution.routes?.execute ?? []).map(cloneRouteEntry),
    researchRoute: (execution.routes?.research ?? []).map(cloneRouteEntry),
    primaryReviewers: review.primaryReviewers!.map(cloneReviewer),
    subtaskReviewers: review.subtaskReviewers!.map(cloneReviewer),
    primaryEnabled: review.primaryEnabled!,
    subtaskEnabled: review.subtaskEnabled!,
    reviewLandedChanges: review.reviewLandedChanges!,
    evidence: cloneEvidence(review.evidence!),
    reviewerTimeoutMs: scalars.reviewerTimeoutMs,
    executorTimeoutMs: scalars.executorTimeoutMs,
    maxCorrectionCycles: scalars.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: scalars.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: scalars.retainBundles,
    ...(waveArtifactTtlMs !== undefined ? { waveArtifactTtlMs: scalars.waveArtifactTtlMs } : {}),
    deleteSpawnedPiSessionsOnCleanup: scalars.deleteSpawnedPiSessionsOnCleanup,
    maxWorkers: execution.maxWorkers!,
    retryPolicy: cloneRetryPolicy(execution.retryPolicy!),
    subtaskNotifications: execution.subtaskNotifications!,
    deferredPiTools: execution.deferredPiTools,
    subtasksViewExpanded: ui.subtasksViewExpanded!,
    showSubtaskTaskIds: ui.showSubtaskTaskIds!,
    scheduledTasks: cloneScheduledTaskCatalog(scheduledTasks),
    scheduledTasksStagedFrom: [...knownTaskIds],
    scheduledTasksAlreadyRunEdited: alreadyRunEdited,
    externalAgentOperations: external.operations,
    externalAgentOpening: structuredClone(opening),
    externalAgentReferenceBaselines: external.referenceBaselines,
    webMaxDownloadBytes: web.fetch.maxDownloadBytes,
    browserInteractionApproval: web.browserInteractionApproval,
    browserIdleExpiryMinutes: web.browserIdleExpiryMinutes,
    browserDownloadRetention: web.browserDownloadRetention,
    browserVisible: web.browserVisible,
    webBrowserPermissions: projectBrowserPermissions(web.browserPermissions),
    webUrlBlocklist: [...web.urlBlocklist],
    youShouldKnow: { ...youShouldKnow },
    tools: {
      topLevelDeny: [...(tools.topLevelDeny ?? [])],
      executorDeny: [...(tools.executorDeny ?? [])],
    },
    toolProtection: cloneToolProtection(toolProtection),
  };
  return { selection, draftConfig };
}

/**
 * Tool-name lists are exact-name sets, but the native pickers only allow names
 * from their own inventory or names already retained from the opening list.
 * Each picker retains its own opening names, so a top-level name cannot be
 * added to the executor list merely because it was retained elsewhere. The
 * exempt discovery loader is never a new audit choice (a retained opening name
 * is preserved separately by the audit-list guard).
 */
function assertEditableToolNames(
  field: string,
  names: readonly string[],
  retained: readonly string[],
  offered: readonly string[],
): void {
  const allowed = new Set([...retained, ...offered]);
  if (names.some((name) => !allowed.has(name))) {
    fail(`${field} contains a name the editor does not offer`);
  }
}

interface ReplayedExternalAgents {
  operations: ExternalAgentOperation[];
  catalog: ExternalAgentCatalog;
  referenceBaselines: Record<string, ExternalAgentReferenceBaseline>;
}

/**
 * The Web menu edits the maximum download as a whole number of MiB from 1
 * through 2048 (src/settings/web.ts), while an unchanged opening value is
 * retained even when it predates that editable range or is not MiB-aligned.
 */
const MEBIBYTE_BYTES = 1024 * 1024;
const MIN_WEB_DOWNLOAD_MIB = 1;
const MAX_WEB_DOWNLOAD_MIB = 2_048;

function assertEditableWebDownloadCap(opening: ReviewGateConfig, bytes: number): void {
  if (bytes === opening.web?.fetch?.maxDownloadBytes) return;
  const mebibytes = bytes / MEBIBYTE_BYTES;
  if (!Number.isSafeInteger(mebibytes) || mebibytes < MIN_WEB_DOWNLOAD_MIB || mebibytes > MAX_WEB_DOWNLOAD_MIB) {
    fail("webMaxDownloadBytes must be a whole number of MiB from 1 through 2048 when changed");
  }
}

/**
 * The mode-cycle editor refuses a changed shortcut that Pi's live host
 * resolution reports as a built-in binding. That inspection is a host
 * dependency, supplied by the owner; an unchanged opening value is retained
 * even when the host cannot inspect bindings or reports a collision.
 */
function assertEditableModeCycleShortcut(
  opening: ReviewGateConfig,
  shortcut: string,
  hostKeyOccupancy: ((shortcut: string) => HostKeybindingCheck) | undefined,
): void {
  if (shortcut === opening.modeCycleShortcut) return;
  if (hostKeyOccupancy === undefined) {
    fail("modeCycleShortcut changed without the owner host-key occupancy check");
  }
  let occupancy: HostKeybindingCheck;
  try {
    occupancy = hostKeyOccupancy(shortcut);
  } catch {
    fail("modeCycleShortcut host-key occupancy could not be verified");
  }
  if (occupancy.resolved && occupancy.bindings.length > 0) {
    fail(`modeCycleShortcut is also used by built-in Pi binding(s) (${occupancy.bindings.join(", ")})`);
  }
}

/**
 * A new Pi auditor must be one the auditor picker can offer: a scoped model
 * (with a supported reasoning level) or an opening worker-resource pin (which
 * the picker offers unavailable-but-real with no reasoning level). An unchanged
 * opening auditor is always retained, including an out-of-scope selection. The
 * scoped inventory is a trusted owner/menu input, never read from the intent.
 */
function assertEditablePiAuditor(
  opening: ReviewGateConfig,
  auditor: ToolProtectionConfig["auditor"],
  offeredPiModels: readonly Pick<ScopedModelChoice, "model" | "supportedThinkingLevels">[],
): void {
  if (auditor?.source !== "pi") return;
  const previous = stagedToolProtectionSettings(opening).auditor;
  const retained = previous?.source === "pi"
    && previous.model === auditor.model
    && previous.thinkingLevel === auditor.thinkingLevel;
  const offered = offeredPiModels.find((model) => model.model === auditor.model);
  const pinned = Object.values(resolvedWorkerCatalog(opening)).some(({ selection }) =>
    selection.source === "pi" && selection.model === auditor.model);
  const editable = offered !== undefined
    ? auditor.thinkingLevel === undefined || offered.supportedThinkingLevels.includes(auditor.thinkingLevel)
    : pinned && auditor.thinkingLevel === undefined;
  if (!retained && !editable) fail("toolProtection.auditor is not a Pi choice the editor offers");
}

/**
 * The native editor only offers its curated catalog models plus the current
 * (owner-held "Keep current") value for a surviving scope. A raw intent may not
 * invent an arbitrary model for a creation or a fresh role; the current value
 * is only applicable to an edit/rename of the opening definition.
 */
function assertEditableNativeModels(
  field: string,
  intent: RemoteExternalAgentIntent,
  source: ExternalAgentValue | undefined,
): void {
  // Switching adapters in the editor retains models picked before the switch.
  const catalogModels = new Set<string>();
  for (const catalog of Object.values(EXTERNAL_AGENT_MODEL_CATALOG)) {
    for (const model of catalog.models) catalogModels.add(model.value);
  }
  const check = (location: string, model: string | undefined, keepCurrent: string | undefined): void => {
    if (model === undefined || catalogModels.has(model) || model === keepCurrent) return;
    fail(`${field} ${location} uses a model the editor does not offer`);
  };
  check("shared", intent.model, source?.model);
  for (const location of ["review", "execution"] as const) {
    const role = intent[location];
    if (role === undefined) continue;
    check(location, role.model, role.fresh === true ? undefined : source?.[location]?.model);
  }
}

/**
 * Replay the editable lineage over the owner opening as one transaction.
 *
 * The wire steps are COMPOSED operations, not chronological menu actions: a
 * swap staged through a temporary id legitimately has A → B while B still
 * exists at the opening. The same rule as persistence applies here: all
 * baseline identities are released before final destination identities are
 * installed, and destination collisions are validated against the owner
 * opening plus that released set. Hidden env/legacy argv come from the owner's
 * opening definition for an edit/rename and from nothing for a creation; no
 * client baseline or private-field flag is trusted.
 */
function replayExternalAgentOperations(
  opening: ReviewGateConfig,
  steps: readonly RemoteExternalAgentOperationIntent[],
): ReplayedExternalAgents {
  const openingCatalog = opening.externalAgents ?? {};
  const operations: ExternalAgentOperation[] = [];
  const released = new Set<string>();
  const claimedOpeningIds = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const field = `externalAgents[${index}]`;
    if (step.definition === undefined) {
      if (step.nextId !== undefined) fail(`${field} has a destination but no definition`);
      if (!Object.hasOwn(openingCatalog, step.id) || claimedOpeningIds.has(step.id)) {
        fail(`${field} deletes an external worker that is not live in the owner opening`);
      }
      const baseline = structuredClone(openingCatalog[step.id]!);
      operations.push({ id: step.id, baseline, nextId: undefined, definition: undefined });
      claimedOpeningIds.add(step.id);
      released.add(step.id);
      continue;
    }
    if (step.nextId === undefined) fail(`${field} has a definition but no destination id`);
    const isCreation = !Object.hasOwn(openingCatalog, step.id) || released.has(step.id);
    let source: ExternalAgentValue | undefined;
    if (!isCreation) {
      if (claimedOpeningIds.has(step.id)) {
        fail(`${field} claims an opening worker already edited by another step`);
      }
      claimedOpeningIds.add(step.id);
      source = openingCatalog[step.id]!;
      if (!isGuidedAdapter(source.adapter)) {
        fail(`${field} edits an unsupported external-worker adapter; only Delete is supported`);
      }
    }
    assertEditableNativeModels(field, step.definition, isCreation ? undefined : source);
    const definition = rebuildExternalAgentDefinition(step.definition, isCreation ? undefined : source);
    if (!isCreation) {
      assertLegacyReasoningResolved(field, source!, step.definition);
    }
    const issues = validateNativeReasoning(step.definition.adapter, definition);
    if (issues.length > 0) {
      fail(`${field} has unresolved reasoning in ${[...new Set(issues.map((issue) => issue.location))].join(", ")}`);
    }
    const canonicalDefinition = canonical(`${field} definition`, () =>
      normalizeConfig({ externalAgents: { [step.nextId!]: definition } }).externalAgents![step.nextId!]!);
    operations.push({
      id: step.id,
      baseline: isCreation ? undefined : structuredClone(source!),
      nextId: step.nextId,
      definition: canonicalDefinition,
    });
    if (!isCreation && step.nextId !== step.id) released.add(step.id);
  }

  // Composed-transaction collision rules, matching the persistence boundary:
  // guarded/opening ids released by this transaction are free destinations.
  const releasedIds = new Set(
    operations.filter((operation) => operation.baseline !== undefined && operation.nextId !== operation.id).map((operation) => operation.id),
  );
  const destinations = new Set<string>();
  for (const operation of operations) {
    if (operation.nextId !== undefined) {
      if (destinations.has(operation.nextId)) fail(`externalAgents installs more than one worker at ${operation.nextId}`);
      destinations.add(operation.nextId);
    }
    if (operation.baseline === undefined && operation.nextId !== undefined
      && Object.hasOwn(openingCatalog, operation.id) && !releasedIds.has(operation.id)) {
      fail(`externalAgents creates ${operation.id}, which the owner opening already has`);
    }
    if (operation.nextId !== undefined && operation.nextId !== operation.id
      && Object.hasOwn(openingCatalog, operation.nextId) && !releasedIds.has(operation.nextId)) {
      fail(`externalAgents renames to ${operation.nextId}, which the owner opening still has`);
    }
  }

  const referenceBaselines: Record<string, ExternalAgentReferenceBaseline> = {};
  for (const id of Object.keys(openingCatalog)) {
    setCatalogKey(referenceBaselines, id, captureExternalAgentReferenceBaseline(opening, id));
  }
  return {
    operations,
    catalog: applyExternalAgentOperations(openingCatalog, operations),
    referenceBaselines,
  };
}

/**
 * Rebuild the canonical native definition exactly as the menu's Apply does:
 * the automatic native command, no shared args, and for every surviving role
 * no args/protocol but the owner-held private env. Models, reasoning, and
 * role timeouts come only from the editable intent.
 */
function rebuildExternalAgentDefinition(
  intent: RemoteExternalAgentIntent,
  source: ExternalAgentValue | undefined,
): ExternalAgentValue {
  return {
    adapter: intent.adapter,
    command: nativeExternalAgentCommand(intent.adapter),
    ...(intent.model !== undefined ? { model: intent.model } : {}),
    ...(intent.reasoningEffort !== undefined ? { reasoningEffort: intent.reasoningEffort } : {}),
    ...(source?.env !== undefined ? { env: { ...source.env } } : {}),
    ...(intent.review !== undefined ? { review: rebuildExternalAgentRole(intent.review, source?.review) } : {}),
    ...(intent.execution !== undefined ? { execution: rebuildExternalAgentRole(intent.execution, source?.execution) } : {}),
  };
}

function rebuildExternalAgentRole(
  intent: RemoteExternalAgentRoleIntent,
  source: ExternalAgentRoleConfig | undefined,
): ExternalAgentRoleConfig {
  return {
    ...(intent.model !== undefined ? { model: intent.model } : {}),
    ...(intent.reasoningEffort !== undefined ? { reasoningEffort: intent.reasoningEffort } : {}),
    ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
    // A fresh role has no opening role, so it inherits no private env.
    ...(intent.fresh === true || source?.env === undefined ? {} : { env: { ...source.env } }),
  };
}

/**
 * The native editor refuses Apply while any enabled scope still has unresolved
 * legacy reasoning. The projected menu sees that state through the presentation
 * metadata; on the owner the authoritative source is the FULL opening/staged
 * definition's own argv. Require the explicit typed choice the UI would have
 * demanded (a removed role needs none, and a role may inherit a resolved shared
 * typed effort).
 */
function assertLegacyReasoningResolved(
  field: string,
  current: ExternalAgentValue,
  intent: RemoteExternalAgentIntent,
): void {
  if (!isGuidedAdapter(current.adapter)) return;
  for (const entry of importNativeReasoning(current.adapter, { ...current, id: "" } as ExternalAgentConfig)) {
    if (entry.location === "shared") {
      if (intent.reasoningEffort === undefined) {
        if (entry.reasoning.kind === "unresolved") fail(`${field} must resolve unresolved shared legacy reasoning`);
        if (entry.reasoning.kind !== "absent") fail(`${field} must retain or explicitly replace shared reasoning`);
      }
      continue;
    }
    if (entry.reasoning.kind !== "unresolved") continue;
    const role = intent[entry.location];
    if (role === undefined) continue;
    // A fresh role has no opening argv. Every surviving role with unresolved
    // legacy argv needs its OWN explicit resolution: a typed effort, the
    // editor's explicit Inherit choice, or removal. A shared typed effort is
    // not evidence that this role's unresolved state was resolved.
    if (role.fresh === true || role.inheritsReasoning === true || role.reasoningEffort !== undefined) continue;
    fail(`${field} must resolve unresolved ${entry.location} legacy reasoning`);
  }
}

/**
 * The shared persistence rule for building the staged catalog: release every
 * guarded/opening identity first, then install every final destination. That is
 * what makes a composed swap or release-then-reinstall transaction coherent.
 */
function applyExternalAgentOperations(base: ExternalAgentCatalog, operations: readonly ExternalAgentOperation[]): ExternalAgentCatalog {
  const catalog = cloneExternalAgentCatalog(base);
  for (const operation of operations) {
    if (operation.baseline !== undefined) delete catalog[operation.id];
  }
  for (const operation of operations) {
    if (operation.nextId !== undefined) setCatalogKey(catalog, operation.nextId, structuredClone(operation.definition!));
  }
  return catalog;
}

/** Merge only editable web values over the owner's non-editable web settings. */
function mergeEditableWeb(opening: ReviewGateConfig["web"], web: NonNullable<ReviewGateConfig["web"]>): NonNullable<ReviewGateConfig["web"]> {
  const base = opening ?? DEFAULT_CONFIG.web!;
  return {
    ...structuredClone(base),
    browserInteractionApproval: web.browserInteractionApproval,
    browserIdleExpiryMinutes: web.browserIdleExpiryMinutes,
    browserDownloadRetention: web.browserDownloadRetention,
    browserVisible: web.browserVisible,
    browserPermissions: { ...web.browserPermissions },
    urlBlocklist: [...web.urlBlocklist],
    fetch: { ...base.fetch, maxDownloadBytes: web.fetch.maxDownloadBytes },
  };
}

// ---------------------------------------------------------------------------
// Closed-schema readers (explicit structure/category checks on untrusted data)
// ---------------------------------------------------------------------------

const INTENT_FIELDS = [
  "version",
  "operatingMode",
  "modeCycleShortcut",
  "workerResources",
  "executeRoute",
  "researchRoute",
  "primaryReviewers",
  "subtaskReviewers",
  "primaryEnabled",
  "subtaskEnabled",
  "reviewLandedChanges",
  "evidence",
  "reviewerTimeoutMs",
  "executorTimeoutMs",
  "maxCorrectionCycles",
  "implementationGuidanceAfterCorrectionAttempts",
  "retainBundles",
  "waveArtifactTtlMs",
  "deleteSpawnedPiSessionsOnCleanup",
  "maxWorkers",
  "retryPolicy",
  "subtaskNotifications",
  "deferredPiTools",
  "subtasksViewExpanded",
  "showSubtaskTaskIds",
  "scheduledTasks",
  "scheduledTasksAlreadyRunEdited",
  "externalAgents",
  "webMaxDownloadBytes",
  "browserInteractionApproval",
  "browserIdleExpiryMinutes",
  "browserDownloadRetention",
  "browserVisible",
  "webBrowserPermissions",
  "webUrlBlocklist",
  "youShouldKnow",
  "tools",
  "toolProtection",
] as const;

const EXTERNAL_AGENT_STEP_FIELDS = ["id", "nextId", "definition"] as const;
const EXTERNAL_AGENT_DEFINITION_FIELDS = ["adapter", "model", "reasoningEffort", "review", "execution"] as const;
const EXTERNAL_AGENT_ROLE_FIELDS = ["model", "reasoningEffort", "timeoutMs", "fresh", "inheritsReasoning"] as const;
const SCHEDULED_TASK_FIELDS = [
  "name",
  "cron",
  "enabled",
  "kind",
  "destination",
  "instructions",
  "workspace",
  "workerResourceId",
  "review",
  "oneShot",
  "alreadyRun",
] as const;

function isGuidedAdapter(value: unknown): value is GuidedExternalAgentAdapter {
  return value === "claude-cli" || value === "codex-cli";
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) fail(`cannot be encoded: ${field} is missing from the staged save`);
  return value;
}

function requiredValue(value: unknown, field: string): unknown {
  if (value === undefined) fail(`save intent is missing ${field}`);
  return value;
}

function fail(message: string): never {
  throw new RemoteReviewSettingsDataError(message);
}

function canonical<T>(field: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RemoteReviewSettingsDataError) throw error;
    fail(`${field} are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Plain data records only: Map/Date/class instances are not configuration objects. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closedRecord(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${field} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} has an unsupported field`);
  }
  return value;
}

function catalogRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${field} must be a plain object`);
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") fail(`${field}[${index}] must be a string`);
    return entry;
  });
}

function readSelectionValue(value: unknown, field: string): ActiveReviewerSelection {
  const record = closedRecord(value, field, ["source", "model", "thinkingLevel", "id"]);
  if (record.source === "pi") {
    if (record.id !== undefined) fail(`${field} has an id for a pi selection`);
    if (typeof record.model !== "string" || record.model.length === 0) fail(`${field}.model must be a non-empty string`);
    if (record.thinkingLevel !== undefined && typeof record.thinkingLevel !== "string") {
      fail(`${field}.thinkingLevel must be a string`);
    }
    return {
      source: "pi",
      model: record.model,
      ...(record.thinkingLevel !== undefined ? { thinkingLevel: record.thinkingLevel as ThinkingLevel } : {}),
    };
  }
  if (record.source === "external") {
    if (record.model !== undefined || record.thinkingLevel !== undefined) {
      fail(`${field} has pi-only fields for an external selection`);
    }
    if (typeof record.id !== "string" || record.id.length === 0) fail(`${field}.id must be a non-empty string`);
    return { source: "external", id: record.id };
  }
  fail(`${field}.source must be "pi" or "external"`);
}

function readReviewers(value: unknown, field: string): ActiveReviewerSelection[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value.map((entry, index) => readSelectionValue(entry, `${field}[${index}]`));
}

function readEvidence(value: unknown): ReviewEvidenceConfig {
  const record = closedRecord(value, "evidence", ["primaryToolOnly", "worktreeToolOnly", "inplaceToolOnly", "snapshotFailureFallback"]);
  const flag = (key: string): boolean => {
    const raw = record[key];
    if (typeof raw !== "boolean") fail(`evidence.${key} must be a boolean`);
    return raw;
  };
  return {
    primaryToolOnly: flag("primaryToolOnly"),
    worktreeToolOnly: flag("worktreeToolOnly"),
    inplaceToolOnly: flag("inplaceToolOnly"),
    snapshotFailureFallback: flag("snapshotFailureFallback"),
  };
}

/**
 * The worker editor generates new keys from the selected executor
 * (`external-<id>` or `pi-<base64url model>`) and keeps the original key when
 * a resource's selection changes afterwards. Owner-opening keys are retained
 * regardless of form.
 */
function isGeneratedWorkerResourceId(id: string): boolean {
  if (id.startsWith("external-")) return isConfiguredId(id.slice("external-".length));
  if (!id.startsWith("pi-")) return false;
  const model = Buffer.from(id.slice("pi-".length), "base64url").toString("utf8");
  return model.length > 0 && model === model.trim() && executorEntryId({ source: "pi", model }) === id;
}

function readWorkerResources(value: unknown, opening: WorkerResourceCatalog): WorkerResourceCatalog {
  const entries = catalogRecord(value, "workerResources");
  const catalog: WorkerResourceCatalog = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (!Object.hasOwn(opening, id) && !isGeneratedWorkerResourceId(id)) {
      fail("workerResources has a new id the editor cannot generate");
    }
    const record = closedRecord(entry, `workerResources.${id}`, ["selection", "maxConcurrent"]);
    const selection = readSelectionValue(requiredValue(record.selection, `workerResources.${id}.selection`), `workerResources.${id}.selection`);
    if (selection.source === "pi" && selection.thinkingLevel !== undefined) {
      fail(`workerResources.${id}.selection must not carry resource-level thinking; use the route entry`);
    }
    if (typeof record.maxConcurrent !== "number") fail(`workerResources.${id}.maxConcurrent must be a number`);
    setCatalogKey(catalog, id, { selection, maxConcurrent: record.maxConcurrent });
  }
  return catalog;
}


function readRoutes(value: unknown, field: string): WorkerRouteEntry[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value.map((entry, index) => {
    const record = closedRecord(entry, `${field}[${index}]`, ["resourceId", "thinkingLevel"]);
    if (typeof record.resourceId !== "string" || record.resourceId.length === 0) fail(`${field}[${index}].resourceId must be a non-empty string`);
    if (record.thinkingLevel !== undefined && typeof record.thinkingLevel !== "string") fail(`${field}[${index}].thinkingLevel must be a string`);
    return {
      resourceId: record.resourceId,
      ...(record.thinkingLevel !== undefined ? { thinkingLevel: record.thinkingLevel as WorkerRouteEntry["thinkingLevel"] } : {}),
    };
  });
}

function readRetryPolicy(value: unknown): ExecutionRetryPolicy {
  const record = closedRecord(value, "retryPolicy", ["maxRetries", "baseDelayMs", "maxDelayMs", "jitter", "maxSameIncidentRepeats"]);
  const number = (key: string): number => {
    const raw = record[key];
    if (typeof raw !== "number") fail(`retryPolicy.${key} must be a number`);
    return raw;
  };
  if (typeof record.jitter !== "boolean") fail("retryPolicy.jitter must be a boolean");
  return {
    maxRetries: number("maxRetries"),
    baseDelayMs: number("baseDelayMs"),
    maxDelayMs: number("maxDelayMs"),
    jitter: record.jitter,
    maxSameIncidentRepeats: number("maxSameIncidentRepeats"),
  };
}

function readBrowserPermissions(value: unknown): WebBrowserPermissions {
  const record = closedRecord(value, "webBrowserPermissions", BROWSER_PERMISSION_FIELDS);
  const permissions = {} as WebBrowserPermissions;
  for (const field of BROWSER_PERMISSION_FIELDS) {
    const raw = record[field];
    if (typeof raw !== "boolean") fail(`webBrowserPermissions.${field} must be a boolean`);
    permissions[field] = raw;
  }
  return permissions;
}

function readYouShouldKnow(value: unknown): YouShouldKnowConfig {
  const record = closedRecord(value, "youShouldKnow", ["enabled", "completionGuidance"]);
  if (typeof record.enabled !== "boolean") fail("youShouldKnow.enabled must be a boolean");
  if (typeof record.completionGuidance !== "boolean") fail("youShouldKnow.completionGuidance must be a boolean");
  return { enabled: record.enabled, completionGuidance: record.completionGuidance };
}

function readTools(value: unknown): ReviewGateToolsConfig {
  const record = closedRecord(value, "tools", ["topLevelDeny", "executorDeny"]);
  return {
    topLevelDeny: readStringArray(requiredValue(record.topLevelDeny, "tools.topLevelDeny"), "tools.topLevelDeny"),
    executorDeny: readStringArray(requiredValue(record.executorDeny, "tools.executorDeny"), "tools.executorDeny"),
  };
}

function readToolProtection(value: unknown): ToolProtectionConfig {
  const record = closedRecord(value, "toolProtection", [
    "level",
    "auditor",
    "scope",
    "toolNames",
    "timeoutMs",
    "maxContextChars",
    "retainAuditorSessions",
    "debug",
  ]);
  if (typeof record.level !== "string") fail("toolProtection.level must be a string");
  const auditor = record.auditor === null
    ? null
    : record.auditor === undefined
      ? undefined
      : readSelectionValue(record.auditor, "toolProtection.auditor");
  if (auditor === undefined) fail("toolProtection.auditor is required (use null for none)");
  if (typeof record.scope !== "string") fail("toolProtection.scope must be a string");
  if (!Array.isArray(record.toolNames)) fail("toolProtection.toolNames must be an array");
  for (const [index, name] of record.toolNames.entries()) {
    if (typeof name !== "string") fail(`toolProtection.toolNames[${index}] must be a string`);
  }
  if (typeof record.timeoutMs !== "number") fail("toolProtection.timeoutMs must be a number");
  if (typeof record.maxContextChars !== "number") fail("toolProtection.maxContextChars must be a number");
  if (typeof record.retainAuditorSessions !== "boolean") fail("toolProtection.retainAuditorSessions must be a boolean");
  if (typeof record.debug !== "boolean") fail("toolProtection.debug must be a boolean");
  return {
    level: record.level as ToolProtectionConfig["level"],
    auditor,
    scope: record.scope as ToolProtectionConfig["scope"],
    toolNames: [...record.toolNames] as string[],
    timeoutMs: record.timeoutMs,
    maxContextChars: record.maxContextChars,
    retainAuditorSessions: record.retainAuditorSessions,
    debug: record.debug,
  };
}

function readScheduledTasks(value: unknown, openingTasks: ScheduledTaskCatalog): ScheduledTaskCatalog {
  const knownTaskIds = new Set(Object.keys(openingTasks));
  const entries = catalogRecord(value, "scheduledTasks");
  const catalog: ScheduledTaskCatalog = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (!isConfiguredId(id)) fail("scheduledTasks has an unsupported task id");
    // The native scheduler editor generates task- plus eight lowercase hex digits.
    if (!knownTaskIds.has(id) && !/^task-[0-9a-f]{8}$/.test(id)) {
      fail("scheduledTasks has a new id the editor cannot generate");
    }
    setCatalogKey(catalog, id, readScheduledTask(id, entry, openingTasks[id]));
  }
  return catalog;
}

function readScheduledTask(id: string, value: unknown, openingEntry: ScheduledTaskEntryConfig | undefined): ScheduledTaskEntryConfig {
  const field = `scheduledTasks.${id}`;
  const record = closedRecord(value, field, SCHEDULED_TASK_FIELDS);
  if (typeof record.name !== "string") fail(`${field}.name must be a string`);
  if (typeof record.cron !== "string") fail(`${field}.cron must be a string`);
  if (typeof record.enabled !== "boolean") fail(`${field}.enabled must be a boolean`);
  if (record.kind !== "execute" && record.kind !== "research" && record.kind !== "inplace") {
    fail(`${field}.kind must be execute, research, or inplace`);
  }
  if (record.destination !== undefined && record.destination !== "subtask" && record.destination !== "orchestrator-turn") {
    fail(`${field}.destination must be subtask or orchestrator-turn`);
  }
  if (typeof record.instructions !== "string") fail(`${field}.instructions must be a string`);
  if (typeof record.workspace !== "string") fail(`${field}.workspace must be a string`);
  if (record.workerResourceId !== undefined && (typeof record.workerResourceId !== "string" || !isConfiguredId(record.workerResourceId))) {
    fail(`${field}.workerResourceId must be a supported worker resource id`);
  }
  if (record.oneShot !== undefined && typeof record.oneShot !== "boolean") fail(`${field}.oneShot must be a boolean`);
  if (record.alreadyRun !== undefined && typeof record.alreadyRun !== "boolean") fail(`${field}.alreadyRun must be a boolean`);
  const review = record.review !== undefined ? readScheduledReview(record.review, `${field}.review`) : undefined;
  if (review?.mode === "selected" && review.reviewers.length === 0) {
    const retained = openingEntry?.review?.mode === "selected" && openingEntry.review.reviewers.length === 0;
    if (!retained) fail(`${field}.review must select at least one reviewer`);
  }
  const entry: ScheduledTaskEntryConfig = {
    name: record.name,
    cron: record.cron,
    enabled: record.enabled,
    kind: record.kind,
    ...(record.destination !== undefined ? { destination: record.destination } : {}),
    instructions: record.instructions,
    workspace: record.workspace,
    ...(record.workerResourceId !== undefined ? { workerResourceId: record.workerResourceId } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(record.oneShot === true ? { oneShot: true } : {}),
    ...(record.alreadyRun === true ? { alreadyRun: true } : {}),
  };
  return canonicalizeCompleteScheduledTask(id, entry);
}

/**
 * Canonicalize an entry the shared schema fully accepts (disabled here so the
 * save-time unservable-pin rule stays the shared `disableUnservableScheduledTasks`
 * decision). A still-incomplete menu draft — no cron/instructions/workspace yet
 * — is returned structurally checked; the shared save-time validation reports
 * it exactly as the local menu does, and the eventual write normalizes it.
 */
function canonicalizeCompleteScheduledTask(id: string, entry: ScheduledTaskEntryConfig): ScheduledTaskEntryConfig {
  // A menu draft may still be blank in its required text fields. Substitute
  // placeholders ONLY to let the canonical normalizer check the other fields;
  // genuine drafts are returned unchanged for shared save-time validation,
  // and any unrelated normalization error fails decoding.
  const missingName = !entry.name.trim();
  const missingCron = !entry.cron.trim();
  const missingInstructions = !entry.instructions.trim();
  const missingWorkspace = (entry.destination ?? "subtask") === "subtask" && !entry.workspace?.trim();
  const normalized = canonical(`scheduledTasks.${id}`, () => normalizeConfig({
    scheduledTasks: {
      [id]: {
        ...entry,
        enabled: false,
        name: missingName ? "Draft" : entry.name,
        cron: missingCron ? "0 * * * *" : entry.cron,
        instructions: missingInstructions ? "Draft" : entry.instructions,
        workspace: missingWorkspace ? "." : entry.workspace,
      },
    },
  }).scheduledTasks![id]!);
  if (missingName || missingCron || missingInstructions || missingWorkspace) return entry;
  return { ...normalized, enabled: entry.enabled };
}

function readScheduledReview(value: unknown, field: string): ScheduledTaskReviewOverride {
  const record = closedRecord(value, field, ["mode", "reviewers"]);
  if (record.mode === "off") {
    if (record.reviewers !== undefined) fail(`${field}.reviewers is invalid with mode off`);
    return { mode: "off" };
  }
  if (record.mode === "selected") {
    return { mode: "selected", reviewers: readReviewers(requiredValue(record.reviewers, `${field}.reviewers`), `${field}.reviewers`) };
  }
  fail(`${field}.mode must be off or selected`);
}

function readExternalAgentOperations(value: unknown): RemoteExternalAgentOperationIntent[] {
  if (!Array.isArray(value)) fail("externalAgents must be an array");
  return value.map((entry, index) => readExternalAgentOperation(entry, index));
}

function readExternalAgentOperation(value: unknown, index: number): RemoteExternalAgentOperationIntent {
  const field = `externalAgents[${index}]`;
  const record = closedRecord(value, field, EXTERNAL_AGENT_STEP_FIELDS);
  if (typeof record.id !== "string" || !isConfiguredId(record.id)) fail(`${field}.id must be a supported external worker id`);
  if (record.nextId !== undefined && (typeof record.nextId !== "string" || !isConfiguredId(record.nextId))) {
    fail(`${field}.nextId must be a supported external worker id`);
  }
  if (record.definition === undefined) {
    return {
      id: record.id,
      ...(record.nextId !== undefined ? { nextId: record.nextId } : {}),
    };
  }
  return {
    id: record.id,
    ...(record.nextId !== undefined ? { nextId: record.nextId } : {}),
    definition: readExternalAgentDefinition(record.definition, `${field}.definition`),
  };
}

function readExternalAgentDefinition(value: unknown, field: string): RemoteExternalAgentIntent {
  const record = closedRecord(value, field, EXTERNAL_AGENT_DEFINITION_FIELDS);
  if (!isGuidedAdapter(record.adapter)) fail(`${field}.adapter must be claude-cli or codex-cli`);
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length === 0)) {
    fail(`${field}.model must be a non-empty string`);
  }
  if (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== "string") {
    fail(`${field}.reasoningEffort must be a string`);
  }
  return {
    adapter: record.adapter,
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort as NativeReasoningEffort } : {}),
    ...(record.review !== undefined ? { review: readExternalAgentRole(record.review, `${field}.review`) } : {}),
    ...(record.execution !== undefined ? { execution: readExternalAgentRole(record.execution, `${field}.execution`) } : {}),
  };
}

function readExternalAgentRole(value: unknown, field: string): RemoteExternalAgentRoleIntent {
  const record = closedRecord(value, field, EXTERNAL_AGENT_ROLE_FIELDS);
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length === 0)) {
    fail(`${field}.model must be a non-empty string`);
  }
  if (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== "string") {
    fail(`${field}.reasoningEffort must be a string`);
  }
  if (record.timeoutMs !== undefined && (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs))) {
    fail(`${field}.timeoutMs must be a finite number`);
  }
  for (const flag of ["fresh", "inheritsReasoning"] as const) {
    if (record[flag] !== undefined && typeof record[flag] !== "boolean") fail(`${field}.${flag} must be a boolean`);
  }
  if (record.inheritsReasoning === true && record.reasoningEffort !== undefined) {
    fail(`${field} cannot explicitly inherit and choose a reasoning effort`);
  }
  return {
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort as NativeReasoningEffort } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.fresh === true ? { fresh: true } : {}),
    ...(record.inheritsReasoning === true ? { inheritsReasoning: true } : {}),
  };
}

/**
 * The configured-id grammar the canonical schema accepts for catalogs
 * (`[A-Za-z0-9_.-]+`, excluding `.`/`..`). It is checked here so invalid keys
 * fail at the data boundary; the canonical normalizer still re-validates every
 * id at Save.
 */
function isConfiguredId(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

// ---------------------------------------------------------------------------
// Small clones shared by projection/encoding.
// ---------------------------------------------------------------------------

function cloneReviewer<T extends ActiveReviewerSelection>(value: T): T {
  return (value.source === "pi"
    ? {
        source: "pi",
        model: value.model,
        ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
      }
    : { source: "external", id: value.id }) as T;
}

function cloneRouteEntry(entry: WorkerRouteEntry): WorkerRouteEntry {
  return {
    resourceId: entry.resourceId,
    ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
  };
}

function cloneRetryPolicy(value: ExecutionRetryPolicy): ExecutionRetryPolicy {
  return {
    maxRetries: value.maxRetries,
    baseDelayMs: value.baseDelayMs,
    maxDelayMs: value.maxDelayMs,
    jitter: value.jitter,
    maxSameIncidentRepeats: value.maxSameIncidentRepeats,
  };
}

function cloneEvidence(value: ReviewEvidenceConfig): ReviewEvidenceConfig {
  return {
    ...(value.primaryToolOnly !== undefined ? { primaryToolOnly: value.primaryToolOnly } : {}),
    ...(value.worktreeToolOnly !== undefined ? { worktreeToolOnly: value.worktreeToolOnly } : {}),
    ...(value.inplaceToolOnly !== undefined ? { inplaceToolOnly: value.inplaceToolOnly } : {}),
    ...(value.snapshotFailureFallback !== undefined ? { snapshotFailureFallback: value.snapshotFailureFallback } : {}),
  };
}

function cloneYouShouldKnow(value: YouShouldKnowConfig): YouShouldKnowConfig {
  return { enabled: value.enabled, completionGuidance: value.completionGuidance };
}

function cloneToolProtection(value: ToolProtectionConfig): ToolProtectionConfig {
  return {
    level: value.level,
    auditor: value.auditor === null ? null : cloneReviewer(value.auditor),
    scope: value.scope,
    toolNames: [...value.toolNames],
    timeoutMs: value.timeoutMs,
    maxContextChars: value.maxContextChars,
    retainAuditorSessions: value.retainAuditorSessions,
    debug: value.debug,
  };
}

function cloneScheduledReview(review: ScheduledTaskReviewOverride): ScheduledTaskReviewOverride {
  return review.mode === "off"
    ? { mode: "off" }
    : { mode: "selected", reviewers: review.reviewers.map(cloneReviewer) };
}

function cloneReasoningImport(value: ReasoningImport): ReasoningImport {
  if (value.kind === "absent") return { kind: "absent" };
  if (value.kind === "value") return { kind: "value", value: value.value };
  return { kind: "unresolved", reason: value.reason };
}
