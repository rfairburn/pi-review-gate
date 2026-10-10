import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { createState } from "../src/state";
import {
  activateOwnedActivity,
  activeActivitySnapshot,
  isOwnedActivityActive,
  ownedActivitySnapshot,
  reconcileRetiredExecutionActivity,
  registerOwnedActivitySource,
  OWNED_ACTIVITY_STATE_KEY,
  type OwnedActivitySourceHandle,
  type RetiredOwnedActivityReconciliation,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import {
  BackgroundExecutionController,
  type BackgroundExecutionGroup,
  type BackgroundTaskRecord,
} from "../src/execution/background-controller";
import { transitionTaskState } from "../src/execution/task-state";
import {
  acquireOperationOwner,
  createOperationRecord,
  createReattachmentBundle,
  recordOperationChildProcess,
  releaseOperationOwner,
  writeOperationRecord,
} from "../src/execution/operation-record";
import { boundedScalingConfig, initGitRepo } from "./helpers/background-controller-fixtures";

const EMPTY_ASSOCIATIONS = { waveRoots: [], bundles: [], groupRoots: [] };

function completeExpectedSources(): void {
  activateOwnedActivity();
  const review = registerOwnedActivitySource("backgroundTasks", "review");
  const shell = registerOwnedActivitySource("backgroundShells", "background-shell");
  review.resolveUncertainty();
  review.resolveIntentUncertainty();
  shell.resolveUncertainty();
  shell.resolveIntentUncertainty();
}

function controller(cwd: () => string, notify?: (message: string) => void): BackgroundExecutionController {
  return new BackgroundExecutionController({
    pi: {},
    config: boundedScalingConfig(),
    state: createState(),
    cwd,
    ...(notify ? { notify } : {}),
  });
}

beforeEach(() => ownedActivityTest.resetOwnedActivityForTests());
afterEach(() => ownedActivityTest.resetOwnedActivityForTests());

test("retired reconciliation stays inert until an authenticated reporter activates the registry", async () => {
  let calls = 0;
  registerOwnedActivitySource("backgroundTasks", "execution", {
    reconcileRetired: async () => {
      calls += 1;
      return {
        ownership: { complete: true, tokens: [], released: [] },
        intent: { complete: true, tokens: [], released: [] },
      };
    },
  });
  await reconcileRetiredExecutionActivity();
  assert.equal(isOwnedActivityActive(), false);
  assert.equal(calls, 0);
  assert.equal(ownedActivitySnapshot().backgroundTasks, null);

  activateOwnedActivity();
  registerOwnedActivitySource("backgroundTasks", "execution");
  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 1, "the retained callback becomes eligible only after opt-in and retirement");
});

test("each session_start reads every eligible retired owner without empty-source starvation", async () => {
  completeExpectedSources();
  const calls: string[] = [];
  const emptyProof = (name: string) => async () => {
    calls.push(name);
    return {
      ownership: { complete: true as const, tokens: [], released: [] },
      intent: { complete: true as const, tokens: [], released: [] },
    };
  };
  const olderUnknown = registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: emptyProof("older-unknown"),
  });
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: emptyProof("newer-unknown"),
  });
  registerOwnedActivitySource("backgroundTasks", "execution", {
    reconcileRetired: emptyProof("newest-known-empty"),
  });
  registerOwnedActivitySource("backgroundTasks", "execution");

  // A legacy one-shot marker from an earlier module copy is scheduling history,
  // not evidence that this exact owner must never be read again.
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<Record<string, unknown>>>>;
  };
  registry.sources.get("backgroundTasks")!.get("execution")![0]!.reconciliationAttempted = true;

  await reconcileRetiredExecutionActivity();
  assert.deepEqual(calls, ["older-unknown", "newer-unknown"],
    "one pass reads every unknown retired owner and skips only the proven empty newer owner");
  await reconcileRetiredExecutionActivity();
  assert.deepEqual(calls, ["older-unknown", "newer-unknown"],
    "proven complete empty owners are skipped on later events without polling");
  assert.equal(olderUnknown.retired, true);
});

test("only an exact retired execution callback can clear a proven empty incarnation", async () => {
  completeExpectedSources();
  let calls = 0;
  const old = registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async (retained) => {
      calls += 1;
      assert.deepEqual(retained, { ownership: [], intent: [] });
      return {
        ownership: { complete: true, tokens: [], released: [] },
        intent: { complete: true, tokens: [], released: [] },
      };
    },
  });
  const newer = registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
  });

  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "a replacement registration does not clear retired uncertainty");
  newer.resolveUncertainty();
  newer.resolveIntentUncertainty();
  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 1);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 0,
    "the validated empty census resolves only the exact retired owner");
  assert.equal(activeActivitySnapshot().activeTasks, 0);
  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 1, "a proven complete empty source needs no later read");
  assert.equal(old.retired, true);
});

test("a failed or incomplete retired read retries only on a later explicit event", async () => {
  completeExpectedSources();
  let calls = 0;
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary read failure");
      if (calls === 2) return {}; // No complete channel: uncertainty must remain.
      return {
        ownership: { complete: true, tokens: [], released: [] },
        intent: { complete: true, tokens: [], released: [] },
      };
    },
  });
  registerOwnedActivitySource("backgroundTasks", "execution");

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 1);
  assert.equal(ownedActivitySnapshot().backgroundTasks, null);
  await Promise.resolve();
  assert.equal(calls, 1, "there is no timer, retry loop, or polling after a failed read");

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 2);
  assert.equal(ownedActivitySnapshot().backgroundTasks, null, "an incomplete result remains fail closed");

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 3);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 0,
    "a later complete exact-owner read can clear the prior uncertainty");
});

