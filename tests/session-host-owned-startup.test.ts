/**
 * Pre-main owned-activity bootstrap contract (issue #323).
 *
 * SYNTHETIC CONTRACT — NOT native restore/kernel proof. These tests spawn a
 * real Node process whose NODE_OPTIONS prepends `--require=<compiled
 * bootstrap-preload.js>` (the same early form the production launcher stages),
 * followed by a synthetic "user fixture" that runs before main, followed by
 * the caller's own NODE_OPTIONS verbatim. They prove only the ordering/
 * initialization contract of the compiled preload and the pure in-memory
 * owned-activity registry: a valid consumed capability-bearing bootstrap opts the
 * process into owned-activity observation BEFORE the fixture's source
 * registrations, and invalid/absent/foreign/executor inputs stay inert. No
 * reporter transport, socket, native session, hook, worker, child job, or
 * kernel restore is exercised; a real `--require` user fixture is the sole
 * stand-in for extension module evaluation.
 *
 * The "execution" and "background-shell" sources in the positive child are
 * synthetic logical registrations; the "review" source is the real public
 * module (src/activation/review-activity.ts) but is still an in-memory fixture,
 * not a live automatic review. Counts are bounded booleans/numbers only; the
 * child never prints or persists the bootstrap token, socket path, or any
 * environment contents.
 *
 * Fixtures are created with exclusive `wx` writes under ONE unique confined
 * temporary root: four immutable shared sources plus per-case result/order
 * files, bounded in aggregate count and bytes before every write, and
 * deliberately RETAINED on success and failure (no recursive teardown).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NODE_OPTIONS_RESTORE_ENV, SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { OWNED_ACTIVITY_STATE_KEY } from "../src/session-host/owned-activity";
import { SESSION_HOST_STICKY_STATE_KEY } from "../src/session-host/reporter";

/** Compiled siblings of this test under dist-test (never imported into this process). */
const PRELOAD_PATH = join(__dirname, "..", "src", "session-host", "bootstrap-preload.js");
const OWNED_ACTIVITY_PATH = join(__dirname, "..", "src", "session-host", "owned-activity.js");
const REVIEW_ACTIVITY_PATH = join(__dirname, "..", "src", "activation", "review-activity.js");

/**
 * The caller's own NODE_OPTIONS, captured verbatim once before any fixture
 * exists. It is never deleted, never replaced, and never printed: it is
 * appended after the synthetic fixture require so caller preloads,
 * instrumentation, and safety configuration survive into every child and the
 * restoration frame, exactly as a user fixture would under the real launcher.
 */
const CALLER_NODE_OPTIONS: string | null = process.env.NODE_OPTIONS ?? null;

/** Aggregate retained-fixture bounds across this whole test file. */
const MAX_FIXTURE_FILES = 32;
const MAX_FIXTURE_TOTAL_BYTES = 256 * 1024;
/** One fixture source stays far below the 32 KiB per-file bound. */
const MAX_FIXTURE_BYTES = 32 * 1024;
/** Reserved budget for one child-written result/order pair. */
const MAX_CASE_OUTPUT_BYTES = 8 * 1024;
/** Child stdout/stderr is never parsed; the bounded result file is. */
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const CHILD_TIMEOUT_MS = 10_000;

/**
 * The second `--require` fixture: it runs after the prepended preload and
 * before main, records its ordering/env/observation view, and (for the
 * positive case) exercises the real review source and synthetic execution/
 * shell handles. It emits bounded booleans and counts only. The expected
 * post-restore NODE_OPTIONS (FIXTURE_EXPECTED_NODE_OPTIONS) is the full
 * original: the synthetic fixture require plus the caller's options.
 */
