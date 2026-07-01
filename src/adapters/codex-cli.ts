import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { parseCodexUsageFromJsonl } from "../usage";
import { reviewerEnv, runPromptProcess } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class CodexCliAdapter implements ModelAdapter {
  readonly kind = "codex-cli";

  constructor(private readonly config: CodexCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const finalPath = join(req.bundleDir, "reviewer-final.txt");
    const usagePath = join(req.bundleDir, "usage.json");
    const args = [
      "exec",
      "--json",
      "--output-last-message",
      finalPath,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.args ?? []),
      "-",
    ];

    const output = await runPromptProcess({
      command: this.config.command ?? "codex",
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

    const usage = parseCodexUsageFromJsonl(output.stdout);
    await writeFile(usagePath, JSON.stringify(usage ?? null, null, 2), "utf8").catch(() => undefined);

    if (output.timedOut) {
      return errorResult(req.id, `Reviewer timed out after ${req.timeoutMs}ms.`, rawOutputPath, "timeout", usage);
    }
    if (output.code !== 0) {
      return errorResult(req.id, `Reviewer exited with status ${output.code}.`, rawOutputPath, `exit_${output.code}`, usage);
    }

    const finalText = await readFile(finalPath, "utf8").catch(() => output.stdout);
    const result = parseReviewResult(req.id, finalText, rawOutputPath);
    result.usage = usage;
    return result;
  }
}

function errorResult(reviewerId: string, summary: string, rawOutputPath: string, error: string, usage: ReviewResult["usage"]): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error, usage };
}
