import { BoundedJsonlDecoder, BoundedTextAccumulator, MEBIBYTE, utf8Prefix } from "../jsonl";

const MAX_STREAMED_TEXT_BYTES = 16 * MEBIBYTE;

export class PiJsonlActivityExtractor {
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));
  private lastModelUpdate = "";

  constructor(
    private readonly onActivity: (message: string) => void,
    private readonly options: { includeModelUpdates?: boolean } = {},
  ) {}

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): void {
    this.decoder.finish();
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.type === "turn_start") {
      this.lastModelUpdate = "";
      this.onActivity("model turn started");
      return;
    }
    if (parsed.type === "turn_end") {
      this.onActivity("model turn completed");
      return;
    }
    if (parsed.type === "message_update" && isRecord(parsed.assistantMessageEvent)) {
      const event = parsed.assistantMessageEvent;
      const eventType = event.type;
      if (eventType === "thinking_start") this.onActivity("model reasoning");
      if (eventType === "text_start") this.onActivity("model composing response");
      if (eventType === "text_end" && typeof event.content === "string") {
        this.emitModelUpdate(event.content);
      }
      if (eventType === "error") {
        const reason = typeof event.reason === "string" ? event.reason : "response failed";
        this.onActivity(`model ${reason === "aborted" ? "response aborted" : "response failed"}`);
      }
      return;
    }
    if (parsed.type === "message_end" && isRecord(parsed.message) && parsed.message.role === "assistant") {
      this.emitModelUpdate(textFromMessageContent(parsed.message.content));
      return;
    }
    if (parsed.type === "tool_execution_start" && typeof parsed.toolName === "string") {
      this.onActivity(formatToolStart(parsed.toolName, parsed.args));
      return;
    }
    if (parsed.type === "tool_execution_end" && typeof parsed.toolName === "string") {
      this.onActivity(formatToolEnd(parsed.toolName, parsed.result, parsed.isError === true));
      return;
    }
    if (parsed.type === "compaction_start") {
      this.onActivity("context compaction started");
      return;
    }
    if (parsed.type === "compaction_end") {
      const outcome = parsed.aborted === true ? "aborted" : parsed.result ? "completed" : "failed";
      this.onActivity(`context compaction ${outcome}`);
      return;
    }
    if (parsed.type === "auto_retry_start") {
      const attempt = typeof parsed.attempt === "number" ? parsed.attempt : undefined;
      const maxAttempts = typeof parsed.maxAttempts === "number" ? parsed.maxAttempts : undefined;
      const count = attempt !== undefined && maxAttempts !== undefined ? ` ${attempt}/${maxAttempts}` : "";
      const reason = typeof parsed.errorMessage === "string" && parsed.errorMessage.trim()
        ? ` · ${singleLine(parsed.errorMessage)}`
        : "";
      this.onActivity(`model retry${count}${reason}`);
      return;
    }
    if (parsed.type === "auto_retry_end") {
      this.onActivity(`model retry ${parsed.success === true ? "completed" : "failed"}`);
    }
  }

  private emitModelUpdate(text: string): void {
    const message = text.trim();
    if (this.options.includeModelUpdates === false || !message || message === this.lastModelUpdate) return;
    this.lastModelUpdate = singleLine(message);
    this.onActivity(`model update · ${singleLine(message)}`);
  }
}

/**
 * Convert `codex exec --json` events into concise, UI-only activity updates.
 * Reasoning contents and command output bodies are intentionally not emitted;
 * the tool card only receives bounded lifecycle and result summaries.
 */
