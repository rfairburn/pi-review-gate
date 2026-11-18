import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecFileException } from "node:child_process";
import type { Readable } from "node:stream";
import {
  awaitPiSettlementReceipt,
  createPiSettlementBootstrap,
  type PiSettlementBootstrap,
} from "../src/execution/pi-settlement-receipt";
import {
  MAX_QUERY_OUTPUT_BYTES,
  MAX_WINDOWS_PROCESS_ID,
  WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS,
  WINDOWS_LINEAGE_REFUSAL_REASONS,
  classifyWindowsAncestryEvidence,
  classifyWindowsLineageQueryFailure,
  isVerifiedWindowsAncestryEvidence,
  isWindowsLineageRefusalReason,
  verifyWindowsProcessLineage,
  windowsLineageQueryEnvironment,
  type WindowsLineageQueryChild,
  type WindowsLineageQueryExecutor,
  type WindowsLineageQueryOptions,
  type WindowsLineageVerification,
} from "../src/execution/windows-process-lineage";
import {
  WINDOWS_LINEAGE_DIAGNOSTIC_MAX_CHARS,
  WINDOWS_LINEAGE_PHASES,
  createWindowsLineagePhaseProbe,
  formatWindowsLineagePhaseDiagnostic,
  instrumentWindowsLineageScript,
  parseWindowsLineagePhaseMarker,
} from "./helpers/windows-lineage-phase-diagnostics";
import {
  WINDOWS_LINEAGE_CAUSAL_ARMS,
  WINDOWS_LINEAGE_CAUSAL_CHILD_FRAMES,
  WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER,
  WINDOWS_LINEAGE_CAUSAL_GATE_BOUND_MS,
  WINDOWS_LINEAGE_CAUSAL_MAX_ADDED_LINES,
  WINDOWS_LINEAGE_CAUSAL_MAX_FRAME_BYTES,
  WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS,
  WINDOWS_LINEAGE_CAUSAL_VERSION,
  assessWindowsLineageCausalExperiment,
  assessWindowsLineageCausalLedger,
  classifyModulePathCategories,
  countModulePathKeys,
  createWindowsLineageCausalLedger,
  createWindowsLineageCausalProbe,
  createWindowsLineageReleaseGate,
  formatWindowsLineageCausalRecord,
  formatWindowsLineageReleaseGate,
  instrumentWindowsLineageCausalScript,
  nativeWindowsModulesDir,
  parseWindowsLineageCausalFrame,
  type WindowsLineageCausalArm,
  type WindowsLineageCausalChild,
  type WindowsLineageCausalLauncher,
  type WindowsLineageCausalLaunchOptions,
  type WindowsLineageCausalProbe,
  type WindowsLineageCausalRecord,
} from "./helpers/windows-lineage-causal-experiment";

/**
 * Issue #335 diagnosis: the ORIGINAL Windows lineage verification invocation
 * now reports WHICH bounded stage refused, through one fixed sanitized stage
 * code appended to the existing settlement refusal. These regressions drive the
 * production orchestration (preflight → one bounded query child → native
 * sentinel / evidence validation → final owned-root liveness) with a mocked
 * query child plus the original boolean acceptance validator, and prove that
 * nothing about acceptance, bounds, ownership, timing, or privacy changed.
 */

const BASE_REFUSAL = "Pi executor settlement acknowledgement PID is not a verified live descendant of its owned shell.";
const FAKE_SECRET = "SUP3RSECRET-token-value";
const FAKE_PRIVATE_PATH = "C:\\Users\\vic\\secrets\\powershell.exe";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function evidenceRows(records: Array<{
  pid: number;
  parentPid: number;
  creationTicks: number;
  observedTicks?: number;
}>): string {
  const ticks = (value: number): string => String(value).padStart(19, "0");
  return records.map((record) => [
    record.pid,
    record.parentPid,
    ticks(record.observedTicks ?? record.creationTicks),
    ticks(record.creationTicks),
  ].join(",")).join(";");
}

const CANDIDATE_PID = 67890;
const OWNED_ROOT_PID = 4321;

const VALID_EVIDENCE = evidenceRows([
  { pid: CANDIDATE_PID, parentPid: 54321, creationTicks: 300 },
  { pid: 54321, parentPid: OWNED_ROOT_PID, creationTicks: 200 },
  { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
]);

/** A live owned cmd.exe root as the verifier observes it (`null` = no PID yet). */
function fakeOwnedRoot(pid: number | null = OWNED_ROOT_PID): ChildProcess {
  return { pid: pid ?? undefined, exitCode: null, signalCode: null } as unknown as ChildProcess;
}

function markRootExited(ownedRoot: ChildProcess): void {
  (ownedRoot as { exitCode: number | null }).exitCode = 0;
}

type FakeQueryBehavior =
  | { kind: "output"; output: string }
  | { kind: "error"; error: unknown }
  | { kind: "chunked"; stdoutChunks: string[]; stderrChunks: string[]; error: unknown };

interface FakeQuery {
  execute: WindowsLineageQueryExecutor;
  calls: Array<{ file: string; args: string[]; options: WindowsLineageQueryOptions }>;
  killCount: () => number;
}

/**
 * One mocked bounded query child. It settles asynchronously so the verifier
 * attaches its own output accounting first. `kill()` only signals the child: as
 * with a real `execFile` child, the query settles on its own completion callback,
 * never on the signal itself.
 */
function fakeQuery(
  behavior: FakeQueryBehavior,
  hooks: { beforeSettle?: () => void } = {},
): FakeQuery {
  const calls: FakeQuery["calls"] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = 0;
  let settled = false;
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const settle = (error: unknown, output = ""): void => {
    if (settled || !callback) return;
    settled = true;
    hooks.beforeSettle?.();
    callback(error as ExecFileException | null, output, "");
  };
  const child: WindowsLineageQueryChild = {
    kill: () => {
      killed += 1;
      return true;
    },
    stdout: stdout as unknown as Readable,
    stderr: stderr as unknown as Readable,
  };
  const execute: WindowsLineageQueryExecutor = (file, args, options, cb) => {
    calls.push({ file, args, options });
    callback = cb;
    if (behavior.kind === "output") setImmediate(() => settle(null, behavior.output));
    if (behavior.kind === "error") setImmediate(() => settle(behavior.error));
    if (behavior.kind === "chunked") {
      setImmediate(() => {
        for (const chunk of behavior.stdoutChunks) stdout.emit("data", chunk);
        for (const chunk of behavior.stderrChunks) stderr.emit("data", chunk);
        settle(behavior.error);
      });
    }
    return child;
  };
  return { execute, calls, killCount: () => killed };
}

/**
 * A query child that never settles on its own: the test decides when and how it
 * ends, so a refusal can only be attributed to a timeout when the verifier's own
 * deadline callback is what killed it.
 */
function fakeDeferredQuery(): FakeQuery & { settle: (error: unknown, output?: string) => void } {
  const calls: FakeQuery["calls"] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = 0;
  let settled = false;
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const execute: WindowsLineageQueryExecutor = (file, args, options, cb) => {
    calls.push({ file, args, options });
    callback = cb;
    const child: WindowsLineageQueryChild = {
      kill: () => {
        killed += 1;
        return true;
      },
      stdout: stdout as unknown as Readable,
      stderr: stderr as unknown as Readable,
    };
    return child;
  };
  return {
    execute,
    calls,
    killCount: () => killed,
    settle: (error, output = "") => {
      if (settled) return;
      settled = true;
      callback?.(error as ExecFileException | null, output, "");
    },
  };
}

interface ControllableQuery {
  execute: WindowsLineageQueryExecutor;
  calls: Array<{ file: string; args: string[]; options: WindowsLineageQueryOptions }>;
  killCount: () => number;
  /** Fire the executor's own completion callback, exactly as a real child would. */
  report: (error?: unknown, output?: string) => void;
}

/**
 * A query child whose whole lifecycle the test drives: `kill()` only counts (or
 * throws, for the failed-signal regression), and the executor callback runs only
 * when the test says so. That is the real `execFile` shape — signalling a child
 * and the callback that settles the query are two separate events.
 */
function fakeControllableQuery(hooks: { killThrows?: boolean } = {}): ControllableQuery {
  const calls: ControllableQuery["calls"] = [];
  let killCount = 0;
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const execute: WindowsLineageQueryExecutor = (file, args, options, cb) => {
    calls.push({ file, args, options });
    callback = cb;
    return {
      kill: () => {
        if (hooks.killThrows) throw new Error(`cannot signal the query child at ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`);
        killCount += 1;
        return true;
      },
      stdout: new EventEmitter() as unknown as Readable,
      stderr: new EventEmitter() as unknown as Readable,
    };
  };
  return {
    execute,
    calls,
    killCount: () => killCount,
    report: (error = null, output = "") => callback?.(error as ExecFileException | null, output, ""),
  };
}

/** Run every queued microtask and immediate, so a settled promise would be observed. */
function flushAsync(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

/**
 * Drive one mocked win32 verification and return the exact PowerShell script the production
 * module handed to its single bounded query child, plus what that verification decided. These
 * guards pin the shape of the script that the win32-only native case then really executes; they
 * are not a substitute for that native proof, and no claim here is that a mocked executor
 * validates PowerShell behaviour itself.
 */
async function captureLineageScript(
  ownedRoot: ChildProcess = fakeOwnedRoot(),
  candidatePid: number = CANDIDATE_PID,
): Promise<{ script: string; options: WindowsLineageQueryOptions; result: Awaited<ReturnType<typeof verifyWithMockedQuery>> }> {
  const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query, ownedRoot, candidatePid));
  assert.equal(query.calls.length, 1, "batching the initial lookup never adds a query child or a retry");
  return { script: query.calls[0].args[4], options: query.calls[0].options, result };
}

/** Every index at which `needle` occurs in `haystack`. */
function allIndexes(haystack: string, needle: string): number[] {
  const indexes: number[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) indexes.push(at);
  return indexes;
}

/** The `Verb-Noun` cmdlet names the script asks PowerShell to resolve. */
function cmdletNames(script: string): string[] {
  return [...new Set(script.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g) ?? [])].sort();
}

/** The `-Filter` literal of the script's single initial CIM request. */
function initialLookupFilter(script: string): string | undefined {
  const line = script.split("\n").find((candidate) => candidate.startsWith("$initial = @(Get-CimInstance"));
  return line === undefined ? undefined : /-Filter "([^"]*)"/.exec(line)?.[1];
}

/** The decimal PID literals the script assigns to its two known-PID variables. */
function knownPidLiterals(script: string): Array<[string, string | undefined]> {
  return ["$targetPid", "$rootPid"].map((name) => [
    name,
    new RegExp(`^\\${name} = (\\d+)$`, "m").exec(script)?.[1],
  ]) as Array<[string, string | undefined]>;
}

/** Drive the production verifier on a mocked win32 host with a mocked query child. */
async function verifyWithMockedQuery(
  query: FakeQuery,
  ownedRoot: ChildProcess = fakeOwnedRoot(),
  candidatePid: number = CANDIDATE_PID,
): Promise<{ verified: boolean; reason?: string }> {
  return await verifyWindowsProcessLineage(ownedRoot, candidatePid, { platform: "win32", execute: query.execute });
}

/** A SystemRoot the cross-host tests can control; production reads the parent's. */
async function withSystemRoot<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const savedRoot = process.env.SystemRoot;
  const savedWindir = process.env.WINDIR;
  if (value === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = value;
  delete process.env.WINDIR;
  try {
    return await fn();
  } finally {
    if (savedRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = savedRoot;
    if (savedWindir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = savedWindir;
  }
}

/**
 * Temporarily set (string) or delete (undefined) keys of this process's
 * environment, restoring every touched key afterwards. On Windows the process
 * environment is case-insensitive, so case aliases collapse onto one key there;
 * assertions built on this helper count keys instead of assuming the aliases stay
 * distinct.
 */
async function withProcessEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.keys(patch).map((key) => [key, Object.hasOwn(process.env, key), process.env[key]] as const);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key] of [...saved].reverse()) delete process.env[key];
    for (const [key, had, value] of saved) if (had) process.env[key] = value;
  }
}

/** Synthetic environment entries; only these allowlisted names are ever named in a failure. */
const SYNTHETIC_ENV_PATCH: Record<string, string> = {
  PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  psmodulepath: "alias-lower",
  PSMODULEPATH: "alias-upper",
  WinPSModulePath: "keep-winps",
  PSModulePathX: "keep-suffix",
  PRG_L446_ENV_SENTINEL: "keep-sentinel",
};

/** The parent's actual key spellings (Windows keeps one spelling per name) that a failure may name. */
function allowlistedEnvKeys(parentEnv: NodeJS.ProcessEnv): string[] {
  const names = ["path", "systemroot", "winpsmodulepath", "psmodulepathx", "prg_l446_env_sentinel"];
  return Object.keys(parentEnv).filter((key) => names.includes(key.toLowerCase()));
}

/**
 * Compare a query child's environment with the specification (every key of
 * `parentEnv` except case-insensitive `PSModulePath`, values identical, nothing
 * added) using counts and booleans only, so a failing assertion can never print an
 * environment value or an unexpected key name.
 */
function queryEnvironmentDifference(env: unknown, parentEnv: NodeJS.ProcessEnv): {
  isObject: boolean;
  isParent: boolean;
  modulePathKeys: number;
  missing: number;
  changed: number;
  extra: number;
  allowlisted: Record<string, boolean>;
} {
  const isObject = typeof env === "object" && env !== null;
  const received = (isObject ? env : {}) as NodeJS.ProcessEnv;
  const isModulePathKey = (key: string): boolean => key.toLowerCase() === "psmodulepath";
  const retained = Object.keys(parentEnv).filter((key) => !isModulePathKey(key));
  const allowlisted: Record<string, boolean> = {};
  for (const key of allowlistedEnvKeys(parentEnv)) {
    allowlisted[key] = Object.hasOwn(received, key) && received[key] === parentEnv[key];
  }
  return {
    isObject,
    isParent: env === parentEnv,
    modulePathKeys: Object.keys(received).filter(isModulePathKey).length,
    missing: retained.filter((key) => !Object.hasOwn(received, key)).length,
    changed: retained.filter((key) => Object.hasOwn(received, key) && received[key] !== parentEnv[key]).length,
    extra: Object.keys(received).filter((key) => !Object.hasOwn(parentEnv, key)).length,
    allowlisted,
  };
}

/** The exact difference a correct producer leaves: none, apart from the removed keys. */
function expectedEnvironmentDifference(parentEnv: NodeJS.ProcessEnv): ReturnType<typeof queryEnvironmentDifference> {
  const allowlisted: Record<string, boolean> = {};
  for (const key of allowlistedEnvKeys(parentEnv)) allowlisted[key] = true;
  return { isObject: true, isParent: false, modulePathKeys: 0, missing: 0, changed: 0, extra: 0, allowlisted };
}

/** Allowlisted shape of the query options: fixed keys and values plus env booleans/counts, never env content. */
function queryOptionsShape(options: WindowsLineageQueryOptions): Record<string, unknown> {
  return {
    keys: Object.keys(options).sort(),
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
    envIsObject: typeof options.env === "object" && options.env !== null,
    envIsProcessEnv: options.env === process.env,
    envModulePathKeys: countModulePathKeys(options.env),
  };
}

const PRODUCTION_OPTIONS_SHAPE = {
  keys: ["encoding", "env", "maxBuffer", "windowsHide"],
  encoding: "utf8",
  maxBuffer: MAX_QUERY_OUTPUT_BYTES,
  windowsHide: true,
  envIsObject: true,
  envIsProcessEnv: false,
  envModulePathKeys: 0,
};

/** A boolean-only snapshot comparison of this process's environment. */
function processEnvSnapshot(): () => { sameKeys: boolean; sameValues: boolean } {
  const before = new Map(Object.entries(process.env));
  return () => {
    const after = Object.entries(process.env);
    return {
      sameKeys: after.length === before.size && after.every(([key]) => before.has(key)),
      sameValues: after.every(([key, value]) => before.get(key) === value),
    };
  };
}

async function writeSignedReceipt(
  bootstrap: PiSettlementBootstrap,
  pid: number,
  settlement: number,
  corruptMac = false,
): Promise<void> {
  const unsigned = { version: 2, sessionId: bootstrap.sessionId, childId: bootstrap.childId, settlement, pid };
  const oneShot = createHmac("sha256", bootstrap.secret)
    .update(`pi-review-gate-live-browser-settlement-key:v2:${settlement}`)
    .digest();
  const mac = createHmac("sha256", oneShot)
    .update(JSON.stringify([unsigned.version, unsigned.sessionId, unsigned.childId, unsigned.settlement, unsigned.pid]))
    .digest("base64url");
  const writtenMac = corruptMac ? `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}` : mac;
  await mkdir(join(bootstrap.path, ".."), { recursive: true });
  await writeFile(bootstrap.path, `${JSON.stringify({ ...unsigned, mac: writtenMac })}\n`);
}

async function withReceiptRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "prg-lineage-diagnostics-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The refusal message one settlement wait produced, or an acceptance failure. */
async function refusalMessage(parent: PiSettlementBootstrap): Promise<string> {
  return await awaitPiSettlementReceipt(parent, 0, 100).then(
    () => { throw new Error("an unverified PID must never be accepted"); },
    (error: unknown) => (error as Error).message,
  );
}

// ---------------------------------------------------------------------------
// Production lineage orchestration through a mocked bounded query child
// ---------------------------------------------------------------------------

