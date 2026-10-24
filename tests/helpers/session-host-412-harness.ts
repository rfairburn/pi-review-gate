/**
 * Shared synthetic host harness for the combined #412 regressions.
 *
 * Owned by the new integration suite only. It wires the REAL production
 * surfaces together in one process:
 *
 *   owning source/controller activation -> authenticated reporter -> protocol
 *   frames on a real Unix-socket broker -> InstanceManager -> SidebarController
 *
 * The native Pi host itself is emulated (hooks/tools/context/UI only); no
 * native Pi process, provider credential, or live model request is involved.
 * Instance PTYs are synthetic manager inputs; background shells, executors and
 * reviewers are real OS children when a test asks for them.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createStatusBroker, type StatusBroker } from "../../src/session-host/broker";
import {
  InstanceManager,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeInstanceView,
  type StatusRegistrar,
} from "../../src/session-host/instances";
import { __test as mainTest } from "../../src/session-host/main";
import { ProfileRegistry } from "../../src/session-host/profiles";
import { HOST_BOOTSTRAP_ENV, decodeFrame, type SessionHostStatus } from "../../src/session-host/protocol";
import activateReporter, { SESSION_HOST_STICKY_STATE_KEY } from "../../src/session-host/reporter";
import { SidebarController, type SidebarItem } from "../../src/session-host/sidebar";
import {
  SESSION_HOST_STARTUP_REQUEST_ENV,
  SESSION_HOST_TITLE_COLUMNS_ENV,
} from "../../src/session-host/startup-request";
import { ownedActivitySnapshot } from "../../src/session-host/owned-activity";
import { SessionStateStore, type ExecutionAssociationsSnapshot } from "../../src/session-state";
import { createState } from "../../src/state";
import { activate as activateGate } from "../../src/index";

export const PENDING_QUESTIONS_WIDGET_KEY = "review-gate-pending-questions";

const PRIVATE_GLOBAL_KEYS = [
  SESSION_HOST_STICKY_STATE_KEY,
  Symbol.for("pi-review-gate.session-host.restore-coordination.v1"),
  Symbol.for("pi-review-gate.session-host.startup-request.v1"),
  Symbol.for("pi-review-gate.session-host.title-columns.v1"),
  Symbol.for("pi-review-gate.session-host.exit-handler"),
] as const;

const ENV_KEYS = [
  HOST_BOOTSTRAP_ENV,
  SESSION_HOST_STARTUP_REQUEST_ENV,
  SESSION_HOST_TITLE_COLUMNS_ENV,
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

export interface FakeHostTool {
  name: string;
  label?: string;
  description?: string;
  exposure?: string;
  defaultActive?: boolean;
  parameters?: unknown;
  execute: (...args: any[]) => Promise<unknown>;
}

export interface FakeHost {
  pi: Record<string, any>;
  hooks: Map<string, Array<(...args: any[]) => unknown>>;
  tools: Map<string, FakeHostTool>;
  notices: string[];
  sent: Array<{ message: unknown; options: unknown }>;
  trigger: (name: string, ...args: unknown[]) => Promise<void>;
  triggerCollect: (name: string, ...args: unknown[]) => Promise<unknown[]>;
  invokeTool: (name: string, params: Record<string, unknown>, ctx: unknown) => Promise<{ result?: any; decisions: unknown[] }>;
}

/** Minimal but complete Pi 1.4.0-style host surface used by both extensions. */
export function createFakeHost(): FakeHost {
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<string, FakeHostTool>();
  const active = new Set<string>();
  const notices: string[] = [];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const pi: Record<string, any> = {
    on(name: string, handler: (...args: any[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => undefined;
    },
    registerTool(tool: FakeHostTool) {
      tools.set(tool.name, tool);
      if ((tool.exposure ?? "direct") === "direct") active.add(tool.name);
      return true;
    },
    registerCommand() { return true; },
    registerMessageRenderer() { return true; },
    registerShortcut() { return true; },
    registerFlag() { return true; },
    appendEntry() {},
    notify(message: string) { notices.push(String(message)); },
    sendUserMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active.clear(); for (const name of names ?? []) active.add(name); return true; },
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        label: tool.label ?? tool.name,
        description: tool.description ?? "",
        exposure: tool.exposure ?? "direct",
        defaultActive: tool.defaultActive ?? true,
      }));
    },
    getCommands() { return []; },
    events: { on() { return () => undefined; }, emit() {} },
  };
  const trigger = async (name: string, ...args: unknown[]): Promise<void> => {
    for (const handler of hooks.get(name) ?? []) await handler(...args);
  };
  const triggerCollect = async (name: string, ...args: unknown[]): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of hooks.get(name) ?? []) results.push(await handler(...args));
    return results;
  };
  const invokeTool = async (
    name: string,
    params: Record<string, unknown>,
    ctx: unknown,
  ): Promise<{ result?: any; decisions: unknown[] }> => {
    const tool = tools.get(name);
    assert.ok(tool, `tool registered: ${name}`);
    const toolCallId = `synthetic-${name}-${Math.random().toString(16).slice(2)}`;
    await trigger("message_end", {
      message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name, arguments: params }] },
    }, ctx);
    await trigger("tool_execution_start", { toolCallId, toolName: name, args: params }, ctx);
    const decisions = await triggerCollect("tool_call", { toolCallId, toolName: name, input: params }, ctx);
    const blocked = decisions.find((value) => value && (value as { block?: unknown }).block === true);
    if (blocked) return { decisions };
    const result = await tool.execute(toolCallId, params, undefined, undefined, ctx);
    await trigger("tool_result", {
      toolCallId,
      toolName: name,
      input: params,
      result,
      isError: Boolean(result && (result as { isError?: unknown }).isError === true),
    }, ctx);
    return { result, decisions };
  };
  return { pi, hooks, tools, notices, sent, trigger, triggerCollect, invokeTool };
}

