import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  __test as instanceTestSeam,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type PtyFactory,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { ProfileRegistry } from "../src/session-host/profiles";
import type { StatusShutdownResult } from "../src/session-host/broker";

/**
 * SYNTHETIC single-row stop safety regressions for InstanceManager.stop(id, {confirmed}).
 *
 * Evidence scope (source-only, synthetic): every case drives the real
 * InstanceManager with FAKE public PTYs (no real process, no @lydell/node-pty
 * native addon) and a FAKE status registrar (no broker, no wire, no auth).
 * This file is NOT native acceptance: it does not prove real Pi runtime,
 * preload/gate behavior, broker/protocol integration, or native Main
 * compatibility; the parent owns those integrated checks.
 *
 * Fixture policy (fail closed):
 * - The original process environment is preserved verbatim (shallow copy, no
 *   keys removed). If an executor role/catalog marker is present in the
 *   original environment under any casing, fixture setup refuses to run
 *   instead of stripping it.
 * - All inert fixtures are exclusively created under the parent-provided
 *   temporary directory (os.tmpdir()) and are RETAINED after the tests: no
 *   rm/rmdir/recursive teardown is attempted because per-entry descendant
 *   ownership is not proved.
 * - The inert pi entry fixture carries a positive Node-entry shebang and an
 *   execute bit only because prepareNativeLaunch validates X_OK; it is never
 *   invoked (the fake PTY factory spawns no process).
 * - No Git, npm, subprocess, SDK, credentials, provider, or home access:
 *   legacy profile mode keeps every read inside the owned fixtures.
 */

/** Executor role/catalog markers are rejected fail-closed, never stripped. */
const ROLE_CATALOG_MARKERS = [
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
] as const;

/** Original env preserved verbatim; any role/catalog marker (any casing) refuses the run. */
function preservedOriginalEnv(): NodeJS.ProcessEnv {
  for (const key of Object.keys(process.env)) {
    if ((ROLE_CATALOG_MARKERS as readonly string[]).includes(key.toUpperCase())) {
      throw new Error(
        `synthetic row-stop fixture refuses to run: ${key} is present in the original environment; role/catalog markers are rejected, never stripped`,
      );
    }
  }
  return { ...process.env };
}

/** Complete observed inactivity: the only state that authorizes an idle-only stop.
 *  The stop gate reads the conservative ownership pair; the activity-intent pair
 *  is carried alongside and must not weaken it. */
const COMPLETE_IDLE: InstanceStatusUpdate = {
  busy: false,
  pendingInput: false,
  inputSurface: false,
  activity: [],
  backgroundTasks: 0,
  backgroundShells: 0,
  activeTasks: 0,
  activeShells: 0,
};

/**
 * Fake public PTY: no real process, no native addon. It records every write
 * and kill and emits exit through the same listener surface the manager
 * subscribes to, so owned-handle truth stays with the exact instance.
 */
class FakeStopPty implements InstancePty {
  static #nextPid = 910_000;

  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  readonly killSignals: string[] = [];
  pauseCount = 0;
  resumeCount = 0;
  exited = false;
  /** Which signal (if any) makes this otherwise well-behaved fake child exit. */
  exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "none";
  /** Runs before the built-in exit-on-signal behavior; may throw like a native kill. */
  killHook?: (signal: string) => void;

  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  readonly #errorListeners: ((error: Error) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = FakeStopPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.#dataListeners.indexOf(listener);
        if (index >= 0) this.#dataListeners.splice(index, 1);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return {
      dispose: () => {
        const index = this.#exitListeners.indexOf(listener);
        if (index >= 0) this.#exitListeners.splice(index, 1);
      },
    };
  }

  on(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    this.#errorListeners.push(listener);
  }

  removeListener(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    const index = this.#errorListeners.indexOf(listener);
    if (index >= 0) this.#errorListeners.splice(index, 1);
  }

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rows = rows;
  }

  kill(signal?: string): void {
    const name = signal ?? "SIGHUP";
    this.killSignals.push(name);
    this.killHook?.(name);
    if (!this.exited && this.exitsOnSignal === name) {
      this.emitExit(0, name === "SIGKILL" ? 9 : 15);
    }
  }

  pause(): void {
    this.pauseCount += 1;
  }

  resume(): void {
    this.resumeCount += 1;
  }

  /** Test-side emitter delivered synchronously, like the manager's guards expect. */
  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

