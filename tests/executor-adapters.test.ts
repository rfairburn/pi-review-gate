import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";
import { PiExecutorAdapter, PiRpc } from "../src/execution/adapters/pi-model";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";
import type { ExecutorLiveControl, ExecutorRequest } from "../src/execution/types";

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
    /requires an authoritative executor tool catalog for native --tools enforcement/,
  );
});

for (const [name, runLegacyRequest] of [
  [
    "Pi",
    async () => new PiExecutorAdapter({ model: "provider/model", command: "must-not-launch" })
      .run({ cwd: process.cwd(), prompt: "task", artifactDir: join(tmpdir(), "pi-review-legacy-request"), turn: 1, allowedTools: ["read"] } as unknown as ExecutorRequest),
  ],
  [
    "Codex",
    async () => new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: "must-not-launch", model: "gpt-test" })
      .run({ cwd: process.cwd(), prompt: "work", artifactDir: join(tmpdir(), "pi-review-codex-legacy-request"), turn: 1, allowedTools: ["read"] } as unknown as ExecutorRequest),
  ],
  [
    "Claude",
    async () => new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "must-not-launch", model: "sonnet" })
      .run({ cwd: process.cwd(), prompt: "work", artifactDir: join(tmpdir(), "pi-review-claude-legacy-request"), turn: 1, allowedTools: ["read"], initialActiveTools: ["read"] } as unknown as ExecutorRequest),
  ],
] as const) {
  test(`${name} executor rejects old-only legacy request fields before any launch`, async () => {
    // A spawn attempt would surface a command-resolution failure instead of
    // the explicit pre-cutover diagnostic, so the message proves no process
    // or SDK launch occurred.
    await assert.rejects(runLegacyRequest(), /Unsupported pre-cutover executor request/);
  });
}

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

