import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runPromptProcess, PROCESS_TREE_CLEANUP_GRACE_MS } from "../src/adapters/process";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";
import { PiExecutorAdapter, PiRpc } from "../src/execution/adapters/pi-model";
import type { ExecutorLiveControl } from "../src/execution/types";

// Node's Windows child job ordinarily terminates non-detached children when
// their spawning Node exits. These fixtures deliberately need a surviving pipe
// holder: detach only on Windows, retain inherited stdio, and stop it via its
// test-owned control file. POSIX holders stay in the owned process group.
const inheritedPipeHolderOptions = "{detached:process.platform==='win32',stdio:['ignore','inherit','inherit','ipc']}";

interface OwnedDescendantFixture {
  root: string;
  workerPidPath: string;
  readyPath: string;
  stopPath: string;
  stoppedPath: string;
}

interface InheritedPipeFixture extends OwnedDescendantFixture {
  commandPath: string;
  parentScript: string;
}

async function createInheritedPipeFixture(): Promise<InheritedPipeFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-child-teardown-"));
  const workerPath = join(root, "worker.cjs");
  const parentPath = join(root, "parent.cjs");
  const commandPath = join(root, "fixture-command.sh");
  const workerPidPath = join(root, "worker.pid");
  const readyPath = join(root, "worker.ready");
  const stopPath = join(root, "worker.stop");
  const stoppedPath = join(root, "worker.stopped");
  await writeFile(workerPath, [
    "const fs=require('node:fs');",
    "const [pidPath,readyPath,stopPath,stoppedPath]=process.argv.slice(2);",
    "fs.writeFileSync(pidPath,String(process.pid));",
    "fs.writeFileSync(readyPath,'ready');",
    "process.stdout.write('descendant-ready\\n');",
    "process.on('exit',()=>{try{fs.writeFileSync(stoppedPath,'stopped')}catch{}});",
    "process.on('SIGTERM',()=>{setTimeout(()=>{fs.writeFileSync(stoppedPath,'stopped');process.exit(0)},1500)});",
    "setInterval(()=>{if(fs.existsSync(stopPath)){fs.writeFileSync(stoppedPath,'stopped');process.exit(0)}},20);",
    "if(process.send)process.send('ready');",
  ].join("\n"));
  const parentScript = [
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,[${JSON.stringify(workerPath)},${JSON.stringify(workerPidPath)},${JSON.stringify(readyPath)},${JSON.stringify(stopPath)},${JSON.stringify(stoppedPath)}],${inheritedPipeHolderOptions});`,
    "child.on('message',message=>{if(message==='ready')process.exit(0)});",
    "child.once('error',error=>{console.error(error);process.exit(1)});",
  ].join("\n");
  await writeFile(parentPath, parentScript);
  await writeFile(commandPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(parentPath)}\n`);
  if (process.platform !== "win32") await chmod(commandPath, 0o755);
  return { root, workerPidPath, readyPath, stopPath, stoppedPath, commandPath, parentScript };
}

interface BackgroundWaitFixture extends InheritedPipeFixture {
  backgroundPidPath: string;
  backgroundStopPath: string;
  backgroundStoppedPath: string;
  rootStopPath: string;
  rootStoppedPath: string;
  finalTextRequestPath: string;
  abortRequestPath: string;
}