export class CodexJsonlActivityExtractor {
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));

  constructor(private readonly onActivity: (message: string) => void) {}

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): void {
    this.decoder.finish();
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    if (parsed.type === "turn.started") {
      this.onActivity("model turn started");
      return;
    }
    if (parsed.type === "turn.completed") {
      this.onActivity("model turn completed");
      return;
    }
    if (parsed.type === "turn.failed") {
      this.onActivity(`model turn failed${codexErrorSummary(parsed.error)}`);
      return;
    }
    if (parsed.type === "error") {
      this.onActivity(`Codex error${codexErrorSummary(parsed.error ?? parsed.message)}`);
      return;
    }

    const eventType = parsed.type;
    const item = isRecord(parsed.item) ? parsed.item : undefined;
    if (!item || (eventType !== "item.started" && eventType !== "item.completed")) return;
    const started = eventType === "item.started";

    if (item.type === "reasoning") {
      if (!started) this.onActivity("model reasoning");
      return;
    }
    if (item.type === "agent_message") {
      if (!started && typeof item.text === "string" && item.text.trim()) {
        this.onActivity(`model update · ${singleLine(item.text)}`);
      }
      return;
    }
    if (item.type === "command_execution") {
      const command = typeof item.command === "string" && item.command.trim()
        ? ` · ${singleLine(item.command)}`
        : "";
      if (started) {
        this.onActivity(`bash${command}`);
      } else {
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
        const failed = exitCode !== undefined ? exitCode !== 0 : item.status === "failed";
        const exit = failed && exitCode !== undefined ? ` · exit ${exitCode}` : "";
        this.onActivity(`bash ${failed ? "failed" : "completed"}${exit}${codexOutputSummary(item.aggregated_output)}`);
      }
      return;
    }
    if (item.type === "file_change") {
      this.onActivity(formatCodexFileChange(item.changes, started));
      return;
    }
    if (item.type === "mcp_tool_call") {
      const server = typeof item.server === "string" ? item.server : "mcp";
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      const failed = !started && (item.status === "failed" || item.error !== undefined && item.error !== null);
      this.onActivity(`${server}/${tool} ${started ? "started" : failed ? "failed" : "completed"}`);
      return;
    }
    if (item.type === "web_search") {
      const query = typeof item.query === "string" && item.query.trim()
        ? ` · ${singleLine(item.query)}`
        : "";
      this.onActivity(`web search ${started ? "started" : "completed"}${query}`);
    }
  }
}

function formatToolStart(toolName: string, args: unknown): string {
  const name = toolName.toLowerCase();
  const values = isRecord(args) ? args : {};
  if (name === "bash" && typeof values.command === "string") {
    return `bash · ${singleLine(values.command)}`;
  }
  const filePath = typeof values.path === "string"
    ? values.path
    : typeof values.file_path === "string"
      ? values.file_path
      : undefined;
  if ((name === "read" || name === "edit" || name === "write" || name === "ls") && filePath) {
    return `${name} · ${singleLine(filePath)}`;
  }
  if (name === "grep" || name === "find" || name === "glob") {
    const pattern = typeof values.pattern === "string" ? singleLine(values.pattern) : "";
    const path = filePath ? ` · ${singleLine(filePath)}` : "";
    return `${name} · ${pattern}${path}`;
  }
  return `${singleLine(toolName)} started`;
}

function formatToolEnd(toolName: string, result: unknown, isError: boolean): string {
  const name = toolName.toLowerCase();
  if (isError) return `${name} failed${resultSummary(result)}`;
  if (name === "read" || name === "grep" || name === "find" || name === "glob" || name === "ls") {
    return `${name} completed`;
  }
  return `${name} completed${resultSummary(result)}`;
}

function resultSummary(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  const text = result.content
    .map((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = [...lines].reverse().find((line) => /\b(?:passed|failed|error|success|created|updated|replaced)\b/i.test(line));
  const summary = useful ?? (lines.length <= 2 ? lines.at(-1) : undefined);
  return summary ? ` · ${singleLine(summary)}` : "";
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function formatCodexFileChange(changes: unknown, started: boolean): string {
  if (!Array.isArray(changes) || changes.length === 0) {
    return `file change ${started ? "started" : "completed"}`;
  }
  const descriptions = changes.flatMap((change) => {
    if (!isRecord(change) || typeof change.path !== "string") return [];
    const kind = typeof change.kind === "string" ? change.kind : "update";
    return [`${kind} ${change.path}`];
  });
  if (descriptions.length === 0) return `file change ${started ? "started" : "completed"}`;
  const label = descriptions.length === 1 ? "file change" : `file changes (${descriptions.length})`;
  return `${label} ${started ? "started" : "completed"} · ${singleLine(descriptions.join(", "))}`;
}

function codexOutputSummary(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = [...lines].reverse().find((line) => /\b(?:passed|failed|error|success|created|updated|replaced)\b/i.test(line));
  const summary = useful ?? (lines.length <= 2 ? lines.at(-1) : undefined);
  return summary ? ` · ${singleLine(summary)}` : "";
}

function codexErrorSummary(value: unknown): string {
  if (typeof value === "string" && value.trim()) return ` · ${singleLine(value)}`;
  if (!isRecord(value)) return "";
  const message = typeof value.message === "string"
    ? value.message
    : typeof value.error === "string"
      ? value.error
      : undefined;
  return message?.trim() ? ` · ${singleLine(message)}` : "";
}

function singleLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface ClaudeStreamResult {
  text: string;
  error?: string;
  sessionId?: string;
  resultEnvelope?: Record<string, unknown>;
}

export class ClaudeStreamJsonParser {
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));
  private assistantText = "";
  private readonly streamedText = new BoundedTextAccumulator(MAX_STREAMED_TEXT_BYTES);
  private error: string | undefined;
  private sessionId: string | undefined;
  private resultEnvelope: Record<string, unknown> | undefined;

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): ClaudeStreamResult {
    this.decoder.finish();
    const resultText = this.resultEnvelope && typeof this.resultEnvelope.result === "string"
      ? this.resultEnvelope.result
      : "";
    return {
      text: resultText || this.assistantText || this.streamedText.value,
      error: this.error,
      sessionId: this.sessionId,
      resultEnvelope: this.resultEnvelope,
    };
  }

  private processLine(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (typeof event.session_id === "string") this.sessionId = event.session_id;

    if (event.type === "result" || event.type === undefined && typeof event.result === "string") {
      this.resultEnvelope = event;
      if (event.is_error === true) this.error = claudeErrorSummary(event);
      return;
    }
    if (event.type === "assistant" && isRecord(event.message)) {
      const text = textFromMessageContent(event.message.content);
      if (text.trim()) this.assistantText = boundedText(text);
      if (isRecord(event.message.usage)) this.resultEnvelope ??= { message: event.message };
      return;
    }
    if (event.type === "stream_event" && isRecord(event.event) && isRecord(event.event.delta)
      && event.event.delta.type === "text_delta" && typeof event.event.delta.text === "string") {
      this.streamedText.append(event.event.delta.text);
    }
  }
}

