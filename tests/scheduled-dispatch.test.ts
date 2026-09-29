/**
 * Issue #222: the per-entry schedule-destination dispatch shared by the
 * scheduler runtime (src/index.ts). These tests pin the routing contract of
 * both destinations, the shared launch-notice/gate ordering on the subtask
 * destination, and the fail-closed reporting paths — overlap skip, overdue
 * drop, dispatch failure, and orchestrator-turn delivery failure — so no
 * failure path can ever report silent success or dispatch a duplicate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledTaskEntryConfig } from "../src/config";
import type { BackgroundInspection } from "../src/execution/background-controller";
import type { ScheduledEntryDispatchHost } from "../src/scheduling/dispatch";
import { deliverSubtaskLaunchNotice } from "../src/execution/launch-notice";
import type { SubtaskLaunchNotice } from "../src/execution/launch-notice";
import { createScheduledEntryDispatcher } from "../src/scheduling/dispatch";
import { ScheduledOrchestratorTurnTracker } from "../src/scheduling/orchestrator-turn";

const dueBase = new Date(2024, 5, 1, 9, 30);

function subtaskEntry(overrides: Partial<ScheduledTaskEntryConfig> = {}): ScheduledTaskEntryConfig {
  return {
    name: "Nightly docs check",
    cron: "30 2 * * *",
    enabled: true,
    kind: "execute",
    instructions: "Check the docs for staleness",
    workspace: "/tmp/prg-dispatch",
    ...overrides,
  };
}

function orchestratorEntry(overrides: Partial<ScheduledTaskEntryConfig> = {}): ScheduledTaskEntryConfig {
  return {
    name: "Daily summary",
    cron: "0 8 * * *",
    enabled: true,
    kind: "execute",
    destination: "orchestrator-turn",
    instructions: "Produce the daily summary",
    workspace: "/tmp/prg-dispatch",
    ...overrides,
  };
}

interface HarnessOptions {
  runs?: Array<{ executionId: string; kind: "execute" | "research"; tasks: Array<{ taskId: string; title: string; state: string }> }>;
  startError?: Error;
  piMessage?: boolean;
  turnEndTracking?: "host-lifecycle-hooks" | "unavailable";
  uiNoticeRejects?: boolean;
  orchestratorDeliveryTimeoutMs?: number;
  orchestratorUnsafeReason?: string;
}

function harness(options: HarnessOptions = {}) {
  const started: Array<{ definition: unknown; kind: "execute" | "research"; workspace: string | undefined; options: Record<string, unknown> }> = [];
  const ownerEvents: string[] = [];
  const uiNotices: string[] = [];
  const consoleWarnings: string[] = [];
  const launches: Array<{ notice: unknown }> = [];
  const imageChecks: string[] = [];
  const piMessages: Array<{ message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }; delivery: unknown }> = [];
  const orchestratorTurns = new ScheduledOrchestratorTurnTracker();
  orchestratorTurns.setTurnEndTracking(options.turnEndTracking ?? "host-lifecycle-hooks");
  const toolsAndHost = {
    started,
    ownerEvents,
    uiNotices,
    consoleWarnings,
    launches,
    imageChecks,
    piMessages,
    orchestratorTurns,
  };
  const host: ScheduledEntryDispatchHost & typeof toolsAndHost = {
    ...toolsAndHost,
    pi: options.piMessage === false ? {} : {
      sendMessage: (message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }, delivery: unknown) => {
        piMessages.push({ message, delivery });
      },
    },
    executionTools: {
      startScheduled: async (_definition, kind, workspace, startOptions) => {
        started.push({ definition: _definition, kind, workspace, options: { ...startOptions } });
        if (options.startError) throw options.startError;
        return {
          executionId: "exec-admitted",
          kind,
          tasks: [{ taskId: "task-admitted", definition: { title: `Scheduled ${kind} task task-1: Nightly docs check` }, state: "queued" }],
        } as unknown as BackgroundInspection;
      },
      scheduledRuns: (scheduledTaskId: string) => {
        void scheduledTaskId;
        return options.runs ?? [];
      },
    },
    reportOwnerEvent: async (content: string) => {
      ownerEvents.push(content);
    },
    orchestratorTurnUnsafeReason: () => options.orchestratorUnsafeReason,
    uiNotice: async (message: string): Promise<void> => {
      if (options.uiNoticeRejects) throw new Error("ui channel rejected the notification");
      uiNotices.push(message);
    },
    consoleWarn: (message: string) => {
      consoleWarnings.push(message);
    },
    deliverLaunchNotice: async (notice: SubtaskLaunchNotice) => {
      launches.push({ notice: notice as unknown as Record<string, unknown> });
      return "delivered" as const;
    },
    orchestratorDeliveryTimeoutMs: options.orchestratorDeliveryTimeoutMs,
    checkScheduledImages: async (entry: ScheduledTaskEntryConfig) => {
      imageChecks.push(entry.instructions);
    },
    orchestratorTurns,
  };
  const dispatch = createScheduledEntryDispatcher(host);
  return { dispatch, host };
}

test("an idle subtask entry admits through startScheduled with its overrides, its shared launch notice, and a resolved gate", async () => {
  const { dispatch, host } = harness();
  const dueAt = new Date(dueBase);
  await dispatch("task-1", subtaskEntry({ workerResourceId: "local", review: { mode: "off" } }), dueAt, false);

  // Exactly one admission through the ordinary subtask start path.
  assert.equal(host.started.length, 1);
  const start = host.started[0]!;
  assert.equal(start.kind, "execute");
  assert.equal(start.workspace, "/tmp/prg-dispatch");
  assert.equal(start.options.scheduledTaskId, "task-1");
  assert.equal(start.options.workerResourceId, "local");
  assert.deepEqual(start.options.reviewOverride, { mode: "off" });
  // The definition carries the instructions verbatim with explicit identity.
  const definition = start.definition as { instructions: string; title: string };
  assert.equal(definition.instructions, "Check the docs for staleness");
  assert.match(definition.title, /task-1/);
  // The managed-image check runs before admission.
  assert.deepEqual(host.imageChecks, ["Check the docs for staleness"]);

  // One shared launch notice with scheduled origin metadata; the gate the
  // controller holds is resolved by the time the dispatch promise settles.
  assert.equal(host.launches.length, 1);
  const notice = host.launches[0]!.notice as { origin: string; executionId: string; scheduled: { entryId: string; dueAt: Date }; tasks: Array<{ taskId: string }> };
  assert.equal(notice.origin, "scheduled");
  assert.equal(notice.executionId, "exec-admitted");
  assert.equal(notice.scheduled.entryId, "task-1");
  assert.equal(notice.scheduled.dueAt.getTime(), dueAt.getTime());
  assert.equal(notice.tasks[0]!.taskId, "task-admitted");
  const gate = start.options.launchNoticeGate as Promise<void>;
  await gate; // resolved by the dispatcher
  // The UI notice stays, and it does not claim any outcome.
  assert.ok(host.uiNotices[0]!.includes("dispatched as exec-admitted"));
  assert.equal(host.ownerEvents.length, 0);
});

test("subtask notices remain causally ordered: the gate resolves only after the delivery attempt", async () => {
  const { dispatch, host } = harness({ piMessage: false });
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), false);
  assert.equal(host.launches.length, 1);
  const gate = host.started[0]!.options.launchNoticeGate as Promise<void>;
  // Even when the model channel is unavailable the gate has resolved — the
  // outcome notifications can never be stranded behind a dead notice.
  await gate;
});

test("a busy entry's due occurrence is reported as a skip with active handles and dispatches nothing", async () => {
  const { dispatch, host } = harness({
    runs: [{ executionId: "exec-active", kind: "execute", tasks: [{ taskId: "task-active", title: "T", state: "running" }] }],
  });
  const dueAt = new Date(dueBase);
  await dispatch("task-1", subtaskEntry(), dueAt, false);
  await dispatch("task-1", subtaskEntry(), dueAt, true);

  assert.equal(host.started.length, 0, "no duplicate dispatch behind an active run");
  assert.equal(host.launches.length, 0);
  assert.equal(host.ownerEvents.length, 2);
  // Both admissions skip: the active run gates every due occurrence.
  assert.match(host.ownerEvents[0]!, /was SKIPPED/);
  assert.match(host.ownerEvents[0]!, /exec-active.*task-active.*running/s);
  assert.match(host.ownerEvents[1]!, /was SKIPPED/);
  assert.ok(!/NOT RUN/.test(host.ownerEvents[1]!), "an active run turns the overdue occurrence into a skip");
});

test("an overdue occurrence with no active run is reported as not-run and never catches up", async () => {
  const { dispatch, host } = harness();
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), true);
  assert.equal(host.started.length, 0);
  assert.equal(host.launches.length, 0);
  assert.equal(host.ownerEvents.length, 1);
  assert.match(host.ownerEvents[0]!, /NOT RUN/);
  assert.match(host.ownerEvents[0]!, /no catch-up run is started/);
});

test("a failed subtask dispatch fails closed with an actionable wake and no notice", async () => {
  const { dispatch, host } = harness({ startError: new Error("no execute worker route is configured") });
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), false);
  assert.equal(host.started.length, 1);
  assert.equal(host.launches.length, 0, "no launch notice follows a rejected admission");
  assert.equal(host.ownerEvents.length, 1);
  assert.match(host.ownerEvents[0]!, /dispatch failed:/);
  assert.match(host.ownerEvents[0]!, /no execute worker route is configured/);
  assert.match(host.ownerEvents[0]!, /The occurrence was not run\./);
  assert.equal(host.uiNotices.length, 0);
});

test("a missing managed scheduled image fails the subtask dispatch closed before admission", async () => {
  const { dispatch, host } = harness();
  host.checkScheduledImages = async () => {
    throw new Error("scheduled image no longer exists: /managed/missing.png");
  };
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), false);
  assert.equal(host.started.length, 0);
  assert.equal(host.launches.length, 0);
  assert.equal(host.ownerEvents.length, 1);
  assert.match(host.ownerEvents[0]!, /dispatch failed:/);
  assert.match(host.ownerEvents[0]!, /scheduled image no longer exists/);
});

test("an orchestrator-turn due occurrence delivers a triggered turn to the existing agent and records the occurrence", async () => {
  const { dispatch, host } = harness();
  const dueAt = new Date(dueBase);
  await dispatch("task-turn", orchestratorEntry(), dueAt, false);

  // No subprocess, no subtask machinery, no cwd override: the existing agent
  // receives one delivered message on the follow-up turn lane.
  assert.equal(host.started.length, 0);
  assert.equal(host.piMessages.length, 1);
  const { message, delivery } = host.piMessages[0]!;
  assert.equal(message.customType, "pi-review-scheduled-orchestrator-turn");
  assert.deepEqual(delivery, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(message.details.entryId, "task-turn");
  assert.equal(message.details.dueAt, dueAt.toISOString());
  // The opaque per-occurrence identity is carried in the message details and
  // registered BEFORE the send: the occurrence is pending immediately.
  assert.match(String(message.details.occurrenceId), /^[0-9a-f-]{36}$/);
  assert.ok(message.content.includes("Produce the daily summary"));
  assert.ok(message.content.includes("no workspace override applies") || message.content.includes("current Pi launch workspace"));

  // The occurrence is pending with the scheduling identity and it has NOT
  // been settled by delivery: completion waits for the host's message_start
  // observation of this exact message inside a run, that run's end, and a
  // settlement.
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 1);
  const occurrence = host.orchestratorTurns.pendingOccurrences()[0]!;
  assert.equal(occurrence.entryId, "task-turn");
  assert.equal(occurrence.occurrenceId, message.details.occurrenceId);
  assert.equal(occurrence.settledAt, undefined);
  assert.equal(occurrence.processedAt, undefined);
  // The occurrence identity matches the sampled due minute, not dispatch time.
  assert.equal(occurrence.dueAt.getTime(), dueAt.getTime());

  // The UI notice stays truthful about what happened (delivered, not done).
  assert.equal(host.uiNotices.length, 1);
  assert.match(host.uiNotices[0]!, /delivered as an orchestrator turn/);
  assert.match(host.uiNotices[0]!, /completes when its initiating turn ends/);
  assert.equal(host.ownerEvents.length, 0);
  // The managed-image check applies to this destination too (same instructions).
  assert.deepEqual(host.imageChecks, ["Produce the daily summary"]);
});

test("an overdue orchestrator occurrence is reported as not-run and delivered nowhere", async () => {
  const { dispatch, host } = harness();
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), true);
  assert.equal(host.piMessages.length, 0);
  assert.equal(host.started.length, 0);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 0);
  assert.equal(host.ownerEvents.length, 1);
  assert.match(host.ownerEvents[0]!, /NOT RUN/);
});

test("an orchestrator-turn delivery that cannot be performed fails closed without recording an occurrence", async () => {
  const { dispatch, host } = harness({ piMessage: false });
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  assert.equal(host.piMessages.length, 0);
  assert.equal(host.started.length, 0);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 0, "nothing was delivered, so nothing is recorded");
  assert.equal(host.ownerEvents.length, 1);
  assert.match(host.ownerEvents[0]!, /could not be delivered to the existing agent/);
  assert.match(host.ownerEvents[0]!, /NOT delivered/);
  assert.match(host.ownerEvents[0]!, /nothing was queued or executed/);
  assert.equal(host.uiNotices.length, 0);
});

test("a host that cannot arm or attribute scheduled turns has the dispatch rejected before anything is sent", async () => {
  const { dispatch, host } = harness({
    orchestratorUnsafeReason: "the host does not expose the agent run-lifecycle hooks (agent_start, message_start, agent_end, agent_settled) this destination requires to arm review before the scheduled turn's model request and to attribute and settle the occurrence",
  });
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  // Fail-closed rejection: the unsafe turn was NEVER delivered (an unreviewed
  // turn on a hook-less host is never allowed).
  assert.equal(host.piMessages.length, 0, "nothing was delivered to the model");
  assert.equal(host.started.length, 0);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 0, "no occurrence exists for a dispatch that never sent");
  assert.equal(host.ownerEvents.length, 0, "the limitation must not be a model-facing scheduler wake");
  assert.equal(host.consoleWarnings.length, 1, "the limitation is reported through the non-triggering console channel");
  assert.match(host.consoleWarnings[0]!, /could not be delivered to the existing agent/);
  assert.match(host.consoleWarnings[0]!, /run-lifecycle hooks/);
  assert.match(host.consoleWarnings[0]!, /NOT delivered/);
  assert.equal(host.uiNotices.length, 0);
});

test("a blocked review restart rejects the orchestrator dispatch fail-closed before anything is sent", async () => {
  const { dispatch, host } = harness({ orchestratorUnsafeReason: "the review gate is blocked for this session (fresh checkpoint restart failed: errno ENOENT), so the scheduled turn could not be reviewed; nothing was delivered" });
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  assert.equal(host.piMessages.length, 0);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 0);
  assert.equal(host.ownerEvents.length, 0, "a blocked review gate cannot be woken with another model turn");
  assert.equal(host.consoleWarnings.length, 1);
  assert.match(host.consoleWarnings[0]!, /could not be delivered to the existing agent/);
  assert.match(host.consoleWarnings[0]!, /fresh checkpoint restart failed/);
  assert.equal(host.uiNotices.length, 0);
});

test("a failed orchestrator delivery attempt is reported, not swallowed", async () => {
  const { dispatch, host } = harness();
  host.pi = { sendMessage: () => { throw new Error("host rejected the delivery"); } };
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 0, "the rejected attempt discarded its occurrence");
  assert.equal(host.ownerEvents.length, 1);
  assert.match(host.ownerEvents[0]!, /could not be delivered/);
});

test("orchestrator-turn occurrences do not consult subtask overlap state", async () => {
  const { dispatch, host } = harness({
    runs: [{ executionId: "exec-active", kind: "execute", tasks: [{ taskId: "task-active", title: "T", state: "running" }] }],
  });
  // Even an active subtask group carrying this entry's id cannot block an
  // orchestrator-turn occurrence: later due occurrences are independent.
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  assert.equal(host.piMessages.length, 1);
  assert.equal(host.started.length, 0);
});
test("a rejecting UI notification cannot skip the model-facing launch notice", async () => {
  const { dispatch, host } = harness({ uiNoticeRejects: true });
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), false);
  // The launch notice is attempted FIRST, independently of the UI notice.
  assert.equal(host.launches.length, 1, "the model wake was attempted despite the UI channel failure");
  const gate = host.started[0]!.options.launchNoticeGate as Promise<void>;
  await gate;
  assert.equal(host.started.length, 1);
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), true);
  assert.equal(host.ownerEvents.length, 1, "the next overdue occurrence is still evaluated independently");
});

test("a wedged model channel releases the gate only after the bounded delivery attempt is reported", async () => {
  const { dispatch, host } = harness();
  // Swap the host notice delivery for the REAL bounded module attempt against
  // a hung host send promise, so the gate-release bound is exercised end to end.
  host.deliverLaunchNotice = async (notice: SubtaskLaunchNotice) => {
    return deliverSubtaskLaunchNotice({
      sendMessage: () => new Promise<never>(() => {}),
    }, notice, { timeoutMs: 40 });
  };
  await dispatch("task-1", subtaskEntry(), new Date(dueBase), false);
  const gate = host.started[0]!.options.launchNoticeGate as Promise<void>;
  const release = new Promise<void>((resolve) => {
    void gate.then(() => resolve());
  });
  const releaseTimedOut = await Promise.race([
    release.then(() => false),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(true), 500); }),
  ]);
  assert.equal(releaseTimedOut, false, "the gate was released by the bounded attempt");
  assert.equal(host.consoleWarnings.length > 0, true, "the uncertain delivery was reported before release");
  assert.match(host.consoleWarnings.join("\n"), /UNKNOWN/, "the uncertain launch notice is never claimed definitely-not-delivered");
  assert.equal(host.started.length, 1);
});

test("an orchestrator send accepted but never acknowledged within its window is reported UNCERTAIN, not failed", async () => {
  const { dispatch, host } = harness({ orchestratorDeliveryTimeoutMs: 30 });
  host.pi = {
    sendMessage: () => new Promise<never>(() => {}), // accepted; never acknowledges
  };
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 1, "the occurrence stays pending: only the host's own message observation could ever count it");
  assert.equal(host.ownerEvents.length, 1);
  const report = host.ownerEvents[0]!;
  assert.match(report, /UNKNOWN/);
  assert.match(report, /may still arrive/);
  assert.match(report, /NOT counted as executed/);
  assert.ok(!/NOT delivered/.test(report), "the report never claims definite non-delivery");
  assert.equal(host.piMessages.length, 0);
  // Even after it (hypothetically) arrived, no unobserved delivery settles.
  host.orchestratorTurns.agentRunStarted();
  host.orchestratorTurns.agentRunEnded();
  assert.equal(host.orchestratorTurns.agentRunSettled().length, 0, "an uncertain send is never settled without its own message_start");
});

test("an orchestrator send that times out but the host later enqueues leaves truthful state only", async () => {
  const { dispatch, host } = harness({ orchestratorDeliveryTimeoutMs: 30 });
  let enqueue: (() => void) | undefined;
  const idleHost: { sendMessage: () => Promise<void>; __host?: boolean } = {
    sendMessage: () => new Promise<void>((resolve) => {
      enqueue = resolve;
    }),
  };
  host.pi = idleHost;
  await dispatch("task-turn", orchestratorEntry(), new Date(dueBase), false);
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 1, "the occurrence stays pending, uncounted on the uncertain window");
  // The host may still enqueue the turn later: the pending occurrence keeps
  // its registered identity, and a real processing of this exact message (an
  // in-run message_start for its occurrenceId) would attribute it truthfully.
  const sendingId = host.orchestratorTurns.pendingOccurrences()[0]!.occurrenceId;
  void sendingId;
  // Until then nothing settles.
  host.orchestratorTurns.agentRunStarted();
  host.orchestratorTurns.agentRunEnded();
  assert.equal(host.orchestratorTurns.agentRunSettled().length, 0);
  // Nothing in this process may treat it as executed, and no crash surfaces
  // from the late settle.
  enqueue!();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.orchestratorTurns.pendingOccurrences().length, 1);
  assert.equal(host.orchestratorTurns.settledOccurrences().length, 0);
});
