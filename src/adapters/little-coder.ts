import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LittleCoderDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../usage";
import { reviewerEnv, runPromptProcess } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class LittleCoderAdapter implements ModelAdapter {
  readonly kind = "little-coder-model";

  constructor(private readonly config: LittleCoderDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const rawStreamPath = join(req.bundleDir, "raw-stream.jsonl");
    const finalOutputPath = join(req.bundleDir, "reviewer-final.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const usagePath = join(req.bundleDir, "usage.json");
    const processResultPath = join(req.bundleDir, "process-result.json");
    const streamExtractor = new PiJsonlReviewExtractor();
    const args = [
      "--model",
      this.config.model,
      "--mode",
      "json",
      "--print",
      ...(this.config.args ?? []),
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

    const output = await runPromptProcess({
      command: this.config.command ?? "little-coder",
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv(process.env),
      signal: req.signal,
      onStdoutChunk: (chunk) => streamExtractor.push(chunk),
    });
    const streamExtracted = streamExtractor.finish();
    const cappedExtracted = extractReviewTextFromPiJsonl(output.stdout);
    const extracted = streamExtracted.text.trim() ? streamExtracted : cappedExtracted;
    const rawOutputText = extracted.text.trim() ? extracted.text : missingFinalTextDiagnostic(output);
    await Promise.all([
      writeFile(rawOutputPath, rawOutputText, "utf8"),
      writeFile(rawStreamPath, output.stdout, "utf8"),
      writeFile(finalOutputPath, extracted.text, "utf8"),
      writeFile(stderrPath, output.stderr, "utf8"),
      writeFile(processResultPath, JSON.stringify({
        code: output.code,
        timedOut: output.timedOut,
        aborted: output.aborted,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
        finalTextCaptured: extracted.text.trim().length > 0,
        stdoutBytesCaptured: Buffer.byteLength(output.stdout),
        rawOutputContainsStream: false,
        rawStreamPath,
      }, null, 2), "utf8"),
    ]);

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
    if (!extracted.text.trim()) {
      const summary = output.stdoutTruncated
        ? "Reviewer output was truncated before a final assistant text was captured."
        : "Reviewer did not produce final assistant text.";
      return errorResult(req.id, summary, rawOutputPath, output.stdoutTruncated ? "output_truncated" : "missing_final_text", extracted.usage);
    }

    const result = parseReviewResult(req.id, extracted.text, rawOutputPath);
    result.usage = extracted.usage;
    return result;
  }
}

function errorResult(reviewerId: string, summary: string, rawOutputPath: string, error: string, usage: ReviewResult["usage"]): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error, usage };
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

function readOnlyReviewerSystemPrompt(): string {
  return [
    "You are an independent read-only code reviewer.",
    "You have exactly these tools available: read, grep, find, and ls.",
    "Use those tools as needed to inspect the current workspace and the supplied review bundle.",
    "Do not modify files, run shell commands, use network access, or ask the primary agent for more context.",
    "Return only valid JSON matching the requested schema.",
  ].join(" ");
}
