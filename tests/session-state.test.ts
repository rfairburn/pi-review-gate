import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { WorkspaceSnapshot } from "../src/capture";
import { materializeReviewConfig, normalizeConfig, unresolvedReviewerSelectionsFor, type ReviewGateConfig } from "../src/config";
import { queueModelDelivery } from "../src/durable-delivery";
import { createEvidenceState } from "../src/evidence";
import { armGitCheckpoint } from "../src/git-checkpoint";
import { captureReviewCheckpoint } from "../src/review-checkpoint";
import {
  configDigest,
  replaceReviewGateState,
  reviewerSelectionDigest,
  SESSION_STATE_ENTRY_TYPE,
  SESSION_STATE_QUARANTINE_MARKER,
  SessionStateCwdMismatchError,
  SessionStateGitBaselineError,
  SessionStateCheckpointBaselineError,
  SessionStateIntegrityError,
  SessionStateInvalidStateError,
  SessionStateParseError,
  SessionStateStore,
  SessionStateMissingSelectionDigestError,
  SessionStateUnsupportedFormatError,
} from "../src/session-state";

test("UI preferences do not change review configuration identity", () => {
  const collapsed = normalizeConfig({ enabled: true, ui: { subtasksViewExpanded: false } });
  const expanded = normalizeConfig({ enabled: true, ui: { subtasksViewExpanded: true } });
  assert.equal(configDigest(collapsed), configDigest(expanded));
});

test("subtask notification preference does not change execution configuration identity", () => {
  const quiet = normalizeConfig({ enabled: true, execution: { subtaskNotifications: "quiet" } });
  const noisy = normalizeConfig({ enabled: true, execution: { subtaskNotifications: "noisy" } });
  assert.equal(configDigest(quiet), configDigest(noisy));
});
import {
  beginAgentRun,
  createState,
  freezeReviewWindowConfig,
  reconcileRestoredReviewWindows,
  rememberUserRequest,
  setReviewWindowBaseline,
  setReviewWindowCheckpointBaseline,
  snapshotOfReviewBaseline,
  snapshotReviewBaseline,
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
      omissions: [],
      omissionsTruncated: false,
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
externalAgents: {
  "reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      env: { PRIVATE_TOKEN: secret },
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "reviewer" }
      ] },
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
        // #126 approved binary handling: the sidecar pair is part of the
        // durable gate contract — markClean must keep enforcing it after restore.
        sidecars: [{ path: "image.bin", sidecarPath: "image.bin.worker-abc123def456" }],
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
    assert.equal(snapshotOfReviewBaseline(restored.state.reviewWindow?.baseline)?.files.get("tracked.txt")?.content, "base\n");
    assert.equal(restored.state.reviewWindow?.evidence.candidates.get(join(root, "outside.txt"))?.exchangeBaselines.get(1)?.error, "missing");
    assert.equal(restored.state.reviewWindow?.reviewerSessions.get("reviewer")?.id, "review-session");
    assert.equal(restored.execution.bundles[0]?.expectedRevision, 7);
    assert.deepEqual(restored.execution.groupRoots, ["/tmp/pi-review-execution-one"]);
    assert.deepEqual(restored.execution.conflictGate?.paths, ["conflicted.txt"]);
    assert.deepEqual(restored.execution.conflictGate?.sidecars, [{ path: "image.bin", sidecarPath: "image.bin.worker-abc123def456" }]);

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

