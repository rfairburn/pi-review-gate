export class PiJsonlActivityExtractor {
  private pending = "";
  private lastModelUpdate = "";

  constructor(
    private readonly onActivity: (message: string) => void,
    private readonly options: { includeModelUpdates?: boolean } = {},
  ) {}

  push(chunk: string): void {
    this.pending += chunk;
    while (true) {
      const newlineIndex = this.pending.search(/\r?\n/);
      if (newlineIndex === -1) return;
      const line = this.pending.slice(0, newlineIndex);
      const newlineLength = this.pending[newlineIndex] === "\r" && this.pending[newlineIndex + 1] === "\n" ? 2 : 1;
      this.pending = this.pending.slice(newlineIndex + newlineLength);
      this.processLine(line);
    }
  }

  finish(): void {
    if (this.pending.trim()) this.processLine(this.pending);
    this.pending = "";
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
    this.lastModelUpdate = message;
    this.onActivity(`model update · ${singleLine(message)}`);
  }
}

/**
 * Convert `codex exec --json` events into concise, UI-only activity updates.
 * Reasoning contents and command output bodies are intentionally not emitted;
 * the tool card only receives bounded lifecycle and result summaries.
 */
export class CodexJsonlActivityExtractor {
  private pending = "";

  constructor(private readonly onActivity: (message: string) => void) {}

  push(chunk: string): void {
    this.pending += chunk;
    while (true) {
      const newlineIndex = this.pending.search(/\r?\n/);
      if (newlineIndex === -1) return;
      const line = this.pending.slice(0, newlineIndex);
      const newlineLength = this.pending[newlineIndex] === "\r" && this.pending[newlineIndex + 1] === "\n" ? 2 : 1;
      this.pending = this.pending.slice(newlineIndex + newlineLength);
      this.processLine(line);
    }
  }

  finish(): void {
    if (this.pending.trim()) this.processLine(this.pending);
    this.pending = "";
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
  const values = isRecord(args) ? args : {};
  if (toolName === "bash" && typeof values.command === "string") {
    return `bash · ${singleLine(values.command)}`;
  }
  if ((toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls") && typeof values.path === "string") {
    return `${toolName} · ${values.path}`;
  }
  if (toolName === "grep") {
    const pattern = typeof values.pattern === "string" ? values.pattern : "";
    const path = typeof values.path === "string" ? ` · ${values.path}` : "";
    return `grep · ${pattern}${path}`;
  }
  if (toolName === "find") {
    const pattern = typeof values.pattern === "string" ? values.pattern : "";
    const path = typeof values.path === "string" ? ` · ${values.path}` : "";
    return `find · ${pattern}${path}`;
  }
  return `${toolName} started`;
}

function formatToolEnd(toolName: string, result: unknown, isError: boolean): string {
  if (isError) return `${toolName} failed${resultSummary(result)}`;
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    return `${toolName} completed`;
  }
  const summary = resultSummary(result);
  return `${toolName} completed${summary}`;
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
