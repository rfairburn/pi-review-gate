import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  Options as ClaudeOptions,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeExecutorConfig } from "../../config";
import {
  PROCESS_TREE_CLEANUP_GRACE_MS,
  reviewerEnv,
  terminateProcessTree,
  waitForPromiseBounded,
  type ProcessRunResult,
} from "../../adapters/process";
import { BoundedTextAccumulator, MEBIBYTE } from "../../jsonl";
import { parseClaudeUsage } from "../../usage";
import { ClaudeStreamJsonParser, ClaudeStreamActivityExtractor } from "../progress";
import { writeExecutorArtifacts } from "../artifacts";
import type { ExecutorAdapter, ExecutorInteractionAcknowledgement, ExecutorRequest, ExecutorTurn } from "../types";
import { createExecutorToolCatalog, rejectPreCutoverRequestFields } from "../tool-catalog";

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;

// Terminal results that miss the current completion target are buffered
// briefly so a failed steering attempt can restore tracking for the original
// turn even when its result arrived while the native interrupt request was
// still pending (issue #63).
const UNKEYED_RESULT_KEY = "__unkeyed__";
const MAX_BUFFERED_RESULTS = 8;

// Explicit interruption is terminal for the run and must not wait on a
// superseded steering target's result or the executor timeout (#310): the
// native acknowledgement and the interrupted turn's terminal result share
// this bound before the session is shut down regardless.
const CLAUDE_INTERRUPT_SETTLE_MS = 5_000;

const CLAUDE_RESEARCH_TOOL_MAP = new Map([
  ["read", "Read"],
  ["grep", "Grep"],
  ["glob", "Glob"],
  ["find", "Glob"],
  ["ls", "Glob"],
  ["WebFetch", "WebFetch"],
  ["WebSearch", "WebSearch"],
]);

const CLAUDE_RESEARCH_POLICY_FLAGS = [
  "--add-dir",
  "--agent",
  "--agents",
  "--allow-dangerously-skip-permissions",
  "--allowed-tools",
  "--allowedTools",
  "--chrome",
  "--dangerously-skip-permissions",
  "--disallowed-tools",
  "--disallowedTools",
  "--mcp-config",
  "--no-chrome",
  "--permission-mode",
  "--plugin-dir",
  "--setting-sources",
  "--settings",
  "--strict-mcp-config",
  "--tools",
] as const;

export interface ClaudeExecutorDependencies {
  loadSdk?: () => Promise<{ query: typeof import("@anthropic-ai/claude-agent-sdk")["query"] }>;
  /** Bound for explicit-interrupt acknowledgement plus terminal result (#310). */
  interruptSettleMs?: number;
  /** Per-signal grace for verifying owned process shutdown after explicit interruption (#310). */
  processCleanupGraceMs?: number;
}

/** Claude executor using the official Agent SDK streaming control surface. */
export class ClaudeExecutorAdapter implements ExecutorAdapter {
  readonly kind = "claude-cli";
  readonly toolEventObservability = {
    mode: "structured",
    description: "Claude Agent SDK assistant tool_use and user tool_result blocks are forwarded; delivery may race the child mutation, so prior state is not verified.",
  } as const;
  readonly model?: string;