test("session state preserves snapshot omission records through save and restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-omissions-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    setReviewWindowBaseline(state, {
      cwd: root,
      capturedAt: "2026-08-17T00:00:00.000Z",
      files: new Map([["protected.txt", {
        relativePath: "protected.txt",
        absolutePath: join(root, "protected.txt"),
        exists: true,
        size: 9,
        mtimeMs: 2,
        sha256: null,
        isBinary: false,
        omittedReason: "unreadable",
      }]]),
      omissions: [
        { path: "protected.txt", kind: "file", reason: "unreadable", errorCode: "EACCES" },
        { path: "gone.txt", kind: "file", reason: "missing", errorCode: "ENOENT" },
        { path: "blocks", kind: "directory", reason: "unreadable", errorCode: "EACCES" },
      ],
      omissionsTruncated: true,
    });
    // Save with a review config so the sidecar carries the canonical
    // selection digest, exactly as the production runtime persists it.
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
        { source: "external", id: "reviewer" }
      ] },
    });
    const store = new SessionStateStore({ sessionId: "conversation-ledger", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] }, config);

    const restored = await store.restore(root);
    assert.ok(restored);
    const baseline = snapshotOfReviewBaseline(restored.state.reviewWindow?.baseline);
    assert.deepEqual(baseline?.omissions, [
      { path: "protected.txt", kind: "file", reason: "unreadable", errorCode: "EACCES" },
      { path: "gone.txt", kind: "file", reason: "missing", errorCode: "ENOENT" },
      { path: "blocks", kind: "directory", reason: "unreadable", errorCode: "EACCES" },
    ]);
    assert.equal(baseline?.omissionsTruncated, true);
    assert.equal(baseline?.files.get("protected.txt")?.omittedReason, "unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cwd mismatch throws a typed error with safe metadata and no message content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-cwd-mismatch-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    queueModelDelivery(state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: "secret pending message one",
    });
    queueModelDelivery(state, {
      kind: "review_transmission",
      channel: "steer",
      message: "secret pending message two",
    });
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] });

    const other = join(root, "other");
    await assert.rejects(
      store.restore(other),
      (error: unknown) => {
        assert.ok(error instanceof SessionStateCwdMismatchError);
        assert.equal(error.storedCwd, root);
        assert.equal(error.currentCwd, resolve(other));
        assert.equal(error.revision, 1);
        assert.deepEqual(error.pendingDeliveries, {
          total: 2,
          byStatus: { queued: 2 },
          byKind: { review_authorization: 1, review_transmission: 1 },
        });
        assert.match(error.message, /does not match resumed cwd/);
        assert.doesNotMatch(error.message, /secret pending message/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantine moves the sidecar to a unique sibling path without clobbering prior quarantines", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-quarantine-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] });
    const originalBytes = await readFile(store.path, "utf8");

    const first = await store.quarantine();
    assert.notEqual(first, store.path);
    assert.equal(dirname(first), dirname(store.path), "quarantine is a sibling path");
    assert.match(first, new RegExp(SESSION_STATE_QUARANTINE_MARKER));
    assert.equal(await readFile(first, "utf8"), originalBytes, "quarantine preserves the exact bytes");
    await assert.rejects(readFile(store.path), /ENOENT/);

    // A fresh save at the original path, then a second quarantine must not
    // clobber the first quarantine.
    await store.save(state, { waveRoots: [], bundles: [] });
    const secondBytes = await readFile(store.path, "utf8");
    const second = await store.quarantine();
    assert.notEqual(second, first);
    assert.equal(await readFile(first, "utf8"), originalBytes, "first quarantine stays intact");
    assert.equal(await readFile(second, "utf8"), secondBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantine rejects when the sidecar is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-quarantine-missing-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await assert.rejects(store.quarantine());
    const leftovers = (await readdir(root)).filter((name) => name.includes(SESSION_STATE_QUARANTINE_MARKER));
    assert.deepEqual(leftovers, [], "no quarantine file may be left behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantine failure leaves the original sidecar untouched", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-quarantine-fail-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] });
    const originalBytes = await readFile(store.path, "utf8");

    await chmod(root, 0o555);
    await assert.rejects(store.quarantine());
    assert.equal(await readFile(store.path, "utf8"), originalBytes, "original must be untouched");
    const leftovers = (await readdir(root)).filter((name) => name.includes(SESSION_STATE_QUARANTINE_MARKER));
    assert.deepEqual(leftovers, [], "no quarantine file may be left behind");
  } finally {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable store refuses to save and reports no durable write", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-unavailable-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    assert.equal(await store.save(state, { waveRoots: [], bundles: [] }), true, "a healthy store reports a durable write");
    store.markUnavailable("restore failed: test");
    assert.match(store.unavailableReasonText ?? "", /restore failed/);
    const before = await readFile(store.path, "utf8");
    assert.equal(await store.save(state, { waveRoots: [], bundles: [] }), false, "an unavailable store reports no durable write");
    assert.equal(await readFile(store.path, "utf8"), before, "no write may occur while unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed sidecar JSON rejects with a typed error that never quotes file content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-bad-json-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    // Truncated, invalid JSON whose raw text carries a secret sentinel. A raw
    // JSON.parse error would quote this text; the typed error must not.
    const sentinel = "SECRET-SIDECAR-SENTINEL-message-text";
    await writeFile(store.path, `{ "state": { "pendingModelDeliveries": [{ "message": "${sentinel}`, "utf8");

    await assert.rejects(
      store.restore(root),
      (error: unknown) => {
        assert.ok(error instanceof SessionStateParseError);
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        return true;
      },
    );

    // A structurally valid but wrong document also fails with a typed error.
    await writeFile(store.path, `${JSON.stringify({ hello: "world" })}\n`, "utf8");
    await assert.rejects(store.restore(root), SessionStateInvalidStateError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Mirror of the store's canonical serialization for legacy-sidecar simulation.
function stableJsonForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJsonForTest(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function workspaceSnapshot(root: string, content: string, capturedAt: string): WorkspaceSnapshot {
  return {
    cwd: root,
    capturedAt,
    files: new Map([["snapshot.txt", {
      relativePath: "snapshot.txt",
      absolutePath: join(root, "snapshot.txt"),
      exists: true,
      size: content.length,
      mtimeMs: 1,
      sha256: createHash("sha256").update(content).digest("hex"),
      isBinary: false,
      content,
    }]]),
    omissions: [],
    omissionsTruncated: false,
  };
}

function stateWithActiveSnapshot(root: string, baseline: WorkspaceSnapshot) {
  const state = createState();
  rememberUserRequest(state, "persist this review window");
  beginAgentRun(state);
  setReviewWindowBaseline(state, baseline);
  return state;
}

function signSidecarForTest(value: Record<string, any>): void {
  const { integritySha256: _integrity, ...unsigned } = value;
  value.integritySha256 = createHash("sha256").update(stableJsonForTest(unsigned)).digest("hex");
}

test("identical window and active-exchange baselines persist once through a versioned reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-shared-baseline-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const content = "unique-baseline-content-sentinel";
    const baseline = workspaceSnapshot(root, content, "2026-08-18T00:00:00.000Z");
    const state = stateWithActiveSnapshot(root, baseline);
    const store = new SessionStateStore({ sessionId: "conversation-shared", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });

    await store.save(state, { waveRoots: [], bundles: [] }, config);

    const sidecarText = await readFile(store.path, "utf8");
    const raw = JSON.parse(sidecarText);
    assert.equal(raw.version, 4, "the changed schema must not be mistaken for v1 by older readers");
    assert.ok(raw.state.reviewWindow.baseline, "the canonical window snapshot stays inline");
    assert.deepEqual(raw.state.reviewWindow.activeExchange.baseline, {
      $snapshotRef: {
        format: "pi-review-gate-workspace-snapshot",
        version: 1,
        target: "window.baseline",
      },
    });
    assert.equal(sidecarText.split(content).length - 1, 1, "the shared snapshot content is serialized only once");

    const restored = await store.restore(root);
    assert.ok(restored?.state.reviewWindow?.baseline);
    assert.strictEqual(
      restored.state.reviewWindow.baseline,
      restored.state.reviewWindow.activeExchange?.baseline,
      "the alias materializes as the exact same restored snapshot",
    );
    assert.deepEqual(snapshotOfReviewBaseline(restored.state.reviewWindow.baseline), baseline);
    assert.equal(snapshotOfReviewBaseline(restored.state.reviewWindow.activeExchange?.baseline)?.files.get("snapshot.txt")?.content, content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct window and active-exchange baselines remain inline and restore independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-distinct-baselines-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const windowBaseline = workspaceSnapshot(root, "window-baseline-content", "2026-08-18T00:00:00.000Z");
    const exchangeBaseline = workspaceSnapshot(root, "exchange-baseline-content", "2026-08-18T00:01:00.000Z");
    const state = stateWithActiveSnapshot(root, windowBaseline);
    state.reviewWindow!.activeExchange!.baseline = snapshotReviewBaseline(exchangeBaseline);
    // Positive control: snapshot windows keep persisting full exchange
    // entries, including the inline content fields Git windows strip.
    state.reviewWindow!.exchanges.push({
      sequence: 1,
      startedAt: "2026-08-19T00:00:00.000Z",
      endedAt: "2026-08-19T00:01:00.000Z",
      workspaceChanges: [{
        path: "snapshot.txt",
        status: "modified",
        binary: false,
        oversized: false,
        oldContent: "sentinel-snapshot-exchange-old\n",
        newContent: "sentinel-snapshot-exchange-new\n",
      }],
      sideEffectChanges: [],
      workspacePatch: "diff --git a/snapshot.txt b/snapshot.txt\n+snapshot patch stays\n",
      sideEffectPatch: "",
      evidenceEvents: [],
      assistantSummaries: [],
      userRequests: [],
    });
    const store = new SessionStateStore({ sessionId: "conversation-distinct", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });

    await store.save(state, { waveRoots: [], bundles: [] }, config);

    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(raw.version, 4);
    assert.equal(raw.state.reviewWindow.activeExchange.baseline.files[0][1].content, "exchange-baseline-content");
    assert.equal("$snapshotRef" in raw.state.reviewWindow.activeExchange.baseline, false);
    const snapshotChange = raw.state.reviewWindow.exchanges[0].workspaceChanges[0];
    assert.equal(snapshotChange.oldContent, "sentinel-snapshot-exchange-old\n");
    assert.equal(snapshotChange.newContent, "sentinel-snapshot-exchange-new\n");
    const restored = await store.restore(root);
    assert.ok(restored?.state.reviewWindow?.baseline);
    assert.ok(restored.state.reviewWindow.activeExchange?.baseline);
    assert.deepEqual(snapshotOfReviewBaseline(restored.state.reviewWindow.baseline), windowBaseline);
    assert.deepEqual(snapshotOfReviewBaseline(restored.state.reviewWindow.activeExchange?.baseline), exchangeBaseline);
    assert.equal(restored.state.reviewWindow.exchanges[0]?.workspaceChanges[0]?.oldContent, "sentinel-snapshot-exchange-old\n");
    assert.notStrictEqual(restored.state.reviewWindow.baseline, restored.state.reviewWindow.activeExchange.baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version 1 sidecars with inline snapshots start a fresh review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-v1-snapshots-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const baseline = workspaceSnapshot(root, "legacy-inline-baseline", "2026-08-18T00:00:00.000Z");
    const state = stateWithActiveSnapshot(root, baseline);
    const store = new SessionStateStore({ sessionId: "conversation-v1", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    await store.save(state, { waveRoots: [], bundles: [] }, config);

    // Convert the new writer's canonical snapshot into the equivalent old v1
    // shape, where the active-exchange baseline was duplicated inline.
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    raw.version = 1;
    raw.state.reviewWindow.activeExchange.baseline = JSON.parse(JSON.stringify(raw.state.reviewWindow.baseline));
    signSidecarForTest(raw);
    await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");

    const restored = await store.restore(root);
    assert.equal(restored?.reviewCutover, "fresh_review_required");
    assert.equal(restored.state.reviewWindow, undefined);
    assert.equal(restored.state.lastQuestionWindow, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or malformed snapshot references fail closed, and snapshot digest tampering is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-bad-snapshot-ref-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const baseline = workspaceSnapshot(root, "integrity-protected-content", "2026-08-18T00:00:00.000Z");
    const state = stateWithActiveSnapshot(root, baseline);
    const store = new SessionStateStore({ sessionId: "conversation-bad-ref", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    await store.save(state, { waveRoots: [], bundles: [] }, config);
    const original = JSON.parse(await readFile(store.path, "utf8"));

    const malformedReference = JSON.parse(JSON.stringify(original));
    malformedReference.state.reviewWindow.activeExchange.baseline.$snapshotRef.version = 2;
    signSidecarForTest(malformedReference);
    await writeFile(store.path, `${JSON.stringify(malformedReference)}\n`, "utf8");
    await assert.rejects(store.restore(root), SessionStateInvalidStateError);

    const hybridReference = JSON.parse(JSON.stringify(original));
    Object.assign(
      hybridReference.state.reviewWindow.activeExchange.baseline,
      JSON.parse(JSON.stringify(hybridReference.state.reviewWindow.baseline)),
    );
    signSidecarForTest(hybridReference);
    await writeFile(store.path, `${JSON.stringify(hybridReference)}\n`, "utf8");
    await assert.rejects(store.restore(root), SessionStateInvalidStateError);

    const missingTarget = JSON.parse(JSON.stringify(original));
    delete missingTarget.state.reviewWindow.baseline;
    signSidecarForTest(missingTarget);
    await writeFile(store.path, `${JSON.stringify(missingTarget)}\n`, "utf8");
    await assert.rejects(store.restore(root), SessionStateInvalidStateError);

    const tamperedContent = JSON.parse(JSON.stringify(original));
    tamperedContent.state.reviewWindow.baseline.files[0][1].content = "tampered-content";
    await writeFile(store.path, `${JSON.stringify(tamperedContent)}\n`, "utf8");
    await assert.rejects(store.restore(root), SessionStateIntegrityError);

    const tamperedDigest = JSON.parse(JSON.stringify(original));
    tamperedDigest.integritySha256 = "0".repeat(64);
    await writeFile(store.path, `${JSON.stringify(tamperedDigest)}\n`, "utf8");
    await assert.rejects(store.restore(root), SessionStateIntegrityError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewerSelectionDigest is insensitive to unrelated settings but tracks reviewer changes", () => {
  const base = {
enabled: true,
externalAgents: {
  "one": {
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {}
  },
  "two": {
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
      { source: "external", id: "one" }
    ] },
  };
  const a = normalizeConfig(base);

  // Unrelated settings must not trigger reconciliation on restore.
  assert.equal(reviewerSelectionDigest(a), reviewerSelectionDigest(normalizeConfig({ ...base, timeoutMs: 999999 })));
  assert.equal(reviewerSelectionDigest(a), reviewerSelectionDigest(normalizeConfig({ ...base, maxPatchBytes: 123456 })));
  assert.equal(reviewerSelectionDigest(a), reviewerSelectionDigest(normalizeConfig({ ...base, web: { enabled: true } })));

  // Reviewer selection changes must be detected.
  assert.notEqual(reviewerSelectionDigest(a), reviewerSelectionDigest(normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "two" }
    ] },
  })));
  // Selecting every catalog reviewer changes the effective set.
  const defaultSelection = normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "one" },
      { source: "external", id: "two" }
    ] },
  });
  assert.notEqual(
    reviewerSelectionDigest(defaultSelection),
    reviewerSelectionDigest(normalizeConfig({
...base,
externalAgents: {
  ...base.externalAgents!,
  "three": {
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
      { source: "external", id: "one" },
      { source: "external", id: "two" },
      { source: "external", id: "three" }
    ] },
    })),
  );
  // Adding an unselected catalog entry does not change the effective selection.
  assert.equal(
    reviewerSelectionDigest(a),
    reviewerSelectionDigest(normalizeConfig({
...base,
externalAgents: {
  ...base.externalAgents!,
  "three": {
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {}
  }
},
    })),
  );
  assert.notEqual(
    reviewerSelectionDigest(a),
    reviewerSelectionDigest(normalizeConfig({
...base,
externalAgents: {
  ...base.externalAgents!,
  one: {
    adapter: "generic-cli" as const,
    command: "/usr/bin/other",
    args: [],
    review: {},
  },
},
    })),
  );
  // A renamed selection (stale id) is part of the selection identity.
  assert.notEqual(reviewerSelectionDigest(a), reviewerSelectionDigest(normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "gone" }
    ] },
  })));
});

