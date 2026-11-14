/**
 * Focused coverage for the native status applicability contract and the
 * owner-bound native status seam (issue #277 native status slice).
 *
 * Two layers, no provider: the pure shared contract (what a declaration means and
 * what an observation may carry), and the manager seam that binds an observer to
 * ONE live hosted run.
 *
 * EVIDENCE SCOPE: every child here is a synthetic PTY and every launch descriptor
 * comes from an injected test provider. Nothing runs a real Claude or Codex binary,
 * reads or writes any provider configuration, credentials, conversation, or
 * terminal, or proves what a real provider reports. What IS proven is the contract
 * the dependent provider adapters will attach to: applicability is data and never a
 * sentinel inside a value; an accepted observation reaches the row through the
 * existing normalization; a malformed or contradictory observation changes nothing;
 * an observer's failure produces honest unknown, never a stale Ready, a zero, or a
 * not-applicable claim; and a seam of a replaced, exited, stopping, removed, or
 * disposed run accepts nothing. The Pi status path, the conservative ownership
 * counts, and the explicit native stop confirmation are shown unchanged.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeCliLaunch,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  NATIVE_STATUS_CATEGORIES,
  NATIVE_STATUS_NOT_APPLICABLE_TEXT,
  isNativeCategoryUnsupported,
  mergeNativeStatusSupport,
  readNativeStatusObservation,
  readNativeStatusSupport,
} from "../src/session-host/native-status";
import type { NativeCliBackend } from "../src/session-host/session-backend";

/* ------------------------------------------------------------------------- *
 * The shared applicability contract
 * ------------------------------------------------------------------------- */

test("an applicability declaration is read strictly, and only absence is no declaration", () => {
  assert.deepEqual(readNativeStatusSupport(undefined), { status: "absent" });
  assert.deepEqual(readNativeStatusSupport({}), { status: "declared", support: {} });
  const declared = readNativeStatusSupport({ agent: "supported", tasks: "unsupported" });
  assert.equal(declared.status, "declared");
  assert.ok(declared.status === "declared");
  assert.deepEqual(declared.support, { agent: "supported", tasks: "unsupported" });
  assert.ok(Object.isFrozen(declared.support), "a published declaration cannot be mutated");

  // A `null`, an array, a non-record, a foreign category, and a foreign value are
  // all INVALID, never laundered into the legacy absence.
  assert.equal(readNativeStatusSupport(null).status, "invalid");
  assert.equal(readNativeStatusSupport([]).status, "invalid");
  assert.equal(readNativeStatusSupport("unsupported").status, "invalid");
  assert.equal(readNativeStatusSupport({ tasks: "no" }).status, "invalid");
  assert.equal(readNativeStatusSupport({ tasks: null }).status, "invalid");
  assert.equal(readNativeStatusSupport({ tasks: 0 }).status, "invalid");
  assert.equal(readNativeStatusSupport({ backgroundTasks: "unsupported" }).status, "invalid");
  assert.equal(readNativeStatusSupport({ TASKS: "unsupported" }).status, "invalid");
  // A non-plain prototype (a class instance, or an object carrying an inherited
  // declaration bag) is refused outright, and a null-prototype record's own keys are
  // a declaration like any other.
  assert.equal(readNativeStatusSupport(Object.create({ tasks: "unsupported" })).status, "invalid");
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.tasks = "unsupported";
  const fromNullPrototype = readNativeStatusSupport(nullPrototype);
  assert.ok(fromNullPrototype.status === "declared");
  assert.deepEqual(fromNullPrototype.support, { tasks: "unsupported" });
});

