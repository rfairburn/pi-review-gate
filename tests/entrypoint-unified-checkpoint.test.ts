// User-runnable entrypoint smoke: npm run build:test && node --test dist-test/tests/entrypoint-unified-checkpoint.test.js
// Exercises real activate() hooks, not runReview/armGitCheckpoint directly. Git
// Both Git and plain-directory activation must choose durable checkpoints.
// Fresh-process resume/verification is a following milestone: this smoke pins
// on-disk descriptor shape and the live review, not restart recovery.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GIT_CHECKPOINT_DESCRIPTOR_FORMAT } from "../src/git-checkpoint";
import { activate } from "../src/index";
import { SessionStateStore } from "../src/session-state";
import type { ReviewCheckpointDescriptor } from "../src/review-checkpoint";
import type { ReviewGateState } from "../src/state";
import { agentCatalog } from "./helpers";
import {
  countingPassReviewerWithPromptDump,
  createSessionRuntime,
  indexTestConfig,
  trigger,
  triggerAgentEnd,
} from "./entrypoint-harness";

const exec = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Smoke Test",
  GIT_AUTHOR_EMAIL: "smoke@example.invalid",
  GIT_COMMITTER_NAME: "Smoke Test",
  GIT_COMMITTER_EMAIL: "smoke@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: gitEnv })).stdout;
}

// The compiled test lives under ignored dist-test/tests. All temporary Git,
// session, reviewer and bundle files stay beneath that ignored directory and
// are removed even when the test fails; no fixture touches the source checkout.
async function fixture(gitRoot: boolean) {
  const root = await mkdtemp(join(__dirname, "unified-checkpoint-smoke-"));
  const cwd = join(root, "workspace");
  // Prevent the plain workspace from discovering the enclosing project Git
  // repository (whose ignored dist-test directory would hide every file).
  const priorGitCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = root;
  const sessionDir = join(root, "session");
  await mkdir(cwd);
  await mkdir(sessionDir);
  const sessionFile = join(sessionDir, "conversation.jsonl");
  await writeFile(sessionFile, "");
  const configPath = join(sessionDir, "review-gate.json");
  const promptPath = join(sessionDir, "reviewer-prompt.txt");
  const callsPath = join(sessionDir, "reviewer-calls.txt");
  await writeFile(configPath, JSON.stringify({
    ...indexTestConfig,
    retainBundles: "always",
    externalAgents: agentCatalog(countingPassReviewerWithPromptDump("fake", callsPath, promptPath)),
    review: {
      primaryReviewers: [{ source: "external", id: "fake" }],
      subtaskReviewers: [{ source: "external", id: "fake" }],
      primaryEnabled: true,
    },
  }));
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;
  if (gitRoot) {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "core.autocrlf", "false");
  }
  await writeFile(join(cwd, "keep.txt"), "untouched clean tracked\n");
  await writeFile(join(cwd, "work.txt"), "committed\n");
  if (gitRoot) {
    await git(cwd, "add", "keep.txt", "work.txt");
    await git(cwd, "commit", "-q", "-m", "seed");
    await writeFile(join(cwd, "work.txt"), "staged baseline\n");
    await git(cwd, "add", "work.txt");
    await writeFile(join(cwd, "work.txt"), "staged baseline\nunstaged baseline\n");
  }
  // Deterministic binary containing NUL and non-UTF8; not in .gitignore.
  await writeFile(join(cwd, "loose.bin"), Buffer.from([0, 255, 3, 8]));
  return { root, cwd, sessionFile, promptPath, callsPath, restoreGitCeiling() {
    if (priorGitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = priorGitCeiling;
  } };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const rt = createSessionRuntime("checkpoint-smoke", f.sessionFile, f.cwd);
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  rt.pi.registerCommand = (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    commands.set(name, options.handler);
  };
  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
  await trigger(rt.hooks, "input", { cwd: f.cwd, source: "user", text: "edit work and the binary only" }, rt.ctx);
  await trigger(rt.hooks, "before_agent_start", { cwd: f.cwd }, rt.ctx);
  const store = new SessionStateStore({ sessionId: "checkpoint-smoke", sessionFile: f.sessionFile, cwd: f.cwd });
  return { rt, store, commands };
}

