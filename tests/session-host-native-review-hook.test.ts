/**
 * #736 slice 2: focused tests for the BLOCKING native review lane.
 *
 * These exercise real local sockets against the production broker plus the
 * exported relay runner (and one genuine compiled child entrypoint). They cover
 * the closed wire family, authenticated held request/response, abort-on-close,
 * release and disposal invalidation, per-source and broker-wide bounds, refusal
 * of wrong/stale/cross-family tokens from every other family, contained handler
 * failure, frame overflow, and the relay's exact provider stdout on success and
 * on every failure. No provider CLI, model, configuration, or permission state
 * is used or changed.
 *
 * Platform coverage, stated honestly:
 *   - Linux/macOS runners execute everything here over a real Unix socket.
 *   - The Windows-specific assertions that are platform-independent (the local
 *     named-pipe address is the one accepted bootstrap address shape, and the
 *     relay dials exactly that address with no POSIX-only assumption) run on
 *     every platform.
 *   - The real Windows named-pipe legs are gated `win32` exactly like the
 *     existing broker and MCP Windows tests: a non-Windows skip is never Windows
 *     evidence.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import test, { afterEach } from "node:test";

import {
  __test as brokerTest,
  MAX_PRE_AUTH_FRAME_BYTES,
  createStatusBroker,
  type NativeHookRegistration,
  type NativeHookSourceHandlers,
  type NativeMcpRegistration,
  type NativeReviewRegistration,
  type NativeReviewSourceHandlers,
  type NativeReviewStatusBroker,
  type StatusBrokerStatusHandlers,
} from "../src/session-host/broker";
import {
  MAX_NATIVE_REVIEW_CWD_BYTES,
  MAX_NATIVE_REVIEW_ID_BYTES,
  MAX_NATIVE_REVIEW_MESSAGE_BYTES,
  MAX_NATIVE_REVIEW_PROMPT_BYTES,
  MAX_NATIVE_REVIEW_REASON_BYTES,
  MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES,
  MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES,
  MAX_NATIVE_REVIEW_STDIN_BYTES,
  MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES,
  NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV,
  NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS,
  decodeNativeReviewRequestFrame,
  decodeNativeReviewServerFrame,
  encodeNativeReviewBootstrapEnv,
  encodeNativeReviewRequestFrame,
  encodeNativeReviewServerFrame,
  isValidNativeReviewInstanceId,
  isNativeReviewLocalPipeAddress,
  parseNativeReviewBootstrap,
  parseNativeReviewBootstrapEnv,
  parseNativeReviewVerdict,
  sanitizeNativeReviewProviderInput,
  type NativeReviewBootstrap,
  type NativeReviewRequest,
  type NativeReviewRequestFrame,
  type NativeReviewVerdict,
} from "../src/session-host/native-review-hook-protocol";
import {
  NATIVE_REVIEW_HOOK_PARENT_POLL_MS,
  NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS,
  nativeReviewUnavailableMessage,
  runNativeReviewHookRelay,
  type NativeReviewHookRelayOptions,
} from "../src/session-host/native-review-hook-relay";
import { NATIVE_REVIEW_DEADLINE_MS } from "../src/session-host/native-review-coordinator";
import {
  encodeNativeHookFrame,
  type NativeHookEvent,
  type NativeHookFailure,
} from "../src/session-host/native-hook-protocol";
import { encodeNativeMcpHello } from "../src/session-host/native-mcp-protocol";
import type { NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import {
  MAX_STATUS_FRAME_BYTES,
} from "../src/session-host/protocol";

const WINDOWS_PIPE_ADDRESS = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;
const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\prg-st-0123456789abcdef0123456789abcdef";
const WINDOWS_PIPE_BOOTSTRAP: NativeReviewBootstrap = {
  version: 1,
  socketPath: WINDOWS_PIPE_PATH,
  generation: "77777777-7777-4777-8777-777777777777",
  instanceId: "99999999-9999-4999-8999-999999999999",
  backend: "claude",
  token: "d".repeat(64),
};

const INSTANCE_REVIEW = "44444444-4444-4444-8444-444444444444";
const INSTANCE_REVIEW_OTHER = "66666666-6666-4666-8666-666666666666";
const INSTANCE_PI = "11111111-1111-4111-8111-111111111111";
const INSTANCE_HOOK = "22222222-2222-4222-8222-222222222222";
const INSTANCE_MCP = "33333333-3333-4333-8333-333333333333";
const INSTANCE_SHARED = "55555555-5555-4555-8555-555555555555";

// The worker root is longer than macOS's sun_path. Keep every real socket inode
// under this root and express only the bind/connect address relatively. A real
// Windows named-pipe address is already short and is never rewritten.
function rootRelativeSocketAddress(address: string): string {
  if (WINDOWS_PIPE_ADDRESS.test(address)) return address;
  const relative = path.relative(process.cwd(), address);
  if (path.isAbsolute(address) && relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && Buffer.byteLength(address, "utf8") > 100) return `./${relative}`;
  return address;
}

function rootRelativeSocketArgument(value: unknown): unknown {
  if (typeof value === "string") return rootRelativeSocketAddress(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const options = value as Record<string, unknown>;
    if (typeof options.path === "string") return { ...options, path: rootRelativeSocketAddress(options.path) };
  }
  return value;
}

function rootRelativeSocketConnectArgument(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 0) {
    value[0] = rootRelativeSocketArgument(value[0]);
    return value;
  }
  if (typeof value === "string") return { path: rootRelativeSocketAddress(value) };
  return rootRelativeSocketArgument(value);
}

const originalServerListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
  args[0] = rootRelativeSocketArgument(args[0]);
  return Reflect.apply(originalServerListen, this, args) as net.Server;
} as typeof net.Server.prototype.listen;

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  args[0] = rootRelativeSocketConnectArgument(args[0]);
  return Reflect.apply(originalSocketConnect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

const brokers = new Set<NativeReviewStatusBroker>();
const socketRoots = new Set<string>();
const sockets = new Set<net.Socket>();
const children = new Set<ReturnType<typeof spawn>>();

function trackSocket(socket: net.Socket): net.Socket {
  sockets.add(socket);
  // The explicit wait helpers classify expected remote closes; this listener
  // only prevents an unhandled error from an intentionally rejected probe.
  socket.on("error", () => undefined);
  return socket;
}

function makeSocketRoot(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".prg-rv-"));
  socketRoots.add(root);
  return root;
}

async function makeBroker(): Promise<NativeReviewStatusBroker> {
  brokerTest.setSocketPathLimitForTests(4096);
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  // `createStatusBroker()` is typed with the widest family set the real broker
  // implements, so registering a review source needs no cast here.
  brokers.add(broker);
  return broker;
}

afterEach(async () => {
  brokerTest.setNativeReviewInFlightLimitForTests(undefined);
  brokerTest.setNativeMcpInFlightLimitForTests(undefined);
  brokerTest.setNativeHookDeliveryLimitForTests(undefined);
  brokerTest.setSocketPathLimitForTests(undefined);
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Cleanup never masks an assertion.
    }
  }
  children.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const broker of brokers) {
    try {
      await broker.dispose();
    } catch {
      // Cleanup never masks a test assertion; the broker is idempotent.
    }
  }
  brokers.clear();
  for (const root of socketRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup only.
    }
  }
  socketRoots.clear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedReview {
  readonly requests: NativeReviewRequest[];
  readonly signals: AbortSignal[];
  handlers: NativeReviewSourceHandlers;
  hold: boolean;
  respond: (request: NativeReviewRequest, index: number) => Promise<NativeReviewVerdict | undefined>;
  aborts: number;
}

function recordingReview(): RecordedReview {
  const recorded = {
    requests: [] as NativeReviewRequest[],
    signals: [] as AbortSignal[],
    handlers: { onReviewRequest: () => Promise.resolve({ action: "allow" as const }) },
    hold: false,
    respond: async () => ({ action: "allow" as const }),
    aborts: 0,
  } as unknown as RecordedReview;
  recorded.handlers.onReviewRequest = (request, signal) => {
    const index = recorded.requests.length;
    recorded.requests.push(request);
    recorded.signals.push(signal);
    signal.addEventListener("abort", () => { recorded.aborts += 1; });
    if (recorded.hold) return new Promise<NativeReviewVerdict>(() => undefined);
    return recorded.respond(request, index) as Promise<NativeReviewVerdict>;
  };
  return recorded;
}

function piHandlers(): StatusBrokerStatusHandlers {
  return { onStatus: () => undefined, onDisconnect: () => undefined };
}

function recordingHook(): {
  readonly events: NativeHookEvent[];
  readonly failures: NativeHookFailure[];
  readonly handlers: NativeHookSourceHandlers;
} {
  const recorded: {
    events: NativeHookEvent[];
    failures: NativeHookFailure[];
    handlers: NativeHookSourceHandlers;
  } = {
    events: [],
    failures: [],
    handlers: { onEvent: () => undefined, onFailure: () => undefined },
  };
  recorded.handlers.onEvent = (event) => { recorded.events.push(event); };
  return recorded;
}

const MCP_ENDPOINT: NativeMcpToolEndpoint = {
  async listTools() { return []; },
  async callTool() { return undefined; },
};

async function connect(address: string, allowHalfOpen = false): Promise<net.Socket> {
  const socket = trackSocket(net.connect({ path: address, allowHalfOpen }));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("test helper: socket connection timed out")), 3000);
    timer.unref?.();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("test helper: socket closed before connecting"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  return socket;
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`test helper: ${label} exceeded its deadline`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForClose(socket: net.Socket, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed || socket.readableEnded) {
      resolve();
      return;
    }
    const timer = setTimeout(() => finish(new Error(`test helper: ${label} did not close`)), timeoutMs);
    timer.unref?.();
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("end", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = (): void => finish();
    socket.once("close", onClose);
    socket.once("end", onClose);
  });
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reviewRequestFrame(
  bootstrap: NativeReviewBootstrap,
  selection: Partial<Omit<NativeReviewRequestFrame, "version" | "type" | "instanceId" | "generation" | "backend" | "token" | "event" | "sessionId">> & {
    event?: NativeReviewRequestFrame["event"];
    sessionId?: string;
  } = {},
  overrides: Partial<Pick<NativeReviewRequestFrame, "instanceId" | "generation" | "backend" | "token">> = {},
): NativeReviewRequestFrame {
  return {
    version: 1,
    type: "native_review_request",
    instanceId: overrides.instanceId ?? bootstrap.instanceId,
    generation: overrides.generation ?? bootstrap.generation,
    backend: overrides.backend ?? bootstrap.backend,
    token: overrides.token ?? bootstrap.token,
    event: selection.event ?? "Stop",
    sessionId: selection.sessionId ?? "session-root",
    ...(selection.turnId === undefined ? {} : { turnId: selection.turnId }),
    ...(selection.stopHookActive === undefined ? {} : { stopHookActive: selection.stopHookActive }),
    ...(selection.backgroundTasks === undefined ? {} : { backgroundTasks: selection.backgroundTasks }),
    ...(selection.cwd === undefined ? {} : { cwd: selection.cwd }),
    ...(selection.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: selection.lastAssistantMessage }),
    ...(selection.prompt === undefined ? {} : { prompt: selection.prompt }),
  };
}

interface RawAnswer {
  /** The one answer frame this family's strict decoder accepted, if any. */
  readonly frame: unknown;
  /** Raw bytes seen before the socket closed, for the "nothing echoed" checks. */
  readonly raw: string;
}

/** Sends one raw request line and reads at most one answer line. */
async function sendRaw(
  socketPath: string,
  line: string | Buffer,
  options: { readonly closeAfterWrite?: boolean } = {},
): Promise<RawAnswer> {
  const socket = await connect(socketPath);
  return new Promise<RawAnswer>((resolve) => {
    let settled = false;
    let raw = "";
    const timer = setTimeout(() => finish(), 1500);
    timer.unref?.();
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.destroy();
      let frame: unknown;
      const newline = raw.indexOf("\n");
      if (newline !== -1) {
        try {
          frame = JSON.parse(raw.slice(0, newline));
        } catch {
          frame = undefined;
        }
      }
      resolve({ frame, raw });
    };
    const onData = (chunk: Buffer): void => {
      raw += chunk.toString("utf8");
      if (raw.includes("\n")) finish();
    };
    const onClose = (): void => finish();
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.write(line);
    if (options.closeAfterWrite === true) socket.end();
  });
}

/** Holds `count` authenticated review requests open from this client side. */
async function holdReviews(
  broker: NativeReviewStatusBroker,
  bootstrap: NativeReviewBootstrap,
  count: number,
): Promise<net.Socket[]> {
  const holders: net.Socket[] = [];
  const baseline = reviewLaneCounts(broker).inFlight;
  for (let index = 0; index < count; index += 1) {
    const holder = await connect(broker.socketPath);
    holder.resume();
    holder.write(encodeNativeReviewRequestFrame(reviewRequestFrame(bootstrap, { sessionId: `held-${index}` })));
    holders.push(holder);
  }
  await waitFor(
    () => reviewLaneCounts(broker).inFlight >= baseline + count,
    "held native review slots saturated",
  );
  return holders;
}

function reviewLaneCounts(broker: NativeReviewStatusBroker): {
  inFlight: number;
  heldConnections: number;
  sources: number;
} {
  return (broker as unknown as {
    __nativeReviewLaneCountsForTests(): { inFlight: number; heldConnections: number; sources: number };
  }).__nativeReviewLaneCountsForTests();
}

function relayStdin(value: unknown, trailing = ""): Readable {
  return Readable.from([Buffer.from(`${JSON.stringify(value)}${trailing}`, "utf8")]);
}