interface FakeStopEntry {
  instanceId: string;
  handlers: InstanceStatusHandlers;
  released: boolean;
  shutdownCalls: ({ readonly requireIdle?: boolean } | undefined)[];
  bootstrap: InstanceStatusRegistration["bootstrap"];
}

/**
 * Fake status registrar: records every authenticated public shutdown call per
 * row and lets each test decide the response. No broker, no wire, no auth.
 */
class FakeStopRegistrar implements StatusRegistrar {
  readonly entries = new Map<string, FakeStopEntry>();
  shutdownHandler?: (
    entry: FakeStopEntry,
    options: { readonly requireIdle?: boolean } | undefined,
  ) => StatusShutdownResult;

  register(instanceId: string, handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    const entry: FakeStopEntry = {
      instanceId,
      handlers,
      released: false,
      shutdownCalls: [],
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: `tok-${randomUUID()}`,
        instanceId,
        generation: randomUUID(),
      },
    };
    this.entries.set(instanceId, entry);
    return {
      bootstrap: entry.bootstrap,
      shutdown: (options) => {
        entry.shutdownCalls.push(options);
        const result = this.shutdownHandler
          ? this.shutdownHandler(entry, options)
          : { requestId: randomUUID(), status: "unavailable" as const };
        return Promise.resolve(result);
      },
      release: () => {
        entry.released = true;
      },
    };
  }

  emitStatus(instanceId: string, update: InstanceStatusUpdate): void {
    const entry = this.entries.get(instanceId);
    assert.ok(entry && !entry.released, "status requires a live registration");
    entry.handlers.onStatus(update);
  }
}

interface StopManager {
  manager: InstanceManager;
  registrar: FakeStopRegistrar;
  spawned: FakeStopPty[];
}

interface StopHarness {
  root: string;
  workspaceA: string;
  workspaceB: string;
  makeManager: (options?: { failSpawns?: boolean }) => StopManager;
}

