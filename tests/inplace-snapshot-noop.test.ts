import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import * as capture from "../src/capture";
import { normalizeConfig, resolvedExecutorPool } from "../src/config";
import { MAX_OBSERVED_TOOL_EVENTS, type PersistedEvidenceState } from "../src/evidence";
import { runInplaceLifecycle, type InPlaceLifecycleInput } from "../src/execution/inplace-worker";
import { OBSERVED_TOOL_EVIDENCE_FILE } from "../src/execution/observed-evidence";
import type { ExecutorAdapter, ExecutorLiveControl, ExecutorRequest } from "../src/execution/types";

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
    await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput });
    await writeFile(join(workspaceRoot, "SCRIPT"), body);
    await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput, result: "written", isError: false });
  }
  let action = async (request: ExecutorRequest, turn: number) => {
    if (turn === 1) await observedWrite(request, script);
  };
  let unavailable = false;
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    get toolEventObservability() { return unavailable
      ? { mode: "unavailable" as const, description: "fixture protocol supplies no structured tool events" }
      : { mode: "structured" as const, description: "actual bounded adapter events" }; },
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
    unavailableObservations() { unavailable = true; },
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
      for (let i = 0; i <= MAX_OBSERVED_TOOL_EVENTS; i++) await request.onToolObservation?.({ stage: "start", toolName: "read", toolInput: {} });
      await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "x".repeat(100000) } });
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

test("snapshot pass followed by REPORT-only churn settles the reviewed pass without re-review; a new qualifying edit still re-reviews", async (t) => {
  const f = await fixture(t);
  f.setAction(async (request, turn) => {
    if (turn === 1) await f.observedWrite(request, "reviewed SCRIPT\n");
    else await writeFile(join(f.workspaceRoot, "REPORT"), `independent REPORT writer ${turn}\n`);
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(result.reviewCycles.length, 1);
  assert.equal(f.turns, 2, "one pass-response turn, no confirmation loop");
  assert.equal((await f.prompts()).length, 1);
  assert.ok(result.changedSinceLaunch.some((change) => change.path === "REPORT"), "post-pass churn is still reported");
  assert.match(result.summary, /captured but NOT reviewed: added REPORT/);
  assert.match(result.summary, /not certified by that pass/);

  const g = await fixture(t);
  g.setAction(async (request, turn) => {
    if (turn === 1) await g.observedWrite(request, "reviewed SCRIPT\n");
    if (turn === 2) await g.observedWrite(request, "post-pass SCRIPT edit\n");
  });
  const rereviewed = await runInplaceLifecycle(g.input);
  assert.equal(rereviewed.status, "reviewed", rereviewed.error);
  assert.equal(rereviewed.reviewCycles.length, 2);
  assert.match(rereviewed.automaticReviewNotArmed ?? "", /Later unattributed changes are NOT approved/);
  assert.ok((await g.prompts())[1]!.includes("post-pass SCRIPT edit"));
});

for (const mode of ["snapshot", "tool"] as const) for (const scenario of ["sibling", "process", "call-only", "candidate-call-only", "completed-noop", "failed-local", "checkpoint", "restored", "unchanged", "already-reviewed", "read-only", "missing", "unsupported", "incomplete"] as const) {
  test(`InPlace ${mode} same-pass ${scenario} retains the actual pass without reviewing unattributed drift`, async (t) => {
    const f = await fixture(t, mode);
    f.setAction(async (request, turn) => {
      if (turn === 1) {
        await f.observedWrite(request, "reviewed SCRIPT\n");
        if (scenario === "missing") f.unavailableObservations();
      } else if (turn === 2) {
        if (scenario === "call-only" || scenario === "completed-noop") {
          const event = { toolName: "bash", toolInput: { command: "echo no mutation" } };
          await request.onToolObservation?.({ ...event, stage: "start" });
          if (scenario === "completed-noop") await request.onToolObservation?.({ ...event, stage: "end", result: "no mutation" });
        }
        if (scenario === "candidate-call-only") await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: join(f.workspaceRoot, "SCRIPT") } });
        if (scenario === "failed-local") {
          const toolInput = { path: join(f.workspaceRoot, "MISSING") };
          await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput });
          await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput, result: "failed before mutation", isError: true });
        }
        if (scenario === "unsupported") await request.onToolObservation?.({ stage: "start", toolName: "unknown" });
        if (scenario === "incomplete") await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "x".repeat(100000) } });
        if (scenario === "read-only") await request.onToolObservation?.({ stage: "end", toolName: "read", toolInput: { path: "SCRIPT" }, result: "reviewed SCRIPT\n" });
        if (scenario === "already-reviewed") await f.observedWrite(request, "reviewed SCRIPT\n");
        if (scenario === "checkpoint") {
          const checkpoint = join(f.workspaceRoot, ".pi-review-gate", "checkpoints", "synthetic-arbitrary", "state");
          await mkdir(join(checkpoint, ".."), { recursive: true });
          await writeFile(checkpoint, "unattributed checkpoint writer\n");
        } else if (scenario === "restored") await writeFile(join(f.workspaceRoot, "SCRIPT"), script);
        else if (scenario === "process") execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('SCRIPT','unattributed process edit\\n')"], { cwd: f.workspaceRoot, timeout: 5000 });
        else if (scenario === "sibling" || scenario === "call-only" || scenario === "candidate-call-only" || scenario === "completed-noop") await writeFile(join(f.workspaceRoot, "SCRIPT"), "unattributed shared-root edit\n");
        else if (scenario !== "unchanged" && scenario !== "already-reviewed" && scenario !== "read-only") await writeFile(join(f.workspaceRoot, "REPORT"), "sibling/process output\n");
      }
    });
    const result = await runInplaceLifecycle(f.input);
    assert.equal(result.status, "reviewed", result.error);
    assert.equal(f.turns, 2, "exactly one confirmation, no snapshot-only follow-up");
    assert.equal((await f.prompts()).length, 1, "actual reviewer invocation count");
    assert.equal(result.reviewCycles.length, 1);
    const pass = result.reviewCycles[0]!;
    assert.equal(pass.cycle, 1);
    assert.equal(pass.verdict, "pass");
    assert.match(await readFile(join(pass.reviewOutput.invocationDir!, "reviewer-context.md"), "utf8"), /reviewed SCRIPT/);
    assert.match(result.summary, /Review cycle 1 passed the delta it reviewed/);
    assert.match(result.summary, /current workspace state is not certified/);
    assert.match(result.summary, /Later unattributed changes are NOT approved/);
    assert.match(result.summary, /best effort: missing, unsupported or incomplete observations are not proof/);
    assert.doesNotMatch(result.summary, /workspace delta is unchanged|workspace is fully reviewed/);
    if (scenario === "checkpoint" && mode === "snapshot") assert.match(result.summary, /NOT reviewed: added \.pi-review-gate\/checkpoints\/synthetic-arbitrary\/state/);
    if (scenario === "restored" && mode === "snapshot") {
      assert.deepEqual(result.changedSinceLaunch, []);
      assert.match(result.summary, /NOT reviewed: restored SCRIPT/);
    }
  });
}

