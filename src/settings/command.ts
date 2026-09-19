import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  BROWSER_PERMISSION_FIELDS,
  DEFAULT_BROWSER_PERMISSIONS,
  DEFAULT_CONFIG,
  DEFAULT_DEFERRED_PI_TOOLS,
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  MAX_EXECUTION_WORKERS,
  cloneWorkerCatalog,
  externalAgentCatalog,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  executorEntryId,
  executorSelectionKey,
  normalizeModeCycleShortcut,
  resolvedExternalAgent,
  resolvedWorkerCatalog,
  workerResourceSupportsResearch,
  type ActiveReviewerSelection,
  type BrowserInteractionApproval,
  type BrowserPermissionField,
  type ExecutorSelection,
  type ExternalAgentConfig,
  type ExecutionRetryPolicy,
  OPERATING_MODES,
  type OperatingMode,
  type RetainBundles,
  type ReviewGateConfig,
  type SubtaskNotificationMode,
  type WebBrowserPermissions,
  type ThinkingLevel,
  type WorkerResourceCatalog,
  type WorkerResourceValue,
  type WorkerRouteEntry,
} from "../config";
import { OPERATING_MODE_LABELS } from "../operating-mode";
import { sendNotice } from "../pi";
import { findOccupiedHostBindings } from "../host-keybindings";
import { retainedSelect, type MenuCustomFactory } from "./menu";
import { scopedModelChoices, type ScopedModelChoice } from "./models";
import { persistReviewSettings, replaceConfig } from "./persistence";

interface RegisterSettingsInput {
  pi: unknown;
  config: ReviewGateConfig;
  configPath?: string;
  onSaved?: (config: ReviewGateConfig, previousMode: OperatingMode, context: unknown) => void | Promise<void>;
  onScopedModels?: (models: string[]) => void;
}

interface UiContext {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  confirm?(title: string, message: string): Promise<boolean>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  /** Host custom TUI component (Pi hosts only); guarded by `mode === "tui"`. */
  custom?(factory: MenuCustomFactory): Promise<string | undefined>;
  /** Host run mode ("tui" | "rpc" | ...); carried from the command context. */
  mode?: string;
}