/** Inert package fixture satisfying prepareNativeLaunch's descriptor checks. */
function makeInertPackageFixture(root: string): { packageRoot: string; piExecutable: string } {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic inert fixture; never imported or executed.\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic inert fixture; never imported or executed.\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert fixture; never imported or executed.\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  for (const [skill, files] of [
    ["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
    ["pi-review-gate-execution", ["SKILL.md"]],
    ["pi-review-gate-research", ["SKILL.md"]],
  ] as const) {
    for (const file of files) {
      const path = join(packageRoot, "skills", skill, ...file.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `synthetic inert fixture ${skill}/${file}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  }
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const piExecutable = join(binDir, "inert-pi-entry");
  writeFileSync(
    piExecutable,
    "#!/usr/bin/env node\n// Synthetic inert Node entry fixture; validated for X_OK and shebang only, never invoked.\n",
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  chmodSync(piExecutable, 0o755);
  return { packageRoot, piExecutable };
}

/**
 * One exclusively-created fixture root under the parent-provided temp. The
 * root and everything under it (including registry-generated profiles) are
 * RETAINED after the tests; no teardown is attempted.
 */
function makeStopHarness(label: string): StopHarness {
  const env = preservedOriginalEnv();
  const root = mkdtempSync(join(tmpdir(), `prg-row-stop-${label}-`));
  const { packageRoot, piExecutable } = makeInertPackageFixture(root);
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });

  const makeManager = (options: { failSpawns?: boolean } = {}): StopManager => {
    const registrar = new FakeStopRegistrar();
    const spawned: FakeStopPty[] = [];
    const ptyFactory: PtyFactory = (descriptor) => {
      if (options.failSpawns) throw new Error("synthetic spawn failure before any child exists");
      const pty = new FakeStopPty(descriptor);
      spawned.push(pty);
      return pty;
    };
    const manager = new InstanceManager({
      packageRoot,
      piExecutable,
      statusRegistrar: registrar,
      nativeSetup: false,
      profileRegistry: new ProfileRegistry({ stateRoot }),
      args: [],
      env,
      ptyFactory,
    });
    return { manager, registrar, spawned };
  };

  return { root, workspaceA, workspaceB, makeManager };
}

function viewFor(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, `row ${id} must exist`);
  return view;
}

test("unconfirmed stop of fresh or non-idle rows requires confirmation and sends no shutdown, TERM, or force", async () => {
  const harness = makeStopHarness("non-idle");
  const { manager, registrar, spawned } = harness.makeManager();

  const idFresh = await manager.create({ label: "fresh", workspace: harness.workspaceA });
  assert.deepEqual(
    await manager.stop(idFresh, { confirmed: false }),
    { status: "confirmation-required", forced: false },
    "a fresh row with unknown state requires confirmation",
  );

  const nonIdleCases: Array<[string, InstanceStatusUpdate]> = [
    ["busy", { ...COMPLETE_IDLE, busy: true }],
    ["pending-input", { ...COMPLETE_IDLE, pendingInput: true }],
    ["input-surface", { ...COMPLETE_IDLE, inputSurface: true }],
    // Zero ACTIVITY but a retained ownership obligation still requires
    // confirmation: the stop gate never reads the displayed intent counts.
    ["retained-tasks", { ...COMPLETE_IDLE, backgroundTasks: 1 }],
    ["retained-shells", { ...COMPLETE_IDLE, backgroundShells: 1 }],
    ["unknown-tasks", { ...COMPLETE_IDLE, backgroundTasks: null }],
    ["unknown-shells", { ...COMPLETE_IDLE, backgroundShells: null }],
  ];
  for (const [label, update] of nonIdleCases) {
    const id = await manager.create({ label, workspace: harness.workspaceA });
    registrar.emitStatus(id, update);
    assert.deepEqual(
      await manager.stop(id, { confirmed: false }),
      { status: "confirmation-required", forced: false },
      `${label} requires confirmation`,
    );
  }

  for (const entry of registrar.entries.values()) {
    assert.equal(entry.shutdownCalls.length, 0, "no public shutdown is sent for a non-idle row");
  }
  for (const pty of spawned) {
    assert.deepEqual(pty.killSignals, [], "no TERM or force reaches an unconfirmed row");
    assert.equal(pty.exited, false);
  }
  for (const view of manager.list()) {
    assert.equal(view.lifecycle, "alive");
    assert.equal(view.hasLiveProcess, true);
  }
});

test("complete idle with an owned live handle sends the authenticated requireIdle shutdown and settles on the actual fake exit without force", async () => {
  const harness = makeStopHarness("idle-require");
  const { manager, registrar, spawned } = harness.makeManager();
  const id = await manager.create({ label: "idle", workspace: harness.workspaceA });
  registrar.emitStatus(id, COMPLETE_IDLE);
  const pty = spawned[0];
  assert.ok(pty);

  registrar.shutdownHandler = (entry, options) => {
    assert.equal(entry.instanceId, id);
    assert.deepEqual(options, { requireIdle: true }, "the unconfirmed idle stop sends the authenticated idle-only public shutdown");
    // Deterministic fake completion: the exact owned PTY exits through its real onExit callback.
    pty.emitExit(0);
    return { requestId: "req-idle-1", status: "requested" };
  };

  assert.deepEqual(await manager.stop(id, { confirmed: false }), { status: "exited", forced: false });
  const entry = registrar.entries.get(id);
  assert.ok(entry);
  assert.equal(entry.shutdownCalls.length, 1);
  assert.deepEqual(pty.killSignals, [], "an accepted idle-only request that exits never falls back to TERM or force");
  assert.equal(viewFor(manager, id).lifecycle, "exited");
  assert.equal(viewFor(manager, id).hasLiveProcess, false);
});

test("a not-idle rejection never enters the stop ladder; a later confirmed stop sends one fresh public shutdown and settles on the actual exit", async () => {
  const harness = makeStopHarness("not-idle-then-confirm");
  const { manager, registrar, spawned } = harness.makeManager();
  const id = await manager.create({ label: "gated", workspace: harness.workspaceA });
  registrar.emitStatus(id, COMPLETE_IDLE);
  const pty = spawned[0];
  assert.ok(pty);

  let calls = 0;
  registrar.shutdownHandler = (entry) => {
    calls += 1;
    if (calls === 1) {
      return { requestId: "req-not-idle", status: "not-idle" };
    }
    // The confirmed ladder's own request: accepted, and the exact owned PTY
    // exits through its onExit callback.
    pty.emitExit(0);
    return { requestId: "req-confirmed", status: "requested" };
  };

  assert.deepEqual(await manager.stop(id, { confirmed: false }), { status: "confirmation-required", forced: false });
  assert.equal(calls, 1);
  const entry = registrar.entries.get(id);
  assert.ok(entry);
  assert.deepEqual(entry.shutdownCalls[0], { requireIdle: true });
  assert.deepEqual(pty.killSignals, [], "a not-idle rejection never enters the signal ladder");
  assert.equal(viewFor(manager, id).lifecycle, "alive");
  assert.equal(viewFor(manager, id).hasLiveProcess, true);

  assert.deepEqual(await manager.stop(id, { confirmed: true }), { status: "exited", forced: false });
  assert.equal(calls, 2, "the confirmed stop sends exactly one fresh public shutdown for the row");
  assert.equal(entry.shutdownCalls[1], undefined, "the confirmed ladder request carries no requireIdle preflight option");
  assert.deepEqual(pty.killSignals, []);
  assert.equal(viewFor(manager, id).lifecycle, "exited");
});

test("a requested acknowledgement alone is not exit or row removal; the row stays until the exact owned PTY onExit", async () => {
  const harness = makeStopHarness("ack-not-exit");
  const { manager, registrar, spawned } = harness.makeManager();
  const id = await manager.create({ label: "acked", workspace: harness.workspaceA });
  registrar.emitStatus(id, COMPLETE_IDLE);
  const pty = spawned[0];
  assert.ok(pty);

  registrar.shutdownHandler = () => ({ requestId: "req-ack", status: "requested" });

  const stopPromise = manager.stop(id, { confirmed: false });
  // The acknowledgement was delivered synchronously; let the manager process
  // it through one deterministic event turn before asserting on row truth.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const entry = registrar.entries.get(id);
  assert.ok(entry);
  assert.equal(entry.shutdownCalls.length, 1, "processing the acknowledgement does not resend a public shutdown");
  assert.equal(viewFor(manager, id).lifecycle, "alive", "a processed acknowledgement does not change the owned process truth");
  assert.equal(viewFor(manager, id).hasLiveProcess, true);
  assert.equal(manager.closeExited(id), false, "the acknowledgement alone never removes the row");

  // Deterministic settle: the exact owned PTY's actual exit callback.
  pty.emitExit(0);
  assert.deepEqual(await stopPromise, { status: "exited", forced: false });
  assert.equal(viewFor(manager, id).lifecycle, "exited");
  assert.equal(manager.closeExited(id), true, "only the actual owned exit makes the row removable");
  assert.equal(manager.list().some((row) => row.id === id), false);
});

test("closeExited on a still-live owned row returns false and leaves the row intact", async () => {
  const harness = makeStopHarness("live-close");
  const { manager } = harness.makeManager();
  const id = await manager.create({ label: "live", workspace: harness.workspaceA });
  assert.equal(manager.closeExited(id), false);
  assert.equal(viewFor(manager, id).lifecycle, "alive");
  assert.equal(viewFor(manager, id).hasLiveProcess, true);
});

test("stop is truthfully unavailable for unknown ids, starting rows, and unspawned error rows without cancelling pending creates", async () => {
  const harness = makeStopHarness("unavailable");
  const { manager } = harness.makeManager();

  assert.deepEqual(await manager.stop("no-such-instance", { confirmed: true }), { status: "unavailable", forced: false });

  // Starting row: ownership is posted but no owned PTY exists yet.
  const pendingCreate = manager.create({ label: "starting-row", workspace: harness.workspaceA });
  const starting = manager.list().find((row) => row.label === "starting-row");
  assert.ok(starting, "the starting row is posted before any await");
  assert.equal(starting.lifecycle, "starting");
  assert.deepEqual(
    await manager.stop(starting.id, { confirmed: true }),
    { status: "unavailable", forced: false },
    "no fake stop for a row without an owned PTY",
  );
  const startedId = await pendingCreate;
  assert.equal(startedId, starting.id, "the pending create is not cancelled by an unavailable stop");
  assert.equal(viewFor(manager, startedId).lifecycle, "alive");

  // Unspawned error row: the factory failed before any child existed.
  const failing = harness.makeManager({ failSpawns: true });
  const errorId = await failing.manager.create({ label: "unspawned", workspace: harness.workspaceB });
  assert.equal(viewFor(failing.manager, errorId).lifecycle, "error");
  assert.equal(viewFor(failing.manager, errorId).hasLiveProcess, false);
  assert.deepEqual(await failing.manager.stop(errorId, { confirmed: true }), { status: "unavailable", forced: false });
  const failedEntry = failing.registrar.entries.get(errorId);
  assert.ok(failedEntry);
  assert.equal(failedEntry.shutdownCalls.length, 0);
  assert.equal(failedEntry.released, true, "the registration is released when no child ever existed");
});

test("stopping one of two owned rows never touches the sibling and leaves the manager usable", async () => {
  const harness = makeStopHarness("sibling");
  const { manager, registrar, spawned } = harness.makeManager();
  const idA = await manager.create({ label: "stop-me", workspace: harness.workspaceA });
  const idB = await manager.create({ label: "keep-running", workspace: harness.workspaceB });
  registrar.emitStatus(idA, COMPLETE_IDLE);
  registrar.emitStatus(idB, COMPLETE_IDLE);
  const ptyA = spawned[0];
  const ptyB = spawned[1];
  assert.ok(ptyA && ptyB);

  registrar.shutdownHandler = (entry) => {
    assert.equal(entry.instanceId, idA, "only the selected row's registration receives the public shutdown");
    ptyA.emitExit(0);
    return { requestId: "req-sibling", status: "requested" };
  };

  assert.deepEqual(await manager.stop(idA, { confirmed: false }), { status: "exited", forced: false });

  // Sibling isolation: no shutdown, write, or signal ever reached row B.
  const entryB = registrar.entries.get(idB);
  assert.ok(entryB);
  assert.equal(entryB.shutdownCalls.length, 0);
  assert.deepEqual(ptyB.writes, []);
  assert.deepEqual(ptyB.killSignals, []);
  assert.equal(viewFor(manager, idB).lifecycle, "alive");
  assert.equal(viewFor(manager, idB).hasLiveProcess, true);

  // Removal is actual-exit-only and selected-row-only.
  assert.equal(manager.closeExited(idA), true);
  assert.equal(manager.closeExited(idB), false);

  // No manager-wide stop: creation still works afterward.
  const idC = await manager.create({ label: "after-stop", workspace: harness.workspaceA });
  assert.equal(viewFor(manager, idC).lifecycle, "alive");
});

test("duplicate concurrent stops share the per-row ladder without resending the public shutdown or force", async () => {
  // Explicitly POSIX synthetic case: the SIGTERM fallback is a POSIX policy.
  instanceTestSeam.setShutdownPlatform("linux");
  try {
    const harness = makeStopHarness("duplicate");
    const { manager, registrar, spawned } = harness.makeManager();
    const id = await manager.create({ label: "duplicated", workspace: harness.workspaceA });
    const pty = spawned[0];
    assert.ok(pty);
    pty.exitsOnSignal = "SIGTERM";
    registrar.shutdownHandler = () => ({ requestId: "req-dup", status: "rejected" });

    const [first, second] = await Promise.all([
      manager.stop(id, { confirmed: true }),
      manager.stop(id, { confirmed: true }),
    ]);
    assert.deepEqual(first, { status: "exited", forced: false });
    assert.deepEqual(second, { status: "exited", forced: false });
    const entry = registrar.entries.get(id);
    assert.ok(entry);
    assert.equal(entry.shutdownCalls.length, 1, "the shared per-row ladder sends the public shutdown exactly once");
    assert.deepEqual(pty.killSignals, ["SIGTERM"], "one bounded owned-handle signal; no duplicate or escalated force");
    assert.equal(viewFor(manager, id).lifecycle, "exited");
  } finally {
    instanceTestSeam.setShutdownPlatform(undefined);
  }
});

test("sticky force: a throwing SIGKILL records the force on the exact owned handle and leaves the row unconfirmed", async () => {
  // Bounded real-time case: stop() uses the fixed 8s grace + 2s kill windows
  // (no injection seam), and this contract requires the row to never confirm
  // exit, so no deterministic fake completion can settle it faster.
  // Explicitly POSIX synthetic case: SIGTERM/SIGKILL escalation is a POSIX policy.
  instanceTestSeam.setShutdownPlatform("linux");
  try {
    const harness = makeStopHarness("sticky-force");
    const { manager, registrar, spawned } = harness.makeManager();
    const id = await manager.create({ label: "stubborn", workspace: harness.workspaceA });
    const pty = spawned[0];
    assert.ok(pty);
    registrar.shutdownHandler = () => ({ requestId: "req-stubborn", status: "rejected" });
    pty.killHook = (signal) => {
      if (signal === "SIGKILL") throw new Error("synthetic forced kill failure");
    };

    assert.deepEqual(
      await manager.stop(id, { confirmed: true }),
      { status: "unconfirmed", forced: true },
      "the force is sticky before the throwing kill; the row never confirms exit",
    );
    assert.deepEqual(pty.killSignals, ["SIGTERM", "SIGKILL"], "escalation stays on the exact owned handle");
    assert.equal(viewFor(manager, id).lifecycle, "alive");
    assert.equal(viewFor(manager, id).hasLiveProcess, true);
    assert.equal(manager.closeExited(id), false);

    // A duplicate operation after the forced ladder reuses the settled per-row
    // promise: no new public shutdown, no resent force, no extra window wait.
    const entry = registrar.entries.get(id);
    assert.ok(entry);
    assert.deepEqual(
      await manager.stop(id, { confirmed: true }),
      { status: "unconfirmed", forced: true },
      "a later stop reuses the settled per-row ladder",
    );
    assert.equal(entry.shutdownCalls.length, 1, "no resent public shutdown after the forced ladder");
    assert.deepEqual(pty.killSignals, ["SIGTERM", "SIGKILL"], "no resent force on the owned handle");
  } finally {
    instanceTestSeam.setShutdownPlatform(undefined);
  }
});

test("new rows and new managers own independent stop ladders", async () => {
  const harness = makeStopHarness("ownership");
  const first = harness.makeManager();
  const second = harness.makeManager();
  const idA = await first.manager.create({ label: "owner-a", workspace: harness.workspaceA });
  const idB = await second.manager.create({ label: "owner-b", workspace: harness.workspaceB });
  first.registrar.emitStatus(idA, COMPLETE_IDLE);
  const ptyA = first.spawned[0];
  assert.ok(ptyA);

  first.registrar.shutdownHandler = () => {
    ptyA.emitExit(0);
    return { requestId: "req-owner", status: "requested" };
  };
  assert.deepEqual(await first.manager.stop(idA, { confirmed: false }), { status: "exited", forced: false });

  // The other manager's row is untouched by a different owner's stop.
  const entryB = second.registrar.entries.get(idB);
  assert.ok(entryB);
  assert.equal(entryB.shutdownCalls.length, 0);
  assert.deepEqual(second.spawned[0].killSignals, []);
  assert.equal(viewFor(second.manager, idB).lifecycle, "alive");

  // A new row in the first manager gets its own fresh ladder.
  const idC = await first.manager.create({ label: "owner-c", workspace: harness.workspaceA });
  first.registrar.emitStatus(idC, COMPLETE_IDLE);
  const ptyC = first.spawned[1];
  assert.ok(ptyC);
  let calls = 0;
  first.registrar.shutdownHandler = () => {
    calls += 1;
    ptyC.emitExit(0);
    return { requestId: "req-owner-c", status: "requested" };
  };
  assert.deepEqual(await first.manager.stop(idC, { confirmed: false }), { status: "exited", forced: false });
  assert.equal(calls, 1);
});
