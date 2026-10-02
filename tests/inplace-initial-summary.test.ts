/** #266: the initial in-place worker's completed final summary is the
 * deliverable, and it must reach the actual reviewer channels through the
 * normal bounded/redacting evidence path (evidence.json, evidence.md, request,
 * and the captured reviewer prompt), including review retries and restored
 * fallback evidence — with review admission, zero-delta skipping, per-task
 * evidence ownership, and fail-closed checkpoint semantics unchanged.
 *
 * Synthetic fixtures only. Every scratch tree, reviewer prompt capture, and
 * evidence artifact lives under a tmpdir() mkdtemp OUTSIDE the source tree.
 * Workers complete with a unique summary marker, no report file, and no
 * in-root edits; review is admitted through the existing external
 * tool-observation path exactly as today. The external observation fixture
 * content is deliberately marker-free: summary markers exist exclusively in
 * the executor's final text, so the reviewer fixture — which may return
 * "pass" only after validating the marker inside the received
 * "Agent final summaries" evidence section — can never be satisfied by tool
 * observations substituting for the deliverable. A checkpoint failure of the
 * summary-bearing durable write is fault-injected and must settle as a
 * disclosed executor_error before any review or successful settlement.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, resolvedExecutorPool, type ReviewGateConfig } from "../src/config";
import { createEvidenceState, rememberFinalAssistantSummaryText } from "../src/evidence";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import { computeInPlaceAttribution, createInPlaceBaseline } from "../src/execution/inplace/basis";
import {
  buildInPlaceReviewRequest,
  runInplaceLifecycle,
  type InPlaceLifecycleResult,
  type InPlaceWorkerResult,
} from "../src/execution/inplace-worker";
import type { ExecutorAdapter } from "../src/execution/types";

const EXTERNAL_CONTENT_TOKEN = "PRG-I266-EXTERNAL-CONTENT-TOKEN";
/** The confirm turn's harmless completion text (recorded like every completed turn). */
const confirmText = "confirmed unchanged";

// ── synthetic fixtures (all paths outside the source workspace) ──────────────

function summaryMarker(label: string): string {
  return `INPLACE-INITIAL-SUMMARY-${label}-${randomUUID().slice(0, 8)}`;
}

interface SummaryRunner {
  /** Ordered per-dispatch summary texts; the last entry repeats for confirmation turns. */
  texts: string[];
  /** Absolute path observed as a tool-observed external write, written on the first dispatch only. */
  externalPath?: string;
}

function markerExecutor(spec: SummaryRunner): ExecutorAdapter {
  let dispatch = 0;
  return {
    kind: "pi-model",
    toolEventObservability: spec.externalPath
      ? { mode: "structured", description: "test structured tool-event stream" }
      : { mode: "unavailable", description: "The test adapter exposes no structured tool events." },
    async run(request) {
      dispatch += 1;
      if (spec.externalPath && dispatch === 1) {
        // Marker-free synthetic content: the tool observation proves the
        // external side effect without ever carrying the summary deliverable
        // (no substitution of tool observations for the final summary).
        await writeFile(spec.externalPath, `${EXTERNAL_CONTENT_TOKEN}: external synthetic observation without summary markers\n`, "utf8");
        request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: spec.externalPath } });
        request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: spec.externalPath }, result: `wrote ${EXTERNAL_CONTENT_TOKEN}` });
      }
      return {
        text: spec.texts[Math.min(dispatch, spec.texts.length) - 1],
        session: { adapter: "pi-model", id: `marker-session-${dispatch}` },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        timedOut: false,
        aborted: false,
      };
    },
  };
}

/**
 * Extract the received "Agent final summaries" evidence section: the only
 * channel that carries the completed final-summary deliverable. Tool
 * observations, external candidates, and event rows live in other sections
 * and can never satisfy this extraction.
 */
function agentSummarySection(prompt: string): string | undefined {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Agent final summaries");
  if (start === -1) return undefined;
  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("### ")) break;
    section.push(lines[index]!);
  }
  return section.join("\n");
}

/**
 * Recording reviewer: captures the received prompt first, then — and only
 * then — may return "pass", and only when the received "Agent final
 * summaries" evidence section contains every required unique marker. Missing
 * markers, or a marker appearing only in tool-observation content, fails
 * closed with an error verdict so a missing deliverable can never be
 * reviewed as passing.
 */
