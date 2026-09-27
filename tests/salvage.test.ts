/**
 * #126 explicit worker-work salvage tests.
 *
 * Part A exercises the salvage module directly against real git fixtures
 * (attribution, non-destructive capture, ref enumeration/selection).
 * Part B drives the production controller paths: attached-HEAD checkpoint
 * failure with a retained dirty worktree, missing worktrees with surviving
 * refs (single / ambiguous / none), baseline abandonment, target conflicts,
 * live-writer refusal, restart durability, and the unchanged ordinary
 * verified-checkpoint force-merge path.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { createReattachmentBundle, readOperationRecord, writeOperationRecord, type OperationRecord } from "../src/execution/operation-record";
import { captureWaveBase, readWaveCaptureRecord, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import {
  assertConfinedSymlinkTarget,
  classifySalvagePaths,
  incidentBranchNames,
  selectSalvageSource,
  salvageWorktreeCandidate,
  type SalvageRefCandidate,
} from "../src/execution/salvage";
import { isActiveTaskState } from "../src/execution/task-state";
import { createState } from "../src/state";

const execFileAsync = promisify(execFile);

const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

/** Raw git output without trimming (file content assertions). */
async function gitRaw(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout;
}

async function mkTmp(prefix: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Create a target repository with a committed base plus optional setup. */
async function setupTarget(
  artifactDir: string,
  extraSetup?: (dir: string) => Promise<void>,
): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-salvage-target-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "base.txt"), "base\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "base"], sourceDir);
  if (extraSetup) await extraSetup(sourceDir);
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "salvage-wave",
    artifactDir,
  });
  return { sourceDir, capture };
}

/** Create a pre-existing branch from the target HEAD carrying its own file. */
async function makePreexistingBranch(dir: string, branch: string, file: string): Promise<void> {
  const main = await git(["symbolic-ref", "--short", "HEAD"], dir);
  await git(["checkout", "-q", "-b", branch], dir);
  await writeFile(join(dir, file), `${file} content\n`, "utf8");
  await git(["add", file], dir);
  await git(["commit", "--quiet", "-m", `pre-existing ${branch}`], dir);
  await git(["checkout", "-q", main], dir);
}

// ── Part A: salvage module against real git fixtures ────────────────────────