async function ownerExists(cwd: string, descriptor: ReviewCheckpointDescriptor): Promise<boolean> {
  if (descriptor.kind === "git") {
    try {
      await git(cwd, "show-ref", "--verify", `refs/pi-review-gate/checkpoints/${descriptor.checkpoint.windowId}/base`);
      return true;
    } catch { return false; }
  }
  return access(join(cwd, ".pi-review-gate", "checkpoints", `${descriptor.windowId}-${descriptor.owner}`, "record.json"))
    .then(() => true, () => false);
}

for (const gitRoot of [true, false]) {
  const backend = gitRoot ? "Git" : "raw";
  test(`${backend} root: clear retires both window and exchange after the durable save`, async () => {
    const f = await fixture(gitRoot);
    try {
      const { rt, store, commands } = await start(f);
      const baseline = (await store.restore(f.cwd))?.state.reviewWindow?.baseline;
      await finish(f, rt);
      const exchange = (await store.restore(f.cwd))?.state.reviewWindow?.activeExchange?.baseline;
      assert.equal(baseline?.kind, "checkpoint");
      assert.equal(exchange?.kind, "checkpoint");
      if (baseline?.kind !== "checkpoint" || exchange?.kind !== "checkpoint") return;
      assert.equal(await ownerExists(f.cwd, baseline.descriptor), true);
      assert.equal(await ownerExists(f.cwd, exchange.descriptor), true);
      await commands.get("review-clear")?.("", rt.ctx);
      assert.equal((await store.restore(f.cwd))?.state.reviewWindow, undefined);
      assert.equal(await ownerExists(f.cwd, baseline.descriptor), false);
      assert.equal(await ownerExists(f.cwd, exchange.descriptor), false);
    } finally {
      f.restoreGitCeiling();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test(`${backend} root: replacement retires the prior question window but retains the new owner`, async () => {
    const f = await fixture(gitRoot);
    try {
      const { rt, store } = await start(f);
      await finish(f, rt);
      const prior = (await store.restore(f.cwd))?.state.reviewWindow;
      const owners = [prior?.baseline, prior?.activeExchange?.baseline].filter((value) => value?.kind === "checkpoint");
      await trigger(rt.hooks, "before_agent_start", { cwd: f.cwd }, rt.ctx);
      await triggerAgentEnd(rt.hooks, { cwd: f.cwd, messages: [{ role: "assistant", content: "no further edits" }] }, rt.ctx);
      assert.ok((await store.restore(f.cwd))?.state.lastQuestionWindow);
      if (prior?.baseline?.kind === "checkpoint") {
        assert.equal(await ownerExists(f.cwd, prior.baseline.descriptor), true, "question window still owns its baseline");
      }
      await trigger(rt.hooks, "input", { cwd: f.cwd, source: "user", text: "a new request" }, rt.ctx);
      await trigger(rt.hooks, "before_agent_start", { cwd: f.cwd }, rt.ctx);
      const next = (await store.restore(f.cwd))?.state.reviewWindow?.baseline;
      assert.equal(next?.kind, "checkpoint");
      if (next?.kind === "checkpoint") assert.equal(await ownerExists(f.cwd, next.descriptor), true);
      for (const owner of owners) {
        if (owner?.kind === "checkpoint") assert.equal(await ownerExists(f.cwd, owner.descriptor), false);
      }
    } finally {
      f.restoreGitCeiling();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test(`${backend} root: failed replacement save retains the old question-window owner`, async () => {
    const f = await fixture(gitRoot);
    const originalSave = SessionStateStore.prototype.save;
    try {
      const { rt, store } = await start(f);
      await finish(f, rt);
      await trigger(rt.hooks, "before_agent_start", { cwd: f.cwd }, rt.ctx);
      await triggerAgentEnd(rt.hooks, { cwd: f.cwd, messages: [{ role: "assistant", content: "no edits" }] }, rt.ctx);
      const prior = (await store.restore(f.cwd))?.state.lastQuestionWindow?.baseline;
      assert.equal(prior?.kind, "checkpoint");
      if (prior?.kind !== "checkpoint") return;
      SessionStateStore.prototype.save = async () => false;
      await trigger(rt.hooks, "input", { cwd: f.cwd, source: "user", text: "replacement" }, rt.ctx);
      assert.equal(await ownerExists(f.cwd, prior.descriptor), true);
      assert.equal((await store.restore(f.cwd))?.state.lastQuestionWindow?.baseline?.kind, "checkpoint");
      assert.match(rt.notices.join("\n"), /checkpoint owners retained because the session-state save is unavailable/);
    } finally {
      SessionStateStore.prototype.save = originalSave;
      f.restoreGitCeiling();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test(`${backend} root: a real session-owner release failure stays visible after the durable save`, async () => {
    const f = await fixture(gitRoot);
    const checkpointModule = require("../src/review-checkpoint") as typeof import("../src/review-checkpoint");
    const originalRelease = checkpointModule.releaseReviewCheckpoint;
    try {
      const { rt, store, commands } = await start(f);
      const baseline = (await store.restore(f.cwd))?.state.reviewWindow?.baseline;
      assert.equal(baseline?.kind, "checkpoint");
      if (baseline?.kind !== "checkpoint") throw new Error("checkpoint missing");
      checkpointModule.releaseReviewCheckpoint = async () => ({ status: "failed", reason: "raw_checkpoint_failed", detail: "injected" });
      await assert.rejects(async () => { await commands.get("review-clear")?.("", rt.ctx); }, /retained checkpoint owner; release failed/);
      assert.equal((await store.restore(f.cwd))?.state.reviewWindow, undefined, "sidecar was saved before attempting release");
      assert.equal(await ownerExists(f.cwd, baseline.descriptor), true, "failed release remains pinned for retry");
      assert.match(rt.notices.join("\n"), /retained checkpoint owner; release failed/);
    } finally {
      checkpointModule.releaseReviewCheckpoint = originalRelease;
      f.restoreGitCeiling();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  for (const failure of ["unavailable", "throw"] as const) {
    test(`${backend} root: ${failure} sidecar save retains discarded owners`, async () => {
      const f = await fixture(gitRoot);
      const originalSave = SessionStateStore.prototype.save;
      try {
        const { rt, store, commands } = await start(f);
        const baseline = (await store.restore(f.cwd))?.state.reviewWindow?.baseline;
        assert.equal(baseline?.kind, "checkpoint");
        if (baseline?.kind !== "checkpoint") return;
        SessionStateStore.prototype.save = async function (...args) {
          if (failure === "throw") throw new Error("test write failure");
          return false;
        };
        if (failure === "throw") {
          await assert.rejects(async () => { await commands.get("review-clear")?.("", rt.ctx); }, /test write failure/);
        } else {
          await commands.get("review-clear")?.("", rt.ctx);
        }
        assert.equal(await ownerExists(f.cwd, baseline.descriptor), true);
        assert.equal((await store.restore(f.cwd))?.state.reviewWindow?.baseline?.kind, "checkpoint", "disk retained the prior owner");
      } finally {
        SessionStateStore.prototype.save = originalSave;
        f.restoreGitCeiling();
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }

  test(`${backend} root: overlapping throwing save cannot strand an acknowledged discard`, async () => {
    const f = await fixture(gitRoot);
    const originalSave = SessionStateStore.prototype.save;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    try {
      const { rt, store, commands } = await start(f);
      const baseline = (await store.restore(f.cwd))?.state.reviewWindow?.baseline;
      assert.equal(baseline?.kind, "checkpoint");
      if (baseline?.kind !== "checkpoint") return;
      let calls = 0;
      SessionStateStore.prototype.save = async function (...args) {
        if (++calls === 1) {
          const write = originalSave.apply(this, args);
          firstStarted();
          await firstGate;
          return write;
        }
        throw new Error("overlapping save failed");
      };
      const clear = commands.get("review-clear")?.("", rt.ctx);
      await started;
      const failing = commands.get("review-gate-ping")?.("", rt.ctx);
      releaseFirst();
      await clear;
      await assert.rejects(async () => { await failing; }, /overlapping save failed/);
      assert.equal((await store.restore(f.cwd))?.state.reviewWindow, undefined);
      assert.equal(await ownerExists(f.cwd, baseline.descriptor), false);
    } finally {
      releaseFirst();
      SessionStateStore.prototype.save = originalSave;
      f.restoreGitCeiling();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test(`${backend} root: re-arm during delayed release cannot persist a deleted owner`, async () => {
    const f = await fixture(gitRoot);
    const originalSave = SessionStateStore.prototype.save;
    const checkpointModule = require("../src/review-checkpoint") as typeof import("../src/review-checkpoint");
    const originalRelease = checkpointModule.releaseReviewCheckpoint;
    let resumeRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => { resumeRelease = resolve; });
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    try {
      const { rt, store, commands } = await start(f);
      const previous = (await store.restore(f.cwd))?.state.reviewWindow;
      assert.equal(previous?.baseline?.kind, "checkpoint");
      if (previous?.baseline?.kind !== "checkpoint") return;
      let liveState: ReviewGateState | undefined;
      SessionStateStore.prototype.save = function (state, ...args) {
        liveState = state;
        return originalSave.call(this, state, ...args);
      };
      checkpointModule.releaseReviewCheckpoint = async (...args) => {
        releaseStarted();
        await releaseGate;
        return originalRelease(...args);
      };
      const clear = commands.get("review-clear")?.("", rt.ctx);
      await started;
      assert.ok(liveState);
      liveState.reviewWindow = previous;
      const rearm = commands.get("review-gate-ping")?.("", rt.ctx);
      assert.equal((await store.restore(f.cwd))?.state.reviewWindow, undefined, "the discard reached disk before release");
      resumeRelease();
      await clear;
      await assert.rejects(async () => { await rearm; }, /retired checkpoint re-armed/);
      assert.equal((await store.restore(f.cwd))?.state.reviewWindow, undefined, "no sidecar can point to the deleted owner");
      assert.match(rt.notices.join("\n"), /persistence blocked/);
    } finally {
      resumeRelease();
      checkpointModule.releaseReviewCheckpoint = originalRelease;
      SessionStateStore.prototype.save = originalSave;
      f.restoreGitCeiling();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

async function finish(f: Awaited<ReturnType<typeof fixture>>, rt: ReturnType<typeof createSessionRuntime>) {
  await writeFile(join(f.cwd, "work.txt"), "staged baseline\nunstaged baseline\nreviewed edit\n");
  await writeFile(join(f.cwd, "loose.bin"), Buffer.from([0, 254, 3, 8]));
  await trigger(rt.hooks, "tool_call", { cwd: f.cwd, toolName: "bash", input: { command: "echo edit" } }, rt.ctx);
  await triggerAgentEnd(rt.hooks, {
    cwd: f.cwd,
    messages: [{ role: "assistant", content: "edited work and binary" }],
  }, rt.ctx);
  assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "1", `actual generic-cli reviewer ran once; notices: ${rt.notices.join(" | ")}`);
  assert.match(rt.notices.join("\n"), /review gate: passed/);
  assert.equal(rt.sent.length, 1);
  const prompt = await readFile(f.promptPath, "utf8");
  assert.match(prompt, /reviewed edit/);
  assert.match(prompt, /work\.txt/);
  assert.match(prompt, /loose\.bin/);
  assert.doesNotMatch(prompt, /untouched clean tracked/);
}

test("Git root: real preprompt arms a unified descriptor and review freezes changed-only output", async () => {
  const f = await fixture(true);
  try {
    const beforeStatus = await git(f.cwd, "status", "--porcelain=v1");
    const beforeIndex = await readFile(join(f.cwd, ".git", "index"));
    const { rt, store } = await start(f);
    const opened = await store.restore(f.cwd);
    const baseline = opened?.state.reviewWindow?.baseline;
    assert.equal(await git(f.cwd, "status", "--porcelain=v1"), beforeStatus, "arming must not alter staged/unstaged/untracked status");
    assert.deepEqual(await readFile(join(f.cwd, ".git", "index")), beforeIndex);
    const armedRaw = JSON.parse(await readFile(store.path, "utf8")) as { state: { reviewWindow: { baseline: Record<string, unknown>; activeExchange: { baseline: Record<string, unknown> } } } };
    // Still settle the actual Git-root review while activation is RED; never
    // let a preprompt-only assertion mask failures in the reviewer hook path.
    await finish(f, rt);
    const settled = await store.restore(f.cwd);
    const window = settled?.state.reviewWindow;
    assert.ok(window, "passed window remains open for the review response");
    assert.equal(window.reviewHistory.at(-1)?.verdict, "pass");
    assert.deepEqual(window.exchanges.at(-1)?.workspaceChanges.map((c) => [c.path, c.status]).sort(), [
      ["loose.bin", "modified"], ["work.txt", "modified"],
    ]);
    assert.equal(window.exchanges.at(-1)?.workspaceChanges.find((c) => c.path === "loose.bin")?.binary, true);
    assert.match(window.exchanges.at(-1)?.workspacePatch ?? "", /reviewed edit/);
    assert.doesNotMatch(window.exchanges.at(-1)?.workspacePatch ?? "", /untouched clean tracked/);
    assert.equal(baseline?.kind, "checkpoint", "Git preprompt must choose the compact checkpoint, not a WorkspaceSnapshot");
    if (baseline?.kind !== "checkpoint") return;
    assert.equal(baseline.descriptor.kind, "git");
    if (baseline.descriptor.kind !== "git") return;
    assert.equal(baseline.descriptor.checkpoint.format, GIT_CHECKPOINT_DESCRIPTOR_FORMAT);
    assert.equal(baseline.cwd, f.cwd);
    assert.equal(armedRaw.state.reviewWindow.baseline.kind, "checkpoint");
    assert.ok(armedRaw.state.reviewWindow.baseline.descriptor);
    assert.equal(Object.hasOwn(armedRaw.state.reviewWindow.baseline, "files"), false, "no legacy WorkspaceSnapshot serialized");
    assert.doesNotMatch(JSON.stringify(armedRaw.state.reviewWindow.baseline), /stagedPatchB64|unstagedPatchB64|contentB64/, "only the compact descriptor belongs in the sidecar");
    assert.ok(armedRaw.state.reviewWindow.activeExchange.baseline.$checkpointRef, "one descriptor, shared by the active exchange");
    assert.equal(Object.hasOwn(armedRaw.state.reviewWindow.activeExchange.baseline, "$snapshotRef"), false);
    assert.equal(window.activeExchange?.baseline?.kind, "checkpoint", "frozen after-checkpoint survives settlement");
    assert.notEqual(window.activeExchange?.baseline?.kind === "checkpoint" && window.activeExchange.baseline.descriptor.kind === "git" ? window.activeExchange.baseline.descriptor.checkpoint.armId : undefined, baseline.descriptor.checkpoint.armId);
    const settledRaw = await readFile(store.path, "utf8");
    assert.doesNotMatch(settledRaw, /\"files\"\s*:/, "no full-root WorkspaceSnapshot in persisted Git window");
  } finally {
    f.restoreGitCeiling();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("plain root: real preprompt and review use raw checkpoint, never snapshot fallback", async () => {
  const f = await fixture(false);
  try {
    const { rt, store } = await start(f);
    const opened = await store.restore(f.cwd);
    assert.equal(opened?.state.reviewWindow?.baseline?.kind, "checkpoint");
    if (opened?.state.reviewWindow?.baseline?.kind === "checkpoint") assert.equal(opened.state.reviewWindow.baseline.descriptor.kind, "raw");
    const armedRaw = await readFile(store.path, "utf8");
    assert.doesNotMatch(armedRaw, /"files"\s*:/, "no WorkspaceSnapshot persisted for plain root");
    await finish(f, rt);
    const window = (await store.restore(f.cwd))?.state.reviewWindow;
    assert.equal(window?.reviewHistory.at(-1)?.verdict, "pass");
    assert.deepEqual(window?.exchanges.at(-1)?.workspaceChanges.map((c) => [c.path, c.status]).sort(), [
      ["loose.bin", "modified"], ["work.txt", "modified"],
    ]);
    assert.equal(window?.exchanges.at(-1)?.workspaceChanges.find((c) => c.path === "loose.bin")?.binary, true);
    assert.equal(window?.activeExchange?.baseline?.kind, "checkpoint");
    assert.equal(window?.activeExchange?.baseline?.kind === "checkpoint" ? window.activeExchange.baseline.descriptor.kind : undefined, "raw");
    assert.doesNotMatch(await readFile(store.path, "utf8"), /"files"\s*:/);
  } finally {
    f.restoreGitCeiling();
    await rm(f.root, { recursive: true, force: true });
  }
});
