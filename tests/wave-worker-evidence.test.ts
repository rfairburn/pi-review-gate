import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { mock } from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { captureWaveBase } from "../src/execution/wave-repository";
import { createWorkerWorktree } from "../src/execution/wave-worktrees";
import { runWaveWorkerLifecycle } from "../src/execution/wave-worker-lifecycle";
import type { ExecutorAdapter, ExecutorRequest } from "../src/execution/types";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { armReviewResponseExchange, beginAgentRun, createState, recordReviewerFeedback, rememberUserRequest, setReviewWindowCheckpointBaseline } from "../src/state";
import { captureWorkerReviewEvidencePolicy } from "../src/execution/review-evidence-policy";
import { effectiveReviewEvidenceSettings } from "../src/config";
import { MAX_OBSERVED_TOOL_EVENTS, recordObservedToolEventEvidence } from "../src/evidence";
import { ParentCheckpointLedger } from "../src/execution/parent-checkpoint-ledger";
import { runReview } from "../src/review";
import { renderSubtaskEventCollapsed, setPiTuiHost } from "../src/message-expansion";

const captureModule = require("../src/capture") as typeof import("../src/capture");
const factory = require("../src/execution/adapters/factory") as typeof import("../src/execution/adapters/factory");
const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env: gitEnv })).stdout.trim();
const task = { title: "Observed SCRIPT", instructions: "Update SCRIPT; REPORT is an independent generator output.", acceptanceCriteria: ["SCRIPT retains the requested content"] };
const reviewer = String.raw`
const fs=require('node:fs'), path=require('node:path'); let prompt='';
process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>prompt+=s); process.stdin.on('end',()=>{
 const root=process.env.PI_REVIEW_GATE_BUNDLE_DIR;
 const review=fs.readdirSync(path.join(root,'reviews')).filter(s=>/^\d+$/.test(s)).sort().at(-1);
 const dir=path.join(root,'reviews',review); const text=p=>fs.readFileSync(path.join(dir,p),'utf8');
 const evidence=JSON.parse(text('evidence.json')); const md=text('evidence.md');
 fs.appendFileSync(process.env.PROOF,JSON.stringify({prompt,evidence,md,request:text('request.md'),patch:text('patch.diff')})+'\n');
 if(process.env.REVIEW_ERROR==='1') { process.exitCode=1; return; }
 const verdict=process.env.REVIEW_NEEDS_CHANGES==='1' && Number(review)<=2 ? 'needs_changes' : 'pass';
 process.stdout.write(JSON.stringify({verdict,summary:'assessed retained evidence',findings:[]}));
});`;
function config(root: string, extra: Record<string, unknown> = {}): ReviewGateConfig {
  return normalizeConfig({ enabled: true, retainBundles: "always",
    youShouldKnow: { enabled: false },
    review: { primaryEnabled: true, subtaskEnabled: true, reviewLandedChanges: true,
      primaryReviewers: [], subtaskReviewers: [{ source: "external", id: "reviewer" }], ...extra },
    externalAgents: {
      executor: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["unused"] } },
      reviewer: { adapter: "generic-cli", command: process.execPath, review: { args: ["-e", reviewer], env: { PROOF: join(root, "proof.jsonl") }, timeoutMs: 10_000 } },
    },
    execution: { maxWorkers: 1, subtaskNotifications: "quiet", workerResources: { worker: { selection: { source: "external", id: "executor" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] }, retryPolicy: { maxRetries: 0, maxSameIncidentRepeats: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false } },
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wave-evidence-"));
  try {
    const source = join(root, "source"); await mkdir(source);
    await git(source, "init", "-q"); await writeFile(join(source, "SCRIPT"), "before\n");
    await git(source, "add", "."); await git(source, "commit", "-qm", "fixture");
    const capture = await captureWaveBase({ cwd: source, waveId: "evidence-wave", artifactDir: root, maxSnapshotBytes: 1_000_000 });
    const worktree = await createWorkerWorktree(capture, "observed");
    return { root, source, capture, worktree, artifactDir: join(capture.waveRoot, "artifacts", "observed") };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
function installAdapter(action: (request: ExecutorRequest, turn: number) => Promise<void>) {
  let turns = 0;
  const feedback: string[] = [];
  const adapter: ExecutorAdapter = {
    kind: "pi-model", toolEventObservability: { mode: "structured", description: "synthetic adapter structured observations" },
    async run(request) {
      feedback.push(request.prompt); await action(request, ++turns);
      return { text: "Implemented SCRIPT; REPORT is independent context, not an observed action.", session: { adapter: "pi-model", id: "synthetic-session" }, stdoutPath: "", stderrPath: "", code: 0, aborted: false, timedOut: false };
    },
  };
  mock.method(factory, "createExecutorAdapter", () => adapter);
  return { turns: () => turns, feedback };
}
async function observedWrite(request: ExecutorRequest, content: string) {
  request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path: "SCRIPT", content } });
  await writeFile(join(request.cwd, "SCRIPT"), content);
  request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path: "SCRIPT", content }, result: "written" });
}
async function proof(root: string): Promise<Array<{ prompt: string; md: string; evidence: { events: unknown[]; toolObservationsTruncated?: boolean; externalObservationRevision?: number; candidates: Array<{ path: string; afterSnapshot?: { content?: string } }> }; request: string; patch: string }>> {
  return (await readFile(join(root, "proof.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

for (const scenario of [
  { mode: "observation", reviewed: false, includeLanded: true, assess: true },
  { mode: "deferred", reviewed: false, includeLanded: true, assess: true },
  { mode: "observation", reviewed: true, includeLanded: true, assess: false },
  { mode: "observation", reviewed: false, includeLanded: false, assess: false },
] as const) {
  test(`Primary tool parent full-ledger landing: ${scenario.mode}, reviewed=${scenario.reviewed}, policy=${scenario.includeLanded}`, async () => {
    const f = await fixture();
    try {
      const cfg = config(f.root, { primaryReviewers: [{ source: "external", id: "reviewer" }], reviewLandedChanges: scenario.includeLanded, evidence: { primaryToolOnly: true } });
      if (scenario.mode === "deferred") cfg.externalAgents!.reviewer!.review!.env = { PROOF: join(f.root, "proof.jsonl"), REVIEW_NEEDS_CHANGES: "1" };
      const state = createState(); rememberUserRequest(state, "Review parent work and required unreviewed landings"); beginAgentRun(state);
      setReviewWindowCheckpointBaseline(state, { kind: "tool", cwd: f.source, capturedAt: new Date().toISOString() });
      const window = state.reviewWindow!;
      for (let index = 0; index < MAX_OBSERVED_TOOL_EVENTS; index++) {
        recordObservedToolEventEvidence({ state: window.evidence, cwd: f.source, selectedRoot: f.source, adapter: "pi-model", stage: "start", toolName: "opaque", toolInput: {} });
      }
      const assess = () => runReview({ cwd: f.source, request: "Assess retained Primary evidence and landing context.", before: window.baseline!, config: cfg, evidence: window.evidence, window });
      const prior = await assess(); assert.ok(prior.result); assert.ok(prior.reviewedBaseline);
      recordReviewerFeedback(state, { result: prior.result, reviewSequence: prior.reviewSequence, source: "automatic", disposition: scenario.mode === "deferred" ? "sent_at_cap" : "sent_for_observation" });
      armReviewResponseExchange(state, prior.reviewedBaseline);
      const active = window.activeExchange!;
      assert.equal(active.reviewResponseMode, scenario.mode);
      assert.equal(active.evidenceEventStart, MAX_OBSERVED_TOOL_EVENTS);
      const { reviewResponseMode: _priorMode, ...priorMetadata } = active;
      const events = structuredClone(window.evidence.events);
      await writeFile(join(f.source, "LANDED"), "unreviewed landing content\n");
      const ledger = new ParentCheckpointLedger({ config: () => cfg, state: () => state, cwd: () => f.source,
        associationsSnapshot: () => { throw new Error("Tool bases must not compose or save checkpoint owners."); }, addActivityContext: () => {},
      });
      await ledger.checkpointParent(window.id, window.baseline, undefined, f.source, ["LANDED"], { taskId: "landing-task" }, { reviewed: scenario.reviewed, detail: scenario.reviewed ? "subtask review passed" : "subtask completed unreviewed" });
      const { reviewResponseMode: landingMode, ...landingMetadata } = active;
      const result = await assess();
      const invocations = await proof(f.root);
      if (scenario.assess) {
        assert.ok(result.result, `required landing assessment was skipped: ${result.noReviewReason}`);
        assert.equal(result.evidenceMethod, "tool-only");
        assert.equal(invocations.length, 2, "an actual reviewer child must assess the landing note");
        assert.match(invocations[1]!.md, /landing-task.*landed without established successful subtask review/);
        assert.match(invocations[1]!.md, /LANDED/);
        assert.match(invocations[1]!.prompt, /landing bookkeeping, not observed tool actions or exact-snapshot certification/);
        assert.equal(landingMode, undefined, "clear only the unchanged-response classification");
      } else {
        assert.equal(result.noReviewReason, "unchanged_review_response");
        assert.equal(invocations.length, 1, "reviewed or excluded landings must not invent another assessment");
        assert.equal(landingMode, scenario.mode);
      }
      assert.deepEqual(landingMetadata, priorMetadata, "keep baseline, exchange offsets, and causal review metadata");
      assert.deepEqual(window.evidence.events, events, "landing bookkeeping must not fabricate or replay tool observations");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const later of ["report", "same-path", "unknown-scope"] as const) {
  test(`actual isolated tool-only lifecycle: ${later} confirmation identity`, async () => {
    const f = await fixture();
    try {
      mock.method(captureModule, "createWorkspaceSnapshot", () => { throw new Error("Direct tool-only must not take a full-root REVIEW-EVIDENCE snapshot"); });
      const adapter = installAdapter(async (request, turn) => {
        assert.ok(turn < 5, "no REPORT-only review churn");
        if (turn === 1 || (turn === 2 && later === "same-path")) await observedWrite(request, `SCRIPT-${turn}\n`);
        if (turn === 2 && later === "unknown-scope") {
          request.onToolObservation?.({ stage: "start", toolName: "opaque", toolInput: { body: "x".repeat(501) } });
        }
        // Independent process: deliberately bypass the observation transport.
        await exec(process.execPath, ["-e", "require('fs').appendFileSync('REPORT','INDEPENDENT-REPORT\\n')"], { cwd: request.cwd });
      });
      const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: true, snapshotFailureFallback: false } }, config: config(f.root) });
      assert.equal(result.status, "accepted");
      assert.equal(result.reviewCycles.length, later === "report" ? 1 : 2);
      assert.equal(adapter.turns(), later === "report" ? 2 : 3);
      const inputs = await proof(f.root);
      assert.equal(inputs[0]!.evidence.candidates.find(c => c.path === "SCRIPT")?.afterSnapshot?.content, "SCRIPT-1\n");
      for (const input of inputs) {
        assert.match(input.prompt, /SCRIPT-1/); assert.match(input.md, /SCRIPT-1|SCRIPT-2/);
        assert.equal(input.evidence.candidates.some(c => c.path === "REPORT"), false);
        assert.doesNotMatch(input.patch, /INDEPENDENT-REPORT/);
        assert.match(input.request, /Tools only/);
      }
      assert.match(adapter.feedback[1]!, /NOT certification of an exact workspace snapshot/);
      assert.notEqual(result.acceptedCommitSha, result.reviewCycles.at(-1)!.candidateCommit, "REPORT confirmation changes landing identity without pretending that tree was reviewed");
      assert.equal(await git(f.capture.repositoryPath, "rev-parse", result.acceptedRef!), result.acceptedCommitSha);
      assert.match(await git(f.capture.repositoryPath, "show", `${result.acceptedCommitSha}:REPORT`), /INDEPENDENT-REPORT/);
      const durable = JSON.parse(await readFile(join(f.artifactDir, "result.json"), "utf8"));
      assert.equal(durable.evidenceMethod, "tool-only"); assert.match(durable.summary, /not exact-snapshot certified/);
    } finally { mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test("full event ledger still invokes a second actual reviewer for a new unknown-scope confirmation observation", async () => {
  const f = await fixture();
  try {
    const adapter = installAdapter(async (request, turn) => {
      assert.ok(turn <= 3, "the second pass must settle without a review loop");
      if (turn === 1) {
        await observedWrite(request, "SCRIPT-FULL-LEDGER\n");
        for (let index = 2; index < MAX_OBSERVED_TOOL_EVENTS; index++) {
          request.onToolObservation?.({ stage: "start", toolName: "opaque", toolInput: {} });
        }
      } else if (turn === 2) {
        request.onToolObservation?.({ stage: "start", toolName: "opaque", toolInput: { body: "x".repeat(501) } });
      }
    });
    const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: true, snapshotFailureFallback: false } }, config: config(f.root) });
    assert.equal(result.status, "accepted", result.error);
    assert.equal(adapter.turns(), 3);
    assert.deepEqual(result.reviewCycles.map(cycle => cycle.verdict), ["pass", "pass"]);
    assert.notEqual(result.reviewCycles[0]!.toolReviewIdentity, result.reviewCycles[1]!.toolReviewIdentity);
    assert.ok(result.reviewCycles[1]!.externalObservationRevision! > result.reviewCycles[0]!.externalObservationRevision!);
    const invocations = await proof(f.root);
    assert.equal(invocations.length, 2, "the real reviewer child must run again, not an empty shared-gate result");
    assert.equal(invocations[0]!.evidence.events.length, MAX_OBSERVED_TOOL_EVENTS);
    assert.deepEqual(invocations[1]!.evidence.events, invocations[0]!.evidence.events, "no synthetic events or replayed observations");
    assert.equal(invocations[1]!.evidence.toolObservationsTruncated, true);
    assert.match(invocations[1]!.md, /additional observations were omitted/);
    assert.equal(invocations[1]!.evidence.candidates.find(candidate => candidate.path === "SCRIPT")?.afterSnapshot?.content, "SCRIPT-FULL-LEDGER\n");
  } finally { mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
});

test("tool-only re-reviews an observed SCRIPT restoration even when the normalized candidate returns to base", async () => {
  const f = await fixture();
  try {
    const adapter = installAdapter(async (request, turn) => {
      if (turn <= 2) await observedWrite(request, turn === 1 ? "SCRIPT-edited\n" : "before\n");
    });
    const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: true, snapshotFailureFallback: false } }, config: config(f.root) });
    assert.equal(result.status, "accepted"); assert.equal(result.reviewCycles.length, 2); assert.equal(adapter.turns(), 3);
    assert.equal(await git(f.capture.repositoryPath, "show", `${result.acceptedCommitSha}:SCRIPT`), "before");
    assert.equal((await proof(f.root))[1]!.evidence.candidates.find(c => c.path === "SCRIPT")?.afterSnapshot?.content, "before\n");
  } finally { mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
});

for (const newUnknownObservation of [false, true]) {
  test(`tool-method correction progress uses canonical unknown-scope revision: ${newUnknownObservation}`, async () => {
    const f = await fixture();
    try {
      const cfg = config(f.root);
      cfg.externalAgents!.reviewer!.review!.env = { PROOF: join(f.root, "proof.jsonl"), REVIEW_NEEDS_CHANGES: "1" };
      installAdapter(async (request, turn) => {
        assert.ok(turn < 5);
        if (turn === 1) await observedWrite(request, "SAME-SCRIPT\n");
        if (turn === 2 && newUnknownObservation) request.onToolObservation?.({ stage: "start", toolName: "opaque", toolInput: { body: "x".repeat(501) } });
        await exec(process.execPath, ["-e", "require('fs').appendFileSync('REPORT','independent\\n')"], { cwd: request.cwd });
      });
      const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: true, snapshotFailureFallback: false } }, config: cfg, maxCorrectionCycles: 3 });
      assert.equal(result.status, newUnknownObservation ? "accepted" : "no_progress");
      assert.equal(result.reviewCycles.length, newUnknownObservation ? 3 : 2);
      if (newUnknownObservation) {
        assert.notEqual(result.reviewCycles[0]!.toolReviewIdentity, result.reviewCycles[1]!.toolReviewIdentity);
        assert.ok(result.reviewCycles[1]!.externalObservationRevision! > result.reviewCycles[0]!.externalObservationRevision!);
      } else {
        // #538: the tool-method repeat is a recoverable no-progress pause with
        // the configured budget disclosed as not exhausted, never a cap claim.
        assert.equal(result.error, "No progress detected.");
        assert.match(result.summary, /assessed the same contribution as the previous review/);
        assert.match(result.summary, /Correction budget not exhausted: 1\/3 used/);
        assert.equal(result.acceptedRef, undefined);
      }
    } finally { mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
}