const BEFORE_MAIN_SOURCE = `"use strict";
const fs = require("node:fs");
const owned = require(process.env.FIXTURE_OWNED_ACTIVITY_PATH);
const review = require(process.env.FIXTURE_REVIEW_ACTIVITY_PATH);
const ownedKey = Symbol.for(process.env.FIXTURE_OWNED_ACTIVITY_KEY);
const stickyKey = Symbol.for(process.env.FIXTURE_STICKY_KEY);
function readGlobal(key) {
  try { return { value: globalThis[key], threw: false }; }
  catch { return { value: undefined, threw: true }; }
}
const registry = readGlobal(ownedKey);
const sticky = readGlobal(stickyKey);
const result = {
  ownedActive: owned.isOwnedActivityActive(),
  bootstrapConsumed: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP === undefined,
  restoreConsumed: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE === undefined,
  originalOptionsRestored: (process.env.NODE_OPTIONS ?? null) === (process.env.FIXTURE_EXPECTED_NODE_OPTIONS ?? null),
  roleIsExecutor: process.env.PI_REVIEW_GATE_RUNTIME_ROLE === "executor",
  stickyInstanceMatches: sticky.value && typeof sticky.value === "object" && sticky.value.bootstrap
    ? sticky.value.bootstrap.instanceId === process.env.FIXTURE_EXPECTED_INSTANCE_ID
    : false,
  foreignRegistryPreserved: registry.value && typeof registry.value === "object"
    ? registry.value.foreignSentinel === process.env.FIXTURE_FOREIGN_SENTINEL
    : false,
  registryReadThrew: registry.threw === true,
  snapshotInitial: owned.ownedActivitySnapshot(),
};
fs.writeFileSync(process.env.FIXTURE_ORDER_PATH, "fixture\\n", { encoding: "utf8", flag: "wx" });
if (process.env.FIXTURE_EXERCISE === "1" && result.ownedActive) {
  const before = owned.ownedActivitySnapshot();
  review.registerReviewActivitySource();
  const afterReview = owned.ownedActivitySnapshot();
  const execution = owned.registerOwnedActivitySource("backgroundTasks", "execution", { uncertain: true });
  const afterExecution = owned.ownedActivitySnapshot();
  execution.resolveUncertainty();
  const afterExecutionResolved = owned.ownedActivitySnapshot();
  const shell = owned.registerOwnedActivitySource("backgroundShells", "background-shell");
  const afterAllSources = owned.ownedActivitySnapshot();
  const reviewToken = review.beginOwnedReviewActivity();
  shell.acquire("synthetic-shell-ownership-token");
  const afterTokens = owned.ownedActivitySnapshot();
  review.endOwnedReviewActivity(reviewToken);
  shell.release("synthetic-shell-ownership-token");
  const afterRelease = owned.ownedActivitySnapshot();
  result.exercise = { before, afterReview, afterExecution, afterExecutionResolved, afterAllSources, afterTokens, afterRelease };
}
fs.writeFileSync(process.env.FIXTURE_RESULT_PATH, JSON.stringify(result), { encoding: "utf8", flag: "wx" });
`;

/** Trivial main: it must run strictly after the fixture require above. */
const MAIN_SOURCE = `"use strict";
const fs = require("node:fs");
fs.appendFileSync(process.env.FIXTURE_ORDER_PATH, "main\\n");
`;

/**
 * Pre-preload fixture: installs a foreign/corrupt process-local state BEFORE
 * the bootstrap preload runs, so the preload's refusal (never overwrite,
 * never attach) can be observed by the later fixture.
 */
const FOREIGN_STATE_SOURCE = `"use strict";
const ownedKey = Symbol.for(process.env.FIXTURE_OWNED_ACTIVITY_KEY);
const stickyKey = Symbol.for(process.env.FIXTURE_STICKY_KEY);
const kind = process.env.FIXTURE_FOREIGN_KIND;
if (kind === "registry") {
  globalThis[ownedKey] = { foreignSentinel: "foreign-registry-state", active: false, sources: null, listeners: null };
} else if (kind === "getter") {
  Object.defineProperty(globalThis, ownedKey, {
    configurable: true,
    enumerable: false,
    get() { throw new Error("foreign owned-activity getter"); },
  });
} else if (kind === "sticky") {
  globalThis[stickyKey] = { bootstrap: JSON.parse(process.env.FIXTURE_FOREIGN_BOOTSTRAP), sequence: 7, sessionEpoch: 3 };
}
`;

