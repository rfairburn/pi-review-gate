/**
 * #736 slice 3c: focused tests for the host's native review lane owner
 * (`src/session-host/native-review-lane-owner.ts`).
 *
 * These drive the REAL persisted settings reader against REAL settings files in
 * a test-owned temporary root — no second settings store and no fake reader is
 * substituted for the one the host uses, because "a fresh read of what the
 * sidebar editor saved, at THIS arm" is the whole contract. Only the coordinator
 * construction is recorded, so a refusal can be proven to have constructed
 * nothing at all, and an arm can be inspected for the exact facts the host hands
 * its coordinator (this row's workspace and checkpoint directory, this backend's
 * own switch, and this host's ONE admitted Pi executable).
 *
 * Every temporary root is created by this file and removed by it, and no
 * pre-existing file is touched.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import type { ReviewGateConfig } from "../src/config";
import type {
  NativeReviewCoordinatorDependencies,
  NativeReviewCoordinator,
} from "../src/session-host/native-review-coordinator";
import { createNativeReviewCoordinator } from "../src/session-host/native-review-coordinator";
import type { NativeReviewCoordinatorHandle, NativeReviewLaneOwner } from "../src/session-host/instances";
import type { NativeHookBackgroundMember } from "../src/session-host/native-hook-protocol";
import type { NativeReviewRequest } from "../src/session-host/native-review-hook-protocol";
import {
  NATIVE_REVIEW_CODEX_BACKGROUND_DETAIL,
  NATIVE_REVIEW_NO_BACKGROUND_DETAIL,
  createNativeReviewLaneOwner,
  nativeReviewLaneBackgroundState,
} from "../src/session-host/native-review-lane-owner";
import type { PersistedReviewGateSource } from "../src/session-host/persisted-review-gate-snapshot";

const PI_FILE = "/synthetic/pi/dist/cli.js";

const ownedRoots: string[] = [];

afterEach(async () => {
  const roots = ownedRoots.splice(0);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface LaneHarness {
  readonly root: string;
  readonly settingsPath: string;
  readonly source: PersistedReviewGateSource;
  readonly owner: NativeReviewLaneOwner;
  /** Every coordinator the owner constructed, in order, with the deps it got. */
  readonly arms: { readonly deps: NativeReviewCoordinatorDependencies; readonly handle: NativeReviewCoordinatorHandle }[];
  writeSettings(value: unknown): Promise<void>;
  removeSettings(): Promise<void>;
  dispose(): Promise<void>;
}

/** A settings document the persisted reader accepts, with the two switches set. */
function settings(claude: boolean | undefined, codex: boolean | undefined, enabled = true): unknown {
  return {
    enabled,
    reviewerTimeoutMs: 30_000,
    review: {
      activeReviewers: [],
      ...(claude === undefined ? {} : { primaryClaudeCodeEnabled: claude }),
      ...(codex === undefined ? {} : { primaryCodexEnabled: codex }),
    },
  };
}

async function createLaneHarness(options: {
  readonly initial?: unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly readSnapshot?: (source: PersistedReviewGateSource) => never;
  /** Replaces the recording factory, e.g. to make construction itself throw. */
  readonly createCoordinator?: (deps: NativeReviewCoordinatorDependencies) => NativeReviewCoordinatorHandle;
} = {}): Promise<LaneHarness> {
  const root = await mkdtemp(join(tmpdir(), "prg-native-review-lane-"));
  ownedRoots.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(root, "review-gate.json");
  if (options.initial !== undefined) await writeFile(settingsPath, JSON.stringify(options.initial), "utf8");

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    // The persisted reader's own explicit-override rule: one absolute path this
    // test owns, so the snapshot is this file and nothing the machine has.
    PI_REVIEW_GATE_CONFIG: settingsPath,
    ...options.env,
  };
  const source: PersistedReviewGateSource = { env, agentDir, resolvedHomeDir: join(root, "home") };

  const arms: LaneHarness["arms"] = [];
  const owner = createNativeReviewLaneOwner({
    settings: source,
    admittedPiCommand: PI_FILE,
    testHooks: {
      ...(options.readSnapshot === undefined ? {} : { readSnapshot: options.readSnapshot }),
      createCoordinator: options.createCoordinator ?? ((deps): NativeReviewCoordinatorHandle => {
        const handle: NativeReviewCoordinatorHandle = {
          onReviewRequest: async () => ({ action: "allow" as const }),
          noteToolActivity: () => undefined,
          dispose: async () => undefined,
        };
        arms.push({ deps, handle });
        return handle;
      }),
    },
  });

  let disposed = false;
  return {
    root,
    settingsPath,
    source,
    owner,
    arms,
    async writeSettings(value) {
      await writeFile(settingsPath, JSON.stringify(value), "utf8");
    },
    async removeSettings() {
      await rm(settingsPath, { force: true });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
    },
  };
}

