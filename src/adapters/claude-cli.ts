import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromClaudeJson, parseClaudeUsage } from "../usage";
import { reviewerEnv, runPromptProcess } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class ClaudeCliAdapter implements ModelAdapter {
  readonly kind = "claude-cli";

  constructor(private readonly config: ClaudeCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const usagePath = join(req.bundleDir, "usage.json");
    const args = [
      "--print",
      "--output-format",
      "json",
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.args ?? []),
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep,Glob",
      "--add-dir",
      req.bundleDir,
      "--append-system-prompt",
      "You are a read-only reviewer. You may inspect files with read-only tools, but you must not modify files, run shell commands, use network access, or ask the primary agent for more context. Return only the requested JSON.",
    ];

    const output = await runPromptProcess({
      command: this.config.command ?? "claude",
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      parsed = undefined;
    }
    const usage = parseClaudeUsage(parsed);
    await writeFile(usagePath, JSON.stringify(usage ?? null, null, 2), "utf8").catch(() => undefined);

    if (output.aborted) {
      return errorResult(req.id, "Reviewer was aborted.", rawOutputPath, "aborted", usage);
    }
    if (output.timedOut) {
      return errorResult(req.id, `Reviewer timed out after ${req.timeoutMs}ms.`, rawOutputPath, "timeout", usage);
    }
    if (output.code !== 0) {
      return errorResult(req.id, claudeErrorSummary(parsed) ?? `Reviewer exited with status ${output.code}.`, rawOutputPath, `exit_${output.code}`, usage);
    }
    const claudeError = claudeErrorSummary(parsed);
    if (claudeError) {
      return errorResult(req.id, claudeError, rawOutputPath, "claude_error", usage);
    }

    const finalText = extractReviewTextFromClaudeJson(parsed) || output.stdout;
    const result = parseReviewResult(req.id, finalText, rawOutputPath);
    result.usage = usage;
    return result;
  }
}

function errorResult(reviewerId: string, summary: string, rawOutputPath: string, error: string, usage: ReviewResult["usage"]): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error, usage };
}

function claudeErrorSummary(value: unknown): string | undefined {
  if (!isRecord(value) || value.is_error !== true) {
    return undefined;
  }
  const status = typeof value.api_error_status === "number" ? `Claude API ${value.api_error_status}` : "Claude API error";
  const result = typeof value.result === "string" && value.result.trim() ? value.result.trim() : undefined;
  return result ? `${status}: ${result}` : status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