function relayStdinBytes(bytes: Buffer): Readable {
  return Readable.from([bytes]);
}

class CapturingStdout {
  text = "";
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

/** Runs the exported relay runner against the real broker with a captured stdout. */
async function runRelay(
  bootstrap: NativeReviewBootstrap,
  event: string,
  stdin: NodeJS.ReadableStream,
): Promise<{ outcome: Awaited<ReturnType<typeof runNativeReviewHookRelay>>; stdout: CapturingStdout }> {
  const stdout = new CapturingStdout();
  const outcome = await runNativeReviewHookRelay({
    env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin,
    stdout: stdout as unknown as NodeJS.WritableStream,
    event,
  });
  return { outcome, stdout };
}

const STOP_INPUT = {
  hook_event_name: "Stop",
  session_id: "session-root",
  turn_id: "turn-7",
  stop_hook_active: false,
  last_assistant_message: "I finished the change.\nIt touches two files.",
  cwd: "/workspace/project",
  background_tasks: [{ id: "b8k3n1p4q", type: "shell", status: "running", description: "SECRET DESCRIPTION" }],
  // Everything below is never selected, never framed, and never printed.
  prompt: "SECRET PROMPT",
  transcript_path: "/secret/transcript.jsonl",
  permission_mode: "bypassPermissions",
  tool_input: { command: "SECRET COMMAND" },
  tool_response: { stdout: "SECRET RESULT" },
};

// ---------------------------------------------------------------------------
// Closed wire family
// ---------------------------------------------------------------------------

test("the review bootstrap is closed, family-distinct, and accepts this broker's Windows pipe address", () => {
  const bootstrap: NativeReviewBootstrap = {
    version: 1,
    socketPath: "/tmp/prg-st-x/s.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_REVIEW,
    backend: "claude",
    token: "a".repeat(64),
  };
  assert.deepEqual(parseNativeReviewBootstrap(bootstrap), bootstrap);
  assert.deepEqual(parseNativeReviewBootstrapEnv(encodeNativeReviewBootstrapEnv(bootstrap)), bootstrap);
  assert.equal(isValidNativeReviewInstanceId(bootstrap.instanceId), true);

  // The one canonical Windows local named-pipe shape is a first-class address.
  assert.equal(isNativeReviewLocalPipeAddress(WINDOWS_PIPE_BOOTSTRAP.socketPath), true);
  assert.deepEqual(parseNativeReviewBootstrap(WINDOWS_PIPE_BOOTSTRAP), WINDOWS_PIPE_BOOTSTRAP);
  assert.match(WINDOWS_PIPE_BOOTSTRAP.socketPath, WINDOWS_PIPE_ADDRESS);

  const variants: unknown[] = [
    { ...bootstrap, token: "short" },
    { ...bootstrap, token: "A".repeat(63) },
    { ...bootstrap, backend: "pi" },
    { ...bootstrap, extra: true },
    { ...bootstrap, type: "native_review_bootstrap" },
    { ...bootstrap, socketPath: "relative/s.sock" },
    { ...bootstrap, socketPath: "/tmp/../etc/s.sock" },
    { ...bootstrap, socketPath: "/tmp//s.sock" },
    { ...bootstrap, socketPath: `${WINDOWS_PIPE_PATH}x` },
    // A remote pipe is never this broker's endpoint.
    { ...bootstrap, socketPath: "\\\\other-host\\pipe\\prg-st-0123456789abcdef0123456789abcdef" },
    { ...bootstrap, instanceId: "not-an-id" },
    { ...bootstrap, instanceId: "" },
    { ...bootstrap, version: 2 },
  ];
  for (const variant of variants) assert.equal(parseNativeReviewBootstrap(variant), undefined, JSON.stringify(variant));
  assert.equal(parseNativeReviewBootstrapEnv("{not-json"), undefined);
  assert.equal(parseNativeReviewBootstrapEnv("x".repeat(4097)), undefined);

  // An MCP bootstrap carries a `type` discriminator, so it never parses here.
  const mcpShaped = { ...bootstrap, type: "native_mcp_bootstrap" };
  assert.equal(parseNativeReviewBootstrap(mcpShaped), undefined);
});

test("one request line is closed and bounded and carries only the reviewed answer", () => {
  const bootstrap = WINDOWS_PIPE_BOOTSTRAP;
  const frame = reviewRequestFrame(bootstrap, {
    turnId: "turn-1",
    stopHookActive: true,
    cwd: "/workspace/project",
    backgroundTasks: [{ id: "b8k3n1p4q", kind: "shell" }],
    lastAssistantMessage: "line one\nline two\twith a tab",
  });
  const decoded = decodeNativeReviewRequestFrame(encodeNativeReviewRequestFrame(frame));
  assert.ok(decoded);
  assert.deepEqual(decoded.frame, frame);
  // The callback value carries no token, generation, or routing id.
  assert.deepEqual(decoded.request, {
    backend: "claude",
    event: "Stop",
    sessionId: "session-root",
    turnId: "turn-1",
    stopHookActive: true,
    backgroundTasks: [{ id: "b8k3n1p4q", kind: "shell" }],
    cwd: "/workspace/project",
    lastAssistantMessage: "line one\nline two\twith a tab",
  });
  assert.equal(JSON.stringify(decoded.request).includes(bootstrap.token), false);

  const forbidden = [
    // A `prompt` is contract data ONLY on `UserPromptSubmit`; this frame is a
    // `Stop`, where the reviewed text is the assistant's answer, so the same
    // field name is refused outright rather than quietly dropped.
    { prompt: "SECRET PROMPT" },
    { transcript_path: "/secret/transcript.jsonl" },
    { tool_name: "Bash" },
    { tool_input: { command: "SECRET" } },
    { tool_response: { stdout: "SECRET" } },
    { hook_event_name: "Stop" },
    { background_tasks: [{ id: "b8k3n1p4q", type: "shell", status: "running" }] },
    // Only the reviewed assistant text is answer text: every other provider
    // field, and any follow-up-line protocol, is refused outright.
    { last_assistant_message: "snake case is not the selected field" },
    { hasBody: true },
    { body: "a body line is not part of this protocol" },
  ];
  for (const extra of forbidden) {
    assert.equal(
      decodeNativeReviewRequestFrame(`${JSON.stringify({ ...frame, ...extra })}\n`),
      undefined,
      JSON.stringify(extra),
    );
  }

  const malformed: unknown[] = [
    { ...frame, sessionId: "bad\u0001id" },
    { ...frame, sessionId: "x".repeat(MAX_NATIVE_REVIEW_ID_BYTES + 1) },
    { ...frame, sessionId: "" },
    { ...frame, turnId: "x".repeat(MAX_NATIVE_REVIEW_ID_BYTES + 1) },
    { ...frame, cwd: "relative/dir" },
    { ...frame, cwd: "/w".repeat(MAX_NATIVE_REVIEW_CWD_BYTES) },
    { ...frame, stopHookActive: "yes" },
    { ...frame, event: "PreToolUse" },
    { ...frame, event: "SessionEnd" },
    // Reviewed text is a string or absent — never a number, never an object.
    { ...frame, lastAssistantMessage: 42 },
    { ...frame, lastAssistantMessage: { text: "no" } },
    // Control characters are refused; ordinary newlines are NOT, because a
    // reviewed assistant answer is multi-line by nature and JSON escaping keeps
    // it inside one wire line either way.
    { ...frame, lastAssistantMessage: "null\u0000byte" },
    { ...frame, lastAssistantMessage: "esc\u0007ape" },
    // One byte past the message bound is refused even though the line could
    // still be encoded inside the frame bound.
    { ...frame, lastAssistantMessage: "x".repeat(MAX_NATIVE_REVIEW_MESSAGE_BYTES + 1) },
    { ...frame, backgroundTasks: [{ id: "b8k3n1p4q", kind: "unknown" }] },
    { ...frame, backgroundTasks: [{ id: "b8k3n1p4q", kind: "shell", extra: 1 }] },
    { ...frame, backgroundTasks: [{ id: "b8k3n1p4q", kind: "shell" }, { id: "b8k3n1p4q", kind: "task" }] },
    // A well-formed but different token is valid FRAMING: this decoder never
    // authenticates. Wrong/stale/cross-family tokens are refused by the broker's
    // record lookup, which is covered by the live-lane tests.
    { ...frame, generation: "stale" },
  ];
  for (const variant of malformed) {
    assert.equal(decodeNativeReviewRequestFrame(`${JSON.stringify(variant)}\n`), undefined, JSON.stringify(variant));
  }

  // The membership contract is identical for either review backend: the relay
  // projects this field from the provider snapshot without consulting backend,
  // so a Codex request carrying it is valid framing — never an unavailable
  // review for an otherwise well-formed turn.
  const codexFrame = reviewRequestFrame({ ...WINDOWS_PIPE_BOOTSTRAP, backend: "codex" }, {
    backgroundTasks: [{ id: "b8k3n1p4q", kind: "task" }],
  });
  const codexDecoded = decodeNativeReviewRequestFrame(encodeNativeReviewRequestFrame(codexFrame));
  assert.ok(codexDecoded, "a Codex request carrying membership is valid framing");
  assert.equal(codexDecoded.request.backend, "codex");
  assert.deepEqual(codexDecoded.request.backgroundTasks, [{ id: "b8k3n1p4q", kind: "task" }]);

  // A request at EVERY bound at once — including a full 64 KiB reviewed answer —
  // encodes and decodes exactly, inside this family's own request bound.
  const maximal = reviewRequestFrame(bootstrap, {
    turnId: "t".repeat(MAX_NATIVE_REVIEW_ID_BYTES),
    cwd: `/${"w".repeat(MAX_NATIVE_REVIEW_CWD_BYTES - 1)}`,
    backgroundTasks: Array.from({ length: 64 }, (_unused, index) => ({
      id: `member-${index}`.padEnd(16, "x"),
      kind: index % 2 === 0 ? "shell" as const : "task" as const,
    })),
    lastAssistantMessage: "\u4e2d".repeat(Math.floor(MAX_NATIVE_REVIEW_MESSAGE_BYTES / 3)),
  });
  const encodedMaximal = encodeNativeReviewRequestFrame(maximal);
  assert.ok(Buffer.byteLength(encodedMaximal, "utf8") <= MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES);
  const maximalDecoded = decodeNativeReviewRequestFrame(encodedMaximal);
  assert.ok(maximalDecoded, "a maximal request still decodes exactly");
  assert.equal(maximalDecoded.request.lastAssistantMessage?.length, Math.floor(MAX_NATIVE_REVIEW_MESSAGE_BYTES / 3));
  // Overflow is refused at the bound, never truncated.
  assert.throws(() => encodeNativeReviewRequestFrame({
    ...maximal,
    cwd: `/workspace/${"x".repeat(MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES)}`,
  }), RangeError);
  // A maximal request is deliberately larger than the shared legacy bound: that
  // is why the broker widens line buffering for THIS family only.
  assert.ok(Buffer.byteLength(encodedMaximal, "utf8") > MAX_PRE_AUTH_FRAME_BYTES,
    "the maximal request must actually exceed the shared legacy bound for this test to mean anything");
});

test("a `UserPromptSubmit` request may carry the prompt and a `Stop` request never can", () => {
  const bootstrap = WINDOWS_PIPE_BOOTSTRAP;
  // The event that has nothing else to review against carries the prompt, with
  // the same multi-line message discipline as the reviewed answer text.
  const ups = reviewRequestFrame(bootstrap, {
    event: "UserPromptSubmit",
    prompt: "Add a retry to upload()\n\tand keep the existing tests",
    lastAssistantMessage: "",
  });
  const upsDecoded = decodeNativeReviewRequestFrame(encodeNativeReviewRequestFrame(ups));
  assert.ok(upsDecoded, "a UPS request carrying the prompt is valid framing");
  assert.deepEqual(upsDecoded.request, {
    backend: "claude",
    event: "UserPromptSubmit",
    sessionId: "session-root",
    prompt: "Add a retry to upload()\n\tand keep the existing tests",
    lastAssistantMessage: "",
  });
  // An EMPTY prompt is still a submitted prompt: it is admitted as "" so the
  // host sees "submitted nothing" rather than a malformed request.
  const emptyPrompt = decodeNativeReviewRequestFrame(encodeNativeReviewRequestFrame(
    reviewRequestFrame(bootstrap, { event: "UserPromptSubmit", prompt: "" }),
  ));
  assert.equal(emptyPrompt?.request.prompt, "");

  // The same field on a `Stop` request is refused outright: the Stop review
  // already carries the assistant's answer, and a relay that projected prompt
  // onto the wrong event must fail closed rather than half-pass.
  assert.equal(
    decodeNativeReviewRequestFrame(encodeNativeReviewRequestFrame(
      reviewRequestFrame(bootstrap, { event: "Stop", prompt: "SECRET PROMPT" }),
    )),
    undefined,
    "a Stop request must never carry prompt text",
  );

  const malformedPrompt: Record<string, unknown>[] = [
    { prompt: 42 },
    { prompt: { text: "no" } },
    { prompt: "null\u0000byte" },
    { prompt: "esc\u0007ape" },
    // One byte past the prompt bound is refused even though the line could
    // still be encoded inside the frame bound.
    { prompt: "x".repeat(MAX_NATIVE_REVIEW_PROMPT_BYTES + 1) },
  ];
  for (const extra of malformedPrompt) {
    assert.equal(
      decodeNativeReviewRequestFrame(`${JSON.stringify({ ...ups, ...extra })}\n`),
      undefined,
      JSON.stringify(extra),
    );
  }

  // A request at EVERY bound at once — a full 64 KiB reviewed answer AND a
  // full 64 KiB prompt — still encodes and decodes exactly, inside this
  // family's own request bound, which is derived from both.
  const maximalBoth = reviewRequestFrame(bootstrap, {
    event: "UserPromptSubmit",
    turnId: "t".repeat(MAX_NATIVE_REVIEW_ID_BYTES),
    cwd: `/${"w".repeat(MAX_NATIVE_REVIEW_CWD_BYTES - 1)}`,
    backgroundTasks: Array.from({ length: 64 }, (_unused, index) => ({
      id: `member-${index}`.padEnd(16, "x"),
      kind: index % 2 === 0 ? "shell" as const : "task" as const,
    })),
    lastAssistantMessage: "\u4e2d".repeat(Math.floor(MAX_NATIVE_REVIEW_MESSAGE_BYTES / 3)),
    prompt: "\u4e2d".repeat(Math.floor(MAX_NATIVE_REVIEW_PROMPT_BYTES / 3)),
  });
  const encodedBoth = encodeNativeReviewRequestFrame(maximalBoth);
  assert.ok(Buffer.byteLength(encodedBoth, "utf8") <= MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES,
    "a maximal prompt must still fit the request bound");
  const bothDecoded = decodeNativeReviewRequestFrame(encodedBoth);
  assert.ok(bothDecoded, "a maximal prompt still decodes exactly");
  assert.equal(bothDecoded.request.prompt?.length, Math.floor(MAX_NATIVE_REVIEW_PROMPT_BYTES / 3));
  assert.equal(bothDecoded.request.lastAssistantMessage?.length, Math.floor(MAX_NATIVE_REVIEW_MESSAGE_BYTES / 3));
});

test("verdict and error frames are closed, bounded, and strictly typed", () => {
  assert.deepEqual(parseNativeReviewVerdict({ action: "allow" }), { action: "allow" });
  // An EMPTY optional field is a complete answer, not a malformed one: only a
  // block REASON must be non-empty, and that rule is enforced separately.
  assert.deepEqual(parseNativeReviewVerdict({ action: "allow", reason: "" }), { action: "allow", reason: "" });
  assert.deepEqual(parseNativeReviewVerdict({ action: "allow", userMessage: "" }), {
    action: "allow", userMessage: "",
  });
  assert.deepEqual(parseNativeReviewVerdict({ action: "block", reason: "run the tests", userMessage: "" }), {
    action: "block", reason: "run the tests", userMessage: "",
  });
  assert.deepEqual(parseNativeReviewVerdict({ action: "block", reason: "run the tests" }), {
    action: "block", reason: "run the tests",
  });
  assert.deepEqual(parseNativeReviewVerdict({ action: "allow", userMessage: "reviewed" }), {
    action: "allow", userMessage: "reviewed",
  });
  for (const bad of [
    { action: "block" },
    { action: "block", reason: "" },
    { action: "retry" },
    {},
    null,
    { action: "allow", extra: true },
    { action: "block", reason: "x".repeat(MAX_NATIVE_REVIEW_REASON_BYTES + 1) },
    { action: "allow", userMessage: "x".repeat(MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES + 1) },
    { action: "allow", userMessage: "bad\u0001notice" },
  ]) assert.equal(parseNativeReviewVerdict(bad), undefined, JSON.stringify(bad));

  assert.deepEqual(
    decodeNativeReviewServerFrame(encodeNativeReviewServerFrame({ version: 1, type: "native_review_response", action: "allow" })),
    { version: 1, type: "native_review_response", action: "allow" },
  );
  assert.deepEqual(
    decodeNativeReviewServerFrame(encodeNativeReviewServerFrame({
      version: 1, type: "native_review_response", action: "block", reason: "fix #2", userMessage: "blocked",
    })),
    { version: 1, type: "native_review_response", action: "block", reason: "fix #2", userMessage: "blocked" },
  );
  for (const code of ["busy", "unavailable", "failed"] as const) {
    assert.deepEqual(
      decodeNativeReviewServerFrame(encodeNativeReviewServerFrame({ version: 1, type: "native_review_error", code })),
      { version: 1, type: "native_review_error", code },
    );
  }
  for (const bad of [
    '{"version":1,"type":"native_review_error","code":"retry"}\n',
    '{"version":1,"type":"native_review_response","action":"block"}\n',
    '{"version":1,"type":"native_review_response","action":"allow","accepted":true}\n',
    '{"version":1,"type":"native_hook_ack","accepted":true}\n',
    '{"version":1,"type":"native_mcp_ready"}\n',
    '{"version":1,"type":"hello"}\n',
    'not json\n',
  ]) assert.equal(decodeNativeReviewServerFrame(bad), undefined, bad);

  // An answer over the response bound is refused on both ends: the encoder
  // refuses to build it, and the relay's decoder refuses to read it.
  const huge = {
    version: 1 as const,
    type: "native_review_response" as const,
    action: "block" as const,
    reason: "x".repeat(MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES),
  };
  assert.throws(() => encodeNativeReviewServerFrame(huge), RangeError);
  assert.equal(decodeNativeReviewServerFrame(`${"x".repeat(MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES)}\n`), undefined);
});

test("provider stdin selection projects only the allowlist and nothing else", () => {
  const selected = sanitizeNativeReviewProviderInput(STOP_INPUT);
  assert.equal(selected.ok, true);
  if (!selected.ok) assert.fail("the real-shaped Stop input must be admitted");
  assert.deepEqual(selected.selection, {
    event: "Stop",
    sessionId: "session-root",
    turnId: "turn-7",
    stopHookActive: false,
    backgroundTasks: [{ id: "b8k3n1p4q", kind: "shell" }],
    lastAssistantMessage: "I finished the change.\nIt touches two files.",
    cwd: "/workspace/project",
  });
  const serialized = JSON.stringify(selected);
  for (const secret of ["SECRET PROMPT", "SECRET COMMAND", "SECRET RESULT", "SECRET DESCRIPTION", "/secret/transcript.jsonl"]) {
    assert.ok(!serialized.includes(secret), `${secret} must never be selected`);
  }

  // An unusable optional field is omitted; a malformed required one is fatal.
  const unusable = sanitizeNativeReviewProviderInput({ ...STOP_INPUT, cwd: "relative/dir" });
  assert.equal(unusable.ok && unusable.selection.cwd, undefined);
  assert.deepEqual(sanitizeNativeReviewProviderInput({ hook_event_name: "Stop" }), { ok: false, reason: "input-invalid" });
  assert.deepEqual(sanitizeNativeReviewProviderInput({ ...STOP_INPUT, hook_event_name: "PreToolUse" }),
    { ok: false, reason: "event-mismatch" });
  assert.deepEqual(sanitizeNativeReviewProviderInput({ ...STOP_INPUT, hook_event_name: "SubagentStop" }),
    { ok: false, reason: "event-mismatch" });
  assert.deepEqual(sanitizeNativeReviewProviderInput(null), { ok: false, reason: "input-invalid" });
  // The whole provider array is validated once, with the observer lane's rule:
  // an unkeyable active member makes the projection absent, never shortened.
  const unkeyable = sanitizeNativeReviewProviderInput({
    hook_event_name: "Stop", session_id: "s", background_tasks: [{ type: "shell", status: "running" }],
  });
  assert.equal(unkeyable.ok && unkeyable.selection.backgroundTasks, undefined);
  const empty = sanitizeNativeReviewProviderInput({ hook_event_name: "Stop", session_id: "s", background_tasks: [] });
  assert.deepEqual(empty.ok && empty.selection.backgroundTasks, []);
  // An empty reported assistant message is reviewable input, not a malformed
  // document: it is selected as "" and travels as an empty body line.
  const emptyMessage = sanitizeNativeReviewProviderInput({
    hook_event_name: "Stop", session_id: "s", last_assistant_message: "",
  });
  assert.equal(emptyMessage.ok && emptyMessage.selection.lastAssistantMessage, "");
});

test("provider stdin selection projects the prompt only for `UserPromptSubmit`", () => {
  const ups = sanitizeNativeReviewProviderInput({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-root",
    prompt: "Add a retry to upload()\nand keep the existing tests",
    // Everything below is still never selected on this event either.
    transcript_path: "/secret/transcript.jsonl",
    tool_input: { command: "SECRET COMMAND" },
  });
  assert.equal(ups.ok, true);
  if (!ups.ok) assert.fail("a shaped UserPromptSubmit input must be admitted");
  assert.deepEqual(ups.selection, {
    event: "UserPromptSubmit",
    sessionId: "session-root",
    prompt: "Add a retry to upload()\nand keep the existing tests",
  });

  // The same field on a `Stop` document is ignored exactly like an unknown
  // field, so prompt text has no path onto the wire from a Stop review.
  const stop = sanitizeNativeReviewProviderInput({ ...STOP_INPUT });
  assert.equal(stop.ok, true);
  if (stop.ok) assert.equal(Object.prototype.hasOwnProperty.call(stop.selection, "prompt"), false);

  // An empty submitted prompt is still a submitted prompt.
  const emptyPrompt = sanitizeNativeReviewProviderInput({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "" });
  assert.equal(emptyPrompt.ok && emptyPrompt.selection.prompt, "");

  // A malformed or over-cap prompt on the event that DOES carry it is a closed
  // failure, never a silent drop: a truncated request must not be reviewed as
  // though it were complete.
  for (const prompt of [42, { text: "no" }, "null\u0000byte", "x".repeat(MAX_NATIVE_REVIEW_PROMPT_BYTES + 1)]) {
    assert.deepEqual(
      sanitizeNativeReviewProviderInput({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt }),
      { ok: false, reason: "input-invalid" },
      JSON.stringify(prompt),
    );
  }
});

// ---------------------------------------------------------------------------
// Live broker lane
// ---------------------------------------------------------------------------

test("an authenticated request is held, answered exactly once, and the socket ends", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const answered = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap, { cwd: "/workspace/project" }),
  ));
  assert.deepEqual(answered.frame, { version: 1, type: "native_review_response", action: "allow" });
  assert.equal(recorded.requests.length, 1);
  assert.deepEqual(recorded.requests[0], {
    backend: "claude",
    event: "Stop",
    sessionId: "session-root",
    cwd: "/workspace/project",
  });
  assert.equal(reviewLaneCounts(broker).sources, 1);
  await waitFor(
    () => reviewLaneCounts(broker).inFlight === 0 && reviewLaneCounts(broker).heldConnections === 0,
    "the slot and held connection return after the answer",
  );
  // Closing the socket AFTER the verdict settled is not a cancellation: a host
  // callback that registered an abort listener must never be told to abandon a
  // review it already decided.
  assert.equal(recorded.signals[0]!.aborted, false, "a completed review's signal is never aborted");
  assert.equal(recorded.aborts, 0, "and no abort listener fires after normal completion");
  assert.doesNotMatch(answered.raw, /token|bootstrap|SECRET/);
});

