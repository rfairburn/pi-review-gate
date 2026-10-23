import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync as readBytesSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_KILL_MS,
  InstanceManager,
  createDefaultPtyFactory,
  isNativeViewerStartupInputSource,
  __test as instanceTestSeam,
  MAX_ACTIVITY_ENTRIES,
  MAX_ACTIVITY_ENTRY_CHARS,
  MAX_INSTANCE_ERROR_CHARS,
  MAX_LABEL_CHARS,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type InstanceStatusRegistrationOptions,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type NativeViewerClipboardReceipt,
  type NativeViewerAnyInputSource,
  type NativeViewerClipboardSink,
  type NativeViewerInputRefusal,
  type NativeViewerInputRequest,
  type NativeViewerInputResult,
  type NativeViewerInputSource,
  type PtyFactory,
  type StatusRegistrar,
  type ViewerOpenOptions,
} from "../src/session-host/instances";
import { ProfileRegistry } from "../src/session-host/profiles";
import { translateInput } from "../src/session-host/input";
import {
  admitSavedSession,
  listSavedSessions,
  type SavedSessionAdmission,
} from "../src/session-host/saved-sessions";
import type {
  SavedSessionCatalog as GuardedSavedCatalog,
  SavedSessionRow as GuardedSavedRow,
} from "../src/session-host/saved-sessions";
import type { SavedDeletionMutationAdapters } from "../src/session-host/instances";
import { createLocalOwningHostService as createGuardedOwningHostService } from "../src/session-host/owning-host-service";
import {
  existsSync as guardedExistsSync,
  renameSync as guardedRenameSync,
  symlinkSync as guardedSymlinkSync,
  unlinkSync as guardedUnlinkSync,
} from "node:fs";
import { SESSION_HOST_BOOTSTRAP_ENV, composeFreshSessionSpawnArgs, prepareNativeLaunch } from "../src/session-host/launch";
import {
  createNativeInputDecoder,
  NATIVE_INPUT_RAW_FRAGMENT_BYTES,
  NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
  type NativeInputDecoder,
  type NativeInputFragment,
  type NativeInputOrigin,
} from "../src/session-host/native-input-origin";
import {
  encodeNativeClipboardOriginCapsule,
  type NativeClipboardEvent,
} from "../src/session-host/native-clipboard";
import { SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV } from "../src/session-host/startup-request";
import { readSessionHostPayloadSync } from "../src/session-host/payload";
import { TerminalSurface, type TerminalInputModes } from "../src/session-host/terminal-surface";
import { createTerminalGraphicsBudget, type TerminalGraphicsBudget } from "../src/session-host/kitty-graphics";
import type {
  StatusBroker,
  StatusBrokerStatusHandlers,
  StatusRegistration,
  StatusRenameRequest,
  StatusRenameResult,
  StatusShutdownResult,
} from "../src/session-host/broker";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import activateReporter, {
  beginSessionHostRestore,
  completeSessionHostRestore,
  SESSION_HOST_STICKY_STATE_KEY,
} from "../src/session-host/reporter";
import { __test as brokerTest, createStatusBroker } from "../src/session-host/broker";
import { SidebarController } from "../src/session-host/sidebar";
import { __test as mainTest } from "../src/session-host/main";
import {
  ACTIVITY_CENSUS_CAPABILITY,
  HOST_BOOTSTRAP_ENV,
  decodeFrame,
  encodeFrame,
  type SessionHostStatus,
} from "../src/session-host/protocol";
import {
  registerOwnedActivitySource,
  __test as ownedActivityTest,
} from "../src/session-host/owned-activity";
import {
  beginOwnedReviewActivity,
  endOwnedReviewActivity,
  registerReviewActivitySource,
  __test as reviewActivityTest,
} from "../src/activation/review-activity";
import { terminalInputModesAgree } from "./helpers/session-host-input-mode-precondition";

/**
 * Focused component tests for the independent owned-PTY instance lifecycle.
 *
 * IMPORTANT EVIDENCE SCOPE: manager cases use synthetic PTYs and broker
 * callbacks. The current-file regression additionally runs the production
 * reporter and protocol through Main's status adapter over an authenticated
 * in-memory transport. These do not prove native Pi runtime behavior or the
 * real broker's socket authentication; the parent owns broader integration.
 * The final native-addon case exercises the pinned PTY binding with an owned
 * Node shim, not a real Pi child. Broker/protocol
 * components have landed, but this file does not exercise them.
 */

function makeTestRoot(label: string): string {
  return realpathSync(mkdtempSync(join(process.cwd(), `.prg-instances-${label}-`)));
}

test("synthetic Windows default PTY factory lazily delegates the unchanged descriptor to public node-pty with bundled ConPTY", () => {
  const processPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(processPlatform);
  let moduleLoads = 0;
  let captured: { file: string; args: string[]; options: unknown } | undefined;
  const ownedPty = {} as unknown as InstancePty;
  instanceTestSeam.setNodePtyLoaderForTests(() => {
    moduleLoads += 1;
    return {
      spawn(file, args, options) {
        captured = { file, args: [...args], options: { ...options } };
        return ownedPty as unknown as import("@lydell/node-pty").IPty;
      },
    };
  });
  Object.defineProperty(process, "platform", { ...processPlatform, value: "win32" });
  try {
    const factory = createDefaultPtyFactory();
    assert.equal(moduleLoads, 0, "factory construction remains lazy and loads no native addon");
    const env = { Path: "C:\\synthetic\\node" };
    const descriptor: InstanceSpawnDescriptor = {
      file: "C:\\synthetic\\node\\node.exe",
      args: ["C:\\synthetic\\pi\\dist\\cli.js", "--offline"],
      env,
      cwd: "C:\\synthetic\\workspace",
      cols: 91,
      rows: 37,
    };
    assert.equal(factory(descriptor), ownedPty, "the exact public PTY handle is returned to its owner");
    assert.equal(moduleLoads, 1);
    assert.deepEqual(captured, {
      file: descriptor.file,
      args: descriptor.args,
      options: {
        name: "xterm-256color",
        cols: 91,
        rows: 37,
        cwd: descriptor.cwd,
        env,
        useConptyDll: true,
      },
    });
    assert.ok(captured && typeof captured.options === "object" && captured.options !== null);
    assert.equal(Object.hasOwn(captured.options, "useConptyDll"), true,
      "win32 explicitly selects the public ConPTY DLL bundled with the pinned node-pty");
    assert.equal((captured.options as { useConptyDll?: unknown }).useConptyDll, true,
      "the bundled ConPTY selection is the exact public boolean true, never a fallback hint");
    assert.equal(Object.hasOwn(captured.options, "useConpty"), false,
      "the deprecated ignored useConpty hint is never set on any platform");
  } finally {
    Object.defineProperty(process, "platform", processPlatform);
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
  }
});

test("POSIX default PTY factory keeps the exact node-pty spawn options without any Windows ConPTY selection", () => {
  const processPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(processPlatform);
  let captured: { file: string; args: string[]; options: unknown } | undefined;
  const ownedPty = {} as unknown as InstancePty;
  instanceTestSeam.setNodePtyLoaderForTests(() => ({
    spawn(file, args, options) {
      captured = { file, args: [...args], options: { ...options } };
      return ownedPty as unknown as import("@lydell/node-pty").IPty;
    },
  }));
  Object.defineProperty(process, "platform", { ...processPlatform, value: "linux" });
  try {
    const factory = createDefaultPtyFactory();
    const env = { PATH: "/usr/bin" };
    const descriptor: InstanceSpawnDescriptor = {
      file: "/usr/bin/node",
      args: ["/srv/pi/dist/cli.js", "--offline"],
      env,
      cwd: "/srv/workspace",
      cols: 80,
      rows: 24,
    };
    assert.equal(factory(descriptor), ownedPty, "the exact public PTY handle is returned to its owner");
    assert.deepEqual(captured, {
      file: descriptor.file,
      args: descriptor.args,
      options: {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: descriptor.cwd,
        env,
      },
    }, "POSIX spawn options remain byte-for-byte the same five public fields");
    assert.ok(captured && typeof captured.options === "object" && captured.options !== null);
    assert.equal(Object.hasOwn(captured.options, "useConptyDll"), false,
      "the Windows-only bundled ConPTY DLL selection is never set on a POSIX host");
    assert.equal(Object.hasOwn(captured.options, "useConpty"), false,
      "the deprecated ignored useConpty hint is never set on any platform");
  } finally {
    Object.defineProperty(process, "platform", processPlatform);
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
  }
});

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
    ["pi-review-gate-completion", ["SKILL.md"]],
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
  handlers: InstanceStatusHandlers;
  bootstrap: InstanceStatusRegistration["bootstrap"];
  released: boolean;
}

class FakeRegistrar implements StatusRegistrar {
  readonly entries: RegistrarEntry[] = [];
  readonly order: string[] = ["registrar"];
  readonly renameRequests: { instanceId: string; request: StatusRenameRequest }[] = [];
  /** Every registration request the manager made, in order, for propagation checks. */
  readonly registrationRequests: Array<{ instanceId: string; options?: InstanceStatusRegistrationOptions }> = [];
  /** Simulates a registrar predating the closed mode: it ignores the request. */
  dropFramingMode = false;
  renameHandler?: (entry: RegistrarEntry, request: StatusRenameRequest) => Promise<StatusRenameResult>;
  shutdownHandler?: (entry: RegistrarEntry, options?: { readonly requireIdle?: boolean }) => Promise<StatusShutdownResult>;
  nextToken?: string;
  readonly #payloadRoot?: string;

  constructor(payloadRoot?: string) {
    this.#payloadRoot = payloadRoot;
  }

  register(
    instanceId: string,
    handlers: RegistrarEntry["handlers"],
    options?: InstanceStatusRegistrationOptions,
  ): InstanceStatusRegistration {
    this.order.push(`register ${instanceId}`);
    this.registrationRequests.push({ instanceId, ...(options === undefined ? {} : { options: { ...options } }) });
    const framingRequested = options?.inputOriginFraming === true && !this.dropFramingMode;
    let payloadDir: string | undefined;
    let payloadIdentity: { dev: number; ino: number } | undefined;
    if (this.#payloadRoot !== undefined) {
      payloadDir = mkdtempSync(join(realpathSync(this.#payloadRoot), "pl-"));
      chmodSync(payloadDir, 0o700);
      const stats = lstatSync(payloadDir);
      payloadIdentity = { dev: stats.dev, ino: stats.ino };
    }
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
        ...(payloadDir === undefined ? {} : { payloadDir }),
        ...(framingRequested ? { inputOriginFraming: 1 as const } : {}),
      },
    };
    this.nextToken = undefined;
    this.entries.push(entry);
    const registration: InstanceStatusRegistration = {
      bootstrap: entry.bootstrap,
      release: () => {
        entry.released = true;
        // The fake broker removes only its own unchanged, empty namespace.
        if (payloadDir !== undefined && payloadIdentity !== undefined) {
          try {
            const stats = lstatSync(payloadDir);
            if (stats.isDirectory() && stats.dev === payloadIdentity.dev && stats.ino === payloadIdentity.ino) {
              rmdirSync(payloadDir);
            }
          } catch {
            // Non-empty/unknown fixtures stay preserved, exactly like the broker.
          }
        }
      },
    };
    if (this.renameHandler) {
      registration.rename = (request) => {
        this.renameRequests.push({ instanceId, request: { ...request } });
        return this.renameHandler!(entry, request);
      };
    }
    if (this.shutdownHandler) {
      registration.shutdown = (options) => this.shutdownHandler!(entry, options);
    }
    return registration;
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
  onSpawnRequest?: (parentInstanceId: string, request: import("../src/session-host/protocol").SessionSpawnInput) => Promise<import("../src/session-host/protocol").SessionSpawnOutcome>;
  shutdownHandler?: (entry: RegistrarEntry, options?: { readonly requireIdle?: boolean }) => Promise<StatusShutdownResult>;
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
  const payloadRoot = join(root, "payloads");
  mkdirSync(payloadRoot, { recursive: true, mode: 0o700 });
  chmodSync(payloadRoot, 0o700);
  const registrar = new FakeRegistrar(payloadRoot);
  registrar.shutdownHandler = options.shutdownHandler;
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
    nativeSetup: false,
    profileRegistry,
    args: [],
    env: options.managerEnv ?? cleanTestEnv(),
    cols: options.cols ?? DEFAULT_INSTANCE_COLS,
    rows: options.rows ?? DEFAULT_INSTANCE_ROWS,
    getSupportedKeyboardFlags: options.getSupportedKeyboardFlags ?? (() => 7),
    ptyFactory,
    onChange: options.onChange,
    onSpawnRequest: options.onSpawnRequest,
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
      nativeSetup: false,
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

test("default native setup shares one owned Pi root without copying resources or coupling child ownership", { skip: process.platform === "win32" }, async () => {
  const harness = makeHarness("native-shared-root");
  try {
    const agentDir = join(harness.root, "native-agent");
    const home = join(harness.root, "native-home");
    const sessionDir = join(agentDir, "sessions");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(agentDir, "skills", "user-skill"), { recursive: true });
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const nativeFiles = new Map<string, Buffer>([
      [join(agentDir, "review-gate.json"), Buffer.from('{"enabled":false,"nativeMarker":"keep-config-bytes"}\n')],
      [join(agentDir, "settings.json"), Buffer.from('{"theme":"native-settings"}\n')],
      [join(agentDir, "keybindings.json"), Buffer.from('{"native":"keybindings"}\n')],
      [join(agentDir, "models.json"), Buffer.from('{"native":"models"}\n')],
      [join(agentDir, "mcp.json"), Buffer.from('{"native":"mcp"}\n')],
      [join(agentDir, "auth.json"), Buffer.from('{"native":"auth fixture"}\n')],
      [join(agentDir, "skills", "user-skill", "SKILL.md"), Buffer.from("native skill bytes\n")],
      [join(agentDir, "extensions", "native-extension.ts"), Buffer.from("native extension bytes\n")],
      [join(sessionDir, "saved-conversation.jsonl"), Buffer.from("native conversation bytes\n")],
    ]);
    for (const [path, bytes] of nativeFiles) writeFileSync(path, bytes);

    const nativeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_PROVIDER_FIXTURE_KEY: "synthetic-provider-key",
      ANTHROPIC_API_KEY: "synthetic-auth-key",
      PI_IMAGE_PROTOCOL: "native-image-selection",
      PI_REVIEW_GATE_CODEMODE_DEFAULT: "0",
    };
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      args: ["--model", "fixture/native-model"],
      env: nativeEnv,
      ptyFactory: harness.ptyFactory,
    });

    const idA = await manager.create({ label: "temporary-a", workspace: harness.workspace });
    const idB = await manager.create({ label: "temporary-b", workspace: harness.workspace2 });
    const viewA = viewFor(manager, idA);
    const viewB = viewFor(manager, idB);
    assert.equal(viewA.agentDir, realpathSync(agentDir));
    assert.equal(viewB.agentDir, viewA.agentDir, "default manager admissions share the canonical native root");
    assert.equal(viewA.workspace, realpathSync(harness.workspace));
    assert.equal(viewB.workspace, realpathSync(harness.workspace2));
    assert.notEqual(viewA.workspace, viewB.workspace);
    assert.notEqual(harness.spawned[0]?.pid, harness.spawned[1]?.pid, "child process ownership stays independent");

    for (const [index, id, workspace] of [
      [0, idA, harness.workspace],
      [1, idB, harness.workspace2],
    ] as const) {
      const descriptor = harness.spawned[index]?.spawnDescriptor;
      assert.ok(descriptor);
      assert.equal(descriptor.cwd, realpathSync(workspace));
      assert.equal(descriptor.env.PI_CODING_AGENT_DIR, realpathSync(agentDir));
      assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, undefined, "native config discovery is not overridden per child");
      assert.equal(descriptor.env.PI_PROVIDER_FIXTURE_KEY, "synthetic-provider-key");
      assert.equal(descriptor.env.ANTHROPIC_API_KEY, "synthetic-auth-key");
      assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, sessionDir, "ordinary native session storage is preserved");
      assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "native-image-selection");
      assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "0");
      assert.deepEqual(descriptor.args.slice(-2), ["--model", "fixture/native-model"]);
      assert.equal(JSON.parse(descriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string).instanceId, id);
    }
    assert.notEqual(
      JSON.parse(harness.spawned[0]!.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string).token,
      JSON.parse(harness.spawned[1]!.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string).token,
      "per-child status authorization remains independent",
    );
    assert.deepEqual(readDirNames(harness.stateRoot), [], "native mode creates no private profile tree");
    for (const [path, bytes] of nativeFiles) {
      assert.deepEqual(readBytesSync(path), bytes, `native resource bytes survive launch: ${path}`);
    }

    manager.write(idA, "only-child-a");
    assert.deepEqual(harness.spawned[0]?.writes.at(-1), "only-child-a");
    assert.equal(harness.spawned[1]?.writes.includes("only-child-a"), false, "input stays addressed to one child");

    const registrationsBeforeGuard = harness.registrar.entries.length;
    const guardedManager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      args: ["--session", "synthetic-session-secret"],
      env: nativeEnv,
      ptyFactory: harness.ptyFactory,
    });
    const guardedId = await guardedManager.create({ label: "guarded", workspace: harness.workspace });
    assert.equal(viewFor(guardedManager, guardedId).lifecycle, "error");
    assert.equal(viewFor(guardedManager, guardedId).error, "session-host: instance launch preparation failed");
    assert.equal(harness.registrar.entries.length, registrationsBeforeGuard, "startup-option rejection happens before status registration");
    assert.equal(harness.spawned.length, 2, "rejected startup selection spawns no child");
    for (const [path, bytes] of nativeFiles) {
      assert.deepEqual(readBytesSync(path), bytes, `startup-option rejection preserves native bytes: ${path}`);
    }
    await guardedManager.dispose();

    // A failed create is contained to its own row and does not touch native
    // resources or the independently live sibling.
    const failedId = await manager.create({
      label: "bad-workspace",
      workspace: join(harness.root, "missing-workspace"),
    });
    assert.equal(viewFor(manager, failedId).lifecycle, "error");
    assert.equal(harness.spawned.length, 2, "workspace admission failure spawns no third child");
    assert.equal(viewFor(manager, idB).hasLiveProcess, true, "failed creation does not stop its sibling");
    for (const [path, bytes] of nativeFiles) {
      assert.deepEqual(readBytesSync(path), bytes, `failed create preserves native bytes: ${path}`);
    }

    harness.spawned[0]!.emitExit(0);
    assert.equal(manager.closeExited(idA), true);
    assert.equal(viewFor(manager, idB).hasLiveProcess, true, "removal does not activate or stop a sibling");
    for (const [path, bytes] of nativeFiles) {
      assert.deepEqual(readBytesSync(path), bytes, `removing an exited row preserves native bytes: ${path}`);
    }
    assert.deepEqual(readDirNames(harness.stateRoot), []);

    harness.spawned[1]!.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
    await manager.dispose();
  } finally {
    cleanup(harness);
  }
});

test("fresh SessionSpawn launch removes inherited messages and stores exact startup data outside argv", async () => {
  const harness = makeHarness("spawn-launch-composition");
  try {
    const managerEnv = cleanTestEnv();
    managerEnv[SESSION_HOST_STARTUP_REQUEST_ENV] = "inherited request must be stripped";
    managerEnv[SESSION_HOST_TITLE_COLUMNS_ENV] = "999";
    const originalArgs = [
      "--provider", "openai",
      "--model", "test-model",
      "-n", "old native title",
      "--print", "parent print message",
      "@parent-prompt.md",
      "--custom-resource", "preserved extension value",
      "bare parent message",
    ];
    const originalEnv = { ...managerEnv };
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      nativeSetup: false,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      args: originalArgs,
      env: managerEnv,
      getSidebarTitleColumns: () => 47,
      ptyFactory: harness.ptyFactory,
    });

    const ordinaryId = await manager.create({ workspace: harness.workspace });
    const ordinary = harness.spawned[0]!.spawnDescriptor;
    assert.deepEqual(ordinary.args.slice(-originalArgs.length), originalArgs,
      "ordinary instance arguments retain the established byte-for-byte launch path");
    assert.equal(ordinary.env[SESSION_HOST_STARTUP_REQUEST_ENV], undefined);
    assert.equal(ordinary.env[SESSION_HOST_TITLE_COLUMNS_ENV], "47");
    assert.equal(JSON.parse(ordinary.env[SESSION_HOST_BOOTSTRAP_ENV] as string).instanceId, ordinaryId);

    const title = " Exact child title ";
    const prompt = [
      "BEGIN startup long prompt",
      "@/literal-not-a-file",
      "--session /tmp/not-a-session-option",
      "/prompt-template literal",
      "Multibyte 日本語 — quotes \"exact\" — lone surrogate \uD800.",
      "MIDDLE".repeat(2_000),
      "END startup long prompt",
      "",
    ].join("\n");
    assert.ok(Buffer.byteLength(prompt, "utf8") > 8192);
    const childId = await manager.create({
      workspace: harness.workspace2,
      initialRequest: { title, prompt },
    });
    const child = harness.spawned[1]!.spawnDescriptor;
    assert.equal(child.cwd, realpathSync(harness.workspace2), "the requested existing workspace is the child cwd");
    const composed = composeFreshSessionSpawnArgs(originalArgs, title);
    assert.deepEqual(child.args.slice(-composed.length), composed,
      "only inherited native settings survive, with the per-child name appended in option position");
    assert.equal(child.args.includes(prompt), false, "the prompt is not sent through CLI positional/@file parsing");
    const startupReference = JSON.parse(child.env[SESSION_HOST_STARTUP_REQUEST_ENV] as string) as {
      name: string; size: number; sha256: string;
    };
    assert.match(startupReference.name, /^p-[0-9a-f]{32}\.json$/,
      "the one-shot env carries only a strict private payload reference");
    assert.equal(Object.hasOwn(startupReference, "prompt"), false);
    assert.equal(Object.hasOwn(startupReference, "title"), false);
    const payloadDir = harness.registrar.entryFor(childId).bootstrap.payloadDir;
    assert.equal(typeof payloadDir, "string");
    const startupText = readSessionHostPayloadSync(payloadDir as string, startupReference);
    assert.deepEqual(JSON.parse(startupText), { title, prompt },
      "the exact title and initial prompt round-trip from the private namespace");
    assert.equal(child.env[SESSION_HOST_TITLE_COLUMNS_ENV], "47");
    assert.equal(JSON.parse(child.env[SESSION_HOST_BOOTSTRAP_ENV] as string).instanceId, childId);
    assert.deepEqual(managerEnv, originalEnv, "per-child startup metadata never mutates the caller environment");
    await manager.dispose();
  } finally {
    cleanup(harness);
  }
});

