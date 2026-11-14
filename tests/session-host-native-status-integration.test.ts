/**
 * End-to-end synthetic integration for the LANDED native status pipeline
 * (issue #277 activation slice).
 *
 * One stretch of this file exercises the real components together, in process:
 * the REAL {@link InstanceManager}, the REAL local {@link createStatusBroker}
 * listener on a REAL bound Unix socket, the REAL
 * {@link createNativeStatusObserver} factory with the REAL acquisition
 * controllers behind it, the REAL {@link runNativeHookRelay} entrypoint and the
 * REAL closed hook protocol/codec, and a REAL owned temporary provider JSONL
 * file that the controllers watch and read.
 *
 * What stays synthetic, on purpose: every child is a fake PTY, every launch
 * descriptor comes from a fake provider (which retains the request's
 * `nativeHook.bootstrap` faithfully and returns a `prepared` outcome carrying a
 * lease it owns), and the relay runs IN-PROCESS with a fixture environment that
 * carries only this run's own bootstrap. No real Claude or Codex binary, no
 * provider authentication, configuration, model, or permission state, no real
 * `Main`, no role-environment clearing, and no Windows ConPTY path. Live
 * provider delivery, runtime clipboard, and Windows CI acceptance are therefore
 * NOT claimed here; what is claimed is that the landed pieces behave as one
 * pipeline when the owner arms them.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { afterEach } from "node:test";

import {
  createStatusBroker,
  type NativeHookStatusBroker,
} from "../src/session-host/broker";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeInstanceView,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { createNativeStatusObserver } from "../src/session-host/native-observer-factory";
import type {
  NativeHookArtifactCleanup,
  NativeHookArtifactLease,
} from "../src/session-host/native-hook-launch-prep";
import {
  NATIVE_HOOK_BOOTSTRAP_ENV,
  encodeNativeHookBootstrapEnv,
  type NativeHookBootstrap,
} from "../src/session-host/native-hook-protocol";
import { runNativeHookRelay, type NativeHookRelayOutcome } from "../src/session-host/native-hook-relay";
import type { NativeCliBackend } from "../src/session-host/session-backend";

/* ----------------------------------------------------------------- fixtures */

const SECRET_PROMPT = "SECRET-PROMPT-TEXT";
const SECRET_TOOL_INPUT = "SECRET-TOOL-INPUT-JSON";
const SECRET_AGENT_MESSAGE = "SECRET-LAST-AGENT-MESSAGE";

const ownedDirectories: string[] = [];
/** Any broker still listening when a test ends would hold the runner open. */
const openBrokers = new Set<NativeHookStatusBroker>();

afterEach(async () => {
  for (const broker of [...openBrokers]) {
    try {
      await broker.dispose();
    } catch {
      // A broker's own teardown refusal cannot mask a test assertion.
    }
    openBrokers.delete(broker);
  }
  // Only directories this file created are removed; nothing provider-owned is.
  for (const dir of ownedDirectories.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Cleanup never masks an assertion; an owned tree that survived is reported
      // by the harness's own leak check, not by a thrown teardown.
    }
  }
});

/**
 * An owned, SHORT root: the broker's Unix socket path has a tight OS bound, and
 * it creates its own private transport directory below whatever root is given.
 * Test-specific trees therefore live as subdirectories of this one.
 */
function makeOwnedRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-ns-")));
  ownedDirectories.push(root);
  return root;
}

/** The inert gate-package fixture the manager expects; never imported or run. */
function makePackageFixture(root: string): { packageRoot: string; piExecutable: string; home: string; agentDir: string } {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = join(root, "native-agent");
  mkdirSync(agentDir, { recursive: true });
  return { packageRoot, piExecutable, home, agentDir };
}

