/**
 * Issue #222: the "orchestrator-turn" schedule destination, corrected for the
 * real Pi host. These tests pin the delivery shape (non-interrupting
 * follow-up that triggers a turn), the truthful failure/uncertain reporting,
 * and the corrected attributed lifecycle: completion requires the host's
 * message_start to observe the occurrence's opaque identity inside a run,
 * followed by that run's end and a settlement. Delivery, another turn, and
 * unrelated human turns never complete an occurrence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ScheduledOrchestratorTurnTracker,
  deliverScheduledOrchestratorTurn,
  findTriggeringCustomMessage,
  formatScheduledOrchestratorTurnContent,
  TRIGGERING_TURN_CUSTOM_TYPES,
} from "../src/scheduling/orchestrator-turn";

const turnRequest = {
  entryId: "task-daily",
  entryName: "Daily summary",
  cron: "0 8 * * *",
  instructions: "Produce the daily summary report in the conversation.",
  dueAt: new Date(2024, 2, 4, 8, 0),
  dueLabel: "2024-03-04 08:00 +00:00 (local)",
};

function baseRecord(overrides: Partial<Parameters<ScheduledOrchestratorTurnTracker["beginOccurrence"]>[0]> = {}): Parameters<ScheduledOrchestratorTurnTracker["beginOccurrence"]>[0] {
  return { entryId: "task-a", entryName: "A", cron: "* * * * *", dueAt: new Date(0), ...overrides };
}

test("the orchestrator-turn content carries the occurrence identity and the verbatim instructions", () => {
  const content = formatScheduledOrchestratorTurnContent(
    { instructions: turnRequest.instructions },
    { entryId: turnRequest.entryId, entryName: turnRequest.entryName, cron: turnRequest.cron, dueAt: turnRequest.dueAt, dueLabel: turnRequest.dueLabel },
  );
  // Identity: entry label, exact sampled due minute, cron expression.
  assert.match(content, /^Scheduled orchestrator turn for task task-daily \(Daily summary\) was due at 2024-03-04 08:00 \+00:00 \(local\) for cron "0 8 \* \* \*"\./);
  // Semantics: the existing agent keeps its own workspace/tools/review, may
  // delegate, and derived work never holds the occurrence open.
  assert.match(content, /current tools, model, and review behavior/);
  assert.match(content, /current Pi launch workspace/);
  assert.match(content, /You may act directly or start subtasks/);
  assert.match(content, /do not keep this scheduled occurrence open/);
  // The instructions themselves are carried verbatim.
  assert.ok(content.endsWith("Produce the daily summary report in the conversation."));
  // No outcome is implied by the delivery.
  assert.match(content, /This is a scheduled request, not a completed outcome/);
});

test("the orchestrator-turn content redacts and bounds hostile entry labels", () => {
  const content = formatScheduledOrchestratorTurnContent(
    { instructions: "Work." },
    {
      entryId: "task-x",
      entryName: `Bearer sk-ABCDEFGHIJKLMNOPQRST ${"y".repeat(400)}`,
      cron: "* * * * *",
      dueAt: new Date(0),
      dueLabel: "label",
    },
  );
  assert.ok(!content.includes("sk-ABCDEFGHIJKLMNOPQRST"), "secrets are redacted from the header");
  const nameLine = content.split("\n")[0]!;
  assert.ok(nameLine.length <= 260, `the header label line is bounded: ${nameLine.length}`);
});

test("a trigger-turn custom message is identified from the host message_start shapes", () => {
  // Real Pi dispatches (event, ctx).
  const event = {
    type: "message_start",
    message: { role: "custom", customType: "pi-review-scheduled-orchestrator-turn", details: { occurrenceId: "id-1" } },
  };
  assert.deepEqual(findTriggeringCustomMessage([event, { some: "ctx" }]), {
    customType: "pi-review-scheduled-orchestrator-turn",
    details: { occurrenceId: "id-1" },
  });
  // Hosts passing the message directly are handled too.
  const direct = { role: "custom", customType: "pi-review-subtask-launch", content: "x" };
  assert.deepEqual(findTriggeringCustomMessage([direct]), { customType: "pi-review-subtask-launch", details: undefined });
  // Non-custom roles and unknown custom types are never attributed or armed.
  assert.equal(findTriggeringCustomMessage([{ message: { role: "user", customType: "pi-review-scheduled-orchestrator-turn" } }]), undefined);
  assert.equal(findTriggeringCustomMessage([{ message: { role: "custom", customType: "unknown-type" } }]), undefined);
  assert.equal(findTriggeringCustomMessage([{ message: { role: "assistant", content: [] } }]), undefined);
  for (const known of TRIGGERING_TURN_CUSTOM_TYPES) {
    assert.ok(findTriggeringCustomMessage([{ message: { role: "custom", customType: known, details: {} } }]), `known type ${known} is recognized`);
  }
});

test("the delivery uses the non-interrupting triggered-turn lane, carries the opaque identity, and never settles the occurrence", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const deliveries: Array<{ message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }; delivery: unknown }> = [];
  const pi = {
    sendMessage: (message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }, delivery: unknown) => {
      deliveries.push({ message, delivery });
    },
  };
  const sending = tracker.beginOccurrence({
    entryId: turnRequest.entryId, entryName: turnRequest.entryName, cron: turnRequest.cron, dueAt: turnRequest.dueAt,
  });
  const outcome = await deliverScheduledOrchestratorTurn(pi, { ...turnRequest, sending });
  assert.equal(outcome, "delivered", "a synchronous void send is accepted immediately");
  assert.equal(deliveries.length, 1);
  // Never steer: a busy orchestrator is queued, not interrupted.
  assert.deepEqual(deliveries[0]!.delivery, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(deliveries[0]!.message.customType, "pi-review-scheduled-orchestrator-turn");
  assert.equal(deliveries[0]!.message.display, true);
  assert.equal(deliveries[0]!.message.details.entryId, "task-daily");
  assert.equal(deliveries[0]!.message.details.dueAt, turnRequest.dueAt.toISOString());
  assert.equal(deliveries[0]!.message.details.occurrenceId, sending.occurrenceId);
  assert.ok(deliveries[0]!.message.content.includes(turnRequest.instructions));
  // Delivery is registered BEFORE the send (pending) and never counts it.
  const occurrence = tracker.pendingOccurrences()[0]!;
  assert.equal(occurrence.occurrenceId, sending.occurrenceId);
  assert.equal(occurrence.settledAt, undefined, "delivery never completes the occurrence");
  assert.equal(occurrence.processedAt, undefined, "the host has not observed the message yet");

  // No host message channel: honestly unavailable — nothing was triggered,
  // and the unobserved sending is discarded so nothing can be counted later.
  const emptyTracker = new ScheduledOrchestratorTurnTracker();
  const emptySending = emptyTracker.beginOccurrence(baseRecord());
  assert.equal(await deliverScheduledOrchestratorTurn({}, { ...turnRequest, sending: emptySending }), "unavailable");
  assert.equal(emptyTracker.pendingOccurrences().length, 0, "the rejected sending was discarded");
  const rejecting = { sendMessage: () => { throw new Error("rejected"); } };
  const rejectedSending = tracker.beginOccurrence(baseRecord());
  assert.equal(await deliverScheduledOrchestratorTurn(rejecting, { ...turnRequest, sending: rejectedSending }), "unavailable");
  assert.equal(tracker.pendingOccurrences().length, 1, "only the earlier sync-void occurrence remains");
  assert.equal(rejectedSending.observedSync(), false);
});

test("a busy-path send promise that resolves quickly is delivered and keeps the occurrence pending for its turn end", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  const busyHost = {
    sendMessage: (message: unknown, delivery: unknown) => Promise.resolve(),
  };
  assert.equal(await deliverScheduledOrchestratorTurn(busyHost, { ...turnRequest, sending }, { timeoutMs: 50 }), "delivered");
  assert.equal(tracker.pendingOccurrences().length, 1);
  assert.equal(tracker.settledOccurrences().length, 0);
});

test("an idle host send that outlives the window but is observed on message_start is delivered, not uncertain", async () => {
  // Real Pi hosts start the whole run from an idle sendCustomMessage: the
  // send promise resolves only after the full cycle, while message_start
  // fires long before. The observation must win over the send outcome.
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  let settleSend: (() => void) | undefined;
  const idleHost = {
    sendMessage: () => new Promise<never>((resolve) => { settleSend = resolve as () => void; }),
  };
  const delivering = deliverScheduledOrchestratorTurn(idleHost, { ...turnRequest, sending }, { timeoutMs: 30 });
  // The host's machine observes the custom message while the send is pending:
  // its consuming run had already begun (host agent_start precedes
  // message_start).
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true);
  assert.equal(await delivering, "delivered", "identity observation outruns the window");
  settleSend!();
  // The occurrence is observed but not settled: only a consuming-run end
  // followed by a settlement completes it.
  assert.equal(sending.observedSync(), true);
  assert.equal(tracker.settledOccurrences().length, 0);
  tracker.agentRunEnded();
  const settled = tracker.agentRunSettled();
  assert.equal(settled.length, 1, "the processing turn's end settles the occurrence");
  assert.equal(settled[0]!.occurrenceId, sending.occurrenceId);
});

test("an orchestrator send that is neither acknowledged nor observed within its window stays UNCERTAIN and pending", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  const slow = { sendMessage: () => new Promise<never>(() => {}) };
  assert.equal(await deliverScheduledOrchestratorTurn(slow, { ...turnRequest, sending }, { timeoutMs: 30 }), "uncertain");
  assert.equal(tracker.pendingOccurrences().length, 1, "the occurrence stays pending for a later truthful arrival");
  assert.equal(tracker.settledOccurrences().length, 0, "and it is never counted on faith");
  // The send may still be enqueued by the host: a late acknowledgement is
  // suppressed internally, never surfaced as an unhandled rejection.
  // A DEFINITE rejection stays "unavailable" (definitely not delivered).
  const rejected = tracker.beginOccurrence(baseRecord());
  const rejectingLate = {
    sendMessage: () => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("host rejected late")), 10);
    }),
  };
  assert.equal(await deliverScheduledOrchestratorTurn(rejectingLate, { ...turnRequest, sending: rejected }, { timeoutMs: 5_000 }), "unavailable");
  assert.equal(tracker.pendingOccurrences().length, 1, "only the uncertain occurrence remains");
  assert.equal(tracker.agentRunSettled().length, 0, "an unobserved delivery can never settle");
});

test("an observed message is never discarded even when the send promise later rejects", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  const host = {
    sendMessage: () => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("late rejection")), 10);
    }),
  };
  const attempt = deliverScheduledOrchestratorTurn(host, { ...turnRequest, sending }, { timeoutMs: 5_000 });
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true);
  assert.equal(await attempt, "delivered", "an observed message was delivered despite the late rejection");
  assert.equal(tracker.pendingOccurrences().length, 1, "the processing occurrence is kept");
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled()[0]!.occurrenceId, sending.occurrenceId);
});

test("attribution requires the host message_start identity for this message — unrelated runs never settle one", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence({ entryId: "task-turn", entryName: "Turn", cron: "* * * * *", dueAt: new Date(0) });

  // An unrelated human turn begins and settles: it consumed no scheduled
  // message, so nothing may be marked — the not-yet-processed delivery
  // survives it.
  tracker.agentRunStarted();
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled().length, 0, "a settlement with no observed occurrence settles nothing");
  assert.equal(sending.observedSync(), false);

  // The scheduled turn begins (host agent_start), its message is observed,
  // and only then does the run end and the settlement complete it.
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true, "the initiating run's message_start is attributed");
  assert.equal(sending.observedSync(), true);
  tracker.agentRunEnded();
  const settled = tracker.agentRunSettled();
  assert.equal(settled.length, 1, "the initiating turn's end completes the occurrence");
  assert.equal(settled[0]!.occurrenceId, sending.occurrenceId);
  assert.ok(settled[0]!.settledAt instanceof Date);
  assert.equal(tracker.pendingOccurrences().length, 0);
  // Nothing settles twice for one run boundary.
  assert.equal(tracker.agentRunSettled().length, 0);
});

test("an observation without an in-flight run is never attributed", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), false, "no consuming run: nothing is attributed");
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true);
  tracker.agentRunEnded();
  tracker.agentRunSettled();
  const next = tracker.beginOccurrence(baseRecord());
  assert.equal(tracker.noteMessageObserved(next.occurrenceId), false, "a message append outside a run is never attributed");
  assert.equal(tracker.settledOccurrences().length, 1);
});

test("an unknown or non-string identity is a no-op", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  assert.equal(tracker.noteMessageObserved(undefined), false);
  assert.equal(tracker.noteMessageObserved(42), false);
  assert.equal(tracker.noteMessageObserved("task-a#3"), false, "identity is opaque random UUID, never a derived key");
  assert.equal(tracker.noteMessageObserved("not-tracked"), false);
  assert.equal(tracker.pendingOccurrences().length, 0);
});

test("a settlement while the consuming run is still in flight never completes it", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence({ entryId: "task-turn", entryName: "Turn", cron: "* * * * *", dueAt: new Date(0) });
  // The consuming run began and observed the message, but has not ended.
  tracker.agentRunStarted();
  tracker.noteMessageObserved(sending.occurrenceId);
  // An in-flight settlement (an interleaved submit-cycle settling while this
  // run is still streaming) must not complete what that run has not ended.
  assert.equal(tracker.agentRunSettled().length, 0, "the consuming run is still in flight");
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled().length, 1, "the run's own end, then the next boundary, completes it");
});

test("multiple queued scheduled turns processed in one cycle settle at that cycle's settlement", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const first = tracker.beginOccurrence({ entryId: "task-a", entryName: "A", cron: "* * * * *", dueAt: new Date(0) });
  const second = tracker.beginOccurrence({ entryId: "task-b", entryName: "B", cron: "* * * * *", dueAt: new Date(1000) });
  // One cycle: agent_start … both queued messages observed on message_start …
  // agent_end … agent_settled.
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(first.occurrenceId), true);
  assert.equal(tracker.noteMessageObserved(second.occurrenceId), true);
  tracker.agentRunEnded();
  const settled = tracker.agentRunSettled();
  assert.deepEqual(settled.map((occurrence) => occurrence.occurrenceId), [first.occurrenceId, second.occurrenceId]);
  assert.equal(tracker.pendingOccurrences().length, 0);
});

test("retries inside a submitting cycle settle the occurrence exactly once", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  // Run 1 fails and is retried: agent_start … agent_end, agent_start … agent_end, agent_settled.
  tracker.agentRunStarted();
  tracker.noteMessageObserved(sending.occurrenceId);
  tracker.agentRunEnded();
  tracker.agentRunStarted();
  tracker.agentRunEnded();
  const settled = tracker.agentRunSettled();
  assert.equal(settled.length, 1);
  assert.equal(tracker.agentRunSettled().length, 0);
});

test("a synchronous void send may race message_start before dispatch returns without losing attribution", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  const host = {
    sendMessage: (raw: unknown) => {
      const message = raw as { customType: string; details: { occurrenceId: string } };
      // The idle host begins the run and synchronously dispatches the matching
      // message_start from inside sendCustomMessage, before it returns void.
      tracker.agentRunStarted();
      const observed = findTriggeringCustomMessage([{ message: { role: "custom", ...message } }]);
      assert.equal(observed?.customType, "pi-review-scheduled-orchestrator-turn");
      assert.equal(tracker.noteMessageObserved(observed.details?.occurrenceId), true);
    },
  };
  assert.equal(await deliverScheduledOrchestratorTurn(host, { ...turnRequest, sending }), "delivered");
  assert.equal(sending.observedSync(), true);
  tracker.agentRunEnded();
  const settled = tracker.agentRunSettled();
  assert.equal(settled.length, 1, "the consuming run's end completes the race-delayed bookkeeping");
  assert.ok(settled[0]!.deliveredAt instanceof Date);
});

test("a synchronous send exception after matching message_start is not misreported as definite non-delivery", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  const host = {
    sendMessage: (raw: unknown) => {
      tracker.agentRunStarted();
      const message = raw as { customType: string; details: { occurrenceId: string } };
      const observed = findTriggeringCustomMessage([{ message: { role: "custom", ...message } }]);
      assert.equal(tracker.noteMessageObserved(observed?.details?.occurrenceId), true);
      throw new Error("wrapper failed after the host accepted the message");
    },
  };
  assert.equal(await deliverScheduledOrchestratorTurn(host, { ...turnRequest, sending }), "delivered");
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled()[0]!.occurrenceId, sending.occurrenceId);
});

test("a message whose review arming fails is never counted at settlement", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const sending = tracker.beginOccurrence(baseRecord());
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(sending.occurrenceId), true);
  tracker.noteMessageArmingFailed(sending.occurrenceId);
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled().length, 0);
  assert.equal(tracker.pendingOccurrences().length, 1, "failed arming cannot produce a completion claim");
});

test("a session reset drops every correlation so a new session can never settle an old occurrence", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const occurrence = tracker.beginOccurrence(baseRecord());
  tracker.agentRunStarted();
  tracker.noteMessageObserved(occurrence.occurrenceId);
  tracker.resetSession();
  assert.equal(tracker.pendingOccurrences().length, 0);
  // A boundary from the previous session never settles the reset occurrence.
  tracker.agentRunEnded();
  tracker.agentRunSettled();
  assert.equal(tracker.settledOccurrences().length, 0, "cross-session boundaries never settle or count an old occurrence");
  // The tracker starts its sequences fresh for the new session.
  const fresh = tracker.beginOccurrence(baseRecord());
  tracker.agentRunStarted();
  assert.equal(tracker.noteMessageObserved(fresh.occurrenceId), true, "the fresh session's own processing is attributed");
  assert.equal(tracker.agentRunSettled().length, 0, "an orphan old-session agent_end cannot end a fresh run");
  tracker.agentRunEnded();
  assert.equal(tracker.agentRunSettled()[0]!.occurrenceId, fresh.occurrenceId);
});

test("the sending handle resolves abandoned after a reset so racing dispatches never hang", async () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  const sending = tracker.beginOccurrence(baseRecord());
  tracker.resetSession();
  assert.equal(await sending.observed, "abandoned");
});

test("pending occurrences stay bounded by dropping the oldest, never by counting it", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  tracker.setTurnEndTracking("host-lifecycle-hooks");
  const first = tracker.beginOccurrence(baseRecord({ entryId: "first" }));
  for (let i = 0; i < 40; i++) tracker.beginOccurrence(baseRecord({ entryId: `spillover-${i}` }));
  const pending = tracker.pendingOccurrences();
  assert.equal(pending.length, 32);
  assert.equal(pending.some((occurrence) => occurrence.entryId === "first"), false, "the oldest pending occurrence was dropped");
  // A dropped occurrence can never be counted: even observing its (gone)
  // identity is a no-op, and no settlement completes it.
  assert.equal(tracker.noteMessageObserved(first.occurrenceId), false);
  tracker.agentRunStarted();
  tracker.agentRunEnded();
  const settled = tracker.agentRunSettled();
  assert.equal(settled.length, 0, "without an in-run observation there is no settlement");
});

// Occurrence ids are opaque and unique per occurrence.
test("occurrence ids are opaque and unique per occurrence", () => {
  const tracker = new ScheduledOrchestratorTurnTracker();
  const first = tracker.beginOccurrence(baseRecord());
  const second = tracker.beginOccurrence(baseRecord());
  assert.notEqual(first.occurrenceId, second.occurrenceId);
  assert.match(first.occurrenceId, /^[0-9a-f-]{36}$/);
});