test("one real-socket JSON line carries a whole request, including a 64 KiB reviewed answer", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  // A full 64 KiB of reviewed assistant text plus every optional field: this one
  // line is larger than the shared legacy frame bound, so it is admitted only by
  // this family's own larger line bound — and it still arrives whole.
  const reviewedSuffix = "\nthe last line matters";
  const reviewed = `${"x".repeat(MAX_NATIVE_REVIEW_MESSAGE_BYTES - Buffer.byteLength(reviewedSuffix, "utf8"))}${reviewedSuffix}`;
  assert.equal(Buffer.byteLength(reviewed, "utf8"), MAX_NATIVE_REVIEW_MESSAGE_BYTES);
  const line = encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap, {
      cwd: "/workspace/project",
      turnId: "turn-7",
      lastAssistantMessage: reviewed,
    }),
  );
  assert.ok(Buffer.byteLength(line, "utf8") > MAX_PRE_AUTH_FRAME_BYTES,
    "this line is admitted only by the review family's own bound");
  const answered = await sendRaw(broker.socketPath, Buffer.from(line, "utf8"));
  assert.deepEqual(answered.frame, { version: 1, type: "native_review_response", action: "allow" });
  assert.equal(recorded.requests.length, 1, "exactly one host callback for the whole line");
  assert.deepEqual(recorded.requests[0], {
    backend: "claude",
    event: "Stop",
    sessionId: "session-root",
    cwd: "/workspace/project",
    turnId: "turn-7",
    lastAssistantMessage: reviewed,
  });
  // The client saw the answer; the broker frees the slot only once it has ALSO
  // observed that connection close, so this is awaited rather than assumed.
  await waitFor(() => reviewLaneCounts(broker).inFlight === 0, "the answered slot returns on close");
});

test("a Codex review source receives the same background membership projection as Claude", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "codex", recorded.handlers);

  // A positively observed empty in-flight set: the relay projects it, and the
  // host must see `[]` rather than losing the whole review.
  const empty = await runRelay(registration.bootstrap, "Stop", relayStdin({
    hook_event_name: "Stop",
    session_id: "session-root",
    background_tasks: [],
  }));
  assert.equal(empty.outcome.status, "allow", "an empty snapshot never makes a Codex review unavailable");
  assert.deepEqual(recorded.requests[0]?.backgroundTasks, []);

  // A valid active member travels in the observer lane's own membership shape,
  // with the provider's extra fields still dropped.
  const active = await runRelay(registration.bootstrap, "Stop", relayStdin({
    hook_event_name: "Stop",
    session_id: "session-root",
    background_tasks: [{ id: "b8k3n1p4q", type: "shell", status: "running", description: "SECRET DESCRIPTION" }],
  }));
  assert.equal(active.outcome.status, "allow");
  assert.deepEqual(recorded.requests[1]?.backgroundTasks, [{ id: "b8k3n1p4q", kind: "shell" }]);
  assert.doesNotMatch(JSON.stringify(recorded.requests[1]), /SECRET|running|status|type/);
  assert.equal(recorded.requests[1]?.backend, "codex");
  registration.release();
});