test("the original acceptance conditions are unchanged and report no refusal stage", async () => {
  const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
  assert.deepEqual(result, { verified: true }, "authentic bounded evidence still verifies");
  assert.equal(query.calls.length, 1, "exactly one bounded query child runs, never a retry");
  assert.equal(query.calls[0].file, join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.deepEqual(query.calls[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.deepEqual(queryOptionsShape(query.calls[0].options), { ...PRODUCTION_OPTIONS_SHAPE, maxBuffer: 4096 },
    "the query keeps its 4KiB output bound, stays hidden, and gets its own environment copy");
  assert.ok(!("timeout" in query.calls[0].options),
    "the verifier owns the deadline callback, so timeout evidence is positively witnessed");
  const script = query.calls[0].args[4];
  assert.match(script, /for \(\$step = 0; \$step -lt 64; \$step\+\+\)/, "the parent walk stays bounded to 64 steps");
  assert.ok(script.includes("PI_REVIEW_GATE_LINEAGE_NO:"), "every native refusal carries a fixed stage");
  assert.ok(!script.includes("CommandLine") && !script.includes("Get-Process"),
    "the bounded query still inspects no command lines, paths, or shim contents");
  assert.equal(isVerifiedWindowsAncestryEvidence(VALID_EVIDENCE, CANDIDATE_PID, OWNED_ROOT_PID), true,
    "the boolean acceptance view agrees with the typed result");
});

test("the query child gets production's environment copy without any PSModulePath key and nothing else changes", async () => {
  await withProcessEnv(SYNTHETIC_ENV_PATCH, async () => {
    const parentAliases = countModulePathKeys(process.env);
    assert.ok(parentAliases >= 1, "the parent environment carries at least one PSModulePath key for this case");
    const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
    const outcome = await withSystemRoot("/fake-windows", async () => {
      const unchanged = processEnvSnapshot();
      const result = await verifyWithMockedQuery(query);
      // Compared while the same parent environment (including SystemRoot) is in effect.
      return { result, difference: queryEnvironmentDifference(query.calls[0]?.options.env, process.env),
        expected: expectedEnvironmentDifference(process.env), unchanged: unchanged() };
    });
    assert.deepEqual(outcome.result, { verified: true }, "the corrected environment changes no acceptance decision");
    assert.equal(query.calls.length, 1, "still exactly one bounded query child, never a retry or warmup");
    assert.deepEqual(outcome.difference, outcome.expected,
      "the child env is a new copy: every case-insensitive PSModulePath key removed, every other key and value kept, nothing added");
    assert.deepEqual(outcome.unchanged, { sameKeys: true, sameValues: true }, "this process's environment is never modified");
    assert.equal(countModulePathKeys(process.env), parentAliases, "the parent keeps every PSModulePath key it had");
    assert.deepEqual(queryOptionsShape(query.calls[0]!.options), PRODUCTION_OPTIONS_SHAPE,
      "the host options are unchanged apart from the environment copy");
    assert.deepEqual(query.calls[0]!.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
      "the same fixed host arguments: no module import or command lookup is added");
    assert.ok(!/Import-Module|Get-Command|Get-Module/.test(query.calls[0]!.args[4]!), "the script adds no module import or lookup");
  });
});

test("the canonical query environment factory removes only case-insensitive PSModulePath keys from a new copy", () => {
  const parent: NodeJS.ProcessEnv = {
    PSModulePath: "a", psmodulepath: "b", PSMODULEPATH: "c", PsModulePath: "d",
    PATH: "C:\\bin", WinPSModulePath: "keep", PSModulePathX: "keep", XPSModulePath: "keep", SystemRoot: "C:\\Windows", EMPTY: "",
  };
  const before = { ...parent };
  const child = windowsLineageQueryEnvironment(parent);
  assert.deepEqual(parent, before, "the parent environment object is never modified");
  assert.notEqual(child, parent, "the copy is a new object");
  assert.deepEqual(Object.keys(child).sort(), ["EMPTY", "PATH", "PSModulePathX", "SystemRoot", "WinPSModulePath", "XPSModulePath"],
    "every case alias of PSModulePath is removed and no look-alike key is");
  assert.ok(Object.keys(child).every((key) => child[key] === parent[key]), "every retained value is copied unchanged");
  assert.notEqual(windowsLineageQueryEnvironment(parent), child, "each call builds its own copy");
});

test("the canonical query environment factory keeps an own __proto__ key as an ordinary key", () => {
  // Built without object-literal prototype syntax, so `__proto__` is a real own key.
  const parent = Object.fromEntries([
    ["PATH", "C:\\bin"], ["__proto__", "own-proto-value"], ["PSModulePath", "removed"], ["SystemRoot", "C:\\Windows"],
  ]) as NodeJS.ProcessEnv;
  Object.defineProperty(parent, "Ordinary", { value: "ordinary-value", enumerable: true, writable: true, configurable: true });
  const parentKeysBefore = Object.keys(parent).join("\u0000");
  const child = windowsLineageQueryEnvironment(parent);
  const ownValue = (env: object, key: string): unknown => Object.getOwnPropertyDescriptor(env, key)?.value;
  assert.deepEqual({
    protoKept: Object.hasOwn(child, "__proto__") && ownValue(child, "__proto__") === ownValue(parent, "__proto__"),
    prototypeUnchanged: Object.getPrototypeOf(child) === Object.prototype,
    othersKept: ["PATH", "SystemRoot", "Ordinary"].every((key) => Object.hasOwn(child, key) && ownValue(child, key) === ownValue(parent, key)),
    targetRemoved: !Object.hasOwn(child, "PSModulePath"),
    keyCount: Object.keys(child).length,
    parentUnchanged: Object.keys(parent).join("\u0000") === parentKeysBefore && Object.hasOwn(parent, "PSModulePath"),
  }, {
    protoKept: true, prototypeUnchanged: true, othersKept: true, targetRemoved: true, keyCount: 4, parentUnchanged: true,
  }, "an own __proto__ key and every ordinary key survive the copy; only PSModulePath is removed");
});

test("the initial lookup batches exactly the two known PIDs and saves one CIM round trip", async () => {
  const { script, result } = await captureLineageScript();
  assert.deepEqual(result, { verified: true }, "the scripted proof still accepts authentic evidence");

  // Three bounded CIM requests remain: the batched initial lookup, the one
  // per-ancestor walk lookup, and the independent fresh full-chain snapshot. The
  // separate owned-root-only lookup is the request the batch replaced, so a valid
  // proof now costs two round trips instead of three at the shortest chain.
  assert.equal(script.split("Get-CimInstance").length - 1, 3,
    "one initial batch, one ancestor hop, one fresh snapshot: no separate owned-root lookup");

  const initial = script.split("\n").find((line) => line.startsWith("$initial = @(Get-CimInstance"));
  assert.ok(initial !== undefined, "the candidate and the owned root are observed by one initial request");
  assert.equal(initialLookupFilter(script), "ProcessId = $targetPid OR ProcessId = $rootPid",
    "the initial filter lists only the two PIDs under verification, so it can never enumerate the host");
  assert.deepEqual(knownPidLiterals(script), [["$targetPid", String(CANDIDATE_PID)], ["$rootPid", String(OWNED_ROOT_PID)]],
    "both PIDs enter the script only as the already-validated decimal literals");
  assert.ok(initial.includes("-Property ProcessId,ParentProcessId,CreationDate"),
    "the batched request reads the same three properties as every later lookup");
  assert.ok(script.indexOf("$initial = @(Get-CimInstance") < script.indexOf("for ($step = 0"),
    "the batched lookup happens before the parent walk starts");
  assert.ok(script.indexOf("chain-candidate-record-missing") < script.indexOf("for ($step = 0"),
    "a missing candidate is still refused at the original stage, before any walking");
  for (const line of script.split("\n")) {
    if (line.includes("Get-CimInstance")) {
      assert.ok(line.includes("-Filter "), `every CIM request stays filtered, found: ${line}`);
    }
  }
  assert.deepEqual(cmdletNames(script), ["ForEach-Object", "Get-CimInstance", "New-Object"],
    "selecting and counting the records by PID adds no new cmdlet for the host to resolve");
  assert.ok(script.includes("$candidateRows = 0") && script.includes("$rootRows = 0") && script.includes("$unexpectedRows = 0"),
    "every initial row is counted, so a duplicate or unexpected row cannot be silently discarded");
  const membershipGuard = script.indexOf("if ($candidateRows -gt 1 -or $unexpectedRows -gt 0)");
  assert.ok(membershipGuard > 0 && membershipGuard < script.indexOf("for ($step = 0"),
    "a duplicated candidate or an unrequested PID is refused before any walking, on an existing fixed stage");
  assert.ok(script.includes("if ($candidateRows -gt 1 -or $unexpectedRows -gt 0) { [Console]::Out.WriteLine('PI_REVIEW_GATE_LINEAGE_NO:snapshot-count-mismatch')"),
    "the initial membership refusal reuses the existing snapshot-count stage rather than a new one");

  // The batch is scoped to the identity actually under verification, never to a
  // collected or cached value.
  const other = (await captureLineageScript(fakeOwnedRoot(999), 55555)).script;
  assert.equal(initialLookupFilter(other), "ProcessId = $targetPid OR ProcessId = $rootPid",
    "the filter shape does not widen for another identity");
  assert.deepEqual(knownPidLiterals(other), [["$targetPid", "55555"], ["$rootPid", "999"]],
    "the batch follows the candidate and root actually under verification");
});

test("the batched initial root observation cannot shorten the walk or replace the fresh snapshot", async () => {
  const { script } = await captureLineageScript();
  const loopStart = script.indexOf("for ($step = 0");
  const rootBranch = script.indexOf("  if ($parent -eq $rootPid) {");
  const afterRootBranch = script.indexOf("  $seen[[string]$parent] = $true");
  assert.ok(loopStart > 0 && rootBranch > loopStart && afterRootBranch > rootBranch,
    "the walk still reaches the owned root through its parent links");

  assert.ok(script.includes('  $current = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = $parent"'),
    "every intermediate ancestor is still its own bounded lookup, never skipped or inferred");
  assert.ok(script.indexOf("chain-ancestor-record-missing") > afterRootBranch,
    "a missing intermediate ancestor is still refused by the walk itself");

  // The initial root row is only ever read before the walk, and inside the branch where
  // the walk positively reached the root, so it can never satisfy a hop or append the
  // root early. A chain that wanders elsewhere never touches it at all.
  const initialRootUses = allIndexes(script, "$initialRoot");
  assert.equal(initialRootUses.length, 3, "the initial root is initialised, selected once, and used once");
  for (const at of initialRootUses) {
    assert.ok(at < loopStart || (at > rootBranch && at < afterRootBranch),
      "the initial root observation stays inside this verification's root-reached branch");
  }
  const rootUniqueness = script.indexOf("if ($rootRows -ne 1)");
  assert.ok(rootUniqueness > rootBranch && rootUniqueness < afterRootBranch,
    "a missing or duplicated owned root is refused only on the root-reached branch, so unrelated chains keep their own refusal stages");
  assert.ok(script.indexOf("[void]$chain.Add($rootPid)") > rootUniqueness,
    "the root only joins the chain after the walk reached it and its record was proven unambiguous");

  // Acceptance still comes only from the unchanged independent fresh snapshot of the
  // whole chain: it re-reads every observed PID, re-checks each observed creation date,
  // counts records, and re-checks parent coherence, so a root that exited or had its
  // PID reused since the initial batch is refused there rather than accepted.
  const snapshot = script.slice(rootBranch, afterRootBranch);
  for (const required of [
    "$filter = ($chain | ForEach-Object { \"ProcessId = $_\" }) -join ' OR '",
    "$liveProcesses = @(Get-CimInstance",
    "if ($liveProcesses.Count -ne $chain.Count) {",
    "$record.CreationDate -ne $observed.CreationDate",
    "$stage = 'snapshot-record-missing'",
    "$stage = 'snapshot-parent-incoherent'",
    "PI_REVIEW_GATE_LINEAGE_NO:$",
  ]) {
    assert.ok(snapshot.includes(required), `the fresh full-chain check still performs: ${required}`);
  }
  for (const stage of ["snapshot-count-mismatch", "snapshot-record-missing", "snapshot-creation-mismatch", "snapshot-parent-incoherent"]) {
    assert.ok(snapshot.includes(stage), `${stage} is still a fail-closed fresh-snapshot stage`);
  }
  assert.equal((snapshot.match(/\[Console\]::Out\.WriteLine\(\(\$evidence/g) ?? []).length, 1,
    "accepting evidence is emitted from exactly one place: the fresh-snapshot branch");
  assert.ok(snapshot.indexOf("[Console]::Out.WriteLine(($evidence") > snapshot.indexOf("$record.CreationDate -ne $observed.CreationDate"),
    "evidence is emitted only after every observed creation date was re-checked");

  // Every fail-closed chain stage that batching could have displaced is still emitted.
  for (const stage of [
    "chain-candidate-record-missing", "chain-owned-root-record-missing", "chain-ancestor-record-missing",
    "chain-parent-absent", "chain-cycle", "chain-depth-limit",
  ]) {
    assert.ok(script.includes(`PI_REVIEW_GATE_LINEAGE_NO:${stage}`), `${stage} is still a native refusal`);
  }
});

test("preflight refusals are fixed stages and never start a query child", async () => {
  const cases: Array<{ name: string; ownedRoot: ChildProcess; candidatePid: number; platform: NodeJS.Platform; expected: string }> = [
    { name: "non-win32 host", ownedRoot: fakeOwnedRoot(), candidatePid: CANDIDATE_PID, platform: "darwin", expected: "preflight-not-win32" },
    { name: "missing root pid", ownedRoot: fakeOwnedRoot(null), candidatePid: CANDIDATE_PID, platform: "win32", expected: "preflight-identity-invalid" },
    { name: "candidate equals the owned root", ownedRoot: fakeOwnedRoot(), candidatePid: OWNED_ROOT_PID, platform: "win32", expected: "preflight-identity-invalid" },
    { name: "non-positive candidate", ownedRoot: fakeOwnedRoot(), candidatePid: 0, platform: "win32", expected: "preflight-identity-invalid" },
    { name: "unsafe candidate", ownedRoot: fakeOwnedRoot(), candidatePid: Number.MAX_SAFE_INTEGER, platform: "win32", expected: "preflight-identity-invalid" },
  ];
  for (const testCase of cases) {
    const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
    const result = await verifyWindowsProcessLineage(testCase.ownedRoot, testCase.candidatePid, {
      platform: testCase.platform,
      execute: query.execute,
    });
    assert.equal(result.verified, false, `${testCase.name} must refuse`);
    assert.equal(result.verified === false && result.reason, testCase.expected, testCase.name);
    assert.equal(query.calls.length, 0, `${testCase.name} must not start a query child`);
  }

  // An already-exited owned root is refused before any query.
  const exitedRoot = fakeOwnedRoot();
  markRootExited(exitedRoot);
  const exitedQuery = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  const exited = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(exitedQuery, exitedRoot));
  assert.deepEqual(exited, { verified: false, reason: "preflight-owned-root-exited" });
  assert.equal(exitedQuery.calls.length, 0, "a dead owned root is never queried");

  // A missing or non-absolute SystemRoot is refused before any query.
  for (const value of [undefined, "not-absolute"]) {
    const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
    const result = await withSystemRoot(value, () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: "preflight-host-root-invalid" }, `SystemRoot ${String(value)}`);
    assert.equal(query.calls.length, 0, "an unvalidated host root is never queried");
  }
});

test("the owned deadline callback is the only source of timeout evidence", async (t) => {
  // A query that only the verifier's own deadline can end.
  const query = fakeDeferredQuery();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    t.mock.timers.tick(4_999);
    assert.equal(query.killCount(), 0, "the query is not killed before its full 5s bound");
    t.mock.timers.tick(1);
    // Authentic evidence that only lands after the owned deadline still refuses.
    query.settle(null, VALID_EVIDENCE);
    const result = await pending;
    assert.deepEqual(result, { verified: false, reason: "query-timeout" },
      "the fired owned timer callback is the positive timeout evidence, and a later result cannot be accepted");
    assert.equal(query.killCount(), 1, "the deadline callback still kills the one bounded child");
    assert.equal(query.calls.length, 1, "the timed-out query is never re-issued");
  } finally {
    t.mock.timers.reset();
  }

  // A normal completion clears the owned deadline instead of leaking it.
  const query2 = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const accepted = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query2));
    assert.deepEqual(accepted, { verified: true });
    // A cleared deadline cannot fire later: nothing kills a settled query.
    t.mock.timers.tick(60_000);
    assert.equal(query2.killCount(), 0, "the armed deadline is cleared once the query settles");
  } finally {
    t.mock.timers.reset();
  }
});

test("the owned deadline signals the one child, but only the query callback settles it", async (t) => {
  const query = fakeControllableQuery();
  let settled = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withSystemRoot("/fake-windows", () =>
      verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: query.execute }));
    void pending.then(() => { settled = true; });

    t.mock.timers.tick(4_999);
    await flushAsync();
    assert.equal(query.calls.length, 1, "exactly one bounded query child is started");
    assert.equal(query.killCount(), 0, "the child is not signalled before its full 5s bound");
    assert.equal(settled, false, "an unfinished query never settles the verification");

    t.mock.timers.tick(1);
    await flushAsync();
    assert.equal(query.killCount(), 1, "the owned deadline callback signals exactly the one bounded child");
    assert.equal(settled, false,
      "signalling is not settlement: the verification stays pending until the query's own completion callback runs");

    // Authentic evidence that only lands after the deadline can never be accepted.
    query.report(null, VALID_EVIDENCE);
    const result = await pending;
    assert.deepEqual(result, { verified: false, reason: "query-timeout" },
      "the positively witnessed timeout is final even when the callback arrives with no error");
    assert.equal(query.killCount(), 1, "the timed-out child is signalled once, never repeatedly");
    assert.equal(query.calls.length, 1, "a timed-out query is never re-issued");
  } finally {
    t.mock.timers.reset();
  }

  // A query that completes on its own clears the armed deadline instead of leaking it.
  const completed = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.deepEqual(await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(completed)), { verified: true });
    t.mock.timers.tick(60_000);
    assert.equal(completed.killCount(), 0, "the owned deadline is cleared once the query callback settles the query");
  } finally {
    t.mock.timers.reset();
  }
});

test("a deadline kill that throws cannot crash the session and never fakes settlement", async (t) => {
  const query = fakeControllableQuery({ killThrows: true });
  let settled = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withSystemRoot("/fake-windows", () =>
      verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: query.execute }));
    void pending.then(() => { settled = true; });

    t.mock.timers.tick(4_999);
    assert.doesNotThrow(() => t.mock.timers.tick(1),
      "a child that refuses to be signalled cannot turn the owned deadline callback into an uncaught exception");
    await flushAsync();
    assert.equal(settled, false, "a failed signal is not settlement and is never reported as a completed query");

    query.report(null, VALID_EVIDENCE);
    const result = await pending;
    assert.deepEqual(result, { verified: false, reason: "query-timeout" },
      "the witnessed deadline still refuses, and the state stays the truthful unconfirmed timeout");
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic"),
      `the thrown signal leaks nothing: ${reported}`);
  } finally {
    t.mock.timers.reset();
  }
});

test("a kill from any other source is never reported as a timeout", async () => {
  // The exact shape of Node's own kill error, without this module's timer firing.
  const killedError = Object.assign(new Error("child process terminated"), { killed: true, signal: "SIGTERM" });
  const query = fakeQuery({ kind: "error", error: killedError });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
  assert.deepEqual(result, { verified: false, reason: "query-failed" },
    "killed/signal/elapsed are never consulted, so an outside kill is not a timeout");
});

test("output-cap refusals come from the witnessed bound or the child's maxBuffer error", async () => {
  const maxBufferError = Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
  const byCode = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(fakeQuery({ kind: "error", error: maxBufferError })));
  assert.deepEqual(byCode, { verified: false, reason: "query-output-cap" });

  const oversized = "y".repeat(MAX_QUERY_OUTPUT_BYTES + 904);
  const byStdoutWitness = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({
      kind: "chunked",
      stdoutChunks: ["x".repeat(2048), "y".repeat(2048), "z".repeat(904)],
      stderrChunks: [],
      error: new Error("child process terminated"),
    }),
  ));
  assert.deepEqual(byStdoutWitness, { verified: false, reason: "query-output-cap" },
    "the verifier's own stdout accounting positively witnesses the 4KiB bound being crossed");

  const byStderrWitness = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({
      kind: "chunked",
      stdoutChunks: [],
      stderrChunks: [oversized],
      error: new Error("child process terminated"),
    }),
  ));
  assert.deepEqual(byStderrWitness, { verified: false, reason: "query-output-cap" },
    "the child's bound applies to each stream, so an oversized stderr alone is a witnessed cap");

  // Split-stream regression: two streams that are EACH within the bound are not
  // an output cap. Their combined size must never override the real cause.
  const splitStreams = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({
      kind: "chunked",
      stdoutChunks: ["x".repeat(3000)],
      stderrChunks: ["y".repeat(3000)],
      error: Object.assign(new Error(`Command failed: ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`), { code: 1 }),
    }),
  ));
  assert.deepEqual(splitStreams, { verified: false, reason: "query-nonzero-exit" },
    "two below-bound streams (6000 bytes combined) never claim an output cap the child never hit");

  // Below the bound, the same accounting must not invent a cap refusal.
  const small = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(
    fakeQuery({ kind: "chunked", stdoutChunks: ["x".repeat(512)], stderrChunks: ["y".repeat(512)], error: new Error("child process terminated") }),
  ));
  assert.deepEqual(small, { verified: false, reason: "query-failed" });

  assert.equal(classifyWindowsLineageQueryFailure(new Error("boom"), { timedOut: false, stdoutBytes: MAX_QUERY_OUTPUT_BYTES, stderrBytes: MAX_QUERY_OUTPUT_BYTES }), "query-failed",
    "exactly at the bound on both streams is not over it");
  assert.equal(classifyWindowsLineageQueryFailure(new Error("boom"), { timedOut: false, stdoutBytes: MAX_QUERY_OUTPUT_BYTES + 1, stderrBytes: 0 }), "query-output-cap");
  assert.equal(classifyWindowsLineageQueryFailure(new Error("boom"), { timedOut: false, stdoutBytes: 0, stderrBytes: MAX_QUERY_OUTPUT_BYTES + 1 }), "query-output-cap");
  assert.equal(classifyWindowsLineageQueryFailure({ code: 1 }, { timedOut: false, stdoutBytes: 3000, stderrBytes: 3000 }), "query-nonzero-exit",
    "the classifier never combines streams into a cap");
  assert.equal(classifyWindowsLineageQueryFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, { timedOut: true, stdoutBytes: 0, stderrBytes: 0 }), "query-timeout",
    "a witnessed timeout outranks a concurrent kill cause");
});

