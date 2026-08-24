import { spawn, type ChildProcess } from "node:child_process";
import type { CodexExecutorConfig } from "../../config";
import { reviewerEnv, terminateProcessTree, type ProcessRunResult } from "../../adapters/process";
import { BoundedTextAccumulator, MEBIBYTE } from "../../jsonl";
import { writeExecutorArtifacts } from "../artifacts";
import type {
  ExecutorAdapter,
  ExecutorInteractionAcknowledgement,
  ExecutorRequest,
  ExecutorTurn,
} from "../types";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const CODEX_RESEARCH_CONFIG_KEYS = new Set([
  "model_auto_compact_token_limit",
  "model_context_window",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
]);

/** Codex executor backed by the official long-lived app-server protocol. */
export class CodexExecutorAdapter implements ExecutorAdapter {
  readonly kind = "codex-cli";
  readonly model?: string;

  constructor(private readonly config: CodexExecutorConfig) {
    this.model = config.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const startedAt = Date.now();
    const sandbox = request.workspaceAccess === "read-only" ? "read-only" : "workspace-write";
    if (sandbox === "read-only") assertCodexResearchArgsSafe(this.config.args);
    const researchConfig = sandbox === "read-only" ? codexResearchThreadConfig(request.allowedTools) : undefined;
    const proc = spawn(this.config.command ?? "codex", [
      ...(this.config.args ?? []),
      "app-server",
      "--listen", "stdio://",
    ], {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: reviewerEnv({ ...process.env, ...this.config.env, PWD: request.cwd }),
    });
    const identity = proc.pid === undefined ? undefined : {
      pid: proc.pid,
      processGroupId: process.platform === "win32" ? undefined : proc.pid,
    };
    if (identity) await request.onProcessStart?.(identity);

    const agentTexts: string[] = [];
    const rpc = new AppServerRpc(proc, (method, params) => {
      request.onUpdate?.(summarizeNotification(method, params));
      if (method === "item/completed" && isRecord(params) && isRecord(params.item)
        && params.item.type === "agentMessage" && typeof params.item.text === "string") {
        agentTexts.push(params.item.text);
      }
    });
    let threadId = request.session?.id;
    let turnId: string | undefined;
    let completedTurn: Record<string, unknown> | undefined;
    let timedOut = false;
    let aborted = false;
    let interruptedByControl = false;
    let protocolIdentity: string | undefined;
    let failure: ExecutorTurn["failure"];
    let code: number | null = 0;

    const timeout = setTimeout(() => {
      timedOut = true;
      rpc.terminate();
    }, this.config.timeoutMs ?? 1_800_000);
    timeout.unref?.();
    const onAbort = () => {
      aborted = true;
      if (interruptedByControl) return;
      void (threadId && turnId
        ? rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined)
        : Promise.resolve()).finally(() => rpc.terminate());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const initializeResponse = await rpc.request("initialize", {
        clientInfo: { name: "pi-review-gate", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      protocolIdentity = stringAt(initializeResponse, "userAgent") ?? "codex app-server v2";
      rpc.notify("initialized", {});

      const threadResponse = request.session
        ? await rpc.request("thread/resume", {
            threadId: request.session.id,
            cwd: request.cwd,
            model: this.config.model,
            sandbox,
            approvalPolicy: "never",
            config: researchConfig,
          })
        : await rpc.request("thread/start", {
            cwd: request.cwd,
            model: this.config.model,
            sandbox,
            approvalPolicy: "never",
            ephemeral: false,
            ...(researchConfig ? {
              config: researchConfig,
              environments: [],
              dynamicTools: [],
              selectedCapabilityRoots: [],
            } : {}),
          });
      threadId = stringAt(threadResponse, "thread", "id") ?? threadId;
      if (!threadId) throw new Error("Codex app-server did not return a thread id.");

      const turnResponse = await rpc.request("turn/start", {
        threadId,
        cwd: request.cwd,
        model: this.config.model,
        approvalPolicy: "never",
        ...(researchConfig ? { environments: [] } : {}),
        input: [{ type: "text", text: request.prompt }],
      });
      turnId = stringAt(turnResponse, "turn", "id");
      if (!turnId) throw new Error("Codex app-server did not return an active turn id.");
      const activeThreadId = threadId;
      const activeTurnId = turnId;

      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: protocolIdentity,
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId) => {
          try {
            const response = await rpc.request("turn/steer", {
              threadId: activeThreadId,
              expectedTurnId: activeTurnId,
              clientUserMessageId: instructionId,
              input: [{ type: "text", text: instruction }],
            });
            return {
              status: "acknowledged",
              message: "Codex app-server accepted steering for the active turn.",
              turnId: stringAt(response, "turnId") ?? activeTurnId,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              status: message.includes("activeTurnNotSteerable") ? "blocked" : "failed",
              message,
              turnId: activeTurnId,
            };
          }
        },
        interrupt: async (): Promise<ExecutorInteractionAcknowledgement> => {
          try {
            interruptedByControl = true;
            await rpc.request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId });
            const terminal = await rpc.waitForTurn(activeThreadId, activeTurnId);
            if (terminal.status !== "interrupted" && terminal.status !== "completed") {
              return { status: "failed", message: `Codex interrupt ended in ${String(terminal.status)}.`, turnId: activeTurnId };
            }
            return { status: "acknowledged", message: "Codex app-server acknowledged turn interruption.", turnId: activeTurnId };
          } catch (error) {
            return { status: "failed", message: error instanceof Error ? error.message : String(error), turnId: activeTurnId };
          }
        },
      });

      const completion = await rpc.waitForTurn(threadId, turnId);
      completedTurn = completion;
      const status = typeof completion.status === "string" ? completion.status : "failed";
      if (status === "interrupted") {
        failure = { category: "interruption", message: "Codex turn was interrupted." };
      } else if (status !== "completed") {
        failure = { category: "provider", message: stringAt(completion, "error", "message") ?? `Codex turn ended in ${status}.` };
      }
    } catch (error) {
      if (!timedOut && !aborted) {
        failure = { category: "protocol", message: error instanceof Error ? error.message : String(error) };
      }
      code = 1;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      request.onLiveControl?.(undefined);
      rpc.terminate();
      const exit = await rpc.closed();
      if (identity) await request.onProcessExit?.({ ...identity, code: exit.code, signal: exit.signal });
    }

    const text = agentTexts.join("\n").trim() || finalAgentText(completedTurn);
    const output = rpc.output(code, timedOut, aborted || interruptedByControl);
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      sessionId: threadId,
      adapter: this.kind,
    });
    request.onUpdate?.(`codex turn finished in ${Math.max(0, Date.now() - startedAt)}ms`);
    return {
      text,
      session: { adapter: this.kind, id: threadId ?? request.session?.id ?? "missing" },
      ...artifacts,
      code,
      timedOut,
      aborted: aborted || interruptedByControl,
      failure,
    };
  }
}

