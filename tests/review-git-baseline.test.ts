import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { registerCommands } from "../src/commands";
import { captureReviewCheckpoint, loadReviewCheckpoint, releaseReviewCheckpoint } from "../src/review-checkpoint";
import { createEvidenceState, recordToolCallEvidence } from "../src/evidence";
import { armGitCheckpoint, type GitCheckpointDescriptor } from "../src/git-checkpoint";
import { collectPausedReviewExchange, runAskReviewer, runReview } from "../src/review";
import { beginAgentRun, createState, recordReviewerFeedbackAndArmExchange, type ReviewBaseline } from "../src/state";
import { fakeNeedsChangesConfig } from "./helpers";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, env: GIT_ENV });
  return stdout;
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-gate-git-baseline-"));
  await git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "# test\n");
  await writeFile(join(repo, "index.ts"), "before\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "initial");
  return repo;
}

function baselineOf(descriptor: GitCheckpointDescriptor, cwd: string): ReviewBaseline {
  return { kind: "git", descriptor, cwd, capturedAt: new Date().toISOString() };
}

async function armAt(repo: string, windowId: string): Promise<GitCheckpointDescriptor> {
  const armed = await armGitCheckpoint(repo, windowId);
  assert.equal(armed.status, "ok", JSON.stringify(armed));
  return armed.value.descriptor;
}

/** All checkpoint pin refs currently present in the repository. */
async function checkpointRefs(repo: string): Promise<string[]> {
  const out = await git(repo, "for-each-ref", "--format=%(refname)", "refs/pi-review-gate/checkpoints/");
  return out.trim() ? out.trim().split("\n") : [];
}

