import {
  DEFAULT_BROWSER_PERMISSIONS,
  DEFAULT_CONFIG,
  DEFAULT_DEFERRED_PI_TOOLS,
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  cloneScheduledTaskCatalog,
  cloneExternalAgentCatalog,
  effectiveReviewSettings,
  externalAgentCatalog,
  externalAgentSupportsReview,
  resolvedWorkerCatalog,
  type ActiveReviewerSelection,
  type OperatingMode,
  type ReviewGateConfig,
  type ScheduledTaskCatalog,
} from "../config";
import { OPERATING_MODE_LABELS } from "../operating-mode";
import { registerHook, sendNotice } from "../pi";
import { abortActiveNativeEditorField } from "../native-editor-bridge";
import { retainedSelect, type SettingsSaveControl } from "./menu";
import { captureExternalAgentReferenceBaseline, changeExternalAgent, manageExternalAgents, stageExternalAgentOperation, type ExternalAgentOperation } from "./external-agent-catalog";
import { scopedModelChoices, type ScopedModelChoice } from "./models";
import { assembleStagedSelectionConfig, captureScheduledAlreadyRun, persistReviewSettings, replaceConfig, type ReviewSettingsSelection } from "./persistence";
import { clearPendingSessionDelta, getPendingSessionDelta, recordPendingSessionDelta } from "./session-delta";
import { prepareScheduledImageAssets, rollbackScheduledImageAssets, rollbackScheduledImageAssetsUnlessPersisted, type PreparedScheduledImageAssets } from "./scheduled-image-assets";
import { alignedSettingsRows, formatByteSize, formatDuration, notify, type UiContext } from "./ui";
import { selectWebSettings } from "./web";
import {
  expandScheduledTaskWorkspaces,
  scheduledSummary,
  selectScheduledTasks,
  validateScheduledTasks,
} from "./scheduled-tasks";
import {
  executorPoolSummary,
  filterResearchCapableCatalog,
  initialWorkerRoute,
  selectWorkerRoute,
  visitWorkerResources,
  withoutResourceThinkingCatalog,
  workerRouteSummary,
} from "./workers";
import { materializeReviewerThinking, selectReviewSection } from "./review";
import {
  retentionLabel,
  selectBundleRetention,
  selectMaxWorkers,
  selectModeCycleShortcut,
  selectOperatingMode,
  selectReviewPolicy,
  selectRetryPolicy,
  selectSubtaskNotifications,
  selectTimeouts,
} from "./controls";
import { collectExternalAgentAvailabilityWarnings, validateSelection, type SettingsValidationPolicy } from "./validation";

interface RegisterSettingsInput {
  pi: unknown;
  config: ReviewGateConfig;
  configPath?: string;
  onSaved?: (config: ReviewGateConfig, previousMode: OperatingMode, context: unknown) => void | Promise<void>;
  onScopedModels?: (models: string[]) => void;
  /**
   * Process-local scheduled-task execution switch (issue #26). Live and
   * current-process-only, with the settled retention contract: the host
   * runtime holds the switch in a process-global holder that SURVIVES /reload
   * in the same process (a live toggle is never reset by a reload), and only a
   * fresh process startup derives the initial value from the scheduler launch
   * flag (flag on, no flag off). It is never persisted in the config file and
   * never becomes a shared default; this menu applies the flip through
   * setEnabled(), which the host runtime wires to an immediate timer
   * stop/start — no polling of the flag.
   */
  schedulerRuntime?: { enabled: boolean; setEnabled(next: boolean): void };
}