// A real git diff child fails only the evidence acquisition command. Parent,
// candidate/checkpoint, construction, and landing plumbing remain real.
async function diffRefusal(root: string) {
  const original = (await exec("which", ["git"])).stdout.trim();
  const bin = join(root, "bin"); await mkdir(bin);
  const marker = join(root, "refuse-evidence"); await writeFile(marker, "yes");
  await writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$1" = diff ] && [ "$2" = --name-only ] && [ "$3" = -z ] && [ "$4" = --no-renames ] && [ -f '${marker}' ]; then exec '${process.execPath}' -e "process.stdout.write('x'.repeat(70*1024*1024))"; fi\nexec '${original}' "$@"\n`); await chmod(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return marker;
}
for (const fallback of [false, true]) {
  test(`actual isolated diff acquisition failure: fallback ${fallback ? "On" : "Off"}`, { skip: process.platform === "win32" }, async () => {
    const f = await fixture(); const oldPath = process.env.PATH;
    try {
      await diffRefusal(f.root);
      const adapter = installAdapter(async (request, turn) => { if (turn === 1) await observedWrite(request, "CURRENT-SCRIPT\n"); });
      const warnings: string[] = [];
      const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: false, snapshotFailureFallback: fallback } }, config: config(f.root), onUpdate: update => { if (update.reviewEvidenceWarning) warnings.push(update.reviewEvidenceWarning.message); } });
      if (!fallback) {
        assert.equal(result.status, "review_error"); assert.equal(result.acceptedRef, undefined); assert.equal(adapter.turns(), 1); assert.equal(warnings.length, 0);
      } else {
        assert.equal(result.status, "accepted_with_warnings"); assert.equal(result.reviewCycles[0]!.reviewOutput.evidenceMethod, "tool-only-fallback");
        assert.equal(warnings.length, 1); assert.match(warnings[0]!, /^WARNING: Isolated worktree/);
        assert.match(result.summary, /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/);
        const input = (await proof(f.root))[0]!; assert.match(input.prompt, /CURRENT-SCRIPT/); assert.match(input.md, /CURRENT-SCRIPT/); assert.match(input.request, /Tools only \(snapshot-failure fallback\)/);
        assert.match(adapter.feedback[1]!, /Tools only \(snapshot-failure fallback\)/);
        const durable = JSON.parse(await readFile(join(f.artifactDir, "result.json"), "utf8"));
        assert.equal(durable.evidenceMethod, "tool-only-fallback"); assert.match(durable.summary, /WARNING: Isolated worktree/);
      }
    } finally { process.env.PATH = oldPath; mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const restoreCapture of [false, true]) {
test(`snapshot-preferring worker ${restoreCapture ? "recovers snapshot" : "warns on each fallback"} for new SCRIPT content`, { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); const oldPath = process.env.PATH;
  try {
    const marker = await diffRefusal(f.root);
    installAdapter(async (request, turn) => {
      if (turn <= 2) await observedWrite(request, `CURRENT-${turn}\n`);
      if (turn === 2 && restoreCapture) await rm(marker);
    });
    const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: false, snapshotFailureFallback: true } }, config: config(f.root) });
    assert.equal(result.status, restoreCapture ? "accepted" : "accepted_with_warnings");
    assert.deepEqual(result.reviewCycles.map(c => c.reviewOutput.evidenceMethod), ["tool-only-fallback", restoreCapture ? "snapshot" : "tool-only-fallback"]);
    assert.equal(result.summary.split("\n").filter(line => /^WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/.test(line)).length, restoreCapture ? 1 : 2);
    if (restoreCapture) assert.match((await proof(f.root))[1]!.patch, /CURRENT-2/);
  } finally { process.env.PATH = oldPath; mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
});

}

