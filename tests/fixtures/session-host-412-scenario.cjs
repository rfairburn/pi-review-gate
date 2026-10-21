"use strict";
/*
 * Isolated scenario runner for the combined #412 regressions.
 *
 * Each invocation runs exactly ONE scenario in its own Node process so the
 * process-local owned-activity registry and the production source/module
 * singletons start clean. It drives the real production wiring:
 *
 *   review-gate activate()/real controller -> real reporter -> real Unix-socket
 *   broker protocol -> real InstanceManager -> SidebarController
 *
 * Synthetic parts are limited to the native Pi host surface, the manager's PTY
 * input, and owned scratch repositories/sidecars. No provider credential or
 * model request is used.
 *
 * Output: one line `SCENARIO_RESULT <json>`; nonzero exit on a failed internal
 * assertion.
 */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const DIST = join(process.cwd(), "dist-test");
const { HostLab, sleep, waitUntil } = require(join(DIST, "tests", "helpers", "session-host-412-harness.js"));
const { BackgroundExecutionController } = require(join(DIST, "src", "execution", "background-controller.js"));
const { normalizeConfig } = require(join(DIST, "src", "config.js"));
const { createState } = require(join(DIST, "src", "state.js"));
const {
  OWNED_ACTIVITY_STATE_KEY,
  activeActivitySnapshot,
  ownedActivitySnapshot,
} = require(join(DIST, "src", "session-host", "owned-activity.js"));
const { beginSessionHostRestore, completeSessionHostRestore } = require(join(DIST, "src", "session-host", "reporter.js"));
const { registerBackgroundShell, __test: shellTest } = require(join(DIST, "src", "background-shell", "index.js"));

const HISTORY_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-412-history-group.cjs");
const WORKER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-412-running-worker.cjs");

const scenario = process.argv[2];
if (!scenario) throw new Error("usage: session-host-412-scenario.cjs <scenario>");

const baseConfig = {
  enabled: true,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "never",
  review: { activeReviewers: [] },
  execution: { deferredPiTools: false },
};

function controllerConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      worker: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["unused"] },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { worker: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] },
      retryPolicy: { maxRetries: 0, maxSameIncidentRepeats: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    },
  });
  config.execution.maxWorkers = 0; // never dispatch: admission/intent bookkeeping only
  return config;
}

function realWorkConfig(workerReadyDir, workerExitDir) {
  const reviewerScript = [
    "let prompt='';",
    "process.stdin.on('data',(chunk)=>{prompt+=chunk;});",
    "process.stdin.on('end',()=>{setTimeout(()=>{",
    "  process.stdout.write(JSON.stringify({verdict:'pass',summary:'synthetic review passed',findings:[]}));",
    "},2500);});",
  ].join("");
  return {
    ...baseConfig,
    externalAgents: {
      worker: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [WORKER_FIXTURE],
          env: { PRG_412_WORKER_READY_DIR: workerReadyDir, PRG_412_WORKER_EXIT_DIR: workerExitDir },
        },
      },
      reviewer: {
        adapter: "generic-cli",
        command: process.execPath,
        review: { args: ["-e", reviewerScript], timeoutMs: 60_000 },
      },
    },
    execution: {
      deferredPiTools: false,
      maxWorkers: 1,
      workerResources: { worker: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "worker" }], research: [] },
      retryPolicy: { maxRetries: 0, maxSameIncidentRepeats: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    },
    review: { activeReviewers: [{ source: "external", id: "reviewer" }] },
  };
}

