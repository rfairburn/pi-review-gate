import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_OUTPUT_BYTES = 1_000_000;

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
    return { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, code: null, timedOut: false, aborted: true };
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
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
      const captured = appendCapped(stdout, chunk, MAX_OUTPUT_BYTES);
      stdout = captured.value;
      stdoutTruncated = stdoutTruncated || captured.truncated;
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      const captured = appendCapped(stderr, chunk, MAX_OUTPUT_BYTES);
      stderr = captured.value;
      stderrTruncated = stderrTruncated || captured.truncated;
    });
    proc.on("close", (code) => {
      input.signal?.removeEventListener("abort", onAbort);
      finish({ stdout, stderr, stdoutTruncated, stderrTruncated, code, timedOut, aborted });
    });
    proc.stdin.end(input.prompt);

    if (input.signal?.aborted) {
      onAbort();
    }
  });
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

export function reviewerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  next.PI_REVIEW_GATE_DISABLED = "1";
  next.LITTLE_CODER_REVIEW_GATE_DISABLED = "1";
  delete next.PI_EXTRA_EXTENSIONS;
  delete next.LITTLE_CODER_EXTRA_EXTENSIONS;
  return next;
}
