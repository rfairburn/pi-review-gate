import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

// SYNTHETIC exact-source observer contracts only. No native PTY, process,
// PowerShell, Pi session, filesystem fixture, or Windows acceptance is run.
// The shared observer fixture is the single source of the incarnation/PID/
// readonly-onExit/sticky-force proofs reused by both the direct Main runner
// and the source-launcher preload.
const source = readFileSync(resolve(__dirname, "../../tests/fixtures/session-host-windows-pty-observer.cjs"), "utf8");
const declaration = source.slice(source.indexOf("function observePtyModule("), source.indexOf("module.exports"));
assert.ok(declaration.startsWith("function observePtyModule("));

function fixture(options: { failJournal?: boolean; throwKill?: boolean; immediatePid?: number } = {}) {
  const records: Record<string, unknown>[] = [];
  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((event: { exitCode: number }) => void)[] = [];
  const exitHandlers: (() => void)[] = [];
  const killCalls: { receiver: unknown; args: unknown[] }[] = [];
  let pid = options.immediatePid ?? 0;
  const handle = {
    get pid() { return pid; },
    onData(listener: (data: string) => void) {
      dataListeners.push(listener);
      return { dispose() { const i = dataListeners.indexOf(listener); if (i >= 0) dataListeners.splice(i, 1); } };
    },
    kill(...args: unknown[]) {
      killCalls.push({ receiver: this, args });
      if (options.throwKill) throw new Error("SYNTHETIC public kill throw");
      return "SYNTHETIC kill return";
    },
  };
  Object.defineProperty(handle, "onExit", { configurable: false, get: () => (listener: (event: { exitCode: number }) => void) => {
    exitListeners.push(listener);
    return { dispose() {} };
  } });
  let spawnReceiver: unknown;
  let spawnArguments: unknown[] = [];
  const originalSpawn = function(this: unknown, ...args: unknown[]) { spawnReceiver = this; spawnArguments = args; return handle; };
  const module = { spawn: originalSpawn };
  const install = runInNewContext(`${declaration}\nobservePtyModule`, {
    process: { platform: "win32", on: (name: string, handler: () => void) => { assert.equal(name, "exit"); exitHandlers.push(handler); } },
    appendMetadata: (_destination: string, record: Record<string, unknown>) => {
      if (options.failJournal) throw new Error("SYNTHETIC journal failure");
      records.push({ ...record });
    },
  }) as (nodePty: unknown, journal: string) => {
    markNormalMainReturn(status: number, threw: boolean): void;
    snapshot(): { forceAttempted: boolean; journalFailed: boolean; unresolvedSpawns: number; unexitedSpawns: number };
    restore(): void;
  };
  const observation = install(module, "/synthetic/journal");
  const args = ["SYNTHETIC-node", ["SYNTHETIC-cli"], { cwd: "/synthetic/workspace" }];
  assert.equal(Reflect.apply(module.spawn, module, args), handle, "observer returns the identical public handle");
  assert.equal(spawnReceiver, module, "original spawn receiver is preserved");
  assert.equal(spawnArguments[0], args[0]);
  assert.equal(spawnArguments[1], args[1]);
  assert.equal(spawnArguments[2], args[2]);
  return { handle, module, originalSpawn, observation, records, killCalls, exitHandlers,
    data(nextPid: number) { pid = nextPid; for (const listener of [...dataListeners]) listener("SYNTHETIC ignored terminal data"); },
    exit() { for (const listener of exitListeners) listener({ exitCode: 0 }); },
  };
}

test("synthetic Windows PTY observation waits for positive public PID on data and preserves readonly onExit", () => {
  const f = fixture();
  assert.equal(f.records.filter(r => r.type === "pty_spawn_pending").length, 1);
  assert.equal(f.records.some(r => r.type === "pty_spawn"), false, "zero at spawn is not an identity");
  assert.equal(f.observation.snapshot().unresolvedSpawns, 1);
  f.data(731);
  f.data(731);
  const starts = f.records.filter(r => r.type === "pty_spawn");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.pid, 731);
  assert.equal(starts[0]!.incarnation, 1);
  f.exit();
  assert.equal(f.records.find(r => r.type === "pty_exit")!.pid, 731);
  assert.equal(f.observation.snapshot().unresolvedSpawns, 0);
  assert.equal(f.observation.snapshot().unexitedSpawns, 0);
  assert.equal(f.observation.snapshot().journalFailed, false);
  f.observation.markNormalMainReturn(0, false);
  f.exitHandlers.forEach(handler => handler());
  assert.equal(f.killCalls.length, 0, "normal settled return never forces");
  f.observation.restore();
  assert.equal(f.module.spawn, f.originalSpawn);
});

test("synthetic owned public kill observation is sticky before throws and preserves receiver/arguments", () => {
  const f = fixture({ throwKill: true, immediatePid: 732 });
  assert.throws(() => Reflect.apply(f.handle.kill, f.handle, ["SYNTHETIC-signal"]), /SYNTHETIC public kill throw/);
  assert.equal(f.observation.snapshot().forceAttempted, true);
  assert.equal(f.records.filter(r => r.type === "pty_force_attempt").length, 1);
  assert.equal(f.killCalls[0]!.receiver, f.handle);
  assert.deepEqual(f.killCalls[0]!.args, ["SYNTHETIC-signal"]);
  f.exit();
  assert.equal(f.observation.snapshot().forceAttempted, true, "a subsequent exit never erases force history");
});

test("synthetic observation failure and changed public PID can never qualify as graceful proof", () => {
  const failed = fixture({ failJournal: true });
  failed.data(733);
  assert.equal(failed.observation.snapshot().journalFailed, true);
  failed.observation.markNormalMainReturn(0, false);
  failed.exitHandlers.forEach(handler => handler());
  assert.equal(failed.observation.snapshot().forceAttempted, true);
  const changed = fixture();
  changed.data(734);
  changed.data(735);
  assert.equal(changed.observation.snapshot().journalFailed, true);
  assert.equal(changed.records.find(r => r.type === "pty_spawn")!.pid, 734, "first observed identity is not silently replaced");
});
