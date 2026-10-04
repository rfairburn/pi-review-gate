import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PROCESS_TREE_CLEANUP_GRACE_MS,
  terminateProcessTree,
  waitForPromiseBounded,
  type BoundedProcessClose,
  type ProcessRunResult,
} from "../../adapters/process";
import { DEFAULT_PI_COMMAND, resolvePiChildSpawn, translateDefaultPiSpawnError } from "../../pi-invocation";
import { BoundedTextAccumulator, MEBIBYTE } from "../../jsonl";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import { PiJsonlActivityExtractor } from "../progress";
import { ExecutorLifecycleError, type ExecutorAdapter, type ExecutorInteractionAcknowledgement, type ExecutorRequest, type ExecutorTurn } from "../types";
import type { ThinkingLevel } from "../../config";
import { BackgroundProcessReadiness } from "../../background-process-readiness";
import { assertNoPiToolPolicyArgs } from "../../pi-tool-policy";
import { isLiveWindowsProcessDescendant } from "../windows-process-lineage";
import {
  DEFERRED_TOOL_SEARCH_NAME,
  EXECUTOR_TOOL_CATALOG_ENV,
  createExecutorToolCatalog,
  createPiWorkerToolCatalog,
  rejectPreCutoverRequestFields,
  type ExecutorToolCatalog,
} from "../tool-catalog";
import {
  PI_SETTLEMENT_CHILD_ENV,
  PI_SETTLEMENT_PATH_ENV,
  PI_SETTLEMENT_SECRET_ENV,
  PI_SETTLEMENT_SESSION_ENV,
  awaitPiSettlementReceipt,
  createPiSettlementBootstrap,
  piSettlementEnvironment,
  removePiSettlementReceipt,
  type PiSettlementBootstrap,
} from "../pi-settlement-receipt";

export interface PiExecutorOptions {
  model: string;
  thinkingLevel?: ThinkingLevel;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  /** Test/embedding override; otherwise bounded by the remaining executor deadline. */
  settlementTimeoutMs?: number;
}

// Successful settlement leaves a live browser. Terminal cleanup gets its
// existing shutdown window, then a separate bounded tree-cleanup/close drain.
const PI_EXECUTOR_TERMINAL_SHUTDOWN_MS = 15_000;
const PI_EXECUTOR_TERMINAL_CLEANUP_MS = 2_000 + PROCESS_TREE_CLEANUP_GRACE_MS;
const PI_RPC_ROOT_EXIT_DRAIN_MS = 100;

export class PiExecutorAdapter implements ExecutorAdapter {
  readonly kind = "pi-model";
  readonly toolEventObservability = {
    mode: "structured",
    description: "Pi RPC tool_execution_start/end events expose named tool inputs and results; delivery may race the child mutation, so prior state is not verified.",
  } as const;
  readonly model: string;

