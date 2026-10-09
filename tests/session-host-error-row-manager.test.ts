import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type PtyFactory,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { PreparedProfile, PrepareProfileOptions, ProfilePreparer } from "../src/session-host/profiles";

/**
 * Focused component tests for the deliberate error-row cleanup API
 * (`InstanceManager.closeError`).
 *
 * EVIDENCE SCOPE: every case drives the REAL InstanceManager with a fake
 * status registrar, a fake setup preparer, and deterministic fake original
 * PTYs. Nothing here loads `@lydell/node-pty`, spawns a process, starts a
 * worker/delegation, reads the native addon, or proves actual native/auth/
 * kernel behavior. The parent owns the consumer wiring (Main/sidebar) and the
 * aggregate/integration verification.
 *
 * FIXTURE POLICY: inert fixture files are created write-exclusive with mode
 * 0600 and are RETAINED on success and failure alike (no recursive teardown).
 * The fixture root lives under the git-ignored `dist-test/` build tree, so
 * retained trees never pollute tracked content. No executable fixture is
 * created: the `piExecutable` seam selects an existing tracked repository CLI
 * that the fake PTY never executes.
 */

function assertOriginalCallerAdmission(env: NodeJS.ProcessEnv = process.env): void {
  if (Object.keys(env).some((key) => ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"].includes(key.toUpperCase()))) {
    throw new Error("error-row manager verification refuses original role/catalog markers before fixture mutation");
  }
}

const fixtureBudgets = new Map<string, { files: number; bytes: number }>();
function writeBoundedFixture(path: string, bytes: string | Buffer): void {
  const root = [...fixtureBudgets.keys()].find((candidate) => path.startsWith(`${candidate}${sep}`));
  assert.ok(root, "fixture write must remain inside its explicitly created root");
  const budget = fixtureBudgets.get(root)!;
  budget.files += 1;
  budget.bytes += Buffer.byteLength(bytes);
  assert.ok(budget.files <= 32 && budget.bytes <= 256 * 1024, "inert fixture budget exceeded");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

/** A retained, git-ignored fixture root; never deleted, so failures stay inspectable. */
function fixtureRoot(label: string): string {
  assertOriginalCallerAdmission();
  const base = join(process.cwd(), "dist-test");
  const before = lstatSync(base, { bigint: true });
  assert.ok(before.isDirectory() && !before.isSymbolicLink(), "compiled test output must be a real existing directory");
  const root = realpathSync(mkdtempSync(join(base, `prg-error-row-${label}-`)));
  const after = lstatSync(base, { bigint: true });
  assert.ok(after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino,
    "fixture parent changed; retain the tree and refuse further writes");
  fixtureBudgets.set(root, { files: 0, bytes: 0 });
  return root;
}

/** An existing tracked repository JavaScript CLI; validated for path shape but never executed. */
function repositoryCliFixture(): string {
  return realpathSync(join(process.cwd(), "scripts", "fake-reviewer.cjs"));
}

/** Shared bounded skill fixtures: identical bytes for the package source and each admitted profile. */
const SKILL_FIXTURE_FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
  ["pi-review-gate-execution", ["SKILL.md"]],
  ["pi-review-gate-research", ["SKILL.md"]],
];

/** Synthetic package root with inert fixtures satisfying the legacy descriptor checks. */
function makePackageFixture(root: string): string {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  const inertFiles: Array<readonly [string, string]> = [
    [join(packageRoot, "dist", "src", "index.js"), "// synthetic gate-extension fixture; never imported or executed\n"],
    [join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// synthetic reporter fixture; never imported or executed\n"],
    [join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// synthetic inert preload fixture; never loaded\n"],
  ];
  for (const [skill, files] of SKILL_FIXTURE_FILES) {
    for (const file of files) {
      const path = join(packageRoot, "skills", skill, ...file.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      inertFiles.push([path, `${skill}/${file}\n`]);
    }
  }
  for (const [path, contents] of inertFiles) {
    writeBoundedFixture(path, contents);
  }
  return packageRoot;
}

/** Deterministic fake original PTY: no process, no native addon, no kernel behavior. */
class FakePty implements InstancePty {
  static #nextPid = 900000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  readonly killSignals: string[] = [];
  pauseCount = 0;
  resumeCount = 0;
  exited = false;
  dataSubscriptionError?: Error;
  exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "none";
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  // Mirrors UnixTerminal's built-in socket handler: an unexpected error throws
  // unless the manager installs its own listener through the runtime API.
  readonly #errorListeners: ((error: Error) => void)[] = [(error) => { throw error; }];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = (FakePty.#nextPid += 1);
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    if (this.dataSubscriptionError) throw this.dataSubscriptionError;
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

  /** Test-side emitter, delivered synchronously like the manager's guards expect. */
  emitData(data: string): void {
    for (const listener of [...this.#dataListeners]) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }

  errorListenerCount(): number {
    return this.#errorListeners.length;
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
  /** When set, the next release attempt records then throws (a failed cleanup). */
  throwNextRelease = false;
  readonly #releaseCounts = new Map<string, number>();

  register(instanceId: string, handlers: RegistrarEntry["handlers"]): InstanceStatusRegistration {
    const entry: RegistrarEntry = {
      instanceId,
      handlers,
      released: false,
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: `tok-${randomUUID()}`,
        instanceId,
        generation: randomUUID(),
      },
    };
    this.entries.push(entry);
    return {
      bootstrap: entry.bootstrap,
      release: () => {
        entry.released = true;
        this.#releaseCounts.set(instanceId, this.releaseCount(instanceId) + 1);
        if (this.throwNextRelease) {
          this.throwNextRelease = false;
          throw new Error("synthetic registration release failure");
        }
      },
    };
  }

  entryFor(instanceId: string): RegistrarEntry {
    const entry = this.entries.find((candidate) => candidate.instanceId === instanceId);
    assert.ok(entry, `registrar has no entry for ${instanceId}`);
    return entry;
  }

  releaseCount(instanceId: string): number {
    return this.#releaseCounts.get(instanceId) ?? 0;
  }

  emitStatus(instanceId: string, update: InstanceStatusUpdate): void {
    const entry = this.entryFor(instanceId);
    if (!entry.released) entry.handlers.onStatus(update);
  }

  /** Deliver even after the broker side released: the manager must still guard. */
  emitAfterRelease(instanceId: string, update: InstanceStatusUpdate): void {
    this.entryFor(instanceId).handlers.onStatus(update);
  }
}

interface FakeAdmission extends PreparedProfile {
  releaseCount: number;
}

class FakePreparer implements ProfilePreparer {
  readonly admissions: FakeAdmission[] = [];
  /** When set, the next admission release attempt records then throws (a failed cleanup). */
  throwNextRelease = false;
  #sequence = 0;

  constructor(readonly profilesRoot: string) {}

  prepare(options: PrepareProfileOptions): PreparedProfile {
    const agentDir = join(this.profilesRoot, `profile-${++this.#sequence}`);
    mkdirSync(agentDir, { recursive: true });
    writeBoundedFixture(join(agentDir, "review-gate.json"), "{}\n");
    // Prepopulate the shipped skill files with the exact package-source bytes
    // using the same wx/0600 fixture policy. prepareNativeLaunch()'s existing
    // byte-parity check then skips them, so refreshNativeProfileSkills() never
    // stages 0644 replacements through the manager under test.
    for (const [skill, files] of SKILL_FIXTURE_FILES) {
      for (const file of files) {
        const path = join(agentDir, "skills", skill, ...file.split("/"));
        mkdirSync(join(path, ".."), { recursive: true });
        writeBoundedFixture(path, `${skill}/${file}\n`);
      }
    }
    const admission = {
      workspace: realpathSync(options.workspace),
      agentDir: realpathSync(agentDir),
      created: true,
      releaseCount: 0,
      release: () => {},
    } as FakeAdmission;
    admission.release = () => {
      admission.releaseCount += 1;
      if (this.throwNextRelease) {
        this.throwNextRelease = false;
        throw new Error("synthetic profile release failure");
      }
    };
    this.admissions.push(admission);
    return admission;
  }
}

interface Harness {
  readonly root: string;
  readonly workspace: string;
  readonly workspace2: string;
  readonly registrar: FakeRegistrar;
  readonly preparer: FakePreparer;
  readonly spawned: FakePty[];
  readonly control: { failNextSpawn: boolean; failNextDataSubscription: boolean };
  readonly manager: InstanceManager;
}

function makeHarness(
  label: string,
  onChange?: (instanceId: string, manager: InstanceManager) => void,
): Harness {
  const root = fixtureRoot(label);
  const packageRoot = makePackageFixture(root);
  const profilesRoot = join(root, "profiles");
  mkdirSync(profilesRoot, { recursive: true });
  const workspace = join(root, "workspace-alpha");
  const workspace2 = join(root, "workspace-beta");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(workspace2, { recursive: true });
  const registrar = new FakeRegistrar();
  const preparer = new FakePreparer(profilesRoot);
  const spawned: FakePty[] = [];
  const control = { failNextSpawn: false, failNextDataSubscription: false };
  let manager!: InstanceManager;
  const ptyFactory: PtyFactory = (descriptor) => {
    if (control.failNextSpawn) {
      control.failNextSpawn = false;
      throw new Error("synthetic PTY factory failure");
    }
    const pty = new FakePty(descriptor);
    if (control.failNextDataSubscription) {
      control.failNextDataSubscription = false;
      pty.dataSubscriptionError = new Error("synthetic data listener wiring failure");
    }
    spawned.push(pty);
    return pty;
  };
  manager = new InstanceManager({
    packageRoot,
    piExecutable: repositoryCliFixture(),
    statusRegistrar: registrar,
    nativeSetup: false,
    profileRegistry: preparer,
    env: { ...process.env },
    ptyFactory,
    ...(onChange ? { onChange: (instanceId: string) => onChange(instanceId, manager) } : {}),
  });
  return { root, workspace, workspace2, registrar, preparer, spawned, control, manager };
}

function viewFor(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, "row must exist");
  return view;
}

function hasRow(manager: InstanceManager, id: string): boolean {
  return manager.list().some((row) => row.id === id);
}

/** Settle the fake original children of any still-live row, then dispose the manager. */
async function settle(harness: Harness): Promise<void> {
  for (const pty of harness.spawned) {
    if (!pty.exited) {
      pty.emitExit(0);
    }
  }
  await harness.manager.dispose();
}

test("error-row verification refuses original role/catalog aliases rather than stripping them", () => {
  for (const name of ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"]) {
    for (const alias of [name, name.toLowerCase()]) {
      for (const value of ["", "executor"]) {
        const env = { [alias]: value, NODE_OPTIONS: "--no-warnings" };
        assert.throws(() => assertOriginalCallerAdmission(env), /refuses original role\/catalog markers/);
        assert.equal(env[alias], value, "refusal does not mutate the caller environment");
        assert.equal(env.NODE_OPTIONS, "--no-warnings");
      }
    }
  }
});

test("closeError removes a settled no-child launch failure exactly once and preserves retained files", async () => {
  const harness = makeHarness("no-child");
  try {
    harness.control.failNextSpawn = true;
    const id = await harness.manager.create({ label: "doomed", workspace: harness.workspace });
    const view = viewFor(harness.manager, id);
    assert.equal(view.lifecycle, "error");
    assert.equal(view.hasLiveProcess, false, "a failed spawn before any child owns no process handle");
    assert.equal(view.error, "session-host: instance PTY setup failed");
    assert.equal(harness.spawned.length, 0, "the synthetic factory genuinely failed before a child existed");
    assert.equal(harness.registrar.releaseCount(id), 1, "the failed launch released its registration once");
    assert.equal(harness.preparer.admissions.length, 1);
    assert.equal(harness.preparer.admissions[0].releaseCount, 1, "the failed launch released its profile once");

    // Retained saved/workspace files must survive the row removal byte-identically.
    const agentDir = harness.preparer.admissions[0].agentDir;
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    const retainedFiles: readonly [string, Buffer][] = [
      [join(harness.workspace, "saved-work.bin"), Buffer.from([0, 1, 2, 255])],
      [join(agentDir, "sessions", "conversation.jsonl"), Buffer.from("saved conversation\n")],
      [join(agentDir, "auth.json"), Buffer.from('{"credential":"synthetic"}\n')],
    ];
    for (const [path, bytes] of retainedFiles) {
      writeBoundedFixture(path, bytes);
    }

    assert.equal(hasRow(harness.manager, id), true);
    assert.equal(harness.manager.closeError(id), true);
    assert.equal(hasRow(harness.manager, id), false, "the terminal error row is removed");
    assert.equal(harness.manager.surface(id), undefined, "no retained parse surface is left detached");
    assert.equal(harness.manager.closeError(id), false, "a repeated error-row close is a harmless unknown-id refusal");
    assert.equal(harness.registrar.releaseCount(id), 1, "no duplicate registration release");
    assert.equal(harness.preparer.admissions[0].releaseCount, 1, "no duplicate profile release");
    assert.equal(harness.manager.hasLiveProcesses(), false);

    // A late reporter callback queued against the removed row cannot resurrect it.
    harness.registrar.emitAfterRelease(id, {
      busy: true, pendingInput: true, inputSurface: true, activity: ["late status"],
    });
    assert.equal(hasRow(harness.manager, id), false, "late status cannot reinsert a removed row");
    assert.equal(harness.registrar.releaseCount(id), 1);

    for (const [path, bytes] of retainedFiles) {
      assert.deepEqual(readFileSync(path), bytes, `retained file stays byte-identical: ${path}`);
    }
  } finally {
    await settle(harness);
  }
});

test("closeError refuses a no-child error whose registration release is unconfirmed", async () => {
  const harness = makeHarness("registration-release-throw");
  try {
    harness.registrar.throwNextRelease = true;
    harness.control.failNextSpawn = true;
    const id = await harness.manager.create({ label: "doomed", workspace: harness.workspace });
    assert.equal(viewFor(harness.manager, id).lifecycle, "error");
    assert.equal(harness.registrar.releaseCount(id), 1, "the registration release was attempted exactly once");
    assert.equal(harness.manager.closeError(id), false, "an unconfirmed registration release blocks removal");
    assert.equal(harness.manager.closeError(id), false, "the refusal is stable across retries");
    assert.equal(harness.registrar.releaseCount(id), 1, "refusal never retries the external release");
    assert.equal(hasRow(harness.manager, id), true, "the row and its handles are retained fail closed");
    assert.equal(viewFor(harness.manager, id).hasLiveProcess, false);
  } finally {
    await settle(harness);
  }
});

test("closeError refuses a no-child error whose profile release is unconfirmed", async () => {
  const harness = makeHarness("profile-release-throw");
  try {
    harness.preparer.throwNextRelease = true;
    harness.control.failNextSpawn = true;
    const id = await harness.manager.create({ label: "doomed", workspace: harness.workspace });
    assert.equal(viewFor(harness.manager, id).lifecycle, "error");
    assert.equal(harness.preparer.admissions[0].releaseCount, 1, "the admission release was attempted exactly once");
    assert.equal(harness.manager.closeError(id), false, "an unconfirmed profile release blocks removal");
    assert.equal(harness.manager.closeError(id), false, "the refusal is stable across retries");
    assert.equal(harness.preparer.admissions[0].releaseCount, 1, "refusal never retries the external release");
    assert.equal(hasRow(harness.manager, id), true, "the row and its handles are retained fail closed");
  } finally {
    await settle(harness);
  }
});

test("closeError refuses while the row's own launch is in flight and removes once it settles", async () => {
  let startingRefusal: boolean | undefined;
  let errorRefusalDuringLaunch: boolean | undefined;
  const harness = makeHarness("in-flight", (id, manager) => {
    const row = manager.list().find((candidate) => candidate.id === id);
    if (!row) return;
    if (row.lifecycle === "starting" && startingRefusal === undefined) {
      startingRefusal = manager.closeError(id);
    }
    if (row.lifecycle === "error" && errorRefusalDuringLaunch === undefined) {
      // The failure is already on the row, but create()'s finally has not yet
      // marked this exact record's launch settled.
      errorRefusalDuringLaunch = manager.closeError(id);
    }
  });
  try {
    harness.control.failNextSpawn = true;
    const id = await harness.manager.create({ label: "late", workspace: harness.workspace });
    assert.equal(startingRefusal, false, "a starting row is never eligible for error-row removal");
    assert.equal(errorRefusalDuringLaunch, false, "an error seen before its own launch settled is refused");
    assert.equal(hasRow(harness.manager, id), true, "the refused row stays exactly as it was");
    assert.equal(harness.manager.closeError(id), true, "the settled terminal error removes safely");
    assert.equal(hasRow(harness.manager, id), false);
    assert.equal(harness.manager.closeError(id), false);
  } finally {
    await settle(harness);
  }
});

test("safe error-row cleanup neither blocks on nor stops a live or starting sibling", async () => {
  const removalNotifications: { id: string; present: boolean }[] = [];
  const harness = makeHarness("sibling", (id, manager) => {
    removalNotifications.push({ id, present: manager.list().some((row) => row.id === id) });
  });
  try {
    const siblingId = await harness.manager.create({ label: "sibling", workspace: harness.workspace2 });
    const siblingPty = harness.spawned[0];
    const siblingSurface = harness.manager.surface(siblingId);
    assert.ok(siblingSurface);
    harness.registrar.emitStatus(siblingId, {
      busy: true, pendingInput: true, inputSurface: true, activity: ["working"],
    });
    const siblingView = viewFor(harness.manager, siblingId);
    assert.equal(siblingView.busy, true);
    assert.equal(siblingPty.errorListenerCount(), 2, "the live sibling keeps its native + manager error listeners");

    harness.control.failNextSpawn = true;
    const errorId = await harness.manager.create({ label: "doomed", workspace: harness.workspace });
    assert.equal(viewFor(harness.manager, errorId).lifecycle, "error");

    // A sibling create is deliberately in flight while the error row is removed.
    const pendingSibling = harness.manager.create({ label: "starting", workspace: harness.workspace });
    assert.equal(harness.manager.closeError(errorId), true, "a live sibling never blocks safe error cleanup");
    await pendingSibling;

    assert.equal(hasRow(harness.manager, siblingId), true);
    assert.equal(hasRow(harness.manager, errorId), false);
    assert.equal(viewFor(harness.manager, siblingId).hasLiveProcess, true, "the sibling stays independently owned");
    assert.deepEqual(viewFor(harness.manager, siblingId), siblingView, "sibling status is untouched");
    assert.strictEqual(harness.manager.surface(siblingId), siblingSurface, "the sibling surface is untouched");
    assert.equal(siblingPty.exited, false);
    assert.deepEqual(siblingPty.killSignals, [], "removing the failed sibling signals nothing");

    // The sibling's original receiver still delivers after the removal.
    harness.registrar.emitStatus(siblingId, {
      busy: false, pendingInput: false, inputSurface: false, activity: ["idle"],
    });
    assert.equal(viewFor(harness.manager, siblingId).busy, false, "the sibling receiver remains live");
    assert.equal(siblingPty.errorListenerCount(), 2, "the sibling error subscription is preserved");

    const removedNotifications = removalNotifications.filter((entry) => entry.id === errorId && !entry.present);
    assert.equal(removedNotifications.length, 1, "the error row emits exactly one removal notification");

    // The sibling's original onExit still governs its own removal and no extra signal is sent.
    siblingPty.emitExit(0);
    assert.equal(harness.manager.closeExited(siblingId), true, "the sibling's own confirmed exit still removes it");
    assert.deepEqual(siblingPty.killSignals, [], "no cleanup path signaled the healthy sibling");
  } finally {
    await settle(harness);
  }
});

test("an errored row with an owned, unexited original child refuses until its exact exit", async () => {
  const harness = makeHarness("owned-error");
  try {
    harness.control.failNextDataSubscription = true;
    const errorId = await harness.manager.create({ label: "wired-failed", workspace: harness.workspace });
    const errorPty = harness.spawned[0];
    assert.equal(viewFor(harness.manager, errorId).lifecycle, "error");
    assert.equal(viewFor(harness.manager, errorId).hasLiveProcess, true, "the original owned child is still held");
    assert.deepEqual(errorPty.killSignals, ["SIGTERM"], "the failed launch already initiated an owned graceful stop");
    assert.equal(harness.registrar.releaseCount(errorId), 0, "registration stays owned until the child confirms exit");
    assert.equal(harness.preparer.admissions[0].releaseCount, 0, "the profile admission stays owned until exit");

    // Optimistic/stale UI evidence cannot authorize removal of a live child.
    harness.registrar.emitStatus(errorId, {
      busy: false, pendingInput: false, inputSurface: false, activity: [], backgroundTasks: 0, backgroundShells: 0,
    });
    assert.equal(viewFor(harness.manager, errorId).busy, false);
    assert.equal(harness.manager.closeError(errorId), false, "busy=false and zero counts are never evidence of exit");
    assert.equal(harness.manager.closeError(errorId), false, "the refusal is stable while the child is unexited");
    assert.deepEqual(errorPty.killSignals, ["SIGTERM"], "refusals never re-signal the owned child");
    assert.equal(errorPty.exited, false);

    errorPty.emitExit(11);
    assert.equal(viewFor(harness.manager, errorId).lifecycle, "error", "the operation failure stays visible after exit");
    assert.equal(viewFor(harness.manager, errorId).hasLiveProcess, false);
    assert.equal(viewFor(harness.manager, errorId).exitCode, 11, "the exit code comes only from the owned exit event");
    assert.equal(harness.registrar.releaseCount(errorId), 1, "the exact owned exit released the registration once");
    assert.equal(harness.preparer.admissions[0].releaseCount, 1, "the exact owned exit released the profile once");

    assert.equal(harness.manager.closeError(errorId), true, "only the exact confirmed exit makes the error row removable");
    assert.equal(hasRow(harness.manager, errorId), false);
    assert.equal(harness.manager.closeError(errorId), false, "a repeated close after exit is a harmless refusal");
    assert.equal(harness.registrar.releaseCount(errorId), 1, "no duplicate release callback after removal");
    assert.equal(harness.preparer.admissions[0].releaseCount, 1, "no duplicate profile release callback after removal");
    assert.deepEqual(errorPty.killSignals, ["SIGTERM"], "removal never signals the already-exited child again");

    // Late data/exit from the removed original cannot resurrect or retarget it.
    errorPty.emitData("late-frame-must-not-return");
    errorPty.emitExit(99);
    assert.equal(hasRow(harness.manager, errorId), false, "late data/exit cannot resurrect the removed row");
    assert.equal(harness.manager.surface(errorId), undefined, "the removed row retains no surface");
  } finally {
    await settle(harness);
  }
});

test("closeExited stays strict, and closeError refuses unknown, starting, and live rows", async () => {
  const harness = makeHarness("refusals");
  try {
    assert.equal(harness.manager.closeError("unknown-instance"), false);
    assert.equal(harness.manager.closeExited("unknown-instance"), false);

    const pendingLive = harness.manager.create({ label: "starting", workspace: harness.workspace });
    const startingRow = harness.manager.list().find((row) => row.label === "starting");
    assert.ok(startingRow);
    assert.equal(startingRow.lifecycle, "starting");
    assert.equal(harness.manager.closeError(startingRow.id), false);
    assert.equal(harness.manager.closeExited(startingRow.id), false);

    const liveId = await pendingLive;
    const livePty = harness.spawned[0];
    assert.equal(viewFor(harness.manager, liveId).lifecycle, "alive");
    assert.equal(harness.manager.closeError(liveId), false, "an alive row is never an error-row removal");
    assert.equal(harness.manager.closeExited(liveId), false, "closeExited remains actual-exit-only");
    assert.deepEqual(livePty.killSignals, [], "both refusals leave the live child unsignaled");
    assert.equal(hasRow(harness.manager, liveId), true);

    // A never-spawned error owns no PTY: closeExited must not call it "exited".
    harness.control.failNextSpawn = true;
    const errorId = await harness.manager.create({ label: "never-spawned", workspace: harness.workspace });
    assert.equal(viewFor(harness.manager, errorId).lifecycle, "error");
    assert.equal(harness.manager.closeExited(errorId), false, "a never-spawned error is not an exited PTY");
    assert.equal(hasRow(harness.manager, errorId), true, "the strict path leaves the error row in place");
    assert.equal(harness.manager.closeError(errorId), true, "the dedicated error path removes it");
    assert.equal(viewFor(harness.manager, liveId).hasLiveProcess, true, "the live row stays owned");

    livePty.emitExit(0);
    assert.equal(harness.manager.closeExited(liveId), true, "the strict path still removes a confirmed exit");
  } finally {
    await settle(harness);
  }
});
