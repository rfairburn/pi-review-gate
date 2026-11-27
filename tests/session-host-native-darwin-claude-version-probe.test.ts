import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstatSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";

import { CLAUDE_INBOX_MIN_CLI_VERSION } from "../src/session-host/native-claude-inbox-delivery";
import { probeClaudeInboxCompatibility } from "../src/session-host/native-claude-version-probe";
import {
  DARWIN_ACL_LISTING_TOOL,
  DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS,
  DARWIN_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  assessDarwinDirectSpawnPrecondition,
  classifyDarwinNativeExecutable,
  createDarwinAclProof,
  probeDarwinClaudeVersion,
  type DarwinClaudeVersionOutcome,
  type DarwinClaudeVersionProbeDeps,
  type DarwinClaudeVersionProbeRequest,
  type DarwinFileFacts,
  type DarwinProbeChild,
  type DarwinProbeFileSystem,
} from "../src/session-host/native-darwin-claude-version-probe";

/**
 * #682: dormant Darwin Claude version evidence.
 *
 * Every portable case injects the filesystem, ACL proof, spawn, kill, clock,
 * and runtime facts: no process, Claude binary, provider, network, or real
 * filesystem object is touched. The optional Darwin-only leg probes a real
 * system executable and is skipped explicitly elsewhere.
 */

const SUPPORTED = CLAUDE_INBOX_MIN_CLI_VERSION;
const EUID = 501;
const PID = 4242;
const DIR = "/Users/dev/.local/share/claude/versions";
const FILE = `${DIR}/${SUPPORTED}`;
const ANCESTORS = ["/", "/Users", "/Users/dev", "/Users/dev/.local", "/Users/dev/.local/share", "/Users/dev/.local/share/claude", DIR];
const RUNTIME = Object.freeze({ platform: "darwin" as const, uvVersion: "1.51.0", osRelease: "24.6.0" });
const OUT = `${SUPPORTED} (Claude Code)\n`;

// ---------------------------------------------------------------------------
// Synthetic executables

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

function machO(options: { cpu?: number; filetype?: number; magic?: number; ncmds?: number; sizeofcmds?: number; size?: number; bigEndian?: boolean } = {}): Buffer {
  const bytes = Buffer.alloc(options.size ?? 16_384);
  const write = (value: number, at: number) => (options.bigEndian ? bytes.writeUInt32BE(value, at) : bytes.writeUInt32LE(value, at));
  write(options.magic ?? 0xfeedfacf, 0);
  write(options.cpu ?? CPU_ARM64, 4);
  write(0, 8);
  write(options.filetype ?? 2, 12);
  write(options.ncmds ?? 4, 16);
  write(options.sizeofcmds ?? 512, 20);
  return bytes;
}

interface FatSlice { cpu: number; offset: number; size: number; align: number; body?: Buffer }

function fat(slices: readonly FatSlice[], options: { wide?: boolean; count?: number; total?: number } = {}): Buffer {
  const wide = options.wide ?? false;
  const total = options.total ?? Math.max(...slices.map((slice) => slice.offset + slice.size), 8192);
  const bytes = Buffer.alloc(total);
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  bytes.writeUInt32BE(options.count ?? slices.length, 4);
  slices.forEach((slice, index) => {
    const at = 8 + index * (wide ? 32 : 20);
    bytes.writeUInt32BE(slice.cpu, at);
    bytes.writeUInt32BE(0, at + 4);
    if (wide) {
      bytes.writeBigUInt64BE(BigInt(slice.offset), at + 8);
      bytes.writeBigUInt64BE(BigInt(slice.size), at + 16);
      bytes.writeUInt32BE(slice.align, at + 24);
    } else {
      bytes.writeUInt32BE(slice.offset, at + 8);
      bytes.writeUInt32BE(slice.size, at + 12);
      bytes.writeUInt32BE(slice.align, at + 16);
    }
    const body = slice.body ?? machO({ cpu: slice.cpu, size: Math.min(slice.size, 4096) });
    body.copy(bytes, slice.offset, 0, Math.min(body.length, slice.size, total - slice.offset));
  });
  return bytes;
}

const universal = (): Buffer => fat([
  { cpu: CPU_X86_64, offset: 16_384, size: 16_384, align: 14 },
  { cpu: CPU_ARM64, offset: 32_768, size: 16_384, align: 14 },
]);

const padded = (text: string, size = 8192): Buffer => {
  const bytes = Buffer.alloc(size, 0x20);
  Buffer.from(text).copy(bytes);
  return bytes;
};

/** A Java class file: `cafebabe`, then minor/major version words. */
function javaClass(minor: number, major: number): Buffer {
  const bytes = Buffer.alloc(8192);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt16BE(minor, 4);
  bytes.writeUInt16BE(major, 6);
  bytes.writeUInt16BE(30, 8);
  return bytes;
}

const reader = (bytes: Buffer) => async (position: number, length: number) => bytes.subarray(position, position + length);
const classify = (bytes: Buffer) => classifyDarwinNativeExecutable(reader(bytes), BigInt(bytes.length));

// ---------------------------------------------------------------------------
// Injected world

let nextIno = 100n;

function facts(mode: number, uid: number, size = 0n, extra: Partial<DarwinFileFacts> = {}): DarwinFileFacts {
  nextIno += 1n;
  return { dev: 16777220n, ino: nextIno, mode, uid, size, mtimeNs: 1_700_000_000_000_000_000n, ctimeNs: 1_700_000_000_000_000_000n, ...extra };
}

interface World {
  entries: Map<string, DarwinFileFacts>;
  content: Buffer;
  /** Facts the descriptor reports; defaults to the path's lstat facts. */
  openedFacts?: DarwinFileFacts;
  openError?: Error;
  lstatHook?: (path: string, count: number) => DarwinFileFacts | Error | "hang" | undefined;
  lstatCount: number;
  opens: number;
  closes: number;
  aclCalls: string[];
  aclVerdicts: Map<string, AclVerdict>;
  /** Replaces the verdict for one path (for example a stalled or stale proof). */
  aclHook?: (path: string) => Promise<AclVerdict> | undefined;
  /** Signals other than signal 0 sent after the leader was reaped: must stay 0. */
  postReapSignals: number;
  spawns: Array<{ file: string; args: string[]; options: SpawnOptions }>;
  kills: Array<[number, NodeJS.Signals | 0]>;
  child?: SyntheticChild;
  groupHelpers: number;
  killIneffective: boolean;
  eperm: boolean;
  leaderIgnoresKill: boolean;
  /** Runs when a SIGKILL reaches an unreaped leader, before its reap is scheduled. */
  onSigkill?: () => void;
}

type AclVerdict = "no-acl" | "owner-only" | "untrusted" | "unprovable" | "cleanup-unconfirmed";

/** Every world built by a test, checked after it for post-reap signals. */
const worlds: World[] = [];

afterEach(() => {
  for (const w of worlds.splice(0)) {
    assert.equal(w.postReapSignals, 0, "a reaped (possibly recycled) process group is never signalled");
  }
});

