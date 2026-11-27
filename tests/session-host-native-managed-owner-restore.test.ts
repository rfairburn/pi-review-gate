/**
 * #682: durable restore of one exact native managed conversation owner.
 *
 * Verified against the real ExecutionToolManager (no Pi, host exposure) and the
 * real owner association store, with injected filesystem and publication
 * failures:
 * - absent restores the authoritative empty set; a host-exposed Start then
 *   publishes through the manager's onAssociationsChanged into the store, and
 *   a fresh handle restores those loaded associations;
 * - one handle coalesces concurrent restores (one read, one construction);
 * - malformed and unusable storage leave tools available through an
 *   explicitly non-authoritative fallback; invalid owner identity is still
 *   refused before manager construction, and bad state is not overwritten;
 * - exact identities stay isolated;
 * - revocation before or after ready is stale (retained, never cancelled);
 * - no save reaches the store before the canonical restore completes;
 * - an incomplete restore (unreadable record, failed durable group rewrite
 *   reported by the canonical restore, collapsed conflict gates, or a bundle
 *   whose identity or revision did not survive) keeps the tools and attached
 *   work available, with a diagnostic and no overwrite of the owner record;
 * - an open-persistence write failure rejects, so a real shared Start reports
 *   it; success never acknowledges a parent checkpoint.
 *
 * Every state root and workspace is a disposable temp directory. Queued tasks
 * never dispatch (`maxWorkers = 0`).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { GROUP_VERSION, serializeGroupSnapshot, writeGroupSnapshot } from "../src/execution/background-group-store";
import { newTask, transitionTaskState } from "../src/execution/task-state";
import type { ExecutionAssociationsSnapshot } from "../src/session-state";
import {
  nativeManagedAssociationPath,
  readNativeManagedAssociations,
  writeNativeManagedAssociations,
  type NativeManagedAssociationOwner,
} from "../src/session-host/native-managed-association-store";
import {
  NativeManagedAssociationSaveError,
  createNativeManagedOwnerRestore,
  type NativeManagedAssociationSave,
  type NativeManagedRestorableManager,
} from "../src/session-host/native-managed-owner-restore";
import { createState } from "../src/state";
import { FixtureAdmission, SUBTASK_TOOL_NAMES, assertManagedEnvelope, queuedTask, type SharedTool } from "./managed-tool-fixtures";

const SCRATCH_PARENT = realpathSync(tmpdir());
const CONVERSATION_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CONVERSATION_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const EMPTY: ExecutionAssociationsSnapshot = { waveRoots: [], bundles: [], groupRoots: [] };

interface Env {
  stateRoot: string;
  workspace: string;
  /** Cleanups that run (last registered first) before the scratch root is removed. */
  defer(cleanup: () => void | Promise<void>): void;
  owner(overrides?: Partial<NativeManagedAssociationOwner>): NativeManagedAssociationOwner;
}

function makeEnv(t: { after(fn: () => void | Promise<void>): void }): Env {
  const root = mkdtempSync(join(SCRATCH_PARENT, "prg-native-managed-owner-restore-tests-"));
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const stateRoot = join(root, "session-host");
  const workspace = join(root, "workspace");
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(workspace);
  return {
    stateRoot,
    workspace,
    defer: (cleanup) => { cleanups.push(cleanup); },
    owner: (overrides = {}) => ({ slotId: "slot-1", backend: "claude", conversationId: CONVERSATION_A, workspace, ...overrides }),
  };
}

function fixtureConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  config.execution!.maxWorkers = 0;
  return config;
}

/** Host-shaped factory for the real manager; records every construction and its save callback. */
function realFactory(env: Env, options: { faults?: Record<string, unknown> } = {}) {
  const { workspace } = env;
  const constructed: Array<{ manager: ExecutionToolManager; save: NativeManagedAssociationSave }> = [];
  const groupRoots = new Set<string>();
  env.defer(async () => {
    for (const { manager } of constructed) {
      for (const root of manager.associations().groupRoots ?? []) groupRoots.add(root);
      // A manager whose store a test broke reports its final association
      // publish as a rejection; teardown only needs to finish.
      await manager.shutdown().catch(() => undefined);
      await manager.detach().catch(() => undefined);
    }
    for (const root of groupRoots) await rm(root, { recursive: true, force: true });
  });
  const create = (save: NativeManagedAssociationSave): ExecutionToolManager => {
    const manager = new ExecutionToolManager({
      pi: undefined,
      config: fixtureConfig(),
      state: createState(),
      cwd: () => workspace,
      authorizedTools: () => ["read", "bash"],
      liveToolCallAllowed: (name) => SUBTASK_TOOL_NAMES.includes(name),
      hostExposure: { actions: ["start", "inspect", "continue"] },
      hostActivityCensus: true,
      onAssociationsChanged: save,
      // The controller's existing deterministic fault seam reaches it through the host input.
      ...(options.faults ? { faults: options.faults } : {}),
    } as ConstructorParameters<typeof ExecutionToolManager>[0]);
    constructed.push({ manager, save });
    return manager;
  };
  return { create, constructed, rememberRoots: (roots: readonly string[]) => roots.forEach((root) => groupRoots.add(root)) };
}