const CLAUDE_ARM = { rowId: "row-1", backend: "claude" as const, workspace: "/row/workspace", checkpointAgentDir: "/row/checkpoint" };
const CODEX_ARM = { rowId: "row-2", backend: "codex" as const, workspace: "/row/workspace", checkpointAgentDir: "/row/checkpoint" };

// ---------------------------------------------------------------------------
// The opt-in decision, re-read at every arm
// ---------------------------------------------------------------------------

test("a backend whose own switch is Off arms no lane and constructs nothing", async () => {
  const lane = await createLaneHarness({ initial: settings(false, true) });
  try {
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "Claude's switch is Off");
    assert.deepEqual(lane.arms, [], "a refusal constructs no coordinator");
    // The other backend's switch answers only for itself.
    assert.notEqual(lane.owner.create(CODEX_ARM), undefined, "Codex's switch is On");
    assert.equal(lane.arms.length, 1);
  } finally {
    await lane.dispose();
  }
});

test("an absent switch is Off: the persisted default never arms a lane", async () => {
  const lane = await createLaneHarness({ initial: settings(undefined, undefined) });
  try {
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined);
    assert.equal(lane.owner.create(CODEX_ARM), undefined);
    assert.deepEqual(lane.arms, []);
  } finally {
    await lane.dispose();
  }
});

test("the master Review switch wins over both per-backend switches", async () => {
  const lane = await createLaneHarness({ initial: settings(true, true, false) });
  try {
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "the whole review gate is Off");
    assert.equal(lane.owner.create(CODEX_ARM), undefined);
    assert.deepEqual(lane.arms, []);
  } finally {
    await lane.dispose();
  }
});

test("a missing, unreadable, malformed, or invalid settings file arms no lane", async () => {
  const missing = await createLaneHarness();
  try {
    assert.equal(missing.owner.create(CLAUDE_ARM), undefined, "no settings file exists");
    assert.deepEqual(missing.arms, []);
  } finally {
    await missing.dispose();
  }

  const lane = await createLaneHarness({ initial: settings(true, true) });
  try {
    assert.notEqual(lane.owner.create(CLAUDE_ARM), undefined, "the same owner arms when the file is valid");
    await lane.writeSettings("{ not json");
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "a malformed document is not a settings state");
    await lane.writeSettings(JSON.stringify({ enabled: "yes" }));
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "a document a Save would reject is not a settings state");
    await lane.writeSettings(JSON.stringify({ enabled: true, review: { primaryClaudeCodeEnabled: "true" } }));
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "a non-boolean switch is never exactly true");
    assert.equal(lane.arms.length, 1, "every refusal after the first constructed nothing");
  } finally {
    await lane.dispose();
  }
});

test("a settings read that throws is the same refusal, never a lane and never an error", async () => {
  const lane = await createLaneHarness({
    initial: settings(true, true),
    readSnapshot: () => {
      throw new Error("the settings root could not be read");
    },
  });
  try {
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined);
    assert.deepEqual(lane.arms, []);
  } finally {
    await lane.dispose();
  }
});

