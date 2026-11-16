import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  isNativeViewerNativeCliInputSource,
  isNativeViewerStartupInputSource,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeViewerAnyInputSource,
  type NativeViewerClipboardReceipt,
  type NativeViewerNativeCliClipboardReceipt,
  type NativeViewerInputRequest,
  type NativeViewerNativeCliInputSource,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { parseNativeViewerScopeToken } from "../src/session-host/native-input-origin";
import type { TerminalInputModes } from "../src/session-host/terminal-surface";

/**
 * Focused manager coverage for remote native CLI input (issue 277 native
 * remote-input slice): the host-side half of "a viewer controls one hosted
 * provider terminal".
 *
 * EVIDENCE SCOPE: every child here is a synthetic PTY and every launch descriptor
 * comes from an injected test provider. Nothing runs a real Claude or Codex binary,
 * reads or writes any provider's real configuration, credentials, or conversations,
 * or proves what a real provider TUI does with a byte. What it does prove is the
 * manager contract: a hosted provider row's input source is a separate `native-cli`
 * variant naming its recorded backend and nothing else; its bytes reach exactly the
 * one owned PTY and arrive RAW (no Pi framing, no encoder, no child-side fence); the
 * Pi row's framed input path is byte-for-byte unchanged beside it; and a stale,
 * retired, cross-row, mode-changed, stopped, or exited target writes nothing.
 */

/** One synthetic owned child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 940_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
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

  on(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    this.#errorListeners.push(listener);
  }

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

  exited = false;

  /** Everything this child was ever handed, as one string, for framing checks. */
  writtenText(): string {
    return this.writes.map((entry) => (typeof entry === "string" ? entry : entry.toString("utf8"))).join("");
  }
}

/** A registrar that records every request, so a native row's silence is provable. */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(instanceId: string, _handlers: InstanceStatusHandlers, options?: { inputOriginFraming?: boolean }): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: "ab".repeat(32),
        instanceId,
        generation: "00000000-0000-4000-8000-000000000001",
        ...(options?.inputOriginFraming === true ? { inputOriginFraming: 1 as const } : {}),
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
  copies: Array<NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt>;
}

/**
 * A real InstanceManager over synthetic fixtures, with input framing opted in so a
 * Pi row beside a native row keeps its exact framed behavior.
 */
function makeHarness(label: string): Harness {
  const root = realpathSync(mkdtempSync(join(process.cwd(), `.prg-native-cli-input-${label}-`)));
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
  const copies: Array<NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt> = [];
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
    nativeInputOriginFraming: true,
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });
  return { root, workspace, manager, registrar, spawned, copies };
}

const HOST_RUN = "run-7a51";

/** Register one surface that carries this host's own run identity. */
function openSurface(harness: Harness): string {
  const viewer = harness.manager.openViewer({
    hostRunId: HOST_RUN,
    nativeClipboardSink: (receipt) => { harness.copies.push(receipt); },
  });
  assert.ok(viewer, "the manager must accept a surface registration");
  return viewer.viewerId;
}

async function createRow(harness: Harness, backend: "claude" | "codex"): Promise<string> {
  const options: CreateInstanceOptions = { workspace: harness.workspace, backend };
  return await harness.manager.create(options);
}

function lastPty(harness: Harness): SpyPty {
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "a launched row owns its PTY");
  return pty;
}

function ptyOf(harness: Harness, backend: "claude" | "codex"): SpyPty {
  const pty = harness.spawned.find((candidate) => candidate.spawnDescriptor.file.endsWith(backend));
  assert.ok(pty, `a ${backend} child was spawned`);
  return pty;
}

function modesOf(harness: Harness, rowId: string): TerminalInputModes {
  const surface = harness.manager.surface(rowId);
  assert.ok(surface, "a launched row owns its terminal surface");
  return surface.inputModes();
}