test("Pi executor launches research workers with authorized native discovery active from launch (#71)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-discovery-launch-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.json");
    const environmentCapture = join(root, "environment.json");
    const command = join(root, "discovery-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      `fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));`,
      `fs.writeFileSync(${JSON.stringify(environmentCapture)},JSON.stringify({toolCatalog:process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG}));`,
      "let input=''; process.stdin.setEncoding('utf8');",
      "const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk; for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      "if(c.type==='prompt'){out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'research complete'}]}});out({type:'turn_end'});ack();out({type:'agent_end'});}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'research complete'}});",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const adapter = new PiExecutorAdapter({ model: "provider/model", command });
    const result = await adapter.run({
      cwd: root,
      prompt: "research task",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read", "grep", "find", "ls", "WebSearch"],
        initialActiveTools: ["read", "grep", "find", "ls"],
      },
    });
    assert.equal(result.text, "research complete");
    const argv: string[] = JSON.parse(await readFile(capture, "utf8"));
    // The native --tools allowlist carries the full inherited catalog plus the
    // loader; the durable initial subset starts the discovery trio active so
    // the worker never needs search_tools before its first discovery call.
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,WebSearch,search_tools");
    const environment = JSON.parse(await readFile(environmentCapture, "utf8"));
    assert.deepEqual(JSON.parse(environment.toolCatalog), {
      allowedToolCatalog: ["read", "grep", "find", "ls", "WebSearch"],
      initialActiveTools: ["read", "grep", "find", "ls"],
    });
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
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor contains a late RPC write after the child closed its stdin and still fails the terminated child", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-late-write-epipe-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "late-write-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';const out=(v)=>console.log(JSON.stringify(v));process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      // Publish the trusted receipt, hard-close the child's pipe read side
      // (POSIX-guaranteed EPIPE for any later parent write), and only then
      // announce agent_end: once the parent sees agent_end, its next RPC write
      // deterministically lands on a peer whose read side is gone while the
      // parent's own stream still reports writable. The child stays alive
      // until the adapter's SIGTERM so the exit is an actual signal,
      // not a benign race the fixture could mask.
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});ack();fs.closeSync(0);setImmediate(()=>out({type:'agent_end'}));}",
      "}});",
      "setInterval(()=>{},1000);",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
    const result = await new PiExecutorAdapter({
      model: "provider/model",
      command,
      settlementTimeoutMs: 100,
    }).run({
      cwd: root,
      prompt: "terminate after late write",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
      onProcessExit: (exit) => {
        exits.push(exit);
      },
    });
    assert.equal(result.code, 1, "a broken RPC transport must never be reported as successful execution");
    assert.equal(result.failure?.category, "protocol");
    assert.equal(exits[0]!.signal, "SIGTERM", "the adapter must terminate the orphaned child itself");
    assert.ok(exits[0]!.code === null, "the child exited by signal, not a success code");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PiRpc latches a transport error that arrives with no pending request and fails future operations", async () => {
  // Deterministic stream-error regression: the EPIPE arrives after the final
  // response, when nothing is in flight. The failure must be latched (not
  // forgotten), settlement waiters must reject immediately instead of waiting
  // out the executor timeout, and future protocol operations must reject
  // without writing to the broken transport.
  const { proc, stdin, stdout } = createFakePiChild();
  const rpc = new PiRpc(proc, new BackgroundProcessReadiness(), () => undefined);
  const prompt = rpc.request("prompt", { message: "hello" });
  stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "response", id: "review-gate-1", success: true })}\n`));
  await prompt;
  // Awaiting settlement with no RPC in flight, like waiting for agent_end.
  const settling = rpc.waitForSettled(0);
  stdin.emit("error", new Error("write EPIPE"));
  assert.ok(rpc.failure instanceof Error, "the first transport failure must be latched even with no pending request");
  assert.equal(rpc.failure.message, "write EPIPE");
  await assert.rejects(settling, /EPIPE/, "settlement waiters must fail on the transport error");
  const writesBefore = stdin.written.length;
  await assert.rejects(rpc.request("get_state", {}), /transport failed/i, "future protocol operations must reject immediately on a failed transport");
  assert.equal(stdin.written.length, writesBefore, "a failed transport must not receive further writes");
  // The child's exit still settles so the adapter can finish truthfully.
  proc.emit("close", 0, null);
  assert.deepEqual(await rpc.closed(), { code: 0, signal: null });
});

test("PiRpc latches output-pipe errors through the same transport failure path", async () => {
  // stdout carries terminal-cleanup evidence (session_shutdown events) and
  // stderr carries child diagnostics; an error on either means captured
  // output is incomplete, so it must fail closed instead of being discarded.
  const { proc, stdout, stderr } = createFakePiChild();
  const rpc = new PiRpc(proc, new BackgroundProcessReadiness(), () => undefined);
  stdout.emit("error", new Error("read EIO"));
  assert.ok(rpc.failure instanceof Error, "an output-pipe error must be latched, not discarded");
  assert.equal(rpc.failure.message, "read EIO");
  await assert.rejects(rpc.request("get_state", {}), /transport failed/i);
  // The first failure stays authoritative; a later stderr error must not
  // replace it or crash the parent.
  stderr.emit("error", new Error("write EPIPE"));
  assert.equal(rpc.failure.message, "read EIO");
});

test("Pi executor fails the shutdown/settlement race when the child exits zero before settling", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-zero-exit-settlement-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "zero-exit-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      // Acknowledge the prompt, then exit zero without agent_end or a
      // settlement receipt: the parent is left awaiting settlement against a
      // child that is already gone. That race must settle as an immediate,
      // truthful protocol failure, not as success and not via the executor
      // timeout.
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});process.exit(0);}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
    const started = Date.now();
    const result = await new PiExecutorAdapter({
      model: "provider/model",
      command,
      settlementTimeoutMs: 100,
    }).run({
      cwd: root,
      prompt: "exit before settling",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
      onProcessExit: (exit) => {
        exits.push(exit);
      },
    });
    assert.equal(result.code, 1, "a zero exit without settlement must not be reported as successful completion");
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /exited before protocol completion/);
    assert.equal(exits[0]?.code, 0, "the child really did exit zero; the failure is truthful, not masked");
    assert.ok(Date.now() - started < 5_000, "settlement must fail fast on child death, not wait out the executor deadline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor fails a final-response/shutdown race when the child exits zero after its last response", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-zero-exit-final-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "zero-exit-final-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      ...fakePiSettlementReceipt,
      "let input='';const out=(v)=>console.log(JSON.stringify(v));process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
      // Complete the whole protocol (response, receipt, agent_end, clean
      // get_state), then hard-close the stdin read side and exit zero before
      // the parent's final get_last_assistant_text write: that write lands on
      // a dead transport while every response already arrived. The run must
      // still fail as a protocol error instead of reporting success.
      "if(c.type==='prompt'){out({type:'response',id:c.id,success:true});ack();out({type:'agent_end'});}",
      "else if(c.type==='get_state'){out({type:'response',id:c.id,success:true,data:{isStreaming:false,pendingMessageCount:0}});fs.closeSync(0);process.exit(0);}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
    const result = await new PiExecutorAdapter({
      model: "provider/model",
      command,
      settlementTimeoutMs: 100,
    }).run({
      cwd: root,
      prompt: "exit after final response",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
      onProcessExit: (exit) => {
        exits.push(exit);
      },
    });
    assert.equal(result.code, 1, "a broken transport after the final response must never be reported as successful execution");
    assert.equal(result.failure?.category, "protocol");
    // The child calls process.exit(0) right after its last response; the
    // adapter's containment SIGTERM may win that race. Either way the child is
    // settled exactly once (no orphan) and the run is a truthful failure.
    assert.equal(exits.length, 1, "the child must be settled exactly once, with no orphan process");
    assert.ok(
      exits[0]!.code === 0 || exits[0]!.signal === "SIGTERM",
      `the child either exited zero on its own or was contained by the adapter's SIGTERM, got ${JSON.stringify(exits[0])}`,
    );
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
      cwd: root, prompt: "finish", artifactDir: root, turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
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
        cwd: root, prompt: "finish", artifactDir: root, turn: 1,
        executorToolCatalog: {
          allowedToolCatalog: ["read"],
          initialActiveTools: ["read"],
        },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read", "bash", "SubtasksStart", "SubtasksSteer"],
        initialActiveTools: ["read", "bash", "SubtasksStart", "SubtasksSteer"],
      },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read", "bash", "SubtasksStart", "SubtasksSteer"],
        initialActiveTools: ["read", "bash", "SubtasksStart", "SubtasksSteer"],
      },
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
      executorToolCatalog: {
        allowedToolCatalog: ["read", "bash", "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"],
        initialActiveTools: ["read", "bash", "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"],
      },
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

