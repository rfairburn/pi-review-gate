import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { PiExecutorAdapter } from "../src/execution/adapters/pi-model";
import type { ExecutorLiveControl } from "../src/execution/types";

test("Pi executor refuses to launch without an authoritative native --tools allowlist", async () => {
  const adapter = new PiExecutorAdapter({ model: "provider/model", command: "must-not-launch" });
  await assert.rejects(
    adapter.run({
      cwd: process.cwd(),
      prompt: "task",
      artifactDir: join(tmpdir(), "pi-review-missing-tools"),
      turn: 1,
    }),
    /requires an authoritative tool allowlist for native --tools enforcement/,
  );
});

test("Pi executor uses acknowledged RPC steering and a durable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-rpc-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.json");
    const environmentCapture = join(root, "environment.json");
    const command = join(root, "little-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));`,
      `fs.writeFileSync(${JSON.stringify(environmentCapture)},JSON.stringify({}));`,
      "let input=''; process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk; for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){console.log(JSON.stringify({type:'response',id:c.id,command:'prompt',success:true}));console.log(JSON.stringify({type:'turn_start'}));}",
      "else if(c.type==='get_state')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:true,pendingMessageCount:0}}));",
      "else if(c.type==='steer'){console.log(JSON.stringify({type:'response',id:c.id,command:'steer',success:true}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'pi complete'}]}}));console.log(JSON.stringify({type:'turn_end'}));console.log(JSON.stringify({type:'agent_end'}));}",
      "else if(c.type==='get_last_assistant_text')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{text:'pi complete'}}));",
      "else if(c.type==='abort'){console.log(JSON.stringify({type:'response',id:c.id,command:'abort',success:true}));console.log(JSON.stringify({type:'agent_end'}));}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new PiExecutorAdapter({
      model: "provider/model",
      thinkingLevel: "high",
      command,
      args: [],
    });
    const run = adapter.run({
      cwd: root,
      prompt: "initial task",
      artifactDir,
      turn: 1,
      allowedTools: ["read", "bash", "SubtasksStart", "SubtasksSteer"],
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    assert.equal((await control.steer("new direction", "steer-1")).status, "acknowledged");
    const result = await run;
    assert.equal(result.text, "pi complete");
    assert.equal(result.session.adapter, "pi-model");
    const argv: string[] = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(argv[argv.indexOf("--mode") + 1], "rpc");
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,bash,SubtasksStart,SubtasksSteer");
    assert.deepEqual(JSON.parse(await readFile(environmentCapture, "utf8")), {});
    assert.equal(argv.includes("--print"), false);

    let resolveInterruptControl!: (control: ExecutorLiveControl) => void;
    const interruptControlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveInterruptControl = resolvePromise; });
    const interruptedRun = adapter.run({
      cwd: root,
      prompt: "interrupt this task",
      artifactDir,
      turn: 2,
      allowedTools: ["read", "bash", "SubtasksStart", "SubtasksSteer"],
      onLiveControl: (next) => { if (next) resolveInterruptControl(next); },
    });
    const interruptControl = await interruptControlReady;
    assert.equal((await interruptControl.interrupt()).status, "acknowledged");
    const interrupted = await interruptedRun;
    assert.equal(interrupted.aborted, true);
    assert.equal(interrupted.failure?.category, "interruption");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi stays alive for ShellStart work and accepts steering while its agent is idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-background-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "prompts.jsonl");
    const command = join(root, "little-background-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');const {spawn}=require('node:child_process');let input='';let bg;let prompts=0;process.stdin.setEncoding('utf8');",
      `const capture=${JSON.stringify(capture)};`,
      "const out=(v)=>console.log(JSON.stringify(v));",
      "const settle=(text)=>{out({type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}});out({type:'turn_end'});out({type:'agent_end'});};",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){prompts++;fs.appendFileSync(capture,JSON.stringify(c.message)+'\\n');out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});if(prompts===1){bg=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'});bg.unref();out({type:'tool_execution_end',toolName:'ShellStart',result:{content:[{type:'text',text:'Started \"long test\" as job1 (pid '+bg.pid+').\\nWaking you on: exit.'}]},isError:false});settle('background started');}else{if(bg){try{process.kill(-bg.pid,'SIGTERM')}catch{}}settle(prompts===2?'steering applied':'final inspection complete');}}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'final inspection complete'}});",
      "else if(c.type==='abort'){out({type:'response',id:c.id,command:c.type,success:true});out({type:'agent_end'});}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const updates: string[] = [];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new PiExecutorAdapter({
      model: "provider/model",
      command,
      timeoutMs: 2_000,
    });
    const run = adapter.run({
      cwd: root,
      prompt: "start background work",
      artifactDir,
      turn: 1,
      allowedTools: ["read", "bash", "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"],
      onUpdate: (message) => updates.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    await waitFor(() => updates.some((message) => message.includes("executor waiting")));
    const acknowledgement = await control.steer("replace true with false", "steer-background-1");
    assert.equal(acknowledgement.status, "acknowledged");
    assert.match(acknowledgement.message, /resumed the idle executor/);
    const result = await run;
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "final inspection complete");
    const prompts = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(prompts, [
      "start background work",
      "replace true with false",
      "ShellStart work that previously blocked this executor reached an idle transition. Re-check ShellList because a newer job may have started after the transition was observed. Inspect completed results and the workspace, address any failure, and finish the original task when current background readiness permits. Do not claim success from process exit alone; verify the requested outcome before responding.",
    ]);
    assert.ok(updates.some((message) => message.includes("final inspection before review")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex executor uses app-server turn steering with exact thread and turn ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-app-server-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.jsonl");
    const command = join(root, "codex-app-server.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs'); let input=''; process.stdin.setEncoding('utf8');",
      `const capture=${JSON.stringify(capture)};`,
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);fs.appendFileSync(capture,raw+'\\n');if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-1'}}}));",
      "else if(c.method==='turn/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-1'}}}));",
      "else if(c.method==='turn/steer'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turnId:'turn-1'}}));console.log(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text:'codex complete'}}}));console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}}));}",
      "else if(c.method==='turn/interrupt')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command, model: "gpt-test" });
    const run = adapter.run({
      cwd: root,
      prompt: "work",
      artifactDir,
      turn: 1,
      workspaceAccess: "read-only",
      allowedTools: ["read", "WebSearch"],
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.steer("adjust", "durable-steer-id")).status, "acknowledged");
    const result = await run;
    assert.equal(result.text, "codex complete");
    assert.equal(result.session.id, "thread-1");
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const steer = calls.find((call) => call.method === "turn/steer");
    assert.equal(steer.params.threadId, "thread-1");
    assert.equal(steer.params.expectedTurnId, "turn-1");
    assert.equal(steer.params.clientUserMessageId, "durable-steer-id");
    const threadStart = calls.find((call) => call.method === "thread/start");
    assert.equal(threadStart.params.sandbox, "read-only");
    assert.equal(threadStart.params.config.web_search, "live");
    assert.deepEqual(threadStart.params.config.mcp_servers, {});
    assert.equal(threadStart.params.config.apps._default.enabled, false);
    assert.deepEqual(threadStart.params.environments, []);
    assert.deepEqual(threadStart.params.dynamicTools, []);
    assert.ok(calls.some((call) => call.method === "initialized"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex interrupt waits for the active turn terminal notification", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-interrupt-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "codex-interrupt.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{userAgent:'codex-test/1.0'}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-i'}}}));",
      "else if(c.method==='turn/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-i'}}}));",
      "else if(c.method==='turn/interrupt'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-i',turn:{id:'turn-i',status:'interrupted'}}})),40);}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command, model: "gpt-test" });
    const run = adapter.run({
      cwd: root,
      prompt: "work",
      artifactDir,
      turn: 1,
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal(control.protocol, "codex-test/1.0");
    const startedAt = Date.now();
    assert.equal((await control.interrupt()).status, "acknowledged");
    assert.ok(Date.now() - startedAt >= 30, "interrupt acknowledgement must await turn completion");
    const result = await run;
    assert.equal(result.failure?.category, "interruption");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex research executor rejects launch arguments that could bypass its sandbox", async () => {
  const adapter = new CodexExecutorAdapter({
    id: "codex",
    adapter: "codex-cli",
    command: "must-not-launch",
    model: "gpt-test",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
  });
  await assert.rejects(adapter.run({
    cwd: process.cwd(),
    prompt: "research",
    artifactDir: join(tmpdir(), "pi-review-codex-policy-override"),
    turn: 1,
    workspaceAccess: "read-only",
  }), /rejects CLI argument --dangerously-bypass-approvals-and-sandbox/);
});

test("Codex research executor retains safe model reasoning configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-safe-config-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "codex-safe-config.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-safe'}}}));",
      "else if(c.method==='turn/start'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-safe'}}}));console.log(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text:'done'}}}));console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-safe',turn:{id:'turn-safe',status:'completed'}}}));}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const adapter = new CodexExecutorAdapter({
      id: "codex",
      adapter: "codex-cli",
      command,
      model: "gpt-test",
      args: ["-c", "model_reasoning_effort=\"high\""],
    });
    const result = await adapter.run({
      cwd: root,
      prompt: "research",
      artifactDir,
      turn: 1,
      workspaceAccess: "read-only",
      allowedTools: ["read"],
    });
    assert.equal(result.text, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("timed out waiting for condition");
}