async function createBackgroundWaitFixture(mode: "root-exits" | "interruptible" | "abort-ignored" = "root-exits"): Promise<BackgroundWaitFixture> {
  const fixture = await createInheritedPipeFixture();
  const backgroundPidPath = join(fixture.root, "background.pid");
  const backgroundStopPath = join(fixture.root, "background.stop");
  const backgroundStoppedPath = join(fixture.root, "background.stopped");
  const rootStopPath = join(fixture.root, "root.stop");
  const rootStoppedPath = join(fixture.root, "root.stopped");
  const finalTextRequestPath = join(fixture.root, "final-text.requested");
  const abortRequestPath = join(fixture.root, "abort.requested");
  const backgroundScript = [
    "const fs=require('node:fs');const [stopPath,stoppedPath]=process.argv.slice(1);",
    "setInterval(()=>{if(fs.existsSync(stopPath)){fs.writeFileSync(stoppedPath,'stopped');process.exit(0)}},20);",
  ].join("\n");
  const initialSettlement = mode === "abort-ignored" ? "" : "ack(1);out({type:'agent_end'});";
  const stateHandler = mode === "interruptible"
    ? "else if(command.type==='get_state'){const isStreaming=stateRequests++>0&&!abortRequested;out({type:'response',id:command.id,command:'get_state',success:true,data:{isStreaming,pendingMessageCount:0}});}"
    : mode === "root-exits"
      ? "else if(command.type==='get_state'){out({type:'response',id:command.id,command:'get_state',success:true,data:{isStreaming:false,pendingMessageCount:0}});setTimeout(()=>process.exit(0),100);}"
      : "else if(command.type==='get_state'){out({type:'response',id:command.id,command:'get_state',success:true,data:{isStreaming:false,pendingMessageCount:0}});}";
  const abortHandler = mode === "interruptible"
    ? "else if(command.type==='abort'){abortRequested=true;out({type:'response',id:command.id,command:'abort',success:true});out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'interrupted background turn'}]}});out({type:'turn_end'});ack(2);out({type:'agent_end'});}"
    : mode === "abort-ignored"
      ? `else if(command.type==='abort'){abortRequested=true;fs.writeFileSync(${JSON.stringify(abortRequestPath)},'received');}`
      : "";
  const parentScript = [
    "const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');",
    "const settlementSession=process.env.PI_REVIEW_GATE_SETTLEMENT_SESSION;const settlementChild=process.env.PI_REVIEW_GATE_SETTLEMENT_CHILD;const settlementSecret=process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET;const settlementPath=process.env.PI_REVIEW_GATE_SETTLEMENT_PATH;",
    "for(const key of ['PI_REVIEW_GATE_SETTLEMENT_SESSION','PI_REVIEW_GATE_SETTLEMENT_CHILD','PI_REVIEW_GATE_SETTLEMENT_SECRET','PI_REVIEW_GATE_SETTLEMENT_PATH'])delete process.env[key];",
    `const rootStopPath=${JSON.stringify(rootStopPath)};const rootStoppedPath=${JSON.stringify(rootStoppedPath)};process.on('exit',()=>{try{fs.writeFileSync(rootStoppedPath,'stopped')}catch{}});setInterval(()=>{if(fs.existsSync(rootStopPath))process.exit(0)},20);`,
    `const holder=spawn(process.execPath,[${JSON.stringify(join(fixture.root, "worker.cjs"))},${JSON.stringify(fixture.workerPidPath)},${JSON.stringify(fixture.readyPath)},${JSON.stringify(fixture.stopPath)},${JSON.stringify(fixture.stoppedPath)}],${inheritedPipeHolderOptions});`,
    `const background=spawn(process.execPath,['-e',${JSON.stringify(backgroundScript)},${JSON.stringify(backgroundStopPath)},${JSON.stringify(backgroundStoppedPath)}],{detached:true,stdio:'ignore'});background.unref();fs.writeFileSync(${JSON.stringify(backgroundPidPath)},String(background.pid));`,
    "const out=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
    "let holderReady=false;let input='';process.stdin.setEncoding('utf8');",
    "const ack=(settlement)=>{const pid=process.pid;const version=2;const oneShot=crypto.createHmac('sha256',settlementSecret).update('pi-review-gate-live-browser-settlement-key:v2:'+settlement).digest();const mac=crypto.createHmac('sha256',oneShot).update(JSON.stringify([version,settlementSession,settlementChild,settlement,pid])).digest('base64url');const receipt={version,sessionId:settlementSession,childId:settlementChild,settlement,pid,mac};fs.mkdirSync(path.dirname(settlementPath),{recursive:true,mode:0o700});const temporary=settlementPath+'.tmp.'+crypto.randomUUID();fs.writeFileSync(temporary,JSON.stringify(receipt)+'\\n',{mode:0o600});fs.renameSync(temporary,settlementPath);};",
    "let stateRequests=0;let abortRequested=false;",
    `const handle=(command)=>{if(command.type==='prompt'){out({type:'response',id:command.id,command:'prompt',success:true});out({type:'tool_execution_end',toolName:'ShellStart',result:{content:[{type:'text',text:'Started '+String.fromCharCode(34)+'owned background'+String.fromCharCode(34)+' as job1 (pid '+background.pid+').'}]},isError:false});out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'authenticated background result'}]}});out({type:'turn_end'});${initialSettlement}}${stateHandler}${abortHandler}else if(command.type==='get_last_assistant_text'){fs.writeFileSync(${JSON.stringify(finalTextRequestPath)},'requested');}};`,
    "const consume=()=>{if(!holderReady)return;for(;;){const newline=input.indexOf('\\n');if(newline<0)break;const raw=input.slice(0,newline);input=input.slice(newline+1);if(raw.trim())handle(JSON.parse(raw));}};",
    "holder.on('message',message=>{if(message!=='ready')return;holderReady=true;fs.writeFileSync(" + JSON.stringify(fixture.workerPidPath) + ",String(holder.pid));fs.writeFileSync(" + JSON.stringify(fixture.readyPath) + ",'ready');consume();});",
    "process.stdin.on('data',chunk=>{input+=chunk;consume()});",
  ].join("\n");
  await writeFile(join(fixture.root, "rpc-background.cjs"), parentScript);
  await writeFile(fixture.commandPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fixture.root, "rpc-background.cjs"))}\n`);
  return { ...fixture, backgroundPidPath, backgroundStopPath, backgroundStoppedPath, rootStopPath, rootStoppedPath, finalTextRequestPath, abortRequestPath, parentScript };
}

async function stopBackgroundWaitFixture(fixture: BackgroundWaitFixture, removeRoot = true): Promise<void> {
  await writeFile(fixture.backgroundStopPath, "stop").catch(() => undefined);
  let pid: number | undefined;
  if (existsSync(fixture.backgroundPidPath)) {
    const parsed = Number(await readFile(fixture.backgroundPidPath, "utf8"));
    if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed;
  }
  if (pid !== undefined) {
    await waitFor(
      () => existsSync(fixture.backgroundStoppedPath) || !pidIsAlive(pid!),
      "the test-owned ShellStart group to stop",
      5_000,
    );
  }
  await stopOwnedFixture(fixture, removeRoot);
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs}ms test bound.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failTerminationAttemptsFor(pid: number): { attempts: string[]; restore: () => void } {
  const originalProcessKill = process.kill;
  const originalChildKill = ChildProcess.prototype.kill;
  const attempts: string[] = [];
  process.kill = ((targetPid: number, signal?: NodeJS.Signals | number) => {
    if (targetPid === -pid && (signal === "SIGTERM" || signal === "SIGKILL")) {
      attempts.push(`group:${signal}`);
      throw Object.assign(new Error("deterministic process-group signaling failure"), { code: "EPERM" });
    }
    return originalProcessKill.call(process, targetPid, signal);
  }) as typeof process.kill;
  ChildProcess.prototype.kill = function (signal?: NodeJS.Signals | number): boolean {
    if (this.pid === pid && (signal === "SIGTERM" || signal === "SIGKILL")) {
      attempts.push(`direct:${signal}`);
      return false;
    }
    return originalChildKill.call(this, signal);
  };
  return {
    attempts,
    restore: () => {
      process.kill = originalProcessKill;
      ChildProcess.prototype.kill = originalChildKill;
    },
  };
}

interface NativeWindowsPiFixture extends OwnedDescendantFixture {
  entryPath: string;
  restorePath: () => void;
  backgroundPidPath?: string;
  backgroundStopPath?: string;
  backgroundStoppedPath?: string;
}

async function createNativeWindowsPiFixture(mode: "rpc" | "rpc-background" | "compaction"): Promise<NativeWindowsPiFixture> {
  const root = await mkdtemp(join(tmpdir(), `pi-child-teardown-win-${mode}-`));
  const workerPath = join(root, "pipe-descendant.cjs");
  const entryPath = join(root, "pi-fixture.cjs");
  const workerPidPath = join(root, "worker.pid");
  const readyPath = join(root, "worker.ready");
  const stopPath = join(root, "worker.stop");
  const stoppedPath = join(root, "worker.stopped");
  const backgroundPath = join(root, "background.cjs");
  const backgroundPidPath = join(root, "background.pid");
  const backgroundStopPath = join(root, "background.stop");
  const backgroundStoppedPath = join(root, "background.stopped");
  await writeFile(workerPath, [
    "const fs=require('node:fs');const [pidPath,readyPath,stopPath,stoppedPath]=process.argv.slice(2);",
    "fs.writeFileSync(pidPath,String(process.pid));fs.writeFileSync(readyPath,'ready');",
    "process.on('exit',()=>{try{fs.writeFileSync(stoppedPath,'stopped')}catch{}});",
    "setInterval(()=>{if(fs.existsSync(stopPath)){fs.writeFileSync(stoppedPath,'stopped');process.exit(0)}},20);",
    "if(process.send)process.send('ready');",
  ].join("\n"));
  await writeFile(backgroundPath, [
    "const fs=require('node:fs');const [stopPath,stoppedPath]=process.argv.slice(2);",
    "setInterval(()=>{if(fs.existsSync(stopPath)){fs.writeFileSync(stoppedPath,'stopped');process.exit(0)}},20);",
  ].join("\n"));
  const commonRunner = [
    "const fs=require('node:fs');const {spawn}=require('node:child_process');",
    `const holder=spawn(process.execPath,[${JSON.stringify(workerPath)},${JSON.stringify(workerPidPath)},${JSON.stringify(readyPath)},${JSON.stringify(stopPath)},${JSON.stringify(stoppedPath)}],${inheritedPipeHolderOptions});`,
    "holder.on('message',message=>{if(message==='ready'){fs.writeFileSync(" + JSON.stringify(workerPidPath) + ",String(holder.pid));fs.writeFileSync(" + JSON.stringify(readyPath) + ",'ready');}});",
  ];
  let entryLines: string[];
  if (mode === "rpc" || mode === "rpc-background") {
    const backgroundRunner = mode === "rpc-background"
      ? `const background=spawn(process.execPath,[${JSON.stringify(backgroundPath)},${JSON.stringify(backgroundStopPath)},${JSON.stringify(backgroundStoppedPath)}],{detached:true,stdio:'ignore'});background.unref();fs.writeFileSync(${JSON.stringify(backgroundPidPath)},String(background.pid));`
      : "";
    const backgroundResult = mode === "rpc-background"
      ? `out({type:'tool_execution_end',toolName:'ShellStart',result:{content:[{type:'text',text:${JSON.stringify('Started "native background" as job1 (pid ')}+background.pid+${JSON.stringify(').')}}]},isError:false});`
      : "";
    entryLines = [
      "const fs=require('node:fs');const crypto=require('node:crypto');const path=require('node:path');const {spawn}=require('node:child_process');",
      "const settlementSession=process.env.PI_REVIEW_GATE_SETTLEMENT_SESSION;const settlementChild=process.env.PI_REVIEW_GATE_SETTLEMENT_CHILD;const settlementSecret=process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET;const settlementPath=process.env.PI_REVIEW_GATE_SETTLEMENT_PATH;",
      "for(const key of ['PI_REVIEW_GATE_SETTLEMENT_SESSION','PI_REVIEW_GATE_SETTLEMENT_CHILD','PI_REVIEW_GATE_SETTLEMENT_SECRET','PI_REVIEW_GATE_SETTLEMENT_PATH'])delete process.env[key];",
      `const holder=spawn(process.execPath,[${JSON.stringify(workerPath)},${JSON.stringify(workerPidPath)},${JSON.stringify(readyPath)},${JSON.stringify(stopPath)},${JSON.stringify(stoppedPath)}],${inheritedPipeHolderOptions});`,
      "holder.on('message',message=>{if(message==='ready'){fs.writeFileSync(" + JSON.stringify(workerPidPath) + ",String(holder.pid));fs.writeFileSync(" + JSON.stringify(readyPath) + ",'ready');}});",
      backgroundRunner,
      "const ack=()=>{const settlement=1;const pid=process.pid;const version=2;const oneShot=crypto.createHmac('sha256',settlementSecret).update('pi-review-gate-live-browser-settlement-key:v2:'+settlement).digest();const mac=crypto.createHmac('sha256',oneShot).update(JSON.stringify([version,settlementSession,settlementChild,settlement,pid])).digest('base64url');const receipt={version,sessionId:settlementSession,childId:settlementChild,settlement,pid,mac};fs.mkdirSync(path.dirname(settlementPath),{recursive:true,mode:0o700});const temporary=settlementPath+'.tmp.'+crypto.randomUUID();fs.writeFileSync(temporary,JSON.stringify(receipt)+'\\n',{mode:0o600});fs.renameSync(temporary,settlementPath);};",
      "const out=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');let input='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const newline=input.indexOf('\\n');if(newline<0)break;const raw=input.slice(0,newline);input=input.slice(newline+1);if(!raw.trim())continue;const command=JSON.parse(raw);if(command.type==='prompt'){out({type:'response',id:command.id,command:'prompt',success:true});" + backgroundResult + "out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'native Windows teardown fixture'}]}});out({type:'turn_end'});ack();out({type:'agent_end'});}else if(command.type==='get_state'){out({type:'response',id:command.id,command:'get_state',success:true,data:{isStreaming:false,pendingMessageCount:0}});setTimeout(()=>process.exit(0),50);}}});",
    ];
  } else {
    entryLines = [
      ...commonRunner,
      "holder.once('message',message=>{if(message==='ready')setTimeout(()=>process.exit(0),100)});",
    ];
  }
  await writeFile(entryPath, entryLines.join("\n"));
  const bin = join(root, "pi-bin");
  await mkdir(bin);
  const shim = join(bin, "pi.cmd");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${entryPath}" %*\r\n`, "utf8");

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, "native Windows fixture requires SystemRoot");
  const system32 = join(systemRoot, "System32");
  const priorPath = Object.entries(process.env).filter(([key]) => key.toLowerCase() === "path");
  for (const [key] of priorPath) delete process.env[key];
  process.env.PATH = [bin, system32].join(delimiter);
  let restored = false;
  const restorePath = (): void => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(process.env)) if (key.toLowerCase() === "path") delete process.env[key];
    for (const [key, value] of priorPath) process.env[key] = value;
  };
  return {
    root,
    workerPidPath,
    readyPath,
    stopPath,
    stoppedPath,
    entryPath,
    restorePath,
    ...(mode === "rpc-background" ? { backgroundPidPath, backgroundStopPath, backgroundStoppedPath } : {}),
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(path: string, label: string, timeoutMs = 8_000): Promise<void> {
  await waitFor(() => existsSync(path), label, timeoutMs);
}

async function stopOwnedFixture(fixture: OwnedDescendantFixture, removeRoot = true): Promise<void> {
  await writeFile(fixture.stopPath, "stop").catch(() => undefined);
  let pid: number | undefined;
  if (existsSync(fixture.workerPidPath)) {
    const parsed = Number(await readFile(fixture.workerPidPath, "utf8"));
    if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed;
  }
  // The stopped marker is written before process.exit(), while Windows may
  // still hold the fixture cwd open. Require actual exit for a recorded PID.
  await waitFor(
    () => pid === undefined || !pidIsAlive(pid),
    "the test-owned descendant to exit",
    5_000,
  );
  if (removeRoot) await removeOwnedFixtureRoot(fixture.root);
}

// Windows reports a process dead (its exit code is no longer STILL_ACTIVE)
// before every handle it held, including an inherited fixture-root cwd, is
// necessarily released, and a directory in use maps to EBUSY (with ENOTEMPTY or
// EPERM for the same transient removal race). Only those codes, only on
// Windows, and only for a finite budget are retried; any other error, any POSIX
// error, or an exhausted budget rethrows the unwrapped fs error.
const WINDOWS_TRANSIENT_ROOT_REMOVAL_CODES: ReadonlySet<string> = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
const WINDOWS_ROOT_REMOVAL_BUDGET_MS = 5_000;
const WINDOWS_ROOT_REMOVAL_INTERVAL_MS = 50;

interface OwnedRootRemovalOptions {
  platform?: NodeJS.Platform;
  remove?: (root: string) => Promise<void>;
  budgetMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Removes a test-owned fixture root after its owned processes have already
 * been confirmed exited. This never waits for or signals processes itself.
 */
async function removeOwnedFixtureRoot(root: string, options: OwnedRootRemovalOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const budgetMs = options.budgetMs ?? WINDOWS_ROOT_REMOVAL_BUDGET_MS;
  const intervalMs = options.intervalMs ?? WINDOWS_ROOT_REMOVAL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + budgetMs;
  for (;;) {
    try {
      await remove(root);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const transient = platform === "win32" && typeof code === "string" && WINDOWS_TRANSIENT_ROOT_REMOVAL_CODES.has(code);
      if (!transient || now() >= deadline) throw error;
      await sleep(intervalMs);
    }
  }
}

async function waitForFixtureReady(fixture: OwnedDescendantFixture): Promise<number> {
  await waitForFile(fixture.readyPath, "descendant startup");
  const pid = Number(await readFile(fixture.workerPidPath, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(pidIsAlive(pid), true, "the inherited-stdio descendant must still be alive");
  return pid;
}

async function waitForRootExit(pid: number): Promise<void> {
  await waitFor(() => !pidIsAlive(pid), `owned process root ${pid} to exit`);
}

function spawnFixtureRoot(fixture: InheritedPipeFixture) {
  return spawn(process.execPath, ["-e", fixture.parentScript], {
    cwd: fixture.root,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("owned fixture cleanup waits for actual exit after a pre-exit stopped marker", async () => {
  const fixture = await createInheritedPipeFixture();
  // This test owns the fixture and deliberately keeps its process alive after
  // publishing the marker, making premature cleanup deterministic.
  await writeFile(join(fixture.root, "worker.cjs"), [
    "const fs=require('node:fs');",
    "const [pidPath,readyPath,stopPath,stoppedPath]=process.argv.slice(2);",
    "fs.writeFileSync(pidPath,String(process.pid));fs.writeFileSync(readyPath,'ready');",
    "const poll=setInterval(()=>{if(fs.existsSync(stopPath)){clearInterval(poll);fs.writeFileSync(stoppedPath,'stopped');setTimeout(()=>process.exit(0),250)}},20);",
    "if(process.send)process.send('ready');",
  ].join("\n"));
  const child = spawnFixtureRoot(fixture);
  const closed = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  try {
    const pid = await waitForFixtureReady(fixture);
    await stopOwnedFixture(fixture, false);
    assert.equal(existsSync(fixture.stoppedPath), true);
    assert.equal(pidIsAlive(pid), false, "a stopped marker alone must not allow cleanup while the owned process is live");
  } finally {
    await stopOwnedFixture(fixture, false);
    await within(closed, 5_000, "test-owned fixture stdio to close");
    await removeOwnedFixtureRoot(fixture.root);
  }
});

function errnoError(code: string, label = code): NodeJS.ErrnoException {
  return Object.assign(new Error(`${label}: synthetic owned-root removal failure`), { code });
}

function virtualRemovalClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let current = 0;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
  };
}

test("owned-root removal retries only a transient Windows directory lock and then succeeds", async () => {
  for (const code of WINDOWS_TRANSIENT_ROOT_REMOVAL_CODES) {
    const clock = virtualRemovalClock();
    const attempts: string[] = [];
    await removeOwnedFixtureRoot("owned-root", {
      platform: "win32",
      now: clock.now,
      sleep: clock.sleep,
      remove: async (root) => {
        attempts.push(root);
        if (attempts.length <= 2) throw errnoError(code);
      },
    });
    assert.deepEqual(attempts, ["owned-root", "owned-root", "owned-root"], `${code} is retried until removal succeeds`);
    assert.deepEqual(clock.sleeps, [WINDOWS_ROOT_REMOVAL_INTERVAL_MS, WINDOWS_ROOT_REMOVAL_INTERVAL_MS]);
  }
});

test("owned-root removal fails visibly with the original code after a persistent Windows lock exhausts its budget", async () => {
  const clock = virtualRemovalClock();
  const thrown: NodeJS.ErrnoException[] = [];
  await assert.rejects(
    removeOwnedFixtureRoot("owned-root", {
      platform: "win32",
      now: clock.now,
      sleep: clock.sleep,
      remove: async () => {
        const error = errnoError("EBUSY", `attempt ${thrown.length + 1}`);
        thrown.push(error);
        throw error;
      },
    }),
    (error: unknown) => {
      assert.equal(error, thrown.at(-1), "the unwrapped fs error is rethrown");
      assert.equal((error as NodeJS.ErrnoException).code, "EBUSY");
      return true;
    },
  );
  const expectedAttempts = WINDOWS_ROOT_REMOVAL_BUDGET_MS / WINDOWS_ROOT_REMOVAL_INTERVAL_MS + 1;
  assert.equal(thrown.length, expectedAttempts, "a persistent lock consumes a finite retry budget");
  assert.equal(clock.sleeps.reduce((total, ms) => total + ms, 0), WINDOWS_ROOT_REMOVAL_BUDGET_MS);
});

test("owned-root removal rethrows nonretryable Windows errors immediately", async () => {
  for (const failure of [errnoError("EACCES"), errnoError("EIO"), new Error("uncoded removal failure")]) {
    const clock = virtualRemovalClock();
    let attempts = 0;
    await assert.rejects(
      removeOwnedFixtureRoot("owned-root", {
        platform: "win32",
        now: clock.now,
        sleep: clock.sleep,
        remove: async () => {
          attempts += 1;
          throw failure;
        },
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(attempts, 1, `${failure.message} must not be retried`);
    assert.deepEqual(clock.sleeps, []);
  }
});

test("owned-root removal rethrows POSIX errors immediately, including lock-like codes", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    for (const code of [...WINDOWS_TRANSIENT_ROOT_REMOVAL_CODES, "EACCES"]) {
      const clock = virtualRemovalClock();
      const failure = errnoError(code);
      let attempts = 0;
      await assert.rejects(
        removeOwnedFixtureRoot("owned-root", {
          platform,
          now: clock.now,
          sleep: clock.sleep,
          remove: async () => {
            attempts += 1;
            throw failure;
          },
        }),
        (error: unknown) => error === failure,
      );
      assert.equal(attempts, 1, `${platform} ${code} must not be retried`);
      assert.deepEqual(clock.sleeps, []);
    }
  }
});

test("owned-root removal deletes a real owned root and tolerates an already-removed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-teardown-remove-"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "owned.txt"), "owned");
  await removeOwnedFixtureRoot(root);
  assert.equal(existsSync(root), false);
  await removeOwnedFixtureRoot(root);
});

test("native Windows owned-root removal rejects while an owned child holds its cwd and succeeds after actual exit", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-teardown-win-lock-"));
  await writeFile(join(root, "owned.txt"), "owned");
  // Control is over IPC, not files: recursive removal may delete every entry
  // inside the root while the root directory itself stays locked as a cwd.
  const child = spawn(process.execPath, [
    "-e",
    "process.on('message',message=>{if(message==='stop')process.exit(0)});setInterval(()=>{},1000);process.send('ready');",
  ], { cwd: root, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  void closed.catch(() => undefined);
  const ready = new Promise<void>((resolve) => {
    child.on("message", (message) => { if (message === "ready") resolve(); });
  });
  let primaryFailure: unknown;
  try {
    await within(ready, 8_000, "owned cwd-holding child startup");
    const pid = child.pid;
    assert.ok(pid, "the exact owned child PID is captured");
    assert.equal(pidIsAlive(pid), true);

    let lockedAttempts = 0;
    await assert.rejects(
      removeOwnedFixtureRoot(root, {
        budgetMs: 500,
        remove: async (path) => {
          lockedAttempts += 1;
          await rm(path, { recursive: true, force: true });
        },
      }),
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        assert.ok(code && WINDOWS_TRANSIENT_ROOT_REMOVAL_CODES.has(code), `a live cwd holder must surface a directory lock code, got ${String(code)}`);
        return true;
      },
    );
    assert.ok(lockedAttempts > 1, "a live lock is retried only within the bounded budget");
    assert.equal(existsSync(root), true, "the root remains while its owned child holds it");
    assert.equal(pidIsAlive(pid), true, "bounded removal neither waits for nor terminates the owned child");

    child.send("stop");
    assert.deepEqual(await within(exited, 5_000, "owned cwd-holding child exit"), { code: 0, signal: null });
    await within(closed, 5_000, "owned cwd-holding child close");
    await waitFor(() => !pidIsAlive(pid), "the owned cwd-holding child to exit", 5_000);
    await removeOwnedFixtureRoot(root);
    assert.equal(existsSync(root), false, "removal succeeds after the owned child actually exits");
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    // The root is deleted only after this exact owned child's exit, close, and
    // actual PID exit are all confirmed within bounds. Any shutdown failure
    // skips deletion and is surfaced, never suppressed or allowed to mask an
    // earlier assertion failure.
    const cleanupFailures: unknown[] = [];
    let shutdownConfirmed = false;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.connected) child.send("stop");
          await within(exited, 5_000, "owned cwd-holding child cooperative cleanup exit");
        } catch (cooperativeFailure) {
          cleanupFailures.push(cooperativeFailure);
          child.kill();
          await within(exited, 5_000, "owned cwd-holding child exit after fallback kill");
        }
      } else {
        await within(exited, 5_000, "owned cwd-holding child cleanup exit");
      }
      await within(closed, 5_000, "owned cwd-holding child cleanup close");
      const ownedPid = child.pid;
      if (ownedPid !== undefined) await waitFor(() => !pidIsAlive(ownedPid), "the owned cwd-holding child PID to exit", 5_000);
      shutdownConfirmed = true;
    } catch (shutdownFailure) {
      cleanupFailures.push(shutdownFailure);
    }
    if (shutdownConfirmed) {
      try {
        await removeOwnedFixtureRoot(root);
      } catch (removalFailure) {
        cleanupFailures.push(removalFailure);
      }
    }
    if (cleanupFailures.length > 0) {
      if (primaryFailure === undefined && cleanupFailures.length === 1) throw cleanupFailures[0];
      const failures = primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures];
      throw new AggregateError(failures, "owned cwd-lock regression cleanup failed");
    }
  }
});

