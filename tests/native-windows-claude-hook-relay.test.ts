/**
 * Native Windows Claude root hook relay (#682), portable tests.
 *
 * Drives the marker parser, the shared per-run key derivation, the bounded
 * sibling branch, and the real native hook relay entry against in-memory fake
 * sockets only (no filesystem, no real pipe, no provider, no credentials). All
 * tokens, keys, run ids, endpoints, and records are inert test values. This is
 * NOT Windows evidence: the platform is an explicit seam.
 *
 * Distinction pinned throughout: a `handed-off` branch result is RECEIPT only
 * (the record write completed locally after the peer proved the per-run key).
 * It is never acceptance, ownership, or a binding, and it is never reflected
 * into the ordinary broker relay outcome.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  EXECUTOR_TOOL_CATALOG_ENV,
  RUNTIME_ROLE_ENV,
  rejectAndStripInheritedHostCapabilities,
  snapshotNativeEnvironment,
} from "../src/session-host/launch";
import { NATIVE_HOOK_TIMEOUT_SECONDS } from "../src/session-host/native-hook-launch-prep";
import {
  NATIVE_HOOK_BOOTSTRAP_ENV,
  type NativeHookBootstrap,
  type NativeHookEventMetadata,
} from "../src/session-host/native-hook-protocol";
import {
  NATIVE_HOOK_ACK_TIMEOUT_MS,
  NATIVE_HOOK_CONNECT_TIMEOUT_MS,
  NATIVE_HOOK_STDIN_TIMEOUT_MS,
  runNativeHookRelay,
  type NativeHookRelayOutcome,
} from "../src/session-host/native-hook-relay";
import {
  WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS,
  WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT,
  WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES,
  type WindowsClaudeHookForwardSeams,
} from "../src/session-host/native-windows-claude-hook-forwarder";
import {
  WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS,
  WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN,
} from "../src/session-host/native-windows-claude-hook-receiver";
import * as relayModule from "../src/session-host/native-windows-claude-hook-relay";
import {
  WINDOWS_CLAUDE_HOOK_KEY_CONTEXT,
  WINDOWS_CLAUDE_HOOK_MARKER_ENV,
  WINDOWS_CLAUDE_HOOK_MARKER_FIELDS,
  WINDOWS_CLAUDE_HOOK_MARKER_MAX_CHARS,
  WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS,
  WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS,
  deriveWindowsClaudeHookProofKey,
  parseWindowsClaudeHookMarker,
  relayWindowsClaudeRootSessionStart,
  type WindowsClaudeHookRelayResult,
} from "../src/session-host/native-windows-claude-hook-relay";

const PROJECT_ROOT = join(__dirname, "..", "..");
const MODULE_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-hook-relay.ts");

/* --------------------------------------------------------------- fixtures */

const INSTANCE = "22222222-2222-4222-8222-222222222222";
const GENERATION = "abcdef33-3333-4333-8333-333333333333";
const BOOTSTRAP_TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const HOOK_PIPE = "\\\\.\\pipe\\prg682-hook-0123456789abcdef0123456789abcdef";
const RUN_ID = "run-7.test:a_b";
const SESSION_ID = "1111abcd-1111-4111-8111-11111111eeee";
const INBOX_ENDPOINT = "\\\\.\\pipe\\LOCAL\\claude-inbox.seg_1";
const INBOX_TOKEN = "inert+INBOX/token=_.~-0123456789";

const BOOTSTRAP: NativeHookBootstrap = Object.freeze({
  version: 1,
  socketPath: "\\\\.\\pipe\\prg-st-00112233445566778899aabbccddeeff",
  generation: GENERATION,
  instanceId: INSTANCE,
  backend: "claude",
  token: BOOTSTRAP_TOKEN,
});

function markerJson(fields: Partial<Record<"pipe" | "runId" | "instanceId" | "generation", unknown>> = {}): string {
  return JSON.stringify({ pipe: HOOK_PIPE, runId: RUN_ID, instanceId: INSTANCE, generation: GENERATION, ...fields });
}

const MARKER = markerJson();

/** The test's own independent statement of the derivation (not the module's code). */
function expectedKey(token = BOOTSTRAP_TOKEN, instanceId = INSTANCE, generation = GENERATION, runId = RUN_ID, pipe = HOOK_PIPE): string {
  return createHmac("sha256", Buffer.from(token, "ascii"))
    .update(JSON.stringify(["prg682-windows-claude-hook-key-v1", instanceId, generation, runId, pipe]), "ascii")
    .digest("hex");
}

function proofFor(key: string, nonce: string, runId = RUN_ID): string {
  return createHmac("sha256", Buffer.from(key, "ascii")).update(`prg682-hook-v1|${runId}|${nonce}`, "ascii").digest("hex");
}

function expectedRecord(): string {
  return `{"v":1,"runId":"${RUN_ID}","event":"SessionStart","sessionId":"${SESSION_ID}",`
    + `"socket":"\\\\\\\\.\\\\pipe\\\\LOCAL\\\\claude-inbox.seg_1","token":"${INBOX_TOKEN}"}\n`;
}

