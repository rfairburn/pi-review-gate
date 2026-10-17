import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import test, { type TestContext } from "node:test";
import * as capture from "../src/capture";
import { normalizeConfig, resolvedExecutorPool } from "../src/config";
import { MAX_OBSERVED_TOOL_EVENTS } from "../src/evidence";
import { runInplaceLifecycle, type InPlaceLifecycleInput, type InPlaceLifecycleResult } from "../src/execution/inplace-worker";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import { buildInPlaceCompletionLines } from "../src/execution/inplace-task-lifecycle";
import { ReviewEvidenceCaptureFailure } from "../src/review-evidence";
import type { ExecutorAdapter, ExecutorRequest } from "../src/execution/types";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { createState } from "../src/state";
import { runReview } from "../src/review";

const scriptContent = "#!/bin/sh\nprintf 'actual retained SCRIPT body 303'\\n\n";
const sandboxEnvironment = ["HOME", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "GIT_CEILING_DIRECTORIES"] as const;

/** One positively owned allocation contains fixtures AND separately allocated
 * retained bundles/controller recovery roots. Never sweep the shared temp dir. */
async function allocateSandbox(afterSetup?: (root: string) => Promise<void>) {
  const base = resolve(".tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "inplace-tool-303-"));
  const prior = sandboxEnvironment.map((key) => [key, process.env[key]] as const);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  };
  try {
    const home = join(root, "home"), tmp = join(root, "tmp"), agent = join(root, "agent");
    await mkdir(home); await mkdir(tmp); await mkdir(agent);
    process.env.HOME = home;
    process.env.TMPDIR = tmp; process.env.TMP = tmp; process.env.TEMP = tmp;
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.GIT_CEILING_DIRECTORIES = root;
    await afterSetup?.(root);
    return { root, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
type Sandbox = Awaited<ReturnType<typeof allocateSandbox>>;
const sandboxes = new WeakMap<TestContext, Sandbox>();

async function fixture(t: TestContext, options: { toolOnly?: boolean; fallback?: boolean; verdicts?: string[] } = {}, owned?: Sandbox) {
  let sandbox = owned ?? sandboxes.get(t);
  if (!sandbox) {
    sandbox = await allocateSandbox();
    sandboxes.set(t, sandbox);
    const allocated = sandbox;
    // Controller finally blocks settle children before this hook removes artifacts.
    t.after(() => allocated.dispose());
  }
  const root = await mkdtemp(join(sandbox.root, "fixture-"));
  const workspaceRoot = join(root, "workspace"), artifactDir = join(root, "artifacts"), prompts = join(root, "prompts.jsonl");
  await mkdir(workspaceRoot); await mkdir(artifactDir);
  await writeFile(join(workspaceRoot, "SCRIPT"), "old script\n");
  const reviewer = `const fs=require('node:fs');let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{const f=${JSON.stringify(prompts)};const n=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\\n').length:0;fs.appendFileSync(f,JSON.stringify(p)+'\\n');process.stdout.write(JSON.stringify({verdict:(${JSON.stringify(options.verdicts ?? ["pass"])})[n]||'pass',summary:'real reviewer fixture',findings:[]}));});`;
  const liveToolOnly = !(options.toolOnly ?? true); // Deliberately opposite the captured task policy in every scope.
  const config = normalizeConfig({ enabled: true, retainBundles: "always", maxCorrectionCycles: 4,
    review: { primaryReviewers: [{ source: "external", id: "reviewer" }], subtaskReviewers: [{ source: "external", id: "reviewer" }],
      evidence: { primaryToolOnly: liveToolOnly, worktreeToolOnly: liveToolOnly, inplaceToolOnly: liveToolOnly, snapshotFailureFallback: !(options.fallback ?? false) } },
    externalAgents: {
      reviewer: { adapter: "generic-cli", command: process.execPath, review: { args: ["-e", reviewer], timeoutMs: 10000 } },
      executor: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    }, execution: { workerResources: { worker: { selection: { source: "external", id: "executor" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] }, retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 0 } },
  });
  const warnings: string[] = [];
  const requests: string[] = [];
  let turn = 0;
  let action: (request: ExecutorRequest, turn: number) => Promise<void> = async (request, n) => {
    await writeFile(join(workspaceRoot, `REPORT-${n}`), "independent report writer\n");
    if (n === 1) await edit(request, scriptContent);
  };
  async function edit(request: ExecutorRequest, body: string) {
    request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: join(workspaceRoot, "SCRIPT") } });
    await writeFile(join(workspaceRoot, "SCRIPT"), body);
    request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: join(workspaceRoot, "SCRIPT") }, result: "written" });
  }
  const adapter: ExecutorAdapter = { kind: "pi-model", toolEventObservability: { mode: "structured", description: "bounded test observations" },
    async run(request) {
      requests.push(request.prompt); await action(request, ++turn);
      return { text: `Worker claim turn ${turn}`, session: { adapter: "pi-model", id: "session" }, stdoutPath: "", stderrPath: "", code: 0, timedOut: false, aborted: false };
    },
  };
  const input: InPlaceLifecycleInput = { taskId: "tool-evidence-303", workspaceRoot, artifactDir, config,
    task: { title: "SCRIPT task", instructions: "Change SCRIPT; REPORT files are independent writer output.", acceptanceCriteria: ["SCRIPT is changed"],
      reviewEvidencePolicy: { toolOnly: options.toolOnly ?? true, snapshotFailureFallback: options.fallback ?? false, scope: "inplace" } },
    executorAssignment: { entry: resolvedExecutorPool(config)[0]!, priority: 0 }, adapterFactory: () => adapter,
    onEvidenceWarning: (message) => { warnings.push(message); },
  };
  return { root, sandbox, workspaceRoot, artifactDir, prompts, input, warnings, requests, edit,
    setAction(next: typeof action) { action = next; },
    async captured() { return (await readFile(prompts, "utf8")).trim().split("\n").map((p) => JSON.parse(p) as string); },
  };
}