test("reviewer teardown bounds inherited pipes after the direct root exits", async () => {
  const fixture = await createInheritedPipeFixture();
  const controller = new AbortController();
  let rootPid: number | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let completed = false;
  const startedAt = Date.now();
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", fixture.parentScript],
    cwd: fixture.root,
    prompt: "",
    timeoutMs: 20_000,
    terminationEscalationMs: 2_000,
    signal: controller.signal,
    onProcessStart: ({ pid }) => { rootPid = pid; },
    onProcessExit: ({ code, signal }) => { exit = { code, signal }; },
  }).finally(() => { completed = true; });
  void running.catch(() => undefined);

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(rootPid);
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(workerPid), true, "the descendant must retain the root's inherited stdio after root exit");
    assert.equal(completed, false, "ordinary close must still be pending while the descendant owns the pipes");
    controller.abort();
    const output = await running;

    assert.ok(Date.now() - startedAt < 10_000, "abort teardown must have a finite bound");
    assert.equal(output.aborted, true);
    assert.equal(output.timedOut, false);
    assert.equal(output.code, 0, "the result retains the actual root exit status");
    assert.deepEqual(exit, { code: 0, signal: null });
    if (process.platform === "win32") {
      assert.match(output.terminationError ?? "", /owned process root exited before taskkill \/T/);
      assert.match(output.terminationError ?? "", /cleanup uncertain/);
    }
  } finally {
    controller.abort();
    try {
      await stopOwnedFixture(fixture);
    } finally {
      await running.catch(() => undefined);
    }
  }
});

