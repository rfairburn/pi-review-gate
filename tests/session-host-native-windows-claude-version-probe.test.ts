import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { CLAUDE_INBOX_MIN_CLI_VERSION } from "../src/session-host/native-claude-inbox-delivery";
import { NATIVE_HOOK_BOOTSTRAP_ENV } from "../src/session-host/native-hook-protocol";
import { NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV } from "../src/session-host/native-review-hook-protocol";
import * as probeModule from "../src/session-host/native-windows-claude-version-probe";
import {
  WINDOWS_CLAUDE_VERSION_ARGS,
  WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS,
  WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  buildWindowsClaudeVersionEnvironment,
  classifyWindowsNativeExecutable,
  probeWindowsClaudeVersion,
  windowsClaudeTargetAncestors,
  type WindowsClaudeVersionOutcome,
  type WindowsClaudeVersionProbeDeps,
  type WindowsClaudeVersionProbeRequest,
  type WindowsDescendantTeardown,
  type WindowsDirectVersionRunBounds,
  type WindowsDirectVersionRunKind,
  type WindowsExactImageRunSpec,
  type WindowsExactImageVersionRunner,
  type WindowsFileFacts,
  type WindowsFileHandle,
  type WindowsProbeFileSystem,
} from "../src/session-host/native-windows-claude-version-probe";

/**
 * #682: INACTIVE Windows Claude direct version evidence.
 *
 * Every case injects the platform, filesystem, exact-image runner, and clock:
 * no process, Claude binary, provider, credential, network, or real filesystem
 * object is touched, and nothing here claims live Windows compatibility. The
 * probe has no default runner, so without an injected one nothing starts.
 */

const PROJECT_ROOT = join(__dirname, "..", "..");
const MODULE_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-version-probe.ts");

const SUPPORTED = CLAUDE_INBOX_MIN_CLI_VERSION;
const ROW = "row-7f3a";
const DIR = "C:\\Users\\dev\\AppData\\Local\\Programs\\Claude";
const FILE = `${DIR}\\claude.exe`;
const ANCESTORS = [
  "C:\\",
  "C:\\Users",
  "C:\\Users\\dev",
  "C:\\Users\\dev\\AppData",
  "C:\\Users\\dev\\AppData\\Local",
  "C:\\Users\\dev\\AppData\\Local\\Programs",
  DIR,
];
const OUT = `${SUPPORTED} (Claude Code)\r\n`;

const SECRETS = ["sk-ant-secret-value", "oauth-secret-value", "sk-openai-secret", "settlement-secret-value", "--require evil"];
const SOURCE_ENV: NodeJS.ProcessEnv = Object.freeze({
  SystemRoot: "C:\\Windows",
  SYSTEMDRIVE: "C:",
  windir: "C:\\Windows",
  TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  PATH: "C:\\Windows\\System32;C:\\Users\\dev\\evil",
  USERPROFILE: "C:\\Users\\dev",
  USERNAME: "dev",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ANTHROPIC_API_KEY: SECRETS[0],
  CLAUDE_CODE_OAUTH_TOKEN: SECRETS[1],
  OPENAI_API_KEY: SECRETS[2],
  PI_REVIEW_GATE_RUNTIME_ROLE: "executor",
  PI_REVIEW_GATE_SETTLEMENT_SECRET: SECRETS[3],
  NODE_OPTIONS: SECRETS[4],
});
const EXPECTED_ENV = Object.freeze({
  SystemRoot: "C:\\Windows",
  SystemDrive: "C:",
  windir: "C:\\Windows",
  TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  HOMEDRIVE: "",
  HOMEPATH: "",
  LOGONSERVER: "",
  PATH: "",
  USERDOMAIN: "",
  USERNAME: "",
  USERPROFILE: "",
});

/* -------------------------------------------------------------- PE images */

function pe(options: {
  mz?: number; peOffset?: number; signature?: number; machine?: number; sections?: number;
  optSize?: number; characteristics?: number; magic?: number; subsystem?: number; size?: number;
} = {}): Buffer {
  const bytes = Buffer.alloc(options.size ?? 8192);
  const at = options.peOffset ?? 0x80;
  bytes.writeUInt16LE(options.mz ?? 0x5a4d, 0);
  bytes.writeUInt32LE(at, 0x3c);
  bytes.writeUInt32LE(options.signature ?? 0x00004550, at);
  bytes.writeUInt16LE(options.machine ?? 0x8664, at + 4);
  bytes.writeUInt16LE(options.sections ?? 5, at + 6);
  bytes.writeUInt16LE(options.optSize ?? 240, at + 20);
  bytes.writeUInt16LE(options.characteristics ?? 0x0022, at + 22);
  bytes.writeUInt16LE(options.magic ?? 0x20b, at + 24);
  bytes.writeUInt16LE(options.subsystem ?? 3, at + 24 + 68);
  return bytes;
}

function reader(bytes: Buffer) {
  return async (position: number, length: number): Promise<Uint8Array> => bytes.subarray(position, position + length);
}

/* ------------------------------------------------------------- filesystem */

function dirFacts(ino: number): WindowsFileFacts {
  return { kind: "directory", dev: 7n, ino: BigInt(ino), size: 0n, mtimeNs: 10n, ctimeNs: 10n, birthtimeNs: 5n };
}

const IMAGE = pe();
const TARGET_FACTS: WindowsFileFacts = Object.freeze({
  kind: "file", dev: 7n, ino: 9001n, size: BigInt(IMAGE.length), mtimeNs: 1_700n, ctimeNs: 1_700n, birthtimeNs: 1_600n,
});
const IDENTITY = Object.freeze({ dev: 7n, ino: 9001n, size: BigInt(IMAGE.length), mtimeNs: 1_700n, ctimeNs: 1_700n });

function errno(code: string): Error {
  return Object.assign(new Error(`synthetic ${code} C:\\secret\\path`), { code });
}

class FakeFs implements WindowsProbeFileSystem {
  readonly entries = new Map<string, WindowsFileFacts>();
  readonly errors = new Map<string, string>();
  readonly lstatCalls: string[] = [];
  readonly openCalls: string[] = [];
  bytes: Buffer = IMAGE;
  openFacts: WindowsFileFacts | undefined;
  hang = false;
  closed = 0;
  onLstat: ((path: string, fs: FakeFs) => void) | undefined;

