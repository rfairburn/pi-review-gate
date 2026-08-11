import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodexCliDeciderConfig } from "../config";
import { parseReviewResult, REVIEW_OUTPUT_JSON_SCHEMA, type ReviewResult } from "../schema";
import { extractCodexReviewFromJsonl } from "../usage";
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

export class CodexCliAdapter implements ModelAdapter {
  readonly kind = "codex-cli";

  constructor(private readonly config: CodexCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const artifacts = reviewerArtifactPaths(req.bundleDir);
    const finalPath = join(req.bundleDir, "reviewer-final.txt");
    const outputSchemaPath = join(req.bundleDir, "review-output-schema.json");
    await writeFile(outputSchemaPath, JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA, null, 2), "utf8");
    const command = this.config.command ?? "codex";
    if (shouldPreflightSandbox(command, this.config.args)) {
      const preflight = await runPromptProcess({
        command,
        args: codexSandboxPreflightArgs(),
        cwd: req.cwd,
        prompt: "",
        timeoutMs: Math.min(req.timeoutMs, 10_000),
        env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
        signal: req.signal,
      });
      if (codexSandboxFailed(preflight.stderr)) {
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
        };
      }
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

    const output = await runPromptProcess({
      command,
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
      signal: req.signal,
    });
    const extracted = extractCodexReviewFromJsonl(output.stdout);
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

    const finalTextFromFile = await readFile(finalPath, "utf8").catch(() => "");
    const finalText = finalTextFromFile.trim() ? finalTextFromFile : extracted.text || output.stdout;
    const result = parseReviewResult(req.id, finalText, artifacts.rawOutput);
    result.usage = usage;
    result.telemetry = processTelemetry(output);
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
