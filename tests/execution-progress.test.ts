import assert from "node:assert/strict";
import test from "node:test";
import { PiJsonlActivityExtractor } from "../src/execution/progress";

test("PiJsonlActivityExtractor emits bounded useful lifecycle summaries instead of token deltas", () => {
  const messages: string[] = [];
  const extractor = new PiJsonlActivityExtractor((message) => messages.push(message));
  const stream = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npx playwright test test/browser/reconnect.spec.js" } }),
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Running 2 tests\n2 passed (12.4s)\n" }] },
      isError: false,
    }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
  ].join("\n") + "\n";

  extractor.push(stream.slice(0, 91));
  extractor.push(stream.slice(91));
  extractor.finish();

  assert.deepEqual(messages, [
    "model turn started",
    "model reasoning",
    "bash · npx playwright test test/browser/reconnect.spec.js",
    "bash completed · 2 passed (12.4s)",
    "model composing response",
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