function validatingReviewerScript(promptLog: string, requiredMarkers: string[], options?: {
  stateFile?: string;
  firstInvocationMessage?: string;
}): string {
  return [
    "const fs=require('node:fs');",
    "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    `fs.appendFileSync(${JSON.stringify(promptLog)},JSON.stringify(prompt)+'\\n');`,
    ...(options?.stateFile ? [
      `const count=Number(fs.existsSync(${JSON.stringify(options.stateFile)})?fs.readFileSync(${JSON.stringify(options.stateFile)},'utf8'):'0');`,
      `fs.writeFileSync(${JSON.stringify(options.stateFile)},String(count+1));`,
      `if(count===0){process.stdout.write(JSON.stringify({verdict:'error',summary:${JSON.stringify(options.firstInvocationMessage ?? "transient reviewer infrastructure incident (first invocation)")},error:'reviewer_incident_injected',findings:[]}));return;}`,
    ] : []),
    `const required=${JSON.stringify(requiredMarkers)};`,
    "const lines=prompt.split('\\n');",
    "const start=lines.findIndex(l=>l.trim()==='### Agent final summaries');",
    "let section=null;",
    "if(start!==-1){const body=[];for(let i=start+1;i<lines.length;i++){if(lines[i].startsWith('### '))break;body.push(lines[i]);}section=body.join('\\n');}",
    "const missing=required.filter(m=>!section||!section.includes(m));",
    "if(missing.length===0){process.stdout.write(JSON.stringify({verdict:'pass',summary:'validated the received final-summary deliverable',findings:[]}));}",
    "else{process.stdout.write(JSON.stringify({verdict:'error',summary:'required completed final summary marker(s) were not present in the received Agent final summaries evidence section: '+missing.join(' '),error:'missing_summary_deliverable',findings:[]}));}",
    "});",
  ].join("\n");
}

function summaryScenarioConfig(reviewerScript: string, retryPolicy: {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  maxSameIncidentRepeats: number;
}): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    maxFileBytes: 64 * 1024,
    maxSnapshotBytes: 4 * 1024 * 1024,
    maxPatchBytes: 64 * 1024,
    review: { activeReviewers: [{ source: "external", id: "validating-reviewer" }] },
    externalAgents: {
      "validating-reviewer": {
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
        review: { args: ["-e", reviewerScript], timeoutMs: 10_000 },
      },
      "unused-executor": {
        adapter: "run-as-binary" as const,
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: ["unused-by-lifecycle-adapter-factory"] },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: {
        "default": { selection: { source: "external", id: "unused-executor" }, maxConcurrent: 1 },
      },
      routes: { execute: [{ resourceId: "default" }], research: [] },
      retryPolicy,
    },
    retainBundles: "always",
  });
}

const noRetryPolicy = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 3 };
const oneRetryPolicy = { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 3 };

/** Build one summary-only task fixture: a non-Git workspace with a synthetic
 *  input fixture, plus an external artifact dir; nothing is written in root. */
async function summaryFixture(scratch: string, label: string, spec?: { externalPath?: string }): Promise<{
  workspaceRoot: string;
  artifactDir: string;
  externalPath?: string;
  inputPath: string;
  inputBefore: string;
}> {
  const workspaceRoot = join(scratch, `workspace-${label}`);
  const artifactDir = join(scratch, "artifacts", label);
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await mkdir(join(workspaceRoot, "input"), { recursive: true });
  const inputPath = join(workspaceRoot, "input", "task-brief.txt");
  await writeFile(inputPath, `synthetic input fixture for ${label}; findings must be reported only in the final assistant summary\n`, "utf8");
  return { workspaceRoot, artifactDir, inputPath, inputBefore: await readFile(inputPath, "utf8"), ...(spec?.externalPath ? { externalPath: spec.externalPath } : {}) };
}

function lifecycleDeps(
  config: ReviewGateConfig,
  adapter: ExecutorAdapter,
  fixtures: { workspaceRoot: string; artifactDir: string },
  taskId: string,
): Parameters<typeof runInplaceLifecycle>[0] {
  return {
    taskId,
    task: {
      title: "summary deliverable task",
      instructions: "Read the input fixture and return the findings only in your final assistant summary; write no report file and no workspace edits.",
      acceptanceCriteria: ["findings appear only in the final assistant summary"],
    },
    workspaceRoot: fixtures.workspaceRoot,
    artifactDir: fixtures.artifactDir,
    config,
    executorAssignment: { entry: resolvedExecutorPool(config)[0]!, priority: 0 },
    adapterFactory: () => adapter,
  };
}