function world(content: Buffer = machO()): World {
  const entries = new Map<string, DarwinFileFacts>();
  for (const path of ANCESTORS) entries.set(path, facts(0o040755, path === "/" || path === "/Users" ? 0 : EUID));
  entries.set(FILE, facts(0o100755, EUID, BigInt(content.length)));
  const w: World = {
    entries, content, lstatCount: 0, opens: 0, closes: 0, aclCalls: [], aclVerdicts: new Map(), postReapSignals: 0, spawns: [], kills: [],
    groupHelpers: 0, killIneffective: false, eperm: false, leaderIgnoresKill: false,
  };
  worlds.push(w);
  return w;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function fileSystem(w: World): DarwinProbeFileSystem {
  return {
    lstat: async (path) => {
      w.lstatCount += 1;
      const hooked = w.lstatHook?.(path, w.lstatCount);
      if (hooked === "hang") return new Promise<never>(() => { /* never settles */ });
      if (hooked instanceof Error) throw hooked;
      if (hooked !== undefined) return hooked;
      const entry = w.entries.get(path);
      if (entry === undefined) throw errno("ENOENT");
      return entry;
    },
    openNoFollow: async (path) => {
      if (w.openError !== undefined) throw w.openError;
      assert.equal(path, FILE);
      w.opens += 1;
      return {
        stat: async () => w.openedFacts ?? w.entries.get(FILE)!,
        read: async (position, length) => w.content.subarray(position, position + length),
        close: async () => { w.closes += 1; },
      };
    },
  };
}

type SyntheticChild = DarwinProbeChild & EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  unrefs: number;
  leaderAlive: boolean;
  finish(status: number | null, signal: NodeJS.Signals | null): void;
};

function syntheticChild(w: World, pid: number | undefined): SyntheticChild {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unrefs: 0,
    leaderAlive: pid !== undefined,
    unref(): void { child.unrefs += 1; },
    finish(status: number | null, signal: NodeJS.Signals | null): void {
      if (!child.leaderAlive) return;
      child.leaderAlive = false;
      child.emit("exit", status, signal);
      setImmediate(() => child.emit("close", status, signal));
    },
  }) as unknown as SyntheticChild;
  w.child = child;
  return child;
}

type Behavior = (child: SyntheticChild) => void;

/** Answers `text` on stdout and exits cleanly. */
const answers = (text: string, status: number | null = 0, signal: NodeJS.Signals | null = null): Behavior => (child) => {
  setImmediate(() => {
    child.stdout.write(text);
    setImmediate(() => child.finish(status, signal));
  });
};

function deps(w: World, behavior: Behavior = answers(OUT), extra: Partial<DarwinClaudeVersionProbeDeps> = {}): DarwinClaudeVersionProbeDeps {
  return {
    runtime: RUNTIME,
    effectiveUid: () => EUID,
    fs: fileSystem(w),
    acl: async (path) => {
      w.aclCalls.push(path);
      return w.aclHook?.(path) ?? w.aclVerdicts.get(path) ?? "no-acl";
    },
    spawn: (file, args, options) => {
      w.spawns.push({ file, args: [...args], options });
      const child = syntheticChild(w, PID);
      behavior(child);
      return child;
    },
    kill: (pid, signal) => {
      w.kills.push([pid, signal]);
      assert.equal(pid, -PID, "only the owned process group is ever signalled");
      if (w.eperm) throw errno("EPERM");
      const leaderAlive = w.child?.leaderAlive === true;
      if (signal === 0) {
        if (!leaderAlive && w.groupHelpers === 0) throw errno("ESRCH");
        return;
      }
      if (!leaderAlive) w.postReapSignals += 1;
      if (w.killIneffective) return;
      w.groupHelpers = 0;
      if (leaderAlive) w.onSigkill?.();
      if (leaderAlive && !w.leaderIgnoresKill) setImmediate(() => w.child?.finish(null, "SIGKILL"));
    },
    ...extra,
  };
}