async function assertContent(result: InPlaceLifecycleResult, marker = "actual retained SCRIPT body 303") {
  const output = result.reviewCycles[0]!.reviewOutput;
  for (const file of ["evidence.json", "evidence.md"]) {
    const body = await readFile(join(output.invocationDir!, file), "utf8");
    assert.ok(body.includes(marker), `${file} retains actual SCRIPT content`);
    assert.ok(!body.includes("independent report writer"), `${file} does not turn unrelated REPORT content into evidence`);
  }
}

test("owned scratch restores environment and removes failed setup and retained reviewer bundles", async (t) => {
  const before = sandboxEnvironment.map((key) => process.env[key]);
  let failedRoot: string | undefined;
  await assert.rejects(allocateSandbox(async (root) => { failedRoot = root; throw new Error("setup fault after allocation"); }), /setup fault/);
  assert.ok(failedRoot);
  assert.equal(existsSync(failedRoot), false);
  assert.deepEqual(sandboxEnvironment.map((key) => process.env[key]), before);
  for (const verdict of ["pass", "error"]) {
    const owned = await allocateSandbox();
    let bundle: string | undefined;
    try {
      const f = await fixture(t, { verdicts: [verdict] }, owned);
      const result = await runInplaceLifecycle(f.input);
      assert.equal(result.status, verdict === "pass" ? "reviewed" : "review_error");
      bundle = result.reviewCycles[0]!.reviewOutput.bundleDir;
      assert.ok(bundle && existsSync(bundle));
      const rel = relative(owned.root, bundle);
      assert.ok(!isAbsolute(rel) && !rel.startsWith(".."), "retained reviewer bundle lives inside the owned scratch root");
    } finally { await owned.dispose(); }
    assert.equal(existsSync(owned.root), false);
    assert.ok(bundle && !existsSync(bundle));
    assert.deepEqual(sandboxEnvironment.map((key) => process.env[key]), before);
  }
});

test("production tool-only InPlace omits every whole-root snapshot and retains SCRIPT in actual reviewer channels; REPORT confirmation does not churn", async (t) => {
  const f = await fixture(t);
  let captures = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { captures++; throw new Error("whole-root capture forbidden"); });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(captures, 0); assert.equal(result.baseline.mode, "tool"); assert.equal(result.baseline.snapshot, undefined);
  assert.equal(result.reviewCycles.length, 1); assert.equal(f.requests.length, 2);
  assert.equal(result.evidenceMethod, "tool-only");
  const basis = JSON.parse(await readFile(join(f.artifactDir, "baseline.json"), "utf8"));
  assert.equal(basis.mode, "tool"); assert.equal(basis.files, undefined);
  await assertContent(result);
  assert.ok((await f.captured())[0]!.includes("actual retained SCRIPT body 303"));
  assert.ok(buildInPlaceCompletionLines(result).join("\n").includes("not snapshot-captured"));
});

