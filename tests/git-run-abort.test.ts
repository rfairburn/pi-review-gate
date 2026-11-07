/**
 * #617: the checkpoint Git runner must settle its owned child truthfully.
 * A signal that is already aborted never spawns; an in-flight abort kills the
 * child and reports `aborted` only after its close event; a close that cannot
 * be established within the existing operation deadline is visible
 * `cleanup_unconfirmed`, never an expected cancellation.
 *
 * These are owned real processes and POSIX launchers, not a mocked process
 * table or native terminal reproduction. Settlement is proven by the actual
 * root ChildProcess close event plus a receipt written synchronously by each
 * owned descendant's own `exit` callback, never by PID absence.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitCheckpointError } from "../src/git-checkpoint";
import { runGit, runGitWithInput, type GitRunSpec } from "../src/checkpoint/run-git";

const posixOnly = { skip: process.platform === "win32" };

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    assert.ok(Date.now() < deadline, `bounded fixture wait: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A POSIX launcher whose whole job is to run an owned Node fixture. */
async function launcher(root: string, fixture: string): Promise<string> {
  const fixturePath = join(root, "fixture.cjs");
  await writeFile(fixturePath, fixture, "utf8");
  const path = join(root, "git");
  await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${fixturePath}' "$@"\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function spec(overrides: Partial<GitRunSpec> = {}): GitRunSpec {
  return { timeoutMs: 5_000, maxBytes: 1024 * 1024, ...overrides };
}

interface RootClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ExitReceipt {
  pid: number;
  code: number;
}

interface OwnedAbortFixture {
  readonly rootDir: string;
  readonly git: string;
  ready(): Promise<number>;
  rootClose(): Promise<RootClose>;
  rootClosed(): boolean;
  release(): Promise<void>;
  receipt(pid: number): Promise<ExitReceipt>;
  dispose(): Promise<void>;
}

/**
 * A real root fixture that spawns one inherited-pipe descendant. The
 * descendant writes its own readiness, holds the runner's stdout/stderr until
 * the test creates the release marker, and records its own terminal code from
 * its real `exit` callback. The spawn spy only observes the returned
 * ChildProcess and its `close`; it never fabricates either.
 */
