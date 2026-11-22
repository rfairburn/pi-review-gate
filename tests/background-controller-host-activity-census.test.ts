/**
 * #682: host-only per-owner activity census (src/execution/background-controller.ts).
 *
 * Independent native owners read their own controller's EXISTING canonical
 * activity census through a host-local source instead of the process-global Pi
 * reporter registry. These regressions prove, with the registry never
 * activated, deterministic known zero -> one -> zero per owner, incomplete
 * (unknown, never zero) while a Start admission is in flight or the census
 * fails, independence between owners (counts and signals), fail-closed input
 * validation, and that the Pi registry source path is unchanged. Nothing ever
 * dispatches (no worker capacity), so no executor process is spawned.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BackgroundExecutionController,
  type HostActivityCensus,
} from "../src/execution/background-controller";
import { ExecutionToolManager } from "../src/execution/tool";
import { transitionTaskState } from "../src/execution/task-state";
import { createState } from "../src/state";
import { registerReviewActivitySource, __test as reviewActivityTest } from "../src/activation/review-activity";
import {
  OWNED_ACTIVITY_STATE_KEY,
  activateOwnedActivity,
  activeActivitySnapshot,
  isOwnedActivityActive,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import { boundedScalingConfig, controllerInternals, initGitRepo, settleOldestUnsettled } from "./helpers/background-controller-fixtures";

const EMPTY_ASSOCIATIONS = { waveRoots: [], bundles: [], groupRoots: [] };
const TASK = { title: "census target", instructions: "do the thing", acceptanceCriteria: ["done"] };

function hostController(root: string, faults?: ConstructorParameters<typeof BackgroundExecutionController>[0]["faults"]) {
  return new BackgroundExecutionController({
    pi: undefined,
    config: boundedScalingConfig(),
    state: createState(),
    cwd: () => root,
    hostActivityCensus: true,
    ...(faults === undefined ? {} : { faults }),
  });
}

function censusOf(controller: BackgroundExecutionController): HostActivityCensus {
  const census = controller.hostActivityCensus();
  assert.ok(census, "a host controller exposes its own census");
  return census;
}

async function count(census: HostActivityCensus): Promise<number | null> {
  const read = await census.read();
  if (read.status !== "complete") return null;
  assert.equal(read.count, read.tokens.size, "the count is exactly the verified token set");
  return read.count;
}

const flushSignals = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Holds exactly the next durable save after hold(): resolves `held` once the
 * save is parked, and release() lets it (and everything chained behind it) run.
 */
class SaveGate {
  private holding = false;
  private releaseHeld: (() => void) | undefined;
  private notifyHeld: (() => void) | undefined;
  hold(): Promise<void> {
    this.holding = true;
    return new Promise<void>((resolve) => { this.notifyHeld = resolve; });
  }
  readonly hook = async (): Promise<void> => {
    if (!this.holding) return;
    this.holding = false;
    const held = new Promise<void>((resolve) => { this.releaseHeld = resolve; });
    this.notifyHeld?.();
    await held;
  };
  release(): void {
    this.holding = false;
    this.releaseHeld?.();
    this.releaseHeld = undefined;
  }
}

const TEMP_ENV = ["TMPDIR", "TMP", "TEMP"] as const;

/**
 * Runs `body` with an owned disposable temp base: workspace roots AND the
 * controller's own `pi-review-execution-*` roots (allocated under tmpdir())
 * live inside it, and it is removed in `finally` on success or failure.
 */
