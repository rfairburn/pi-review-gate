// Issue #175 regression coverage: the human-selected `reviewLandedChanges`
// policy in the landed split-config API (`effectiveReviewSettings(config)`).
// When automatic primary review AND the landed option are both on, an
// UNREVIEWED same-workspace landing's diff stays in the primary review
// window's ordinary baseline instead of being selectively checkpointed away:
// it is reviewed at the model's normal idle settlement alongside the parent's
// own edits. A landing whose content already carries a successful subtask
// review (accepted with a passing final review cycle) is not double-reviewed
// and keeps the existing selective checkpoint. An outcome whose review status
// cannot be established fails closed: the diff stays in the window and the
// uncertainty is reported rather than guessed. No review trigger fires at
// landing, no immediate review happens, and no verdict is invented by the
// controller. With either toggle off, the exact prior selective-checkpoint
// behavior is preserved (the primary window persists for later manual
// own-edit review). The foreign-target identity guard from issue #25 keeps
// unrelated target landings out of the parent window in every combination,
// and (with the policy on) same-workspace conflict gates stay review-readiness
// blockers until SubtasksMarkClean, so conflict markers are never reviewed as
// resolved work; only the final resolved diff becomes landed evidence.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareSnapshots, createWorkspaceSnapshot, type WorkspaceSnapshot } from "../src/capture";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  BackgroundExecutionController,
  type BackgroundInspection,
  type BackgroundTaskDefinition,
} from "../src/execution/background-controller";
import { inspectOperation } from "../src/execution/operation-actions";
import { readOperationRecord, writeOperationRecord } from "../src/execution/operation-record";
import { activeExchangeBaseline, beginAgentRun, createState, rememberUserRequest, setReviewWindowBaseline, type ReviewGateState } from "../src/state";
import { initGitRepo, waitFor, waitForAsync } from "./helpers/background-controller-fixtures";

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function task(title: string, instructions: string): BackgroundTaskDefinition {
  return { title, instructions, acceptanceCriteria: [`${title} marker landed`] };
}

/**
 * Fake executor seam (same transport as the established fixtures): writes the
 * file named by the matching sentinel's action when the prompt contains the
 * sentinel, and optionally mutates a prepared target file mid-turn so the
 * landing plan conflicts against the earlier capture.
 */
async function writeLandingExecutorScript(
  root: string,
  actions: Array<{ sentinel: string; file: string; targetShared?: string; targetSharedContent?: string; worktreeShared?: string }>,
): Promise<string> {
  const script = join(root, `executor-landed-${actions.map((a) => a.sentinel.toLowerCase()).join("-")}.cjs`);
  await writeFile(script, [
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    `process.stdin.on('end',()=>{const actions=${JSON.stringify(actions)};`,
    "for(const action of actions){if(prompt.includes(action.sentinel)){",
    "fs.writeFileSync(action.file,action.file+' landed\\n');",
    "if(action.worktreeShared!==undefined){fs.writeFileSync('shared.txt',action.worktreeShared);}",
    "if(action.targetShared!==undefined){fs.writeFileSync(action.targetShared,action.targetSharedContent);}}}",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
  ].join("\n"), "utf8");
  await chmod(script, 0o755);
  return script;
}

function executionConfig(
  script: string,
  review: { primaryEnabled?: boolean; reviewLandedChanges?: boolean } = {},
  options?: { passingReviewer?: boolean },
): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: options?.passingReviewer ? [{ source: "external", id: "passing" }] : [], ...review },
    externalAgents: {
      "landed-review-fake": {
        adapter: "run-as-binary" as const,
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] }
      },
      ...(options?.passingReviewer ? {
        "passing": {
          adapter: "generic-cli",
          command: process.execPath,
          args: [],
          review: {
            args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})),100))"],
            timeoutMs: 5000,
          }
        }
      } : {}),
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: "landed-review-fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
}

/** Opens a review window with an active exchange baseline over the parent root
 *  before any landing happens, mirroring the ordinary idle-review setup. */