  constructor(
    private readonly config: ClaudeExecutorConfig,
    private readonly dependencies: ClaudeExecutorDependencies = {},
  ) {
    this.model = config.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    rejectPreCutoverRequestFields(request);
    const readOnly = request.workspaceAccess === "read-only";
    const toolCatalog = request.executorToolCatalog
      ? createExecutorToolCatalog(
          request.executorToolCatalog.allowedToolCatalog,
          request.executorToolCatalog.initialActiveTools,
        )
      : undefined;
    // Claude has no adapter-specific deferred activation channel. Until it
    // does, preserve the full role-authorized research catalog.
    const researchTools = readOnly ? claudeResearchTools(toolCatalog?.allowedToolCatalog) : [];
    if (readOnly) assertClaudeResearchArgsSafe(this.config.args);
    const requestedSessionId = request.session?.id ?? randomUUID();
    const initialUuid = randomUUID();
    const input = new AsyncMessageQueue();
    const stdout = new BoundedTextAccumulator(100 * MEBIBYTE);
    const stderr = new BoundedTextAccumulator(16 * MEBIBYTE);
    const parser = new ClaudeStreamJsonParser();
    const activity = new ClaudeStreamActivityExtractor(
      (message) => request.onUpdate?.(message),
      { includeModelUpdates: true },
    );
    let query: Query | undefined;
    let child: ChildProcess | undefined;
    let processIdentity: { pid: number; processGroupId?: number } | undefined;
    let lifecycleStart: Promise<void> = Promise.resolve();
    let lifecycleExit: Promise<void> = Promise.resolve();
    let targetUuid = initialUuid;
    let finalResult: SDKResultMessage | undefined;
    let effectiveSessionId = requestedSessionId;
    let protocolFailure: string | undefined;
    let steerDeliveryFailure: string | undefined;
    let sessionClosed = false;
    const pendingSteerDeliveries = new Set<Promise<void>>();
    let timedOut = false;
    let aborted = false;
    let interruptedByControl = false;
    let finished = false;
    // The single owned-process shutdown of an explicit interruption (#310):
    // started at the interruption's settlement boundary, awaited by both the
    // interrupt acknowledgement and run cleanup. Resolves with a diagnostic
    // when shutdown could not be verified, undefined otherwise.
    let ownedShutdown: Promise<string | undefined> | undefined;
    let terminationFailure: string | undefined;
    // The exit report delivered through onProcessExit, the canonical owned
    // lifecycle record. After explicit interruption it is withheld until the
    // whole owned group is verified gone and never fabricated otherwise.
    let exitReported: Promise<void> | undefined;

    const sdk = await (this.dependencies.loadSdk?.() ?? dynamicImport("@anthropic-ai/claude-agent-sdk"));
    const abortController = new AbortController();
    const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
      // The SDK-generated policy flags must be final for read-only turns so
      // arbitrary external-agent arguments cannot widen the research profile.
      const args = readOnly
        ? [...(this.config.args ?? []), ...options.args]
        : [...options.args, ...(this.config.args ?? [])];
      child = spawn(options.command, args, {
        cwd: options.cwd,
        env: reviewerEnv({ ...options.env, ...this.config.env }),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      });
      if (child.pid !== undefined) {
        processIdentity = {
          pid: child.pid,
          processGroupId: process.platform === "win32" ? undefined : child.pid,
        };
        lifecycleStart = Promise.resolve(request.onProcessStart?.(processIdentity));
      }
      lifecycleExit = new Promise((resolvePromise) => {
        child!.once("exit", (code, signal) => {
          if (interruptedByControl) {
            resolvePromise();
            return;
          }
          exitReported = Promise.resolve(processIdentity && request.onProcessExit?.({ ...processIdentity, code, signal }));
          void exitReported.finally(resolvePromise);
        });
        child!.once("error", () => resolvePromise());
      });
      return child as unknown as SpawnedProcess;
    };

    const options: ClaudeOptions = {
      cwd: request.cwd,
      model: this.config.model,
      permissionMode: readOnly ? "dontAsk" : "auto",
      tools: readOnly ? researchTools : { type: "preset", preset: "claude_code" },
      ...(readOnly ? {
        allowedTools: researchTools,
        settingSources: [],
        skills: [] as string[],
        plugins: [],
        mcpServers: {},
        strictMcpConfig: true,
        canUseTool: async (toolName: string) => researchTools.includes(toolName)
          ? { behavior: "allow" as const }
          : {
              behavior: "deny" as const,
              message: `Tool ${toolName} is outside the read-only research profile.`,
              interrupt: false,
            },
      } : {}),
      includePartialMessages: true,
      persistSession: true,
      pathToClaudeCodeExecutable: this.config.command ?? "claude",
      env: reviewerEnv({ ...process.env, ...this.config.env }),
      abortController,
      spawnClaudeCodeProcess,
      stderr: (chunk) => stderr.append(chunk),
      ...(request.session ? { resume: requestedSessionId } : { sessionId: requestedSessionId }),
    };