test("salvage — fast path: HEAD deriving from the base attributes every delta and never mutates the worktree", async () => {
  const artifactDir = await mkTmp("pi-salvage-unit-fast-");
  try {
    const { capture } = await setupTarget(artifactDir);
    const worker = await createWorkerWorktree(capture, "task-fast");
    // Worker work: a retained commit on a branch from the base, an unstaged
    // edit to a tracked file, and a task-created untracked file.
    await git(["checkout", "-q", "-b", "issue-42"], worker.worktreeRoot);
    await writeFile(join(worker.worktreeRoot, "committed.txt"), "worker committed\n", "utf8");
    await git(["add", "committed.txt"], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "worker commit"], worker.worktreeRoot);
    await writeFile(join(worker.worktreeRoot, "base.txt"), "worker modified base\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "dirty.txt"), "worker dirty\n", "utf8");

    const before = {
      status: await git(["status", "--porcelain"], worker.worktreeRoot),
      index: await git(["ls-files", "-s"], worker.worktreeRoot),
      head: await git(["rev-parse", "HEAD"], worker.worktreeRoot),
      branch: await git(["symbolic-ref", "--short", "HEAD"], worker.worktreeRoot),
    };

    const candidate = await salvageWorktreeCandidate(capture, "task-fast", "Fast path task", worker.worktreeRoot);

    assert.equal(candidate.sourceKind, "worktree");
    assert.equal(candidate.branchName, "issue-42");
    assert.ok(candidate.differsFromBase);
    assert.deepEqual(candidate.attributedPaths.sort(), ["base.txt", "committed.txt", "dirty.txt"]);
    assert.deepEqual(candidate.baselineOnlyPaths, []);
    assert.deepEqual(candidate.ambiguousPaths, []);

    // The candidate tree carries the on-disk content of every path.
    for (const [file, expected] of [
      ["committed.txt", "worker committed\n"],
      ["base.txt", "worker modified base\n"],
      ["dirty.txt", "worker dirty\n"],
    ] as const) {
      assert.equal(await gitRaw(["show", `${candidate.commitSha}:${file}`], worker.worktreeRoot), expected);
    }
    // Sole parent is the synthetic wave base.
    assert.equal(await git(["rev-parse", `${candidate.commitSha}^@`], worker.worktreeRoot), capture.baseCommit);

    // The capture is non-destructive: worktree, real index, and HEAD are untouched.
    assert.equal(await git(["status", "--porcelain"], worker.worktreeRoot), before.status);
    assert.equal(await git(["ls-files", "-s"], worker.worktreeRoot), before.index);
    assert.equal(await git(["rev-parse", "HEAD"], worker.worktreeRoot), before.head);
    assert.equal(await git(["symbolic-ref", "--short", "HEAD"], worker.worktreeRoot), before.branch);

    // The worktree is dirty by design; removeWorktree refuses dirty sources,
    // so the fixture teardown below removes the whole tree instead.
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("salvage — divergent history: pre-existing branch content is ambiguous, session commits are attributed", async () => {
  const artifactDir = await mkTmp("pi-salvage-unit-divergent-");
  try {
    const { capture } = await setupTarget(artifactDir, (dir) => makePreexistingBranch(dir, "alpha", "alpha.txt"));
    const worker = await createWorkerWorktree(capture, "task-divergent");
    // The worker continued the pre-existing branch with a session commit.
    await git(["checkout", "-q", "alpha"], worker.worktreeRoot);
    await writeFile(join(worker.worktreeRoot, "worker-a.txt"), "session work\n", "utf8");
    await git(["add", "worker-a.txt"], worker.worktreeRoot);
    await git(["commit", "--quiet", "-m", "session commit"], worker.worktreeRoot);
    const tip = await git(["rev-parse", "HEAD"], worker.worktreeRoot);
    const tree = await git(["rev-parse", "HEAD^{tree}"], worker.worktreeRoot);

    const classification = await classifySalvagePaths(capture, tip, tree);
    assert.deepEqual(classification.attributedPaths, ["worker-a.txt"]);
    assert.deepEqual(classification.ambiguousPaths, ["alpha.txt"]);
    assert.deepEqual(classification.baselineOnlyPaths, []);

    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("salvage — baseline-only abandonment: a base file the source checkout lacks is never a worker deletion", async () => {
  const artifactDir = await mkTmp("pi-salvage-unit-baseline-");
  try {
    // The target has an uncommitted file; the synthetic base contains it, but
    // no source branch can.
    const { capture } = await setupTarget(artifactDir, async (dir) => {
      await makePreexistingBranch(dir, "alpha", "alpha.txt");
      await writeFile(join(dir, "uncommitted-target.txt"), "target only\n", "utf8");
    });
    const tip = await git(["rev-parse", "refs/heads/alpha"], capture.repositoryPath);
    const tree = await git(["rev-parse", "refs/heads/alpha^{tree}"], capture.repositoryPath);

    const classification = await classifySalvagePaths(capture, tip, tree);
    assert.deepEqual(classification.attributedPaths, []);
    assert.deepEqual(classification.baselineOnlyPaths, ["uncommitted-target.txt"]);
    assert.deepEqual(classification.ambiguousPaths, ["alpha.txt"]);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("salvage — a base-tracked ignored file is never transferred as a worker deletion", async () => {
  const artifactDir = await mkTmp("pi-salvage-unit-ignored-tracked-");
  try {
    const { capture } = await setupTarget(artifactDir, async (dir) => {
      // The target tracks a file its own .gitignore also matches: the capture
      // includes tracked/indexed files regardless of ignore rules.
      await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
      await writeFile(join(dir, "keep.log"), "tracked log\n", "utf8");
      await git(["add", ".gitignore"], dir);
      await git(["add", "-f", "keep.log"], dir);
      await git(["commit", "--quiet", "-m", "track ignored log"], dir);
    });
    const worker = await createWorkerWorktree(capture, "task-ignored-tracked");
    await writeFile(join(worker.worktreeRoot, "worker.txt"), "worker\n", "utf8");

    const candidate = await salvageWorktreeCandidate(capture, "task-ignored-tracked", "Ignored tracked log", worker.worktreeRoot);

    // Only the worker's own file transfers; keep.log keeps its base content in
    // the candidate tree and is never reported as an attributed deletion.
    assert.deepEqual([...candidate.attributedPaths].sort(), ["worker.txt"]);
    assert.equal(await gitRaw(["show", `${candidate.commitSha}:keep.log`], worker.worktreeRoot), "tracked log\n");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("salvage — incident branch names and ref selection never guess among several candidates", () => {
  const record = {
    incidents: [
      { message: "Executor was cancelled, but its workspace checkpoint could not be verified: Worktree at \"/x\" is not on a detached HEAD (on branch \"issue-42\")." },
      { message: "unrelated incident without a branch" },
    ],
  } as unknown as OperationRecord;
  assert.deepEqual(incidentBranchNames(record), ["issue-42"]);

  const candidate = (refName: string, incidentNamed = false, taskOwned = false): SalvageRefCandidate => ({
    refName,
    tipSha: "a".repeat(40),
    attributedPaths: ["w.txt"],
    baselineOnlyPaths: [],
    ambiguousPaths: [],
    incidentNamed,
    ...(taskOwned ? { taskOwned: true } : {}),
  });

  assert.deepEqual(selectSalvageSource([]), {
    kind: "none",
    reason: "no surviving ref in the private repository carries provably worker-created or ambiguous content",
  });

  // Ambiguity-only candidates are surfaced (named), never selected, and never
  // reported as "no recoverable work".
  const ambiguityOnly: SalvageRefCandidate = {
    refName: "refs/heads/alpha",
    tipSha: "b".repeat(40),
    attributedPaths: [],
    baselineOnlyPaths: [],
    ambiguousPaths: ["alpha.txt"],
    incidentNamed: false,
  };
  const surfaced = selectSalvageSource([ambiguityOnly]);
  assert.equal(surfaced.kind, "ambiguous");
  if (surfaced.kind === "ambiguous") {
    assert.deepEqual(surfaced.candidates.map((c) => c.refName), ["refs/heads/alpha"]);
  }
  // An ambiguity-only ref alongside a selectable one stays in the listing.
  const mixed = selectSalvageSource([candidate("refs/heads/one"), ambiguityOnly]);
  assert.equal(mixed.kind, "ref");
  if (mixed.kind === "ref") {
    assert.deepEqual(mixed.unselected.map((c) => c.refName), ["refs/heads/alpha"]);
  }

  const single = selectSalvageSource([candidate("refs/heads/one")]);
  assert.equal(single.kind, "ref");
  if (single.kind === "ref") {
    assert.equal(single.candidate.refName, "refs/heads/one");
    assert.deepEqual(single.unselected, []);
  }

  const tieBroken = selectSalvageSource([candidate("refs/heads/a"), candidate("refs/heads/b", true)]);
  assert.equal(tieBroken.kind, "ref");
  if (tieBroken.kind === "ref") {
    assert.equal(tieBroken.candidate.refName, "refs/heads/b");
    assert.deepEqual(tieBroken.unselected.map((c) => c.refName), ["refs/heads/a"]);
  }

  const ambiguous = selectSalvageSource([candidate("refs/heads/a"), candidate("refs/heads/b")]);
  assert.equal(ambiguous.kind, "ambiguous");
  if (ambiguous.kind === "ambiguous") {
    assert.equal(ambiguous.candidates.length, 2);
  }

  // A sole surviving branch head is used only in a single-task wave: when
  // sibling tasks share the wave's private repository, an unnamed candidate
  // could be another task's branch, so selection falls through to ambiguous.
  // Durable incident evidence naming the ref as this task's own still selects
  // it, and a sole task-owned candidate (ownership proven by commit identity)
  // is selected even with siblings present.
  const soleWithSiblings = selectSalvageSource([candidate("refs/heads/one")], { hasSiblingTasks: true });
  assert.equal(soleWithSiblings.kind, "ambiguous");
  const soleNamedWithSiblings = selectSalvageSource([candidate("refs/heads/one", true)], { hasSiblingTasks: true });
  assert.equal(soleNamedWithSiblings.kind, "ref");
  if (soleNamedWithSiblings.kind === "ref") {
    assert.equal(soleNamedWithSiblings.candidate.refName, "refs/heads/one");
  }
  const soleOwnedWithSiblings = selectSalvageSource(
    [candidate("refs/pi-review-gate/waves/w/candidate-snapshots/task-1/t", false, true)],
    { hasSiblingTasks: true },
  );
  assert.equal(soleOwnedWithSiblings.kind, "ref");
  if (soleOwnedWithSiblings.kind === "ref") {
    assert.equal(soleOwnedWithSiblings.candidate.taskOwned, true);
  }
});

test("salvage — symlink confinement mirrors ordinary candidate normalization", () => {
  const root = "/worker-worktree";
  // Relative targets that stay inside the worker root transfer.
  assert.doesNotThrow(() => assertConfinedSymlinkTarget(root, "docs/link.md", "./target.md"));
  assert.doesNotThrow(() => assertConfinedSymlinkTarget(root, "a/b/link", "../sibling.txt"));
  assert.doesNotThrow(() => assertConfinedSymlinkTarget(root, "link", "sub/inner.txt"));
  // Absolute targets refuse the salvage.
  assert.throws(
    () => assertConfinedSymlinkTarget(root, "evil", "/etc/passwd"),
    /absolute target.*refusing to salvage/,
  );
  // Targets that escape the worker root refuse the salvage.
  assert.throws(
    () => assertConfinedSymlinkTarget(root, "a/link", "../../outside.txt"),
    /escapes the worker root.*refusing to salvage/,
  );
});

// ── Part B: production controller paths ─────────────────────────────────────

interface SalvageScenario {
  root: string;
  controller: BackgroundExecutionController;
  executionId: string;
  taskId: string;
  config: ReturnType<typeof normalizeConfig>;
  cleanup: () => Promise<void>;
}

function gitEnvLine(): string {
  return "const G={...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'t@example.com'};"
    + "const git=(...a)=>{const r=require('node:child_process').spawnSync('git',a,{cwd:process.cwd(),encoding:'utf8',env:G});"
    + "if(r.status!==0)throw new Error('git '+a.join(' ')+': '+(r.stderr||''));return r.stdout||''};";
}

function sessionLine(id: string): string {
  return `console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'${id}'}));`;
}

const ASSISTANT_LINE = "console.log(JSON.stringify({type:'assistant',text:'done'}));";
const HANG_LINE = "setTimeout(()=>{console.log(JSON.stringify({type:'assistant',text:'late completion'}));},30000);";

async function startSalvageScenario(
  unique: string,
  executorBody: string,
  targetSetup?: (dir: string) => Promise<void>,
): Promise<SalvageScenario> {
  const root = await mkTmp(`pi-salvage-ctl-${unique}-`);
  await git(["init", "--quiet"], root);
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await git(["add", "."], root);
  await git(["commit", "--quiet", "-m", "base"], root);
  if (targetSetup) await targetSetup(root);
  const executor = join(root, `salvage-executor-${unique}.cjs`);
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    gitEnvLine(),
    executorBody,
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "salvage": {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: "salvage" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  const controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
  const started = await controller.start([{
    title: `salvage ${unique}`,
    instructions: unique,
    acceptanceCriteria: ["work present"],
  }]);
  const taskId = started.tasks[0]!.taskId;
  return {
    root,
    controller,
    executionId: started.executionId,
    taskId,
    config,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function worktreeFileVisible(scenario: SalvageScenario, file: string): Promise<void> {
  await waitFor(async () => {
    const waveRoot = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.waveRoot;
    if (!waveRoot) return false;
    try {
      await stat(join(waveRoot, "workers", scenario.taskId, file));
      return true;
    } catch {
      return false;
    }
  }, 30_000, `worktree file ${file} visible`);
}

/** Wait for worker-authored content to land in the retained worktree. Presence
 * alone is not enough: base.txt exists from the checkout, so waiting on it can
 * beat the executor body and leave the worktree clean for settlement cleanup. */
async function worktreeFileContentVisible(scenario: SalvageScenario, file: string, expected: string): Promise<void> {
  await waitFor(async () => {
    const waveRoot = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.waveRoot;
    if (!waveRoot) return false;
    try {
      return (await readFile(join(waveRoot, "workers", scenario.taskId, file), "utf8")) === expected;
    } catch {
      return false;
    }
  }, 30_000, `worktree file ${file} content`);
}

async function readOperation(scenario: SalvageScenario): Promise<OperationRecord> {
  const waveRoot = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.waveRoot!;
  return readOperationRecord(join(waveRoot, "artifacts", scenario.taskId, "operation.json"));
}

/** forceMerge that tolerates the settle-to-quiesce window: the task state can
 * become inactive before the launch promise's cleanup deregisters the runtime,
 * so an early call is truthfully refused ("live or queued writer") and retried.
 * The probe consumes nothing: the command is recorded only after the gate. */
async function forceMergeQuiesced(
  scenario: SalvageScenario,
  input: { mergeAnyhow: boolean; instructionId: string },
): Promise<Awaited<ReturnType<BackgroundExecutionController["forceMerge"]>>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await scenario.controller.forceMerge({
        executionId: scenario.executionId,
        taskId: scenario.taskId,
        ...input,
        actor: "user",
      });
    } catch (error) {
      if (error instanceof Error && /live or queued writer/.test(error.message) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        continue;
      }
      throw error;
    }
  }
}

test("salvage — attached-HEAD checkpoint failure with a retained dirty worktree lands the actual worker work", async () => {
  const scenario = await startSalvageScenario("attached-dirty", [
    "git('checkout','-b','issue-42');",
    "fs.writeFileSync('committed.txt','worker committed\\n');",
    "git('add','committed.txt');",
    "git('commit','-qm','worker commit');",
    "fs.writeFileSync('base.txt','worker modified base\\n');",
    "fs.writeFileSync('dirty.txt','worker dirty\\n');",
    sessionLine("salvage-attached-dirty"),
    HANG_LINE,
  ].join("\n"));
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "dirty.txt");
    const interrupted = await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-1",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");

    // The ordinary checkpoint is impossible: attached HEAD failed
    // normalization. The cancel path records the critical diagnostic as an
    // incident; the settled lifecycle then finalizes the operation state as
    // paused_recoverable (no verified checkpoint exists).
    const record = await readOperation(scenario);
    assert.equal(record.state, "paused_recoverable");
    assert.equal(record.checkpoint, undefined);
    assert.ok(record.incidents.some((incident) => incident.stage === "cancellation_checkpoint" && incident.message.includes('on branch "issue-42"')));

    // No work reached the target yet.
    await assert.rejects(stat(join(scenario.root, "committed.txt")));
    await assert.rejects(stat(join(scenario.root, "dirty.txt")));

    const landed = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-force-1",
      actor: "user",
    });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");
    assert.match(task.summary ?? "", /salvage/i);

    // Every piece of actual worker work arrived.
    assert.equal(await readFile(join(scenario.root, "committed.txt"), "utf8"), "worker committed\n");
    assert.equal(await readFile(join(scenario.root, "dirty.txt"), "utf8"), "worker dirty\n");
    assert.equal(await readFile(join(scenario.root, "base.txt"), "utf8"), "worker modified base\n");

    // Durable forced-salvage provenance on the command record.
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-1")!;
    assert.equal(command.status, "acknowledged");
    assert.equal(command.salvage?.sourceKind, "worktree");
    assert.equal(command.salvage?.branchName, "issue-42");
    assert.deepEqual([...(command.salvage?.attributedPaths ?? [])].sort(), ["base.txt", "committed.txt", "dirty.txt"]);
    assert.deepEqual(command.salvage?.baselineOnlyPaths, []);
    assert.deepEqual(command.salvage?.ambiguousPaths, []);

    // Source evidence is preserved: the retained worktree is untouched.
    const worktreeRoot = record.worktreeRoot;
    assert.equal(await readFile(join(worktreeRoot, "committed.txt"), "utf8"), "worker committed\n");
    assert.equal(await readFile(join(worktreeRoot, "dirty.txt"), "utf8"), "worker dirty\n");
    assert.equal(await git(["symbolic-ref", "--short", "HEAD"], worktreeRoot), "issue-42");

    // Truthful operation state: salvage did not change it (still
    // paused_recoverable with no checkpoint), and added a salvage provenance
    // incident; no review status was asserted.
    const after = await readOperation(scenario);
    assert.equal(after.state, "paused_recoverable");
    assert.equal(after.checkpoint, undefined);
    assert.ok(after.incidents.some((incident) => incident.cause === "salvage" && incident.stage === "force_merge"));
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — missing worktree with a single surviving ref salvages from that ref", async () => {
  const scenario = await startSalvageScenario("missing-worktree-single", [
    "git('checkout','-b','issue-42');",
    "fs.writeFileSync('committed.txt','worker committed\\n');",
    "git('add','committed.txt');",
    "git('commit','-qm','worker commit');",
    sessionLine("salvage-missing-single"),
    ASSISTANT_LINE,
  ].join("\n"));
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    // The worker exits normally; normalization fails on the attached HEAD and
    // the clean worktree is removed at settlement.
    await waitFor(async () => {
      const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0];
      return Boolean(task && !isActiveTaskState(task.state));
    }, 30_000, "task settles");
    const settled = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!;
    assert.ok(["paused_recoverable", "interrupted", "failed"].includes(settled.state), `settled in ${settled.state}`);
    // Normalization failed (attached HEAD): the critical diagnostic is an
    // incident; the settled lifecycle finalizes the operation state as
    // paused_recoverable with no checkpoint.
    const record = await readOperation(scenario);
    assert.equal(record.state, "paused_recoverable");
    assert.equal(record.checkpoint, undefined);
    await waitFor(async () => {
      try {
        await stat(record.worktreeRoot);
        return false;
      } catch {
        return true;
      }
    }, 30_000, "clean worktree removed");

    const landed = await forceMergeQuiesced(scenario, { mergeAnyhow: false, instructionId: "salvage-force-2" });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");
    assert.equal(await readFile(join(scenario.root, "committed.txt"), "utf8"), "worker committed\n");
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-2")!;
    assert.equal(command.salvage?.sourceKind, "retained_ref");
    assert.equal(command.salvage?.refName, "refs/heads/issue-42");
    assert.deepEqual(command.salvage?.attributedPaths, ["committed.txt"]);

    // The retained ref remains as source evidence in the private repository.
    const waveRoot = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.waveRoot!;
    const capture = await readWaveCaptureRecord(waveRoot);
    assert.ok(await git(["rev-parse", "--verify", "refs/heads/issue-42"], capture.repositoryPath));
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — missing worktree with several plausible refs and no tie-break evidence transfers nothing", async () => {
  const scenario = await startSalvageScenario(
    "missing-worktree-ambiguous",
    [
      "git('checkout','alpha');",
      "fs.writeFileSync('worker-a.txt','A work\\n');",
      "git('add','.');",
      "git('commit','-qm','work a');",
      "git('checkout','beta');",
      "fs.writeFileSync('worker-b.txt','B work\\n');",
      "git('add','.');",
      "git('commit','-qm','work b');",
      "git('checkout','--detach');",
      sessionLine("salvage-missing-ambiguous"),
      ASSISTANT_LINE,
    ].join("\n"),
    async (dir) => {
      await makePreexistingBranch(dir, "alpha", "alpha.txt");
      await makePreexistingBranch(dir, "beta", "beta.txt");
    },
  );
  try {
    await waitFor(async () => {
      const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0];
      return Boolean(task && !isActiveTaskState(task.state));
    }, 30_000, "task settles");
    const record = await readOperation(scenario);
    assert.equal(record.state, "paused_recoverable");
    // The merge-base failure names no branch: no durable tie-break evidence.
    assert.ok(!record.incidents.some((incident) => /on branch "[^"]+"/.test(incident.message)));

    await assert.rejects(
      forceMergeQuiesced(scenario, { mergeAnyhow: false, instructionId: "salvage-force-3" }),
      /Multiple plausible salvage sources/,
    );
    const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!;
    assert.equal(task.state, "paused_recoverable");
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-3")!;
    assert.equal(command.status, "failed");
    assert.match(command.error ?? "", /refs\/heads\/alpha/);
    assert.match(command.error ?? "", /refs\/heads\/beta/);

    // Nothing was transferred: no session work reached the worktree and the
    // pre-existing branches are intact.
    await assert.rejects(stat(join(scenario.root, "worker-a.txt")));
    await assert.rejects(stat(join(scenario.root, "worker-b.txt")));
    assert.equal(await gitRaw(["show", "alpha:alpha.txt"], scenario.root), "alpha.txt content\n");
    assert.equal(await gitRaw(["show", "beta:beta.txt"], scenario.root), "beta.txt content\n");
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — missing worktree with only ambiguous surviving content names it instead of reporting none", async () => {
  const scenario = await startSalvageScenario(
    "missing-worktree-ambiguous-only",
    [
      "git('checkout','alpha');",
      sessionLine("salvage-missing-none"),
      ASSISTANT_LINE,
    ].join("\n"),
    (dir) => makePreexistingBranch(dir, "alpha", "alpha.txt"),
  );
  try {
    await waitFor(async () => {
      const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0];
      return Boolean(task && !isActiveTaskState(task.state));
    }, 30_000, "task settles");
    const record = await readOperation(scenario);
    assert.equal(record.state, "paused_recoverable");

    // The surviving ref carries only ambiguous (unprovable) content: it is
    // named as an unresolved candidate instead of being filtered out and
    // reported as nonexistent.
    await assert.rejects(
      forceMergeQuiesced(scenario, { mergeAnyhow: false, instructionId: "salvage-force-4" }),
      /Multiple plausible salvage sources/,
    );
    const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!;
    assert.equal(task.state, "paused_recoverable");
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-4")!;
    assert.equal(command.status, "failed");
    assert.match(command.error ?? "", /refs\/heads\/alpha/);
    assert.match(command.error ?? "", /attributed 0, ambiguous 1/);
    // The pre-existing branch content is not worker work: nothing moved into
    // the target and the target branch is intact.
    await assert.rejects(stat(join(scenario.root, "alpha.txt")));
    assert.equal(await gitRaw(["show", "alpha:alpha.txt"], scenario.root), "alpha.txt content\n");
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — baseline abandonment and ambiguity in a retained divergent worktree transfer only proven paths", async () => {
  const scenario = await startSalvageScenario(
    "divergent-worktree",
    [
      "git('checkout','alpha');",
      "fs.writeFileSync('new-on-alpha.txt','worker on alpha\\n');",
      sessionLine("salvage-divergent"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await makePreexistingBranch(dir, "alpha", "alpha.txt");
      // Uncommitted target file: present in the synthetic base, absent from
      // every source branch.
      await writeFile(join(dir, "uncommitted-target.txt"), "target only\n", "utf8");
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "new-on-alpha.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-5",
      actor: "user",
    });

    const landed = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-force-5",
      actor: "user",
    });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");

    // Only the proven session-local path transferred.
    assert.equal(await readFile(join(scenario.root, "new-on-alpha.txt"), "utf8"), "worker on alpha\n");
    // The baseline-only file was NOT deleted from the target...
    assert.equal(await readFile(join(scenario.root, "uncommitted-target.txt"), "utf8"), "target only\n");
    // ...and the ambiguous pre-existing branch content was neither materialized
    // into the worktree nor altered on its target branch.
    await assert.rejects(stat(join(scenario.root, "alpha.txt")));
    assert.equal(await gitRaw(["show", "alpha:alpha.txt"], scenario.root), "alpha.txt content\n");

    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-5")!;
    assert.deepEqual(command.salvage?.attributedPaths, ["new-on-alpha.txt"]);
    // Baseline-only: the captured uncommitted target file plus the test's own
    // executor script (untracked in the target at capture time). Both are
    // target-local content the divergent branch lacks — never deletions.
    assert.deepEqual(
      [...(command.salvage?.baselineOnlyPaths ?? [])].sort(),
      ["salvage-executor-divergent-worktree.cjs", "uncommitted-target.txt"],
    );
    assert.deepEqual(command.salvage?.ambiguousPaths, ["alpha.txt"]);
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — one explicit force-merge materializes text conflicts and lands clean paths", async () => {
  const scenario = await startSalvageScenario("conflict", [
    "git('checkout','-b','issue-42');",
    "fs.writeFileSync('base.txt','worker version\\n');",
    "fs.writeFileSync('dirty.txt','worker dirty\\n');",
    sessionLine("salvage-conflict"),
    HANG_LINE,
  ].join("\n"));
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "dirty.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-6",
      actor: "user",
    });

    // The target independently modified the same tracked file.
    await writeFile(join(scenario.root, "base.txt"), "target version\n", "utf8");

    // #126: there is no clean-only mode — the single explicit request merges
    // all identified work: clean paths apply and ordinary text conflicts
    // materialize diff3 markers in the same call. `mergeAnyhow` is accepted
    // for caller compatibility but controls nothing.
    const conflicted = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-force-6",
      actor: "user",
    });
    const task = conflicted.tasks[0]!;
    assert.equal(task.state, "conflicted");
    assert.deepEqual(conflicted.conflictGate?.paths, ["base.txt"]);
    // The conflicting path carries markers; the non-conflicting path landed.
    const marked = await readFile(join(scenario.root, "base.txt"), "utf8");
    assert.match(marked, /^<<<<<<< current workspace$/m);
    assert.match(marked, /^\|\|\|\|\|\|\| subtask base$/m);
    assert.match(marked, /^=======$/m);
    assert.match(marked, /^>>>>>>> forced subtask /m);
    assert.equal(await readFile(join(scenario.root, "dirty.txt"), "utf8"), "worker dirty\n");

    // The conflicted salvage still transferred non-conflicting paths, so its
    // forced-salvage provenance is recorded durably on the command and in the
    // operation record — it cannot later read like an ordinary merge.
    const conflictedCommand = task.commands.find((candidate) => candidate.instructionId === "salvage-force-6")!;
    assert.equal(conflictedCommand.salvage?.sourceKind, "worktree");
    assert.deepEqual([...(conflictedCommand.salvage?.attributedPaths ?? [])].sort(), ["base.txt", "dirty.txt"]);
    const conflictedRecord = await readOperation(scenario);
    assert.ok(
      conflictedRecord.incidents.some((incident) => incident.cause === "salvage"
        && /materialized conflicts from/.test(incident.message)
        && /1 conflict\(s\) await resolution \(base\.txt\)/.test(incident.message)),
    );

    // Marking clean is refused while the markers remain.
    await assert.rejects(scenario.controller.markClean({ actor: "user" }), /Conflict markers remain/);

    // Resolving the markers and marking clean lands the task; the forced-
    // salvage provenance survives that landing in both durable records.
    await writeFile(join(scenario.root, "base.txt"), "resolved\n", "utf8");
    const cleared = await scenario.controller.markClean({ actor: "user" });
    assert.equal(cleared.cleared, true);
    assert.deepEqual(cleared.paths, ["base.txt"]);
    const landedTask = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!;
    assert.equal(landedTask.state, "landed");
    const landedCommand = landedTask.commands.find((candidate) => candidate.instructionId === "salvage-force-6")!;
    assert.equal(landedCommand.salvage?.sourceKind, "worktree");
    assert.ok((await readOperation(scenario)).incidents.some((incident) => incident.cause === "salvage"));
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — binary conflicts preserve the target and save the worker version alongside", async () => {
  const scenario = await startSalvageScenario(
    "binary-conflict",
    [
      "fs.writeFileSync('image.bin', Buffer.from([0x00,0x01,0x02,0xff]));",
      "fs.writeFileSync('dirty.txt','worker dirty\\n');",
      sessionLine("salvage-binary-conflict"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await writeFile(join(dir, "image.bin"), Buffer.from([0x00, 0x10, 0x20]));
      await git(["add", "image.bin"], dir);
      await git(["commit", "--quiet", "-m", "binary base"], dir);
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "dirty.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-binary",
      actor: "user",
    });
    // The target's own binary version diverged from the base after capture.
    await writeFile(join(scenario.root, "image.bin"), Buffer.from([0x00, 0x30, 0x40]));

    const conflicted = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-binary-force",
      actor: "user",
    });
    const task = conflicted.tasks[0]!;
    assert.equal(task.state, "conflicted");
    assert.deepEqual(conflicted.conflictGate?.paths, ["image.bin"]);
    // The clean path still transferred; the binary conflict did not abort it.
    assert.equal(await readFile(join(scenario.root, "dirty.txt"), "utf8"), "worker dirty\n");
    // The target binary is preserved in place…
    assert.deepEqual(await readFile(join(scenario.root, "image.bin")), Buffer.from([0x00, 0x30, 0x40]));
    // …and the worker version is saved alongside under a collision-safe name.
    const sidecar = (await readdir(scenario.root)).find((entry) => /^image\.bin\.worker-[0-9a-f]{12}$/.test(entry));
    assert.ok(sidecar, "the worker binary version is saved alongside");
    assert.deepEqual(await readFile(join(scenario.root, sidecar!)), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    // Both paths are identified for manual resolution in the gate and summary.
    assert.match(task.summary ?? "", /image\.bin -> .*image\.bin\.worker-[0-9a-f]{12}/);
    assert.match(String(conflicted.conflictGate?.reason), /image\.bin\.worker-[0-9a-f]{12}/);

    // The conflict stays gated: marking clean is refused while the worker
    // version still sits alongside the preserved target.
    await assert.rejects(
      scenario.controller.markClean({ actor: "user" }),
      /still has its worker version saved alongside at .*image\.bin\.worker-[0-9a-f]{12}/,
    );

    // Choosing the target side means removing the worker version, then
    // marking clean lands the task with the target content intact.
    await rm(join(scenario.root, sidecar!));
    assert.equal((await scenario.controller.markClean({ actor: "user" })).cleared, true);
    assert.equal(scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.state, "landed");
    assert.deepEqual(await readFile(join(scenario.root, "image.bin")), Buffer.from([0x00, 0x30, 0x40]));
  } finally {
    await scenario.cleanup();
  }
});

// #126 approved U2 fallback (explicit force-merge only): a symlink/type
// conflict cannot carry text markers, so instead of aborting the whole merge
// the target is preserved intact and the worker version (its link target) is
// saved alongside while the remaining identified work still merges in the same call.
test("salvage — a symlink/type conflict is preserved with the worker version alongside", async () => {
  const scenario = await startSalvageScenario(
    "symlink-conflict",
    [
      // Worker replaces the base regular file with a symlink (a type change).
      "fs.rmSync('doc.txt');fs.symlinkSync('elsewhere','doc.txt');",
      "fs.writeFileSync('dirty.txt','worker dirty\\n');",
      sessionLine("salvage-symlink-conflict"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await writeFile(join(dir, "doc.txt"), "base doc\n", "utf8");
      await git(["add", "doc.txt"], dir);
      await git(["commit", "--quiet", "-m", "symlink base"], dir);
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "dirty.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-symlink",
      actor: "user",
    });
    // The target's own copy diverged from the base after capture (regular file).
    await writeFile(join(scenario.root, "doc.txt"), "target doc\n", "utf8");

    const conflicted = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-symlink-force",
      actor: "user",
    });
    const task = conflicted.tasks[0]!;
    assert.equal(task.state, "conflicted");
    assert.ok(conflicted.conflictGate?.paths.includes("doc.txt"), "the type conflict is gated for manual resolution");
    // The clean path still transferred in the same call — the merge did not abort.
    assert.equal(await readFile(join(scenario.root, "dirty.txt"), "utf8"), "worker dirty\n");
    // The target's regular file is preserved intact (not turned into a symlink)…
    const docStat = await stat(join(scenario.root, "doc.txt"));
    assert.ok(docStat.isFile() && !docStat.isSymbolicLink(), "the target stays a regular file");
    assert.equal(await readFile(join(scenario.root, "doc.txt"), "utf8"), "target doc\n");
    // …and the worker's symlink version is recorded alongside (its target string).
    const sidecar = (await readdir(scenario.root)).find((entry) => /^doc\.txt\.worker-[0-9a-f]{12}$/.test(entry));
    assert.ok(sidecar, "the worker symlink version is saved alongside");
    assert.equal(await readFile(join(scenario.root, sidecar!), "utf8"), "elsewhere");
    // Both are named for manual resolution; the gate stays while the sidecar exists.
    assert.match(String(conflicted.conflictGate?.reason), /doc\.txt\.worker-[0-9a-f]{12}/);
    await assert.rejects(
      scenario.controller.markClean({ actor: "user" }),
      /still has its worker version saved alongside at .*doc\.txt\.worker-[0-9a-f]{12}/,
    );
    // Resolving by keeping the target means removing the sidecar, then markClean.
    await rm(join(scenario.root, sidecar!));
    assert.equal((await scenario.controller.markClean({ actor: "user" })).cleared, true);
    assert.equal(scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.state, "landed");
  } finally {
    await scenario.cleanup();
  }
});