async function readCapturedPrompts(promptLog: string): Promise<string[]> {
  if (!existsSync(promptLog)) return [];
  return (await readFile(promptLog, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
}

interface EvidenceSnapshotFile {
  finalAssistantSummaries: string[];
  events: unknown[];
  candidates: Array<{ externalSideEffect?: boolean }>;
}

async function readObservedEvidence(artifactDir: string): Promise<EvidenceSnapshotFile> {
  return JSON.parse(await readFile(join(artifactDir, "observed-tool-evidence.json"), "utf8")) as EvidenceSnapshotFile;
}

/** Assert the reviewer-facing artifacts carry the completed summary through
 *  the deliverable channel (the Agent final summaries section), and that tool
 *  observations remain present alongside it rather than being substituted. */
async function assertReviewerChannels(result: InPlaceLifecycleResult, marker: string, promptLog: string, options?: {
  prompts?: number;
  externalPath?: string;
}): Promise<void> {
  const cycle = result.reviewCycles.at(-1);
  assert.ok(cycle, "a review cycle was recorded");
  const invocationDir = cycle.reviewOutput.invocationDir;
  const bundleDir = cycle.reviewOutput.bundleDir;
  assert.ok(invocationDir && bundleDir, "the reviewer bundle and invocation directories are retained");

  const evidence = JSON.parse(await readFile(join(invocationDir, "evidence.json"), "utf8")) as EvidenceSnapshotFile;
  assert.deepEqual(evidence.finalAssistantSummaries, [marker], "reviewer evidence.json contains exactly the completed summary");
  assert.ok(evidence.events.length > 0, "tool observations stay present alongside the summary (not substituted)");
  assert.ok(evidence.candidates.some((candidate) => candidate.externalSideEffect === true), "external evidence stays present alongside the summary");

  const evidenceMd = await readFile(join(invocationDir, "evidence.md"), "utf8");
  assert.match(evidenceMd, /Agent final summaries/);
  assert.ok(evidenceMd.includes(marker), "reviewer evidence.md contains the completed summary");

  const bundleCurrentEvidence = JSON.parse(await readFile(join(bundleDir, "current", "evidence.json"), "utf8")) as EvidenceSnapshotFile;
  assert.deepEqual(bundleCurrentEvidence.finalAssistantSummaries, [marker], "the bundle's current evidence carries the completed summary");

  const request = await readFile(join(bundleDir, "request.md"), "utf8");
  assert.ok(request.includes(marker), "the review request itself contains the completed summary");
  if (options?.externalPath) {
    assert.match(request, /Tool-observed external side-effect candidates/);
    assert.ok(request.includes(options.externalPath), "the request keeps the external tool observation alongside the summary");
  }

  const prompts = await readCapturedPrompts(promptLog);
  assert.equal(prompts.length, options?.prompts ?? 1, "the reviewer was invoked the expected number of times");
  for (const prompt of prompts) {
    // The deliverable channel is the Agent final summaries section; a marker
    // anywhere else (tool observations, paths) can never satisfy this check.
    const section = agentSummarySection(prompt);
    assert.ok(section !== undefined, "the captured reviewer prompt carries the Agent final summaries section");
    assert.ok(section.includes(marker), "the actual captured reviewer prompt contains the completed summary in its deliverable section");
    if (options?.externalPath) {
      assert.ok(prompt.includes(options.externalPath), "the captured reviewer prompt keeps the external tool observation alongside the summary");
      assert.ok(prompt.includes(EXTERNAL_CONTENT_TOKEN), "the captured reviewer prompt keeps the tool-observed content (not substituted)");
    }
  }
}

// ── fixture-level fail-closed assertions (direct script execution) ───────────

test("reviewer fixture passes only on the received summary section; tool observations and absence fail closed", () => {
  const promptLog = join(tmpdir(), `prg-i266-fixture-verify-${randomUUID().slice(0, 8)}.jsonl`);
  try {
    const marker = summaryMarker("fixture-level");
    const runFixture = (prompt: string): { verdict: string; summary: string } => {
      const outcome = spawnSync(process.execPath, ["-e", validatingReviewerScript(promptLog, [marker])], {
        input: prompt,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(outcome.status, 0, `fixture exited cleanly: ${outcome.stderr}`);
      return JSON.parse(outcome.stdout) as { verdict: string; summary: string };
    };

    // Marker ONLY inside tool-observation content: must be rejected (the
    // deliverable section is missing) — tool observations never substitute
    // for the completed summary.
    const observationOnly = [
      "User request context:",
      "<request>",
      "review the synthetic deliverable",
      "</request>",
      "",
      "Session evidence:",
      "<session_evidence>",
      "## Session Evidence",
      "### Tool-observed external side-effect candidates",
      `- /tmp/observed-path (prior state unverified; write:command) ${marker}`,
      "### Executor tool-event observability limits",
      "- pi-model: test structured tool-event stream",
      "</session_evidence>",
      "",
    ].join("\n");
    const rejected = runFixture(observationOnly);
    assert.equal(rejected.verdict, "error", `missing summary section must fail closed: ${rejected.summary}`);
    assert.match(rejected.summary, /not present in the received Agent final summaries evidence section/);

    // The required marker in a summary section with a DIFFERENT text present:
    // still rejected (exact deliverable validation, no partial credit).
    const wrongSummary = observationOnly.replace(
      "### Tool-observed external side-effect candidates",
      `### Agent final summaries\n#### Summary 1\n\n${summaryMarker("wrong-text")}\n\n### Tool-observed external side-effect candidates`,
    );
    assert.equal(runFixture(wrongSummary).verdict, "error", "an unrelated summary entry must not satisfy the required marker");

    // The marker inside the received Agent final summaries section: the only
    // pass outcome.
    const summaryPresent = observationOnly.replace(
      "### Tool-observed external side-effect candidates",
      `### Agent final summaries\n#### Summary 1\n\n${marker}\n\n### Tool-observed external side-effect candidates`,
    );
    const accepted = runFixture(summaryPresent);
    assert.equal(accepted.verdict, "pass", `validating the received summary deliverable passes: ${accepted.summary}`);
  } finally {
    rm(promptLog, { force: true }).catch(() => undefined);
  }
});

// ── normal channel ───────────────────────────────────────────────────────────

test("initial completed summary is validated by the actual reviewer through the existing external-evidence admission", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-init-summary-"));
  try {
    const marker = summaryMarker("normal-channel");
    const externalPath = join(scratch, "external-observation.txt");
    const promptLog = join(scratch, "reviewer-prompts.jsonl");
    const fixture = await summaryFixture(scratch, "normal", { externalPath });
    const config = summaryScenarioConfig(validatingReviewerScript(promptLog, [marker]), noRetryPolicy);
    const result = await runInplaceLifecycle({
      ...lifecycleDeps(config, markerExecutor({ texts: [marker, confirmText], externalPath }), fixture, "inplace-init-summary-normal"),
    });

    assert.equal(result.status, "reviewed", JSON.stringify({
      status: result.status,
      error: result.error,
      cycles: result.reviewCycles.length,
      reviewerSummary: result.reviewCycles.at(-1)?.reviewOutput.result?.summary,
    }));
    assert.equal(result.reviewCycles.length, 1);
    assert.equal(result.reviewCycles[0]?.verdict, "pass", "the reviewer passed only after validating the received summary deliverable");
    assert.equal(result.changedSinceLaunch.length, 0, "the summary-only deliverable made zero in-root delta");
    assert.deepEqual(result.observedExternalPaths, [externalPath], "admission came from the existing external tool-observed evidence");
    // No report file exists and the input fixture is untouched: the worker
    // deliverable was the summary alone, and foreign files are preserved.
    assert.equal(await readFile(fixture.inputPath, "utf8"), fixture.inputBefore);

    await assertReviewerChannels(result, marker, promptLog, { externalPath });

    // The completed summaries were durably persisted by each turn's checkpoint
    // (initial deliverable plus the confirmation turn's text).
    const persisted = await readObservedEvidence(fixture.artifactDir);
    assert.deepEqual(persisted.finalAssistantSummaries, [marker, confirmText], "each completed turn's summary was durably persisted at its checkpoint");
    assert.ok(persisted.events.length > 0, "the persisted evidence retains the tool observations");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── retry channel ────────────────────────────────────────────────────────────

test("review retry retains the initial summary; tool observations are kept, not substituted", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-retry-summary-"));
  try {
    const marker = summaryMarker("retry-channel");
    const externalPath = join(scratch, "retry-external-observation.txt");
    const promptLog = join(scratch, "reviewer-prompts.jsonl");
    const fixture = await summaryFixture(scratch, "retry", { externalPath });
    const config = summaryScenarioConfig(
      validatingReviewerScript(promptLog, [marker], {
        stateFile: join(scratch, "reviewer-counter.txt"),
        firstInvocationMessage: "transient reviewer infrastructure incident (first invocation)",
      }),
      oneRetryPolicy,
    );
    const result = await runInplaceLifecycle({
      ...lifecycleDeps(config, markerExecutor({ texts: [marker, confirmText], externalPath }), fixture, "inplace-init-summary-retry"),
    });

    assert.equal(result.status, "reviewed", JSON.stringify({
      status: result.status,
      error: result.error,
      reviewerSummary: result.reviewCycles.at(-1)?.reviewOutput.result?.summary,
    }));
    assert.equal(result.reviewCycles.length, 1);
    assert.equal(result.reviewCycles[0]?.verdict, "pass", "the retry completed after the transient reviewer incident");

    // Both reviewer invocations received the SAME initial summary; the retry
    // neither lost it nor replaced it with tool observations.
    const prompts = await readCapturedPrompts(promptLog);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      const section = agentSummarySection(prompt);
      assert.ok(section !== undefined && section.includes(marker), "each review invocation received the initial completed summary in its deliverable section");
      assert.ok(prompt.includes(externalPath), "each review invocation kept the external tool observation alongside the summary");
      assert.ok(prompt.includes(EXTERNAL_CONTENT_TOKEN), "each review invocation kept the tool-observed content (not substituted)");
    }
    assert.ok(prompts[0] !== undefined && agentSummarySection(prompts[0])!.includes(marker), "the first (failing) invocation already received the summary: its failure was not a missing deliverable");

    // Each invocation's own evidence.json carries the summary (the second one
    // is the returned cycle's invocation directory, asserted by the helper).
    const cycle = result.reviewCycles.at(-1)!;
    const firstInvocationEvidence = JSON.parse(await readFile(join(cycle.reviewOutput.bundleDir!, "reviews", "0001", "evidence.json"), "utf8")) as EvidenceSnapshotFile; // sequencePath pads to four digits
    assert.deepEqual(firstInvocationEvidence.finalAssistantSummaries, [marker], "the retry's evidence retained the summary in its own bundle");

    await assertReviewerChannels(result, marker, promptLog, { externalPath, prompts: 2 });
    const persisted = await readObservedEvidence(fixture.artifactDir);
    assert.deepEqual(persisted.finalAssistantSummaries, [marker, confirmText]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── fallback/restore channel ─────────────────────────────────────────────────

test("restored fallback evidence retains the initial summary for the continuation reviewer", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-restore-summary-"));
  try {
    const initialMarker = summaryMarker("fallback-initial");
    const continuationMarker = summaryMarker("fallback-continuation");
    const externalPath = join(scratch, "restore-external-observation.txt");
    const promptLog = join(scratch, "reviewer-prompts.jsonl");
    const fixture = await summaryFixture(scratch, "restore", { externalPath });
    const config = summaryScenarioConfig(
      validatingReviewerScript(promptLog, [initialMarker, continuationMarker], {
        stateFile: join(scratch, "reviewer-counter.txt"),
        firstInvocationMessage: "transient reviewer infrastructure incident (first invocation)",
      }),
      noRetryPolicy,
    );
    const adapter = markerExecutor({ texts: [initialMarker, continuationMarker, confirmText], externalPath });

    // Phase 1: the initial lifecycle completes and its summary is durably
    // persisted; the first review fails on a transient reviewer incident and
    // settles paused with no fabrication and no retry-increase.
    const stopped = await runInplaceLifecycle({
      ...lifecycleDeps(config, adapter, fixture, "inplace-init-summary-restore"),
    });
    assert.equal(stopped.status, "review_error", JSON.stringify({ status: stopped.status, error: stopped.error }));
    const persistedAfterInitial = await readObservedEvidence(fixture.artifactDir);
    assert.deepEqual(persistedAfterInitial.finalAssistantSummaries, [initialMarker], "the initial deliverable survived durably before the pause");

    // Phase 2: an admitted continuation restores the durable evidence and the
    // original basis, then runs the continuation turn with its own marker.
    // The retained result models what the controller keeps after a review_error
    // pause: prior-turn context only, always re-run as the authoritative turn.
    const retained: InPlaceWorkerResult = {
      status: "executor_error",
      taskId: stopped.taskId,
      title: stopped.title,
      summary: stopped.summary,
      adapter: stopped.adapter,
      model: stopped.model,
      session: stopped.session,
      error: stopped.error,
      operationRecord: stopped.operationRecord,
      incidents: stopped.incidents ?? [],
      attempts: stopped.attempts ?? 1,
      lastExecutorTurn: stopped.lastExecutorTurn,
    };
    const restoredRun = await runInplaceLifecycle({
      ...lifecycleDeps(config, adapter, fixture, stopped.taskId),
      baseline: stopped.baseline,
      initialResult: retained,
      continuation: { instructions: "Finish the task from the retained state; the prior result is context only." },
    });

    assert.equal(restoredRun.status, "reviewed", JSON.stringify({
      status: restoredRun.status,
      error: restoredRun.error,
      reviewerSummary: restoredRun.reviewCycles.at(-1)?.reviewOutput.result?.summary,
    }));
    assert.equal(restoredRun.changedSinceLaunch.length, 0);

    const prompts = await readCapturedPrompts(promptLog);
    assert.equal(prompts.length, 2);
    // The restored fallback context gave the continuation reviewer the
    // ORIGINAL initial deliverable plus the continuation's own summary, both
    // through the deliverable section (not through tool observations).
    const restoredSection = prompts[1] !== undefined ? agentSummarySection(prompts[1]) : undefined;
    assert.ok(restoredSection !== undefined && restoredSection.includes(initialMarker), "the restored fallback context retained the initial summary");
    assert.ok(restoredSection !== undefined && restoredSection.includes(continuationMarker), "the continuation summary is present in the same deliverable section");
    assert.ok(prompts[1]?.includes(externalPath) && prompts[1]?.includes(EXTERNAL_CONTENT_TOKEN), "the external tool observation is still present, not substituted");
    assert.ok(!prompts[0]?.includes(continuationMarker), "summaries are not fabricated out of order across lifecycles");
    const persistedAfterRestore = await readObservedEvidence(fixture.artifactDir);
    assert.deepEqual(persistedAfterRestore.finalAssistantSummaries, [initialMarker, continuationMarker, confirmText], "task evidence records each summary in delivery order");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── zero-delta admission invariant (unchanged) ───────────────────────────────

test("genuine zero delta with no external evidence still skips review even when a summary exists", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-skip-summary-"));
  try {
    const marker = summaryMarker("skip-channel");
    const promptLog = join(scratch, "reviewer-prompts.jsonl");
    const fixture = await summaryFixture(scratch, "skip");
    const config = summaryScenarioConfig(validatingReviewerScript(promptLog, [marker]), noRetryPolicy);
    const result = await runInplaceLifecycle({
      ...lifecycleDeps(config, markerExecutor({ texts: [marker, confirmText] }), fixture, "inplace-init-summary-skip"),
    });

    assert.equal(result.status, "no_changes", "zero-delta, no-external-evidence tasks still settle without review");
    assert.equal(result.reviewCycles.length, 0);
    assert.equal(existsSync(promptLog), false, "the reviewer was never invoked");
    assert.equal(await readFile(fixture.inputPath, "utf8"), fixture.inputBefore, "the input fixture is untouched");
    // The completed summary was still recorded (bounded, redacted) and
    // durably persisted at the turn checkpoint for later restore, without
    // forcing any review or requiring a report file.
    const persisted = await readObservedEvidence(fixture.artifactDir);
    assert.deepEqual(persisted.finalAssistantSummaries, [marker]);
    assert.equal(persisted.events.length, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── summary-only evidence request composition (pure unit regression) ─────────

test("summary-only evidence alone composes the evidence bundle into the review request", async () => {
  // Pure #266 regression for the request builder's summary-only evidence
  // guard: review ADMISSION is not exercised here (no zero-delta skip, no
  // lifecycle, no reviewer invocation). With an existing-shaped non-Git
  // attribution fixture, exactly one harmless completed summary recorded
  // through the existing bounded/redacting helper, and zero tool events,
  // observability notes, and candidates, the request builder must still
  // attach the evidence bundle and expose the summary through the Agent final
  // summaries deliverable section.
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-request-summary-"));
  try {
    const marker = summaryMarker("request-guard");
    const fixture = await summaryFixture(scratch, "request-guard");
    // The reviewer fixture below is never invoked: this test builds the
    // request only, through the ordinary config/baseline helpers.
    const config = summaryScenarioConfig(validatingReviewerScript(join(scratch, "reviewer-prompts-never.jsonl"), [marker]), noRetryPolicy);
    const baseline = await createInPlaceBaseline(fixture.workspaceRoot, config);
    const attribution = await computeInPlaceAttribution(baseline, config);
    assert.equal(attribution.baseline.mode, "non_git");
    assert.equal(attribution.changes.length, 0, "the synthetic attribution fixture records a zero delta after launch");

    const evidence = createEvidenceState();
    rememberFinalAssistantSummaryText(evidence, marker);
    assert.deepEqual(evidence.finalAssistantSummaries, [marker], "exactly one harmless completed summary was recorded");
    assert.equal(evidence.events.length, 0);
    assert.equal(evidence.candidates.size, 0);
    assert.deepEqual(evidence.toolObservabilityNotes, []);

    const request = buildInPlaceReviewRequest({
      title: "summary deliverable task",
      instructions: "Read the input fixture and return the findings only in your final assistant summary; write no report file and no workspace edits.",
      acceptanceCriteria: ["findings appear only in the final assistant summary"],
    }, attribution, evidence);

    assert.match(
      request,
      /Structured executor tool-observation evidence \(post-hoc, bounded, not a pre-write gate\)/,
      "summary-only evidence still attaches the evidence bundle to the request",
    );
    const section = agentSummarySection(request);
    assert.ok(section !== undefined, "the request carries the Agent final summaries deliverable section");
    assert.ok(section.includes(marker), "the completed summary appears in the Agent final summaries section of the request");
    assert.ok(section.includes("Summary 1"), "the summary is rendered as a numbered deliverable entry");
    assert.ok(!request.includes("Tool event digest"), "no tool events were fabricated into a summary-only request");
    assert.ok(!request.includes("Tool-observed external side-effect candidates"), "no external candidates were fabricated into a summary-only request");
    assert.ok(!request.includes("Executor tool-event observability limits"), "no observability notes were fabricated into a summary-only request");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── serial vs concurrent, per-task marker ownership ──────────────────────────

test("per-task summaries stay distinct and unmixed across serial and concurrent initial runs", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-distinct-summary-"));
  try {
    // Serial: the second lifecycle must not inherit the first task's summary.
    const serialA = summaryMarker("serial-task-a");
    const serialB = summaryMarker("serial-task-b");
    const serialPromptA = join(scratch, "serial-prompts-a.jsonl");
    const serialPromptB = join(scratch, "serial-prompts-b.jsonl");
    const serialExternalA = join(scratch, "serial-external-a.txt");
    const serialExternalB = join(scratch, "serial-external-b.txt");
    const fixtureA = await summaryFixture(scratch, "serial-a", { externalPath: serialExternalA });
    const fixtureB = await summaryFixture(scratch, "serial-b", { externalPath: serialExternalB });
    const configA = summaryScenarioConfig(validatingReviewerScript(serialPromptA, [serialA]), noRetryPolicy);
    const configB = summaryScenarioConfig(validatingReviewerScript(serialPromptB, [serialB]), noRetryPolicy);
    const resultA = await runInplaceLifecycle({
      ...lifecycleDeps(configA, markerExecutor({ texts: [serialA, confirmText], externalPath: serialExternalA }), fixtureA, "inplace-summary-serial-a"),
    });
    assert.equal(resultA.status, "reviewed");
    const resultB = await runInplaceLifecycle({
      ...lifecycleDeps(configB, markerExecutor({ texts: [serialB, confirmText], externalPath: serialExternalB }), fixtureB, "inplace-summary-serial-b"),
    });
    assert.equal(resultB.status, "reviewed");
    // Distinct task evidence lifetimes: B's evidence carried exactly B's
    // marker (no mixing with A), and A's durable evidence still holds A's.
    const promptsB = await readCapturedPrompts(serialPromptB);
    assert.equal(promptsB.length, 1);
    assert.ok(promptsB[0] !== undefined && agentSummarySection(promptsB[0]!)!.includes(serialB), "the serial second task received its own marker");
    assert.ok(!promptsB[0]?.includes(serialA), "the serial second task did not receive the prior task's marker");
    assert.deepEqual((await readObservedEvidence(fixtureB.artifactDir)).finalAssistantSummaries, [serialB, confirmText]);
    assert.deepEqual((await readObservedEvidence(fixtureA.artifactDir)).finalAssistantSummaries, [serialA, confirmText]);
    await assertReviewerChannels(resultA, serialA, serialPromptA, { externalPath: serialExternalA });
    await assertReviewerChannels(resultB, serialB, serialPromptB, { externalPath: serialExternalB });

    // Concurrent: two in-place lifecycles with their own workspace roots,
    // artifact dirs, and reviewers. Evidence windows are per-task. The source
    // omission this issue fixes is a serial one, so this comparison must not
    // attribute anything to concurrency itself; it only proves that
    // distinguishable per-task summaries are neither lost nor mixed when runs
    // proceed together.
    const concurrentCount = 2;
    const concurrentSetups: Array<{
      marker: string;
      promptLog: string;
      externalPath: string;
      config: ReviewGateConfig;
      fixture: Awaited<ReturnType<typeof summaryFixture>>;
    }> = [];
    for (let index = 0; index < concurrentCount; index += 1) {
      const marker = summaryMarker(`concurrent-task-${index + 1}`);
      const promptLog = join(scratch, `concurrent-prompts-${index + 1}.jsonl`);
      const externalPath = join(scratch, `concurrent-external-${index + 1}.txt`);
      concurrentSetups.push({
        marker,
        promptLog,
        externalPath,
        config: summaryScenarioConfig(validatingReviewerScript(promptLog, [marker]), noRetryPolicy),
        fixture: await summaryFixture(scratch, `concurrent-${index + 1}`, { externalPath }),
      });
    }
    const concurrentResults = await Promise.all(concurrentSetups.map((setup, index) => {
      return runInplaceLifecycle({
        ...lifecycleDeps(setup.config, markerExecutor({ texts: [setup.marker, confirmText], externalPath: setup.externalPath }), setup.fixture, `inplace-summary-concurrent-${index + 1}`),
      });
    }));
    for (const [index, result] of concurrentResults.entries()) {
      assert.equal(result.status, "reviewed", `concurrent task ${index + 1} settled reviewed`);
      const ownMarker = concurrentSetups[index]!.marker;
      const otherMarker = concurrentSetups[1 - index]!.marker;
      const prompts = await readCapturedPrompts(concurrentSetups[index]!.promptLog);
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0] !== undefined && agentSummarySection(prompts[0]!)!.includes(ownMarker), `concurrent task ${index + 1} received exactly its own marker`);
      assert.ok(!prompts[0]?.includes(otherMarker), `concurrent task ${index + 1} did not receive the other task's marker`);
      assert.deepEqual(
        (await readObservedEvidence(concurrentSetups[index]!.fixture.artifactDir)).finalAssistantSummaries,
        [ownMarker, confirmText],
        `concurrent task ${index + 1} evidence records only its own marker`,
      );
      await assertReviewerChannels(result, ownMarker, concurrentSetups[index]!.promptLog, { externalPath: concurrentSetups[index]!.externalPath });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── fail-closed missing deliverable ──────────────────────────────────────────

test("missing summary deliverable fails closed: the reviewer rejects it and the lifecycle never passes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-missing-summary-"));
  try {
    const requiredButMissing = "EXPECTED-DELIVERABLE-MARKER-NEVER-PROVIDED";
    const externalPath = join(scratch, "missing-external-observation.txt");
    const promptLog = join(scratch, "reviewer-prompts.jsonl");
    const fixture = await summaryFixture(scratch, "missing", { externalPath });
    const config = summaryScenarioConfig(validatingReviewerScript(promptLog, [requiredButMissing]), noRetryPolicy);
    // The executor completes with prose that never contains the required
    // unique deliverable marker — exactly the missing-summary evidence shape
    // (review is admitted through the existing external-evidence path).
    const result = await runInplaceLifecycle({
      ...lifecycleDeps(config, markerExecutor({ texts: ["Completed the requested reading task with prose findings only.", confirmText], externalPath }), fixture, "inplace-init-summary-missing"),
    });

    assert.equal(result.status, "review_error", "a review without the required summary deliverable fails closed as a review error");
    assert.equal(result.reviewCycles.length, 1);
    assert.equal(result.reviewCycles[0]?.verdict, "error");
    assert.match(
      result.reviewCycles[0]?.reviewOutput.result?.summary ?? "",
      /not present in the received Agent final summaries evidence section/,
      "the reviewer's rejection names the missing deliverable",
    );
    // The summary prose reached the evidence channel (that is all that was
    // produced) — the pass was refused because the required marker was absent.
    const persisted = await readObservedEvidence(fixture.artifactDir);
    assert.deepEqual(persisted.finalAssistantSummaries, ["Completed the requested reading task with prose findings only."]);
    const prompts = await readCapturedPrompts(promptLog);
    assert.equal(prompts.length, 1);
    assert.ok(!prompts[0]?.includes(requiredButMissing), "no required deliverable marker ever existed in the evidence");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ── durable checkpoint fault injection (fail closed before review) ───────────

test("a failed summary-bearing evidence checkpoint settles as a disclosed executor_error before reviewing", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-inplace-checkpoint-fault-"));
  try {
    const marker = summaryMarker("checkpoint-fault");
    const externalPath = join(scratch, "fault-external-observation.txt");
    const promptLog = join(scratch, "reviewer-prompts.jsonl");
    const fixture = await summaryFixture(scratch, "fault", { externalPath });
    const config = summaryScenarioConfig(validatingReviewerScript(promptLog, [marker]), noRetryPolicy);

    // Fault injection: the durable write of the observed evidence (which now
    // carries the summary) fails at the rename stage exactly once; every
    // other durable write proceeds so settlement itself still works.
    let faultFireCount = 0;
    const injectedMessage = "durable write fault injected for #266 checkpoint regression";
    setDurableWriteFaultInjectionForTesting((stage, path) => {
      if (stage === "before_rename" && path.endsWith("observed-tool-evidence.json") && faultFireCount === 0) {
        faultFireCount += 1;
        throw new Error(injectedMessage);
      }
    });
    try {
      const result = await runInplaceLifecycle({
        ...lifecycleDeps(config, markerExecutor({ texts: [marker, confirmText], externalPath }), fixture, "inplace-init-summary-fault"),
      });

      assert.equal(faultFireCount, 1, "the fault fired exactly once at the summary-bearing evidence checkpoint");
      assert.equal(result.status, "executor_error", "the checkpoint failure rejects the turn and settles as a disclosed executor error");
      assert.ok((result.error ?? "").includes(injectedMessage), "the injected durable-write failure is disclosed verbatim");
      assert.equal(result.reviewCycles.length, 0, "no review ever proceeded after the failed checkpoint");
      assert.equal(existsSync(promptLog), false, "the own reviewer was never invoked");
      // No successful or silent in-place settlement occurred.
      const persistedResult = JSON.parse(await readFile(join(fixture.artifactDir, "result.json"), "utf8")) as { status: string; error?: string };
      assert.equal(persistedResult.status, "executor_error");
      assert.ok((persistedResult.error ?? "").includes(injectedMessage));
      // The durable evidence never claims a persisted summary for this run.
      assert.equal(existsSync(join(fixture.artifactDir, "observed-tool-evidence.json")), false, "no stale summary-bearing checkpoint was silently kept");
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});