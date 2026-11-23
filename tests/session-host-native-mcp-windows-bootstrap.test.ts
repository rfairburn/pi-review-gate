/**
 * #682 Windows native MCP bootstrap: launch staging and relay consumption
 * through the EXISTING platform permission policy and the EXISTING broker's
 * local named-pipe address.
 *
 * Coverage boundary, stated honestly. These cases are portable SIMULATIONS:
 * they select the Windows code paths with `platform: "win32"` and substitute
 * the Windows protection proof with a recording policy that implements the
 * same `PeerStatePermissionPolicy` contract (protect only an empty created
 * object, refuse with the policy's own fixed diagnostics). The filesystem
 * underneath is the host's real one, and the broker is a real local broker
 * reached through the relay's `connect` seam, which redirects the Windows pipe
 * address to that broker's own socket. None of this is evidence about the
 * real trusted DACL helper, NTFS file identity or deletion semantics, or a real
 * Windows named pipe; that needs a native Windows run without these seams.
 * No provider CLI, model, approval, configuration, or live host is used.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";

import { __test as brokerTest, createStatusBroker, type NativeMcpStatusBroker } from "../src/session-host/broker";
import { scanNativeArgPositions } from "../src/session-host/native-cli-launch";
import { NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS } from "../src/session-host/native-managed-host-lane";
import {
  NATIVE_MCP_ARTIFACT_ROOT_PREFIX,
  NATIVE_MCP_SERVER_NAME_PREFIX,
  prepareNativeMcpLaunch,
  type NativeMcpLaunchOutcome,
  type NativeMcpLaunchPreparationInput,
  type NativeMcpStagingStage,
} from "../src/session-host/native-mcp-launch-prep";
import {
  encodeNativeMcpBootstrap,
  isNativeMcpLocalPipeAddress,
  parseNativeMcpBootstrap,
  type NativeMcpBootstrap,
} from "../src/session-host/native-mcp-protocol";
import {
  NATIVE_MCP_RELAY_BOOTSTRAP_FLAG,
  WINDOWS_NATIVE_MCP_CLAIM_SUFFIX,
  isCanonicalLocalNativeMcpPath,
  isExpectedNativeMcpBrokerEndpoint,
  isProtectedNativeMcpSocketPath,
  openNativeMcpBrokerLane,
  readNativeMcpBootstrapFile,
  runNativeMcpRelay,
  windowsNativeMcpClaimPath,
  type NativeMcpRelayOutcome,
} from "../src/session-host/native-mcp-relay";
import type {
  NativeMcpCallToolRequest,
  NativeMcpCallToolResult,
  NativeMcpListToolsRequest,
  NativeMcpToolDescriptor,
  NativeMcpToolEndpoint,
} from "../src/session-host/native-mcp-stdio";
import type { PeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permission-policy";
import { withPeerStorageDiagnostic, type PeerStorageReason } from "../src/session-host/network/peer-storage-diagnostics";

type Json = Record<string, any>;

const HOST_SERVER_NAME = `${NATIVE_MCP_SERVER_NAME_PREFIX}${"0123456789abcdef".repeat(2)}`;
const INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const GENERATION = "44444444-4444-4444-8444-444444444444";
const TOKEN = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
const PIPE = `\\\\.\\pipe\\prg-st-${"0123456789abcdef".repeat(2)}`;

/** Whole-file simulation on a POSIX filesystem; real Windows needs a native run without seams. */
const simulated = { skip: process.platform === "win32" ? "portable Windows simulation; run the native Windows lane instead" : false };

function bootstrapFor(backend: "claude" | "codex", socketPath = PIPE): NativeMcpBootstrap {
  return { version: 1, type: "native_mcp_bootstrap", socketPath, generation: GENERATION, instanceId: INSTANCE_ID, backend, token: TOKEN };
}

// ---------------------------------------------------------------------------
// Owned scratch: one private directory per test file under the runner's
// temporary root, removed after every test whatever the outcome.

const scratchDirectories = new Set<string>();
const brokers = new Set<NativeMcpStatusBroker>();
const sockets = new Set<net.Socket>();

function makeScratch(prefix = "prg-mcp-win-"): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  fs.chmodSync(directory, 0o700);
  scratchDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  brokerTest.setSocketPathLimitForTests(undefined);
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const broker of brokers) {
    try {
      await broker.dispose();
    } catch {
      // Disposal is idempotent; cleanup never masks an assertion.
    }
  }
  brokers.clear();
  for (const directory of scratchDirectories) fs.rmSync(directory, { recursive: true, force: true });
  scratchDirectories.clear();
});

