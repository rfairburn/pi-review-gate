import assert from "node:assert/strict";
import { execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import type { ExecutorInteractionAcknowledgement, ExecutorLiveControl } from "../src/execution/types";

// Deterministic stdin-EPIPE rendezvous for the Codex app-server RPC client
// (#268): a real owned child closes its own stdin read side (fd 0) while
// remaining alive, then signals over stdout. The parent releases its next
// write only after seeing that signal, so the write causally hits a closed
// pipe — no timing trials, sleeps, or incidence loops. On the original source
// the resulting async Writable EPIPE has no listener and crashes the host;
// on the fix it must settle through the existing failed executor outcome.
//
// Hardened finally-path owned-child cleanup (fixture-only, #268): the child's
// identity is captured at spawn time — the actual handle, its initial pid, the
// process-group id, the launched cwd, and this fixture's own exit AND close
// observations attached before any await or adapter callback — and an
// already-settled child is always observed first (never signaled again). For a
// still-live child on POSIX, cleanup verifies the pid's CURRENT identity
// against the capture with a bounded native query (`/proc` on Linux, `ps` and
// `lsof` on macOS/BSD): current ppid must be this test process, the current
// cwd must match the captured fixture cwd (raw or canonical), and the current
// pgid must match the captured group. Only then is a signal sent — as a
// process-group signal plus the captured direct handle — and settlement is
// proven by observing close on the captured handle and confirming the owned
// group is actually gone. Identity mismatch, an unqueryable pid, or a query
// failure fails closed and reports an unverified identity: no signal is sent
// at all, the fixture root is retained instead of removed, and the receipt
// records the honest pending child.
// Explicit residual limitation (deliberate, not hidden): a child whose
// identity cannot be verified is left running — no signal, no
// timeout-as-settlement, no forced success — so the fixture cannot bound its
// lifetime (the 20s scenario guards bound the primary scenario's settlement,
// never a still-live unverified child), and such a child may hold the test
// runner's stdio pipes open after the suite until someone reaps it by hand
// using the receipt in the failure output. On win32 the required live cwd
// verification is not portably available, so cleanup fails closed there too
// (no signal); this standing policy is asserted process-free and is never
// claimed to be a native-Windows cleanup guarantee.
//
// Fourth case — simulated #268 latch oracle (test-only, deliberately NOT
// kernel evidence): the three cases above close the child's real stdin read
// side and rely on the kernel EPIPE. This case spawns a healthy owned child
// that never closes anything, and at the adapter's public synchronous
// onLiveControl boundary — the one instant where every startup RPC has
// resolved and run() has not yet registered its turn wait — the fixture
// itself emits a clearly labeled SIMULATED `write EPIPE` Error onto the
// captured child's stdin. The channel stays physically writable for the
// whole scenario, so a zero post-latch write count is load-bearing latch
// evidence (no reply to a post-latch server request, no steering write)
// rather than an incidental dead-stream refusal, and the not-yet-registered
// turn wait can only settle through the latched transport state.

// ===== prg268-probe-extract:begin =====

/** Captured live identity of the fixture-owned child: the actual ChildProcess handle, its spawn-time pid, the process-group id (non-Windows detached leader), the launched cwd, and our own exit AND close observations on that handle. */
interface CapturedOwnedChild {
  proc: ChildProcess | undefined;
  pid: number | undefined;
  processGroupId: number | undefined;
  expectedCwd: string;
  exitObserved: boolean;
  closeObserved: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function createCapturedOwnedChild(expectedCwd: string): CapturedOwnedChild {
  return { proc: undefined, pid: undefined, processGroupId: undefined, expectedCwd, exitObserved: false, closeObserved: false, code: null, signal: null };
}

/** Capture the first spawned child's live identity and observe its settlement on that handle. Invoked synchronously at spawn, before any await or adapter callback. */
function captureOwnedChild(captured: CapturedOwnedChild, proc: ChildProcess): void {
  if (captured.proc !== undefined || proc.pid === undefined) return;
  captured.proc = proc;
  captured.pid = proc.pid;
  // The adapter spawns detached on non-Windows, so the child leads its own
  // process group: group id == pid (the identity the adapter reports via
  // onProcessStart, and the group a later verified signal sweep must confirm).
  if (process.platform !== "win32") captured.processGroupId = proc.pid;
  // Our own exit and close observations, attached before any await and before
  // the adapter's observers, so cleanup consults this fixture's own record of
  // settlement on the captured handle rather than re-deriving it at cleanup
  // time from the same object (the pre-hardening tautological check).
  proc.once("exit", (code, signal) => {
    captured.exitObserved = true;
    captured.code = code;
    captured.signal = signal;
  });
  proc.once("close", (code, signal) => {
    captured.closeObserved = true;
    captured.code = code;
    captured.signal = signal;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bounded receipt detail: keep diagnostics actionable without unbounded output. */
function clampDetail(value: string, limit = 2_000): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}

/** Query the OS for a live pid's current identity, platform-specifically: Linux reads /proc (ppid/pgrp from stat, cwd from the symlink); macOS/BSD use `ps` for pid/ppid/pgid and `lsof` for cwd. Never throws: an unqueryable or gone pid yields a detail so cleanup can fail closed instead of signaling. */
function queryLiveIdentity(pid: number): { ok: true; ppid: number; pgid: number; cwd?: string } | { ok: false; detail: string } {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      return { ok: false, detail: `cannot read /proc/${pid}/stat: ${errorMessage(error)}` };
    }
    // The comm field may contain spaces and parentheses; anchor after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return { ok: false, detail: `unparseable /proc/${pid}/stat` };
    let cwd: string | undefined;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* cwd stays unverified */ }
    return { ok: true, ppid, pgid, cwd };
  }
  let raw: string;
  try {
    raw = execFileSync("ps", ["-o", "pid=,ppid=,pgid=", "-p", String(pid)], { timeout: 5_000, encoding: "utf8" });
  } catch (error) {
    return { ok: false, detail: `ps query failed for pid ${pid}: ${errorMessage(error)}` };
  }
  const match = raw.trim().match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
  if (!match || Number(match[1]) !== pid) return { ok: false, detail: `ps returned no row for pid ${pid}` };
  let cwd: string | undefined;
  try {
    const lsofOut = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { timeout: 5_000, encoding: "utf8" });
    const nameLine = lsofOut.split("\n").find((line) => line.startsWith("n"));
    if (nameLine) cwd = nameLine.slice(1);
  } catch { /* cwd stays unverified */ }
  return { ok: true, ppid: Number(match[2]), pgid: Number(match[3]), cwd };
}

