/**
 * Issue #716: the editable Review-settings data boundary for another host.
 *
 * These tests pin the pure three-way translation used by remote settings:
 * owner opening projection, closed editable save intent, and owner-side decode
 * into the shared persisted-save inputs. They cover the acceptance-relevant
 * leaks/forgeries: private worker command/argv/env, raw unknown settings,
 * caller baselines, unsupported adapters, schedule workspaces/catalogs,
 * Browser permissions (YOLO included), worker rename/delete/creation lineage,
 * legacy reasoning parity, and malformed/unknown payload rejection.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_DEFERRED_PI_TOOLS,
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  cloneScheduledTaskCatalog,
  cloneWorkerCatalog,
  effectiveReviewEvidenceSettings,
  effectiveReviewSettings,
  normalizeConfig,
  resolvedExternalAgent,
  type ReviewGateConfig,
} from "../src/config";
import { importNativeReasoning, type NativeReasoningDefinition } from "../src/external-agent-reasoning";
import { preparePersistedSave, type PersistedSaveSelection, type StagedPersistedSave } from "../src/settings/persisted-save";
import { persistReviewSettings } from "../src/settings/persistence";
import { captureExternalAgentReferenceBaseline, changeExternalAgent, stageExternalAgentOperation, type ExternalAgentOperation } from "../src/settings/external-agent-catalog";
import { selectExternalAgentCreation, selectExternalAgentEdit } from "../src/settings/external-agents";
import type { ScopedModelChoice } from "../src/settings/models";
import { stagedToolProtectionSettings } from "../src/settings/tool-protection";
import type { UiContext } from "../src/settings/ui";
import {
  REMOTE_REVIEW_SETTINGS_DATA_VERSION,
  RemoteReviewSettingsDataError,
  decodeRemoteReviewSettingsSaveIntent,
  encodeRemoteReviewSettingsSaveIntent,
  projectRemoteReviewSettingsOpening,
  type RemoteReviewSettingsSaveIntent,
} from "../src/session-host/remote-review-settings-data";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixture(): ReviewGateConfig {
  const config = normalizeConfig({
    enabled: false,
    operatingMode: "orchestrate",
    modeCycleShortcut: "alt+m",
    reviewerTimeoutMs: 111_000,
    executorTimeoutMs: 222_000,
    maxCorrectionCycles: 3,
    implementationGuidanceAfterCorrectionAttempts: 2,
    waveArtifactTtlMs: 123_456,
    retainBundles: "always",
    deleteSpawnedPiSessionsOnCleanup: true,
    externalAgents: {
      native: {
        adapter: "claude-cli",
        command: "/secret/custom-claude",
        args: ["--effort", "high", "--shared-secret"],
        env: { SHARED_TOKEN: "shared-env-secret", SHARED_EMPTY: "" },
        model: "claude-opus-5-5",
        review: {
          model: "claude-sonnet-5-5",
          env: { REVIEW_TOKEN: "review-env-secret" },
          timeoutMs: 9_000,
          protocol: "pi-reviewer-json-v1",
        },
        execution: {
          model: "claude-sonnet-5-5",
          timeoutMs: 1_234,
          args: ["--role-secret-token"],
          env: { EXEC_TOKEN: "exec-env-secret" },
          protocol: "pi-review-executor-jsonl-v1",
        },
      },
      "legacy-conflict": {
        adapter: "claude-cli",
        command: "claude",
        args: ["--effort", "high", "--effort", "low"],
        env: { CONFLICT_TOKEN: "conflict-env-secret" },
        model: "claude-opus-5-5",
        execution: { env: { CONFLICT_EXEC_TOKEN: "conflict-exec-env-secret" } },
      },
      "legacy-role": {
        adapter: "codex-cli",
        command: "codex",
        model: "gpt-6-sol",
        review: {
          model: "gpt-6-sol",
          args: ["-c", 'model_reasoning_effort="high"', "-c", 'model_reasoning_effort="low"'],
          env: { ROLE_CONFLICT_TOKEN: "role-conflict-secret" },
        },
      },
      "mixed-legacy": {
        adapter: "claude-cli",
        command: "claude",
        model: "claude-opus-5-5",
        args: ["--effort", "high"],
        env: { MIXED_TOKEN: "mixed-env-secret" },
        review: {
          model: "claude-sonnet-5-5",
          args: ["--effort", "high", "--effort", "low"],
          env: { MIXED_REVIEW_TOKEN: "mixed-review-env-secret" },
        },
        execution: { model: "claude-sonnet-5-5" },
      },
      "custom-model": {
        adapter: "claude-cli",
        command: "/secret/custom-model-command",
        model: "owner-only-model",
        review: { model: "owner-only-review" },
      },
      binary: {
        adapter: "run-as-binary",
        command: "/secret/unsupported-binary",
        args: ["--binary-argv-secret"],
        env: { BINARY_TOKEN: "binary-env-secret" },
        review: { protocol: "pi-reviewer-json-v1", env: { BINARY_REVIEW_TOKEN: "binary-review-env-secret" } },
        execution: { protocol: "pi-review-executor-jsonl-v1", env: { BINARY_EXEC_TOKEN: "binary-exec-env-secret" } },
      },
    },
    execution: {
      workerResources: {
        pi: { selection: { source: "pi", model: "openai/gpt-5", thinkingLevel: "high" }, maxConcurrent: 2 },
        "native-r": { selection: { source: "external", id: "native" }, maxConcurrent: 1 },
      },
      routes: {
        execute: [{ resourceId: "native-r" }, { resourceId: "pi", thinkingLevel: "high" }],
        research: [{ resourceId: "native-r" }],
      },
      maxWorkers: 6,
      retryPolicy: { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8_000, jitter: false, maxSameIncidentRepeats: 3 },
      subtaskNotifications: "noisy",
      deferredPiTools: false,
    },
    review: {
      primaryReviewers: [{ source: "external", id: "native" }, { source: "pi", model: "openai/gpt-5", thinkingLevel: "medium" }],
      subtaskReviewers: [{ source: "external", id: "legacy-conflict" }],
      primaryEnabled: true,
      subtaskEnabled: false,
      primaryClaudeCodeEnabled: true,
      primaryCodexEnabled: false,
      reviewLandedChanges: true,
      evidence: { primaryToolOnly: true, worktreeToolOnly: false, inplaceToolOnly: true, snapshotFailureFallback: false },
    },
    scheduledTasks: {
      nightly: {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run the owner check",
        workspace: "~/owner/project",
        workerResourceId: "native-r",
        review: { mode: "selected", reviewers: [{ source: "external", id: "native" }] },
        oneShot: true,
        alreadyRun: true,
      },
      dormant: {
        name: "Dormant",
        cron: "30 5 * * 1",
        enabled: false,
        kind: "execute",
        destination: "orchestrator-turn",
        instructions: "Dormant override",
        workspace: "stale-unused-workspace",
        review: { mode: "selected", reviewers: [{ source: "external", id: "legacy-role" }] },
      },
    },
    ui: { subtasksViewExpanded: true, showSubtaskTaskIds: true },
    youShouldKnow: { enabled: false, completionGuidance: true },
    tools: { topLevelDeny: ["Bash"], executorDeny: ["ApplyPatch"] },
    toolProtection: {
      level: "aligned",
      auditor: { source: "external", id: "native" },
      scope: "selected",
      toolNames: ["Bash", "Read"],
      timeoutMs: 12_000,
      maxContextChars: 20_000,
      retainAuditorSessions: true,
      debug: true,
    },
    web: {
      browserInteractionApproval: "automatically-deny",
      browserIdleExpiryMinutes: 0,
      browserDownloadRetention: 3,
      browserVisible: true,
      browserPermissions: {
        modelCredentialEntry: true,
        modelCredentialSubmission: true,
        modelUploads: true,
        modelDownloadSaving: true,
        modelClipboard: true,
        modelCamera: true,
        modelMicrophone: true,
        modelGeolocation: true,
        modelServiceWorkers: true,
        modelPopupRestrictionOverride: true,
        localNetworks: true,
        yolo: true,
      },
      urlBlocklist: ["example\\.com", "^https://blocked"],
      fetch: { maxDownloadBytes: 1_234_567 },
    },
  });
  // Raw settings a projection must never forward. These are added after
  // normalization because the canonical loader drops unknown configuration.
  const raw = config as unknown as Record<string, unknown>;
  raw.ownerConfigPath = "/secret/owner/config.json";
  raw.loadWarnings = ["raw-diagnostic-secret"];
  raw.schedulerRuntime = { enabled: true, liveOnly: "process-state-secret" };
  (config.externalAgents!.native as unknown as Record<string, unknown>).unknownWorkerField = "worker-raw-secret";
  (config.scheduledTasks!.nightly as unknown as Record<string, unknown>).unknownTaskField = "task-raw-secret";
  (config.execution!.routes!.execute![0] as unknown as Record<string, unknown>).unknownRouteField = "route-raw-secret";
  (config.review!.primaryReviewers![0] as unknown as Record<string, unknown>).unknownReviewerField = "reviewer-raw-secret";
  (config.execution!.retryPolicy as unknown as Record<string, unknown>).unknownRetryField = "retry-raw-secret";
  return config;
}

/** The canonical staged selection a menu over `staged` would hand its backend. */
function selectionFor(
  opening: ReviewGateConfig,
  staged: ReviewGateConfig,
  operations: ExternalAgentOperation[] = [],
  options: { alreadyRunEdited?: string[] } = {},
): PersistedSaveSelection {
  const review = effectiveReviewSettings(staged);
  const execution = staged.execution;
  const web = staged.web ?? DEFAULT_CONFIG.web!;
  return {
    operatingMode: staged.operatingMode,
    modeCycleShortcut: staged.modeCycleShortcut,
    workerResources: cloneWorkerCatalog(execution?.workerResources ?? {}),
    executeRoute: (execution?.routes?.execute ?? []).map((entry) => ({ ...entry })),
    researchRoute: (execution?.routes?.research ?? []).map((entry) => ({ ...entry })),
    primaryReviewers: review.primaryReviewers.map((entry) => ({ ...entry })),
    subtaskReviewers: review.subtaskReviewers.map((entry) => ({ ...entry })),
    primaryEnabled: review.primaryEnabled,
    subtaskEnabled: review.subtaskEnabled,
    primaryClaudeCodeEnabled: review.primaryClaudeCodeEnabled,
    primaryCodexEnabled: review.primaryCodexEnabled,
    reviewLandedChanges: review.reviewLandedChanges,
    evidence: { ...effectiveReviewEvidenceSettings(staged) },
    reviewerTimeoutMs: staged.reviewerTimeoutMs,
    executorTimeoutMs: staged.executorTimeoutMs,
    maxCorrectionCycles: staged.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: staged.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: staged.retainBundles,
    deleteSpawnedPiSessionsOnCleanup: staged.deleteSpawnedPiSessionsOnCleanup === true,
    maxWorkers: execution?.maxWorkers ?? DEFAULT_MAX_WORKERS,
    retryPolicy: { ...(execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY) },
    subtaskNotifications: execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE,
    deferredPiTools: execution?.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS,
    subtasksViewExpanded: staged.ui?.subtasksViewExpanded === true,
    showSubtaskTaskIds: staged.ui?.showSubtaskTaskIds === true,
    scheduledTasks: cloneScheduledTaskCatalog(staged.scheduledTasks ?? {}),
    scheduledTasksStagedFrom: Object.keys(opening.scheduledTasks ?? {}),
    scheduledTasksAlreadyRunEdited: [...(options.alreadyRunEdited ?? [])],
    externalAgentOperations: operations,
    externalAgentOpening: structuredClone(opening),
    externalAgentReferenceBaselines: Object.fromEntries(
      Object.keys(opening.externalAgents ?? {}).map((id) => [id, captureExternalAgentReferenceBaseline(opening, id)]),
    ),
    webMaxDownloadBytes: web.fetch.maxDownloadBytes,
    browserInteractionApproval: web.browserInteractionApproval,
    browserIdleExpiryMinutes: web.browserIdleExpiryMinutes,
    browserDownloadRetention: web.browserDownloadRetention,
    browserVisible: web.browserVisible,
    webBrowserPermissions: { ...web.browserPermissions },
    webUrlBlocklist: [...web.urlBlocklist],
    youShouldKnow: { ...(staged.youShouldKnow ?? DEFAULT_CONFIG.youShouldKnow!) },
    tools: { topLevelDeny: [...(staged.tools?.topLevelDeny ?? [])], executorDeny: [...(staged.tools?.executorDeny ?? [])] },
    toolProtection: stagedToolProtectionSettings(staged),
  };
}