test("an initial request without a host payload namespace fails before any child exists", async () => {
  const harness = makeHarness("spawn-payload-required");
  try {
    const registrar = new FakeRegistrar(); // Explicitly no payload namespace.
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: registrar,
      nativeSetup: false,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      args: [],
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const id = await manager.create({
      workspace: harness.workspace,
      initialRequest: { title: "Child", prompt: "Exact prompt without an inline fallback." },
    });
    assert.equal(viewFor(manager, id).lifecycle, "error");
    assert.equal(harness.spawned.length, 0, "no child is spawned and no inline prompt fallback exists");
    assert.equal(registrar.entries.length, 1, "the registration existed only for the refused launch");
    assert.equal(registrar.entries[0]!.released, true, "the refused registration is released");
    await manager.dispose();
  } finally {
    cleanup(harness);
  }
});

test("child exit before startup consumption discards the owned startup payload", async () => {
  const harness = makeHarness("startup-payload-exit");
  try {
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      nativeSetup: false,
      profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      args: [],
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
    });
    const prompt = "BEGIN unconsumed startup prompt\n" + "x".repeat(9_000) + "\nEND unconsumed startup prompt";
    const id = await manager.create({
      workspace: harness.workspace,
      initialRequest: { title: "Exiting child", prompt },
    });
    const child = harness.spawned[0]!;
    const descriptor = JSON.parse(child.spawnDescriptor.env[SESSION_HOST_STARTUP_REQUEST_ENV] as string) as {
      name: string; size: number; sha256: string;
    };
    const payloadDir = harness.registrar.entryFor(id).bootstrap.payloadDir as string;
    const payloadPath = join(payloadDir, descriptor.name);
    assert.ok(lstatSync(payloadPath).isFile(), "the exact startup payload exists before the child settles");
    assert.deepEqual(JSON.parse(readBytesSync(payloadPath, "utf8")), { title: "Exiting child", prompt });

    child.emitExit(0);
    await until(() => viewFor(manager, id).lifecycle === "exited", "child exit before startup consumption");
    assert.equal(lstatSync(payloadPath, { throwIfNoEntry: false }), undefined,
      "the manager discards its exact unconsumed payload at confirmed child settlement");
    assert.equal(lstatSync(payloadDir, { throwIfNoEntry: false }), undefined,
      "the now-empty private namespace is released");
    await manager.dispose();
  } finally {
    cleanup(harness);
  }
});

test("parent Stop fences authenticated spawn requests until a positive idle-only rejection", async () => {
  let resolveShutdown!: (result: StatusShutdownResult) => void;
  let shutdownCalls = 0;
  let spawnCalls = 0;
  const harness = makeHarness("spawn-stop-admission-fence", {
    shutdownHandler: async (_entry, options) => {
      shutdownCalls += 1;
      assert.equal(options?.requireIdle, true, "the first Stop attempt is an idle-only preflight");
      return new Promise<StatusShutdownResult>((resolve) => { resolveShutdown = resolve; });
    },
    onSpawnRequest: async () => {
      spawnCalls += 1;
      return "started";
    },
  });
  try {
    const parentId = await harness.manager.create({ workspace: harness.workspace });
    const parent = harness.registrar.entryFor(parentId);
    harness.registrar.emitStatus(parent, {
      busy: false,
      pendingInput: false,
      inputSurface: false,
      activity: [],
      nativeSession: { sessionId: "native-stop-parent", epoch: 1, name: "Parent" },
      backgroundTasks: 0,
      backgroundShells: 0,
    });

    const stopping = harness.manager.stop(parentId, { confirmed: false });
    await until(() => shutdownCalls === 1, "parent Stop has sent its delayed authenticated shutdown preflight");
    const request = { workspace: harness.workspace2, title: "Sibling", prompt: "Start a sibling." };
    assert.equal(await parent.handlers.onSpawnRequest?.(request), "failed",
      "the exact parent cannot authorize SessionSpawn while its Stop acknowledgement is pending");
    assert.equal(spawnCalls, 0);
    assert.equal(harness.spawned.length, 1, "the delayed Stop creates no surviving sibling");

    resolveShutdown({ requestId: "idle-rejected", status: "not-idle" });
    assert.deepEqual(await stopping, { status: "confirmation-required", forced: false });
    assert.equal(await parent.handlers.onSpawnRequest?.(request), "started",
      "a positive idle-only rejection reopens this parent's spawn admission");
    assert.equal(spawnCalls, 1);
    assert.equal(harness.spawned.length, 1, "the harness callback is admitted only after the rejection");

    harness.spawned[0]!.emitExit(0);
    await harness.manager.dispose();
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
      nativeSetup: false,
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
        nativeSetup: false,
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

test("native names are observed and persisted rename is fenced before and after the broker call", async () => {
  const harness = makeHarness("native-rename");
  let releaseRename: ((result: StatusRenameResult) => void) | undefined;
  harness.registrar.renameHandler = (entry, request) => {
    if (request.expectedSessionEpoch === 2) {
      return new Promise<StatusRenameResult>((resolve) => { releaseRename = resolve; });
    }
    harness.registrar.emitStatus(entry, {
      busy: false, pendingInput: false, inputSurface: false, activity: [],
      nativeSession: { sessionId: request.expectedSessionId, epoch: request.expectedSessionEpoch, name: request.name },
    });
    return Promise.resolve({
      requestId: "rename-ack-1",
      status: "renamed",
      expectedSessionId: request.expectedSessionId,
      expectedSessionEpoch: request.expectedSessionEpoch,
      observedSessionId: request.expectedSessionId,
      observedSessionEpoch: request.expectedSessionEpoch,
    });
  };
  try {
    const id = await harness.manager.create({ workspace: harness.workspace });
    const entry = harness.registrar.entryFor(id);
    harness.registrar.emitStatus(entry, {
      busy: false, pendingInput: false, inputSurface: false, activity: [],
      nativeSession: { sessionId: "conversation-1", epoch: 1, name: "Initial title" },
    });
    assert.equal(viewFor(harness.manager, id).label, "Initial title");
    assert.deepEqual(viewFor(harness.manager, id).nativeSession, {
      sessionId: "conversation-1", epoch: 1, name: "Initial title",
    });

    const success = await harness.manager.rename(id, {
      expectedSessionId: "conversation-1", expectedSessionEpoch: 1, name: "Persisted title",
    });
    assert.equal(success.status, "renamed");
    assert.deepEqual(harness.registrar.renameRequests.map(({ request }) => request), [{
      expectedSessionId: "conversation-1", expectedSessionEpoch: 1, name: "Persisted title",
    }]);
    assert.equal(viewFor(harness.manager, id).label, "Persisted title", "the row follows observed status, not an optimistic local label");

    harness.registrar.emitStatus(entry, {
      busy: false, pendingInput: false, inputSurface: false, activity: [],
      nativeSession: { sessionId: "conversation-2", epoch: 2, name: "Switched conversation" },
    });
    const stale = await harness.manager.rename(id, {
      expectedSessionId: "conversation-1", expectedSessionEpoch: 1, name: "Must not win",
    });
    assert.equal(stale.status, "stale-session");
    assert.equal(harness.registrar.renameRequests.length, 1, "preflight stale tuples never reach the broker");

    const pending = harness.manager.rename(id, {
      expectedSessionId: "conversation-2", expectedSessionEpoch: 2, name: "Racing title",
    });
    assert.equal(harness.registrar.renameRequests.length, 2);
    harness.registrar.emitStatus(entry, {
      busy: false, pendingInput: false, inputSurface: false, activity: [],
      nativeSession: { sessionId: "conversation-3", epoch: 3, name: "Latest conversation" },
    });
    assert.ok(releaseRename, "the pending broker rename reached its asynchronous handler");
    releaseRename({
      requestId: "rename-ack-2", status: "renamed",
      expectedSessionId: "conversation-2", expectedSessionEpoch: 2,
      observedSessionId: "conversation-2", observedSessionEpoch: 2,
    });
    const raced = await pending;
    assert.equal(raced.status, "stale-session", "a tuple change during persistence prevents reporting success");
    assert.equal(viewFor(harness.manager, id).label, "Latest conversation");
    harness.registrar.emitDisconnect(entry);
    assert.equal(viewFor(harness.manager, id).nativeSession, null, "disconnect clears observed native identity");
    assert.equal(viewFor(harness.manager, id).label, "(session name unavailable)");
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
      nativeSetup: false,
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
    assert.equal(hungRegistration.released, false, "dispose retains the live owner's status registration until confirmed exit");
    assert.equal(harness.manager.hasLiveProcesses(), true, "truthful: an owned child was not confirmed dead");
    assert.equal(viewFor(harness.manager, polite).lifecycle, "exited");
    harness.spawned[1].emitExit(42, 9);
    assert.equal(hungRegistration.released, true, "a later owned exit releases the deferred registration");
    assert.equal(harness.manager.hasLiveProcesses(), false);
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

test("one InstanceManager graphics budget is shared across every owned terminal surface", async () => {
  const harness = makeHarness("shared-graphics-budget");
  let manager: InstanceManager | undefined;
  let pendingTransferReservations = 0;
  const budget = createTerminalGraphicsBudget();
  const sharedBudget: TerminalGraphicsBudget = {
    reserveImage: (...args) => budget.reserveImage(...args),
    reserveFallbackImage: () => budget.reserveFallbackImage(),
    reservePlacement: (fallback) => budget.reservePlacement(fallback),
    reservePendingTransfer: () => {
      pendingTransferReservations += 1;
      return pendingTransferReservations === 1 ? budget.reservePendingTransfer() : undefined;
    },
    reservePendingBytes: (bytes) => budget.reservePendingBytes(bytes),
  };
  try {
    manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      nativeSetup: false,
      profileRegistry: harness.profileRegistry,
      env: cleanTestEnv(),
      ptyFactory: harness.ptyFactory,
      graphicsBudget: sharedBudget,
    });
    const first = await manager.create({ workspace: harness.workspace });
    const second = await manager.create({ workspace: harness.workspace2 });
    const firstSurface = manager.surface(first);
    const secondSurface = manager.surface(second);
    assert.ok(firstSurface && secondSurface);
    const pending = "\x1b_Ga=T,f=100,q=2,C=1,i=7,m=1;AAAA\x1b\\";
    firstSurface.write(pending);
    await firstSurface.flush();
    secondSurface.write(pending);
    await secondSurface.flush();
    assert.equal(pendingTransferReservations, 2,
      "both surfaces consult the same manager-owned reservation instead of receiving private per-surface budgets");
    for (const pty of harness.spawned) pty.exitsOnSignal = "SIGTERM";
    await manager.shutdown({ graceMs: 30, killMs: 30 });
    await manager.dispose();
    manager = undefined;
  } finally {
    if (manager) {
      for (const pty of harness.spawned) pty.exitsOnSignal = "SIGTERM";
      await manager.shutdown({ graceMs: 30, killMs: 30 });
      await manager.dispose();
    }
    cleanup(harness);
  }
});

test("constructor validation and defaults", async () => {
  const harness = makeHarness("ctor");
  try {
    assert.throws(
      () => new InstanceManager({
        packageRoot: harness.packageRoot,
        piExecutable: harness.piExecutable,
        statusRegistrar: harness.registrar,
        nativeSetup: false,
      }),
      /nativeSetup:false requires an explicitly injected legacy setup preparer/,
    );
    assert.throws(
      () => new InstanceManager({
        packageRoot: harness.packageRoot,
        piExecutable: harness.piExecutable,
        statusRegistrar: harness.registrar,
        profileRegistry: new ProfileRegistry({ stateRoot: harness.stateRoot }),
      }),
      /nativeSetup must be explicit/,
      "injected setup preparers cannot silently select legacy/native launch mode",
    );
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
    nativeSetup: false,
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
// --- Deliberate saved-conversation creation (issue 323). ---
//
// These cases use the landed read-only saved-sessions API with a synthetic
// public listAll injection against own-root fixtures: real catalog minting,
// real branded admissions, real launch revalidation. Fake PTYs only.

const SAVED_SESSION_HEADER_TIMESTAMP = "2025-01-01T00:00:00.000Z";

function writeSavedSessionFile(dir: string, name: string, id: string, cwd: string): string {
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: SAVED_SESSION_HEADER_TIMESTAMP, cwd })}\n`,
    "utf8",
  );
  return file;
}

/** Synthetic public-API flat-directory listAll injection (component-test seam). */
function makeSavedListAll() {
  return async (
    sessionDir: string,
    _onProgress?: (progress: Readonly<Record<string, unknown>>) => void,
    signal?: AbortSignal,
  ) => {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    const rows: { path: string; id: string; cwd: string }[] = [];
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = join(sessionDir, entry.name);
      let text: string;
      try {
        text = readBytesSync(file).toString("utf8");
      } catch {
        continue;
      }
      const first = text.split("\n").find((line) => line.trim() !== "");
      if (!first) continue;
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(first) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof header.id === "string" && typeof header.cwd === "string") {
        rows.push({ path: file, id: header.id, cwd: header.cwd });
      }
    }
    return rows;
  };
}

interface SavedFixture {
  agentDir: string;
  workspace: string;
  home: string;
  env: NodeJS.ProcessEnv;
  manager: InstanceManager;
}

function makeSavedHarness(label: string): Harness & SavedFixture {
  const harness = makeHarness(`saved-${label}`);
  const agentDir = join(harness.root, `saved-agent-${label}`);
  const workspace = join(harness.root, `saved-workspace-${label}`);
  const home = join(harness.root, `saved-home-${label}`);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
  };
  const manager = new InstanceManager({
    packageRoot: harness.packageRoot,
    piExecutable: harness.piExecutable,
    statusRegistrar: harness.registrar,
    env,
    ptyFactory: harness.ptyFactory,
  });
  return { ...harness, agentDir, workspace, home, env, manager };
}

async function admissionFor(harness: SavedFixture, id: string): Promise<SavedSessionAdmission> {
  const catalog = await listSavedSessions({ agentDir: harness.agentDir, listAll: makeSavedListAll() });
  const row = catalog.rows.find((candidate) => candidate.id === id);
  assert.ok(row, `catalog lists ${id}`);
  const admitted = admitSavedSession(catalog, row);
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") throw new Error("unreachable");
  return admitted.admission;
}

test("saved-session create composes the exact per-child --session admission in the shared native root", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("compose");
  try {
    const file = writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "one.jsonl", "saved-compose-1", harness.workspace);
    const admission = await admissionFor(harness, "saved-compose-1");

    // A conflicting explicit workspace is refused: the header cwd decides.
    await assert.rejects(
      harness.manager.create({ workspace: harness.workspace2, savedSession: admission }),
      /recorded workspace/,
    );
    // A forged (non-branded) receipt is refused before any row exists.
    await assert.rejects(
      harness.manager.create({
        workspace: admission.workspace,
        savedSession: { ...admission } as unknown as SavedSessionAdmission,
      }),
      /not a valid admission receipt/,
    );
    assert.equal(harness.spawned.length, 0, "refusals spawn no child and post no row");

    const id = await harness.manager.create({ workspace: admission.workspace, savedSession: admission });
    const descriptor = harness.spawned[0]?.spawnDescriptor;
    assert.ok(descriptor);
    assert.equal(descriptor.cwd, realpathSync(harness.workspace), "the exact saved header cwd is the child workspace");
    assert.deepEqual(descriptor.args.slice(0, 6), [
      "--extension", join(harness.packageRoot, "dist", "src", "session-host", "reporter.js"),
      "--extension", join(harness.packageRoot, "dist", "src", "index.js"),
      "--session", file,
    ], "the exact --session pair is composed after the extension pairs");
    assert.equal(viewFor(harness.manager, id).lifecycle, "alive");
  } finally {
    cleanup(harness);
  }
});

test("saved-session duplicate fencing: concurrent and live reservations, released only on confirmed exit", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("fence");
  try {
    writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "one.jsonl", "saved-fence-1", harness.workspace);
    const admission = await admissionFor(harness, "saved-fence-1");

    // Concurrent deliberate opens: the second is fenced synchronously by the
    // first create's reservation, before any await.
    const first = harness.manager.create({ workspace: admission.workspace, savedSession: admission });
    await assert.rejects(
      harness.manager.create({ workspace: admission.workspace, savedSession: admission }),
      /already open in this host/,
    );
    const idA = await first;

    // A live row with the reservation still fences a later deliberate open.
    await assert.rejects(
      harness.manager.create({ workspace: admission.workspace, savedSession: admission }),
      /already open in this host/,
    );
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "reservation", id: "saved-fence-1", file: admission.file },
      { kind: "current" },
    ], "the exact reservation stays paired and live current binding remains independently unknown");

    // Only the exact owned PTY's actual exit releases the reservation.
    harness.spawned[0]!.emitExit(0);
    assert.equal(harness.manager.closeExited(idA), true);
    const idB = await harness.manager.create({ workspace: admission.workspace, savedSession: admission });
    assert.equal(viewFor(harness.manager, idB).lifecycle, "alive", "exited rows never block reopening");
  } finally {
    cleanup(harness);
  }
});

test("saved-session reservation is released when creation definitively fails before a child exists", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("release-fail");
  try {
    writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "one.jsonl", "saved-release-1", harness.workspace);
    const admission = await admissionFor(harness, "saved-release-1");

    let failNextSpawn = true;
    const originalFactory = harness.ptyFactory;
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      ptyFactory: (descriptor) => {
        if (failNextSpawn) {
          failNextSpawn = false;
          throw new Error("synthetic spawn failure");
        }
        return originalFactory(descriptor);
      },
    });

    const failedId = await manager.create({ workspace: admission.workspace, savedSession: admission });
    assert.equal(viewFor(manager, failedId).lifecycle, "error", "the failed row is contained to itself");
    // The reservation is released with the pre-child failure: reopening works.
    const retryId = await manager.create({ workspace: admission.workspace, savedSession: admission });
    assert.equal(viewFor(manager, retryId).lifecycle, "alive");
  } finally {
    cleanup(harness);
  }
});

test("known native bindings fence duplicate saved admissions across disconnect and replace on rebind", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("rebind");
  try {
    const proj = join(harness.agentDir, "sessions", "proj");
    writeSavedSessionFile(proj, "x.jsonl", "conv-x", harness.workspace);
    writeSavedSessionFile(proj, "y.jsonl", "conv-y", harness.workspace2);
    // One catalog mints both admissions at the same revision.
    const catalog = await listSavedSessions({ agentDir: harness.agentDir, listAll: makeSavedListAll() });
    const rowX = catalog.rows.find((candidate) => candidate.id === "conv-x");
    const rowY = catalog.rows.find((candidate) => candidate.id === "conv-y");
    assert.ok(rowX && rowY);
    const admittedX = admitSavedSession(catalog, rowX);
    const admittedY = admitSavedSession(catalog, rowY);
    assert.equal(admittedX.status, "admitted");
    assert.equal(admittedY.status, "admitted");
    if (admittedX.status !== "admitted" || admittedY.status !== "admitted") throw new Error("unreachable");

    const id = await harness.manager.create({ label: "ordinary", workspace: harness.workspace });
    const entry = harness.registrar.entryFor(id);

    // The observed current binding fences the same conversation's admission.
    harness.registrar.emitStatus(entry, { busy: null, pendingInput: null, inputSurface: false, activity: [], nativeSession: { sessionId: "conv-x", epoch: 1, name: "Conversation X" } });
    await assert.rejects(
      harness.manager.create({ workspace: admittedX.admission.workspace, savedSession: admittedX.admission }),
      /already open in this host/,
    );

    // A status disconnect retains the last-known CURRENT binding.
    harness.registrar.emitDisconnect(entry);
    await assert.rejects(
      harness.manager.create({ workspace: admittedX.admission.workspace, savedSession: admittedX.admission }),
      /already open in this host/,
    );

    // A newer observed binding (native /new or /resume) replaces it.
    harness.registrar.emitStatus(entry, { busy: null, pendingInput: null, inputSurface: false, activity: [], nativeSession: { sessionId: "conv-y", epoch: 2, name: "Conversation Y" } });
    await assert.rejects(
      harness.manager.create({ workspace: admittedY.admission.workspace, savedSession: admittedY.admission }),
      /already open in this host/,
    );
    const reopened = await harness.manager.create({ workspace: admittedX.admission.workspace, savedSession: admittedX.admission });
    assert.equal(viewFor(harness.manager, reopened).lifecycle, "alive", "the replaced conversation can be opened again");
  } finally {
    cleanup(harness);
  }
});

test("current-file ownership stays private, rebinds from status, and never borrows a saved reservation path", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("current-file-rebind");
  try {
    writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "x.jsonl", "saved-current-x", harness.workspace);
    const admission = await admissionFor(harness, "saved-current-x");
    const id = await harness.manager.create({ workspace: admission.workspace, savedSession: admission });
    const entry = harness.registrar.entryFor(id);

    harness.registrar.emitStatus(entry, {
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: {
        sessionId: admission.sessionId,
        epoch: 1,
        name: "Loaded conversation",
        currentFile: admission.file,
      },
    });
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "reservation", id: admission.sessionId, file: admission.file },
      { kind: "current", id: admission.sessionId, file: admission.file },
    ], "current and pending bindings are distinct even when they currently name the same file");
    assert.equal(viewFor(harness.manager, id).nativeSession?.currentFile, undefined,
      "private file observations do not enter the manager's display view");

    const plannedNewFile = "/synthetic/not-yet-saved-new.jsonl";
    harness.registrar.emitStatus(entry, {
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: {
        sessionId: "native-new-id",
        epoch: 2,
        name: "New conversation",
        currentFile: plannedNewFile,
      },
    });
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "current", id: "native-new-id", file: plannedNewFile },
    ], "native /new or /resume replaces both current ID and actual planned file, not an old reservation");

    harness.registrar.emitStatus(entry, {
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      nativeSession: {
        sessionId: "native-new-id",
        epoch: 2,
        name: "New conversation",
        currentFile: "relative/invalid.jsonl",
      },
    });
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "current", id: "native-new-id" },
    ], "an invalid optional path revokes the earlier current-file observation");

    harness.registrar.emitDisconnect(entry);
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "current" },
      { kind: "known-id", id: "native-new-id" },
    ], "disconnect revokes current path while retaining only a separately classified launch duplicate fence");
  } finally {
    cleanup(harness);
  }
});

test("reporter protocol current file reaches the production manager and Main deletion guard", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("reporter-main-current-file");
  const savedFile = writeSavedSessionFile(
    join(harness.agentDir, "sessions", "proj"),
    "same-file-different-catalog-id.jsonl",
    "catalog-header-id-b",
    harness.workspace,
  );
  const catalog = await listSavedSessions({ agentDir: harness.agentDir, listAll: makeSavedListAll() });
  const row = catalog.rows.find((candidate) => candidate.id === "catalog-header-id-b");
  assert.ok(row);

  const channels = new Map<string, StatusBrokerStatusHandlers>();
  const bootstraps = new Map<string, StatusRegistration["bootstrap"]>();
  const socketPath = `/tmp/prg-synthetic-${randomUUID()}.sock`;
  const generation = randomUUID();
  const token = "a".repeat(64);
  const broker: StatusBroker = {
    socketPath,
    generation,
    register(instanceId, handlers) {
      const bootstrap: StatusRegistration["bootstrap"] = {
        version: 1,
        socketPath,
        token,
        instanceId,
        generation,
      };
      channels.set(instanceId, handlers);
      bootstraps.set(instanceId, bootstrap);
      return {
        bootstrap,
        rename: async (request) => ({
          requestId: randomUUID(),
          status: "unavailable",
          expectedSessionId: request.expectedSessionId,
          expectedSessionEpoch: request.expectedSessionEpoch,
          observedSessionId: null,
          observedSessionEpoch: null,
        }),
        shutdown: async () => ({ requestId: randomUUID(), status: "unavailable" }),
        release: () => { channels.delete(instanceId); },
      };
    },
    async dispose() { channels.clear(); },
  };
  const manager = new InstanceManager({
    packageRoot: harness.packageRoot,
    piExecutable: harness.piExecutable,
    statusRegistrar: mainTest.statusRegistrar(broker),
    nativeSetup: false,
    profileRegistry: harness.profileRegistry,
    env: harness.env,
    ptyFactory: harness.ptyFactory,
  });

  const envNames = [HOST_BOOTSTRAP_ENV, SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV,
    "PI_REVIEW_GATE_RUNTIME_ROLE"] as const;
  const oldEnv = new Map(envNames.map((key) => [key, process.env[key]] as const));
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const privateGlobalKeys = [
    SESSION_HOST_STICKY_STATE_KEY,
    Symbol.for("pi-review-gate.session-host.startup-request.v1"),
    Symbol.for("pi-review-gate.session-host.title-columns.v1"),
  ] as const;
  const oldGlobal = new Map(privateGlobalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  for (const key of privateGlobalKeys) delete globalScope[key];

  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = { on(name: string, callback: (...args: unknown[]) => unknown) {
    hooks.set(name, [...(hooks.get(name) ?? []), callback]);
  } };
  const trigger = async (name: string, ...args: unknown[]): Promise<void> => {
    for (const callback of hooks.get(name) ?? []) await callback(...args);
  };
  const sockets: net.Socket[] = [];
  let currentId = "old-live-id-a";
  let currentFile: string | undefined = savedFile;
  const context = () => ({
    mode: "tui",
    ui: { setWidget() {} },
    isIdle: () => false,
    sessionManager: {
      getSessionId: () => currentId,
      getSessionName: () => "Synthetic current conversation",
      getEntries: () => [],
      getSessionFile: () => currentFile,
    },
  });
  let reporterStarted = false;
  let instanceId: string | undefined;
  try {
    for (const key of envNames) delete process.env[key];
    const id = await manager.create({ workspace: harness.workspace });
    instanceId = id;
    const bootstrap = bootstraps.get(id);
    assert.ok(bootstrap);
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);

    await activateReporter(pi, {
      reconnectDelayMs: 60_000,
      maxReconnectAttempts: 0,
      connectSocket: (address) => {
        assert.equal(address, bootstrap.socketPath);
        const socket = new net.Socket();
        let buffered = "";
        let authenticated = false;
        socket.write = ((chunk: string | Uint8Array) => {
          buffered += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline + 1);
            buffered = buffered.slice(newline + 1);
            const message = decodeFrame(line);
            if (message?.type === "hello") {
              authenticated = message.instanceId === bootstrap.instanceId
                && message.generation === bootstrap.generation
                && message.token === bootstrap.token;
            } else if (message?.type === "status" && authenticated
              && message.instanceId === bootstrap.instanceId
              && message.generation === bootstrap.generation) {
              channels.get(id)?.onStatus(message as SessionHostStatus);
            }
          }
          return true;
        }) as typeof socket.write;
        sockets.push(socket);
        return socket;
      },
    });
    reporterStarted = true;

    await trigger("session_start", { type: "session_start" }, context());
    sockets.at(-1)?.emit("connect");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.list()[0]?.nativeSession?.sessionId, currentId);
    assert.equal(manager.list()[0]?.nativeSession?.currentFile, undefined,
      "the manager's display view strips authenticated path data");
    assert.equal(JSON.stringify(manager.list()).includes(savedFile), false,
      "the actual saved path never enters the public manager view");
    assert.notEqual(currentId, row.id, "the live session ID remains the pre-catalog value while the saved header has changed");
    const firstGuardSnapshot = mainTest.savedDeletionOwnedSessions(manager);
    assert.deepEqual(firstGuardSnapshot, [{ kind: "current", id: currentId, file: savedFile }]);
    assert.equal(mainTest.validateOwnedSavedSessionDeletion(manager, catalog, row), "known-owned-duplicate",
      "Main blocks deletion by current real file even though the live ID differs from the catalog header ID");

    currentId = "new-live-id-b";
    currentFile = join(harness.root, "planned-new-unsaved.jsonl");
    await trigger("session_start", { type: "session_start", reason: "synthetic-resume" }, context());
    sockets.at(-1)?.emit("connect");
    await new Promise((resolve) => setImmediate(resolve));
    const reboundSnapshot = mainTest.savedDeletionOwnedSessions(manager);
    assert.deepEqual(reboundSnapshot, [{ kind: "current", id: currentId, file: currentFile }],
      "the production reporter/protocol/manager path replaces the current loaded file on /new or /resume");
    assert.equal(mainTest.validateOwnedSavedSessionDeletion(manager, catalog, row), undefined,
      "once rebound, the old actual file is no longer protected by an unrelated live ID");

    currentFile = undefined;
    await trigger("session_info_changed", { type: "session_info_changed" }, context());
    const unavailableSnapshot = mainTest.savedDeletionOwnedSessions(manager);
    assert.deepEqual(unavailableSnapshot, [{ kind: "current", id: currentId }],
      "a missing current-file observation clears the last path instead of retaining it as current");
    assert.equal(mainTest.validateOwnedSavedSessionDeletion(manager, catalog, row), "unknown-live-binding",
      "Main fails closed when the live reporter cannot observe its current file");
  } finally {
    if (reporterStarted) await trigger("session_shutdown", { type: "session_shutdown" }, context()).catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    if (instanceId !== undefined) {
      harness.spawned.at(-1)?.emitExit(0);
      manager.closeExited(instanceId);
    }
    await manager.dispose().catch(() => undefined);
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, descriptor] of oldGlobal) {
      if (descriptor === undefined) delete globalScope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    cleanup(harness);
  }
});

test("loaded activity telemetry recovers through the production reporter/protocol/manager path", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("reporter-main-activity-recovery");
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  const channels = new Map<string, StatusBrokerStatusHandlers>();
  const bootstraps = new Map<string, StatusRegistration["bootstrap"]>();
  const socketPath = `/tmp/prg-synthetic-${randomUUID()}.sock`;
  const generation = randomUUID();
  const token = "a".repeat(64);
  const broker: StatusBroker = {
    socketPath,
    generation,
    register(instanceId, handlers) {
      const bootstrap: StatusRegistration["bootstrap"] = { version: 1, socketPath, token, instanceId, generation };
      channels.set(instanceId, handlers);
      bootstraps.set(instanceId, bootstrap);
      return {
        bootstrap,
        rename: async (request) => ({ requestId: randomUUID(), status: "unavailable", expectedSessionId: request.expectedSessionId, expectedSessionEpoch: request.expectedSessionEpoch, observedSessionId: null, observedSessionEpoch: null }),
        shutdown: async () => ({ requestId: randomUUID(), status: "unavailable" }),
        release: () => { channels.delete(instanceId); },
      };
    },
    async dispose() { channels.clear(); },
  };
  const manager = new InstanceManager({
    packageRoot: harness.packageRoot,
    piExecutable: harness.piExecutable,
    statusRegistrar: mainTest.statusRegistrar(broker),
    nativeSetup: false,
    profileRegistry: harness.profileRegistry,
    env: harness.env,
    ptyFactory: harness.ptyFactory,
  });

  const envNames = [HOST_BOOTSTRAP_ENV, SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV, "PI_REVIEW_GATE_RUNTIME_ROLE"] as const;
  const oldEnv = new Map(envNames.map((key) => [key, process.env[key]] as const));
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const privateGlobalKeys = [SESSION_HOST_STICKY_STATE_KEY, Symbol.for("pi-review-gate.session-host.startup-request.v1"), Symbol.for("pi-review-gate.session-host.title-columns.v1")] as const;
  const oldGlobal = new Map(privateGlobalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  for (const key of privateGlobalKeys) delete globalScope[key];

  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = { on(name: string, callback: (...args: unknown[]) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); } };
  const trigger = async (name: string, ...args: unknown[]): Promise<void> => { for (const callback of hooks.get(name) ?? []) await callback(...args); };
  const sockets: net.Socket[] = [];
  const context = () => ({ mode: "tui", ui: { setWidget() {} }, isIdle: () => false, sessionManager: { getSessionId: () => "activity-recovery-id", getSessionName: () => "Activity recovery", getEntries: () => [], getSessionFile: () => undefined } });

  // Production source registration: hold a real review run before opt-in.
  const run = beginOwnedReviewActivity();
  registerReviewActivitySource();
  let executionReady = false;
  registerOwnedActivitySource("backgroundTasks", "execution", {
    intentUncertain: true,
    refreshActivity: () => executionReady ? { status: "complete", intentTokens: new Set<string>() } : { status: "incomplete" },
  });

  let instanceId: string | undefined;
  let settled = false;
  try {
    for (const key of envNames) delete process.env[key];
    const id = await manager.create({ workspace: harness.workspace });
    instanceId = id;
    const bootstrap = bootstraps.get(id);
    assert.ok(bootstrap);
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);

    await activateReporter(pi, {
      reconnectDelayMs: 60_000,
      maxReconnectAttempts: 0,
      connectSocket: (address) => {
        assert.equal(address, bootstrap.socketPath);
        const socket = new net.Socket();
        let buffered = "";
        let authenticated = false;
        socket.write = ((chunk: string | Uint8Array) => {
          buffered += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline + 1);
            buffered = buffered.slice(newline + 1);
            const message = decodeFrame(line);
            if (message?.type === "hello") {
              authenticated = message.instanceId === bootstrap.instanceId && message.generation === bootstrap.generation;
            } else if (message?.type === "status" && authenticated && message.instanceId === bootstrap.instanceId && message.generation === bootstrap.generation) {
              channels.get(id)?.onStatus(message as SessionHostStatus);
            }
          }
          return true;
        }) as typeof socket.write;
        sockets.push(socket);
        return socket;
      },
    });

    const viewActivity = (): number | null | undefined => manager.list().find((entry) => entry.id === id)?.activeTasks;
    const waitForActivity = async (expected: number | null, what: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      for (;;) {
        if (viewActivity() === expected) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; loaded activeTasks is ${String(viewActivity())}`);
        await sleep(5);
      }
    };

    // Startup with the execution source still incomplete: the loaded host must
    // stay unknown — never a fabricated zero.
    await trigger("session_start", { type: "session_start" }, context());
    sockets.at(-1)?.emit("connect");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(viewActivity(), null, "incomplete startup evidence stays unknown on the loaded host");

    // The execution source's readiness completes at a later genuine lifecycle
    // event; the held review run must publish as known nonzero.
    executionReady = true;
    await trigger("session_start", { type: "session_start", reason: "synthetic-readiness" }, context());
    sockets.at(-1)?.emit("connect");
    await new Promise((resolve) => setImmediate(resolve));
    await waitForActivity(1, "the held review run to publish as known nonzero");

    // Deliberately stale loaded telemetry while the run is still held.
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "review"), "mark the held review source uncertain");
    await waitForActivity(null, "stale telemetry to publish unknown on the loaded host");
    await waitForActivity(1, "automatic recovery to publish nonzero without a prompt or admission");

    // Settle the run; authoritative state is now idle.
    endOwnedReviewActivity(run);
    settled = true;
    await waitForActivity(0, "settlement to publish the exact zero");

    // Deliberately stale telemetry again while the source already knows zero:
    // independent unknown-to-zero recovery through the same publication path.
    assert.ok(ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "review"), "mark the idle review source uncertain");
    await waitForActivity(null, "stale telemetry to publish unknown again");
    await waitForActivity(0, "automatic recovery to publish the exact idle zero");
  } finally {
    if (!settled) endOwnedReviewActivity(run);
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    for (const socket of sockets) socket.destroy();
    await manager.dispose().catch(() => {});
    await broker.dispose();
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, descriptor] of oldGlobal) {
      if (descriptor === undefined) delete globalScope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    cleanup(harness);
  }
});