/**
 * Fallback-path main: registers every expected source BEFORE the preload is
 * loaded, then requires the preload so a valid bootstrap primes and activates.
 * It demonstrates that pre-opt-in registrations replay as uncertain (no
 * blanket zero) and are only cleared by their own authoritative handles, and
 * that registry reactivation never clears retained ownership.
 */
const FALLBACK_MAIN_SOURCE = `"use strict";
const fs = require("node:fs");
const owned = require(process.env.FIXTURE_OWNED_ACTIVITY_PATH);
const reviewHandle = owned.registerOwnedActivitySource("backgroundTasks", "review");
const executionHandle = owned.registerOwnedActivitySource("backgroundTasks", "execution");
const shellHandle = owned.registerOwnedActivitySource("backgroundShells", "background-shell");
const before = owned.ownedActivitySnapshot();
require(process.env.FIXTURE_PRELOAD_PATH);
const activeAfterPreload = owned.isOwnedActivityActive();
const afterActivation = owned.ownedActivitySnapshot();
executionHandle.resolveUncertainty();
const afterExecutionResolved = owned.ownedActivitySnapshot();
reviewHandle.resolveUncertainty();
shellHandle.resolveUncertainty();
const afterResolved = owned.ownedActivitySnapshot();
executionHandle.acquire("retained-pre-existing-token");
owned.activateOwnedActivity();
const afterReactivation = owned.ownedActivitySnapshot();
executionHandle.release("retained-pre-existing-token");
const afterRetainedRelease = owned.ownedActivitySnapshot();
fs.writeFileSync(process.env.FIXTURE_RESULT_PATH, JSON.stringify({
  before,
  activeAfterPreload,
  afterActivation,
  afterExecutionResolved,
  afterResolved,
  afterReactivation,
  afterRetainedRelease,
}), { encoding: "utf8", flag: "wx" });
`;

interface OwnedCounts {
  backgroundTasks: number | null;
  backgroundShells: number | null;
}

interface ContractResult {
  ownedActive: boolean;
  bootstrapConsumed: boolean;
  restoreConsumed: boolean;
  originalOptionsRestored: boolean;
  roleIsExecutor: boolean;
  stickyInstanceMatches: boolean;
  foreignRegistryPreserved: boolean;
  registryReadThrew: boolean;
  snapshotInitial: OwnedCounts;
  exercise?: {
    before: OwnedCounts;
    afterReview: OwnedCounts;
    afterExecution: OwnedCounts;
    afterExecutionResolved: OwnedCounts;
    afterAllSources: OwnedCounts;
    afterTokens: OwnedCounts;
    afterRelease: OwnedCounts;
  };
}

interface FallbackResult {
  before: OwnedCounts;
  activeAfterPreload: boolean;
  afterActivation: OwnedCounts;
  afterExecutionResolved: OwnedCounts;
  afterResolved: OwnedCounts;
  afterReactivation: OwnedCounts;
  afterRetainedRelease: OwnedCounts;
}

interface CaseFixtures {
  readonly root: string;
  readonly beforeMain: string;
  readonly main: string;
  readonly foreignState: string;
  readonly fallbackMain: string;
  readonly result: string;
  readonly order: string;
}

interface RunConfig {
  readonly fixtures: CaseFixtures;
  readonly main?: string;
  readonly nodeOptions?: string;
  readonly expectedNodeOptions?: string;
  readonly bootstrap?: string;
  readonly restoreFrame?: string;
  readonly runtimeRole?: string;
  readonly foreignKind?: string;
  readonly foreignBootstrap?: string;
  readonly expectedInstanceId?: string;
  readonly foreignSentinel?: string;
  readonly exercise?: boolean;
}