test("query spawn, nonzero-exit, and unclassified failures are distinct fixed stages", async () => {
  const spawnError = Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} ENOENT ${FAKE_SECRET}`), { code: "ENOENT" });
  const nonzeroError = Object.assign(new Error(`Command failed: ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`), { code: 1 });
  const opaqueError = new Error(`powershell.exe exited oddly ${FAKE_PRIVATE_PATH} ${FAKE_SECRET}`);
  const cases: Array<[unknown, string]> = [
    [spawnError, "query-spawn-failed"],
    [nonzeroError, "query-nonzero-exit"],
    [opaqueError, "query-failed"],
  ];
  for (const [error, expected] of cases) {
    const query = fakeQuery({ kind: "error", error });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: expected });
    assert.equal(query.calls.length, 1, "a failed query is never retried");
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic"),
      `the ${expected} stage carries no error text or host path: ${reported}`);
  }
});

test("an unknown string error code is never attributed to a spawn failure", async () => {
  // Only a known OS spawn errno can claim the child never started. Node-internal
  // `ERR_*` codes, host- or library-supplied codes, and near-miss spellings say
  // nothing about whether the child started, so they stay unclassified.
  const unsupportedCodes = [
    "ERR_INVALID_ARG_TYPE",
    "ERR_CHILD_PROCESS_IPC_REQUIRED",
    "ERR_UNKNOWN_SYSCALL_CODE",
    "ENOENTISH",
    "ENOENT-ish",
    "not-a-code",
    "",
  ];
  for (const code of unsupportedCodes) {
    const error = Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} ${code} ${FAKE_SECRET}`), { code });
    assert.equal(classifyWindowsLineageQueryFailure(error, { timedOut: false, stdoutBytes: 0, stderrBytes: 0 }), "query-failed",
      `${JSON.stringify(code)} is not a known spawn errno, so no spawn cause may be claimed`);

    const query = fakeQuery({ kind: "error", error });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: "query-failed" }, JSON.stringify(code));
    assert.equal(query.calls.length, 1, "an unclassified query failure is never retried");
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic") && !reported.includes("ERR_"),
      `the ${JSON.stringify(code)} stage carries no raw code, error text, or host path: ${reported}`);
  }

  // The known spawn errnos keep their existing attribution.
  for (const code of ["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ENOEXEC"]) {
    assert.equal(classifyWindowsLineageQueryFailure(Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} failed`), { code }),
      { timedOut: false, stdoutBytes: 0, stderrBytes: 0 }), "query-spawn-failed", code);
  }
  // A witnessed timeout and a real maxBuffer error still outrank any code.
  assert.equal(classifyWindowsLineageQueryFailure({ code: "ERR_CHILD_PROCESS_IPC_REQUIRED" }, { timedOut: true, stdoutBytes: 0, stderrBytes: 0 }), "query-timeout");
  assert.equal(classifyWindowsLineageQueryFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, { timedOut: false, stdoutBytes: 0, stderrBytes: 0 }), "query-output-cap");
});

test("every native sentinel stage is reported verbatim and an unknown sentinel fails closed", async () => {
  for (const stage of WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS) {
    const query = fakeQuery({ kind: "output", output: `PI_REVIEW_GATE_LINEAGE_NO:${stage}\n` });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: stage }, `native sentinel ${stage}`);
    assert.equal(isVerifiedWindowsAncestryEvidence(`PI_REVIEW_GATE_LINEAGE_NO:${stage}`, CANDIDATE_PID, OWNED_ROOT_PID), false);
  }
  for (const output of [
    "PI_REVIEW_GATE_LINEAGE_NO",
    "PI_REVIEW_GATE_LINEAGE_NO:not-a-stage",
    `PI_REVIEW_GATE_LINEAGE_NO:${FAKE_PRIVATE_PATH}`,
  ]) {
    const query = fakeQuery({ kind: "output", output });
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.deepEqual(result, { verified: false, reason: "sentinel-unrecognized" }, output);
    assert.ok(!JSON.stringify(result).includes("vic"), "an unrecognizable sentinel reports no payload");
  }
});

test("the evidence validator refuses each malformed or unrelated shape with its fixed stage", () => {
  const cases: Array<{ name: string; output: string; candidate: number; root: number; expected: string }> = [
    { name: "empty output", output: "", candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-bound-violation" },
    {
      name: "single row",
      output: evidenceRows([{ pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 300 }]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-bound-violation",
    },
    {
      name: "beyond 64 parent steps",
      output: evidenceRows([
        { pid: 90000, parentPid: 90001, creationTicks: 5000 },
        ...Array.from({ length: 64 }, (_, index) => ({
          pid: 90001 + index,
          parentPid: index === 63 ? OWNED_ROOT_PID : 90002 + index,
          creationTicks: 4999 - index,
        })),
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 900 },
      ]),
      candidate: 90000, root: OWNED_ROOT_PID, expected: "evidence-bound-violation",
    },
    {
      name: "extra evidence field",
      output: `67890,54321,${"0".repeat(18)}1,${"0".repeat(18)}1,extra;4321,4,${"0".repeat(18)}1,${"0".repeat(18)}1`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "short creation ticks",
      output: `67890,4321,123,123;4321,4,456,456`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "ticks beyond DateTime.MaxValue",
      output: `67890,4321,3155378976000000000,3155378976000000000;4321,4,1,1`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "non-numeric pid token",
      output: `67a90,4321,${"0".repeat(18)}1,${"0".repeat(18)}1;4321,4,${"0".repeat(18)}1,${"0".repeat(18)}1`,
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-shape-invalid",
    },
    {
      name: "unstable creation snapshot",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 100, observedTicks: 101 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-snapshot-unstable",
    },
    { name: "candidate is not the chain head", output: VALID_EVIDENCE, candidate: 54321, root: OWNED_ROOT_PID, expected: "evidence-candidate-mismatch" },
    { name: "chain ends at another root", output: VALID_EVIDENCE, candidate: CANDIDATE_PID, root: 10000, expected: "evidence-owned-root-mismatch" },
    { name: "candidate equals the owned root", output: VALID_EVIDENCE, candidate: OWNED_ROOT_PID, root: OWNED_ROOT_PID, expected: "evidence-identity-invalid" },
    { name: "candidate pid zero", output: VALID_EVIDENCE, candidate: 0, root: OWNED_ROOT_PID, expected: "evidence-identity-invalid" },
    {
      name: "duplicated pid (cycle)",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 300 },
        { pid: OWNED_ROOT_PID, parentPid: OWNED_ROOT_PID, creationTicks: 200 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-duplicate-pid",
    },
    {
      name: "broken parent link",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: 54321, creationTicks: 300 },
        { pid: 999, parentPid: OWNED_ROOT_PID, creationTicks: 200 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 50 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-chain-broken",
    },
    {
      name: "recycled parent created after its child",
      output: evidenceRows([
        { pid: CANDIDATE_PID, parentPid: OWNED_ROOT_PID, creationTicks: 100 },
        { pid: OWNED_ROOT_PID, parentPid: 4, creationTicks: 200 },
      ]),
      candidate: CANDIDATE_PID, root: OWNED_ROOT_PID, expected: "evidence-creation-order-invalid",
    },
  ];
  for (const testCase of cases) {
    const result = classifyWindowsAncestryEvidence(testCase.output, testCase.candidate, testCase.root);
    assert.equal(result.verified, false, `${testCase.name} must refuse`);
    assert.equal(result.verified === false && result.reason, testCase.expected, testCase.name);
    assert.equal(isVerifiedWindowsAncestryEvidence(testCase.output, testCase.candidate, testCase.root), false,
      `${testCase.name} must not be accepted by the boolean view either`);
    assert.ok(result.verified === false && isWindowsLineageRefusalReason(result.reason), `${testCase.name} reports a fixed stage`);
  }
  assert.deepEqual(classifyWindowsAncestryEvidence(VALID_EVIDENCE, CANDIDATE_PID, OWNED_ROOT_PID), { verified: true });
});

test("the owned root exiting during the query refuses at the final liveness check", async () => {
  const ownedRoot = fakeOwnedRoot();
  const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE }, { beforeSettle: () => markRootExited(ownedRoot) });
  const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query, ownedRoot));
  assert.deepEqual(result, { verified: false, reason: "owned-root-exited-after-query" },
    "authentic evidence cannot bind a PID to an owned root that already exited");
  assert.equal(query.calls.length, 1, "the race is observed, never re-queried");
});

test("every refusal stage is a fixed code and carries no output, path, PID, or error text", async () => {
  const leakingError = Object.assign(new Error(`powershell at ${FAKE_PRIVATE_PATH} failed with ${FAKE_SECRET}`), { code: 3 });
  const leakyOutput = `${FAKE_PRIVATE_PATH};pid=999;secret=${FAKE_SECRET}`;
  const behaviors: FakeQueryBehavior[] = [
    { kind: "error", error: leakingError },
    { kind: "output", output: leakyOutput },
    { kind: "output", output: "PI_REVIEW_GATE_LINEAGE_NO" },
    { kind: "chunked", stdoutChunks: ["x".repeat(9000)], stderrChunks: [], error: leakingError },
    { kind: "chunked", stdoutChunks: ["x".repeat(3000)], stderrChunks: ["y".repeat(3000)], error: leakingError },
  ];
  for (const behavior of behaviors) {
    const query = fakeQuery(behavior);
    const result = await withSystemRoot("/fake-windows", () => verifyWithMockedQuery(query));
    assert.equal(result.verified, false, JSON.stringify(result));
    assert.ok(result.verified === false && isWindowsLineageRefusalReason(result.reason), behavior.kind);
    const reported = JSON.stringify(result);
    assert.ok(!reported.includes(FAKE_SECRET) && !reported.includes("vic") && !reported.includes("999"),
      `${behavior.kind} leaked a sanitized value: ${reported}`);
  }
  // The stage list itself is closed: only these literals can ever be reported.
  for (const stage of WINDOWS_LINEAGE_REFUSAL_REASONS) {
    assert.equal(isWindowsLineageRefusalReason(stage), true, stage);
  }
  for (const notAStage of ["", "unknown", "verifier-error", FAKE_SECRET, FAKE_PRIVATE_PATH, 42, null]) {
    assert.equal(isWindowsLineageRefusalReason(notAStage), false, String(notAStage));
  }
});

// ---------------------------------------------------------------------------
// The refusal the settlement receipt actually reports
// ---------------------------------------------------------------------------

test("typed lineage acceptance binds the verified PID on the unchanged success path", async () => {
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "typed-lineage-session");
    const seen: number[] = [];
    parent.verifySpawnedPid = async (pid) => {
      seen.push(pid);
      return { verified: isVerifiedWindowsAncestryEvidence(VALID_EVIDENCE, pid, OWNED_ROOT_PID) };
    };
    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.deepEqual(seen, [CANDIDATE_PID]);
    assert.equal(parent.pid, CANDIDATE_PID, "the verified actual Pi PID is bound after lineage proof");
  });
});

test("a typed lineage refusal appends only the fixed stage to the recognizable wording", async () => {
  for (const stage of ["chain-cycle", "query-timeout", "query-output-cap", "snapshot-creation-mismatch", "owned-root-exited-after-query"]) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, `refusal-${stage}`);
      parent.verifySpawnedPid = async () => ({ verified: false, reason: stage });
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      const message = await refusalMessage(parent);
      assert.ok(message.startsWith(BASE_REFUSAL), `base refusal wording stays recognizable: ${message}`);
      assert.equal(message, `${BASE_REFUSAL} [lineage stage: ${stage}]`);
      assert.equal(parent.pid, undefined, `${stage} must not bind a PID`);
    });
  }
});

test("legacy boolean lineage callers keep the exact original refusal wording", async () => {
  for (const verify of [() => false as boolean, async () => false as boolean]) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, "boolean-lineage");
      parent.verifySpawnedPid = verify;
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      assert.equal(await refusalMessage(parent), BASE_REFUSAL, "boolean callers report no stage");
      assert.equal(parent.pid, undefined);
    });
  }
});

test("a truthy lineage result is never acceptance", async () => {
  const refused: unknown[] = ["true", 1, {}, [], { verified: "true" }, { verified: 1 }, { verified: false }, new Date(0)];
  for (const value of refused) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, "truthy-lineage");
      parent.verifySpawnedPid = () => value as { verified: boolean };
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      const message = await refusalMessage(parent);
      assert.equal(message, `${BASE_REFUSAL} [lineage stage: unknown]`, JSON.stringify(String(value)));
      assert.equal(parent.pid, undefined, `${String(value)} must never bind a PID`);
    });
  }
  // Only strict `verified === true` accepts, even when a stage rides along.
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "strict-truthy-lineage");
    parent.verifySpawnedPid = async () => ({ verified: true, reason: "chain-cycle" });
    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.equal(parent.pid, CANDIDATE_PID);
  });
});

test("a malformed or private stage value is replaced by the fixed unknown stage", async () => {
  for (const reason of [`${FAKE_PRIVATE_PATH}\\${FAKE_SECRET}`, FAKE_SECRET, 42, { nested: FAKE_SECRET }, null, undefined, ""]) {
    await withReceiptRoot(async (root) => {
      const parent = createPiSettlementBootstrap(root, "malformed-stage");
      parent.verifySpawnedPid = async () => ({ verified: false, reason });
      await writeSignedReceipt(parent, CANDIDATE_PID, 1);
      const message = await refusalMessage(parent);
      assert.equal(message, `${BASE_REFUSAL} [lineage stage: unknown]`);
      assert.ok(!message.includes(FAKE_SECRET) && !message.includes("vic"), message);
      assert.equal(parent.pid, undefined);
    });
  }
});

test("a thrown lineage verifier reports the fixed verifier-error stage without the thrown value", async () => {
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "throwing-lineage");
    parent.verifySpawnedPid = () => {
      throw new Error(`lineage query could not run ${FAKE_PRIVATE_PATH} token=${FAKE_SECRET}`);
    };
    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    const message = await refusalMessage(parent);
    assert.equal(message, `${BASE_REFUSAL} [lineage stage: verifier-error]`);
    assert.ok(!message.includes(FAKE_SECRET) && !message.includes("vic"), message);
    assert.equal(parent.pid, undefined, "a verifier exception never binds a PID");
  });
});

test("the receipt signature is authenticated before the lineage verifier runs", async () => {
  await withReceiptRoot(async (root) => {
    const parent = createPiSettlementBootstrap(root, "hmac-first");
    let calls = 0;
    parent.verifySpawnedPid = () => {
      calls += 1;
      return { verified: true };
    };
    await writeSignedReceipt(parent, CANDIDATE_PID, 1, true);
    await assert.rejects(awaitPiSettlementReceipt(parent, 0, 100), /signature is invalid/);
    assert.equal(calls, 0, "an unauthenticated PID never reaches the lineage verifier");
    assert.equal(parent.pid, undefined, "a bad HMAC never binds a PID and never reports a lineage stage");

    await writeSignedReceipt(parent, CANDIDATE_PID, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.equal(calls, 1);
    assert.equal(parent.pid, CANDIDATE_PID);

    await writeSignedReceipt(parent, CANDIDATE_PID + 1, 2);
    await assert.rejects(awaitPiSettlementReceipt(parent, 1, 100), /does not match/);
    assert.equal(calls, 1, "later receipt PIDs use the bound identity, not another lineage proof");
    assert.equal(parent.pid, CANDIDATE_PID);
  });
});

// ---------------------------------------------------------------------------
// Test-only native query phase diagnostics (Refs #446)
// ---------------------------------------------------------------------------

/**
 * Diagnosis for the one required Windows run that reported `query-timeout` for a
 * genuine descendant: the probe below observes that same single bounded query
 * child from outside the production module so a future native run can say WHERE
 * the five seconds went. These cross-platform cases pin the wrapper's own bounds,
 * privacy, and non-interference; the win32-only cases below exercise it natively.
 * Phase timestamps are when THIS process noticed an event, so they locate a delay
 * boundary and never by themselves establish a root cause.
 */

/** Exactly one inserted marker line matches; no production line may. */
const PHASE_MARKER_LINE = /^\s*(?:if \(\$step -lt \d+\) \{ )?\[Console\]::Error\.WriteLine\('PRG-LINEAGE-PHASE:[a-z][a-z0-9-]*'\)(?: \})?$/;

/** The script-side phases the diagnostics must be able to bracket. */
const INSTRUMENTED_PHASES = [
  "script-entry", "initial-query-start", "initial-query-end", "walk-start",
  "ancestor-lookup", "snapshot-start", "snapshot-end", "evidence-written", "walk-depth-limit",
] as const;

/** Occurrences of a fixed substring — used to prove nothing is duplicated or added. */
function occurrences(haystack: string, needle: string): number {
  return allIndexes(haystack, needle).length;
}

test("the diagnostic script wrapper adds stderr-only markers and changes no production decision", async () => {
  const { script } = await captureLineageScript();
  const outcome = instrumentWindowsLineageScript(script);
  assert.ok(outcome.instrumented, "the production script still carries every fixed marker anchor");
  if (!outcome.instrumented) return;

  const original = script.split("\n");
  const instrumented = outcome.script.split("\n");
  assert.ok(outcome.markers >= INSTRUMENTED_PHASES.length && outcome.markers <= 12,
    `the marker count stays bounded, got ${outcome.markers}`);
  assert.equal(instrumented.length, original.length + outcome.markers,
    "markers are whole added lines, never edits to a production line");
  const added = instrumented.filter((line) => PHASE_MARKER_LINE.test(line));
  assert.equal(added.length, outcome.markers, "every added line is one fixed marker line");
  assert.deepEqual(instrumented.filter((line) => !PHASE_MARKER_LINE.test(line)), original,
    "removing the marker lines yields the production script line for line, in order");
  assert.ok(added.every((line) => line.includes("[Console]::Error.WriteLine(")), "markers are written to stderr only");
  assert.equal(occurrences(outcome.script, "[Console]::Out"), occurrences(script, "[Console]::Out"),
    "the stdout proof bytes are still written from exactly the same places");
  assert.equal(occurrences(outcome.script, "Get-CimInstance"), 3, "the three bounded CIM requests are unchanged");
  assert.equal(initialLookupFilter(outcome.script), initialLookupFilter(script), "the initial filter is unchanged");
  assert.ok(outcome.script.includes("for ($step = 0; $step -lt 64; $step++)"), "the 64-hop walk bound is unchanged");
  for (const phase of INSTRUMENTED_PHASES) {
    assert.ok(outcome.script.includes(`PRG-LINEAGE-PHASE:${phase}`), `${phase} stays observable`);
  }
  const ancestor = added.filter((line) => line.includes("ancestor-lookup"));
  assert.equal(ancestor.length, 1, "the per-hop marker is one line, never one line per hop");
  assert.ok(ancestor[0]?.includes("if ($step -lt 2)"),
    "the per-hop marker is step-guarded, so stderr stays bounded for any chain length");
});

test("diagnostic script instrumentation fails closed to the untouched script", async () => {
  const foreign = "$ErrorActionPreference = 'Stop'\nWrite-Output 'not the lineage script'\n";
  assert.deepEqual(instrumentWindowsLineageScript(foreign), { instrumented: false, script: foreign, reason: "anchors-missing" },
    "an unrecognized script is handed to the query completely untouched");

  const { script } = await captureLineageScript();
  const initialLine = script.split("\n").find((line) => line.startsWith("$initial = @(Get-CimInstance"))!;
  const ambiguous = script.replace(`${initialLine}\n`, () => `${initialLine}\n${initialLine}\n`);
  assert.deepEqual(instrumentWindowsLineageScript(ambiguous), { instrumented: false, script: ambiguous, reason: "anchors-missing" },
    "an ambiguous anchor is refused rather than guessed at");
});

test("only allowlisted phase names are markers and no other stderr text is ever interpretable", () => {
  for (const phase of WINDOWS_LINEAGE_PHASES) {
    assert.equal(parseWindowsLineagePhaseMarker(`PRG-LINEAGE-PHASE:${phase}\r`), phase);
  }
  for (const line of [
    "", "\r", "PRG-LINEAGE-PHASE", "PRG-LINEAGE-PHASE:", "PRG-LINEAGE-PHASE:Not-A-Phase",
    `PRG-LINEAGE-PHASE:${FAKE_PRIVATE_PATH}`, "PRG-LINEAGE-PHASE:chain-cycle;extra",
    "  PRG-LINEAGE-PHASE:script-entry", `Get-CimInstance PRG-LINEAGE-PHASE:snapshot-end`,
    "PRG-LINEAGE-PHASE:query-timeout", `PRG-LINEAGE-PHASE:${FAKE_SECRET}`,
  ]) {
    assert.equal(parseWindowsLineagePhaseMarker(line), undefined, `${JSON.stringify(line)} is not a phase`);
  }
});

test("the phase probe observes one native query without changing its proof or leaking anything", async () => {
  const { script } = await captureLineageScript();
  const seen: Array<{ file: string; args: string[]; options: WindowsLineageQueryOptions }> = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  Object.assign(child, { kill: () => true, stdout, stderr });
  let callback: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const probe = createWindowsLineagePhaseProbe((file, args, options, cb) => {
    seen.push({ file, args, options });
    callback = cb;
    return child as unknown as WindowsLineageQueryChild;
  });

  const armed = withSystemRoot("/fake-windows", () =>
    verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: probe.execute }));
  await flushAsync();

  assert.equal(seen.length, 1, "the probe never adds a query child or a retry");
  assert.equal(seen[0].file, join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "the probe delegates to the production executable");
  assert.equal(seen[0].args.length, 5, "only the script argument may be substituted");
  assert.deepEqual(seen[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    "the production argument vector is passed through unchanged");
  assert.deepEqual(queryOptionsShape(seen[0].options), PRODUCTION_OPTIONS_SHAPE,
    "the 4KiB per-stream bound, encoding, hidden window, and production environment copy are passed through untouched");
  assert.ok(!("timeout" in seen[0].options), "the probe never takes over the owned 5s deadline");
  assert.ok(seen[0].args[4].includes("PRG-LINEAGE-PHASE:snapshot-start"), "the script argument is the instrumented copy");

  // The delegate has already returned its child object, and that alone is not spawn
  // evidence: until the child emits its own `spawn` event, an ENOENT or other
  // asynchronous spawn failure looks identical from here. The result token below is
  // only a render input while the query is still in flight; the ledger is the point.
  const inFlight = probe.timeline("positive-proof", { verified: false, reason: "query-failed" });
  assert.equal(inFlight.calls, 1, "the one query child started and has not settled");
  assert.equal(inFlight.callbacks, 0, "no completion callback has been witnessed yet");
  assert.ok(!inFlight.phases.some((phase) => phase.phase === "child-spawn"),
    "a returned child object is never recorded as a spawn");
  child.emit("spawn");

  stderr.emit("data", "PRG-LINEAGE-PHASE:script-entry\r\nPRG-LINEAGE-PHASE:initial-query-start\r\n");
  stderr.emit("data", `Get-CimInstance failed at ${FAKE_PRIVATE_PATH} token=${FAKE_SECRET} pid=987654321\r\n`);
  stderr.emit("data", "PRG-LINEAGE-PHASE:initial-query-end\r\nPRG-LINEAGE-PHASE:ancestor-lookup\r\n"
    + "PRG-LINEAGE-PHASE:ancestor-lookup\r\nPRG-LINEAGE-PHASE:ancestor-lookup\r\n");
  stdout.emit("data", VALID_EVIDENCE);
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  callback?.(null, VALID_EVIDENCE, "");
  const result = await armed;
  assert.deepEqual(result, { verified: true }, "forwarding the callback verbatim keeps the real acceptance decision intact");

  const line = probe.diagnostic("positive-proof", result);
  assert.ok(line.length <= WINDOWS_LINEAGE_DIAGNOSTIC_MAX_CHARS, `the diagnostic stays bounded: ${line.length}`);
  assert.ok(!line.includes(FAKE_SECRET) && !line.includes("vic") && !line.includes("987654321")
    && !line.includes("C:\\") && !line.includes("Get-CimInstance") && !line.includes("PRG-LINEAGE-PHASE"),
  `the diagnostic carries no stderr text, path, PID, script, or marker prefix: ${line}`);
  assert.match(line, /result=verified delegation=production instrument=ok calls=1 callbacks=1/);
  assert.match(line, /unrecognized=1 scanTruncated=false/);
  assert.match(line, /ancestor-lookup@\d+x3/, "repeated observations aggregate into the one canonical record");
  assert.equal(occurrences(line, "ancestor-lookup"), 1, "one phase is never printed twice");
  assert.equal(occurrences(line, "child-spawn"), 1,
    "the one `spawn` notification is recorded once, and only because it was emitted");
  const order = ["child-spawn", "script-entry", "initial-query-start", "initial-query-end",
    "ancestor-lookup", "stdout-first", "stderr-first", "child-exit", "child-close", "query-callback"];
  const positions = order.map((phase) => line.indexOf(phase));
  assert.ok(positions.every((at) => at >= 0), `every observed phase is reported: ${line}`);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right),
    "phases print in the canonical fixed order, not in arrival order");
  const canonical = probe.timeline("positive-proof", result);
  assert.equal(new Set(canonical.phases.map((record) => record.phase)).size, canonical.phases.length,
    "the canonical record keeps one entry per phase, never a second event or status ledger");

  // The status token is honest: a query that is not production's own shape is
  // reported as changed instead of being presented as native proof evidence.
  const altered = createWindowsLineagePhaseProbe(() => child as unknown as WindowsLineageQueryChild);
  altered.execute(join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: MAX_QUERY_OUTPUT_BYTES, windowsHide: true, timeout: 5_000 } as unknown as WindowsLineageQueryOptions,
    () => undefined);
  assert.match(altered.diagnostic("negative-proof", { verified: false, reason: "query-timeout" }),
    /delegation=changed instrument=ok calls=1 callbacks=0/);
});

test("a query child that never notifies spawn leaves no spawn evidence behind", () => {
  // The real shape of an asynchronous spawn failure: the executor returns a child
  // object, the child never emits `spawn`, and the completion callback settles with a
  // spawn errno. The diagnosis may report the callback it really witnessed, never a
  // process creation it did not witness.
  const child = new EventEmitter();
  Object.assign(child, { kill: () => true, stdout: new EventEmitter(), stderr: new EventEmitter() });
  let settle: ((error: ExecFileException | null, stdout: string, stderr: string) => void) | undefined;
  const probe = createWindowsLineagePhaseProbe((_file, _args, _options, callback) => {
    settle = callback;
    return child as unknown as WindowsLineageQueryChild;
  });
  probe.execute(join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output 'proof'"],
    { encoding: "utf8", maxBuffer: MAX_QUERY_OUTPUT_BYTES, windowsHide: true, env: windowsLineageQueryEnvironment(process.env) },
    () => undefined);

  const started = probe.diagnostic("spawn-failure", { verified: false, reason: "query-spawn-failed" });
  assert.match(started, /calls=1 callbacks=0/, "the delegate returned its child, and nothing settled");
  assert.ok(!started.includes("child-spawn"), `no spawn event means no spawn phase: ${started}`);

  settle?.(Object.assign(new Error(`spawn ${FAKE_PRIVATE_PATH} ENOENT`), { code: "ENOENT" }) as ExecFileException, "", "");
  const failed = probe.diagnostic("spawn-failure", { verified: false, reason: "query-spawn-failed" });
  assert.match(failed, /callbacks=1/, "the completion callback the wrapper actually witnessed is reported");
  assert.match(failed, /query-callback@\d+/);
  assert.ok(!failed.includes("child-spawn"), `a spawn failure never claims a spawn: ${failed}`);
  assert.ok(!failed.includes("child-exit") && !failed.includes("child-close"),
    `an unobserved lifecycle is not reported: ${failed}`);
});

test("the phase diagnostic cannot exceed its bound or report an unvalidated value", () => {
  const widest = formatWindowsLineagePhaseDiagnostic({
    label: `x${FAKE_SECRET}`.repeat(200),
    result: { verified: false, reason: "not-a-stage" } as unknown as WindowsLineageVerification,
    elapsedMs: 2 ** 31,
    calls: 2 ** 40,
    callbacks: -5,
    instrument: "ok",
    delegation: "production",
    unrecognizedMarkers: 2 ** 40,
    scanTruncated: true,
    phases: [
      ...WINDOWS_LINEAGE_PHASES.map((phase) => ({ phase, elapsedMs: 2 ** 31 - 1, count: 999 })),
      { phase: "child-spawn", elapsedMs: 1, count: 2 },
      { phase: "made-up-phase" as (typeof WINDOWS_LINEAGE_PHASES)[number], elapsedMs: 3, count: 1 },
    ],
  });
  assert.ok(widest.length <= WINDOWS_LINEAGE_DIAGNOSTIC_MAX_CHARS, `bounded by construction: ${widest}`);
  assert.ok(!widest.includes(FAKE_SECRET) && !widest.includes("xxxx"), `no caller text: ${widest}`);
  assert.ok(!widest.includes("made-up-phase"), "a phase outside the closed vocabulary is never printed");
  assert.equal(occurrences(widest, "child-spawn"), 1, "a duplicated phase collapses into the one canonical record");
  assert.match(widest, /label=\? result=unknown/);
  assert.match(widest, /calls=\? callbacks=\? unrecognized=\? scanTruncated=true elapsedMs=\?/);
  assert.match(widest, /child-spawn@2147483647x999/, "only bounded integers print");
});

// ---------------------------------------------------------------------------
// #446 causal experiment instrument (cross-platform; the win32 cases run it natively)
// ---------------------------------------------------------------------------

/**
 * Refs #446, first causal phase: one fixed two-arm experiment (inherited
 * environment vs. a child-only environment copy without `PSModulePath`) with
 * passive lookup hooks and a child clock. These cases pin the experiment's own
 * contract with mocked children: the treatment touches only the query child's
 * environment, the gate releases only after both positives are ready and fails
 * as INVALID otherwise, the instrument fails closed on missing/malformed hook
 * data, and nothing private reaches the bounded line. They prove nothing about
 * Windows PowerShell 5.1 itself; the win32 controls below validate the hooks on
 * the real host, and only the native case produces experimental evidence.
 */

const CAUSAL_FRAME_LINE = /^\s*\[Console\]::Error\.WriteLine\('PRG-L446:(?:initial-query-start|initial-query-end|snapshot-start|snapshot-end):' \+ \$global:PrgL446\.Clock\.ElapsedMilliseconds(?: \+ ':' \+ \$global:PrgL446\.Pre \+ '-' \+ \$global:PrgL446\.Post \+ '-' \+ \$global:PrgL446\.Depth)?\)$/;
const SYNTHETIC_MODULE_PATH = [
  "C:\\Users\\vic\\Documents\\PowerShell\\Modules",
  "C:\\Program Files\\PowerShell\\7\\Modules",
  "C:\\Program Files\\WindowsPowerShell\\Modules",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
].join(";");

interface FakeCausalChild {
  child: EventEmitter & WindowsLineageCausalChild;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdinEnds: Array<string | undefined>;
  file: string;
  args: string[];
  options: WindowsLineageCausalLaunchOptions;
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void;
}

/** Mocked query launches that record exactly what each probe handed to its launcher. */
function fakeCausalLauncher(): { launch: WindowsLineageCausalLauncher; children: FakeCausalChild[] } {
  const children: FakeCausalChild[] = [];
  const launch: WindowsLineageCausalLauncher = (file, args, options, callback) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdinEnds: Array<string | undefined> = [];
    const child = new EventEmitter() as EventEmitter & WindowsLineageCausalChild;
    Object.assign(child, {
      kill: () => true,
      stdout,
      stderr,
      stdin: { end: (chunk?: string) => { stdinEnds.push(chunk); }, on: () => undefined },
    });
    children.push({ child, stdout, stderr, stdinEnds, file, args, options, callback });
    return child;
  };
  return { launch, children };
}

/** A manual bound timer, so gate expiry is driven by the test, never by wall time. */
function manualSchedule(): {
  schedule: (callback: () => void, ms: number) => { cancel(): void };
  timers: Array<{ callback: () => void; ms: number; cancelled: boolean }>;
} {
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
  };
}

const frame = (name: string, ms: number, token?: string): string =>
  `PRG-L446:${name}:${ms}${token === undefined ? "" : `:${token}`}\r\n`;

/** The complete coherent frame sequence of one accepted query through the hooks. */
function acceptedFrames(ack: "ok" | "ungated", lookupClass = "native-cim"): string[] {
  return [
    frame("psmp", 1, "1010"), frame("hooks-installed", 2), frame("initial-query-start", 3),
    frame("lookup-ready", 4), frame("lookup-released", 9, ack), frame("lookup-complete", 40, lookupClass),
    frame("initial-query-end", 300, "1-1-0"), frame("snapshot-start", 301), frame("snapshot-end", 350),
  ];
}

const ARMS = WINDOWS_LINEAGE_CAUSAL_ARMS;

test("module-path observation reports closed categories and counts keys without copying any environment", () => {
  const parent: NodeJS.ProcessEnv = {
    PSModulePath: SYNTHETIC_MODULE_PATH, psmodulepath: "dup", PSMODULEPATH: "dup2",
    PATH: "C:\\bin", WinPSModulePath: "keep", PSModulePathX: "keep", SystemRoot: "C:\\Windows",
  };
  assert.equal(countModulePathKeys(parent), 3, "every case alias is counted");
  assert.equal(countModulePathKeys(windowsLineageQueryEnvironment(parent)), 0, "the production copy has none left");
  assert.equal(countModulePathKeys(undefined), 0);

  const native = nativeWindowsModulesDir("C:\\Windows");
  assert.equal(classifyModulePathCategories(SYNTHETIC_MODULE_PATH, native), "1111",
    "PowerShell 7 locations ahead of the native module location are reported as closed bits");
  assert.equal(classifyModulePathCategories(
    "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules\\", native), "1010",
  "WindowsPowerShell is not a PowerShell 7 segment, and the native match is case/trailing-separator insensitive");
  assert.equal(classifyModulePathCategories("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;D:\\Documents\\PowerShell\\Modules", native), "1110",
    "a PowerShell 7 location after the native one is present but not first");
  assert.equal(classifyModulePathCategories("D:\\x\\PowerShell\\7-preview\\Modules", native), "1101",
    "an absent native location with a PowerShell 7 location reports ps7-first");
  assert.equal(classifyModulePathCategories(
    "C:\\Program Files (x86)\\Microsoft SQL Server\\150\\Tools\\PowerShell\\Modules\\;D:\\x\\PowerShell\\Scripts;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", native), "1010",
  "another tool's PowerShell\\Modules folder is not a PowerShell 7 default location");
  assert.equal(classifyModulePathCategories(undefined, native), "0000");
  assert.equal(classifyModulePathCategories("", undefined), "0000");
  assert.equal(nativeWindowsModulesDir("relative\\root"), undefined, "a non-absolute SystemRoot has no native location");
});

test("the causal script adds only a passive prelude and clock frames around the unchanged production lines", async () => {
  const { script } = await captureLineageScript();
  const original = script.split("\n");
  for (const gate of ["matched", "ungated"] as const) {
    const outcome = instrumentWindowsLineageCausalScript(script, gate);
    assert.ok(outcome.instrumented, `${gate}: the production script still carries every causal anchor`);
    if (!outcome.instrumented) continue;
    const lines = outcome.script.split("\n");
    assert.deepEqual(lines.slice(0, outcome.prelude.length), [...outcome.prelude], `${gate}: the prelude is a whole-line prefix`);
    const rest = lines.slice(outcome.prelude.length);
    assert.equal(rest.filter((line) => CAUSAL_FRAME_LINE.test(line)).length, 4, `${gate}: exactly four clock frames are added`);
    assert.deepEqual(rest.filter((line) => !CAUSAL_FRAME_LINE.test(line)), original,
      `${gate}: removing the prelude and frame lines yields the production script line for line`);
    assert.equal(outcome.addedLines, outcome.prelude.length + 4);
    assert.ok(outcome.addedLines <= WINDOWS_LINEAGE_CAUSAL_MAX_ADDED_LINES, `${gate}: added lines stay bounded`);
    assert.ok(outcome.script.length < 16_000, `${gate}: the command line stays far below the Windows limit`);
    assert.equal(occurrences(outcome.script, "[Console]::Out"), occurrences(script, "[Console]::Out"),
      `${gate}: stdout proof bytes are written from exactly the same places`);
    assert.deepEqual(cmdletNames(outcome.script), cmdletNames(script), `${gate}: no command name is added to the script`);

    const prelude = outcome.prelude.join("\n");
    assert.deepEqual(cmdletNames(prelude), ["Get-CimInstance"], `${gate}: the only command name in the prelude is the observed literal`);
    assert.equal(occurrences(prelude, "Get-CimInstance"), occurrences(prelude, "'Get-CimInstance'"),
      `${gate}: the observed name appears only as a quoted literal, never as an invocation`);
    for (const forbidden of [
      "Import-Module", "Get-Command", "Add-Type", "Trace-Command", "Start-Sleep", "Set-StrictMode", "Invoke-",
      "Write-Output", "Write-Host", "StopSearch", "CommandScriptBlock", ".Command =", "[Console]::Out", "& {", "& $",
      "Get-CimInstance -", "CimSession", "Get-Module",
    ]) {
      assert.ok(!prelude.includes(forbidden), `${gate}: the passive prelude never contains ${JSON.stringify(forbidden)}`);
    }
    for (const line of outcome.prelude) {
      const text = line.trim();
      assert.ok(
        /^\$[A-Za-z][A-Za-z0-9:.]* = /.test(text)
          || /^(?:try \{|\}|\} catch \{|foreach \(|if \(|elseif \(|param\()/.test(text)
          || text.startsWith("[Console]::Error.WriteLine('PRG-L446:")
          || /^\$ExecutionContext\.InvokeCommand\.(?:Pre|Post)CommandLookupAction = \{$/.test(text),
        `${gate}: every prelude line is an assignment, control flow, or a fixed stderr frame: ${text}`);
    }
    // The console host only consumes redirected stdin as pipeline input when the
    // command uses `$input`; neither the production script nor the prelude does, so
    // the release token can only be read by the gate itself (validated natively).
    assert.ok(!/\$input\b/i.test(outcome.script), `${gate}: the script never uses $input`);
    assert.equal(occurrences(prelude, "[Console]::In.ReadLine()"), gate === "matched" ? 1 : 0,
      `${gate}: only the matched gate reads the one release token`);
    assert.ok(prelude.includes("if (($prgState.Depth -eq 0) -and $prgState.Outer -and (-not $prgState.Unpaired) -and (-not $prgState.Resolved)) {"),
      `${gate}: lookup-complete is emitted only when the first outer lookup's own post-lookup closes it`);
    assert.ok(prelude.indexOf("PRG-L446:lookup-nested-post:") > prelude.indexOf("PostCommandLookupAction = {"),
      `${gate}: a nested completion is recorded separately by the post-lookup hook`);
    assert.equal(occurrences(prelude, "PRG-L446:lookup-unpaired:"), 2, `${gate}: both hooks report a pairing failure`);
    assert.equal(occurrences(prelude, "PreCommandLookupAction = {"), 1);
    assert.equal(occurrences(prelude, "PostCommandLookupAction = {"), 1);
  }

  const foreign = "$ErrorActionPreference = 'Stop'\nWrite-Output 'not the lineage script'\n";
  assert.deepEqual(instrumentWindowsLineageCausalScript(foreign, "matched"),
    { instrumented: false, script: foreign, reason: "anchors-missing" }, "an unrecognized script is returned untouched");
  const initialLine = original.find((line) => line.startsWith("$initial = @(Get-CimInstance"))!;
  const ambiguous = script.replace(`${initialLine}\n`, () => `${initialLine}\n${initialLine}\n`);
  assert.deepEqual(instrumentWindowsLineageCausalScript(ambiguous, "ungated"),
    { instrumented: false, script: ambiguous, reason: "anchors-missing" }, "an ambiguous anchor is refused");
  const shifted = `# leading\n${script}`;
  assert.deepEqual(instrumentWindowsLineageCausalScript(shifted, "matched"),
    { instrumented: false, script: shifted, reason: "anchors-missing" }, "the prelude only ever precedes the fixed first line");
});