for (const mode of ["snapshot", "tool"] as const) {
  test(`InPlace ${mode} completed no-op cannot attribute a later sibling edit to the operation`, async (t) => {
    const f = await fixture(t, mode);
    f.setAction(async (request, turn) => {
      if (turn === 1) await f.observedWrite(request, "reviewed SCRIPT\n");
      if (turn === 2) {
        await f.observedWrite(request, "reviewed SCRIPT\n");
        // This runs strictly AFTER the completed operation's end observation.
        await writeFile(join(f.workspaceRoot, "SCRIPT"), "late sibling SCRIPT\n");
      }
    });
    const result = await runInplaceLifecycle(f.input);
    assert.equal(result.status, "reviewed", result.error);
    assert.equal(result.reviewCycles.length, 1);
    assert.equal((await f.prompts()).length, 1);
    assert.equal(f.turns, 2);
    assert.equal(result.reviewCycles[0]!.verdict, "pass");
    assert.match(result.automaticReviewNotArmed ?? "", /Later unattributed changes are NOT approved/);
    assert.match(result.summary, /Review cycle 1 passed the delta it reviewed/);
    assert.doesNotMatch((await f.prompts())[0]!, /late sibling SCRIPT/);
  });

  for (const status of ["acknowledged", "blocked"] as const) {
    test(`InPlace ${mode} ${status} live steering during confirmation respects the instruction boundary`, async (t) => {
      const f = await fixture(t, mode);
      let live: ExecutorLiveControl | undefined;
      f.input.onLiveControl = (control) => { live = control; };
      f.setAction(async (request, turn) => {
        if (turn === 1) {
          await f.observedWrite(request, "earlier reviewed SCRIPT\n");
          f.unavailableObservations();
        }
        if (turn === 2) {
          request.onLiveControl?.({ adapter: "pi-model", generation: 1, capabilities: { steer: true, interrupt: false },
            steer: async () => ({ status, message: "controlled transport acknowledgement" }),
            interrupt: async () => ({ status: "blocked", message: "unsupported" }) });
          assert.ok(live);
          assert.equal((await live.steer("Implement newer instructions", "new-instruction")).status, status);
          await writeFile(join(f.workspaceRoot, "SCRIPT"), "new instruction implementation without tool events\n");
          request.onLiveControl?.(undefined);
        }
      });
      const result = await runInplaceLifecycle(f.input);
      assert.equal(result.status, "reviewed", result.error);
      assert.equal((await f.prompts()).length, status === "acknowledged" ? 2 : 1);
      assert.equal(result.reviewCycles.length, status === "acknowledged" ? 2 : 1);
      assert.equal(result.reviewCycles.at(-1)!.cycle, status === "acknowledged" ? 2 : 1);
      if (status === "acknowledged" && mode === "snapshot") assert.match((await f.prompts())[1]!, /new instruction implementation without tool events/);
    });
  }
}

