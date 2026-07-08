import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenericCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { reviewerEnv, runPromptProcess } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class GenericCliAdapter implements ModelAdapter {
  readonly kind = "generic-cli";

  constructor(private readonly config: GenericCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const processResultPath = join(req.bundleDir, "process-result.json");
    const timeoutMs = req.timeoutMs || this.config.timeoutMs || 300_000;
    const output = await runPromptProcess({
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs,
      env: reviewerEnv(process.env),
      signal: req.signal,
    });

    await Promise.all([
      writeFile(rawOutputPath, output.stdout, "utf8"),
      writeFile(stderrPath, output.stderr, "utf8"),
      writeFile(processResultPath, JSON.stringify({
        code: output.code,
        timedOut: output.timedOut,
        aborted: output.aborted,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
      }, null, 2), "utf8"),
    ]);

    if (output.aborted) {
      return errorResult(req.id, "Reviewer was aborted.", rawOutputPath, "aborted");
    }
    if (output.timedOut) {
      return errorResult(req.id, `Reviewer timed out after ${timeoutMs}ms.`, rawOutputPath, "timeout");
    }
    if (output.code !== 0) {
      return errorResult(req.id, `Reviewer exited with status ${output.code}.`, rawOutputPath, `exit_${output.code}`);
    }
    return parseReviewResult(req.id, output.stdout, rawOutputPath);
  }
}

function errorResult(reviewerId: string, summary: string, rawOutputPath: string, error: string): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error };
}
