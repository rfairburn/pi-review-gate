/**
 * Issue #452 residual, real-host regression: a one-shot subtask watch
 * checkpoint that was still valid when Pi steered it must not keep asserting
 * "work remains active" after the owning session's model stopped being able to
 * read it truthfully.
 *
 * What the existing unit tiers already cover (and deliberately do not repeat
 * here): pre-send cancellation, the fire-time active-task check, one-shot
 * replacement, and quiet/noisy lanes. This file exercises the consumption
 * window in an actual `pi --mode rpc` agent loop with the compiled candidate,
 * real admitted subtasks (local `run-as-binary` executors; no provider
 * credentials), and a scripted faux model whose every REQUEST is journalled:
 *
 * 1. valid delivery (the base control): the checkpoint fires while the worker
 *    is still active and its text reaches a later provider request of the same
 *    run. An always-suppressing implementation fails here.
 * 2. settlement before consumption, NO abort: the checkpoint fires mid-tool,
 *    the worker is released and canonically settles while the steer is still
 *    queued, and the drain request that also carries the completion event must
 *    not carry that execution's active-work assertion.
 * 3. the aborted-run drain: a checkpoint fires while the session is busy in a
 *    long tool call; the test aborts the run, Pi drains the steer into the
 *    aborting teardown with NO provider request, and the recovery run's
 *    provider contexts must never carry that execution's active-work
 *    assertion. A no-guard candidate reproduces it (verified against the
 *    unpatched base build in the phase evidence).
 * 4. the same-drain user steer (the official finding): with the host's public
 *    `set_steering_mode` mode `all`, a checkpoint fires while a foreground tool
 *    is still busy and a real USER steering message is queued after the
 *    checkpoint fired but before the tool finishes. Both drain in the SAME
 *    turn, and one provider request must carry the valid checkpoint AND the
 *    user content before the run's natural stop, with the foreground command
 *    completing normally and that checkpoint's entry receiving NO context edit.
 *    An adjacency-only guard reproduces the false retirement here (verified
 *    against the unpatched base build in the phase evidence).
 * 5. raw history stays: every persisted `custom_message` checkpoint entry keeps
 *    its original text, and each suppression lands as Pi's append-only
 *    `context_edit` with `replacement: null` — future model context only.
 *
 * Worker lifetimes are held independently per admitted worker (one held marker
 * file per worker, released explicitly by the test), so a scenario can prove
 * the watched work was still canonically active at the queue/drain boundary
 * instead of racing an already-released executor.
 *
 * Skips when no installed Pi 1.x host or compiled candidate is available
 * (hard-fails under PI_REVIEW_GATE_REQUIRE_PI_HOST=1), matching the existing
 * real-host convention.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBgShellWakeFixture, type BgShellWakeFixture } from "./pi-native-bgshell-wake-fixture";
import { skipOrFail } from "./bridge-fakes";

const WATCH_ASSERTION = "is due while work remains active";
const SAME_DRAIN_STEER = "NATIVE-WATCH-SAME-DRAIN-STEER";

function checkPrerequisites(t: { skip(message?: string): void }): boolean {
  const candidate = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (!candidate || !existsSync(candidate)) {
    skipOrFail(t, "PI_REVIEW_GATE_CANDIDATE_ENTRY must name a scratch compiled candidate");
    return false;
  }
  if (process.platform === "win32") {
    t.skip("POSIX foreground bash fixture, not Windows evidence");
    return false;
  }
  try {
    createBgShellWakeFixture({ candidateEntry: null });
  } catch (error) {
    skipOrFail(t, error instanceof Error ? error.message : String(error));
    return false;
  }
  return true;
}

function stopSteps(count: number, label: string): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => ({ text: label }));
}

/** The owning session is idle when its newest boundary event is a settle. */
async function waitIdle(fixture: BgShellWakeFixture, timeoutMs = 90_000): Promise<boolean> {
  return await fixture.waitFor(() => {
    const events = fixture.journal().map((entry) => entry.event);
    return events.lastIndexOf("agent_settled") > events.lastIndexOf("agent_start");
  }, timeoutMs);
}

