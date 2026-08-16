import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import { PiJsonlActivityExtractor } from "../progress";
import { ExecutorLifecycleError, type ExecutorAdapter, type ExecutorRequest, type ExecutorTurn } from "../types";
import type { ThinkingLevel } from "../../config";
import { withLittleCoderThinkingBudget } from "../../little-coder-thinking";

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
        await compactInterruptedSession({
          command: this.options.command ?? "little-coder",
          model: this.options.model,
          thinkingLevel,
          sessionId,
          sessionDir,
          cwd: request.cwd,
          args: this.options.args ?? [],
          timeoutMs: Math.min(this.options.timeoutMs ?? 1_800_000, 300_000),
          env: executorEnv(this.options.model, thinkingLevel),
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
      "--mode", "json",
      "--print",
      "--thinking", thinkingLevel,
      "--session-id", sessionId,
      "--session-dir", sessionDir,
      "--approve",
      ...(this.options.args ?? []),
    ];
    const output = await runPromptProcess({
      command: this.options.command ?? "little-coder",
      args,
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs: this.options.timeoutMs ?? 1_800_000,
      env: executorEnv(this.options.model, thinkingLevel),
      signal: request.signal,
      onProcessStart: request.onProcessStart,
      onProcessExit: request.onProcessExit,
      onStdoutChunk: (chunk) => {
        extractor.push(chunk);
        activity.push(chunk);
      },
    });
    activity.finish();
    const streamed = extractor.finish();
    const extracted = streamed.text.trim() ? streamed : extractReviewTextFromPiJsonl(output.stdout);
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text: extracted.text,
      usage: extracted.usage,
      sessionId,
      adapter: this.kind,
    });
    return {
      text: extracted.text,
      session: { adapter: this.kind, id: sessionId },
      usage: extracted.usage,
      ...artifacts,
      code: output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
      lifecycle: extracted.lifecycle,
      failure: extracted.lifecycle.compaction.status === "in_progress"
        ? { category: "interruption", message: "Executor process ended while context compaction was in progress." }
        : extracted.lifecycle.compaction.status === "failed" || extracted.lifecycle.compaction.status === "aborted"
          ? { category: "compaction", message: extracted.lifecycle.compaction.error ?? "Context compaction did not complete." }
          : extracted.terminalError
            ? { category: "provider", message: extracted.terminalError }
        : output.stdinError
          ? { category: "stdin", message: output.stdinError }
          : undefined,
    };
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

function rpcError(event: Record<string, unknown>): string {
  if (typeof event.error === "string") return event.error;
  const error = event.error as Record<string, unknown> | undefined;
  if (typeof error?.message === "string") return error.message;
  return "unknown RPC error";
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Executor recovery was cancelled.");
}

function executorEnv(model: string, thinkingLevel: ThinkingLevel): NodeJS.ProcessEnv {
  const env = reviewerEnv(process.env);
  // Keep normal little-coder extensions except this gate; the kill-switch is
  // authoritative and prevents nested automatic review.
  if (process.env.LITTLE_CODER_EXTRA_EXTENSIONS) {
    env.LITTLE_CODER_EXTRA_EXTENSIONS = process.env.LITTLE_CODER_EXTRA_EXTENSIONS;
  }
  if (process.env.PI_EXTRA_EXTENSIONS) {
    env.PI_EXTRA_EXTENSIONS = process.env.PI_EXTRA_EXTENSIONS;
  }
  return withLittleCoderThinkingBudget(env, model, thinkingLevel);
}