/** Await a child's close event with a bounded deadline. Resolves false on expiry so every cleanup path reports an explicit, bounded outcome instead of a silent timeout-as-settlement. */
function waitForChildClose(proc: ChildProcess, guardMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      proc.off("close", onClose);
      resolvePromise(false);
    }, guardMs);
    timer.unref?.();
    proc.once("close", onClose);
  });
}

/**
 * Receipt of the finally-path owned-child cleanup. `settled` is the
 * root-removal safety flag: `true` only when the owned child's settlement has
 * been positively proven (already settled at entry, or verified-signaled with
 * close observed AND the owned group confirmed gone); `false` means an
 * unverified or unresolved child may still be alive, so the fixture root must
 * be retained and the diagnostic must be reported, not papered over.
 */
type OwnedChildCleanupReceipt =
  | { settled: true; action: "no-child" | "already-settled" | "verified-signal-close"; detail: string; code?: number | null; signal?: NodeJS.Signals | null; groupSignalSent?: boolean; childSignalSent?: boolean }
  | { settled: false; action: "settlement-unconfirmed" | "unverified-identity-no-signal"; detail: string };

/**
 * Fail-closed finally-path cleanup for the fixture-owned child. Never throws.
 * Order: observe already-settled first (exit AND close on the captured handle;
 * nothing is ever signaled after observed settlement); on POSIX, verify a live
 * child's current identity against the spawn-time capture with a bounded
 * native query immediately before signaling (ppid/cwd/pgid — pid equality
 * alone is insufficient against recycled or foreign pids); signal only after
 * verification (owned process group, then the captured direct handle only if
 * it is still live); then observe the actual close and verify the owned group
 * is gone. Unverified, recycled, or foreign identities and every query error
 * refuse with no signal; settlement that never receives the close (or whose
 * owned group retains members) is reported as unconfirmed, never forced to
 * success, and the fixture root is retained (`settled: false`).
 */
