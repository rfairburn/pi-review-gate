import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeStreamActivityExtractor, ClaudeStreamJsonParser } from "../src/execution/progress";

test("ClaudeStreamJsonParser recovers the final result envelope from split JSONL chunks", () => {
  const parser = new ClaudeStreamJsonParser();
  const stream = [
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "assistant", session_id: "session-1", message: { role: "assistant", content: [{ type: "text", text: "intermediate" }] } },
    { type: "result", session_id: "session-1", result: "final", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01 },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";

  parser.push(stream.slice(0, 37));
  parser.push(stream.slice(37));
  const result = parser.finish();

  assert.equal(result.text, "final");
  assert.equal(result.sessionId, "session-1");
  assert.deepEqual(result.resultEnvelope?.usage, { input_tokens: 10, output_tokens: 2 });
});

test("ClaudeStreamJsonParser preserves Claude error details and batch JSON compatibility", () => {
  const parser = new ClaudeStreamJsonParser();
  parser.push(JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "Rate limited" }));
  assert.equal(parser.finish().error, "Claude API 429: Rate limited");

  const batch = new ClaudeStreamJsonParser();
  batch.push(JSON.stringify({ result: "legacy final", usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(batch.finish().text, "legacy final");
});

test("ClaudeStreamActivityExtractor emits native Claude lifecycle and tool milestones", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.push([
    { type: "system", subtype: "init" },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking", thinking: "private" } } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "" } } },
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/repo/src/index.ts" } },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
      { type: "text", text: "Checking the implementation." },
    ] } },
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "read-1", content: "secret file contents" },
      { type: "tool_result", tool_use_id: "bash-1", content: "Running tests\n42 passed" },
    ] } },
    { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, error: "overloaded" },
    { type: "result", result: "done" },
  ].map((event) => JSON.stringify(event)).join("\n"));
  extractor.finish();

  assert.deepEqual(activity, [
    "model turn started",
    "model reasoning",
    "model composing response",
    "read · /repo/src/index.ts",
    "bash · npm test",
    "model update · Checking the implementation.",
    "read completed",
    "bash completed · 42 passed",
    "model retry 1/3 · overloaded",
    "model turn completed",
  ]);
  assert.equal(activity.some((message) => message.includes("private") || message.includes("secret file")), false);
});

test("ClaudeStreamActivityExtractor suppresses reviewer output and deduplicates tool events", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor(
    (message) => activity.push(message),
    { includeModelUpdates: false },
  );
  const tool = { type: "assistant", message: { content: [
    { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/repo/a.ts" } },
    { type: "text", text: "{\"verdict\":\"pass\"}" },
  ] } };
  extractor.push(`${JSON.stringify(tool)}\n${JSON.stringify(tool)}\n`);
  extractor.finish();

  assert.deepEqual(activity, ["read · /repo/a.ts"]);
});