function produceHistory(workspace, mode) {
  const output = execFileSync(process.execPath, [HISTORY_FIXTURE, JSON.stringify({ workspace, mode })], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = output.split("\n").find((entry) => entry.startsWith("HISTORY_GROUP "));
  assert.ok(line, `history fixture printed a record (${output})`);
  return JSON.parse(line.slice("HISTORY_GROUP ".length));
}

function statusSummary(lab) {
  const first = lab.firstLoadedUpdate();
  const view = lab.view();
  return {
    updateCount: lab.updates.length,
    firstIsFirstUpdate: first !== undefined && lab.updates[0] === first,
    first: first === undefined ? null : {
      busy: first.view.busy,
      activity: [...first.view.activity],
      pendingInput: first.view.pendingInput,
      activeTasks: first.view.activeTasks,
      activeShells: first.view.activeShells,
      backgroundTasks: first.view.backgroundTasks,
      backgroundShells: first.view.backgroundShells,
      nativeSessionId: first.view.nativeSession?.sessionId ?? null,
      epoch: first.view.nativeSession?.epoch ?? null,
      duringRequest: first.duringRequest,
    },
    requestsAtFirst: lab.activityRequests,
    activityRequests: lab.activityRequests,
    socketCount: lab.socketCount,
    requestResults: [...lab.requestResults],
    view: view === undefined ? null : {
      lifecycle: view.lifecycle,
      hasLiveProcess: view.hasLiveProcess,
      busy: view.busy,
      pendingInput: view.pendingInput,
      activity: [...view.activity],
      activeTasks: view.activeTasks,
      activeShells: view.activeShells,
      backgroundTasks: view.backgroundTasks,
      backgroundShells: view.backgroundShells,
      nativeSessionId: view.nativeSession?.sessionId ?? null,
    },
    rendered: lab.renderRow(),
    notices: [...lab.host.notices],
  };
}

async function withLab(label, config, run) {
  const lab = await HostLab.create({ label, config });
  try {
    return await run(lab);
  } finally {
    await lab.dispose();
  }
}

async function startGate(lab) {
  await lab.startReporter({ reconnectDelayMs: 25, maxReconnectAttempts: 4 });
  lab.installNativePendingPanelClear();
  await lab.activateGateExtension();
  await lab.sessionStart();
  await lab.waitFor(() => lab.firstLoadedUpdate() !== undefined, "first loaded Ready");
}

async function restoreScenario(name, execution, options = {}) {
  return withLab(name, baseConfig, async (lab) => {
      if (options.corruptSidecar) lab.writeCorruptSidecar();
      else if (execution !== undefined) await lab.seedSidecar(execution);
      if (options.delayed) {
        await lab.startReporter({ reconnectDelayMs: 25, maxReconnectAttempts: 4 });
        lab.installNativePendingPanelClear();
        let releaseRestore;
        const held = new Promise((resolve) => { releaseRestore = resolve; });
        await lab.activateGateExtension({ sessionStartInitializationTestBarrier: () => held });
        const started = lab.sessionStart();
        await sleep(80);
        const updatesWhileHeld = lab.updates.length;
        releaseRestore();
        await started;
        await lab.waitFor(() => lab.firstLoadedUpdate() !== undefined, "first loaded Ready after delayed restore");
        return { ...statusSummary(lab), updatesWhileHeld };
      }
      if (options.reload) {
        await startGate(lab);
        const marker = lab.updates.length;
        await lab.sessionStart("reload");
        await lab.waitFor(() => lab.updates.length > marker, "reload status");
        const reloaded = lab.updates[marker];
        return {
          ...statusSummary(lab),
          reload: {
            busy: reloaded.view.busy,
            activity: [...reloaded.view.activity],
            activeTasks: reloaded.view.activeTasks,
            activeShells: reloaded.view.activeShells,
            backgroundTasks: reloaded.view.backgroundTasks,
            backgroundShells: reloaded.view.backgroundShells,
            nativeSessionId: reloaded.view.nativeSession?.sessionId ?? null,
            epoch: reloaded.view.nativeSession?.epoch ?? null,
            previousEpoch: lab.updates[0]?.view.nativeSession?.epoch,
          },
        };
      }
    await startGate(lab);
    return statusSummary(lab);
  });
}

async function scenarioRestoreFresh() {
  return restoreScenario("restore-fresh", { waveRoots: [], bundles: [], groupRoots: [] });
}

async function scenarioRestoreAbsentRoots() {
  return restoreScenario("restore-absent", { waveRoots: [], bundles: [] });
}

async function scenarioRestoreMissingRoot() {
  const missing = join(tmpdir(), `prg-412-missing-history-${process.pid}`);
  return restoreScenario("restore-missing", { waveRoots: [], bundles: [], groupRoots: [missing] });
}

async function scenarioRestoreUnreadableRoot() {
  const root = mkdtempSync(join(tmpdir(), "prg-412-unreadable-"));
  try {
    writeFileSync(join(root, "execution.json"), "{ corrupt historical record", "utf8");
    return await restoreScenario("restore-unreadable", { waveRoots: [], bundles: [], groupRoots: [root] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioRestoreCorruptSidecar() {
  return restoreScenario("restore-corrupt-sidecar", undefined, { corruptSidecar: true });
}

async function scenarioRestoreHistory(mode) {
  let history;
  try {
    return await withLab(`restore-${mode}`, baseConfig, async (lab) => {
      history = produceHistory(lab.workspace, mode);
      await lab.seedSidecar({ waveRoots: [], bundles: [], groupRoots: [history.root] });
      await startGate(lab);
      const summary = statusSummary(lab);
      return { ...summary, historyRoot: history.root, historyTaskId: history.taskId };
    });
  } finally {
    // lab.dispose() already triggered the gate session_shutdown that settles its
    // restored controller; only then is the fixture-owned group root removed.
    if (history) {
      try { rmSync(history.root, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }
}

async function scenarioRestoreDelayed() {
  return restoreScenario("restore-delayed", { waveRoots: [], bundles: [], groupRoots: [] }, { delayed: true });
}

async function scenarioRestoreReload() {
  return restoreScenario("restore-reload", { waveRoots: [], bundles: [], groupRoots: [] }, { reload: true });
}

async function scenarioRealWork() {
  const scratch = mkdtempSync(join(tmpdir(), "prg-412-real-work-"));
  const readyDir = join(scratch, "worker-ready");
  const exitDir = join(scratch, "worker-exit");
  try {
    return await withLab("real-work", realWorkConfig(readyDir, exitDir), async (lab) => {
      const steps = [];
      const note = (name) => steps.push({ name, ...statusSummary(lab) });
      await startGate(lab);
      note("first-loaded");

      lab.isIdle = () => false;
      await lab.host.trigger("agent_start", { type: "agent_start" }, lab.ctx);
      await lab.waitForView((view) => view.busy === true, "prompt busy");
      note("prompt-busy");
      lab.isIdle = () => true;
      await lab.host.trigger("agent_end", { type: "agent_end", cwd: lab.workspace }, lab.ctx);
      await lab.host.trigger("agent_settled", { type: "agent_settled", cwd: lab.workspace }, lab.ctx);
      await lab.waitForView((view) => view.busy === false, "prompt settled");
      note("prompt-settled");

      for (const cycle of [1, 2]) {
        const shell = await lab.host.invokeTool("ShellStart", {
          command: "sleep 0.7; echo synthetic-shell-done",
          label: `synthetic-412-shell-${cycle}`,
          wake_on: { exit: true },
        }, lab.ctx);
        assert.ok(shell.result, `shell ${cycle} executed`);
        await lab.waitForView((view) => view.activeShells === 1, `shell ${cycle} running`, 10_000);
        note(`shell-${cycle}-running`);
        await lab.waitForView((view) => view.activeShells === 0 && view.backgroundShells === 0,
          `shell ${cycle} settled`, 15_000);
        note(`shell-${cycle}-settled`);
      }

      // One real automatic review with a real reviewer process. The review
      // settles only after the adapter observed reviewer process exit.
      await lab.host.trigger("input", { cwd: lab.workspace, text: "review the synthetic change", source: "user" }, lab.ctx);
      await lab.host.trigger("before_agent_start", { cwd: lab.workspace }, lab.ctx);
      // Automatic review requires agent tool activity: deliver the agent's
      // write tool hooks around the actual write.
      const write = { toolCallId: "synthetic-412-write", toolName: "write", input: { path: "reviewed.txt", content: "synthetic reviewed change\n" } };
      await lab.host.trigger("tool_call", write, lab.ctx);
      writeFileSync(join(lab.workspace, "reviewed.txt"), "synthetic reviewed change\n", "utf8");
      await lab.host.trigger("tool_result", { ...write, result: { content: [{ type: "text", text: "Wrote reviewed.txt" }] }, isError: false }, lab.ctx);
      await lab.host.trigger("agent_start", { type: "agent_start" }, lab.ctx);
      lab.isIdle = () => true;
      await lab.host.trigger("agent_end", { type: "agent_end", cwd: lab.workspace }, lab.ctx);
      await lab.host.trigger("agent_settled", { type: "agent_settled", cwd: lab.workspace }, lab.ctx);
      await lab.waitForView((view) => view.activeTasks === 1, "review running", 15_000);
      note("review-running");
      await lab.waitForView((view) => view.activeTasks === 0, "review settled", 20_000);
      await waitUntil(() => lab.host.notices.some((notice) => /review gate: passed/u.test(notice)), 10_000);
      note("review-settled");

      return { steps, notices: [...lab.host.notices] };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function executionRegistryEntry() {
  const state = globalThis[OWNED_ACTIVITY_STATE_KEY];
  const entry = state.sources.get("backgroundTasks")?.get("execution")?.find((candidate) => !candidate.retired);
  assert.ok(entry, "live execution source entry exists");
  assert.ok(entry.intentTokens instanceof Set, "live execution entry carries intent telemetry");
  return entry;
}

function registryDump() {
  const state = globalThis[OWNED_ACTIVITY_STATE_KEY];
  if (!state) return "no-registry-state";
  const dump = [];
  for (const [category, bySource] of state.sources) {
    for (const [source, list] of bySource) {
      dump.push({
        category,
        source,
        entries: list.map((entry) => ({
          retired: entry.retired,
          ownershipTokens: [...(entry.tokens ?? [])].length,
          ownershipUncertain: entry.uncertain,
          intent: entry.intentTokens === undefined ? "legacy" : [...entry.intentTokens].length,
          intentUncertain: entry.intentUncertain,
        })),
      });
    }
  }
  return dump;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function scenarioPoisonRecovery() {
  return withLab("poison-recovery", baseConfig, async (lab) => {
    let controller;
    const roots = [];
    try {
      // Real production background-shell tools/source for work that starts or
      // settles while a host request's owning execution census is held.
      registerBackgroundShell(lab.host.pi);
      await lab.startReporter({ reconnectDelayMs: 20, maxReconnectAttempts: 4 });
      lab.installNativePendingPanelClear();
      lab.host.pi.on("session_start", () => {
        const completion = beginSessionHostRestore(lab.sessionId);
        completeSessionHostRestore(completion);
      });
      // The owning controller exists before the first loaded status, exactly as
      // the real gate registers it during extension activation.
      controller = new BackgroundExecutionController({
        pi: {},
        config: controllerConfig(),
        state: createState(),
        cwd: () => lab.workspace,
      });
      await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
      await lab.sessionStart();
      await lab.waitFor(() => lab.firstLoadedUpdate() !== undefined, "first loaded Ready");
      await lab.waitForView((view) => view.activeTasks === 0, "first loaded canonical idle zero");
      const startTask = async (title) => {
        const inspection = await controller.start([{
          title,
          instructions: "canonical admitted work must survive telemetry poison",
          acceptanceCriteria: ["recovered"],
        }]);
        roots.push(inspection.root);
        return inspection;
      };
      const taskA = await startTask("synthetic poison target A");
      const taskIdA = taskA.tasks[0].taskId;
      const manifestA = join(taskA.root, "execution.json");
      await lab.waitFor(() => activeActivitySnapshot().activeTasks === 1,
        `canonical admitted work starts at 1 (${JSON.stringify(registryDump())})`);
      assert.equal(activeActivitySnapshot().activeTasks, 1, "canonical admitted work is positively known");
      await lab.waitForView((view) => view.activeTasks === 1, "canonical work published");

      const entry = executionRegistryEntry();
      const originalRefresher = entry.refreshActivity;
      assert.equal(typeof originalRefresher, "function", "the owning source exposes its canonical refresher");
      let refreshCalls = 0;
      let refresherHold;
      entry.refreshActivity = async () => {
        refreshCalls += 1;
        const hold = refresherHold;
        if (hold) {
          refresherHold = undefined;
          hold.entered();
          await hold.gate;
        }
        return originalRefresher();
      };
      const armRefresherHold = () => {
        let release;
        let entered;
        const gate = new Promise((resolve) => { release = resolve; });
        const enteredP = new Promise((resolve) => { entered = resolve; });
        refresherHold = { gate, entered };
        return { release, enteredP };
      };
      const poison = (tokens, uncertain) => {
        entry.intentTokens.clear();
        for (const token of tokens) entry.intentTokens.add(token);
        entry.intentUncertain = uncertain;
      };
      // The reporter's cached activity is re-synced only by a genuine registry
      // notification. An OWNERSHIP-only lifecycle mutation on another current
      // production source (a real shell cleanup token acquire/release) is that
      // event; it never reaches into controller-private bookkeeping.
      const ownershipHandle = shellTest.shellActivityHandle();
      assert.ok(ownershipHandle, "the production shell source handle is installed after reporter activation");
      let ownershipSeq = 0;
      let shellSeq = 0;
      const publishUnknown = async (label) => {
        const token = `synthetic-ownership-poison-${process.pid}-${ownershipSeq += 1}`;
        ownershipHandle.acquire(token);
        ownershipHandle.release(token);
        // Host cache is invalidated by a real pushed unknown status on the SAME
        // live authenticated connection; the manager then issues the request.
        await lab.waitForView((view) => view.activeTasks === null, `${label}: host row unknown while connected`, 8_000);
      };

      const phases = [];
      const liveCycle = async (name, ghosts, expected, duringHold) => {
        const ownershipBefore = ownedActivitySnapshot().backgroundTasks;
        assert.equal(typeof ownershipBefore, "number", `${name}: task ownership is observed before recovery`);
        const ownershipTokensBefore = [...entry.tokens].sort();
        const ownershipUncertainBefore = entry.uncertain;
        const requestsBefore = lab.activityRequests;
        const completedBefore = lab.completedRequests.length;
        const socketsBefore = lab.socketCount;
        const callsBefore = refreshCalls;
        const hold = armRefresherHold();
        poison(ghosts, true);
        await publishUnknown(name);
        await hold.enteredP;
        assert.ok(lab.activityRequests > requestsBefore,
          `${name}: the host automatically requested a fresh census`);
        assert.equal(lab.socketCount, socketsBefore,
          `${name}: recovery ran over the same live authenticated connection (no reconnect)`);
        assert.ok(refreshCalls > callsBefore,
          `${name}: processActivityRequest invoked the owning source's canonical refresher`);
        if (duringHold) await duringHold();
        hold.release();
        await lab.waitFor(() => lab.completedRequests.length > completedBefore,
          `${name}: correlated activity reply arrived`, 10_000);
        const payload = lab.completedRequests.at(-1);
        assert.equal(payload.status, "complete", `${name}: correlated reply is complete`);
        assert.equal(payload.duringRequest, true, `${name}: correlated payload was observed for this request`);
        assert.equal(payload.nativeSessionId, lab.sessionId, `${name}: payload keeps the current conversation`);
        assert.equal(payload.activeTasks, expected.activeTasks,
          `${name}: correlated payload carries the fresh actual task count`);
        assert.equal(payload.activeShells, expected.activeShells,
          `${name}: correlated payload carries the real shell work observed around the request`);
        assert.equal(typeof payload.backgroundTasks, "number",
          `${name}: correlated payload keeps an observed ownership count, never unknown`);
        assert.equal(payload.backgroundTasks, ownershipBefore,
          `${name}: recovery preserves task ownership in the correlated reply`);
        assert.equal(ownedActivitySnapshot().backgroundTasks, ownershipBefore,
          `${name}: recovery preserves task ownership locally`);
        assert.deepEqual([...entry.tokens].sort(), ownershipTokensBefore,
          `${name}: recovery preserves exact execution ownership tokens`);
        assert.equal(entry.uncertain, ownershipUncertainBefore,
          `${name}: recovery preserves ownership uncertainty`);
        await lab.waitForView((view) => view.activeTasks === expected.activeTasks && view.activeShells === expected.activeShells,
          `${name}: rendered row converges to the fresh actual counts`, 8_000);
        const rendered = lab.renderRow();
        assert.match(rendered, new RegExp(`bg tasks ${expected.activeTasks} \\| shells ${expected.activeShells}`, "u"),
          `${name}: rendered row shows the fresh actual counts\n${rendered}`);
        phases.push({ name, ...statusSummary(lab), refreshCalls, payload });
        return payload;
      };

      const ownedDuringWork = ownedActivitySnapshot().backgroundTasks;
      const liveManifestSentinel = sha256File(manifestA);

      // Nonzero, repeated: one execution task is active; a real shell STARTS
      // while the request holds the execution census.
      await liveCycle("nonzero-shell-start", [], { activeTasks: 1, activeShells: 1 }, async () => {
        const shell = await lab.host.invokeTool("ShellStart", {
          command: "sleep 1.2; echo synthetic-live-shell",
          label: `synthetic-live-${shellSeq += 1}`,
          wake_on: { exit: true },
        }, lab.ctx);
        assert.ok(shell.result, "shell started while the census was held");
        assert.equal(activeActivitySnapshot().activeShells, 1, "the new shell is real current activity");
      });
      await lab.waitForView((view) => view.activeShells === 0, "live shell settled", 15_000);

      // A second execution task before the next cycle, then a real shell that
      // SETTLES while the request holds the execution census.
      const taskB = await startTask("synthetic poison target B");
      assert.equal(activeActivitySnapshot().activeTasks, 2, "the second admission counts");
      await lab.waitForView((view) => view.activeTasks === 2, "second canonical work published");
      const shellSettling = await lab.host.invokeTool("ShellStart", {
        command: "sleep 0.6; echo synthetic-settling-shell",
        label: `synthetic-settling-${shellSeq += 1}`,
        wake_on: { exit: true },
      }, lab.ctx);
      assert.ok(shellSettling.result, "settling shell started before the request");
      await lab.waitForView((view) => view.activeShells === 1, "settling shell running");
      await liveCycle("nonzero-shell-settle", ["execution:ghost-a", "execution:ghost-b"], { activeTasks: 2, activeShells: 0 }, async () => {
        await waitUntil(() => activeActivitySnapshot().activeShells === 0, 15_000);
      });
      assert.equal(sha256File(manifestA), liveManifestSentinel, "activity recovery never rewrites the durable record");

      // Real settlement of both admitted tasks, then repeated zero recovery.
      await controller.interrupt({
        executionId: taskA.executionId,
        taskId: taskIdA,
        mode: "interrupt_as_failure",
        instructionId: "synthetic-412-interrupt-a",
        actor: "user",
      });
      assert.equal(activeActivitySnapshot().activeTasks, 1,
        "one admitted task remains after the first real interrupt");
      const taskIdB = taskB.tasks[0].taskId;
      await controller.interrupt({
        executionId: taskB.executionId,
        taskId: taskIdB,
        mode: "interrupt_as_failure",
        instructionId: "synthetic-412-interrupt-b",
        actor: "user",
      });
      assert.equal(activeActivitySnapshot().activeTasks, 0, "canonical activity is now a known zero");
      const settledSentinel = sha256File(manifestA);

      // Zero with a shell STARTING during the held request.
      await liveCycle("zero-shell-start", ["execution:ghost-zero"], { activeTasks: 0, activeShells: 1 }, async () => {
        const shell = await lab.host.invokeTool("ShellStart", {
          command: "sleep 1.2; echo synthetic-zero-shell",
          label: `synthetic-zero-${shellSeq += 1}`,
          wake_on: { exit: true },
        }, lab.ctx);
        assert.ok(shell.result, "zero-cycle shell started while the census was held");
        assert.equal(activeActivitySnapshot().activeShells, 1, "the zero-cycle shell is real current activity");
      });
      await lab.waitForView((view) => view.activeShells === 0, "zero-cycle shell settled", 15_000);

      // Zero with a shell SETTLING during the held request, repeated.
      for (const [index, ghosts] of [["execution:ghost-x", "execution:ghost-y"], ["execution:ghost-z"]].entries()) {
        const shell = await lab.host.invokeTool("ShellStart", {
          command: "sleep 0.6; echo synthetic-zero-settling",
          label: `synthetic-zero-settling-${shellSeq += 1}`,
          wake_on: { exit: true },
        }, lab.ctx);
        assert.ok(shell.result, "zero settling shell started");
        await lab.waitForView((view) => view.activeShells === 1, "zero settling shell running");
        await liveCycle(`zero-shell-settle-${index + 1}`, ghosts, { activeTasks: 0, activeShells: 0 }, async () => {
          await waitUntil(() => activeActivitySnapshot().activeShells === 0, 15_000);
        });
        assert.equal(sha256File(manifestA), settledSentinel, "zero recovery never rewrites the durable record");
      }

      return {
        phases,
        final: statusSummary(lab),
        ownership: { duringWork: ownedDuringWork },
        sentinels: { live: liveManifestSentinel, settled: settledSentinel },
      };
    } finally {
      let failure;
      try { await controller?.detach(); } catch (error) { failure = error; }
      if (!failure) {
        for (const root of roots) {
          try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
        }
      }
      if (failure) throw failure;
    }
  });
}

async function scenarioUnreadableLive() {
  return withLab("unreadable-live", baseConfig, async (lab) => {
    let controller;
    let root;
    try {
      await lab.startReporter({ reconnectDelayMs: 20, maxReconnectAttempts: 4 });
      lab.installNativePendingPanelClear();
      lab.host.pi.on("session_start", () => {
        const completion = beginSessionHostRestore(lab.sessionId);
        completeSessionHostRestore(completion);
      });
      controller = new BackgroundExecutionController({
        pi: {},
        config: controllerConfig(),
        state: createState(),
        cwd: () => lab.workspace,
      });
      await controller.restore({ waveRoots: [], bundles: [], groupRoots: [] });
      await lab.sessionStart();
      await lab.waitFor(() => lab.firstLoadedUpdate() !== undefined, "first loaded Ready");
      await lab.waitForView((view) => view.activeTasks === 0, "first loaded canonical idle zero");
      const started = await controller.start([{
        title: "unreadable live target",
        instructions: "canonical record becomes unreadable during the request",
        acceptanceCriteria: ["unknown"],
      }]);
      root = started.root;
      await lab.waitFor(() => activeActivitySnapshot().activeTasks === 1, "canonical work known");
      await lab.waitForView((view) => view.activeTasks === 1, "canonical work published");

      const entry = executionRegistryEntry();
      const originalRefresher = entry.refreshActivity;
      let refreshCalls = 0;
      let refresherHold;
      entry.refreshActivity = async () => {
        refreshCalls += 1;
        const hold = refresherHold;
        if (hold) { refresherHold = undefined; hold.entered(); await hold.gate; }
        return originalRefresher();
      };
      const ownershipHandle = shellTest.shellActivityHandle();
      assert.ok(ownershipHandle);
      const manifest = join(started.root, "execution.json");
      const heldManifest = `${manifest}.held-${process.pid}`;
      let release;
      let entered;
      const gate = new Promise((resolve) => { release = resolve; });
      const enteredP = new Promise((resolve) => { entered = resolve; });
      refresherHold = { gate, entered };
      entry.intentTokens.clear();
      entry.intentTokens.add("execution:ghost-unreadable");
      entry.intentUncertain = true;
      const token = `synthetic-unreadable-${process.pid}`;
      ownershipHandle.acquire(token);
      ownershipHandle.release(token);
      await lab.waitForView((view) => view.activeTasks === null, "host row unknown while connected");
      await enteredP;
      assert.ok(refreshCalls > 0, "the request invoked the owning source");
      // Make the canonical record genuinely unreadable during this exact read.
      renameSync(manifest, heldManifest);
      release();
      await lab.waitFor(() => lab.completedRequests.length > 0, "correlated unreadable reply", 10_000);
      const payload = lab.completedRequests.at(-1);
      assert.equal(payload.status, "complete");
      assert.equal(payload.activeTasks, null, "unreadable canonical evidence stays unknown in the correlated payload");
      assert.notEqual(payload.activeTasks, 0, "unreadable evidence is never certified as zero");
      const renderedUnknown = lab.renderRow();
      assert.match(renderedUnknown, /bg tasks unknown/u, "the rendered row shows truthful unknown");
      renameSync(heldManifest, manifest);
      return { payload, refreshCalls, renderedUnknown, final: statusSummary(lab) };
    } finally {
      let failure;
      try { await controller?.detach(); } catch (error) { failure = error; }
      if (!failure && root) {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ }
      }
      if (failure) throw failure;
    }
  });
}

const scenarios = {
  "restore-fresh": scenarioRestoreFresh,
  "restore-absent-roots": scenarioRestoreAbsentRoots,
  "restore-missing-root": scenarioRestoreMissingRoot,
  "restore-unreadable-root": scenarioRestoreUnreadableRoot,
  "restore-corrupt-sidecar": scenarioRestoreCorruptSidecar,
  "restore-settled-history": () => scenarioRestoreHistory("settled"),
  "restore-queued-history": () => scenarioRestoreHistory("queued"),
  "restore-delayed": scenarioRestoreDelayed,
  "restore-reload": scenarioRestoreReload,
  "real-work": scenarioRealWork,
  "poison-recovery": scenarioPoisonRecovery,
  "unreadable-live": scenarioUnreadableLive,
};

const run = scenarios[scenario];
if (!run) throw new Error(`unknown scenario ${scenario}`);
run().then((result) => {
  process.stdout.write(`SCENARIO_RESULT ${JSON.stringify({ scenario, ok: true, result })}\n`);
  process.exit(0);
}, (error) => {
  process.stderr.write(`SCENARIO_ERROR ${scenario} ${String(error && error.stack || error)}\n`);
  process.exit(1);
});

