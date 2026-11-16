/**
 * Focused coverage for the production owned-Codex-backend adapter (issue #277
 * owning-manager slice).
 *
 * EVIDENCE SCOPE: the plan is a test rendering plan, and the child is either a
 * hand-built captured handle (for the termination and Windows-delivery cases) or a
 * real `node:child_process` spawn of a path that cannot exist (for the one case
 * that proves the adapter returns a genuine Node child whose readers the lease can
 * bind to). Nothing here runs a real Codex binary, opens a socket, or reads any
 * provider configuration or credential.
 *
 * What it does prove: the adapter spawns exactly what the plan rendered, with the
 * stdio shape the lease requires; a Windows batch plan's pre-escaped command line
 * is appended verbatim with `windowsVerbatimArguments` instead of an empty argv
 * that would drop the whole app-server command; termination goes through the
 * injected owned-tree authority on the exact captured handle, escalates once inside
 * a bounded window, and never claims a gone process without its exit; and the
 * operator environment reaches the backend unchanged, with no bearer and no auth
 * variable of any kind.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import test from "node:test";

import {
  OWNED_CODEX_BACKEND_TERMINATION_GRACE_MS,
  OWNED_CODEX_BACKEND_TERMINATION_KILL_MS,
  createOwnedCodexBackendLauncher,
  type OwnedCodexBackendSpawnOptions,
} from "../src/session-host/native-codex-owned-launch";
import {
  OwnedCodexBackendReadinessError,
  type OwnedCodexBackendLaunchIdentity,
  type OwnedCodexBackendLease,
} from "../src/session-host/native-codex-backend";
import type {
  NativeCodexOwnedLaunchPlan,
  NativeCodexOwnedTuiConnection,
} from "../src/session-host/native-cli-launch";

const READINESS_TITLE = "codex app-server (WebSockets)";

function readinessBanner(endpoint: string): string {
  const port = endpoint.slice(endpoint.lastIndexOf(":") + 1);
  return [
    READINESS_TITLE,
    `  listening on: ${endpoint}`,
    `  readyz: http://127.0.0.1:${port}/readyz`,
    `  healthz: http://127.0.0.1:${port}/healthz`,
    "  note: synthetic adapter fixture",
    "",
  ].join("\n");
}

/** A captured handle with the shape the lease binds its proof to. */
class CapturedChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 42_4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

/** A test plan recording exactly what the adapter asked it to render. */
class RecordingPlan implements NativeCodexOwnedLaunchPlan {
  readonly backendEnv: NodeJS.ProcessEnv = {
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    CODEX_HOME: "/synthetic/home/.codex",
    OPERATOR_SETTING: "kept",
  };
  readonly renders: { controlArgs: readonly string[]; env: Readonly<NodeJS.ProcessEnv> }[] = [];
  rendered: { file: string; args: string[]; commandLine?: string; env: NodeJS.ProcessEnv; cwd: string };

  constructor(cwd = "/synthetic/workspace") {
    this.rendered = {
      file: "/synthetic/bin/codex",
      args: ["app-server"],
      env: { ...this.backendEnv },
      cwd,
    };
  }

  renderBackend(controlArgs: readonly string[], environment: NodeJS.ProcessEnv) {
    this.renders.push({ controlArgs, env: environment });
    return this.rendered;
  }

  renderTui(_connection: NativeCodexOwnedTuiConnection): never {
    throw new Error("the adapter never renders the TUI");
  }
}

interface AdapterCapture {
  readonly plan: RecordingPlan;
  readonly lease: OwnedCodexBackendLease;
  readonly spawnCalls: { file: string; args: readonly string[]; options: OwnedCodexBackendSpawnOptions }[];
  readonly terminateCalls: { child: unknown; signal: string }[];
  readonly child: CapturedChild;
}

interface AdapterCase {
  readonly platform?: NodeJS.Platform;
  readonly rendered?: RecordingPlan["rendered"];
  readonly terminationGraceMs?: number;
  readonly terminationKillMs?: number;
  /** Supply a child factory to model a spawn that returns something else. */
  readonly childFactory?: () => CapturedChild;
  /** Observes (and may throw from) each owned termination call after it is recorded. */
  readonly onTerminate?: (signal: string) => void;
}