function openDescriptors(): number | undefined {
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The recording stand-in for the existing Windows policy. It implements the
// same contract the trusted DACL helper does — protection only for the EMPTY
// object the caller just created, fixed diagnostics on refusal — and records
// every proof with what the object looked like at that moment.

type PolicyMethod = keyof PeerStatePermissionPolicy;

interface PolicyCall {
  readonly method: PolicyMethod;
  readonly path: string;
  /** Byte length for a file, entry count for a directory, at the proof. */
  readonly observed: number;
}

class RecordingWindowsPolicy implements PeerStatePermissionPolicy {
  readonly calls: PolicyCall[] = [];
  /** Return a reason to refuse that proof (`"plain"` = an undiagnosed error). */
  refuse: (method: PolicyMethod, target: string) => PeerStorageReason | "plain" | undefined = () => undefined;
  /** Runs after a successful protect, before it returns (identity-swap simulation). */
  afterProtect: (method: PolicyMethod, target: string) => void = () => undefined;
  /** Runs after a successful owner-controlled proof, before it returns (ancestor-swap simulation). */
  afterAssert: (target: string) => void = () => undefined;

  assertOwnerControlledDirectory(target: string): void {
    this.#prove("assertOwnerControlledDirectory", target, "dir");
    this.afterAssert(target);
  }

  assertPrivateDirectory(target: string): void {
    this.#prove("assertPrivateDirectory", target, "dir");
  }

  protectCreatedDirectory(target: string): void {
    // The real helper refuses a used object (eligibility: empty, right kind).
    this.#prove("protectCreatedDirectory", target, "dir", true);
    this.afterProtect("protectCreatedDirectory", target);
  }

  assertPrivateFile(target: string): void {
    this.#prove("assertPrivateFile", target, "file");
  }

  protectCreatedFile(target: string): void {
    this.#prove("protectCreatedFile", target, "file", true);
    this.afterProtect("protectCreatedFile", target);
  }

  methods(): PolicyMethod[] {
    return this.calls.map((call) => call.method);
  }

  /** `[method, path]` pairs, in order. */
  steps(): Array<[PolicyMethod, string]> {
    return this.calls.map((call) => [call.method, call.path]);
  }

  #prove(method: PolicyMethod, target: string, kind: "dir" | "file", mustBeEmpty = false): void {
    let observed: number;
    try {
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink() || (kind === "dir" ? !stats.isDirectory() : !stats.isFile())) throw new Error("kind");
      observed = kind === "dir" ? entryCount(target) : stats.size;
    } catch {
      throw withPeerStorageDiagnostic(new Error("refused"), "unsafe-object");
    }
    this.calls.push({ method, path: target, observed });
    if (mustBeEmpty && observed !== 0) throw withPeerStorageDiagnostic(new Error("refused"), "changed");
    const reason = this.refuse(method, target);
    if (reason === "plain") throw new Error("refused without a diagnostic");
    if (reason !== undefined) throw withPeerStorageDiagnostic(new Error("refused"), reason);
  }
}

/** Entry count, or -1 for a directory this account may traverse but not list (a system ancestor). */
function entryCount(directory: string): number {
  try {
    return fs.readdirSync(directory).length;
  } catch {
    return -1;
  }
}

/** Every directory from the filesystem root down to `directory`, top-down. */
function ancestryOf(directory: string): string[] {
  const out: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    out.push(current);
    if (path.dirname(current) === current) break;
  }
  return out.reverse();
}

/** The ancestry walk's `[method, path]` steps for `directory`. */
function ancestrySteps(directory: string): Array<[PolicyMethod, string]> {
  return ancestryOf(directory).map((component) => ["assertOwnerControlledDirectory", component]);
}

/** A policy that fails the test if it is ever consulted (POSIX regression). */
const untouchablePolicy: PeerStatePermissionPolicy = new Proxy({} as PeerStatePermissionPolicy, {
  get: (_target, property) => () => { throw new Error(`POSIX consulted the Windows policy (${String(property)})`); },
});

function windowsInput(
  backend: "claude" | "codex",
  artifactParent: string,
  permissions: PeerStatePermissionPolicy,
  overrides: Partial<NativeMcpLaunchPreparationInput> = {},
): NativeMcpLaunchPreparationInput {
  return {
    backend,
    bootstrap: bootstrapFor(backend),
    platform: "win32",
    scan: scanNativeArgPositions(backend, [], "synthetic-target"),
    env: { PATH: "/usr/bin" },
    ownedCodexBackend: backend === "codex",
    serverName: HOST_SERVER_NAME,
    artifactParent,
    permissions,
    ...overrides,
  };
}

function prepared(outcome: NativeMcpLaunchOutcome) {
  assert.equal(outcome.mcp, "prepared", `expected prepared, got ${JSON.stringify(outcome)}`);
  if (outcome.mcp !== "prepared") throw new Error("unreachable");
  return outcome;
}

function unavailable(outcome: NativeMcpLaunchOutcome, reason: string) {
  assert.equal(outcome.mcp, "unavailable", `expected unavailable, got ${JSON.stringify(outcome)}`);
  if (outcome.mcp !== "unavailable") throw new Error("unreachable");
  assert.equal(outcome.reason, reason);
  return outcome;
}

/** The relay argv the Claude config instructs the provider to run. */
function claudeRelayArgv(outcome: ReturnType<typeof prepared>): string[] {
  const configFile = outcome.args[0]!.slice("--mcp-config=".length);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Json;
  assert.deepEqual(Object.keys(config.mcpServers), [HOST_SERVER_NAME]);
  const args = config.mcpServers[HOST_SERVER_NAME].args as string[];
  assert.equal(args.length, 3);
  return args.slice(1);
}

// ---------------------------------------------------------------------------
// Capability gate

test("Windows staging is shared support only: the host lane capability stays off on Windows", () => {
  // The owning host lane is the only production path that arms a native MCP
  // launch; it stays POSIX-only until Windows transport and real-client
  // evidence exist. This file's simulations do not change that.
  assert.deepEqual([...NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS].sort(), ["darwin", "linux"]);
  assert.equal(NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS.includes("win32"), false);
});

// ---------------------------------------------------------------------------
// Launch staging

