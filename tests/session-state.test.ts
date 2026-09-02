import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { queueModelDelivery } from "../src/durable-delivery";
import { createEvidenceState } from "../src/evidence";
import {
  configDigest,
  replaceReviewGateState,
  SESSION_STATE_ENTRY_TYPE,
  SESSION_STATE_QUARANTINE_MARKER,
  SessionStateCwdMismatchError,
  SessionStateInvalidStateError,
  SessionStateParseError,
  SessionStateStore,
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
    const store = new SessionStateStore({ sessionId: "conversation-ledger", sessionFile, cwd: root });
    await store.save(state, { waveRoots: [], bundles: [] });

    const restored = await store.restore(root);
    assert.ok(restored);
    const baseline = restored.state.reviewWindow?.baseline;
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
