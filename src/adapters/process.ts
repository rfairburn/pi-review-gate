import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
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
}): Promise<ProcessRunResult> {
  if (input.signal?.aborted) {
    return { stdout: "", stderr: "", code: null, timedOut: false, aborted: true };
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
      if (Buffer.byteLength(stdout) < MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) < MAX_OUTPUT_BYTES) {
        stderr += chunk;
      }
    });
    proc.on("close", (code) => {
      input.signal?.removeEventListener("abort", onAbort);
      finish({ stdout, stderr, code, timedOut, aborted });
    });
    proc.stdin.end(input.prompt);

    if (input.signal?.aborted) {
      onAbort();
    }
  });
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
