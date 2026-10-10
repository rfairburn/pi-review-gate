// Issue #220: the in-place subtask worker kind. Focused coverage for the
// launch-time attribution basis, prompt/containment contracts, reviewer
// disclosure wording, and the controller lifecycle (non-Git workspace, no
// capture or landing, own reviewer settling `reported`, refusal of the
// landing-only operations, scheduled dispatch through the ordinary start
// path, and subtask-tool exclusion from the child catalog). Execute/research
// behavior stays covered by its existing suites and is unchanged here.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import {
  assertInPlaceArtifactOutsideWorkspace,
  buildInPlacePrompt,
  buildInPlaceReviewRequest,
  computeInPlaceAttribution,
  createInPlaceBaseline,
  inPlaceDeltaIdentity,
  INPLACE_BASELINE_FILE,
  loadInPlaceBaseline,
  persistInPlaceBaseline,
  runInplaceLifecycle,
  type InPlaceAttribution,
  type InPlaceBaseline,
  type InPlaceWorkerResult,
} from "../src/execution/inplace-worker";
import { normalizeConfig, resolvedExecutorPool, type ReviewGateConfig } from "../src/config";
import type { ExecutorAdapter } from "../src/execution/types";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";
import { waitFor } from "./helpers/background-controller-fixtures";