test("a coordinator factory that throws is the same refusal, never an error reaching the arm", async () => {
  let reached = 0;
  const lane = await createLaneHarness({
    initial: settings(true, true),
    createCoordinator: (): NativeReviewCoordinatorHandle => {
      reached += 1;
      throw new Error("the coordinator could not be constructed");
    },
  });
  try {
    // The opt-in was On, so this throw is the owner's to absorb: it is the same
    // `undefined` a refused arm returns, and it never reaches the launch.
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "a throwing factory is the same refusal the opt-in gives");
    assert.equal(reached, 1, "the factory was actually reached, so the throw is the owner's to absorb");
    assert.equal(lane.owner.create(CODEX_ARM), undefined, "a later arm is contained the same way");
    assert.equal(reached, 2, "each arm is attempted once");
    assert.deepEqual(lane.arms, [], "no coordinator survived");
  } finally {
    await lane.dispose();
  }
});

test("the global kill switch arms no lane even when both switches are On", async () => {
  const lane = await createLaneHarness({
    initial: settings(true, true),
    env: { PI_REVIEW_GATE_DISABLED: "1" },
  });
  try {
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "the kill switch is not a review opt-in");
    assert.equal(lane.owner.create(CODEX_ARM), undefined);
    assert.deepEqual(lane.arms, []);
  } finally {
    await lane.dispose();
  }
});

test("every arm re-reads the file, so a switch that moved between arms is honored", async () => {
  const lane = await createLaneHarness({ initial: settings(true, true) });
  try {
    assert.notEqual(lane.owner.create(CLAUDE_ARM), undefined, "On at the first arm");
    await lane.writeSettings(settings(false, true));
    assert.equal(lane.owner.create(CLAUDE_ARM), undefined, "Off before the next arm, with no host restart");
    await lane.writeSettings(settings(true, true));
    assert.notEqual(lane.owner.create(CLAUDE_ARM), undefined, "On again at the arm after that");
    assert.equal(lane.arms.length, 2);
  } finally {
    await lane.dispose();
  }
});

// ---------------------------------------------------------------------------
// What an armed lane is given
// ---------------------------------------------------------------------------

test("an armed lane gets this row's facts and this host's one admitted Pi executable", async () => {
  const lane = await createLaneHarness({ initial: settings(true, true) });
  try {
    const handle = lane.owner.create(CLAUDE_ARM);
    assert.ok(handle, "the switch is On, so this row gets a lane");
    assert.equal(lane.arms.length, 1);
    const deps = lane.arms[0]!.deps;
    assert.equal(deps.backend, "claude");
    assert.equal(deps.workspace, CLAUDE_ARM.workspace);
    assert.equal(deps.checkpointAgentDir, CLAUDE_ARM.checkpointAgentDir);
    assert.equal(deps.admittedPiCommand, PI_FILE, "the host's already-resolved Pi, never a second resolution");

    const codex = lane.owner.create(CODEX_ARM);
    assert.ok(codex);
    assert.equal(lane.arms[1]!.deps.backend, "codex");
    assert.equal(lane.arms[1]!.deps.admittedPiCommand, PI_FILE);
  } finally {
    await lane.dispose();
  }
});

