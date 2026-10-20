/**
 * Focused tests for the InstanceManager's native clipboard routing (#466).
 *
 * Evidence scope: capsules are produced by the shared authenticated encoder
 * against a synthetic registration bootstrap, and children are synthetic PTYs
 * whose output is an ordinary string. These cases prove per-row receiver
 * binding, sequence/generation/instance authentication as observed through the
 * manager, the live-record/registration/stop/lifecycle/native-tuple fence, and
 * that no capsule or payload text ever reaches a frame or a view. They make no
 * claim about the real broker's socket authentication, the native producer's
 * source-stack provenance, a real terminal's OSC 52 permission, or any physical
 * clipboard — none of those is touched here.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusBootstrap,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type PtyFactory,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { ProfileRegistry } from "../src/session-host/profiles";
import {
  encodeNativeClipboardCapsule,
  NATIVE_CLIPBOARD_OSC,
  type NativeClipboardEvent,
} from "../src/session-host/native-clipboard";
import type { SessionHostBootstrap, SessionHostNativeSession } from "../src/session-host/protocol";

const ESC = "\x1b";
const BEL = "\x07";

function makeTestRoot(label: string): string {
  return realpathSync(mkdtempSync(join(process.cwd(), `.prg-native-clipboard-${label}-`)));
}

function osc(capsule: string): string {
  return `${ESC}]${NATIVE_CLIPBOARD_OSC};${capsule}${BEL}`;
}

function encodedText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

type CopyEvent = Extract<NativeClipboardEvent, { kind: "copy" }>;

function copyEvent(text: string, sessionId: string, sessionEpoch: number): CopyEvent {
  return { kind: "copy", encoded: encodedText(text), sessionId, sessionEpoch };
}

type Route = (instanceId: string, event: NativeClipboardEvent) => void;

function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

class FakePty implements InstancePty {
  static #nextPid = 910_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly killSignals: string[] = [];
  readonly writes: (string | Buffer)[] = [];
  /** Production stop paths signal the child; this fake can model a stubborn one. */
  exitsOnKill = true;
  #exited = false;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  readonly #errorListeners: ((error: Error) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = FakePty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
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

  on(_eventName: "error", listener: (error: Error) => void): unknown {
    this.#errorListeners.push(listener);
    return this;
  }

  removeListener(_eventName: "error", listener: (error: Error) => void): unknown {
    const index = this.#errorListeners.indexOf(listener);
    if (index >= 0) this.#errorListeners.splice(index, 1);
    return this;
  }

  write(data: string | Buffer): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }

  kill(signal?: string): void {
    this.killSignals.push(signal ?? "SIGTERM");
    if (this.exitsOnKill) this.emitExit(0);
  }

  pause(): void {}
  resume(): void {}

  emitData(data: string): void {
    for (const listener of [...this.#dataListeners]) listener(data);
  }

  emitExit(exitCode = 0): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal: 0 });
  }
}

interface RegistrarRow {
  readonly instanceId: string;
  readonly bootstrap: InstanceStatusBootstrap;
  readonly handlers: InstanceStatusHandlers;
  released: boolean;
}

class FakeRegistrar implements StatusRegistrar {
  readonly rows: RegistrarRow[] = [];
  generation = randomUUID();

  register(instanceId: string, handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    const bootstrap: InstanceStatusBootstrap = {
      version: 1,
      socketPath: `/synthetic/${instanceId}.sock`,
      // Production tokens are 32 random bytes in hex; the capsule HMAC key is
      // derived from exactly that shape.
      token: randomBytes(32).toString("hex"),
      instanceId,
      generation: this.generation,
    };
    const row: RegistrarRow = { instanceId, bootstrap, handlers, released: false };
    this.rows.push(row);
    return { bootstrap, release: () => { row.released = true; } };
  }

  rowFor(instanceId: string): RegistrarRow {
    const row = this.rows.find((candidate) => candidate.instanceId === instanceId);
    assert.ok(row, `registrar has no row for ${instanceId}`);
    return row;
  }
}

interface Harness {
  root: string;
  workspace: string;
  registrar: FakeRegistrar;
  spawned: FakePty[];
  routes: { instanceId: string; event: NativeClipboardEvent }[];
  manager: InstanceManager;
  close(): Promise<void>;
}