const ROOT_SESSION_START: NativeHookEventMetadata = Object.freeze({ hook_event_name: "SessionStart", session_id: SESSION_ID });

function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify(BOOTSTRAP),
    [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: MARKER,
    CLAUDE_CODE_MESSAGING_SOCKET: INBOX_ENDPOINT,
    CLAUDE_CODE_MESSAGING_TOKEN: INBOX_TOKEN,
    ...extra,
  };
}

/** In-memory hook peer: answers HELLO1 according to `mode` and records every byte it receives. */
class FakeHookPeer extends EventEmitter {
  readonly writes: Buffer[] = [];
  ended = 0;
  destroyed = 0;
  nonce = "";

  constructor(private readonly respond: (nonce: string, peer: FakeHookPeer) => void) {
    super();
    setImmediate(() => this.emit("connect"));
  }

  write(data: string | Uint8Array, callback: (error?: Error | null) => void): boolean {
    const bytes = Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    this.writes.push(bytes);
    const text = bytes.toString("latin1");
    if (this.writes.length === 1 && /^HELLO1 [0-9a-f]{32}\n$/u.test(text)) {
      this.nonce = text.slice(7, 39);
      setImmediate(() => this.respond(this.nonce, this));
    }
    queueMicrotask(() => callback(null));
    return true;
  }

  end(): this {
    this.ended += 1;
    return this;
  }

  destroy(): this {
    this.destroyed += 1;
    return this;
  }

  proof(hex: string): void {
    this.emit("data", Buffer.from(`PROOF ${hex}\n`, "latin1"));
  }
}

function correctPeer(key = expectedKey()): (nonce: string, peer: FakeHookPeer) => void {
  return (nonce, peer) => peer.proof(proofFor(key, nonce));
}

interface HookHarness {
  readonly seams: WindowsClaudeHookForwardSeams;
  readonly peers: FakeHookPeer[];
  readonly connectCalls: string[];
}

function hookHarness(respond: (nonce: string, peer: FakeHookPeer) => void = correctPeer(), extra: Partial<WindowsClaudeHookForwardSeams> = {}): HookHarness {
  const peers: FakeHookPeer[] = [];
  const connectCalls: string[] = [];
  return {
    peers,
    connectCalls,
    seams: {
      connect: (pipe) => {
        connectCalls.push(pipe);
        const peer = new FakeHookPeer(respond);
        peers.push(peer);
        return peer;
      },
      ...extra,
    },
  };
}

/** In-memory broker socket: records the one frame line and answers with the fixed ACK. */
class FakeBrokerSocket extends EventEmitter {
  readonly written: string[] = [];
  destroyed = false;

  constructor(private readonly reply: string | undefined) {
    super();
    setImmediate(() => this.emit("connect"));
  }

  setNoDelay(): this {
    return this;
  }

  write(chunk: unknown): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    const reply = this.reply;
    if (reply !== undefined) setImmediate(() => this.emit("data", Buffer.from(reply, "utf8")));
    return true;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      setImmediate(() => this.emit("close"));
    }
    return this;
  }
}

const ACK_ACCEPTED = '{"version":1,"type":"native_hook_ack","accepted":true}\n';
const ACK_REJECTED = '{"version":1,"type":"native_hook_ack","accepted":false}\n';

interface RelayRun {
  readonly outcome: NativeHookRelayOutcome;
  readonly brokerLines: string[];
  readonly brokerPaths: string[];
  readonly branch: WindowsClaudeHookRelayResult[];
  readonly hook: HookHarness;
}

async function runRelay(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: unknown;
  readonly platform?: NodeJS.Platform;
  readonly ack?: string | undefined;
  readonly respond?: (nonce: string, peer: FakeHookPeer) => void;
  readonly observeThrows?: boolean;
} = {}): Promise<RelayRun> {
  const brokerLines: string[] = [];
  const brokerPaths: string[] = [];
  const branch: WindowsClaudeHookRelayResult[] = [];
  const hook = hookHarness(options.respond);
  const ack = "ack" in options ? options.ack : ACK_ACCEPTED;
  const outcome = await runNativeHookRelay({
    env: options.env ?? hookEnv(),
    stdin: Readable.from([Buffer.from(JSON.stringify(options.stdin ?? {
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      source: "startup",
    }), "utf8")]),
    connect: (socketPath) => {
      brokerPaths.push(socketPath);
      const socket = new FakeBrokerSocket(ack);
      const write = socket.write.bind(socket);
      socket.write = (chunk: unknown) => {
        brokerLines.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        return write(chunk);
      };
      return socket as unknown as Socket;
    },
    timeouts: { stdinMs: 1000, connectMs: 1000, ackMs: 1000 },
    windowsClaudeHook: {
      platform: options.platform ?? "win32",
      seams: hook.seams,
      observe: (result) => {
        branch.push(result);
        if (options.observeThrows) throw new Error("observer failure");
      },
    },
  });
  return { outcome, brokerLines, brokerPaths, branch, hook };
}

function sentBytes(peer: FakeHookPeer): string {
  return Buffer.concat(peer.writes).toString("latin1");
}