/** Restore an env var to its exact prior state: assigned when it was present, deleted when absent. */
function restoreEnvSetting(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

/** Wait for a truthy value; returns it once present (bounded). */
async function createInPlaceScratch(prefix: string): Promise<string> {
  return mkdtemp(join(process.cwd(), `.pi-review-inplace-${prefix}-`));
}

async function waitForValue<T>(fetch: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fetch();
    if (value !== undefined && value !== null && !(typeof value === "boolean" && value === false)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for value");
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** Bounded wait until an async predicate holds. */
async function waitForAsyncTrue(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((done) => setTimeout(done, 25));
  }
}

const execFileAsync = promisify(execFile);
const executionToolNamesLocal = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

const boundedConfig: ReviewGateConfig = normalizeConfig({
  enabled: true,
  maxFileBytes: 64 * 1024,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxPatchBytes: 64 * 1024,
  review: { activeReviewers: [] },
});

// ── attribution basis (launch snapshot + recorded delta) ────────────────────

test("in-place attribution tracks a non-Git workspace without claiming any repository anchor", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-inplace-nogit-"));
  try {
    await writeFile(join(workspace, "seed.txt"), "seed\n", "utf8");
    const baseline = await createInPlaceBaseline(workspace, boundedConfig);
    assert.equal(baseline.mode, "non_git");
    assert.equal(baseline.gitHead, undefined);
    assert.equal(baseline.gitRepositoryRoot, undefined);
    assert.equal(baseline.snapshot.files.get("seed.txt")?.content, "seed\n");

    // One simulated worker turn: add a file and modify an existing one.
    await writeFile(join(workspace, "added.txt"), "added\n", "utf8");
    await writeFile(join(workspace, "seed.txt"), "seed changed\n", "utf8");
    const attribution = await computeInPlaceAttribution(baseline, boundedConfig);
    const byPath = new Map(attribution.changes.map((change) => [change.path, change.status]));
    assert.equal(byPath.get("added.txt"), "added");
    assert.equal(byPath.get("seed.txt"), "modified");
    assert.equal(attribution.gitHeadMoved, undefined, "non-Git workspaces carry no HEAD fields");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("in-place attribution records a Git HEAD basis and discloses HEAD movement instead of claiming a candidate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-inplace-git-"));
  const git = async (args: string[]): Promise<void> => {
    await execFileAsync("git", args, { cwd: workspace });
  };
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "one\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "base"]);
    const baseline = await createInPlaceBaseline(workspace, boundedConfig);
    assert.equal(baseline.mode, "git");
    assert.ok(baseline.gitHead && /^[0-9a-f]{40}$/.test(baseline.gitHead));
    assert.ok(baseline.gitRepositoryRoot, "the repository top level is recorded");

    // Working-tree-style change with no commits.
    await writeFile(join(workspace, "tracked.txt"), "two\n", "utf8");
    await writeFile(join(workspace, "untracked.txt"), "new\n", "utf8");
    let attribution = await computeInPlaceAttribution(baseline, boundedConfig);
    assert.equal(attribution.gitHeadMoved, false);
    const statuses = new Map(attribution.changes.map((change) => [change.path, change.status]));
    assert.equal(statuses.get("tracked.txt"), "modified");
    assert.equal(statuses.get("untracked.txt"), "added");

    // A commit inside the workspace moves HEAD: disclosed as a moved anchor,
    // never presented as the reviewed candidate.
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "worker commit"]);
    attribution = await computeInPlaceAttribution(baseline, boundedConfig);
    assert.equal(attribution.gitHeadMoved, true);
    assert.notEqual(attribution.gitCurrentHead, baseline.gitHead);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ── prompt, artifact containment, and reviewer disclosure ────────────────────

test("the in-place prompt forbids subtask recursion and states the in-place write contract", () => {
  const task = {
    title: "Prepare checkout",
    instructions: "Clone the repository into this workspace",
    acceptanceCriteria: ["Checkout present"],
  };
  const prompt = buildInPlacePrompt(task, "/tmp/somewhere/workspace");
  assert.match(prompt, /in-place implementation executor/);
  assert.match(prompt, /designated task workspace: \/tmp\/somewhere\/workspace/);
  assert.match(prompt, /Never launch child subtasks|no subtask tools are available here/);
  assert.match(prompt, /no wave capture/);
  assert.match(prompt, /do not commit, push/i);
  assert.match(prompt, /summarize exactly what you changed/);
  assert.match(prompt, /external side effect/);
});

test("in-place artifact containment refuses paths inside the workspace before any mkdir", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-inplace-contain-"));
  try {
    // Refused: directly inside the workspace.
    await assert.rejects(
      assertInPlaceArtifactOutsideWorkspace(join(workspace, "artifacts", "task-1"), workspace),
      /outside the workspace/,
    );
    // Refused: a nested path whose existing ancestor already sits inside.
    await mkdir(join(workspace, "sub"), { recursive: true });
    await assert.rejects(
      assertInPlaceArtifactOutsideWorkspace(join(workspace, "sub", "deeper"), workspace),
      /outside the workspace/,
    );
    // Allowed: a sibling outside the workspace resolves and is not created by the assertion itself.
    const outside = join(await realpath(workspace), "..", "pi-review-inplace-artifacts-ok");
    await rm(outside, { recursive: true, force: true });
    await assertInPlaceArtifactOutsideWorkspace(join(outside, "artifacts", "task-1"), workspace);
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the in-place review request discloses the recorded delta and the attribution boundary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-inplace-review-req-"));
  try {
    await writeFile(join(workspace, "a.txt"), "a\n", "utf8");
    const baseline = await createInPlaceBaseline(workspace, boundedConfig);
    await writeFile(join(workspace, "a.txt"), "a changed\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "b\n", "utf8");
    const attribution = await computeInPlaceAttribution(baseline, boundedConfig);
    const task = {
      title: "Edit the file",
      instructions: "Update a.txt",
      acceptanceCriteria: ["a.txt says 'a changed'"],
    };
    const request = buildInPlaceReviewRequest(task, attribution);
    assert.match(request, /In-place workspace disclosure \(authoritative\)/);
    assert.match(request, new RegExp(escapeForRegex(attribution.baseline.workspaceRoot)));
    assert.match(request, /modified: a\.txt/);
    assert.match(request, /added: b\.txt/);
    assert.match(request, /Attribution boundary \(authoritative\)/);
    assert.match(request, /cannot prove which post-launch changes the worker made/);
    assert.match(request, /post-hoc evaluation only/);
    assert.match(request, /never represents a pre-write gate/);
    assert.match(request, /do not silently present unrelated concurrent changes as reviewed worker output/i);
    assert.match(request, /not inside a Git repository/, "a non-Git workspace says so instead of inventing a HEAD");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the recorded delta identity is content-anchored: same paths with different contents are different identities", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-inplace-identity-"));
  const config = boundedConfig;
  try {
    await writeFile(join(workspace, "seed.txt"), "one\n", "utf8");
    const baseline = await createInPlaceBaseline(workspace, config);
    await writeFile(join(workspace, "seed.txt"), "two\n", "utf8");
    let attribution = await computeInPlaceAttribution(baseline, config);
    const identityOne = inPlaceDeltaIdentity(attribution);
    assert.match(identityOne, /seed\.txt/);

    // A correction that rewrites the same path: path set and statuses are
    // unchanged, but the content identity must change.
    await writeFile(join(workspace, "seed.txt"), "three\n", "utf8");
    attribution = await computeInPlaceAttribution(baseline, config);
    const identityTwo = inPlaceDeltaIdentity(attribution);
    assert.notEqual(identityTwo, identityOne, "content changes must change the identity");
    // A byte-identical workspace yields the same identity back.
    await writeFile(join(workspace, "seed.txt"), "two\n", "utf8");
    attribution = await computeInPlaceAttribution(baseline, config);
    assert.equal(inPlaceDeltaIdentity(attribution), identityOne, "same contents keep the identity stable");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the launch baseline persists before dispatch and is restored for continuations, failing closed otherwise", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-baseline-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const artifactDir = join(scratch, "artifacts", "task-base");
  await mkdir(artifactDir, { recursive: true });
  try {
    await writeFile(join(workspace, "seed.txt"), "seed\n", "utf8");
    const baseline = await createInPlaceBaseline(workspace, boundedConfig);
    const baselinePath = await persistInPlaceBaseline(baseline, "task-restore-1", artifactDir);
    // Same-baseline re-persist is refuse-once (write-once publication): a
    // later re-capture cannot silently re-baseline a running task.
    await assert.rejects(
      persistInPlaceBaseline(baseline, "task-restore-1", artifactDir),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
      "the launch baseline document is write-once",
    );
    const restored = await loadInPlaceBaseline("task-restore-1", artifactDir, workspace);
    assert.equal(restored.workspaceRoot, baseline.workspaceRoot);
    assert.equal(restored.mode, "non_git");
    assert.equal(restored.capturedAt, baseline.capturedAt);
    assert.equal(restored.snapshot.files.get("seed.txt")?.content, "seed\n");
    // Content identity survives the round trip: the restored basis and the
    // original in-memory basis produce the identical content-anchored
    // attribution, and a change to an already-changed path is observable.
    await writeFile(join(workspace, "seed.txt"), "seed changed\n", "utf8");
    const attributionRestored = await computeInPlaceAttribution(restored, boundedConfig);
    const attributionLive = await computeInPlaceAttribution(baseline, boundedConfig);
    assert.equal(inPlaceDeltaIdentity(attributionRestored), inPlaceDeltaIdentity(attributionLive));
    await writeFile(join(workspace, "seed.txt"), "seed changed again\n", "utf8");
    const attributionSecond = await computeInPlaceAttribution(restored, boundedConfig);
    assert.notEqual(inPlaceDeltaIdentity(attributionSecond), inPlaceDeltaIdentity(attributionRestored));

    // A tampered document fails closed.
    await writeFile(baselinePath, JSON.stringify({ ...JSON.parse(await readFile(baselinePath, "utf8")), taskId: "task-TAMPERED" }), "utf8");
    await assert.rejects(loadInPlaceBaseline("task-restore-1", artifactDir, workspace), /malformed or tampered/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

function escapeForRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Narrative omitted from routine in-place completion prose (#220/PR226). */
const REJECTED_COMPLETION_NARRATIVE = [
  "cannot prove which post-launch changes",
  "no verdict was fabricated",
  "Missing events do not establish",
  "nothing was gated, rolled back, or landed",
  "Attribution (authoritative)",
  "Attribution remains bounded",
];

// ── controller lifecycle (fake run-as-binary executor) ──────────────────────

interface InPlaceExecutorSpec {
  script: string;
  /** Optional release-gate sentinel: the executor waits for this path to exist before finishing the turn. */
  gate?: string;
}

async function writeInPlaceExecutorScript(root: string, spec: { file: string; gate?: string }): Promise<string> {
  const script = join(root, "inplace-fake-executor.cjs");
  await writeFile(script, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    `if(prompt.includes('INPLACE_SENTINEL'))fs.writeFileSync(${JSON.stringify(spec.file)},'written in place\\n');`,
    "const finish=()=>{",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed the in-place edit'}));",
    "};",
    spec.gate
      ? `const gate=${JSON.stringify(spec.gate)};const poll=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(poll);finish();}},10);`
      : "finish();",
    "});",
  ].join("\n"), "utf8");
  await chmod(script, 0o755);
  return script;
}

function inplaceExternalConfig(spec: InPlaceExecutorSpec, options?: {
  passingReviewer?: boolean;
  reviewPromptFile?: string;
  reviewVerdicts?: Array<"pass" | "needs_changes">;
  reviewVerdictFile?: string;
  backupExecutor?: boolean;
  retryPolicy?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; jitter: boolean; maxSameIncidentRepeats: number };
}): ReviewGateConfig {
  const reviewerScript = [
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    ...(options?.reviewPromptFile ? [`fs.writeFileSync(${JSON.stringify(options.reviewPromptFile)},prompt);`] : []),
    ...(options?.reviewVerdicts && options.reviewVerdictFile ? [
      `const verdicts=${JSON.stringify(options.reviewVerdicts)};`,
      `const verdictIndex=fs.existsSync(${JSON.stringify(options.reviewVerdictFile)})?Number(fs.readFileSync(${JSON.stringify(options.reviewVerdictFile)},'utf8')):0;`,
      `fs.writeFileSync(${JSON.stringify(options.reviewVerdictFile)},String(verdictIndex+1));`,
      "const verdict=verdicts[verdictIndex]??verdicts[verdicts.length-1]??'pass';",
    ] : ["const verdict='pass';"]),
    "const findings=verdict==='needs_changes'?[{severity:'blocking',file:null,line:null,issue:'External-only correction needs another review',recommendation:'Continue reviewing the new external observation.'}]:[];",
    "process.stdout.write(JSON.stringify({verdict,summary:'reviewed evidence',findings}));",
    "});",
  ].join("\n");
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: options?.passingReviewer ? [{ source: "external", id: "passing" }] : [] },
    externalAgents: {
      "inplace-fake": {
        adapter: "run-as-binary" as const,
        command: process.execPath,
        env: spec.gate ? { PI_REVIEW_EXECUTOR_TEST_GATE: spec.gate } : undefined,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [spec.script] },
      },
      ...(options?.backupExecutor ? {
        "inplace-backup": {
          adapter: "run-as-binary" as const,
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [spec.script] },
        },
      } : {}),
      ...(options?.passingReviewer ? {
        "passing": {
          adapter: "generic-cli",
          command: process.execPath,
          args: [],
          review: { args: ["-e", reviewerScript], timeoutMs: 5000 },
        },
      } : {}),
    },
    execution: {
      maxWorkers: 1,
      workerResources: {
        "default": { selection: { source: "external", id: "inplace-fake" }, maxConcurrent: 1 },
        ...(options?.backupExecutor ? { "backup": { selection: { source: "external", id: "inplace-backup" }, maxConcurrent: 1 } } : {}),
      },
      routes: { execute: [{ resourceId: "default" }, ...(options?.backupExecutor ? [{ resourceId: "backup" }] : [])], research: [] },
      ...(options?.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
    },
    retainBundles: "always",
  });
}

test("omitting the in-place workspace keeps the existing primary workspace as the selected root", async () => {
  const workspace = await createInPlaceScratch("default-root");
  let instance: BackgroundExecutionController | undefined;
  try {
    const script = await writeInPlaceExecutorScript(workspace, { file: join(workspace, "default-root.txt") });
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script }),
      state: createState(),
      cwd: () => workspace,
    });
    const started = await instance.start(
      [{ title: "default root", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["the selected workspace is used"] }],
      "inplace",
    );
    assert.equal(started.cwd, await realpath(workspace));
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 30_000);
    const settled = instance.inspect(started.executionId).tasks[0]!;
    assert.equal(settled.dispatch?.worktreeRoot, await realpath(workspace));
    assert.equal(await readFile(join(workspace, "default-root.txt"), "utf8"), "written in place\n");
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an outside-root-only absolute write reaches the in-place reviewer as unverified external evidence", async () => {
  const scratch = await createInPlaceScratch("external-only");
  const workspace = join(scratch, "selected-root");
  const externalPath = join(scratch, "outside-write.txt");
  const reviewPromptFile = join(scratch, "captured-review-prompt.txt");
  const artifactDir = join(scratch, "artifacts", "external-only");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" }, { passingReviewer: true, reviewPromptFile });
  const entry = resolvedExecutorPool(config)[0];
  assert.ok(entry);
  let turns = 0;
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    toolEventObservability: { mode: "structured", description: "test structured tool events" },
    async run(request) {
      turns += 1;
      assert.equal(request.cwd, resolve(workspace));
      if (turns === 1) {
        await writeFile(externalPath, "external content\n", "utf8");
        // Model the child mutation preceding parent stream delivery: the
        // path is evidence, but no reliable pre-write snapshot exists.
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: externalPath } });
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: externalPath }, result: "wrote external file" });
      }
      return {
        text: "completed the external write",
        session: { adapter: "pi-model", id: "external-only-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
  try {
    const result = await runInplaceLifecycle({
      taskId: "inplace-external-only",
      task: { title: "Write outside root", instructions: "Write the requested absolute path", acceptanceCriteria: ["outside file exists"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      adapterFactory: () => adapter,
    });
    assert.equal(result.status, "reviewed");
    assert.equal(result.reviewCycles.length, 1, "the external-only evidence received its own passing review");
    assert.equal(result.changedSinceLaunch.length, 0, "the external file is not an in-root delta");
    assert.deepEqual(result.observedExternalPaths, [externalPath]);
    assert.equal(await readFile(externalPath, "utf8"), "external content\n");
    assert.ok(turns >= 2, "a passing external-only review is confirmed with the same in-place worker");
    assert.equal("landing" in result, false, "in-place work has no landing result");
    const reviewerPrompt = await readFile(reviewPromptFile, "utf8");
    assert.match(reviewerPrompt, new RegExp(escapeForRegex(externalPath)));
    assert.match(reviewerPrompt, /Tool-observed external side-effect candidates/);
    assert.match(reviewerPrompt, /prior state unverified/i);
    assert.match(reviewerPrompt, /Bounded current after-turn observation/);
    assert.match(reviewerPrompt, /not a diff/);
    assert.match(reviewerPrompt, /no exact diff is claimed/i);
    const persisted = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8")) as {
      changedSinceLaunch: unknown[];
      observedExternalPaths: string[];
      status: string;
    };
    assert.equal(persisted.status, "reviewed");
    assert.deepEqual(persisted.changedSinceLaunch, []);
    assert.deepEqual(persisted.observedExternalPaths, [externalPath]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("external-only correction observations count as progress when the workspace delta stays unchanged", async () => {
  const scratch = await createInPlaceScratch("external-correction-progress");
  const workspace = join(scratch, "selected-root");
  const externalPath = join(scratch, "same-outside-path.txt");
  const reviewVerdictFile = join(scratch, "review-count.txt");
  const artifactDir = join(scratch, "artifacts", "external-correction-progress");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" }, {
    passingReviewer: true,
    reviewVerdicts: ["needs_changes", "needs_changes", "pass"],
    reviewVerdictFile,
  });
  const entry = resolvedExecutorPool(config)[0];
  assert.ok(entry);
  let turns = 0;
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    toolEventObservability: { mode: "structured", description: "test structured tool events" },
    async run(request) {
      turns += 1;
      if (turns <= 2) {
        await writeFile(externalPath, `external correction ${turns}\n`, "utf8");
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: externalPath } });
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: externalPath }, result: "updated external file" });
      }
      return {
        text: "completed the external correction",
        session: { adapter: "pi-model", id: "external-correction-progress-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
  try {
    const result = await runInplaceLifecycle({
      taskId: "inplace-external-correction-progress",
      task: { title: "Correct external evidence", instructions: "Update the same absolute path on correction", acceptanceCriteria: ["the outside file contains the latest correction"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      adapterFactory: () => adapter,
      maxCorrectionCycles: 3,
    });
    assert.equal(result.status, "reviewed");
    assert.equal(result.reviewCycles.length, 3, "two external-only corrections must not be stopped as no progress");
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "needs_changes", "pass"]);
    assert.deepEqual(result.reviewCycles.map((cycle) => cycle.externalObservationRevision), [2, 4, 4]);
    assert.equal(result.changedSinceLaunch.length, 0, "external-only corrections leave the workspace identity unchanged");
    assert.equal(turns, 4, "the passing review is confirmed without another external write");
    assert.equal(await readFile(externalPath, "utf8"), "external correction 2\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a new outside-root observation during pass confirmation forces another review", async () => {
  const scratch = await createInPlaceScratch("external-confirmation");
  const workspace = join(scratch, "selected-root");
  const initialExternalPath = join(scratch, "initial-external.txt");
  const confirmationExternalPath = join(scratch, "confirmation-external.txt");
  const reviewPromptFile = join(scratch, "confirmation-review-prompt.txt");
  const artifactDir = join(scratch, "artifacts", "external-confirmation");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" }, { passingReviewer: true, reviewPromptFile });
  const entry = resolvedExecutorPool(config)[0];
  assert.ok(entry);
  let turns = 0;
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    toolEventObservability: { mode: "structured", description: "test structured tool events" },
    async run(request) {
      turns += 1;
      const path = turns === 1
        ? initialExternalPath
        : turns === 2
          ? confirmationExternalPath
          : undefined;
      if (path) {
        await writeFile(path, `external write ${turns}\n`, "utf8");
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path } });
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path }, result: "wrote external file" });
      }
      return {
        text: "completed the external write",
        session: { adapter: "pi-model", id: "external-confirmation-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
  try {
    const result = await runInplaceLifecycle({
      taskId: "inplace-external-confirmation",
      task: { title: "Observe confirmation write", instructions: "Write externally, including during confirmation", acceptanceCriteria: ["both outside files remain present"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      adapterFactory: () => adapter,
    });
    assert.equal(result.status, "reviewed");
    assert.equal(result.reviewCycles.length, 2, "the confirmation write invalidates the first pass and reaches a second review");
    assert.equal(turns, 3, "each passing review gets one confirmation turn");
    assert.equal(result.changedSinceLaunch.length, 0);
    assert.deepEqual(result.observedExternalPaths, [initialExternalPath, confirmationExternalPath]);
    assert.equal(await readFile(initialExternalPath, "utf8"), "external write 1\n");
    assert.equal(await readFile(confirmationExternalPath, "utf8"), "external write 2\n");
    const reviewerPrompt = await readFile(reviewPromptFile, "utf8");
    assert.match(reviewerPrompt, new RegExp(escapeForRegex(initialExternalPath)));
    assert.match(reviewerPrompt, new RegExp(escapeForRegex(confirmationExternalPath)));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("external tool observations survive a stopped turn and reach the continuation reviewer", async () => {
  const scratch = await createInPlaceScratch("external-continuation");
  const workspace = join(scratch, "selected-root");
  const externalPath = join(scratch, "continued-external.txt");
  const reviewPromptFile = join(scratch, "continuation-review-prompt.txt");
  const artifactDir = join(scratch, "artifacts", "external-continuation");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" }, {
    passingReviewer: true,
    reviewPromptFile,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 3 },
  });
  const entry = resolvedExecutorPool(config)[0];
  assert.ok(entry);
  let turns = 0;
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    toolEventObservability: { mode: "structured", description: "test structured tool events" },
    async run(request) {
      turns += 1;
      if (turns === 1) {
        await writeFile(externalPath, "written before the turn stopped\n", "utf8");
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: externalPath } });
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: externalPath }, result: "wrote file" });
        return {
          text: "partial external write",
          session: { adapter: "pi-model", id: "prior-session" },
          stdoutPath: "",
          stderrPath: "",
          code: null,
          timedOut: false,
          aborted: false,
          failure: { category: "provider", message: "429 quota exceeded" },
        };
      }
      assert.equal(request.session?.id, "prior-session");
      return {
        text: "continued after inspecting the external write",
        session: { adapter: "pi-model", id: "prior-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
  try {
    const stopped = await runInplaceLifecycle({
      taskId: "inplace-external-continuation",
      task: { title: "Continue external write", instructions: "Finish after the external write", acceptanceCriteria: ["outside file remains present"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      adapterFactory: () => adapter,
    });
    assert.equal(stopped.status, "executor_error");
    assert.equal(stopped.session?.id, "prior-session");
    const retained: InPlaceWorkerResult = {
      status: "executor_error",
      taskId: stopped.taskId,
      title: stopped.title,
      summary: stopped.summary,
      adapter: stopped.adapter,
      session: stopped.session,
      error: stopped.error,
      operationRecord: stopped.operationRecord,
      incidents: stopped.incidents ?? [],
      attempts: stopped.attempts ?? 1,
      lastExecutorTurn: stopped.lastExecutorTurn,
    };
    const continued = await runInplaceLifecycle({
      taskId: stopped.taskId,
      task: { title: stopped.title, instructions: "Finish after the external write", acceptanceCriteria: ["outside file remains present"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      adapterFactory: () => adapter,
      baseline: stopped.baseline,
      initialResult: retained,
      continuation: { instructions: "Inspect the partial result and finish the task." },
    });
    assert.equal(continued.status, "reviewed");
    assert.equal(continued.changedSinceLaunch.length, 0);
    assert.deepEqual(continued.observedExternalPaths, [externalPath]);
    assert.equal(await readFile(externalPath, "utf8"), "written before the turn stopped\n");
    const persistedEvidence = JSON.parse(await readFile(join(artifactDir, "observed-tool-evidence.json"), "utf8")) as {
      events: unknown[];
      candidates: Array<{ externalSideEffect?: boolean; absolutePath?: string }>;
    };
    assert.equal(persistedEvidence.events.length, 2);
    assert.equal(persistedEvidence.candidates[0]?.externalSideEffect, true);
    const reviewerPrompt = await readFile(reviewPromptFile, "utf8");
    assert.match(reviewerPrompt, new RegExp(escapeForRegex(externalPath)));
    assert.match(reviewerPrompt, /prior state unverified/i);
    assert.match(reviewerPrompt, /written before the turn stopped/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("retryable provider 429 failover preserves the in-place root, partial writes, and launch baseline", async () => {
  const scratch = await createInPlaceScratch("failover");
  const workspace = join(scratch, "workspace");
  const artifactDir = join(scratch, "artifacts", "failover");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "seed.txt"), "launch state\n", "utf8");
  const config = inplaceExternalConfig({ script: "unused" }, {
    backupExecutor: true,
    retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: true, maxSameIncidentRepeats: 3 },
  });
  const [firstEntry, backupEntry] = resolvedExecutorPool(config);
  assert.ok(firstEntry);
  assert.ok(backupEntry);
  const first = { entry: firstEntry, priority: 0 };
  const backup = { entry: backupEntry, priority: 1 };
  const partialPath = join(workspace, "partial.txt");
  const completedPath = join(workspace, "replacement.txt");
  let firstCalls = 0;
  let backupCalls = 0;
  const providerFailure = (id: string) => ({
    text: "",
    session: { adapter: "inplace-fake", id },
    stdoutPath: "",
    stderrPath: "",
    code: null,
    timedOut: false,
    aborted: false,
    failure: { category: "provider" as const, message: "429 quota exceeded" },
  });
  const firstAdapter: ExecutorAdapter = {
    kind: "first-provider",
    async run(request) {
      firstCalls += 1;
      const fakePid = 900000 + firstCalls;
      await request.onProcessStart?.({ pid: fakePid });
      await request.onProcessExit?.({ pid: fakePid, code: 1, signal: null });
      assert.equal(request.cwd, resolve(workspace));
      if (firstCalls === 1) {
        await writeFile(partialPath, "partial work must survive\n", "utf8");
      } else {
        assert.equal(request.session?.id, "first-session", "same-adapter retry retains its session");
      }
      return providerFailure("first-session");
    },
  };
  const backupAdapter: ExecutorAdapter = {
    kind: "backup-provider",
    async run(request) {
      backupCalls += 1;
      assert.equal(request.cwd, resolve(workspace));
      assert.equal(request.session, undefined, "failover uses a fresh session");
      assert.match(request.prompt, /429 quota exceeded/);
      assert.match(request.prompt, /No wave capture, new launch baseline, workspace reset, checkpoint, rollback, or landing occurred/);
      assert.equal(await readFile(partialPath, "utf8"), "partial work must survive\n");
      await writeFile(completedPath, "replacement completed work\n", "utf8");
      return {
        text: "replacement finished the task",
        session: { adapter: "backup-provider", id: "backup-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
  try {
    const originalRandom = Math.random;
    let randomDraws = 0;
    Math.random = () => {
      randomDraws += 1;
      return 0.5;
    };
    let result: Awaited<ReturnType<typeof runInplaceLifecycle>>;
    try {
      result = await runInplaceLifecycle({
        taskId: "inplace-provider-failover",
        task: { title: "Continue in place", instructions: "Finish the task", acceptanceCriteria: ["replacement file exists"] },
        workspaceRoot: workspace,
        artifactDir,
        config,
        executorAssignment: first,
        acquireFailover: async (current) => {
          assert.equal(current.entry.entryId, firstEntry.entryId);
          return backup;
        },
        adapterFactory: (_config, selection) => selection.source === "external" && selection.id === "inplace-backup" ? backupAdapter : firstAdapter,
      });
    } finally {
      Math.random = originalRandom;
    }
    assert.equal(result.status, "unreviewed");
    assert.equal(firstCalls, 2, "the configured same-adapter retry is honored before pool failover");
    assert.equal(randomDraws, 0, "the in-place base-zero guard skips the shared computation and jitter draw");
    assert.equal(backupCalls, 1);
    assert.deepEqual(result.changedSinceLaunch.map(({ path }) => path).sort(), ["partial.txt", "replacement.txt"]);
    assert.equal(await readFile(partialPath, "utf8"), "partial work must survive\n");
    assert.equal(await readFile(completedPath, "utf8"), "replacement completed work\n");
    const baseline = await loadInPlaceBaseline(result.taskId, artifactDir, workspace);
    assert.equal(baseline.snapshot.files.get("seed.txt")?.content, "launch state\n");
    assert.equal(baseline.snapshot.files.has("partial.txt"), false, "the original launch baseline was not recaptured after the partial write");
    const operation = JSON.parse(await readFile(result.operationRecord, "utf8")) as {
      assignments: Array<{ entryId: string; reason: string; outcome?: string }>;
      incidents: Array<{ message: string; resolution?: string }>;
    };
    assert.deepEqual(operation.assignments.map(({ entryId, reason }) => [entryId, reason]), [
      [firstEntry.entryId, "initial"],
      [backupEntry.entryId, "failover"],
    ]);
    assert.ok(operation.incidents.some((incident) => /429 quota exceeded/.test(incident.message) && incident.resolution === "executor_pool_failover"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("in-place failover stays closed when an unsettled first child is followed by a settled retry", async () => {
  const scratch = await createInPlaceScratch("failover-unsettled");
  const workspace = join(scratch, "workspace");
  const artifactDir = join(scratch, "artifacts", "unsettled");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" }, {
    backupExecutor: true,
    retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 3 },
  });
  const [firstEntry] = resolvedExecutorPool(config);
  assert.ok(firstEntry);
  let failoverCalls = 0;
  let attempts = 0;
  let exitCalls = 0;
  const adapter: ExecutorAdapter = {
    kind: "first-provider",
    async run(request) {
      attempts += 1;
      const pid = 987654321 + attempts;
      await request.onProcessStart?.({ pid });
      if (attempts === 2) {
        exitCalls += 1;
        await request.onProcessExit?.({ pid, code: 1, signal: null });
      }
      return {
        text: "",
        session: { adapter: "first-provider", id: "session" },
        stdoutPath: "",
        stderrPath: "",
        code: null,
        timedOut: false,
        aborted: false,
        failure: { category: "provider", message: "429 quota exceeded" },
      };
    },
  };
  try {
    const result = await runInplaceLifecycle({
      taskId: "inplace-unsettled-child",
      task: { title: "Fail closed", instructions: "Do not launch a replacement", acceptanceCriteria: ["no failover"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry: firstEntry, priority: 0 },
      acquireFailover: async () => { failoverCalls += 1; return undefined; },
      adapterFactory: () => adapter,
    });
    assert.equal(result.status, "executor_error");
    assert.equal(attempts, 2, "one settled retry must follow the first attempt");
    assert.equal(exitCalls, 1, "the second child reports its exit");
    assert.equal(failoverCalls, 0, "the unsettled first child prevents replacement acquisition");
    const operation = JSON.parse(await readFile(result.operationRecord, "utf8")) as { state: string; incidents: Array<{ terminalCode?: string }> };
    assert.equal(operation.state, "failed_critical", "settlement does not downgrade the fail-closed incident");
    assert.ok(operation.incidents.some((incident) => incident.terminalCode === "recovery_state_corrupt_or_unverifiable"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("no-change settlement discloses an adapter with no structured tool-event stream", async () => {
  const scratch = await createInPlaceScratch("unobservable");
  const workspace = join(scratch, "workspace");
  const artifactDir = join(scratch, "artifacts", "unobservable");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" });
  const entry = resolvedExecutorPool(config)[0];
  assert.ok(entry);
  const adapter: ExecutorAdapter = {
    kind: "run-as-binary",
    toolEventObservability: { mode: "unavailable", description: "The test protocol has no structured tool calls." },
    async run() {
      return {
        text: "done",
        session: { adapter: "run-as-binary", id: "session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
  try {
    const result = await runInplaceLifecycle({
      taskId: "inplace-unobservable",
      task: { title: "No visible writes", instructions: "Inspect only", acceptanceCriteria: ["no workspace delta"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      adapterFactory: () => adapter,
    });
    assert.equal(result.status, "no_changes");
    assert.match(result.summary, /does not establish that no external side effects occurred/);
    assert.match(result.summary, /Snapshot policy excludes ignored directories/i);
    assert.match(result.summary, /no structured tool calls/i);
    assert.deepEqual(result.observedExternalPaths, []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("in-place tasks write directly in a non-Git workspace, settle reported, and record in-place dispatch provenance", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-e2e-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const script = await writeInPlaceExecutorScript(scratch, { file: join(workspace, "made.txt") });
    const messages: string[] = [];
    instance = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config: inplaceExternalConfig({ script }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "in-place edit", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["made.txt written in the workspace"] }],
      "inplace",
      workspace,
    );
    assert.equal(started.kind, "inplace");
    assert.equal(started.cwd, await realpath(workspace));
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 30_000);
    // The write happened directly in the selected workspace; nothing landed anywhere.
    assert.equal(await readFile(join(workspace, "made.txt"), "utf8"), "written in place\n");
    const settled = instance.inspect(started.executionId).tasks[0]!;
    assert.equal(settled.state, "reported");
    assert.equal(settled.waveRoot, undefined);
    assert.match(settled.summary ?? "", /in place/i);
    assert.match(settled.summary ?? "", / Review: disabled\./, "the actual review disposition is reported");
    assert.match(settled.summary ?? "", /^Workspace changes since launch: added made\.txt$/m, "the recorded delta is named, not counted");
    assert.equal(settled.result?.phase, "completed");
    assert.equal(settled.result?.landing, undefined);
    assert.equal(settled.result?.taskResults[0]?.status, "completed_unreviewed");
    assert.ok(settled.artifactDir && settled.artifactDir.includes("artifacts"), "the artifact dir lives under the execution root");
    // #93: dispatch provenance marks the in-place workspace and no base commit.
    assert.equal(settled.dispatch?.inPlace, true);
    assert.equal(settled.dispatch?.baseCommit, "");
    assert.equal(settled.dispatch?.worktreeRoot, await realpath(workspace));
    // The completion wake names the in-place settlement as concise positive
    // fact (#220/PR226): actual review disposition, the named recorded delta,
    // and the group aggregate — no repeated narrative.
    const completion = await waitForValue(() => messages.find((message) => message.includes(settled.taskId) && /finished in/.test(message)), 10_000);
    assert.match(completion!, / Review: disabled\./);
    assert.match(completion!, /^Workspace changes since launch: added made\.txt$/m);
    assert.match(completion!, new RegExp(`In-place ${escapeForRegex(started.executionId)} COMPLETE: 1/1 tasks settled in place\\.`));
    assert.doesNotMatch(completion!, /All requested in-place work settled/, "the group result is one line");
    for (const rejected of REJECTED_COMPLETION_NARRATIVE) {
      assert.doesNotMatch(completion!, new RegExp(rejected, "i"), `routine completion carries no rejected narrative: ${rejected}`);
    }

    // Landing-only operations are refused with actionable diagnostics; the
    // settled task keeps its reported state.
    await assert.rejects(
      instance.forceMerge({
        executionId: started.executionId,
        taskId: settled.taskId,
        mergeAnyhow: false,
        instructionId: "fm-1",
        actor: "user",
      }),
      /no mergeable checkpoint/,
    );
    assert.equal(instance.inspect(started.executionId, settled.taskId).tasks[0]?.state, "reported");
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("scheduled dispatch options select the in-place kind through the ordinary start path", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-sched-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const script = await writeInPlaceExecutorScript(scratch, { file: join(workspace, "sched.txt") });
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "scheduled in-place", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["ok"] }],
      "inplace",
      workspace,
      { scheduledTaskId: "sched-entry-1" },
    );
    assert.equal(started.kind, "inplace");
    // scheduledRuns lists the entry's UNSETTLED runs (overlap detection), so
    // sample it while this run is still active, then let it settle.
    await waitForValue(() => instance!.inspect(started.executionId).tasks[0]?.state === "running" ? true : undefined, 30_000);
    const activeRuns = instance.scheduledRuns("sched-entry-1");
    assert.ok(activeRuns.length >= 1);
    assert.ok(activeRuns.some((run) => run.kind === "inplace" && run.tasks.length >= 1));
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 30_000);
    assert.equal(instance.scheduledRuns("sched-entry-1").length === 0, true, "settled runs no longer overlap-block");
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an in-place task reviews through the subtask reviewer configuration and settles reviewed", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-reviewed-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const script = await writeInPlaceExecutorScript(scratch, { file: join(workspace, "reviewed.txt") });
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script }, { passingReviewer: true }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "reviewed in-place edit", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["reviewed.txt written"] }],
      "inplace",
      workspace,
    );
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 45_000);
    const task = instance.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "reported");
    assert.equal(await readFile(join(workspace, "reviewed.txt"), "utf8"), "written in place\n");
    // The own review ran: the report carries a pass verdict, and the durable
    // in-place cycle record exists under reviews/inplace/ carrying the
    // attribution basis instead of a fabricated commit identity.
    assert.equal(task.result?.taskResults[0]?.reviewReport?.aggregate, "pass");
    assert.ok(task.artifactDir);
    const cyclePath = join(task.artifactDir!, "reviews", "inplace", "cycle-000001.json");
    const cycleRecord = JSON.parse(await readFile(cyclePath, "utf8")) as Record<string, unknown>;
    assert.equal(cycleRecord.waveId, "inplace");
    assert.equal(cycleRecord.inPlace, true);
    assert.equal(cycleRecord.candidate, undefined, "no commit identity is fabricated");
    const attribution = cycleRecord.attribution as Record<string, unknown>;
    assert.equal(attribution.workspaceRoot, await realpath(workspace));
    assert.deepEqual((attribution.changedSinceLaunch as Array<{ path: string }>).map((entry) => entry.path), ["reviewed.txt"]);
    // result.json discloses the in-place marker and the recorded delta.
    const resultJson = JSON.parse(await readFile(join(task.artifactDir!, "result.json"), "utf8")) as Record<string, unknown>;
    assert.equal(resultJson.inPlace, true);
    assert.deepEqual(resultJson.changedSinceLaunch, [{ status: "added", path: "reviewed.txt" }]);
    // The settled summary reports the actual review disposition and names the
    // recorded delta (#220/PR226) — no repeated attribution narrative.
    assert.match(task.summary ?? "", / Review: passed\./);
    assert.match(task.summary ?? "", /^Workspace changes since launch: added reviewed\.txt$/m);
    for (const rejected of REJECTED_COMPLETION_NARRATIVE) {
      assert.doesNotMatch(task.summary ?? "", new RegExp(rejected, "i"), `routine completion carries no rejected narrative: ${rejected}`);
    }
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

// Regression (#220/PR226): a root hello.txt with a passing review
// must be reported as the named delta plus the actual review disposition and
// the group aggregate — never a count-only note or repeated narrative. The
// separate external-path category (e.g. /dev/null) is exercised through the
// same builder finishInplace uses in tests/inplace-completion-reporting.test.ts;
// this e2e pins the controller wiring for the exact hello.txt scenario.
test("in-place completion names the root delta and reports the actual review disposition", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-hello-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const messages: string[] = [];
    const script = await writeInPlaceExecutorScript(scratch, { file: join(workspace, "hello.txt") });
    instance = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config: inplaceExternalConfig({ script }, { passingReviewer: true }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "hello in place", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["hello.txt written at the workspace root"] }],
      "inplace",
      workspace,
    );
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 45_000);
    const settled = instance.inspect(started.executionId).tasks[0]!;
    assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "written in place\n");
    // The durable summary is the concise factual shape: identity/workspace,
    // actual review disposition, and the named recorded delta.
    assert.match(settled.summary ?? "", new RegExp(`^In-place task ${escapeForRegex(settled.taskId)} finished in place in .*\. Review: passed\.$`, "m"));
    assert.match(settled.summary ?? "", /^Workspace changes since launch: added hello\.txt$/m);
    for (const rejected of REJECTED_COMPLETION_NARRATIVE) {
      assert.doesNotMatch(settled.summary ?? "", new RegExp(rejected, "i"), `routine completion carries no rejected narrative: ${rejected}`);
    }
    // The completion wake adds the concise group aggregate, nothing more.
    const completion = await waitForValue(() => messages.find((message) => message.includes(settled.taskId) && /finished in/.test(message)), 10_000);
    assert.match(completion!, / Review: passed\./);
    assert.match(completion!, /^Workspace changes since launch: added hello\.txt$/m);
    assert.match(completion!, new RegExp(`In-place ${escapeForRegex(started.executionId)} COMPLETE: 1/1 tasks settled in place\\.`));
    assert.doesNotMatch(completion!, /All requested in-place work settled/, "the group result is one line");
    for (const rejected of REJECTED_COMPLETION_NARRATIVE) {
      assert.doesNotMatch(completion!, new RegExp(rejected, "i"), `routine completion carries no rejected narrative: ${rejected}`);
    }
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("interrupt-with-merge is refused for in-place tasks and interruption leaves prior writes untouched", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-interrupt-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const gate = join(scratch, "release-gate");
    const script = await writeInPlaceExecutorScript(scratch, { file: join(workspace, "prior.txt"), gate });
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script, gate }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "interrupted in-place edit", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["ok"] }],
      "inplace",
      workspace,
    );
    // While the executor is gated mid-turn, its write has already happened.
    await waitFor(() => instance!.inspect(started.executionId).tasks[0]?.state === "running", 30_000);
    const taskId = instance.inspect(started.executionId).tasks[0]!.taskId;
    await waitForAsyncTrue(async () => await readFile(join(workspace, "prior.txt"), "utf8").then(() => true, () => false), 10_000);
    await assert.rejects(
      instance.interrupt({
        executionId: started.executionId,
        taskId,
        mode: "interrupt_with_merge",
        instructionId: "iwm-1",
        actor: "user",
      }),
      /interrupt_with_merge|no captured checkpoint/,
    );
    // Interrupt as failure: quiesce, settle interrupted, and verify the
    // already-performed write is NOT rolled back anywhere.
    await instance.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "iaf-1",
      actor: "user",
    });
    await waitFor(() => ["interrupted", "failed", "paused_recoverable"].includes(instance!.inspect(started.executionId).tasks[0]?.state ?? ""), 30_000);
    const settledTask = instance.inspect(started.executionId, taskId).tasks[0]!;
    assert.ok(["interrupted", "paused_recoverable"].includes(settledTask.state), `the task settled at ${settledTask.state}`);
    // Pass 3 (finding 1): the interrupted turn's abort must not degrade the
    // settle-time scan — the durable result and summary RECORD the partial
    // write instead of reporting an unknown delta.
    const interruptedResult = JSON.parse(await readFile(join(settledTask.artifactDir!, "result.json"), "utf8")) as {
      status: string;
      changedSinceLaunch: Array<{ status: string; path: string }>;
      attributionError?: string;
    };
    assert.equal(interruptedResult.status, "cancelled");
    assert.deepEqual(interruptedResult.changedSinceLaunch, [{ status: "added", path: "prior.txt" }], "the partial write is recorded against the launch baseline");
    assert.equal(interruptedResult.attributionError, undefined);
    assert.match(settledTask.summary ?? "", /^Workspace changes since launch: added prior\.txt$/m, "the interrupted summary names the inspected delta");
    assert.match(settledTask.summary ?? "", /not rolled back/i);
    assert.doesNotMatch(settledTask.summary ?? "", /workspace delta could not be verified/);
    await writeFile(gate, "release\n", "utf8");
    // The already-performed write stays in the workspace; no rollback exists.
    await waitForAsyncTrue(async () => await readFile(join(workspace, "prior.txt"), "utf8").then(() => true, () => false), 10_000);
    assert.equal(await readFile(join(workspace, "prior.txt"), "utf8"), "written in place\n");
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

// Manager-level launch path: the tool wrapper assigns the authoritative child
// catalog, and for kind "inplace" every Subtasks*-prefixed control is removed
// while the rest of the parent authorization is preserved (#220).
test("SubtasksStart kind inplace produces an in-place definition whose catalog carries no subtask tools", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-catalog-"));
  const managerRoot = scratch;
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand(_name: string, _options: unknown) { /* unused here */ },
    setToolActive(_name: string, _enabled: boolean) { /* unused here */ },
    getActiveTools: () => ["read", "edit", "write", "bash", ...executionToolNamesLocal],
  };
  const script = await writeInPlaceExecutorScript(managerRoot, { file: join(managerRoot, "unused-sentinel.txt") });
  const config = inplaceExternalConfig({ script });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => managerRoot,
    notify: () => undefined,
  });
  manager.sync();
  try {
    const start = tools.find((tool) => tool.name === "SubtasksStart");
    assert.ok(start, "SubtasksStart was registered");
    const started = await (start.execute as (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>)(
      "catalog-start",
      {
        kind: "inplace",
        workspace: managerRoot,
        tasks: [{ title: "catalog check", instructions: "List the in-place boundaries", acceptanceCriteria: ["ok"] }],
      },
      undefined,
      undefined,
      {},
    );
    assert.equal(started.details.kind, "inplace");
    assert.match(started.content[0].text, /in-?place group/);
    const definition = started.details.tasks[0].definition;
    assert.equal(definition.backgroundKind, "inplace");
    assert.ok(definition.executorToolCatalog, "an authoritative catalog was assigned");
    assert.equal(definition.executorToolCatalog.allowedToolCatalog.includes("bash"), true, "shell capability survives");
    assert.equal(definition.executorToolCatalog.allowedToolCatalog.includes("edit"), true, "file capability stays intact");
    for (const forbidden of ["SubtasksStart", "SubtasksAdd", "SubtasksContinue", "SubtasksInspect", "SubtasksWatch"]) {
      assert.equal(definition.executorToolCatalog.allowedToolCatalog.includes(forbidden), false, forbidden);
    }
  } finally {
    await manager.shutdown();
  }
});


function isInsideTarget(directory: string, candidate: string): boolean {
  const rel = relative(resolve(directory), resolve(candidate));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function waitForPathGone(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      if (Date.now() > deadline) throw new Error("timed out waiting for path removal");
      await new Promise((done) => setTimeout(done, 25));
    } catch {
      return;
    }
  }
}

test("a pass confirmation that changes reviewed CONTENT re-reviews instead of settling (finding-1 identity)", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-confirm-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const payload = join(workspace, "payload.txt");
    const counter = join(scratch, "invocation-counter");
    const script = join(scratch, "inplace-confirm-executor.cjs");
    await writeFile(script, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const finish=()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed the in-place edit'}));",
      "};",
      `const counter=${JSON.stringify(counter)};const n=(fs.existsSync(counter)?(parseInt(fs.readFileSync(counter,'utf8'),10)||0):0)+1;fs.writeFileSync(counter,String(n));`,
      "const isInitial=prompt.includes('in-place implementation executor');",
      "const isContinuation=prompt.includes('Current continuation instructions');",
      `const file=${JSON.stringify(payload)};`,
      "if(isInitial){fs.writeFileSync(file,'v1\\n');finish();}",
      "else if(isContinuation){if(n===2){fs.writeFileSync(file,'v2\\n');}finish();}",
      "else{finish();}",
      "});",
    ].join("\n"), "utf8");
    await chmod(script, 0o755);
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script }, { passingReviewer: true }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "pass-confirm content change", instructions: "Write payload.txt with the reviewed content", acceptanceCriteria: ["payload.txt carries the reviewed content"] }],
      "inplace",
      workspace,
    );
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => ["reported", "failed", "paused_recoverable", "interrupted"].includes(task.state)), 120_000);
    const task = instance.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "reported", `pass-confirm task settled at ${task.state}: ${task.error ?? ""} · last activity: ${task.activity.at(-1)?.message ?? ""}`);
    assert.equal(await readFile(payload, "utf8"), "v2\n", "the confirmation-turn rewrite is present in the workspace");
    assert.ok(task.result?.taskResults[0]?.reviewReport, "a review report exists");
    assert.equal(task.result!.taskResults[0]!.reviewReport!.reviewCycles, 2, "two review cycles ran");
    const cycleOne = JSON.parse(await readFile(join(task.artifactDir!, "reviews", "inplace", "cycle-000001.json"), "utf8")) as Record<string, unknown>;
    const cycleTwo = JSON.parse(await readFile(join(task.artifactDir!, "reviews", "inplace", "cycle-000002.json"), "utf8")) as Record<string, unknown>;
    const attributionOne = cycleOne.attribution as Record<string, unknown>;
    const attributionTwo = cycleTwo.attribution as Record<string, unknown>;
    assert.notEqual(attributionOne.deltaIdentitySha256, attributionTwo.deltaIdentitySha256, "the second review covered different content");
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