function makeAdapter(options: AdapterCase = {}): AdapterCapture {
  const plan = new RecordingPlan();
  if (options.rendered !== undefined) plan.rendered = options.rendered;
  const child = options.childFactory?.() ?? new CapturedChild();
  const spawnCalls: AdapterCapture["spawnCalls"] = [];
  const terminateCalls: AdapterCapture["terminateCalls"] = [];
  const factory = createOwnedCodexBackendLauncher({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
    ...(options.terminationKillMs === undefined ? {} : { terminationKillMs: options.terminationKillMs }),
    spawnChild: (file, args, spawnOptions) => {
      spawnCalls.push({ file, args, options: spawnOptions });
      // Emit `spawn` the way Node does, after the synchronous return.
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    terminateTree: (terminated, signal) => {
      terminateCalls.push({ child: terminated, signal });
      options.onTerminate?.(signal);
      return undefined;
    },
  });
  const identity: OwnedCodexBackendLaunchIdentity = { leaseId: "adapter-lease", generation: 3 };
  const controller = new AbortController();
  const lease = factory({ identity, plan, signal: controller.signal });
  return { plan, lease, spawnCalls, terminateCalls, child };
}

function bounded<T>(promise: Promise<T>, ms = 4_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test deadline exceeded")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("the adapter spawns exactly what the plan rendered, with the stdio shape the lease requires", async () => {
  const capture = makeAdapter({ platform: "linux" });
  assert.equal(capture.spawnCalls.length, 1, "the lease spawns synchronously at launch");
  const call = capture.spawnCalls[0]!;
  assert.equal(call.file, "/synthetic/bin/codex");
  // The plan receives the lease's CLOSED control argv, not anything the adapter made up.
  const controlArgs = capture.plan.renders[0]!.controlArgs;
  assert.deepEqual(controlArgs.slice(0, 6), ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256"]);
  assert.match(String(controlArgs[6]), /^[0-9a-f]{64}$/u);
  assert.deepEqual(call.args, capture.plan.rendered.args, "the rendered argv is handed to spawn unchanged");
  assert.equal(call.options.cwd, "/synthetic/workspace");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual([...call.options.stdio], ["ignore", "pipe", "pipe"]);
  assert.equal(call.options.detached, true, "a POSIX backend leads its own group so the owned tree authority can terminate it");
  assert.equal(call.options.windowsVerbatimArguments, undefined);

  // The operator environment reaches the backend unchanged, and never a bearer.
  const backendEnv = capture.plan.renders[0]!.env;
  assert.equal(backendEnv.OPERATOR_SETTING, "kept");
  assert.equal(Object.keys(backendEnv).some((key) => key.startsWith("PI_REVIEW_GATE_OWNED_CODEX_RPC_")), false);

  // A recognized banner still produces a real ready value from the real lease.
  capture.child.stdout.write(readinessBanner("ws://127.0.0.1:5599"));
  const ready = await bounded(capture.lease.readiness);
  assert.equal(ready.endpoint, "ws://127.0.0.1:5599");
  capture.child.exit(0);
  capture.child.stdout.end();
  capture.child.stderr.end();
  const settlement = await bounded(capture.lease.settlement);
  assert.deepEqual(settlement, { status: "settled", child: "exited", code: 0, signal: null, stdout: "ended", stderr: "ended" });
});

test("a Windows batch plan's command line is appended verbatim, never dropped as an empty argv", async () => {
  const batch = {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: [],
    commandLine: "/d /s /v:off /c \"C:\\tools\\codex.cmd app-server --listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-sha256 abc\"",
    env: { PATH: "C:\\synthetic\\bin" },
    cwd: "C:\\synthetic\\workspace",
  };
  const capture = makeAdapter({ platform: "win32", rendered: batch });
  const call = capture.spawnCalls[0]!;
  assert.equal(call.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(call.args, [batch.commandLine], "the whole rendered command line is the one appended argument");
  assert.notDeepEqual(call.args, [], "the control argv is never lost to an empty argv array");
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.equal(call.options.detached, false, "Windows owns termination through the job/tree authority, not a group signal");
  assert.equal(call.options.cwd, "C:\\synthetic\\workspace");
});

test("termination requests SIGTERM on the exact captured handle and stops once it exits", async () => {
  const capture = makeAdapter({ platform: "linux", terminationGraceMs: 200, terminationKillMs: 200 });
  capture.lease.requestStop();
  await tick();
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(capture.terminateCalls[0]!.child, capture.child, "the same captured handle, never a pid or a scan");
  capture.child.exit(null, "SIGTERM");
  await tick();
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM"]);
  const status = capture.lease.status();
  assert.equal(status.terminationAttempted, true);
  assert.equal(status.terminationFailed, false);
});

test("termination escalates to SIGKILL on the same handle when the grace window ends", async () => {
  const capture = makeAdapter({ platform: "linux", terminationGraceMs: 30, terminationKillMs: 300 });
  capture.lease.requestStop();
  await tick();
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  capture.child.exit(null, "SIGKILL");
  await tick();
  assert.equal(capture.lease.status().terminationFailed, false);
});

test("a SIGTERM-only owned termination never reports a force escalation attempt", async () => {
  const capture = makeAdapter({ platform: "linux", terminationGraceMs: 200, terminationKillMs: 200 });
  assert.equal(capture.lease.status().forceEscalationAttempted, false);
  capture.lease.requestStop();
  await tick();
  assert.equal(capture.lease.status().terminationAttempted, true);
  assert.equal(capture.lease.status().forceEscalationAttempted, false, "a SIGTERM request is not a force attempt");
  capture.child.exit(null, "SIGTERM");
  capture.child.stdout.end();
  capture.child.stderr.end();
  await bounded(capture.lease.settlement);
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(capture.lease.status().forceEscalationAttempted, false);
});

test("the force escalation bit is reported immediately before the SIGKILL call and stays sticky", async () => {
  const observed: { signal: string; forced: boolean }[] = [];
  let lease: OwnedCodexBackendLease | undefined;
  const capture = makeAdapter({
    platform: "linux",
    terminationGraceMs: 20,
    terminationKillMs: 300,
    onTerminate: (signal) => {
      observed.push({ signal, forced: lease!.status().forceEscalationAttempted });
    },
  });
  lease = capture.lease;
  capture.lease.requestStop();
  await bounded((async () => {
    while (capture.terminateCalls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  })());
  assert.deepEqual(observed, [
    { signal: "SIGTERM", forced: false },
    { signal: "SIGKILL", forced: true },
  ], "recorded before the forced call, and never at SIGTERM");
  // A force attempt is evidence only: the child has not exited and nothing settled.
  const pending = capture.lease.status();
  assert.equal(pending.forceEscalationAttempted, true);
  assert.equal(pending.exitObserved, false);
  assert.equal(pending.settled, false);
  capture.child.exit(null, "SIGKILL");
  capture.child.stdout.end();
  capture.child.stderr.end();
  await bounded(capture.lease.settlement);
  assert.equal(capture.lease.status().settled, true);
  assert.equal(capture.lease.status().forceEscalationAttempted, true, "sticky after settlement");
});

test("a throwing SIGKILL send is still reported as a force escalation attempt", async () => {
  const capture = makeAdapter({
    platform: "linux",
    terminationGraceMs: 20,
    terminationKillMs: 20,
    onTerminate: (signal) => {
      if (signal === "SIGKILL") throw new Error("synthetic forced-send failure");
    },
  });
  capture.lease.requestStop();
  await bounded((async () => {
    while (!capture.lease.status().terminationFailed) await new Promise((resolve) => setTimeout(resolve, 5));
  })());
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  const status = capture.lease.status();
  assert.equal(status.forceEscalationAttempted, true);
  assert.equal(status.terminationFailed, true);
  assert.equal(status.settled, false, "a reported force attempt is never settlement");
});

test("a backend that survives both windows stays unsettled instead of being called gone", async () => {
  const capture = makeAdapter({ platform: "linux", terminationGraceMs: 20, terminationKillMs: 20 });
  capture.lease.requestStop();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(capture.terminateCalls.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  const status = capture.lease.status();
  assert.equal(status.terminationAttempted, true);
  assert.equal(status.terminationFailed, true);
  assert.equal(status.settled, false, "a failed termination is never reported as gone");
});

test("a child that never forked is never signalled, and its settlement stays honest", async () => {
  const capture = makeAdapter({
    platform: "linux",
    terminationGraceMs: 20,
    terminationKillMs: 20,
    childFactory: () => {
      const child = new CapturedChild();
      child.pid = undefined;
      return child;
    },
  });
  capture.lease.requestStop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(capture.terminateCalls, [], "nothing is signalled when no process exists");
  // The lease still requires its own proof; the adapter never fabricated one.
  assert.equal(capture.lease.status().settled, false);
});

test("a spawned child without both stdio readers is refused by the lease, never hidden behind a throw", async () => {
  const capture = makeAdapter({
    platform: "linux",
    childFactory: () => {
      const child = new CapturedChild();
      // A handle whose readers are gone can never carry the lease's proof.
      (child as unknown as { stdout: unknown }).stdout = undefined;
      return child;
    },
  });
  await assert.rejects(
    bounded(capture.lease.readiness),
    (error: unknown) => error instanceof OwnedCodexBackendReadinessError && error.code === "stream-unavailable",
  );
  assert.equal(capture.lease.status().settled, false, "an unprovable child is never declared gone");
});

test("the real spawner returns a genuine Node child whose pre-spawn failure the lease proves", async () => {
  const plan = new RecordingPlan(process.cwd());
  plan.rendered = {
    file: join(process.cwd(), "definitely-not-an-executable-2f8c1a"),
    args: [],
    env: { ...plan.backendEnv },
    cwd: process.cwd(),
  };
  const lease = createOwnedCodexBackendLauncher({ platform: process.platform })({
    identity: { leaseId: "real-spawn-lease", generation: 0 },
    plan,
    signal: new AbortController().signal,
  });
  await assert.rejects(
    bounded(lease.readiness),
    (error: unknown) => error instanceof OwnedCodexBackendReadinessError
      && (error.code === "spawn-failed" || error.code === "child-exited" || error.code === "stream-unavailable"),
  );
  const settlement = await bounded(lease.settlement);
  assert.deepEqual(settlement, { status: "settled", child: "not-created" });
});

test("the adapter rejects a malformed termination window instead of defaulting to an unbounded one", () => {
  assert.throws(() => createOwnedCodexBackendLauncher({ terminationGraceMs: -1 }), RangeError);
  assert.throws(() => createOwnedCodexBackendLauncher({ terminationKillMs: 1.5 }), RangeError);
  // The shipped defaults are finite.
  assert.ok(OWNED_CODEX_BACKEND_TERMINATION_GRACE_MS > 0);
  assert.ok(OWNED_CODEX_BACKEND_TERMINATION_KILL_MS > 0);
});
