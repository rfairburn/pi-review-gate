/**
 * Issue #533 (cleanup slice): the opt-in `deleteSpawnedPiSessionsOnCleanup`
 * toggle is bound to cleanup that ALREADY selects an artifact.
 *
 * These cases pin the binding, not a new selection surface: default Off keeps
 * every canonical native history, On deletes only the exact histories the
 * already-removed bundle/wave/execution artifacts reference, and retained,
 * protected, unverifiable, or unrelated sessions are never touched. Fixtures
 * use isolated synthetic native stores; no shared store, credentials, or live
 * session is involved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeReviewBundle, removeTransientWindowBundle } from "../src/bundle";
import { replaceConfig } from "../src/settings/persistence";
import { DEFAULT_CONFIG } from "../src/config";
import { removeOwnedExecutionRoot, removeOwnedWaveRoot } from "../src/execution/background-group-store";
import { BackgroundExecutionController, INLINE_SETTLED_TASK_LIMIT } from "../src/execution/background-controller";
import { createState } from "../src/state";
import { pruneCompletedWaveRoots } from "../src/execution/wave-repository";
import {
  deleteAbandonedReviewerSetPiSessions,
  deleteOwnedRootPiSessions,
  deleteReviewerStagingPiSessions,
  PiSessionCleanupError,
  removeArtifactRetainingOnSessionCleanupFailure,
} from "../src/pi-session-cleanup";
import { PI_SESSION_REFERENCE_DIRNAME, writePiSessionReference } from "../src/pi-session-reference";
import {
  boundedScalingConfig,
  collidingTaskRecord,
  controllerInternals,
  initGitRepo,
  settleOldestUnsettled,
  writePersistedExecutionGroupTasks,
} from "./helpers/background-controller-fixtures";

/** The locked-directory fixture cannot fail for an unprivileged unlink only: root deletes inside a read-only directory. */
function skipIfRoot(t: { skip(message?: string): void }): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root can unlink inside a read-only directory");
    return true;
  }
  return false;
}

let sequence = 0;

function sessionId(tag: string): string {
  sequence += 1;
  return `${tag}-${sequence}-session`;
}

async function scratch(prefix = "pi-session-cleanup-"): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

