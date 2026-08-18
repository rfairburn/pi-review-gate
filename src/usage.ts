export interface TokenUsage {
  scope?: "invocation";
  inputTokens?: number;
  totalInputTokens?: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costTotal?: number;
  raw?: unknown;
}

export function formatTokenUsage(usage: TokenUsage | undefined): string {
  if (!usage || isZeroUsage(usage)) {
    return "review tokens: unavailable";
  }
  const parts: string[] = [];
  const totalInputTokens = usage.totalInputTokens ?? usage.inputTokens;
  if (totalInputTokens !== undefined) {
    const inputBreakdown: string[] = [];
    if (usage.uncachedInputTokens !== undefined) {
      inputBreakdown.push(`uncached ${formatCount(usage.uncachedInputTokens)}`);
    }
    if (usage.cachedInputTokens !== undefined) {
      inputBreakdown.push(`cached ${formatCount(usage.cachedInputTokens)}`);
    }
    if (usage.cacheWriteTokens !== undefined) {
      inputBreakdown.push(`cache-write ${formatCount(usage.cacheWriteTokens)}`);
    }
    parts.push(`input ${formatCount(totalInputTokens)}${inputBreakdown.length > 0 ? ` (${inputBreakdown.join(", ")})` : ""}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`out ${formatCount(usage.outputTokens)}`);
  }
  if (usage.reasoningOutputTokens !== undefined) {
    parts.push(`reasoning ${formatCount(usage.reasoningOutputTokens)}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`total ${formatCount(usage.totalTokens)}`);
  }
  if (usage.costTotal !== undefined && usage.costTotal > 0) {
    parts.push(`cost $${usage.costTotal.toFixed(4)}`);
  }
  return parts.length > 0 ? `review tokens (this pass): ${parts.join(", ")}` : "review tokens: unavailable";
}

export function parseCodexUsageFromJsonl(stdout: string): TokenUsage | undefined {
  return extractCodexReviewFromJsonl(stdout).usage;
}

export function extractReviewTextFromCodexJsonl(stdout: string): string {
  return extractCodexReviewFromJsonl(stdout).text;
}

export function extractCodexSessionId(stdout: string): string | undefined {
  return extractCodexReviewFromJsonl(stdout).sessionId;
}

export function extractCodexReviewFromJsonl(stdout: string): {
  text: string;
  usage?: TokenUsage;
  sessionId?: string;
} {
  const extractor = new CodexJsonlReviewExtractor();
  extractor.push(stdout);
  return extractor.finish();
}

export class CodexJsonlReviewExtractor {
  private lastUsage: unknown;
  private text = "";
  private sessionId: string | undefined;
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): { text: string; usage?: TokenUsage; sessionId?: string } {
    this.decoder.finish();
    let usage: TokenUsage | undefined;
    if (isRecord(this.lastUsage)) {
      const lastTokenUsage = isRecord(this.lastUsage.last_token_usage) ? this.lastUsage.last_token_usage : undefined;
      const totalTokenUsage = isRecord(this.lastUsage.total_token_usage) ? this.lastUsage.total_token_usage : undefined;
      const raw = lastTokenUsage ?? totalTokenUsage;
      usage = normalizeOpenAiStyleUsage(raw ?? this.lastUsage, this.lastUsage);
    }
    return { text: this.text, usage, sessionId: this.sessionId };
  }

  private processLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    if (parsed.type === "turn.completed" && isRecord(parsed.usage)) {
      this.lastUsage = parsed.usage;
    } else if (isRecord(parsed.payload) && parsed.payload.type === "token_count") {
      this.lastUsage = parsed.payload.info;
    }
    if (isRecord(parsed.item) && parsed.item.type === "agent_message" && typeof parsed.item.text === "string" && parsed.item.text.trim()) {
      this.text = boundedText(parsed.item.text);
    } else if (parsed.type === "message" && isRecord(parsed.message) && parsed.message.role === "assistant") {
      const messageText = textFromContent(parsed.message.content);
      if (messageText.trim()) {
        this.text = boundedText(messageText);
      }
    }
    if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
      this.sessionId = parsed.thread_id;
    }
  }
}