test("reviewer selection digest round-trips through sidecar save and restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-selection-digest-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, {
      cwd: root,
      capturedAt: "2026-08-16T00:00:00.000Z",
      files: new Map(),
      omissions: [],
      omissionsTruncated: false,
    });
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "one": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {}
  },
  "two": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
        { source: "external", id: "one" }
      ] },
    });
    freezeReviewWindowConfig(state, config);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    // Production saves pass the window's effective (frozen) configuration.
    await store.save(state, { waveRoots: [], bundles: [] }, state.reviewWindow!.reviewConfig);

    const restored = await store.restore(root);
    // The selection digest is canonical: it matches the live configuration.
    assert.equal(restored?.reviewerSelectionDigest, reviewerSelectionDigest(config));
    // New sidecars write only the canonical selection digest; the superseded
    // broad reviewConfigDigest field is no longer emitted.
    const raw = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    assert.equal("reviewConfigDigest" in raw, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewerSelectionDigest distinguishes unresolved-only and duplicate-only changes on materialized configs", () => {
  const base = {
enabled: true,
externalAgents: {
  "alpha": {
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
      { source: "external", id: "alpha" }
    ] },
  };
  const missingA = normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "alpha" },
      { source: "external", id: "missingA" }
    ] },
  });
  const missingB = normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "alpha" },
      { source: "external", id: "missingB" }
    ] },
  });

  // The actual persistence boundary digests materialized configs; a change
  // that swaps one unresolvable selection for another must be visible there.
  assert.notEqual(
    reviewerSelectionDigest(materializeReviewConfig(missingA, [])),
    reviewerSelectionDigest(materializeReviewConfig(missingB, [])),
  );
  // Live and materialized forms of the same effective selection stay
  // equivalent, so an unchanged reload never reports a change.
  assert.equal(reviewerSelectionDigest(missingA), reviewerSelectionDigest(materializeReviewConfig(missingA, [])));
  assert.equal(reviewerSelectionDigest(missingB), reviewerSelectionDigest(materializeReviewConfig(missingB, [])));

  // Duplicate-only changes are part of the selection identity as well.
  const noDuplicate = normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "alpha" }
    ] },
  });
  const duplicated = normalizeConfig({
...base,
review: { activeReviewers: [
      { source: "external", id: "alpha" },
      { source: "external", id: "alpha" }
    ] },
  });
  assert.notEqual(
    reviewerSelectionDigest(materializeReviewConfig(noDuplicate, [])),
    reviewerSelectionDigest(materializeReviewConfig(duplicated, [])),
  );
  assert.equal(reviewerSelectionDigest(duplicated), reviewerSelectionDigest(materializeReviewConfig(duplicated, [])));
});

