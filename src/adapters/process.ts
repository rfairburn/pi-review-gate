import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ReviewerInvocationTelemetry, ReviewResult } from "../schema";
import { BoundedJsonlDecoder, MEBIBYTE, utf8Prefix } from "../jsonl";
import { DEFAULT_PI_COMMAND, resolvePiChildSpawn, translateDefaultPiSpawnError } from "../pi-invocation";

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  streamEvents: number;
  toolCalls: number;
  toolResultBytes: number;
  compactions: number;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdinError?: string;
  terminationError?: string;
}

export interface ReviewerArtifactPaths {
  rawOutput: string;
  stderr: string;
  usage: string;
  processResult: string;
}

export interface ProcessLifecycleStart {
  pid: number;
  processGroupId?: number;
}

export interface ProcessLifecycleExit extends ProcessLifecycleStart {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface BoundedProcessClose {
  code: number | null;
  signal: NodeJS.Signals | null;
  closeObserved: boolean;
  exitObserved: boolean;
}

/** Grace period after terminal signaling before stdio is closed fail-closed. */
export const PROCESS_TREE_CLEANUP_GRACE_MS = 5_000;

export type BoundedPromiseOutcome<T> =
  | { kind: "fulfilled"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

/** Observe a promise for a bounded interval without abandoning rejection ownership. */
export function waitForPromiseBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedPromiseOutcome<T>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a non-negative safe integer");
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: BoundedPromiseOutcome<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    promise.then(
      (value) => finish({ kind: "fulfilled", value }),
      (error: unknown) => finish({ kind: "rejected", error }),
    );
  });
}

// Retained output is diagnostic evidence, not a protocol transport. Protocol
// adapters parse incrementally and remain correct even if this limit is hit.
export const MAX_RETAINED_OUTPUT_BYTES = 100 * MEBIBYTE;

/**
 * Wait for the child and all inherited stdio handles to close, but never let
 * terminal cleanup wait indefinitely on a descendant that retained a pipe.
 * On expiry only our local pipe handles are destroyed; this does not prove or
 * claim that any process was terminated. The returned status is only what the
 * direct root's exit or close event actually reported.
 */
export function waitForProcessCloseBounded(
  proc: ChildProcess,
  timeoutMs: number,
  onUnobservedClose?: (outcome: BoundedProcessClose) => void,
): Promise<BoundedProcessClose> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a non-negative safe integer");
  }
  return new Promise((resolve) => {
    let settled = false;
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    if (typeof proc.exitCode === "number" || proc.signalCode !== null) {
      exitStatus = { code: proc.exitCode, signal: proc.signalCode };
    }
    const finish = (outcome: BoundedProcessClose): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
      proc.removeListener("close", onClose);
      resolve(outcome);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitStatus = { code, signal };
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ code, signal, closeObserved: true, exitObserved: exitStatus !== undefined });
    };
    const timer = setTimeout(() => {
      const status = exitStatus ?? { code: null, signal: null };
      // Latch the unobserved outcome before destroying our local endpoints;
      // the resulting close notifications are not child-close evidence.
      const outcome = { ...status, closeObserved: false, exitObserved: exitStatus !== undefined };
      onUnobservedClose?.(outcome);
      finish(outcome);
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.unref();
    }, timeoutMs);
    proc.once("exit", onExit);
    proc.once("close", onClose);
  });
}

export function reviewerArtifactPaths(bundleDir: string): ReviewerArtifactPaths {
  return {
    rawOutput: join(bundleDir, "raw-output.txt"),
    stderr: join(bundleDir, "stderr.txt"),
    usage: join(bundleDir, "usage.json"),
    processResult: join(bundleDir, "process-result.json"),
  };
}

