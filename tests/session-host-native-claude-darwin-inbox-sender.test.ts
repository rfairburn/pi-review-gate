/**
 * #682: the shared Claude inbox sender's Darwin capability.
 *
 * Portable and synthetic: the Darwin endpoint proof runs for real, but against
 * an injected fake Darwin namespace (fixed `/tmp`/`/var` aliases, owners,
 * modes, ctimes, ACL listings) through the sender's own test seams, and the
 * connection is an in-process fake transport that records the connect path and
 * every written byte. No socket, listing child, Claude CLI, provider account,
 * or credential is used, so nothing here proves real macOS behavior.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { inspect } from "node:util";
import test, { afterEach } from "node:test";

import {
  CLAUDE_DARWIN_PROOF_MAX_AGE_MS,
  proveClaudeDarwinInboxEndpoint,
  type ClaudeDarwinAclExecOptions,
  type ClaudeDarwinAclExecResult,
  type ClaudeDarwinFsProbe,
  type ClaudeDarwinInboxEndpointProof,
  type ClaudeDarwinLstat,
} from "../src/session-host/native-claude-darwin-inbox-endpoint";
import {
  CLAUDE_INBOX_PROVABLE_PLATFORMS,
  CLAUDE_INBOX_SUPPORTED_PLATFORMS,
  claudeInboxEndpointRule,
  createClaudeDarwinInboxSendCapability,
  createClaudeInboxSendCapability,
  proveClaudeInboxDarwinEndpoint,
  sendClaudeInboxMessage,
  setClaudeInboxConnectorForTests,
  setClaudeInboxDarwinProofSeamsForTests,
  setClaudeInboxPlatformForTests,
  type ClaudeDarwinInboxCapabilityInput,
  type ClaudeInboxSendCapability,
  type ClaudeInboxSendResult,
} from "../src/session-host/native-claude-inbox-delivery";

const UID = 501;
const SESSION_ID = "0f6b3c9e-1d2a-4b5c-8d7e-9f0a1b2c3d4e";
const HOOK_TOKEN = "HOOK-TOKEN-SECRET-682\n é \u{1f511}";
const MESSAGE = "SECRET-MESSAGE-682\nsecond line é \u{1f600} \"quoted\"";
const TMP_SOCKET = "/tmp/claude-2/i.sock";
const TMP_CANONICAL = `/private${TMP_SOCKET}`;
const VAR_SOCKET = "/var/folders/zz/abc123/T/claude-1/inbox.sock";
/** The exact Linux wire bytes for MESSAGE/HOOK_TOKEN (see the Linux sender test). */
const EXPECTED_WIRE =
  '{"type":"auth","token":"HOOK-TOKEN-SECRET-682\\n é \u{1f511}"}\n'
  + `{"type":"user","session_id":"${SESSION_ID}","message":{"role":"user","content":`
  + '"SECRET-MESSAGE-682\\nsecond line é \u{1f600} \\"quoted\\""}}\n';

const TYPE = { dir: 0o040000n, link: 0o120000n, sock: 0o140000n, file: 0o100000n } as const;
type Kind = keyof typeof TYPE;
let inoSeq = 5000n;

function perms(mode: bigint): string {
  const m = Number(mode & 0o7777n);
  const t = (r: number, w: number, x: number, s: number, on: string, off: string): string =>
    `${m & r ? "r" : "-"}${m & w ? "w" : "-"}${m & s ? (m & x ? on : off) : (m & x ? "x" : "-")}`;
  return t(0o400, 0o200, 0o100, 0o4000, "s", "S") + t(0o040, 0o020, 0o010, 0o2000, "s", "S") + t(0o004, 0o002, 0o001, 0o1000, "t", "T");
}

function typeChar(mode: bigint): string {
  const type = mode & 0o170000n;
  return type === TYPE.dir ? "d" : type === TYPE.link ? "l" : type === TYPE.sock ? "s" : "-";
}

/** A fake Darwin namespace for the proof's filesystem and listing seams. */
class World {
  readonly stats = new Map<string, ClaudeDarwinLstat>();
  readonly links = new Map<string, string>();
  readonly acl = new Map<string, string[]>();
  readonly aclPaths: string[] = [];
  aclHook?: (path: string, options: ClaudeDarwinAclExecOptions) => Promise<ClaudeDarwinAclExecResult | undefined> | undefined;

