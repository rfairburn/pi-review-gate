import { randomUUID } from "node:crypto";
import type { ClaudeExecutorConfig } from "../../config";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import { parseClaudeUsage } from "../../usage";
import { ClaudeStreamJsonParser, ClaudeStreamActivityExtractor } from "../progress";
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
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "auto",
      "--tools", "default",
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.args ?? []),
      ...(request.session ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ];

    const parser = new ClaudeStreamJsonParser();
    const activityExtractor = new ClaudeStreamActivityExtractor(
      (message) => request.onUpdate?.(message),
      { includeModelUpdates: true },
    );

    const output = await runPromptProcess({
      command: this.config.command ?? "claude",
      args,
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs: this.config.timeoutMs ?? 1_800_000,
      env: reviewerEnv({ ...process.env, ...this.config.env }),
      signal: request.signal,
      onProcessStart: request.onProcessStart,
      onProcessExit: request.onProcessExit,
      onStdoutChunk: (chunk) => {
        parser.push(chunk);
        activityExtractor.push(chunk);
      },
    });

    activityExtractor.finish();
    const parsed = parser.finish();
    const text = parsed.text;
    const usage = parseClaudeUsage(parsed.resultEnvelope);
    const effectiveSessionId = parsed.sessionId ?? sessionId;
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      usage,
      sessionId: effectiveSessionId,
      adapter: this.kind,
    });
    return {
      text,
      session: { adapter: this.kind, id: effectiveSessionId },
      usage,
      ...artifacts,
      code: parsed.error && output.code === 0 ? 1 : output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
      failure: parsed.error
        ? { category: "provider", message: parsed.error }
        : output.stdinError
          ? { category: "stdin", message: output.stdinError }
          : undefined,
    };
  }
}
