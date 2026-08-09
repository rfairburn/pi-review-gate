import assert from "node:assert/strict";
import test from "node:test";
import {
  littleCoderThinkingBudget,
  withLittleCoderThinkingBudget,
} from "../src/little-coder-thinking";

test("little-coder thinking levels map to Pi's documented token budgets", () => {
  assert.equal(littleCoderThinkingBudget("minimal"), 1_024);
  assert.equal(littleCoderThinkingBudget("low"), 2_048);
  assert.equal(littleCoderThinkingBudget("medium"), 8_192);
  assert.equal(littleCoderThinkingBudget("high"), 16_384);
  assert.equal(littleCoderThinkingBudget("xhigh"), 16_384);
  assert.equal(littleCoderThinkingBudget("max"), 16_384);
  assert.equal(littleCoderThinkingBudget("off"), undefined);
});

test("little-coder thinking budget overrides a stale inherited value", () => {
  const env = withLittleCoderThinkingBudget(
    { LITTLE_CODER_THINKING_BUDGET: "4096" },
    "ollama/deepseek-v4-flash:0731-cloud",
    "medium",
  );
  assert.equal(env.LITTLE_CODER_THINKING_BUDGET, "8192");
});

test("thinking off explicitly disables the little-coder budget", () => {
  const env = withLittleCoderThinkingBudget(
    { LITTLE_CODER_THINKING_BUDGET: "4096", KEEP_ME: "yes" },
    "ollama/deepseek-v4-flash:0731-cloud",
    "off",
  );
  assert.equal(env.LITTLE_CODER_THINKING_BUDGET, "0");
  assert.equal(env.KEEP_ME, "yes");
});

test("OpenAI-Codex reasoning uses effort without an output-side token cap", () => {
  const env = withLittleCoderThinkingBudget(
    { LITTLE_CODER_THINKING_BUDGET: "4096" },
    "openai-codex/gpt-5.6-luna",
    "max",
  );
  assert.equal(env.LITTLE_CODER_THINKING_BUDGET, "0");
});

test("OpenAI API reasoning uses effort without an output-side token cap", () => {
  const env = withLittleCoderThinkingBudget(
    { LITTLE_CODER_THINKING_BUDGET: "4096" },
    "openai/gpt-5.6-sol",
    "high",
  );
  assert.equal(env.LITTLE_CODER_THINKING_BUDGET, "0");
});

test("Anthropic reasoning uses Pi's native budget or effort without a second cap", () => {
  const env = withLittleCoderThinkingBudget(
    { LITTLE_CODER_THINKING_BUDGET: "4096" },
    "anthropic/claude-sonnet-4-6",
    "max",
  );
  assert.equal(env.LITTLE_CODER_THINKING_BUDGET, "0");
});

test("unknown providers receive numeric budgets by default", () => {
  const env = withLittleCoderThinkingBudget(
    {},
    "future-local-provider/reasoning-model",
    "low",
  );
  assert.equal(env.LITTLE_CODER_THINKING_BUDGET, "2048");
});