test("readConfig re-reads persisted settings on every call and yields undefined when they stop being readable", async () => {
  const lane = await createLaneHarness({ initial: settings(true, true) });
  try {
    lane.owner.create(CLAUDE_ARM);
    const readConfig = lane.arms[0]!.deps.readConfig;

    const first = readConfig();
    assert.ok(first, "the settings are readable now");
    assert.equal(first!.reviewerTimeoutMs, 30_000);

    // The very next call sees the file as it is now: no cache, no snapshot.
    await lane.writeSettings({ ...settings(true, true) as Record<string, unknown>, reviewerTimeoutMs: 45_000 });
    const second = readConfig() as ReviewGateConfig;
    assert.equal(second.reviewerTimeoutMs, 45_000, "every call reads the current file");

    // Mid-run Off: the next request of a live lane sees it and stops reviewing.
    await lane.writeSettings(settings(false, true));
    assert.equal((readConfig() as ReviewGateConfig).review?.primaryClaudeCodeEnabled, false);

    // Unreadable is `undefined`, which the coordinator reads as allow-with-notice
    // or close-window — never as a reviewer running on a stale guess.
    await lane.removeSettings();
    assert.equal(readConfig(), undefined, "a file that is gone is not a settings state");
    await writeFile(lane.settingsPath, "not json at all", "utf8");
    assert.equal(readConfig(), undefined, "a malformed file is not a settings state");
    await lane.writeSettings(settings(true, true));
    assert.notEqual(readConfig(), undefined, "and a readable file is readable again, still without a restart");
  } finally {
    await lane.dispose();
  }
});

test("the host's facts are bound once, so a later caller mutation cannot redirect or switch the read", async () => {
  const lane = await createLaneHarness({ initial: settings(true, true) });
  try {
    const other = join(lane.root, "other-gate.json");
    await writeFile(other, JSON.stringify(settings(false, false)), "utf8");
    lane.owner.create(CLAUDE_ARM);
    const readConfig = lane.arms[0]!.deps.readConfig;
    assert.notEqual(readConfig(), undefined);
    // The owner froze its own copy of the source at construction, so the
    // caller's object is not what a later read consults — neither its path nor
    // its kill switch.
    lane.source.env.PI_REVIEW_GATE_DISABLED = "1";
    (lane.source.env as Record<string, string>).PI_REVIEW_GATE_CONFIG = other;
    const still = readConfig() as ReviewGateConfig;
    assert.equal(still.review?.primaryClaudeCodeEnabled, true,
      "the owner still reads the path it bound, not one the caller pointed at later");
  } finally {
    await lane.dispose();
  }
});

// ---------------------------------------------------------------------------
// The default coordinator is the real one
// ---------------------------------------------------------------------------

test("without a test seam the owner constructs the real Pi-free coordinator", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-native-review-lane-real-"));
  ownedRoots.push(root);
  const settingsPath = join(root, "review-gate.json");
  await writeFile(settingsPath, JSON.stringify(settings(true, true)), "utf8");
  const workspace = join(root, "workspace");
  const checkpoint = join(root, "checkpoint");
  await mkdir(workspace);
  await mkdir(checkpoint);
  const owner = createNativeReviewLaneOwner({
    settings: {
      env: { PI_REVIEW_GATE_CONFIG: settingsPath, HOME: join(root, "home") },
      agentDir: join(root, "agent"),
      resolvedHomeDir: join(root, "home"),
    },
    admittedPiCommand: PI_FILE,
  });
  const handle = owner.create({ rowId: "row-real", backend: "claude", workspace, checkpointAgentDir: checkpoint });
  assert.ok(handle, "the switch is On");
  assert.equal(typeof handle.onReviewRequest, "function");
  assert.equal(typeof handle.noteToolActivity, "function");
  assert.equal(typeof handle.dispose, "function");
  // The returned object IS the real coordinator, so its Pi-free surface exists.
  assert.equal((handle as unknown as NativeReviewCoordinator).activityTracked, false);
  assert.deepEqual(await handle.dispose(), { unreviewedConversations: 0 });

  // And with the switch Off the same owner constructs nothing at all.
  await writeFile(settingsPath, JSON.stringify(settings(false, false)), "utf8");
  assert.equal(owner.create({ rowId: "row-real", backend: "claude", workspace, checkpointAgentDir: checkpoint }), undefined);
});

// ---------------------------------------------------------------------------
// The background mapping the lane answers from
// ---------------------------------------------------------------------------

const request = (backgroundTasks?: readonly NativeHookBackgroundMember[]): NativeReviewRequest => ({
  backend: "claude",
  event: "Stop",
  sessionId: "session-1",
  ...(backgroundTasks === undefined ? {} : { backgroundTasks }),
});

