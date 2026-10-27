/**
 * Issue #533 continuation no-regression.
 *
 * A Pi turn that cannot reopen its native session must never be left with
 * continuation-only text (which assumes the previous session's task, acceptance
 * criteria, acknowledged updates, and current instructions are still in its
 * history). The lifecycle therefore keeps carrying the SAME full-task handoff it
 * already had for a fresh session, and the adapter may use it for that fresh
 * session. These tests pin the shapes that must not lose anything:
 *
 * 1. An in-place continuation with a compatible retained session still receives
 *    the existing resumed-session continuation text, and the session reaching
 *    the adapter is IDENTITY only — no duplicated transcript path or workspace.
 * 2. An in-place session the adapter cannot reopen still runs the existing
 *    full-task handoff instead of refusing: no lost task, no burned incident,
 *    and no prior-transcript replay.
 * 3. In-place same-adapter retries and executor failover keep carrying a
 *    complete task handoff alongside their existing prompts.
 * 4. The delegated (cross-executor) continuation keeps its existing handoff
 *    inputs, worker workspace, and verified checkpoint when the executor
 *    changes mid-continuation.
 *
 * Synthetic adapters, scripted child executors, and tmpdir scratch only: no
 * user settings, no native session store, no credentials, and no live `dist/`.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, resolvedExecutorPool, resolvedWorkerResources, type ReviewGateConfig } from "../src/config";
import {
  buildInPlaceContinuationDisclosure,
  buildInPlacePrompt,
  runInplaceLifecycle,
  type InPlaceLifecycleResult,
  type InPlaceWorkerResult,
} from "../src/execution/inplace-worker";
import { ExecutorLifecycleError, type ExecutorAdapter, type ExecutorRequest, type ExecutorTurn } from "../src/execution/types";
import { captureWaveBase, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import { resumeWaveWorker, runWaveWorker, type WaveWorkerTask } from "../src/execution/wave-worker";

// ── fixtures ────────────────────────────────────────────────────────────────

const TASK = {
  title: "Carry the whole task across a session change",
  instructions: "INPLACE-533-TASK: finish the handoff slice in this workspace.",
  acceptanceCriteria: ["INPLACE-533-ACCEPTANCE: a fresh session still knows the task"],
  relevantContext: "INPLACE-533-CONTEXT: the prior transcript is not replayed.",
};

const CONTINUATION = "INPLACE-533-CONTINUATION: address the reviewer finding.";

/** The existing in-place fresh-session continuation payload, composed here so a
 * change to the one construction the lifecycle reuses is caught loudly. */
function expectedFullTaskHandoff(workspaceRoot: string): string {
  return [
    buildInPlacePrompt(TASK, workspaceRoot),
    "",
    buildInPlaceContinuationDisclosure(false),
    "",
    "Current continuation instructions:",
    CONTINUATION,
  ].join("\n");
}

interface ObservedRequest {
  prompt: string;
  handoffPrompt?: string;
  session?: { adapter: string; id: string };
  sessionKeys: string[];
}

function completedTurn(text: string, sessionId: string): ExecutorTurn {
  return {
    text,
    session: { adapter: "pi-model", id: sessionId },
    stdoutPath: "",
    stderrPath: "",
    code: 0,
    timedOut: false,
    aborted: false,
  };
}

function failedTurn(message: string, sessionId: string): ExecutorTurn {
  return { ...completedTurn("", sessionId), code: null, failure: { category: "provider", message } };
}

/** An adapter that records exactly what the in-place turn loop handed it. */
function recordingAdapter(
  requests: ObservedRequest[],
  respond: (request: ExecutorRequest, attempt: number) => ExecutorTurn,
): ExecutorAdapter {
  let calls = 0;
  return {
    kind: "pi-model",
    toolEventObservability: { mode: "unavailable", description: "test adapter exposes no structured tool-event stream" },
    async run(request) {
      calls += 1;
      requests.push({
        prompt: request.prompt,
        ...(request.handoffPrompt === undefined ? {} : { handoffPrompt: request.handoffPrompt }),
        ...(request.session === undefined ? {} : { session: request.session }),
        sessionKeys: Object.keys(request.session ?? {}).sort(),
      });
      return respond(request, calls);
    },
  };
}

