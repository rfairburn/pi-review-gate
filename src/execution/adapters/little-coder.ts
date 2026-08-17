import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reviewerEnv, terminateProcessTree, type ProcessRunResult } from "../../adapters/process";
import { BoundedTextAccumulator, MEBIBYTE } from "../../jsonl";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import { PiJsonlActivityExtractor } from "../progress";
import { ExecutorLifecycleError, type ExecutorAdapter, type ExecutorInteractionAcknowledgement, type ExecutorRequest, type ExecutorTurn } from "../types";
import type { ThinkingLevel } from "../../config";
import { withLittleCoderThinkingBudget } from "../../little-coder-thinking";
import { BackgroundProcessReadiness } from "../../background-process-readiness";

export interface LittleCoderExecutorOptions {
  model: string;
  thinkingLevel?: ThinkingLevel;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export class LittleCoderExecutorAdapter implements ExecutorAdapter {
  readonly kind = "little-coder-model";
  readonly model: string;

  constructor(private readonly options: LittleCoderExecutorOptions) {
    this.model = options.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const thinkingLevel = this.options.thinkingLevel ?? "high";
    const sessionId = request.session?.id ?? randomUUID();
    const sessionDir = join(request.artifactDir, "executor-sessions");
    await mkdir(sessionDir, { recursive: true });
    if (request.recovery?.compactBeforePrompt) {
      if (!request.session) {
        throw new Error("Cannot compact an interrupted executor without its durable session id.");
      }
      request.onUpdate?.("reopening executor session for context compaction");
      try {
        const allowedTools = normalizeAllowedTools(request.allowedTools);
        await compactInterruptedSession({
          command: this.options.command ?? "little-coder",
          model: this.options.model,
          thinkingLevel,
          sessionId,
          sessionDir,
          cwd: request.cwd,
          args: childArgs(this.options.args ?? [], allowedTools),
          timeoutMs: Math.min(this.options.timeoutMs ?? 1_800_000, 300_000),
          env: executorEnv(this.options.model, thinkingLevel, allowedTools),
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
    const allowedTools = normalizeAllowedTools(request.allowedTools);
    const args = [
      "--model", this.options.model,
      "--mode", "rpc",
      "--thinking", thinkingLevel,
      "--session-id", sessionId,
      "--session-dir", sessionDir,
      "--approve",
      ...childArgs(this.options.args ?? [], allowedTools),
    ];
    const proc = spawn(this.options.command ?? "little-coder", args, {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: executorEnv(this.options.model, thinkingLevel, allowedTools),
    });
    const identity = proc.pid === undefined ? undefined : {
      pid: proc.pid,
      processGroupId: process.platform === "win32" ? undefined : proc.pid,
    };
    if (identity) await request.onProcessStart?.(identity);
    const backgroundReadiness = new BackgroundProcessReadiness();
    const rpc = new LittleCoderRpc(proc, backgroundReadiness, (chunk) => {
      extractor.push(chunk);
      activity.push(chunk);
    });
    let timedOut = false;
    let aborted = false;
    let interruptedByControl = false;
    let protocolFailure: string | undefined;
    let finalText = "";
    const timeoutMs = this.options.timeoutMs ?? 1_800_000;
    let timeoutDeadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (backgroundReadiness.snapshot().running.length > 0) {
        timeoutDeadline = Date.now() + timeoutMs;
        return;
      }
      if (Date.now() < timeoutDeadline) return;
      timedOut = true;
      rpc.terminate();
    }, Math.min(250, Math.max(25, Math.floor(timeoutMs / 4))));
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      if (interruptedByControl) return;
      void rpc.request("abort", {}).catch(() => undefined).finally(() => rpc.terminate());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let settledGeneration = rpc.settledGeneration;
      await rpc.request("prompt", { message: request.prompt });
      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: "pi rpc",
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId) => {
          try {
            const state = await rpc.request("get_state", {});
            if (rpcState(state).isStreaming) {
              await rpc.request("steer", { message: instruction }, instructionId);
              return { status: "acknowledged", message: "Little Coder RPC acknowledged live steering." };
            }
            await rpc.request("prompt", { message: instruction }, instructionId);
            return {
              status: "acknowledged",
              message: "Little Coder RPC resumed the idle executor with the steering instruction while background work remained active.",
            };
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
              return { status: "acknowledged", message: "Little Coder RPC interruption terminated the idle executor and its background processes." };
            }
            const beforeInterrupt = rpc.settledGeneration;
            await rpc.request("abort", {});
            await rpc.waitForSettled(beforeInterrupt);
            return { status: "acknowledged", message: "Little Coder RPC acknowledged interruption and the agent settled." };
          } catch (error) {
            return { status: "failed", message: messageOf(error) };
          }
        },
      });
      await rpc.waitForSettled(settledGeneration);
      for (;;) {
        const background = backgroundReadiness.snapshot();
        if (background.unverifiable.length > 0) {
          throw new Error(
            `ShellStart reported background work whose process group could not be verified: ${background.unverifiable.join("; ")}`,
          );
        }
        if (background.running.length === 0) break;
        request.onUpdate?.(
          `executor waiting for ${background.running.length} background process group(s): ${background.running.map((job) => `${job.id} (${job.label})`).join(", ")}`,
        );
        await waitForBackgroundProcesses(backgroundReadiness, request.signal);
        if (request.signal?.aborted || timedOut || interruptedByControl) break;

        settledGeneration = rpc.settledGeneration;
        const state = rpcState(await rpc.request("get_state", {}));
        if (state.isStreaming || state.pendingMessageCount > 0) {
          request.onUpdate?.("background process completed; waiting for the executor's automatic completion turn");
          await rpc.waitForSettled(settledGeneration);
        } else {
          request.onUpdate?.("background process completed; resuming executor for final inspection before review");
          await rpc.request("prompt", { message: backgroundCompletionPrompt });
          await rpc.waitForSettled(settledGeneration);
        }
      }
      const response = await rpc.request("get_last_assistant_text", {});
      finalText = isRecord(response.data) && typeof response.data.text === "string" ? response.data.text : "";
    } catch (error) {
      if (!timedOut && !aborted && !interruptedByControl) protocolFailure = messageOf(error);
    } finally {
      clearInterval(timer);
      request.signal?.removeEventListener("abort", onAbort);
      request.onLiveControl?.(undefined);
      rpc.terminate();
    }
    const exit = await rpc.closed();
    if (identity) await request.onProcessExit?.({ ...identity, code: exit.code, signal: exit.signal });
    const output = rpc.output(protocolFailure ? 1 : 0, timedOut, aborted || interruptedByControl);
    activity.finish();
    const streamed = extractor.finish();
    const extracted = streamed.text.trim() ? streamed : extractReviewTextFromPiJsonl(output.stdout);
    const text = finalText.trim() || extracted.text;
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
      code: output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
      lifecycle: extracted.lifecycle,
      failure: protocolFailure
        ? { category: "protocol", message: protocolFailure }
        : interruptedByControl
          ? { category: "interruption", message: "Little Coder RPC turn was interrupted." }
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

