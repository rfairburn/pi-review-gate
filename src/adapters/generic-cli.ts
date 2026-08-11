import type { GenericCliDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { processFailureResult, processTelemetry, reviewerArtifactPaths, reviewerEnv, runPromptProcess, writeReviewerProcessArtifacts } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class GenericCliAdapter implements ModelAdapter {
  readonly kind = "generic-cli";

  constructor(private readonly config: GenericCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const artifacts = reviewerArtifactPaths(req.bundleDir);
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs ?? 300_000;
    const output = await runPromptProcess({
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs,
      env: reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir),
      signal: req.signal,
    });

    await writeReviewerProcessArtifacts({ paths: artifacts, output });
    const failure = processFailureResult({
      reviewerId: req.id,
      output,
      rawOutputPath: artifacts.rawOutput,
      timeoutMs,
    });
    if (failure) return failure;
    const result = parseReviewResult(req.id, output.stdout, artifacts.rawOutput);
    result.telemetry = processTelemetry(output);
    return result;
  }
}
