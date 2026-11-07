/**
 * #617: a deliberate cancellation while the parent review settles its
 * after-checkpoint evidence is an expected review lifecycle outcome, not an
 * extension failure. The tests below use real Git checkpoints, real process
 * cancellation, the real review-turn coordinator and real evidence state.
 *
 * POSIX `git` wrappers only pause specific owned production-child boundaries:
 * the after-checkpoint `git diff`, a published pin's delayed close, and the
 * pin-reconciliation generation probe. They are deterministic timing fixtures,
 * not replacements for capture, comparison, settlement, cleanup, or
 * cancellation transitions.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createReviewTurnCoordinator } from "../src/activation/review-turn";
import { armGitCheckpoint, loadGitCheckpoint } from "../src/git-checkpoint";
import * as capture from "../src/capture";
import { recordToolCallEvidence, recordToolResultEvidence } from "../src/evidence";
import { runAskReviewer, runReview } from "../src/review";
import {
  captureReviewCheckpoint,
  loadReviewCheckpoint,
  releaseReviewCheckpoint,
  type ReviewCheckpointScope,
} from "../src/review-checkpoint";
import * as checkpoints from "../src/review-checkpoint";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import {
  beginAgentRun,
  createState,
  hasUnresolvedReview,
  recordReviewerFeedback,
  rememberUserRequest,
  setReviewWindowCheckpointBaseline,
  type ReviewBaseline,
  type UnifiedReviewBaseline,
} from "../src/state";
import { disposableAgentDir, testCheckpointScope } from "./checkpoint-scope-helpers";
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
const posixOnly = { skip: process.platform === "win32" };

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, env: GIT_ENV });
  return stdout;
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "prg-abort-recovery-"));
  try {
    await git(repo, "init", "-q");
    await writeFile(join(repo, "base.txt"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    // Checkpoint roots are canonical. Keep candidates in that same namespace
    // so a symlinked temporary root cannot accidentally test outside-file capture.
    return await realpath(repo);
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    throw error;
  }
}

async function checkpointRefs(repo: string): Promise<string[]> {
  const out = await git(repo, "for-each-ref", "--format=%(refname)", "refs/pi-review-gate/checkpoints/");
  return out.trim() ? out.trim().split("\n") : [];
}

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

async function lineCount(path: string): Promise<number> {
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).length; } catch { return 0; }
}

/** The issue's real after-checkpoint capture calls `git diff --binary`.
 * Pause exactly there until the test asks the owning review to cancel. */