test("real reporter/protocol/broker/manager rendered row recovers fresh zero and nonzero activity on request", { skip: process.platform === "win32" }, async () => {
  const harness = makeHarness("reporter-broker-request");
  ownedActivityTest.resetOwnedActivityForTests();
  reviewActivityTest.resetReviewActivityForTests();
  let tokens = new Set<string>();
  const execution = registerOwnedActivitySource("backgroundTasks", "execution", {
    intentUncertain: true,
    refreshActivity: () => ({ status: "complete", intentTokens: new Set(tokens) }),
  } as unknown as Parameters<typeof registerOwnedActivitySource>[2]);
  registerReviewActivitySource();
  registerOwnedActivitySource("backgroundShells", "background-shell", {
    intentUncertain: true,
    refreshActivity: () => ({ status: "complete", intentTokens: new Set<string>() }),
  } as unknown as Parameters<typeof registerOwnedActivitySource>[2]);

  const socketRoot = realpathSync(mkdtempSync(join(tmpdir(), "prg-ar-")));
  const broker = await createStatusBroker({ socketRoot });
  const manager = new InstanceManager({
    packageRoot: harness.packageRoot,
    piExecutable: harness.piExecutable,
    statusRegistrar: mainTest.statusRegistrar(broker),
    nativeSetup: false,
    profileRegistry: harness.profileRegistry,
    env: cleanTestEnv(),
    ptyFactory: harness.ptyFactory,
  });
  const envNames = [HOST_BOOTSTRAP_ENV, SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV, "PI_REVIEW_GATE_RUNTIME_ROLE"] as const;
  const oldEnv = new Map(envNames.map((key) => [key, process.env[key]] as const));
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const privateGlobalKeys = [SESSION_HOST_STICKY_STATE_KEY, Symbol.for("pi-review-gate.session-host.restore-coordination.v1"), Symbol.for("pi-review-gate.session-host.startup-request.v1"), Symbol.for("pi-review-gate.session-host.title-columns.v1")] as const;
  const oldGlobal = new Map(privateGlobalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  for (const key of privateGlobalKeys) delete globalScope[key];
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = { on(name: string, callback: (...args: unknown[]) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); } };
  const trigger = async (name: string, ...args: unknown[]): Promise<void> => { for (const callback of hooks.get(name) ?? []) await callback(...args); };
  const sessionId = "restored-e2e-session";
  const context = { mode: "tui", ui: { setWidget() {} }, isIdle: () => true, sessionManager: { getSessionId: () => sessionId, getSessionName: () => "Restored E2E", getEntries: () => [] } };
  let instanceId: string | undefined;
  let reporterStarted = false;
  try {
    for (const key of envNames) delete process.env[key];
    instanceId = await manager.create({ workspace: harness.workspace });
    const bootstrap = JSON.parse(String(harness.spawned[0]!.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV])) as Record<string, unknown>;
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);
    await activateReporter(pi, { reconnectDelayMs: 40, maxReconnectAttempts: 2 });
    reporterStarted = true;
    // The gate's own restore hook runs after the reporter's hook. Its marker
    // is what makes the first loaded status wait for the restored boundary.
    pi.on("session_start", async () => {
      const completion = beginSessionHostRestore(sessionId);
      completeSessionHostRestore(completion);
    });
    await trigger("session_start", { type: "session_start", reason: "startup" }, context);
    const waitForView = async (predicate: (view: NativeInstanceView) => boolean, what: string): Promise<NativeInstanceView> => {
      const deadline = Date.now() + 4_000;
      for (;;) {
        const view = manager.list().find((row) => row.id === instanceId);
        if (view && predicate(view)) return view;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; view is ${JSON.stringify(view)}`);
        await sleep(5);
      }
    };
    const renderRow = (view: NativeInstanceView): string => {
      const sidebar = new SidebarController({ onAction: () => undefined });
      sidebar.updateItems([mainTest.toSidebarItem(view)]);
      return sidebar.renderRoster(32, 20).lines.join("\n");
    };

    const first = await waitForView(
      (view) => view.busy === false && view.activeTasks === 0 && view.activeShells === 0,
      "first restored Ready to show actual idle/zero",
    );
    assert.equal(first.hasLiveProcess, true, "the restored row remains owned by a live child");
    assert.match(renderRow(first), /bg tasks 0 \| shells 0/u,
      "the complete rendered row shows actual restored idle/zero at first Ready");

    // Durable ownership is independent of the ephemeral activity request.
    // The synthetic execution source resolves its replayed ownership
    // uncertainty exactly as the real controller's restore does.
    execution.resolveUncertainty();
    execution.acquire("e2e-durable-ownership");
    await waitForView((view) => view.backgroundTasks === 1, "durable ownership to publish");

    // Deliberately stale host/client understanding: the owning source actually
    // holds one intent token, while the last displayed value was zero. The host
    // asks the exact live client for a complete fresh census.
    tokens = new Set(["e2e-fresh-intent"]);
    ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution");
    assert.equal(await manager.refreshActivity(instanceId), "complete");
    const nonzero = await waitForView((view) => view.activeTasks === 1, "fresh nonzero intent");
    assert.equal(nonzero.backgroundTasks, 1, "durable ownership is preserved across the activity request");
    assert.match(renderRow(nonzero), /bg tasks 1 \| shells 0/u);

    // The opposite direction is just as fresh: actual zero replaces a cached
    // nonzero value without a prompt, task, restart, or manual refresh.
    tokens = new Set();
    ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution");
    assert.equal(await manager.refreshActivity(instanceId), "complete");
    const zero = await waitForView((view) => view.activeTasks === 0, "fresh idle zero intent");
    assert.equal(zero.backgroundTasks, 1);
    assert.match(renderRow(zero), /bg tasks 0 \| shells 0/u);

    // A repeated unknown episode recovers again.
    tokens = new Set(["e2e-second-intent"]);
    ownedActivityTest.markCurrentSourceIntentUncertainForTests("backgroundTasks", "execution");
    assert.equal(await manager.refreshActivity(instanceId), "complete");
    await waitForView((view) => view.activeTasks === 1, "repeated fresh nonzero intent");
  } finally {
    if (reporterStarted) await trigger("session_shutdown", { type: "session_shutdown" }, context).catch(() => undefined);
    ownedActivityTest.resetOwnedActivityForTests();
    reviewActivityTest.resetReviewActivityForTests();
    if (instanceId !== undefined) {
      harness.spawned.at(-1)?.emitExit(0);
      manager.closeExited(instanceId);
    }
    await manager.dispose().catch(() => undefined);
    await broker.dispose().catch(() => undefined);
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, descriptor] of oldGlobal) {
      if (descriptor === undefined) delete globalScope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    cleanup(harness);
  }
});

test("a dropped first automatic activity reply retries within the bounded episode budget", { skip: process.platform === "win32" }, async () => {
  const harness = makeHarness("activity-drop-retry");
  const socketRoot = realpathSync(mkdtempSync(join(tmpdir(), "prg-ar-retry-")));
  const broker = await createStatusBroker({ socketRoot });
  brokerTest.setActivityTimeoutForTests(60);
  const manager = new InstanceManager({
    packageRoot: harness.packageRoot,
    piExecutable: harness.piExecutable,
    statusRegistrar: mainTest.statusRegistrar(broker),
    nativeSetup: false,
    profileRegistry: harness.profileRegistry,
    env: cleanTestEnv(),
    ptyFactory: harness.ptyFactory,
  });
  let instanceId: string | undefined;
  let client: net.Socket | undefined;
  try {
    instanceId = await manager.create({ workspace: harness.workspace });
    const bootstrap = JSON.parse(String(harness.spawned[0]!.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV])) as {
      instanceId: string;
      generation: string;
      token: string;
    };
    const nativeSession = { sessionId: "retry-native-session", epoch: 1, name: "Retry" };
    const requests: Array<{ requestId: string; afterSequence: number }> = [];
    client = net.connect(broker.socketPath);
    await new Promise<void>((resolve, reject) => {
      client!.once("connect", resolve);
      client!.once("error", reject);
    });
    let buffered = "";
    client.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline + 1);
        buffered = buffered.slice(newline + 1);
        const message = decodeFrame(line);
        if (message?.type !== "activity_request") continue;
        requests.push({ requestId: message.requestId, afterSequence: message.afterSequence });
        if (requests.length === 1) continue; // Drop the first reply with no status push.
        client!.write(encodeFrame({
          version: 1,
          type: "activity_result",
          instanceId: bootstrap.instanceId,
          generation: bootstrap.generation,
          requestId: message.requestId,
          outcome: "complete",
          status: {
            version: 1,
            type: "status",
            instanceId: bootstrap.instanceId,
            generation: bootstrap.generation,
            sequence: 2,
            busy: false,
            pendingInput: false,
            inputSurface: false,
            activity: ["Ready"],
            backgroundTasks: 0,
            backgroundShells: 0,
            activeTasks: 3,
            activeShells: 0,
            nativeSession,
          },
          observedSessionId: nativeSession.sessionId,
          observedSessionEpoch: nativeSession.epoch,
        } as never));
      }
    });
    client.write(encodeFrame({
      version: 1,
      type: "hello",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      token: bootstrap.token,
      capabilities: [ACTIVITY_CENSUS_CAPABILITY],
    } as never));
    client.write(encodeFrame({
      version: 1,
      type: "status",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      sequence: 1,
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      backgroundTasks: null,
      backgroundShells: null,
      activeTasks: null,
      activeShells: null,
      nativeSession,
    } as never));

    await until(
      () => manager.list().find((view) => view.id === instanceId)?.activeTasks === 3,
      "automatic retry to recover the dropped reply without another lifecycle event",
      5000,
    );
    assert.ok(requests.length >= 2, "the manager retried a timed-out automatic census");
    assert.equal(requests[0]!.afterSequence, 1);
    assert.equal(requests[1]!.afterSequence, 1, "the retry is fenced to the last accepted sequence");
    const view = manager.list().find((candidate) => candidate.id === instanceId);
    assert.equal(view?.busy, false);
    assert.equal(view?.activeShells, 0);
  } finally {
    brokerTest.setActivityTimeoutForTests(undefined);
    client?.destroy();
    if (instanceId !== undefined) {
      harness.spawned.at(-1)?.emitExit(0);
      manager.closeExited(instanceId);
    }
    await manager.dispose().catch(() => undefined);
    await broker.dispose().catch(() => undefined);
    cleanup(harness);
  }
});

test("saved-origin rebind releases the initial reservation; the new binding stays fenced", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("rebind-saved");
  try {
    const proj = join(harness.agentDir, "sessions", "proj");
    writeSavedSessionFile(proj, "x.jsonl", "conv-x", harness.workspace);
    writeSavedSessionFile(proj, "y.jsonl", "conv-y", harness.workspace2);
    // One catalog mints both admissions at the same revision.
    const catalog = await listSavedSessions({ agentDir: harness.agentDir, listAll: makeSavedListAll() });
    const rowX = catalog.rows.find((candidate) => candidate.id === "conv-x");
    const rowY = catalog.rows.find((candidate) => candidate.id === "conv-y");
    assert.ok(rowX && rowY);
    const admittedX = admitSavedSession(catalog, rowX);
    const admittedY = admitSavedSession(catalog, rowY);
    assert.equal(admittedX.status, "admitted");
    assert.equal(admittedY.status, "admitted");
    if (admittedX.status !== "admitted" || admittedY.status !== "admitted") throw new Error("unreachable");

    // Open X through the saved picker: its reservation fences X while live.
    const idA = await harness.manager.create({ workspace: admittedX.admission.workspace, savedSession: admittedX.admission });
    const entry = harness.registrar.entryFor(idA);
    await assert.rejects(
      harness.manager.create({ workspace: admittedX.admission.workspace, savedSession: admittedX.admission }),
      /already open in this host/,
    );

    // The observed binding confirms X, then native /new moves the child to Y.
    harness.registrar.emitStatus(entry, { busy: null, pendingInput: null, inputSurface: false, activity: [], nativeSession: { sessionId: "conv-x", epoch: 1, name: "Conversation X" } });
    harness.registrar.emitStatus(entry, { busy: null, pendingInput: null, inputSurface: false, activity: [], nativeSession: { sessionId: "conv-y", epoch: 2, name: "Conversation Y" } });

    // The superseded reservation is released: X can be opened again...
    const idB = await harness.manager.create({ workspace: admittedX.admission.workspace, savedSession: admittedX.admission });
    assert.equal(viewFor(harness.manager, idB).lifecycle, "alive", "the replaced conversation can be opened again");
    // ...while the current binding Y stays fenced and is no longer paired with X's file.
    await assert.rejects(
      harness.manager.create({ workspace: admittedY.admission.workspace, savedSession: admittedY.admission }),
      /already open in this host/,
    );
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "current", id: "conv-y" },
      { kind: "reservation", id: "conv-x", file: rowX.file },
      { kind: "current" },
    ], "the rebound current ID is never paired with the new sibling's reserved file");
  } finally {
    cleanup(harness);
  }
});

test("saved admission is revalidated at the final checkpoint: a replaced file spawns no child", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("checkpoint");
  try {
    const proj = join(harness.agentDir, "sessions", "proj");
    const file = writeSavedSessionFile(proj, "one.jsonl", "saved-checkpoint-1", harness.workspace);
    const admission = await admissionFor(harness, "saved-checkpoint-1");

    // Replace the exact file during the final launch checkpoint (before the
    // admission revalidation): the child must never receive a path that no
    // longer matches the branded admission.
    setImmediate(() => {
      rmSync(file);
      writeSavedSessionFile(proj, "one.jsonl", "saved-checkpoint-2", harness.workspace);
    });
    const id = await harness.manager.create({ workspace: admission.workspace, savedSession: admission });
    assert.equal(viewFor(harness.manager, id).lifecycle, "error", "the replaced file is contained to an error row");
    assert.equal(harness.spawned.length, 0, "no child spawns from a stale admission");
    assert.deepEqual(harness.manager.ownedLiveSessions(), [], "the failed reservation is released");
  } finally {
    cleanup(harness);
  }
});

test("ownedLiveSessions reports live bindings and reservations only; exited rows contribute nothing", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("owned");
  try {
    writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "one.jsonl", "saved-owned-1", harness.workspace);
    const admission = await admissionFor(harness, "saved-owned-1");

    const pending = harness.manager.create({ workspace: admission.workspace, savedSession: admission });
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "reservation", id: "saved-owned-1", file: admission.file },
    ], "a reservation exists before a PTY-backed current binding is live");
    const idA = await pending;

    const idB = await harness.manager.create({ label: "ordinary", workspace: harness.workspace2 });
    const entry = harness.registrar.entryFor(idB);
    harness.registrar.emitStatus(entry, { busy: null, pendingInput: null, inputSurface: false, activity: [], nativeSession: { sessionId: "observed-binding", epoch: 1, name: "Observed" } });
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "reservation", id: "saved-owned-1", file: admission.file },
      { kind: "current" },
      { kind: "current", id: "observed-binding" },
    ]);

    harness.spawned[0]!.emitExit(0);
    harness.spawned[1]!.emitExit(0);
    assert.equal(harness.manager.closeExited(idA), true);
    assert.equal(harness.manager.closeExited(idB), true);
    assert.deepEqual(harness.manager.ownedLiveSessions(), [], "exited and removed rows never block reopening");
  } finally {
    cleanup(harness);
  }
});

test("status updates publish bounded owned-work counts and never fabricate zero", async () => {
  const harness = makeHarness("owned-counts");
  try {
    const id = await harness.manager.create({ label: "counts", workspace: harness.workspace });
    const entry = harness.registrar.entryFor(id);
    const counts = (): [number | null | undefined, number | null | undefined] => [
      viewFor(harness.manager, id).backgroundTasks,
      viewFor(harness.manager, id).backgroundShells,
    ];

    assert.deepEqual(counts(), [null, null], "no status yet: unknown, never a fabricated zero");

    harness.registrar.emitStatus(entry, {
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      backgroundTasks: 2,
      backgroundShells: 0,
    });
    assert.deepEqual(counts(), [2, 0], "observed counts are copied onto the immutable view");

    harness.registrar.emitStatus(entry, {
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      backgroundTasks: -1,
      backgroundShells: 1.5,
    });
    assert.deepEqual(counts(), [null, null], "invalid counts normalize to unknown");

    harness.registrar.emitStatus(entry, {
      busy: false,
      pendingInput: false,
      inputSurface: false,
      activity: [],
      backgroundShells: 1,
    });
    assert.deepEqual(counts(), [null, 1], "an older registrar omitting tasks stays unknown, never zero");

    harness.registrar.emitDisconnect(entry);
    assert.deepEqual(counts(), [null, null], "a reporter disconnect collapses counts to unknown");

    harness.registrar.emitStatus(entry, {
      busy: true,
      pendingInput: null,
      inputSurface: false,
      activity: ["Working"],
      backgroundTasks: 4,
      backgroundShells: 2,
    });
    assert.deepEqual(counts(), [4, 2]);
    harness.spawned[0]!.emitExit(0);
    assert.deepEqual(counts(), [null, null], "an actual child exit never retains a stale owned count");
  } finally {
    cleanup(harness);
  }
});

test("status updates publish activity intent independently of the ownership counts", async () => {
  const harness = makeHarness("activity-intent-counts");
  try {
    const id = await harness.manager.create({ label: "intent", workspace: harness.workspace });
    const entry = harness.registrar.entryFor(id);
    const view = (): { backgroundTasks?: number | null; backgroundShells?: number | null; activeTasks?: number | null; activeShells?: number | null } =>
      viewFor(harness.manager, id);

    harness.registrar.emitStatus(entry, {
      busy: null,
      pendingInput: null,
      inputSurface: false,
      activity: [],
      backgroundTasks: 1,
      backgroundShells: 0,
      activeTasks: 0,
      activeShells: 0,
    });
    assert.deepEqual(
      [view().activeTasks, view().activeShells, view().backgroundTasks, view().backgroundShells],
      [0, 0, 1, 0],
      "a retained ownership obligation with zero activity is carried independently",
    );

    harness.registrar.emitStatus(entry, {
      busy: false,
      pendingInput: false,
      inputSurface: false,
      activity: [],
      activeTasks: -1,
      activeShells: 1.5,
    });
    assert.deepEqual([view().activeTasks, view().activeShells], [null, null], "invalid intent normalizes to unknown");
    assert.deepEqual([view().backgroundTasks, view().backgroundShells], [null, null], "an omitted ownership count is unknown, never zero");

    harness.registrar.emitStatus(entry, {
      busy: false,
      pendingInput: false,
      inputSurface: false,
      activity: [],
      backgroundShells: 3,
    });
    assert.deepEqual([view().activeTasks, view().activeShells], [null, null], "an older registrar omitting intent keeps it unknown, never a fallback");

    harness.registrar.emitDisconnect(entry);
    assert.deepEqual([view().activeTasks, view().activeShells], [null, null], "a reporter disconnect collapses intent to unknown");
    harness.spawned[0]!.emitExit(0);
  } finally {
    cleanup(harness);
  }
});

// ---------------------------------------------------------------------------
// Opt-in native input framing: one host encoder per registration, gated on the
// child's authenticated readiness, covering BOTH hosted PTY write sources
// (local user input and TerminalSurface protocol replies).
//
// IMPORTANT EVIDENCE SCOPE: these cases use the same synthetic PTYs and
// synthetic registrar as the rest of this file. They prove the HOST-side
// contract only — strict mode propagation before spawn, refusal before an
// authenticated READY on this exact registration, closed origin classification of
// every framed write, per-registration encoder continuity, lifecycle fences, and
// that the legacy default stays byte-identical. They make no claim about the real
// PTY, a real Pi child's decoder installation order, Windows ConPTY, or any
// physical clipboard; the parent owns the native CLI proof.
// ---------------------------------------------------------------------------

const FRAMING_READY_PREFIX = "prg-native-input-ready-v1;";
const FRAMING_READY_DOMAIN = "pi-review-gate/native-input-ready/v1\0";
const FRAMING_HEX_TOKEN = "ab".repeat(32);
// Startup infrastructure output can query DA before the bridge is ready.
const EARLY_WINDOWS_TERMINAL_PREFIX = "\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h";
/**
 * A fresh valid hex64 registration token per row: the input codec derives its
 * HMAC key from exactly this production shape, and distinct keys are what make
 * cross-row readiness refusal mean something.
 */
const framingToken = (): string => randomBytes(32).toString("hex");
/** The private capsule OSC the child bridge writes on the same stdout stream. */
const capsuleOsc = (capsule: string): string => `\x1b]777;${capsule}\x07`;

type FramingBootstrap = InstanceStatusRegistration["bootstrap"];

/** Independently re-derive the child bridge's readiness wire format. */
function readyCapsule(
  bootstrap: FramingBootstrap,
  overrides: { token?: string; instanceId?: string; generation?: string; body?: Record<string, unknown> } = {},
): string {
  const body = JSON.stringify(overrides.body ?? {
    version: 1,
    kind: "input-framing-ready",
    instanceId: overrides.instanceId ?? bootstrap.instanceId,
    generation: overrides.generation ?? bootstrap.generation,
  });
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const mac = createHmac("sha256", Buffer.from(overrides.token ?? bootstrap.token, "hex"))
    .update(FRAMING_READY_DOMAIN).update(encoded).digest("hex");
  return `${FRAMING_READY_PREFIX}${encoded};${mac}`;
}

/** Verify a framed host write with this registration's own decoder. */
function decodeFramedWrite(bootstrap: FramingBootstrap, framed: string, decoder = createNativeInputDecoder(bootstrap)): NativeInputFragment[] {
  assert.equal(typeof framed, "string");
  assert.notEqual(framed, "", "a framed write carries its framing bytes");
  const fed = decoder.feed(framed);
  assert.equal(fed.ok, true, `the framed write authenticates against this registration: ${fed.ok ? "" : fed.code}`);
  const closed = decoder.finish();
  assert.equal(closed.ok, true, "one host write is one complete logical dispatch");
  return [...fed.fragments];
}

function framedPayload(bootstrap: FramingBootstrap, framed: string): { text: string; origin: NativeInputOrigin } {
  const fragments = decodeFramedWrite(bootstrap, framed);
  assert.equal(fragments.length, 1, "short host input travels as one fragment");
  const first = fragments[0]!;
  assert.deepEqual([first.start, first.end], [true, true]);
  return { text: first.payload.toString("utf8"), origin: first.origin };
}

interface FramingHarness {
  root: string;
  workspace: string;
  packageRoot: string;
  piExecutable: string;
  registrar: FakeRegistrar;
  spawned: FakePty[];
  manager: InstanceManager;
  /** The caller's own env object; the manager and launch must never mutate it. */
  callerEnv: NodeJS.ProcessEnv;
}

function makeFramingHarness(
  label: string,
  options: {
    framing?: boolean;
    onNativeClipboard?: (instanceId: string, event: NativeClipboardEvent) => void;
    getSupportedKeyboardFlags?: () => number;
  } = {},
): FramingHarness {
  const root = makeTestRoot(label);
  const pkg = makePackageFixture(root);
  const home = join(root, "home");
  const agentDir = join(root, "native-agent");
  const sessionDir = join(agentDir, "sessions");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const callerEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
  };
  const registrar = new FakeRegistrar();
  const spawned: FakePty[] = [];
  const manager = new InstanceManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: registrar,
    args: [],
    // A clone: the harness keeps the original object to prove it stays untouched.
    env: { ...callerEnv },
    ptyFactory: (descriptor) => {
      const pty = new FakePty(descriptor);
      pty.exitsOnSignal = "SIGTERM";
      spawned.push(pty);
      return pty;
    },
    ...(options.framing === undefined ? {} : { nativeInputOriginFraming: options.framing }),
    ...(options.onNativeClipboard === undefined ? {} : { onNativeClipboard: options.onNativeClipboard }),
    ...(options.getSupportedKeyboardFlags === undefined ? {} : { getSupportedKeyboardFlags: options.getSupportedKeyboardFlags }),
  });
  return { root, workspace, packageRoot: pkg.packageRoot, piExecutable: pkg.piExecutable, registrar, spawned, manager, callerEnv };
}

interface FramingRow {
  id: string;
  pty: FakePty;
  bootstrap: FramingBootstrap;
  entry: RegistrarEntry;
}

async function createFramingRow(harness: FramingHarness): Promise<FramingRow> {
  // The codec derives its key from the production hex64 registration token shape,
  // and every registration gets its OWN token so no row can borrow another's
  // readiness, framed bytes, or capsules.
  harness.registrar.nextToken = framingToken();
  const id = await harness.manager.create({ workspace: harness.workspace });
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "creating a row spawns its owned child");
  const entry = harness.registrar.entries.find((candidate) => candidate.instanceId === id);
  assert.ok(entry, "creating a row registers it");
  assert.equal(entry.released, false);
  return { id, pty, bootstrap: entry.bootstrap, entry };
}

/**
 * Deliver this row's readiness capsule on its own stdout stream and wait for the
 * parse that verifies it: readiness is observed by the terminal parser, so a
 * later write in the same tick is still honestly refused.
 */
async function markReady(harness: FramingHarness, row: FramingRow): Promise<void> {
  row.pty.emitData(capsuleOsc(readyCapsule(row.bootstrap)));
  await harness.manager.surface(row.id)?.flush();
}

/** Deliver bytes and wait for the parse that may produce a query reply. */
async function deliver(harness: FramingHarness, row: FramingRow, data: string): Promise<void> {
  row.pty.emitData(data);
  await harness.manager.surface(row.id)?.flush();
}

async function disposeFramingHarness(harness: FramingHarness): Promise<void> {
  for (const pty of harness.spawned) pty.emitExit(0);
  await harness.manager.dispose();
  rmSync(harness.root, { recursive: true, force: true });
}

test("an opted-in native row records the closed mode in its actual bootstrap and spawn env before the child exists", async () => {
  const harness = makeFramingHarness("framing-propagation", { framing: true });
  const callerEnvBefore = JSON.stringify(harness.callerEnv);
  try {
    const row = await createFramingRow(harness);
    const request = harness.registrar.registrationRequests.at(-1);
    assert.deepEqual(request, { instanceId: row.id, options: { inputOriginFraming: true } },
      "the registration request carries the closed opt-in");
    assert.equal(row.bootstrap.inputOriginFraming, 1, "the mode lives in the bootstrap the host hands to the child");
    // The child receives this object only as one-shot JSON env: the marker must
    // survive serialization into the actual spawn environment.
    const spawnBootstrap = JSON.parse(row.pty.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string) as FramingBootstrap;
    assert.equal(spawnBootstrap.inputOriginFraming, 1, "the mode is present before the child exists");
    assert.equal(spawnBootstrap.token, row.bootstrap.token);
    assert.equal(row.pty.spawnDescriptor.env.PI_CLIPBOARD_OSC52, "1",
      "the supported static capture flag is supplied for this opted-in native launch only");
    assert.equal(JSON.stringify(harness.callerEnv), callerEnvBefore, "the caller's env object is never mutated");
    // Exactly one registration carried the request, and the marker reached the
    // child through the one-shot spawn env (registration strictly precedes spawn).
    assert.equal(harness.registrar.registrationRequests.length, 1, "one registration per row");
    // Nothing has been written yet, and nothing may be before readiness.
    assert.deepEqual(row.pty.writes, [], "no byte reaches a framing child before readiness");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the framing opt-in is a closed boolean and never applies to a non-native manager", () => {
  const harness = makeFramingHarness("framing-opt-in-validation");
  try {
    const base = {
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: new FakeRegistrar(),
      args: [],
      env: { ...harness.callerEnv },
      ptyFactory: (descriptor: InstanceSpawnDescriptor) => new FakePty(descriptor),
    };
    // Constructing these managers spawns nothing; both refusals happen in the
    // constructor before any registration, launch, or child exists.
    assert.throws(
      () => new InstanceManager({ ...base, nativeInputOriginFraming: "yes" as never }),
      /must be a boolean or absent/,
      "a malformed opt-in is refused instead of guessing",
    );
    assert.throws(
      () => new InstanceManager({
        ...base,
        nativeSetup: false,
        profileRegistry: new ProfileRegistry({ stateRoot: join(harness.root, "state") }),
        nativeInputOriginFraming: true,
      }),
      /available only for native setup launches/,
      "a legacy private-profile manager can never frame input",
    );
    // The explicit default is the legacy manager, unchanged.
    const legacy = new InstanceManager({ ...base, nativeInputOriginFraming: false });
    assert.equal(harness.spawned.length, 0);
    void legacy.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a default manager keeps legacy PTY bytes and a legacy bootstrap byte-for-byte", async () => {
  const harness = makeFramingHarness("framing-default-legacy");
  try {
    const row = await createFramingRow(harness);
    assert.equal(Object.hasOwn(row.bootstrap, "inputOriginFraming"), false, "absence is the legacy bootstrap");
    const spawnBootstrap = JSON.parse(row.pty.spawnDescriptor.env[SESSION_HOST_BOOTSTRAP_ENV] as string) as Record<string, unknown>;
    assert.equal(Object.hasOwn(spawnBootstrap, "inputOriginFraming"), false);
    assert.equal(row.pty.spawnDescriptor.env.PI_CLIPBOARD_OSC52, undefined,
      "an ordinary native launch never gains the capture flag");
    // Legacy rows forward exactly the bytes they were given, in whatever type.
    harness.manager.write(row.id, "ls -la\r");
    harness.manager.write(row.id, Buffer.from([0x1b, 0x5b, 0x41]));
    assert.deepEqual(row.pty.writes, ["ls -la\r", Buffer.from([0x1b, 0x5b, 0x41])]);
    // Early automatic replies on a legacy row still go out raw, without READY.
    await deliver(harness, row, EARLY_WINDOWS_TERMINAL_PREFIX);
    await deliver(harness, row, "\x1b[>7u\x1b[?u");
    assert.deepEqual(row.pty.writes.slice(2), ["\x1b[?1;2c", "\x1b[?7u"]);
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "alive");
    // A legacy row also ignores readiness capsules entirely: no mode, no framing.
    await markReady(harness, row);
    harness.manager.write(row.id, "after-foreign-ready");
    assert.deepEqual(row.pty.writes.at(-1), "after-foreign-ready");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a framing row refuses every write until its own verified readiness, then frames local input", async () => {
  const harness = makeFramingHarness("framing-readiness", { framing: true });
  try {
    const row = await createFramingRow(harness);

    // Refusal before readiness: an honest error and zero bytes, never raw input.
    assert.throws(() => harness.manager.write(row.id, "typed-before-ready"), /refusing unframed input/);
    assert.equal(row.pty.writes.length, 0, "a refused framing write puts nothing in the child");

    // A readiness capsule signed by a foreign registration arms nothing.
    const foreign: FramingBootstrap = { ...row.bootstrap, token: "cd".repeat(32) };
    await deliver(harness, row, capsuleOsc(readyCapsule(foreign)));
    assert.throws(() => harness.manager.write(row.id, "still-refused"), /refusing unframed input/);

    // A valid capsule for a different generation, kind, or MAC is refused too.
    await deliver(harness, row, capsuleOsc(readyCapsule(row.bootstrap, { generation: randomUUID() })));
    await deliver(harness, row, capsuleOsc(readyCapsule(row.bootstrap, { body: {
      version: 1, kind: "clipboard-copy-ready",
      instanceId: row.bootstrap.instanceId, generation: row.bootstrap.generation,
    } })));
    const tampered = readyCapsule(row.bootstrap);
    await deliver(harness, row, capsuleOsc(`${tampered.slice(0, -1)}${tampered.endsWith("0") ? "1" : "0"}`));
    assert.throws(() => harness.manager.write(row.id, "still-refused"), /refusing unframed input/);
    assert.equal(row.pty.writes.length, 0, "no refused readiness ever produced a byte");

    // The child's own readiness for THIS registration arms exactly this row.
    await markReady(harness, row);
    const text = "ünïcödé ⌨ — αβ\n";
    harness.manager.write(row.id, text);
    const framed = row.pty.writes.at(-1);
    assert.equal(typeof framed, "string");
    const framedText = framed as string;
    assert.ok(framedText.startsWith("prg-ni-v2;"), "the write is an authenticated framed dispatch");
    assert.equal(framedText.includes(text), false, "the user's bytes never travel as raw terminal input");
    assert.deepEqual(framedPayload(row.bootstrap, framedText), { text, origin: { kind: "local" } });

    // Readiness is consumed at most once per registration; later writes keep
    // framing under the same encoder and monotonic sequence.
    await markReady(harness, row);
    const decoder = createNativeInputDecoder(row.bootstrap);
    const first = decodeFramedWrite(row.bootstrap, framedText, decoder);
    harness.manager.write(row.id, "b");
    const second = decodeFramedWrite(row.bootstrap, row.pty.writes.at(-1) as string, decoder);
    assert.deepEqual(first.map((fragment) => fragment.dispatchId), [1]);
    assert.deepEqual(second.map((fragment) => fragment.dispatchId), [2],
      "one encoder per registration continues its sequence; readiness never resets it");

    // A reporter reconnect (extension reload) never resets this registration's
    // encoder or revokes its readiness: the sequence stays monotonic.
    row.entry.handlers.onReconnect?.();
    harness.manager.write(row.id, "c");
    const third = decodeFramedWrite(row.bootstrap, row.pty.writes.at(-1) as string, decoder);
    assert.deepEqual(third.map((fragment) => fragment.dispatchId), [3],
      "a reconnect reuses the same per-registration encoder instead of starting over");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a live framing row discards early automatic replies without replay, then frames future replies as none", async () => {
  const harness = makeFramingHarness("framing-protocol", { framing: true });
  try {
    const row = await createFramingRow(harness);
    const assertLiveOwned = (): void => {
      const view = viewFor(harness.manager, row.id);
      assert.equal(view.lifecycle, "alive");
      assert.equal(view.error, undefined, "discarding an unsent reply is not a row error");
      assert.equal(row.pty.exited, false, "the same child stays alive");
      assert.deepEqual(row.pty.killSignals, [], "no owned stop was initiated");
      assert.equal(row.entry.released, false, "the same registration stays owned");
    };

    // The actual early Windows DA prefix and a kitty query arrive before READY.
    // Neither raw replies nor HMAC framing bytes may leave, and user input is
    // still refused rather than queued, downgraded, or mistaken for protocol.
    await deliver(harness, row, EARLY_WINDOWS_TERMINAL_PREFIX);
    await deliver(harness, row, "\x1b[>7u\x1b[?u");
    assert.deepEqual(row.pty.writes, [], "no raw or framed protocol reply reaches the child");
    assert.throws(() => harness.manager.write(row.id, "typed-before-ready"), /refusing unframed input/);
    assert.deepEqual(row.pty.writes, [], "refused local input also writes zero bytes");
    assertLiveOwned();

    // Foreign, wrong-generation, and tampered readiness arm nothing on this row.
    const tampered = readyCapsule(row.bootstrap);
    for (const capsule of [
      readyCapsule({ ...row.bootstrap, token: "cd".repeat(32) }),
      readyCapsule(row.bootstrap, { generation: randomUUID() }),
      `${tampered.slice(0, -1)}${tampered.endsWith("0") ? "1" : "0"}`,
    ]) {
      await deliver(harness, row, capsuleOsc(capsule));
      await deliver(harness, row, "\x1b[c\x1b[?u");
      assert.throws(() => harness.manager.write(row.id, "still-refused"), /refusing unframed input/);
      assert.deepEqual(row.pty.writes, [], "bad readiness authorizes neither replies nor user input");
      assertLiveOwned();
    }

    // This SAME child's own authenticated READY enables only future queries.
    await markReady(harness, row);
    assert.deepEqual(row.pty.writes, [], "readiness never replays any previously discarded reply");
    assertLiveOwned();
    await deliver(harness, row, EARLY_WINDOWS_TERMINAL_PREFIX);
    await deliver(harness, row, "\x1b[?u");
    assert.equal(row.pty.writes.length, 2, "only the two future queries produce writes");
    const decoder = createNativeInputDecoder(row.bootstrap);
    const replies = row.pty.writes.flatMap((reply) => {
      assert.equal(typeof reply, "string");
      assert.ok((reply as string).startsWith("prg-ni-v2;"), "every future protocol reply is framed");
      return decodeFramedWrite(row.bootstrap, reply as string, decoder);
    });
    assert.deepEqual(replies.map((reply) => reply.payload.toString("utf8")), ["\x1b[?1;2c", "\x1b[?7u"],
      "the original DA and kitty payloads travel unchanged inside frames");
    assert.deepEqual(replies.map((reply) => reply.origin), [{ kind: "none" }, { kind: "none" }],
      "protocol replies carry neither local nor viewer origin");
    assert.deepEqual(replies.map((reply) => reply.dispatchId), [1, 2],
      "discarded replies and refused input spent no encoder dispatches");
    assertLiveOwned();
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("readiness is bound to one registration: a sibling's capsule never arms another row", async () => {
  const harness = makeFramingHarness("framing-cross-row", { framing: true });
  try {
    const rowA = await createFramingRow(harness);
    const rowB = await createFramingRow(harness);
    assert.notEqual(rowA.bootstrap.token, rowB.bootstrap.token);

    // Each row's own READY delivered to the OTHER row's stdout is rejected by
    // that row's receiver (identity/HMAC), so both stay unframed.
    await deliver(harness, rowA, capsuleOsc(readyCapsule(rowB.bootstrap)));
    await deliver(harness, rowB, capsuleOsc(readyCapsule(rowA.bootstrap)));
    assert.throws(() => harness.manager.write(rowA.id, "a"), /refusing unframed input/);
    assert.throws(() => harness.manager.write(rowB.id, "b"), /refusing unframed input/);
    assert.deepEqual([rowA.pty.writes, rowB.pty.writes], [[], []]);

    await markReady(harness, rowA);
    harness.manager.write(rowA.id, "armed");
    assert.equal(typeof rowA.pty.writes.at(-1), "string");
    assert.ok((rowA.pty.writes.at(-1) as string).startsWith("prg-ni-v2;"));
    assert.deepEqual(rowB.pty.writes, [], "readiness never crosses rows");

    // After A's child exits, a late readiness capsule cannot revive its row.
    rowA.pty.emitExit(0);
    rowA.pty.emitData(capsuleOsc(readyCapsule(rowA.bootstrap)));
    assert.throws(() => harness.manager.write(rowA.id, "late"), /not accepting input/);
    assert.equal(rowA.pty.writes.length, 1, "an exited row receives nothing, ready or not");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a framing row whose registrar ignored the mode fails the launch closed instead of framing a legacy child", async () => {
  const harness = makeFramingHarness("framing-registrar-drop", { framing: true });
  try {
    harness.registrar.dropFramingMode = true;
    harness.registrar.nextToken = FRAMING_HEX_TOKEN;
    const id = await harness.manager.create({ workspace: harness.workspace });
    const view = viewFor(harness.manager, id);
    assert.equal(view.lifecycle, "error");
    assert.equal(view.error, "session-host: instance launch preparation failed");
    assert.equal(harness.spawned.length, 0, "no child ever existed, so no raw byte could be typed into one");
    const entry = harness.registrar.entries.find((candidate) => candidate.instanceId === id);
    assert.ok(entry, "the registration was still attempted and then released");
    assert.equal(entry.released, true, "the refused launch released its registration");
    assert.throws(() => harness.manager.write(id, "anything"), /not accepting input|unknown instance id/);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an unresolved stop closes the framing seam for both write sources while ownership stays retained", async () => {
  const harness = makeFramingHarness("framing-stop-fence", { framing: true });
  try {
    const row = await createFramingRow(harness);
    // A stubborn child: the owned stop signals it, but no exit event ever arrives,
    // so the stop stays unconfirmed while the row is still `alive`.
    row.pty.exitsOnSignal = "none";
    await markReady(harness, row);
    harness.manager.write(row.id, "before-stop");
    const writesBefore = row.pty.writes.length;
    assert.ok((row.pty.writes.at(-1) as string).startsWith("prg-ni-v2;"), "the row framed while it was running");

    // Fire-and-forget: the confirmed stop signals the child and then waits for the
    // actual exit this child never sends.
    void harness.manager.stop(row.id, { confirmed: true }).catch(() => undefined);
    await until(() => row.pty.killSignals.length > 0, "the owned stop signalled its own child");
    assert.equal(row.pty.killSignals.at(-1), "SIGTERM", "the stop is the owned graceful signal path");
    assert.equal(row.entry.released, false, "an unconfirmed stop never releases the registration");

    // Readiness armed earlier is not a standing grant: local user input is refused.
    assert.throws(() => harness.manager.write(row.id, "during-stop"), /refusing unframed input/);
    assert.equal(row.pty.writes.length, writesBefore, "no framed byte left during the unresolved stop");
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "alive",
      "the row stays alive and owned until its real exit event");

    // The second write source is refused by the same fence, and the refusal is
    // reported truthfully rather than hidden or retried as raw input.
    await deliver(harness, row, "\x1b[>7u\x1b[?u");
    assert.equal(row.pty.writes.length, writesBefore, "no unframed or framed protocol reply left either");
    const failed = viewFor(harness.manager, row.id);
    assert.equal(failed.lifecycle, "error");
    assert.equal(failed.error, "session-host: instance query reply write failed");
    assert.equal(row.pty.killSignals.length, 1,
      "the failure joins the existing owned stop instead of starting a second one");
    assert.equal(row.entry.released, false, "ownership is retained, never silently dropped");

    // The row still settles on the child's actual exit, and nothing arrives after.
    row.pty.emitExit(0);
    await until(() => row.entry.released, "the confirmed exit released the registration");
    // The truthful lifecycle survives the confirmed exit: a row that failed while
    // stopping keeps reporting its failure instead of pretending a clean stop.
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "error",
      "the reported failure is not rewritten by the later exit");
    assert.equal(row.pty.writes.length, writesBefore, "the row received nothing after the stop began");
    assert.throws(() => harness.manager.write(row.id, "after-exit"), /not accepting input/);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an unready framing row stopped reentrantly during a query still fails the closed reply seam", async () => {
  let closeAdmission: (() => void) | undefined;
  let stopping: ReturnType<InstanceManager["stop"]> | undefined;
  let shutdownRequests = 0;
  const harness = makeFramingHarness("framing-unready-stop", {
    framing: true,
    getSupportedKeyboardFlags: () => {
      const close = closeAdmission;
      closeAdmission = undefined;
      close?.();
      return 7;
    },
  });
  // Observe the owned native stop request without depending on OS signal policy.
  harness.registrar.shutdownHandler = async () => {
    shutdownRequests += 1;
    return { requestId: "unready-owned-stop", status: "requested" };
  };
  try {
    const row = await createFramingRow(harness);
    row.pty.exitsOnSignal = "none";
    // The surface's supported-flags callback can reenter before onReply. The
    // discard must inspect CURRENT stop/admission facts, not earlier liveness.
    closeAdmission = () => { stopping = harness.manager.stop(row.id, { confirmed: true }); };
    await deliver(harness, row, "\x1b[?u");
    assert.ok(stopping, "the callback started this row's owned stop before its reply");
    assert.deepEqual(row.pty.writes, [], "neither a framed nor raw reply leaves the closed seam");
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "error");
    assert.equal(viewFor(harness.manager, row.id).error, "session-host: instance query reply write failed");
    assert.equal(shutdownRequests, 1, "the reply failure joins the existing owned stop");
    assert.equal(row.pty.exited, false);
    assert.equal(row.entry.released, false, "the unconfirmed child's registration stays owned");
    await markReady(harness, row);
    assert.throws(() => harness.manager.write(row.id, "during-stop"), /not accepting input|refusing unframed input/);
    assert.deepEqual(row.pty.writes, [], "late readiness cannot reopen stopped admission");
    row.pty.emitExit(0);
    await stopping;
    assert.equal(row.entry.released, true, "only the actual child exit releases ownership");
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "error");
  } finally {
    closeAdmission = undefined;
    await disposeFramingHarness(harness);
  }
});

test("a ready framing row still fails and stops its owned child on a genuine protocol PTY write error", async () => {
  const harness = makeFramingHarness("framing-protocol-write-error", { framing: true });
  let shutdownRequests = 0;
  harness.registrar.shutdownHandler = async () => {
    shutdownRequests += 1;
    return { requestId: "failed-query-owned-stop", status: "requested" };
  };
  try {
    const row = await createFramingRow(harness);
    row.pty.exitsOnSignal = "none";
    await markReady(harness, row);
    row.pty.writeError = new Error("synthetic framed query-write failure");
    await deliver(harness, row, "\x1b[c");
    assert.deepEqual(row.pty.writes, [], "the failing PTY accepted no write");
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "error");
    assert.equal(viewFor(harness.manager, row.id).error, "session-host: instance query reply write failed");
    assert.equal(shutdownRequests, 1, "the genuine failure initiated the owned native stop");
    assert.equal(row.pty.exited, false);
    assert.equal(row.entry.released, false, "ownership is retained until actual exit");
    row.pty.emitExit(0);
    await until(() => row.entry.released, "the actual exit released the registration");
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "error");
  } finally {
    await disposeFramingHarness(harness);
  }
});

test("a manager-wide shutdown closes the framing seam before any child confirms", async () => {
  const harness = makeFramingHarness("framing-manager-stop", { framing: true });
  try {
    const row = await createFramingRow(harness);
    row.pty.exitsOnSignal = "none";
    await markReady(harness, row);
    harness.manager.write(row.id, "before-shutdown");
    const writesBefore = row.pty.writes.length;
    // Shutdown has begun but its child has not confirmed: the seam is already shut.
    const shutdown = harness.manager.dispose();
    assert.throws(() => harness.manager.write(row.id, "during-shutdown"), /disposed|refusing unframed input/);
    assert.equal(row.pty.writes.length, writesBefore, "shutdown wrote nothing new to the child");
    row.pty.emitExit(0);
    await shutdown;
    assert.equal(row.pty.writes.length, writesBefore);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a disposed framing manager refuses input and ignores late readiness", async () => {
  const harness = makeFramingHarness("framing-dispose", { framing: true });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    harness.manager.write(row.id, "before-dispose");
    assert.equal(row.pty.writes.length, 1);
    row.pty.emitExit(0);
    await harness.manager.dispose();
    row.pty.emitData(capsuleOsc(readyCapsule(row.bootstrap)));
    assert.throws(() => harness.manager.write(row.id, "after-dispose"), /disposed|not accepting input/);
    assert.equal(row.pty.writes.length, 1, "disposal closes the write seam");
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("framing input survives a large paste and multibyte boundaries as one contiguous dispatch", async () => {
  const harness = makeFramingHarness("framing-large", { framing: true });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    const paste = `\x1b[200~${"雪あα".repeat(40_000)}\x1b[201~`;
    harness.manager.write(row.id, paste);
    const framed = row.pty.writes.at(-1) as string;
    assert.equal(typeof framed, "string");
    const fragments = decodeFramedWrite(row.bootstrap, framed);
    assert.ok(fragments.length > 1, "a paste larger than the technical fragment bound splits into ordered fragments");
    assert.equal(fragments[0]?.start, true);
    assert.equal(fragments.at(-1)?.end, true);
    assert.equal(new Set(fragments.map((fragment) => fragment.dispatchId)).size, 1,
      "one paste is one logical dispatch");
    assert.deepEqual(fragments.map((fragment, index) => fragment.part), fragments.map((_, index) => index));
    const rejoined = Buffer.concat(fragments.map((fragment) => fragment.payload)).toString("utf8");
    assert.equal(rejoined, paste, "payload bytes are preserved exactly across fragment boundaries");
    assert.deepEqual(fragments[0]?.origin, { kind: "local" });
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Strict same-manager viewer input boundary (#481 interactive path): the manager
// owns every input fact and the one PTY write; a host-minted scope token describes
// those facts and is never a grant.
//
// IMPORTANT EVIDENCE SCOPE: these cases use the same synthetic PTYs, synthetic
// registrar, and real TerminalSurface as the framing cases above. They prove the
// host-side contract only — what may become an input source, which current facts
// every write is fenced on, that every refusal happens before any byte reaches the
// child, and that an authenticated viewer-origin copy is delivered to exactly the
// viewer whose token named it. They make no claim about a real PTY, a real native
// child, a browser viewer, a transport, or any physical clipboard, and nothing here
// enables network input: no listener, socket, or activation exists in this seam.
// ---------------------------------------------------------------------------

const VIEWER_HOST_RUN = "11111111-2222-4333-8444-555555555555";
const VIEWER_SESSION = "conversation-viewer-input";

/** One viewer's own copy sink plus the receipts it received, in arrival order. */
function viewerSink(): { receipts: NativeViewerClipboardReceipt[]; sink: NativeViewerClipboardSink } {
  const receipts: NativeViewerClipboardReceipt[] = [];
  return { receipts, sink: (receipt) => { receipts.push(receipt); } };
}

/**
 * Register one surface with EXACTLY the given open options and nothing else, so a
 * half-bound surface really is half-bound: a sink is never supplied on the caller's
 * behalf, and an omitted option stays omitted.
 */
function openSurface(manager: InstanceManager, options?: ViewerOpenOptions): string {
  const state = manager.openViewer(options);
  assert.ok(state, "a live manager registers the surface");
  return state.viewerId;
}

/** One fully bound surface: its own copy sink, the receipts it took, its own id. */
function boundSurface(manager: InstanceManager): {
  viewerId: string;
  receipts: NativeViewerClipboardReceipt[];
} {
  const own = viewerSink();
  const viewerId = openSurface(manager, { hostRunId: VIEWER_HOST_RUN, nativeClipboardSink: own.sink });
  return { viewerId, receipts: own.receipts };
}

/** Point one registered surface at a row. */
function displayRow(manager: InstanceManager, viewerId: string, rowId: string): void {
  const applied = manager.updateViewer(viewerId, { sessionId: rowId, cols: 80, rows: 24 });
  assert.equal(applied.applied, true, JSON.stringify(applied));
}

/** Report the row's current native conversation the way its live client would. */
function reportConversation(row: FramingRow, sessionId: string, epoch: number): void {
  row.entry.handlers.onStatus({
    busy: false, pendingInput: false, inputSurface: false, activity: [],
    nativeSession: { sessionId, epoch, name: `Viewer ${epoch}` },
  });
}

/**
 * The current CONVERSATION source of one surface, or undefined. A startup source
 * (tuple-less, before a row's first status) is deliberately not one.
 */
function conversationSourceOf(manager: InstanceManager, viewerId: string): NativeViewerInputSource | undefined {
  const source = manager.readViewerInputSource(viewerId);
  return source === undefined || isNativeViewerStartupInputSource(source) ? undefined : source;
}

/** A complete, well-formed request built from the caller's own observations. */
function viewerRequest(
  manager: InstanceManager, rowId: string, source: NativeViewerAnyInputSource, data: string,
): NativeViewerInputRequest {
  const modes = manager.surface(rowId)?.inputModes();
  assert.ok(modes, "a live row exposes its own input modes");
  return { expectedSource: source, expectedInputModes: modes, data };
}

/**
 * Framed dispatches are an ORDERED stream for one registration: a later frame
 * cannot be decoded by a restarted decoder. One decoder per row consumes every
 * framed write in order and remembers the fragments of the last one.
 */
interface ViewerFrameStream {
  readonly decoder: NativeInputDecoder;
  next: number;
  last: readonly NativeInputFragment[];
}
const viewerFrameStreams = new WeakMap<FramingRow, ViewerFrameStream>();

function readViewerFrames(row: FramingRow): readonly NativeInputFragment[] {
  let stream = viewerFrameStreams.get(row);
  if (stream === undefined) {
    stream = { decoder: createNativeInputDecoder(row.bootstrap), next: 0, last: [] };
    viewerFrameStreams.set(row, stream);
  }
  while (stream.next < row.pty.writes.length) {
    const write = row.pty.writes[stream.next++];
    if (typeof write !== "string" || !write.startsWith("prg-ni-v2;")) continue;
    const fed = stream.decoder.feed(write);
    assert.equal(fed.ok, true,
      `this registration decodes its own framing in order: ${fed.ok ? "" : fed.code}`);
    const closed = stream.decoder.finish();
    assert.equal(closed.ok, true, "one host write is one complete logical dispatch");
    stream.last = fed.fragments;
  }
  return stream.last;
}

/** The one dispatch the most recent framed write produced. */
function lastViewerFrame(row: FramingRow): {
  text: string;
  origin: NativeInputOrigin;
  tuple: { sessionId: string; epoch: number } | undefined;
} {
  const fragments = readViewerFrames(row);
  assert.equal(fragments.length, 1, "the accepted write left exactly one framed fragment");
  const fragment = fragments[0]!;
  return {
    text: fragment.payload.toString("utf8"),
    origin: fragment.origin,
    tuple: fragment.expectedNativeTuple === undefined ? undefined : { ...fragment.expectedNativeTuple },
  };
}

/** One authenticated v2 copy capsule from this row's own child bridge. */
function originCapsule(
  row: FramingRow, sequence: number, event: NativeClipboardEvent,
  input: { origin: { kind: "local" } | { kind: "viewer"; token: string }; dispatchId: number },
): string {
  return encodeNativeClipboardOriginCapsule(
    row.bootstrap as SessionHostBootstrap, sequence, event, input,
  );
}

const copyEvent = (text: string, sessionId: string, sessionEpoch: number): NativeClipboardEvent => ({
  kind: "copy", encoded: Buffer.from(text, "utf8").toString("base64"), sessionId, sessionEpoch,
});
const copiedText = (event: NativeClipboardEvent): string => Buffer.from(
  event.kind === "copy" ? event.encoded : "", "base64",
).toString("utf8");

test("a viewer input source exists only for a bound surface on a ready framed row with a known conversation", async () => {
  const harness = makeFramingHarness("viewer-source", { framing: true });
  try {
    const row = await createFramingRow(harness);
    // Exactly the four bindings under test: no options at all, a sink with no run
    // identity, a run identity with no sink, and a fully bound surface.
    const plain = openSurface(harness.manager);
    const unbound = openSurface(harness.manager, { nativeClipboardSink: viewerSink().sink });
    const runOnly = openSurface(harness.manager, { hostRunId: VIEWER_HOST_RUN });
    const bound = boundSurface(harness.manager);

    // A surface that displays nothing is not an input source.
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined,
      "a surface showing no row has no scope");
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, {
      expectedSource: {} as NativeViewerInputSource, expectedInputModes: {} as never, data: "x",
    }), { status: "refused", reason: "invalid-input" },
    "a malformed request is refused before any fact is read");

    displayRow(harness.manager, bound.viewerId, row.id);
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined,
      "readiness was never verified on this row");
    await markReady(harness, row);
    // Before its first accepted status a ready framed row is in its explicit startup
    // phase: the scope is the tuple-less startup variant, never a guessed conversation.
    const startupScope = harness.manager.readViewerInputSource(bound.viewerId);
    assert.ok(startupScope !== undefined && isNativeViewerStartupInputSource(startupScope)
      && !Object.hasOwn(startupScope, "nativeSession") && /^nvst1\./.test(startupScope.sourceToken),
    "an unknown native conversation is never guessed into a scope; only the explicit startup source exists");

    reportConversation(row, VIEWER_SESSION, 3);
    const source = conversationSourceOf(harness.manager, bound.viewerId);
    assert.ok(source, "a bound surface on a ready framed row with a known conversation has a scope");
    const geometry = harness.manager.instanceGeometry(row.id);
    assert.ok(geometry, "a row with a viewer has canonical geometry");
    assert.deepEqual(source, {
      hostRunId: VIEWER_HOST_RUN,
      viewerId: bound.viewerId,
      viewerRevision: 2,
      rowId: row.id,
      nativeSession: { sessionId: VIEWER_SESSION, epoch: 3 },
      geometry: { cols: geometry.cols, rows: geometry.rows, revision: geometry.revision },
      registrationIdentity: row.bootstrap.instanceId,
      registrationGeneration: row.bootstrap.generation,
      sourceToken: source!.sourceToken,
    });
    assert.match(source!.sourceToken, /^nvs1\./);
    assert.ok(Object.isFrozen(source));
    assert.ok(Object.isFrozen(source!.nativeSession));
    assert.ok(Object.isFrozen(source!.geometry));
    assert.equal(source!.sourceToken.includes(row.bootstrap.token), false,
      "the scope token never carries the registration secret");
    // Reading is a pure fact read: nothing was written, resized, spawned, or armed.
    assert.deepEqual(row.pty.writes, [], "reading a source touched no child");
    assert.deepEqual(row.pty.killSignals, []);
    assert.equal(harness.spawned.length, 1);

    // The published viewer facts stay exactly what they were: no new public field,
    // no second viewer store, and the run identity and sink stay host-side.
    const published = harness.manager.viewerState(bound.viewerId);
    assert.deepEqual(Object.keys(published!).sort(), ["cols", "revision", "rows", "sessionId", "viewerId"]);
    assert.equal(JSON.stringify(published).includes(VIEWER_HOST_RUN), false);
    assert.equal(JSON.stringify(harness.manager.sessionViewers(row.id)).includes(VIEWER_HOST_RUN), false);

    // An unbound or half-bound surface is never an input source, and neither is an
    // unknown id. Each refusal is truthful and writes nothing.
    const liveRequest = viewerRequest(harness.manager, row.id, source!, "x");
    for (const viewerId of [plain, unbound, runOnly]) {
      assert.deepEqual(harness.manager.writeViewerInput(viewerId, liveRequest),
        { status: "refused", reason: "no-input-source" },
        "a surface without this host's run identity AND its own sink has no input path");
    }
    assert.deepEqual(harness.manager.writeViewerInput("viewer-never-registered", liveRequest),
      { status: "refused", reason: "unknown-viewer" });
    assert.deepEqual(row.pty.writes, [], "every refusal above left the child untouched");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a malformed viewer request, options object, or surface is refused without touching any state", async () => {
  const harness = makeFramingHarness("viewer-request-shape", { framing: true });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    reportConversation(row, VIEWER_SESSION, 1);
    const bound = boundSurface(harness.manager);
    displayRow(harness.manager, bound.viewerId, row.id);
    const source = harness.manager.readViewerInputSource(bound.viewerId);
    assert.ok(source);
    const modes = harness.manager.surface(row.id)!.inputModes();
    const good = { expectedSource: source, expectedInputModes: modes, data: "ls\r" };
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, good), { status: "submitted" });
    const writes = row.pty.writes.length;

    for (const bad of [
      undefined, null, 7, "ls\r", [],
      { expectedSource: source, expectedInputModes: modes },
      { expectedSource: source, expectedInputModes: modes, data: "" },
      { expectedSource: source, expectedInputModes: modes, data: 5 },
      { expectedSource: source, expectedInputModes: modes, data: Buffer.alloc(0) },
      { expectedSource: source, expectedInputModes: modes, data: Uint8Array.of(0x41) },
      { expectedSource: source, expectedInputModes: modes, data: "x", extra: 1 },
      { expectedInputModes: modes, data: "x" },
      { expectedSource: { ...source, extra: 1 }, expectedInputModes: modes, data: "x" },
      { expectedSource: { ...source, sourceToken: "" }, expectedInputModes: modes, data: "x" },
      { expectedSource: { ...source, hostRunId: "" }, expectedInputModes: modes, data: "x" },
      { expectedSource: { ...source, nativeSession: { sessionId: VIEWER_SESSION } }, expectedInputModes: modes, data: "x" },
      { expectedSource: { ...source, nativeSession: { sessionId: VIEWER_SESSION, epoch: 0 } }, expectedInputModes: modes, data: "x" },
      { expectedSource: { ...source, geometry: { cols: 0, rows: 24, revision: 0 } }, expectedInputModes: modes, data: "x" },
      { expectedSource: source, expectedInputModes: { ...modes, bracketedPaste: "yes" }, data: "x" },
      { expectedSource: source, expectedInputModes: { ...modes, mouseTracking: "packet" }, data: "x" },
      { expectedSource: source, expectedInputModes: { ...modes, kittyFlags: 9 }, data: "x" },
      { expectedSource: source, expectedInputModes: { ...modes, extra: 1 }, data: "x" },
    ]) {
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, bad as unknown as NativeViewerInputRequest),
        { status: "refused", reason: "invalid-input" }, `${JSON.stringify(bad)} is not a closed request`);
    }
    assert.equal(row.pty.writes.length, writes, "a malformed request never reached the child");

    // A well-formed mode object that simply is not the row's current mode is a
    // FRESHNESS refusal, and stays distinguishable from a shape refusal.
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, {
      expectedSource: source, expectedInputModes: { ...modes, bracketedPaste: !modes.bracketedPaste }, data: "x",
    }), { status: "refused", reason: "stale-input-modes" },
    "another input mode is stale evidence, not a malformed request");
    assert.equal(row.pty.writes.length, writes, "a stale mode observation wrote nothing");

    // A closed options object is the only shape a surface may register with.
    for (const bad of [{ extra: 1 }, { sink: () => undefined }, "bound", 7, null]) {
      assert.throws(() => harness.manager.openViewer(bad as never), /closed options object/);
    }
    assert.throws(() => harness.manager.openViewer({ hostRunId: "has space" } as never), /bounded printable text/);
    assert.throws(() => harness.manager.openViewer({ hostRunId: "r".repeat(200) } as never), /bounded printable text/);
    assert.throws(() => harness.manager.openViewer({ nativeClipboardSink: "sink" } as never), /must be a function/);
    assert.equal(harness.manager.sessionViewers(row.id).length, 1, "a refused registration created no surface");
    assert.equal(row.pty.writes.length, writes, "a refused registration wrote nothing");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("every viewer write is fenced on the manager's current facts and refuses before any byte", async () => {
  const harness = makeFramingHarness("viewer-fence", { framing: true });
  try {
    const row = await createFramingRow(harness);
    row.pty.exitsOnSignal = "none";
    await markReady(harness, row);
    reportConversation(row, VIEWER_SESSION, 4);
    const bound = boundSurface(harness.manager);
    displayRow(harness.manager, bound.viewerId, row.id);
    const source = harness.manager.readViewerInputSource(bound.viewerId);
    assert.ok(source);
    const modes = harness.manager.surface(row.id)!.inputModes();
    const request = (data: string): NativeViewerInputRequest =>
      ({ expectedSource: source, expectedInputModes: modes, data });

    // The admitted write frames with the viewer origin and the CURRENT conversation
    // as the child-side fence, verified here by an independent decoder.
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, request("ls\r")), { status: "submitted" });
    let admitted = row.pty.writes.length;
    assert.equal(admitted, 1, "the admitted write is the only write this child has taken");
    const frame = lastViewerFrame(row);
    assert.equal(frame.text, "ls\r", "the payload travels exactly as given");
    assert.deepEqual(frame.origin, { kind: "viewer", token: source.sourceToken });
    assert.deepEqual(frame.tuple, { sessionId: VIEWER_SESSION, epoch: 4 });

    const refuse = (reason: NativeViewerInputRefusal, label: string): void => {
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, request("stale bytes")),
        { status: "refused", reason }, label);
      assert.equal(row.pty.writes.length, admitted, `${label}: nothing reached the child`);
    };

    // The same bytes mean something else in another mode: the modes the caller
    // observed must still be the modes the row is in.
    await deliver(harness, row, "\x1b[?2004h");
    assert.notEqual(harness.manager.surface(row.id)!.inputModes().bracketedPaste, modes.bracketedPaste,
      "the row really changed input mode");
    refuse("stale-input-modes", "bytes made for another input mode are refused");
    const freshModes = harness.manager.surface(row.id)!.inputModes();
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
      { expectedSource: source, expectedInputModes: freshModes, data: "ok\r" }), { status: "submitted" },
    "the mode fence is a freshness check, never a blanket refusal");
    admitted = row.pty.writes.length;
    assert.equal(admitted, 2, "the freshness check admitted exactly one more dispatch");
    assert.deepEqual(readViewerFrames(row).map((fragment) => fragment.payload.toString("utf8")), ["ok\r"],
      "the second dispatch decodes in stream order, never with a restarted decoder");

    // A newer native conversation (an in-child /new or /resume) invalidates it.
    reportConversation(row, VIEWER_SESSION, 5);
    refuse("stale-source", "a newer native epoch is not the observed conversation");
    // An unknown conversation is never guessed back into existence.
    row.entry.handlers.onStatus({
      busy: false, pendingInput: false, inputSurface: false, activity: [], nativeSession: null,
    });
    refuse("unknown-native-tuple", "an unknown conversation has no scope");
    reportConversation(row, VIEWER_SESSION, 6);
    refuse("stale-source", "a different session id is not the observed conversation");

    // An ABA geometry change still describes a newer canonical geometry.
    const geometryBefore = geometryOf(harness, row);
    assert.deepEqual(source.geometry, { cols: geometryBefore.cols, rows: geometryBefore.rows, revision: geometryBefore.revision },
      "the source stated the row's canonical geometry at read time");
    assert.equal(harness.manager.updateViewer(bound.viewerId, { cols: 90, rows: 30 }).applied, true);
    assert.equal(harness.manager.updateViewer(bound.viewerId, { cols: 80, rows: 24 }).applied, true);
    const geometryAfter = geometryOf(harness, row);
    assert.deepEqual([geometryAfter.cols, geometryAfter.rows], [geometryBefore.cols, geometryBefore.rows],
      "the row came back to the same size");
    assert.ok(geometryAfter.revision > geometryBefore.revision, "at a strictly newer geometry revision");
    refuse("stale-source", "an ABA geometry change is stale");

    // A source cannot be pointed at another run, viewer, row, or token.
    for (const forged of [
      { ...source, hostRunId: "11111111-9999-8888-7777-666666666666" },
      { ...source, viewerId: "viewer-someone-else" },
      { ...source, viewerRevision: 99 },
      { ...source, rowId: "row-someone-else" },
      { ...source, registrationIdentity: "99999999-9999-9999-9999-999999999999" },
      { ...source, registrationGeneration: "88888888-8888-8888-8888-888888888888" },
      { ...source, nativeSession: { sessionId: VIEWER_SESSION, epoch: 4 } },
      { ...source, geometry: { cols: 80, rows: 24, revision: 0 } },
      { ...source, sourceToken: `${source.sourceToken.slice(0, -1)}${source.sourceToken.endsWith("0") ? "1" : "0"}` },
    ]) {
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
        { expectedSource: forged, expectedInputModes: freshModes, data: "x" }),
      { status: "refused", reason: "stale-source" }, `${JSON.stringify(forged)} is not the current scope`);
    }
    assert.equal(row.pty.writes.length, admitted, "a forged source never reached the child");

    // Displaying no row is not an input path, and an unconfirmed Stop closes it
    // while the child is still running and still owned.
    assert.equal(harness.manager.updateViewer(bound.viewerId, { sessionId: null }).applied, true);
    refuse("row-unavailable", "a surface displaying no row has no input path");
    assert.equal(harness.manager.updateViewer(bound.viewerId, { sessionId: row.id }).applied, true);
    const stopping = harness.manager.stop(row.id, { confirmed: true });
    void stopping.catch(() => undefined);
    await until(() => row.pty.killSignals.length > 0, "the owned stop signalled its child");
    refuse("row-unavailable", "an unresolved stop closes the viewer input path too");
    assert.equal(row.entry.released, false, "the refusal never dropped ownership");

    // Once the child really exits, the surface's participation ends with the row.
    row.pty.emitExit(0);
    await until(() => row.entry.released, "the confirmed exit released the registration");
    refuse("row-unavailable", "a finished row has no input path");

    // Disposal closes the seam for every surface, ready or not.
    await harness.manager.dispose();
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, request("x")),
      { status: "refused", reason: "disposed" });
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

function geometryOf(harness: FramingHarness, row: FramingRow): { cols: number; rows: number; revision: number } {
  const geometry = harness.manager.instanceGeometry(row.id);
  assert.ok(geometry, "the row still has canonical geometry");
  return geometry;
}

/** Pi 1.3.0's documented default `app.message.copy` binding (Ctrl+X). */
const CTRL_X = "\x18";
/**
 * One ordinary child VT negotiation of a fully negotiated input-mode state: Kitty
 * flags 7, mouse tracking `any` with SGR encoding, bracketed paste on. Nothing
 * here queries, so the negotiation itself writes nothing to the child.
 */
const NEGOTIATE_VIEWER_INPUT_MODES = "\x1b[>7u\x1b[?1003h\x1b[?1006h\x1b[?2004h";
/** Native synchronized output: the child begins, then ends, one held frame. */
const SYNC_FRAME_BEGIN = "\x1b[?2026h";
const SYNC_FRAME_END = "\x1b[?2026l";
/** Exactly what `NEGOTIATE_VIEWER_INPUT_MODES` leaves the row in. */
const VIEWER_FENCED_MODES: TerminalInputModes = {
  kittyFlags: 7,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: true,
  mouseTracking: "any",
  modifyOtherKeys: 0,
  mouseEncoding: "sgr",
};

test("the input-mode precondition helper compares every field and never accepts an absent observation", () => {
  // One alternate value per live mode field. A consumer that ignored one field, or
  // that inverted acceptance for a missing observation, fails here in both
  // directions, and the completeness assertion below fails if a new mode field ever
  // goes untested.
  const mismatches: Array<{ field: keyof TerminalInputModes; override: Partial<TerminalInputModes> }> = [
    { field: "kittyFlags", override: { kittyFlags: 6 } },
    { field: "applicationCursorKeys", override: { applicationCursorKeys: true } },
    { field: "applicationKeypad", override: { applicationKeypad: true } },
    { field: "bracketedPaste", override: { bracketedPaste: false } },
    { field: "mouseTracking", override: { mouseTracking: "drag" } },
    { field: "modifyOtherKeys", override: { modifyOtherKeys: 2 } },
    { field: "mouseEncoding", override: { mouseEncoding: "default" } },
  ];
  assert.deepEqual(mismatches.map((entry) => entry.field).sort(), Object.keys(VIEWER_FENCED_MODES).sort(),
    "every live input-mode field has a mismatch case");
  assert.equal(terminalInputModesAgree(VIEWER_FENCED_MODES, { ...VIEWER_FENCED_MODES }), true,
    "an identical observation is current");
  for (const { field, override } of mismatches) {
    const other = { ...VIEWER_FENCED_MODES, ...override };
    assert.notDeepEqual(other, VIEWER_FENCED_MODES, `the ${field} case really differs in that one field`);
    assert.equal(terminalInputModesAgree(VIEWER_FENCED_MODES, other), false,
      `a ${field} difference is never agreement`);
    assert.equal(terminalInputModesAgree(other, VIEWER_FENCED_MODES), false,
      `a ${field} difference is never agreement in the other direction either`);
  }
  assert.equal(terminalInputModesAgree(VIEWER_FENCED_MODES, undefined), false,
    "a row with no readable current modes is never agreement");
  assert.equal(terminalInputModesAgree(undefined, VIEWER_FENCED_MODES), false,
    "a missing captured observation is never agreement");
  assert.equal(terminalInputModesAgree(undefined, undefined), false,
    "two absent observations are not agreement");
});

test("the input-mode fence alone refuses a no-change held frame that every other viewer precondition still passes", async () => {
  // IMPORTANT EVIDENCE SCOPE: synthetic PTY and synthetic registrar only, like the
  // rest of this file. Each leg proves the HOST-side fence on its own fresh row:
  // a native synchronized frame withholds mouse packet authorization without
  // changing one fact the observed source describes, so a fixture that only
  // re-checks the source would still admit the gesture while the manager correctly
  // refuses it and writes nothing. No real child, native Pi, or physical clipboard
  // is involved, and no leg proves anything about a mode change after the send.
  const legs: Array<{
    name: string;
    /** Held-frame bytes delivered AFTER this leg captured its observation. */
    hold: "none" | "begin" | "begin-and-end";
    /** Whether the captured observation is still current against the live row. */
    agrees: boolean;
    /** The live row's mouse packet authorization at the attempt. */
    mouseTracking: TerminalInputModes["mouseTracking"];
    expected: NativeViewerInputResult;
    writes: number;
  }> = [
    { name: "baseline", hold: "none", agrees: true, mouseTracking: "any", expected: { status: "submitted" }, writes: 1 },
    {
      name: "held", hold: "begin", agrees: false, mouseTracking: "none",
      expected: { status: "refused", reason: "stale-input-modes" }, writes: 0,
    },
    { name: "committed", hold: "begin-and-end", agrees: true, mouseTracking: "any", expected: { status: "submitted" }, writes: 1 },
  ];
  for (const leg of legs) {
    // One fresh fixture per leg, so no leg inherits another leg's frame or refusal.
    const harness = makeFramingHarness(`viewer-mode-hold-${leg.name}`, { framing: true });
    try {
      const row = await createFramingRow(harness);
      await markReady(harness, row);
      reportConversation(row, VIEWER_SESSION, 7);
      const bound = boundSurface(harness.manager);
      displayRow(harness.manager, bound.viewerId, row.id);
      await deliver(harness, row, NEGOTIATE_VIEWER_INPUT_MODES);
      const surface = harness.manager.surface(row.id);
      assert.ok(surface, "a live row exposes its own terminal surface");
      const capturedModes = surface.inputModes();
      assert.deepEqual(capturedModes, VIEWER_FENCED_MODES,
        `the ${leg.name} leg negotiated exactly the mode state it captured`);
      const capturedSource = conversationSourceOf(harness.manager, bound.viewerId);
      assert.ok(capturedSource, "the surface has this row's conversation source");
      assert.equal(terminalInputModesAgree(capturedModes, surface.inputModes()), true,
        "the captured observation starts out current against the live row");

      if (leg.hold !== "none") await deliver(harness, row, SYNC_FRAME_BEGIN);
      if (leg.hold === "begin-and-end") await deliver(harness, row, SYNC_FRAME_END);

      // Every source fact the same fence also checks is untouched by a no-change
      // frame, so the old tuple/geometry/source precondition still passes here.
      assert.equal(isDeepStrictEqual(conversationSourceOf(harness.manager, bound.viewerId), capturedSource), true,
        `a held frame changed no fact the ${leg.name} source describes`);
      assert.equal(terminalInputModesAgree(capturedModes, surface.inputModes()), leg.agrees,
        `the live row's modes still match the captured observation (${leg.name})`);
      assert.equal(surface.inputModes().mouseTracking, leg.mouseTracking,
        `only mouse packet authorization moved during the ${leg.name} leg`);
      for (const field of ["kittyFlags", "applicationCursorKeys", "applicationKeypad",
        "bracketedPaste", "modifyOtherKeys", "mouseEncoding"] as const) {
        assert.equal(surface.inputModes()[field], capturedModes[field],
          `the ${field} mode the bytes were made for is unchanged (${leg.name})`);
      }
      assert.deepEqual(surface.requestedMouseReporting(), { mouseTracking: "any", mouseEncoding: "sgr" },
        `the child's requested mouse reporting is unchanged in the ${leg.name} leg`);

      // ONE input attempt per leg, made with this leg's own captured observation.
      const writesBefore = row.pty.writes.length;
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, {
        expectedSource: capturedSource, expectedInputModes: capturedModes, data: CTRL_X,
      }), leg.expected, `the manager's own fence answers the ${leg.name} leg`);
      assert.equal(row.pty.writes.length - writesBefore, leg.writes,
        `exactly the admitted dispatch reaches the child (${leg.name})`);
      if (leg.writes === 1) {
        const frame = lastViewerFrame(row);
        assert.equal(frame.text === CTRL_X, true, "the copy key travelled exactly as sent");
        assert.equal(frame.origin.kind === "viewer" && frame.origin.token === capturedSource.sourceToken, true,
          "the dispatch retains this viewer's origin without exposing its token");
        assert.equal(frame.tuple?.sessionId === VIEWER_SESSION && frame.tuple.epoch === 7, true,
          "the dispatch retains this conversation fence");
      }
      if (leg.hold === "begin") {
        // Ending the held frame is the only change: the same observation is current
        // again, which localizes the refusal to the hold itself and not to some mode
        // the frame bytes negotiated.
        await deliver(harness, row, SYNC_FRAME_END);
        assert.equal(terminalInputModesAgree(capturedModes, surface.inputModes()), true,
          "the refusal was the hold, not any mode the frame changed");
      }
    } finally {
      try {
        await disposeFramingHarness(harness);
      } finally {
        rmSync(harness.root, { recursive: true, force: true });
      }
    }
  }
});