  constructor() {
    ANCESTORS.forEach((path, index) => this.entries.set(path, dirFacts(index + 1)));
    this.entries.set(FILE, TARGET_FACTS);
  }

  count(path: string): number {
    return this.lstatCalls.filter((entry) => entry === path).length;
  }

  async lstat(path: string): Promise<WindowsFileFacts> {
    this.lstatCalls.push(path);
    this.onLstat?.(path, this);
    if (this.hang) return new Promise<never>(() => { /* never settles */ });
    const code = this.errors.get(path);
    if (code !== undefined) throw errno(code);
    const facts = this.entries.get(path);
    if (facts === undefined) throw errno("ENOENT");
    return facts;
  }

  async open(path: string): Promise<WindowsFileHandle> {
    this.openCalls.push(path);
    const facts = this.openFacts ?? this.entries.get(path);
    if (facts === undefined) throw errno("ENOENT");
    return {
      stat: async () => facts,
      read: async (position, length, checkDeadline) => {
        checkDeadline?.();
        return this.bytes.subarray(position, position + length);
      },
      close: async () => { this.closed += 1; },
    };
  }
}

/* ----------------------------------------------------------------- runner */

interface RunnerCall { spec: WindowsExactImageRunSpec; bounds: WindowsDirectVersionRunBounds }
type ReceiptFactory = (spec: WindowsExactImageRunSpec, bounds: WindowsDirectVersionRunBounds, now: () => number) => unknown;

/** An exact-image runner double; a factory may return another factory, which is applied with the same arguments. */
function fakeRunner(result: ReceiptFactory | object) {
  const calls: RunnerCall[] = [];
  const runner: WindowsExactImageVersionRunner = {
    binding: "exact-image-no-fallback",
    run: async (spec, bounds, now) => {
      calls.push({ spec, bounds });
      let value: unknown = typeof result === "function" ? (result as ReceiptFactory)(spec, bounds, now) : result;
      if (typeof value === "function") value = (value as ReceiptFactory)(spec, bounds, now);
      return value as never;
    },
  };
  return { runner, calls };
}

function exited(kind: WindowsDirectVersionRunKind, stdout: string, descendants: WindowsDescendantTeardown, captureCompletedAt: number, extra: object = {}) {
  return {
    exactChild: "exited",
    launch: "suspended-image-name-matched",
    ownedHandles: "closed",
    kind,
    stdout,
    outputBytes: Buffer.byteLength(stdout),
    captureCompletedAt,
    descendants,
    ...extra,
  };
}

function witnessed(stdout = OUT): ReceiptFactory {
  return (_spec, _bounds, now) => exited("completed", stdout, "witnessed-empty", now());
}

function request(overrides: Partial<WindowsClaudeVersionProbeRequest> = {}, deps: WindowsClaudeVersionProbeDeps = {}): WindowsClaudeVersionProbeRequest {
  return {
    target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: IDENTITY },
    isCurrent: () => true,
    env: SOURCE_ENV,
    ...overrides,
    deps: { platform: "win32", ...deps },
  };
}

function assertClosedOutcome(outcome: WindowsClaudeVersionOutcome): void {
  const text = JSON.stringify(outcome, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  for (const secret of SECRETS) assert.ok(!text.includes(secret), "no secret in an outcome");
  assert.ok(!text.includes("Claude Code"), "no raw stdout in an outcome");
  assert.ok(!text.includes("synthetic"), "no raw error in an outcome");
  if (outcome.evidence === "refused" && outcome.process === "none") {
    assert.deepEqual(Object.keys(outcome).sort(), ["evidence", "process", "reason"]);
  } else if (outcome.evidence === "refused") {
    assert.deepEqual(Object.keys(outcome).sort(), ["descendants", "evidence", "process", "reason"]);
  } else if (outcome.evidence === "unsettled") {
    assert.deepEqual(Object.keys(outcome).sort(), ["descendants", "evidence", "reason"]);
    assert.equal(outcome.descendants, "unproven");
  }
  assert.ok(Object.isFrozen(outcome));
}

/* ------------------------------------------------------------ positive path */

test("positive: exact row, file, identity, and observed version only after a witnessed clean lifecycle", async () => {
  const fs = new FakeFs();
  const { runner, calls } = fakeRunner(witnessed());
  const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner }));
  assert.deepEqual(outcome, {
    evidence: "version",
    version: SUPPORTED,
    rowId: ROW,
    file: FILE,
    identity: IDENTITY,
    lifecycle: { launch: "suspended-image-name-matched", exactChild: "exited-clean", descendants: "witnessed-empty" },
  });
  assert.ok(Object.isFrozen(outcome));
  assert.equal(calls.length, 1);
  const [{ spec, bounds }] = calls;
  assert.equal(spec.file, FILE);
  assert.deepEqual([...spec.args], ["--version"]);
  assert.equal(spec.args, WINDOWS_CLAUDE_VERSION_ARGS);
  assert.equal(spec.cwd, DIR, "fixed cwd: the executable's own parent directory");
  assert.deepEqual({ ...spec.env }, EXPECTED_ENV);
  // The runner is handed the exact image and cwd identities it must bind the launch to.
  assert.deepEqual(spec.image, {
    dev: TARGET_FACTS.dev, ino: TARGET_FACTS.ino, size: TARGET_FACTS.size,
    mtimeNs: TARGET_FACTS.mtimeNs, ctimeNs: TARGET_FACTS.ctimeNs, birthtimeNs: TARGET_FACTS.birthtimeNs,
  });
  assert.deepEqual(spec.cwdIdentity, { dev: 7n, ino: BigInt(ANCESTORS.length), birthtimeNs: 5n });
  // Every ancestor identity the probe observed, root first, ending at the cwd, for the runner's held handles.
  assert.deepEqual(spec.ancestorIdentities, ANCESTORS.map((_path, index) => ({ dev: 7n, ino: BigInt(index + 1), birthtimeNs: 5n })));
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.image) && Object.isFrozen(spec.cwdIdentity));
  assert.ok(Object.isFrozen(spec.ancestorIdentities) && spec.ancestorIdentities.every((entry) => Object.isFrozen(entry)));
  assert.equal(bounds.maxOutputBytes, WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES);
  assert.equal(bounds.cleanupMs, WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS);
  // Before, pre-spawn, and post-run observation of the full chain and both siblings.
  assert.equal(fs.count(FILE), 3);
  assert.equal(fs.count(`${FILE}.com`), 3);
  assert.equal(fs.count(`${FILE}.exe`), 3);
  for (const ancestor of ANCESTORS) assert.equal(fs.count(ancestor), 3);
  assert.deepEqual(fs.openCalls, [FILE]);
  assert.equal(fs.closed, 1);
});

