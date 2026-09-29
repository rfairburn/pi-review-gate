import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deferredPiToolsEnabled, effectiveReviewSettings, loadConfig, materializeReviewConfig, resolveReviewers, type OperatingMode, type ScheduledTaskEntryConfig } from "./config";
import { ScheduledTaskRuntime } from "./scheduling/dispatcher";
import { createScheduledEntryDispatcher } from "./scheduling/dispatch";
import { deliverScheduledEvent } from "./scheduling/events";
import { ScheduledOrchestratorTurnTracker, findTriggeringCustomMessage } from "./scheduling/orchestrator-turn";
import { deliverSubtaskLaunchNotice, type SubtaskLaunchNotice } from "./execution/launch-notice";
import { getSchedulerRuntime } from "./scheduling/runtime";
import { removeReviewBundle, removeTransientWindowBundle } from "./bundle";
import { captureReviewCheckpoint, releaseReviewCheckpoint } from "./review-checkpoint";
import { registerCommands } from "./commands";
import { createCorrectionFeedbackMarker, isRepeatedNoProgressFeedback } from "./correction-feedback";
import {
  recordToolCallEvidence,
  recordToolResultEvidence,
  rememberFinalAssistantSummary,
  shouldRecordToolCallEvidence,
  shouldRecordToolResultEvidence,
} from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractSignal, extractToolArgs, extractToolName, isEscapeTerminalInput, onTerminalInput, sendFollowUp, sendNotice, sendSteeringPrompt, sendTriggeredFollowUp, createStatusTracker, setStatus, type HookHandler } from "./pi";
import { collectPausedReviewExchange, runReview, type ReviewRunOutput } from "./review";
import {
  createReviewCancellationCoordinator,
  type ActiveReviewCancellation,
  type ReviewCancelReason,
} from "./review-cancellation";
import {
  activeExchangeHasBaseline,
  beginAgentRun,
  buildRequestContext,
  closeReviewWindow,
  createState,
  freezeReviewWindowConfig,
  getCorrectionAttemptCount,
  ownedReviewCheckpointDescriptors,
  reconcileRestoredReviewWindows,
  reconcileWindowReviewerSelection,
  recordReviewerFeedbackAndArmExchange,
  rememberUserRequest,
  setReviewWindowCheckpointBaseline,
  type ReviewGateState,
} from "./state";
import { registerReviewSettings } from "./settings/command";
import { scopedModelChoices } from "./settings/models";
import { persistSubtasksViewPreference, replaceConfig } from "./settings/persistence";
import { assertScheduledImagesPresent, managedScheduledImageRoot } from "./settings/scheduled-image-assets";
import { registerStreamFailureReporting } from "./stream-failure-report";
import { ExecutionToolManager } from "./execution/tool";
import { acknowledgeOwnerRetiringSave } from "./execution/background-controller";
import { combineTokenUsage, extractPiUsageFromMessages, formatTokenUsage, type TokenUsage } from "./usage";
import { NativeToolCallPreflight } from "./tool-call-preflight";
import { buildReviewAuthorizationMessage, createReviewTransmissionMessage, deliverReviewTransmission, hasReviewDeliveryReceipt, type ReviewTransmissionAction } from "./transmission";
import { dispatchModelDelivery, queueModelDelivery } from "./durable-delivery";
import { replaceReviewGateState, reviewCheckpointDescriptorIdentity, sessionPersistenceIdentity, SessionStateCheckpointBaselineError, SessionStateCwdMismatchError, SessionStateConversationMismatchError, SessionStateGitBaselineError, SessionStateIntegrityError, SessionStateInvalidStateError, SessionStateMissingSelectionDigestError, SessionStateParseError, SessionStateStore, SessionStateUnsupportedFormatError, type PendingDeliverySummary } from "./session-state";
import { BackgroundProcessReadiness } from "./background-process-readiness";
import {
  registerBackgroundShell,
  type BackgroundShellHost,
  type BackgroundShellLifecycleEvent,
} from "./background-shell";
import { registerApplyPatchTool } from "./apply-patch/tool";
import { registerGitReadTool, type GitReadHost } from "./git-read/tool";
import { WebToolManager, type PiWebHost } from "./web/tools";
import { DeferredToolManager } from "./deferred-tools";
import { loadOperatingModeSegments, OPERATING_MODE_LABELS } from "./operating-mode";
import { registerModeCycleShortcut } from "./mode-cycle";
import { contextIsInteractiveTui, registerUserQuestions, userQuestionsBeginSession, userQuestionsEndSession } from "./user-question";
import { prewarmPiAgentPeer } from "./peer-prewarm";
import {
  EXECUTOR_TOOL_CATALOG_ENV,
  createExecutorToolCatalog,
  type ExecutorToolCatalog,
} from "./execution/tool-catalog";
import {
  capturePiSettlementBootstrap,
  publishPiSettlementReceipt,
  removePiSettlementReceipt,
  type PiSettlementBootstrap,
} from "./execution/pi-settlement-receipt";

declare const module: {
  exports: unknown;
};

const orchestratorBackgroundCompletionPrompt = [
  "[pi-review-background-ready] ShellStart work that previously blocked review reached an idle transition.",
  "Automatic review was deliberately deferred while they were active.",
  "Re-check ShellList because a newer job may have started after this event was queued.",
  "Inspect the completed results and workspace, address any failure, and finish the original request when current background readiness permits.",
  "Do not claim success from process exit alone; verify the requested outcome before completing this turn.",
].join(" ");

interface ActivationDependencies {
  /** Narrow injection seam used by lifecycle tests; production constructs it. */
  webTools?: Pick<WebToolManager, "register" | "cleanup" | "sync" | "applySavedSettings">;
  /**
   * Issue #222 lifecycle-test seams: a controlled scheduler clock/tick so a
   * due occurrence can be exercised at a deterministic minute, and an access
   * hook for the live orchestrator-turn tracker (occurrence attribution and
   * settlement are observable in tests through its own state).
   * Production constructs neither.
   */
  schedulerTimer?: { now?: () => number; tickIntervalMs?: number };
  orchestratorTurnsTestAccess?: (tracker: ScheduledOrchestratorTurnTracker) => void;
}