function makeHarness(label: string, options: { route?: Route } = {}): Harness {
  const root = makeTestRoot(label);
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// inert fixture\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// inert fixture\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// inert fixture\n", "utf8");
  for (const skill of [
    "pi-review-gate-orchestrator",
    "pi-review-gate-execution",
    "pi-review-gate-research",
    "pi-review-gate-completion",
  ]) {
    const dir = join(packageRoot, "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `${skill}/SKILL.md\n`, "utf8");
  }
  const references = join(packageRoot, "skills", "pi-review-gate-orchestrator", "references");
  mkdirSync(references, { recursive: true });
  writeFileSync(join(references, "recovery.md"), "recovery\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const registrar = new FakeRegistrar();
  const spawned: FakePty[] = [];
  const ptyFactory: PtyFactory = (descriptor) => {
    const pty = new FakePty(descriptor);
    spawned.push(pty);
    return pty;
  };
  const routes: { instanceId: string; event: NativeClipboardEvent }[] = [];
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
  delete env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG;
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    nativeSetup: false,
    profileRegistry: new ProfileRegistry({ stateRoot: join(root, "state") }),
    args: [],
    env,
    ptyFactory,
    ...(options.route === undefined ? {} : { onNativeClipboard: options.route }),
  });
  return {
    root,
    workspace,
    registrar,
    spawned,
    routes,
    manager,
    async close() {
      await manager.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Row {
  readonly id: string;
  readonly pty: FakePty;
  readonly bootstrap: InstanceStatusBootstrap;
}

async function createRow(harness: Harness, sessionId: string | null, epoch = 1): Promise<Row> {
  const id = await harness.manager.create({ workspace: harness.workspace } satisfies CreateInstanceOptions);
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "creating a row spawns its owned child");
  const row = harness.registrar.rowFor(id);
  if (sessionId !== null) {
    row.handlers.onStatus(statusWith(sessionId, epoch));
  }
  await settle();
  return { id, pty, bootstrap: row.bootstrap };
}

function statusWith(sessionId: string, epoch: number): InstanceStatusUpdate {
  const nativeSession: SessionHostNativeSession = { sessionId, epoch, name: `Conversation ${sessionId}` };
  return { busy: false, pendingInput: false, inputSurface: true, activity: [], nativeSession };
}

async function sendCapsule(harness: Harness, row: Row, capsule: string): Promise<void> {
  row.pty.emitData(osc(capsule));
  await harness.manager.surface(row.id)?.flush();
  await settle();
}

function capsuleFor(bootstrap: InstanceStatusBootstrap, sequence: number, event: NativeClipboardEvent): string {
  return encodeNativeClipboardCapsule(bootstrap as SessionHostBootstrap, sequence, event);
}

function rendered(harness: Harness, id: string): string {
  return harness.manager.surface(id)?.frame().lines.join("\n") ?? "";
}

test("a verified capsule routes once to its exact live row and never reaches frame text", async () => {
  const harness = makeHarness("route", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, "conversation-alpha");
    const event = copyEvent("selected\ttext\nsecond line — ünïcödé", "conversation-alpha", 1);
    const capsule = capsuleFor(row.bootstrap, 1, event);
    await sendCapsule(harness, row, capsule);
    assert.deepEqual(harness.routes, [{ instanceId: row.id, event }]);
    const frame = rendered(harness, row.id);
    assert.ok(!frame.includes(capsule), "the capsule never renders");
    assert.ok(!frame.includes(event.encoded), "the encoded payload never renders");
    assert.ok(!frame.includes("prg-native-copy-v1"), "the capsule prefix never renders");
    assert.ok(!JSON.stringify(harness.manager.list()).includes(capsule), "no view carries capsule text");
  } finally {
    await harness.close();
  }
});

test("replayed and descending sequences are refused while a strictly newer sequence routes", async () => {
  const harness = makeHarness("replay", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, "conversation-alpha");
    const event = copyEvent("copy me", "conversation-alpha", 1);
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 5, event));
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 5, event));
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 4, event));
    assert.equal(harness.routes.length, 1, "one sequence routes exactly once");
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 6, event));
    assert.equal(harness.routes.length, 2, "a strictly newer sequence still routes");
  } finally {
    await harness.close();
  }
});

