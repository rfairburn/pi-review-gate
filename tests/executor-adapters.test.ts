import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { LittleCoderExecutorAdapter } from "../src/execution/adapters/little-coder";
import type { ExecutorLiveControl } from "../src/execution/types";

test("Little Coder executor uses acknowledged RPC steering and a durable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-rpc-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.json");
    const command = join(root, "little-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));`,
      "let input=''; process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk; for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){console.log(JSON.stringify({type:'response',id:c.id,command:'prompt',success:true}));console.log(JSON.stringify({type:'turn_start'}));}",
      "else if(c.type==='steer'){console.log(JSON.stringify({type:'response',id:c.id,command:'steer',success:true}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'little complete'}]}}));console.log(JSON.stringify({type:'turn_end'}));console.log(JSON.stringify({type:'agent_settled'}));}",
      "else if(c.type==='get_last_assistant_text')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{text:'little complete'}}));",
      "else if(c.type==='abort'){console.log(JSON.stringify({type:'response',id:c.id,command:'abort',success:true}));console.log(JSON.stringify({type:'agent_settled'}));}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new LittleCoderExecutorAdapter({
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
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    assert.equal((await control.steer("new direction", "steer-1")).status, "acknowledged");
    const result = await run;
    assert.equal(result.text, "little complete");
    assert.equal(result.session.adapter, "little-coder-model");
    const argv: string[] = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(argv[argv.indexOf("--mode") + 1], "rpc");
    assert.equal(argv.includes("--print"), false);

    let resolveInterruptControl!: (control: ExecutorLiveControl) => void;
    const interruptControlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveInterruptControl = resolvePromise; });
    const interruptedRun = adapter.run({
      cwd: root,
      prompt: "interrupt this task",
      artifactDir,
      turn: 2,
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