async function persisted(stateRoot: string, owner: NativeManagedAssociationOwner) {
  return readNativeManagedAssociations(stateRoot, owner);
}

test("absent restores empty, the real manager persists through the store, and a new handle restores the loaded owner", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  const first = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  assert.equal(first.source, "absent");
  assert.deepEqual(first.manager.associations().groupRoots, []);
  assert.deepEqual(await persisted(env.stateRoot, env.owner()), { status: "absent" }, "an empty restore writes nothing");

  // A host-exposed Start publishes through onAssociationsChanged into the exact owner's file.
  const manager = first.manager;
  manager.sync();
  const admission = new FixtureAdmission();
  const params = { tasks: [queuedTask("durable owner")] };
  admission.admit("owner-start-1", "SubtasksStart", params);
  const started = await (manager.sharedManagedTool("start", admission) as SharedTool).invoke({ toolCallId: "owner-start-1" });
  assertManagedEnvelope(started, false, "start");
  const roots = manager.associations().groupRoots ?? [];
  assert.equal(roots.length, 1);
  factory.rememberRoots(roots);
  const saved = await persisted(env.stateRoot, env.owner());
  assert.equal(saved.status, "loaded");
  if (saved.status !== "loaded") return;
  assert.deepEqual(saved.associations.groupRoots, roots);
  // A committed association write is never a parent-checkpoint acknowledgement
  // (no bare true, no receipt), so the ledger cannot retire checkpoint owners on it.
  assert.equal(await factory.constructed[0]!.save(manager.associations()), undefined);

  // The owning run ends; a later run restores the persisted group through the canonical API.
  await manager.shutdown();
  const second = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(second.status, "ready");
  if (second.status !== "ready") return;
  assert.equal(second.source, "loaded");
  assert.equal(typeof second.revision, "number");
  assert.notEqual(second.manager, manager);
  assert.deepEqual(second.manager.associations().groupRoots, roots);
});

test("one handle coalesces concurrent restores into one read, one construction, and one canonical restore", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), EMPTY)).status, "published");
  let lookups = 0;
  let restores = 0;
  const handle = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => true,
    createManager: (save) => {
      const manager = factory.create(save);
      const original = manager.restoreAssociations.bind(manager);
      manager.restoreAssociations = async (...args) => {
        restores += 1;
        return original(...args);
      };
      return manager;
    },
    testHooks: { read: { beforeFileLookup: () => { lookups += 1; } } },
  });
  const [ra, rb] = await Promise.all([handle.restore(), handle.restore()]);
  assert.equal(ra, rb, "concurrent calls observe the one shared attempt");
  assert.equal(ra.status, "ready");
  assert.equal(await handle.restore(), ra, "a settled attempt is never repeated");
  assert.equal(lookups, 1);
  assert.equal(factory.constructed.length, 1);
  assert.equal(restores, 1);
});

