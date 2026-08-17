import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { createEvidenceState } from "../src/evidence";
import {
  configDigest,
  replaceReviewGateState,
  SESSION_STATE_ENTRY_TYPE,
  SessionStateStore,
} from "../src/session-state";

test("UI preferences do not change review configuration identity", () => {
  const collapsed = normalizeConfig({ enabled: true, ui: { subtasksViewExpanded: false } });
  const expanded = normalizeConfig({ enabled: true, ui: { subtasksViewExpanded: true } });
  assert.equal(configDigest(collapsed), configDigest(expanded));
});
import {
  beginAgentRun,
  createState,
  freezeReviewWindowConfig,
  rememberUserRequest,
  setReviewWindowBaseline,
} from "../src/state";

test("session state round-trips review evidence and associations only for the same conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-state-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, {
      cwd: root,
      capturedAt: "2026-08-16T00:00:00.000Z",
      files: new Map([["tracked.txt", {
        relativePath: "tracked.txt",
        absolutePath: join(root, "tracked.txt"),
        exists: true,
        size: 5,
        mtimeMs: 1,
        sha256: "abc",
        isBinary: false,
        content: "base\n",
      }]]),
    });
    const evidence = createEvidenceState();
    evidence.candidates.set(join(root, "outside.txt"), {
      path: "outside.txt",
      absolutePath: join(root, "outside.txt"),
      sources: ["write:path"],
      exchangeBaselines: new Map([[1, { error: "missing" }]]),
    });
    state.reviewWindow!.evidence = evidence;
    state.reviewWindow!.reviewerSessions.set("reviewer", { adapter: "codex-cli", id: "review-session" });
    state.reviewInProgress = true;
    state.queuedUserInputsDuringReview.push("additional direction");

    const secret = "must-not-be-written-to-session-state";
    const config = normalizeConfig({
      enabled: true,
      decider: {
        id: "reviewer",
        adapter: "generic-cli",
        command: process.execPath,
        env: { PRIVATE_TOKEN: secret },
      },
    });
    freezeReviewWindowConfig(state, config);
    const markers: Array<{ type: string; data: unknown }> = [];
    const store = new SessionStateStore(
      { sessionId: "conversation-a", sessionFile, cwd: root },
      (type, data) => markers.push({ type, data }),
    );
    await store.save(state, {
      waveRoots: ["/tmp/wave-one"],
      groupRoots: ["/tmp/pi-review-execution-one"],
      conflictGate: {
        executionId: "exec-one",
        taskId: "task-one",
        sourceRoot: root,
        paths: ["conflicted.txt"],
        activatedAt: "2026-08-16T00:00:00.000Z",
        manifestPath: "/tmp/pi-review-execution-one/conflict.json",
        reason: "resolve the conflict",
      },
      bundles: [{
        version: 1,
        operationId: "wave-one/task-0",
        waveId: "wave-one",
        taskId: "task-0",
        waveRoot: "/tmp/wave-one",
        expectedRevision: 7,
      }],
    }, state.reviewWindow!.reviewConfig);

    const persistedText = await readFile(store.path, "utf8");
    assert.doesNotMatch(persistedText, new RegExp(secret));
    assert.doesNotMatch(persistedText, /PRIVATE_TOKEN/);
    assert.equal(markers.at(-1)?.type, SESSION_STATE_ENTRY_TYPE);

    const restored = await store.restore(root);
    assert.ok(restored);
    assert.equal(restored.state.reviewInProgress, false, "a restarted process cannot retain in-process ownership");
    assert.deepEqual(restored.state.queuedUserInputsDuringReview, ["additional direction"]);
    assert.equal(restored.state.reviewWindow?.requestHistory[0]?.text, "implement the durable change");
    assert.equal(restored.state.reviewWindow?.baseline?.files.get("tracked.txt")?.content, "base\n");
    assert.equal(restored.state.reviewWindow?.evidence.candidates.get(join(root, "outside.txt"))?.exchangeBaselines.get(1)?.error, "missing");
    assert.equal(restored.state.reviewWindow?.reviewerSessions.get("reviewer")?.id, "review-session");
    assert.equal(restored.execution.bundles[0]?.expectedRevision, 7);
    assert.deepEqual(restored.execution.groupRoots, ["/tmp/pi-review-execution-one"]);
    assert.deepEqual(restored.execution.conflictGate?.paths, ["conflicted.txt"]);

    const target = createState();
    replaceReviewGateState(target, restored.state);
    assert.equal(target.reviewWindow?.id, state.reviewWindow?.id);

    const wrongConversation = new SessionStateStore({ sessionId: "conversation-b", sessionFile, cwd: root });
    await assert.rejects(wrongConversation.restore(root), /different conversation/);
    await assert.rejects(store.restore(join(root, "other")), /does not match resumed cwd/);

    const newSessionFile = join(root, "new-conversation.jsonl");
    await writeFile(newSessionFile, "", "utf8");
    const newConversation = new SessionStateStore({ sessionId: "conversation-c", sessionFile: newSessionFile, cwd: root });
    assert.equal(await newConversation.restore(root), undefined);

    const corrupted = JSON.parse(persistedText) as { state: { reviewsPaused: boolean } };
    corrupted.state.reviewsPaused = !corrupted.state.reviewsPaused;
    await writeFile(store.path, JSON.stringify(corrupted), "utf8");
    await assert.rejects(store.restore(root), /failed its integrity check/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
