import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { LittleCoderExecutorAdapter } from "../src/execution/adapters/little-coder";

test("little-coder executor uses the canonical model, isolated session, and nested-gate kill switch", async () => {
  const fixture = await harnessFixture("little");
  const adapter = new LittleCoderExecutorAdapter({
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "max",
    command: fixture.command,
    args: [fixture.capture],
  });

  const activity: string[] = [];
  const first = await adapter.run({
    ...request(fixture, 1),
    onUpdate: (message) => activity.push(message),
  });
  const second = await adapter.run(request(fixture, 2, first.session));

  assert.equal(first.text, "little complete");
  assert.deepEqual(activity, ["model turn started", "model update · little complete", "model turn completed"]);
  assert.equal(second.session.id, first.session.id);
  const captured = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.deepEqual(valueAfter(captured.argv, "--model"), "openai-codex/gpt-5.6-sol");
  assert.deepEqual(valueAfter(captured.argv, "--thinking"), "max");
  assert.equal(captured.thinkingBudget, "0");
  assert.deepEqual(valueAfter(captured.argv, "--session-id"), first.session.id);
  assert.equal(captured.disabled, "1");
});

test("little-coder executor preserves terminal provider errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-provider-error-"));
  try {
    const artifactDir = join(root, "artifacts");
    await mkdir(artifactDir);
    const command = join(root, "provider-error.cjs");
    await writeFile(command, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],errorMessage:'Provider capacity exhausted'}}));",
      "console.log(JSON.stringify({type:'auto_retry_end',success:false,finalError:'Provider capacity exhausted'}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const adapter = new LittleCoderExecutorAdapter({ model: "provider/model", command });
    const result = await adapter.run({ cwd: root, prompt: "work", artifactDir, turn: 1 });
    assert.deepEqual(result.failure, { category: "provider", message: "Provider capacity exhausted" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("little-coder executor classifies an unfinished compaction as an interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-compaction-"));
  try {
    const artifactDir = join(root, "artifacts");
    await mkdir(artifactDir);
    const command = join(root, "compaction.cjs");
    await writeFile(command, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],errorMessage:'This operation was aborted'}}));",
      "console.log(JSON.stringify({type:'compaction_start',reason:'manual'}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const adapter = new LittleCoderExecutorAdapter({ model: "provider/model", command });
    const result = await adapter.run({ cwd: root, prompt: "work", artifactDir, turn: 1 });
    assert.deepEqual(result.failure, {
      category: "interruption",
      message: "Executor process ended while context compaction was in progress.",
    });
    assert.equal(result.lifecycle?.compaction.status, "in_progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("little-coder executor explicitly compacts the exact durable session before resuming", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-compact-recovery-"));
  try {
    const artifactDir = join(root, "artifacts");
    await mkdir(artifactDir);
    const command = join(root, "compact-recovery.cjs");
    const log = join(root, "rpc-log.jsonl");
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      "const mode=process.argv[process.argv.indexOf('--mode')+1];",
      `const log=${JSON.stringify(log)};`,
      "if(mode==='rpc') {",
      " let input=''; process.stdin.setEncoding('utf8');",
      " process.stdin.on('data',chunk=>{ input+=chunk; for(;;){ const n=input.indexOf('\\n'); if(n<0)break; const line=input.slice(0,n); input=input.slice(n+1); if(!line)continue; const command=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(command)+'\\n'); if(command.type==='get_state') console.log(JSON.stringify({type:'response',id:command.id,command:'get_state',success:true,data:{sessionId:'durable-session'}})); else if(command.type==='compact') console.log(JSON.stringify({type:'response',id:command.id,command:'compact',success:true,data:{summary:'preserved'}})); } });",
      "} else {",
      " process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'resumed after compact'}]}})); });",
      "}",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const adapter = new LittleCoderExecutorAdapter({ model: "provider/model", command });
    const updates: string[] = [];
    const processLifecycle: string[] = [];
    const result = await adapter.run({
      cwd: root,
      prompt: "continue",
      artifactDir,
      turn: 2,
      session: { adapter: "little-coder-model", id: "durable-session" },
      recovery: { kind: "compaction", compactBeforePrompt: true },
      onUpdate: (message) => updates.push(message),
      onProcessStart: ({ pid }) => { processLifecycle.push(`start:${pid}`); },
      onProcessExit: ({ pid }) => { processLifecycle.push(`exit:${pid}`); },
    });

    assert.equal(result.text, "resumed after compact");
    const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(commands.map((entry) => entry.type), ["get_state", "compact"]);
    assert.match(commands[1].customInstructions, /Preserve the task objective/);
    assert.ok(updates.includes("reopening executor session for context compaction"));
    assert.ok(updates.includes("context compaction completed; resuming executor"));
    assert.equal(processLifecycle.length, 4);
    assert.match(processLifecycle[0] ?? "", /^start:/);
    assert.equal(processLifecycle[1]?.replace("exit:", ""), processLifecycle[0]?.replace("start:", ""));
    assert.match(processLifecycle[2] ?? "", /^start:/);
    assert.equal(processLifecycle[3]?.replace("exit:", ""), processLifecycle[2]?.replace("start:", ""));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex executor starts with automatic workspace-write approval and resumes the exact thread", async () => {
  const fixture = await harnessFixture("codex");
  const adapter = new CodexExecutorAdapter({
    id: "codex",
    adapter: "codex-cli",
    command: fixture.command,
    model: "gpt-5.6-sol",
    args: [],
    env: { CAPTURE_PATH: fixture.capture, PI_REVIEW_GATE_DISABLED: "0" },
  });

  const activity: string[] = [];
  const first = await adapter.run({
    ...request(fixture, 1),
    onUpdate: (message) => activity.push(message),
  });
  assert.equal(first.session.id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(activity, ["model turn started", "model update · codex complete", "model turn completed"]);
  const start = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.ok(start.argv.includes("--approve-for-me"));
  assert.ok(!start.argv.includes("--sandbox"));
  assert.equal(valueAfter(start.argv, "--model"), "gpt-5.6-sol");
  assert.equal(start.disabled, "1");

  await adapter.run(request(fixture, 2, first.session));
  const resumed = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.deepEqual(resumed.argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.argv.includes(first.session.id));
});