test("failed, missing, and incomplete censuses invalidate formerly known channels without releasing tokens", async () => {
  completeExpectedSources();
  let calls = 0;
  const old = registerOwnedActivitySource("backgroundTasks", "execution", {
    reconcileRetired: async (retained) => {
      calls += 1;
      if (calls === 1) throw new Error("retired inventory read failed");
      if (calls === 2) return {}; // No applicable proof is not complete evidence.
      if (calls === 3) return {
        ownership: { complete: false },
        intent: { complete: false },
      };
      return {
        ownership: { complete: true, tokens: [...retained.ownership], released: [] },
        intent: { complete: true, tokens: [], released: [] },
      };
    },
  });
  old.acquire("retained-owner");
  const newer = registerOwnedActivitySource("backgroundTasks", "execution");
  newer.resolveUncertainty();
  newer.resolveIntentUncertainty();

  assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  assert.equal(activeActivitySnapshot().activeTasks, 0,
    "the old intent channel was known zero before its retained owner was censused");
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<{
      id: string;
      retired: boolean;
      tokens: Set<string>;
      intentTokens: Set<string>;
      uncertain: boolean;
      intentUncertain: boolean;
    }>>>;
  };
  const entries = registry.sources.get("backgroundTasks")!.get("execution")!;
  const retired = entries.find((entry) => entry.id === old.incarnation)!;
  const current = entries.find((entry) => entry.id === newer.incarnation)!;

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 1);
  assert.equal(ownedActivitySnapshot().backgroundTasks, null);
  assert.equal(activeActivitySnapshot().activeTasks, null,
    "a failed fresh read cannot preserve an unjustified known-zero intent channel");
  assert.deepEqual([...retired.tokens], ["retained-owner"]);
  assert.equal(retired.intentUncertain, true);
  assert.equal(current.intentUncertain, false, "the newer incarnation stays untouched");

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 2);
  assert.equal(activeActivitySnapshot().activeTasks, null,
    "a missing channel proof remains unknown on a later explicit event");
  assert.deepEqual([...retired.tokens], ["retained-owner"]);

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 3);
  assert.equal(activeActivitySnapshot().activeTasks, null,
    "an explicit incomplete result cannot claim zero");
  assert.deepEqual([...retired.tokens], ["retained-owner"]);

  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 4);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1,
    "a later complete ownership proof retains the exact positive token");
  assert.equal(activeActivitySnapshot().activeTasks, 0,
    "a later complete stopped proof can re-establish zero activity");
  assert.deepEqual([...retired.tokens], ["retained-owner"]);
  assert.equal(current.intentUncertain, false);
});

test("stale incomplete channels cannot invalidate recovered exact or newer source data", async () => {
  completeExpectedSources();
  let finish!: (value: {
    ownership: { complete: false };
    intent: { complete: false };
  }) => void;
  let signalEntered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const pending = new Promise<{
    ownership: { complete: false };
    intent: { complete: false };
  }>((resolve) => { finish = resolve; });
  const old = registerOwnedActivitySource("backgroundTasks", "execution", {
    reconcileRetired: async () => {
      signalEntered();
      return pending;
    },
  });
  old.acquire("stale-owner");
  const newer = registerOwnedActivitySource("backgroundTasks", "execution");
  newer.resolveUncertainty();
  newer.resolveIntentUncertainty();
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<{
      id: string;
      retired: boolean;
      tokens: Set<string>;
      intentTokens: Set<string>;
      uncertain: boolean;
      intentUncertain: boolean;
      revision: number;
    }>>>;
  };
  const entries = registry.sources.get("backgroundTasks")!.get("execution")!;
  const current = entries.find((entry) => entry.id === newer.incarnation)!;
  const currentRevision = current.revision;

  const pass = reconcileRetiredExecutionActivity();
  await callbackEntered;
  // An exact-source recovery/mutation supersedes the pending read while the
  // replacement remains known zero.
  old.markIntentUncertain();
  old.resolveIntentUncertainty();
  finish({ ownership: { complete: false }, intent: { complete: false } });
  await pass;

  assert.equal(old.retired, true);
  assert.equal(entries.find((entry) => entry.id === old.incarnation)!.intentUncertain, false);
  assert.equal(activeActivitySnapshot().activeTasks, 0,
    "the stale incomplete output does not undo later recovered zero");
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1,
    "stale incomplete ownership output cannot drop the retained positive token");
  assert.deepEqual([...entries.find((entry) => entry.id === old.incarnation)!.tokens], ["stale-owner"]);
  assert.equal(current.intentUncertain, false);
  assert.equal(current.revision, currentRevision, "the newer source is not mutated by the stale result");
});

