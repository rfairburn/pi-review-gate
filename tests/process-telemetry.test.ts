import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("runPromptProcess durably announces ownership before sending the prompt and reports exit", async () => {
  const events: string[] = [];
  let releaseStart!: () => void;
  let announceStart!: () => void;
  const startAnnounced = new Promise<void>((resolve) => { announceStart = resolve; });
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let completed = false;
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('done'))"],
    cwd: process.cwd(),
    prompt: "begin",
    timeoutMs: 15_000,
    onProcessStart: async ({ pid, processGroupId }) => {
      assert.ok(pid > 0);
      if (process.platform !== "win32") assert.equal(processGroupId, pid);
      events.push("start-begin");
      announceStart();
      await startGate;
      events.push("start-durable");
    },
    onProcessExit: ({ code }) => {
      events.push(`exit-${code}`);
    },
  }).then((result) => {
    completed = true;
    return result;
  });

  await startAnnounced;
  assert.equal(completed, false, "the child must not receive its prompt before ownership is durable");
  releaseStart();
  const output = await running;
  assert.equal(output.stdout, "done");
  assert.deepEqual(events, ["start-begin", "start-durable", "exit-0"]);
});

test("an ownership-publication failure quiesces the child and records exit before rejecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-owner-failure-"));
  const marker = join(root, "prompt-received");
  const events: string[] = [];
  try {
    await assert.rejects(
      runPromptProcess({
        command: process.execPath,
        args: ["-e", [
          "const fs=require('node:fs');",
          "process.stdin.resume();",
          `process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(marker)},'yes'));`,
          "setInterval(()=>{},1000);",
        ].join("")],
        cwd: root,
        prompt: "must not be delivered",
        timeoutMs: 15_000,
        onProcessStart: () => {
          events.push("start");
          throw new Error("ownership publication failed");
        },
        onProcessExit: () => { events.push("exit"); },
      }),
      /ownership publication failed/,
    );
    assert.deepEqual(events, ["start", "exit"]);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
