/**
 * Owned Codex backend lease acceptance (synthetic, no provider/model runtime).
 *
 * Ordinary children and stdio readers here are hand-built captured Node
 * handles; one regression uses a real Node spawn of a nonexistent executable
 * to prove the pre-spawn failure path. The tests prove the lease contract
 * only: generated bearer/digest separation, child-only TUI material,
 * recognized-banner parsing, deadline/abort behavior, and fail-closed
 * child/reader settlement. They are not evidence that a live Codex version,
 * Windows PTY launch, or host integration works.
 */
import assert from "node:assert/strict";
import { spawn as spawnChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX,
  NATIVE_CODEX_BACKEND_DEFAULT_STARTUP_TIMEOUT_MS,
  NATIVE_CODEX_BACKEND_MAX_BANNER_BYTES,
  OwnedCodexBackendReadinessError,
  launchOwnedCodexBackend,
  type OwnedCodexBackendFailureCode,
  type OwnedCodexBackendLaunchIdentity,
  type OwnedCodexBackendLease,
  type OwnedCodexBackendReady,
  type OwnedCodexBackendSettlement,
  type OwnedCodexTuiConnection,
} from "../src/session-host/native-codex-backend";

const READINESS_TITLE = "codex app-server (WebSockets)";

function readinessBanner(endpoint: string, note = "binds localhost only (use SSH port-forwarding for remote access)"): string {
  const port = endpoint.slice(endpoint.lastIndexOf(":") + 1);
  return [
    READINESS_TITLE,
    `  listening on: ${endpoint}`,
    `  readyz: http://127.0.0.1:${port}/readyz`,
    `  healthz: http://127.0.0.1:${port}/healthz`,
    `  note: ${note}`,
    "",
  ].join("\n");
}