export function parseClaudeUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = isRecord(value.usage)
    ? value.usage
    : isRecord(value.message) && isRecord(value.message.usage)
      ? value.message.usage
      : undefined;
  if (!usage) {
    return undefined;
  }
  const inputTokens = numberValue(usage.input_tokens);
  const cachedInputTokens = numberValue(usage.cache_read_input_tokens);
  const cacheWriteTokens = numberValue(usage.cache_creation_input_tokens);
  const result = {
    scope: "invocation" as const,
    inputTokens,
    totalInputTokens: sumDefined([inputTokens, cachedInputTokens, cacheWriteTokens]),
    uncachedInputTokens: inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: numberValue(usage.output_tokens),
    totalTokens: sumDefined([
      numberValue(usage.input_tokens),
      numberValue(usage.cache_read_input_tokens),
      numberValue(usage.cache_creation_input_tokens),
      numberValue(usage.output_tokens),
    ]),
    costTotal: numberValue(value.total_cost_usd),
    raw: usage,
  };
  return isZeroUsage(result) && isRecord(value) && value.is_error === true ? undefined : result;
}

export function parsePiUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = isRecord(value.usage)
    ? value.usage
    : isRecord(value.message) && isRecord(value.message.usage)
      ? value.message.usage
      : undefined;
  if (!usage) {
    return undefined;
  }
  const inputTokens = numberValue(usage.input);
  const cachedInputTokens = numberValue(usage.cacheRead);
  const cacheWriteTokens = numberValue(usage.cacheWrite);
  return {
    scope: "invocation",
    inputTokens,
    totalInputTokens: sumDefined([inputTokens, cachedInputTokens, cacheWriteTokens]),
    uncachedInputTokens: inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: numberValue(usage.output),
    totalTokens: numberValue(usage.totalTokens) ?? sumDefined([
      numberValue(usage.input),
      numberValue(usage.cacheRead),
      numberValue(usage.cacheWrite),
      numberValue(usage.output),
    ]),
    costTotal: isRecord(usage.cost) ? numberValue(usage.cost.total) : undefined,
    raw: usage,
  };
}

export function extractPiUsageFromMessages(args: unknown[]): TokenUsage | undefined {
  const combined: Required<Pick<TokenUsage, "inputTokens" | "totalInputTokens" | "uncachedInputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "totalTokens" | "costTotal">> = {
    inputTokens: 0,
    totalInputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costTotal: 0,
  };
  let found = false;
  for (const arg of args) {
    if (!isRecord(arg) || !Array.isArray(arg.messages)) {
      continue;
    }
    for (const message of arg.messages) {
      const usage = parsePiUsage(message);
      if (!usage) {
        continue;
      }
      found = true;
      combined.inputTokens += usage.inputTokens ?? 0;
      combined.totalInputTokens += usage.totalInputTokens ?? usage.inputTokens ?? 0;
      combined.uncachedInputTokens += usage.uncachedInputTokens ?? usage.inputTokens ?? 0;
      combined.cachedInputTokens += usage.cachedInputTokens ?? 0;
      combined.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      combined.outputTokens += usage.outputTokens ?? 0;
      combined.totalTokens += usage.totalTokens ?? 0;
      combined.costTotal += usage.costTotal ?? 0;
    }
  }
  return found ? { scope: "invocation", ...combined } : undefined;
}

export function extractReviewTextFromClaudeJson(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.result === "string") {
    return value.result;
  }
  if (typeof value.response === "string") {
    return value.response;
  }
  if (isRecord(value.message)) {
    return textFromContent(value.message.content);
  }
  return textFromContent(value.content);
}

export interface PiJsonlReviewExtraction {
  text: string;
  usage?: TokenUsage;
  terminalError?: string;
  lifecycle: PiLifecycleSummary;
}

export interface PiLifecycleEvent {
  sequence: number;
  type: "model_error" | "retry_start" | "retry_end" | "compaction_start" | "compaction_end" | "turn_start" | "turn_end" | "assistant_text";
  reason?: string;
  error?: string;
  success?: boolean;
}

