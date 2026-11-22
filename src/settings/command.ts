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
  effectiveReviewEvidenceSettings,
  externalAgentCatalog,
  externalAgentSupportsReview,
  resolvedWorkerCatalog,
  type ActiveReviewerSelection,
  type ExternalAgentConfig,
  type OperatingMode,
  type ReviewGateConfig,
  type ScheduledTaskCatalog,
  type WorkerRouteEntry,
} from "../config";
import { OPERATING_MODE_LABELS } from "../operating-mode";
import { registerHook, sendNotice } from "../pi";
import { publishForegroundEscape } from "../foreground-escape";
import { abortActiveNativeEditorField } from "../native-editor-bridge";
import { createMenuActionFence, retainedSelect, type MenuCustomFactory, type SettingsSaveControl } from "./menu";
import { captureExternalAgentReferenceBaseline, changeExternalAgent, manageExternalAgents, stageExternalAgentOperation, type ExternalAgentOperation } from "./external-agent-catalog";
import { projectExternalAgentValue, type ExternalAgentFormBranch, type ExternalAgentFormBranchSnapshot } from "./external-agents";
import { scopedModelChoices, type ScopedModelChoice } from "./models";
import { assembleStagedSelectionConfig, captureScheduledAlreadyRun, replaceConfig } from "./persistence";
import {
  commitPersistedSave,
  localPersistedSaveBackend,
  preparePersistedSave,
  type PersistedSaveBackend,
  type PersistedSaveSelection,
  type PreparedPersistedSave,
  type StagedPersistedSave,
} from "./persisted-save";
import { clearPendingSessionDelta, getPendingSessionDelta, recordPendingSessionDelta } from "./session-delta";
import { collectScheduledImageCandidates, rollbackScheduledImageAssets } from "./scheduled-image-assets";
import { alignedSettingsRows, formatDuration, notify, type UiContext } from "./ui";
import { draftSlot } from "./draft";
import { deniableToolNames, readToolChoices, selectToolSettings, toolsRootSummary, type RetainedToolDenials } from "./tools";
import { expandScheduledTaskWorkspaces, scheduledSummary, selectScheduledTasks, type SelectScheduledTasksOptions } from "./scheduled-tasks";
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
  retentionSummary,
  selectRetention,
  selectMaxWorkers,
  selectModeCycleShortcut,
  selectOperatingMode,
  selectReviewPolicy,
  selectRetryPolicy,
  selectSubtaskSettings,
  selectTimeouts,
  subtasksRootSummary,
} from "./controls";
import { stagedToolProtectionSettings } from "./tool-protection";
import { collectExternalAgentAvailabilityWarnings } from "./validation";

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
  /**
   * Authoritative pre-role-deny candidate tools for the Tools pickers
   * (issue #434, and the #536 audit-name picker), supplied by the runtime from
   * the host's otherwise-discoverable inventory. Reading it never activates or
   * authorizes a tool; it only labels the choices. When absent or malformed the
   * selectors still render every saved name, so nothing staged is lost or
   * silently granted. The deny selectors drop the reserved `tool_search` loader
   * from this inventory; the audit picker keeps it when the runtime offers it.
   */
  getToolChoices?: () => readonly { name: string; description?: string }[];
  /**
   * Loader-INCLUSIVE live inventory for the tool-protection audit-name picker
   * (issue #536). The audit subset may name any exact tool, the reserved
   * discovery loader included, so it cannot read the deny-shaped list — that
   * one drops the loader before the settings menu ever sees it. Availability
   * comes from the runtime's own metadata, and reading it activates nothing.
   * When absent, the audit picker falls back to `getToolChoices` and a saved
   * loader name simply stays a reversible unavailable row.
   */
  getAuditedToolChoices?: () => readonly { name: string; description?: string }[];
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
      await runSettingsMenuWithDraftStatus({
        config: input.config,
        configPath: input.configPath,
        ui,
        scoped,
        getToolChoices: input.getToolChoices,
        getAuditedToolChoices: input.getAuditedToolChoices,
        // The live session transaction reads its host effects from the
        // registration input itself, exactly as before (issue #653).
        transaction: { kind: "session", host: input },
      }, initialSection);
    };
  input.pi.registerCommand("review-settings", {
    description: "Configure delegated execution, tool denials and deferred Pi tools, YouShouldKnow notices and completion guidance, reviewers, review policy, scheduled tasks, web tools, and retention.",
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

/**
 * The live-session host effects of the /review-settings transaction: the
 * effective config's install callback and the process-local scheduler switch.
 * Read from the registration input at the moment each effect runs.
 */
type SessionSettingsHost = Pick<RegisterSettingsInput, "onSaved" | "schedulerRuntime">;

/**
 * Which transaction one settings menu run belongs to (issue #653). Both kinds
 * share the one menu, staged selection, section handlers, validation, and
 * persistence boundary; only the root exits and their effects differ:
 *
 * - `session` — the live /review-settings transaction over the EFFECTIVE
 *   config: root Escape validates and applies session-only (pending delta),
 *   Save persists then installs through replaceConfig/onSaved, and the
 *   Scheduler runtime row flips the process switch.
 * - `persisted` — the disk-only transaction over a menu-local config the caller
 *   loaded from disk: root Escape and Cancel discard before any validation or
 *   image copy, and only Save/Ctrl+S validates, prepares images, and persists.
 *   It never installs into a live config, calls onSaved, reads or records a
 *   pending session delta, or touches a scheduler runtime.
 */
type SettingsTransaction =
  | { kind: "session"; host: SessionSettingsHost }
  | {
      kind: "persisted";
      /** The persisted-only Save seam; see PersistedReviewSettingsInput.backend. */
      backend: PersistedSaveBackend;
      beforePersist?: PersistedReviewSettingsInput["beforePersist"];
      /** The caller's target-switch seam; see PersistedReviewSettingsInput.targetControl. */
      targetControl?: PersistedReviewSettingsInput["targetControl"];
      /** The workspace spelling contract; see PersistedReviewSettingsInput.workspaceInput. */
      workspaceInput?: PersistedReviewSettingsInput["workspaceInput"];
    };

/** The shared settings menu input: the menu-local config plus its transaction. */
interface SettingsMenuInput {
  /**
   * Session: the live effective config (installed into on apply/Save).
   * Persisted: the caller's fresh disk-loaded config, read-only here.
   */
  config: ReviewGateConfig;
  configPath: string;
  ui: UiContext;
  scoped: ScopedModelChoice[];
  getToolChoices?: RegisterSettingsInput["getToolChoices"];
  getAuditedToolChoices?: RegisterSettingsInput["getAuditedToolChoices"];
  transaction: SettingsTransaction;
}

/** How one settings menu run ended. */
type SettingsMenuOutcome =
  | { kind: "saved"; config: ReviewGateConfig }
  | { kind: "applied" }
  | { kind: "discarded" }
  /**
   * A caller-supplied target switch was accepted (see
   * PersistedReviewSettingsInput.targetControl). The old transaction ended
   * here: nothing was saved, validated, copied, or applied, and the caller
   * loads the newly chosen target itself.
   */
  | { kind: "switched" };

/**
 * Input for the disk-only settings transaction (issue #653). The caller owns
 * config path resolution and the fresh disk read; `config` is menu-local
 * loaded data, never an effective/live session config, and this transaction
 * never mutates it.
 */
export interface PersistedReviewSettingsInput {
  /** A fresh config loaded from `configPath` by the caller. */
  config: ReviewGateConfig;
  /** The explicit persistent config file the Save writes (and image assets anchor to). */
  configPath: string;
  /**
   * The host settings UI. Supply `editText` for a host-owned text field. The
   * run attaches its own Ctrl+S save control as `ui.saveControl` while open.
   */
  ui: UiContext;
  /** The scoped model choices offered to model/reasoning selectors. */
  scoped: ScopedModelChoice[];
  /** Display-only deny-picker inventory (see RegisterSettingsInput). */
  getToolChoices?: () => readonly { name: string; description?: string }[];
  /** Display-only loader-inclusive audit inventory (see RegisterSettingsInput). */
  getAuditedToolChoices?: () => readonly { name: string; description?: string }[];
  /**
   * Optional caller step run only on an explicit Save (row or Ctrl+S), after
   * the staged selection validated and scheduled images were prepared, and
   * immediately before the shared persistence boundary writes `configPath`.
   * Never run on open, root Escape, or Cancel. A rejection follows the shared
   * Save failure policy (prepared image copies are rolled back and nothing is
   * written). Used by the session host to publish an absent canonical config
   * through its existing guarded initializer on first Save (issue #653).
   *
   * Issue #716: the hook travels with the staged payload, and the Save backend
   * runs it on the config's owner — never as requester-local work before the
   * backend is called.
   */
  beforePersist?: () => void | Promise<void>;
  /**
   * Optional persisted-only Save backend (issue #716). Defaults to
   * `localPersistedSaveBackend`, which runs the shared preparation and commit
   * against this host's `configPath`. A delegating backend receives the
   * internally staged payload instead and is called BEFORE any requester-local
   * preparation, so submitting a draft for another host needs no local path
   * probe, managed image copy, directory check, or config read/write. The
   * staged payload is internal menu state, never a wire DTO.
   */
  backend?: PersistedSaveBackend;
  /**
   * Optional host-target switch seam for a caller whose outer editor loop owns
   * the target list (the remote Review editor). When supplied, the root menu
   * renders exactly one `Host: <label>` action and changes nothing else;
   * choosing it calls {@link requestSwitch} with whether THIS transaction
   * stages anything different from its opening baseline. That is a value
   * comparison over the shared staged selection — never rendered text, save
   * validation, or a filesystem probe.
   *
   * - `true` means the caller already chose a DISTINCT target and confirmed
   *   the switch if the draft was dirty. The old transaction ends at once with
   *   the `switched` outcome: no Save, validation, managed image copy, write,
   *   or live effect. (A caller that resolves `true` for the same target would
   *   abandon the draft; same-target is the caller's own no-op.)
   * - `false` covers a cancelled picker, a declined dirty confirmation, and
   *   the caller's same-target no-op. Nothing closes: the menu re-shows with
   *   exactly the same draft, staged edits included.
   *
   * Ctrl+S is suspended for the whole request, so a chord pressed inside the
   * caller's temporary picker or confirmation can neither latch this
   * transaction's Save nor unwind that picker; the shared held-action fence is
   * untouched. Omitting this member leaves the menu, its rows, and every
   * outcome exactly as they were. A rejection from the request propagates to
   * the caller unchanged (the shared Save backend follows the same policy):
   * the menu never treats a failed request as a switch or as a cancel.
   */
  targetControl?: {
    readonly label: string;
    requestSwitch(hasUnsavedChanges: boolean): Promise<boolean>;
  };
  /**
   * Optional scheduled-workspace text contract (the remote Review editor).
   * `"owner"` stages the workspace field exactly as typed: a leading
   * `~`/`~/...` is NOT expanded against this requester's home, because the
   * config belongs to another host and that owner expands its own home on the
   * owner-side Save. Omitted (the live menu and the Local editor) keeps the
   * existing immediate home expansion. Nothing else about the field, its
   * validation, or the staged spelling changes. This is also the existing
   * owner-target marker for the mode-cycle shortcut editor: an owner-held
   * config validates the chord's syntax only, because its keybinding occupancy
   * belongs to the destination and is applied by the owner on Save.
   */
  workspaceInput?: "owner";
}

/**
 * Result of the disk-only settings transaction: `saved` carries the config the
 * Save wrote (as normalized by the persistence boundary); `discarded` means
 * root Escape or Cancel ended the run and nothing was validated, copied, or
 * written; `switched` means the caller's target switch was accepted, so this
 * transaction ended without a Save and the caller loads the new target itself.
 */
export type PersistedReviewSettingsOutcome =
  | { kind: "saved"; config: ReviewGateConfig }
  | { kind: "discarded" }
  | { kind: "switched" };

/**
 * Opens the shared settings menu as a disk-only transaction (issue #653): the
 * same staged menu, section handlers, validation, image preparation, and
 * persistence guards as /review-settings, without any live-session effect.
 * Root Escape and Cancel discard; Save and Ctrl+S persist to `configPath`.
 * Running sessions are untouched — only configs loaded from disk afterwards
 * see the saved result. A persistence failure follows the shared Save policy
 * (an external-worker conflict keeps the menu open with an error notice; any
 * other failure rejects). A caller that supplies a target control can end the
 * run with the distinct `switched` outcome instead, as described on
 * {@link PersistedReviewSettingsInput.targetControl}.
 */
export async function runPersistedReviewSettings(input: PersistedReviewSettingsInput): Promise<PersistedReviewSettingsOutcome> {
  const outcome = await runSettingsMenuWithDraftStatus({
    config: input.config,
    configPath: input.configPath,
    ui: input.ui,
    scoped: input.scoped,
    getToolChoices: input.getToolChoices,
    getAuditedToolChoices: input.getAuditedToolChoices,
    transaction: {
      kind: "persisted",
      backend: input.backend ?? localPersistedSaveBackend,
      beforePersist: input.beforePersist,
      targetControl: input.targetControl,
      workspaceInput: input.workspaceInput,
    },
  });
  // The persisted transaction has no session-only apply. An accepted target
  // switch is its own outcome and never a Save: the caller loads the newly
  // chosen target after this returns.
  if (outcome.kind === "saved") return outcome;
  if (outcome.kind === "switched") return outcome;
  return { kind: "discarded" };
}

/**
 * Run one settings transaction with the shared dirty-draft handle attached for
 * exactly the transaction's lifetime (issue #723).
 *
 * The transaction owns the only dirty comparison — it reads the single shared
 * staged draft — and publishes that predicate here as soon as the draft exists.
 * This wrapper detaches it on EVERY completion: Save, root Escape, Cancel, an
 * accepted target switch, or a rejection, so a host never keeps a handle to a
 * draft that is gone. One registration per UI per transaction, never an
 * observer list, and a host without the seam changes nothing about how its
 * transaction runs.
 */
async function runSettingsMenuWithDraftStatus(
  input: SettingsMenuInput,
  initialSection: SettingsMenuInitialSection = "root",
): Promise<SettingsMenuOutcome> {
  const port = input.ui.settingsDraftStatus;
  if (typeof port?.attach !== "function") return await runSettingsMenu(input, initialSection);
  let detach: (() => void) | undefined;
  try {
    return await runSettingsMenu(input, initialSection, (isChanged) => {
      detach = port.attach(isChanged);
    });
  } finally {
    if (typeof detach === "function") detach();
  }
}

/**
 * The one settings menu of one transaction, over the single shared staged
 * draft (see the `draft` holder below).
 *
 * @param publishDraftStatus called once, at transaction opening, with this
 * transaction's own dirty predicate; whoever supplies it owns detaching the
 * registration for the whole transaction lifetime (issue #723).
 */
async function runSettingsMenu(
  input: SettingsMenuInput,
  initialSection: SettingsMenuInitialSection = "root",
  publishDraftStatus?: (isChanged: () => boolean) => void,
): Promise<SettingsMenuOutcome> {
  const transaction = input.transaction;
  // The caller-supplied target switch (see PersistedReviewSettingsInput):
  // absent for the live session transaction and for every caller that does not
  // own an outer target loop, so their menus and outcomes are unchanged.
  const hostTarget = transaction.kind === "persisted" ? transaction.targetControl : undefined;
  // The Scheduled tasks workspace-field spelling contract; see
  // PersistedReviewSettingsInput.workspaceInput.
  const scheduledTaskOptions: SelectScheduledTasksOptions = transaction.kind === "persisted" && transaction.workspaceInput === "owner"
    ? { workspaceInput: "owner" }
    : {};
  // A caller-owned target switch asks the leaf editors to keep a stored
  // reasoning representation on no-op reasoning edits; every other transaction
  // keeps the editors' existing behavior.
  const preserveCurrentThinking = hostTarget !== undefined;
  // #306/#294: the already-run baseline at menu opening, so a root Escape can
  // preserve consumption AND re-arms that land while this menu is open (the
  // bidirectional protection), not only live-true consumption.
  // Session transactions only: the persisted transaction never installs into
  // its menu-local config, so it has no already-run install baseline.
  const scheduledTasksAlreadyRunBeforeMenu = transaction.kind === "session" ? captureScheduledAlreadyRun(input.config) : undefined;
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
  // Issue #653: the disk-only transaction never reads a pending session delta.
  const pendingDelta = transaction.kind === "session" ? getPendingSessionDelta(input.config) : undefined;
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
  // Issue #175: the review draft is the layer-split state. A legacy
  // `review.activeReviewers` record is imported into both sets here (menu
  // display is immediate), and the stored file is untouched until a save.
  const effectiveReview = effectiveReviewSettings(input.config);
  // THE shared staged draft of this transaction (issue #723): every value the
  // menu stages lives on this one holder tree, and each nested menu edits it
  // through the sub-holder it is handed — see src/settings/draft.ts. The root
  // keeps no locals of its own, so there is one editing path and one staged
  // state for every surface: an accepted edit is in the shared draft as soon as
  // it is drawn, while the operator is still nested, and the one dirty
  // comparison below reads exactly the values Save and Apply commit.
  const draft = {
    operatingMode: input.config.operatingMode,
    modeCycleShortcut: input.config.modeCycleShortcut,
    // The catalog is keyed by stable resource ID; display order (alphabetical)
    // never defines identity or scheduling, and routes are explicit references.
    workers: {
      workerResources: withoutResourceThinkingCatalog(resolvedWorkerCatalog(input.config)),
      executeRoute: initialWorkerRoute(input.config, "execute"),
      researchRoute: initialWorkerRoute(input.config, "research"),
    },
    review: {
      primaryReviewers: materializeReviewerThinking(effectiveReview.primaryReviewers, input.scoped),
      subtaskReviewers: materializeReviewerThinking(effectiveReview.subtaskReviewers, input.scoped),
      primaryEnabled: effectiveReview.primaryEnabled,
      subtaskEnabled: effectiveReview.subtaskEnabled,
      reviewLandedChanges: effectiveReview.reviewLandedChanges,
      evidence: effectiveReviewEvidenceSettings(input.config),
    },
    timeouts: {
      reviewerTimeoutMs: input.config.reviewerTimeoutMs,
      executorTimeoutMs: input.config.executorTimeoutMs,
    },
    policy: {
      maxCorrectionCycles: input.config.maxCorrectionCycles,
      guidanceThreshold: input.config.implementationGuidanceAfterCorrectionAttempts,
    },
    retention: {
      retainBundles: input.config.retainBundles,
      // The existing canonical wave artifact cleanup age, staged under Retention
      // (issue #729). Absent means the documented 30-day default. It joins the
      // persisted selection ONLY once this transaction actually edited it — an
      // accepted Retention entry here, or an earlier session-only apply carried
      // in the pending delta — so an unrelated Save from a stale menu can never
      // write its opening snapshot back over a newer on-disk threshold,
      // including an absent key.
      waveArtifactTtlMs: input.config.waveArtifactTtlMs ?? DEFAULT_CONFIG.waveArtifactTtlMs ?? 0,
      waveArtifactTtlMsStaged: pendingDelta?.waveArtifactTtlMs !== undefined,
      deleteSpawnedPiSessions: input.config.deleteSpawnedPiSessionsOnCleanup === true,
    },
    maxWorkers: input.config.execution?.maxWorkers ?? DEFAULT_MAX_WORKERS,
    retry: { policy: { ...(input.config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY) } },
    subtasks: {
      subtaskNotifications: input.config.execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE,
      subtasksViewExpanded: input.config.ui?.subtasksViewExpanded === true,
      // #229: presentation-only activity-line preference, staged like the view
      // preference. Off (the default) hides just the redundant generated
      // owning-task prefix on subtask activity lines; task identity stays in
      // every record.
      showSubtaskTaskIds: input.config.ui?.showSubtaskTaskIds === true,
    },
    tools: {
      // Issue #434: the exact-name deny lists staged as one canonical draft.
      // The required discovery loader is never a deniable candidate: canonical
      // config validation rejects it and recovery drops it, and filtering here
      // keeps a raw programmatic config from ever staging or persisting it.
      topLevelDeny: deniableToolNames(input.config.tools?.topLevelDeny ?? []),
      executorDeny: deniableToolNames(input.config.tools?.executorDeny ?? []),
      deferredPiTools: input.config.execution?.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS,
      youShouldKnow: { ...(input.config.youShouldKnow ?? DEFAULT_CONFIG.youShouldKnow!) },
      web: {
        maxDownloadBytes: input.config.web!.fetch.maxDownloadBytes,
        browserInteractionApproval: input.config.web!.browserInteractionApproval ?? "ask",
        browserIdleExpiryMinutes: input.config.web!.browserIdleExpiryMinutes ?? DEFAULT_CONFIG.web!.browserIdleExpiryMinutes,
        browserDownloadRetention: input.config.web!.browserDownloadRetention ?? DEFAULT_CONFIG.web!.browserDownloadRetention,
        browserVisible: input.config.web!.browserVisible ?? DEFAULT_CONFIG.web!.browserVisible,
        // Issue #27 a-la-carte browser permissions: staged like every other
        // section. YOLO is a master override; the individual values beneath it
        // are preserved so disabling restores them exactly as saved.
        browserPermissions: { ...(input.config.web!.browserPermissions ?? DEFAULT_BROWSER_PERMISSIONS) },
        // Issue #620: the shared acquisition URL blocklist is staged like every
        // other Web value and persisted as one list for both WebFetch and
        // BrowserExtract.
        urlBlocklist: [...(input.config.web!.urlBlocklist ?? [])],
      },
      // Issue #536: the tool-protection block staged as the canonical
      // shape itself (no second enable flag, no per-scope level). An absent
      // stored block opens on the core defaults, which is also what an explicit
      // Off and a block rejected at startup display — this menu never claims
      // the stored configuration said Off.
      toolProtection: stagedToolProtectionSettings(input.config),
    },
    // Issue #26 scheduled tasks: the complete catalog is staged as its own
    // canonical copy; Save persists it through the shared save boundary. Entry
    // definitions stay visible and editable regardless of any runtime switch.
    scheduledTasks: cloneScheduledTaskCatalog(input.config.scheduledTasks ?? {}),
  };
  // Issue #434 review pass 1: the transaction-opening deny names are UI-only
  // row identities retained for this whole menu session, independent of the
  // staged checkbox state, so a saved name the live inventory no longer offers
  // stays visible and reversible (uncheck and recheck, across Back/re-entry).
  // They are never persisted, never copied into the draft config, and never
  // treated as authorization: the live canonical config is the only store.
  const retainedToolDenials: RetainedToolDenials = {
    topLevelDeny: deniableToolNames(input.config.tools?.topLevelDeny ?? []),
    executorDeny: deniableToolNames(input.config.tools?.executorDeny ?? []),
  };
  // Issue #536: the transaction-opening audit names, retained by the same
  // UI-only rule so the audit picker keeps every unavailable saved name as a
  // reversible row for this menu session. They are deliberately NOT passed
  // through the deny filter: an audited name may be any exact name — the
  // reserved discovery loader included — and a configured name is retained
  // rather than silently dropped. Never persisted, never staged.
  const retainedAuditedToolNames: readonly string[] = [...draft.tools.toolProtection.toolNames];
  // Issue #723: the ONE active external-worker form branch. An external-worker
  // Create/Edit form commits only on Create/Apply and discards completely on
  // Cancel/Escape, so its unapplied edits are deliberately NOT part of the
  // staged selection and can never reach a Save or Apply payload. They are still
  // visible, so the single dirty comparison below also reads this branch while a
  // form is open. Exactly one form is ever open, the form owns opening and
  // closing it, and nothing here is an observer list or a second staged state.
  let activeAgentFormBranch: ExternalAgentFormBranchSnapshot | undefined;
  const reportAgentFormBranch: ExternalAgentFormBranch = (branch) => {
    activeAgentFormBranch = branch;
  };
  // The ids visible at open time let Save distinguish the user's own deletions
  // from entries another process appended after this instance opened.
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
  //
  // Issue #463: the control also carries the transaction's shared held-action
  // fence. A held key's repeat/release must never replay a host action, and
  // the claim has to survive the transition from a nested menu (the deny
  // picker) back to its parent (Tools) and on to the root — otherwise a held
  // Escape could close the picker, then the Tools menu, and then apply the
  // staged draft. The fence is created eagerly so every menu of this
  // transaction shares the SAME fence object.
  const saveControl: SettingsSaveControl = { saveRequested: false, suspended: 0, actionFence: createMenuActionFence() };
  input.ui.saveControl = saveControl;

  // The one canonical staged-selection record for this menu session (issue
  // #294): both the persistent Save and the session-only Escape apply build
  // their config from it, so neither path stages a divergent field set.
  // It is declared before the /scheduled-tasks shortcut pre-loop so the
  // target-switch baseline below is captured at transaction OPENING, before
  // that pre-loop can stage anything.
  const stagedSelection = (catalogForApply: ScheduledTaskCatalog): PersistedSaveSelection => ({
    operatingMode: draft.operatingMode,
    externalAgentOperations,
    externalAgentOpening,
    modeCycleShortcut: draft.modeCycleShortcut,
    workerResources: draft.workers.workerResources,
    executeRoute: draft.workers.executeRoute,
    researchRoute: draft.workers.researchRoute,
    primaryReviewers: draft.review.primaryReviewers,
    subtaskReviewers: draft.review.subtaskReviewers,
    primaryEnabled: draft.review.primaryEnabled,
    subtaskEnabled: draft.review.subtaskEnabled,
    reviewLandedChanges: draft.review.reviewLandedChanges,
    evidence: draft.review.evidence,
    reviewerTimeoutMs: draft.timeouts.reviewerTimeoutMs,
    executorTimeoutMs: draft.timeouts.executorTimeoutMs,
    maxCorrectionCycles: draft.policy.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: draft.policy.guidanceThreshold,
    retainBundles: draft.retention.retainBundles,
    // Omitted unless edited (issue #729): the persistence boundary then keeps
    // the latest on-disk `waveArtifactTtlMs`, exactly as before this control.
    ...(draft.retention.waveArtifactTtlMsStaged ? { waveArtifactTtlMs: draft.retention.waveArtifactTtlMs } : {}),
    deleteSpawnedPiSessionsOnCleanup: draft.retention.deleteSpawnedPiSessions,
    maxWorkers: draft.maxWorkers,
    retryPolicy: draft.retry.policy,
    subtaskNotifications: draft.subtasks.subtaskNotifications,
    deferredPiTools: draft.tools.deferredPiTools,
    youShouldKnow: draft.tools.youShouldKnow,
    tools: { topLevelDeny: [...draft.tools.topLevelDeny], executorDeny: [...draft.tools.executorDeny] },
    toolProtection: {
      ...draft.tools.toolProtection,
      auditor: draft.tools.toolProtection.auditor === null ? null : { ...draft.tools.toolProtection.auditor },
      toolNames: [...draft.tools.toolProtection.toolNames],
    },
    subtasksViewExpanded: draft.subtasks.subtasksViewExpanded,
    showSubtaskTaskIds: draft.subtasks.showSubtaskTaskIds,
    scheduledTasks: catalogForApply,
    scheduledTasksStagedFrom,
    scheduledTasksAlreadyRunEdited: [...scheduledAlreadyRunEdited],
    webMaxDownloadBytes: draft.tools.web.maxDownloadBytes,
    browserInteractionApproval: draft.tools.web.browserInteractionApproval,
    browserIdleExpiryMinutes: draft.tools.web.browserIdleExpiryMinutes,
    browserDownloadRetention: draft.tools.web.browserDownloadRetention,
    browserVisible: draft.tools.web.browserVisible,
    webBrowserPermissions: draft.tools.web.browserPermissions,
    webUrlBlocklist: draft.tools.web.urlBlocklist,
  });

  // Issue #294: a pending session-only alreadyRun edit is not a new edit in
  // this reopened menu. If consumption or a re-arm happened while this menu
  // was open (or during preparation), the current live value replaces the
  // stale staged flag before persistence and baseline capture; the existing
  // before-save protection then covers changes made later, in flight.
  const mergePendingAlreadyRunState = (catalogForApply: ScheduledTaskCatalog): void => {
    for (const id of pendingAlreadyRunEdited) {
      if (scheduledAlreadyRunEdited.has(id)) continue;
      const liveEntry = input.config.scheduledTasks?.[id];
      const stagedEntry = catalogForApply[id];
      if (liveEntry === undefined || stagedEntry === undefined) continue;
      if (liveEntry.alreadyRun === true) stagedEntry.alreadyRun = true;
      else delete stagedEntry.alreadyRun;
    }
  };

  // The one persistence-shaped staged selection for this menu session: the
  // canonical staged selection plus the pending session-delta carry-through.
  // The session Save and the disk-only Save backend both build their payload
  // through it, so neither path can stage a divergent field set (issue #716).
  const stagedSelectionForPersistence = (catalogForApply: ScheduledTaskCatalog): PersistedSaveSelection => ({
    ...stagedSelection(catalogForApply),
    // Issue #294: carry the pending session-only delta through this Save:
    // earlier Escape-applied deletions and explicit alreadyRun edits stay
    // effective, and seeded external-agent operations keep their pre-cascade
    // reference baselines for the optimistic guard.
    externalAgentReferenceBaselines: Object.fromEntries(agentReferenceBaselines),
    scheduledTasksStagedFrom: [...new Set([...scheduledTasksStagedFrom, ...pendingScheduleDeletions])],
    scheduledTasksAlreadyRunEdited: [...new Set([...scheduledAlreadyRunEdited, ...pendingAlreadyRunEdited])],
  });

  // The switch's comparison view: the same staged selection Save would commit,
  // with the EFFECTIVE cleanup age, workspace spellings, and schedule
  // destination made explicit. Save carries `waveArtifactTtlMs` only once this
  // transaction edited it, but accepting the prefilled age unchanged is not an
  // edit: comparing effective values keeps that submission clean, while a
  // different accepted age still differs from the opening effective age (which
  // is exactly this local's opening value).
  //
  // The same holds for a Local scheduled workspace stored as `~/project`:
  // Local editing and the Local Save both expand a home prefix, so accepting
  // that exact prefill stages its absolute spelling and a raw comparison would
  // call it an edit. Both sides are expanded here with the same purely lexical
  // rule the Save uses (no filesystem probe), never into the draft. OWNER mode
  // is deliberately left untouched: a remote workspace keeps the owner's
  // spelling for the owner-side Save, which resolves its own home.
  //
  // A schedule destination is compared by effective value too: config loading
  // accepts and preserves an explicit `destination: "subtask"`, while choosing
  // that same Subtask option removes the redundant key. Both spellings mean the
  // same scheduled destination, so neither may make the draft look edited.
  //
  // Image-paste provenance participates by its LEXICAL CANDIDATE SET only: the
  // same paths Save could verify and repair from accepted host inserts and the
  // final instructions. Ordinary text, duplicate observations, and paths no
  // longer in the instructions therefore never prompt, while accepting an
  // observed paste of the exact path a loaded task already references (which
  // lets Save replace it with a managed copy) is a real staged change. Nothing
  // is validated or read here.
  //
  // This view is for the dirty comparison only: it never changes what Save
  // stages.
  const stagedSelectionForSwitch = () => {
    const scheduledTasks = draft.scheduledTasks;
    const workspaces = scheduledTaskOptions.workspaceInput === "owner"
      ? scheduledTasks
      : expandScheduledTaskWorkspaces(scheduledTasks);
    // A prototype-safe own-key copy: a configured id such as `__proto__` stays
    // an ordinary entry (Object.fromEntries defines own data properties).
    const destinations = Object.fromEntries(Object.entries(workspaces).map(([id, entry]) => [
      id,
      { ...entry, destination: entry.destination ?? "subtask" },
    ]));
    const selection = stagedSelectionForPersistence(scheduledTasks);
    // Pi and the standard Local backend hold the COMPLETE definitions in the
    // draft, so this view compares those projected values: a worker whose edit
    // was applied and then applied back to its original values is not a staged
    // change, even though an operation for the same id is still queued. A
    // delegated backend can apply edits to fields the editable projection does
    // not carry (an owner-only command or protocol), so there the operation log
    // stays the source of truth. Neither projection changes Save, Apply, or the
    // optimistic reference guards (issue #723).
    const fullAgentValuesStaged = transaction.kind === "session" || transaction.backend === localPersistedSaveBackend;
    // A route entry whose resource is not in the staged pool cannot survive the
    // existing reconciliation (issue #723): the pool editor keeps such an entry
    // only to preserve re-add ordering inside the visit. Comparing it would make
    // Add → Remove of a new resource look like a staged change even though the
    // pool is back to its opening value and no Save can carry the entry. This is
    // the comparison view only — the routes handed to Save are untouched.
    const routable = (entries: WorkerRouteEntry[] | undefined): WorkerRouteEntry[] | undefined =>
      entries?.filter((entry) => Object.hasOwn(selection.workerResources ?? {}, entry.resourceId));
    return {
      ...selection,
      executeRoute: routable(selection.executeRoute),
      researchRoute: routable(selection.researchRoute),
      // Net-empty external-worker operations are not a staged change (issue
      // #723): creating a worker and deleting it again leaves the catalog at its
      // opening value, and the remote Save encoder already drops an operation
      // with no baseline, no destination, and no definition. Reference baselines
      // are optimistic save guards for the ids this transaction touched, not
      // edited values, so they stay out of the comparison too. The Save payload
      // keeps both exactly as they were.
      externalAgentValues: fullAgentValuesStaged
        ? Object.fromEntries(Object.entries(draftConfig.externalAgents ?? {}).map(([id, definition]) =>
          [id, projectExternalAgentValue(definition, false)]))
        : undefined,
      externalAgentOperations: fullAgentValuesStaged ? undefined : selection.externalAgentOperations?.filter((operation) =>
        operation.baseline !== undefined || operation.nextId !== undefined || operation.definition !== undefined),
      externalAgentReferenceBaselines: undefined,
      // Exact-name lists participate by MEMBERSHIP (issue #723): unchecking and
      // rechecking one opening name appends it at the end of the staged list, so
      // the operator sees the same denied (or audited) set while the list's text
      // order moved. Only this comparison view sorts; the saved order and every
      // genuinely order-sensitive list — the role routes, the URL blocklist, the
      // scheduled catalog — keep their exact spelling.
      tools: selection.tools === undefined ? undefined : {
        topLevelDeny: [...(selection.tools.topLevelDeny ?? [])].sort(),
        executorDeny: [...(selection.tools.executorDeny ?? [])].sort(),
      },
      toolProtection: {
        ...selection.toolProtection,
        toolNames: [...selection.toolProtection.toolNames].sort(),
      },
      waveArtifactTtlMs: draft.retention.waveArtifactTtlMs,
      scheduledTasks: destinations,
      // An already-run override only matters for a task still in the draft:
      // adding one, toggling it, and removing it again is not a staged change,
      // and Save never consults the override for an absent task.
      scheduledTasksAlreadyRunEdited: selection.scheduledTasksAlreadyRunEdited?.filter(
        (id) => Object.hasOwn(scheduledTasks, id),
      ),
      scheduledImageCandidates: Object.fromEntries(
        Object.entries(scheduledTasks).flatMap(([id, entry]): Array<[string, string[]]> => {
          const candidates = collectScheduledImageCandidates(entry.instructions, scheduledImageProvenance.get(id) ?? []);
          return candidates.length === 0 ? [] : [[id, [...candidates].sort()]];
        }),
      ),
    };
  };

  // The dirty baseline, captured here at transaction OPENING for every
  // transaction. The comparison is over the same persistence-shaped staged
  // selection a Save would commit, so staged external-worker operations and the
  // edited-only already-run bookkeeping participate, while values are compared
  // by VALUE: merely opening a field, going Back, or re-submitting an unchanged
  // value never looks dirty. It is taken once, before anything can be staged
  // (including the /scheduled-tasks shortcut pre-loop below), so the one
  // predicate below stays correct however often it is asked.
  const openingStagedSelection = canonicalStagedSelection(stagedSelectionForSwitch());
  // The opening record, parsed once so the single canonical form below can pair
  // the staged side with the active form branch without re-deriving it.
  const openingSelection: unknown = openingStagedSelection === undefined
    ? undefined
    : JSON.parse(openingStagedSelection);

  /**
   * Whether this transaction stages anything different from its opening
   * baseline. This is THE dirty comparison of the shared draft, for every
   * surface that asks (issue #723): the caller-supplied target switch (issue
   * #716) and the host's single {@link UiContext.settingsDraftStatus} handle
   * read this same function. Pure value comparison over the single shared
   * staged state: no save validation, no workspace filesystem probe, and no
   * effect on Save, Apply, or cancellation.
   *
   * The one active external-worker form branch canonicalizes INSIDE this same
   * comparison rather than beside it: an unapplied form edit is deliberately not
   * staged (Create/Apply stays the commit boundary), so the comparison pairs the
   * staged selection with the branch's live projection, and with no form open
   * both sides carry `form: undefined`.
   */
  const stagedSelectionChanged = (): boolean => {
    if (openingSelection === undefined) return true;
    const branch = activeAgentFormBranch;
    const opening = canonicalStagedSelection({ selection: openingSelection, form: branch?.opening });
    const current = canonicalStagedSelection({ selection: stagedSelectionForSwitch(), form: branch?.readCurrent() });
    // A comparison the canonical form cannot represent (an opening or a current
    // value with a cycle) is reported as changed: the caller's own dirty
    // confirmation is the safe side, not a silent discard.
    return opening === undefined || current === undefined || opening !== current;
  };

  // Issue #723: hand the transaction's own dirty predicate to a host that owns
  // an embedded settings pane, exactly once, at transaction opening. The caller
  // of {@link runSettingsMenu} owns detaching it, so the handle lives precisely
  // as long as the transaction does and never outlives the draft it reads. A
  // host without the seam (every Pi command) pays nothing.
  publishDraftStatus?.(stagedSelectionChanged);

  /**
   * Enter the Scheduled tasks submenu for this transaction. The submenu edits
   * the shared `draft.scheduledTasks` catalog in place, so there is nothing to
   * adopt on return. The reviewer-list no-op opt-in is forwarded so a
   * target-switch transaction keeps stored reasoning levels on unchanged edits;
   * every other run passes the caller's options unchanged (the flag is false).
   */
  const visitScheduledTasks = (agents: ExternalAgentConfig[]): Promise<void> => selectScheduledTasks(
    input.ui,
    draft.scheduledTasks,
    draft.workers.workerResources,
    draftConfig,
    input.scoped,
    agents,
    scheduledImageProvenance,
    scheduledAlreadyRunEdited,
    { ...scheduledTaskOptions, preserveReviewerThinking: preserveCurrentThinking },
  );

  // Issue #190: /scheduled-tasks lands in the existing Scheduled tasks submenu
  // before the root. It stages into this same canonical catalog through the
  // shared readers/writers and returns here on Esc or Back, so Save/Cancel run
  // through the identical transaction as the ordinary entry — no duplicate
  // scheduler UI or state.
  if (initialSection === "scheduled") {
    await visitScheduledTasks(externalAgentCatalog(draftConfig));
  }

  // Issue #294: the staged-apply preparation shared by Save and root Escape:
  // workspace expansion, the save-time validation, and the managed-image
  // transaction. Returns undefined (with an error notice) when the menu must
  // stay open for a fix or an explicit Cancel.
  //
  // Issue #716: the preparation itself is the shared non-UI boundary in
  // ./persisted-save; this wrapper keeps the expansion in the editable draft
  // and turns a typed failure into the menu's error notice. The disk-only Save
  // does not use this wrapper — it hands the staged payload to its backend,
  // which may prepare on another host instead.
  const prepareStagedApply = async (): Promise<PreparedPersistedSave | undefined> => {
    const preparation = await preparePersistedSave({
      configPath: input.configPath,
      cwd: input.ui.cwd,
      config: input.config,
      draftConfig,
      scoped: input.scoped,
      // The same canonical staged selection this Apply/Save will commit; the
      // preparation derives every validation input from it.
      selection: stagedSelectionForPersistence(draft.scheduledTasks),
      scheduledImageProvenance,
    });
    // Workspace expansion lands in the editable draft even when validation
    // fails, exactly as before this boundary was extracted: a retry validates
    // the expanded spelling and a Cancel still copies nothing.
    draft.scheduledTasks = preparation.scheduledTasks;
    if (preparation.kind === "invalid") {
      await notify(input.ui, preparation.error, "error");
      return undefined;
    }
    return preparation;
  };

  // Issue #294: the root-Escape session-only apply: assemble the staged
  // selection over the live config (no disk read or write), install it with
  // the existing alreadyRun protection, record the pending delta for a later
  // Save, and run the same runtime side effects as Save. A failed apply rolls
  // back exactly the managed copies this preparation positively created —
  // nothing live or persisted can reference them yet — and keeps the menu
  // open.
  const applyStagedToLive = async (staged: PreparedPersistedSave): Promise<boolean> => {
    if (transaction.kind !== "session") throw new Error("Session-only apply is not available in a disk-only settings transaction.");
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
      // Only an age this transaction actually edited carries forward to a
      // later Save (issue #729); an untouched one stays disk-owned.
      ...(draft.retention.waveArtifactTtlMsStaged ? { waveArtifactTtlMs: draft.retention.waveArtifactTtlMs } : {}),
    });
    // Include inactive definitions and additions preserved from the latest
    // on-disk catalog. Availability probes never launch the application.
    staged.validationPolicy.warnings?.clear();
    await collectExternalAgentAvailabilityWarnings(next, staged.validationPolicy);
    await transaction.host.onSaved?.(input.config, previousMode, { ui: input.ui });
    await notify(input.ui, "Review settings applied for this session (not saved to disk).", "info");
    for (const warning of staged.validationPolicy.warnings ?? []) await notify(input.ui, warning, "warning");
    for (const warning of staged.scheduleDisableWarnings) await notify(input.ui, warning, "warning");
    for (const warning of staged.toolProtectionWarnings) await notify(input.ui, warning, "warning");
    // The hotkey binding itself is captured by Pi at extension load, so a
    // changed key needs the documented /reload (same as keybindings.json).
    if (draft.modeCycleShortcut !== previousModeCycleShortcut) {
      await notify(input.ui, "Mode cycle hotkey requires Save, then /reload; the session-only value does not change the registered binding.", "info");
    }
    return true;
  };

  // Caller-local last selection for this loop only: the highlighted row is
  // re-shown after every staged change so a toggle can repeat without
  // navigating back to the top (issue #140). UI-only state, never persisted.
  // The /scheduled-tasks shortcut returns here from the Scheduled tasks
  // submenu on Esc or Back (issue #190), so its first root show highlights
  // the row the user just left instead of the menu head; the ordinary
  // /review-settings entry still opens at the head.
  let rootLastKey: string | undefined = initialSection === "scheduled" ? "scheduled" : undefined;
  while (true) {
    // Aliases to the shared draft's sub-HOLDERS, never to their values: every
    // read below goes through the holder, so it sees an edit a nested menu made
    // moments ago (issue #723).
    const { workers, review, timeouts, policy, retention, retry, subtasks, tools } = draft;
    draftConfig.execution = { ...draftConfig.execution, workerResources: workers.workerResources, routes: { execute: workers.executeRoute, research: workers.researchRoute } };
    draftConfig.review = { ...draftConfig.review, primaryReviewers: review.primaryReviewers, subtaskReviewers: review.subtaskReviewers, primaryEnabled: review.primaryEnabled, subtaskEnabled: review.subtaskEnabled, reviewLandedChanges: review.reviewLandedChanges, evidence: review.evidence };
    draftConfig.scheduledTasks = draft.scheduledTasks;
    // Keep the draft's protection block aligned with the staged value so an
    // external-worker rename cascade reaches the auditor the user just chose.
    draftConfig.toolProtection = { ...tools.toolProtection, auditor: tools.toolProtection.auditor === null ? null : { ...tools.toolProtection.auditor }, toolNames: [...tools.toolProtection.toolNames] };
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
      : !review.primaryEnabled && !review.subtaskEnabled
        ? " — automatic review off"
        : "";
    // Section definitions drive both the aligned rendering and the row keys,
    // so a conditionally shown section (the live scheduler runtime toggle) can
    // never shift another row's label or key binding (issue #140 stability).
    const rootSections: Array<{ key: string; label: string; value: string }> = [
      { key: "mode", label: "Operating mode", value: OPERATING_MODE_LABELS[draft.operatingMode] },
      { key: "modeCycle", label: "Mode cycle hotkey", value: draft.modeCycleShortcut },
      { key: "resources", label: "Worker resources", value: executorPoolSummary(workers.workerResources) },
      { key: "externalAgents", label: "External workers", value: `${agents.length} defined` },
      { key: "route.execute", label: "Execution priority", value: workerRouteSummary(workers.executeRoute, workers.workerResources, draftConfig, input.scoped) },
      { key: "route.research", label: "Research priority", value: workerRouteSummary(workers.researchRoute, workers.workerResources, draftConfig, input.scoped) },
      { key: "reviewers", label: "Reviewers", value: `primary ${layerSummary(review.primaryEnabled, review.primaryReviewers)} · subtask ${layerSummary(review.subtaskEnabled, review.subtaskReviewers)}${reviewStatus}` },
      { key: "timeouts", label: "Timeouts", value: `review ${formatDuration(timeouts.reviewerTimeoutMs)} · executor ${formatDuration(timeouts.executorTimeoutMs)}` },
      { key: "policy", label: "Review policy", value: `${policy.maxCorrectionCycles} corrections · concrete after ${policy.guidanceThreshold}` },
      { key: "retention", label: "Retention", value: retentionSummary(retention.retainBundles, retention.deleteSpawnedPiSessions) },
      { key: "workers", label: "Global concurrency", value: String(draft.maxWorkers) },
      { key: "retry", label: "Retry policy", value: `${retry.policy.maxRetries} retries · ${formatDuration(retry.policy.baseDelayMs)} base` },
      // Issue #659: the three subtask notification/display controls are
      // grouped under one row, placed at the first replaced row so every
      // other section keeps its relative order.
      { key: "subtasks", label: "Subtasks", value: subtasksRootSummary(subtasks) },
      { key: "tools", label: "Tools", value: toolsRootSummary({ topLevelDeny: tools.topLevelDeny, executorDeny: tools.executorDeny, deferredPiTools: tools.deferredPiTools, web: { maxDownloadBytes: tools.web.maxDownloadBytes, browserVisible: tools.web.browserVisible, browserPermissions: tools.web.browserPermissions, urlBlocklist: tools.web.urlBlocklist } }) },
      { key: "scheduled", label: "Scheduled tasks", value: scheduledSummary(draft.scheduledTasks) },
      // Issue #653: a disk-only transaction has no process scheduler row.
      ...(transaction.kind === "session" && transaction.host.schedulerRuntime
        ? [{ key: "schedulerRuntime", label: "Scheduler runtime", value: transaction.host.schedulerRuntime.enabled ? "On" : "Off" }]
        : []),
    ];
    const renderedRootRows = alignedSettingsRows(rootSections.map((section) => [section.label, section.value] as const));
    // Rows are keyed by stable section names: every label re-renders with the
    // staged state, but the key never changes (issue #140).
    let choice: string | undefined = await retainedSelect(input.ui, {
      title: "Review settings",
      cancelHint: transaction.kind === "session" ? "apply for session" : "discard changes",
      rows: [
        // The caller-supplied target switch (the remote Review editor): ONE
        // root action naming the host being edited, and nothing else. The
        // caller owns the target list, the dirty confirmation, and the
        // same-target no-op; this menu only reports the staged-change state
        // and ends the old transaction when the switch is accepted.
        ...(hostTarget !== undefined ? [{ key: "target", label: `Host: ${hostTarget.label}` }] : []),
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
      return { kind: "discarded" };
    }
    if (!choice) {
      // Issue #653: the disk-only transaction's root Escape discards exactly
      // like Cancel — before any validation or managed image copy.
      if (transaction.kind === "persisted") return { kind: "discarded" };
      // Root Escape (issue #294): validate and apply the staged settings to
      // the live config only — no persistent config write. Nested menus keep
      // their existing Back semantics; this is the root exit only.
      const staged = await prepareStagedApply();
      if (staged === undefined) continue;
      if (!await applyStagedToLive(staged)) continue;
      return { kind: "applied" };
    }
    rootLastKey = choice;
    if (choice === "target" && hostTarget !== undefined) {
      // The caller's temporary picker/confirmation runs with Ctrl+S suspended,
      // so a chord pressed there can neither latch this transaction's Save nor
      // unwind the caller's picker; every other surface keeps its default
      // participation once the request settles. The shared held-action fence
      // is deliberately NOT cleared: the Enter that opened this row stays
      // claimed until released, so a held key cannot also confirm the picker.
      const switched = await withSaveSuspended(input.ui, () => hostTarget.requestSwitch(stagedSelectionChanged()));
      // A cancelled picker, a declined dirty confirmation, or the caller's own
      // same-target no-op never closes this menu: the loop re-shows the root
      // with exactly the same staged draft, edits included.
      if (switched === true) return { kind: "switched" };
      continue;
    }
    if (choice === "mode") {
      draft.operatingMode = await selectOperatingMode(input.ui, draft.operatingMode);
      continue;
    }
    if (choice === "modeCycle") {
      // A remote Review editor already passes `workspaceInput: "owner"`: that
      // config belongs to another host, so the requester validates the chord's
      // syntax only and the OWNER applies its own destination occupancy on
      // Save. The Local target, the Local editor, and the in-Pi menu keep the
      // existing live-host occupancy check.
      draft.modeCycleShortcut = await selectModeCycleShortcut(input.ui, draft.modeCycleShortcut, {
        checkHostOccupancy: !(transaction.kind === "persisted" && transaction.workspaceInput === "owner"),
      });
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
        workers.workerResources = draftConfig.execution!.workerResources!;
        workers.executeRoute = draftConfig.execution!.routes!.execute ?? [];
        workers.researchRoute = draftConfig.execution!.routes!.research ?? [];
        review.primaryReviewers = draftConfig.review!.primaryReviewers!;
        review.subtaskReviewers = draftConfig.review!.subtaskReviewers!;
        draft.scheduledTasks = draftConfig.scheduledTasks!;
        // #536: a rename carries the auditor reference; a deletion keeps the
        // unresolved selection and the Protection level and warns, rather than
        // turning the gate Off or choosing another auditor on the user's
        // behalf.
        if (draftConfig.toolProtection) tools.toolProtection = stagedToolProtectionSettings(draftConfig);
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
        for (const warning of changed.warnings) await notify(input.ui, warning, "warning");
      }, reportAgentFormBranch);
      continue;
    }
    if (choice === "resources") {
      // The visit edits the shared worker sub-holder in place: an accepted Add
      // is in the draft while the pool is still on screen.
      await visitWorkerResources(
        input.ui,
        workers,
        agents,
        draftConfig,
        input.scoped,
        // The same target-switch opt-in also keeps a PASSIVE pool visit from
        // reconciling a stored route entry away (see the leaf parameter).
        preserveCurrentThinking,
      );
      continue;
    }
    if (choice === "route.execute") {
      // The editor stages through the shared worker holder, so an accepted Add,
      // move, exclude, or reasoning change is in the draft while the route
      // editor is still drawn (issue #723).
      await selectWorkerRoute(input.ui, "Execution priority", draftSlot(workers, "executeRoute"), workers.workerResources, draftConfig, input.scoped, preserveCurrentThinking, preserveCurrentThinking);
      continue;
    }
    if (choice === "route.research") {
      await selectWorkerRoute(
        input.ui,
        "Research priority",
        draftSlot(workers, "researchRoute"),
        filterResearchCapableCatalog(draftConfig, workers.workerResources),
        draftConfig,
        input.scoped,
        preserveCurrentThinking,
        preserveCurrentThinking,
      );
      continue;
    }
    if (choice === "reviewers") {
      // The submenu edits the shared review sub-holder directly (issue #723), so
      // an accepted toggle or evidence choice is staged while it is still drawn.
      await selectReviewSection(input.ui, review, agents, input.scoped, preserveCurrentThinking);
      continue;
    }
    if (choice === "timeouts") {
      await selectTimeouts(input.ui, timeouts);
      continue;
    }
    if (choice === "policy") {
      await selectReviewPolicy(input.ui, policy);
      continue;
    }
    if (choice === "retention") {
      await selectRetention(input.ui, retention);
      continue;
    }
    if (choice === "workers") {
      draft.maxWorkers = await selectMaxWorkers(input.ui, draft.maxWorkers);
      continue;
    }
    if (choice === "retry") {
      await selectRetryPolicy(input.ui, retry);
      continue;
    }
    if (choice === "subtasks") {
      // Issue #659: the grouped submenu. It stages into this same canonical
      // transaction through the shared sub-holder and returns on Back or
      // Escape, so Save, root Escape, and Cancel stay the root's alone.
      await selectSubtaskSettings(input.ui, subtasks);
      continue;
    }
    if (choice === "tools") {
      // Issue #434: the root Tools subsection. The moved Deferred Pi tools,
      // YouShouldKnow notices, Completion guidance, and Web/browser subtree are
      // edited here through their existing controls and keep their previous
      // selection keys; the two deny selectors are independent and checked
      // means strictly denied (the #536 audit picker reuses this same
      // searchable list with checked meaning AUDITED). The submenu edits the
      // shared tools sub-holder (issue #723), so every accepted value is staged
      // while its own screen is still drawn; nothing is adopted on return. All
      // of it stays unapplied until the root Save/root-Escape/Cancel
      // transaction decides. The candidate inventory is display-only: it is
      // read here, never activated.
      await selectToolSettings(input.ui, tools, readToolChoices(input.getToolChoices), retainedToolDenials, { config: draftConfig, agents, scoped: input.scoped, preserveCurrentThinking }, {
        // The audit subset reads the same display-only inventory WITHOUT the
        // deny-only loader filter, from the runtime's loader-inclusive read
        // (falling back to the shared inventory when a host cannot supply one),
        // so the reserved `tool_search` loader is an auditable row whenever the
        // runtime offers it — and stays a reversible unavailable row when it
        // does not.
        choices: readToolChoices(input.getAuditedToolChoices ?? input.getToolChoices, { includeReservedDiscoveryLoader: true }),
        retainedNames: retainedAuditedToolNames,
      });
      continue;
    }
    if (choice === "scheduled") {
      await visitScheduledTasks(agents);
      continue;
    }
    if (choice === "schedulerRuntime") {
      // Live, current-process-only switch (issue #26): applies immediately,
      // never persists, and stays outside the staged settings transaction —
      // cancelling other changes does not revert it.
      // Real setter contract: the runtime reacts synchronously by stopping
      // or starting its timers; nothing polls the flag afterwards.
      if (transaction.kind === "session" && transaction.host.schedulerRuntime) {
        transaction.host.schedulerRuntime.setEnabled(!transaction.host.schedulerRuntime.enabled);
      }
      continue;
    }
    // choice === "save": the persistent save boundary (issue #294) — the same
    // staged-apply preparation as root Escape, then the disk merge with
    // foreign-entry preservation and the external-agent optimistic cascade
    // guards. Explicit Save and Ctrl+S share this one canonical Save path.
    //
    // Issue #716: the disk-only transaction hands its staged payload to the
    // transaction's Save backend BEFORE any local preparation, so a backend
    // that persists on another host needs no requester-local path probe,
    // managed image copy, directory check, or config read/write. The default
    // backend is the shared non-UI preparation/commit boundary in this process;
    // no live install, onSaved, pending delta, or scheduler effect exists here.
    if (transaction.kind === "persisted") {
      const stagedSave: StagedPersistedSave = {
        configPath: input.configPath,
        cwd: input.ui.cwd,
        config: input.config,
        draftConfig,
        scoped: input.scoped,
        scheduledImageProvenance,
        // The staged selection is plain data captured BEFORE preparation. The
        // backend validates it and commits this exact selection with only the
        // prepared catalog substituted, so no post-preparation callback can
        // carry a different catalog past the shared checks.
        selection: stagedSelectionForPersistence(draft.scheduledTasks),
        ...(transaction.beforePersist ? { beforePersist: transaction.beforePersist } : {}),
      };
      const result = await transaction.backend.saveStaged(stagedSave);
      // The workspace-expanded editable catalog stays in the draft for every
      // outcome, exactly as the shared menu did before this boundary.
      draft.scheduledTasks = result.scheduledTasks;
      if (result.kind === "invalid" || result.kind === "conflict") {
        await notify(input.ui, result.error, "error");
        continue;
      }
      // Issue #653: the disk-only Save ends here — no live install, no
      // onSaved, and no pending-delta bookkeeping. Running sessions keep their
      // own effective settings; configs loaded from disk afterwards see this.
      await notify(input.ui, "Review settings saved to disk. Running sessions keep their current settings; newly launched sessions use the saved settings.", "info");
      for (const warning of result.warnings) await notify(input.ui, warning, "warning");
      for (const warning of result.scheduleDisableWarnings) await notify(input.ui, warning, "warning");
      for (const warning of result.toolProtectionWarnings) await notify(input.ui, warning, "warning");
      return { kind: "saved", config: result.config };
    }
    const staged = await prepareStagedApply();
    if (staged === undefined) continue;
    // Issue #294: a pending session-only alreadyRun edit is not a new edit in
    // this reopened menu (see mergePendingAlreadyRunState).
    mergePendingAlreadyRunState(staged.catalogForApply);
    // #306: capture the live already-run state before this asynchronous save
    // so a later install can preserve changes made while it was in flight.
    const scheduledTasksAlreadyRunBeforeSave = captureScheduledAlreadyRun(input.config);
    // The shared non-UI commit keeps the strict merge, the atomic write, and
    // the exact rollback/conflict policy (issue #716). A prepared-image
    // rollback and the external-worker notice text live there, not here.
    const commit = await commitPersistedSave({
      configPath: input.configPath,
      selection: stagedSelectionForPersistence(staged.catalogForApply),
      ...(staged.prepared ? { prepared: staged.prepared } : {}),
    });
    if (commit.kind === "conflict") {
      await notify(input.ui, commit.error, "error");
      continue;
    }
    const next = commit.config;
    // Include inactive definitions and additions preserved from the latest
    // on-disk catalog. Availability probes never launch the application.
    // Disk may have changed existing definitions since this menu opened.
    // Announce availability of the saved catalog, not stale draft warnings.
    staged.validationPolicy.warnings?.clear();
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
    await transaction.host.onSaved?.(input.config, previousMode, { ui: input.ui });
    await notify(input.ui, "Review settings saved.", "info");
    for (const warning of staged.validationPolicy.warnings ?? []) await notify(input.ui, warning, "warning");
    for (const warning of staged.scheduleDisableWarnings) await notify(input.ui, warning, "warning");
    for (const warning of staged.toolProtectionWarnings) await notify(input.ui, warning, "warning");
    // The hotkey binding itself is captured by Pi at extension load, so a
    // changed key needs the documented /reload (same as keybindings.json);
    // the persisted mode change itself never needs a reload.
    if (draft.modeCycleShortcut !== previousModeCycleShortcut) {
      await notify(input.ui, "Mode cycle hotkey takes effect after /reload.", "info");
    }
    // Issue #294: the pending session-only choices are durable now.
    clearPendingSessionDelta(input.config);
    return { kind: "saved", config: input.config };
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
  // Issue #419: this command's own custom seam is where Escape ownership lives.
  // The host dialog seams (confirmation, plain selector, input, editor) join it
  // through the same invocation-local surface, because a settings confirmation
  // opens AFTER its preceding menu slot has already closed.
  const surface: SettingsHostSurface = {};
  publishSettingsCustomEscape(ctx, ui, surface);
  publishSettingsHostDialogEscape(ctx, ui, surface);
  return ui;
}

/**
 * The live host TUI this settings invocation has already been handed, shared by
 * the custom-slot and host-dialog owners. It is captured from the public
 * custom-component factory argument, so a host that never gave this command a
 * TUI (an RPC/print host, or a plain-selector-only run) keeps today's input
 * path with no ownership published at all.
 */
interface SettingsHostSurface {
  tui?: unknown;
}

/**
 * Issue #419: while a settings screen is the foreground UI, Escape belongs to
 * that screen and to nothing else.
 *
 * Pi dispatches raw terminal-input listeners BEFORE the focused component, so
 * an Escape pressed inside `/review-settings` still reached the automatic or
 * command-driven review's abort listener underneath the menu and cancelled a
 * review the user never asked to cancel. Every native settings surface opens
 * through this command's own `ui.custom` seam — the retained menus, the
 * search-capable deny picker, and the native text-field slot — so ownership is
 * published there and nowhere else: unrelated host editors, host dialogs, and
 * the plain/RPC selector fallback (which has no `custom`) keep their exact
 * current input path.
 *
 * One publish exists per `custom()` call. It retires the moment that slot
 * closes, so a separate, later Escape stays ordinary review cancellation — no
 * sticky suppression and no global disabling. `routeForegroundEscape` captures
 * the owner before invoking it, so a menu that dismisses synchronously inside
 * the same dispatch still consumes that one packet while the next press is
 * fresh.
 *
 * Ownership is claimed only on positive focus evidence: the host's public
 * `getFocusedComponent()` must still name the component this seam produced.
 * That is what keeps a popup overlay opened above an open settings menu in
 * charge of its own Escape (the settings publish is not foreground while the
 * overlay holds focus), and it means a host that cannot report focus, or a
 * slot the host has already replaced, claims nothing at all.
 */
function publishSettingsCustomEscape(ctx: unknown, ui: UiContext, surface: SettingsHostSurface): void {
  const custom = ui.custom;
  if (typeof custom !== "function") return;
  // Forwarded through the original method with the original receiver so a
  // receiver-dependent host or forwarding wrapper keeps working unchanged.
  const forward = custom as (factory: MenuCustomFactory, options?: unknown) => Promise<string | undefined>;
  ui.custom = (factory: MenuCustomFactory, options?: unknown): Promise<string | undefined> => {
    let tui: unknown;
    let component: { handleInput?(data: string): void } | undefined;
    let closed = false;
    const release = publishForegroundEscape(ctx, {
      handleInput: (data) => {
        if (closed) return;
        try {
          // The screen keeps its own existing back/cancel/exit handling —
          // including its held-action fence and Ctrl+S save latch.
          component?.handleInput?.(data);
        } finally {
          // Pi renders after the focused component consumes input.
          requestHostRender(tui);
        }
      },
      isCurrent: () => !closed,
      isForeground: () => !closed && component !== undefined && holdsHostFocus(tui, component),
    });
    const guarded: MenuCustomFactory = (hostTui, theme, keybindings, done) => {
      tui = hostTui;
      surface.tui = hostTui;
      let settled = false;
      const close = (result?: string): void => {
        // The slot is over the instant done() runs: mark it before the host
        // starts tearing it down, so no later listener can route a separate
        // press here and a re-entrant done() cannot settle twice.
        if (settled) return;
        settled = true;
        closed = true;
        done(result);
      };
      const produced = factory(hostTui, theme, keybindings, close);
      if (isThenable(produced)) {
        // A host factory may resolve its component asynchronously; the host
        // focuses whatever it resolves to, so ownership follows the same value.
        void Promise.resolve(produced).then(
          (value) => { component = asInputComponent(value); },
          () => { /* a rejecting factory rejects custom(); the finally retires */ },
        );
      } else {
        component = asInputComponent(produced);
      }
      return produced;
    };
    try {
      return Promise
        .resolve(forward.call(ui, guarded, options))
        .finally(() => { closed = true; release(); });
    } catch (error) {
      // A host slot that fails synchronously never produced a promise to
      // retire on: retire here so the publish cannot outlive the attempt.
      closed = true;
      release();
      throw error;
    }
  };
}

function asInputComponent(value: unknown): { handleInput?(data: string): void } | undefined {
  return isRecord(value) && typeof value.handleInput === "function"
    ? value as { handleInput(data: string): void }
    : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (isRecord(value) || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

/**
 * True only when the live host still reports the component this seam produced
 * as its focused component. A missing or throwing focus seam is not evidence:
 * such a host owns nothing here, which leaves today's input path in place
 * rather than inventing ownership that cannot be observed.
 */
function holdsHostFocus(tui: unknown, component: unknown): boolean {
  if (!isRecord(tui) || typeof tui.getFocusedComponent !== "function") return false;
  try {
    return tui.getFocusedComponent() === component;
  } catch {
    return false;
  }
}

/**
 * Issue #419: the settings transaction's own host DIALOGS are foreground
 * settings screens too — the YOLO-enable confirmation and the tool-protection
 * auditor confirmations go through the public `ui.confirm` seam (and a
 * degraded run can reach the plain `ui.select`/`ui.input`/`ui.editor` seams),
 * which the host implements as an editor-slot dialog, not a `custom`
 * component. Their preceding settings menu slot has already closed by then, so
 * without this the Escape would reach a review aborter and cancel a review
 * while the confirmation stayed open.
 *
 * Ownership is published only with the same positive evidence the custom slot
 * requires: this invocation must already hold the live host TUI (the public
 * custom-component factory argument), the host must report a focus transition
 * to a NEW component when the dialog opens, and that component must still hold
 * focus when the press arrives. The routed press goes to that component's own
 * `handleInput`, so the confirmation keeps its exact existing Yes/No/cancel
 * semantics — a declined or cancelled confirmation still leaves YOLO Off — and
 * the publish retires as soon as the dialog settles. A host without a reported
 * TUI (RPC/print, or a run that never opened a settings custom screen) keeps
 * today's behavior with nothing published.
 */
function publishSettingsHostDialogEscape(ctx: unknown, ui: UiContext, surface: SettingsHostSurface): void {
  // Only seams the host really offers are wrapped: settings code branches on
  // the ABSENCE of some of them (YOLO requires a confirmation dialog and fails
  // closed without one), so a synthetic member would change that behavior.
  const target = ui as unknown as Record<string, unknown>;
  for (const member of ["confirm", "select", "input", "editor"] as const) {
    if (typeof target[member] !== "function") continue;
    target[member] = settingsHostDialogOwner(ctx, ui, surface, member);
  }
}

function settingsHostDialogOwner(
  ctx: unknown,
  ui: UiContext,
  surface: SettingsHostSurface,
  member: "confirm" | "select" | "input" | "editor",
): (...args: unknown[]) => unknown {
  const original = (ui as unknown as Record<string, unknown>)[member];
  return (...args: unknown[]): unknown => {
    const call = original as (...rest: unknown[]) => unknown;
    if (typeof call !== "function") return undefined;
    const tui = surface.tui;
    if (!isRecord(tui) || typeof tui.getFocusedComponent !== "function") {
      // No observable host focus for this run: the documented cancellation
      // path stays exactly as it was.
      return call.apply(ui, args);
    }
    let before: unknown;
    try {
      before = tui.getFocusedComponent();
    } catch {
      before = undefined;
    }
    const pending = call.apply(ui, args);
    // showExtensionConfirm/showExtensionSelector push and focus their dialog
    // synchronously inside this call; a host that does not is not claimed.
    let after: unknown;
    try {
      after = tui.getFocusedComponent();
    } catch {
      after = undefined;
    }
    if (after === undefined || after === null || after === before) return pending;
    let closed = false;
    const release = publishForegroundEscape(ctx, {
      handleInput: (data) => {
        if (closed) return;
        try {
          asInputComponent(after)?.handleInput?.(data);
        } finally {
          requestHostRender(tui);
        }
      },
      isCurrent: () => !closed,
      isForeground: () => !closed && holdsHostFocus(tui, after),
    });
    return Promise.resolve(pending).finally(() => { closed = true; release(); });
  };
}

function requestHostRender(tui: unknown): void {
  if (!isRecord(tui) || typeof tui.requestRender !== "function") return;
  try {
    tui.requestRender();
  } catch {
    // A stale host handle owns no frame; the input already landed.
  }
}

/**
 * Run one caller-owned step with this transaction's Ctrl+S participation
 * suspended (the target switch's temporary picker and dirty confirmation).
 * This is the same bracket the external-worker Create/Edit forms use: the
 * selector sees `suspended > 0`, so a chord pressed inside it neither sets the
 * latch nor unwinds the picker, and the counter is always restored afterwards
 * so every other surface keeps its default participation.
 */
async function withSaveSuspended<T>(ui: UiContext, operation: () => Promise<T>): Promise<T> {
  const control = ui.saveControl;
  if (!control) return operation();
  control.suspended += 1;
  try {
    return await operation();
  } finally {
    control.suspended -= 1;
  }
}

/**
 * Key-order-insensitive JSON text of one staged settings value, used for the
 * caller-supplied target switch's value comparison (see
 * PersistedReviewSettingsInput.targetControl). Property order is an artifact
 * of how a value was staged, never a user-visible change, so it must not make
 * an untouched draft look dirty. Returns `undefined` when the value cannot be
 * represented at all (a cycle); callers treat that as "cannot prove
 * unchanged" rather than as clean.
 */
function canonicalStagedSelection(value: unknown): string | undefined {
  try {
    return JSON.stringify(sortedStagedValue(value));
  } catch {
    return undefined;
  }
}

function sortedStagedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedStagedValue);
  if (isRecord(value)) {
    // A NULL-prototype container. A configured id such as `__proto__` is an
    // ordinary own key of a staged catalog, and assigning it on a plain `{}`
    // would invoke the inherited setter instead: the entry would vanish from
    // the canonical text, so an edit to that task would look clean.
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) sorted[key] = sortedStagedValue(value[key]);
    return sorted;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