test("a throwing ownership result accessor does not suppress valid intent proof", async () => {
  completeExpectedSources();
  const old = registerOwnedActivitySource("backgroundTasks", "execution", {
    intentUncertain: true,
    reconcileRetired: async () => {
      const result: RetiredOwnedActivityReconciliation = {
        intent: { complete: true, tokens: ["retained-intent"], released: [] },
      };
      Object.defineProperty(result, "ownership", {
        enumerable: true,
        get() {
          throw new Error("synthetic ownership channel accessor failure");
        },
      });
      return result;
    },
  });
  old.acquire("retained-owner");
  old.acquireIntent("retained-intent");
  const newer = registerOwnedActivitySource("backgroundTasks", "execution");
  newer.resolveUncertainty();
  newer.resolveIntentUncertainty();
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<{
      id: string;
      retired: boolean;
      tokens: Set<string>;
      intentTokens: Set<string>;
      uncertain: boolean;
      intentUncertain: boolean;
      revision: number;
    }>>>;
  };
  const entries = registry.sources.get("backgroundTasks")!.get("execution")!;
  const retired = entries.find((entry) => entry.id === old.incarnation)!;
  const current = entries.find((entry) => entry.id === newer.incarnation)!;
  const currentRevision = current.revision;

  assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  assert.equal(activeActivitySnapshot().activeTasks, null);
  await reconcileRetiredExecutionActivity();

  assert.equal(retired.uncertain, true,
    "the throwing ownership property fails closed only for ownership");
  assert.equal(retired.intentUncertain, false,
    "the independent complete intent channel resolves despite the ownership accessor failure");
  assert.deepEqual([...retired.tokens], ["retained-owner"], "ownership tokens are not released");
  assert.deepEqual([...retired.intentTokens], ["retained-intent"]);
  assert.equal(ownedActivitySnapshot().backgroundTasks, null);
  assert.equal(activeActivitySnapshot().activeTasks, 1);
  assert.equal(current.revision, currentRevision, "the newer source remains untouched");
});

test("nested channel accessors cannot overwrite newer exact-source recovery", async () => {
  completeExpectedSources();
  let calls = 0;
  let old!: OwnedActivitySourceHandle;
  old = registerOwnedActivitySource("backgroundTasks", "execution", {
    reconcileRetired: async (retained) => {
      calls += 1;
      return {
        ownership: { complete: true as const, tokens: [...retained.ownership], released: [] },
        intent: calls === 1 ? {
          get complete(): false {
            old.markIntentUncertain();
            old.resolveIntentUncertainty();
            return false;
          },
        } : { complete: true as const, tokens: [], released: [] },
      };
    },
  });
  old.acquire("retained-owner");
  registerOwnedActivitySource("backgroundTasks", "execution");
  assert.equal(activeActivitySnapshot().activeTasks, 0);
  await reconcileRetiredExecutionActivity();
  assert.equal(activeActivitySnapshot().activeTasks, 0,
    "nested accessor recovery supersedes the stale incomplete result");
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  assert.equal(calls, 1);
  await reconcileRetiredExecutionActivity();
  assert.equal(calls, 2, "a later explicit event can retry");
  assert.equal(activeActivitySnapshot().activeTasks, 0);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
});

test("one owner's read error does not skip independent eligible owners", async () => {
  completeExpectedSources();
  const calls: string[] = [];
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async () => {
      calls.push("throws");
      throw new Error("owner unavailable");
    },
  });
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async () => {
      calls.push("independent");
      return {
        ownership: { complete: true, tokens: [], released: [] },
        intent: { complete: true, tokens: [], released: [] },
      };
    },
  });
  registerOwnedActivitySource("backgroundTasks", "execution");

  await reconcileRetiredExecutionActivity();
  assert.deepEqual(calls, ["throws", "independent"]);
  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "the failed owner remains unknown while the independent owner's proof is applied");
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<{ uncertain: boolean }>>>;
  };
  assert.equal(registry.sources.get("backgroundTasks")!.get("execution")![1]!.uncertain, false);
});

test("reentrant and concurrent passes share at most one in-flight read per source", async () => {
  completeExpectedSources();
  const calls = new Map<string, number>();
  const finish: Array<() => void> = [];
  const pendingProof = (name: string) => () => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (calls.get(name) === 1) void reconcileRetiredExecutionActivity();
    return new Promise<{ ownership: { complete: true; tokens: string[]; released: string[] }; intent: { complete: true; tokens: string[]; released: string[] } }>((resolve) => {
      finish.push(() => resolve({
        ownership: { complete: true, tokens: [], released: [] },
        intent: { complete: true, tokens: [], released: [] },
      }));
    });
  };
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true, intentUncertain: true, reconcileRetired: pendingProof("first"),
  });
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true, intentUncertain: true, reconcileRetired: pendingProof("second"),
  });
  registerOwnedActivitySource("backgroundTasks", "execution");

  const firstPass = reconcileRetiredExecutionActivity();
  await Promise.all([reconcileRetiredExecutionActivity(), reconcileRetiredExecutionActivity()]);
  assert.deepEqual([...calls.entries()], [["first", 1], ["second", 1]]);
  assert.equal(finish.length, 2);
  for (const complete of finish) complete();
  await firstPass;
  assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
});