    query = sdk.query({ prompt: input, options });
    const activeQuery = query;
    const unmatchedResults = new Map<string, SDKResultMessage>();
    const toolUses = new Map<string, { toolName: string; toolInput: Record<string, unknown> }>();
    let settleNow: (() => void) | undefined;
    const resultPromise = new Promise<void>((resolveSettlement) => {
      settleNow = resolveSettlement;
      void (async () => {
        try {
          await consumeMessages(activeQuery, (message, line) => {
            if (finished) return true;
            stdout.append(line);
            parser.push(line);
            activity.push(line);
            forwardClaudeToolObservations(message, request.onToolObservation, toolUses);
            if (typeof message.session_id === "string") effectiveSessionId = message.session_id;
            if (message.type === "result") {
              const resultUuid = "user_message_uuid" in message && typeof message.user_message_uuid === "string"
                ? message.user_message_uuid
                : undefined;
              // After an explicit interrupt any terminal result settles the
              // run: deferred steering may have retargeted completion, and
              // the interrupted turn's result can be original-tagged or
              // untagged (#310). Close at once so queued work cannot start.
              if (interruptedByControl || resultUuid === targetUuid || resultUuid === undefined && targetUuid === initialUuid) {
                finalResult = message;
                finished = true;
                if (interruptedByControl) beginControlShutdown();
                return true;
              }
              const key = resultUuid ?? UNKEYED_RESULT_KEY;
              unmatchedResults.set(key, message);
              if (unmatchedResults.size > MAX_BUFFERED_RESULTS) {
                const oldest = unmatchedResults.keys().next().value;
                if (oldest !== undefined) unmatchedResults.delete(oldest);
              }
            }
            return false;
          });
        } catch (error) {
          // Preserve protocol-error reporting when the SDK stream itself
          // fails: record it under the same timeout/abort policy as the main
          // flow instead of leaving an unhandled rejection behind. Only
          // disposal errors after an explicit interruption closed the
          // session are suppressed; earlier failures keep their diagnostic
          // even while the interrupt is pending (#310).
          if (!timedOut && !aborted && !(interruptedByControl && sessionClosed)) protocolFailure = messageOf(error);
        } finally {
          resolveSettlement();
        }
      })();
    });