const NULL_COUNTS: OwnedCounts = { backgroundTasks: null, backgroundShells: null };

/**
 * The parent test process must not itself be running inside a delegating role
 * or executor catalog: a synthetic standalone contract there would be a role
 * context this suite cannot authorize. Inspect every environment key name
 * case-insensitively so a spelling alias cannot slip past, and refuse loudly
 * rather than skip — before any fixture mutation. Caller role configuration is
 * never modified or deleted; only the explicit executor test input is injected
 * afterwards, for one child, on the copied child environment.
 */
function assertCallerRoleClear(): void {
  const offending = Object.keys(process.env).filter((name) => {
    const canonical = name.toUpperCase();
    return canonical === "PI_REVIEW_GATE_RUNTIME_ROLE" || canonical === "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG";
  });
  assert.deepEqual(
    offending,
    [],
    "this synthetic owned-startup contract must run outside any delegating runtime role or executor catalog, including case aliases, and is never silently skipped",
  );
}

let sharedFixtureRoot: string | undefined;
let retainedFixtureFiles = 0;
let retainedFixtureBytes = 0;

/** Enforce the aggregate retained-fixture budget before every write/reservation. */
function reserveFixtureBudget(count: number, bytes: number): void {
  assert.ok(
    retainedFixtureFiles + count <= MAX_FIXTURE_FILES,
    `retained fixture file count stays within the ${MAX_FIXTURE_FILES}-file bound`,
  );
  assert.ok(
    retainedFixtureBytes + bytes <= MAX_FIXTURE_TOTAL_BYTES,
    `retained fixture bytes stay within the ${MAX_FIXTURE_TOTAL_BYTES}-byte bound`,
  );
  retainedFixtureFiles += count;
  retainedFixtureBytes += bytes;
}

function writeSharedFixture(name: string, content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  assert.ok(bytes <= MAX_FIXTURE_BYTES, "fixture source stays within the 32 KiB per-file bound");
  reserveFixtureBudget(1, bytes);
  writeFileSync(join(sharedFixtureRoot!, name), content, { encoding: "utf8", flag: "wx" });
}

/**
 * The single shared immutable fixture root, created lazily only after the
 * caller role/catalog guard has passed. Four sources are written exactly once;
 * every case gets only exclusive per-case result/order paths.
 */
function fixtureRoot(): string {
  assertCallerRoleClear();
  if (sharedFixtureRoot === undefined) {
    sharedFixtureRoot = mkdtempSync(join(tmpdir(), "prg-owned-startup-"));
    writeSharedFixture("before-main.js", BEFORE_MAIN_SOURCE);
    writeSharedFixture("main.js", MAIN_SOURCE);
    writeSharedFixture("foreign-state.js", FOREIGN_STATE_SOURCE);
    writeSharedFixture("fallback-main.js", FALLBACK_MAIN_SOURCE);
  }
  return sharedFixtureRoot;
}

function makeCaseFixtures(caseId: string, withOrder: boolean): CaseFixtures {
  const root = fixtureRoot();
  reserveFixtureBudget(withOrder ? 2 : 1, MAX_CASE_OUTPUT_BYTES);
  return {
    root,
    beforeMain: join(root, "before-main.js"),
    main: join(root, "main.js"),
    foreignState: join(root, "foreign-state.js"),
    fallbackMain: join(root, "fallback-main.js"),
    result: join(root, `result-${caseId}.json`),
    order: join(root, `order-${caseId}.log`),
  };
}

function makeBootstrap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    socketPath: "/tmp/prg-owned-startup.sock",
    token: randomBytes(32).toString("hex"),
    instanceId: randomUUID(),
    generation: randomUUID(),
    ...overrides,
  };
}