test("causal frames are a closed grammar that fits far inside the 4KiB stderr bound", () => {
  const longest: Record<string, string | undefined> = {
    psmp: "1111", "hooks-installed": undefined, "initial-query-start": undefined, "lookup-ready": undefined,
    "lookup-released": "ungated", "lookup-complete": "cim-elsewhere", "initial-query-end": "9-9-9",
    "snapshot-start": undefined, "snapshot-end": undefined, "prelude-error": "hooks", "hook-error": "post",
  };
  let total = 0;
  for (const name of WINDOWS_LINEAGE_CAUSAL_CHILD_FRAMES) {
    const line = frame(name, 9_999_999, longest[name]);
    assert.ok(Buffer.byteLength(line) <= WINDOWS_LINEAGE_CAUSAL_MAX_FRAME_BYTES, `${name} fits the frame bound`);
    assert.deepEqual(parseWindowsLineageCausalFrame(line.trimEnd()), {
      frame: name, childMs: 9_999_999, ...(longest[name] === undefined ? {} : { token: longest[name] }),
    });
    total += Buffer.byteLength(line);
  }
  assert.ok(total < MAX_QUERY_OUTPUT_BYTES / 4, `every frame together stays far below the per-stream bound: ${total}`);

  for (const line of ["", "plain host stderr", `Get-CimInstance failed at ${FAKE_PRIVATE_PATH}`, " PRG-L446:lookup-ready:1"]) {
    assert.equal(parseWindowsLineageCausalFrame(line), undefined, `${JSON.stringify(line)} is not a frame and is not retained`);
  }
  for (const line of [
    "PRG-L446:", "PRG-L446:lookup-ready", "PRG-L446:lookup-ready:", "PRG-L446:lookup-ready:-1", "PRG-L446:lookup-ready:01",
    "PRG-L446:lookup-ready:12345678", "PRG-L446:lookup-ready:1:ok", "PRG-L446:lookup-released:1", "PRG-L446:lookup-released:1:OK",
    "PRG-L446:lookup-complete:1:CimCmdlets", `PRG-L446:lookup-complete:1:${FAKE_PRIVATE_PATH}`, "PRG-L446:psmp:1:10",
    `PRG-L446:psmp:1:${FAKE_SECRET}`, "PRG-L446:initial-query-end:1:10-1-0", "PRG-L446:initial-query-end:1:1-1", "PRG-L446:lookup-nested-post:1:1", "PRG-L446:made-up:1", "PRG-L446:hook-error:1:pre:x",
    `PRG-L446:snapshot-end:1${"x".repeat(80)}`,
  ]) {
    assert.equal(parseWindowsLineageCausalFrame(line), "malformed", `${JSON.stringify(line)} is malformed, never guessed`);
  }
});

