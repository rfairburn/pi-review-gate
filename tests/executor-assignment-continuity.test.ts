import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, resolvedWorkerRoute, type ExecutorPoolEntry, type ReviewGateConfig } from "../src/config";
import { captureWaveBase, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree } from "../src/execution/wave-worktrees";
import { ExecutorPoolScheduler, type ExecutorPoolAssignment, type ExecutorPoolLease } from "../src/execution/executor-pool";
import { runWaveWorkerLifecycle } from "../src/execution/wave-worker-lifecycle";
import { continueOperation } from "../src/execution/operation-actions";
import { executeWave } from "../src/execution/wave-controller";
import { createReattachmentBundle, readOperationRecord, writeOperationRecord, type OperationRecord, type ReattachmentBundle } from "../src/execution/operation-record";
import type { ContinuationProgressUpdate, SubtaskProgressUpdate } from "../src/execution/types";
import type { WaveWorkerTask } from "../src/execution/wave-worker";

// ── helpers ──────────────────────────────────────────────────────────────────

async function mkTmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function git(args: string[], cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const GIT_ENV = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

/** Fail fast when a generated fake script does not parse. */
async function checkScriptSyntax(path: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync(process.execPath, ["--check", path]);
  } catch (error) {
    throw new Error(
      `generated fake script failed node --check (${path}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Create a committed source repo and capture it. */
async function setupCapture(artifactDir: string): Promise<{ sourceDir: string; capture: WaveCaptureResult }> {
  const sourceDir = await mkTmp("pi-eac-src-");
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await writeFile(join(sourceDir, "app.js"), "console.log('hi');\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  await mkdir(artifactDir, { recursive: true });
  const capture = await captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "test-wave",
    artifactDir,
  });
  return { sourceDir, capture };
}

function testTask(): WaveWorkerTask {
  return {
    title: "Assignment continuity task",
    instructions: "Create worker-output.txt with the requested content.",
    acceptanceCriteria: ["worker-output.txt exists with content"],
  };
}

interface FakeExecutorOptions {
  /**
   * Turn number -> file content written to worker-output.txt. Turns without a
   * mapping leave the tree untouched (a well-behaved agent asked to confirm
   * an unchanged tree makes no edits).
   */
  contents?: Record<number, string>;
  /** Turns that record the invocation and then exit non-zero. */
  failTurns?: number[];
  /** Delay before completion so capacity polling can observe the lease. */
  sleepMs?: number;
}

/**
 * Deterministic fake executor source: appends one JSON line per invocation
 * ({turn, operation, sessionId}) to its capture file, writes turn-dependent
 * content into the worktree, and emits the run-as-binary protocol with the
 * requested session id echoed back so session continuity is observable.
 */
function fakeExecutorSource(capturePath: string, options: FakeExecutorOptions = {}): string {
  const contents = JSON.stringify(options.contents ?? {});
  const failTurns = JSON.stringify(options.failTurns ?? []);
  const sleepMs = options.sleepMs ?? 0;
  return [
    "process.stdin.resume();",
    "process.stdin.on('end', async () => {",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const capture = ${JSON.stringify(capturePath)};`,
    "const turn = Number(process.env.PI_REVIEW_EXECUTOR_TURN ?? '1');",
    "const sessionId = process.env.PI_REVIEW_EXECUTOR_SESSION_ID ?? 'no-session';",
    `fs.appendFileSync(capture, JSON.stringify({ turn, operation: process.env.PI_REVIEW_EXECUTOR_OPERATION, sessionId }) + '\\n');`,
    `if (${failTurns}.includes(turn)) { console.log(JSON.stringify({ type: 'session', sessionId })); process.exit(3); }`,
    `if (${sleepMs} > 0) await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));`,
    `const contents = ${contents};`,
    "if (Object.prototype.hasOwnProperty.call(contents, String(turn))) {",
    "  fs.writeFileSync(path.join(process.cwd(), 'worker-output.txt'), contents[String(turn)] + '\\n');",
    "}",
    "console.log(JSON.stringify({ type: 'session', sessionId }));",
    "console.log(JSON.stringify({ type: 'assistant', text: 'done turn ' + turn }));",
    "});",
  ].join("\n");
}

/** Stateful reviewer source: needs_changes on the first invocation, pass afterwards. */
function needsChangesThenPassReviewerSource(statePath: string): string {
  return [
    "const fs = require('node:fs');",
    `const statePath = ${JSON.stringify(statePath)};`,
    "let n = 0; try { n = parseInt(fs.readFileSync(statePath, 'utf8'), 10); } catch {}",
    "n += 1; fs.writeFileSync(statePath, String(n));",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify({ verdict: n === 1 ? 'needs_changes' : 'pass', summary: 'review ' + n, findings: [] }));",
    "});",
  ].join("");
}

