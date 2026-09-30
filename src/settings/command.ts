import {
  DEFAULT_BROWSER_PERMISSIONS,
  DEFAULT_CONFIG,
  DEFAULT_DEFERRED_PI_TOOLS,
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  cloneScheduledTaskCatalog,
  effectiveReviewSettings,
  externalAgentCatalog,
  externalAgentSupportsReview,
  resolvedWorkerCatalog,
  type ActiveReviewerSelection,
  type OperatingMode,
  type ReviewGateConfig,
} from "../config";
import { OPERATING_MODE_LABELS } from "../operating-mode";
import { registerHook, sendNotice } from "../pi";
import { abortActiveNativeEditorField } from "../native-editor-bridge";
import { retainedSelect } from "./menu";
import { scopedModelChoices, type ScopedModelChoice } from "./models";
import { persistReviewSettings, replaceConfig } from "./persistence";
import { prepareScheduledImageAssets, rollbackScheduledImageAssetsUnlessPersisted, type PreparedScheduledImageAssets } from "./scheduled-image-assets";
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
import { validateSelection } from "./validation";

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
  // Derived list for menu enumeration only; identity lookups go straight to
  // the canonical keyed catalog via resolvedExternalAgent.
  const agents = externalAgentCatalog(input.config);
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

  // Issue #190: /scheduled-tasks lands in the existing Scheduled tasks submenu
  // before the root. It stages into this same canonical catalog through the
  // shared readers/writers and returns here on Esc or Back, so Save/Cancel run
  // through the identical transaction as the ordinary entry — no duplicate
  // scheduler UI or state.
  if (initialSection === "scheduled") {
    scheduledTasks = await selectScheduledTasks(input.ui, scheduledTasks, workerResources, input.config, input.scoped, agents, scheduledImageProvenance);
  }

  // Caller-local last selection for this loop only: the highlighted row is
  // re-shown after every staged change so a toggle can repeat without
  // navigating back to the top (issue #140). UI-only state, never persisted.
  // The /scheduled-tasks shortcut returns here from the Scheduled tasks
  // submenu on Esc or Back (issue #190), so its first root show highlights
  // the row the user just left instead of the menu head; the ordinary
  // /review-settings entry still opens at the head.
  let rootLastKey: string | undefined = initialSection === "scheduled" ? "scheduled" : undefined;
  while (true) {
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
      { key: "route.execute", label: "Execution priority", value: workerRouteSummary(executeRoute, workerResources, input.config, input.scoped) },
      { key: "route.research", label: "Research priority", value: workerRouteSummary(researchRoute, workerResources, input.config, input.scoped) },
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
    const choice = await retainedSelect(input.ui, {
      title: "Review settings",
      rows: [
        ...rootSections.map((section, index) => ({ key: section.key, label: renderedRootRows[index]! })),
        { key: "save", label: "Save changes" },
        { key: "cancel", label: "Cancel" },
      ],
      initialKey: rootLastKey,
    });
    if (!choice || choice === "cancel") return;
    rootLastKey = choice;
    if (choice === "mode") {
      operatingMode = await selectOperatingMode(input.ui, operatingMode);
      continue;
    }
    if (choice === "modeCycle") {
      modeCycleShortcut = await selectModeCycleShortcut(input.ui, modeCycleShortcut);
      continue;
    }
    if (choice === "resources") {
      ({ workerResources, executeRoute, researchRoute } = await visitWorkerResources(
        input.ui,
        workerResources,
        executeRoute,
        researchRoute,
        agents,
        input.config,
        input.scoped,
      ));
      continue;
    }
    if (choice === "route.execute") {
      executeRoute = await selectWorkerRoute(input.ui, "Execution priority", executeRoute, workerResources, input.config, input.scoped);
      continue;
    }
    if (choice === "route.research") {
      researchRoute = await selectWorkerRoute(
        input.ui,
        "Research priority",
        researchRoute,
        filterResearchCapableCatalog(input.config, workerResources),
        input.config,
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
      scheduledTasks = await selectScheduledTasks(input.ui, scheduledTasks, workerResources, input.config, input.scoped, agents, scheduledImageProvenance);
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
    // Expand a leading `~`/`~/...` — entered above or hand-edited into the
    // config file — against the user's home before validation and persistence.
    // This stores an absolute spelling, not a symlink-resolved path. Relative
    // and other spellings keep their parent-session-cwd anchor at run time.
    scheduledTasks = expandScheduledTaskWorkspaces(scheduledTasks);
    const error = (await validateSelection(workerResources, primaryReviewers, input.config, input.scoped, executeRoute, researchRoute))
      ?? (await validateSelection(workerResources, subtaskReviewers, input.config, input.scoped, executeRoute, researchRoute))
      ?? (await validateScheduledTasks(scheduledTasks, workerResources, input.config, input.scoped, input.ui.cwd));
    if (error) {
      await notify(input.ui, error, "error");
      continue;
    }
    // The Save-time transaction for images pasted through the native host
    // editor (see src/settings/scheduled-image-assets.ts): every observed
    // native insert is verified against the FINAL staged instructions and
    // actual image content, copied into the private managed store, and the
    // staged temporary path is replaced by the managed absolute path BEFORE
    // the ordinary atomic config persistence. Any failure (missing,
    // non-image, too large, or an unobserved Pi clipboard temp reference)
    // fails closed with an actionable notice and leaves the config and the
    // managed store untouched — the menu stays open, so the user can Cancel
    // (which copies nothing) or fix the entry and Save again.
    let prepared: PreparedScheduledImageAssets | undefined;
    let catalogForSave = scheduledTasks;
    try {
      prepared = await prepareScheduledImageAssets(input.configPath!, scheduledTasks, scheduledImageProvenance);
      catalogForSave = prepared.catalog;
    } catch (error) {
      await notify(input.ui, `review gate: ${error instanceof Error ? error.message : String(error)}`, "error");
      continue;
    }
    let next: ReviewGateConfig;
    try {
      next = await persistReviewSettings(input.configPath!, {
        operatingMode,
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
        scheduledTasks: catalogForSave,
        scheduledTasksStagedFrom,
        webMaxDownloadBytes,
        browserInteractionApproval,
        browserIdleExpiryMinutes,
        browserDownloadRetention,
        browserVisible,
        webBrowserPermissions: browserPermissions,
      });
    } catch (error) {
      // A failed Save mutates nothing — but the atomic config write can reject
      // AFTER its rename already replaced the file, in which case the persisted
      // text references the just-created copies. The rollback reads the config
      // first and keeps any created copy the persisted text references (and
      // everything when the config cannot be read); the staged catalog keeps
      // the original temporary paths so a later Save can retry either way.
      if (prepared) await rollbackScheduledImageAssetsUnlessPersisted(input.configPath!, prepared);
      throw error;
    }
    const previousMode = input.config.operatingMode;
    const previousModeCycleShortcut = input.config.modeCycleShortcut;
    replaceConfig(input.config, next);
    await input.onSaved?.(input.config, previousMode, { ui: input.ui });
    await notify(input.ui, "Review settings saved.", "info");
    // The hotkey binding itself is captured by Pi at extension load, so a
    // changed key needs the documented /reload (same as keybindings.json);
    // the persisted mode change itself never needs a reload.
    if (modeCycleShortcut !== previousModeCycleShortcut) {
      await notify(input.ui, "Mode cycle hotkey takes effect after /reload.", "info");
    }
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