async function armParentReviewWindow(
  root: string,
  config: ReviewGateConfig,
): Promise<{ state: ReviewGateState; baseline: WorkspaceSnapshot }> {
  const state = createState();
  rememberUserRequest(state, "run subtasks while I keep editing the parent workspace");
  beginAgentRun(state);
  const baseline = await createWorkspaceSnapshot(root, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
  });
  setReviewWindowBaseline(state, baseline);
  return { state, baseline };
}

function changedPaths(baseline: WorkspaceSnapshot, current: WorkspaceSnapshot): string[] {
  return compareSnapshots(baseline, current).map((change) => change.path).sort();
}

/** The review window's live diff evidence: current workspace versus the
 *  window's current (active-exchange) baseline — i.e., exactly what the next
 *  ordinary model-idle review would see. */
async function windowDiffPaths(
  state: ReviewGateState,
  root: string,
  config: ReviewGateConfig,
): Promise<string[]> {
  const windowBaseline = activeExchangeBaseline(state);
  assert.ok(windowBaseline, "the review window must keep an active-exchange baseline");
  const current = await createWorkspaceSnapshot(root, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    reuseUnchangedFrom: windowBaseline,
  });
  return changedPaths(windowBaseline, current);
}

interface Harness {
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  taskId: string;
  state: ReviewGateState;
  baseline: WorkspaceSnapshot;
  config: ReviewGateConfig;
  cleanup: () => Promise<void>;
}