async function settleOwnedChild(captured: CapturedOwnedChild): Promise<OwnedChildCleanupReceipt> {
  const { proc, pid } = captured;
  if (proc === undefined || pid === undefined) {
    return { settled: true, action: "no-child", detail: "no fixture-owned child was captured at spawn; nothing to signal" };
  }
  // Observe before signaling: an already settled child is never signaled. The
  // captured handle's own close observation is the primary settle record;
  // exitCode/signalCode on that handle is the secondary observation.
  if (captured.closeObserved || captured.exitObserved || proc.exitCode !== null || proc.signalCode !== null) {
    if (captured.closeObserved) {
      return {
        settled: true,
        action: "already-settled",
        code: captured.code,
        signal: captured.signal,
        detail: `child ${pid} settled before cleanup (exit and close observed on the captured handle: code ${captured.code}, signal ${String(captured.signal)}); no signal sent`,
      };
    }
    // Exit was observed but close (stdio teardown) still pending: wait for the
    // close with a bounded explicit guard — no signals are needed.
    const closed = await waitForChildClose(proc, 5_000);
    if (closed) {
      return {
        settled: true,
        action: "already-settled",
        code: proc.exitCode,
        signal: proc.signalCode,
        detail: `child ${pid} settled before cleanup (close observed during cleanup: code ${proc.exitCode}, signal ${String(proc.signalCode)}); no signal sent`,
      };
    }
    return {
      settled: false,
      action: "settlement-unconfirmed",
      detail: `child ${pid} exit was observed but its close (stdio teardown) did not confirm within the bounded guard; no signal sent; fixture root retained`,
    };
  }
  if (process.platform === "win32") {
    // Windows: a live process's current working directory is not portably
    // queryable (tasklist/wmic/CIM expose no cwd; only an NtQueryInformationFile
    // P/Invoke probe would read it), so the required cwd verification cannot be
    // obtained. Fail closed like the POSIX path: report unverified identity and
    // send no signal instead of terminating on handle ownership alone. (The
    // adapter spawns without a detached group on win32, so there is no group to
    // verify or signal.) Not exercised natively unless run on Windows, and never
    // claimed as a native-Windows cleanup assurance.
    return {
      settled: false,
      action: "unverified-identity-no-signal",
      detail: `win32: required live cwd verification unavailable for pid ${pid} (no portable cwd query); no signal sent; fixture root retained`,
    };
  }
  const query = queryLiveIdentity(pid);
  if (!query.ok) {
    return { settled: false, action: "unverified-identity-no-signal", detail: `${clampDetail(query.detail)}; no signal sent; fixture root retained` };
  }
  if (query.ppid !== process.pid) {
    return {
      settled: false,
      action: "unverified-identity-no-signal",
      detail: `pid ${pid} is not owned by this fixture at query time (current ppid ${query.ppid}, this process ${process.pid}); no signal sent; fixture root retained`,
    };
  }
  // The OS reports the resolved cwd (macOS resolves /tmp to /private/tmp and
  // other symlinked prefixes); compare against the resolved expected form too
  // so verified cleanup still works when the fixture dir sits under a symlink.
  let expectedCwdReal = captured.expectedCwd;
  try { expectedCwdReal = realpathSync.native(captured.expectedCwd); } catch { /* keep raw form */ }
  if (query.cwd === undefined || (query.cwd !== captured.expectedCwd && query.cwd !== expectedCwdReal)) {
    return {
      settled: false,
      action: "unverified-identity-no-signal",
      detail: `pid ${pid} current cwd is ${String(query.cwd)}, which does not match the captured fixture cwd ${captured.expectedCwd}; no signal sent; fixture root retained`,
    };
  }
  const group = captured.processGroupId ?? pid;
  if (query.pgid !== group) {
    return {
      settled: false,
      action: "unverified-identity-no-signal",
      detail: `pid ${pid} current process group is ${query.pgid}, which does not match the captured group ${group}; no signal sent; fixture root retained`,
    };
  }
  // Identity verified immediately before signaling. Residual TOCTOU window
  // (a verified-alive pid settling between the query and the signal) cannot be
  // closed from userspace; the close observation below — never the signal
  // result — is the settlement authority, and a vanished group's refusal here
  // sends nothing that was not verified.
  let groupSignalSent = false;
  try {
    process.kill(-group, "SIGKILL");
    groupSignalSent = true;
  } catch { /* the verified group vanished between query and signal */ }
  let childSignalSent = false;
  if (proc.exitCode === null && proc.signalCode === null) {
    try { childSignalSent = proc.kill("SIGKILL") === true; } catch { /* already gone between query and signal */ }
  }
  // Pre-hardening cleanup bound preserved (5s): expiry is explicit failure via
  // the settlement-unconfirmed receipt with a retained fixture root — never a
  // silent timeout-as-settlement and no deadline increase.
  const closed = await waitForChildClose(proc, 5_000);
  if (!closed) {
    return {
      settled: false,
      action: "settlement-unconfirmed",
      detail: `verified pid ${pid} was signaled (group sent=${groupSignalSent}, direct sent=${childSignalSent}) but close was not observed within the bounded guard; no further signals sent; fixture root retained`,
    };
  }
  // Verify the owned group is actually gone rather than declaring success: a
  // lingering member is reported honestly and the root is retained. Probe with
  // signal 0 (no signal delivered); ESRCH proves the group is empty.
  let groupStatus = "";
  try {
    process.kill(-group, 0);
    groupStatus = `its owned group ${group} still reports live members after the verified sweep`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") groupStatus = `its owned group ${group} could not be probed (errno ${String(code ?? errorMessage(error))})`;
  }
  if (groupStatus) {
    return {
      settled: false,
      action: "settlement-unconfirmed",
      detail: `child ${pid} closed (code ${proc.exitCode}, signal ${String(proc.signalCode)}), but ${groupStatus}; no further signals sent; fixture root retained`,
    };
  }
  return {
    settled: true,
    action: "verified-signal-close",
    code: proc.exitCode,
    signal: proc.signalCode,
    groupSignalSent,
    childSignalSent,
    detail: `pid ${pid} verified live at query time (ppid ${query.ppid}, cwd ${query.cwd}, pgid ${query.pgid}) then SIGKILL-swept; close observed (code ${proc.exitCode}, signal ${String(proc.signalCode)}); owned group ${group} confirmed gone`,
  };
}

// ===== prg268-probe-extract:end =====

type TestSpawn = (file: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;

interface StdinClosedBarrier {
  install: () => void;
  restore: () => void;
  closed: Promise<void>;
  captured: CapturedOwnedChild;
}

/** Install a spawn wrapper that captures the real child and resolves `closed` when its stdout carries the marker. */
function captureStdinClosedChild(marker: string, expectedCwd: string): StdinClosedBarrier {
  // The raw CJS exports object (not a namespace import, whose bindings are
  // getter-only): the adapter resolves spawn through this shared module at
  // call time, so a scoped wrapper observes the real child it spawns.
  const childProcessExports = require("node:child_process") as { spawn: TestSpawn };
  const realSpawn = childProcessExports.spawn;
  const captured = createCapturedOwnedChild(expectedCwd);
  let releaseClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolvePromise) => { releaseClosed = resolvePromise; });
  return {
    install: () => {
      childProcessExports.spawn = ((file: string, args?: readonly string[], options?: SpawnOptions) => {
        const spawned = realSpawn(file, args ?? [], options ?? {});
        // Identity captured synchronously at spawn — handle, initial pid,
        // group, and this fixture's own exit/close observations — before any
        // await or adapter callback can touch the child.
        captureOwnedChild(captured, spawned);
        spawned.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes(marker)) releaseClosed?.();
        });
        return spawned;
      }) as TestSpawn;
    },
    restore: () => { childProcessExports.spawn = realSpawn; },
    closed,
    captured,
  };
}

/** Thin barrier for the simulated #268 latch oracle: a healthy fixture-owned child (never closed by anyone) whose stdin write calls are counted from spawn. Reuses the shared captured-identity observer (`captureOwnedChild`) and the shared settle path (`settleOwnedChild`); nothing here duplicates them. */
interface StdinCountingChildBarrier {
  install: () => void;
  restore: () => void;
  captured: CapturedOwnedChild;
  /** Total stdin write calls observed on the captured child since spawn. */
  stdinWriteCount: () => number;
}

