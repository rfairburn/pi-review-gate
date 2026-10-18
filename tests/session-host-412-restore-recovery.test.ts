/**
 * Combined production regressions for #412: restored/new runtime startup,
 * authoritative owning-source recovery, and the host-visible rendered row.
 *
 * Each scenario runs in its own Node process through
 * tests/fixtures/session-host-412-scenario.cjs so the process-local
 * owned-activity registry and the production source/module singletons start
 * clean. Inside that process the real wiring is exercised end to end:
 *
 *   review-gate activate() / real BackgroundExecutionController
 *     -> authenticated session-host reporter
 *     -> protocol frames on a real Unix-socket status broker
 *     -> production InstanceManager
 *     -> SidebarController rendered rows
 *
 * The regressions do NOT use "known-zero" fake source registrations as their
 * end-to-end proof: the review-gate extension itself restores the real saved
 * sidecar and registers the real execution controller, or the scenario drives
 * a real production controller for recovery races. Synthetic parts are limited
 * to the native Pi host surface, the manager's PTY input, and owned scratch
 * repositories/sidecars. No provider credential or live model request is used.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { encodeFrame } from "../src/session-host/protocol";
import { Recorder } from "./helpers/session-host-412-harness";

const SCENARIO = join(process.cwd(), "tests", "fixtures", "session-host-412-scenario.cjs");
const EXECUTOR_SCENARIO = join(process.cwd(), "tests", "fixtures", "session-host-412-executor.cjs");
const SESSION_ID = "synthetic-412-session";

interface FirstStatus {
  busy: boolean | null;
  activity: string[];
  pendingInput: boolean | null;
  activeTasks: number | null;
  activeShells: number | null;
  backgroundTasks: number | null;
  backgroundShells: number | null;
  nativeSessionId: string | null;
  epoch: number | null;
  duringRequest: boolean;
}

interface ScenarioSummary {
  updateCount: number;
  firstIsFirstUpdate: boolean;
  first: FirstStatus | null;
  requestsAtFirst: number;
  activityRequests: number;
  socketCount: number;
  requestResults: string[];
  view: {
    lifecycle: string;
    hasLiveProcess: boolean;
    busy: boolean | null;
    pendingInput: boolean | null;
    activity: string[];
    activeTasks: number | null;
    activeShells: number | null;
    backgroundTasks: number | null;
    backgroundShells: number | null;
    nativeSessionId: string | null;
  } | null;
  rendered: string;
  notices: string[];
}

interface ScenarioResult {
  scenario: string;
  ok: true;
  result: Record<string, any>;
}

function runScenario(name: string): Record<string, any> {
  // A dedicated per-scenario temp root keeps capture pruning and wave artifacts
  // isolated from unrelated suites (the shared OS temp can hold thousands of
  // wave roots mid-CI). It is ignored scratch under dist-test, removed on
  // success and retained as evidence on failure.
  const scenarioTmp = mkdtempSync(join(process.cwd(), "dist-test", `tmp-412-${name}-`));
  let output: string;
  try {
    output = execFileSync(process.execPath, [name === "real-executor" ? EXECUTOR_SCENARIO : SCENARIO, name], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, TMPDIR: scenarioTmp },
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`scenario ${name} failed: ${failure.stderr || failure.stdout || failure.message}`);
  }
  const line = output.split("\n").find((entry) => entry.startsWith("SCENARIO_RESULT "));
  assert.ok(line, `scenario ${name} printed a result (${output})`);
  const parsed = JSON.parse(line.slice("SCENARIO_RESULT ".length)) as ScenarioResult;
  assert.equal(parsed.scenario, name);
  assert.equal(parsed.ok, true);
  rmSync(scenarioTmp, { recursive: true, force: true });
  return parsed.result;
}

function runScenarioFailure(
  name: string,
  extraEnv: Record<string, string>,
): { status: number | undefined; stdout: string; stderr: string; scenarioTmp: string } {
  const scenarioTmp = mkdtempSync(join(process.cwd(), "dist-test", `tmp-412-fail-${name}-`));
  try {
    execFileSync(process.execPath, [name === "real-executor" ? EXECUTOR_SCENARIO : SCENARIO, name], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, TMPDIR: scenarioTmp, ...extraEnv },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    if (failure.status === undefined && failure.stderr === undefined) throw error;
    return { status: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", scenarioTmp };
  }
  rmSync(scenarioTmp, { recursive: true, force: true });
  throw new Error(`scenario ${name} unexpectedly succeeded under the fault injection`);
}

/**
 * Assert one restored/new runtime's FIRST successful loaded status (never a
 * later stage): the row is already loaded with its native conversation, actual
 * readiness and activity counts are final, and no host recovery request or
 * work was needed to reach it.
 */