test("a viewer-origin copy reaches exactly the viewer whose input caused it", async () => {
  const routed: { instanceId: string; event: NativeClipboardEvent }[] = [];
  const harness = makeFramingHarness("viewer-copy", {
    framing: true,
    onNativeClipboard: (instanceId, event) => { routed.push({ instanceId, event }); },
  });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    reportConversation(row, VIEWER_SESSION, 2);
    const a = boundSurface(harness.manager);
    const b = boundSurface(harness.manager);
    const sibling = boundSurface(harness.manager);
    for (const viewer of [a, b, sibling]) displayRow(harness.manager, viewer.viewerId, row.id);
    const sourceA = harness.manager.readViewerInputSource(a.viewerId);
    const sourceB = harness.manager.readViewerInputSource(b.viewerId);
    assert.ok(sourceA && sourceB);
    assert.notEqual(sourceA.sourceToken, sourceB.sourceToken, "each surface commits to its own scope");

    // A copy for B's dispatch arrives first, then the older copy for A's dispatch:
    // each lands on its own sink with its own dispatch id and origin.
    await deliver(harness, row, capsuleOsc(originCapsule(row, 1,
      copyEvent("copied by B", VIEWER_SESSION, 2), { origin: { kind: "viewer", token: sourceB.sourceToken }, dispatchId: 7 })));
    assert.deepEqual(b.receipts.map((receipt) => [copiedText(receipt.event), receipt.dispatchId, receipt.source.sourceToken]),
      [["copied by B", 7, sourceB.sourceToken]]);
    assert.deepEqual([...a.receipts], [], "a copy is never attributed to the most recent viewer");
    assert.deepEqual(sibling.receipts, [], "a copy is never broadcast to a sibling surface");
    assert.deepEqual(routed, [], "a viewer copy never takes the owner's local clipboard route");

    await deliver(harness, row, capsuleOsc(originCapsule(row, 2,
      copyEvent("copied by A", VIEWER_SESSION, 2), { origin: { kind: "viewer", token: sourceA.sourceToken }, dispatchId: 3 })));
    assert.deepEqual(a.receipts.map((receipt) => [copiedText(receipt.event), receipt.dispatchId]),
      [["copied by A", 3]], "the initiating viewer gets its own copy, in whatever order it arrives");
    assert.equal(b.receipts.length, 1);
    const receipt = a.receipts[0]!;
    assert.deepEqual(Object.keys(receipt).sort(), ["dispatchId", "event", "source"]);
    assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.event) && Object.isFrozen(receipt.source));
    assert.deepEqual(receipt.source, sourceA, "the receipt restates the exact scope that caused the copy");
    assert.deepEqual(routed, []);

    // Anything the token does not vouch for delivers nothing anywhere.
    const closedToken = sourceB.sourceToken;
    assert.equal(harness.manager.closeViewer(b.viewerId), true);
    await deliver(harness, row, capsuleOsc(originCapsule(row, 3,
      copyEvent("after close", VIEWER_SESSION, 2), { origin: { kind: "viewer", token: closedToken }, dispatchId: 8 })));
    assert.deepEqual(routed, [], "a retired surface gets nothing, and nothing falls back to the owner");
    assert.equal(a.receipts.length, 1);

    // A newer surface revision invalidates a token minted for the older one.
    assert.equal(harness.manager.updateViewer(a.viewerId, { cols: 90, rows: 30 }).applied, true);
    await deliver(harness, row, capsuleOsc(originCapsule(row, 4,
      copyEvent("stale revision", VIEWER_SESSION, 2), { origin: { kind: "viewer", token: sourceA.sourceToken }, dispatchId: 9 })));
    assert.equal(a.receipts.length, 1, "a stale scope token delivers nothing");

    // A stale conversation, a foreign or uncanonical token, and a surface with no
    // sink are all dropped quietly — never re-attributed, never broadcast.
    const siblingToken = harness.manager.readViewerInputSource(sibling.viewerId)!.sourceToken;
    for (const [sequence, input] of [
      [5, { origin: { kind: "viewer", token: siblingToken }, dispatchId: 10, event: copyEvent("wrong conversation", VIEWER_SESSION, 1) }],
      [6, { origin: { kind: "viewer", token: "nvs1.viewer-nobody.00000000000000000000000000000000" }, dispatchId: 11, event: copyEvent("nobody", VIEWER_SESSION, 2) }],
      [7, { origin: { kind: "viewer", token: "peer-token-1" }, dispatchId: 12, event: copyEvent("uncanonical", VIEWER_SESSION, 2) }],
      [8, { origin: { kind: "viewer", token: `nvs1.${sibling.viewerId}.00000000000000000000000000000000` }, dispatchId: 13, event: copyEvent("forged", VIEWER_SESSION, 2) }],
    ] as const) {
      await deliver(harness, row, capsuleOsc(originCapsule(row, sequence, input.event, {
        origin: input.origin, dispatchId: input.dispatchId,
      })));
    }
    assert.deepEqual(routed, [], "none of those became a local copy");
    assert.equal(sibling.receipts.length, 0, "a forged commitment never opens a sink");
    assert.equal(a.receipts.length, 1);

    // A surface with no sink of its own is never a copy destination, and a sink
    // that refuses cannot break the row or push the copy somewhere else.
    const grumpy = harness.manager.openViewer({
      hostRunId: VIEWER_HOST_RUN,
      nativeClipboardSink: () => { throw new Error("the viewer refused"); },
    });
    assert.ok(grumpy);
    displayRow(harness.manager, grumpy!.viewerId, row.id);
    const grumpySource = harness.manager.readViewerInputSource(grumpy!.viewerId);
    assert.ok(grumpySource, "a bound surface with its own sink is a source even if that sink refuses");
    await deliver(harness, row, capsuleOsc(originCapsule(row, 9,
      copyEvent("refused copy", VIEWER_SESSION, 2), { origin: { kind: "viewer", token: grumpySource.sourceToken }, dispatchId: 14 })));
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "alive", "a throwing sink cannot break the row");
    assert.deepEqual(routed, [], "a refused viewer copy never escapes to the owner's route");
    assert.equal(a.receipts.length, 1, "and it never lands on another viewer instead");

    // A local receipt still travels ONLY the unchanged local route, and the exit
    // fence closes both routes.
    const localEvent = copyEvent("owner copy", VIEWER_SESSION, 2);
    await deliver(harness, row, capsuleOsc(originCapsule(row, 10, localEvent, { origin: { kind: "local" }, dispatchId: 15 })));
    assert.deepEqual(routed, [{ instanceId: row.id, event: localEvent }],
      "the owner's local route is unchanged and stays the only destination for a local receipt");
    assert.equal(a.receipts.length, 1, "a local receipt never becomes a viewer copy");

    row.pty.emitExit(0);
    await deliver(harness, row, capsuleOsc(originCapsule(row, 11,
      copyEvent("after exit", VIEWER_SESSION, 2), { origin: { kind: "viewer", token: sourceA.sourceToken }, dispatchId: 16 })));
    assert.equal(a.receipts.length, 1, "an exited row delivers nothing at all");
    assert.equal(routed.length, 1);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the viewer input seam is closed on a legacy row and never changes local or protocol bytes", async () => {
  const harness = makeFramingHarness("viewer-legacy-closed");
  try {
    const row = await createFramingRow(harness);
    reportConversation(row, VIEWER_SESSION, 1);
    const bound = boundSurface(harness.manager);
    displayRow(harness.manager, bound.viewerId, row.id);
    const modes = harness.manager.surface(row.id)!.inputModes();
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined,
      "a legacy row is never an input source, ready or not");
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, {
      expectedSource: {
        hostRunId: VIEWER_HOST_RUN, viewerId: bound.viewerId, viewerRevision: 2, rowId: row.id,
        nativeSession: { sessionId: VIEWER_SESSION, epoch: 1 },
        geometry: { cols: 80, rows: 24, revision: 0 },
        registrationIdentity: row.bootstrap.instanceId, registrationGeneration: row.bootstrap.generation,
        sourceToken: "nvs1.aaaa.00000000000000000000000000000000",
      },
      expectedInputModes: modes, data: "ls\r",
    }), { status: "refused", reason: "input-unready" },
    "an unframed child is never typed into with framing text or raw viewer bytes");
    assert.deepEqual(row.pty.writes, [], "a refused viewer write put nothing in the legacy child");

    // Local input on that same legacy row is still the unchanged raw forward.
    harness.manager.write(row.id, "ls -la\r");
    harness.manager.write(row.id, Buffer.from([0x1b, 0x5b, 0x41]));
    assert.deepEqual(row.pty.writes, ["ls -la\r", Buffer.from([0x1b, 0x5b, 0x41])]);
    // The no-argument registration and its published facts are unchanged.
    const plain = harness.manager.openViewer();
    assert.deepEqual(Object.keys(plain!).sort(), ["cols", "revision", "rows", "sessionId", "viewerId"]);
    assert.equal(plain!.revision, 1);
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }

  // On a framed row, the two pre-existing write sources keep their exact dispatch
  // shape: no expected native tuple, no new key, no viewer origin.
  const framing = makeFramingHarness("viewer-local-shape", { framing: true });
  try {
    const row = await createFramingRow(framing);
    await markReady(framing, row);
    reportConversation(row, VIEWER_SESSION, 1);
    framing.manager.write(row.id, "local keys");
    const localFrame = readViewerFrames(row);
    assert.equal(localFrame.length, 1);
    assert.deepEqual(localFrame[0]!.origin, { kind: "local" });
    assert.equal(Object.hasOwn(localFrame[0]!, "expectedNativeTuple"), true);
    assert.equal(localFrame[0]!.expectedNativeTuple, undefined,
      "a local dispatch keeps its unchanged body: the fence is viewer-only");
    assert.match(row.pty.writes.at(-1) as string,
      /^prg-ni-v2;[0-9a-f]{16};[1-9][0-9]*;[A-Za-z0-9_-]+;[0-9a-f]{64};$/,
      "the printable v2 frame shape is unchanged: five ASCII fields and one semicolon terminator");

    await deliver(framing, row, "\x1b[>7u\x1b[?u");
    const reply = readViewerFrames(row);
    assert.deepEqual(reply[0]!.origin, { kind: "none" }, "a protocol reply still carries no user origin");
    assert.equal(reply[0]!.expectedNativeTuple, undefined);
    assert.equal(viewFor(framing.manager, row.id).lifecycle, "alive");
    await disposeFramingHarness(framing);
  } finally {
    rmSync(framing.root, { recursive: true, force: true });
  }
});