/** Spawn wrapper that captures the real healthy child with the shared identity observer and counts every stdin write call the adapter makes against it. */
function captureHealthyStdinCountingChild(expectedCwd: string): StdinCountingChildBarrier {
  // Same shared CJS exports seam as captureStdinClosedChild: the adapter
  // resolves spawn through this module at call time, so a scoped wrapper
  // observes the real child it spawns.
  const childProcessExports = require("node:child_process") as { spawn: TestSpawn };
  const realSpawn = childProcessExports.spawn;
  const captured = createCapturedOwnedChild(expectedCwd);
  let stdinWriteCount = 0;
  return {
    install: () => {
      childProcessExports.spawn = ((file: string, args?: readonly string[], options?: SpawnOptions) => {
        const spawned = realSpawn(file, args ?? [], options ?? {});
        // Shared captured-identity observer: handle, initial pid, group, and this
        // fixture's own exit/close observations, attached synchronously at spawn —
        // before any await or adapter callback.
        captureOwnedChild(captured, spawned);
        const stdin = spawned.stdin;
        if (stdin) {
          // The wrapper is installed inside the spawn call itself, before the
          // adapter can write anything, and delegates calls unchanged to the
          // real stream. The channel is never closed here: post-latch write
          // attempts would physically succeed, so a zero post-latch count is
          // load-bearing evidence of latch suppression, not dead-stream refusal.
          const rawWrite = stdin.write.bind(stdin) as (...writeArgs: unknown[]) => boolean;
          stdin.write = ((...writeArgs: unknown[]) => {
            stdinWriteCount += 1;
            return rawWrite(...writeArgs);
          }) as typeof stdin.write;
        }
        return spawned;
      }) as TestSpawn;
    },
    restore: () => { childProcessExports.spawn = realSpawn; },
    captured,
    stdinWriteCount: () => stdinWriteCount,
  };
}

async function runWithBoundedSettle<T>(work: Promise<T>, guardMs: number, label: string): Promise<T> {
  let guard: NodeJS.Timeout | undefined;
  const guarded = work.catch((error: unknown) => { throw error; });
  const raced = Promise.race([
    guarded,
    new Promise<never>((_, rejectPromise) => {
      guard = setTimeout(() => rejectPromise(new Error(`${label} did not settle within the bounded guard`)), guardMs);
      guard.unref?.();
    }),
  ]);
  return raced.finally(() => clearTimeout(guard));
}

/**
 * Preserve both the primary failure and the honest pending-child receipt: the
 * fixture root is intentionally left in place (it is never removed while an
 * owned child's settlement is unproven, because deleting it could destroy
 * evidence and cannot help a live unverified process), and the thrown
 * diagnostic carries the cleanup receipt with the primary error as its
 * `cause`, so the cleanup path cannot mask what actually failed.
 */
function failPendingOwnedChildCleanup(primaryError: unknown, cleanup: OwnedChildCleanupReceipt | undefined, root: string): never {
  const receipt = cleanup
    ? `${cleanup.action} (settled=${cleanup.settled}): ${cleanup.detail}`
    : "cleanup was not attempted";
  const message = `owned-child cleanup did not prove settlement; fixture root retained at ${root} (${receipt}); no further signals were sent`;
  if (primaryError !== undefined) throw new Error(message, { cause: primaryError });
  throw new Error(message);
}

test("Codex app-server stdin EPIPE settles as a failed executor outcome without crashing the host (#268)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-stdin-epipe-"));
  let cleanup: OwnedChildCleanupReceipt | undefined;
  let cleanupBarrier: StdinClosedBarrier | undefined;
  let primaryError: unknown;
  try {
    try {
      const artifactDir = join(root, "artifacts");
      const childScript = join(root, "codex-stdin-close.cjs");
      await mkdir(artifactDir);
      // Invoke Node directly rather than relying on a platform-specific shebang.
      // closeSync(0) is synchronous: by the time the stdout marker is observed
      // by the parent, the pipe read side is definitely closed and the next
      // parent write is causally guaranteed to emit an async EPIPE.
      await writeFile(childScript, [
        "require(\"node:fs\").closeSync(0);",
        "console.log(\"STDIN_CLOSED_AT_START\");",
        "setInterval(() => {}, 1000); // stay alive until the adapter settles us",
      ].join("\n"), "utf8");

      const barrier = captureStdinClosedChild("STDIN_CLOSED_AT_START", root);
      barrier.install();
      cleanupBarrier = barrier;
      const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
      const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: process.execPath, args: [childScript], model: "gpt-test" });
      const runPromise = adapter.run({
        cwd: root,
        prompt: "must fail through the normal executor path",
        artifactDir,
        turn: 1,
        // Rendezvous barrier: hold the initialize write until the real owned
        // child has closed its stdin read side while remaining alive.
        onProcessStart: async () => { await barrier.closed; },
        onProcessExit: (exit) => { exits.push(exit); },
      });
      // Attach handling immediately so a rejection during the rendezvous cannot become an unhandled rejection.
      void runPromise.catch(() => undefined);
      const result = await runWithBoundedSettle(runPromise, 20_000, "Codex stdin-EPIPE executor");
      // The broken input channel surfaces as the existing failed outcome —
      // not a crash, not a hang, and never a completed/reviewed success.
      assert.equal(result.code, 1);
      assert.equal(result.failure?.category, "protocol");
      assert.match(result.failure?.message ?? "", /EPIPE/);
      assert.equal(result.timedOut, false);
      assert.equal(result.aborted, false);
      assert.equal(result.text, "");
      // The owned child is settled exactly once with its real identity, as
      // captured at spawn time (not re-derived at cleanup).
      assert.ok(barrier.captured.pid !== undefined, "the wrapper must have observed the real spawned child");
      assert.equal(exits.length, 1, "the owned child exit must be settled exactly once through onProcessExit");
      assert.equal(exits[0]!.pid, barrier.captured.pid);
      assert.equal(exits[0]!.code, null);
      assert.equal(exits[0]!.signal, "SIGTERM");
    } finally {
      if (cleanupBarrier) {
        cleanupBarrier.restore();
        cleanup = await settleOwnedChild(cleanupBarrier.captured);
      } else {
        cleanup = { settled: true, action: "no-child", detail: "setup failed before the spawn wrapper was installed; no owned child was ever created" };
      }
    }
    // Finally-path cleanup must observe the child already settled by the
    // adapter's SIGTERM path and must not signal anything new.
    assert.ok(
      cleanup !== undefined && cleanup.action === "already-settled",
      `finally-path cleanup must observe an already-settled owned child without signaling (${
        cleanup === undefined ? "cleanup was not attempted" : `${cleanup.action}: ${cleanup.detail}`
      })`,
    );
    if (cleanup !== undefined && cleanup.action === "already-settled") {
      assert.equal(cleanup.code, null, "already-settled cleanup must report the observed exit code unchanged");
      assert.equal(cleanup.signal, "SIGTERM", "already-settled cleanup must report the observed signal unchanged");
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Root deletion is gated on proven settlement: never rm(...) while an
    // unverified live owned child might still hold the fixture scripts or
    // stdio pipes open.
    if (cleanup?.settled) {
      await rm(root, { recursive: true, force: true });
    } else {
      failPendingOwnedChildCleanup(primaryError, cleanup, root);
    }
  }
});