test("frozen selection digest reports a missing-only reviewer change across save and restore, not on unchanged reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-missing-only-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const alpha = { id: "alpha", adapter: "generic-cli" as const, command: process.execPath, args: [], review: {} };
    const configA = normalizeConfig({
enabled: true,
externalAgents: {
  [alpha.id]: { adapter: "generic-cli" as const, command: process.execPath, args: [], review: {} },
},
review: { activeReviewers: [
        { source: "external", id: "alpha" },
        { source: "external", id: "missingA" }
      ] },
    });
    const configB = normalizeConfig({
enabled: true,
externalAgents: {
  [alpha.id]: { adapter: "generic-cli" as const, command: process.execPath, args: [], review: {} },
},
review: { activeReviewers: [
        { source: "external", id: "alpha" },
        { source: "external", id: "missingB" }
      ] },
    });

    // Save under A exactly as production does: the store receives the window's
    // frozen (materialized) configuration, whose unresolved selection lives
    // beside the config object.
    const freshState = () => {
      const state = createState();
      rememberUserRequest(state, "implement the durable change");
      beginAgentRun(state);
      setReviewWindowBaseline(state, {
        cwd: root,
        capturedAt: "2026-08-16T00:00:00.000Z",
        files: new Map(),
        omissions: [],
        omissionsTruncated: false,
      });
      return state;
    };

    const saved = freshState();
    freezeReviewWindowConfig(saved, configA);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(saved, { waveRoots: [], bundles: [] }, saved.reviewWindow!.reviewConfig!);
    const restored = await store.restore(root);
    assert.ok(restored);

    // Unchanged reload: the re-frozen window digests identically, so no
    // reconciliation notice repeats.
    const unchangedState = freshState();
    unchangedState.reviewWindow!.reviewConfig = undefined; // persisted windows never carry their frozen config
    assert.equal(reconcileRestoredReviewWindows(unchangedState, restored, configA).configurationChanged, false);

    // The settings change swaps only the unresolvable selection: the healthy
    // reviewer still runs and the unresolved selection stays a visible bounded
    // outcome of the reconciled window.
    const changedState = freshState();
    changedState.reviewWindow!.reviewConfig = undefined;
    assert.equal(reconcileRestoredReviewWindows(changedState, restored, configB).configurationChanged, true);
    // Re-read through a fresh reference: reconciliation replaced the window's
    // frozen configuration object (the earlier `= undefined` assignment keeps
    // TypeScript narrowing the property, so widen it explicitly).
    const reconciledConfig = changedState.reviewWindow?.reviewConfig as ReviewGateConfig | undefined;
    assert.ok(reconciledConfig);
    assert.deepEqual(reconciledConfig.review?.activeReviewers, [{ source: "external", id: "alpha" }]);
    assert.deepEqual(unresolvedReviewerSelectionsFor(reconciledConfig), ["external:missingB"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecars whose review window lacks the reviewer selection digest are rejected at restore and preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-legacy-digest-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, {
      cwd: root,
      capturedAt: "2026-08-16T00:00:00.000Z",
      files: new Map(),
      omissions: [],
      omissionsTruncated: false,
    });
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
        { source: "external", id: "reviewer" }
      ] },
    });
    freezeReviewWindowConfig(state, config);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] }, state.reviewWindow!.reviewConfig);

    // Simulate a pre-cutover sidecar by removing the selection digest and
    // recomputing the integrity hash over the modified document (same
    // canonical form the store uses: sha256 of stableJson of the unsigned
    // payload).
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    delete raw.reviewerSelectionDigest;
    const { integritySha256: _integrity, ...unsigned } = raw;
    const canonical = JSON.parse(JSON.stringify(unsigned));
    raw.integritySha256 = createHash("sha256").update(stableJsonForTest(canonical)).digest("hex");
    const oldOnlyBody = `${JSON.stringify(raw)}\n`;
    await writeFile(store.path, oldOnlyBody, "utf8");

    // The old-only shape is rejected before any restored state is applied —
    // no upgrade-on-read — and the sidecar is preserved byte-for-byte.
    await assert.rejects(
      () => store.restore(root),
      (error: unknown) => error instanceof SessionStateMissingSelectionDigestError,
    );
    assert.equal(await readFile(store.path, "utf8"), oldOnlyBody);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a record-only (worker-side deletion) sidecar entry round-trips without fabricating a path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-record-sidecar-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, { cwd: root, capturedAt: "2026-08-16T00:00:00.000Z", files: new Map(), omissions: [], omissionsTruncated: false });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    freezeReviewWindowConfig(state, config);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, {
      waveRoots: [],
      bundles: [],
      conflictGate: {
        executionId: "exec-del",
        taskId: "task-del",
        sourceRoot: root,
        paths: ["gone.bin"],
        activatedAt: "2026-08-16T00:00:00.000Z",
        manifestPath: join(root, "conflict.json"),
        reason: "worker-side deletion recorded",
        // #126 U2: a worker-side deletion has no bytes to save, so the durable
        // entry carries only the path — never a fabricated sidecar location.
        sidecars: [{ path: "gone.bin" }],
      },
    }, state.reviewWindow!.reviewConfig);

    const restored = await store.restore(root);
    assert.ok(restored);
    assert.deepEqual(
      restored.execution.conflictGate?.sidecars,
      [{ path: "gone.bin" }],
      "a record-only sidecar entry must restore exactly, with no fabricated sidecarPath",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed sidecar entry rejects the snapshot fail-closed and preserves the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-bad-sidecar-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, { cwd: root, capturedAt: "2026-08-16T00:00:00.000Z", files: new Map(), omissions: [], omissionsTruncated: false });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    freezeReviewWindowConfig(state, config);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, {
      waveRoots: [],
      bundles: [],
      conflictGate: {
        executionId: "exec-bad",
        taskId: "task-bad",
        sourceRoot: root,
        paths: ["image.bin"],
        activatedAt: "2026-08-16T00:00:00.000Z",
        manifestPath: join(root, "conflict.json"),
        reason: "binary conflict",
        sidecars: [{ path: "image.bin", sidecarPath: "image.bin.worker-abc123def456" }],
      },
    }, state.reviewWindow!.reviewConfig);

    // Corrupt the persisted sidecar entry (sidecarPath must be a string) and
    // re-sign the document so the failure is the shape check, not integrity.
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    const gate = raw.execution?.conflictGate ?? raw.execution?.conflictGates?.[0];
    assert.ok(gate?.sidecars?.[0], "the persisted gate must carry its sidecar entry");
    gate.sidecars[0].sidecarPath = 42;
    const { integritySha256: _integrity, ...unsigned } = raw;
    raw.integritySha256 = createHash("sha256").update(stableJsonForTest(JSON.parse(JSON.stringify(unsigned)))).digest("hex");
    const corrupted = `${JSON.stringify(raw)}\n`;
    await writeFile(store.path, corrupted, "utf8");

    // A wrong-typed sidecar field must reject the snapshot rather than be
    // dropped: a restored gate without it could clear a sidecar conflict while
    // the worker version still sits alongside.
    await assert.rejects(
      () => store.restore(root),
      (error: unknown) => error instanceof SessionStateInvalidStateError,
    );
    assert.equal(await readFile(store.path, "utf8"), corrupted, "the malformed sidecar is preserved byte-for-byte");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidecars without a review window restore even without a selection digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-windowless-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] });

    // No review window is persisted, so there is nothing to verify against a
    // selection digest; the record remains restorable.
    const restored = await store.restore(root);
    assert.ok(restored);
    assert.equal(restored.state.reviewWindow, undefined);
    assert.equal(restored.state.lastQuestionWindow, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-cutover windowless state cancels queued review verdicts but keeps user input and execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-windowless-old-delivery-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    state.pendingModelDeliveries.push(
      { deliveryId: "old-pass", kind: "review_authorization", channel: "follow_up", message: "stale pass", status: "queued", createdAt: "old" },
      { deliveryId: "old-feedback", kind: "review_transmission", channel: "steer", message: "stale verdict", status: "queued", createdAt: "old" },
      { deliveryId: "user", kind: "queued_user_input", channel: "follow_up", message: "keep this", status: "queued", createdAt: "old" },
    );
    const store = new SessionStateStore({ sessionId: "old-windowless", sessionFile, cwd: root });
    await store.save(state, { waveRoots: ["execution-root"], bundles: [] });
    const old = JSON.parse(await readFile(store.path, "utf8"));
    old.version = 3;
    signSidecarForTest(old);
    await writeFile(store.path, JSON.stringify(old));

    const restored = await store.restore(root);
    assert.equal(restored?.state.reviewWindow, undefined);
    assert.deepEqual(restored?.state.pendingModelDeliveries.map((delivery) => delivery.status),
      ["cancelled", "cancelled", "queued"]);
    assert.deepEqual(restored?.execution.waveRoots, ["execution-root"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sidecars predating the omission ledger fail restore explicitly and are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-pre-ledger-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, {
      cwd: root,
      capturedAt: "2026-08-16T00:00:00.000Z",
      files: new Map(),
      omissions: [],
      omissionsTruncated: false,
    });
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
        { source: "external", id: "reviewer" }
      ] },
    });
    freezeReviewWindowConfig(state, config);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] }, state.reviewWindow!.reviewConfig);

    // Simulate a pre-ledger sidecar: the persisted window baseline carries no
    // omission ledger fields. Recompute the integrity hash over the modified
    // document so the failure is format-based, not integrity-based.
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    delete raw.state.reviewWindow.baseline.omissions;
    delete raw.state.reviewWindow.baseline.omissionsTruncated;
    const { integritySha256: _integrity, ...unsigned } = raw;
    const canonical = JSON.parse(JSON.stringify(unsigned));
    raw.integritySha256 = createHash("sha256").update(stableJsonForTest(canonical)).digest("hex");
    const tamperedBody = `${JSON.stringify(raw)}\n`;
    await writeFile(store.path, tamperedBody, "utf8");

    await assert.rejects(
      () => store.restore(root),
      (error: unknown) => error instanceof SessionStateUnsupportedFormatError,
    );
    // The failed sidecar is preserved byte-for-byte: restore never rewrites it.
    assert.equal(await readFile(store.path, "utf8"), tamperedBody);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("superseded-format sidecars carrying the obsolete reviewConfigurationError flag restore with the flag dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-obsolete-flag-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "implement the durable change");
    beginAgentRun(state);
    setReviewWindowBaseline(state, {
      cwd: root,
      capturedAt: "2026-08-16T00:00:00.000Z",
      files: new Map(),
      omissions: [],
      omissionsTruncated: false,
    });
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {}
  }
},
review: { activeReviewers: [
        { source: "external", id: "reviewer" }
      ] },
    });
    freezeReviewWindowConfig(state, config);
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] }, state.reviewWindow!.reviewConfig);

    // Simulate an old-only sidecar whose window still carries the obsolete
    // blocking flag; recompute the integrity hash over the modified document.
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    raw.state.reviewWindow.reviewConfigurationError = "Persisted review state used a different reviewer configuration.";
    const { integritySha256: _integrity, ...unsigned } = raw;
    const canonical = JSON.parse(JSON.stringify(unsigned));
    raw.integritySha256 = createHash("sha256").update(stableJsonForTest(canonical)).digest("hex");
    await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");

    // The obsolete flag is an unsupported copy: it is ignored on read (no
    // rejection, no rewrite), and the window re-freezes from current settings.
    const restored = await store.restore(root);
    assert.ok(restored?.state.reviewWindow);
    assert.equal(
      (restored.state.reviewWindow as unknown as Record<string, unknown>)["reviewConfigurationError"],
      undefined,
    );
    assert.equal(snapshotOfReviewBaseline(restored.state.reviewWindow!.baseline)?.cwd, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── v3 Git checkpoint baselines ──────────────────────────────────────────────
//
// The v3 writer persists a Git baseline as a compact descriptor (no patch or
// file content) and re-verifies every Git baseline against the repository on
// restore, failing closed before any restored state is applied.

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function gitForBaselineTest(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo, env: GIT_ENV });
  return stdout;
}

