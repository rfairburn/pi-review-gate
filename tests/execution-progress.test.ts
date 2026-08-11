import assert from "node:assert/strict";
import test from "node:test";
import { CodexJsonlActivityExtractor, PiJsonlActivityExtractor } from "../src/execution/progress";

test("PiJsonlActivityExtractor emits bounded useful lifecycle summaries instead of token deltas", () => {
  const messages: string[] = [];
  const extractor = new PiJsonlActivityExtractor((message) => messages.push(message));
  const stream = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "private reasoning" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "I’ll inspect the tests now." } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I’ll inspect the tests now." }] } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npx playwright test test/browser/reconnect.spec.js" } }),
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Running 2 tests\n2 passed (12.4s)\n" }] },
      isError: false,
    }),
    JSON.stringify({ type: "turn_end", message: { role: "assistant" }, toolResults: [] }),
  ].join("\n") + "\n";

  extractor.push(stream.slice(0, 91));
  extractor.push(stream.slice(91));
  extractor.finish();

  assert.deepEqual(messages, [
    "model turn started",
    "model reasoning",
    "model composing response",
    "model update · I’ll inspect the tests now.",
    "bash · npx playwright test test/browser/reconnect.spec.js",
    "bash completed · 2 passed (12.4s)",
    "model turn completed",
  ]);
  assert.equal(messages.some((message) => message.includes("private reasoning")), false);
});

test("PiJsonlActivityExtractor summarizes file tools without including file contents", () => {
  const messages: string[] = [];
  const extractor = new PiJsonlActivityExtractor((message) => messages.push(message));
  extractor.push([
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/repo/test.js" } }),
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "read",
      result: { content: [{ type: "text", text: "a very large file body that must not enter progress" }] },
      isError: false,
    }),
  ].join("\n"));
  extractor.finish();

  assert.deepEqual(messages, ["read · /repo/test.js", "read completed"]);
});

test("PiJsonlActivityExtractor reports detailed file, failure, retry, and compaction activity", () => {
  const messages: string[] = [];
  const extractor = new PiJsonlActivityExtractor((message) => messages.push(message));
  extractor.push([
    JSON.stringify({ type: "tool_execution_start", toolName: "write", args: { path: "/repo/src/new.ts", content: "not shown" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "write", result: { content: [{ type: "text", text: "Created /repo/src/new.ts" }] }, isError: false }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "3 tests failed" }] }, isError: true }),
    JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "provider overloaded" }),
    JSON.stringify({ type: "auto_retry_end", success: true, attempt: 1 }),
    JSON.stringify({ type: "compaction_start", reason: "threshold" }),
    JSON.stringify({ type: "compaction_end", reason: "threshold", result: { summary: "done" }, aborted: false }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" } }),
  ].join("\n"));
  extractor.finish();

  assert.deepEqual(messages, [
    "write · /repo/src/new.ts",
    "write completed · Created /repo/src/new.ts",
    "bash · npm test",
    "bash failed · 3 tests failed",
    "model retry 1/3 · provider overloaded",
    "model retry completed",
    "context compaction started",
    "context compaction completed",
    "model response aborted",
  ]);
});

test("PiJsonlActivityExtractor can suppress reviewer model text while retaining milestones", () => {
  const messages: string[] = [];
  const extractor = new PiJsonlActivityExtractor(
    (message) => messages.push(message),
    { includeModelUpdates: false },
  );
  extractor.push([
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "{\"verdict\":\"pass\"}" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{\"verdict\":\"pass\"}" }] } }),
    JSON.stringify({ type: "turn_end", message: { role: "assistant" }, toolResults: [] }),
  ].join("\n"));
  extractor.finish();

  assert.deepEqual(messages, ["model turn started", "model turn completed"]);
});

test("CodexJsonlActivityExtractor emits useful live milestones from split JSONL chunks", () => {
  const messages: string[] = [];
  const extractor = new CodexJsonlActivityExtractor((message) => messages.push(message));
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning must stay private" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I’ll inspect the tests, then update the implementation." } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test", status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "Running tests\n42 passed\n", exit_code: 0, status: "completed" } }),
    JSON.stringify({ type: "item.started", item: { type: "file_change", changes: [{ kind: "update", path: "/repo/src/index.ts" }] } }),
    JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ kind: "update", path: "/repo/src/index.ts" }] } }),
    JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "docs", tool: "search" } }),
    JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "docs", tool: "search", status: "completed" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join("\n") + "\n";

  extractor.push(stream.slice(0, 73));
  extractor.push(stream.slice(73, 311));
  extractor.push(stream.slice(311));
  extractor.finish();

  assert.deepEqual(messages, [
    "model turn started",
    "model reasoning",
    "model update · I’ll inspect the tests, then update the implementation.",
    "bash · npm test",
    "bash completed · 42 passed",
    "file change started · update /repo/src/index.ts",
    "file change completed · update /repo/src/index.ts",
    "docs/search started",
    "docs/search completed",
    "model turn completed",
  ]);
  assert.equal(messages.some((message) => message.includes("private reasoning must stay private")), false);
});

test("CodexJsonlActivityExtractor reports failures and ignores malformed or unknown events", () => {
  const messages: string[] = [];
  const extractor = new CodexJsonlActivityExtractor((message) => messages.push(message));
  extractor.push([
    "not json",
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "Error: tests failed\n", exit_code: 1, status: "failed" } }),
    JSON.stringify({ type: "error", message: "connection lost" }),
    JSON.stringify({ type: "turn.failed", error: { message: "request failed" } }),
    JSON.stringify({ type: "unknown.event", secret: "ignore me" }),
  ].join("\n"));
  extractor.finish();

  assert.deepEqual(messages, [
    "bash failed · exit 1 · Error: tests failed",
    "Codex error · connection lost",
    "model turn failed · request failed",
  ]);
});