// #126 approved U2 fallback (explicit force-merge only): a worker-side deletion
// of an unrepresentable (binary) path has no bytes to save. The target is
// preserved intact, the deletion intent is recorded without fabricating content,
// and the remaining identified work still merges in the same call.
test("salvage — a binary worker-side deletion is recorded without fabricating bytes", async () => {
  const scenario = await startSalvageScenario(
    "binary-deletion",
    [
      // Worker deletes the base binary file.
      "fs.rmSync('gone.bin');",
      "fs.writeFileSync('dirty.txt','worker dirty\\n');",
      sessionLine("salvage-binary-deletion"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await writeFile(join(dir, "gone.bin"), Buffer.from([0x00, 0x10, 0x20]));
      await git(["add", "gone.bin"], dir);
      await git(["commit", "--quiet", "-m", "binary base"], dir);
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "dirty.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-deletion",
      actor: "user",
    });
    // The target's own copy diverged from the base after capture (delete/modify).
    await writeFile(join(scenario.root, "gone.bin"), Buffer.from([0x00, 0x30, 0x40]));

    const conflicted = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-deletion-force",
      actor: "user",
    });
    const task = conflicted.tasks[0]!;
    assert.equal(task.state, "conflicted");
    assert.ok(conflicted.conflictGate?.paths.includes("gone.bin"), "the deletion conflict is gated for manual resolution");
    // The clean path still transferred in the same call — the merge did not abort.
    assert.equal(await readFile(join(scenario.root, "dirty.txt"), "utf8"), "worker dirty\n");
    // The target's binary is preserved intact (NOT deleted by the worker side)…
    assert.deepEqual(await readFile(join(scenario.root, "gone.bin")), Buffer.from([0x00, 0x30, 0x40]));
    // …and no worker bytes were fabricated: there is no sidecar for a deletion.
    const entries = await readdir(scenario.root);
    assert.ok(!entries.some((entry) => /^gone\.bin\.worker-/.test(entry)), "no worker version is fabricated for a deletion");
    // The gate records the deletion intent without a sidecar path to validate.
    const gateSidecar = (conflicted.conflictGate?.sidecars ?? []).find((item) => item.path === "gone.bin");
    assert.ok(gateSidecar, "the deletion conflict is recorded in the gate");
    assert.equal(gateSidecar!.sidecarPath, undefined, "a worker-side deletion has no sidecar to validate");
    // Record-only: markClean is the explicit resolution act (no file to check).
    assert.equal((await scenario.controller.markClean({ actor: "user" })).cleared, true);
    assert.equal(scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.state, "landed");
  } finally {
    await scenario.cleanup();
  }
});