test("an empty reported assistant message is still reviewed, as an empty string", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const { outcome, stdout } = await runRelay(registration.bootstrap, "Stop", relayStdin({
    hook_event_name: "Stop",
    session_id: "session-root",
    last_assistant_message: "",
  }));
  assert.equal(outcome.status, "allow");
  assert.equal(stdout.text, "", "an allow with no notice prints nothing");
  assert.equal(recorded.requests.length, 1);
  assert.equal(recorded.requests[0]!.lastAssistantMessage, "", "the host sees the empty message, not a missing one");
  registration.release();
});

test("a malformed or over-bound request line reaches no handler and answers nothing", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  // A reviewed answer of the wrong type is not a request line at all: it falls
  // through to the other families' strict decoders and the connection closes with
  // no callback and no answer frame.
  const wrongType = await sendRaw(broker.socketPath, Buffer.from(`${JSON.stringify({
    ...reviewRequestFrame(registration.bootstrap),
    lastAssistantMessage: 42,
  })}\n`, "utf8"));
  assert.equal(wrongType.frame, undefined);
  assert.equal(recorded.requests.length, 0);

  // One byte past the reviewed-text bound is refused even though the line still
  // encodes inside the frame bound — the host is never asked to review a
  // truncated turn.
  const overTextBound = await sendRaw(broker.socketPath, Buffer.from(`${JSON.stringify({
    ...reviewRequestFrame(registration.bootstrap),
    lastAssistantMessage: "x".repeat(MAX_NATIVE_REVIEW_MESSAGE_BYTES + 1),
  })}\n`, "utf8"));
  assert.equal(overTextBound.frame, undefined);
  assert.equal(recorded.requests.length, 0);

  // A line past even the frame bound is refused by the broker's own line bound
  // before any decoder runs, and leaves nothing counted behind.
  const overFrameBound = await sendRaw(broker.socketPath, Buffer.from(`${JSON.stringify({
    ...reviewRequestFrame(registration.bootstrap),
    lastAssistantMessage: "x".repeat(MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES),
  })}\n`, "utf8"));
  assert.equal(overFrameBound.frame, undefined);
  assert.equal(recorded.requests.length, 0);
  assert.equal(reviewLaneCounts(broker).inFlight, 0);

  // A complete request followed by a SECOND request line in the SAME socket
  // chunk. The already-received trailing bytes make the stream invalid, so the
  // request is refused before authentication: no answer and no host callback —
  // identical to the same bytes arriving in a later chunk, which the branch
  // above closes. How the provider's output happened to be split can never
  // change whether a turn was reviewed.
  const second = await sendRaw(broker.socketPath, Buffer.concat([
    Buffer.from(encodeNativeReviewRequestFrame(
      reviewRequestFrame(registration.bootstrap, { sessionId: "first-turn" }),
    ), "utf8"),
    Buffer.from(encodeNativeReviewRequestFrame(
      reviewRequestFrame(registration.bootstrap, { sessionId: "second-turn" }),
    ), "utf8"),
  ]));
  assert.equal(second.raw, "", "coalesced trailing bytes are refused before any answer");
  assert.equal(recorded.requests.length, 0, "and before the host is ever asked to review");
  assert.equal(reviewLaneCounts(broker).inFlight, 0);
});

test("release destroys a held review connection and a late verdict never double-frees its slot", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  let release!: (verdict: NativeReviewVerdict) => void;
  const gate = new Promise<NativeReviewVerdict>((resolve) => { release = resolve; });
  recorded.respond = () => gate;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const socket = await connect(broker.socketPath);
  socket.write(encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap, { lastAssistantMessage: "held text" }),
  ));
  await waitFor(() => recorded.requests.length === 1, "handler invoked");
  assert.equal(recorded.requests[0]!.lastAssistantMessage, "held text");

  const closed = waitForClose(socket, "held review socket on release");
  registration.release();
  await closed;
  await waitFor(() => recorded.aborts === 1, "release aborts the host signal");
  assert.equal(reviewLaneCounts(broker).heldConnections, 0, "the held connection is gone");
  // The slot stays counted while the abandoned host promise is still outstanding
  // (same accounting as the MCP lane), and returns exactly once when it settles.
  assert.equal(reviewLaneCounts(broker).inFlight, 1, "abandoned host work keeps counting");
  release({ action: "allow" });
  await waitFor(() => reviewLaneCounts(broker).inFlight === 0, "the slot returns when the promise settles");
  await settle(20);
  assert.equal(reviewLaneCounts(broker).inFlight, 0, "a settled promise never double-frees");
});

test("a busy review refusal closes without taking a slot, and answered Unix peers keep theirs until close", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  const gates: Array<(verdict: NativeReviewVerdict) => void> = [];
  recorded.respond = () => new Promise<NativeReviewVerdict>((resolve) => { gates.push(resolve); });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  // A Unix socket can keep its write half open after receiving the broker's EOF.
  // Windows named pipes can close both halves after end() despite allowHalfOpen,
  // so keep the handlers pending there until the busy refusal has flushed.
  const halfOpen = process.platform !== "win32";
  const held = [await connect(broker.socketPath, halfOpen), await connect(broker.socketPath, halfOpen)];
  const received = held.map(() => "");
  held.forEach((socket, index) => {
    socket.on("data", (chunk: Buffer) => { received[index] += chunk.toString("utf8"); });
    socket.write(encodeNativeReviewRequestFrame(
      reviewRequestFrame(registration.bootstrap, { sessionId: `held-${index}` }),
    ));
  });
  await waitFor(() => recorded.requests.length === 2, "both requests reached the handler");
  async function answerHeldReviews(): Promise<void> {
    gates.forEach((release) => release({ action: "allow" }));
    await Promise.all(held.map((socket) => waitForClose(socket, "broker EOF after the verdict")));
    for (const raw of received) {
      assert.deepEqual(JSON.parse(raw.trim()), { version: 1, type: "native_review_response", action: "allow" });
    }
  }

  if (halfOpen) {
    await answerHeldReviews();
    assert.ok(held.every((socket) => socket.readableEnded && !socket.destroyed && !socket.writableEnded),
      "both Unix clients received EOF without closing their write halves");
  }
  assert.equal(reviewLaneCounts(broker).inFlight, 2,
    halfOpen ? "both completed replies still occupy their slots" : "both pending reviews occupy their slots");
  assert.equal(reviewLaneCounts(broker).heldConnections, 2);

  // The third turn is refused without migrating from intake to an admitted slot.
  // The client reads its reply but never initiates close; the broker must close
  // this connection after flushing the small frame, leaving only the two holders.
  const refusal = await connect(broker.socketPath);
  let refusalRaw = "";
  refusal.setEncoding("utf8");
  refusal.on("data", (chunk: string) => { refusalRaw += chunk; });
  let refusalClosed = false;
  refusal.once("close", () => { refusalClosed = true; });
  refusal.write(encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap, { sessionId: "third" }),
  ));
  await waitFor(() => refusalClosed, "a busy refusal closes as soon as its small reply flushes");
  assert.deepEqual(JSON.parse(refusalRaw.trim()), { version: 1, type: "native_review_error", code: "busy" });
  assert.equal(recorded.requests.length, 2, "the refused turn never reached the handler");
  assert.equal(reviewLaneCounts(broker).inFlight, 2, "and the refusal holds no admitted slot");
  assert.equal(reviewLaneCounts(broker).heldConnections, 2, "the flushed refusal leaves no tracked review connection");

  // On Windows the slot may return as soon as the answered pipe closes; on Unix
  // the held write halves stay open until we explicitly close the clients.
  if (!halfOpen) await answerHeldReviews();
  assert.equal(recorded.aborts, 0, "delivering a verdict is not a cancellation");
  held.forEach((socket) => socket.destroy());
  await waitFor(() => reviewLaneCounts(broker).inFlight === 0, "capacity returns once the sockets close");
  assert.equal(reviewLaneCounts(broker).heldConnections, 0);
  assert.equal(recorded.aborts, 0, "closing after a delivered verdict is not a cancellation");
  assert.equal(recorded.signals.every((signal) => !signal.aborted), true);
  registration.release();
});

test("a held request survives a slow handler and is answered exactly once", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  let release!: (verdict: { action: "block"; reason: string }) => void;
  const gate = new Promise<{ action: "block"; reason: string }>((resolve) => { release = resolve; });
  recorded.respond = () => gate;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const socket = await connect(broker.socketPath);
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { raw += chunk; });
  socket.write(encodeNativeReviewRequestFrame(reviewRequestFrame(registration.bootstrap)));
  await waitFor(() => recorded.requests.length === 1, "handler invoked");
  await settle(120);
  assert.equal(raw, "", "no answer is written while the host is still reviewing");
  assert.equal(reviewLaneCounts(broker).inFlight, 1);

  release({ action: "block", reason: "run the tests first" });
  await waitFor(() => raw.includes("\n"), "one answer frame");
  assert.deepEqual(JSON.parse(raw.slice(0, raw.indexOf("\n"))), {
    version: 1, type: "native_review_response", action: "block", reason: "run the tests first",
  });
  await settle(80);
  assert.equal(raw.split("\n").length - 1, 1, "exactly one answer frame");
  await waitForClose(socket, "review socket after its answer");
});

test("a client socket closed mid-wait aborts the host signal", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const socket = await connect(broker.socketPath);
  socket.write(encodeNativeReviewRequestFrame(reviewRequestFrame(registration.bootstrap)));
  await waitFor(() => recorded.requests.length === 1, "handler invoked");
  assert.equal(recorded.signals[0]!.aborted, false);

  socket.destroy();
  await waitFor(() => recorded.aborts === 1, "handler signal aborted");
  assert.equal(recorded.signals[0]!.aborted, true);
  await waitFor(() => reviewLaneCounts(broker).heldConnections === 0, "held connection cleared");
});

test("release aborts the in-flight review, destroys the held socket, and refuses later requests", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const bootstrap = registration.bootstrap;

  const held = await connect(broker.socketPath);
  held.write(encodeNativeReviewRequestFrame(reviewRequestFrame(bootstrap)));
  await waitFor(() => recorded.requests.length === 1, "handler invoked");

  const closed = waitForClose(held, "held review socket on release");
  registration.release();
  await closed;
  await waitFor(() => recorded.aborts === 1, "handler signal aborted by release");
  assert.equal(reviewLaneCounts(broker).heldConnections, 0, "the held connection is gone");
  assert.equal(reviewLaneCounts(broker).sources, 0);
  // The counted slot is deliberately NOT reclaimed by an abort: closing the
  // connection cannot prove the host's own work stopped, so the slot stays
  // counted until that abandoned promise settles (same accounting as the MCP
  // lane) and a later turn cannot exceed the lane bound meanwhile.
  assert.equal(reviewLaneCounts(broker).inFlight, 1, "an abandoned host promise keeps its counted slot");

  // A later request with the same (now stale) token is a silent close.
  const stale = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(bootstrap)));
  assert.equal(stale.frame, undefined, "a released review token is stale and closed without an answer");
  assert.equal(recorded.requests.length, 1, "the stale request never reached the handler");

  // The id is free again for the next owned launch, with a fresh token.
  const replacement = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recordingReview().handlers);
  assert.notEqual(replacement.bootstrap.token, bootstrap.token);
  replacement.release();
});

test("broker disposal aborts an in-flight review and revokes the bootstrap", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const bootstrap = registration.bootstrap;

  const held = await connect(broker.socketPath);
  held.write(encodeNativeReviewRequestFrame(reviewRequestFrame(bootstrap)));
  await waitFor(() => recorded.requests.length === 1, "handler invoked");

  const closed = waitForClose(held, "held review socket on dispose");
  await broker.dispose();
  brokers.delete(broker);
  await closed;
  assert.equal(recorded.signals[0]!.aborted, true, "disposal aborts every in-flight review signal");
});