test("replacement emptiness cannot erase positive tokens or uncertainty from another incarnation", async () => {
  completeExpectedSources();
  const old = registerOwnedActivitySource("backgroundTasks", "execution", { uncertain: true, intentUncertain: true });
  old.acquire("old-positive");
  old.acquireIntent("old-running");
  const newer = registerOwnedActivitySource("backgroundTasks", "execution");
  newer.acquire("new-positive");
  newer.acquireIntent("new-running");
  newer.resolveUncertainty();
  newer.resolveIntentUncertainty();

  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "the new empty/positive source cannot resolve the old uncertain source");
  assert.equal(activeActivitySnapshot().activeTasks, null);
  old.resolveUncertainty(); // exact old handle only
  old.resolveIntentUncertainty();
  assert.equal(ownedActivitySnapshot().backgroundTasks, 2);
  assert.equal(activeActivitySnapshot().activeTasks, 2,
    "resolving the old incarnation preserves both distinct positive sources");
});

test("per-channel release proofs are required, and legacy entries stay intent-unknown", async () => {
  completeExpectedSources();
  const old = registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async () => ({
      ownership: { complete: true, tokens: [], released: [] }, // cannot drop an old positive
      intent: { complete: true, tokens: [], released: ["intent-token"] },
    }),
  });
  old.acquire("owned-token");
  old.acquireIntent("intent-token");
  registerOwnedActivitySource("backgroundTasks", "execution");
  await reconcileRetiredExecutionActivity();
  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "an omitted retained ownership token without settlement proof is not released");
  assert.equal(activeActivitySnapshot().activeTasks, 0,
    "the independently proven stopped intent token clears without clearing ownership uncertainty");

  ownedActivityTest.resetOwnedActivityForTests();
  activateOwnedActivity();
  const legacyReview = registerOwnedActivitySource("backgroundTasks", "review");
  legacyReview.resolveUncertainty();
  legacyReview.resolveIntentUncertainty();
  const legacy = registerOwnedActivitySource("backgroundTasks", "execution");
  legacy.acquire("legacy-owner");
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<Record<string, unknown>>>>;
  };
  const legacyEntry = registry.sources.get("backgroundTasks")!.get("execution")![0]!;
  delete legacyEntry.intentTokens;
  delete legacyEntry.intentUncertain;
  delete legacyEntry.reconcileRetired;
  delete legacyEntry.reconciliationAttempted;
  legacy.markUncertain();
  const replacement = registerOwnedActivitySource("backgroundTasks", "execution");
  replacement.resolveUncertainty();
  replacement.resolveIntentUncertainty();
  await reconcileRetiredExecutionActivity();
  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "legacy entries without a callback retain uncertainty and their positive token");
  assert.equal(activeActivitySnapshot().activeTasks, null,
    "a new incarnation cannot invent legacy intent history");
});

test("stale asynchronous results are discarded after source mutation or re-registration", async () => {
  completeExpectedSources();
  let finish!: (value: { ownership: { complete: true; tokens: string[]; released: string[] }; intent: { complete: true; tokens: string[]; released: string[] } }) => void;
  let mutationCalls = 0;
  const pendingResult = new Promise<{
    ownership: { complete: true; tokens: string[]; released: string[] };
    intent: { complete: true; tokens: string[]; released: string[] };
  }>((resolve) => { finish = resolve; });
  const old = registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async (retained) => {
      mutationCalls += 1;
      if (mutationCalls === 1) return pendingResult;
      return {
        ownership: { complete: true, tokens: [...retained.ownership], released: [] },
        intent: { complete: true, tokens: [...(retained.intent ?? [])], released: [] },
      };
    },
  });
  registerOwnedActivitySource("backgroundTasks", "execution");
  const attempt = reconcileRetiredExecutionActivity();
  old.acquire("concurrent-token"); // increments the exact old incarnation's revision
  finish({
    ownership: { complete: true, tokens: [], released: [] },
    intent: { complete: true, tokens: [], released: [] },
  });
  await attempt;
  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "an async census cannot clear uncertainty after concurrent token mutation");
  assert.equal(mutationCalls, 1);
  await reconcileRetiredExecutionActivity();
  assert.equal(mutationCalls, 2, "a later event gets a fresh exact-token snapshot");
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1,
    "the later complete result retains the concurrent positive token and clears uncertainty");
  assert.equal(activeActivitySnapshot().activeTasks, 0);

  ownedActivityTest.resetOwnedActivityForTests();
  completeExpectedSources();
  let finishAfterRegistration!: (value: { ownership: { complete: true; tokens: string[]; released: string[] }; intent: { complete: true; tokens: string[]; released: string[] } }) => void;
  const registrationResult = new Promise<{
    ownership: { complete: true; tokens: string[]; released: string[] };
    intent: { complete: true; tokens: string[]; released: string[] };
  }>((resolve) => { finishAfterRegistration = resolve; });
  let signalEntered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
  let registrationCalls = 0;
  registerOwnedActivitySource("backgroundTasks", "execution", {
    uncertain: true,
    intentUncertain: true,
    reconcileRetired: async (retained) => {
      registrationCalls += 1;
      if (registrationCalls === 1) {
        signalEntered();
        return registrationResult;
      }
      return {
        ownership: { complete: true, tokens: [...retained.ownership], released: [] },
        intent: { complete: true, tokens: [...(retained.intent ?? [])], released: [] },
      };
    },
  });
  registerOwnedActivitySource("backgroundTasks", "execution", { uncertain: true, intentUncertain: true });
  const delayedAttempt = reconcileRetiredExecutionActivity();
  await callbackEntered;
  registerOwnedActivitySource("backgroundTasks", "execution", { uncertain: true, intentUncertain: true });
  finishAfterRegistration({
    ownership: { complete: true, tokens: [], released: [] },
    intent: { complete: true, tokens: [], released: [] },
  });
  await delayedAttempt;
  assert.equal(registrationCalls, 1, "a registration race discards the captured pass without restarting it");
  assert.equal(ownedActivitySnapshot().backgroundTasks, null,
    "registration of a newer source fences the delayed older result");
  await reconcileRetiredExecutionActivity();
  assert.equal(registrationCalls, 2, "a later event may retry the unchanged exact owner");
  const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
    sources: Map<string, Map<string, Array<{ uncertain: boolean }>>>;
  };
  assert.equal(registry.sources.get("backgroundTasks")!.get("execution")![0]!.uncertain, false);
});

