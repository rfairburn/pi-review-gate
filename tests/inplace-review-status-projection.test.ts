/**
 * Issue #314: an in-place task's reviewing progress reaches the same reviewer
 * status and the same subtask-widget row presentation as an execute task's.
 *
 * The shared widget renders one row per active task as
 * `kind · title [state] · executor · reviewers <labels> (<phase>)`, where the
 * reviewer segment is projected from the task's durable review status. The
 * wave (execute) progress pipeline produced that projection; the in-place
 * pipeline never did, so an in-place reviewing row labeled only its executor.
 * These regressions drive the actual production seam — worker progress →
 * lifecycle progress handler → durable task record → subtask-indicator
 * snapshot → rendered widget line — for the in-place kind, compare it against
 * the execute kind on the real controller, and pin what must stay unchanged:
 * a running row's executor-only presentation, the immutable executor
 * invocation identity, and the existing multiple/unknown/empty/missing
 * reviewer handling. Presentation only: no lifecycle, routing, outcome, or
 * model-selection behavior is asserted beyond the rendered row.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, resolveReviewers, type ReviewGateConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import type { BackgroundExecutionGroup } from "../src/execution/background-group-store";
import { inPlaceProgress, type InPlaceLifecycleDeps } from "../src/execution/inplace-task-lifecycle";
import { researchProgress, type ResearchLifecycleDeps } from "../src/execution/research-task-lifecycle";
import {
  isActiveTaskState,
  newTask,
  type BackgroundTaskDefinition,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
} from "../src/execution/task-state";
import { SubtaskIndicator } from "../src/execution/subtask-indicator";
import { reviewerProgressLabel } from "../src/execution/wave-worker-lifecycle";
import { createState } from "../src/state";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";

// ── fast seam: real progress handler → real indicator → rendered line ───────

/** Reviewer labels exactly as a worker emits them (same production labeler). */
function emittedReviewerLabels(config: ReviewGateConfig): string[] {
  return resolveReviewers(config).reviewers.map(reviewerProgressLabel);
}

const projectionConfig = normalizeConfig({
  enabled: true,
  review: { activeReviewers: [{ source: "external", id: "reviewer-a" }] },
  externalAgents: {
    "inplace-fake": {
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const },
    },
    "reviewer-a": {
      adapter: "generic-cli",
      command: process.execPath,
      args: [],
      review: { args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})))"], timeoutMs: 5000 },
    },
  },
  execution: {
    workerResources: { default: { selection: { source: "external" as const, id: "inplace-fake" }, maxConcurrent: 1 } },
    routes: { execute: [{ resourceId: "default" }], research: [] },
  },
});

function syntheticTask(): BackgroundTaskRecord {
  return newTask({
    title: "in-place review row",
    instructions: "write the marker file",
    acceptanceCriteria: ["marker written"],
  });
}

function syntheticGroup(kind: BackgroundTaskKind, task: BackgroundTaskRecord): BackgroundExecutionGroup {
  const now = new Date().toISOString();
  return {
    version: 3,
    revision: 0,
    integritySha256: "0".repeat(64),
    executionId: `exec-${kind}-synthetic`,
    kind,
    root: "/synthetic/execution-root",
    cwd: "/synthetic/workspace",
    createdAt: now,
    updatedAt: now,
    tasks: [task],
  };
}

/**
 * One live task wired through the real subtask indicator: every render pushes
 * the frame the widget would show.
 */
function indicatorCapture(group: BackgroundExecutionGroup, task: BackgroundTaskRecord, config: ReviewGateConfig) {
  const frames: string[][] = [];
  const indicator = new SubtaskIndicator({
    config: () => config,
    activeTaskEntries: () => [{ group, task }],
    isRuntimeActive: () => false,
    conflictGatePaths: () => undefined,
    recentActivity: () => [],
  }, true);
  indicator.setContext({ ui: { setWidget: (_name: string, content: unknown) => {
    if (typeof content === "function") frames.push((content as () => { render(width: number): string[] })().render(400));
    else frames.push((content as string[] | undefined) ?? []);
  } } });
  return { frames, render: () => indicator.render() };
}