test("unusable owner storage keeps tools available without overwriting state; invalid owner identity is refused", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  await writeNativeManagedAssociations(env.stateRoot, env.owner(), EMPTY);
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  writeFileSync(path, "{ not json", { mode: 0o600 });

  const malformed = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(malformed.status, "ready");
  if (malformed.status !== "ready") return;
  assert.equal(malformed.source, "unavailable");
  assert.deepEqual(malformed.diagnostic, { stage: "read", reason: "malformed" });
  malformed.manager.sync();
  assert.ok(malformed.manager.sharedManagedTool("start", new FixtureAdmission()), "a storage refusal does not hide Start");
  assert.equal(await factory.constructed[0]!.save(EMPTY), undefined);
  assert.equal(readFileSync(path, "utf8"), "{ not json", "unavailable state is never overwritten");

  const badOwner = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: { ...env.owner(), conversationId: "not-a-uuid" }, isCurrent: () => true, createManager: factory.create,
  });
  assert.equal(badOwner.owner, undefined);
  assert.deepEqual(await badOwner.restore(), { status: "unavailable", reason: "invalid-owner" });

  const extraKey = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: { ...env.owner(), extra: true } as never, isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.deepEqual(extraKey, { status: "unavailable", reason: "invalid-owner" });

  const fileRoot = join(env.workspace, "not-a-directory");
  writeFileSync(fileRoot, "x");
  const badRoot = await createNativeManagedOwnerRestore({
    stateRoot: fileRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(badRoot.status, "ready");
  if (badRoot.status === "ready") assert.deepEqual(badRoot.diagnostic, { stage: "read", reason: "invalid-state-root" });

  const missingRoot = await createNativeManagedOwnerRestore({
    stateRoot: join(env.workspace, "missing"), owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(missingRoot.status, "ready");
  if (missingRoot.status === "ready") assert.deepEqual(missingRoot.diagnostic, { stage: "read", reason: "invalid-state-root" });

  assert.equal(factory.constructed.length, 3, "only the invalid identities refuse to construct a manager");
});

test("a loaded owner without a group roster is incomplete, not empty", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  const owner = env.owner();
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, owner, {
    waveRoots: [], bundles: [],
  })).status, "published");
  const path = nativeManagedAssociationPath(env.stateRoot, owner);
  const before = readFileSync(path);
  const handle = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner, isCurrent: () => true, createManager: factory.create,
  });
  const result = await handle.restore();
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.diagnostic?.stage, "restore");
  assert.equal(result.diagnostic.reason, "restore-incomplete");
  const { manager, save } = factory.constructed[0]!;
  assert.equal(result.manager, manager);
  assert.equal(handle.readyManager(), manager);
  assert.equal(await save(manager.associations()), undefined, "closed persistence never writes an authoritative empty roster");
  await manager.shutdown();
  assert.deepEqual(readFileSync(path), before);
});

test("exact identities restore in isolation and never touch another owner's file", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  const foreign: ExecutionAssociationsSnapshot = { waveRoots: [], bundles: [], groupRoots: [join(env.workspace, "foreign-group")] };
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), foreign)).status, "published");
  const ownerPath = nativeManagedAssociationPath(env.stateRoot, env.owner());
  const before = readFileSync(ownerPath);

  const otherWorkspace = join(env.workspace, "nested");
  mkdirSync(otherWorkspace);
  const variants: NativeManagedAssociationOwner[] = [
    env.owner({ conversationId: CONVERSATION_B }),
    env.owner({ backend: "codex" }),
    env.owner({ slotId: "slot-2" }),
    env.owner({ workspace: otherWorkspace }),
  ];
  for (const variant of variants) {
    const result = await createNativeManagedOwnerRestore({
      stateRoot: env.stateRoot, owner: variant, isCurrent: () => true, createManager: factory.create,
    }).restore();
    assert.equal(result.status, "ready", JSON.stringify(variant));
    if (result.status !== "ready") continue;
    assert.equal(result.source, "absent", "a different exact owner never loads another owner's associations");
    assert.deepEqual(result.manager.associations().groupRoots, []);
  }
  assert.deepEqual(readFileSync(ownerPath), before, "other owners' restores leave this owner's file byte-identical");

  // Another owner's later saves stay in its own file.
  const lastSave = factory.constructed.at(-1)!.save;
  assert.equal(await lastSave(EMPTY), undefined);
  assert.deepEqual(readFileSync(ownerPath), before);
});

test("revocation before ready is stale: nothing read or constructed early, and a constructed manager is retained, not cancelled", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  // The store's read hook runs only once its directory exists.
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), EMPTY)).status, "published");
  let lookups = 0;
  const lookupHook = { beforeFileLookup: () => { lookups += 1; } };

  const revokedUpFront = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => false, createManager: factory.create, testHooks: { read: lookupHook },
  }).restore();
  assert.deepEqual(revokedUpFront, { status: "stale" });
  assert.equal(lookups, 0);

  let current = true;
  const revokedDuringRead = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => current,
    createManager: factory.create,
    testHooks: { read: { beforeFileLookup: () => { current = false; } } },
  }).restore();
  assert.deepEqual(revokedDuringRead, { status: "stale" });
  assert.equal(current, false, "the revocation happened inside the store read");

  const throwingProof = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => { throw new Error("proof failed"); }, createManager: factory.create,
  }).restore();
  assert.deepEqual(throwingProof, { status: "stale" }, "a throwing freshness proof fails closed");
  assert.equal(factory.constructed.length, 0);

  // Revoked while the canonical restore runs: retained for the host, never exposed or shut down.
  current = true;
  const revokedDuringRestore = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => current,
    createManager: (save) => {
      const manager = factory.create(save);
      const original = manager.restoreAssociations.bind(manager);
      manager.restoreAssociations = async (...args) => {
        const result = await original(...args);
        current = false;
        return result;
      };
      return manager;
    },
  }).restore();
  assert.equal(revokedDuringRestore.status, "stale");
  assert.ok(!("manager" in revokedDuringRestore), "a stale outcome never exposes a manager");
  const retained = (revokedDuringRestore as { retainedManager?: ExecutionToolManager }).retainedManager;
  assert.equal(retained, factory.constructed[0]!.manager);
  // Not cancelled or detached: after a complete restore its persistence stays
  // open, so its lifecycle saves keep the exact owner's durable record.
  const before = await persisted(env.stateRoot, env.owner());
  assert.equal(before.status, "loaded");
  assert.equal(await factory.constructed[0]!.save(retained!.associations()), undefined);
  const after = await persisted(env.stateRoot, env.owner());
  assert.equal(after.status, "loaded");
  if (before.status === "loaded" && after.status === "loaded") assert.equal(after.revision, before.revision + 1);
});