function assertCodexResearchArgsSafe(args: readonly string[] | undefined): void {
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const arg = args![index]!;
    if (arg === "--strict-config") continue;
    if (arg === "-c" || arg === "--config") {
      const value = args![index + 1];
      if (!value || !isSafeCodexResearchConfig(value)) {
        throw new Error(`Codex research launch rejects configuration ${value ?? arg}; the read-only profile is authoritative.`);
      }
      index += 1;
      continue;
    }
    const inline = arg.startsWith("-c=")
      ? arg.slice(3)
      : arg.startsWith("--config=")
        ? arg.slice("--config=".length)
        : undefined;
    if (inline !== undefined && isSafeCodexResearchConfig(inline)) continue;
    throw new Error(`Codex research launch rejects CLI argument ${arg}; the read-only profile is authoritative.`);
  }
}

function isSafeCodexResearchConfig(value: string): boolean {
  const separator = value.indexOf("=");
  return separator > 0 && CODEX_RESEARCH_CONFIG_KEYS.has(value.slice(0, separator).trim());
}

function codexResearchThreadConfig(allowedTools: readonly string[] | undefined): Record<string, unknown> {
  if (!allowedTools) {
    throw new Error("Codex research launch requires an authoritative parent tool allowlist.");
  }
  return {
    web_search: allowedTools.includes("WebSearch") ? "live" : "disabled",
    mcp_servers: {},
    apps: {
      _default: {
        enabled: false,
        approvals_reviewer: null,
        destructive_enabled: false,
        open_world_enabled: false,
        default_tools_approval_mode: null,
        default_tools_enabled: false,
      },
    },
  };
}

