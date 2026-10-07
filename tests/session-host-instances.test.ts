import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync as readBytesSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_KILL_MS,
  InstanceManager,
  MAX_ACTIVITY_ENTRIES,
  MAX_ACTIVITY_ENTRY_CHARS,
  MAX_INSTANCE_ERROR_CHARS,
  MAX_LABEL_CHARS,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type PtyFactory,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { ProfileRegistry } from "../src/session-host/profiles";
import { SESSION_HOST_BOOTSTRAP_ENV, prepareNativeLaunch } from "../src/session-host/launch";
import { TerminalSurface } from "../src/session-host/terminal-surface";

/**
 * Focused component tests for the independent owned-PTY instance lifecycle.
 *
 * IMPORTANT EVIDENCE SCOPE: all manager cases use a FAKE status registrar;
 * everything except the final native-addon case also uses FAKE PTYs. These
 * prove manager ownership/lifecycle semantics, while the final case exercises
 * the pinned PTY binding with an owned Node shim. Neither proves real Pi 1.0.4,
 * actual preload/gate behavior, broker/protocol integration, or native Main
 * compatibility; the parent owns those integrated checks. Broker/protocol
 * components have landed, but this file does not exercise them.
 */

function makeTestRoot(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `prg-instances-${label}-`)));
}

const SHUTDOWN_ENV_KEYS = [
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
] as const;

function cleanTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SHUTDOWN_ENV_KEYS) delete env[key];
  return env;
}

interface PackageFixture {
  root: string;
  packageRoot: string;
  piExecutable: string;
}