test("floor: the shared 2.1.330 floor admits numerically newer stable versions and returns them exactly", async () => {
  assert.equal(SUPPORTED, "2.1.330");
  for (const version of ["2.1.330", "2.1.1000", "2.2.0", "3.0.0"]) {
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: fakeRunner(witnessed(`${version} (Claude Code)\n`)).runner }));
    assert.equal(outcome.evidence, "version");
    assert.equal(outcome.evidence === "version" && outcome.version, version);
  }
  for (const version of ["2.1.329", "2.0.999", "1.99.999", "0.0.0"]) {
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: fakeRunner(witnessed(`${version} (Claude Code)\n`)).runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "version-unsupported", process: "exact-child-exited", descendants: "witnessed-empty" });
  }
});

test("grammar: only the exact official stable stdout form is recognized", async () => {
  const unrecognized = [
    "",
    `${SUPPORTED}\n`,
    `v${SUPPORTED} (Claude Code)\n`,
    `${SUPPORTED}-beta.1 (Claude Code)\n`,
    `${SUPPORTED}+build (Claude Code)\n`,
    "2.01.330 (Claude Code)\n",
    "2.1.330.1 (Claude Code)\n",
    "1234567.1.330 (Claude Code)\n",
    ` ${SUPPORTED} (Claude Code)\n`,
    `${SUPPORTED} (Claude Code)\n\n`,
    `${SUPPORTED} (Claude Code) extra\n`,
    `${SUPPORTED} (claude code)\n`,
    `${SUPPORTED} (Claude Code)\nsecond line\n`,
  ];
  for (const stdout of unrecognized) {
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: fakeRunner(witnessed(stdout)).runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "version-unrecognized", process: "exact-child-exited", descendants: "witnessed-empty" }, JSON.stringify(stdout));
    assertClosedOutcome(outcome);
  }
});

/* ----------------------------------------------- runner availability */

test("no process start: without an exact-image, no-fallback runner an otherwise valid request starts nothing", async () => {
  const fallbackLike: unknown[] = [
    undefined,
    null,
    async () => witnessed()(null as never, null as never, () => 0),
    { run: async () => ({ exactChild: "not-created" }) },
    { binding: "pathname", run: async () => ({ exactChild: "not-created" }) },
    { binding: "exact-image-no-fallback" },
    { binding: "exact-image-no-fallback", run: "spawn" },
    { get binding(): string { throw new Error("C:\\secret"); }, run: async () => ({}) },
  ];
  for (const runner of fallbackLike) {
    const fs = new FakeFs();
    let predicateCalls = 0;
    const outcome = await probeWindowsClaudeVersion(request(
      { isCurrent: () => { predicateCalls += 1; return true; } },
      { fs, runner: runner as never },
    ));
    assert.deepEqual(outcome, { evidence: "refused", reason: "runner-unavailable", process: "none" });
    assert.equal(fs.lstatCalls.length, 0, "no filesystem access");
    assert.equal(fs.openCalls.length, 0);
    assert.equal(predicateCalls, 0);
  }
  // Production composition: no deps beyond the platform means no runner, so nothing starts.
  const production = await probeWindowsClaudeVersion({
    target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: IDENTITY },
    isCurrent: () => true,
    env: SOURCE_ENV,
    deps: { platform: "win32" },
  });
  assert.deepEqual(production, { evidence: "refused", reason: "runner-unavailable", process: "none" });
});

/* --------------------------------------------------------- refusals, no spawn */

test("no process start: non-Windows hosts refuse before validation or any filesystem access", async () => {
  for (const platform of ["linux", "darwin", "freebsd"] as const) {
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({}, { platform, fs, runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "unsupported-platform", process: "none" });
    assert.equal(calls.length, 0);
    assert.equal(fs.lstatCalls.length, 0);
  }
});

