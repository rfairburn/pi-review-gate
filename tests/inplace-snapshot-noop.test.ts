import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import * as capture from "../src/capture";
import { normalizeConfig, resolvedExecutorPool } from "../src/config";
import { MAX_OBSERVED_TOOL_EVENTS, type PersistedEvidenceState } from "../src/evidence";
import { runInplaceLifecycle, type InPlaceLifecycleInput } from "../src/execution/inplace-worker";
import { OBSERVED_TOOL_EVIDENCE_FILE } from "../src/execution/observed-evidence";
import type { ExecutorAdapter, ExecutorRequest } from "../src/execution/types";

const script = "#!/bin/sh\nprintf 'retained no-op SCRIPT content'\n";

async function fixture(t: TestContext, mode: "snapshot" | "tool" | "fallback" = "snapshot") {
  const base = resolve("dist-test/.fixtures");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "inplace-noop-"));
  const keys = ["HOME", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "GIT_CEILING_DIRECTORIES"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  // Register before partial setup; runInplaceLifecycle awaits reviewer child settlement.
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const workspaceRoot = join(root, "workspace"), artifactDir = join(root, "artifacts");
  const home = join(root, "home"), tmp = join(root, "tmp"), agent = join(root, "agent");
  for (const dir of [workspaceRoot, artifactDir, home, tmp, agent]) await mkdir(dir);
  process.env.HOME = home; process.env.TMPDIR = tmp; process.env.TMP = tmp; process.env.TEMP = tmp;
  process.env.PI_CODING_AGENT_DIR = agent; process.env.GIT_CEILING_DIRECTORIES = root;
  await writeFile(join(workspaceRoot, "SCRIPT"), script);
  const prompts = join(root, "reviewer-prompts.jsonl");
  await writeFile(prompts, "");
  const reviewer = `const fs=require('node:fs');let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(p)+'\\n');process.stdout.write(JSON.stringify({verdict:'pass',summary:'actual reviewer passed',findings:[]}));});`;
  const config = normalizeConfig({ enabled: true, retainBundles: "always", maxCorrectionCycles: 3,
    review: { primaryReviewers: [{ source: "external", id: "reviewer" }], subtaskReviewers: [{ source: "external", id: "reviewer" }],
      evidence: { primaryToolOnly: false, worktreeToolOnly: false, inplaceToolOnly: mode === "tool", snapshotFailureFallback: mode === "fallback" } },
    externalAgents: {
      reviewer: { adapter: "generic-cli", command: process.execPath, review: { args: ["-e", reviewer], timeoutMs: 10000 } },
      executor: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: { workerResources: { worker: { selection: { source: "external", id: "executor" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] },
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 0 } },
  });
  let turns = 0;
  async function observedWrite(request: ExecutorRequest, body: string) {
    const toolInput = { path: join(workspaceRoot, "SCRIPT"), content: body };
    request.onToolObservation?.({ stage: "start", toolName: "write", toolInput });
    await writeFile(join(workspaceRoot, "SCRIPT"), body);
    request.onToolObservation?.({ stage: "end", toolName: "write", toolInput, result: "written" });
  }
  let action = async (request: ExecutorRequest, turn: number) => {
    if (turn === 1) await observedWrite(request, script);
  };
  const adapter: ExecutorAdapter = {
    kind: "pi-model", toolEventObservability: { mode: "structured", description: "actual bounded adapter events" },
    async run(request) {
      await action(request, ++turns);
      return { text: `SCRIPT claim ${turns}`, session: { adapter: "pi-model", id: "noop-session" }, stdoutPath: "", stderrPath: "", code: 0, timedOut: false, aborted: false };
    },
  };
  const warnings: string[] = [];
  const input: InPlaceLifecycleInput = { taskId: "snapshot-noop", workspaceRoot, artifactDir, config,
    task: { title: "SCRIPT", instructions: "Write SCRIPT; independent REPORT output is not worker evidence.", acceptanceCriteria: ["SCRIPT retained"],
      reviewEvidencePolicy: { scope: "inplace", toolOnly: mode === "tool", snapshotFailureFallback: mode === "fallback" } },
    executorAssignment: { entry: resolvedExecutorPool(config)[0]!, priority: 0 }, adapterFactory: () => adapter,
    onEvidenceWarning: (message) => { warnings.push(message); },
  };
  return { input, warnings, workspaceRoot, observedWrite, get turns() { return turns; },
    setAction(next: typeof action) { action = next; },
    async prompts() { return (await readFile(prompts, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string); },
    async evidence() { return JSON.parse(await readFile(join(artifactDir, OBSERVED_TOOL_EVIDENCE_FILE), "utf8")) as PersistedEvidenceState; },
  };
}

test("all-Off snapshot identical structured SCRIPT write stays no_changes before and after durable continuation", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.input.config.review!.evidence, { primaryToolOnly: false, worktreeToolOnly: false, inplaceToolOnly: false, snapshotFailureFallback: false });
  const first = await runInplaceLifecycle(f.input);
  assert.equal(first.status, "no_changes", JSON.stringify({ status: first.status, cycles: first.reviewCycles.length, reviewerCalls: (await f.prompts()).length, error: first.error }));
  assert.equal(first.evidenceMethod, "snapshot");
  assert.deepEqual(first.changedSinceLaunch, []);
  assert.equal(first.reviewCycles.length, 0);
  assert.equal(f.turns, 1);
  assert.deepEqual(await f.prompts(), [], "the real reviewer process was never invoked");
  const saved = await f.evidence();
  assert.equal(saved.requiresReview, false);
  assert.equal(saved.events.length, 2);
  assert.equal(saved.toolObservationRevision, 2);
  assert.equal(saved.externalObservationRevision, 0);
  assert.equal(saved.candidates.length, 1);
  assert.equal(saved.candidates[0]!.toolObserved, true);
  assert.equal(saved.candidates[0]!.afterSnapshot!.content, script);
  const continued = await runInplaceLifecycle({ ...f.input, continuation: { instructions: "Confirm SCRIPT remains unchanged." } });
  assert.equal(continued.status, "no_changes", JSON.stringify({ status: continued.status, reviewerCalls: (await f.prompts()).length, error: continued.error }));
  assert.equal(continued.reviewCycles.length, 0);
  assert.equal(f.turns, 2);
  assert.deepEqual(await f.prompts(), []);
  assert.equal((await f.evidence()).requiresReview, false, "restoring in-root candidates alone must not force review");
});