const READY_BANNER = readinessBanner("ws://127.0.0.1:54321");

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly child: ChildProcess;
  pid = 4_242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls = 0;

  constructor() {
    super();
    this.child = this as unknown as ChildProcess;
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface LaunchOptions {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly identity?: OwnedCodexBackendLaunchIdentity;
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly terminate?: (child: ChildProcess) => unknown;
  readonly spawn?: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
}

interface LaunchCapture {
  readonly fake: FakeChild;
  readonly lease: OwnedCodexBackendLease;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly spawnCalls: () => number;
  readonly terminateCalls: () => number;
  readonly terminatedChildren: () => readonly ChildProcess[];
  readonly controlArgs: () => readonly string[] | undefined;
  readonly backendEnv: () => NodeJS.ProcessEnv | undefined;
}

interface ReadyCapture {
  readonly ready: OwnedCodexBackendReady;
  readonly tui: OwnedCodexTuiConnection;
  readonly token: string;
  readonly authEnvName: string;
}

function launch(options: LaunchOptions = {}): LaunchCapture {
  const fake = new FakeChild();
  const baseEnv = options.baseEnv ?? {
    PATH: "/usr/bin",
    HOME: "/home/operator",
    OPERATOR_SETTING: "kept",
  };
  let spawnCalls = 0;
  let terminateCalls = 0;
  let controlArgs: readonly string[] | undefined;
  let backendEnv: NodeJS.ProcessEnv | undefined;
  let spawnedChild: ChildProcess | undefined;
  const terminated: ChildProcess[] = [];
  const lease = launchOwnedCodexBackend({
    identity: options.identity ?? { leaseId: "lease-test", generation: 1 },
    baseEnv,
    spawnBackend: (args, env) => {
      spawnCalls += 1;
      controlArgs = args;
      backendEnv = env;
      const spawned = options.spawn ? options.spawn(args, env) : (fake as unknown as ChildProcess);
      spawnedChild = spawned;
      return spawned;
    },
    terminateOwnedBackend: (child) => {
      terminateCalls += 1;
      terminated.push(child);
      return options.terminate ? options.terminate(child) : undefined;
    },
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // A real Node ChildProcess emits `spawn` after launch returns. Mirror that
  // for the synthetic successful child so pre-spawn and post-spawn errors stay
  // distinguishable in tests.
  if (spawnedChild === (fake as unknown as ChildProcess)) fake.emit("spawn");
  return {
    fake,
    lease,
    baseEnv,
    spawnCalls: () => spawnCalls,
    terminateCalls: () => terminateCalls,
    terminatedChildren: () => terminated,
    controlArgs: () => controlArgs,
    backendEnv: () => backendEnv,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function bounded<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test deadline exceeded")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function expectReadinessFailure(
  lease: OwnedCodexBackendLease,
  code: OwnedCodexBackendFailureCode,
): Promise<OwnedCodexBackendReadinessError> {
  try {
    await bounded(lease.readiness);
  } catch (error) {
    assert.ok(error instanceof OwnedCodexBackendReadinessError);
    assert.equal(error.code, code);
    assert.equal(error.message, `owned Codex backend readiness failed: ${code}`);
    return error;
  }
  assert.fail("expected readiness to reject");
}

async function expectPending(promise: Promise<unknown>, ms = 25): Promise<void> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => "settled" as const, () => "rejected" as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);
  assert.equal(outcome, pending);
}

async function finishReader(stream: PassThrough): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return;
  const ended = once(stream, "end");
  stream.end();
  await ended;
}

async function settleNormally(capture: LaunchCapture, code = 0): Promise<OwnedCodexBackendSettlement> {
  capture.fake.emitExit(code);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  return bounded(capture.lease.settlement);
}

async function readyConnection(capture: LaunchCapture): Promise<ReadyCapture> {
  capture.fake.stderr.write(READY_BANNER);
  const ready = await bounded(capture.lease.readiness);
  const tui = ready.createTuiConnection();
  const token = ready.readObserverBearer();
  const authIndex = tui.args.indexOf("--remote-auth-token-env");
  assert.ok(authIndex >= 0);
  const authEnvName = tui.args[authIndex + 1];
  if (typeof authEnvName !== "string") assert.fail("missing TUI auth environment name");
  return { ready, tui, token, authEnvName };
}

test("launch generates a fresh bearer, digest-only argv, and a TUI-only env clone", async () => {
  const capture = launch();
  const { ready, tui, token, authEnvName } = await readyConnection(capture);
  try {
    assert.equal(capture.spawnCalls(), 1);
    assert.equal(capture.lease.status().spawnObserved, true);
    assert.equal(capture.lease.status().spawnFailureObserved, false);
    const args = capture.controlArgs();
    assert.ok(args);
    assert.deepEqual(args, [
      "app-server",
      "--listen", "ws://127.0.0.1:0",
      "--ws-auth", "capability-token",
      "--ws-token-sha256", createHash("sha256").update(token, "utf8").digest("hex"),
    ]);
    assert.ok(Object.isFrozen(args));
    assert.ok(!args.some((arg) => arg.includes(token)));
    assert.ok(!args.some((arg) => /stdio:\/\/|unix|uds/i.test(arg)));
    assert.equal(ready.endpoint, "ws://127.0.0.1:54321");
    assert.match(ready.endpoint, /^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);

    const bearer = ready.readObserverBearer();
    assert.equal(bearer, token);
    assert.equal(token.length, 43);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.match(token, /^[A-Za-z0-9_-]+$/);

    assert.deepEqual(tui.args, ["--remote", ready.endpoint, "--remote-auth-token-env", authEnvName]);
    assert.ok(Object.isFrozen(tui.args));
    assert.ok(Object.isFrozen(tui.env));
    assert.ok(authEnvName.startsWith(NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX));
    assert.equal(tui.env[authEnvName], token);
    assert.deepEqual(tui.env, { ...capture.baseEnv, [authEnvName]: token });

    const backendEnv = capture.backendEnv();
    assert.ok(backendEnv);
    assert.notStrictEqual(backendEnv, capture.baseEnv);
    assert.deepEqual(backendEnv, capture.baseEnv);
    assert.equal(backendEnv[authEnvName], undefined);
    assert.ok(!Object.values(backendEnv).includes(token));
    assert.deepEqual(capture.baseEnv, {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      OPERATOR_SETTING: "kept",
    });
    assert.equal(process.env[authEnvName], undefined);
    assert.ok(!Object.values(process.env).includes(token));

    assert.equal(JSON.stringify(capture.lease), "{}");
    assert.equal(JSON.stringify(ready), "{}");
    assert.ok(!JSON.stringify(capture.lease.status()).includes(token));
    assert.ok(!JSON.stringify(capture.lease.status()).includes(authEnvName));

    const second = ready.createTuiConnection();
    assert.notStrictEqual(second, tui);
    assert.notStrictEqual(second.env, tui.env);
    assert.deepEqual(second.env, tui.env);
    try {
      (second.env as Record<string, string | undefined>)[authEnvName] = "tampered";
    } catch {
      // The object is frozen in strict mode; either way the original must win.
    }
    assert.equal(second.env[authEnvName], token);

    assert.equal(capture.lease.status().phase, "ready");
    const settlement = await settleNormally(capture);
    assert.deepEqual(settlement, {
      status: "settled",
      child: "exited",
      code: 0,
      signal: null,
      stdout: "ended",
      stderr: "ended",
    });
    assert.equal(capture.lease.status().phase, "settled");
    assert.equal(capture.fake.killCalls, 0);
    assert.equal(capture.terminateCalls(), 0);
  } finally {
    capture.lease.requestStop();
    await finishReader(capture.fake.stdout).catch(() => undefined);
    await finishReader(capture.fake.stderr).catch(() => undefined);
    capture.fake.emitExit(0);
    await bounded(capture.lease.settlement).catch(() => undefined);
  }
});

test("launch copies the operator base environment instead of retaining it", async () => {
  const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", OPERATOR_SETTING: "kept" };
  const capture = launch({ baseEnv });
  baseEnv.PATH = "/mutated";
  baseEnv.ADDED_LATER = "later";
  const { tui } = await readyConnection(capture);
  try {
    assert.equal(tui.env.PATH, "/usr/bin");
    assert.equal(tui.env.OPERATOR_SETTING, "kept");
    assert.equal(tui.env.ADDED_LATER, undefined);
    assert.equal(capture.backendEnv()?.PATH, "/usr/bin");
    assert.equal(capture.backendEnv()?.ADDED_LATER, undefined);
  } finally {
    await settleNormally(capture);
  }
});

test("each lease gets a fresh bearer and a fresh non-colliding auth env name", async () => {
  const first = launch();
  const firstReady = await readyConnection(first);
  const second = launch();
  const secondReady = await readyConnection(second);
  try {
    assert.notEqual(firstReady.token, secondReady.token);
    assert.notEqual(firstReady.authEnvName, secondReady.authEnvName);
    assert.equal(Buffer.from(firstReady.token, "base64url").length, 32);
    assert.equal(Buffer.from(secondReady.token, "base64url").length, 32);
  } finally {
    await settleNormally(first);
    await settleNormally(second);
  }
});

test("reserved TUI auth variables are additive, not overwritten", async () => {
  const operatorKey = `${NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX}OPERATOR`;
  const capture = launch({ baseEnv: { PATH: "/usr/bin", [operatorKey]: "operator-value" } });
  const { tui, token, authEnvName } = await readyConnection(capture);
  try {
    assert.notEqual(authEnvName, operatorKey);
    assert.equal(tui.env[operatorKey], "operator-value");
    assert.equal(tui.env[authEnvName], token);
    assert.deepEqual(capture.backendEnv(), capture.baseEnv);
  } finally {
    await settleNormally(capture);
  }
});

test("launch copies an immutable identity and keeps default serialization secret-free", async () => {
  const identity = { leaseId: "lease-immutable", generation: 9 };
  const capture = launch({ identity });
  identity.leaseId = "mutated";
  identity.generation = 10;
  assert.equal(capture.lease.identity.leaseId, "lease-immutable");
  assert.equal(capture.lease.identity.generation, 9);
  assert.ok(Object.isFrozen(capture.lease.identity));
  assert.equal(JSON.stringify(capture.lease), "{}");
  await settleNormally(capture);
});

test("accepts the recognized banner split across chunks with ANSI sequences", async () => {
  const capture = launch();
  capture.fake.stderr.write("\x1b[1;3");
  await tick();
  capture.fake.stderr.write("6mcodex app-server (WebSockets)\x1b[0m\n  \x1b[2mlistening on:\x1b[0m \x1b[32mws://127.0.0.");
  await tick();
  assert.equal(capture.lease.status().ready, false);
  capture.fake.stderr.write(
    "1:43210\x1b[0m\n  readyz: http://127.0.0.1:43210/readyz\n  healthz: http://127.0.0.1:43210/healthz\n  note: binds localhost only\n",
  );
  const ready = await bounded(capture.lease.readiness);
  assert.equal(ready.endpoint, "ws://127.0.0.1:43210");
  await settleNormally(capture);
});

test("accepts the recognized readiness banner from the captured stdout reader too", async () => {
  const capture = launch();
  capture.fake.stdout.write(READY_BANNER);
  const ready = await bounded(capture.lease.readiness);
  assert.equal(ready.endpoint, "ws://127.0.0.1:54321");
  await settleNormally(capture);
});

test("a complete recognized record at natural reader end is accepted", async () => {
  const capture = launch();
  const banner = readinessBanner("ws://127.0.0.1:4567");
  capture.fake.stderr.write(banner.slice(0, -1));
  await tick();
  assert.equal(capture.lease.status().ready, false);
  await finishReader(capture.fake.stderr);
  const ready = await bounded(capture.lease.readiness);
  assert.equal(ready.endpoint, "ws://127.0.0.1:4567");
  await settleNormally(capture);
});

test("both captured readers ending without a banner fails readiness closed", async () => {
  const capture = launch();
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  await expectReadinessFailure(capture.lease, "endpoint-not-observed");
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(0);
  const settlement = await bounded(capture.lease.settlement);
  assert.equal(settlement.child, "exited");
});

test("rejects an oversized banner with a fixed code and bounded retention", async () => {
  const capture = launch();
  capture.fake.stdout.write("x".repeat(NATIVE_CODEX_BACKEND_MAX_BANNER_BYTES + 1));
  await expectReadinessFailure(capture.lease, "banner-oversize");
  assert.equal(capture.terminateCalls(), 1);
  assert.equal(capture.lease.status().ready, false);
  assert.ok(!JSON.stringify(capture.lease.status()).includes("x".repeat(64)));
  await settleNormally(capture);
});

const invalidEndpointCases: readonly {
  readonly label: string;
  readonly endpoint: string;
  readonly code: OwnedCodexBackendFailureCode;
}[] = [
  { label: "a hostname endpoint", endpoint: "ws://localhost:1234", code: "endpoint-non-loopback" },
  { label: "a non-loopback IPv4 endpoint", endpoint: "ws://192.168.1.2:1234", code: "endpoint-non-loopback" },
  { label: "another loopback IPv4 address", endpoint: "ws://127.0.0.2:1234", code: "endpoint-non-loopback" },
  { label: "an IPv6 loopback endpoint", endpoint: "ws://[::1]:1234", code: "endpoint-non-loopback" },
  { label: "credentials in the endpoint", endpoint: "ws://user:pass@127.0.0.1:1234", code: "endpoint-non-loopback" },
  { label: "a missing port", endpoint: "ws://127.0.0.1", code: "endpoint-invalid" },
  { label: "a zero port", endpoint: "ws://127.0.0.1:0", code: "endpoint-invalid" },
  { label: "an out-of-range port", endpoint: "ws://127.0.0.1:65536", code: "endpoint-invalid" },
  { label: "a leading-zero port", endpoint: "ws://127.0.0.1:0123", code: "endpoint-invalid" },
  { label: "a path-bearing endpoint", endpoint: "ws://127.0.0.1:1234/path", code: "endpoint-invalid" },
  { label: "a query-bearing endpoint", endpoint: "ws://127.0.0.1:1234?token=x", code: "endpoint-invalid" },
  { label: "a fragment-bearing endpoint", endpoint: "ws://127.0.0.1:1234#frag", code: "endpoint-invalid" },
  { label: "a credential-suffixed authority", endpoint: "ws://127.0.0.1:1234@evil", code: "endpoint-invalid" },
  { label: "a second port component", endpoint: "ws://127.0.0.1:1234:5678", code: "endpoint-invalid" },
  { label: "a secure websocket scheme", endpoint: "wss://127.0.0.1:1234", code: "endpoint-invalid" },
  { label: "an uppercase websocket scheme", endpoint: "WS://127.0.0.1:1234", code: "endpoint-invalid" },
];

for (const item of invalidEndpointCases) {
  test(`rejects ${item.label}`, async () => {
    const capture = launch();
    capture.fake.stderr.write(readinessBanner(item.endpoint));
    await expectReadinessFailure(capture.lease, item.code);
    const status = capture.lease.status();
    assert.equal(status.ready, false);
    assert.equal(status.readinessFailure, item.code);
    assert.equal(capture.terminateCalls(), 1);
    await settleNormally(capture);
  });
}

test("rejects duplicate or ambiguous endpoint declarations", async () => {
  for (const banner of [
    `${READINESS_TITLE}\n  listening on: ws://127.0.0.1:1111\n  listening on: ws://127.0.0.1:2222\n`,
    `${READINESS_TITLE}\n  listening on: ws://127.0.0.1:1111\n  listening on: ws://127.0.0.1:1111\n`,
  ]) {
    const capture = launch();
    capture.fake.stderr.write(banner);
    await expectReadinessFailure(capture.lease, "endpoint-ambiguous");
    await settleNormally(capture);
  }
});

test("rejects chunked and concatenated ambiguity identically", async () => {
  const prefix = `${READINESS_TITLE}\n  listening on: ws://127.0.0.1:1111 `;
  const suffix = "ws://127.0.0.1:2222\n";

  const chunked = launch();
  chunked.fake.stderr.write(prefix);
  await tick();
  assert.equal(chunked.lease.status().ready, false);
  chunked.fake.stderr.write(suffix);
  await expectReadinessFailure(chunked.lease, "endpoint-ambiguous");
  await settleNormally(chunked);

  const concatenated = launch();
  concatenated.fake.stderr.write(prefix + suffix);
  await expectReadinessFailure(concatenated.lease, "endpoint-ambiguous");
  await settleNormally(concatenated);

  const completePrefix = `${READINESS_TITLE}\n  listening on: ws://127.0.0.1:1111\n`;
  const completeSuffix = "  listening on: ws://127.0.0.1:2222\n";
  const completeChunked = launch();
  completeChunked.fake.stderr.write(completePrefix);
  await tick();
  assert.equal(completeChunked.lease.status().ready, false);
  completeChunked.fake.stderr.write(completeSuffix);
  await expectReadinessFailure(completeChunked.lease, "endpoint-ambiguous");
  await settleNormally(completeChunked);

  const noColonPrefix = `${READINESS_TITLE}\n  listening on ws://127.0.0.1:1111 `;
  const noColonSuffix = "ws://127.0.0.1:2222\n";
  const noColonChunked = launch();
  noColonChunked.fake.stderr.write(noColonPrefix);
  await tick();
  assert.equal(noColonChunked.lease.status().ready, false);
  noColonChunked.fake.stderr.write(noColonSuffix);
  await expectReadinessFailure(noColonChunked.lease, "endpoint-ambiguous");
  await settleNormally(noColonChunked);

  const noColonConcatenated = launch();
  noColonConcatenated.fake.stderr.write(noColonPrefix + noColonSuffix);
  await expectReadinessFailure(noColonConcatenated.lease, "endpoint-ambiguous");
  await settleNormally(noColonConcatenated);
});

test("rejects a recognized record whose health endpoints disagree with the listening port", async () => {
  const capture = launch();
  capture.fake.stderr.write([
    READINESS_TITLE,
    "  listening on: ws://127.0.0.1:1111",
    "  readyz: http://127.0.0.1:2222/readyz",
    "  healthz: http://127.0.0.1:2222/healthz",
    "  note: binds localhost only",
    "",
  ].join("\n"));
  await expectReadinessFailure(capture.lease, "banner-invalid");
  assert.equal(capture.terminateCalls(), 1);
  await settleNormally(capture);
});

test("ignores the provider's post-banner listening log after the complete record", async () => {
  const capture = launch();
  capture.fake.stderr.write(
    `${READY_BANNER}2026-01-01T00:00:00Z INFO app-server websocket listening on ws://127.0.0.1:54321\n`,
  );
  const ready = await bounded(capture.lease.readiness);
  assert.equal(ready.endpoint, "ws://127.0.0.1:54321");
  await settleNormally(capture);
});

test("rejects a duplicate recognized record in the same chunk", async () => {
  const capture = launch();
  capture.fake.stderr.write(READY_BANNER + READY_BANNER);
  await expectReadinessFailure(capture.lease, "banner-invalid");
  assert.equal(capture.terminateCalls(), 1);
  await settleNormally(capture);
});

test("rejects arbitrary URL mentions and readiness without the recognized title", async () => {
  const mention = launch();
  mention.fake.stderr.write("some log mention ws://127.0.0.1:54321\n");
  await expectReadinessFailure(mention.lease, "banner-invalid");
  await settleNormally(mention);

  const missingTitle = launch();
  missingTitle.fake.stderr.write("  listening on: ws://127.0.0.1:54321\n");
  await expectReadinessFailure(missingTitle.lease, "banner-invalid");
  await settleNormally(missingTitle);
});

test("retains an incomplete ANSI escape instead of changing the published port", async () => {
  const capture = launch();
  capture.fake.stderr.write(`${READINESS_TITLE}\n  listening on: ws://127.0.0.1:4321\x1b[0;`);
  await tick();
  assert.equal(capture.lease.status().ready, false);
  capture.fake.stderr.write(
    "32m\n  readyz: http://127.0.0.1:4321/readyz\n  healthz: http://127.0.0.1:4321/healthz\n  note: binds localhost only\n",
  );
  const ready = await bounded(capture.lease.readiness);
  assert.equal(ready.endpoint, "ws://127.0.0.1:4321");
  await settleNormally(capture);
});

test("an incomplete ANSI escape at reader end fails closed", async () => {
  const capture = launch();
  capture.fake.stderr.write(`${READINESS_TITLE}\n  listening on: ws://127.0.0.1:4321\x1b[0;`);
  await finishReader(capture.fake.stderr);
  await expectReadinessFailure(capture.lease, "banner-invalid");
  assert.equal(capture.terminateCalls(), 1);
  await settleNormally(capture);
});

test("startup deadline fails readiness, stops the exact child, and late banner cannot reactivate", async () => {
  const capture = launch({ startupTimeoutMs: 15 });
  await expectReadinessFailure(capture.lease, "startup-timeout");
  assert.equal(capture.terminateCalls(), 1);
  assert.strictEqual(capture.terminatedChildren()[0], capture.fake as unknown as ChildProcess);
  capture.fake.stderr.write(READY_BANNER);
  await tick();
  assert.equal(capture.lease.status().ready, false);
  assert.equal(capture.lease.status().readinessFailure, "startup-timeout");
  await settleNormally(capture);
  assert.equal(capture.terminateCalls(), 1);
});

test("abort fails readiness and requests one exact owned stop; late banner cannot reactivate", async () => {
  const controller = new AbortController();
  const capture = launch({ signal: controller.signal });
  controller.abort();
  await expectReadinessFailure(capture.lease, "aborted");
  assert.equal(capture.terminateCalls(), 1);
  capture.fake.stderr.write(READY_BANNER);
  await tick();
  assert.equal(capture.lease.status().ready, false);
  await settleNormally(capture);
});

test("a pre-aborted launch never spawns and settles as proven abandonment", async () => {
  const controller = new AbortController();
  controller.abort();
  const capture = launch({ signal: controller.signal });
  assert.equal(capture.spawnCalls(), 0);
  await expectReadinessFailure(capture.lease, "aborted");
  assert.equal(capture.terminateCalls(), 0);
  assert.deepEqual(await bounded(capture.lease.settlement), {
    status: "settled",
    child: "not-created",
  });
  const status = capture.lease.status();
  assert.equal(status.settled, true);
  assert.equal(status.childWitnessed, false);
  assert.equal(status.phase, "settled");
});

test("a spawn throw rejects readiness but settles proven abandonment", async () => {
  const capture = launch({
    spawn: () => {
      throw new Error("synthetic spawn failure");
    },
  });
  assert.equal(capture.spawnCalls(), 1);
  await expectReadinessFailure(capture.lease, "spawn-failed");
  assert.equal(capture.terminateCalls(), 0);
  assert.deepEqual(await bounded(capture.lease.settlement), {
    status: "settled",
    child: "not-created",
  });
  assert.equal(capture.lease.status().settled, true);
});

test("a nonexistent executable settles as a proven pre-spawn failure without termination", async () => {
  const child = spawnChildProcess(
    `pi-review-gate-missing-codex-backend-${randomUUID()}`,
    [],
    { stdio: ["ignore", "pipe", "pipe"], shell: false, env: process.env },
  );
  let terminateCalls = 0;
  const lease = launchOwnedCodexBackend({
    identity: { leaseId: "lease-missing-executable", generation: 2 },
    baseEnv: { PATH: "/nonexistent" },
    spawnBackend: () => child,
    terminateOwnedBackend: () => {
      terminateCalls += 1;
    },
    startupTimeoutMs: 2_000,
  });

  await expectReadinessFailure(lease, "spawn-failed");
  const settlement = await bounded(lease.settlement);
  assert.deepEqual(settlement, { status: "settled", child: "not-created" });
  const status = lease.status();
  assert.equal(status.childWitnessed, true);
  assert.equal(status.spawnObserved, false);
  assert.equal(status.spawnFailureObserved, true);
  assert.equal(status.exitObserved, false);
  assert.equal(status.stopRequested, false);
  assert.equal(status.terminationAttempted, false);
  assert.equal(status.terminationFailed, false);
  assert.equal(status.childErrorObserved, true);
  assert.equal(status.settled, true);
  assert.equal(status.phase, "settled");
  assert.equal(terminateCalls, 0);
});

test("a proven pre-spawn failure settles abandonment after captured readers close", async () => {
  const preSpawnFailure = new FakeChild();
  const capture = launch({ spawn: () => preSpawnFailure as unknown as ChildProcess });
  preSpawnFailure.emit("error", new Error("synthetic pre-spawn failure"));
  await expectReadinessFailure(capture.lease, "spawn-failed");
  preSpawnFailure.stdout.destroy();
  preSpawnFailure.stderr.destroy();
  await tick();

  const settlement = await bounded(capture.lease.settlement);
  assert.deepEqual(settlement, { status: "settled", child: "not-created" });
  const status = capture.lease.status();
  assert.equal(status.spawnObserved, false);
  assert.equal(status.spawnFailureObserved, true);
  assert.equal(status.exitObserved, false);
  assert.equal(status.stdoutEnded, false);
  assert.equal(status.stderrEnded, false);
  assert.equal(status.settled, true);
  assert.equal(capture.terminateCalls(), 0);
});

test("an error before spawn after a stop attempt is not treated as never-created", async () => {
  const child = new FakeChild();
  const spawnChild = child as unknown as ChildProcess;
  let terminateCalls = 0;
  const lease = launchOwnedCodexBackend({
    identity: { leaseId: "lease-stop-before-spawn-error", generation: 3 },
    baseEnv: { PATH: "/usr/bin" },
    spawnBackend: () => spawnChild,
    terminateOwnedBackend: () => {
      terminateCalls += 1;
    },
    startupTimeoutMs: 1_000,
  });
  lease.requestStop();
  assert.equal(terminateCalls, 1);
  child.emit("error", new Error("synthetic error after stop attempt"));
  await tick();
  const status = lease.status();
  assert.equal(status.spawnFailureObserved, false);
  assert.equal(status.childErrorObserved, true);
  await expectPending(lease.settlement);

  child.emitExit(0);
  await finishReader(child.stdout);
  await finishReader(child.stderr);
  const settlement = await bounded(lease.settlement);
  assert.equal(settlement.child, "exited");
  assert.equal(terminateCalls, 1);
});

test("a foreign spawn result is never adopted and cannot be called settled", async () => {
  const capture = launch({ spawn: () => ({}) as ChildProcess });
  await expectReadinessFailure(capture.lease, "spawn-invalid");
  assert.equal(capture.terminateCalls(), 0);
  await expectPending(capture.lease.settlement);
  const status = capture.lease.status();
  assert.equal(status.childWitnessed, false);
  assert.equal(status.settled, false);
});

test("a captured child without both stdio readers fails closed without settling", async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: null, stderr: null, pid: 77 });
  const capture = launch({ spawn: () => child });
  await expectReadinessFailure(capture.lease, "stream-unavailable");
  assert.equal(capture.terminateCalls(), 1);
  assert.strictEqual(capture.terminatedChildren()[0], child);
  await expectPending(capture.lease.settlement);
  const status = capture.lease.status();
  assert.equal(status.childWitnessed, true);
  assert.equal(status.exitObserved, false);
  assert.equal(status.settled, false);
});