function inPlaceConfig(options?: {
  backupExecutor?: boolean;
  maxRetries?: number;
}): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "inplace-533": {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [] },
      },
      ...(options?.backupExecutor ? {
        "inplace-533-backup": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [] },
        },
      } : {}),
    },
    execution: {
      maxWorkers: 1,
      retryPolicy: {
        maxRetries: options?.maxRetries ?? 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        maxSameIncidentRepeats: 1,
      },
      workerResources: {
        default: { selection: { source: "external", id: "inplace-533" }, maxConcurrent: 1 },
        ...(options?.backupExecutor ? {
          backup: { selection: { source: "external", id: "inplace-533-backup" }, maxConcurrent: 1 },
        } : {}),
      },
      routes: {
        execute: [{ resourceId: "default" }, ...(options?.backupExecutor ? [{ resourceId: "backup" }] : [])],
        research: [],
      },
    },
    retainBundles: "always",
  });
}

async function scratch(unique: string): Promise<{ root: string; workspace: string; artifactDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `prg-i533-${unique}-`)));
  const workspace = join(root, "workspace");
  const artifactDir = join(root, "artifacts", "task");
  await mkdir(workspace, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(workspace, "seed.txt"), "launch state\n", "utf8");
  return { root, workspace, artifactDir };
}

/** Run one initial in-place dispatch and return its result plus what the adapter saw. */
async function runInitial(input: {
  taskId: string;
  workspace: string;
  artifactDir: string;
  config: ReviewGateConfig;
  adapter: ExecutorAdapter;
}): Promise<InPlaceLifecycleResult> {
  const entry = resolvedExecutorPool(input.config)[0];
  assert.ok(entry, "the fixture pool must expose the default in-place resource");
  return await runInplaceLifecycle({
    taskId: input.taskId,
    task: TASK,
    workspaceRoot: input.workspace,
    artifactDir: input.artifactDir,
    config: input.config,
    executorAssignment: { entry, priority: 0 },
    adapterFactory: () => input.adapter,
  });
}

/** Retain one completed dispatch as the durable prior result of a continuation. */
function retained(result: InPlaceLifecycleResult): InPlaceWorkerResult {
  return {
    status: "completed",
    taskId: result.taskId,
    title: result.title,
    summary: result.summary,
    ...(result.session === undefined ? {} : { session: result.session }),
    adapter: result.adapter,
    ...(result.model === undefined ? {} : { model: result.model }),
    error: result.error,
    operationRecord: result.operationRecord,
    incidents: result.incidents ?? [],
    attempts: result.attempts ?? 1,
    ...(result.lastExecutorTurn === undefined ? {} : { lastExecutorTurn: result.lastExecutorTurn }),
  };
}

async function runContinuation(input: {
  taskId: string;
  workspace: string;
  artifactDir: string;
  config: ReviewGateConfig;
  prior: InPlaceWorkerResult;
  baseline: InPlaceLifecycleResult["baseline"];
  adapter: ExecutorAdapter;
  backupAdapter?: ExecutorAdapter;
}): Promise<InPlaceLifecycleResult> {
  const [entry, backup] = resolvedExecutorPool(input.config);
  assert.ok(entry);
  return await runInplaceLifecycle({
    taskId: input.taskId,
    task: TASK,
    workspaceRoot: input.workspace,
    artifactDir: input.artifactDir,
    config: input.config,
    executorAssignment: { entry, priority: 0 },
    adapterFactory: (_config, selection) => (
      input.backupAdapter && selection.source === "external" && selection.id === "inplace-533-backup"
        ? input.backupAdapter
        : input.adapter
    ),
    baseline: input.baseline,
    initialResult: input.prior,
    continuation: { instructions: CONTINUATION },
    ...(input.backupAdapter && backup ? {
      acquireFailover: async (current) => (
        current.entry.entryId === "default" ? { entry: backup, priority: 1 } : undefined
      ),
    } : {}),
  });
}

/** Every settled non-failure lifecycle disposition; the executor ran either way. */
function assertSettled(status: InPlaceLifecycleResult["status"], context: string): void {
  assert.ok(["reviewed", "unreviewed", "no_changes"].includes(status),
    `${context}, got ${status}`);
}

// ── 1. a compatible session still resumes, and identity is all the adapter gets ──