function assertFirstLoaded(
  summary: ScenarioSummary,
  expected: { activeTasks: number | null; backgroundTasks: number | null },
  what: string,
): void {
  assert.equal(summary.updateCount, 1, `${what}: exactly one authoritative status was published`);
  assert.equal(summary.firstIsFirstUpdate, true,
    `${what}: the loaded status IS the first broker-forwarded status (no earlier Ready/unknown/initializing frame)`);
  const first = summary.first;
  assert.ok(first, `${what}: first loaded status exists`);
  assert.equal(first.nativeSessionId, SESSION_ID, `${what}: loaded native conversation identity`);
  assert.equal(first.busy, false, `${what}: first loaded status reports actual idle readiness`);
  assert.deepEqual(first.activity, ["Ready"], `${what}: first loaded status is Ready, not an initializing placeholder`);
  assert.equal(first.pendingInput, false, `${what}: the native pending panel is observed absent`);
  assert.equal(first.activeTasks, expected.activeTasks, `${what}: first loaded status already has the actual activity count`);
  assert.equal(first.activeShells, 0, `${what}: no shell activity`);
  assert.equal(first.backgroundTasks, expected.backgroundTasks, `${what}: first loaded status has the actual ownership count`);
  assert.equal(first.backgroundShells, 0, `${what}: no owned shell work`);
  assert.equal(summary.requestsAtFirst, 0,
    `${what}: the known first status needed no host recovery request and no manual refresh`);

  const view = summary.view;
  assert.ok(view, `${what}: manager row exists`);
  assert.equal(view.lifecycle, "alive", `${what}: manager row is alive`);
  assert.equal(view.hasLiveProcess, true, `${what}: manager still owns the live child`);
  assert.equal(view.nativeSessionId, SESSION_ID, `${what}: manager loaded the conversation`);
  assert.equal(view.activeTasks, expected.activeTasks, `${what}: manager row keeps the actual activity`);
  assert.equal(view.pendingInput, false, `${what}: manager row has no pending input`);
  assert.match(summary.rendered, new RegExp(`bg tasks ${expected.activeTasks ?? "unknown"} \\| shells 0`, "u"),
    `${what}: rendered row shows the actual activity counts\n${summary.rendered}`);
  assert.match(summary.rendered, expected.activeTasks === 0 ? /agent idle/u : /agent running/u,
    `${what}: rendered row shows the actual agent state\n${summary.rendered}`);
  assert.match(summary.rendered, /Ready/u, `${what}: rendered row shows the real Ready activity\n${summary.rendered}`);
}