export async function activate(pi: unknown, dependencies: ActivationDependencies = {}): Promise<void> {
  // Live session working directory. The top-level branch keeps it updated from
  // hook context; a Pi executor worker's cwd is its stable worktree root.
  let currentCwd = process.cwd();
  const executorRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE === "executor";
  let executorSettlementBootstrap: PiSettlementBootstrap | undefined;
  let executorSettlementBootstrapError: Error | undefined;
  if (executorRole) {
    try {
      // Capture and erase the signing bootstrap before the first await, tool
      // registration, model request, or model-spawned subprocess.
      executorSettlementBootstrap = capturePiSettlementBootstrap();
    } catch (error) {
      executorSettlementBootstrapError = error instanceof Error ? error : new Error("Pi executor settlement bootstrap failed.");
    }
  }
  const loaded = loadConfig();
  for (const warning of loaded.warnings ?? []) {
    await sendNotice(pi, `review gate: config warning: ${warning}`);
  }

  const { config } = loaded;
  if (loaded.globallyDisabled) {
    await sendNotice(pi, `review gate: disabled (${loaded.disabledReason ?? "environment kill switch"})`);
    return;
  }

  // Install the native Pi preflight before registering any extension tools.
  // The native batch event and execution lifecycle seams are required; without
  // them the extension must not expose tools with only partial duplicate
  // coverage. Runtime controllers are attached as each role initializes.
  let backgroundShellController: ReturnType<typeof registerBackgroundShell> | undefined;
  let executionTools: ExecutionToolManager | undefined;
  const nativeToolPreflight = new NativeToolCallPreflight({
    shellStartLiveness: (fingerprint) => backgroundShellController?.startLiveness(fingerprint) ?? { state: "unknown" },
    subtaskStartLiveness: (fingerprint) => executionTools?.startLiveness(fingerprint) ?? { state: "unknown" },
  });
  const lifecycleHooksReady = nativeToolPreflight.registerLifecycleHooks(pi);
  let toolCallObserver: (...args: unknown[]) => unknown = (...args) => nativeToolPreflight.preflight(args);
  const preflightHookReady = nativeToolPreflight.registerToolCallHook(pi, (...args) => toolCallObserver(...args));
  if (!lifecycleHooksReady || !preflightHookReady) {
    throw new Error("review gate: native duplicate-call preflight requires Pi message_end, tool_call, tool_execution_start, tool_result, and session_tree hooks; no extension tools were registered");
  }

  const webTools = dependencies.webTools ?? (canRegisterWebTools(pi) ? new WebToolManager(pi, loaded.config) : undefined);
  webTools?.register();

  // Register ApplyPatch in both the top-level orchestrator and Pi-native
  // executor runtimes. It is active by default under Pi's registered-tool
  // policy; an explicit Pi launch --tools allowlist remains authoritative, so
  // this never force-enables the tool through setActiveTools.
  if (canRegisterApplyPatchTool(pi)) {
    registerApplyPatchTool(pi);
  }

  // Register GitRead (#73) in both the top-level orchestrator and Pi-native
  // executor runtimes, before any deferred-tool authorization capture. Role
  // visibility is applied downstream, never here: the captured boundary pins
  // it to the plan/research operating mode at the top level, while durable
  // child catalogs admit it for research workers and exclude it from
  // execute-kind workers. Like ApplyPatch it is active by default under Pi's
  // registered-tool policy; an explicit Pi launch --tools allowlist remains
  // authoritative, so this never force-enables the tool through setActiveTools.
  if (canRegisterGitReadTool(pi)) {
    registerGitReadTool(pi, () => currentCwd);
  }

  if (executorRole) {
    if (canRegisterBackgroundShell(pi)) {
      backgroundShellController = registerBackgroundShell(
        pi,
        (toolCallId, toolName) => nativeToolPreflight.admittedSubmittedFingerprint(toolCallId, toolName),
        (toolCallId, toolName) => nativeToolPreflight.observeReturnedError(toolCallId, toolName),
      );
    }
    const deferredTools = new DeferredToolManager(pi);
    if (!deferredTools.register()) {
      // This reduced executor has no bootstrap hooks below, so reset the
      // preflight alongside its existing session lifecycle handlers.
      registerHook(pi, "session_start", () => nativeToolPreflight.reset());
      registerHook(pi, "session_shutdown", () => nativeToolPreflight.reset());
      // #84 diagnostics stay available even on this reduced executor host:
      // register the bridge after the background shell's own lifecycle hooks
      // so its shutdown reset can never be dispatched ahead of the reaper.
      registerStreamFailureReporting(pi);
      return;
    }
    const serializedToolCatalog = process.env[EXECUTOR_TOOL_CATALOG_ENV];
    const executorToolCatalog = executorBootstrapToolCatalog(serializedToolCatalog);
    registerHook(pi, "session_start", (...args) => {
      nativeToolPreflight.reset();
      const context = extractContext(args);
      const sessionIdentity = typeof context === "object" && context !== null
        ? (context as { sessionManager?: unknown }).sessionManager
        : undefined;
      deferredTools.sessionStart(sessionIdentity, executorToolCatalog, true);
      // Keep the one-shot bootstrap only until session_start so extension
      // reloads during initialization can still consume it. Worker tools and
      // their subprocesses never inherit the hidden catalog.
      delete process.env[EXECUTOR_TOOL_CATALOG_ENV];
    });
    registerHook(pi, "before_agent_start", (...args) => {
      deferredTools.reapply();
      return deferredToolPromptInjection(deferredTools.startupGuidance(), extractSystemPrompt(args));
    });
    registerHook(pi, "tool_result", () => {
      deferredTools.reapply();
    });
    let settlementGeneration = 0;
    let terminal = false;
    let receiptPublication = Promise.resolve();
    const acknowledgementFailure = () => executorSettlementBootstrapError
      ?? (!executorSettlementBootstrap || terminal ? new Error(
        "Pi executor settlement bootstrap is unavailable or retired. Executor reload/replacement is unsupported; restart this worker with a fresh parent-issued identity.",
      ) : undefined);
    // Bootstrap secrets are intentionally erased, not persisted across reload.
    // Pi logs most hook errors and continues: block tools explicitly, and never
    // publish a replacement receipt or reset a generation under the old identity.
    toolCallObserver = (...args) => {
      const failure = acknowledgementFailure();
      if (failure) return { block: true, reason: failure.message };
      return nativeToolPreflight.preflight(args);
    };
    registerHook(pi, "session_shutdown", async () => {
      nativeToolPreflight.reset();
      terminal = true;
      // Retire acknowledgements even if terminal browser cleanup fails. Wait
      // for any publication already in flight so it cannot recreate the file.
      await Promise.all([
        webTools?.cleanup(),
        receiptPublication.catch(() => undefined).then(async () => {
          if (executorSettlementBootstrap) await removePiSettlementReceipt(executorSettlementBootstrap);
        }),
      ]);
    });
    registerHook(pi, "agent_settled", async () => {
      const failure = acknowledgementFailure();
      if (failure) throw failure;
      const generation = ++settlementGeneration;
      // Authenticate model settlement, NOT browser quiescence. The browser
      // remains live until explicit close or terminal worker/session shutdown.
      receiptPublication = receiptPublication.then(async () => {
        if (terminal) throw acknowledgementFailure();
        await publishPiSettlementReceipt(executorSettlementBootstrap!, generation);
      });
      await receiptPublication;
    });
    // #84: bounded in-memory capture of errored assistant (model stream)
    // failures, correlated per toolCallId so failed tool cards report honestly
    // and the model receives a concise sanitized note when the failure details
    // leave its active context. No durable sidecar exists; the store rebuilds
    // from session entries on session_start/session_tree and never changes
    // retry/transport behavior. Registered after every critical executor
    // lifecycle hook so its session_shutdown reset can never be dispatched
    // ahead of settlement retirement or the background shell's own reaper.
    registerStreamFailureReporting(pi);
    return;
  }

  // The extension selects one mode segment per run; the launcher no longer
  // permanently appends orchestration instructions.
  const operatingModeSegments = loadOperatingModeSegments(join(__dirname, "..", "..", "scripts"));

  backgroundShellController = canRegisterBackgroundShell(pi)
    ? registerBackgroundShell(
      pi,
      (toolCallId, toolName) => nativeToolPreflight.admittedSubmittedFingerprint(toolCallId, toolName),
      (toolCallId, toolName) => nativeToolPreflight.observeReturnedError(toolCallId, toolName),
    )
    : undefined;

  // Register the compact loader before session_start. Authorization capture
  // is deliberately delayed until executionTools.sync() has registered and
  // reconciled every legitimately available top-level execution tool.
  const deferredTools = new DeferredToolManager(pi, () => config.operatingMode);
  deferredTools.register();

  // Pending questions (issue #95): AskUserQuestion registers before
  // session_start so it enters the deferred-tool authorization boundary like
  // every other top-level tool; the pending-question list shortcut and the
  // persistent panel widget are registered here as well. Top level only — executor
  // runtimes have no question UI surface.
  const userQuestions = registerUserQuestions(pi);

  const state = createState();
  let currentScopedModels: string[] = [];
  let sessionActive = true;
  let activeReviewAbort: ReviewAbortHandle | undefined;
  let activeReviewSettled: Promise<void> | undefined;
  let activeStatusTracker: ReturnType<typeof createStatusTracker> | undefined;
  let agentRunActive = false;
  let agentSettlementInputHold = false;
  // Records accumulated from each low-level run's agent_end until Pi confirms
  // via agent_settled that no automatic retry, compaction retry, or queued
  // continuation remains. Finalization must not happen at agent_end: Pi can
  // still mutate the workspace after it (e.g. a retried provider overload),
  // so closing or reviewing the window there would race the real outcome.
  let pendingSettlementUsage: TokenUsage | undefined;
  let pendingSettlementAborted = false;
  let pendingSettlementPausedForQuestion = false;
  let reviewerQuestionPausePending = false;
  let stateStore: SessionStateStore | undefined;
  type Owner = ReturnType<typeof ownedReviewCheckpointDescriptors>[number];
  const ownersOf = () => new Map(ownedReviewCheckpointDescriptors(state).map((owner) =>
    [reviewCheckpointDescriptorIdentity(owner.cwd, owner.descriptor), owner]));
  // Only verified, durably written owners enter this ledger. Retain failed
  // releases for retry; a quarantined/damaged restore never enters it.
  let durableOwners = new Map<string, Owner>();
  let ownerSaveTail = Promise.resolve();
  let latestSavedOwners = new Map<string, Owner>();
  const retiredOwnerIds = new Set<string>();
  const saveWithOwnerRetirement = (store: SessionStateStore): Promise<boolean> => {
    // Admit saves one at a time, including the entire release. A new save
    // cannot put a descriptor back on disk while its old pin is being removed.
    // Sample state at admission (not invocation), when save() serializes it.
    const operation = ownerSaveTail.then(async (): Promise<boolean> => {
      if (store !== stateStore) return false;
      const savedOwners = ownersOf();
      if ([...savedOwners.keys()].some((id) => retiredOwnerIds.has(id))) {
        await sendNoticeUnlessItThrows(pi, "review gate: a retired checkpoint was re-armed while its prior owner was being released; persistence blocked. Capture a fresh checkpoint before reviewing");
        throw new Error("review gate: retired checkpoint re-armed; capture a fresh checkpoint before reviewing");
      }
      // Throws are not acknowledgements. The next queued save still runs;
      // this operation never suppresses a previously confirmed retirement.
      if (!executionTools) throw new Error("review gate: execution tools unavailable during session save");
      const saved = await store.save(state, executionTools.associations(), effectiveReviewConfig());
      if (!saved) {
        if ([...durableOwners.keys()].some((id) => !savedOwners.has(id))) {
          await sendNoticeUnlessItThrows(pi, "review gate: checkpoint owners retained because the session-state save is unavailable; the prior sidecar still owns them. Repair persistence and restart before relying on a cleared window");
        }
        return false;
      }
      latestSavedOwners = savedOwners;
      for (const [id, owner] of savedOwners) durableOwners.set(id, owner);
      for (const [id, owner] of durableOwners) {
        if (latestSavedOwners.has(id) || ownersOf().has(id)) continue;
        const released = await releaseReviewCheckpoint(owner.cwd, owner.descriptor);
        if (released.status !== "ok") {
          await sendNoticeUnlessItThrows(pi, `review gate: retained checkpoint owner; release failed (${released.reason}). Inspect the checkpoint store and retry after repairing storage; no review success is implied`);
          throw new Error(`review gate: retained checkpoint owner; release failed (${released.reason}): ${released.detail}`);
        }
        durableOwners.delete(id);
        retiredOwnerIds.add(id);
      }
      return true;
    });
    ownerSaveTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  let checkpointRestartBlocked: string | undefined;
  /**
   * A message_start-triggered run cannot be cancelled by this host after the
   * message is admitted. If review/auth re-arming fails, fail closed at the
   * native tool boundary for the rest of this session and refuse later
   * scheduled orchestrator turns rather than allowing an unreviewed change.
   */
  let triggeringMessageReviewFailure: string | undefined;
  let backgroundCompletionMonitor: Promise<void> | undefined;
  let backgroundMonitorGeneration = 0;
  let backgroundReviewDeferred = false;
  let pendingNativeCompletionRevision: number | undefined;
  const reviewCancellation = createReviewCancellationCoordinator();
  let unsubscribeBackgroundLifecycle: (() => void) | undefined;
  const pendingEvidenceCaptures = new Set<Promise<void>>();
  const orchestratorBackgroundReadiness = new BackgroundProcessReadiness();
  const reviewerQuestionPauseWaiters = new Set<(error?: Error) => void>();
  const sessionAbortController = new AbortController();
  executionTools = new ExecutionToolManager({
    pi,
    config,
    state,
    cwd: () => currentCwd,
    submittedFingerprintFor: (toolCallId, toolName) => nativeToolPreflight.admittedSubmittedFingerprint(toolCallId, toolName),
    onNativeToolError: (toolCallId, toolName) => nativeToolPreflight.observeReturnedError(toolCallId, toolName),
    authorizedTools: () => deferredTools.authorizedToolNames(),
    notify: (message) => sendNotice(pi, message),
    // The session writer serializes save AND owner retirement. Distinguish its
    // completed retirement from a standalone controller's bare durable save.
    onAssociationsChanged: () => acknowledgeOwnerRetiringSave(persistConfirmedSessionState),
    onExpandedViewChanged: async (expanded) => {
      if (!loaded.path) {
        throw new Error("No persistent review-gate config file is loaded.");
      }
      replaceConfig(config, await persistSubtasksViewPreference(loaded.path, expanded));
    },
  });

  // Issue #26: process-local scheduled-execution runtime. The live On/Off
  // switch lives in a process-global holder that survives /reload; this
  // per-activation timer loop attaches to each session and detaches with
  // it, so timers never outlive their orchestrator while the switch keeps
  // its state across reloads. Dispatch goes straight through the ordinary
  // subtask start path — no model or orchestrator launch turn — and every
  // outcome flows through the existing owner-scoped notification policy.
  //
  // Issue #222: the per-entry schedule destination is resolved by the shared
  // dispatch layer. Scheduled subtask admissions additionally wake the model
  // through the shared non-model-initiated launch notice (partial #215),
  // held causally ordered by the controller's launch-notice gate so a fast
  // completion can never precede the notice naming it.

  /** Issue #26: owner wake for scheduler-only events (skip/overdue drop/dispatch failure). */
  const wakeSchedulerOwner = async (content: string): Promise<void> => {
    if (!deliverScheduledEvent(pi, content)) {
      await sendNotice(pi, content);
    }
  };

  /**
   * Issue #222: truthful turn-end observability for scheduled orchestrator
   * turns. Its attribution hooks observe run and message boundaries before
   * model work. The tracker's agent_settled handler is registered after the
   * review gate's own handler, so review settlement finishes before the
   * tracker marks an attributed occurrence complete. A host without hooks
   * is rejected before an orchestrator turn is sent, and the limitation is
   * reported instead.
   */
  const orchestratorTurnTracker = new ScheduledOrchestratorTurnTracker();
  // Lifecycle-test seam: exposes the live tracker so host-faithful tests can
  // observe attribution and settlement state.
  dependencies.orchestratorTurnsTestAccess?.(orchestratorTurnTracker);

  /**
   * Issue #222: fail-closed orchestrator-turn admission guard, read at each
   * dispatch: a host without every essential run-lifecycle hook can neither
   * arm the review gate before a scheduled turn's model request (nothing on
   * the idle path emits before_agent_start) nor attribute and settle the
   * occurrence, and a blocked review restart cannot settle reviews at all.
   * The unsafe scheduled turn is never delivered.
   */
  const orchestratorTurnUnsafeReason = (): string | undefined => {
    if (orchestratorTurnTracker.turnEndTracking === "unavailable") {
      return "the host does not expose the agent run-lifecycle hooks (agent_start, message_start, agent_end, agent_settled) this destination requires to arm review before the scheduled turn's model request and to attribute and settle the occurrence";
    }
    if (checkpointRestartBlocked) {
      return `the review gate is blocked for this session (fresh checkpoint restart failed: ${checkpointRestartBlocked}), so the scheduled turn could not be reviewed; nothing was delivered`;
    }
    if (triggeringMessageReviewFailure) {
      return `${triggeringMessageReviewFailure}; scheduled orchestrator turns are blocked for this session`;
    }
    return undefined;
  };

  const schedulerSwitch = getSchedulerRuntime();
  /**
   * Issue #222: one due occurrence of one scheduled entry, routed by the
   * entry's destination through src/scheduling/dispatch.ts. `dueAt` is the
   * exact absolute minute the runtime sampled, so every skip and failure wake
   * reports the scheduled due time — never the (possibly late) dispatch
   * instant. Subtask entries keep the ordinary subtask dispatch path (with
   * its overlap skip, overdue drop, and fail-closed failure reporting) plus
   * the shared model-facing launch notice; orchestrator-turn entries deliver
   * into the existing agent and complete when the initiating turn ends.
   */
  const dispatchScheduledEntry = createScheduledEntryDispatcher({
    pi,
    executionTools,
    reportOwnerEvent: wakeSchedulerOwner,
    uiNotice: (message) => sendNotice(pi, message),
    consoleWarn: (message) => console.warn(message),
    deliverLaunchNotice: async (notice: SubtaskLaunchNotice) => {
      // The bounded attempt is inside the shared module; an unavailable
      // channel is never a silent launch: the execution stays admitted and
      // the missing model wake is reported through the honest UI channel (a
      // console report follows in the dispatch layer, which holds the
      // outcome, so the UI notice carries only the user-visible part, and an
      // uncertain window is never claimed either way).
      const outcome = await deliverSubtaskLaunchNotice(pi, notice);
      if (outcome === "unavailable") {
        await sendNotice(pi, `review gate: scheduled launch notice for execution ${notice.executionId} could not be delivered to the model; the execution was admitted and its ordinary notifications remain active`);
      } else if (outcome === "uncertain") {
        await sendNotice(pi, `review gate: scheduled launch notice for execution ${notice.executionId} was accepted by the host but did not acknowledge within its bounded window; whether it was enqueued is UNKNOWN and it may still arrive`);
      }
      return outcome;
    },
    checkScheduledImages: async (entry: ScheduledTaskEntryConfig) => {
      if (loaded.path) {
        await assertScheduledImagesPresent(entry.instructions, managedScheduledImageRoot(loaded.path));
      }
    },
    orchestratorTurns: orchestratorTurnTracker,
    orchestratorTurnUnsafeReason,
  });
  const scheduledRuntime = new ScheduledTaskRuntime({
    switchState: schedulerSwitch,
    catalog: () => config.scheduledTasks,
    onDue: (entryId, entry, dueAt, overdue) => dispatchScheduledEntry(entryId, entry, dueAt, overdue),
    onError: (message) => sendNotice(pi, `review gate: ${message}`),
    ...(dependencies.schedulerTimer?.now !== undefined ? { now: dependencies.schedulerTimer.now } : {}),
    ...(dependencies.schedulerTimer?.tickIntervalMs !== undefined ? { tickIntervalMs: dependencies.schedulerTimer.tickIntervalMs } : {}),
  });

  const effectiveReviewConfig = () => {
    if (state.reviewWindow && !state.reviewWindow.reviewConfig) {
      freezeReviewWindowConfig(state, config, currentScopedModels);
    }
    return state.reviewWindow?.reviewConfig
      ?? state.lastQuestionWindow?.reviewConfig
      ?? materializeReviewConfig(config, currentScopedModels);
  };
  const persistSessionState = async (force = false) => {
    if (!stateStore || (!sessionActive && !force)) return;
    await saveWithOwnerRetirement(stateStore);
  };
  const persistConfirmedSessionState = async (): Promise<boolean> => {
    if (!stateStore || !sessionActive) return false;
    return saveWithOwnerRetirement(stateStore);
  };
  // Automatic-delivery persistence reports whether a save actually happened:
  // persistSessionState deliberately resolves without writing when there is no
  // state store or the session has gone inactive, and the uncertain-delivery
  // gate in deliverAutomaticTransmission must only treat a real durable write
  // as proof of the uncertain transition.
  const persistAutomaticDeliveryState = async (): Promise<boolean> => {
    if (!stateStore || !sessionActive) return false;
    return saveWithOwnerRetirement(stateStore);
  };

  const trackEvidenceCapture = async (operation: Promise<void>): Promise<void> => {
    pendingEvidenceCaptures.add(operation);
    try {
      await operation;
    } finally {
      pendingEvidenceCaptures.delete(operation);
    }
  };

  const drainEvidenceCaptures = async (): Promise<void> => {
    while (pendingEvidenceCaptures.size > 0) {
      await Promise.allSettled([...pendingEvidenceCaptures]);
    }
  };

  const releaseReviewerQuestionPauseWaiters = (error?: Error) => {
    for (const resolve of reviewerQuestionPauseWaiters) {
      resolve(error);
    }
    reviewerQuestionPauseWaiters.clear();
  };

  const currentBackgroundReadiness = () => {
    if (!backgroundShellController) return orchestratorBackgroundReadiness.snapshot();
    const snapshot = backgroundShellController.snapshot();
    return { revision: snapshot.revision, running: snapshot.running, unverifiable: [] as string[] };
  };

  const scheduleBackgroundCompletion = (noticeTarget: unknown) => {
    if (backgroundCompletionMonitor) return;
    const generation = backgroundMonitorGeneration;
    backgroundCompletionMonitor = (async () => {
      while (sessionActive && generation === backgroundMonitorGeneration) {
        const readiness = currentBackgroundReadiness();
        if (readiness.unverifiable.length > 0 || readiness.running.length === 0) break;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      if (!sessionActive || generation !== backgroundMonitorGeneration) return;
      const readiness = currentBackgroundReadiness();
      if (readiness.unverifiable.length > 0) {
        await sendNotice(
          noticeTarget,
          `review gate: review remains blocked because ShellStart background readiness could not be verified: ${readiness.unverifiable.join("; ")}`,
        );
        return;
      }
      if (executionTools.reviewReadiness().length > 0) return;
      const idleRevision = readiness.revision;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
      const confirmed = currentBackgroundReadiness();
      if (
        !sessionActive
        || generation !== backgroundMonitorGeneration
        || confirmed.revision !== idleRevision
        || confirmed.running.length > 0
        || confirmed.unverifiable.length > 0
        || agentRunActive
        || state.reviewInProgress
        || !state.reviewWindow
        || executionTools.reviewReadiness().length > 0
      ) return;
      const delivered = await sendTriggeredFollowUp(pi, orchestratorBackgroundCompletionPrompt);
      if (!delivered) {
        await sendNotice(noticeTarget, "review gate: background work completed, but the orchestrator could not be resumed automatically; review remains deferred until the next turn");
      }
    })().finally(() => {
      backgroundCompletionMonitor = undefined;
    });
  };

  const handleBackgroundLifecycle = (event: BackgroundShellLifecycleEvent) => {
    if (event.type === "started") {
      pendingNativeCompletionRevision = undefined;
      return;
    }
    if (
      !sessionActive
      || !backgroundReviewDeferred
      || event.running.length > 0
      || event.exitWakeScheduled
    ) return;

    const revision = event.revision;
    pendingNativeCompletionRevision = revision;
    queueMicrotask(() => {
      void (async () => {
        if (!sessionActive || pendingNativeCompletionRevision !== revision) return;
        const current = backgroundShellController?.snapshot();
        if (!current || current.revision !== revision || current.running.length > 0) return;
        if (!state.reviewWindow || state.reviewInProgress || executionTools.reviewReadiness().length > 0) return;
        const delivered = await sendTriggeredFollowUp(pi, orchestratorBackgroundCompletionPrompt);
        if (!delivered) {
          await sendNotice(pi, "review gate: background work completed, but the orchestrator could not be resumed automatically; review remains deferred until the next turn");
        }
      })();
    });
  };

  unsubscribeBackgroundLifecycle = backgroundShellController?.subscribe(handleBackgroundLifecycle);

  registerHook(pi, "session_shutdown", async (...args) => {
    nativeToolPreflight.reset();
    sessionActive = false;
    setStatus(extractContext(args) ?? pi, "review-gate", undefined);
    setStatus(extractContext(args) ?? pi, "review-gate-mode", undefined);
    sessionAbortController.abort();
    // Settle every pending question and sync waiter for the dying session so
    // nothing can outlive it; the abort above already interrupted active runs.
    userQuestionsEndSession(userQuestions?.controller);
    const reviewSettled = activeReviewSettled;
    activeReviewAbort?.shutdown();
    activeReviewAbort = undefined;
    await reviewSettled;
    await activeStatusTracker?.clear({ immediate: true });
    activeStatusTracker = undefined;
    agentRunActive = false;
    reviewerQuestionPausePending = false;
    backgroundMonitorGeneration += 1;
    backgroundReviewDeferred = false;
    pendingNativeCompletionRevision = undefined;
    orchestratorBackgroundReadiness.clear();
    unsubscribeBackgroundLifecycle?.();
    unsubscribeBackgroundLifecycle = undefined;
    releaseReviewerQuestionPauseWaiters();
    // Issue #26: stop future dispatches for the dying session first; active
    // scheduled subtasks are NOT interrupted — they settle through the
    // controller's own shutdown/recovery semantics below.
    scheduledRuntime.detach();
    // Issue #222: a new session can never complete (or settle) the previous
    // session's orchestrator-turn occurrences; correlation state is per
    // session and cleared at both boundaries.
    orchestratorTurnTracker.resetSession();
    await executionTools.shutdown();
    await webTools?.cleanup();
    await cleanupReviewBundles(state);
    await drainEvidenceCaptures();
    await persistSessionState(true);
    await stateStore?.drain();
    await executionTools.detach();
    discardSessionState(state);
  });

  registerHook(pi, "session_start", async (...args) => {
    // Issue #222: session boundaries reset orchestrator-turn correlation —
    // only runs of the CURRENT session may settle its deliveries.
    orchestratorTurnTracker.resetSession();
    triggeringMessageReviewFailure = undefined;
    // Issue #213: interactive TUI sessions prewarm the running Pi agent peer
    // immediately — a fire-and-forget native import that overlaps the rest of
    // this hook (no timer, no visible UI) so the first /review-settings menu
    // and native textbox consume an already-cached module instead of pausing
    // on a cold load. Non-TUI modes never prewarm, and any failure keeps
    // today's on-demand/fail-closed behavior. Never awaited here: the hook
    // must not block on it.
    if (contextIsInteractiveTui(extractContext(args))) {
      void prewarmPiAgentPeer();
    }
    await ownerSaveTail;
    nativeToolPreflight.reset();
    sessionActive = true;
    currentCwd = extractCwd(args, currentCwd);
    backgroundMonitorGeneration += 1;
    backgroundCompletionMonitor = undefined;
    backgroundReviewDeferred = false;
    pendingNativeCompletionRevision = undefined;
    orchestratorBackgroundReadiness.clear();
    if (backgroundShellController && !unsubscribeBackgroundLifecycle) {
      unsubscribeBackgroundLifecycle = backgroundShellController.subscribe(handleBackgroundLifecycle);
    }
    updateScopedModels(args);
    executionTools.setScopedModels(currentScopedModels);
    executionTools.setUiContext(extractContext(args) ?? pi);
    discardSessionState(state);
    checkpointRestartBlocked = undefined;
    durableOwners = new Map();
    latestSavedOwners = new Map();
    retiredOwnerIds.clear();
    const context = extractContext(args);
    const deferredSessionIdentity = typeof context === "object" && context !== null
      ? (context as { sessionManager?: unknown }).sessionManager
      : undefined;
    // Bind the pending-question controller to this session's identity; every
    // registration, presentation, and submission rechecks it, so questions
    // never cross switch/new/fork. Only an interactive TUI session can ever
    // answer or decline a question (RPC/print/JSON have no key input), so the
    // surface stays fail-closed everywhere else.
    userQuestionsBeginSession(userQuestions?.controller, deferredSessionIdentity);
    userQuestions?.setInteractiveUi(contextIsInteractiveTui(context));
    // The panel renders through the event context's widget surface (the
    // installed host does not expose it on the extension API object), so
    // note this session's live context before reconciling. A new session
    // never inherits another session's panel, and an unusable identity must
    // clear any stale one (beginSession does not notify in that case).
    userQuestions?.noteContext(context);
    userQuestions?.syncPanel();
    const identity = sessionPersistenceIdentity(context, currentCwd);
    const appendEntry = typeof pi === "object" && pi !== null && "appendEntry" in pi && typeof pi.appendEntry === "function"
      ? pi.appendEntry.bind(pi) as (customType: string, data: unknown) => void
      : undefined;
    stateStore = identity && appendEntry
      ? new SessionStateStore(identity, appendEntry)
      : identity ? new SessionStateStore(identity) : undefined;
    let restoredRevision: number | undefined;
    let damagedReviewRestart = false;
    if (stateStore) {
      try {
        const restored = await stateStore.restore(currentCwd);
        if (restored) {
          if (restored.reviewCutover === "damaged_checkpoint") {
            // Preserve the authentic prior review and its damaged record/pin
            // before writing any fresh state. link+unlink quarantine is
            // no-clobber; a failed move must never allow overwrite.
            let preserved: string;
            try {
              preserved = await stateStore.quarantine();
            } catch (error) {
              checkpointRestartBlocked = `quarantine failed (${safeRestoreFailureDiagnostic(error)})`;
              throw error;
            }
            await sendNoticeUnlessItThrows(context ?? pi,
              `review gate: previous review cannot resume (checkpoint ${restored.damagedCheckpointReason}); preserved prior state at ${boundPath(preserved)} and its owned records in place. Already-present edits become the new baseline; prior edits were not reviewed. Starting a fresh checkpoint without confirmation.`);
          }
          replaceReviewGateState(state, restored.state);
          await executionTools.restoreAssociations(restored.execution);
          // Persisted windows never carry their frozen reviewer configuration;
          // they are re-frozen against the current settings. When the review
          // settings changed since the last save, reconcile by continuing with
          // the current configuration instead of blocking: the preserved
          // baseline, evidence, and completed history stay untouched and are
          // reviewed with the currently configured reviewers.
          const reconciliation = reconcileRestoredReviewWindows(state, restored, config, currentScopedModels);
          if (reconciliation.configurationChanged && reconciliation.windows > 0) {
            await sendNotice(context ?? pi, `review gate: review settings changed since the persisted state; reconciled ${reconciliation.windows} review window(s) with the current configuration (${reconciliation.reviewers} configured reviewer(s)); preserved evidence and history are unchanged`);
          }
          restoredRevision = restored.revision;
          if (restored.reviewCutover === "damaged_checkpoint") {
            damagedReviewRestart = true;
            try {
              // Arm immediately on restart, before another turn can edit the
              // workspace; never reuse any verdict or evidence from the old
              // window. before_agent_start will attach its exchange baseline.
              const captured = await captureReviewCheckpoint(currentCwd, `window-${state.nextReviewWindowId}-${randomUUID()}`);
              if (captured.status !== "ok") throw new Error(`checkpoint capture failed (${captured.reason})`);
              beginAgentRun(state);
              setReviewWindowCheckpointBaseline(state, {
                kind: "checkpoint", descriptor: captured.value, cwd: currentCwd, capturedAt: new Date().toISOString(),
              });
              freezeReviewWindowConfig(state, config, currentScopedModels);
              if (!await saveWithOwnerRetirement(stateStore)) {
                throw new Error("fresh checkpoint state was not durably saved");
              }
              await sendNoticeUnlessItThrows(context ?? pi, "review gate: fresh checkpoint captured; only edits after this reset can receive a new review verdict");
            } catch (captureError) {
              checkpointRestartBlocked = safeRestoreFailureDiagnostic(captureError);
              stateStore.markUnavailable("fresh checkpoint restart failed");
              await sendNoticeUnlessItThrows(context ?? pi,
                `review gate: fresh checkpoint could not be durably captured (${checkpointRestartBlocked}); prior review remains preserved; review is blocked. Repair the workspace or storage and restart`);
            }
          } else {
            durableOwners = ownersOf();
            latestSavedOwners = new Map(durableOwners);
          }
        } else {
          await executionTools.restoreAssociations({ waveRoots: [], bundles: [] });
        }
      } catch (error) {
        if (error instanceof SessionStateCwdMismatchError) {
          await handleCwdMismatchRestore(context ?? pi, stateStore, error, currentCwd);
        } else {
          // Fail closed: never overwrite a sidecar that failed to restore.
          stateStore.markUnavailable(`restore failed: ${safeRestoreFailureDiagnostic(error)}`);
          await sendNoticeUnlessItThrows(
            context ?? pi,
            `review gate: persisted conversation state was not restored (${safeRestoreFailureDiagnostic(error)}); the state file was left untouched at ${boundPath(stateStore.path)}; review-gate persistence is disabled for this session to avoid overwriting it; resolve the issue manually and restart`,
          );
        }
        // Only after the store is guarded (or the sidecar already quarantined)
        // may any code path run that could persist state.
        await executionTools.restoreAssociations({ waveRoots: [], bundles: [] });
      }
    } else {
      await executionTools.restoreAssociations({ waveRoots: [], bundles: [] });
    }
    executionTools.sync();
    deferredTools.sessionStart(
      deferredSessionIdentity,
      undefined,
      false,
      deferredPiToolsEnabled(config),
    );
    setStatus(extractContext(args) ?? pi, "review-gate-mode", operatingModeStatusText(config.operatingMode));
    if (restoredRevision !== undefined) {
      await recoverPendingModelDeliveries({
        pi,
        state,
        persist: () => persistSessionState(),
        isSessionActive: () => sessionActive,
        notify: (message) => sendNotice(context ?? pi, message),
      });
      if (!damagedReviewRestart) {
        await sendNotice(context ?? pi, `review gate: restored conversation state revision ${restoredRevision}`);
      }
    }
    // Issue #26: arm the scheduler only after restore completes, so overlap
    // detection sees restored groups before any due occurrence can fire.
    scheduledRuntime.attach();
    await persistSessionState();
    await sendNotice(extractContext(args) ?? pi, `review gate: loaded (${loaded.path ?? "no config path"})`);
  });

  // #84: the same diagnostic bridge, registered after the critical review
  // lifecycle hooks. Its synchronous session_shutdown reset must never be
  // dispatched before the review shutdown handler: review cleanup starts by
  // reading the still-live context (status cleanup and abort) synchronously,
  // and once the diagnostic reset's microtask boundary has passed, the
  // context can already be stale (host /new replacement). Registration order
  // is the dispatch order the host uses, so placing this registration after
  // session_shutdown/session_start guarantees review cleanup always runs
  // first, while the bridge's message_end capture, session_start rebuild,
  // and session_tree rebuild still see every event Pi emits.
  registerStreamFailureReporting(pi);

  registerHook(pi, "input", async (...args) => {
    currentCwd = extractCwd(args, currentCwd);
    if (extractInputSource(args) === "extension") {
      return;
    }
    const text = extractInputText(args);
    if ((state.reviewInProgress || agentSettlementInputHold) && text.trim()) {
      const queued = text.trim();
      state.queuedUserInputsDuringReview.push(queued);
      const deliverySequence = state.pendingModelDeliveries.filter((delivery) => delivery.kind === "queued_user_input").length + 1;
      queueModelDelivery(state, {
        deliveryId: `queued-user-input:${state.reviewWindow?.id ?? "window"}:${deliverySequence}`,
        kind: "queued_user_input",
        channel: "follow_up",
        message: queued,
      });
      await persistSessionState();
      return { action: "handled" };
    }
    const expiredQuestionWindow = state.reviewWindow ? undefined : state.lastQuestionWindow;
    rememberUserRequest(state, text);
    await removeTransientWindowBundle(expiredQuestionWindow);
    await persistSessionState();
    return undefined;
  });

  /**
   * Issue #222 (corrected): scheduled orchestrator-turn lifecycle observation
   * and review arming against the real host's event machine. On an idle host
   * a scheduled custom send starts its run directly (before_agent_start is
   * never emitted for it); on a busy host the queued message is consumed by
   * the running cycle's loop. Both host paths emit agent_start before the
   * consuming run's message_start, whose message_start handler runs before
   * that message's model request — so here:
   *
   * - agent_start/agent_end track the run-lifecycle sequences the tracker
   *   uses to bind an observation to its consuming run and to know when that
   *   run has ended;
   * - message_start both attributes the scheduled occurrence (opaque
   *   identity in the message details — never an unrelated
   *   before_agent_start) and arms the review gate BEFORE the model request
   *   for any triggering custom message delivered by this extension (idle
   *   scheduled turn, launch notice, scheduler wake, or background-completion
   *   wake).
   *
   * The agent_settled counterpart stays after the review settlement
   * registration (the end of this activation), so the tracker only ever
   * observes completed boundaries. Handlers are exception-safe; they fire
   * for every run and message, including human-initiated ones, and only ever
   * advance the occurrence lifecycle or arm the review gate (never dispatch
   * or steer anything).
   */
  const registerObservabilityHook = (event: string, handler: HookHandler): boolean => {
    try {
      return registerHook(pi, event, handler);
    } catch {
      // A host that cannot provide this hook is rejected at dispatch time.
      return false;
    }
  };
  const orchestratorTurnHookRegistered = {
    agentStart: registerObservabilityHook("agent_start", () => {
      try {
        orchestratorTurnTracker.agentRunStarted();
      } catch {
        // Observability must never break a run.
      }
    }),
    agentEnd: registerObservabilityHook("agent_end", () => {
      try {
        orchestratorTurnTracker.agentRunEnded();
      } catch {
        // Observability must never break a run.
      }
    }),
    messageStart: registerObservabilityHook("message_start", async (...args: unknown[]) => {
      const message = findTriggeringCustomMessage(args);
      if (!message) return;
      const occurrenceId = message.customType === "pi-review-scheduled-orchestrator-turn"
        ? message.details?.occurrenceId
        : undefined;
      if (!orchestratorTurnTracker.hasRunsInFlight()) {
        // Real Pi emits agent_start before consuming a trigger-turn custom
        // message. If that contract is absent at runtime, do not arm or
        // attribute the message as though a real consuming run existed.
        triggeringMessageReviewFailure ??= "a triggering custom message arrived without an observable agent run";
        orchestratorTurnTracker.noteMessageArmingFailed(occurrenceId);
        await sendNoticeUnlessItThrows(extractContext(args) ?? pi,
          "review gate: a triggering custom message could not be correlated with an agent run; all Pi tool calls are blocked for this session, and scheduled orchestrator turns are disabled until a new session");
        return;
      }
      // Attribute FIRST (cheap and synchronous): a send promise may reject
      // while the async review baseline is being persisted. This identity is
      // the host's exact message_start, never an unrelated before_agent_start.
      const observed = occurrenceId !== undefined && orchestratorTurnTracker.noteMessageObserved(occurrenceId);
      try {
        // The scheduled instructions are the request the reviewer must
        // evaluate, not merely an unattributed custom message in the session.
        // A busy follow-up adds them to the current exchange; an idle custom
        // turn opens a new review window before its baseline is captured.
        if (observed) {
          if (!message.content?.trim()) throw new Error("scheduled request text is unavailable");
          rememberUserRequest(state, message.content);
        }
        // Fail-closed arming: this model request starts work this extension
        // initiated outside the normal prompt path. For a busy queued turn the
        // run already has an armed exchange baseline (shared window, no
        // re-capture); for an idle run this captures the baseline HERE, before
        // that message's model request.
        const armed = await armAgentRun(args);
        if (armed === "blocked") {
          throw new Error("the review gate's checkpoint restart is blocked");
        }
        if (observed) await persistSessionState();
      } catch (error) {
        // Pi may continue the provider request after a message_start handler
        // fails. Do not count this occurrence, block every native tool call
        // before execution, and refuse later scheduled turns until a new
        // session restores a trustworthy review/auth boundary.
        triggeringMessageReviewFailure ??= "a triggering custom message could not reassert its review baseline and deferred-tool authorization";
        orchestratorTurnTracker.noteMessageArmingFailed(occurrenceId);
        console.warn(`review gate: ${triggeringMessageReviewFailure}: ${error instanceof Error ? error.message : String(error)}`);
        await sendNoticeUnlessItThrows(extractContext(args) ?? pi,
          "review gate: a triggering custom message could not reassert the review baseline and deferred-tool authorization; all Pi tool calls are blocked for this session, and scheduled orchestrator turns are disabled until a new session");
      }
    }),
  };
  /**
   * Issue #222 (corrected lifecycle): the shared fail-closed run-arming body
   * for every agent run this extension observes. The review gate's
   * before_agent_start calls it for every normal user turn; the scheduled
   * custom-message observation (message_start) calls it for the idle and
   * queued scheduled runs whose submit path on real Pi hosts bypasses
   * before_agent_start entirely. Idempotent for an already-armed run (a busy
   * queued turn shares the exchange window the running cycle armed) and
   * capturing a fresh checkpoint baseline for an idle run. It cannot modify
   * the system prompt (message_start has no prompt result): the model-facing
   * injection stays on the before_agent_start path only.
   */
  const armAgentRun = async (args: unknown[]): Promise<"armed" | "blocked"> => {
    // Pi may auto-activate tools registered after session_start. Reassert the
    // captured boundary immediately before every new agent request.
    deferredTools.reapply();
    if (checkpointRestartBlocked) return "blocked";
    agentRunActive = true;
    currentCwd = extractCwd(args, currentCwd);
    updateScopedModels(args);
    executionTools.setScopedModels(currentScopedModels);
    executionTools.setUiContext(extractContext(args) ?? pi);
    beginAgentRun(state);
    if (activeExchangeHasBaseline(state)) return "armed";
    const existing = state.reviewWindow?.baseline;
    if (existing && existing.kind !== "checkpoint") {
      // Restored legacy windows retain their own typed baseline and settle
      // through their existing fail-closed path until that window closes.
      if (state.reviewWindow?.activeExchange) state.reviewWindow.activeExchange.baseline = existing;
      freezeReviewWindowConfig(state, config, currentScopedModels);
      await persistSessionState();
      return "armed";
    }
    const captured = existing ? undefined : await captureReviewCheckpoint(currentCwd, `window-${state.reviewWindow?.id ?? 0}-${randomUUID()}`);
    if (captured && captured.status !== "ok") throw new Error(`review gate: baseline capture failed (${captured.reason}): ${captured.detail}`);
    const baseline = existing ?? (captured?.status === "ok"
      ? { kind: "checkpoint" as const, descriptor: captured.value, cwd: currentCwd, capturedAt: new Date().toISOString() }
      : undefined);
    if (!baseline) throw new Error("review gate: checkpoint capture unavailable");
    // Once the descriptor enters state, retain it on save failure: a future
    // successful save can still recover the referenced checkpoint.
    try {
      setReviewWindowCheckpointBaseline(state, baseline);
      freezeReviewWindowConfig(state, config, currentScopedModels);
      await persistSessionState();
    } catch (error) {
      if (captured?.status === "ok" && state.reviewWindow?.baseline !== baseline && state.reviewWindow?.activeExchange?.baseline !== baseline) {
        const released = await releaseReviewCheckpoint(currentCwd, captured.value);
        if (released.status !== "ok") throw new Error(`review gate: baseline setup failed; orphan release failed (${released.reason}): ${released.detail}`);
      }
      throw error;
    }
    return "armed";
  };

  /**
   * Issue #222 (corrected): the review gate's run-arming for normal user
   * turns. Unchanged in behavior; the arming body is shared with the
   * scheduled custom-message observation below.
   */
  registerHook(pi, "before_agent_start", async (...args) => {
    const armed = await armAgentRun(args);
    if (armed === "blocked") throw new Error(`review gate: fresh checkpoint restart failed (${checkpointRestartBlocked}); repair and restart before review`);
    return executionPromptInjection(executionTools.criticalPrompt(), deferredTools.startupGuidance(), operatingModeSystemPrompt(args));
  });

  toolCallObserver = async (...args) => {
    if (triggeringMessageReviewFailure) {
      return {
        block: true,
        reason: `review gate: ${triggeringMessageReviewFailure}; no tool call may execute until the review/auth boundary is restored in a new session`,
      };
    }
    const decision = nativeToolPreflight.preflight(args);
    const name = extractToolName(args);
    const toolArgs = extractToolArgs(args);
    const window = state.reviewWindow;
    if (window && shouldRecordToolCallEvidence(name)) {
      try {
        await trackEvidenceCapture(recordToolCallEvidence({
          state: window.evidence,
          cwd: currentCwd,
          toolName: name,
          toolInput: toolArgs,
          snapshotOptions: {
            maxFileBytes: config.maxFileBytes,
            maxSnapshotBytes: config.maxSnapshotBytes,
          },
          exchangeSequence: window.activeExchange?.sequence,
        }));
      } catch (error) {
        if (!decision) throw error;
      }
    }
    return decision;
  };

  registerHook(pi, "tool_result", async (...args) => {
    // The next provider request can follow this hook immediately. Preserve
    // loader additions while removing registrations that were never in the
    // captured authorization boundary.
    deferredTools.reapply();
    const name = extractToolName(args);
    const toolArgs = extractToolArgs(args);
    if (!backgroundShellController) {
      orchestratorBackgroundReadiness.observeToolResult(name, args[0], isToolError(args[0]));
    }
    const window = state.reviewWindow;
    const toolError = isToolError(args[0]);
    if (!window || !shouldRecordToolResultEvidence(name, toolError)) {
      return;
    }
    recordToolResultEvidence({
      state: window.evidence,
      toolName: name,
      toolInput: toolArgs,
      result: args[0],
      isError: toolError,
      exchangeSequence: window.activeExchange?.sequence,
    });
  });

  registerHook(pi, "agent_end", async (...args) => {
    try {
    // Pi emits agent_end for every low-level run and may still auto-retry,
    // auto-compact and retry, or continue with queued follow-up messages
    // afterwards. This hook therefore only records what the finished run
    // produced; review finalization happens once at agent_settled, where Pi
    // guarantees no automatic continuation remains (docs/extensions.md).
    // Detecting "this end is retryable" from provider error strings would be
    // brittle — the lifecycle boundary is the source of truth.
    currentCwd = extractCwd(args, currentCwd);
    const signal = extractSignal(args);
    const window = state.reviewWindow;
    if (window) {
      rememberFinalAssistantSummary(window.evidence, args);
    }
    pendingSettlementUsage = combineTokenUsage(pendingSettlementUsage, extractPiUsageFromMessages(args));
    if (signal?.aborted) {
      pendingSettlementAborted = true;
    }

    // The consultation can be identified here, but cannot be reviewed or
    // released until agent_settled has run the browser ownership barrier.
    const pauseForReviewerQuestion = reviewerQuestionPausePending;
    reviewerQuestionPausePending = false;
    if (pauseForReviewerQuestion) pendingSettlementPausedForQuestion = true;
    } finally {
      await persistSessionState();
    }
  });

  registerHook(pi, "agent_settled", async (...args) => {
    try {
    // agent_settled is the only point where Pi guarantees that no automatic
    // retry, compaction retry, or queued continuation remains for this turn,
    // so the review window may be finalized here and only here. Consume this
    // cycle's accumulated records first: running a review can queue follow-up
    // runs, whose before_agent_start resets the accumulators.
    const actingUsage = pendingSettlementUsage;
    const runAborted = pendingSettlementAborted;
    const pausedForReviewerQuestion = pendingSettlementPausedForQuestion;
    pendingSettlementUsage = undefined;
    pendingSettlementAborted = false;
    pendingSettlementPausedForQuestion = false;
    agentRunActive = false;
    currentCwd = extractCwd(args, currentCwd);
    const noticeTarget = extractContext(args) ?? pi;
    if (checkpointRestartBlocked) {
      await sendNoticeUnlessItThrows(noticeTarget,
        `review gate: review blocked (${checkpointRestartBlocked}); repair and restart before review`);
      return;
    }
    const prospectiveWindow = state.reviewWindow;
    // Issue #175: automatic primary review is a stored per-layer toggle. It
    // suppresses the settlement-time automatic review only; manual
    // /review-now and /ask-reviewer stay gated by the selected reviewers and
    // the master setting. The hold must track whether an automatic review
    // will actually run, so queued user input is never stranded behind a
    // review that was switched off.
    const primaryEnabled = effectiveReviewSettings(config).primaryEnabled;
    agentSettlementInputHold = Boolean(
      prospectiveWindow?.baseline
      && !runAborted
      && !pausedForReviewerQuestion
      && !state.reviewsPaused
      && primaryEnabled
      && (prospectiveWindow.reviewConfig?.enabled ?? config.enabled),
    );
    // Reviews settle model work, not the live browser. Page scripts and
    // authenticated broker traffic may continue throughout a review.
    if (pausedForReviewerQuestion) {
      // /ask-reviewer waits for this exact model settlement boundary, without
      // closing or suspending the browser. Web effects may continue.
      const window = state.reviewWindow;
      try {
        if (window?.baseline && !runAborted) {
          await collectPausedReviewExchange({
            cwd: currentCwd,
            config: window.reviewConfig ?? config,
            evidence: window.evidence,
            actingUsage,
            window,
          });
        }
        releaseReviewerQuestionPauseWaiters();
      } catch (error) {
        releaseReviewerQuestionPauseWaiters(error instanceof Error ? error : new Error("Reviewer consultation settlement failed."));
        throw error;
      }
      return;
    }
    const window = state.reviewWindow;
    if (!window) {
      return;
    }
    if (!primaryEnabled) {
      // Automatic primary review is off (issue #175): no reviewer runs at
      // settlement. Nothing is deferred on background readiness — there is no
      // automatic review for active background work to block — and the window
      // stays open so the baseline, exchanges, evidence, and history keep
      // accumulating across quick turns for a manual /review-now. The turn's
      // exchange is settled without any verdict, so no synthetic PASS ever
      // enters the persisted review history.
      // A background-completion wake armed by an earlier deferral while
      // automatic review was on may still resume the model after the toggle:
      // it finishes the original request, and this same off path settles that
      // resumed turn without running reviewers.
      backgroundReviewDeferred = false;
      pendingNativeCompletionRevision = undefined;
      if (!window.baseline) {
        closeReviewWindow(state);
        return;
      }
      if (!config.enabled) {
        // Master setting off keeps its existing settlement semantics: the
        // window is preserved for reviewer questions but not kept open.
        closeReviewWindow(state, true);
        return;
      }
      if (runAborted) {
        // A user abort of the run supersedes automatic review; the window and
        // its baseline survive for the next turn, exactly as before.
        state.reviewInProgress = false;
        state.queuedUserInputsDuringReview = [];
        return;
      }
      await collectPausedReviewExchange({
        cwd: currentCwd,
        config: window.reviewConfig ?? freezeReviewWindowConfig(state, config, currentScopedModels),
        evidence: window.evidence,
        actingUsage,
        window,
      });
      await persistSessionState();
      return;
    }
    const backgroundReadiness = currentBackgroundReadiness();
    const executionReadiness = executionTools.reviewReadiness();
    if (backgroundReadiness.unverifiable.length > 0) {
      await sendNotice(
        noticeTarget,
        `review gate: automatic review blocked because ShellStart background readiness could not be verified: ${backgroundReadiness.unverifiable.join("; ")}`,
      );
      await persistSessionState();
      return;
    }
    if (backgroundReadiness.running.length > 0 || executionReadiness.length > 0) {
      if (backgroundReadiness.running.length > 0) backgroundReviewDeferred = true;
      const blockers = [
        backgroundReadiness.running.length > 0
          ? `${backgroundReadiness.running.length} background process group(s) remain active (${backgroundReadiness.running.map((job) => `${job.id}: ${job.label}`).join(", ")})`
          : undefined,
        executionReadiness.length > 0
          ? `${executionReadiness.length} background subtask(s) remain active (${executionReadiness.map((task) => `${task.taskId}: ${task.kind} · ${task.title} [${task.state}]`).join(", ")})`
          : undefined,
      ].filter((value): value is string => Boolean(value));
      await sendNotice(
        noticeTarget,
        `review gate: automatic review deferred while ${blockers.join(" and ")}`,
      );
      if (backgroundReadiness.running.length > 0 && !backgroundShellController) {
        scheduleBackgroundCompletion(noticeTarget);
      }
      await persistSessionState();
      return;
    }
    backgroundReviewDeferred = false;
    pendingNativeCompletionRevision = undefined;
    if (!window.baseline) {
      closeReviewWindow(state);
      return;
    }
    // #193 slice D: pass the typed baseline through. A Git checkpoint
    // variant settles inside runReview through one frozen after-checkpoint
    // (frozen-to-frozen compare, changed-only delta); a legacy snapshot keeps
    // the existing settle semantics.
    const reviewBefore = window.baseline;
    const reviewConfig = window.reviewConfig ?? freezeReviewWindowConfig(state, config, currentScopedModels);
    if (!reviewConfig.enabled) {
      if (config.enabled) {
        // The gate is enabled but no configured reviewer is currently
        // resolvable. Fail closed without clearing the preserved window: the
        // evidence stays open until a reviewer can run.
        await sendNoticeWhileSessionActive(
          noticeTarget,
          "review gate: automatic review deferred because no configured reviewer is currently available; the preserved review window stays open until a reviewer can run; use /review-settings",
          () => sessionActive,
        );
        await persistSessionState();
        return;
      }
      closeReviewWindow(state, true);
      return;
    }
    if (runAborted) {
      // A user abort of the run supersedes automatic review; the window and
      // its baseline survive for the next turn, exactly as before.
      state.reviewInProgress = false;
      state.queuedUserInputsDuringReview = [];
      return;
    }
    if (state.reviewsPaused) {
      await collectPausedReviewExchange({
        cwd: currentCwd,
        config: reviewConfig,
        evidence: window.evidence,
        actingUsage,
        window,
      });
      return;
    }

    state.reviewInProgress = true;
    let settleReview!: () => void;
    const reviewSettled = new Promise<void>((resolvePromise) => { settleReview = resolvePromise; });
    activeReviewSettled = reviewSettled;
    // The terminal-input listener must be installed before any await so Escape
    // (and /review-cancel) can abort while evidence drains or state persists;
    // the handler itself gates on reviewInProgress.
    const reviewAbort = createReviewAbortController({
      signal: undefined,
      noticeTarget,
      state,
      isSessionActive: () => sessionActive,
      cancellation: reviewCancellation,
      settled: reviewSettled,
      describe: () => "the automatic review",
    });
    activeReviewAbort = reviewAbort;
    try {
      await drainEvidenceCaptures();
      await persistSessionState();
    } catch (error) {
      // Any failure after listener/coordinator registration must still
      // unregister, settle the review, and clear active references so session
      // shutdown and /review-cancel never observe stale state.
      state.reviewInProgress = false;
      reviewAbort.cleanup();
      if (activeReviewAbort === reviewAbort) activeReviewAbort = undefined;
      settleReview();
      if (activeReviewSettled === reviewSettled) activeReviewSettled = undefined;
      throw error;
    }
    if (!sessionActive) {
      state.reviewInProgress = false;
      reviewAbort.cleanup();
      if (activeReviewAbort === reviewAbort) activeReviewAbort = undefined;
      settleReview();
      if (activeReviewSettled === reviewSettled) activeReviewSettled = undefined;
      return;
    }
    // No run signal exists at settlement time (the last low-level run has
    // already finished); cancellation still flows through escape terminal
    // input, /review-cancel, and session shutdown.
    const statusTracker = createStatusTracker(noticeTarget, "review-gate", "reviewing changes");
    activeStatusTracker = statusTracker;
    let output: ReviewRunOutput;
    try {
      output = await runReview({
        cwd: currentCwd,
        request: buildRequestContext(state, state.reviewWindow, { priorFeedback: "latest" }),
        before: reviewBefore,
        config: reviewConfig,
        evidence: window.evidence,
        correctionAttemptCount: getCorrectionAttemptCount(window),
        actingUsage,
        window,
        signal: reviewAbort.signal,
        notify: (message) => sendNoticeWhileSessionActive(noticeTarget, message, () => sessionActive),
        onUpdate: (message) => statusTracker.update(message),
        onInvocationPrepared: persistSessionState,
      });
    } catch (error) {
      if (!sessionActive) {
        return;
      }
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      throw error;
    } finally {
      await statusTracker.clear({ immediate: reviewAbort.signal.aborted, signal: reviewAbort.signal });
      if (activeStatusTracker === statusTracker) {
        activeStatusTracker = undefined;
      }
      reviewAbort.cleanup();
      if (activeReviewAbort === reviewAbort) {
        activeReviewAbort = undefined;
      }
      settleReview();
      if (activeReviewSettled === reviewSettled) activeReviewSettled = undefined;
      // A resumed conversation may need the active review artifacts.
    }

    if (!sessionActive) {
      await output.releaseReviewedBaseline?.();
      return;
    }

    if (!output.changed) {
      if (output.noReviewReason === "unchanged_deferred_response") {
        await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
        return;
      }
      closeReviewWindow(state, true);
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      return;
    }

    if (reviewAbort.signal.aborted || output.result?.error === "aborted") {
      if (reviewAbort.getReason() === "escape" || reviewAbort.getReason() === "manual") {
        await reviewAbort.notifyCancellation();
      }
      state.reviewInProgress = false;
      // Count the queued user inputs that are deliberately dropped with this
      // cancellation so the notice below never invents or leaks content. The
      // ledger is the source of truth for what is cleared: every reachable
      // current entry carries its durable delivery record, old-only entries
      // without one are still counted (never silently dropped), and ledger
      // occurrences whose only record is an in-flight delivery
      // (dispatching/uncertain) may still land and are never counted as
      // definitely dropped. The count is computed before the deliveries below
      // are cancelled and the queued-input ledger is cleared.
      const inFlightByMessage = new Map<string, number>();
      for (const delivery of state.pendingModelDeliveries) {
        if (delivery.kind === "queued_user_input" && (delivery.status === "dispatching" || delivery.status === "uncertain")) {
          inFlightByMessage.set(delivery.message, (inFlightByMessage.get(delivery.message) ?? 0) + 1);
        }
      }
      let droppedInputCount = 0;
      for (const message of state.queuedUserInputsDuringReview) {
        const inFlight = inFlightByMessage.get(message) ?? 0;
        if (inFlight > 0) {
          inFlightByMessage.set(message, inFlight - 1);
          continue;
        }
        droppedInputCount += 1;
      }
      for (const delivery of state.pendingModelDeliveries) {
        if (delivery.kind === "queued_user_input" && delivery.status === "queued") {
          delivery.status = "cancelled";
          delivery.diagnostic = "The review was explicitly cancelled before this queued input was released.";
        }
      }
      state.queuedUserInputsDuringReview.splice(0);
      // Make the cancellation durable immediately: cancelled deliveries must
      // never be re-dispatched by a later restore, and the cleared ledger must
      // not be resurrected.
      await persistSessionState();
      if (droppedInputCount > 0) {
        // Explicit count-only notice: dropped input is never resent
        // automatically and its content is never echoed.
        await sendNoticeWhileSessionActive(
          noticeTarget,
          `review gate: ${droppedInputCount} queued user input(s) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed`,
          () => sessionActive,
        );
      }
      return;
    }

    const transmit = async (details: Parameters<typeof transmitReviewPass>[0]): Promise<string> => {
      try {
        const message = await transmitReviewPass(details);
        // The new after descriptor is reachable from state; save before
        // retiring the previous response baseline. On save failure retain both.
        await persistSessionState();
        return message;
      } catch (error) {
        // A transmission that fails before recording feedback never hands off
        // the after descriptor. Once reachable from state, retain on any save
        // failure rather than deleting an in-memory or persisted reference.
        if (window.activeExchange?.baseline !== output.reviewedBaseline) await output.releaseReviewedBaseline?.();
        throw error;
      }
    };
    if (output.result?.verdict === "pass") {
      const transmission = await transmit({
        state,
        output,
        source: "automatic",
        disposition: "sent_for_observation",
        action: "passed",
      });
      await sendNoticeWhileSessionActive(
        noticeTarget,
        `review gate: ${output.result.error === "partial_reviewer_error" ? "passed with reviewer warnings" : "passed"} (${formatTokenUsage(output.result.usage)})`,
        () => sessionActive,
      );
      await deliverAutomaticTransmission(pi, noticeTarget, state, output, "passed", transmission, () => sessionActive, persistAutomaticDeliveryState);
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      return;
    }

    if (output.result?.verdict === "needs_changes") {
      if (isRepeatedNoProgressFeedback({
        previous: window.lastCorrectionFeedback,
        result: output.result,
        changes: output.changes,
        evidenceEventCount: window.evidence.events.length,
      })) {
        const transmission = await transmit({
          state,
          output,
          source: "automatic",
          disposition: "sent_at_cap",
          action: "deferred",
        });
        await sendNoticeWhileSessionActive(
          noticeTarget,
          [
            `review gate: repeated changes requested with no new correction evidence (${formatTokenUsage(output.result.usage)})`,
            "Reviewer feedback matched the previous blocking feedback, and the correction turn produced no new tool evidence or file-change fingerprint.",
            "Stopping automatic correction to avoid a loop.",
          ].join("\n"),
          () => sessionActive,
        );
        await deliverAutomaticTransmission(pi, noticeTarget, state, output, "deferred", transmission, () => sessionActive, persistAutomaticDeliveryState);
        await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
        return;
      }

      window.lastCorrectionFeedback = createCorrectionFeedbackMarker({
        result: output.result,
        changes: output.changes,
        evidenceEventCount: window.evidence.events.length,
      });
      if (window.correctionCycles >= reviewConfig.maxCorrectionCycles) {
        const deferredTransmission = await transmit({
          state,
          output,
          source: "automatic",
          disposition: "sent_at_cap",
          action: "deferred",
        });
        window.lastCappedFollowUp = buildReviewAuthorizationMessage({
          reviewSequence: output.reviewSequence!,
          bundleDir: output.bundleDir!,
        });
        await sendNoticeWhileSessionActive(
          noticeTarget,
          [
            `review gate: changes requested, automatic correction cap reached (${formatTokenUsage(output.result.usage)})`,
            "Complete reviewer feedback was transmitted to the implementing model, but automatic correction is deferred.",
            `Use /review-continue to authorize another ${reviewConfig.maxCorrectionCycles} automatic correction cycle(s).`,
          ].join("\n"),
          () => sessionActive,
        );
        await deliverAutomaticTransmission(pi, noticeTarget, state, output, "deferred", deferredTransmission, () => sessionActive, persistAutomaticDeliveryState);
        await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
        return;
      }
      window.lastCappedFollowUp = undefined;
      window.correctionCycles += 1;
      const transmission = await transmit({
        state,
        output,
        source: "automatic",
        disposition: "sent_for_correction",
        action: "correction_required",
      });
      await sendNoticeWhileSessionActive(
        noticeTarget,
        `review gate: changes requested (${formatTokenUsage(output.result.usage)})`,
        () => sessionActive,
      );
      await deliverAutomaticTransmission(pi, noticeTarget, state, output, "correction_required", transmission, () => sessionActive, persistAutomaticDeliveryState);
      await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
      return;
    }

    const failed = `review gate: reviewer failed (${formatTokenUsage(output.result?.usage)})`;
    if (output.result) {
      const transmission = await transmit({
        state,
        output,
        source: "automatic",
        disposition: "sent_review_error",
        action: "review_error",
      });
      await deliverAutomaticTransmission(pi, noticeTarget, state, output, "review_error", transmission, () => sessionActive, persistAutomaticDeliveryState);
    }
    await sendNoticeWhileSessionActive(noticeTarget, failed, () => sessionActive);
    await releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState);
    } finally {
      agentSettlementInputHold = false;
      await persistSessionState();
    }
  });

  // Command-driven reviews bypass before_agent_start. Guard their handlers at
  // registration, before a reviewer, checkpoint, notice or delivery can run.
  // Keep every other host API bound to the original Pi instance.
  const reviewCommandNames = new Set(["review-now", "review-continue", "ask-reviewer", "ask-reviewer-interactive"]);
  const commandRegister = typeof pi === "object" && pi !== null && "registerCommand" in pi && typeof pi.registerCommand === "function"
    ? pi.registerCommand.bind(pi) as (name: string, options: { handler: (args: string, ctx: unknown) => unknown }) => void
    : undefined;
  const commandHost = commandRegister
    ? new Proxy(pi as object, {
      get(target, property) {
        if (property === "registerCommand") {
          return (name: string, options: { handler: (args: string, ctx: unknown) => unknown }) =>
            commandRegister(name, {
              ...options,
              handler: async (args: string, ctx: unknown) => {
                if (checkpointRestartBlocked && reviewCommandNames.has(name)) {
                  await sendNoticeUnlessItThrows(ctx ?? pi,
                    `review gate: /${name} blocked (${checkpointRestartBlocked}); repair and restart before review`);
                  return;
                }
                return options.handler(args, ctx);
              },
            });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
    : pi;
  registerCommands({
    pi: commandHost,
    cwd: () => currentCwd,
    config,
    getConfig: () => materializeReviewConfig(config, currentScopedModels),
    state,
    isSessionActive: () => sessionActive,
    sessionSignal: sessionAbortController.signal,
    cancellation: reviewCancellation,
    onStateChanged: persistSessionState,
    releaseQueuedUserInputs: () => releaseQueuedUserInputs(pi, state, () => sessionActive, persistSessionState),
    prepareReviewerQuestion: async (commandName, ctx) => {
      if (!agentRunActive && commandContextIsIdle(ctx)) {
        return;
      }

      reviewerQuestionPausePending = true;
      const paused = new Promise<void>((resolve, reject) => reviewerQuestionPauseWaiters.add((error) => error ? reject(error) : resolve()));
      const delivered = await sendSteeringPrompt(
        pi,
        [
          `Reviewer consultation requested by /${commandName}.`,
          "Pause implementation at this steering boundary. Do not call any more tools or modify files after receiving this message.",
          "End this turn so the reviewer can inspect the workspace; its response will be provided next. The browser remains live during review and page effects may continue.",
        ].join(" "),
      );
      if (!delivered) {
        reviewerQuestionPausePending = false;
        releaseReviewerQuestionPauseWaiters();
        throw new Error("review gate: cannot pause the active turn because sendUserMessage is unavailable");
      }
      await paused;
    },
  });

  registerReviewSettings({
    pi,
    config,
    configPath: loaded.path,
    // Issue #26: the live process-local switch; the menu flips it through
    // setEnabled, which stops or starts the timers immediately.
    schedulerRuntime: schedulerSwitch,
    onSaved: async (_saved, previousMode, context) => {
      executionTools.sync();
      // Issue #26: Save replans same-process timers immediately — future-only
      // sampling restarts from the next minute boundary against the saved
      // catalog; no missed occurrence is replayed.
      scheduledRuntime.replan();
      deferredTools.setDeferredEnabled(deferredPiToolsEnabled(config));
      // The saved web visibility applies to a live interactive browser
      // immediately (controlled replacement); the callback awaits it so the
      // outcome is visibly reported, never queued or silently postponed.
      let visibilityNotice: string | undefined;
      if (webTools) {
        try {
          visibilityNotice = await webTools.applySavedSettings(config) ?? undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await sendNotice(pi, `review gate: browser visibility change failed — ${message.slice(0, 500)}; if the message above says the browser was left unchanged its handles remain valid, otherwise treat previous handles as stale and use BrowserOpen.`);
        }
      }
      if (visibilityNotice) await sendNotice(pi, `review gate: ${visibilityNotice}`);
      await applyOperatingModeTransition(previousMode, context);
      // Reconcile existing review windows to the new reviewer selection
      // immediately. The swap replaces each window's frozen config object
      // without mutating it, so an invocation already running under the old
      // selection keeps exactly the reviewers it started with; the next
      // review uses the new selection. Captured evidence, baselines, and
      // completed history are untouched.
      let reconciled = 0;
      for (const window of [state.reviewWindow, state.lastQuestionWindow]) {
        if (window && reconcileWindowReviewerSelection(window, config, currentScopedModels)) {
          reconciled += 1;
        }
      }
      if (reconciled > 0) {
        const reviewerCount = resolveReviewers(config, currentScopedModels).reviewers.length;
        await sendNotice(pi, `review gate: ${reconciled} review window(s) reconciled to the updated reviewer settings (${reviewerCount} configured reviewer(s)); preserved evidence and history are unchanged`);
        await persistSessionState();
      }
    },
    onScopedModels: (models) => {
      currentScopedModels = [...models];
      executionTools.setScopedModels(currentScopedModels);
    },
  });

  function updateScopedModels(args: unknown[]): void {
    const choices = scopedModelChoices(extractContext(args) ?? args.find((arg) => scopedModelChoices(arg) !== undefined));
    if (choices) currentScopedModels = choices.map((choice) => choice.model);
  }

  /**
   * Compose this run's system prompt: the base prompt (including any user
   * --append-system-prompt text and shared instructions) plus the current
   * operating-mode segment. Each run is built fresh, so a mode switch replaces
   * the previous mode's segment on the next run without string surgery; the
   * authorized tool inventory is appended after it by executionPromptInjection.
   */
  const operatingModeSystemPrompt = (args: unknown[]): string | undefined => {
    const base = extractSystemPrompt(args);
    const segment = operatingModeSegments[config.operatingMode];
    if (!segment) return base;
    return base ? `${base}\n\n${segment}` : segment;
  };

  const operatingModeStatusText = (mode: OperatingMode): string => `operating mode: ${OPERATING_MODE_LABELS[mode]}`;

  /**
   * The single shared operating-mode transition path (settings save today,
   * hotkey later). Affects future actions only: the current run and already
   * running subtasks keep their captured instructions, disclosed counts-only.
   */
  const applyOperatingModeTransition = async (previous: OperatingMode, noticeTarget: unknown): Promise<void> => {
    deferredTools.reapply();
    const next = config.operatingMode;
    if (previous === next) return;
    setStatus(noticeTarget, "review-gate-mode", operatingModeStatusText(next));
    const capturedWork = executionTools.reviewReadiness().length + currentBackgroundReadiness().running.length;
    const detail = next === "plan-research"
      ? "write-capable tools are hidden until you switch to a write-capable mode"
      : "previously authorized tools are available again";
    await sendNotice(
      noticeTarget,
      `review gate: operating mode is now ${OPERATING_MODE_LABELS[next]}; the mode prompt and tool set apply from the next turn. ${capturedWork > 0 ? `${capturedWork} running work item(s) keep their captured instructions until they finish. ` : ""}${detail}.`,
    );
  };

  /**
   * Direct mode-cycling hotkey (issue #20): reuses the same persisted mode
   * field and the same shared transition as the settings path. Registered
   * only when Pi exposes the shortcut API; absent hosts simply have no
   * hotkey while /review-settings keeps working.
   */
  registerModeCycleShortcut({
    pi,
    config,
    configPath: loaded.path,
    applyModeTransition: applyOperatingModeTransition,
  });

  /**
   * Issue #222 (corrected): scheduled orchestrator-turn settlement
   * observation. Registered LAST so this tracker's settlement lands after
   * the review gate's own agent_settled handler in the host's
   * registration-ordered handler lists — the review settlement completes
   * first, and the tracker only ever observes completed boundaries.
   * Availability is decided from ACTUAL registration results: a host that
   * cannot observe these events never has an unsafe scheduled orchestrator
   * turn delivered (the dispatch-time guard rejects the occurrence instead
   * of allowing an unreviewed turn).
   */
  let agentSettledRegistered = false;
  try {
    agentSettledRegistered = registerHook(pi, "agent_settled", () => {
      try {
        orchestratorTurnTracker.agentRunSettled();
      } catch {
        // Observability must never break a settlement.
      }
    });
  } catch {
    agentSettledRegistered = false;
  }
  orchestratorTurnTracker.setTurnEndTracking(
    orchestratorTurnHookRegistered.messageStart
      && orchestratorTurnHookRegistered.agentStart
      && orchestratorTurnHookRegistered.agentEnd
      && agentSettledRegistered
      ? "host-lifecycle-hooks"
      : "unavailable",
  );
}

async function cleanupReviewBundles(state: ReviewGateState): Promise<void> {
  const windows = [state.reviewWindow, state.lastQuestionWindow].filter((window) => window !== undefined);
  const directories = [...new Set([
    ...state.ownedBundleDirs,
    ...windows.map((window) => window.bundleDir).filter((value): value is string => Boolean(value)),
  ])];
  await Promise.all(directories.map((directory) => removeReviewBundle(directory)));
  state.ownedBundleDirs.clear();
  for (const window of windows) {
    window.bundleDir = undefined;
    window.retainBundleAfterClose = false;
  }
}

function canRegisterBackgroundShell(value: unknown): value is BackgroundShellHost {
  return typeof (value as { registerTool?: unknown } | undefined)?.registerTool === "function";
}

function canRegisterWebTools(value: unknown): value is PiWebHost {
  return typeof (value as { registerTool?: unknown } | undefined)?.registerTool === "function";
}

function canRegisterApplyPatchTool(value: unknown): boolean {
  return typeof (value as { registerTool?: unknown } | undefined)?.registerTool === "function";
}

function canRegisterGitReadTool(value: unknown): value is GitReadHost {
  return typeof (value as { registerTool?: unknown } | undefined)?.registerTool === "function";
}

function executorBootstrapToolCatalog(serialized: string | undefined): ExecutorToolCatalog | undefined {
  if (serialized === undefined) return undefined;
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    if (
      typeof parsed !== "object"
      || parsed === null
      || !Array.isArray(parsed.allowedToolCatalog)
      || !Array.isArray(parsed.initialActiveTools)
    ) return undefined;
    return createExecutorToolCatalog(
      parsed.allowedToolCatalog as string[],
      parsed.initialActiveTools as string[],
    );
  } catch {
    // A malformed or ambient bootstrap never falls back to the launch-active
    // catalog. Fresh worker startup will fail closed.
    return undefined;
  }
}

function extractSystemPrompt(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === "object" && arg !== null && "systemPrompt" in arg
      && typeof (arg as { systemPrompt?: unknown }).systemPrompt === "string") {
      return (arg as { systemPrompt: string }).systemPrompt;
    }
  }
  return undefined;
}

function withAuthorizedToolInventory(systemPrompt: string | undefined, inventory: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${inventory}` : inventory;
}

function deferredToolPromptInjection(
  content: string | undefined,
  systemPrompt: string | undefined,
): { systemPrompt: string } | undefined {
  if (!content) return undefined;
  return { systemPrompt: withAuthorizedToolInventory(systemPrompt, content) };
}

function executionPromptInjection(
  content: string | undefined,
  authorizedToolInventory?: string,
  systemPrompt?: string,
): { message?: { customType: string; content: string; display: boolean }; systemPrompt?: string } | undefined {
  const composedSystemPrompt = authorizedToolInventory
    ? withAuthorizedToolInventory(systemPrompt, authorizedToolInventory)
    : systemPrompt;
  if (!content && composedSystemPrompt === undefined) return undefined;
  return {
    ...(content ? {
      message: {
        customType: "pi-review-subtask-critical",
        content,
        display: false,
      },
    } : {}),
    ...(composedSystemPrompt !== undefined ? { systemPrompt: composedSystemPrompt } : {}),
  };
}

async function transmitReviewPass(input: {
  state: ReviewGateState;
  output: ReviewRunOutput;
  source: "automatic" | "manual";
  disposition: "sent_for_correction" | "sent_for_observation" | "sent_at_cap" | "sent_review_error";
  action: ReviewTransmissionAction;
}): Promise<string> {
  const message = await createReviewTransmissionMessage({
    invocationDir: input.output.invocationDir!,
    reviewSequence: input.output.reviewSequence!,
    gateVerdict: input.output.result!.verdict,
    reviewerResults: input.output.reviewerResults!,
    bundleDir: input.output.bundleDir!,
    action: input.action,
  });
  recordReviewerFeedbackAndArmExchange(input.state, {
    result: input.output.result!,
    reviewerResults: input.output.reviewerResults,
    reviewSequence: input.output.reviewSequence,
    source: input.source,
    disposition: input.disposition,
    reviewedBaseline: input.output.reviewedBaseline!,
    displayLabels: input.output.reviewerDisplayLabels,
  });
  return message;
}

const MAX_DELIVERY_DIAGNOSTIC_CHARS = 200;

function boundDeliveryDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_DELIVERY_DIAGNOSTIC_CHARS) {
    return singleLine;
  }
  const marker = "… (truncated)";
  return `${singleLine.slice(0, MAX_DELIVERY_DIAGNOSTIC_CHARS - marker.length)}${marker}`;
}

const SAFE_DIAGNOSTIC_ERRNO_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

/**
 * A trusted diagnostic for session-state restore/quarantine failures, derived
 * only from fixed categories or Node errno codes. Raw error message text is
 * never used: JSON.parse errors may quote sidecar content (including pending
 * message text) and filesystem/validation errors may repeat unbounded paths.
 * Paths must be disclosed separately, only through boundPath.
 */
function safeRestoreFailureDiagnostic(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === "string" && SAFE_DIAGNOSTIC_ERRNO_PATTERN.test(code)) return `errno ${code}`;
  if (error instanceof SessionStateParseError) return "invalid JSON";
  if (error instanceof SessionStateInvalidStateError) return "invalid persisted state";
  if (error instanceof SessionStateUnsupportedFormatError) return "unsupported pre-cutover session format (missing snapshot omission ledger)";
  if (error instanceof SessionStateMissingSelectionDigestError) return "unsupported pre-cutover session format (missing reviewer-selection digest)";
  if (error instanceof SessionStateGitBaselineError) return `Git checkpoint baseline verification failed (${error.reason})`;
  if (error instanceof SessionStateCheckpointBaselineError) return `checkpoint baseline verification failed (${error.reason})`;
  if (error instanceof SessionStateIntegrityError) return "integrity check failed";
  if (error instanceof SessionStateConversationMismatchError) return "conversation mismatch";
  return "validation failed";
}

/**
 * Send a notice best-effort: notification failures must never propagate into
 * persistence decisions (e.g. disabling a store whose quarantine succeeded).
 */
async function sendNoticeUnlessItThrows(target: unknown, message: string): Promise<void> {
  try {
    await sendNotice(target, message);
  } catch {
    // Notification is best-effort; never let it affect persistence state.
  }
}

const MAX_NOTICE_PATH_CHARS = 160;
const MAX_NOTICE_TOKEN_CHARS = 40;
const MAX_NOTICE_COUNT_ENTRIES = 8;

/** Bound a path disclosed in a notice so notices stay concise. */
function boundPath(path: string): string {
  if (path.length <= MAX_NOTICE_PATH_CHARS) return path;
  const marker = "… (truncated)";
  return `${path.slice(0, MAX_NOTICE_PATH_CHARS - marker.length)}${marker}`;
}

/** Bound an arbitrary token (e.g. a status/kind label from a sidecar). */
function boundToken(token: string): string {
  if (token.length <= MAX_NOTICE_TOKEN_CHARS) return token;
  return `${token.slice(0, MAX_NOTICE_TOKEN_CHARS - 1)}…`;
}

/** Render aggregate counts with bounded entry count and token length. */
function formatCountEntries(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_NOTICE_COUNT_ENTRIES)
    .map(([key, count]) => `${boundToken(key)} ${count}`);
  const total = Object.keys(counts).length;
  if (total > MAX_NOTICE_COUNT_ENTRIES) entries.push(`+${total - MAX_NOTICE_COUNT_ENTRIES} more`);
  return entries.join(", ");
}

/**
 * Render the safe pending-delivery summary for a notice: counts only, never
 * message text or delivery identifiers.
 */
function formatPendingDeliverySummary(summary: PendingDeliverySummary): string {
  const parts = [`${summary.total} pending delivery record(s) preserved`];
  const statuses = formatCountEntries(summary.byStatus);
  if (statuses) parts.push(`status: ${statuses}`);
  const kinds = formatCountEntries(summary.byKind);
  if (kinds) parts.push(`kinds: ${kinds}`);
  return parts.join("; ");
}

/**
 * Handle a same-conversation/different-cwd restore rejection: quarantine the
 * authoritative sidecar to a unique sibling path before any fresh-state save,
 * then notify with the mismatch, quarantine path, and safe pending-record
 * summary. If quarantine fails, fail closed: leave the prior sidecar in place,
 * disable the store so the unconditional save cannot overwrite it, and emit an
 * actionable preservation notice.
 */
async function handleCwdMismatchRestore(
  noticeTarget: unknown,
  stateStore: SessionStateStore,
  error: SessionStateCwdMismatchError,
  currentCwd: string,
): Promise<void> {
  let quarantinePath: string;
  try {
    // Only the quarantine operation is guarded: once it succeeds the prior
    // sidecar is safely preserved and persistence must stay enabled so the
    // unconditional fresh save for the new cwd can proceed.
    quarantinePath = await stateStore.quarantine();
  } catch (quarantineError) {
    stateStore.markUnavailable(`quarantine failed: ${safeRestoreFailureDiagnostic(quarantineError)}`);
    await sendNoticeUnlessItThrows(
      noticeTarget,
      `review gate: persisted conversation state belongs to a different working directory (stored: ${boundPath(error.storedCwd)}, current: ${boundPath(error.currentCwd)}) and could not be quarantined (${safeRestoreFailureDiagnostic(quarantineError)}); the prior state file was left untouched at ${boundPath(stateStore.path)}; review-gate persistence is disabled for this session to avoid overwriting it; resolve the mismatch manually and restart`,
    );
    return;
  }
  await sendNoticeUnlessItThrows(
    noticeTarget,
    `review gate: persisted conversation state belongs to a different working directory (stored: ${boundPath(error.storedCwd)}, current: ${boundPath(error.currentCwd)}); quarantined to ${boundPath(quarantinePath)}; ${formatPendingDeliverySummary(error.pendingDeliveries)}; starting fresh state for ${boundPath(currentCwd)}`,
  );
}

async function deliverAutomaticTransmission(
  pi: unknown,
  noticeTarget: unknown,
  state: ReviewGateState,
  output: ReviewRunOutput,
  action: ReviewTransmissionAction,
  message: string,
  isSessionActive: () => boolean,
  persist: () => boolean | Promise<boolean>,
): Promise<void> {
  if (!output.invocationDir) return;
  const delivery = queueModelDelivery(state, {
    kind: "review_transmission",
    channel: "follow_up",
    invocationDir: output.invocationDir,
    action,
    message,
  });
  await persist();
  if (!isSessionActive()) return;
  // dispatchModelDelivery mutates the in-memory status to uncertain before
  // awaiting persistence, so only a persist that resolves while the record is
  // uncertain proves this dispatch durably established the uncertain state.
  // Without that proof the exception must keep propagating: queue/persist
  // failures and pre-existing uncertain records are never masked as
  // transport uncertainty, never noticed as a new uncertainty, and never
  // retried or reverted to queued.
  let durablyUncertain = false;
  try {
    await dispatchModelDelivery({
      delivery,
      persist: async () => {
        const persisted = await persist();
        if (persisted && delivery.status === "uncertain") durablyUncertain = true;
      },
      deliver: () => deliverReviewTransmission({
        invocationDir: output.invocationDir!,
        action,
        message,
        idempotencyKey: delivery.deliveryId,
        deliver: () => isSessionActive() ? sendFollowUp(pi, message) : Promise.resolve(false),
      }),
    });
  } catch (error) {
    if (!durablyUncertain) {
      throw error;
    }
    await sendNoticeWhileSessionActive(
      noticeTarget,
      `review gate: delivery ${delivery.deliveryId} is uncertain and was not retried automatically: ${boundDeliveryDiagnostic(error)}; inspect ${delivery.invocationDir ?? "the resumed session"}`,
      isSessionActive,
    );
  }
}

async function recoverPendingModelDeliveries(input: {
  pi: unknown;
  state: ReviewGateState;
  persist: () => void | Promise<void>;
  isSessionActive: () => boolean;
  notify: (message: string) => void | Promise<void>;
}): Promise<void> {
  for (const delivery of input.state.pendingModelDeliveries) {
    if (delivery.status === "delivered" || delivery.status === "cancelled") continue;
    if (delivery.kind === "queued_user_input") continue;
    if (delivery.invocationDir && await hasReviewDeliveryReceipt(delivery.invocationDir, delivery.deliveryId)) {
      delivery.status = "delivered";
      delivery.deliveredAt ??= new Date().toISOString();
      delivery.diagnostic = undefined;
      await input.persist();
      continue;
    }
    if (delivery.status === "dispatching" || delivery.status === "uncertain") {
      delivery.status = "uncertain";
      delivery.diagnostic ??= "The prior application ended after dispatch began but before a durable acknowledgement was found.";
      await input.persist();
      await input.notify(`review gate: delivery ${delivery.deliveryId} is uncertain and was not duplicated automatically; inspect ${delivery.invocationDir ?? "the resumed session"}`);
      continue;
    }
    if (!input.isSessionActive()) return;
    try {
      await dispatchModelDelivery({
        delivery,
        persist: input.persist,
        deliver: () => delivery.invocationDir && delivery.action
          ? deliverReviewTransmission({
              invocationDir: delivery.invocationDir,
              action: delivery.action,
              message: delivery.message,
              idempotencyKey: delivery.deliveryId,
              deliver: () => delivery.channel === "steer"
                ? sendSteeringPrompt(input.pi, delivery.message)
                : sendFollowUp(input.pi, delivery.message),
            })
          : delivery.channel === "steer"
            ? sendSteeringPrompt(input.pi, delivery.message)
            : sendFollowUp(input.pi, delivery.message),
      });
    } catch (error) {
      await input.notify(`review gate: pending delivery ${delivery.deliveryId} could not be recovered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (input.state.queuedUserInputsDuringReview.length > 0) {
    // Occurrence-aware split: only ledger occurrences backed by an active
    // (non-terminal) durable delivery record can be released when the review
    // finishes; old-only occurrences without one must never be promised a
    // release — they stay preserved until explicitly cancelled.
    const total = input.state.queuedUserInputsDuringReview.length;
    const { releasable, unreleasable } = splitReleasableQueuedInputs(input.state);
    if (unreleasable === 0) {
      await input.notify(`review gate: ${total} user input(s) remain queued from an interrupted review and were not reordered automatically; use /review-now to finish the interrupted review and release them, or /review-clear to cancel them`);
    } else if (releasable === 0) {
      await input.notify(`review gate: ${total} user input(s) remain queued from an interrupted review and were not reordered automatically; none can be released by /review-now because no active durable delivery record exists for them; they stay preserved until cancelled with /review-clear`);
    } else {
      await input.notify(`review gate: ${total} user input(s) remain queued from an interrupted review and were not reordered automatically; ${releasable} of them can be released by finishing the interrupted review with /review-now, but ${unreleasable} cannot be released automatically because no active durable delivery record exists for them; all of them stay preserved until cancelled with /review-clear`);
    }
  }
}

/**
 * Split queued-input ledger occurrences into those backed by an active
 * (non-terminal) durable delivery record — releasable when the review
 * finishes — and old-only occurrences without one, which can never be
 * dispatched. Occurrence-based so repeated texts count correctly.
 */
function splitReleasableQueuedInputs(state: ReviewGateState): { releasable: number; unreleasable: number } {
  const activeByMessage = new Map<string, number>();
  for (const delivery of state.pendingModelDeliveries) {
    if (delivery.kind === "queued_user_input" && delivery.status !== "delivered" && delivery.status !== "cancelled") {
      activeByMessage.set(delivery.message, (activeByMessage.get(delivery.message) ?? 0) + 1);
    }
  }
  let releasable = 0;
  for (const message of state.queuedUserInputsDuringReview) {
    const active = activeByMessage.get(message) ?? 0;
    if (active > 0) {
      activeByMessage.set(message, active - 1);
      releasable += 1;
    }
  }
  return { releasable, unreleasable: state.queuedUserInputsDuringReview.length - releasable };
}

export default activate;

module.exports = activate;
Object.assign(module.exports as Record<string, unknown>, { activate });

function commandContextIsIdle(ctx: unknown): boolean {
  if (typeof ctx === "object" && ctx !== null && "isIdle" in ctx && typeof ctx.isIdle === "function") {
    return Boolean(ctx.isIdle());
  }
  return true;
}

function isToolError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "isError" in value && Boolean((value as { isError?: unknown }).isError);
}

async function releaseQueuedUserInputs(
  pi: unknown,
  state: ReviewGateState,
  isSessionActive: () => boolean,
  persist: () => void | Promise<void>,
): Promise<void> {
  state.reviewInProgress = false;
  // Old-only ledger occurrences without an active durable delivery record can
  // never be dispatched; identify them explicitly instead of silently
  // skipping — their contents stay preserved until the user cancels them.
  if (isSessionActive()) {
    const { unreleasable } = splitReleasableQueuedInputs(state);
    if (unreleasable > 0) {
      await sendNotice(
        pi,
        `review gate: ${unreleasable} queued user input(s) were not released because no active durable delivery record exists for them; they stay preserved and can be cancelled with /review-clear`,
      );
    }
  }
  for (const delivery of state.pendingModelDeliveries.filter((candidate) =>
    candidate.kind === "queued_user_input" && candidate.status !== "delivered" && candidate.status !== "cancelled")) {
    if (!isSessionActive()) return;
    rememberUserRequest(state, delivery.message);
    try {
      const delivered = await dispatchModelDelivery({
        delivery,
        persist,
        deliver: () => isSessionActive() ? sendFollowUp(pi, delivery.message) : Promise.resolve(false),
      });
      if (!delivered) return;
      const index = state.queuedUserInputsDuringReview.indexOf(delivery.message);
      if (index >= 0) state.queuedUserInputsDuringReview.splice(index, 1);
      await persist();
    } catch {
      return;
    }
  }
}

type ReviewAbortReason = "parent" | "escape" | "manual" | "session_shutdown";

interface ReviewAbortHandle {
  signal: AbortSignal;
  cleanup: () => void;
  getReason: () => ReviewAbortReason | undefined;
  notifyCancellation: () => Promise<void>;
  shutdown: () => void;
}

function createReviewAbortController(input: {
  signal: AbortSignal | undefined;
  noticeTarget: unknown;
  state: ReviewGateState;
  isSessionActive: () => boolean;
  cancellation: ReturnType<typeof createReviewCancellationCoordinator>;
  settled: Promise<void>;
  describe: () => string;
}): ReviewAbortHandle {
  const controller = new AbortController();
  let abortReason: ReviewAbortReason | undefined;
  let cancellationNotice: Promise<void> | undefined;
  let cancellationAcknowledgement: Promise<void> | undefined;
  let cleanedUp = false;

  const abortReview = (reason: ReviewAbortReason) => {
    if (!controller.signal.aborted) {
      abortReason = reason;
      controller.abort(reason);
    }
  };
  const acknowledgeCancellation = () => {
    if (!input.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationAcknowledgement) {
      cancellationAcknowledgement = sendNotice(
        input.noticeTarget,
        `review gate: cancelling ${input.describe()}; waiting for reviewer processes to stop`,
      ).catch(() => undefined);
    }
    return cancellationAcknowledgement;
  };
  const notifyCancellation = () => {
    if (abortReason !== "escape" && abortReason !== "manual") {
      return Promise.resolve();
    }
    if (!input.isSessionActive()) {
      return Promise.resolve();
    }
    if (!cancellationNotice) {
      cancellationNotice = sendNotice(input.noticeTarget, "review gate: review cancelled; reviewer processes stopped").catch(() => undefined);
    }
    return cancellationNotice;
  };
  const abortFromParent = () => abortReview("parent");

  if (input.signal?.aborted) {
    abortFromParent();
  }
  input.signal?.addEventListener("abort", abortFromParent, { once: true });

  const unsubscribeTerminalInput = onTerminalInput(input.noticeTarget, (terminalInput) => {
    if (!input.state.reviewInProgress || !isEscapeTerminalInput(terminalInput)) {
      return undefined;
    }
    abortReview("escape");
    // Immediate acknowledgement only; the completion notice claims reviewer
    // quiescence only after runReview has returned and cleanup ran.
    void acknowledgeCancellation();
    return { action: "handled", consume: true };
  });
  if (!unsubscribeTerminalInput) {
    input.cancellation.noteTerminalInterceptionUnavailable((message) => sendNotice(input.noticeTarget, message));
  }

  const cancellationHandle: ActiveReviewCancellation = {
    requestCancel: (reason: ReviewCancelReason = "manual") => abortReview(reason),
    acknowledgeCancellation,
    settled: input.settled,
    describe: input.describe,
    notifyCancellation,
  };
  const unregisterCancellation = input.cancellation.register(cancellationHandle);

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    unregisterCancellation();
    try {
      input.signal?.removeEventListener("abort", abortFromParent);
    } catch {
      // Listener removal must never mask the review outcome.
    }
    try {
      unsubscribeTerminalInput?.();
    } catch {
      // The UI context may already be stale; the review is settled either way.
    }
  };

  return {
    signal: controller.signal,
    cleanup,
    getReason: () => abortReason,
    notifyCancellation,
    shutdown: () => {
      abortReview("session_shutdown");
      cleanup();
    },
  };
}

async function sendNoticeWhileSessionActive(
  target: unknown,
  message: string,
  isSessionActive: () => boolean,
): Promise<void> {
  if (!isSessionActive()) {
    return;
  }
  await sendNotice(target, message);
}

function discardSessionState(state: ReviewGateState): void {
  replaceReviewGateState(state, createState());
}