test("a reader closed without natural end fails readiness and never proves settlement", async () => {
  const capture = launch();
  capture.fake.stdout.destroy();
  await expectReadinessFailure(capture.lease, "reader-closed");
  assert.equal(capture.terminateCalls(), 1);
  capture.fake.emitExit(0);
  await finishReader(capture.fake.stderr);
  await expectPending(capture.lease.settlement);
  const status = capture.lease.status();
  assert.equal(status.exitObserved, true);
  assert.equal(status.stdoutEnded, false);
  assert.equal(status.settled, false);
  assert.equal(capture.terminateCalls(), 1);
});

test("a child close event never fabricates a genuine exit", async () => {
  const capture = launch();
  await readyConnection(capture);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  capture.fake.emit("close", 0, null);
  await tick();
  assert.equal(capture.lease.status().exitObserved, false);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(0);
  const settlement = await bounded(capture.lease.settlement);
  assert.equal(settlement.status, "settled");
  assert.equal(settlement.child, "exited");
});

test("genuine exit before final reader drain does not settle until both readers end", async () => {
  const capture = launch();
  await readyConnection(capture);
  capture.fake.emitExit(0);
  assert.equal(capture.lease.status().exitObserved, true);
  assert.equal(capture.lease.status().phase, "exited");
  await expectPending(capture.lease.settlement);
  await finishReader(capture.fake.stdout);
  await expectPending(capture.lease.settlement);
  await finishReader(capture.fake.stderr);
  const settlement = await bounded(capture.lease.settlement);
  assert.deepEqual(settlement, {
    status: "settled",
    child: "exited",
    code: 0,
    signal: null,
    stdout: "ended",
    stderr: "ended",
  });
  assert.equal(capture.terminateCalls(), 0);
});