class LittleCoderRpc {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private settledWaiters: Array<{ after: number; resolve: () => void; reject: (error: Error) => void }> = [];
  private settledCount = 0;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stdout = new BoundedTextAccumulator(100 * MEBIBYTE);
  private readonly stderr = new BoundedTextAccumulator(16 * MEBIBYTE);

  constructor(
    private readonly proc: ChildProcess,
    private readonly backgroundReadiness: BackgroundProcessReadiness,
    private readonly onJsonl: (chunk: string) => void,
  ) {
    proc.stdout?.on("data", (value: Buffer) => this.consume(value.toString("utf8")));
    proc.stderr?.on("data", (value: Buffer) => { this.stderr.append(value.toString("utf8")); });
    this.exitPromise = new Promise((resolvePromise) => {
      proc.once("close", (code, signal) => {
        const error = new Error(`Little Coder RPC exited before protocol completion (${code ?? signal ?? "unknown"}).`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        for (const waiter of this.settledWaiters) waiter.reject(error);
        this.settledWaiters = [];
        resolvePromise({ code, signal });
      });
      proc.once("error", (error) => {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
    });
  }

  request(type: string, fields: Record<string, unknown>, explicitId?: string): Promise<Record<string, unknown>> {
    const id = explicitId ?? `review-gate-${this.nextId++}`;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      if (!this.proc.stdin?.writable) {
        this.pending.delete(id);
        reject(new Error("Little Coder RPC stdin is not writable."));
        return;
      }
      this.proc.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  get settledGeneration(): number {
    return this.settledCount;
  }

  waitForSettled(after = this.settledCount): Promise<void> {
    if (this.settledCount > after) return Promise.resolve();
    return new Promise((resolvePromise, reject) => this.settledWaiters.push({ after, resolve: resolvePromise, reject }));
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
    };
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
      } else if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
        this.backgroundReadiness.observeToolResult(event.toolName, event.result, event.isError === true);
      } else if (event.type === "agent_settled") {
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
    "--approve",
    ...input.args,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(input.command, args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...input.env, PWD: input.cwd },
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
    let forceKillTimer: NodeJS.Timeout | undefined;
    let phase: "state" | "compact" = "state";

    const stop = (signal: NodeJS.Signals) => {
      if (proc.exitCode !== null) return;
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch {
        // The process may have exited between the liveness check and signal.
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
    };
    const finishAfterClose = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      try {
        await lifecycleStart?.catch(() => undefined);
        if (lifecycleStartInvoked && processIdentity) await input.onProcessExit?.({ ...processIdentity, code, signal });
        if (completionError) reject(completionError);
        else resolve();
      } catch (lifecycleError) {
        reject(lifecycleError);
      }
    };
    const fail = (message: string) => requestFinish(new Error(`${message}${stderr.trim() ? ` Stderr: ${stderr.trim().slice(-2000)}` : ""}`));
    const send = (value: object) => {
      if (!proc.stdin.writable) return fail("Executor RPC stdin closed during compaction recovery.");
      proc.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const timer = setTimeout(() => fail(`Executor compaction recovery timed out after ${input.timeoutMs}ms.`), input.timeoutMs);
    const onAbort = () => requestFinish(abortError(input.signal));
    input.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => requestFinish(error));
    proc.stdin.on("error", (error) => requestFinish(error));
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
    proc.on("close", (code, signal) => {
      if (!finishing) completionError = new Error(`Executor RPC exited with status ${code} during compaction recovery.`);
      void finishAfterClose(code, signal);
    });
    lifecycleStart = (async () => {
      if (!processIdentity) throw new Error(`Could not determine pid for ${input.command}.`);
      lifecycleStartInvoked = true;
      await input.onProcessStart?.(processIdentity);
      if (!settled) send({ id: "review-gate-state", type: "get_state" });
    })();
    void lifecycleStart.catch((error) => requestFinish(error));
  });
}

const recoveryCompactionInstructions = [
  "Preserve the task objective, completed investigation, edits, validation results, and exact remaining work.",
  "This session will be resumed automatically after compaction.",
].join(" ");

const backgroundCompletionPrompt = [
  "All ShellStart background process groups are now finished.",
  "Inspect their results and the workspace, address any failure, and finish the original task.",
  "Do not claim success from process exit alone; verify the requested outcome before responding.",
].join(" ");

async function waitForBackgroundProcesses(
  readiness: BackgroundProcessReadiness,
  signal?: AbortSignal,
): Promise<void> {
  while (readiness.snapshot().running.length > 0) {
    if (signal?.aborted) throw abortError(signal);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
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

function normalizeAllowedTools(tools: readonly string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  return [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))];
}

function childArgs(args: readonly string[], allowedTools: readonly string[] | undefined): string[] {
  return [
    ...args,
    ...(allowedTools ? ["--tools", allowedTools.join(",")] : []),
  ];
}

function executorEnv(model: string, thinkingLevel: ThinkingLevel, allowedTools?: readonly string[]): NodeJS.ProcessEnv {
  const env = reviewerEnv(process.env);
  // Keep normal little-coder extensions except this gate; the kill-switch is
  // authoritative and prevents nested automatic review.
  if (process.env.LITTLE_CODER_EXTRA_EXTENSIONS) {
    env.LITTLE_CODER_EXTRA_EXTENSIONS = process.env.LITTLE_CODER_EXTRA_EXTENSIONS;
  }
  if (process.env.PI_EXTRA_EXTENSIONS) {
    env.PI_EXTRA_EXTENSIONS = process.env.PI_EXTRA_EXTENSIONS;
  }
  if (allowedTools) env.LITTLE_CODER_ALLOWED_TOOLS = allowedTools.join(",");
  return withLittleCoderThinkingBudget(env, model, thinkingLevel);
}