export interface PiLifecycleSummary {
  events: PiLifecycleEvent[];
  compaction: {
    status: "none" | "in_progress" | "completed" | "failed" | "aborted";
    reason?: string;
    error?: string;
    resumeObserved: boolean;
  };
  provisionalAbortResolved: boolean;
}

export function extractReviewTextFromPiJsonl(stdout: string): PiJsonlReviewExtraction {
  const extractor = new PiJsonlReviewExtractor();
  extractor.push(stdout);
  return extractor.finish();
}

export class PiJsonlReviewExtractor {
  private finalText = "";
  private readonly currentDeltaText = new BoundedTextAccumulator(MAX_AGENT_TEXT_BYTES);
  private partialText = "";
  private usage: TokenUsage | undefined;
  private terminalError = "";
  private sequence = 0;
  private readonly lifecycleEvents: PiLifecycleEvent[] = [];
  private compactionStatus: PiLifecycleSummary["compaction"]["status"] = "none";
  private compactionReason: string | undefined;
  private compactionError: string | undefined;
  private resumeObserved = false;
  private provisionalAbortResolved = false;
  private readonly decoder = new BoundedJsonlDecoder((line) => this.processLine(line));

  push(chunk: string): void {
    this.decoder.push(chunk);
  }

  finish(): PiJsonlReviewExtraction {
    this.decoder.finish();
    return this.result();
  }

  result(): PiJsonlReviewExtraction {
    return {
      text: this.finalText || this.currentDeltaText.value || this.partialText,
      usage: this.usage,
      terminalError: this.terminalError || undefined,
      lifecycle: {
        events: [...this.lifecycleEvents],
        compaction: {
          status: this.compactionStatus,
          reason: this.compactionReason,
          error: this.compactionError,
          resumeObserved: this.resumeObserved,
        },
        provisionalAbortResolved: this.provisionalAbortResolved,
      },
    };
  }

  private processLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const parsedUsage = parsePiUsage(parsed);
    if (parsedUsage) {
      this.usage = parsedUsage;
    }
    if (!isRecord(parsed)) {
      return;
    }

    const terminalError = piStreamError(parsed);
    if (terminalError) {
      this.terminalError = terminalError;
      this.record({ type: "model_error", error: terminalError });
    }
    if (parsed.type === "auto_retry_end" && parsed.success === true) {
      this.terminalError = "";
    }

    if (parsed.type === "turn_start") {
      if (this.compactionStatus === "completed") this.resumeObserved = true;
      this.record({ type: "turn_start" });
    }
    if (parsed.type === "turn_end") this.record({ type: "turn_end" });
    if (parsed.type === "auto_retry_start") {
      this.record({
        type: "retry_start",
        error: typeof parsed.errorMessage === "string" ? boundedError(parsed.errorMessage) : undefined,
      });
    }
    if (parsed.type === "auto_retry_end") {
      this.record({
        type: "retry_end",
        success: parsed.success === true,
        error: typeof parsed.finalError === "string" ? boundedError(parsed.finalError) : undefined,
      });
    }
    if (parsed.type === "compaction_start") {
      this.compactionStatus = "in_progress";
      this.compactionReason = typeof parsed.reason === "string" ? parsed.reason : undefined;
      this.compactionError = undefined;
      if (isAbortLikeError(this.terminalError)) {
        this.terminalError = "";
        this.provisionalAbortResolved = true;
      }
      this.record({ type: "compaction_start", reason: this.compactionReason });
    }
    if (parsed.type === "compaction_end") {
      const error = typeof parsed.errorMessage === "string" && parsed.errorMessage.trim()
        ? boundedError(parsed.errorMessage)
        : undefined;
      this.compactionStatus = parsed.aborted === true
        ? "aborted"
        : parsed.result
          ? "completed"
          : "failed";
      this.compactionReason = typeof parsed.reason === "string" ? parsed.reason : this.compactionReason;
      this.compactionError = error;
      if (error) this.terminalError = error;
      else if (this.compactionStatus === "completed" && isAbortLikeError(this.terminalError)) {
        this.terminalError = "";
        this.provisionalAbortResolved = true;
      }
      this.record({
        type: "compaction_end",
        reason: this.compactionReason,
        error,
        success: this.compactionStatus === "completed",
      });
    }