/* ------------------------------------------------------------------ marker */

test("the marker parser admits only the one canonical identifiers-only shape", () => {
  assert.deepEqual(WINDOWS_CLAUDE_HOOK_MARKER_FIELDS, ["pipe", "runId", "instanceId", "generation"]);
  assert.equal(WINDOWS_CLAUDE_HOOK_MARKER_ENV, "PI_REVIEW_GATE_WINDOWS_CLAUDE_HOOK");
  const parsed = parseWindowsClaudeHookMarker(MARKER);
  assert.deepEqual(parsed, { pipe: HOOK_PIPE, runId: RUN_ID, instanceId: INSTANCE, generation: GENERATION });
  assert.ok(Object.isFrozen(parsed));
  assert.equal(MARKER.includes(BOOTSTRAP_TOKEN), false, "the marker carries no bootstrap token");

  const bad: unknown[] = [
    undefined,
    null,
    42,
    {},
    [HOOK_PIPE, RUN_ID, INSTANCE, GENERATION],
    "",
    `${MARKER}\n`,
    ` ${MARKER}`,
    MARKER.replace(",", ", "),
    JSON.stringify({ runId: RUN_ID, pipe: HOOK_PIPE, instanceId: INSTANCE, generation: GENERATION }),
    JSON.stringify({ pipe: HOOK_PIPE, runId: RUN_ID, instanceId: INSTANCE }),
    JSON.stringify({ pipe: HOOK_PIPE, runId: RUN_ID, instanceId: INSTANCE, generation: GENERATION, key: expectedKey() }),
    JSON.stringify({ pipe: HOOK_PIPE, runId: RUN_ID, instanceId: INSTANCE, generation: GENERATION, token: BOOTSTRAP_TOKEN }),
    MARKER.replace('{"pipe"', '{"pipe":"x","pipe"'),
    MARKER.replace('"runId"', '"run\\u0049d"'),
    MARKER.replace(RUN_ID, "run\\u002d7"),
    `{"__proto__":{"pipe":"x"},${MARKER.slice(1)}`,
    markerJson({ pipe: HOOK_PIPE.toUpperCase() }),
    markerJson({ pipe: HOOK_PIPE.replace("abcdef", "ABCDEF") }),
    markerJson({ pipe: `${HOOK_PIPE}0` }),
    markerJson({ pipe: HOOK_PIPE.slice(0, -1) }),
    markerJson({ pipe: "\\\\.\\pipe\\LOCAL\\prg682-hook-0123456789abcdef0123456789abcdef" }),
    markerJson({ pipe: "//./pipe/prg682-hook-0123456789abcdef0123456789abcdef" }),
    markerJson({ runId: ".leading-dot" }),
    markerJson({ runId: "r".repeat(129) }),
    markerJson({ runId: "run id" }),
    markerJson({ runId: "run\u00e9" }),
    markerJson({ runId: 7 }),
    markerJson({ instanceId: "not-hex-zz" }),
    markerJson({ generation: "" }),
    markerJson({ generation: "a".repeat(129) }),
    markerJson({ instanceId: "\u0661" }),
    `{"pipe":"${"x".repeat(WINDOWS_CLAUDE_HOOK_MARKER_MAX_CHARS)}"}`,
    MARKER.replace(RUN_ID, `${RUN_ID}\u0000`),
  ];
  for (const value of bad) assert.equal(parseWindowsClaudeHookMarker(value), undefined, JSON.stringify(value));
  // The longest valid marker fits the bound.
  const longest = markerJson({ runId: `r${"x".repeat(127)}`, instanceId: "a".repeat(128), generation: "b".repeat(128) });
  assert.ok(longest.length <= WINDOWS_CLAUDE_HOOK_MARKER_MAX_CHARS);
  assert.notEqual(parseWindowsClaudeHookMarker(longest), undefined);
});

/* --------------------------------------------------------------------- key */

