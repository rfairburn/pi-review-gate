/**
 * #781 — the persistence boundary a restore result feeds.
 *
 * A host saves what the restore says must still be reproducible, not the raw
 * live snapshot: an execution root that exists but could not be read is absent
 * from the live snapshot and present in the required set, so a live-only save
 * would erase the only path back to that work. A root the restore positively
 * proved collected is absent from the required set and stays dropped.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createSessionPersistence } from "../src/activation/persistence";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { ExecutionToolManager } from "../src/execution/tool";
import { SessionStateStore, type ExecutionAssociationsSnapshot } from "../src/session-state";
import { createState } from "../src/state";
import {
  activateOwnedActivity,
  activeActivitySnapshot,
  ownedActivitySnapshot,
  registerOwnedActivitySource,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import { waitFor } from "./helpers/background-controller-fixtures";
import type { ReattachmentBundle } from "../src/execution/operation-record";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

function managerFor(
  cwd: string,
  notices: string[],
  onAssociationsChanged?: (associations: ExecutionAssociationsSnapshot) => void,
): ExecutionToolManager {
  return new ExecutionToolManager({
    pi: { registerTool() {}, registerCommand() {}, setToolActive() {}, getActiveTools() { return []; } },
    config: normalizeConfig({
      enabled: true,
      execution: { routes: { execute: [], research: [] }, maxWorkers: 1 },
    }),
    state: createState(),
    cwd: () => cwd,
    notify: (message: string) => { notices.push(message); },
    ...(onAssociationsChanged ? { onAssociationsChanged: async (associations: ExecutionAssociationsSnapshot) => {
      onAssociationsChanged(associations);
      return true;
    } } : {}),
  });
}

/** A real wave whose candidate staging is refused, so the durable bundle is
 *  adoptable by a later restore: the operation record, capture, and manifest
 *  are the ones production wrote, not hand-written fixtures. */