/** A fake PTY that records what its owner does and settles on SIGTERM. */
class FakePty implements InstancePty {
  static #nextPid = 780_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly killSignals: string[] = [];
  exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = FakePty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(_listener: (data: string) => void): { dispose(): void } { return { dispose: () => undefined }; }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }

  on(_eventName: "error", _listener: (error: Error) => void): void { /* recorded by absence */ }
  removeListener(_eventName: "error", _listener: (error: Error) => void): void { /* no-op */ }
  write(_data: string | Buffer): void { /* nothing is written to a hosted row here */ }
  resize(_columns: number, _rows: number): void { /* not exercised */ }
  pause(): void { /* not exercised */ }
  resume(): void { /* not exercised */ }

  kill(signal?: string): void {
    const name = signal ?? "SIGHUP";
    this.killSignals.push(name);
    if (!this.exited && name === "SIGTERM") this.emitExit(143);
  }

  emitExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode });
  }
}

/** The Pi-family registrar. A hosted provider row must never appear in it. */
class PiRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: {
        version: 1,
        socketPath: "/synthetic/pi.sock",
        token: "0".repeat(64),
        instanceId,
        generation: "00000000-0000-4000-8000-000000000000",
      },
      release: () => undefined,
    };
  }
}

/** The staged-artifact handle a `prepared` launch outcome transfers to the owner. */
class OwnedLease implements NativeHookArtifactLease {
  readonly root: string;
  cleanupCount = 0;

  constructor(root: string) {
    this.root = root;
  }

  cleanup(): Promise<NativeHookArtifactCleanup> {
    this.cleanupCount += 1;
    return Promise.resolve({ removed: [this.root], preserved: [] });
  }
}

/* ------------------------------------------------------------- the harness */

