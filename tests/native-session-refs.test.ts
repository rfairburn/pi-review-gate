/**
 * Opt-in native Pi session cleanup (#533). These tests pin the safety contract:
 * Off deletes nothing; On deletes only sessions this extension recorded and
 * verified by their own bounded public header; a root the existing ownership
 * guard refuses deletes nothing anywhere; and anything that cannot be verified
 * stays on disk with a disclosed reason instead of losing its only reference.
 */
import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeOwnedExecutionRoot, removeOwnedWaveRoot } from "../src/execution/background-group-store";
import { deleteRecordedNativeSession, deleteRecordedNativeSessions } from "../src/execution/native-session-refs";
import { MAX_SESSION_HEADER_BYTES } from "../src/session-host/saved-sessions";

function headerLine(id: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date("2026-01-01T00:00:00.000Z").toISOString(), cwd: "/work" });
}

async function nativeSession(store: string, id: string, extraBytes = 0): Promise<string> {
  await mkdir(store, { recursive: true });
  const file = join(store, `${id}.jsonl`);
  const tail = extraBytes > 0 ? `\n${"x".repeat(extraBytes)}` : "";
  await writeFile(file, `${headerLine(id)}${tail}\n`, "utf8");
  return file;
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  if ("sessionId" in value) value = { adapter: "pi-model", ...value };
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

/** One wave root whose durable metadata records three sessions in three layouts. */
async function ownedWaveRoot(store: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave-refs-"));
  const taskDir = join(root, "artifacts", "task-0");
  const executorFile = await nativeSession(store, "executor-session");
  const operationFile = await nativeSession(store, "operation-session");
  const reviewerFile = await nativeSession(store, "reviewer-session");
  await writeJson(join(taskDir, "executor", "0001", "process-result.json"), { sessionId: "executor-session", sessionFile: executorFile });
  await writeJson(join(taskDir, "operation.json"), { session: { adapter: "pi-model", id: "operation-session", file: operationFile } });
  // A reviewer pass whose own cleanup point ran while the setting was Off: its
  // only remaining record lives in the published review layout.
  await writeJson(join(taskDir, "reviews", "0001", "reviewers", "r1", "invocation.json"), {
    reviewerId: "r1",
    session: { adapter: "pi-model", id: "reviewer-session", file: reviewerFile },
  });
  return root;
}

test("recorded sessions in every durable layout survive cleanup while the setting is Off", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const root = await ownedWaveRoot(store);
  const foreign = await nativeSession(store, "someone-elses-session");
  try {
    await removeOwnedWaveRoot(await realpath(root));
    for (const id of ["executor-session", "operation-session", "reviewer-session"]) {
      assert.equal(existsSync(join(store, `${id}.jsonl`)), true, `${id} must survive Off cleanup`);
    }
    assert.equal(existsSync(foreign), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("root cleanup deletes exactly the sessions the removed root recorded, including reviewer invocations", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const root = await ownedWaveRoot(store);
  const foreign = await nativeSession(store, "someone-elses-session");
  await writeJson(join(root, "artifacts", "non-pi", "operation.json"), {
    session: { adapter: "codex-appserver", id: "someone-elses-session", file: foreign },
  });
  try {
    const cleanup = await removeOwnedWaveRoot(await realpath(root), true);
    assert.deepEqual(cleanup.refused, []);
    assert.equal(cleanup.deleted, 3);
    for (const id of ["executor-session", "operation-session", "reviewer-session"]) {
      assert.equal(existsSync(join(store, `${id}.jsonl`)), false, `${id} must be deleted`);
    }
    assert.equal(existsSync(foreign), true, "an unreferenced session is never touched");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("a root the ownership guard refuses deletes no sessions outside itself", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  // Named like a root but not a temporary wave/execution root, so the existing
  // guard rejects it; the sessions it references must all survive.
  const impostor = join(process.cwd(), "wave-not-owned");
  const executorFile = await nativeSession(store, "guarded-executor-session");
  await writeJson(join(impostor, "artifacts", "task-0", "executor", "0001", "process-result.json"), {
    sessionId: "guarded-executor-session",
    sessionFile: executorFile,
  });
  const executionImpostor = join(process.cwd(), "pi-review-execution-not-owned");
  await writeJson(join(executionImpostor, "operation.json"), {
    session: { adapter: "pi-model", id: "guarded-executor-session", file: executorFile },
  });
  try {
    await assert.rejects(removeOwnedWaveRoot(impostor, true), /Refusing to remove unrecognized wave root/);
    await assert.rejects(removeOwnedExecutionRoot(executionImpostor, undefined, true), /Refusing to remove unrecognized execution root/);
    assert.equal(existsSync(executorFile), true, "a refused root must leave every referenced session untouched");
    assert.equal(existsSync(join(impostor, "artifacts", "task-0", "executor", "0001", "process-result.json")), true);
  } finally {
    await rm(impostor, { recursive: true, force: true });
    await rm(executionImpostor, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("unverifiable sessions are refused with a reason and stay on disk", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const root = await mkdtemp(join(tmpdir(), "wave-refs-"));
  const taskDir = join(root, "artifacts", "task-0");
  const mismatched = await nativeSession(store, "recorded-id");
  await writeFile(mismatched, `${headerLine("a-different-session")}\n`, "utf8");
  const real = await nativeSession(store, "linked-target-session");
  const symlinked = join(store, "symlinked-session.jsonl");
  await symlink(real, symlinked);
  await writeJson(join(taskDir, "executor", "0001", "process-result.json"), { sessionId: "recorded-id", sessionFile: mismatched });
  await writeJson(join(taskDir, "executor", "0002", "process-result.json"), { sessionId: "linked-target-session", sessionFile: symlinked });
  // An already-deleted session is already cleaned, not a refusal.
  await writeJson(join(taskDir, "executor", "0003", "process-result.json"), {
    sessionId: "gone-session",
    sessionFile: join(store, "gone-session.jsonl"),
  });
  try {
    const cleanup = await deleteRecordedNativeSessions(root);
    assert.equal(cleanup.deleted, 1, "only the already-absent session counts as cleaned");
    assert.equal(cleanup.refused.length, 2);
    assert.match(cleanup.refused.join("\n"), /records a different session id/);
    assert.match(cleanup.refused.join("\n"), /not a regular file/);
    assert.equal(existsSync(mismatched), true);
    assert.equal(await lstat(symlinked).then((info) => info.isSymbolicLink()), true);
    assert.equal(existsSync(real), true, "the symlink target is never followed or deleted");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("identity verification reads only the bounded header, never the transcript", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const root = await mkdtemp(join(tmpdir(), "wave-refs-"));
  const taskDir = join(root, "artifacts", "task-0");
  // Same header, wildly different transcript size: the same bounded read decides
  // both, so a 500 MB session costs no more than a 100 byte one.
  const small = await nativeSession(store, "small-session");
  const huge = await nativeSession(store, "huge-session", 4 * 1024 * 1024);
  // The recorded id appears only past the bounded header window, so a reader
  // that scanned the file would "find" it. The bounded reader refuses instead.
  const buriedStore = join(store, "buried");
  await mkdir(buriedStore, { recursive: true });
  const buried = join(buriedStore, "buried-session.jsonl");
  await writeFile(buried, `${JSON.stringify({ type: "message", text: "y".repeat(MAX_SESSION_HEADER_BYTES) })}\n${headerLine("buried-session")}\n`, "utf8");
  await writeJson(join(taskDir, "executor", "0001", "process-result.json"), { sessionId: "small-session", sessionFile: small });
  await writeJson(join(taskDir, "executor", "0002", "process-result.json"), { sessionId: "huge-session", sessionFile: huge });
  await writeJson(join(taskDir, "executor", "0003", "process-result.json"), { sessionId: "buried-session", sessionFile: buried });
  const reads = t.mock.method(fs, "readSync");
  try {
    const cleanup = await deleteRecordedNativeSessions(root);
    assert.equal(cleanup.deleted, 2, "both bounded headers verified regardless of transcript size");
    assert.equal(existsSync(small), false);
    assert.equal(existsSync(huge), false);
    assert.equal(cleanup.refused.length, 1);
    assert.match(cleanup.refused[0] ?? "", /no verifiable bounded session header/);
    assert.equal(existsSync(buried), true, "a file whose header window does not verify is left alone");
    const bytesRead = reads.mock.calls.reduce((total, call) => total + Number(call.result ?? 0), 0);
    assert.ok(bytesRead > 0 && bytesRead <= 3 * MAX_SESSION_HEADER_BYTES, "identity reads stay bounded across all three files");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("a reviewer cleanup point deletes only its own verified session", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const own = await nativeSession(store, "reviewer-own");
  const sibling = await nativeSession(store, "reviewer-sibling");
  try {
    assert.deepEqual(await deleteRecordedNativeSession({ id: "reviewer-own", file: own }), { deleted: true });
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(sibling), true);
    // No recorded reference is nothing to do, and never a refusal.
    assert.deepEqual(await deleteRecordedNativeSession({ id: "x" }), { deleted: false });
    const refused = await deleteRecordedNativeSession({ id: "wrong-id", file: sibling });
    assert.equal(refused.deleted, false);
    assert.match(refused.refusal ?? "", /records a different session id/);
    assert.equal(existsSync(sibling), true);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

/**
 * A reviewer question publishes its only session reference under
 * `questions/<pass>/reviewers/<id>/invocation.json`, with no `sessions.json`
 * entry to mask an omission, so that layout must be collected too.
 */
test("a question-only invocation reference survives Off and is deleted by a later On cleanup", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const file = await nativeSession(store, "question-session");
  const questionRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "wave-refs-"));
    await writeJson(join(root, "artifacts", "task-0", "questions", "0001", "reviewers", "q1", "invocation.json"), {
      reviewerId: "q1",
      session: { adapter: "pi-model", id: "question-session", file },
    });
    return root;
  };
  const offRoot = await questionRoot();
  try {
    // Off (the default): removing the records leaves the session in Pi's store.
    await removeOwnedWaveRoot(await realpath(offRoot));
    assert.equal(existsSync(file), true, "Off cleanup never deletes a question session");

    // On, later: the same record in another removed root is deletion authority.
    const onRoot = await questionRoot();
    try {
      const cleanup = await removeOwnedWaveRoot(await realpath(onRoot), true);
      assert.deepEqual(cleanup.refused, []);
      assert.equal(cleanup.deleted, 1);
      assert.equal(existsSync(file), false, "the question session is deleted with its last reference");
    } finally {
      await rm(onRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(offRoot, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("symlinked roots and artifact directories grant no deletion authority", async () => {
  const canonicalTmp = await realpath(tmpdir());
  const store = await mkdtemp(join(tmpdir(), "pi-native-store-"));
  const foreign = await nativeSession(store, "foreign-session");
  // A real directory holding valid metadata, reached only through a link.
  const target = await mkdtemp(join(tmpdir(), "wave-target-"));
  await writeJson(join(target, "artifacts", "task-0", "executor", "0001", "process-result.json"), {
    sessionId: "foreign-session",
    sessionFile: foreign,
  });
  const linkedRoot = join(canonicalTmp, `wave-linked-${process.pid}-${Date.now()}`);
  await symlink(target, linkedRoot);
  // A real root whose `executor` layout directory is a link out of the root.
  const realRoot = await mkdtemp(join(tmpdir(), "wave-refs-"));
  const foreignLayout = await mkdtemp(join(tmpdir(), "pi-foreign-layout-"));
  await writeJson(join(foreignLayout, "0001", "process-result.json"), {
    sessionId: "foreign-session",
    sessionFile: foreign,
  });
  await mkdir(join(realRoot, "artifacts", "task-0"), { recursive: true });
  await symlink(foreignLayout, join(realRoot, "artifacts", "task-0", "executor"));
  try {
    // The existing guard accepts a symlink named like a wave root; the
    // collector must still refuse it, and removal must drop only the link.
    const cleanup = await removeOwnedWaveRoot(linkedRoot, true);
    assert.equal(cleanup.deleted, 0);
    assert.match(cleanup.refused.join("\n"), /is not a real artifact directory/);
    assert.equal(existsSync(foreign), true, "a symlinked root deletes no foreign sessions");
    assert.equal(existsSync(join(target, "artifacts", "task-0", "executor", "0001", "process-result.json")), true);
    assert.equal(existsSync(linkedRoot), false, "only the link itself is removed, as before");

    const nested = await deleteRecordedNativeSessions(await realpath(realRoot));
    assert.equal(nested.deleted, 0, "a symlinked layout directory is not collected");
    assert.equal(existsSync(foreign), true, "a symlinked executor directory deletes no foreign sessions");
    assert.equal(existsSync(join(foreignLayout, "0001", "process-result.json")), true);
  } finally {
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(realRoot, { recursive: true, force: true });
    await rm(foreignLayout, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