test("native watch checkpoints: valid delivery reaches the model, while a settled or aborted-run drain is withheld and raw history stays", { timeout: 420_000 }, async (t) => {
  if (!checkPrerequisites(t)) return;
  const candidate = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY!;
  const config = {
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      held: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [] as string[] },
      },
    },
    execution: {
      deferredPiTools: false,
      workerResources: { default: { selection: { source: "external", id: "held" }, maxConcurrent: 3 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  };
  let fixture: BgShellWakeFixture;
  try {
    fixture = createBgShellWakeFixture({
      candidateEntry: candidate,
      gateConfig: config,
      scratchParent: process.env.PI_REVIEW_GATE_SCRATCH_PARENT,
    });
  } catch (error) {
    skipOrFail(t, String(error));
    return;
  }
  // One held marker per admitted worker: the executor claims the lowest free
  // slot and stays active until the test writes that slot's .release file.
  const workerMarker = (slot: number) => join(fixture.paths.stateDir, `worker-${slot}`);
  const releaseMarker = (slot: number) => join(fixture.paths.stateDir, `worker-${slot}.release`);
  const releaseWorker = (slot: number): void => {
    writeFileSync(releaseMarker(slot), "done");
  };
  const heldWorkers = (): number[] => {
    try {
      return readdirSync(fixture.paths.stateDir)
        .filter((name) => /^worker-\d+$/.test(name))
        .map((name) => Number(name.slice("worker-".length)))
        .sort((left, right) => left - right);
    } catch {
      return [];
    }
  };
  config.externalAgents.held.execution.args = ["-e", `const fs=require('node:fs'),path=require('node:path');
const dir=${JSON.stringify(fixture.paths.stateDir)};
let mine=null;
for(let slot=1;slot<=8;slot++){const p=path.join(dir,'worker-'+slot);try{fs.writeFileSync(p,'held',{flag:'wx'});mine=p;break;}catch{}}
console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));
const timer=setInterval(()=>{if(mine&&fs.existsSync(mine+'.release')){clearInterval(timer);console.log(JSON.stringify({type:'assistant',text:'done'}));}},30);`];
  t.after(async () => {
    // Release every still-held worker before terminating its owning session;
    // a worker that cannot be verified as settled leaves the scratch retained.
    for (const slot of heldWorkers()) {
      if (!existsSync(releaseMarker(slot))) releaseWorker(slot);
    }
    const settled = await fixture.waitFor(() => {
      const events = fixture.journal();
      const starts = events.filter((entry) => entry.event === "message_start" && entry.customType === "pi-review-subtask-launch");
      const settledExecutions = new Set(events.filter((entry) => entry.event === "message_start"
        && entry.customType === "pi-review-subtask-event"
        && /landed independently|at state LANDED/.test(entry.preview ?? ""))
        .map((entry) => entry.preview?.match(/exec-[0-9a-f-]+/)?.[0]));
      return starts.map((entry) => entry.preview?.match(/exec-[0-9a-f-]+/)?.[0])
        .every((id) => id === undefined || settledExecutions.has(id));
    }, 90_000);
    await fixture.dispose({ retainScratch: !settled });
  });

  await fixture.start(stopSteps(20, "native-watch-idle-ack"));

  /** Admit one real subtask through the registered human command and return its execution handle. */
  async function addExecution(title: string, expectedSlot: number): Promise<string> {
    const marker = fixture.journal().length;
    await fixture.prompt(`/subtask-add ${title}`);
    assert.ok(await fixture.waitFor(() => fixture.journal().slice(marker).some((entry) => entry.customType === "pi-review-subtask-launch" && entry.event === "message_start"), 90_000),
      `launch notice missing for ${title}; journal=${JSON.stringify(fixture.journal().slice(marker))}\n${fixture.stderr}`);
    const executionId = fixture.journal().slice(marker)
      .map((entry) => entry.preview?.match(/exec-[0-9a-f-]+/)?.[0])
      .find((id): id is string => id !== undefined);
    assert.ok(executionId, `execution handle missing for ${title}`);
    // Canonical proof that THIS scenario's worker is the one being held: the
    // expected slot marker exists and its release does not.
    assert.ok(await fixture.waitFor(() => existsSync(workerMarker(expectedSlot)), 60_000),
      `worker slot ${expectedSlot} was never claimed for ${title}; held=${JSON.stringify(heldWorkers())}`);
    assert.ok(!existsSync(releaseMarker(expectedSlot)), `worker slot ${expectedSlot} was released before its scenario`);
    assert.ok(await waitIdle(fixture), `the launch notice run for ${title} never settled; ${fixture.stderr}`);
    return executionId;
  }

  /** Arm a one-shot checkpoint in its own idle run and prove the arm result. The
   * delay is long enough that the deadline passes during the NEXT run's tool
   * call, so the queued checkpoint is genuinely pending at that boundary. */
  async function armWatch(executionId: string, after: string): Promise<void> {
    const marker = fixture.journal().length;
    await fixture.setTurnScript([
      { toolCalls: [{ toolName: "SubtasksWatch", arguments: { executionId, after } }] },
      ...stopSteps(4, "native-watch-armed-ack"),
    ]);
    await fixture.prompt(`arm one checkpoint for ${executionId}`);
    assert.ok(await fixture.waitFor(() => fixture.journal().slice(marker).some((entry) => entry.event === "message_end"
      && entry.role === "toolResult"
      && new RegExp(`SubtasksWatch armed for ${executionId}`).test(entry.preview ?? "")), 60_000),
    `the checkpoint was never armed for ${executionId}; journal=${JSON.stringify(fixture.journal().slice(marker))}\n${fixture.stderr}`);
    assert.ok(await waitIdle(fixture), `the arming run for ${executionId} never settled; ${fixture.stderr}`);
  }

  // ── Scenario 1: a checkpoint that fires while work is genuinely active ─────
  const executionA = await addExecution("NATIVE-WATCH-VALID", 1);
  await armWatch(executionA, "3s");
  // The busy run contains no arming step: an injected checkpoint resets the
  // probe's step counter, and replaying an arm step would keep re-arming.
  await fixture.setTurnScript([
    { toolCalls: [
      { toolName: "ShellStart", arguments: { command: "sleep 4; echo watch-sibling", label: "watch-sibling", wake_on: { exit: true } } },
      { toolName: "bash", arguments: { command: "sleep 6; echo busy-a" } },
    ] },
    ...stopSteps(8, "native-watch-valid-ack"),
  ]);
  const validBegin = fixture.journal().length;
  await fixture.prompt("stay busy while the checkpoint is pending");
  // The provider actually saw the deliberate checkpoint while the worker was
  // still active: this is the delivery proof AND the control that keeps any
  // blanket-suppression change from passing this file. (A custom message is
  // represented as a user message in native model context, which is also why
  // the scripted step index is rewritten below.)
  assert.ok(await fixture.waitFor(() => fixture.modelRequests().some((entry) => (entry.transcriptPreview ?? []).some((message) => (message.preview ?? "").includes(`${executionA} ${WATCH_ASSERTION}`))), 60_000),
    `a valid checkpoint never reached a provider request; requests=${JSON.stringify(fixture.modelRequests())}\n${fixture.stderr}`);
  const validRun = fixture.journal().slice(validBegin);
  const validInjection = validRun.findIndex((entry) => entry.event === "message_start"
    && entry.customType === "pi-review-subtask-watch");
  assert.ok(validInjection >= 0, "the live watch was injected during the busy run");
  const priorResponse = validRun.slice(0, validInjection).reverse()
    .find((entry) => entry.event === "message_end" && entry.role === "assistant");
  assert.match(priorResponse?.preview ?? "", /toolCall:bash/, "watch steered at a tool boundary before natural stop");
  assert.ok(validRun.some((entry) => entry.event === "model_request"
    && (entry.transcriptPreview ?? []).some((message) => message.role === "toolResult"
      && (message.preview ?? "").includes("busy-a"))), "the in-flight command finished normally before watch consumption");
  assert.ok(validRun.some((entry) => entry.event === "message_start"
    && entry.customType === "pi-review-bg-shell" && (entry.preview ?? "").includes("watch-sibling")),
  "another eligible notification shared the native drain without suppressing the valid watch");
  assert.ok(!validRun.some((entry) => entry.stopReason === "aborted" || entry.stopReason === "error"),
    "watch delivery did not abort or fail the busy parent");
  await fixture.setTurnScript(stopSteps(6, "native-watch-valid-ack"));
  releaseWorker(1);
  assert.ok(await fixture.waitFor(() => fixture.journal().some((entry) => entry.event === "message_start"
    && entry.customType === "pi-review-subtask-event"
    && (entry.preview ?? "").includes(executionA)), 90_000), `the first execution never settled; ${fixture.stderr}`);
  assert.ok(await waitIdle(fixture), `the settlement run for ${executionA} never settled; ${fixture.stderr}`);

  // ── Scenario 2: settlement lands while the queued checkpoint is unconsumed ─
  const executionC = await addExecution("NATIVE-WATCH-SETTLED", 2);
  // The deadline must pass clearly INSIDE the next run's tool call and clearly
  // BEFORE the release, so the checkpoint is genuinely fired-but-unconsumed
  // when the work settles.
  await armWatch(executionC, "3s");
  const settleMarker = fixture.journal().length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "bash", arguments: { command: "sleep 9; echo busy-c" } }] },
    ...stopSteps(10, "native-watch-settled-ack"),
  ]);
  await fixture.prompt("run a long tool while the checkpoint is queued");
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(settleMarker).some((entry) => entry.event === "message_end"
    && entry.role === "assistant" && /toolCall:bash/.test(entry.preview ?? "")), 60_000),
  `the long tool call never started; journal=${JSON.stringify(fixture.journal().slice(settleMarker))}\n${fixture.stderr}`);
  // The deadline (arm + 5s) passes mid-tool at about tool+3s; only then is the
  // worker released, so it settles well before the drain boundary that follows
  // the tool result.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  releaseWorker(2);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(settleMarker).some((entry) => entry.event === "message_start"
    && entry.customType === "pi-review-subtask-event"
    && (entry.preview ?? "").includes(executionC)), 60_000),
  `the settled execution's notification never arrived; journal=${JSON.stringify(fixture.journal().slice(settleMarker))}\n${fixture.stderr}`);
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(settleMarker).some((entry) => entry.event === "message_start"
    && entry.customType === "pi-review-subtask-watch"), 90_000),
  `the queued checkpoint was never injected; journal=${JSON.stringify(fixture.journal().slice(settleMarker))}\n${fixture.stderr}`);
  await fixture.setTurnScript(stopSteps(10, "native-watch-settled-ack"));
  assert.ok(await waitIdle(fixture), `the settlement run for ${executionC} never settled; ${fixture.stderr}`);
  for (const request of fixture.journal().slice(settleMarker).filter((entry) => entry.event === "model_request")) {
    const stale = (request.transcriptPreview ?? []).filter((message) => (message.preview ?? "").includes(`${executionC} ${WATCH_ASSERTION}`));
    assert.deepEqual(stale, [], `a checkpoint whose work settled re-asserted active work: ${JSON.stringify(request)}\n${fixture.stderr}`);
  }

  // ── Scenario 3: the checkpoint fires, then the run is aborted mid-tool ─────
  const executionB = await addExecution("NATIVE-WATCH-ABORTED", 3);
  // Arming 3s before the long tool call's own start point puts the deadline
  // clearly inside the tool call and clearly before the abort, so the queued
  // checkpoint is pending at the teardown drain instead of racing it.
  await armWatch(executionB, "3s");
  const beforeAbort = fixture.journal().length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "bash", arguments: { command: "sleep 9; echo busy-b" } }] },
    ...stopSteps(6, "native-watch-abort-ack"),
  ]);
  await fixture.prompt("run a long tool while the checkpoint is pending");
  // The deadline passes while the long tool call is still running, so Pi holds
  // the steer until the abort drains it into the aborting run's teardown. The
  // worker is deliberately NOT released: the work stays canonically active.
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(beforeAbort).some((entry) => entry.event === "message_end"
    && entry.role === "assistant" && /toolCall:bash/.test(entry.preview ?? "")), 60_000),
  `the long tool call never started; journal=${JSON.stringify(fixture.journal().slice(beforeAbort))}\n${fixture.stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  await fixture.abort();
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(beforeAbort).some((entry) => entry.event === "agent_settled"), 90_000), fixture.stderr);
  const abortedRun = fixture.journal().slice(beforeAbort);
  const injection = abortedRun.findIndex((entry) => entry.event === "message_start" && entry.customType === "pi-review-subtask-watch");
  assert.ok(injection >= 0, `the queued checkpoint was never drained into the aborting run; journal=${JSON.stringify(abortedRun)}\n${fixture.stderr}`);
  const teardownResponse = abortedRun.slice(injection).find((entry) => entry.event === "message_end" && entry.role === "assistant" && !/toolCall:/.test(entry.preview ?? ""));
  assert.ok(teardownResponse && !["stop", "toolUse", "length"].includes(String(teardownResponse.stopReason ?? "")),
    `the aborting run ended with a completing response; the stale window was not reproduced: ${JSON.stringify(abortedRun.slice(injection))}`);
  assert.ok(!abortedRun.some((entry) => entry.event === "message_start" && entry.customType === "pi-review-subtask-event"
    && (entry.preview ?? "").includes(executionB)),
  `the held worker settled during the aborted scenario; the watch was not actually pending: ${JSON.stringify(abortedRun)}`);

  // ── Recovery run: the unconsumed checkpoint must never assert active work ──
  const recoveryBegin = fixture.journal().length;
  await fixture.setTurnScript(stopSteps(4, "native-watch-recovery-ack"));
  await fixture.prompt("recover after the abort");
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(recoveryBegin).some((entry) => entry.event === "model_request"), 60_000), fixture.stderr);
  const recoveryRequests = fixture.modelRequests().filter((entry) => entry.ts >= fixture.journal()[recoveryBegin]!.ts);
  assert.ok(recoveryRequests.length >= 1, "the recovery run made no provider request");
  for (const request of recoveryRequests) {
    const stale = (request.transcriptPreview ?? []).filter((message) => (message.preview ?? "").includes(`${executionB} ${WATCH_ASSERTION}`));
    assert.deepEqual(stale, [], `the unconsumed aborted-run checkpoint re-asserted active work in a recovery request: ${JSON.stringify(request)}\n${fixture.stderr}`);
  }

  assert.ok(await waitIdle(fixture), "the recovery run settled before checking durable omission");
  const laterBegin = fixture.journal().length;
  await fixture.prompt("continue after the successful recovery response");
  assert.ok(await waitIdle(fixture), "the later run settled");
  const laterRequests = fixture.journal().slice(laterBegin).filter((entry) => entry.event === "model_request");
  assert.ok(laterRequests.length > 0, "a later run actually consumed context after the recovery success");
  for (const request of laterRequests) {
    assert.ok(!(request.transcriptPreview ?? []).some((message) =>
      (message.preview ?? "").includes(`${executionB} ${WATCH_ASSERTION}`)),
    "a successful recovery must not rehabilitate the omitted checkpoint in a later run");
  }

  // ── Scenario 4: a real user steer drains in the SAME turn as the checkpoint ─
  // Pi's supported queue mode (`set_steering_mode` mode `all`) releases a due
  // checkpoint and a queued user message together at the turn boundary. The
  // user message is same-drain traffic, not a new turn, so withholding the
  // still-valid checkpoint and editing its entry out of future context is the
  // failure this regression pins.
  const executionD = await addExecution("NATIVE-WATCH-SAME-DRAIN", 4);
  await fixture.rpc("set_steering_mode", { mode: "all" });
  const sameDrainDelayMs = 6_000;
  await armWatch(executionD, "6s");
  // The arm completed no later than this instant, so the checkpoint's deadline
  // is at most `sameDrainDelayMs` ahead of it. The busy run below starts
  // immediately and its foreground command outlives that deadline by a wide
  // margin, so the checkpoint is genuinely QUEUED (never yet injected or read)
  // when the user steering message is sent behind it.
  const armedNoLaterThan = Date.now();
  const drainBegin = fixture.journal().length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "bash", arguments: { command: "sleep 14; echo busy-d" } }] },
    ...stopSteps(12, "native-watch-same-drain-ack"),
  ]);
  await fixture.prompt("run a long tool while the checkpoint is pending");
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(drainBegin).some((entry) => entry.event === "message_end"
    && entry.role === "assistant" && /toolCall:bash/.test(entry.preview ?? "")), 60_000),
  `the long tool call never started; journal=${JSON.stringify(fixture.journal().slice(drainBegin))}\n${fixture.stderr}`);
  // Past the deadline, still inside the foreground command: queue the real USER
  // steering message AFTER the checkpoint fired and BEFORE the tool finishes.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, armedNoLaterThan + sameDrainDelayMs + 2_000 - Date.now())));
  const steerDisposition = await fixture.rpc("steer", { message: `${SAME_DRAIN_STEER} use the other flag` });
  assert.match(JSON.stringify(steerDisposition), /queued/, `the user steering message was not queued: ${JSON.stringify(steerDisposition)}\n${fixture.stderr}`);
  // The drain is journalled in quick succession — the checkpoint injection,
  // the user steering behind it, then the provider request they both feed — so
  // wait for the whole boundary before snapshotting. A poll that lands inside
  // that batch must not read a half-written run; the content assertions below
  // stay exactly as they are, so the unpatched control still fails for
  // withholding the still-valid checkpoint.
  let drainBoundary: { run: ReturnType<typeof fixture.journal>; watchStart: number; userStart: number } | undefined;
  assert.ok(await fixture.waitFor(() => {
    const run = fixture.journal().slice(drainBegin);
    const watch = run.findIndex((entry) => entry.event === "message_start"
      && entry.customType === "pi-review-subtask-watch");
    const steer = run.findIndex((entry) => entry.event === "message_start" && entry.role === "user"
      && (entry.preview ?? "").includes(SAME_DRAIN_STEER));
    if (watch < 0 || steer <= watch || !run.slice(steer + 1).some((entry) => entry.event === "model_request")) return false;
    drainBoundary = { run, watchStart: watch, userStart: steer };
    return true;
  }, 90_000),
  `the due checkpoint and the queued user steering were never drained into one provider request; journal=${JSON.stringify(fixture.journal().slice(drainBegin))}\n${fixture.stderr}`);
  const { run: drainRun, watchStart, userStart } = drainBoundary!;
  // The checkpoint was still pending through every earlier request of this run:
  // none of them carried it, so the drain request is genuinely its first.
  const carriesCheckpoint = (entry: { transcriptPreview?: Array<{ preview?: string }> }) => (entry.transcriptPreview ?? [])
    .some((message) => (message.preview ?? "").includes(`${executionD} ${WATCH_ASSERTION}`));
  const beforeDrain = drainRun.slice(0, watchStart).filter((entry) => entry.event === "model_request");
  assert.ok(beforeDrain.length >= 1, "the busy run made no provider request before the checkpoint drained");
  for (const request of beforeDrain) {
    assert.ok(!carriesCheckpoint(request), `the still-queued checkpoint reached an earlier request: ${JSON.stringify(request)}`);
  }
  // One turn drained both messages: no assistant response separates them, and
  // the drain request itself carries the valid checkpoint AND the user content.
  const drainRequestOffset = drainRun.slice(userStart).findIndex((entry) => entry.event === "model_request");
  assert.ok(drainRequestOffset >= 0, `no provider request followed the drain: ${JSON.stringify(drainRun.slice(userStart))}\n${fixture.stderr}`);
  assert.ok(!drainRun.slice(watchStart, userStart + drainRequestOffset).some((entry) => entry.event === "message_end" && entry.role === "assistant"),
    "the checkpoint and the user steering drained in the SAME turn, with no response between them");
  const drainRequest = drainRun[userStart + drainRequestOffset]!;
  assert.ok(carriesCheckpoint(drainRequest),
    `the same-drain request withheld a still-valid checkpoint: ${JSON.stringify(drainRequest)}\n${fixture.stderr}`);
  assert.ok((drainRequest.transcriptPreview ?? []).some((message) => (message.preview ?? "").includes(SAME_DRAIN_STEER)),
    `the same-drain request lost the queued user steering: ${JSON.stringify(drainRequest)}\n${fixture.stderr}`);
  // The probe indexes scripted steps from the newest user message, so the drain
  // itself re-reads step zero; rewrite the script now that the drain is proven.
  await fixture.setTurnScript(stopSteps(12, "native-watch-same-drain-ack"));
  // The in-flight command completed normally into context, and nothing in the
  // drain run was aborted or errored: this is a clean same-drain delivery.
  assert.ok(await fixture.waitFor(() => fixture.journal().slice(drainBegin).some((entry) => entry.event === "model_request"
    && (entry.transcriptPreview ?? []).some((message) => message.role === "toolResult"
      && (message.preview ?? "").includes("busy-d"))), 90_000),
  `the foreground command never completed into context; ${fixture.stderr}`);
  assert.ok(!fixture.journal().slice(drainBegin).some((entry) => entry.stopReason === "aborted" || entry.stopReason === "error"),
    `the same-drain run aborted or failed: ${JSON.stringify(fixture.journal().slice(drainBegin))}\n${fixture.stderr}`);
  assert.ok(drainRun.slice(0, watchStart).some((entry) => entry.event === "message_end" && entry.role === "toolResult"),
    "both messages drained after the completed foreground tool result");
  await fixture.setTurnScript(stopSteps(10, "native-watch-same-drain-ack"));
  releaseWorker(4);
  assert.ok(await fixture.waitFor(() => fixture.journal().some((entry) => entry.event === "message_start"
    && entry.customType === "pi-review-subtask-event"
    && (entry.preview ?? "").includes(executionD)), 90_000), `the fourth execution never settled; ${fixture.stderr}`);
  assert.ok(await waitIdle(fixture), `the settlement run for ${executionD} never settled; ${fixture.stderr}`);

  // ── Raw history: unchanged entries, append-only context edits only ─────────
  const { readFile, readdir } = await import("node:fs/promises");
  const sessionFiles = await readdir(fixture.paths.sessionsDir);
  const watchEntries: Array<{ id: string; executionIds: string[]; content: string }> = [];
  const edits = new Map<string, { content: string } | null>();
  for (const file of sessionFiles.filter((name) => name.endsWith(".jsonl"))) {
    const text = await readFile(join(fixture.paths.sessionsDir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type === "custom_message" && entry.customType === "pi-review-subtask-watch"
        && typeof entry.id === "string" && typeof entry.content === "string") {
        const watches = (entry.details as { watches?: Array<{ executionId: string }> } | undefined)?.watches ?? [];
        watchEntries.push({ id: entry.id, executionIds: watches.map((watch) => watch.executionId), content: entry.content });
      }
      if (entry.type === "context_edit" && typeof entry.targetId === "string") {
        edits.set(entry.targetId, typeof (entry.replacement as { content?: string } | undefined)?.content === "string"
          ? { content: (entry.replacement as { content: string }).content }
          : null);
      }
    }
  }
  const entryA = watchEntries.find((entry) => entry.executionIds.includes(executionA));
  const entryC = watchEntries.find((entry) => entry.executionIds.includes(executionC));
  const entryB = watchEntries.find((entry) => entry.executionIds.includes(executionB));
  const entryD = watchEntries.find((entry) => entry.executionIds.includes(executionD));
  assert.ok(entryA && entryB && entryC && entryD, `all four checkpoint entries must stay in raw history; saw ${JSON.stringify(watchEntries.map((entry) => entry.executionIds))}`);
  for (const entry of [entryA!, entryB!, entryC!, entryD!]) {
    assert.ok(entry.content.includes(WATCH_ASSERTION), "raw checkpoint history must keep its original text verbatim");
  }
  assert.ok(edits.get(entryB!.id) === null, "the never-consumed aborted-run checkpoint was not omitted from future context by an append-only context_edit");
  assert.ok(edits.get(entryC!.id) === null, "the never-consumed settled checkpoint was not omitted from future context by an append-only context_edit");
  assert.ok(!edits.has(entryA!.id), "the consumed checkpoint's history must stay in future model context");
  assert.ok(!edits.has(entryD!.id), "the valid checkpoint drained beside a user steer must never be edited out of future context");
});