test("pre-opt-in task admission invalidates a retained empty inventory until a completed detach", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-preoptin-"));
  try {
    await initGitRepo(root);
    const old = controller(() => root);
    await old.restore(EMPTY_ASSOCIATIONS);
    const started = await old.start([{ title: "pre-opt-in", instructions: "work", acceptanceCriteria: ["done"] }]);
    const oldInternals = old as unknown as { groups: Map<string, BackgroundExecutionGroup> };
    assert.equal(oldInternals.groups.get(started.executionId)?.tasks.length, 1);
    assert.equal(isOwnedActivityActive(), false, "the old source acquired work before telemetry opt-in");

    completeExpectedSources();
    const replacement = controller(() => root);
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "a stale empty capture cannot clear the pre-opt-in owner's uncertainty");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "replacement emptiness cannot invent the old owner's missed activity token");
    await old.detach();
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted empty restore is recovered from its retained exact owner before replacement restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-empty-"));
  try {
    completeExpectedSources();
    const old = controller(() => root);
    await old.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0);

    const interruptedRestore = old.restore(EMPTY_ASSOCIATIONS);
    const racingDetach = old.detach();
    await Promise.all([interruptedRestore, racingDetach]);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "the interrupted restore leaves its exact source uncertain");

    const replacement = controller(() => join(root, "replacement-session"));
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 0,
      "an exact old-owner empty read restores known zero before ordinary replacement restoration");
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    await old.detach();
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing group plus throwing notify remains unknown without successful proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-missing-"));
  try {
    completeExpectedSources();
    let notifications = 0;
    const old = controller(() => root, () => {
      notifications += 1;
      throw new Error("synthetic notify failure");
    });
    await old.restore(EMPTY_ASSOCIATIONS);
    const missingRoot = join(root, "pi-review-execution-missing");
    await assert.rejects(old.restore({ waveRoots: [], bundles: [], groupRoots: [missingRoot] }));
    assert.equal(notifications, 1);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);

    const replacement = controller(() => root);
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "missing authoritative roots remain unknown after this failed read");
    assert.equal(notifications, 1, "the read-only census never notifies");
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stopped task keeps cleanup ownership while a validated stop clears only activity intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-stopped-"));
  try {
    await initGitRepo(root);
    completeExpectedSources();
    let notifications = 0;
    const old = controller(() => root, () => { notifications += 1; });
    await old.restore(EMPTY_ASSOCIATIONS);
    const started = await old.start([{ title: "stopped", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = old as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save(group: BackgroundExecutionGroup): Promise<unknown>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    const artifactDir = join(group.root, "artifacts", task.taskId);
    await mkdir(artifactDir, { recursive: true });
    const operation = createOperationRecord({
      waveId: "wave-retired-stopped",
      taskId: task.taskId,
      title: task.definition.title,
      worktreeRoot: group.cwd,
      effectiveCwd: group.cwd,
      artifactDir,
      retryBudget: 0,
    });
    acquireOperationOwner(operation);
    releaseOperationOwner(operation);
    await writeOperationRecord(operation);
    task.waveRoot = group.root;
    task.generation = 1;
    task.bundle = createReattachmentBundle(operation, group.root);
    transitionTaskState(task, "failed");
    await internals.save(group);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    const durableBefore = await readFile(join(group.root, "execution.json"));
    await old.detach();
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "detach retains uncertainty and the cleanup token");

    const nextCwd = join(root, "next-session");
    await mkdir(nextCwd);
    const replacement = controller(() => nextCwd);
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1,
      "the exact old source still owns the stopped task's recovery/cleanup anchor");
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "validated released operation ownership proves the task is stopped independently");
    assert.deepEqual(await readFile(join(group.root, "execution.json")), durableBefore,
      "retired reconciliation performs no durable writes or task-state transitions");
    assert.equal(notifications, 0, "retired reconciliation does not notify");
    assert.equal(task.state, "failed", "retired reconciliation does not auto-resume work");
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("controller-stale retired reads are discarded before fresh live-child evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-live-stopped-"));
  try {
    await initGitRepo(root);
    completeExpectedSources();
    const old = controller(() => root);
    await old.restore(EMPTY_ASSOCIATIONS);
    const started = await old.start([{ title: "live-stopped", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = old as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save(group: BackgroundExecutionGroup): Promise<unknown>;
      syncOwnedTask(task: BackgroundTaskRecord): void;
      readCensusOperation(
        group: BackgroundExecutionGroup,
        task: BackgroundTaskRecord,
        associationRevision?: number,
      ): Promise<{ status: "released" | "dead" | "live" | "uncertain" }>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    const artifactDir = join(group.root, "artifacts", task.taskId);
    await mkdir(artifactDir, { recursive: true });
    const operation = createOperationRecord({
      waveId: "wave-retired-live-stopped",
      taskId: task.taskId,
      title: task.definition.title,
      worktreeRoot: group.cwd,
      effectiveCwd: group.cwd,
      artifactDir,
      retryBudget: 0,
    });
    acquireOperationOwner(operation);
    // Synthetic lifecycle evidence only: this records the test process as a
    // live child lease; no executor/private session is started.
    recordOperationChildProcess(operation, process.pid);
    await writeOperationRecord(operation);
    task.waveRoot = group.root;
    task.generation = 1;
    task.bundle = createReattachmentBundle(operation, group.root);
    transitionTaskState(task, "stopped_for_application_exit");
    internals.syncOwnedTask(task);
    await internals.save(group);

    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "the stopped task starts with a positively known-zero activity channel");
    await old.detach();
    assert.equal(activeActivitySnapshot().activeTasks, 0,
      "detach sees no in-memory runtime/admission and leaves the persisted stopped state provisionally known zero");

    const nextCwd = join(root, "next-session");
    await mkdir(nextCwd);
    const newer = controller(() => nextCwd);
    await newer.restore(EMPTY_ASSOCIATIONS);
    const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
      sources: Map<string, Map<string, Array<{
        id: string;
        retired: boolean;
        tokens: Set<string>;
        intentTokens: Set<string>;
        uncertain: boolean;
        intentUncertain: boolean;
        revision: number;
      }>>>;
    };
    const entries = registry.sources.get("backgroundTasks")!.get("execution")!;
    const retired = entries.find((entry) => entry.retired)!;
    const current = entries.find((entry) => !entry.retired)!;
    const currentRevision = current.revision;
    const retiredRevision = retired.revision;
    const originalRead = internals.readCensusOperation.bind(old);
    let gateFirstRead = true;
    let signalRead!: () => void;
    const readEntered = new Promise<void>((resolve) => { signalRead = resolve; });
    let releaseRead!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
    internals.readCensusOperation = async (readGroup, readTask, associationRevision) => {
      if (gateFirstRead) {
        gateFirstRead = false;
        signalRead();
        await readBarrier;
      }
      return originalRead(readGroup, readTask, associationRevision);
    };

    const stalePass = reconcileRetiredExecutionActivity();
    await readEntered;
    await old.detach(); // Controller-local census revision changes; registry telemetry does not.
    assert.equal(retired.revision, retiredRevision);
    assert.equal(current.revision, currentRevision);
    releaseRead();
    await stalePass;
    assert.equal(retired.uncertain, true,
      "the controller-fenced stale result does not resolve ownership");
    assert.equal(retired.intentUncertain, false,
      "the discarded stale result does not turn known-zero intent into unknown");
    assert.deepEqual([...retired.tokens], [task.taskId]);
    assert.deepEqual([...retired.intentTokens], []);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    assert.equal(current.revision, currentRevision, "stale evidence does not mutate the newer source");

    await reconcileRetiredExecutionActivity(); // A later event retries against the newly sealed controller revision.
    assert.equal(retired.uncertain, false,
      "the independently complete ownership census resolves its exact channel");
    assert.equal(retired.intentUncertain, true,
      "the unverified live child prevents the stopped record from claiming zero activity");
    assert.deepEqual([...retired.tokens], [task.taskId], "the retained cleanup token is not released");
    assert.deepEqual([...retired.intentTokens], [], "the census does not fabricate a running intent token");
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
    assert.equal(activeActivitySnapshot().activeTasks, null);
    assert.equal(current.revision, currentRevision, "the recovered current incarnation is untouched");
    assert.equal(current.uncertain, false);
    assert.equal(current.intentUncertain, false);

    releaseOperationOwner(operation);
    await writeOperationRecord(operation);
    await reconcileRetiredExecutionActivity();
    assert.equal(retired.intentUncertain, false,
      "a later explicit read after validated stopped proof can recover activity zero");
    assert.equal(activeActivitySnapshot().activeTasks, 0);
    assert.equal(ownedActivitySnapshot().backgroundTasks, 1,
      "activity recovery does not release the separate positive cleanup owner");
    assert.deepEqual([...retired.tokens], [task.taskId]);
    assert.equal(current.revision, currentRevision, "later old-owner proof still does not mutate the current source");
    await newer.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("detach recaptures a force-merge admitted while save tails drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-detach-merge-"));
  try {
    await initGitRepo(root);
    completeExpectedSources();
    const old = controller(() => root);
    await old.restore(EMPTY_ASSOCIATIONS);
    const started = await old.start([{ title: "detach-merge", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = old as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save(group: BackgroundExecutionGroup): Promise<unknown>;
      saveTails: Map<string, Promise<void>>;
      recoverTaskAssociation(...args: unknown[]): Promise<unknown>;
      pendingForceMerges: Map<string, unknown>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    const artifactDir = join(group.root, "artifacts", task.taskId);
    await mkdir(artifactDir, { recursive: true });
    const operation = createOperationRecord({
      waveId: "wave-retired-detach-merge",
      taskId: task.taskId,
      title: task.definition.title,
      worktreeRoot: group.cwd,
      effectiveCwd: group.cwd,
      artifactDir,
      retryBudget: 0,
    });
    acquireOperationOwner(operation);
    releaseOperationOwner(operation);
    await writeOperationRecord(operation);
    task.waveRoot = group.root;
    task.generation = 1;
    task.bundle = createReattachmentBundle(operation, group.root);
    transitionTaskState(task, "failed");
    await internals.save(group);
    assert.equal(activeActivitySnapshot().activeTasks, 0);

    let releaseSaveTail!: () => void;
    const saveTail = new Promise<void>((resolve) => { releaseSaveTail = resolve; });
    internals.saveTails.set(group.executionId, saveTail);
    const detached = old.detach(); // Initial inventory is captured; quiescence now waits on saveTail.

    let releaseRecovery!: () => void;
    const recoveryBarrier = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let signalRecovery!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { signalRecovery = resolve; });
    internals.recoverTaskAssociation = async () => {
      signalRecovery();
      await recoveryBarrier;
      throw new Error("synthetic force-merge barrier released");
    };
    const merging = old.forceMerge({
      executionId: group.executionId,
      taskId: task.taskId,
      mergeAnyhow: true,
      instructionId: "detach-race-force-merge",
      actor: "user",
    });
    await recoveryEntered;
    assert.equal(internals.pendingForceMerges.has(task.taskId), true);
    assert.equal(activeActivitySnapshot().activeTasks, 1, "the in-flight merge owns a positive intent token");

    releaseSaveTail();
    await detached;
    assert.equal(ownedActivitySnapshot().backgroundTasks, null);
    assert.equal(activeActivitySnapshot().activeTasks, null);

    const replacement = controller(() => root);
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "the refreshed inventory does not clear ownership while force-merge is pending");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "the in-flight force-merge remains unknown after replacement restoration");
    const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
      sources: Map<string, Map<string, Array<{
        retired: boolean;
        tokens: Set<string>;
        intentTokens: Set<string>;
        uncertain: boolean;
        intentUncertain: boolean;
      }>>>;
    };
    const retired = registry.sources.get("backgroundTasks")!.get("execution")!.find((entry) => entry.retired)!;
    assert.equal(retired.tokens.has(task.taskId), true, "the old cleanup token remains owned");
    assert.equal(retired.intentTokens.has(task.taskId), true, "the old force-merge intent token is retained");
    assert.equal(retired.uncertain, true);
    assert.equal(retired.intentUncertain, true);

    releaseRecovery();
    await assert.rejects(merging, /synthetic force-merge barrier released/);
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt manifests and unmatched bundles remain unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-corrupt-"));
  try {
    await initGitRepo(root);
    completeExpectedSources();
    const old = controller(() => root);
    await old.restore(EMPTY_ASSOCIATIONS);
    const started = await old.start([{ title: "corrupt", instructions: "work", acceptanceCriteria: ["done"] }]);
    const group = (old as unknown as { groups: Map<string, BackgroundExecutionGroup> }).groups.get(started.executionId)!;
    await old.detach();
    await writeFile(join(group.root, "execution.json"), "{}\n");
    const replacement = controller(() => root);
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "a corrupt exact group cannot be replaced by an empty map");
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }

  const unmatchedRoot = await mkdtemp(join(tmpdir(), "pi-review-retired-unmatched-"));
  try {
    completeExpectedSources();
    const old = controller(() => unmatchedRoot);
    await old.restore(EMPTY_ASSOCIATIONS);
    await old.restore({
      waveRoots: [],
      groupRoots: [],
      bundles: [{
        version: 1,
        operationId: "wave-unmatched/task-unmatched",
        waveId: "wave-unmatched",
        taskId: "task-unmatched",
        waveRoot: join(unmatchedRoot, "missing-wave"),
        expectedRevision: 0,
      }],
    });
    await old.detach();
    const replacement = controller(() => unmatchedRoot);
    await reconcileRetiredExecutionActivity();
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "an unmatched retained bundle is not counted as an empty execution census");
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(unmatchedRoot, { recursive: true, force: true });
  }
});