test("no save reaches the store before the canonical restore completes; the full snapshot is published afterwards", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), EMPTY)).status, "published");
  const seeded = await persisted(env.stateRoot, env.owner());
  assert.equal(seeded.status, "loaded");
  const overwrite: ExecutionAssociationsSnapshot = { waveRoots: [], bundles: [], groupRoots: [join(env.workspace, "pre-restore")] };
  const answers: unknown[] = [];
  const result = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => true,
    createManager: (save) => {
      const manager = factory.create(save);
      const original = manager.restoreAssociations.bind(manager);
      manager.restoreAssociations = async (...args) => {
        // Both before and during the canonical restore the store must not change.
        answers.push(await save(overwrite));
        assert.deepEqual(await persisted(env.stateRoot, env.owner()), seeded);
        const result = await original(...args);
        answers.push(await save(overwrite));
        assert.deepEqual(await persisted(env.stateRoot, env.owner()), seeded);
        return result;
      };
      return manager;
    },
  }).restore();
  assert.deepEqual(answers, [undefined, undefined], "pre-restore saves are deferred without confirming or rejecting");
  assert.equal(result.status, "ready");
  if (result.status !== "ready" || seeded.status !== "loaded") return;
  const after = await persisted(env.stateRoot, env.owner());
  assert.equal(after.status, "loaded");
  if (after.status !== "loaded") return;
  assert.equal(after.revision, seeded.revision + 1, "one deferred publication after the restore");
  assert.deepEqual(after.associations.groupRoots, result.manager.associations().groupRoots);
  assert.ok(!after.associations.groupRoots?.includes(overwrite.groupRoots![0]!), "the pre-restore snapshot never reached the store");
});

test("a failed restore keeps saves closed and never overwrites the owner file", async (t) => {
  const env = makeEnv(t);
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), EMPTY)).status, "published");
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  const before = readFileSync(path);
  let captured: NativeManagedAssociationSave | undefined;
  const failing: NativeManagedRestorableManager = {
    restoreAssociations: async () => { throw new Error("restore exploded"); },
    associations: () => EMPTY,
  };
  const result = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => true,
    createManager: (save) => {
      captured = save;
      return failing;
    },
  }).restore();
  assert.deepEqual(result, { status: "failed", reason: "restore-failed", retainedManager: failing });
  assert.equal(await captured!({ waveRoots: [], bundles: [], groupRoots: ["/x"] }), undefined, "closed persistence declines without writing or rejecting");
  assert.deepEqual(readFileSync(path), before);

  const throwingFactory = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: () => { throw new Error("no manager"); },
  }).restore();
  assert.deepEqual(throwingFactory, { status: "failed", reason: "manager-construction-failed" });
  const notAManager = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: () => ({}) as never,
  }).restore();
  assert.deepEqual(notAManager, { status: "failed", reason: "manager-construction-failed" });
  assert.deepEqual(readFileSync(path), before);
});