test("Claude executor uses editable auto mode and resumes its UUID", async () => {
  const fixture = await harnessFixture("claude");
  const adapter = new ClaudeExecutorAdapter({
    id: "claude",
    adapter: "claude-cli",
    command: fixture.command,
    model: "sonnet",
    args: [],
    env: { CAPTURE_PATH: fixture.capture },
  });

  const first = await adapter.run(request(fixture, 1));
  const start = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.equal(first.text, "claude complete");
  assert.equal(valueAfter(start.argv, "--permission-mode"), "auto");
  assert.equal(valueAfter(start.argv, "--tools"), "default");
  assert.equal(valueAfter(start.argv, "--session-id"), first.session.id);

  await adapter.run(request(fixture, 2, first.session));
  const resumed = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.equal(valueAfter(resumed.argv, "--resume"), first.session.id);
});

async function harnessFixture(mode: "little" | "codex" | "claude"): Promise<{
  root: string;
  artifactDir: string;
  command: string;
  capture: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-${mode}-adapter-`));
  const artifactDir = join(root, "artifacts");
  await mkdir(artifactDir);
  const command = join(root, "fake-harness.cjs");
  const capture = join(root, "capture.json");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const mode = ${JSON.stringify(mode)};`,
    "const argv = process.argv.slice(2);",
    "const capture = process.env.CAPTURE_PATH || argv.at(-1);",
    "fs.writeFileSync(capture, JSON.stringify({ argv, disabled: process.env.PI_REVIEW_GATE_DISABLED, thinkingBudget: process.env.LITTLE_CODER_THINKING_BUDGET }));",
    "if (mode === 'little') {",
    "  console.log(JSON.stringify({ type: 'turn_start' }));",
    "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'little complete' }] } }));",
    "  console.log(JSON.stringify({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] }));",
    "} else if (mode === 'codex') {",
    "  console.log(JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }));",
    "  console.log(JSON.stringify({ type: 'turn.started' }));",
    "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex complete' } }));",
    "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));",
    "} else {",
    "  console.log(JSON.stringify({ result: 'claude complete', usage: { input_tokens: 10, output_tokens: 2 } }));",
    "}",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { root, artifactDir, command, capture };
}

function request(
  fixture: { root: string; artifactDir: string },
  turn: number,
  session?: { adapter: string; id: string },
) {
  return {
    cwd: fixture.root,
    prompt: `turn ${turn}`,
    artifactDir: fixture.artifactDir,
    turn,
    session,
  };
}

function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index === -1 ? undefined : values[index + 1];
}