test("PiRpc teardown bounds close after a dead root without inventing descendant cleanup", async () => {
  const fixture = await createInheritedPipeFixture();
  const proc = spawnFixtureRoot(fixture);
  const rpc = new PiRpc(proc, new BackgroundProcessReadiness(), () => undefined);
  let ordinaryCloseObserved = false;
  void rpc.closed().then(() => { ordinaryCloseObserved = true; });
  const startedAt = Date.now();

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(proc.pid);
    await waitForRootExit(proc.pid);
    assert.equal(pidIsAlive(workerPid), true);
    assert.equal(ordinaryCloseObserved, false, "the direct root exit must not be confused with inherited-pipe close");
    rpc.terminate();
    const close = await rpc.waitForCloseBounded(2_000 + PROCESS_TREE_CLEANUP_GRACE_MS);

    assert.ok(Date.now() - startedAt < 10_000, "RPC teardown must have a finite bound");
    assert.equal(close.exitObserved, true);
    assert.equal(close.code, 0);
    if (process.platform === "win32") {
      assert.equal(close.closeObserved, false, "closing local pipe handles must not be reported as observed child close");
      assert.match(rpc.terminationError ?? "", /owned process root exited before taskkill \/T/);
    } else {
      assert.equal(close.closeObserved, true, "the owned POSIX process group remains signalable after leader exit");
      assert.equal(existsSync(fixture.stoppedPath), true, "the owned descendant exits itself after terminal group signaling");
    }
  } finally {
    rpc.terminate();
    await stopOwnedFixture(fixture);
  }
});