test("recorder captures the correlated activity_result payload, not a later ordinary push", async () => {
  const recorder = new Recorder();
  let resolveRequest!: (value: { requestId: string; status: "complete" }) => void;
  const reply = new Promise<{ requestId: string; status: "complete" }>((resolve) => { resolveRequest = resolve; });
  const registration = { requestActivity: () => reply } as unknown as Parameters<Recorder["wrap"]>[0];
  const socket = { write: (_chunk: string) => true } as unknown as import("node:net").Socket;
  recorder.trackSocket(socket);
  const wrapped = recorder.wrap(registration);
  const pending = wrapped.requestActivity!();
  const nativeSession = { sessionId: "correlated-session", epoch: 1, name: "Correlated" };
  const instanceId = "11111111-1111-4111-8111-111111111111";
  const generation = "22222222-2222-4222-8222-222222222222";
  const requestId = "33333333-3333-4333-8333-333333333333";
  const statusFrame = (sequence: number, activeTasks: number) => ({
    version: 1, type: "status", instanceId, generation,
    sequence, busy: false, pendingInput: false, inputSurface: false,
    backgroundTasks: 9, backgroundShells: 0, activeTasks, activeShells: 0,
    activity: ["Ready"], nativeSession,
  });
  socket.write(encodeFrame({
    version: 1, type: "activity_result", instanceId, generation,
    requestId, outcome: "complete", status: statusFrame(5, 99),
    observedSessionId: nativeSession.sessionId, observedSessionEpoch: nativeSession.epoch,
  } as never) as string);
  // A later ordinary push with the "correct" count arrives before the awaiting
  // request continuation; it must not replace the correlated reply.
  socket.write(encodeFrame(statusFrame(6, 1) as never) as string);
  resolveRequest({ requestId, status: "complete" });
  await pending;
  assert.equal(recorder.completedRequests.length, 1);
  const captured = recorder.completedRequests[0]!;
  assert.equal(captured.requestId, requestId);
  assert.equal(captured.activeTasks, 99, "the captured count is the correlated reply, not the later push");
  assert.equal(captured.backgroundTasks, 9);
});

test("restored histories reach their FIRST loaded Ready with actual counts through the real gate", { skip: process.platform === "win32" }, async (t) => {
  await t.test("fresh saved conversation with an authoritative empty association set", () => {
    const summary = runScenario("restore-fresh") as ScenarioSummary;
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: 0 }, "fresh restore");
  });

  await t.test("older saved sidecar without the optional groupRoots roster", () => {
    const summary = runScenario("restore-absent-roots") as ScenarioSummary;
    // An absent roster cannot prove an empty owned set, so the conservative
    // ownership channel stays unknown; the CURRENT runtime's activity is still
    // an independently established known zero.
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: null }, "absent groupRoots restore");
  });

  await t.test("missing historical group root (prior busy/unknown history, no current work)", () => {
    const summary = runScenario("restore-missing-root") as ScenarioSummary;
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: null }, "missing historical root restore");
    assert.match(summary.notices.join("\n"), /background execution was not restored/u,
      "the gate truthfully reports the historical root it could not restore");
  });

  await t.test("unreadable historical group root", () => {
    const summary = runScenario("restore-unreadable-root") as ScenarioSummary;
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: null }, "unreadable historical root restore");
  });

  await t.test("unreadable saved sidecar itself (failed historical recovery)", () => {
    const summary = runScenario("restore-corrupt-sidecar") as ScenarioSummary;
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: null }, "corrupt sidecar recovery");
    assert.match(summary.notices.join("\n"), /persisted conversation state was not restored/u,
      "the failed historical recovery is reported truthfully");
  });

  await t.test("settled historical group (the former runtime's finished work)", () => {
    const summary = runScenario("restore-settled-history") as ScenarioSummary;
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: 0 }, "settled historical group restore");
  });

  await t.test("restored real admitted work is preserved at the FIRST loaded Ready", () => {
    const summary = runScenario("restore-queued-history") as ScenarioSummary;
    // The new runtime attached the real queued task: its current activity is
    // counted from its own lifecycle, never replayed from history and never
    // hidden as idle.
    assertFirstLoaded(summary, { activeTasks: 1, backgroundTasks: 1 }, "restored admitted work");
  });

  await t.test("delayed restore publication never publishes an earlier Ready/initializing status", () => {
    const summary = runScenario("restore-delayed") as ScenarioSummary & { updatesWhileHeld: number };
    assert.equal(summary.updatesWhileHeld, 0,
      "no loaded/Ready or initializing status is published while the saved conversation is still loading");
    assertFirstLoaded(summary, { activeTasks: 0, backgroundTasks: 0 }, "delayed restore");
  });

  await t.test("a reload publishes its own first loaded Ready instead of replaying the prior session", () => {
    const summary = runScenario("restore-reload") as ScenarioSummary & {
      reload: {
        busy: boolean | null;
        activity: string[];
        activeTasks: number | null;
        activeShells: number | null;
        backgroundTasks: number | null;
        backgroundShells: number | null;
        nativeSessionId: string | null;
        epoch: number | null;
        previousEpoch: number | null;
      };
    };
    assert.equal(summary.reload.nativeSessionId, SESSION_ID);
    assert.equal(summary.reload.busy, false, "the reload's first status is not a pre-restore unknown/busy replay");
    assert.deepEqual(summary.reload.activity, ["Ready"]);
    assert.equal(summary.reload.activeTasks, 0, "the reload's first status carries the actual idle zero");
    assert.equal(summary.reload.activeShells, 0);
    assert.equal(summary.reload.backgroundTasks, 0);
    assert.equal(summary.reload.backgroundShells, 0);
    assert.ok(summary.reload.previousEpoch !== null && summary.reload.epoch !== null
      && summary.reload.epoch > summary.reload.previousEpoch,
    "the reload advances the native session epoch instead of replaying the prior session");
  });
});