test("Windows staging proves the existing policy's protection before any capability byte is written", simulated, async () => {
  const parent = makeScratch();
  const policy = new RecordingWindowsPolicy();
  const stages: Array<{ stage: NativeMcpStagingStage; calls: number; size?: number }> = [];
  let bootstrapPath: string | undefined;
  const before = openDescriptors();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, policy, {
    stagingProbe: (stage) => {
      const root = fs.readdirSync(parent).find((name) => name.startsWith(NATIVE_MCP_ARTIFACT_ROOT_PREFIX));
      const bootstrap = root === undefined ? undefined : path.join(parent, root, "native-mcp-bootstrap.json");
      if (bootstrap !== undefined) bootstrapPath = bootstrap;
      const size = bootstrap !== undefined && fs.existsSync(bootstrap) ? fs.statSync(bootstrap).size : undefined;
      stages.push({ stage, calls: policy.calls.length, size });
    },
  })));
  try {
    const { root, bootstrapFile } = outcome.lease;
    assert.equal(bootstrapFile, bootstrapPath);
    assert.equal(path.dirname(root), parent);
    const configFile = path.join(root, "claude-mcp-config.json");
    // Exactly the existing policy's methods, in protection order: the whole
    // ancestry from the filesystem root down to the parent first, then each
    // empty object this call had just created — and no other path.
    const ancestry = ancestrySteps(parent);
    assert.deepEqual(policy.steps(), [
      ...ancestry,
      ["protectCreatedDirectory", root],
      ["protectCreatedFile", bootstrapFile],
      ["protectCreatedFile", configFile],
    ]);
    assert.deepEqual(policy.calls.slice(ancestry.length).map((call) => call.observed), [0, 0, 0], "each protected while empty");
    // The bootstrap stays empty until its protection is proven.
    const at = (stage: NativeMcpStagingStage) => stages.find((entry) => entry.stage === stage)!;
    assert.equal(at("bootstrap-opened").size, 0);
    assert.equal(at("bootstrap-opened").calls, ancestry.length + 1, "the bootstrap's protection is not yet established when it is created");
    assert.equal(at("bootstrap-protected").size, 0, "protected while still empty");
    assert.equal(at("bootstrap-protected").calls, ancestry.length + 2);
    assert.ok(at("bootstrap-written").size! > 0);
    assert.equal(fs.readFileSync(bootstrapFile, "utf8"), encodeNativeMcpBootstrap(bootstrapFor("claude")));

    // The token is only in the bootstrap: never in the provider flags or config.
    assert.equal(JSON.stringify(outcome.args).includes(TOKEN), false);
    assert.equal(fs.readFileSync(configFile, "utf8").includes(TOKEN), false);
    assert.deepEqual(claudeRelayArgv(outcome), [NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, bootstrapFile]);

    // Windows defers deleting an open file, so only the root stays pinned.
    const after = openDescriptors();
    if (before !== undefined && after !== undefined) assert.equal(after, before + 1);
  } finally {
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
  }
  assert.deepEqual(fs.readdirSync(parent), [], "owned, nonrecursive cleanup removed every staged entry");
  const settled = openDescriptors();
  if (before !== undefined && settled !== undefined) assert.equal(settled, before, "cleanup released the root pin");
});

test("a Windows policy refusal at any proof stages no capability byte and rolls back exactly what was created", simulated, async () => {
  const cases: Array<{ method: PolicyMethod; nth?: number; expect: string; reason?: PeerStorageReason | "plain" }> = [
    { method: "assertOwnerControlledDirectory", expect: "artifact-path-unprotected", reason: "unsafe-permissions" },
    { method: "assertOwnerControlledDirectory", expect: "artifact-path-unprotected", reason: "protection-unsupported" },
    { method: "protectCreatedDirectory", expect: "artifact-staging-failed", reason: "unsafe-permissions" },
    { method: "protectCreatedDirectory", expect: "artifact-staging-failed", reason: "plain" },
    { method: "protectCreatedFile", nth: 1, expect: "artifact-staging-failed", reason: "foreign-owner" },
    // The config's refusal comes after the bootstrap was written: it must go too.
    { method: "protectCreatedFile", nth: 2, expect: "artifact-staging-failed", reason: "unsafe-permissions" },
  ];
  for (const { method, nth = 1, expect, reason } of cases) {
    const parent = makeScratch();
    const policy = new RecordingWindowsPolicy();
    let seen = 0;
    policy.refuse = (called) => (called === method && ++seen === nth ? reason : undefined);
    const before = openDescriptors();
    const outcome = unavailable(await prepareNativeMcpLaunch(windowsInput("claude", parent, policy)), expect);
    assert.equal(outcome.rollback, undefined, `${method}#${nth}: nothing was left for the owner`);
    assert.deepEqual(fs.readdirSync(parent), [], `${method}#${nth}: nothing survives`);
    const after = openDescriptors();
    if (before !== undefined && after !== undefined) assert.equal(after, before, `${method}#${nth}: no descriptor leaked`);
    if (method === "assertOwnerControlledDirectory") assert.deepEqual(policy.methods(), [method], "nothing was created");
  }

  // A staging-point failure before the bootstrap's protection: still empty, rolled back.
  const parent = makeScratch();
  for (const failAt of ["bootstrap-opened", "bootstrap-protected", "config-protected"] as const) {
    const outcome = unavailable(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy(), {
      stagingProbe: (stage) => { if (stage === failAt) throw new Error(`injected at ${stage}`); },
    })), "artifact-staging-failed");
    assert.equal(outcome.rollback, undefined);
    assert.deepEqual(fs.readdirSync(parent), [], `nothing survives a failure at ${failAt}`);
  }
});

test("Windows staging refuses an object swapped during protection and preserves the replacement", simulated, async () => {
  const parent = makeScratch();
  const policy = new RecordingWindowsPolicy();
  const kept = path.join(makeScratch(), "original");
  policy.afterProtect = (method, target) => {
    if (method !== "protectCreatedFile") return;
    // Keep the original inode alive elsewhere, so the replacement can never
    // reuse its identity, then put a foreign empty file at the same name.
    fs.renameSync(target, kept);
    fs.writeFileSync(target, "", { mode: 0o600 });
  };
  const outcome = unavailable(await prepareNativeMcpLaunch(windowsInput("claude", parent, policy)), "artifact-staging-failed");
  const [rootName] = fs.readdirSync(parent);
  assert.ok(rootName?.startsWith(NATIVE_MCP_ARTIFACT_ROOT_PREFIX));
  const root = path.join(parent, rootName!);
  const replacement = path.join(root, "native-mcp-bootstrap.json");
  assert.deepEqual([...outcome.rollback!.preserved].sort(), [replacement, root].sort(), "identity mismatch: never removed");
  assert.equal(fs.readFileSync(replacement, "utf8"), "", "no capability byte reached the swapped-in file");
  assert.equal(fs.readFileSync(kept, "utf8"), "", "nor the original");
});