    // Closing the SDK session is authoritative for steering delivery: once
    // it is closed, a steering acknowledgement must not claim delivery into
    // a session that can no longer consume input (issue #63).
    const closeQuerySession = () => {
      if (!sessionClosed) {
        sessionClosed = true;
        query?.close();
      }
    };
    const shutDownOwnedProcess = (): Promise<string | undefined> => ownedShutdown ??= (async () => {
      const failure = await terminateOwnedClaudeProcess(
        child,
        this.dependencies.processCleanupGraceMs ?? PROCESS_TREE_CLEANUP_GRACE_MS,
      );
      if (failure === undefined && processIdentity && child && exitReported === undefined) {
        exitReported = Promise.resolve(request.onProcessExit?.({
          ...processIdentity,
          code: child.exitCode,
          signal: child.signalCode,
        }));
      }
      await exitReported;
      return failure;
    })();
    // Explicit interruption is terminal: at its settlement boundary stop all
    // input, close the session, and start owned termination at once rather
    // than after SDK iterator disposal, which grants the CLI a stdin-EOF
    // grace in which surviving queued work could still run (#310). Closing
    // input also rejects any steering the SDK never pulled.
    const beginControlShutdown = (): void => {
      finished = true;
      input.close();
      closeQuerySession();
      abortController.abort();
      void shutDownOwnedProcess();
      settleNow?.();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void query?.interrupt().catch(() => undefined).finally(() => closeQuerySession());
    }, this.config.timeoutMs ?? 1_800_000);
    timeout.unref?.();
    const onAbort = () => {
      aborted = true;
      if (interruptedByControl) return;
      void query?.interrupt().catch(() => undefined).finally(() => closeQuerySession());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await query.initializationResult();
      await lifecycleStart;
      // Enqueue the task prompt before publishing live control so steering
      // can never be delivered ahead of the prompt it steers (issue #63).
      await input.enqueue(userMessage(request.prompt, initialUuid, "now"));
      // #93: the SDK transport accepted the enqueue — the actual delivery
      // boundary for this prompt (session initialization already succeeded).
      request.onPromptDelivery?.({ prompt: request.prompt });
      request.onUpdate?.("claude streaming session initialized with live steer and interrupt controls");
      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: "Claude Agent SDK streaming Query",
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId, options) => {
          if (interruptedByControl) {
            return { status: "blocked", message: "Claude turn was explicitly interrupted; steering was not delivered." };
          }
          if (finished) return { status: "blocked", message: "Claude turn already reached a terminal result." };
          const messageUuid = randomUUID();
          const previousTargetUuid = targetUuid;
          // Retarget before interrupting so the interrupted turn's result
          // cannot match and end this run; the steered message's result is
          // the terminal one (issue #63).
          targetUuid = messageUuid;
          let interruptionVerified = false;
          let interruptionSurvived = false;
          let deliverySettled: (() => void) | undefined;
          let deliveryPromise: Promise<void> | undefined;
          try {
            if (options?.interrupt) {
              // Record the owned control event before issuing it so a result
              // that races the acknowledgement is still attributed to this
              // turn; it stays unverified until the native interrupt resolves,
              // so a racing or rejected interruption cannot relabel a genuine
              // failure (#305).
              activity.notePendingInterruption(previousTargetUuid);
              const receipt = await query!.interrupt();
              interruptionVerified = true;
              // The receipt's still_queued uuids survive the abort and will
              // run: a surviving target was never interrupted, so withdraw
              // its unproven authority instead of granting it. Older CLIs
              // provide no survivor receipt; their acknowledgement authorizes
              // classification only when the result itself has an explicit
              // abort terminal reason (#305).
              interruptionSurvived = receipt !== undefined && receipt.still_queued.includes(previousTargetUuid);
              if (interruptionSurvived) {
                activity.clearInterruption(previousTargetUuid);
              } else {
                activity.verifyInterruption(previousTargetUuid, receipt !== undefined);
              }
              // Track the delivery of a verified interruption so run
              // settlement can reflect a delivery that fails while shutdown
              // is in flight.
              deliveryPromise = new Promise<void>((resolveDelivery) => { deliverySettled = resolveDelivery; });
              pendingSteerDeliveries.add(deliveryPromise);
            }
            if (sessionClosed) throw new Error("Claude streaming session is closed.");
            await input.enqueue(userMessage(instruction, messageUuid, "now"));
            return {
              status: "acknowledged",
              message: options?.interrupt
                ? interruptionSurvived
                  ? `Claude Agent SDK delivered turn-interrupt steering to the same session (${instructionId}); the previous turn was still queued and survives the interrupt.`
                  : `Claude Agent SDK delivered turn-interrupt steering to the same session (${instructionId}); any in-flight turn was interrupted.`
                : `Claude Agent SDK accepted live steering (${instructionId}).`,
              turnId: messageUuid,
            };
          } catch (error) {
            const failure = messageOf(error);
            if (!interruptionVerified) {
              // The native interrupt was rejected (or delivery failed before
              // any interruption): the original turn was never verified as
              // interrupted, so restore its completion tracking — including a
              // terminal result that arrived while the request was pending —
              // instead of stranding this run on an undelivered UUID. A later
              // genuine failure of that turn must keep its failure label (#305).
              activity.clearInterruption(previousTargetUuid);
              targetUuid = previousTargetUuid;
              // An explicit interruption that already settled the run keeps
              // its terminal result (#310).
              const bufferedKey = previousTargetUuid !== initialUuid || unmatchedResults.has(previousTargetUuid)
                ? previousTargetUuid
                : UNKEYED_RESULT_KEY;
              const buffered = finished ? undefined : unmatchedResults.get(bufferedKey);
              if (buffered !== undefined) {
                unmatchedResults.delete(bufferedKey);
                finalResult = buffered;
                finished = true;
                settleNow?.();
              }
            } else {
              // The interrupt succeeded but the replacement was never
              // delivered: settle with a concrete failure rather than waiting
              // for a result whose message will never arrive. A surviving
              // target (receipt still_queued) was acknowledged, not
              // interrupted (#305).
              steerDeliveryFailure = interruptionSurvived
                ? `Claude turn-interrupt steering was acknowledged, but the previous turn survived the interrupt and replacement delivery failed: ${failure}`
                : `Claude turn-interrupt steering verified the interruption, but replacement delivery failed: ${failure}`;
              finished = true;
              settleNow?.();
            }
            return { status: "failed", message: failure, turnId: messageUuid };
          } finally {
            deliverySettled?.();
            if (deliveryPromise !== undefined) pendingSteerDeliveries.delete(deliveryPromise);
          }
        },
        interrupt: async (): Promise<ExecutorInteractionAcknowledgement> => {
          if (sessionClosed) {
            return { status: "blocked", message: "Claude streaming session is already closed; there is no live turn to interrupt." };
          }
          interruptedByControl = true;
          const settleMs = this.dependencies.interruptSettleMs ?? CLAUDE_INTERRUPT_SETTLE_MS;
          const deadline = Date.now() + settleMs;
          const remaining = () => Math.max(0, deadline - Date.now());
          // Deferred steering retargets completion while the superseded turn
          // keeps running, so the interrupt may abort either. Record both
          // owned control events before issuing the interrupt so a result
          // that races the acknowledgement is still attributed; they stay
          // unverified until the native interrupt resolves, so a racing,
          // rejected, or unacknowledged interruption cannot relabel a
          // genuine failure (#305, #310).
          const interruptedUuids = targetUuid !== initialUuid
            && !unmatchedResults.has(initialUuid)
            && !unmatchedResults.has(UNKEYED_RESULT_KEY)
            ? [initialUuid, targetUuid]
            : [targetUuid];
          for (const uuid of interruptedUuids) activity.notePendingInterruption(uuid);
          const native = await waitForPromiseBounded(
            Promise.resolve().then(() => activeQuery.interrupt()),
            remaining(),
          );
          const details: string[] = [];
          let nativeFailure: string | undefined;
          let survivors = 0;
          if (native.kind === "fulfilled") {
            const receipt = native.value;
            // The receipt's still_queued uuids survive the abort and would
            // run: a surviving target was never interrupted, so withdraw its
            // unproven authority instead of granting it. Older CLIs provide
            // no survivor receipt; their acknowledgement authorizes
            // classification only when the result itself has an explicit
            // abort terminal reason (#305).
            for (const uuid of interruptedUuids) {
              if (receipt !== undefined && receipt.still_queued.includes(uuid)) {
                activity.clearInterruption(uuid);
              } else {
                activity.verifyInterruption(uuid, receipt !== undefined);
              }
            }
            survivors = receipt?.still_queued.length ?? 0;
            details.push(`Claude Agent SDK acknowledged interruption${receipt ? `; ${receipt.still_queued.length} message(s) remain queued` : ""}`);
          } else {
            for (const uuid of interruptedUuids) activity.clearInterruption(uuid);
            nativeFailure = native.kind === "rejected"
              ? messageOf(native.error)
              : `Claude Agent SDK did not acknowledge the interrupt within ${settleMs} ms`;
            details.push(nativeFailure);
          }
          if (survivors > 0) {
            // Survivors would start as soon as the interrupted turn ends;
            // the public SDK cannot cancel them, so shut the session down
            // now instead of letting them execute after interruption (#310).
            details.push(`closed the session so ${survivors} surviving queued message(s) cannot run`);
          } else if (nativeFailure === undefined && (await waitForPromiseBounded(resultPromise, remaining())).kind === "timeout") {
            details.push(`no terminal result arrived within ${settleMs} ms, so the session was closed`);
          } else if (nativeFailure !== undefined && !finished) {
            details.push("closed the session");
          }
          beginControlShutdown();
          const cleanupFailure = await shutDownOwnedProcess();
          if (cleanupFailure) {
            details.push(`owned Claude process shutdown was not verified: ${cleanupFailure}`);
          } else if (processIdentity) {
            details.push("owned Claude process shutdown verified");
          }
          return {
            status: nativeFailure === undefined && cleanupFailure === undefined ? "acknowledged" : "failed",
            message: `${details.join("; ")}.`,
          };
        },
      });
      await resultPromise;
      // Reflect concurrent steering-delivery outcomes before settling the
      // turn so a verified-but-undelivered interruption is reported.
      while (pendingSteerDeliveries.size > 0) {
        await Promise.allSettled([...pendingSteerDeliveries]);
      }
    } catch (error) {
      if (!timedOut && !aborted) protocolFailure = messageOf(error);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      request.onLiveControl?.(undefined);
      input.close();
      closeQuerySession();
      abortController.abort();
      if (interruptedByControl) {
        // Explicit interruption acknowledges only verified owned shutdown;
        // an unverifiable group is reported, never assumed (#310).
        terminationFailure = await shutDownOwnedProcess();
      } else {
        await lifecycleExit;
      }
    }

    activity.finish();
    const parsed = parser.finish();
    const resultEnvelope = finalResult ?? parsed.resultEnvelope;
    const text = finalResult?.type === "result" && finalResult.subtype === "success"
      ? finalResult.result
      : parsed.text;
    const usage = parseClaudeUsage(resultEnvelope);
    // The terminal result message is authoritative for this run: an earlier
    // error result from a superseded (interrupted) turn must not fail a run
    // whose replacement turn completed successfully (issue #63).
    const resultError = finalResult?.type === "result"
      ? finalResult.subtype === "success"
        ? undefined
        : finalResult.errors.join("; ") || finalResult.subtype
      : parsed.error;
    const terminationDiagnostic = terminationFailure
      ? `Claude CLI shutdown after explicit interruption was not verified: ${terminationFailure}`
      : undefined;
    const code = protocolFailure || resultError || steerDeliveryFailure || terminationDiagnostic ? 1 : 0;
    const output: ProcessRunResult = {
      stdout: stdout.value,
      stderr: stderr.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      streamEvents: stdout.value.split("\n").filter(Boolean).length,
      toolCalls: 0,
      toolResultBytes: 0,
      compactions: 0,
      code,
      timedOut,
      aborted: aborted || interruptedByControl,
      ...(terminationFailure ? { terminationError: terminationFailure } : {}),
    };
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      usage,
      sessionId: effectiveSessionId,
      adapter: this.kind,
    });
    const failure: ExecutorTurn["failure"] = protocolFailure
      ? { category: "protocol", message: protocolFailure }
      : interruptedByControl
        ? { category: "interruption", message: resultError ?? "Claude query was interrupted." }
      : steerDeliveryFailure
        ? { category: "protocol", message: steerDeliveryFailure }
      : resultError
        ? { category: "provider", message: resultError }
        : undefined;
    return {
      text,
      session: { adapter: this.kind, id: effectiveSessionId },
      usage,
      ...artifacts,
      code,
      timedOut,
      aborted: aborted || interruptedByControl,
      failure: terminationDiagnostic
        ? failure
          ? { ...failure, message: `${failure.message} ${terminationDiagnostic}` }
          : { category: "process", message: terminationDiagnostic }
        : failure,
    };
  }
}

