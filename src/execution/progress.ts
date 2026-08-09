export class PiJsonlActivityExtractor {
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
    if (parsed.type === "turn_start") {
      this.onActivity("model turn started");
      return;
    }
    if (parsed.type === "message_update" && isRecord(parsed.assistantMessageEvent)) {
      const eventType = parsed.assistantMessageEvent.type;
      if (eventType === "thinking_start") this.onActivity("model reasoning");
      if (eventType === "text_start") this.onActivity("model composing response");
      return;
    }
    if (parsed.type === "tool_execution_start" && typeof parsed.toolName === "string") {
      this.onActivity(formatToolStart(parsed.toolName, parsed.args));
      return;
    }
    if (parsed.type === "tool_execution_end" && typeof parsed.toolName === "string") {
      this.onActivity(formatToolEnd(parsed.toolName, parsed.result, parsed.isError === true));
    }
  }
}

function formatToolStart(toolName: string, args: unknown): string {
  const values = isRecord(args) ? args : {};
  if (toolName === "bash" && typeof values.command === "string") {
    return `bash · ${singleLine(values.command)}`;
  }
  if ((toolName === "read" || toolName === "edit" || toolName === "write") && typeof values.path === "string") {
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

function singleLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