test("wrong, stale, cross-family, and backend-mismatched review requests reach no handler", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = false;
  recorded.respond = async () => ({ action: "allow" });
  // One owned launch legitimately has an observer hook source, an MCP lane, and
  // a review source under the SAME instance id, so the only thing that can
  // authenticate a family is that family's own token.
  const reviewRegistration = broker.registerNativeReviewSource(INSTANCE_SHARED, "claude", recorded.handlers);
  const hookRegistration: NativeHookRegistration = broker.registerNativeHookSource(INSTANCE_SHARED, "claude", recordingHook().handlers);
  const mcpRegistration: NativeMcpRegistration = broker.registerNativeMcpSource(INSTANCE_SHARED, "claude", MCP_ENDPOINT);
  const piRegistration = broker.register(INSTANCE_PI, piHandlers());

  const probes: Array<{ label: string; frame: NativeReviewRequestFrame }> = [
    { label: "wrong token", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { token: "0".repeat(64) }) },
    { label: "stale generation", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) },
    { label: "backend mismatch", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { backend: "codex" }) },
    { label: "observer hook token", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { token: hookRegistration.bootstrap.token }) },
    { label: "MCP lane token", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { token: mcpRegistration.bootstrap.token }) },
    { label: "Pi reporter token", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { token: piRegistration.bootstrap.token }) },
    { label: "foreign instance id", frame: reviewRequestFrame(reviewRegistration.bootstrap, {}, { instanceId: INSTANCE_REVIEW_OTHER }) },
  ];
  for (const probe of probes) {
    const answer = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(probe.frame));
    assert.equal(answer.frame, undefined, `${probe.label}: closed silently without an answer frame`);
  }
  assert.deepEqual(recorded.requests, [], "no rejected probe reached the host callback");

  // The other families are untouched by the rejected review probes.
  const hookAnswer = await sendRaw(broker.socketPath, encodeNativeHookFrame({
    version: 1,
    type: "native_hook_event",
    instanceId: INSTANCE_SHARED,
    generation: hookRegistration.bootstrap.generation,
    backend: "claude",
    token: hookRegistration.bootstrap.token,
    hook_event_name: "PreToolUse",
    tool_use_id: "toolu-after-review-probes",
  }));
  assert.deepEqual(hookAnswer.frame, { version: 1, type: "native_hook_ack", accepted: true }, "the observer lane still works");

  const mcpSocket = await connect(broker.socketPath);
  let mcpClosed = false;
  mcpSocket.once("close", () => { mcpClosed = true; });
  mcpSocket.write(encodeNativeMcpHello(mcpRegistration.bootstrap));
  await settle(120);
  assert.equal(mcpClosed, false, "the MCP lane still authenticates this shared endpoint");

  // And the review family still authenticates its own token afterwards.
  const ok = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(reviewRegistration.bootstrap)));
  assert.deepEqual(ok.frame, { version: 1, type: "native_review_response", action: "allow" });

  // Vice versa: a review token never authenticates the observer lane.
  const crossFamilyHook = await sendRaw(broker.socketPath, encodeNativeHookFrame({
    version: 1,
    type: "native_hook_event",
    instanceId: INSTANCE_SHARED,
    generation: hookRegistration.bootstrap.generation,
    backend: "claude",
    token: reviewRegistration.bootstrap.token,
    hook_event_name: "PreToolUse",
  }));
  assert.equal(crossFamilyHook.frame, undefined, "a review token cannot authenticate an observer hook frame under the same id");

  // Nor the MCP lane under the same id.
  const crossFamilyMcp = await sendRaw(broker.socketPath, encodeNativeMcpHello({
    ...mcpRegistration.bootstrap,
    token: reviewRegistration.bootstrap.token,
  }));
  assert.equal(crossFamilyMcp.frame, undefined, "a review token cannot authenticate an MCP hello under the same id");
});

test("per-source and broker-wide bounds answer busy and never call the handler", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const holders = await holdReviews(broker, registration.bootstrap, 2);
  const overSource = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap, { sessionId: "third" }),
  ));
  assert.deepEqual(overSource.frame, { version: 1, type: "native_review_error", code: "busy" });
  assert.equal(recorded.requests.length, 2, "a refused request never reached the handler");

  // The broker-wide bound, probed from a source that STILL has per-source
  // capacity. The first source is already at its own limit, so a probe from it
  // could be refused by the per-source rule alone and would stay green even with
  // the broker-wide check removed. The second source holds only one request of
  // its own, so only the broker-wide limit can refuse it.
  const other = recordingReview();
  other.hold = true;
  const otherRegistration = broker.registerNativeReviewSource(INSTANCE_REVIEW_OTHER, "codex", other.handlers);
  holders.push(...await holdReviews(broker, otherRegistration.bootstrap, 1));
  brokerTest.setNativeReviewInFlightLimitForTests(3);
  assert.equal(reviewLaneCounts(broker).inFlight, 3, "the lane is full across both sources");
  const globalProbe = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(
    reviewRequestFrame(otherRegistration.bootstrap, { sessionId: "over-global" }),
  ));
  assert.deepEqual(globalProbe.frame, { version: 1, type: "native_review_error", code: "busy" });
  assert.equal(other.requests.length, 1, "the global refusal never reached the second source's handler");
  assert.equal(reviewLaneCounts(broker).inFlight, 3);

  for (const socket of holders) socket.destroy();
  await waitFor(() => reviewLaneCounts(broker).heldConnections === 0, "every held connection cleared");
});

test("a rejected, thrown, or malformed verdict answers failed and never blocks", async () => {
  const broker = await makeBroker();
  const cases: Array<{ label: string; handler: () => Promise<never> | Promise<{ action: string }> }> = [
    { label: "rejection", handler: () => Promise.reject(new Error("host exploded")) },
    { label: "malformed verdict", handler: () => Promise.resolve({ action: "retry" }) },
    { label: "block without reason", handler: () => Promise.resolve({ action: "block" }) },
  ];
  for (const testCase of cases) {
    const recorded = recordingReview();
    recorded.respond = testCase.handler as RecordedReview["respond"];
    const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
    const answer = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(registration.bootstrap)));
    assert.deepEqual(answer.frame, { version: 1, type: "native_review_error", code: "failed" }, testCase.label);
    registration.release();
  }

  // A synchronous throw is contained the same way, and the broker survives.
  const throwing = {
    onReviewRequest: (): never => { throw new Error("sync throw"); },
  } as unknown as NativeReviewSourceHandlers;
  const throwingRegistration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", throwing);
  const thrown = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(throwingRegistration.bootstrap)));
  assert.deepEqual(thrown.frame, { version: 1, type: "native_review_error", code: "failed" });
  throwingRegistration.release();

  const survivor = recordingReview();
  survivor.respond = async () => ({ action: "allow" });
  const survivorRegistration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", survivor.handlers);
  const ok = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(survivorRegistration.bootstrap)));
  assert.deepEqual(ok.frame, { version: 1, type: "native_review_response", action: "allow" }, "the lane is still usable");
  survivorRegistration.release();
});

test("a resolved verdict whose getters throw is contained, frees its slot, and the next request succeeds", async () => {
  const broker = await makeBroker();
  const cases: Array<{ label: string; verdict: () => unknown }> = [
    // A getter that throws on the FIRST read.
    {
      label: "throwing action getter",
      verdict: () => ({
        get action(): string { throw new Error("host getter exploded"); },
        reason: "never read",
      }),
    },
    // A getter that throws only once the validator has already touched the
    // object: validation reads `action` first, then `reason`, so a single throw
    // mid-validation must not escape the fulfillment callback.
    {
      label: "throwing reason getter after a valid action",
      verdict: () => ({
        action: "block",
        get reason(): string { throw new Error("late getter explosion"); },
      }),
    },
    // A property whose getter throws every time, reached through the same
    // validation path.
    {
      label: "throwing userMessage getter",
      verdict: () => ({
        action: "allow",
        get userMessage(): string { throw new Error("notice getter exploded"); },
      }),
    },
  ];
  for (const testCase of cases) {
    const recorded = recordingReview();
    recorded.respond = async () => testCase.verdict() as NativeReviewVerdict;
    const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
    const answer = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(registration.bootstrap)));
    assert.deepEqual(answer.frame, { version: 1, type: "native_review_error", code: "failed" }, testCase.label);
    await waitFor(() => reviewLaneCounts(broker).inFlight === 0, `${testCase.label} frees its slot`);
    registration.release();
  }

  // The broker is unharmed: the very next request is reviewed normally.
  const next = recordingReview();
  next.respond = async () => ({ action: "block", reason: "still working" });
  const nextRegistration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", next.handlers);
  const ok = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(nextRegistration.bootstrap)));
  assert.deepEqual(ok.frame, { version: 1, type: "native_review_response", action: "block", reason: "still working" });
  await waitFor(() => reviewLaneCounts(broker).inFlight === 0, "the final answered slot returns on close");
  nextRegistration.release();
});

test("a returned promise or thenable whose then accessor throws is contained and answers failed", async () => {
  const broker = await makeBroker();
  const cases: Array<{ label: string; make: () => unknown }> = [
    {
      // A genuine native promise with an own `then` accessor that throws:
      // Promise.resolve would hand this exact object back, so attaching
      // callbacks to it directly would throw out of the socket callback.
      label: "native promise with throwing then accessor",
      make: () => {
        const promise = Promise.resolve({ action: "allow" });
        Object.defineProperty(promise, "then", { get(): never { throw new Error("then accessor exploded"); } });
        return promise;
      },
    },
    {
      label: "plain thenable with throwing then accessor",
      make: () => ({ get then(): never { throw new Error("thenable accessor exploded"); } }),
    },
  ];
  for (const testCase of cases) {
    const handlers = { onReviewRequest: () => testCase.make() } as unknown as NativeReviewSourceHandlers;
    const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", handlers);
    const answer = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(registration.bootstrap)));
    assert.deepEqual(answer.frame, { version: 1, type: "native_review_error", code: "failed" }, testCase.label);
    await waitFor(() => reviewLaneCounts(broker).inFlight === 0, `${testCase.label} frees its slot`);
    registration.release();
  }

  const next = recordingReview();
  next.respond = async () => ({ action: "allow" });
  const nextRegistration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", next.handlers);
  const ok = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(nextRegistration.bootstrap)));
  assert.deepEqual(ok.frame, { version: 1, type: "native_review_response", action: "allow" }, "the lane is still usable");
  nextRegistration.release();
});

test("frame overflow, invalid UTF-8, and a second request line are refused before any callback", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = false;
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  // A request line carrying a field past its own bound is refused by this
  // family's strict decoder before authentication or any callback is reached.
  const oversized = `${JSON.stringify({
    version: 1,
    type: "native_review_request",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    backend: "claude",
    token: registration.bootstrap.token,
    event: "Stop",
    sessionId: "session-root",
    cwd: `/workspace/${"x".repeat(MAX_STATUS_FRAME_BYTES)}`,
  })}\n`;
  assert.ok(Buffer.byteLength(oversized, "utf8") > MAX_STATUS_FRAME_BYTES);
  const overflow = await sendRaw(broker.socketPath, oversized);
  assert.equal(overflow.frame, undefined, "an oversized header line is closed without an answer");

  const garbage = await sendRaw(broker.socketPath, Buffer.from([0xff, 0xfe, 0x0a]));
  assert.equal(garbage.frame, undefined);

  // One connection carries exactly one request line: a second line while the
  // first is still unanswered closes the connection without any callback.
  const heldRecorded = recordingReview();
  heldRecorded.hold = true;
  const heldRegistration = broker.registerNativeReviewSource(INSTANCE_REVIEW_OTHER, "claude", heldRecorded.handlers);
  const socket = await connect(broker.socketPath);
  let secondLineClosed = false;
  socket.once("close", () => { secondLineClosed = true; });
  socket.write(encodeNativeReviewRequestFrame(reviewRequestFrame(heldRegistration.bootstrap)));
  await waitFor(() => heldRecorded.requests.length === 1, "first request handled");
  socket.write(encodeNativeReviewRequestFrame(reviewRequestFrame(heldRegistration.bootstrap, { sessionId: "second" })));
  await waitFor(() => secondLineClosed, "review socket closed by its second request line");
  await settle(40);
  assert.equal(heldRecorded.requests.length, 1, "the second request line never reached the handler");
  heldRegistration.release();
});

test("a review source's wider line buffer never lets a BOM-padded Pi hello authenticate", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  let piStatuses = 0;
  const piRegistration = broker.register(INSTANCE_PI, {
    onStatus: () => { piStatuses += 1; },
    onDisconnect: () => undefined,
  });

  // `parseHello` ignores unknown fields, so a padded hello is still a VALID Pi
  // hello at a precise raw length. Because the shared decoder strips a leading
  // UTF-8 BOM, only a check on the RAW bytes preserves the limit the original
  // pre-auth reader enforced: once the BOM is gone the decoded JSON is back
  // inside the legacy bound.
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const paddedHello = (rawLineBytes: number): Buffer => {
    const skeleton = Buffer.from(JSON.stringify({
      version: 1,
      type: "hello",
      instanceId: piRegistration.bootstrap.instanceId,
      generation: piRegistration.bootstrap.generation,
      token: piRegistration.bootstrap.token,
      pad: "",
    }), "utf8");
    const pad = "p".repeat(rawLineBytes - bom.length - skeleton.length);
    return Buffer.concat([
      bom,
      Buffer.from(JSON.stringify({
        version: 1,
        type: "hello",
        instanceId: piRegistration.bootstrap.instanceId,
        generation: piRegistration.bootstrap.generation,
        token: piRegistration.bootstrap.token,
        pad,
      }), "utf8"),
      Buffer.from("\n", "utf8"),
    ]);
  };

  // Control: at the largest raw length the original reader accepted, the same
  // BOM-padded hello still authenticates — the wider buffer changes nothing for
  // a frame that fits, and this proves the padding itself is not what refuses it.
  const atLimit = await connect(broker.socketPath);
  let atLimitClosed = false;
  atLimit.once("close", () => { atLimitClosed = true; });
  atLimit.write(paddedHello(MAX_PRE_AUTH_FRAME_BYTES - 1));
  await settle(120);
  assert.equal(atLimitClosed, false, "a legacy frame at the original raw limit stays open");
  // Proof that it really authenticated: its status frame is now accepted.
  atLimit.write(`${JSON.stringify({
    version: 1,
    type: "status",
    instanceId: piRegistration.bootstrap.instanceId,
    generation: piRegistration.bootstrap.generation,
    sequence: 1,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
  })}\n`);
  await waitFor(() => piStatuses === 1, "the padded hello at the limit authenticated the Pi reporter");
  atLimit.destroy();
  const piStatusesAtControl = piStatuses;

  // Regression: ONE byte of raw padding past the original limit, which the
  // BOM-stripping decoder would otherwise bring back inside it. With a review
  // source registered the wider buffer must still refuse it, on the raw bytes,
  // before any legacy decoder runs. A hello earns no reply, so the proof that it
  // was REFUSED is that the broker closes the connection and the Pi reporter is
  // never replaced: an authenticated hello would sit open awaiting status.
  const overLimit = await connect(broker.socketPath);
  let overLimitClosed = false;
  overLimit.once("close", () => { overLimitClosed = true; });
  overLimit.write(paddedHello(MAX_PRE_AUTH_FRAME_BYTES));
  await waitFor(() => overLimitClosed, "a raw-oversized BOM-padded Pi hello closes the connection");
  assert.equal(overLimit.readableEnded || overLimit.destroyed, true);
  // And it never authenticated: a status frame on that same (already refused)
  // connection is not accepted, so the active reporter is still the control one.
  overLimit.write(`${JSON.stringify({
    version: 1,
    type: "status",
    instanceId: piRegistration.bootstrap.instanceId,
    generation: piRegistration.bootstrap.generation,
    sequence: 2,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
  })}\n`);
  await settle(120);
  assert.equal(piStatuses, piStatusesAtControl, "the refused hello never became the Pi reporter");
  assert.equal(recorded.requests.length, 0, "and it never reached the review handler");

  // Identical refusal with no review source registered: the original behaviour.
  const noReviewBroker = await makeBroker();
  const plainPi = noReviewBroker.register(INSTANCE_PI, { onStatus: () => undefined, onDisconnect: () => undefined });
  const plainHello = (rawLineBytes: number): Buffer => {
    const pad = "p".repeat(rawLineBytes - bom.length - JSON.stringify({
      version: 1, type: "hello",
      instanceId: plainPi.bootstrap.instanceId,
      generation: plainPi.bootstrap.generation,
      token: plainPi.bootstrap.token,
      pad: "",
    }).length);
    return Buffer.concat([bom, Buffer.from(JSON.stringify({
      version: 1, type: "hello",
      instanceId: plainPi.bootstrap.instanceId,
      generation: plainPi.bootstrap.generation,
      token: plainPi.bootstrap.token,
      pad,
    }), "utf8"), Buffer.from("\n", "utf8")]);
  };
  const baseline = await sendRaw(noReviewBroker.socketPath, plainHello(MAX_PRE_AUTH_FRAME_BYTES));
  assert.equal(baseline.raw, "", "the refusal is unchanged on a broker with no review source");

  // The review lane is unaffected throughout.
  const review = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap),
  ));
  assert.deepEqual(review.frame, { version: 1, type: "native_review_response", action: "allow" });
  piRegistration.release();
  registration.release();
});