// #126 approved U2 fallback (explicit force-merge only): one force-merge call
// landing a clean path, an ordinary diff3 text conflict, and a preserved
// non-text (symlink/type) conflict together pins the mixed gate — the marker
// check on the text path plus the sidecar-existence check on the preserved path
// must BOTH be satisfied before markClean clears.
test("salvage — a mixed clean / text-conflict / preserved landing gates until both resolve", async () => {
  const scenario = await startSalvageScenario(
    "mixed-conflict",
    [
      // Worker modifies the shared base file (text conflict with the target).
      "fs.writeFileSync('shared.txt','worker shared\\n');",
      // Worker replaces doc.txt with a symlink (a type change → preserved + sidecar).
      "fs.rmSync('doc.txt');fs.symlinkSync('elsewhere','doc.txt');",
      // Worker creates a clean-only file.
      "fs.writeFileSync('dirty.txt','worker dirty\\n');",
      sessionLine("salvage-mixed-conflict"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await writeFile(join(dir, "shared.txt"), "base shared\n", "utf8");
      await writeFile(join(dir, "doc.txt"), "base doc\n", "utf8");
      await git(["add", "shared.txt", "doc.txt"], dir);
      await git(["commit", "--quiet", "-m", "mixed base"], dir);
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "dirty.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-mixed",
      actor: "user",
    });
    // The target diverges from the base on both conflict paths after capture.
    await writeFile(join(scenario.root, "shared.txt"), "target shared\n", "utf8");
    await writeFile(join(scenario.root, "doc.txt"), "target doc\n", "utf8");

    const conflicted = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-mixed-force",
      actor: "user",
    });
    assert.equal(conflicted.tasks[0]!.state, "conflicted");
    // The clean path still transferred in the same call — the merge did not abort.
    assert.equal(await readFile(join(scenario.root, "dirty.txt"), "utf8"), "worker dirty\n");
    // The ordinary text conflict landed as diff3 markers on shared.txt…
    const shared = await readFile(join(scenario.root, "shared.txt"), "utf8");
    assert.match(shared, /<<<<<<< /);
    assert.match(shared, /=======/);
    assert.match(shared, />>>>>>> /);
    // …and the preserved type conflict kept doc.txt an intact regular file with
    // the worker's symlink version saved alongside.
    const docStat = await stat(join(scenario.root, "doc.txt"));
    assert.ok(docStat.isFile() && !docStat.isSymbolicLink(), "the target stays a regular file");
    assert.equal(await readFile(join(scenario.root, "doc.txt"), "utf8"), "target doc\n");
    const sidecar = (await readdir(scenario.root)).find((entry) => /^doc\.txt\.worker-[0-9a-f]{12}$/.test(entry));
    assert.ok(sidecar, "the worker symlink version is saved alongside");
    // The gate names both the text-conflict path and the preserved path.
    assert.ok(conflicted.conflictGate?.paths.includes("shared.txt"), "text conflict is gated");
    assert.ok(conflicted.conflictGate?.paths.includes("doc.txt"), "preserved conflict is gated");
    const gateDoc = (conflicted.conflictGate?.sidecars ?? []).find((item) => item.path === "doc.txt");
    assert.ok(gateDoc && typeof gateDoc.sidecarPath === "string", "the preserved entry records its sidecar");

    // markClean is refused while the text-conflict markers remain…
    await assert.rejects(
      scenario.controller.markClean({ actor: "user" }),
      /Conflict markers remain in:/,
    );
    // …and, once the markers are resolved, still while the sidecar exists.
    await writeFile(join(scenario.root, "shared.txt"), "resolved shared\n", "utf8");
    await assert.rejects(
      scenario.controller.markClean({ actor: "user" }),
      /still has its worker version saved alongside at .*doc\.txt\.worker-[0-9a-f]{12}/,
    );
    // Removing the sidecar (choosing the target) satisfies both checks.
    await rm(join(scenario.root, sidecar!));
    assert.equal((await scenario.controller.markClean({ actor: "user" })).cleared, true);
    assert.equal(scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.state, "landed");
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — a live writer still blocks force-merge before any salvage", async () => {
  const scenario = await startSalvageScenario("live-writer", [
    sessionLine("salvage-live"),
    HANG_LINE,
  ].join("\n"));
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await assert.rejects(
      scenario.controller.forceMerge({
        executionId: scenario.executionId,
        taskId: scenario.taskId,
        mergeAnyhow: false,
        instructionId: "salvage-force-7",
        actor: "user",
      }),
      /live or queued writer/,
    );
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-7",
      actor: "user",
    });
    await waitFor(async () => {
      const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0];
      return Boolean(task && !isActiveTaskState(task.state));
    }, 30_000, "task settles");
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — a salvaged landing survives restart without continuation eligibility", async () => {
  const root = await mkTmp("pi-salvage-ctl-restart-");
  let controller: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    await git(["init", "--quiet"], root);
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await git(["add", "."], root);
    await git(["commit", "--quiet", "-m", "base"], root);
    const executor = join(root, "salvage-restart.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      gitEnvLine(),
      "if(prompt.includes('RESTART_ONE')){",
      "git('checkout','-b','issue-42');",
      "fs.writeFileSync('salvaged.txt','worker salvaged\\n');",
      "fs.writeFileSync('base.txt','worker modified base\\n');",
      "}else{",
      "git('checkout','-b','issue-43');",
      "fs.writeFileSync('other.txt','other work\\n');",
      "}",
      sessionLine("salvage-restart"),
      HANG_LINE,
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "salvage": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" },
        },
      },
      execution: {
        maxWorkers: 1,
        workerResources: { "default": { selection: { source: "external", id: "salvage" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([
      { title: "restart one", instructions: "RESTART_ONE", acceptanceCriteria: ["salvaged.txt exists"] },
      { title: "restart two", instructions: "RESTART_TWO", acceptanceCriteria: ["other.txt exists"] },
    ]);
    const executionId = started.executionId;
    const taskOneId = started.tasks[0]!.taskId;
    const taskTwoId = started.tasks[1]!.taskId;

    // Task one: attached branch + dirty worktree, interrupted, salvaged.
    await waitFor(() => controller!.inspect(executionId, taskOneId).tasks[0]?.state === "running");
    await waitFor(async () => {
      const waveRoot = controller!.inspect(executionId, taskOneId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      try {
        await stat(join(waveRoot, "workers", taskOneId, "salvaged.txt"));
        return true;
      } catch {
        return false;
      }
    }, 30_000, "task one work visible");
    await controller.interrupt({
      executionId, taskId: taskOneId, mode: "interrupt_as_failure",
      instructionId: "restart-interrupt-1", actor: "user",
    });
    const landed = await controller.forceMerge({
      executionId, taskId: taskOneId, mergeAnyhow: false,
      instructionId: "restart-force-1", actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");

    // Task two: interrupted and left for inspection so the group survives.
    await waitFor(() => controller!.inspect(executionId, taskTwoId).tasks[0]?.state === "running");
    await waitFor(async () => {
      const waveRoot = controller!.inspect(executionId, taskTwoId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      try {
        await stat(join(waveRoot, "workers", taskTwoId, "other.txt"));
        return true;
      } catch {
        return false;
      }
    }, 30_000, "task two work visible");
    await controller.interrupt({
      executionId, taskId: taskTwoId, mode: "interrupt_as_failure",
      instructionId: "restart-interrupt-2", actor: "user",
    });
    await waitFor(async () => {
      const task = controller!.inspect(executionId, taskTwoId).tasks[0];
      return Boolean(task && !isActiveTaskState(task.state));
    }, 30_000, "task two settles");

    // No laundering: continuing the salvaged task is refused. The settled
    // bundle is now stale (salvage provenance advanced the operation
    // revision) and is refused as such; even a current bundle cannot start a
    // continuation because no checkpoint was ever verified.
    const landedTask = controller.inspect(executionId, taskOneId).tasks[0]!;
    assert.ok(landedTask.bundle, "the worker result carried a reattachment bundle");
    await assert.rejects(
      controller.continueTask({
        executionId, taskId: taskOneId, bundle: landedTask.bundle!,
        instructions: "continue", instructionId: "restart-continue-stale", actor: "user",
      }),
      /Stale reattachment bundle/,
    );
    const waveRootOne = controller.inspect(executionId, taskOneId).tasks[0]!.waveRoot!;
    const currentRecord = await readOperationRecord(join(waveRootOne, "artifacts", taskOneId, "operation.json"));
    const currentBundle = createReattachmentBundle(currentRecord, waveRootOne);
    await assert.rejects(
      controller.continueTask({
        executionId, taskId: taskOneId, bundle: currentBundle,
        instructions: "continue", instructionId: "restart-continue", actor: "user",
      }),
      /Recovery checkpoint is not verified/,
    );

    // Restart.
    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    config.execution!.maxWorkers = 0;
    restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);

    // The salvaged landing is durable: state, provenance, and target content.
    const restoredTaskOne = restored.inspect(executionId, taskOneId).tasks[0]!;
    assert.equal(restoredTaskOne.state, "landed");
    await waitFor(async () => {
      const task = restored!.inspect(executionId, taskOneId).tasks[0];
      return Boolean(task?.commands.some((command) => command.action === "force_merge" && command.salvage));
    }, 30_000, "salvage provenance visible after restore");
    const provenance = restoredTaskOne.commands.find((command) => command.action === "force_merge")!.salvage;
    assert.equal(provenance?.sourceKind, "worktree");
    assert.equal(provenance?.branchName, "issue-42");
    assert.equal(await readFile(join(root, "salvaged.txt"), "utf8"), "worker salvaged\n");
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "worker modified base\n");

    // The settled task's wave root was cleaned: no second force-merge anchor.
    await assert.rejects(
      restored.forceMerge({
        executionId, taskId: taskOneId, mergeAnyhow: false,
        instructionId: "restart-force-2", actor: "user",
      }),
      /no durable wave ownership anchor/,
    );

    // The untouched interrupted task survives the restart for inspection.
    const restoredTaskTwo = restored.inspect(executionId, taskTwoId).tasks[0]!;
    assert.equal(restoredTaskTwo.state, "interrupted");
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("salvage — partial-attribution source bytes survive shutdown and restore", async () => {
  const scenario = await startSalvageScenario(
    "retention-restart",
    [
      "git('checkout','alpha');",
      "fs.writeFileSync('new-on-alpha.txt','worker on alpha\\n');",
      sessionLine("salvage-retention"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await makePreexistingBranch(dir, "alpha", "alpha.txt");
      await writeFile(join(dir, "uncommitted-target.txt"), "target only\n", "utf8");
    },
  );
  let restored: BackgroundExecutionController | undefined;
  let waveRoot: string | undefined;
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "new-on-alpha.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "retention-interrupt",
      actor: "user",
    });
    const landed = await forceMergeQuiesced(scenario, { mergeAnyhow: false, instructionId: "retention-force" });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");
    // The pre-existing branch content is not provably worker work: it stays
    // untransferred and its source bytes must be retained for inspection.
    assert.deepEqual(
      task.commands.find((command) => command.instructionId === "retention-force")!.salvage?.ambiguousPaths,
      ["alpha.txt"],
    );
    waveRoot = task.waveRoot;
    assert.ok(waveRoot, "the landed salvage keeps its wave root while evidence is unresolved");
    const retainedSource = join(waveRoot, "workers", scenario.taskId, "alpha.txt");
    assert.equal(await readFile(retainedSource, "utf8"), "alpha.txt content\n");

    // Shutdown and restore: the retained wave root, provenance, and bytes
    // survive with the landed state and no automatic re-landing.
    const associations = scenario.controller.associations();
    await scenario.controller.shutdown();
    await scenario.controller.detach();
    scenario.config.execution!.maxWorkers = 0;
    restored = new BackgroundExecutionController({ pi: {}, config: scenario.config, state: createState(), cwd: () => scenario.root });
    await restored.restore(associations);
    const restoredTask = restored.inspect(scenario.executionId, scenario.taskId).tasks[0]!;
    assert.equal(restoredTask.state, "landed");
    assert.equal(restoredTask.waveRoot, waveRoot);
    assert.deepEqual(
      restoredTask.commands.find((command) => command.instructionId === "retention-force")!.salvage?.ambiguousPaths,
      ["alpha.txt"],
    );
    assert.equal(await readFile(retainedSource, "utf8"), "alpha.txt content\n");
    // No automatic re-landing: exactly the one explicit force-merge command.
    assert.deepEqual(
      restoredTask.commands.filter((command) => command.action === "force_merge").map((command) => command.instructionId),
      ["retention-force"],
    );
  } finally {
    await restored?.shutdown().catch(() => undefined);
    if (waveRoot) await rm(waveRoot, { recursive: true, force: true }).catch(() => undefined);
    await scenario.cleanup();
  }
});

test("salvage — the ordinary verified-checkpoint force-merge path is unchanged and records no salvage provenance", async () => {
  const scenario = await startSalvageScenario("ordinary-checkpoint", [
    "fs.writeFileSync('draft.txt','recover me\\n');",
    sessionLine("salvage-ordinary"),
    HANG_LINE,
  ].join("\n"));
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "draft.txt");
    const interrupted = await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-8",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    const record = await readOperation(scenario);
    assert.ok(record.checkpoint, "detached HEAD yields a verified checkpoint on cancellation");

    const landed = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-force-8",
      actor: "user",
    });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");
    assert.match(task.summary ?? "", /force-merged mechanically/i);
    assert.equal(await readFile(join(scenario.root, "draft.txt"), "utf8"), "recover me\n");
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-8")!;
    assert.equal(command.status, "acknowledged");
    assert.equal(command.salvage, undefined, "ordinary checkpoint landings carry no salvage provenance");
  } finally {
    await scenario.cleanup();
  }
});