export async function writeReviewerProcessArtifacts(input: {
  paths: ReviewerArtifactPaths;
  output: ProcessRunResult;
  rawOutput?: string;
  usage?: ReviewResult["usage"];
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await Promise.all([
    writeFile(input.paths.rawOutput, input.rawOutput ?? input.output.stdout, "utf8"),
    writeFile(input.paths.stderr, input.output.stderr, "utf8"),
    writeFile(input.paths.usage, JSON.stringify(input.usage ?? null, null, 2), "utf8"),
    writeFile(input.paths.processResult, JSON.stringify({
      code: input.output.code,
      timedOut: input.output.timedOut,
      aborted: input.output.aborted,
      stdinError: input.output.stdinError,
      terminationError: input.output.terminationError,
      stdoutTruncated: input.output.stdoutTruncated,
      stderrTruncated: input.output.stderrTruncated,
      stdoutBytes: input.output.stdoutBytes,
      stderrBytes: input.output.stderrBytes,
      streamEvents: input.output.streamEvents,
      toolCalls: input.output.toolCalls,
      toolResultBytes: input.output.toolResultBytes,
      compactions: input.output.compactions,
      ...input.metadata,
    }, null, 2), "utf8"),
  ]);
}

export function reviewerErrorResult(
  reviewerId: string,
  summary: string,
  rawOutputPath: string,
  error: string,
  usage?: ReviewResult["usage"],
): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error, usage };
}

export function processFailureResult(input: {
  reviewerId: string;
  output: ProcessRunResult;
  rawOutputPath: string;
  timeoutMs: number;
  usage?: ReviewResult["usage"];
}): ReviewResult | undefined {
  const telemetry = processTelemetry(input.output);
  if (input.output.aborted) {
    return {
      ...reviewerErrorResult(input.reviewerId, "Reviewer was aborted.", input.rawOutputPath, "aborted", input.usage),
      telemetry,
      diagnostic: input.output.terminationError,
    };
  }
  if (input.output.timedOut) {
    return { ...reviewerErrorResult(
      input.reviewerId,
      `Reviewer timed out after ${input.timeoutMs}ms.`,
      input.rawOutputPath,
      "timeout",
      input.usage,
    ), telemetry, diagnostic: input.output.terminationError };
  }
  if (input.output.stdinError) {
    return {
      ...reviewerErrorResult(
        input.reviewerId,
        "Reviewer could not receive its prompt.",
        input.rawOutputPath,
        "stdin_error",
        input.usage,
      ),
      telemetry,
      diagnostic: joinDiagnostics(input.output.stdinError, input.output.terminationError),
    };
  }
  if (input.output.code !== 0) {
    return { ...reviewerErrorResult(
      input.reviewerId,
      `Reviewer exited with status ${input.output.code}.`,
      input.rawOutputPath,
      `exit_${input.output.code}`,
      input.usage,
    ), telemetry, diagnostic: joinDiagnostics(stderrDiagnostic(input.output.stderr), input.output.terminationError) };
  }
  return undefined;
}

function stderrDiagnostic(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const tail = lines.slice(-12).join("\n");
  return tail.length <= 2000 ? tail : tail.slice(tail.length - 2000);
}