test("readers ending before the child exit settle immediately on the genuine exit", async () => {
  const capture = launch();
  await readyConnection(capture);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  assert.equal(capture.lease.status().stdoutEnded, true);
  assert.equal(capture.lease.status().stderrEnded, true);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(0);
  const settlement = await bounded(capture.lease.settlement);
  assert.equal(settlement.child, "exited");
});

test("an exit event with an undefined status is not settlement by itself", async () => {
  const capture = launch();
  await readyConnection(capture);
  capture.fake.emit("exit", undefined, null);
  assert.equal(capture.lease.status().exitObserved, true);
  await expectPending(capture.lease.settlement);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  const settlement = await bounded(capture.lease.settlement);
  assert.equal(settlement.child, "exited");
  if (settlement.child === "exited") assert.equal(settlement.code, null);
});

test("a post-spawn child error is not abandonment and still requires genuine settlement", async () => {
  const capture = launch();
  await readyConnection(capture);
  capture.fake.emit("error", new Error("synthetic child error"));
  await tick();
  const status = capture.lease.status();
  assert.equal(status.spawnObserved, true);
  assert.equal(status.spawnFailureObserved, false);
  assert.equal(status.childErrorObserved, true);
  assert.equal(status.stopRequested, true);
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(1);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  const settlement = await bounded(capture.lease.settlement);
  assert.deepEqual(settlement, {
    status: "settled",
    child: "exited",
    code: 1,
    signal: null,
    stdout: "ended",
    stderr: "ended",
  });
});

