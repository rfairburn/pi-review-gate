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
});
