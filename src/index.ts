import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deferredPiToolsEnabled, loadConfig, materializeReviewConfig, resolveReviewers, type OperatingMode, type ScheduledTaskEntryConfig } from "./config";
import { ScheduledTaskRuntime } from "./scheduling/dispatcher";
import { createScheduledEntryDispatcher } from "./scheduling/dispatch";
import { deliverScheduledEvent } from "./scheduling/events";
import { ScheduledOrchestratorTurnTracker } from "./scheduling/orchestrator-turn";
import { consumeOneShotExecution } from "./scheduling/one-shot";
import { deliverSubtaskLaunchNotice, type SubtaskLaunchNotice } from "./execution/launch-notice";
import { getSchedulerRuntime } from "./scheduling/runtime";
import { removeReviewBundle, removeTransientWindowBundle } from "./bundle";
import { captureReviewCheckpoint, reviewCheckpointScopeFromContext, type ReviewCheckpointScope } from "./review-checkpoint";
import { registerCommands } from "./commands";
import {
  recordToolCallEvidence,
  recordToolResultEvidence,
  shouldRecordToolCallEvidence,
  shouldRecordToolResultEvidence,
} from "./evidence";
import { registerHook, extractContext, extractCwd, extractInputSource, extractInputText, extractToolArgs, extractToolName, sendNotice, setStatus, type HookHandler } from "./pi";
import { createReviewCancellationCoordinator } from "./review-cancellation";
import {
  beginAgentRun,
  createState,
  freezeReviewWindowConfig,
  reconcileRestoredReviewWindows,
  reconcileWindowReviewerSelection,
  rememberUserRequest,
  setReviewWindowCheckpointBaseline,
  type ReviewGateState,
} from "./state";
import { registerReviewSettings } from "./settings/command";
import { scopedModelChoices } from "./settings/models";
import { persistSubtasksViewPreference } from "./settings/persistence";
import { assertScheduledImagesPresent, managedScheduledImageRoot } from "./settings/scheduled-image-assets";
import { registerStreamFailureReporting } from "./stream-failure-report";
import { ExecutionToolManager } from "./execution/tool";
import { acknowledgeOwnerRetiringSave } from "./execution/background-controller";
import { NativeToolCallPreflight } from "./tool-call-preflight";
import { queueModelDelivery } from "./durable-delivery";
import { replaceReviewGateState, sessionPersistenceIdentity, SessionStateCwdMismatchError, SessionStateStore } from "./session-state";
import {
  registerBackgroundShell,
  type BackgroundShellHost,
} from "./background-shell";
import { boundPath, handleCwdMismatchRestore, safeRestoreFailureDiagnostic, sendNoticeUnlessItThrows } from "./activation/diagnostics";
import { createSessionPersistence } from "./activation/persistence";
import { deferredToolPromptInjection, executionPromptInjection, extractSystemPrompt } from "./activation/prompt-composition";
import { capturePrimaryCodemodeDefault } from "./activation/primary-codemode-default";
import { recoverPendingModelDeliveries, releaseQueuedUserInputs } from "./activation/pending-delivery";
import { createReviewTurnCoordinator, isToolError } from "./activation/review-turn";
import { registerApplyPatchTool } from "./apply-patch/tool";
import { registerGitReadTool, type GitReadHost } from "./git-read/tool";
import { WebToolManager, type PiWebHost } from "./web/tools";
import { DeferredToolManager, isDeferredToolHost } from "./deferred-tools";
import { loadOperatingModeSegments, OPERATING_MODE_LABELS } from "./operating-mode";
import { registerModeCycleShortcut } from "./mode-cycle";
import { contextIsInteractiveTui, registerUserQuestions, userQuestionsBeginSession, userQuestionsEndSession } from "./user-question";
import {
  registerNotificationMessageRenderers,
  warmPiTuiHost,
} from "./message-expansion";
import { prewarmPiAgentPeer } from "./peer-prewarm";
import { warmNativeExpansionHost } from "./presentation-hints";
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
  /**
   * #301 lifecycle-test seam for fake hosts that never emit a session_start
   * carrying a live session manager: the raw-checkpoint scope those tests'
   * "live session" would have. Pi never supplies dependencies, so production
   * scope always comes from the live session context at session_start.
   */
  initialCheckpointScope?: ReviewCheckpointScope;
}