test("Windows staging declines a non-canonical, relative, or non-directory artifact parent before any proof", simulated, async () => {
  const scratch = makeScratch();
  const file = path.join(scratch, "file");
  fs.writeFileSync(file, "x");
  const linked = path.join(scratch, "linked");
  fs.symlinkSync(makeScratch(), linked);
  for (const artifactParent of ["relative/dir", file, path.join(scratch, "missing")]) {
    const policy = new RecordingWindowsPolicy();
    unavailable(await prepareNativeMcpLaunch(windowsInput("claude", scratch, policy, { artifactParent })), "artifact-path-unprotected");
    assert.deepEqual(policy.calls, [], `${artifactParent}: the policy is never asked about an unusable parent`);
  }
  // A symlinked parent is canonicalized first: the proof and the root use the real directory.
  const policy = new RecordingWindowsPolicy();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("codex", scratch, policy, { artifactParent: linked })));
  const realAncestry = ancestrySteps(fs.realpathSync(linked));
  assert.deepEqual(policy.steps().slice(0, realAncestry.length), realAncestry);
  assert.deepEqual(policy.methods().slice(realAncestry.length), ["protectCreatedDirectory", "protectCreatedFile"]);
  assert.equal(policy.calls.some((call) => call.path.startsWith(linked)), false, "the symlink path is never proved or used");
  assert.equal(path.dirname(outcome.lease.root), fs.realpathSync(linked));
  await outcome.lease.cleanup();
});

test("POSIX staging and reading never consult a supplied Windows policy and keep proving 0600 before writing", { skip: process.platform === "win32" ? "POSIX regression" : false }, async () => {
  const parent = makeScratch();
  const seen: Array<{ stage: NativeMcpStagingStage; mode?: number; size?: number }> = [];
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, untouchablePolicy, {
    platform: "linux",
    bootstrap: bootstrapFor("claude", path.join(parent, "broker.sock")),
    stagingProbe: (stage) => {
      const root = fs.readdirSync(parent).find((name) => name.startsWith(NATIVE_MCP_ARTIFACT_ROOT_PREFIX));
      const file = root === undefined ? undefined : path.join(parent, root, "native-mcp-bootstrap.json");
      const stats = file !== undefined && fs.existsSync(file) ? fs.statSync(file) : undefined;
      seen.push({ stage, mode: stats === undefined ? undefined : stats.mode & 0o777, size: stats?.size });
    },
  })));
  const protectedAt = seen.find((entry) => entry.stage === "bootstrap-protected")!;
  assert.deepEqual({ mode: protectedAt.mode, size: protectedAt.size }, { mode: 0o600, size: 0 });
  assert.equal(fs.statSync(outcome.lease.root).mode & 0o777, 0o700);
  const descriptorsHeld = openDescriptors();
  // The POSIX reader ignores the policy seam, consumes once, and leaves cleanup an absent bootstrap.
  const read = readNativeMcpBootstrapFile(outcome.lease.bootstrapFile, { platform: "linux", permissions: untouchablePolicy });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(readNativeMcpBootstrapFile(outcome.lease.bootstrapFile, { platform: "linux", permissions: untouchablePolicy }),
    { ok: false, reason: "file_invalid" });
  const cleanup = await outcome.lease.cleanup();
  assert.deepEqual(cleanup.absent, [outcome.lease.bootstrapFile]);
  assert.deepEqual(cleanup.preserved, []);
  const after = openDescriptors();
  if (descriptorsHeld !== undefined && after !== undefined) assert.equal(after, descriptorsHeld - 3, "POSIX pinned the root and both files until cleanup");
});

// ---------------------------------------------------------------------------
// Relay reading

test("the Windows reader repeats the staged proof chain before opening, then consumes exactly once", simulated, async () => {
  const parent = makeScratch();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("codex", parent, new RecordingWindowsPolicy())));
  const { root, bootstrapFile } = outcome.lease;
  const reader = new RecordingWindowsPolicy();
  const first = readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: reader });
  assert.deepEqual(first, { ok: true, bootstrap: bootstrapFor("codex") });
  assert.deepEqual(reader.steps(), [
    ...ancestrySteps(parent),
    ["assertPrivateDirectory", root],
    ["assertPrivateFile", bootstrapFile],
  ]);
  assert.equal(reader.calls.at(-1)!.observed, Buffer.byteLength(encodeNativeMcpBootstrap(bootstrapFor("codex"))));
  assert.equal(fs.existsSync(bootstrapFile), false, "consumed");
  // Single use: a second reader (or a racing relay) never gets the token.
  assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: new RecordingWindowsPolicy() }),
    { ok: false, reason: "file_invalid" });
  const cleanup = await outcome.lease.cleanup();
  assert.deepEqual(cleanup, { removed: [root], absent: [bootstrapFile], preserved: [] });
});