  readonly fs: ClaudeDarwinFsProbe = {
    lstat: async (path) => {
      const stats = this.stats.get(path);
      if (stats === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return stats;
    },
    readlink: async (path) => {
      const target = this.links.get(path);
      if (target === undefined) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return target;
    },
  };

  readonly executor = async (_tool: string, args: readonly string[], options: ClaudeDarwinAclExecOptions): Promise<ClaudeDarwinAclExecResult> => {
    const path = args[args.length - 1] as string;
    this.aclPaths.push(path);
    const hooked = await this.aclHook?.(path, options);
    if (hooked !== undefined) return hooked;
    const stats = this.stats.get(path);
    if (stats === undefined) return { status: "exited", exitCode: 1, stdout: Buffer.alloc(0) };
    const target = (stats.mode & 0o170000n) === TYPE.link ? this.links.get(path) : undefined;
    const entries = this.acl.get(path) ?? [];
    const name = target === undefined ? path : `${path} -> ${target}`;
    const lines = [`${stats.ino} ${typeChar(stats.mode)}${perms(stats.mode)}${entries.length > 0 ? "+" : ""} 1 someone  staff  0 Jan  1 00:00 ${name}`];
    entries.forEach((entry, index) => lines.push(` ${index}: ${entry}`));
    return { status: "exited", exitCode: 0, stdout: Buffer.from(`${lines.join("\n")}\n`, "utf8") };
  };

  set(path: string, kind: Kind, uid: number, perm: number): ClaudeDarwinLstat {
    inoSeq += 1n;
    const stats = { dev: 16777220n, ino: inoSeq, uid: BigInt(uid), mode: TYPE[kind] | BigInt(perm), ctimeNs: 1_700_000_000_000_000_000n + inoSeq };
    this.stats.set(path, stats);
    return stats;
  }

  /** Re-stamp an object's ctime, as any metadata change (an ACL edit) does. */
  touch(path: string): void {
    const stats = this.stats.get(path) as ClaudeDarwinLstat;
    inoSeq += 1n;
    this.stats.set(path, { ...stats, ctimeNs: stats.ctimeNs + inoSeq });
  }
}

function darwinWorld(): World {
  const w = new World();
  w.set("/", "dir", 0, 0o755);
  w.set("/bin/ls", "file", 0, 0o755);
  w.set("/tmp", "link", 0, 0o755);
  w.links.set("/tmp", "private/tmp");
  w.set("/var", "link", 0, 0o755);
  w.links.set("/var", "private/var");
  w.set("/private", "dir", 0, 0o755);
  w.set("/private/tmp", "dir", 0, 0o1777);
  w.set("/private/tmp/claude-2", "dir", UID, 0o700);
  w.set(TMP_CANONICAL, "sock", UID, 0o600);
  return w;
}

/** Install the fake world as this host's Darwin namespace. */
function useDarwin(w: World): void {
  setClaudeInboxPlatformForTests("darwin");
  setClaudeInboxDarwinProofSeamsForTests({ fs: w.fs, getuid: () => UID, aclExecutor: w.executor });
}

afterEach(() => {
  setClaudeInboxConnectorForTests(undefined);
  setClaudeInboxPlatformForTests(undefined);
  setClaudeInboxDarwinProofSeamsForTests(undefined);
});

function input(overrides: Partial<ClaudeDarwinInboxCapabilityInput> = {}): ClaudeDarwinInboxCapabilityInput {
  return {
    launchId: "launch-682",
    sessionId: SESSION_ID,
    socketPath: TMP_SOCKET,
    hookToken: HOOK_TOKEN,
    claudeVersion: "2.1.331",
    isCurrent: () => true,
    ...overrides,
  };
}

async function freshProof(socketPath = TMP_SOCKET, isCurrent: () => boolean = () => true): Promise<ClaudeDarwinInboxEndpointProof> {
  const result = await proveClaudeInboxDarwinEndpoint({ socketPath, isCurrent });
  assert.equal(result.ok, true, `proof should succeed: ${JSON.stringify(result)}`);
  return (result as { proof: ClaudeDarwinInboxEndpointProof }).proof;
}

async function darwinCapability(overrides: Partial<ClaudeDarwinInboxCapabilityInput> = {}): Promise<ClaudeInboxSendCapability> {
  const result = createClaudeDarwinInboxSendCapability(input(overrides), await freshProof(overrides.socketPath ?? TMP_SOCKET));
  assert.equal(result.ok, true, `capability should build: ${JSON.stringify(result)}`);
  return (result as { capability: ClaudeInboxSendCapability }).capability;
}

function assertNoSecrets(value: unknown): void {
  const text = `${JSON.stringify(value)} ${inspect(value, { depth: 10, showHidden: true })}`;
  assert.doesNotMatch(text, /HOOK-TOKEN-SECRET-682/);
  assert.doesNotMatch(text, /SECRET-MESSAGE-682/);
  assert.equal(text.includes("claude-2"), false, "names no socket path");
  assert.equal(text.includes("private/tmp"), false, "names no canonical path");
}

class FakeSocket extends Duplex {
  readonly writes: Buffer[] = [];
  destroyedByClient = false;
  constructor() {
    super({ allowHalfOpen: false });
  }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk);
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.destroyedByClient = true;
    callback(error);
  }
}