  constructor(private readonly options: PiExecutorOptions) {
    this.model = options.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    assertNoPiToolPolicyArgs(this.options.args ?? [], "Pi executor arguments");
    rejectPreCutoverRequestFields(request);
    const thinkingLevel = this.options.thinkingLevel ?? "high";
    if (!request.executorToolCatalog) {
      throw new Error("Pi executor launch requires an authoritative executor tool catalog for native --tools enforcement.");
    }
    const durableToolCatalog = createExecutorToolCatalog(
      request.executorToolCatalog.allowedToolCatalog,
      request.executorToolCatalog.initialActiveTools,
    );
    const toolCatalog = createPiWorkerToolCatalog(durableToolCatalog);
    // The native CLI allowlist remains the hard launch boundary. tool_search
    // is the sole control tool added outside the durable capability catalog;
    // the extension receives the validated initial subset through a private
    // child environment bootstrap.
    const launchTools = [...new Set([...toolCatalog.allowedToolCatalog, DEFERRED_TOOL_SEARCH_NAME])];
    const sessionId = request.session?.id ?? randomUUID();
    const sessionDir = join(request.artifactDir, "executor-sessions");
    await mkdir(sessionDir, { recursive: true });
    if (request.recovery?.compactBeforePrompt) {
      if (!request.session) {
        throw new Error("Cannot compact an interrupted executor without its durable session id.");
      }
      request.onUpdate?.("reopening executor session for context compaction");
      try {
        await compactInterruptedSession({
          command: this.options.command ?? "pi",
          model: this.options.model,
          thinkingLevel,
          sessionId,
          sessionDir,
          cwd: request.cwd,
          args: childArgs(this.options.args ?? [], launchTools),
          timeoutMs: Math.min(this.options.timeoutMs ?? 1_800_000, 300_000),
          env: executorEnv(toolCatalog),
          signal: request.signal,
          onProcessStart: request.onProcessStart,
          onProcessExit: request.onProcessExit,
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new ExecutorLifecycleError(
          "compaction",
          `Explicit executor compaction recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      request.onUpdate?.("context compaction completed; resuming executor");
    }
    const extractor = new PiJsonlReviewExtractor();
    const activity = new PiJsonlActivityExtractor((message) => request.onUpdate?.(message));
    const args = [
      "--model", this.options.model,
      "--mode", "rpc",
      "--thinking", thinkingLevel,
      "--session-id", sessionId,
      "--session-dir", sessionDir,
      ...childArgs(this.options.args ?? [], launchTools),
    ];
    const timeoutMs = this.options.timeoutMs ?? 1_800_000;
    const settlementBootstrap = createPiSettlementBootstrap(request.artifactDir, sessionId);
    // The identity is random, but remove only this exact parent-owned path so
    // an impossible stale collision can never satisfy the new child.
    await removePiSettlementReceipt(settlementBootstrap);
    // #204: alias-independent default `pi` launch; Windows npm pi.cmd is
    // invoked through the shared cmd.exe spec without inspecting its contents.
    const childEnv = executorEnv(toolCatalog, settlementBootstrap);
    const invocation = resolvePiChildSpawn(this.options.command ?? "pi", args, childEnv);
    if (!invocation.ok) throw new Error(invocation.error);
    // Only the POSIX pass-through keeps the bare `pi` name; a missing default
    // Pi CLI there surfaces as an actionable diagnostic instead of raw ENOENT.
    const isDefaultPiPassThrough = invocation.file === DEFAULT_PI_COMMAND;
    const proc = spawn(invocation.file, invocation.args, {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const identity = proc.pid === undefined ? undefined : {
      pid: proc.pid,
      processGroupId: process.platform === "win32" ? undefined : proc.pid,
    };
    if (invocation.windowsVerbatimArguments) {
      // cmd.exe is the owned cleanup/lifecycle root, not the actual Pi Node
      // process. The first signed child receipt must prove native process
      // ancestry before binding its PID; the callback remains parent-only.
      settlementBootstrap.verifySpawnedPid = (pid) => isLiveWindowsProcessDescendant(proc, pid);
    } else {
      // Direct spawns bind the known child PID exactly as before.
      settlementBootstrap.pid = proc.pid;
    }
    // Observe the child lifecycle before awaiting durable PID persistence
    // (#231): a fast-exiting child can emit 'close' while onProcessStart is
    // still pending, and PiRpc must already be listening for that event so
    // the turn settles from the real exit instead of hanging. The delivery
    // barrier is retained: no prompt is written until after onProcessStart
    // resolves (the first RPC write happens below).
    const backgroundReadiness = new BackgroundProcessReadiness();
    const rpc = new PiRpc(proc, backgroundReadiness, (chunk) => {
      extractor.push(chunk);
      activity.push(chunk);
    }, (error) => translateDefaultPiSpawnError(error, isDefaultPiPassThrough), request.onToolObservation);
    const rootExit = rpc.rootExited();
    let rootExitObserved = false;
    void rootExit.then(() => { rootExitObserved = true; });
    let lifecycleStart: Promise<void> | undefined;
    let lifecycleStartError: unknown;
    let lifecycleCompletion: Promise<void> | undefined;
    let timedOut = false;
    let aborted = false;
    let interruptedByControl = false;
    let startupReady = false;
    let cancelStartup!: () => void;
    const startupCancelled = new Promise<void>((resolvePromise) => { cancelStartup = resolvePromise; });
    // Turn-interrupt steering handoff (issue #63): held from the start of a
    // steering delivery until its transport acceptance. During that window an
    // interrupted session can briefly look idle, so run() must not settle on
    // pre-steering text in between.
    const steerHandoff = (() => {
      let pending = false;
      let waiter: (() => void) | undefined;
      return {
        begin: (): void => { pending = true; },
        end: (): void => { pending = false; waiter?.(); waiter = undefined; },
        isPending: (): boolean => pending,
        wait: async (): Promise<void> => {
          while (pending) await new Promise<void>((resolvePromise) => { waiter = resolvePromise; });
        },
      };
    })();
    // Set synchronously with run()'s completion break so a steer starting
    // after it fails truthfully instead of acknowledging into a finishing
    // run (issue #63).
    let completing = false;
    let protocolFailure: string | undefined;
    const appendProtocolFailure = (failure: string): void => {
      if (!protocolFailure) protocolFailure = failure;
      else if (!protocolFailure.includes(failure)) protocolFailure = `${protocolFailure} ${failure}`;
    };
    let cleanupFailure: string | undefined;
    let finalText = "";
    let timeoutDeadline = Date.now() + timeoutMs;
    let receiptGeneration = 0;
    // Highest settlement generation run() has authenticated as a clean state.
    // New waits anchor after it so an already-settled steered replacement is
    // re-authenticated from its own receipts instead of waiting for a turn
    // that will not come (issue #63).
    let authenticatedSettlementGeneration = 0;
    let lastSettlementAcknowledged = false;
    const settlementAcknowledgements = new Map<number, Promise<void>>();
    const waitForAuthenticatedSettlement = async (after: number): Promise<void> => {
      let acknowledgement = settlementAcknowledgements.get(after);
      if (!acknowledgement) {
        acknowledgement = (async () => {
          let afterAgentEnd = after;
          for (;;) {
            // agent_end is only a wake-up hint. The signed receipt below is
            // emitted by the child's actual agent_settled hook and supplies
            // the authoritative child generation, not zero browser resources.
            // Worker browsers remain live between turns; terminal cleanup is
            // required before this adapter returns completion to its parent.
            await rpc.waitForSettled(afterAgentEnd);
            const remaining = Math.max(1, timeoutDeadline - Date.now());
            receiptGeneration = await awaitPiSettlementReceipt(
              settlementBootstrap,
              receiptGeneration,
              Math.min(this.options.settlementTimeoutMs ?? remaining, remaining),
              request.signal,
            );
            const state = rpcState(await rpc.request("get_state", {}));
            if (!state.isStreaming && state.pendingMessageCount === 0) {
              lastSettlementAcknowledged = true;
              return;
            }
            // A prior autonomous settlement raced the prompted turn. Its
            // receipt is valid but cannot acknowledge the newer active/queued
            // turn; wait for that turn's own actual settlement generation.
            lastSettlementAcknowledged = false;
            afterAgentEnd = rpc.settledGeneration;
          }
        })();
        settlementAcknowledgements.set(after, acknowledgement);
      }
      await acknowledgement;
    };
    const timer = setInterval(() => {
      if (startupReady && backgroundReadiness.snapshot().running.length > 0 && !rootExitObserved
        && !aborted && !request.signal?.aborted
        && !interruptedByControl && !rpc.terminationWasRequested) {
        timeoutDeadline = Date.now() + timeoutMs;
        return;
      }
      if (Date.now() < timeoutDeadline) return;
      timedOut = true;
      if (!startupReady) cancelStartup();
      rpc.terminate();
    }, Math.min(250, Math.max(25, Math.floor(timeoutMs / 4))));
    // Keep the model deadline live even if the owned child exits while an
    // asynchronous start-persistence callback is still pending.
    const onAbort = () => {
      aborted = true;
      if (!startupReady) {
        cancelStartup();
        rpc.terminate();
        return;
      }
      if (interruptedByControl) return;
      const abortDeadline = setTimeout(() => rpc.terminate(), 2_000);
      void rpc.request("abort", {}).catch(() => undefined).finally(() => {
        clearTimeout(abortDeadline);
        rpc.terminate();
      });
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    lifecycleStart = (async () => {
      if (identity) await request.onProcessStart?.(identity);
    })();
    void lifecycleStart.catch((error) => {
      lifecycleStartError = error instanceof Error ? error : new Error(messageOf(error));
      if (!startupReady) cancelStartup();
      rpc.terminate();
    });
    const startupOutcome = await Promise.race([
      lifecycleStart.then(() => "ready" as const, () => "failed" as const),
      startupCancelled.then(() => "stopped" as const),
    ]);
    if (startupOutcome === "ready" && Date.now() >= timeoutDeadline) {
      timedOut = true;
      cancelStartup();
      rpc.terminate();
    }
    startupReady = startupOutcome === "ready"
      && !timedOut && !aborted && !request.signal?.aborted && !rpc.terminationWasRequested;
    if (lifecycleStartError) {
      protocolFailure = `Pi executor lifecycle start callback failed: ${messageOf(lifecycleStartError)}`;
    }
    if (!startupReady && timedOut && !protocolFailure) {
      protocolFailure = "Pi executor startup did not complete before the configured model deadline.";
    }
    if (!startupReady && !timedOut && !aborted && !protocolFailure && rpc.terminationWasRequested) {
      protocolFailure = "Pi executor startup stopped before durable process identity publication completed.";
    }
    // Keep a bounded startup stop out of the RPC failure path without wrapping
    // the existing prompt/settlement state machine in an additional scope.
    const startupSkipped = Symbol("Pi executor startup did not complete");
    try {
      if (!startupReady) throw startupSkipped;
      let settledGeneration = rpc.settledGeneration;
      await rpc.request("prompt", { message: request.prompt });
      // #93: the RPC transport accepted the prompt — the actual delivery
      // boundary for this prompt.
      request.onPromptDelivery?.({ prompt: request.prompt });
      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: "pi rpc",
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId, options) => {
          try {
            if (completing) {
              return { status: "failed", message: "Pi executor completion is already in progress; steering was not delivered." };
            }
            // Hold the handoff from delivery start until transport acceptance
            // so run() can never settle on pre-steering text while this
            // delivery is in flight (issue #63). The acknowledgement covers
            // delivery acceptance only; run() follows the replacement turn's
            // own settlement before completing.
            steerHandoff.begin();
            try {
              const state = await rpc.request("get_state", {});
              if (!options?.interrupt && rpcState(state).isStreaming) {
                // Injected into the active turn; its settlement is already
                // tracked by run() through the ongoing generation.
                await rpc.request("steer", { message: instruction }, instructionId);
                return { status: "acknowledged", message: "Pi RPC acknowledged live steering." };
              }
              let interruptedActiveTurn = false;
              if (options?.interrupt && rpcState(state).isStreaming) {
                // Pi RPC abort waits for the session to become idle before
                // responding, so the prompt below starts a clean turn in the
                // same session and workspace.
                await rpc.request("abort", {});
                interruptedActiveTurn = true;
              }
              await rpc.request("prompt", { message: instruction }, instructionId);
              return {
                status: "acknowledged",
                message: options?.interrupt
                  ? (interruptedActiveTurn
                    ? "Pi RPC interrupted the active turn and delivered steering to the same session."
                    : "No active Pi RPC turn was streaming; steering was delivered to the idle executor without interruption.")
                  : "Pi RPC resumed the idle executor with the steering instruction while background work remained active.",
              };
            } finally {
              steerHandoff.end();
            }
          } catch (error) {
            return { status: "failed", message: messageOf(error) };
          }
        },
        interrupt: async (): Promise<ExecutorInteractionAcknowledgement> => {
          try {
            interruptedByControl = true;
            const state = await rpc.request("get_state", {});
            if (!rpcState(state).isStreaming) {
              rpc.terminate();
              const close = await rpc.waitForCloseBounded(PI_EXECUTOR_TERMINAL_CLEANUP_MS);
              if (!close.closeObserved) {
                throw new Error("Pi RPC interruption cleanup is uncertain: child close was not observed before the teardown deadline; the owned root or descendants may remain live.");
              }
              return { status: "acknowledged", message: "Pi RPC interruption observed executor shutdown." };
            }
            const beforeInterrupt = rpc.settledGeneration;
            await rpc.request("abort", {});
            lastSettlementAcknowledged = false;
            await waitForAuthenticatedSettlement(beforeInterrupt);
            // Turn settlement leaves a live browser; interruption is terminal.
            rpc.terminate();
            const close = await rpc.waitForCloseBounded(PI_EXECUTOR_TERMINAL_CLEANUP_MS);
            if (!close.closeObserved) {
              throw new Error("Pi RPC interruption cleanup is uncertain: child close was not observed before the teardown deadline; the owned root or descendants may remain live.");
            }
            return { status: "acknowledged", message: "Pi RPC acknowledged interruption and observed executor shutdown." };
          } catch (error) {
            return { status: "failed", message: messageOf(error) };
          }
        },
      });
      lastSettlementAcknowledged = false;
      await waitForAuthenticatedSettlement(settledGeneration);
      authenticatedSettlementGeneration = rpc.settledGeneration;
      for (;;) {
        const background = backgroundReadiness.snapshot();
        if (background.unverifiable.length > 0) {
          throw new Error(
            `ShellStart reported background work whose process group could not be verified: ${background.unverifiable.join("; ")}`,
          );
        }
        if (background.running.length === 0) {
          const idleState = rpcState(await rpc.request("get_state", {}));
          if (idleState.isStreaming || idleState.pendingMessageCount > 0) {
            request.onUpdate?.("steered turn still active; waiting for its settlement before completion");
            lastSettlementAcknowledged = false;
            await waitForAuthenticatedSettlement(authenticatedSettlementGeneration);
            authenticatedSettlementGeneration = rpc.settledGeneration;
            continue;
          }
          // A steering delivery may sit between decision and transport
          // acceptance while the session looks idle; wait it out so completion
          // never uses pre-steering text (issue #63).
          if (steerHandoff.isPending()) {
            await steerHandoff.wait();
            continue;
          }
          if (rpc.settledGeneration > authenticatedSettlementGeneration) {
            // Settlements completed after the last authenticated clean state
            // - for example a steered replacement turn that finished while
            // run() was waiting elsewhere. Re-authenticate from the
            // pre-steering generation so their own receipts evidence
            // completion, instead of trusting stale evidence or waiting for a
            // turn that will not come (issue #63).
            request.onUpdate?.("settled turn(s) completed since the last authenticated settlement; re-authenticating before completion");
            lastSettlementAcknowledged = false;
            await waitForAuthenticatedSettlement(authenticatedSettlementGeneration);
            authenticatedSettlementGeneration = rpc.settledGeneration;
            continue;
          }
          break;
        }
        request.onUpdate?.(
          `executor waiting for ${background.running.length} background process group(s): ${background.running.map((job) => `${job.id} (${job.label})`).join(", ")}`,
        );
        await waitForBackgroundProcesses(
          backgroundReadiness,
          request.signal,
          rootExit,
          () => timedOut || aborted || interruptedByControl || rpc.terminationWasRequested,
        );
        if (request.signal?.aborted || timedOut || aborted || interruptedByControl || rpc.terminationWasRequested) break;
        const idleRevision = backgroundReadiness.snapshot().revision;

        settledGeneration = rpc.settledGeneration;
        const state = rpcState(await rpc.request("get_state", {}));
        const confirmed = backgroundReadiness.snapshot();
        if (confirmed.revision !== idleRevision || confirmed.running.length > 0) {
          request.onUpdate?.("background readiness changed before executor resumption; waiting for the current process groups");
          continue;
        }
        if (state.isStreaming || state.pendingMessageCount > 0) {
          request.onUpdate?.("background process completed; waiting for the executor's automatic completion turn");
          lastSettlementAcknowledged = false;
          await waitForAuthenticatedSettlement(settledGeneration);
          authenticatedSettlementGeneration = rpc.settledGeneration;
        } else {
          request.onUpdate?.("background process completed; resuming executor for final inspection before review");
          await rpc.request("prompt", { message: backgroundCompletionPrompt });
          lastSettlementAcknowledged = false;
          await waitForAuthenticatedSettlement(settledGeneration);
          authenticatedSettlementGeneration = rpc.settledGeneration;
        }
      }
      if (request.signal?.aborted || timedOut || aborted || interruptedByControl || rpc.terminationWasRequested) {
        throw new Error("Pi RPC terminal teardown was requested.");
      }
      completing = true;
      const response = await rpc.request("get_last_assistant_text", {});
      finalText = isRecord(response.data) && typeof response.data.text === "string" ? response.data.text : "";
      if (!lastSettlementAcknowledged) {
        throw new Error("Pi executor completion lacks an acknowledgement for its final settlement.");
      }
    } catch (error) {
      if (error !== startupSkipped && !timedOut && !aborted && !interruptedByControl) protocolFailure = messageOf(error);
    } finally {
      clearInterval(timer);
      request.signal?.removeEventListener("abort", onAbort);
      request.onLiveControl?.(undefined);
      if (lastSettlementAcknowledged && !timedOut && !aborted && !interruptedByControl && !protocolFailure && !rpc.failure) rpc.closeInput();
      else rpc.terminate();
    }
    type ShutdownOutcome =
      | { kind: "closed"; exit: { code: number | null; signal: NodeJS.Signals | null } }
      | { kind: "root-exited" }
      | { kind: "deadline" };
    let shutdownTimer: NodeJS.Timeout | undefined;
    const shutdownWaits: Array<Promise<ShutdownOutcome>> = [
      rpc.closed().then((exit) => ({ kind: "closed", exit } as const)),
      new Promise<ShutdownOutcome>((resolvePromise) => {
        shutdownTimer = setTimeout(() => resolvePromise({ kind: "deadline" }), PI_EXECUTOR_TERMINAL_SHUTDOWN_MS);
        shutdownTimer.unref?.();
      }),
    ];
    // During an already-requested teardown, root exit is enough to begin the
    // bounded inherited-pipe drain. A normal stdin-close shutdown still gets
    // the full existing graceful window before any process-tree signaling.
    if (rpc.terminationWasRequested) {
      shutdownWaits.push(rpc.rootExited().then(() => ({ kind: "root-exited" } as const)));
    }
    const exitWithinDeadline: Promise<ShutdownOutcome> = Promise.race(shutdownWaits);
    let shutdown = await exitWithinDeadline.finally(() => clearTimeout(shutdownTimer));
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    let exitObserved = false;
    if (shutdown.kind === "closed") {
      exit = shutdown.exit;
      exitObserved = true;
      if (rpc.closeCleanupUncertainStatus) {
        cleanupFailure = "Pi RPC cleanup uncertain: the child close notification followed local stdio destruction and does not confirm owned descendant cleanup.";
      }
    } else {
      if (shutdown.kind === "deadline") {
        protocolFailure ??= `Pi RPC terminal shutdown exceeded its ${PI_EXECUTOR_TERMINAL_SHUTDOWN_MS}ms cleanup deadline.`;
      } else {
        // The root can exit before its inherited stdio handles close. Give a
        // normally-draining close event a short chance before tree cleanup.
        let rootDrainTimer: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
          rpc.closed().then((closedExit) => ({ kind: "closed", exit: closedExit } as const)),
          new Promise<{ kind: "drain-deadline" }>((resolvePromise) => {
            rootDrainTimer = setTimeout(
              () => resolvePromise({ kind: "drain-deadline" }),
              PI_RPC_ROOT_EXIT_DRAIN_MS,
            );
          }),
        ]).finally(() => clearTimeout(rootDrainTimer));
        if (drained.kind === "closed") {
          shutdown = drained;
          exit = drained.exit;
          exitObserved = true;
          if (rpc.closeCleanupUncertainStatus) {
            cleanupFailure = "Pi RPC cleanup uncertain: the child close notification followed local stdio destruction and does not confirm owned descendant cleanup.";
          }
        } else {
          if (!timedOut && !aborted && !interruptedByControl) {
            protocolFailure ??= "Pi RPC root exited before child stdio closed; terminal cleanup is required.";
          }
          rpc.terminate();
          const close = await rpc.waitForCloseBounded(PI_EXECUTOR_TERMINAL_CLEANUP_MS);
          exit = { code: close.code, signal: close.signal };
          exitObserved = close.exitObserved;
          if (!close.closeObserved) {
            cleanupFailure = `Pi RPC cleanup uncertain: child close was not observed within ${PI_EXECUTOR_TERMINAL_CLEANUP_MS}ms; the owned root or descendants may remain live.`;
          }
        }
      }
      if (shutdown.kind === "deadline") {
        rpc.terminate();
        const close = await rpc.waitForCloseBounded(PI_EXECUTOR_TERMINAL_CLEANUP_MS);
        exit = { code: close.code, signal: close.signal };
        exitObserved = close.exitObserved;
        if (!close.closeObserved) {
          cleanupFailure = `Pi RPC cleanup uncertain: child close was not observed within ${PI_EXECUTOR_TERMINAL_CLEANUP_MS}ms; the owned root or descendants may remain live.`;
        }
      }
    }
    if (!aborted && !interruptedByControl && !timedOut && (exit.signal || (exit.code !== null && exit.code !== 0))) {
      protocolFailure ??= `Pi executor process terminated unexpectedly (${exit.signal ?? exit.code}).`;
    }
    // A latched transport failure (for example an EPIPE after the child
    // closed its stdin, or a broken output pipe losing terminal-cleanup
    // evidence) means the protocol exchange is untrustworthy even when the
    // child exits zero.
    protocolFailure ??= rpc.failure ? `Pi RPC transport failed: ${messageOf(rpc.failure)}.` : undefined;
    // Pi logs lifecycle hook failures rather than necessarily exiting nonzero.
    // A live-browser settlement receipt must not mask failed terminal cleanup.
    protocolFailure ??= rpc.shutdownFailure;
    await removePiSettlementReceipt(settlementBootstrap).catch(() => undefined);
    if (identity) {
      lifecycleCompletion ??= (async () => {
        try {
          await lifecycleStart;
        } catch {
          // Exit publication remains ordered after a failed start callback.
        }
        if (exitObserved) await request.onProcessExit?.({ ...identity, code: exit.code, signal: exit.signal });
      })();
      void lifecycleCompletion.catch(() => undefined);
      const lifecycleOutcome = await waitForPromiseBounded(lifecycleCompletion, PI_EXECUTOR_TERMINAL_CLEANUP_MS);
      if (lifecycleOutcome.kind === "timeout") {
        appendProtocolFailure(`Pi executor lifecycle callbacks did not settle within ${PI_EXECUTOR_TERMINAL_CLEANUP_MS}ms; process identity or exit persistence is unconfirmed.`);
      } else if (lifecycleOutcome.kind === "rejected") {
        appendProtocolFailure(`Pi executor lifecycle callback failed: ${messageOf(lifecycleOutcome.error)}`);
      }
      if (lifecycleStartError) {
        appendProtocolFailure(`Pi executor lifecycle start callback failed: ${messageOf(lifecycleStartError)}`);
      }
    }
    const terminationFailure = rpc.terminationError
      ? `Pi RPC termination attempts failed before child close: ${rpc.terminationError}`
      : undefined;
    if (protocolFailure || timedOut || aborted || interruptedByControl || rpc.terminationWasRequested) {
      const residual = backgroundReadiness.snapshot().running;
      if (residual.length > 0) {
        cleanupFailure = [
          cleanupFailure,
          `Pi RPC cleanup uncertain: tracked background process groups are still live or unconfirmed after executor shutdown: ${residual.map((job) => `${job.id} (${job.label}, pid ${job.pid}, group ${job.processGroupId})`).join(", ")}.`,
        ].filter(Boolean).join(" ");
      }
    }
    const failureMessage = [protocolFailure, cleanupFailure, terminationFailure].filter(Boolean).join(" ") || undefined;
    const processCleanupFailure = cleanupFailure
      ?? (terminationFailure && /descendants may remain live|owned cleanup is uncertain/.test(terminationFailure)
        ? terminationFailure
        : undefined);
    // Process artifacts retain the real direct-root exit status; the adapter's
    // returned code separately represents a failed protocol/cleanup outcome.
    const output = rpc.output(exit.code, timedOut, aborted || interruptedByControl);
    activity.finish();
    const streamed = extractor.finish();
    const extracted = streamed.text.trim() ? streamed : extractReviewTextFromPiJsonl(output.stdout);
    const text = processCleanupFailure ? "" : finalText.trim() || extracted.text;
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      usage: extracted.usage,
      sessionId,
      adapter: this.kind,
    });
    return {
      text,
      session: { adapter: this.kind, id: sessionId },
      usage: extracted.usage,
      ...artifacts,
      code: failureMessage ? 1 : output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
      lifecycle: extracted.lifecycle,
      failure: processCleanupFailure
        ? { category: "process", message: failureMessage! }
        : protocolFailure
          ? { category: "protocol", message: failureMessage! }
        : terminationFailure
          ? { category: "process", message: terminationFailure }
        : interruptedByControl
          ? { category: "interruption", message: "Pi RPC turn was interrupted." }
        : extracted.lifecycle.compaction.status === "in_progress"
        ? { category: "interruption", message: "Executor process ended while context compaction was in progress." }
        : extracted.lifecycle.compaction.status === "failed" || extracted.lifecycle.compaction.status === "aborted"
          ? { category: "compaction", message: extracted.lifecycle.compaction.error ?? "Context compaction did not complete." }
          : extracted.terminalError
            ? { category: "provider", message: extracted.terminalError }
          : undefined,
    };
  }
}

export class PiRpc {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private settledWaiters: Array<{ after: number; resolve: () => void; reject: (error: Error) => void }> = [];
  private settledCount = 0;
  // The first failure of any child pipe is latched here. A broken transport
  // cannot carry further protocol traffic, and the failure must survive even
  // when it arrives with no request in flight (after the final response,
  // during shutdown, while awaiting settlement): consulting this latch before
  // reporting success keeps a later zero exit from masking the broken
  // transport as successful execution.
  private transportFailure?: Error;
  private exitStatus?: { code: number | null; signal: NodeJS.Signals | null };
  private closeStatus?: { code: number | null; signal: NodeJS.Signals | null };
  private closeCleanupUncertain = false;
  private forceKillTimer: NodeJS.Timeout | undefined;
  private terminationRequested = false;
  private terminationFailures = new Map<NodeJS.Signals, string>();
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly rootExitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stdout = new BoundedTextAccumulator(100 * MEBIBYTE);
  private readonly stderr = new BoundedTextAccumulator(16 * MEBIBYTE);

  constructor(
    private readonly proc: ChildProcess,
    private readonly backgroundReadiness: BackgroundProcessReadiness,
    private readonly onJsonl: (chunk: string) => void,
    /** #204: translate a raw spawn ENOENT of the POSIX default-pi pass-through into the actionable missing-CLI diagnostic. */
    private readonly translateSpawnError?: (error: Error) => Error,
    private readonly onToolObservation?: ExecutorRequest["onToolObservation"],
  ) {
    proc.stdout?.on("data", (value: Buffer) => this.consume(value.toString("utf8")));
    proc.stderr?.on("data", (value: Buffer) => { this.stderr.append(value.toString("utf8")); });
    // A child that dies (or closes its pipe read side) while the parent's side
    // of the stream still reports writable emits an asynchronous EPIPE (or
    // similar) stream error. Without a listener Node raises it as an uncaught
    // exception, which would crash the parent before this adapter can settle
    // the child's termination as a truthful protocol failure. Every child-pipe
    // error is therefore latched as a transport failure: in-flight requests
    // and settlement waiters fail through the existing protocol path, future
    // protocol operations reject immediately without writing, and the latch is
    // consulted before any exit can be reported as success. Output-pipe errors
    // additionally mean captured terminal-cleanup evidence is incomplete, so
    // they fail closed through the same latch instead of being discarded.
    proc.stdin?.on("error", (error) => this.failTransport(error));
    proc.stdout?.on("error", (error) => this.failTransport(error));
    proc.stderr?.on("error", (error) => this.failTransport(error));
    const rejectPending = (error: Error): void => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const waiter of this.settledWaiters) waiter.reject(error);
      this.settledWaiters = [];
    };
    this.rootExitPromise = new Promise((resolvePromise) => {
      const observeRootExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exitStatus = { code, signal };
        rejectPending(new Error(`Pi RPC root exited before protocol completion (${code ?? signal ?? "unknown"}).`));
        resolvePromise({ code, signal });
      };
      if (typeof proc.exitCode === "number" || proc.signalCode !== null) {
        observeRootExit(proc.exitCode, proc.signalCode);
      } else {
        proc.once("exit", observeRootExit);
      }
    });
    this.exitPromise = new Promise((resolvePromise) => {
      proc.once("close", (code, signal) => {
        if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
        this.forceKillTimer = undefined;
        this.closeStatus = { code, signal };
        this.exitStatus ??= { code, signal };
        rejectPending(new Error(`Pi RPC exited before protocol completion (${code ?? signal ?? "unknown"}).`));
        resolvePromise({ code, signal });
      });
      proc.once("error", (error) => this.failTransport(this.translateSpawnError ? this.translateSpawnError(error) : error));
    });
  }

  /** The first child-pipe failure, if any; once latched the transport is unusable. */
  get failure(): Error | undefined {
    return this.transportFailure;
  }

  private failTransport(error: unknown): void {
    const transportError = error instanceof Error ? error : new Error(String(error));
    if (!this.transportFailure) this.transportFailure = transportError;
    for (const pending of this.pending.values()) pending.reject(transportError);
    this.pending.clear();
    for (const waiter of this.settledWaiters) waiter.reject(transportError);
    this.settledWaiters = [];
  }

  request(type: string, fields: Record<string, unknown>, explicitId?: string): Promise<Record<string, unknown>> {
    const id = explicitId ?? `review-gate-${this.nextId++}`;
    if (this.exitStatus && !this.proc.stdin?.writable) {
      // Preserve the existing transport diagnostic when ownership publication
      // completes after a normal close has already made stdin unwritable.
      return Promise.reject(new Error("Pi RPC stdin is not writable."));
    }
    if (this.exitStatus) {
      return Promise.reject(new Error(`Pi RPC root exited before protocol completion (${this.exitStatus.code ?? this.exitStatus.signal ?? "unknown"}).`));
    }
    if (this.transportFailure) {
      // The transport is already broken; never write to it again.
      return Promise.reject(new Error(`Pi RPC transport failed: ${messageOf(this.transportFailure)}`));
    }
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      if (!this.proc.stdin?.writable) {
        const error = new Error("Pi RPC stdin is not writable.");
        this.pending.delete(id);
        this.failTransport(error);
        reject(error);
        return;
      }
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      } catch (error) {
        // A synchronous write failure means the transport is broken; latch it
        // so the outcome stays a truthful protocol failure. Asynchronous EPIPE
        // is contained by the same latch via the stdin error handler.
        const writeError = error instanceof Error ? error : new Error(String(error));
        this.pending.delete(id);
        this.failTransport(writeError);
        reject(writeError);
      }
    });
  }

  shutdownFailure?: string;

  get terminationError(): string | undefined {
    return this.terminationFailures.size > 0 ? [...this.terminationFailures.values()].join("\n") : undefined;
  }

  get closeCleanupUncertainStatus(): boolean {
    return this.closeCleanupUncertain;
  }

  get terminationWasRequested(): boolean {
    return this.terminationRequested;
  }

  get settledGeneration(): number {
    return this.settledCount;
  }

  waitForSettled(after = this.settledCount): Promise<void> {
    if (this.settledCount > after) return Promise.resolve();
    if (this.transportFailure) return Promise.reject(this.transportFailure);
    if (this.exitStatus) {
      // The child is already gone; a settlement that never arrived cannot
      // arrive, so fail now instead of waiting out the executor timeout.
      return Promise.reject(new Error(`Pi RPC exited before protocol completion (${this.exitStatus.code ?? this.exitStatus.signal ?? "unknown"}).`));
    }
    return new Promise((resolvePromise, reject) => this.settledWaiters.push({ after, resolve: resolvePromise, reject }));
  }

  terminate(): void {
    if (this.terminationRequested) return;
    // Ordinary close already completed this lifecycle. Do not signal a
    // potentially recycled group ID. Locally induced close is not evidence
    // of cleanup and must retain the existing terminal signaling path.
    if (this.closeStatus && !this.closeCleanupUncertain) return;
    this.terminationRequested = true;
    const termination = new Error("Pi RPC process termination was requested.");
    for (const pending of this.pending.values()) pending.reject(termination);
    this.pending.clear();
    for (const waiter of this.settledWaiters) waiter.reject(termination);
    this.settledWaiters = [];
    // On POSIX, the owned process group remains signalable after its leader
    // exits. Windows deliberately refuses to taskkill a dead/reusable root PID.
    const attemptTermination = (signal: NodeJS.Signals): void => {
      try {
        this.recordTerminationFailure(terminateProcessTree(this.proc, signal));
      } catch (error) {
        this.recordTerminationFailure(`${signal} termination failed (${messageOf(error)}); owned cleanup is uncertain`);
      }
    };
    attemptTermination("SIGTERM");
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = undefined;
      attemptTermination("SIGKILL");
    }, 2_000);
    this.forceKillTimer.unref?.();
  }

  closeInput(): void {
    if (!this.proc.stdin?.writable) return;
    try {
      this.proc.stdin.end();
    } catch (error) {
      // Ending an already-broken transport must not crash the parent; latch
      // it so a later zero exit cannot be reported as success.
      this.failTransport(error);
    }
  }

  closed(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise;
  }

  rootExited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.rootExitPromise;
  }

  waitForCloseBounded(timeoutMs: number): Promise<BoundedProcessClose> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative safe integer");
    }
    if (this.closeStatus) {
      return Promise.resolve({
        ...this.closeStatus,
        closeObserved: !this.closeCleanupUncertain,
        exitObserved: true,
      });
    }
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (outcome: BoundedProcessClose): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(outcome);
      };
      const timer = setTimeout(() => {
        const status = this.exitStatus ?? (typeof this.proc.exitCode === "number" || this.proc.signalCode !== null
          ? { code: this.proc.exitCode, signal: this.proc.signalCode }
          : { code: null, signal: null });
        this.closeCleanupUncertain = true;
        // Record uncertainty before our own stream destruction can emit close.
        finish({ ...status, closeObserved: false, exitObserved: this.exitStatus !== undefined });
        this.proc.stdin?.destroy();
        this.proc.stdout?.destroy();
        this.proc.stderr?.destroy();
        this.proc.unref();
      }, timeoutMs);
      void this.exitPromise.then((status) => finish({
        ...status,
        closeObserved: !this.closeCleanupUncertain,
        exitObserved: true,
      }));
    });
  }

  output(code: number | null, timedOut: boolean, aborted: boolean): ProcessRunResult {
    return {
      stdout: this.stdout.value,
      stderr: this.stderr.value,
      stdoutTruncated: this.stdout.truncated,
      stderrTruncated: this.stderr.truncated,
      stdoutBytes: this.stdout.bytes,
      stderrBytes: this.stderr.bytes,
      streamEvents: this.stdout.value.split("\n").filter(Boolean).length,
      toolCalls: 0,
      toolResultBytes: 0,
      compactions: 0,
      code,
      timedOut,
      aborted,
      terminationError: this.terminationError,
    };
  }

  private recordTerminationFailure(failure: string | undefined): void {
    if (!failure) return;
    const signal = failure.startsWith("SIGKILL ") ? "SIGKILL" : "SIGTERM";
    this.terminationFailures.set(signal, failure);
  }

  private consume(chunk: string): void {
    this.stdout.append(chunk);
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      this.onJsonl(`${raw}\n`);
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (event.type === "response" && typeof event.id === "string") {
        const pending = this.pending.get(event.id);
        if (!pending) continue;
        this.pending.delete(event.id);
        if (event.success === true) pending.resolve(event);
        else pending.reject(new Error(rpcError(event)));
      } else if (event.type === "extension_error" && event.event === "session_shutdown") {
        this.shutdownFailure = "Pi executor terminal session cleanup failed; completion cannot confirm resource cleanup.";
      } else if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
        this.backgroundReadiness.observeToolResult(event.toolName, event.result, event.isError === true);
        this.onToolObservation?.({
          stage: "end",
          toolName: event.toolName,
          ...(isRecord(event.args) ? { toolInput: event.args } : {}),
          result: event.result,
          isError: event.isError === true,
          ...(typeof event.toolCallId === "string" ? { observationId: event.toolCallId } : {}),
        });
      } else if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        this.onToolObservation?.({
          stage: "start",
          toolName: event.toolName,
          ...(isRecord(event.args) ? { toolInput: event.args } : {}),
          ...(typeof event.toolCallId === "string" ? { observationId: event.toolCallId } : {}),
        });
      } else if (event.type === "agent_end") {
        this.settledCount += 1;
        const ready = this.settledWaiters.filter((waiter) => waiter.after < this.settledCount);
        this.settledWaiters = this.settledWaiters.filter((waiter) => waiter.after >= this.settledCount);
        for (const waiter of ready) waiter.resolve();
      }
    }
  }
}

async function compactInterruptedSession(input: {
  command: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  sessionId: string;
  sessionDir: string;
  cwd: string;
  args: string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProcessStart?: ExecutorRequest["onProcessStart"];
  onProcessExit?: ExecutorRequest["onProcessExit"];
}): Promise<void> {
  if (input.signal?.aborted) throw abortError(input.signal);
  const args = [
    "--model", input.model,
    "--mode", "rpc",
    "--thinking", input.thinkingLevel,
    "--session-id", input.sessionId,
    "--session-dir", input.sessionDir,
    ...input.args,
  ];

  await new Promise<void>((resolve, reject) => {
    // #204: the compaction recovery child uses the same alias-independent
    // resolution as the main RPC executor launch.
    const childEnv = { ...input.env, PWD: input.cwd };
    const invocation = resolvePiChildSpawn(input.command, args, childEnv);
    if (!invocation.ok) {
      reject(new Error(invocation.error));
      return;
    }
    const proc = spawn(invocation.file, invocation.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const processIdentity = proc.pid === undefined
      ? undefined
      : { pid: proc.pid, processGroupId: process.platform === "win32" ? undefined : proc.pid };
    let lifecycleStartInvoked = false;
    let lifecycleStart: Promise<void> | undefined;
    let buffer = "";
    let stderr = "";
    let settled = false;
    let finishing = false;
    let completionError: Error | undefined;
    let lifecycleCompletion: Promise<void> | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let cleanupDeadlineTimer: NodeJS.Timeout | undefined;
    let rootExitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const terminationErrors: string[] = [];
    let phase: "state" | "compact" = "state";

    const stop = (signal: NodeJS.Signals) => {
      // Preserve POSIX process-group signaling after leader exit. Windows
      // cleanup fails closed rather than taskkilling a dead/reusable root PID.
      try {
        const failure = terminateProcessTree(proc, signal);
        if (failure) terminationErrors.push(failure);
      } catch (error) {
        terminationErrors.push(`${signal} termination failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const requestFinish = (error?: Error) => {
      if (finishing || settled) return;
      finishing = true;
      completionError = error;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      stop("SIGTERM");
      forceKillTimer = setTimeout(() => stop("SIGKILL"), 2_000);
      forceKillTimer.unref?.();
      cleanupDeadlineTimer = setTimeout(() => {
        if (settled) return;
        const status = rootExitStatus ?? (typeof proc.exitCode === "number" || proc.signalCode !== null
          ? { code: proc.exitCode, signal: proc.signalCode }
          : { code: null, signal: null });
        const exitObserved = rootExitStatus !== undefined || typeof proc.exitCode === "number" || proc.signalCode !== null;
        terminationErrors.push(
          "cleanup uncertain: child close was not observed before the teardown deadline; the owned root or descendants may remain live",
        );
        // Settle as uncertain before local pipe destruction can emit close;
        // releasing those endpoints does not prove descendant termination.
        const cleanup = finishAfterClose(status.code, status.signal, exitObserved);
        proc.stdin.destroy();
        proc.stdout.destroy();
        proc.stderr.destroy();
        proc.unref();
        void cleanup;
      }, 2_000 + PROCESS_TREE_CLEANUP_GRACE_MS);
    };
    const finishAfterClose = async (
      code: number | null,
      signal: NodeJS.Signals | null,
      exitObserved = true,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      input.signal?.removeEventListener("abort", onAbort);
      try {
        lifecycleCompletion ??= (async () => {
          let startError: unknown;
          try {
            await lifecycleStart;
          } catch (error) {
            startError = error instanceof Error ? error : new Error(messageOf(error));
          }
          if (exitObserved && lifecycleStartInvoked && processIdentity) {
            await input.onProcessExit?.({ ...processIdentity, code, signal });
          }
          if (startError) throw startError;
        })();
        void lifecycleCompletion.catch(() => undefined);
        const lifecycleOutcome = await waitForPromiseBounded(
          lifecycleCompletion,
          2_000 + PROCESS_TREE_CLEANUP_GRACE_MS,
        );
        const terminationDetail = terminationErrors.length > 0
          ? ` Termination attempts failed before child close: ${terminationErrors.join("; ")}`
          : "";
        if (lifecycleOutcome.kind === "timeout") {
          const completionDetail = completionError?.message ?? "Executor compaction cleanup failed.";
          reject(new Error(
            `${completionDetail} Lifecycle callbacks did not settle within ${2_000 + PROCESS_TREE_CLEANUP_GRACE_MS}ms; process identity or exit persistence is unconfirmed.${terminationDetail}`,
          ));
          return;
        }
        if (lifecycleOutcome.kind === "rejected") {
          const completionDetail = completionError && messageOf(completionError) !== messageOf(lifecycleOutcome.error)
            ? `${completionError.message} `
            : "";
          reject(new Error(`${completionDetail}Lifecycle callback failed: ${messageOf(lifecycleOutcome.error)}${terminationDetail}`));
          return;
        }
        if (completionError || terminationErrors.length > 0) {
          const detail = terminationDetail;
          reject(new Error(`${completionError?.message ?? "Executor compaction cleanup failed."}${detail}`));
        } else resolve();
      } catch (lifecycleError) {
        reject(new Error(`Executor lifecycle callback failed: ${messageOf(lifecycleError)}`));
      }
    };
    const fail = (message: string) => requestFinish(new Error(`${message}${stderr.trim() ? ` Stderr: ${stderr.trim().slice(-2000)}` : ""}`));
    const send = (value: object) => {
      if (!proc.stdin.writable) return fail("Executor RPC stdin closed during compaction recovery.");
      proc.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const deadline = Date.now() + input.timeoutMs;
    const timer = setTimeout(() => fail(`Executor compaction recovery timed out after ${input.timeoutMs}ms.`), input.timeoutMs);
    const onAbort = () => requestFinish(abortError(input.signal));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    // Only the POSIX pass-through keeps the bare `pi` name; a missing default
    // Pi CLI there surfaces as an actionable diagnostic instead of raw ENOENT.
    const isDefaultPiPassThrough = invocation.file === DEFAULT_PI_COMMAND;
    proc.on("error", (error) => requestFinish(translateDefaultPiSpawnError(error, isDefaultPiPassThrough)));
    proc.stdin.on("error", (error) => requestFinish(error));
    // Output-pipe errors would otherwise surface as uncaught stream
    // exceptions; route them through the same fail-closed finish path.
    proc.stdout.on("error", (error) => requestFinish(error));
    proc.stderr.on("error", (error) => requestFinish(error));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type !== "response") continue;
        if (phase === "state" && event.id === "review-gate-state") {
          if (event.success !== true) return fail(`Could not reopen executor session: ${rpcError(event)}`);
          const data = event.data as Record<string, unknown> | undefined;
          if (data?.sessionId !== input.sessionId) {
            return fail(`Executor RPC reopened session ${String(data?.sessionId)}, expected ${input.sessionId}.`);
          }
          phase = "compact";
          send({ id: "review-gate-compact", type: "compact", customInstructions: recoveryCompactionInstructions });
        } else if (phase === "compact" && event.id === "review-gate-compact") {
          if (event.success === true) return requestFinish();
          const message = rpcError(event);
          // These responses prove the reopened branch is already compacted or
          // below the compaction floor; either is safe to resume.
          if (/already compacted|nothing to compact/i.test(message)) return requestFinish();
          return fail(`Executor context compaction failed: ${message}`);
        }
      }
    });
    proc.once("exit", (code, signal) => { rootExitStatus = { code, signal }; });
    proc.on("close", (code, signal) => {
      if (!finishing) completionError = new Error(`Executor RPC exited with status ${code} during compaction recovery.`);
      void finishAfterClose(code, signal, rootExitStatus !== undefined);
    });
    lifecycleStart = (async () => {
      if (!processIdentity) throw new Error(`Could not determine pid for ${input.command}.`);
      lifecycleStartInvoked = true;
      await input.onProcessStart?.(processIdentity);
      if (Date.now() >= deadline && !finishing) {
        fail(`Executor compaction recovery timed out after ${input.timeoutMs}ms.`);
        return;
      }
      if (!settled && !finishing) send({ id: "review-gate-state", type: "get_state" });
    })();
    void lifecycleStart.catch((error) => requestFinish(error instanceof Error ? error : new Error(messageOf(error))));
  });
}

const recoveryCompactionInstructions = [
  "Preserve the task objective, completed investigation, edits, validation results, and exact remaining work.",
  "This session will be resumed automatically after compaction.",
].join(" ");

const backgroundCompletionPrompt = [
  "ShellStart work that previously blocked this executor reached an idle transition.",
  "Re-check ShellList because a newer job may have started after the transition was observed.",
  "Inspect completed results and the workspace, address any failure, and finish the original task when current background readiness permits.",
  "Do not claim success from process exit alone; verify the requested outcome before responding.",
].join(" ");

async function waitForBackgroundProcesses(
  readiness: BackgroundProcessReadiness,
  signal: AbortSignal | undefined,
  rootExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  shouldStop: () => boolean,
): Promise<void> {
  const rootExitWait = rootExit.then((status) => ({ kind: "root-exit" as const, status }));
  while (readiness.snapshot().running.length > 0) {
    if (signal?.aborted) throw abortError(signal);
    if (shouldStop()) return;
    const outcome = await Promise.race([
      new Promise<{ kind: "poll" }>((resolvePromise) => setTimeout(() => resolvePromise({ kind: "poll" }), 100)),
      rootExitWait,
    ]);
    if (outcome.kind === "root-exit") {
      const { code, signal: exitSignal } = outcome.status;
      throw new Error(`Pi RPC root exited while waiting for background process readiness (${code ?? exitSignal ?? "unknown"}).`);
    }
  }
}

function rpcState(response: Record<string, unknown>): { isStreaming: boolean; pendingMessageCount: number } {
  const data = isRecord(response.data) ? response.data : {};
  return {
    isStreaming: data.isStreaming === true,
    pendingMessageCount: typeof data.pendingMessageCount === "number" ? data.pendingMessageCount : 0,
  };
}

function rpcError(event: Record<string, unknown>): string {
  if (typeof event.error === "string") return event.error;
  const error = event.error as Record<string, unknown> | undefined;
  if (typeof error?.message === "string") return error.message;
  return "unknown RPC error";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Executor recovery was cancelled.");
}

function childArgs(args: readonly string[], allowedTools: readonly string[]): string[] {
  return [
    ...args,
    "--extension", resolve(__dirname, "../../index.js"),
    "--tools", allowedTools.join(","),
  ];
}

function executorEnv(toolCatalog: ExecutorToolCatalog, settlement?: PiSettlementBootstrap): NodeJS.ProcessEnv {
  const next = { ...process.env };
  // The child must load the review-gate extension in its executor role so the
  // already-designed registration of web tools and background shell runs.
  // PI_REVIEW_GATE_DISABLED would short-circuit activate() before the
  // executor-role branch, so it must never reach the child, even when the
  // parent process itself is disabled. PI_EXTRA_EXTENSIONS is dropped so only
  // the explicitly passed --extension loads in the child.
  delete next.PI_REVIEW_GATE_DISABLED;
  delete next.PI_EXTRA_EXTENSIONS;
  delete next[PI_SETTLEMENT_SECRET_ENV];
  delete next[PI_SETTLEMENT_PATH_ENV];
  delete next[PI_SETTLEMENT_SESSION_ENV];
  delete next[PI_SETTLEMENT_CHILD_ENV];
  for (const suffix of ["SECRET", "PATH", "SESSION", "CHILD"]) delete next[`PI_REVIEW_GATE_QUIESCENCE_${suffix}`];
  next.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
  next[EXECUTOR_TOOL_CATALOG_ENV] = JSON.stringify(toolCatalog);
  if (settlement) Object.assign(next, piSettlementEnvironment(settlement));
  return next;
}
