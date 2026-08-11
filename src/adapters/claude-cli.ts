import { randomUUID } from "node:crypto";
import type { ClaudeCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { parseClaudeUsage } from "../usage";
import { ClaudeStreamJsonParser, ClaudeStreamActivityExtractor } from "../execution/progress";
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
      "stream-json",
      "--verbose",
      "--include-partial-messages",
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

    const parser = new ClaudeStreamJsonParser();
    const activityExtractor = new ClaudeStreamActivityExtractor(
      (message) => req.onUpdate?.(message),
      { includeModelUpdates: false },
    );

    const output = await runPromptProcess({
      command: this.config.command ?? "claude",
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
      signal: req.signal,
      onStdoutChunk: (chunk) => {
        parser.push(chunk);
        activityExtractor.push(chunk);
      },
    });

    activityExtractor.finish();
    const parsed = parser.finish();
    const usage = parseClaudeUsage(parsed.resultEnvelope);
    await writeReviewerProcessArtifacts({ paths: artifacts, output, usage });

    const failure = processFailureResult({
      reviewerId: req.id,
      output,
      rawOutputPath: artifacts.rawOutput,
      timeoutMs: req.timeoutMs,
      usage,
    });
    if (failure) {
      return parsed.error ? { ...failure, summary: parsed.error } : failure;
    }
    if (parsed.error) {
      return reviewerErrorResult(req.id, parsed.error, artifacts.rawOutput, "claude_error", usage);
    }

    const result = parseReviewResult(req.id, parsed.text, artifacts.rawOutput);
    result.usage = usage;
    return result;
  }
}