/** Minimal native Pi transcript whose first-line header carries the identity. */
async function nativeSession(input: { store: string; id: string; cwd: string }): Promise<string> {
  await mkdir(input.store, { recursive: true });
  const file = join(input.store, `${input.id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: input.id, timestamp: "2025-06-01T10:00:00.000Z", cwd: input.cwd },
    {
      type: "message",
      id: "m-1",
      parentId: null,
      timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
    },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

/** Record one canonical reference in an owner artifact, returning its native file. */
async function ownerReference(input: {
  ownerDir: string;
  store: string;
  cwd: string;
  id?: string;
}): Promise<{ id: string; file: string }> {
  const id = input.id ?? sessionId("s");
  const file = await nativeSession({ store: input.store, id, cwd: input.cwd });
  const written = await writePiSessionReference(input.ownerDir, { id, file, cwd: input.cwd });
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  return { id, file };
}

/** A real, owned `wave-*` root in the default temporary root. */
async function waveRoot(prefix: string, artifacts: readonly string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  for (const artifact of artifacts) await mkdir(join(root, "artifacts", artifact), { recursive: true });
  return root;
}

test("default Off keeps the exact native histories while existing cleanup removes the artifacts", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    const bundle = join(root, "pi-review-gate-bundle");
    const reviewer = await ownerReference({
      ownerDir: join(bundle, "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    const window = { bundleDir: bundle, retainBundleAfterClose: false };
    await removeTransientWindowBundle(window);
    assert.equal(await exists(bundle), false, "the existing prompt-boundary removal still happens");
    assert.equal(await exists(reviewer.file), true, "default Off preserves the canonical reviewer history");

    const wave = await waveRoot("wave-cleanup-off-", ["task-1"]);
    const worker = await ownerReference({ ownerDir: join(wave, "artifacts", "task-1"), store, cwd: workspace });
    await removeOwnedWaveRoot(wave);
    assert.equal(await exists(wave), false, "the existing wave-root removal still happens");
    assert.equal(await exists(worker.file), true, "default Off preserves the worker's canonical history");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("On deletes exactly the removed bundle's reviewer histories for every pass and invocation kind", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const bundle = join(root, "pi-review-gate-bundle");
    const firstPass = await ownerReference({
      ownerDir: join(bundle, "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    const secondPass = await ownerReference({
      ownerDir: join(bundle, "reviews", "002", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    const questionPass = await ownerReference({
      ownerDir: join(bundle, "questions", "001", "reviewers", "bob"),
      store,
      cwd: workspace,
    });
    // Unrelated histories: a sibling bundle's reviewer session, the primary
    // session file, and a non-Pi file in the same store directory.
    const sibling = await ownerReference({
      ownerDir: join(root, "pi-review-gate-other", "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    const primary = await nativeSession({ store, id: sessionId("primary"), cwd: workspace });
    const nonPi = join(store, "notes.txt");
    await writeFile(nonPi, "not a session\n", "utf8");

    await removeReviewBundle(bundle, { deleteSpawnedPiSessions: true });

    assert.equal(await exists(bundle), false, "the bundle itself is removed exactly as before");
    for (const pass of [firstPass, secondPass, questionPass]) {
      assert.equal(await exists(pass.file), false, `associated history ${pass.id} was deleted`);
    }
    assert.equal(await exists(sibling.file), true, "a sibling bundle's history is untouched");
    assert.equal(await exists(primary), true, "the primary session is untouched");
    assert.equal(await exists(nonPi), true, "non-Pi files are never touched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("On deletes worker histories of the removed wave root only, including multiple references per task", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const wave = await waveRoot("wave-cleanup-on-", ["task-1", "task-2"]);
    const turnOne = await ownerReference({ ownerDir: join(wave, "artifacts", "task-1"), store, cwd: workspace });
    const turnTwo = await ownerReference({ ownerDir: join(wave, "artifacts", "task-1"), store, cwd: workspace });
    const second = await ownerReference({ ownerDir: join(wave, "artifacts", "task-2"), store, cwd: workspace });
    const unrelated = await nativeSession({ store, id: sessionId("unrelated"), cwd: workspace });

    await removeOwnedWaveRoot(wave, { deleteSpawnedPiSessions: true });

    assert.equal(await exists(wave), false);
    for (const worker of [turnOne, turnTwo, second]) {
      assert.equal(await exists(worker.file), false, `associated history ${worker.id} was deleted`);
    }
    assert.equal(await exists(unrelated), true, "a session no removed artifact references is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("On deletes only the retired execution root's own artifact histories", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const retired = await waveRoot("pi-review-execution-retired-", ["task-9"]);
    const kept = await waveRoot("pi-review-execution-kept-", ["task-9"]);
    const retiredSession = await ownerReference({ ownerDir: join(retired, "artifacts", "task-9"), store, cwd: workspace });
    const keptSession = await ownerReference({ ownerDir: join(kept, "artifacts", "task-9"), store, cwd: workspace });

    await removeOwnedExecutionRoot(retired, undefined, { deleteSpawnedPiSessions: true });

    assert.equal(await exists(retired), false);
    assert.equal(await exists(retiredSession.file), false);
    assert.equal(await exists(kept), true, "another owned root is not selected by this retirement");
    assert.equal(await exists(keptSession.file), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained, ineligible, and protected artifacts keep their sessions even On", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    // Retained bundle: the existing retention decision still wins.
    const retained = join(root, "pi-review-gate-retained");
    const retainedSession = await ownerReference({
      ownerDir: join(retained, "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    const window = { bundleDir: retained, retainBundleAfterClose: true };
    await removeTransientWindowBundle(window, { deleteSpawnedPiSessions: true });
    assert.equal(await exists(retained), true);
    assert.equal(await exists(retainedSession.file), true, "a retained bundle keeps its history");

    // An unrecognized root is refused by the existing ownership guard, so its
    // sessions are never reached.
    const foreign = join(root, "wave-not-owned");
    const foreignSession = await ownerReference({ ownerDir: join(foreign, "artifacts", "task-1"), store, cwd: workspace });
    await assert.rejects(removeOwnedWaveRoot(foreign, { deleteSpawnedPiSessions: true }), /Refusing to remove unrecognized wave root/);
    assert.equal(await exists(foreign), true);
    assert.equal(await exists(foreignSession.file), true);

    // TTL selection: a recovery-required root is protected and keeps its history.
    const parent = await scratch("pi-wave-gc-");
    try {
      const recovery = join(parent, "wave-recovery");
      await mkdir(join(recovery, "wave-repo.git"), { recursive: true });
      await writeFile(join(recovery, "wave-manifest.json"), JSON.stringify({
        version: 1,
        phase: "completed",
        repositoryPath: join(recovery, "wave-repo.git"),
        landingStatus: "recovery_required",
      }));
      const recoverySession = await ownerReference({ ownerDir: join(recovery, "artifacts", "task-1"), store, cwd: workspace });
      const old = new Date(Date.now() - 10_000);
      await utimes(recovery, old, old);
      assert.deepEqual(await pruneCompletedWaveRoots(parent, 1_000, Date.now(), undefined, { deleteSpawnedPiSessions: true }), []);
      assert.equal(await exists(recovery), true);
      assert.equal(await exists(recoverySession.file), true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TTL pruning deletes the expired root's sessions and leaves newer or protected roots alone", async () => {
  const root = await scratch("pi-wave-gc-on-");
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    for (const name of ["wave-expired", "wave-recovery", "wave-recent"]) {
      await mkdir(join(root, name, "wave-repo.git"), { recursive: true });
      await writeFile(join(root, name, "wave-manifest.json"), JSON.stringify({
        version: 1,
        phase: "completed",
        repositoryPath: join(root, name, "wave-repo.git"),
        landingStatus: name === "wave-recovery" ? "recovery_required" : "landed",
      }));
    }
    const expired = await ownerReference({ ownerDir: join(root, "wave-expired", "artifacts", "task-1"), store, cwd: workspace });
    const recovery = await ownerReference({ ownerDir: join(root, "wave-recovery", "artifacts", "task-1"), store, cwd: workspace });
    const recent = await ownerReference({ ownerDir: join(root, "wave-recent", "artifacts", "task-1"), store, cwd: workspace });
    const old = new Date(Date.now() - 10_000);
    await utimes(join(root, "wave-expired"), old, old);
    await utimes(join(root, "wave-recovery"), old, old);

    assert.deepEqual(
      await pruneCompletedWaveRoots(root, 1_000, Date.now(), undefined, { deleteSpawnedPiSessions: true }),
      [join(root, "wave-expired")],
    );
    assert.equal(await exists(expired.file), false, "the TTL-selected root's history is deleted with it");
    assert.equal(await exists(recovery.file), true, "a protected root keeps its history");
    assert.equal(await exists(recent.file), true, "a root the existing TTL selector keeps keeps its history");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unverifiable or foreign references are preserved, never guessed at", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const bundle = join(root, "pi-review-gate-bundle");

    // Header id does not match the reference: preserved.
    const mismatchedId = sessionId("recorded");
    const mismatchedOwner = join(bundle, "reviews", "001", "reviewers", "alice");
    const otherFile = await nativeSession({ store, id: sessionId("actual"), cwd: workspace });
    const mismatched = await writePiSessionReference(mismatchedOwner, { id: mismatchedId, file: otherFile, cwd: workspace });
    assert.equal(mismatched.ok, true);

    // A reference whose native file is already gone: nothing to delete, no failure.
    const missingOwner = join(bundle, "reviews", "002", "reviewers", "alice");
    const missing = await writePiSessionReference(missingOwner, {
      id: sessionId("missing"),
      file: join(store, "already-gone.jsonl"),
      cwd: workspace,
    });
    assert.equal(missing.ok, true);

    // A reviewer reference directory that is a symlink is not an owned layout:
    // nothing is read through it.
    const foreignStore = join(root, "foreign-store");
    const foreignOwner = join(bundle, "reviews", "003", "reviewers", "mallory");
    const foreign = await ownerReference({ ownerDir: foreignOwner, store: foreignStore, cwd: workspace });
    await rm(join(foreignOwner, PI_SESSION_REFERENCE_DIRNAME), { recursive: true, force: true });
    await symlink(join(foreignStore, "elsewhere"), join(foreignOwner, PI_SESSION_REFERENCE_DIRNAME));
    await mkdir(join(foreignStore, "elsewhere"), { recursive: true });
    await writeFile(
      join(foreignStore, "elsewhere", `${foreign.id}.json`),
      `${JSON.stringify({ id: foreign.id, file: foreign.file, cwd: workspace }, null, 2)}\n`,
      "utf8",
    );

    await removeReviewBundle(bundle, { deleteSpawnedPiSessions: true });

    assert.equal(await exists(bundle), false, "a skipped reference never blocks the existing removal");
    assert.equal(await exists(otherFile), true, "an id-mismatched history is preserved");
    assert.equal(await exists(foreign.file), true, "a symlinked reference directory is never followed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a canceled pass discards its staged sessions only when On, before the staging directory goes", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const offStaging = join(root, "pi-review-gate-reviewer-off");
    const onStaging = join(root, "pi-review-gate-reviewer-on");
    const kept = await ownerReference({ ownerDir: offStaging, store, cwd: workspace });
    const discarded = await ownerReference({ ownerDir: onStaging, store, cwd: workspace });
    const unrelated = await nativeSession({ store, id: sessionId("primary"), cwd: workspace });

    // Default Off: the existing staging discard removes artifacts only.
    assert.deepEqual(await deleteReviewerStagingPiSessions(offStaging, {}), []);
    await rm(offStaging, { recursive: true, force: true });
    assert.equal(await exists(kept.file), true, "an Off cancellation keeps the native history");

    // On: the exact staged session is deleted at the same cleanup, before the
    // staging directory that holds its reference is removed.
    assert.deepEqual(await deleteReviewerStagingPiSessions(onStaging, { deleteSpawnedPiSessions: true }), []);
    assert.equal(await exists(discarded.file), false);
    await rm(onStaging, { recursive: true, force: true });
    assert.equal(await exists(join(onStaging, PI_SESSION_REFERENCE_DIRNAME)), false);
    assert.equal(await exists(unrelated), true, "an unrelated session is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed publication deletes only the abandoned staged set's sessions when On", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const invocation = join(root, "pi-review-gate-bundle", "reviews", "001");
    const abandoned = join(invocation, ".reviewers-abandoned");
    const abandonedSession = await ownerReference({ ownerDir: join(abandoned, "alice"), store, cwd: workspace });
    // A set published by an earlier successful pass is not abandoned here.
    const published = await ownerReference({ ownerDir: join(invocation, "reviewers", "alice"), store, cwd: workspace });

    // Default Off: the abandoned set's histories survive the discard.
    assert.deepEqual(await deleteAbandonedReviewerSetPiSessions(abandoned, {}), []);
    assert.equal(await exists(abandonedSession.file), true);

    assert.deepEqual(await deleteAbandonedReviewerSetPiSessions(abandoned, { deleteSpawnedPiSessions: true }), []);
    assert.equal(await exists(abandonedSession.file), false, "the abandoned set's session is deleted");
    assert.equal(await exists(published.file), true, "an already-published pass's session is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked owned-looking root is never traversed, so the target's sessions survive", async () => {
  const root = await scratch();
  const links: string[] = [];
  const waveRoots: string[] = [];
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const target = await waveRoot("wave-cleanup-symlink-target-", ["task-1"]);
    waveRoots.push(target);
    const targetSession = await ownerReference({ ownerDir: join(target, "artifacts", "task-1"), store, cwd: workspace });

    // An owned-looking `wave-*` symlink passes the existing lexical ownership
    // guard; the removal itself would only unlink the symlink.
    const link = join(await realpath(tmpdir()), `wave-cleanup-symlink-${process.pid}-${sequence}`);
    links.push(link);
    await symlink(target, link);

    const direct = await deleteOwnedRootPiSessions(link);
    assert.deepEqual(direct.deleted, [], "no session is deleted through the symlink");
    assert.match(direct.preserved[0]?.reason ?? "", /symlink/);

    await removeOwnedWaveRoot(link, { deleteSpawnedPiSessions: true });
    assert.equal(await exists(link), false, "the existing removal still unlinks the selected root");
    assert.equal(await exists(target), true, "the symlink target's artifacts are untouched");
    assert.equal(await exists(targetSession.file), true, "the symlink target's history is untouched");

    // Same root-validation for a symlinked bundle and a symlinked staging owner.
    const realBundle = join(root, "pi-review-gate-bundle");
    const bundleSession = await ownerReference({
      ownerDir: join(realBundle, "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    const bundleLink = join(root, "linked-bundle");
    await symlink(realBundle, bundleLink);
    await removeReviewBundle(bundleLink, { deleteSpawnedPiSessions: true });
    assert.equal(await exists(bundleLink), false);
    assert.equal(await exists(realBundle), true);
    assert.equal(await exists(bundleSession.file), true);

    const realStaging = join(root, "pi-review-gate-reviewer-real");
    const stagingSession = await ownerReference({ ownerDir: realStaging, store, cwd: workspace });
    const stagingLink = join(root, "pi-review-gate-reviewer-linked");
    await symlink(realStaging, stagingLink);
    assert.deepEqual(await deleteReviewerStagingPiSessions(stagingLink, { deleteSpawnedPiSessions: true }), []);
    assert.equal(await exists(stagingSession.file), true, "a symlinked staging owner is never followed");
  } finally {
    for (const link of links) await rm(link, { force: true }).catch(() => undefined);
    for (const wave of waveRoots) await rm(wave, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("only a native .jsonl is deleted; a matching-header backup file is preserved", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const bundle = join(root, "pi-review-gate-bundle");
    const owner = join(bundle, "reviews", "001", "reviewers", "alice");
    const session = await ownerReference({ ownerDir: owner, store, cwd: workspace });
    // A backup copy whose native header still proves the same id and workspace.
    const backupId = sessionId("backup");
    const backupFile = join(store, `${backupId}.jsonl.bak`);
    await writeFile(backupFile, `${JSON.stringify({ type: "session", version: 3, id: backupId, timestamp: "2025-06-01T10:00:00.000Z", cwd: workspace })}\n`, "utf8");
    const backupReference = await writePiSessionReference(owner, { id: backupId, file: backupFile, cwd: workspace });
    assert.equal(backupReference.ok, true);

    await removeReviewBundle(bundle, { deleteSpawnedPiSessions: true });

    assert.equal(await exists(bundle), false, "the existing bundle removal is unchanged");
    assert.equal(await exists(session.file), false, "the exact native .jsonl is deleted");
    assert.equal(await exists(backupFile), true, "a non-.jsonl target is never deleted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabling the setting is not itself a cleanup", async () => {
  const root = await scratch();
  try {
    const store = join(root, "native-store");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const bundle = join(root, "pi-review-gate-bundle");
    const session = await ownerReference({
      ownerDir: join(bundle, "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });

    const live = structuredClone(DEFAULT_CONFIG);
    assert.equal(live.deleteSpawnedPiSessionsOnCleanup, false, "the toggle defaults off");
    replaceConfig(live, { ...live, deleteSpawnedPiSessionsOnCleanup: true });

    assert.equal(live.deleteSpawnedPiSessionsOnCleanup, true);
    assert.equal(await exists(bundle), true, "no artifact is removed by enabling the setting");
    assert.equal(await exists(session.file), true, "no history is deleted by enabling the setting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deletion failure keeps the root, surfaces the error, and leaves its references intact", async (t) => {
  if (skipIfRoot(t)) return;
  const root = await scratch();
  const locked = join(root, "locked-store");
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const wave = await waveRoot("wave-cleanup-failure-", ["task-1"]);
    const worker = await ownerReference({ ownerDir: join(wave, "artifacts", "task-1"), store: locked, cwd: workspace });
    await chmod(locked, 0o500);

    await assert.rejects(
      removeOwnedWaveRoot(wave, { deleteSpawnedPiSessions: true }),
      /spawned Pi session cleanup failed/,
    );
    assert.equal(await exists(wave), true, "a root whose sessions could not be deleted is retained");
    assert.equal(await exists(worker.file), true);
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * #533 final review F1: the opt-in deletion must never turn a benign native-store
 * hiccup into lost shutdown persistence. The failure is typed, the selected
 * artifact stays retained with its references, and a shutdown-bound caller can
 * disclose it while finishing its own finalization.
 */
test("a spawned-session deletion failure is a typed cleanup failure a shutdown caller can tolerate", async (t) => {
  if (skipIfRoot(t)) return;
  const root = await scratch();
  const locked = join(root, "locked-store");
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const wave = await waveRoot("wave-cleanup-typed-", ["task-1"]);
    const worker = await ownerReference({ ownerDir: join(wave, "artifacts", "task-1"), store: locked, cwd: workspace });
    // The same contract for a review bundle: retained, disclosed, references intact.
    const bundle = join(root, "pi-review-gate-bundle");
    const reviewer = await ownerReference({
      ownerDir: join(bundle, "reviews", "001", "reviewers", "alice"),
      store: locked,
      cwd: workspace,
    });
    await chmod(locked, 0o500);

    // The removal's own error path is unchanged, and it is now distinguishable.
    const thrown = await removeOwnedWaveRoot(wave, { deleteSpawnedPiSessions: true }).catch((error: unknown) => error);
    assert.ok(thrown instanceof PiSessionCleanupError, "an undeletable referenced session raises PiSessionCleanupError");
    assert.match((thrown as Error).message, /spawned Pi session cleanup failed/);
    assert.equal((thrown as PiSessionCleanupError).failures.length, 1);
    assert.equal(await exists(wave), true, "a root whose sessions could not be deleted stays retained");

    // A shutdown-bound caller discloses exactly that failure and keeps going.
    const disclosed: string[] = [];
    const removed = await removeArtifactRetainingOnSessionCleanupFailure(
      () => removeOwnedWaveRoot(wave, { deleteSpawnedPiSessions: true }),
      (error) => {
        disclosed.push(error.message);
      },
    );
    assert.equal(removed, false, "the artifact was retained instead of removed");
    assert.equal(disclosed.length, 1, "the failure is disclosed once");
    assert.ok((disclosed[0] ?? "").includes(worker.file), "the disclosure names the exact session file");
    assert.equal(await exists(wave), true);
    assert.equal(await exists(worker.file), true, "the undeletable history and its reference survive for a retry");

    const bundleDisclosed: string[] = [];
    assert.equal(await removeArtifactRetainingOnSessionCleanupFailure(
      () => removeReviewBundle(bundle, { deleteSpawnedPiSessions: true }),
      (error) => {
        bundleDisclosed.push(error.message);
      },
    ), false);
    assert.match(bundleDisclosed.join("\n"), /spawned Pi session cleanup failed/);
    assert.equal(await exists(bundle), true, "the bundle keeps its references while a session survives");
    assert.equal(await exists(reviewer.file), true);
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("only the session-cleanup failure is tolerated: refusals and artifact removal failures still propagate", async (t) => {
  if (skipIfRoot(t)) return;
  const root = await scratch();
  const readOnlyParent = join(root, "read-only-parent");
  try {
    const workspace = join(root, "workspace");
    const store = join(root, "native-store");
    await mkdir(workspace, { recursive: true });

    // The existing ownership guard is a plain error: nothing is swallowed.
    const foreign = join(root, "wave-not-owned");
    await mkdir(join(foreign, "artifacts", "task-1"), { recursive: true });
    const refused: string[] = [];
    await assert.rejects(
      removeArtifactRetainingOnSessionCleanupFailure(
        () => removeOwnedWaveRoot(foreign, { deleteSpawnedPiSessions: true }),
        (error) => {
          refused.push(error.message);
        },
      ),
      /Refusing to remove unrecognized wave root/,
    );
    assert.deepEqual(refused, [], "an ownership refusal is never reported as session cleanup");

    // The artifact's own `rm` failure is likewise untouched fail-closed behavior:
    // the eligible session deletion happens first, then the error propagates.
    const bundle = join(readOnlyParent, "pi-review-gate-bundle");
    const session = await ownerReference({
      ownerDir: join(bundle, "reviews", "001", "reviewers", "alice"),
      store,
      cwd: workspace,
    });
    await chmod(readOnlyParent, 0o500);
    const disclosed: string[] = [];
    await assert.rejects(
      removeArtifactRetainingOnSessionCleanupFailure(
        () => removeReviewBundle(bundle, { deleteSpawnedPiSessions: true }),
        (error) => {
          disclosed.push(error.message);
        },
      ),
      (error: unknown) => !(error instanceof PiSessionCleanupError) && /EACCES|EPERM/.test(String(error)),
    );
    assert.deepEqual(disclosed, [], "an artifact-removal failure is never reported as session cleanup");
    assert.equal(await exists(session.file), false, "the deletion the option already selected still happened");
  } finally {
    await chmod(readOnlyParent, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown cleanup discloses a spawned-session deletion failure instead of aborting the shutdown sequence", async (t) => {
  if (skipIfRoot(t)) return;
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-cleanup-controller-"));
  const messages: string[] = [];
  const lockedStores: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const config = boundedScalingConfig();
    config.deleteSpawnedPiSessionsOnCleanup = true;
    controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => {
        messages.push(message);
      },
    });
    const started = await controller.start([{ title: "cleanup target", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = controllerInternals(controller);
    const task = internals.groups.get(started.executionId)!.tasks[0]!;

    // A real owned wave root whose one referenced session cannot be unlinked.
    const locked = join(root, "locked-store");
    lockedStores.push(locked);
    const wave = await waveRoot("wave-cleanup-shutdown-", [task.taskId]);
    const worker = await ownerReference({ ownerDir: join(wave, "artifacts", task.taskId), store: locked, cwd: root });
    await chmod(locked, 0o500);
    task.waveRoot = wave;
    await settleOldestUnsettled(controller, started.executionId, "cleanup target settled");

    // F1: the cleanup the shutdown sequence awaits resolves and discloses.
    await controller.cleanupSettledArtifacts();
    assert.match(messages.join("\n"), /review gate: spawned Pi session cleanup failed/);
    assert.equal(await exists(wave), true, "the wave root is retained with its references");
    assert.equal(await exists(worker.file), true, "the undeletable history survives");
    assert.equal(await exists(started.root), true, "the execution root survives while its work is still referenced");
    assert.equal(internals.groups.has(started.executionId), true, "the retained group keeps its ownership bookkeeping");
    const retained = internals.groups.get(started.executionId)!.tasks[0]!;
    assert.equal(retained.waveRoot, wave, "the retained root keeps its recorded pointer");
    assert.equal(retained.bundle, undefined, "the settled task's other bookkeeping is unchanged");
    const associations = controller.associations();
    assert.ok(associations.waveRoots.includes(wave), "the retained wave root stays associated");
    assert.ok(associations.groupRoots?.includes(started.root), "the retained execution root stays associated");

    // The remaining shutdown steps still run: before the fix this rejected from
    // the cleanup and skipped the persistence, indicator, and detach work.
    await controller.shutdown();
    await controller.detach();
  } finally {
    for (const store of lockedStores) await chmod(store, 0o700).catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrecognized wave root still aborts shutdown cleanup instead of being disclosed away", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-cleanup-refusal-"));
  const messages: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const config = boundedScalingConfig();
    config.deleteSpawnedPiSessionsOnCleanup = true;
    controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => {
        messages.push(message);
      },
    });
    const started = await controller.start([{ title: "refusal target", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = controllerInternals(controller);
    const task = internals.groups.get(started.executionId)!.tasks[0]!;
    const foreign = join(root, "wave-not-owned");
    await mkdir(join(foreign, "artifacts", task.taskId), { recursive: true });
    task.waveRoot = foreign;
    await settleOldestUnsettled(controller, started.executionId, "refusal target settled");

    await assert.rejects(
      controller.cleanupSettledArtifacts(),
      /Refusing to remove unrecognized wave root/,
    );
    assert.deepEqual(messages, [], "a pre-existing fail-closed error is not downgraded to a notice");
    assert.equal(await exists(foreign), true);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained execution root keeps its group instead of aborting shutdown cleanup", async (t) => {
  if (skipIfRoot(t)) return;
  const root = await mkdtemp(join(tmpdir(), "pi-review-session-cleanup-group-"));
  const messages: string[] = [];
  let controller: BackgroundExecutionController | undefined;
  const lockedStores: string[] = [];
  try {
    await initGitRepo(root);
    const config = boundedScalingConfig();
    config.deleteSpawnedPiSessionsOnCleanup = true;
    controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
      notify: (message) => {
        messages.push(message);
      },
    });
    const started = await controller.start([{ title: "group target", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = controllerInternals(controller);
    const task = internals.groups.get(started.executionId)!.tasks[0]!;
    // The execution root's own task artifact references one undeletable session.
    const locked = join(root, "locked-store");
    lockedStores.push(locked);
    const owner = await ownerReference({ ownerDir: join(started.root, "artifacts", task.taskId), store: locked, cwd: root });
    await chmod(locked, 0o500);
    await settleOldestUnsettled(controller, started.executionId, "group target settled");

    await controller.cleanupSettledArtifacts();
    assert.match(messages.join("\n"), /review gate: spawned Pi session cleanup failed/);
    assert.equal(await exists(owner.file), true);
    assert.equal(await exists(started.root), true, "an execution root with a surviving history is retained");
    assert.equal(internals.groups.has(started.executionId), true, "retirement bookkeeping is deferred, not faked");
    assert.ok(controller.associations().groupRoots?.includes(started.root), "the group keeps its durable association");

    await controller.shutdown();
    await controller.detach();
  } finally {
    for (const store of lockedStores) await chmod(store, 0o700).catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an archived task's undeletable session retains its wave root and the archive that owns it", async (t) => {
  if (skipIfRoot(t)) return;
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-archived-session-workspace-"));
  const groupRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-review-execution-archived-session-")));
  const stuckWave = await waveRoot("wave-archived-stuck-", ["task-legacy-0"]);
  const freeWave = await waveRoot("wave-archived-free-", ["task-legacy-1"]);
  const locked = join(workspace, "locked-store");
  const freeStore = join(workspace, "free-store");
  let restored: BackgroundExecutionController | undefined;
  try {
    const stuck = await ownerReference({ ownerDir: join(stuckWave, "artifacts", "task-legacy-0"), store: locked, cwd: workspace });
    const free = await ownerReference({ ownerDir: join(freeWave, "artifacts", "task-legacy-1"), store: freeStore, cwd: workspace });
    await chmod(locked, 0o500);

    // A group past the inline settled window: the two wave-root owners are
    // evicted, so shutdown learns about them ONLY from their authenticated
    // archives in the retirement scan.
    const base = Date.parse("2024-01-01T00:00:00.000Z");
    const at = (index: number): string => new Date(base + index * 1_000).toISOString();
    const records = Array.from({ length: INLINE_SETTLED_TASK_LIMIT + 8 }, (_unused, index) => collidingTaskRecord(
      `task-legacy-${index}`,
      at(index),
      at(index),
      `archived summary ${index}`,
    ));
    records[0]!.waveRoot = stuckWave;
    records[1]!.waveRoot = freeWave;
    await writePersistedExecutionGroupTasks(groupRoot, workspace, "exec-archived-session", records);

    const messages: string[] = [];
    const config = boundedScalingConfig();
    config.deleteSpawnedPiSessionsOnCleanup = true;
    restored = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => workspace,
      notify: (message) => {
        messages.push(message);
      },
    });
    await restored.restore({ waveRoots: [], bundles: [], groupRoots: [groupRoot] });
    const evicted = controllerInternals(restored).groups.get("exec-archived-session")!.tasks;
    assert.equal(evicted.some((task) => task.taskId === "task-legacy-0"), false,
      "the stuck root's task is archive-only, not an inline task record");

    await restored.shutdown();

    assert.match(messages.join("\n"), /review gate: spawned Pi session cleanup failed/);
    await access(stuckWave);
    await access(stuck.file);
    assert.equal(await exists(freeWave), false, "an independent archived root is still retired");
    assert.equal(await exists(free.file), false, "its eligible session is deleted with it");
    await access(join(groupRoot, "tasks", "task-legacy-0.json"));
    assert.ok(restored.associations().groupRoots?.includes(groupRoot),
      "the archive and association that own the retained root survive with it");

    // Retention is what makes the cleanup retryable: once the store is writable
    // again, the same existing lifecycle point finishes the deletion.
    await chmod(locked, 0o700);
    await restored.cleanupSettledArtifacts();
    assert.equal(await exists(stuckWave), false, "the retained wave root is removed on the next cleanup");
    assert.equal(await exists(stuck.file), false);
    assert.equal(await exists(groupRoot), false, "the execution root retires once no root survives its sessions");
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(groupRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(stuckWave, { recursive: true, force: true }).catch(() => undefined);
    await rm(freeWave, { recursive: true, force: true }).catch(() => undefined);
  }
});