class LabPty implements InstancePty {
  static nextPid = 515_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  readonly killSignals: string[] = [];
  exited = false;
  readonly #data: ((data: string) => void)[] = [];
  readonly #exit: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  readonly #errors: ((error: Error) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = LabPty.nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data.push(listener);
    return { dispose: () => { const index = this.#data.indexOf(listener); if (index >= 0) this.#data.splice(index, 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exit.push(listener);
    return { dispose: () => { const index = this.#exit.indexOf(listener); if (index >= 0) this.#exit.splice(index, 1); } };
  }

  on(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    this.#errors.push(listener);
  }

  removeListener(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    const index = this.#errors.indexOf(listener);
    if (index >= 0) this.#errors.splice(index, 1);
  }

  write(data: string | Buffer): void { this.writes.push(data); }
  resize(columns: number, rows: number): void { this.cols = columns; this.rows = rows; }
  kill(signal?: string): void { this.killSignals.push(signal ?? "SIGHUP"); }
  pause(): void {}
  resume(): void {}

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exit]) listener({ exitCode, signal });
  }
}

export interface RecordedUpdate {
  readonly view: InstanceStatusUpdate;
  /** True when this pushed status was observed while a host activity request was in flight. */
  readonly duringRequest: boolean;
  readonly at: number;
}

export interface LabOptions {
  label: string;
  sessionId?: string;
  sessionName?: string;
  /** Raw review-gate config object written to the synthetic config file. */
  config: Record<string, unknown>;
  isIdle?: () => boolean;
}

interface LabFields {
  root: string;
  agentDir: string;
  workspace: string;
  sessionFile: string;
  configPath: string;
  broker: StatusBroker;
  manager: InstanceManager;
  instanceId: string;
  pty: LabPty;
  host: FakeHost;
  recorder: Recorder;
  /** Short-lived Unix-socket transport root (OS socket-length bound). */
  socketRoot: string;
  oldEnv: Map<string, string | undefined>;
  oldGlobals: Map<PropertyKey, PropertyDescriptor | undefined>;
}

/**
 * One isolated production-wiring fixture: real broker + real manager + real
 * reporter + synthetic native host. The caller decides whether to activate the
 * review-gate extension (production restore path) or register its own real
 * owning sources/controllers after reporter activation.
 */
export class HostLab {
  readonly root: string;
  readonly agentDir: string;
  readonly workspace: string;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly configPath: string;
  readonly broker: StatusBroker;
  readonly manager: InstanceManager;
  readonly instanceId: string;
  readonly host: FakeHost;
  readonly recorder: Recorder;
  readonly socketRoot: string;
  isIdle: () => boolean;
  readonly ctx: Record<string, any>;
  readonly #pty: LabPty;
  readonly #oldEnv: Map<string, string | undefined>;
  readonly #oldGlobals: Map<PropertyKey, PropertyDescriptor | undefined>;
  #reporterActivated = false;
  #gateActivated = false;
  #disposed = false;