test("InPlace continuation instructions never reuse the earlier run's passing review", async (t) => {
  const f = await fixture(t);
  f.setAction(async (request, turn) => {
    if (turn === 1) await f.observedWrite(request, "earlier reviewed SCRIPT\n");
  });
  const first = await runInplaceLifecycle(f.input);
  assert.equal(first.status, "reviewed", first.error);
  const passArtifact = first.reviewCycles[0]!.reviewOutput.invocationDir!;
  const continued = await runInplaceLifecycle({ ...f.input, continuation: { instructions: "Perform a different follow-up task." } });
  assert.equal(continued.status, "unreviewed");
  assert.equal(continued.reviewCycles.length, 0, "a prior pass is not this continuation's review");
  assert.equal((await f.prompts()).length, 1);
  assert.match(continued.summary, /passed only an earlier delta in a prior run/);
  assert.ok(await readFile(join(passArtifact, "reviewer-context.md"), "utf8"));
});

for (const mode of ["snapshot", "tool"] as const) for (const activity of ["own-edit", "own-patch", "own-new-file", "own-restoration", "outside-candidate-no-diff"] as const) {
  test(`InPlace ${mode} same-pass ${activity} actually invokes a follow-up reviewer`, async (t) => {
    const f = await fixture(t, mode);
    f.setAction(async (request, turn) => {
      if (turn === 1) await f.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        if (activity === "outside-candidate-no-diff") {
          await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: join(f.workspaceRoot, "..", "outside-candidate") } });
        } else if (activity === "own-patch") {
          const toolInput = { patch: "*** Begin Patch\n*** Update File: SCRIPT\n@@\n-first reviewed SCRIPT\n+new own patch SCRIPT\n*** End Patch" };
          await request.onToolObservation?.({ stage: "start", toolName: "ApplyPatch", toolInput });
          await writeFile(join(f.workspaceRoot, "SCRIPT"), "new own patch SCRIPT\n");
          await request.onToolObservation?.({ stage: "end", toolName: "ApplyPatch", toolInput, result: "applied", isError: false });
        } else if (activity === "own-new-file") {
          const toolInput = { path: join(f.workspaceRoot, "NEW"), content: "new own content\n" };
          await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput });
          await writeFile(toolInput.path, toolInput.content);
          await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput, result: "written", isError: false });
        } else await f.observedWrite(request, activity === "own-edit" ? "new own SCRIPT\n" : script);
      }
    });
    const result = await runInplaceLifecycle(f.input);
    assert.equal(result.status, "reviewed", result.error);
    assert.equal(f.turns, 3);
    assert.equal((await f.prompts()).length, 2);
    assert.deepEqual(result.reviewCycles.map((cycle) => [cycle.cycle, cycle.verdict]), [[1, "pass"], [2, "pass"]]);
    assert.notEqual(result.reviewCycles[0]!.reviewOutput.invocationDir, result.reviewCycles[1]!.reviewOutput.invocationDir);
    if (activity === "outside-candidate-no-diff") assert.ok((await f.prompts())[1]!.includes("outside-candidate"), "observed scope, not verified outside diff, reaches the reviewer");
  });
}