/** Fresh repository with one commit. */
async function initGitRepoForBaselineTest(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-session-git-baseline-"));
  await gitForBaselineTest(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "# baseline test\n", "utf8");
  await gitForBaselineTest(repo, "add", ".");
  await gitForBaselineTest(repo, "commit", "-q", "-m", "initial");
  return repo;
}

async function armCheckpointIn(root: string, windowId: string) {
  const arm = await armGitCheckpoint(root, windowId);
  assert.equal(arm.status, "ok");
  if (arm.status !== "ok") throw new Error("unreachable");
  return arm.value.descriptor;
}

function gitBaseline(descriptor: import("../src/git-checkpoint").GitCheckpointDescriptor, cwd: string, capturedAt: string) {
  return { kind: "git" as const, descriptor, cwd, capturedAt };
}

/** Save a sidecar whose review window holds the given Git baselines. */
async function saveGitBaselineSidecar(root: string, sessionId: string, windowId: string) {
  const sessionFile = join(root, "conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");
  const descriptor = await armCheckpointIn(root, windowId);
  const state = createState();
  rememberUserRequest(state, "persist a git checkpoint baseline");
  beginAgentRun(state);
  const baseline = gitBaseline(descriptor, root, "2026-08-19T00:00:00.000Z");
  state.reviewWindow!.baseline = baseline;
  const store = new SessionStateStore({ sessionId, sessionFile, cwd: root });
  const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
  await store.save(state, { waveRoots: [], bundles: [] }, config);
  return { store, descriptor, baseline };
}