  private constructor(options: LabOptions, fields: LabFields) {
    this.root = fields.root;
    this.agentDir = fields.agentDir;
    this.workspace = fields.workspace;
    this.sessionFile = fields.sessionFile;
    this.sessionId = options.sessionId ?? "synthetic-412-session";
    this.configPath = fields.configPath;
    this.broker = fields.broker;
    this.manager = fields.manager;
    this.instanceId = fields.instanceId;
    this.#pty = fields.pty;
    this.host = fields.host;
    this.recorder = fields.recorder;
    this.socketRoot = fields.socketRoot;
    this.#oldEnv = fields.oldEnv;
    this.#oldGlobals = fields.oldGlobals;
    this.isIdle = options.isIdle ?? (() => true);
    this.ctx = this.#makeContext(options.sessionName ?? "Synthetic 412");
  }

  get updates(): RecordedUpdate[] { return this.recorder.updates; }
  get requestResults(): string[] { return this.recorder.requestResults; }
  get completedRequests(): CompletedActivityRequest[] { return this.recorder.completedRequests; }
  get activityRequests(): number { return this.recorder.requestCount; }

  static async create(options: LabOptions): Promise<HostLab> {
    const root = mkdtempSync(join(tmpdir(), `prg-412-${options.label}-`));
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "state");
    // The authenticated status transport must fit the OS Unix-socket path bound
    // (103 bytes). This isolated run-time IPC endpoint is the only scratch path
    // outside the fixture root; it is created and removed by this lab alone.
    const socketRoot = realpathSync(mkdtempSync(join("/tmp", "prg412sock-")));
    for (const directory of [agentDir, workspace, stateRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, "base.txt"), "base\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Synthetic"], { cwd: workspace });
    execFileSync("git", ["add", "base.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");
    const configPath = join(root, "review-gate.json");
    writeFileSync(configPath, JSON.stringify(options.config), "utf8");

    const oldEnv = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) { oldEnv.set(key, process.env[key]); delete process.env[key]; }
    const oldGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
    const globalScope = globalThis as Record<PropertyKey, unknown>;
    for (const key of PRIVATE_GLOBAL_KEYS) {
      oldGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      delete globalScope[key];
    }
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    // The owned-activity registry and its production source incarnations are
    // process-local singletons shared by this file's sequential stacks: the
    // shell/review sources registered at module load are replayed by the first
    // reporter activation, and later gate activations retire cleanly. Resetting
    // the registry here would discard those real module registrations and make
    // every combined category permanently unknown.

    const broker = await createStatusBroker({ socketRoot });
    const recorder = new Recorder();
    const registrar: StatusRegistrar = {
      register(instanceId: string, handlers: InstanceStatusHandlers) {
        const inner = mainTest.statusRegistrar(broker);
        const wrapped: InstanceStatusHandlers = {
          ...handlers,
          onStatus(update) {
            recorder.updates.push({ view: { ...update, activity: [...update.activity] }, duringRequest: recorder.pending > 0, at: recorder.tick() });
            handlers.onStatus(update);
          },
        };
        const registration = inner.register(instanceId, wrapped);
        return recorder.wrap(registration);
      },
    };
    const profileRegistry = new ProfileRegistry({ stateRoot });
    const spawned: LabPty[] = [];
    const manager = new InstanceManager({
      packageRoot: makeSyntheticPackage(root),
      piExecutable: makeSyntheticPiExecutable(root),
      statusRegistrar: registrar,
      nativeSetup: false,
      profileRegistry,
      args: [],
      env: cleanChildEnv(),
      ptyFactory: (descriptor) => {
        const pty = new LabPty(descriptor);
        spawned.push(pty);
        return pty;
      },
    });
    const instanceId = await manager.create({ workspace });
    const pty = spawned.at(-1);
    assert.ok(pty, "the synthetic manager spawned one owned PTY");
    const bootstrap = JSON.parse(String(pty.spawnDescriptor.env[HOST_BOOTSTRAP_ENV])) as Record<string, string>;
    process.env[HOST_BOOTSTRAP_ENV] = JSON.stringify(bootstrap);

    const host = createFakeHost();
    return new HostLab(options, {
      root, agentDir, workspace, sessionFile, configPath, broker, manager, instanceId, pty, host, recorder, socketRoot, oldEnv, oldGlobals,
    });
  }

  #makeContext(sessionName: string): Record<string, any> {
    return {
      cwd: this.workspace,
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (message: unknown) => { this.host.notices.push(String(message)); },
        setWidget() {},
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        custom: async () => undefined,
        editor: async () => undefined,
        setStatus() {},
        setWorkingMessage() {},
        getToolsExpanded: () => false,
        setToolsExpanded() {},
      },
      isIdle: () => this.isIdle(),
      isProjectTrusted: () => true,
      signal: undefined,
      abort() {},
      shutdown() {},
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
      model: undefined,
      scopedModels: [],
      thinkingLevel: "off",
      modelRegistry: {},
      sessionManager: {
        getSessionId: () => this.sessionId,
        getSessionFile: () => this.sessionFile,
        getCwd: () => this.workspace,
        getSessionName: () => sessionName,
        getEntries: () => [],
      },
    };
  }

  /** Connect the real reporter to the real broker over its authenticated socket. */
  async startReporter(options: { reconnectDelayMs?: number; maxReconnectAttempts?: number } = {}): Promise<void> {
    await activateReporter(this.host.pi, {
      reconnectDelayMs: options.reconnectDelayMs ?? 25,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 4,
      onSocket: (socket) => this.recorder.trackSocket(socket),
    });
    this.#reporterActivated = true;
  }

  /** Activate the review-gate extension after the reporter, exactly like the child loader. */
  async activateGateExtension(extra: Parameters<typeof activateGate>[1] = {}): Promise<void> {
    await activateGate(this.host.pi, {
      initialCheckpointScope: { agentDir: this.agentDir, sessionId: this.sessionId },
      ...extra,
    });
    this.#gateActivated = true;
  }

  /**
   * Observe the native pending-question panel's initial render, exactly as the
   * native host publishes the known widget key at startup. Registered in the
   * same session_start chain, before the reporter's first authoritative loaded
   * status is emitted.
   */
  installNativePendingPanelClear(): void {
    this.host.pi.on("session_start", () => {
      try { this.ctx.ui.setWidget(PENDING_QUESTIONS_WIDGET_KEY, undefined); } catch { /* native UI unavailable */ }
    });
  }

  async seedSidecar(execution: ExecutionAssociationsSnapshot): Promise<void> {
    const store = new SessionStateStore({ sessionId: this.sessionId, sessionFile: this.sessionFile, cwd: this.workspace });
    assert.equal(await store.save(createState(), execution), true, "synthetic sidecar wrote durably");
  }

  writeCorruptSidecar(): void {
    writeFileSync(`${this.sessionFile}.pi-review-gate-state.json`, "{ not a valid sidecar", "utf8");
  }

  async sessionStart(reason = "startup"): Promise<void> {
    await this.host.trigger("session_start", { type: "session_start", reason }, this.ctx);
  }

  view(): NativeInstanceView | undefined {
    return this.manager.list().find((row) => row.id === this.instanceId);
  }

  sidebarItem(): SidebarItem | undefined {
    const view = this.view();
    return view === undefined ? undefined : mainTest.toSidebarItem(view);
  }

  renderRow(cols = 40, rows = 24): string {
    const item = this.sidebarItem();
    assert.ok(item, "the synthetic row exists");
    const sidebar = new SidebarController({ onAction: () => undefined });
    sidebar.updateItems([item]);
    return sidebar.renderRoster(cols, rows).lines.join("\n");
  }

  /** First broker-forwarded status that carries the loaded native conversation identity. */
  firstLoadedUpdate(): RecordedUpdate | undefined {
    return this.updates.find((entry) => entry.view.nativeSession?.sessionId === this.sessionId);
  }

  async waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; view=${JSON.stringify(this.view())} updates=${JSON.stringify(this.updates.map((entry) => entry.view))}`);
      }
      await sleep(5);
    }
  }

  async waitForView(predicate: (view: NativeInstanceView) => boolean, what: string, timeoutMs = 4_000): Promise<NativeInstanceView> {
    await this.waitFor(() => {
      const view = this.view();
      return view !== undefined && predicate(view);
    }, what, timeoutMs);
    return this.view()!;
  }

  get socketCount(): number {
    return this.recorder.sockets.length;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const failures: Error[] = [];
    const record = (label: string, error: unknown): void => {
      failures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
    };
    // Attempt every cleanup step, then fail loudly if any owned child could not
    // be positively settled. Fixtures are retained on failure as evidence.
    if (this.#gateActivated || this.#reporterActivated) {
      try {
        await this.host.trigger("session_shutdown", { type: "session_shutdown", reason: "test" }, this.ctx);
      } catch (error) { record("session_shutdown", error); }
    }
    // A known-zero shell observation is required; unknown/null or a timeout is
    // not settlement.
    try {
      await waitUntil(() => ownedActivitySnapshot().backgroundShells === 0, 5_000);
    } catch (error) {
      record(`owned shell settlement not positively zero (backgroundShells=${String(ownedActivitySnapshot().backgroundShells)})`, error);
    }
    try { this.#pty.emitExit(0); } catch (error) { record("synthetic PTY exit", error); }
    try { this.manager.closeExited(this.instanceId); } catch (error) { record("manager closeExited", error); }
    try { await this.manager.dispose(); } catch (error) { record("manager dispose", error); }
    try { await this.broker.dispose(); } catch (error) { record("broker dispose", error); }
    rmSync(this.socketRoot, { recursive: true, force: true });
    for (const [key, value] of this.#oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const globalScope = globalThis as Record<PropertyKey, unknown>;
    for (const [key, descriptor] of this.#oldGlobals) {
      if (descriptor === undefined) delete globalScope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    // Keep the process-local production source incarnations across this file's
    // sequential stacks; each stack settles its own work and retires cleanly.
    if (failures.length > 0) {
      throw new AggregateError(failures, "synthetic host cleanup did not positively settle every owned child; fixtures retained");
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

export interface CompletedActivityRequest {
  readonly status: string;
  readonly requestId: string;
  /** Counts carried by the correlated status delivered for this exact request. */
  readonly activeTasks: number | null;
  readonly activeShells: number | null;
  readonly backgroundTasks: number | null;
  readonly backgroundShells: number | null;
  readonly busy: boolean | null;
  readonly nativeSessionId: string | null;
  /** True only when the correlated delivery was observed while this request was in flight. */
  readonly duringRequest: boolean;
  readonly socketCount: number;
}

export class Recorder {
  readonly updates: RecordedUpdate[] = [];
  readonly requestResults: string[] = [];
  readonly completedRequests: CompletedActivityRequest[] = [];
  /** Exact outgoing correlated activity_result payloads, keyed by requestId. */
  readonly activityReplies = new Map<string, { status: SessionHostStatus; duringRequest: boolean }>();
  readonly sockets: net.Socket[] = [];
  requestCount = 0;
  pending = 0;
  lastSocket: net.Socket | undefined;
  #clock = 0;

  tick(): number { return this.#clock += 1; }

  trackSocket(socket: net.Socket): void {
    this.sockets.push(socket);
    this.lastSocket = socket;
    const write = socket.write.bind(socket);
    socket.write = ((...args: any[]): boolean => {
      // The production reporter writes one complete encodeFrame() string per
      // call, so the correlated activity payload can be selected by requestId
      // instead of inferred from a time window.
      const frame = typeof args[0] === "string" ? decodeFrame(args[0]) : undefined;
      if (frame?.type === "activity_result" && frame.outcome === "complete" && frame.status) {
        this.activityReplies.set(frame.requestId, {
          status: frame.status,
          duringRequest: this.pending > 0,
        });
      }
      return Reflect.apply(write, socket, args);
    }) as typeof socket.write;
  }

  wrap(registration: InstanceStatusRegistration): InstanceStatusRegistration {
    const requestActivity = registration.requestActivity;
    if (typeof requestActivity !== "function") return registration;
    return {
      ...registration,
      requestActivity: async () => {
        this.requestCount += 1;
        this.pending += 1;
        try {
          const result = await requestActivity.call(registration);
          this.requestResults.push(result.status);
          if (result.status === "complete") {
            // Match the exact encoded activity_result frame by requestId. A
            // later ordinary push cannot substitute for the correlated reply.
            const reply = this.activityReplies.get(result.requestId);
            assert.ok(reply, "completed request has its exact wire payload");
            this.activityReplies.delete(result.requestId);
            const correlated = reply.status;
            this.completedRequests.push({
              status: result.status,
              requestId: result.requestId,
              activeTasks: correlated.activeTasks ?? null,
              activeShells: correlated.activeShells ?? null,
              backgroundTasks: correlated.backgroundTasks ?? null,
              backgroundShells: correlated.backgroundShells ?? null,
              busy: correlated.busy,
              nativeSessionId: correlated.nativeSession?.sessionId ?? null,
              duringRequest: reply.duringRequest,
              socketCount: this.sockets.length,
            });
          }
          return result;
        } finally {
          this.pending -= 1;
        }
      },
    };
  }
}

function cleanChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  return env;
}

function makeSyntheticPackage(root: string): string {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture.\n", "utf8");
  for (const [skill, files] of [
    ["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
    ["pi-review-gate-execution", ["SKILL.md"]],
    ["pi-review-gate-research", ["SKILL.md"]],
    ["pi-review-gate-completion", ["SKILL.md"]],
  ] as const) {
    for (const file of files) {
      const path = join(packageRoot, "skills", skill, ...file.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${skill}/${file}\n`, "utf8");
    }
  }
  return packageRoot;
}

function makeSyntheticPiExecutable(root: string): string {
  const executable = join(root, "bin", "synthetic-pi");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture for descriptor-only manager wiring.\n", "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  if (!predicate()) throw new Error("bounded wait expired");
}