/** Node's quoted NODE_OPTIONS grammar: forward slashes and escaped quotes only. */
function nodeRequireClause(pathname: string): string {
  const portable = pathname.replace(/\\/g, "/");
  return `--require="${portable.replace(/"/g, '\\"')}"`;
}

/**
 * Compose the child NODE_OPTIONS exactly like the launcher: the preload require
 * is prepended, the synthetic user fixture follows, and the caller's original
 * NODE_OPTIONS is appended verbatim. The restoration frame's `original` is the
 * full original (fixture + caller options) — never the caller's value alone,
 * never a replacement for it.
 */
function preloadedNodeOptions(fixtures: CaseFixtures, foreign = false): { nodeOptions: string; userOptions: string } {
  const fixtureRequire = nodeRequireClause(fixtures.beforeMain);
  const userOptions = CALLER_NODE_OPTIONS === null ? fixtureRequire : `${fixtureRequire} ${CALLER_NODE_OPTIONS}`;
  const preload = nodeRequireClause(PRELOAD_PATH);
  const foreignClause = foreign ? `${nodeRequireClause(fixtures.foreignState)} ` : "";
  return { userOptions, nodeOptions: `${foreignClause}${preload} ${userOptions}` };
}

/**
 * Spawn one bounded, inert child fixture. The child inherits the caller's
 * confined HOME/TEMP/cache environment and NODE_OPTIONS verbatim (unless this
 * case composes a NODE_OPTIONS chain that embeds it); no environment contents
 * are ever printed. Errors surface only as bounded booleans/counts in a
 * result file.
 */