test("an in-place continuation resumes the retained session with the existing continuation text and carries the full-task handoff as its fallback", async () => {
  const { root, workspace, artifactDir } = await scratch("resume");
  const config = inPlaceConfig();
  const requests: ObservedRequest[] = [];
  try {
    const first = await runInitial({
      taskId: "inplace-533-resume",
      workspace,
      artifactDir,
      config,
      adapter: recordingAdapter(requests, () => completedTurn("first turn done", "inplace-533-session")),
    });
    assertSettled(first.status, "the initial dispatch must settle");
    assert.equal(first.session?.id, "inplace-533-session");

    const continued = await runContinuation({
      taskId: first.taskId,
      workspace,
      artifactDir,
      config,
      prior: retained(first),
      baseline: first.baseline,
      adapter: recordingAdapter(requests, (request) => {
        assert.equal(request.session?.id, "inplace-533-session", "the retained session is still resumed");
        return completedTurn("continued in the same session", "inplace-533-session");
      }),
    });
    assertSettled(continued.status, "the continuation must complete");

    const [initialRequest, continuationRequest] = requests;
    // Existing resumed-session behavior is untouched: the continuation turn
    // still delivers the resumed disclosure plus the current instructions.
    assert.match(continuationRequest.prompt, /Your previous executor session is being resumed\./);
    assert.ok(continuationRequest.prompt.includes(CONTINUATION));
    assert.ok(!continuationRequest.prompt.includes("INPLACE-533-TASK"),
      "a resumed continuation stays continuation-only text, exactly as before");
    // #533: the fallback exists WITHOUT replacing the resumed prompt, and it is
    // precisely the existing full-task construction — no replay, no new payload.
    assert.equal(continuationRequest.handoffPrompt, expectedFullTaskHandoff(workspace));
    assert.ok(continuationRequest.handoffPrompt?.includes("INPLACE-533-TASK"));
    assert.ok(continuationRequest.handoffPrompt?.includes("INPLACE-533-ACCEPTANCE"));
    assert.ok(continuationRequest.handoffPrompt?.includes("INPLACE-533-CONTEXT"));
    assert.ok(continuationRequest.handoffPrompt?.includes(workspace), "the handoff names the in-place workspace");
    assert.ok(continuationRequest.handoffPrompt?.includes(CONTINUATION));
    // The session handed to the adapter is identity only: the transcript path and
    // workspace live only in the owner's canonical reference.
    assert.deepEqual(continuationRequest.sessionKeys, ["adapter", "id"],
      `no duplicated path state reaches the adapter: ${JSON.stringify(continuationRequest.session)}`);
    assert.deepEqual(initialRequest.sessionKeys, [], "the initial dispatch has no session, as before");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 2. an unverifiable session falls back to the handoff instead of refusing ──

// A faithful stand-in for the Pi adapter's rule: a session whose native history
// cannot be verified is never prompted with continuation-only text. With a
// full-task handoff it starts a fresh session from that handoff; without one it
// refuses before spawning. `failFirstAttempt` scripts one retryable failure so a
// retry's fallback can be observed.
function piLikeAdapter(
  requests: ObservedRequest[],
  delivered: string[],
  resumableSessionIds: ReadonlySet<string>,
  options?: { failFirstAttempt?: { message: string; sessionId: string } },
): ExecutorAdapter {
  let calls = 0;
  return {
    kind: "pi-model",
    toolEventObservability: { mode: "structured", description: "test structured tool events" },
    async run(request) {
      calls += 1;
      requests.push({
        prompt: request.prompt,
        ...(request.handoffPrompt === undefined ? {} : { handoffPrompt: request.handoffPrompt }),
        ...(request.session === undefined ? {} : { session: request.session }),
        sessionKeys: Object.keys(request.session ?? {}).sort(),
      });
      if (calls === 1 && options?.failFirstAttempt) {
        return failedTurn(options.failFirstAttempt.message, options.failFirstAttempt.sessionId);
      }
      if (request.session && !resumableSessionIds.has(request.session.id)) {
        if (!request.handoffPrompt) {
          throw new ExecutorLifecycleError(
            "protocol",
            "Cannot continue the prior Pi session without its verified history or a full-task handoff: the recorded session could not be verified",
          );
        }
        delivered.push(request.handoffPrompt);
        return completedTurn("completed from the full task handoff", "inplace-533-replacement");
      }
      delivered.push(request.prompt);
      return completedTurn("completed in the reopened session", request.session?.id ?? "inplace-533-initial");
    },
  };
}

test("an in-place turn whose native session cannot be reopened runs the existing full-task handoff instead of losing the task", async () => {
  const { root, workspace, artifactDir } = await scratch("fallback");
  const config = inPlaceConfig();
  const requests: ObservedRequest[] = [];
  const delivered: string[] = [];
  try {
    const first = await runInitial({
      taskId: "inplace-533-fallback",
      workspace,
      artifactDir,
      config,
      adapter: piLikeAdapter(requests, delivered, new Set(["inplace-533-initial"])),
    });
    assertSettled(first.status, "the initial turn must settle");
    assert.deepEqual(delivered[0], requests[0].prompt, "the initial turn is delivered as-is");

    // The retained session is one the adapter can no longer verify.
    requests.length = 0;
    delivered.length = 0;
    const continued = await runContinuation({
      taskId: first.taskId,
      workspace,
      artifactDir,
      config,
      prior: retained(first),
      baseline: first.baseline,
      adapter: piLikeAdapter(requests, delivered, new Set()),
    });
    assertSettled(continued.status,
      "the continuation must not be bricked by an unverifiable session");
    assert.equal(requests.length, 1, "the handoff fallback happens on the first attempt, not after burned retries");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0], expectedFullTaskHandoff(workspace),
      "the fresh session receives the complete existing task handoff, never continuation-only text");
    assert.ok(!delivered[0].includes("Your previous executor session is being resumed"),
      "a fresh session is never told the old session survived");
    assert.deepEqual(continued.incidents ?? [], [], "no incident is manufactured for a handled fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. retries and failover keep carrying a complete task handoff ───────────

test("an in-place same-adapter retry keeps the existing retry prompt and still carries the full-task handoff", async () => {
  const { root, workspace, artifactDir } = await scratch("retry");
  const config = inPlaceConfig({ maxRetries: 1 });
  const requests: ObservedRequest[] = [];
  try {
    const result = await runInitial({
      taskId: "inplace-533-retry",
      workspace,
      artifactDir,
      config,
      adapter: recordingAdapter(requests, (_request, attempt) => (
        attempt === 1
          ? failedTurn("429 provider unavailable", "inplace-533-retry-session")
          : completedTurn("completed after retry", "inplace-533-retry-session")
      )),
    });
    assertSettled(result.status, "the retry must recover");
    assert.equal(requests.length, 2);
    const [first, retry] = requests;
    assert.equal(first.handoffPrompt, buildInPlacePrompt(TASK, workspace),
      "the initial dispatch's handoff is its own complete task prompt");
    // Existing retry prose is unchanged, and a session that cannot be reopened
    // still has the whole task to fall back to.
    assert.match(retry.prompt, /The previous executor attempt was interrupted/);
    assert.match(retry.prompt, /Previous incident: .*429 provider unavailable/);
    // #533 F3: the fallback keeps the caller's exact full task AND the retry's
    // current recovery text (incident, no-checkpoint wording, continuation
    // instructions) — the same construction plus this attempt's retry prompt.
    assert.equal(retry.handoffPrompt, [retry.prompt, "", buildInPlacePrompt(TASK, workspace)].join("\n"),
      "the retry handoff composes the unchanged retry prompt with the unchanged full task");
    assert.ok(retry.handoffPrompt?.includes("INPLACE-533-ACCEPTANCE"));
    assert.ok(!retry.handoffPrompt?.includes("Recovery checkpoint"),
      "in-place execution still has no checkpoint, so none is invented");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #533 F3: a retry whose native session vanished must still deliver the current
// retry instructions and incident to the fresh session. Before the fix the
// adapter's fresh fallback delivered only the constant caller handoff, dropping
// the retry text the resumed session would have received.
test("an in-place continuation retry whose native session cannot be reopened delivers the current retry incident on top of the full task", async () => {
  const { root, workspace, artifactDir } = await scratch("retry-fallback");
  const config = inPlaceConfig({ maxRetries: 1 });
  const requests: ObservedRequest[] = [];
  const delivered: string[] = [];
  try {
    const first = await runInitial({
      taskId: "inplace-533-retry-fallback",
      workspace,
      artifactDir,
      config,
      adapter: recordingAdapter(requests, () => completedTurn("first turn done", "inplace-533-retry-fallback-session")),
    });
    assertSettled(first.status, "the initial dispatch must settle");
    requests.length = 0;
    const continued = await runContinuation({
      taskId: first.taskId,
      workspace,
      artifactDir,
      config,
      prior: retained(first),
      baseline: first.baseline,
      adapter: piLikeAdapter(requests, delivered, new Set(), {
        failFirstAttempt: { message: "429 provider unavailable", sessionId: "inplace-533-retry-fallback-session" },
      }),
    });
    assertSettled(continued.status, "the retry fallback must settle the task, not brick it");
    assert.equal(requests.length, 2, "the continuation attempt fails, then one retry runs");
    const [continuation, retry] = requests;
    // The continuation attempt's unchanged inputs: resumed continuation text for
    // the session, the existing full-task handoff as its fallback.
    assert.match(continuation.prompt, /Your previous executor session is being resumed\./);
    assert.equal(continuation.handoffPrompt, expectedFullTaskHandoff(workspace));
    assert.equal(delivered.length, 1, "only the retry turn reached a session, and it started fresh");
    assert.deepEqual(delivered, [retry.handoffPrompt]);
    // Unchanged resumed retry text: retry-only prose, no replayed task.
    assert.match(retry.prompt, /Previous incident: .*429 provider unavailable/);
    assert.ok(!retry.prompt.includes("INPLACE-533-TASK"), "the resumed retry prompt is unchanged");
    // The fresh-session fallback now carries BOTH the current retry instructions
    // and incident AND the exact full task, acceptance criteria, and current
    // continuation instructions — everything the resumed session would see.
    assert.ok(delivered[0]!.startsWith(retry.prompt), "the fallback opens with the same retry text the resumed session receives");
    assert.ok(delivered[0]!.endsWith(expectedFullTaskHandoff(workspace)),
      "the fallback still ends with the unchanged full-task handoff");
    assert.ok(delivered[0]!.includes("INPLACE-533-TASK"));
    assert.ok(delivered[0]!.includes("INPLACE-533-ACCEPTANCE"));
    assert.ok(delivered[0]!.includes("INPLACE-533-CONTEXT"));
    assert.ok(delivered[0]!.includes(CONTINUATION), "the current continuation instructions stay present");
    assert.ok(delivered[0]!.includes(workspace), "the same in-place workspace is named");
    assert.ok(!delivered[0]!.includes("Recovery checkpoint"), "no checkpoint is invented for in-place execution");
    assert.ok(!delivered[0]!.includes("Your previous executor session is being resumed"),
      "the fresh session is never told the old session survived");
    const operation = JSON.parse(await readFile(join(artifactDir, "operation.json"), "utf8")) as {
      incidents: Array<{ cause: string }>;
    };
    assert.deepEqual(operation.incidents.map((incident) => incident.cause), ["provider_error"],
      "the recovered failure is the only incident; the fallback manufactures none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an in-place failover replacement still receives the complete task, workspace, and current instructions", async () => {
  const { root, workspace, artifactDir } = await scratch("failover");
  const config = inPlaceConfig({ backupExecutor: true });
  const requests: ObservedRequest[] = [];
  try {
    const first = await runInitial({
      taskId: "inplace-533-failover",
      workspace,
      artifactDir,
      config,
      adapter: recordingAdapter(requests, () => completedTurn("first turn done", "inplace-533-failover-session")),
    });
    requests.length = 0;
    const replacementRequests: ObservedRequest[] = [];
    const continued = await runContinuation({
      taskId: first.taskId,
      workspace,
      artifactDir,
      config,
      prior: retained(first),
      baseline: first.baseline,
      adapter: recordingAdapter(requests, () => failedTurn("provider overloaded", "inplace-533-failover-session")),
      backupAdapter: recordingAdapter(replacementRequests, () => completedTurn("replacement finished", "inplace-533-replacement-session")),
    });
    assertSettled(continued.status, "the failover must recover");
    assert.equal(replacementRequests.length, 1);
    const replacement = replacementRequests[0];
    // A changed executor gets a NEW session (no cross-harness conversion) and the
    // whole task in hand: original task text, acceptance criteria, workspace, the
    // prior failure, and the current continuation instructions.
    assert.equal(replacement.session, undefined, "the replacement starts its own session");
    assert.ok(replacement.prompt.includes("INPLACE-533-TASK"), "the replacement carries the task");
    assert.ok(replacement.prompt.includes("INPLACE-533-ACCEPTANCE"));
    assert.ok(replacement.prompt.includes(workspace), "the replacement names the same in-place workspace");
    assert.match(replacement.prompt, /Prior executor failure: .*provider overloaded/);
    assert.ok(replacement.prompt.includes(CONTINUATION), "the replacement carries the current instructions");
    assert.equal(replacement.handoffPrompt, replacement.prompt,
      "the failover prompt is itself the complete handoff, so a fresh session loses nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 4. the delegated cross-executor handoff keeps its inputs and checkpoint ──

async function mkTmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function git(args: string[], cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  return stdout.trim();
}

const WAVE_TASK: WaveWorkerTask = {
  title: "Carry the handoff across an executor change",
  instructions: "WAVE-533-TASK: create worker-output.txt with the requested content.",
  acceptanceCriteria: ["WAVE-533-ACCEPTANCE: worker-output.txt exists with content"],
};

const WAVE_FEEDBACK = "WAVE-533-CONTINUATION: address the reviewer finding.";

/**
 * The delegated continuation's existing handoff contract, unchanged by #533:
 * when the executor serving a continuation changes and the prior executor fails,
 * the replacement starts its OWN session and receives the executor handoff
 * (verified checkpoint + prior failure) on top of the complete original task and
 * the current continuation instructions, addressed to the same worker worktree.
 */
test("a delegated continuation whose executor changes still receives the full handoff, workspace, and verified checkpoint", async () => {
  const root = await mkTmp("prg-i533-wave-");
  try {
    // The source repo, wave capture, artifacts, and worker worktree all live
    // under `root`, so the single `finally` removal leaves nothing behind. The
    // capture parent stays outside the source root, as captureWaveBase requires.
    const sourceDir = join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await git(["init", "--quiet"], sourceDir);
    await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
    await git(["add", "."], sourceDir);
    await git(["commit", "--quiet", "-m", "init"], sourceDir);
    const captureDir = join(root, "capture");
    await mkdir(captureDir, { recursive: true });
    const capture: WaveCaptureResult = await captureWaveBase({
      cwd: sourceDir,
      maxSnapshotBytes: 1_000_000,
      waveId: "i533-wave",
      artifactDir: captureDir,
    });
    const worker = await createWorkerWorktree(capture, "task-533-handoff");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-533-handoff");
    await mkdir(artifactDir, { recursive: true });
    const promptCapture = join(root, "replacement-prompt.txt");
    const identityCapture = join(root, "replacement-identity.json");

    // Primary executor: turn 1 completes, every later turn fails so the
    // continuation must fail over to the replacement resource.
    const primaryCommand = join(root, "primary.cjs");
    await writeFile(primaryCommand, [
      "const fs=require('node:fs'),path=require('node:path');",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN);",
      "if(turn<=1){",
      "  fs.writeFileSync(path.join(process.cwd(),'worker-output.txt'),'first pass\\n');",
      "  console.log(JSON.stringify({type:'session',sessionId:'wave-533-primary'}));",
      "  console.log(JSON.stringify({type:'assistant',text:'first pass complete'}));",
      "  process.exit(0);",
      "}",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID??'wave-533-primary'}));",
      "console.log(JSON.stringify({type:'error',message:'WAVE-533 primary provider failed'}));",
      "process.exit(1);",
    ].join("\n"), "utf8");
    // Replacement executor: records the exact prompt and whether it was handed a
    // session, then finishes the task.
    const replacementCommand = join(root, "replacement.cjs");
    await writeFile(replacementCommand, [
      "const fs=require('node:fs'),path=require('node:path');",
      `fs.writeFileSync(${JSON.stringify(promptCapture)},fs.readFileSync(0,'utf8'));`,
      `fs.writeFileSync(${JSON.stringify(identityCapture)},JSON.stringify({`,
      "  sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID??null,",
      "  operation: process.env.PI_REVIEW_EXECUTOR_OPERATION??null,",
      "  cwd: fs.realpathSync(process.cwd()),",
      "}));",
      "fs.writeFileSync(path.join(process.cwd(),'worker-output.txt'),'first pass\\nfinished by replacement\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:'wave-533-replacement'}));",
      "console.log(JSON.stringify({type:'assistant',text:'finished from the handoff'}));",
    ].join("\n"), "utf8");
    await chmod(primaryCommand, 0o755);
    await chmod(replacementCommand, 0o755);

    const config = normalizeConfig({
      enabled: true,
      execution: {
        maxWorkers: 1,
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
        workerResources: {
          primary: { selection: { source: "external", id: "wave-533-primary" }, maxConcurrent: 1 },
          backup: { selection: { source: "external", id: "wave-533-replacement" }, maxConcurrent: 1 },
        },
        routes: { execute: [{ resourceId: "primary" }, { resourceId: "backup" }], research: [] },
      },
      externalAgents: {
        "wave-533-primary": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [primaryCommand], timeoutMs: 30_000 },
        },
        "wave-533-replacement": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [replacementCommand], timeoutMs: 30_000 },
        },
      },
    });
    const pool = resolvedWorkerResources(config);
    assert.equal(pool.length, 2);

    const first = await runWaveWorker({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-533-handoff",
      task: WAVE_TASK,
      capture,
      worktree: worker,
      artifactDir,
      config,
      executorAssignment: { entry: pool[0]!, priority: 0 },
    });
    assert.equal(first.status, "completed", `the initial turn must complete: ${first.error ?? ""}`);
    assert.ok(first.candidate, "the initial turn produces the durable candidate the checkpoint names");

    const continued = await resumeWaveWorker({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-533-handoff",
      task: WAVE_TASK,
      capture,
      worktree: worker,
      artifactDir,
      config,
      priorResult: first,
      feedback: WAVE_FEEDBACK,
      turn: 2,
      executorAssignment: { entry: pool[0]!, priority: 0 },
      acquireFailover: async (assignment) => (
        assignment.entry.entryId === "primary" ? { entry: pool[1]!, priority: 1 } : undefined
      ),
    });
    assert.equal(continued.status, "completed", `the failover must complete the continuation: ${continued.error ?? ""}`);
    assert.equal(continued.session?.id, "wave-533-replacement", "the replacement runs its own session");

    const prompt = await readFile(promptCapture, "utf8");
    const identity = JSON.parse(await readFile(identityCapture, "utf8")) as { sessionId: string | null; operation: string | null; cwd: string };
    assert.equal(identity.operation, "start", "the replacement starts its own session instead of resuming");
    assert.notEqual(identity.sessionId, "wave-533-primary",
      "no prior session handle crosses to a different executor");
    assert.equal(identity.cwd, await realpath(worker.worktreeRoot), "the replacement works in the same worker worktree");
    // The existing handoff inputs are all still there.
    assert.match(prompt, /Executor handoff \(authoritative\)/);
    assert.match(prompt, /Prior executor failure: \S/, "the prior failure stays disclosed");
    assert.match(prompt, /Verified checkpoint:/, "the verified checkpoint is still handed over");
    assert.ok(prompt.includes("WAVE-533-TASK"), "the replacement receives the original task");
    assert.ok(prompt.includes("WAVE-533-ACCEPTANCE"), "the replacement receives the acceptance criteria");
    assert.ok(prompt.includes(await realpath(worker.worktreeRoot)), "the replacement is addressed to the worker workspace");
    assert.ok(prompt.includes("Current continuation instructions:") && prompt.includes(WAVE_FEEDBACK),
      "the replacement receives the current continuation instructions");

    // The durable checkpoint identity survives the executor change.
    const operation = JSON.parse(await readFile(join(artifactDir, "operation.json"), "utf8")) as {
      checkpoint?: { commitSha?: string; verified?: boolean };
    };
    assert.ok(operation.checkpoint?.verified, "the operation keeps a verified durable checkpoint");
    assert.equal(operation.checkpoint.commitSha, continued.checkpoint?.commitSha,
      "the reported checkpoint is the durable one the handoff named");

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
