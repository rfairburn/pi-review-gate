import { randomUUID } from "node:crypto";
import type { RunAsBinaryExecutorConfig } from "../../config";
import { reviewerEnv, runPromptProcess } from "../../adapters/process";
import type { TokenUsage } from "../../usage";
import { BoundedJsonlDecoder } from "../../jsonl";
import { writeExecutorArtifacts } from "../artifacts";
import type { ExecutorAdapter, ExecutorRequest, ExecutorTurn } from "../types";

export class RunAsBinaryExecutorAdapter implements ExecutorAdapter {
  readonly kind = "run-as-binary";

  constructor(private readonly config: RunAsBinaryExecutorConfig) {}

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    const requestedSessionId = request.session?.id ?? randomUUID();
    const protocol = new RunAsBinaryProtocolParser();
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
      onProcessStart: request.onProcessStart,
      onProcessExit: request.onProcessExit,
      onStdoutChunk: (chunk) => {
        protocol.push(chunk);
        request.onUpdate?.("binary executor running");
      },
    });
    const parsed = protocol.finish();
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
      failure: output.stdinError ? { category: "stdin", message: output.stdinError } : undefined,
    };
  }
}

class RunAsBinaryProtocolParser {
  private text = "";
  private sessionId: string | undefined;
  private usage: TokenUsage | undefined;
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): { text: string; sessionId?: string; usage?: TokenUsage } {
    this.decoder.finish();
    return { text: this.text, sessionId: this.sessionId, usage: this.usage };
  }

  private processLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "session" && typeof value.sessionId === "string") {
      this.sessionId = value.sessionId;
    }
    if (value.type === "assistant" && typeof value.text === "string") {
      this.text = value.text;
    }
    if (value.type === "usage" && isRecord(value.usage)) {
      this.usage = { scope: "invocation", raw: value.usage };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