test("the per-run key is derivable only with the exact bootstrap token and tuple, domain-separated", () => {
  assert.equal(WINDOWS_CLAUDE_HOOK_KEY_CONTEXT, "prg682-windows-claude-hook-key-v1");
  assert.notEqual(WINDOWS_CLAUDE_HOOK_KEY_CONTEXT, WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT);
  const input = { token: BOOTSTRAP_TOKEN, instanceId: INSTANCE, generation: GENERATION, runId: RUN_ID, pipe: HOOK_PIPE };
  const key = deriveWindowsClaudeHookProofKey(input);
  assert.equal(key, expectedKey());
  assert.match(key ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(deriveWindowsClaudeHookProofKey({ ...input }), key, "pure and deterministic");

  // Every tuple element and the exact token text (ASCII, case preserved) change the key.
  const variants = [
    { ...input, token: BOOTSTRAP_TOKEN.toUpperCase() },
    { ...input, token: `1${BOOTSTRAP_TOKEN.slice(1)}` },
    { ...input, instanceId: GENERATION },
    { ...input, generation: INSTANCE },
    { ...input, runId: `${RUN_ID}x` },
    { ...input, pipe: HOOK_PIPE.replace("0123", "3210") },
  ];
  const keys = new Set(variants.map((variant) => deriveWindowsClaudeHookProofKey(variant)));
  assert.equal(keys.size, variants.length);
  assert.ok(!keys.has(key) && !keys.has(undefined));
  // Not the raw token, not a proof-context HMAC, not a reordered tuple.
  assert.notEqual(key, BOOTSTRAP_TOKEN);
  assert.notEqual(key, createHmac("sha256", BOOTSTRAP_TOKEN).update(`${WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT}|${RUN_ID}`).digest("hex"));
  assert.notEqual(key, expectedKey(BOOTSTRAP_TOKEN, GENERATION, INSTANCE));

  for (const broken of [
    undefined,
    null,
    { ...input, token: BOOTSTRAP_TOKEN.slice(1) },
    { ...input, token: `${BOOTSTRAP_TOKEN}0` },
    { ...input, token: `g${BOOTSTRAP_TOKEN.slice(1)}` },
    { ...input, token: 7 },
    { ...input, pipe: "\\\\.\\pipe\\LOCAL\\x" },
    { ...input, runId: "" },
    { ...input, instanceId: "zz" },
    { ...input, generation: undefined },
  ]) {
    assert.equal(deriveWindowsClaudeHookProofKey(broken as never), undefined, JSON.stringify(broken));
  }
});

/* ------------------------------------------------------------ eligibility */

test("every ineligible combination returns a closed reason before any connection", async () => {
  const cases: Array<{
    readonly name: string;
    readonly reason: (typeof WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS)[number];
    readonly bootstrap?: NativeHookBootstrap;
    readonly metadata?: NativeHookEventMetadata;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  }> = [
    { name: "linux", reason: "not-windows", platform: "linux" },
    { name: "darwin", reason: "not-windows", platform: "darwin" },
    { name: "codex", reason: "not-claude", bootstrap: { ...BOOTSTRAP, backend: "codex" } },
    { name: "no marker", reason: "no-marker", env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: undefined }) },
    { name: "lowercase marker name is not the marker", reason: "no-marker", env: {
      ...hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: undefined }),
      pi_review_gate_windows_claude_hook: MARKER,
    } },
    { name: "empty marker", reason: "marker-invalid", env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: "" }) },
    { name: "malformed marker", reason: "marker-invalid", env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: "{not json" }) },
    { name: "marker with key", reason: "marker-invalid", env: hookEnv({
      [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: JSON.stringify({ pipe: HOOK_PIPE, runId: RUN_ID, instanceId: INSTANCE, generation: GENERATION, key: expectedKey() }),
    }) },
    { name: "instance mismatch", reason: "marker-mismatch", env: hookEnv({
      [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: markerJson({ instanceId: "44444444-4444-4444-8444-444444444444" }),
    }) },
    { name: "generation mismatch", reason: "marker-mismatch", env: hookEnv({
      [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: markerJson({ generation: INSTANCE }),
    }) },
    { name: "generation case differs", reason: "marker-mismatch", env: hookEnv({
      [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: markerJson({ generation: GENERATION.toUpperCase() }),
    }) },
    { name: "subagent session start", reason: "not-root-session-start", metadata: { ...ROOT_SESSION_START, agent_id: "agent-1" } },
    { name: "other event", reason: "not-root-session-start", metadata: { hook_event_name: "Stop", session_id: SESSION_ID } },
    { name: "missing session", reason: "session-invalid", metadata: { hook_event_name: "SessionStart" } },
    { name: "uppercase session", reason: "session-invalid", metadata: { hook_event_name: "SessionStart", session_id: SESSION_ID.toUpperCase() } },
    { name: "posix endpoint", reason: "endpoint-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude.sock" }) },
    { name: "global endpoint", reason: "endpoint-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\Global\\x" }) },
    { name: "dot endpoint", reason: "endpoint-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\LOCAL\\x." }) },
    { name: "LF endpoint", reason: "endpoint-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_SOCKET: `${INBOX_ENDPOINT}\n` }) },
    { name: "missing endpoint", reason: "endpoint-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_SOCKET: undefined }) },
    { name: "short token", reason: "token-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_TOKEN: "abc" }) },
    { name: "quote token", reason: "token-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_TOKEN: 'abcdefgh"' }) },
    { name: "space token", reason: "token-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_TOKEN: "abcd efgh" }) },
    { name: "long token", reason: "token-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_TOKEN: "a".repeat(4097) }) },
    { name: "missing token", reason: "token-invalid", env: hookEnv({ CLAUDE_CODE_MESSAGING_TOKEN: undefined }) },
  ];
  for (const entry of cases) {
    const hook = hookHarness();
    const result = await relayWindowsClaudeRootSessionStart(
      entry.bootstrap ?? BOOTSTRAP,
      entry.metadata ?? ROOT_SESSION_START,
      entry.env ?? hookEnv(),
      { platform: entry.platform ?? "win32", seams: hook.seams },
    );
    assert.deepEqual(result, { disposition: "ineligible", reason: entry.reason }, entry.name);
    assert.deepEqual(hook.connectCalls, [], `${entry.name}: no connection`);
    assert.ok(WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS.includes(entry.reason));
  }
});

/* -------------------------------------------------- frame and send gating */

test("an eligible root SessionStart sends the receiver's exact v1 record only after the peer proves the derived key", async () => {
  let recordSeen = "";
  const hook = hookHarness((nonce, peer) => {
    assert.equal(peer.writes.length, 1, "nothing but HELLO1 before the proof");
    peer.proof(proofFor(expectedKey(), nonce));
  });
  const result = await relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: hook.seams });
  assert.deepEqual(result, { disposition: "handed-off", reason: "write-completed" }, "receipt only: the write completed locally");
  assert.deepEqual(hook.connectCalls, [HOOK_PIPE], "exactly one connection to the marker's exact pipe");
  const [peer] = hook.peers;
  assert.equal(peer.writes.length, 2);
  assert.match(peer.writes[0].toString("latin1"), /^HELLO1 [0-9a-f]{32}\n$/u);
  recordSeen = peer.writes[1].toString("latin1");
  assert.equal(recordSeen, expectedRecord());
  assert.ok(Buffer.byteLength(recordSeen) <= WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES);
  // The receiver's own anchored candidate grammar (.NET `\z` is JS end-of-input without `m`).
  const pattern = new RegExp(WINDOWS_CLAUDE_HOOK_CANDIDATE_PS_PATTERN.replace(/\\z$/u, "$"), "u");
  const match = pattern.exec(recordSeen.slice(0, -1));
  assert.ok(match, "the record matches the receiver's candidate pattern");
  assert.equal(match[1], RUN_ID);
  assert.equal(match[2], SESSION_ID);
  assert.equal(`\\\\.\\pipe\\LOCAL\\${match[3]}`, INBOX_ENDPOINT);
  assert.equal(match[4], INBOX_TOKEN);
  assert.deepEqual(Object.keys(JSON.parse(recordSeen) as object), [...WINDOWS_CLAUDE_HOOK_CANDIDATE_FIELDS]);
  // Neither the key, the bootstrap token, nor the marker ever crosses the hook pipe.
  const sent = sentBytes(peer);
  for (const secret of [expectedKey(), BOOTSTRAP_TOKEN, MARKER, INSTANCE, GENERATION]) assert.equal(sent.includes(secret), false);
  assert.equal(peer.ended, 1);
  // The longest admitted token still fits the shared record bound.
  const longest = hookHarness();
  const longResult = await relayWindowsClaudeRootSessionStart(
    BOOTSTRAP,
    ROOT_SESSION_START,
    hookEnv({ CLAUDE_CODE_MESSAGING_TOKEN: "t".repeat(4096), CLAUDE_CODE_MESSAGING_SOCKET: `\\\\.\\pipe\\LOCAL\\${"s".repeat(200)}` }),
    { platform: "win32", seams: longest.seams },
  );
  assert.equal(longResult.disposition, "handed-off");
});

test("unproved, mismatched, cross-run, and absent proofs never materialize or send the record", async () => {
  const wrongProofs: Array<[string, (nonce: string, peer: FakeHookPeer) => void, string]> = [
    ["proof keyed by the raw bootstrap token", (nonce, peer) => peer.proof(proofFor(BOOTSTRAP_TOKEN, nonce)), "proof-mismatch"],
    ["proof keyed by another run's key", (nonce, peer) => peer.proof(proofFor(expectedKey(BOOTSTRAP_TOKEN, INSTANCE, GENERATION, "other-run"), nonce)), "proof-mismatch"],
    ["proof over another run id", (nonce, peer) => peer.proof(proofFor(expectedKey(), nonce, "other-run")), "proof-mismatch"],
    ["proof for another nonce", (_nonce, peer) => peer.proof(proofFor(expectedKey(), "0".repeat(32))), "proof-mismatch"],
    ["uppercase proof", (nonce, peer) => peer.proof(proofFor(expectedKey(), nonce).toUpperCase()), "proof-malformed"],
    ["peer closes without proof", (_nonce, peer) => peer.emit("close"), "proof-absent"],
  ];
  for (const [name, respond, reason] of wrongProofs) {
    const hook = hookHarness(respond);
    const result = await relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: hook.seams });
    assert.deepEqual(result, { disposition: "not-sent", reason }, name);
    assert.equal(hook.peers[0].writes.length, 1, `${name}: only HELLO1 was written`);
    assert.equal(sentBytes(hook.peers[0]).includes(INBOX_TOKEN), false, `${name}: no token byte left`);
  }
});