test("real prompt, shell, task and review work publish actual nonzero then settled zero", { skip: process.platform === "win32" }, () => {
  const result = runScenario("real-work");
  const steps = result.steps as Array<ScenarioSummary & { name: string }>;
  const step = (name: string): ScenarioSummary & { name: string } => {
    const found = steps.find((entry) => entry.name === name);
    assert.ok(found, `real-work step ${name} exists (steps: ${steps.map((entry) => entry.name).join(", ")})`);
    return found;
  };

  assertFirstLoaded(step("first-loaded"), { activeTasks: 0, backgroundTasks: 0 }, "fresh real-work session");

  const promptBusy = step("prompt-busy");
  assert.equal(promptBusy.view?.busy, true, "prompt work marks the row busy");
  assert.match(promptBusy.rendered, /agent running/u);
  assert.equal(promptBusy.view?.activeTasks, 0, "prompt work alone is not background activity");
  const promptSettled = step("prompt-settled");
  assert.equal(promptSettled.view?.busy, false);
  assert.deepEqual(promptSettled.view?.activity, ["Ready"]);

  for (const cycle of [1, 2]) {
    const running = step(`shell-${cycle}-running`);
    assert.equal(running.view?.activeShells, 1, `shell ${cycle} publishes running intent`);
    assert.equal(running.view?.backgroundShells, 1, `shell ${cycle} is independently owned until its actual exit`);
    assert.match(running.rendered, /bg tasks 0 \| shells 1/u, `rendered row shows running shells ${cycle}\n${running.rendered}`);
    assert.match(running.rendered, /agent running/u);
    const settled = step(`shell-${cycle}-settled`);
    assert.equal(settled.view?.activeShells, 0);
    assert.equal(settled.view?.backgroundShells, 0);
    assert.match(settled.rendered, /bg tasks 0 \| shells 0/u);
  }

  const reviewRunning = step("review-running");
  assert.equal(reviewRunning.view?.activeTasks, 1, "the real automatic review publishes activity");
  assert.equal(reviewRunning.view?.busy, false, "a background review does not make the agent itself busy");
  assert.match(reviewRunning.rendered, /bg tasks 1 \| shells 0/u, `rendered row shows the running review\n${reviewRunning.rendered}`);
  const reviewSettled = step("review-settled");
  assert.equal(reviewSettled.view?.activeTasks, 0, "the review verdict settles the count back to zero");
  assert.match(reviewSettled.rendered, /bg tasks 0 \| shells 0/u);
  assert.deepEqual(reviewSettled.view?.activity, ["Ready"]);
  assert.match((result.notices as string[]).join("\n"), /review gate: passed/u, "the real reviewer's verdict settled the review");
});