test("uncertain operation liveness remains unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-retired-liveness-"));
  try {
    await initGitRepo(root);
    completeExpectedSources();
    const old = controller(() => root);
    await old.restore(EMPTY_ASSOCIATIONS);
    const started = await old.start([{ title: "liveness", instructions: "work", acceptanceCriteria: ["done"] }]);
    const internals = old as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      save(group: BackgroundExecutionGroup): Promise<unknown>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task: BackgroundTaskRecord = group.tasks[0]!;
    const artifactDir = join(group.root, "artifacts", task.taskId);
    await mkdir(artifactDir, { recursive: true });
    const operation = createOperationRecord({
      waveId: "wave-retired-liveness",
      taskId: task.taskId,
      title: task.definition.title,
      worktreeRoot: group.cwd,
      effectiveCwd: group.cwd,
      artifactDir,
      retryBudget: 0,
    });
    acquireOperationOwner(operation);
    await writeOperationRecord(operation);
    task.waveRoot = group.root;
    task.generation = 1;
    task.bundle = createReattachmentBundle(operation, group.root);
    transitionTaskState(task, "failed");
    await internals.save(group);
    (old as unknown as { ownedActivity: OwnedActivitySourceHandle }).ownedActivity.markIntentUncertain();
    await old.detach();

    const replacement = controller(() => root);
    const originalKill = process.kill;
    process.kill = (() => { throw Object.assign(new Error("synthetic liveness probe failure"), { code: "EIO" }); }) as typeof process.kill;
    try {
      await reconcileRetiredExecutionActivity();
    } finally {
      process.kill = originalKill;
    }
    await replacement.restore(EMPTY_ASSOCIATIONS);
    assert.equal(ownedActivitySnapshot().backgroundTasks, null,
      "uncertain operation ownership is never released by durable task state alone");
    assert.equal(activeActivitySnapshot().activeTasks, null,
      "uncertain process liveness cannot establish stopped activity");
    await replacement.detach();
  } finally {
    ownedActivityTest.resetOwnedActivityForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed lease identity and unsafe operation revision cannot clear retired evidence", async () => {
  for (const corruption of ["owner", "revision"] as const) {
    const root = await mkdtemp(join(tmpdir(), `pi-review-retired-corrupt-${corruption}-`));
    try {
      await initGitRepo(root);
      completeExpectedSources();
      const old = controller(() => root);
      await old.restore(EMPTY_ASSOCIATIONS);
      const started = await old.start([{ title: corruption, instructions: "work", acceptanceCriteria: ["done"] }]);
      const internals = old as unknown as {
        groups: Map<string, BackgroundExecutionGroup>;
        save(group: BackgroundExecutionGroup): Promise<unknown>;
      };
      const group = internals.groups.get(started.executionId)!;
      const task = group.tasks[0]!;
      const artifactDir = join(group.root, "artifacts", task.taskId);
      await mkdir(artifactDir, { recursive: true });
      const operation = createOperationRecord({
        waveId: `wave-retired-${corruption}`,
        taskId: task.taskId,
        title: task.definition.title,
        worktreeRoot: group.cwd,
        effectiveCwd: group.cwd,
        artifactDir,
        retryBudget: 0,
      });
      acquireOperationOwner(operation);
      releaseOperationOwner(operation);
      await writeOperationRecord(operation);
      const operationPath = join(artifactDir, "operation.json");
      const corrupted = JSON.parse(await readFile(operationPath, "utf8")) as Record<string, unknown>;
      if (corruption === "owner") corrupted.owner = { status: "released" };
      else corrupted.revision = Number(corrupted.revision) + 0.5;
      await writeFile(operationPath, `${JSON.stringify(corrupted, null, 2)}\n`);
      task.waveRoot = group.root;
      task.generation = 1;
      task.bundle = createReattachmentBundle(operation, group.root);
      transitionTaskState(task, "failed");
      await internals.save(group);
      (old as unknown as { ownedActivity: OwnedActivitySourceHandle }).ownedActivity.markIntentUncertain();
      await old.detach();

      const replacement = controller(() => root);
      await reconcileRetiredExecutionActivity();
      await replacement.restore(EMPTY_ASSOCIATIONS);
      assert.equal(ownedActivitySnapshot().backgroundTasks, null,
        `${corruption} corruption leaves ownership uncertainty intact`);
      assert.equal(activeActivitySnapshot().activeTasks, null,
        `${corruption} corruption cannot establish stopped activity`);
      const registry = (globalThis as Record<PropertyKey, unknown>)[OWNED_ACTIVITY_STATE_KEY] as {
        sources: Map<string, Map<string, Array<{
          retired: boolean;
          tokens: Set<string>;
          uncertain: boolean;
          intentUncertain?: boolean;
        }>>>;
      };
      const retired = registry.sources.get("backgroundTasks")!.get("execution")!.find((entry) => entry.retired)!;
      assert.equal(retired.tokens.has(task.taskId), true, "the old positive cleanup token is retained");
      assert.equal(retired.uncertain, true);
      assert.equal(retired.intentUncertain, true);
      await replacement.detach();
    } finally {
      ownedActivityTest.resetOwnedActivityForTests();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("lost runtime and force-merge owners remain unknown instead of being suppressed", async () => {
  for (const lostOwner of ["runtime", "force-merge"] as const) {
    const root = await mkdtemp(join(tmpdir(), `pi-review-retired-${lostOwner}-`));
    try {
      await initGitRepo(root);
      completeExpectedSources();
      const old = controller(() => root);
      await old.restore(EMPTY_ASSOCIATIONS);
      const started = await old.start([{ title: lostOwner, instructions: "work", acceptanceCriteria: ["done"] }]);
      const internals = old as unknown as {
        groups: Map<string, BackgroundExecutionGroup>;
        runtimes: Map<string, unknown>;
        pendingForceMerges: Map<string, unknown>;
      };
      const group = internals.groups.get(started.executionId)!;
      const task: BackgroundTaskRecord = group.tasks[0]!;
      if (lostOwner === "runtime") internals.runtimes.set(task.taskId, {});
      else internals.pendingForceMerges.set(task.taskId, {});
      await old.detach();
      assert.equal(ownedActivitySnapshot().backgroundTasks, null);

      const replacement = controller(() => root);
      await reconcileRetiredExecutionActivity();
      await replacement.restore(EMPTY_ASSOCIATIONS);
      assert.equal(ownedActivitySnapshot().backgroundTasks, null,
        `${lostOwner} evidence is not replaced by an empty replacement map`);
      assert.equal(activeActivitySnapshot().activeTasks, null,
        `${lostOwner} liveness is not inferred stopped`);
      await replacement.detach();
    } finally {
      ownedActivityTest.resetOwnedActivityForTests();
      await rm(root, { recursive: true, force: true });
    }
  }
});