export function registerReviewSettings(input: RegisterSettingsInput): void {
  if (!isRecord(input.pi) || typeof input.pi.registerCommand !== "function") return;
  // Session reset (/new, /resume, quit/fork) fires session_shutdown before the
  // host clears its editor slot; settle any open native editor field as a
  // cancel so it neither hangs nor leaks partial text into the next session's
  // chat draft (issue #26). On /reload the host clears the slot first and the
  // abort only prevents a hang — see src/native-editor-bridge.ts.
  registerHook(input.pi, "session_shutdown", () => {
    abortActiveNativeEditorField();
  });
  const openSettings = (commandName: string, initialSection: SettingsMenuInitialSection) =>
    async (_args: string, ctx: unknown): Promise<void> => {
      const ui = extractUi(ctx);
      if (!ui) {
        await sendNotice(ctx, `review gate: /${commandName} requires an interactive selector UI`);
        return;
      }
      if (!input.configPath) {
        await notify(ui, "No persistent review-gate config file is loaded.", "error");
        return;
      }
      const scoped = scopedModelChoices(ctx) ?? [];
      input.onScopedModels?.(scoped.map((choice) => choice.model));
      await runSettingsMenu({ ...input, ui, scoped }, initialSection);
    };
  input.pi.registerCommand("review-settings", {
    description: "Configure delegated execution, deferred Pi tools, reviewers, review policy, scheduled tasks, the operating-mode cycle hotkey, web tools, and retention.",
    handler: openSettings("review-settings", "root"),
  });
  // Issue #190: landing shortcut into the same staged settings transaction.
  // It opens the existing Scheduled tasks submenu immediately; Esc or Back
  // from it lands at this same root menu, so Save changes and Cancel behave
  // exactly as for /review-settings. No second menu, state, or save path is
  // introduced: the shortcut stages into the one canonical catalog.
  input.pi.registerCommand("scheduled-tasks", {
    description: "Open the Scheduled tasks settings submenu directly; Esc or Back returns to /review-settings with the same staged Save/Cancel transaction.",
    handler: openSettings("scheduled-tasks", "scheduled"),
  });
}

/** Where an opened settings menu shows first (issue #190). */
type SettingsMenuInitialSection = "root" | "scheduled";

