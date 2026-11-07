/**
 * #617: a recovered Tool -> checkpoint basis is persisted by onInvocationPrepared
 * before the first reviewer launch. An actual invocation cancellation must keep
 * the actual aborted result and leave that durable owner in place; a later save
 * failure must not turn the last acknowledged sidecar into a dangling reference.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionPersistence } from "../src/activation/persistence";
import {
  captureObservedToolPathAfterStates,
  recordObservedToolEventEvidence,
  recordToolCallEvidence,
  recordToolResultEvidence,
} from "../src/evidence";
import { loadReviewCheckpoint } from "../src/review-checkpoint";
import { runReview } from "../src/review";
import { SessionStateStore } from "../src/session-state";
import {
  beginAgentRun,
  createState,
  hasUnresolvedReview,
  recordReviewerFeedback,
  rememberUserRequest,
  setReviewWindowCheckpointBaseline,
  type ReviewBaseline,
} from "../src/state";
import { disposableAgentDir, testCheckpointScope } from "./checkpoint-scope-helpers";
import { fakeNeedsChangesConfig } from "./helpers";

test("a recovered checkpoint persisted before invocation survives cancellation and a failed later save", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prg-recovery-persistence-"));
  const repo = join(root, "repo");
  const sessionFile = join(root, "conversation.jsonl");
  const sessionId = "recovery-persistence";
  const scope = testCheckpointScope(disposableAgentDir(), sessionId);
  const config = { ...fakeNeedsChangesConfig(), retainBundles: "always" as const };
  let bundleDir: string | undefined;
  try {
    await mkdir(repo);
    await writeFile(sessionFile, "");
    await writeFile(join(repo, "index.ts"), "before\n");
    const state = createState();
    state.checkpointScope = scope;
    rememberUserRequest(state, "recover retained tool evidence");
    beginAgentRun(state);
    const toolBaseline: ReviewBaseline = { kind: "tool", cwd: repo, capturedAt: new Date().toISOString() };
    setReviewWindowCheckpointBaseline(state, toolBaseline);
    const window = state.reviewWindow!;
    window.nextReviewSequence = 2;
    recordReviewerFeedback(state, {
      result: { reviewerId: "gate", verdict: "needs_changes", summary: "an earlier review left this work unresolved", findings: [] },
      source: "automatic",
      disposition: "sent_for_correction",
      reviewSequence: 1,
    });
    assert.equal(hasUnresolvedReview(window), true);
    const snapshotOptions = { maxFileBytes: config.maxFileBytes, maxSnapshotBytes: config.maxSnapshotBytes };
    const write = { toolName: "write", toolInput: { path: "index.ts", content: "after\n" } };
    const exchangeSequence = window.activeExchange!.sequence;
    await recordToolCallEvidence({ state: window.evidence, cwd: repo, ...write, snapshotOptions, exchangeSequence });
    recordObservedToolEventEvidence({ state: window.evidence, cwd: repo, selectedRoot: repo, adapter: "pi-model", stage: "start", ...write });
    await writeFile(join(repo, "index.ts"), "after\n");
    recordObservedToolEventEvidence({ state: window.evidence, cwd: repo, selectedRoot: repo, adapter: "pi-model", stage: "end", ...write, result: "written" });
    recordToolResultEvidence({ state: window.evidence, ...write, result: { content: [{ type: "text", text: "Wrote index.ts" }] }, exchangeSequence });
    await captureObservedToolPathAfterStates(window.evidence, repo, snapshotOptions);

    const store = new SessionStateStore({ sessionId, sessionFile, cwd: repo });
    const persistence = createSessionPersistence({
      pi: {},
      state,
      isSessionActive: () => true,
      associations: () => ({ waveRoots: [], bundles: [] }),
      reviewConfig: () => config,
    });
    persistence.bindStore(store);
    const controller = new AbortController();
    let preparedSaves = 0;
    const output = await runReview({
      cwd: repo,
      checkpointScope: scope,
      request: "review recovered work",
      before: toolBaseline,
      config,
      evidence: window.evidence,
      window,
      signal: controller.signal,
      evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" },
      onInvocationPrepared: async () => {
        assert.equal(await persistence.persistConfirmed(), true, "the recovered basis is durably acknowledged before reviewer launch");
        preparedSaves += 1;
        // Cancellation wins only after the recovered descriptor is durably
        // referenced by the sidecar and the invocation may have started.
        controller.abort("manual");
      },
    });
    bundleDir = output.bundleDir;
    assert.equal(preparedSaves, 1);
    assert.equal(output.result?.error, "aborted");
    assert.ok(output.bundleDir, "the actual invocation cancellation keeps its real bundle reference");
    const invocationDir = join(output.bundleDir!, "reviews", "0002");
    assert.ok(output.changes.some((change) => change.path === "index.ts"), "the actual aborted result retains its reviewed changes");
    const tombstone = JSON.parse(await readFile(join(invocationDir, "canceled.json"), "utf8")) as {
      processSettlement?: string;
      diagnostic?: string;
    };
    assert.equal(output.result?.processSettlement, tombstone.processSettlement);
    assert.equal(output.result?.diagnostic, tombstone.diagnostic);
    assert.equal(window.baseline?.kind, "checkpoint");
    assert.equal(window.activeExchange, undefined, "the completed pre-review exchange was settled normally");
    assert.equal(hasUnresolvedReview(window), true, "no fabricated pass resolves the outstanding review");
    assert.equal(window.reviewHistory.length, 1);
    assert.equal(window.reviewHistory.some((entry) => entry.verdict === "pass"), false);

    const saved = await store.restore(repo, scope);
    assert.ok(saved);
    const savedBaseline = saved.state.reviewWindow?.baseline;
    assert.equal(savedBaseline?.kind, "checkpoint");
    if (!savedBaseline || savedBaseline.kind !== "checkpoint") throw new Error("expected a persisted recovered checkpoint baseline");
    assert.equal((await loadReviewCheckpoint(repo, savedBaseline.descriptor, { scope })).status, "ok", "the acknowledged owner is loadable");
    assert.equal(hasUnresolvedReview(saved.state.reviewWindow), true);
    assert.ok(saved.state.reviewWindow?.evidence.candidates.has(join(repo, "index.ts")), "retained evidence survives the acknowledged save");

    // A save admitted after the cancellation fails before its durable write.
    // The last acknowledged sidecar must remain authoritative and intact.
    let saveCalls = 0;
    const failingSave = t.mock.method(store, "save", async () => {
      saveCalls += 1;
      throw new Error("fixture subsequent save failure");
    });
    await assert.rejects(persistence.persist(), /fixture subsequent save failure/);
    assert.equal(saveCalls, 1);
    const reloaded = await store.restore(repo, scope);
    assert.ok(reloaded);
    const reloadedBaseline = reloaded.state.reviewWindow?.baseline;
    assert.equal(reloadedBaseline?.kind, "checkpoint");
    if (!reloadedBaseline || reloadedBaseline.kind !== "checkpoint") throw new Error("expected the last durable checkpoint baseline");
    assert.deepEqual(reloadedBaseline.descriptor, savedBaseline.descriptor, "the failed save does not replace the last durable owner");
    assert.equal((await loadReviewCheckpoint(repo, reloadedBaseline.descriptor, { scope })).status, "ok", "a failed later save never releases the durable recovered owner");
    assert.equal(hasUnresolvedReview(reloaded.state.reviewWindow), true);
    assert.equal(reloaded.state.reviewWindow?.reviewHistory.some((entry) => entry.verdict === "pass"), false);
    assert.ok(reloaded.state.reviewWindow?.evidence.candidates.has(join(repo, "index.ts")));

    // Restoring the real store shows the same owner remains safely persistable
    // under normal window ownership once persistence is repaired.
    failingSave.mock.restore();
    await persistence.persist();
    const continued = await store.restore(repo, scope);
    assert.ok(continued);
    const continuedBaseline = continued.state.reviewWindow?.baseline;
    assert.equal(continuedBaseline?.kind, "checkpoint");
    if (!continuedBaseline || continuedBaseline.kind !== "checkpoint") throw new Error("expected continued checkpoint ownership");
    assert.deepEqual(continuedBaseline.descriptor, savedBaseline.descriptor);
    assert.equal((await loadReviewCheckpoint(repo, continuedBaseline.descriptor, { scope })).status, "ok");
    assert.equal(hasUnresolvedReview(continued.state.reviewWindow), true);
  } finally {
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