export async function activate(pi: unknown, dependencies: ActivationDependencies = {}): Promise<void> {
  // Capture wrapper intent and consume its one-shot environment marker before
  // any await, tool registration, or model-spawned subprocess can inherit it.
  const executorRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE === "executor";
  const wrapperCodemodeMarker = !executorRole && process.env.PI_REVIEW_GATE_CODEMODE_DEFAULT === "1";
  delete process.env.PI_REVIEW_GATE_CODEMODE_DEFAULT;
  // Wrapper opt-in is process-local primary intent. Executor runtimes are
  // governed only by their fixed catalog and neither read nor retain it.
  const wrapperCodemodeDefault = !executorRole && capturePrimaryCodemodeDefault(wrapperCodemodeMarker);

  // Live session working directory. The top-level branch keeps it updated from
  // hook context; a Pi executor worker's cwd is its stable worktree root.
  let currentCwd = process.cwd();
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
  /**
   * Issue #306: one-shot consumption shared by both destination seams — the
   * subtask destination's actual transport-boundary dispatch record and the
   * orchestrator destination's in-run message_start observation. Both fire
   * at ACTUAL execution start, never at queueing or admission; persistence
   * failures are reported through the console (honest, non-model-facing) and
   * never claimed as recorded.
   */
  const consumeOneShot = (entryId: string): void => {
    consumeOneShotExecution(entryId, {
      config,
      ...(loaded.path !== undefined ? { configPath: loaded.path } : {}),
      reportError: (message) => console.warn(message),
    });
  };
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
    registerDeferredToolLifecycleHooks(pi, deferredTools);
    let terminal = false;
    const acknowledgementFailure = () => executorSettlementBootstrapError
      ?? (!executorSettlementBootstrap || terminal ? new Error(
        "Pi executor settlement bootstrap is unavailable or retired. Executor reload/replacement is unsupported; restart this worker with a fresh parent-issued identity.",
      ) : undefined);
    toolCallObserver = (...args) => {
      const failure = acknowledgementFailure();
      if (failure) return { block: true, reason: failure.message };
      const name = extractToolName(args);
      const nested = hasNestedToolCallParent(args);
      if (!deferredTools.toolCallAllowed(name, nested)) return nativeToolAuthorizationBlock(name, nested);
      return nativeToolPreflight.preflight(args);
    };
    if (!isDeferredToolHost(pi)) {
      // This reduced executor has no bootstrap hooks below, so reset the
      // preflight alongside its existing session lifecycle handlers. The
      // loader itself registers late (session_start) on supported hosts.
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
    registerHook(pi, "session_start", async (...args) => {
      nativeToolPreflight.reset();
      const context = extractContext(args);
      const sessionIdentity = typeof context === "object" && context !== null
        ? (context as { sessionManager?: unknown }).sessionManager
        : undefined;
      // Late loader registration with the host-native parameter schema, before
      // the authorization capture that pins this worker's boundary.
      await deferredTools.registerWithNativeSchema();
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
    let receiptPublication = Promise.resolve();
    // Bootstrap secrets are intentionally erased, not persisted across reload.
    // Pi logs most hook errors and continues: block tools explicitly, and never
    // publish a replacement receipt or reset a generation under the old identity.
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

  // The compact loader registers at session start — after executionTools.sync()
  // has registered and reconciled every legitimately available top-level
  // execution tool and before the authorization capture that pins this
  // session's boundary. Late registration keeps Pi's load-time replaceable-
  // builtin collision pass from seeing a competing tool_search definition, and
  // registerWithNativeSchema reuses the host-native parameter schema.
  const deferredTools = new DeferredToolManager(pi, () => config.operatingMode, wrapperCodemodeDefault);
  registerDeferredToolLifecycleHooks(pi, deferredTools);

  // Pending questions (issue #95): AskUserQuestion registers before
  // session_start so it enters the deferred-tool authorization boundary like
  // every other top-level tool; the pending-question list shortcut and the
  // persistent panel widget are registered here as well. Top level only — executor
  // runtimes have no question UI surface.
  const userQuestions = registerUserQuestions(pi);

  // Issue #92: automatic notification consumers of unified expansion. The five
  // orchestrator-facing custom messages (subtask event/watch, background-shell
  // wake, scheduled task event, scheduled orchestrator turn) register a message
  // renderer over the SAME shared presentation core the tool-result rollout
  // uses, so they collapse to a truthful summary and expand to the complete
  // existing notification text. Top level only — executor runtimes send none of
  // these. A host without registerMessageRenderer keeps the full native fallback.
  const notificationRenderersRegistered = registerNotificationMessageRenderers(pi);
  // Unified expansion peers (#92, wiring via src/host-peer-loader.ts): a compiled
  // extension entry (pi >= 0.86 native import) cannot resolve the host's
  // pi-tui / key-hint packages by bare `require` name, so the shared
  // presentation renderers resolve them asynchronously. Start resolving now and
  // complete it during interactive session setup below, strictly before the
  // first render; a genuinely absent peer keeps the documented native fallback.
  void warmNativeExpansionHost();
  void warmPiTuiHost();
  if (!notificationRenderersRegistered) {
    // Honest degradation: the host predates registerMessageRenderer, so the five
    // notification types render through the host's default label + full-Markdown
    // box (no compaction). Delivery and model-visible content are unchanged.
    await sendNotice(pi, "review gate: host has no message renderer API; notifications use full-text rendering");
  }

  const state = createState();
  state.checkpointScope = dependencies.initialCheckpointScope;
  let currentScopedModels: string[] = [];
  let sessionActive = true;
  let checkpointRestartBlocked: string | undefined;
  const reviewCancellation = createReviewCancellationCoordinator();
  const sessionAbortController = new AbortController();

  // The session persistence owner holds the late-bound store, the serialized
  // save-and-release tail, and the checkpoint-owner ledger. It is constructed
  // before the execution manager so the manager's association callback can be
  // wired to its confirmed-save operation; the root mediates both directions
  // of that binding (the live association snapshot sampled at save admission,
  // and onAssociationsChanged below).
  const sessionPersistence = createSessionPersistence({
    pi,
    state,
    isSessionActive: () => sessionActive,
    associations: () => executionTools?.associations(),
    reviewConfig: () => effectiveReviewConfig(),
  });
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
    onAssociationsChanged: () => acknowledgeOwnerRetiringSave(() => sessionPersistence.persistConfirmed()),
    onExpandedViewChanged: async (expanded) => {
      if (!loaded.path) {
        throw new Error("No persistent review-gate config file is loaded.");
      }
      // The view toggle persists only its owned disk preference. Installing
      // the disk-derived result into the live config here would reset
      // session-only (Escape-applied) executor, reviewer, mode, and catalog
      // choices while their pending-delta metadata still references them;
      // the live config is the sole active state, so only its owned ui field
      // changes after the awaited persistence. Live scheduled-task fields
      // (including one-shot alreadyRun) are never touched by this path.
      await persistSubtasksViewPreference(loaded.path, expanded);
      config.ui = { ...config.ui, subtasksViewExpanded: expanded };
    },
    onScheduledDispatchRecorded: consumeOneShot,
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
  const orchestratorTurnTracker = new ScheduledOrchestratorTurnTracker({
    // Issue #306: the in-run message_start observation is the one-shot
    // consumption point for this destination — the provider turn started.
    onObserved: (occurrence) => consumeOneShot(occurrence.entryId),
  });
  // Lifecycle-test seam: exposes the live tracker so host-faithful tests can
  // observe attribution and settlement state.
  dependencies.orchestratorTurnsTestAccess?.(orchestratorTurnTracker);

  // The review-turn coordinator owns the automatic review protocol's mutable
  // state: active abort/settled/status references, agent-run activity and the
  // settlement input hold, per-cycle usage/abort/question accumulators and the
  // reviewer-question pause waiters, the evidence-capture barrier, the
  // background-completion monitor/deferral state, and the triggering-message
  // failure flag. It returns handler bodies and narrow operations; every hook
  // registration stays in this root's manifest.
  const reviewTurn = createReviewTurnCoordinator({
    pi,
    state,
    config,
    scopedModels: () => currentScopedModels,
    isSessionActive: () => sessionActive,
    observeCwd: (args) => { currentCwd = extractCwd(args, currentCwd); },
    cwd: () => currentCwd,
    syncExecutionContext: (args) => {
      updateScopedModels(args);
      executionTools.setScopedModels(currentScopedModels);
      executionTools.setUiContext(extractContext(args) ?? pi);
    },
    checkpointRestartBlocked: () => checkpointRestartBlocked,
    effectiveReviewConfig: () => effectiveReviewConfig(),
    persist: () => sessionPersistence.persist(),
    persistAutomaticDelivery: () => sessionPersistence.persistAutomaticDelivery(),
    backgroundShell: () => backgroundShellController,
    reviewReadiness: () => executionTools.reviewReadiness(),
    reapplyDeferredTools: () => deferredTools.reapply(),
    cancellation: reviewCancellation,
    orchestratorTurns: orchestratorTurnTracker,
  });

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
    const triggeringFailure = reviewTurn.triggeringFailure();
    if (triggeringFailure) {
      return `${triggeringFailure}; scheduled orchestrator turns are blocked for this session`;
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
  // The construction-time subscription slot is preserved exactly: attach the
  // coordinator's lifecycle handler to the controller now (a no-op when the
  // host has no ShellStart), and re-attach after every session_start reset.
  reviewTurn.attachBackgroundLifecycle();

  registerHook(pi, "session_shutdown", async (...args) => {
    nativeToolPreflight.reset();
    sessionActive = false;
    setStatus(extractContext(args) ?? pi, "review-gate", undefined);
    setStatus(extractContext(args) ?? pi, "review-gate-mode", undefined);
    sessionAbortController.abort();
    // Settle every pending question and sync waiter for the dying session so
    // nothing can outlive it; the abort above already interrupted active runs.
    userQuestionsEndSession(userQuestions?.controller);
    // Coordinator shutdown preserves the original order: abort and await the
    // active review first, then clear the status tracker, then reset run,
    // settlement, monitor, and question-pause state.
    await reviewTurn.shutdownReview();
    await reviewTurn.clearStatusTracker();
    reviewTurn.resetForShutdown();
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
    await reviewTurn.drainEvidenceCaptures();
    await sessionPersistence.persist(true);
    await sessionPersistence.drain();
    await executionTools.detach();
    discardSessionState(state);
  });

  registerHook(pi, "session_start", async (...args) => {
    // Issue #222: session boundaries reset orchestrator-turn correlation —
    // only runs of the CURRENT session may settle its deliveries.
    orchestratorTurnTracker.resetSession();
    reviewTurn.clearTriggeringFailure();
    // Issue #213: interactive TUI sessions prewarm the running Pi agent peer
    // immediately — a fire-and-forget native import that overlaps the rest of
    // this hook (no timer, no visible UI) so the first /review-settings menu
    // and native textbox consume an already-cached module instead of pausing
    // on a cold load. Non-TUI modes never prewarm, and any failure keeps
    // today's on-demand/fail-closed behavior. The prewarm call itself stays
    // fire-and-forget; the expansion-peer warm below awaits the same in-flight
    // module records.
    if (contextIsInteractiveTui(extractContext(args))) {
      void prewarmPiAgentPeer();
      // #92: complete the expansion-peer resolution BEFORE anything renders —
      // pi draws the initial (restored) transcript only after this hook
      // completes, so a compiled deployment whose bare require() cannot see
      // the host packages is fully wired ahead of the first message or tool
      // row. Both waits join the prewarm's own in-flight module records; a
      // genuinely absent peer keeps the honest native full fallback instead
      // of failing the session.
      await Promise.all([warmNativeExpansionHost(), warmPiTuiHost()]);
    }
    await sessionPersistence.awaitSaveTail();
    nativeToolPreflight.reset();
    sessionActive = true;
    currentCwd = extractCwd(args, currentCwd);
    reviewTurn.resetForSessionStart();
    updateScopedModels(args);
    executionTools.setScopedModels(currentScopedModels);
    executionTools.setUiContext(extractContext(args) ?? pi);
    discardSessionState(state);
    checkpointRestartBlocked = undefined;
    sessionPersistence.resetLedger();
    const context = extractContext(args);
    // #301: raw checkpoints live in this live session's external namespace
    // under Pi's agent-data directory, for persisted and in-memory sessions
    // alike. The scope comes from the live session id, never from a session
    // file location or a persisted descriptor.
    state.checkpointScope = reviewCheckpointScopeFromContext(context) ?? dependencies.initialCheckpointScope;
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
    const stateStore = identity && appendEntry
      ? new SessionStateStore(identity, appendEntry)
      : identity ? new SessionStateStore(identity) : undefined;
    // The persistence owner keeps its own late-bound reference to the store
    // for the save tail and the stale-store check.
    sessionPersistence.bindStore(stateStore);
    let restoredRevision: number | undefined;
    let damagedReviewRestart = false;
    if (stateStore) {
      try {
        const restored = await stateStore.restore(currentCwd, state.checkpointScope);
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
              const captured = await captureReviewCheckpoint(currentCwd, `window-${state.nextReviewWindowId}-${randomUUID()}`, { scope: state.checkpointScope });
              if (captured.status !== "ok") throw new Error(`checkpoint capture failed (${captured.reason})`);
              beginAgentRun(state);
              setReviewWindowCheckpointBaseline(state, {
                kind: "checkpoint", descriptor: captured.value, cwd: currentCwd, capturedAt: new Date().toISOString(),
              });
              freezeReviewWindowConfig(state, config, currentScopedModels);
              if (!await sessionPersistence.saveAndRetire(stateStore)) {
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
            sessionPersistence.adoptRestoredOwners();
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
    // Late loader registration: after every legitimately available top-level
    // execution tool is registered and reconciled, before the authorization
    // capture below. The host-native parameter schema is resolved here so the
    // descriptor identity Pi's own tool_search recognition requires holds for
    // this session incarnation.
    await deferredTools.registerWithNativeSchema();
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
        persist: () => sessionPersistence.persist(),
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
    await sessionPersistence.persist();
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
    if ((state.reviewInProgress || reviewTurn.isSettlementInputHoldActive()) && text.trim()) {
      const queued = text.trim();
      state.queuedUserInputsDuringReview.push(queued);
      const deliverySequence = state.pendingModelDeliveries.filter((delivery) => delivery.kind === "queued_user_input").length + 1;
      queueModelDelivery(state, {
        deliveryId: `queued-user-input:${state.reviewWindow?.id ?? "window"}:${deliverySequence}`,
        kind: "queued_user_input",
        channel: "follow_up",
        message: queued,
      });
      await sessionPersistence.persist();
      return { action: "handled" };
    }
    const expiredQuestionWindow = state.reviewWindow ? undefined : state.lastQuestionWindow;
    rememberUserRequest(state, text);
    await removeTransientWindowBundle(expiredQuestionWindow);
    await sessionPersistence.persist();
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
    // The coordinator's handler body (verbatim move): it attributes the
    // scheduled occurrence on the host's exact message_start, re-asserts the
    // review baseline and deferred-tool authorization before that message's
    // model request, and fails closed on any arming error.
    messageStart: registerObservabilityHook("message_start", (...args: unknown[]) => reviewTurn.onMessageStart(args)),
  };
  /**
   * Issue #222 (corrected): the review gate's run-arming for normal user
   * turns. Unchanged in behavior; the arming body is shared with the
   * scheduled custom-message observation below.
   */
  registerHook(pi, "before_agent_start", async (...args) => {
    const armed = await reviewTurn.armAgentRun(args);
    if (armed === "blocked") throw new Error(`review gate: fresh checkpoint restart failed (${checkpointRestartBlocked}); repair and restart before review`);
    return executionPromptInjection(executionTools.criticalPrompt(), deferredTools.startupGuidance(), operatingModeSystemPrompt(args));
  });

  toolCallObserver = async (...args) => {
    const triggeringFailure = reviewTurn.triggeringFailure();
    if (triggeringFailure) {
      return {
        block: true,
        reason: `review gate: ${triggeringFailure}; no tool call may execute until the review/auth boundary is restored in a new session`,
      };
    }
    const name = extractToolName(args);
    const nested = hasNestedToolCallParent(args);
    const decision = deferredTools.toolCallAllowed(name, nested)
      ? nativeToolPreflight.preflight(args)
      : nativeToolAuthorizationBlock(name, nested);
    const toolArgs = extractToolArgs(args);
    const window = state.reviewWindow;
    if (window && shouldRecordToolCallEvidence(name)) {
      try {
        await reviewTurn.trackEvidenceCapture(recordToolCallEvidence({
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
    reviewTurn.observeBackgroundToolResult(name, args[0]);
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

  registerHook(pi, "agent_end", (...args) => reviewTurn.onAgentEnd(args));

  // The coordinator settlement handler (verbatim move): agent_settled is the
  // only boundary where Pi guarantees no automatic continuation remains, so
  // the review window is finalized there and only there.
  registerHook(pi, "agent_settled", (...args) => reviewTurn.onAgentSettled(args));

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
    onStateChanged: () => sessionPersistence.persist(),
    releaseQueuedUserInputs: () => releaseQueuedUserInputs(pi, state, () => sessionActive, () => sessionPersistence.persist()),
    // The coordinator question-pause preparation (verbatim move): it holds
    // the settlement input hold, steers the model to pause, and waits for
    // the agent_settled boundary that collects the paused exchange.
    prepareReviewerQuestion: (commandName, ctx) => reviewTurn.prepareReviewerQuestion(commandName, ctx),
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
        await sessionPersistence.persist();
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
    const capturedWork = executionTools.reviewReadiness().length + reviewTurn.currentBackgroundReadiness().running.length;
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

export default activate;

module.exports = activate;
Object.assign(module.exports as Record<string, unknown>, { activate });

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

function registerDeferredToolLifecycleHooks(pi: unknown, deferredTools: DeferredToolManager): void {
  // Pi exposes these real runtime boundaries for reconciling native tool
  // registry changes; there is deliberately no synthetic tools_changed hook.
  for (const event of ["turn_start", "session_tree", "mcp_servers_change"]) {
    registerHook(pi, event, () => deferredTools.reapply());
  }
}

function hasNestedToolCallParent(args: unknown[]): boolean {
  return args.some((arg) => {
    if (typeof arg !== "object" || arg === null) return false;
    const parentToolCallId = (arg as { parentToolCallId?: unknown }).parentToolCallId;
    return typeof parentToolCallId === "string" && parentToolCallId.length > 0;
  });
}

function nativeToolAuthorizationBlock(name: string, nested: boolean): { block: true; reason: string } {
  const target = name || "unknown tool";
  return {
    block: true,
    reason: `review gate: ${nested ? "nested " : ""}native tool call to ${target} is not permitted by the live session authorization boundary`,
  };
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

function discardSessionState(state: ReviewGateState): void {
  replaceReviewGateState(state, createState());
}