test("the Windows reader refuses before opening and leaves the bootstrap for owned cleanup", simulated, async () => {
  const parent = makeScratch();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy())));
  const { root, bootstrapFile } = outcome.lease;
  const expected = fs.readFileSync(bootstrapFile, "utf8");
  const refusing = (method: PolicyMethod, reason: PeerStorageReason | "plain"): RecordingWindowsPolicy => {
    const policy = new RecordingWindowsPolicy();
    policy.refuse = (called) => (called === method ? reason : undefined);
    return policy;
  };
  const cases: Array<[RecordingWindowsPolicy, string]> = [
    [refusing("assertOwnerControlledDirectory", "unsafe-permissions"), "parent_invalid"],
    [refusing("assertPrivateDirectory", "foreign-owner"), "parent_invalid"],
    [refusing("assertPrivateDirectory", "plain"), "parent_invalid"],
    [refusing("assertPrivateFile", "unsafe-permissions"), "file_invalid"],
    // No trusted helper on this host: nothing can be proven.
    [refusing("assertOwnerControlledDirectory", "protection-unsupported"), "platform_unverifiable"],
    [refusing("assertPrivateFile", "protection-unsupported"), "platform_unverifiable"],
  ];
  for (const [policy, reason] of cases) {
    assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: policy }), { ok: false, reason });
    assert.equal(fs.readFileSync(bootstrapFile, "utf8"), expected, `${reason}: left in place, unread`);
  }

  // Paths that are not canonical local absolute paths are refused before any proof.
  for (const candidate of ["relative/native-mcp-bootstrap.json", `${root}/../${path.basename(root)}/native-mcp-bootstrap.json`, `${bootstrapFile}\u0007`, ""]) {
    const policy = new RecordingWindowsPolicy();
    assert.deepEqual(readNativeMcpBootstrapFile(candidate, { platform: "win32", permissions: policy }), { ok: false, reason: "path_invalid" });
    assert.deepEqual(policy.calls, []);
  }

  // A second name for the bootstrap (hard link) or a symlink is never read.
  const alias = path.join(root, "alias.json");
  fs.linkSync(bootstrapFile, alias);
  assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: new RecordingWindowsPolicy() }), { ok: false, reason: "file_invalid" });
  fs.unlinkSync(alias);
  const symlink = path.join(root, "via-link.json");
  fs.symlinkSync(bootstrapFile, symlink);
  assert.deepEqual(readNativeMcpBootstrapFile(symlink, { platform: "win32", permissions: new RecordingWindowsPolicy() }), { ok: false, reason: "file_invalid" });
  fs.unlinkSync(symlink);

  // Owned cleanup still removes the refused bootstrap exactly.
  const cleanup = await outcome.lease.cleanup();
  assert.deepEqual(cleanup.preserved, []);
  assert.ok(cleanup.removed.includes(bootstrapFile));
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("a replaceable, redirected, or swapped ancestor above the checked directories blocks staging and consumption", simulated, async () => {
  // Staging: an ancestor ABOVE the artifact parent that the existing policy
  // cannot prove owner-controlled stops everything before any creation.
  const parent = makeScratch();
  const above = path.dirname(parent);
  const staging = new RecordingWindowsPolicy();
  staging.refuse = (method, target) => (method === "assertOwnerControlledDirectory" && target === above ? "unsafe-permissions" : undefined);
  unavailable(await prepareNativeMcpLaunch(windowsInput("claude", parent, staging)), "artifact-path-unprotected");
  assert.deepEqual(fs.readdirSync(parent), [], "nothing was created, so no capability byte was written");
  assert.equal(staging.methods().includes("protectCreatedDirectory"), false);
  // No trusted helper for some ancestor: the same decline.
  staging.refuse = (method, target) => (method === "assertOwnerControlledDirectory" && target === ancestryOf(parent)[0] ? "protection-unsupported" : undefined);
  unavailable(await prepareNativeMcpLaunch(windowsInput("codex", parent, staging)), "artifact-path-unprotected");
  assert.deepEqual(fs.readdirSync(parent), []);

  // Reading: a staged bootstrap, then the same kinds of ancestor faults.
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("codex", parent, new RecordingWindowsPolicy())));
  const { root, bootstrapFile } = outcome.lease;
  const expected = fs.readFileSync(bootstrapFile, "utf8");
  const intact = (label: string): void => assert.equal(fs.readFileSync(bootstrapFile, "utf8"), expected, `${label}: not consumed`);

  const replaceable = new RecordingWindowsPolicy();
  replaceable.refuse = (method, target) => (method === "assertOwnerControlledDirectory" && target === above ? "unsafe-permissions" : undefined);
  assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: replaceable }), { ok: false, reason: "parent_invalid" });
  assert.equal(replaceable.methods().includes("assertPrivateFile"), false, "the file was never proved or opened");
  intact("replaceable ancestor");

  const unsupported = new RecordingWindowsPolicy();
  unsupported.refuse = (method, target) => (method === "assertOwnerControlledDirectory" && target === above ? "protection-unsupported" : undefined);
  assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: unsupported }), { ok: false, reason: "platform_unverifiable" });
  intact("unprovable ancestor");

  // A symlink (the portable stand-in for a junction) ABOVE the checked
  // directories: the path string is canonical, but the walk never follows it.
  const links = makeScratch();
  const via = path.join(links, "via");
  fs.symlinkSync(above, via);
  const redirected = path.join(via, path.basename(parent), path.basename(root), path.basename(bootstrapFile));
  assert.equal(isCanonicalLocalNativeMcpPath(redirected), true, "string canonicalization alone cannot see the link");
  const viaPolicy = new RecordingWindowsPolicy();
  assert.deepEqual(readNativeMcpBootstrapFile(redirected, { platform: "win32", permissions: viaPolicy }), { ok: false, reason: "parent_invalid" });
  assert.equal(viaPolicy.calls.some((call) => call.path.startsWith(via)), false, "the helper is never pointed through the link");
  intact("redirected ancestor");

  // An ancestor swapped while it is being proved: identity changed, refused.
  const moved = `${parent}.moved`;
  const swapping = new RecordingWindowsPolicy();
  swapping.afterAssert = (target) => {
    if (target !== parent) return;
    fs.renameSync(parent, moved);
    fs.mkdirSync(parent, { mode: 0o700 });
  };
  try {
    assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: swapping }), { ok: false, reason: "parent_invalid" });
    assert.equal(fs.readFileSync(path.join(moved, path.basename(root), path.basename(bootstrapFile)), "utf8"), expected, "swapped: not consumed");
  } finally {
    fs.rmdirSync(parent);
    fs.renameSync(moved, parent);
  }

  // The unchanged chain still reads once, and owned cleanup stays exact.
  assert.equal(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: new RecordingWindowsPolicy() }).ok, true);
  assert.deepEqual(await outcome.lease.cleanup(), { removed: [root], absent: [bootstrapFile], preserved: [] });
});