test("the review family's larger line bound never widens any legacy family's frame limit", async () => {
  assert.ok(MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES > MAX_PRE_AUTH_FRAME_BYTES,
    "this test only means something if the review line bound is the larger one");
  const broker = await makeBroker();
  const recorded = recordingReview();
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const hookRegistration = broker.registerNativeHookSource(INSTANCE_HOOK, "claude", recordingHook().handlers);
  const mcpRegistration = broker.registerNativeMcpSource(INSTANCE_MCP, "claude", MCP_ENDPOINT);

  // One line, larger than the shared legacy bound but smaller than this family's
  // own: shaped like the Pi family (a status frame with a huge extra field) so it
  // is unambiguously NOT a review request. The broker must refuse it on the
  // transport bound, before any decoder runs, with no answer of any kind.
  const oversizedLegacy = `${JSON.stringify({
    version: 1,
    type: "status",
    instanceId: INSTANCE_PI,
    generation: broker.generation,
    token: hookRegistration.bootstrap.token,
    padding: "p".repeat(MAX_PRE_AUTH_FRAME_BYTES),
  })}\n`;
  assert.ok(Buffer.byteLength(oversizedLegacy, "utf8") > MAX_PRE_AUTH_FRAME_BYTES);
  assert.ok(Buffer.byteLength(oversizedLegacy, "utf8") < MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES);
  const refused = await sendRaw(broker.socketPath, Buffer.from(oversizedLegacy, "utf8"));
  assert.equal(refused.frame, undefined, "an oversized legacy-shaped line is never answered");
  assert.equal(recorded.requests.length, 0, "and it never reaches the review handler either");

  // Same for a native MCP hello padded past the shared bound: this family's
  // larger bound does not become a general-purpose larger frame allowance.
  const oversizedHello = `${JSON.stringify({
    ...mcpRegistration.bootstrap,
    type: "native_mcp_hello",
    padding: "h".repeat(MAX_PRE_AUTH_FRAME_BYTES),
  })}\n`;
  assert.ok(Buffer.byteLength(oversizedHello, "utf8") > MAX_PRE_AUTH_FRAME_BYTES);
  const refusedHello = await sendRaw(broker.socketPath, Buffer.from(oversizedHello, "utf8"));
  assert.equal(refusedHello.frame, undefined);
  assert.equal(recorded.requests.length, 0);

  // The legacy families' OWN bounds are unchanged: a normal observer-hook frame
  // and a normal MCP hello are still accepted on a broker that hosts a review
  // source, exactly as before this family existed.
  const hookAnswer = await sendRaw(broker.socketPath, encodeNativeHookFrame({
    version: 1,
    type: "native_hook_event",
    instanceId: INSTANCE_HOOK,
    generation: hookRegistration.bootstrap.generation,
    backend: "claude",
    token: hookRegistration.bootstrap.token,
    hook_event_name: "PreToolUse",
    tool_use_id: "toolu-normal-size",
  }));
  assert.deepEqual(hookAnswer.frame, { version: 1, type: "native_hook_ack", accepted: true });

  const mcpSocket = trackSocket(await connect(broker.socketPath));
  let mcpClosed = false;
  mcpSocket.once("close", () => { mcpClosed = true; });
  mcpSocket.write(encodeNativeMcpHello(mcpRegistration.bootstrap));
  await settle(120);
  assert.equal(mcpClosed, false, "the MCP hello's own bound still authenticates it");
  mcpSocket.destroy();

  // And this family's own larger line still works on the same broker.
  const review = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(
    reviewRequestFrame(registration.bootstrap, {
      lastAssistantMessage: "x".repeat(MAX_NATIVE_REVIEW_MESSAGE_BYTES - 64),
    }),
  ));
  assert.deepEqual(review.frame, {
    version: 1, type: "native_review_response", action: "allow",
  });
  mcpRegistration.release();
  hookRegistration.release();
  registration.release();
});

test("a review source registers beside every other family and only its own duplicate is refused", async () => {
  const broker = await makeBroker();
  // One broker endpoint, one instance id, four independent families: the review
  // source never displaces or merges with a Pi row, an observer hook source, or
  // an MCP lane. (A Pi row cannot share an id with a native family at all — that
  // pre-existing rule is asserted by the broker and MCP suites, not changed here.)
  const hook = broker.registerNativeHookSource(INSTANCE_SHARED, "claude", recordingHook().handlers);
  const mcp = broker.registerNativeMcpSource(INSTANCE_SHARED, "claude", MCP_ENDPOINT);
  const review = broker.registerNativeReviewSource(INSTANCE_SHARED, "claude", recordingReview().handlers);
  assert.equal(review.bootstrap.socketPath, broker.socketPath, "the review lane reuses the one broker endpoint");
  assert.equal(review.bootstrap.instanceId, hook.bootstrap.instanceId);
  assert.equal(review.bootstrap.instanceId, mcp.bootstrap.instanceId);
  assert.notEqual(review.bootstrap.token, hook.bootstrap.token, "the review token is independent");
  assert.notEqual(review.bootstrap.token, mcp.bootstrap.token, "the review token is independent");
  assert.equal(review.bootstrap.generation, broker.generation);

  // Only a second live review source for the same id is refused, and a released
  // id is free again with a fresh token.
  assert.throws(
    () => broker.registerNativeReviewSource(INSTANCE_SHARED, "codex", recordingReview().handlers),
    /active native review source already exists/,
  );
  review.release();
  const replacement = broker.registerNativeReviewSource(INSTANCE_SHARED, "codex", recordingReview().handlers);
  assert.notEqual(replacement.bootstrap.token, review.bootstrap.token);
  assert.equal(replacement.bootstrap.backend, "codex");
  replacement.release();

  // A review source on its own id coexists with a Pi row on another id.
  const own = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recordingReview().handlers);
  const pi = broker.register(INSTANCE_PI, piHandlers());
  assert.notEqual(own.bootstrap.token, pi.bootstrap.token);

  // Registration validation is unchanged by the other families' state.
  assert.throws(() => broker.registerNativeReviewSource("not-an-id", "claude", recordingReview().handlers), /malformed/);
  assert.throws(() => broker.registerNativeReviewSource(INSTANCE_REVIEW_OTHER, "pi" as never, recordingReview().handlers), /backend/);
  assert.throws(() => broker.registerNativeReviewSource(INSTANCE_REVIEW_OTHER, "claude", {} as never), /onReviewRequest/);
  own.release();
});

test("the observer hook lane keeps its one-shot ACK behaviour beside the review lane", async () => {
  const broker = await makeBroker();
  const hookRecorded = recordingHook();
  const hook = broker.registerNativeHookSource(INSTANCE_HOOK, "claude", hookRecorded.handlers);
  const review = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recordingReview().handlers);

  const hookAnswer = await sendRaw(broker.socketPath, encodeNativeHookFrame({
    version: 1,
    type: "native_hook_event",
    instanceId: hook.bootstrap.instanceId,
    generation: hook.bootstrap.generation,
    backend: "claude",
    token: hook.bootstrap.token,
    hook_event_name: "Stop",
    session_id: "session-root",
  }));
  assert.deepEqual(hookAnswer.frame, { version: 1, type: "native_hook_ack", accepted: true });
  assert.deepEqual(hookRecorded.events, [{ backend: "claude", hook_event_name: "Stop", session_id: "session-root" }],
    "the observer lane's closed metadata is unchanged");

  const reviewAnswer = await sendRaw(broker.socketPath, encodeNativeReviewRequestFrame(reviewRequestFrame(review.bootstrap)));
  assert.equal(reviewAnswer.frame === undefined, false, "the review lane answers its own family");
});

// ---------------------------------------------------------------------------
// Relay: exact provider stdout
// ---------------------------------------------------------------------------

test("the relay maps each verdict to the exact provider stdout", async () => {
  const broker = await makeBroker();
  const cases: Array<{
    label: string;
    verdict: { action: "allow"; userMessage?: string } | { action: "block"; reason: string; userMessage?: string };
    expected: string;
  }> = [
    { label: "allow", verdict: { action: "allow" }, expected: "" },
    { label: "allow with notice", verdict: { action: "allow", userMessage: "reviewed, looks fine" }, expected: `${JSON.stringify({ systemMessage: "reviewed, looks fine" })}\n` },
    { label: "block", verdict: { action: "block", reason: "add a test" }, expected: `${JSON.stringify({ decision: "block", reason: "add a test" })}\n` },
    {
      label: "block with notice",
      verdict: { action: "block", reason: "add a test", userMessage: "pi-review-gate blocked this turn" },
      expected: `${JSON.stringify({ decision: "block", reason: "add a test", systemMessage: "pi-review-gate blocked this turn" })}\n`,
    },
    {
      // The regression this guards: discarding a block solely because its notice
      // is empty would let the provider proceed with a turn the host blocked.
      label: "block with empty notice",
      verdict: { action: "block", reason: "add a test", userMessage: "" },
      expected: `${JSON.stringify({ decision: "block", reason: "add a test", systemMessage: "" })}\n`,
    },
    {
      label: "allow with empty notice",
      verdict: { action: "allow", userMessage: "" },
      expected: `${JSON.stringify({ systemMessage: "" })}\n`,
    },
  ];
  for (const testCase of cases) {
    const recorded = recordingReview();
    recorded.respond = async () => testCase.verdict;
    const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
    const { outcome, stdout } = await runRelay(registration.bootstrap, "Stop", relayStdin(STOP_INPUT));
    assert.equal(outcome.status, testCase.verdict.action, testCase.label);
    assert.equal(stdout.text, testCase.expected, testCase.label);
    registration.release();
  }
});