test("a child error before readiness fails readiness but cannot be reported as abandoned", async () => {
  const capture = launch();
  capture.fake.emit("error", new Error("synthetic early error"));
  await expectReadinessFailure(capture.lease, "child-error");
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(0);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  const settlement = await bounded(capture.lease.settlement);
  assert.equal(settlement.child, "exited");
});

test("a captured reader error fails readiness and never fabricates settlement", async () => {
  const capture = launch();
  capture.fake.stdout.emit("error", new Error("synthetic reader error"));
  await expectReadinessFailure(capture.lease, "reader-error");
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  assert.equal(capture.lease.status().readerErrorObserved, true);
  await settleNormally(capture);
});

test("premature reader destruction after readiness never counts as settlement", async () => {
  const capture = launch();
  await readyConnection(capture);
  capture.fake.stdout.destroy();
  await tick();
  assert.equal(capture.terminateCalls(), 1);
  assert.equal(capture.lease.status().stdoutEnded, false);
  capture.fake.emitExit(0);
  await finishReader(capture.fake.stderr);
  await expectPending(capture.lease.settlement);
  assert.equal(capture.lease.status().settled, false);
});

test("removing reader listeners does not itself count as reader completion", async () => {
  const capture = launch();
  await readyConnection(capture);
  capture.fake.stdout.removeAllListeners();
  capture.fake.stdout.end();
  await tick();
  capture.fake.emitExit(0);
  await finishReader(capture.fake.stderr);
  await expectPending(capture.lease.settlement);
  assert.equal(capture.lease.status().stdoutEnded, false);
});