test("only a positive unsupported declaration is not-applicable", () => {
  for (const category of NATIVE_STATUS_CATEGORIES) {
    const other = NATIVE_STATUS_CATEGORIES.find((candidate) => candidate !== category)!;
    assert.equal(isNativeCategoryUnsupported(undefined, category), false, "legacy rows stay reportable");
    assert.equal(isNativeCategoryUnsupported({}, category), false);
    assert.equal(isNativeCategoryUnsupported({ [category]: "supported" }, category), false);
    assert.equal(isNativeCategoryUnsupported({ [category]: "unsupported" }, category), true);
    // A declaration about another category never silences this one.
    assert.equal(isNativeCategoryUnsupported({ [other]: "unsupported" }, category), false);
  }
  assert.equal(NATIVE_STATUS_NOT_APPLICABLE_TEXT, "N/A");
});

test("a later declaration changes only the categories it names", () => {
  const first = readNativeStatusSupport({ tasks: "unsupported", shells: "unsupported" });
  assert.ok(first.status === "declared");
  const second = readNativeStatusSupport({ shells: "supported", agent: "unsupported" });
  assert.ok(second.status === "declared");
  const merged = mergeNativeStatusSupport(first.support, second.support);
  assert.deepEqual(merged, { agent: "unsupported", tasks: "unsupported", shells: "supported" });
  assert.ok(Object.isFrozen(merged));
  // No declaration at all never erases what the row already proved.
  assert.equal(mergeNativeStatusSupport(merged, undefined), merged);
  assert.equal(mergeNativeStatusSupport(undefined, undefined), undefined);
  // A malformed incoming map merges nothing.
  assert.equal(mergeNativeStatusSupport(merged, { tasks: "n/a" } as never), merged);
});

test("an observation is read strictly, and a provider count never rides the ownership channel", () => {
  assert.deepEqual(readNativeStatusObservation(undefined), { status: "absent" });
  const valid = readNativeStatusObservation({
    busy: false,
    pendingInput: null,
    activity: ["Ready"],
    activeTasks: 0,
    activeShells: null,
    support: { shells: "unsupported" },
  });
  assert.equal(valid.status, "valid");
  assert.ok(valid.status === "valid");
  assert.deepEqual(valid.snapshot, {
    busy: false,
    pendingInput: null,
    activity: ["Ready"],
    activeTasks: 0,
    activeShells: null,
    support: { shells: "unsupported" },
  });
  // An omitted value field is an unknown, never a kept-over value from before.
  const sparse = readNativeStatusObservation({});
  assert.ok(sparse.status === "valid");
  assert.deepEqual(sparse.snapshot, {
    busy: null, pendingInput: null, activity: [], activeTasks: null, activeShells: null,
  });

  // The conservative ownership pair and every foreign field are refused whole.
  assert.deepEqual(readNativeStatusObservation({ backgroundTasks: 0 }), { status: "invalid", field: "record" });
  assert.deepEqual(readNativeStatusObservation({ backgroundShells: 0 }), { status: "invalid", field: "record" });
  assert.deepEqual(readNativeStatusObservation({ inputSurface: true }), { status: "invalid", field: "record" });
  assert.deepEqual(
    readNativeStatusObservation({ nativeSession: { sessionId: "s", epoch: 1, name: "n" } }),
    { status: "invalid", field: "record" },
  );
  // A wrongly typed or impossible value is rejected, not collapsed to unknown.
  assert.deepEqual(readNativeStatusObservation({ activeTasks: "2" }), { status: "invalid", field: "activeTasks" });
  assert.deepEqual(readNativeStatusObservation({ activeTasks: -1 }), { status: "invalid", field: "activeTasks" });
  assert.deepEqual(readNativeStatusObservation({ activeTasks: 1.5 }), { status: "invalid", field: "activeTasks" });
  assert.deepEqual(readNativeStatusObservation({ busy: "idle" }), { status: "invalid", field: "busy" });
  assert.deepEqual(readNativeStatusObservation({ activity: "Ready" }), { status: "invalid", field: "activity" });
  assert.deepEqual(readNativeStatusObservation({ activity: [{}] }), { status: "invalid", field: "activity" });
  assert.deepEqual(readNativeStatusObservation({ support: null }), { status: "invalid", field: "support" });
  assert.deepEqual(readNativeStatusObservation("busy"), { status: "invalid", field: "record" });
});