async function runSettingsMenu(
  input: RegisterSettingsInput & { ui: UiContext; scoped: ScopedModelChoice[] },
  initialSection: SettingsMenuInitialSection = "root",
): Promise<void> {
  // #306/#294: the already-run baseline at menu opening, so a root Escape can
  // preserve consumption AND re-arms that land while this menu is open (the
  // bidirectional protection), not only live-true consumption.
  const scheduledTasksAlreadyRunBeforeMenu = captureScheduledAlreadyRun(input.config);
  // Derived list for menu enumeration only; identity lookups go straight to
  // the canonical keyed catalog via resolvedExternalAgent.
  const draftConfig: ReviewGateConfig = {
    ...input.config,
    externalAgents: cloneExternalAgentCatalog(input.config.externalAgents ?? {}),
  };
  // Issue #294: seed this session's staged external-agent transaction and
  // transaction metadata from the pending session-only delta (if any): a
  // prior root Escape applied these choices to the live config without
  // persisting them, and a later Save must carry them through. The delta is
  // baseline metadata only — the live config remains the single active store,
  // so menu-local operation definitions are reconstructed from it on reopen.
  const pendingDelta = getPendingSessionDelta(input.config);
  const externalAgentOperations: ExternalAgentOperation[] = (pendingDelta?.agentOperations ?? []).map((operation) => {
    const stagedOperation: ExternalAgentOperation = structuredClone(operation);
    if (operation.nextId !== undefined) {
      const agents = draftConfig.externalAgents ?? {};
      if (!Object.hasOwn(agents, operation.nextId)) {
        throw new Error("Pending external worker is missing from live settings. Reopen settings after reloading.");
      }
      stagedOperation.definition = structuredClone(agents[operation.nextId]);
    }
    return stagedOperation;
  });
  const externalAgentOpening = structuredClone(input.config);
  // Optimistic-transaction reference baselines, retained across the ENTIRE
  // unsaved transaction: a later invocation opens on already-applied session
  // state, so its opening snapshot cannot serve as the pre-transaction
  // projection. A fresh transaction captures every existing agent's original
  // references once; a continuing transaction keeps the delta's captured
  // baselines until Save.
  const agentReferenceBaselines = new Map(
    pendingDelta?.agentReferenceBaselines
      ?? Object.keys(externalAgentOpening.externalAgents ?? {}).map((id) =>
        [id, captureExternalAgentReferenceBaseline(externalAgentOpening, id)] as const),
  );
  const pendingScheduleDeletions = [...(pendingDelta?.scheduleDeletions ?? [])];
  const pendingAlreadyRunEdited = [...(pendingDelta?.alreadyRunEdited ?? [])];
  let operatingMode = input.config.operatingMode;
  let modeCycleShortcut = input.config.modeCycleShortcut;
  // The catalog is keyed by stable resource ID; display order (alphabetical)
  // never defines identity or scheduling, and routes are explicit references.
  let workerResources = withoutResourceThinkingCatalog(resolvedWorkerCatalog(input.config));
  let executeRoute = initialWorkerRoute(input.config, "execute");
  let researchRoute = initialWorkerRoute(input.config, "research");
  // Issue #175: the review draft is the layer-split state. A legacy
  // `review.activeReviewers` record is imported into both sets here (menu
  // display is immediate), and the stored file is untouched until a save.
  const effectiveReview = effectiveReviewSettings(input.config);
  let primaryReviewers = materializeReviewerThinking(effectiveReview.primaryReviewers, input.scoped);
  let subtaskReviewers = materializeReviewerThinking(effectiveReview.subtaskReviewers, input.scoped);
  let primaryEnabled = effectiveReview.primaryEnabled;
  let subtaskEnabled = effectiveReview.subtaskEnabled;
  let reviewLandedChanges = effectiveReview.reviewLandedChanges;
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
  let browserIdleExpiryMinutes = input.config.web!.browserIdleExpiryMinutes ?? DEFAULT_CONFIG.web!.browserIdleExpiryMinutes;
  let browserDownloadRetention = input.config.web!.browserDownloadRetention ?? DEFAULT_CONFIG.web!.browserDownloadRetention;
  let browserVisible = input.config.web!.browserVisible ?? DEFAULT_CONFIG.web!.browserVisible;
  // Issue #27 a-la-carte browser permissions: staged like every other section.
  // YOLO is a master override; the individual values beneath it are preserved
  // so disabling restores them exactly as saved.
  let browserPermissions = { ...(input.config.web!.browserPermissions ?? DEFAULT_BROWSER_PERMISSIONS) };
  // Issue #26 scheduled tasks: the complete catalog is staged as its own
  // canonical copy; Save persists it through the shared save boundary. Entry
  // definitions stay visible and editable regardless of any runtime switch.
  // The ids visible at open time let Save distinguish the user's own deletions
  // from entries another process appended after this instance opened.
  let scheduledTasks = cloneScheduledTaskCatalog(input.config.scheduledTasks ?? {});
  const scheduledTasksStagedFrom = Object.keys(input.config.scheduledTasks ?? {});
  // Native image pastes observed in scheduled instructions (issue: scheduled
  // image assets). Provenance-carrying observation only, keyed by stable task
  // id: Save verifies each observed token against the FINAL staged
  // instructions and actual image content before copying anything. A cancel
  // or entry removal discards that entry's observations; Save consumes them
  // without clearing — the menu exits after a successful save.
  const scheduledImageProvenance = new Map<string, string[]>();
  // Issue #306: entry ids whose already-run state was explicitly toggled in
  // this staged session. Save preserves the scheduler-recorded alreadyRun for
  // every other entry so a stale unrelated save cannot erase it.
  const scheduledAlreadyRunEdited = new Set<string>();

  // Issue #294 follow-on: the root-owned Ctrl+S save signal for this menu
  // session, attached to the per-command UI so every retained selector in
  // the transaction shares it. It exists BEFORE the /scheduled-tasks shortcut
  // pre-loop, so a save request latched there unwinds through the same
  // canonical Save path as one latched deeper in the tree. The control is
  // UI-only state — never copied into settings drafts.
  const saveControl: SettingsSaveControl = { saveRequested: false, suspended: 0 };
  input.ui.saveControl = saveControl;

  // Issue #190: /scheduled-tasks lands in the existing Scheduled tasks submenu
  // before the root. It stages into this same canonical catalog through the
  // shared readers/writers and returns here on Esc or Back, so Save/Cancel run
  // through the identical transaction as the ordinary entry — no duplicate
  // scheduler UI or state.
  if (initialSection === "scheduled") {
    scheduledTasks = await selectScheduledTasks(input.ui, scheduledTasks, workerResources, draftConfig, input.scoped, externalAgentCatalog(draftConfig), scheduledImageProvenance, scheduledAlreadyRunEdited);
  }

  // Issue #294: the staged-apply preparation shared by Save and root Escape:
  // workspace expansion, the save-time validation, and the managed-image
  // transaction. Returns undefined (with an error notice) when the menu must
  // stay open for a fix or an explicit Cancel.
  const prepareStagedApply = async (): Promise<{
    prepared: PreparedScheduledImageAssets | undefined;
    catalogForApply: ScheduledTaskCatalog;
    warnings: Set<string>;
    validationPolicy: SettingsValidationPolicy;
  } | undefined> => {
    // Expand a leading `~`/`~/...` — entered above or hand-edited into the
    // config file — against the user's home before validation and persistence.
    // This stores an absolute spelling, not a symlink-resolved path. Relative
    // and other spellings keep their parent-session-cwd anchor at run time.
    scheduledTasks = expandScheduledTaskWorkspaces(scheduledTasks);
    const warnings = new Set<string>();
    const validationPolicy: SettingsValidationPolicy = { allowMissingApplicationCli: true, warnings };
    const error = (await validateSelection(workerResources, primaryReviewers, draftConfig, input.scoped, executeRoute, researchRoute, validationPolicy))
      ?? (await validateSelection(workerResources, subtaskReviewers, draftConfig, input.scoped, executeRoute, researchRoute, validationPolicy))
      ?? (await validateScheduledTasks(scheduledTasks, workerResources, draftConfig, input.scoped, input.ui.cwd, validationPolicy));
    if (error) {
      await notify(input.ui, error, "error");
      return undefined;
    }
    // The Save-time transaction for images pasted through the native host
    // editor (see src/settings/scheduled-image-assets.ts): every observed
    // native insert is verified against the FINAL staged instructions and
    // actual image content, copied into the private managed store, and the
    // staged temporary path is replaced by the managed absolute path BEFORE
    // the config is applied or persisted. Any failure (missing, non-image,
    // too large, or an unobserved Pi clipboard temp reference) fails closed
    // with an actionable notice and leaves the config and the managed store
    // untouched — the menu stays open, so the user can Cancel (which copies
    // nothing) or fix the entry and try again.
    let prepared: PreparedScheduledImageAssets | undefined;
    let catalogForApply = scheduledTasks;
    try {
      prepared = await prepareScheduledImageAssets(input.configPath!, scheduledTasks, scheduledImageProvenance);
      catalogForApply = prepared.catalog;
    } catch (error) {
      await notify(input.ui, `review gate: ${error instanceof Error ? error.message : String(error)}`, "error");
      return undefined;
    }
    return { prepared, catalogForApply, warnings, validationPolicy };
  };

  // Issue #294: the root-Escape session-only apply: assemble the staged
  // selection over the live config (no disk read or write), install it with
  // the existing alreadyRun protection, record the pending delta for a later
  // Save, and run the same runtime side effects as Save. A failed apply rolls
  // back exactly the managed copies this preparation positively created —
  // nothing live or persisted can reference them yet — and keeps the menu
  // open.
  const applyStagedToLive = async (staged: {
    prepared: PreparedScheduledImageAssets | undefined;
    catalogForApply: ScheduledTaskCatalog;
    warnings: Set<string>;
    validationPolicy: SettingsValidationPolicy;
  }): Promise<boolean> => {
    let next: ReviewGateConfig;
    try {
      next = assembleStagedSelectionConfig(input.config, stagedSelection(staged.catalogForApply), {
        externalAgents: draftConfig.externalAgents,
        scheduledTasks: staged.catalogForApply,
      });
    } catch (error) {
      if (staged.prepared) await rollbackScheduledImageAssets(staged.prepared);
      await notify(input.ui, `review gate: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    const previousMode = input.config.operatingMode;
    const previousModeCycleShortcut = input.config.modeCycleShortcut;
    // #306/#294: the opening baseline gives the bidirectional protection —
    // a consumption OR a re-arm that landed while this menu was open survives
    // installing this staged result, and an explicit Already-run edit from
    // this session always wins.
    replaceConfig(input.config, next, {
      scheduledTasksAlreadyRunEdited: [...scheduledAlreadyRunEdited],
      scheduledTasksAlreadyRunBeforeSave: scheduledTasksAlreadyRunBeforeMenu,
    });
    const stagedIds = new Set(Object.keys(staged.catalogForApply));
    recordPendingSessionDelta(input.config, {
      // Baseline-only metadata: identity mappings and original baselines, never
      // a duplicate of the active definitions (the live config owns those).
      agentOperations: externalAgentOperations.map(({ id, baseline, nextId }) => structuredClone({ id, baseline, nextId })),
      agentReferenceBaselines: new Map(agentReferenceBaselines),
      scheduleDeletions: new Set([...pendingScheduleDeletions, ...scheduledTasksStagedFrom.filter((id) => !stagedIds.has(id))]),
      alreadyRunEdited: new Set([...pendingAlreadyRunEdited, ...scheduledAlreadyRunEdited]),
    });
    // Include inactive definitions and additions preserved from the latest
    // on-disk catalog. Availability probes never launch the application.
    staged.warnings.clear();
    await collectExternalAgentAvailabilityWarnings(next, staged.validationPolicy);
    await input.onSaved?.(input.config, previousMode, { ui: input.ui });
    await notify(input.ui, "Review settings applied for this session (not saved to disk).", "info");
    for (const warning of staged.warnings) await notify(input.ui, warning, "warning");
    // The hotkey binding itself is captured by Pi at extension load, so a
    // changed key needs the documented /reload (same as keybindings.json).
    if (modeCycleShortcut !== previousModeCycleShortcut) {
      await notify(input.ui, "Mode cycle hotkey requires Save, then /reload; the session-only value does not change the registered binding.", "info");
    }
    return true;
  };

  // The one canonical staged-selection record for this menu session (issue
  // #294): both the persistent Save and the session-only Escape apply build
  // their config from it, so neither path stages a divergent field set.
  const stagedSelection = (catalogForApply: ScheduledTaskCatalog): ReviewSettingsSelection => ({
    operatingMode,
    externalAgentOperations,
    externalAgentOpening,
    modeCycleShortcut,
    workerResources,
    executeRoute,
    researchRoute,
    primaryReviewers,
    subtaskReviewers,
    primaryEnabled,
    subtaskEnabled,
    reviewLandedChanges,
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
    scheduledTasks: catalogForApply,
    scheduledTasksStagedFrom,
    scheduledTasksAlreadyRunEdited: [...scheduledAlreadyRunEdited],
    webMaxDownloadBytes,
    browserInteractionApproval,
    browserIdleExpiryMinutes,
    browserDownloadRetention,
    browserVisible,
    webBrowserPermissions: browserPermissions,
  });

  // Caller-local last selection for this loop only: the highlighted row is
  // re-shown after every staged change so a toggle can repeat without
  // navigating back to the top (issue #140). UI-only state, never persisted.
  // The /scheduled-tasks shortcut returns here from the Scheduled tasks
  // submenu on Esc or Back (issue #190), so its first root show highlights
  // the row the user just left instead of the menu head; the ordinary
  // /review-settings entry still opens at the head.
  let rootLastKey: string | undefined = initialSection === "scheduled" ? "scheduled" : undefined;
  while (true) {
    draftConfig.execution = { ...draftConfig.execution, workerResources, routes: { execute: executeRoute, research: researchRoute } };
    draftConfig.review = { ...draftConfig.review, primaryReviewers, subtaskReviewers, primaryEnabled, subtaskEnabled, reviewLandedChanges };
    draftConfig.scheduledTasks = scheduledTasks;
    const agents = externalAgentCatalog(draftConfig);
    const totalReviewerChoices = input.scoped.length + agents.filter(externalAgentSupportsReview).length;
    const layerSummary = (enabled: boolean, reviewers: ActiveReviewerSelection[]): string =>
      enabled
        ? reviewers.length === 0
          ? `0/${totalReviewerChoices} selected · auto off (no reviewers)`
          : `${reviewers.length}/${totalReviewerChoices} selected · auto`
        : "off";
    const reviewStatus = !input.config.enabled
      ? " — review disabled by master setting"
      : !primaryEnabled && !subtaskEnabled
        ? " — automatic review off"
        : "";
    // Section definitions drive both the aligned rendering and the row keys,
    // so a conditionally shown section (the live scheduler runtime toggle) can
    // never shift another row's label or key binding (issue #140 stability).
    const rootSections: Array<{ key: string; label: string; value: string }> = [
      { key: "mode", label: "Operating mode", value: OPERATING_MODE_LABELS[operatingMode] },
      { key: "modeCycle", label: "Mode cycle hotkey", value: modeCycleShortcut },
      { key: "resources", label: "Worker resources", value: executorPoolSummary(workerResources) },
      { key: "externalAgents", label: "External workers", value: `${agents.length} defined` },
      { key: "route.execute", label: "Execution priority", value: workerRouteSummary(executeRoute, workerResources, draftConfig, input.scoped) },
      { key: "route.research", label: "Research priority", value: workerRouteSummary(researchRoute, workerResources, draftConfig, input.scoped) },
      { key: "reviewers", label: "Reviewers", value: `primary ${layerSummary(primaryEnabled, primaryReviewers)} · subtask ${layerSummary(subtaskEnabled, subtaskReviewers)}${reviewStatus}` },
      { key: "timeouts", label: "Timeouts", value: `review ${formatDuration(reviewerTimeoutMs)} · executor ${formatDuration(executorTimeoutMs)}` },
      { key: "policy", label: "Review policy", value: `${maxCorrectionCycles} corrections · concrete after ${guidanceThreshold}` },
      { key: "retention", label: "Bundle retention", value: retentionLabel(retainBundles) },
      { key: "workers", label: "Global concurrency", value: String(maxWorkers) },
      { key: "retry", label: "Retry policy", value: `${retryPolicy.maxRetries} retries · ${formatDuration(retryPolicy.baseDelayMs)} base` },
      { key: "notifications", label: "Subtask notifications", value: subtaskNotifications === "quiet" ? "Quiet" : "Noisy" },
      { key: "deferredTools", label: "Deferred Pi tools", value: `${deferredPiTools ? "On" : "Off"} · local now, new subtasks` },
      { key: "subtasksView", label: "Subtasks view", value: subtasksViewExpanded ? "Expanded" : "Collapsed" },
      { key: "scheduled", label: "Scheduled tasks", value: scheduledSummary(scheduledTasks) },
      ...(input.schedulerRuntime
        ? [{ key: "schedulerRuntime", label: "Scheduler runtime", value: input.schedulerRuntime.enabled ? "On" : "Off" }]
        : []),
      { key: "web", label: "Web", value: `${formatByteSize(webMaxDownloadBytes)} max download · ${browserVisible ? "headed" : "headless"} browser${browserPermissions.yolo ? " · YOLO ON" : ""}` },
    ];
    const renderedRootRows = alignedSettingsRows(rootSections.map((section) => [section.label, section.value] as const));
    // Rows are keyed by stable section names: every label re-renders with the
    // staged state, but the key never changes (issue #140).
    let choice: string | undefined = await retainedSelect(input.ui, {
      title: "Review settings",
      rows: [
        ...rootSections.map((section, index) => ({ key: section.key, label: renderedRootRows[index]! })),
        { key: "save", label: "Save changes" },
        { key: "cancel", label: "Cancel" },
      ],
      initialKey: rootLastKey,
    });
    // Issue #294 follow-on: a latched Ctrl+S (pressed in this menu or any
    // nested settings selector, which unwound through its normal cancel
    // return path) reaches the root as an explicit Save — the same canonical
    // save path as the "Save changes" row. The latch is consumed BEFORE
    // validation so a failed save neither auto-retries on the next show nor
    // degrades into a session-only Escape apply.
    if (choice === undefined && saveControl.saveRequested) {
      saveControl.saveRequested = false;
      choice = "save";
    }
    if (choice === "cancel") {
      // Explicit Cancel (issue #294): preserve the prior session state
      // exactly — no live apply, no managed copies, no pending-delta change.
      return;
    }
    if (!choice) {
      // Root Escape (issue #294): validate and apply the staged settings to
      // the live config only — no persistent config write. Nested menus keep
      // their existing Back semantics; this is the root exit only.
      const staged = await prepareStagedApply();
      if (staged === undefined) continue;
      if (!await applyStagedToLive(staged)) continue;
      return;
    }
    rootLastKey = choice;
    if (choice === "mode") {
      operatingMode = await selectOperatingMode(input.ui, operatingMode);
      continue;
    }
    if (choice === "modeCycle") {
      modeCycleShortcut = await selectModeCycleShortcut(input.ui, modeCycleShortcut);
      continue;
    }
    if (choice === "externalAgents") {
      await manageExternalAgents(input.ui, draftConfig, async (id, nextId, definition) => {
        if (!Object.hasOwn(draftConfig.externalAgents ?? {}, id)) {
          Object.defineProperty(draftConfig.externalAgents!, id, { value: definition, enumerable: true, writable: true, configurable: true });
          // A creation has no on-disk original: never capture an opening
          // baseline for it (issue #294), or a later reopen would invent one.
          stageExternalAgentOperation(externalAgentOperations, externalAgentOpening, id, nextId, definition, true);
          return;
        }
        const changed = changeExternalAgent(draftConfig, id, nextId, definition);
        replaceConfig(draftConfig, changed.config);
        workerResources = draftConfig.execution!.workerResources!;
        executeRoute = draftConfig.execution!.routes!.execute ?? [];
        researchRoute = draftConfig.execution!.routes!.research ?? [];
        primaryReviewers = draftConfig.review!.primaryReviewers!;
        subtaskReviewers = draftConfig.review!.subtaskReviewers!;
        scheduledTasks = draftConfig.scheduledTasks!;
        // Issue #294: capture the pre-transaction reference baseline for a
        // newly staged operation from this session's OPENING snapshot — never
        // from the already-cascaded draft, whose references reflect this
        // transaction's own renames and selection edits and would conflict
        // with unchanged on-disk references. Chained operations keep their
        // original id's baseline.
        const operation = stageExternalAgentOperation(externalAgentOperations, externalAgentOpening, id, nextId, definition);
        if (!agentReferenceBaselines.has(operation.id)) {
          agentReferenceBaselines.set(operation.id, captureExternalAgentReferenceBaseline(externalAgentOpening, operation.id));
        }
        for (const notice of changed.notices) await notify(input.ui, notice, "info");
      });
      continue;
    }
    if (choice === "resources") {
      ({ workerResources, executeRoute, researchRoute } = await visitWorkerResources(
        input.ui,
        workerResources,
        executeRoute,
        researchRoute,
        agents,
        draftConfig,
        input.scoped,
      ));
      continue;
    }
    if (choice === "route.execute") {
      executeRoute = await selectWorkerRoute(input.ui, "Execution priority", executeRoute, workerResources, draftConfig, input.scoped);
      continue;
    }
    if (choice === "route.research") {
      researchRoute = await selectWorkerRoute(
        input.ui,
        "Research priority",
        researchRoute,
        filterResearchCapableCatalog(draftConfig, workerResources),
        draftConfig,
        input.scoped,
      );
      continue;
    }
    if (choice === "reviewers") {
      ({ primaryReviewers, subtaskReviewers, primaryEnabled, subtaskEnabled, reviewLandedChanges } =
        await selectReviewSection(input.ui, { primaryReviewers, subtaskReviewers, primaryEnabled, subtaskEnabled, reviewLandedChanges }, agents, input.scoped));
      continue;
    }
    if (choice === "timeouts") {
      ({ reviewerTimeoutMs, executorTimeoutMs } = await selectTimeouts(
        input.ui,
        reviewerTimeoutMs,
        executorTimeoutMs,
      ));
      continue;
    }
    if (choice === "policy") {
      ({ maxCorrectionCycles, guidanceThreshold } = await selectReviewPolicy(
        input.ui,
        maxCorrectionCycles,
        guidanceThreshold,
      ));
      continue;
    }
    if (choice === "retention") {
      retainBundles = await selectBundleRetention(input.ui, retainBundles);
      continue;
    }
    if (choice === "workers") {
      maxWorkers = await selectMaxWorkers(input.ui, maxWorkers);
      continue;
    }
    if (choice === "retry") {
      retryPolicy = await selectRetryPolicy(input.ui, retryPolicy);
      continue;
    }
    if (choice === "notifications") {
      subtaskNotifications = await selectSubtaskNotifications(input.ui, subtaskNotifications);
      continue;
    }
    if (choice === "deferredTools") {
      deferredPiTools = !deferredPiTools;
      continue;
    }
    if (choice === "subtasksView") {
      subtasksViewExpanded = !subtasksViewExpanded;
      continue;
    }
    if (choice === "scheduled") {
      scheduledTasks = await selectScheduledTasks(input.ui, scheduledTasks, workerResources, draftConfig, input.scoped, agents, scheduledImageProvenance, scheduledAlreadyRunEdited);
      continue;
    }
    if (choice === "schedulerRuntime") {
      // Live, current-process-only switch (issue #26): applies immediately,
      // never persists, and stays outside the staged settings transaction —
      // cancelling other changes does not revert it.
      // Real setter contract: the runtime reacts synchronously by stopping
      // or starting its timers; nothing polls the flag afterwards.
      if (input.schedulerRuntime) input.schedulerRuntime.setEnabled(!input.schedulerRuntime.enabled);
      continue;
    }
    if (choice === "web") {
      ({ maxDownloadBytes: webMaxDownloadBytes, browserInteractionApproval, browserIdleExpiryMinutes, browserDownloadRetention, browserVisible, browserPermissions } = await selectWebSettings(
        input.ui, webMaxDownloadBytes, browserInteractionApproval, browserIdleExpiryMinutes, browserDownloadRetention, browserVisible, browserPermissions,
      ));
      continue;
    }
    // choice === "save": the persistent save boundary (issue #294) — the same
    // staged-apply preparation as root Escape, then the disk merge with
    // foreign-entry preservation and the external-agent optimistic cascade
    // guards. Explicit Save and Ctrl+S share this one canonical Save path.
    const staged = await prepareStagedApply();
    if (staged === undefined) continue;
    // Issue #294: a pending session-only alreadyRun edit is not a new edit in
    // this reopened menu. If consumption or a re-arm happened while this menu
    // was open (or during preparation), the current live value replaces the
    // stale staged flag before persistence and baseline capture; the existing
    // before-save protection then covers changes made later, in flight.
    for (const id of pendingAlreadyRunEdited) {
      if (scheduledAlreadyRunEdited.has(id)) continue;
      const liveEntry = input.config.scheduledTasks?.[id];
      const stagedEntry = staged.catalogForApply[id];
      if (liveEntry === undefined || stagedEntry === undefined) continue;
      if (liveEntry.alreadyRun === true) stagedEntry.alreadyRun = true;
      else delete stagedEntry.alreadyRun;
    }
    // #306: capture the live already-run state before this asynchronous save
    // so a later install can preserve changes made while it was in flight.
    const scheduledTasksAlreadyRunBeforeSave = captureScheduledAlreadyRun(input.config);
    let next: ReviewGateConfig;
    try {
      next = await persistReviewSettings(input.configPath!, {
        ...stagedSelection(staged.catalogForApply),
        // Issue #294: carry the pending session-only delta through this Save:
        // earlier Escape-applied deletions and explicit alreadyRun edits stay
        // effective, and seeded external-agent operations keep their
        // pre-cascade reference baselines for the optimistic guard.
        externalAgentReferenceBaselines: Object.fromEntries(agentReferenceBaselines),
        scheduledTasksStagedFrom: [...new Set([...scheduledTasksStagedFrom, ...pendingScheduleDeletions])],
        scheduledTasksAlreadyRunEdited: [...new Set([...scheduledAlreadyRunEdited, ...pendingAlreadyRunEdited])],
      });
    } catch (error) {
      // A failed Save mutates nothing and retains the pending delta — but the
      // atomic config write can reject AFTER its rename already replaced the
      // file, in which case the persisted text references the just-created
      // copies. The rollback reads the config first and keeps any created copy
      // the persisted text references (and everything when the config cannot
      // be read); the staged catalog keeps the original temporary paths so a
      // later Save can retry either way.
      if (staged.prepared) await rollbackScheduledImageAssetsUnlessPersisted(input.configPath!, staged.prepared);
      if (externalAgentOperations.length === 0) throw error;
      await notify(input.ui, `Cannot save external worker changes: ${error instanceof Error ? error.message : "persistence conflict"}`, "error");
      continue;
    }
    // Include inactive definitions and additions preserved from the latest
    // on-disk catalog. Availability probes never launch the application.
    // Disk may have changed existing definitions since this menu opened.
    // Announce availability of the saved catalog, not stale draft warnings.
    staged.warnings.clear();
    await collectExternalAgentAvailabilityWarnings(next, staged.validationPolicy);
    const previousMode = input.config.operatingMode;
    const previousModeCycleShortcut = input.config.modeCycleShortcut;
    // #306: a scheduler-recorded alreadyRun=true in the live catalog must
    // survive installing this (possibly stale) save result — and an explicit
    // re-arm made while this save was in flight must survive it too. Only
    // explicit Already-run edits from THIS session clear the protection:
    // a pending session-only edit is already reflected in the staged catalog
    // (seeded from the live config), so the before-save baseline — not an
    // exemption — decides whether a newer live change wins.
    replaceConfig(input.config, next, {
      scheduledTasksAlreadyRunEdited: [...scheduledAlreadyRunEdited],
      scheduledTasksAlreadyRunBeforeSave,
    });
    await input.onSaved?.(input.config, previousMode, { ui: input.ui });
    await notify(input.ui, "Review settings saved.", "info");
    for (const warning of staged.warnings) await notify(input.ui, warning, "warning");
    // The hotkey binding itself is captured by Pi at extension load, so a
    // changed key needs the documented /reload (same as keybindings.json);
    // the persisted mode change itself never needs a reload.
    if (modeCycleShortcut !== previousModeCycleShortcut) {
      await notify(input.ui, "Mode cycle hotkey takes effect after /reload.", "info");
    }
    // Issue #294: the pending session-only choices are durable now.
    clearPendingSessionDelta(input.config);
    return;
  }
}

function extractUi(ctx: unknown): UiContext | undefined {
  if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.select !== "function") return undefined;
  // Delegate to the live host UI object (prototype chain) so members beyond
  // this interface — e.g. setStatus, used after saving — keep working, and
  // carry the command context's run mode for guarding terminal-only custom
  // components (issue #140).
  const ui = Object.create(ctx.ui) as UiContext;
  if (typeof ctx.mode === "string") ui.mode = ctx.mode;
  // The session cwd anchors the workspace field's native path completion
  // against the host's own working directory, never process.cwd (issue #26).
  if (typeof ctx.cwd === "string") ui.cwd = ctx.cwd;
  return ui;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