test("a strict viewer input preserves translated legacy mouse bytes without UTF-8 conversion", async () => {
  const harness = makeFramingHarness("viewer-native-mouse", { framing: true });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    reportConversation(row, VIEWER_SESSION, 1);
    const bound = boundSurface(harness.manager);
    assert.equal(harness.manager.updateViewer(bound.viewerId, {
      sessionId: row.id, cols: 240, rows: 200,
    }).applied, true);
    row.pty.emitData("\x1b[?1000h\x1b[?1006l");
    await harness.manager.surface(row.id)!.flush();
    const source = harness.manager.readViewerInputSource(bound.viewerId);
    assert.ok(source);
    const modes = harness.manager.surface(row.id)!.inputModes();
    assert.equal(modes.mouseTracking, "vt200");
    assert.equal(modes.mouseEncoding, "default");
    const native = translateInput("\x1b[<0;170;170M", modes, {
      column: 0, row: 0, cols: source.geometry.cols, rows: source.geometry.rows,
    });
    assert.ok(Buffer.isBuffer(native), "the native translator returns byte-oriented X10");
    assert.deepEqual([...native], [0x1b, 0x5b, 0x4d, 32, 202, 202]);
    const before = row.pty.writes.length;
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId, {
      expectedSource: source, expectedInputModes: modes, data: native,
    }), { status: "submitted" });
    assert.equal(row.pty.writes.length, before + 1);
    const framed = row.pty.writes.at(-1);
    assert.ok(typeof framed === "string", "viewer bytes travel as authenticated framing, never raw mouse bytes");
    const fragments = decodeFramedWrite(row.bootstrap, framed);
    assert.equal(fragments.length, 1);
    assert.deepEqual(fragments[0]!.payload, native, "high-bit native mouse bytes are not UTF-8 re-encoded");
    assert.deepEqual(fragments[0]!.origin, { kind: "viewer", token: source.sourceToken });
    assert.deepEqual(fragments[0]!.expectedNativeTuple, { sessionId: VIEWER_SESSION, epoch: 1 });
  } finally {
    try {
      await disposeFramingHarness(harness);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("a conversation identity outside ASCII is still a viewer input source and still frames", async () => {
  const harness = makeFramingHarness("viewer-identity-domain", { framing: true });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    const bound = boundSurface(harness.manager);
    displayRow(harness.manager, bound.viewerId, row.id);

    const scopes: string[] = [];
    // Both identities are valid protocol conversation IDs — opaque text bounded in
    // UTF-8 bytes — so neither may lose the row its input source.
    for (const { sessionId, epoch } of [
      { sessionId: "conversation-雪", epoch: 1 },
      { sessionId: "n".repeat(256), epoch: 2 },
    ]) {
      reportConversation(row, sessionId, epoch);
      const source = conversationSourceOf(harness.manager, bound.viewerId);
      assert.ok(source, `a valid conversation identity describes a scope (${sessionId.length} chars)`);
      assert.deepEqual(source.nativeSession, { sessionId, epoch });
      const modes = harness.manager.surface(row.id)!.inputModes();
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
        { expectedSource: source, expectedInputModes: modes, data: "x" }), { status: "submitted" },
      "input is admitted for a conversation whose identity is not ASCII");
      const frame = lastViewerFrame(row);
      assert.deepEqual(frame.tuple, { sessionId, epoch }, "the child is told this exact conversation");
      assert.equal(frame.text, "x", "the payload travels unchanged");
      const raw = row.pty.writes.at(-1) as string;
      assert.equal(/[\u0080-\uffff]/.test(raw), false, "the framed bytes stay ASCII");
      scopes.push(source.sourceToken);
    }
    assert.notEqual(scopes[0], scopes[1], "each conversation identity commits to its own scope");
    assert.equal(viewFor(harness.manager, row.id).lifecycle, "alive");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a viewer dispatch is admitted only up to the child's whole-dispatch assembly bound", async () => {
  const harness = makeFramingHarness("viewer-payload-bound", { framing: true });
  try {
    const row = await createFramingRow(harness);
    await markReady(harness, row);
    reportConversation(row, VIEWER_SESSION, 1);
    const bound = boundSurface(harness.manager);
    displayRow(harness.manager, bound.viewerId, row.id);
    const source = harness.manager.readViewerInputSource(bound.viewerId);
    assert.ok(source);
    const modes = harness.manager.surface(row.id)!.inputModes();
    const send = (data: string | Buffer): { status: string; reason?: string } => harness.manager.writeViewerInput(
      bound.viewerId, { expectedSource: source, expectedInputModes: modes, data },
    );

    // The exact technical bound is admitted, and high-bit native bytes are never
    // re-encoded: the bound is counted in raw bytes, not characters or base64.
    const exactBytes = Buffer.alloc(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES, 0xa9);
    assert.deepEqual(send(exactBytes), { status: "submitted" });
    let admitted = row.pty.writes.length;
    assert.equal(admitted, 1, "the exact-bound dispatch is the only write this child has taken");
    const byteFragments = readViewerFrames(row);
    assert.ok(byteFragments.length > 1, "the bounded payload still travels as several transport fragments");
    assert.ok(byteFragments.every((fragment) => fragment.payload.length <= NATIVE_INPUT_RAW_FRAGMENT_BYTES),
      "the unchanged per-fragment transport bound still applies to the framed wire body");
    assert.equal(Buffer.concat(byteFragments.map((fragment) => fragment.payload)).equals(exactBytes), true,
      "the exact bound arrives byte-exact");
    assert.deepEqual(byteFragments[0]!.origin, { kind: "viewer", token: source.sourceToken });
    assert.deepEqual(byteFragments[0]!.expectedNativeTuple, { sessionId: VIEWER_SESSION, epoch: 1 });

    // One byte over is refused before the PTY: no truncation, no prefix, no error.
    assert.deepEqual(send(Buffer.alloc(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES + 1)), {
      status: "refused", reason: "invalid-input",
    }, "one byte over the technical bound is refused before the child");
    assert.equal(row.pty.writes.length, admitted, "an over-bound dispatch never reached the child");

    // The same bound applies to a string in UTF-8 BYTES: this one is half the bound
    // in characters but exactly the bound in bytes, so it is admitted.
    const exactText = "\u00e9".repeat(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES / 2);
    assert.equal(Buffer.byteLength(exactText, "utf8"), NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES);
    assert.deepEqual(send(exactText), { status: "submitted" });
    admitted = row.pty.writes.length;
    assert.equal(admitted, 2, "the byte-exact string dispatch is admitted");
    const textFragments = readViewerFrames(row);
    assert.equal(Buffer.concat(textFragments.map((fragment) => fragment.payload)).toString("utf8"), exactText,
      "the string travels exactly, with no character-length shortcut");

    // Fewer characters than the bound but more UTF-8 bytes is over the bound.
    const overText = "\u96ea".repeat(Math.ceil((NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES + 3) / 3));
    assert.ok(overText.length < NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
      "the refusal is about UTF-8 bytes, not JavaScript string length");
    assert.ok(Buffer.byteLength(overText, "utf8") > NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES);
    assert.deepEqual(send(overText), { status: "refused", reason: "invalid-input" },
      "a multi-byte string over the byte bound is refused before the child");
    assert.equal(row.pty.writes.length, admitted, "no over-bound string reached the child");

    // A refusal is not sticky: a normal dispatch on the same row still works.
    assert.deepEqual(send("still works\r"), { status: "submitted" });
    assert.equal(row.pty.writes.length, admitted + 1, "the next admitted dispatch is written normally");
    assert.equal(lastViewerFrame(row).text, "still works\r");

    // Local user input keeps its unchanged, uncapped behavior: the bound is a
    // viewer-dispatch admission fact, not a paste policy for local writes.
    const localPayload = "L".repeat(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES + 1);
    harness.manager.write(row.id, localPayload);
    assert.equal(row.pty.writes.length, admitted + 2, "local input past the viewer bound is still written");
    const localFragments = readViewerFrames(row);
    assert.equal(Buffer.concat(localFragments.map((fragment) => fragment.payload)).toString("utf8"), localPayload,
      "local input beyond the viewer assembly bound travels unchanged");
    assert.deepEqual(localFragments[0]!.origin, { kind: "local" });

    assert.equal(viewFor(harness.manager, row.id).lifecycle, "alive");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Startup-phase viewer input (issue 389): a ready framed registration before its
// first accepted status states an explicit tuple-less startup source whose
// dispatch carries only the startup fence; the phase is sticky-closed by status,
// disconnect, reconnect, and exit, and never becomes a copy scope.
// ---------------------------------------------------------------------------

function startupSourceOf(manager: InstanceManager, viewerId: string): NativeViewerAnyInputSource {
  const source = manager.readViewerInputSource(viewerId);
  assert.ok(source !== undefined && isNativeViewerStartupInputSource(source), "the surface states a startup source");
  return source;
}

test("startup input: a ready framed row before its first status admits only startup-fenced viewer dispatches", async () => {
  const routed: { instanceId: string; event: NativeClipboardEvent }[] = [];
  const harness = makeFramingHarness("viewer-startup", {
    framing: true,
    onNativeClipboard: (instanceId, event) => { routed.push({ instanceId, event }); },
  });
  try {
    const row = await createFramingRow(harness);
    const bound = boundSurface(harness.manager);
    displayRow(harness.manager, bound.viewerId, row.id);
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined,
      "an unready registration has no startup source either");
    await markReady(harness, row);
    const startup = startupSourceOf(harness.manager, bound.viewerId);
    assert.equal(Object.hasOwn(startup, "nativeSession"), false);
    assert.match(startup.sourceToken, /^nvst1\./);
    assert.equal(startup.sourceToken.includes(row.bootstrap.token), false);
    assert.ok(Object.isFrozen(startup) && Object.isFrozen(startup.geometry));
    const modes = harness.manager.surface(row.id)!.inputModes();

    // Malformed startup shapes are refused before any fact is read.
    for (const bad of [
      { ...startup, phase: "conversation" },
      { ...startup, nativeSession: null },
      { ...startup, nativeSession: { sessionId: VIEWER_SESSION, epoch: 1 } },
    ]) {
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
        { expectedSource: bad, expectedInputModes: modes, data: "x" } as unknown as NativeViewerInputRequest),
      { status: "refused", reason: "invalid-input" }, `${JSON.stringify(bad)} is not a closed startup source`);
    }
    // A well-formed but forged startup source is stale.
    for (const forged of [
      { ...startup, viewerRevision: 99 },
      { ...startup, geometry: { ...startup.geometry, revision: startup.geometry.revision + 1 } },
      { ...startup, sourceToken: `${startup.sourceToken.slice(0, -1)}${startup.sourceToken.endsWith("0") ? "1" : "0"}` },
    ]) {
      assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
        { expectedSource: forged, expectedInputModes: modes, data: "x" }),
      { status: "refused", reason: "stale-source" });
    }
    assert.deepEqual(row.pty.writes.filter((write) => typeof write === "string" && write.startsWith("prg-ni-v2;"))
      .length, 0, "no refused startup write reached the child");

    // The admitted write carries the startup fence and nothing else.
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
      { expectedSource: startup, expectedInputModes: modes, data: "1" }), { status: "submitted" });
    const fragments = readViewerFrames(row);
    assert.equal(fragments.length, 1);
    assert.deepEqual(fragments[0]!.origin, { kind: "viewer", token: startup.sourceToken });
    assert.equal(fragments[0]!.expectedNativeTuple, undefined, "no tuple, real or fabricated");
    assert.equal(fragments[0]!.expectedNativePhase, "startup");
    assert.equal(fragments[0]!.payload.toString("utf8"), "1");

    // A copy capsule naming the startup token is never routed: startup is no copy scope.
    await deliver(harness, row, capsuleOsc(originCapsule(row, 1, copyEvent("startup copy", VIEWER_SESSION, 1),
      { origin: { kind: "viewer", token: startup.sourceToken }, dispatchId: fragments[0]!.dispatchId })));
    assert.deepEqual(bound.receipts, [], "a startup token never opens a copy sink");
    assert.deepEqual(routed, [], "and never falls back to the owner's local route");

    // An ABA geometry change retires the old startup commitment; a fresh one works.
    assert.equal(harness.manager.updateViewer(bound.viewerId, { cols: 90, rows: 30 }).applied, true);
    assert.equal(harness.manager.updateViewer(bound.viewerId, { cols: 80, rows: 24 }).applied, true);
    const writesBefore = row.pty.writes.length;
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
      { expectedSource: startup, expectedInputModes: modes, data: "x" }), { status: "refused", reason: "stale-source" });
    assert.equal(row.pty.writes.length, writesBefore);
    const fresh = startupSourceOf(harness.manager, bound.viewerId);
    assert.notEqual(fresh.sourceToken, startup.sourceToken);

    // The first ACCEPTED status — even one with a null tuple — closes startup for good.
    row.entry.handlers.onStatus({ busy: false, pendingInput: false, inputSurface: false, activity: [], nativeSession: null });
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined);
    assert.deepEqual(harness.manager.writeViewerInput(bound.viewerId,
      { expectedSource: fresh, expectedInputModes: modes, data: "x" }),
    { status: "refused", reason: "unknown-native-tuple" }, "a closed startup phase admits nothing");
    assert.equal(row.pty.writes.length, writesBefore, "nothing reached the child after startup closed");

    // A known tuple then gives the ordinary source; losing it never reopens startup.
    reportConversation(row, VIEWER_SESSION, 1);
    assert.ok(conversationSourceOf(harness.manager, bound.viewerId), "a conversation source follows the tuple");
    row.entry.handlers.onStatus({ busy: false, pendingInput: false, inputSurface: false, activity: [], nativeSession: null });
    assert.equal(harness.manager.readViewerInputSource(bound.viewerId), undefined,
      "a once-known, now lost tuple never becomes startup");
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("startup input is sticky-closed by disconnect, reconnect, and exit, and a status before readiness never opens it", async () => {
  const harness = makeFramingHarness("viewer-startup-retire", { framing: true });
  try {
    const disconnected = await createFramingRow(harness);
    const reconnected = await createFramingRow(harness);
    const exited = await createFramingRow(harness);
    const statusFirst = await createFramingRow(harness);
    const surfaces = new Map<FramingRow, string>();
    for (const row of [disconnected, reconnected, exited, statusFirst]) {
      const bound = boundSurface(harness.manager);
      displayRow(harness.manager, bound.viewerId, row.id);
      surfaces.set(row, bound.viewerId);
    }
    // A status that lands BEFORE readiness already retired startup on that row.
    statusFirst.entry.handlers.onStatus({ busy: false, pendingInput: false, inputSurface: false, activity: [], nativeSession: null });
    for (const row of [disconnected, reconnected, exited, statusFirst]) await markReady(harness, row);
    assert.equal(harness.manager.readViewerInputSource(surfaces.get(statusFirst)!), undefined,
      "readiness after the first status never opens startup");

    for (const row of [disconnected, reconnected, exited]) startupSourceOf(harness.manager, surfaces.get(row)!);
    disconnected.entry.handlers.onDisconnect();
    assert.equal(harness.manager.readViewerInputSource(surfaces.get(disconnected)!), undefined,
      "a reporter disconnect closes startup");
    reconnected.entry.handlers.onReconnect?.();
    assert.equal(harness.manager.readViewerInputSource(surfaces.get(reconnected)!), undefined,
      "a reconnect closes startup");
    exited.pty.emitExit(0);
    await until(() => exited.entry.released, "the exit released the registration");
    assert.equal(harness.manager.readViewerInputSource(surfaces.get(exited)!), undefined, "an exit closes startup");
    for (const row of [disconnected, reconnected, statusFirst]) {
      assert.equal(viewFor(harness.manager, row.id).lifecycle, "alive", "closing startup never stops a child");
    }
    await disposeFramingHarness(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// --- Guarded saved-conversation Resume/Delete primitives (remote-provider prerequisite). ---
//
// Real branded catalogs, the real native admission and deletion validation, the
// real private create path, and fake PTYs. Deletion never reaches the real
// `trash` binary: every deletion case installs the narrow test-only mutation
// adapters, which replace only the protected handoffs themselves.

function guardedRow(catalog: GuardedSavedCatalog, id: string): GuardedSavedRow {
  const row = catalog.rows.find((candidate) => candidate.id === id);
  assert.ok(row, `catalog lists ${id}`);
  return row;
}

async function guardedCatalog(harness: SavedFixture): Promise<GuardedSavedCatalog> {
  return listSavedSessions({ agentDir: harness.agentDir, listAll: makeSavedListAll() });
}

/** Replace a file with identical header bytes and a new inode (both exist before the swap). */
function replaceWithNewInode(file: string, id: string, cwd: string): void {
  const staged = writeSavedSessionFile(join(file, ".."), `${basename(file)}.replacement`, id, cwd);
  guardedRenameSync(staged, file);
}

function bindLiveRow(harness: Harness, rowId: string, sessionId: string, epoch: number, currentFile: string): void {
  harness.registrar.emitStatus(harness.registrar.entryFor(rowId), {
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: { sessionId, epoch, name: `Live ${sessionId}`, currentFile },
  });
}

interface DeletionProbe {
  readonly trashCalls: string[];
  readonly unlinkCalls: string[];
}

/**
 * Install the test-only trash/unlink handoffs for one body. The default trash
 * reports a nonzero status without touching the file (so the native unlink
 * fallback runs), and the default unlink really removes the file.
 */
async function withDeletionAdapters<T>(
  handoffs: { trash?: (file: string) => number | null; unlink?: (file: string) => void },
  body: (probe: DeletionProbe) => T | Promise<T>,
): Promise<T> {
  const probe: DeletionProbe = { trashCalls: [], unlinkCalls: [] };
  instanceTestSeam.setSavedDeletionAdaptersForTests({
    spawnSync: ((command: string, args: readonly string[]) => {
      probe.trashCalls.push(`${command} ${args.join(" ")}`);
      const status = handoffs.trash ? handoffs.trash(args[0]!) : 1;
      return { pid: 0, output: [], stdout: "", stderr: "", status, signal: null };
    }) as unknown as NonNullable<SavedDeletionMutationAdapters["spawnSync"]>,
    unlink: (path: string) => {
      probe.unlinkCalls.push(path);
      (handoffs.unlink ?? guardedUnlinkSync)(path);
    },
  });
  try {
    return await body(probe);
  } finally {
    instanceTestSeam.setSavedDeletionAdaptersForTests(undefined);
  }
}

test("guarded saved Resume refuses before any create invocation when the final guard declines, throws, or was revoked earlier", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-resume-refuse");
  try {
    writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "one.jsonl", "guard-resume-1", harness.workspace);
    const catalog = await guardedCatalog(harness);
    const row = guardedRow(catalog, "guard-resume-1");
    let guardCalls = 0;
    const counted = (answer: () => boolean) => (): boolean => {
      guardCalls += 1;
      return answer();
    };

    assert.deepEqual(await harness.manager.startSavedSession(catalog, { ...row }, counted(() => true)),
      { status: "refused", reason: "unknown-row" }, "a copied row is not a minted catalog row");
    assert.deepEqual(await harness.manager.startSavedSession({ ...catalog }, row, counted(() => true)),
      { status: "refused", reason: "unknown-row" }, "a copied catalog carries no brand");
    assert.equal(guardCalls, 0, "forged selections are refused before authorization is consulted");

    assert.deepEqual(await harness.manager.startSavedSession(catalog, row, counted(() => false)),
      { status: "refused", reason: "not-authorized" });
    assert.deepEqual(await harness.manager.startSavedSession(catalog, row, counted(() => {
      throw new Error("synthetic guard failure");
    })), { status: "refused", reason: "not-authorized" }, "a throwing guard refuses");
    assert.deepEqual(await harness.manager.startSavedSession(catalog, row, counted(() => "yes" as unknown as boolean)),
      { status: "refused", reason: "not-authorized" }, "only an exact true authorizes");

    let policyOn = true;
    const foreignPreflight = (): boolean => {
      policyOn = false;
      return true;
    };
    assert.equal(foreignPreflight(), true, "an earlier foreign callback revoked the policy and still reported the row valid");
    assert.deepEqual(await harness.manager.startSavedSession(catalog, row, counted(() => policyOn)),
      { status: "refused", reason: "not-authorized" }, "the final guard observes the earlier revocation");
    assert.equal(guardCalls, 4);
    assert.equal(harness.spawned.length, 0, "no refusal spawned a child");
    assert.equal(harness.registrar.entries.length, 0, "no refusal registered a status channel");
    assert.deepEqual(harness.manager.list(), [], "no refusal posted a row");
    assert.deepEqual(harness.manager.ownedLiveSessions(), [], "no refusal left a reservation");

    // A guard that begins this manager's shutdown is caught by its private stop latch.
    const stopping = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      ptyFactory: harness.ptyFactory,
    });
    const shutdowns: Promise<unknown>[] = [];
    assert.deepEqual(await stopping.startSavedSession(catalog, row, () => {
      shutdowns.push(stopping.shutdown({ graceMs: 0, killMs: 0 }));
      return true;
    }), { status: "refused", reason: "unavailable" });
    await Promise.all(shutdowns);
    assert.equal(harness.spawned.length, 0, "a stopping manager starts nothing after the guard");

    // The same exact row is still admissible through the guarded path afterwards.
    let authorized = 0;
    const started = await harness.manager.startSavedSession(catalog, row, () => {
      authorized += 1;
      return true;
    });
    assert.equal(started.status, "started");
    if (started.status !== "started") throw new Error("unreachable");
    assert.equal(authorized, 1, "Resume consults the final guard exactly once");
    assert.equal(viewFor(harness.manager, started.id).lifecycle, "alive");
    assert.deepEqual(harness.spawned[0]?.spawnDescriptor.args.slice(4, 6), ["--session", row.file],
      "the branded admission reached the existing native create path");
    assert.equal(harness.spawned[0]?.spawnDescriptor.cwd, realpathSync(harness.workspace));
  } finally {
    cleanup(harness);
  }
});

