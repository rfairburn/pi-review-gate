import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  isNativeViewerNativeCliInputSource,
  MAX_LABEL_CHARS,
  MAX_NATIVE_CLI_TARGET_CHARS as MANAGER_MAX_NATIVE_CLI_TARGET_CHARS,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeCliLaunchRequest,
  type NativeInstanceView,
  type NativeViewerInputRequest,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  NODE_OPTIONS_RESTORE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
  type NativeLaunchDescriptor,
} from "../src/session-host/launch";
import { SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV } from "../src/session-host/startup-request";
import {
  MAX_NATIVE_CLI_TARGET_CHARS,
  MAX_NATIVE_DISPLAY_NAME_CHARS,
  sessionBackendDisplayLabel,
  type NativeCliBackend,
} from "../src/session-host/session-backend";
import { savedDeletionOwnedSessions } from "../src/session-host/owning-host-service";
import { admitSavedSession, listSavedSessions, type SavedSessionAdmission } from "../src/session-host/saved-sessions";

/**
 * Focused component coverage for per-row native CLI hosting (issue 277 core
 * manager slice).
 *
 * EVIDENCE SCOPE: every child here is a synthetic PTY and every launch
 * descriptor comes from an injected test provider. Nothing in this file runs a
 * real Claude or Codex binary, reads or writes any provider's real
 * configuration, credentials, or conversations, or proves a real provider TUI's
 * rendering behavior. What it does prove is the manager contract: the injected
 * full interactive descriptor is spawned verbatim with no Pi registration,
 * bootstrap, preload, startup payload, title token, framing, or Pi setup; input,
 * resize, backpressure, stop, and settlement stay addressed to the one owned
 * handle; every provider field stays truthfully unknown; and the Pi launch path,
 * its framing fail-closed rule, and its unknown-Pi saved-session safety are
 * unchanged.
 */

const HOST_TOKEN_KEYS = [
  SESSION_HOST_BOOTSTRAP_ENV,
  SESSION_HOST_STARTUP_REQUEST_ENV,
  SESSION_HOST_TITLE_COLUMNS_ENV,
  NODE_OPTIONS_RESTORE_ENV,
] as const;

/** One synthetic owned child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 710_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  readonly killSignals: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  pauseCount = 0;
  resumeCount = 0;
  exited = false;
  /** Provider children in these fixtures settle on SIGTERM unless a case says otherwise. */
  exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "SIGTERM";
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

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ cols: columns, rows });
    this.cols = columns;
    this.rows = rows;
  }

  kill(signal?: string): void {
    const name = signal ?? "SIGHUP";
    this.killSignals.push(name);
    if (!this.exited && this.exitsOnSignal === name) this.emitExit(name === "SIGKILL" ? 9 : 15);
  }

  pause(): void { this.pauseCount += 1; }
  resume(): void { this.resumeCount += 1; }

  emitData(data: string): void { for (const listener of [...this.#dataListeners]) listener(data); }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

/** A registrar that records every request, so a native row's silence is provable. */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: { instanceId: string; options?: { inputOriginFraming?: boolean } }[] = [];
  readonly releases: string[] = [];

  register(instanceId: string, _handlers: InstanceStatusHandlers, options?: { inputOriginFraming?: boolean }): InstanceStatusRegistration {
    this.requests.push({ instanceId, ...(options === undefined ? {} : { options: { ...options } }) });
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        // The production registration token shape, so a framing row can build its
        // encoder from it exactly as the real broker's registration allows.
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
        ...(options?.inputOriginFraming === true ? { inputOriginFraming: 1 as const } : {}),
      },
      release: () => { this.releases.push(instanceId); },
    };
  }
}

interface NativeHarness {
  root: string;
  packageRoot: string;
  piExecutable: string;
  agentDir: string;
  workspace: string;
  workspace2: string;
  env: NodeJS.ProcessEnv;
  manager: InstanceManager;
  registrar: RecordingRegistrar;
  spawned: SpyPty[];
  providerCalls: { backend: NativeCliBackend; request: NativeCliLaunchRequest }[];
}

interface NativeHarnessOptions {
  framing?: boolean;
  provider?: NativeCliLaunch;
  envExtras?: NodeJS.ProcessEnv;
}

/**
 * A real InstanceManager over synthetic fixtures: a package fixture good enough
 * for the unchanged Pi launch path, a temp-rooted Pi agent directory, and an
 * injected native CLI provider that records what it was asked for.
 */
function makeNativeHarness(label: string, options: NativeHarnessOptions = {}): NativeHarness {
  const root = realpathSync(mkdtempSync(join(process.cwd(), `.prg-native-cli-${label}-`)));
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
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const workspace = join(root, "workspace-alpha");
  const workspace2 = join(root, "workspace-beta");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(workspace2, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    ...options.envExtras,
  };
  const registrar = new RecordingRegistrar();
  const spawned: SpyPty[] = [];
  const providerCalls: { backend: NativeCliBackend; request: NativeCliLaunchRequest }[] = [];
  const provider: NativeCliLaunch = options.provider ?? ((backend, request) => {
    providerCalls.push({ backend, request: { ...request, env: { ...request.env } } });
    return {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: env.HOME, [`${backend.toUpperCase()}_CONFIG_DIR`]: join(root, `provider-config-${backend}`) },
      cwd: request.workspace,
    };
  });
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    env,
    args: [],
    nativeCliLaunch: provider,
    ...(options.framing === undefined ? {} : { nativeInputOriginFraming: options.framing }),
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });
  return { root, packageRoot, piExecutable, agentDir, workspace, workspace2, env, manager, registrar, spawned, providerCalls };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bound a promise that must finish on its own. If it does not, `release` is run
 * first so a hung dependency cannot keep the process alive, and the wait fails.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string, release?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          release?.();
          reject(new Error(`timed out: ${what}`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wait for an asynchronous surface/frame fact without asserting on a race. */
async function untilFrame(surfaceText: () => string, pattern: RegExp, what: string): Promise<string> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const text = surfaceText();
    if (pattern.test(text)) return text;
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await sleep(20);
  }
}