/** Observe one non-native tool shape exactly at its operation boundaries. */
async function observedTool(request: ExecutorRequest, toolName: string, toolInput: Record<string, unknown>,
  body: string, isError = false, result: unknown = "completed") {
  await request.onToolObservation?.({ stage: "start", toolName, toolInput });
  await writeFile(join(request.cwd, "SCRIPT"), body);
  await request.onToolObservation?.({ stage: "end", toolName, toolInput, result, isError });
}

for (const mode of ["snapshot", "tool"] as const) {
  for (const variant of ["shell-redirect", "powershell-redirect", "codex-files", "edit-camel"] as const) {
    test(`InPlace ${mode} same-pass supported ${variant} mutation re-reviews without tool-brand interpretation`, async (t) => {
      const f = await fixture(t, mode);
      const body = `supported ${variant} SCRIPT\n`;
      const toolInput = variant === "shell-redirect" ? { command: "printf x > SCRIPT" }
        : variant === "powershell-redirect" ? { command: "'x' > SCRIPT" }
          : variant === "codex-files" ? { files: [join(f.workspaceRoot, "SCRIPT")] }
            : { filePath: join(f.workspaceRoot, "SCRIPT"), edits: [{ oldText: "first reviewed SCRIPT\n", newText: body }] };
      const toolName = variant === "shell-redirect" ? "bash" : variant === "powershell-redirect" ? "powershell" : variant === "codex-files" ? "write" : "edit";
      f.setAction(async (request, turn) => {
        if (turn === 1) await f.observedWrite(request, "first reviewed SCRIPT\n");
        if (turn === 2) await observedTool(request, toolName, toolInput, body);
      });
      const result = await runInplaceLifecycle(f.input);
      assert.equal(result.status, "reviewed", result.error);
      assert.equal(result.reviewCycles.length, 2, "the completed supported mutation is captured reviewable activity");
      assert.equal(f.turns, 3);
      const prompts = await f.prompts();
      assert.equal(prompts.length, 2, "actual reviewer invocation count");
      assert.ok(prompts[1]!.includes(body.trim()));
    });
  }

  test(`InPlace ${mode} same-pass completed supported mutation with no content effect retains the pass`, async (t) => {
    const f = await fixture(t, mode);
    f.setAction(async (request, turn) => {
      if (turn === 1) await f.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        // A recognized mutation candidate whose completed operation reports no
        // content change is not fresh reviewable activity.
        await request.onToolObservation?.({ stage: "start", toolName: "bash", toolInput: { command: "touch SCRIPT" } });
        await request.onToolObservation?.({ stage: "end", toolName: "bash", toolInput: { command: "touch SCRIPT" }, result: "completed", isError: false });
      }
    });
    const result = await runInplaceLifecycle(f.input);
    assert.equal(result.status, "reviewed", result.error);
    assert.equal(result.reviewCycles.length, 1);
    assert.equal(f.turns, 2);
    assert.equal((await f.prompts()).length, 1);
    assert.match(result.summary, /Later unattributed changes are NOT approved/);
  });

  test(`InPlace ${mode} same-pass partially applied ApplyPatch error re-reviews while a failed-before-mutation write does not`, async (t) => {
    const partial = await fixture(t, mode);
    const toolInput = { patch: "*** Begin Patch\n*** Update File: SCRIPT\n@@\n-first reviewed SCRIPT\n+partially applied SCRIPT\n*** Add File: LATER\n+never attempted\n*** End Patch" };
    partial.setAction(async (request, turn) => {
      if (turn === 1) await partial.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        // The overall result is an error, but the earlier operation survives.
        await request.onToolObservation?.({ stage: "start", toolName: "ApplyPatch", toolInput });
        await writeFile(join(partial.workspaceRoot, "SCRIPT"), "partially applied SCRIPT\n");
        await request.onToolObservation?.({ stage: "end", toolName: "ApplyPatch", toolInput, isError: true,
          result: "patch failed at operation 2 (create_file LATER): Invalid Context; 1 earlier operation(s) still applied" });
      }
    });
    const reviewed = await runInplaceLifecycle(partial.input);
    assert.equal(reviewed.status, "reviewed", reviewed.error);
    assert.equal(reviewed.reviewCycles.length, 2, "reported applied effects are not discarded by an overall error");
    assert.equal((await partial.prompts()).length, 2);
    assert.ok((await partial.prompts())[1]!.includes("partially applied SCRIPT"));

    const failed = await fixture(t, mode);
    failed.setAction(async (request, turn) => {
      if (turn === 1) await failed.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        const input = { path: join(failed.workspaceRoot, "MISSING") };
        await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: input });
        await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: input, result: "failed before mutation", isError: true });
      }
    });
    const failedResult = await runInplaceLifecycle(failed.input);
    assert.equal(failedResult.status, "reviewed", failedResult.error);
    assert.equal(failedResult.reviewCycles.length, 1, "a failure before any mutation is not captured activity");
    assert.equal((await failed.prompts()).length, 1);
  });

  for (const scenario of ["sibling-noop", "sibling-restore"] as const) {
    test(`InPlace ${mode} same-pass ${scenario} compares against the operation prestate, not the stale passing snapshot`, async (t) => {
      const f = await fixture(t, mode);
      const drift = "sibling drift SCRIPT\n";
      f.setAction(async (request, turn) => {
        if (turn === 1) await f.observedWrite(request, "first reviewed SCRIPT\n");
        if (turn === 2) {
          await writeFile(join(f.workspaceRoot, "SCRIPT"), drift);
          // sibling-noop repeats the drifted content; sibling-restore genuinely
          // restores the reviewed content from the drifted prestate.
          await f.observedWrite(request, scenario === "sibling-noop" ? drift : "first reviewed SCRIPT\n");
        }
      });
      const result = await runInplaceLifecycle(f.input);
      assert.equal(result.status, "reviewed", result.error);
      assert.equal(result.reviewCycles.length, scenario === "sibling-noop" ? 1 : 2);
      assert.equal((await f.prompts()).length, scenario === "sibling-noop" ? 1 : 2, "actual reviewer invocation count");
      if (scenario === "sibling-noop") assert.match(result.summary, /Later unattributed changes are NOT approved/);
      else assert.ok((await f.prompts())[1]!.includes("first reviewed SCRIPT"));
    });
  }

  test(`InPlace ${mode} redacted display spelling never fabricates an outside-root candidate; a usable outside identity still re-reviews`, async (t) => {
    const redacted = await fixture(t, mode);
    redacted.setAction(async (request, turn) => {
      if (turn === 1) await redacted.observedWrite(request, "reviewed SCRIPT\n");
      if (turn === 2) {
        // `../token=value/../workspace/SCRIPT` normalizes in-root, but its
        // display projection redacts to `../token=[REDACTED]`.
        await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "../token=value/../workspace/SCRIPT" } });
      }
    });
    const retained = await runInplaceLifecycle(redacted.input);
    assert.equal(retained.status, "reviewed", retained.error);
    assert.equal(retained.reviewCycles.length, 1, "a redacted display spelling is not resolved as an identity");
    assert.equal((await redacted.prompts()).length, 1);

    const outside = await fixture(t, mode);
    outside.setAction(async (request, turn) => {
      if (turn === 1) await outside.observedWrite(request, "reviewed SCRIPT\n");
      if (turn === 2) await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "../outside-candidate" } });
    });
    const reviewed = await runInplaceLifecycle(outside.input);
    assert.equal(reviewed.status, "reviewed", reviewed.error);
    assert.equal(reviewed.reviewCycles.length, 2, "a usable outside-root identity still re-reviews without an actual diff");
    assert.ok((await outside.prompts())[1]!.includes("outside-candidate"));
  });
}