function passingReviewerSource(): string {
  return [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify({ verdict: 'pass', summary: 'all good', findings: [] }));",
    "});",
  ].join("");
}

type AgentKey = "a" | "b";

interface PoolHarness {
  root: string;
  config: ReviewGateConfig;
  noReviewConfig: ReviewGateConfig;
  captures: Record<AgentKey, string>;
  entries: ReturnType<typeof resolvedWorkerRoute>;
}

/**
 * Two distinguishable executor resources (res-a/model-a, res-b/model-b) in
 * workerResources form, each backed by a deterministic fake binary whose
 * invocations are captured per agent.
 */
async function buildPoolHarness(
  order: [AgentKey, AgentKey],
  options: { a?: FakeExecutorOptions; b?: FakeExecutorOptions; reviewer?: "needs_changes_then_pass" | "pass" },
): Promise<PoolHarness> {
  const root = await mkTmp("pi-eac-");
  const captures: Record<AgentKey, string> = {
    a: join(root, "invocations-a.jsonl"),
    b: join(root, "invocations-b.jsonl"),
  };
  const scripts: Record<AgentKey, string> = {
    a: join(root, "exec-a.cjs"),
    b: join(root, "exec-b.cjs"),
  };
  for (const key of ["a", "b"] as const) {
    await writeFile(scripts[key], fakeExecutorSource(captures[key], options[key] ?? {}), "utf8");
    await chmod(scripts[key], 0o755);
    await checkScriptSyntax(scripts[key]);
  }
  const reviewerSource = options.reviewer === "pass"
    ? passingReviewerSource()
    : needsChangesThenPassReviewerSource(join(root, "reviewer-state"));

  const resources = order.map((key) => ({
    resourceId: `res-${key}`,
    selection: { source: "external" as const, id: `exec-${key}` },
    maxConcurrent: 1,
  }));
  const agents = [
    { id: "exec-a", adapter: "run-as-binary" as const, command: process.execPath, model: "model-a", execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [scripts.a], timeoutMs: 30_000 } },
    { id: "exec-b", adapter: "run-as-binary" as const, command: process.execPath, model: "model-b", execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [scripts.b], timeoutMs: 30_000 } },
  ];
  const base = {
    execution: {
      workerResources: resources,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
    },
    externalAgents: agents,
  };
  const config = normalizeConfig({
    ...base,
    enabled: true,
    decider: { id: "gate-reviewer", adapter: "generic-cli" as const, command: process.execPath, args: ["-e", reviewerSource], timeoutMs: 20_000 },
  });
  const noReviewConfig = normalizeConfig({ ...base, enabled: false, review: { activeReviewers: [] } });
  return {
    root,
    config,
    noReviewConfig,
    captures,
    entries: resolvedWorkerRoute(config, "execute"),
  };
}

async function readInvocations(path: string): Promise<Array<{ turn: number; operation: string; sessionId: string }>> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function operationAt(artifactDir: string): Promise<OperationRecord> {
  return readOperationRecord(join(artifactDir, "operation.json"));
}

function acquireLease(pool: ExecutorPoolScheduler, entryId?: string): ExecutorPoolLease | undefined {
  return entryId ? pool.tryAcquireEntry(entryId) : pool.tryAcquire();
}

/**
 * Pool subclass that records every acquisition/release deterministically so
 * concurrent-lease accounting can be asserted from the event stream instead
 * of time-sampled capacity snapshots.
 */
class RecordingPool extends ExecutorPoolScheduler {
  readonly events: Array<{ kind: "acquire" | "release"; entryId: string }> = [];
  maxConcurrentHeld = 0;
  private heldCounts = new Map<string, number>();
  // Internal pool calls (e.g. acquireAfterRoute -> tryAcquireRoute) dispatch
  // through the overrides, so each lease object is recorded exactly once.
  private readonly wrappedLeases = new WeakSet<object>();

  constructor(entries: readonly ExecutorPoolEntry[]) {
    super(entries);
  }

  private totalHeld(): number {
    let total = 0;
    for (const count of this.heldCounts.values()) total += count;
    return total;
  }

  private wrap(lease: ExecutorPoolLease | undefined): ExecutorPoolLease | undefined {
    if (!lease || this.wrappedLeases.has(lease)) return lease;
    const entryId = lease.entry.entryId;
    this.events.push({ kind: "acquire", entryId });
    this.heldCounts.set(entryId, (this.heldCounts.get(entryId) ?? 0) + 1);
    this.maxConcurrentHeld = Math.max(this.maxConcurrentHeld, this.totalHeld());
    let released = false;
    const wrapper: ExecutorPoolLease = {
      ...lease,
      release: () => {
        if (released) return;
        released = true;
        this.events.push({ kind: "release", entryId });
        const remaining = (this.heldCounts.get(entryId) ?? 1) - 1;
        if (remaining <= 0) this.heldCounts.delete(entryId);
        else this.heldCounts.set(entryId, remaining);
        lease.release();
      },
    };
    this.wrappedLeases.add(lease);
    this.wrappedLeases.add(wrapper);
    return wrapper;
  }