function runChild(config: RunConfig): unknown {
  assertCallerRoleClear();
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv[SESSION_HOST_BOOTSTRAP_ENV];
  delete childEnv[NODE_OPTIONS_RESTORE_ENV];
  // The caller's NODE_OPTIONS is preserved: a composed chain already embeds it,
  // and a case that composes none inherits it unchanged from the copy above.
  if (config.nodeOptions !== undefined) childEnv.NODE_OPTIONS = config.nodeOptions;
  if (config.bootstrap !== undefined) childEnv[SESSION_HOST_BOOTSTRAP_ENV] = config.bootstrap;
  if (config.restoreFrame !== undefined) childEnv[NODE_OPTIONS_RESTORE_ENV] = config.restoreFrame;
  // Explicit executor input is a test input, injected only after the guard.
  if (config.runtimeRole !== undefined) childEnv.PI_REVIEW_GATE_RUNTIME_ROLE = config.runtimeRole;
  if (config.foreignKind !== undefined) childEnv.FIXTURE_FOREIGN_KIND = config.foreignKind;
  if (config.foreignBootstrap !== undefined) childEnv.FIXTURE_FOREIGN_BOOTSTRAP = config.foreignBootstrap;
  if (config.expectedInstanceId !== undefined) childEnv.FIXTURE_EXPECTED_INSTANCE_ID = config.expectedInstanceId;
  if (config.foreignSentinel !== undefined) childEnv.FIXTURE_FOREIGN_SENTINEL = config.foreignSentinel;
  childEnv.FIXTURE_OWNED_ACTIVITY_PATH = OWNED_ACTIVITY_PATH;
  childEnv.FIXTURE_REVIEW_ACTIVITY_PATH = REVIEW_ACTIVITY_PATH;
  childEnv.FIXTURE_OWNED_ACTIVITY_KEY = String(OWNED_ACTIVITY_STATE_KEY.description);
  childEnv.FIXTURE_STICKY_KEY = String(SESSION_HOST_STICKY_STATE_KEY.description);
  childEnv.FIXTURE_PRELOAD_PATH = PRELOAD_PATH;
  childEnv.FIXTURE_RESULT_PATH = config.fixtures.result;
  childEnv.FIXTURE_ORDER_PATH = config.fixtures.order;
  childEnv.FIXTURE_EXERCISE = config.exercise === true ? "1" : "0";
  childEnv.FIXTURE_EXPECTED_NODE_OPTIONS = config.expectedNodeOptions;

  const outcome = spawnSync(process.execPath, [config.main ?? config.fixtures.main], {
    env: childEnv,
    cwd: config.fixtures.root,
    shell: false,
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(outcome.error, undefined, "child fixture spawned and completed within bounds");
  assert.equal(outcome.signal, null, "child fixture was not terminated by signal or timeout");
  assert.equal(outcome.status, 0, "child fixture exited cleanly");
  const raw = readFileSync(config.fixtures.result, "utf8");
  assert.ok(raw.length > 0 && Buffer.byteLength(raw, "utf8") <= MAX_CHILD_OUTPUT_BYTES, "child result is bounded");
  return JSON.parse(raw) as unknown;
}

function readOrder(fixtures: CaseFixtures): string[] {
  return readFileSync(fixtures.order, "utf8").split("\n").filter((line) => line.length > 0);
}

function retained(t: { diagnostic: (message: string) => void }): void {
  t.diagnostic("retained synthetic fixtures under the confined temporary root; no cleanup performed");
}

/** The composed chain and restoration frame must carry the caller's options verbatim. */
function assertCallerOptionsPreserved(nodeOptions: string, userOptions: string): void {
  if (CALLER_NODE_OPTIONS === null) return; // Nothing caller-owned to preserve.
  assert.ok(nodeOptions.endsWith(CALLER_NODE_OPTIONS), "the child chain preserves the caller's original NODE_OPTIONS verbatim");
  assert.ok(userOptions.endsWith(CALLER_NODE_OPTIONS), "the restoration frame preserves the caller's original NODE_OPTIONS verbatim");
}

test("a valid managed bootstrap activates pre-main owned-activity observation before source registration", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("activate", true);
  const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures);
  assertCallerOptionsPreserved(nodeOptions, userOptions);
  const bootstrap = makeBootstrap();
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: userOptions,
    bootstrap: JSON.stringify(bootstrap),
    restoreFrame: JSON.stringify({ original: userOptions }),
    exercise: true,
    expectedInstanceId: String(bootstrap.instanceId),
  }) as ContractResult;

  assert.equal(result.ownedActive, true, "the valid consumed bootstrap opts into observation before the fixture loads");
  assert.equal(result.bootstrapConsumed, true, "bootstrap env is consumed before the fixture loads");
  assert.equal(result.restoreConsumed, true, "one-shot restore frame is consumed before the fixture loads");
  assert.equal(result.originalOptionsRestored, true, "the full original NODE_OPTIONS (fixture + caller options) is restored byte-exact");
  assert.equal(result.stickyInstanceMatches, true, "the native instance identity is primed pre-main");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "activation alone registers no source and claims no zero");
  assert.deepEqual(readOrder(fixtures), ["fixture", "main"], "the preload-staged fixture runs strictly before main");

  const exercise = result.exercise!;
  assert.deepEqual(exercise.before, NULL_COUNTS, "fresh registry starts unknown");
  assert.deepEqual(exercise.afterReview, NULL_COUNTS, "one source is not completeness");
  assert.deepEqual(exercise.afterExecution, NULL_COUNTS, "an uncertain execution source never yields zero");
  assert.deepEqual(exercise.afterExecutionResolved, { backgroundTasks: 0, backgroundShells: null },
    "task sources accounted but the shell source still missing: shells stay unknown");
  assert.deepEqual(exercise.afterAllSources, { backgroundTasks: 0, backgroundShells: 0 },
    "fresh accounted sources may honestly report zero");
  assert.deepEqual(exercise.afterTokens, { backgroundTasks: 1, backgroundShells: 1 },
    "real review and synthetic shell ownership tokens are positive");
  assert.deepEqual(exercise.afterRelease, { backgroundTasks: 0, backgroundShells: 0 },
    "only actual settlement releases a token back to zero");
});