function request(w: World, behavior?: Behavior, extra: Partial<DarwinClaudeVersionProbeDeps> = {}, overrides: Partial<DarwinClaudeVersionProbeRequest> = {}): DarwinClaudeVersionProbeRequest {
  const target = w.entries.get(FILE)!;
  return {
    file: FILE,
    identity: { dev: target.dev, ino: target.ino },
    cwd: "/Users/dev/project",
    env: { HOME: "/Users/dev", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    deps: deps(w, behavior, extra),
    ...overrides,
  };
}

const refusal = (reason: string): DarwinClaudeVersionOutcome => ({ evidence: "refused", reason } as DarwinClaudeVersionOutcome);
const VERIFIED: DarwinClaudeVersionOutcome = { evidence: "version", version: SUPPORTED };

function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

// ---------------------------------------------------------------------------
// Format recognition

test("thin and fat 64-bit Mach-O executables are recognized with only the needed evidence", async () => {
  assert.equal(await classify(machO({ cpu: CPU_ARM64 })), "mach-o");
  assert.equal(await classify(machO({ cpu: CPU_X86_64 })), "mach-o");
  // A compact executable need not fill a page: only header + load commands must fit.
  assert.equal(await classify(machO({ cpu: CPU_X86_64, size: 2048 })), "mach-o");
  assert.equal(await classify(machO({ sizeofcmds: 512, size: 32 + 512 })), "mach-o");
  assert.equal(await classify(universal()), "fat-mach-o");
  assert.equal(await classify(fat([
    { cpu: CPU_X86_64, offset: 16_384, size: 16_384, align: 14 },
    { cpu: CPU_ARM64, offset: 32_768, size: 16_384, align: 14 },
  ], { wide: true })), "fat-mach-o");
  // An unrecognized extra slice (i386) is bounds-checked, not required to parse.
  assert.equal(await classify(fat([
    { cpu: 7, offset: 4096, size: 4096, align: 12, body: Buffer.alloc(4096, 0x41) },
    { cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14 },
  ])), "fat-mach-o");
});

test("scripts, Java class files, and Mach-O lookalikes are never native executables", async () => {
  const cases: Record<string, Buffer> = {
    "shebang script": padded("#!/bin/sh\necho 2.1.330 (Claude Code)\n"),
    "env shebang": padded("#!/usr/bin/env node\nconsole.log('x')\n"),
    "plain text": padded("echo 2.1.330 (Claude Code)\n"),
    "java class (major 52)": javaClass(0, 52),
    "java class (major 45, minor 3)": javaClass(3, 45),
    "java class (major 65)": javaClass(0, 65),
    "32-bit Mach-O": machO({ magic: 0xfeedface }),
    "big-endian Mach-O": machO({ bigEndian: true }),
    "dylib": machO({ filetype: 6 }),
    "bundle": machO({ filetype: 8 }),
    "object file": machO({ filetype: 1 }),
    "unknown cpu": machO({ cpu: 0x12 }),
    "no load commands": machO({ ncmds: 0 }),
    "load commands past end": machO({ sizeofcmds: 20_000 }),
    "truncated executable": machO({ size: 256 }),
    "load commands one byte past EOF": machO({ sizeofcmds: 512, size: 32 + 511 }),
    "shorter than a Mach-O header": machO({ size: 31 }),
    "fat with zero entries": fat([{ cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14 }], { count: 0 }),
    "fat with too many entries": fat([{ cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14 }], { count: 9 }),
    // Nine otherwise valid entries: only the entry bound refuses this one.
    "fat with nine valid entries": fat([
      { cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14 },
      ...Array.from({ length: 8 }, (_, index) => ({ cpu: 7, offset: 32_768 + index * 4096, size: 4096, align: 12, body: Buffer.alloc(0) })),
    ]),
    "fat slice not Mach-O": fat([{ cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14, body: padded("#!/bin/sh\n", 4096) }]),
    "fat slice cpu mismatch": fat([{ cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14, body: machO({ cpu: CPU_X86_64, size: 4096 }) }]),
    "fat slice dylib": fat([{ cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14, body: machO({ filetype: 6, size: 4096 }) }]),
    "fat only unknown cpus": fat([{ cpu: 18, offset: 16_384, size: 16_384, align: 14 }]),
    "fat misaligned slice": fat([{ cpu: CPU_ARM64, offset: 16_400, size: 16_000, align: 14 }]),
    "fat alignment too large": fat([{ cpu: CPU_ARM64, offset: 65_536, size: 16_384, align: 16 }]),
    "fat slice inside table": fat([{ cpu: CPU_ARM64, offset: 8, size: 4096, align: 0, body: Buffer.alloc(0) }]),
    "fat slice past end": fat([{ cpu: CPU_ARM64, offset: 16_384, size: 16_384, align: 14 }], { total: 20_000 }),
    "fat overlapping slices": fat([
      { cpu: CPU_X86_64, offset: 16_384, size: 32_768, align: 14 },
      { cpu: CPU_ARM64, offset: 32_768, size: 16_384, align: 14 },
    ]),
    "empty": Buffer.alloc(0),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assert.equal(await classify(bytes), null, name);
  }
  // A size the reader cannot back up, or a short read, is never evidence.
  assert.equal(await classifyDarwinNativeExecutable(async () => Buffer.alloc(10), 16_384n), null);
});

// ---------------------------------------------------------------------------
// Runtime precondition

test("the direct-spawn precondition is satisfied only by Darwin with known posix_spawn facts", () => {
  assert.equal(assessDarwinDirectSpawnPrecondition(RUNTIME), "satisfied");
  assert.equal(assessDarwinDirectSpawnPrecondition({ ...RUNTIME, uvVersion: "1.44.2" }), "satisfied");
  assert.equal(assessDarwinDirectSpawnPrecondition({ ...RUNTIME, osRelease: "19.0.0" }), "satisfied");
  for (const facts of [
    { ...RUNTIME, platform: "linux" as const },
    { ...RUNTIME, uvVersion: "1.44.1" },
    { ...RUNTIME, uvVersion: "1.43.0" },
    { ...RUNTIME, uvVersion: undefined },
    { ...RUNTIME, uvVersion: "garbage" },
    { ...RUNTIME, osRelease: "18.7.0" },
    { ...RUNTIME, osRelease: "" },
  ]) {
    assert.equal(assessDarwinDirectSpawnPrecondition(facts), "unproven", JSON.stringify(facts));
  }
  assert.equal(assessDarwinDirectSpawnPrecondition(null as never), "unproven");
});

test("a non-Darwin host or an unproven runtime is refused before any filesystem or spawn work", async () => {
  const w = world();
  for (const [runtime, reason] of [
    [{ ...RUNTIME, platform: "linux" as const }, "unsupported-platform"],
    [{ ...RUNTIME, platform: "win32" as const }, "unsupported-platform"],
    [{ ...RUNTIME, uvVersion: "1.40.0" }, "runtime-precondition-unproven"],
    [{ ...RUNTIME, osRelease: "18.0.0" }, "runtime-precondition-unproven"],
  ] as const) {
    assert.deepEqual(await probeDarwinClaudeVersion(request(w, undefined, { runtime })), refusal(reason));
  }
  assert.equal(w.lstatCount, 0);
  assert.equal(w.spawns.length, 0);
  assert.equal(w.aclCalls.length, 0);
});

test("with production seams on a non-Darwin host the probe refuses without touching anything", { skip: process.platform === "darwin" ? "covered by the Darwin-only leg" : false }, async () => {
  assert.deepEqual(
    await probeDarwinClaudeVersion({ file: "/usr/bin/true", identity: { dev: 1n, ino: 1n }, cwd: "/", env: {} }),
    refusal("unsupported-platform"),
  );
});

// ---------------------------------------------------------------------------
// Happy path and exact spawn

test("a trusted direct native target yields exact version evidence from one exact direct spawn", async () => {
  for (const content of [machO(), machO({ cpu: CPU_X86_64 }), universal()]) {
    const w = world(content);
    const timersBefore = activeTimeouts();
    const req = request(w);
    assert.deepEqual(await probeDarwinClaudeVersion(req), VERIFIED);
    assert.equal(w.spawns.length, 1);
    const [{ file, args, options }] = w.spawns;
    assert.equal(file, FILE);
    assert.deepEqual(args, ["--version"]);
    assert.deepEqual(options, {
      cwd: "/Users/dev/project",
      env: { HOME: "/Users/dev", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    assert.notEqual(options.env, req.env, "the environment is copied, never shared");
    assert.deepEqual(w.aclCalls, [...ANCESTORS, FILE], "every ancestor and the target ACL is proven");
    assert.equal(w.opens, 1);
    assert.equal(w.closes, 1, "the descriptor is released");
    assert.deepEqual(w.kills, [[-PID, 0]], "the group is observed empty; nothing needed killing");
    assert.equal(w.child?.stdout.destroyed, true);
    assert.equal(w.child?.stderr.destroyed, true);
    assert.equal(activeTimeouts(), timersBefore, "no timer outlives the probe");
  }
});

test("root-owned trusted paths, sticky root directories, and owner-only ACLs are accepted", async () => {
  const w = world();
  w.entries.set("/Users/dev/.local", facts(0o041777, 0));
  const target = facts(0o100755, 0, BigInt(w.content.length));
  w.entries.set(FILE, target);
  w.aclVerdicts.set("/Users/dev", "owner-only");
  assert.deepEqual(await probeDarwinClaudeVersion(request(w)), VERIFIED);
});

// ---------------------------------------------------------------------------
// Request refusals

test("malformed requests are refused before any work", async () => {
  const w = world();
  const bad: Array<[string, Partial<DarwinClaudeVersionProbeRequest>, Partial<DarwinClaudeVersionProbeDeps>?]> = [
    ["relative", { file: "claude" }],
    ["dot-relative", { file: "./claude" }],
    ["root", { file: "/" }],
    ["trailing slash", { file: `${FILE}/` }],
    ["dot-dot", { file: `${DIR}/../versions/${SUPPORTED}` }],
    ["dot segment", { file: `${DIR}/./${SUPPORTED}` }],
    ["double slash", { file: `${DIR}//${SUPPORTED}` }],
    ["NUL", { file: `${FILE}\0` }],
    ["too long", { file: `/${"a".repeat(1100)}` }],
    ["long component", { file: `/Users/${"a".repeat(256)}` }],
    ["non-string", { file: 7 as never }],
    ["no identity", { identity: undefined as never }],
    ["number identity", { identity: { dev: 1, ino: 2 } as never }],
    ["relative cwd", { cwd: "project" }],
    ["env non-string", { env: { HOME: 1 as never } }],
    ["env NUL", { env: { HOME: "/Users/dev\0x" } }],
    ["env key with =", { env: { "A=B": "c" } }],
    ["env hook marker", { env: { PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP: "x" } }],
    ["env review marker", { env: { PI_REVIEW_GATE_NATIVE_REVIEW_BOOTSTRAP: "x" } }],
    ["env array", { env: [] as never }],
    ["widened timeout", {}, { timeoutMs: DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS + 1 }],
    ["widened cleanup", {}, { cleanupMs: DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS + 1 }],
    ["widened cap", {}, { maxOutputBytes: DARWIN_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES + 1 }],
    ["zero timeout", {}, { timeoutMs: 0 }],
  ];
  for (const [name, overrides, extra] of bad) {
    assert.deepEqual(await probeDarwinClaudeVersion(request(w, undefined, extra ?? {}, overrides)), refusal("invalid-request"), name);
  }
  assert.deepEqual(await probeDarwinClaudeVersion(null as never), refusal("invalid-request"));
  assert.equal(w.lstatCount, 0);
  assert.equal(w.spawns.length, 0);
});

// ---------------------------------------------------------------------------
// Path and target trust

test("linked, missing, foreign-owned, replaceable, or ACL-widened ancestors are refused", async () => {
  const cases: Array<[string, (w: World) => void]> = [
    ["symlinked ancestor", (w) => w.entries.set("/Users/dev/.local", facts(0o120755, EUID))],
    ["file as ancestor", (w) => w.entries.set("/Users/dev/.local", facts(0o100755, EUID))],
    ["missing ancestor", (w) => w.entries.delete("/Users/dev/.local/share")],
    ["foreign owner", (w) => w.entries.set("/Users/dev/.local/share", facts(0o040755, 502))],
    ["group writable", (w) => w.entries.set(DIR, facts(0o040775, EUID))],
    ["world writable", (w) => w.entries.set(DIR, facts(0o040777, EUID))],
    ["user-owned sticky world writable", (w) => w.entries.set(DIR, facts(0o041777, EUID))],
    ["root world writable without sticky", (w) => w.entries.set("/Users", facts(0o040777, 0))],
    ["untrusted ancestor ACL", (w) => w.aclVerdicts.set("/Users/dev", "untrusted")],
    ["unprovable ancestor ACL", (w) => w.aclVerdicts.set("/", "unprovable")],
  ];
  for (const [name, mutate] of cases) {
    const w = world();
    mutate(w);
    assert.deepEqual(await probeDarwinClaudeVersion(request(w)), refusal("untrusted-path"), name);
    assert.equal(w.spawns.length, 0, name);
  }
});

test("a target with an unexpected type, owner, mode, identity, or ACL is refused", async () => {
  const cases: Array<[string, string, (w: World) => void]> = [
    ["symlink target", "untrusted-target", (w) => w.entries.set(FILE, facts(0o120755, EUID, 16_384n))],
    ["directory target", "untrusted-target", (w) => w.entries.set(FILE, facts(0o040755, EUID, 16_384n))],
    ["fifo target", "untrusted-target", (w) => w.entries.set(FILE, facts(0o010755, EUID, 16_384n))],
    ["foreign owner", "untrusted-target", (w) => w.entries.set(FILE, facts(0o100755, 502, 16_384n))],
    ["group writable", "untrusted-target", (w) => w.entries.set(FILE, facts(0o100775, EUID, 16_384n))],
    ["world writable", "untrusted-target", (w) => w.entries.set(FILE, facts(0o100757, EUID, 16_384n))],
    ["setuid", "untrusted-target", (w) => w.entries.set(FILE, facts(0o104755, EUID, 16_384n))],
    ["setgid", "untrusted-target", (w) => w.entries.set(FILE, facts(0o102755, EUID, 16_384n))],
    ["not executable", "untrusted-target", (w) => w.entries.set(FILE, facts(0o100644, EUID, 16_384n))],
    ["root-owned without other execute", "untrusted-target", (w) => w.entries.set(FILE, facts(0o100750, 0, 16_384n))],
    ["open refuses a link", "untrusted-target", (w) => { w.openError = errno("ELOOP"); }],
    ["untrusted target ACL", "untrusted-target", (w) => w.aclVerdicts.set(FILE, "untrusted")],
    ["unprovable target ACL", "untrusted-target", (w) => w.aclVerdicts.set(FILE, "unprovable")],
    ["descriptor identity differs", "target-identity-mismatch", (w) => { w.openedFacts = facts(0o100755, EUID, 16_384n); }],
    ["descriptor content differs", "target-identity-mismatch", (w) => {
      const entry = w.entries.get(FILE)!;
      w.openedFacts = { ...entry, mtimeNs: entry.mtimeNs + 1n };
    }],
  ];
  for (const [name, reason, mutate] of cases) {
    const w = world();
    const req = request(w);
    mutate(w);
    assert.deepEqual(await probeDarwinClaudeVersion(req), refusal(reason), name);
    assert.equal(w.spawns.length, 0, name);
    assert.equal(w.opens, w.closes, `${name}: no descriptor leaks`);
  }

  // The caller's resolved identity must be the observed target.
  const w = world();
  assert.deepEqual(
    await probeDarwinClaudeVersion(request(w, undefined, {}, { identity: { dev: 16777220n, ino: 1n } })),
    refusal("target-identity-mismatch"),
  );
  assert.equal(w.opens, 0);
});

test("scripts and lookalikes at a trusted path are refused as non-native without spawning", async () => {
  for (const content of [padded("#!/bin/sh\necho 2.1.330 (Claude Code)\n"), javaClass(0, 52), machO({ filetype: 6 }), machO({ size: 256 })]) {
    const w = world(content);
    assert.deepEqual(await probeDarwinClaudeVersion(request(w)), refusal("non-native-executable"));
    assert.equal(w.spawns.length, 0);
    assert.equal(w.closes, 1);
  }
});

test("a change between the checks and the spawn, or across the run, is never evidence", async () => {
  // Replaced right before the spawn: the pre-spawn re-observation catches it.
  const pre = world();
  const chainLength = ANCESTORS.length + 1;
  pre.lstatHook = (path, count) => (count > chainLength && path === "/Users/dev/.local" ? facts(0o040755, EUID) : undefined);
  assert.deepEqual(await probeDarwinClaudeVersion(request(pre)), refusal("target-changed"));
  assert.equal(pre.spawns.length, 0);

  // Replaced during the run: the post-run re-observation catches it.
  for (const [name, swap] of [
    ["ancestor replaced", (path: string) => (path === "/Users/dev/.local/share" ? facts(0o040755, EUID) : undefined)],
    ["target rewritten", (path: string, w: World) => (path === FILE ? { ...w.entries.get(FILE)!, mtimeNs: 1n } : undefined)],
    ["target removed", (path: string) => (path === FILE ? errno("ENOENT") : undefined)],
  ] as const) {
    const w = world();
    w.lstatHook = (path, count) => (count > 2 * chainLength ? swap(path, w) : undefined);
    assert.deepEqual(await probeDarwinClaudeVersion(request(w)), refusal("target-changed"), name);
    assert.equal(w.spawns.length, 1, name);
  }
});

test("an ACL verdict is bound to identical before/after observations, change time included", async () => {
  const chainLength = ANCESTORS.length + 1;
  const ctimeBumped = (w: World, path: string): DarwinFileFacts => {
    const entry = w.entries.get(path)!;
    return { ...entry, ctimeNs: entry.ctimeNs + 1n };
  };

  // An ACL granted while the probe lists it: identity, mode, and owner are
  // unchanged, the listing it saw is stale, and only ctime moved.
  const racing = world();
  racing.aclHook = (path) => {
    if (path !== "/Users/dev") return undefined;
    racing.entries.set(path, ctimeBumped(racing, path));
    return Promise.resolve("no-acl");
  };
  assert.deepEqual(await probeDarwinClaudeVersion(request(racing)), refusal("target-changed"));
  assert.equal(racing.spawns.length, 0, "a stale ACL verdict never reaches a spawn");

  // A ctime-only ancestor change seen by the pre-spawn re-observation.
  const pre = world();
  pre.lstatHook = (path, count) => (count > chainLength && path === "/Users/dev/.local" ? ctimeBumped(pre, path) : undefined);
  assert.deepEqual(await probeDarwinClaudeVersion(request(pre)), refusal("target-changed"));
  assert.equal(pre.spawns.length, 0);

  // A ctime-only ancestor change during the run is never evidence.
  const post = world();
  post.lstatHook = (path, count) => (count > 2 * chainLength && path === "/" ? ctimeBumped(post, path) : undefined);
  assert.deepEqual(await probeDarwinClaudeVersion(request(post)), refusal("target-changed"));
  assert.equal(post.spawns.length, 1);
});

test("the post-run re-observation shares the final bound: a stalled or late observation is never evidence", async () => {
  const chainLength = ANCESTORS.length + 1;

  // Stalled post-run stat.
  const stalled = world();
  stalled.lstatHook = (_path, count) => (count > 2 * chainLength ? "hang" : undefined);
  const timersBefore = activeTimeouts();
  const started = Date.now();
  assert.deepEqual(await probeDarwinClaudeVersion(request(stalled, undefined, { timeoutMs: 60, cleanupMs: 40 })), refusal("timeout"));
  assert.ok(Date.now() - started < 1_000, "settles at timeout + cleanup bound");
  assert.equal(stalled.spawns.length, 1);
  assert.equal(activeTimeouts(), timersBefore, "no deadline timer outlives the probe");

  // A stalled post-run stat that returns late issues no further stat.
  const delayed = world();
  const { fs, state } = stallingFileSystem(delayed, 2 * chainLength + 2);
  assert.deepEqual(await probeDarwinClaudeVersion(request(delayed, undefined, { fs, timeoutMs: 60, cleanupMs: 40 })), refusal("timeout"));
  const issuedAtRefusal = state.issued;
  state.release?.();
  await settleTurns();
  assert.equal(state.issued, issuedAtRefusal, "no post-run stat is issued after the deadline");

  // Likewise for the pre-spawn re-observation.
  const pre = world();
  const preStall = stallingFileSystem(pre, chainLength + 2);
  assert.deepEqual(await probeDarwinClaudeVersion(request(pre, undefined, { fs: preStall.fs, timeoutMs: 40 })), refusal("timeout"));
  const preIssued = preStall.state.issued;
  preStall.state.release?.();
  await settleTurns();
  assert.equal(preStall.state.issued, preIssued, "no pre-spawn stat is issued after the deadline");
  assert.equal(pre.spawns.length, 0);

  // A post-run stat that succeeds, but only after the final bound.
  let clock = 0;
  const late = world();
  late.lstatHook = (_path, count) => {
    if (count === 2 * chainLength + 1) clock += DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS + DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS;
    return undefined;
  };
  assert.deepEqual(await probeDarwinClaudeVersion(request(late, undefined, { now: () => clock })), refusal("timeout"));

  // Control: the same flow inside the bound verifies.
  assert.deepEqual(await probeDarwinClaudeVersion(request(world(), undefined, { now: () => clock })), VERIFIED);
});

// ---------------------------------------------------------------------------
// Output grammar

test("only the exact official stdout form of a supported version is evidence", async () => {
  const cases: Array<[string, string, string?]> = [
    [`${SUPPORTED} (Claude Code)`, "version"],
    [`${SUPPORTED} (Claude Code)\r\n`, "version"],
    ["2.1.331 (Claude Code)\n", "version", "2.1.331"],
    [`launcher banner\n${SUPPORTED} (Claude Code)\n`, "version-unrecognized"],
    [`v${SUPPORTED} (Claude Code)\n`, "version-unrecognized"],
    [`${SUPPORTED} (Claude Code) \n`, "version-unrecognized"],
    [`${SUPPORTED}  (Claude Code)\n`, "version-unrecognized"],
    [`${SUPPORTED} (claude code)\n`, "version-unrecognized"],
    [`${SUPPORTED}\n`, "version-unrecognized"],
    [`${SUPPORTED} (Claude Code)\n\n`, "version-unrecognized"],
    [`${SUPPORTED}-beta (Claude Code)\n`, "version-unrecognized"],
    ["2.1 (Claude Code)\n", "version-unrecognized"],
    ["", "version-unrecognized"],
    ["2.1.330 (Claude Code) ", "version-unrecognized"],
    ["2.1.329 (Claude Code)\n", "version-unsupported"],
    ["9.9.9 (Claude Code)\n", "version", "9.9.9"],
  ];
  for (const [stdout, expected, observedVersion = SUPPORTED] of cases) {
    const w = world();
    const outcome = await probeDarwinClaudeVersion(request(w, answers(stdout)));
    assert.deepEqual(
      outcome,
      expected === "version" ? { evidence: "version", version: observedVersion } : refusal(expected),
      JSON.stringify(stdout),
    );
    // Grammar parity with the Linux classifier for the same stdout.
    const linux = await probeClaudeInboxCompatibility({ file: "/synthetic/claude", env: {}, cwd: "/", runner: async () => ({ kind: "completed", stdout }) });
    assert.equal(linux.compatibility === "verified", outcome.evidence === "version", `parity: ${JSON.stringify(stdout)}`);
  }
});

test("stderr is counted and discarded; nonzero exits and signals are refused", async () => {
  const noisy: Behavior = (child) => setImmediate(() => {
    child.stderr.write("warning: something\n");
    child.stdout.write(OUT);
    setImmediate(() => child.finish(0, null));
  });
  assert.deepEqual(await probeDarwinClaudeVersion(request(world(), noisy)), VERIFIED);
  assert.deepEqual(await probeDarwinClaudeVersion(request(world(), answers(OUT, 1))), refusal("abnormal-exit"));
  assert.deepEqual(await probeDarwinClaudeVersion(request(world(), answers(OUT, null, "SIGTERM"))), refusal("abnormal-exit"));
});

// ---------------------------------------------------------------------------
// Caps, deadline, spawn and stream failures

test("combined output past the cap stops the owned group and is refused", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const w = world();
    const chatty: Behavior = (child) => setImmediate(() => {
      child.stdout.write(OUT);
      child[stream].write(Buffer.alloc(DARWIN_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES, 0x41));
    });
    assert.deepEqual(await probeDarwinClaudeVersion(request(w, chatty)), refusal("oversized"), stream);
    assert.deepEqual(w.kills[0], [-PID, "SIGKILL"], `${stream}: the group is killed while the leader is unreaped`);
    assert.equal(w.child?.leaderAlive, false);
  }
});

test("a wedged child is stopped at the deadline, and a late clean close is never evidence", async () => {
  const w = world();
  const timersBefore = activeTimeouts();
  const started = Date.now();
  const outcome = await probeDarwinClaudeVersion(request(w, () => { /* never answers */ }, { timeoutMs: 60 }));
  assert.deepEqual(outcome, refusal("timeout"));
  assert.ok(Date.now() - started < 2_000, "settles near its bound");
  assert.deepEqual(w.kills[0], [-PID, "SIGKILL"]);
  assert.equal(activeTimeouts(), timersBefore);

  // A clean close observed at or past the monotonic deadline, before the timer.
  let clock = 0;
  const late = world();
  const lateClose: Behavior = (child) => setImmediate(() => {
    child.stdout.write(OUT);
    clock += DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS;
    child.finish(0, null);
  });
  assert.deepEqual(await probeDarwinClaudeVersion(request(late, lateClose, { now: () => clock })), refusal("timeout"));
});

/**
 * Wraps a world's filesystem so that the `stallAt`-th issued `lstat` (1-based)
 * waits for `release()`. `issued` counts every `lstat` the probe submits.
 */
function stallingFileSystem(w: World, stallAt: number) {
  const inner = fileSystem(w);
  const state = { issued: 0, release: undefined as (() => void) | undefined };
  const fs: DarwinProbeFileSystem = {
    ...inner,
    lstat: (path) => {
      state.issued += 1;
      if (state.issued !== stallAt) return inner.lstat(path);
      return new Promise((resolve, reject) => { state.release = () => { inner.lstat(path).then(resolve, reject); }; });
    },
  };
  return { fs, state };
}

const settleTurns = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test("a hung filesystem check settles at the deadline and issues nothing afterwards", async () => {
  // Stat 3 is "/Users/dev" (a middle ancestor); stat 7 is the last ancestor,
  // whose successor would be the target's own stat.
  for (const stallAt of [3, ANCESTORS.length]) {
    const w = world();
    const { fs, state } = stallingFileSystem(w, stallAt);
    const outcome = await probeDarwinClaudeVersion(request(w, undefined, { fs, timeoutMs: 40 }));
    assert.deepEqual(outcome, refusal("timeout"), `stall at ${stallAt}`);
    const issuedAtRefusal = state.issued;
    state.release?.();
    await settleTurns();
    assert.equal(state.issued, issuedAtRefusal, `stall at ${stallAt}: no stat is issued after the stalled one returns late`);
    assert.equal(w.spawns.length, 0, "an abandoned check never spawns");
    assert.equal(w.opens, 0, "an abandoned check opens nothing afterwards");
    assert.deepEqual(w.aclCalls, [], "an abandoned check runs no ACL listing afterwards");
  }
});

test("a delayed header read past the deadline issues no further read, and the descriptor is still closed", async () => {
  const w = world(universal());
  const inner = fileSystem(w);
  const reads: number[] = [];
  let release: (() => void) | undefined;
  const fs: DarwinProbeFileSystem = {
    ...inner,
    openNoFollow: async (path) => {
      const handle = await inner.openNoFollow(path);
      return {
        ...handle,
        read: (position, length, checkDeadline) => {
          checkDeadline?.();
          reads.push(position);
          if (position !== 0) return handle.read(position, length);
          return new Promise((resolve) => { release = () => { resolve(handle.read(position, length)); }; });
        },
      };
    },
  };
  assert.deepEqual(await probeDarwinClaudeVersion(request(w, undefined, { fs, timeoutMs: 40 })), refusal("timeout"));
  release?.();
  await settleTurns();
  assert.deepEqual(reads, [0], "no fat-slice read follows the late header read");
  assert.equal(w.opens, 1);
  assert.equal(w.closes, 1, "descriptor cleanup still runs");
  assert.equal(w.spawns.length, 0);
});

test("a stalled ACL proof settles at the shared deadline and never spawns", async () => {
  const w = world();
  w.aclHook = (path) => (path === "/Users/dev" ? new Promise<never>(() => { /* never settles */ }) : undefined);
  const timersBefore = activeTimeouts();
  const started = Date.now();
  assert.deepEqual(await probeDarwinClaudeVersion(request(w, undefined, { timeoutMs: 50 })), refusal("timeout"));
  assert.ok(Date.now() - started < 1_000);
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(w.aclCalls, ["/", "/Users", "/Users/dev"], "no listing starts after the stalled one");
  assert.equal(activeTimeouts(), timersBefore);
});

test("an ACL listing whose cleanup is unconfirmed refuses with that uncertainty, never a spawn", async () => {
  const w = world();
  w.aclHook = (path) => (path === "/Users/dev" ? Promise.resolve<AclVerdict>("cleanup-unconfirmed") : undefined);
  assert.deepEqual(await probeDarwinClaudeVersion(request(w)), refusal("cleanup-unconfirmed"));
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(w.aclCalls, ["/", "/Users", "/Users/dev"]);
});

test("a signal-0 observation that lands past the cleanup bound is never confirmation", async () => {
  let clock = 0;
  const w = world();
  const base = deps(w);
  const lateObservation = (pid: number, signal: NodeJS.Signals | 0): void => {
    // The observation starts in time but its ESRCH answer is seen after the
    // cleanup bound, still well inside the overall probe deadline.
    if (signal === 0) clock += 101;
    base.kill!(pid, signal);
  };
  assert.deepEqual(
    await probeDarwinClaudeVersion(request(w, undefined, { now: () => clock, cleanupMs: 100, kill: lateObservation })),
    refusal("cleanup-unconfirmed"),
  );
  assert.deepEqual(w.kills, [[-PID, 0]], "one observation, no signal");

  // Control: the same observation inside the bound confirms and verifies.
  let inTime = 0;
  const control = world();
  const controlBase = deps(control);
  assert.deepEqual(
    await probeDarwinClaudeVersion(request(control, undefined, {
      now: () => inTime,
      cleanupMs: 100,
      kill: (pid, signal) => { if (signal === 0) inTime += 99; controlBase.kill!(pid, signal); },
    })),
    VERIFIED,
  );
});

test("version-child cleanup ends at the absolute bound: a late reap or late settlement is never confirmation", async () => {
  // The leader is reaped only after the clock passed deadline + cleanup.
  let clock = 0;
  const lateReap = world();
  lateReap.onSigkill = () => { clock += DARWIN_CLAUDE_VERSION_PROBE_TIMEOUT_MS + DARWIN_CLAUDE_VERSION_PROBE_CLEANUP_MS; };
  assert.deepEqual(
    await probeDarwinClaudeVersion(request(lateReap, () => { /* wedged */ }, { now: () => clock, timeoutMs: 50 })),
    refusal("cleanup-unconfirmed"),
  );
  assert.deepEqual(lateReap.kills[0], [-PID, "SIGKILL"], "the unreaped leader is still killed");

  // The timeout settlement itself is observed after the absolute bound: no fresh window opens.
  let late = 0;
  const lateSettle = world();
  const timer = setTimeout(() => { late = 10_000; }, 20);
  const started = Date.now();
  assert.deepEqual(
    await probeDarwinClaudeVersion(request(lateSettle, () => { /* wedged */ }, { now: () => late, timeoutMs: 50, cleanupMs: 100 })),
    refusal("cleanup-unconfirmed"),
  );
  clearTimeout(timer);
  assert.ok(Date.now() - started < 1_000);
});

test("spawn and stream failures are refused and settle without leaks", async () => {
  const thrown = world();
  assert.deepEqual(await probeDarwinClaudeVersion(request(thrown, undefined, { spawn: () => { throw new TypeError("bad"); } })), refusal("spawn-failed"));

  const noPid = world();
  const failing = { ...deps(noPid), spawn: () => {
    const child = syntheticChild(noPid, undefined);
    setImmediate(() => { child.emit("error", errno("ENOENT")); child.emit("close", -2, null); });
    return child;
  } };
  assert.deepEqual(await probeDarwinClaudeVersion(request(noPid, undefined, failing)), refusal("spawn-failed"));
  assert.deepEqual(noPid.kills, [], "no group exists, so none is signalled");

  for (const stream of ["stdout", "stderr"] as const) {
    const w = world();
    const broken: Behavior = (child) => setImmediate(() => {
      child.stdout.write(OUT);
      child[stream].emit("error", new Error("synthetic read failure"));
    });
    assert.deepEqual(await probeDarwinClaudeVersion(request(w, broken)), refusal("output-failed"), stream);
    assert.deepEqual(w.kills[0], [-PID, "SIGKILL"], stream);
  }
});

// ---------------------------------------------------------------------------
// Production ACL proof (spawn seam only; no real listing tool runs)

interface AclChild extends EventEmitter {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: null;
  kills: NodeJS.Signals[];
  unrefs: number;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

/**
 * `reaps` (default): a SIGKILL is followed by `exit` and `close`, as a real
 * reaped child would be. `false`: the child is never reaped (wedged in I/O).
 */
function aclHarness(behavior: (child: AclChild) => void, harnessOptions: { reaps?: boolean; pid?: number | undefined } = {}) {
  const calls: Array<{ file: string; args: string[]; options: SpawnOptions }> = [];
  const children: AclChild[] = [];
  const spawnAcl = (file: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ file, args: [...args], options });
    const child = Object.assign(new EventEmitter(), {
      pid: "pid" in harnessOptions ? harnessOptions.pid : 777,
      stdout: new PassThrough(),
      stderr: null,
      kills: [] as NodeJS.Signals[],
      unrefs: 0,
      kill(signal?: NodeJS.Signals): boolean {
        child.kills.push(signal ?? "SIGTERM");
        if (harnessOptions.reaps !== false) {
          setImmediate(() => {
            child.emit("exit", null, signal ?? "SIGTERM");
            setImmediate(() => child.emit("close", null, signal ?? "SIGTERM"));
          });
        }
        return true;
      },
      unref(): void { child.unrefs += 1; },
    }) as AclChild;
    children.push(child);
    behavior(child);
    return child as unknown as DarwinProbeChild;
  };
  return { calls, children, spawnAcl };
}

const listing = (text: string, status = 0) => (child: AclChild) => setImmediate(() => {
  child.stdout.end(text);
  child.emit("exit", status, null);
  setImmediate(() => child.emit("close", status, null));
});

const LISTED = "drwxr-xr-x  5 dev  staff  160 Jan  1 00:00 /Users/dev\n";

test("the production ACL proof lists one object directly with a fixed tool and classifies it with the shared parser", async () => {
  const deadline = () => performance.now() + 2_000;
  const plain = aclHarness(listing(LISTED));
  assert.equal(await createDarwinAclProof(plain.spawnAcl)("/Users/dev", deadline()), "no-acl");
  assert.deepEqual(plain.calls, [{
    file: DARWIN_ACL_LISTING_TOOL,
    args: ["-lde", "/Users/dev"],
    options: { env: { LC_ALL: "C", LANG: "C" }, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  }]);
  assert.equal(DARWIN_ACL_LISTING_TOOL, "/bin/ls");
  assert.deepEqual(plain.children[0]!.kills, [], "a listing that exits is never signalled");

  const denyOnly = aclHarness(listing(LISTED.replace("drwxr-xr-x ", "drwxr-xr-x+") + " 0: group:everyone deny delete\n"));
  assert.equal(await createDarwinAclProof(denyOnly.spawnAcl)("/Users/dev", deadline()), "owner-only");

  const granting = aclHarness(listing(LISTED.replace("drwxr-xr-x ", "drwxr-xr-x+") + " 0: group:staff allow add_file,delete_child\n"));
  assert.equal(await createDarwinAclProof(granting.spawnAcl)("/Users/dev", deadline()), "untrusted");

  for (const [name, behavior] of [
    ["nonzero exit", listing(LISTED, 1)],
    ["unparseable listing", listing("garbage\n")],
    ["empty ACL marker", listing(LISTED.replace("drwxr-xr-x ", "drwxr-xr-x+"))],
  ] as const) {
    const harness = aclHarness(behavior);
    assert.equal(await createDarwinAclProof(harness.spawnAcl)("/Users/dev", deadline()), "unprovable", name);
    assert.deepEqual(harness.children[0]!.kills, [], `${name}: an exited listing is never signalled`);
  }

  // A stream error forces termination; the reaped child is confirmed before the verdict.
  const broken = aclHarness((child) => setImmediate(() => child.stdout.emit("error", new Error("synthetic"))));
  assert.equal(await createDarwinAclProof(broken.spawnAcl)("/Users/dev", deadline()), "unprovable");
  assert.deepEqual(broken.children[0]!.kills, ["SIGKILL"]);
  assert.equal(broken.children[0]!.unrefs, 0, "a confirmed reap needs no unref");

  // A spawn error with no pid: no process exists, so nothing is signalled.
  const noPid = aclHarness((child) => setImmediate(() => child.emit("error", errno("ENOENT"))), { pid: undefined });
  assert.equal(await createDarwinAclProof(noPid.spawnAcl)("/Users/dev", deadline()), "unprovable");
  assert.deepEqual(noPid.children[0]!.kills, []);

  assert.equal(await createDarwinAclProof(() => { throw new TypeError("bad"); })("/Users/dev", deadline()), "unprovable");

  // Already past the deadline: nothing is spawned.
  const late = aclHarness(listing(LISTED));
  assert.equal(await createDarwinAclProof(late.spawnAcl)("/Users/dev", performance.now() - 1), "unprovable");
  assert.equal(late.calls.length, 0);
});

test("the production ACL proof never performs the parser's synchronous account lookup or infers ownership from an account", async (t) => {
  const os = require("node:os") as typeof import("node:os");
  const lookup = t.mock.method(os, "userInfo", () => ({ username: "dev", uid: EUID, gid: 20, shell: null, homedir: "/Users/dev" }));
  const deadline = () => performance.now() + 2_000;
  const withAcl = (entry: string) => aclHarness(listing(LISTED.replace("drwxr-xr-x ", "drwxr-xr-x+") + entry));

  // The current account's own named grant is not treated as owner-equivalent.
  const named = withAcl(" 0: user:dev allow add_file,delete_child\n");
  assert.equal(await createDarwinAclProof(named.spawnAcl)("/Users/dev", deadline()), "untrusted");
  // `owner@` grants and read-only grants to others are accepted.
  const owner = withAcl(" 0: owner@ allow add_file,delete_child\n");
  assert.equal(await createDarwinAclProof(owner.spawnAcl)("/Users/dev", deadline()), "owner-only");
  const readOnly = withAcl(" 0: group:everyone allow read,execute\n");
  assert.equal(await createDarwinAclProof(readOnly.spawnAcl)("/Users/dev", deadline()), "owner-only");
  assert.equal(lookup.mock.callCount(), 0, "no synchronous account lookup");
});

test("the production ACL proof is bounded by the probe deadline and its byte cap, and confirms its child's reap", async () => {
  const timersBefore = activeTimeouts();

  // Stalled listing that is reaped after SIGKILL: closed pipes, confirmed, no unref.
  const stalled = aclHarness(() => { /* never answers */ });
  const started = Date.now();
  assert.equal(await createDarwinAclProof(stalled.spawnAcl)("/Users/dev", performance.now() + 40), "unprovable");
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(stalled.children[0]!.kills, ["SIGKILL"]);
  assert.equal(stalled.children[0]!.stdout.destroyed, true);
  assert.equal(stalled.children[0]!.unrefs, 0);

  // Stalled listing that is never reaped: uncertainty is retained, bounded by the cleanup window.
  const wedged = aclHarness(() => { /* never answers */ }, { reaps: false });
  const wedgedStart = Date.now();
  assert.equal(await createDarwinAclProof(wedged.spawnAcl, undefined, 30)("/Users/dev", performance.now() + 30), "cleanup-unconfirmed");
  assert.ok(Date.now() - wedgedStart < 1_000);
  assert.deepEqual(wedged.children[0]!.kills, ["SIGKILL"]);
  assert.equal(wedged.children[0]!.stdout.destroyed, true, "pipes are closed");
  assert.equal(wedged.children[0]!.unrefs, 1, "the unconfirmed child cannot hold the host");

  // A reap observed only after the cleanup window is not confirmation.
  let lateClock = 0;
  const lateReap = aclHarness(() => { /* never answers */ }, { reaps: false });
  const lateProof = createDarwinAclProof(lateReap.spawnAcl, () => lateClock, 50)("/Users/dev", 20);
  setTimeout(() => {
    lateClock = 20 + 50;
    lateReap.children[0]!.emit("exit", null, "SIGKILL");
  }, 40);
  assert.equal(await lateProof, "cleanup-unconfirmed");

  // Oversized listing: forced termination, confirmed reap.
  const chatty = aclHarness((child) => setImmediate(() => child.stdout.write(Buffer.alloc(64 * 1024 + 1, 0x41))));
  assert.equal(await createDarwinAclProof(chatty.spawnAcl)("/Users/dev", performance.now() + 2_000), "unprovable");
  assert.deepEqual(chatty.children[0]!.kills, ["SIGKILL"]);
  assert.equal(activeTimeouts(), timersBefore, "no listing timer leaks");

  // A clean listing that closes only at or past the deadline is never trusted.
  let clock = 0;
  const late = aclHarness((child) => setImmediate(() => {
    child.stdout.end(LISTED);
    clock = 100;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  }));
  assert.equal(await createDarwinAclProof(late.spawnAcl, () => clock)("/Users/dev", 100), "unprovable");
  assert.deepEqual(late.children[0]!.kills, [], "an exited listing is never signalled");
});

// ---------------------------------------------------------------------------
// Owned process-group teardown

test("after the leader is reaped the group is only observed, never signalled", async () => {
  // A member that leaves on its own within the bound: confirmed by observation alone.
  const leaves = world();
  leaves.groupHelpers = 1;
  setTimeout(() => { leaves.groupHelpers = 0; }, 30);
  assert.deepEqual(await probeDarwinClaudeVersion(request(leaves)), VERIFIED);
  assert.ok(leaves.kills.length >= 2);
  assert.ok(leaves.kills.every(([, signal]) => signal === 0), "only signal-0 observation after the reap");

  // The id is still observed after the reap: a lingering member or a recycled
  // group is indistinguishable, so nothing is signalled and nothing is evidence.
  const recycled = world();
  recycled.groupHelpers = 1;
  assert.deepEqual(await probeDarwinClaudeVersion(request(recycled, undefined, { cleanupMs: 60 })), refusal("cleanup-unconfirmed"));
  assert.ok(recycled.kills.every(([, signal]) => signal === 0), "a potentially recycled group is never signalled");
});

test("cleanup that cannot be confirmed retains uncertainty instead of yielding evidence", async () => {
  const cases: Array<[string, Behavior, (w: World) => void]> = [
    ["member outlives a clean leader exit", answers(OUT), (w) => { w.groupHelpers = 1; }],
    ["timeout kill ineffective before the reap", () => { /* wedged */ }, (w) => { w.killIneffective = true; }],
    ["group membership unobservable", answers(OUT), (w) => { w.eperm = true; }],
    ["leader never reaped after a timeout kill", () => { /* wedged */ }, (w) => { w.leaderIgnoresKill = true; }],
  ];
  for (const [name, behavior, mutate] of cases) {
    const w = world();
    mutate(w);
    const timersBefore = activeTimeouts();
    const started = Date.now();
    const outcome = await probeDarwinClaudeVersion(request(w, behavior, { timeoutMs: 50, cleanupMs: 80 }));
    assert.deepEqual(outcome, refusal("cleanup-unconfirmed"), name);
    assert.ok(Date.now() - started < 2_000, `${name}: settles within its bounds`);
    assert.equal(w.child?.unrefs, 1, `${name}: the unconfirmed child cannot hold the host`);
    assert.equal(activeTimeouts(), timersBefore, `${name}: no poll timer leaks`);
  }
});

// ---------------------------------------------------------------------------
// Optional Darwin-only leg (no Claude, no provider)

test("Darwin only: real direct probe of a system executable that is not Claude", { skip: process.platform === "darwin" ? false : "real Darwin spawn semantics require macOS" }, async () => {
  const runtime = { platform: process.platform, uvVersion: process.versions.uv, osRelease: (await import("node:os")).release() };
  if (assessDarwinDirectSpawnPrecondition(runtime) !== "satisfied") return;
  // `/usr/bin/true` is a root-owned native executable that prints nothing.
  const file = "/usr/bin/true";
  const stats = lstatSync(file, { bigint: true });
  const outcome = await probeDarwinClaudeVersion({ file, identity: { dev: stats.dev, ino: stats.ino }, cwd: "/", env: {} });
  assert.ok(
    outcome.evidence === "refused" && ["version-unrecognized", "untrusted-path", "untrusted-target"].includes(outcome.reason),
    JSON.stringify(outcome),
  );
});