test("concurrent PiRpc close waiters preserve uncertainty after local stdio destruction", async () => {
  const fixture = await createInheritedPipeFixture();
  const proc = spawnFixtureRoot(fixture);
  const rpc = new PiRpc(proc, new BackgroundProcessReadiness(), () => undefined);
  let ordinaryCloseObserved = false;
  void rpc.closed().then(() => { ordinaryCloseObserved = true; });

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(proc.pid);
    await waitForRootExit(proc.pid);
    const firstWaiter = rpc.waitForCloseBounded(25);
    const secondWaiter = rpc.waitForCloseBounded(2_000);
    const first = await firstWaiter;

    assert.equal(first.closeObserved, false);
    assert.equal(first.exitObserved, true);
    assert.equal(first.code, 0);
    await waitFor(() => ordinaryCloseObserved, "locally induced ChildProcess close after root exit", 1_000);
    const second = await secondWaiter;
    assert.equal(second.closeObserved, false, "another waiter must not treat local pipe destruction as confirmed cleanup");
    assert.equal(second.exitObserved, true);
    assert.equal(second.code, 0);
    assert.equal(pidIsAlive(workerPid), true, "local stdio destruction must not be mistaken for descendant termination");
  } finally {
    await stopOwnedFixture(fixture);
  }
});

test("PiRpc does not signal a stale group after ordinary close", {
  skip: process.platform === "win32",
}, async () => {
  const proc = spawn(process.execPath, ["-e", "process.exit(0)"], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new PiRpc(proc, new BackgroundProcessReadiness(), () => undefined);
  await within(rpc.closed(), 5_000, "ordinary RPC close");
  assert.ok(proc.pid);
  const originalKill = process.kill;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -proc.pid!) {
      signals.push(signal);
      return true;
    }
    return originalKill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    rpc.terminate();
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.deepEqual(signals, [], "neither initial nor delayed signaling may target the closed lifecycle");
  } finally {
    process.kill = originalKill;
  }
});

