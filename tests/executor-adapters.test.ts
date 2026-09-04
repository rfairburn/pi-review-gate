import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { PiExecutorAdapter } from "../src/execution/adapters/pi-model";
import type { ExecutorLiveControl } from "../src/execution/types";

// Minimal stand-in for the trusted child extension in fake RPC fixtures. Real
// Pi children publish this only from agent_settled, with a LIVE browser.
// These protocol fixtures have no extension host.
const fakePiSettlementReceipt = [
  "const crypto=require('node:crypto');let ackGeneration=0;",
  "const ack=()=>{ackGeneration++;const sessionId=process.env.PI_REVIEW_GATE_SETTLEMENT_SESSION;const childId=process.env.PI_REVIEW_GATE_SETTLEMENT_CHILD;const secret=process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET;const target=process.env.PI_REVIEW_GATE_SETTLEMENT_PATH;const pid=process.pid;const version=2;const oneShot=crypto.createHmac('sha256',secret).update('pi-review-gate-live-browser-settlement-key:v2:'+ackGeneration).digest();const mac=crypto.createHmac('sha256',oneShot).update(JSON.stringify([version,sessionId,childId,ackGeneration,pid])).digest('base64url');const receipt={version,sessionId,childId,settlement:ackGeneration,pid,mac};fs.mkdirSync(require('node:path').dirname(target),{recursive:true,mode:0o700});const temporary=target+'.tmp.'+crypto.randomUUID();fs.writeFileSync(temporary,JSON.stringify(receipt)+'\\n',{mode:0o600});fs.renameSync(temporary,target);};",
];

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