test("same-path observed SCRIPT rewrite requires a new review even after the bounded ledger fills", async (t) => {
  const f = await fixture(t);
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("forbidden"); });
  f.setAction(async (request, n) => {
    if (n === 1) {
      await f.edit(request, scriptContent);
      for (let i = 0; i < MAX_OBSERVED_TOOL_EVENTS + 2; i++) request.onToolObservation?.({ stage: "start", toolName: "read", toolInput: {} });
    }
    if (n === 2) await f.edit(request, "new SCRIPT after first pass\n");
    await writeFile(join(f.workspaceRoot, `REPORT-${n}`), "independent");
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(result.reviewCycles.length, 2);
  assert.ok(result.reviewCycles[1]!.toolObservationRevision! > result.reviewCycles[0]!.toolObservationRevision!);
  assert.ok((await f.captured())[1]!.includes("new SCRIPT after first pass"), "new same-path content reaches the second reviewer despite event retention overflow");
});

test("path-free observed shell rewrite during confirmation reaches a second ordinary review with updated SCRIPT content", async (t) => {
  const f = await fixture(t);
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("tool-only whole-root capture forbidden"); });
  const code = "require('fs').writeFileSync('SCRIPT','changed by path-free command')";
  const command = `node -e ${JSON.stringify(code)}`;
  f.setAction(async (request, n) => {
    if (n === 1) await f.edit(request, scriptContent);
    if (n === 2) {
      request.onToolObservation?.({ stage: "start", toolName: "bash", toolInput: { command } });
      execFileSync(process.execPath, ["-e", code], { cwd: f.workspaceRoot, timeout: 5000 });
      request.onToolObservation?.({ stage: "end", toolName: "bash", toolInput: { command }, result: "completed" });
    }
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(result.reviewCycles.length, 2);
  assert.equal(result.reviewCycles[0]!.toolObservationRevision, result.reviewCycles[1]!.toolObservationRevision, "the shell command has no extracted mutation path");
  assert.equal(result.reviewCycles[0]!.externalObservationRevision, result.reviewCycles[1]!.externalObservationRevision);
  const secondPrompt = (await f.captured())[1]!;
  assert.ok(secondPrompt.includes("writeFileSync"), "new observed command reaches the second reviewer");
  assert.ok(secondPrompt.includes("changed by path-free command"));
  const evidence = JSON.parse(await readFile(join(result.reviewCycles[1]!.reviewOutput.invocationDir!, "evidence.json"), "utf8"));
  assert.ok(evidence.candidates.some((candidate: { afterSnapshot?: { content?: string } }) => candidate.afterSnapshot?.content === "changed by path-free command"), "after-content capture was not suppressed by unchanged path revisions");
});

test("known read-only confirmation observations alone do not churn a tool-only pass", async (t) => {
  const f = await fixture(t);
  f.setAction(async (request, n) => {
    if (n === 1) await f.edit(request, scriptContent);
    else request.onToolObservation?.({ stage: "end", toolName: "read", toolInput: { path: "SCRIPT" }, result: scriptContent });
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(result.reviewCycles.length, 1);
});

test("unknown scope advances external revision beyond a full event ledger and invalidates a tool-only pass", async (t) => {
  const f = await fixture(t);
  f.setAction(async (request, n) => {
    if (n === 1) for (let i = 0; i < MAX_OBSERVED_TOOL_EVENTS + 1; i++) request.onToolObservation?.({ stage: "start", toolName: "read", toolInput: {} });
    if (n === 2) request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "x".repeat(100000) } });
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(result.reviewCycles.length, 2);
  assert.ok(result.reviewCycles[1]!.externalObservationRevision! > result.reviewCycles[0]!.externalObservationRevision!);
});

test("valid empty/binary event stream permits honest degraded review, never no_changes", async (t) => {
  const f = await fixture(t);
  f.setAction(async () => undefined);
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(result.reviewCycles.length, 1);
  assert.match((await f.captured())[0]!, /No structured tool observations|not proof of no effects/);
});

test("snapshot default shares one frozen attribution/reviewer pair and keeps ordinary workspace-diff scope", async (t) => {
  const f = await fixture(t, { toolOnly: false });
  const original = capture.createWorkspaceSnapshot;
  let captures = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async (...args: Parameters<typeof original>) => { captures++; return original(...args); });
  f.setAction(async (request, n) => {
    if (n === 1) { await f.edit(request, scriptContent); await writeFile(join(f.workspaceRoot, "REPORT"), "independent report writer\n"); }
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error); assert.equal(result.evidenceMethod, "snapshot");
  assert.equal(captures, 3, "launch, attribution, and confirmation only: reviewer never recaptures whole root");
  assert.ok(result.changedSinceLaunch.some((c) => c.path === "REPORT"), "snapshot default still includes concurrent writers");
  const before = result.baseline.snapshot!;
  await assert.rejects(runReview({ cwd: f.workspaceRoot, request: "invalid pair", before, config: f.input.config,
    evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "inplace" },
    preparedSnapshots: { before, after: { ...before, cwd: f.root } },
  }), /invalid prepared snapshot/);
});