test("salvage — a verified checkpoint under failed_critical lands as an explicit forced checkpoint", async () => {
  const scenario = await startSalvageScenario("forced-checkpoint", [
    "fs.writeFileSync('draft.txt','recover me\\n');",
    sessionLine("salvage-forced"),
    HANG_LINE,
  ].join("\n"));
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileVisible(scenario, "draft.txt");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-9",
      actor: "user",
    });
    // Simulate the lifecycle inconsistency: the operation record ends
    // failed_critical while its checkpoint remains verifiable.
    const waveRoot = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!.waveRoot!;
    const recordPath = join(waveRoot, "artifacts", scenario.taskId, "operation.json");
    const record = await readOperationRecord(recordPath);
    assert.ok(record.checkpoint, "the cancellation checkpoint exists");
    record.state = "failed_critical";
    await writeOperationRecord(record);

    const landed = await scenario.controller.forceMerge({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mergeAnyhow: false,
      instructionId: "salvage-force-9",
      actor: "user",
    });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");
    assert.equal(await readFile(join(scenario.root, "draft.txt"), "utf8"), "recover me\n");
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-force-9")!;
    assert.equal(command.salvage?.sourceKind, "verified_checkpoint");
    assert.match(command.salvage?.reason ?? "", /failed_critical/);
    // The operation state stays truthful and gains a salvage provenance incident.
    const after = await readOperationRecord(recordPath);
    assert.equal(after.state, "failed_critical");
    assert.ok(after.incidents.some((incident) => incident.cause === "salvage"));
  } finally {
    await scenario.cleanup();
  }
});