test("no process start: shims, batch files, scripts, path search, and non-canonical paths are refused", async () => {
  const files: unknown[] = [
    "claude.exe",
    "claude",
    `${DIR}\\claude`,
    `${DIR}\\claude.cmd`,
    `${DIR}\\claude.bat`,
    `${DIR}\\claude.com`,
    `${DIR}\\claude.ps1`,
    `${DIR}\\claude.exe.cmd`,
    `${DIR}\\.exe`,
    "\\\\server\\share\\claude.exe",
    "\\\\?\\C:\\claude.exe",
    "\\\\.\\C:\\claude.exe",
    "C:claude.exe",
    "C:/Users/dev/claude.exe",
    "C:\\Users/dev\\claude.exe",
    "C:\\Users\\dev\\..\\claude.exe",
    "C:\\Users\\.\\claude.exe",
    "C:\\Users\\\\claude.exe",
    "C:\\Users\\dev.\\claude.exe",
    "C:\\Users\\dev \\claude.exe",
    `${DIR}\\claude.exe.`,
    `${DIR}\\claude.exe `,
    `${DIR}\\claude.exe:stream`,
    `${DIR}\\claude.exe::$DATA`,
    "C:\\con\\claude.exe",
    "C:\\Users\\NUL.txt\\claude.exe",
    "C:\\Users\\dev\\com1.exe",
    "C:\\Users\\dev\\LPT\u00b9.exe",
    "C:\\PROGRA~1\\Claude\\claude.exe",
    `${DIR}\\CLAUDE~1.EXE`,
    `${DIR}\\cla\u0007ude.exe`,
    `${DIR}\\cla*ude.exe`,
    `${DIR}\\cla"ude.exe`,
    `${DIR}\\cla\uD800ude.exe`,
    `C:\\${"a".repeat(250)}\\claude.exe`,
    "",
    42,
    null,
  ];
  for (const file of files) {
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(witnessed());
    const target = { route: "direct-native-exe", rowId: ROW, file, identity: IDENTITY } as unknown as WindowsClaudeVersionProbeRequest["target"];
    const outcome = await probeWindowsClaudeVersion(request({ target }, { fs, runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "invalid-request", process: "none" }, String(file));
    assert.equal(calls.length, 0);
    assert.equal(fs.lstatCalls.length, 0);
  }
  assert.deepEqual(windowsClaudeTargetAncestors(FILE), ANCESTORS);
  assert.deepEqual(windowsClaudeTargetAncestors("c:\\claude.exe"), ["c:\\"]);
  assert.deepEqual(windowsClaudeTargetAncestors(`${DIR}\\Claude.EXE`), ANCESTORS);
});

test("no process start: route, row, identity, predicate, bounds, and request shape are validated", async () => {
  const cases: Array<[string, Partial<WindowsClaudeVersionProbeRequest>, WindowsClaudeVersionProbeDeps]> = [
    ["cmd route", { target: { route: "cmd-shim", rowId: ROW, file: FILE, identity: IDENTITY } as never }, {}],
    ["path-search route", { target: { route: "path-search", rowId: ROW, file: FILE, identity: IDENTITY } as never }, {}],
    ["missing route", { target: { rowId: ROW, file: FILE, identity: IDENTITY } as never }, {}],
    ["empty row", { target: { route: "direct-native-exe", rowId: "", file: FILE, identity: IDENTITY } }, {}],
    ["row with space", { target: { route: "direct-native-exe", rowId: "row 1", file: FILE, identity: IDENTITY } }, {}],
    ["row too long", { target: { route: "direct-native-exe", rowId: `r${"x".repeat(128)}`, file: FILE, identity: IDENTITY } }, {}],
    ["number identity", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { dev: 7, ino: 9001, size: 1, mtimeNs: 1 } as never } }, {}],
    ["zero inode", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { ...IDENTITY, ino: 0n } } }, {}],
    ["empty size", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { ...IDENTITY, size: 0n } } }, {}],
    ["missing mtime", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { dev: 7n, ino: 9001n, size: 1n, ctimeNs: 1n } as never } }, {}],
    ["missing change time", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { dev: 7n, ino: 9001n, size: 1n, mtimeNs: 1n } as never } }, {}],
    ["zero change time", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { ...IDENTITY, ctimeNs: 0n } } }, {}],
    ["number change time", { target: { route: "direct-native-exe", rowId: ROW, file: FILE, identity: { ...IDENTITY, ctimeNs: 1700 } as never } }, {}],
    ["null target", { target: null as never }, {}],
    ["predicate not a function", { isCurrent: true as never }, {}],
    ["timeout above ceiling", {}, { timeoutMs: WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS + 1 }],
    ["cleanup above ceiling", {}, { cleanupMs: WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS + 1 }],
    ["cap above ceiling", {}, { maxOutputBytes: WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES + 1 }],
    ["fractional timeout", {}, { timeoutMs: 1.5 }],
    ["zero cap", {}, { maxOutputBytes: 0 }],
  ];
  for (const [name, overrides, deps] of cases) {
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(witnessed());
    let predicateCalls = 0;
    const isCurrent = overrides.isCurrent ?? (() => { predicateCalls += 1; return true; });
    const outcome = await probeWindowsClaudeVersion(request({ ...overrides, isCurrent }, { fs, runner, ...deps }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "invalid-request", process: "none" }, name);
    assert.equal(calls.length, 0, name);
    assert.equal(fs.lstatCalls.length, 0, name);
    assert.equal(predicateCalls, 0, name);
  }
  assert.deepEqual(await probeWindowsClaudeVersion(null as never), { evidence: "refused", reason: "invalid-request", process: "none" });
});

/* -------------------------------------------------------------- environment */

test("environment: only allowlisted system names reach the probe; no provider, credential, or marker data", async () => {
  assert.deepEqual({ ...buildWindowsClaudeVersionEnvironment(SOURCE_ENV) }, EXPECTED_ENV);
  // Absent optional system names are pinned empty so libuv cannot import host values.
  assert.deepEqual({ ...buildWindowsClaudeVersionEnvironment({ SystemRoot: "C:\\Windows" }) }, {
    ...EXPECTED_ENV, SystemDrive: "", windir: "", TEMP: "", TMP: "",
  });
  // Identical case variants are one value; conflicting variants are refused.
  assert.deepEqual({ ...buildWindowsClaudeVersionEnvironment({ ...SOURCE_ENV, SYSTEMROOT: "C:\\Windows" }) }, EXPECTED_ENV);
  for (const source of [
    { ...SOURCE_ENV, SYSTEMROOT: "D:\\Other" },
    { ...SOURCE_ENV, SystemRoot: undefined },
    { ...SOURCE_ENV, SystemRoot: "Windows" },
    { ...SOURCE_ENV, SystemRoot: "\\\\server\\Windows" },
    { ...SOURCE_ENV, SystemDrive: "C:\\" },
    { ...SOURCE_ENV, SYSTEMDRIVE: "C" },
    { ...SOURCE_ENV, TEMP: "relative\\temp" },
    { ...SOURCE_ENV, TMP: "C:\\tmp\u0000x" },
    { ...SOURCE_ENV, windir: 7 },
    { ...SOURCE_ENV, [NATIVE_HOOK_BOOTSTRAP_ENV]: "bootstrap" },
    { ...SOURCE_ENV, [NATIVE_HOOK_BOOTSTRAP_ENV.toLowerCase()]: "bootstrap" },
    { ...SOURCE_ENV, [NATIVE_HOOK_BOOTSTRAP_ENV]: "" },
    // #736: the SEPARATE review-family marker is refused by the same rule, in every
    // casing and even when empty — a `--version` probe authenticates nothing.
    { ...SOURCE_ENV, [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "bootstrap" },
    { ...SOURCE_ENV, [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV.toLowerCase()]: "bootstrap" },
    { ...SOURCE_ENV, [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "" },
    null,
    [],
    "SystemRoot=C:\\Windows",
  ]) {
    assert.equal(buildWindowsClaudeVersionEnvironment(source), null, JSON.stringify(source));
  }

  const fs = new FakeFs();
  const { runner, calls } = fakeRunner(witnessed());
  const marked = await probeWindowsClaudeVersion(request({ env: { ...SOURCE_ENV, [NATIVE_HOOK_BOOTSTRAP_ENV]: "x" } }, { fs, runner }));
  assert.deepEqual(marked, { evidence: "refused", reason: "invalid-request", process: "none" });
  assert.equal(calls.length, 0);
  assert.equal(fs.lstatCalls.length, 0);

  const accepted = fakeRunner(witnessed());
  await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: accepted.runner }));
  const serialized = JSON.stringify(accepted.calls, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  for (const secret of SECRETS) assert.ok(!serialized.includes(secret), secret);
  for (const name of ["ANTHROPIC", "CLAUDE_CODE", "OPENAI", "PI_REVIEW_GATE", "ComSpec", "PATHEXT", "NODE_OPTIONS"]) {
    assert.ok(!serialized.includes(name), name);
  }
});

