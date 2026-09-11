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
import { reviewerEnv, type ProcessRunResult } from "../../adapters/process";
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
}

/** Claude executor using the official Agent SDK streaming control surface. */
export class ClaudeExecutorAdapter implements ExecutorAdapter {
  readonly kind = "claude-cli";
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
          void Promise.resolve(processIdentity && request.onProcessExit?.({ ...processIdentity, code, signal }))
            .finally(resolvePromise);
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
            if (typeof message.session_id === "string") effectiveSessionId = message.session_id;
            if (message.type === "result") {
              const resultUuid = "user_message_uuid" in message && typeof message.user_message_uuid === "string"
                ? message.user_message_uuid
                : undefined;
              if (resultUuid === targetUuid || resultUuid === undefined && targetUuid === initialUuid) {
                finalResult = message;
                finished = true;
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
          // flow instead of leaving an unhandled rejection behind.
          if (!timedOut && !aborted) protocolFailure = messageOf(error);
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
          if (finished) return { status: "blocked", message: "Claude turn already reached a terminal result." };
          const messageUuid = randomUUID();
          const previousTargetUuid = targetUuid;
          // Retarget before interrupting so the interrupted turn's result
          // cannot match and end this run; the steered message's result is
          // the terminal one (issue #63).
          targetUuid = messageUuid;
          let interruptionVerified = false;
          let deliverySettled: (() => void) | undefined;
          let deliveryPromise: Promise<void> | undefined;
          try {
            if (options?.interrupt) {
              await query!.interrupt();
              interruptionVerified = true;
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
                ? `Claude Agent SDK delivered turn-interrupt steering to the same session (${instructionId}); any in-flight turn was interrupted.`
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
              // instead of stranding this run on an undelivered UUID.
              targetUuid = previousTargetUuid;
              const bufferedKey = previousTargetUuid !== initialUuid || unmatchedResults.has(previousTargetUuid)
                ? previousTargetUuid
                : UNKEYED_RESULT_KEY;
              const buffered = unmatchedResults.get(bufferedKey);
              if (buffered !== undefined) {
                unmatchedResults.delete(bufferedKey);
                finalResult = buffered;
                finished = true;
                settleNow?.();
              }
            } else {
              // The interrupt succeeded but the replacement was never
              // delivered: settle with a concrete failure rather than waiting
              // for a result whose message will never arrive.
              steerDeliveryFailure = `Claude turn-interrupt steering verified the interruption, but replacement delivery failed: ${failure}`;
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
          try {
            interruptedByControl = true;
            const receipt = await query!.interrupt();
            await resultPromise.catch(() => undefined);
            return {
              status: "acknowledged",
              message: `Claude Agent SDK acknowledged interruption${receipt ? `; ${receipt.still_queued.length} message(s) remain queued` : ""}.`,
            };
          } catch (error) {
            return { status: "failed", message: messageOf(error) };
          }
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
      await lifecycleExit;
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
    const code = protocolFailure || resultError || steerDeliveryFailure ? 1 : 0;
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
    return {
      text,
      session: { adapter: this.kind, id: effectiveSessionId },
      usage,
      ...artifacts,
      code,
      timedOut,
      aborted: aborted || interruptedByControl,
      failure: protocolFailure
        ? { category: "protocol", message: protocolFailure }
        : interruptedByControl
          ? { category: "interruption", message: resultError ?? "Claude query was interrupted." }
        : steerDeliveryFailure
          ? { category: "protocol", message: steerDeliveryFailure }
        : resultError
          ? { category: "provider", message: resultError }
          : undefined,
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
  private values: Array<{ message: SDKUserMessage; consumed: () => void }> = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  enqueue(message: SDKUserMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Claude streaming input is closed."));
    return new Promise((resolvePromise) => {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter({ value: message, done: false });
        resolvePromise();
      } else {
        this.values.push({ message, consumed: resolvePromise });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters = [];
    for (const value of this.values) value.consumed();
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