test("an absent bootstrap leaves the preloaded process inert with unchanged options", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("absent", true);
  const { nodeOptions } = preloadedNodeOptions(fixtures);
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: nodeOptions,
    exercise: true,
  }) as ContractResult;

  assert.equal(result.ownedActive, false, "no bootstrap: owned-activity observation stays inert");
  assert.equal(result.restoreConsumed, true, "no frame was present to consume");
  assert.equal(result.originalOptionsRestored, true, "without a frame the preload leaves NODE_OPTIONS untouched, caller options included");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "inert registry never reports a count");
  assert.equal(result.exercise, undefined, "an inert registry never runs the source exercise");
});

test("malformed, oversized, and invalid-capability bootstraps never activate observation", (t) => {
  assertCallerRoleClear();
  retained(t);
  const variants: ReadonlyArray<{ name: string; raw: string }> = [
    { name: "invalid JSON", raw: "{ not json" },
    { name: "oversized raw env", raw: JSON.stringify({ ...makeBootstrap(), filler: "a".repeat(20_000) }) },
    { name: "non-canonical socket", raw: JSON.stringify(makeBootstrap({ socketPath: "relative.sock" })) },
    { name: "malformed token", raw: JSON.stringify(makeBootstrap({ token: "deadbeef" })) },
  ];
  for (const [index, variant] of variants.entries()) {
    const fixtures = makeCaseFixtures(`invalid-${index}`, true);
    const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures);
    assertCallerOptionsPreserved(nodeOptions, userOptions);
    const result = runChild({
      fixtures,
      nodeOptions,
      expectedNodeOptions: userOptions,
      bootstrap: variant.raw,
      restoreFrame: JSON.stringify({ original: userOptions }),
      exercise: true,
    }) as ContractResult;
    assert.equal(result.ownedActive, false, `${variant.name}: observation stays inert`);
    assert.equal(result.bootstrapConsumed, true, `${variant.name}: the invalid env is still consumed`);
    assert.equal(result.originalOptionsRestored, true, `${variant.name}: the full original options are still restored`);
    assert.deepEqual(result.snapshotInitial, NULL_COUNTS, `${variant.name}: no count is fabricated`);
    assert.equal(result.exercise, undefined, `${variant.name}: no source exercise runs`);
  }
});

test("a restore frame alone restores the environment but never activates observation", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("restore-only", true);
  const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures);
  assertCallerOptionsPreserved(nodeOptions, userOptions);
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: userOptions,
    restoreFrame: JSON.stringify({ original: userOptions }),
    exercise: true,
  }) as ContractResult;

  assert.equal(result.ownedActive, false, "a restore frame is not authentication");
  assert.equal(result.restoreConsumed, true, "the sidecar is consumed");
  assert.equal(result.originalOptionsRestored, true, "the full original options are restored");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "no bootstrap: the registry stays inert");
});

test("an executor runtime with a valid bootstrap primes sticky state but never activates observation", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("executor", true);
  const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures);
  assertCallerOptionsPreserved(nodeOptions, userOptions);
  const bootstrap = makeBootstrap();
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: userOptions,
    bootstrap: JSON.stringify(bootstrap),
    restoreFrame: JSON.stringify({ original: userOptions }),
    runtimeRole: "executor",
    exercise: true,
    expectedInstanceId: String(bootstrap.instanceId),
  }) as ContractResult;

  assert.equal(result.roleIsExecutor, true, "the explicit executor test input is present");
  assert.equal(result.ownedActive, false, "an executor runtime never opts into observation");
  assert.equal(result.bootstrapConsumed, true, "sticky priming still consumes the one-shot bootstrap");
  assert.equal(result.stickyInstanceMatches, true, "priming is not role-stripped");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "the registry stays inert");
  assert.equal(result.exercise, undefined, "no source exercise runs for an executor");
});