interface Harness {
  readonly root: string;
  readonly workspace: string;
  readonly manager: InstanceManager;
  readonly broker: NativeHookStatusBroker;
  readonly piRegistrar: PiRegistrar;
  readonly providerRequests: { backend: NativeCliBackend; request: NativeCliLaunchRequest }[];
  readonly leases: OwnedLease[];
  readonly spawned: FakePty[];
  readonly order: string[];
  /** Every row view this manager published, in the order it changed. */
  viewsOf(id: string): NativeInstanceView[];
  view(id: string): NativeInstanceView;
  /** Resolves on the first published view of `id` that satisfies `matches`. */
  waitView(id: string, matches: (view: NativeInstanceView) => boolean, what: string): Promise<NativeInstanceView>;
  /** One in-process relay delivery for one bootstrap, as the provider's hook would. */
  relay(bootstrap: NativeHookBootstrap, providerStdin: unknown): Promise<NativeHookRelayOutcome>;
  /** One raw relay delivery whose stdin is not valid provider JSON. */
  relayRaw(bootstrap: NativeHookBootstrap, stdinText: string): Promise<NativeHookRelayOutcome>;
  create(backend: NativeCliBackend): Promise<string>;
  dispose(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const root = makeOwnedRoot();
  const { packageRoot, piExecutable, home, agentDir } = makePackageFixture(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const broker = await createStatusBroker({ socketRoot: root });
  openBrokers.add(broker);
  const piRegistrar = new PiRegistrar();
  const providerRequests: Harness["providerRequests"] = [];
  const leases: OwnedLease[] = [];
  const spawned: FakePty[] = [];
  const order: string[] = [];
  const published = new Map<string, NativeInstanceView[]>();
  const waiters: { id: string; matches: (view: NativeInstanceView) => boolean; resolve: (view: NativeInstanceView) => void }[] = [];

  // The fake interactive provider behaves like the real launcher adapter: it
  // retains the request's bootstrap, and when one was armed it composes the
  // prepared args/environment into the descriptor and hands back the lease it
  // staged, so the owner - not this fake - decides when those files go away.
  const provider: NativeCliLaunch = (backend, request): NativeCliLaunchDescriptor => {
    order.push("provider");
    providerRequests.push({ backend, request: { ...request, env: { ...request.env } } });
    const bootstrap = request.nativeHook?.bootstrap;
    const lease = bootstrap === undefined ? undefined : new OwnedLease(join(root, `staged-${backend}`));
    if (lease !== undefined) leases.push(lease);
    const env: NodeJS.ProcessEnv = { ...request.env, HOME: home, PATH: "/usr/bin:/bin" };
    const args = ["--interactive"];
    if (bootstrap !== undefined && lease !== undefined) {
      env[NATIVE_HOOK_BOOTSTRAP_ENV] = "<prepared-by-this-launch>";
      args.push("--hooks-file", lease.root);
    }
    const descriptor: NativeCliLaunchDescriptor = {
      file: `/synthetic/bin/${backend}`,
      args,
      env,
      cwd: request.workspace,
      ...(bootstrap === undefined || lease === undefined
        ? {}
        : {
          nativeHook: {
            observation: "prepared" as const,
            backend,
            route: backend === "claude" ? "claude-settings-file" as const : "codex-session-start" as const,
            args: ["--hooks-file", lease.root],
            environment: { [NATIVE_HOOK_BOOTSTRAP_ENV]: "<prepared-by-this-launch>" },
            lease,
          },
        }),
    };
    return descriptor;
  };

  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: piRegistrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: provider,
    // The two optional owner-side seams, exactly as a hosting Main supplies them.
    nativeHookRegistrar: broker,
    nativeStatusObserverFactory: createNativeStatusObserver,
    onChange: (id) => {
      const view = manager.list().find((candidate) => candidate.id === id);
      if (view === undefined) return;
      const history = published.get(id) ?? [];
      history.push(view);
      published.set(id, history);
      for (const waiter of waiters.filter((candidate) => candidate.id === id && candidate.matches(view))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(view);
      }
    },
    ptyFactory: (descriptor) => {
      order.push("spawn");
      const pty = new FakePty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });

  const latest = (id: string): NativeInstanceView => {
    const view = manager.list().find((candidate) => candidate.id === id);
    assert.ok(view, "the owned row exists");
    return view;
  };

  return {
    root,
    workspace,
    manager,
    broker,
    piRegistrar,
    providerRequests,
    leases,
    spawned,
    order,
    viewsOf: (id) => [latest(id), ...(published.get(id) ?? [])],
    view: latest,
    waitView: (id, matches, what) => new Promise<NativeInstanceView>((resolve, reject) => {
      const current = latest(id);
      if (matches(current)) return resolve(current);
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${what}; latest view: ${JSON.stringify(latest(id))}`));
      }, 5000);
      timer.unref?.();
      waiters.push({
        id,
        matches,
        resolve: (view) => { clearTimeout(timer); resolve(view); },
      });
    }),
    relay: (bootstrap, providerStdin) => runNativeHookRelay({
      env: { [NATIVE_HOOK_BOOTSTRAP_ENV]: encodeNativeHookBootstrapEnv(bootstrap) },
      stdin: Readable.from([Buffer.from(JSON.stringify(providerStdin), "utf8")]),
    }),
    relayRaw: (bootstrap, stdinText) => runNativeHookRelay({
      env: { [NATIVE_HOOK_BOOTSTRAP_ENV]: encodeNativeHookBootstrapEnv(bootstrap) },
      stdin: Readable.from([Buffer.from(stdinText, "utf8")]),
    }),
    create: (backend) => manager.create({ workspace, backend } as CreateInstanceOptions),
    dispose: async () => { await manager.dispose(); openBrokers.delete(broker); await broker.dispose(); },
  };
}

/** The bootstrap this row's own launch was armed with. */
function bootstrapOf(harness: Harness, index = 0): NativeHookBootstrap {
  const bootstrap = harness.providerRequests[index]?.request.nativeHook?.bootstrap;
  assert.ok(bootstrap, "the armed launch carries its own fresh bootstrap");
  return bootstrap;
}

/** One provider transcript file inside this harness's owned tree. */
function transcriptFile(harness: Harness, name: string): string {
  const dir = join(harness.root, "transcripts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "", "utf8");
  return path;
}

const claudeHook = (
  transcript: string,
  sessionId: string,
  hookEventName: string,
  extra: Record<string, unknown> = {},
) => ({
  hook_event_name: hookEventName,
  session_id: sessionId,
  transcript_path: transcript,
  // Real provider payloads carry these; the closed sanitizer must drop them.
  prompt: SECRET_PROMPT,
  tool_input: { command: SECRET_TOOL_INPUT },
  ...extra,
});

const claudeSummaryRow = (fields: Record<string, unknown> = {}) => `${JSON.stringify({
  type: "system",
  subtype: "stop_hook_summary",
  hookEventName: "Stop",
  isSidechain: false,
  preventedContinuation: true,
  hookErrors: [],
  hookAdditionalContext: [],
  ...fields,
})}\n`;

/* ------------------------------------------------------------------ tests */

test("activation: the real broker's fresh bootstrap is registered before the provider and the spawn, and the prepared lease is retained", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("claude");

    // The provider runs before the raw spawn, and the bootstrap it received can
    // only exist if this row's registration was already issued: so registration,
    // then provider, then child, in that order, with no child whose source is
    // not already bound to this exact row.
    assert.deepEqual(harness.order, ["provider", "spawn"]);
    assert.equal(harness.providerRequests.length, 1);
    assert.deepEqual(harness.piRegistrar.requests, [], "a hosted provider row never joins the Pi family");

    const bootstrap = bootstrapOf(harness);
    assert.equal(bootstrap.backend, "claude");
    assert.equal(bootstrap.instanceId, id, "the bootstrap names exactly this row");
    assert.equal(bootstrap.socketPath, harness.broker.socketPath, "the bootstrap names the host's ONE existing broker listener");
    assert.equal(bootstrap.generation, harness.broker.generation);
    assert.match(bootstrap.token, /^[0-9a-f]{64}$/);

    // The provider kept the bootstrap it was given and staged files for it; the
    // child is live, so nothing may be cleaned up yet.
    assert.equal(harness.leases.length, 1);
    assert.equal(harness.leases[0]!.cleanupCount, 0);
    assert.equal(harness.spawned.length, 1);

    // No observation has arrived yet: every supported field is unknown, never
    // Ready, never zero. The source's own declaration is published at activation.
    const view = harness.view(id);
    assert.equal(view.backend, "claude");
    assert.equal(view.lifecycle, "alive");
    assert.equal(view.busy, null);
    assert.equal(view.pendingInput, null);
    assert.equal(view.activeTasks, null);
    assert.equal(view.activeShells, null);
    assert.deepEqual(view.activity, []);
    assert.deepEqual(view.statusSupport, {
      agent: "supported", input: "supported", tasks: "supported", shells: "supported", activity: "supported",
    });
    assert.equal(view.nativeSession, null, "a hosted provider row reports no Pi conversation tuple");
  } finally {
    await harness.dispose();
  }
});

test("a real Claude turn: hook lane publishes running, the tool TYPE, and the question census on the exact owned row", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("claude");
    const transcript = transcriptFile(harness, "claude-session.jsonl");
    const bootstrap = bootstrapOf(harness);

    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "SessionStart"))).status, "accepted");
    assert.equal(harness.view(id).busy, null, "a session boundary alone claims no foreground state");

    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-1" }))).status, "accepted");
    const running = await harness.waitView(id, (view) => view.busy === true, "the accepted root turn");
    assert.deepEqual(running.activity, ["Working"]);
    assert.equal(running.pendingInput, null, "no question has been observed either way");

    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "PreToolUse", { prompt_id: "p-1", tool_name: "Bash", tool_use_id: "t-1" }))).status, "accepted");
    const tool = await harness.waitView(id, (view) => view.activity[0] === "bash", "the observed tool TYPE");
    assert.equal(tool.busy, true);

    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "PreToolUse", {
      prompt_id: "p-1", tool_name: "AskUserQuestion", tool_use_id: "q-1",
    }))).status, "accepted");
    const asked = await harness.waitView(id, (view) => view.pendingInput === true, "the open question request");
    assert.equal(asked.busy, true);

    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "PostToolUse", {
      prompt_id: "p-1", tool_name: "AskUserQuestion", tool_use_id: "q-1",
    }))).status, "accepted");
    const answered = await harness.waitView(id, (view) => view.pendingInput === false, "the definitively closed question");
    assert.equal(answered.busy, true, "closing a question does not end the turn");

    // Nothing a provider names may travel on this lane: the row's whole public
    // surface stays free of prompt, tool, and answer content.
    const serialized = JSON.stringify(harness.manager.list());
    for (const secret of [SECRET_PROMPT, SECRET_TOOL_INPUT, transcript]) {
      assert.ok(!serialized.includes(secret), "the row view carries no provider content or path");
    }
  } finally {
    await harness.dispose();
  }
});

test("Claude Ready comes only from the persisted root summary appended after the relay's ACK", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("claude");
    const transcript = transcriptFile(harness, "claude-session.jsonl");
    const bootstrap = bootstrapOf(harness);
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "SessionStart"));
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-1" }));
    await harness.waitView(id, (view) => view.busy === true, "the running root turn");

    // A summary that already predates this turn is history: the barrier is the
    // file's size at the synchronous moment of this run's own Stop callback, so
    // an older row can never close the turn that is ending now.
    appendFileSync(transcript, claudeSummaryRow(), "utf8");

    // The root Stop carries this provider harness's own background snapshot. Its
    // callback runs SYNCHRONOUSLY inside the broker before the ACK, so the
    // transcript barrier is this file's size at this instant - and the summary
    // for this turn can only be appended after the relay returns.
    const stop = await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "Stop", {
      prompt_id: "p-1",
      background_tasks: [
        { id: "task-1", description: SECRET_AGENT_MESSAGE, type: "agent", status: "running", backgrounded: true },
        { id: "task-2", description: SECRET_AGENT_MESSAGE, type: "agent", status: "pending", backgrounded: true },
        { id: "shell-1", description: SECRET_AGENT_MESSAGE, type: "shell", status: "running", backgrounded: true },
        // Not background work: a foreground task and an already-settled one.
        { id: "task-3", description: SECRET_AGENT_MESSAGE, type: "agent", status: "running", backgrounded: false },
        { id: "task-4", description: SECRET_AGENT_MESSAGE, type: "agent", status: "completed", backgrounded: true },
      ],
    }));
    assert.equal(stop.status, "accepted");
    assert.equal(stop.delivered, "event", "the whole snapshot validated; it was not silently dropped");
    const stopped = harness.view(id);
    assert.equal(stopped.busy, null, "this observer's own Stop hook is never proof of Ready or idle");
    assert.deepEqual(stopped.activity, []);
    assert.equal(stopped.activeTasks, 2, "the root Stop snapshot is a real observed count");
    assert.equal(stopped.activeShells, 1);

    appendFileSync(transcript, claudeSummaryRow(), "utf8");
    const ready = await harness.waitView(id, (view) => view.busy === false, "the source-confirmed root turn end");
    assert.deepEqual(ready.activity, ["Ready"]);
    assert.equal(ready.activeTasks, 2, "the published snapshot survives its own turn end");
    assert.equal(ready.activeShells, 1);
    assert.ok(!JSON.stringify(ready).includes(SECRET_AGENT_MESSAGE));
  } finally {
    await harness.dispose();
  }
});

test("an inconclusive root summary is neither Ready nor idle, and the same live observer recovers on fresh data", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("claude");
    const transcript = transcriptFile(harness, "claude-session.jsonl");
    const bootstrap = bootstrapOf(harness);
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "SessionStart"));
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-1" }));
    await harness.waitView(id, (view) => view.busy === true, "the running root turn");

    // Publish a real root snapshot first, so the read that has to decide the
    // inconclusive summary leaves an observable fact of its own behind.
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "Stop", {
      prompt_id: "p-1",
      background_tasks: [{ id: "task-1", description: SECRET_AGENT_MESSAGE, type: "agent", status: "running", backgrounded: true }],
    }));
    await harness.waitView(id, (view) => view.activeTasks === 1, "the root Stop snapshot");

    // One batch: a summary whose `preventedContinuation: false` sits alongside a
    // nonempty `hookErrors` array (blocking and nonblocking outcomes mixed, so the
    // turn is undecidable rather than terminal), plus a structured task transition.
    // Nothing else in this run can move the published snapshot to unknown, so the
    // count going unknown is the observable proof that THIS window was actually
    // read and decided - before any newer prompt can retire the armed read.
    appendFileSync(transcript, `${claudeSummaryRow({ preventedContinuation: false, hookErrors: [SECRET_AGENT_MESSAGE] })}${JSON.stringify({
      type: "attachment",
      attachment: { type: "task_status", taskId: "b-1", taskType: "local_bash", status: "completed" },
    })}\n`, "utf8");
    await harness.waitView(id, (view) => view.activeTasks === null, "the appended summary batch was read and decided");

    assert.ok(!harness.viewsOf(id).some((view) => view.busy === false),
      "an undecidable summary never became Ready, and nothing published since the Stop claimed it either");

    // The same live observer recovers on the next accepted root turn.
    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-2" }))).status, "accepted");
    const resumed = await harness.waitView(id, (view) => view.busy === true && view.activity[0] === "Working", "the next accepted root turn");
    assert.equal(resumed.activeTasks, null, "new root work keeps the retired turn's snapshot unknown");
  } finally {
    await harness.dispose();
  }
});

test("a lost hook is a gap that recovers on the same alive observer, not a retired capture", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("claude");
    const transcript = transcriptFile(harness, "claude-session.jsonl");
    const bootstrap = bootstrapOf(harness);
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "SessionStart"));
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-1" }));
    await harness.waitView(id, (view) => view.busy === true, "the running root turn");

    // The provider's hook ran but its stdin was unusable: the relay reports one
    // closed failure, and the supported observations collapse to unknown.
    const gap = await harness.relayRaw(bootstrap, "this is not provider json");
    assert.equal(gap.status, "accepted");
    assert.equal(gap.delivered, "failure");
    const degraded = await harness.waitView(id, (view) => view.busy === null, "the withdrawn foreground");
    assert.equal(degraded.pendingInput, null);
    assert.deepEqual(degraded.activity, []);

    // The run, its registration, and its observer are all still alive: fenced
    // fresh data from this same run publishes again on the same row.
    assert.equal((await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-2" }))).status, "accepted");
    const recovered = await harness.waitView(id, (view) => view.busy === true, "recovery from the gap");
    assert.equal(recovered.lifecycle, "alive");
    assert.equal(harness.leases[0]!.cleanupCount, 0, "a live child still owns the files it was told to read");
  } finally {
    await harness.dispose();
  }
});

test("retiring the run releases the registration, invalidates the capture, and a late file or hook restores nothing", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("claude");
    const transcript = transcriptFile(harness, "claude-session.jsonl");
    const bootstrap = bootstrapOf(harness);
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "SessionStart"));
    await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-1" }));
    await harness.waitView(id, (view) => view.busy === true, "the running root turn");

    await harness.manager.stop(id, { confirmed: true });
    // The stop retired the callbacks immediately: this run's own token is now
    // refused by the broker, and nothing is queued or retried for it.
    const late = await harness.relay(bootstrap, claudeHook(transcript, "sess-a", "Stop", { prompt_id: "p-1" }));
    assert.notEqual(late.status, "accepted", "a released native registration cannot be delivered to again");

    // The child's real exit is what releases the staged files - not the stop call.
    const pty = harness.spawned[0]!;
    assert.ok(pty.killSignals.includes("SIGTERM"));
    await harness.waitView(id, (view) => view.lifecycle === "exited", "the row's own settlement");
    assert.equal(harness.leases[0]!.cleanupCount, 1, "the settled child's staged files are released once");

    // A late summary in the watched file, and a late event for another live row,
    // cannot revive the retired capture: the exited row stays truthful. The
    // observer was disposed at retirement, so this drains its machinery rather
    // than waiting on a timer that a retry would have to use.
    appendFileSync(transcript, claudeSummaryRow(), "utf8");
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const exited = harness.view(id);
    assert.equal(exited.lifecycle, "exited");
    assert.equal(exited.busy, null, "an exited run never becomes Ready");
    assert.deepEqual(exited.activity, []);
  } finally {
    await harness.dispose();
  }
});

test("observations reach only the exact owned row: a sibling row's hook changes nothing here", async () => {
  const harness = await makeHarness();
  try {
    const first = await harness.create("claude");
    const second = await harness.create("claude");
    const transcript = transcriptFile(harness, "claude-session.jsonl");
    const firstBootstrap = bootstrapOf(harness, 0);

    await harness.relay(firstBootstrap, claudeHook(transcript, "sess-a", "SessionStart"));
    await harness.relay(firstBootstrap, claudeHook(transcript, "sess-a", "UserPromptSubmit", { prompt_id: "p-1" }));
    await harness.waitView(first, (view) => view.busy === true, "the first row's running turn");

    const other = harness.view(second);
    assert.equal(other.busy, null, "another row's provider state is untouched");
    assert.equal(other.activeTasks, null);
    assert.deepEqual(other.activity, []);
    assert.deepEqual(other.statusSupport, harness.view(first).statusSupport,
      "each row declares its own source's applicability independently");

    // A foreign bootstrap for a row that is not this one's can never route here:
    // the broker authenticates the source, and the manager re-proves the record.
    const otherBootstrap = bootstrapOf(harness, 1);
    assert.notEqual(otherBootstrap.instanceId, firstBootstrap.instanceId);
    assert.notEqual(otherBootstrap.token, firstBootstrap.token);
  } finally {
    await harness.dispose();
  }
});

test("a real Codex turn: the owned rollout's persisted root records drive Running then Ready, with N/A census categories", async () => {
  const harness = await makeHarness();
  try {
    const id = await harness.create("codex");
    const thread = "11111111-1111-4111-8111-111111111111";
    const transcript = transcriptFile(harness, `rollout-2026-01-02T03-04-05-${thread}.jsonl`);
    const bootstrap = bootstrapOf(harness);

    let ordinal = 0;
    const row = (payload: Record<string, unknown>) => `${JSON.stringify({
      timestamp: "2026-01-02T03:04:05.000Z",
      ordinal: (ordinal += 1),
      ...payload,
    })}\n`;
    // The provider's own head record: it corroborates the thread named by the
    // canonical rollout basename, and it predates this run's SessionStart hook.
    appendFileSync(transcript, row({
      type: "session_meta",
      payload: {
        session_id: "lineage-1",
        id: thread,
        timestamp: "2026-01-02T03:04:05",
        cwd: "/synthetic/work",
        originator: "test-harness",
        cli_version: "0.167.2",
        source: "cli",
        model_provider: null,
        base_instructions: null,
      },
    }), "utf8");

    assert.equal((await harness.relay(bootstrap, {
      hook_event_name: "SessionStart",
      session_id: "lineage-1",
      transcript_path: transcript,
      source: "startup",
      prompt: SECRET_PROMPT,
    })).status, "accepted");

    // Fresh records after the bind floor are the only ones that can attest the
    // turn running now.
    appendFileSync(transcript, row({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1", root_turn_id: "turn-1", model_context_window: null },
    }), "utf8");
    const running = await harness.waitView(id, (view) => view.busy === true, "the persisted root task_started");
    assert.equal(running.lifecycle, "alive");

    appendFileSync(transcript, row({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        root_turn_id: "turn-1",
        last_agent_message: SECRET_AGENT_MESSAGE,
      },
    }), "utf8");
    const ready = await harness.waitView(id, (view) => view.busy === false, "the durable root task_complete");
    assert.ok(ready.activity.length <= 1, "the published activity stays bounded and sanitized");
    assert.ok(!JSON.stringify(harness.manager.list()).includes(SECRET_AGENT_MESSAGE));
    assert.ok(!JSON.stringify(harness.manager.list()).includes(transcript));

    // The categories this route cannot report are a positive N/A, never a zero,
    // and never an unknown that a later hook could "recover" into a guess.
    assert.deepEqual(ready.statusSupport, {
      agent: "supported", input: "unsupported", tasks: "unsupported", shells: "unsupported", activity: "supported",
    });
    assert.equal(ready.pendingInput, null);
    assert.equal(ready.activeTasks, null);
    assert.equal(ready.activeShells, null);
  } finally {
    await harness.dispose();
  }
});