for (const reviewed of [false, true]) {
  test(`real Start/Add land with Primary tool basis and ${reviewed ? "reviewed" : "unreviewed"} worker bookkeeping`, async () => {
    const f = await fixture(); let controller: BackgroundExecutionController | undefined;
    try {
      const cfg = config(f.root, { subtaskEnabled: reviewed, evidence: { primaryToolOnly: true, worktreeToolOnly: reviewed, inplaceToolOnly: false } });
      const state = createState(); rememberUserRequest(state, "start and add tasks"); beginAgentRun(state);
      setReviewWindowCheckpointBaseline(state, { kind: "tool", cwd: f.source, capturedAt: new Date().toISOString() });
      // Do not make a new observed write on every confirmation.
      let requests = 0;
      installAdapter(async request => { if (++requests % (reviewed ? 2 : 1) === 1 || !reviewed) await observedWrite(request, "SCRIPT-controller\n"); });
      const warnings: string[] = [];
      controller = new BackgroundExecutionController({ config: cfg, state, cwd: () => f.source, pi: {}, notify: message => { warnings.push(message); } });
      const started = await controller.start([task]);
      const wait = async (taskId: string) => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const current = controller!.inspect(started.executionId, taskId).tasks[0]!;
          if (current.state === "landed") return current;
          assert.ok(!["failed", "paused_recoverable"].includes(current.state), JSON.stringify(current));
          assert.ok(Date.now() < deadline, "controller fixture deadline"); await new Promise(done => setTimeout(done, 20));
        }
      };
      const first = await wait(started.tasks[0]!.taskId);
      assert.equal(first.result?.taskResults[0]?.status, reviewed ? "accepted" : "completed_unreviewed");
      // Add must produce a different candidate, not a no-op tree.
      mock.restoreAll(); let addTurn = 0; installAdapter(async request => { if (++addTurn === 1) await observedWrite(request, "SCRIPT-added\n"); });
      const added = await controller.add(started.executionId, [task]); await wait(added.tasks.at(-1)!.taskId);
      assert.equal(state.reviewWindow?.baseline?.kind, "tool");
      assert.ok(warnings.every(w => !w.includes("Legacy Git parent baseline")));
      if (!reviewed) { assert.equal(state.reviewWindow!.evidence.requiresReview, true); assert.match(state.reviewWindow!.evidence.reviewEvidenceNotes!.join(" "), /landing bookkeeping, not observed tool actions/); }
    } finally { await controller?.shutdown(); mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const landing of ["landed", "conflicted"] as const) {
test(`actual fallback is always-on UI and final ${landing} model outcome in Quiet mode with optional notices Off`, { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); const oldPath = process.env.PATH; let controller: BackgroundExecutionController | undefined;
  try {
    const marker = await diffRefusal(f.root);
    const cfg = config(f.root, { evidence: { primaryToolOnly: true, snapshotFailureFallback: true } });
    const state = createState(); rememberUserRequest(state, "run fallback worker"); beginAgentRun(state);
    setReviewWindowCheckpointBaseline(state, { kind: "tool", cwd: f.source, capturedAt: new Date().toISOString() });
    installAdapter(async (request, turn) => {
      if (turn === 1) await observedWrite(request, "CURRENT-CONTROLLER\n");
      else {
        await rm(marker, { force: true });
        if (landing === "conflicted") await writeFile(join(f.source, "SCRIPT"), "CONCURRENT-SOURCE\n");
      }
    });
    const ui: string[] = []; const model: Array<{ content?: unknown }> = [];
    controller = new BackgroundExecutionController({ config: cfg, state, cwd: () => f.source,
      pi: { sendMessage: (message: { content?: unknown }) => model.push(message) }, notify: message => { ui.push(message); } });
    const started = await controller.start([task]); const id = started.tasks[0]!.taskId;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = controller.inspect(started.executionId, id).tasks[0]!;
      if (current.state === landing) break;
      assert.ok(!["failed", "paused_recoverable"].includes(current.state), JSON.stringify(current));
      assert.ok(Date.now() < deadline, "fallback controller deadline"); await new Promise(done => setTimeout(done, 20));
    }
    const final = controller.inspect(started.executionId, id).tasks[0]!;
    await controller.shutdown();
    assert.equal(ui.filter(w => /^WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/.test(w)).length, 1);
    assert.ok(model.some(message => typeof message.content === "string" && /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/.test(message.content)), "actual completion sent to model carries fallback independent of optional notices");
    assert.match(final.summary ?? "", /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/);
    if (landing === "conflicted") assert.match(await readFile(join(f.source, "SCRIPT"), "utf8"), /CONCURRENT-SOURCE/);
  } finally { await controller?.shutdown(); process.env.PATH = oldPath; mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
});
}