test("default-Off first acquisition failure blocks before executor work", async (t) => {
  const f = await fixture(t, { toolOnly: false });
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("injected acquisition fault"); });
  await assert.rejects(runInplaceLifecycle(f.input), ReviewEvidenceCaptureFailure);
  assert.equal(f.requests.length, 0); assert.equal(f.warnings.length, 0);
});

test("production controller fallback warns through originating UI/outcome for success and errors with quiet notifications and YouShouldKnow Off", async (t) => {
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("actual initial/later capture failure"); });
  const priorEnvironment = sandboxEnvironment.map((key) => process.env[key]);
  let owned: Sandbox | undefined;
  const executionRoots: string[] = [];
  for (const verdict of ["pass", "error"]) {
    const f = await fixture(t, { toolOnly: false, fallback: true, verdicts: [verdict] });
    owned = f.sandbox;
    f.input.config.review!.evidence!.inplaceToolOnly = false;
    f.input.config.review!.evidence!.snapshotFailureFallback = true;
    f.input.config.youShouldKnow = { enabled: false, completionGuidance: false };
    f.input.config.execution!.subtaskNotifications = "quiet";
    f.input.config.externalAgents!.executor!.execution!.args = ["-e", "process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'binary claim only'}));});"];
    const ui: string[] = [], model: string[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: unknown }) => {
        const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        model.push(text);
        if (text.includes(verdict === "pass" ? "finished in place" : "stopped before settlement")) complete();
      } },
      config: f.input.config, state: createState(), cwd: () => f.workspaceRoot,
      notify: (message) => { ui.push(message); },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const started = await controller.start([{ title: "fallback origin", instructions: "Return a summary", acceptanceCriteria: ["summary returned"] }], "inplace");
      const rel = relative(f.sandbox.root, started.root);
      assert.ok(!isAbsolute(rel) && !rel.startsWith(".."), "execution recovery root belongs to this invocation's scratch allocation");
      executionRoots.push(started.root);
      await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("controller completion deadline")), 30000); })]);
      const result = controller.inspect(started.executionId).tasks[0]!;
      assert.equal(result.state, verdict === "pass" ? "reported" : "paused_recoverable");
      assert.equal(ui.filter((s) => s.startsWith("WARNING: InPlace")).length, 2, "first baseline and later cycle each emit always-on UI warnings");
      assert.match(model.join("\n"), /WARNING: InPlace snapshot-failure fallback/);
      assert.match(result.summary!, /WARNING: InPlace/);
    } finally {
      if (timer) clearTimeout(timer);
      await controller.shutdown(); await controller.detach();
    }
  }
  assert.ok(owned);
  await owned.dispose();
  assert.equal(existsSync(owned.root), false);
  assert.ok(executionRoots.every((root) => !existsSync(root)), "paused recovery roots are removed only after controller children settle");
  assert.deepEqual(sandboxEnvironment.map((key) => process.env[key]), priorEnvironment);
});