    if (parsed.type === "message_start" && isAssistantMessage(parsed.message)) {
      this.currentDeltaText.clear();
      this.partialText = "";
      return;
    }

    if (parsed.type === "message_update") {
      this.applyMessageUpdate(parsed);
      return;
    }

    if (isAssistantMessage(parsed.message)) {
      this.captureAssistantText(parsed.message.content);
    }
  }

  private applyMessageUpdate(parsed: Record<string, unknown>): void {
    const event = isRecord(parsed.assistantMessageEvent) ? parsed.assistantMessageEvent : undefined;
    if (event?.type === "text_delta" && typeof event.delta === "string") {
      this.currentDeltaText.append(event.delta);
    }
    const partial = isRecord(event?.partial)
      ? event.partial
      : isRecord(parsed.message) && parsed.message.role === "assistant"
        ? parsed.message
        : undefined;
    if (isAssistantMessage(partial)) {
      const text = textFromContent(partial.content);
      if (text.trim()) {
        this.partialText = boundedText(text);
      }
    }
  }

  private captureAssistantText(content: unknown): void {
    const text = textFromContent(content);
    if (text.trim()) {
      const bounded = boundedText(text);
      this.finalText = bounded;
      this.currentDeltaText.set(bounded);
      this.partialText = bounded;
      this.terminalError = "";
      this.record({ type: "assistant_text" });
    }
  }

  private record(event: Omit<PiLifecycleEvent, "sequence">): void {
    this.lifecycleEvents.push({ sequence: ++this.sequence, ...event });
  }
}

function isAbortLikeError(value: string): boolean {
  return /\babort(?:ed|ing)?\b/i.test(value);
}

function piStreamError(event: Record<string, unknown>): string | undefined {
  if (event.type === "auto_retry_end" && event.success === false && typeof event.finalError === "string") {
    return boundedError(event.finalError);
  }
  if (typeof event.errorMessage === "string" && event.errorMessage.trim()) {
    return boundedError(event.errorMessage);
  }
  if (isRecord(event.message) && typeof event.message.errorMessage === "string" && event.message.errorMessage.trim()) {
    return boundedError(event.message.errorMessage);
  }
  if (Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (isRecord(message) && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
        return boundedError(message.errorMessage);
      }
    }
  }
  return undefined;
}

function boundedError(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : normalized.slice(normalized.length - 2_000);
}

function boundedText(value: string): string {
  return utf8Prefix(value, MAX_AGENT_TEXT_BYTES);
}

function normalizeOpenAiStyleUsage(value: Record<string, unknown>, raw: unknown): TokenUsage {
  const inputTokens = numberValue(value.input_tokens);
  const cachedInputTokens = numberValue(value.cached_input_tokens);
  const cacheWriteTokens = numberValue(value.cache_write_input_tokens);
  const outputTokens = numberValue(value.output_tokens);
  const reasoningOutputTokens = numberValue(value.reasoning_output_tokens);
  return {
    scope: "invocation",
    inputTokens,
    totalInputTokens: inputTokens,
    uncachedInputTokens: subtractDefined(inputTokens, cachedInputTokens, cacheWriteTokens),
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: numberValue(value.total_tokens) ?? sumDefined([inputTokens, outputTokens]),
    raw,
  };
}

function subtractDefined(total: number | undefined, ...parts: Array<number | undefined>): number | undefined {
  if (total === undefined) {
    return undefined;
  }
  return Math.max(0, total - parts.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function isZeroUsage(usage: TokenUsage): boolean {
  const values = [
    usage.inputTokens,
    usage.totalInputTokens,
    usage.uncachedInputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
    usage.costTotal,
  ].filter((value): value is number => value !== undefined);
  return values.length > 0 && values.every((value) => value === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.role === "assistant";
}
import { BoundedJsonlDecoder, BoundedTextAccumulator, MEBIBYTE, utf8Prefix } from "./jsonl";

const MAX_AGENT_TEXT_BYTES = 16 * MEBIBYTE;
