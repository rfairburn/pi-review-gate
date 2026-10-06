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
      { type: "text", text: "Checking the\nimplementation." },
    ] } },
    { type: "assistant", message: { role: "assistant", content: [
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

test("ClaudeStreamJsonParser keeps subtype and errors detail for non-API Claude failures", () => {
  const parser = new ClaudeStreamJsonParser();
  parser.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["[ede_diagnostic] synthetic marker"],
  }));
  assert.equal(parser.finish().error, "Claude error (error_during_execution): [ede_diagnostic] synthetic marker");

  const bare = new ClaudeStreamJsonParser();
  bare.push(JSON.stringify({ type: "result", is_error: true }));
  assert.equal(bare.finish().error, "Claude error");
});

test("ClaudeStreamActivityExtractor reports uncorrelated error results with subtype and errors detail", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
    user_message_uuid: "turn-1",
  }));
  extractor.finish();

  assert.deepEqual(activity, [
    "model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user stop_reason=tool_use",
  ]);
});

test("ClaudeStreamActivityExtractor reports verified owned control interruptions as truthful interruptions (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  // Contract-shaped SDKResultError: no user_message_uuid field, positive
  // abort evidence via terminal_reason.
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_tools",
    errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model turn interrupted"]);
});

test("ClaudeStreamActivityExtractor reports the reported SDK-mode cutoff payload as an interruption for a verified owned control (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  // The owning control returned a survivor receipt excluding this turn.
  extractor.verifyInterruption("turn-1", true);
  // The exact reported steering-correlated raw result: SDK-mode interrupted
  // turn results carry no terminal_reason, only the CLI's internal cutoff
  // diagnostic in errors[].
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model turn interrupted"]);
});

// The reported cutoff payload must not read as an interruption without a
// recorded owned control: the diagnostic alone is not authority.
test("ClaudeStreamActivityExtractor keeps the reported cutoff payload failing without a recorded owned control (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  }));
  extractor.finish();

  assert.deepEqual(activity, [
    "model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
  ]);
});

test("ClaudeStreamActivityExtractor keeps diagnostic-plus-error execution results failing after a verified interruption (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1", true);
  // Real error content alongside the internal diagnostic is a genuine
  // failure, not a clean cutoff.
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use", "synthetic logged failure"],
  }));
  extractor.finish();

  assert.deepEqual(activity, [
    "model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use; synthetic logged failure",
  ]);
});

test("ClaudeStreamActivityExtractor keeps diagnostic-only execution results with a non-abort terminal reason failing after a verified interruption (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1", true);
  // A present non-abort terminal reason is not the reported interrupted-turn
  // shape; only its absence qualifies the diagnostic-only errors.
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "background_requested",
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  }));
  extractor.finish();

  assert.deepEqual(activity, [
    "model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
  ]);
});

test("ClaudeStreamActivityExtractor keeps the reported cutoff payload failing when the acknowledgement carried no survivor receipt (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  // Older CLIs resolve the interrupt without a receipt: the diagnostic-only
  // shape is not abort-specific, so the failure label stands.
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  }));
  extractor.finish();

  assert.deepEqual(activity, [
    "model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
  ]);
});

test("ClaudeStreamActivityExtractor keeps same-subtype genuine failures failing after a verified interruption (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  // error_during_execution without abort evidence is a genuine failure even
  // for the interrupted turn.
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "model_error",
    errors: ["synthetic model failure detail"],
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model failed · Claude error (error_during_execution): synthetic model failure detail"]);
});

test("ClaudeStreamActivityExtractor keeps unexplained execution errors failing after a verified interruption (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  // No terminal reason at all: no positive interruption evidence.
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["synthetic undiagnosed termination"],
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model failed · Claude error (error_during_execution): synthetic undiagnosed termination"]);
});

test("ClaudeStreamActivityExtractor keeps racing results failing before the interrupt is verified (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  // The result arrives while the native interrupt acknowledgement is still
  // pending: the turn ended on its own, so the failure label stands.
  extractor.notePendingInterruption("turn-1");
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    api_error_status: 429,
    errors: [],
    result: "Rate limited",
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model failed · Claude API 429: Rate limited"]);
});

test("ClaudeStreamActivityExtractor keeps genuine API failures failing even for a verified interrupted turn (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    api_error_status: 429,
    errors: [],
    result: "Rate limited",
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model failed · Claude API 429: Rate limited"]);
});

test("ClaudeStreamActivityExtractor keeps non-interruption subtypes failing for a verified interrupted turn (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    errors: ["max turns reached"],
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model failed · Claude error (error_max_turns): max turns reached"]);
});

test("ClaudeStreamActivityExtractor withdraws rejected interruptions so later failures keep their label (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.clearInterruption("turn-1");
  extractor.push(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    api_error_status: 500,
    errors: [],
    result: "Overloaded",
  }));
  extractor.finish();

  assert.deepEqual(activity, ["model failed · Claude API 500: Overloaded"]);
});

test("ClaudeStreamActivityExtractor keeps unrelated failures failing near recorded interruptions (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  // A verified interruption for one turn must not suppress a genuine API
  // failure of another turn, and the correlated unkeyed result still reports
  // the interruption.
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  extractor.push([
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 429,
      errors: [],
      result: "Rate limited",
      user_message_uuid: "turn-2",
    }),
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
    }),
  ].join("\n"));
  extractor.finish();

  assert.deepEqual(activity, [
    "model failed · Claude API 429: Rate limited",
    "model turn interrupted",
  ]);
});

test("ClaudeStreamActivityExtractor consumes recorded interruptions when the turn completes successfully (#305)", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  // The interrupt was a no-op: the turn completed on its own. The consumed
  // record must not relabel a later genuine failure of another turn.
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  extractor.push([
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", user_message_uuid: "turn-1" }),
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
    }),
  ].join("\n"));
  extractor.finish();

  assert.deepEqual(activity, [
    "model turn completed",
    "model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user stop_reason=tool_use",
  ]);
});

test("ClaudeStreamActivityExtractor retires interruptions on unkeyed success", () => {
  const activity: string[] = [];
  const extractor = new ClaudeStreamActivityExtractor((message) => activity.push(message));
  extractor.notePendingInterruption("turn-1");
  extractor.verifyInterruption("turn-1");
  extractor.push([
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_tools",
      errors: ["synthetic subsequent-turn termination"],
    }),
  ].join("\n"));
  extractor.finish();
  assert.deepEqual(activity, [
    "model turn completed",
    "model failed · Claude error (error_during_execution): synthetic subsequent-turn termination",
  ]);
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