test("a foreign sticky identity is neither attached nor overwritten", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("foreign-sticky", true);
  const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures, true);
  assertCallerOptionsPreserved(nodeOptions, userOptions);
  const foreign = makeBootstrap();
  const envBootstrap = makeBootstrap();
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: userOptions,
    bootstrap: JSON.stringify(envBootstrap),
    restoreFrame: JSON.stringify({ original: userOptions }),
    foreignKind: "sticky",
    foreignBootstrap: JSON.stringify(foreign),
    exercise: true,
    expectedInstanceId: String(foreign.instanceId),
  }) as ContractResult;

  assert.equal(result.ownedActive, false, "a conflicting sticky identity never primes a new attach");
  assert.equal(result.stickyInstanceMatches, true, "the known sticky identity stays authoritative and untouched");
  assert.equal(result.bootstrapConsumed, true, "the conflicting one-shot env is still consumed");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "no observation container is created");
});

test("a foreign owned-activity container is refused rather than overwritten", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("foreign-registry", true);
  const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures, true);
  assertCallerOptionsPreserved(nodeOptions, userOptions);
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: userOptions,
    bootstrap: JSON.stringify(makeBootstrap()),
    restoreFrame: JSON.stringify({ original: userOptions }),
    foreignKind: "registry",
    exercise: true,
    foreignSentinel: "foreign-registry-state",
  }) as ContractResult;

  assert.equal(result.ownedActive, false, "a corrupt foreign container is never treated as active");
  assert.equal(result.foreignRegistryPreserved, true, "the foreign container is left untouched");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "a foreign container yields unknown, never zero");
});

test("a throwing foreign owned-activity getter is refused rather than replaced", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("foreign-getter", true);
  const { nodeOptions, userOptions } = preloadedNodeOptions(fixtures, true);
  assertCallerOptionsPreserved(nodeOptions, userOptions);
  const result = runChild({
    fixtures,
    nodeOptions,
    expectedNodeOptions: userOptions,
    bootstrap: JSON.stringify(makeBootstrap()),
    restoreFrame: JSON.stringify({ original: userOptions }),
    foreignKind: "getter",
    exercise: true,
  }) as ContractResult;

  assert.equal(result.registryReadThrew, true, "the foreign getter really did throw on read");
  assert.equal(result.ownedActive, false, "a throwing getter can never establish active observation");
  assert.deepEqual(result.snapshotInitial, NULL_COUNTS, "an unavailable container stays unknown");
});

test("pre-opt-in source registrations replay as uncertain until their own handles resolve them", (t) => {
  assertCallerRoleClear();
  retained(t);
  const fixtures = makeCaseFixtures("fallback", false);
  const bootstrap = makeBootstrap();
  const result = runChild({
    fixtures,
    main: fixtures.fallbackMain,
    // The fallback child inherits the caller's NODE_OPTIONS unchanged (no
    // composed chain), so no restoration expectation is asserted here.
    expectedNodeOptions: undefined,
    bootstrap: JSON.stringify(bootstrap),
  }) as FallbackResult;

  assert.deepEqual(result.before, NULL_COUNTS, "registrations before opt-in create no container and observe nothing");
  assert.equal(result.activeAfterPreload, true, "loading the preload with a valid consumed prime activates observation");
  assert.deepEqual(result.afterActivation, NULL_COUNTS,
    "pre-announcement registrations replay as uncertain: no blanket zero");
  assert.deepEqual(result.afterExecutionResolved, NULL_COUNTS,
    "resolving only one replayed source cannot account for the others");
  assert.deepEqual(result.afterResolved, { backgroundTasks: 0, backgroundShells: 0 },
    "each replayed source must resolve through its own authoritative handle");
  assert.deepEqual(result.afterReactivation, { backgroundTasks: 1, backgroundShells: 0 },
    "idempotent registry reactivation never clears retained ownership");
  assert.deepEqual(result.afterRetainedRelease, { backgroundTasks: 0, backgroundShells: 0 },
    "only the owning handle releases its retained token");
});