test("guarded saved Resume re-reads its own file, header, root, workspace, binding, and catalog facts after the guard", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-resume-facts");
  try {
    const sessions = join(harness.agentDir, "sessions");
    const goneWorkspace = join(harness.root, "guard-gone-workspace");
    mkdirSync(goneWorkspace, { recursive: true });
    writeSavedSessionFile(join(sessions, "replace"), "r.jsonl", "guard-replace", harness.workspace);
    writeSavedSessionFile(join(sessions, "header"), "h.jsonl", "guard-header", harness.workspace);
    writeSavedSessionFile(join(sessions, "root"), "o.jsonl", "guard-root", harness.workspace);
    writeSavedSessionFile(join(sessions, "workspace"), "w.jsonl", "guard-workspace", goneWorkspace);
    writeSavedSessionFile(join(sessions, "duplicate"), "d.jsonl", "guard-duplicate", harness.workspace);
    const catalog = await guardedCatalog(harness);

    const replaced = guardedRow(catalog, "guard-replace");
    assert.deepEqual(await harness.manager.startSavedSession(catalog, replaced, () => {
      replaceWithNewInode(replaced.file, replaced.id, replaced.cwd);
      return true;
    }), { status: "refused", reason: "replaced-file" }, "a file the guard replaced is caught after it returns");

    const header = guardedRow(catalog, "guard-header");
    assert.deepEqual(await harness.manager.startSavedSession(catalog, header, () => {
      writeFileSync(header.file, "not a session header\n", "utf8");
      return true;
    }), { status: "refused", reason: "malformed-header" });

    const rooted = guardedRow(catalog, "guard-root");
    const project = join(sessions, "root");
    assert.deepEqual(await harness.manager.startSavedSession(catalog, rooted, () => {
      guardedRenameSync(project, `${project}-moved`);
      guardedSymlinkSync(`${project}-moved`, project, "dir");
      return true;
    }), { status: "refused", reason: "outside-sessions-root" });

    const workspace = guardedRow(catalog, "guard-workspace");
    assert.deepEqual(await harness.manager.startSavedSession(catalog, workspace, () => {
      rmSync(goneWorkspace, { recursive: true, force: true });
      return true;
    }), { status: "refused", reason: "workspace-unavailable" });

    assert.equal(harness.spawned.length, 0, "no post-guard refusal reached the create path");
    assert.deepEqual(harness.manager.list(), []);

    const duplicate = guardedRow(catalog, "guard-duplicate");
    const admitted = admitSavedSession(catalog, duplicate);
    assert.equal(admitted.status, "admitted");
    if (admitted.status !== "admitted") throw new Error("unreachable");
    const admission = admitted.admission;
    const nested: Promise<string>[] = [];
    assert.deepEqual(await harness.manager.startSavedSession(catalog, duplicate, () => {
      nested.push(harness.manager.create({ workspace: admission.workspace, savedSession: admission }));
      return true;
    }), { status: "refused", reason: "known-owned-duplicate" }, "a reservation the guard created is in the census read after it");
    assert.equal(nested.length, 1);
    await Promise.all(nested);
    assert.equal(harness.spawned.length, 1, "only the guard's own create spawned; the guarded Resume did not");
    assert.deepEqual(harness.manager.ownedLiveSessions(), [
      { kind: "reservation", id: duplicate.id, file: duplicate.file },
      { kind: "current" },
    ]);

    // A newer listing supersedes the catalog, so its selections are stale.
    await guardedCatalog(harness);
    assert.deepEqual(await harness.manager.startSavedSession(catalog, duplicate, () => true),
      { status: "refused", reason: "stale-catalog" });
    assert.equal(harness.spawned.length, 1);
  } finally {
    cleanup(harness);
  }
});

