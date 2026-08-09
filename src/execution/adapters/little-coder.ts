import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import { PiJsonlActivityExtractor } from "../progress";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../types";
import type { ThinkingLevel } from "../../config";

export interface LittleCoderExecutorOptions {
  model: string;
  thinkingLevel?: ThinkingLevel;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export class LittleCoderExecutorAdapter implements ExecutorAdapter {
  readonly kind = "little-coder-model";
  readonly model: string;

  constructor(private readonly options: LittleCoderExecutorOptions) {
    this.model = options.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const sessionId = request.session?.id ?? randomUUID();
    const sessionDir = join(request.artifactDir, "executor-sessions");
    await mkdir(sessionDir, { recursive: true });
    const extractor = new PiJsonlReviewExtractor();
    const activity = new PiJsonlActivityExtractor((message) => request.onUpdate?.(message));
    const args = [
      "--model", this.options.model,
      "--mode", "json",
      "--print",
      "--thinking", this.options.thinkingLevel ?? "high",
      "--session-id", sessionId,
      "--session-dir", sessionDir,
      "--approve",
      ...(this.options.args ?? []),
    ];
    const output = await runPromptProcess({
      command: this.options.command ?? "little-coder",
      args,
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs: this.options.timeoutMs ?? 1_800_000,
      env: executorEnv(),
      signal: request.signal,
      onStdoutChunk: (chunk) => {
        extractor.push(chunk);
        activity.push(chunk);
      },
    });
    activity.finish();
    const streamed = extractor.finish();
    const extracted = streamed.text.trim() ? streamed : extractReviewTextFromPiJsonl(output.stdout);
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text: extracted.text,
      usage: extracted.usage,
      sessionId,
      adapter: this.kind,
    });
    return {
      text: extracted.text,
      session: { adapter: this.kind, id: sessionId },
      usage: extracted.usage,
      ...artifacts,
      code: output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
    };
  }
}

function executorEnv(): NodeJS.ProcessEnv {
  const env = reviewerEnv(process.env);
  // Keep normal little-coder extensions except this gate; the kill-switch is
  // authoritative and prevents nested automatic review.
  if (process.env.LITTLE_CODER_EXTRA_EXTENSIONS) {
    env.LITTLE_CODER_EXTRA_EXTENSIONS = process.env.LITTLE_CODER_EXTRA_EXTENSIONS;
  }
  if (process.env.PI_EXTRA_EXTENSIONS) {
    env.PI_EXTRA_EXTENSIONS = process.env.PI_EXTRA_EXTENSIONS;
  }
  return env;
}