test("failed publication rejects through the callback so a real shared Start reports it, without cancelling the admitted group", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  let failCommit = false;
  const publication = { beforeCommit: () => { if (failCommit) throw new Error("injected commit failure"); } };

  const ready = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create, testHooks: { publication },
  }).restore();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const manager = ready.manager;
  manager.sync();

  // The commit fails during a real SubtasksStart: the canonical result reports the durability failure.
  failCommit = true;
  const admission = new FixtureAdmission();
  admission.admit("failing-start", "SubtasksStart", { tasks: [queuedTask("not durable")] });
  const started = await (manager.sharedManagedTool("start", admission) as SharedTool).invoke({ toolCallId: "failing-start" });
  assertManagedEnvelope(started, true, "start with failed association commit");
  assert.match(started.content[0].text, /not durably recorded \(failed: publication-failed\)/);
  assert.match(started.content[0].text, /already admitted work remains admitted and was not cancelled/);
  assert.deepEqual(await persisted(env.stateRoot, env.owner()), { status: "absent" }, "nothing was committed");
  // The group was admitted before publication; it is neither rolled back nor cancelled.
  const admitted = manager.associations().groupRoots ?? [];
  assert.equal(admitted.length, 1);
  factory.rememberRoots(admitted);

  // The next committed save records the admitted group.
  failCommit = false;
  assert.equal(await factory.constructed[0]!.save(manager.associations()), undefined);
  const saved = await persisted(env.stateRoot, env.owner());
  assert.equal(saved.status, "loaded");
  if (saved.status === "loaded") assert.deepEqual(saved.associations.groupRoots, admitted);

  // State corrupted after restore: the store refuses, the callback rejects, the file stays as found.
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  writeFileSync(path, "corrupt", { mode: 0o600 });
  await assert.rejects(factory.constructed[0]!.save(EMPTY), /not durably recorded \(refused: malformed\)/);
  assert.equal(readFileSync(path, "utf8"), "corrupt");

  // A deferred post-restore publication that fails is surfaced without hiding tools.
  const other = env.owner({ conversationId: CONVERSATION_B });
  failCommit = true;
  const deferredHandle = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: other,
    isCurrent: () => true,
    createManager: (save) => {
      const created = factory.create(save);
      void save(EMPTY);
      return created;
    },
    testHooks: { publication },
  });
  const deferred = await deferredHandle.restore();
  assert.equal(deferred.status, "ready");
  if (deferred.status !== "ready") return;
  assert.deepEqual(deferred.diagnostic, { stage: "publish", reason: "publication-failed" });
  assert.equal(deferred.manager, factory.constructed.at(-1)!.manager);
  assert.equal(deferredHandle.readyManager(), deferred.manager);
  assert.deepEqual(await persisted(env.stateRoot, other), { status: "absent" });
});

test("an incomplete canonical restore keeps tools and attached work available without replacing the owner file", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  // A real group record, persisted by a real manager through the owner store.
  const first = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  first.manager.sync();
  const admission = new FixtureAdmission();
  admission.admit("seed-start", "SubtasksStart", { tasks: [queuedTask("readable group")] });
  assertManagedEnvelope(await (first.manager.sharedManagedTool("start", admission) as SharedTool).invoke({ toolCallId: "seed-start" }), false, "seed start");
  const readable = first.manager.associations().groupRoots ?? [];
  assert.equal(readable.length, 1);
  factory.rememberRoots(readable);
  await first.manager.shutdown();

  // The owner file also references a group whose canonical record is unreadable.
  const unreadable = join(env.workspace, "pi-review-execution-unreadable");
  mkdirSync(unreadable);
  writeFileSync(join(unreadable, "execution.json"), "{ not a record");
  const seeded = await persisted(env.stateRoot, env.owner());
  assert.equal(seeded.status, "loaded");
  if (seeded.status !== "loaded") return;
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), {
    ...seeded.associations, groupRoots: [...readable, unreadable],
  })).status, "published");
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  const before = readFileSync(path);

  const notices: string[] = [];
  const handle = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => true,
    createManager: (save) => {
      const created = factory.create(save);
      const original = created.restoreAssociations.bind(created);
      // Observe, and forward, the diagnostic callback the composition supplies.
      created.restoreAssociations = (value, options, notify) => original(value, options, (message) => {
        notices.push(message);
        return notify?.(message);
      });
      return created;
    },
  });
  const result = await handle.restore();
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.diagnostic?.stage, "restore");
  assert.equal(result.diagnostic.reason, "restore-incomplete");
  assert.equal(handle.readyManager(), result.manager);
  assert.ok(notices.some((message) => message.includes("was not restored")), "the canonical restore reported the unreadable record and resolved");
  const retained = result.manager;
  assert.deepEqual(retained.associations().groupRoots, readable, "the readable group stays attached, not cancelled");
  assert.deepEqual(readFileSync(path), before, "the owner file is byte-identical after the incomplete restore");

  // Persistence is closed: a lifecycle save is declined (unconfirmed, not a
  // rejection that could fail attached work) and never replaces the owner file,
  // including the save the host's own shutdown performs.
  const save = factory.constructed.at(-1)!.save;
  assert.equal(await save(retained.associations()), undefined);
  assert.deepEqual(readFileSync(path), before);
  await retained.shutdown();
  assert.deepEqual(readFileSync(path), before, "no later save replaces the intact owner file");
});