test("a termination seam failure stays observable and never proves settlement", async () => {
  const capture = launch({
    terminate: () => {
      throw new Error("synthetic stop failure");
    },
  });
  await readyConnection(capture);
  assert.doesNotThrow(() => capture.lease.requestStop());
  const status = capture.lease.status();
  assert.equal(status.terminationAttempted, true);
  assert.equal(status.terminationFailed, true);
  assert.equal(status.settled, false);
  assert.equal(status.phase, "stopping");
  assert.equal(capture.terminateCalls(), 1);
  assert.doesNotThrow(() => capture.lease.requestStop());
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(0);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  await bounded(capture.lease.settlement);
  assert.equal(capture.terminateCalls(), 1);
  assert.equal(capture.fake.killCalls, 0);
});

test("an async termination rejection is recorded without becoming settlement", async () => {
  const capture = launch({ terminate: () => Promise.reject(new Error("async stop failure")) });
  await readyConnection(capture);
  capture.lease.requestStop();
  await tick();
  assert.equal(capture.lease.status().terminationFailed, true);
  assert.equal(capture.lease.status().settled, false);
  await expectPending(capture.lease.settlement);
  capture.fake.emitExit(0);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  await bounded(capture.lease.settlement);
});

test("requestStop is idempotent and never signals after a confirmed exit", async () => {
  const capture = launch();
  await readyConnection(capture);
  capture.lease.requestStop();
  capture.lease.requestStop();
  assert.equal(capture.terminateCalls(), 1);
  assert.strictEqual(capture.terminatedChildren()[0], capture.fake as unknown as ChildProcess);
  assert.equal(capture.fake.killCalls, 0);
  capture.fake.emitExit(0);
  capture.lease.requestStop();
  assert.equal(capture.terminateCalls(), 1);
  await finishReader(capture.fake.stdout);
  await finishReader(capture.fake.stderr);
  await bounded(capture.lease.settlement);
  assert.equal(capture.terminateCalls(), 1);
});