/* ---------------------------------------------------- context and stable identity */

test("context: the row predicate is rechecked before the effect and after the exit receipt", async () => {
  {
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({ isCurrent: () => false }, { fs, runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "context-changed", process: "none" });
    assert.equal(fs.lstatCalls.length, 0);
    assert.equal(calls.length, 0);
  }
  {
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({ isCurrent: () => { throw new Error("C:\\secret"); } }, { fs: new FakeFs(), runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "context-changed", process: "none" });
    assert.equal(calls.length, 0);
  }
  {
    let checks = 0;
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({ isCurrent: () => (checks += 1) === 1 }, { fs: new FakeFs(), runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "context-changed", process: "none" });
    assert.equal(calls.length, 0, "a row that stopped being current before the spawn starts nothing");
  }
  {
    let current = true;
    const { runner, calls } = fakeRunner(() => { current = false; return witnessed(); });
    const outcome = await probeWindowsClaudeVersion(request({ isCurrent: () => current }, { fs: new FakeFs(), runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "context-changed", process: "exact-child-exited", descendants: "witnessed-empty" });
    assert.equal(calls.length, 1);
  }
  {
    // A truthy non-boolean is not currency.
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({ isCurrent: (() => 1) as never }, { fs: new FakeFs(), runner }));
    assert.equal(outcome.evidence === "refused" && outcome.reason, "context-changed");
    assert.equal(calls.length, 0);
  }
});

test("identity: links, non-directories, missing objects, and mismatched identity are refused before any spawn", async () => {
  const cases: Array<[string, (fs: FakeFs) => void, string]> = [
    ["ancestor junction", (fs) => fs.entries.set(ANCESTORS[3]!, { ...dirFacts(4), kind: "link" }), "untrusted-path"],
    ["ancestor is a file", (fs) => fs.entries.set(ANCESTORS[2]!, { ...dirFacts(3), kind: "file" }), "untrusted-path"],
    ["ancestor missing", (fs) => fs.entries.delete(DIR), "untrusted-path"],
    ["ancestor access error", (fs) => fs.errors.set("C:\\Users", "EACCES"), "untrusted-path"],
    ["target is an execution alias link", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, kind: "link" }), "untrusted-target"],
    ["target is a directory", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, kind: "directory" }), "untrusted-target"],
    ["target missing", (fs) => fs.entries.delete(FILE), "untrusted-target"],
    ["different inode", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, ino: 9002n }), "target-identity-mismatch"],
    ["different volume", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, dev: 8n }), "target-identity-mismatch"],
    ["different size", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, size: TARGET_FACTS.size + 1n }), "target-identity-mismatch"],
    ["different mtime", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, mtimeNs: 1_701n }), "target-identity-mismatch"],
    // An in-place change since verification that preserves file id, size, and mtime.
    ["changed since verification", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, ctimeNs: 1_750n }), "target-identity-mismatch"],
    ["opened handle differs", (fs) => { fs.openFacts = { ...TARGET_FACTS, ino: 9003n }; }, "target-identity-mismatch"],
    ["opened handle ctime differs", (fs) => { fs.openFacts = { ...TARGET_FACTS, ctimeNs: 1_702n }; }, "target-identity-mismatch"],
    [".com fallback sibling exists", (fs) => fs.entries.set(`${FILE}.com`, TARGET_FACTS), "target-ambiguous"],
    [".exe fallback sibling exists", (fs) => fs.entries.set(`${FILE}.exe`, TARGET_FACTS), "target-ambiguous"],
    ["sibling unknowable", (fs) => fs.errors.set(`${FILE}.com`, "EACCES"), "target-ambiguous"],
    ["script renamed .exe", (fs) => { fs.bytes = Buffer.from("@echo off\r\nclaude %*\r\n"); fs.openFacts = { ...TARGET_FACTS }; }, "non-native-executable"],
    ["DLL image", (fs) => { fs.bytes = pe({ characteristics: 0x2022 }); }, "non-native-executable"],
  ];
  for (const [name, mutate, reason] of cases) {
    const fs = new FakeFs();
    mutate(fs);
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason, process: "none" }, name);
    assertClosedOutcome(outcome);
    assert.equal(calls.length, 0, name);
    assert.equal(fs.closed, fs.openCalls.length, `${name}: every opened handle is closed`);
  }
});