function claudeResearchTools(allowedTools: readonly string[] | undefined): string[] {
  if (!allowedTools) {
    throw new Error("Claude research launch requires an authoritative parent tool allowlist.");
  }
  return [...new Set(allowedTools.flatMap((tool) => {
    const mapped = CLAUDE_RESEARCH_TOOL_MAP.get(tool);
    return mapped ? [mapped] : [];
  }))];
}

function assertClaudeResearchArgsSafe(args: readonly string[] | undefined): void {
  const unsafe = args?.find((arg) => CLAUDE_RESEARCH_POLICY_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  ));
  if (unsafe) {
    throw new Error(`Claude research launch rejects tool-policy argument ${unsafe}; the read-only profile is authoritative.`);
  }
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private values: Array<{ message: SDKUserMessage; consumed: () => void; undelivered: (error: Error) => void }> = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  enqueue(message: SDKUserMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Claude streaming input is closed."));
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter({ value: message, done: false });
        resolvePromise();
      } else {
        this.values.push({ message, consumed: resolvePromise, undelivered: rejectPromise });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters = [];
    // A message the SDK never pulled was not delivered; report that instead
    // of resolving as if the transport had accepted it (#310).
    const undelivered = new Error("Claude streaming input closed before the message was delivered.");
    for (const value of this.values) value.undelivered(undelivered);
    this.values = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) {
          value.consumed();
          return Promise.resolve({ value: value.message, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
      },
    };
  }
}

