import assert from "node:assert/strict";
import test from "node:test";
import { processTelemetry, runPromptProcess } from "../src/adapters/process";

test("review process telemetry records stream, tool-result, and compaction volume without imposing a budget", async () => {
  const script = [
    "const events=[",
    "{type:'message',message:{role:'assistant',content:[{type:'toolCall',name:'read'}]}},",
    "{type:'message',message:{role:'toolResult',content:[{type:'text',text:'file contents'}]}},",
    "{type:'compaction_start',reason:'manual'},",
    "{type:'message',message:{role:'assistant',content:[{type:'text',text:'done'}]}}",
    "];",
    "for(const event of events)process.stdout.write(JSON.stringify(event)+'\\n');",
  ].join("");
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    prompt: "review",
    timeoutMs: 15000,
  });
  const telemetry = processTelemetry(output);

  assert.equal(output.code, 0);
  assert.equal(telemetry.streamEvents, 4);
  assert.equal(telemetry.toolCalls, 1);
  assert.ok((telemetry.toolResultBytes ?? 0) > 0);
  assert.equal(telemetry.compactions, 1);
  assert.equal(telemetry.stdoutBytes, Buffer.byteLength(output.stdout));
  assert.equal(telemetry.stdoutTruncated, false);
});

test("review process telemetry counts repeated lifecycle representations as one tool call", async () => {
  const call = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } };
  const events = [
    { type: "message_start", message: { role: "assistant", content: [call] } },
    { type: "message_end", message: { role: "assistant", content: [call] } },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "read" },
    { type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "payload" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "payload" }] } },
  ];
  const script = `for(const event of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(event)+'\\n')`;
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    prompt: "review",
    timeoutMs: 15000,
  });

  assert.equal(output.code, 0);
  assert.equal(processTelemetry(output).toolCalls, 1);
  const oneResult = events[4]?.message;
  assert.equal(processTelemetry(output).toolResultBytes, Buffer.byteLength(JSON.stringify(oneResult)));
});

test("runPromptProcess reports early stdin closure instead of crashing the host", async () => {
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.destroy();process.exitCode=7"],
    cwd: process.cwd(),
    prompt: "x".repeat(2_000_000),
    timeoutMs: 15_000,
  });

  assert.equal(output.aborted, false);
  assert.equal(output.timedOut, false);
  assert.ok(output.code !== 0 || output.stdinError);
});

test("runPromptProcess remains abortable while a large prompt is being written", async () => {
  const controller = new AbortController();
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.pause();setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    prompt: "x".repeat(8 * 1024 * 1024),
    timeoutMs: 15_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  const output = await running;
  assert.equal(output.aborted, true);
  assert.equal(output.timedOut, false);
});