interface Transport {
  readonly paths: string[];
  readonly sockets: FakeSocket[];
  /** ACL listings already made when each connect was emitted. */
  readonly listingsAtConnect: number[];
}

/** Fake connector: records the path, runs `beforeConnect`, then emits `connect`. */
function installTransport(w: World, beforeConnect?: () => void): Transport {
  const transport: Transport = { paths: [], sockets: [], listingsAtConnect: [] };
  setClaudeInboxConnectorForTests((path) => {
    const socket = new FakeSocket();
    transport.paths.push(path);
    transport.sockets.push(socket);
    setImmediate(() => {
      beforeConnect?.();
      transport.listingsAtConnect.push(w.aclPaths.length);
      socket.emit("connect");
    });
    return socket;
  });
  return transport;
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* spin */ }
}

test("the platform split: Linux keeps its rule, macOS gets only the Darwin proof, everything else none", () => {
  assert.deepEqual([...CLAUDE_INBOX_SUPPORTED_PLATFORMS], ["linux"], "the Linux namespace rule is not widened");
  assert.deepEqual([...CLAUDE_INBOX_PROVABLE_PLATFORMS], ["linux", "darwin"]);
  for (const [platform, rule] of [["linux", "linux"], ["darwin", "darwin"], ["win32", undefined], ["freebsd", undefined], ["aix", undefined]] as const) {
    setClaudeInboxPlatformForTests(platform);
    assert.equal(claudeInboxEndpointRule(), rule, platform);
  }
});

test("a fresh Darwin proof mints an opaque capability; each send re-proves before and after connect and writes the Linux wire bytes to the canonical spelling", async () => {
  const w = darwinWorld();
  useDarwin(w);
  const capability = await darwinCapability();
  const perProof = w.aclPaths.length;
  assert.deepEqual(w.aclPaths, ["/", "/tmp", "/private", "/private/tmp", "/private/tmp/claude-2", TMP_CANONICAL],
    "the mint proof listed the alias, every canonical ancestor, and the socket");
  assertNoSecrets(capability);
  assert.equal(String(JSON.stringify(capability)), '"[ClaudeInboxSendCapability]"');

  const transport = installTransport(w);
  const result = await within(sendClaudeInboxMessage(capability, MESSAGE), 5000, "darwin send");
  assert.equal(result.disposition, "sent_unconfirmed", JSON.stringify(result));
  const wire = Buffer.concat(transport.sockets[0]!.writes).toString("utf8");
  assert.equal(wire, EXPECTED_WIRE, "the same two NDJSON frames as Linux");
  assert.deepEqual(result, { disposition: "sent_unconfirmed", placement: "unconfirmed", launchId: "launch-682", bytesWritten: Buffer.byteLength(wire) });
  assert.deepEqual(transport.paths, [TMP_CANONICAL], "connects only to the proven canonical spelling, never the alias");
  assert.deepEqual(transport.listingsAtConnect, [perProof * 2], "one complete re-proof ran before the connect");
  assert.equal(w.aclPaths.length, perProof * 3, "and another complete re-proof ran after the connect, before the first byte");
  assertNoSecrets(result);
  assert.ok(Object.isFrozen(result));
});