test("the relay prints the not-reviewed notice for every failure and never a decision", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const bootstrap = registration.bootstrap;
  const unavailable = (reason: string) => `${JSON.stringify({ systemMessage: nativeReviewUnavailableMessage(reason as never) })}\n`;

  // Broker-side closed errors.
  for (const code of ["busy", "unavailable", "failed"] as const) {
    const stdout = new CapturingStdout();
    const outcome = await runNativeReviewHookRelay({
      env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
      stdin: relayStdin(STOP_INPUT),
      stdout: stdout as unknown as NodeJS.WritableStream,
      event: "Stop",
      connect: () => {
        const socket = new net.Socket();
        setImmediate(() => {
          socket.emit("connect");
          socket.emit("data", Buffer.from(`${JSON.stringify({ version: 1, type: "native_review_error", code })}\n`, "utf8"));
        });
        return trackSocket(socket);
      },
    });
    assert.equal(outcome.status, "unavailable", code);
    assert.equal(outcome.reason, code, code);
    assert.equal(stdout.text, unavailable(code), code);
  }

  // No bootstrap at all.
  const unconfigured = new CapturingStdout();
  const unconfiguredOutcome = await runNativeReviewHookRelay({
    env: {}, stdin: relayStdin(STOP_INPUT), stdout: unconfigured as unknown as NodeJS.WritableStream, event: "Stop",
  });
  assert.deepEqual(unconfiguredOutcome, { status: "unavailable", reason: "unconfigured" });
  assert.equal(unconfigured.text, unavailable("unconfigured"));

  // Event cross-check failures.
  const badArg = await runRelay(bootstrap, "PreToolUse", relayStdin(STOP_INPUT));
  assert.deepEqual(badArg.outcome, { status: "unavailable", reason: "event-mismatch" });
  assert.equal(badArg.stdout.text, unavailable("event-mismatch"));

  const mismatchedStdin = await runRelay(bootstrap, "UserPromptSubmit", relayStdin({ ...STOP_INPUT, hook_event_name: "Stop" }));
  assert.deepEqual(mismatchedStdin.outcome, { status: "unavailable", reason: "event-mismatch" });

  // Malformed / oversized / non-UTF-8 stdin.
  const malformed = await runRelay(bootstrap, "Stop", relayStdinBytes(Buffer.from("{not-json", "utf8")));
  assert.deepEqual(malformed.outcome, { status: "unavailable", reason: "input-malformed" });
  const tooLarge = await runRelay(bootstrap, "Stop", relayStdinBytes(Buffer.alloc(MAX_NATIVE_REVIEW_STDIN_BYTES + 1, 0x20)));
  assert.deepEqual(tooLarge.outcome, { status: "unavailable", reason: "input-too-large" });
  const notUtf8 = await runRelay(bootstrap, "Stop", relayStdinBytes(Buffer.from([0xff, 0xfe])));
  assert.deepEqual(notUtf8.outcome, { status: "unavailable", reason: "input-not-utf8" });

  // Unreachable broker, and a socket that closes without ever answering.
  //
  // The endpoint is a REAL one this fixture issued, then disposed: a closed
  // POSIX Unix socket here is a closed named pipe on Windows, so the same probe
  // exercises a genuine connection failure on every platform. A hand-written
  // filesystem path would not — the Windows bootstrap validator rejects it as
  // unconfigured before the relay ever dials, which would make this assertion
  // test nothing there.
  await broker.dispose();
  const unreachable = await runNativeReviewHookRelay({
    env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin: relayStdin(STOP_INPUT),
    stdout: new CapturingStdout() as unknown as NodeJS.WritableStream,
    event: "Stop",
    timeouts: { connectMs: 200 },
  });
  assert.equal(unreachable.reason, "unreachable");

  const closedEarly = await runNativeReviewHookRelay({
    env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin: relayStdin(STOP_INPUT),
    stdout: new CapturingStdout() as unknown as NodeJS.WritableStream,
    event: "Stop",
    connect: () => {
      const socket = new net.Socket();
      setImmediate(() => {
        socket.emit("connect");
        socket.emit("close");
      });
      return trackSocket(socket);
    },
  });
  assert.deepEqual(closedEarly, { status: "unavailable", reason: "closed" });

  // A hostile or malformed answer frame is never read as a verdict.
  for (const answer of ['{"version":1,"type":"native_review_response","action":"block"}\n', 'nonsense\n', '{"version":1,"type":"hello"}\n']) {
    const stdout = new CapturingStdout();
    const outcome = await runNativeReviewHookRelay({
      env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
      stdin: relayStdin(STOP_INPUT),
      stdout: stdout as unknown as NodeJS.WritableStream,
      event: "Stop",
      connect: () => {
        const socket = new net.Socket();
        setImmediate(() => {
          socket.emit("connect");
          socket.emit("data", Buffer.from(answer, "utf8"));
        });
        return trackSocket(socket);
      },
    });
    assert.equal(outcome.status, "unavailable", answer);
    assert.equal((outcome as { reason?: string }).reason, "response-invalid", answer);
    assert.equal(stdout.text.includes('"decision"'), false, `${answer} must never produce a decision`);
  }

  assert.ok(recorded.requests.length >= 0);
  registration.release();
});

test("the projected request never carries prompt text, a transcript path, or the token", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "block", reason: "please add a test", userMessage: "reviewed and blocked" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const { stdout } = await runRelay(registration.bootstrap, "Stop", relayStdin(STOP_INPUT, "\r\n"));
  assert.equal(recorded.requests.length, 1);
  const request = recorded.requests[0]!;
  assert.deepEqual(request, {
    backend: "claude",
    event: "Stop",
    sessionId: "session-root",
    turnId: "turn-7",
    stopHookActive: false,
    backgroundTasks: [{ id: "b8k3n1p4q", kind: "shell" }],
    lastAssistantMessage: "I finished the change.\nIt touches two files.",
    cwd: "/workspace/project",
  });
  // A `Stop` review is reviewed on the assistant's answer, so it never carries
  // prompt text even though the provider document does.
  assert.equal(Object.prototype.hasOwnProperty.call(request, "prompt"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "transcript_path"), false);
  const serializedRequest = JSON.stringify(request);
  for (const secret of ["SECRET PROMPT", "SECRET COMMAND", "SECRET RESULT", "SECRET DESCRIPTION", "/secret/transcript.jsonl"]) {
    assert.ok(!serializedRequest.includes(secret), `${secret} must never reach the host callback`);
  }
  assert.ok(!serializedRequest.includes(registration.bootstrap.token), "the token never reaches the host callback");

  // And it never appears on the provider's stdout either.
  assert.ok(!stdout.text.includes(registration.bootstrap.token), "the token is never printed");
  assert.ok(!stdout.text.includes("SECRET"), "no provider stdin secret is printed");
  assert.deepEqual(JSON.parse(stdout.text), {
    decision: "block", reason: "please add a test", systemMessage: "reviewed and blocked",
  });
  registration.release();
});

test("a `UserPromptSubmit` request reaches the host callback with the submitted prompt", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const { outcome } = await runRelay(registration.bootstrap, "UserPromptSubmit", relayStdin({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-root",
    prompt: "Add a retry to upload()\nand keep the existing tests",
    // Still never selected on this event: the prompt is the only new field.
    transcript_path: "/secret/transcript.jsonl",
    tool_input: { command: "SECRET COMMAND" },
    tool_response: { stdout: "SECRET RESULT" },
  }));
  assert.equal(outcome.status, "allow");
  assert.equal(recorded.requests.length, 1);
  const request = recorded.requests[0]!;
  assert.deepEqual(request, {
    backend: "claude",
    event: "UserPromptSubmit",
    sessionId: "session-root",
    prompt: "Add a retry to upload()\nand keep the existing tests",
  });
  const serializedRequest = JSON.stringify(request);
  for (const secret of ["SECRET COMMAND", "SECRET RESULT", "/secret/transcript.jsonl"]) {
    assert.ok(!serializedRequest.includes(secret), `${secret} must never reach the host callback`);
  }
  assert.ok(!serializedRequest.includes(registration.bootstrap.token), "the token never reaches the host callback");
  registration.release();
});

test("the relay waits without its own deadline and answers when the host is slow", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { action: "allow", userMessage: "slow but reviewed" };
  };
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const started = Date.now();
  const { outcome, stdout } = await runRelay(registration.bootstrap, "UserPromptSubmit", relayStdin({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-root",
    prompt: "SECRET PROMPT",
  }));
  assert.ok(Date.now() - started >= 200, "the relay held the connection open for the host");
  assert.equal(outcome.status, "allow");
  assert.equal(stdout.text, `${JSON.stringify({ systemMessage: "slow but reviewed" })}\n`);
  assert.equal(recorded.requests[0]!.event, "UserPromptSubmit");
  registration.release();
});

// ---------------------------------------------------------------------------
// Windows: platform-independent assertions, then the real-host legs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The held wait's two guards: provider-parent liveness, and the relay's own
// backstop. Both exist because a provider hook timeout is NOT guaranteed to
// kill this child (verified live on Windows, where the provider runs the hook
// through `cmd.exe /C` and its timeout kills only `cmd.exe`), and an orphaned
// relay would hold a broker connection the host believes it is answering.
// ---------------------------------------------------------------------------

/** Runs the relay with an injected watchdog against the real broker. */
type RelayWatchdog = NonNullable<NativeReviewHookRelayOptions["watchdog"]>;

/**
 * Keeps the event loop alive with a REFERENCED timer while a test waits on a
 * production guard whose own timers are deliberately `unref`'d, so a watchdog
 * that never fires fails the test instead of letting the loop drain and the test
 * end silently. Always `done()` in a `finally`.
 */