export async function runPromptProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onProcessStart?: (process: ProcessLifecycleStart) => void | Promise<void>;
  onProcessExit?: (process: ProcessLifecycleExit) => void | Promise<void>;
  /**
   * #93: invoked at the actual prompt transport boundary — once the prompt
   * write has been flushed to the child's stdin pipe. Never invoked when the
   * child dies or the pipe errors before accepting the write, so pre-delivery
   * failures never publish a sent record.
   */
  onPromptDelivery?: (delivery: { prompt: string }) => void;
  /** Internal/test override; production adapters use MAX_RETAINED_OUTPUT_BYTES. */
  maxRetainedOutputBytes?: number;
  /** Internal/test override for deterministic SIGKILL escalation coverage. */
  terminationEscalationMs?: number;
  /** Test-only cmd.exe fixture control; ordinary configured launches keep Node's default quoting. */
  windowsVerbatimArguments?: boolean;
  /**
   * #204: alias-independent default `pi` resolution. This seam is shared by
   * non-Pi adapters (generic-cli, run-as-binary, claude-cli, codex-cli), whose
   * configured commands keep their exact spawn semantics; only the Pi model
   * adapter opts in.
   */
  resolveDefaultPi?: boolean;
}): Promise<ProcessRunResult> {
  const maxRetainedOutputBytes = input.maxRetainedOutputBytes ?? MAX_RETAINED_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxRetainedOutputBytes) || maxRetainedOutputBytes < 0) {
    throw new RangeError("maxRetainedOutputBytes must be a non-negative safe integer");
  }
  const terminationEscalationMs = input.terminationEscalationMs ?? 2_000;
  if (!Number.isSafeInteger(terminationEscalationMs) || terminationEscalationMs < 0) {
    throw new RangeError("terminationEscalationMs must be a non-negative safe integer");
  }
  if (input.signal?.aborted) {
    return emptyProcessResult({ aborted: true });
  }

  return await new Promise((resolve, reject) => {
    const childEnv = { ...(input.env ?? process.env), PWD: input.cwd };
    // #204: alias-independent default `pi` launch, opt-in so non-Pi adapters
    // sharing this seam keep their exact configured command/argv semantics.
    let file = input.command;
    let spawnArgs: string[] = [...input.args];
    let windowsVerbatimArguments = input.windowsVerbatimArguments === true;
    if (input.resolveDefaultPi) {
      const invocation = resolvePiChildSpawn(input.command, input.args, childEnv);
      if (!invocation.ok) {
        reject(new Error(invocation.error));
        return;
      }
      file = invocation.file;
      spawnArgs = invocation.args;
      windowsVerbatimArguments = invocation.windowsVerbatimArguments === true;
    }
    // Only the POSIX pass-through keeps the bare `pi` name; a missing default
    // Pi CLI there surfaces as an actionable diagnostic instead of raw ENOENT.
    const isDefaultPiPassThrough = input.resolveDefaultPi === true && file === DEFAULT_PI_COMMAND;
    const proc = spawn(file, spawnArgs, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapturedBytes = 0;
    let stderrCapturedBytes = 0;
    const streamMetrics = new JsonlStreamMetrics();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdinError: string | undefined;
    let terminationError: string | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let boundedCleanup: Promise<BoundedProcessClose> | undefined;
    let cleanupCloseUnobserved = false;
    // #93: report delivery only when the stdin write actually flushed to the
    // transport pipe; an erroring child or pipe never reports delivery.
    let promptDeliveryReported = false;
    if (input.onPromptDelivery) {
      proc.stdin.on("finish", () => {
        if (promptDeliveryReported) return;
        promptDeliveryReported = true;
        input.onPromptDelivery?.({ prompt: input.prompt });
      });
    }

    const processIdentity = proc.pid === undefined
      ? undefined
      : { pid: proc.pid, processGroupId: process.platform === "win32" ? undefined : proc.pid };
    let lifecycleStartInvoked = false;
    let lifecycleStartError: unknown;
    let lifecycleStart: Promise<void> | undefined;
    let lifecycleCompletion: Promise<void> | undefined;

    const completeLifecycle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      exitObserved: boolean,
    ): Promise<void> => {
      lifecycleCompletion ??= (async () => {
        try {
          await lifecycleStart;
        } catch {
          // A failed start publication still precedes exit publication; the
          // original start failure is reported after the ordered exit callback.
        }
        if (exitObserved && lifecycleStartInvoked && processIdentity) {
          await input.onProcessExit?.({ ...processIdentity, code, signal });
        }
      })();
      return lifecycleCompletion;
    };

    const finish = async (
      result: ProcessRunResult,
      code: number | null,
      signal: NodeJS.Signals | null,
      exitObserved = true,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      try {
        const lifecycle = completeLifecycle(code, signal, exitObserved);
        const lifecycleOutcome = await waitForPromiseBounded(lifecycle, PROCESS_TREE_CLEANUP_GRACE_MS);
        if (lifecycleOutcome.kind === "timeout") {
          const cleanup = terminationError ? ` ${terminationError}` : "";
          throw new Error(
            `Process lifecycle callbacks did not settle within ${PROCESS_TREE_CLEANUP_GRACE_MS}ms; process identity or exit persistence is unconfirmed.${cleanup}`,
          );
        }
        if (lifecycleOutcome.kind === "rejected") throw lifecycleOutcome.error;
        if (lifecycleStartError) throw lifecycleStartError;
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };

    const terminate = () => {
      if (forceKillTimer) {
        return;
      }
      const attemptTermination = (signal: NodeJS.Signals) => {
        try {
          const failure = terminateProcessTree(proc, signal);
          if (failure) terminationError = joinDiagnostics(terminationError, failure);
        } catch (error) {
          // Keep callback/timer termination fail-closed even if the shared
          // helper itself encounters an unexpected synchronous exception.
          terminationError = joinDiagnostics(terminationError, terminationFailure(signal, error));
        }
      };
      attemptTermination("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) attemptTermination("SIGKILL");
      }, terminationEscalationMs);
      forceKillTimer.unref?.();
      boundedCleanup ??= waitForProcessCloseBounded(
        proc,
        terminationEscalationMs + PROCESS_TREE_CLEANUP_GRACE_MS,
        (close) => {
          if (close.closeObserved) return;
          cleanupCloseUnobserved = true;
          terminationError = joinDiagnostics(
            terminationError,
            "cleanup uncertain: the child close event was not observed before the teardown deadline; the owned root or descendants may remain live",
          );
        },
      );
      void boundedCleanup.then((close) => {
        if (close.closeObserved || settled) return;
        streamMetrics.finish();
        void finish({
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          stdoutBytes,
          stderrBytes,
          ...streamMetrics.snapshot(),
          code: close.code,
          timedOut,
          aborted,
          stdinError,
          terminationError,
        }, close.code, close.signal, close.exitObserved);
      });
    };

    const deadline = Date.now() + input.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => {
      input.signal?.removeEventListener("abort", onAbort);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(translateDefaultPiSpawnError(error, isDefaultPiPassThrough));
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      input.onStdoutChunk?.(chunk);
      stdoutBytes += Buffer.byteLength(chunk);
      streamMetrics.push(chunk);
      const captured = cappedChunk(chunk, maxRetainedOutputBytes - stdoutCapturedBytes);
      stdout += captured.value;
      stdoutCapturedBytes += captured.bytes;
      stdoutTruncated = stdoutTruncated || captured.truncated;
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      const captured = cappedChunk(chunk, maxRetainedOutputBytes - stderrCapturedBytes);
      stderr += captured.value;
      stderrCapturedBytes += captured.bytes;
      stderrTruncated = stderrTruncated || captured.truncated;
    });
    proc.on("close", (code, signal) => {
      if (cleanupCloseUnobserved) return;
      input.signal?.removeEventListener("abort", onAbort);
      streamMetrics.finish();
      void finish({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        stdoutBytes,
        stderrBytes,
        ...streamMetrics.snapshot(),
        code,
        timedOut,
        aborted,
        stdinError,
        terminationError,
      }, code, signal, true);
    });
    proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A child may exit or close stdin before a large prompt has been fully
      // written. Without this listener Node treats EPIPE as an uncaught event
      // and terminates the host process.
      stdinError ??= boundedDiagnostic(error.message || error.code || "stdin write failed");
      if (!settled && !timedOut && !aborted) terminate();
    });
    lifecycleStart = (async () => {
      if (!processIdentity) throw new Error(`Could not determine pid for ${input.command}.`);
      lifecycleStartInvoked = true;
      await input.onProcessStart?.(processIdentity);
      if (settled) return;
      if (Date.now() >= deadline && !timedOut) {
        timedOut = true;
        terminate();
        return;
      }
      if (settled || timedOut || aborted || input.signal?.aborted) return;
      proc.stdin.end(input.prompt);
    })();
    void lifecycleStart.catch((error) => {
      lifecycleStartError = error instanceof Error
        ? error
        : new Error(`Process lifecycle start callback failed: ${String(error)}`);
      if (!settled) terminate();
    });
    if (input.signal?.aborted && !aborted) onAbort();
  });
}