test("Codex app-server stdin EPIPE settles an in-flight turn wait and pending RPC work (#268)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-stdin-epipe-turn-"));
  let cleanup: OwnedChildCleanupReceipt | undefined;
  let cleanupBarrier: StdinClosedBarrier | undefined;
  let primaryError: unknown;
  try {
    try {
      const artifactDir = join(root, "artifacts");
      const childScript = join(root, "codex-stdin-close-midturn.cjs");
      await mkdir(artifactDir);
      // Accepts initialize/thread/start/turn-start, then closes the stdin read
      // side while remaining alive with the turn still open. The parent's next
      // write (steering) is released only after the close marker, so the EPIPE
      // lands while both a pending RPC and the turn wait are outstanding.
      await writeFile(childScript, [
        "let input='';process.stdin.setEncoding('utf8');",
        "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
        "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{userAgent:'codex-epipe-test/1.0'}}));",
        "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-epipe'}}}));",
        "else if(c.method==='turn/start'){console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-epipe'}}}));require('node:fs').closeSync(0);console.log('STDIN_CLOSED_MIDTURN');}",
        "}});",
        "setInterval(() => {}, 1000); // stay alive until the adapter settles us",
      ].join("\n"), "utf8");

      const barrier = captureStdinClosedChild("STDIN_CLOSED_MIDTURN", root);
      barrier.install();
      cleanupBarrier = barrier;
      let resolveControl!: (control: ExecutorLiveControl) => void;
      const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
      const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
      const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: process.execPath, args: [childScript], model: "gpt-test" });
      const runPromise = adapter.run({
        cwd: root,
        prompt: "work that never completes",
        artifactDir,
        turn: 1,
        onLiveControl: (control) => { if (control) resolveControl(control); },
        onProcessExit: (exit) => { exits.push(exit); },
      });
      // Attach handling immediately so a rejection during the rendezvous cannot become an unhandled rejection.
      void runPromise.catch(() => undefined);
      // The bounded guard covers the whole scenario, including rendezvous and steering.
      const { result, acknowledgement } = await runWithBoundedSettle((async () => {
        const control = await controlReady;
        // The turn is accepted and open; the child has closed its input channel.
        await barrier.closed;
        // This write causally hits the closed pipe while the turn wait is outstanding.
        const ack = await control.steer("steer after the input channel closed", "codex-epipe-steer-1");
        return { result: await runPromise, acknowledgement: ack };
      })(), 20_000, "Codex mid-turn stdin-EPIPE executor");
      assert.equal(acknowledgement.status, "failed");
      assert.match(acknowledgement.message ?? "", /EPIPE/);
      // The outstanding turn wait settled as the existing failed outcome.
      assert.equal(result.code, 1);
      assert.equal(result.failure?.category, "protocol");
      assert.match(result.failure?.message ?? "", /EPIPE/);
      assert.equal(result.timedOut, false);
      assert.equal(result.aborted, false);
      assert.ok(barrier.captured.pid !== undefined, "the wrapper must have observed the real spawned child");
      assert.equal(exits.length, 1, "the owned child exit must be settled exactly once through onProcessExit");
      assert.equal(exits[0]!.pid, barrier.captured.pid);
      assert.equal(exits[0]!.code, null);
      assert.equal(exits[0]!.signal, "SIGTERM");
    } finally {
      if (cleanupBarrier) {
        cleanupBarrier.restore();
        cleanup = await settleOwnedChild(cleanupBarrier.captured);
      } else {
        cleanup = { settled: true, action: "no-child", detail: "setup failed before the spawn wrapper was installed; no owned child was ever created" };
      }
    }
    // Finally-path cleanup must observe the child already settled by the
    // adapter's SIGTERM path and must not signal anything new.
    assert.ok(
      cleanup !== undefined && cleanup.action === "already-settled",
      `finally-path cleanup must observe an already-settled owned child without signaling (${
        cleanup === undefined ? "cleanup was not attempted" : `${cleanup.action}: ${cleanup.detail}`
      })`,
    );
    if (cleanup !== undefined && cleanup.action === "already-settled") {
      assert.equal(cleanup.code, null, "already-settled cleanup must report the observed exit code unchanged");
      assert.equal(cleanup.signal, "SIGTERM", "already-settled cleanup must report the observed signal unchanged");
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Root deletion is gated on proven settlement: never rm(...) while an
    // unverified live owned child might still hold the fixture scripts or
    // stdio pipes open.
    if (cleanup?.settled) {
      await rm(root, { recursive: true, force: true });
    } else {
      failPendingOwnedChildCleanup(primaryError, cleanup, root);
    }
  }
});