test("stale: a change between the checks and the spawn starts nothing; a change during the run is never evidence", async () => {
  {
    const fs = new FakeFs();
    fs.onLstat = (path, self) => {
      if (path === FILE && self.count(FILE) === 2) self.entries.set(FILE, { ...TARGET_FACTS, mtimeNs: 1_800n });
    };
    const { runner, calls } = fakeRunner(witnessed());
    assert.deepEqual(await probeWindowsClaudeVersion(request({}, { fs, runner })), { evidence: "refused", reason: "target-changed", process: "none" });
    assert.equal(calls.length, 0);
  }
  {
    const fs = new FakeFs();
    fs.onLstat = (path, self) => {
      if (path === `${FILE}.exe` && self.count(path) === 2) self.entries.set(path, TARGET_FACTS);
    };
    const { runner, calls } = fakeRunner(witnessed());
    assert.deepEqual(await probeWindowsClaudeVersion(request({}, { fs, runner })), { evidence: "refused", reason: "target-changed", process: "none" });
    assert.equal(calls.length, 0);
  }
  {
    const fs = new FakeFs();
    fs.onLstat = (path, self) => {
      if (path === DIR && self.count(DIR) === 2) self.entries.set(DIR, { ...dirFacts(77) });
    };
    const { runner, calls } = fakeRunner(witnessed());
    assert.deepEqual(await probeWindowsClaudeVersion(request({}, { fs, runner })), { evidence: "refused", reason: "target-changed", process: "none" });
    assert.equal(calls.length, 0, "a replaced cwd starts nothing");
  }
  const duringRun: Array<[string, (fs: FakeFs) => void]> = [
    ["target replaced", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, ino: 9100n })],
    ["target rewritten", (fs) => fs.entries.set(FILE, { ...TARGET_FACTS, ctimeNs: 1_999n })],
    ["target removed", (fs) => fs.entries.delete(FILE)],
    ["cwd replaced", (fs) => fs.entries.set(DIR, dirFacts(99))],
    ["ancestor became a junction", (fs) => fs.entries.set(ANCESTORS[1]!, { ...dirFacts(2), kind: "link" })],
    ["fallback sibling appeared", (fs) => fs.entries.set(`${FILE}.com`, TARGET_FACTS)],
  ];
  for (const [name, mutate] of duringRun) {
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(() => { mutate(fs); return witnessed(); });
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "target-changed", process: "exact-child-exited", descendants: "witnessed-empty" }, name);
    assert.equal(calls.length, 1);
  }
});

test("time: hung checks refuse at the deadline without spawning; hung post-run checks are never evidence", async () => {
  {
    const fs = new FakeFs();
    fs.hang = true;
    const { runner, calls } = fakeRunner(witnessed());
    const started = performance.now();
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner, timeoutMs: 40, cleanupMs: 20 }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "timeout", process: "none" });
    assert.equal(calls.length, 0);
    assert.ok(performance.now() - started < 1_000);
  }
  {
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(() => { fs.hang = true; return witnessed(); });
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner, timeoutMs: 40, cleanupMs: 20 }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "timeout", process: "exact-child-exited", descendants: "witnessed-empty" });
    assert.equal(calls.length, 1);
  }
  {
    // A receipt that lands after the final bound is not trusted.
    let clock = 0;
    const fs = new FakeFs();
    const { runner } = fakeRunner(() => { clock = 10_000; return witnessed(); });
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner, now: () => clock }));
    assert.deepEqual(outcome, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" });
  }
  {
    // Decoding itself crosses the final bound (a slow synchronous property read): the snapshot is discarded.
    let clock = 0;
    const { runner } = fakeRunner((_spec, bounds, now) => ({
      ...exited("abnormal-exit", "", "witnessed-empty", now()),
      get ownedHandles(): string {
        clock = bounds.deadline + bounds.cleanupMs + 1;
        return "closed";
      },
    }));
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner, now: () => clock }));
    assert.deepEqual(outcome, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" });
  }
  {
    // The same receipt decoded inside the bound is a clean exited refusal.
    const { runner } = fakeRunner((_spec, _bounds, now) => exited("abnormal-exit", "", "witnessed-empty", now()));
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "abnormal-exit", process: "exact-child-exited", descendants: "witnessed-empty" });
  }
});

/* ---------------------------------------------------------- runner receipts */

function runnerOf(run: WindowsExactImageVersionRunner["run"]): WindowsExactImageVersionRunner {
  return { binding: "exact-image-no-fallback", run };
}

