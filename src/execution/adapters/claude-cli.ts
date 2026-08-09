import { randomUUID } from "node:crypto";
import type { ClaudeExecutorConfig } from "../../config";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import { extractReviewTextFromClaudeJson, parseClaudeUsage } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../types";

export class ClaudeExecutorAdapter implements ExecutorAdapter {
  readonly kind = "claude-cli";
  readonly model?: string;

  constructor(private readonly config: ClaudeExecutorConfig) {
    this.model = config.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const sessionId = request.session?.id ?? randomUUID();
    const args = [
      "--print",
      "--output-format", "json",
      "--permission-mode", "auto",
      "--tools", "default",
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.args ?? []),
      ...(request.session ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ];
    const output = await runPromptProcess({
      command: this.config.command ?? "claude",
      args,
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs: this.config.timeoutMs ?? 1_800_000,
      env: reviewerEnv({ ...process.env, ...this.config.env }),
      signal: request.signal,
      onStdoutChunk: () => request.onUpdate?.("Claude executor running"),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      parsed = undefined;
    }
    const text = extractReviewTextFromClaudeJson(parsed) || output.stdout;
    const usage = parseClaudeUsage(parsed);
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      usage,
      sessionId,
      adapter: this.kind,
    });
    return {
      text,
      session: { adapter: this.kind, id: sessionId },
      usage,
      ...artifacts,
      code: output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
    };
  }
}