test("Pi RPC executor returns an explicit failure for a dead root with inherited pipes", {
  // PiExecutorAdapter intentionally appends Pi CLI flags after its configured
  // command's exact argv; node.exe rejects those flags before a -e fixture.
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createInheritedPipeFixture();
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const adapter = new PiExecutorAdapter({
    model: "provider/model",
    command: fixture.commandPath,
    timeoutMs: 5_000,
  });
  const startedAt = Date.now();
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "execute",
    artifactDir,
    turn: 1,
    executorToolCatalog: { allowedToolCatalog: ["read"], initialActiveTools: ["read"] },
    onProcessStart: ({ pid }) => { rootPid = pid; },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
  });
  void running.catch(() => undefined);

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(rootPid);
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(workerPid), true);
    const result = await running;

    assert.ok(Date.now() - startedAt < 12_000, "executor terminal teardown must have a finite bound");
    assert.equal(result.code, 1);
    assert.ok(result.failure, "a dead root before RPC completion must fail closed");
    assert.deepEqual(rootExit, { code: 0, signal: null }, "lifecycle reporting uses the actual root exit event");
    const processResult = JSON.parse(await readFile(join(artifactDir, "executor", "0001", "process-result.json"), "utf8"));
    assert.equal(processResult.code, 0, "process artifacts retain the actual root status despite adapter failure");
    if (process.platform === "win32") {
      assert.equal(result.failure?.category, "process", "unconfirmed cleanup is classified as an infrastructure failure");
      assert.match(result.failure?.message ?? "", /cleanup uncertain|termination attempts failed/);
    }
  } finally {
    try {
      await stopOwnedFixture(fixture);
    } finally {
      await running.catch(() => undefined);
    }
  }
});

test("compaction recovery bounds cleanup after root exit and rejects unconfirmed teardown", {
  // The direct executable fixture preserves the adapter's custom-command argv
  // boundary and therefore runs only where node.exe accepts the scripted form.
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createInheritedPipeFixture();
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const adapter = new PiExecutorAdapter({
    model: "provider/model",
    command: fixture.commandPath,
    timeoutMs: 1_000,
  });
  const startedAt = Date.now();
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "resume after compaction",
    artifactDir,
    turn: 2,
    session: { adapter: "pi-model", id: "teardown-test-session" },
    recovery: { kind: "compaction", compactBeforePrompt: true },
    executorToolCatalog: { allowedToolCatalog: ["read"], initialActiveTools: ["read"] },
    onProcessStart: ({ pid }) => { rootPid = pid; },
    onProcessExit: async ({ code, signal }) => {
      rootExit = { code, signal };
      throw new Error("recovery exit persistence rejected");
    },
  });
  void running.catch(() => undefined);

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(rootPid);
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(workerPid), true);
    await assert.rejects(running, /Explicit executor compaction recovery failed:.*(timed out|cleanup uncertain|termination attempts failed).*recovery exit persistence rejected/s);

    assert.ok(Date.now() - startedAt < 12_000, "compaction teardown must have a finite bound");
    assert.deepEqual(rootExit, { code: 0, signal: null }, "compaction preserves the actual root exit status");
  } finally {
    try {
      await stopOwnedFixture(fixture);
    } finally {
      await running.catch(() => undefined);
    }
  }
});

test("Pi RPC root exit interrupts background readiness and returns a bounded classified failure", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createBackgroundWaitFixture();
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const startedAt = Date.now();
  const adapter = new PiExecutorAdapter({
    model: "provider/model",
    command: fixture.commandPath,
    timeoutMs: 1_000,
  });
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "settle then wait for owned background work",
    artifactDir,
    turn: 3,
    executorToolCatalog: { allowedToolCatalog: ["read", "ShellStart"], initialActiveTools: ["read", "ShellStart"] },
    onProcessStart: ({ pid }) => { rootPid = pid; },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
  });
  void running.catch(() => undefined);

  try {
    const holderPid = await waitForFixtureReady(fixture);
    await waitForFile(fixture.backgroundPidPath, "tracked ShellStart group startup");
    const backgroundPid = Number(await readFile(fixture.backgroundPidPath, "utf8"));
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    assert.equal(pidIsAlive(backgroundPid), true, "authenticated settlement must leave live tracked background work");
    assert.ok(rootPid);
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(holderPid), true, "the inherited-pipe descendant must survive root exit");

    const result = await within(running, 5_000, "root-exit background readiness teardown");
    assert.ok(Date.now() - startedAt < 5_000, "root exit must break the readiness wait before its renewed model deadline");
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, false, "root exit is not a refreshed background timeout");
    assert.equal(result.failure?.category, "process");
    assert.equal(result.text, "");
    assert.match(result.failure?.message ?? "", /cleanup uncertain.*tracked background process groups.*job1/);
    assert.ok(result.failure?.message.includes(`group ${backgroundPid}`));
    assert.match(result.failure?.message ?? "", /root exited while waiting for background process readiness/);
    assert.deepEqual(rootExit, { code: 0, signal: null });
    assert.equal(pidIsAlive(backgroundPid), true, "the positively tracked background group remains live until fixture cleanup");
  } finally {
    await stopBackgroundWaitFixture(fixture, false);
    await running.catch(() => undefined);
    await removeOwnedFixtureRoot(fixture.root);
  }
});

test("Pi RPC live-control interruption breaks background readiness after termination attempts fail", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createBackgroundWaitFixture("interruptible");
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveControl!: (control: ExecutorLiveControl) => void;
  let resolveReadinessWait!: () => void;
  const controlReady = new Promise<ExecutorLiveControl>((resolve) => { resolveControl = resolve; });
  const readinessWaitStarted = new Promise<void>((resolve) => { resolveReadinessWait = resolve; });
  const adapter = new PiExecutorAdapter({
    model: "provider/model",
    command: fixture.commandPath,
    timeoutMs: 60_000,
  });
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "settle then wait for owned background work",
    artifactDir,
    turn: 6,
    executorToolCatalog: { allowedToolCatalog: ["read", "ShellStart"], initialActiveTools: ["read", "ShellStart"] },
    onProcessStart: ({ pid }) => { rootPid = pid; },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
    onLiveControl: (control) => { if (control) resolveControl(control); },
    onUpdate: (message) => {
      if (message.startsWith("executor waiting for 1 background process group")) resolveReadinessWait();
    },
  });
  void running.catch(() => undefined);
  let terminationPatch: ReturnType<typeof failTerminationAttemptsFor> | undefined;
  let interrupting: Promise<Awaited<ReturnType<ExecutorLiveControl["interrupt"]>>> | undefined;

  try {
    const control = await within(controlReady, 5_000, "Pi live-control registration");
    const holderPid = await waitForFixtureReady(fixture);
    await waitForFile(fixture.backgroundPidPath, "tracked ShellStart group startup");
    const backgroundPid = Number(await readFile(fixture.backgroundPidPath, "utf8"));
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    await within(readinessWaitStarted, 5_000, "background readiness wait startup");
    assert.ok(rootPid);
    assert.equal(pidIsAlive(rootPid), true, "the executor root must remain live while interruption is requested");
    assert.equal(pidIsAlive(holderPid), true);
    assert.equal(pidIsAlive(backgroundPid), true);

    terminationPatch = failTerminationAttemptsFor(rootPid);
    const startedAt = Date.now();
    interrupting = control.interrupt();
    const shutdownPlusCleanupBoundMs = 15_000 + 2_000 + PROCESS_TREE_CLEANUP_GRACE_MS;
    const [acknowledgement, result] = await Promise.all([
      within(interrupting, 10_000, "live-control interruption acknowledgement"),
      within(running, shutdownPlusCleanupBoundMs + 1_500, "interruption-triggered Pi RPC teardown"),
    ]);

    assert.ok(Date.now() - startedAt < shutdownPlusCleanupBoundMs + 1_500);
    assert.equal(acknowledgement.status, "failed", "interruption must report unconfirmed process cleanup");
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "process");
    assert.equal(result.text, "", "uncertain teardown must not return accepted assistant text");
    assert.match(result.failure?.message ?? "", /cleanup uncertain/);
    assert.match(result.failure?.message ?? "", /SIGTERM termination failed/);
    assert.match(result.failure?.message ?? "", /SIGKILL termination failed/);
    assert.match(result.failure?.message ?? "", /EPERM/);
    assert.match(result.failure?.message ?? "", /ChildProcess\.kill returned false/);
    assert.deepEqual(terminationPatch.attempts, [
      "group:SIGTERM",
      "direct:SIGTERM",
      "group:SIGKILL",
      "direct:SIGKILL",
    ], "both group/tree and direct-child attempts must fail at both escalation levels");
    assert.equal(rootExit, undefined, "local cleanup uncertainty must not fabricate a root-exit callback");
    assert.equal(pidIsAlive(rootPid), true, "failed termination attempts must leave the direct root alive");
    assert.equal(pidIsAlive(holderPid), true, "failed termination attempts must leave the inherited-pipe descendant alive");
    assert.equal(pidIsAlive(backgroundPid), true, "failed termination attempts must leave tracked background work alive");
    assert.equal(existsSync(fixture.finalTextRequestPath), false, "terminal interruption must skip the final RPC request");
    const processResult = JSON.parse(await readFile(join(artifactDir, "executor", "0006", "process-result.json"), "utf8"));
    assert.equal(processResult.code, null, "process artifacts must not invent a direct-root exit status");
  } finally {
    await stopBackgroundWaitFixture(fixture, false);
    await writeFile(fixture.rootStopPath, "stop").catch(() => undefined);
    if (rootPid !== undefined) {
      await waitFor(
        () => existsSync(fixture.rootStoppedPath) || !pidIsAlive(rootPid!),
        "the test-owned Pi root to stop cooperatively",
        5_000,
      );
    }
    terminationPatch?.restore();
    await running.catch(() => undefined);
    await interrupting?.catch(() => undefined);
    await removeOwnedFixtureRoot(fixture.root);
  }
});