// #126 H1 acceptance branch: a verified checkpoint is superseded when the
// retained worktree provably continued from it. The cancellation checkpoint
// normalizes the worktree onto its candidate commit (whose tree is exactly the
// checkpoint tree); an ignored file keeps the worktree retained for diagnosis,
// and newer committed work on top of that candidate descends through a commit
// carrying the checkpoint tree — so the difference is provably newer.
test("salvage — a verified checkpoint is superseded by provably newer committed work", async () => {
  const scenario = await startSalvageScenario(
    "supersede-newer",
    [
      "fs.mkdirSync('ignored', { recursive: true });",
      "fs.writeFileSync('ignored/junk.txt','junk\\n');",
      "fs.writeFileSync('base.txt','worker v1\\n');",
      "git('add','.'); git('commit','-qm','session one');",
      "fs.writeFileSync('ignored/commit-complete.txt','ready\\n');",
      sessionLine("salvage-supersede-newer"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await writeFile(join(dir, ".gitignore"), "ignored/\n", "utf8");
      await git(["add", ".gitignore"], dir);
      await git(["commit", "--quiet", "-m", "gitignore"], dir);
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileContentVisible(scenario, "base.txt", "worker v1\n");
    // The base edit is visible before the executor's synchronous git add/commit
    // has necessarily finished. Wait for a marker written after git returns, or
    // interrupting now can kill that child mid-index update and make the
    // cancellation checkpoint fail on a stale index.lock.
    await worktreeFileContentVisible(scenario, "ignored/commit-complete.txt", "ready\n");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-supersede-1",
      actor: "user",
    });
    const record = await readOperation(scenario);
    assert.equal(record.state, "cancelled");
    assert.ok(record.checkpoint?.commitSha, "the detached-HEAD committed state must verify as a checkpoint");

    // The worktree survived settlement (its ignored file keeps it non-clean)
    // and its HEAD is the checkpoint candidate itself. Newer work continues
    // from there.
    const worktreeRoot = record.worktreeRoot;
    await writeFile(join(worktreeRoot, "base.txt"), "worker v2\n", "utf8");
    await git(["add", "."], worktreeRoot);
    await git(["commit", "--quiet", "-m", "session two"], worktreeRoot);

    const landed = await forceMergeQuiesced(scenario, { mergeAnyhow: false, instructionId: "salvage-supersede-1" });
    const task = landed.tasks[0]!;
    assert.equal(task.state, "landed");
    assert.equal(await readFile(join(scenario.root, "base.txt"), "utf8"), "worker v2\n");
    // The supersession is provenance of the merge that actually consumed the
    // retained worktree; a later call would find the worktree inside the
    // checkpoint and take the ordinary checkpoint path with no salvage.
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-supersede-1")!;
    assert.equal(command.salvage?.sourceKind, "worktree");
    assert.ok(command.salvage?.supersededCheckpoint, "the superseded checkpoint is recorded in provenance");
    assert.equal(command.salvage?.supersededCheckpoint?.commitSha, record.checkpoint?.commitSha);
  } finally {
    await scenario.cleanup();
  }
});