export function processTelemetry(output: ProcessRunResult): ReviewerInvocationTelemetry {
  return {
    stdoutBytes: output.stdoutBytes,
    stderrBytes: output.stderrBytes,
    stdoutBytesCaptured: Buffer.byteLength(output.stdout),
    stderrBytesCaptured: Buffer.byteLength(output.stderr),
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    streamEvents: output.streamEvents,
    toolCalls: output.toolCalls,
    toolResultBytes: output.toolResultBytes,
    compactions: output.compactions,
  };
}

function emptyProcessResult(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    streamEvents: 0,
    toolCalls: 0,
    toolResultBytes: 0,
    compactions: 0,
    code: null,
    timedOut: false,
    aborted: false,
    stdinError: undefined,
    ...overrides,
  };
}

class JsonlStreamMetrics {
  private readonly decoder = new BoundedJsonlDecoder((line) => this.consume(line));
  private streamEvents = 0;
  private toolCallIds = new Set<string>();
  private anonymousToolCalls = 0;
  private toolResultIds = new Set<string>();
  private toolResultBytes = 0;
  private compactions = 0;

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): void {
    this.decoder.finish();
  }

  snapshot(): Pick<ProcessRunResult, "streamEvents" | "toolCalls" | "toolResultBytes" | "compactions"> {
    return {
      streamEvents: this.streamEvents,
      toolCalls: this.toolCallIds.size + this.anonymousToolCalls,
      toolResultBytes: this.toolResultBytes,
      compactions: this.compactions,
    };
  }

  private consume(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    this.streamEvents += 1;
    if (isCompactionEvent(event)) this.compactions += 1;
    const calls = collectToolCalls(event);
    for (const id of calls.ids) this.toolCallIds.add(id);
    this.anonymousToolCalls += calls.anonymous;
    for (const result of collectToolResults(event)) {
      if (result.id) {
        if (this.toolResultIds.has(result.id)) continue;
        this.toolResultIds.add(result.id);
      }
      this.toolResultBytes += result.bytes;
    }
  }
}