test("real continuation completion snapshot includes fallback in Quiet model delivery and collapsed success rendering", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); const oldPath = process.env.PATH; let controller: BackgroundExecutionController | undefined;
  try {
    const cfg = config(f.root, { evidence: { primaryToolOnly: true, snapshotFailureFallback: true } });
    const state = createState(); rememberUserRequest(state, "continue the worker"); beginAgentRun(state);
    setReviewWindowCheckpointBaseline(state, { kind: "tool", cwd: f.source, capturedAt: new Date().toISOString() });
    let continuing = false; let continuationTurns = 0; let marker: string | undefined;
    installAdapter(async (request, turn) => {
      if (!continuing) { if (turn === 1) await observedWrite(request, "INITIAL-SCRIPT\n"); }
      else if (++continuationTurns === 1) await observedWrite(request, "CONTINUED-SCRIPT\n");
      else if (marker) await rm(marker, { force: true });
    });
    const ui: string[] = []; const model: Array<{ content?: unknown; details?: unknown }> = [];
    controller = new BackgroundExecutionController({ config: cfg, state, cwd: () => f.source,
      pi: { sendMessage: (message: { content?: unknown; details?: unknown }) => model.push(message) }, notify: message => { ui.push(message); } });
    const started = await controller.start([task]); const id = started.tasks[0]!.taskId;
    const wait = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 30_000;
      while (!predicate()) {
        const current = controller!.inspect(started.executionId, id).tasks[0]!;
        assert.ok(!["failed", "paused_recoverable", "conflicted"].includes(current.state), JSON.stringify(current));
        assert.ok(Date.now() < deadline, label); await new Promise(done => setTimeout(done, 20));
      }
    };
    await wait(() => model.some(message => typeof message.content === "string" && message.content.startsWith(`Task ${id} landed independently`)), "initial completion delivery");
    marker = await diffRefusal(f.root); continuing = true; model.length = 0; ui.length = 0;
    const admissionDeadline = Date.now() + 30_000;
    for (;;) {
      try {
        await controller.continueTask({ executionId: started.executionId, taskId: id, instructions: "CONTINUE_SCRIPT: update SCRIPT again", instructionId: "continue-evidence-warning", actor: "user" });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/already active/.test(error.message) || Date.now() >= admissionDeadline) throw error;
        await new Promise(done => setTimeout(done, 20));
      }
    }
    await wait(() => model.some(message => typeof message.content === "string" && message.content.startsWith(`Task ${id} continuation landed.`)), "continuation completion delivery");
    const delivered = model.find(message => typeof message.content === "string" && message.content.startsWith(`Task ${id} continuation landed.`))!;
    assert.match(delivered.content as string, /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/);
    assert.equal(ui.filter(message => /^WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/.test(message)).length, 1);
    setPiTuiHost({ wrapTextWithAnsi: (text: string) => text.split("\n") });
    const card = renderSubtaskEventCollapsed(delivered, {}, { bold: (text: string) => text, fg: (_color: string, text: string) => text }) as { render(width: number): string[] };
    assert.match(card.render(1000).join("\n"), /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/);
    assert.match(await readFile(join(f.source, "SCRIPT"), "utf8"), /CONTINUED-SCRIPT/);
    assert.match(controller.inspect(started.executionId, id).tasks[0]!.summary ?? "", /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/);
    assert.match((await proof(f.root)).at(-1)!.prompt, /CONTINUED-SCRIPT/);
  } finally { await controller?.shutdown(); process.env.PATH = oldPath; mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
});