async function ownedAbortFixture(
  t: TestContext,
  prefix: string,
  releaseAction = "process.exit(0);",
): Promise<OwnedAbortFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const releasePath = join(rootDir, "owned.release");
  const rootReadyPath = join(rootDir, "root.ready");
  const descendantReadyPath = join(rootDir, "descendant.ready");
  const receiptPath = join(rootDir, "descendant.exit.json");
  const descendantScript = [
    "const fs=require('node:fs');",
    `const releasePath=${JSON.stringify(releasePath)};`,
    `const receiptPath=${JSON.stringify(receiptPath)};`,
    "process.on('exit',(code)=>{",
    "  fs.writeFileSync(receiptPath,JSON.stringify({pid:process.pid,code}));",
    "});",
    `fs.writeFileSync(${JSON.stringify(descendantReadyPath)},String(process.pid));`,
    "const releasePoll=setInterval(()=>{",
    "  if(!fs.existsSync(releasePath))return;",
    "  clearInterval(releasePoll);",
    `  ${releaseAction}`,
    "},20);",
    // Independent finite watchdog: even a lost test cannot leave this pipe
    // owner alive indefinitely. Normal tests release and observe code 0 first.
    "setTimeout(()=>{clearInterval(releasePoll);process.exit(91);},30000).unref();",
  ].join("\n");
  const git = await launcher(rootDir, [
    "const fs=require('node:fs');const {spawn}=require('node:child_process');",
    `const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'inherit'});`,
    `fs.writeFileSync(${JSON.stringify(rootReadyPath)}, String(descendant.pid));`,
    "process.stdin.resume();setInterval(()=>{},1000);",
  ].join(""));

  const realSpawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  let closeObservation: RootClose | undefined;
  let closePromise: Promise<RootClose> | undefined;
  t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
    assert.equal(child, undefined, "the fixture owns exactly one root child");
    const spawned = realSpawn(...args);
    child = spawned;
    closePromise = new Promise<RootClose>((resolve) => {
      spawned.once("close", (code, signal) => {
        closeObservation = { code, signal };
        resolve(closeObservation);
      });
    });
    return spawned;
  }) as typeof childProcess.spawn);

  const release = async (): Promise<void> => {
    await writeFile(releasePath, "release", "utf8");
  };

  const ready = async (): Promise<number> => {
    await until(
      async () => (await exists(rootReadyPath)) && (await exists(descendantReadyPath)),
      "owned fixture child readiness",
    );
    const announcedPid = Number(await readFile(rootReadyPath, "utf8"));
    const descendantPid = Number(await readFile(descendantReadyPath, "utf8"));
    assert.ok(Number.isSafeInteger(announcedPid) && announcedPid > 0, "the root published its owned descendant PID");
    assert.equal(announcedPid, descendantPid, "root and descendant published the same owned PID");
    assert.ok(child, "the fixture root ChildProcess was spawned");
    return descendantPid;
  };

  const rootClose = async (): Promise<RootClose> => {
    assert.ok(closePromise, "the fixture root ChildProcess was spawned");
    return closePromise;
  };

  const receipt = async (pid: number): Promise<ExitReceipt> => {
    await until(() => exists(receiptPath), `owned descendant ${pid} exit receipt`);
    const observed = JSON.parse(await readFile(receiptPath, "utf8")) as ExitReceipt;
    assert.equal(observed.pid, pid, "the exit receipt belongs to the owned descendant");
    assert.equal(typeof observed.code, "number", "the exit receipt records the descendant's real exit code");
    return observed;
  };

  const dispose = async (): Promise<void> => {
    // Release first even when an assertion failed before the test's own
    // release, so the descendant can close the inherited pipes.
    await release();
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already terminal */ }
    }
    if (child) {
      assert.ok(closePromise, "a spawned fixture root has a close observer");
      await until(() => closeObservation !== undefined, "owned fixture root close during cleanup");
      const pidPath = await exists(rootReadyPath)
        ? rootReadyPath
        : await exists(descendantReadyPath) ? descendantReadyPath : undefined;
      if (pidPath !== undefined) {
        const pid = Number(await readFile(pidPath, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          await until(() => exists(receiptPath), `owned fixture descendant ${pid} exit receipt during cleanup`);
          const observed = JSON.parse(await readFile(receiptPath, "utf8")) as ExitReceipt;
          assert.equal(observed.pid, pid, "cleanup receipt belongs to the owned descendant");
        }
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  };

  return {
    rootDir,
    git,
    ready,
    rootClose,
    rootClosed: () => closeObservation !== undefined,
    release,
    receipt,
    dispose,
  };
}

test("an already-aborted signal starts no Git child for either runner", posixOnly, async (t) => {
  // Observe the real spawn boundary: checking a marker immediately after a
  // rejection alone could miss a child that has not reached its script yet.
  const spawn = t.mock.method(childProcess, "spawn");
  const root = await mkdtemp(join(tmpdir(), "prg-run-preabort-"));
  try {
    const marker = join(root, "spawned");
    const git = await launcher(root, [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
      "setTimeout(()=>process.exit(0), 20);",
    ].join(""));
    for (const invoke of [
      () => runGit(git, root, ["version"], spec({ signal: AbortSignal.abort("escape") })),
      () => runGitWithInput(git, root, ["apply"], Buffer.from("patch"), spec({ signal: AbortSignal.abort("escape") }), {}),
    ]) {
      const error = await invoke().then(
        () => assert.fail("the pre-signaled operation must not resolve"),
        (failure: unknown) => failure,
      );
      assert.ok(error instanceof GitCheckpointError);
      assert.equal(error.reason, "aborted");
      assert.equal(spawn.mock.callCount(), 0, "a pre-signaled runner must not spawn its child");
      assert.equal(await exists(marker), false, "a pre-signaled runner must not execute its child");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an in-flight abort waits for the owned child's close before reporting aborted", { ...posixOnly, timeout: 15_000 }, async (t) => {
  const fixture = await ownedAbortFixture(t, "prg-run-close-");
  try {
    const controller = new AbortController();
    let settled = false;
    const pending = runGit(fixture.git, fixture.rootDir, ["version"], spec({ signal: controller.signal }))
      .then(() => assert.fail("the aborted runner must reject"), (failure: unknown) => failure)
      .finally(() => { settled = true; });
    const pid = await fixture.ready();
    controller.abort("escape");
    // The descendant deliberately retains the inherited pipes across this
    // observation window. An implementation that reports on abort rather
    // than on the real close would settle here.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, "abort must not report before the inherited pipe owner closes");
    assert.equal(fixture.rootClosed(), false, "the real root close event has not been observed yet");
    await fixture.release();
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "aborted");
    assert.deepEqual(
      await fixture.rootClose(),
      { code: null, signal: "SIGKILL" },
      "the root ChildProcess's actual close records the abort kill",
    );
    assert.equal((await fixture.receipt(pid)).code, 0, "the owned descendant observed its own clean exit");
  } finally { await fixture.dispose(); }
});

test("late bytes from an inherited pipe owner cannot replace an abort with an overflow failure", { ...posixOnly, timeout: 15_000 }, async (t) => {
  const fixture = await ownedAbortFixture(t, "prg-run-late-bytes-", [
    "process.stdout.write('x'.repeat(2048));",
    "fs.writeFileSync(require('node:path').join(process.cwd(),'late-bytes.wrote'),'yes');",
    "setTimeout(()=>process.exit(0),100);",
  ].join(""));
  const wrote = join(fixture.rootDir, "late-bytes.wrote");
  try {
    const controller = new AbortController();
    let settled = false;
    const pending = runGit(fixture.git, fixture.rootDir, ["version"], spec({ signal: controller.signal, maxBytes: 64 }))
      .then(() => assert.fail("the aborted runner must reject"), (failure: unknown) => failure)
      .finally(() => { settled = true; });
    const pid = await fixture.ready();
    controller.abort("escape");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, "an immediate report would not wait for the inherited pipe owner");
    assert.equal(await exists(wrote), false, "the owned descendant has not written after the abort yet");
    await fixture.release();
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "aborted");
    assert.equal(await exists(wrote), true, "the inherited pipe owner wrote bytes after the abort");
    assert.deepEqual(
      await fixture.rootClose(),
      { code: null, signal: "SIGKILL" },
      "the root ChildProcess's actual close records the abort kill",
    );
    assert.equal((await fixture.receipt(pid)).code, 0, "the owned descendant observed its own clean exit");
  } finally { await fixture.dispose(); }
});