test("Pi executor child loads the review-gate extension in executor role without inheriting disablement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-executor-env-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.json");
    const command = join(root, "env-capture-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      `fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));`,
      "let input=''; process.stdin.setEncoding('utf8');",
      "const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk; for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'research complete'}]}});out({type:'turn_end'});ack();out({type:'agent_end'});}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'research complete'}});",
      "else if(c.type==='abort'){out({type:'response',id:c.id,command:c.type,success:true});ack();out({type:'agent_end'});}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
    const previousExtraExtensions = process.env.PI_EXTRA_EXTENSIONS;
    // Simulate a parent context where the review gate is disabled and extra
    // extensions are configured; neither may reach the executor child.
    process.env.PI_REVIEW_GATE_DISABLED = "1";
    process.env.PI_EXTRA_EXTENSIONS = "/must/not/propagate.js";
    try {
      const adapter = new PiExecutorAdapter({ model: "provider/model", command });
      const result = await adapter.run({
        cwd: root,
        prompt: "research task",
        artifactDir,
        turn: 1,
        executorToolCatalog: {
          allowedToolCatalog: ["read", "WebSearch", "WebFetch", "BrowserExtract"],
          initialActiveTools: ["read", "WebFetch"],
        },
      });
      assert.equal(result.text, "research complete");
      const continued = await adapter.run({
        cwd: root,
        prompt: "continue research task",
        artifactDir,
        turn: 2,
        session: result.session,
        executorToolCatalog: {
          allowedToolCatalog: ["read", "WebSearch", "WebFetch", "BrowserExtract"],
          initialActiveTools: ["read", "WebFetch"],
        },
      });
      assert.equal(continued.session.id, result.session.id, "a fresh continuation process reuses the durable Pi session");
      const captured = JSON.parse(await readFile(capture, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };
      // The child must not inherit the review-gate kill switch from the parent
      // or have it imposed by the adapter; with it set, activate() returns
      // before the executor-role branch and no web tools are registered.
      assert.equal(captured.env.PI_REVIEW_GATE_DISABLED, undefined);
      assert.equal(captured.env.PI_REVIEW_GATE_RUNTIME_ROLE, "executor");
      assert.equal(captured.env.PI_EXTRA_EXTENSIONS, undefined);
      const tools = captured.argv[captured.argv.indexOf("--tools") + 1];
      assert.equal(tools, "read,WebSearch,WebFetch,BrowserExtract,search_tools");
      assert.deepEqual(JSON.parse(captured.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG!), {
        allowedToolCatalog: ["read", "WebSearch", "WebFetch", "BrowserExtract"],
        initialActiveTools: ["read", "WebFetch"],
      });
      const extension = captured.argv[captured.argv.indexOf("--extension") + 1];
      assert.ok(extension.endsWith("index.js"), `expected the review-gate extension to load in the child, got ${extension}`);
    } finally {
      if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
      else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
      if (previousExtraExtensions === undefined) delete process.env.PI_EXTRA_EXTENSIONS;
      else process.env.PI_EXTRA_EXTENSIONS = previousExtraExtensions;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor fails closed when agent_end and process lifetime provide no trusted settlement receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-missing-quiescence-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "unacknowledged-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});out({type:'agent_end'});}",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,success:true,data:{text:'untrusted completion claim'}});",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const result = await new PiExecutorAdapter({
      model: "provider/model",
      command,
      timeoutMs: 1_000,
      settlementTimeoutMs: 50,
    }).run({
      cwd: root,
      prompt: "finish without acknowledgement",
      artifactDir,
      turn: 1,
      allowedTools: ["read"],
    });
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /settlement acknowledgement was not received/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor does not turn child termination into successful completion", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-terminated-quiescence-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "terminated-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});ack();out({type:'agent_end'});setImmediate(()=>process.kill(process.pid,'SIGTERM'));}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const result = await new PiExecutorAdapter({
      model: "provider/model",
      command,
      settlementTimeoutMs: 100,
    }).run({
      cwd: root,
      prompt: "terminate",
      artifactDir,
      turn: 1,
      allowedTools: ["read"],
    });
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor does not mask a terminal cleanup hook error behind a valid live-browser settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-cleanup-"));
  try {
    const command = join(root, "rpc.cjs");
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';const out=v=>console.log(JSON.stringify(v));process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const c=JSON.parse(input.slice(0,n));input=input.slice(n+1);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});ack();out({type:'agent_end'});}",
      "else out({type:'response',id:c.id,success:true,data:c.type==='get_state'?{isStreaming:false,pendingMessageCount:0}:{text:'done'}});}});",
      "process.stdin.on('end',()=>out({type:'extension_error',event:'session_shutdown',error:'closure unconfirmed'}));",
    ].join("\n"));
    await chmod(command, 0o755);
    const result = await new PiExecutorAdapter({ model: "provider/model", command, timeoutMs: 2_000 }).run({
      cwd: root, prompt: "finish", artifactDir: root, turn: 1, allowedTools: ["read"],
    });
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /terminal session cleanup failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const cleanup of ["delayed", "stalled"] as const) {
  test(`Pi executor terminal cleanup ${cleanup === "delayed" ? "can outlast two seconds and the model deadline without termination" : "has a separate finite deadline before termination"}`, {
    skip: process.platform === "win32",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-terminal-cleanup-grace-"));
    try {
      const command = join(root, "rpc.cjs");
      const marker = join(root, "cleanup.json");
      await writeFile(command, [
        "#!/usr/bin/env node",
        "const fs=require('node:fs');",
        ...fakePiSettlementReceipt,
        `const marker=${JSON.stringify(marker)};let cleanupStarted;`,
        "process.on('SIGTERM',()=>{fs.writeFileSync(marker,JSON.stringify({state:'terminated',elapsed:Date.now()-cleanupStarted}));process.exit(1);});",
        "let input='';const out=v=>console.log(JSON.stringify(v));process.stdin.setEncoding('utf8');",
        "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const c=JSON.parse(input.slice(0,n));input=input.slice(n+1);",
        "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});ack();out({type:'agent_end'});}",
        "else out({type:'response',id:c.id,success:true,data:c.type==='get_state'?{isStreaming:false,pendingMessageCount:0}:{text:'done'}});}});",
        "process.stdin.on('end',()=>{cleanupStarted=Date.now();",
        cleanup === "delayed"
          ? "setTimeout(()=>fs.writeFileSync(marker,JSON.stringify({state:'complete',elapsed:Date.now()-cleanupStarted})),2500);"
          : "setInterval(()=>{},1000);",
        "});",
      ].join("\n"));
      await chmod(command, 0o755);
      const result = await new PiExecutorAdapter({ model: "provider/model", command, timeoutMs: 2_000 }).run({
        cwd: root, prompt: "finish", artifactDir: root, turn: 1, allowedTools: ["read"],
      });
      const outcome = JSON.parse(await readFile(marker, "utf8"));
      if (cleanup === "delayed") {
        assert.equal(outcome.state, "complete", "valid terminal cleanup must finish without SIGTERM");
        assert.ok(outcome.elapsed >= 2_400, "the fixture exercised cleanup beyond the old two-second grace");
        assert.equal(result.code, 0);
        assert.equal(result.failure, undefined);
        assert.equal(result.text, "done");
      } else {
        assert.equal(outcome.state, "terminated");
        assert.ok(outcome.elapsed >= 14_500, "cleanup receives its own grace, not the model deadline");
        assert.equal(result.code, 1);
        assert.equal(result.failure?.category, "protocol");
        assert.match(result.failure?.message ?? "", /terminal shutdown exceeded its 15000ms cleanup deadline/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Pi executor waits from agent_end through delayed child agent_settled acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-delayed-settlement-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "delayed-settlement-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';let settled=false;process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});out({type:'agent_end'});setTimeout(()=>{ack();settled=true;},150);}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,success:true,data:{isStreaming:!settled,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,success:true,data:{text:'settled after cleanup'}});",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const started = Date.now();
    const result = await new PiExecutorAdapter({ model: "provider/model", command, timeoutMs: 2_000 }).run({
      cwd: root,
      prompt: "wait for true settlement",
      artifactDir,
      turn: 1,
      allowedTools: ["read"],
    });
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "settled after cleanup");
    assert.ok(Date.now() - started >= 140, "agent_end alone must not release executor completion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor does not count retry agent_end events as settlement generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retry-settlement-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "retry-settlement-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';let settled=false;process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});out({type:'agent_end'});setTimeout(()=>{out({type:'agent_end'});setTimeout(()=>{settled=true;ack();},40);},40);}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,success:true,data:{isStreaming:!settled,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,success:true,data:{text:'retry settled once'}});",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const result = await new PiExecutorAdapter({ model: "provider/model", command, timeoutMs: 2_000 }).run({
      cwd: root,
      prompt: "retry before settlement",
      artifactDir,
      turn: 1,
      allowedTools: ["read"],
    });
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "retry settled once");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor follows trusted generations across an autonomous settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-autonomous-settlement-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "autonomous-settlement-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';let pending=true;let autoScheduled=false;process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});ack();out({type:'agent_end'});}",
      "else if(c.type==='get_state'){out({type:'response',id:c.id,success:true,data:{isStreaming:false,pendingMessageCount:pending?1:0}});if(pending&&!autoScheduled){autoScheduled=true;setTimeout(()=>{pending=false;ack();out({type:'agent_end'});},25);}}",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,success:true,data:{text:'autonomous final settlement'}});",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const result = await new PiExecutorAdapter({ model: "provider/model", command, timeoutMs: 2_000 }).run({
      cwd: root,
      prompt: "allow autonomous completion",
      artifactDir,
      turn: 1,
      allowedTools: ["read"],
    });
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "autonomous final settlement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      ...fakePiSettlementReceipt,
      `fs.writeFileSync(${JSON.stringify(environmentCapture)},JSON.stringify({toolCatalog:process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG}));`,
      "let input='';let streaming=false; process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk; for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){streaming=true;console.log(JSON.stringify({type:'response',id:c.id,command:'prompt',success:true}));console.log(JSON.stringify({type:'turn_start'}));}",
      "else if(c.type==='get_state')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:streaming,pendingMessageCount:0}}));",
      "else if(c.type==='steer'){streaming=false;console.log(JSON.stringify({type:'response',id:c.id,command:'steer',success:true}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'pi complete'}]}}));console.log(JSON.stringify({type:'turn_end'}));ack();console.log(JSON.stringify({type:'agent_end'}));}",
      "else if(c.type==='get_last_assistant_text')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{text:'pi complete'}}));",
      "else if(c.type==='abort'){streaming=false;console.log(JSON.stringify({type:'response',id:c.id,command:'abort',success:true}));ack();console.log(JSON.stringify({type:'agent_end'}));}",
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
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,bash,search_tools");
    const environment = JSON.parse(await readFile(environmentCapture, "utf8"));
    assert.deepEqual(JSON.parse(environment.toolCatalog), {
      allowedToolCatalog: ["read", "bash"],
      initialActiveTools: ["read", "bash"],
    });
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
      ...fakePiSettlementReceipt,
      `const capture=${JSON.stringify(capture)};`,
      "const out=(v)=>console.log(JSON.stringify(v));",
      "const settle=(text)=>{out({type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}});out({type:'turn_end'});ack();out({type:'agent_end'});};",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){prompts++;fs.appendFileSync(capture,JSON.stringify(c.message)+'\\n');out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});if(prompts===1){bg=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'});bg.unref();out({type:'tool_execution_end',toolName:'ShellStart',result:{content:[{type:'text',text:'Started \"long test\" as job1 (pid '+bg.pid+').\\nWaking you on: exit.'}]},isError:false});settle('background started');}else{if(bg){try{process.kill(-bg.pid,'SIGTERM')}catch{}}settle(prompts===2?'steering applied':'final inspection complete');}}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'final inspection complete'}});",
      "else if(c.type==='abort'){out({type:'response',id:c.id,command:c.type,success:true});ack();out({type:'agent_end'});}",
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

test("Codex research executor preserves the full allowed catalog with app-server steering", async () => {
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
      initialActiveTools: ["read"],
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
    // WebSearch remains available because it is role-authorized, even though
    // the durable future initial set does not include it.
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