test("Pi RPC signal cancellation bounds an unanswered abort with live background work", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createBackgroundWaitFixture("abort-ignored");
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  const controller = new AbortController();
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolvePromptDelivered!: () => void;
  const promptDelivered = new Promise<void>((resolve) => { resolvePromptDelivered = resolve; });
  const adapter = new PiExecutorAdapter({
    model: "provider/model",
    command: fixture.commandPath,
    timeoutMs: 60_000,
  });
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "start tracked work without settling",
    artifactDir,
    turn: 7,
    signal: controller.signal,
    executorToolCatalog: { allowedToolCatalog: ["read", "ShellStart"], initialActiveTools: ["read", "ShellStart"] },
    onProcessStart: ({ pid }) => { rootPid = pid; },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
    onPromptDelivery: () => resolvePromptDelivered(),
  });
  void running.catch(() => undefined);
  let terminationPatch: ReturnType<typeof failTerminationAttemptsFor> | undefined;

  try {
    const holderPid = await waitForFixtureReady(fixture);
    await within(promptDelivered, 5_000, "prompt acceptance before signal cancellation");
    await waitForFile(fixture.backgroundPidPath, "tracked ShellStart group startup");
    const backgroundPid = Number(await readFile(fixture.backgroundPidPath, "utf8"));
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    assert.ok(rootPid);
    assert.equal(pidIsAlive(rootPid), true, "the live RPC root must remain available for the unanswered abort");
    assert.equal(pidIsAlive(holderPid), true);
    assert.equal(pidIsAlive(backgroundPid), true, "the prompt must register live tracked background work");

    terminationPatch = failTerminationAttemptsFor(rootPid);
    const startedAt = Date.now();
    controller.abort();
    const shutdownPlusAbortGraceBoundMs = 2_000 + 15_000 + 2_000 + PROCESS_TREE_CLEANUP_GRACE_MS;
    const result = await within(running, shutdownPlusAbortGraceBoundMs + 1_500, "signal-cancelled Pi RPC teardown");

    assert.ok(Date.now() - startedAt < shutdownPlusAbortGraceBoundMs + 1_500);
    assert.equal(existsSync(fixture.abortRequestPath), true, "the child receives the cooperative abort request");
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "process");
    assert.equal(result.text, "", "uncertain teardown must not return accepted assistant text");
    assert.match(result.failure?.message ?? "", /cleanup uncertain/);
    assert.match(result.failure?.message ?? "", /SIGTERM termination failed/);
    assert.match(result.failure?.message ?? "", /SIGKILL termination failed/);
    assert.match(result.failure?.message ?? "", /EPERM/);
    assert.match(result.failure?.message ?? "", /ChildProcess\.kill returned false/);
    assert.deepEqual(terminationPatch.attempts, [
      "group:SIGTERM",
      "direct:SIGTERM",
      "group:SIGKILL",
      "direct:SIGKILL",
    ], "both group/tree and direct-child attempts must fail at both escalation levels");
    assert.equal(rootExit, undefined, "local cleanup uncertainty must not fabricate a root-exit callback");
    assert.equal(pidIsAlive(rootPid), true, "failed termination attempts must leave the direct root alive");
    assert.equal(pidIsAlive(holderPid), true, "failed termination attempts must leave the inherited-pipe descendant alive");
    assert.equal(pidIsAlive(backgroundPid), true, "failed termination attempts must leave tracked background work alive");
    assert.equal(existsSync(fixture.finalTextRequestPath), false);
    const processResult = JSON.parse(await readFile(join(artifactDir, "executor", "0007", "process-result.json"), "utf8"));
    assert.equal(processResult.code, null, "process artifacts must not invent a direct-root exit status");
  } finally {
    await stopBackgroundWaitFixture(fixture, false);
    await writeFile(fixture.rootStopPath, "stop").catch(() => undefined);
    if (rootPid !== undefined) {
      await waitFor(
        () => existsSync(fixture.rootStoppedPath) || !pidIsAlive(rootPid!),
        "the test-owned Pi root to stop cooperatively",
        5_000,
      );
    }
    terminationPatch?.restore();
    await running.catch(() => undefined);
    await removeOwnedFixtureRoot(fixture.root);
  }
});

test("native Windows Pi RPC executor reports uncertain cleanup after its CMD root exits", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createNativeWindowsPiFixture("rpc");
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  let restorePath: (() => void) | undefined = fixture.restorePath;
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const startedAt = Date.now();
  const adapter = new PiExecutorAdapter({ model: "provider/model", timeoutMs: 20_000 });
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "complete a settled turn before CMD teardown",
    artifactDir,
    turn: 4,
    executorToolCatalog: { allowedToolCatalog: ["read"], initialActiveTools: ["read"] },
    onProcessStart: ({ pid }) => {
      rootPid = pid;
      restorePath?.();
      restorePath = undefined;
    },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
  });
  void running.catch(() => undefined);

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(rootPid);
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(workerPid), true, "the native Node descendant must outlive the exited CMD root");
    const result = await within(running, 12_000, "native Windows RPC cleanup");

    assert.ok(Date.now() - startedAt < 12_000);
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "process");
    assert.match(result.failure?.message ?? "", /cleanup uncertain/);
    assert.match(result.failure?.message ?? "", /owned process root exited before taskkill \/T/);
    assert.equal(result.text, "", "unconfirmed cleanup must not expose an accepted executor result");
    assert.deepEqual(rootExit, { code: 0, signal: null }, "lifecycle reporting retains the CMD root's real status");
    const processResult = JSON.parse(await readFile(join(artifactDir, "executor", "0004", "process-result.json"), "utf8"));
    assert.equal(processResult.code, 0, "process artifacts retain the observed root status");
    assert.equal(pidIsAlive(workerPid), true, "local pipe destruction is not descendant cleanup");
  } finally {
    restorePath?.();
    await stopOwnedFixture(fixture, false);
    await running.catch(() => undefined);
    await removeOwnedFixtureRoot(fixture.root);
  }
});