/** Read one surface's current scope and require the hosted native CLI variant. */
function nativeScope(harness: Harness, viewerId: string, expectedBackend: "claude" | "codex"): NativeViewerNativeCliInputSource {
  const scope = harness.manager.readViewerInputSource(viewerId);
  assert.ok(scope !== undefined, "a live hosted row has a current input scope");
  assert.equal(isNativeViewerNativeCliInputSource(scope), true, "a hosted provider row states the native CLI variant");
  assert.equal(isNativeViewerStartupInputSource(scope), false);
  const native = scope as NativeViewerNativeCliInputSource;
  assert.equal(native.phase, "native-cli");
  assert.equal(native.backend, expectedBackend);
  assert.equal(native.hostRunId, HOST_RUN);
  assert.match(native.sourceToken, /^nvcli1\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[0-9a-f]{32}$/);
  // Closed shape: no conversation, no registration, no PID, no path, no command.
  assert.deepEqual(Object.keys(native).sort(), [
    "backend", "geometry", "hostRunId", "phase", "rowId", "sourceToken", "viewerId", "viewerRevision",
  ]);
  return native;
}

function request(source: NativeViewerAnyInputSource, modes: TerminalInputModes, data: string): NativeViewerInputRequest {
  return { expectedSource: source, expectedInputModes: modes, data };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for an asynchronous surface fact without asserting on a race. */
async function untilTrue(read: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (read()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await sleep(10);
  }
}

test("two hosted provider rows each state their own native CLI source and receive only their own raw bytes", async () => {
  const harness = makeHarness("two-rows");
  try {
    const claudeId = await createRow(harness, "claude");
    const codexId = await createRow(harness, "codex");
    const claudeViewer = openSurface(harness);
    const codexViewer = openSurface(harness);
    assert.equal(harness.manager.updateViewer(claudeViewer, { sessionId: claudeId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.updateViewer(codexViewer, { sessionId: codexId, cols: 80, rows: 24 }).applied, true);

    const claudeSource = nativeScope(harness, claudeViewer, "claude");
    const codexSource = nativeScope(harness, codexViewer, "codex");
    assert.equal(claudeSource.rowId, claudeId);
    assert.equal(codexSource.rowId, codexId);
    assert.notEqual(claudeSource.sourceToken, codexSource.sourceToken);

    // Keyboard bytes go to exactly the addressed child, RAW: the write the child sees
    // is the byte string the caller handed over, with no framing of any kind.
    const keystroke = "a";
    assert.deepEqual(harness.manager.writeViewerInput(claudeViewer, request(
      claudeSource, modesOf(harness, claudeId), keystroke,
    )), { status: "submitted" });
    const claudePty = ptyOf(harness, "claude");
    const codexPty = ptyOf(harness, "codex");
    assert.deepEqual(claudePty.writes, [keystroke], "one raw write, byte-exact, to the addressed child only");
    assert.deepEqual(codexPty.writes, [], "the sibling provider child receives nothing");

    // A full bracketed-paste body and a canonical SGR mouse report stay byte-exact:
    // no Pi framing, no encoder, and no re-encoding happens on this path.
    const paste = "\u001b[200~multi\nline\u001b[201~";
    const mouse = "\u001b[<0;4;7M";
    assert.deepEqual(harness.manager.writeViewerInput(codexViewer, request(
      codexSource, modesOf(harness, codexId), paste,
    )), { status: "submitted" });
    assert.deepEqual(harness.manager.writeViewerInput(codexViewer, request(
      codexSource, modesOf(harness, codexId), mouse,
    )), { status: "submitted" });
    assert.deepEqual(codexPty.writes, [paste, mouse], "paste and mouse bytes are handed over unchanged");
    assert.equal(claudePty.writtenText().includes("prg-ni-v2;"), false, "no Pi input framing exists on a provider child");
    assert.equal(codexPty.writtenText().includes("prg-ni-v2;"), false);

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a Pi row keeps its framed viewer input while a hosted provider row stays raw", async () => {
  const harness = makeHarness("pi-vs-native");
  try {
    const piId = await harness.manager.create({ workspace: harness.workspace });
    const claudeId = await createRow(harness, "claude");
    const piViewer = openSurface(harness);
    const claudeViewer = openSurface(harness);
    assert.equal(harness.manager.updateViewer(piViewer, { sessionId: piId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.updateViewer(claudeViewer, { sessionId: claudeId, cols: 80, rows: 24 }).applied, true);

    // The Pi row is not framed yet: its registration exists but its readiness capsule
    // has not been verified, so a framed viewer write is refused rather than raw.
    const piScope = harness.manager.readViewerInputSource(piViewer);
    assert.equal(piScope, undefined, "a Pi row with unverified framing states no input scope");
    const claudeSource = nativeScope(harness, claudeViewer, "claude");

    // Cross-target refusals: a provider source is never accepted for a Pi surface,
    // and a Pi surface's address never carries provider bytes.
    const refused = harness.manager.writeViewerInput(piViewer, request(
      claudeSource, modesOf(harness, claudeId), "x",
    ));
    assert.equal(refused.status, "refused");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("stale, retired, mode-changed, stopped, and exited native targets write nothing", async () => {
  const harness = makeHarness("staleness");
  try {
    const rowId = await createRow(harness, "claude");
    const viewerId = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewerId, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const source = nativeScope(harness, viewerId, "claude");
    const modes = modesOf(harness, rowId);
    const pty = lastPty(harness);

    // A viewer change (selecting another row and back, or a pane change) is a real
    // boundary even when the row's canonical geometry never moved.
    const otherId = await createRow(harness, "claude");
    assert.equal(harness.manager.updateViewer(viewerId, { sessionId: otherId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.updateViewer(viewerId, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(source, modes, "a")),
      { status: "refused", reason: "stale-source" }, "an A -> B -> A viewer change never revives the old source");
    assert.deepEqual(pty.writes, []);

    // A canonical geometry change, and an A -> B -> A return to the original size,
    // are both refusals: the revision is part of the identity.
    const current = nativeScope(harness, viewerId, "claude");
    assert.equal(harness.manager.resizeInstance(rowId, 90, 30), true);
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(current, modes, "a")),
      { status: "refused", reason: "stale-source" });
    assert.equal(harness.manager.resizeInstance(rowId, 80, 24), true);
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(current, modes, "a")),
      { status: "refused", reason: "stale-source" }, "an A -> B -> A geometry change is still a change");
    assert.deepEqual(pty.writes, []);

    // A mode change means the same bytes mean something else.
    const afterGeometry = nativeScope(harness, viewerId, "claude");
    pty.emitData("\u001b[?2004h");
    await untilTrue(() => modesOf(harness, rowId).bracketedPaste !== modes.bracketedPaste,
      "the child's own bracketed-paste mode change is observable");
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(afterGeometry, modes, "a")),
      { status: "refused", reason: "stale-input-modes" });
    assert.deepEqual(pty.writes, []);
    pty.emitData("\u001b[?2004l");
    await untilTrue(() => modesOf(harness, rowId).bracketedPaste === modes.bracketedPaste,
      "the mode returns to what the source was observed under");

    // A backend the row never recorded, or a token from elsewhere, is a stale source:
    // a well-formed forged object is refused before the PTY, not honored.
    const fresh = nativeScope(harness, viewerId, "claude");
    const forged: NativeViewerNativeCliInputSource = Object.freeze({
      ...fresh,
      sourceToken: `nvcli1.${fresh.viewerId}.${randomBytes(16).toString("hex")}`,
    });
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(forged, modesOf(harness, rowId), "a")),
      { status: "refused", reason: "stale-source" });
    const wrongBackend = Object.freeze({ ...fresh, backend: "codex" as const });
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(wrongBackend as unknown as NativeViewerAnyInputSource, modesOf(harness, rowId), "a")),
      { status: "refused", reason: "stale-source" });
    assert.deepEqual(pty.writes, []);

    // A retired surface has no scope and writes nothing.
    assert.equal(harness.manager.closeViewer(viewerId), true);
    assert.equal(harness.manager.readViewerInputSource(viewerId), undefined);
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(fresh, modesOf(harness, rowId), "a")),
      { status: "refused", reason: "unknown-viewer" });
    assert.deepEqual(pty.writes, []);

    // The child's own exit ends the row's input eligibility and its private
    // process-incarnation key with it.
    const liveViewer = openSurface(harness);
    assert.equal(harness.manager.updateViewer(liveViewer, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const liveSource = nativeScope(harness, liveViewer, "claude");
    assert.deepEqual(harness.manager.writeViewerInput(liveViewer, request(liveSource, modesOf(harness, rowId), "z")),
      { status: "submitted" });
    assert.deepEqual(pty.writes.at(-1), "z");
    pty.emitExit(0);
    assert.equal(harness.manager.readViewerInputSource(liveViewer), undefined, "an exited row states no input scope");
    assert.deepEqual(harness.manager.writeViewerInput(liveViewer, request(liveSource, modesOf(harness, rowId), "a")),
      { status: "refused", reason: "row-unavailable" });
    assert.equal(pty.writes.at(-1), "z", "the exit wrote nothing more");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a confirmed stop closes native input admission before the child is signalled", async () => {
  const harness = makeHarness("stop");
  try {
    const rowId = await createRow(harness, "codex");
    const viewerId = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewerId, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const source = nativeScope(harness, viewerId, "codex");
    const pty = lastPty(harness);

    const stopping = harness.manager.stop(rowId, { confirmed: true });
    // Admission is closed synchronously, before any signal is sent or awaited.
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(source, modesOf(harness, rowId), "a")),
      { status: "refused", reason: "row-unavailable" }, "a row inside a stop takes no viewer input");
    assert.deepEqual(pty.writes, [], "nothing was typed into a child already being stopped");
    await stopping;
    assert.equal(harness.manager.readViewerInputSource(viewerId), undefined);

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a native CLI input source can never carry a copy receipt", async () => {
  const harness = makeHarness("copy-route");
  try {
    const rowId = await createRow(harness, "claude");
    const viewerId = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewerId, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const source = nativeScope(harness, viewerId, "claude");

    // The copy router resolves only `nvs1` conversation scopes. A native CLI token is
    // a different commitment domain, so it can never name a copy destination.
    assert.equal(parseNativeViewerScopeToken(source.sourceToken), undefined,
      "the conversation copy router cannot parse a native CLI token");

    // A native row has no copy producer, so its surface needs no copy sink at all to
    // take input — and nothing on this path ever calls one.
    const sinkless = harness.manager.openViewer({ hostRunId: HOST_RUN });
    assert.ok(sinkless);
    assert.equal(harness.manager.updateViewer(sinkless.viewerId, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const sinklessSource = nativeScope(harness, sinkless.viewerId, "claude");
    assert.deepEqual(harness.manager.writeViewerInput(sinkless.viewerId, request(
      sinklessSource, modesOf(harness, rowId), "q",
    )), { status: "submitted" });
    assert.deepEqual(harness.copies, [], "no clipboard receipt was produced for a hosted provider row");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a hosted provider row never registers with the status broker, so no Pi bootstrap exists for it", async () => {
  const harness = makeHarness("no-registration");
  try {
    const rowId = await createRow(harness, "claude");
    const pty = lastPty(harness);
    assert.deepEqual(harness.registrar.requests, [], "no status registration was made for a provider child");
    assert.equal(Object.hasOwn(pty.spawnDescriptor.env, SESSION_HOST_BOOTSTRAP_ENV), false,
      "no bootstrap token exists for this child anywhere");
    const viewerId = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewerId, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const source = nativeScope(harness, viewerId, "claude");
    assert.deepEqual(harness.manager.writeViewerInput(viewerId, request(source, modesOf(harness, rowId), "y")),
      { status: "submitted" }, "input works with no registration, no encoder, and no framing readiness");
    assert.deepEqual(pty.writes, ["y"]);

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