function hangGuard(label: string, timeoutMs = 15_000): { watch<T>(promise: Promise<T>): Promise<T>; done(): void } {
  let timer: NodeJS.Timeout | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no outcome within ${timeoutMs}ms`)), timeoutMs);
  });
  return {
    watch<T>(promise: Promise<T>): Promise<T> { return Promise.race([promise, failure]); },
    done(): void { clearTimeout(timer); },
  };
}

async function runGuardedRelay(
  bootstrap: NativeReviewBootstrap,
  watchdog: RelayWatchdog,
): Promise<{ outcome: Awaited<ReturnType<typeof runNativeReviewHookRelay>>; stdout: CapturingStdout }> {
  const stdout = new CapturingStdout();
  const outcome = await runNativeReviewHookRelay({
    env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin: relayStdin(STOP_INPUT),
    stdout: stdout as unknown as NodeJS.WritableStream,
    event: "Stop",
    watchdog,
  });
  return { outcome, stdout };
}

test("a relay whose provider parent died abandons the wait and tells the host by hanging up", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  // Only the guard can end this wait: the host would happily take the review.
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  // `pollMs: 0` switches the interval OFF, so what ends this wait is a probe at a
  // socket boundary — the moment the relay would otherwise start work for a
  // provider that is already gone.
  const guard = hangGuard("relay parent loss at the connect boundary");
  try {
    const started = Date.now();
    const { outcome, stdout } = await guard.watch(
      runGuardedRelay(registration.bootstrap, { isParentAlive: () => false, pollMs: 0 }),
    );
    assert.ok(Date.now() - started < 2_000, "the abandoned wait ended on the probe, not on an answer");
    assert.deepEqual(outcome, { status: "unavailable" }, "an abandoned wait carries no closed reason: nothing was delivered");
    assert.equal(stdout.text, "", "a turn whose provider is gone has no reader for a notice");
    assert.deepEqual(recorded.requests, [], "a provider that is gone is never asked to review at all");
    assert.equal(recorded.aborts, 0, "no review was started, so there was nothing to abort");
    await waitFor(() => reviewLaneCounts(broker).heldConnections === 0, "the abandoned connection is gone");
  } finally {
    guard.done();
    registration.release();
  }
});

test("a connection already carrying the host's review is destroyed when the parent is noticed gone", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const guard = hangGuard("relay parent loss on an already-held connection");
  try {
    // The parent is alive while the request is sent and the host takes the
    // review, and only then dies: this is the ALREADY-HELD connection the guard
    // must destroy, which is the only thing that tells the host to abort the
    // review it is running.
    const { outcome, stdout } = await guard.watch(
      runGuardedRelay(registration.bootstrap, { isParentAlive: () => recorded.requests.length === 0, pollMs: 10 }),
    );
    assert.deepEqual(outcome, { status: "unavailable" });
    assert.equal(stdout.text, "", "a turn whose provider died mid-review has no reader for a verdict");
    assert.equal(recorded.requests.length, 1, "the review really was requested before the parent was lost");
    await waitFor(() => recorded.aborts === 1, "destroying the held connection aborted the host's review");
    await waitFor(() => reviewLaneCounts(broker).heldConnections === 0, "the held connection is gone");
  } finally {
    guard.done();
    registration.release();
  }
});

test("the relay's own backstop abandons a wait the provider's hook timeout cannot end", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.hold = true;
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const { outcome, stdout } = await runGuardedRelay(registration.bootstrap, {
    // A parent that stays alive proves the backstop, and only the backstop, ends
    // this wait — the exact orphan case the provider's own timeout cannot reach.
    isParentAlive: () => true,
    pollMs: 10,
    deadlineMs: 150,
  });
  assert.deepEqual(outcome, { status: "unavailable" });
  assert.equal(stdout.text, "", "the backstop writes nothing either");
  await waitFor(() => recorded.aborts === 1, "the backstop's hangup aborted the host's review");
  registration.release();
});

test("the backstop is inside the provider's hook timeout but outside the host's own review deadline", () => {
  assert.equal(NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS, NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS * 1000 - 60_000);
  assert.ok(NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS < NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS * 1000,
    "an orphaned relay cannot outlive the hook that spawned it");
  assert.ok(NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS > NATIVE_REVIEW_DEADLINE_MS,
    "a review the host is still bounding is never abandoned by the relay first");
  assert.ok(NATIVE_REVIEW_HOOK_PARENT_POLL_MS >= 250 && NATIVE_REVIEW_HOOK_PARENT_POLL_MS <= 500,
    "the liveness poll is coarse, not a hot loop");
});

test("a live parent and an unexpired backstop never abandon a slow host", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  let probed = 0;
  recorded.respond = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { action: "allow", userMessage: "slow but reviewed" };
  };
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const { outcome, stdout } = await runGuardedRelay(registration.bootstrap, {
    isParentAlive: () => {
      probed += 1;
      return true;
    },
    pollMs: 20,
  });
  assert.ok(probed >= 3, `the guard actually ran (${probed} probes)`);
  assert.equal(outcome.status, "allow");
  assert.equal(stdout.text, `${JSON.stringify({ systemMessage: "slow but reviewed" })}\n`);
  registration.release();
});

test("abandoning the wait destroys the held socket before the relay returns", async () => {
  let held: net.Socket | undefined;
  const stdout = new CapturingStdout();
  // The injected socket is never connected and the guard's timers are unref'd, so
  // without this referenced guard a watchdog that never fired would let the event
  // loop drain instead of failing the test.
  const guard = hangGuard("relay parent-liveness guard on a held socket");
  try {
    const outcome = await guard.watch(runNativeReviewHookRelay({
      env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: encodeNativeReviewBootstrapEnv(WINDOWS_PIPE_BOOTSTRAP) },
      stdin: relayStdin(STOP_INPUT),
      stdout: stdout as unknown as NodeJS.WritableStream,
      event: "Stop",
      connect: () => {
        // An unconnected socket: nothing is dialed and nothing answers, so only the
        // guard can end this wait — and what it must do is destroy the handle.
        const socket = new net.Socket();
        held = socket;
        return trackSocket(socket);
      },
      watchdog: { isParentAlive: () => false, pollMs: 10 },
    }));
    assert.deepEqual(outcome, { status: "unavailable" });
    assert.equal(stdout.text, "");
    assert.ok(held, "the relay dialed the injected endpoint");
    assert.equal(held!.destroyed, true, "the held connection is destroyed, so the broker aborts the review");
  } finally {
    guard.done();
  }
});

test("a provider parent that dies during the stdin read is still detected, because the probe predates the await", async () => {
  const broker = await makeBroker();
  // A FAST responder: the broker answers the moment a request arrives, so the
  // only way this relay avoids writing a decision for an orphaned hook is to
  // probe its parent at the boundary where it would have sent or accepted one.
  const recorded = recordingReview();
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  const realPpid = process.ppid;
  // Restored exactly as found. Faked through an accessor: on Node 22 a data
  // property redefined over `process.ppid` keeps reading the real value, so a
  // value fake would never reach the relay's probe there.
  const originalPpid = Object.getOwnPropertyDescriptor(process, "ppid");
  // Pid 1 always exists and this process may not signal it, so the probe's
  // `process.kill(ppid, 0)` answer for it is EPERM — ALIVE. The only thing that
  // can prove the orphaning here is the captured initial ppid itself, which is
  // exactly what must have been captured before the stdin await.
  const replacementPpid = 1;
  let faked = false;
  const fakePpid = (value: number): void => {
    Object.defineProperty(process, "ppid", { get: () => value, configurable: true, enumerable: true });
    faked = true;
  };
  const guard = hangGuard("relay probe captured before the stdin read");
  try {
    fakePpid(realPpid);
    // A stdin document that arrives late: the original parent dies while the read
    // is still outstanding, and this child is reparented.
    const stdin = new Readable({ read(): void { /* pushed by hand */ } });
    const stdout = new CapturingStdout();
    const running = runNativeReviewHookRelay({
      env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: encodeNativeReviewBootstrapEnv(registration.bootstrap) },
      stdin,
      stdout: stdout as unknown as NodeJS.WritableStream,
      event: "Stop",
      // The interval is OFF and the broker answers as fast as it can: nothing but
      // a probe at a socket boundary can outrun this reply, so the test cannot
      // pass merely because a poll happened to beat a held response.
      watchdog: { pollMs: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    fakePpid(replacementPpid);
    stdin.push(Buffer.from(`${JSON.stringify(STOP_INPUT)}\n`, "utf8"));
    stdin.push(null);
    const outcome = await guard.watch(running);
    assert.deepEqual(outcome, { status: "unavailable" }, "the orphaned relay abandoned the wait instead of taking a verdict");
    assert.equal(stdout.text, "", "an orphaned relay leaves no notice behind");
    assert.deepEqual(recorded.requests, [], "an orphaned relay never asks the host to start a review");
    assert.equal(recorded.aborts, 0, "no review was started, so there was nothing to abort");
    await waitFor(() => reviewLaneCounts(broker).heldConnections === 0, "the abandoned connection is gone");
  } finally {
    guard.done();
    if (faked) {
      Object.defineProperty(process, "ppid", originalPpid
        ?? { value: realPpid, configurable: true, writable: true, enumerable: true });
    }
    registration.release();
  }
});

test("the relay dials a Windows named-pipe bootstrap address unchanged", async () => {
  const dialed: string[] = [];
  const stdout = new CapturingStdout();
  const outcome = await runNativeReviewHookRelay({
    env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: encodeNativeReviewBootstrapEnv(WINDOWS_PIPE_BOOTSTRAP) },
    stdin: relayStdin(STOP_INPUT),
    stdout: stdout as unknown as NodeJS.WritableStream,
    event: "Stop",
    connect: (socketPath) => {
      dialed.push(socketPath);
      const socket = new net.Socket();
      setImmediate(() => {
        socket.emit("connect");
        socket.emit("data", Buffer.from(`${JSON.stringify({ version: 1, type: "native_review_response", action: "allow" })}\n`, "utf8"));
      });
      return trackSocket(socket);
    },
  });
  assert.deepEqual(dialed, [WINDOWS_PIPE_BOOTSTRAP.socketPath], "the pipe address is dialed exactly as issued");
  assert.equal(outcome.status, "allow");
  assert.equal(stdout.text, "");
});

test("a real Windows named-pipe broker holds and answers one review request", {
  skip: process.platform !== "win32",
}, async () => {
  const broker = await makeBroker();
  assert.match(broker.socketPath, WINDOWS_PIPE_ADDRESS);
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "block", reason: "Windows pipe review", userMessage: "blocked on Windows" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);
  assert.match(registration.bootstrap.socketPath, WINDOWS_PIPE_ADDRESS);
  assert.equal(isNativeReviewLocalPipeAddress(registration.bootstrap.socketPath), true);

  const { outcome, stdout } = await runRelay(registration.bootstrap, "Stop", relayStdin(STOP_INPUT));
  assert.equal(outcome.status, "block");
  assert.deepEqual(JSON.parse(stdout.text), {
    decision: "block", reason: "Windows pipe review", systemMessage: "blocked on Windows",
  });
  assert.equal(recorded.requests.length, 1);
});

// ---------------------------------------------------------------------------
// Genuine compiled entrypoint
// ---------------------------------------------------------------------------

interface ChildOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The same socket-path shortening the existing native relay tests use for a
 * genuine child: only the bind/connect ADDRESS is shortened relative to the
 * unchanged cwd, and a real Windows named-pipe address is never rewritten.
 */
function writeSocketPathPreload(): string {
  const directory = makeSocketRoot();
  const file = path.join(directory, "socket-path-shim.cjs");
  fs.writeFileSync(file, `
const net = require("node:net");
const path = require("node:path");
const original = net.Socket.prototype.connect;
function shorten(address) {
  if (typeof address !== "string" || !path.isAbsolute(address) || Buffer.byteLength(address, "utf8") <= 100) return address;
  const relative = path.relative(process.cwd(), address);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep)) return address;
  return "./" + relative;
}
net.Socket.prototype.connect = function (...args) {
  if (Array.isArray(args[0]) && args[0].length > 0) {
    const first = args[0][0];
    if (typeof first === "string") args[0][0] = { path: shorten(first) };
    else if (first && typeof first === "object" && typeof first.path === "string") args[0][0] = { ...first, path: shorten(first.path) };
  } else if (typeof args[0] === "string") args[0] = { path: shorten(args[0]) };
  else if (args[0] && typeof args[0] === "object" && typeof args[0].path === "string") args[0] = { ...args[0], path: shorten(args[0].path) };
  return original.apply(this, args);
};
`, { mode: 0o600 });
  return file;
}

function runCompiledEntrypoint(args: string[], env: NodeJS.ProcessEnv, stdin: Buffer): Promise<ChildOutcome> {
  const helper = path.join(__dirname, "..", "src", "session-host", "native-review-hook-relay.js");
  return new Promise<ChildOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

test("the genuine compiled entrypoint exits zero and prints the exact decision line", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "block", reason: "child verdict" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const childEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    NODE_OPTIONS: `--require=${writeSocketPathPreload()}`,
    [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap),
  };

  const blocked = await runCompiledEntrypoint(["Stop"], childEnvironment, Buffer.from(JSON.stringify(STOP_INPUT), "utf8"));
  assert.equal(blocked.code, 0, "a review relay never exits non-zero");
  assert.equal(blocked.stdout, `${JSON.stringify({ decision: "block", reason: "child verdict" })}\n`);
  assert.equal(blocked.stderr, "", "no secret or provider diagnostic is written");
  await waitFor(() => recorded.requests.length === 1, "entrypoint request");
  assert.equal(JSON.stringify(recorded.requests[0]).includes("SECRET PROMPT"), false);

  const unconfigured = await runCompiledEntrypoint(["Stop"], { PATH: process.env.PATH ?? "" }, Buffer.from(JSON.stringify(STOP_INPUT), "utf8"));
  assert.equal(unconfigured.code, 0);
  assert.deepEqual(JSON.parse(unconfigured.stdout), {
    systemMessage: nativeReviewUnavailableMessage("unconfigured"),
  });
  assert.equal(unconfigured.stderr, "");

  const wrongEvent = await runCompiledEntrypoint(["PreToolUse"], childEnvironment, Buffer.from(JSON.stringify(STOP_INPUT), "utf8"));
  assert.equal(wrongEvent.code, 0);
  assert.deepEqual(JSON.parse(wrongEvent.stdout), {
    systemMessage: nativeReviewUnavailableMessage("event-mismatch"),
  });

  const malformed = await runCompiledEntrypoint(["Stop"], childEnvironment, Buffer.from("{not-json", "utf8"));
  assert.equal(malformed.code, 0);
  assert.deepEqual(JSON.parse(malformed.stdout), {
    systemMessage: nativeReviewUnavailableMessage("input-malformed"),
  });

  // No token or bootstrap text is ever printed by the child.
  for (const output of [blocked.stdout, unconfigured.stdout, wrongEvent.stdout, malformed.stdout]) {
    assert.ok(!output.includes(registration.bootstrap.token), "the token is never printed");
  }
});

test("a large decision survives a slow stdout reader", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  // 240 000 quote characters is 240 KB of UTF-8 — a legal reason — and JSON
  // escaping turns each into two bytes, so the wire line is ~480 KB: far past any
  // OS pipe buffer, which makes the child's single stdout write genuinely
  // backpressured.
  const reason = '"'.repeat(240_000);
  const expectedLine = `${JSON.stringify({ decision: "block", reason })}\n`;
  assert.ok(Buffer.byteLength(expectedLine, "utf8") > 400 * 1024);
  recorded.respond = async () => ({ action: "block", reason });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const helper = path.join(__dirname, "..", "src", "session-host", "native-review-hook-relay.js");
  const child = spawn(process.execPath, [helper, "Stop"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: `--require=${writeSocketPathPreload()}`,
      [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  // Registered BEFORE the artificial delay, and `close` rather than `exit`: the
  // child can exit while the parent still has buffered stdio to consume, so
  // waiting on `exit` would make this assertion depend on drain timing.
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => resolve(null));
  });
  child.stdin!.end(Buffer.from(JSON.stringify(STOP_INPUT), "utf8"));

  // The provider deliberately does not start reading for 1.5 seconds. Anything
  // that gave up on the drain and exited on a timer would have truncated the
  // line by now; only a real drain can deliver all of it.
  await settle(1_500);
  assert.equal(child.exitCode, null, "the relay stays alive while stdout is still backpressured");
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });

  const code = await closed;
  children.delete(child);
  assert.equal(code, 0, `a slow reader must not change the exit code (stderr: ${stderr.slice(0, 200)})`);
  assert.equal(stdout.length, expectedLine.length, "the ENTIRE decision line arrives, untruncated");
  assert.deepEqual(JSON.parse(stdout), { decision: "block", reason });
  assert.equal(stderr, "");
  assert.equal(recorded.requests.length, 1);
  registration.release();
});

test("stdout's asynchronous error guard is installed before the first write and swallows EPIPE", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "allow", userMessage: "a notice" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  const written: string[] = [];
  let errorListenersAtFirstWrite = -1;
  const stream = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      if (errorListenersAtFirstWrite === -1) errorListenersAtFirstWrite = stream.listenerCount("error");
      written.push(String(chunk));
      callback();
    },
  });

  const relay = runNativeReviewHookRelay({
    env: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap) },
    stdin: relayStdin(STOP_INPUT),
    stdout: stream as unknown as NodeJS.WritableStream,
    event: "Stop",
  });
  await waitFor(() => written.length > 0, "the relay wrote its provider line");

  // The guard exists at the moment the FIRST write is performed, so a failure
  // raised by that very write already has a listener.
  assert.equal(errorListenersAtFirstWrite, 1, "the error guard is installed before the first write");

  // A closed provider pipe surfaces as an asynchronous 'error' event. With no
  // listener, emitting it throws — that is the uncaught crash this relay must
  // not produce.
  let threw = false;
  try {
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "an asynchronous stdout EPIPE is never an unhandled stream error");

  const outcome = await relay;
  assert.deepEqual(outcome, { status: "allow" });
  assert.deepEqual(JSON.parse(written.join("")), { systemMessage: "a notice" });
  assert.equal(recorded.requests.length, 1);
  registration.release();
});

test("a provider that stops reading the relay's stdout still gets exit code zero", async () => {
  const broker = await makeBroker();
  const recorded = recordingReview();
  recorded.respond = async () => ({ action: "block", reason: "closed stdout must not crash the relay" });
  const registration = broker.registerNativeReviewSource(INSTANCE_REVIEW, "claude", recorded.handlers);

  // The real entrypoint, spawned normally, then its stdout READ end is destroyed
  // in the parent: every write the child makes afterwards fails with EPIPE,
  // asynchronously, exactly as a provider that stopped reading its hook output.
  const helper = path.join(__dirname, "..", "src", "session-host", "native-review-hook-relay.js");
  const child = spawn(process.execPath, [helper, "Stop"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: `--require=${writeSocketPathPreload()}`,
      [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stderr.resume();
  child.stdout.destroy();
  child.stdin!.end(Buffer.from(JSON.stringify(STOP_INPUT), "utf8"));

  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", () => resolve(null));
  });
  children.delete(child);
  assert.equal(code, 0, `a closed stdout must not produce a non-zero exit (stderr: ${stderr})`);
  assert.equal(stderr, "", "a closed stdout is not reported as a crash diagnostic");
  assert.doesNotMatch(stderr, /EPIPE|ERR_STREAM|unhandled|Unhandled/i);
  await waitFor(() => recorded.requests.length === 1, "the request was still reviewed");
});