test("enabled initial/later repeated fallback warns on each actual use, preserves SCRIPT, retries each correction, and remains origin-correct in durable outcomes", async (t) => {
  const f = await fixture(t, { toolOnly: false, fallback: true, verdicts: ["needs_changes", "pass"] });
  let captures = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { captures++; throw new Error("injected acquisition fault"); });
  f.setAction(async (request, n) => { if (n < 3) await f.edit(request, scriptContent + `# revision ${n}\n`); });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(captures, 3); assert.equal(f.warnings.length, 3);
  assert.equal(result.reviewCycles.length, 2); assert.equal(result.evidenceMethod, "tool-only-fallback");
  await assertContent(result);
  for (const prompt of await f.captured()) assert.match(prompt, /WARNING: InPlace snapshot-failure fallback/);
  assert.ok(f.requests.slice(1).every((p) => p.includes("WARNING: InPlace")), "implementing model sees fallback, not just telemetry");
  const durable = await readFile(join(f.artifactDir, "result.json"), "utf8");
  assert.match(durable, /tool-only-fallback/); assert.match(durable, /WARNING: InPlace/);
  assert.match(buildInPlaceCompletionLines(result).join("\n"), /WARNING: InPlace/);
});

test("later capture fault default-Off blocks without reviewer approval; enabled fallback preserves existing snapshot basis", async (t) => {
  for (const fallback of [false, true]) {
    const f = await fixture(t, { toolOnly: false, fallback });
    const original = capture.createWorkspaceSnapshot;
    let captures = 0;
    const mocked = t.mock.method(capture, "createWorkspaceSnapshot", async (...args: Parameters<typeof original>) => {
      if (++captures > 1) throw new Error("later acquisition fault");
      return original(...args);
    });
    if (!fallback) await assert.rejects(runInplaceLifecycle(f.input), ReviewEvidenceCaptureFailure);
    else {
      const result = await runInplaceLifecycle(f.input);
      assert.equal(result.status, "reviewed", result.error); assert.equal(result.baseline.mode, "non_git");
      assert.equal(f.warnings.length, 1); await assertContent(result);
    }
    mocked.mock.restore();
  }
});

test("snapshot-preferring continuation retries capture and warns again without losing retained current-work content", async (t) => {
  const f = await fixture(t, { toolOnly: false, fallback: true, verdicts: ["error", "pass"] });
  let captures = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { captures++; throw new Error("repeated acquisition failure"); });
  const stopped = await runInplaceLifecycle(f.input);
  assert.equal(stopped.status, "review_error"); assert.equal(captures, 2);
  f.input.config.review!.evidence!.snapshotFailureFallback = false;
  const resumed = await runInplaceLifecycle({ ...f.input, continuation: { instructions: "Continue with retained work" } });
  assert.equal(resumed.status, "reviewed", resumed.error);
  assert.equal(captures, 3); assert.equal(f.warnings.length, 3);
  assert.equal(resumed.evidenceMethod, "tool-only-fallback");
  await assertContent(resumed);
  assert.ok((await f.captured()).every((p) => p.includes("actual retained SCRIPT body 303")));
});

test("no-observation tool-only history stays reviewable after snapshot recovery and needs_changes", async (t) => {
  const f = await fixture(t, { toolOnly: false, fallback: true, verdicts: ["needs_changes", "pass"] });
  const original = capture.createWorkspaceSnapshot;
  let captures = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async (...args: Parameters<typeof original>) => {
    if (++captures === 1) throw new Error("initial snapshot unavailable");
    return original(...args);
  });
  f.setAction(async (_request, n) => { if (n === 1) await writeFile(join(f.workspaceRoot, "SCRIPT"), "earlier unobserved work\n"); });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "pass"]);
  assert.deepEqual(result.reviewCycles.map((cycle) => cycle.reviewOutput.evidenceMethod), ["tool-only", "snapshot"]);
  assert.equal(result.reviewCycles[1]!.changedSinceLaunch.length, 0, "the subsequent-work snapshot delta really is empty");
  const prompts = await f.captured();
  assert.equal(prompts.length, 2, "correction still reaches an ordinary reviewer");
  assert.ok(prompts.every((prompt) => prompt.includes("Worker claim turn 1")));
  assert.match(prompts[1]!, /subsequent work only/);
  assert.doesNotMatch(result.summary, /No workspace paths changed within the recorded bounded snapshot since launch/);
  const persisted = JSON.parse(await readFile(join(f.artifactDir, "observed-tool-evidence.json"), "utf8"));
  assert.equal(persisted.requiresReview, true);
});

