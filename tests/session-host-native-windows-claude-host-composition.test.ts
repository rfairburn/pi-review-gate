/**
 * #682: the production composition of the reviewed Windows Claude managed
 * callback lane — the trusted PowerShell resolver, the exact version runner
 * factory, the callback-only custody composition's allowlisted direct
 * supervisor spawn, the launcher's Windows probe step, and the probe's
 * launcher adapter.
 *
 * Portable checks only: every process is a fake injected through a spawn seam,
 * every probe is a recording seam, and no PowerShell, Claude, provider, pipe,
 * or credential is touched. Real Windows acceptance of this composition is
 * separate work. Every fixture is removed in `finally`.
 */

import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstatSync, type BigIntStats } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { normalizeConfig } from "../src/config";
import { CLAUDE_INBOX_MIN_CLI_VERSION } from "../src/session-host/native-claude-inbox-delivery";
import {
  composeWindowsClaudeInboxCompatibility,
  createNativeCliLauncher,
  type NativeCliLauncherOptions,
} from "../src/session-host/native-cli-launch";
import type { PeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permission-policy";
import {
  classifyProtectedExecutableAclEvidence,
  type WindowsAclAceEvidence,
  type WindowsAclEvidence,
} from "../src/session-host/network/peer-state-windows-permissions";
import type { NativeHookBootstrap } from "../src/session-host/native-hook-protocol";
import type { NativeHookLaunchOutcome } from "../src/session-host/native-hook-launch-prep";
import type { NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpBootstrap } from "../src/session-host/native-mcp-protocol";
import { NATIVE_MCP_SERVER_NAME_PREFIX } from "../src/session-host/native-mcp-server-name";
import {
  WINDOWS_CLAUDE_CALLBACK_PLATFORM,
  buildWindowsClaudeCustodySupervisorEnvironment,
  createWindowsClaudeCallbackCustodyComposition,
  createWindowsClaudeVersionRunnerForHost,
  proveWindowsClaudeTargetTrust,
  resolveWindowsClaudePowerShell,
} from "../src/session-host/native-windows-claude-host-composition";
import {
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS,
  buildWindowsClaudeCustodySupervisorLaunch,
  type WindowsClaudeCustodySupervisorLaunch,
} from "../src/session-host/native-windows-claude-custody-scripts";
import {
  WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS,
  WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  buildWindowsClaudeVersionEnvironment,
  probeWindowsClaudeInboxCompatibility,
  windowsClaudeTargetAncestors,
  windowsImageOf,
  type WindowsClaudeVersionOutcome,
  type WindowsClaudeVersionProbe,
  type WindowsClaudeVersionProbeRequest,
  type WindowsExactImageRunSpec,
  type WindowsExactImageVersionRunner,
  type WindowsExecutableIdentity,
} from "../src/session-host/native-windows-claude-version-probe";

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const PWSH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\pwsh.exe`;
const DIR = String.raw`C:\Users\dev\AppData\Local\Programs\Claude`;
const FILE = `${DIR}\\claude.exe`;
const ROW = "11111111-1111-4111-8111-111111111111";
const PROFILE = String.raw`C:\Users\dev`;
const SUPPORTED = CLAUDE_INBOX_MIN_CLI_VERSION;
/** Synthetic same-user host environment; every value is fabricated test input. */
const HOST_ENV: NodeJS.ProcessEnv = Object.freeze({
  SystemRoot: String.raw`C:\Windows`,
  SystemDrive: "C:",
  windir: String.raw`C:\Windows`,
  TEMP: String.raw`C:\Users\dev\AppData\Local\Temp`,
  TMP: String.raw`C:\Users\dev\AppData\Local\Temp`,
  USERPROFILE: PROFILE,
  PATH: String.raw`C:\Windows\System32;C:\Users\dev\evil`,
  ANTHROPIC_API_KEY: "synthetic-provider-credential-never-forwarded",
  CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-never-forwarded",
});
const IDENTITY: WindowsExecutableIdentity = Object.freeze({
  dev: 3_221_225_473n, ino: 0x0001_0000_0000_2345n, size: 8192n,
  mtimeNs: 1_700_000_000_123_456_700n, ctimeNs: 1_700_000_100_000_000_000n,
});

/* ----------------------------------------------------------- PowerShell */

test("only the exact System32 Windows PowerShell 5.1 path is trusted; anything else is no PowerShell", () => {
  assert.equal(resolveWindowsClaudePowerShell(() => POWERSHELL), POWERSHELL);
  assert.equal(resolveWindowsClaudePowerShell(() => PWSH), undefined, "PowerShell 7 is not the reviewed host");
  assert.equal(resolveWindowsClaudePowerShell(() => null), undefined);
  assert.equal(resolveWindowsClaudePowerShell(() => undefined), undefined);
  assert.equal(resolveWindowsClaudePowerShell(() => "powershell.exe"), undefined, "never a bare name");
  assert.equal(resolveWindowsClaudePowerShell(() => String.raw`C:\Tools\powershell.exe`), undefined);
  assert.equal(resolveWindowsClaudePowerShell(() => { throw new Error("synthetic resolver failure"); }), undefined);
  assert.equal(WINDOWS_CLAUDE_CALLBACK_PLATFORM, "win32");
});

/* ------------------------------------------------------- version runner */

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  kill(): boolean {
    this.kills += 1;
    return true;
  }
}

function runSpec(): WindowsExactImageRunSpec {
  const ancestors = windowsClaudeTargetAncestors(FILE)!;
  const chain = ancestors.map((_path, index) => Object.freeze({ dev: IDENTITY.dev, ino: BigInt(100 + index), birthtimeNs: 1_500_000_000_000_000_000n + BigInt(index) * 100n }));
  return Object.freeze({
    file: FILE,
    args: Object.freeze(["--version"]),
    cwd: DIR,
    env: buildWindowsClaudeVersionEnvironment(HOST_ENV)!,
    image: Object.freeze({ ...IDENTITY, birthtimeNs: 1_600_000_000_000_000_000n }),
    cwdIdentity: chain[chain.length - 1]!,
    ancestorIdentities: Object.freeze(chain),
  });
}

test("the host version runner is the reviewed exact-image runner over the trusted PowerShell, or nothing", async () => {
  let spawns = 0;
  const neverSpawn = (): ChildProcess => { spawns += 1; throw new Error("unreachable"); };
  assert.equal(createWindowsClaudeVersionRunnerForHost({ resolvePowerShell: () => null, spawn: neverSpawn }), undefined);
  assert.equal(createWindowsClaudeVersionRunnerForHost({ resolvePowerShell: () => PWSH, spawn: neverSpawn }), undefined);
  assert.equal(spawns, 0, "no PowerShell, no runner, nothing started");

  const calls: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = [];
  const runner = createWindowsClaudeVersionRunnerForHost({
    resolvePowerShell: () => POWERSHELL,
    userProfile: () => PROFILE,
    spawn: (file, args, options) => {
      calls.push({ file, args: [...args], options });
      const child = new FakeChild();
      // Node reports no process was created: an `error` before `spawn`.
      setImmediate(() => child.emit("error", new Error("synthetic ENOENT")));
      return child as unknown as ChildProcess;
    },
  });
  assert.ok(runner);
  assert.equal(runner.binding, "exact-image-no-fallback");
  const receipt = await runner.run(runSpec(), {
    deadline: 5_000, cleanupMs: WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS, maxOutputBytes: WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  }, () => 0);
  assert.equal(receipt.exactChild, "not-created");
  assert.equal(calls.length, 1, "one direct spawn");
  const [{ file, args, options }] = calls;
  assert.equal(file, POWERSHELL, "the trusted PowerShell file itself");
  assert.ok(args.includes("-NoProfile") && args.includes("-EncodedCommand"));
  assert.equal(options.shell, false);
  assert.equal(options.detached, false);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(options.env, { ...buildWindowsClaudeVersionEnvironment(HOST_ENV)!, USERPROFILE: PROFILE },
    "the allowlist plus the helper-only same-user USERPROFILE");
});

/* ------------------------------------------------ custody composition */

function supervisorLaunch(overrides: Partial<Parameters<typeof buildWindowsClaudeCustodySupervisorLaunch>[0]> = {}): WindowsClaudeCustodySupervisorLaunch {
  return buildWindowsClaudeCustodySupervisorLaunch({
    powershellPath: POWERSHELL,
    ctlPipe: `prg682-ctl-${"a".repeat(32)}`,
    ctlNonce: "b".repeat(32),
    hookPipe: `prg682-hook-${"c".repeat(32)}`,
    hookControl: true,
    ...overrides,
  });
}

test("the supervisor environment is the allowlist plus the same-user helper USERPROFILE, or nothing", () => {
  const env = buildWindowsClaudeCustodySupervisorEnvironment(HOST_ENV, PROFILE);
  assert.deepEqual(env, { ...buildWindowsClaudeVersionEnvironment(HOST_ENV)!, USERPROFILE: PROFILE });
  assert.equal((env as Record<string, string> | undefined)?.PATH, "", "no host PATH");
  assert.ok(!JSON.stringify(env).includes("synthetic-"), "no provider or credential value");
  assert.equal(buildWindowsClaudeCustodySupervisorEnvironment(HOST_ENV, undefined), undefined);
  assert.equal(buildWindowsClaudeCustodySupervisorEnvironment(HOST_ENV, "relative\\profile"), undefined);
  assert.equal(buildWindowsClaudeCustodySupervisorEnvironment({ ...HOST_ENV, SystemRoot: undefined }, PROFILE), undefined);
  assert.equal(buildWindowsClaudeCustodySupervisorEnvironment({ ...HOST_ENV, Pi_Review_Gate_Native_Hook_Bootstrap: "{}" }, PROFILE), undefined,
    "a host carrying a hook bootstrap marker in any casing composes nothing");
});

test("the callback-only composition's one supervisor spawn is exactly the reviewed direct spawn, with no fallback", () => {
  const spawns: Array<{ file: string; args: readonly string[]; options: SpawnOptions }> = [];
  const child = new FakeChild() as unknown as ChildProcess;
  const composition = createWindowsClaudeCallbackCustodyComposition({
    resolvePowerShell: () => POWERSHELL,
    hostEnvironment: () => HOST_ENV,
    spawn: (file, args, options) => {
      spawns.push({ file, args: [...args], options });
      return child;
    },
  });
  assert.equal(composition.callbackOnly, true);
  assert.equal(composition.createAdapter, undefined, "the landed standalone adapter");
  assert.ok(Object.isFrozen(composition));
  const request = Object.freeze({ rowId: ROW, backend: "claude" as const, target: FILE, args: Object.freeze([]), workspace: DIR });
  const selected = composition.select(request);
  assert.ok(selected);
  assert.equal(selected.powershellPath, POWERSHELL);

  const launch = supervisorLaunch();
  assert.equal(selected.spawnSupervisor(launch), child, "the exact spawned handle is returned");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.file, POWERSHELL);
  assert.deepEqual(spawns[0]!.args, launch.args, "the renderer's exact argv");
  assert.deepEqual(spawns[0]!.options, {
    stdio: [...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS.stdio],
    windowsHide: true,
    detached: false,
    shell: false,
    env: { ...buildWindowsClaudeVersionEnvironment(HOST_ENV)!, USERPROFILE: PROFILE },
  });

  // Anything other than the reviewed launch is refused BEFORE any spawn.
  const refusals: Array<[string, WindowsClaudeCustodySupervisorLaunch]> = [
    ["another PowerShell file", { ...launch, file: String.raw`C:\Other\System32\WindowsPowerShell\v1.0\powershell.exe` }],
    ["a shell spawn", { ...launch, spawnOptions: { ...launch.spawnOptions, shell: true } as never }],
    ["a detached spawn", { ...launch, spawnOptions: { ...launch.spawnOptions, detached: true } as never }],
    ["inherited stdio", { ...launch, spawnOptions: { ...launch.spawnOptions, stdio: ["inherit", "pipe", "pipe"] } as never }],
    ["an extra spawn option", { ...launch, spawnOptions: { ...launch.spawnOptions, cwd: "C:\\" } as never }],
    ["a non-string argument", { ...launch, args: [...launch.args, 7] as never }],
  ];
  for (const [label, refused] of refusals) {
    assert.throws(() => selected.spawnSupervisor(refused), /not the reviewed direct spawn/, label);
  }
  assert.equal(spawns.length, 1, "no refused launch reached the spawn seam");
});

test("the callback-only composition declines before any effect without trusted PowerShell or a usable host environment", () => {
  let spawns = 0;
  const spawn = (): ChildProcess => { spawns += 1; return new FakeChild() as unknown as ChildProcess; };
  const request = Object.freeze({ rowId: ROW, backend: "claude" as const, target: FILE, args: Object.freeze([]), workspace: DIR });
  const declines: Array<[string, Parameters<typeof createWindowsClaudeCallbackCustodyComposition>[0]]> = [
    ["no PowerShell", { resolvePowerShell: () => null, hostEnvironment: () => HOST_ENV, spawn }],
    ["PowerShell 7", { resolvePowerShell: () => PWSH, hostEnvironment: () => HOST_ENV, spawn }],
    ["a throwing resolver", { resolvePowerShell: () => { throw new Error("synthetic"); }, hostEnvironment: () => HOST_ENV, spawn }],
    ["no USERPROFILE", { resolvePowerShell: () => POWERSHELL, hostEnvironment: () => ({ ...HOST_ENV, USERPROFILE: undefined }), spawn }],
    ["no SystemRoot", { resolvePowerShell: () => POWERSHELL, hostEnvironment: () => ({ ...HOST_ENV, SystemRoot: undefined }), spawn }],
    ["a throwing environment", { resolvePowerShell: () => POWERSHELL, hostEnvironment: () => { throw new Error("synthetic"); }, spawn }],
  ];
  for (const [label, options] of declines) {
    assert.equal(createWindowsClaudeCallbackCustodyComposition(options).select(request), undefined, label);
  }

  // The exact wrapper render is preflighted: argv custody cannot carry is declined
  // before any process starts (the row keeps the ordinary direct launch).
  const composition = createWindowsClaudeCallbackCustodyComposition({
    resolvePowerShell: () => POWERSHELL, hostEnvironment: () => HOST_ENV, spawn,
  });
  assert.ok(composition.select({ ...request, args: ["--name", "a title with spaces & \"quotes\""] }), "a renderable argv is admitted");
  const unrenderable: Array<[string, readonly string[]]> = [
    ["an unpaired surrogate in a title", ["--name=title\uD800"]],
    ["a control character", ["--name=a\u0007b"]],
    ["a command line beyond the renderer's bound", ["x".repeat(20_000)]],
  ];
  for (const [label, args] of unrenderable) {
    assert.equal(composition.select({ ...request, args: Object.freeze([...args]) }), undefined, label);
  }
  assert.equal(composition.select({ ...request, target: String.raw`C:\Program Files\Claude\claude.cmd` }), undefined, "a non-.exe target");
  assert.equal(spawns, 0);
});

/* ------------------------------------------------------- probe adapter */

function recordingProbe(answer: WindowsClaudeVersionOutcome | (() => Promise<WindowsClaudeVersionOutcome>)): {
  probe: WindowsClaudeVersionProbe;
  calls: WindowsClaudeVersionProbeRequest[];
} {
  const calls: WindowsClaudeVersionProbeRequest[] = [];
  const probe: WindowsClaudeVersionProbe = async (request) => {
    calls.push(request);
    return typeof answer === "function" ? answer() : answer;
  };
  return { probe, calls };
}

const LIFECYCLE = Object.freeze({ launch: "suspended-image-name-matched", exactChild: "exited-clean", descendants: "witnessed-empty" } as const);
const evidence = (version: string, file = FILE): WindowsClaudeVersionOutcome =>
  Object.freeze({ evidence: "version", version, rowId: ROW, file, identity: IDENTITY, lifecycle: LIFECYCLE });
const RUNNER: WindowsExactImageVersionRunner = Object.freeze({
  binding: "exact-image-no-fallback" as const,
  run: async () => Object.freeze({ exactChild: "not-created" as const }),
});

const VERIFIED_IMAGE = windowsImageOf(FILE, IDENTITY);

test("the probe adapter probes the exact file, its own fingerprint, the row, and the supplied runner; only exact supported evidence verifies, with its image", async () => {
  const { probe, calls } = recordingProbe(evidence(SUPPORTED));
  const identities: string[] = [];
  const outcome = await probeWindowsClaudeInboxCompatibility({
    file: FILE, rowId: ROW, env: HOST_ENV, runner: RUNNER, probe,
    identity: async (file) => { identities.push(file); return IDENTITY; },
  });
  assert.deepEqual(outcome, { compatibility: "verified", version: SUPPORTED, windowsImage: VERIFIED_IMAGE });
  assert.deepEqual(VERIFIED_IMAGE, {
    file: FILE, dev: "3221225473", ino: String(0x0001_0000_0000_2345n), size: "8192",
    mtimeNs: "1700000000123456700", ctimeNs: "1700000100000000000",
  }, "a JSON-safe decimal fingerprint of the probed image");
  assert.equal(JSON.parse(JSON.stringify(outcome)).windowsImage.ino, VERIFIED_IMAGE.ino);
  assert.ok(Object.isFrozen(outcome));
  assert.deepEqual(identities, [FILE]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual({ ...call!.target }, { route: "direct-native-exe", rowId: ROW, file: FILE, identity: IDENTITY });
  assert.equal(call!.deps?.runner, RUNNER, "the supplied exact-image runner");
  assert.ok(call!.deps!.timeoutMs! > 0 && call!.deps!.timeoutMs! <= WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS);
  assert.deepEqual(Object.keys(call!.deps!).sort(), ["runner", "timeoutMs"], "production seams otherwise");
  assert.equal(call!.env, HOST_ENV);
  assert.equal(call!.isCurrent(), true);

  const otherImage: WindowsClaudeVersionOutcome = { ...evidence(SUPPORTED) as Extract<WindowsClaudeVersionOutcome, { evidence: "version" }>, identity: { ...IDENTITY, ino: IDENTITY.ino + 1n } };
  const cases: Array<[string, WindowsClaudeVersionOutcome, string]> = [
    ["newer stable", evidence("2.2.0"), "verified"],
    ["below the floor", evidence("2.1.329"), "version-unsupported"],
    ["malformed", evidence("2.01.331"), "version-unrecognized"],
    ["another file", evidence(SUPPORTED, String.raw`C:\Other\claude.exe`), "version-unavailable"],
    ["another image", otherImage, "version-unavailable"],
    ["refused unrecognized", { evidence: "refused", reason: "version-unrecognized", process: "exact-child-exited", descendants: "witnessed-empty" }, "version-unrecognized"],
    ["refused unsupported", { evidence: "refused", reason: "version-unsupported", process: "exact-child-exited", descendants: "witnessed-empty" }, "version-unsupported"],
    ["no runner", { evidence: "refused", reason: "runner-unavailable", process: "none" }, "version-unavailable"],
    ["launch unverified", { evidence: "refused", reason: "launch-unverified", process: "exact-child-exited", descendants: "witnessed-empty" }, "version-unavailable"],
    ["teardown unproven", { evidence: "refused", reason: "teardown-unproven", process: "exact-child-exited", descendants: "unproven" }, "version-unavailable"],
  ];
  for (const [label, answer, expected] of cases) {
    const result = await probeWindowsClaudeInboxCompatibility({
      file: FILE, rowId: ROW, env: HOST_ENV, runner: RUNNER, probe: recordingProbe(answer).probe, identity: async () => IDENTITY,
    });
    if (expected === "verified") assert.equal(result.compatibility, "verified", label);
    else assert.deepEqual(result, { compatibility: "declined", reason: expected }, label);
  }
});

test("the probe adapter reports an unsettled or unknowable probe as unsettled, never as a decline", async () => {
  const unsettled: Array<[string, WindowsClaudeVersionProbe]> = [
    ["cleanup unconfirmed", recordingProbe({ evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }).probe],
    ["spawn uncertain", recordingProbe({ evidence: "unsettled", reason: "spawn-uncertain", descendants: "unproven" }).probe],
    ["a throwing probe", async () => { throw new Error("synthetic"); }],
    ["a malformed answer", async () => null as unknown as WindowsClaudeVersionOutcome],
  ];
  for (const [label, probe] of unsettled) {
    assert.deepEqual(
      await probeWindowsClaudeInboxCompatibility({ file: FILE, rowId: ROW, env: HOST_ENV, runner: RUNNER, probe, identity: async () => IDENTITY }),
      { compatibility: "unsettled" },
      label,
    );
  }
});

test("the probe adapter starts nothing without the file's own fingerprint or without a runner", async () => {
  const { probe, calls } = recordingProbe(evidence(SUPPORTED));
  for (const identity of [async () => undefined, async () => { throw new Error("synthetic"); }, async () => ({ ...IDENTITY, ctimeNs: 0n })]) {
    assert.deepEqual(
      await probeWindowsClaudeInboxCompatibility({ file: FILE, rowId: ROW, env: HOST_ENV, runner: RUNNER, probe, identity }),
      { compatibility: "declined", reason: "version-unavailable" },
    );
  }
  assert.equal(calls.length, 0, "no fingerprint, no probe");
  // The real probe with no runner refuses before any filesystem access.
  assert.deepEqual(
    await probeWindowsClaudeInboxCompatibility({ file: FILE, rowId: ROW, env: HOST_ENV, runner: undefined, identity: async () => IDENTITY }),
    { compatibility: "declined", reason: "version-unavailable" },
  );
});

/* ---------------------------------------------------------- target trust */

const CURRENT_SID = "S-1-5-21-1000-1000-1000-1001";
const SYSTEM_SID = "S-1-5-18";
const USERS_SID = "S-1-5-32-545";
const READ_EXECUTE = 0x0012_00a9;
const FULL = 0x001f_01ff;

function aclFile(overrides: Partial<WindowsAclEvidence> = {}): WindowsAclEvidence {
  const aces: WindowsAclAceEvidence[] = overrides.aces ?? [
    { sid: CURRENT_SID, aceType: "allow", rights: FULL, inherit: 0, propagate: 0, inherited: true },
    { sid: SYSTEM_SID, aceType: "allow", rights: FULL, inherit: 0, propagate: 0, inherited: true },
    { sid: USERS_SID, aceType: "allow", rights: READ_EXECUTE, inherit: 0, propagate: 0, inherited: true },
  ];
  const deny = aces.filter((entry) => entry.aceType === "deny").length;
  return {
    isDirectory: false, isReparsePoint: false, entryCount: -1, fileLength: 4096, ownerSid: CURRENT_SID,
    daclPresent: true, daclProtected: false, daclAceCount: aces.length, daclAllowCount: aces.length - deny,
    daclDenyCount: deny, daclOtherCount: 0, aces, parentExists: true, parentIsReparsePoint: false,
    ...overrides,
  };
}

test("a protected executable admits read/execute for untrusted principals and refuses any write, replacement, or permission right", () => {
  assert.equal(classifyProtectedExecutableAclEvidence(aclFile(), CURRENT_SID), null);
  assert.equal(classifyProtectedExecutableAclEvidence(aclFile({ ownerSid: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" }), CURRENT_SID), null,
    "a TrustedInstaller-owned install");
  const users = (rights: number, extra: Partial<WindowsAclAceEvidence> = {}): WindowsAclAceEvidence[] => [
    { sid: CURRENT_SID, aceType: "allow", rights: FULL, inherit: 0, propagate: 0, inherited: true },
    { sid: USERS_SID, aceType: "allow", rights, inherit: 0, propagate: 0, inherited: true, ...extra },
  ];
  const refusals: Array<[string, WindowsAclEvidence, string]> = [
    ["a directory", aclFile({ isDirectory: true }), "unsafe-object"],
    ["a reparse point", aclFile({ isReparsePoint: true }), "unsafe-object"],
    ["a null DACL", aclFile({ daclPresent: false }), "unsafe-permissions"],
    ["a foreign owner", aclFile({ ownerSid: "S-1-5-21-9-9-9-2002" }), "foreign-owner"],
    ["untrusted write", aclFile({ aces: users(READ_EXECUTE | 0x2) }), "unsafe-permissions"],
    ["untrusted append", aclFile({ aces: users(READ_EXECUTE | 0x4) }), "unsafe-permissions"],
    ["untrusted delete", aclFile({ aces: users(READ_EXECUTE | 0x0001_0000) }), "unsafe-permissions"],
    ["untrusted change permissions", aclFile({ aces: users(READ_EXECUTE | 0x0004_0000) }), "unsafe-permissions"],
    ["untrusted full control", aclFile({ aces: users(FULL) }), "unsafe-permissions"],
    ["a deny entry", aclFile({ aces: users(READ_EXECUTE, { aceType: "deny" }) }), "unsafe-permissions"],
    ["an incomplete enumeration", aclFile({ daclOtherCount: 1, daclAceCount: 3 }), "protection-unsupported"],
  ];
  for (const [label, item, reason] of refusals) {
    assert.equal(classifyProtectedExecutableAclEvidence(item, CURRENT_SID), reason, label);
  }
});

interface FakeStat { kind: "dir" | "file" | "link"; ino: bigint }

function trustHarness(): {
  readonly stats: Map<string, FakeStat>;
  readonly calls: string[];
  readonly permissions: PeerStatePermissionPolicy;
  readonly lstat: (path: string) => BigIntStats;
} {
  const stats = new Map<string, FakeStat>();
  for (const [index, path] of [...windowsClaudeTargetAncestors(FILE)!, FILE].entries()) {
    stats.set(path, { kind: path === FILE ? "file" : "dir", ino: BigInt(index + 1) });
  }
  const calls: string[] = [];
  const refuse = (): never => { throw new Error("unused proof"); };
  const permissions: PeerStatePermissionPolicy = {
    assertOwnerControlledDirectory: refuse,
    assertPrivateDirectory: refuse,
    protectCreatedDirectory: refuse,
    assertPrivateFile: refuse,
    protectCreatedFile: refuse,
    assertReplacementProtectedAncestor: (path) => { calls.push(`ancestor ${path}`); },
    assertProtectedExecutable: (path) => { calls.push(`file ${path}`); },
  };
  const lstat = (path: string): BigIntStats => {
    const stat = stats.get(path);
    if (stat === undefined) throw Object.assign(new Error("synthetic ENOENT"), { code: "ENOENT" });
    return {
      dev: 1n, ino: stat.ino, birthtimeNs: 5n, ctimeNs: 6n,
      isFile: () => stat.kind === "file", isDirectory: () => stat.kind === "dir", isSymbolicLink: () => stat.kind === "link",
    } as unknown as BigIntStats;
  };
  return { stats, calls, permissions, lstat };
}

test("target trust proves every ancestor top-down and then the exact file, with the existing policy proofs only", () => {
  const h = trustHarness();
  assert.equal(proveWindowsClaudeTargetTrust(FILE, { permissions: h.permissions, lstat: h.lstat }), true);
  assert.deepEqual(h.calls, [
    ...windowsClaudeTargetAncestors(FILE)!.map((path) => `ancestor ${path}`),
    `file ${FILE}`,
  ]);

  const refused = (label: string, mutate: (t: ReturnType<typeof trustHarness>) => Parameters<typeof proveWindowsClaudeTargetTrust>[1], file = FILE): void => {
    const t = trustHarness();
    assert.equal(proveWindowsClaudeTargetTrust(file, mutate(t)), false, label);
  };
  refused("a policy refusal on an ancestor", (t) => ({
    lstat: t.lstat,
    permissions: { ...t.permissions, assertReplacementProtectedAncestor: (path) => { if (path === DIR) throw new Error("synthetic refusal"); } },
  }));
  refused("a policy refusal on the file", (t) => ({
    lstat: t.lstat, permissions: { ...t.permissions, assertProtectedExecutable: () => { throw new Error("synthetic refusal"); } },
  }));
  refused("a policy without the executable proof", (t) => ({
    lstat: t.lstat, permissions: { ...t.permissions, assertProtectedExecutable: undefined },
  }));
  refused("a policy without the ancestor proof", (t) => ({
    lstat: t.lstat, permissions: { ...t.permissions, assertReplacementProtectedAncestor: undefined },
  }));
  refused("a linked ancestor", (t) => { t.stats.set(DIR, { kind: "link", ino: 99n }); return { lstat: t.lstat, permissions: t.permissions }; });
  refused("a linked target", (t) => { t.stats.set(FILE, { kind: "link", ino: 99n }); return { lstat: t.lstat, permissions: t.permissions }; });
  refused("a target replaced during its proof", (t) => ({
    lstat: t.lstat,
    permissions: { ...t.permissions, assertProtectedExecutable: () => { t.stats.set(FILE, { kind: "file", ino: 77n }); } },
  }));
  refused("a missing target", (t) => { t.stats.delete(FILE); return { lstat: t.lstat, permissions: t.permissions }; });
  refused("a shim", (t) => ({ lstat: t.lstat, permissions: t.permissions }), `${DIR}\\claude.cmd`);
  refused("a relative path", (t) => ({ lstat: t.lstat, permissions: t.permissions }), "claude.exe");
});

/* -------------------------------------------------------- launcher step */

test("the launcher's Windows step declines a shim or an untrusted target before any runner and passes only the factory's exact-image runner", async () => {
  let factoryCalls = 0;
  const factory = (): WindowsExactImageVersionRunner => { factoryCalls += 1; return RUNNER; };
  const trusted: string[] = [];
  const targetTrust = (file: string): boolean => { trusted.push(file); return true; };
  const { probe, calls } = recordingProbe(evidence(SUPPORTED));
  for (const shim of [`${DIR}\\claude.cmd`, `${DIR}\\claude.BAT`]) {
    assert.deepEqual(
      await composeWindowsClaudeInboxCompatibility({ file: shim, rowId: ROW, env: HOST_ENV, runnerFactory: factory, targetTrust, probe }),
      { compatibility: "declined", reason: "version-unavailable" },
    );
  }
  assert.equal(trusted.length, 0);
  for (const untrusted of [() => false, () => { throw new Error("synthetic"); }]) {
    assert.deepEqual(
      await composeWindowsClaudeInboxCompatibility({
        file: FILE, rowId: ROW, env: HOST_ENV, runnerFactory: factory, targetTrust: untrusted, probe, identity: async () => IDENTITY,
      }),
      { compatibility: "declined", reason: "version-unavailable" },
      "an unproven target is never probed",
    );
  }
  assert.equal(factoryCalls, 0);
  assert.equal(calls.length, 0, "no shim or unproven target is ever probed");

  const verified = await composeWindowsClaudeInboxCompatibility({
    file: FILE, rowId: ROW, env: HOST_ENV, runnerFactory: factory, targetTrust, probe, identity: async () => IDENTITY,
  });
  assert.deepEqual(verified, { compatibility: "verified", version: SUPPORTED, windowsImage: VERIFIED_IMAGE });
  assert.deepEqual(trusted, [FILE], "the exact file's trust is proved first");
  assert.equal(factoryCalls, 1, "one runner per eligible probe");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.deps?.runner, RUNNER, "exactly the factory's exact-image runner");
  assert.equal(calls[0]!.target.file, FILE, "the descriptor's own direct file");
  assert.equal(calls[0]!.target.rowId, ROW);

  // A factory that throws or finds no PowerShell leaves no runner: nothing starts.
  for (const runnerFactory of [() => undefined, () => { throw new Error("synthetic"); }]) {
    assert.deepEqual(
      await composeWindowsClaudeInboxCompatibility({ file: FILE, rowId: ROW, env: HOST_ENV, runnerFactory, targetTrust, identity: async () => IDENTITY }),
      { compatibility: "declined", reason: "version-unavailable" },
    );
  }
});

/* ------------------------------------------------------ launcher (win32) */

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
function hookBootstrap(): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: "22222222-2222-4222-8222-222222222222",
    instanceId: ROW,
    backend: "claude",
    token: TOKEN,
  };
}
function mcpOption() {
  return {
    bootstrap: {
      version: 1,
      type: "native_mcp_bootstrap",
      socketPath: "/tmp/prg-synthetic-status-broker.sock",
      generation: "33333333-3333-4333-8333-333333333333",
      instanceId: ROW,
      backend: "claude",
      token: "b".repeat(64),
    } as NativeMcpBootstrap,
    serverName: `${NATIVE_MCP_SERVER_NAME_PREFIX}${"0".repeat(32)}`,
  };
}

/** Controlled prepared hook and MCP leases, counting each cleanup. */
function controlledPreparation() {
  const cleanups = { hook: 0, mcp: 0 };
  const hookPreparation: NonNullable<NativeCliLauncherOptions["nativeHookPreparation"]> = async (input) => ({
    observation: "prepared",
    backend: input.backend,
    route: "claude-settings-file",
    args: ["--settings", "C:\\synthetic\\hook-settings.json"],
    environment: {},
    lease: { root: null, cleanup: async () => { cleanups.hook += 1; return { removed: [], preserved: [] }; } },
  }) as unknown as NativeHookLaunchOutcome;
  const mcpPreparation: NonNullable<NativeCliLauncherOptions["nativeMcpPreparation"]> = async (input) => ({
    mcp: "prepared",
    backend: input.backend,
    route: "claude-mcp-config-file",
    placement: "claude-tui",
    serverName: input.serverName,
    args: ["--mcp-config", "C:\\synthetic\\mcp.json"],
    lease: { cleanup: async () => { cleanups.mcp += 1; } },
  }) as unknown as NativeMcpLaunchOutcome;
  return { cleanups, hookPreparation, mcpPreparation };
}

/** A probe seam that answers exact evidence for exactly the request it received. */
function echoingProbe(answer: "version" | "unsettled"): { probe: WindowsClaudeVersionProbe; calls: WindowsClaudeVersionProbeRequest[] } {
  const calls: WindowsClaudeVersionProbeRequest[] = [];
  const probe: WindowsClaudeVersionProbe = async (request) => {
    calls.push(request);
    return answer === "unsettled"
      ? { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }
      : { evidence: "version", version: SUPPORTED, rowId: request.target.rowId, file: request.target.file, identity: request.target.identity, lifecycle: LIFECYCLE };
  };
  return { probe, calls };
}

async function launcherFixture(run: (bin: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-windows-claude-host-composition-")));
  try {
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    await mkdir(bin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    for (const name of ["claude.exe", "codex.exe"]) {
      await writeFile(join(bin, name), "MZ never invoked\n");
      await chmod(join(bin, name), 0o755);
    }
    await run(bin, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LAUNCH_ENV = (bin: string): NodeJS.ProcessEnv => ({ PATH: bin, PATHEXT: ".EXE;.CMD" });

test("an eligible Windows launch probes the exact direct file and returns its direct descriptor with the verified image", async () => {
  await launcherFixture(async (bin, workspace) => {
    const { cleanups, hookPreparation, mcpPreparation } = controlledPreparation();
    const { probe, calls } = echoingProbe("version");
    const trusted: string[] = [];
    let factoryCalls = 0;
    const launcher = createNativeCliLauncher(normalizeConfig({ enabled: true, externalAgents: {} }), {
      platform: "win32",
      nativeHookPreparation: hookPreparation,
      nativeMcpPreparation: mcpPreparation,
      windowsClaudeTargetTrust: (file) => { trusted.push(file); return true; },
      windowsClaudeVersionRunner: () => { factoryCalls += 1; return RUNNER; },
      windowsClaudeVersionProbe: probe,
    });
    const descriptor = await launcher("claude", {
      workspace, env: LAUNCH_ENV(bin), nativeHook: { bootstrap: hookBootstrap() }, nativeMcp: mcpOption(),
      claudeInboxCompatibility: true, claudeInboxRequiresNativeMcp: true,
    });
    const file = join(bin, "claude.exe");
    const stats = lstatSync(file, { bigint: true });
    assert.equal(descriptor.file, file, "the direct native file itself");
    assert.equal(descriptor.commandLine, undefined, "no cmd.exe rendering");
    assert.deepEqual(descriptor.args, ["--settings", "C:\\synthetic\\hook-settings.json", "--mcp-config", "C:\\synthetic\\mcp.json"]);
    assert.deepEqual(descriptor.claudeInboxCompatibility, {
      compatibility: "verified",
      version: SUPPORTED,
      windowsImage: {
        file, dev: stats.dev.toString(), ino: stats.ino.toString(), size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString(),
      },
    });
    assert.deepEqual(trusted, [file], "the exact descriptor file's trust was proved");
    assert.equal(factoryCalls, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.target.file, descriptor.file, "the probed file is the spawned file");
    assert.equal(calls[0]!.target.rowId, ROW);
    assert.equal(calls[0]!.deps?.runner, RUNNER);
    assert.equal(Object.keys(calls[0]!.env).some((name) => /NATIVE_HOOK_BOOTSTRAP/iu.test(name)), false, "no hook marker reaches the probe");
    assert.deepEqual(cleanups, { hook: 0, mcp: 0 }, "the caller owns both leases");
  });
});

test("an unsettled Windows probe refuses the launch attempt, returns no descriptor, and rolls back both prepared leases", async () => {
  await launcherFixture(async (bin, workspace) => {
    const { cleanups, hookPreparation, mcpPreparation } = controlledPreparation();
    const { probe, calls } = echoingProbe("unsettled");
    const launcher = createNativeCliLauncher(normalizeConfig({ enabled: true, externalAgents: {} }), {
      platform: "win32",
      nativeHookPreparation: hookPreparation,
      nativeMcpPreparation: mcpPreparation,
      windowsClaudeTargetTrust: () => true,
      windowsClaudeVersionRunner: () => RUNNER,
      windowsClaudeVersionProbe: probe,
    });
    await assert.rejects(launcher("claude", {
      workspace, env: LAUNCH_ENV(bin), nativeHook: { bootstrap: hookBootstrap() }, nativeMcp: mcpOption(),
      claudeInboxCompatibility: true, claudeInboxRequiresNativeMcp: true,
    }), /version probe could not settle its exact child, so this launch attempt is refused/u);
    assert.equal(calls.length, 1);
    assert.deepEqual(cleanups, { hook: 1, mcp: 1 }, "each prepared lease is cleaned up exactly once");
  });
});

test("an ineligible or unproven Windows Claude launch runs no probe and no runner, and launches normally", async () => {
  await launcherFixture(async (bin, workspace) => {
    const { cleanups, hookPreparation, mcpPreparation } = controlledPreparation();
    let factoryCalls = 0;
    const trusted: string[] = [];
    const { probe, calls } = echoingProbe("version");
    const make = (trust: boolean) => createNativeCliLauncher(normalizeConfig({ enabled: true, externalAgents: {} }), {
      platform: "win32",
      nativeHookPreparation: hookPreparation,
      nativeMcpPreparation: mcpPreparation,
      windowsClaudeTargetTrust: (file) => { trusted.push(file); return trust; },
      windowsClaudeVersionRunner: () => { factoryCalls += 1; return RUNNER; },
      windowsClaudeVersionProbe: probe,
    });
    const launcher = make(true);
    const env = LAUNCH_ENV(bin);

    const unhooked = await launcher("claude", { workspace, env, claudeInboxCompatibility: true });
    assert.deepEqual(unhooked.claudeInboxCompatibility, { compatibility: "declined", reason: "status-hook-not-prepared" });
    assert.equal(unhooked.file, join(bin, "claude.exe"), "the ordinary direct launch");
    assert.equal(unhooked.commandLine, undefined);

    // A prepared hook without the managed MCP option is declined deterministically.
    const noLane = await launcher("claude", {
      workspace, env, nativeHook: { bootstrap: hookBootstrap() }, claudeInboxCompatibility: true, claudeInboxRequiresNativeMcp: true,
    });
    assert.equal(noLane.nativeHook?.observation, "prepared");
    assert.deepEqual(noLane.claudeInboxCompatibility, { compatibility: "declined", reason: "native-mcp-not-prepared" });
    // Windows callbacks exist only beside the managed lane even without the lane scope.
    const hooksOnly = await launcher("claude", { workspace, env, nativeHook: { bootstrap: hookBootstrap() }, claudeInboxCompatibility: true });
    assert.deepEqual(hooksOnly.claudeInboxCompatibility, { compatibility: "declined", reason: "native-mcp-not-prepared" });

    const codex = await launcher("codex", { workspace, env, claudeInboxCompatibility: true });
    assert.deepEqual(codex.claudeInboxCompatibility, { compatibility: "declined", reason: "not-claude-backend" });
    const unrequested = await launcher("claude", { workspace, env, nativeHook: { bootstrap: hookBootstrap() }, nativeMcp: mcpOption() });
    assert.equal("claudeInboxCompatibility" in unrequested, false);
    assert.equal(trusted.length, 0, "no trust proof for an ineligible request");

    // A native PATH candidate whose trust cannot be proved never reaches the runner
    // or custody: it is declined and launches normally, owning its leases.
    const untrusted = await make(false)("claude", {
      workspace, env, nativeHook: { bootstrap: hookBootstrap() }, nativeMcp: mcpOption(),
      claudeInboxCompatibility: true, claudeInboxRequiresNativeMcp: true,
    });
    assert.deepEqual(untrusted.claudeInboxCompatibility, { compatibility: "declined", reason: "version-unavailable" });
    assert.equal(untrusted.file, join(bin, "claude.exe"));
    assert.deepEqual(trusted, [join(bin, "claude.exe")]);
    assert.equal(calls.length, 0, "no probe ran");
    assert.equal(factoryCalls, 0, "no runner was built");
    assert.deepEqual(cleanups, { hook: 0, mcp: 0 }, "a clean decline leaves every lease with the caller");

    const options = (extra: Partial<NativeCliLauncherOptions>) => () => createNativeCliLauncher(normalizeConfig({ enabled: true, externalAgents: {} }), extra);
    assert.throws(options({ windowsClaudeVersionProbe: "probe" as unknown as WindowsClaudeVersionProbe }), /Windows Claude version probe launcher option must be a function/);
    assert.throws(options({ windowsClaudeVersionRunner: {} as unknown as () => WindowsExactImageVersionRunner }), /Windows Claude version runner launcher option must be a function/);
    assert.throws(options({ windowsClaudeTargetTrust: 1 as unknown as () => boolean }), /Windows Claude target trust launcher option must be a function/);
    assert.throws(options({ nativeHookPreparation: {} as never }), /native hook preparation launcher option must be a function/);
    assert.throws(options({ nativeMcpPreparation: {} as never }), /native MCP preparation launcher option must be a function/);
  });
});
