import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodexCliDeciderConfig } from "../config";
import { parseReviewResult, REVIEW_OUTPUT_JSON_SCHEMA, type ReviewResult } from "../schema";
import { CodexJsonlReviewExtractor, extractCodexReviewFromJsonl } from "../usage";
import {
  processFailureResult,
  type ProcessRunResult,
  processTelemetry,
  MAX_RETAINED_OUTPUT_BYTES,
  reviewerArtifactPaths,
  reviewerEnv,
  reviewerErrorResult,
  runPromptProcess,
  writeReviewerProcessArtifacts,
} from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";
import { readBoundedTextFile } from "../bounded-file";
import { CodexJsonlActivityExtractor } from "../execution/progress";

export class CodexCliAdapter implements ModelAdapter {
  readonly kind = "codex-cli";

  constructor(private readonly config: CodexCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const artifacts = reviewerArtifactPaths(req.bundleDir);
    const finalPath = join(req.bundleDir, "reviewer-final.txt");
    const outputSchemaPath = join(req.bundleDir, "review-output-schema.json");
    await writeFile(outputSchemaPath, JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA, null, 2), "utf8");
    const command = this.config.command ?? "codex";
    let preflight: ProcessRunResult | undefined;
    if (shouldPreflightSandbox(command, this.config.args)) {
      req.onUpdate?.("sandbox preflight started");
      preflight = await runPromptProcess({
        command,
        args: codexSandboxPreflightArgs(),
        cwd: req.cwd,
        prompt: "",
        timeoutMs: Math.min(req.timeoutMs, 10_000),
        env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
        signal: req.signal,
      });
      if (codexSandboxFailed(preflight.stderr)) {
        req.onUpdate?.("sandbox preflight failed");
        await writeReviewerProcessArtifacts({ paths: artifacts, output: preflight });
        return {
          ...reviewerErrorResult(
          req.id,
          "Codex reviewer could not inspect the evidence because its read-only filesystem sandbox failed to start.",
          artifacts.rawOutput,
          "sandbox_unavailable",
          undefined,
          ),
          telemetry: processTelemetry(preflight),
          processSettlement: preflight.processSettlement,
          diagnostic: preflight.terminationError,
        };
      }
      req.onUpdate?.("sandbox preflight completed");
    }
    const args = req.session
      ? [
        "exec",
        "resume",
        "--json",
        "--output-last-message",
        finalPath,
        ...(this.config.model ? ["--model", this.config.model] : []),
        ...(this.config.args ?? []),
        "--skip-git-repo-check",
        req.session.id,
        "-",
      ]
      : [
        "exec",
        "--json",
        "--output-last-message",
        finalPath,
        ...(this.config.model ? ["--model", this.config.model] : []),
        ...(this.config.args ?? []),
        "--sandbox",
        "read-only",
        "--output-schema",
        outputSchemaPath,
        "--skip-git-repo-check",
        "-",
      ];

    const streamExtractor = new CodexJsonlReviewExtractor();
    const activityExtractor = new CodexJsonlActivityExtractor(
      (message) => req.onUpdate?.(message),
      { includeModelUpdates: false },
    );
    const output = await runPromptProcess({
      command,
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
      signal: req.signal,
      onStdoutChunk: (chunk) => {
        streamExtractor.push(chunk);
        activityExtractor.push(chunk);
      },
    });
    // Both owned launches contribute: a confirmed main child cannot conceal
    // an uncertain preflight child.
    if (preflight) {
      output.processSettlement = preflight.processSettlement === "confirmed" && output.processSettlement === "confirmed"
        ? "confirmed" : "unconfirmed";
      output.terminationError = [preflight.terminationError, output.terminationError].filter(Boolean).join("\n") || undefined;
    }
    activityExtractor.finish();
    const streamed = streamExtractor.finish();
    const extracted = streamed.text || streamed.sessionId || streamed.usage
      ? streamed
      : extractCodexReviewFromJsonl(output.stdout);
    const usage = extracted.usage;
    const sessionId = extracted.sessionId ?? req.session?.id;
    if (sessionId) {
      req.onSession?.({ adapter: this.kind, id: sessionId });
    }
    await writeReviewerProcessArtifacts({ paths: artifacts, output, usage });
    const failure = processFailureResult({
      reviewerId: req.id,
      output,
      rawOutputPath: artifacts.rawOutput,
      timeoutMs: req.timeoutMs,
      usage,
    });
    if (failure) return failure;

    const finalFile = await readBoundedTextFile(finalPath, MAX_RETAINED_OUTPUT_BYTES)
      .catch(() => ({ text: "", truncated: false }));
    if (finalFile.truncated) {
      return {
        ...reviewerErrorResult(req.id, "Codex reviewer final output exceeded the 100 MiB limit.", artifacts.rawOutput, "output_truncated", usage),
        telemetry: processTelemetry(output),
        processSettlement: output.processSettlement,
        diagnostic: output.terminationError,
      };
    }
    const finalText = finalFile.text.trim() ? finalFile.text : extracted.text || output.stdout;
    const result = parseReviewResult(req.id, finalText, artifacts.rawOutput);
    result.usage = usage;
    result.telemetry = processTelemetry(output);
    result.processSettlement = output.processSettlement;
    result.diagnostic = output.terminationError;
    if (result.verdict === "error" && codexSandboxFailed(output.stderr)) {
      return {
        ...reviewerErrorResult(
        req.id,
        "Codex reviewer could not inspect the evidence because its read-only filesystem sandbox failed to start.",
        artifacts.rawOutput,
        "sandbox_unavailable",
        usage,
        ),
        telemetry: processTelemetry(output),
        processSettlement: output.processSettlement,
        diagnostic: output.terminationError,
      };
    }
    return result;
  }
}

export function codexSandboxPreflightArgs(): string[] {
  return ["sandbox", "--permissions-profile", ":read-only", process.execPath, "-e", ""];
}

function codexSandboxFailed(stderr: string): boolean {
  return /fs sandbox helper failed|\bbwrap:|sandbox[^\n]*failed/i.test(stderr);
}

function shouldPreflightSandbox(command: string, args: string[] | undefined): boolean {
  return basename(command) === "codex"
    && !args?.includes("--dangerously-bypass-approvals-and-sandbox");
}