test("a sequence is consumed even when the host rejects the event, so it can never be retried", async () => {
  const harness = makeHarness("consumed", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    // The row's current conversation is epoch 1; this capsule claims epoch 2.
    const row = await createRow(harness, "conversation-alpha", 1);
    const future = copyEvent("not yet current", "conversation-alpha", 2);
    const rejected = capsuleFor(row.bootstrap, 1, future);
    await sendCapsule(harness, row, rejected);
    assert.deepEqual(harness.routes, [], "a tuple the row does not currently report is refused");
    // The row now really reports epoch 2, but the same sequence stays consumed.
    row.pty;
    harness.registrar.rowFor(row.id).handlers.onStatus(statusWith("conversation-alpha", 2));
    await settle();
    await sendCapsule(harness, row, rejected);
    assert.deepEqual(harness.routes, [], "a refused sequence can never be replayed after state changes");
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 2, future));
    assert.deepEqual(harness.routes, [{ instanceId: row.id, event: future }], "the next sequence routes");
  } finally {
    await harness.close();
  }
});

test("foreign token, foreign instance, stale generation, and malformed capsules never route", async () => {
  const harness = makeHarness("forged", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, "conversation-alpha");
    const event = copyEvent("forged copy", "conversation-alpha", 1);
    const foreignToken: InstanceStatusBootstrap = { ...row.bootstrap, token: randomBytes(32).toString("hex") };
    const foreignInstance: InstanceStatusBootstrap = { ...row.bootstrap, instanceId: `other-${randomUUID()}` };
    const staleGeneration: InstanceStatusBootstrap = { ...row.bootstrap, generation: randomUUID() };
    await sendCapsule(harness, row, capsuleFor(foreignToken, 1, event));
    await sendCapsule(harness, row, capsuleFor(foreignInstance, 2, event));
    await sendCapsule(harness, row, capsuleFor(staleGeneration, 3, event));
    await sendCapsule(harness, row, "prg-native-copy-v1;bogus;deadbeef");
    await sendCapsule(harness, row, osc("prg-native-copy-v1;bogus;deadbeef"));
    await sendCapsule(harness, row, "");
    assert.deepEqual(harness.routes, [], "no unauthenticated capsule reaches host routing");
    // The row's own authenticated capsule still routes afterwards.
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 4, event));
    assert.deepEqual(harness.routes, [{ instanceId: row.id, event }]);
  } finally {
    await harness.close();
  }
});

test("one row's capsule never routes through a sibling's receiver", async () => {
  const harness = makeHarness("sibling", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const first = await createRow(harness, "conversation-one");
    const second = await createRow(harness, "conversation-two");
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.bootstrap.token, second.bootstrap.token);
    const event = copyEvent("first row selection", "conversation-one", 1);
    const capsule = capsuleFor(first.bootstrap, 1, event);
    // Row A's authenticated capsule delivered into row B's child output.
    await sendCapsule(harness, second, capsule);
    assert.deepEqual(harness.routes, [], "row B's receiver rejects row A's capsule");
    // Row B's own capsule for row A's conversation is refused by the tuple fence.
    await sendCapsule(harness, second, capsuleFor(second.bootstrap, 1, event));
    assert.deepEqual(harness.routes, [], "row B never routes another conversation's request");
    await sendCapsule(harness, first, capsule);
    assert.deepEqual(harness.routes, [{ instanceId: first.id, event }], "row A still routes its own request");
  } finally {
    await harness.close();
  }
});

test("a stale native tuple routes nothing while the row's current conversation still routes", async () => {
  const harness = makeHarness("tuple", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, "conversation-alpha", 1);
    const staleEpoch = copyEvent("stale epoch", "conversation-alpha", 1);
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 1, staleEpoch));
    assert.equal(harness.routes.length, 1);
    // The child moved to a newer conversation; the older request is now stale.
    harness.registrar.rowFor(row.id).handlers.onStatus(statusWith("conversation-alpha", 2));
    await settle();
    const otherConversation = copyEvent("other conversation", "conversation-other", 2);
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 2, staleEpoch));
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 3, otherConversation));
    assert.equal(harness.routes.length, 1, "neither a stale epoch nor a foreign conversation routes");
    const current = copyEvent("current", "conversation-alpha", 2);
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 4, current));
    assert.deepEqual(harness.routes[1], { instanceId: row.id, event: current });
  } finally {
    await harness.close();
  }
});

test("a row with no observed native conversation routes nothing", async () => {
  const harness = makeHarness("no-tuple", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, null);
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 1, copyEvent("x", "conversation-x", 1)));
    assert.deepEqual(harness.routes, []);
    assert.equal(harness.manager.list().find((view) => view.id === row.id)?.nativeSession, null);
  } finally {
    await harness.close();
  }
});

