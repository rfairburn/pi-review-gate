import assert from "node:assert/strict";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { terminateProcessTree } from "../src/adapters/process";
import type { ExecutorLiveControl, ExecutorRequest, ExecutorTurn } from "../src/execution/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms = 14_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture deadline ${ms}ms exceeded`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Real, finite app-server children, never a provider/CLI/login. Every launch
// has its own home/repo, a credential-free environment and a 12s hard lifetime.
// Incoming frames and signal times are bounded by the finite scenario, not a
// copy of the adapter's state. A spawn observer captures ACTUAL exit/close.
const server = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const mode = process.argv[2];
const out = v => process.stdout.write(JSON.stringify(v)+'\n');
const event = name => out({method:name,params:{}});
const reply = (c,result) => out({id:c.id,result});
const complete = (id='turn-1',status='interrupted',text='retained 🦊 output') => out({method:'turn/completed',params:{threadId:'thread-1',turn:{id,status,items:[{type:'agentMessage',text}]}}});
const log = v => fs.appendFileSync('calls.jsonl', JSON.stringify(v)+'\n');
let starts=0;
process.on('SIGTERM',()=>{
  log({signal:'SIGTERM',at:Date.now()});
  if(['late','handoff','timeout','accepted','accepted-epipe','missing-notification','replacement-accepted'].includes(mode)) return;
  setTimeout(()=>process.exit(0), mode==='replied'?180:80);
});
setTimeout(()=>process.exit(93),12_000);
readline.createInterface({input:process.stdin}).on('line',line=>{
  const c=JSON.parse(line);log(c);
  if(c.method==='initialize') reply(c,{userAgent:'finite-synthetic/1'});
  else if(c.method==='thread/start'||c.method==='thread/resume') reply(c,{thread:{id:'thread-1'}});
  else if(c.method==='turn/start') {
    const id='turn-'+(++starts);
    if(mode==='replacement-accepted'&&starts>1){event('fixture/replacement-seen');setTimeout(()=>{reply(c,{turn:{id}});complete(id,'completed','replacement retained 🦊 output');log({acceptedReplacement:c.id});},150);}
    else reply(c,{turn:{id}});
    if(mode==='root-pipes'||mode==='owned-group-pipes') {
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setTimeout(()=>process.exit(0),9000)"],{detached:mode==='root-pipes',stdio:['ignore',1,2,'ipc'],env:process.env});
      child.once('message',()=>{
        fs.writeFileSync('descendant.pid',String(child.pid));
        event('fixture/descendant-ready');setTimeout(()=>process.exit(0),30);
      });
    }
    if(mode==='completed'||(mode==='nonterminal'&&starts>1)) complete(id,'completed');
    if(mode==='torn') process.stdout.write('{"TORN":"unfinished');
  } else if(c.method==='turn/interrupt') {
    if(mode!=='torn')event('fixture/interrupt-seen');
    if(mode==='missing') return;
    const answer=()=>{reply(c,{});if(mode!=='missing-notification')complete();};
    if(['late','handoff','accepted','missing-notification'].includes(mode))setTimeout(answer,150);
    else if(mode==='timeout')setTimeout(answer,800);
    else if(mode==='wait-fence'){reply(c,{});setTimeout(()=>complete(),80);}
    else if(mode==='torn'){ reply(c,{});process.stdout.write('\n');complete(); }
    else answer();
  } else if(c.method==='turn/steer') {
    event('fixture/steer-seen');
    if(mode==='accepted-epipe'){
      fs.closeSync(0);event('fixture/stdin-closed');
      setTimeout(()=>{reply(c,{turnId:'turn-1'});log({accepted:c.id});},150);
    }
    else if(mode==='accepted')setTimeout(()=>{reply(c,{turnId:'turn-1'});log({accepted:c.id});},150);
    else if(mode==='routing') {
      // Server requests share numeric ids with client RPCs; only response
      // frames may settle those RPCs. Replies arrive in reverse ID order.
      out({id:c.id,method:'server/unsupported'});
      setTimeout(()=>reply(c,{turnId:c.params.clientUserMessageId}),c.params.clientUserMessageId==='first'?80:20);
    }
    else if(mode==='nonterminal')reply(c,{turnId:'turn-2'});
  }
});
`;

type Spawn = (file: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
async function fixture(mode: string, body: (f: {
  run: Promise<ExecutorTurn>; control: Promise<ExecutorLiveControl>; abort: () => void;
  child: () => ChildProcess; closed: Promise<void>; exited: Promise<void>;
  exitAt: () => number; closeAt: () => number; calls: () => Promise<any[]>;
  event: (name: string) => Promise<void>; root: string; exits: any[];
}) => Promise<void>, options: Partial<ExecutorRequest> = {}, timeoutMs = 10_000): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codex-terminal-'));
  const cp = require('node:child_process') as { spawn: Spawn };
  const originalSpawn = cp.spawn;
  const ready = deferred<ExecutorLiveControl>();
  const closed = deferred<void>();
  const exited = deferred<void>();
  const events = new Map<string, ReturnType<typeof deferred<void>>>();
  let child: ChildProcess | undefined;
  let exitAt = 0, closeAt = 0;
  let run: Promise<ExecutorTurn> | undefined;
  const controller = new AbortController();
  const exits: any[] = [];
  try {
    await mkdir(join(root, 'home'));
    await mkdir(join(root, 'repo'));
    await mkdir(join(root, 'artifacts'));
    await writeFile(join(root, 'server.cjs'), server);
    cp.spawn = ((file, args, spawnOptions) => {
      // Limit interception to this invocation's positively owned script.
      if (!args?.includes(join(root, 'server.cjs'))) return originalSpawn(file, args, spawnOptions);
      const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
      child = originalSpawn(file, args, { ...spawnOptions, env });
      child.once('exit', () => { exitAt = Date.now(); exited.resolve(); });
      child.once('close', () => { closeAt = Date.now(); closed.resolve(); });
      return child;
    }) as Spawn;
    run = new CodexExecutorAdapter({ id: 'codex', adapter: 'codex-cli', command: process.execPath, args: [join(root, 'server.cjs'), mode], timeoutMs }).run({
      cwd: join(root, 'repo'), artifactDir: join(root, 'artifacts'), turn: 1, prompt: 'synthetic task', signal: controller.signal,
      onLiveControl: c => { if(c) ready.resolve(c); },
      onUpdate: text => {
        const event = events.get(text) ?? deferred<void>(); events.set(text, event); event.resolve();
      },
      onProcessExit: exit => { exits.push(exit); },
      ...options,
    });
    void run.catch(() => undefined);
    await bounded(body({ run, control: ready.promise, abort: () => controller.abort(), child: () => child!, closed: closed.promise, exited: exited.promise,
      exitAt: () => exitAt, closeAt: () => closeAt, root, exits,
      calls: async () => (await readFile(join(root, 'repo', 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v)),
      event: name => { const e=events.get(name)??deferred<void>();events.set(name,e);return e.promise; },
    }), 17_000);
  } finally {
    controller.abort();
    try {
      if (child && !exitAt) terminateProcessTree(child, 'SIGKILL');
      // Even failed assertions and partial setup must observe this captured
      // child's close before removing its own fixture. Never delete unknowns.
      if (child) await bounded(closed.promise, 14_000);
      if (run) await bounded(run.catch(() => undefined));
      // An escaped inherited-pipe descendant has a finite 9s lifetime. Never
      // mistake the root's locally-induced close for its death, or remove its
      // fixture until this invocation's recorded PID is actually gone.
      let descendant: number | undefined;
      try { descendant = Number(await readFile(join(root, 'repo', 'descendant.pid'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (descendant) await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 12_000;
        const probe = () => {
          try {
            process.kill(descendant!, 0);
            if (Date.now() >= deadline) reject(new Error('owned finite descendant did not exit; fixture retained'));
            else setTimeout(probe, 30);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') resolve();
            else reject(error);
          }
        };
        probe();
      });
      await rm(root, { recursive: true, force: true });
    } finally { cp.spawn = originalSpawn; }
  }
}

for (const mode of ['missing', 'torn', 'replied']) {
  test(`terminal interrupt + abort: ${mode} reply settles exposed calls and actual child close`, async t => {
    await fixture(mode, async f => {
      const control = await f.control;
      const began = Date.now();
      const interrupt = control.interrupt(); f.abort();
      const [ack,result] = await bounded(Promise.all([interrupt,f.run]), 1_500);
      await f.closed;
      const elapsed = f.closeAt()-began;
      assert.ok(f.exitAt()>0 && elapsed<1_500, `actual close took ${elapsed}ms`);
      assert.equal(result.aborted,true);
      assert.equal(ack.status,mode==='replied'?'acknowledged':'failed');
      if(mode==='torn') assert.equal(result.text,'retained 🦊 output','independent terminal frame survives torn reply');
      assert.equal((await f.calls()).filter(c=>c.method==='turn/interrupt').length,1);
      assert.equal(f.exits.length,1);
      // Public stale controls must settle without relying on nonwritable stdin.
      assert.equal((await bounded(control.steer('late','late'),200)).status,'failed');
      assert.equal((await bounded(control.interrupt(),200)).status,'failed');
      t.diagnostic(`actual exit ${f.exitAt()-began}ms; close ${elapsed}ms; native=${ack.status}`);
    });
  });
}

test('signal-only abort starts teardown without a native reply', async () => {
  await fixture('missing', async f => {
    await f.control; const began=Date.now(); f.abort();
    assert.equal((await bounded(f.run,1_500)).aborted,true);
    await f.closed; assert.ok(f.closeAt()-began<1_500);
  });
});

for (const mode of ['late','missing-notification']) {
  test(`${mode}: native ACK is not quiescence; SIGTERM resistance escalates at two seconds`, {skip:process.platform==='win32'}, async t => {
    await fixture(mode, async f => {
      const control=await f.control; const began=Date.now();
      const interrupt=control.interrupt(); f.abort();
      const [ack,result]=await bounded(Promise.all([interrupt,f.run]),3_500);
      await f.closed;
      assert.equal(f.child().signalCode,'SIGKILL');
      assert.ok(f.closeAt()-began>=1_900 && f.closeAt()-began<3_500);
      assert.equal(ack.status,mode==='late'?'acknowledged':'failed');
      assert.equal(result.aborted,true);
      assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
      t.diagnostic(`actual SIGKILL exit ${f.exitAt()-began}ms; close ${f.closeAt()-began}ms`);
    });
  });
}

test('pending plain steer settles failed on close, not an ordinary turn timeout', async () => {
  await fixture('missing',async f=>{
    const control=await f.control;
    const pending=control.steer('pending','pending');
    await f.event('codex fixture/steer-seen');
    f.abort();
    const [ack,result]=await bounded(Promise.all([pending,f.run]),1_500);
    assert.equal(ack.status,'failed');assert.equal(result.aborted,true);await f.closed;
  });
});

test('steering actually accepted during terminal drain is never falsely denied', {skip:process.platform==='win32'}, async () => {
  await fixture('accepted',async f=>{
    const control=await f.control;
    const pending=control.steer('accepted before close','accepted');
    await f.event('codex fixture/steer-seen'); f.abort();
    const [ack,result]=await bounded(Promise.all([pending,f.run]),3_500);
    assert.equal(ack.status,'acknowledged');assert.equal(result.aborted,true);await f.closed;
    assert.ok((await f.calls()).some(c=>c.accepted));
  });
});

test('real terminal-interrupt EPIPE keeps prior steering acceptance routable through drain', {skip:process.platform==='win32'}, async t => {
  await fixture('accepted-epipe', async f => {
    const control = await f.control;
    const inputErrors: string[] = [];
    f.child().stdin!.on('error', (error: NodeJS.ErrnoException) => { inputErrors.push(error.code ?? 'unknown'); });
    const steering = control.steer('accepted before input close', 'accepted-epipe');
    // Child closes fd 0 itself, then announces it on stdout. The next real
    // native interrupt write causally hits the closed pipe; no mock error.
    await f.event('codex fixture/stdin-closed');
    const began = Date.now();
    const interrupt = control.interrupt(); f.abort();
    const [steerAck, interruptAck, result] = await bounded(Promise.all([steering, interrupt, f.run]), 3_500);
    await f.closed;
    assert.ok(inputErrors.includes('EPIPE'), 'captured stdin must report the actual kernel EPIPE');
    assert.equal(steerAck.status, 'acknowledged', 'stdout acceptance after EPIPE must still route to the sent request');
    assert.equal(interruptAck.status, 'failed', 'the native interrupt itself was not acknowledged');
    assert.equal(result.aborted, true);
    assert.ok((await f.calls()).some(c => c.accepted));
    assert.equal(f.child().signalCode, 'SIGKILL');
    assert.ok(f.closeAt() - began >= 1_900 && f.closeAt() - began < 3_500);
    t.diagnostic(`kernel EPIPE; steering accepted; actual exit ${f.exitAt()-began}ms, close ${f.closeAt()-began}ms`);
  });
});

test('concurrent interrupt-steer handoff + terminal interrupt + abort fences replacement writes', {skip:process.platform==='win32'}, async () => {
  await fixture('handoff',async f=>{
    const control=await f.control;
    const handoff=control.steer('must not start','replacement',{interrupt:true});
    await f.event('codex fixture/interrupt-seen');
    const interrupt=control.interrupt(); f.abort();
    const [steer,,result]=await bounded(Promise.all([handoff,interrupt,f.run]),3_500);
    assert.equal(steer.status,'failed');assert.equal(result.aborted,true);await f.closed;
    const calls=await f.calls();
    assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
    assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,2,'one handoff plus one best-effort terminal interrupt');
  });
});

test('missing nonterminal interrupt reply settles handoff when terminal abort takes over',async()=>{
  await fixture('missing',async f=>{
    const control=await f.control;
    const handoff=control.steer('must not start','replacement',{interrupt:true});
    await f.event('codex fixture/interrupt-seen');f.abort();
    const [ack,result]=await bounded(Promise.all([handoff,f.run]),1_500);
    assert.equal(ack.status,'failed');assert.equal(result.aborted,true);await f.closed;
    assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
  });
});

test('terminal fence after awaited interrupted-turn completion prevents a replacement',async()=>{
  let abort: (()=>void)|undefined;
  await fixture('wait-fence',async f=>{
    abort=f.abort;const control=await f.control;
    const [ack,result]=await bounded(Promise.all([control.steer('must not start','replacement',{interrupt:true}),f.run]),1_500);
    assert.equal(ack.status,'failed');assert.equal(result.aborted,true);await f.closed;
    assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
  },{onUpdate:text=>{if(text==='codex turn completed')abort?.();}});
});

test('replacement actually accepted during terminal drain keeps its truthful acknowledgement', {skip:process.platform==='win32'},async()=>{
  await fixture('replacement-accepted',async f=>{
    const control=await f.control;
    const handoff=control.steer('already sent','replacement',{interrupt:true});
    await f.event('codex fixture/replacement-seen');f.abort();
    const [ack,result]=await bounded(Promise.all([handoff,f.run]),3_500);
    assert.equal(ack.status,'acknowledged');assert.equal(ack.turnId,'turn-2');assert.equal(result.aborted,true);await f.closed;
    assert.equal(result.text,'replacement retained 🦊 output','late accepted replacement keeps its completed-item fallback');
    const calls=await f.calls();assert.ok(calls.some(c=>c.acceptedReplacement));
    assert.equal(calls.filter(c=>c.method==='turn/start').length,2);
  });
});

test('timeout fences a late interrupt-steer reply before replacement start', {skip:process.platform==='win32'}, async t => {
  const began=Date.now();
  await fixture('timeout',async f=>{
    const control=await f.control;
    const handoff=control.steer('must not start','replacement',{interrupt:true});
    const [ack,result]=await bounded(Promise.all([handoff,f.run]),3_500);
    assert.equal(ack.status,'failed');assert.equal(result.timedOut,true);await f.closed;
    assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,1);
    assert.ok(f.closeAt()-began<3_500);
    t.diagnostic(`timeout + escalation actual close ${f.closeAt()-began}ms from fixture setup`);
  },{},500);
});

test('completed turn cache and final-item output survive immediate terminal cancellation', async () => {
  await fixture('completed',async f=>{
    const control=await f.control; f.abort();
    const [result]=await Promise.all([f.run,control.interrupt()]);
    assert.equal(result.text,'retained 🦊 output');await f.closed;
  });
});

test('nonterminal interrupt-steer retains same thread and replacement target',async()=>{
  await fixture('nonterminal',async f=>{
    const control=await f.control;
    const ack=await control.steer('replacement','replacement',{interrupt:true});
    assert.equal(ack.status,'acknowledged');assert.equal(ack.turnId,'turn-2');
    const result=await f.run;assert.equal(result.aborted,false);assert.equal(result.text,'retained 🦊 output');
    assert.equal(result.session.id,'thread-1');await f.closed;
    const calls=await f.calls();
    assert.deepEqual(calls.filter(c=>c.method==='turn/start').map(c=>c.params.threadId),['thread-1','thread-1']);
  });
});

test('response-ID routing and server requests remain intact for concurrent plain steering',async()=>{
  await fixture('routing',async f=>{
    const control=await f.control;
    const [first,second]=await Promise.all([control.steer('one','first'),control.steer('two','second')]);
    assert.equal(first.turnId,'first');assert.equal(second.turnId,'second');
    assert.equal(first.status,'acknowledged');assert.equal(second.status,'acknowledged');
    f.abort();await f.run;await f.closed;
    const replies=(await f.calls()).filter(c=>c.error?.code===-32601);
    assert.equal(replies.length,2);
  });
});

test('pending start persistence: cancellation closes child first, bounds callbacks, never sends a late prompt',async t=>{
  const start=deferred<void>();const gate=deferred<void>();const exit=deferred<void>();
  let prompt=false;
  try {
    await fixture('missing',async f=>{
      await start.promise;const began=Date.now();f.abort();
      await bounded(f.closed,1_500);
      const result=await bounded(f.run,6_500);
      assert.equal(result.failure?.category,'process');assert.match(result.failure?.message??'',/persistence is unconfirmed/);
      assert.equal(prompt,false);assert.ok(Date.now()-began>=4_900 && Date.now()-began<6_500);
      gate.resolve();await bounded(exit.promise,500);
      assert.equal(prompt,false);t.diagnostic(`actual child close ${f.closeAt()-began}ms; callback bound ${Date.now()-began}ms`);
    },{onProcessStart:async()=>{start.resolve();await gate.promise;},onProcessExit:()=>{exit.resolve();},onPromptDelivery:()=>{prompt=true;}});
  }finally{gate.resolve();}
});

test('observed child close during held startup persistence settles without a missed close or prompt',async()=>{
  const gate=deferred<void>();const start=deferred<void>();let exit=false;
  try {
    await fixture('missing',async f=>{
      await start.promise;
      terminateProcessTree(f.child(),'SIGTERM');await f.closed;gate.resolve();
      const result=await bounded(f.run,500);
      assert.equal(result.code,1);assert.equal(exit,true);
    },{onProcessStart:async()=>{start.resolve();await gate.promise;},onProcessExit:()=>{exit=true;},onPromptDelivery:()=>assert.fail('late prompt')});
  }finally{gate.resolve();}
});

test('configured timeout remains active during held startup persistence',async()=>{
  const gate=deferred<void>();const started=deferred<void>();let delivered=false;
  try {
    await fixture('missing',async f=>{
      await started.promise;const began=Date.now();
      await bounded(f.closed,1_500);
      const result=await bounded(f.run,6_500);
      assert.equal(result.timedOut,true);assert.equal(result.aborted,false);
      assert.ok(f.closeAt()-began<1_500);
      assert.match(result.failure?.message??'',/persistence is unconfirmed/);
      assert.equal(delivered,false);gate.resolve();
    },{onProcessStart:async()=>{started.resolve();await gate.promise;},onPromptDelivery:()=>{delivered=true;}},300);
  }finally{gate.resolve();}
});

test('rejected start persistence tears down before any prompt',async()=>{
  let delivered=false;
  await fixture('missing',async f=>{
    const result=await bounded(f.run,1_500);await f.closed;
    assert.equal(result.failure?.category,'process');assert.match(result.failure?.message??'',/start persistence refused/);
    assert.equal(delivered,false);
  },{onProcessStart:async()=>{throw new Error('start persistence refused');},onPromptDelivery:()=>{delivered=true;}});
});

test('held exit persistence has a five-second bound after actual child close',async()=>{
  const gate=deferred<void>();const entered=deferred<void>();
  try {
    await fixture('completed',async f=>{
      await entered.promise;const began=Date.now();
      const result=await bounded(f.run,6_500);await f.closed;
      assert.ok(Date.now()-began>=4_900 && Date.now()-began<6_500);
      assert.match(result.failure?.message??'',/persistence is unconfirmed/);
      assert.equal(result.text,'retained 🦊 output');gate.resolve();
    },{onProcessExit:async()=>{entered.resolve();await gate.promise;}});
  }finally{gate.resolve();}
});

test('rejected exit persistence reports a process failure, retaining completed output',async()=>{
  await fixture('completed',async f=>{
    const result=await f.run;await f.closed;
    assert.equal(result.failure?.category,'process');assert.match(result.failure?.message??'',/exit persistence refused/);
    assert.equal(result.text,'retained 🦊 output');
  },{onProcessExit:async()=>{throw new Error('exit persistence refused');}});
});

test('root exit with inherited pipes bounds drain at seven seconds without publishing a fabricated exit', {skip:process.platform==='win32'},async t=>{
  await fixture('root-pipes',async f=>{
    await f.control;await f.event('codex fixture/descendant-ready');await f.exited;const began=f.exitAt();
    const result=await bounded(f.run,8_500);
    assert.equal(result.code,1);assert.equal(result.failure?.category,'process');
    assert.match(result.failure?.message??'',/close\/drain exceeded 7000ms/);
    assert.ok(Date.now()-began>=6_900 && Date.now()-began<8_500);
    assert.equal(f.exits.length,0,'local pipe destruction cannot release child ownership');
    const pid=Number(await readFile(join(f.root,'repo','descendant.pid'),'utf8'));
    assert.doesNotThrow(()=>process.kill(pid,0),'descendant is still live after local drain closure');
    t.diagnostic(`observed root exit; unconfirmed drain returned ${Date.now()-began}ms later; no onProcessExit`);
  });
});

test('POSIX owned-group escalation still reaches inherited-pipe descendants after leader exit', {skip:process.platform==='win32'},async t=>{
  await fixture('owned-group-pipes',async f=>{
    await f.control;await f.event('codex fixture/descendant-ready');await f.exited;
    await bounded(f.run,3_500);await f.closed;
    assert.equal(f.child().exitCode,0);
    assert.ok(f.closeAt()-f.exitAt()>=1_900 && f.closeAt()-f.exitAt()<3_500);
    assert.equal(f.exits.length,1,'observed pipe closure after group escalation can publish the actual root exit');
    t.diagnostic(`root exited 0; actual inherited-pipe close ${f.closeAt()-f.exitAt()}ms after leader exit`);
  });
});

test('supplemental simulated signaling refusal: actual root close cannot confirm owned-group cleanup',async()=>{
  const processModule=require('../src/adapters/process') as {terminateProcessTree:typeof terminateProcessTree};
  const original=processModule.terminateProcessTree;
  processModule.terminateProcessTree=(child,signal)=>{
    // Test-only failure injection, NOT OS evidence of a failed group signal.
    // The real root still closes; the production safety path must not turn
    // that close into verified descendant cleanup or an ownership release.
    child.kill(signal);
    return `${signal} SIMULATED process-group termination was not confirmed; descendants may remain live`;
  };
  try {
    await fixture('replied',async f=>{
      const control=await f.control;
      const [ack,result]=await Promise.all([control.interrupt(),f.run]);await f.closed;
      assert.equal(ack.status,'failed');assert.equal(result.failure?.category,'process');
      assert.match(result.failure?.message??'',/SIMULATED/);
      assert.equal(f.exits.length,0);
    });
  }finally{processModule.terminateProcessTree=original;}
});