/** Config for the timeout continuation test: bounded timeout, no retries. */
function inplaceTimeoutConfig(script: string): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "inplace-fake": {
        adapter: "run-as-binary" as const,
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: "inplace-fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
      retryPolicy: { maxRetries: 0, baseDelayMs: 0 },
    },
    executorTimeoutMs: 1200,
    retainBundles: "always",
  });
}

/** Admission can race the prior run's promise settlement; brief bounded retries. */
async function continueWhenSettled(
  instance: BackgroundExecutionController,
  executionId: string,
  input: { instructions: string; instructionId: string; actor: "user" },
): Promise<unknown> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await instance.continueTask({
        executionId,
        ...input,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already active/.test(message) || Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

test("pausing after a partial write preserves the ORIGINAL launch baseline for the continuation (finding-2)", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-resume-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const payload = join(workspace, "resumed.txt");
    const gate = join(scratch, "release-gate");
    const script = join(scratch, "inplace-pause-executor.cjs");
    await writeFile(script, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const finish=()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed the in-place edit'}));",
      "};",
      "const isInitial=prompt.includes('in-place implementation executor');",
      `const file=${JSON.stringify(payload)};`,
      "if(isInitial){fs.writeFileSync(file,'pre-pause\\n');const wait=()=>{if(fs.existsSync(" + JSON.stringify(gate) + ")){finish();}else{setTimeout(wait,10);}};wait();}",
      "else{finish();}",
      "});",
    ].join("\n"), "utf8");
    await chmod(script, 0o755);
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script, gate }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "pause and continue", instructions: "PRE_PAUSE: the initial turn writes partially and stalls", acceptanceCriteria: ["the task continues in place"] }],
      "inplace",
      workspace,
    );
    await waitFor(() => instance!.inspect(started.executionId).tasks[0]?.state === "running", 30_000);
    const taskId = instance.inspect(started.executionId).tasks[0]!.taskId;
    await waitForAsyncTrue(async () => await readFile(payload, "utf8").then((value) => value === "pre-pause\n", () => false), 10_000);
    const artifacts = instance.inspect(started.executionId).tasks[0]!.artifactDir!;
    const baselineBefore = await readFile(join(artifacts, INPLACE_BASELINE_FILE), "utf8");
    await instance.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "iaf-pause",
      actor: "user",
    });
    await waitFor(() => ["interrupted", "paused_recoverable", "failed"].includes(instance!.inspect(started.executionId).tasks[0]!.state), 30_000);
    assert.equal(await readFile(payload, "utf8"), "pre-pause\n", "prior writes were not rolled back");
    await continueWhenSettled(instance, started.executionId, {
      instructions: "Finish the task; write resumed.txt with final content.",
      instructionId: "continue-pause-1",
      actor: "user",
    });
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 60_000);
    const settledTask = instance.inspect(started.executionId, taskId).tasks[0]!;
    const baselineAfter = await readFile(join(artifacts, INPLACE_BASELINE_FILE), "utf8");
    // The original baseline was RESTORED (write-once bytes), not re-captured:
    // the pre-pause write still appears in the recorded delta.
    assert.equal(baselineAfter, baselineBefore, "the persisted launch baseline was reused after the continuation");
    const resultJson = JSON.parse(await readFile(join(artifacts, "result.json"), "utf8")) as { changedSinceLaunch: Array<{ status: string; path: string }> };
    assert.deepEqual(resultJson.changedSinceLaunch, [{ status: "added", path: "resumed.txt" }], "a re-baselined continuation would have hidden the pre-pause write");
    void settledTask;
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a continuation after an executor failure still dispatches the requested turn (finding-3)", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-failure-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  const messages: string[] = [];
  try {
    const payload = join(workspace, "after-failure.txt");
    const script = join(scratch, "inplace-failure-executor.cjs");
    await writeFile(script, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const finish=()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed the in-place edit'}));",
      "};",
      `const file=${JSON.stringify(payload)};`,
      "if(prompt.includes('in-place implementation executor')){fs.writeFileSync(file,'partial before timeout\\n');setTimeout(finish,60000);}",
      "else if(prompt.includes('Current continuation instructions')){fs.writeFileSync(file,'after failure\\n');finish();}",
      "else{finish();}",
      "});",
    ].join("\n"), "utf8");
    await chmod(script, 0o755);
    instance = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config: inplaceTimeoutConfig(script),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "continued after failure", instructions: "WAIT: the first turn times out", acceptanceCriteria: ["the continuation runs after the failure"] }],
      "inplace",
      workspace,
    );
    const taskId = instance.inspect(started.executionId).tasks[0]!.taskId;
    await waitFor(() => ["paused_recoverable", "failed"].includes(instance!.inspect(started.executionId).tasks[0]!.state), 45_000);
    const paused = instance.inspect(started.executionId, taskId).tasks[0]!;
    assert.ok(["paused_recoverable", "failed"].includes(paused.state), `the failed task parked at ${paused.state}`);
    // #220 pass-2 (finding 1), asserted BEFORE continuing: the partial write
    // that happened before the timeout surfaces in result.json, the durable
    // summary, and the failure notice — never a false no-changes claim.
    const pausedResultJson = JSON.parse(await readFile(join(paused.artifactDir!, "result.json"), "utf8")) as {
      status: string;
      changedSinceLaunch: Array<{ status: string; path: string }>;
      attributionError?: string;
    };
    assert.equal(pausedResultJson.status, "timeout");
    assert.deepEqual(pausedResultJson.changedSinceLaunch, [{ status: "added", path: "after-failure.txt" }], "the pre-timeout partial write is the recorded delta, not an empty one");
    assert.equal(pausedResultJson.attributionError, undefined);
    assert.match(paused.summary ?? "", /^Workspace changes since launch: added after-failure\.txt$/m);
    assert.doesNotMatch(paused.summary ?? "", /no recorded workspace changes/);
    assert.doesNotMatch(paused.summary ?? "", /cannot prove which post-launch changes/i, "stopped summaries carry no repeated attribution narrative");
    const failureWake = await waitForValue(() => messages.find((message) => message.includes("stopped before settlement")), 10_000);
    assert.match(failureWake!, /added after-failure\.txt/, "the failure diagnostic carries the named delta");
    const artifacts = paused.artifactDir!;
    const baselineBefore = await readFile(join(artifacts, INPLACE_BASELINE_FILE), "utf8");
    await continueWhenSettled(instance, started.executionId, {
      instructions: "Now write after-failure.txt in this workspace",
      instructionId: "continue-after-failure",
      actor: "user",
    });
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 60_000);
    const settledTask = instance.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(settledTask.state, "reported");
    assert.equal(await readFile(payload, "utf8"), "after failure\n");
    const baselineAfter = await readFile(join(artifacts, INPLACE_BASELINE_FILE), "utf8");
    assert.equal(baselineAfter, baselineBefore, "the original launch baseline is reused, not re-captured");
    assert.equal(settledTask.dispatch?.inPlace, true, "the requested continuation was actually dispatched in place");
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

