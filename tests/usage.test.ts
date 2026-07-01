import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPiUsageFromMessages,
  extractReviewTextFromClaudeJson,
  extractReviewTextFromPiJsonl,
  formatTokenUsage,
  parseClaudeUsage,
  parseCodexUsageFromJsonl,
} from "../src/usage";

test("parseCodexUsageFromJsonl reads token_count events", () => {
  const usage = parseCodexUsageFromJsonl([
    JSON.stringify({ type: "event", payload: { type: "started" } }),
    JSON.stringify({
      type: "event",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 100,
            output_tokens: 250,
            reasoning_output_tokens: 75,
            total_tokens: 1450,
          },
        },
      },
    }),
  ].join("\n"));

  assert.equal(usage?.inputTokens, 1200);
  assert.equal(usage?.cachedInputTokens, 100);
  assert.equal(usage?.outputTokens, 250);
  assert.equal(usage?.reasoningOutputTokens, 75);
  assert.equal(usage?.totalTokens, 1450);
});

test("parseClaudeUsage reads json output usage and review text", () => {
  const output = {
    result: "{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[]}",
    usage: {
      input_tokens: 900,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
      output_tokens: 150,
    },
    total_cost_usd: 0.0123,
  };

  const usage = parseClaudeUsage(output);

  assert.equal(extractReviewTextFromClaudeJson(output), output.result);
  assert.equal(usage?.inputTokens, 900);
  assert.equal(usage?.cachedInputTokens, 400);
  assert.equal(usage?.cacheWriteTokens, 50);
  assert.equal(usage?.outputTokens, 150);
  assert.equal(usage?.totalTokens, 1500);
  assert.equal(usage?.costTotal, 0.0123);
});

test("extractReviewTextFromPiJsonl reads assistant text and little-coder usage", () => {
  const output = [
    JSON.stringify({ type: "status", message: "running" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[]}" }],
        usage: {
          input: 800,
          cacheRead: 200,
          cacheWrite: 25,
          output: 125,
          totalTokens: 1150,
          cost: { total: 0 },
        },
      },
    }),
  ].join("\n");

  const extracted = extractReviewTextFromPiJsonl(output);

  assert.match(extracted.text, /"verdict":"pass"/);
  assert.equal(extracted.usage?.inputTokens, 800);
  assert.equal(extracted.usage?.cachedInputTokens, 200);
  assert.equal(extracted.usage?.cacheWriteTokens, 25);
  assert.equal(extracted.usage?.outputTokens, 125);
  assert.equal(extracted.usage?.totalTokens, 1150);
});

test("extractPiUsageFromMessages sums acting model usage from agent_end args", () => {
  const usage = extractPiUsageFromMessages([
    {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", usage: { input: 100, cacheRead: 20, output: 30, totalTokens: 150, cost: { total: 0.001 } } },
        { role: "assistant", usage: { input: 200, cacheWrite: 40, output: 60, totalTokens: 300, cost: { total: 0.002 } } },
      ],
    },
  ]);

  assert.equal(usage?.inputTokens, 300);
  assert.equal(usage?.cachedInputTokens, 20);
  assert.equal(usage?.cacheWriteTokens, 40);
  assert.equal(usage?.outputTokens, 90);
  assert.equal(usage?.totalTokens, 450);
  assert.equal(usage?.costTotal, 0.003);
});

test("formatTokenUsage returns compact user-facing summary", () => {
  assert.equal(
    formatTokenUsage({ inputTokens: 1200, outputTokens: 345, totalTokens: 1545 }),
    "review tokens: in 1.2k, out 345, total 1.5k",
  );
  assert.equal(formatTokenUsage(undefined), "review tokens: unavailable");
});