test("receipts: unsettled and uncertain runs are distinct from clean refusals", async () => {
  const cases: Array<[string, WindowsExactImageVersionRunner["run"], WindowsClaudeVersionOutcome]> = [
    ["not created", async () => ({ exactChild: "not-created" }), { evidence: "refused", reason: "spawn-failed", process: "none" }],
    // The suspended child failed the before-resume proof: it never ran, was terminated, and its teardown was witnessed.
    ["terminated before resume", async () => ({ exactChild: "terminated-before-resume", ownedHandles: "closed", descendants: "witnessed-empty" }), { evidence: "refused", reason: "launch-unverified", process: "exact-child-exited", descendants: "witnessed-empty" }],
    ["terminated before resume, handles open", async () => ({ exactChild: "terminated-before-resume", ownedHandles: "open", descendants: "witnessed-empty" }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["terminated before resume, teardown unproven", async () => ({ exactChild: "terminated-before-resume", ownedHandles: "closed", descendants: "unproven" }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["superseded launch claim", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { launch: "bound-to-expected" }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["unsettled", async () => ({ exactChild: "unsettled" }), { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["spawn uncertain", async () => ({ exactChild: "spawn-uncertain" }), { evidence: "unsettled", reason: "spawn-uncertain", descendants: "unproven" }],
    ["synchronous throw", () => { throw new Error("C:\\secret"); }, { evidence: "unsettled", reason: "spawn-uncertain", descendants: "unproven" }],
    ["rejection", async () => { throw new Error("C:\\secret"); }, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["malformed", async () => ({ exactChild: "gone" }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["unknown kind", async (_s, _b, now) => exited("done" as never, OUT, "witnessed-empty", now()) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["unknown teardown", async (_s, _b, now) => exited("completed", OUT, "probably" as never, now()) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["launch not bound", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { launch: "pathname" }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["launch binding missing", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { launch: undefined }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["handle closure missing", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { ownedHandles: undefined }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["handles still open", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { ownedHandles: "open" }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["timeout without handle closure", async (_s, _b, now) => exited("timeout", "", "unproven", now(), { ownedHandles: undefined }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["byte count missing", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { outputBytes: undefined }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["negative byte count", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { outputBytes: -1 }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["capture time missing", async (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { captureCompletedAt: Number.NaN }) as never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" }],
    ["timeout", async (_s, _b, now) => exited("timeout", "", "unproven", now()) as never, { evidence: "refused", reason: "timeout", process: "exact-child-exited", descendants: "unproven" }],
    ["oversized", async (_s, _b, now) => exited("oversized", "", "unproven", now()) as never, { evidence: "refused", reason: "oversized", process: "exact-child-exited", descendants: "unproven" }],
    ["abnormal", async (_s, _b, now) => exited("abnormal-exit", OUT, "witnessed-empty", now()) as never, { evidence: "refused", reason: "abnormal-exit", process: "exact-child-exited", descendants: "witnessed-empty" }],
    ["output failed", async (_s, _b, now) => exited("output-failed", "", "unproven", now()) as never, { evidence: "refused", reason: "output-failed", process: "exact-child-exited", descendants: "unproven" }],
    ["completed, teardown unproven", async (_s, _b, now) => exited("completed", OUT, "unproven", now()) as never, { evidence: "refused", reason: "teardown-unproven", process: "exact-child-exited", descendants: "unproven" }],
  ];
  for (const [name, run, expected] of cases) {
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: runnerOf(run) }));
    assert.deepEqual(outcome, expected, name);
    assertClosedOutcome(outcome);
  }
  // A runner that never settles is unsettled at the final bound, never a clean refusal.
  const started = performance.now();
  const never = await probeWindowsClaudeVersion(request({}, {
    fs: new FakeFs(), runner: runnerOf(() => new Promise<never>(() => { /* never */ })), timeoutMs: 30, cleanupMs: 20,
  }));
  assert.deepEqual(never, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" });
  assert.ok(performance.now() - started < 1_000);
});

test("receipts: a throwing receipt is unsettled without an unhandled rejection, and each field is read once", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const throwing = runnerOf(async () => ({ get exactChild(): string { throw new Error("C:\\secret raw"); } }) as never);
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: throwing }));
    assert.deepEqual(outcome, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" });

    // A receipt whose fields change between reads cannot validate one value and use another.
    const reads = new Map<string, number>();
    const shifting = runnerOf(async (_s, _b, now) => {
      const base = exited("completed", OUT, "witnessed-empty", now());
      return new Proxy(base, {
        get(targetObject, key: string) {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          if (key === "stdout" && count > 1) return "9.9.9 (Claude Code)\n";
          return (targetObject as Record<string, unknown>)[key];
        },
      }) as never;
    });
    const shifted = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: shifting }));
    assert.equal(shifted.evidence === "version" && shifted.version, SUPPORTED);
    for (const [key, count] of reads) assert.equal(count, 1, key);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("bounds: completed receipts must substantiate the byte window and capture before the deadline", async () => {
  const cases: Array<[string, ReceiptFactory, WindowsClaudeVersionProbeDeps, string]> = [
    // A valid version line can never pass a cap it exceeds.
    ["combined bytes over the cap", witnessed(), { maxOutputBytes: 1 }, "oversized"],
    ["reported bytes over the cap", (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { outputBytes: WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES + 1 }), {}, "oversized"],
    // stdout alone over the cap, whatever byte count the receipt claims.
    ["stdout alone over the cap", (_s, _b, now) => exited("completed", `${OUT}${" ".repeat(64)}`, "witnessed-empty", now(), { outputBytes: 4 }), { maxOutputBytes: 32 }, "oversized"],
    ["stdout larger than the reported count", (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now(), { outputBytes: 3 }), {}, "output-failed"],
    ["capture before the run started", (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now() - 10_000), {}, "output-failed"],
    ["capture in the future", (_s, _b, now) => exited("completed", OUT, "witnessed-empty", now() + 1_000), {}, "output-failed"],
  ];
  for (const [name, factory, deps, reason] of cases) {
    const outcome = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: fakeRunner(factory).runner, ...deps }));
    assert.deepEqual(outcome, { evidence: "refused", reason, process: "exact-child-exited", descendants: "witnessed-empty" }, name);
  }
  // Exactly at the cap is admitted.
  const exact = await probeWindowsClaudeVersion(request({}, { fs: new FakeFs(), runner: fakeRunner(witnessed()).runner, maxOutputBytes: Buffer.byteLength(OUT) }));
  assert.equal(exact.evidence, "version");
});

test("bounds: a late capture during the cleanup grace and a late pre-spawn check are never evidence", async () => {
  {
    // Clock-driven: capture completes exactly at the run deadline, inside the cleanup grace.
    let clock = 0;
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner((_s, bounds) => {
      clock = bounds.deadline;
      return exited("completed", OUT, "witnessed-empty", bounds.deadline);
    });
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner, now: () => clock }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "timeout", process: "exact-child-exited", descendants: "witnessed-empty" });
    assert.equal(calls.length, 1);
  }
  {
    // A slow row predicate pushes the pre-spawn check past the deadline: the runner is never invoked.
    let clock = 0;
    let checks = 0;
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({
      isCurrent: () => {
        checks += 1;
        if (checks === 2) clock = WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS;
        return true;
      },
    }, { fs: new FakeFs(), runner, now: () => clock }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "timeout", process: "none" });
    assert.equal(checks, 2);
    assert.equal(calls.length, 0);
  }
});

test("bounds: the budget covers the first predicate and the exact start sample; a failed handle close starts nothing", async () => {
  {
    // The first predicate consumes the whole budget: no fresh budget, no filesystem access, no runner.
    let clock = 0;
    const fs = new FakeFs();
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({
      isCurrent: () => { clock = WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS; return true; },
    }, { fs, runner, now: () => clock }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "timeout", process: "none" });
    assert.equal(fs.lstatCalls.length, 0);
    assert.equal(calls.length, 0);
  }
  {
    // The clock reaches the deadline exactly at the start sample, after every earlier check passed.
    let clock = 0;
    let samples = 0;
    let armed = false;
    const { runner, calls } = fakeRunner(witnessed());
    let checks = 0;
    const outcome = await probeWindowsClaudeVersion(request({
      isCurrent: () => { checks += 1; if (checks === 2) armed = true; return true; },
    }, {
      fs: new FakeFs(),
      runner,
      now: () => {
        if (armed) {
          samples += 1;
          // Sample 1 is the post-predicate deadline check; sample 2 is the start sample.
          if (samples === 2) clock = WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS;
        }
        return clock;
      },
    }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "timeout", process: "none" });
    assert.equal(samples, 2);
    assert.equal(calls.length, 0);
  }
  {
    const fs = new FakeFs();
    const open = fs.open.bind(fs);
    fs.open = async (path) => {
      const handle = await open(path);
      return { ...handle, close: async () => { fs.closed += 1; throw errno("EIO"); } };
    };
    const { runner, calls } = fakeRunner(witnessed());
    const outcome = await probeWindowsClaudeVersion(request({}, { fs, runner }));
    assert.deepEqual(outcome, { evidence: "refused", reason: "internal-failure", process: "none" });
    assertClosedOutcome(outcome);
    assert.equal(fs.closed, 1);
    assert.equal(calls.length, 0);
  }
});

/* ------------------------------------------------------------ PE recognition */

test("PE: only 64-bit console executable images are recognized", async () => {
  assert.equal(await classifyWindowsNativeExecutable(reader(IMAGE), BigInt(IMAGE.length)), "pe32-plus-console");
  assert.equal(await classifyWindowsNativeExecutable(reader(pe({ machine: 0xaa64 })), 8192n), "pe32-plus-console");
  const refused: Array<[string, Buffer]> = [
    ["not MZ", pe({ mz: 0x4d5a })],
    ["header offset inside DOS header", pe({ peOffset: 0x20 })],
    ["header offset past the read window", pe({ peOffset: 4090 })],
    ["bad signature", pe({ signature: 0x00004e45 })],
    ["i386", pe({ machine: 0x14c })],
    ["ARMNT", pe({ machine: 0x1c4 })],
    ["no sections", pe({ sections: 0 })],
    ["too many sections", pe({ sections: 97 })],
    ["DLL", pe({ characteristics: 0x2022 })],
    ["not executable image", pe({ characteristics: 0x0020 })],
    ["PE32 magic", pe({ magic: 0x10b })],
    ["optional header too small", pe({ optSize: 96 })],
    ["GUI subsystem", pe({ subsystem: 2 })],
    ["native subsystem", pe({ subsystem: 1 })],
    ["section table beyond file", pe({ size: 400 })],
    ["batch text", Buffer.from("@echo off\r\nclaude %*\r\n".padEnd(200, " "))],
    ["shebang script", Buffer.from("#!/usr/bin/env node\n".padEnd(200, " "))],
  ];
  for (const [name, bytes] of refused) {
    assert.equal(await classifyWindowsNativeExecutable(reader(bytes), BigInt(bytes.length)), null, name);
  }
  assert.equal(await classifyWindowsNativeExecutable(reader(Buffer.alloc(10)), 10n), null);
  assert.equal(await classifyWindowsNativeExecutable(reader(IMAGE), 8192 as never), null);
  // A short read is never a format verdict.
  assert.equal(await classifyWindowsNativeExecutable(async () => IMAGE.subarray(0, 100), BigInt(IMAGE.length)), null);
});

/* ------------------------------------------------------------- inertness */

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("composition: only the launcher and host composition use it, closed surface, stated trust boundary, and no live compatibility claim", () => {
  assert.deepEqual(Object.keys(probeModule).sort(), [
    "WINDOWS_CLAUDE_VERSION_ARGS",
    "WINDOWS_CLAUDE_VERSION_ENV_PASSTHROUGH",
    "WINDOWS_CLAUDE_VERSION_ENV_PINNED_EMPTY",
    "WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS",
    "WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES",
    "WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS",
    "WINDOWS_CLAUDE_VERSION_ROUTE",
    "buildWindowsClaudeVersionEnvironment",
    "classifyWindowsNativeExecutable",
    "probeWindowsClaudeInboxCompatibility",
    "probeWindowsClaudeVersion",
    "windowsClaudeTargetAncestors",
    "windowsImageOf",
  ]);
  assert.equal(WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS, 5_000);
  assert.equal(WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES, 4 * 1024);
  const text = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(text.includes("## Production composition"));
  assert.ok(text.includes("The runner was observed on real Windows (stock\n * PowerShell 5.1) before wiring"));
  assert.doesNotMatch(text, /INACTIVE|no product path/u);
  // The accepted limitation is stated, and no post-hoc identity binding is claimed.
  assert.ok(text.includes("no claim of an\n * independently verified child cwd or of sandboxing an attacker running as the\n * same user."));
  assert.doesNotMatch(text, /bound-to-expected|bind the created process/u);
  assert.ok(text.includes("live\n * Windows compatibility of any Claude build"));
  // The module starts nothing itself: no process API, shell, PowerShell, cmd, Python trampoline, or PID signal.
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /child_process|\bspawn(?:Sync)?\(|shell:|powershell|cmd\.exe|python|process\.kill\(|execFile|execSync|(?<![.\w])exec\(/iu);
  // It never imports the runner, and has no default one.
  assert.doesNotMatch(code, /native-windows-claude-version-runner/u);
  // #682: the runner, the native CLI launcher, and the host composition import the
  // probe; only the host composition builds the runner. No other product path.
  const runnerPath = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-version-runner.ts");
  const launcherPath = join(PROJECT_ROOT, "src", "session-host", "native-cli-launch.ts");
  const compositionPath = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-host-composition.ts");
  for (const file of listTs(join(PROJECT_ROOT, "src"))) {
    if (file === MODULE_SOURCE_PATH || file === runnerPath) continue;
    const source = readFileSync(file, "utf8");
    if (file !== launcherPath && file !== compositionPath) {
      assert.ok(!source.includes("native-windows-claude-version-probe"), `${file} must not import the probe`);
    }
    if (file !== compositionPath) {
      assert.ok(!source.includes("native-windows-claude-version-runner"), `${file} must not import the runner`);
    }
  }
});