function boundedDiagnostic(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : normalized.slice(normalized.length - 2_000);
}

function collectToolCalls(event: Record<string, unknown>): { ids: Set<string>; anonymous: number } {
  const ids = new Set<string>();
  let anonymous = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const type = typeof value.type === "string" ? value.type : "";
    if (["toolCall", "toolUse", "tool_use", "tool_execution_start"].includes(type)) {
      const id = toolCallIdentity(value);
      if (id) ids.add(id);
      else anonymous += 1;
    }
    for (const key of ["message", "content", "item", "event", "content_block"]) visit(value[key]);
  };
  visit(event);
  return { ids, anonymous };
}

function toolCallIdentity(value: Record<string, unknown>): string | undefined {
  for (const key of ["id", "toolCallId", "tool_use_id", "call_id"]) {
    const id = value[key];
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function collectToolResults(event: Record<string, unknown>): Array<{ id?: string; bytes: number }> {
  const results: Array<{ id?: string; bytes: number }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const role = typeof value.role === "string" ? value.role : "";
    const type = typeof value.type === "string" ? value.type : "";
    if (role === "toolResult" || type === "toolResult" || type === "tool_result") {
      results.push({ id: toolCallIdentity(value), bytes: Buffer.byteLength(JSON.stringify(value)) });
      return;
    }
    for (const key of ["message", "content", "item", "event"]) visit(value[key]);
  };
  visit(event);
  return results;
}

function isCompactionEvent(event: Record<string, unknown>): boolean {
  return [event.type, event.event, event.subtype].some((value) =>
    typeof value === "string" && /compact/i.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cappedChunk(chunk: string, remainingBytes: number): { value: string; bytes: number; truncated: boolean } {
  if (remainingBytes <= 0) {
    return { value: "", bytes: 0, truncated: chunk.length > 0 };
  }
  const chunkBytes = Buffer.byteLength(chunk);
  if (chunkBytes <= remainingBytes) {
    return { value: chunk, bytes: chunkBytes, truncated: false };
  }
  const value = utf8Prefix(chunk, remainingBytes);
  return { value, bytes: Buffer.byteLength(value), truncated: true };
}

export function terminateProcessTree(proc: ChildProcess, signal: NodeJS.Signals): string | undefined {
  // A child whose spawn failed never forked: pid stays undefined forever.
  // Signaling it is not a no-op — on Node 24, kill() after a failed spawn
  // delivers the signal to the caller's own process group (observed: the
  // parent dies with SIGTERM). There is nothing to terminate; the spawn
  // error itself is the failure that must surface.
  if (proc.pid === undefined) return undefined;
  let processGroupError: unknown;
  if (proc.pid && process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
      return undefined;
    } catch (error) {
      // Fall back to killing the direct child below.
      processGroupError = error;
    }
  }
  if (process.platform === "win32") {
    if (hasExited(proc)) {
      return terminationFailure(
        signal,
        new Error("owned process root exited before taskkill /T; descendants may remain live"),
        undefined,
        true,
      );
    }
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot || !isAbsolute(systemRoot)) {
      return terminationFailure(signal, new Error("the Windows system root is unavailable for taskkill /T"));
    }
    const taskkill = join(systemRoot, "System32", "taskkill.exe");
    try {
      const result = spawnSync(taskkill, ["/PID", String(proc.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        timeout: 3_000,
      });
      if (result.error) return terminationFailure(signal, result.error);
      if (result.status !== 0) {
        return terminationFailure(signal, new Error(`taskkill /T exited with status ${result.status ?? "unknown"}`));
      }
      return undefined;
    } catch (error) {
      return terminationFailure(signal, error);
    }
  }
  // A POSIX leader may have exited while descendants still hold its process
  // group's pipes open. Try the group signal first even in that state; only
  // skip the POSIX direct-child fallback once its exit is known.
  if (hasExited(proc)) {
    // ESRCH proves that the owned group has no members at the moment of the
    // signal attempt; other failures leave descendant cleanup unconfirmed.
    return processGroupError && !hasErrnoCode(processGroupError, "ESRCH")
      ? terminationFailure(signal, processGroupError, undefined, true)
      : undefined;
  }
  try {
    const sent = proc.kill(signal);
    if (sent) {
      // Signaling the direct child does not prove descendants were terminated
      // when the process-group attempt failed.
      return processGroupError
        ? terminationFailure(
          signal,
          new Error("direct-child fallback sent but group termination was not confirmed"),
          processGroupError,
        )
        : undefined;
    }
    if (hasExited(proc)) {
      return processGroupError
        ? terminationFailure(signal, processGroupError, undefined, true)
        : undefined;
    }
    return terminationFailure(signal, new Error("ChildProcess.kill returned false before child exit was observed."), processGroupError);
  } catch (error) {
    if (hasExited(proc)) {
      return processGroupError
        ? terminationFailure(signal, processGroupError, undefined, true)
        : undefined;
    }
    return terminationFailure(signal, error, processGroupError);
  }
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode != null || proc.signalCode != null;
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function terminationFailure(signal: NodeJS.Signals, error: unknown, processGroupError?: unknown, leaderExited = false): string {
  const describe = (value: unknown): string => {
    const code = typeof value === "object" && value !== null && "code" in value
      ? String((value as { code?: unknown }).code ?? "")
      : "";
    const message = value instanceof Error ? value.message : String(value);
    return boundedDiagnostic(code ? `${code}: ${message}` : message);
  };
  const groupDetail = processGroupError
    ? `; process-group attempt also failed (${describe(processGroupError)})`
    : "";
  const status = leaderExited
    ? "process leader exited but descendants may remain live"
    : "child exit had not been observed";
  return `${signal} termination failed (${describe(error)})${groupDetail}; ${status}`;
}

function joinDiagnostics(...values: Array<string | undefined>): string | undefined {
  const diagnostic = values.filter((value): value is string => Boolean(value)).join("\n");
  return diagnostic ? boundedDiagnostic(diagnostic) : undefined;
}

export function reviewerEnv(
  env: NodeJS.ProcessEnv,
  evidenceBundleDir?: string,
): NodeJS.ProcessEnv {
  const next = { ...env };
  next.PI_REVIEW_GATE_DISABLED = "1";
  delete next.PI_EXTRA_EXTENSIONS;
  if (evidenceBundleDir) {
    next.PI_REVIEW_GATE_BUNDLE_DIR = evidenceBundleDir;
  }
  return next;
}
