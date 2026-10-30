import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { captureWaveBase, WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree, workerRefName } from "../src/execution/wave-worktrees";
import { reviewerProgressLabel, runWaveWorkerLifecycle, type WaveWorkerLifecycleResult } from "../src/execution/wave-worker-lifecycle";
import { buildWaveWorkerPrompt } from "../src/execution/wave-worker";
import type { ExecutorAdapter, ExecutorRequest } from "../src/execution/types";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import { buildSubtaskEvidence, readSubtaskEvidence } from "../src/execution/subtask-evidence";
import { normalizeConfig, type ActiveReviewerSelection, type ExternalAgentConfig, type ReviewGateConfig } from "../src/config";
import { agentCatalog } from "./helpers";
import type { WaveWorkerTask } from "../src/execution/wave-worker";

const factory = require("../src/execution/adapters/factory") as typeof import("../src/execution/adapters/factory");

// ── helpers ──────────────────────────────────────────────────────────────────

async function mkTmp(prefix: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function git(args: string[], cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const GIT_ENV = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function gitInRepo(args: string[], repoPath: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const GIT_ENV = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
  });
  return stdout.trim();
}

/** Create a committed source repo and capture it. */
async function setupCapture(artifactDir: string): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-wwl-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await writeFile(join(sourceDir, "app.js"), "console.log('hi');\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "test-wave",
    artifactDir,
  });
  return { sourceDir, capture };
}

function testTask(): WaveWorkerTask {
  return {
    title: "Test lifecycle task",
    instructions: "Create worker-output.txt with the requested content.",
    acceptanceCriteria: ["worker-output.txt exists with content"],
  };
}

