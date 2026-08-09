import { randomUUID } from "node:crypto";
import type { ClaudeCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromClaudeJson, parseClaudeUsage } from "../usage";
import {
  processFailureResult,
  reviewerArtifactPaths,
  reviewerEnv,
  reviewerErrorResult,
  runPromptProcess,
  writeReviewerProcessArtifacts,
} from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class ClaudeCliAdapter implements ModelAdapter {
  readonly kind = "claude-cli";

  constructor(private readonly config: ClaudeCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const artifacts = reviewerArtifactPaths(req.bundleDir);
    const sessionId = req.session?.id ?? randomUUID();
    req.onSession?.({ adapter: this.kind, id: sessionId });
    const args = [
      "--print",
      "--output-format",
      "json",
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.args ?? []),
      ...(req.session ? ["--resume", sessionId] : ["--session-id", sessionId]),
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep,Glob",
      "--add-dir",
      req.evidenceBundleDir ?? req.bundleDir,
      "--append-system-prompt",
      "You are a read-only reviewer. You may inspect files with read-only tools, but you must not modify files, run shell commands, use network access, or ask the primary agent for more context. Return only the requested JSON.",
    ];

    const output = await runPromptProcess({
      command: this.config.command ?? "claude",
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
      signal: req.signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      parsed = undefined;
    }
    const usage = parseClaudeUsage(parsed);
    await writeReviewerProcessArtifacts({ paths: artifacts, output, usage });
    const failure = processFailureResult({
      reviewerId: req.id,
      output,
      rawOutputPath: artifacts.rawOutput,
      timeoutMs: req.timeoutMs,
      usage,
    });
    if (failure) {
      return output.code !== 0 && claudeErrorSummary(parsed)
        ? { ...failure, summary: claudeErrorSummary(parsed)! }
        : failure;
    }
    const claudeError = claudeErrorSummary(parsed);
    if (claudeError) {
      return reviewerErrorResult(req.id, claudeError, artifacts.rawOutput, "claude_error", usage);
    }

    const finalText = extractReviewTextFromClaudeJson(parsed) || output.stdout;
    const result = parseReviewResult(req.id, finalText, artifacts.rawOutput);
    result.usage = usage;
    return result;
  }
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
