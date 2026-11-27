/**
 * #736 slice 3c: Main-level wiring of the automatic native review lane.
 *
 * These prove the HOST's choice, not the lane's behavior: the exact condition
 * under which Main hands its manager a `nativeReviewLane`, and nothing else.
 * The lane is armed only where the native hook registrar and observer pair is
 * armed, only on a broker that actually carries the review family, and only on a
 * host that owns its agent directory — anywhere else the manager options keep
 * the exact shape they had before this feature existed.
 *
 * The synthetic Main harness supplies the terminal, writer, and manager double.
 * The arming test uses the REAL local status broker (so the review-family probe
 * is the production broker's own method), real host ownership, and a REAL saved
 * settings file, so what the lane owner reads is the file the sidebar editor
 * would save. No provider CLI, model, or child is involved, and no review ever
 * runs: the lane is only asked whether a row gets a coordinator.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStatusBroker, type NativeReviewStatusBroker } from "../src/session-host/broker";
import type { NativeReviewLaneOwner } from "../src/session-host/instances";
import type { ProfilePreparer } from "../src/session-host/profiles";
import type { SidebarNativeCliTarget } from "../src/session-host/sidebar";

import {
  createHarness,
  nextTurn,
  ready,
  type FakeManager,
  type Harness,
  type MainTestDependencies,
} from "./helpers/session-host-main-harness";

const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
];

const ownedRoots = new Set<string>();

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-review-lane-main-")));
  ownedRoots.add(root);
  return root;
}

/**
 * A fixture root of its OWN for the broker's socket, passed straight to
 * `createStatusBroker`. A socket path under the workspace fixture root is too
 * long for macOS's 104-byte AF_UNIX limit once the temp prefix is included, so
 * the socket root is kept as short as the status-broker suite keeps its own —
 * the same pattern, for the same reason.
 */
function makeSocketRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-rvl-")));
  ownedRoots.add(root);
  return root;
}

/** A real native Pi agent directory with a real saved Review settings file. */
function makeAgentDir(root: string, review: Record<string, unknown> | undefined): string {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "keybindings.json"), "{}", "utf8");
  if (review !== undefined) {
    writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({
      enabled: true,
      review: { activeReviewers: [], ...review },
    }), "utf8");
  }
  return agentDir;
}

function hosting() {
  return () => ({
    targets: TARGETS,
    launch: async (backend: "claude" | "codex", request: { workspace: string; env: NodeJS.ProcessEnv }) => ({
      file: `/synthetic/${backend}`,
      args: [],
      env: { ...request.env },
      cwd: request.workspace,
    }),
  });
}

function profileRegistry(): ProfilePreparer {
  return { prepare: () => { throw new Error("no session is prepared in this test"); } };
}

async function closeHarness(harness: Harness, broker?: NativeReviewStatusBroker): Promise<void> {
  harness.signals.emit("SIGTERM");
  await harness.result;
  if (broker !== undefined) {
    try {
      await broker.dispose();
    } catch {
      // Main already disposed its broker; disposal is idempotent.
    }
  }
  for (const root of ownedRoots) {
    rmSync(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
}

const ARM = { rowId: "row-main", backend: "claude" as const, workspace: "/synthetic/workspace", checkpointAgentDir: "/synthetic/checkpoint" };
const CODEX_ARM = { ...ARM, rowId: "row-codex", backend: "codex" as const };

test("a hosting host on a review-capable broker hands its manager the automatic review lane", async () => {
  const root = makeRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = makeAgentDir(root, { primaryClaudeCodeEnabled: true });
  const socketRoot = makeSocketRoot();
  let created: NativeReviewStatusBroker | undefined;
  const dependencies: MainTestDependencies = {
    createBroker: async () => {
      created = await createStatusBroker({ socketRoot }) as NativeReviewStatusBroker;
      return created;
    },
    nativeCliHosting: hosting(),
    createSessionSetup: () => ({ nativeSetup: true, nativeAgentDir: agentDir, profileRegistry: profileRegistry() }),
  };
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: home } }, dependencies);
  try {
    const manager: FakeManager = await ready(harness);
    assert.ok(created, "the host created its broker");

    // The lane rides the observation pair it depends on, on the same broker.
    assert.equal(manager.options.nativeHookRegistrar, created, "the observation pair is armed");
    assert.equal(typeof manager.options.nativeStatusObserverFactory, "function");
    const lane = manager.options.nativeReviewLane as NativeReviewLaneOwner | undefined;
    assert.ok(lane && typeof lane.create === "function", "the review-capable host arms the lane owner");

    // The lane reads THIS host's saved settings, at this arm: Claude is On.
    const handle = lane!.create(ARM);
    assert.ok(handle, "the backend's own switch is On in the file this host saves");
    assert.equal(typeof handle.onReviewRequest, "function");
    assert.equal(typeof handle.noteToolActivity, "function");
    assert.equal(typeof handle.dispose, "function");
    await handle.dispose();

    // Codex's switch is not set in that file, so its row gets nothing.
    assert.equal(lane!.create(CODEX_ARM), undefined, "the other backend's row is unchanged");
  } finally {
    await closeHarness(harness, created);
  }
});

