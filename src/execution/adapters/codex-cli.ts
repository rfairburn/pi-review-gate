import { join } from "node:path";
import type { CodexExecutorConfig } from "../../config";
import { MAX_RETAINED_OUTPUT_BYTES, reviewerEnv, runPromptProcess } from "../../adapters/process";
import { CodexJsonlReviewExtractor, extractCodexReviewFromJsonl } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import { CodexJsonlActivityExtractor } from "../progress";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../types";
import { readBoundedTextFile } from "../../bounded-file";

export class CodexExecutorAdapter implements ExecutorAdapter {
  readonly kind = "codex-cli";
  readonly model?: string;

  constructor(private readonly config: CodexExecutorConfig) {
    this.model = config.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const activity = new CodexJsonlActivityExtractor((message) => request.onUpdate?.(message));
    const streamExtractor = new CodexJsonlReviewExtractor();
    const finalPath = join(request.artifactDir, `codex-final-${String(request.turn).padStart(4, "0")}.txt`);
    const shared = [
      "--json",
      "--output-last-message", finalPath,
      ...(this.config.model ? ["--model", this.config.model] : []),
      ...(this.config.args ?? []),
      "--skip-git-repo-check",
    ];
    const args = request.session
      ? ["exec", "resume", ...shared, request.session.id, "-"]
      : ["exec", ...shared, "--approve-for-me", "-"];
    const output = await runPromptProcess({
      command: this.config.command ?? "codex",
      args,
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs: this.config.timeoutMs ?? 1_800_000,
      env: reviewerEnv({ ...process.env, ...this.config.env }),
      signal: request.signal,
      onProcessStart: request.onProcessStart,
      onProcessExit: request.onProcessExit,
      onStdoutChunk: (chunk) => {
        streamExtractor.push(chunk);
        activity.push(chunk);
      },
    });
    activity.finish();
    const streamed = streamExtractor.finish();
    const extracted = streamed.text || streamed.sessionId || streamed.usage
      ? streamed
      : extractCodexReviewFromJsonl(output.stdout);
    const finalFile = await readBoundedTextFile(finalPath, MAX_RETAINED_OUTPUT_BYTES)
      .catch(() => ({ text: "", truncated: false }));
    const text = finalFile.text.trim() ? finalFile.text : extracted.text;
    const sessionId = extracted.sessionId ?? request.session?.id ?? "missing";
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      usage: extracted.usage,
      sessionId,
      adapter: this.kind,
    });
    return {
      text,
      session: { adapter: this.kind, id: sessionId },
      usage: extracted.usage,
      ...artifacts,
      code: output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
      failure: finalFile.truncated
        ? { category: "protocol", message: "Codex executor final output exceeded the 100 MiB limit." }
        : output.stdinError
          ? { category: "stdin", message: output.stdinError }
          : undefined,
    };
  }
}