function stagedSave(
  opening: ReviewGateConfig,
  staged: ReviewGateConfig,
  operations: ExternalAgentOperation[] = [],
  options: { alreadyRunEdited?: string[] } = {},
): StagedPersistedSave {
  return {
    configPath: "/owner/review-gate.json",
    cwd: "/owner/workspace",
    config: opening,
    draftConfig: staged,
    scoped: [],
    selection: selectionFor(opening, staged, operations, options),
    scheduledImageProvenance: new Map(),
  };
}

/** Encode, JSON-transport, and decode one staged save over the owner opening. */
function roundTrip(opening: ReviewGateConfig, staged: ReviewGateConfig, operations: ExternalAgentOperation[] = [], options: { alreadyRunEdited?: string[] } = {}) {
  const wire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, staged, operations, options))));
  return { wire: wire as RemoteReviewSettingsSaveIntent, decoded: decodeRemoteReviewSettingsSaveIntent(wire, opening) };
}

function assertDataError(action: () => unknown, pattern?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RemoteReviewSettingsDataError, `expected a RemoteReviewSettingsDataError, got ${String(error)}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

/** The menu-relevant reasoning semantics: a legacy "value" and the projected typed effort are the same editor state. */
function menuReasoningSemantics(agent: NativeReasoningDefinition, adapter: "claude-cli" | "codex-cli") {
  return importNativeReasoning(adapter, agent).map((entry) => ({
    location: entry.location,
    reasoning: entry.reasoning.kind === "value" ? { kind: "structured", value: entry.reasoning.value } : entry.reasoning,
    recognizedSettingCount: entry.recognizedSettingCount,
    droppedOtherTokenCount: entry.droppedOtherTokenCount,
    warnings: entry.warnings,
  }));
}

/** Fresh property access that defeats stale control-flow narrowing in assertions. */
function selectedAgent(config: ReviewGateConfig, id: string) {
  const catalog = config.externalAgents ?? {};
  return catalog[id]!;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test("projection carries every menu-owned value and no private worker field, raw setting, path, or baseline", () => {
  const opening = fixture();
  const snapshot = structuredClone(opening);
  const projected = projectRemoteReviewSettingsOpening(opening);

  assert.equal(projected.version, REMOTE_REVIEW_SETTINGS_DATA_VERSION);
  assert.deepEqual(opening, snapshot);

  const serialized = JSON.stringify(projected);
  for (const secret of [
    "shared-env-secret",
    "shared-empty",
    "review-env-secret",
    "exec-env-secret",
    "conflict-env-secret",
    "role-conflict-secret",
    "binary-env-secret",
    "binary-argv-secret",
    "binary-review-env-secret",
    "/secret/",
    "/owner/config.json",
    "raw-diagnostic-secret",
    "process-state-secret",
    "worker-raw-secret",
    "task-raw-secret",
    "route-raw-secret",
    "reviewer-raw-secret",
    "retry-raw-secret",
    "externalAgentReferenceBaselines",
    "externalAgentOpening",
  ]) {
    assert.ok(!serialized.includes(secret), `projection leaked ${secret}`);
  }

  // Private definition fields never cross, including on unsupported adapters.
  for (const agent of Object.values(projected.config.externalAgents!)) {
    assert.equal(Object.hasOwn(agent, "command"), false);
    assert.equal(Object.hasOwn(agent, "args"), false);
    assert.equal(Object.hasOwn(agent, "env"), false);
    for (const role of [agent.review, agent.execution]) {
      if (!role) continue;
      assert.equal(Object.hasOwn(role, "args"), false);
      assert.equal(Object.hasOwn(role, "env"), false);
      assert.equal(Object.hasOwn(role, "protocol"), false);
    }
  }
  assert.equal(Object.hasOwn(projected.config.externalAgents!.native, "unknownWorkerField"), false);
  assert.equal(Object.hasOwn(projected.config.scheduledTasks!.nightly, "unknownTaskField"), false);
  assert.equal(Object.hasOwn(projected.config.execution!.routes!.execute![0], "unknownRouteField"), false);
  assert.equal(Object.hasOwn(projected.config.review!.primaryReviewers![0], "unknownReviewerField"), false);
  assert.equal(Object.hasOwn(projected.config.execution!.retryPolicy!, "unknownRetryField"), false);
  assert.equal(Object.hasOwn(projected.config as unknown as Record<string, unknown>, "schedulerRuntime"), false);
  assert.equal(projected.config.externalAgents!.binary.adapter, "run-as-binary");
  assert.ok(projected.config.externalAgents!.binary.review);
  assert.ok(projected.config.externalAgents!.binary.execution);

  // Every menu-owned value is present.
  const config = projected.config;
  assert.equal(config.enabled, false);
  assert.equal(config.operatingMode, "orchestrate");
  assert.equal(config.modeCycleShortcut, "alt+m");
  assert.equal(config.reviewerTimeoutMs, 111_000);
  assert.equal(config.executorTimeoutMs, 222_000);
  assert.equal(config.maxCorrectionCycles, 3);
  assert.equal(config.implementationGuidanceAfterCorrectionAttempts, 2);
  assert.equal(config.waveArtifactTtlMs, 123_456);
  assert.equal(config.retainBundles, "always");
  assert.equal(config.deleteSpawnedPiSessionsOnCleanup, true);
  assert.deepEqual(config.review!.primaryReviewers, [
    { source: "external", id: "native" },
    { source: "pi", model: "openai/gpt-5", thinkingLevel: "medium" },
  ]);
  assert.deepEqual(config.review!.subtaskReviewers, opening.review!.subtaskReviewers);
  assert.equal(config.review!.primaryEnabled, true);
  assert.equal(config.review!.subtaskEnabled, false);
  assert.equal(config.review!.primaryClaudeCodeEnabled, true);
  assert.equal(config.review!.primaryCodexEnabled, false);
  assert.equal(config.review!.reviewLandedChanges, true);
  assert.deepEqual(config.review!.evidence, opening.review!.evidence);
  assert.deepEqual(config.execution!.routes, {
    execute: [{ resourceId: "native-r" }, { resourceId: "pi", thinkingLevel: "high" }],
    research: [{ resourceId: "native-r" }],
  });
  assert.equal(config.execution!.maxWorkers, 6);
  assert.deepEqual(config.execution!.retryPolicy, {
    maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8_000, jitter: false, maxSameIncidentRepeats: 3,
  });
  assert.equal(config.execution!.subtaskNotifications, "noisy");
  assert.equal(config.execution!.deferredPiTools, false);
  // Resource-level Pi thinking is menu-normalized away; route reasoning stays.
  assert.equal(Object.hasOwn(config.execution!.workerResources!.pi.selection, "thinkingLevel"), false);
  assert.deepEqual(config.execution!.workerResources!["native-r"], opening.execution!.workerResources!["native-r"]);
  assert.deepEqual(config.ui, opening.ui);
  assert.deepEqual(config.youShouldKnow, opening.youShouldKnow);
  assert.deepEqual(config.tools, opening.tools);
  assert.deepEqual(config.toolProtection, opening.toolProtection);
  assert.deepEqual(config.web!.browserPermissions, opening.web!.browserPermissions);
  assert.deepEqual(config.web!.urlBlocklist, opening.web!.urlBlocklist);
  assert.equal(config.web!.browserInteractionApproval, "automatically-deny");
  assert.equal(config.web!.browserIdleExpiryMinutes, 0);
  assert.equal(config.web!.browserDownloadRetention, 3);
  assert.equal(config.web!.browserVisible, true);
  assert.equal(config.web!.fetch.maxDownloadBytes, 1_234_567);

  // Scheduled tasks keep the full editable catalog, including workspace text.
  const nightly = { ...opening.scheduledTasks!.nightly } as Record<string, unknown>;
  delete nightly.unknownTaskField;
  assert.deepEqual(config.scheduledTasks, { nightly, dormant: opening.scheduledTasks!.dormant });
  assert.equal(config.scheduledTasks!.nightly.workspace, "~/owner/project");
  assert.equal(config.scheduledTasks!.nightly.instructions, "Run the owner check");
  assert.equal(config.scheduledTasks!.dormant.destination, "orchestrator-turn");
});

test("projection preserves the menu-visible legacy reasoning import without exporting argv", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  for (const id of ["native", "legacy-conflict", "legacy-role", "mixed-legacy"]) {
    const owner = resolvedExternalAgent(opening, id)!;
    const menu = resolvedExternalAgent(projected, id)!;
    assert.deepEqual(
      menuReasoningSemantics(owner, owner.adapter as "claude-cli" | "codex-cli"),
      menuReasoningSemantics(menu, menu.adapter as "claude-cli" | "codex-cli"),
      `reasoning import parity for ${id}`,
    );
  }
  // Recognized effort becomes the typed value the menu imports; unresolved
  // state travels as presentation metadata, never as a token.
  assert.equal(projected.externalAgents!.native.reasoningEffort, "high");
  assert.equal(projected.externalAgents!["legacy-conflict"].reasoningEffort, undefined);
  assert.equal(projected.externalAgents!["legacy-role"].reasoningEffort, undefined);
  const projectedAgents = projected.externalAgents as Record<string, { legacyReasoningImport?: unknown; review?: { legacyReasoningImport?: unknown } }>;
  assert.ok(projectedAgents["legacy-conflict"].legacyReasoningImport);
  assert.ok(projectedAgents["legacy-role"].review?.legacyReasoningImport);
  assert.equal(projected.externalAgents!["mixed-legacy"].reasoningEffort, "high");
  assert.ok(projectedAgents["mixed-legacy"].review?.legacyReasoningImport);
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("encode/decode round-trips menu values and reattaches only owner-held baselines and private env", () => {
  const opening = fixture();
  // The menu drafts over the projected opening, so emulate that view.
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  let clientDraft = changeExternalAgent(projected, "native", "renamed", projected.externalAgents!.native).config;
  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "native", "renamed", clientDraft.externalAgents!.renamed);
  const created = normalizeConfig({
    externalAgents: { created: { adapter: "codex-cli", model: "gpt-6-sol", execution: { model: "gpt-6-sol", timeoutMs: 4321 }, review: { model: "gpt-6-sol" } } },
  }).externalAgents!.created;
  clientDraft.externalAgents!.created = structuredClone(created);
  stageExternalAgentOperation(operations, projected, "created", "created", created, true);
  clientDraft = changeExternalAgent(clientDraft, "binary").config;
  stageExternalAgentOperation(operations, projected, "binary");

  // Other editable sections staged by the client.
  clientDraft.execution!.maxWorkers = 9;
  clientDraft.execution!.retryPolicy = { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 200, jitter: true, maxSameIncidentRepeats: 1 };
  clientDraft.review!.primaryEnabled = false;
  clientDraft.review!.primaryClaudeCodeEnabled = false;
  clientDraft.review!.primaryCodexEnabled = true;
  clientDraft.review!.reviewLandedChanges = false;
  clientDraft.web!.browserPermissions.yolo = false;
  clientDraft.web!.browserPermissions.modelUploads = false;
  clientDraft.web!.browserVisible = false;
  clientDraft.web!.fetch.maxDownloadBytes = 128 * 1024 * 1024;
  clientDraft.scheduledTasks!.nightly.workspace = "~/staged/project";
  clientDraft.scheduledTasks!.nightly.instructions = "Edited owner instructions";
  clientDraft.ui!.subtasksViewExpanded = false;
  clientDraft.youShouldKnow = { enabled: true, completionGuidance: false };
  clientDraft.tools = { topLevelDeny: ["Read"], executorDeny: [] };
  clientDraft.toolProtection = { ...stagedToolProtectionSettings(clientDraft), debug: false };

  const staged = stagedSave(opening, clientDraft, operations, { alreadyRunEdited: ["nightly", "forged-unknown-task"] });
  // Retention is staged only when explicitly edited (issue #729).
  staged.selection.waveArtifactTtlMs = 999_999;
  const intent = encodeRemoteReviewSettingsSaveIntent(staged);
  const wire = JSON.parse(JSON.stringify(intent)) as RemoteReviewSettingsSaveIntent;

  const serialized = JSON.stringify(wire);
  for (const forbidden of [
    "shared-env-secret",
    "review-env-secret",
    "exec-env-secret",
    "binary-env-secret",
    "command",
    "externalAgentOpening",
    "externalAgentReferenceBaselines",
    "scheduledTasksStagedFrom",
    "scheduledImageProvenance",
    "configPath",
    "cwd",
  ]) {
    assert.ok(!serialized.includes(forbidden), `wire intent leaked ${forbidden}`);
  }
  assert.equal(wire.externalAgents.find((operation) => operation.id === "native")!.definition!.execution!.timeoutMs, 1_234);
  assert.equal(wire.scheduledTasks.nightly.workspace, "~/staged/project");

  const decoded = decodeRemoteReviewSettingsSaveIntent(wire, opening, [], { deny: ["Read"] });
  const { selection, draftConfig } = decoded;

  // Owner-held baselines are recomputed, never accepted from the payload.
  assert.deepEqual(selection.externalAgentOpening, opening);
  assert.deepEqual(selection.scheduledTasksStagedFrom, Object.keys(opening.scheduledTasks!));
  assert.deepEqual(selection.scheduledTasksAlreadyRunEdited, ["nightly"]);
  assert.deepEqual(
    selection.externalAgentReferenceBaselines,
    Object.fromEntries(Object.keys(opening.externalAgents!).map((id) => [id, captureExternalAgentReferenceBaseline(opening, id)])),
  );
  assert.equal(selection.waveArtifactTtlMs, 999_999);

  // Staged values survive canonical normalization.
  assert.equal(selection.maxWorkers, 9);
  assert.deepEqual(selection.retryPolicy, { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 200, jitter: true, maxSameIncidentRepeats: 1 });
  assert.equal(selection.primaryEnabled, false);
  assert.equal(selection.primaryClaudeCodeEnabled, false);
  assert.equal(selection.primaryCodexEnabled, true);
  assert.equal(draftConfig.review!.primaryClaudeCodeEnabled, false);
  assert.equal(draftConfig.review!.primaryCodexEnabled, true);
  assert.equal(selection.reviewLandedChanges, false);
  assert.deepEqual(selection.primaryReviewers, [
    { source: "external", id: "renamed" },
    { source: "pi", model: "openai/gpt-5", thinkingLevel: "medium" },
  ]);
  assert.deepEqual(selection.subtaskReviewers, [{ source: "external", id: "legacy-conflict" }]);
  assert.equal(selection.webBrowserPermissions!.yolo, false);
  assert.equal(selection.webBrowserPermissions!.modelUploads, false);
  assert.equal(selection.browserVisible, false);
  assert.equal(selection.webMaxDownloadBytes, 134_217_728);
  assert.equal(selection.scheduledTasks.nightly.workspace, "~/staged/project");
  assert.equal(selection.scheduledTasks.nightly.instructions, "Edited owner instructions");
  assert.equal(selection.scheduledTasks.nightly.workerResourceId, "native-r");
  assert.equal(selection.scheduledTasks.nightly.review!.mode, "selected");
  assert.deepEqual((selection.scheduledTasks.nightly.review as { reviewers: unknown }).reviewers, [{ source: "external", id: "renamed" }]);
  assert.equal(selection.subtasksViewExpanded, false);
  assert.deepEqual(selection.youShouldKnow, { enabled: true, completionGuidance: false });
  assert.deepEqual(selection.tools, { topLevelDeny: ["Read"], executorDeny: [] });
  assert.deepEqual(selection.toolProtection, { ...stagedToolProtectionSettings(clientDraft), debug: false });
  assert.equal(selection.workerResources["native-r"].selection.source, "external");
  assert.equal((selection.workerResources["native-r"].selection as { id: string }).id, "renamed");
  assert.deepEqual(selection.executeRoute, clientDraft.execution!.routes!.execute);
  assert.deepEqual(selection.researchRoute, clientDraft.execution!.routes!.research);

  // Owner-side reconstruction: canonical native command, cleared args/protocol,
  // preserved env for surviving roles, owner baseline.
  const renameOperation = selection.externalAgentOperations!.find((operation) => operation.id === "native")!;
  assert.deepEqual(renameOperation.baseline, opening.externalAgents!.native);
  assert.equal(renameOperation.nextId, "renamed");
  assert.equal(renameOperation.definition!.command, "claude");
  assert.deepEqual(renameOperation.definition!.args, []);
  assert.deepEqual(renameOperation.definition!.env, { SHARED_TOKEN: "shared-env-secret", SHARED_EMPTY: "" });
  assert.deepEqual(renameOperation.definition!.execution!.env, { EXEC_TOKEN: "exec-env-secret" });
  assert.deepEqual(renameOperation.definition!.review!.env, { REVIEW_TOKEN: "review-env-secret" });
  assert.equal(renameOperation.definition!.execution!.protocol, undefined);
  assert.deepEqual(renameOperation.definition!.execution!.args, []);

  const createOperation = selection.externalAgentOperations!.find((operation) => operation.id === "created")!;
  assert.equal(createOperation.baseline, undefined);
  assert.equal(createOperation.definition!.command, "codex");
  assert.equal(createOperation.definition!.env, undefined);
  assert.equal(createOperation.definition!.execution!.env, undefined);

  const deleteOperation = selection.externalAgentOperations!.find((operation) => operation.id === "binary")!;
  assert.equal(deleteOperation.nextId, undefined);
  assert.deepEqual(deleteOperation.baseline, opening.externalAgents!.binary);

  // The draft catalog is the staged cascade, not the opening.
  assert.equal(draftConfig.externalAgents!.binary, undefined);
  assert.equal(draftConfig.externalAgents!.native, undefined);
  assert.equal(draftConfig.externalAgents!.renamed.command, "claude");
  assert.deepEqual(draftConfig.externalAgents!.renamed.env, opening.externalAgents!.native.env);
  assert.equal(draftConfig.externalAgents!.created.command, "codex");
  assert.equal(draftConfig.execution!.maxWorkers, 9);
  assert.equal(draftConfig.scheduledTasks!.nightly.instructions, "Edited owner instructions");
  assert.deepEqual(draftConfig.review!.primaryReviewers, selection.primaryReviewers);
  assert.equal(draftConfig.web!.browserVisible, false);
  assert.equal(draftConfig.toolProtection!.debug, false);
});

test("owner opening ids drive worker identification: edits, renames, deletions, creations, and re-creations", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;

  // A same-id role edit inherits the owner env.
  const edit = normalizeConfig({ externalAgents: { native: { adapter: "claude-cli", reasoningEffort: "default", model: "claude-opus-5-5", review: { model: "claude-haiku-4-5" }, execution: { model: "claude-sonnet-5-5", timeoutMs: 77_777 } } } }).externalAgents!.native;
  const editOperations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(editOperations, projected, "native", "native", edit);
  let decoded = roundTrip(opening, projected, editOperations).decoded;
  assert.deepEqual(decoded.selection.externalAgentOperations![0].baseline, opening.externalAgents!.native);
  assert.deepEqual(decoded.selection.externalAgentOperations![0].definition!.env, opening.externalAgents!.native.env);
  assert.deepEqual(decoded.selection.externalAgentOperations![0].definition!.execution!.env, opening.externalAgents!.native.execution!.env);
  assert.equal(decoded.selection.externalAgentOperations![0].definition!.execution!.timeoutMs, 77_777);

  // Deletion keeps the owner opening definition as its optimistic baseline.
  const deleteOperations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(deleteOperations, projected, "native");
  decoded = roundTrip(opening, projected, deleteOperations).decoded;
  assert.deepEqual(decoded.selection.externalAgentOperations![0].baseline, opening.externalAgents!.native);
  assert.equal(decoded.selection.externalAgentOperations![0].nextId, undefined);
  assert.equal(decoded.draftConfig.externalAgents!.native, undefined);

  // Delete then re-create the same id in one transaction: the composed menu
  // operation is a re-creation, so no owner env is inherited.
  const composed: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(composed, projected, "native");
  const recreated = normalizeConfig({ externalAgents: { native: { adapter: "claude-cli", review: { model: "claude-haiku-4-5" } } } }).externalAgents!.native;
  stageExternalAgentOperation(composed, projected, "native", "native", recreated, true);
  assert.equal(composed.length, 1);
  assert.equal(composed[0].createdInTransaction, true);
  const composedTrip = roundTrip(opening, projected, composed);
  // The re-creation crosses as the deletion it staged plus a fresh creation, so
  // the owner derives the opening baseline and never inherits private env.
  assert.equal(composedTrip.wire.externalAgents.length, 2);
  decoded = composedTrip.decoded;
  // The deletion keeps the owner opening baseline; the following creation has
  // no baseline and no inherited private env.
  assert.equal(decoded.selection.externalAgentOperations!.length, 2);
  assert.deepEqual(decoded.selection.externalAgentOperations![0].baseline, opening.externalAgents!.native);
  assert.equal(decoded.selection.externalAgentOperations![0].nextId, undefined);
  assert.equal(decoded.selection.externalAgentOperations![1].baseline, undefined);
  assert.equal(decoded.selection.externalAgentOperations![1].nextId, "native");
  assert.equal(decoded.selection.externalAgentOperations![1].definition!.env, undefined);
  assert.equal(decoded.selection.externalAgentOperations![1].definition!.review!.env, undefined);
  assert.equal(selectedAgent(decoded.draftConfig, "native").env, undefined);

  // Rename then create at the released id: two distinct lineages.
  const chain: ExternalAgentOperation[] = [];
  const renamedDefinition = normalizeConfig({ externalAgents: { renamed: { adapter: "claude-cli", reasoningEffort: "default", execution: { model: "claude-sonnet-5-5" } } } }).externalAgents!.renamed;
  stageExternalAgentOperation(chain, projected, "native", "renamed", renamedDefinition);
  const freshAtOldId = normalizeConfig({ externalAgents: { native: { adapter: "codex-cli", review: { model: "gpt-6-sol" } } } }).externalAgents!.native;
  stageExternalAgentOperation(chain, projected, "native", "native", freshAtOldId, true);
  assert.equal(chain.length, 2);
  decoded = roundTrip(opening, projected, chain).decoded;
  assert.equal(decoded.selection.externalAgentOperations![0].nextId, "renamed");
  assert.deepEqual(decoded.selection.externalAgentOperations![0].definition!.env, opening.externalAgents!.native.env);
  assert.deepEqual(decoded.selection.externalAgentOperations![1].baseline, undefined);
  assert.equal(decoded.selection.externalAgentOperations![1].definition!.env, undefined);
  assert.equal(selectedAgent(decoded.draftConfig, "renamed").command, "claude");
  assert.equal(selectedAgent(decoded.draftConfig, "native").command, "codex");

  // A creation renamed before Save keeps its creation lineage: no owner env,
  // no opening baseline, and the final destination identity.
  const createRename: ExternalAgentOperation[] = [];
  const fresh = normalizeConfig({ externalAgents: { fresh: { adapter: "codex-cli", review: { model: "gpt-6-sol" } } } }).externalAgents!.fresh;
  stageExternalAgentOperation(createRename, projected, "fresh", "fresh", fresh, true);
  stageExternalAgentOperation(createRename, projected, "fresh", "renamed-fresh", fresh);
  assert.equal(createRename.length, 1);
  const createRenameTrip = roundTrip(opening, projected, createRename);
  assert.equal(createRenameTrip.wire.externalAgents.length, 1);
  assert.equal(createRenameTrip.decoded.selection.externalAgentOperations![0].baseline, undefined);
  assert.equal(createRenameTrip.decoded.selection.externalAgentOperations![0].nextId, "renamed-fresh");
  assert.equal(selectedAgent(createRenameTrip.decoded.draftConfig, "renamed-fresh").env, undefined);
  assert.equal(selectedAgent(createRenameTrip.decoded.draftConfig, "fresh"), undefined);

  // Reusing a creation origin after its created agent was renamed away is a
  // legitimate second creation, not an edit of the first destination.
  const reusedOrigin: ExternalAgentOperation[] = [];
  const first = normalizeConfig({ externalAgents: { origin: { adapter: "codex-cli", review: {} }, renamed: { adapter: "codex-cli", review: {} } } }).externalAgents!;
  stageExternalAgentOperation(reusedOrigin, projected, "origin", "origin", first.origin, true);
  stageExternalAgentOperation(reusedOrigin, projected, "origin", "renamed", first.renamed);
  stageExternalAgentOperation(reusedOrigin, projected, "origin", "origin", first.origin, true);
  assert.deepEqual(reusedOrigin.map((operation) => [operation.id, operation.nextId]), [["origin", "renamed"], ["origin", "origin"]]);
  const reused = roundTrip(opening, projected, reusedOrigin).decoded;
  assert.deepEqual(reused.selection.externalAgentOperations!.map((operation) => [operation.id, operation.nextId]), [["origin", "renamed"], ["origin", "origin"]]);
  assert.equal(selectedAgent(reused.draftConfig, "renamed").command, "codex");
  assert.equal(selectedAgent(reused.draftConfig, "origin").command, "codex");

  // Create then delete inside one session is a native no-op and crosses as no
  // step at all (rather than being mistaken for deleting an unknown worker).
  const createdThenDeleted: ExternalAgentOperation[] = [];
  const temporary = normalizeConfig({ externalAgents: { temporary: { adapter: "codex-cli", review: {} } } }).externalAgents!.temporary;
  stageExternalAgentOperation(createdThenDeleted, projected, "temporary", "temporary", temporary, true);
  stageExternalAgentOperation(createdThenDeleted, projected, "temporary", undefined, undefined);
  assert.deepEqual(createdThenDeleted, [{ id: "temporary", baseline: undefined, nextId: undefined, definition: undefined, createdInTransaction: true }]);
  const noOp = roundTrip(opening, projected, createdThenDeleted);
  assert.deepEqual(noOp.wire.externalAgents, []);
  assert.deepEqual(noOp.decoded.selection.externalAgentOperations, []);
  assert.equal(selectedAgent(noOp.decoded.draftConfig, "temporary"), undefined);
});

test("composed worker swaps decode as one release-then-install transaction and persist", async () => {
  const opening = normalizeConfig({
    enabled: false,
    externalAgents: {
      A: {
        adapter: "claude-cli",
        command: "claude",
        model: "claude-opus-5-5",
        env: { A_ENV: "a-env-secret" },
        review: { model: "claude-sonnet-5-5", env: { A_REVIEW_ENV: "a-review-env-secret" } },
        execution: { model: "claude-sonnet-5-5" },
      },
      B: {
        adapter: "claude-cli",
        command: "claude",
        model: "claude-opus-5-5",
        env: { B_ENV: "b-env-secret" },
        review: { model: "claude-sonnet-5-5" },
        execution: { model: "claude-sonnet-5-5", env: { B_EXEC_ENV: "b-exec-env-secret" } },
      },
    },
    execution: {
      workerResources: {
        rA: { selection: { source: "external", id: "A" }, maxConcurrent: 1 },
        rB: { selection: { source: "external", id: "B" }, maxConcurrent: 1 },
      },
      routes: { execute: [{ resourceId: "rA" }, { resourceId: "rB" }], research: [] },
    },
    review: {
      primaryReviewers: [{ source: "external", id: "A" }, { source: "external", id: "B" }],
      subtaskReviewers: [],
      primaryEnabled: true,
      subtaskEnabled: true,
    },
  });
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  // Stage the swap through the temporary id exactly as the native menu does.
  let draft = changeExternalAgent(projected, "A", "temp", projected.externalAgents!.A).config;
  draft = changeExternalAgent(draft, "B", "A", projected.externalAgents!.B).config;
  draft = changeExternalAgent(draft, "temp", "B", projected.externalAgents!.A).config;
  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "A", "temp", projected.externalAgents!.A);
  stageExternalAgentOperation(operations, projected, "B", "A", projected.externalAgents!.B);
  stageExternalAgentOperation(operations, projected, "temp", "B", projected.externalAgents!.A);
  // Composition has already collapsed the temporary id.
  assert.deepEqual(operations.map((operation) => [operation.id, operation.nextId]), [["A", "B"], ["B", "A"]]);

  const { wire, decoded } = roundTrip(opening, draft, operations);
  assert.equal(wire.externalAgents.length, 2);
  assert.deepEqual(decoded.selection.externalAgentOperations!.map((operation) => [operation.id, operation.nextId]), [["A", "B"], ["B", "A"]]);
  assert.deepEqual(decoded.selection.externalAgentOperations![0].baseline, opening.externalAgents!.A);
  assert.deepEqual(decoded.selection.externalAgentOperations![1].baseline, opening.externalAgents!.B);

  // Release-then-install: A now carries B's definition (and private env), and
  // B carries A's; the swap is not mistaken for a destination collision.
  assert.deepEqual(selectedAgent(decoded.draftConfig, "A").env, { B_ENV: "b-env-secret" });
  assert.deepEqual(selectedAgent(decoded.draftConfig, "A").execution!.env, { B_EXEC_ENV: "b-exec-env-secret" });
  assert.deepEqual(selectedAgent(decoded.draftConfig, "B").env, { A_ENV: "a-env-secret" });
  assert.deepEqual(selectedAgent(decoded.draftConfig, "B").review!.env, { A_REVIEW_ENV: "a-review-env-secret" });
  assert.deepEqual(
    decoded.selection.primaryReviewers,
    [{ source: "external", id: "B" }, { source: "external", id: "A" }],
  );
  assert.equal((decoded.selection.workerResources!.rA.selection as { id: string }).id, "B");
  assert.equal((decoded.selection.workerResources!.rB.selection as { id: string }).id, "A");

  const dir = await mkdtemp(join(__dirname, "remote-settings-swap-"));
  try {
    const path = join(dir, "review-gate.json");
    await writeFile(path, JSON.stringify(opening, null, 2), "utf8");
    const persisted = await persistReviewSettings(path, decoded.selection);
    assert.deepEqual(persisted.externalAgents!.A.env, { B_ENV: "b-env-secret" });
    assert.deepEqual(persisted.externalAgents!.B.env, { A_ENV: "a-env-secret" });
    assert.equal((persisted.execution!.workerResources!.rA.selection as { id: string }).id, "B");
    assert.equal((persisted.execution!.workerResources!.rB.selection as { id: string }).id, "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paired creations may reuse each other's historical creation ids", async () => {
  const opening = normalizeConfig({ enabled: false });
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const definitions = normalizeConfig({
    externalAgents: {
      U: { adapter: "codex-cli", review: { model: "gpt-6-sol" } },
      T: { adapter: "codex-cli", review: { model: "gpt-6-sol" } },
    },
  }).externalAgents!;
  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "U", "U", definitions.U, true);
  stageExternalAgentOperation(operations, projected, "T", "T", definitions.T, true);
  stageExternalAgentOperation(operations, projected, "T", "X", definitions.T);
  stageExternalAgentOperation(operations, projected, "U", "T", definitions.U);
  assert.deepEqual(operations.map((operation) => [operation.id, operation.nextId]), [["U", "T"], ["T", "X"]]);
  assert.ok(operations.every((operation) => operation.baseline === undefined));

  const { wire, decoded } = roundTrip(opening, projected, operations);
  assert.equal(wire.externalAgents.length, 2);
  assert.deepEqual(decoded.selection.externalAgentOperations!.map((operation) => [operation.id, operation.nextId]), [["U", "T"], ["T", "X"]]);
  assert.ok(decoded.selection.externalAgentOperations!.every((operation) => operation.baseline === undefined));
  assert.equal(selectedAgent(decoded.draftConfig, "U"), undefined);
  assert.equal(selectedAgent(decoded.draftConfig, "T").review!.model, "gpt-6-sol");
  assert.equal(selectedAgent(decoded.draftConfig, "X").review!.model, "gpt-6-sol");

  const dir = await mkdtemp(join(__dirname, "remote-settings-pair-"));
  try {
    const path = join(dir, "review-gate.json");
    await writeFile(path, JSON.stringify(opening, null, 2), "utf8");
    const persisted = await persistReviewSettings(path, decoded.selection);
    assert.equal(persisted.externalAgents!.U, undefined);
    assert.equal(persisted.externalAgents!.T.review!.model, "gpt-6-sol");
    assert.equal(persisted.externalAgents!.X.review!.model, "gpt-6-sol");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rejection of untrusted payloads
// ---------------------------------------------------------------------------

/** A wire intent with an untouched, valid staged selection. */
function validWire(): RemoteReviewSettingsSaveIntent {
  const opening = fixture();
  return JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, opening))));
}

test("remote tool-name edits use offered choices and retain opening names per picker", () => {
  const opening = fixture();
  const choices = { deny: ["Read"], audit: ["Write", "tool_search"] };
  const wire = validWire();
  wire.tools.topLevelDeny = ["Bash", "Read"];
  wire.toolProtection.toolNames = ["Bash", "Write"];
  const { selection } = decodeRemoteReviewSettingsSaveIntent(wire, opening, [], choices);
  assert.deepEqual(selection.tools!.topLevelDeny, ["Bash", "Read"]);
  assert.deepEqual(selection.toolProtection.toolNames, ["Bash", "Write"]);

  for (const name of ["not-offered", "tool_search"]) {
    const forged = structuredClone(wire);
    forged.toolProtection.toolNames = [name];
    assertDataError(() => decodeRemoteReviewSettingsSaveIntent(forged, opening, [], choices), /toolProtection\.toolNames/);
  }
  const forged = structuredClone(wire);
  forged.tools.executorDeny = ["Bash"]; // Retained only in the top-level picker.
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(forged, opening, [], choices), /tools\.executorDeny/);

  // An edited selected-scope audit subset may not drop the last auditable name.
  const coverageOpening = normalizeConfig({
    enabled: false,
    toolProtection: {
      level: "aligned",
      auditor: { source: "external", id: "native" },
      scope: "selected",
      toolNames: ["Bash", "tool_search"],
      timeoutMs: 10_000,
      maxContextChars: 128_000,
      retainAuditorSessions: false,
      debug: false,
    },
  });
  const coverageWire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(coverageOpening, projectRemoteReviewSettingsOpening(coverageOpening).config))));
  const coverageDecoded = decodeRemoteReviewSettingsSaveIntent(coverageWire, coverageOpening);
  assert.deepEqual(coverageDecoded.selection.toolProtection!.toolNames, ["Bash", "tool_search"]);

  const loaderOnly = structuredClone(coverageWire);
  loaderOnly.toolProtection.toolNames = ["tool_search"];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(loaderOnly, coverageOpening), /auditable name/);

  const allCalls = structuredClone(coverageWire);
  allCalls.toolProtection.scope = "all";
  assert.deepEqual(decodeRemoteReviewSettingsSaveIntent(allCalls, coverageOpening).selection.toolProtection!.toolNames, ["Bash", "tool_search"]);

  const allCallsLoaderOnly = structuredClone(loaderOnly);
  allCallsLoaderOnly.toolProtection.scope = "all";
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(allCallsLoaderOnly, coverageOpening), /auditable name/);

  const auditableOnly = structuredClone(coverageWire);
  auditableOnly.toolProtection.toolNames = ["Bash"];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(auditableOnly, coverageOpening), /retain the opening discovery loader name/);
  auditableOnly.toolProtection.scope = "all";
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(auditableOnly, coverageOpening), /retain the opening discovery loader name/);

  const editedSubset = structuredClone(coverageWire);
  editedSubset.toolProtection.toolNames = ["Write", "tool_search"];
  assert.deepEqual(decodeRemoteReviewSettingsSaveIntent(editedSubset, coverageOpening, [], choices).selection.toolProtection!.toolNames, ["Write", "tool_search"]);

  const loaderOnlyOpening = normalizeConfig({
    enabled: false,
    toolProtection: { ...coverageOpening.toolProtection!, toolNames: ["tool_search"] },
  });
  const loaderOnlyWire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(loaderOnlyOpening, projectRemoteReviewSettingsOpening(loaderOnlyOpening).config))));
  assert.deepEqual(decodeRemoteReviewSettingsSaveIntent(loaderOnlyWire, loaderOnlyOpening).selection.toolProtection!.toolNames, ["tool_search"]);
});

test("decode rejects unknown and forged top-level fields, baselines, paths, and provenance", () => {
  const opening = fixture();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["external opening baseline", { externalAgentOpening: structuredClone(opening) }],
    ["reference baselines", { externalAgentReferenceBaselines: { native: {} } }],
    ["schedule staged-from", { scheduledTasksStagedFrom: ["nightly"] }],
    ["config path", { configPath: "/owner/review-gate.json" }],
    ["working directory", { cwd: "/owner" }],
    ["scoped models", { scoped: [] }],
    ["image provenance", { scheduledImageProvenance: {} }],
    ["beforePersist hook", { beforePersist: () => undefined }],
    ["unknown field", { futureField: true }],
    ["version", { version: 99 }],
  ];
  for (const [label, patch] of cases) {
    assertDataError(() => decodeRemoteReviewSettingsSaveIntent({ ...validWire(), ...patch }, opening), undefined);
    void label;
  }
});

test("decode rejects forged private worker fields and unsupported adapter edits on the wire", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const operations: ExternalAgentOperation[] = [];
  const edit = normalizeConfig({ externalAgents: { native: { adapter: "claude-cli", reasoningEffort: "default", review: {} } } }).externalAgents!.native;
  stageExternalAgentOperation(operations, projected, "native", "native", edit);
  const base = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, projected, operations))));

  const cases: Array<[string, (wire: any) => void]> = [
    ["baseline", (wire) => { wire.externalAgents[0].baseline = opening.externalAgents!.native; }],
    ["command", (wire) => { wire.externalAgents[0].definition.command = "/bin/evil"; }],
    ["args", (wire) => { wire.externalAgents[0].definition.args = ["--secret"]; }],
    ["env", (wire) => { wire.externalAgents[0].definition.env = { STOLEN: "x" }; }],
    ["role args", (wire) => { wire.externalAgents[0].definition.review.args = ["--secret"]; }],
    ["role env", (wire) => { wire.externalAgents[0].definition.review.env = { STOLEN: "x" }; }],
    ["role protocol", (wire) => { wire.externalAgents[0].definition.review.protocol = "pi-reviewer-json-v1"; }],
    ["unknown adapter", (wire) => { wire.externalAgents[0].definition.adapter = "generic-cli"; }],
    ["unsupported adapter edit", (wire) => { wire.externalAgents[0].id = "binary"; wire.externalAgents[0].nextId = "binary"; }],
  ];
  for (const [label, mutate] of cases) {
    const wire = structuredClone(base);
    mutate(wire);
    assertDataError(() => decodeRemoteReviewSettingsSaveIntent(wire, opening), undefined);
    void label;
  }

  // Deleting an unknown worker and a definition-less rename are not
  // menu-producible. A definition at an unseen id is a creation (possibly
  // renamed before Save), which the owner keeps as creation lineage.
  const unknownDelete = structuredClone(base);
  unknownDelete.externalAgents = [{ id: "missing-worker" }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(unknownDelete, opening), /not live/);
  const destinationOnly = structuredClone(base);
  destinationOnly.externalAgents = [{ id: "native", nextId: "renamed" }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(destinationOnly, opening), /no definition/);
  const missingDestination = structuredClone(base);
  missingDestination.externalAgents = [{ id: "native", definition: { adapter: "claude-cli", review: {} } }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(missingDestination, opening), /no destination id/);
  const collision = structuredClone(base);
  collision.externalAgents = [{ id: "native", nextId: "legacy-conflict", definition: { adapter: "claude-cli", reasoningEffort: "default", review: {} } }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(collision, opening), /still has/);

  // A same-ID edit and a rename of that opening worker are one composed menu
  // operation, so two wire steps cannot both claim its opening definition.
  const duplicateClaim = structuredClone(base);
  duplicateClaim.externalAgents = [
    { id: "native", nextId: "native", definition: { adapter: "claude-cli", reasoningEffort: "default", model: "claude-opus-5-5", review: {}, execution: {} } },
    { id: "native", nextId: "renamed", definition: { adapter: "claude-cli", reasoningEffort: "default", model: "claude-opus-5-5", review: {}, execution: {} } },
  ];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(duplicateClaim, opening), /already edited/);
});

test("a pre-change v1 save intent is refused at the version gate, never as a missing field", () => {
  const opening = fixture();
  // Exactly what a peer from before the per-provider toggles sends: the v1
  // generation, and a closed review block that never carried the two fields.
  const legacy = validWire() as unknown as Record<string, unknown>;
  legacy.version = 1;
  delete legacy.primaryClaudeCodeEnabled;
  delete legacy.primaryCodexEnabled;
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(legacy as never, opening), /save intent has an unsupported version/);

  // The current generation carries both fields, so the same intent decodes.
  const current = validWire();
  assert.equal(current.primaryClaudeCodeEnabled, true);
  assert.equal(current.primaryCodexEnabled, false);
  const decoded = decodeRemoteReviewSettingsSaveIntent(current, opening);
  assert.equal(decoded.selection.primaryClaudeCodeEnabled, true);
  assert.equal(decoded.selection.primaryCodexEnabled, false);
});

test("decode rejects malformed categories and keeps forged already-run ids out of known task metadata", () => {
  const opening = fixture();
  const base = validWire();
  const cases: Array<[string, (wire: any) => void]> = [
    ["operating mode", (wire) => { wire.operatingMode = "launch"; }],
    ["shortcut", (wire) => { wire.modeCycleShortcut = ""; }],
    ["timeout", (wire) => { wire.reviewerTimeoutMs = -1; }],
    ["max workers", (wire) => { wire.maxWorkers = 0; }],
    ["retry jitter", (wire) => { wire.retryPolicy.jitter = "yes"; }],
    ["retry delay", (wire) => { wire.retryPolicy.maxDelayMs = 1; wire.retryPolicy.baseDelayMs = 2; }],
    ["reviewer source", (wire) => { wire.primaryReviewers = [{ source: "human", id: "x" }]; }],
    ["pi reviewer id", (wire) => { wire.primaryReviewers = [{ source: "pi", model: "openai/gpt-5", id: "x" }]; }],
    ["evidence flag", (wire) => { wire.evidence.primaryToolOnly = "yes"; }],
    ["worker selection", (wire) => { wire.workerResources.pi.selection.source = "robot"; }],
    ["worker duplicate selection", (wire) => { wire.workerResources["external-native"] = { selection: { source: "external", id: "native" }, maxConcurrent: 1 }; }],
    ["route unknown resource", (wire) => { wire.executeRoute[0].resourceId = "missing"; }],
    ["route duplicate", (wire) => { wire.executeRoute.push({ ...wire.executeRoute[0] }); }],
    ["route thinking", (wire) => { wire.executeRoute[0].thinkingLevel = "impossible"; }],
    ["browser approval", (wire) => { wire.browserInteractionApproval = "maybe"; }],
    ["browser permission", (wire) => { wire.webBrowserPermissions.modelUploads = 1; }],
    ["browser permission unknown", (wire) => { wire.webBrowserPermissions.sudo = true; }],
    ["browser idle", (wire) => { wire.browserIdleExpiryMinutes = -1; }],
    ["url blocklist", (wire) => { wire.webUrlBlocklist = ["("]; }],
    ["you should know", (wire) => { wire.youShouldKnow.enabled = "yes"; }],
    ["tool deny list", (wire) => { wire.tools.topLevelDeny = [5]; }],
    ["reserved deny", (wire) => { wire.tools.executorDeny = ["tool_search"]; }],
    ["tool protection level", (wire) => { wire.toolProtection.level = "maximum"; }],
    ["tool protection auditor", (wire) => { wire.toolProtection.auditor = { source: "external", id: "native", baseline: {} }; }],
    ["tool protection unknown", (wire) => { wire.toolProtection.extra = true; }],
    ["scheduled kind", (wire) => { wire.scheduledTasks.nightly.kind = "daemon"; }],
    ["scheduled unknown key", (wire) => { wire.scheduledTasks.nightly.unknownTaskField = "x"; }],
    ["scheduled review mode", (wire) => { wire.scheduledTasks.nightly.review = { mode: "sometimes" }; }],
    ["scheduled one shot", (wire) => { wire.scheduledTasks.nightly.oneShot = "yes"; }],
    ["scheduled worker id", (wire) => { wire.scheduledTasks.nightly.workerResourceId = "bad id"; }],
    ["invalid nonblank cron with blank instructions", (wire) => { wire.scheduledTasks.nightly.cron = "not-a-cron"; wire.scheduledTasks.nightly.instructions = ""; }],
    ["invalid reviewer thinking on complete orchestrator entry", (wire) => { wire.scheduledTasks.dormant.review = { mode: "selected", reviewers: [{ source: "pi", model: "openai/gpt-5", thinkingLevel: "impossible" }] }; }],
    ["invalid reviewer thinking with blank instructions", (wire) => { wire.scheduledTasks.dormant.instructions = ""; wire.scheduledTasks.dormant.review = { mode: "selected", reviewers: [{ source: "pi", model: "openai/gpt-5", thinkingLevel: "impossible" }] }; }],
    ["scheduled task id", (wire) => { wire.scheduledTasks["bad id"] = { ...wire.scheduledTasks.nightly }; }],
    ["map scheduled catalog", (wire) => { wire.scheduledTasks = new Map(); }],
    ["date scheduled catalog", (wire) => { wire.scheduledTasks = new Date(); }],
    ["map worker catalog", (wire) => { wire.workerResources = new Map(); }],
    ["already-run type", (wire) => { wire.scheduledTasksAlreadyRunEdited = ["nightly", 5]; }],
    ["missing required field", (wire) => { delete wire.maxWorkers; }],
    ["native provider toggle value", (wire) => { wire.primaryClaudeCodeEnabled = "yes"; }],
    ["missing native provider toggle", (wire) => { delete wire.primaryCodexEnabled; }],
    ["external agent id", (wire) => { wire.externalAgents = [{ id: 12 }]; }],
    ["external role timeout", (wire) => { wire.externalAgents = [{ id: "native", nextId: "native", definition: { adapter: "claude-cli", review: {}, execution: { timeoutMs: "long" } } }]; }],
  ];
  for (const [label, mutate] of cases) {
    const wire = structuredClone(base);
    mutate(wire);
    assertDataError(() => decodeRemoteReviewSettingsSaveIntent(wire, opening), undefined);
    void label;
  }

  const forged = structuredClone(base);
  forged.scheduledTasksAlreadyRunEdited = ["nightly", "forged-unknown-task"];
  const decoded = decodeRemoteReviewSettingsSaveIntent(forged, opening);
  assert.deepEqual(decoded.selection.scheduledTasksAlreadyRunEdited, ["nightly"]);
});

test("a new empty selected-reviewer schedule override is rejected but a legacy opening one is retained", () => {
  const opening = fixture();
  const wire = validWire();
  wire.scheduledTasks.dormant.review = { mode: "selected", reviewers: [] };
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(wire, opening), /select at least one reviewer/);

  const newWire = validWire();
  newWire.scheduledTasks["task-0123abcd"] = { ...newWire.scheduledTasks.dormant, review: { mode: "selected", reviewers: [] } };
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(newWire, opening), /select at least one reviewer/);

  const legacyOpening = normalizeConfig({
    enabled: false,
    scheduledTasks: {
      legacyEmpty: {
        name: "Legacy empty override",
        cron: "0 * * * *",
        enabled: false,
        kind: "execute",
        destination: "orchestrator-turn",
        instructions: "Keep",
        workspace: "",
        review: { mode: "selected", reviewers: [] },
      },
    },
  });
  const legacyProjected = projectRemoteReviewSettingsOpening(legacyOpening).config;
  const legacyDecoded = roundTrip(legacyOpening, legacyProjected).decoded;
  assert.deepEqual(legacyDecoded.selection.scheduledTasks!.legacyEmpty.review, { mode: "selected", reviewers: [] });
});

test("encode refuses scheduled image provenance and non-lineage additions instead of losing them", () => {
  const opening = fixture();
  const staged: StagedPersistedSave = {
    ...stagedSave(opening, opening),
    scheduledImageProvenance: new Map([["nightly", ["/tmp/pasted-image.png"]]]),
  };
  assertDataError(() => encodeRemoteReviewSettingsSaveIntent(staged), /image attachments/);

  const additions: StagedPersistedSave = stagedSave(opening, opening);
  additions.selection.externalAgentAdditions = {
    added: { adapter: "codex-cli", command: "codex", review: {} },
  };
  assertDataError(() => encodeRemoteReviewSettingsSaveIntent(additions), /lineage/);
});

// ---------------------------------------------------------------------------
// Legacy reasoning parity through the real editor
// ---------------------------------------------------------------------------

function editorScript(actions: Array<string | undefined>, edits: Array<string | undefined> = []) {
  const notices: string[] = [];
  const ui: UiContext = {
    async select(title, options) {
      assert.ok(actions.length > 0, `unexpected menu: ${title}`);
      const action = actions.shift();
      if (action === undefined) return undefined;
      const row = options.find((option) => option.startsWith(action));
      assert.ok(row, `missing row "${action}" in ${title}: ${options.join(" | ")}`);
      return row;
    },
    async editor() {
      assert.ok(edits.length > 0);
      return edits.shift();
    },
    notify(message) {
      notices.push(message);
    },
  };
  return {
    ui,
    notices,
    consumed() {
      assert.equal(actions.length, 0, "unconsumed menu actions");
      assert.equal(edits.length, 0, "unconsumed edits");
    },
  };
}

test("legacy shared reasoning keeps its unresolved Apply guard and resolves through the real editor", async () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const existing = resolvedExternalAgent(projected, "legacy-conflict")!;
  const script = editorScript([
    "Apply edit",
    "Shared reasoning:",
    "CLI default (no app-owned effort flag)",
    "Apply edit",
  ]);
  const result = await selectExternalAgentEdit(script.ui, projected, existing);
  assert.ok(result?.kind === "apply");
  assert.ok(script.notices.some((notice) => notice.includes("Cannot apply: resolve invalid reasoning")));
  assert.equal(result.agent.reasoningEffort, "default");
  assert.deepEqual(result.agent.args, []);

  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "legacy-conflict", "legacy-conflict", {
    adapter: result.agent.adapter,
    command: result.agent.command,
    reasoningEffort: result.agent.reasoningEffort,
    args: result.agent.args,
    model: result.agent.model,
    execution: result.agent.execution,
  });
  const decoded = roundTrip(opening, projected, operations).decoded;
  const definition = decoded.selection.externalAgentOperations![0].definition!;
  assert.equal(definition.command, "claude");
  assert.equal(definition.reasoningEffort, "default");
  assert.deepEqual(definition.args, []);
  assert.deepEqual(definition.env, { CONFLICT_TOKEN: "conflict-env-secret" });
  assert.deepEqual(definition.execution!.env, { CONFLICT_EXEC_TOKEN: "conflict-exec-env-secret" });

  // A wire edit that silently drops the unresolved state is rejected.
  const forgedOperations: ExternalAgentOperation[] = [];
  const projectedDefinition = projected.externalAgents!["legacy-conflict"];
  stageExternalAgentOperation(forgedOperations, projected, "legacy-conflict", "legacy-conflict", {
    adapter: projectedDefinition.adapter,
    command: "claude",
    model: projectedDefinition.model,
    execution: projectedDefinition.execution,
  });
  assertDataError(
    () => roundTrip(opening, projected, forgedOperations),
    /unresolved shared legacy reasoning/,
  );
  script.consumed();
});

test("recognized shared legacy effort does not hide a conflicting role's unresolved editor state", async () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const existing = resolvedExternalAgent(projected, "mixed-legacy")!;
  const script = editorScript([
    "Apply edit",
    "Advanced review overrides",
    "Reasoning:",
    "Inherit shared reasoning",
    "Back",
    "Apply edit",
  ]);
  const result = await selectExternalAgentEdit(script.ui, projected, existing);
  assert.ok(result?.kind === "apply");
  assert.ok(script.notices.some((notice) => notice.includes("Cannot apply: resolve invalid reasoning")));
  assert.equal(result.agent.review!.reasoningEffort, undefined);
  assert.equal((result.agent.review as unknown as { legacyReasoningInherited?: boolean }).legacyReasoningInherited, true);

  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "mixed-legacy", "mixed-legacy", result.agent);
  const { wire, decoded } = roundTrip(opening, projected, operations);
  assert.equal(wire.externalAgents[0].definition!.reasoningEffort, "high");
  assert.equal(wire.externalAgents[0].definition!.review!.inheritsReasoning, true);
  const definition = decoded.selection.externalAgentOperations![0].definition!;
  assert.equal(definition.reasoningEffort, "high");
  assert.equal(definition.review!.reasoningEffort, undefined);
  assert.deepEqual(definition.review!.env, { MIXED_REVIEW_TOKEN: "mixed-review-env-secret" });

  // The promoted shared typed effort cannot stand in for resolving the role.
  const projectedDefinition = projected.externalAgents!["mixed-legacy"];
  const forged: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(forged, projected, "mixed-legacy", "mixed-legacy", {
    adapter: projectedDefinition.adapter,
    command: "claude",
    model: projectedDefinition.model,
    reasoningEffort: projectedDefinition.reasoningEffort,
    review: { model: projectedDefinition.review!.model },
    execution: projectedDefinition.execution,
  });
  assertDataError(() => roundTrip(opening, projected, forged), /unresolved review legacy reasoning/);
  script.consumed();
});

test("a surviving worker cannot clear opening shared reasoning by omission", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const sharedless = normalizeConfig({
    externalAgents: { native: { adapter: "claude-cli", command: "claude", model: "claude-opus-5-5", review: { model: "claude-sonnet-5-5" }, execution: { model: "claude-sonnet-5-5" } } },
  }).externalAgents!.native;
  const explicitDefault = normalizeConfig({
    externalAgents: { native: { adapter: "claude-cli", command: "claude", reasoningEffort: "default", model: "claude-opus-5-5", review: { model: "claude-sonnet-5-5" }, execution: { model: "claude-sonnet-5-5" } } },
  }).externalAgents!.native;

  // Recognized legacy shared effort: omission would clear it and its argv.
  const omittedLegacy: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(omittedLegacy, projected, "native", "native", sharedless);
  assertDataError(() => roundTrip(opening, projected, omittedLegacy), /retain or explicitly replace shared reasoning/);

  const explicitLegacy: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(explicitLegacy, projected, "native", "native", explicitDefault);
  assert.equal(
    roundTrip(opening, projected, explicitLegacy).decoded.selection.externalAgentOperations![0].definition!.reasoningEffort,
    "default",
  );

  // Already-typed opening effort: omission is still not an editor action.
  const typedOpening = normalizeConfig({
    enabled: false,
    externalAgents: {
      typed: { adapter: "claude-cli", command: "claude", model: "claude-opus-5-5", reasoningEffort: "high", review: { model: "claude-sonnet-5-5" }, execution: { model: "claude-sonnet-5-5" } },
    },
  });
  const typedProjected = projectRemoteReviewSettingsOpening(typedOpening).config;
  const omittedTyped: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(omittedTyped, typedProjected, "typed", "typed", sharedless);
  assertDataError(() => roundTrip(typedOpening, typedProjected, omittedTyped), /retain or explicitly replace shared reasoning/);

  const explicitTyped: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(explicitTyped, typedProjected, "typed", "typed", explicitDefault);
  assert.equal(
    roundTrip(typedOpening, typedProjected, explicitTyped).decoded.selection.externalAgentOperations![0].definition!.reasoningEffort,
    "default",
  );
});

test("legacy role reasoning unresolved state is enforced and can inherit or resolve explicitly", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const existing = resolvedExternalAgent(projected, "legacy-role")!;
  const script = editorScript([
    "Apply edit",
    "Advanced review overrides",
    "Reasoning:",
    "CLI default (no app-owned effort flag)",
    "Back",
    "Apply edit",
  ]);
  return (async () => {
    const result = await selectExternalAgentEdit(script.ui, projected, existing);
    assert.ok(result?.kind === "apply");
    assert.ok(script.notices.some((notice) => notice.includes("Cannot apply: resolve invalid reasoning")));
    assert.equal(result.agent.review!.reasoningEffort, "default");
    assert.deepEqual(result.agent.review!.args, []);

    const operations: ExternalAgentOperation[] = [];
    stageExternalAgentOperation(operations, projected, "legacy-role", "legacy-role", result.agent);
    const decoded = roundTrip(opening, projected, operations).decoded;
    assert.deepEqual(decoded.selection.externalAgentOperations![0].definition!.review!.env, { ROLE_CONFLICT_TOKEN: "role-conflict-secret" });
    assert.equal(decoded.selection.externalAgentOperations![0].definition!.review!.reasoningEffort, "default");
    assert.deepEqual(decoded.selection.externalAgentOperations![0].definition!.review!.args, []);

    const projectedDefinition = projected.externalAgents!["legacy-role"];
    const forgedOperations: ExternalAgentOperation[] = [];
    stageExternalAgentOperation(forgedOperations, projected, "legacy-role", "legacy-role", {
      adapter: projectedDefinition.adapter,
      command: "codex",
      model: projectedDefinition.model,
      review: { model: projectedDefinition.review!.model },
    });
    assertDataError(
      () => roundTrip(opening, projected, forgedOperations),
      /unresolved review legacy reasoning/,
    );
    script.consumed();
  })();
});

test("explicit Inherit shared reasoning with no shared effort round-trips as a real edit", async () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const existing = resolvedExternalAgent(projected, "legacy-role")!;
  const script = editorScript([
    "Apply edit",
    "Advanced review overrides",
    "Reasoning:",
    "Inherit shared reasoning",
    "Back",
    "Apply edit",
  ]);
  const result = await selectExternalAgentEdit(script.ui, projected, existing);
  assert.ok(result?.kind === "apply");
  assert.equal(result.agent.review!.reasoningEffort, undefined);
  assert.equal((result.agent.review as unknown as { legacyReasoningInherited?: boolean }).legacyReasoningInherited, true);

  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "legacy-role", "legacy-role", result.agent);
  const { wire, decoded } = roundTrip(opening, projected, operations);
  assert.equal(wire.externalAgents[0].definition!.review!.inheritsReasoning, true);
  const definition = decoded.selection.externalAgentOperations![0].definition!;
  assert.equal(definition.review!.reasoningEffort, undefined);
  assert.deepEqual(definition.review!.env, { ROLE_CONFLICT_TOKEN: "role-conflict-secret" });
  assert.deepEqual(definition.review!.args, []);
  script.consumed();
});

test("a removed and re-added role is fresh: no owner env is inherited, while a surviving role keeps it", async () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const existing = resolvedExternalAgent(projected, "native")!;
  const script = editorScript([
    "Roles:",
    "Review only",
    "Roles:",
    "Execution and review",
    "Apply edit",
  ]);
  const result = await selectExternalAgentEdit(script.ui, projected, existing);
  assert.ok(result?.kind === "apply");
  assert.equal((result.agent.execution as unknown as { roleCreatedInSession?: boolean }).roleCreatedInSession, true);
  assert.equal((result.agent.review as unknown as { roleCreatedInSession?: boolean }).roleCreatedInSession, undefined);

  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "native", "native", result.agent);
  const { wire, decoded } = roundTrip(opening, projected, operations);
  assert.equal(wire.externalAgents[0].definition!.execution!.fresh, true);
  assert.equal(wire.externalAgents[0].definition!.review!.fresh, undefined);
  const definition = decoded.selection.externalAgentOperations![0].definition!;
  assert.deepEqual(definition.env, opening.externalAgents!.native.env);
  assert.deepEqual(definition.review!.env, opening.externalAgents!.native.review!.env);
  assert.equal(definition.execution!.env, undefined);
  script.consumed();
});

test("native model choices accept the shared catalog and the owner-held Keep current value only", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;

  const keepCurrent: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(keepCurrent, projected, "custom-model", "custom-model", projected.externalAgents!["custom-model"]);
  const decoded = roundTrip(opening, projected, keepCurrent).decoded;
  assert.equal(decoded.selection.externalAgentOperations![0].definition!.model, "owner-only-model");
  assert.equal(decoded.selection.externalAgentOperations![0].definition!.review!.model, "owner-only-review");

  const forged = validWire();
  forged.externalAgents = [{ id: "new", nextId: "new", definition: { adapter: "codex-cli", model: "made-up-model", review: {} } }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(forged, opening), /model the editor does not offer/);

  const forgedEdit = validWire();
  forgedEdit.externalAgents = [{ id: "native", nextId: "native", definition: { adapter: "claude-cli", model: "made-up-model", review: {} } }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(forgedEdit, opening), /model the editor does not offer/);

  const forgedRole = validWire();
  forgedRole.externalAgents = [{ id: "new", nextId: "new", definition: { adapter: "codex-cli", review: { model: "made-up-role-model" } } }];
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(forgedRole, opening), /model the editor does not offer/);
});

test("a model picked before an adapter switch survives a real creation round trip", async () => {
  const opening = normalizeConfig({ enabled: false });
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const script = editorScript([
    "Claude Code",
    "Identifier:",
    "Roles:",
    "Execution and review",
    "Shared model:",
    "Opus 5.5",
    "Adapter:",
    "Codex",
    "Create",
  ], ["switched-model"]);
  const created = await selectExternalAgentCreation(script.ui, projected);
  assert.ok(created);
  assert.equal(created.adapter, "codex-cli");
  assert.equal(created.model, "claude-opus-5-5");

  const operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, projected, "switched-model", "switched-model", created, true);
  const decoded = roundTrip(opening, projected, operations).decoded;
  const definition = decoded.selection.externalAgentOperations![0].definition!;
  assert.equal(definition.adapter, "codex-cli");
  assert.equal(definition.command, "codex");
  assert.equal(definition.model, "claude-opus-5-5");
  assert.equal(definition.reasoningEffort, undefined);
  script.consumed();
});

test("a new Pi auditor must be a scoped or pinned menu choice, while an unchanged opening auditor is retained", () => {
  const offered: Array<Pick<ScopedModelChoice, "model" | "supportedThinkingLevels">> = [
    { model: "openai/gpt-5", supportedThinkingLevels: ["low", "medium", "high"] },
  ];
  const opening = fixture();

  const scoped = validWire();
  scoped.toolProtection.auditor = { source: "pi", model: "openai/gpt-5", thinkingLevel: "medium" };
  const scopedDecoded = decodeRemoteReviewSettingsSaveIntent(scoped, opening, offered);
  assert.deepEqual(scopedDecoded.selection.toolProtection!.auditor, { source: "pi", model: "openai/gpt-5", thinkingLevel: "medium" });

  const unsupported = structuredClone(scoped);
  unsupported.toolProtection.auditor = { source: "pi", model: "openai/gpt-5", thinkingLevel: "max" };
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(unsupported, opening, offered), /not a Pi choice/);

  const outside = structuredClone(scoped);
  outside.toolProtection.auditor = { source: "pi", model: "runtime/private-model", thinkingLevel: "medium" };
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(outside, opening, offered), /not a Pi choice/);

  const retainedOpening = normalizeConfig({
    enabled: false,
    toolProtection: {
      level: "aligned",
      auditor: { source: "pi", model: "owner/out-of-scope", thinkingLevel: "low" },
      scope: "all",
      toolNames: [],
      timeoutMs: 10_000,
      maxContextChars: 128_000,
      retainAuditorSessions: false,
      debug: false,
    },
  });
  const projected = projectRemoteReviewSettingsOpening(retainedOpening).config;
  const retainedWire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(retainedOpening, projected))));
  const retainedDecoded = decodeRemoteReviewSettingsSaveIntent(retainedWire, retainedOpening, offered);
  assert.deepEqual(retainedDecoded.selection.toolProtection!.auditor, { source: "pi", model: "owner/out-of-scope", thinkingLevel: "low" });
});

test("changed web cap and mode shortcut follow the menu's editable constraints", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const unchanged = roundTrip(opening, projected).decoded;
  assert.equal(unchanged.selection.webMaxDownloadBytes, 1_234_567);

  const base = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, projected)))) as RemoteReviewSettingsSaveIntent;
  const changed = structuredClone(base);
  changed.webMaxDownloadBytes = 128 * 1024 * 1024;
  assert.equal(decodeRemoteReviewSettingsSaveIntent(changed, opening).selection.webMaxDownloadBytes, 134_217_728);
  for (const bytes of [1024 * 1024, 2048 * 1024 * 1024]) {
    const wire = structuredClone(base);
    wire.webMaxDownloadBytes = bytes;
    assert.equal(decodeRemoteReviewSettingsSaveIntent(wire, opening).selection.webMaxDownloadBytes, bytes);
  }
  for (const bytes of [0, 1024 * 1024 + 512 * 1024, 2049 * 1024 * 1024, 1_234_568]) {
    const wire = structuredClone(base);
    wire.webMaxDownloadBytes = bytes;
    assertDataError(() => decodeRemoteReviewSettingsSaveIntent(wire, opening), undefined);
  }

  // An unchanged opening value outside the editable MiB set is retained.
  const legacyOpening = normalizeConfig({ enabled: false, web: { fetch: { maxDownloadBytes: 3_000 * 1024 * 1024 } } });
  const legacyProjected = projectRemoteReviewSettingsOpening(legacyOpening).config;
  assert.equal(roundTrip(legacyOpening, legacyProjected).decoded.selection.webMaxDownloadBytes, 3_000 * 1024 * 1024);

  const changedShortcut = structuredClone(base);
  changedShortcut.modeCycleShortcut = "ALT+K";
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(changedShortcut, opening), /owner host-key occupancy/);
  const occupied = () => ({ resolved: true, bindings: ["app.interrupt"] });
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(changedShortcut, opening, [], {}, occupied), /built-in Pi binding/);
  let seen = "";
  const free = (shortcut: string) => { seen = shortcut; return { resolved: true, bindings: [] }; };
  assert.equal(decodeRemoteReviewSettingsSaveIntent(changedShortcut, opening, [], {}, free).selection.modeCycleShortcut, "alt+k");
  assert.equal(seen, "alt+k");
  const unresolved = () => ({ resolved: false, bindings: [] });
  assert.equal(decodeRemoteReviewSettingsSaveIntent(changedShortcut, opening, [], {}, unresolved).selection.modeCycleShortcut, "alt+k");

  // An identical opening shortcut is retained without consulting the host.
  const identical = structuredClone(base);
  let calls = 0;
  const forbidden = () => { calls += 1; return { resolved: true, bindings: ["app.interrupt"] }; };
  assert.equal(decodeRemoteReviewSettingsSaveIntent(identical, opening, [], {}, forbidden).selection.modeCycleShortcut, "alt+m");
  assert.equal(calls, 0);
});

test("new catalog keys must have the form generated by the editor", () => {
  const opening = fixture();
  const wire = validWire();
  const resource = { selection: { source: "external" as const, id: "binary" }, maxConcurrent: 1 };
  wire.workerResources.add = resource;
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(wire, opening), /workerResources has a new id/);
  delete wire.workerResources.add;
  // A resource added for legacy-conflict can subsequently switch to binary.
  wire.workerResources["external-legacy-conflict"] = resource;
  const generatedPiKey = `pi-${Buffer.from("openai/gpt-5").toString("base64url")}`;
  wire.workerResources[generatedPiKey] = { selection: { source: "pi", model: "claude-opus-5-5" }, maxConcurrent: 1 };
  const decoded = decodeRemoteReviewSettingsSaveIntent(wire, opening);
  assert.deepEqual(decoded.selection.workerResources["external-legacy-conflict"], resource);
  assert.equal((decoded.selection.workerResources[generatedPiKey]!.selection as { model: string }).model, "claude-opus-5-5");

  wire.scheduledTasks["foreign-schedule"] = { ...wire.scheduledTasks.nightly };
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(wire, opening), /scheduledTasks has a new id/);
});

test("resource-level Pi thinking is stripped by the encoder and rejected by the decoder", () => {
  const opening = fixture();
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const staged = stagedSave(opening, projected);
  (staged.selection.workerResources.pi.selection as unknown as { thinkingLevel?: string }).thinkingLevel = "high";
  const wire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(staged)));
  assert.equal(Object.hasOwn(wire.workerResources.pi.selection, "thinkingLevel"), false);

  const forged = validWire();
  (forged.workerResources.pi.selection as unknown as { thinkingLevel?: string }).thinkingLevel = "high";
  assertDataError(() => decodeRemoteReviewSettingsSaveIntent(forged, opening), /resource-level thinking/);
});

// ---------------------------------------------------------------------------
// Shared-persistence conflict semantics
// ---------------------------------------------------------------------------

test("decoded lineages keep the shared rename, re-creation, and stale-creation conflict semantics", async () => {
  // A real retained opening is the canonical loaded config (raw extra keys are
  // not part of it), unlike the projection-leak fixture's deliberate extras.
  const opening = normalizeConfig(fixture());
  // The leak fixture keeps an unavailable external subtask reviewer to prove it
  // is projected; persistence is stricter, so use a review-capable worker here.
  opening.review!.subtaskReviewers = [{ source: "external", id: "legacy-role" }];
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const dir = await mkdtemp(join(__dirname, "remote-settings-conflict-"));
  try {
    const writeOpening = async (name: string): Promise<string> => {
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(opening, null, 2), "utf8");
      return path;
    };

    // Rename: owner env survives in the destination-only reconstruction.
    const renameOperations: ExternalAgentOperation[] = [];
    const renamed = normalizeConfig({ externalAgents: { renamed: { adapter: "claude-cli", reasoningEffort: "default", model: "claude-opus-5-5", review: { model: "claude-sonnet-5-5" }, execution: { model: "claude-sonnet-5-5" } } } }).externalAgents!.renamed;
    const renamedDraft = changeExternalAgent(projected, "native", "renamed", renamed).config;
    stageExternalAgentOperation(renameOperations, projected, "native", "renamed", renamed);
    const renamePath = await writeOpening("rename.json");
    const renameDecoded = roundTrip(opening, renamedDraft, renameOperations).decoded;
    const renamedConfig = await persistReviewSettings(renamePath, renameDecoded.selection);
    assert.equal(renamedConfig.externalAgents!.native, undefined);
    assert.deepEqual(renamedConfig.externalAgents!.renamed.env, opening.externalAgents!.native.env);
    assert.equal(renamedConfig.externalAgents!.renamed.command, "claude");

    // Re-creation: the opening baseline is guarded, but no owner env comes back.
    const recreateOperations: ExternalAgentOperation[] = [];
    stageExternalAgentOperation(recreateOperations, projected, "native");
    const recreated = normalizeConfig({ externalAgents: { native: { adapter: "claude-cli", review: { model: "claude-haiku-4-5" } } } }).externalAgents!.native;
    stageExternalAgentOperation(recreateOperations, projected, "native", "native", recreated, true);
    const recreateDraft = changeExternalAgent(projected, "native").config;
    recreateDraft.externalAgents!.native = structuredClone(recreated);
    const recreatePath = await writeOpening("recreate.json");
    const recreateDecoded = roundTrip(opening, recreateDraft, recreateOperations).decoded;
    const recreatedConfig = await persistReviewSettings(recreatePath, recreateDecoded.selection);
    assert.equal(recreatedConfig.externalAgents!.native.env, undefined);
    assert.equal(recreatedConfig.externalAgents!.native.review!.env, undefined);
    assert.equal(recreatedConfig.externalAgents!.native.command, "claude");

    // A creation at an id that appeared on disk after opening keeps the native
    // creation collision instead of overwriting the newer agent: nothing is
    // written.
    const stalePath = await writeOpening("stale.json");
    const diskWithNewcomer = structuredClone(opening) as ReviewGateConfig;
    diskWithNewcomer.externalAgents!.newcomer = normalizeConfig({
      externalAgents: { newcomer: { adapter: "claude-cli", review: { model: "claude-sonnet-5-5" } } },
    }).externalAgents!.newcomer;
    await writeFile(stalePath, JSON.stringify(diskWithNewcomer, null, 2), "utf8");
    const staleWire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, projected))));
    staleWire.externalAgents = [{ id: "newcomer", nextId: "newcomer", definition: { adapter: "claude-cli", review: { model: "claude-sonnet-5-5" } } }];
    const staleDecoded = decodeRemoteReviewSettingsSaveIntent(staleWire, opening);
    await assert.rejects(
      () => persistReviewSettings(stalePath, staleDecoded.selection),
      /created in this menu already exists on disk/,
    );
    assert.deepEqual(JSON.parse(await readFile(stalePath, "utf8")), JSON.parse(JSON.stringify(diskWithNewcomer)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared-backend integration
// ---------------------------------------------------------------------------

test("a decoded remote save feeds the shared preparation directly", async () => {
  const dir = await mkdtemp(join(__dirname, "remote-settings-data-"));
  try {
    const opening = normalizeConfig({
      enabled: false,
      scheduledTasks: {
        task: {
          name: "Remote task",
          cron: "0 * * * *",
          enabled: true,
          kind: "execute",
          instructions: "Run it",
          workspace: dir,
        },
      },
    });
    const projected = projectRemoteReviewSettingsOpening(opening).config;
    const { decoded } = roundTrip(opening, projected);
    const preparation = await preparePersistedSave({
      configPath: join(dir, "review-gate.json"),
      cwd: dir,
      config: opening,
      draftConfig: decoded.draftConfig,
      scoped: [],
      selection: decoded.selection,
      scheduledImageProvenance: new Map(),
    });
    assert.equal(preparation.kind, "prepared", preparation.kind === "invalid" ? preparation.error : undefined);

    // A still-incomplete menu entry (new task with no cron yet) crosses the
    // wire intact and is decoded before shared save-time validation reports it.
    const incompleteWire = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, projected)))) as RemoteReviewSettingsSaveIntent;
    incompleteWire.scheduledTasks["task-0123abcd"] = { name: "Draft", cron: "", enabled: true, kind: "execute", instructions: "", workspace: "" };
    const incompleteDecoded = decodeRemoteReviewSettingsSaveIntent(incompleteWire, opening);
    assert.deepEqual(incompleteDecoded.selection.scheduledTasks!["task-0123abcd"], {
      name: "Draft", cron: "", enabled: true, kind: "execute", instructions: "", workspace: "",
    });
    const invalid = await preparePersistedSave({
      configPath: join(dir, "review-gate.json"),
      cwd: dir,
      config: opening,
      draftConfig: incompleteDecoded.draftConfig,
      scoped: [],
      selection: incompleteDecoded.selection,
      scheduledImageProvenance: new Map(),
    });
    assert.equal(invalid.kind, "invalid");
    assert.match(invalid.kind === "invalid" ? invalid.error : "", /cron|schedule/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("projected opening defaults and version stay stable for an absent editable section", () => {
  const opening = normalizeConfig({});
  const projected = projectRemoteReviewSettingsOpening(opening);
  assert.equal(projected.version, REMOTE_REVIEW_SETTINGS_DATA_VERSION);
  assert.equal(projected.config.enabled, opening.enabled);
  assert.deepEqual(projected.config.externalAgents, {});
  assert.deepEqual(projected.config.scheduledTasks, {});
  assert.equal(projected.config.toolProtection!.level, "off");
  assert.equal(projected.config.toolProtection!.auditor, null);
  assert.deepEqual(projected.config.web!.browserPermissions, DEFAULT_CONFIG.web!.browserPermissions);
  assert.equal(projected.config.waveArtifactTtlMs, DEFAULT_CONFIG.waveArtifactTtlMs);
  const wire = encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, projected.config));
  const decoded = decodeRemoteReviewSettingsSaveIntent(JSON.parse(JSON.stringify(wire)), opening);
  assert.equal(decoded.selection.scheduledTasks !== undefined, true);
  assert.deepEqual(decoded.selection.scheduledTasks, {});
  assert.deepEqual(decoded.selection.executeRoute, []);
  assert.deepEqual(decoded.selection.researchRoute, []);
  assert.equal("waveArtifactTtlMs" in decoded.selection, false);
  assert.deepEqual(decoded.selection.scheduledTasksStagedFrom, []);
  assert.deepEqual(decoded.selection.externalAgentOperations, []);
});