for (const mode of ["snapshot", "tool"] as const) {
  test(`InPlace ${mode} incomplete or unpaired boundaries never fabricate same-pass activity`, async (t) => {
    for (const scenario of ["end-only-failed", "unpaired-identities"] as const) {
      const f = await fixture(t, mode);
      const other = join(f.workspaceRoot, "OTHER");
      f.setAction(async (request, turn) => {
        if (turn === 1) await f.observedWrite(request, "first reviewed SCRIPT\n");
        if (turn === 2) {
          if (scenario === "end-only-failed") {
            const toolInput = { path: join(f.workspaceRoot, "MISSING") };
            // Delivery lost the call stage; the error reports no mutation.
            await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput, result: "failed before mutation", isError: true });
          } else {
            await writeFile(other, "other body\n");
            await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { files: [join(f.workspaceRoot, "SCRIPT")] } });
            // The result names a different identity: no pair may be compared.
            await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { files: [other] }, result: "completed", isError: false });
          }
        }
      });
      const result = await runInplaceLifecycle(f.input);
      assert.equal(result.status, "reviewed", `${scenario}: ${result.error}`);
      assert.equal(result.reviewCycles.length, 1, `${scenario}: incomplete capture is not activity`);
      assert.equal(f.turns, 2, scenario);
      assert.equal((await f.prompts()).length, 1, `${scenario}: exact reviewer invocations`);
      assert.match(result.summary, /Later unattributed changes are NOT approved/, scenario);
      assert.match(result.summary, /missing, unsupported or incomplete observations are not proof/, scenario);
    }
  });

  test(`InPlace ${mode} boundary comparisons match file identities, not candidate order`, async (t) => {
    const reordered = await fixture(t, mode);
    const other = join(reordered.workspaceRoot, "OTHER");
    reordered.setAction(async (request, turn) => {
      if (turn === 1) await reordered.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        await writeFile(other, "other body\n");
        const files = [join(reordered.workspaceRoot, "SCRIPT"), other];
        await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { files } });
        await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { files: [...files].reverse() }, result: "completed", isError: false });
      }
    });
    const retained = await runInplaceLifecycle(reordered.input);
    assert.equal(retained.status, "reviewed", retained.error);
    assert.equal(retained.reviewCycles.length, 1, "reordered unchanged candidates are not a change");
    assert.equal((await reordered.prompts()).length, 1);

    const swapped = await fixture(t, mode);
    const swappedOther = join(swapped.workspaceRoot, "OTHER");
    swapped.setAction(async (request, turn) => {
      if (turn === 1) await swapped.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        await writeFile(swappedOther, "other body\n");
        const files = [join(swapped.workspaceRoot, "SCRIPT"), swappedOther];
        await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { files } });
        // Genuine edits, with the end observation listing the same files reversed.
        await writeFile(join(swapped.workspaceRoot, "SCRIPT"), "other body\n");
        await writeFile(swappedOther, "first reviewed SCRIPT\n");
        await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { files: [...files].reverse() }, result: "completed", isError: false });
      }
    });
    const reviewed = await runInplaceLifecycle(swapped.input);
    assert.equal(reviewed.status, "reviewed", reviewed.error);
    assert.equal(reviewed.reviewCycles.length, 2, "identity-matched boundary changes are captured activity");
    assert.equal((await swapped.prompts()).length, 2);
  });
}

