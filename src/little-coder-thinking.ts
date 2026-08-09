import type { ThinkingLevel } from "./config";

const THINKING_BUDGETS: Partial<Record<ThinkingLevel, number>> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
  max: 16_384,
};

const NATIVE_REASONING_PROVIDERS = new Set(["anthropic", "openai", "openai-codex"]);

export function littleCoderThinkingBudget(level: ThinkingLevel): number | undefined {
  return THINKING_BUDGETS[level];
}

export function withLittleCoderThinkingBudget(
  env: NodeJS.ProcessEnv,
  model: string,
  level: ThinkingLevel,
): NodeJS.ProcessEnv {
  const next = { ...env };
  const budget = littleCoderThinkingBudget(level);
  const provider = model.split("/", 1)[0] ?? "";
  if (level !== "off" && !NATIVE_REASONING_PROVIDERS.has(provider) && budget !== undefined) {
    next.LITTLE_CODER_THINKING_BUDGET = String(budget);
  } else {
    // An explicit zero disables little-coder's independent output-side cap.
    // This matters for providers such as Anthropic and OpenAI-Codex, where Pi
    // already supplies a native token budget or reasoning effort. A second
    // output-side character estimate would duplicate or distort that control.
    next.LITTLE_CODER_THINKING_BUDGET = "0";
  }
  return next;
}