async function startLandingHarness(
  unique: string,
  options: {
    review: { primaryEnabled?: boolean; reviewLandedChanges?: boolean };
    actions: Array<{ sentinel: string; file: string; targetShared?: string; targetSharedContent?: string; worktreeShared?: string }>;
    configOptions?: { passingReviewer?: boolean; masterEnabled?: boolean };
  },
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-landed-${unique}-`));
  const script = await writeLandingExecutorScript(root, options.actions);
  const config = executionConfig(script, options.review, options.configOptions);
  config.enabled = options.configOptions?.masterEnabled ?? config.enabled;
  const { state, baseline } = await armParentReviewWindow(root, config);
  // A parent-authored edit after the baseline: it must stay in the window's
  // diff beside any landed evidence in every policy combination.
  await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");
  const controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
  const started = await controller.start([task("landed-work", options.actions[0]!.sentinel)]);
  const taskId = started.tasks[0]!.taskId;
  return {
    root,
    controller,
    started,
    taskId,
    state,
    baseline,
    config,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("unreviewed landed diffs stay in the primary review window across ordinary and continued landings while the policy is on", async () => {
  // No subtask reviewers are selected, so the subtask completes unreviewed:
  // its landed work has no successful subtask review behind it and remains
  // primary-window evidence for the next ordinary model-idle review.
  const harness = await startLandingHarness("ordinary-continue-on", {
    review: { reviewLandedChanges: true },
    actions: [
      { sentinel: "LANDED_FIRST", file: "first.txt" },
      { sentinel: "LANDED_CONTINUE", file: "continued.txt" },
    ],
  });
  const { root, controller, started, taskId, state, baseline, config, cleanup } = harness;
  try {
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    // No immediate review fires at landing: the task simply lands, records no
    // review activity, and the parent's own edit remains beside the landed
    // diff inside the ordinary review-window baseline.
    const landedTask = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.ok((landedTask.activity ?? []).every((event) => !/review/i.test(event.phase)), "landing must not trigger a review phase");
    assert.equal(activeExchangeBaseline(state), baseline, "the review-window baseline must be untouched while the unreviewed diff stays in the window");
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["first.txt", "parent.txt"],
      "the unreviewed landed diff must remain in the review window beside the parent's own edit",
    );

    // Continued landing: the settled task's follow-up work also stays in the
    // same ordinary window evidence.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await controller.continueTask({
          executionId: started.executionId,
          taskId,
          instructions: "LANDED_CONTINUE",
          instructionId: "continue-landed",
          actor: "user",
        });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/already active/.test(error.message) || Date.now() > deadline) throw error;
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["continued.txt", "first.txt", "parent.txt"],
      "continued unreviewed landing diffs must accumulate in the same review window",
    );
    await controller.shutdown();
  } finally {
    await cleanup();
  }
});

test("an ordinarily reviewed accepted landing is not double-reviewed: existing checkpoint behavior holds even while the policy is on", async () => {
  // A passing subtask reviewer makes this an ordinarily reviewed accepted
  // landing; the landed option stays on but must not re-review reviewed work.
  const harness = await startLandingHarness("reviewed-on", {
    review: { reviewLandedChanges: true },
    actions: [{ sentinel: "LANDED_REVIEWED", file: "reviewed.txt" }],
    configOptions: { passingReviewer: true },
  });
  const { root, controller, started, taskId, state, config, cleanup } = harness;
  try {
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    const landedTask = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.ok(
      (landedTask.reviewStatus?.reviewers ?? []).includes("passing"),
      "the subtask review must have run and passed for this scenario",
    );
    assert.equal(
      (landedTask.activity ?? []).filter((event) => /could not be established/.test(event.message)).length,
      0,
      "a reviewed accepted landing must not report uncertain review status",
    );
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["parent.txt"],
      "a landing with a successful subtask review keeps the existing selective checkpoint instead of re-entering the primary window",
    );
    await controller.shutdown();
  } finally {
    await cleanup();
  }
});

test("policy off preserves the existing selective checkpoint of unreviewed landed diffs for manual review", async () => {
  const harness = await startLandingHarness("ordinary-off", {
    review: {},
    actions: [{ sentinel: "LANDED_FIRST", file: "first.txt" }],
  });
  const { root, controller, started, taskId, state, config, cleanup } = harness;
  try {
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["parent.txt"],
      "with the option off the landed diff is still checkpointed away; only parent edits remain",
    );
    await controller.shutdown();
  } finally {
    await cleanup();
  }
});

test("landed option on but primary review off keeps the exact existing checkpoint behavior", async () => {
  const harness = await startLandingHarness("primary-off", {
    review: { primaryEnabled: false, reviewLandedChanges: true },
    actions: [{ sentinel: "LANDED_FIRST", file: "first.txt" }],
  });
  const { root, controller, started, taskId, state, config, cleanup } = harness;
  try {
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["parent.txt"],
      "the landed option is inactive while primary review is off; the landed diff is checkpointed away",
    );
    await controller.shutdown();
  } finally {
    await cleanup();
  }
});

test("the master review switch keeps landed-change inclusion inactive", async () => {
  const harness = await startLandingHarness("master-off", {
    review: { primaryEnabled: true, reviewLandedChanges: true },
    configOptions: { masterEnabled: false },
    actions: [{ sentinel: "LANDED_FIRST", file: "first.txt" }],
  });
  const { root, controller, started, taskId, state, config, cleanup } = harness;
  try {
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    assert.deepEqual(await windowDiffPaths(state, root, config), ["parent.txt"]);
    await controller.shutdown();
  } finally {
    await cleanup();
  }
});

test("force-merge salvage lands into the review window while the policy is on and never asserts review success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-landed-force-merge-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "landed-merge-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','salvage me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [], reviewLandedChanges: true },
      externalAgents: {
        "salvage-fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
        maxWorkers: 1,
        workerResources: { "default": { selection: { source: "external", id: "salvage-fake" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    const { state, baseline } = await armParentReviewWindow(root, config);
    await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");
    controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
    const active = controller;
    const started = await active.start([task("salvage work", "write draft.txt")]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => active.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    await waitForAsync(async () => {
      const waveRoot = active.inspect(started.executionId, taskId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return readFile(join(waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
    });
    const interrupted = await active.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-landed",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"));

    const landed = await active.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-landed",
      actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    // Existing manual-inspection warning for forced salvage stays intact; no
    // PASS or review success is asserted anywhere.
    assert.match(landed.tasks[0]?.summary ?? "", /manual workspace inspection is still required/i);
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "salvage me\n");
    // Fail-closed review-status handling: the interrupted task's outcome does
    // not establish a subtask review, so the uncertainty is reported instead
    // of being guessed, and the diff stays in the review window.
    assert.ok(
      (landed.tasks[0]?.activity ?? []).some((event) => /subtask-review status that could not be established/.test(event.message)),
      "an unestablishable force-merge outcome must report its uncertain review status while keeping the diff in the window",
    );
    assert.equal(activeExchangeBaseline(state), baseline, "the review-window baseline must stay untouched by the unreviewed force-merge");
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["draft.txt", "parent.txt"],
      "the force-merged unreviewed landed diff must remain in the review window",
    );
    await active.shutdown();
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit salvage force-merge keeps the by-construction-unreviewed diff in the window without an uncertainty report", async () => {
  // The salvage branch of the #175 review-status helper: a force-merge whose
  // source resolves to identified retained work (no verified checkpoint)
  // carries no review success by construction, so the landed diff stays in
  // the primary review window and no uncertainty is reported — unreviewed is
  // established, not guessed.
  const root = await mkdtemp(join(tmpdir(), "pi-review-landed-salvage-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "salvage-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','salvage me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [], reviewLandedChanges: true },
      externalAgents: {
        "salvage-fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
        maxWorkers: 1,
        workerResources: { "default": { selection: { source: "external", id: "salvage-fake" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    const { state, baseline } = await armParentReviewWindow(root, config);
    await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");
    controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
    const active = controller;
    const started = await active.start([task("salvage work", "write draft.txt")]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => active.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    await waitForAsync(async () => {
      const waveRoot = active.inspect(started.executionId, taskId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return readFile(join(waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
    });
    const interrupted = await active.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-salvage",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"));

    // Strip the verified checkpoint from the durable operation record so the
    // explicit force-merge resolves to salvage from the retained worktree
    // instead of the verified-checkpoint path.
    const waveRoot = active.inspect(started.executionId, taskId).tasks[0]!.waveRoot!;
    const record = await readOperationRecord(join(waveRoot, "artifacts", taskId, "operation.json"));
    assert.ok(record.checkpoint, "the interrupted task durably checkpointed its work before tampering");
    record.checkpoint = undefined;
    await writeOperationRecord(record);
    const inspection = await inspectOperation(active.inspect(started.executionId, taskId).tasks[0]!.bundle!);
    assert.notEqual(inspection.checkpointVerification.status, "verified", "the tampered record must no longer verify");

    const landed = await active.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-salvage",
      actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    // Salvage provenance is recorded and the manual-inspection warning stays
    // intact; no PASS or review success is asserted anywhere.
    const command = landed.tasks[0]?.commands.find((candidate) => candidate.instructionId === "force-salvage");
    assert.ok(command?.salvage, "the salvage force-merge must record durable salvage provenance");
    assert.match(landed.tasks[0]?.summary ?? "", /manual inspection is required/i);
    assert.match(landed.tasks[0]?.summary ?? "", /salvage/i);
    // By-construction unreviewed: the diff stays in the window and NO
    // uncertainty report fires (the outcome establishes unreviewed status).
    assert.equal(
      (landed.tasks[0]?.activity ?? []).filter((event) => /could not be established/.test(event.message)).length,
      0,
      "salvage must establish unreviewed status by construction instead of reporting uncertainty",
    );
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "salvage me\n");
    assert.equal(activeExchangeBaseline(state), baseline, "the review-window baseline must stay untouched by the unreviewed salvage");
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["draft.txt", "parent.txt"],
      "the salvaged unreviewed landed diff must remain in the review window",
    );
    await active.shutdown();
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("materialized conflicts stay out of resolved-work review, and the cleared landing diff stays in the window while the policy is on", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-landed-conflict-"));
  await initGitRepo(root, { "shared.txt": "base\n" });
  // The executor mutates the parent's own shared.txt mid-turn so the landing
  // plan conflicts against the earlier capture and materializes markers in the
  // parent workspace; its other file lands cleanly. The subtask completes
  // unreviewed (no subtask reviewers are selected).
  const script = await writeLandingExecutorScript(root, [
    {
      sentinel: "LANDED_CONFLICT",
      file: "applied.txt",
      worktreeShared: "worker a\n",
      targetShared: join(root, "shared.txt"),
      targetSharedContent: "user a\n",
    },
  ]);
  const config = executionConfig(script, { reviewLandedChanges: true });
  const { state, baseline } = await armParentReviewWindow(root, config);
  await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");
  const controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
  try {
    const started = await controller.start([task("conflict work", "LANDED_CONFLICT")]);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks[0]?.state === "conflicted",
      "the landing to materialize conflicts in the parent workspace",
    );
    // Conflict safety: while markers are unresolved the task blocks review
    // readiness (policy on), and no resolved-work diff is invented for the
    // marker path.
    const readiness = controller.reviewReadiness();
    assert.ok(
      readiness.some((entry) => entry.executionId === started.executionId && entry.taskId === started.tasks[0]!.taskId && entry.state === "conflicted"),
      "an unresolved same-workspace conflict must block review readiness while the policy is on",
    );
    assert.match(await readFile(join(root, "shared.txt"), "utf8"), /^<<<<<<< /m);
    const gate = controller.inspect(started.executionId).conflictGate;
    assert.ok(gate, "the conflict gate must be inspectable while unresolved");
    assert.deepEqual([...gate!.paths], ["shared.txt"]);

    // Resolve the conflict and clear it through the existing gate API; the
    // final resolved landed diff remains in the ordinary window evidence at
    // the next model-idle review.
    await writeFile(join(root, "shared.txt"), "resolved\n", "utf8");
    const outcome = await controller.markClean();
    assert.ok(outcome.cleared, "markClean must clear the resolved conflict");
    assert.ok(outcome.paths.includes("shared.txt"));
    const landedTask = controller.inspect(started.executionId).tasks[0]!;
    assert.equal(landedTask.state, "landed");
    assert.equal(controller.reviewReadiness().length, 0, "cleared conflicts must unblock review readiness");
    assert.equal(activeExchangeBaseline(state), baseline, "the review-window baseline must stay untouched while the unreviewed conflict evidence stays in the window");
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["applied.txt", "parent.txt", "shared.txt"],
      "the post-resolution landed diff must remain in the review window beside the parent's own edit",
    );
    await controller.shutdown();
  } finally {
    await controller.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed conflict applications are not double-reviewed, while the unreviewed resolution stays in the window", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-landed-conflict-reviewed-"));
  await initGitRepo(root, { "shared.txt": "base\n" });
  const script = await writeLandingExecutorScript(root, [
    {
      sentinel: "LANDED_CONFLICT",
      file: "applied.txt",
      worktreeShared: "worker a\n",
      targetShared: join(root, "shared.txt"),
      targetSharedContent: "user a\n",
    },
  ]);
  // A passing subtask reviewer makes the candidate ordinarily reviewed: its
  // clean applied paths must not re-enter the primary window, while the human
  // conflict resolution is unreviewed and stays there after markClean.
  const config = executionConfig(script, { reviewLandedChanges: true }, { passingReviewer: true });
  const { state, baseline } = await armParentReviewWindow(root, config);
  await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");
  const controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
  try {
    const started = await controller.start([task("conflict work", "LANDED_CONFLICT")]);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks[0]?.state === "conflicted",
      "the landing to materialize conflicts in the parent workspace",
    );
    const readiness = controller.reviewReadiness();
    assert.ok(
      readiness.some((entry) => entry.executionId === started.executionId && entry.state === "conflicted"),
      "the unresolved conflict must still block review readiness",
    );
    await writeFile(join(root, "shared.txt"), "resolved\n", "utf8");
    const outcome = await controller.markClean();
    assert.ok(outcome.cleared, "markClean must clear the resolved conflict");
    assert.equal(controller.inspect(started.executionId).tasks[0]?.state, "landed");
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["parent.txt", "shared.txt"],
      "the reviewed applied path is checkpointed away (no double-review) while the unreviewed resolution stays in the window",
    );
    await controller.shutdown();
  } finally {
    await controller.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("policy off preserves the existing post-SubtasksMarkClean selective checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-landed-conflict-off-"));
  await initGitRepo(root, { "shared.txt": "base\n" });
  const script = await writeLandingExecutorScript(root, [
    {
      sentinel: "LANDED_CONFLICT",
      file: "applied.txt",
      worktreeShared: "worker a\n",
      targetShared: join(root, "shared.txt"),
      targetSharedContent: "user a\n",
    },
  ]);
  const config = executionConfig(script, {});
  const { state, baseline } = await armParentReviewWindow(root, config);
  await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");
  const controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
  try {
    const started = await controller.start([task("conflict work", "LANDED_CONFLICT")]);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks[0]?.state === "conflicted",
      "the landing to materialize conflicts in the parent workspace",
    );
    // Policy off keeps the prior readiness behavior: conflicted tasks are not
    // readiness blockers.
    assert.equal(
      controller.reviewReadiness().some((entry) => entry.state === "conflicted"),
      false,
      "with the policy off a conflicted task must not become a new readiness blocker",
    );
    await writeFile(join(root, "shared.txt"), "resolved\n", "utf8");
    const outcome = await controller.markClean();
    assert.ok(outcome.cleared, "markClean must clear the resolved conflict");
    assert.equal(controller.inspect(started.executionId).tasks[0]?.state, "landed");
    assert.deepEqual(
      await windowDiffPaths(state, root, config),
      ["parent.txt"],
      "with the option off the resolved conflict path is still selectively checkpointed away",
    );
    await controller.shutdown();
  } finally {
    await controller.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit foreign-target landing never enters the parent review window even while the policy is on", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-review-landed-parent-")));
  const targetA = await realpath(await mkdtemp(join(tmpdir(), "pi-review-landed-foreign-")));
  await initGitRepo(parent);
  await initGitRepo(targetA);
  const script = await writeLandingExecutorScript(parent, [
    { sentinel: "LANDED_FOREIGN", file: "foreign-landed.txt" },
  ]);
  const config = executionConfig(script, { reviewLandedChanges: true });
  const { state, baseline } = await armParentReviewWindow(parent, config);
  const controller = new BackgroundExecutionController({ config, state, cwd: () => parent, pi: {} });
  const owned = [parent, targetA];
  try {
    const started = await controller.start([task("foreign work", "LANDED_FOREIGN")], "execute", targetA);
    owned.push(started.root);
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed", 30_000);
    assert.ok(
      await readFile(join(targetA, "foreign-landed.txt"), "utf8").then(() => true, () => false),
      "the landing must land in the foreign target",
    );
    // The identity guard still keeps the foreign target's files out of the
    // parent baseline: the baseline is untouched and the parent window shows
    // no foreign entries.
    assert.deepEqual(
      [...baseline.files.keys()].sort(),
      [...(await createWorkspaceSnapshot(parent, {
        maxFileBytes: config.maxFileBytes,
        maxSnapshotBytes: config.maxSnapshotBytes,
      })).files.keys()].sort(),
      "the parent baseline must not gain foreign target entries",
    );
    const parentCurrent = await createWorkspaceSnapshot(parent, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
      reuseUnchangedFrom: baseline,
    });
    assert.deepEqual(changedPaths(baseline, parentCurrent), [], "a foreign landing must not contaminate the parent review window");
    await controller.shutdown();
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    for (const root of owned) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});