test("a value for a category declared unreportable is never applied, and the rest still lands", () => {
  const declared = {
    tasks: "unsupported", shells: "unsupported", input: "unsupported", agent: "unsupported",
  } as const;
  // The declaration is authoritative: each declared category stays unknown (and
  // renders N/A), while the rest of a well-shaped snapshot is not thrown away.
  const coerced = readNativeStatusObservation(
    { busy: true, pendingInput: true, activity: ["Working"], activeTasks: 5, activeShells: 2 },
    declared,
  );
  assert.ok(coerced.status === "valid");
  assert.deepEqual(coerced.snapshot, {
    busy: null, pendingInput: null, activity: ["Working"], activeTasks: null, activeShells: null,
  });
  // Activity has its own declaration, and it wins the same way.
  const activityDeclared = readNativeStatusObservation(
    { busy: true, activity: ["Working"] },
    { agent: "supported", activity: "unsupported" },
  );
  assert.ok(activityDeclared.status === "valid");
  assert.deepEqual(activityDeclared.snapshot, {
    busy: true, pendingInput: null, activity: [], activeTasks: null, activeShells: null,
  });
  // The same rule applies to a declaration made inside the same observation.
  const same = readNativeStatusObservation({ busy: false, activeTasks: 0, support: { tasks: "unsupported" } });
  assert.ok(same.status === "valid");
  assert.equal(same.snapshot.activeTasks, null, "a declared-unreportable count never becomes 0");
  assert.equal(same.snapshot.busy, false, "the reportable category still landed");
  assert.deepEqual(same.snapshot.support, { tasks: "unsupported" });
  // A supported category keeps its observed zero.
  const reportable = readNativeStatusObservation({ activeTasks: 0, support: { tasks: "supported" } });
  assert.ok(reportable.status === "valid");
  assert.equal(reportable.snapshot.activeTasks, 0);
});

/* ------------------------------------------------------------------------- *
 * The manager's owner-bound seam
 * ------------------------------------------------------------------------- */

/** One synthetic owned child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 640_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  exited = false;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  readonly #errorListeners: ((error: Error) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose: () => { const i = this.#dataListeners.indexOf(listener); if (i >= 0) this.#dataListeners.splice(i, 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => { const i = this.#exitListeners.indexOf(listener); if (i >= 0) this.#exitListeners.splice(i, 1); } };
  }

  on(eventName: "error", listener: (error: Error) => void): void { assert.equal(eventName, "error"); this.#errorListeners.push(listener); }
  removeListener(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    const i = this.#errorListeners.indexOf(listener);
    if (i >= 0) this.#errorListeners.splice(i, 1);
  }

  write(data: string | Buffer): void { this.writes.push(data); }
  resize(columns: number, rows: number): void { this.cols = columns; this.rows = rows; }
  kill(): void { this.emitExit(0, 15); }
  pause(): void { /* observed elsewhere */ }
  resume(): void { /* observed elsewhere */ }

  emitData(data: string): void { for (const listener of [...this.#dataListeners]) listener(data); }
  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

/** A registrar that records every request, so a native row's silence is provable. */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];
  readonly handlers = new Map<string, InstanceStatusHandlers>();

  register(instanceId: string, handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.requests.push(instanceId);
    this.handlers.set(instanceId, handlers);
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: "ab".repeat(32),
        instanceId,
        generation: "00000000-0000-4000-8000-000000000001",
      },
      release: () => undefined,
    };
  }
}

interface Harness {
  root: string;
  workspace: string;
  manager: InstanceManager;
  registrar: RecordingRegistrar;
  spawned: SpyPty[];
}