test("v3 persists a Git baseline as a compact descriptor and restores it after reloading the checkpoint", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    // A staged change whose payload must never reach the sidecar.
    await writeFile(join(root, "staged.txt"), "sentinel-git-baseline-payload\n", "utf8");
    await gitForBaselineTest(root, "add", "staged.txt");

    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const descriptor = await armCheckpointIn(root, "win-git-shared");
    const state = createState();
    rememberUserRequest(state, "persist a git checkpoint baseline");
    beginAgentRun(state);
    // Share the Git baseline with the active exchange: it must dedupe.
    const baseline = gitBaseline(descriptor, root, "2026-08-19T00:00:00.000Z");
    state.reviewWindow!.baseline = baseline;
    state.reviewWindow!.activeExchange!.baseline = baseline;
    // A completed exchange whose unbounded inline content must be stripped
    // from the sidecar while every decision field and the bounded patch stay.
    state.reviewWindow!.exchanges.push({
      sequence: 1,
      startedAt: "2026-08-19T00:00:00.000Z",
      endedAt: "2026-08-19T00:01:00.000Z",
      workspaceChanges: [{
        path: "staged.txt",
        status: "modified",
        binary: false,
        oversized: false,
        oldGitMode: "100644",
        newGitMode: "100644",
        oldTracking: "tracked",
        newTracking: "tracked",
        renamedFrom: "old-name.txt",
        oldContent: "sentinel-git-exchange-old\n",
        newContent: "sentinel-git-exchange-new\n",
      }],
      // Side effects have no Git checkpoint fallback: their inline content
      // must be persisted even for Git windows.
      sideEffectChanges: [{
        path: "../outside/side-effect.txt",
        status: "modified",
        binary: false,
        oversized: false,
        oldContent: "sentinel-git-side-effect-old\n",
        newContent: "sentinel-git-side-effect-new\n",
      }],
      workspacePatch: "diff --git a/staged.txt b/staged.txt\n+bounded patch stays\n",
      sideEffectPatch: "",
      evidenceEvents: [],
      assistantSummaries: [],
      userRequests: [],
    });
    const store = new SessionStateStore({ sessionId: "conversation-git-shared", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    await store.save(state, { waveRoots: [], bundles: [] }, config);

    const sidecarText = await readFile(store.path, "utf8");
    const raw = JSON.parse(sidecarText);
    assert.equal(raw.version, 4);
    // Descriptor-only: exactly the compact fields, nothing else.
    assert.deepEqual(raw.state.reviewWindow.baseline, { kind: "git", descriptor, cwd: root, capturedAt: baseline.capturedAt });
    assert.deepEqual(raw.state.reviewWindow.activeExchange.baseline, {
      $gitCheckpointRef: { format: "pi-review-gate-git-checkpoint", version: 1, target: "window.baseline" },
    });
    // The checkpoint's patch payload never enters the sidecar.
    assert.ok(!sidecarText.includes("sentinel-git-baseline-payload"), "staged patch content must not be persisted in the sidecar");

    // Git windows strip exactly the unbounded content fields from persisted
    // exchanges; path/status/mode/tracking/rename and the bounded patch stay.
    const persistedChange = raw.state.reviewWindow.exchanges[0].workspaceChanges[0];
    assert.equal(persistedChange.oldContent, undefined);
    assert.equal(persistedChange.newContent, undefined);
    assert.equal(persistedChange.path, "staged.txt");
    assert.equal(persistedChange.status, "modified");
    assert.equal(persistedChange.binary, false);
    assert.equal(persistedChange.oversized, false);
    assert.equal(persistedChange.oldGitMode, "100644");
    assert.equal(persistedChange.newGitMode, "100644");
    assert.equal(persistedChange.oldTracking, "tracked");
    assert.equal(persistedChange.newTracking, "tracked");
    assert.equal(persistedChange.renamedFrom, "old-name.txt");
    assert.ok(raw.state.reviewWindow.exchanges[0].workspacePatch.includes("bounded patch stays"), "the bounded patch must be persisted");
    assert.ok(!sidecarText.includes("sentinel-git-exchange-old"), "old file content must not be persisted for Git windows");
    assert.ok(!sidecarText.includes("sentinel-git-exchange-new"), "new file content must not be persisted for Git windows");

    // The deliberate asymmetry: side-effect content has no checkpoint
    // fallback, so it stays in the sidecar even for Git windows.
    const persistedSideEffect = raw.state.reviewWindow.exchanges[0].sideEffectChanges[0];
    assert.equal(persistedSideEffect.oldContent, "sentinel-git-side-effect-old\n");
    assert.equal(persistedSideEffect.newContent, "sentinel-git-side-effect-new\n");

    const restored = await store.restore(root);
    assert.ok(restored?.state.reviewWindow?.baseline);
    assert.deepEqual(restored.state.reviewWindow.baseline, baseline);
    // The stripping happens at the persistence boundary: the restored
    // exchange carries no inline workspace content, but keeps its side effects.
    assert.equal(restored.state.reviewWindow.exchanges[0]?.workspaceChanges[0]?.oldContent, undefined);
    assert.equal(restored.state.reviewWindow.exchanges[0]?.workspaceChanges[0]?.newContent, undefined);
    assert.equal(restored.state.reviewWindow.exchanges[0]?.sideEffectChanges[0]?.oldContent, "sentinel-git-side-effect-old\n");
    assert.strictEqual(
      restored.state.reviewWindow.baseline,
      restored.state.reviewWindow.activeExchange?.baseline,
      "the git alias materializes as the same restored baseline",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct Git window and active-exchange baselines persist inline and restore independently", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    const descriptorA = await armCheckpointIn(root, "win-distinct-a");
    const descriptorB = await armCheckpointIn(root, "win-distinct-b");
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = createState();
    rememberUserRequest(state, "persist distinct git baselines");
    beginAgentRun(state);
    const baselineA = gitBaseline(descriptorA, root, "2026-08-19T00:00:00.000Z");
    const baselineB = gitBaseline(descriptorB, root, "2026-08-19T00:01:00.000Z");
    state.reviewWindow!.baseline = baselineA;
    state.reviewWindow!.activeExchange!.baseline = baselineB;
    const store = new SessionStateStore({ sessionId: "conversation-git-distinct", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    await store.save(state, { waveRoots: [], bundles: [] }, config);

    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(raw.version, 4);
    assert.deepEqual(raw.state.reviewWindow.baseline, baselineA);
    assert.deepEqual(raw.state.reviewWindow.activeExchange.baseline, baselineB);
    assert.ok(!("$gitCheckpointRef" in raw.state.reviewWindow.activeExchange.baseline), "distinct baselines must not be deduplicated");

    const restored = await store.restore(root);
    assert.ok(restored?.state.reviewWindow?.baseline);
    assert.deepEqual(restored.state.reviewWindow.baseline, baselineA);
    assert.deepEqual(restored.state.reviewWindow.activeExchange?.baseline, baselineB);
    assert.notStrictEqual(
      restored.state.reviewWindow.baseline,
      restored.state.reviewWindow.activeExchange?.baseline,
      "distinct baselines restore as distinct objects",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function expectGitBaselineRestoreFailure(
  root: string,
  mutate: (raw: Record<string, any>) => Promise<void> | void,
  expectedReason: string,
): Promise<void> {
  const { store } = await saveGitBaselineSidecar(root, "conversation-git-failclosed", "win-failclosed");
  const written = await readFile(store.path, "utf8");
  const raw = JSON.parse(written);
  await mutate(raw);
  signSidecarForTest(raw);
  await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");

  await assert.rejects(
    store.restore(root),
    (error: unknown) => error instanceof SessionStateGitBaselineError && error.reason === expectedReason,
  );
  // A failed restore must leave the sidecar exactly as it found it.
  assert.equal(await readFile(store.path, "utf8"), `${JSON.stringify(raw)}\n`);
}

test("a missing checkpoint record fails closed with checkpoint_data_missing", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    await expectGitBaselineRestoreFailure(root, async (raw) => {
      // The descriptor is intact; the durable record is what disappears.
      const descriptor = raw.state.reviewWindow.baseline.descriptor;
      const recordPath = join(root, ".git", "pi-review-gate", "checkpoints", descriptor.windowId, `arm-${descriptor.armId}`, "record.json");
      await rm(recordPath);
    }, "checkpoint_data_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted pin ref fails closed with pin_ref_missing", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    const { store } = await saveGitBaselineSidecar(root, "conversation-git-pin", "win-pin");
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    const descriptor = raw.state.reviewWindow.baseline.descriptor;
    await gitForBaselineTest(root, "update-ref", "-d", descriptor.ref);
    await assert.rejects(
      store.restore(root),
      (error: unknown) => error instanceof SessionStateGitBaselineError && error.reason === "pin_ref_missing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a capture root pointing at a different repository fails closed with wrong_repository", async () => {
  const root = await initGitRepoForBaselineTest();
  const otherRepo = await initGitRepoForBaselineTest();
  try {
    await expectGitBaselineRestoreFailure(root, (raw) => {
      raw.state.reviewWindow.baseline.cwd = otherRepo;
    }, "wrong_repository");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(otherRepo, { recursive: true, force: true });
  }
});

test("a malformed descriptor fails closed with malformed_descriptor", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    await expectGitBaselineRestoreFailure(root, (raw) => {
      // Break the object id format: gate 1 rejects before any I/O.
      raw.state.reviewWindow.baseline.descriptor.base = `z${raw.state.reviewWindow.baseline.descriptor.base.slice(1)}`;
    }, "malformed_descriptor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed baseline kinds in one window are rejected before restore completes", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    const { store } = await saveGitBaselineSidecar(root, "conversation-git-mixed", "win-mixed");
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    // Layer an inline snapshot baseline over the Git window baseline.
    raw.state.reviewWindow.activeExchange = {
      ...raw.state.reviewWindow.activeExchange,
      baseline: { cwd: root, capturedAt: "2026-08-19T00:02:00.000Z", files: [] },
    };
    signSidecarForTest(raw);
    await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");
    await assert.rejects(
      store.restore(root),
      (error: unknown) => error instanceof SessionStateInvalidStateError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a provisional v2 sidecar with a snapshot reference starts a fresh review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-v2-ref-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const baseline = workspaceSnapshot(root, "v2-reference-content", "2026-08-18T00:00:00.000Z");
    const state = stateWithActiveSnapshot(root, baseline);
    const store = new SessionStateStore({ sessionId: "conversation-v2-ref", sessionFile, cwd: root });
    const config = normalizeConfig({ enabled: true, review: { activeReviewers: [] } });
    await store.save(state, { waveRoots: [], bundles: [] }, config);

    // Downgrade the v3 document to the provisional v2 shape and re-sign.
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(raw.version, 4);
    assert.ok(raw.state.reviewWindow.activeExchange.baseline.$snapshotRef, "the shared snapshot must be a reference");
    raw.version = 2;
    signSidecarForTest(raw);
    await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");

    const restored = await store.restore(root);
    assert.equal(restored?.reviewCutover, "fresh_review_required");
    assert.equal(restored.state.reviewWindow, undefined);
    rememberUserRequest(restored.state, "next request");
    assert.equal((restored.state.reviewWindow as import("../src/state").ReviewWindow | undefined)?.requestHistory[0]?.text, "next request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unified raw checkpoint stays compact, deduplicates an equal descriptor, and verifies on restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-unified-raw-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    await writeFile(join(root, "payload.txt"), "unified-raw-payload-sentinel", "utf8");
    const captured = await captureReviewCheckpoint(root, "window-raw");
    assert.equal(captured.status, "ok");
    if (captured.status !== "ok") return;
    assert.equal(captured.value.kind, "raw");
    const state = createState();
    beginAgentRun(state);
    const baseline = { kind: "checkpoint" as const, descriptor: captured.value, cwd: root, capturedAt: "now" };
    setReviewWindowCheckpointBaseline(state, baseline);
    state.reviewWindow!.activeExchange!.baseline = { ...baseline, capturedAt: "later", descriptor:
      captured.value.kind === "raw" ? {
        digest: captured.value.digest, owner: captured.value.owner, windowId: captured.value.windowId,
        root: captured.value.root, format: captured.value.format, kind: captured.value.kind,
      } : captured.value };
    const store = new SessionStateStore({ sessionId: "raw-session", sessionFile, cwd: root });
    state.reviewsPaused = true;
    state.pendingModelDeliveries.push(
      { deliveryId: "old-pass", kind: "review_authorization", channel: "follow_up", message: "old verdict", status: "queued", createdAt: "old" },
      { deliveryId: "user", kind: "queued_user_input", channel: "follow_up", message: "retain user input", status: "queued", createdAt: "old" },
    );
    await store.save(state, { waveRoots: ["execution-root"], bundles: [] }, normalizeConfig({ enabled: true }));
    const text = await readFile(store.path, "utf8");
    const raw = JSON.parse(text);
    assert.deepEqual(raw.state.reviewWindow.baseline, baseline);
    assert.deepEqual(raw.state.reviewWindow.activeExchange.baseline, {
      $checkpointRef: { format: "pi-review-gate-review-checkpoint", version: 1, target: "window.baseline" },
    });
    assert.ok(!text.includes("unified-raw-payload-sentinel"));
    const restored = await store.restore(root);
    assert.strictEqual(restored?.state.reviewWindow?.baseline, restored?.state.reviewWindow?.activeExchange?.baseline);
    assert.deepEqual(restored?.execution.waveRoots, ["execution-root"]);

    const missing = JSON.parse(text);
    delete missing.state.reviewWindow.baseline;
    signSidecarForTest(missing);
    await writeFile(store.path, JSON.stringify(missing));
    await assert.rejects(store.restore(root), SessionStateInvalidStateError);
    delete missing.state.reviewWindow.activeExchange.baseline;
    signSidecarForTest(missing);
    await writeFile(store.path, JSON.stringify(missing));
    await assert.rejects(store.restore(root), SessionStateInvalidStateError, "armed marker rejects loss of both baseline fields");

    const malformed = JSON.parse(text);
    malformed.state.reviewWindow.baseline.descriptor.digest = "not-a-digest";
    signSidecarForTest(malformed);
    await writeFile(store.path, JSON.stringify(malformed));
    await assert.rejects(store.restore(root), (error: unknown) =>
      error instanceof SessionStateCheckpointBaselineError && error.reason === "raw_checkpoint_failed");

    await writeFile(store.path, text);
    if (captured.value.kind !== "raw") return;
    await rm(join(root, ".pi-review-gate", "checkpoints", `${captured.value.windowId}-${captured.value.owner}`, "record.json"));
    const damaged = await store.restore(root);
    assert.equal(damaged?.reviewCutover, "damaged_checkpoint");
    assert.equal(damaged?.state.reviewWindow, undefined);
    assert.deepEqual(damaged?.execution.waveRoots, ["execution-root"]);
    assert.equal(damaged?.state.reviewsPaused, true, "unrelated review preference survives");
    assert.deepEqual(damaged?.state.pendingModelDeliveries.map((d) => d.status), ["cancelled", "queued"]);
    assert.equal(damaged?.state.pendingAcceptedReviewerQuestions.length, 0);
    assert.equal(await readFile(store.path, "utf8"), text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a signed foreign unified checkpoint and malformed execution association never qualify for damage cutover", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-foreign-unified-"));
  const foreign = await mkdtemp(join(tmpdir(), "pi-review-foreign-root-"));
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "");
    const captured = await captureReviewCheckpoint(root, "window-foreign-check");
    assert.equal(captured.status, "ok");
    if (captured.status !== "ok" || captured.value.kind !== "raw") return;
    const state = createState();
    beginAgentRun(state);
    setReviewWindowCheckpointBaseline(state, { kind: "checkpoint", descriptor: captured.value, cwd: root, capturedAt: "now" });
    const store = new SessionStateStore({ sessionId: "foreign-check", sessionFile, cwd: root });
    await store.save(state, { waveRoots: ["valid"], bundles: [] }, normalizeConfig({ enabled: true }));
    const original = JSON.parse(await readFile(store.path, "utf8"));

    const foreignSidecar = JSON.parse(JSON.stringify(original));
    foreignSidecar.state.reviewWindow.baseline.cwd = foreign;
    foreignSidecar.state.reviewWindow.baseline.descriptor.root = foreign;
    signSidecarForTest(foreignSidecar);
    await writeFile(store.path, JSON.stringify(foreignSidecar));
    await assert.rejects(store.restore(root), SessionStateCheckpointBaselineError);

    const invalidExecution = JSON.parse(JSON.stringify(original));
    invalidExecution.execution.bundles.push({ version: 1, operationId: 42 });
    signSidecarForTest(invalidExecution);
    await writeFile(store.path, JSON.stringify(invalidExecution));
    await assert.rejects(store.restore(root), SessionStateInvalidStateError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

test("unified Git checkpoint requires its pinned ref; pre-cutover verdict and deliveries do not survive", async () => {
  const root = await initGitRepoForBaselineTest();
  try {
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const captured = await captureReviewCheckpoint(root, "window-unified-git");
    assert.equal(captured.status, "ok");
    if (captured.status !== "ok") return;
    assert.equal(captured.value.kind, "git");
    const state = createState();
    rememberUserRequest(state, "old request");
    beginAgentRun(state);
    setReviewWindowCheckpointBaseline(state, { kind: "checkpoint", descriptor: captured.value, cwd: root, capturedAt: "now" });
    const store = new SessionStateStore({ sessionId: "git-session", sessionFile, cwd: root });
    await store.save(state, { waveRoots: ["execution-root"], bundles: [] }, normalizeConfig({ enabled: true }));
    const original = await readFile(store.path, "utf8");
    assert.equal((await store.restore(root))?.state.reviewWindow?.baseline?.kind, "checkpoint");
    if (captured.value.kind !== "git") return;
    await gitForBaselineTest(root, "update-ref", "-d", captured.value.checkpoint.ref);
    const damaged = await store.restore(root);
    assert.equal(damaged?.reviewCutover, "damaged_checkpoint");
    assert.equal(damaged?.damagedCheckpointReason, "pin_ref_missing");
    assert.equal(damaged?.state.reviewWindow, undefined);
    assert.deepEqual(damaged?.execution.waveRoots, ["execution-root"]);
    assert.equal(await readFile(store.path, "utf8"), original);

    const legacy = JSON.parse(original);
    legacy.version = 3;
    legacy.state.reviewWindow.baseline = { cwd: root, capturedAt: "old", files: [], omissions: [], omissionsTruncated: false };
    legacy.state.reviewWindow.reviewHistory = [{ sequence: 1, source: "automatic", disposition: "sent_for_observation", verdict: "pass", reviewerResults: [] }];
    delete legacy.state.reviewWindow.baseline.omissions;
    delete legacy.state.reviewWindow.baseline.omissionsTruncated;
    delete legacy.reviewerSelectionDigest;
    delete legacy.state.reviewWindow.activeExchange.baseline;
    legacy.state.pendingModelDeliveries = [{ deliveryId: "old", kind: "review_authorization", channel: "follow_up", message: "old pass", status: "queued", createdAt: "now" }];
    signSidecarForTest(legacy);
    await writeFile(store.path, JSON.stringify(legacy));
    const fresh = await store.restore(root);
    assert.equal(fresh?.reviewCutover, "fresh_review_required");
    assert.equal(fresh.state.reviewWindow, undefined);
    assert.equal(fresh.state.pendingModelDeliveries[0]?.status, "cancelled");
    assert.deepEqual(fresh.execution.waveRoots, ["execution-root"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