test("the instrument fails closed on missing, swallowed, malformed, or incoherent hook data", () => {
  const assess = (chunks: string[], gate: "matched" | "ungated" = "matched"): string => {
    const ledger = createWindowsLineageCausalLedger();
    for (const chunk of chunks) ledger.scan(chunk, 0);
    return assessWindowsLineageCausalLedger(ledger, gate);
  };
  const ok = acceptedFrames("ok");
  assert.equal(assess(ok), "ok", "a complete coherent chain is a usable observation");
  assert.equal(assess([ok.join("").slice(0, 37), ok.join("").slice(37)]), "ok", "split chunks assemble into the same frames");
  assert.equal(assess(acceptedFrames("ungated"), "ungated"), "ok");
  assert.equal(assess(ok.slice(0, 5)), "ok", "a child stalled after release and before lookup completion is an observation");
  assert.equal(assess(ok.slice(0, 4)), "ok", "a child waiting at its gate is an observation, judged by the gate record");
  assert.equal(assess([]), "hooks-unconfirmed", "no frames at all never reads as a fast lookup");
  assert.equal(assess(ok.slice(0, 1)), "hooks-unconfirmed", "the hook install itself must be confirmed");
  assert.equal(assess(ok.slice(0, 3)), "hook-unobserved", "a request that started without a pre-lookup frame is unobserved, not fast");
  assert.equal(assess([...ok.slice(0, 3), ok[6]!]), "hook-unobserved", "a completed request without hook frames means the hooks did not run");
  assert.equal(assess([...ok.slice(0, 4), ok[5]!, ok[6]!]), "hook-unobserved", "a skipped release frame is never bridged");
  assert.equal(assess([...ok, frame("hook-error", 41, "post")]), "hook-error", "a hook that caught its own failure is reported");
  assert.equal(assess([frame("prelude-error", 0, "state"), ...ok]), "prelude-error");
  assert.equal(assess([...ok, "PRG-L446:lookup-ready:abc\r\n"]), "frame-malformed");
  assert.equal(assess([...ok, ok[3]!]), "frame-duplicate", "a frame written twice is an instrument anomaly");
  assert.equal(assess(acceptedFrames("ungated")), "release-mismatch", "a gated child must acknowledge the gate");
  assert.equal(assess(ok, "ungated"), "release-mismatch", "an ungated child must never read a token");
  assert.equal(assess([...ok.slice(0, 5), frame("lookup-complete", 5, "other"), frame("initial-query-end", 2, "1-1-0")]),
    "frame-order", "child clock readings must not run backwards along the chain");
  assert.equal(assess([...ok.slice(0, 6), frame("initial-query-end", 300, "0-0-0")]), "frame-order",
    "a resolved lookup must have been counted by both hooks");
  assert.equal(assess([...ok.slice(0, 7), frame("snapshot-end", 350)]), "frame-order", "a snapshot end needs its start");
  assert.equal(assess([...ok.slice(0, 4), frame("snapshot-start", 301)]), "frame-order",
    "a snapshot cannot start before the initial request was observed to end");
  assert.equal(assess(["x".repeat(MAX_QUERY_OUTPUT_BYTES + 1)]), "scan-truncated", "scanning never exceeds the 4KiB stream bound");

  // Pairing: only the post-lookup that closes the FIRST OUTER lookup is its completion.
  const nestedThenOuter = [
    ...ok.slice(0, 5), frame("lookup-nested-post", 20), frame("lookup-complete", 40, "native-cim"),
    frame("initial-query-end", 300, "2-2-0"), ...ok.slice(7),
  ];
  assert.equal(assess(nestedThenOuter), "ok", "a nested completion followed by the outer completion is coherent");
  const nestedThenStall = [...ok.slice(0, 5), frame("lookup-nested-post", 20)];
  assert.equal(assess(nestedThenStall), "ok",
    "a nested completion followed by an outer stall is an observation of a stall INSIDE the outer lookup");
  const stalled = createWindowsLineageCausalLedger();
  stalled.scan(nestedThenStall.join(""), 0);
  stalled.finish();
  assert.equal(stalled.events.has("lookup-complete"), false,
    "a nested completion is never recorded as the outer lookup's resolution");
  assert.equal(assess([...ok.slice(0, 5), frame("lookup-nested-post", 20), frame("initial-query-end", 300, "2-1-1")]),
    "lookup-unpaired", "a request that ended with a target lookup still open cannot be paired");
  assert.equal(assess([...ok.slice(0, 6), frame("initial-query-end", 300, "2-1-0")]), "lookup-unpaired",
    "counts that do not balance with the open depth cannot be paired");
  assert.equal(assess([...ok, frame("lookup-unpaired", 41)]), "lookup-unpaired", "a child-reported pairing failure fails the instrument");
  assert.equal(assess([...ok.slice(0, 4), frame("lookup-nested-post", 5)]), "frame-order",
    "a nested completion cannot precede the outer release");
  assert.equal(assess([...ok.slice(0, 6), frame("lookup-nested-post", 41), ...ok.slice(6)]), "frame-order",
    "a nested completion cannot follow the outer completion");

  // An unterminated final tail is judged at the actual close, never left pending.
  const finalized = (chunks: string[]): ReturnType<typeof createWindowsLineageCausalLedger> => {
    const tailLedger = createWindowsLineageCausalLedger();
    for (const chunk of chunks) tailLedger.scan(chunk, 0);
    tailLedger.finish();
    return tailLedger;
  };
  for (const tail of ["PRG-L446:hook-error:400:post", "PRG-L446:lookup-complete:40:nat", "PRG-L4", `  PRG-L446:snapshot-end:9\r`]) {
    const tailLedger = finalized([...ok, tail]);
    assert.equal(assessWindowsLineageCausalLedger(tailLedger, "matched"), "frame-malformed",
      `an unterminated instrument tail ${JSON.stringify(tail)} fails the instrument`);
    assert.equal(tailLedger.finished, true);
  }
  const truncatedComplete = finalized([...ok.slice(0, 5), "PRG-L446:lookup-complete:40:native-cim"]);
  assert.equal(truncatedComplete.events.has("lookup-complete"), false, "a truncated frame is never parsed as an observation");
  assert.equal(assessWindowsLineageCausalLedger(truncatedComplete, "matched"), "frame-malformed",
    "a truncated completion is invalid instrumentation, not an unresolved native lookup");
  const hostTail = finalized([...ok, `warning ${FAKE_SECRET}`]);
  assert.equal(assessWindowsLineageCausalLedger(hostTail, "matched"), "ok", "an unterminated host tail is not an instrument frame");
  assert.equal(hostTail.unrecognized, 1, "and is counted, never kept");
  hostTail.scan(frame("hook-error", 500, "pre"), 0);
  assert.equal(hostTail.events.has("hook-error"), false, "nothing is scanned after finalization");

  const ledger = createWindowsLineageCausalLedger();
  ledger.scan(`noise ${FAKE_SECRET}\r\n${ok.join("")}`, 7);
  assert.equal(ledger.unrecognized, 1, "other stderr is counted, never kept");
  assert.equal(JSON.stringify([...ledger.events.values()]).includes(FAKE_SECRET), false);
});

test("the release gate opens only after both arms are ready and fails as invalid on any other path", () => {
  const ends: string[] = [];
  const release = (arm: string) => (withToken: boolean): void => { ends.push(`${arm}:${withToken ? "token" : "no-token"}`); };
  let clock = 100;
  const timer = manualSchedule();
  const gate = createWindowsLineageReleaseGate({ parties: ARMS, now: () => clock, schedule: timer.schedule });
  gate.register("inherited", release("inherited"));
  gate.ready("child-scoped");
  assert.deepEqual([...ends], [], "a ready report from an unregistered party is ignored");
  gate.register("child-scoped", release("child-scoped"));
  gate.ready("inherited");
  assert.equal(timer.timers.length, 1, "the bound starts at the first ready report");
  assert.equal(timer.timers[0]!.ms, WINDOWS_LINEAGE_CAUSAL_GATE_BOUND_MS);
  assert.deepEqual([...ends], [], "one ready party is never released");
  clock = 340;
  gate.ready("child-scoped");
  assert.deepEqual(ends, ["inherited:token", "child-scoped:token"], "both parties are released together, only then");
  assert.equal(timer.timers[0]!.cancelled, true, "the bound is cancelled on release");
  assert.deepEqual(gate.record(), { status: "released", parties: 2, registered: 2, ready: 2, boundMs: 1_000, waitMs: 240 });
  gate.dispose();
  assert.equal(gate.record().status, "released", "disposing a released gate keeps its record");

  const expiring = manualSchedule();
  const expired: string[] = [];
  const late = createWindowsLineageReleaseGate({ parties: ARMS, schedule: expiring.schedule });
  late.register("inherited", (withToken) => { expired.push(`inherited:${withToken}`); });
  late.register("child-scoped", (withToken) => { expired.push(`child-scoped:${withToken}`); });
  late.ready("inherited");
  expiring.timers[0]!.callback();
  assert.deepEqual(expired, ["inherited:false", "child-scoped:false"], "an expired bound ends every stdin WITHOUT the token");
  late.ready("child-scoped");
  assert.deepEqual(late.record(), { status: "invalid", reason: "bound-expired", parties: 2, registered: 2, ready: 1, boundMs: 1_000 });
  assert.match(formatWindowsLineageReleaseGate(late.record()), /status=invalid reason=bound-expired .*waitMs=none$/);

  const closing: string[] = [];
  const lost = createWindowsLineageReleaseGate({ parties: ARMS, schedule: manualSchedule().schedule });
  lost.register("inherited", (withToken) => { closing.push(`inherited:${withToken}`); });
  lost.ready("inherited");
  lost.closed("child-scoped");
  assert.deepEqual([...closing], [], "an unregistered close changes nothing");
  lost.register("child-scoped", (withToken) => { closing.push(`child-scoped:${withToken}`); });
  lost.closed("child-scoped");
  assert.equal(lost.record().reason, "party-closed-before-release");
  assert.deepEqual(closing, ["inherited:false", "child-scoped:false"], "a party lost before release releases the other without the token");

  const pending = createWindowsLineageReleaseGate({ parties: ARMS, schedule: manualSchedule().schedule });
  const pendingEnds: boolean[] = [];
  pending.register("inherited", (withToken) => { pendingEnds.push(withToken); });
  pending.dispose();
  assert.equal(pending.record().reason, "disposed-pending");
  pending.register("child-scoped", (withToken) => { pendingEnds.push(withToken); });
  assert.deepEqual(pendingEnds, [false, false], "a party registered after invalidation is released without the token at once");

  const duplicate = createWindowsLineageReleaseGate({ parties: ARMS, schedule: manualSchedule().schedule });
  duplicate.register("inherited", () => undefined);
  duplicate.register("inherited", () => undefined);
  assert.equal(duplicate.record().reason, "duplicate-party");
  const unknown = createWindowsLineageReleaseGate({ parties: ["inherited"], schedule: manualSchedule().schedule });
  unknown.register("child-scoped", () => undefined);
  assert.equal(unknown.record().reason, "unknown-party");
});

test("the corrected arm launches the producer's own environment and the legacy control overrides it", async () => {
  await withProcessEnv(SYNTHETIC_ENV_PATCH, () => twoArmExperimentCase());
});

async function twoArmExperimentCase(): Promise<void> {
  // The legacy control's override source; the corrected arm never sees it.
  const parentEnv: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows", PSModulePath: SYNTHETIC_MODULE_PATH, psmodulepath: "dup", PATH: "C:\\bin" };
  const parentBefore = { ...parentEnv };
  const processUnchanged = processEnvSnapshot();
  const processModulePathKeys = countModulePathKeys(process.env);
  const timer = manualSchedule();
  let clock = 0;
  const gate = createWindowsLineageReleaseGate({ parties: ARMS, now: () => clock, schedule: timer.schedule });
  const fake = fakeCausalLauncher();
  const positives = ARMS.map((arm) => createWindowsLineageCausalProbe({
    arm, role: "positive", gate: "matched", releaseGate: gate, parentEnv, launch: fake.launch, now: () => clock,
  }));
  const proving = withSystemRoot("/fake-windows", () => Promise.all(positives.map((probe) =>
    verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: probe.execute }))));
  await flushAsync();

  assert.equal(fake.children.length, 2, "one query child per positive verification, no warmup or extra child");
  const [control, treated] = fake.children as [FakeCausalChild, FakeCausalChild];
  for (const launched of fake.children) {
    assert.equal(launched.file, join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    assert.deepEqual(launched.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(launched.args.length, 5);
    assert.ok(launched.args[4]!.includes("[Console]::In.ReadLine()"), "positives run the matched-gate instrumented script");
    assert.ok(!("timeout" in launched.options), "the probe never takes over the owned 5s deadline");
  }
  assert.equal(control.args[4], treated.args[4], "both arms run byte-identical scripts");
  // The corrected arm launches exactly the environment the producer built from this
  // process's environment: compared against the specification, not re-derived here,
  // so a producer that dropped the correction (or changed any other key) fails.
  assert.deepEqual(queryOptionsShape(treated.options), PRODUCTION_OPTIONS_SHAPE,
    "the corrected arm forwards production's options object, environment copy included");
  assert.deepEqual(queryEnvironmentDifference(treated.options.env, process.env), expectedEnvironmentDifference(process.env),
    "the corrected arm's env is production's copy: no PSModulePath alias, every other key and value kept");
  assert.ok(control.options.env === parentEnv, "the legacy control explicitly overrides the env with the original parent environment");
  assert.equal(countModulePathKeys(control.options.env), 2, "the legacy control still carries the parent's PSModulePath keys");
  const { env: controlEnv, ...controlRest } = control.options;
  const { env: treatedEnv, ...treatedRest } = treated.options;
  assert.ok(controlEnv !== treatedEnv, "the arms launch different environment objects");
  assert.deepEqual(controlRest, treatedRest, "the arms differ only in their environment");
  assert.deepEqual(parentEnv, parentBefore, "the override source is never modified");

  control.child.emit("spawn");
  treated.child.emit("spawn");
  control.stderr.emit("data", acceptedFrames("ok").slice(0, 4).join(""));
  clock = 15;
  assert.deepEqual([control.stdinEnds, treated.stdinEnds], [[], []], "no child is released while one arm is not ready");
  treated.stderr.emit("data", acceptedFrames("ok").slice(0, 3).join("") + "PRG-L446:lookup-");
  assert.deepEqual([control.stdinEnds, treated.stdinEnds], [[], []], "a partial ready frame is not readiness");
  clock = 22;
  treated.stderr.emit("data", "ready:4\r\n");
  assert.deepEqual([control.stdinEnds, treated.stdinEnds], [["G\n"], ["G\n"]],
    "the token is written then stdin ended, for both children, exactly once, after both are ready");
  assert.deepEqual(gate.record(), { status: "released", parties: 2, registered: 2, ready: 2, boundMs: 1_000, waitMs: 22 });

  for (const launched of fake.children) {
    launched.stderr.emit("data", acceptedFrames("ok").slice(4).join(""));
    launched.stdout.emit("data", VALID_EVIDENCE);
    launched.child.emit("exit", 0, null);
    launched.child.emit("close", 0, null);
    launched.callback(null, VALID_EVIDENCE, "");
  }
  assert.deepEqual(await proving, [{ verified: true }, { verified: true }],
    "the forwarded callback keeps each production acceptance decision intact");
  // Compared once the test's own SystemRoot override has been restored.
  assert.deepEqual(processUnchanged(), { sameKeys: true, sameValues: true }, "this process's environment is never modified");
  assert.equal(countModulePathKeys(process.env), processModulePathKeys, "this process keeps every PSModulePath key it had");
  assert.deepEqual(await Promise.all(positives.map((probe) => probe.whenClosed())), [true, true],
    "each probe witnessed its actual query child's close");
  positives.forEach((probe) => probe.dispose());
  assert.deepEqual([control.stdinEnds, treated.stdinEnds], [["G\n"], ["G\n"]], "dispose never writes a second time");

  const negatives = ARMS.map((arm) => createWindowsLineageCausalProbe({
    arm, role: "negative", gate: "ungated", parentEnv, launch: fake.launch, now: () => clock,
  }));
  const refusals: WindowsLineageVerification[] = [];
  for (const probe of negatives) {
    const refusing = withSystemRoot("/fake-windows", () =>
      verifyWindowsProcessLineage(fakeOwnedRoot(), 999, { platform: "win32", execute: probe.execute }));
    await flushAsync();
    const launched: FakeCausalChild = fake.children[fake.children.length - 1]!;
    assert.ok(!launched.args[4]!.includes("[Console]::In.ReadLine()"), "negatives run ungated");
    launched.child.emit("spawn");
    launched.stderr.emit("data", acceptedFrames("ungated").slice(0, 7).join(""));
    launched.stdout.emit("data", "PI_REVIEW_GATE_LINEAGE_NO:chain-parent-absent\r\n");
    launched.child.emit("exit", 0, null);
    launched.child.emit("close", 0, null);
    launched.callback(null, "PI_REVIEW_GATE_LINEAGE_NO:chain-parent-absent\r\n", "");
    refusals.push(await refusing);
    assert.deepEqual(launched.stdinEnds, [], "an ungated child's stdin is left exactly as production leaves it");
  }
  assert.deepEqual(refusals, [
    { verified: false, reason: "chain-parent-absent" },
    { verified: false, reason: "chain-parent-absent" },
  ], "the unrelated refusals still come from the native chain stage");

  const records = [
    ...positives.map((probe, index) => probe.record({ verified: true } as WindowsLineageVerification)),
    ...negatives.map((probe, index) => probe.record(refusals[index]!)),
  ];
  assert.deepEqual(assessWindowsLineageCausalExperiment({ gate: gate.record(), records }), { valid: true });
  const [controlRecord, treatedRecord] = records as [WindowsLineageCausalRecord, WindowsLineageCausalRecord];
  assert.equal(controlRecord.treatment, "legacy-inherited-override");
  assert.equal(treatedRecord.treatment, "producer-env");
  assert.equal(controlRecord.parentModulePath, "1111", "the parent categories are closed bits computed in memory");
  for (const record of records) {
    const legacy = record.arm === "inherited";
    assert.equal(record.producerEnv, true, `${record.arm}: the producer supplied its own environment copy`);
    assert.equal(record.launchModulePath, legacy ? "1111" : "0000", `${record.arm}: launched module-path categories`);
    assert.equal(record.launchModulePathKeys, legacy ? 2 : 0, `${record.arm}: launched PSModulePath key count`);
  }
  assert.equal(controlRecord.gateWaitMs, 22, "the introduced gate wait is recorded separately for the first-ready arm");
  assert.equal(treatedRecord.gateWaitMs, 0);

  for (const record of records) {
    const line = formatWindowsLineageCausalRecord(record);
    assert.ok(line.length <= WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS, `bounded: ${line.length}`);
    assert.match(line, /^prg-l446 v=2 experiment=l446-psmodulepath-differential arm=(?:inherited|child-scoped) role=(?:positive|negative) treatment=(?:legacy-inherited-override|producer-env) /);
    assert.ok(!line.includes("delegation="), "the experiment never claims production delegation");
    for (const forbidden of ["vic", "C:\\", "Program Files", "67890", "4321", "999", "Get-CimInstance", "PRG-L446", "PSModulePath", "G\n"]) {
      assert.ok(!line.includes(forbidden), `the summary carries no ${JSON.stringify(forbidden)}: ${line}`);
    }
    assert.match(line, record.arm === "inherited"
      ? /instrument=ok calls=1 callbacks=1 exit=true close=true stdinFailed=false parentPsmp=1111 producerEnv=true launchPsmp=1111 launchPsmpKeys=2 childPsmp=1010/
      : /instrument=ok calls=1 callbacks=1 exit=true close=true stdinFailed=false parentPsmp=1111 producerEnv=true launchPsmp=0000 launchPsmpKeys=0 childPsmp=1010/);
  }
  assert.match(formatWindowsLineageCausalRecord(controlRecord),
    /lookup=native-cim lookups=1-1-0 ack=ok gateWaitMs=22 .*events=\[child-spawn@0,stderr-first@0,psmp@0\/c1:1010,hooks-installed@0\/c2,initial-query-start@0\/c3,lookup-ready@0\/c4,release-sent@22,lookup-released@22\/c9:ok,lookup-complete@22\/c40:native-cim,/);
}

test("an invalid gate or a lost party makes the experiment invalid and never pretends a timeout", async () => {
  const timer = manualSchedule();
  const gate = createWindowsLineageReleaseGate({ parties: ARMS, schedule: timer.schedule });
  const fake = fakeCausalLauncher();
  const probes = ARMS.map((arm) => createWindowsLineageCausalProbe({
    arm, role: "positive", gate: "matched", releaseGate: gate, parentEnv: { SystemRoot: "C:\\Windows" }, launch: fake.launch,
  }));
  const proving = withSystemRoot("/fake-windows", () => Promise.all(probes.map((probe) =>
    verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: probe.execute }))));
  await flushAsync();
  const [first, second] = fake.children as [FakeCausalChild, FakeCausalChild];
  first.stderr.emit("data", acceptedFrames("ok").slice(0, 4).join(""));
  timer.timers[0]!.callback();
  assert.deepEqual([first.stdinEnds, second.stdinEnds], [[undefined], [undefined]],
    "an expired gate ends both stdins without the token, so a waiting child proceeds instead of stalling");
  first.stderr.emit("data", frame("lookup-released", 1_004, "invalid") + acceptedFrames("ok").slice(5).join(""));
  // The second child reaches its pre-lookup only after the gate already failed: it
  // reads end-of-input instead of the token and proceeds, acknowledging `invalid`.
  second.stderr.emit("data", acceptedFrames("ok").slice(0, 4).join("") + frame("lookup-released", 1_200, "invalid"));
  for (const launched of fake.children) {
    launched.child.emit("exit", 0, null);
    launched.child.emit("close", 0, null);
    launched.callback(null, VALID_EVIDENCE, "");
  }
  const results = await proving;
  const negatives = ARMS.map((arm) => ({
    ...probes[0]!.record({ verified: false, reason: "chain-parent-absent" }),
    arm, role: "negative" as const, gate: "ungated" as const, treatment: arm === "inherited" ? "legacy-inherited-override" as const : "producer-env" as const,
    releaseAck: "ungated",
  }));
  const validity = assessWindowsLineageCausalExperiment({
    gate: gate.record(),
    records: [...probes.map((probe, index) => probe.record(results[index]!)), ...negatives],
  });
  assert.equal(validity.valid, false, "an expired gate can never be a valid experiment");
  assert.ok(!validity.valid && validity.reasons.includes("gate-invalid-bound-expired"), JSON.stringify(validity));
  assert.ok(!validity.valid && validity.reasons.includes("inherited-positive-ack-invalid"),
    "the child-side acknowledgement of a missing token is reported");
  assert.ok(!validity.valid && validity.reasons.every((reason) => /^[a-z0-9-]+$/.test(reason)), "reasons are fixed tokens");
  assert.deepEqual(probes[0]!.record(results[0]!).releaseAck, "invalid");
  assert.equal(probes[0]!.record(results[0]!).gateWaitMs, undefined, "no release was sent, so no gate wait is claimed");

  // A second launch through one probe starts nothing and surfaces as production's fixed spawn stage.
  const again = await withSystemRoot("/fake-windows", () =>
    verifyWindowsProcessLineage(fakeOwnedRoot(), CANDIDATE_PID, { platform: "win32", execute: probes[0]!.execute }));
  assert.deepEqual(again, { verified: false, reason: "query-spawn-failed" });
  assert.equal(fake.children.length, 2, "the probe never launches a second query child or retries");
  assert.equal(probes[0]!.record(results[0]!).instrument, "extra-call");

  const missing = assessWindowsLineageCausalExperiment({ gate: { status: "pending", parties: 2, registered: 0, ready: 0, boundMs: 1_000 }, records: [] });
  assert.equal(missing.valid, false);
  assert.ok(!missing.valid && missing.reasons.includes("gate-pending-none") && missing.reasons.includes("child-scoped-negative-records-missing"));

  const unstarted = createWindowsLineageCausalProbe({ arm: "inherited", role: "negative", gate: "ungated" });
  assert.equal(await unstarted.whenClosed(), false, "a probe that never launched reports no closure instead of waiting forever");
  assert.equal(unstarted.record({ verified: false, reason: "preflight-not-win32" }).instrument, "not-started");
});