function userMessage(text: string, uuid: string, priority: "now" | "next" | "later"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: uuid as SDKUserMessage["uuid"],
    priority,
  };
}

async function consumeMessages(
  query: Query,
  onMessage: (message: SDKMessage, line: string) => boolean,
): Promise<void> {
  for await (const message of query) {
    const line = `${JSON.stringify(message)}\n`;
    if (onMessage(message, line)) return;
  }
}

function forwardClaudeToolObservations(
  message: SDKMessage,
  onObservation: ExecutorRequest["onToolObservation"],
  toolUses: Map<string, { toolName: string; toolInput: Record<string, unknown> }>,
): void {
  if (!onObservation) return;
  const value = message as unknown as Record<string, unknown>;
  const payload = isRecord(value.message) ? value.message : undefined;
  const content = payload?.content;
  if (!Array.isArray(content)) return;
  if (value.type === "assistant") {
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
      const toolInput = isRecord(block.input) ? block.input : {};
      const id = typeof block.id === "string" ? block.id : undefined;
      if (id) toolUses.set(id, { toolName: block.name, toolInput });
      onObservation({
        stage: "start",
        toolName: block.name,
        toolInput,
        ...(id ? { observationId: id } : {}),
      });
    }
    return;
  }
  if (value.type === "user") {
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const prior = id ? toolUses.get(id) : undefined;
      onObservation({
        stage: "end",
        toolName: prior?.toolName ?? "tool_result",
        ...(prior ? { toolInput: prior.toolInput } : {}),
        result: block.content,
        isError: block.is_error === true,
        ...(id ? { observationId: id } : {}),
      });
      if (id) toolUses.delete(id);
    }
  }
}