async function blockAfterCheckpointDiff() {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperRoot = await mkdtemp(join(tmpdir(), "prg-git-wrapper-"));
  const bin = join(wrapperRoot, "bin");
  const state = join(wrapperRoot, "state");
  await mkdir(bin);
  await mkdir(state);
  const started = join(state, "started");
  const passthrough = join(state, "passthrough");
  const release = join(state, "release");
  await writeFile(join(bin, "git"), [
    "#!/bin/sh",
    "has_diff=0; has_binary=0",
    "for arg in \"$@\"; do",
    "  [ \"$arg\" = \"diff\" ] && has_diff=1",
    "  [ \"$arg\" = \"--binary\" ] && has_binary=1",
    "done",
    "if [ \"$has_diff\" = 1 ] && [ \"$has_binary\" = 1 ] && [ ! -f '" + passthrough + "' ]; then",
    "  printf '%s\\n' \"$$\" >> '" + started + "'",
    "  while [ ! -f '" + release + "' ]; do sleep 0.02; done",
    "fi",
    `exec '${realGit}' "$@"`,
  ].join("\n"), "utf8");
  await chmod(join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return {
    started,
    passthrough,
    async close() {
      try { writeFileSync(release, "release"); } catch { /* fixture cleanup is best-effort */ }
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(wrapperRoot, { recursive: true, force: true });
    },
  };
}

function reviewerConfig(promptPath: string, invocationPath: string) {
  return fakeNeedsChangesConfig({
    retainBundles: "never",
    externalAgents: {
      "recovery-pass": {
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
        review: {
          args: ["-e", [
            "const fs=require('node:fs');let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            `fs.appendFileSync(${JSON.stringify(invocationPath)},'ran\\n');`,
            `fs.writeFileSync(${JSON.stringify(promptPath)},input);`,
            "process.stdout.write(JSON.stringify({verdict:'pass',summary:'cumulative work reviewed',findings:[]}));",
            "});",
          ].join("")],
          timeoutMs: 15000,
        },
      },
    },
    review: { activeReviewers: [{ source: "external", id: "recovery-pass" }] },
  });
}

async function unifiedBaseline(repo: string, scope: ReviewCheckpointScope): Promise<UnifiedReviewBaseline> {
  const captured = await captureReviewCheckpoint(repo, `baseline-${randomUUID()}`, { scope });
  assert.equal(captured.status, "ok", JSON.stringify(captured));
  if (captured.status !== "ok") throw new Error("baseline capture failed");
  return { kind: "checkpoint", descriptor: captured.value, cwd: repo, capturedAt: new Date().toISOString() };
}

function baselineRef(baseline: UnifiedReviewBaseline): string {
  if (baseline.descriptor.kind !== "git") throw new Error("expected a Git checkpoint baseline");
  return baseline.descriptor.checkpoint.ref;
}

function reviewerRan(marker: string): Promise<boolean> { return exists(marker); }

/** A window already on retained Tools-only evidence, eligible for recovery. */
function toolWindow(cwd: string) {
  const state = createState();
  rememberUserRequest(state, "recover retained tool evidence");
  beginAgentRun(state);
  const baseline: ReviewBaseline = { kind: "tool", cwd, capturedAt: new Date().toISOString() };
  setReviewWindowCheckpointBaseline(state, baseline);
  return { state, window: state.reviewWindow!, baseline };
}

/** A checkpoint window with one retained write candidate for settle tests. */
async function checkpointWindowWithWrite(
  repo: string,
  scope: ReviewCheckpointScope,
  limits: { maxFileBytes: number; maxSnapshotBytes: number },
  name: string,
  content: string,
) {
  const state = createState();
  rememberUserRequest(state, "review a candidate capture");
  beginAgentRun(state);
  const baseline = await unifiedBaseline(repo, scope);
  setReviewWindowCheckpointBaseline(state, baseline);
  const window = state.reviewWindow!;
  const exchangeSequence = window.activeExchange!.sequence;
  const write = { toolName: "write", toolInput: { path: name, content } };
  await recordToolCallEvidence({ state: window.evidence, cwd: repo, ...write, snapshotOptions: limits, exchangeSequence });
  await writeFile(join(repo, name), content);
  recordToolResultEvidence({ state: window.evidence, ...write, result: { content: [{ type: "text", text: `Wrote ${name}` }] }, exchangeSequence });
  return { state, window, baseline };
}

test("pre-signaled review cancellation returns the owned aborted lifecycle without spawning a reviewer", async () => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "pre-signaled-review");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const baseline = await unifiedBaseline(repo, scope);
    const refsBefore = await checkpointRefs(repo);
    await writeFile(join(repo, "changed.txt"), "pre-signaled change\n");
    const controller = new AbortController();
    controller.abort("escape");
    const output = await runReview({
      cwd: repo,
      request: "review the cancelled prompt",
      before: baseline,
      config,
      signal: controller.signal,
    });
    assert.equal(output.changed, true, "the existing aborted convention remains changed:true");
    assert.deepEqual(output.changes, []);
    assert.equal(output.result?.error, "aborted");
    assert.equal(output.result?.processSettlement, "confirmed");
    assert.equal(output.reviewerResults, undefined, "no reviewer verdict is invented");
    assert.equal(output.reviewedBaseline, undefined, "no reviewed baseline or certificate is promoted");
    assert.equal(output.bundleDir, undefined);
    assert.equal(output.bundleRetained, false);
    assert.equal(await reviewerRan(invocationPath), false, "a pre-signaled review never launches a reviewer");
    assert.deepEqual(await checkpointRefs(repo), refsBefore, "no after-checkpoint pin is created");
    assert.equal((await loadReviewCheckpoint(repo, baseline.descriptor, { scope })).status, "ok", "the original baseline remains loadable");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("an in-flight abort during the after-checkpoint Git diff returns aborted and releases its owned pin", { ...posixOnly, timeout: 20000 }, async () => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "in-flight-capture-abort");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  let wrapper: Awaited<ReturnType<typeof blockAfterCheckpointDiff>> | undefined;
  try {
    const baseline = await unifiedBaseline(repo, scope);
    const refsBefore = await checkpointRefs(repo);
    await writeFile(join(repo, "changed.txt"), "in-flight change\n");
    wrapper = await blockAfterCheckpointDiff();
    const controller = new AbortController();
    const pending = runReview({
      cwd: repo,
      request: "review the in-flight cancelled prompt",
      before: baseline,
      config,
      signal: controller.signal,
    });
    await until(async () => (await lineCount(wrapper!.started)) >= 1, "after-checkpoint git diff reached");
    controller.abort("escape");
    const output = await pending;
    assert.equal(output.result?.error, "aborted");
    assert.equal(output.result?.processSettlement, "confirmed");
    assert.equal(output.reviewerResults, undefined);
    assert.equal(output.reviewedBaseline, undefined);
    assert.equal(output.bundleDir, undefined);
    assert.equal(await reviewerRan(invocationPath), false, "cancellation precedes reviewer launch");
    assert.deepEqual(await checkpointRefs(repo), refsBefore, "the cancelled after-checkpoint arm leaves no pin");
    assert.equal((await loadReviewCheckpoint(repo, baseline.descriptor, { scope })).status, "ok", "the original baseline is unaffected");
  } finally {
    await wrapper?.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test("an in-flight abort during a legacy Git after-checkpoint returns aborted", { ...posixOnly, timeout: 20000 }, async () => {
  const repo = await initRepo();
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  let wrapper: Awaited<ReturnType<typeof blockAfterCheckpointDiff>> | undefined;
  try {
    const armed = await armGitCheckpoint(repo, `legacy-baseline-${randomUUID()}`);
    assert.equal(armed.status, "ok", JSON.stringify(armed));
    if (armed.status !== "ok") return;
    const baseline: ReviewBaseline = { kind: "git", descriptor: armed.value.descriptor, cwd: repo, capturedAt: new Date().toISOString() };
    await writeFile(join(repo, "changed.txt"), "legacy in-flight change\n");
    wrapper = await blockAfterCheckpointDiff();
    const controller = new AbortController();
    const pending = runReview({ cwd: repo, request: "review legacy cancelled prompt", before: baseline, config, signal: controller.signal });
    await until(async () => (await lineCount(wrapper!.started)) >= 1, "legacy after-checkpoint git diff reached");
    controller.abort("escape");
    const output = await pending;
    assert.equal(output.result?.error, "aborted");
    assert.equal(output.result?.processSettlement, "confirmed");
    assert.equal(output.reviewerResults, undefined);
    assert.equal(output.reviewedBaseline, undefined);
    assert.equal(output.bundleDir, undefined);
    assert.equal(await reviewerRan(invocationPath), false);
    assert.deepEqual(await checkpointRefs(repo), [baseline.descriptor.ref]);
    assert.equal((await loadGitCheckpoint(repo, armed.value.descriptor)).status, "ok");
  } finally {
    await wrapper?.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test("an in-flight abort while settling a reviewer question returns the existing aborted answer", { ...posixOnly, timeout: 20000 }, async () => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "ask-in-flight-abort");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  let wrapper: Awaited<ReturnType<typeof blockAfterCheckpointDiff>> | undefined;
  try {
    const baseline = await unifiedBaseline(repo, scope);
    const refsBefore = await checkpointRefs(repo);
    await writeFile(join(repo, "changed.txt"), "question change\n");
    wrapper = await blockAfterCheckpointDiff();
    const controller = new AbortController();
    const pending = runAskReviewer({
      cwd: repo,
      checkpointScope: scope,
      question: "is this safe?",
      request: "review the cancelled question",
      before: baseline,
      config,
      signal: controller.signal,
    });
    await until(async () => (await lineCount(wrapper!.started)) >= 1, "question after-checkpoint git diff reached");
    controller.abort("manual");
    const output = await pending;
    assert.equal(output.result?.error, "aborted");
    assert.equal(output.result?.processSettlement, "confirmed");
    assert.deepEqual(output.changes, []);
    assert.equal(output.reviewerResults, undefined);
    assert.equal(output.bundleDir, undefined);
    assert.equal(output.bundleRetained, false);
    assert.equal(await reviewerRan(invocationPath), false, "cancellation precedes reviewer launch");
    assert.deepEqual(await checkpointRefs(repo), refsBefore, "the cancelled question leaves no after pin");
    assert.equal((await loadReviewCheckpoint(repo, baseline.descriptor, { scope })).status, "ok");
  } finally {
    await wrapper?.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test("raw checkpoint capture and load keep their abort classification without a Git child", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-raw-abort-"));
  const scope = testCheckpointScope(disposableAgentDir(), "raw-abort");
  try {
    await writeFile(join(root, "raw.txt"), "before\n");
    const captured = await captureReviewCheckpoint(root, "raw-abort-window", { scope });
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok") return;
    const controller = new AbortController();
    controller.abort("escape");
    const recapture = await captureReviewCheckpoint(root, "raw-abort-window-2", { scope, signal: controller.signal });
    assert.equal(recapture.status, "failed");
    if (recapture.status === "failed") assert.equal(recapture.reason, "aborted");
    const loaded = await loadReviewCheckpoint(root, captured.value, { scope, signal: controller.signal });
    assert.equal(loaded.status, "failed");
    if (loaded.status === "failed") assert.equal(loaded.reason, "aborted");
    assert.equal((await loadReviewCheckpoint(root, captured.value, { scope })).status, "ok", "the pre-abort record is unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a string-reason cancellation during candidate freezing follows the aborted lifecycle", { timeout: 15000 }, async (t) => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "candidate-freeze-abort");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const { window, baseline } = await checkpointWindowWithWrite(
      repo, scope, { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes },
      "candidate.txt", "candidate change\n",
    );
    const controller = new AbortController();
    const realSnapshot = capture.createPathSnapshot;
    let snapshots = 0;
    t.mock.method(capture, "createPathSnapshot", async (...args: Parameters<typeof realSnapshot>) => {
      const result = await realSnapshot(...args);
      snapshots += 1;
      controller.abort("escape");
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      throw error;
    });
    const output = await runReview({
      cwd: repo, request: "candidate freeze cancellation", before: baseline, window, config,
      evidence: window.evidence, signal: controller.signal,
    });
    assert.equal(snapshots, 1, "the real candidate snapshot ran before the cancellation");
    assert.equal(output.result?.error, "aborted");
    assert.deepEqual(output.changes, []);
    assert.equal(output.reviewedBaseline, undefined);
    assert.equal(await reviewerRan(invocationPath), false);
    assert.equal(window.baseline, baseline);
    assert.equal(window.activeExchange?.baseline, baseline);
    assert.deepEqual(await checkpointRefs(repo), [baselineRef(baseline)], "no after-checkpoint pin is created");
    assert.equal((await loadReviewCheckpoint(repo, baseline.descriptor, { scope })).status, "ok");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a genuine candidate-capture failure racing abort stays visible", { timeout: 15000 }, async (t) => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "candidate-freeze-failure");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const { window, baseline } = await checkpointWindowWithWrite(
      repo, scope, { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes },
      "candidate.txt", "candidate change\n",
    );
    const controller = new AbortController();
    const realSnapshot = capture.createPathSnapshot;
    t.mock.method(capture, "createPathSnapshot", async (...args: Parameters<typeof realSnapshot>) => {
      await realSnapshot(...args);
      controller.abort("escape");
      throw new Error("fixture candidate capture failure");
    });
    await assert.rejects(
      runReview({
        cwd: repo, request: "candidate freeze failure", before: baseline, window, config,
        evidence: window.evidence, signal: controller.signal,
      }),
      /fixture candidate capture failure/,
      "a concurrent abort must not mask a genuine candidate failure",
    );
    assert.equal(await reviewerRan(invocationPath), false);
    assert.equal(window.baseline, baseline);
    assert.equal(window.activeExchange?.baseline, baseline);
    assert.deepEqual(await checkpointRefs(repo), [baselineRef(baseline)]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a post-capture tool recovery cancellation releases the staged checkpoint and preserves original bases", { timeout: 15000 }, async (t) => {
  const repo = await initRepo();
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const { window, baseline: tool } = toolWindow(repo);
    const controller = new AbortController();
    const realCapture = checkpoints.captureReviewCheckpoint;
    t.mock.method(checkpoints, "captureReviewCheckpoint", async (...args: Parameters<typeof realCapture>) => {
      const result = await realCapture(...args);
      if (result.status === "ok") controller.abort("escape");
      return result;
    });
    const output = await runReview({
      cwd: repo,
      request: "cancelled recovery",
      before: tool,
      window,
      config,
      signal: controller.signal,
      evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" },
    });
    assert.equal(output.changed, true);
    assert.equal(output.result?.error, "aborted");
    assert.deepEqual(output.changes, []);
    assert.equal(output.reviewedBaseline, undefined);
    assert.equal(output.bundleDir, undefined);
    assert.equal(await reviewerRan(invocationPath), false);
    assert.equal(window.baseline, tool, "the original window tool baseline is preserved");
    assert.equal(window.activeExchange?.baseline, tool, "the original exchange tool baseline is preserved");
    assert.deepEqual(await checkpointRefs(repo), [], "the untransferred recovered checkpoint is released");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("cancellation during the recovery warning releases the staged capture without promoting it", { timeout: 15000 }, async () => {
  const repo = await initRepo();
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const { window, baseline: tool } = toolWindow(repo);
    const controller = new AbortController();
    let warnings = 0;
    const output = await runReview({
      cwd: repo,
      request: "warning-time cancellation",
      before: tool,
      window,
      config,
      signal: controller.signal,
      evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" },
      notify: () => {
        warnings += 1;
        controller.abort("escape");
      },
    });
    assert.equal(warnings, 1, "the real recovery warning ran");
    assert.equal(output.result?.error, "aborted");
    assert.equal(output.reviewedBaseline, undefined);
    assert.equal(window.baseline, tool, "cancellation during the warning never promotes the recovered basis");
    assert.equal(window.activeExchange?.baseline, tool);
    assert.deepEqual(await checkpointRefs(repo), [], "the staged capture is released");
    assert.equal(await reviewerRan(invocationPath), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("primary recovery-warning cancellation restores original bases and releases the recovered pin", { timeout: 15000 }, async () => {
  const repo = await initRepo();
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  let state: ReturnType<typeof createState> | undefined;
  try {
    const opened = toolWindow(repo);
    state = opened.state;
    const { window, baseline: tool } = opened;
    window.nextReviewSequence = 2;
    recordReviewerFeedback(state, {
      result: { reviewerId: "gate", verdict: "needs_changes", summary: "an earlier review left this work unresolved", findings: [] },
      source: "automatic",
      disposition: "sent_for_correction",
      reviewSequence: 1,
    });
    assert.equal(hasUnresolvedReview(window), true);
    const originalExchange = window.activeExchange;
    const originalExchangeCount = window.exchanges.length;
    const originalRequestIndex = window.nextExchangeRequestIndex;
    await writeFile(join(repo, "primary-recovery.txt"), "primary recovery change\n");
    const controller = new AbortController();
    let recoveryWarnings = 0;
    const output = await runReview({
      cwd: repo,
      request: "primary recovery warning cancellation",
      before: tool,
      window,
      config,
      signal: controller.signal,
      evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "primary" },
      notify: (message) => {
        if (message.includes("Snapshot capture recovered")) {
          recoveryWarnings += 1;
          controller.abort("escape");
        }
      },
    });
    assert.equal(recoveryWarnings, 1, "the real delayed Primary recovery warning ran");
    assert.equal(output.result?.error, "aborted");
    assert.deepEqual(output.changes, []);
    assert.equal(output.reviewedBaseline, undefined);
    assert.equal(output.bundleDir, undefined, "the cancelled recovery exposes no partial review bundle");
    assert.equal(window.baseline, tool, "the original window tool baseline is preserved");
    assert.equal(window.activeExchange, originalExchange, "rollback restores the original active exchange, not a replacement");
    assert.equal(window.activeExchange?.baseline, tool, "the original exchange tool baseline is preserved");
    assert.equal(window.exchanges.length, originalExchangeCount, "the cancelled staged exchange is not recorded as complete");
    assert.equal(window.nextExchangeRequestIndex, originalRequestIndex, "unsettled requests remain in the active exchange");
    assert.equal(window.reviewHistory.length, 1);
    assert.equal(hasUnresolvedReview(window), true);
    assert.deepEqual(await checkpointRefs(repo), [], "the recovered after-checkpoint is released");
    assert.equal(await reviewerRan(invocationPath), false);
  } finally {
    const bundleDir = state?.reviewWindow?.bundleDir;
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("recovery cancellation whose release fails stays visible and leaves the pin", { timeout: 15000 }, async (t) => {
  const repo = await initRepo();
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const { window, baseline: tool } = toolWindow(repo);
    const controller = new AbortController();
    const realCapture = checkpoints.captureReviewCheckpoint;
    t.mock.method(checkpoints, "captureReviewCheckpoint", async (...args: Parameters<typeof realCapture>) => {
      const result = await realCapture(...args);
      if (result.status === "ok") controller.abort("escape");
      return result;
    });
    let releases = 0;
    t.mock.method(checkpoints, "releaseReviewCheckpoint", async () => {
      releases += 1;
      return { status: "failed" as const, reason: "raw_checkpoint_failed" as const, detail: "fixture recovery release uncertainty" };
    });
    await assert.rejects(
      runReview({
        cwd: repo,
        request: "release failure recovery",
        before: tool,
        window,
        config,
        signal: controller.signal,
        evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" },
      }),
      /additionally failed to release the ephemeral after-checkpoint.*fixture recovery release uncertainty/,
      "an unconfirmed recovery release cannot be hidden by cancellation",
    );
    assert.equal(releases, 1);
    assert.equal(window.baseline, tool);
    assert.equal(window.activeExchange?.baseline, tool);
    assert.equal((await checkpointRefs(repo)).length, 1, "the release-uncertain recovered pin stays visible");
    assert.equal(await reviewerRan(invocationPath), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a normal unified-checkpoint review still passes and hands off its reviewed baseline", async () => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "normal-review");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  let reviewed: ReviewBaseline | undefined;
  try {
    const baseline = await unifiedBaseline(repo, scope);
    await writeFile(join(repo, "changed.txt"), "normal change\n");
    const output = await runReview({ cwd: repo, request: "review normal work", before: baseline, config });
    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "pass");
    assert.equal(await reviewerRan(invocationPath), true);
    assert.match(await readFile(promptPath, "utf8"), /normal change/);
    reviewed = output.reviewedBaseline;
    assert.equal(reviewed?.kind, "checkpoint");
    if (reviewed?.kind !== "checkpoint") throw new Error("expected a reviewed checkpoint baseline");
    assert.equal((await loadReviewCheckpoint(repo, reviewed.descriptor, { scope })).status, "ok");
    const released = await releaseReviewCheckpoint(repo, reviewed.descriptor, { scope });
    assert.equal(released.status, "ok");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a genuine Git baseline failure stays visible even when the same signal aborts", async (t) => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "genuine-git-failure");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const baseline = await unifiedBaseline(repo, scope);
    // Real damage: the owned pin is gone. loadGitCheckpoint fails genuinely.
    await git(repo, "update-ref", "-d", baselineRef(baseline));
    const refsBefore = await checkpointRefs(repo);
    await assert.rejects(
      runReview({ cwd: repo, request: "control failure", before: baseline, config }),
      /verifying baseline failed \(pin_ref_missing\)/,
      "the ordinary control still reports the real Git failure",
    );
    const controller = new AbortController();
    const realLoad = checkpoints.loadReviewCheckpoint;
    t.mock.method(checkpoints, "loadReviewCheckpoint", async (...args: Parameters<typeof realLoad>) => {
      const result = await realLoad(...args);
      controller.abort("escape");
      return result;
    });
    await assert.rejects(
      runReview({ cwd: repo, request: "concurrent failure", before: baseline, config, signal: controller.signal }),
      /verifying baseline failed \(pin_ref_missing\)/,
      "signal.aborted must never mask a genuine checkpoint cause",
    );
    assert.equal(await reviewerRan(invocationPath), false);
    assert.deepEqual(await checkpointRefs(repo), refsBefore, "neither path arms an after-checkpoint");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a release failure after a proven cancellation stays an extension-visible failure", async (t) => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "release-uncertainty");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  try {
    const baseline = await unifiedBaseline(repo, scope);
    await writeFile(join(repo, "changed.txt"), "release failure change\n");
    const controller = new AbortController();
    const realCompare = checkpoints.compareReviewCheckpoints;
    t.mock.method(checkpoints, "compareReviewCheckpoints", async (...args: Parameters<typeof realCompare>) => {
      const result = await realCompare(...args);
      if (result.status === "ok") controller.abort("escape");
      return result;
    });
    let releases = 0;
    t.mock.method(checkpoints, "releaseReviewCheckpoint", async () => {
      releases += 1;
      return { status: "failed" as const, reason: "raw_checkpoint_failed" as const, detail: "fixture owned release uncertainty" };
    });
    await assert.rejects(
      runReview({ cwd: repo, request: "release failure", before: baseline, config, signal: controller.signal }),
      /releasing after-checkpoint failed \(raw_checkpoint_failed\): fixture owned release uncertainty/,
      "a cancellation cannot hide an unconfirmed owned release",
    );
    assert.equal(releases, 1);
    assert.equal(await reviewerRan(invocationPath), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("cancelled pin creation reconciles a published generation-owned pin under the lock", { ...posixOnly, timeout: 20000 }, async () => {
  const repo = await initRepo();
  const wrapperRoot = await mkdtemp(join(tmpdir(), "prg-pin-publish-wrapper-"));
  const windowId = `pin-published-${randomUUID()}`;
  const ref = `refs/pi-review-gate/checkpoints/${windowId}/base`;
  const started = join(wrapperRoot, "started");
  const release = join(wrapperRoot, "release");
  try {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = join(wrapperRoot, "git");
    await writeFile(wrapper, [
      "#!/bin/sh",
      "has_update=0; has_pin=0; has_arm=0",
      "for arg in \"$@\"; do",
      "  [ \"$arg\" = \"update-ref\" ] && has_update=1",
      `  [ \"$arg\" = \"${ref}\" ] && has_pin=1`,
      "  case \"$arg\" in \"prg-git-checkpoint arm-\"*) has_arm=1;; esac",
      "done",
      `if [ \"$has_update\" = 1 ] && [ \"$has_pin\" = 1 ] && [ \"$has_arm\" = 1 ] && [ ! -f '${started}' ]; then`,
      `  '${realGit}' \"$@\" || exit $?`,
      `  printf 'published\\n' > '${started}'`,
      `  while [ ! -f '${release}' ]; do sleep 0.02; done`,
      "  exit 0",
      "fi",
      `exec '${realGit}' \"$@\"`,
    ].join("\n"), "utf8");
    await chmod(wrapper, 0o755);
    const controller = new AbortController();
    const pending = armGitCheckpoint(repo, windowId, { gitPath: wrapper, signal: controller.signal, timeoutMs: 10000 });
    await until(() => exists(started), "pin update-ref published and close delayed");
    assert.ok((await git(repo, "for-each-ref", "--format=%(refname)")).includes(ref), "the real update-ref published this arm's pin");
    controller.abort("escape");
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.reason, "aborted");
      assert.notEqual(result.reason, "cleanup_unconfirmed", "successful generation-proof reconciliation stays an expected cancellation");
    }
    assert.deepEqual(await checkpointRefs(repo), [], "the published pin is removed after cancellation");
  } finally {
    try { writeFileSync(release, "release"); } catch { /* fixture cleanup is best-effort */ }
    await rm(wrapperRoot, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("unconfirmable pin-creation reconciliation stays a visible cleanup failure", { ...posixOnly, timeout: 20000 }, async () => {
  const repo = await initRepo();
  const wrapperRoot = await mkdtemp(join(tmpdir(), "prg-pin-reconcile-wrapper-"));
  const windowId = `pin-unconfirmed-${randomUUID()}`;
  const ref = `refs/pi-review-gate/checkpoints/${windowId}/base`;
  const started = join(wrapperRoot, "started");
  const blockLog = join(wrapperRoot, "block-log");
  const release = join(wrapperRoot, "release");
  try {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = join(wrapperRoot, "git");
    await writeFile(wrapper, [
      "#!/bin/sh",
      "has_update=0; has_pin=0; has_arm=0; has_log=0; has_ref=0",
      "for arg in \"$@\"; do",
      "  [ \"$arg\" = \"update-ref\" ] && has_update=1",
      "  [ \"$arg\" = \"log\" ] && has_log=1",
      `  [ \"$arg\" = \"${ref}\" ] && { has_pin=1; has_ref=1; }`,
      "  case \"$arg\" in \"prg-git-checkpoint arm-\"*) has_arm=1;; esac",
      "done",
      `if [ \"$has_update\" = 1 ] && [ \"$has_pin\" = 1 ] && [ \"$has_arm\" = 1 ] && [ ! -f '${started}' ]; then`,
      `  '${realGit}' \"$@\" || exit $?`,
      `  printf 'published\\n' > '${started}'`,
      `  while [ ! -f '${release}' ]; do sleep 0.02; done`,
      "  exit 0",
      "fi",
      `if [ \"$has_log\" = 1 ] && [ \"$has_ref\" = 1 ] && [ -f '${blockLog}' ]; then`,
      `  while [ ! -f '${release}' ]; do sleep 0.02; done`,
      "fi",
      `exec '${realGit}' \"$@\"`,
    ].join("\n"), "utf8");
    await chmod(wrapper, 0o755);
    const controller = new AbortController();
    const pending = armGitCheckpoint(repo, windowId, { gitPath: wrapper, signal: controller.signal, timeoutMs: 3000 });
    await until(() => exists(started), "pin update-ref published and close delayed");
    // The reconciliation generation probe is the next step; hold it past the
    // operation deadline so absence/removal cannot be positively confirmed.
    await writeFile(blockLog, "block", "utf8");
    controller.abort("escape");
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.reason, "cleanup_unconfirmed");
      assert.match(result.detail ?? "", /pin absence or removal was not confirmed/);
    }
    assert.ok((await checkpointRefs(repo)).some((entry) => entry === ref), "the unconfirmed published pin stays visible");
  } finally {
    try { writeFileSync(release, "release"); } catch { /* fixture cleanup is best-effort */ }
    await rm(wrapperRoot, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("unconfirmed arm cleanup after abort is a visible cleanup failure, not an expected cancellation", { timeout: 15000 }, async () => {
  const repo = await initRepo();
  const windowId = "window-cleanup-unconfirmed";
  try {
    const controller = new AbortController();
    // Hold the real per-window pin lock from the fault seam onwards, so the
    // arm's own abort cleanup cannot acquire it and cannot positively confirm
    // pin/scratch removal. No cleanup function is replaced.
    const lock = join(repo, ".git", "pi-review-gate", "checkpoint-pin-locks", windowId);
    const result = await armGitCheckpoint(repo, windowId, {
      signal: controller.signal,
      timeoutMs: 2000,
      faultHooks: {
        betweenPatchCaptures: async () => {
          await mkdir(lock, { recursive: true });
          controller.abort("escape");
        },
      },
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.reason, "cleanup_unconfirmed");
      assert.match(result.detail ?? "", /cleanup was not confirmed/);
      assert.notEqual(result.reason, "aborted");
    }
    const refs = await checkpointRefs(repo);
    assert.ok(refs.some((ref) => ref.includes(windowId)), "the unconfirmed pin remains visible for recovery");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("repeated cancelled prompts followed by a completed review preserve the cumulative baseline, evidence, and obligations", { ...posixOnly, timeout: 30000 }, async (t) => {
  const repo = await initRepo();
  const scope = testCheckpointScope(disposableAgentDir(), "coordinator-recovery");
  const promptPath = join(repo, "prompt.md");
  const invocationPath = join(repo, "reviewer-invocations.log");
  const config = reviewerConfig(promptPath, invocationPath);
  const cancellation = createReviewCancellationCoordinator();
  const state = createState();
  const notices: string[] = [];
  const terminalHandlers = new Set<(input: string) => unknown>();
  const sent: string[] = [];
  const ctx = {
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus() {},
      onTerminalInput(handler: (input: string) => unknown) {
        terminalHandlers.add(handler);
        return () => { terminalHandlers.delete(handler); };
      },
    },
  };
  const pi = {
    registerCommand() {},
    sendUserMessage(message: string) { sent.push(message); },
  };
  let wrapper: Awaited<ReturnType<typeof blockAfterCheckpointDiff>> | undefined;
  let coordinator: ReturnType<typeof createReviewTurnCoordinator> | undefined;
  try {
    rememberUserRequest(state, "finish the cumulative change");
    beginAgentRun(state);
    const baseline = await unifiedBaseline(repo, scope);
    setReviewWindowCheckpointBaseline(state, baseline);
    const window = state.reviewWindow!;
    window.nextReviewSequence = 2;
    recordReviewerFeedback(state, {
      result: { reviewerId: "gate", verdict: "needs_changes", summary: "an earlier review left this work unresolved", findings: [] },
      source: "automatic",
      disposition: "sent_for_correction",
      reviewSequence: 1,
    });
    // This prompt is the model's correction response to review 1, exactly as
    // a real needs_changes settlement would have armed it.
    window.activeExchange!.causedByReviewSequence = 1;
    window.activeExchange!.causedByReviewVerdict = "needs_changes";
    window.activeExchange!.reviewResponseMode = "correction";
    assert.equal(hasUnresolvedReview(window), true);
    const snapshotOptions = { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes };
    const exchangeSequence = window.activeExchange!.sequence;
    const recordWrite = async (name: string, content: string) => {
      const write = { toolName: "write", toolInput: { path: name, content } };
      await recordToolCallEvidence({ state: window.evidence, cwd: repo, ...write, snapshotOptions, exchangeSequence });
      await writeFile(join(repo, name), content);
      recordToolResultEvidence({ state: window.evidence, ...write, result: { content: [{ type: "text", text: `Wrote ${name}` }] }, exchangeSequence });
    };

    coordinator = createReviewTurnCoordinator({
      pi, state, config, cancellation, scopedModels: () => [], isSessionActive: () => true,
      observeCwd() {}, cwd: () => repo, syncExecutionContext() {}, checkpointRestartBlocked: () => undefined,
      effectiveReviewConfig: () => config, persist: async () => {}, persistAutomaticDelivery: async () => true,
      backgroundShell: () => undefined, reviewReadiness: () => [], reapplyDeferredTools() {},
      orchestratorTurns: { hasRunsInFlight: () => false, noteMessageObserved: () => false, noteMessageArmingFailed() {} },
    });
    wrapper = await blockAfterCheckpointDiff();
    const baselineRefName = baselineRef(baseline);
    const captureSignals: AbortSignal[] = [];
    const realCapture = checkpoints.captureReviewCheckpoint;
    t.mock.method(checkpoints, "captureReviewCheckpoint", async (...args: Parameters<typeof realCapture>) => {
      const signal = args[2]?.signal;
      assert.ok(signal, "each settlement supplies its owning review signal");
      assert.equal(signal.aborted, false, "new capture never inherits a stale abort");
      captureSignals.push(signal);
      return realCapture(...args);
    });

    // Two distinct prompts each reach the after-checkpoint diff and are
    // cancelled there. Neither abort may clear, replace, or "settle" state.
    for (const [cycle, name, content] of [[1, "first.txt", "first pre-abort change\n"], [2, "second.txt", "second pre-abort change\n"]] as const) {
      const beforeEvents = window.evidence.events.length;
      const beforeCandidates = new Set(window.evidence.candidates.keys());
      const promptController = new AbortController();
      assert.equal(await coordinator.armAgentRun([{ signal: promptController.signal }, ctx]), "armed");
      assert.equal(window.baseline, baseline, "production prompt arming reuses the preserved window baseline");
      await recordWrite(name, content);
      const pending = coordinator.onAgentSettled([ctx]);
      await until(async () => (await lineCount(wrapper!.started)) >= cycle, `after-checkpoint diff ${cycle}`);
      const active = cancellation.current();
      assert.ok(active, "each prompt registers its own cancellation handle");
      active.requestCancel("escape");
      await pending;
      assert.equal(promptController.signal.aborted, false, "review cancellation never contaminates the next host prompt signal");
      assert.equal(captureSignals.length, cycle);
      assert.equal(captureSignals[cycle - 1]!.aborted, true, "only this settlement's owned signal was aborted");
      assert.equal(cancellation.current(), undefined, `cycle ${cycle} unregisters its handle`);
      assert.equal(state.reviewInProgress, false);
      assert.equal(state.reviewActivityToken, undefined, `cycle ${cycle} releases owned review activity`);
      assert.equal(terminalHandlers.size, 0, `cycle ${cycle} removes its terminal listener`);
      assert.equal(window.baseline, baseline, `cycle ${cycle} preserves the window baseline identity`);
      assert.equal(window.activeExchange?.baseline, baseline, `cycle ${cycle} preserves the active exchange baseline identity`);
      assert.equal(window.reviewHistory.length, 1, `cycle ${cycle} records no synthetic review`);
      assert.equal(hasUnresolvedReview(window), true, `cycle ${cycle} preserves outstanding prior feedback`);
      assert.equal(window.bundleDir, undefined, `cycle ${cycle} promotes no partial review bundle`);
      assert.ok(window.evidence.events.length > beforeEvents, `cycle ${cycle} retains new tool evidence`);
      for (const key of beforeCandidates) assert.ok(window.evidence.candidates.has(key), `cycle ${cycle} retains earlier candidates`);
      assert.ok(window.evidence.candidates.has(join(repo, name)), `cycle ${cycle} retains its candidate`);
      assert.deepEqual(await checkpointRefs(repo), [baselineRefName], `cycle ${cycle} leaves exactly the baseline pin`);
      assert.equal((await loadReviewCheckpoint(repo, baseline.descriptor, { scope })).status, "ok");
      assert.equal(notices.filter((message) => message.includes("cancelled;")).length, cycle);
      assert.match(notices.join("\n"), new RegExp(`review gate: review cancelled; reviewer processes stopped`));
      assert.doesNotMatch(notices.join("\n"), /Extension error|capturing after-checkpoint failed/);
      assert.equal(sent.length, 0, `cycle ${cycle} re-sends no cancelled input or error release`);
    }

    // A third prompt completes normally. The paused wrapper lets the real
    // after-checkpoint capture and the real reviewer run.
    await writeFile(wrapper.passthrough, "go", "utf8");
    const eventsBeforePass = window.evidence.events.length;
    const nextPromptController = new AbortController();
    assert.equal(await coordinator.armAgentRun([{ signal: nextPromptController.signal }, ctx]), "armed");
    await recordWrite("third.txt", "new post-abort change\n");
    await coordinator.onAgentSettled([ctx]);

    assert.equal(captureSignals.length, 3, "the next prompt obtains a new after-checkpoint through production settlement");
    assert.equal(new Set(captureSignals).size, 3, "each review owns a fresh controller, including repeated recovery");
    assert.equal(captureSignals[2]!.aborted, false);
    assert.equal(nextPromptController.signal.aborted, false);
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.equal(await reviewerRan(invocationPath), true, "the completed prompt launches the real reviewer");
    const prompt = await readFile(promptPath, "utf8");
    assert.match(prompt, /first\.txt/);
    assert.match(prompt, /first pre-abort change/);
    assert.match(prompt, /second\.txt/);
    assert.match(prompt, /second pre-abort change/);
    assert.match(prompt, /third\.txt/);
    assert.match(prompt, /new post-abort change/);
    assert.equal(window.baseline, baseline, "the completed review still reports against the original window baseline");
    assert.equal(window.reviewHistory.length, 2);
    assert.equal(window.reviewHistory.at(-1)?.verdict, "pass");
    assert.equal(hasUnresolvedReview(window), false);
    assert.deepEqual(
      window.exchanges.at(-1)?.workspaceChanges.map((change) => change.path).sort(),
      ["first.txt", "second.txt", "third.txt"],
      "the completed exchange carries every pre-abort and new change",
    );
    assert.ok(window.evidence.events.length > eventsBeforePass, "passing does not discard the retained evidence");
    assert.ok(window.evidence.candidates.has(join(repo, "first.txt")));
    assert.ok(window.evidence.candidates.has(join(repo, "second.txt")));
    assert.ok(window.evidence.candidates.has(join(repo, "third.txt")));
    const nextBaseline = window.activeExchange?.baseline;
    assert.equal(nextBaseline?.kind, "checkpoint");
    if (nextBaseline?.kind !== "checkpoint") throw new Error("expected a handed-off checkpoint baseline");
    assert.notEqual(nextBaseline.descriptor, baseline.descriptor, "the pass hands off the new reviewed after-checkpoint");
    assert.equal((await loadReviewCheckpoint(repo, nextBaseline.descriptor, { scope })).status, "ok");
    assert.equal(state.reviewInProgress, false);
    assert.equal(state.reviewActivityToken, undefined);
    assert.equal(terminalHandlers.size, 0);
    assert.equal(cancellation.current(), undefined);
    assert.equal(sent.length, 1, "only the completed pass is transmitted; cancelled prompts re-send nothing");
    assert.doesNotMatch(sent.join("\n"), /cancel/i);
  } finally {
    await wrapper?.close();
    await coordinator?.shutdownReview();
    if (state.reviewWindow?.bundleDir) await rm(state.reviewWindow.bundleDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