/** Narrow synthetic lifecycle capabilities; no controller authority is used. */
function syntheticDeps(render: () => void, config: ReviewGateConfig): InPlaceLifecycleDeps & ResearchLifecycleDeps {
  return {
    persistence: {
      save: async () => ({ revision: 1, updatedAt: new Date().toISOString(), peakConcurrency: 1, integritySha256: "0".repeat(64) }),
      publishAssociations: async () => undefined,
    },
    notify: () => undefined,
    wake: { wake: async () => undefined },
    activity: { add: () => undefined },
    dispatch: { record: () => undefined },
    indicator: { update: render },
    config: { base: () => config, forGroup: () => config, scopedModels: () => [] },
    executor: { acquireAfterRoute: async () => undefined, routeOf: () => [] },
    steering: {
      prestart: async () => undefined,
      continuation: async (_group, _task, instructions) => instructions,
      claimDeferred: async () => [],
      failUndelivered: () => [],
      acknowledgeInterrupt: async () => undefined,
      flushQueued: async () => undefined,
    },
    live: { runtime: () => undefined },
    artifactDir: () => "/synthetic/artifacts",
  };
}

/** The whole seam: live record, real indicator frames, real progress handler. */
function inPlaceSeam(kind: BackgroundTaskKind = "inplace", config = projectionConfig) {
  const task = syntheticTask();
  const group = syntheticGroup(kind, task);
  const { frames, render } = indicatorCapture(group, task, config);
  const deps = syntheticDeps(render, config);
  return {
    task,
    group,
    deps,
    frames,
    line: () => frames.at(-1)!.find((row) => row.startsWith(`  ${kind} · `)) ?? "",
  };
}

test("in-place reviewing progress projects the emitted reviewer labels into the live row", () => {
  const { task, group, deps, line } = inPlaceSeam();
  const labels = emittedReviewerLabels(projectionConfig);
  assert.deepEqual(labels, ["reviewer-a"]);

  // Running first: the row is executor-only, with no reviewer segment at all.
  inPlaceProgress(group, task, { phase: "executing", message: "executor turn 1" }, deps);
  const statusWhileRunning = task.reviewStatus;
  assert.equal(statusWhileRunning, undefined, "a non-review phase must not create review status");
  assert.equal(task.state, "running");
  const runningLine = line();
  assert.match(runningLine, /^  inplace · in-place review row \[running\] · \S/);
  assert.ok(!runningLine.includes("reviewers"), runningLine);

  // Reviewing: the labels the in-place coordinator emits for its frozen
  // reviewer set reach the durable review status and the rendered row.
  inPlaceProgress(group, task, {
    phase: "reviewing",
    message: "review cycle 1 over the recorded workspace delta",
    reviewCycle: 1,
    reviewers: labels,
  }, deps);
  assert.equal(task.state, "reviewing");
  assert.deepEqual(task.reviewStatus?.reviewers, ["reviewer-a"]);
  assert.equal(task.reviewStatus?.phase, "reviewing");
  assert.ok(task.reviewStatus?.activity.includes("review cycle 1 over the recorded workspace delta"));
  const reviewingLine = line();
  assert.match(reviewingLine, /^  inplace · in-place review row \[reviewing\] · \S/);
  assert.ok(reviewingLine.endsWith(" · reviewers reviewer-a (reviewing)"), reviewingLine);

  // The row's executor identity segment is untouched by the review projection.
  assert.equal(reviewingLine.split(" · ")[2], runningLine.split(" · ")[2]);
});