test("the corrected arm never normalizes: a producer that omitted the correction is launched as-is and reported", async () => {
  const { script } = await captureLineageScript();
  const file = join("/fake-windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const base = { encoding: "utf8" as const, maxBuffer: MAX_QUERY_OUTPUT_BYTES, windowsHide: true };
  const brokenProducers: Array<{ name: string; options: WindowsLineageQueryOptions; reason: string; keys: number }> = [
    // A producer that forwarded the parent's module path unchanged.
    { name: "env kept PSModulePath", options: { ...base, env: { SystemRoot: "C:\\Windows", PSModulePath: SYNTHETIC_MODULE_PATH } },
      reason: "child-scoped-negative-launch-env-module-path", keys: 1 },
    // A case alias the producer failed to remove.
    { name: "env kept a case alias", options: { ...base, env: { SystemRoot: "C:\\Windows", psmodulepath: "alias" } },
      reason: "child-scoped-negative-launch-env-module-path", keys: 1 },
    // A producer that dropped the env option entirely (the child would inherit).
    { name: "env omitted", options: base as WindowsLineageQueryOptions, reason: "child-scoped-negative-producer-env-missing", keys: -1 },
  ];
  for (const broken of brokenProducers) {
    const fake = fakeCausalLauncher();
    const probe = createWindowsLineageCausalProbe({
      arm: "child-scoped", role: "negative", gate: "ungated", parentEnv: { SystemRoot: "C:\\Windows" }, launch: fake.launch,
    });
    probe.execute(file, args, broken.options, () => undefined);
    assert.equal(fake.children.length, 1, `${broken.name}: one launch`);
    assert.ok(fake.children[0]!.options === broken.options, `${broken.name}: the corrected arm forwards the producer's options object verbatim`);
    const record = probe.record({ verified: false, reason: "chain-parent-absent" });
    if (broken.keys >= 0) assert.equal(record.launchModulePathKeys, broken.keys, `${broken.name}: the leaked key is counted`);
    const validity = assessWindowsLineageCausalExperiment({ gate: { status: "released", parties: 2, registered: 2, ready: 2, boundMs: 1_000, waitMs: 1 }, records: [record] });
    assert.ok(!validity.valid && validity.reasons.includes(broken.reason), `${broken.name}: ${validity.valid ? "valid" : validity.reasons.join(",")}`);
    assert.ok(!formatWindowsLineageCausalRecord(record).includes("alias") && !formatWindowsLineageCausalRecord(record).includes("C:\\"),
      `${broken.name}: no environment value reaches the summary`);
  }
});

test("the probe finalizes its ledger at the actual close, so a truncated last frame invalidates the experiment", async () => {
  const fake = fakeCausalLauncher();
  const probe = createWindowsLineageCausalProbe({
    arm: "inherited", role: "negative", gate: "ungated", parentEnv: { SystemRoot: "C:\\Windows" }, launch: fake.launch,
  });
  const refusing = withSystemRoot("/fake-windows", () =>
    verifyWindowsProcessLineage(fakeOwnedRoot(), 999, { platform: "win32", execute: probe.execute }));
  await flushAsync();
  const launched = fake.children[0]!;
  launched.child.emit("spawn");
  launched.stderr.emit("data", acceptedFrames("ungated").slice(0, 7).join("") + "PRG-L446:hook-error:400:post");
  launched.stdout.emit("data", "PI_REVIEW_GATE_LINEAGE_NO:chain-parent-absent\r\n");
  launched.child.emit("exit", 0, null);
  const beforeClose = probe.record({ verified: false, reason: "chain-parent-absent" });
  assert.equal(beforeClose.closeWitnessed, false, "nothing is finalized before the child's own close");
  launched.child.emit("close", 0, null);
  launched.callback(null, "PI_REVIEW_GATE_LINEAGE_NO:chain-parent-absent\r\n", "");
  const outsider = await refusing;
  assert.deepEqual(outsider, { verified: false, reason: "chain-parent-absent" }, "the production decision is forwarded unchanged");
  assert.equal(await probe.whenClosed(), true);
  const record = probe.record(outsider);
  assert.equal(record.instrument, "frame-malformed", "the unterminated hook-error tail is judged at close, not silently dropped");
  assert.equal(record.malformed, 1);
  const validity = assessWindowsLineageCausalExperiment({
    gate: { status: "released", parties: 2, registered: 2, ready: 2, boundMs: 1_000, waitMs: 1 },
    records: [record],
  });
  assert.ok(!validity.valid && validity.reasons.includes("inherited-negative-instrument-frame-malformed"), JSON.stringify(validity));
  assert.ok(!formatWindowsLineageCausalRecord(record).includes("hook-error@"), "the truncated frame never becomes an observation");
});

test("the causal summary cannot exceed its bound or report an unvalidated value", () => {
  const line = formatWindowsLineageCausalRecord({
    arm: `x${FAKE_SECRET}` as WindowsLineageCausalRecord["arm"],
    role: "positive",
    gate: "matched",
    treatment: FAKE_PRIVATE_PATH as WindowsLineageCausalRecord["treatment"],
    result: { verified: false, reason: FAKE_SECRET } as unknown as WindowsLineageVerification,
    elapsedMs: 2 ** 40,
    calls: -1,
    callbacks: 1,
    instrument: "ok",
    exitWitnessed: true,
    closeWitnessed: true,
    stdinFailed: false,
    parentModulePath: SYNTHETIC_MODULE_PATH,
    producerEnv: FAKE_SECRET as unknown as boolean,
    launchModulePath: FAKE_PRIVATE_PATH,
    launchModulePathKeys: -3,
    childModulePath: "10101",
    lookupClass: FAKE_PRIVATE_PATH,
    lookupCounts: FAKE_SECRET,
    releaseAck: "G",
    gateWaitMs: 2 ** 31,
    malformed: 0,
    unrecognized: 2 ** 40,
    duplicates: 0,
    scanTruncated: false,
    events: [
      ...WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER.map((event) => ({ event, parentMs: 2 ** 31 - 1, childMs: 9_999_999, token: FAKE_SECRET, count: 999 })),
      // Valid longest tokens on a second copy are ignored: the first record of an event is canonical.
      ...WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER.map((event) => ({ event, parentMs: 1, token: "cim-elsewhere", count: 1 })),
      { event: "made-up" as WindowsLineageCausalRecord["events"][number]["event"], parentMs: 1, count: 1 },
    ],
  });
  assert.ok(line.length <= WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS, `bounded by construction: ${line.length}`);
  for (const forbidden of [FAKE_SECRET, "vic", "C:\\", "made-up", "10101"]) {
    assert.ok(!line.includes(forbidden), `no unvalidated ${JSON.stringify(forbidden)}: ${line}`);
  }
  assert.match(line, /arm=\? role=positive treatment=\? gate=matched result=unknown instrument=ok calls=\?/);
  assert.match(line, /parentPsmp=\? producerEnv=false launchPsmp=\? launchPsmpKeys=\? childPsmp=\? lookup=\? lookups=\? ack=\? gateWaitMs=\? /);
  assert.ok(!line.includes("cim-elsewhere") && !line.includes("@1,"), "a duplicated event record never replaces the canonical first one");
  const longest: Record<string, string> = {
    psmp: "1111", "lookup-released": "ungated", "lookup-complete": "cim-elsewhere", "initial-query-end": "9-9-9",
    "prelude-error": "hooks", "hook-error": "post",
  };
  const widest = formatWindowsLineageCausalRecord({
    arm: "child-scoped", role: "negative", gate: "ungated", treatment: "producer-env",
    result: { verified: false, reason: "evidence-creation-order-invalid" }, elapsedMs: 2 ** 31 - 1, calls: 2 ** 31 - 1,
    callbacks: 2 ** 31 - 1, instrument: "hooks-unconfirmed", exitWitnessed: false, closeWitnessed: false, stdinFailed: true,
    parentModulePath: "1111", producerEnv: false, launchModulePath: "1111", launchModulePathKeys: 9,
    childModulePath: "1111", lookupClass: "cim-elsewhere", lookupCounts: "9-9-9", releaseAck: "ungated",
    gateWaitMs: 2 ** 31 - 1, malformed: 999, unrecognized: 999, duplicates: 999, scanTruncated: true,
    events: WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER.map((event) => ({
      event, parentMs: 2 ** 31 - 1, childMs: 9_999_999, ...(longest[event] === undefined ? {} : { token: longest[event] }), count: 999,
    })),
  } as WindowsLineageCausalRecord);
  assert.ok(widest.length <= WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS, `the widest valid record is bounded: ${widest.length}`);
  assert.match(widest, /,\+1\]$/, `only the trailing event is withheld, and it is counted instead of overflowing: ${widest}`);
  assert.match(widest, /lookup-released@2147483647\/c9999999x999:ungated,lookup-nested-post@2147483647\/c9999999x999,lookup-complete@2147483647\/c9999999x999:cim-elsewhere,/,
    "a repeat count precedes the closed token, so the two never run together");
});

// ---------------------------------------------------------------------------
// Owned-process identity handshake (cross-platform; used by the win32 fixture)
// ---------------------------------------------------------------------------

/**
 * A native fixture ownership frame is exactly one newline-terminated line that
 * is either `PRG-PID:<pid>` or `PRG-ERR:<reason>`. Nothing else is interpretable,
 * so a partial chunk, a truncated stream, or a failed inner spawn can never be
 * mistaken for a process identity that cleanup later signals.
 */
const OWNED_PID_LINE = /^PRG-PID:([1-9]\d{0,9})$/;
const OWNED_ABSENT_LINE = /^PRG-ERR:([A-Za-z0-9._-]{1,64})$/;
const OWNED_PID_TEXT = /^([1-9]\d{0,9})$/;
const MAX_OWNED_FRAME_BYTES = 256;