test("Pi executor interrupts the active turn and delivers steering to the same session (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-steer-interrupt-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "prompts.jsonl");
    const commands = join(root, "commands.log");
    const command = join(root, "little-steer-interrupt-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let input='';let streaming=false;let lastText='';let prompts=0;process.stdin.setEncoding('utf8');",
      ...fakePiSettlementReceipt,
      `const capture=${JSON.stringify(capture)};const commands=${JSON.stringify(commands)};`,
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);fs.appendFileSync(commands,c.type+'\\n');",
      "if(c.type==='prompt'){prompts++;streaming=true;fs.appendFileSync(capture,JSON.stringify(c.message)+'\\n');console.log(JSON.stringify({type:'response',id:c.id,command:'prompt',success:true}));console.log(JSON.stringify({type:'turn_start'}));if(prompts>1){streaming=false;lastText='steered complete';console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:lastText}]}}));console.log(JSON.stringify({type:'turn_end'}));ack();console.log(JSON.stringify({type:'agent_end'}));}}",
      "else if(c.type==='get_state')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:streaming,pendingMessageCount:0}}));",
      "else if(c.type==='get_last_assistant_text')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{text:lastText}}));",
      "else if(c.type==='abort'){streaming=false;console.log(JSON.stringify({type:'response',id:c.id,command:'abort',success:true}));ack();console.log(JSON.stringify({type:'agent_end'}));}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new PiExecutorAdapter({
      model: "provider/model",
      command,
    });
    const run = adapter.run({
      cwd: root,
      prompt: "initial task",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read", "bash"],
        initialActiveTools: ["read", "bash"],
      },
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    // The initial turn stays streaming until the interruption below.
    const acknowledgement = await control.steer("steer the active turn", "steer-interrupt-1", { interrupt: true });
    assert.equal(acknowledgement.status, "acknowledged");
    assert.match(acknowledgement.message, /interrupted the active turn/);
    const result = await run;
    assert.equal(result.failure, undefined);
    // The steered turn's settlement is the completion text, not the aborted
    // turn's partial output.
    assert.equal(result.text, "steered complete");
    const prompts = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(prompts, ["initial task", "steer the active turn"]);
    // Interrupt-before-delivery: the abort precedes the replacement prompt on
    // the wire, in the same session.
    const seen = (await readFile(commands, "utf8")).trim().split("\n");
    const abortAt = seen.indexOf("abort");
    const promptAt = seen.lastIndexOf("prompt");
    assert.ok(abortAt > -1 && promptAt > abortAt, "abort must be delivered before the replacement prompt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor acknowledges interrupt steering before the replacement settles and accepts a second steer (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-steer-ack-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "prompts.jsonl");
    const commands = join(root, "commands.log");
    const command = join(root, "little-steer-ack-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let input='';let streaming=false;let lastText='';let prompts=0;process.stdin.setEncoding('utf8');",
      ...fakePiSettlementReceipt,
      `const capture=${JSON.stringify(capture)};const commands=${JSON.stringify(commands)};`,
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);fs.appendFileSync(commands,c.type+'\\n');",
      "if(c.type==='prompt'){prompts++;streaming=true;fs.appendFileSync(capture,JSON.stringify(c.message)+'\\n');console.log(JSON.stringify({type:'response',id:c.id,command:'prompt',success:true}));console.log(JSON.stringify({type:'turn_start'}));if(prompts===3){setTimeout(()=>{streaming=false;lastText='second steer complete';console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:lastText}]}}));console.log(JSON.stringify({type:'turn_end'}));ack();console.log(JSON.stringify({type:'agent_end'}));},50);}}",
      "else if(c.type==='get_state')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:streaming,pendingMessageCount:0}}));",
      "else if(c.type==='steer')console.log(JSON.stringify({type:'response',id:c.id,command:'steer',success:true}));",
      "else if(c.type==='get_last_assistant_text')console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{text:lastText}}));",
      "else if(c.type==='abort'){streaming=false;console.log(JSON.stringify({type:'response',id:c.id,command:'abort',success:true}));ack();console.log(JSON.stringify({type:'agent_end'}));}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new PiExecutorAdapter({
      model: "provider/model",
      command,
    });
    const run = adapter.run({
      cwd: root,
      prompt: "initial task",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read", "bash"],
        initialActiveTools: ["read", "bash"],
      },
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    let settled = false;
    const done = run.finally(() => { settled = true; });
    // The first replacement turn deliberately stays running after acceptance.
    const first = await control.steer("steer the active turn", "steer-ack-1", { interrupt: true });
    assert.equal(first.status, "acknowledged");
    assert.match(first.message, /interrupted the active turn/);
    // The acknowledgement establishes transport acceptance only: the adapter
    // run must still be pending while its replacement turn is unfinished.
    assert.equal(settled, false, "steering ACK must not await replacement turn completion");
    // A plain steer reaches the still-running replacement without interruption.
    const second = await control.steer("keep going", "steer-plain-2", { interrupt: false });
    assert.equal(second.status, "acknowledged");
    assert.match(second.message, /live steering/);
    // A second interrupt-steer targets the replacement turn itself.
    const third = await control.steer("stop and finish differently", "steer-interrupt-3", { interrupt: true });
    assert.equal(third.status, "acknowledged");
    assert.match(third.message, /interrupted the active turn/);
    const result = await done;
    assert.equal(result.failure, undefined);
    // run() followed both handoffs; the final text is the second replacement's.
    assert.equal(result.text, "second steer complete");
    const prompts = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(prompts, ["initial task", "steer the active turn", "stop and finish differently"]);
    // Outbound ordering: each interruption precedes its own replacement
    // prompt, and the plain steer never issues an abort.
    const seen = (await readFile(commands, "utf8")).trim().split("\n");
    const aborts = seen.map((line, index) => line === "abort" ? index : -1).filter((index) => index >= 0);
    const promptAt = seen.map((line, index) => line === "prompt" ? index : -1).filter((index) => index >= 0);
    assert.equal(aborts.length, 2);
    assert.equal(promptAt.length, 3);
    assert.ok(aborts[0]! < promptAt[1]!, "first interruption precedes its replacement prompt");
    assert.ok(aborts[1]! > promptAt[1]! && aborts[1]! < promptAt[2]!, "second interruption targets the replacement turn and precedes its own replacement prompt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executor interrupt steering without an active turn reports no interruption (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-little-steer-idle-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "prompts.jsonl");
    const commands = join(root, "commands.log");
    const command = join(root, "little-steer-idle-rpc.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');const {spawn}=require('node:child_process');let input='';let bg;let prompts=0;process.stdin.setEncoding('utf8');",
      ...fakePiSettlementReceipt,
      `const capture=${JSON.stringify(capture)};const commands=${JSON.stringify(commands)};`,
      "const out=(v)=>console.log(JSON.stringify(v));",
      "const settle=(text)=>{out({type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}});out({type:'turn_end'});ack();out({type:'agent_end'});};",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);fs.appendFileSync(commands,c.type+'\\n');",
      "if(c.type==='prompt'){prompts++;fs.appendFileSync(capture,JSON.stringify(c.message)+'\\n');out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});if(prompts===1){bg=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{detached:true,stdio:'ignore'});bg.unref();out({type:'tool_execution_end',toolName:'ShellStart',result:{content:[{type:'text',text:'Started \"idle test\" as job1 (pid '+bg.pid+').\\nWaking you on: exit.'}]},isError:false});settle('background started');}else if(prompts===2){settle('steered complete');}else{if(bg){try{process.kill(-bg.pid,'SIGTERM')}catch{}}settle('final inspection complete');}}",
      "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{isStreaming:false,pendingMessageCount:0}});",
      "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'final inspection complete'}});",
      "else if(c.type==='abort'){out({type:'response',id:c.id,command:'abort',success:true});ack();out({type:'agent_end'});}",
      "}});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);
    const updates: string[] = [];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new PiExecutorAdapter({
      model: "provider/model",
      command,
      timeoutMs: 20_000,
    });
    const run = adapter.run({
      cwd: root,
      prompt: "start background work",
      artifactDir,
      turn: 1,
      executorToolCatalog: {
        allowedToolCatalog: ["read", "bash", "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"],
        initialActiveTools: ["read", "bash", "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"],
      },
      onUpdate: (message) => updates.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    await waitFor(() => updates.some((message) => message.includes("executor waiting")));
    // The agent is idle while background work runs, so the honest status must
    // not claim an interruption.
    const acknowledgement = await control.steer("replace true with false", "steer-idle-1", { interrupt: true });
    assert.equal(acknowledgement.status, "acknowledged");
    assert.match(acknowledgement.message, /without interruption/);
    const result = await run;
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "final inspection complete");
    const prompts = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(prompts[0], "start background work");
    assert.equal(prompts[1], "replace true with false");
    assert.ok(prompts[2].startsWith("ShellStart work that previously blocked"));
    const seen = (await readFile(commands, "utf8")).trim().split("\n");
    assert.equal(seen.includes("abort"), false);
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
      executorToolCatalog: {
        allowedToolCatalog: ["read", "WebSearch"],
        initialActiveTools: ["read"],
      },
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

test("Codex executor interrupts the active turn and starts a steered turn on the same thread (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-steer-interrupt-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.jsonl");
    const command = join(root, "codex-steer-interrupt.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');",
      `const capture=${JSON.stringify(capture)};`,
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);fs.appendFileSync(capture,raw+'\\n');if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-1'}}}));",
      "else if(c.method==='turn/start'){const id=c.params.input[0].text==='steer the active turn'?'turn-2':'turn-1';console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id}}}));if(id==='turn-2'){console.log(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text:'codex steered'}}}));console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-2',status:'completed'}}}));}}",
      "else if(c.method==='turn/interrupt'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:c.params.turnId,status:'interrupted'}}})),40);}",
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
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    // The first turn stays open until the interruption below.
    const acknowledgement = await control.steer("steer the active turn", "steer-interrupt-1", { interrupt: true });
    assert.equal(acknowledgement.status, "acknowledged");
    assert.match(acknowledgement.message, /interrupted the active turn/);
    const result = await run;
    assert.equal(result.failure, undefined);
    // The replacement turn's output is the completion text on the same thread.
    assert.equal(result.text, "codex steered");
    assert.equal(result.session.id, "thread-1");
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const interrupts = calls.filter((call) => call.method === "turn/interrupt");
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].params.turnId, "turn-1");
    const starts = calls.filter((call) => call.method === "turn/start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1].params.input, [{ type: "text", text: "steer the active turn" }]);
    // The steered instruction must not also be sent through turn/steer.
    assert.ok(calls.every((call) => call.method !== "turn/steer"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex executor surfaces a failed steered replacement turn in the task result (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-steer-fail-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "codex-steer-fail.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-1'}}}));",
      "else if(c.method==='turn/start'){const id=c.params.input[0].text==='steer the active turn'?'turn-2':'turn-1';console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id}}}));if(id==='turn-2')console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-2',status:'failed'}}}));}",
      "else if(c.method==='turn/interrupt'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:c.params.turnId,status:'interrupted'}}})),40);}",
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
    const acknowledgement = await control.steer("steer the active turn", "steer-fail-1", { interrupt: true });
    // Transport acceptance is acknowledged; the replacement turn's own
    // failure is a task outcome, not a steering delivery failure (#63).
    assert.equal(acknowledgement.status, "acknowledged");
    assert.match(acknowledgement.message, /interrupted the active turn/);
    const result = await run;
    assert.equal(result.failure?.category, "provider");
    assert.match(result.failure?.message ?? "", /ended in failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex executor acknowledges interrupt steering before the replacement completes and accepts a second steer (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-steer-ack-"));
  try {
    const artifactDir = join(root, "artifacts");
    const capture = join(root, "capture.jsonl");
    const command = join(root, "codex-steer-ack.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');let starts=0;",
      `const capture=${JSON.stringify(capture)};`,
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);fs.appendFileSync(capture,raw+'\\n');if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-1'}}}));",
      "else if(c.method==='turn/start'){const id='turn-'+(++starts);console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id}}}));if(id==='turn-3'){console.log(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text:'codex final'}}}));console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-3',status:'completed'}}}));}}",
      "else if(c.method==='turn/steer')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turnId:c.params.expectedTurnId}}));",
      "else if(c.method==='turn/interrupt'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:c.params.turnId,status:'interrupted'}}})),40);}",
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
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    let settled = false;
    const done = run.finally(() => { settled = true; });
    // The first replacement turn deliberately stays running after acceptance.
    const first = await control.steer("steer the active turn", "codex-steer-1", { interrupt: true });
    assert.equal(first.status, "acknowledged");
    assert.match(first.message, /interrupted the active turn/);
    assert.equal(first.turnId, "turn-2");
    // The acknowledgement establishes transport acceptance only: the adapter
    // run must still be pending while its replacement turn is unfinished.
    assert.equal(settled, false, "steering ACK must not await replacement turn completion");
    // Default steering while the replacement runs targets the CURRENT turn.
    const second = await control.steer("keep going", "codex-steer-2", { interrupt: false });
    assert.equal(second.status, "acknowledged");
    // A second interrupt-steer interrupts the replacement, not the original.
    const third = await control.steer("stop and finish differently", "codex-steer-3", { interrupt: true });
    assert.equal(third.status, "acknowledged");
    assert.match(third.message, /interrupted the active turn/);
    assert.equal(third.turnId, "turn-3");
    const result = await done;
    assert.equal(result.failure, undefined);
    // run() followed both handoffs; the final text is the last replacement's.
    assert.equal(result.text, "codex final");
    assert.equal(result.session.id, "thread-1");
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    // Outbound ordering: each interruption precedes its own replacement
    // turn/start, and the plain steer never issues an interrupt.
    assert.deepEqual(
      calls.map((call) => call.method === "turn/start" ? `start:${call.params.input[0].text}` : call.method === "turn/interrupt" ? `interrupt:${call.params.turnId}` : call.method),
      ["initialize", "initialized", "thread/start", "start:work", "interrupt:turn-1", "start:steer the active turn", "turn/steer", "interrupt:turn-2", "start:stop and finish differently"],
    );
    const steerCall = calls.find((call) => call.method === "turn/steer");
    assert.equal(steerCall.params.expectedTurnId, "turn-2", "default steering must target the current active turn");
    // Replacement turns preserve the launch turn's model and approval policy.
    for (const start of calls.filter((call) => call.method === "turn/start")) {
      assert.equal(start.params.model, "gpt-test");
      assert.equal(start.params.approvalPolicy, "never");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex executor reports a rejected replacement turn start as a failed steering acknowledgement (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-steer-startfail-"));
  try {
    const artifactDir = join(root, "artifacts");
    const command = join(root, "codex-steer-startfail.cjs");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');let firstStart=true;",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
      "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));",
      "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-1'}}}));",
      "else if(c.method==='turn/start'){if(firstStart){firstStart=false;console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-1'}}}));}else{console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,error:{code:-32600,message:'turn/start rejected: synthetic transport failure'}}));}}",
      "else if(c.method==='turn/interrupt'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}}));setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:c.params.turnId,status:'interrupted'}}})),40);}",
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
    const acknowledgement = await control.steer("steer the active turn", "codex-start-fail-1", { interrupt: true });
    // The interruption succeeded but the replacement was never accepted, so
    // the steering delivery itself failed truthfully (#63).
    assert.equal(acknowledgement.status, "failed");
    assert.match(acknowledgement.message, /synthetic transport failure/);
    const result = await run;
    assert.equal(result.failure?.category, "interruption");
    assert.match(result.failure?.message ?? "", /replacement turn did not complete/);
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
      executorToolCatalog: {
        allowedToolCatalog: ["read"],
        initialActiveTools: ["read"],
      },
    });
    assert.equal(result.text, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Minimal fake child process for PiRpc transport-level regressions: real
// EventEmitter pipes with no kernel timing, so stream errors can be emitted
// deterministically at exactly the moment no request is in flight.
function createFakePiChild(): {
  proc: ChildProcess;
  stdin: { writable: boolean; written: string[]; ended: boolean } & EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    written: [] as string[],
    ended: false,
    write(chunk: unknown): boolean {
      this.written.push(String(chunk));
      return true;
    },
    end(): void {
      this.ended = true;
    },
  });
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(proc, { pid: 4242, exitCode: null, signalCode: null, stdout, stderr, stdin });
  return { proc: proc as unknown as ChildProcess, stdin, stdout, stderr };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("timed out waiting for condition");
}