test("the branch budget aborts within the hook timeout and an expired proof never sends", async () => {
  // Timing contract: stdin bound, then the concurrent broker exchange and branch, inside the hook timeout.
  assert.equal(WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS, 3000);
  assert.ok(WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS < WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS);
  assert.ok(
    NATIVE_HOOK_STDIN_TIMEOUT_MS + Math.max(NATIVE_HOOK_CONNECT_TIMEOUT_MS + NATIVE_HOOK_ACK_TIMEOUT_MS, WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS)
      < NATIVE_HOOK_TIMEOUT_SECONDS * 1000,
  );

  // 1. A silent peer: the branch's own budget timer (exactly 3000 ms) cancels the attempt.
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const timerSeams = {
    setTimer: (callback: () => void, ms: number) => {
      const entry = { callback, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  const silent = hookHarness(() => {}, timerSeams);
  const pending = relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: silent.seams });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.map((entry) => entry.ms), [WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS, WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS]);
  timers[0].callback();
  assert.deepEqual(await pending, { disposition: "not-sent", reason: "cancelled" });
  assert.equal(silent.peers[0].writes.length, 1, "only HELLO1");
  assert.ok(timers[1].cleared, "the client's own timer was released");
  assert.ok(silent.peers[0].destroyed >= 1, "the connection was torn down");

  // 2. A late proof after the budget fired is never answered with a record.
  const lateTimers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const late = hookHarness((nonce, peer) => {
    lateTimers[0].callback();
    peer.proof(proofFor(expectedKey(), nonce));
  }, {
    setTimer: (callback, ms) => {
      const entry = { callback, ms, cleared: false };
      lateTimers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const lateResult = await relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: late.seams });
  assert.deepEqual(lateResult, { disposition: "not-sent", reason: "cancelled" });
  assert.equal(late.peers[0].writes.length, 1);

  // 3. A valid proof that completes after the branch deadline (clock seam) fails the currency fence.
  let clock = 0;
  const expired = hookHarness((nonce, peer) => {
    clock = WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS;
    peer.proof(proofFor(expectedKey(), nonce));
  }, { now: () => clock });
  const expiredResult = await relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: expired.seams });
  assert.deepEqual(expiredResult, { disposition: "not-sent", reason: "stale" });
  assert.equal(expired.peers[0].writes.length, 1);

  // 4. A completed send releases the branch budget timer.
  const okTimers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const ok = hookHarness(correctPeer(), {
    setTimer: (callback, ms) => {
      const entry = { callback, ms, cleared: false };
      okTimers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const okResult = await relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: ok.seams });
  assert.equal(okResult.disposition, "handed-off");
  assert.ok(okTimers.every((entry) => entry.cleared), "every timer released after a completed send");

  // 5. Real timers with a short test budget: the attempt settles promptly against a silent peer.
  const real = hookHarness(() => {});
  const startedAt = performance.now();
  const realResult = await relayWindowsClaudeRootSessionStart(BOOTSTRAP, ROOT_SESSION_START, hookEnv(), { platform: "win32", seams: real.seams, budgetMs: 50 });
  assert.deepEqual(realResult, { disposition: "not-sent", reason: "cancelled" });
  assert.ok(performance.now() - startedAt < 2000);
});