test("Codex app-server stdin EPIPE between turn-start resolution and turn-wait registration settles without stranding work (#268)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-stdin-epipe-late-"));
  let cleanup: OwnedChildCleanupReceipt | undefined;
  let cleanupBarrier: StdinClosedBarrier | undefined;
  let primaryError: unknown;
  try {
    try {
      const artifactDir = join(root, "artifacts");
      const rendezvousDir = join(root, "rendezvous");
      const childScript = join(root, "codex-stdin-close-late.cjs");
      await mkdir(artifactDir);
      await mkdir(rendezvousDir);
      // On turn/start the child closes the stdin read side while alive, then
      // delivers the turn response and a server request in one chunk. The
      // reply write hits the closed pipe and its async error can land before
      // run() registers the turn wait — both settlement maps are empty at that
      // instant, so only a latched transport failure keeps the later-registered
      // wait from hanging against the still-live child. After the parent
      // confirms phase 1 was delivered, the child sends ANOTHER server request:
      // reply writes must stop (or be contained) once the channel is dead, never
      // escape the stdout callback as an uncaught exception.
      await writeFile(childScript, [
        "const fs=require('node:fs');",
        "const rendezvousDir=process.argv[2];",
        "let input='';process.stdin.setEncoding('utf8');",
        "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
        "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{userAgent:'codex-epipe-test/1.0'}}));",
        "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-epipe'}}}));",
        "else if(c.method==='turn/start'){fs.closeSync(0);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-epipe'}}})+'\\n'+JSON.stringify({jsonrpc:'2.0',id:900,method:'server/request'})+'\\n'+'STDIN_CLOSED_PHASE1\\n');}",
        "}});",
        "let phase2Sent=false;",
        "fs.watch(rendezvousDir,()=>{if(phase2Sent)return;phase2Sent=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:901,method:'server/request'})+'\\n');});",
        "setInterval(() => {}, 1000); // stay alive until the adapter settles us",
      ].join("\n"), "utf8");

      const barrier = captureStdinClosedChild("STDIN_CLOSED_PHASE1", root);
      barrier.install();
      cleanupBarrier = barrier;
      const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
      const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: process.execPath, args: [childScript, rendezvousDir], model: "gpt-test" });
      const runPromise = adapter.run({
        cwd: root,
        prompt: "work that never completes",
        artifactDir,
        turn: 1,
        onProcessExit: (exit) => { exits.push(exit); },
      });
      // Attach handling immediately so a rejection during the rendezvous cannot become an unhandled rejection.
      void runPromise.catch(() => undefined);
      // The bounded guard covers the whole scenario, including both rendezvous phases.
      const result = await runWithBoundedSettle((async () => {
        // Phase 1 delivered: turn response plus the first server request after the close.
        await barrier.closed;
        // Release phase 2: the child sends another server request against the dead channel.
        await writeFile(join(rendezvousDir, "phase-2"), "");
        return runPromise;
      })(), 20_000, "Codex late-server-request stdin-EPIPE executor");
      // The latched failure settles the turn work registered after the error.
      assert.equal(result.code, 1);
      assert.equal(result.failure?.category, "protocol");
      assert.match(result.failure?.message ?? "", /EPIPE/);
      assert.equal(result.timedOut, false);
      assert.equal(result.aborted, false);
      assert.ok(barrier.captured.pid !== undefined, "the wrapper must have observed the real spawned child");
      assert.equal(exits.length, 1, "the owned child exit must be settled exactly once through onProcessExit");
      assert.equal(exits[0]!.pid, barrier.captured.pid);
      assert.equal(exits[0]!.code, null);
      assert.equal(exits[0]!.signal, "SIGTERM");
    } finally {
      if (cleanupBarrier) {
        cleanupBarrier.restore();
        cleanup = await settleOwnedChild(cleanupBarrier.captured);
      } else {
        cleanup = { settled: true, action: "no-child", detail: "setup failed before the spawn wrapper was installed; no owned child was ever created" };
      }
    }
    // Finally-path cleanup must observe the child already settled by the
    // adapter's SIGTERM path and must not signal anything new.
    assert.ok(
      cleanup !== undefined && cleanup.action === "already-settled",
      `finally-path cleanup must observe an already-settled owned child without signaling (${
        cleanup === undefined ? "cleanup was not attempted" : `${cleanup.action}: ${cleanup.detail}`
      })`,
    );
    if (cleanup !== undefined && cleanup.action === "already-settled") {
      assert.equal(cleanup.code, null, "already-settled cleanup must report the observed exit code unchanged");
      assert.equal(cleanup.signal, "SIGTERM", "already-settled cleanup must report the observed signal unchanged");
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Root deletion is gated on proven settlement: never rm(...) while an
    // unverified live owned child might still hold the fixture scripts,
    // rendezvous directory, or stdio pipes open.
    if (cleanup?.settled) {
      await rm(root, { recursive: true, force: true });
    } else {
      failPendingOwnedChildCleanup(primaryError, cleanup, root);
    }
  }
});

