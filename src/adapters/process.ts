import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewerInvocationTelemetry, ReviewResult } from "../schema";

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
}

export interface ReviewerArtifactPaths {
  rawOutput: string;
  stderr: string;
  usage: string;
  processResult: string;
}

const MAX_OUTPUT_BYTES = 1_000_000;

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
    return { ...reviewerErrorResult(input.reviewerId, "Reviewer was aborted.", input.rawOutputPath, "aborted", input.usage), telemetry };
  }
  if (input.output.timedOut) {
    return { ...reviewerErrorResult(
      input.reviewerId,
      `Reviewer timed out after ${input.timeoutMs}ms.`,
      input.rawOutputPath,
      "timeout",
      input.usage,
    ), telemetry };
  }
  if (input.output.code !== 0) {
    return { ...reviewerErrorResult(
      input.reviewerId,
      `Reviewer exited with status ${input.output.code}.`,
      input.rawOutputPath,
      `exit_${input.output.code}`,
      input.usage,
    ), telemetry, diagnostic: stderrDiagnostic(input.output.stderr) };
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
}): Promise<ProcessRunResult> {
  if (input.signal?.aborted) {
    return emptyProcessResult({ aborted: true });
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...(input.env ?? process.env), PWD: input.cwd },
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const streamMetrics = new JsonlStreamMetrics();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve(result);
    };

    const terminate = () => {
      if (forceKillTimer) {
        return;
      }
      terminateProcessTree(proc, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          terminateProcessTree(proc, "SIGKILL");
        }
      }, 2_000);
      forceKillTimer.unref?.();
    };

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
      reject(error);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      input.onStdoutChunk?.(chunk);
      stdoutBytes += Buffer.byteLength(chunk);
      streamMetrics.push(chunk);
      const captured = appendCapped(stdout, chunk, MAX_OUTPUT_BYTES);
      stdout = captured.value;
      stdoutTruncated = stdoutTruncated || captured.truncated;
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      const captured = appendCapped(stderr, chunk, MAX_OUTPUT_BYTES);
      stderr = captured.value;
      stderrTruncated = stderrTruncated || captured.truncated;
    });
    proc.on("close", (code) => {
      input.signal?.removeEventListener("abort", onAbort);
      streamMetrics.finish();
      finish({
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
      });
    });
    proc.stdin.end(input.prompt);

    if (input.signal?.aborted) {
      onAbort();
    }
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
    ...overrides,
  };
}

class JsonlStreamMetrics {
  private pending = "";
  private streamEvents = 0;
  private toolCallIds = new Set<string>();
  private anonymousToolCalls = 0;
  private toolResultBytes = 0;
  private compactions = 0;

  push(chunk: string): void {
    this.pending += chunk;
    while (true) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) return;
      this.consume(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
  }

  finish(): void {
    if (this.pending.trim()) this.consume(this.pending);
    this.pending = "";
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
    this.toolResultBytes += toolResultPayloadBytes(event);
  }
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

function toolResultPayloadBytes(event: Record<string, unknown>): number {
  let bytes = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const role = typeof value.role === "string" ? value.role : "";
    const type = typeof value.type === "string" ? value.type : "";
    if (role === "toolResult" || type === "toolResult" || type === "tool_result") {
      bytes += Buffer.byteLength(JSON.stringify(value));
      return;
    }
    for (const key of ["message", "content", "item", "event"]) visit(value[key]);
  };
  visit(event);
  return bytes;
}

function isCompactionEvent(event: Record<string, unknown>): boolean {
  return [event.type, event.event, event.subtype].some((value) =>
    typeof value === "string" && /compact/i.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendCapped(current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= maxBytes) {
    return { value: current, truncated: chunk.length > 0 };
  }
  const remaining = maxBytes - currentBytes;
  const chunkBytes = Buffer.byteLength(chunk);
  if (chunkBytes <= remaining) {
    return { value: current + chunk, truncated: false };
  }
  return {
    value: current + Buffer.from(chunk).subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

export function terminateProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid && process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  proc.kill(signal);
}

export function reviewerEnv(env: NodeJS.ProcessEnv, evidenceBundleDir?: string): NodeJS.ProcessEnv {
  const next = { ...env };
  next.PI_REVIEW_GATE_DISABLED = "1";
  next.LITTLE_CODER_REVIEW_GATE_DISABLED = "1";
  delete next.PI_EXTRA_EXTENSIONS;
  delete next.LITTLE_CODER_EXTRA_EXTENSIONS;
  if (evidenceBundleDir) {
    next.PI_REVIEW_GATE_BUNDLE_DIR = evidenceBundleDir;
  }
  return next;
}