test("a failed durable rewrite of an attached group during restore is incomplete, keeps the group, and leaves the owner file intact", async (t) => {
  const env = makeEnv(t);
  let failRestoreSaves = false;
  const factory = realFactory(env, {
    faults: { save: () => { if (failRestoreSaves) throw new Error("injected restore save failure"); } },
  });
  const first = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  first.manager.sync();
  const admission = new FixtureAdmission();
  admission.admit("seed-start", "SubtasksStart", { tasks: [queuedTask("readable group")] });
  assertManagedEnvelope(await (first.manager.sharedManagedTool("start", admission) as SharedTool).invoke({ toolCallId: "seed-start" }), false, "seed start");
  const roots = first.manager.associations().groupRoots ?? [];
  assert.equal(roots.length, 1);
  factory.rememberRoots(roots);
  await first.manager.shutdown();
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  const before = readFileSync(path);

  const handle = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => true,
    createManager: (save) => {
      const created = factory.create(save);
      const original = created.restoreAssociations.bind(created);
      // The fault applies only while the canonical restore runs.
      created.restoreAssociations = async (...args) => {
        failRestoreSaves = true;
        try {
          await original(...args);
        } finally {
          failRestoreSaves = false;
        }
      };
      return created;
    },
  });
  const result = await handle.restore();
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.diagnostic?.stage, "restore");
  assert.equal(result.diagnostic.reason, "restore-incomplete");
  assert.equal(handle.readyManager(), result.manager);
  const retained = result.manager;
  assert.deepEqual(retained.associations().groupRoots, roots, "the readable group was attached and stays attached");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(await factory.constructed.at(-1)!.save(retained.associations()), undefined);
  await retained.shutdown();
  assert.deepEqual(readFileSync(path), before, "the owner file is unchanged");
});

test("conflict gates must survive with every durable field: collapsed same-root gates are incomplete", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  const sourceRoot = join(env.workspace, "gated-source");
  mkdirSync(sourceRoot);
  const gate = (paths: string[], sidecars?: Array<{ path: string; sidecarPath?: string }>) => ({
    executionId: "exec-gated", taskId: "task-gated", sourceRoot, paths,
    activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(env.workspace, "manifest.json"), reason: "conflict",
    ...(sidecars ? { sidecars } : {}),
  });

  // Positive control: one gate round-trips through the real manager, so the full-field comparison holds.
  const single = env.owner({ conversationId: CONVERSATION_B });
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, single, {
    ...EMPTY, conflictGates: [gate(["a.ts"], [{ path: "a.ts", sidecarPath: join(env.workspace, "a.side") }])],
  })).status, "published");
  const ready = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: single, isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(ready.status, "ready");
  if (ready.status === "ready") {
    await ready.manager.shutdown();
    await ready.manager.detach();
  }

  // Two gates for the same task and root with different paths/sidecars: the canonical restore keeps one.
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), {
    ...EMPTY, conflictGates: [gate(["a.ts"]), gate(["b.ts"], [{ path: "b.ts" }])],
  })).status, "published");
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  const before = readFileSync(path);
  const result = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.diagnostic?.stage, "restore");
  assert.equal(result.diagnostic.reason, "restore-incomplete");
  assert.equal(result.manager.associations().conflictGates?.length, 1, "the canonical restore collapsed the same-root gates");
  assert.deepEqual(readFileSync(path), before, "the owner file keeps both gates byte-identically");
});

test("no shared restore result means no overwrite even when the live snapshot matches", async (t) => {
  const env = makeEnv(t);
  const waveRoot = join(env.workspace, "wave");
  const bundle = { version: 1 as const, operationId: "op-1", waveId: "wave-1", taskId: "task-1", waveRoot, expectedRevision: 3 };
  const owner = env.owner();
  const associations = { waveRoots: [waveRoot], bundles: [bundle], groupRoots: [] };
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, owner, associations)).status, "published");
  const path = nativeManagedAssociationPath(env.stateRoot, owner);
  const before = readFileSync(path);
  const manager: NativeManagedRestorableManager = {
    restoreAssociations: async () => undefined,
    associations: () => associations,
  };
  let save!: NativeManagedAssociationSave;
  const result = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner, isCurrent: () => true,
    createManager: (callback) => { save = callback; return manager; },
  }).restore();
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.diagnostic?.reason, "restore-incomplete");
  await save(EMPTY);
  assert.deepEqual(readFileSync(path), before);
});