test("guarded saved Resume treats the create invocation as accepted owner work even when authorization is lost inside it", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-resume-accepted");
  try {
    writeSavedSessionFile(join(harness.agentDir, "sessions", "proj"), "one.jsonl", "guard-accepted-1", harness.workspace);
    const catalog = await guardedCatalog(harness);
    const row = guardedRow(catalog, "guard-accepted-1");
    let policyOn = true;
    const policyAtSpawn: boolean[] = [];
    const manager = new InstanceManager({
      packageRoot: harness.packageRoot,
      piExecutable: harness.piExecutable,
      statusRegistrar: harness.registrar,
      env: harness.env,
      // The row post inside the create invocation turns the policy Off.
      onChange: () => { policyOn = false; },
      ptyFactory: (descriptor) => {
        policyAtSpawn.push(policyOn);
        return harness.ptyFactory(descriptor);
      },
    });

    const result = await manager.startSavedSession(catalog, row, () => policyOn);
    assert.equal(result.status, "started", "losing authorization inside the invocation never becomes a refusal");
    if (result.status !== "started") throw new Error("unreachable");
    assert.deepEqual(policyAtSpawn, [false], "the policy was already Off while the accepted create was still running");
    assert.equal(viewFor(manager, result.id).lifecycle, "alive");
    assert.deepEqual(harness.spawned[0]?.killSignals, [], "no implicit stop, cancellation, or rollback");
    assert.deepEqual(manager.ownedLiveSessions(), [
      { kind: "reservation", id: row.id, file: row.file },
      { kind: "current" },
    ], "the accepted reservation stays owned");
    assert.deepEqual(await manager.startSavedSession(catalog, row, () => true),
      { status: "refused", reason: "known-owned-duplicate" }, "the duplicate fence still holds afterwards");
    assert.equal(harness.spawned.length, 1);
  } finally {
    cleanup(harness);
  }
});