/**
 * Terminate and verify the owned Claude CLI process group after explicit
 * interruption (#310). Each escalation step waits a bounded grace for the
 * root's observed exit and, on POSIX, for the detached group to have no
 * members. Returns undefined only when shutdown is verified (or nothing was
 * spawned); otherwise a diagnostic, never an assumed shutdown.
 */
async function terminateOwnedClaudeProcess(
  proc: ChildProcess | undefined,
  graceMs: number,
): Promise<string | undefined> {
  if (proc?.pid === undefined) return undefined;
  // Only an observed root exit counts as evidence; the spawn-signal
  // AbortError precedes it.
  const rootExit = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => { proc.once("exit", () => resolvePromise()); });
  const failures: string[] = [];
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const failure = terminateProcessTree(proc, signal);
    if (failure) failures.push(failure);
    const deadline = Date.now() + graceMs;
    const rootExited = (await waitForPromiseBounded(rootExit, graceMs)).kind !== "timeout";
    if (rootExited && await ownedGroupEmpty(proc.pid, failure === undefined, deadline)) return undefined;
  }
  return [
    ...failures,
    `Claude CLI process ${proc.pid}${process.platform === "win32" ? "" : ` (process group ${proc.pid})`} was still live or unverifiable after SIGKILL`,
  ].join("; ");
}

async function ownedGroupEmpty(processGroupId: number, signalDelivered: boolean, deadline: number): Promise<boolean> {
  // Windows has no detached process group to probe: a successful taskkill /T
  // plus the root's observed exit is the available evidence.
  if (process.platform === "win32") return signalDelivered;
  for (;;) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      // Only ESRCH proves the group has no members; other errors (such as a
      // transient EPERM while a member is mid-exec) keep it unverified.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