test("a ready manager is never handed out again after its run is revoked, and no second restore starts", async (t) => {
  const env = makeEnv(t);
  const factory = realFactory(env);
  let current = true;
  let restores = 0;
  const handle = createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot,
    owner: env.owner(),
    isCurrent: () => current,
    createManager: (save) => {
      const created = factory.create(save);
      const original = created.restoreAssociations.bind(created);
      created.restoreAssociations = async (...args) => {
        restores += 1;
        return original(...args);
      };
      return created;
    },
  });
  assert.equal(handle.readyManager(), undefined, "nothing is ready before a restore settles");
  const ready = await handle.restore();
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  assert.equal(handle.readyManager(), ready.manager);
  assert.equal(await handle.restore(), ready, "a fresh run reuses the settled attempt");

  current = false;
  assert.equal(handle.readyManager(), undefined, "the synchronous accessor rechecks freshness");
  const reacquired = await handle.restore();
  assert.deepEqual(reacquired, { status: "stale", retainedManager: ready.manager });
  current = true;
  assert.equal(handle.readyManager(), undefined, "revocation is sticky for the run");
  assert.equal((await handle.restore()).status, "stale");
  assert.equal(restores, 1, "reacquisition never starts another restore");
  assert.equal(factory.constructed.length, 1);
});