test("guarded saved Delete refuses before any trash or unlink when the guard declines or the manager's own facts refuse", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-delete-refuse");
  try {
    const sessions = join(harness.agentDir, "sessions");
    writeSavedSessionFile(join(sessions, "a"), "keep.jsonl", "guard-delete-keep", harness.workspace);
    writeSavedSessionFile(join(sessions, "b"), "swap.jsonl", "guard-delete-swap", harness.workspace);
    writeSavedSessionFile(join(sessions, "c"), "bound.jsonl", "guard-delete-bound", harness.workspace);
    const catalog = await guardedCatalog(harness);
    const keep = guardedRow(catalog, "guard-delete-keep");
    const swap = guardedRow(catalog, "guard-delete-swap");
    const bound = guardedRow(catalog, "guard-delete-bound");

    await withDeletionAdapters({}, async (probe) => {
      let guardCalls = 0;
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, { ...keep }, () => {
        guardCalls += 1;
        return true;
      }), { status: "refused", reason: "unknown-row" });
      assert.equal(guardCalls, 0, "a forged row is refused before authorization is consulted");

      assert.deepEqual(harness.manager.deleteSavedSession(catalog, keep, () => false),
        { status: "refused", reason: "not-authorized" });
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, keep, () => {
        throw new Error("synthetic guard failure");
      }), { status: "refused", reason: "not-authorized" });

      let policyOn = true;
      const foreignPreflight = (): boolean => {
        policyOn = false;
        return true;
      };
      assert.equal(foreignPreflight(), true);
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, keep, () => policyOn),
        { status: "refused", reason: "not-authorized" }, "an earlier revocation is caught by the final guard");

      assert.deepEqual(harness.manager.deleteSavedSession(catalog, swap, () => {
        replaceWithNewInode(swap.file, swap.id, swap.cwd);
        return true;
      }), { status: "refused", reason: "replaced-file" }, "a file the guard replaced is never trashed");

      const liveId = await harness.manager.create({ workspace: harness.workspace });
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, bound, () => true),
        { status: "refused", reason: "unknown-live-binding" }, "a live child without a current tuple is an unknown binding");
      bindLiveRow(harness, liveId, "guard-unrelated-live", 1, join(harness.root, "unrelated-live.jsonl"));
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, bound, () => {
        bindLiveRow(harness, liveId, bound.id, 2, bound.file);
        return true;
      }), { status: "refused", reason: "known-owned-duplicate" }, "a binding the guard changed is read after it");

      assert.deepEqual(probe.trashCalls, [], "no refusal invoked trash");
      assert.deepEqual(probe.unlinkCalls, [], "no refusal invoked unlink");
      for (const row of [keep, swap, bound]) assert.equal(guardedExistsSync(row.file), true);
    });
  } finally {
    cleanup(harness);
  }
});

test("guarded saved Delete keeps the local rules: missing workspace deletes; stopping, reservations, and stale catalogs refuse", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-delete-rules");
  try {
    const sessions = join(harness.agentDir, "sessions");
    const goneWorkspace = join(harness.root, "guard-delete-gone-workspace");
    mkdirSync(goneWorkspace, { recursive: true });
    writeSavedSessionFile(join(sessions, "gone"), "g.jsonl", "guard-delete-gone", goneWorkspace);
    writeSavedSessionFile(join(sessions, "reserved"), "r.jsonl", "guard-delete-reserved", harness.workspace);
    const catalog = await guardedCatalog(harness);
    const gone = guardedRow(catalog, "guard-delete-gone");
    const reserved = guardedRow(catalog, "guard-delete-reserved");
    rmSync(goneWorkspace, { recursive: true, force: true });

    await withDeletionAdapters({}, async (probe) => {
      const stopping = new InstanceManager({
        packageRoot: harness.packageRoot,
        piExecutable: harness.piExecutable,
        statusRegistrar: harness.registrar,
        env: harness.env,
        ptyFactory: harness.ptyFactory,
      });
      const shutdowns: Promise<unknown>[] = [];
      assert.deepEqual(stopping.deleteSavedSession(catalog, gone, () => {
        shutdowns.push(stopping.shutdown({ graceMs: 0, killMs: 0 }));
        return true;
      }), { status: "refused", reason: "unavailable" }, "a guard that stops the manager is caught by its private latch");
      await Promise.all(shutdowns);
      assert.deepEqual(probe.trashCalls, []);

      assert.deepEqual(harness.manager.deleteSavedSession(catalog, gone, () => true),
        { status: "deleted", method: "unlink" }, "a missing recorded workspace stays deletable exactly as locally");
      assert.deepEqual(probe.trashCalls, [`trash ${gone.file}`], "trash is attempted first with the one admitted path");
      assert.deepEqual(probe.unlinkCalls, [gone.file]);
      assert.equal(guardedExistsSync(gone.file), false);

      const admitted = admitSavedSession(catalog, reserved);
      assert.equal(admitted.status, "admitted");
      if (admitted.status !== "admitted") throw new Error("unreachable");
      const pendingCreate = harness.manager.create({ workspace: admitted.admission.workspace, savedSession: admitted.admission });
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, reserved, () => true),
        { status: "refused", reason: "known-owned-duplicate" }, "a pending reservation protects its exact file");
      await pendingCreate;
      await guardedCatalog(harness);
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, reserved, () => true),
        { status: "refused", reason: "stale-catalog" });
      assert.equal(probe.trashCalls.length, 1);
      assert.equal(probe.unlinkCalls.length, 1);
      assert.equal(guardedExistsSync(reserved.file), true);
    });
  } finally {
    cleanup(harness);
  }
});

test("guarded saved Delete revalidates before the unlink fallback and reports invoked handoffs truthfully", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-delete-stages");
  try {
    const sessions = join(harness.agentDir, "sessions");
    for (const id of ["stage-swap", "stage-revoke", "stage-trash-ok", "stage-unlink-ok", "stage-unlink-fail", "stage-gone"]) {
      writeSavedSessionFile(join(sessions, id), `${id}.jsonl`, id, harness.workspace);
    }
    const catalog = await guardedCatalog(harness);

    const swap = guardedRow(catalog, "stage-swap");
    let guardCalls = 0;
    await withDeletionAdapters({
      trash: (file) => {
        replaceWithNewInode(file, swap.id, swap.cwd);
        return 1;
      },
    }, (probe) => {
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, swap, () => {
        guardCalls += 1;
        return true;
      }), { status: "unconfirmed", trashInvoked: true, unlinkInvoked: false, fallbackRefusal: "replaced-file" });
      assert.equal(guardCalls, 2, "the same guard boundary ran before trash and again before the fallback");
      assert.deepEqual(probe.unlinkCalls, [], "a replacement observed after trash is never unlinked");
      assert.equal(guardedExistsSync(swap.file), true, "the replacement is preserved");
    });

    const revoke = guardedRow(catalog, "stage-revoke");
    let policyOn = true;
    await withDeletionAdapters({ trash: () => { policyOn = false; return 1; } }, (probe) => {
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, revoke, () => policyOn),
        { status: "unconfirmed", trashInvoked: true, unlinkInvoked: false, fallbackRefusal: "not-authorized" },
        "authorization lost inside trash stops the fallback but never claims trash was not invoked");
      assert.deepEqual(probe.trashCalls, [`trash ${revoke.file}`]);
      assert.deepEqual(probe.unlinkCalls, []);
    });

    const trashOk = guardedRow(catalog, "stage-trash-ok");
    policyOn = true;
    await withDeletionAdapters({
      trash: (file) => {
        policyOn = false;
        guardedUnlinkSync(file);
        return 0;
      },
    }, () => {
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, trashOk, () => policyOn),
        { status: "deleted", method: "trash" }, "a native trash success is reported even though the policy turned Off");
      assert.equal(guardedExistsSync(trashOk.file), false);
    });

    const unlinkOk = guardedRow(catalog, "stage-unlink-ok");
    policyOn = true;
    await withDeletionAdapters({
      unlink: (file) => {
        policyOn = false;
        guardedUnlinkSync(file);
      },
    }, (probe) => {
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, unlinkOk, () => policyOn),
        { status: "deleted", method: "unlink" }, "a returned fallback unlink is reported even though the policy turned Off");
      assert.deepEqual(probe.unlinkCalls, [unlinkOk.file]);
      assert.equal(guardedExistsSync(unlinkOk.file), false);
    });

    const unlinkFail = guardedRow(catalog, "stage-unlink-fail");
    await withDeletionAdapters({
      unlink: () => { throw new Error("synthetic EACCES with /private/raw/path"); },
    }, () => {
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, unlinkFail, () => true),
        { status: "unconfirmed", trashInvoked: true, unlinkInvoked: true },
        "a failed fallback is unconfirmed, with no raw error text in the outcome");
      assert.equal(guardedExistsSync(unlinkFail.file), true);
    });

    const goneAfterTrash = guardedRow(catalog, "stage-gone");
    await withDeletionAdapters({
      trash: (file) => {
        guardedUnlinkSync(file);
        return null;
      },
    }, (probe) => {
      assert.deepEqual(harness.manager.deleteSavedSession(catalog, goneAfterTrash, () => true),
        { status: "deleted", method: "trash" }, "the native gone-file rule is preserved");
      assert.deepEqual(probe.unlinkCalls, []);
    });
    assert.equal(harness.spawned.length, 0, "deletion never starts or stops a child");
  } finally {
    cleanup(harness);
  }
});

test("the owning-host service runs the guarded primitives of its one manager with injected callbacks only before the guard", { skip: process.platform === "win32" }, async () => {
  const harness = makeSavedHarness("guard-service");
  try {
    const sessions = join(harness.agentDir, "sessions");
    writeSavedSessionFile(join(sessions, "delete"), "d.jsonl", "service-delete", harness.workspace);
    writeSavedSessionFile(join(sessions, "resume"), "r.jsonl", "service-resume", harness.workspace);
    const catalog = await guardedCatalog(harness);
    const deletion = guardedRow(catalog, "service-delete");
    const resume = guardedRow(catalog, "service-resume");
    const order: string[] = [];
    let teardown = false;
    const service = createGuardedOwningHostService({
      createManager: () => harness.manager,
      teardownRequested: () => {
        order.push("teardown");
        return teardown;
      },
    });
    service.openManager({} as Parameters<typeof service.openManager>[0]);

    await withDeletionAdapters({
      trash: () => {
        order.push("trash");
        return 1;
      },
      unlink: (file) => {
        order.push("unlink");
        guardedUnlinkSync(file);
      },
    }, () => {
      assert.deepEqual(service.deleteSavedConversation(catalog, deletion, () => {
        order.push("guard");
        return true;
      }), { status: "deleted", method: "unlink" });
      assert.deepEqual(order, ["teardown", "guard", "trash", "guard", "unlink"],
        "the injected teardown latch is read only before authorization; nothing injected runs between a guard and its handoff");
    });

    order.length = 0;
    const started = await service.startSavedConversation(catalog, resume, () => {
      order.push("guard");
      return true;
    });
    assert.equal(started.status, "started");
    assert.deepEqual(order, ["teardown", "guard", "teardown"],
      "teardown is read before the guard and again only after the create invocation, for classification");

    teardown = true;
    order.length = 0;
    assert.deepEqual(await service.startSavedConversation(catalog, resume, () => {
      order.push("guard");
      return true;
    }), { status: "refused", reason: "unavailable" });
    assert.deepEqual(service.deleteSavedConversation(catalog, resume, () => {
      order.push("guard");
      return true;
    }), { status: "refused", reason: "unavailable" });
    assert.deepEqual(order, ["teardown", "teardown"], "host teardown refuses before any guard");
    assert.equal(harness.spawned.length, 1);
  } finally {
    cleanup(harness);
  }
});