// Regression (finding-4 follow-up): restoring an env var by plain assignment
// materializes the literal string "undefined" when the variable was originally
// absent, which corrupted TMPDIR for every later test in the file (CI runs with
// TMPDIR unset). The restore helper below must keep an absent variable absent.
test("restoring an env setting keeps its exact prior state in both branches", () => {
  const name = "PI_REVIEW_RESTORE_PROBE";
  // Originally absent: stays absent, never materialized as a value.
  delete process.env[name];
  restoreEnvSetting(name, undefined);
  assert.ok(!Object.hasOwn(process.env, name), "an absent variable must stay absent, not become the literal 'undefined'");
  assert.equal(process.env[name], undefined);
  // Originally present: the previous value is restored unchanged.
  process.env[name] = "prior-value";
  restoreEnvSetting(name, "prior-value");
  assert.ok(Object.hasOwn(process.env, name));
  assert.equal(process.env[name], "prior-value");
  delete process.env[name];
});

test("a workspace containing the system temp directory launches with artifacts stored outside it (finding-4)", async () => {
  const realTmp = await realpath(tmpdir());
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-tmpdir-scratch-"));
  // The selected workspace will BE the system temp directory as os.tmpdir()
  // computes it: TMPDIR is redirected to a controlled directory of the real
  // temp tree (bounded scan), the workspace is that directory, and the
  // execution root must be created outside it (its parent, the real temp
  // root). scratch stays disjoint so its removal cannot collide with the
  // relocated root.
  const smallTemp = await mkdtemp(join(realTmp, "pi-review-inplace-smalltmp-"));
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = smallTemp;
  let instance: BackgroundExecutionController | undefined;
  try {
    const workspace = await realpath(tmpdir());
    const payload = join(workspace, "made-in-temp.txt");
    const script = join(scratch, "inplace-tmpdir-executor.cjs");
    await writeFile(script, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      `if(prompt.includes('INPLACE_SENTINEL'))fs.writeFileSync(${JSON.stringify(payload)},'written in the temp workspace\\n');`,
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed the temp-workspace edit'}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(script, 0o755);
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: inplaceExternalConfig({ script }),
      state: createState(),
      cwd: () => workspace,
    });
    const started = await instance.start(
      [{ title: "temp workspace edit", instructions: "INPLACE_SENTINEL", acceptanceCriteria: ["made-in-temp.txt written"] }],
      "inplace",
      workspace,
    );
    assert.equal(started.kind, "inplace");
    assert.equal(started.cwd, workspace);
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => ["reported", "failed", "paused_recoverable", "interrupted"].includes(task.state)), 120_000);
    const task = instance.inspect(started.executionId).tasks[0]!;
    assert.equal(task.state, "reported", `temp workspace task settled at ${task.state}: ${task.error ?? ""} · last activity: ${task.activity.at(-1)?.message ?? ""}`);
    assert.equal(await readFile(payload, "utf8"), "written in the temp workspace\n");
    assert.ok(!isInsideTarget(workspace, task.artifactDir!), "the execution root is outside the selected temp workspace");
    // Guarded cleanup accepts the relocated base and removes the root. Under a
    // loaded host the settled task's save tail can race the removal; a bounded
    // retry re-runs cleanup for the still-owned group and verifies removal.
    const cleanupDeadline = Date.now() + 30_000;
    for (;;) {
      try {
        await instance.cleanupSettledArtifacts();
        await waitForPathGone(task.artifactDir!);
        break;
      } catch (error) {
        const message = error instanceof Error ? `${error.message}` : String(error);
        if (!/ENOTEMPTY|EBUSY/.test(message) || Date.now() > cleanupDeadline) throw error;
        await new Promise((done) => setTimeout(done, 150));
      }
    }
  } finally {
    restoreEnvSetting("TMPDIR", previousTmpDir);
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a review-error pause followed by continuation keeps distinct durable cycles and re-numbers the next cycle (finding-2)", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-cycles-"));
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  let instance: BackgroundExecutionController | undefined;
  try {
    const payload = join(workspace, "cycled.txt");
    const invokeCounter = join(scratch, "executor-invocations");
    const reviewCounter = join(scratch, "reviewer-invocations");
    const script = join(scratch, "inplace-cycles-executor.cjs");
    // The executor rewrites the reviewed file on its first two invocations
    // (initial: v1, first continuation: v2) and stays still afterwards, so
    // every review cycle's content-anchored identity is observable and pass
    // confirmation settles against stable contents.
    await writeFile(script, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const finish=()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed the in-place edit'}));",
      "};",
      `const counter=${JSON.stringify(invokeCounter)};const n=(fs.existsSync(counter)?(parseInt(fs.readFileSync(counter,'utf8'),10)||0):0)+1;fs.writeFileSync(counter,String(n));`,
      "const isInitial=prompt.includes('in-place implementation executor');",
      "const isContinuation=prompt.includes('Current continuation instructions');",
      `const file=${JSON.stringify(payload)};`,
      "if(isInitial){fs.writeFileSync(file,'v1\\n');finish();}",
      "else if(isContinuation){if(n===2){fs.writeFileSync(file,'v2\\n');}finish();}",
      "else{finish();}",
      "});",
    ].join("\n"), "utf8");
    await chmod(script, 0o755);
    // Scripted reviewer: deliberate 'error' verdicts for the first lifecycle
    // (the review pipeline retries errors, so it consumes several calls) and
    // 'pass' afterwards for the continuation's fresh cycle. The counter file
    // lives under scratch (never inside the workspace).
    const reviewerScript = join(scratch, "scripted-reviewer.cjs");
    await writeFile(reviewerScript, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      `const counter=${JSON.stringify(reviewCounter)};const n=(fs.existsSync(counter)?(parseInt(fs.readFileSync(counter,'utf8'),10)||0):0)+1;fs.writeFileSync(counter,String(n));`,
      "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify(",
      "n<=3?{verdict:'error',summary:'deliberate review infrastructure failure',findings:[],error:'deliberate_test_failure'}:",
      "{verdict:'pass',summary:'reviewed the recorded delta',findings:[]})),100));",
    ].join("\n"), "utf8");
    await chmod(reviewerScript, 0o755);
    instance = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config: normalizeConfig({
        enabled: true,
        review: { activeReviewers: [{ source: "external", id: "scripted" }] },
        externalAgents: {
          "inplace-fake": {
            adapter: "run-as-binary" as const,
            command: process.execPath,
            execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] },
          },
          "scripted": {
            adapter: "generic-cli",
            command: process.execPath,
            args: [],
            review: { args: [reviewerScript], timeoutMs: 5000 },
          },
        },
        execution: {
          maxWorkers: 1,
          workerResources: { "default": { selection: { source: "external", id: "inplace-fake" }, maxConcurrent: 1 } },
          routes: { execute: [{ resourceId: "default" }], research: [] },
        },
        retainBundles: "always",
      }),
      state: createState(),
      cwd: () => scratch,
    });
    const started = await instance.start(
      [{ title: "cycled in-place edits", instructions: "Write cycled.txt; the first review will fail on purpose", acceptanceCriteria: ["cycled.txt carries the final content"] }],
      "inplace",
      workspace,
    );
    const taskId = instance.inspect(started.executionId).tasks[0]!.taskId;
    // Lifecycle 1: review cycle 1 exhausts its error retries and pauses.
    await waitFor(() => ["paused_recoverable", "failed"].includes(instance!.inspect(started.executionId).tasks[0]!.state), 60_000);
    const paused = instance.inspect(started.executionId, taskId).tasks[0]!;
    const cycleOne = JSON.parse(await readFile(join(paused.artifactDir!, "reviews", "inplace", "cycle-000001.json"), "utf8")) as Record<string, unknown>;
    assert.equal(cycleOne.aggregate, "error", "the deliberately failing cycle record is durable before continuation");
    const identityOne = (cycleOne.attribution as Record<string, unknown>).deltaIdentitySha256 as string;
    assert.ok(typeof identityOne === "string" && identityOne.length > 0);
    // Lifecycle 2 (continuation): the next cycle number must START AFTER the
    // retained cycle-1 record, so the passing cycle publishes its OWN file.
    await continueWhenSettled(instance, started.executionId, {
      instructions: "Continue the task in this workspace.",
      instructionId: "continue-cycles",
      actor: "user",
    });
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => task.state === "reported"), 120_000);
    const settledTask = instance.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(settledTask.state, "reported");
    const cycleTwo = JSON.parse(await readFile(join(paused.artifactDir!, "reviews", "inplace", "cycle-000002.json"), "utf8")) as Record<string, unknown>;
    assert.equal(cycleTwo.aggregate, "pass", "the continuation's fresh cycle record is the passing one — not a collision with cycle 1");
    const attributionOne = cycleOne.attribution as Record<string, unknown>;
    const attributionTwo = cycleTwo.attribution as Record<string, unknown>;
    assert.notEqual(attributionOne.deltaIdentitySha256, attributionTwo.deltaIdentitySha256, "each cycle retains its own content identity");
    // The final result identifies the NEW passing cycle (2) — the retained
    // cycle-1 evidence stays in its durable file.
    const resultJson = JSON.parse(await readFile(join(paused.artifactDir!, "result.json"), "utf8")) as {
      status: string;
      reviewCycles: Array<{ cycle: number; verdict: string }>;
      reviewReport?: { reviewCycles: number; latestReviewSequence: number; aggregate: string };
    };
    assert.equal(resultJson.status, "reviewed");
    assert.deepEqual(resultJson.reviewCycles.map((cycle) => [cycle.cycle, cycle.verdict]), [[2, "pass"]]);
    assert.equal(resultJson.reviewReport?.aggregate, "pass");
    // The re-numbered cycle file itself proves the allocation advanced: the
    // passing record was published as cycle 2, never recycled from 1.
    assert.equal((cycleTwo as Record<string, unknown>).cycle, 2);
    assert.equal((cycleOne as Record<string, unknown>).cycle, 1);
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an aborted in-place turn whose started child never reports a verified exit fails closed with ownership retained (#310)", async () => {
  const scratch = await createInPlaceScratch("unverified-shutdown");
  const workspace = join(scratch, "selected-root");
  const artifactDir = join(scratch, "artifacts", "unverified-shutdown");
  await mkdir(workspace, { recursive: true });
  const config = inplaceExternalConfig({ script: "unused" });
  const entry = resolvedExecutorPool(config)[0];
  assert.ok(entry);
  const abort = new AbortController();
  let started!: () => void;
  const adapterStarted = new Promise<void>((resolvePromise) => { started = resolvePromise; });
  const adapter: ExecutorAdapter = {
    kind: "claude-cli",
    async run(request) {
      // The adapter could not verify its owned shutdown after an explicit
      // interrupt, so it never reports the child's exit.
      await request.onProcessStart?.({ pid: 900310 });
      started();
      await new Promise<void>((resolvePromise) => {
        if (request.signal?.aborted) resolvePromise();
        else request.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
      });
      return {
        text: "",
        session: { adapter: "claude-cli", id: "unverified-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 1,
        timedOut: false,
        aborted: true,
        failure: { category: "interruption" as const, message: "Claude query was interrupted. Claude CLI shutdown after explicit interruption was not verified: injected" },
      };
    },
  };
  try {
    const lifecycle = runInplaceLifecycle({
      taskId: "inplace-unverified-shutdown",
      task: { title: "Interrupted in place", instructions: "work", acceptanceCriteria: ["none"] },
      workspaceRoot: workspace,
      artifactDir,
      config,
      executorAssignment: { entry, priority: 0 },
      signal: abort.signal,
      adapterFactory: () => adapter,
    });
    await adapterStarted;
    abort.abort(new Error("interrupt_as_failure"));
    const result = await lifecycle;
    assert.notEqual(result.status, "reviewed");
    const operation = JSON.parse(await readFile(join(artifactDir, "operation.json"), "utf8")) as {
      state: string;
      incidents: Array<{ stage: string; terminalCode?: string; message: string }>;
      owner?: { status: string; childPid?: number; childExitedAt?: string };
    };
    assert.equal(operation.state, "failed_critical");
    const incident = operation.incidents.at(-1)!;
    assert.equal(incident.stage, "executor_shutdown");
    assert.equal(incident.terminalCode, "recovery_state_corrupt_or_unverifiable");
    assert.match(incident.message, /shutdown after explicit interruption was not verified: injected/);
    assert.equal(operation.owner?.status, "active");
    assert.equal(operation.owner?.childPid, 900310);
    assert.equal(operation.owner?.childExitedAt, undefined);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