test("a settings file that does not opt the backend in still arms the lane owner but arms no row", async () => {
  const root = makeRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = makeAgentDir(root, { primaryClaudeCodeEnabled: false });
  const socketRoot = makeSocketRoot();
  let created: NativeReviewStatusBroker | undefined;
  const dependencies: MainTestDependencies = {
    createBroker: async () => {
      created = await createStatusBroker({ socketRoot }) as NativeReviewStatusBroker;
      return created;
    },
    nativeCliHosting: hosting(),
    createSessionSetup: () => ({ nativeSetup: true, nativeAgentDir: agentDir, profileRegistry: profileRegistry() }),
  };
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: home } }, dependencies);
  try {
    const manager: FakeManager = await ready(harness);
    const lane = manager.options.nativeReviewLane as NativeReviewLaneOwner | undefined;
    assert.ok(lane, "the host arms the owner; the decision is per row and per arm");
    assert.equal(lane.create(ARM), undefined, "the saved switch is Off, so this row is the row it was");
  } finally {
    await closeHarness(harness, created);
  }
});

test("a host with no native hosting wires no review lane at all", async () => {
  const harness = createHarness();
  try {
    const manager: FakeManager = await ready(harness);
    assert.equal(manager.options.nativeCliLaunch, undefined);
    assert.ok(!("nativeHookRegistrar" in manager.options), "no observation pair, by the existing rule");
    assert.ok(!("nativeReviewLane" in manager.options), "and therefore no review lane either");
  } finally {
    await closeHarness(harness);
  }
});

test("a broker without the native hook family arms neither the pair nor the review lane", async () => {
  const root = makeRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = makeAgentDir(root, { primaryClaudeCodeEnabled: true });
  // The harness default broker is a Pi-only facade: it carries no native hook
  // family, so the pair is never armed and the lane cannot be either.
  const dependencies: MainTestDependencies = {
    nativeCliHosting: hosting(),
    createSessionSetup: () => ({ nativeSetup: true, nativeAgentDir: agentDir, profileRegistry: profileRegistry() }),
  };
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: home } }, dependencies);
  try {
    const manager: FakeManager = await ready(harness);
    assert.equal(typeof manager.options.nativeCliLaunch, "function", "this host does offer native sessions");
    assert.ok(!("nativeHookRegistrar" in manager.options));
    assert.ok(!("nativeReviewLane" in manager.options), "no review-family broker, no lane");
  } finally {
    await closeHarness(harness);
  }
});

test("a host that does not own its agent directory arms no review lane", async () => {
  const root = makeRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = makeAgentDir(root, { primaryClaudeCodeEnabled: true });
  const socketRoot = makeSocketRoot();
  let created: NativeReviewStatusBroker | undefined;
  const dependencies: MainTestDependencies = {
    createBroker: async () => {
      created = await createStatusBroker({ socketRoot }) as NativeReviewStatusBroker;
      return created;
    },
    nativeCliHosting: hosting(),
    // The observation pair is armed, but this host never opened host state.
    createSessionSetup: () => ({ nativeSetup: false, nativeAgentDir: agentDir, profileRegistry: profileRegistry() }),
  };
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: home } }, dependencies);
  try {
    const manager: FakeManager = await ready(harness);
    assert.equal(manager.options.nativeHookRegistrar, created, "the observation pair is still armed as before");
    assert.ok(!("nativeReviewLane" in manager.options), "a host without owned state arms no automatic review");
  } finally {
    await nextTurn();
    await closeHarness(harness, created);
  }
});