test("the Claude background mapping reads the provider's own membership projection", () => {
  assert.deepEqual(nativeReviewLaneBackgroundState("claude", request()), {
    state: "unknown",
    detail: NATIVE_REVIEW_NO_BACKGROUND_DETAIL,
  }, "an absent array is never read as idle");
  assert.deepEqual(nativeReviewLaneBackgroundState("claude", request([])), { state: "idle" },
    "a positively observed empty set is idle");
  assert.deepEqual(nativeReviewLaneBackgroundState("claude", request([
    { id: "task-a", kind: "shell" },
    { id: "task-b", kind: "task" },
  ])), { state: "running", count: 2 }, "membership is the count the deferral reports");
});

test("Codex reads its owned census: both sides observed decide, anything else is unknown", () => {
  const codexRequest: NativeReviewRequest = { ...request([{ id: "task-a", kind: "shell" }]), backend: "codex" };
  const unknown = { state: "unknown", detail: NATIVE_REVIEW_CODEX_BACKGROUND_DETAIL };
  assert.deepEqual(nativeReviewLaneBackgroundState("codex", codexRequest), unknown,
    "no census reader never certifies a workspace, whatever the request carries");
  assert.deepEqual(nativeReviewLaneBackgroundState("codex", request([]), () => ({ tasks: 0, shells: 0 })), { state: "idle" });
  assert.deepEqual(nativeReviewLaneBackgroundState("codex", request(), () => ({ tasks: 1, shells: 2 })),
    { state: "running", count: 3 }, "tasks and shells both defer, summed");
  for (const census of [
    { tasks: null, shells: 0 },
    { tasks: 0, shells: null },
    { tasks: -1, shells: 0 },
    { tasks: 0.5, shells: 0 },
    { tasks: Number.NaN, shells: 0 },
  ]) {
    assert.deepEqual(nativeReviewLaneBackgroundState("codex", request(), () => census), unknown, JSON.stringify(census));
  }
  assert.deepEqual(nativeReviewLaneBackgroundState("codex", request(), () => { throw new Error("census gone"); }), unknown,
    "a throwing census reader is contained and read as unknown");
  // Both unknown details are bounded single-line notice text: the coordinator
  // folds them into a verdict's userMessage, which the transport bounds.
  for (const detail of [NATIVE_REVIEW_NO_BACKGROUND_DETAIL, NATIVE_REVIEW_CODEX_BACKGROUND_DETAIL]) {
    assert.ok(detail.length > 0 && detail.length < 200);
    assert.equal(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(detail), false);
  }
});

test("the lane's background seam is the mapping, applied to this backend", async () => {
  const lane = await createLaneHarness({ initial: settings(true, true) });
  try {
    lane.owner.create(CODEX_ARM);
    assert.deepEqual(await lane.arms[0]!.deps.backgroundState(request([])), {
      state: "unknown",
      detail: NATIVE_REVIEW_CODEX_BACKGROUND_DETAIL,
    }, "an arm without the manager's census reader stays unknown");
    let census = { tasks: 0 as number | null, shells: 1 as number | null };
    lane.owner.create({ ...CODEX_ARM, backgroundCensus: () => census });
    const deps = lane.arms[1]!.deps;
    assert.deepEqual(await deps.backgroundState(request([])), { state: "running", count: 1 },
      "the manager's census for this row is what the coordinator sees");
    census = { tasks: 0, shells: 0 };
    assert.deepEqual(await deps.backgroundState(request([])), { state: "idle" }, "read fresh at every Stop");
  } finally {
    await lane.dispose();
  }
});

test("createNativeReviewCoordinator is the production default the seam replaces", () => {
  // The seam is a seam, not a second path: the owner's default is the real
  // factory this suite also drives directly above.
  assert.equal(typeof createNativeReviewCoordinator, "function");
});