test("in-place review status keeps the shared phase and reviewer semantics", () => {
  const { task, group, deps, line } = inPlaceSeam();
  inPlaceProgress(group, task, { phase: "reviewing", message: "review cycle 1", reviewers: ["reviewer-a"] }, deps);

  // A correction phase keeps the reviewers and moves the phase (as the wave
  // pipeline does), so the row keeps exposing the reviewing model.
  inPlaceProgress(group, task, { phase: "correcting", message: "correcting findings", reviewers: ["reviewer-a"] }, deps);
  assert.equal(task.reviewStatus?.phase, "correcting");
  assert.deepEqual(task.reviewStatus?.reviewers, ["reviewer-a"]);
  assert.ok(line().endsWith(" · reviewers reviewer-a (correcting)"), line());

  // A later non-review phase never replaces an established review phase and
  // never drops the reviewer segment.
  inPlaceProgress(group, task, { phase: "executing", message: "executor turn 2" }, deps);
  assert.equal(task.reviewStatus?.phase, "correcting");
  assert.ok(line().endsWith(" · reviewers reviewer-a (correcting)"), line());
});

test("in-place rows keep the existing multiple, empty, and missing reviewer presentation", () => {
  // Multiple reviewers render as one comma-joined label list.
  const multiple = inPlaceSeam();
  inPlaceProgress(multiple.group, multiple.task, { phase: "reviewing", message: "review cycle 1", reviewers: ["reviewer-a", "reviewer-b"] }, multiple.deps);
  assert.deepEqual(multiple.task.reviewStatus?.reviewers, ["reviewer-a", "reviewer-b"]);
  assert.ok(multiple.line().endsWith(" · reviewers reviewer-a, reviewer-b (reviewing)"), multiple.line());

  // An explicitly empty reviewer set renders the honest "none" label.
  const empty = inPlaceSeam();
  inPlaceProgress(empty.group, empty.task, { phase: "reviewing", message: "review cycle 1", reviewers: [] }, empty.deps);
  assert.deepEqual(empty.task.reviewStatus?.reviewers, []);
  assert.ok(empty.line().endsWith(" · reviewers none (reviewing)"), empty.line());

  // A reviewing update that carries no labels at all still projects the phase
  // and renders "none" — nothing is guessed from current configuration.
  const unlabelled = inPlaceSeam();
  inPlaceProgress(unlabelled.group, unlabelled.task, { phase: "reviewing", message: "review cycle 1" }, unlabelled.deps);
  assert.deepEqual(unlabelled.task.reviewStatus?.reviewers, []);
  assert.ok(unlabelled.line().endsWith(" · reviewers none (reviewing)"), unlabelled.line());

  // Missing review state stays missing: neither a plain running phase nor a
  // confirmation without any prior review status creates a reviewer segment.
  const missing = inPlaceSeam();
  inPlaceProgress(missing.group, missing.task, { phase: "executing", message: "executor turn 1" }, missing.deps);
  inPlaceProgress(missing.group, missing.task, { phase: "confirming", message: "confirming the earlier pass" }, missing.deps);
  inPlaceProgress(missing.group, missing.task, { phase: "completing", message: "settling" }, missing.deps);
  const statusWithoutReview = missing.task.reviewStatus;
  assert.equal(statusWithoutReview, undefined);
  assert.ok(!missing.line().includes("reviewers"), missing.line());
});