test("minting refuses forged, foreign, non-current, stale, and expired proofs, and keeps the shared input checks", async () => {
  const w = darwinWorld();
  useDarwin(w);
  w.set("/private/var", "dir", 0, 0o755);
  for (const dir of ["/private/var/folders", "/private/var/folders/zz"]) w.set(dir, "dir", 0, 0o755);
  for (const dir of ["/private/var/folders/zz/abc123", "/private/var/folders/zz/abc123/T", "/private/var/folders/zz/abc123/T/claude-1"]) w.set(dir, "dir", UID, 0o700);
  w.set(`/private${VAR_SOCKET}`, "sock", UID, 0o600);
  const refuse = (label: string, result: ReturnType<typeof createClaudeDarwinInboxSendCapability>, reason: string): void => {
    assert.deepEqual(result, { ok: false, reason }, label);
    assertNoSecrets(result);
  };

  const proof = await freshProof();
  refuse("forged look-alike", createClaudeDarwinInboxSendCapability(input(), Object.freeze({}) as ClaudeDarwinInboxEndpointProof), "invalid_endpoint_proof");
  refuse("proof of another socket", createClaudeDarwinInboxSendCapability(input({ socketPath: VAR_SOCKET }), proof), "invalid_endpoint_proof");
  refuse("canonical spelling of an aliased proof is a different path", createClaudeDarwinInboxSendCapability(input({ socketPath: `${TMP_SOCKET}x` }), proof), "invalid_endpoint_proof");
  // Two spellings of the SAME canonical socket: a proof binds only the spelling it ran for.
  const canonicalProof = await freshProof(TMP_CANONICAL);
  refuse("canonical-spelling proof for the alias spelling", createClaudeDarwinInboxSendCapability(input({ socketPath: TMP_SOCKET }), canonicalProof), "invalid_endpoint_proof");
  refuse("alias-spelling proof for the canonical spelling", createClaudeDarwinInboxSendCapability(input({ socketPath: TMP_CANONICAL }), proof), "invalid_endpoint_proof");
  assert.equal(createClaudeDarwinInboxSendCapability(input({ socketPath: TMP_CANONICAL }), canonicalProof).ok, true, "each spelling mints from its own proof");
  // A genuine proof run outside the sender's own entry point carries no spelling binding.
  const direct = await proveClaudeDarwinInboxEndpoint({ socketPath: TMP_SOCKET, isCurrent: () => true },
    { platform: "darwin", getuid: () => UID, fs: w.fs, aclExecutor: w.executor });
  assert.equal(direct.ok, true);
  refuse("proof from outside the sender entry point", createClaudeDarwinInboxSendCapability(input(), (direct as { proof: ClaudeDarwinInboxEndpointProof }).proof), "invalid_endpoint_proof");
  refuse("caller not current", createClaudeDarwinInboxSendCapability(input({ isCurrent: () => false }), proof), "invalid_endpoint_proof");
  refuse("caller predicate throws", createClaudeDarwinInboxSendCapability(input({ isCurrent: () => { throw new Error(HOOK_TOKEN); } }), proof), "invalid_endpoint_proof");
  let current = true;
  const stale = await freshProof(TMP_SOCKET, () => current);
  current = false;
  refuse("proof's own run is no longer current", createClaudeDarwinInboxSendCapability(input(), stale), "invalid_endpoint_proof");
  refuse("unsupported version", createClaudeDarwinInboxSendCapability(input({ claudeVersion: "2.1.329" }), proof), "unsupported_cli_version");
  refuse("prerelease version", createClaudeDarwinInboxSendCapability(input({ claudeVersion: "2.2.0-beta.1" }), proof), "unsupported_cli_version");
  refuse("bad session", createClaudeDarwinInboxSendCapability(input({ sessionId: "latest" }), proof), "invalid_session_id");
  refuse("bad token", createClaudeDarwinInboxSendCapability(input({ hookToken: "" }), proof), "invalid_hook_token");
  refuse("relative path", createClaudeDarwinInboxSendCapability(input({ socketPath: "tmp/i.sock" }), proof), "invalid_socket_path");
  refuse("non-ASCII path", createClaudeDarwinInboxSendCapability(input({ socketPath: "/tmp/é.sock" }), proof), "invalid_socket_path");
  const varProof = await freshProof(VAR_SOCKET);
  assert.equal(createClaudeDarwinInboxSendCapability(input({ socketPath: VAR_SOCKET }), varProof).ok, true, "the /var alias mints too");

  // A proof is never a standing grant: past its short maximum age it mints nothing.
  const aging = await freshProof();
  await new Promise<void>((resolve) => setTimeout(resolve, CLAUDE_DARWIN_PROOF_MAX_AGE_MS + 100));
  refuse("expired proof", createClaudeDarwinInboxSendCapability(input(), aging), "invalid_endpoint_proof");
});

