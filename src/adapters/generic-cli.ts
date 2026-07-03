import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenericCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

const MAX_OUTPUT_BYTES = 1_000_000;

export class GenericCliAdapter implements ModelAdapter {
  readonly kind = "generic-cli";

  constructor(private readonly config: GenericCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const args = this.config.args ?? [];
    const timeoutMs = req.timeoutMs || this.config.timeoutMs || 300_000;

    return await new Promise<ReviewResult>((resolve) => {
      const proc = spawn(this.config.command, args, {
        cwd: req.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedEnv(process.env),
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = async (result: ReviewResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        await Promise.all([
          writeFile(rawOutputPath, stdout, "utf8").catch(() => undefined),
          writeFile(stderrPath, stderr, "utf8").catch(() => undefined),
        ]);
        resolve(result);
      };

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        void finish({
          reviewerId: req.id,
          verdict: "error",
          summary: `Reviewer timed out after ${timeoutMs}ms.`,
          findings: [],
          rawOutputPath,
          error: "timeout",
        });
      }, timeoutMs);

      req.signal?.addEventListener("abort", () => {
        proc.kill("SIGTERM");
        void finish({
          reviewerId: req.id,
          verdict: "error",
          summary: "Reviewer was aborted.",
          findings: [],
          rawOutputPath,
          error: "aborted",
        });
      });

      proc.on("error", (error) => {
        void finish({
          reviewerId: req.id,
          verdict: "error",
          summary: `Reviewer process failed: ${error.message}`,
          findings: [],
          rawOutputPath,
          error: error.message,
        });
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
        if (code !== 0) {
          void finish({
            reviewerId: req.id,
            verdict: "error",
            summary: `Reviewer exited with status ${code}.`,
            findings: [],
            rawOutputPath,
            error: `exit_${code}`,
          });
          return;
        }
        void finish(parseReviewResult(req.id, stdout, rawOutputPath));
      });

      proc.stdin.end(req.prompt);
    });
  }
}

function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  next.PI_REVIEW_GATE_DISABLED = "1";
  next.LITTLE_CODER_REVIEW_GATE_DISABLED = "1";
  delete next.PI_EXTRA_EXTENSIONS;
  delete next.LITTLE_CODER_EXTRA_EXTENSIONS;
  return next;
}
