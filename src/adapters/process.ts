import { spawn } from "node:child_process";

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
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
  return await new Promise((resolve, reject) => {
    const proc = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: ProcessRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      finish({ stdout, stderr, code: null, timedOut });
    }, input.timeoutMs);

    input.signal?.addEventListener("abort", () => {
      proc.kill("SIGTERM");
      finish({ stdout, stderr, code: null, timedOut: false });
    });

    proc.on("error", reject);
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
      finish({ stdout, stderr, code, timedOut });
    });
    proc.stdin.end(input.prompt);
  });
}

export function reviewerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  next.PI_REVIEW_GATE_DISABLED = "1";
  next.LITTLE_CODER_REVIEW_GATE_DISABLED = "1";
  delete next.PI_EXTRA_EXTENSIONS;
  delete next.LITTLE_CODER_EXTRA_EXTENSIONS;
  return next;
}
