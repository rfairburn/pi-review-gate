/**
 * Main-level wiring for the owned Codex status route (issue #277 owned status slice).
 *
 * These prove the HOST's choices, not the pipeline: the host that offers native
 * provider sessions hands its manager the composite owned-backend factory (the
 * production owned launcher fronted by the private TUI relay) and the native
 * observer module's owned-aware factory, while a host with no native hosting keeps
 * the exact manager options it had before. The library default factory — what every
 * other consumer of this module gets — stays the legacy hook route.
 *
 * The synthetic Main harness supplies the terminal, writer, and manager double; the
 * broker in the arming test is the REAL local status broker on a REAL bound socket.
 * No provider CLI, provider configuration, model, child, or live installation is
 * involved.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  NativeStatusObserver,
  NativeStatusObserverFactory,
} from "../src/session-host/instances";
import { createStatusBroker, type NativeHookStatusBroker } from "../src/session-host/broker";
import {
  createNativeStatusObserver,
  createNativeStatusObserverFactory,
} from "../src/session-host/native-observer-factory";
import type { NativeStatusObservation, NativeStatusSupportMap } from "../src/session-host/native-status";
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
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
];

const LEGACY_CODEX_SUPPORT: NativeStatusSupportMap = Object.freeze({
  agent: "supported",
  input: "unsupported",
  tasks: "unsupported",
  shells: "unsupported",
  activity: "supported",
});

const RPC_ALL_SUPPORT: NativeStatusSupportMap = Object.freeze({
  agent: "supported",
  input: "supported",
  tasks: "supported",
  shells: "supported",
  activity: "supported",
});

const ownedRoots = new Set<string>();

function makeSocketRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-owned-main-")));
  ownedRoots.add(root);
  return root;
}

function hostingWithLauncher() {
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

async function closeHarness(harness: Harness, broker?: NativeHookStatusBroker): Promise<void> {
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

/** Build one observer from a factory and record what it publishes. */
async function build(
  factory: NativeStatusObserverFactory,
  backend: "claude" | "codex",
): Promise<{ readonly observer: NativeStatusObserver; readonly observations: NativeStatusObservation[] }> {
  const observations: NativeStatusObservation[] = [];
  const observer = await factory({
    rowId: "row-main-owned",
    backend,
    emit: (observation) => {
      observations.push(observation);
      return { accepted: true } as const;
    },
  });
  return { observer, observations };
}

test("a hosting host wires the owned Codex backend factory alongside its launcher and broker", async () => {
  const socketRoot = makeSocketRoot();
  let created: NativeHookStatusBroker | undefined;
  const dependencies: MainTestDependencies = {
    createBroker: async () => {
      created = await createStatusBroker({ socketRoot });
      return created;
    },
    nativeCliHosting: hostingWithLauncher(),
  };
  const harness = createHarness({}, dependencies);
  try {
    const manager: FakeManager = await ready(harness);
    assert.ok(created, "the host created its broker");

    assert.equal(typeof manager.options.nativeCliLaunch, "function");
    assert.equal(manager.options.nativeHookRegistrar, created,
      "the observation path still uses this host's ONE existing broker");
    assert.equal(typeof manager.options.ownedCodexBackendFactory, "function",
      "the host that offers owned Codex launches provides the factory that honors an owned plan");
    assert.equal(typeof manager.options.nativeStatusObserverFactory, "function",
      "the host hands over the native observer module's factory, not a Main-local adapter");

    // The factory the host handed over is the owned-aware one: Claude is never
    // wrapped, and a Codex run keeps the legacy declaration until its own cap.
    const factory = manager.options.nativeStatusObserverFactory!;
    const claude = await build(factory, "claude");
    assert.equal(claude.observer.observeOwnedCodexBackend, undefined,
      "a Claude row is never given the owned Codex seam");
    assert.deepEqual(claude.observer.support, {
      agent: "supported", input: "supported", tasks: "supported", shells: "supported", activity: "supported",
    });

    const codex = await build(factory, "codex");
    assert.equal(typeof codex.observer.observeOwnedCodexBackend, "function");
    assert.deepEqual(codex.observer.support, LEGACY_CODEX_SUPPORT,
      "before a capability the run is exactly the legacy Codex source");

    // A capability with an endpoint this host cannot describe withdraws the
    // observation under the RPC declaration: no dial, no throw, no fake value.
    codex.observer.observeOwnedCodexBackend!({
      leaseId: "lease-main-owned",
      generation: 0,
      endpoint: "ws://not-an-owned-endpoint",
      readObserverBearer: () => "never-used",
    });
    assert.deepEqual(codex.observer.support, RPC_ALL_SUPPORT,
      "an owned run declares all five categories, with none left not-applicable");
    assert.equal(codex.observations.length, 1);
    assert.deepEqual(codex.observations[0]!.support, RPC_ALL_SUPPORT);
    assert.equal(codex.observations[0]!.busy, null);
    assert.equal(codex.observations[0]!.activeTasks, null);
    assert.deepEqual(codex.observations[0]!.activity, []);
    codex.observer.dispose();

    // The ordinary Pi path is untouched by any of this.
    harness.terminal.emitInput("\r");
    harness.terminal.emitInput("\x15");
    harness.terminal.emitInput("/plain/pi/workspace");
    harness.terminal.emitInput("\r");
    await nextTurn();
    assert.deepEqual(manager.createOptions.at(-1), { workspace: "/plain/pi/workspace" });
  } finally {
    await closeHarness(harness, created);
  }
});

test("a host with no native hosting wires no owned backend factory at all", async () => {
  const harness = createHarness();
  try {
    const manager: FakeManager = await ready(harness);
    assert.equal(manager.options.nativeCliLaunch, undefined);
    assert.ok(!("ownedCodexBackendFactory" in manager.options),
      "no hosting means no owned backend factory, ever");
    assert.ok(!("nativeStatusObserverFactory" in manager.options),
      "no hosting means no observer construction, ever");
  } finally {
    await closeHarness(harness);
  }
});

test("the library default factory stays the exact legacy route for every backend", async () => {
  const factory = createNativeStatusObserverFactory();
  const codex = await build(factory, "codex");
  try {
    assert.equal(codex.observer.observeOwnedCodexBackend, undefined,
      "an opted-out host's Codex observer has no owned seam to be handed one");
    assert.deepEqual(codex.observer.support, LEGACY_CODEX_SUPPORT);
    // The legacy factory itself is unchanged and still usable directly.
    const legacy = await build(createNativeStatusObserver, "codex");
    assert.deepEqual(legacy.observer.support, LEGACY_CODEX_SUPPORT);
    assert.equal(legacy.observer.observeOwnedCodexBackend, undefined);
    legacy.observer.dispose();
  } finally {
    codex.observer.dispose();
  }

  const claudeOnly = createNativeStatusObserverFactory({ ownedCodexBackend: true });
  const claude = await build(claudeOnly, "claude");
  try {
    assert.equal(claude.observer.observeOwnedCodexBackend, undefined,
      "the owned Codex route never reaches a Claude row");
  } finally {
    claude.observer.dispose();
  }

  assert.throws(() => createNativeStatusObserverFactory({ ownedCodexBackend: "yes" as unknown as boolean }),
    TypeError, "the host opt-in is a boolean or absent");
});