  override tryAcquire(startPriority = 0): ExecutorPoolLease | undefined {
    return this.wrap(super.tryAcquire(startPriority));
  }

  override tryAcquireEntry(entryId: string): ExecutorPoolLease | undefined {
    return this.wrap(super.tryAcquireEntry(entryId));
  }

  override tryAcquireRoute(entries: readonly ExecutorPoolEntry[], startPriority = 0): ExecutorPoolLease | undefined {
    return this.wrap(super.tryAcquireRoute(entries, startPriority));
  }

  override tryAcquireRouteEntry(entryId: string, entries: readonly ExecutorPoolEntry[]): ExecutorPoolLease | undefined {
    return this.wrap(super.tryAcquireRouteEntry(entryId, entries));
  }

  override async acquireAfter(current: number | ExecutorPoolAssignment, signal?: AbortSignal): Promise<ExecutorPoolLease | undefined> {
    return this.wrap(await super.acquireAfter(current, signal));
  }

  override async acquireAfterRoute(
    current: number | ExecutorPoolAssignment,
    entries: readonly ExecutorPoolEntry[] | (() => readonly ExecutorPoolEntry[]),
    signal?: AbortSignal,
  ): Promise<ExecutorPoolLease | undefined> {
    return this.wrap(await super.acquireAfterRoute(current, entries, signal));
  }
}

/** Run one initial (unreviewed) wave on the given resource and return its handles. */
async function runInitialWave(
  harness: PoolHarness,
  sourceDir: string,
  pool: ExecutorPoolScheduler,
  entryId: string,
): Promise<{ waveRoot: string; artifactDir: string; bundle: ReattachmentBundle }> {
  const initialLease = acquireLease(pool, entryId);
  assert.ok(initialLease, `${entryId} must be leasable`);
  await mkdir(join(harness.root, "artifacts"), { recursive: true });
  const wave = await executeWave({
    cwd: sourceDir,
    tasks: [testTask()],
    config: harness.noReviewConfig,
    maxWorkers: 1,
    artifactDir: join(harness.root, "artifacts"),
    executorPool: pool,
    initialExecutorLeases: [initialLease],
  });
  assert.equal(wave.taskResults[0]?.status, "completed_unreviewed", JSON.stringify(wave.taskResults));
  const bundle = wave.taskResults[0]!.bundle!;
  return {
    waveRoot: wave.waveRoot,
    artifactDir: join(wave.waveRoot, "artifacts", wave.taskResults[0]!.taskId),
    bundle,
  };
}

async function makeSourceDir(parentDir: string): Promise<string> {
  const sourceDir = await realpath(await mkdtemp(join(parentDir, "src-")));
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  return sourceDir;
}

// ── #17: lifecycle stays on the leased non-default resource ─────────────────

