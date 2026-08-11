import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexExecutorConfig } from "../../config";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import { extractCodexReviewFromJsonl } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import { CodexJsonlActivityExtractor } from "../progress";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../types";

export class CodexExecutorAdapter implements ExecutorAdapter {
  readonly kind = "codex-cli";
  readonly model?: string;

  constructor(private readonly config: CodexExecutorConfig) {
    this.model = config.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const activity = new CodexJsonlActivityExtractor((message) => request.onUpdate?.(message));
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
      onStdoutChunk: (chunk) => activity.push(chunk),
    });
    activity.finish();
    const extracted = extractCodexReviewFromJsonl(output.stdout);
    const fileText = await readFile(finalPath, "utf8").catch(() => "");
    const text = fileText.trim() ? fileText : extracted.text;
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
    };
  }
}