test("the Windows reader consumes through one exclusive claim: concurrent readers never both get the token", simulated, async () => {
  const parent = makeScratch();
  const win32 = (extra: { beforeWindowsClaim?: () => void } = {}) => ({ platform: "win32" as const, permissions: new RecordingWindowsPolicy(), ...extra });
  const expectedBootstrap = bootstrapFor("claude");

  // Two relays that both read the record: the one that claims first wins;
  // the other, already past its read, finds the bootstrap consumed.
  {
    const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy())));
    const { bootstrapFile } = outcome.lease;
    let first: ReturnType<typeof readNativeMcpBootstrapFile> | undefined;
    const second = readNativeMcpBootstrapFile(bootstrapFile, win32({
      beforeWindowsClaim: () => { first = readNativeMcpBootstrapFile(bootstrapFile, win32()); },
    }));
    assert.deepEqual(first, { ok: true, bootstrap: expectedBootstrap }, "the first claimant gets the token");
    assert.deepEqual(second, { ok: false, reason: "consume_failed" }, "the reader that lost the claim gets nothing");
    assert.equal(fs.existsSync(bootstrapFile), false);
    assert.equal(fs.existsSync(`${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`), false, "the winner removed its claim");
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.absent, [bootstrapFile]);
    assert.deepEqual(cleanup.preserved, []);
  }

  // Another relay holds the claim (mid-consumption): refused, nothing removed;
  // lease cleanup removes that claim because it is a link to the bootstrap.
  {
    const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy())));
    const { root, bootstrapFile } = outcome.lease;
    const claim = `${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`;
    const expected = fs.readFileSync(bootstrapFile, "utf8");
    const result = readNativeMcpBootstrapFile(bootstrapFile, win32({ beforeWindowsClaim: () => fs.linkSync(bootstrapFile, claim) }));
    assert.deepEqual(result, { ok: false, reason: "consume_failed" });
    assert.equal(fs.readFileSync(bootstrapFile, "utf8"), expected, "not consumed by the loser");
    // While the claim exists the bootstrap has a second link: never read again.
    assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, win32()), { ok: false, reason: "file_invalid" });
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
    assert.deepEqual([...cleanup.removed].sort(), [claim, bootstrapFile, path.join(root, "claude-mcp-config.json"), root].sort());
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("an alternate bootstrap filename contends for the same Windows claim slot", simulated, async () => {
  const parent = makeScratch();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("codex", parent, new RecordingWindowsPolicy())));
  const { root, bootstrapFile } = outcome.lease;
  const alternate = path.join(root, "NATIVE~1.JSO");
  const claim = windowsNativeMcpClaimPath(bootstrapFile);
  assert.equal(claim, `${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`, "the fixed slot is the canonical name's claim");
  assert.equal(windowsNativeMcpClaimPath(alternate), claim, "every spelling in the directory maps to one slot");
  try {
    // Portable stand-in for an 8.3 spelling: the same inode under another
    // name, still a single link.
    fs.renameSync(bootstrapFile, alternate);
    const expected = fs.readFileSync(alternate, "utf8");
    // The long-name reader holds the claim while the short-name reader tries.
    const result = readNativeMcpBootstrapFile(alternate, {
      platform: "win32",
      permissions: new RecordingWindowsPolicy(),
      beforeWindowsClaim: () => fs.linkSync(alternate, claim),
    });
    assert.deepEqual(result, { ok: false, reason: "consume_failed" });
    assert.equal(fs.readFileSync(alternate, "utf8"), expected, "the losing spelling consumed nothing");
    fs.unlinkSync(claim);
    // With the slot free, the alternate spelling's own claim lands in that same slot and is removed after the win.
    const won = readNativeMcpBootstrapFile(alternate, { platform: "win32", permissions: new RecordingWindowsPolicy() });
    assert.equal(won.ok, true, JSON.stringify(won));
    assert.equal(fs.existsSync(claim), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    if (fs.existsSync(alternate)) fs.renameSync(alternate, bootstrapFile);
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("an occupied claim name is refused without consuming, and lease cleanup never removes the unrelated entry", simulated, async () => {
  const parent = makeScratch();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy())));
  const { root, bootstrapFile } = outcome.lease;
  const claim = `${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`;
  const expected = fs.readFileSync(bootstrapFile, "utf8");
  fs.writeFileSync(claim, "unrelated\n", { mode: 0o600 });
  assert.deepEqual(readNativeMcpBootstrapFile(bootstrapFile, { platform: "win32", permissions: new RecordingWindowsPolicy() }),
    { ok: false, reason: "consume_failed" });
  assert.equal(fs.readFileSync(bootstrapFile, "utf8"), expected, "not consumed");
  assert.equal(fs.readFileSync(claim, "utf8"), "unrelated\n", "the unrelated entry is untouched");
  // A claim name is never read as a bootstrap, in any letter case.
  for (const candidate of [claim, `${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX.toUpperCase()}`]) {
    const policy = new RecordingWindowsPolicy();
    assert.deepEqual(readNativeMcpBootstrapFile(candidate, { platform: "win32", permissions: policy }), { ok: false, reason: "path_invalid" });
    assert.deepEqual(policy.calls, []);
  }
  const cleanup = await outcome.lease.cleanup();
  assert.deepEqual([...cleanup.preserved].sort(), [claim, root].sort(), "a foreign claim (and so the root) is preserved");
  assert.deepEqual([...cleanup.removed].sort(), [bootstrapFile, path.join(root, "claude-mcp-config.json")].sort());
  assert.equal(fs.readFileSync(claim, "utf8"), "unrelated\n");
});

test("lease cleanup removes an interrupted claim only while it is still a link to the bootstrap", simulated, async () => {
  const parent = makeScratch();
  // Interrupted after the claim, before removing the bootstrap.
  {
    const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("codex", parent, new RecordingWindowsPolicy())));
    const { root, bootstrapFile } = outcome.lease;
    const claim = `${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`;
    fs.linkSync(bootstrapFile, claim);
    assert.deepEqual(await outcome.lease.cleanup(), { removed: [claim, bootstrapFile, root], absent: [], preserved: [] });
  }
  // Interrupted after removing the bootstrap, before removing the claim.
  {
    const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("codex", parent, new RecordingWindowsPolicy())));
    const { root, bootstrapFile } = outcome.lease;
    const claim = `${bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`;
    fs.linkSync(bootstrapFile, claim);
    fs.unlinkSync(bootstrapFile);
    assert.deepEqual(await outcome.lease.cleanup(), { removed: [claim, root], absent: [bootstrapFile], preserved: [] });
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("without a policy seam the Windows reader uses the existing trusted helper, which cannot prove anything here", simulated, () => {
  const directory = makeScratch();
  const file = path.join(directory, "native-mcp-bootstrap.json");
  fs.writeFileSync(file, encodeNativeMcpBootstrap(bootstrapFor("claude")), { mode: 0o600 });
  assert.deepEqual(readNativeMcpBootstrapFile(file, { platform: "win32" }), { ok: false, reason: "platform_unverifiable" });
  assert.equal(fs.existsSync(file), true, "never read or consumed");
});