/** Parse one owned PID text into a usable PID, or refuse. Never a guess. */
function parseOwnedPid(text: string): number | undefined {
  const match = OWNED_PID_TEXT.exec(text.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_WINDOWS_PROCESS_ID ? pid : undefined;
}

interface OwnedPidHandshake {
  /** Feed raw stdout text; a PID is adopted only from one complete frame. */
  feed(chunk: string): void;
  /** Record a transport-level failure (early exit, spawn error, expired bound). */
  fail(reason: string): void;
  readonly pid: number | undefined;
  readonly failure: string | undefined;
  /** True only when the owned root positively reported it has no descendant. */
  readonly reportedAbsent: boolean;
  readonly settled: boolean;
}

function createOwnedPidHandshake(): OwnedPidHandshake {
  let buffer = "";
  let pid: number | undefined;
  let failure: string | undefined;
  let reportedAbsent = false;
  let settled = false;
  const stop = (reason?: string, adopted?: number): void => {
    settled = true;
    if (reason !== undefined) failure = reason;
    if (adopted !== undefined) pid = adopted;
  };
  return {
    feed(chunk: string): void {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > MAX_OWNED_FRAME_BYTES) {
        stop(`ownership frame exceeded ${MAX_OWNED_FRAME_BYTES} bytes without a complete line`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      const pidLine = OWNED_PID_LINE.exec(line);
      if (pidLine) {
        const adopted = parseOwnedPid(pidLine[1] ?? "");
        if (adopted !== undefined) stop(undefined, adopted);
        else stop(`ownership frame ${JSON.stringify(line)} is not a usable process id`);
        return;
      }
      const absentLine = OWNED_ABSENT_LINE.exec(line);
      if (absentLine) {
        reportedAbsent = true;
        stop(`owned root reported ${absentLine[1]}`);
        return;
      }
      stop(`malformed ownership frame ${JSON.stringify(line)}`);
    },
    fail(reason: string): void {
      if (!settled) stop(reason);
    },
    get pid(): number | undefined {
      return pid;
    },
    get failure(): string | undefined {
      return failure;
    },
    get reportedAbsent(): boolean {
      return reportedAbsent;
    },
    get settled(): boolean {
      return settled;
    },
  };
}

/** Bounded poll until the handshake settles; expiry is a recorded failure. */
async function waitForHandshake(handshake: OwnedPidHandshake, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!handshake.settled) {
    if (Date.now() > deadline) {
      handshake.fail("the owned root did not report an ownership frame within the bounded wait");
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

test("a split ownership frame yields a PID only once it is complete and validated", () => {
  const split = createOwnedPidHandshake();
  split.feed("PRG-PI");
  assert.equal(split.pid, undefined, "a partial frame prefix is not an identity");
  assert.equal(split.settled, false);
  split.feed("D:4242");
  assert.equal(split.pid, undefined, "a complete PID without its terminator is not an identity");
  assert.equal(split.settled, false);
  split.feed("\n");
  assert.equal(split.pid, 4242, "one complete validated frame adopts the PID");
  assert.equal(split.failure, undefined);
  assert.equal(split.settled, true);
  split.feed("PRG-PID:9999\n");
  assert.equal(split.pid, 4242, "a settled handshake never adopts a second identity");
});

test("missing, malformed, and truncated ownership messages never yield a PID", () => {
  const malformed = [
    "4242\n",
    "PRG-PID:abc\n",
    "PRG-PID:undefined\n",
    "PRG-PID:NaN\n",
    "PRG-PID:0\n",
    "PRG-PID:-7\n",
    "PRG-PID:12.5\n",
    "PRG-PID:1234567890123\n",
    "PRG-PID:9999999999\n",
    "PRG-PID:4242",
    "\n",
    "PRG-ERR:not a frame token\n",
  ];
  for (const chunk of malformed) {
    const handshake = createOwnedPidHandshake();
    handshake.feed(chunk);
    assert.equal(handshake.pid, undefined, `${JSON.stringify(chunk)} must never adopt a PID`);
    if (!chunk.endsWith("\n")) {
      assert.equal(handshake.settled, false, `${JSON.stringify(chunk)} is incomplete, not malformed`);
      continue;
    }
    assert.equal(handshake.settled, true, `${JSON.stringify(chunk)} settles as a refusal`);
    assert.ok(handshake.failure !== undefined, `${JSON.stringify(chunk)} reports why it refused`);
  }

  // A usable PID above the process-id bound is refused, not truncated.
  const oversizedPid = createOwnedPidHandshake();
  oversizedPid.feed("PRG-PID:4294967296\n");
  assert.equal(oversizedPid.pid, undefined);
  assert.match(oversizedPid.failure ?? "", /not a usable process id/);

  // Partial digits then a lost stream: the identity was never complete.
  const truncated = createOwnedPidHandshake();
  truncated.feed("PRG-PID:12");
  truncated.fail("the owned root exited early with 1");
  assert.equal(truncated.pid, undefined, "a truncated PID is never signalled as a process");
  assert.match(truncated.failure ?? "", /exited early/);

  // An unframed flood fails closed instead of scanning for digits.
  const flooded = createOwnedPidHandshake();
  flooded.feed("x".repeat(MAX_OWNED_FRAME_BYTES + 32));
  assert.equal(flooded.pid, undefined);
  assert.match(flooded.failure ?? "", /exceeded/);

  // Positive absence is distinguishable from a lost handshake.
  const absent = createOwnedPidHandshake();
  absent.feed("PRG-ERR:descendant-spawn-failed\n");
  assert.equal(absent.pid, undefined);
  assert.equal(absent.reportedAbsent, true, "the root positively reported no descendant");
  const lost = createOwnedPidHandshake();
  lost.fail("the bounded wait expired");
  assert.equal(lost.pid, undefined);
  assert.equal(lost.reportedAbsent, false, "a lost handshake must be treated as a possible orphan");
});

test("ownership PID files are only read as complete validated identities", () => {
  assert.equal(parseOwnedPid("4242"), 4242);
  assert.equal(parseOwnedPid("  4242\n"), 4242);
  for (const text of ["", "   ", "abc", "NaN", "undefined", "0", "-7", "12.5", "4242 extra", "99999999999", "4294967296"]) {
    assert.equal(parseOwnedPid(text), undefined, `${JSON.stringify(text)} is not a usable PID`);
  }
});

// ---------------------------------------------------------------------------
// Owned fixture teardown (cross-platform contract, used by the win32 fixture)
// ---------------------------------------------------------------------------

/** An unusable identity is never "live", so cleanup can never signal NaN. */
function pidIsLive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_WINDOWS_PROCESS_ID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Never let fixture teardown become an unbounded wait. */
async function bounded<T>(what: string, promise: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded wait for a positively-owned fixture PID to be gone. */
async function waitForPidGone(
  pid: number,
  isLive: (pid: number) => boolean = pidIsLive,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isLive(pid)) {
    if (Date.now() > deadline) throw new Error(`owned fixture pid ${pid} never settled`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

/**
 * A close wait settles only on the child's own `close` event. An `error` event is
 * not closure evidence — a failed signal or a stream failure says nothing about
 * whether the process is gone — so treating its rejection as settlement would
 * let teardown delete ownership records for a process that may still be running.
 */
function closeSettled(child: { once: (event: "close", listener: () => void) => unknown }): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    child.once("close", () => resolvePromise());
  });
}

interface OwnedFixtureChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill: () => boolean;
}

interface OwnedFixtureCleanupPlan {
  fixtureDir: string;
  direct: Array<{ label: string; child: OwnedFixtureChild; closed: Promise<void> }>;
  /** The fixture whose descendants must be terminated as a tree, if any. */
  ownedTreeRoot?: OwnedFixtureChild;
  descendantPids: Iterable<number>;
  /** True when a validated identity was adopted, or absence was positively reported. */
  ownershipConfirmed: boolean;
  terminateOwnedTree?: (rootPid: number) => string[];
  isLive?: (pid: number) => boolean;
  signalPid?: (pid: number) => void;
  boundMs?: number;
}

interface OwnedFixtureCleanupResult {
  problems: string[];
  /** Set whenever settlement stayed unconfirmed and the records were kept. */
  retainedFixtureDir: string | undefined;
}

const terminateOwnedWindowsTree = (rootPid: number): string[] => {
  if (process.platform !== "win32") return [];
  const tree = spawnSync("taskkill", ["/T", "/F", "/PID", String(rootPid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (tree.error || (tree.status ?? 1) !== 0) {
    return [`owned tree termination reported ${String(tree.status ?? tree.error?.message ?? "unknown")}`];
  }
  return [];
};

/**
 * Teardown for the native lineage fixture. Every step is individually guarded and
 * individually bounded, so one failure can never strand another fixture; the
 * ownership records are removed only after both direct fixtures actually closed,
 * every recorded descendant actually stopped being live, and descendant ownership
 * was confirmed or positively reported absent. Otherwise the directory is
 * retained and reported, because deleting the only ownership evidence while a
 * fixture may still be running is the worse failure.
 */
async function cleanupOwnedFixtures(plan: OwnedFixtureCleanupPlan): Promise<OwnedFixtureCleanupResult> {
  const problems: string[] = [];
  const isLive = plan.isLive ?? pidIsLive;
  const signalPid = plan.signalPid ?? ((pid: number): void => { process.kill(pid); });
  const boundMs = plan.boundMs ?? 20_000;
  const descendants = [...plan.descendantPids].filter((pid) => Number.isSafeInteger(pid) && pid > 0);

  // Terminate the owned tree while its root is still alive: on Windows a signal
  // to the Node root does not terminate its descendants.
  const root = plan.ownedTreeRoot;
  if (root !== undefined && root.pid !== undefined && root.exitCode === null && root.signalCode === null) {
    const treeProblems = (plan.terminateOwnedTree ?? terminateOwnedWindowsTree)(root.pid);
    problems.push(...treeProblems);
    if (treeProblems.length > 0) {
      try {
        root.kill();
      } catch (error) {
        problems.push(`owned root signal failed: ${String(error)}`);
      }
    }
  }
  for (const pid of descendants) {
    if (!isLive(pid)) continue;
    try {
      signalPid(pid);
    } catch (error) {
      problems.push(`descendant pid ${pid} signal failed: ${String(error)}`);
    }
  }
  for (const { label, child } of plan.direct) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch (error) {
        problems.push(`${label} signal failed: ${String(error)}`);
      }
    }
  }

  let settled = true;
  for (const { label, closed } of plan.direct) {
    try {
      await bounded(`${label} close`, closed, boundMs);
    } catch (error) {
      settled = false;
      problems.push(String(error));
    }
  }
  for (const pid of descendants) {
    try {
      await bounded(`descendant pid ${pid} exit`, waitForPidGone(pid, isLive, boundMs), boundMs + 1_000);
    } catch (error) {
      settled = false;
      problems.push(String(error));
    }
  }
  if (!plan.ownershipConfirmed) {
    settled = false;
    problems.push("descendant ownership could not be confirmed: no validated frame or ownership record, and no positive absence report");
  }

  if (!settled) {
    return {
      problems: [...problems, `fixture directory retained pending confirmed process settlement: ${plan.fixtureDir}`],
      retainedFixtureDir: plan.fixtureDir,
    };
  }
  try {
    await rm(plan.fixtureDir, { recursive: true, force: true });
  } catch (error) {
    problems.push(`fixture directory cleanup failed: ${String(error)}`);
  }
  return { problems, retainedFixtureDir: undefined };
}

test("a close wait settles only on close, never on an error or exit event", async () => {
  const child = new EventEmitter();
  // Exactly the real fixture's shape: an error listener exists so a failed signal
  // is handled, while closure is proven only by `close`.
  child.on("error", () => undefined);
  const closed = closeSettled(child as unknown as Parameters<typeof closeSettled>[0]);
  let settled = false;
  void closed.then(() => { settled = true; });

  child.emit("error", new Error("signal failed"));
  child.emit("exit", 1, null);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(settled, false, "an error or exit event is not process closure evidence");

  child.emit("close", 1, null);
  await bounded("close wait", closed, 1_000);
  assert.equal(settled, true, "only the close event settles the wait");
});

async function withScratchFixtureDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "prg-lineage-teardown-"));
  await writeFile(join(dir, "root-seen-pid.txt"), "4242");
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const settledClose = (): Promise<void> => Promise.resolve();

/** Live for the first check (so the descendant is signalled), gone afterwards. */
const liveOnce = (): (() => boolean) => {
  let checks = 0;
  return () => (checks += 1) === 1;
};

test("teardown removes ownership records only after every fixture settles", async () => {
  await withScratchFixtureDir(async (fixtureDir) => {
    const signals: Array<number | string> = [];
    const root = { pid: 4242, exitCode: null, signalCode: null, kill: () => { signals.push("root"); return true; } };
    const unrelated = { pid: 4300, exitCode: 0, signalCode: null, kill: () => { signals.push("unrelated"); return true; } };
    const result = await cleanupOwnedFixtures({
      fixtureDir,
      direct: [
        { label: "owned root", child: root, closed: settledClose() },
        { label: "unrelated fixture", child: unrelated, closed: settledClose() },
      ],
      ownedTreeRoot: root,
      descendantPids: [4243],
      ownershipConfirmed: true,
      terminateOwnedTree: (pid) => { signals.push(`tree:${pid}`); return []; },
      isLive: liveOnce(),
      signalPid: (pid) => { signals.push(pid); },
      boundMs: 200,
    });
    assert.deepEqual(result.problems, [], "a fully settled teardown reports nothing wrong");
    assert.equal(result.retainedFixtureDir, undefined);
    assert.deepEqual(signals, ["tree:4242", 4243, "root"],
      "the owned tree is terminated first, then the live descendant, then the still-running root");
    await assert.rejects(readFile(join(fixtureDir, "root-seen-pid.txt"), "utf8"), { code: "ENOENT" },
      "records are removed only once settlement is confirmed");
  });
});

test("an unconfirmed close or descendant exit retains the ownership records", async () => {
  const never = new Promise<void>(() => undefined);
  const cases: Array<{ name: string; plan: (fixtureDir: string) => OwnedFixtureCleanupPlan }> = [
    {
      name: "close wait timeout",
      plan: (fixtureDir) => ({
        fixtureDir,
        direct: [
          {
            label: "owned root",
            child: { pid: 4242, exitCode: null, signalCode: null, kill: () => true },
            closed: never,
          },
        ],
        descendantPids: [],
        ownershipConfirmed: true,
        terminateOwnedTree: () => [],
        isLive: () => false,
        signalPid: () => undefined,
        boundMs: 40,
      }),
    },
    {
      name: "descendant exit timeout",
      plan: (fixtureDir) => ({
        fixtureDir,
        direct: [
          {
            label: "owned root",
            child: { pid: 4242, exitCode: null, signalCode: null, kill: () => true },
            closed: settledClose(),
          },
        ],
        descendantPids: [4243],
        ownershipConfirmed: true,
        terminateOwnedTree: () => [],
        isLive: () => true,
        signalPid: () => undefined,
        boundMs: 40,
      }),
    },
    {
      name: "unconfirmed ownership",
      plan: (fixtureDir) => ({
        fixtureDir,
        direct: [
          {
            label: "owned root",
            child: { pid: 4242, exitCode: 1, signalCode: null, kill: () => true },
            closed: settledClose(),
          },
        ],
        descendantPids: [],
        ownershipConfirmed: false,
        terminateOwnedTree: () => [],
        isLive: () => false,
        signalPid: () => undefined,
        boundMs: 40,
      }),
    },
  ];

  for (const testCase of cases) {
    await withScratchFixtureDir(async (fixtureDir) => {
      const result = await cleanupOwnedFixtures(testCase.plan(fixtureDir));
      assert.equal(result.retainedFixtureDir, fixtureDir, `${testCase.name} must retain the records`);
      assert.ok(result.problems.some((problem) => problem.includes("retained pending confirmed process settlement")),
        `${testCase.name} reports the retained directory: ${result.problems.join("; ")}`);
      assert.equal(await readFile(join(fixtureDir, "root-seen-pid.txt"), "utf8"), "4242",
        `${testCase.name} keeps the ownership record while a fixture may still be running`);
    });
  }
});

test("a failed owned-tree termination is reported and falls back without stranding other fixtures", async () => {
  await withScratchFixtureDir(async (fixtureDir) => {
    const signals: Array<number | string> = [];
    const root = { pid: 4242, exitCode: null, signalCode: null, kill: () => { signals.push("root"); return true; } };
    const unrelated = { pid: 4300, exitCode: null, signalCode: null, kill: () => { signals.push("unrelated"); return true; } };
    const result = await cleanupOwnedFixtures({
      fixtureDir,
      direct: [
        { label: "owned root", child: root, closed: settledClose() },
        { label: "unrelated fixture", child: unrelated, closed: settledClose() },
      ],
      ownedTreeRoot: root,
      descendantPids: [4243],
      ownershipConfirmed: true,
      terminateOwnedTree: (pid) => { signals.push(`tree:${pid}`); return ["owned tree termination reported 128"]; },
      isLive: liveOnce(),
      signalPid: (pid) => { signals.push(pid); },
      boundMs: 200,
    });
    assert.ok(result.problems.some((problem) => problem.includes("owned tree termination reported 128")),
      "the failed tree termination is reported instead of swallowed");
    assert.equal(result.retainedFixtureDir, undefined,
      "confirmed closure still releases the records when the tree step alone failed");
    assert.deepEqual(signals, ["tree:4242", "root", 4243, "root", "unrelated"],
      "the fallback signal plus every remaining fixture step still runs");
  });
});

// ---------------------------------------------------------------------------
// Native Windows production query (win32 only; real processes, no mocks)
// ---------------------------------------------------------------------------

if (process.platform === "win32") {
  const SLEEP_BODY = "setInterval(() => {}, 1000);";

  /** Bounded read of one ownership PID file; absence or junk is not an identity. */
  async function readOwnedPidFile(path: string, timeoutMs = 3_000): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const parsed = parseOwnedPid(await readFile(path, "utf8"));
        if (parsed !== undefined) return parsed;
      } catch {
        if (Date.now() > deadline) return undefined;
      }
      if (Date.now() > deadline) return undefined;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  /** One independently owned real fixture set: root, its direct descendant, and an unrelated process. */
  interface NativeLineageFixture {
    arm: WindowsLineageCausalArm;
    fixtureDir: string;
    rootSeenPidFile: string;
    selfReportedPidFile: string;
    ownedRoot: ChildProcess;
    unrelated: ChildProcess;
    rootClosed: Promise<void>;
    unrelatedClosed: Promise<void>;
    handshake: OwnedPidHandshake;
  }

  async function startNativeLineageFixture(arm: WindowsLineageCausalArm): Promise<NativeLineageFixture> {
    const fixtureDir = await mkdtemp(join(tmpdir(), "prg-lineage-native-"));
    // Two independent ownership channels: the root records the PID it saw, and
    // the descendant reports its own PID as its first action. Teardown uses every
    // validated identity it can find, so a lost stdout frame cannot orphan it.
    const rootSeenPidFile = join(fixtureDir, "root-seen-pid.txt");
    const selfReportedPidFile = join(fixtureDir, "self-reported-pid.txt");
    const descendantBody = [
      "try { require('node:fs').writeFileSync(",
      JSON.stringify(selfReportedPidFile) + ", String(process.pid)); } catch {}",
      SLEEP_BODY,
    ].join("");
    const rootBody = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantBody)}], { stdio: 'ignore', windowsHide: true });`,
      "const pid = child.pid;",
      "if (Number.isSafeInteger(pid) && pid > 0) {",
      `  fs.writeFileSync(${JSON.stringify(rootSeenPidFile)}, String(pid));`,
      "  process.stdout.write('PRG-PID:' + pid + '\\n');",
      "} else {",
      "  process.stdout.write('PRG-ERR:descendant-spawn-failed\\n');",
      "  process.exit(1);",
      "}",
      `setInterval(() => {}, ${120_000});`,
    ].join("");

    const ownedRoot = spawn(process.execPath, ["-e", rootBody], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const unrelated = spawn(process.execPath, ["-e", SLEEP_BODY], { stdio: "ignore", windowsHide: true });
    // Attached before any kill so a fast exit can never be missed, and an error
    // event can never become an unhandled 'error' event. Both waits settle only on
    // their own `close` event: an error is not closure evidence.
    const rootClosed = closeSettled(ownedRoot);
    const unrelatedClosed = closeSettled(unrelated);
    unrelated.on("error", () => undefined);

    const handshake = createOwnedPidHandshake();
    ownedRoot.stdout?.setEncoding("utf8");
    ownedRoot.stdout?.on("data", (chunk: string) => handshake.feed(chunk));
    ownedRoot.on("error", (error) => handshake.fail(`the owned root reported an error: ${error.message}`));
    ownedRoot.once("exit", () => {
      if (!handshake.settled) {
        handshake.fail(`the owned root exited early with ${String(ownedRoot.exitCode ?? ownedRoot.signalCode)}`);
      }
    });
    return { arm, fixtureDir, rootSeenPidFile, selfReportedPidFile, ownedRoot, unrelated, rootClosed, unrelatedClosed, handshake };
  }

  /** The unchanged owned teardown for one fixture set; problems are labelled by arm only. */
  async function teardownNativeLineageFixture(fixture: NativeLineageFixture): Promise<string[]> {
    const ownedPids = new Set<number>();
    if (fixture.handshake.pid !== undefined) ownedPids.add(fixture.handshake.pid);
    for (const path of [fixture.rootSeenPidFile, fixture.selfReportedPidFile]) {
      const recorded = await readOwnedPidFile(path);
      if (recorded !== undefined) ownedPids.add(recorded);
    }
    const { problems } = await cleanupOwnedFixtures({
      fixtureDir: fixture.fixtureDir,
      direct: [
        { label: "owned root", child: fixture.ownedRoot, closed: fixture.rootClosed },
        { label: "unrelated fixture", child: fixture.unrelated, closed: fixture.unrelatedClosed },
      ],
      ownedTreeRoot: fixture.ownedRoot,
      descendantPids: ownedPids,
      ownershipConfirmed: ownedPids.size > 0 || fixture.handshake.reportedAbsent,
    });
    return problems.map((problem) => `[${fixture.arm}] ${problem}`);
  }

  /**
   * Refs #446, first causal phase: ONE fixed two-arm experiment on the real native
   * proof. Each arm gets its own freshly owned root/descendant/unrelated fixture,
   * validated ready before any query starts, and exactly two production
   * verifications (one genuine positive, then one unrelated negative), each with
   * the production executable, arguments, 5s owned deadline, 4KiB bound, one query
   * child, initial identity, fresh snapshot, and final root-liveness check.
   * Version 2: the `child-scoped` arm launches the environment the production
   * producer itself now builds (a copy without `PSModulePath`), forwarded verbatim;
   * the `inherited` arm is the LEGACY CONTROL that overrides that environment with
   * the original parent environment, reproducing the pre-correction query child.
   * Version 1 of this case (before the correction) showed the inherited child
   * binding a `CimCmdlets` outside the native system modules and the cleared child
   * binding the native one, with both arms fast; that is a module-binding
   * counterexample, not the cause of the historical timeout.
   *
   * Both positives are the first real CIM operations of this case. Their first
   * outer `Get-CimInstance` pre-lookup waits for one release token that the gate
   * writes only after both reported that point, inside the unchanged deadline;
   * the negatives run afterwards with the same passive hooks and no gate, even when
   * a positive failed. Every original assertion is kept for the control and also
   * applied to the treatment; the experiment's own validity (gate released, hooks
   * observed, one child each, closure witnessed) is asserted separately, and an
   * invalid experiment is reported as invalid, never as a CIM timeout. Fixed
   * diagnostic lines are printed before any assertion so they survive failure.
   * The experiment changes no production code, deadline, or acceptance rule.
   */
  test("native Windows lineage proof accepts a real descendant and refuses an unrelated PID", async (t) => {
    const fixtures: NativeLineageFixture[] = [];
    const probes: WindowsLineageCausalProbe[] = [];
    const records: WindowsLineageCausalRecord[] = [];
    const failures: unknown[] = [];
    const problems: string[] = [];
    const check = (assertion: () => void): void => {
      try {
        assertion();
      } catch (error) {
        failures.push(error);
      }
    };
    const gate = createWindowsLineageReleaseGate({ parties: WINDOWS_LINEAGE_CAUSAL_ARMS });
    /** Await the exact query child's close; an unwitnessed close is retained as a problem, never assumed. */
    const awaited = new Set<WindowsLineageCausalProbe>();
    const settleQuery = async (probe: WindowsLineageCausalProbe, label: string): Promise<void> => {
      if (awaited.has(probe)) return;
      awaited.add(probe);
      try {
        await bounded(`${label} query close`, probe.whenClosed());
      } catch (error) {
        problems.push(String(error));
      }
    };

    try {
      for (const arm of WINDOWS_LINEAGE_CAUSAL_ARMS) fixtures.push(await startNativeLineageFixture(arm));
      await Promise.all(fixtures.map((fixture) => waitForHandshake(fixture.handshake)));
      // Readiness is validated for BOTH arms before either query is launched.
      for (const fixture of fixtures) {
        if (fixture.handshake.pid === undefined) {
          throw new Error(`experiment invalid (setup): the ${fixture.arm} owned root did not report a validated descendant PID (${
            fixture.handshake.failure ?? "no frame"})`);
        }
        if (fixture.ownedRoot.exitCode !== null || fixture.ownedRoot.signalCode !== null) {
          throw new Error(`experiment invalid (setup): the ${fixture.arm} owned root exited before the proof`);
        }
        if (!fixture.unrelated.pid || fixture.unrelated.exitCode !== null || fixture.unrelated.signalCode !== null) {
          throw new Error(`experiment invalid (setup): the ${fixture.arm} unrelated fixture process is not live`);
        }
      }

      const positiveProbes = fixtures.map((fixture) => createWindowsLineageCausalProbe({
        arm: fixture.arm, role: "positive", gate: "matched", releaseGate: gate,
      }));
      probes.push(...positiveProbes);
      const positives = await Promise.all(fixtures.map((fixture, index) =>
        verifyWindowsProcessLineage(fixture.ownedRoot, fixture.handshake.pid!, { execute: positiveProbes[index]!.execute })));
      gate.dispose();
      for (const [index, probe] of positiveProbes.entries()) await settleQuery(probe, `${fixtures[index]!.arm} positive`);
      t.diagnostic(formatWindowsLineageReleaseGate(gate.record()));
      for (const [index, probe] of positiveProbes.entries()) {
        const record = probe.record(positives[index]!);
        records.push(record);
        t.diagnostic(formatWindowsLineageCausalRecord(record));
      }

      // One unrelated proof per arm, after both positives, whatever they decided.
      const negatives: WindowsLineageVerification[] = [];
      for (const fixture of fixtures) {
        const probe = createWindowsLineageCausalProbe({ arm: fixture.arm, role: "negative", gate: "ungated" });
        probes.push(probe);
        const outsider = await verifyWindowsProcessLineage(fixture.ownedRoot, fixture.unrelated.pid!, { execute: probe.execute });
        await settleQuery(probe, `${fixture.arm} negative`);
        const record = probe.record(outsider);
        records.push(record);
        negatives.push(outsider);
        t.diagnostic(formatWindowsLineageCausalRecord(record));
      }

      const validity = assessWindowsLineageCausalExperiment({ gate: gate.record(), records });
      t.diagnostic(`prg-l446-validity v=${WINDOWS_LINEAGE_CAUSAL_VERSION} valid=${validity.valid} reasons=[${validity.valid ? "" : validity.reasons.join(",")}]`);

      for (const [index, fixture] of fixtures.entries()) {
        check(() => assert.deepEqual(positives[index], { verified: true },
          `the real bounded native query must still prove a genuine descendant (${fixture.arm} arm)`));
        const outsider = negatives[index]!;
        check(() => {
          assert.equal(outsider.verified, false, `a process outside the owned tree never verifies (${fixture.arm} arm)`);
          assert.ok(outsider.verified === false && isWindowsLineageRefusalReason(outsider.reason),
            `the native refusal reports a fixed stage (${fixture.arm} arm)`);
          assert.ok(outsider.verified === false
            && !outsider.reason.startsWith("preflight-")
            && !outsider.reason.startsWith("query-"),
          `an unrelated PID must be refused by the native chain/evidence stages (${fixture.arm} arm), got ${
            outsider.verified === false ? outsider.reason : "accepted"}`);
        });
      }
      check(() => assert.ok(validity.valid,
        `experiment invalid: ${validity.valid ? "" : validity.reasons.join(",")} (an invalid experiment is not CIM evidence)`));
    } catch (error) {
      failures.push(error);
    }

    // Every gate and gated stdin is closed on every path, then every started query
    // child's actual close is awaited before the unchanged owned fixture teardown,
    // which keeps the ownership records whenever settlement stays unconfirmed.
    gate.dispose();
    for (const probe of probes) probe.dispose();
    for (const probe of probes) await settleQuery(probe, "experiment");
    for (const fixture of fixtures) problems.push(...await teardownNativeLineageFixture(fixture));

    const cleanupError = problems.length > 0 ? new Error(`owned fixture cleanup incomplete: ${problems.join("; ")}`) : undefined;
    if (failures.length === 1 && cleanupError === undefined) throw failures[0];
    if (failures.length === 0 && cleanupError !== undefined) throw cleanupError;
    if (failures.length > 0) {
      throw new AggregateError(
        cleanupError === undefined ? failures : [...failures, cleanupError],
        cleanupError === undefined
          ? "native lineage experiment failed"
          : "native lineage experiment failed and its owned cleanup is incomplete",
      );
    }
  });

  // -------------------------------------------------------------------------
  // CONTROLLED CIM/POWERSHELL FLOW TESTS (win32 only) — not real native ancestry proof.
  // The emitted lineage script is executed by a real PowerShell host with only the CIM
  // data source substituted. A PowerShell function shadows the cmdlet of the same name
  // (command precedence: alias > function > cmdlet), so the script text under test is
  // byte-identical to what the production module hands to the real query child while
  // every response is a fixed synthetic row set. That makes the duplicated, ambiguous,
  // and unexpected-response paths deterministically testable, which a mocked executor
  // cannot do: the shipped script's own control flow really runs here. It contacts no
  // CIM, no network, and no real processes, and `-EncodedCommand` is only transport for
  // the same script bytes (no shell quoting), not a different program. The real-CIM
  // proof stays in the native case above.
  // -------------------------------------------------------------------------

  const powershellHost = join(process.env.SystemRoot ?? process.env.WINDIR ?? "",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const MID_PID = 54321;
  const ROOT_TICKS = 1_000;
  const MID_TICKS = 2_000;
  const CANDIDATE_TICKS = 3_000;
  const INITIAL_FILTER = `ProcessId = ${CANDIDATE_PID} OR ProcessId = ${OWNED_ROOT_PID}`;
  const DIRECT_SNAPSHOT_FILTER = INITIAL_FILTER;
  const MID_FILTER = `ProcessId = ${MID_PID}`;
  const MULTI_SNAPSHOT_FILTER = `ProcessId = ${CANDIDATE_PID} OR ProcessId = ${MID_PID} OR ProcessId = ${OWNED_ROOT_PID}`;

  interface StubRow { pid: number; parent: number; ticks: number | null }

  const stubRow = (pid: number, parent: number, ticks: number | null = CANDIDATE_TICKS): StubRow => ({ pid, parent, ticks });
  const CANDIDATE_DIRECT = stubRow(CANDIDATE_PID, OWNED_ROOT_PID);
  const CANDIDATE_VIA_MID = stubRow(CANDIDATE_PID, MID_PID);
  const MID_RECORD = stubRow(MID_PID, OWNED_ROOT_PID, MID_TICKS);
  const ROOT_RECORD = stubRow(OWNED_ROOT_PID, 4, ROOT_TICKS);
  const REUSED_ROOT_RECORD = stubRow(OWNED_ROOT_PID, 4, ROOT_TICKS + 5_000);
  const UNRELATED_RECORD = stubRow(999, 4, ROOT_TICKS);

  function stubRowText(stub: StubRow): string {
    return stub.ticks === null
      ? `(New-PiRowWithoutCreationDate ${stub.pid} ${stub.parent})`
      : `(New-PiRow ${stub.pid} ${stub.parent} ${stub.ticks})`;
  }

  /** Prelude that shadows `Get-CimInstance` with one fixed response per call. */
  function powershellStubPrelude(responses: StubRow[][], logPath: string): string {
    return [
      "$ErrorActionPreference = 'Stop'",
      "function New-PiRow { param([long]$ProcessIdValue, [long]$ParentProcessIdValue, [long]$TicksValue) "
        + "[pscustomobject]@{ ProcessId = $ProcessIdValue; ParentProcessId = $ParentProcessIdValue; "
        + "CreationDate = [DateTime]::new($TicksValue, [DateTimeKind]::Utc) } }",
      "function New-PiRowWithoutCreationDate { param([long]$ProcessIdValue, [long]$ParentProcessIdValue) "
        + "[pscustomobject]@{ ProcessId = $ProcessIdValue; ParentProcessId = $ParentProcessIdValue; CreationDate = $null } }",
      "$global:__piResponses = @{}",
      "$global:__piCall = 0",
      `$global:__piLog = '${logPath.replace(/'/g, "''")}'`,
      "function Get-CimInstance { param([string]$ClassName, [string[]]$Property, [string]$Filter) "
        + "Add-Content -LiteralPath $global:__piLog -Value $Filter; "
        + "$rows = $global:__piResponses[[int]$global:__piCall]; "
        + "$global:__piCall = $global:__piCall + 1; "
        + "if ($null -eq $rows) { return }; foreach ($row in $rows) { $row } }",
      ...responses.map((rows, index) => `$global:__piResponses[${index}] = @(${rows.map(stubRowText).join(", ")})`),
    ].join("\n");
  }

  /** Run the emitted script on the host PowerShell and report stdout, exit, and CIM filters. */
  async function runEmittedLineageScript(
    script: string,
    responses: StubRow[][],
    launch: { env?: NodeJS.ProcessEnv; input?: string } = {},
  ): Promise<{
    stdout: string; stderr: string; status: number | null; filters: string[];
  }> {
    const dir = await mkdtemp(join(tmpdir(), "prg-lineage-pwsh-"));
    try {
      const logPath = join(dir, "cim-filters.txt");
      const command = `${powershellStubPrelude(responses, logPath)}\n${script}`;
      const encoded = Buffer.from(command, "utf16le").toString("base64");
      const result = spawnSync(powershellHost,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
          ...(launch.env === undefined ? {} : { env: launch.env }),
          ...(launch.input === undefined ? {} : { input: launch.input }),
        });
      let filters: string[] = [];
      try {
        filters = (await readFile(logPath, "utf8")).split(/\r?\n/).filter((line) => line.length > 0);
      } catch {
        filters = [];
      }
      return {
        stdout: (result.stdout ?? "").trim(),
        stderr: (result.stderr ?? "").trim(),
        status: result.status,
        filters,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("PowerShell running the emitted script with a stubbed CIM source refuses duplicated, ambiguous, and unexpected initial rows", async () => {
    if (!existsSync(powershellHost)) {
      throw new Error("the win32 suite must be able to locate Windows PowerShell to exercise the emitted script");
    }
    const { script } = await captureLineageScript();
    const cases: Array<{
      name: string; responses: StubRow[][]; accepted: boolean; stage?: string; filters: string[];
    }> = [
      {
        name: "a valid direct chain (two CIM calls, one of them the batched initial lookup)",
        responses: [[CANDIDATE_DIRECT, ROOT_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]],
        accepted: true,
        filters: [INITIAL_FILTER, DIRECT_SNAPSHOT_FILTER],
      },
      {
        name: "a valid two-hop chain, with each intermediate ancestor queried once on its own",
        responses: [[CANDIDATE_VIA_MID, ROOT_RECORD], [MID_RECORD], [CANDIDATE_VIA_MID, MID_RECORD, ROOT_RECORD]],
        accepted: true,
        filters: [INITIAL_FILTER, MID_FILTER, MULTI_SNAPSHOT_FILTER],
      },
      {
        name: "a duplicated candidate row cannot be accepted even when the later snapshot is consistent",
        responses: [[CANDIDATE_DIRECT, CANDIDATE_DIRECT, ROOT_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]],
        accepted: false, stage: "snapshot-count-mismatch", filters: [INITIAL_FILTER],
      },
      {
        name: "a row for a PID that was never requested cannot be accepted",
        responses: [[CANDIDATE_DIRECT, ROOT_RECORD, UNRELATED_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]],
        accepted: false, stage: "snapshot-count-mismatch", filters: [INITIAL_FILTER],
      },
      {
        name: "a duplicated owned-root row is refused once the walk reaches the root",
        responses: [[CANDIDATE_DIRECT, ROOT_RECORD, ROOT_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]],
        accepted: false, stage: "chain-owned-root-record-missing", filters: [INITIAL_FILTER],
      },
      {
        name: "a chain that never reaches the root keeps its own walk stage despite a duplicated owned-root row",
        responses: [[CANDIDATE_VIA_MID, ROOT_RECORD, ROOT_RECORD], []],
        accepted: false, stage: "chain-ancestor-record-missing", filters: [INITIAL_FILTER, MID_FILTER],
      },
      {
        name: "a missing owned-root record is refused at the root-reached branch",
        responses: [[CANDIDATE_DIRECT], [CANDIDATE_DIRECT]],
        accepted: false, stage: "chain-owned-root-record-missing", filters: [INITIAL_FILTER],
      },
      {
        name: "an owned-root PID reused after the initial batch is refused by the fresh snapshot",
        responses: [[CANDIDATE_DIRECT, ROOT_RECORD], [CANDIDATE_DIRECT, REUSED_ROOT_RECORD]],
        accepted: false, stage: "snapshot-creation-mismatch", filters: [INITIAL_FILTER, DIRECT_SNAPSHOT_FILTER],
      },
      {
        name: "an initial owned-root row without a creation date can never be accepted",
        responses: [[CANDIDATE_DIRECT, stubRow(OWNED_ROOT_PID, 4, null)], [CANDIDATE_DIRECT, ROOT_RECORD]],
        accepted: false, stage: "snapshot-creation-mismatch", filters: [INITIAL_FILTER, DIRECT_SNAPSHOT_FILTER],
      },
      {
        name: "the missing-candidate stage stays ahead of every other initial-batch anomaly",
        responses: [[UNRELATED_RECORD]],
        accepted: false, stage: "chain-candidate-record-missing", filters: [INITIAL_FILTER],
      },
      {
        name: "an empty initial response is the original missing-candidate refusal",
        responses: [[]],
        accepted: false, stage: "chain-candidate-record-missing", filters: [INITIAL_FILTER],
      },
    ];

    for (const testCase of cases) {
      const run = await runEmittedLineageScript(script, testCase.responses);
      assert.equal(run.status, 0, `${testCase.name}: the script always exits 0, got ${run.status} / ${run.stderr}`);
      assert.deepEqual(run.filters, testCase.filters, `${testCase.name}: observed CIM filters ${JSON.stringify(run.filters)}`);
      const verdict = classifyWindowsAncestryEvidence(run.stdout, CANDIDATE_PID, OWNED_ROOT_PID);
      if (testCase.accepted) {
        assert.deepEqual(verdict, { verified: true },
          `${testCase.name} must verify, got ${JSON.stringify(verdict)} from ${JSON.stringify(run.stdout)}`);
        continue;
      }
      assert.equal(run.stdout, `PI_REVIEW_GATE_LINEAGE_NO:${testCase.stage}`, testCase.name);
      assert.equal(verdict.verified, false, `${testCase.name} must never be accepted`);
      assert.equal(verdict.verified === false && verdict.reason, testCase.stage, testCase.name);
      assert.ok((WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS as readonly string[]).includes(testCase.stage ?? ""),
        `${testCase.name} refuses on an existing native sentinel stage, not a new one`);
    }
  });

  /**
   * The diagnostics wrapper is only usable as evidence if the instrumented script
   * still decides exactly what the production script decides. Both scripts run on
   * the real PowerShell host against the same stubbed CIM source, and the stdout
   * proof bytes, exit status, and CIM request sequence must be identical, with the
   * new markers visible only on stderr and only where control actually reached.
   * This validates the diagnostic instrument; the native ancestry proof is the
   * separate case above, and nothing here measures real CIM timing.
   */
  test("the instrumented lineage script keeps proof bytes, decisions, and CIM requests identical on the real host", async () => {
    if (!existsSync(powershellHost)) {
      throw new Error("the win32 suite must be able to locate Windows PowerShell to exercise the instrumented script");
    }
    const { script } = await captureLineageScript();
    const outcome = instrumentWindowsLineageScript(script);
    assert.ok(outcome.instrumented, "the production script still carries every fixed marker anchor");
    if (!outcome.instrumented) return;

    const cases: Array<{
      name: string;
      responses: StubRow[][];
      accepted: boolean;
      stage?: string;
      filters: string[];
      phases: readonly string[];
    }> = [
      {
        name: "an accepted direct chain",
        responses: [[CANDIDATE_DIRECT, ROOT_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]],
        accepted: true, filters: [INITIAL_FILTER, DIRECT_SNAPSHOT_FILTER],
        phases: ["script-entry", "initial-query-start", "initial-query-end", "walk-start",
          "snapshot-start", "snapshot-end", "evidence-written"],
      },
      {
        name: "a walk that loses an intermediate ancestor",
        responses: [[CANDIDATE_VIA_MID, ROOT_RECORD, ROOT_RECORD], []],
        accepted: false, stage: "chain-ancestor-record-missing", filters: [INITIAL_FILTER, MID_FILTER],
        phases: ["script-entry", "initial-query-start", "initial-query-end", "walk-start", "ancestor-lookup"],
      },
    ];
    for (const testCase of cases) {
      const baseline = await runEmittedLineageScript(script, testCase.responses);
      const instrumented = await runEmittedLineageScript(outcome.script, testCase.responses);
      assert.equal(instrumented.stdout, baseline.stdout, `${testCase.name}: stdout proof bytes are unchanged`);
      assert.equal(instrumented.status, baseline.status, `${testCase.name}: the exit status is unchanged`);
      assert.deepEqual(instrumented.filters, testCase.filters, `${testCase.name}: the CIM requests are unchanged`);
      const verdict = classifyWindowsAncestryEvidence(instrumented.stdout, CANDIDATE_PID, OWNED_ROOT_PID);
      if (testCase.accepted) {
        assert.deepEqual(verdict, { verified: true }, `${testCase.name} still verifies`);
      } else {
        assert.equal(instrumented.stdout, `PI_REVIEW_GATE_LINEAGE_NO:${testCase.stage}`, testCase.name);
        assert.equal(verdict.verified === false && verdict.reason, testCase.stage,
          `${testCase.name} still refuses on the same native stage`);
      }
      const observed = WINDOWS_LINEAGE_PHASES.filter((phase) => instrumented.stderr.includes(`PRG-LINEAGE-PHASE:${phase}`));
      assert.deepEqual(observed, testCase.phases, `${testCase.name}: markers follow the control flow actually taken`);
      assert.ok(occurrences(instrumented.stderr, "PRG-LINEAGE-PHASE:") <= 12,
        `${testCase.name}: stderr markers stay bounded`);
    }
  });

  /**
   * Refs #446 instrument validation on the REAL installed Windows PowerShell 5.1,
   * before any native causal reading is trusted. The causal-instrumented script and
   * the production script run against the same stubbed CIM source (no CIM contact,
   * no warmup): stdout proof bytes, exit status, and the CIM request sequence must
   * be identical in every gate mode, including a missing or wrong release token. The
   * passive hooks must actually fire on this engine and bracket the target lookup in
   * child-clock order; the stub is a function, so the resolved command must classify
   * as `other`, never as the native cmdlet. Hook support is therefore demonstrated
   * here on the native host, not assumed from documentation of a newer engine.
   */
  test("the causal hook instrument fires on the real host without changing proof bytes, decisions, or CIM requests", async () => {
    if (!existsSync(powershellHost)) {
      throw new Error("the win32 suite must be able to locate Windows PowerShell to validate the causal instrument");
    }
    const { script } = await captureLineageScript();
    const cases: Array<{ name: string; responses: StubRow[][]; filters: string[]; snapshot: boolean }> = [
      {
        name: "an accepted direct chain",
        responses: [[CANDIDATE_DIRECT, ROOT_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]],
        filters: [INITIAL_FILTER, DIRECT_SNAPSHOT_FILTER],
        snapshot: true,
      },
      {
        name: "a walk that loses an intermediate ancestor",
        responses: [[CANDIDATE_VIA_MID, ROOT_RECORD, ROOT_RECORD], []],
        filters: [INITIAL_FILTER, MID_FILTER],
        snapshot: false,
      },
    ];
    const modes: Array<{ gate: "matched" | "ungated"; input?: string; ack: string }> = [
      { gate: "matched", input: "G\n", ack: "ok" },
      { gate: "matched", input: "", ack: "invalid" },
      { gate: "matched", input: "X\n", ack: "invalid" },
      { gate: "ungated", ack: "ungated" },
    ];
    for (const testCase of cases) {
      const baseline = await runEmittedLineageScript(script, testCase.responses);
      for (const mode of modes) {
        const label = `${testCase.name} / ${mode.gate} / ${JSON.stringify(mode.input ?? null)}`;
        const outcome = instrumentWindowsLineageCausalScript(script, mode.gate);
        assert.ok(outcome.instrumented, `${label}: the production script carries every causal anchor`);
        if (!outcome.instrumented) return;
        const run = await runEmittedLineageScript(outcome.script, testCase.responses, { input: mode.input ?? "" });
        assert.equal(run.stdout, baseline.stdout, `${label}: stdout proof bytes are unchanged`);
        assert.equal(run.status, baseline.status, `${label}: the exit status is unchanged`);
        assert.deepEqual(run.filters, testCase.filters, `${label}: the CIM requests are unchanged`);

        const ledger = createWindowsLineageCausalLedger();
        ledger.scan(`${run.stderr}\n`, 0);
        ledger.finish();
        assert.equal(assessWindowsLineageCausalLedger(ledger, mode.gate), "ok",
          `${label}: the hooks fired and bracketed the lookup coherently (malformed=${ledger.malformed}, duplicates=${ledger.duplicates})`);
        assert.equal(ledger.events.get("lookup-released")?.token, mode.ack, `${label}: the release acknowledgement is exact`);
        assert.equal(ledger.events.get("lookup-complete")?.token, "other",
          `${label}: the stubbed function resolves as other, never as the native cmdlet`);
        assert.equal(ledger.events.get("initial-query-end")?.token, "1-1-0",
          `${label}: one outer pre-lookup and one post-lookup preceded the initial request's end`);
        assert.equal(ledger.events.has("snapshot-start") && ledger.events.has("snapshot-end"), testCase.snapshot,
          `${label}: snapshot frames follow the control flow actually taken`);
        assert.ok(Buffer.byteLength(run.stderr) < MAX_QUERY_OUTPUT_BYTES / 4, `${label}: added stderr stays far below the stream bound`);
      }
    }
  });

  /**
   * The correction's only lever, checked on the real host with synthetic values
   * and the ACTUAL producer environment: with a PowerShell 7-style module location
   * in this process's `PSModulePath`, the legacy inherited environment shows that
   * location to the child as a closed category, while the environment production
   * itself built for its query child (captured from the producer, not re-derived
   * here) carries no inherited `PSModulePath` key, so Windows PowerShell rebuilds a
   * path that contains its native module location. The rebuilt path may also hold
   * user- or machine-scope entries (Microsoft documents that the rebuild can include
   * a user-scope `PSModulePath`, which may legitimately name PowerShell 7 locations),
   * so the absence of every PowerShell 7 location is NOT asserted, and the native
   * location is not claimed to be the only entry. Stubbed CIM again; no module
   * directory is inspected.
   */
  test("the producer's query environment lets the real host rebuild its own module path", async () => {
    if (!existsSync(powershellHost)) {
      throw new Error("the win32 suite must be able to locate Windows PowerShell to validate the environment correction");
    }
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
    const scratch = await mkdtemp(join(tmpdir(), "prg-l446-psmp-"));
    try {
      const syntheticModulePath = [
        join(scratch, "PowerShell", "7", "Modules"),
        join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      ].join(";");
      // Windows environment names are case-insensitive, so this replaces the one
      // existing PSModulePath entry for the duration of the capture only. The real
      // SystemRoot stays in effect, so the producer's copy differs from the legacy
      // environment only by the correction itself.
      const captured = await withProcessEnv({ PSModulePath: syntheticModulePath }, async () => {
        const legacy: NodeJS.ProcessEnv = { ...process.env };
        const query = fakeQuery({ kind: "output", output: VALID_EVIDENCE });
        const parentUnchanged = processEnvSnapshot();
        const result = await verifyWithMockedQuery(query);
        const call = query.calls[0]!;
        return {
          result, calls: query.calls.length, script: call.args[4]!, legacy, producer: call.options.env,
          parentUnchanged: parentUnchanged(),
          legacyModulePathKeys: countModulePathKeys(legacy),
          producerModulePathKeys: countModulePathKeys(call.options.env),
          producerShape: queryOptionsShape(call.options),
          difference: queryEnvironmentDifference(call.options.env, process.env),
          expected: expectedEnvironmentDifference(process.env),
        };
      });
      assert.deepEqual(captured.result, { verified: true });
      assert.equal(captured.calls, 1, "one producer call, no retry");
      assert.deepEqual(captured.producerShape, PRODUCTION_OPTIONS_SHAPE, "the producer supplied its own environment copy");
      assert.deepEqual(captured.difference, captured.expected,
        "on the real host the producer's copy keeps every other key and value and drops only PSModulePath");
      assert.deepEqual(captured.parentUnchanged, { sameKeys: true, sameValues: true }, "the producer never modifies this process's environment");
      assert.equal(captured.legacyModulePathKeys, 1, "the legacy control still inherits the PSModulePath key");
      assert.equal(captured.producerModulePathKeys, 0, "the producer's child environment carries no inherited PSModulePath key");
      const outcome = instrumentWindowsLineageCausalScript(captured.script, "ungated");
      assert.ok(outcome.instrumented);
      if (!outcome.instrumented) return;
      const responses = [[CANDIDATE_DIRECT, ROOT_RECORD], [CANDIDATE_DIRECT, ROOT_RECORD]];
      const runs = {
        legacy: await runEmittedLineageScript(outcome.script, responses, { env: captured.legacy }),
        producer: await runEmittedLineageScript(outcome.script, responses, { env: captured.producer }),
      };
      const bits: Record<string, string | undefined> = {};
      for (const [arm, run] of Object.entries(runs)) {
        const verdict = classifyWindowsAncestryEvidence(run.stdout, CANDIDATE_PID, OWNED_ROOT_PID);
        assert.deepEqual(verdict, { verified: true }, `${arm}: the stubbed proof is unchanged by the environment`);
        const ledger = createWindowsLineageCausalLedger();
        ledger.scan(`${run.stderr}\n`, 0);
        ledger.finish();
        assert.equal(assessWindowsLineageCausalLedger(ledger, "ungated"), "ok", `${arm}: the instrument is coherent`);
        bits[arm] = ledger.events.get("psmp")?.token;
      }
      assert.equal(bits.legacy?.[1], "1", `an inherited PowerShell 7 location is visible to the legacy child: ${bits.legacy}`);
      assert.equal(bits.producer?.[0], "1", `the removed variable is rebuilt by the child: ${bits.producer}`);
      assert.equal(bits.producer?.[2], "1", `the rebuilt path has the native module location: ${bits.producer}`);
      assert.equal(runs.producer.stdout, runs.legacy.stdout, "the proof bytes are identical under both environments");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