test("a capability is usable only on its own platform: Darwin on Linux, Linux on Darwin, and Windows are refused without a connect", async () => {
  const w = darwinWorld();
  useDarwin(w);
  const darwin = await darwinCapability();
  const linux = createClaudeInboxSendCapability({
    launchId: "launch-682", sessionId: SESSION_ID, socketPath: TMP_CANONICAL, endpoint: { dev: 1n, ino: 2n, uid: UID },
    hookToken: HOOK_TOKEN, claudeVersion: "2.1.330", isCurrent: () => true,
  });
  assert.equal(linux.ok, true);
  const transport = installTransport(w);
  const listed = w.aclPaths.length;
  const expectRefused = async (label: string, result: ClaudeInboxSendResult): Promise<void> => {
    assert.deepEqual(result, { disposition: "refused", reason: "unsupported_platform" }, label);
  };
  await expectRefused("linux capability on darwin", await sendClaudeInboxMessage((linux as { capability: ClaudeInboxSendCapability }).capability, MESSAGE));
  for (const platform of ["linux", "win32", "freebsd"] as NodeJS.Platform[]) {
    setClaudeInboxPlatformForTests(platform);
    await expectRefused(`darwin capability on ${platform}`, await sendClaudeInboxMessage(darwin, MESSAGE));
  }
  assert.equal(transport.paths.length, 0, "no refusal connected");
  assert.equal(w.aclPaths.length, listed, "no refusal ran a proof");
});

test("a failed pre-connect re-proof never connects: ACL allow, replacement, removal, alias change, unprotected parent, stale run", async () => {
  const cases: Array<[string, (w: World, setCurrent: (value: boolean) => void) => void, string]> = [
    ["allow ACL on the socket", (w) => { w.acl.set(TMP_CANONICAL, ["user:mallory allow delete"]); w.touch(TMP_CANONICAL); }, "endpoint_unprotected"],
    ["allow ACL on a parent", (w) => { w.acl.set("/private/tmp/claude-2", ["group:staff allow add_file,delete_child"]); w.touch("/private/tmp/claude-2"); }, "endpoint_unprotected"],
    ["unprovable ACL", (w) => { w.acl.set(TMP_CANONICAL, ["user:mallory deny frobnicate"]); w.touch(TMP_CANONICAL); }, "endpoint_unprotected"],
    ["socket replaced", (w) => { w.set(TMP_CANONICAL, "sock", UID, 0o600); }, "endpoint_mismatch"],
    ["socket removed", (w) => { w.stats.delete(TMP_CANONICAL); }, "endpoint_unavailable"],
    ["alias retargeted", (w) => { w.links.set("/tmp", "/Users/mallory/tmp"); }, "endpoint_unprotected"],
    ["parent made world-writable without sticky", (w) => { w.set("/private/tmp", "dir", 0, 0o777); }, "endpoint_unprotected"],
    ["listing child failed", (w) => { w.aclHook = async () => ({ status: "diagnostic" }); }, "endpoint_unprotected"],
    ["run no longer current", (_w, setCurrent) => setCurrent(false), "not_current"],
  ];
  for (const [label, mutate, reason] of cases) {
    const w = darwinWorld();
    useDarwin(w);
    let current = true;
    const capability = await darwinCapability({ isCurrent: () => current });
    const transport = installTransport(w);
    mutate(w, (value) => { current = value; });
    const result = await within(sendClaudeInboxMessage(capability, MESSAGE), 5000, label);
    assert.deepEqual(result, { disposition: "refused", reason }, label);
    assert.equal(transport.paths.length, 0, `${label}: never connected`);
    assertNoSecrets(result);
  }
});