test("a real executor process starts, runs, and positively settles on interrupt", { skip: process.platform === "win32" }, () => {
  const result = runScenario("real-executor");
  const steps = result.steps as Array<{
    cycle: number;
    workerPid: string;
    readyFile: string;
    exitFile: string;
    stateBefore: string;
    stateAfter: string;
    activeBefore: number | null;
    activeAfter: number | null;
  }>;
  assert.equal(steps.length, 2, "two independent real executor cycles ran");
  for (const entry of steps) {
    assert.match(entry.workerPid, /^\d+$/u, `cycle ${entry.cycle}: a real OS child pid was observed`);
    assert.match(entry.readyFile, /^\d+\.ready$/u, `cycle ${entry.cycle}: readiness acknowledgement came from that pid`);
    assert.equal(entry.exitFile, `${entry.workerPid}.exit`, `cycle ${entry.cycle}: exit acknowledgement is keyed to the same pid`);
    assert.equal(entry.stateBefore, "running", `cycle ${entry.cycle}: work was executing, not queued, before the interrupt`);
    assert.equal(entry.activeBefore, 1, `cycle ${entry.cycle}: canonical activity was 1 while the executor ran`);
    assert.equal(entry.stateAfter, "interrupted", `cycle ${entry.cycle}: the interrupt quiesced the task`);
    assert.equal(entry.activeAfter, 0, `cycle ${entry.cycle}: canonical activity returned to a known zero after verified exit`);
  }
});

test("executor failure after readiness terminates the acknowledged worker before cleanup", { skip: process.platform === "win32" }, () => {
  const failure = runScenarioFailure("real-executor", { PRG_412_EXECUTOR_FAIL_AFTER_READY: "1" });
  let settlementVerified = false;
  try {
    assert.notEqual(failure.status, 0, "the fault-injected scenario exited nonzero");
    assert.match(failure.stderr, /injected assertion failure immediately after executor readiness/u);
    const retained = /EXECUTOR_FIXTURES_RETAINED (\S+)/u.exec(failure.stderr);
    if (retained) {
      // Settlement verification failed inside the fixture: it retained its
      // evidence. Verify the acknowledged workers are gone before removing it.
      const scratch = retained[1]!;
      const readyDir = join(scratch, "worker-ready");
      const exitDir = join(scratch, "worker-exit");
      const ready = readdirSync(readyDir).filter((file) => file.endsWith(".ready"));
      assert.ok(ready.length > 0, "the injected failure happened after a real worker readiness acknowledgement");
      for (const file of ready) {
        const pid = file.split(".")[0]!;
        assert.ok(readdirSync(exitDir).includes(`${pid}.exit`), `worker ${pid} wrote its exit acknowledgement`);
        assert.throws(() => process.kill(Number(pid), 0), (error: NodeJS.ErrnoException) => error?.code === "ESRCH",
          `worker ${pid} is no longer alive`);
      }
    } else {
      // Cleanup succeeded and removed the fixtures; it must have reported the
      // positively settled worker pids before removal.
      const settled = /EXECUTOR_SETTLED ([0-9,]+)/u.exec(failure.stderr);
      assert.ok(settled, `settled worker pids were reported before fixture removal: ${failure.stderr}`);
      for (const pid of settled[1]!.split(",")) {
        assert.throws(() => process.kill(Number(pid), 0), (error: NodeJS.ErrnoException) => error?.code === "ESRCH",
          `worker ${pid} exited before cleanup completed`);
      }
    }
    settlementVerified = true;
  } finally {
    // Never destroy the executor's retained scratch (it lives under this
    // TMPDIR) unless every settlement assertion above actually passed.
    if (settlementVerified) {
      rmSync(failure.scenarioTmp, { recursive: true, force: true });
    } else {
      process.stderr.write(`EXECUTOR_PARENT_FIXTURES_RETAINED ${failure.scenarioTmp}\n`);
    }
  }
});