test("native Windows default pi.cmd root exit bounds authenticated background readiness with uncertain cleanup", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createNativeWindowsPiFixture("rpc-background");
  const artifactDir = join(fixture.root, "artifacts");
  await mkdir(artifactDir);
  let restorePath: (() => void) | undefined = fixture.restorePath;
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const startedAt = Date.now();
  const running = new PiExecutorAdapter({ model: "provider/model", timeoutMs: 20_000 }).run({
    cwd: fixture.root,
    prompt: "authenticate settlement, report live ShellStart work, then exit the CMD root",
    artifactDir,
    turn: 8,
    executorToolCatalog: { allowedToolCatalog: ["read", "ShellStart"], initialActiveTools: ["read", "ShellStart"] },
    onProcessStart: ({ pid }) => {
      rootPid = pid;
      restorePath?.();
      restorePath = undefined;
    },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
  });
  void running.catch(() => undefined);

  try {
    const holderPid = await waitForFixtureReady(fixture);
    assert.ok(fixture.backgroundPidPath && fixture.backgroundStopPath && fixture.backgroundStoppedPath);
    await waitForFile(fixture.backgroundPidPath, "native ShellStart process startup");
    const backgroundPid = Number(await readFile(fixture.backgroundPidPath, "utf8"));
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    assert.equal(pidIsAlive(backgroundPid), true, "authenticated settlement leaves tracked background work live");
    assert.ok(rootPid, "the owned root is the native cmd.exe process");
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(holderPid), true, "the live Node descendant retains the CMD root's stdio pipes");

    const result = await within(running, 12_000, "native Windows authenticated background readiness teardown");
    assert.ok(Date.now() - startedAt < 12_000, "root exit must bound the background readiness wait");
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "process");
    assert.match(result.failure?.message ?? "", /cleanup uncertain.*tracked background process groups.*job1/);
    assert.ok(result.failure?.message.includes(`group ${backgroundPid}`));
    assert.match(result.failure?.message ?? "", /root exited while waiting for background process readiness/);
    assert.equal(result.text, "", "uncertain cleanup must not expose accepted assistant text");
    assert.deepEqual(rootExit, { code: 0, signal: null }, "lifecycle reporting retains the actual CMD root status");
    const processResult = JSON.parse(await readFile(join(artifactDir, "executor", "0008", "process-result.json"), "utf8"));
    assert.equal(processResult.code, 0, "process artifacts retain the observed root status");
    assert.equal(pidIsAlive(backgroundPid), true, "tracked work remains live until cooperative fixture cleanup");
  } finally {
    restorePath?.();
    if (fixture.backgroundStopPath) await writeFile(fixture.backgroundStopPath, "stop").catch(() => undefined);
    if (fixture.backgroundPidPath && fixture.backgroundStoppedPath && existsSync(fixture.backgroundPidPath)) {
      const parsed = Number(await readFile(fixture.backgroundPidPath, "utf8"));
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        await waitFor(
          () => existsSync(fixture.backgroundStoppedPath!) || !pidIsAlive(parsed),
          "the positively owned native test background process to stop",
          5_000,
        );
      }
    }
    await stopOwnedFixture(fixture, false);
    await running.catch(() => undefined);
    await removeOwnedFixtureRoot(fixture.root);
  }
});

test("native Windows compaction recovery rejects uncertain cleanup after its CMD root exits", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createNativeWindowsPiFixture("compaction");
  let restorePath: (() => void) | undefined = fixture.restorePath;
  let rootPid: number | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const startedAt = Date.now();
  const adapter = new PiExecutorAdapter({ model: "provider/model", timeoutMs: 500 });
  const running = adapter.run({
    cwd: fixture.root,
    prompt: "resume after native Windows compaction recovery",
    artifactDir: join(fixture.root, "artifacts"),
    turn: 5,
    session: { adapter: "pi-model", id: "native-cmd-teardown-session" },
    recovery: { kind: "compaction", compactBeforePrompt: true },
    executorToolCatalog: { allowedToolCatalog: ["read"], initialActiveTools: ["read"] },
    onProcessStart: ({ pid }) => {
      rootPid = pid;
      restorePath?.();
      restorePath = undefined;
    },
    onProcessExit: ({ code, signal }) => { rootExit = { code, signal }; },
  });
  void running.catch(() => undefined);

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(rootPid);
    await waitForRootExit(rootPid);
    assert.equal(pidIsAlive(workerPid), true, "the native Node descendant must outlive the exited CMD root");
    await assert.rejects(within(running, 12_000, "native Windows compaction cleanup"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Explicit executor compaction recovery failed/);
      assert.match(error.message, /owned process root exited before taskkill \/T/);
      assert.match(error.message, /cleanup uncertain/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 12_000);
    assert.deepEqual(rootExit, { code: 0, signal: null }, "recovery reports the CMD root's real exit status");
    assert.equal(pidIsAlive(workerPid), true, "the fixture remains live until cooperative cleanup");
  } finally {
    restorePath?.();
    await stopOwnedFixture(fixture, false);
    await running.catch(() => undefined);
    await removeOwnedFixtureRoot(fixture.root);
  }
});

test("native Windows CMD root exit with a live Node descendant is reported as uncertain cleanup", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createInheritedPipeFixture();
  const controller = new AbortController();
  let cmdPid: number | undefined;
  let completed = false;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot);
  const cmd = join(systemRoot, "System32", "cmd.exe");
  // CMD is the actual ChildProcess root; it runs the Node parent, which starts
  // a separately recorded live Node descendant inheriting CMD's stdio handles.
  const cmdCommand = `""${process.execPath}" "${join(fixture.root, "parent.cjs")}""`;
  const running = runPromptProcess({
    command: cmd,
    args: ["/d", "/s", "/c", cmdCommand],
    cwd: fixture.root,
    prompt: "",
    timeoutMs: 20_000,
    terminationEscalationMs: 50,
    signal: controller.signal,
    windowsVerbatimArguments: true,
    onProcessStart: ({ pid }) => { cmdPid = pid; },
  }).finally(() => { completed = true; });
  void running.catch(() => undefined);

  try {
    const workerPid = await waitForFixtureReady(fixture);
    assert.ok(cmdPid);
    await waitForRootExit(cmdPid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(pidIsAlive(workerPid), true, "the Node descendant must remain live after the native CMD root exits");
    assert.equal(completed, false, "the descendant's inherited pipe must keep close pending after CMD exits");
    controller.abort();
    const output = await running;

    assert.equal(output.code, 0, "CMD's observed root exit status is retained");
    assert.equal(output.aborted, true);
    assert.match(output.terminationError ?? "", /owned process root exited before taskkill \/T/);
    assert.match(output.terminationError ?? "", /cleanup uncertain/);
  } finally {
    controller.abort();
    try {
      await stopOwnedFixture(fixture);
    } finally {
      await running.catch(() => undefined);
    }
  }
});