/** Create a fake executor that writes a file and returns a response. */
async function createFakeExecutor(root: string, fileName = "worker-output.txt", content = "worker done", sessionId = "test-session-id"): Promise<{ command: string }> {
  const command = join(root, "fake-executor.cjs");
  await writeFile(command, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(fileName)}), ${JSON.stringify(content)} + '\\n');`,
    `console.log(JSON.stringify({ type: 'session', sessionId: ${JSON.stringify(sessionId)} }));`,
    "console.log(JSON.stringify({ type: 'assistant', text: 'Implemented the change.' }));",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

/** Create a fake executor that does nothing. */
async function createNoOpExecutor(root: string): Promise<{ command: string }> {
  const command = join(root, "noop-executor.cjs");
  await writeFile(command, [
    "console.log(JSON.stringify({ type: 'session', sessionId: 'noop-session' }));",
    "console.log(JSON.stringify({ type: 'assistant', text: 'No changes needed.' }));",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { command };
}

/** Build a config with a fake executor. */
const PASSING_REVIEWER_SCRIPT = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'all good',findings:[]})))";
const NEEDS_CHANGES_REVIEWER_SCRIPT = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'x.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))";
const ERRORING_REVIEWER_SCRIPT = "process.stdin.resume();process.stdin.on('end',()=>{throw new Error('reviewer crash');})";

function cliReviewerAgent(id: string, script: string, timeoutMs = 15_000): ExternalAgentConfig {
  return {
    id,
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: { args: ["-e", script], timeoutMs },
  };
}

function buildConfig(
  command: string,
  executorId = "fake-exec",
  extraAgents: ExternalAgentConfig[] = [],
  activeReviewers: ActiveReviewerSelection[] = [],
): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    execution: {
      workerResources: { "default": { selection: { source: "external", id: executorId }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    externalAgents: agentCatalog(
      {
        id: executorId,
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [command],
          timeoutMs: 15000,
        },
      },
      ...extraAgents,
    ),
    ...(activeReviewers.length > 0 ? { review: { activeReviewers } } : {}),
  });
}

/** Build a config with a passing reviewer. */
function buildPassingReviewerConfig(executorCommand: string): ReviewGateConfig {
  return buildConfig(
    executorCommand,
    "fake-exec",
    [cliReviewerAgent("passing", PASSING_REVIEWER_SCRIPT)],
    [{ source: "external", id: "passing" }],
  );
}

/** Build a config with a needs_changes reviewer. */
function buildNeedsChangesReviewerConfig(executorCommand: string): ReviewGateConfig {
  return buildConfig(
    executorCommand,
    "fake-exec",
    [cliReviewerAgent("blocking", NEEDS_CHANGES_REVIEWER_SCRIPT)],
    [{ source: "external", id: "blocking" }],
  );
}

/** Build a config with a reviewer that errors. */
function buildErrorReviewerConfig(executorCommand: string): ReviewGateConfig {
  return buildConfig(
    executorCommand,
    "fake-exec",
    [cliReviewerAgent("erroring", ERRORING_REVIEWER_SCRIPT)],
    [{ source: "external", id: "erroring" }],
  );
}

function buildPassWithReviewerErrorConfig(executorCommand: string): ReviewGateConfig {
  return buildConfig(
    executorCommand,
    "fake-exec",
    [
      cliReviewerAgent("passing", PASSING_REVIEWER_SCRIPT),
      cliReviewerAgent("erroring", ERRORING_REVIEWER_SCRIPT),
    ],
    [
      { source: "external", id: "passing" },
      { source: "external", id: "erroring" },
    ],
  );
}

/**
 * Reviewer that returns a scripted verdict per invocation and retains the
 * bundle it actually assessed. Used to prove a correction reached a real
 * subsequent review (rather than a status-only or self-approved claim).
 */
function scriptedReviewer(root: string, verdicts: Array<"pass" | "needs_changes">): ExternalAgentConfig {
  const script = [
    "const fs=require('node:fs');const path=require('node:path');",
    "let prompt='';process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',s=>prompt+=s);",
    "process.stdin.on('end',()=>{",
    "  const counter=process.env.REVIEW_COUNTER;",
    "  const call=(fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0)+1;",
    "  fs.writeFileSync(counter,String(call));",
    "  const verdicts=JSON.parse(process.env.REVIEW_VERDICTS);",
    "  const verdict=verdicts[call-1]??'pass';",
    "  const bundle=process.env.PI_REVIEW_GATE_BUNDLE_DIR;",
    "  if(bundle){",
    "    const reviews=fs.readdirSync(path.join(bundle,'reviews')).filter(d=>/^\\d+$/.test(d)).sort();",
    "    const dir=path.join(bundle,'reviews',reviews.at(-1));",
    "    fs.appendFileSync(process.env.REVIEW_PROOF,JSON.stringify({",
    "      call,verdict,prompt,",
    "      request:fs.readFileSync(path.join(dir,'request.md'),'utf8'),",
    "      evidence:JSON.parse(fs.readFileSync(path.join(dir,'evidence.json'),'utf8')),",
    "      patch:fs.readFileSync(path.join(dir,'patch.diff'),'utf8'),",
    "      markdown:fs.readFileSync(path.join(dir,'evidence.md'),'utf8'),",
    "    })+'\\n');",
    "  }",
    "  process.stdout.write(JSON.stringify(verdict==='pass'",
    "    ?{verdict,summary:'assessed retained evidence',findings:[]}",
    "    :{verdict,summary:'the corrected result must be revised again',findings:[{severity:'blocking',file:'result.md',line:null,issue:'the corrected result still needs revision',recommendation:'revise the result and re-report'}]}));",
    "});",
  ].join("\n");
  return {
    id: "scripted",
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", script],
      timeoutMs: 15_000,
      env: {
        REVIEW_COUNTER: join(root, "review-calls.txt"),
        REVIEW_VERDICTS: JSON.stringify(verdicts),
        REVIEW_PROOF: join(root, "review-proof.jsonl"),
      },
    },
  };
}

type ReviewerProof = {
  call: number;
  verdict: string;
  prompt: string;
  request: string;
  evidence: {
    events: Array<{ phase: string; toolName: string; summary: string; candidatePaths: string[] }>;
    candidates: Array<{
      path: string;
      externalSideEffect?: boolean;
      afterSnapshot?: { content?: string };
    }>;
    finalAssistantSummaries: string[];
    toolObservationRevision?: number;
    externalObservationRevision?: number;
    changedCandidatePaths: string[];
  };
  patch: string;
  markdown: string;
};

async function reviewerProof(root: string): Promise<ReviewerProof[]> {
  const text = await readFile(join(root, "review-proof.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReviewerProof);
}

/**
 * Install one synthetic structured-evidence executor adapter for the whole
 * lifecycle. Turns are numbered from 1; the action returns that turn's final
 * assistant report text.
 */
function installLifecycleAdapter(
  action: (request: ExecutorRequest, turn: number) => Promise<string>,
): { turns: () => number; feedback: string[] } {
  let turns = 0;
  const feedback: string[] = [];
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    toolEventObservability: {
      mode: "structured",
      description: "synthetic adapter structured observations",
    },
    async run(request) {
      const turn = ++turns;
      feedback.push(request.prompt);
      const text = await action(request, turn);
      return {
        text,
        session: { adapter: "pi-model", id: "synthetic-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        aborted: false,
        timedOut: false,
      };
    },
  };
  mock.method(factory, "createExecutorAdapter", () => adapter);
  return { turns: () => turns, feedback };
}

/** Write one in-worktree file through real structured tool-event evidence. */
async function observedWorktreeWrite(request: ExecutorRequest, path: string, content: string): Promise<void> {
  request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path, content } });
  await writeFile(join(request.cwd, path), content, "utf8");
  request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path, content }, result: "written" });
}

// ── tests ────────────────────────────────────────────────────────────────────

test("review progress prefers model names over unique reviewer ids", () => {
  assert.equal(reviewerProgressLabel({
    id: "reviewer-7e86e3f2",
    adapter: "codex-cli",
    model: "openai-codex/gpt-5.6-luna",
  }), "openai-codex/gpt-5.6-luna");
  assert.equal(reviewerProgressLabel({
    id: "pi-openai-codex-gpt-5-6-luna",
    adapter: "pi-model",
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
  }), "openai-codex/gpt-5.6-luna (high)");
  assert.equal(reviewerProgressLabel({
    id: "reviewer-without-model-metadata",
    adapter: "generic-cli",
    command: "reviewer",
  }), "reviewer-without-model-metadata");
});

test("lifecycle: pass + unchanged confirmation accepts and pins worker ref", async () => {
  const root = await mkTmp("pi-wwl-pass-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-pass");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-pass");
    await mkdir(artifactDir, { recursive: true });

    // Executor writes a file.
    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);
    const updates: Array<{ phase: string; message: string }> = [];

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-pass",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.ok(result.acceptedRef, "should have acceptedRef");
    assert.ok(result.acceptedCommitSha, "should have acceptedCommitSha");
    assert.equal(result.unreviewed, undefined, "should not be unreviewed");
    assert.equal(result.reviewCycles.length, 1, "should have exactly one review cycle");
    assert.equal(result.reviewCycles[0].verdict, "pass");
    assert.ok(updates.some((update) => update.phase === "reviewing" && update.message === "passing started"));
    assert.ok(updates.some((update) => update.phase === "reviewing" && update.message === "passing finished · pass"));

    // Verify the worker ref points to the accepted commit.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha, "worker ref should point to accepted commit");

    // Verify result.json was written.
    const resultJson = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    assert.equal(resultJson.status, "accepted");
    assert.equal(resultJson.taskId, "task-pass");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle passes the captured worktree evidence policy to Primary review", async () => {
  const root = await mkTmp("pi-wwl-tool-only-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-tool-only");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-tool-only");
    await mkdir(artifactDir, { recursive: true });
    const { command } = await createFakeExecutor(root);
    const updates: Array<{ phase: string; message: string }> = [];

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-tool-only",
      task: {
        ...testTask(),
        reviewEvidencePolicy: { toolOnly: true, snapshotFailureFallback: false, scope: "worktree" },
      },
      capture,
      worktree: worker,
      artifactDir,
      config: buildPassingReviewerConfig(command),
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted");
    const reviewOutput = result.reviewCycles[0]!.reviewOutput as unknown as {
      evidenceMethod?: string;
      evidenceCoverageNotice?: string;
    };
    assert.equal(reviewOutput.evidenceMethod, "tool-only");
    assert.match(reviewOutput.evidenceCoverageNotice ?? "", /No structured tool observations/);
    assert.ok(updates.some((update) => update.phase === "reviewing" && /Review evidence method: Tools only/.test(update.message)));
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle resolves current review settings after executor work completes", async () => {
  const root = await mkTmp("pi-wwl-live-review-settings-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-live-review-settings");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-live-review-settings");
    const startedMarker = join(root, "executor-started.txt");
    const oldReviewerMarker = join(root, "old-reviewer.txt");
    const newReviewerMarker = join(root, "new-reviewer.txt");
    const executor = join(root, "delayed-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');const path=require('node:path');",
      `fs.writeFileSync(${JSON.stringify(startedMarker)},'started');`,
      "setTimeout(()=>{",
      "fs.writeFileSync(path.join(process.cwd(),'worker-output.txt'),'worker done\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:'live-settings-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'Implemented the change.'}));",
      "},250);",
    ].join("\n"), "utf8");
    const reviewer = (id: string, marker: string) => ({
      id,
      adapter: "generic-cli" as const,
      command: process.execPath,
      args: [],
      review: {
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'used');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})))`],
        timeoutMs: 15_000,
      },
    });
    const config = buildConfig(executor);
    const executorAgent = config.externalAgents!["fake-exec"]!;
    config.externalAgents = agentCatalog({ id: "fake-exec", ...executorAgent }, reviewer("old", oldReviewerMarker));
    config.review = { activeReviewers: [{ source: "external", id: "old" }] };

    const running = runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-live-review-settings",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await access(startedMarker).then(() => true, () => false)) break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await access(startedMarker);
    config.externalAgents = agentCatalog({ id: "fake-exec", ...executorAgent }, reviewer("new", newReviewerMarker));
    config.review = { activeReviewers: [{ source: "external", id: "new" }] };

    const result = await running;
    assert.equal(result.status, "accepted");
    assert.equal(await readFile(newReviewerMarker, "utf8"), "used");
    await assert.rejects(access(oldReviewerMarker), /ENOENT/);
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: pass plus reviewer infrastructure error accepts with warnings and remains integration-eligible", async () => {
  const root = await mkTmp("pi-wwl-pass-warning-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-pass-warning");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-pass-warning");
    await mkdir(artifactDir, { recursive: true });
    const { command } = await createFakeExecutor(root);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-pass-warning",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config: buildPassWithReviewerErrorConfig(command),
    });

    assert.equal(result.status, "accepted_with_warnings");
    assert.ok(result.acceptedRef);
    assert.ok(result.acceptedCommitSha);
    assert.equal(result.reviewReport?.aggregate, "pass_with_warnings");
    assert.deepEqual(result.reviewReport?.reviewers.map((reviewer) => reviewer.verdict), ["pass", "error"]);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: pass then mutation causes re-review", async () => {
  const root = await mkTmp("pi-wwl-pass-mutate-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-mutate");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-mutate");
    await mkdir(artifactDir, { recursive: true });

    // Single executor: on start writes initial.txt; on resume also writes mutated.txt.
    // This simulates the executor making additional changes after the pass observation.
    const command = join(root, "mutate-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const isResume = process.env.PI_REVIEW_EXECUTOR_OPERATION === 'resume';",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial' + String.fromCharCode(10));",
      "if (isResume) {",
      "  fs.writeFileSync(path.join(process.cwd(), 'mutated.txt'), 'mutated' + String.fromCharCode(10));",
      "}",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'mutate-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: isResume ? 'Mutated after pass.' : 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-mutate",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // The lifecycle should detect the mutation and re-review.
    // Since the resume executor also writes mutated.txt, the tree changes.
    // The second review should pass (same passing reviewer).
    // After the second pass, the confirmation is also a resume, so it also writes mutated.txt (same tree).
    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.ok(result.reviewCycles.length >= 2, `should have at least 2 review cycles, got ${result.reviewCycles.length}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: a repeated identical contribution pauses as no_progress, never the numeric cap", async () => {
  const root = await mkTmp("pi-wwl-correction-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-correct");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-correct");
    await mkdir(artifactDir, { recursive: true });

    // The executor writes the same file and reports the same summary on every
    // turn: the correction contributes nothing new for a reviewer to assess.
    const firstCommand = join(root, "correct-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(), 'initial.txt'), 'initial' + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'correct-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Initial changes.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const config = buildNeedsChangesReviewerConfig(firstCommand);
    config.maxCorrectionCycles = 30;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-correct",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // One corrective handoff actually happened, and its repeated contribution
    // was reviewed before the truthful no-progress pause.
    assert.equal(result.status, "no_progress", `expected no_progress, got ${result.status}: ${result.error}`);
    assert.equal(result.error, "No progress detected.");
    assert.match(result.summary, /assessed the same contribution as the previous review/);
    assert.match(result.summary, /Correction budget not exhausted: 1\/30 used/);
    assert.doesNotMatch(result.summary, /Correction cap reached/);
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "needs_changes"]);
    assert.equal(result.acceptedRef, undefined);
    assert.equal(result.acceptedCommitSha, undefined);
    const operation = JSON.parse(await readFile(join(artifactDir, "operation.json"), "utf8"));
    assert.equal(operation.state, "paused_recoverable", "a no-progress pause stays recoverable");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: steering during review aborts reviewers and resumes the executor before fresh review", async () => {
  const root = await mkTmp("pi-wwl-review-steer-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-steer");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-steer");
    await mkdir(artifactDir, { recursive: true });
    const executor = join(root, "review-steer-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "fs.writeFileSync('steered.txt',turn===1?'true\\n':'false\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'review-steer-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn '+turn+' complete'}));",
    ].join("\n"), "utf8");
    const baseConfig = buildConfig(executor);
    const config: ReviewGateConfig = {
...baseConfig,
enabled: true,
externalAgents: {
  ...baseConfig.externalAgents!,
  "slow-pass": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", [
          "const fs=require('node:fs');const path=require('node:path');",
          "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{",
          "const request=fs.readFileSync(path.join(process.env.PI_REVIEW_GATE_BUNDLE_DIR,'request.md'),'utf8');",
          "const visible=request.includes('[steer:review-steer-1] Write false instead.')&&request.includes('Later updates supersede');",
          "process.stdout.write(JSON.stringify(visible?{verdict:'pass',summary:'authoritative steering visible',findings:[]}:{verdict:'needs_changes',summary:'steering missing',findings:[{severity:'blocking',issue:'steering missing',recommendation:'include steering'}]}));",
          "},2000))",
        ].join("")],
      timeoutMs: 5000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "slow-pass" }
      ] },
    };
    let steered = false;
    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-review-steer",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onLiveControl: (control) => {
        if (steered || control?.protocol !== "review-to-executor-handoff-v1") return;
        steered = true;
        void control.steer("Write false instead.", "review-steer-1");
      },
    });

    assert.equal(steered, true);
    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}: ${result.error ?? result.summary}`);
    assert.equal(await readFile(join(worker.worktreeRoot, "steered.txt"), "utf8"), "false\n");
    assert.ok(result.reviewCycles.every((cycle) => cycle.verdict === "pass"));
    const persisted = JSON.parse(await readFile(join(artifactDir, "task.json"), "utf8"));
    assert.deepEqual(persisted.task.authoritativeUpdates.map((item: { instructionId: string }) => item.instructionId), ["review-steer-1"]);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: turn-interrupt steering during review supersedes the review like ordinary steering (#63)", async () => {
  const root = await mkTmp("pi-wwl-review-steer-interrupt-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-steer-interrupt");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-steer-interrupt");
    await mkdir(artifactDir, { recursive: true });
    const executor = join(root, "review-steer-interrupt-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "fs.writeFileSync('steered.txt',turn===1?'true\\n':'false\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'review-steer-interrupt-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn '+turn+' complete'}));",
    ].join("\n"), "utf8");
    const baseConfig = buildConfig(executor);
    const config: ReviewGateConfig = {
...baseConfig,
enabled: true,
externalAgents: {
  ...baseConfig.externalAgents!,
  "slow-pass": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", [
          "const fs=require('node:fs');const path=require('node:path');",
          "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{",
          "const request=fs.readFileSync(path.join(process.env.PI_REVIEW_GATE_BUNDLE_DIR,'request.md'),'utf8');",
          "const visible=request.includes('[steer:review-steer-interrupt] Write false instead.')&&request.includes('Later updates supersede');",
          "process.stdout.write(JSON.stringify(visible?{verdict:'pass',summary:'authoritative steering visible',findings:[]}:{verdict:'needs_changes',summary:'steering missing',findings:[{severity:'blocking',issue:'steering missing',recommendation:'include steering'}]}));",
          "},2000))",
        ].join("")],
      timeoutMs: 5000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "slow-pass" }
      ] },
    };
    let steered = false;
    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-review-steer-interrupt",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onLiveControl: (control) => {
        if (steered || control?.protocol !== "review-to-executor-handoff-v1") return;
        steered = true;
        assert.deepEqual(control.capabilities, { steer: true, interrupt: false });
        void control.steer("Write false instead.", "review-steer-interrupt", { interrupt: true });
      },
    });

    assert.equal(steered, true);
    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}: ${result.error ?? result.summary}`);
    assert.equal(await readFile(join(worker.worktreeRoot, "steered.txt"), "utf8"), "false\n");
    assert.ok(result.reviewCycles.every((cycle) => cycle.verdict === "pass"));
    const persisted = JSON.parse(await readFile(join(artifactDir, "task.json"), "utf8"));
    assert.deepEqual(persisted.task.authoritativeUpdates.map((item: { instructionId: string }) => item.instructionId), ["review-steer-interrupt"]);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: correction cap reached", async () => {
  const root = await mkTmp("pi-wwl-cap-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-cap");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-cap");
    await mkdir(artifactDir, { recursive: true });

    // Executor that always writes a new file (different each time).
    const command = join(root, "cap-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const turn = process.env.PI_REVIEW_EXECUTOR_TURN || '1';",
      "fs.writeFileSync(path.join(process.cwd(), `file-${turn}.txt`), `content-${turn}` + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'cap-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Changes applied.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 1;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
    assert.ok(result.error?.includes("cap") || result.error?.includes("1"), `error should mention cap: ${result.error}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: review disabled returns completed_unreviewed", async () => {
  const root = await mkTmp("pi-wwl-disabled-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-disabled");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-disabled");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command);
    config.enabled = false; // Disable review

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-disabled",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true, "should be explicitly unreviewed");
    assert.ok(result.acceptedRef, "should have acceptedRef even when unreviewed");
    assert.ok(result.acceptedCommitSha, "should have acceptedCommitSha");
    assert.equal(result.reviewCycles.length, 0, "should have no review cycles");

    // Verify the worker ref was pinned.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha, "worker ref should point to unreviewed commit");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: mode-only candidate is reviewed", async () => {
  const root = await mkTmp("pi-wwl-mode-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-mode");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-mode");
    await mkdir(artifactDir, { recursive: true });

    // Executor that changes file mode only.
    const command = join(root, "mode-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.chmodSync(path.join(process.cwd(), 'app.js'), 0o755);",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'mode-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Made executable.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-mode",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.equal(result.reviewCycles.length, 1, "should have one review cycle");
    assert.equal(result.reviewCycles[0].verdict, "pass");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: reviewer error returns review_error", async () => {
  const root = await mkTmp("pi-wwl-review-err-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-err");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-err");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildErrorReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-review-err",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "review_error", `expected review_error, got ${result.status}`);
    assert.ok(result.error, "should have error message");
    assert.ok(!result.acceptedRef, "should not have acceptedRef on review error");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: accepted ref hash matches the passed candidate", async () => {
  const root = await mkTmp("pi-wwl-ref-hash-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-ref-hash");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-ref-hash");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-ref-hash",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted");

    // The accepted ref should point to the passed candidate commit.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha, "accepted ref should match accepted commit SHA");

    // The accepted commit should be the same as the one from the review cycle.
    assert.equal(result.reviewCycles[0].candidateCommit, result.acceptedCommitSha,
      "review cycle candidate should match accepted commit");

    // Verify the worker ref name format.
    const expectedRef = workerRefName(capture.waveId, "task-ref-hash");
    assert.equal(result.acceptedRef, expectedRef, "accepted ref should match expected format");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: no_changes executor returns no_changes", async () => {
  const root = await mkTmp("pi-wwl-noc-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-noc");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-noc");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createNoOpExecutor(root);
    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-noc",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "no_changes", `expected no_changes, got ${result.status}`);
    assert.equal(result.reviewCycles.length, 0, "should have no review cycles");
    assert.ok(!result.acceptedRef, "should not have acceptedRef for no_changes");
    // Report-only success contract: the executor's diagnosis summary is the
    // authoritative report and must stay retrievable (durable artifacts),
    // with no candidate commit and no fabricated review evidence.
    assert.ok(result.summary.startsWith("No changes needed."), "the executor's report summary must be retained on the result");
    assert.match(result.summary, /Review evidence limitations:.*tool-level write paths are not observed/);
    const completion = JSON.parse(await readFile(join(artifactDir, "completion.json"), "utf8"));
    assert.equal(completion.status, "no_changes");
    assert.equal(completion.summary, "No changes needed.");
    assert.equal(completion.differsFromBase, false, "no file commit may be fabricated for a report-only task");
    const durable = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    assert.equal(durable.status, "no_changes");
    assert.ok(durable.summary.startsWith("No changes needed."));
    assert.match(durable.summary, /Review evidence limitations:.*tool-level write paths are not observed/);
    assert.equal(durable.reviewCycles.length, 0, "no review cycle is fabricated for a skipped review");
    assert.equal(durable.reviewReport ?? undefined, undefined, "no review report is fabricated for a skipped review");
    assert.ok(result.artifactDir, "artifactDir stays user-inspectable");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: result.json written to artifact root", async () => {
  const root = await mkTmp("pi-wwl-result-json-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-result-json");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-result-json");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-result-json",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // Verify result.json exists and has correct structure.
    const resultJson = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    assert.equal(resultJson.version, 1);
    assert.equal(resultJson.status, "accepted");
    assert.equal(resultJson.taskId, "task-result-json");
    assert.ok(resultJson.acceptedRef, "should have acceptedRef in result.json");
    assert.ok(resultJson.acceptedCommitSha, "should have acceptedCommitSha in result.json");
    assert.ok(Array.isArray(resultJson.reviewCycles), "should have reviewCycles array");
    assert.ok(resultJson.completedAt, "should have completedAt timestamp");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: no reviewers configured returns completed_unreviewed", async () => {
  const root = await mkTmp("pi-wwl-no-reviewers-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-no-reviewers");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-no-reviewers");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    // Config with no active reviewers.
    const config = buildConfig(command);
    config.review = { activeReviewers: [] };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-no-reviewers",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: cancelled via abort signal", async () => {
  const root = await mkTmp("pi-wwl-cancel-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-cancel");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-cancel");
    await mkdir(artifactDir, { recursive: true });

    // Slow executor to give time for abort.
    const command = join(root, "cancel-executor.cjs");
    await writeFile(command, [
      "setTimeout(() => {",
      "  console.log(JSON.stringify({ type: 'session', sessionId: 'cancel-session' }));",
      "  console.log(JSON.stringify({ type: 'assistant', text: 'done' }));",
      "}, 60000);",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildPassingReviewerConfig(command);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-cancel",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      signal: controller.signal,
    });

    assert.equal(result.status, "cancelled", `expected cancelled, got ${result.status}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: failed workers are not pinned", async () => {
  const root = await mkTmp("pi-wwl-no-pin-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-no-pin");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-no-pin");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildErrorReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-no-pin",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "review_error");
    assert.ok(!result.acceptedRef, "should not have acceptedRef on review error");

    // Verify no worker ref was created.
    const expectedRef = workerRefName(capture.waveId, "task-no-pin");
    const refExists = await gitInRepo(
      ["rev-parse", "--verify", expectedRef],
      capture.repositoryPath,
    ).catch(() => null);
    assert.equal(refExists, null, "no worker ref should exist for failed lifecycle");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: a numeric maxCorrectionCycles of 30 is enforced and is the only correction_cap cause", async () => {
  const root = await mkTmp("pi-wwl-numeric-cap-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-numeric-cap");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-numeric-cap");
    await mkdir(artifactDir, { recursive: true });

    // Every turn contributes a distinct file and a distinct report, so no
    // reviewed contribution repeats: only the numeric budget can stop it.
    const command = join(root, "numeric-cap-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const turn = process.env.PI_REVIEW_EXECUTOR_TURN || '1';",
      "fs.writeFileSync(path.join(process.cwd(), `distinct-${turn}.txt`), `content-${turn}` + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'numeric-cap-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: `Distinct turn ${turn} report.` }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 30;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-numeric-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // Initial review plus the configured 30 correction cycles.
    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}: ${result.error}`);
    assert.equal(result.error, "Correction cap reached: 30");
    assert.match(result.summary, /Correction cap reached after 30 cycle\(s\)/);
    assert.doesNotMatch(result.summary, /No progress/);
    assert.doesNotMatch(result.summary, /not exhausted/);
    assert.equal(result.reviewCycles.length, 31, "initial review plus 30 numeric corrections");
    assert.ok(result.reviewCycles.every((cycle) => cycle.verdict === "needs_changes"));
    assert.equal(new Set(result.reviewCycles.map((cycle) => cycle.candidateCommit)).size, 31,
      "every reviewed contribution must be distinct from the previous one");
    assert.equal(result.acceptedRef, undefined, "an exhausted result accepts no ref");
    assert.equal(result.acceptedCommitSha, undefined);
    const operation = JSON.parse(await readFile(join(artifactDir, "operation.json"), "utf8"));
    assert.equal(operation.state, "paused_recoverable", "numeric exhaustion stays recoverable");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: zero-event XML-shaped correction text is never executed and its repeat stops as no_progress", async () => {
  const root = await mkTmp("pi-wwl-xml-tool-text-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-xml-tool-text");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-xml-tool-text");
    await mkdir(artifactDir, { recursive: true });

    const turnLog = join(root, "executor-turns.txt");
    const injectedPath = join(worker.worktreeRoot, "xml-injected.txt");
    // Literal assistant text that merely resembles a tool call. The lifecycle
    // must never reinterpret it as an executable tool invocation.
    const xmlText = [
      "<tool_call>",
      JSON.stringify({ name: "write", arguments: { file_path: "xml-injected.txt", content: "should never be written" } }),
      "</tool_call>",
    ].join("");
    const command = join(root, "xml-tool-text-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const turn = process.env.PI_REVIEW_EXECUTOR_TURN || '1';",
      "const operation = process.env.PI_REVIEW_EXECUTOR_OPERATION || 'start';",
      `fs.appendFileSync(${JSON.stringify(turnLog)}, turn + ':' + operation + String.fromCharCode(10));`,
      "if (turn === '1') fs.writeFileSync('implementation.txt', 'implemented' + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'xml-session' }));",
      `console.log(JSON.stringify({ type: 'assistant', text: turn === '1' ? 'Initial implementation complete.' : ${JSON.stringify(xmlText)} }));`,
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 30;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-xml-tool-text",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // Exact observed sequence: implement, correct (zero-work XML text),
    // review, correct the repeated identical report, review, then stop.
    assert.equal(await readFile(turnLog, "utf8"), ["1:start", "2:resume", "3:resume", ""].join("\n"));
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict),
      ["needs_changes", "needs_changes", "needs_changes"]);
    assert.equal(result.reviewCycles.length, 3, "the repeated report is stopped only after an actual review");
    assert.equal(result.status, "no_progress", `expected no_progress, got ${result.status}: ${result.error}`);
    assert.equal(result.error, "No progress detected.");
    assert.match(result.summary, /assessed the same contribution as the previous review/);
    assert.match(result.summary, /Correction budget not exhausted: 2\/30 used/);
    assert.doesNotMatch(result.summary, /Correction cap reached/);

    // The zero-event corrective turns retained no structured tool identity.
    assert.ok(result.reviewCycles.every((cycle) => (cycle.toolObservationRevision ?? 0) === 0),
      "the binary protocol corrective turns emit zero structured tool events");
    assert.equal(new Set(result.reviewCycles.map((cycle) => cycle.candidateTreeSha)).size, 1,
      "every review assessed the same candidate tree");
    // The XML text was never executed as a tool call.
    await assert.rejects(access(injectedPath), /ENOENT/);
    // No stopped/unapproved result gets an accepted ref.
    assert.equal(result.acceptedRef, undefined);
    assert.equal(result.acceptedCommitSha, undefined);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: a report-only revised report reaches a real second review without dummy writes", async () => {
  const root = await mkTmp("pi-wwl-report-only-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-report-only");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-report-only");
    await mkdir(artifactDir, { recursive: true });

    // Report-only task: the deliverable is the report text, written outside the
    // candidate worktree. The candidate tree stays identical to base.
    const reportPath = join(root, "report.md");
    // A report-only turn must never need a dummy workspace edit, and a report
    // claim must never approve itself: each turn records the worktree state and
    // whether any worker landing ref exists yet.
    const worktreeStateBeforeEachTurn: string[] = [];
    const landingRefBeforeEachTurn: string[] = [];
    const adapter = installLifecycleAdapter(async (request, turn) => {
      worktreeStateBeforeEachTurn.push(await git(["status", "--porcelain", "--untracked-files=all"], request.cwd));
      landingRefBeforeEachTurn.push(await gitInRepo(
        ["rev-parse", "--verify", "--quiet", workerRefName(capture.waveId, "task-report-only")],
        capture.repositoryPath,
      ).catch(() => ""));
      if (turn === 1) {
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: reportPath, content: "Draft report v1\n" } });
        await writeFile(reportPath, "Draft report v1\n", "utf8");
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: reportPath, content: "Draft report v1\n" }, result: "written" });
        return "Draft report delivered.";
      }
      if (turn === 2) {
        // The reviewer asked for a revised report, not source edits.
        return "Revised report v2: the blocking finding is answered by re-checking the read-only analysis; no source change was needed.";
      }
      if (turn === 3) {
        // The reviewer is still blocking the first revision, so a further
        // revised report is the corrective contribution — still with no write.
        return "Revised report v3: the second blocking finding is answered with the added comparison table; still no source change.";
      }
      return "Acknowledged the reviewed report.";
    });
    const config = buildConfig(process.execPath, "fake-exec", [scriptedReviewer(root, ["needs_changes", "needs_changes", "pass"])], [{ source: "external", id: "scripted" }]);
    config.maxCorrectionCycles = 30;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-report-only",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "needs_changes", "pass"],
      `expected two real blocking verdicts and a real pass, got ${result.status}: ${result.error}`);
    assert.equal(adapter.turns(), 4, "initial turn, two corrective report turns, and one pass confirmation");
    // A blocking verdict stays blocking and lands nothing: the executor's own
    // report claim never became an approval.
    assert.equal(adapter.feedback.length, 4);
    assert.doesNotMatch(adapter.feedback[0]!, /Gate verdict:/);
    assert.match(adapter.feedback[1]!, /Gate verdict: needs_changes/);
    assert.match(adapter.feedback[1]!, /the corrected result still needs revision/);
    assert.match(adapter.feedback[2]!, /Gate verdict: needs_changes/);
    assert.match(adapter.feedback[3]!, /Gate verdict: pass/);
    // A file-free reviewed result settles without a fabricated commit or ref.
    assert.equal(result.status, "no_changes", `expected the canonical no-file outcome, got ${result.status}`);
    assert.equal(result.acceptedRef, undefined);
    assert.equal(result.acceptedCommitSha, undefined);
    assert.deepEqual(worktreeStateBeforeEachTurn, ["", "", "", ""],
      "no dummy workspace edit may be required to reach review");
    assert.deepEqual(landingRefBeforeEachTurn, ["", "", "", ""],
      "no landing ref may exist while review is still asking for changes");
    assert.equal(await git(["status", "--porcelain", "--untracked-files=all"], worker.worktreeRoot), "",
      "the worktree is still untouched after settlement");
    assert.equal(await gitInRepo(
      ["rev-parse", "--verify", "--quiet", workerRefName(capture.waveId, "task-report-only")],
      capture.repositoryPath,
    ).catch(() => ""), "", "a file-free result never pins a landing ref");
    // Every assessed contribution carried the same unchanged candidate tree,
    // so only the revised report claim distinguished it.
    assert.equal(new Set(result.reviewCycles.map((cycle) => cycle.candidateTreeSha)).size, 1,
      "each revised report was reviewed against the identical unchanged tree");
    // Each review actually received the report claim it judged.
    const proofs = await reviewerProof(root);
    assert.equal(proofs.length, 3, "each revised report must reach a real reviewer invocation");
    assert.match(proofs[0]!.evidence.finalAssistantSummaries.join("\n"), /Draft report delivered/);
    assert.match(proofs[1]!.evidence.finalAssistantSummaries.join("\n"), /Revised report v2/);
    assert.match(proofs[1]!.markdown, /Revised report v2/);
    assert.match(proofs[2]!.evidence.finalAssistantSummaries.join("\n"), /Revised report v3/);
    assert.match(proofs[2]!.markdown, /Revised report v3/);
    // The report is an external side-effect candidate, never an in-root delta.
    assert.equal(proofs[2]!.evidence.candidates.some((candidate) => candidate.path.endsWith("report.md") && candidate.externalSideEffect === true), true,
      "the external report must remain an observed outside-root side effect");
    assert.equal(proofs[2]!.evidence.changedCandidatePaths.some((path) => path.includes("report.md")), false,
      "the external report must not be treated as an in-workspace changed path");
    assert.doesNotMatch(proofs[2]!.patch, /report\.md/);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: checks-only progress with an unchanged tree and unchanged observation revisions reaches review", async () => {
  const root = await mkTmp("pi-wwl-checks-only-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-checks-only");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-checks-only");
    await mkdir(artifactDir, { recursive: true });

    // Every turn below runs before acceptance, so each turn also records
    // whether any worker landing ref exists yet.
    const landingRefBeforeEachTurn: string[] = [];
    const adapter = installLifecycleAdapter(async (request, turn) => {
      landingRefBeforeEachTurn.push(await gitInRepo(
        ["rev-parse", "--verify", "--quiet", workerRefName(capture.waveId, "task-checks-only")],
        capture.repositoryPath,
      ).catch(() => ""));
      if (turn === 1) {
        await observedWorktreeWrite(request, "SCRIPT", "checkable\n");
        return "SCRIPT updated.";
      }
      if (turn === 2) {
        // Checks-only correction: real structured observations that name no
        // mutation path, with an identical report text and no tree change.
        request.onToolObservation?.({ stage: "start", toolName: "bash", toolInput: { command: "npm run check:static" } });
        request.onToolObservation?.({ stage: "end", toolName: "bash", toolInput: { command: "npm run check:static" }, result: "checks passed" });
      }
      if (turn === 3) {
        // The reviewer is still blocking the checks-only correction, so this
        // next handoff contributes a further real check and still no delta.
        request.onToolObservation?.({ stage: "start", toolName: "bash", toolInput: { command: "npm run build:test" } });
        request.onToolObservation?.({ stage: "end", toolName: "bash", toolInput: { command: "npm run build:test" }, result: "focused tests passed" });
      }
      return "SCRIPT updated.";
    });
    const config = buildConfig(process.execPath, "fake-exec", [scriptedReviewer(root, ["needs_changes", "needs_changes", "pass"])], [{ source: "external", id: "scripted" }]);
    config.maxCorrectionCycles = 30;

    const updates: Array<{ phase: string; message: string }> = [];
    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-checks-only",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted", `expected accepted after two reviewed corrections, got ${result.status}: ${result.error}`);
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "needs_changes", "pass"],
      "a second blocking verdict must stay blocking and the next corrective handoff must be allowed");
    assert.equal(adapter.turns(), 4, "initial turn, two corrective handoffs, and one pass acknowledgement");
    assert.deepEqual(landingRefBeforeEachTurn, ["", "", "", ""],
      "no unapproved landing ref may exist before the passing review");

    // Exact executor/reviewer sequence: each corrective turn received the
    // blocking verdict it had to answer, and the last turn received the pass.
    assert.equal(adapter.feedback.length, 4);
    assert.doesNotMatch(adapter.feedback[0]!, /Gate verdict:/);
    assert.match(adapter.feedback[1]!, /Gate verdict: needs_changes/);
    assert.match(adapter.feedback[1]!, /the corrected result still needs revision/);
    assert.match(adapter.feedback[2]!, /Gate verdict: needs_changes/);
    assert.match(adapter.feedback[3]!, /Gate verdict: pass/);
    const progress = updates.map((update) => `${update.phase}:${update.message}`);
    for (const expected of [
      "reviewing:review cycle 1",
      "correcting:correction 1/30",
      "reviewing:review cycle 2",
      "correcting:correction 2/30",
      "reviewing:review cycle 3",
      "confirming:review passed — confirming unchanged tree",
    ]) {
      assert.ok(progress.includes(expected), `expected progress ${expected}, got ${JSON.stringify(progress)}`);
    }
    assert.ok(!updates.some((update) => /No progress|Correction cap/.test(update.message)),
      "the loop stops for neither a repeated contribution nor the numeric budget");

    const [first, second, third] = result.reviewCycles;
    assert.equal(second!.candidateTreeSha, first!.candidateTreeSha, "the candidate tree is unchanged");
    assert.equal(third!.candidateTreeSha, first!.candidateTreeSha, "the second correction also changes no file");
    for (const cycle of result.reviewCycles) {
      assert.equal(cycle.toolObservationRevision, first!.toolObservationRevision,
        "a checks-only observation does not move the mutation-path revision");
      assert.equal(cycle.externalObservationRevision, first!.externalObservationRevision,
        "an in-workspace check is not external scope");
    }
    // Every review actually assessed the checks that justified further review.
    const proofs = await reviewerProof(root);
    assert.equal(proofs.length, 3, "each correction must reach a real subsequent reviewer invocation");
    assert.deepEqual(proofs.map((proof) => proof.evidence.finalAssistantSummaries.at(-1)),
      ["SCRIPT updated.", "SCRIPT updated.", "SCRIPT updated."],
      "the retained report claim is identical for every assessed contribution");
    assert.ok(!proofs[0]!.evidence.events.some((event) => event.toolName === "bash"),
      "the initial review had no check observation to assess");
    assert.match(proofs[1]!.markdown, /npm run check:static/);
    assert.ok(proofs[1]!.evidence.events.some((event) => event.toolName === "bash"),
      "the real check events must be retained evidence for the subsequent review");
    assert.match(proofs[2]!.markdown, /npm run check:static/);
    assert.match(proofs[2]!.markdown, /npm run build:test/);
    assert.deepEqual(proofs[2]!.evidence.changedCandidatePaths, proofs[0]!.evidence.changedCandidatePaths,
      "the corrections added no workspace change for the passing review to land");
    // Acceptance pins exactly the candidate that passed the final review.
    assert.equal(result.acceptedRef, workerRefName(capture.waveId, "task-checks-only"));
    assert.equal(result.acceptedCommitSha, result.reviewCycles.at(-1)!.candidateCommit,
      "the pinned ref is the candidate the passing review assessed");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: an external artifact refresh reaches review without attributing in-root work outside the workspace", async () => {
  const root = await mkTmp("pi-wwl-external-refresh-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-external-refresh");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-external-refresh");
    await mkdir(artifactDir, { recursive: true });

    // The external deliverable lives outside the isolated worktree; the
    // in-workspace candidate SCRIPT must remain an ordinary reviewed change.
    const externalPath = join(root, "artifact.md");
    const adapter = installLifecycleAdapter(async (request, turn) => {
      if (turn === 1) {
        await observedWorktreeWrite(request, "SCRIPT", "reviewed script v1\n");
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: externalPath, content: "artifact v1\n" } });
        await writeFile(externalPath, "artifact v1\n", "utf8");
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: externalPath, content: "artifact v1\n" }, result: "written" });
        return "SCRIPT and the external artifact are delivered.";
      }
      if (turn === 2) {
        // Refresh only the external artifact; the candidate tree is unchanged.
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: externalPath, content: "artifact v2\n" } });
        await writeFile(externalPath, "artifact v2\n", "utf8");
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: externalPath, content: "artifact v2\n" }, result: "written" });
        return "Refreshed the external artifact.";
      }
      return "Acknowledged.";
    });
    const config = buildConfig(process.execPath, "fake-exec", [scriptedReviewer(root, ["needs_changes", "pass"])], [{ source: "external", id: "scripted" }]);
    config.maxCorrectionCycles = 30;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-external-refresh",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}: ${result.error}`);
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "pass"]);
    const [first, second] = result.reviewCycles;
    assert.equal(second!.candidateTreeSha, first!.candidateTreeSha, "the candidate tree is unchanged");
    assert.ok(second!.externalObservationRevision! > first!.externalObservationRevision!,
      "the refreshed external artifact is retained as real external evidence");
    const proofs = await reviewerProof(root);
    assert.equal(proofs.length, 2);
    const externalCandidate = proofs[1]!.evidence.candidates.find((candidate) => candidate.path.endsWith("artifact.md"));
    assert.equal(externalCandidate?.externalSideEffect, true, "only the actual outside-root artifact is external");
    assert.equal(externalCandidate?.afterSnapshot?.content, "artifact v2\n");
    const inRootCandidate = proofs[1]!.evidence.candidates.find((candidate) => candidate.path === "SCRIPT");
    assert.equal(inRootCandidate?.externalSideEffect, undefined, "in-root work is not attributed to outside scope");
    // The landed candidate carries the reviewed in-workspace change only.
    assert.doesNotMatch(proofs[1]!.patch, /artifact\.md/);
    assert.match(await git(["show", `${result.acceptedCommitSha}:SCRIPT`], capture.repositoryPath), /reviewed script v1/);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