for (const negative of ["reviewer", "candidate", "normalized-candidate", "checkpoint", "cancel", "unknown-acquisition", "construction"] as const) {
  test(`fallback On never rescues ${negative} failure in actual worker lifecycle`, { skip: process.platform === "win32" && ["reviewer", "candidate", "normalized-candidate", "checkpoint", "unknown-acquisition"].includes(negative) }, async () => {
    const f = await fixture(); const oldPath = process.env.PATH;
    try {
      const cfg = config(f.root);
      const abort = new AbortController();
      if (["reviewer", "candidate", "normalized-candidate"].includes(negative)) await diffRefusal(f.root);
      if (negative === "reviewer") cfg.externalAgents!.reviewer!.review!.env = { PROOF: join(f.root, "proof.jsonl"), REVIEW_ERROR: "1" };
      if (negative === "construction") {
        // An unusable managed worktree is construction/integrity failure, not
        // evidence acquisition. No branch or ownership metadata is changed.
        await rm(join(f.worktree.worktreeRoot, ".git"));
      }
      if (negative === "unknown-acquisition") {
        const original = (await exec("which", ["git"])).stdout.trim(); const bin = join(f.root, "bin"); await mkdir(bin);
        await writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$1" = diff ] && [ "$2" = --binary ]; then exit 73; fi\nexec '${original}' "$@"\n`); await chmod(join(bin, "git"), 0o755); process.env.PATH = `${bin}:${oldPath}`;
      }
      installAdapter(async (request, turn) => {
        if (turn === 1) await observedWrite(request, "CURRENT-NEGATIVE\n");
        if (negative === "normalized-candidate" && turn === 2) await writeFile(join(request.cwd, "REPORT"), "unobserved addition\n");
        if (negative === "checkpoint") await symlink("../unlandable-outside", join(request.cwd, "escape-link"));
        if (negative === "cancel") abort.abort();
        if (negative === "candidate" && turn === 2) await git(f.capture.repositoryPath, "update-ref", `refs/pi-review-gate/waves/${f.capture.waveId}/review-candidates/observed/cycle-000001`, f.capture.baseCommit);
      });
      let completions = 0;
      let result: Awaited<ReturnType<typeof runWaveWorkerLifecycle>> | undefined;
      let thrown: unknown;
      try {
        result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: { scope: "worktree", toolOnly: false, snapshotFailureFallback: true } }, config: cfg, signal: abort.signal,
          onUpdate: update => {
            if (negative === "normalized-candidate" && update.phase === "completing" && ++completions === 2) {
              const operation = JSON.parse(readFileSync(join(f.artifactDir, "operation.json"), "utf8"));
              execFileSync("git", ["update-ref", operation.checkpoint.ref, f.capture.baseCommit], { cwd: f.capture.repositoryPath, env: gitEnv });
            }
          },
        });
      } catch (error) { thrown = error; }
      assert.ok(thrown || result, "must produce a blocking outcome");
      assert.equal(result?.acceptedRef, undefined);
      assert.ok(thrown || ["review_error", "executor_error", "cancelled"].includes(result!.status), result?.status);
      if (["reviewer", "candidate", "normalized-candidate"].includes(negative)) assert.match(result!.summary, /WARNING: Isolated worktree.*Tools only \(snapshot-failure fallback\)/);
    } finally { process.env.PATH = oldPath; mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const worktreeToolOnly of [false, true]) {
  test(`actual worktree consumer ignores opposite Primary/InPlace toggles: ${worktreeToolOnly}`, async () => {
    const f = await fixture();
    try {
      const cfg = config(f.root, { evidence: { primaryToolOnly: !worktreeToolOnly, worktreeToolOnly, inplaceToolOnly: !worktreeToolOnly } });
      installAdapter(async (request, turn) => { if (turn === 1) await observedWrite(request, "SCOPED-SCRIPT\n"); });
      const policy = captureWorkerReviewEvidencePolicy(effectiveReviewEvidenceSettings(cfg), "execute");
      const result = await runWaveWorkerLifecycle({ ...f, sourceRoot: f.source, taskId: "observed", task: { ...task, reviewEvidencePolicy: policy }, config: cfg });
      assert.equal(result.status, "accepted"); assert.equal(result.reviewCycles[0]!.reviewOutput.evidenceMethod, worktreeToolOnly ? "tool-only" : "snapshot");
    } finally { mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const primaryToolOnly of [false, true]) for (const worktreeToolOnly of [false, true]) for (const inplaceToolOnly of [false, true]) {
  test(`scope isolation ${primaryToolOnly}/${worktreeToolOnly}/${inplaceToolOnly}`, () => {
    const settings = effectiveReviewEvidenceSettings(normalizeConfig({ review: { evidence: { primaryToolOnly, worktreeToolOnly, inplaceToolOnly } } }));
    assert.equal(captureWorkerReviewEvidencePolicy(settings, "execute").toolOnly, worktreeToolOnly);
    assert.equal(captureWorkerReviewEvidencePolicy(settings, "inplace").toolOnly, inplaceToolOnly);
  });
}