// #126 H1 refusal branch: when the retained worktree was reset to an older
// state and edited there, no commit on its history carries the checkpoint
// tree, so a differing checkpoint delta has no provable ordering. The landing
// refuses as ambiguous instead of guessing which side is newer.
test("salvage — a differing checkpoint delta without provable ordering refuses", async () => {
  const scenario = await startSalvageScenario(
    "supersede-unordered",
    [
      "fs.mkdirSync('ignored', { recursive: true });",
      "fs.writeFileSync('ignored/junk.txt','junk\\n');",
      "fs.writeFileSync('base.txt','worker v1\\n');",
      sessionLine("salvage-supersede-unordered"),
      HANG_LINE,
    ].join("\n"),
    async (dir) => {
      await writeFile(join(dir, ".gitignore"), "ignored/\n", "utf8");
      await git(["add", ".gitignore"], dir);
      await git(["commit", "--quiet", "-m", "gitignore"], dir);
    },
  );
  try {
    await waitFor(() => scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]?.state === "running");
    await worktreeFileContentVisible(scenario, "base.txt", "worker v1\n");
    await scenario.controller.interrupt({
      executionId: scenario.executionId,
      taskId: scenario.taskId,
      mode: "interrupt_as_failure",
      instructionId: "salvage-interrupt-supersede-2",
      actor: "user",
    });
    const record = await readOperation(scenario);
    assert.equal(record.state, "cancelled");
    assert.ok(record.checkpoint?.commitSha, "the dirty detached-HEAD state must verify as a checkpoint");

    // The worktree survived settlement (ignored file keeps it non-clean).
    // Reset it to the pre-acceptance base state — the candidate's parent —
    // and edit there: no commit on its history carries the checkpoint tree.
    const worktreeRoot = record.worktreeRoot;
    const baseCommit = await git(["rev-parse", "HEAD^"], worktreeRoot);
    await git(["checkout", "--quiet", baseCommit], worktreeRoot);
    await writeFile(join(worktreeRoot, "base.txt"), "worker v2\n", "utf8");

    await assert.rejects(
      forceMergeQuiesced(scenario, { mergeAnyhow: false, instructionId: "salvage-supersede-2" }),
      /not a provable superset/,
    );
    const task = scenario.controller.inspect(scenario.executionId, scenario.taskId).tasks[0]!;
    assert.ok(["interrupted", "paused_recoverable"].includes(task.state), `task stays ${task.state}`);
    const command = task.commands.find((candidate) => candidate.instructionId === "salvage-supersede-2")!;
    assert.equal(command.status, "failed");
    assert.match(command.error ?? "", /not a provable superset/);
    // Nothing was transferred.
    assert.equal(await readFile(join(scenario.root, "base.txt"), "utf8"), "base\n");
  } finally {
    await scenario.cleanup();
  }
});