function viewOf(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, "the row must exist");
  return view;
}

function lastPty(harness: NativeHarness): SpyPty {
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "a launched row owns its PTY");
  return pty;
}

test("a native CLI row spawns the injected interactive descriptor verbatim with no Pi registration, bootstrap, framing, or Pi setup", async () => {
  const providerEnv = { PATH: "/synthetic/bin", CLAUDE_CONFIG_DIR: "/synthetic/home/.claude", NODE_OPTIONS: "--max-old-space-size=256" };
  let seenRequest: NativeCliLaunchRequest | undefined;
  const harness = makeNativeHarness("launch", {
    provider: (backend, request) => {
      seenRequest = request;
      return { file: `/synthetic/bin/${backend}`, args: ["--interactive", "--model", "opus"], env: providerEnv, cwd: request.workspace };
    },
  });
  try {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });

    // The provider was asked for exactly this row's canonical workspace.
    assert.ok(seenRequest);
    assert.equal(seenRequest.workspace, realpathSync(harness.workspace));
    assert.equal(Object.hasOwn(seenRequest, "targetId"), false, "no target is invented when the caller gave none");
    assert.deepEqual(seenRequest.env, harness.env, "the provider gets a copy of the manager's environment snapshot");
    assert.deepEqual(harness.providerCalls, [], "the default harness provider never ran");

    // The descriptor is applied verbatim: file, argv, cwd, and environment.
    const pty = lastPty(harness);
    assert.equal(pty.spawnDescriptor.file, "/synthetic/bin/claude");
    assert.deepEqual(pty.spawnDescriptor.args, ["--interactive", "--model", "opus"]);
    assert.equal(pty.spawnDescriptor.cwd, realpathSync(harness.workspace));
    assert.deepEqual(pty.spawnDescriptor.env, providerEnv, "the child environment is the provider's, unchanged and unadded-to");
    assert.equal(pty.spawnDescriptor.env.NODE_OPTIONS, "--max-old-space-size=256", "the manager never rewrites NODE_OPTIONS for a provider child");
    assert.deepEqual(providerEnv, { PATH: "/synthetic/bin", CLAUDE_CONFIG_DIR: "/synthetic/home/.claude", NODE_OPTIONS: "--max-old-space-size=256" },
      "the provider's own env object is never mutated");
    for (const key of HOST_TOKEN_KEYS) {
      assert.equal(Object.hasOwn(pty.spawnDescriptor.env, key), false, `${key} never reaches a native CLI child`);
    }
    assert.equal(pty.spawnDescriptor.args.some((arg) => arg === "--extension" || arg.startsWith("--session")), false,
      "no Pi extension or session argument is composed for a provider child");

    // No status registration exists at all, so no bootstrap token exists either.
    assert.deepEqual(harness.registrar.requests, [], "a native CLI row is never registered with the status broker");

    // The row is a truthful, independent, unknown-status row with a stable label.
    const view = viewOf(harness.manager, id);
    assert.equal(view.backend, "claude");
    assert.equal(view.label, sessionBackendDisplayLabel("claude"));
    assert.equal(view.lifecycle, "alive");
    assert.equal(view.hasLiveProcess, true);
    assert.equal(view.nativeSession, null, "no Pi native conversation is claimed");
    assert.equal(view.busy, null);
    assert.equal(view.pendingInput, null);
    assert.equal(view.inputSurface, false);
    assert.equal(view.backgroundTasks, null);
    assert.equal(view.backgroundShells, null);
    assert.equal(view.activeTasks, null);
    assert.equal(view.activeShells, null);
    assert.deepEqual(view.activity, []);
    assert.equal(view.workspace, realpathSync(harness.workspace));

    // The Pi agent directory is recorded for host ownership bookkeeping only, and
    // no Pi setup ran for this row: nothing was published into the shared root.
    assert.equal(view.agentDir, realpathSync(harness.agentDir));
    assert.deepEqual(readdirSync(harness.agentDir), [], "a native CLI row performs no Pi agent-directory setup");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("Pi, Claude, and Codex rows in one manager keep separate PTYs, registrations, environments, and recorded backends", async () => {
  const harness = makeNativeHarness("three-backends");
  try {
    const piId = await harness.manager.create({ workspace: harness.workspace });
    const claudeId = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    const codexId = await harness.manager.create({ workspace: harness.workspace2, backend: "codex" });

    assert.equal(harness.registrar.requests.length, 1, "only the Pi row is registered");
    assert.equal(harness.registrar.requests[0]?.instanceId, piId);
    assert.equal(harness.spawned.length, 3);
    const [piPty, claudePty, codexPty] = harness.spawned;
    assert.ok(piPty && claudePty && codexPty);
    assert.notEqual(piPty.pid, claudePty.pid);
    assert.notEqual(claudePty.pid, codexPty.pid);

    assert.ok(piPty.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV], "the Pi child still receives its one-shot bootstrap");
    assert.deepEqual(piPty.spawnDescriptor.args.slice(0, 4), [
      "--extension", join(harness.packageRoot, "dist", "src", "session-host", "reporter.js"),
      "--extension", join(harness.packageRoot, "dist", "src", "index.js"),
    ], "the Pi launch path is unchanged");
    for (const nativePty of [claudePty, codexPty]) {
      for (const key of HOST_TOKEN_KEYS) {
        assert.equal(Object.hasOwn(nativePty.spawnDescriptor.env, key), false);
      }
    }
    assert.equal(claudePty.spawnDescriptor.file, "/synthetic/bin/claude");
    assert.equal(codexPty.spawnDescriptor.file, "/synthetic/bin/codex");
    assert.equal(claudePty.spawnDescriptor.cwd, realpathSync(harness.workspace));
    assert.equal(codexPty.spawnDescriptor.cwd, realpathSync(harness.workspace2), "each native row uses its own explicitly selected workspace");

    const views = harness.manager.list();
    assert.equal(views.length, 3);
    assert.equal(Object.hasOwn(views.find((v) => v.id === piId) ?? {}, "backend"), false, "an unrecorded Pi row keeps the compatible view shape");
    assert.equal(viewOf(harness.manager, claudeId).backend, "claude");
    assert.equal(viewOf(harness.manager, codexId).backend, "codex");
    assert.equal(viewOf(harness.manager, codexId).label, sessionBackendDisplayLabel("codex"));

    // Output and input never cross rows.
    claudePty.emitData("claude output\r\n");
    const claudeSurface = harness.manager.surface(claudeId);
    assert.ok(claudeSurface);
    await untilFrame(
      () => claudeSurface.frame().lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"),
      /claude output/,
      "the addressed row renders its own child's bytes",
    );
    const codexSurface = harness.manager.surface(codexId);
    assert.ok(codexSurface);
    assert.equal(codexSurface.frame().lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).join(""), "",
      "a sibling's bytes never render into another row");
    harness.manager.write(codexId, "echo hi\r");
    assert.deepEqual(codexPty.writes, ["echo hi\r"]);
    assert.deepEqual(claudePty.writes, []);

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("host-wide input framing stays Pi-only: a native row's local input is raw while a framing Pi row still refuses", async () => {
  const harness = makeNativeHarness("framing-isolation", { framing: true });
  try {
    const nativeId = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    const nativePty = lastPty(harness);
    harness.manager.write(nativeId, "ls -la\r");
    harness.manager.write(nativeId, Buffer.from([0x1b, 0x5b, 0x41]));
    assert.deepEqual(nativePty.writes, ["ls -la\r", Buffer.from([0x1b, 0x5b, 0x41])],
      "a native CLI row receives raw bytes, exactly as a legacy unframed row does");
    assert.equal(viewOf(harness.manager, nativeId).lifecycle, "alive");

    // The Pi row in the SAME manager still refuses every byte before readiness.
    const piId = await harness.manager.create({ workspace: harness.workspace });
    assert.deepEqual(harness.registrar.requests, [{ instanceId: piId, options: { inputOriginFraming: true } }],
      "only the Pi row requested framing, and only once");
    assert.throws(() => harness.manager.write(piId, "ls\r"), /refusing unframed input/);
    assert.deepEqual(harness.spawned.at(-1)?.writes ?? [], [], "no unframed byte reaches a framing Pi child");

    // The strict viewer seam fences a hosted row against its OWN process-incarnation
    // scope. The variant exists and is raw, but a forged Pi-shaped source is still
    // refused before any byte: this is never an unframed back door into a child.
    const viewer = harness.manager.openViewer({ hostRunId: "run-1", nativeClipboardSink: () => undefined });
    assert.ok(viewer);
    assert.equal(harness.manager.updateViewer(viewer.viewerId, { sessionId: nativeId, cols: 80, rows: 24 }).applied, true);
    const nativeScope = harness.manager.readViewerInputSource(viewer.viewerId);
    assert.ok(nativeScope !== undefined && isNativeViewerNativeCliInputSource(nativeScope),
      "a native row mints its own hosted input scope, never a Pi one");
    assert.equal(Object.hasOwn(nativeScope, "registrationIdentity"), false);
    assert.equal(Object.hasOwn(nativeScope, "nativeSession"), false);
    const forgedSource = {
      hostRunId: "run-1", viewerId: viewer.viewerId, viewerRevision: viewer.revision + 1, rowId: nativeId,
      nativeSession: { sessionId: "synthetic-native-conversation", epoch: 1 },
      geometry: { cols: 80, rows: 24, revision: 1 },
      registrationIdentity: "identity", registrationGeneration: "generation", sourceToken: "nvst1-forged",
    };
    const inputModes = {
      kittyFlags: 0, applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: false,
      mouseTracking: "none", modifyOtherKeys: 0, mouseEncoding: "default",
    };
    const result = harness.manager.writeViewerInput(viewer.viewerId, {
      expectedSource: forgedSource, expectedInputModes: inputModes, data: "ls\r",
    } as unknown as NativeViewerInputRequest);
    assert.deepEqual(result, { status: "refused", reason: "stale-source" });
    assert.deepEqual(nativePty.writes.slice(2), [], "the refused viewer dispatch wrote nothing");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("addressed resize and per-row geometry reach only the addressed native row", async () => {
  const harness = makeNativeHarness("resize");
  try {
    const idA = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    const idB = await harness.manager.create({ workspace: harness.workspace2, backend: "codex" });
    const ptyA = harness.spawned[0]!;
    const ptyB = harness.spawned[1]!;

    assert.equal(harness.manager.resizeInstance(idA, 132, 43), true);
    assert.deepEqual(ptyA.resizes, [{ cols: 132, rows: 43 }]);
    assert.deepEqual(ptyB.resizes, [], "a sibling native row is never resized");
    assert.deepEqual(harness.manager.instanceGeometry(idA), { cols: 132, rows: 43, revision: 1 });
    assert.deepEqual(harness.manager.instanceGeometry(idB), { cols: 80, rows: 24, revision: 0 });

    // Per-viewer participation sizes the addressed row only.
    const viewer = harness.manager.openViewer();
    assert.ok(viewer);
    assert.equal(harness.manager.updateViewer(viewer.viewerId, { sessionId: idB, cols: 100, rows: 30 }).applied, true);
    assert.deepEqual(ptyB.resizes, [{ cols: 100, rows: 30 }]);
    assert.deepEqual(ptyA.resizes, [{ cols: 132, rows: 43 }]);

    // A finished row is reported, never guessed at.
    ptyA.emitExit(0);
    assert.equal(harness.manager.resizeInstance(idA, 90, 20), false);
    assert.deepEqual(ptyA.resizes, [{ cols: 132, rows: 43 }]);

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("native rows report unknown activity, always require explicit stop confirmation, and settle only on their own exit", async () => {
  const harness = makeNativeHarness("settlement");
  try {
    const idA = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    const idB = await harness.manager.create({ workspace: harness.workspace2, backend: "codex" });
    const ptyA = harness.spawned[0]!;
    const ptyB = harness.spawned[1]!;
    ptyA.exitsOnSignal = "SIGTERM";
    ptyB.exitsOnSignal = "SIGTERM";

    // No telemetry exists for a provider child, so nothing is inferred.
    assert.equal(await harness.manager.refreshActivity(idA), "disconnected", "a native row has no live status client to ask");
    assert.deepEqual(await harness.manager.stop(idA, { confirmed: false }), { status: "confirmation-required", forced: false });
    assert.deepEqual(ptyA.killSignals, [], "an unconfirmed stop never signals a provider child");

    // Explicit confirmation uses the existing owned-handle ladder.
    assert.deepEqual(await harness.manager.stop(idA, { confirmed: true }), { status: "exited", forced: false });
    assert.deepEqual(ptyA.killSignals, ["SIGTERM"]);
    const exited = viewOf(harness.manager, idA);
    assert.equal(exited.lifecycle, "exited");
    assert.equal(exited.exitCode, 15);
    assert.equal(exited.hasLiveProcess, false);

    // The sibling row is untouched by its sibling's settlement.
    const sibling = viewOf(harness.manager, idB);
    assert.equal(sibling.lifecycle, "alive");
    assert.equal(sibling.hasLiveProcess, true);
    assert.deepEqual(ptyB.killSignals, [], "stopping one row never signals another row's handle");
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(harness.manager.closeExited(idB), false, "a live row is never removable");
    assert.equal(harness.manager.closeExited(idA), true);
    assert.equal(harness.manager.list().length, 1);

    // A child that ignores SIGTERM escalates to the owned handle's SIGKILL and
    // stays "remaining" until its own exit event actually arrives.
    const idC = await harness.manager.create({ workspace: harness.workspace, backend: "codex" });
    const ptyC = lastPty(harness);
    ptyC.exitsOnSignal = "none";
    const shutdown = harness.manager.shutdown({ graceMs: 40, killMs: 40 });
    const result = await shutdown;
    assert.deepEqual(result.forcedIds, [idC], "only the still-owned child was force-escalated");
    assert.deepEqual(result.remainingIds, [idC], "a force attempt is never a settlement");
    assert.deepEqual(ptyC.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(viewOf(harness.manager, idC).hasLiveProcess, true);
    assert.equal(harness.manager.closeExited(idC), false);
    ptyC.emitExit(137, 9);
    assert.equal(viewOf(harness.manager, idC).lifecycle, "exited");
    assert.equal(harness.manager.closeExited(idC), true);
    assert.equal(harness.manager.hasLiveProcesses(), false);
    // The manager-wide shutdown settled the other native row through the same
    // owned-handle ladder, and only its own exit event ended it.
    assert.deepEqual(ptyB.killSignals, ["SIGTERM"], "a provider child that exits on SIGTERM never needs escalation");
    assert.equal(viewOf(harness.manager, idB).lifecycle, "exited");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a native row refuses Pi rename and Pi control truthfully and never enters a Pi path", async () => {
  const harness = makeNativeHarness("unsupported-control");
  try {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    const rename = await harness.manager.rename(id, {
      expectedSessionId: "synthetic-conversation", expectedSessionEpoch: 1, name: "a new name",
    });
    assert.notEqual(rename.status, "renamed", "there is no Pi conversation to rename");
    assert.equal(rename.status, "disconnected", "a native row has no authenticated Pi control channel at all");
    assert.deepEqual(harness.registrar.requests, [], "the refusal never created a registration to rename through");
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive", "an unsupported control is a refusal, never a row failure");
    assert.equal(viewOf(harness.manager, id).label, sessionBackendDisplayLabel("claude"),
      "the stable provider label is not replaced by a name that was never observed");
    assert.deepEqual(lastPty(harness).writes, [], "nothing was typed into the provider child");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("native rows are excluded from the Pi saved-session census while unknown Pi rows keep refusing", async () => {
  const harness = makeNativeHarness("census");
  try {
    const nativeId = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    assert.ok(nativeId);
    // A live provider child with no Pi binding contributes nothing at all — not
    // even the unknown-binding placeholder — because it owns no Pi conversation.
    assert.deepEqual(harness.manager.ownedLiveSessions(), []);
    assert.deepEqual(savedDeletionOwnedSessions(harness.manager), []);

    // An unknown Pi row still contributes both its current binding and the
    // placeholder: the fail-closed rule is unchanged.
    const piId = await harness.manager.create({ workspace: harness.workspace2 });
    assert.ok(piId);
    assert.deepEqual(harness.manager.ownedLiveSessions(), [{ kind: "current" }]);
    assert.deepEqual(savedDeletionOwnedSessions(harness.manager), [{ kind: "current" }, {}]);

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a configured native launch target is forwarded unchanged and is never applied to a Pi row", async () => {
  const harness = makeNativeHarness("target");
  try {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "codex", nativeCliTarget: "shared-codex-staging" });
    assert.equal(viewOf(harness.manager, id).backend, "codex");
    const call = harness.providerCalls.at(-1);
    assert.ok(call);
    assert.equal(call.request.targetId, "shared-codex-staging", "the operator's explicit selection reaches the provider unchanged");

    // A Pi launch has no target to select: the explicit choice is refused, never
    // silently ignored, and nothing is posted or spawned.
    await assert.rejects(
      harness.manager.create({ workspace: harness.workspace, nativeCliTarget: "shared-codex-staging" }),
      /only valid for a native CLI backend/,
    );
    await assert.rejects(
      harness.manager.create({ workspace: harness.workspace, backend: "pi", nativeCliTarget: "shared-codex-staging" }),
      /only valid for a native CLI backend/,
    );
    // Malformed selections are refused too, before any provider runs. A space is
    // legal in an opaque id; an empty, multiline, or oversized one is not.
    for (const bad of ["", "line\nbreak", "x".repeat(200)]) {
      await assert.rejects(
        harness.manager.create({ workspace: harness.workspace, backend: "claude", nativeCliTarget: bad }),
        /launch target must be bounded single-line text/,
      );
    }
    assert.equal(harness.providerCalls.length, 1, "no refusal reached the provider");
    assert.equal(harness.spawned.length, 1, "no refusal posted a child");
    assert.equal(harness.manager.list().length, 1, "no refusal posted a row");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the native target-id bound is the shared one: exactly 128 characters start and one over never reaches the provider", async () => {
  const harness = makeNativeHarness("target-bound");
  try {
    // The manager validates against the bound `session-backend.ts` owns, and the
    // sidebar offers against the same value, so a drawn choice is launchable.
    assert.equal(MANAGER_MAX_NATIVE_CLI_TARGET_CHARS, MAX_NATIVE_CLI_TARGET_CHARS,
      "the manager's historical re-export is the shared bound, not a second copy");
    const atBound = "t".repeat(MAX_NATIVE_CLI_TARGET_CHARS);
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude", nativeCliTarget: atBound });
    assert.equal(viewOf(harness.manager, id).backend, "claude");
    assert.equal(harness.providerCalls.at(-1)?.request.targetId, atBound, "the id at the bound reaches the provider unchanged");

    // One character over the bound, and the C1 control characters the sidebar
    // must drop too, stay refused before the provider runs.
    for (const bad of ["t".repeat(MAX_NATIVE_CLI_TARGET_CHARS + 1), "claude\u0080", "claude\u009f", "claude\u007f"]) {
      await assert.rejects(
        harness.manager.create({ workspace: harness.workspace, backend: "claude", nativeCliTarget: bad }),
        /launch target must be bounded single-line text/,
      );
    }
    assert.equal(harness.providerCalls.length, 1, "no boundary refusal reached the provider");
    assert.equal(harness.spawned.length, 1, "no boundary refusal spawned a child");
    assert.equal(harness.manager.list().length, 1, "no boundary refusal posted a row");

    // An untyped caller with no options at all still gets the bounded create
    // refusal, exactly as before the native target option existed.
    await assert.rejects(
      harness.manager.create(undefined as unknown as CreateInstanceOptions),
      /create requires an explicit workspace directory/,
    );
    assert.equal(harness.manager.list().length, 1, "an optionless create posts no row");
    assert.equal(harness.spawned.length, 1, "an optionless create spawns nothing");
    assert.equal(harness.providerCalls.length, 1, "an optionless create never reaches the provider");

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("unsupported Pi inputs, an unknown backend, and a host without a provider are all refused before any row exists", async () => {
  const harness = makeNativeHarness("refusals");
  const savedAgentDir = join(harness.root, "saved-agent");
  mkdirSync(join(savedAgentDir, "sessions", "proj"), { recursive: true });
  writeFileSync(
    join(savedAgentDir, "sessions", "proj", "one.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "saved-native-refusal", timestamp: "2025-01-01T00:00:00.000Z", cwd: harness.workspace })}\n`,
    "utf8",
  );
  const catalog = await listSavedSessions({
    agentDir: savedAgentDir,
    listAll: async (sessionDir: string) => readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(sessionDir, entry.name);
        const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { id: string; cwd: string };
        return { path: file, id: header.id, cwd: header.cwd };
      }),
  });
  const row = catalog.rows.find((candidate) => candidate.id === "saved-native-refusal");
  assert.ok(row);
  const admitted = admitSavedSession(catalog, row, { ownedLiveSessions: [] });
  assert.equal(admitted.status, "admitted");
  const admission = (admitted as { admission: SavedSessionAdmission }).admission;

  try {
    const refusals: CreateInstanceOptions[] = [
      { workspace: harness.workspace, backend: "claude", savedSession: admission },
      { workspace: harness.workspace, backend: "claude", initialRequest: { title: "t", prompt: "do the thing" } },
      { workspace: harness.workspace, backend: "codex", profile: join(harness.root, "legacy-profile") },
      { workspace: harness.workspace, backend: "kittens" as never },
      { workspace: harness.workspace, backend: "" as never },
    ];
    for (const options of refusals) {
      await assert.rejects(harness.manager.create(options), (error: Error) => error instanceof Error);
    }
    assert.equal(harness.manager.list().length, 0, "a refused creation posts no row");
    assert.equal(harness.spawned.length, 0, "a refused creation spawns nothing");
    assert.equal(harness.providerCalls.length, 0, "a refused creation never reaches the provider");
    assert.deepEqual(harness.registrar.requests, []);

    // A host with no provider refuses the backend instead of falling back to Pi.
    const noProvider = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      args: [],
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    await assert.rejects(noProvider.create({ workspace: harness.workspace, backend: "claude" }), /no native CLI launch provider/);
    assert.equal(harness.manager.list().length, 0);
    assert.equal(harness.spawned.length, 0);
    // The same host still creates Pi rows exactly as before.
    const piId = await noProvider.create({ workspace: harness.workspace });
    assert.equal(viewOf(noProvider, piId).lifecycle, "alive");
    await noProvider.dispose();

    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an unusable provider result, a foreign cwd, or a stop during a pending provider fails the row closed without a child", async () => {
  const harness = makeNativeHarness("provider-failures");
  try {
    // A provider answer that is not a descriptor at all.
    const nullManager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      nativeCliLaunch: () => null as unknown as NativeLaunchDescriptor,
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    const nullId = await nullManager.create({ workspace: harness.workspace, backend: "claude" });
    const nullView = viewOf(nullManager, nullId);
    assert.equal(nullView.lifecycle, "error");
    assert.equal(nullView.hasLiveProcess, false);
    assert.equal(nullManager.closeError(nullId), true, "a never-spawned failed launch is removable once its cleanup settled");
    await nullManager.dispose();

    // A descriptor whose cwd is not this row's selected workspace.
    const foreignManager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      nativeCliLaunch: () => ({ file: "/synthetic/bin/claude", args: [], env: {}, cwd: harness.workspace2 }),
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    const foreignId = await foreignManager.create({ workspace: harness.workspace, backend: "claude" });
    assert.equal(viewOf(foreignManager, foreignId).lifecycle, "error");
    assert.equal(harness.spawned.length, 0, "a descriptor for another workspace never spawns");
    await foreignManager.dispose();

    // A workspace that does not exist is refused before the provider runs.
    const missingManager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      nativeCliLaunch: () => { throw new Error("the provider must never run for a missing workspace"); },
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    const missingId = await missingManager.create({ workspace: join(harness.root, "does-not-exist"), backend: "codex" });
    assert.equal(viewOf(missingManager, missingId).lifecycle, "error");
    assert.equal(harness.spawned.length, 0);
    await missingManager.dispose();

    // A provider that never answers must never hold the host away from stopping
    // its existing children. Shutdown aborts the unspawned creation, still runs the
    // owned stop ladder for the live sibling, and completes while the provider is
    // unresolved; the provider's late answer then creates nothing.
    let releaseProvider: (() => void) | undefined;
    const unresolved = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerInvocations = 0;
    const stoppingManager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      nativeCliLaunch: async () => {
        providerInvocations += 1;
        if (providerInvocations === 1) {
          return { file: "/synthetic/bin/claude", args: [], env: {}, cwd: harness.workspace };
        }
        // Never answers while the host shuts down, then rejects late: a late
        // rejection must be consumed, never surfaced and never spawned.
        await unresolved;
        throw new Error("the provider answered after this host already shut down");
      },
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    const siblingId = await stoppingManager.create({ workspace: harness.workspace, backend: "claude" });
    const siblingPty = lastPty(harness);
    assert.equal(viewOf(stoppingManager, siblingId).lifecycle, "alive");

    const pendingCreate = stoppingManager.create({ workspace: harness.workspace2, backend: "codex" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.spawned.length, 1, "the unresolved creation owns no child yet");

    const shutdownResult = await withTimeout(
      stoppingManager.shutdown({ graceMs: 20, killMs: 20 }),
      3000,
      "shutdown completes while the provider stays unresolved",
      releaseProvider,
    );
    const pendingId = await pendingCreate;
    assert.deepEqual(shutdownResult, { forcedIds: [], remainingIds: [] });
    assert.deepEqual(siblingPty.killSignals, ["SIGTERM"],
      "the live sibling still reached its owned stop ladder");
    assert.equal(viewOf(stoppingManager, siblingId).lifecycle, "exited");
    assert.equal(viewOf(stoppingManager, pendingId).lifecycle, "error",
      "the aborted creation reports a truthful error row and owns no child");
    assert.equal(harness.spawned.length, 1, "the aborted creation never spawned");

    // The late provider answer (here a rejection) is consumed and spawns nothing.
    releaseProvider!();
    await sleep(20);
    assert.equal(harness.spawned.length, 1, "a provider that answers after shutdown spawns nothing");
    assert.equal(viewOf(stoppingManager, pendingId).lifecycle, "error");

    // The same holds for a late fulfillment: the descriptor is discarded.
    let releaseSecond: (() => void) | undefined;
    const secondUnresolved = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const lateFulfill = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      nativeCliLaunch: async () => {
        await secondUnresolved;
        return { file: "/synthetic/bin/codex", args: [], env: {}, cwd: harness.workspace };
      },
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    const lateId = lateFulfill.create({ workspace: harness.workspace, backend: "codex" });
    await new Promise((resolve) => setImmediate(resolve));
    await withTimeout(lateFulfill.dispose(), 3000, "dispose completes while the provider stays unresolved", releaseSecond);
    const lateRowId = await lateId;
    assert.equal(harness.spawned.length, 1, "a late fulfillment is discarded, never spawned");
    assert.equal(viewOf(lateFulfill, lateRowId).lifecycle, "error");
    releaseSecond!();
    await sleep(20);
    assert.equal(harness.spawned.length, 1, "the provider settling after disposal still spawns nothing");

    // Host capability tokens a provider left in its environment are stripped.
    const dirtyManager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: { ...harness.env, [SESSION_HOST_BOOTSTRAP_ENV]: "stale-bootstrap" },
      nativeCliLaunch: () => ({
        file: "/synthetic/bin/claude",
        args: [],
        env: {
          PATH: "/synthetic/bin",
          [SESSION_HOST_BOOTSTRAP_ENV]: "stale",
          [SESSION_HOST_STARTUP_REQUEST_ENV]: "stale",
          [SESSION_HOST_TITLE_COLUMNS_ENV]: "40",
          [NODE_OPTIONS_RESTORE_ENV]: "stale",
          CLAUDE_CONFIG_DIR: "/synthetic/home/.claude",
        },
        cwd: harness.workspace,
      }),
      ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); harness.spawned.push(pty); return pty; },
    });
    const dirtyId = await dirtyManager.create({ workspace: harness.workspace, backend: "claude" });
    const dirtyPty = harness.spawned.at(-1)!;
    for (const key of HOST_TOKEN_KEYS) {
      assert.equal(Object.hasOwn(dirtyPty.spawnDescriptor.env, key), false, `${key} is stripped even when the provider carries it`);
    }
    assert.equal(dirtyPty.spawnDescriptor.env.PATH, "/synthetic/bin");
    assert.equal(dirtyPty.spawnDescriptor.env.CLAUDE_CONFIG_DIR, "/synthetic/home/.claude", "provider configuration is never touched");
    assert.equal(viewOf(dirtyManager, dirtyId).lifecycle, "alive");
    await dirtyManager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The native workspace accepts exactly the host's shared Pi spellings.
//
// A native row and a Pi row are the same host's rows, so the SAME resolver
// decides what a workspace spelling means: a leading bare `~`/`~/`, the process
// working directory for a relative spelling, and the canonical real path on
// success. Nothing here resolves through a shell, and nothing expands an
// environment variable or a `~otheruser` form — those stay the invoking shell's
// business for both backends.
// ---------------------------------------------------------------------------

test("a native row accepts absolute, relative, and symlink workspace spellings as one canonical directory", async () => {
  const harness = makeNativeHarness("workspace-spellings");
  try {
    const canonical = realpathSync(harness.workspace);
    const link = join(harness.root, "workspace-link");
    symlinkSync(harness.workspace, link);
    const relativeSpelling = relative(process.cwd(), harness.workspace);
    assert.ok(!isAbsolute(relativeSpelling), "the fixture spelling really is relative to this process");

    for (const [label, input] of [
      ["absolute", harness.workspace],
      ["relative to the process working directory", relativeSpelling],
      ["symlink", link],
    ] as const) {
      const id = await withTimeout(
        harness.manager.create({ workspace: input, backend: "claude" }),
        5000,
        `native ${label} create`,
      );
      const call = harness.providerCalls.at(-1);
      assert.ok(call, `${label}: the provider was asked for this row`);
      assert.equal(call.request.workspace, canonical,
        `${label}: the provider receives the one canonical directory, never the raw spelling`);
      assert.equal(viewOf(harness.manager, id).workspace, canonical,
        `${label}: the row records the canonical directory`);
      assert.equal(harness.spawned.at(-1)?.spawnDescriptor.cwd, canonical,
        `${label}: the child is anchored at the canonical directory`);
    }
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a tilde native workspace is expanded by the host's own resolver before the provider runs", async () => {
  const seen: string[] = [];
  const harness = makeNativeHarness("workspace-tilde", {
    provider: (_backend, request) => {
      seen.push(request.workspace);
      throw new Error("synthetic provider refusal; nothing spawns");
    },
  });
  try {
    const home = realpathSync(homedir());
    const bareId = await withTimeout(
      harness.manager.create({ workspace: "~", backend: "claude" }),
      5000,
      "tilde native create",
    );
    assert.deepEqual(seen, [home],
      "a bare ~ is the home directory this host itself resolves, and the provider sees that path");
    assert.equal(harness.spawned.length, 0, "the refusing provider spawned no child");
    assert.equal(viewOf(harness.manager, bareId).lifecycle, "error");

    // A ~-prefixed path that does not exist is refused by the same resolver,
    // before the provider is ever consulted: no shell did any of this work.
    const missingId = await withTimeout(
      harness.manager.create({ workspace: `~/.prg-native-missing-${randomUUID()}`, backend: "claude" }),
      5000,
      "missing tilde native create",
    );
    assert.equal(seen.length, 1, "an unresolvable workspace never reaches the provider");
    assert.equal(harness.spawned.length, 0, "no child exists for an unresolvable workspace");
    assert.equal(viewOf(harness.manager, missingId).lifecycle, "error");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a native workspace that is a file or does not exist is refused before the provider runs", async () => {
  const harness = makeNativeHarness("workspace-refusals");
  try {
    const filePath = join(harness.root, "not-a-directory");
    writeFileSync(filePath, "fixture file; never a workspace\n", "utf8");
    for (const [label, input] of [
      ["a regular file", filePath],
      ["a missing directory", join(harness.root, "no-such-directory")],
    ] as const) {
      const id = await withTimeout(
        harness.manager.create({ workspace: input, backend: "claude" }),
        5000,
        `native ${label} create`,
      );
      assert.equal(harness.providerCalls.length, 0, `${label}: the provider is never asked`);
      assert.equal(harness.spawned.length, 0, `${label}: no child is ever spawned`);
      assert.equal(viewOf(harness.manager, id).lifecycle, "error",
        `${label}: the row reports the bounded launch error and nothing else`);
    }
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// One native row's host-side display name: the operator's caption of THIS
// host's row. It replaces the row's single existing label field, is validated
// before anything changes, and is never a provider conversation identity.
// ---------------------------------------------------------------------------

test("a native row's display name replaces its one label field and never invents a second identity", async () => {
  const harness = makeNativeHarness("display-name");
  try {
    const nativeId = await withTimeout(
      harness.manager.create({ workspace: harness.workspace, backend: "claude" }),
      5000,
      "native create",
    );
    const providerLabel = sessionBackendDisplayLabel("claude");
    assert.equal(viewOf(harness.manager, nativeId).label, providerLabel,
      "the stable provider label is in charge until the operator names the row");

    assert.equal(harness.manager.setNativeDisplayName(nativeId, "Fleet work"), "set");
    const named = viewOf(harness.manager, nativeId);
    assert.equal(named.label, "Fleet work", "the name travels in the label field the host already transmits");
    assert.equal(Object.hasOwn(named, "nativeDisplayName"), false,
      "no second name field is invented beside the existing label");
    assert.equal(named.backend, "claude", "the row's backend identity is untouched by a caption");
    assert.equal(named.nativeSession, null, "a caption never becomes or reveals a conversation identity");
    assert.equal(harness.manager.setNativeDisplayName(nativeId, "Fleet work"), "unchanged");
    assert.equal(harness.manager.setNativeDisplayName(nativeId, "Fleet work 2"), "set");
    assert.equal(viewOf(harness.manager, nativeId).label, "Fleet work 2", "a later name replaces the earlier one");

    // Every rejected caption leaves the row exactly as it was: nothing is
    // truncated, coerced, or partially applied.
    const before = viewOf(harness.manager, nativeId).label;
    for (const [label, bad] of [
      ["empty", ""],
      ["whitespace only", "   "],
      ["surrounding whitespace", " Fleet "],
      ["one line break", "fleet\nwork"],
      ["a control character", "fleet\u0007work"],
      ["a C1 control character", "fleet\u0085work"],
      ["one character past the bound", "x".repeat(MAX_NATIVE_DISPLAY_NAME_CHARS + 1)],
    ] as const) {
      assert.equal(harness.manager.setNativeDisplayName(nativeId, bad), "invalid-name", `${label} is refused`);
      assert.equal(viewOf(harness.manager, nativeId).label, before, `${label}: the row's label is untouched`);
    }
    assert.equal(harness.manager.setNativeDisplayName(nativeId, "x".repeat(MAX_NATIVE_DISPLAY_NAME_CHARS)), "set",
      "the bound itself is admissible");
    assert.equal(MAX_NATIVE_DISPLAY_NAME_CHARS, MAX_LABEL_CHARS,
      "the caption bound is the row-label bound the manager already enforces, so no accepted name is refused downstream");

    // Unknown rows own no caption, and a Pi row is never captioned here: its name
    // belongs to the authenticated Pi rename path alone.
    assert.equal(harness.manager.setNativeDisplayName(randomUUID(), "ghost"), "no-row");
    const piId = await withTimeout(harness.manager.create({ workspace: harness.workspace2 }), 5000, "Pi create");
    const piLabel = viewOf(harness.manager, piId).label;
    assert.equal(harness.manager.setNativeDisplayName(piId, "not my caption"), "not-native");
    assert.equal(viewOf(harness.manager, piId).label, piLabel, "the Pi row's label is untouched");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