function makeHarness(label: string): Harness {
  const root = realpathSync(mkdtempSync(join(process.cwd(), `.prg-native-status-${label}-`)));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture; not the production preload.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture for descriptor-only manager tests.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const agentDir = join(root, "native-agent");
  mkdirSync(agentDir, { recursive: true });
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const registrar = new RecordingRegistrar();
  const spawned: SpyPty[] = [];
  const provider: NativeCliLaunch = (backend, request) => ({
    file: `/synthetic/bin/${backend}`,
    args: ["--interactive"],
    env: { PATH: "/synthetic/bin", HOME: root },
    cwd: request.workspace,
  });
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: provider,
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });
  return { root, workspace, manager, registrar, spawned };
}

async function createRow(harness: Harness, backend: NativeCliBackend = "claude"): Promise<string> {
  const options: CreateInstanceOptions = { workspace: harness.workspace, backend };
  return await harness.manager.create(options);
}

function viewOf(harness: Harness, id: string): ReturnType<InstanceManager["list"]>[number] {
  const view = harness.manager.list().find((candidate) => candidate.id === id);
  assert.ok(view, `row ${id} is listed`);
  return view;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("only a live hosted run offers a status seam, and it is bound to that row's own run", async () => {
  const harness = makeHarness("binding");
  try {
    const rowId = await createRow(harness);
    assert.equal(harness.manager.nativeStatusCapture("no-such-row"), undefined, "no row, no seam");

    const seam = harness.manager.nativeStatusCapture(rowId);
    assert.ok(seam !== undefined, "a live hosted run offers its own status seam");
    assert.deepEqual({ rowId: seam.rowId, backend: seam.backend }, { rowId, backend: "claude" });
    assert.ok(Object.isFrozen(seam), "the seam handed to a host adapter is frozen");

    // A Pi row beside it keeps its exact behavior: no provider seam at all, and no
    // applicability on its view.
    const piId = await harness.manager.create({ workspace: harness.workspace });
    await settle();
    assert.equal(harness.manager.nativeStatusCapture(piId), undefined, "a Pi row has no provider status seam");
    assert.equal(Object.prototype.hasOwnProperty.call(viewOf(harness, piId), "statusSupport"), false,
      "a Pi row's view carries no applicability field at all");
    // The native row has declared nothing yet, so it too carries nothing: absence is
    // the legacy unknown path, not an inferred not-applicable.
    assert.equal(Object.prototype.hasOwnProperty.call(viewOf(harness, rowId), "statusSupport"), false);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an accepted observation reaches the row through the shared sink and never touches the ownership pair", async () => {
  const harness = makeHarness("accepted");
  try {
    const rowId = await createRow(harness);
    const seam = harness.manager.nativeStatusCapture(rowId)!;
    const accepted = seam.submit({
      busy: true,
      pendingInput: true,
      activity: ["bash · npm test", "read · src/index.ts"],
      activeTasks: 2,
      activeShells: 1,
      support: { tasks: "supported" },
    });
    assert.deepEqual(accepted, { accepted: true });
    const view = viewOf(harness, rowId);
    assert.equal(view.busy, true);
    assert.equal(view.pendingInput, true);
    assert.deepEqual(view.activity, ["bash · npm test", "read · src/index.ts"]);
    assert.equal(view.activeTasks, 2);
    assert.equal(view.activeShells, 1);
    assert.deepEqual(view.statusSupport, { tasks: "supported" });
    // The conservative OWNERSHIP pair stays unknown: a provider's own harness counts
    // are never this host's execution, review, or background-shell sources.
    assert.equal(view.backgroundTasks, null);
    assert.equal(view.backgroundShells, null);

    // Activity is sanitized by the existing sink, not by a native-side copy.
    seam.submit({ busy: true, activity: ["run\u001b[31m\u0007\nning tests"] });
    const sanitized = viewOf(harness, rowId).activity;
    assert.equal(sanitized.length, 1);
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(sanitized[0] ?? ""), false,
      `control bytes reached the sidebar sink: ${JSON.stringify(sanitized)}`);

    // A positively observed turn end is displayable on its own: busy false with the
    // background categories still unobserved, with no synthesized zero anywhere.
    seam.submit({ busy: false, pendingInput: false, activity: ["Ready"] });
    const idle = viewOf(harness, rowId);
    assert.equal(idle.busy, false);
    assert.deepEqual(idle.activity, ["Ready"]);
    assert.equal(idle.activeTasks, null, "no background zero is invented to force an idle reading");
    assert.equal(idle.activeShells, null);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a malformed observation changes nothing, and a refused category never becomes zero or idle", async () => {
  const harness = makeHarness("malformed");
  try {
    const rowId = await createRow(harness);
    const seam = harness.manager.nativeStatusCapture(rowId)!;
    assert.deepEqual(seam.submit({ busy: true, pendingInput: null, activity: ["Working"], activeTasks: 3 }), { accepted: true });
    const before = viewOf(harness, rowId);

    for (const bad of [
      { activeTasks: "3" },
      { activeTasks: -2 },
      { busy: "idle" },
      { activity: 7 },
      { backgroundTasks: 0 },
      { backgroundShells: 0 },
      { nativeSession: { sessionId: "s", epoch: 1, name: "n" } },
      "not-a-record",
      null,
      [],
    ]) {
      const result = seam.submit(bad as never);
      assert.deepEqual(result, { accepted: false, code: "malformed-observation" }, `${JSON.stringify(bad)} was refused`);
    }
    const after = viewOf(harness, rowId);
    assert.deepEqual(
      { busy: after.busy, pendingInput: after.pendingInput, activity: after.activity, activeTasks: after.activeTasks },
      { busy: before.busy, pendingInput: before.pendingInput, activity: before.activity, activeTasks: before.activeTasks },
      "a refused observation left every observed fact exactly where it was",
    );
    assert.equal(after.backgroundTasks, null, "a provider-submitted ownership count never entered the row");
    assert.equal(after.backgroundShells, null);

    // Declare a category unreportable, then try to report a value for it anyway.
    assert.deepEqual(seam.submit({ support: { shells: "unsupported" } }), { accepted: true });
    assert.deepEqual(seam.submit({ busy: true, activeShells: 0 }), { accepted: true });
    const held = viewOf(harness, rowId);
    assert.equal(held.activeShells, null, "a value for a declared-unreportable category is never applied");
    assert.deepEqual(held.statusSupport, { shells: "unsupported" });
    assert.equal(held.busy, true, "the rest of the snapshot still landed");
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an observer failure clears observed values to unknown and keeps the row's capabilities honest", async () => {
  const harness = makeHarness("invalidate");
  try {
    const rowId = await createRow(harness);
    const seam = harness.manager.nativeStatusCapture(rowId)!;
    assert.deepEqual(seam.submit({
      busy: false,
      pendingInput: false,
      activity: ["Ready"],
      activeTasks: 0,
      activeShells: 0,
      support: { tasks: "supported", shells: "unsupported", input: "unsupported" },
    }), { accepted: true });
    const good = viewOf(harness, rowId);
    assert.equal(good.busy, false);
    assert.equal(good.activeTasks, 0);

    assert.deepEqual(seam.invalidate(), { accepted: true });
    const cleared = viewOf(harness, rowId);
    // Every observed value is unknown again — not a stale Ready, not a zero.
    assert.equal(cleared.busy, null);
    assert.equal(cleared.pendingInput, null);
    assert.equal(cleared.activeTasks, null);
    assert.equal(cleared.activeShells, null);
    assert.deepEqual(cleared.activity, []);
    // The capability statement is a fact about the backend, not about this
    // observation, so it survives.
    assert.deepEqual(cleared.statusSupport, { tasks: "supported", shells: "unsupported", input: "unsupported" });
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an accepted invalidation retires its capture generation so late callbacks cannot restore values", async () => {
  const harness = makeHarness("retire");
  try {
    const rowId = await createRow(harness);
    const first = harness.manager.nativeStatusCapture(rowId)!;
    assert.deepEqual(first.submit({
      busy: false,
      pendingInput: false,
      activity: ["Ready"],
      activeTasks: 0,
      activeShells: 0,
    }), { accepted: true });

    // A second capture minted from the SAME live generation is retired together with the
    // first: an observer failure is a fact about the run's observation, not one object.
    const sibling = harness.manager.nativeStatusCapture(rowId)!;

    assert.deepEqual(first.invalidate(), { accepted: true });
    const cleared = viewOf(harness, rowId);
    assert.equal(cleared.busy, null);
    assert.deepEqual(cleared.activity, []);

    // The delayed pre-failure callbacks of the retired generation are all refused, and
    // none of them restores a value: no stale Ready, no stale pending prompt, no stale
    // count, and no re-clearing churn either.
    for (const stale of [first, sibling]) {
      assert.deepEqual(
        stale.submit({ busy: false, pendingInput: false, activity: ["Ready"], activeTasks: 0, activeShells: 0 }),
        { accepted: false, code: "retired-capture" },
      );
      assert.deepEqual(stale.invalidate(), { accepted: false, code: "retired-capture" });
    }
    const stillClean = viewOf(harness, rowId);
    assert.equal(stillClean.busy, null, "a retired submit cannot restore a stale Ready");
    assert.equal(stillClean.pendingInput, null, "a retired submit cannot restore a stale pending prompt");
    assert.equal(stillClean.activeTasks, null, "a retired submit cannot restore a stale count");
    assert.equal(stillClean.activeShells, null, "a retired submit cannot restore a stale count");
    assert.deepEqual(stillClean.activity, []);

    // Recovery is real: the run is still live (nothing about the child changed), so a
    // freshly acquired capture binds the current generation and genuinely fresh
    // observations land again.
    const recovered = harness.manager.nativeStatusCapture(rowId)!;
    assert.notEqual(recovered, first);
    assert.deepEqual(recovered.submit({ busy: true, activeTasks: 2, activeShells: 0 }), { accepted: true });
    const back = viewOf(harness, rowId);
    assert.equal(back.busy, true);
    assert.equal(back.activeTasks, 2);
    assert.equal(back.activeShells, 0);

    // A retired capture still cannot act after recovery either, and a second honest
    // failure retires the recovered generation the same way.
    assert.deepEqual(first.submit({ busy: false }), { accepted: false, code: "retired-capture" });
    assert.deepEqual(recovered.invalidate(), { accepted: true });
    assert.deepEqual(recovered.submit({ busy: false, activeTasks: 0 }), {
      accepted: false,
      code: "retired-capture",
    });
    const clearedAgain = viewOf(harness, rowId);
    assert.equal(clearedAgain.busy, null);
    assert.equal(clearedAgain.activeTasks, null);
    assert.ok(harness.manager.nativeStatusCapture(rowId), "the live row can still arm a fresh capture");
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a replaced, exited, or disposed run never accepts old observer data", async () => {
  const harness = makeHarness("stale");
  try {
    const rowId = await createRow(harness);
    const seam = harness.manager.nativeStatusCapture(rowId)!;
    assert.deepEqual(seam.submit({ busy: true, activity: ["Working"] }), { accepted: true });

    // The child exits: the row's own observed values go with it, and the seam of
    // that incarnation can never put them back.
    const pty = harness.spawned.at(-1)!;
    pty.emitExit(0, 15);
    await settle();
    const exited = viewOf(harness, rowId);
    assert.equal(exited.lifecycle, "exited");
    assert.equal(exited.busy, null);
    assert.deepEqual(exited.activity, []);
    assert.equal(harness.manager.nativeStatusCapture(rowId), undefined, "an exited row offers no seam");
    assert.deepEqual(seam.submit({ busy: false, activity: ["Ready"] }), { accepted: false, code: "no-live-run" });
    assert.deepEqual(seam.invalidate(), { accepted: false, code: "no-live-run" });
    assert.equal(viewOf(harness, rowId).busy, null, "a stale callback restored nothing");

    // A new hosted row is a new run: the old seam is not its seam.
    const nextRow = await createRow(harness);
    assert.equal(harness.manager.nativeStatusCapture(nextRow)!.rowId, nextRow);
    assert.deepEqual(seam.submit({ busy: true }), { accepted: false, code: "no-live-run" });
    const fresh = viewOf(harness, nextRow);
    assert.equal(fresh.busy, null, "a replacement child inherits no observer data");
    assert.equal(Object.prototype.hasOwnProperty.call(fresh, "statusSupport"), false);

    // Disposal closes the door on the live seam too.
    const liveSeam = harness.manager.nativeStatusCapture(nextRow)!;
    assert.deepEqual(liveSeam.submit({ busy: true }), { accepted: true });
    await harness.manager.dispose();
    assert.deepEqual(liveSeam.submit({ busy: false }), { accepted: false, code: "no-live-run" });
    rmSync(harness.root, { recursive: true, force: true });
    return;
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a stopping hosted row refuses observer data and keeps requiring an explicit stop", async () => {
  const harness = makeHarness("stop-authority");
  try {
    const rowId = await createRow(harness);
    const seam = harness.manager.nativeStatusCapture(rowId)!;
    // Even a fully observed, fully idle-looking foreground with the provider's own
    // background counts at zero cannot make a hosted row safe to stop: the
    // conservative ownership pair is unknown, and it stays unknown.
    assert.deepEqual(seam.submit({
      busy: false, pendingInput: false, activeTasks: 0, activeShells: 0, activity: ["Ready"],
    }), { accepted: true });
    const view = viewOf(harness, rowId);
    assert.equal(view.busy, false);
    assert.equal(view.activeTasks, 0);
    assert.equal(view.backgroundTasks, null);
    assert.equal(view.backgroundShells, null);
    assert.deepEqual(await harness.manager.stop(rowId, { confirmed: false }), {
      status: "confirmation-required", forced: false,
    }, "a hosted provider row always requires its explicit stop confirmation");

    // The refused preflight did not fabricate anything either.
    const after = viewOf(harness, rowId);
    assert.equal(after.busy, false);
    assert.equal(after.backgroundTasks, null);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the Pi status path is unchanged and never gains an applicability field", async () => {
  const harness = makeHarness("pi-unchanged");
  try {
    const piId = await harness.manager.create({ workspace: harness.workspace });
    await settle();
    const handlers = harness.registrar.handlers.get(piId);
    assert.ok(handlers !== undefined, "the Pi row registered exactly as before");
    const update: InstanceStatusUpdate = {
      busy: false,
      pendingInput: false,
      inputSurface: false,
      backgroundTasks: 0,
      backgroundShells: 0,
      activeTasks: 0,
      activeShells: 0,
      activity: ["Ready"],
    };
    handlers!.onStatus(update);
    const view = viewOf(harness, piId);
    assert.equal(view.busy, false);
    assert.equal(view.pendingInput, false);
    assert.equal(view.activeTasks, 0);
    assert.equal(view.activeShells, 0);
    assert.deepEqual(view.activity, ["Ready"]);
    assert.equal(Object.prototype.hasOwnProperty.call(view, "statusSupport"), false,
      "a Pi row's view is byte-compatible with the pre-native shape");

    // Its registration's failure paths stay unknown, exactly as before, and a native
    // seam never existed for it to be confused with.
    handlers!.onDisconnect();
    const disconnected = viewOf(harness, piId);
    assert.equal(disconnected.busy, null);
    assert.equal(disconnected.activeTasks, null);
    assert.equal(harness.manager.nativeStatusCapture(piId), undefined);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});