test("a failed post-connect re-proof writes no byte", async () => {
  const cases: Array<[string, (w: World, setCurrent: (value: boolean) => void) => void, string]> = [
    ["replaced after connect", (w) => { w.set(TMP_CANONICAL, "sock", UID, 0o600); }, "endpoint_mismatch"],
    ["allow ACL after connect", (w) => { w.acl.set(TMP_CANONICAL, ["user:mallory allow delete"]); w.touch(TMP_CANONICAL); }, "endpoint_unprotected"],
    ["removed after connect", (w) => { w.stats.delete(TMP_CANONICAL); }, "endpoint_unavailable"],
    ["not current after connect", (_w, setCurrent) => setCurrent(false), "not_current"],
  ];
  for (const [label, mutate, reason] of cases) {
    const w = darwinWorld();
    useDarwin(w);
    let current = true;
    const capability = await darwinCapability({ isCurrent: () => current });
    const transport = installTransport(w, () => mutate(w, (value) => { current = value; }));
    const result = await within(sendClaudeInboxMessage(capability, MESSAGE), 5000, label);
    assert.deepEqual(result, { disposition: "refused", reason }, label);
    assert.equal(transport.paths.length, 1, `${label}: connected once`);
    assert.equal(transport.sockets[0]!.writes.length, 0, `${label}: no byte written`);
    assert.equal(transport.sockets[0]!.destroyedByClient, true, `${label}: the connection was closed`);
  }
});

test("the re-proof runs only inside the send's finite remaining deadline and is ended with the attempt", async () => {
  // A listing that never answers: the send's own deadline ends the proof and aborts the child.
  const w = darwinWorld();
  useDarwin(w);
  const capability = await darwinCapability();
  const transport = installTransport(w);
  const signals: AbortSignal[] = [];
  const timeouts: number[] = [];
  w.aclHook = (_path, options) => {
    signals.push(options.signal);
    timeouts.push(options.timeoutMs);
    return new Promise<ClaudeDarwinAclExecResult>((resolve) => options.signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true }));
  };
  const started = performance.now();
  const stalled = await within(sendClaudeInboxMessage(capability, MESSAGE, { deadlineMs: 200 }), 3000, "stalled listing");
  assert.deepEqual(stalled, { disposition: "refused", reason: "deadline_exceeded" });
  assert.ok(performance.now() - started < 2000, "bounded by the send deadline");
  assert.ok(timeouts.length > 0 && timeouts.every((ms) => ms > 0 && ms <= 200), "each listing gets at most the remaining send budget");
  assert.ok(signals.every((signal) => signal.aborted), "the in-flight listing is aborted once the attempt ends");
  assert.equal(transport.paths.length, 0);

  // A connect that spends almost the whole budget leaves too little for the
  // post-connect proof: that is a deadline refusal, never a skipped check.
  const tight = darwinWorld();
  useDarwin(tight);
  const tightCapability = await darwinCapability();
  const tightTransport = installTransport(tight, () => spin(360));
  const late = await within(sendClaudeInboxMessage(tightCapability, MESSAGE, { deadlineMs: 400 }), 3000, "tight budget");
  assert.deepEqual(late, { disposition: "refused", reason: "deadline_exceeded" });
  for (const socket of tightTransport.sockets) assert.equal(socket.writes.length, 0, "no byte without a post-connect proof");
  const connectedAt = tightTransport.listingsAtConnect[0];
  if (connectedAt !== undefined) assert.equal(tight.aclPaths.length, connectedAt, "no post-connect proof started without budget");
});

test("cancellation during a re-proof refuses and aborts the listing child", async () => {
  const w = darwinWorld();
  useDarwin(w);
  const capability = await darwinCapability();
  const transport = installTransport(w);
  const controller = new AbortController();
  let listingSignal: AbortSignal | undefined;
  w.aclHook = (_path, options) => {
    listingSignal = options.signal;
    setImmediate(() => controller.abort());
    return new Promise<ClaudeDarwinAclExecResult>((resolve) => options.signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true }));
  };
  const result = await within(sendClaudeInboxMessage(capability, MESSAGE, { signal: controller.signal }), 3000, "cancel");
  assert.deepEqual(result, { disposition: "refused", reason: "cancelled" });
  assert.equal(listingSignal?.aborted, true);
  assert.equal(transport.paths.length, 0);
});
