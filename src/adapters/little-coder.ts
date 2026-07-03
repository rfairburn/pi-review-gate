import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LittleCoderDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromPiJsonl } from "../usage";
import { reviewerEnv, runPromptProcess } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class LittleCoderAdapter implements ModelAdapter {
  readonly kind = "little-coder-model";

  constructor(private readonly config: LittleCoderDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const usagePath = join(req.bundleDir, "usage.json");
    const args = [
      "--model",
      this.config.model,
      "--mode",
      "json",
      "--print",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      ...(this.config.args ?? []),
    ];

    const output = await runPromptProcess({
      command: this.config.command ?? "little-coder",
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv(process.env),
      signal: req.signal,
    });
    await Promise.all([
      writeFile(rawOutputPath, output.stdout, "utf8"),
      writeFile(stderrPath, output.stderr, "utf8"),
    ]);

    const extracted = extractReviewTextFromPiJsonl(output.stdout);
    await writeFile(usagePath, JSON.stringify(extracted.usage ?? null, null, 2), "utf8").catch(() => undefined);

    if (output.aborted) {
      return errorResult(req.id, "Reviewer was aborted.", rawOutputPath, "aborted", extracted.usage);
    }
    if (output.timedOut) {
      return errorResult(req.id, `Reviewer timed out after ${req.timeoutMs}ms.`, rawOutputPath, "timeout", extracted.usage);
    }
    if (output.code !== 0) {
      return errorResult(req.id, `Reviewer exited with status ${output.code}.`, rawOutputPath, `exit_${output.code}`, extracted.usage);
    }

    const result = parseReviewResult(req.id, extracted.text || output.stdout, rawOutputPath);
    result.usage = extracted.usage;
    return result;
  }
}

function errorResult(reviewerId: string, summary: string, rawOutputPath: string, error: string, usage: ReviewResult["usage"]): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error, usage };
}