test("an empty snapshot correction still validates unresolved feedback without structured observations", async (t) => {
  const f = await fixture(t, { toolOnly: false, verdicts: ["needs_changes", "pass"] });
  f.setAction(async (_request, n) => {
    if (n === 1) await writeFile(join(f.workspaceRoot, "SCRIPT"), "unobserved edit\n");
    if (n === 2) await writeFile(join(f.workspaceRoot, "SCRIPT"), "old script\n");
  });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.deepEqual(result.reviewCycles.map((cycle) => cycle.verdict), ["needs_changes", "pass"]);
  assert.equal(result.reviewCycles[1]!.changedSinceLaunch.length, 0);
  assert.equal((await f.captured()).length, 2);
});

test("later fallback with a snapshot launch basis refuses settlement after required evidence disappears", async (t) => {
  const f = await fixture(t, { toolOnly: false, fallback: true });
  const original = capture.createWorkspaceSnapshot;
  let captures = 0, publications = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async (...args: Parameters<typeof original>) => {
    if (++captures > 1) throw new Error("later capture unavailable");
    return original(...args);
  });
  setDurableWriteFaultInjectionForTesting(async (stage, path) => {
    if (stage === "after_rename" && path.endsWith("observed-tool-evidence.json") && ++publications === 3) await rm(path);
  });
  try {
    await assert.rejects(runInplaceLifecycle(f.input), /Persisted tool evidence .* is missing/);
    assert.equal(publications, 3, "checkpoint removed after the confirmation turn's publication");
    assert.equal((await f.captured()).length, 1, "a real reviewer ran before evidence loss");
    assert.equal(existsSync(join(f.artifactDir, "result.json")), false, "no reviewed outcome is published without required evidence");
  } finally { setDurableWriteFaultInjectionForTesting(undefined); }
});

test("preferred snapshot recovery starts a subsequent-work baseline and retains earlier tool evidence and coverage disclosure", async (t) => {
  const f = await fixture(t, { toolOnly: false, fallback: true });
  const original = capture.createWorkspaceSnapshot;
  let captures = 0;
  t.mock.method(capture, "createWorkspaceSnapshot", async (...args: Parameters<typeof original>) => {
    if (++captures <= 2) throw new Error("temporary capture failure");
    return original(...args);
  });
  f.setAction(async (request, n) => { if (n <= 3) await f.edit(request, scriptContent + `# turn ${n}\n`); });
  const result = await runInplaceLifecycle(f.input);
  assert.equal(result.status, "reviewed", result.error);
  assert.equal(f.warnings.length, 2); assert.equal(result.reviewCycles.length, 3);
  assert.equal(result.reviewCycles[0]!.reviewOutput.evidenceMethod, "tool-only-fallback");
  assert.equal(result.reviewCycles[1]!.reviewOutput.evidenceMethod, "tool-only");
  assert.equal(result.reviewCycles[2]!.reviewOutput.evidenceMethod, "snapshot");
  assert.match(result.reviewCycles[2]!.reviewOutput.evidenceCoverageNotice!, /subsequent work only/);
  const last = (await f.captured()).at(-1)!;
  assert.ok(last.includes("actual retained SCRIPT body 303")); assert.match(last, /Earlier work has tool-only evidence/);
  const recovery = JSON.parse(await readFile(join(f.artifactDir, "snapshot-recovery", "baseline.json"), "utf8"));
  assert.equal(recovery.toolOnlyHistory, true);
  const recoveryPath = join(f.artifactDir, "snapshot-recovery", "baseline.json");
  const savedRecovery = await readFile(recoveryPath, "utf8");
  await writeFile(recoveryPath, "{corrupt");
  await assert.rejects(runInplaceLifecycle({ ...f.input, continuation: { instructions: "Continue" } }), /could not be read/);
  await writeFile(recoveryPath, savedRecovery);
  await rm(recoveryPath);
  await assert.rejects(runInplaceLifecycle({ ...f.input, continuation: { instructions: "Continue" } }), /recovery snapshot basis is missing/);
});