const config = fakeNeedsChangesConfig();
test("raw parent checkpoint reviews changed binary and mode without a workspace snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-raw-parent-"));
  try {
    await writeFile(join(root, "clean.txt"), "unchanged\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 1]));
    await writeFile(join(root, "mode.txt"), "same text\n");
    const captured = await captureReviewCheckpoint(root, "raw-parent");
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;
    assert.equal(captured.value.kind, "raw");
    const before: ReviewBaseline = { kind: "checkpoint", descriptor: captured.value, cwd: root, capturedAt: new Date().toISOString() };
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 254, 1]));
    await chmod(join(root, "mode.txt"), 0o755);
    const output = await runReview({ cwd: root, request: "change binary and mode", before, config });
    assert.equal(output.result?.verdict, "needs_changes");
    assert.equal(output.reviewedBaseline?.kind, "checkpoint");
    assert.deepEqual(output.changes.map((change) => change.path).sort(), ["binary.bin", "mode.txt"]);
    assert.equal(output.changes.find((change) => change.path === "binary.bin")?.binary, true);
    assert.equal(output.changes.find((change) => change.path === "mode.txt")?.newGitMode, "100755");
    if (output.reviewedBaseline?.kind === "checkpoint") {
      assert.equal((await loadReviewCheckpoint(root, output.reviewedBaseline.descriptor)).status, "ok");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Git-ignored in-root evidence remains reviewable using its pre-checkpoint frozen value", async () => {
  const repo = await initRepo();
  try {
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-q", "-m", "ignore candidate");
    await writeFile(join(repo, "ignored.txt"), "before\n");
    const captured = await captureReviewCheckpoint(repo, "ignored-candidate");
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;
    const evidence = createEvidenceState();
    await recordToolCallEvidence({
      state: evidence, cwd: repo, toolName: "write", toolInput: { path: "ignored.txt" },
      snapshotOptions: { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes },
    });
    await writeFile(join(repo, "ignored.txt"), "after\n");
    const output = await runReview({
      cwd: repo, request: "edit ignored file", config, evidence,
      before: { kind: "checkpoint", descriptor: captured.value, cwd: repo, capturedAt: new Date().toISOString() },
    });
    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "needs_changes");
    assert.deepEqual(output.changes.map((change) => change.path), ["ignored.txt"]);
    assert.equal(output.changes[0]?.newContent, "after\n");
  } finally { await rm(repo, { recursive: true, force: true }); }
});
test("nested Git-ignored evidence deletion reports a repository-root-relative path", async () => {
  const repo = await mkdtemp(join(process.cwd(), ".nested-ignored-evidence-"));
  const cwd = join(repo, "app");
  try {
    await mkdir(cwd, { recursive: true });
    await git(repo, "init", "-q");
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "tracked.txt"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "base");
    await writeFile(join(repo, "ignored.txt"), "before\n");
    const captured = await captureReviewCheckpoint(cwd, "nested-ignored-deletion");
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;

    const evidence = createEvidenceState();
    await recordToolCallEvidence({
      state: evidence, cwd, toolName: "write", toolInput: { path: "../ignored.txt" },
      snapshotOptions: { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes },
    });
    await rm(join(repo, "ignored.txt"));
    const output = await runReview({
      cwd, request: "delete ignored file", config, evidence,
      before: { kind: "checkpoint", descriptor: captured.value, cwd, capturedAt: new Date().toISOString() },
    });
    assert.equal(output.changed, true);
    assert.deepEqual(output.changes.map((change) => [change.path, change.status]), [["ignored.txt", "deleted"]]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("/review-continue captures a repository-root checkpoint while preserving nested session cwd", async () => {
  const repo = await mkdtemp(join(process.cwd(), ".review-continue-nested-"));
  const cwd = join(repo, "nested");
  await mkdir(cwd);
  try {
    await git(repo, "init", "-q");
    await writeFile(join(repo, "baseline.txt"), "base\n");
    await git(repo, "add", "baseline.txt");
    await git(repo, "commit", "-qm", "base");
    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    window.lastCappedFollowUp = "capped feedback";
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
    registerCommands({
      pi: {
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<unknown> }) { commands.set(name, options.handler); },
        sendUserMessage: async () => undefined,
      },
      cwd: () => cwd, config, state,
      onStateChanged: async () => undefined,
    });
    await commands.get("review-continue")!("", {});
    const response = window.activeExchange?.baseline;
    assert.equal(response?.kind, "checkpoint");
    if (response?.kind !== "checkpoint") throw new Error("missing response checkpoint");
    assert.equal(response.cwd, cwd);
    assert.equal(response.descriptor.kind, "git");
    assert.equal((await loadReviewCheckpoint(cwd, response.descriptor)).status, "ok");
    assert.equal((await releaseReviewCheckpoint(cwd, response.descriptor)).status, "ok");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("/review-continue capture failure preserves capped authorization for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-continue-capture-"));
  try {
    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    window.lastCappedFollowUp = "original capped feedback";
    window.correctionCycles = 2;
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
    registerCommands({
      pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<unknown> }) { commands.set(name, options.handler); } },
      cwd: () => join(root, "missing-root"), config, state,
      onStateChanged: () => undefined,
    });
    await assert.rejects(() => commands.get("review-continue")!("", {}), /response checkpoint failed/);
    assert.equal(window.lastCappedFollowUp, "original capped feedback");
    assert.equal(window.correctionCycles, 2);
    assert.equal(window.activeExchange?.baseline, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("/review-now retains completed checkpoint when changes-requested notice fails", async () => {
  const repo = await initRepo();
  try {
    const captured = await captureReviewCheckpoint(repo, "manual-notice-baseline");
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;
    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    const baseline: ReviewBaseline = { kind: "checkpoint", descriptor: captured.value, cwd: repo, capturedAt: new Date().toISOString() };
    window.baseline = baseline;
    window.activeExchange!.baseline = baseline;
    await writeFile(join(repo, "index.ts"), "new content\n");
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
    registerCommands({
      pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<unknown> }) { commands.set(name, options.handler); } },
      cwd: () => repo, config, state,
    });
    const ctx = { ui: { notify(message: string) { if (message.includes("changes requested")) throw new Error("notice failed"); } } };
    await assert.rejects(() => commands.get("review-now")!("", ctx), /notice failed/);
    assert.equal(window.activeExchange?.baseline?.kind, "checkpoint");
    assert.equal((await checkpointRefs(repo)).length, 2, "recorded after-checkpoint remains pinned");
  } finally { await rm(repo, { recursive: true, force: true }); }
});
test("/review-continue retains its newly referenced capture when persistence fails", async () => {
  const repo = await initRepo();
  try {
    const captured = await captureReviewCheckpoint(repo, "continue-baseline");
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;
    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    const baseline: ReviewBaseline = { kind: "checkpoint", descriptor: captured.value, cwd: repo, capturedAt: new Date().toISOString() };
    window.baseline = baseline;
    window.activeExchange!.baseline = baseline;
    window.lastCappedFollowUp = "feedback";
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
    registerCommands({
      pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<unknown> }) { commands.set(name, options.handler); } },
      cwd: () => repo, config, state,
      onStateChanged: () => { throw new Error("save failed"); },
    });
    await assert.rejects(() => commands.get("review-continue")!("", {}), /save failed/);
    assert.equal(window.activeExchange?.baseline?.kind, "checkpoint");
    assert.notEqual(window.activeExchange?.baseline, baseline, "failed save retains the new in-memory descriptor");
    assert.equal((await checkpointRefs(repo)).length, 2, "save failure must retain both old and new pins");
  } finally { await rm(repo, { recursive: true, force: true }); }
});
test("/review-continue rebases an existing response exchange while retaining the old pin without durable acknowledgement", async () => {
  const repo = await initRepo();
  try {
    const first = await captureReviewCheckpoint(repo, "continue-window");
    const old = await captureReviewCheckpoint(repo, "continue-previous-response");
    assert.equal(first.status, "ok", JSON.stringify(first));
    assert.equal(old.status, "ok", JSON.stringify(old));
    if (first.status !== "ok" || old.status !== "ok") return;
    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    const windowBaseline: ReviewBaseline = { kind: "checkpoint", descriptor: first.value, cwd: repo, capturedAt: new Date().toISOString() };
    const oldResponse: ReviewBaseline = { kind: "checkpoint", descriptor: old.value, cwd: repo, capturedAt: new Date().toISOString() };
    window.baseline = windowBaseline;
    window.activeExchange!.baseline = oldResponse;
    window.lastCappedFollowUp = "feedback";
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
    let savedWithOldPin = false;
    registerCommands({
      pi: {
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<unknown> }) { commands.set(name, options.handler); },
        sendUserMessage: async () => undefined,
      },
      cwd: () => repo, config, state,
      onStateChanged: async () => {
        if (window.activeExchange?.baseline !== oldResponse && !savedWithOldPin) {
          savedWithOldPin = (await checkpointRefs(repo)).includes("refs/pi-review-gate/checkpoints/continue-previous-response/base");
        }
      },
    });
    await commands.get("review-continue")!("", {});
    assert.equal(savedWithOldPin, true, "the command handoff retains the old pin until durable ownership transfer");
    assert.equal(window.activeExchange?.baseline?.kind, "checkpoint");
    assert.notEqual(window.activeExchange?.baseline, oldResponse);
    assert.notEqual(window.activeExchange?.baseline, windowBaseline);
    const current = window.activeExchange?.baseline;
    assert.equal(current?.kind, "checkpoint");
    if (current?.kind !== "checkpoint") return;
    assert.equal(current.descriptor.kind, "git");
    if (current.descriptor.kind !== "git") return;
    // This command-only harness cannot acknowledge a durable session save.
    // The entrypoint's durable owner ledger retires the old pin after save;
    // without that ledger the command must conservatively retain it.
    assert.deepEqual((await checkpointRefs(repo)).sort(), [
      "refs/pi-review-gate/checkpoints/continue-window/base",
      "refs/pi-review-gate/checkpoints/continue-previous-response/base",
      `refs/pi-review-gate/checkpoints/${current.descriptor.checkpoint.windowId}/base`,
    ].sort());
  } finally { await rm(repo, { recursive: true, force: true }); }
});
test("unified Git checkpoint baseline settles without a workspace snapshot", async () => {
  const repo = await initRepo();
  try {
    const captured = await captureReviewCheckpoint(repo, "unified-git-parent");
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;
    assert.equal(captured.value.kind, "git");
    await writeFile(join(repo, "index.ts"), "changed\n");
    const output = await runReview({
      cwd: repo, request: "change index", config,
      before: { kind: "checkpoint", descriptor: captured.value, cwd: repo, capturedAt: new Date().toISOString() },
    });
    assert.equal(output.result?.verdict, "needs_changes");
    assert.deepEqual(output.changes.map((change) => change.path), ["index.ts"]);
    assert.equal(output.reviewedBaseline?.kind, "checkpoint");
    assert.equal(output.reviewedBaseline?.kind === "checkpoint" ? output.reviewedBaseline.descriptor.kind : undefined, "git");
  } finally { await rm(repo, { recursive: true, force: true }); }
});
test("runReview settles a dirty Git baseline through one frozen after-checkpoint", async () => {
  const repo = await initRepo();
  try {
    // Dirty worktree at arm time: the checkpoint must capture it as baseline.
    await writeFile(join(repo, "dirty.txt"), "already dirty\n");
    const before = await armAt(repo, "w-dirty");

    await writeFile(join(repo, "index.ts"), "after\n");
    await writeFile(join(repo, "new.txt"), "added\n");

    const output = await runReview({
      cwd: repo,
      request: "change index",
      before: baselineOf(before, repo),
      config,
    });

    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "needs_changes");
    const byPath = new Map(output.changes.map((c) => [c.path, c]));
    assert.equal(byPath.get("index.ts")?.status, "modified");
    assert.equal(byPath.get("new.txt")?.status, "added");
    // The dirty-at-arm file is part of the baseline: not reported as changed.
    assert.equal(byPath.has("dirty.txt"), false);
    assert.equal(byPath.has("README.md"), false);

    // Ownership transferred: the frozen after-baseline is returned and its
    // pin stays in place (a later lifecycle slice owns save-before-release).
    assert.equal(output.reviewedBaseline?.kind, "git");
    const refs = await checkpointRefs(repo);
    assert.deepEqual(refs.sort(), [
      "refs/pi-review-gate/checkpoints/w-dirty/base",
      `refs/pi-review-gate/checkpoints/${(output.reviewedBaseline as { descriptor: GitCheckpointDescriptor }).descriptor.windowId}/base`,
    ].sort());
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("distinct Git window and exchange baselines compare against the same frozen after", async () => {
  const repo = await initRepo();
  try {
    // Baseline A: a.txt dirty at "v1".
    await writeFile(join(repo, "a.txt"), "v1\n");
    const descA = await armAt(repo, "w-a");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "second");
    // Baseline B: a.txt dirty at "v2" (a.txt changed between A and B).
    // Match the cached size/mtime exactly and age the live index. A newly
    // copied index would be newer and falsely consider this entry clean.
    await git(repo, "config", "core.trustctime", "false");
    const fixed = new Date((Math.floor(Date.now() / 1000) - 60) * 1000);
    await utimes(join(repo, "a.txt"), fixed, fixed);
    await git(repo, "add", "a.txt");
    const cached = await stat(join(repo, "a.txt"));
    await utimes(join(repo, ".git", "index"), new Date(cached.mtimeMs - 2000), new Date(cached.mtimeMs - 2000));
    await writeFile(join(repo, "a.txt"), "v2\n");
    await utimes(join(repo, "a.txt"), cached.atime, cached.mtime);
    assert.equal((await stat(join(repo, "a.txt"))).mtimeMs, cached.mtimeMs);
    const descB = await armAt(repo, "w-b");

    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    window.baseline = baselineOf(descA, repo);
    assert.ok(window.activeExchange);
    window.activeExchange.baseline = baselineOf(descB, repo);

    // After both baselines: a.txt untouched (still "v2"), c.txt added.
    await writeFile(join(repo, "c.txt"), "c\n");

    const output = await runReview({
      cwd: repo,
      request: "change c",
      before: window.baseline,
      config,
      window,
    });

    assert.equal(output.changed, true);
    // Window view (vs A): a.txt v1 -> v2 plus the new file.
    const windowPaths = output.changes.map((c) => c.path).sort();
    assert.deepEqual(windowPaths, ["a.txt", "c.txt"]);
    // Exchange view (vs B): only the new file — settled from the SAME frozen
    // after-checkpoint, not a second live inspection.
    const exchange = window.exchanges.at(-1);
    assert.ok(exchange, "the active exchange is completed by the review");
    assert.deepEqual(exchange.workspaceChanges.map((c) => c.path).sort(), ["c.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("binary, symlink, mode, and untracked changes are reviewed from the Git delta", async () => {
  const repo = await initRepo();
  try {
    if (process.platform !== "win32") {
      await writeFile(join(repo, "bin.dat"), randomBytes(64).toString("binary"));
      await symlink("README.md", join(repo, "link.lnk"));
      await writeFile(join(repo, "mode.txt"), "m\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "assets");
    }
    const before = await armAt(repo, "w-types");

    await writeFile(join(repo, "untracked.txt"), "new\n");
    if (process.platform !== "win32") {
      await writeFile(join(repo, "bin.dat"), randomBytes(64).toString("binary"));
      await rm(join(repo, "link.lnk"));
      await symlink("mode.txt", join(repo, "link.lnk"));
      await chmod(join(repo, "mode.txt"), 0o755);
    }

    const output = await runReview({
      cwd: repo,
      request: "mixed change types",
      before: baselineOf(before, repo),
      config,
    });

    assert.equal(output.changed, true);
    const byPath = new Map(output.changes.map((c) => [c.path, c]));
    assert.equal(byPath.get("untracked.txt")?.status, "added");
    if (process.platform !== "win32") {
      assert.equal(byPath.has("bin.dat"), true, "binary change is reviewable");
      assert.equal(byPath.has("link.lnk"), true, "symlink retarget is reviewable");
      assert.equal(byPath.has("mode.txt"), true, "mode-only change stays visible");
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("no-change Git review releases the orphan after pin", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-nochange");

    const output = await runReview({
      cwd: repo,
      request: "nothing changed",
      before: baselineOf(before, repo),
      config,
    });

    assert.equal(output.changed, false);
    assert.equal(output.noReviewReason, "no_initial_changes");
    assert.equal(output.reviewedBaseline, undefined);
    // The ephemeral after pin is released; only the window baseline remains.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-nochange/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("missing before pin fails closed without snapshot fallback or new state", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-missing");
    // Simulate a lost pin (e.g., manual ref deletion): the baseline can no
    // longer be verified.
    await git(repo, "update-ref", "-d", "refs/pi-review-gate/checkpoints/w-missing/base", before.base);

    await writeFile(join(repo, "index.ts"), "after\n");

    await assert.rejects(
      runReview({
        cwd: repo,
        request: "change index",
        before: baselineOf(before, repo),
        config,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /refusing to fall back to a workspace snapshot/);
        return true;
      },
    );
    // Verification precedes arming: no new checkpoint state was created.
    assert.deepEqual(await checkpointRefs(repo), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("corrupted before record fails closed on digest mismatch", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-corrupt");
    const recordPath = join(repo, ".git", "pi-review-gate", "checkpoints", "w-corrupt", `arm-${before.armId}`, "record.json");
    const original = await readFile(recordPath);
    await writeFile(recordPath, Buffer.concat([original, Buffer.from("x")]));

    await assert.rejects(
      runReview({
        cwd: repo,
        request: "change index",
        before: baselineOf(before, repo),
        config,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /refusing to fall back to a workspace snapshot/);
        return true;
      },
    );
    // The record is restored for recovery visibility; no new pin was armed.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-corrupt/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("collectPausedReviewExchange settles a Git exchange baseline and releases its pin", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-paused");

    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    window.baseline = baselineOf(before, repo);
    assert.ok(window.activeExchange);
    window.activeExchange.baseline = baselineOf(before, repo);

    await writeFile(join(repo, "file.txt"), "changed after pause\n");

    await collectPausedReviewExchange({ cwd: repo, config, window });

    const exchange = window.exchanges.at(-1);
    assert.ok(exchange, "the paused exchange is completed");
    assert.deepEqual(exchange.workspaceChanges.map((c) => c.path), ["file.txt"]);
    // Ephemeral after pin released after the artifacts were written.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-paused/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("runAskReviewer settles a Git baseline and releases its ephemeral pin", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-ask");

    await writeFile(join(repo, "index.ts"), "after\n");

    const output = await runAskReviewer({
      cwd: repo,
      question: "is this okay?",
      request: "ask about the change",
      before: baselineOf(before, repo),
      config,
    });

    assert.ok(output.result, "the reviewer answered");
    const byPath = new Map(output.changes.map((c) => [c.path, c]));
    assert.equal(byPath.get("index.ts")?.status, "modified");
    // A reviewer question never transfers ownership: the pin is released.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-ask/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("legacy raw snapshot input keeps existing settle semantics through the union", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-git-legacy-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n");

    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
    });

    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "needs_changes");
    assert.equal(output.reviewedBaseline?.kind, "snapshot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("post-arm settle failure releases the ephemeral after pin", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-invalid-limit");
    await writeFile(join(repo, "index.ts"), "after\n");

    // buildGitReviewDelta validates its limits and throws AFTER the checkpoint
    // is armed; the release guard must reclaim the freshly armed pin.
    await assert.rejects(
      runReview({
        cwd: repo,
        request: "change index",
        before: baselineOf(before, repo),
        config: { ...config, maxPatchBytes: Number.NaN },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid Git review limit: maxPatchBytes/);
        return true;
      },
    );
    // No orphan after pin: only the window baseline remains.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-invalid-limit/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("paused exchange settle failure releases the ephemeral after pin", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-paused-fail");

    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    window.baseline = baselineOf(before, repo);
    assert.ok(window.activeExchange);
    window.activeExchange.baseline = baselineOf(before, repo);

    await writeFile(join(repo, "file.txt"), "changed after pause\n");
    // Force the artifact write to fail: bundleDir points at a regular file.
    const blocker = join(repo, "bundle-blocker");
    await writeFile(blocker, "x\n");
    window.bundleDir = blocker;

    await assert.rejects(
      collectPausedReviewExchange({ cwd: repo, config, window }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        return true;
      },
    );
    // The ephemeral after pin was released despite the artifact failure.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-paused-fail/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});


test("a completed Git pass transfers after-baseline ownership to the response exchange", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-handoff");
    await writeFile(join(repo, "index.ts"), "after\n");

    const state = createState();
    beginAgentRun(state);
    const window = state.reviewWindow!;
    window.baseline = baselineOf(before, repo);

    const output = await runReview({
      cwd: repo,
      request: "change index",
      before: window.baseline,
      config,
      window,
    });
    assert.equal(output.changed, true);
    const reviewed = output.reviewedBaseline;
    assert.ok(reviewed);
    assert.equal(reviewed.kind, "git");
    const afterWindowId = reviewed.kind === "git" ? reviewed.descriptor.windowId : "";
    assert.ok(afterWindowId);

    // Handoff contract: the caller records the returned after-baseline on the
    // response exchange; from then on the pin is owned by persisted state and
    // must survive (no release in this path).
    recordReviewerFeedbackAndArmExchange(state, {
      result: output.result!,
      reviewerResults: output.reviewerResults,
      reviewSequence: output.reviewSequence,
      source: "manual",
      disposition: "sent_for_correction",
      reviewedBaseline: reviewed,
    });
    const exchange = state.reviewWindow!.activeExchange;
    assert.ok(exchange);
    assert.equal(exchange.baseline?.kind, "git");
    assert.equal(
      exchange.baseline?.kind === "git" ? exchange.baseline.descriptor.windowId : undefined,
      afterWindowId,
    );
    const refs = await checkpointRefs(repo);
    assert.ok(refs.includes(`refs/pi-review-gate/checkpoints/${afterWindowId}/base`));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("ask-reviewer evidence failure after settlement releases the ephemeral after pin", async () => {
  const repo = await initRepo();
  try {
    const before = await armAt(repo, "w-evidence-fail");
    await writeFile(join(repo, "index.ts"), "after\n");

    // Make candidate iteration throw: a deterministic evidence-collection
    // failure that occurs AFTER the after-checkpoint has been armed.
    const evidence = createEvidenceState();
    Object.defineProperty(evidence.candidates, "values", {
      value: () => { throw new Error("synthetic evidence collection failure"); },
    });

    await assert.rejects(
      runAskReviewer({
        cwd: repo,
        question: "is this okay?",
        request: "ask about the change",
        before: baselineOf(before, repo),
        config,
        evidence,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /synthetic evidence collection failure/);
        return true;
      },
    );
    // No orphan after pin: only the window baseline remains.
    assert.deepEqual(await checkpointRefs(repo), ["refs/pi-review-gate/checkpoints/w-evidence-fail/base"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
