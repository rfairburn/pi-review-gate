export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costTotal?: number;
  raw?: unknown;
}

export function formatTokenUsage(usage: TokenUsage | undefined): string {
  if (!usage) {
    return "review tokens: unavailable";
  }
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`in ${formatCount(usage.inputTokens)}`);
  }
  if (usage.cachedInputTokens !== undefined) {
    parts.push(`cached ${formatCount(usage.cachedInputTokens)}`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`cache-write ${formatCount(usage.cacheWriteTokens)}`);
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
  return parts.length > 0 ? `review tokens: ${parts.join(", ")}` : "review tokens: unavailable";
}

export function parseCodexUsageFromJsonl(stdout: string): TokenUsage | undefined {
  let lastUsage: unknown;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed) && isRecord(parsed.payload) && parsed.payload.type === "token_count") {
      lastUsage = parsed.payload.info;
    }
  }
  if (!isRecord(lastUsage)) {
    return undefined;
  }
  const lastTokenUsage = isRecord(lastUsage.last_token_usage) ? lastUsage.last_token_usage : undefined;
  const totalTokenUsage = isRecord(lastUsage.total_token_usage) ? lastUsage.total_token_usage : undefined;
  const raw = lastTokenUsage ?? totalTokenUsage;
  if (!raw) {
    return { raw: lastUsage };
  }
  return normalizeOpenAiStyleUsage(raw, lastUsage);
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
  return {
    inputTokens: numberValue(usage.input_tokens),
    cachedInputTokens: numberValue(usage.cache_read_input_tokens),
    cacheWriteTokens: numberValue(usage.cache_creation_input_tokens),
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
  return {
    inputTokens: numberValue(usage.input),
    cachedInputTokens: numberValue(usage.cacheRead),
    cacheWriteTokens: numberValue(usage.cacheWrite),
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
  const combined: Required<Pick<TokenUsage, "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "totalTokens" | "costTotal">> = {
    inputTokens: 0,
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
      combined.cachedInputTokens += usage.cachedInputTokens ?? 0;
      combined.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      combined.outputTokens += usage.outputTokens ?? 0;
      combined.totalTokens += usage.totalTokens ?? 0;
      combined.costTotal += usage.costTotal ?? 0;
    }
  }
  return found ? combined : undefined;
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

export function extractReviewTextFromPiJsonl(stdout: string): { text: string; usage?: TokenUsage } {
  let lastText = "";
  let usage: TokenUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const parsedUsage = parsePiUsage(parsed);
    if (parsedUsage) {
      usage = parsedUsage;
    }
    if (isRecord(parsed) && isRecord(parsed.message) && parsed.message.role === "assistant") {
      const text = textFromContent(parsed.message.content);
      if (text.trim()) {
        lastText = text;
      }
    } else if (isRecord(parsed) && parsed.type === "message" && isRecord(parsed.message) && parsed.message.role === "assistant") {
      const text = textFromContent(parsed.message.content);
      if (text.trim()) {
        lastText = text;
      }
    }
  }
  return { text: lastText, usage };
}

function normalizeOpenAiStyleUsage(value: Record<string, unknown>, raw: unknown): TokenUsage {
  return {
    inputTokens: numberValue(value.input_tokens),
    cachedInputTokens: numberValue(value.cached_input_tokens),
    outputTokens: numberValue(value.output_tokens),
    reasoningOutputTokens: numberValue(value.reasoning_output_tokens),
    totalTokens: numberValue(value.total_tokens),
    raw,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