for (const mode of ["snapshot", "tool"] as const) {
  test(`InPlace ${mode} an incomplete candidate never vetoes an independently captured change`, async (t) => {
    // 1. Unreadable candidate first, followed by a readable, genuinely changed one.
    const first = await fixture(t, mode);
    const blocked = join(first.workspaceRoot, "UNREADABLE");
    const firstScript = join(first.workspaceRoot, "SCRIPT");
    first.setAction(async (request, turn) => {
      if (turn === 1) await first.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        await writeFile(blocked, "unreadable body\n");
        await chmod(blocked, 0o000);
        try {
          const files = [blocked, firstScript];
          await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { files } });
          await writeFile(firstScript, "changed after the unreadable candidate\n");
          await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { files }, result: "completed", isError: false });
        } finally {
          await chmod(blocked, 0o600);
        }
      }
    });
    const unreadable = await runInplaceLifecycle(first.input);
    assert.equal(unreadable.status, "reviewed", unreadable.error);
    assert.equal(unreadable.reviewCycles.length, 2, "the readable changed identity is affirmative evidence");
    assert.equal((await first.prompts()).length, 2, "exact reviewer invocations");

    // 2. Different-sized candidate sets with one genuinely changed shared identity.
    const second = await fixture(t, mode);
    const secondScript = join(second.workspaceRoot, "SCRIPT");
    const other = join(second.workspaceRoot, "OTHER");
    second.setAction(async (request, turn) => {
      if (turn === 1) await second.observedWrite(request, "first reviewed SCRIPT\n");
      if (turn === 2) {
        await writeFile(other, "other body\n");
        await request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { files: [secondScript] } });
        await writeFile(secondScript, "changed shared identity\n");
        await request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { files: [secondScript, other] }, result: "completed", isError: false });
      }
    });
    const reviewed = await runInplaceLifecycle(second.input);
    assert.equal(reviewed.status, "reviewed", reviewed.error);
    assert.equal(reviewed.reviewCycles.length, 2, "a changed shared identity is affirmative even when sets differ");
    assert.equal((await second.prompts()).length, 2);
  });
}