test("the canonical local path rule rejects relative, unresolved, controlled, and network-namespace paths", () => {
  const scratch = makeScratch();
  assert.equal(isCanonicalLocalNativeMcpPath(path.join(scratch, "a.json")), true);
  for (const candidate of [
    "", "a.json", `${scratch}/./a.json`, `${scratch}/../a.json`, `${scratch}/a\u0000.json`, `${scratch}/a\n.json`,
    "\\\\server\\share\\a.json", "\\\\?\\C:\\a.json", "\\\\.\\C:\\a.json", "//server/share/a.json", 42,
  ]) {
    assert.equal(isCanonicalLocalNativeMcpPath(candidate), false, JSON.stringify(candidate));
  }
});

test("Windows bootstrap paths have an unambiguous spelling for Node and the DACL helper", () => {
  // Portable: the Windows spelling rule is selected explicitly, whatever the host.
  assert.equal(isCanonicalLocalNativeMcpPath("C:\\", "win32"), true);
  assert.equal(isCanonicalLocalNativeMcpPath("C:\\Pi scratch\\bootstrap.json", "win32"), true);
  assert.equal(isCanonicalLocalNativeMcpPath("C:\\Users\\me\\AppData\\Local\\Temp\\prg-native-mcp-Ab12Cd\\native-mcp-bootstrap.json", "win32"), true);
  for (const candidate of [
    // Trailing dots and spaces are stripped by .NET but kept by Node.
    "C:\\private.\\bootstrap.json", "C:\\private \\bootstrap.json", "C:\\private\\bootstrap.json.", "C:\\private\\bootstrap.json ",
    // Alternate data streams, wildcards, and reserved device names.
    "C:\\private\\bootstrap.json:stream", "C:\\private\\boot*.json", "C:\\private\\NUL.json", "C:\\private\\com1",
    "C:\\private\\COM¹.json", "C:\\private\\CONOUT$",
    // Not a resolved drive-letter path.
    "C:private\\bootstrap.json", "C:\\private\\..\\bootstrap.json", "C:\\private\\\\bootstrap.json", "C:/private/bootstrap.json",
    "\\\\server\\share\\bootstrap.json", "\\\\?\\C:\\bootstrap.json", "\\\\.\\C:\\bootstrap.json", "/tmp/bootstrap.json",
    "C:\\private\\a\u0007.json", 42,
  ]) {
    assert.equal(isCanonicalLocalNativeMcpPath(candidate, "win32"), false, JSON.stringify(candidate));
  }
});

// ---------------------------------------------------------------------------
// Endpoint trust: only the existing broker's local pipe

test("a Windows lane dials only the existing broker's generated local pipe, reusing the protocol's shape check", async () => {
  const lower = "0123456789abcdef".repeat(2);
  assert.equal(isNativeMcpLocalPipeAddress(PIPE), true);
  assert.equal(isExpectedNativeMcpBrokerEndpoint(PIPE, "win32"), true);
  for (const address of [
    `\\\\server\\pipe\\prg-st-${lower}`,
    `\\\\?\\pipe\\prg-st-${lower}`,
    `\\\\.\\pipe\\prg-st-${lower.toUpperCase()}`,
    `\\\\.\\pipe\\prg-st-${lower}0`,
    `\\\\.\\pipe\\other-${lower}`,
    "/tmp/prg-status/broker.sock",
    "C:\\Users\\me\\broker.sock",
  ]) {
    assert.equal(isNativeMcpLocalPipeAddress(address), false, address);
    assert.equal(isExpectedNativeMcpBrokerEndpoint(address, "win32"), false, address);
  }
  // POSIX never accepts a pipe-shaped address in place of a protected socket.
  assert.equal(isExpectedNativeMcpBrokerEndpoint(PIPE, "linux"), false);

  // An unexpected endpoint is refused before any connection, so no hello (token) is sent.
  let attempts = 0;
  const connect = (): net.Socket => { attempts += 1; throw new Error("never dialed"); };
  assert.deepEqual(await openNativeMcpBrokerLane(bootstrapFor("claude", "/tmp/prg-status/broker.sock"), { platform: "win32", connect }),
    { ok: false, reason: "unprotected" });
  assert.deepEqual(await openNativeMcpBrokerLane(bootstrapFor("claude"), { platform: "linux", connect }), { ok: false, reason: "unprotected" });
  assert.equal(attempts, 0);
});

// ---------------------------------------------------------------------------
// Bridge: Windows staging -> relay reader -> lane -> real broker -> endpoint

const TOOLS: NativeMcpToolDescriptor[] = [{ name: "SubtasksInspect", description: "inspect", inputSchema: { type: "object" } }];

class RecordingEndpoint implements NativeMcpToolEndpoint {
  readonly calls: NativeMcpCallToolRequest[] = [];
  async listTools(_request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]> {
    return TOOLS;
  }
  async callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    this.calls.push(request);
    return { content: [{ type: "text", text: `ran ${request.name}` }], isError: false };
  }
}

class StdioClient {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly frames: Json[] = [];
  #buffer = "";

