import { randomUUID } from "node:crypto";
import type { RunAsBinaryExecutorConfig } from "../../config";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import type { TokenUsage } from "../../usage";
import { writeExecutorArtifacts } from "../artifacts";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../types";

export class RunAsBinaryExecutorAdapter implements ExecutorAdapter {
  readonly kind = "run-as-binary";

  constructor(private readonly config: RunAsBinaryExecutorConfig) {}

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const requestedSessionId = request.session?.id ?? randomUUID();
    const output = await runPromptProcess({
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: request.cwd,
      prompt: request.prompt,
      timeoutMs: this.config.timeoutMs ?? 1_800_000,
      env: {
        ...reviewerEnv({ ...process.env, ...this.config.env }),
        PI_REVIEW_EXECUTOR_PROTOCOL: this.config.protocol,
        PI_REVIEW_EXECUTOR_OPERATION: request.session ? "resume" : "start",
        PI_REVIEW_EXECUTOR_SESSION_ID: requestedSessionId,
        PI_REVIEW_EXECUTOR_TURN: String(request.turn),
      },
      signal: request.signal,
      onStdoutChunk: () => request.onUpdate?.("binary executor running"),
    });
    const parsed = parseProtocol(output.stdout);
    const sessionId = parsed.sessionId ?? requestedSessionId;
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text: parsed.text,
      usage: parsed.usage,
      sessionId,
      adapter: this.kind,
    });
    return {
      text: parsed.text,
      session: { adapter: this.kind, id: sessionId },
      usage: parsed.usage,
      ...artifacts,
      code: output.code,
      timedOut: output.timedOut,
      aborted: output.aborted,
    };
  }
}

function parseProtocol(stdout: string): { text: string; sessionId?: string; usage?: TokenUsage } {
  let text = "";
  let sessionId: string | undefined;
  let usage: TokenUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    if (value.type === "session" && typeof value.sessionId === "string") {
      sessionId = value.sessionId;
    }
    if (value.type === "assistant" && typeof value.text === "string") {
      text = value.text;
    }
    if (value.type === "usage" && isRecord(value.usage)) {
      usage = { scope: "invocation", raw: value.usage };
    }
  }
  return { text, sessionId, usage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