export class ClaudeStreamActivityExtractor {
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));
  private lastModelUpdate = "";
  private readonly toolNames = new Map<string, string>();
  private readonly seenToolStarts = new Set<string>();
  private readonly seenToolResults = new Set<string>();

  constructor(
    private readonly onActivity: (message: string) => void,
    private readonly options: { includeModelUpdates?: boolean } = {},
  ) {}

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): void {
    this.decoder.finish();
  }

  private processLine(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;

    if (event.type === "system") {
      if (event.subtype === "init") this.onActivity("model turn started");
      if (event.subtype === "api_retry") {
        const attempt = typeof event.attempt === "number" && typeof event.max_retries === "number"
          ? ` ${event.attempt}/${event.max_retries}`
          : "";
        const reason = typeof event.error === "string" ? ` · ${singleLine(event.error)}` : "";
        this.onActivity(`model retry${attempt}${reason}`);
      }
      return;
    }

    if (event.type === "stream_event" && isRecord(event.event)) {
      const block = event.event.type === "content_block_start" && isRecord(event.event.content_block)
        ? event.event.content_block
        : undefined;
      if (block?.type === "thinking") this.onActivity("model reasoning");
      if (block?.type === "text") this.onActivity("model composing response");
      return;
    }

    if (event.type === "assistant" && isRecord(event.message)) {
      if (Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
          const id = typeof block.id === "string" ? block.id : `${block.name}:${this.seenToolStarts.size}`;
          this.toolNames.set(id, block.name);
          if (this.seenToolStarts.has(id)) continue;
          this.seenToolStarts.add(id);
          this.onActivity(formatToolStart(block.name, block.input));
        }
      }
      this.emitModelUpdate(textFromMessageContent(event.message.content));
      return;
    }

    if (event.type === "user" && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : `result:${this.seenToolResults.size}`;
        if (this.seenToolResults.has(id)) continue;
        this.seenToolResults.add(id);
        const name = this.toolNames.get(id) ?? "tool";
        const content = typeof block.content === "string"
          ? [{ type: "text", text: block.content }]
          : block.content;
        this.onActivity(formatToolEnd(name, { content }, block.is_error === true));
      }
      return;
    }

    if (event.type === "result") {
      this.onActivity(event.is_error === true
        ? `model failed · ${singleLine(claudeErrorSummary(event))}`
        : "model turn completed");
    }
  }

  private emitModelUpdate(text: string): void {
    const message = text.trim();
    if (this.options.includeModelUpdates === false || !message || message === this.lastModelUpdate) return;
    this.lastModelUpdate = singleLine(message);
    this.onActivity(`model update · ${singleLine(message)}`);
  }
}

function claudeErrorSummary(value: Record<string, unknown>): string {
  const status = typeof value.api_error_status === "number" ? `Claude API ${value.api_error_status}` : "Claude API error";
  const detail = typeof value.error === "string" && value.error.trim()
    ? value.error
    : typeof value.result === "string" && value.result.trim()
      ? value.result
      : undefined;
  return detail ? `${status}: ${detail}` : status;
}

function boundedText(value: string): string {
  return utf8Prefix(value, MAX_STREAMED_TEXT_BYTES);
}