  constructor() {
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline: number;
      while ((newline = this.#buffer.indexOf("\n")) >= 0) {
        this.frames.push(JSON.parse(this.#buffer.slice(0, newline)));
        this.#buffer = this.#buffer.slice(newline + 1);
      }
    });
  }

  send(message: Json): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  async response(id: number): Promise<Json> {
    const deadline = Date.now() + 4000;
    while (!this.frames.some((frame) => frame.id === id)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for response ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.frames.find((frame) => frame.id === id)!;
  }
}

/**
 * Where the bridge's broker socket lives: an owned fixture whose bind and dial
 * addresses are short whatever TMPDIR is (the same choice as the MCP lane
 * tests). The broker's POSIX socket must sit beneath a path no other local
 * user can replace; when the working directory qualifies, the socket lives
 * there (dialed relative to it), otherwise under canonical `/tmp`, never
 * `os.tmpdir()`, which may be long or point back into the checkout.
 */
let socketBase: string | undefined;
function socketFixtureRoot(): string {
  if (socketBase !== undefined) return socketBase;
  const probe = fs.mkdtempSync(path.join(process.cwd(), ".prg-mcp-probe-"));
  try {
    fs.chmodSync(probe, 0o700);
    const leaf = path.join(probe, "s.sock");
    const uid = BigInt(process.getuid!());
    const usable = isProtectedNativeMcpSocketPath(leaf, {
      lstat: (target) => target === leaf
        ? { uid, mode: 0o140700n, isDirectory: () => false, isSocket: () => true }
        : fs.lstatSync(target, { bigint: true }),
    });
    socketBase = usable ? process.cwd() : fs.realpathSync("/tmp");
  } finally {
    fs.rmdirSync(probe);
  }
  return socketBase;
}

function makeSocketScratch(): string {
  const directory = fs.mkdtempSync(path.join(socketFixtureRoot(), ".prg-mcp-"));
  fs.chmodSync(directory, 0o700);
  scratchDirectories.add(directory);
  return directory;
}

/** The address to bind or dial: relative to the working directory when the absolute one is long and beneath it. */
function dialable(address: string): string {
  if (Buffer.byteLength(address, "utf8") <= 100) return address;
  const relative = path.relative(process.cwd(), address);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? `./${relative}` : address;
}

async function makeBroker(): Promise<NativeMcpStatusBroker> {
  brokerTest.setSocketPathLimitForTests(4096);
  const socketRoot = makeSocketScratch();
  // The broker binds its own absolute path; keep the bind address dialable too.
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
    if (typeof args[0] === "string") args[0] = dialable(args[0]);
    else if (args[0] && typeof args[0] === "object" && typeof (args[0] as Json).path === "string") {
      args[0] = { ...(args[0] as Json), path: dialable((args[0] as Json).path) };
    }
    return Reflect.apply(listen, this, args) as net.Server;
  } as typeof net.Server.prototype.listen;
  try {
    const broker = await createStatusBroker({ socketRoot });
    brokers.add(broker);
    assert.ok(Buffer.byteLength(dialable(broker.socketPath), "utf8") <= 100, "the fixture socket address fits every Unix bound");
    return broker;
  } finally {
    net.Server.prototype.listen = listen;
  }
}

test("bridge: a Windows-staged bootstrap reaches the real broker only through the expected local pipe, once", simulated, async () => {
  const broker = await makeBroker();
  const endpoint = new RecordingEndpoint();
  const registration = broker.registerNativeMcpSource(INSTANCE_ID, "claude", endpoint);
  // The bootstrap a Windows broker would issue: same proof, pipe address.
  const issued = parseNativeMcpBootstrap({ ...registration.bootstrap, socketPath: PIPE });
  assert.ok(issued !== undefined);

  const parent = makeScratch();
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy(), { bootstrap: issued })));
  const argv = claudeRelayArgv(outcome);
  const dialed: string[] = [];
  const connect = (address: string): net.Socket => {
    dialed.push(address);
    // Seam: the pipe address is redirected to this broker's own socket.
    const socket = net.createConnection({ path: dialable(broker.socketPath) });
    sockets.add(socket);
    return socket;
  };
  const relayOptions = (client: StdioClient) => ({
    argv, env: {}, input: client.input, output: client.output, platform: "win32" as const,
    permissions: new RecordingWindowsPolicy(), connect,
  });

  const client = new StdioClient();
  const run: Promise<NativeMcpRelayOutcome> = runNativeMcpRelay(relayOptions(client));
  client.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  assert.equal((await client.response(0)).result.serverInfo.name, "pi-review-gate");
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual((await client.response(1)).result, { tools: TOOLS });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksInspect", arguments: { id: "t" } } });
  assert.deepEqual((await client.response(2)).result, { content: [{ type: "text", text: "ran SubtasksInspect" }], isError: false });
  assert.deepEqual(dialed, [PIPE], "exactly the issued local pipe, once");
  assert.equal(fs.existsSync(outcome.lease.bootstrapFile), false, "consumed before connecting");
  assert.equal(fs.existsSync(`${outcome.lease.bootstrapFile}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`), false, "no claim left behind");
  client.input.end();
  assert.deepEqual(await run, { status: "ended", reason: "input_ended", laneClosedFirst: false });
  assert.equal(JSON.stringify(client.frames).includes(TOKEN), false);
  assert.equal(JSON.stringify(client.frames).includes(registration.bootstrap.token), false);

  // Single use: a second relay start with the same instruction never dials.
  const again = new StdioClient();
  assert.deepEqual(await runNativeMcpRelay(relayOptions(again)), { status: "bootstrap_invalid" });
  assert.equal(dialed.length, 1);
  assert.equal(endpoint.calls.length, 1);

  const cleanup = await outcome.lease.cleanup();
  assert.deepEqual(cleanup.absent, [outcome.lease.bootstrapFile]);
  assert.deepEqual(cleanup.preserved, []);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("bridge: a Windows bootstrap naming anything but the local pipe is consumed but never dialed", simulated, async () => {
  const parent = makeScratch();
  const posixAddressed = bootstrapFor("claude", "/tmp/prg-status/broker.sock");
  const outcome = prepared(await prepareNativeMcpLaunch(windowsInput("claude", parent, new RecordingWindowsPolicy(), { bootstrap: posixAddressed })));
  let attempts = 0;
  const client = new StdioClient();
  const result = await runNativeMcpRelay({
    argv: claudeRelayArgv(outcome), env: {}, input: client.input, output: client.output, platform: "win32",
    permissions: new RecordingWindowsPolicy(), connect: () => { attempts += 1; throw new Error("never dialed"); },
  });
  assert.deepEqual(result, { status: "unprotected" });
  assert.equal(attempts, 0, "no hello (token) was sent");
  await outcome.lease.cleanup();
  assert.deepEqual(fs.readdirSync(parent), []);
});