test("requestStop before readiness fails readiness but leaves settlement pending until proof", async () => {
  const capture = launch();
  capture.lease.requestStop();
  await expectReadinessFailure(capture.lease, "stopped");
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  const status = capture.lease.status();
  assert.equal(status.ready, false);
  assert.equal(status.stopRequested, true);
  assert.equal(status.settled, false);
  await settleNormally(capture);
});

test("a lease with rejected readiness and unconfirmed stop remains observable", async () => {
  const capture = launch();
  capture.fake.stderr.write(readinessBanner("ws://127.0.0.1:0"));
  await expectReadinessFailure(capture.lease, "endpoint-invalid");
  const before = capture.lease.status();
  assert.equal(before.settled, false);
  assert.equal(before.childWitnessed, true);
  capture.lease.requestStop();
  capture.lease.requestStop();
  assert.equal(capture.terminateCalls(), 1);
  await expectPending(capture.lease.settlement);
  const after = capture.lease.status();
  assert.equal(after.readinessFailure, "endpoint-invalid");
  assert.equal(after.stopRequested, true);
  assert.equal(after.settled, false);
  assert.equal(capture.lease.identity.leaseId, "lease-test");
  await settleNormally(capture);
});

test("exposes a positive bounded default startup deadline", () => {
  assert.ok(Number.isSafeInteger(NATIVE_CODEX_BACKEND_DEFAULT_STARTUP_TIMEOUT_MS));
  assert.ok(NATIVE_CODEX_BACKEND_DEFAULT_STARTUP_TIMEOUT_MS > 0);
});