class AppServerRpc {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private turnWaiters = new Map<string, Array<{ resolve: (turn: Record<string, unknown>) => void; reject: (error: Error) => void }>>();
  private completedTurns = new Map<string, Record<string, unknown>>();
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stdoutCapture = new BoundedTextAccumulator(100 * MEBIBYTE);
  private readonly stderrCapture = new BoundedTextAccumulator(16 * MEBIBYTE);

  constructor(private readonly proc: ChildProcess, private readonly onNotification: (method: string, params: unknown) => void) {
    proc.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => { this.stderrCapture.append(chunk.toString("utf8")); });
    this.exitPromise = new Promise((resolvePromise) => {
      proc.once("close", (code, signal) => {
        const error = new Error(`Codex app-server exited before completing pending protocol work (${code ?? signal ?? "unknown"}).`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        for (const waiters of this.turnWaiters.values()) {
          for (const waiter of waiters) waiter.reject(error);
        }
        this.turnWaiters.clear();
        resolvePromise({ code, signal });
      });
      proc.once("error", (error) => {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  waitForTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const key = `${threadId}:${turnId}`;
    const completed = this.completedTurns.get(key);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolvePromise, reject) => {
      const waiters = this.turnWaiters.get(key) ?? [];
      waiters.push({ resolve: resolvePromise, reject });
      this.turnWaiters.set(key, waiters);
    });
  }

  terminate(): void {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    terminateProcessTree(this.proc, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) terminateProcessTree(this.proc, "SIGKILL");
    }, 2_000);
    timer.unref?.();
  }

  closed(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise;
  }

  output(code: number | null, timedOut: boolean, aborted: boolean): ProcessRunResult {
    return {
      stdout: this.stdoutCapture.value,
      stderr: this.stderrCapture.value,
      stdoutTruncated: this.stdoutCapture.truncated,
      stderrTruncated: this.stderrCapture.truncated,
      stdoutBytes: this.stdoutCapture.bytes,
      stderrBytes: this.stderrCapture.bytes,
      streamEvents: this.stdoutCapture.value.split("\n").filter(Boolean).length,
      toolCalls: 0,
      toolResultBytes: 0,
      compactions: 0,
      code,
      timedOut,
      aborted,
    };
  }

  private write(value: unknown): void {
    if (!this.proc.stdin?.writable) throw new Error("Codex app-server stdin is not writable.");
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consume(chunk: string): void {
    this.stdoutCapture.append(chunk);
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (!isRecord(value)) continue;
      if (typeof value.id === "number" && ("result" in value || "error" in value)) {
        const response = value as unknown as JsonRpcResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(`${response.error.message ?? "Codex app-server error"}: ${JSON.stringify(response.error.data ?? {})}`));
        else pending.resolve(response.result);
        continue;
      }
      if (typeof value.id === "number" && typeof value.method === "string") {
        this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: `Client does not support server request ${value.method}.` } });
        continue;
      }
      if (typeof value.method !== "string") continue;
      this.onNotification(value.method, value.params);
      if (value.method === "turn/completed" && isRecord(value.params) && isRecord(value.params.turn)) {
        const threadId = typeof value.params.threadId === "string" ? value.params.threadId : "";
        const turnId = typeof value.params.turn.id === "string" ? value.params.turn.id : "";
        const key = `${threadId}:${turnId}`;
        this.completedTurns.set(key, value.params.turn);
        const waiters = this.turnWaiters.get(key);
        if (waiters) {
          this.turnWaiters.delete(key);
          for (const waiter of waiters) waiter.resolve(value.params.turn);
        }
      }
    }
  }
}

function finalAgentText(turn: Record<string, unknown> | undefined): string {
  if (!turn || !Array.isArray(turn.items)) return "";
  return turn.items
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "agentMessage" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function summarizeNotification(method: string, params: unknown): string {
  if (method === "item/started" || method === "item/completed") {
    const type = isRecord(params) && isRecord(params.item) && typeof params.item.type === "string" ? params.item.type : "item";
    return `codex ${method === "item/started" ? "started" : "completed"} ${type}`;
  }
  if (method === "turn/completed") return "codex turn completed";
  if (method === "context/compacted") return "codex context compacted";
  if (method.includes("error") || method.includes("warning")) return `codex ${method}`;
  return `codex ${method}`;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