// ── Focused tests for lifecycle stabilization ────────────────────────────────

test("lifecycle: reviewer-blocked does not create artifact directory", async () => {
  const root = await mkTmp("pi-wwl-blocked-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-blocked");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-blocked");
    // Do NOT pre-create the artifact directory.

    // Config with a duplicated enabled reviewer selection causes reviewer_blocked.
    const config = buildConfig(await createFakeExecutor(root).then((e) => e.command));
    config.enabled = true;
    config.externalAgents = {
      ...config.externalAgents!,
      "dup-reviewer": {
        adapter: "generic-cli" as const,
        command: process.execPath,
        args: [],
        review: { args: ["-e", "process.stdout.write('{}')"], timeoutMs: 15000 }
      }
    };
    config.review = {
      activeReviewers: [
        { source: "external", id: "dup-reviewer" },
        { source: "external", id: "dup-reviewer" },
      ],
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-blocked",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "reviewer_blocked");

    // Verify the artifact directory was NOT created.
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(artifactDir), /ENOENT/,
      "artifact directory should not be created for reviewer-blocked");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: reviewer receives task acceptance criteria in evidence", async () => {
  const root = await mkTmp("pi-wwl-evidence-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-evidence");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-evidence");
    await mkdir(artifactDir, { recursive: true });

    // Executor writes a file.
    const { command } = await createFakeExecutor(root);

    // Reviewer checks that the prompt contains acceptance criteria.
    const baseConfig = buildConfig(command);
    const config: ReviewGateConfig = {
...baseConfig,
enabled: true,
externalAgents: {
  ...baseConfig.externalAgents!,
  "evidence-checker": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "let s='';",
          "process.stdin.on('data',c=>s+=c);",
          "process.stdin.on('end',()=>{",
          "const ok=s.includes('Acceptance criteria:')",
          "&& s.includes('worker-output.txt exists with content')",
          "&& s.includes('Task instructions:')",
          "&& s.includes('Create worker-output.txt')",
          "&& s.includes('Implemented the change.')",
          "&& s.includes('Workspace snapshot disclosure:')",
          "&& s.includes('Git-ignored files are not present');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'evidence complete',findings:[]}",
          ":{verdict:'needs_changes',summary:'missing evidence',findings:[]}));",
          "});",
        ].join(""),
      ],
      timeoutMs: 15000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "evidence-checker" }
      ] },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-evidence",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: an executor completion report resolves review without a tree change", async () => {
  const root = await mkTmp("pi-wwl-response-evidence-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-response-evidence");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-response-evidence");
    await mkdir(artifactDir, { recursive: true });

    const completionMarker = "EXECUTOR-COMPLETION-REPORT-7A91";
    const executor = join(root, "response-evidence-executor.cjs");
    await writeFile(executor, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const resumed = process.env.PI_REVIEW_EXECUTOR_OPERATION === 'resume';",
      "fs.writeFileSync(path.join(process.cwd(), 'worker-output.txt'), 'worker done\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'response-evidence-session' }));",
      `console.log(JSON.stringify({ type: 'assistant', text: resumed ? ${JSON.stringify(completionMarker)} : 'Initial implementation complete.' }));`,
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);

    const reviewerScript = [
      "process.stdin.resume();",
      "let s='';",
      "process.stdin.on('data',c=>s+=c);",
      "process.stdin.on('end',()=>{",
      `const complete=s.includes(${JSON.stringify(completionMarker)});`,
      "process.stdout.write(JSON.stringify(complete",
      "?{verdict:'pass',summary:'completion report is present',findings:[]}",
      ":{verdict:'needs_changes',summary:'completion report missing',guidance:'Report completion.',findings:[{severity:'blocking',file:'session',line:null,issue:'completion report missing',recommendation:'Report completion.'}]}));",
      "});",
    ].join("");
    const baseConfig = buildConfig(executor);
    const config: ReviewGateConfig = {
...baseConfig,
enabled: true,
maxCorrectionCycles: 2,
externalAgents: {
  ...baseConfig.externalAgents!,
  "response-evidence-checker": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", reviewerScript],
      timeoutMs: 15000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "response-evidence-checker" }
      ] },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-response-evidence",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "pass"]);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: reviewer receives the executor's isolated path mapping", async () => {
  const root = await mkTmp("pi-wwl-review-paths-");
  try {
    const { sourceDir, capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-review-paths");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-review-paths");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root, "absolute-output.txt");
    const aliasRoot = sourceDir + "-lexical-alias";
    const expectedWorkerPath = join(worker.worktreeRoot, "absolute-output.txt");
    const baseConfig = buildConfig(command);
    const config: ReviewGateConfig = {
...baseConfig,
enabled: true,
externalAgents: {
  ...baseConfig.externalAgents!,
  "path-mapping-checker": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "let s='';",
          "process.stdin.on('data',c=>s+=c);",
          "process.stdin.on('end',()=>{",
          `const sourceRoot=${JSON.stringify(sourceDir)};`,
          `const aliasRoot=${JSON.stringify(aliasRoot)};`,
          `const workerPath=${JSON.stringify(expectedWorkerPath)};`,
          "const ok=!s.includes(sourceRoot)&&!s.includes(aliasRoot)&&s.includes(workerPath);",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'review paths are isolated',findings:[]}",
          ":{verdict:'needs_changes',summary:'review received source paths',findings:[{severity:'blocking',file:'session',line:null,issue:'source path leaked',recommendation:'rewrite it'}]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "path-mapping-checker" }
      ] },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: sourceDir,
      sourceRootAliases: [aliasRoot],
      taskId: "task-review-paths",
      task: {
        title: `Create ${sourceDir}/absolute-output.txt`,
        instructions: `Create ${sourceDir}/absolute-output.txt and verify it via ${aliasRoot}/absolute-output.txt.`,
        acceptanceCriteria: [
          `${sourceDir}/absolute-output.txt exists`,
          `${aliasRoot}/absolute-output.txt has the requested content`,
        ],
        relevantContext: `The requested file is ${sourceDir}/absolute-output.txt.`,
      },
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: accepted HEAD equals exact passed candidate hash", async () => {
  const root = await mkTmp("pi-wwl-head-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-head");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-head");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-head",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted");

    // Verify the worktree HEAD is at the accepted commit.
    const headSha = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    assert.equal(headSha, result.acceptedCommitSha,
      "worktree HEAD should equal accepted commit SHA");

    // Verify the worker ref points to the same commit.
    const refSha = await gitInRepo(
      ["rev-parse", result.acceptedRef!],
      capture.repositoryPath,
    );
    assert.equal(refSha, result.acceptedCommitSha,
      "worker ref should equal accepted commit SHA");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: correction exchange history preserved across cycles", async () => {
  const root = await mkTmp("pi-wwl-exchange-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-exchange");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-exchange");
    await mkdir(artifactDir, { recursive: true });

    // Executor that always writes a file (different each time).
    const command = join(root, "exchange-executor.cjs");
    await writeFile(command, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const turn = process.env.PI_REVIEW_EXECUTOR_TURN || '1';",
      "fs.writeFileSync(path.join(process.cwd(), `file-${turn}.txt`), `content-${turn}` + String.fromCharCode(10));",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'exchange-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Changes applied.' }));",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    // Reviewer always returns needs_changes.
    const config = buildNeedsChangesReviewerConfig(command);
    config.maxCorrectionCycles = 2;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-exchange",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "correction_cap");
    // Should have at least 2 review cycles (initial + 1 correction).
    assert.ok(result.reviewCycles.length >= 2,
      `should have at least 2 review cycles, got ${result.reviewCycles.length}`);

    // Each cycle should have a distinct candidate commit.
    const shas = result.reviewCycles.map((c) => c.candidateCommit);
    const uniqueShas = new Set(shas);
    assert.ok(uniqueShas.size >= 2,
      `should have at least 2 distinct candidate commits, got ${uniqueShas.size}`);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: invalid maxCorrectionCycles fails safely", async () => {
  const root = await mkTmp("pi-wwl-invalid-cap-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-invalid-cap");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-invalid-cap");
    // Do NOT pre-create the artifact directory.

    const { command } = await createFakeExecutor(root);
    const config = buildPassingReviewerConfig(command);

    // Test negative value.
    const result1 = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-invalid-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      maxCorrectionCycles: -1,
    });
    assert.equal(result1.status, "review_error");
    assert.ok(result1.error?.includes("Invalid maxCorrectionCycles"),
      `error should mention invalid maxCorrectionCycles: ${result1.error}`);

    // Test non-integer value.
    const result2 = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-invalid-cap",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      maxCorrectionCycles: 1.5 as any,
    });
    assert.equal(result2.status, "review_error");

    // Verify artifact directory was NOT created for invalid values.
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(artifactDir), /ENOENT/,
      "artifact directory should not be created for invalid maxCorrectionCycles");

    // Test undefined (should use config default, not fail).
    // Use a separate artifact dir to avoid interference.
    const artifactDir2 = join(capture.waveRoot, "artifacts", "task-invalid-cap-2");
    const result3 = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-invalid-cap-2",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir: artifactDir2,
      config,
      maxCorrectionCycles: undefined,
    });
    // Should proceed normally (not review_error from validation).
    assert.notEqual(result3.status, "review_error",
      "undefined maxCorrectionCycles should use config default");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: review cycles pin immutable per-cycle aliases and acceptance matches the final cycle", async () => {
  const root = await mkTmp("pi-wwl-alias-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-alias-lifecycle");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-alias-lifecycle");
    const { command } = await createFakeExecutor(root);

    const config = buildPassingReviewerConfig(command);

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-alias-lifecycle",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted");
    assert.ok(result.reviewCycles.length >= 1, "at least one review cycle ran");

    // Every recorded cycle pins an immutable per-cycle alias that still pins
    // the exact reviewed candidate commit and tree.
    for (const cycle of result.reviewCycles) {
      const expectedRef = `refs/pi-review-gate/waves/${capture.waveId}/review-candidates/task-alias-lifecycle/cycle-${String(cycle.cycle).padStart(6, "0")}`;
      assert.equal(cycle.candidateRef, expectedRef, "cycle records its immutable alias ref");
      const pinned = await gitInRepo(["rev-parse", "--verify", cycle.candidateRef], capture.repositoryPath);
      assert.equal(pinned, cycle.candidateCommit, "alias pins the reviewed candidate");
      const tree = await gitInRepo(["rev-parse", `${cycle.candidateCommit}^{tree}`], capture.repositoryPath);
      assert.equal(tree, cycle.candidateTreeSha, "alias candidate matches the recorded tree");
    }

    // Acceptance is tied to the final review cycle candidate.
    const finalCycle = result.reviewCycles[result.reviewCycles.length - 1];
    assert.equal(result.acceptedCommitSha, finalCycle.candidateCommit, "accepted commit equals the final cycle candidate");

    // result.json records the alias identity compatibly.
    const persisted = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    for (const cycle of persisted.reviewCycles) {
      assert.equal(typeof cycle.candidateRef, "string");
      assert.ok(cycle.candidateRef.startsWith("refs/pi-review-gate/waves/"));
    }

    // The accepted worker ref is create-once and pins the exact passed commit.
    assert.equal(result.acceptedRef, workerRefName(capture.waveId, "task-alias-lifecycle"));
    assert.equal(
      await gitInRepo(["rev-parse", result.acceptedRef!], capture.repositoryPath),
      result.acceptedCommitSha,
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: completed review cycles persist durable official records before final settlement (#50)", async () => {
  const root = await mkTmp("pi-wwl-durablereview-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-durable-review");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-durable-review");
    await mkdir(artifactDir, { recursive: true });

    // The executor writes the initial candidate on turn 1 and a different
    // file on correction turns (PI_REVIEW_EXECUTOR_TURN), so the second cycle
    // reviews a new candidate instead of tripping no-progress detection.
    const firstCommand = join(root, "durable-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const turn = Number(process.env.PI_REVIEW_EXECUTOR_TURN || '1');",
      "if (turn === 1) fs.writeFileSync('initial.txt', 'initial\\n');",
      "else fs.writeFileSync('corrected.txt', 'corrected\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'durable-review-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Turn ' + turn + ' complete.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const config = buildNeedsChangesReviewerConfig(firstCommand);
    config.maxCorrectionCycles = 1;

    let correctingAsserted: Promise<void> | undefined;

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-durable-review",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => {
        if (update.phase !== "correcting" || correctingAsserted) return;
        correctingAsserted = (async () => {
          // While the worker is actively correcting, the completed review
          // cycle must already be durably persisted and no final result may
          // exist yet.
          let resultExists = true;
          try { await access(join(artifactDir, "result.json")); } catch { resultExists = false; }
          assert.equal(resultExists, false, "result.json must not exist while the correction turn is active");
          const during = JSON.parse(await readFile(
            join(artifactDir, "reviews", capture.waveId, "cycle-000001.json"), "utf8"));
          assert.equal(during.aggregate, "needs_changes");
        })();
      },
    });
    // The assertions captured during the "correcting" phase must have held.
    if (correctingAsserted) await correctingAsserted;
    assert.ok(correctingAsserted, "the lifecycle must enter an active correction turn");

    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
    assert.equal(result.reviewCycles.length, 2, "two review cycles completed");

    // Both completed cycles are durably persisted with official identity.
    for (const cycle of result.reviewCycles) {
      const path = join(artifactDir, "reviews", capture.waveId, `cycle-${String(cycle.cycle).padStart(6, "0")}.json`);
      const record = JSON.parse(await readFile(path, "utf8"));
      assert.equal(record.version, 1);
      assert.equal(record.taskId, "task-durable-review");
      assert.equal(record.waveId, capture.waveId);
      assert.equal(record.cycle, cycle.cycle);
      assert.equal(typeof record.reviewSequence, "number");
      assert.equal(record.aggregate, "needs_changes");
      assert.equal(record.candidate.commitSha, cycle.candidateCommit, "record pins the reviewed candidate");
      assert.equal(record.candidate.treeSha, cycle.candidateTreeSha);
      assert.equal(record.candidate.ref, cycle.candidateRef, "record carries the immutable cycle alias");
      assert.ok(Array.isArray(record.reviewers) && record.reviewers.length >= 1);
      const blocking = record.reviewers[0];
      assert.equal(blocking.verdict, "needs_changes");
      assert.equal(blocking.findings[0].severity, "blocking");
      assert.equal(blocking.findings[0].file, "x.ts");
      assert.equal(blocking.findings[0].issue, "missing test");
      assert.equal(blocking.findings[0].recommendation, "add coverage");
    }

    // The final result still settles normally and agrees with the durable records.
    const settled = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
    assert.equal(settled.status, "correction_cap");
    assert.equal(settled.reviewReport.aggregate, "needs_changes");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: a failed record publication leaves an explicit marker and never alters the lifecycle (#50)", async () => {
  const root = await mkTmp("pi-wwl-pubfail-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-pubfail");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-pubfail");
    await mkdir(artifactDir, { recursive: true });

    // The executor writes a different file per turn (PI_REVIEW_EXECUTOR_TURN),
    // so every cycle reviews a new candidate instead of tripping no-progress
    // detection. With maxCorrectionCycles = 2, a correction turn is still
    // active after cycle 2's failed publication.
    const firstCommand = join(root, "pubfail-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const turn = Number(process.env.PI_REVIEW_EXECUTOR_TURN || '1');",
      "if (turn === 1) fs.writeFileSync('initial.txt', 'initial\\n');",
      "else fs.writeFileSync('corrected-' + turn + '.txt', 'corrected\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'pubfail-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Turn ' + turn + ' complete.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const config = buildNeedsChangesReviewerConfig(firstCommand);
    config.maxCorrectionCycles = 2;

    let secondCorrecting: Promise<void> | undefined;
    // Fail only cycle 2's record publication (before its atomic commit point),
    // leaving no file; the marker write for the same cycle must still succeed.
    setDurableWriteFaultInjectionForTesting((stage, path) => {
      if (stage === "before_rename" && path.endsWith("cycle-000002.json")) {
        throw new Error("injected: review cycle record publication failed");
      }
    });
    try {
      const result = await runWaveWorkerLifecycle({
        sourceRoot: capture.discovery.captureRoot,
        taskId: "task-pubfail",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir,
        config,
        onUpdate: (update) => {
          // The lifecycle's correction loop emits "correction N/M"; the
          // executor-turn runner also reports phase "correcting" for resume
          // bookkeeping, so key on the exact correction-loop message.
          if (update.phase !== "correcting" || update.message !== `correction 2/${config.maxCorrectionCycles}`) return;
          if (!secondCorrecting) {
            secondCorrecting = (async () => {
              // Active correction after cycle 2's failed publication: no final
              // result exists, cycle 1 is readable, and cycle 2 left only its
              // explicit marker — never a silent gap.
              let resultExists = true;
              try { await access(join(artifactDir, "result.json")); } catch { resultExists = false; }
              assert.equal(resultExists, false, "result.json must not exist while the correction turn is active");
              const record1 = JSON.parse(await readFile(
                join(artifactDir, "reviews", capture.waveId, "cycle-000001.json"), "utf8"));
              assert.equal(record1.aggregate, "needs_changes");
              let record2Exists = true;
              try { await access(join(artifactDir, "reviews", capture.waveId, "cycle-000002.json")); } catch { record2Exists = false; }
              assert.equal(record2Exists, false, "the failed publication must not leave a record file");
              const marker = JSON.parse(await readFile(
                join(artifactDir, "reviews", capture.waveId, "cycle-000002.json.unpublished"), "utf8"));
              assert.equal(marker.version, 1);
              assert.equal(marker.taskId, "task-pubfail");
              assert.equal(marker.waveId, capture.waveId);
              assert.equal(marker.cycle, 2);
              assert.equal(typeof marker.reviewSequence, "number");
              assert.equal(marker.aggregate, "needs_changes", "the official gate verdict stays visible in the marker");
              assert.match(String(marker.reason), /injected/);
            })();
          }
        },
      });
      // The assertions captured during the second "correcting" phase must have held.
      if (secondCorrecting) await secondCorrecting;
      assert.ok(secondCorrecting, "the lifecycle must be actively correcting after cycle 2's failed publication");

      // The publication failure never alters the lifecycle itself.
      assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
      assert.equal(result.reviewCycles.length, 3, "all three review cycles completed");

      // The final result still settles with every official verdict (final-result
      // reconciliation is preserved), and cycle 3's record persisted normally.
      const settled = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
      assert.equal(settled.status, "correction_cap");
      assert.equal(settled.reviewCycles.length, 3);
      assert.equal(settled.reviewReport.aggregate, "needs_changes");
      await access(join(artifactDir, "reviews", capture.waveId, "cycle-000003.json"));
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: when both record and marker publication fail, currentness is never asserted (#50)", async () => {
  // A shared fault (ENOSPC, directory permissions) can prevent BOTH cycle 2's
  // record and its failure marker from publishing, leaving no durable trace of
  // the completed cycle at all. During the active correction that follows,
  // evidence reads must keep prior findings readable but must NOT assert the
  // older cycle current — currentness is never inferred from the absence of a
  // newer file; completeness uncertainty stays model-visible until settlement.
  const root = await mkTmp("pi-wwl-pubfail2-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-pubfail2");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-pubfail2");
    await mkdir(artifactDir, { recursive: true });

    // The executor writes a different file per turn (PI_REVIEW_EXECUTOR_TURN),
    // so every cycle reviews a new candidate instead of tripping no-progress
    // detection. With maxCorrectionCycles = 2, a correction turn is still
    // active after cycle 2's failed publications.
    const firstCommand = join(root, "pubfail2-first.cjs");
    await writeFile(firstCommand, [
      "const fs = require('node:fs');",
      "const turn = Number(process.env.PI_REVIEW_EXECUTOR_TURN || '1');",
      "if (turn === 1) fs.writeFileSync('initial.txt', 'initial\\n');",
      "else fs.writeFileSync('corrected-' + turn + '.txt', 'corrected\\n');",
      "console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'pubfail2-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: 'Turn ' + turn + ' complete.' }));",
    ].join("\n"), "utf8");
    await chmod(firstCommand, 0o755);

    const config = buildNeedsChangesReviewerConfig(firstCommand);
    config.maxCorrectionCycles = 2;

    let secondCorrecting: Promise<void> | undefined;
    // Reject both cycle 2's record and its .unpublished marker at the atomic
    // commit point — a shared durable-write failure, not two independent ones.
    setDurableWriteFaultInjectionForTesting((stage, path) => {
      if (stage === "before_rename"
        && (path.endsWith("cycle-000002.json") || path.endsWith("cycle-000002.json.unpublished"))) {
        throw new Error("injected: shared durable-write failure");
      }
    });
    try {
      const result = await runWaveWorkerLifecycle({
        sourceRoot: capture.discovery.captureRoot,
        taskId: "task-pubfail2",
        task: testTask(),
        capture,
        worktree: worker,
        artifactDir,
        config,
        onUpdate: (update) => {
          if (update.phase !== "correcting" || update.message !== `correction 2/${config.maxCorrectionCycles}`) return;
          if (!secondCorrecting) {
            secondCorrecting = (async () => {
              // Neither the record nor the marker exists: no durable trace.
              for (const name of ["cycle-000002.json", "cycle-000002.json.unpublished"]) {
                let exists = true;
                try { await access(join(artifactDir, "reviews", capture.waveId, name)); } catch { exists = false; }
                assert.equal(exists, false, `${name} must not exist`);
              }

              // Evidence read during active correction: prior findings stay readable…
              const bundle = await buildSubtaskEvidence({ taskId: "task-pubfail2", waveRoot: capture.waveRoot, artifactDir });
              const filtered = readSubtaskEvidence(bundle, { filter: "review" });
              assert.equal(filtered.entries?.length, 1, "cycle 1's reviewer verdict must stay inspectable");
              const found = readSubtaskEvidence(bundle, { find: "missing test" });
              assert.ok((found.matchSummary?.totalMatches ?? 0) >= 1, "cycle 1's findings must stay searchable");

              // …but its currentness is never asserted from the absence of a
              // newer file: latest available with unknown completeness.
              const lifecycle = readSubtaskEvidence(bundle, { filter: "lifecycle" });
              const status = (lifecycle.entries ?? []).find((entry) => entry.source.recordKey === "status" && entry.source.sourceId === `review:${capture.waveId}:cycle-000001`);
              assert.ok(status, "cycle 1 must carry a lifecycle status entry");
              assert.match(String(status!.preview), /latest available review evidence/);
              assert.match(String(status!.preview), /cannot be confirmed/);
              assert.ok(
                !String(status!.preview).includes("is the most recently completed review for this task"),
                "absence of a newer file must never prove currentness",
              );

              // Review-completeness uncertainty is model-visible in context.
              assert.equal(bundle.context?.review?.aggregate, "needs_changes", "the readable cycle is still summarized…");
              assert.match(bundle.context?.review?.caveat ?? "", /failed to publish without leaving a trace/);
            })();
          }
        },
      });
      // The assertions captured during the second "correcting" phase must have held.
      if (secondCorrecting) await secondCorrecting;
      assert.ok(secondCorrecting, "the lifecycle must be actively correcting after cycle 2's failed publications");

      // The shared publication failure never alters the lifecycle itself.
      assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
      assert.equal(result.reviewCycles.length, 3, "all three review cycles completed");

      // Final-result reconciliation is preserved: every official verdict still
      // settles into result.json.
      const settled = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
      assert.equal(settled.status, "correction_cap");
      assert.equal(settled.reviewCycles.length, 3);
      assert.equal(settled.reviewReport.aggregate, "needs_changes");
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── #175 subtask review layer selection ─────────────────────────────────────

/** A passing CLI reviewer that leaves a marker file behind when invoked. */
function markerPassReviewer(id: string, marker: string): ExternalAgentConfig {
  return {
    id,
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'used');` +
          "process.stdin.resume();process.stdin.on('end',()=>" +
          "process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})))",
      ],
      timeoutMs: 15_000,
    },
  };
}

test("lifecycle: subtask review off returns completed_unreviewed without invoking reviewers", async () => {
  const root = await mkTmp("pi-wwl-subtask-off-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-off");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-off");
    await mkdir(artifactDir, { recursive: true });
    const reviewerMarker = join(root, "reviewer-ran.txt");

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command, "fake-exec", [markerPassReviewer("subtask-rev", reviewerMarker)]);
    // Subtask review is explicitly off even though its own reviewer set is
    // populated and primary review remains on: neither may pull the subtask
    // layer back on.
    config.review = {
      primaryReviewers: [{ source: "external", id: "subtask-rev" }],
      subtaskReviewers: [{ source: "external", id: "subtask-rev" }],
      subtaskEnabled: false,
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-off",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true, "the change must be explicitly unreviewed");
    assert.ok(result.acceptedRef, "the changed candidate is still pinned on the unreviewed path");
    assert.equal(result.reviewCycles.length, 0, "no review cycles may be fabricated");
    assert.equal(result.reviewReport ?? undefined, undefined, "no review report may be fabricated");
    await assert.rejects(
      () => access(reviewerMarker),
      "the subtask reviewer must never be invoked while subtask review is off",
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: subtask review off ignores an invalid subtask selection", async () => {
  const root = await mkTmp("pi-wwl-subtask-off-invalid-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-off-invalid");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-off-invalid");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command);
    // The unreviewed path never resolves or validates the subtask selection,
    // so an unknown subtask reviewer id must not block completion.
    config.review = {
      subtaskReviewers: [{ source: "external", id: "missing-reviewer" }],
      subtaskEnabled: false,
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-off-invalid",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true);
    assert.equal(result.reviewCycles.length, 0);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: subtask review on uses the subtask reviewer set, not the primary set", async () => {
  const root = await mkTmp("pi-wwl-subtask-set-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-set");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-set");
    await mkdir(artifactDir, { recursive: true });
    const primaryMarker = join(root, "primary-reviewer-ran.txt");
    const subtaskMarker = join(root, "subtask-reviewer-ran.txt");

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command, "fake-exec", [
      markerPassReviewer("primary-rev", primaryMarker),
      markerPassReviewer("subtask-rev", subtaskMarker),
    ]);
    // A split configuration: the primary set and the subtask set are stored
    // separately, and subtask review must run only the subtask reviewers.
    config.review = {
      primaryReviewers: [{ source: "external", id: "primary-rev" }],
      subtaskReviewers: [{ source: "external", id: "subtask-rev" }],
    };
    const updates: Array<{ phase: string; message: string }> = [];

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-set",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.equal(result.reviewCycles.length, 1, "should have one review cycle");
    assert.equal(result.reviewCycles[0].verdict, "pass");
    await access(subtaskMarker);
    await assert.rejects(
      () => access(primaryMarker),
      "the primary reviewer set must never be invoked for subtask review",
    );
    assert.ok(
      updates.some((update) => update.phase === "reviewing" && update.message === "subtask-rev started"),
      "progress must name the subtask reviewer",
    );
    assert.ok(
      !updates.some((update) => update.phase === "reviewing" && update.message === "primary-rev started"),
      "progress must never name the primary reviewer for subtask review",
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: empty subtask reviewer set returns completed_unreviewed without using the primary set", async () => {
  const root = await mkTmp("pi-wwl-subtask-empty-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-empty");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-empty");
    await mkdir(artifactDir, { recursive: true });
    const primaryMarker = join(root, "primary-reviewer-ran.txt");

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command, "fake-exec", [markerPassReviewer("primary-rev", primaryMarker)]);
    // Subtask review stays on but its separate set is empty: the pre-split
    // no-reviewer semantics hold for the subtask layer, and the populated
    // primary set must not silently become the subtask reviewers.
    config.review = {
      primaryReviewers: [{ source: "external", id: "primary-rev" }],
      subtaskReviewers: [],
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-empty",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "completed_unreviewed", `expected completed_unreviewed, got ${result.status}`);
    assert.equal(result.unreviewed, true);
    assert.equal(result.reviewCycles.length, 0);
    await assert.rejects(
      () => access(primaryMarker),
      "the primary reviewer set must not be invoked as a subtask fallback",
    );

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: primary toggle off leaves subtask review independent", async () => {
  const root = await mkTmp("pi-wwl-subtask-independent-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-independent");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-independent");
    await mkdir(artifactDir, { recursive: true });
    const subtaskMarker = join(root, "subtask-reviewer-ran.txt");

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command, "fake-exec", [markerPassReviewer("subtask-rev", subtaskMarker)]);
    // Primary automatic review is off; the subtask layer must still review.
    config.review = {
      primaryEnabled: false,
      subtaskReviewers: [{ source: "external", id: "subtask-rev" }],
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-independent",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.equal(result.reviewCycles[0].verdict, "pass");
    await access(subtaskMarker);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: unknown subtask reviewer id still blocks review", async () => {
  const root = await mkTmp("pi-wwl-subtask-unknown-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-unknown");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-unknown");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const config = buildConfig(command);
    config.review = {
      subtaskReviewers: [{ source: "external", id: "missing-reviewer" }],
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-unknown",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "reviewer_blocked", `expected reviewer_blocked, got ${result.status}`);
    assert.match(result.error ?? "", /unknown enabled reviewer ids/);
    assert.ok(!result.acceptedRef, "fail-closed blocking must not pin a candidate");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: duplicate subtask reviewer ids still block review", async () => {
  const root = await mkTmp("pi-wwl-subtask-dup-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-subtask-dup");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-subtask-dup");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    const reviewer = markerPassReviewer("subtask-rev", join(root, "marker.txt"));
    const config = buildConfig(command, "fake-exec", [reviewer]);
    config.review = {
      subtaskReviewers: [
        { source: "external", id: "subtask-rev" },
        { source: "external", id: "subtask-rev" },
      ],
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-subtask-dup",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "reviewer_blocked", `expected reviewer_blocked, got ${result.status}`);
    assert.match(result.error ?? "", /duplicate enabled reviewer ids/);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── Subtask review workspace-validity criterion (#179) ───────────────────────

test("lifecycle: subtask review request carries the hard candidate workspace-validity criterion", async () => {
  const root = await mkTmp("pi-wwl-validity-prompt-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-validity-prompt");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-validity-prompt");
    await mkdir(artifactDir, { recursive: true });

    const { command } = await createFakeExecutor(root);
    // Deterministic reviewer: passes only when the subtask review request
    // carries the workspace-validity criterion; otherwise blocks. This tests
    // prompt delivery, not that an LLM would follow the instruction.
    const reviewerScript = [
      "process.stdin.resume();let s='';",
      "process.stdin.on('data',c=>s+=c);",
      "process.stdin.on('end',()=>{",
      "const ok=s.includes('Candidate workspace validity (hard criterion)')",
      "&& s.includes('needs_changes with a path-specific actionable reason')",
      "&& s.includes('Gitlinks (submodule entries)')",
      "&& s.includes('harmless temp-like name')",
      "&& s.includes('pre-existing untracked files outside the candidate')",
      "&& s.includes('full test-suite run alone')",
      "&& s.includes('a task without a verified candidate cannot be reviewed');",
      "process.stdout.write(JSON.stringify(ok",
      "?{verdict:'pass',summary:'criterion delivered',findings:[]}",
      ":{verdict:'needs_changes',summary:'criterion missing',findings:[{severity:'blocking',file:'prompt',line:null,issue:'workspace-validity criterion missing',recommendation:'deliver the criterion in the subtask review request'}]}));",
      "});",
    ].join("");
    const reviewer = cliReviewerAgent("validity-prompt-checker", reviewerScript);
    const baseConfig = buildConfig(command, "fake-exec", [reviewer]);
    const config: ReviewGateConfig = {
      ...baseConfig,
      enabled: true,
      review: { subtaskReviewers: [{ source: "external", id: "validity-prompt-checker" }] },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-validity-prompt",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.equal(result.reviewCycles[0].verdict, "pass");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle: workspace-validity defect blocks acceptance until the candidate is corrected", async () => {
  const root = await mkTmp("pi-wwl-validity-defect-");
  try {
    const { capture } = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-validity-defect");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-validity-defect");
    await mkdir(artifactDir, { recursive: true });

    const unwantedFile = "scratch-diagnostic.txt";
    // Synthetic executor: initial turn leaves a task-generated diagnostic file
    // in the candidate; the correction turn removes it.
    const executor = join(root, "validity-defect-executor.cjs");
    await writeFile(executor, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const resumed = process.env.PI_REVIEW_EXECUTOR_OPERATION === 'resume';",
      "fs.writeFileSync(path.join(process.cwd(), 'worker-output.txt'), 'worker done\\n');",
      "if (resumed) { fs.rmSync(path.join(process.cwd(), 'scratch-diagnostic.txt'), { force: true }); }",
      "else { fs.writeFileSync(path.join(process.cwd(), 'scratch-diagnostic.txt'), 'internal diagnostic noise\\n'); }",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'validity-defect-session' }));",
      "console.log(JSON.stringify({ type: 'assistant', text: resumed ? 'Removed the unwanted diagnostic file.' : 'Implemented the change.' }));",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);

    // Deterministic reviewer: when the candidate patch contains the unwanted
    // generated file, it must be needs_changes with a path-specific finding;
    // once the candidate is clean (and the criterion is present), it passes.
    const reviewerScript = [
      "process.stdin.resume();",
      "let s='';",
      "process.stdin.on('data',c=>s+=c);",
      "process.stdin.on('end',()=>{",
      "if (!s.includes('Candidate workspace validity (hard criterion)')) {",
      "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'criterion missing',findings:[{severity:'blocking',file:'prompt',line:null,issue:'criterion missing',recommendation:'deliver the criterion'}]})); return; }",
      `if (s.includes(${JSON.stringify(unwantedFile)})) {`,
      "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'unwanted generated file inside the candidate',findings:[{severity:'blocking',file:'scratch-diagnostic.txt',line:null,issue:'task-generated diagnostic file inside the candidate',recommendation:'remove scratch-diagnostic.txt from the workspace'}]})); return; }",
      "process.stdout.write(JSON.stringify({verdict:'pass',summary:'candidate workspace valid',findings:[]}));",
      "});",
    ].join("");
    const reviewer = cliReviewerAgent("validity-defect-checker", reviewerScript);
    const baseConfig = buildConfig(executor, "fake-exec", [reviewer]);
    const config: ReviewGateConfig = {
      ...baseConfig,
      enabled: true,
      maxCorrectionCycles: 2,
      review: { subtaskReviewers: [{ source: "external", id: "validity-defect-checker" }] },
    };

    const result = await runWaveWorkerLifecycle({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-validity-defect",
      task: testTask(),
      capture,
      worktree: worker,
      artifactDir,
      config,
    });

    // A verified candidate workspace defect must block acceptance/landing
    // until the path-specific correction lands; the clean replacement passes.
    assert.equal(result.status, "accepted", `expected accepted, got ${result.status}`);
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "pass"]);
    assert.equal(result.reviewCycles[0].reviewOutput.result?.findings?.[0]?.file, unwantedFile);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic built-in worker prompt does not carry the subtask review validity criterion", () => {
  const prompt = buildWaveWorkerPrompt(
    testTask(),
    "/source-root-placeholder",
    "/worker-root-placeholder",
  );
  assert.ok(!prompt.includes("Candidate workspace validity (hard criterion)"));
  assert.ok(!prompt.includes("needs_changes with a path-specific actionable reason"));
  assert.ok(prompt.includes("Workspace snapshot disclosure:"));
});