/* ------------------------------------------------------ real relay entry */

test("the real relay keeps the broker frame and outcome identical while the Windows branch runs beside it", async () => {
  const marked = await runRelay();
  const unmarked = await runRelay({ env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: undefined }) });
  const linux = await runRelay({ platform: "linux" });
  for (const run of [marked, unmarked, linux]) {
    assert.deepEqual(run.outcome, { status: "accepted", delivered: "event" });
    assert.deepEqual(run.brokerPaths, [BOOTSTRAP.socketPath]);
    assert.equal(run.brokerLines.length, 1);
  }
  assert.equal(marked.brokerLines[0], unmarked.brokerLines[0], "the marker changes no broker byte");
  assert.equal(marked.brokerLines[0], linux.brokerLines[0]);
  const frame = JSON.parse(marked.brokerLines[0]) as Record<string, unknown>;
  assert.equal(frame.type, "native_hook_event");
  assert.equal("claude_inbox_announcement" in frame, false, "Windows never packs inbox values into broker traffic");
  for (const secret of [INBOX_TOKEN, "LOCAL", "prg682-hook", RUN_ID, MARKER, expectedKey()]) {
    assert.equal(marked.brokerLines[0].includes(secret), false, `no ${secret.slice(0, 12)} in the broker frame`);
  }
  // Separate branch result: receipt on the marked Windows run only, nothing elsewhere.
  assert.deepEqual(marked.branch, [{ disposition: "handed-off", reason: "write-completed" }]);
  assert.equal(sentBytes(marked.hook.peers[0]).endsWith(expectedRecord()), true);
  assert.deepEqual(unmarked.branch, [{ disposition: "ineligible", reason: "no-marker" }]);
  assert.deepEqual(unmarked.hook.connectCalls, []);
  assert.deepEqual(linux.branch, [{ disposition: "ineligible", reason: "not-windows" }]);
  assert.deepEqual(linux.hook.connectCalls, []);
  // The outcome object exposes nothing about the branch.
  assert.deepEqual(Object.keys(marked.outcome).sort(), ["delivered", "status"]);
});

