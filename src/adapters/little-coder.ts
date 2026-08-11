import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LittleCoderDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../usage";
import { PiJsonlActivityExtractor } from "../execution/progress";
import {
  processFailureResult,
  processTelemetry,
  reviewerArtifactPaths,
  reviewerEnv,
  reviewerErrorResult,
  runPromptProcess,
  writeReviewerProcessArtifacts,
} from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";
import { withLittleCoderThinkingBudget } from "../little-coder-thinking";

export class LittleCoderAdapter implements ModelAdapter {
  readonly kind = "little-coder-model";

  constructor(
    private readonly config: LittleCoderDeciderConfig,
    private readonly dependencies: { runPromptProcess?: typeof runPromptProcess } = {},
  ) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const thinkingLevel = this.config.thinkingLevel ?? "high";
    const artifacts = reviewerArtifactPaths(req.bundleDir);
    const rawStreamPath = join(req.bundleDir, "raw-stream.jsonl");
    const sessionId = req.session?.id ?? randomUUID();
    // Keep runtime session history with the private reviewer staging directory,
    // never in the evidence bundle where this or a sibling reviewer can inspect it.
    const sessionDir = join(req.bundleDir, "session");
    await mkdir(sessionDir, { recursive: true });
    req.onSession?.({ adapter: this.kind, id: sessionId });
    const streamExtractor = new PiJsonlReviewExtractor();
    const activity = new PiJsonlActivityExtractor(
      (message) => req.onUpdate?.(message),
      { includeModelUpdates: false },
    );
    const args = [
      "--model",
      this.config.model,
      "--mode",
      "json",
      "--print",
      "--thinking",
      thinkingLevel,
      ...(this.config.args ?? []),
      "--session-id",
      sessionId,
      "--session-dir",
      sessionDir,
      "--no-tools",
      "--tools",
      "read,grep,find,ls",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      "--system-prompt",
      readOnlyReviewerSystemPrompt(),
    ];

    const output = await (this.dependencies.runPromptProcess ?? runPromptProcess)({
      command: this.config.command ?? "little-coder",
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: withLittleCoderThinkingBudget(
        reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
        this.config.model,
        thinkingLevel,
      ),
      signal: req.signal,
      onStdoutChunk: (chunk) => {
        streamExtractor.push(chunk);
        activity.push(chunk);
      },
    });
    activity.finish();
    const streamExtracted = streamExtractor.finish();
    const extracted = streamExtracted.text.trim() ? streamExtracted : extractReviewTextFromPiJsonl(output.stdout);
    const rawOutputText = extracted.text.trim()
      ? extracted.text
      : extracted.terminalError
        ? providerFailureDiagnostic(extracted.terminalError, output)
        : missingFinalTextDiagnostic(output);
    await Promise.all([
      writeFile(rawStreamPath, output.stdout, "utf8"),
      writeReviewerProcessArtifacts({
        paths: artifacts,
        output,
        rawOutput: rawOutputText,
        usage: extracted.usage,
        metadata: {
          finalTextCaptured: extracted.text.trim().length > 0,
          terminalProviderError: extracted.terminalError,
          stdoutBytesCaptured: Buffer.byteLength(output.stdout),
          rawOutputContainsStream: false,
          rawStreamPath: "raw-stream.jsonl",
        },
      }),
    ]);

    const failure = processFailureResult({
      reviewerId: req.id,
      output,
      rawOutputPath: artifacts.rawOutput,
      timeoutMs: req.timeoutMs,
      usage: extracted.usage,
    });
    if (failure) return failure;
    if (extracted.terminalError) {
      return {
        ...reviewerErrorResult(
          req.id,
          "Reviewer provider failed before producing a final response.",
          artifacts.rawOutput,
          "provider_error",
          extracted.usage,
        ),
        diagnostic: extracted.terminalError,
        telemetry: processTelemetry(output),
      };
    }
    if (!extracted.text.trim()) {
      const summary = output.stdoutTruncated
        ? "Reviewer output was truncated before a final assistant text was captured."
        : "Reviewer did not produce final assistant text.";
      return {
        ...reviewerErrorResult(
        req.id,
        summary,
        artifacts.rawOutput,
        output.stdoutTruncated ? "output_truncated" : "missing_final_text",
        extracted.usage,
        ),
        telemetry: processTelemetry(output),
      };
    }

    const result = parseReviewResult(req.id, extracted.text, artifacts.rawOutput);
    result.usage = extracted.usage;
    result.telemetry = processTelemetry(output);
    return result;
  }
}

function missingFinalTextDiagnostic(output: {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}): string {
  return [
    "No final assistant text was captured from the little-coder JSONL stream.",
    `exitCode: ${output.code === null ? "null" : output.code}`,
    `timedOut: ${output.timedOut}`,
    `aborted: ${output.aborted}`,
    `stdoutTruncated: ${output.stdoutTruncated}`,
    `stderrTruncated: ${output.stderrTruncated}`,
  ].join("\n");
}

function providerFailureDiagnostic(error: string, output: {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}): string {
  return [
    "The little-coder stream ended with a provider error before final assistant text was produced.",
    `providerError: ${error}`,
    `exitCode: ${output.code === null ? "null" : output.code}`,
    `timedOut: ${output.timedOut}`,
    `aborted: ${output.aborted}`,
  ].join("\n");
}

function readOnlyReviewerSystemPrompt(): string {
  return [
    "You are an independent read-only code reviewer.",
    "You have exactly these tools available: read, grep, find, and ls.",
    "Use those tools as needed to inspect the current workspace and the supplied review bundle.",
    "Do not inspect session/runtime streams or reviewer output directories; they are not review evidence.",
    "Do not modify files, run shell commands, use network access, or ask the primary agent for more context.",
    "Return only valid JSON matching the requested schema.",
  ].join(" ");
}