test("lifecycle keeps the leased non-default executor across corrections and pass confirmation", async () => {
  const harness = await buildPoolHarness(["a", "b"], {
    reviewer: "needs_changes_then_pass",
    b: { contents: { 1: "v1", 2: "v2" } },
  });
  let currentLease: ExecutorPoolLease | undefined;
  try {
    const { sourceDir, capture } = await setupCapture(join(harness.root, "artifacts-parent"));
    const taskId = "task-1";
    const worktree = await createWorkerWorktree(capture, taskId);
    const artifactDir = join(capture.waveRoot, "artifacts", taskId);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const lease = acquireLease(pool, "res-b");
    assert.ok(lease, "non-default resource must be leasable");
    currentLease = lease;
    const updates: SubtaskProgressUpdate[] = [];

    const result = await runWaveWorkerLifecycle({
      taskId,
      task: testTask(),
      capture,
      worktree,
      artifactDir,
      config: harness.config,
      sourceRoot: capture.discovery.captureRoot,
      sourceRootAliases: [sourceDir],
      executorAssignment: lease,
      acquireFailover: async (current: ExecutorPoolAssignment) => {
        currentLease?.release();
        const next = await pool.acquireAfterRoute(current, harness.entries);
        if (next) currentLease = next;
        return next;
      },
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted", JSON.stringify({ status: result.status, error: result.error }));
    const aInvocations = await readInvocations(harness.captures.a);
    const bInvocations = await readInvocations(harness.captures.b);
    // Initial + correction + pass confirmation: every executor turn on res-b.
    assert.equal(aInvocations.length, 0, `res-a must never be invoked: ${JSON.stringify(aInvocations)}`);
    assert.equal(bInvocations.length, 3, `expected 3 res-b invocations: ${JSON.stringify(bInvocations)}`);
    // Session continuity on the leased resource: turn 1 starts, turns 2-3 resume.
    assert.equal(bInvocations[0]!.operation, "start");
    assert.equal(bInvocations[1]!.operation, "resume");
    assert.equal(bInvocations[2]!.operation, "resume");
    assert.equal(bInvocations[1]!.sessionId, bInvocations[0]!.sessionId);
    assert.equal(bInvocations[2]!.sessionId, bInvocations[0]!.sessionId);

    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-b");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-b" });
    assert.ok(operation.assignments.every((item) => item.entryId === "res-b"), JSON.stringify(operation.assignments));
    assert.ok(!updates.some((update) => /changed the executor assignment/i.test(update.message)),
      "no settings-change announcement is expected while the lease is honored");
    // The lifecycle must not leak leases: both resources fully released.
    // The lifecycle never releases the caller-owned lease: release the last
    // live lease here and verify the pool is fully drained.
    currentLease?.release();
    currentLease = undefined;
    const snapshot = pool.capacitySnapshot();
    assert.equal(snapshot.activeLeases, 0, JSON.stringify(snapshot));
  } finally {
    currentLease?.release();
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #17: genuine failover is recorded and later turns follow the new assignment

test("lifecycle records a real failover during correction and follows the new effective assignment", async () => {
  const harness = await buildPoolHarness(["a", "b"], {
    reviewer: "needs_changes_then_pass",
    a: { contents: { 1: "v1" }, failTurns: [2] },
    b: { contents: { 3: "v2" } },
  });
  let currentLease: ExecutorPoolLease | undefined;
  try {
    const { sourceDir, capture } = await setupCapture(join(harness.root, "artifacts-parent"));
    const taskId = "task-1";
    const worktree = await createWorkerWorktree(capture, taskId);
    const artifactDir = join(capture.waveRoot, "artifacts", taskId);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const lease = acquireLease(pool, "res-a");
    assert.ok(lease, "default resource must be leasable");
    currentLease = lease;
    const updates: SubtaskProgressUpdate[] = [];

    // res-a succeeds on the initial turn but fails on the correction turn.
    const result = await runWaveWorkerLifecycle({
      taskId,
      task: testTask(),
      capture,
      worktree,
      artifactDir,
      config: harness.config,
      sourceRoot: capture.discovery.captureRoot,
      sourceRootAliases: [sourceDir],
      executorAssignment: lease,
      acquireFailover: async (current: ExecutorPoolAssignment) => {
        currentLease?.release();
        const next = await pool.acquireAfterRoute(current, harness.entries);
        if (next) currentLease = next;
        return next;
      },
      onUpdate: (update) => updates.push(update),
    });

    assert.equal(result.status, "accepted", JSON.stringify({ status: result.status, error: result.error }));
    const aInvocations = await readInvocations(harness.captures.a);
    const bInvocations = await readInvocations(harness.captures.b);
    // res-a ran the initial turn and failed once on the correction turn.
    assert.deepEqual(aInvocations.map((item) => item.turn), [1, 2]);
    // res-b took over from the verified checkpoint (turn 3) and also served
    // the pass-confirmation turn (turn 4): later turns follow the NEW
    // effective assignment instead of pinning the original lease.
    assert.deepEqual(bInvocations.map((item) => item.turn), [3, 4]);
    assert.equal(bInvocations[0]!.operation, "start", "failover must start a new session");
    assert.notEqual(bInvocations[0]!.sessionId, aInvocations[0]!.sessionId);

    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-b");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-b" });
    const failoverAssignment = operation.assignments.find((item) => item.reason === "failover");
    assert.ok(failoverAssignment, `expected a recorded failover assignment: ${JSON.stringify(operation.assignments)}`);
    assert.equal(failoverAssignment.entryId, "res-b");
    // The handoff is explicit in the activity stream, not silent.
    assert.ok(
      updates.some((update) => /failover/i.test(update.message) && update.message.includes("res-a") && update.message.includes("res-b")),
      `expected an explicit failover event: ${JSON.stringify(updates.map((u) => u.message))}`,
    );
    // The failure that triggered the handoff is durably recorded and resolved.
    const failureIncident = operation.incidents.find((incident) => incident.resolution === "verified_checkpoint_failover");
    assert.ok(failureIncident, `expected a recorded failure resolved by failover: ${JSON.stringify(operation.incidents)}`);
    // The lifecycle never releases the caller-owned lease: release the last
    // live lease here and verify the pool is fully drained.
    currentLease?.release();
    currentLease = undefined;
    const snapshot = pool.capacitySnapshot();
    assert.equal(snapshot.activeLeases, 0, JSON.stringify(snapshot));
  } finally {
    currentLease?.release();
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #16: recovery with a changed assignment announces and actually uses the new session

test("recovery under a changed assignment starts the announced new session on the leased resource", async () => {
  const harness = await buildPoolHarness(["a", "b"], { reviewer: "pass", a: { contents: { 1: "v1" } }, b: { contents: { 2: "v2" } } });
  try {
    const sourceDir = await makeSourceDir(harness.root);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const { artifactDir, bundle } = await runInitialWave(harness, sourceDir, pool, "res-a");
    const initialOperation = await operationAt(artifactDir);
    assert.equal(initialOperation.executorEntryId, "res-a");
    assert.equal((await readInvocations(harness.captures.a)).length, 1);

    // Recovery now leases the other resource (settings moved the default).
    const recoveryLease = acquireLease(pool, "res-b");
    assert.ok(recoveryLease);
    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle,
      instructions: "append the next change",
      instructionId: "continuation-1",
      config: harness.config,
      executorAssignment: recoveryLease,
      executorPool: pool,
      onUpdate: (update) => progress.push(update),
    });
    // Caller-owned lease: release it now that the continuation has settled.
    recoveryLease.release();

    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    const bInvocations = await readInvocations(harness.captures.b);
    // Continuation turn + pass confirmation, both on the leased resource.
    assert.equal(bInvocations.length, 2, JSON.stringify(bInvocations));
    // The announced replacement is the one that actually executed: a fresh
    // session under res-b, not a silent resume of the old res-a session.
    assert.equal(bInvocations[0]!.operation, "start", "changed assignment must force a new session");
    assert.notEqual(bInvocations[0]!.sessionId, initialOperation.session?.id);
    assert.ok(
      progress.some((update) => /changed the executor assignment/i.test(update.message) && update.message.includes("res-b")),
      `expected the settings-change announcement: ${JSON.stringify(progress.map((u) => u.message))}`,
    );
    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-b");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-b" });
    // No res-a invocation after the initial turn.
    assert.equal((await readInvocations(harness.captures.a)).length, 1);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #16: legacy operation without recorded assignment must not silently resume

test("recovery of a legacy operation without recorded assignment starts a new session instead of silently resuming", async () => {
  const harness = await buildPoolHarness(["a", "b"], { reviewer: "pass", a: { contents: { 1: "v1" } }, b: { contents: { 2: "v2" } } });
  try {
    const sourceDir = await makeSourceDir(harness.root);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const { artifactDir, waveRoot } = await runInitialWave(harness, sourceDir, pool, "res-a");
    const initialOperation = await operationAt(artifactDir);
    const priorSessionId = initialOperation.session?.id;
    assert.ok(priorSessionId, "initial turn must persist a session");

    // Simulate a legacy operation: durable session exists, but no recorded
    // executor assignment metadata. Rewriting the record bumps its revision,
    // so refresh the reattachment bundle from the rewritten record.
    const legacy = await operationAt(artifactDir);
    delete legacy.executorEntryId;
    delete legacy.executorPriority;
    delete legacy.executorSelection;
    delete legacy.executorAgentFingerprint;
    legacy.assignments = [];
    await writeOperationRecord(legacy);
    const bundle = createReattachmentBundle(await operationAt(artifactDir), waveRoot);

    const recoveryLease = acquireLease(pool, "res-b");
    assert.ok(recoveryLease);
    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle,
      instructions: "append the next change",
      instructionId: "continuation-1",
      config: harness.config,
      executorAssignment: recoveryLease,
      executorPool: pool,
      onUpdate: (update) => progress.push(update),
    });
    // Caller-owned lease: release it now that the continuation has settled.
    recoveryLease.release();

    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    const bInvocations = await readInvocations(harness.captures.b);
    assert.equal(bInvocations.length, 2, JSON.stringify(bInvocations));
    // Without recorded assignment metadata the prior session is unverifiable:
    // recovery must fail closed to a new session and say so.
    assert.equal(bInvocations[0]!.operation, "start", "legacy recovery must not silently resume the old session");
    assert.notEqual(bInvocations[0]!.sessionId, priorSessionId);
    assert.ok(
      progress.some((update) => /not durably recorded|unverifiable/i.test(update.message)),
      `expected an explicit announcement for the unverifiable prior session: ${JSON.stringify(progress.map((u) => u.message))}`,
    );
    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-b");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-b" });
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #16: compatible resume keeps the exact session and announces nothing

test("recovery on the same recorded assignment resumes the exact prior session", async () => {
  const harness = await buildPoolHarness(["a", "b"], { reviewer: "pass", a: { contents: { 1: "v1", 2: "v2" } } });
  try {
    const sourceDir = await makeSourceDir(harness.root);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const { artifactDir, bundle } = await runInitialWave(harness, sourceDir, pool, "res-a");
    const initialOperation = await operationAt(artifactDir);
    const priorSessionId = initialOperation.session?.id;
    assert.ok(priorSessionId);

    const recoveryLease = acquireLease(pool, "res-a");
    assert.ok(recoveryLease);
    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle,
      instructions: "append the next change",
      instructionId: "continuation-1",
      config: harness.config,
      executorAssignment: recoveryLease,
      executorPool: pool,
      onUpdate: (update) => progress.push(update),
    });
    // Caller-owned lease: release it now that the continuation has settled.
    recoveryLease.release();

    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    const aInvocations = await readInvocations(harness.captures.a);
    assert.equal(aInvocations.length, 3, JSON.stringify(aInvocations));
    // Compatible resume: the exact prior session continues on turns 2 and 3.
    assert.equal(aInvocations[1]!.operation, "resume");
    assert.equal(aInvocations[1]!.sessionId, priorSessionId);
    assert.equal(aInvocations[2]!.operation, "resume");
    assert.equal(aInvocations[2]!.sessionId, priorSessionId);
    assert.ok(
      !progress.some((update) => /changed the executor assignment/i.test(update.message)),
      "compatible resume must not announce a replacement assignment",
    );
    assert.equal((await readInvocations(harness.captures.b)).length, 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #16/#17: recovery failover is explicit and lease accounting stays coherent

test("recovery failover announces the handoff, follows it durably, and holds one lease at a time", async () => {
  // res-b is the leased recovery resource but fails; res-a (the original
  // executor) receives the verified checkpoint through recorded failover.
  const harness = await buildPoolHarness(["b", "a"], {
    reviewer: "pass",
    a: { contents: { 1: "v1", 3: "v2" } },
    b: { failTurns: [2] },
  });
  try {
    const sourceDir = await makeSourceDir(harness.root);
    const pool = new RecordingPool(harness.entries);
    const { artifactDir, bundle } = await runInitialWave(harness, sourceDir, pool, "res-a");

    // The scheduler now prefers res-b (first in the route), so recovery leases it.
    const recoveryLease = acquireLease(pool);
    assert.equal(recoveryLease?.entry.entryId, "res-b");
    assert.ok(recoveryLease);

    const progress: ContinuationProgressUpdate[] = [];
    let continued: Awaited<ReturnType<typeof continueOperation>> | undefined;
    try {
      continued = await continueOperation({
        bundle,
        instructions: "append the next change",
        instructionId: "continuation-1",
        config: harness.config,
        executorAssignment: recoveryLease,
        executorPool: pool,
        onUpdate: (update) => progress.push(update),
      });
    } finally {
      // Caller-owned lease: release it now that the continuation has settled.
      recoveryLease.release();
    }

    assert.ok(continued, "continuation must complete");
    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    // Deterministic lease observation from the pool's own acquisition/release
    // events: one task must never hold more than one lease at a time, even
    // across failover.
    assert.ok(
      pool.maxConcurrentHeld <= 1,
      `one task must hold at most one lease at a time; max concurrent held was ${pool.maxConcurrentHeld}: ${JSON.stringify(pool.events)}`,
    );

    const bInvocations = await readInvocations(harness.captures.b);
    const aInvocations = await readInvocations(harness.captures.a);
    // res-b was attempted for the recovery turn and failed; res-a took over
    // from the verified checkpoint (turn 3) and served confirmation (turn 4).
    assert.deepEqual(bInvocations.map((item) => item.turn), [2]);
    assert.deepEqual(aInvocations.map((item) => item.turn), [1, 3, 4]);
    // The failover starts a new session even though res-a executed turn 1.
    assert.equal(aInvocations[1]!.operation, "start");
    assert.notEqual(aInvocations[1]!.sessionId, aInvocations[0]!.sessionId);

    // Both the settings-change announcement and the explicit failover handoff
    // appear in the activity stream; the durable record ends on res-a.
    assert.ok(
      progress.some((update) => /changed the executor assignment/i.test(update.message) && update.message.includes("res-b")),
      `expected the settings-change announcement: ${JSON.stringify(progress.map((u) => u.message))}`,
    );
    assert.ok(
      progress.some((update) => /failover/i.test(update.message) && update.message.includes("res-b") && update.message.includes("res-a")),
      `expected an explicit failover handoff event: ${JSON.stringify(progress.map((u) => u.message))}`,
    );
    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-a");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-a" });
    assert.ok(operation.assignments.some((item) => item.reason === "failover" && item.entryId === "res-a"));
    const finalSnapshot = pool.capacitySnapshot();
    assert.equal(finalSnapshot.activeLeases, 0, JSON.stringify(finalSnapshot));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #16: a stable agent id that re-resolves to a different model must not silently resume

test("recovery with an unchanged agent id that now resolves to a different model starts a new session", async () => {
  const harness = await buildPoolHarness(["a", "b"], { reviewer: "pass", a: { contents: { 1: "v1" } }, b: { contents: { 2: "v2" } } });
  try {
    const sourceDir = await makeSourceDir(harness.root);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const { artifactDir, bundle } = await runInitialWave(harness, sourceDir, pool, "res-a");
    const initialOperation = await operationAt(artifactDir);
    assert.ok(initialOperation.executorAgentFingerprint, "assignment must durably record the resolved agent identity");
    const priorSessionId = initialOperation.session?.id;
    assert.ok(priorSessionId);

    // The catalog re-points the same stable agent id to a different binary and
    // model. The resource id (res-a) and selection id (exec-a) stay identical,
    // so only the recorded fingerprint can prove old-session compatibility.
    const driftedConfig = structuredClone(harness.config);
    const rePointed = (driftedConfig.externalAgents ?? []).find((agent) => agent.id === "exec-a");
    assert.ok(rePointed, "harness must define the exec-a agent");
    rePointed.model = "model-a-drifted";
    rePointed.execution = { protocol: "pi-review-executor-jsonl-v1", args: [join(harness.root, "exec-b.cjs")], timeoutMs: 30_000 };

    const recoveryLease = acquireLease(pool, "res-a");
    assert.ok(recoveryLease);
    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle,
      instructions: "append the next change",
      instructionId: "continuation-1",
      config: driftedConfig,
      executorAssignment: recoveryLease,
      executorPool: pool,
      onUpdate: (update) => progress.push(update),
    });
    // Caller-owned lease: release it now that the continuation has settled.
    recoveryLease.release();

    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    const bInvocations = await readInvocations(harness.captures.b);
    // The re-pointed agent served continuation (turn 2) and confirmation (turn 3).
    assert.equal(bInvocations.length, 2, JSON.stringify(bInvocations));
    // Same id, different resolution: the prior session must not be resumed.
    assert.equal(bInvocations[0]!.operation, "start", "a re-pointed agent id must force a new session");
    assert.notEqual(bInvocations[0]!.sessionId, priorSessionId);
    // The confirmation turn resumes the session the re-pointed agent created.
    assert.equal(bInvocations[1]!.operation, "resume");
    assert.equal(bInvocations[1]!.sessionId, bInvocations[0]!.sessionId);
    assert.ok(
      progress.some((update) => /no longer resolves to the adapter and model/i.test(update.message)),
      `expected an explicit resolution-drift announcement: ${JSON.stringify(progress.map((u) => u.message))}`,
    );
    // The old binary was never invoked again.
    assert.equal((await readInvocations(harness.captures.a)).length, 1);
    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-a");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-a" });
    assert.notEqual(operation.executorAgentFingerprint, initialOperation.executorAgentFingerprint, "record must carry the new resolution");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ── #16/#17: inherited (agent-level) configuration drift is part of the effective invocation

/** Give an agent inherited env alongside role env so both merge into the effective invocation. */
function withInheritedAgentEnv(
  config: ReviewGateConfig,
  agentId: string,
  env: Record<string, string>,
  roleEnv?: Record<string, string>,
): void {
  const agent = (config.externalAgents ?? []).find((candidate) => candidate.id === agentId);
  assert.ok(agent, `harness must define the ${agentId} agent`);
  agent.env = { ...env };
  if (roleEnv && agent.execution) agent.execution.env = { ...roleEnv };
}

test("recovery with an unchanged agent id whose inherited env changed starts a new session", async () => {
  const harness = await buildPoolHarness(["a", "b"], { reviewer: "pass", a: { contents: { 1: "v1", 2: "v2" } } });
  try {
    // exec-a carries inherited (agent-level) env alongside role env, so the
    // effective invocation merges both exactly as executorFromExternalAgent does.
    withInheritedAgentEnv(harness.config, "exec-a", { EAC_INHERITED: "one", EAC_ROLE: "base" }, { EAC_ROLE: "role-wins" });
    withInheritedAgentEnv(harness.noReviewConfig, "exec-a", { EAC_INHERITED: "one", EAC_ROLE: "base" }, { EAC_ROLE: "role-wins" });

    const sourceDir = await makeSourceDir(harness.root);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const { artifactDir, bundle } = await runInitialWave(harness, sourceDir, pool, "res-a");
    const initialOperation = await operationAt(artifactDir);
    assert.ok(initialOperation.executorAgentFingerprint, "assignment must durably record the resolved agent identity");
    const priorSessionId = initialOperation.session?.id;
    assert.ok(priorSessionId);

    // Only the inherited (agent-level) env value changes; role env is present
    // and untouched. A resolution that only looked at role env would have kept
    // the fingerprint stable and silently resumed the stale session.
    const driftedConfig = structuredClone(harness.config);
    const driftedAgent = (driftedConfig.externalAgents ?? []).find((agent) => agent.id === "exec-a");
    assert.ok(driftedAgent, "harness must define the exec-a agent");
    driftedAgent.env = { ...(driftedAgent.env ?? {}), EAC_INHERITED: "two" };

    const recoveryLease = acquireLease(pool, "res-a");
    assert.ok(recoveryLease);
    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle,
      instructions: "append the next change",
      instructionId: "continuation-1",
      config: driftedConfig,
      executorAssignment: recoveryLease,
      executorPool: pool,
      onUpdate: (update) => progress.push(update),
    });
    // Caller-owned lease: release it now that the continuation has settled.
    recoveryLease.release();

    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    const aInvocations = await readInvocations(harness.captures.a);
    // Continuation (turn 2) + pass confirmation (turn 3), all on res-a.
    assert.equal(aInvocations.length, 3, JSON.stringify(aInvocations));
    // Same id, changed inherited env: the prior session must not be resumed.
    assert.equal(aInvocations[1]!.operation, "start", "a changed inherited env must force a new session");
    assert.notEqual(aInvocations[1]!.sessionId, priorSessionId);
    // The confirmation turn resumes the session the drifted config created.
    assert.equal(aInvocations[2]!.operation, "resume");
    assert.equal(aInvocations[2]!.sessionId, aInvocations[1]!.sessionId);
    assert.ok(
      progress.some((update) => /no longer resolves to the adapter and model/i.test(update.message)),
      `expected an explicit resolution-drift announcement: ${JSON.stringify(progress.map((u) => u.message))}`,
    );
    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorEntryId, "res-a");
    assert.deepEqual(operation.executorSelection, { source: "external", id: "exec-a" });
    assert.notEqual(operation.executorAgentFingerprint, initialOperation.executorAgentFingerprint, "record must carry the new resolution");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("recovery with only a shadowed base env value changed resumes the exact prior session", async () => {
  const harness = await buildPoolHarness(["a", "b"], { reviewer: "pass", a: { contents: { 1: "v1", 2: "v2" } } });
  try {
    // exec-a's role env overrides EAC_ROLE, so the agent-level value is not
    // part of the effective merged invocation.
    withInheritedAgentEnv(harness.config, "exec-a", { EAC_INHERITED: "one", EAC_ROLE: "base" }, { EAC_ROLE: "role-wins" });
    withInheritedAgentEnv(harness.noReviewConfig, "exec-a", { EAC_INHERITED: "one", EAC_ROLE: "base" }, { EAC_ROLE: "role-wins" });

    const sourceDir = await makeSourceDir(harness.root);
    const pool = new ExecutorPoolScheduler(harness.entries);
    const { artifactDir, bundle } = await runInitialWave(harness, sourceDir, pool, "res-a");
    const initialOperation = await operationAt(artifactDir);
    const priorSessionId = initialOperation.session?.id;
    assert.ok(priorSessionId);

    // Change only the base value that the role env overrides: the effective
    // merged invocation is unchanged, so session compatibility must hold.
    const shadowedConfig = structuredClone(harness.config);
    const shadowedAgent = (shadowedConfig.externalAgents ?? []).find((agent) => agent.id === "exec-a");
    assert.ok(shadowedAgent, "harness must define the exec-a agent");
    shadowedAgent.env = { ...(shadowedAgent.env ?? {}), EAC_ROLE: "other-base" };

    const recoveryLease = acquireLease(pool, "res-a");
    assert.ok(recoveryLease);
    const progress: ContinuationProgressUpdate[] = [];
    const continued = await continueOperation({
      bundle,
      instructions: "append the next change",
      instructionId: "continuation-1",
      config: shadowedConfig,
      executorAssignment: recoveryLease,
      executorPool: pool,
      onUpdate: (update) => progress.push(update),
    });
    // Caller-owned lease: release it now that the continuation has settled.
    recoveryLease.release();

    assert.equal(continued.landing?.status, "landed", JSON.stringify({ status: continued.lifecycle?.status, error: continued.lifecycle?.error }));
    const aInvocations = await readInvocations(harness.captures.a);
    assert.equal(aInvocations.length, 3, JSON.stringify(aInvocations));
    // Effective configuration unchanged: the exact prior session resumes.
    assert.equal(aInvocations[1]!.operation, "resume");
    assert.equal(aInvocations[1]!.sessionId, priorSessionId);
    assert.equal(aInvocations[2]!.operation, "resume");
    assert.equal(aInvocations[2]!.sessionId, priorSessionId);
    assert.ok(
      !progress.some((update) => /no longer resolves|changed the executor assignment/i.test(update.message)),
      "a shadowed base value must not announce a resolution drift",
    );
    const operation = await operationAt(artifactDir);
    assert.equal(operation.executorAgentFingerprint, initialOperation.executorAgentFingerprint, "effective configuration unchanged");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