test("continuation honors captured policy despite live settings change and verifies missing/corrupt/foreign persisted tool basis and evidence", async (t) => {
  const f = await fixture(t, { verdicts: ["error", "pass"] });
  const stopped = await runInplaceLifecycle(f.input);
  assert.equal(stopped.status, "review_error");
  f.input.config.review!.evidence!.inplaceToolOnly = false;
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("live policy must not override admission"); });
  const next = { ...f.input, baseline: stopped.baseline, continuation: { instructions: "Continue the same task" } };
  const basisPath = join(f.artifactDir, "baseline.json"), evidencePath = join(f.artifactDir, "observed-tool-evidence.json");
  const basis = await readFile(basisPath, "utf8"), evidence = await readFile(evidencePath, "utf8");
  await rm(basisPath); await assert.rejects(runInplaceLifecycle(next)); await writeFile(basisPath, basis);
  await writeFile(basisPath, basis.replace("tool-evidence-303", "foreign-task")); await assert.rejects(runInplaceLifecycle(next)); await writeFile(basisPath, basis);
  await rm(evidencePath); await assert.rejects(runInplaceLifecycle(next), /missing/); await writeFile(evidencePath, evidence);
  await writeFile(evidencePath, "{broken"); await assert.rejects(runInplaceLifecycle(next), /restored/); await writeFile(evidencePath, evidence);
  await rm(join(f.artifactDir, "operation.json"));
  await rm(evidencePath); await assert.rejects(runInplaceLifecycle(next), /missing/); await writeFile(evidencePath, evidence);
  await rm(basisPath); await assert.rejects(runInplaceLifecycle(next), /basis is missing/); await writeFile(basisPath, basis);
  const result = await runInplaceLifecycle(next);
  assert.equal(result.status, "reviewed", result.error); assert.equal(result.evidenceMethod, "tool-only");
});

test("required evidence write failure, cancellation and reviewer execution failure never become fallback approval", async (t) => {
  const f = await fixture(t, { fallback: true });
  setDurableWriteFaultInjectionForTesting((stage, path) => {
    if (stage === "before_rename" && path.endsWith("observed-tool-evidence.json")) throw new Error("required evidence publication refused");
  });
  try { await assert.rejects(runInplaceLifecycle(f.input), /required evidence/); }
  finally { setDurableWriteFaultInjectionForTesting(undefined); }
  assert.equal(f.requests.length, 0);
  const cancelled = await fixture(t, { fallback: true });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runInplaceLifecycle({ ...cancelled.input, signal: abort.signal }));
  assert.equal(cancelled.warnings.length, 0);
  const reviewerError = await fixture(t, { toolOnly: false, fallback: true, verdicts: ["error"] });
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("eligible capture fault, not reviewer approval"); });
  const result = await runInplaceLifecycle(reviewerError.input);
  assert.equal(result.status, "review_error"); assert.equal(result.reviewCycles[0]!.verdict, "error");
});

test("tool-only cancellation settlement retains bounded observations without any whole-root capture", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  t.mock.method(capture, "createWorkspaceSnapshot", async () => { throw new Error("whole-root cancellation capture forbidden"); });
  f.setAction(async (request) => { await f.edit(request, scriptContent); abort.abort(); });
  const result = await runInplaceLifecycle({ ...f.input, signal: abort.signal });
  assert.equal(result.status, "cancelled"); assert.equal(result.reviewCycles.length, 0);
  assert.match(result.attributionError!, /not captured under tool-only/);
  assert.match(await readFile(join(f.artifactDir, "observed-tool-evidence.json"), "utf8"), /actual retained SCRIPT body 303/);
});

test("required post-work publication stays blocking, while optional cycle publication/marker failures remain best-effort", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  setDurableWriteFaultInjectionForTesting((stage, path) => {
    if (stage === "before_rename" && path.endsWith("observed-tool-evidence.json") && ++writes === 2) throw new Error("required post-work write fault");
  });
  try {
    const result = await runInplaceLifecycle(f.input);
    assert.equal(result.status, "executor_error"); assert.match(result.error!, /required post-work write fault/); assert.equal(result.reviewCycles.length, 0);
  } finally { setDurableWriteFaultInjectionForTesting(undefined); }
  const optional = await fixture(t);
  setDurableWriteFaultInjectionForTesting((stage, path) => {
    if (stage === "before_rename" && /cycle-\d+\.json(?:\.unpublished)?$/.test(path)) throw new Error("optional cycle publication fault");
  });
  try {
    const result = await runInplaceLifecycle(optional.input);
    assert.equal(result.status, "reviewed", result.error);
    assert.equal(result.reviewReport?.aggregate, "pass");
  } finally { setDurableWriteFaultInjectionForTesting(undefined); }
});
