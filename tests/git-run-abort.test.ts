/**
 * #617: the checkpoint Git runner must settle its owned child truthfully.
 * A signal that is already aborted never spawns; an in-flight abort kills the
 * child and reports `aborted` only after its close event; a close that cannot
 * be established within the existing operation deadline is visible
 * `cleanup_unconfirmed`, never an expected cancellation.
 *
 * These are owned real processes and POSIX launchers, not a mocked process
 * table or native terminal reproduction.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitCheckpointError } from "../src/git-checkpoint";
import { runGit, runGitWithInput, type GitRunSpec } from "../src/checkpoint/run-git";

const posixOnly = { skip: process.platform === "win32" };

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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

test("an in-flight abort waits for the owned child's close before reporting aborted", { ...posixOnly, timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-run-close-"));
  try {
    const ready = join(root, "ready");
    const childPid = join(root, "child.pid");
    // The direct child spawns an owned descendant that inherits the runner's
    // stdout/stderr. Killing the direct child cannot close those pipes until
    // the descendant exits, so `close` is a positive observation rather than
    // an assumption.
    const git = await launcher(root, [
      "const fs=require('node:fs');const {spawn}=require('node:child_process');",
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify([
        `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`,
        "setTimeout(()=>process.exit(0), 1200);",
      ].join(""))}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(ready)}, String(descendant.pid));`,
      "setInterval(()=>{},1000);",
    ].join(""));
    const controller = new AbortController();
    let settled = false;
    const pending = runGit(git, root, ["version"], spec({ signal: controller.signal }))
      .then(() => assert.fail("the aborted runner must reject"), (failure: unknown) => failure)
      .finally(() => { settled = true; });
    await until(async () => (await exists(ready)) && (await exists(childPid)), "owned fixture child readiness");
    const pid = Number(await readFile(childPid, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const abortedAt = Date.now();
    controller.abort("escape");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, "abort must not report before the inherited pipe owner closes");
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "aborted");
    assert.ok(!alive(pid), "the inherited-pipe owner must have exited before close was observed");
    assert.ok(Date.now() - abortedAt >= 400, "the runner waited for the real close event, not just the kill");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("late bytes from an inherited pipe owner cannot replace an abort with an overflow failure", { ...posixOnly, timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-run-late-bytes-"));
  try {
    const ready = join(root, "ready");
    const childPid = join(root, "child.pid");
    const wrote = join(root, "wrote");
    const git = await launcher(root, [
      "const fs=require('node:fs');const {spawn}=require('node:child_process');",
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify([
        `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`,
        "setTimeout(()=>{process.stdout.write('x'.repeat(2048));require('node:fs').writeFileSync(" + JSON.stringify(wrote) + ",'yes');setTimeout(()=>process.exit(0),100)},150);",
      ].join(""))}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(ready)}, String(descendant.pid));`,
      "setInterval(()=>{},1000);",
    ].join(""));
    const controller = new AbortController();
    const pending = runGit(git, root, ["version"], spec({ signal: controller.signal, maxBytes: 64 }))
      .then(() => assert.fail("the aborted runner must reject"), (failure: unknown) => failure);
    await until(async () => (await exists(ready)) && (await exists(childPid)), "owned fixture child readiness");
    const pid = Number(await readFile(childPid, "utf8"));
    controller.abort("escape");
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "aborted");
    assert.equal(await exists(wrote), true, "the inherited pipe owner did write after the abort");
    await until(() => !alive(pid), "owned descendant exits", 5000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a close that misses the existing operation deadline is visible cleanup uncertainty", { ...posixOnly, timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-run-unconfirmed-"));
  try {
    const ready = join(root, "ready");
    const childPid = join(root, "child.pid");
    const git = await launcher(root, [
      "const fs=require('node:fs');const {spawn}=require('node:child_process');",
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify([
        `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`,
        "setTimeout(()=>process.exit(0), 3000);",
      ].join(""))}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(ready)}, String(descendant.pid));`,
      "setInterval(()=>{},1000);",
    ].join(""));
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runGit(git, root, ["version"], spec({ timeoutMs: 1000, signal: controller.signal }))
      .then(() => assert.fail("an unconfirmed close must fail, not resolve"), (failure: unknown) => failure);
    await until(async () => (await exists(ready)) && (await exists(childPid)), "owned fixture child readiness");
    const pid = Number(await readFile(childPid, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    controller.abort("escape");
    const error = await pending;
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "cleanup_unconfirmed");
    assert.match(error.message, /close event was not observed/);
    assert.ok(Date.now() - startedAt < 2500, "the operation deadline bounds the wait; it is not extended");
    await until(() => !alive(pid), "owned descendant exits", 5000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runGitWithInput also kills an in-flight owned child and waits for close", { ...posixOnly, timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-run-input-abort-"));
  try {
    const ready = join(root, "ready");
    const childPid = join(root, "child.pid");
    const git = await launcher(root, [
      "const fs=require('node:fs');const {spawn}=require('node:child_process');",
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify([
        `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`,
        "setTimeout(()=>process.exit(0), 700);",
      ].join(""))}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(ready)}, String(descendant.pid));`,
      "process.stdin.resume();setInterval(()=>{},1000);",
    ].join(""));
    const controller = new AbortController();
    const pending = runGitWithInput(git, root, ["apply"], Buffer.from("patch"), spec({ signal: controller.signal }), {});
    await until(async () => (await exists(ready)) && (await exists(childPid)), "owned fixture child readiness");
    const pid = Number(await readFile(childPid, "utf8"));
    controller.abort("escape");
    const error = await pending.then(() => assert.fail("the aborted runner must reject"), (failure: unknown) => failure);
    assert.ok(error instanceof GitCheckpointError);
    assert.equal(error.reason, "aborted");
    assert.ok(!alive(pid), "the inherited-pipe owner must have exited before close was observed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