test("fresh owning-source payloads recover poisoned telemetry and render the real counts", { skip: process.platform === "win32" }, () => {
  const result = runScenario("poison-recovery");
  const phases = result.phases as Array<ScenarioSummary & { name: string; refreshCalls: number; payload: {
    status: string;
    requestId: string;
    activeTasks: number | null;
    activeShells: number | null;
    backgroundTasks: number | null;
    backgroundShells: number | null;
    busy: boolean | null;
    nativeSessionId: string | null;
    duringRequest: boolean;
    socketCount: number;
  } }>;
  const phase = (name: string) => {
    const found = phases.find((entry) => entry.name === name);
    assert.ok(found, `poison-recovery phase ${name} exists (phases: ${phases.map((entry) => entry.name).join(", ")})`);
    return found;
  };

  // Every recovery is request-driven on the SAME live authenticated connection:
  // the owning source refresher is gated/counted, the host row was knowingly
  // wrong/unknown beforehand, and the correlated payload is captured directly.
  const assertFreshPayload = (
    found: ReturnType<typeof phase>,
    expected: { activeTasks: number; activeShells: number },
    label: string,
  ): void => {
    assert.equal(found.payload.status, "complete", `${label}: correlated reply is complete`);
    assert.equal(found.payload.duringRequest, true, `${label}: payload was delivered for this exact request`);
    assert.equal(found.payload.nativeSessionId, SESSION_ID, `${label}: payload keeps the current conversation`);
    assert.equal(found.payload.activeTasks, expected.activeTasks, `${label}: fresh actual task count`);
    assert.equal(found.payload.activeShells, expected.activeShells, `${label}: fresh actual shell count`);
    assert.equal(typeof found.payload.backgroundTasks, "number", `${label}: ownership count stays observed, never unknown`);
    assert.ok(found.activityRequests > 0, `${label}: the host automatically requested a fresh census`);
    assert.ok(found.refreshCalls > 0, `${label}: the owning source's canonical refresher was invoked`);
    assert.ok(found.requestResults.includes("complete"), `${label}: complete correlated payloads delivered`);
    assert.match(found.rendered, new RegExp(`bg tasks ${expected.activeTasks} \\| shells ${expected.activeShells}`, "u"),
      `${label}: rendered row shows the fresh actual counts\n${found.rendered}`);
  };

  // Nonzero truth, repeated. A real shell starts during the first held request
  // and another real shell settles during the second; execution work remains
  // actual while the registry telemetry was independently poisoned.
  assertFreshPayload(phase("nonzero-shell-start"), { activeTasks: 1, activeShells: 1 }, "nonzero-shell-start");
  assertFreshPayload(phase("nonzero-shell-settle"), { activeTasks: 2, activeShells: 0 }, "nonzero-shell-settle");

  // Zero truth, repeated, after the real interrupt settled both tasks: one
  // shell starts during the held request and two settle during later ones.
  assertFreshPayload(phase("zero-shell-start"), { activeTasks: 0, activeShells: 1 }, "zero-shell-start");
  assertFreshPayload(phase("zero-shell-settle-1"), { activeTasks: 0, activeShells: 0 }, "zero-shell-settle-1");
  assertFreshPayload(phase("zero-shell-settle-2"), { activeTasks: 0, activeShells: 0 }, "zero-shell-settle-2");

  // Durable record bytes moved exactly once (the real settlement) and never
  // during any activity recovery.
  assert.match(result.sentinels.live, /^[0-9a-f]{64}$/u);
  assert.match(result.sentinels.settled, /^[0-9a-f]{64}$/u);
  assert.notEqual(result.sentinels.live, result.sentinels.settled,
    "the real interrupt settled and rewrote the durable record exactly once");
  assert.ok(result.final.updateCount >= 3, "repeated recovery published several authoritative statuses");
});

test("a genuinely unreadable live source stays unknown in the correlated request payload", { skip: process.platform === "win32" }, () => {
  const result = runScenario("unreadable-live");
  const payload = result.payload as {
    status: string;
    activeTasks: number | null;
    nativeSessionId: string | null;
    duringRequest: boolean;
  };
  assert.equal(payload.status, "complete");
  assert.equal(payload.duringRequest, true);
  assert.equal(payload.nativeSessionId, SESSION_ID);
  assert.equal(payload.activeTasks, null, "unreadable canonical evidence stays unknown");
  assert.notEqual(payload.activeTasks, 0, "unreadable evidence is never certified as zero");
  assert.ok((result.refreshCalls as number) > 0, "the request invoked the owning source");
  assert.match(result.renderedUnknown as string, /bg tasks unknown/u, "the rendered row shows truthful unknown at that exact reply");
});