async function adoptableWave(repo: string): Promise<{ bundle: ReattachmentBundle; waveRoot: string }> {
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "base.txt");
  await git(repo, "commit", "-qm", "base");
  const tools = await mkdtemp(join(await realpath(tmpdir()), "prg-adopt-tools-"));
  const executor = join(tools, "adopt-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "require('node:fs').writeFileSync('task.txt','task work\\n');",
    // An absolute symlink is refused by candidate staging, so the operation
    // stays recoverable with its durable bundle, exactly as after a crash. The
    // target is deliberately outside every workspace and never read.
    "require('node:fs').symlinkSync('/prg-fixture-absent-target/escape','escape');",
    "console.log(JSON.stringify({type:'session',sessionId:'adopt-session'}));",
    "console.log(JSON.stringify({type:'assistant',text:'done'}));});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const controller = new BackgroundExecutionController({
    pi: {},
    config: normalizeConfig({
      enabled: true,
      retainBundles: "always",
      externalAgents: {
        adopter: {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1", timeoutMs: 30_000 },
        },
      },
      execution: {
        maxWorkers: 1,
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
        workerResources: { default: { selection: { source: "external", id: "adopter" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    }),
    state: createState(),
    cwd: () => repo,
  });
  try {
    const started = await controller.start([{ title: "adoptable", instructions: "write task.txt", acceptanceCriteria: ["task.txt exists"] }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => {
      const task = controller.inspect(started.executionId, taskId).tasks[0];
      return task?.state === "paused_recoverable" && task.waveRoot !== undefined && task.bundle !== undefined;
    }, 60_000);
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    const bundle = { ...task.bundle! };
    const waveRoot = task.waveRoot!;
    await controller.shutdown();
    await controller.detach();
    return { bundle, waveRoot };
  } finally {
    await rm(tools, { recursive: true, force: true });
  }
}

test("a canonical adoption inside the next restore does not inherit the previous owner's retained references", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-restore-adopt-owner-"));
  const notices: string[] = [];
  const repo = join(root, "repo");
  await mkdir(repo);
  try {
    const { bundle, waveRoot } = await adoptableWave(repo);
    const previousOwnerRoot = join(root, "exec-previous-owner-unreadable");
    await mkdir(previousOwnerRoot);

    const published: ExecutionAssociationsSnapshot[] = [];
    const manager = managerFor(repo, notices, (associations) => {
      // Pi's persistence hook: sample what a save would write right now, which
      // is the boundary's merge of the live snapshot and what a restore retained.
      published.push(manager.persistableAssociations());
    });

    // The previous conversation ends with an unreadable execution root: it is
    // retained so its own final save can still reproduce it.
    const first = await manager.restoreAssociations({ waveRoots: [], bundles: [], groupRoots: [previousOwnerRoot] });
    assert.ok(first);
    assert.deepEqual(manager.persistableAssociations().groupRoots, [previousOwnerRoot],
      "the retiring owner's final save still has its unresolved reference");

    // A different owner is restored from a valid legacy bundle. Its adoption
    // publishes through the same callback before restoreAssociations returns.
    const second = await manager.restoreAssociations({ waveRoots: [waveRoot], bundles: [bundle], groupRoots: [] });
    assert.ok(second);
    assert.ok(published.length >= 1, "the canonical adoption published through the association callback");
    const sampled = published.at(-1)!;
    const liveAtPublication = manager.associations();
    const liveGroupRoots = liveAtPublication.groupRoots ?? [];
    assert.ok(liveGroupRoots.length >= 1, "the adoption attached a group");
    assert.ok(!(sampled.groupRoots ?? []).includes(previousOwnerRoot),
      "the new conversation's save never carries the previous owner's unreadable root");
    assert.deepEqual(sampled.groupRoots ?? [], liveGroupRoots,
      "the published snapshot is exactly the adopted owner's live record");
    assert.ok(sampled.bundles.some((candidate) => candidate.operationId === bundle.operationId),
      "the adopted group's own association is present");
    assert.equal(second.recovery.complete, true, "the adoption itself settled cleanly");
    for (const adopted of manager.associations().groupRoots ?? []) await rm(adopted, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Await the registry's one canonical coalesced activity-refresh pass. */
async function awaitActivityRefresh(): Promise<void> {
  await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
}

async function sidecarExecution(root: string): Promise<ExecutionAssociationsSnapshot> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json")) found.push(path);
    }
  };
  await walk(root);
  assert.equal(found.length, 1, `exactly one sidecar is written under ${root}`);
  return JSON.parse(await readFile(found[0]!, "utf8")).execution as ExecutionAssociationsSnapshot;
}

test("the persistence boundary drops a proven-collected root and keeps an unreadable existing group", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-restore-boundary-"));
  const notices: string[] = [];
  try {
    const collected = join(root, "exec-collected");   // never created: positively absent
    const unreadable = join(root, "exec-unreadable"); // exists, carries no manifest
    await mkdir(unreadable);
    const manager = managerFor(root, notices);
    const loaded: ExecutionAssociationsSnapshot = { waveRoots: [], bundles: [], groupRoots: [collected, unreadable] };

    const result = await manager.restoreAssociations(loaded);
    assert.ok(result, "a real manager reports a structured restore result");
    assert.equal(result!.recovery.complete, false, "an existing group that could not be read is never complete");
    assert.deepEqual(result!.associations.groupRoots, [unreadable],
      "the required set keeps the unreadable root and drops the collected one");

    // #781: Pi samples associations() for its sidecar save, so for a Pi manager
    // that method IS the persistence projection. The raw live walk it corrects
    // carried neither root — which is exactly why the boundary exists.
    assert.deepEqual(manager.associations().groupRoots, [unreadable],
      "Pi's sampled snapshot keeps the required reference, not the raw live one");
    const persistable = manager.persistableAssociations();
    assert.ok(!(persistable.groupRoots ?? []).includes(collected),
      "a root this restore positively proved collected stays dropped");
    assert.deepEqual(persistable.groupRoots, [unreadable],
      "the reference needed to recover that group on the next start survives the save");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi's first post-restore save reproduces the unreadable group and not the collected root", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-restore-save-"));
  const notices: string[] = [];
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "");
    const collected = join(root, "exec-collected");
    const unreadable = join(root, "exec-unreadable");
    await mkdir(unreadable);

    // The unreadable group's own wave and bundle are gone from disk. A failed
    // group read proves nothing about whether that group's task released them,
    // so they stay required and reach the first persisted snapshot too.
    const missingWave = join(root, "wave-of-unreadable-group");
    const missingBundle = {
      version: 1 as const,
      operationId: "op-unreadable",
      waveId: "wave-unreadable",
      taskId: "task-unreadable",
      waveRoot: missingWave,
      expectedRevision: 2,
    };
    const manager = managerFor(repo, notices);
    const result = await manager.restoreAssociations({
      waveRoots: [missingWave],
      bundles: [missingBundle],
      groupRoots: [collected, unreadable],
    });
    assert.ok(result);
    assert.deepEqual(result!.associations.waveRoots, [missingWave],
      "a missing wave is not proven released by a group this restore could not read");
    assert.deepEqual(result!.associations.bundles, [missingBundle]);
    assert.deepEqual(result!.associations.groupRoots, [unreadable],
      "the gone execution root is still reconciled out while the unreadable one is kept");

    const state = createState();
    const config = normalizeConfig({ enabled: true });
    const store = new SessionStateStore({ sessionId: "restore-boundary", sessionFile, cwd: repo });
    const persistence = createSessionPersistence({
      pi: {},
      state,
      isSessionActive: () => true,
      // Exactly the accessor the Pi host wires for its session sidecar.
      associations: () => manager.persistableAssociations(),
      reviewConfig: () => config,
    });
    persistence.bindStore(store);

    assert.equal(await persistence.persistConfirmed(), true, "the first post-restore save is acknowledged");
    const saved = await sidecarExecution(root);
    assert.ok(!(saved.groupRoots ?? []).includes(collected),
      "the collected execution root is not put back on disk");
    assert.deepEqual(saved.groupRoots, [unreadable],
      "the unreadable group's root survives the first save, so its work is still recoverable");
    assert.deepEqual(saved.waveRoots, [missingWave]);
    assert.deepEqual(saved.bundles, [missingBundle]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a superseded restore never replaces the current owner's retained persistence snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-restore-superseded-"));
  const notices: string[] = [];
  try {
    const older = join(root, "exec-unreadable-older");
    const current = join(root, "exec-unreadable-current");
    await mkdir(older);
    await mkdir(current);
    const manager = managerFor(root, notices);

    let releaseOlder!: () => void;
    const parked = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let reachedNotifier = false;
    const olderRestore = manager.restoreAssociations(
      { waveRoots: [], bundles: [], groupRoots: [older] },
      undefined,
      async (message) => {
        if (!reachedNotifier && message.includes(older)) {
          reachedNotifier = true;
          await parked;
        }
      },
    );
    for (let waited = 0; !reachedNotifier && waited < 5_000; waited += 10) await new Promise((done) => setTimeout(done, 10));
    assert.ok(reachedNotifier, "the older restore is parked in the unreadable group's awaited notifier");

    // A second restore on the same actual manager finishes while the first is parked.
    const currentResult = await manager.restoreAssociations({ waveRoots: [], bundles: [], groupRoots: [current] });
    releaseOlder();
    const olderResult = await olderRestore;

    assert.equal(olderResult?.recovery.reasons[0]?.code, "restore-superseded",
      "a restore whose owner scope already closed reports itself superseded");
    assert.ok(currentResult, "a real manager reports a structured restore result");
    assert.ok(currentResult!.recovery.reasons.some((reason: { kind: string }) => reason.kind === "group"),
      "the current owner's own unreadable root is still reported unresolved");
    assert.deepEqual(manager.persistableAssociations().groupRoots, [current],
      "the superseded input is never retained: only the current owner's root survives the next save");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi's save boundary keeps the missing and unreadable roots with both unanchored same-root gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-restore-boundary-pi-"));
  const notices: string[] = [];
  try {
    const gone = join(root, "exec-verified-gone");   // never created: positively absent
    const unreadable = join(root, "exec-unreadable"); // exists, carries no manifest
    await mkdir(unreadable);
    const target = await mkdtemp(join(root, "target-"));
    const gate = (executionId: string, taskId: string, paths: string[]) => ({
      executionId, taskId, sourceRoot: target, paths,
      activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: join(target, "manifest.json"), reason: "conflict",
    });
    // Two DISTINCT gates for one source root: the one-per-root store can install
    // at most one, so the other exists only in the restore's required set.
    const gateA = gate("exec-a", "task-a", ["a.ts"]);
    const gateB = gate("exec-b", "task-b", ["b.ts"]);
    const manager = managerFor(root, notices);
    const loaded: ExecutionAssociationsSnapshot = {
      waveRoots: [], bundles: [], groupRoots: [gone, unreadable], conflictGates: [gateA, gateB],
    };

    const result = await manager.restoreAssociations(loaded);
    assert.ok(result, "a real manager reports a structured restore result");
    assert.equal(result!.recovery.complete, false);
    assert.ok(result!.recovery.reasons.some((reason) => reason.code === "group-unavailable" && reason.id === gone),
      "the missing group might have held one of the gated tasks");
    assert.ok(result!.recovery.reasons.some((reason) => reason.code === "gate-collapsed"),
      "the gate the store could not install is reported, not silently dropped");

    // What Pi's session writer actually samples is the snapshot it persists.
    const saved = manager.associations();
    assert.deepEqual(saved, manager.persistableAssociations(),
      "Pi's sampled snapshot IS the persistence projection, not the raw live one");
    assert.deepEqual(saved.groupRoots, [gone, unreadable],
      "neither group was proven safe to drop from the next save");
    assert.equal(saved.conflictGates?.length, 2,
      "both same-root gate records survive an ordinary post-restore save");

    // The hazard the discarded record created: with only one gate persisted, the
    // next owner sees no collapse at all and its MarkClean could release that
    // root without ever validating the discarded sibling. Re-restoring what Pi
    // just saved must therefore keep reporting the collapse.
    const successor = managerFor(root, notices);
    const next = await successor.restoreAssociations(saved);
    assert.ok(next, "the successor restore reports a structured result");
    assert.ok(next!.recovery.reasons.some((reason) => reason.code === "gate-collapsed"),
      "the next owner still knows this root carries gates it cannot all install");
    assert.deepEqual(next!.associations.groupRoots, [gone, unreadable]);
    assert.equal(next!.associations.conflictGates?.length, 2,
      "both gate records stay required for the next owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an omitted groupRoots roster is never persisted as an authoritative empty roster", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-restore-roster-"));
  const notices: string[] = [];
  try {
    ownedActivityTest.resetOwnedActivityForTests();
    activateOwnedActivity();
    registerOwnedActivitySource("backgroundTasks", "review");
    const repo = join(root, "repo");
    await mkdir(repo);
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "");

    // A legacy saved conversation: empty wave and bundle lists, and no
    // groupRoots field at all. The omission is the only evidence that cleanup
    // ownership was never established.
    const loaded = { waveRoots: [], bundles: [] } as ExecutionAssociationsSnapshot;
    assert.equal("groupRoots" in loaded, false, "the loaded record really omits the roster");

    const manager = managerFor(repo, notices);
    const first = await manager.restoreAssociations(loaded);
    assert.ok(first, "a real manager reports a structured restore result");
    assert.equal(first!.recovery.complete, false, "an omitted roster cannot prove an empty owned set");
    assert.ok(first!.recovery.reasons.some((reason) => reason.code === "roster-absent"),
      `the shared result says why, got ${JSON.stringify(first!.recovery.reasons)}`);
    await awaitActivityRefresh();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "cleanup ownership stays unknown while the roster is unestablished");
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "current-runtime activity is still an independently established known zero");

    const state = createState();
    const config = normalizeConfig({ enabled: true });
    const store = new SessionStateStore({ sessionId: "restore-roster", sessionFile, cwd: repo });
    const persistence = createSessionPersistence({
      pi: {},
      state,
      isSessionActive: () => true,
      // Exactly the accessor the Pi session writer samples for its sidecar.
      associations: () => manager.associations(),
      reviewConfig: () => config,
    });
    persistence.bindStore(store);

    assert.equal(await persistence.persistConfirmed(), true, "the post-restore save is acknowledged");
    const saved = await sidecarExecution(root);
    assert.equal(saved.groupRoots, undefined,
      "Pi never turns a roster omission into the empty roster the next start would read as authoritative");

    // Reload: the next conversation reads the same omission and stays unknown.
    const reloaded: ExecutionAssociationsSnapshot = {
      waveRoots: saved.waveRoots ?? [],
      bundles: saved.bundles ?? [],
      ...(saved.groupRoots === undefined ? {} : { groupRoots: saved.groupRoots }),
    };
    assert.equal("groupRoots" in reloaded, false, "the reloaded record still carries no roster");
    const successor = managerFor(repo, notices);
    const second = await successor.restoreAssociations(reloaded);
    assert.ok(second);
    assert.ok(second!.recovery.reasons.some((reason) => reason.code === "roster-absent"),
      "the reloaded record is still not an authoritative empty owned set");
    assert.equal(second!.recovery.complete, false);
    await awaitActivityRefresh();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "cleanup ownership is still unknown after the save/reload round trip");
    assert.equal(activeActivitySnapshot().activeTasks, 0, "live activity remains a known zero");
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});
