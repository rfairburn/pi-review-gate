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
import { createExecutorToolCatalog } from "../tool-catalog";

const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;

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
    const readOnly = request.workspaceAccess === "read-only";
    const toolCatalog = request.executorToolCatalog
      ? createExecutorToolCatalog(
          request.executorToolCatalog.allowedToolCatalog,
          request.executorToolCatalog.initialActiveTools,
        )
      : request.allowedTools
        ? createExecutorToolCatalog(request.allowedTools, request.initialActiveTools)
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
    const resultPromise = consumeMessages(query, (message, line) => {
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
      }
      return false;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      void query?.interrupt().catch(() => undefined).finally(() => query?.close());
    }, this.config.timeoutMs ?? 1_800_000);
    timeout.unref?.();
    const onAbort = () => {
      aborted = true;
      if (interruptedByControl) return;
      void query?.interrupt().catch(() => undefined).finally(() => query?.close());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await query.initializationResult();
      await lifecycleStart;
      request.onUpdate?.("claude streaming session initialized with live steer and interrupt controls");
      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: "Claude Agent SDK streaming Query",
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId) => {
          if (finished) return { status: "blocked", message: "Claude turn already reached a terminal result." };
          const messageUuid = randomUUID();
          targetUuid = messageUuid;
          try {
            await input.enqueue(userMessage(instruction, messageUuid, "now"));
            return {
              status: "acknowledged",
              message: `Claude Agent SDK accepted live steering (${instructionId}).`,
              turnId: messageUuid,
            };
          } catch (error) {
            return { status: "failed", message: messageOf(error), turnId: messageUuid };
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
      await input.enqueue(userMessage(request.prompt, initialUuid, "now"));
      await resultPromise;
    } catch (error) {
      if (!timedOut && !aborted) protocolFailure = messageOf(error);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      request.onLiveControl?.(undefined);
      input.close();
      query.close();
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
    const resultError = finalResult?.type === "result" && finalResult.subtype !== "success"
      ? finalResult.errors.join("; ") || finalResult.subtype
      : parsed.error;
    const code = protocolFailure || resultError ? 1 : 0;
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