test("an in-place reviewer segment never relabels the immutable executor identity under stale configuration", () => {
  const task = syntheticTask();
  // Identity as reported by the invocation that actually served the task.
  task.executorEntryId = "external-inplace-fake";
  task.executorSelection = { source: "external", id: "inplace-fake" };
  task.executorModel = "served-model-1";
  const group = syntheticGroup("inplace", task);
  // The same live task rendered against a LATER configuration: the catalog
  // entry gained a model that never served this invocation, and the active
  // reviewer set changed to a reviewer that never reviewed it.
  const staleConfig = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [{ source: "external", id: "reviewer-changed-later" }] },
    externalAgents: {
      "inplace-fake": {
        adapter: "run-as-binary",
        command: process.execPath,
        model: "never-served-9",
        execution: { protocol: "pi-review-executor-jsonl-v1" as const },
      },
      "reviewer-changed-later": {
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
        review: { args: ["-e", "process.stdout.write('{}')"], timeoutMs: 1000 },
      },
    },
    execution: {
      workerResources: { default: { selection: { source: "external" as const, id: "inplace-fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  const { frames, render } = indicatorCapture(group, task, staleConfig);
  const deps = syntheticDeps(render, staleConfig);
  const line = () => frames.at(-1)!.find((row) => row.startsWith("  inplace · ")) ?? "";

  inPlaceProgress(group, task, { phase: "reviewing", message: "review cycle 1", reviewers: ["reviewer-a"] }, deps);
  const rendered = line();
  assert.ok(rendered.includes("· served-model-1"), rendered);
  assert.ok(!rendered.includes("never-served-9"), rendered);
  // Reviewer labels are what the worker emitted, never a re-resolution of the
  // current reviewer configuration.
  assert.ok(rendered.endsWith(" · reviewers reviewer-a (reviewing)"), rendered);
  assert.ok(!rendered.includes("reviewer-changed-later"), rendered);
});

test("an in-place row with no executor identity yet still exposes its reviewers", () => {
  const { task, group, deps, line } = inPlaceSeam();
  inPlaceProgress(group, task, { phase: "reviewing", message: "review cycle 1", reviewers: ["reviewer-a"] }, deps);
  const rendered = line();
  assert.ok(rendered.startsWith("  inplace · in-place review row [reviewing] · executor pending"), rendered);
  assert.ok(rendered.endsWith(" · reviewers reviewer-a (reviewing)"), rendered);
});

test("an in-place row exposes the reviewer model labels the worker actually emits", () => {
  // The labels are produced by the same production labeler the workers use,
  // so a model-backed reviewer surfaces its MODEL (not just a catalog id):
  // a pi-model reviewer renders model plus thinking level, and a codex-cli
  // reviewer with a configured model renders that model.
  const modelConfig = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [{ source: "pi", model: "gpt-5-mini", thinkingLevel: "low" }, { source: "external", id: "codex-reviewer" }] },
    externalAgents: {
      "codex-reviewer": { adapter: "codex-cli", args: [], model: "reviewer-model-7", review: {} },
    },
  });
  const labels = emittedReviewerLabels(modelConfig);
  assert.deepEqual(labels, ["gpt-5-mini (low)", "reviewer-model-7"]);

  const { task, group, deps, line } = inPlaceSeam("inplace", modelConfig);
  inPlaceProgress(group, task, { phase: "reviewing", message: "review cycle 1", reviewers: labels }, deps);
  assert.deepEqual(task.reviewStatus?.reviewers, ["gpt-5-mini (low)", "reviewer-model-7"]);
  assert.ok(line().endsWith(" · reviewers gpt-5-mini (low), reviewer-model-7 (reviewing)"), line());
});

test("an empty reviewer update after a labelled one keeps the established reviewers and raw labels render verbatim", () => {
  const { task, group, deps, line } = inPlaceSeam();
  inPlaceProgress(group, task, { phase: "reviewing", message: "review cycle 1", reviewers: ["reviewer-a"] }, deps);

  // A later review-phase update that carries no labels never clears what the
  // worker already emitted (same shared rule the wave pipeline follows).
  inPlaceProgress(group, task, { phase: "reviewing", message: "reviewer 1 responded", reviewers: [] }, deps);
  assert.deepEqual(task.reviewStatus?.reviewers, ["reviewer-a"]);
  assert.ok(line().endsWith(" · reviewers reviewer-a (reviewing)"), line());
  inPlaceProgress(group, task, { phase: "confirming", message: "confirming the pass" }, deps);
  assert.deepEqual(task.reviewStatus?.reviewers, ["reviewer-a"]);
  assert.ok(line().endsWith(" · reviewers reviewer-a (confirming)"), line());

  // A worker-emitted label is rendered verbatim, including an unknown one:
  // nothing is guessed, replaced, or dropped.
  const raw = inPlaceSeam();
  inPlaceProgress(raw.group, raw.task, { phase: "reviewing", message: "review cycle 1", reviewers: ["unknown"] }, raw.deps);
  assert.deepEqual(raw.task.reviewStatus?.reviewers, ["unknown"]);
  assert.ok(raw.line().endsWith(" · reviewers unknown (reviewing)"), raw.line());
});