test("Codex app-server simulated stdin failure latches before turn-wait registration and stops every post-latch input write (#268)", async () => {
  // Deterministic LATCH-ONLY oracle (isolates the #268 `stdinFailure` latch by
  // itself — the prior combined no-latch/no-guard mutant receipt could not).
  // This test drives ONLY the adapter's public surface: run() callbacks, the
  // public stdin 'error' listener the adapter installs, and the public stdout
  // consumer. No private constructor or field is touched, no global Promise is
  // patched, and this fixture itself issues no OS signal — the child is
  // settled by the adapter's own SIGTERM path exactly like the three natural
  // kernel-EPIPE cases above (the shared settleOwnedChild observes it).
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-stdin-latch-"));
  let cleanup: OwnedChildCleanupReceipt | undefined;
  let latchChild: StdinCountingChildBarrier | undefined;
  let primaryError: unknown;
  try {
    try {
      const artifactDir = join(root, "artifacts");
      const childScript = join(root, "codex-latch-oracle-child.cjs");
      await mkdir(artifactDir);
      // Healthy synthetic app-server: acknowledges initialize/thread/start/
      // turn/start and never completes the turn. No one ever closes this
      // child's stdin read side — the channel stays writable for the whole
      // scenario, so a zero post-latch write count is load-bearing evidence
      // of latch suppression rather than an incidental dead-stream refusal.
      // turn/steer and every other request are deliberately left unanswered:
      // with the latch intact those writes are never issued (pre-write
      // rejection); without the latch, the outstanding steering RPC and the
      // turn wait must hang into the bounded guard instead of ever succeeding.
      await writeFile(childScript, [
        "let input='';process.stdin.setEncoding('utf8');",
        "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c||!c.id||!c.method)continue;",
        "if(c.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{userAgent:'codex-latch-oracle/1.0'}}));",
        "else if(c.method==='thread/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-latch-oracle'}}}));",
        "else if(c.method==='turn/start')console.log(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-latch-oracle'}}}));",
        "}});",
        "setInterval(() => {}, 1000); // stay alive until the adapter settles us",
      ].join("\n"), "utf8");

      const barrier = captureHealthyStdinCountingChild(root);
      barrier.install();
      latchChild = barrier;
      // Clearly labeled SIMULATED transport failure: a fixture-emitted Error,
      // not kernel evidence (the three fd0-close cases above own kernel
      // EPIPE coverage). It is emitted onto the captured child's stdin, where
      // only the adapter's public stdin 'error' listener can consume it.
      const simulatedError = new Error(
        "SIMULATED write EPIPE (#268 latch oracle): fixture-emitted stdin transport error; the child channel remains writable and no real kernel error occurred",
      );
      // Injection state, recorded inside the production callback but asserted
      // ONLY after settlement: an assertion thrown inside the callback would be
      // caught by the adapter into the failed outcome it reports, so nothing
      // here may assert — the callback only records and injects.
      const oracle = {
        injected: false,
        undefinedControlDelivered: false,
        secondLiveControlArrived: false,
        childStreamsUnavailable: false,
        protocolAtLatch: undefined as string | undefined,
        writesAtLatch: -1,
        serverRequestDelivered: false,
      };
      let steerAck: Promise<ExecutorInteractionAcknowledgement> | undefined;
      let resolveControl!: (control: ExecutorLiveControl) => void;
      const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
      const exits: Array<{ pid: number; code: number | null; signal: string | null }> = [];
      const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: process.execPath, args: [childScript], model: "gpt-test" });
      const runPromise = adapter.run({
        cwd: root,
        prompt: "work that never completes",
        artifactDir,
        turn: 1,
        onLiveControl: (control) => {
          // Teardown delivery: never a second injection.
          if (control === undefined) { oracle.undefinedControlDelivered = true; return; }
          if (oracle.injected) { oracle.secondLiveControlArrived = true; return; }
          oracle.injected = true;
          oracle.protocolAtLatch = control.protocol;
          const liveChild = barrier.captured.proc;
          if (!liveChild || !liveChild.stdin || !liveChild.stdout) { oracle.childStreamsUnavailable = true; return; }
          // At this synchronous callback run() sits between its resolved
          // await startTurn and the not-yet-registered waitForTurn: every
          // startup RPC has resolved and neither the pending-RPC map nor the
          // turn-wait map holds anything. Capture the write count, latch the
          // SIMULATED failure through the adapter's public stdin 'error'
          // listener, then deliver a post-latch server-request frame and start
          // a steering RPC — none of which may ever write again.
          oracle.writesAtLatch = barrier.stdinWriteCount();
          liveChild.stdin.emit("error", simulatedError);
          liveChild.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 900, method: "server/request" })}\n`, "utf8"));
          oracle.serverRequestDelivered = true;
          steerAck = control.steer("steering after the simulated stdin failure", "codex-latch-oracle-steer-1");
          resolveControl(control);
        },
        onProcessExit: (exit) => { exits.push(exit); },
      });
      // Attach handling immediately so a rejection during the latch cannot become an unhandled rejection.
      void runPromise.catch(() => undefined);
      // The bounded guard covers the whole scenario, including the steering acknowledgement.
      const { ack, result } = await runWithBoundedSettle((async () => {
        await controlReady;
        const steerReceipt = await steerAck!;
        return { ack: steerReceipt, result: await runPromise };
      })(), 20_000, "Codex simulated stdin-latch executor");

      // All assertions happen here, outside production callbacks.
      assert.equal(oracle.injected, true, "the first live control must have been captured");
      assert.equal(oracle.undefinedControlDelivered, true, "run() teardown must deliver the undefined live control once");
      assert.equal(oracle.secondLiveControlArrived, false, "no second live control may trigger a second injection");
      assert.equal(oracle.childStreamsUnavailable, false, "the captured child stream handles must be usable at the latch point");
      assert.equal(oracle.protocolAtLatch, "codex-latch-oracle/1.0", "the synthetic child must have acknowledged initialize before the latch");
      assert.ok(
        oracle.writesAtLatch === 4,
        `the latch point must sit after exactly the four startup input writes (initialize, initialized, thread/start, turn/start); observed ${oracle.writesAtLatch}`,
      );
      assert.equal(oracle.serverRequestDelivered, true, "the post-latch synthetic server request must have been delivered on stdout");

      // The latched transport failure settles the not-yet-registered turn wait
      // as the existing failed executor outcome — the child stayed alive with
      // its turn open, so only the latch could end this wait.
      assert.equal(result.code, 1);
      assert.equal(result.failure?.category, "protocol");
      assert.match(result.failure?.message ?? "", /EPIPE/);
      assert.equal(result.failure?.message, simulatedError.message, "the turn-wait settlement must carry the latched simulated failure verbatim");
      assert.equal(result.timedOut, false);
      assert.equal(result.aborted, false);
      assert.equal(result.session.id, "thread-latch-oracle", "the child's thread id proves thread/start resolved before the latch");
      assert.equal(result.text, "");

      // The later steering RPC must never reach the wire: its acknowledgement
      // settles failed with the same latched failure and the turn id accepted
      // at turn/start.
      assert.equal(ack.status, "failed");
      assert.match(ack.message ?? "", /EPIPE/);
      assert.equal(ack.message, simulatedError.message, "the steering acknowledgement must carry the same latched failure verbatim");
      assert.equal(ack.turnId, "turn-latch-oracle");

      // Zero post-latch input writes while the channel stayed physically
      // writable: no reply to the synthetic server request, no steering write,
      // and no teardown write.
      assert.equal(barrier.stdinWriteCount(), oracle.writesAtLatch, "no input write may be attempted after the latch");

      // The owned child was settled exactly once by the adapter's own SIGTERM
      // termination path (never by this fixture).
      assert.ok(barrier.captured.pid !== undefined, "the wrapper must have observed the real spawned child");
      assert.equal(exits.length, 1, "the owned child exit must be settled exactly once through onProcessExit");
      assert.equal(exits[0]!.pid, barrier.captured.pid);
      assert.equal(exits[0]!.code, null);
      assert.equal(exits[0]!.signal, "SIGTERM");
    } finally {
      if (latchChild) {
        latchChild.restore();
        cleanup = await settleOwnedChild(latchChild.captured);
      } else {
        cleanup = { settled: true, action: "no-child", detail: "setup failed before the spawn wrapper was installed; no owned child was ever created" };
      }
    }
    // Finally-path cleanup must observe the child already settled by the
    // adapter's SIGTERM path and must not signal anything new.
    assert.ok(
      cleanup !== undefined && cleanup.action === "already-settled",
      `finally-path cleanup must observe an already-settled owned child without signaling (${
        cleanup === undefined ? "cleanup was not attempted" : `${cleanup.action}: ${cleanup.detail}`
      })`,
    );
    if (cleanup !== undefined && cleanup.action === "already-settled") {
      assert.equal(cleanup.code, null, "already-settled cleanup must report the observed exit code unchanged");
      assert.equal(cleanup.signal, "SIGTERM", "already-settled cleanup must report the observed signal unchanged");
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Root deletion is gated on proven settlement: never rm(...) while an
    // unverified live owned child might still hold the fixture scripts or
    // stdio pipes open.
    if (cleanup?.settled) {
      await rm(root, { recursive: true, force: true });
    } else {
      failPendingOwnedChildCleanup(primaryError, cleanup, root);
    }
  }
});

test("Windows fail-closed cleanup must not signal an unverified live owned child (#268)", async () => {
  // Process-free stub for the standing win32 policy (the #238 approach): a live
  // fixture child cannot be identity-verified on Windows (no portable cwd
  // query), so cleanup must report an unverified identity and send no signal.
  // This is not a native-Windows claim and not a product-behavior change: the
  // POSIX verified-signal close path is exercised by the three EPIPE fixtures
  // above and by their external probe receipts; this stub only proves that the
  // unverified branch of THIS fixture's cleanup refuses to signal.
  let childSignalCalls = 0;
  let osSignalCalls = 0;
  const captured = createCapturedOwnedChild(join("unused", "cwd"));
  captured.pid = 12345;
  captured.proc = {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: () => {
      childSignalCalls += 1;
      return true;
    },
  } as unknown as ChildProcess;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realKill = process.kill;
  let receipt: OwnedChildCleanupReceipt | undefined;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.kill = (() => {
      osSignalCalls += 1;
      return true;
    }) as typeof process.kill;
    receipt = await settleOwnedChild(captured);
  } finally {
    process.kill = realKill;
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  assert.ok(
    receipt !== undefined && receipt.action === "unverified-identity-no-signal" && receipt.detail.includes("win32"),
    `win32 cleanup must fail closed without portable cwd verification (got ${JSON.stringify(receipt)})`,
  );
  assert.equal(receipt?.settled, false, "win32 cleanup must report the pending child honestly");
  assert.equal(childSignalCalls, 0, "unavailable verification must not signal the captured child handle");
  assert.equal(osSignalCalls, 0, "unavailable verification must not signal a pid or process group");
});