test("broker status is never reflected from the branch, and branch failures never change the broker outcome", async () => {
  const rejected = await runRelay({ ack: ACK_REJECTED });
  assert.deepEqual(rejected.outcome, { status: "rejected", delivered: "event" });
  assert.deepEqual(rejected.branch, [{ disposition: "handed-off", reason: "write-completed" }], "receipt is independent of broker status, and is not a binding");

  const failedBranch = await runRelay({ respond: (nonce, peer) => peer.proof(proofFor(BOOTSTRAP_TOKEN, nonce)) });
  assert.deepEqual(failedBranch.outcome, { status: "accepted", delivered: "event" });
  assert.deepEqual(failedBranch.branch, [{ disposition: "not-sent", reason: "proof-mismatch" }]);

  const observerThrows = await runRelay({ observeThrows: true });
  assert.deepEqual(observerThrows.outcome, { status: "accepted", delivered: "event" });

  // Codex, mismatch, invalid marker, subagent and other events: no connection, outcome unchanged.
  const variants: Array<[string, Parameters<typeof runRelay>[0], WindowsClaudeHookRelayResult]> = [
    ["codex", { env: hookEnv({ [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify({ ...BOOTSTRAP, backend: "codex" }) }) }, { disposition: "ineligible", reason: "not-claude" }],
    ["mismatch", { env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: markerJson({ generation: INSTANCE }) }) }, { disposition: "ineligible", reason: "marker-mismatch" }],
    ["invalid", { env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: `${MARKER} ` }) }, { disposition: "ineligible", reason: "marker-invalid" }],
    ["subagent", { stdin: { hook_event_name: "SessionStart", session_id: SESSION_ID, agent_id: "agent-1", agent_type: "worker" } }, { disposition: "ineligible", reason: "not-root-session-start" }],
    ["stop", { stdin: { hook_event_name: "Stop", session_id: SESSION_ID } }, { disposition: "ineligible", reason: "not-root-session-start" }],
    ["provider-supplied routing fields are never selected", {
      env: hookEnv({ [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: undefined }),
      stdin: { hook_event_name: "SessionStart", session_id: SESSION_ID, pipe: HOOK_PIPE, runId: RUN_ID, marker: MARKER },
    }, { disposition: "ineligible", reason: "no-marker" }],
  ];
  for (const [name, options, expected] of variants) {
    const run = await runRelay(options);
    assert.deepEqual(run.outcome, { status: "accepted", delivered: "event" }, name);
    assert.deepEqual(run.branch, [expected], name);
    assert.deepEqual(run.hook.connectCalls, [], `${name}: no hook connection`);
    assert.equal(run.brokerLines[0].includes(MARKER), false);
    assert.equal(run.brokerLines[0].includes(HOOK_PIPE.slice(9)), false);
  }

  // A failure frame (unparseable provider input) never runs the branch at all.
  const brokerLines: string[] = [];
  let observed = 0;
  const failure = await runNativeHookRelay({
    env: hookEnv(),
    stdin: Readable.from([Buffer.from("{not json", "utf8")]),
    connect: () => {
      const socket = new FakeBrokerSocket(ACK_ACCEPTED);
      const write = socket.write.bind(socket);
      socket.write = (chunk: unknown) => {
        brokerLines.push(String(chunk));
        return write(chunk);
      };
      return socket as unknown as Socket;
    },
    windowsClaudeHook: { platform: "win32", observe: () => { observed += 1; } },
  });
  assert.deepEqual(failure, { status: "accepted", delivered: "failure", failure: "input-malformed" });
  assert.equal(observed, 0);
  assert.equal(brokerLines.length, 1);
});

test("an unreachable broker and a silent hook peer both settle within their own bounds", async () => {
  const branch: WindowsClaudeHookRelayResult[] = [];
  const hook = hookHarness(() => {});
  const startedAt = performance.now();
  const outcome = await runNativeHookRelay({
    env: hookEnv(),
    stdin: Readable.from([Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION_ID }), "utf8")]),
    connect: () => {
      throw new Error("no broker");
    },
    windowsClaudeHook: { platform: "win32", seams: hook.seams, budgetMs: 40, observe: (result) => branch.push(result) },
  });
  assert.deepEqual(outcome, { status: "unreachable", delivered: "event" });
  assert.deepEqual(branch, [{ disposition: "not-sent", reason: "cancelled" }]);
  // Wall-clock smoke only: scheduler delay may cancel before or after HELLO1, so assert
  // just that no record byte left (exact HELLO ordering is pinned with injected timers above).
  assert.ok(hook.peers.length <= 1 && hook.peers.every((peer) => peer.writes.length <= 1));
  assert.ok(hook.peers.every((peer) => !sentBytes(peer).includes(INBOX_TOKEN) && !sentBytes(peer).includes("SessionStart")));
  assert.ok(performance.now() - startedAt < 2000);
});

/* ------------------------------------------------------------- launch */