test("research progress semantics are unchanged while the shared row stays kind-agnostic", () => {
  // #314 changed only the in-place pipeline. Research keeps its existing
  // behavior at the same narrow seam: its progress updates never created a
  // review status (its workers emit no reviewer labels), and no model
  // selection or routing was touched.
  const task = syntheticTask();
  const group = syntheticGroup("research", task);
  const { frames, render } = indicatorCapture(group, task, projectionConfig);
  const deps = syntheticDeps(render, projectionConfig);
  researchProgress(group, task, { phase: "executing", message: "reading sources" }, deps);
  researchProgress(group, task, { phase: "correcting", message: "re-checking sources", reviewers: ["reviewer-a"] }, deps);
  assert.equal(task.state, "running");
  const researchStatus = task.reviewStatus;
  assert.equal(researchStatus, undefined, "research progress must keep not projecting review status");

  // The row itself is shared presentation: once a review status exists, every
  // kind renders the identical reviewer segment after its own kind token.
  task.reviewStatus = { phase: "reviewing", reviewers: ["gpt-5-mini (low)"], activity: [], updatedAt: new Date().toISOString() };
  render();
  const inplace = inPlaceSeam();
  inPlaceProgress(inplace.group, inplace.task, { phase: "reviewing", message: "review cycle 1", reviewers: ["gpt-5-mini (low)"] }, inplace.deps);
  const researchRow = frames.at(-1)!.find((row) => row.startsWith("  research · ")) ?? "";
  assert.ok(researchRow.endsWith(" · reviewers gpt-5-mini (low) (reviewing)"), researchRow);
  // Identical reviewer segment for both kinds (task state differs only because
  // research progress keeps its own existing state mapping).
  const reviewerSegment = (row: string) => row.slice(row.indexOf(" · reviewers "));
  assert.equal(reviewerSegment(researchRow), reviewerSegment(inplace.line()));
});

// ── production path: both kinds on the real controller ──────────────────────

/** Reviewer that answers after a short delay so the reviewing row stays live. */
async function writeDelayedReviewerScript(root: string): Promise<string> {
  const script = join(root, "delayed-reviewer.cjs");
  await writeFile(script, [
    "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed',findings:[]})),400);});",
  ].join("\n"), "utf8");
  await chmod(script, 0o755);
  return script;
}