export function registerReviewSettings(input: RegisterSettingsInput): void {
  if (!isRecord(input.pi) || typeof input.pi.registerCommand !== "function") return;
  input.pi.registerCommand("review-settings", {
    description: "Configure delegated execution, deferred Pi tools, reviewers, review policy, the operating-mode cycle hotkey, web tools, and retention.",
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
  let browserIdleExpiryMinutes = input.config.web!.browserIdleExpiryMinutes ?? DEFAULT_CONFIG.web!.browserIdleExpiryMinutes;
  let browserDownloadRetention = input.config.web!.browserDownloadRetention ?? DEFAULT_CONFIG.web!.browserDownloadRetention;
  let browserVisible = input.config.web!.browserVisible ?? DEFAULT_CONFIG.web!.browserVisible;
  // Issue #27 a-la-carte browser permissions: staged like every other section.
  // YOLO is a master override; the individual values beneath it are preserved
  // so disabling restores them exactly as saved.
  let browserPermissions = { ...(input.config.web!.browserPermissions ?? DEFAULT_BROWSER_PERMISSIONS) };

  // Caller-local last selection for this loop only: the highlighted row is
  // re-shown after every staged change so a toggle can repeat without
  // navigating back to the top (issue #140). UI-only state, never persisted.
  let rootLastKey: string | undefined;
  while (true) {
    const totalReviewerChoices = input.scoped.length + agents.filter(externalAgentSupportsReview).length;
    const reviewStatus = input.config.enabled
      ? activeReviewers.length === 0 ? " — review disabled" : ""
      : " — review disabled by master setting";
    const [modeRow, modeCycleRow, resourcesRow, executeRouteRow, researchRouteRow, reviewersRow, timeoutsRow, policyRow, retentionRow, workersRow, retryRow, notificationsRow, deferredToolsRow, subtasksViewRow, webRow] = alignedSettingsRows([
      ["Operating mode", OPERATING_MODE_LABELS[operatingMode]],
      ["Mode cycle hotkey", modeCycleShortcut],
      ["Worker resources", executorPoolSummary(workerResources)],
      ["Execution priority", workerRouteSummary(executeRoute, workerResources, input.config, input.scoped)],
      ["Research priority", workerRouteSummary(researchRoute, workerResources, input.config, input.scoped)],
      ["Reviewers", `${activeReviewers.length}/${totalReviewerChoices} selected${reviewStatus}`],
      ["Timeouts", `review ${formatDuration(reviewerTimeoutMs)} · executor ${formatDuration(executorTimeoutMs)}`],
      ["Review policy", `${maxCorrectionCycles} corrections · concrete after ${guidanceThreshold}`],
      ["Bundle retention", retentionLabel(retainBundles)],
      ["Global concurrency", String(maxWorkers)],
      ["Retry policy", `${retryPolicy.maxRetries} retries · ${formatDuration(retryPolicy.baseDelayMs)} base`],
      ["Subtask notifications", subtaskNotifications === "quiet" ? "Quiet" : "Noisy"],
      ["Deferred Pi tools", `${deferredPiTools ? "On" : "Off"} · local now, new subtasks`],
      ["Subtasks view", subtasksViewExpanded ? "Expanded" : "Collapsed"],
      ["Web", `${formatByteSize(webMaxDownloadBytes)} max download · ${browserVisible ? "headed" : "headless"} browser${browserPermissions.yolo ? " · YOLO ON" : ""}`],
    ]);
    // Rows are keyed by stable section names: every label re-renders with the
    // staged state, but the key never changes (issue #140).
    const choice = await retainedSelect(input.ui, {
      title: "Review settings",
      rows: [
        { key: "mode", label: modeRow },
        { key: "modeCycle", label: modeCycleRow },
        { key: "resources", label: resourcesRow },
        { key: "route.execute", label: executeRouteRow },
        { key: "route.research", label: researchRouteRow },
        { key: "reviewers", label: reviewersRow },
        { key: "timeouts", label: timeoutsRow },
        { key: "policy", label: policyRow },
        { key: "retention", label: retentionRow },
        { key: "workers", label: workersRow },
        { key: "retry", label: retryRow },
        { key: "notifications", label: notificationsRow },
        { key: "deferredTools", label: deferredToolsRow },
        { key: "subtasksView", label: subtasksViewRow },
        { key: "web", label: webRow },
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
      // Selection keys at the start of this visit. Reasoning re-pairing and
      // added-resource enrollment re-derivation run only for resources whose
      // model actually changed during this visit, so explicit per-route
      // thinking levels set between visits survive untouched.
      const keysAtVisitStart = new Map(
        Object.entries(workerResources).map(([id, value]) => [id, executorSelectionKey(value.selection)]),
      );
      // Enrollment bookkeeping is scoped to this one visit: resources present
      // when the pool editor opened are never enrolled into a route they were
      // excluded from just because their model changed now; only resources
      // added during this visit keep Add's enrollment semantics against
      // their final selection.
      const priorResourceIds = new Set(Object.keys(workerResources));
      const enrolledSelectionKeys = new Map<string, string>();
      workerResources = await selectExecutorPool(input.ui, workerResources, agents, input.config, input.scoped, (id, value) => {
        // Explicit Add enrolls the new resource in each supported role priority
        // directly at the action, in addition order, with the model's default
        // reasoning. The membership guard keeps add/remove/re-add of one
        // identity from producing duplicate route references. Passive load/save
        // never enrolls: missing or empty routes stay empty.
        if (!executeRoute.some((entry) => entry.resourceId === id)) {
          executeRoute.push({ ...defaultWorkerRouteEntry(id, value.selection, input.scoped) });
        }
        if (workerResourceSupportsResearch(input.config, value.selection)
            && !researchRoute.some((entry) => entry.resourceId === id)) {
          researchRoute.push({ ...defaultWorkerRouteEntry(id, value.selection, input.scoped) });
        }
        enrolledSelectionKeys.set(id, executorSelectionKey(value.selection));
      });
      executeRoute = reconcileWorkerRoute(executeRoute, workerResources);
      researchRoute = reconcileWorkerRoute(
        researchRoute,
        filterResearchCapableCatalog(input.config, workerResources),
      );
      for (const [id, value] of Object.entries(workerResources)) {
        const currentKey = executorSelectionKey(value.selection);
        // Baseline: this visit's starting key; for resources added during
        // this visit, the key they were enrolled under (Add time or last
        // re-derivation). Equal means the model did not change during this
        // visit, so explicit per-route thinking levels are left alone.
        const baselineKey = keysAtVisitStart.get(id) ?? enrolledSelectionKeys.get(id);
        if (baselineKey === currentKey) continue;
        if (!priorResourceIds.has(id)) {
          // Added by explicit Add during this visit: enrollment follows the
          // final selection, not the model chosen at Add time. Enroll in each
          // supported role the resource is not currently listed in; the
          // membership guards keep add/remove/re-add of one identity
          // duplicate-free.
          if (!executeRoute.some((entry) => entry.resourceId === id)) {
            executeRoute.push({ ...defaultWorkerRouteEntry(id, value.selection, input.scoped) });
          }
          if (workerResourceSupportsResearch(input.config, value.selection)
              && !researchRoute.some((entry) => entry.resourceId === id)) {
            researchRoute.push({ ...defaultWorkerRouteEntry(id, value.selection, input.scoped) });
          }
          enrolledSelectionKeys.set(id, currentKey);
        }
        // Re-pair retained entries with the new model's reasoning; this runs
        // only when the model changed during this visit.
        executeRoute = normalizeWorkerRouteAfterModelSwitch(executeRoute, id, value.selection, input.scoped);
        researchRoute = normalizeWorkerRouteAfterModelSwitch(researchRoute, id, value.selection, input.scoped);
      }
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
      activeReviewers = await selectReviewers(input.ui, activeReviewers, agents, input.scoped);
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
    if (choice === "web") {
      ({ maxDownloadBytes: webMaxDownloadBytes, browserInteractionApproval, browserIdleExpiryMinutes, browserDownloadRetention, browserVisible, browserPermissions } = await selectWebSettings(
        input.ui, webMaxDownloadBytes, browserInteractionApproval, browserIdleExpiryMinutes, browserDownloadRetention, browserVisible, browserPermissions,
      ));
      continue;
    }
    const error = await validateSelection(workerResources, activeReviewers, input.config, input.scoped, executeRoute, researchRoute);
    if (error) {
      await notify(input.ui, error, "error");
      continue;
    }
    const next = await persistReviewSettings(input.configPath!, {
      operatingMode,
      modeCycleShortcut,
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
      browserIdleExpiryMinutes,
      browserDownloadRetention,
      browserVisible,
      webBrowserPermissions: browserPermissions,
    });
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

const BROWSER_APPROVAL_CHOICES: Record<BrowserInteractionApproval, string> = {
  ask: "Ask",
  "automatically-accept": "Automatically Accept",
  "automatically-deny": "Automatically Deny",
};

async function selectWebSettings(
  ui: UiContext,
  initialMaxDownloadBytes: number,
  initialApproval: BrowserInteractionApproval,
  initialIdleExpiryMinutes: number,
  initialDownloadRetention: number,
  initialVisible: boolean,
  initialPermissions: WebBrowserPermissions,
): Promise<{ maxDownloadBytes: number; browserInteractionApproval: BrowserInteractionApproval; browserIdleExpiryMinutes: number; browserDownloadRetention: number; browserVisible: boolean; browserPermissions: WebBrowserPermissions }> {
  let maxDownloadBytes = initialMaxDownloadBytes;
  let browserInteractionApproval = initialApproval;
  let browserIdleExpiryMinutes = initialIdleExpiryMinutes;
  let browserDownloadRetention = initialDownloadRetention;
  let browserVisible = initialVisible;
  let browserPermissions = { ...initialPermissions };
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [downloadRow, approvalRow, idleExpiryRow, retentionRow, visibilityRow, permissionsRow] = alignedSettingsRows([
      ["Maximum download", formatByteSize(maxDownloadBytes)],
      ["Browser interaction approval", BROWSER_APPROVAL_CHOICES[browserInteractionApproval]],
      ["Browser idle expiry", browserIdleExpiryMinutes === 0 ? "0 · idle close disabled" : `${browserIdleExpiryMinutes} minutes`],
      ["Download retention", browserDownloadRetention === 0 ? "0 · unlimited unsaved downloads" : `${browserDownloadRetention} unsaved per session`],
      ["Browser visibility", browserVisible ? "Headed · visible browser window" : "Headless · no window (default)"],
      ["Browser permissions", browserPermissionsSummary(browserPermissions)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Web settings",
      rows: [
        { key: "download", label: downloadRow },
        { key: "approval", label: approvalRow },
        { key: "idleExpiry", label: idleExpiryRow },
        { key: "retention", label: retentionRow },
        { key: "visibility", label: visibilityRow },
        { key: "permissions", label: permissionsRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { maxDownloadBytes, browserInteractionApproval, browserIdleExpiryMinutes, browserDownloadRetention, browserVisible, browserPermissions };
    lastKey = choice;
    if (choice === "visibility") {
      await notify(ui, "Headless (default) keeps the QA browser without a window. Headed shows a real browser window with a native address bar. Saving a changed visibility applies it immediately to the live browser: the browser is replaced and its tabs, active page, and in-memory cookies/localStorage/IndexedDB are restored best-effort (never lossless; failures and redirects are reported). With no open browser it applies at the next BrowserOpen. The model's tools stay exactly the same either way.", "info");
      const selected = await ui.select("Browser visibility", ["Headless · no window (default)", "Headed · visible browser window"]);
      if (selected === "Headed · visible browser window") browserVisible = true;
      else if (selected === "Headless · no window (default)") browserVisible = false;
      continue;
    }
    if (choice === "permissions") {
      browserPermissions = await selectBrowserPermissions(ui, browserPermissions);
      continue;
    }
    if (choice === "approval") {
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
    if (choice === "idleExpiry") {
      const entered = await ui.input("Browser idle expiry in minutes (0 disables idle close)", String(browserIdleExpiryMinutes));
      if (entered === undefined) continue;
      // Empty input must stay rejected: Number("") would otherwise stage 0.
      const trimmed = entered.trim();
      const minutes = trimmed.length === 0 ? NaN : Number(trimmed);
      if (!Number.isSafeInteger(minutes) || minutes < 0) {
        await notify(ui, "Enter 0 to disable idle close, or a positive safe whole number of minutes.", "error");
        continue;
      }
      browserIdleExpiryMinutes = minutes;
      continue;
    }
    if (choice === "retention") {
      await notify(ui, "Maximum retained unsaved downloads per browser session. While the cap is reached, a new download cancels and releases the oldest retained one (after a live lowering, the next arrival may release more than one); saved files are never counted or affected. 0 disables count-based eviction entirely (normal save/close/revocation cleanup still applies). A lowered value takes effect when the next download arrives; editing this setting never deletes pending downloads.", "info");
      const entered = await ui.input("Maximum retained unsaved downloads per browser session (0 = unlimited)", String(browserDownloadRetention));
      if (entered === undefined) continue;
      // Empty input must stay rejected: Number("") would otherwise stage 0.
      const trimmed = entered.trim();
      const retention = trimmed.length === 0 ? NaN : Number(trimmed);
      if (!Number.isSafeInteger(retention) || retention < 0) {
        await notify(ui, "Enter 0 for unlimited, or a positive safe whole number of retained unsaved downloads.", "error");
        continue;
      }
      browserDownloadRetention = retention;
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

/** One-line state of the a-la-carte browser permissions for the Web row. */
function browserPermissionsSummary(permissions: WebBrowserPermissions): string {
  if (permissions.yolo) return "YOLO on";
  const enabled = BROWSER_PERMISSION_FIELDS.filter((field) => field !== "yolo" && permissions[field]).length;
  return `${enabled} of ${BROWSER_PERMISSION_FIELDS.length - 1} enabled`;
}

/**
 * Risk-appropriate enablement notices for the individual capability toggles
 * (issue #27). Disabling never warns: turning a permission off is
 * straightforward and can only reduce authority.
 */
const BROWSER_PERMISSION_ROWS: ReadonlyArray<{
  field: BrowserPermissionField;
  label: string;
  enableWarning?: string;
}> = [
  {
    field: "modelCredentialEntry",
    label: "Model credential entry",
    enableWarning: "Model credential entry lets the model type into password and credential fields. Entered values can still be exposed through tool results, model context, logs, and screenshots; masking alone does not protect secrets.",
  },
  {
    field: "modelCredentialSubmission",
    label: "Model credential submission",
    enableWarning: "Model credential submission lets the model submit forms containing credentials. It grants no broader network or filesystem authority. Human form submission is always allowed regardless of this toggle.",
  },
  {
    field: "modelUploads",
    label: "Model uploads",
    enableWarning: "Model uploads lets the model upload explicitly chosen host files into a page file input (BrowserUpload). Each upload follows the configured browser interaction approval policy and names the exact source paths; this is not permission for a page or model to read arbitrary host files. Human uploads are unaffected.",
  },
  {
    field: "modelDownloadSaving",
    label: "Model download saving",
    enableWarning: "Model download saving lets the model save retained pending downloads to explicitly chosen destinations, wherever the model's existing host write authority reaches (BrowserDownloadSave; relative paths resolve to the session working directory). Each save follows the configured browser interaction approval policy. Human downloads are unaffected.",
  },
  {
    field: "modelClipboard",
    label: "Model clipboard read/write",
    enableWarning: "Model clipboard access lets the model read from and write to the browser clipboard (the host system clipboard in a headed session; a per-instance virtual clipboard in headless mode), which can carry credentials or other secrets between applications.",
  },
  {
    field: "modelCamera",
    label: "Model camera",
    enableWarning: "Model camera grants camera access to the managed browser for model-driven sessions. This grants capability; it does not force activation.",
  },
  {
    field: "modelMicrophone",
    label: "Model microphone",
    enableWarning: "Model microphone grants microphone access to the managed browser for model-driven sessions. This grants capability; it does not force activation.",
  },
  {
    field: "modelGeolocation",
    label: "Model geolocation",
    enableWarning: "Model geolocation grants location access to the managed browser for model-driven sessions. Location is sensitive personal data.",
  },
  {
    field: "modelServiceWorkers",
    label: "Model service workers",
    enableWarning: "Model service workers allows service workers in the managed browser. This grants capability; it does not force registration or activation. The policy is fixed at browser launch, so enabling or disabling it while a browser session is live replaces that session in a controlled way (tabs, storage state, and granted permissions are restored best-effort and every loss is reported). Service-worker traffic still egresses only through the authenticated broker.",
  },
  {
    field: "modelPopupRestrictionOverride",
    label: "Model popup restriction override",
    enableWarning: "Model popup restriction override lifts the four-tab session limit for page-created popups while enabled: such popups are adopted as owned tabs with the same guards, routes, and broker egress as model-opened tabs. Model-initiated opens and ordinary browsing stay within the limit; already-adopted popup tabs remain open if you disable it.",
  },
  {
    field: "localNetworks",
    label: "Local networks (human and model)",
    enableWarning: "Local networks allows human and model navigation to loopback, private, and link-local addresses — including cloud metadata endpoints. This opens SSRF-style access to local services and instance metadata; use it only for intentional local-service or machine-role debugging.",
  },
];

const YOLO_PERMISSION_LABEL = "YOLO / allow everything";

const YOLO_ENABLE_WARNING =
  "YOLO enables every browser permission — model credential entry and submission, uploads, download saving, " +
  "clipboard read/write, camera, microphone, geolocation, service workers, popup restriction override, and local " +
  "network access including loopback, private, link-local, and cloud metadata addresses — and bypasses per-action " +
  "approval prompts (Ask, Automatically Accept, and Automatically Deny). Browsing can reach any destination with " +
  "full capability, and page content remains untrusted. This persists until you explicitly disable it; only a human " +
  "can enable or disable it.";

const YOLO_CONFIRM_MESSAGE =
  "Confirm enabling YOLO / allow everything for the managed browser. It stays enabled across restarts until you " +
  "disable it here; disabling is immediate and restores your saved individual permissions as the effective policy.";

/**
 * The Browser permissions submenu (issue #27): independently selectable
 * capability toggles plus the YOLO master override, staged like every other
 * settings section (Save/Cancel at the root).
 *
 * - Enabling an individual capability presents its risk-appropriate notice and
 *   then applies the staged toggle; disabling is straightforward.
 * - Every YOLO OFF → ON transition requires a prominent warning plus explicit
 *   interactive human confirmation. Cancellation, an unavailable confirm UI,
 *   or a failed save leaves it Off. Only this human-invoked command can enable
 *   it; page content and workers never reach this code path.
 * - YOLO ON → OFF is straightforward: no warning or confirmation, and the saved
 *   individual values become effective again exactly as stored.
 */
async function selectBrowserPermissions(ui: UiContext, initial: WebBrowserPermissions): Promise<WebBrowserPermissions> {
  let permissions = { ...initial };
  // Truthful status: every issue #27 capability is enforced. Credential
  // entry/submission, uploads, download saving, and clipboard read/write by
  // the interactive-browser tool actions; camera, microphone, and geolocation
  // as per-origin device grants issued on top-level navigation commits and
  // cleared live on disable (an unconfirmable engine clear fails the affected
  // session closed and is reported through the save rather than claimed
  // applied; a clear that does not settle within the cleanup deadline is
  // reported as still in flight and the affected session is closed to contain
  // any retained grants); service workers
  // at browser launch, with a
  // controlled replacement of a live browser when the saved policy changes;
  // the popup restriction override while it is enabled; local networks (and
  // YOLO's local-network effect) at the interactive egress broker.
  await notify(
    ui,
    "These stage the issue #27 browser permissions, and every capability is enforced. Credential entry/submission, uploads, download saving, and clipboard read/write are enforced by interactive-browser tool actions; camera, microphone, and geolocation apply as per-origin device permission grants issued when a tab commits to an origin (and cleared from live sessions when disabled — an unconfirmable engine clear closes the affected browser session instead of being claimed applied, and a clear that does not settle within the cleanup deadline is reported as still in flight and the affected session is closed to contain any retained grants); service workers apply at browser launch, so a saved change replaces the live browser in a controlled way that restores tabs, storage state, and granted permissions best-effort; the popup restriction override lifts the four-tab limit for page-created popups while enabled; local networks (including YOLO's local-network effect) is enforced at the interactive egress broker. Saved changes apply to the live session immediately.",
    "info",
  );
  // Caller-local last selection for this loop only: keys are the permission
  // field names (plus yolo/back), stable across the On/Off label flips, so a
  // toggled row stays highlighted on the re-show (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const rowLabels = alignedSettingsRows([
      ...BROWSER_PERMISSION_ROWS.map((row) => [row.label, permissions[row.field] ? "On" : "Off"] as const),
      [YOLO_PERMISSION_LABEL, permissions.yolo ? "On" : "Off"] as const,
    ]);
    const choice = await retainedSelect(ui, {
      title: "Browser permissions",
      rows: [
        ...BROWSER_PERMISSION_ROWS.map((row, index) => ({ key: row.field, label: rowLabels[index]! })),
        { key: "yolo", label: rowLabels[rowLabels.length - 1]! },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return permissions;
    lastKey = choice;
    if (choice === "yolo") {
      if (permissions.yolo) {
        permissions.yolo = false;
        await notify(ui, "YOLO disabled; the saved individual browser permissions are effective again.", "info");
      } else if (!await confirmYoloEnablement(ui)) {
        continue;
      } else {
        permissions.yolo = true;
      }
      continue;
    }
    const row = BROWSER_PERMISSION_ROWS.find((candidate) => candidate.field === choice);
    if (!row) continue;
    if (!permissions[row.field] && row.enableWarning) {
      await notify(ui, row.enableWarning, "warning");
    }
    permissions[row.field] = !permissions[row.field];
  }
}

/** Prominent warning plus explicit human confirmation for YOLO OFF → ON. */
async function confirmYoloEnablement(ui: UiContext): Promise<boolean> {
  await notify(ui, YOLO_ENABLE_WARNING, "warning");
  if (!ui.confirm) {
    await notify(ui, "YOLO requires an interactive confirmation dialog to enable; it stays Off.", "error");
    return false;
  }
  const confirmed = await ui.confirm("Enable YOLO / allow everything?", YOLO_CONFIRM_MESSAGE);
  if (!confirmed) {
    await notify(ui, "YOLO stays Off.", "info");
    return false;
  }
  return true;
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

async function selectOperatingMode(ui: UiContext, current: OperatingMode): Promise<OperatingMode> {
  const options = OPERATING_MODES.map((mode) => `${OPERATING_MODE_LABELS[mode]}${mode === current ? "  current" : ""}`);
  const selected = await ui.select("Operating mode", options);
  return OPERATING_MODES.find((mode) => selected === `${OPERATING_MODE_LABELS[mode]}${mode === current ? "  current" : ""}`) ?? current;
}

async function selectModeCycleShortcut(ui: UiContext, current: string): Promise<string> {
  if (!ui.input) {
    await notify(ui, "This UI does not support text input; the mode cycle hotkey cannot be edited here.", "error");
    return current;
  }
  while (true) {
    const entered = await ui.input("Mode cycle hotkey (modifiers + key, e.g. alt+m)", current);
    if (entered === undefined) return current;
    const trimmed = entered.trim();
    if (trimmed.length === 0) {
      await notify(ui, "Enter a shortcut such as alt+m, or cancel to keep the current one.", "error");
      continue;
    }
    let normalized: string;
    try {
      normalized = normalizeModeCycleShortcut(trimmed);
    } catch (error) {
      await notify(ui, error instanceof Error ? error.message : String(error), "error");
      continue;
    }
    // Never steal an occupied host binding: a key that Pi's live resolution
    // shows as a built-in binding is rejected and re-prompted, so the built-in
    // action keeps working. Conflicts with other extensions are not detectable
    // here (Pi reports those itself at startup) and are not claimed to be.
    const occupancy = findOccupiedHostBindings(normalized);
    if (occupancy.resolved && occupancy.bindings.length > 0) {
      await notify(
        ui,
        `'${normalized}' is also used by built-in Pi binding(s) (${occupancy.bindings.join(", ")}); pick a different key so the built-in action keeps working.`,
        "error",
      );
      continue;
    }
    return normalized;
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
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [retriesRow, baseRow, maxRow, repeatsRow, jitterRow] = alignedSettingsRows([
      ["Retries after initial attempt", String(policy.maxRetries)],
      ["Base delay", formatDuration(policy.baseDelayMs)],
      ["Maximum delay", formatDuration(policy.maxDelayMs)],
      ["Same-incident repeat limit", String(policy.maxSameIncidentRepeats)],
      ["Delay jitter", policy.jitter ? "Enabled" : "Disabled"],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Executor retry policy",
      rows: [
        { key: "retries", label: retriesRow },
        { key: "base", label: baseRow },
        { key: "max", label: maxRow },
        { key: "repeats", label: repeatsRow },
        { key: "jitter", label: jitterRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return policy;
    lastKey = choice;
    if (choice === "jitter") {
      policy.jitter = !policy.jitter;
      continue;
    }
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const isDelay = choice === "base" || choice === "max";
    const current = choice === "retries"
      ? policy.maxRetries
      : choice === "base"
        ? policy.baseDelayMs
        : choice === "max"
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
    if (choice === "retries") next.maxRetries = parsed;
    else if (choice === "base") next.baseDelayMs = parsed;
    else if (choice === "max") next.maxDelayMs = parsed;
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

/**
 * Display-only ordering: alphabetical by the displayed resource/model label
 * (case-insensitive), with a stable resource-ID tie-break. The key, not the
 * row order, is identity; saved catalogs are never reordered.
 */
function sortedCatalogKeys(catalog: WorkerResourceCatalog, config: ReviewGateConfig, scoped: ScopedModelChoice[]): string[] {
  return Object.keys(catalog).sort((a, b) => {
    const labelA = executorSelectionLabel(catalog[a]!.selection, config, scoped).toLowerCase();
    const labelB = executorSelectionLabel(catalog[b]!.selection, config, scoped).toLowerCase();
    if (labelA < labelB) return -1;
    if (labelA > labelB) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

async function selectExecutorPool(
  ui: UiContext,
  initial: WorkerResourceCatalog,
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  onAdd?: (resourceId: string, value: WorkerResourceValue) => void,
): Promise<WorkerResourceCatalog> {
  let catalog = cloneWorkerCatalog(initial);
  // Caller-local last selection for this loop only: entry keys are the stable
  // resource ids, so a re-shown list after add/edit/re-sort keeps the same
  // resource highlighted even when its label or position changed (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const keys = sortedCatalogKeys(catalog, config, scoped);
    const entryRows = keys.map((key, index) => `${index + 1}. ${executorPoolEntrySummary(catalog[key]!, config, scoped)}`);
    const choice = await retainedSelect(ui, {
      title: "Worker resources — shared capacity",
      rows: [
        ...keys.map((key, index) => ({ key, label: entryRows[index]! })),
        { key: "add", label: "Add worker resource" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return catalog;
    lastKey = choice;
    if (choice === "add") {
      const selection = await selectExecutorModel(ui, undefined, Object.values(catalog), agents, scoped);
      if (!selection) continue;
      const createdId = executorEntryId(selection);
      // The generated id can collide with a resource that kept its stable key
      // after switching away from this selection. Overwriting it would replace
      // an existing identity, capacity, and route references, so fail the Add.
      if (Object.prototype.hasOwnProperty.call(catalog, createdId)) {
        await notify(ui, `Cannot add: generated resource id ${createdId} already belongs to another resource whose model was switched away from it; existing resources are unchanged.`, "error");
        continue;
      }
      const maxConcurrent = await selectExecutorCapacity(ui, 1);
      const createdValue: WorkerResourceValue = { selection, maxConcurrent };
      setCatalogKey(catalog, createdId, createdValue);
      onAdd?.(createdId, createdValue);
      continue;
    }
    // Resource ids can never equal the action keys above (they are prefixed
    // external-/pi-), so an unknown value is a no-op re-show as before.
    if (!Object.prototype.hasOwnProperty.call(catalog, choice)) continue;
    catalog = await editExecutorPoolEntry(ui, catalog, choice, agents, config, scoped);
  }
}

/** Routes initialize exactly as stored; a missing or empty route stays empty. */
function initialWorkerRoute(
  config: ReviewGateConfig,
  kind: "execute" | "research",
): WorkerRouteEntry[] {
  const configured = config.execution?.routes?.[kind];
  return configured ? configured.map((entry) => ({ ...entry })) : [];
}

function reconcileWorkerRoute(route: WorkerRouteEntry[], resources: WorkerResourceCatalog): WorkerRouteEntry[] {
  return route.filter((entry) => Object.prototype.hasOwnProperty.call(resources, entry.resourceId));
}

/** Catalog subset of the research-capable resources, keyed as before. */
function filterResearchCapableCatalog(config: ReviewGateConfig, catalog: WorkerResourceCatalog): WorkerResourceCatalog {
  const out: WorkerResourceCatalog = {};
  for (const [id, value] of Object.entries(catalog)) {
    if (!workerResourceSupportsResearch(config, value.selection)) continue;
    setCatalogKey(out, id, { selection: { ...value.selection }, maxConcurrent: value.maxConcurrent });
  }
  return out;
}

/**
 * A worker resource's reasoning goes hand in hand with its selected model, so a
 * manual model replacement discards the previous model's level for every retained
 * route entry — even when the new model supports it. Each entry takes the new
 * model's own configured or pinned reasoning, otherwise its supported default,
 * so displayed, persisted, routed, and effective values all stay paired with the
 * model. External agents own their configuration; a Pi reasoning override no
 * longer applies.
 */
function normalizeWorkerRouteAfterModelSwitch(
  route: WorkerRouteEntry[],
  resourceId: string,
  selection: ExecutorSelection,
  scoped: ScopedModelChoice[],
): WorkerRouteEntry[] {
  if (selection.source !== "pi") {
    return route.map((entry) => entry.resourceId === resourceId
      ? { resourceId }
      : entry);
  }
  const choice = scoped.find((candidate) => candidate.model === selection.model);
  if (!choice) return route;
  const level = effectiveThinkingLevel(undefined, choice);
  return route.map((entry) => entry.resourceId === resourceId
    ? { resourceId, thinkingLevel: level }
    : entry);
}

function defaultWorkerRouteEntry(resourceId: string, selection: ExecutorSelection, scoped: ScopedModelChoice[]): WorkerRouteEntry {
  const choice = selection.source === "pi"
    ? scoped.find((candidate) => candidate.model === selection.model)
    : undefined;
  return {
    resourceId,
    thinkingLevel: choice ? effectiveThinkingLevel(undefined, choice) : undefined,
  };
}

async function selectWorkerRoute(
  ui: UiContext,
  title: string,
  initial: WorkerRouteEntry[],
  resources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): Promise<WorkerRouteEntry[]> {
  let route = reconcileWorkerRoute(initial.map((entry) => ({ ...entry })), resources);
  // Caller-local last selection for this loop only: entry keys are the stable
  // resource ids, so the edited entry stays highlighted when the list re-shows
  // after an add, exclude, or move (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const rows = route.map((entry, index) => `${index + 1}. ${workerRouteEntrySummary(entry, resources, config, scoped)}`);
    const choice = await retainedSelect(ui, {
      title,
      rows: [
        ...route.map((entry, index) => ({ key: entry.resourceId, label: rows[index]! })),
        { key: "add", label: "Add resource" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return route;
    lastKey = choice;
    if (choice === "add") {
      const used = new Set(route.map((entry) => entry.resourceId));
      const availableKeys = sortedCatalogKeys(resources, config, scoped).filter((key) => !used.has(key));
      const labels = availableKeys.map((key) => executorSelectionLabel(resources[key]!.selection, config, scoped));
      const selected = await ui.select(`${title} — add`, labels.length ? [...labels, "Back"] : ["No additional resources", "Back"]);
      const index = labels.indexOf(selected ?? "");
      if (index >= 0) {
        const key = availableKeys[index]!;
        const selection = resources[key]!.selection;
        const modelChoice = selection.source === "pi"
          ? scoped.find((candidate) => candidate.model === selection.model)
          : undefined;
        route.push({
          resourceId: key,
          thinkingLevel: selection.source === "pi" && modelChoice
            ? effectiveThinkingLevel(selection.thinkingLevel, modelChoice)
            : undefined,
        });
      }
      continue;
    }
    let index = route.findIndex((candidate) => candidate.resourceId === choice);
    if (index < 0) continue;
    // The per-entry editor re-shows after every action (Move up/down
    // deliberately keeps editing the moved entry), so it retains its own last
    // action by key (issue #140).
    let editLastKey: string | undefined;
    while (route[index]) {
      const entry = route[index]!;
      const resource = Object.prototype.hasOwnProperty.call(resources, entry.resourceId)
        ? resources[entry.resourceId]
        : undefined;
      if (!resource) break;
      const [thinkingRow] = alignedSettingsRows([
        ["Thinking", routeThinkingSummary(entry, resource, scoped)],
      ]);
      const edit = await retainedSelect(ui, {
        title: `${title} — ${executorSelectionLabel(resource.selection, config, scoped)}`,
        rows: [
          ...(resource.selection.source === "pi" ? [{ key: "thinking", label: thinkingRow }] : []),
          ...(index > 0 ? [{ key: "moveUp", label: "Move up" }] : []),
          ...(index < route.length - 1 ? [{ key: "moveDown", label: "Move down" }] : []),
          { key: "exclude", label: "Exclude from this route" },
          { key: "back", label: "Back" },
        ],
        initialKey: editLastKey,
      });
      if (!edit || edit === "back") break;
      editLastKey = edit;
      if (edit === "thinking" && resource.selection.source === "pi") {
        const selection = resource.selection;
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (model) entry.thinkingLevel = await selectThinkingLevel(
          ui,
          model,
          effectiveThinkingLevel(entry.thinkingLevel ?? selection.thinkingLevel, model),
        );
      } else if (edit === "moveUp" && index > 0) {
        [route[index - 1], route[index]] = [route[index]!, route[index - 1]!];
        index -= 1;
      } else if (edit === "moveDown" && index < route.length - 1) {
        [route[index], route[index + 1]] = [route[index + 1]!, route[index]!];
        index += 1;
      } else if (edit === "exclude") {
        route.splice(index, 1);
        break;
      }
    }
  }
}

/**
 * Edit one catalog resource by its stable key. The catalog is unordered: there
 * are no reorder controls; ordering lives in the explicit role routes.
 */
async function editExecutorPoolEntry(
  ui: UiContext,
  initial: WorkerResourceCatalog,
  key: string,
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): Promise<WorkerResourceCatalog> {
  let catalog = cloneWorkerCatalog(initial);
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (Object.prototype.hasOwnProperty.call(catalog, key)) {
    const entry = catalog[key]!;
    const [modelRow, capacityRow] = alignedSettingsRows([
      ["Model", executorSelectionLabel(entry.selection, config, scoped)],
      ["Maximum concurrency", String(entry.maxConcurrent)],
    ]);
    const choice = await retainedSelect(ui, {
      title: `Worker resource ${key}`,
      rows: [
        { key: "model", label: modelRow },
        { key: "capacity", label: capacityRow },
        { key: "remove", label: "Remove" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return catalog;
    lastKey = choice;
    if (choice === "model") {
      const others = Object.entries(catalog)
        .filter(([candidateKey]) => candidateKey !== key)
        .map(([, value]) => value);
      const selection = await selectExecutorModel(ui, entry.selection, others, agents, scoped);
      if (selection) setCatalogKey(catalog, key, { ...entry, selection });
      continue;
    }
    if (choice === "capacity") {
      setCatalogKey(catalog, key, { ...entry, maxConcurrent: await selectExecutorCapacity(ui, entry.maxConcurrent) });
      continue;
    }
    if (choice === "remove") {
      delete catalog[key];
      return catalog;
    }
  }
  return catalog;
}

/** Define an own data property even for keys like "__proto__" or "constructor". */
function setCatalogKey(catalog: WorkerResourceCatalog, key: string, value: WorkerResourceValue): void {
  Object.defineProperty(catalog, key, { value, enumerable: true, writable: true, configurable: true });
}

async function selectExecutorModel(
  ui: UiContext,
  current: ExecutorSelection | undefined,
  existing: WorkerResourceValue[],
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
  // Caller-local last selection for this loop only: keys are the reviewer
  // keys (reasoning rows prefixed), stable across the ✓/✗ label flips, so a
  // toggled row stays highlighted on the re-show (issue #140).
  let lastKey: string | undefined;
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
      return [{ key: row.key, label: `Reasoning · ${row.label}  ${thinkingLevelLabel(level)}`, selection, choice }];
    });
    const choice = await retainedSelect(ui, {
      title: `Reviewers — Enter toggles — ${selected.length}/${rows.length} selected`,
      rows: [
        ...rows.map((row) => ({ key: row.key, label: `${row.label} ${hasReviewer(selected, row.value) ? "✓" : "✗"}` })),
        ...unavailable.map((selection) => ({ key: reviewerKey(selection), label: `${reviewerSelectionLabel(selection)} [unavailable] ✓` })),
        ...reasoningRows.map((row) => ({ key: `reasoning:${row.key}`, label: row.label })),
        { key: "enableAll", label: "Enable all" },
        { key: "clearAll", label: "Clear all" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return selected;
    lastKey = choice;
    if (choice === "enableAll") {
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
    if (choice === "clearAll") {
      selected = [];
      continue;
    }
    const row = rows.find((candidate) => candidate.key === choice);
    const unavailableRow = unavailable.find((candidate) => reviewerKey(candidate) === choice);
    const reasoningRow = reasoningRows.find((candidate) => `reasoning:${candidate.key}` === choice);
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
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [cyclesRow, guidanceRow] = alignedSettingsRows([
      ["Automatic correction attempts", String(maxCorrectionCycles)],
      ["Concrete guidance after", String(guidanceThreshold)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Review policy",
      rows: [
        { key: "cycles", label: cyclesRow },
        { key: "guidance", label: guidanceRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { maxCorrectionCycles, guidanceThreshold };
    lastKey = choice;
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const current = choice === "cycles" ? maxCorrectionCycles : guidanceThreshold;
    const entered = await ui.input(
      choice === "cycles" ? "Automatic correction attempts" : "Concrete guidance after correction attempts",
      String(current),
    );
    if (entered === undefined) continue;
    const parsed = Number(entered.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      await notify(ui, "Enter a non-negative whole number.", "error");
      continue;
    }
    if (choice === "cycles") maxCorrectionCycles = parsed;
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
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [reviewerRow, executorRow] = alignedSettingsRows([
      ["Reviewer timeout", formatDuration(reviewerTimeoutMs)],
      ["Executor timeout", formatDuration(executorTimeoutMs)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Timeouts",
      rows: [
        { key: "reviewer", label: reviewerRow },
        { key: "executor", label: executorRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return { reviewerTimeoutMs, executorTimeoutMs };
    lastKey = choice;
    if (!ui.input) {
      await notify(ui, "This UI does not support numeric input.", "error");
      continue;
    }
    const currentMs = choice === "reviewer" ? reviewerTimeoutMs : executorTimeoutMs;
    const entered = await ui.input(
      choice === "reviewer" ? "Reviewer timeout in minutes" : "Executor timeout in minutes",
      String(currentMs / 60_000),
    );
    if (entered === undefined) continue;
    const minutes = Number(entered.trim());
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60_000 > Number.MAX_SAFE_INTEGER) {
      await notify(ui, "Enter a positive number of minutes.", "error");
      continue;
    }
    const timeoutMs = Math.round(minutes * 60_000);
    if (choice === "reviewer") reviewerTimeoutMs = timeoutMs;
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
  workerResources: WorkerResourceCatalog,
  reviewers: ActiveReviewerSelection[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  executeRoute: WorkerRouteEntry[] = [],
  researchRoute: WorkerRouteEntry[] = [],
): Promise<string | undefined> {
  const duplicateReviewer = duplicate(reviewers.map(reviewerKey));
  if (duplicateReviewer) return `Duplicate enabled reviewer: ${duplicateReviewer}`;
  const scopedModels = new Set(scoped.map((choice) => choice.model));
  const duplicateExecutor = duplicate(Object.values(workerResources).map((entry) => executorSelectionKey(entry.selection)));
  if (duplicateExecutor) return `Duplicate executor pool selection: ${duplicateExecutor}`;
  for (const [kind, route] of [["Execution", executeRoute], ["Research", researchRoute]] as const) {
    const duplicateResource = duplicate(route.map((entry) => entry.resourceId));
    if (duplicateResource) return `${kind} priority contains duplicate resource: ${duplicateResource}`;
    for (const entry of route) {
      const resource = Object.prototype.hasOwnProperty.call(workerResources, entry.resourceId)
        ? workerResources[entry.resourceId]
        : undefined;
      if (!resource) return `${kind} priority references missing worker resource: ${entry.resourceId}`;
      if (kind === "Research" && !workerResourceSupportsResearch(config, resource.selection)) {
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
  for (const [resourceId, entry] of Object.entries(workerResources)) {
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1 || entry.maxConcurrent > MAX_EXECUTION_WORKERS) {
      return `Executor maximum concurrency must be between 1 and ${MAX_EXECUTION_WORKERS}: ${resourceId}`;
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
    const agent = resolvedExternalAgent(config, selection.id);
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
    const agent = resolvedExternalAgent(config, reviewer.id);
    if (!agent || !externalAgentSupportsReview(agent)) return `External reviewer is unavailable: ${reviewer.id}`;
    if (config.enabled && !await commandAvailable(agent.command!)) return `Reviewer executable is unavailable: ${agent.command} (${agent.id})`;
  }
  return undefined;
}

function initialReviewerSelections(config: ReviewGateConfig): ActiveReviewerSelection[] {
  return (config.review?.activeReviewers ?? []).map(cloneReviewerSelection);
}

function executorPoolSummary(catalog: WorkerResourceCatalog): string {
  const values = Object.values(catalog);
  const slots = values.reduce((total, entry) => total + entry.maxConcurrent, 0);
  return `${values.length} ${values.length === 1 ? "model" : "models"} · ${slots} ${slots === 1 ? "slot" : "slots"}`;
}

function workerRouteSummary(
  route: WorkerRouteEntry[],
  resources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): string {
  if (route.length === 0) return "Disabled (no resources)";
  return route.map((entry) => {
    const resource = Object.prototype.hasOwnProperty.call(resources, entry.resourceId)
      ? resources[entry.resourceId]
      : undefined;
    return resource ? executorSelectionLabel(resource.selection, config, scoped).split(" [")[0] : `${entry.resourceId} [missing]`;
  }).join(" → ");
}

function workerRouteEntrySummary(
  route: WorkerRouteEntry,
  resources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): string {
  const resource = Object.prototype.hasOwnProperty.call(resources, route.resourceId)
    ? resources[route.resourceId]
    : undefined;
  if (!resource) return `${route.resourceId} [missing]`;
  return `${executorSelectionLabel(resource.selection, config, scoped)} · ${routeThinkingSummary(route, resource, scoped)} · shared max ${resource.maxConcurrent}`;
}

function routeThinkingSummary(route: WorkerRouteEntry, resource: WorkerResourceValue, scoped: ScopedModelChoice[]): string {
  if (resource.selection.source === "external") return "Configured by agent";
  const selection = { ...resource.selection, thinkingLevel: route.thinkingLevel ?? resource.selection.thinkingLevel };
  return executorThinkingSummary(selection, scoped);
}

function executorPoolEntrySummary(entry: WorkerResourceValue, config: ReviewGateConfig, scoped: ScopedModelChoice[]): string {
  return `${executorSelectionLabel(entry.selection, config, scoped)} · shared max ${entry.maxConcurrent}`;
}

function executorSelectionLabel(selection: ExecutorSelection, config: ReviewGateConfig, scoped: ScopedModelChoice[]): string {
  if (selection.source === "pi") {
    return scoped.find((candidate) => candidate.model === selection.model)?.label ?? `${selection.model} [unavailable]`;
  }
  const agent = resolvedExternalAgent(config, selection.id);
  return agent && externalAgentSupportsExecution(agent) ? `${agent.id} [${agent.adapter}]` : `${selection.id} [unavailable]`;
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

function withoutResourceThinkingCatalog(catalog: WorkerResourceCatalog): WorkerResourceCatalog {
  const out: WorkerResourceCatalog = {};
  for (const [resourceId, entry] of Object.entries(catalog)) {
    const selection = { ...entry.selection };
    if (selection.source === "pi") delete selection.thinkingLevel;
    setCatalogKey(out, resourceId, { selection, maxConcurrent: entry.maxConcurrent });
  }
  return out;
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
  if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.select !== "function") return undefined;
  // Delegate to the live host UI object (prototype chain) so members beyond
  // this interface — e.g. setStatus, used after saving — keep working, and
  // carry the command context's run mode for guarding terminal-only custom
  // components (issue #140).
  const ui = Object.create(ctx.ui) as UiContext;
  if (typeof ctx.mode === "string") ui.mode = ctx.mode;
  return ui;
}

async function notify(ui: UiContext, message: string, type: "info" | "warning" | "error"): Promise<void> {
  ui.notify?.(message, type);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