test("ordinary launch input strips the marker in every Windows casing and keeps executor-role rejection", () => {
  assert.deepEqual(
    snapshotNativeEnvironment({
      [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: MARKER,
      pi_review_gate_windows_claude_hook: "case-variant",
      Pi_Review_Gate_Windows_Claude_Hook: "other",
      PATH: "C:\\bin",
    }, "win32"),
    { PATH: "C:\\bin" },
    "conflicting case variants are dropped before any conflict check",
  );
  const posix: NodeJS.ProcessEnv = { [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: MARKER, HOME: "/home/example", sentinel: "keep" };
  rejectAndStripInheritedHostCapabilities(posix);
  assert.deepEqual(posix, { HOME: "/home/example", sentinel: "keep" });

  for (const role of [RUNTIME_ROLE_ENV, EXECUTOR_TOOL_CATALOG_ENV]) {
    const env: NodeJS.ProcessEnv = { [role]: "executor", [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: MARKER };
    assert.throws(() => rejectAndStripInheritedHostCapabilities(env), /refusing to prepare a native launch/);
    assert.equal(env[role], "executor", "a genuine worker-role marker is never silently cleared");
    const windows = snapshotNativeEnvironment({ [role.toLowerCase()]: "executor", [WINDOWS_CLAUDE_HOOK_MARKER_ENV]: MARKER }, "win32");
    assert.equal(windows[WINDOWS_CLAUDE_HOOK_MARKER_ENV], undefined);
    assert.throws(() => rejectAndStripInheritedHostCapabilities(windows), /refusing to prepare a native launch/);
  }
});

/* ------------------------------------------------------- module surface */

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("closed surface: only the injected custody callback composition issues the marker, and the module logs and stores nothing", () => {
  assert.deepEqual(Object.keys(relayModule).sort(), [
    "WINDOWS_CLAUDE_HOOK_KEY_CONTEXT",
    "WINDOWS_CLAUDE_HOOK_MARKER_ENV",
    "WINDOWS_CLAUDE_HOOK_MARKER_FIELDS",
    "WINDOWS_CLAUDE_HOOK_MARKER_MAX_CHARS",
    "WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS",
    "WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS",
    "deriveWindowsClaudeHookProofKey",
    "parseWindowsClaudeHookMarker",
    "relayWindowsClaudeRootSessionStart",
  ]);
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_HOOK_MARKER_FIELDS) && Object.isFrozen(WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS));
  const moduleText = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(moduleText.endsWith("\n") && !moduleText.endsWith("\n\n"));
  assert.doesNotMatch(moduleText, /console\.|process\.env|child_process|node:fs|\bspawn\(|\bfetch\(|new Function|\beval\(|\brequire\(|\bimport\(/u);
  assert.doesNotMatch(moduleText, /\[MARKER_ENV\]\s*=|\[WINDOWS_CLAUDE_HOOK_MARKER_ENV\]\s*=/u, "the module never writes the marker");
  const launchPath = join(PROJECT_ROOT, "src", "session-host", "launch.ts");
  const launchText = readFileSync(launchPath, "utf8");
  // The launcher mirrors the name locally (unchanged minimal closure) and must not import this module.
  assert.ok(launchText.includes('const WINDOWS_CLAUDE_HOOK_MARKER_ENV = "PI_REVIEW_GATE_WINDOWS_CLAUDE_HOOK";'));
  assert.equal(launchText.includes('from "./native-windows-claude-hook-relay"'), false);
  // #682: the ONE issuer is the instance manager's injected-only Windows custody
  // callback composition (no production host passes that injection): exactly one
  // marker issuance into the wrapper environment and one shared key derivation.
  const instancesPath = join(PROJECT_ROOT, "src", "session-host", "instances.ts");
  const instancesText = readFileSync(instancesPath, "utf8");
  assert.equal(instancesText.split("[WINDOWS_CLAUDE_HOOK_MARKER_ENV]: callbackPlan.marker").length - 1, 1, "one marker issuance");
  assert.equal(instancesText.split("deriveWindowsClaudeHookProofKey(").length - 1, 1, "one key derivation");
  for (const file of listTs(join(PROJECT_ROOT, "src"))) {
    if (file === MODULE_SOURCE_PATH) continue;
    const text = readFileSync(file, "utf8");
    if (file !== launchPath) {
      assert.equal(text.includes("PI_REVIEW_GATE_WINDOWS_CLAUDE_HOOK"), false, `${file} must not spell the marker name`);
    }
    if (file !== instancesPath) {
      assert.doesNotMatch(text, /\[WINDOWS_CLAUDE_HOOK_MARKER_ENV\]\s*=(?!=)|WINDOWS_CLAUDE_HOOK_MARKER_ENV\s*:/u, `${file} must not issue the marker`);
      assert.equal(text.includes("deriveWindowsClaudeHookProofKey"), false, `${file}: no other key derivation caller`);
      assert.equal(text.includes("nativeWindowsClaudeCustody"), false, `${file}: no production host injects custody`);
    }
    const usesMarker = text.includes("WINDOWS_CLAUDE_HOOK_MARKER_ENV");
    if (usesMarker) {
      assert.match(file, /[\\/]session-host[\\/](launch|instances)\.ts$/u, `${file}: only the launcher strips and the custody composition issues the marker`);
    }
    if (text.includes("relayWindowsClaudeRootSessionStart")) {
      assert.match(file, /[\\/]session-host[\\/]native-hook-relay\.ts$/u, `${file}: only the native hook relay runs the branch`);
    }
  }
});