/** Synthetic package root with inert fixtures satisfying prepareNativeLaunch's descriptor checks. */
function makePackageFixture(root: string): PackageFixture {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture; not the production preload.\n", "utf8");
  for (const [skill, files] of [
    ["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
    ["pi-review-gate-execution", ["SKILL.md"]],
    ["pi-review-gate-research", ["SKILL.md"]],
  ] as const) {
    for (const file of files) {
      const path = join(packageRoot, "skills", skill, ...file.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${skill}/${file}\n`, "utf8");
    }
  }
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture for descriptor-only manager tests.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  return { root, packageRoot, piExecutable };
}

class FakePty implements InstancePty {
  static #nextPid = 424242;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  readonly killSignals: string[] = [];
  pauseCount = 0;
  resumeCount = 0;
  paused = false;
  exited = false;
  resizeError?: Error;
  dataSubscriptionError?: Error;
  writeError?: Error;
  pauseError?: Error;
  resumeError?: Error;
  /** Which signal (if any) makes this otherwise well-behaved fake child exit. */
  exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "none";
  killHook?: (signal: string) => void;
  /** Simulate UnixTerminal's close/exit callback firing inside its error listener. */
  exitBeforeReadErrorListenerCountCheck = false;
  exitOnSubscription?: { exitCode: number; signal?: number };
  dataOnSubscription?: string;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  // Match UnixTerminal's built-in socket handler; an unexpected error throws unless
  // the manager installs the second listener through the runtime `on("error")` API.
  readonly #errorListeners: ((error: Error) => void)[] = [(error) => this.#handleNativeReadError(error)];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = FakePty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    if (this.dataSubscriptionError) throw this.dataSubscriptionError;
    this.#dataListeners.push(listener);
    if (this.dataOnSubscription !== undefined) {
      const data = this.dataOnSubscription;
      this.dataOnSubscription = undefined;
      listener(data);
    }
    return {
      dispose: () => {
        const index = this.#dataListeners.indexOf(listener);
        if (index >= 0) this.#dataListeners.splice(index, 1);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListenersPush(listener);
    if (this.exitOnSubscription) {
      const event = this.exitOnSubscription;
      this.exitOnSubscription = undefined;
      this.emitExit(event.exitCode, event.signal);
    }
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

  private exitListenersPush(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.#exitListeners.push(listener);
  }

  write(data: string | Buffer): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    if (this.resizeError) throw this.resizeError;
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
    if (this.pauseError) throw this.pauseError;
    this.paused = true;
  }

  resume(): void {
    this.resumeCount += 1;
    if (this.resumeError) throw this.resumeError;
    this.paused = false;
  }

  /** Test-side event emitters (delivered synchronously like the manager's guards expect). */
  emitData(data: string): void {
    for (const listener of [...this.#dataListeners]) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }

  captureCallbacks(): {
    data: readonly ((data: string) => void)[];
    exit: readonly ((event: { exitCode: number; signal?: number }) => void)[];
  } {
    return {
      data: [...this.#dataListeners],
      exit: [...this.#exitListeners],
    };
  }

  emitReadError(error: Error): void {
    // Like EventEmitter, dispatch from a snapshot. The built-in handler runs
    // first and performs its listener-count check after any synchronous exit.
    for (const listener of [...this.#errorListeners]) listener(error);
  }

  #handleNativeReadError(error: Error): void {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.includes("EAGAIN")) return;
    if (this.exitBeforeReadErrorListenerCountCheck) this.emitExit(17, 15);
    if (typeof code === "string" && (code.includes("EIO") || code.includes("errno 5"))) return;
    if (this.#errorListeners.length < 2) throw error;
  }
}

interface RegistrarEntry {
  instanceId: string;
  handlers: { onStatus(update: InstanceStatusUpdate): void; onDisconnect(): void };
  bootstrap: InstanceStatusRegistration["bootstrap"];
  released: boolean;
}

class FakeRegistrar implements StatusRegistrar {
  readonly entries: RegistrarEntry[] = [];
  readonly order: string[] = ["registrar"];
  nextToken?: string;

  register(instanceId: string, handlers: RegistrarEntry["handlers"]): InstanceStatusRegistration {
    this.order.push(`register ${instanceId}`);
    const entry: RegistrarEntry = {
      instanceId,
      handlers,
      released: false,
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        // Long enough to exercise the manager's token redaction bound.
        token: this.nextToken ?? `tok-${randomUUID()}`,
        instanceId,
        generation: randomUUID(),
      },
    };
    this.nextToken = undefined;
    this.entries.push(entry);
    return {
      bootstrap: entry.bootstrap,
      release: () => {
        entry.released = true;
      },
    };
  }

  /** Deliver a status update the way the (future) broker would. */
  emitStatus(entry: RegistrarEntry, update: InstanceStatusUpdate): void {
    if (!entry.released) entry.handlers.onStatus(update);
  }

  emitDisconnect(entry: RegistrarEntry): void {
    if (!entry.released) entry.handlers.onDisconnect();
  }

  /** Deliver even after the broker side released: the manager must still guard. */
  emitAfterRelease(entry: RegistrarEntry, update: InstanceStatusUpdate): void {
    entry.handlers.onStatus(update);
  }

  entryFor(instanceId: string): RegistrarEntry {
    const entry = this.entries.find((candidate) => candidate.instanceId === instanceId);
    assert.ok(entry, `registrar has no entry for ${instanceId}`);
    return entry;
  }
}

interface Harness {
  root: string;
  packageRoot: string;
  piExecutable: string;
  stateRoot: string;
  profileRegistry: ProfileRegistry;
  workspace: string;
  workspace2: string;
  registrar: FakeRegistrar;
  spawned: FakePty[];
  manager: InstanceManager;
  ptyFactory: PtyFactory;
}

interface HarnessOptions {
  cols?: number;
  rows?: number;
  managerEnv?: NodeJS.ProcessEnv;
  getSupportedKeyboardFlags?: () => number;
  onChange?: (instanceId: string) => void;
}

function makeHarness(label: string, options: HarnessOptions = {}): Harness {
  const root = makeTestRoot(label);
  const pkg = makePackageFixture(root);
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  const workspace = join(root, "workspace-alpha");
  const workspace2 = join(root, "workspace-beta");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(workspace2, { recursive: true });
  const registrar = new FakeRegistrar();
  const spawned: FakePty[] = [];
  const profileRegistry = new ProfileRegistry({ stateRoot });
  const ptyFactory: PtyFactory = (descriptor) => {
    registrar.order.push(`spawn ${descriptor.env[SESSION_HOST_BOOTSTRAP_ENV] === undefined ? "?" : "tokened"}`);
    const pty = new FakePty(descriptor);
    spawned.push(pty);
    return pty;
  };
  const manager = new InstanceManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: registrar,
    profileRegistry,
    args: [],
    env: options.managerEnv ?? cleanTestEnv(),
    cols: options.cols ?? DEFAULT_INSTANCE_COLS,
    rows: options.rows ?? DEFAULT_INSTANCE_ROWS,
    getSupportedKeyboardFlags: options.getSupportedKeyboardFlags ?? (() => 7),
    ptyFactory,
    onChange: options.onChange,
  });
  return {
    root,
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    stateRoot,
    profileRegistry,
    workspace,
    workspace2,
    registrar,
    spawned,
    manager,
    ptyFactory,
  };
}

function cleanup(harness: Harness): void {
  rmSync(harness.root, { recursive: true, force: true });
}

function viewFor(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, "row must exist");
  return view;
}

function stripSgr(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function frameText(surface: TerminalSurface | undefined): string {
  assert.ok(surface, "surface must exist");
  return surface.frame().lines.map(stripSgr).join("\n");
}

async function until(predicate: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(predicate(), `timed out waiting for: ${what}`);
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("create posts a truthful starting-to-alive row with an independently admitted profile, descriptor, registration, and pty", async () => {
  const harness = makeHarness("single");
  try {
    const managerEnv = cleanTestEnv();
    const before = JSON.stringify(managerEnv);

    const changed: string[] = [];
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      args: ["--model", "test-model"],
      env: managerEnv,
      getSupportedKeyboardFlags: () => 7,
      onChange: (id) => changed.push(id),
      ptyFactory: (descriptor) => {
        harness.registrar.order.push(`spawn ${descriptor.cwd}`);
        const pty = new FakePty(descriptor);
        harness.spawned.push(pty);
        return pty;
      },
    });

    const id = await manager.create({ label: "alpha", workspace: harness.workspace });

    // Registration strictly before spawn.
    assert.deepEqual(
      harness.registrar.order,
      ["registrar", `register ${id}`, `spawn ${realpathSync(harness.workspace)}`],
      "registration must lead every spawn",
    );
    assert.equal(changed[0], id, "posting the starting row notifies the frontend hook");

    const view = viewFor(manager, id);
    assert.equal(view.label, "alpha");
    assert.equal(view.lifecycle, "alive", "row reaches alive once the spawn succeeded");
    assert.equal(view.hasLiveProcess, true, "the row reports the owned PTY handle, independent of lifecycle/status");
    assert.equal(Object.isFrozen(view), true, "the complete returned view is immutable");
    assert.throws(() => Object.assign(view, { hasLiveProcess: false }), TypeError);
    assert.equal(viewFor(manager, id).hasLiveProcess, true, "mutating a view copy cannot change manager state");
    assert.equal(view.busy, null, "no reporter ran yet: busy stays null, never a fake Idle");
    assert.equal(view.pendingInput, null);
    assert.equal(view.inputSurface, false);
    assert.deepEqual(view.activity, []);
    assert.equal(view.exitCode, undefined);
    assert.equal(view.agentDir.startsWith(join(harness.stateRoot, "profiles")), true);
    assert.equal(view.agentDir === "", false, "row carries the admitted agent dir");

    // Independent profile admission materialized on disk.
    const agentDir = view.agentDir;
    assert.equal(view.workspace, realpathSync(harness.workspace), "canonical workspace on the row");
    const generated = join(harness.stateRoot, "profiles");
    assert.equal(readDirNames(generated).includes(basename(agentDir)), true, "generated profile exists");
    assert.equal(readFileSync(join(agentDir, "review-gate.json")).includes('"enabled"'), true);

    // The spawn descriptor: explicit cwd/env/argv plus current geometry.
    const pty = harness.spawned[0];
    assert.ok(pty);
    const descriptor = pty.spawnDescriptor;
    assert.equal(descriptor.file, realpathSync(harness.piExecutable));
    assert.equal(descriptor.cwd, realpathSync(harness.workspace));
    assert.deepEqual(descriptor.args.slice(0, 4), [
      "--extension", join(harness.packageRoot, "dist", "src", "session-host", "reporter.js"),
      "--extension", join(harness.packageRoot, "dist", "src", "index.js"),
    ]);
    assert.deepEqual(descriptor.args.slice(4), ["--model", "test-model"]);
    assert.equal(descriptor.env.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, join(agentDir, "review-gate.json"));
    assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "none");
    assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "1");
    assert.equal(descriptor.cols, DEFAULT_INSTANCE_COLS);
    assert.equal(descriptor.rows, DEFAULT_INSTANCE_ROWS);
    assert.equal(pty.cols, DEFAULT_INSTANCE_COLS);
    assert.equal(pty.rows, DEFAULT_INSTANCE_ROWS);
    assert.equal(pty.paused, false);

    // The bootstrap is injected AS JSON only into the fresh spawn-env clone.
    const registration = harness.registrar.entryFor(id);
    assert.equal(registration.released, false);
    assert.equal(registration.bootstrap.instanceId, id);
    assert.equal(registration.bootstrap.version, 1);
    assert.equal(typeof registration.bootstrap.socketPath, "string");
    assert.equal(typeof registration.bootstrap.token, "string");
    assert.equal(typeof registration.bootstrap.generation, "string");
    const injected = descriptor.env[SESSION_HOST_BOOTSTRAP_ENV];
    assert.ok(injected);
    assert.deepEqual(JSON.parse(injected), {
      ...registration.bootstrap,
    });
    // The token lives ONLY in the spawn-env clone, never in the user's env.
    assert.equal(managerEnv[SESSION_HOST_BOOTSTRAP_ENV], undefined);
    assert.deepEqual(JSON.parse(before), managerEnv, "the caller's env object is never mutated");
    assert.equal(SESSION_HOST_BOOTSTRAP_ENV in descriptor.env, true);

    manager.surface(id)?.dispose();
  } finally {
    cleanup(harness);
  }
});

test("constructor snapshots caller arguments and environment for every later sibling launch", async () => {
  const harness = makeHarness("constructor-snapshot");
  try {
    const callerArgs = ["--model", "captured-model"];
    const callerEnv = cleanTestEnv();
    callerEnv.PRG_INSTANCE_SNAPSHOT_TEST = "captured-env";
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      args: callerArgs,
      env: callerEnv,
      ptyFactory: harness.ptyFactory,
    });

    callerArgs[1] = "mutated-after-construction";
    callerArgs.push("--unexpected-late-arg");
    callerEnv.PRG_INSTANCE_SNAPSHOT_TEST = "mutated-after-construction";
    callerEnv.PRG_INSTANCE_ADDED_AFTER_CONSTRUCTION = "not-snapshotted";

    await manager.create({ label: "snapshot-a", workspace: harness.workspace });
    await manager.create({ label: "snapshot-b", workspace: harness.workspace2 });
    for (const pty of harness.spawned) {
      assert.deepEqual(pty.spawnDescriptor.args.slice(-2), ["--model", "captured-model"]);
      assert.equal(pty.spawnDescriptor.env.PRG_INSTANCE_SNAPSHOT_TEST, "captured-env");
      assert.equal(pty.spawnDescriptor.env.PRG_INSTANCE_ADDED_AFTER_CONSTRUCTION, undefined);
      pty.exitsOnSignal = "SIGTERM";
    }
    assert.deepEqual(callerArgs, ["--model", "mutated-after-construction", "--unexpected-late-arg"]);
    assert.equal(callerEnv.PRG_INSTANCE_SNAPSHOT_TEST, "mutated-after-construction", "manager never mutates caller env");
    assert.equal(callerEnv.PRG_INSTANCE_ADDED_AFTER_CONSTRUCTION, "not-snapshotted");
    await manager.shutdown({ graceMs: 30, killMs: 30 });

    const processSnapshotKey = "PRG_INSTANCE_PROCESS_ENV_SNAPSHOT_TEST";
    const savedProcessEnv = new Map(
      [...SHUTDOWN_ENV_KEYS, processSnapshotKey].map((key) => [key, process.env[key]] as const),
    );
    let inheritedManager: InstanceManager | undefined;
    try {
      for (const key of SHUTDOWN_ENV_KEYS) delete process.env[key];
      process.env[processSnapshotKey] = "captured-process-env";
      inheritedManager = new InstanceManager({
        packageRoot: harness.packageRoot,
        piExecutable: harness.piExecutable,
        statusRegistrar: harness.registrar,
        profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
        ptyFactory: harness.ptyFactory,
      });
      process.env[processSnapshotKey] = "mutated-after-construction";
      await inheritedManager.create({ label: "process-snapshot", workspace: harness.workspace });
      assert.equal(harness.spawned[2].spawnDescriptor.env[processSnapshotKey], "captured-process-env");
      harness.spawned[2].exitsOnSignal = "SIGTERM";
      await inheritedManager.shutdown({ graceMs: 30, killMs: 30 });
    } finally {
      await inheritedManager?.dispose();
      for (const [key, value] of savedProcessEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    cleanup(harness);
  }
});

test("resized geometry persists for new and still-pending instances", async () => {
  const harness = makeHarness("geometry-persistence");
  try {
    harness.manager.resize(102, 36);
    const firstId = await harness.manager.create({ label: "first", workspace: harness.workspace });
    assert.deepEqual(
      [harness.spawned[0].spawnDescriptor.cols, harness.spawned[0].spawnDescriptor.rows],
      [102, 36],
      "resize before create affects the first spawn descriptor",
    );
    assert.deepEqual(
      [harness.manager.surface(firstId)!.frame().cols, harness.manager.surface(firstId)!.frame().rows],
      [102, 36],
    );

    const pendingCreate = harness.manager.create({ label: "pending", workspace: harness.workspace2 });
    const pendingRow = harness.manager.list().find((row) => row.label === "pending");
    assert.ok(pendingRow);
    assert.equal(pendingRow.lifecycle, "starting");
    harness.manager.resize(91, 29);
    const pendingId = await pendingCreate;
    const pendingPty = harness.spawned[1];
    assert.deepEqual([pendingPty.spawnDescriptor.cols, pendingPty.spawnDescriptor.rows], [91, 29]);
    assert.deepEqual([pendingPty.cols, pendingPty.rows], [91, 29]);
    assert.deepEqual(
      [harness.manager.surface(pendingId)!.frame().cols, harness.manager.surface(pendingId)!.frame().rows],
      [91, 29],
      "resize during launch preparation reaches the later surface",
    );
    assert.deepEqual([harness.spawned[0].cols, harness.spawned[0].rows], [91, 29]);
  } finally {
    cleanup(harness);
  }
});

test("two instances own independent cwd/env/profiles/frames/queries and input routing", async () => {
  const harness = makeHarness("pair");
  try {
    const idA = await harness.manager.create({ label: "one", workspace: harness.workspace });
    const idB = await harness.manager.create({ label: "two", workspace: harness.workspace2 });
    assert.notEqual(idA, idB);
    const viewA = viewFor(harness.manager, idA);
    const viewB = viewFor(harness.manager, idB);
    assert.notEqual(viewA.agentDir, viewB.agentDir, "independent admitted profile directories");
    assert.notEqual(harness.spawned[0].pid, harness.spawned[1].pid);
    assert.equal(harness.spawned[0].spawnDescriptor.cwd, realpathSync(harness.workspace));
    assert.equal(harness.spawned[1].spawnDescriptor.cwd, realpathSync(harness.workspace2));
    assert.equal(harness.spawned[0].spawnDescriptor.env.PI_CODING_AGENT_DIR, viewA.agentDir);
    assert.equal(harness.spawned[1].spawnDescriptor.env.PI_CODING_AGENT_DIR, viewB.agentDir);
    // Per-instance registration: instanceId matches each row; tokens never shared.
    const regA = harness.registrar.entryFor(idA);
    const regB = harness.registrar.entryFor(idB);
    assert.notEqual(regA.bootstrap.token, regB.bootstrap.token);
    assert.equal(JSON.parse(harness.spawned[0].spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string).token, regA.bootstrap.token);
    assert.equal(JSON.parse(harness.spawned[1].spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string).token, regB.bootstrap.token);

    const ptyA = harness.spawned[0];
    const ptyB = harness.spawned[1];
    ptyA.emitData("frame-from-alpha");
    ptyB.emitData("frame-from-beta");
    await harness.manager.surface(idA)!.flush();
    await harness.manager.surface(idB)!.flush();
    assert.equal(frameText(harness.manager.surface(idA)).includes("frame-from-alpha"), true);
    assert.equal(frameText(harness.manager.surface(idA)).includes("frame-from-beta"), false);
    assert.equal(frameText(harness.manager.surface(idB)).includes("frame-from-beta"), true);
    assert.equal(frameText(harness.manager.surface(idB)).includes("frame-from-alpha"), false);

    // A query parsed by instance A's surface is replied to ONLY on A's PTY.
    ptyA.emitData("\x1b[>7u\x1b[?u"); // negotiate flags, then query
    await harness.manager.surface(idA)!.flush();
    assert.equal(ptyA.writes.some((write) => write === "\x1b[?7u"), true, "query reply routed to its own pty");
    assert.equal(ptyB.writes.length, 0, "no reply ever leaks to a sibling pty");

    // Input routing is explicit-id only.
    harness.manager.write(idB, "input-for-beta");
    assert.deepEqual(ptyB.writes.slice(-1), ["input-for-beta"]);
    assert.equal(ptyA.writes.includes("input-for-beta"), false);
    harness.manager.write(idA, "input-for-alpha");
    assert.deepEqual(ptyA.writes.slice(-1), ["input-for-alpha"]);
    assert.throws(() => harness.manager.write("no-such-id", "x"), /unknown instance id/);

    // X10/legacy mouse packets can contain bytes which are not valid UTF-8.
    // The adapter's Buffer must reach only its selected PTY without a string
    // round-trip (which would re-encode 0x80/0xff as different UTF-8 bytes).
    const rawMousePacket = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0xff]);
    harness.manager.write(idB, rawMousePacket);
    const delivered = ptyB.writes.at(-1);
    assert.strictEqual(delivered, rawMousePacket, "write preserves the original byte Buffer without coercion");
    assert.deepEqual(delivered, Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0xff]));
    assert.equal(ptyA.writes.some((write) => Buffer.isBuffer(write)), false, "raw bytes never forward to a sibling pty");
  } finally {
    cleanup(harness);
  }
});

test("status updates land in a truthful bounded copied view; disconnect never claims an exit or Idle", async () => {
  const harness = makeHarness("status");
  try {
    const id = await harness.manager.create({ label: "watched", workspace: harness.workspace });
    const entry = harness.registrar.entryFor(id);
    const long = "😀".repeat(MAX_ACTIVITY_ENTRY_CHARS + 50);
    const structuralLine = "Ready \u0000now\u007f\u000b\u0085\u009f";
    const activity = ["discard-old-line", structuralLine, long];
    harness.registrar.emitStatus(entry, { busy: true, pendingInput: true, inputSurface: true, activity });
    let view = viewFor(harness.manager, id);
    assert.equal(view.busy, true);
    assert.equal(view.pendingInput, true);
    assert.equal(view.inputSurface, true);
    assert.equal(view.activity.length, MAX_ACTIVITY_ENTRIES, "activity snapshot keeps at most two lines");
    assert.deepEqual(view.activity[0], "Ready now", "C0, DEL, and C1 controls are stripped from structural lines");
    assert.equal(Array.from(view.activity.at(-1)!).length, MAX_ACTIVITY_ENTRY_CHARS, "line cap counts Unicode code points");
    assert.equal(view.activity.at(-1), Array.from(long).slice(0, MAX_ACTIVITY_ENTRY_CHARS).join(""));
    // Copied immutably: mutating the returned array must not affect the row.
    assert.throws(() => (view.activity as string[]).push("tampered"), /extensible|read only/);
    assert.equal(viewFor(harness.manager, id).activity.includes("tampered"), false);

    harness.registrar.emitStatus(entry, { busy: false, pendingInput: false, inputSurface: false, activity: ["Ready"] });
    await sleep(5);
    view = viewFor(harness.manager, id);
    assert.equal(view.busy, false, "a valid idle remains explicit, not unknown");
    assert.deepEqual(view.activity, ["Ready"], "valid idle has no activity TTL");

    harness.registrar.emitDisconnect(entry);
    view = viewFor(harness.manager, id);
    assert.equal(view.busy, null, "disconnect collapses busy to null (truthful, never Idle)");
    assert.equal(view.pendingInput, null);
    assert.equal(view.inputSurface, false);
    assert.equal(view.lifecycle, "alive", "a reporter disconnect is not a process exit");
    assert.deepEqual(view.activity, [], "disconnect clears stale activity instead of showing stale status");
    assert.equal(view.hasLiveProcess, true, "reporter loss does not release the owned PTY");

    // A fresh reporter after a reconnect may report again; a status delivered
    // AFTER the registration was released by a real exit must be ignored.
    const pty = harness.spawned[0];
    pty.emitExit(3);
    await sleep(0);
    view = viewFor(harness.manager, id);
    assert.equal(view.lifecycle, "exited");
    assert.equal(view.hasLiveProcess, false, "confirmed exit clears the live-process truth field");
    assert.deepEqual(view.activity, [], "confirmed exit clears stale activity");
    assert.equal(registrationEntryReleased(harness.registrar, id), true);
    const busyBefore = view.busy;
    harness.registrar.emitAfterRelease(entry, { busy: true, pendingInput: true, inputSurface: true, activity: ["late"] });
    view = viewFor(harness.manager, id);
    assert.equal(view.busy, busyBefore, "late status after release cannot touch the row");
    assert.equal(view.activity.includes("late"), false);
  } finally {
    cleanup(harness);
  }
});

function readFileSync(path: string): string {
  // Local helper: bounded, utf8 read for assertions only.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(path, "utf8") as string;
}

function readDirNames(path: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readdirSync(path) as string[];
}

function registrationEntryReleased(registrar: FakeRegistrar, instanceId: string): boolean {
  return registrar.entryFor(instanceId).released;
}

test("exit freezes the retained frame with a truthful code, drops late events, and releases the admission", async () => {
  const harness = makeHarness("exit");
  try {
    const stateRoot = harness.stateRoot;
    const registry = new ProfileRegistry({ stateRoot });
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    // A supplied profile proves admission release observably (re-admission
    // succeeds only when the row's admission was released).
    const agentDir = join(harness.root, "supplied-profile");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({ enabled: true }), "utf8");
    const id = await manager.create({ label: "exiting", workspace: harness.workspace, profile: agentDir });
    const pty = harness.spawned[0];
    harness.registrar.emitStatus(harness.registrar.entryFor(id), {
      busy: true,
      pendingInput: true,
      inputSurface: true,
      activity: ["working"],
    });

    pty.emitData("EARLY-EXIT-TEXT");
    pty.emitExit(7); // exit while queued bytes are still parsing
    assert.equal(frameText(manager.surface(id)).includes("EARLY-EXIT-TEXT") === false, true, "parse may still be in flight");
    await manager.surface(id)!.flush();
    assert.equal(frameText(manager.surface(id)).includes("EARLY-EXIT-TEXT"), true, "retained last frame completes after flush");

    let view = viewFor(manager, id);
    assert.equal(view.lifecycle, "exited");
    assert.equal(view.hasLiveProcess, false);
    assert.equal(view.exitCode, 7);
    assert.equal(view.busy, null, "exit clears the last reported busy state");
    assert.equal(view.pendingInput, null, "exit clears the last reported pending-input state");
    assert.equal(view.inputSurface, false, "exit clears the last reported input surface");
    assert.deepEqual(view.activity, [], "exit clears stale activity while the final frame remains available");
    assert.equal(registrationEntryReleased(harness.registrar, id), true);
    assert.equal(manager.hasLiveProcesses(), false, "an exited owned handle is not a live process");
    assert.ok(manager.surface(id), "the retained last frame stays readable via the surface");

    // Stale events after exit: dropped, truthful state retained.
    pty.emitData("MUST-NOT-LAND");
    await manager.surface(id)!.flush();
    assert.equal(frameText(manager.surface(id)).includes("MUST-NOT-LAND"), false);
    pty.emitExit(9, 15);
    assert.equal(viewFor(manager, id).exitCode, 7, "a stale second exit cannot rewrite the row");
    harness.registrar.emitAfterRelease(harness.registrar.entryFor(id), { busy: true, pendingInput: true, inputSurface: true, activity: ["late"] });
    assert.equal(viewFor(manager, id).activity.includes("late"), false);

    // Profile admission released on confirmed exit: re-admission succeeds,
    // and the profile's files persist untouched.
    await registry.prepare({ workspace: harness.workspace2, profile: agentDir });
    const profileSnapshot = readDirNames(agentDir).join(",");
    assert.equal(profileSnapshot.includes("review-gate.json"), true, "profile config persists after exit");
    rmSync(join(agentDir, "review-gate.json"), { force: true }); // cleanup of the test-owned file only
  } finally {
    cleanup(harness);
  }
});

test("closeExited removes only one confirmed-exited owner and preserves its storage and live sibling", async () => {
  const rosterChanges: { instanceId: string; ids: string[] }[] = [];
  let observeRoster: (() => string[]) | undefined;
  const harness = makeHarness("close-exited", {
    onChange: (instanceId) => rosterChanges.push({ instanceId, ids: observeRoster?.() ?? [] }),
  });
  observeRoster = () => harness.manager.list().map((row) => row.id);
  try {
    const idA = await harness.manager.create({ label: "close-me", workspace: harness.workspace });
    const idB = await harness.manager.create({ label: "keep-running", workspace: harness.workspace2 });
    const agentDirA = viewFor(harness.manager, idA).agentDir;
    const agentDirB = viewFor(harness.manager, idB).agentDir;
    const surfaceA = harness.manager.surface(idA);
    const surfaceB = harness.manager.surface(idB);
    assert.ok(surfaceA);
    assert.ok(surfaceB);

    const workspaceAFile = join(harness.workspace, "workspace-owned.bin");
    const workspaceBFile = join(harness.workspace2, "workspace-owned.bin");
    writeFileSync(workspaceAFile, Buffer.from([0, 1, 255, 10]));
    writeFileSync(workspaceBFile, Buffer.from([9, 8, 0, 255]));
    for (const [agentDir, prefix] of [[agentDirA, "alpha"], [agentDirB, "beta"]] as const) {
      mkdirSync(join(agentDir, "sessions"), { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ owner: prefix }));
      writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ credentialFixture: `${prefix}-auth` }));
      writeFileSync(join(agentDir, "sessions", "conversation.jsonl"), `${prefix}-session\n`);
    }
    const persistentFiles = [
      workspaceAFile,
      join(agentDirA, "review-gate.json"),
      join(agentDirA, "settings.json"),
      join(agentDirA, "auth.json"),
      join(agentDirA, "sessions", "conversation.jsonl"),
      workspaceBFile,
      join(agentDirB, "review-gate.json"),
      join(agentDirB, "settings.json"),
      join(agentDirB, "auth.json"),
      join(agentDirB, "sessions", "conversation.jsonl"),
    ];
    const persistedBytes = new Map(persistentFiles.map((path) => [path, readBytesSync(path)] as const));

    const ptyA = harness.spawned[0];
    const ptyB = harness.spawned[1];
    const lateCallbacksA = ptyA.captureCallbacks();
    harness.registrar.emitStatus(harness.registrar.entryFor(idB), {
      busy: true,
      pendingInput: true,
      inputSurface: true,
      activity: ["sibling remains active"],
    });
    ptyB.emitData("sibling-frame");
    await surfaceB.flush();
    const siblingView = viewFor(harness.manager, idB);
    const siblingFrame = frameText(surfaceB);
    const siblingWrites = [...ptyB.writes];
    const siblingSignals = [...ptyB.killSignals];
    const changesBeforeExit = rosterChanges.length;

    ptyA.emitData("final-frame-before-close");
    ptyA.emitExit(7);
    await surfaceA.flush();
    await sleep(0);
    assert.equal(viewFor(harness.manager, idA).lifecycle, "exited");
    assert.equal(viewFor(harness.manager, idA).exitCode, 7);
    assert.strictEqual(harness.manager.surface(idA), surfaceA, "the final surface stays retained until explicit close");
    assert.deepEqual(ptyA.killSignals, [], "natural exit and row removal never signal the child");

    const changesBeforeClose = rosterChanges.length;
    assert.equal(harness.manager.closeExited(idA), true);
    assert.equal(rosterChanges.length, changesBeforeClose + 1, "removal emits exactly one synchronous roster change");
    assert.deepEqual(rosterChanges.at(-1), { instanceId: idA, ids: [idB] }, "observers see the row already removed");
    const changesAfterClose = rosterChanges.length;
    assert.equal(harness.manager.closeExited(idA), false, "a repeated close is a harmless unknown-id refusal");
    assert.equal(rosterChanges.length, changesAfterClose, "repeated close emits no duplicate roster change");
    assert.deepEqual(harness.manager.list().map((row) => row.id), [idB]);
    assert.equal(harness.manager.surface(idA), undefined, "the removed row's surface is disposed and released");
    assert.strictEqual(harness.manager.surface(idB), surfaceB, "the sibling surface remains owned");
    assert.equal(harness.manager.hasLiveProcesses(), true, "the sibling stays live after the exited owner is removed");
    assert.deepEqual(viewFor(harness.manager, idB), siblingView, "sibling status and lifecycle remain unchanged");
    assert.equal(frameText(surfaceB), siblingFrame, "sibling frame remains unchanged");
    assert.deepEqual(ptyB.writes, siblingWrites, "closing A does not write to B");
    assert.deepEqual(ptyB.killSignals, siblingSignals, "closing A does not signal B");
    assert.equal(ptyB.exited, false, "B remains live");
    assert.throws(() => harness.profileRegistry.prepare({ workspace: harness.workspace2, profile: agentDirB }), /already has an active admission/);
    const releasedA = harness.profileRegistry.prepare({ workspace: harness.workspace, profile: agentDirA });
    releasedA.release();

    for (const [path, bytes] of persistedBytes) {
      assert.deepEqual(readBytesSync(path), bytes, `persistent file remains byte-identical: ${path}`);
    }

    // Events already queued against A's old handlers, plus a late reporter
    // callback, cannot mutate or reinsert the removed row.
    for (const callback of lateCallbacksA.data) callback("late-frame-must-not-return");
    for (const callback of lateCallbacksA.exit) callback({ exitCode: 99 });
    harness.registrar.emitAfterRelease(harness.registrar.entryFor(idA), {
      busy: true,
      pendingInput: true,
      inputSurface: true,
      activity: ["late status"],
    });
    assert.deepEqual(harness.manager.list().map((row) => row.id), [idB]);
    assert.equal(rosterChanges.length, changesBeforeClose + 1, "late callbacks do not emit misleading roster changes");
    assert.deepEqual(ptyB.writes, siblingWrites, "unknown A input cannot fall through to B");
    assert.throws(() => harness.manager.write(idA, "must-not-be-rerouted"), /unknown instance id/);
    assert.deepEqual(ptyB.writes, siblingWrites);
    harness.manager.write(idB, "explicitly-addressed-b");
    assert.deepEqual(ptyB.writes, [...siblingWrites, "explicitly-addressed-b"]);
    assert.deepEqual(ptyA.killSignals, []);

    // A normal explicit create can reuse A's released profile after close;
    // removal neither owns that storage nor blocks future admissions.
    const nextId = await harness.manager.create({ label: "next-owner", workspace: harness.workspace, profile: agentDirA });
    assert.equal(viewFor(harness.manager, nextId).agentDir, agentDirA);
    harness.spawned[2].emitExit(0);
    assert.equal(harness.manager.closeExited(nextId), true);
    assert.equal(viewFor(harness.manager, idB).hasLiveProcess, true);
    assert.equal(rosterChanges.length > changesBeforeExit, true);
  } finally {
    cleanup(harness);
  }
});

test("closeExited refuses unknown, starting, and live rows without side effects", async () => {
  const changes: string[] = [];
  const harness = makeHarness("close-refusals", { onChange: (id) => changes.push(id) });
  try {
    assert.equal(harness.manager.closeExited("unknown-instance"), false);
    assert.deepEqual(changes, [], "unknown ids do not notify roster observers");

    const createPending = harness.manager.create({ label: "starting", workspace: harness.workspace });
    const starting = harness.manager.list().find((row) => row.label === "starting");
    assert.ok(starting);
    assert.equal(starting.lifecycle, "starting");
    const changesAfterPost = changes.length;
    assert.equal(harness.manager.closeExited(starting.id), false);
    assert.equal(changes.length, changesAfterPost, "starting refusal does not alter the roster");

    const id = await createPending;
    const livePty = harness.spawned[0];
    const liveSurface = harness.manager.surface(id);
    assert.equal(viewFor(harness.manager, id).lifecycle, "alive");
    const changesBeforeLiveRefusal = changes.length;
    assert.equal(harness.manager.closeExited(id), false);
    assert.equal(changes.length, changesBeforeLiveRefusal);
    assert.deepEqual(livePty.killSignals, [], "refusal never signals a live child");
    assert.equal(livePty.exited, false);
    assert.equal(viewFor(harness.manager, id).hasLiveProcess, true);
    assert.strictEqual(harness.manager.surface(id), liveSurface, "live surface is retained");

    livePty.emitExit(0);
    assert.equal(harness.manager.closeExited(id), true, "the same row becomes closable only after observed exit");
  } finally {
    cleanup(harness);
  }
});

test("an exit callback during listener registration cannot revive a starting row or retain its admission", async () => {
  const harness = makeHarness("early-exit");
  try {
    const agentDir = join(harness.root, "early-profile");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({ enabled: true }), "utf8");
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const factory: PtyFactory = (descriptor) => {
      const pty = new FakePty(descriptor);
      pty.exitOnSubscription = { exitCode: 23, signal: 15 };
      harness.spawned.push(pty);
      return pty;
    };
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: factory,
    });

    const id = await manager.create({ label: "early-exit", workspace: harness.workspace, profile: agentDir });
    assert.equal(viewFor(manager, id).lifecycle, "exited", "synchronous early exit is never overwritten with alive");
    assert.equal(viewFor(manager, id).hasLiveProcess, false);
    assert.equal(viewFor(manager, id).exitCode, 23);
    assert.equal(manager.hasLiveProcesses(), false);
    assert.equal(registrationEntryReleased(harness.registrar, id), true);
    assert.ok(manager.surface(id), "the exited row retains its terminal surface");
    const readmitted = registry.prepare({ workspace: harness.workspace, profile: agentDir });
    readmitted.release();
  } finally {
    cleanup(harness);
  }
});

test("a row closed reentrantly during exit-listener registration does not allocate detached resources", async () => {
  const harness = makeHarness("reentrant-close-on-exit");
  const spawned: FakePty[] = [];
  const changes: { id: string; present: boolean; lifecycle?: string }[] = [];
  let manager!: InstanceManager;
  let closedId: string | undefined;
  let closeResults: boolean[] = [];
  let notificationsAfterRemoval = 0;
  try {
    manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      env: cleanTestEnv(),
      ptyFactory: (descriptor) => {
        const pty = new FakePty(descriptor);
        if (spawned.length === 1) {
          pty.exitOnSubscription = { exitCode: 23, signal: 15 };
        }
        spawned.push(pty);
        return pty;
      },
      onChange: (id) => {
        const row = manager.list().find((candidate) => candidate.id === id);
        changes.push({ id, present: row !== undefined, lifecycle: row?.lifecycle });
        if (closedId === id && !row) {
          notificationsAfterRemoval += 1;
        }
        if (row?.lifecycle === "exited" && closedId === undefined) {
          closeResults.push(manager.closeExited(id));
          closedId = id;
        }
      },
    });

    const siblingId = await manager.create({ label: "sibling", workspace: harness.workspace2 });
    const siblingPty = spawned[0];
    const siblingSurface = manager.surface(siblingId);
    assert.ok(siblingSurface);

    const id = await manager.create({ label: "sync-exit", workspace: harness.workspace });
    assert.equal(closedId, id, "the exited-row observer closes synchronously from the exit callback");
    assert.deepEqual(closeResults, [true]);
    assert.equal(manager.list().some((row) => row.id === id), false);
    assert.equal(manager.surface(id), undefined, "a detached row has no public retained surface");
    assert.equal(
      changes.filter((change) => change.id === id && !change.present).length,
      1,
      "the removal notification is emitted once, with no later launch notification",
    );
    assert.equal(notificationsAfterRemoval, 0, "launch continuation emits no notification after reentrant removal");
    assert.deepEqual(spawned[1].killSignals, [], "closing the sync-exited child does not signal it");
    assert.equal(spawned[1].exited, true);
    assert.equal(manager.surface(siblingId), siblingSurface);
    assert.equal(viewFor(manager, siblingId).hasLiveProcess, true);
    assert.equal(siblingPty.exited, false);

    const nextId = await manager.create({ label: "next-create", workspace: harness.workspace });
    assert.equal(viewFor(manager, nextId).lifecycle, "alive");
    assert.ok(manager.surface(nextId));
    assert.equal(viewFor(manager, siblingId).hasLiveProcess, true);

    // Settle and close the fake fixture children without involving a shutdown
    // signal ladder; this test is only about manager ownership interleaving.
    siblingPty.emitExit(0);
    assert.equal(manager.closeExited(siblingId), true);
    spawned[2].emitExit(0);
    assert.equal(manager.closeExited(nextId), true);
  } finally {
    cleanup(harness);
  }
});

test("a synchronous output-queue failure stays an error and stops only its owner", async () => {
  const harness = makeHarness("parse-failure");
  try {
    const spawned: FakePty[] = [];
    const factory: PtyFactory = (descriptor) => {
      const pty = new FakePty(descriptor);
      if (spawned.length === 0) {
        pty.dataOnSubscription = "x".repeat(9 * 1024 * 1024);
      }
      spawned.push(pty);
      return pty;
    };
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: factory,
    });

    const failedId = await manager.create({ label: "parse-failed", workspace: harness.workspace });
    const healthyId = await manager.create({ label: "healthy", workspace: harness.workspace2 });
    const failed = viewFor(manager, failedId);
    assert.equal(failed.lifecycle, "error", "the synchronous parse failure is not overwritten with alive");
    assert.equal(failed.error, "session-host: instance output parsing failed");
    assert.equal(failed.hasLiveProcess, true, "an error row still reports its unconfirmed owned PTY");
    assert.equal(registrationEntryReleased(harness.registrar, failedId), false, "status registration remains until confirmed exit");
    assert.throws(() => registry.prepare({ workspace: harness.workspace, profile: failed.agentDir }), /already has an active admission/);
    assert.deepEqual(spawned[0].killSignals, ["SIGTERM"], "the failed instance receives owned graceful cleanup");
    assert.deepEqual(spawned[1].killSignals, [], "a parser failure never stops a sibling");
    assert.equal(viewFor(manager, healthyId).lifecycle, "alive");
    assert.equal(viewFor(manager, healthyId).hasLiveProcess, true);
    assert.equal(manager.hasLiveProcesses(), true, "both owned handles remain live until their exits are confirmed");
    spawned[0].emitExit(1);
    await sleep(0);
    assert.equal(viewFor(manager, failedId).hasLiveProcess, false);
    assert.equal(registrationEntryReleased(harness.registrar, failedId), true);
    const readmitted = registry.prepare({ workspace: harness.workspace, profile: failed.agentDir });
    readmitted.release();
    assert.equal(viewFor(manager, healthyId).hasLiveProcess, true, "a sibling remains independently live");
    spawned[1].exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 20, killMs: 20 });
  } finally {
    cleanup(harness);
  }
});

test("PTY setup failure keeps process truth and admission until the owned child exits", async () => {
  const harness = makeHarness("pty-setup-failure");
  try {
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const factory: PtyFactory = (descriptor) => {
      const pty = harness.ptyFactory(descriptor) as FakePty;
      if (harness.spawned.length === 1) pty.dataSubscriptionError = new Error("private setup detail");
      return pty;
    };
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: factory,
    });
    const failedId = await manager.create({ label: "setup-failed", workspace: harness.workspace });
    const siblingId = await manager.create({ label: "healthy", workspace: harness.workspace2 });
    const failedPty = harness.spawned[0];
    const siblingPty = harness.spawned[1];
    const failed = viewFor(manager, failedId);
    assert.equal(failed.lifecycle, "error");
    assert.equal(failed.error, "session-host: instance PTY setup failed");
    assert.equal(failed.hasLiveProcess, true, "the factory returned an owned PTY before setup failed");
    assert.equal(registrationEntryReleased(harness.registrar, failedId), false);
    assert.deepEqual(failedPty.killSignals, ["SIGTERM"]);
    assert.deepEqual(siblingPty.killSignals, [], "setup failure stops only its own child");
    assert.equal(viewFor(manager, siblingId).hasLiveProcess, true);
    assert.throws(
      () => registry.prepare({ workspace: harness.workspace, profile: failed.agentDir }),
      /already has an active admission/,
    );

    failedPty.emitExit(9);
    await sleep(0);
    assert.equal(viewFor(manager, failedId).hasLiveProcess, false);
    assert.equal(registrationEntryReleased(harness.registrar, failedId), true);
    const readmitted = registry.prepare({ workspace: harness.workspace, profile: failed.agentDir });
    readmitted.release();
    siblingPty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
  } finally {
    cleanup(harness);
  }
});

test("a native PTY read error is contained to its owner until that child confirms exit", async () => {
  const harness = makeHarness("pty-read-error");
  try {
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const failedId = await manager.create({ label: "read-failed", workspace: harness.workspace });
    const siblingId = await manager.create({ label: "healthy", workspace: harness.workspace2 });
    const failedPty = harness.spawned[0];
    const siblingPty = harness.spawned[1];
    const secret = `private native read diagnostic ${"x".repeat(MAX_INSTANCE_ERROR_CHARS + 100)}`;
    const readError = new Error(secret);

    assert.doesNotThrow(() => failedPty.emitReadError(readError), "the native error does not escape through the host");
    assert.equal(viewFor(manager, failedId).lifecycle, "error");
    assert.equal(viewFor(manager, failedId).error, "session-host: instance PTY read failed");
    assert.equal(viewFor(manager, failedId).hasLiveProcess, true, "read failure does not claim the owned child exited");
    assert.equal(viewFor(manager, failedId).error?.includes(secret), false);
    assert.deepEqual(failedPty.killSignals, ["SIGTERM"]);
    assert.deepEqual(siblingPty.killSignals, [], "the read error cannot stop a sibling");
    assert.equal(manager.hasLiveProcesses(), true);
    assert.equal(registrationEntryReleased(harness.registrar, failedId), false);
    const failedAgentDir = viewFor(manager, failedId).agentDir;
    assert.throws(() => registry.prepare({ workspace: harness.workspace, profile: failedAgentDir }), /already has an active admission/);

    failedPty.emitExit(5);
    await sleep(0);
    assert.equal(viewFor(manager, failedId).lifecycle, "error", "the operation failure remains visible after its child exits");
    assert.equal(viewFor(manager, failedId).hasLiveProcess, false, "confirmed exit clears process truth without hiding the error");
    assert.equal(manager.hasLiveProcesses(), true, "the sibling is still owned and alive");
    assert.equal(registrationEntryReleased(harness.registrar, failedId), true);
    const readmitted = registry.prepare({ workspace: harness.workspace, profile: failedAgentDir });
    readmitted.release();
    siblingPty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
    assert.equal(viewFor(manager, siblingId).lifecycle, "exited");
  } finally {
    cleanup(harness);
  }
});

test("expected UnixTerminal read-error codes do not fail healthy instances or mislabel normal exits", async () => {
  const harness = makeHarness("expected-pty-read-errors");
  try {
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const eagainId = await manager.create({ label: "retryable", workspace: harness.workspace });
    const eagainPty = harness.spawned[0];
    assert.doesNotThrow(() => eagainPty.emitReadError(Object.assign(new Error("retry"), { code: "EAGAIN" })));
    assert.equal(viewFor(manager, eagainId).lifecycle, "alive");
    assert.equal(viewFor(manager, eagainId).hasLiveProcess, true);
    assert.equal(viewFor(manager, eagainId).error, undefined);
    assert.deepEqual(eagainPty.killSignals, [], "EAGAIN is not a fatal child error");

    for (const [index, code] of ["EIO", "errno 5"].entries()) {
      const id = await manager.create({ label: `normal-exit-${index}`, workspace: harness.workspace2 });
      const pty = harness.spawned[index + 1];
      assert.doesNotThrow(() => pty.emitReadError(Object.assign(new Error("normal PTY close"), { code })));
      assert.equal(viewFor(manager, id).lifecycle, "alive", `${code} alone is not treated as confirmed exit`);
      assert.equal(viewFor(manager, id).hasLiveProcess, true);
      assert.equal(viewFor(manager, id).error, undefined);
      assert.deepEqual(pty.killSignals, []);

      pty.emitExit(0, 5);
      await sleep(0);
      assert.equal(viewFor(manager, id).lifecycle, "exited");
      assert.equal(viewFor(manager, id).hasLiveProcess, false);
      assert.equal(viewFor(manager, id).error, undefined, `${code} followed by exit remains a normal exited row`);
      assert.equal(registrationEntryReleased(harness.registrar, id), true);
    }

    eagainPty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
    assert.equal(viewFor(manager, eagainId).lifecycle, "exited");
    assert.equal(viewFor(manager, eagainId).hasLiveProcess, false);
  } finally {
    cleanup(harness);
  }
});

test("read-error listener remains installed through synchronous native exit dispatch", async () => {
  const harness = makeHarness("pty-read-error-exit-race");
  try {
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const exitingId = await manager.create({ label: "exiting", workspace: harness.workspace });
    const siblingId = await manager.create({ label: "sibling", workspace: harness.workspace2 });
    const exitingPty = harness.spawned[0];
    const siblingPty = harness.spawned[1];
    exitingPty.exitBeforeReadErrorListenerCountCheck = true;

    assert.doesNotThrow(
      () => exitingPty.emitReadError(new Error("unexpected socket error during synchronous exit")),
      "deferred listener removal keeps UnixTerminal's listener-count check satisfied",
    );
    assert.equal(viewFor(manager, exitingId).lifecycle, "exited");
    assert.equal(viewFor(manager, exitingId).hasLiveProcess, false);
    assert.equal(viewFor(manager, exitingId).error, undefined);
    assert.equal(registrationEntryReleased(harness.registrar, exitingId), true);
    assert.deepEqual(exitingPty.killSignals, []);
    assert.equal(viewFor(manager, siblingId).lifecycle, "alive");
    assert.deepEqual(siblingPty.killSignals, [], "the native exit race cannot affect a sibling");

    siblingPty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
  } finally {
    cleanup(harness);
  }
});

test("failed spawn before a child exists is truthful and exposes no upstream diagnostic contents", async () => {
  const harness = makeHarness("startfail");
  try {
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const agentDir = join(harness.root, "supplied-profile");
    mkdirSync(agentDir, { recursive: true });
    const argumentSecret = "argv-secret-value";
    const providerSecret = "provider-env-secret-value";
    const configSecret = "private-config-content-value";
    const configContents = JSON.stringify({ enabled: true, secret: configSecret });
    const token = `bootstrap-secret-${"x".repeat(MAX_INSTANCE_ERROR_CHARS + 80)}`;
    writeFileSync(join(agentDir, "review-gate.json"), configContents, "utf8");
    harness.registrar.nextToken = token;
    const managerEnv = cleanTestEnv();
    managerEnv.PROVIDER_SECRET = providerSecret;
    const factory: PtyFactory = (descriptor) => {
      const bootstrap = descriptor.env[SESSION_HOST_BOOTSTRAP_ENV];
      assert.ok(bootstrap);
      const upstreamDetails = [
        descriptor.args.join(" "),
        descriptor.env.PROVIDER_SECRET,
        readFileSync(descriptor.env.PI_REVIEW_GATE_CONFIG as string),
        bootstrap,
      ].join(" | ");
      throw new Error(`pty factory failed with upstream details: ${upstreamDetails}`);
    };
    const notifications: { lifecycle: string | undefined; registrationReleased: boolean | undefined }[] = [];
    let manager!: InstanceManager;
    manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      args: ["--model", argumentSecret],
      env: managerEnv,
      onChange: (changedId) => {
        const current = manager.list().find((row) => row.id === changedId);
        const registration = harness.registrar.entries.find((entry) => entry.instanceId === changedId);
        notifications.push({ lifecycle: current?.lifecycle, registrationReleased: registration?.released });
      },
      ptyFactory: factory,
    });
    const id = await manager.create({ label: "doomed", workspace: harness.workspace, profile: agentDir });
    assert.ok(id);
    const view = viewFor(manager, id);
    assert.equal(view.lifecycle, "error");
    assert.equal(view.exitCode, undefined);
    assert.equal(view.hasLiveProcess, false, "pre-spawn failure owns no process handle");
    assert.equal(view.error, "session-host: instance PTY setup failed");
    assert.ok(view.error);
    assert.ok(view.error.length <= MAX_INSTANCE_ERROR_CHARS);
    for (const secret of [argumentSecret, providerSecret, configSecret, configContents, token, token.slice(0, 128)]) {
      assert.equal(view.error.includes(secret), false, "upstream diagnostic material is never copied or truncated into the public row");
    }
    const finalNotification = notifications.at(-1);
    assert.deepEqual(finalNotification, { lifecycle: "error", registrationReleased: true }, "failed-spawn cleanup notifies observers after releasing status");
    assert.equal(harness.spawned.length, 0, "spawning genuinely failed");
    assert.equal(registrationEntryReleased(harness.registrar, id), true, "registration released on failed spawn");
    // Admission released: the same supplied profile can be admitted again.
    await registry.prepare({ workspace: harness.workspace, profile: agentDir });
    assert.equal(manager.hasLiveProcesses(), false);
    assert.equal(manager.surface(id), undefined, "no parse pipeline exists after a failed spawn");
    writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({ enabled: true }), "utf8");
    rmSync(agentDir, { recursive: true, force: true });
  } finally {
    cleanup(harness);
  }
});

test("resize and query-write failures never expose argv, provider env, config, or long bootstrap tokens", async () => {
  const harness = makeHarness("runtime-diagnostic-privacy");
  try {
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const agentDir = join(harness.root, "private-profile");
    mkdirSync(agentDir, { recursive: true });
    const argumentSecret = "argv-runtime-secret";
    const providerSecret = "provider-runtime-secret";
    const configSecret = "config-runtime-secret";
    const configContents = JSON.stringify({ enabled: true, privateValue: configSecret });
    const token = `long-runtime-token-${"t".repeat(MAX_INSTANCE_ERROR_CHARS + 120)}`;
    writeFileSync(join(agentDir, "review-gate.json"), configContents, "utf8");
    const managerEnv = cleanTestEnv();
    managerEnv.PROVIDER_SECRET = providerSecret;
    const factory: PtyFactory = (descriptor) => {
      const pty = harness.ptyFactory(descriptor) as FakePty;
      pty.exitsOnSignal = "SIGTERM";
      const bootstrap = descriptor.env[SESSION_HOST_BOOTSTRAP_ENV];
      assert.ok(bootstrap);
      const upstreamDetails = [
        descriptor.args.join(" "),
        descriptor.env.PROVIDER_SECRET,
        readFileSync(descriptor.env.PI_REVIEW_GATE_CONFIG as string),
        bootstrap,
      ].join(" | ");
      if (harness.spawned.length === 1) {
        pty.resizeError = new Error(`native resize failed: ${upstreamDetails}`);
      } else {
        pty.writeError = new Error(`native query write failed: ${upstreamDetails}`);
      }
      return pty;
    };
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      args: ["--model", argumentSecret],
      env: managerEnv,
      ptyFactory: factory,
    });
    harness.registrar.nextToken = token;
    const resizeId = await manager.create({ label: "resize-private", workspace: harness.workspace, profile: agentDir });
    manager.resize(101, 31);
    assert.equal(viewFor(manager, resizeId).error, "session-host: instance PTY resize failed");

    harness.registrar.nextToken = token;
    const queryId = await manager.create({ label: "query-private", workspace: harness.workspace2, profile: agentDir });
    harness.spawned[1].emitData("\x1b[>7u\x1b[?u");
    await manager.surface(queryId)!.flush();
    assert.equal(viewFor(manager, queryId).error, "session-host: instance query reply write failed");

    for (const id of [resizeId, queryId]) {
      const error = viewFor(manager, id).error ?? "";
      assert.ok(error.length <= MAX_INSTANCE_ERROR_CHARS);
      for (const secret of [argumentSecret, providerSecret, configSecret, configContents, token, token.slice(0, 128)]) {
        assert.equal(error.includes(secret), false, "fixed diagnostics do not reveal or truncate upstream contents");
      }
      assert.equal(registrationEntryReleased(harness.registrar, id), true);
    }
    assert.equal(manager.hasLiveProcesses(), false);
  } finally {
    cleanup(harness);
  }
});

test("label and workspace validation; creation after shutdown is rejected", async () => {
  const harness = makeHarness("validate");
  try {
    await assert.rejects(() => harness.manager.create({ label: "l".repeat(MAX_LABEL_CHARS + 1), workspace: harness.workspace }), /label exceeds/);
    await assert.rejects(() => harness.manager.create({ label: "two\nlines", workspace: harness.workspace }), /single line/);
    await assert.rejects(() => harness.manager.create({ label: "two\u2028lines", workspace: harness.workspace }), /single line/);
    await assert.rejects(() => harness.manager.create({ label: "c1\u009b-control", workspace: harness.workspace }), /single line/);
    await assert.rejects(() => harness.manager.create({ label: "ctl\x1b", workspace: harness.workspace }), /single line/);
    await assert.rejects(() => harness.manager.create({ label: "ok", workspace: "" }), /explicit workspace/);
    await assert.rejects(() => harness.manager.create({ label: "ok", workspace: 17 as unknown as string } as CreateInstanceOptions), /workspace/);
    await harness.manager.shutdown({ graceMs: 10, killMs: 10 });
    await assert.rejects(() => harness.manager.create({ label: "late", workspace: harness.workspace }), /shut down/);
  } finally {
    cleanup(harness);
  }
});

test("backpressure pauses and resumes only the owned source, preserving query-reply ownership", async () => {
  const harness = makeHarness("backpressure");
  try {
    const idA = await harness.manager.create({ label: "noisy", workspace: harness.workspace });
    const idB = await harness.manager.create({ label: "quiet", workspace: harness.workspace2 });
    const ptyA = harness.spawned[0];
    const ptyB = harness.spawned[1];
    // One chunk over the 1 MiB high watermark (default surface budget):
    // the source pauses until the queue drains below the low watermark.
    ptyA.emitData("x".repeat(1500 * 1024));
    assert.equal(ptyA.paused, true, "queue backpressure pauses the owned pty");
    assert.equal(ptyB.paused, false, "siblings are untouched");
    await harness.manager.surface(idA)!.flush();
    assert.equal(ptyA.paused, false, "draining below the low watermark resumes the source");
    assert.equal(ptyA.pauseCount >= 1 && ptyA.resumeCount >= 1, true);
    // Query-reply ownership is preserved while flow control is wired.
    ptyA.emitData("\x1b[>7u\x1b[?u");
    await harness.manager.surface(idA)!.flush();
    assert.equal(ptyA.writes.includes("\x1b[?7u"), true);
    assert.equal(ptyB.writes.length, 0);
  } finally {
    cleanup(harness);
  }
});

test("a throwing resume after successful pause fails only its owner and retains admission until exit", async () => {
  const harness = makeHarness("resume-failure");
  try {
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const failedId = await manager.create({ label: "resume-failed", workspace: harness.workspace });
    const siblingId = await manager.create({ label: "sibling", workspace: harness.workspace2 });
    const failedPty = harness.spawned[0];
    const siblingPty = harness.spawned[1];
    failedPty.resumeError = new Error("upstream resume error contains private provider/config/token details");

    failedPty.emitData("x".repeat(1500 * 1024));
    assert.equal(failedPty.paused, true, "the initial pause succeeds");
    await manager.surface(failedId)!.flush();

    assert.equal(viewFor(manager, failedId).lifecycle, "error");
    assert.equal(viewFor(manager, failedId).hasLiveProcess, true);
    assert.equal(viewFor(manager, failedId).error, "session-host: instance PTY resume failed");
    assert.equal(failedPty.pauseCount, 1);
    assert.equal(failedPty.resumeCount, 1, "resume was attempted");
    assert.equal(failedPty.paused, true, "a failed resume does not pretend the source was resumed");
    assert.deepEqual(failedPty.killSignals, ["SIGTERM"], "the affected child gets owned cleanup");
    assert.deepEqual(siblingPty.killSignals, [], "resume failure does not stop a sibling");
    assert.equal(registrationEntryReleased(harness.registrar, failedId), false);
    assert.equal(manager.hasLiveProcesses(), true);
    const failedAgentDir = viewFor(manager, failedId).agentDir;
    assert.throws(() => registry.prepare({ workspace: harness.workspace, profile: failedAgentDir }), /already has an active admission/);

    failedPty.emitExit(7);
    await sleep(0);
    assert.equal(viewFor(manager, failedId).lifecycle, "error", "the resume failure remains visible after confirmed exit");
    assert.equal(viewFor(manager, failedId).hasLiveProcess, false);
    assert.equal(registrationEntryReleased(harness.registrar, failedId), true);
    const readmitted = registry.prepare({ workspace: harness.workspace, profile: failedAgentDir });
    readmitted.release();
    siblingPty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
    assert.equal(viewFor(manager, siblingId).lifecycle, "exited");
  } finally {
    cleanup(harness);
  }
});

test("a throwing pause is a fatal owned PTY I/O error", async () => {
  const harness = makeHarness("pause-failure");
  try {
    const registry = new ProfileRegistry({ stateRoot: harness.stateRoot });
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const id = await manager.create({ label: "pause-failed", workspace: harness.workspace });
    const pty = harness.spawned[0];
    pty.pauseError = new Error("private pause detail");
    pty.emitData("x".repeat(1500 * 1024));

    assert.equal(viewFor(manager, id).lifecycle, "error");
    assert.equal(viewFor(manager, id).hasLiveProcess, true);
    assert.equal(viewFor(manager, id).error, "session-host: instance PTY pause failed");
    assert.equal(pty.pauseCount, 1);
    assert.equal(pty.paused, false, "the failed pause is not represented as successful");
    assert.deepEqual(pty.killSignals, ["SIGTERM"]);
    assert.equal(registrationEntryReleased(harness.registrar, id), false, "admission remains until confirmed exit");
    pty.emitExit(8);
    await sleep(0);
    assert.equal(viewFor(manager, id).hasLiveProcess, false);
    assert.equal(registrationEntryReleased(harness.registrar, id), true);
  } finally {
    cleanup(harness);
  }
});

test("resize updates hidden and visible live children while containing per-instance failures", async () => {
  const harness = makeHarness("resize");
  try {
    const idA = await harness.manager.create({ label: "shown", workspace: harness.workspace });
    const idB = await harness.manager.create({ label: "hidden", workspace: harness.workspace2 });
    harness.manager.resize(100, 30);
    const ptyA = harness.spawned[0];
    const ptyB = harness.spawned[1];
    assert.deepEqual([ptyA.cols, ptyA.rows], [100, 30]);
    assert.deepEqual([ptyB.cols, ptyB.rows], [100, 30]);
    assert.deepEqual(harness.manager.surface(idB)!.frame().lines[0].length > 0, true);
    assert.equal(harness.manager.surface(idB)!.frame().cols, 100);
    assert.deepEqual(ptyA.killSignals, [], "resizing never kills or stops a child");
    assert.deepEqual(ptyB.killSignals, []);
    assert.equal(harness.manager.hasLiveProcesses(), true);

    // A resize failure becomes a truthful error and stops only its owned
    // child; ownership remains live until the child's own exit event arrives.
    ptyB.resizeError = new Error("synthetic resize failure");
    harness.manager.resize(60, 20);
    assert.deepEqual([ptyA.cols, ptyA.rows], [60, 20]);
    assert.deepEqual([ptyB.cols, ptyB.rows], [100, 30], "exited children are not resized");
    assert.deepEqual(ptyB.killSignals, ["SIGTERM"], "only the failed instance is stopped");
    assert.equal(viewFor(harness.manager, idB).lifecycle, "error");
    assert.equal(viewFor(harness.manager, idB).hasLiveProcess, true);
    assert.equal(registrationEntryReleased(harness.registrar, idB), false);
    assert.equal(viewFor(harness.manager, idA).hasLiveProcess, true, "the sibling remains live");
    ptyB.emitExit(1);
    await sleep(0);
    assert.equal(viewFor(harness.manager, idB).hasLiveProcess, false);
    assert.equal(registrationEntryReleased(harness.registrar, idB), true);
    harness.manager.resize(50, 18);
    assert.deepEqual([ptyA.cols, ptyA.rows], [50, 18]);
    assert.deepEqual([ptyB.cols, ptyB.rows], [100, 30]);
    assert.throws(() => harness.manager.resize(0, 20), /cols/);
  } finally {
    cleanup(harness);
  }
});

test("graceful shutdown settles a well-behaved owned child within the grace window", async () => {
  const harness = makeHarness("graceful");
  try {
    const id = await harness.manager.create({ label: "polite", workspace: harness.workspace });
    const pty = harness.spawned[0];
    pty.exitsOnSignal = "SIGTERM";
    const result = await harness.manager.shutdown({ graceMs: 500, killMs: 200 });
    assert.deepEqual(result.forcedIds, [], "no escalation needed");
    assert.deepEqual(result.remainingIds, [], "exit confirmed within grace");
    assert.deepEqual(pty.killSignals, ["SIGTERM"], "exactly the owned handle was signaled");
    const view = viewFor(harness.manager, id);
    assert.equal(view.lifecycle, "exited");
    assert.equal(registrationEntryReleased(harness.registrar, id), true);
    assert.equal(harness.manager.hasLiveProcesses(), false);
  } finally {
    cleanup(harness);
  }
});

test("bounded escalation SIGKILLs only the owned handle and reports forced ids honestly", async () => {
  const harness = makeHarness("escalate");
  try {
    const idA = await harness.manager.create({ label: "stubborn", workspace: harness.workspace });
    const idB = await harness.manager.create({ label: "polite", workspace: harness.workspace2 });
    const stubborn = harness.spawned[0];
    const polite = harness.spawned[1];
    stubborn.exitsOnSignal = "SIGKILL";
    polite.exitsOnSignal = "SIGTERM";
    // Never call real process.kill: escalation must go through the owned pty only.
    const processKill = process.kill;
    let processKillCalls = 0;
    process.kill = ((pid: number | string, signal?: string | number) => {
      processKillCalls += 1;
      void pid;
    }) as typeof process.kill;
    try {
      const result = await harness.manager.shutdown({ graceMs: 100, killMs: 100 });
      assert.deepEqual(result.forcedIds, [idA], "escalation reported for the stubborn child");
      assert.deepEqual(result.remainingIds, [], "SIGKILL settled it within the kill window");
    } finally {
      process.kill = processKill;
    }
    assert.deepEqual(stubborn.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(polite.killSignals, ["SIGTERM"]);
    assert.equal(processKillCalls, 0, "no global process scan, no arbitrary pid signaling");
    assert.equal(viewFor(harness.manager, idA).lifecycle, "exited");
    assert.equal(viewFor(harness.manager, idA).exitCode, 0);
    assert.equal(registrationEntryReleased(harness.registrar, idA), true);
  } finally {
    cleanup(harness);
  }
});

test("a child that never settles keeps its admission and is reported with remaining ids", async () => {
  const harness = makeHarness("remaining");
  try {
    const stateRoot = harness.stateRoot;
    const registry = new ProfileRegistry({ stateRoot });
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: registry,
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const id = await manager.create({ label: "hung", workspace: harness.workspace });
    const pty = harness.spawned[0];
    const view = viewFor(manager, id);
    const agentDir = view.agentDir;
    pty.exitsOnSignal = "none";
    const result = await manager.shutdown({ graceMs: 60, killMs: 60 });
    assert.deepEqual(result.forcedIds, [id], "escalation truly happened");
    assert.deepEqual(result.remainingIds, [id], "an unconfirmable child stays in the result");
    const retry = await manager.shutdown({ graceMs: 1, killMs: 1 });
    assert.deepEqual(retry.forcedIds, [id], "a repeat reports the earlier escalation");
    assert.deepEqual(retry.remainingIds, [id], "a repeat retains the live handle honestly");
    assert.deepEqual(pty.killSignals, ["SIGTERM", "SIGKILL"], "a repeat does not resignal the owned PTY");
    const hung = viewFor(manager, id);
    assert.equal(hung.lifecycle, "alive", "truthful: the owned child never confirmed exit");
    assert.equal(manager.hasLiveProcesses(), true);
    assert.equal(registrationEntryReleased(harness.registrar, id), false, "registration held while the child lives");
    // The admission must NOT be freed as if the child were safely gone.
    assert.throws(() => registry.prepare({ workspace: harness.workspace, profile: agentDir }), /already has an active admission/);
    // A later confirmed exit releases the admission truthfully.
    pty.emitExit(1);
    await sleep(0);
    assert.equal(viewFor(manager, id).lifecycle, "exited");
    assert.equal(registrationEntryReleased(harness.registrar, id), true);
    await registry.prepare({ workspace: harness.workspace, profile: agentDir });
    assert.equal(manager.hasLiveProcesses(), false);
  } finally {
    cleanup(harness);
  }
});

test("shutdown recomputes remaining handles after a timed-out child exits while a sibling is still stopping", async () => {
  const harness = makeHarness("late-exit-during-shutdown");
  let firstPty: FakePty | undefined;
  let slowSiblingPty: FakePty | undefined;
  let lateExitTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<Awaited<ReturnType<InstanceManager["shutdown"]>>> | undefined;
  try {
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const firstId = await manager.create({ label: "short-ladder", workspace: harness.workspace });
    const slowSiblingId = await manager.create({ label: "existing-error-stop", workspace: harness.workspace2 });
    firstPty = harness.spawned[0];
    slowSiblingPty = harness.spawned[1];

    // This fatal query-write error starts a default 8s+2s owned stop before
    // shutdown. Its ladder remains pending while the first child's short
    // shutdown ladder times out and that child later confirms exit.
    slowSiblingPty.writeError = new Error("synthetic query-write failure");
    slowSiblingPty.emitData("\x1b[>7u\x1b[?u");
    await manager.surface(slowSiblingId)!.flush();
    assert.equal(viewFor(manager, slowSiblingId).lifecycle, "error");
    assert.deepEqual(slowSiblingPty.killSignals, ["SIGTERM"]);

    const graceMs = 40;
    const killMs = 40;
    firstPty.killHook = (signal) => {
      if (signal !== "SIGKILL") return;
      // The short ladder's kill wait expires at killMs. Confirm exit after
      // that timeout, while the sibling's pre-existing default ladder waits.
      lateExitTimer = setTimeout(() => {
        firstPty?.emitExit(41, 9);
        setImmediate(() => slowSiblingPty?.emitExit(0, 15));
      }, killMs + 10);
    };
    shutdownPromise = manager.shutdown({ graceMs, killMs });
    const result = await shutdownPromise;

    assert.deepEqual(firstPty.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(slowSiblingPty.killSignals, ["SIGTERM"], "shutdown shares the sibling's existing stop ladder");
    assert.deepEqual(result.forcedIds, [firstId], "escalation history is preserved");
    assert.deepEqual(result.remainingIds, [], "a handle that exited before all ladders finished is not reported remaining");
    assert.equal(viewFor(manager, firstId).hasLiveProcess, false);
    assert.equal(viewFor(manager, slowSiblingId).hasLiveProcess, false);
    assert.equal(manager.hasLiveProcesses(), false);
  } finally {
    if (lateExitTimer) clearTimeout(lateExitTimer);
    firstPty?.emitExit(41, 9);
    slowSiblingPty?.emitExit(0, 15);
    await shutdownPromise?.catch(() => undefined);
    cleanup(harness);
  }
});

test("shutdown during a pending create aborts the spawn; nothing revives or leaks a token", async () => {
  const harness = makeHarness("concurrent");
  try {
    const idFirst = await harness.manager.create({ label: "first", workspace: harness.workspace });
    harness.spawned[0].exitsOnSignal = "SIGTERM";
    const latePromise = harness.manager.create({ label: "late", workspace: harness.workspace2 });
    // The late row is posted and genuinely 'starting' while pending.
    const lateRow = harness.manager.list().find((row) => row.label === "late");
    assert.ok(lateRow);
    assert.equal(lateRow.lifecycle, "starting");
    assert.throws(() => harness.manager.write(lateRow.id, "x"), /not accepting input/);

    const shutdownPromise = harness.manager.shutdown({ graceMs: 100, killMs: 100 });
    const [lateId] = await Promise.all([latePromise, shutdownPromise]);
    const lateView = harness.manager.list().find((row) => row.id === lateId);
    assert.ok(lateView);
    assert.equal(lateView.lifecycle, "error", "the aborted launch ends in a truthful error row");
    assert.equal(harness.spawned.length, 1, "no PTY was spawned after shutdown started");
    assert.equal(harness.registrar.entries.some((entry) => entry.instanceId === lateId), false, "the aborted row never acquired a registration or token");
    assert.equal(harness.manager.hasLiveProcesses(), false, "the first child settled gracefully in the same shutdown");
    assert.equal(viewFor(harness.manager, idFirst).lifecycle, "exited");
    // Creating after shutdown is rejected.
    await assert.rejects(() => harness.manager.create({ label: "more", workspace: harness.workspace }), /shut down/);
    // A repeated shutdown is honest and idempotent.
    const again = await harness.manager.shutdown({ graceMs: 10, killMs: 10 });
    assert.deepEqual(again.forcedIds, []);
    assert.deepEqual(again.remainingIds, []);
  } finally {
    cleanup(harness);
  }
});

test("dispose is idempotent, releases only owned resources, and preserves profile, workspace, and unknown files", async () => {
  const harness = makeHarness("dispose");
  try {
    const manager = harness.manager;
    const id = await manager.create({ label: "kept", workspace: harness.workspace });
    const agentDir = viewFor(manager, id).agentDir;
    // User-owned files inside the profile and the workspace are never touched.
    writeFileSync(join(agentDir, "settings.json"), "{}", "utf8");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(join(agentDir, "sessions", "session-1.jsonl"), "{}\n", "utf8");
    const unknownWorkspaceFile = join(harness.workspace, "user-owned.txt");
    writeFileSync(unknownWorkspaceFile, "keep", "utf8");
    const pty = harness.spawned[0];
    pty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 300, killMs: 100 });
    await manager.dispose();
    await manager.dispose(); // idempotent
    assert.equal(manager.surface(id), undefined, "owned terminal surfaces are closed");
    assert.equal(manager.hasLiveProcesses(), false);
    const config = readFileSync(join(agentDir, "review-gate.json"));
    assert.ok(config.includes('"enabled"'));
    assert.equal(readFileSync(join(agentDir, "settings.json")), "{}");
    assert.equal(readFileSync(join(agentDir, "sessions", "session-1.jsonl")), "{}\n");
    assert.equal(readFileSync(unknownWorkspaceFile), "keep", "workspace files are preserved");
  } finally {
    cleanup(harness);
  }
});

test("dispose without prior shutdown gracefully stops un-signaled children; already-escalated rows stay honest", async () => {
  const harness = makeHarness("dispose-fresh");
  try {
    const polite = await harness.manager.create({ label: "polite", workspace: harness.workspace });
    harness.spawned[0].exitsOnSignal = "SIGTERM";
    const hung = await harness.manager.create({ label: "hung", workspace: harness.workspace2 });
    harness.spawned[1].exitsOnSignal = "none";
    const hangId = hung;
    const result = await harness.manager.shutdown({ graceMs: 40, killMs: 40 });
    assert.deepEqual(result.remainingIds, [hangId], "the hung child is honestly remaining");
    const hungRegistration = harness.registrar.entryFor(hangId);
    harness.registrar.emitStatus(hungRegistration, {
      busy: true,
      pendingInput: true,
      inputSurface: true,
      activity: ["still running"],
    });
    const hungSignals = harness.spawned[1].killSignals.length;
    await harness.manager.dispose();
    assert.deepEqual(harness.spawned[1].killSignals.length, hungSignals, "dispose never re-signals an escalated child");
    assert.equal(viewFor(harness.manager, hangId).lifecycle, "alive", "dispose keeps never-settled rows truthful");
    assert.equal(viewFor(harness.manager, hangId).busy, null, "dispose closes status reporting without a stale busy badge");
    assert.equal(viewFor(harness.manager, hangId).pendingInput, null);
    assert.deepEqual(viewFor(harness.manager, hangId).activity, [], "dispose clears stale activity when reporting closes");
    assert.equal(viewFor(harness.manager, hangId).hasLiveProcess, true, "the retained row still truthfully owns the child");
    assert.equal(hungRegistration.released, true, "dispose releases the owned status registration");
    assert.equal(harness.manager.hasLiveProcesses(), true, "truthful: an owned child was not confirmed dead");
    assert.equal(viewFor(harness.manager, polite).lifecycle, "exited");
    // A dispose-only manager stops fresh children within the default windows.
    const fresh = makeHarness("dispose-only");
    try {
      const freshId = await fresh.manager.create({ label: "fresh", workspace: fresh.workspace });
      fresh.spawned[0].exitsOnSignal = "SIGTERM";
      await fresh.manager.dispose();
      assert.equal(viewFor(fresh.manager, freshId).lifecycle, "exited");
      assert.equal(fresh.manager.hasLiveProcesses(), false);
      assert.deepEqual(fresh.spawned[0].killSignals, ["SIGTERM"]);
    } finally {
      cleanup(fresh);
    }
  } finally {
    cleanup(harness);
  }
});

test("constructor validation and defaults", async () => {
  const harness = makeHarness("ctor");
  try {
    assert.throws(() => new InstanceManager({ packageRoot: "", piExecutable: "x", statusRegistrar: harness.registrar }), /packageRoot/);
    assert.throws(() => new InstanceManager({ packageRoot: "p", piExecutable: "", statusRegistrar: harness.registrar }), /piExecutable/);
    assert.throws(
      () => new InstanceManager({ packageRoot: "p", piExecutable: "x", statusRegistrar: { register: undefined as never } } as never),
      /statusRegistrar/,
    );
    assert.throws(
      () => new InstanceManager({
        packageRoot: harness.packageRoot,
        piExecutable: harness.piExecutable,
        statusRegistrar: harness.registrar,
        cols: 0,
      }),
      /cols/,
    );
    assert.throws(
      () => new InstanceManager({
        packageRoot: harness.packageRoot,
        piExecutable: harness.piExecutable,
        statusRegistrar: harness.registrar,
        rows: 1001,
      }),
      /rows/,
    );
    // Defaults are exported and stable.
    assert.equal(DEFAULT_SHUTDOWN_GRACE_MS, 8000);
    assert.equal(DEFAULT_SHUTDOWN_KILL_MS, 2000);
  } finally {
    cleanup(harness);
  }
});

test("prepareNativeLaunch parity: the manager reuses the landed contract unchanged", async () => {
  const harness = makeHarness("parity");
  try {
    const agentDir = join(harness.root, "parity-profile");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify({ enabled: true }), "utf8");
    const descriptor = prepareNativeLaunch({
      packageRoot: harness.packageRoot,
      agentDir,
      workspace: harness.workspace,
      piExecutable: harness.piExecutable,
      args: [],
      env: cleanTestEnv(),
    });
    assert.equal(descriptor.file, realpathSync(harness.piExecutable));
    assert.equal(descriptor.cwd, realpathSync(harness.workspace));
    assert.equal(descriptor.env[SESSION_HOST_BOOTSTRAP_ENV], undefined, "preparation never carries the token; only spawn injection does");
    rmSync(join(agentDir, "review-gate.json"), { force: true });
    rmSync(agentDir, { recursive: true, force: true });
  } finally {
    cleanup(harness);
  }
});

/**
 * REAL pinned native-addon fixture (POSIX; skipped when @lydell/node-pty
 * cannot load). This exercises native PTY cwd/env/geometry/input/shutdown
 * using an owned Node CLI shim. Synthetic gate/reporter/preload files and the
 * fake status registrar remain test-only; this is not real-Pi, preload, gate,
 * broker/protocol, or native Main compatibility evidence.
 */
const nodePtyLoadable = ((): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    require("@lydell/node-pty");
    return process.platform !== "win32";
  } catch {
    return false;
  }
})();

test("pinned native addon: independent PTYs with an owned Node shim, explicit cwd/env/input, and shutdown", { skip: nodePtyLoadable ? false : "the pinned @lydell/node-pty native addon could not be loaded", timeout: 30_000 }, async () => {
  const harness = makeHarness("real-pty");
  // This owned Node CLI shim has no child processes or timers: it reports its
  // own cwd/env/TTY geometry, echoes input from stdin events, and exits on TERM.
  const nodeShim = [
    "#!/usr/bin/env node",
    "\"use strict\";",
    "const path = require(\"node:path\");",
    "const base = path.basename(process.cwd());",
    "const boot = process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ? \"present\" : \"absent\";",
    "const geo = `${process.stdout.rows} ${process.stdout.columns}`;",
    "process.stdout.write(`DIR=${base}|BOOT=${boot}|GEO=${geo}\\n`);",
    "process.stdin.setEncoding(\"utf8\");",
    "let pending = \"\";",
    "process.stdin.on(\"data\", (chunk) => {",
    "  pending += chunk;",
    "  let newline;",
    "  while ((newline = pending.indexOf(\"\\n\")) >= 0) {",
    "    const line = pending.slice(0, newline).replace(/\\r$/, \"\");",
    "    pending = pending.slice(newline + 1);",
    "    process.stdout.write(`GOT:${line}\\n`);",
    "  }",
    "});",
    "process.on(\"SIGTERM\", () => process.exit(0));",
    "",
  ].join("\n");
  const pi = join(harness.root, "bin", "shim-pi");
  writeFileSync(pi, nodeShim, "utf8");
  chmodSync(pi, 0o755);
  const realManager = new InstanceManager({
    packageRoot: harness.packageRoot,
    piExecutable: pi,
    statusRegistrar: harness.registrar,
    profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
    env: cleanTestEnv(),
  });
  try {
    const idA = await realManager.create({ label: "real-a", workspace: harness.workspace });
    const idB = await realManager.create({ label: "real-b", workspace: harness.workspace2 });
    const baseA = basename(harness.workspace);
    const baseB = basename(harness.workspace2);
    await until(() => frameText(realManager.surface(idA)).includes(`DIR=${baseA}`) && frameText(realManager.surface(idA)).includes("BOOT=present"), "instance A frame", 8000);
    await until(() => frameText(realManager.surface(idB)).includes(`DIR=${baseB}`), "instance B frame", 8000);
    assert.equal(frameText(realManager.surface(idA)).includes(`DIR=${baseB}`), false, "independent real cwd");
    assert.equal(frameText(realManager.surface(idA)).includes("GEO=24 80"), true, "initial geometry reached the real pty");
    // Input routed only to A's real pty.
    realManager.write(idA, "ping-a\n");
    await until(() => frameText(realManager.surface(idA)).includes("GOT:ping-a"), "input echo", 8000);
    assert.equal(frameText(realManager.surface(idB)).includes("GOT:ping-a"), false);
    // The owned Node shims handle SIGTERM directly and spawn no descendants.
    const result = await realManager.shutdown({ graceMs: 3000, killMs: 1000 });
    assert.deepEqual(result.remainingIds, [], "real managed children settle within the grace window");
    assert.equal(realManager.hasLiveProcesses(), false);
    assert.equal(viewFor(realManager, idA).lifecycle, "exited");
    assert.equal(viewFor(realManager, idB).lifecycle, "exited");
  } finally {
    await realManager.dispose().catch(() => undefined);
    cleanup(harness);
  }
});