test("an exited child, a closed row, shutdown, and dispose all stop routing", async () => {
  const harness = makeHarness("lifecycle", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, "conversation-alpha");
    const event = copyEvent("after exit", "conversation-alpha", 1);
    const capsule = capsuleFor(row.bootstrap, 1, event);
    await sendCapsule(harness, row, capsule);
    assert.equal(harness.routes.length, 1, "routing works while the owned child is alive");

    row.pty.emitExit(0);
    await settle();
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 2, event));
    assert.equal(harness.routes.length, 1, "an exited owned process routes nothing");

    assert.equal(harness.manager.closeExited(row.id), true);
    row.pty.emitData(osc(capsuleFor(row.bootstrap, 3, event)));
    await settle();
    assert.equal(harness.routes.length, 1, "a closed row's late child output routes nothing");

    const next = await createRow(harness, "conversation-beta");
    await sendCapsule(harness, next, capsuleFor(next.bootstrap, 1, copyEvent("beta", "conversation-beta", 1)));
    assert.equal(harness.routes.length, 2, "the live row still routes before shutdown");
    await harness.manager.shutdown();
    await sendCapsule(harness, next, capsuleFor(next.bootstrap, 2, copyEvent("beta", "conversation-beta", 1)));
    assert.equal(harness.routes.length, 2, "a stopping manager routes nothing");
    await harness.manager.dispose();
    next.pty.emitData(osc(capsuleFor(next.bootstrap, 3, copyEvent("beta", "conversation-beta", 1))));
    await settle();
    assert.equal(harness.routes.length, 2, "a disposed manager routes nothing");
    rmSync(harness.root, { recursive: true, force: true });
  } catch (error) {
    rmSync(harness.root, { recursive: true, force: true });
    throw error;
  }
});

test("a row whose stop admission is closed routes nothing", async () => {
  const harness = makeHarness("stop-admission", { route: (instanceId, event) => harness.routes.push({ instanceId, event }) });
  try {
    const row = await createRow(harness, "conversation-alpha");
    row.pty.exitsOnKill = false;
    const stopping = harness.manager.stop(row.id, { confirmed: true });
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 1, copyEvent("while stopping", "conversation-alpha", 1)));
    assert.deepEqual(harness.routes, [], "closed stop admission routes nothing");
    assert.ok(row.pty.killSignals.length > 0, "the owned stop path actually engaged this child");
    row.pty.exitsOnKill = true;
    row.pty.emitExit(0);
    await stopping;
    await harness.close();
  } catch (error) {
    rmSync(harness.root, { recursive: true, force: true });
    throw error;
  }
});

test("without a host route the capsule stays swallowed and the row is unaffected", async () => {
  const harness = makeHarness("no-route");
  try {
    const row = await createRow(harness, "conversation-alpha");
    row.pty.emitData("visible output\n");
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 1, copyEvent("ignored", "conversation-alpha", 1)));
    assert.deepEqual(harness.routes, []);
    const view = harness.manager.list().find((candidate) => candidate.id === row.id);
    assert.equal(view?.lifecycle, "alive", "the row keeps running");
    const frame = rendered(harness, row.id);
    assert.ok(frame.includes("visible output"), "ordinary parsing is unchanged");
    assert.ok(!frame.includes("prg-native-copy-v1"));
    // Query replies still return only to this row's own child.
    row.pty.emitData(`${ESC}[?u`);
    await harness.manager.surface(row.id)?.flush();
    assert.ok(
      row.pty.writes.some((write) => String(write).includes("[?0u")),
      "the surface's query reply still goes back to its own child",
    );
    assert.ok(!rendered(harness, row.id).includes("?u"), "the reply never renders");
  } finally {
    await harness.close();
  }
});

test("a throwing host route is contained and the row keeps parsing", async () => {
  const harness = makeHarness("throwing-route", {
    route: () => {
      throw new Error("synthetic host clipboard failure");
    },
  });
  try {
    const row = await createRow(harness, "conversation-alpha");
    row.pty.emitData("before capsule\n");
    await harness.manager.surface(row.id)?.flush();
    await sendCapsule(harness, row, capsuleFor(row.bootstrap, 1, copyEvent("boom", "conversation-alpha", 1)));
    row.pty.emitData("after capsule\n");
    await harness.manager.surface(row.id)?.flush();
    await settle();
    const frame = rendered(harness, row.id);
    assert.ok(frame.includes("before capsule") && frame.includes("after capsule"), "parsing survives a throwing route");
    assert.ok(!frame.includes("prg-native-copy-v1"));
    assert.equal(harness.manager.list().find((view) => view.id === row.id)?.lifecycle, "alive");
  } finally {
    await harness.close();
  }
});