async function widgetRowsFor(prefix: "execute" | "inplace"): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), `pi-review-314-${prefix}-`));
  let instance: BackgroundExecutionController | undefined;
  try {
    const executor = join(scratch, "executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{if(prompt.includes('SENTINEL'))fs.writeFileSync('marker.txt','written\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed the edit'}));});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const reviewer = await writeDelayedReviewerScript(scratch);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [{ source: "external", id: "e2e-reviewer" }] },
      externalAgents: {
        "e2e-exec": {
          adapter: "run-as-binary",
          command: process.execPath,
          model: "e2e-executor-model",
          execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [executor], timeoutMs: 30_000 },
        },
        "e2e-reviewer": {
          adapter: "generic-cli",
          command: process.execPath,
          args: [],
          review: { args: [reviewer], timeoutMs: 20_000 },
        },
      },
      execution: {
        maxWorkers: 1,
        workerResources: { default: { selection: { source: "external" as const, id: "e2e-exec" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });

    let workspace = scratch;
    if (prefix === "execute") await initGitRepo(scratch);
    else {
      workspace = join(scratch, "workspace");
      await mkdir(workspace, { recursive: true });
    }

    const frames: string[][] = [];
    const rows: string[] = [];
    const ctx = { ui: { setWidget: (_name: string, content: unknown) => {
      if (typeof content !== "function") return;
      const rendered = (content as () => { render(width: number): string[] })().render(400);
      frames.push(rendered);
      const row = rendered.find((line) => line.startsWith(`  ${prefix} · 314 row [`));
      if (row) rows.push(row);
    } } };
    instance = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => scratch });
    instance.setUiContext(ctx);
    await instance.toggleExpandedView(ctx);

    const definition = [{ title: "314 row", instructions: "SENTINEL write marker.txt", acceptanceCriteria: ["marker.txt written"] }];
    const started = prefix === "execute"
      ? await instance.start(definition)
      : await instance.start(definition, "inplace", workspace);
    await waitFor(() => instance!.inspect(started.executionId).tasks.every((task) => !isActiveTaskState(task.state)), 60_000);
    return rows;
  } finally {
    await instance?.shutdown();
    await instance?.detach();
    await rm(scratch, { recursive: true, force: true });
  }
}

test("an in-place task and an execute task expose the same reviewer segment on the live row", async () => {
  const inplace = await widgetRowsFor("inplace");
  const execute = await widgetRowsFor("execute");

  const reviewingOf = (rows: string[]) => rows.filter((row) => row.includes("[reviewing] · "));
  const inplaceReviewing = reviewingOf(inplace);
  const executeReviewing = reviewingOf(execute);
  assert.ok(inplaceReviewing.length > 0, `no in-place reviewing widget row was captured: ${JSON.stringify(inplace)}`);
  assert.ok(executeReviewing.length > 0, `no execute reviewing widget row was captured: ${JSON.stringify(execute)}`);

  // Both kinds reach the same reviewer segment through the existing
  // execute/research presentation — no new format, no guessed reviewer.
  for (const line of inplaceReviewing) assert.ok(line.endsWith(" · reviewers e2e-reviewer (reviewing)"), line);
  for (const line of executeReviewing) assert.ok(line.endsWith(" · reviewers e2e-reviewer (reviewing)"), line);

  // The two rows differ only in the kind token: everything after it is the
  // shared presentation.
  const stripKind = (line: string) => line.replace(/^  \w+ · /, "");
  assert.equal(stripKind(inplaceReviewing.at(-1)!), stripKind(executeReviewing.at(-1)!));

  // Before any review activity starts, no row carries a reviewer segment: the
  // running in-place executor presentation is unchanged.
  const beforeReview = (rows: string[]) => rows.slice(0, rows.findIndex((row) => row.includes("[reviewing] · ")));
  for (const rows of [inplace, execute]) {
    const early = beforeReview(rows);
    assert.ok(early.length > 0, `no pre-review widget row was captured: ${JSON.stringify(rows)}`);
    for (const line of early) assert.ok(!line.includes("reviewers"), line);
  }

  // The executor identity segment evolves identically for both kinds (recorded
  // selection, then the model the invocation reports) and the review
  // projection never invents or relabels an executor inside it.
  const executorSegment = (line: string) => line.split(" · ")[2] ?? "";
  const inplaceSegments = [...new Set(inplace.map(executorSegment))];
  const executeSegments = [...new Set(execute.map(executorSegment))];
  assert.deepEqual(inplaceSegments, executeSegments);
  for (const segment of inplaceSegments) {
    assert.ok(segment === "e2e-exec" || segment === "e2e-executor-model", segment);
    assert.ok(!segment.includes("reviewer"), segment);
  }
});