async function withRoots<T>(names: string[], body: (roots: string[]) => Promise<T>): Promise<T> {
  const savedEnv = TEMP_ENV.map((key) => [key, process.env[key]] as const);
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-host-census-"));
  try {
    const base = await realpath(scratch);
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    for (const key of TEMP_ENV) process.env[key] = base;
    assert.equal(tmpdir(), base, "execution roots are allocated inside the owned base");
    const roots: string[] = [];
    for (const name of names) {
      const root = await mkdtemp(join(base, `workspace-${name}-`));
      roots.push(root);
      await initGitRepo(root);
    }
    return await body(roots);
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

test("independent host owners each read known zero -> one -> zero with the Pi registry off", async () => {
  await withRoots(["a", "b"], async ([rootA, rootB]) => {
    const a = hostController(rootA!);
    const b = hostController(rootB!);
    const censusA = censusOf(a);
    const censusB = censusOf(b);
    assert.notEqual(censusA, censusB);
    let signalsA = 0;
    let signalsB = 0;
    const unsubscribeA = censusA.subscribe(() => { signalsA += 1; });
    const unsubscribeB = censusB.subscribe(() => { signalsB += 1; });

    await a.restore(EMPTY_ASSOCIATIONS);
    await b.restore(EMPTY_ASSOCIATIONS);
    assert.equal(await count(censusA), 0, "a clean restore is a known zero for owner A");
    assert.equal(await count(censusB), 0, "a clean restore is a known zero for owner B");

    await flushSignals();
    signalsA = 0;
    signalsB = 0;
    const started = await a.start([TASK]);
    assert.equal(await count(censusA), 1, "queued work counts immediately for its own owner");
    assert.equal(await count(censusB), 0, "an unrelated owner is not affected");
    await flushSignals();
    assert.ok(signalsA > 0, "the owner's lifecycle change signals its own subscribers");
    assert.equal(signalsB, 0, "an unrelated owner's subscribers receive no signal");

    const group = controllerInternals(a).groups.get(started.executionId)!;
    transitionTaskState(group.tasks[0]!, "failed");
    await controllerInternals(a).save(group);
    assert.equal(await count(censusA), 0, "settled work returns the owner to a known zero");
    assert.equal(await count(censusB), 0);

    // No process-global registry was ever created or activated.
    assert.equal(isOwnedActivityActive(), false);
    assert.equal((globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY], undefined);
    assert.equal(activeActivitySnapshot().activeTasks, null, "the Pi view stays unknown: nothing reported to it");

    unsubscribeA();
    unsubscribeB();
  });
});

test("an in-flight Start admission or failed census reads incomplete, never zero", async () => {
  const gate = new SaveGate();
  let failCensus = false;
  await withRoots(["admission"], async ([root]) => {
    const controller = hostController(root!, {
      save: gate.hook,
      currentActivityCensus: () => {
        if (failCensus) throw new Error("injected census failure");
      },
    });
    const census = censusOf(controller);
    await controller.restore(EMPTY_ASSOCIATIONS);
    assert.equal(await count(census), 0);

    const held = gate.hold();
    const starting = controller.start([TASK]);
    try {
      // A Start that rejects or never reaches the hold fails the test (and
      // still reaches cleanup) instead of stranding it on `held`.
      await Promise.race([
        held,
        starting.then(() => assert.fail("Start completed before its save was held")),
      ]);
      assert.deepEqual(await census.read(), { status: "incomplete" }, "an admission in flight is unknown");
    } finally {
      gate.release();
      await starting;
    }
    assert.equal(await count(census), 1, "the admitted task counts once the admission settles");

    failCensus = true;
    assert.deepEqual(await census.read(), { status: "incomplete" }, "a failed census is unknown, not zero");
    failCensus = false;
    assert.equal(await count(census), 1);
  });
});

test("a detach that drains a held save on a settled group ends with a signalled known zero", async () => {
  const gate = new SaveGate();
  await withRoots(["detach"], async ([root]) => {
    const controller = hostController(root!, { save: gate.hook });
    const census = censusOf(controller);
    await controller.restore(EMPTY_ASSOCIATIONS);
    const started = await controller.start([TASK]);
    const internals = controllerInternals(controller);
    const group = internals.groups.get(started.executionId)!;
    // Fully settled (landed): no retained ownership anchor, so detach's own
    // finalizer raises no uncertainty signal that could mask a missing
    // post-detach readiness signal.
    await settleOldestUnsettled(controller, started.executionId, "detach");
    assert.equal(await count(census), 0, "the settled group is a known zero before detach");

    // A subscriber that only re-reads on signals: no polling anywhere.
    const reads: Array<Promise<number | null>> = [];
    const unsubscribe = census.subscribe(() => { reads.push(count(census)); });
    const held = gate.hold();
    const saving = internals.save(group);
    let detaching: Promise<void> | undefined;
    try {
      await Promise.race([
        held,
        saving.then(() => assert.fail("Save completed without reaching the hold")),
      ]);
      detaching = controller.detach();
      await flushSignals();
      assert.equal(await count(census), null, "detach with a pending save tail is unknown");
    } finally {
      gate.release();
      await saving.catch(() => undefined);
      await detaching;
    }
    await flushSignals();
    assert.ok(reads.length > 0, "detach completion signalled the subscriber");
    const results = await Promise.all(reads);
    assert.equal(results.at(-1), 0, "the last signalled read after detach is a known zero");
    unsubscribe();
  });
});

test("a throwing or rejecting listener cannot break signal delivery to others", async () => {
  await withRoots(["listeners"], async ([root]) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = hostController(root!);
      const census = censusOf(controller);
      let asyncFailed = false;
      let healthyReceived = false;
      census.subscribe(async () => {
        await census.read();
        asyncFailed = true;
        throw new Error("async projection failure");
      });
      census.subscribe(() => { throw new Error("sync projection failure"); });
      census.subscribe(() => { healthyReceived = true; });
      await controller.restore(EMPTY_ASSOCIATIONS);
      // An empty census performs no disk reads: flushing delivers every queued
      // callback and lets any unhandled rejection be reported, without ever
      // waiting on delivery itself (which could strand cleanup on regression).
      for (let i = 0; i < 3; i += 1) await flushSignals();
      assert.ok(healthyReceived, "the healthy listener received the signal");
      assert.ok(asyncFailed, "the async listener reached its rejection");
      assert.deepEqual(unhandled, [], "no listener failure escapes as an unhandled rejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

test("host census input is validated fail closed and is host-only", async () => {
  await withRoots([], async () => {
    const base = { config: boundedScalingConfig(), state: createState(), cwd: () => tmpdir() };
    assert.throws(
      () => new BackgroundExecutionController({ ...base, pi: {}, hostActivityCensus: true }),
      /cannot be combined with a Pi host/,
    );
    assert.throws(
      () => new BackgroundExecutionController({ ...base, pi: undefined, hostActivityCensus: false as unknown as true }),
      /must be exactly true/,
    );
    assert.equal(new BackgroundExecutionController({ ...base, pi: {} }).hostActivityCensus(), undefined);

    assert.throws(
      () => new ExecutionToolManager({ ...base, pi: undefined, hostActivityCensus: true }),
      /requires a managed tool host exposure/,
    );
    const piManager = new ExecutionToolManager({ ...base, pi: {} });
    assert.equal(piManager.activityCensus(), undefined, "a Pi manager has no host census");
    const plainHost = new ExecutionToolManager({ ...base, pi: undefined, hostExposure: { actions: ["start", "inspect"] } });
    assert.equal(plainHost.activityCensus(), undefined, "a host manager opts in explicitly");
    const host = new ExecutionToolManager({
      ...base,
      pi: undefined,
      hostExposure: { actions: ["start", "inspect"] },
      hostActivityCensus: true,
    });
    const census = host.activityCensus();
    assert.ok(census);
    await host.restoreAssociations(EMPTY_ASSOCIATIONS);
    assert.deepEqual(await census.read(), { status: "complete", count: 0, tokens: new Set() });
  });
});

test("the Pi registry source is unchanged and host owners never share or retire it", async () => {
  await withRoots(["pi", "host"], async ([piRoot, hostRoot]) => {
    // A host owner created before activation leaves nothing pending to replay.
    const host = hostController(hostRoot!);
    activateOwnedActivity();
    registerReviewActivitySource();
    const pi = new BackgroundExecutionController({
      pi: {},
      config: boundedScalingConfig(),
      state: createState(),
      cwd: () => piRoot!,
    });
    await pi.restore(EMPTY_ASSOCIATIONS);
    await host.restore(EMPTY_ASSOCIATIONS);
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "the Pi registry establishes zero as before");

    await host.start([TASK]);
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 0, "host work is never reported through the Pi registry");
    assert.equal(await count(censusOf(host)), 1);

    await pi.start([TASK]);
    await ownedActivityTest.settleOwnedActivityIntentRefreshForTests();
    assert.equal(activeActivitySnapshot().activeTasks, 1, "Pi work counts through the registry as before");
    assert.equal(
      (pi as unknown as { ownedActivity: { retired: boolean } }).ownedActivity.retired,
      false,
      "a host owner never supersedes the Pi registry source",
    );
    assert.equal(await count(censusOf(host)), 1, "the host owner's own count is unaffected");
  });
});