for (const mode of ["tool", "fallback"] as const) {
  test(`${mode} identical SCRIPT observations still reach the actual reviewer; REPORT-only confirmation does not churn`, async (t) => {
    const f = await fixture(t, mode);
    let captures = 0;
    t.mock.method(capture, "createWorkspaceSnapshot", async () => { captures++; throw new Error("injected snapshot acquisition failure"); });
    f.setAction(async (request, turn) => {
      if (turn === 1) await f.observedWrite(request, script);
      else await writeFile(join(f.workspaceRoot, "REPORT"), "independent REPORT writer\n");
    });
    const result = await runInplaceLifecycle(f.input);
    assert.equal(result.status, "reviewed", result.error ?? result.status);
    assert.equal(result.reviewCycles.length, 1);
    assert.equal(f.turns, 2);
    assert.equal(captures, mode === "tool" ? 0 : 2);
    assert.equal(f.warnings.length, mode === "tool" ? 0 : 2);
    const prompts = await f.prompts();
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes(script.trim()), "actual SCRIPT content reaches reviewer stdin");
    for (const file of ["evidence.json", "evidence.md"]) {
      const body = await readFile(join(result.reviewCycles[0]!.reviewOutput.invocationDir!, file), "utf8");
      assert.ok(body.includes("retained no-op SCRIPT content"));
      assert.ok(!body.includes("independent REPORT writer"));
    }
  });
}

test("new in-root SCRIPT plus unknown overflow advances both review revisions and reaches a second tool review", async (t) => {
  const f = await fixture(t, "tool");
  f.setAction(async (request, turn) => {
    if (turn === 1) await f.observedWrite(request, script);
    if (turn === 2) {
      await f.observedWrite(request, "new in-root SCRIPT after pass\n");
      for (let i = 0; i <= MAX_OBSERVED_TOOL_EVENTS; i++) request.onToolObservation?.({ stage: "start", toolName: "read", toolInput: {} });
      request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "x".repeat(100000) } });
    }
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error ?? result.status);
  assert.equal(result.reviewCycles.length, 2);
  const [first, second] = result.reviewCycles;
  assert.ok(second!.toolObservationRevision! > first!.toolObservationRevision!);
  assert.ok(second!.externalObservationRevision! > first!.externalObservationRevision!);
  assert.notEqual(second!.identity, first!.identity);
  const prompts = await f.prompts();
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1]!.includes("new in-root SCRIPT after pass"));
  const saved = await f.evidence();
  assert.equal(saved.requiresReview, true);
  assert.equal(saved.toolObservationsTruncated, true);
});