/** Restrict real shutdown cleanup to this invocation's own temp root. */
function ownerTemp(env: Env): string {
  const temp = join(dirname(env.stateRoot), "artifacts");
  mkdirSync(temp);
  const key = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const before = process.env[key];
  process.env[key] = temp;
  env.defer(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  return temp;
}

async function seedOwnerTask(
  workspace: string,
  temp: string,
  kind: "research" | "execute",
  state: "reported" | "landed" | "running",
) {
  const root = mkdtempSync(join(temp, "pi-review-execution-"));
  const waveRoot = mkdtempSync(join(temp, "wave-"));
  const task = newTask({ title: `Owned ${kind} fixture`, instructions: "Fixture only", acceptanceCriteria: ["Persisted task"] });
  const waveId = randomUUID();
  const executionId = `exec-${randomUUID()}`;
  const bundle = { version: 1 as const, waveRoot, waveId, taskId: task.taskId, operationId: `${waveId}/${task.taskId}`, expectedRevision: 1 };
  task.waveRoot = waveRoot;
  task.bundle = bundle;
  transitionTaskState(task, state);
  const now = new Date().toISOString();
  await writeGroupSnapshot(root, serializeGroupSnapshot({
    version: GROUP_VERSION, executionId, revision: 1, integritySha256: "", kind,
    root, cwd: workspace, sessionCwd: workspace, createdAt: now, updatedAt: now,
    tasks: [task], peakConcurrency: 1, totalTaskCount: 1, settledArchivedCount: 0,
  }, new Map()));
  return { root, waveRoot, bundle, executionId, taskId: task.taskId };
}

for (const kind of ["research", "execute"] as const) {
  test(`#781 ${kind} restart after normal cleanup keeps native and Pi tools available`, async (t) => {
    const env = makeEnv(t);
    const temp = ownerTemp(env);
    const factory = realFactory(env);
    const saved = await seedOwnerTask(env.workspace, temp, kind, kind === "research" ? "reported" : "landed");
    const snapshot = { groupRoots: [saved.root], waveRoots: [saved.waveRoot], bundles: [saved.bundle] };
    const owner = env.owner({ backend: kind === "research" ? "claude" : "codex" });
    assert.equal((await writeNativeManagedAssociations(env.stateRoot, owner, snapshot)).status, "published");
    // Normal controller shutdown collects both roots. Keep the *prior* owner
    // snapshot to represent a restart with associations not yet reconciled.
    const retiring = factory.create(async () => undefined);
    await retiring.restoreAssociations(snapshot);
    await retiring.shutdown();
    await retiring.detach();
    assert.equal(existsSync(saved.root), false);
    assert.equal(existsSync(saved.waveRoot), false);

    const piTools = new Set<string>();
    const pi = new ExecutionToolManager({
      pi: { registerTool: (tool: { name: string }) => piTools.add(tool.name), registerCommand() {} },
      config: fixtureConfig(), state: createState(), cwd: () => env.workspace,
      authorizedTools: () => undefined,
    });
    env.defer(() => pi.detach());
    const piNotices: string[] = [];
    await pi.restoreAssociations(snapshot, undefined, (notice) => { piNotices.push(notice); });
    pi.sync();
    const restore = () => createNativeManagedOwnerRestore({
      stateRoot: env.stateRoot, owner, isCurrent: () => true, createManager: factory.create,
    }).restore();
    const native = await restore();
    assert.equal(native.status, "ready");
    if (native.status !== "ready") return;
    native.manager.sync();
    assert.equal(native.diagnostic, undefined);
    assert.deepEqual(piNotices, []);
    assert.deepEqual(native.manager.associations(), pi.associations());
    const census = await native.manager.activityCensus()?.read();
    assert.equal(census?.status, "complete");
    assert.equal(census.count, 0);
    const admission = new FixtureAdmission();
    for (const [action, name] of [["start", "SubtasksStart"], ["inspect", "SubtasksInspect"]] as const) {
      assert.ok(piTools.has(name));
      assert.equal(native.manager.sharedManagedTool(action, admission)?.name, name);
    }
    // First actual association save must not reintroduce discarded paths.
    admission.admit("post-cleanup-start", "SubtasksStart", { tasks: [queuedTask("Fresh work after cleanup")] });
    assertManagedEnvelope(await (native.manager.sharedManagedTool("start", admission) as SharedTool).invoke({ toolCallId: "post-cleanup-start" }), false, "post-cleanup start");
    const rewritten = await persisted(env.stateRoot, owner);
    assert.equal(rewritten.status, "loaded");
    if (rewritten.status !== "loaded") return;
    assert.deepEqual(rewritten.associations.waveRoots, []);
    assert.deepEqual(rewritten.associations.bundles, []);
    assert.equal(rewritten.associations.groupRoots?.length, 1);
    assert.ok(!rewritten.associations.groupRoots?.includes(saved.root));
    await native.manager.shutdown();
    await native.manager.detach();
    const restarted = await restore();
    assert.equal(restarted.status, "ready");
    if (restarted.status === "ready") assert.equal(restarted.diagnostic, undefined);
  });
}

test("#781 a missing in-flight wave does not hide other tools or replace the recovery record", async (t) => {
  const env = makeEnv(t);
  const temp = ownerTemp(env);
  const factory = realFactory(env);
  const saved = await seedOwnerTask(env.workspace, temp, "execute", "running");
  const snapshot = { groupRoots: [saved.root], waveRoots: [saved.waveRoot], bundles: [saved.bundle] };
  assert.equal((await writeNativeManagedAssociations(env.stateRoot, env.owner(), snapshot)).status, "published");
  const path = nativeManagedAssociationPath(env.stateRoot, env.owner());
  const before = readFileSync(path);
  await rm(saved.waveRoot, { recursive: true });

  const restore = await createNativeManagedOwnerRestore({
    stateRoot: env.stateRoot, owner: env.owner(), isCurrent: () => true, createManager: factory.create,
  }).restore();
  assert.equal(restore.status, "ready");
  if (restore.status !== "ready") return;
  assert.equal(restore.diagnostic?.stage, "restore");
  restore.manager.sync();
  const admission = new FixtureAdmission();
  const params = { executionId: saved.executionId, taskId: saved.taskId };
  admission.admit("missing-wave-inspect", "SubtasksInspect", params);
  const inspected = await (restore.manager.sharedManagedTool("inspect", admission) as SharedTool)
    .invoke({ toolCallId: "missing-wave-inspect" });
  assertManagedEnvelope(inspected, false, "the authentic group and task still exist");
  assert.match(inspected.content[0].text, /paused_recoverable/);
  admission.admit("missing-wave-continue", "SubtasksContinue", { ...params, instructions: "Recover this owned fixture" });
  const continued = await (restore.manager.sharedManagedTool("continue", admission) as SharedTool)
    .invoke({ toolCallId: "missing-wave-continue" });
  assertManagedEnvelope(continued, true, "missing recovery material refuses this operation only");
  assert.match(continued.content[0].text, /durable wave directory is missing/);
  admission.admit("missing-wave-inspect-again", "SubtasksInspect", params);
  const afterRefusal = await (restore.manager.sharedManagedTool("inspect", admission) as SharedTool)
    .invoke({ toolCallId: "missing-wave-inspect-again" });
  assert.match(afterRefusal.content[0].text, /paused_recoverable/, "the refused command never queues a worker");
  assert.ok(restore.manager.sharedManagedTool("start", admission), "unrelated tools remain visible");
  assert.deepEqual(restore.manager.associations().waveRoots, [saved.waveRoot], "recoverable work retains its named wave");
  await restore.manager.shutdown();
  assert.deepEqual(readFileSync(path), before, "a refused recovery leaves the owner record intact");
});