test("a close that misses the existing operation deadline is visible cleanup uncertainty", { ...posixOnly, timeout: 15_000 }, async (t) => {
  const fixture = await ownedAbortFixture(t, "prg-run-unconfirmed-");
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runGit(fixture.git, fixture.rootDir, ["version"], spec({ timeoutMs: 1000, signal: controller.signal }))
      .then(() => assert.fail("an unconfirmed close must fail, not resolve"), (failure: unknown) => failure);
    const pid = await fixture.ready();
    controller.abort("escape");
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "cleanup_unconfirmed");
    assert.match(error.message, /close event was not observed/);
    assert.ok(Date.now() - startedAt < 2500, "the operation deadline bounds the wait; it is not extended");
    assert.equal(fixture.rootClosed(), false, "the deadline reported before the owned pipe owner closed");
    await fixture.release();
    assert.deepEqual(
      await fixture.rootClose(),
      { code: null, signal: "SIGKILL" },
      "the release lets the root ChildProcess reach its actual close",
    );
    assert.equal((await fixture.receipt(pid)).code, 0, "the owned descendant observed its own clean exit");
  } finally { await fixture.dispose(); }
});

test("runGitWithInput also kills an in-flight owned child and waits for close", { ...posixOnly, timeout: 15_000 }, async (t) => {
  const fixture = await ownedAbortFixture(t, "prg-run-input-abort-");
  try {
    const controller = new AbortController();
    let settled = false;
    const pending = runGitWithInput(fixture.git, fixture.rootDir, ["apply"], Buffer.from("patch"), spec({ signal: controller.signal }), {})
      .then(() => assert.fail("the aborted runner must reject"), (failure: unknown) => failure)
      .finally(() => { settled = true; });
    const pid = await fixture.ready();
    controller.abort("escape");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, "the input runner must not report before the inherited pipe owner closes");
    assert.equal(fixture.rootClosed(), false, "the real root close event has not been observed yet");
    await fixture.release();
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "aborted");
    assert.deepEqual(
      await fixture.rootClose(),
      { code: null, signal: "SIGKILL" },
      "the root ChildProcess's actual close records the abort kill",
    );
    assert.equal((await fixture.receipt(pid)).code, 0, "the owned descendant observed its own clean exit");
  } finally { await fixture.dispose(); }
});
