/**
 * Pure retained ordinary-fresh Codex root-facts binder.
 *
 * These tests drive only the closed relay metadata union: no socket, provider,
 * model, relay, or process is involved. They prove the settled binding rule
 * (empty owned-backend witness + one genuine TUI + one initial fresh start + own
 * matched first work), sticky fail-closed withdrawal, helper/child exclusion,
 * root-scoped current tool state, and current-snapshot watch delivery without
 * wire-event replay. They do NOT prove that a live provider's start/turn
 * sequence matches, and they never claim a general root selector.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { NativeCodexTuiRelayMetadataEvent } from "../src/session-host/native-codex-tui-relay";
import {
  createNativeCodexTuiRootFactsBinder,
  type NativeCodexTuiRootFactsBinder,
  type NativeCodexTuiRootFactsSnapshot,
  type NativeCodexTuiRootToolFact,
  type NativeCodexTuiRootWithdrawalReason,
} from "../src/session-host/native-codex-tui-root-facts";

/* --------------------------------------------------------------- fixtures */

const C = "connection-one";
const C2 = "connection-two";
const A = "thread-a";

function initialize(connectionId = C, humanApprovalRequired = true): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "genuine-tui-initialize",
    connectionId,
    sequence: 1,
    clientName: "codex-tui",
    humanApprovalRequired,
  };
}

interface CandidateOptions {
  readonly requestIdKind?: "native" | "native-helper";
  readonly parentThreadId?: string;
  readonly ephemeral?: boolean;
  readonly connectionId?: string;
}

function startCandidate(threadId: string, options: CandidateOptions = {}): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "thread-candidate",
    connectionId: options.connectionId ?? C,
    sequence: 2,
    origin: "thread-start",
    requestIdKind: options.requestIdKind ?? "native",
    threadId,
    ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
    ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
  };
}

function advancedCandidate(
  threadId: string,
  origin: "thread-resume" | "thread-fork",
  requestIdKind: "native" | "native-helper" = "native",
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "thread-candidate",
    connectionId: C,
    sequence: 2,
    origin,
    requestIdKind,
    threadId,
  };
}

function work(
  threadId: string,
  turnId: string,
  requestIdKind: "native" | "native-helper" = "native",
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "turn-work-target",
    connectionId: C,
    sequence: 3,
    requestIdKind,
    threadId,
    turnId,
  };
}

interface ItemOptions {
  readonly itemId?: string;
  readonly turnId?: string;
  readonly connectionId?: string;
}

function item(
  threadId: string | undefined,
  toolCategory: NativeCodexTuiRootToolFact["category"] | undefined,
  phase: "started" | "completed" = "started",
  options: ItemOptions = {},
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "item-phase",
    connectionId: options.connectionId ?? C,
    sequence: 4,
    phase,
    itemKind: "commandExecution",
    itemId: options.itemId ?? "item-1",
    ...(threadId === undefined ? {} : { threadId }),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    ...(toolCategory === undefined ? {} : { toolCategory }),
  };
}

function attested(): NativeCodexTuiRootFactsBinder {
  const binder = createNativeCodexTuiRootFactsBinder();
  binder.attestEmptyBackend();
  return binder;
}

function boundBinder(): NativeCodexTuiRootFactsBinder {
  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate(A));
  binder.observe(work(A, "turn-1"));
  return binder;
}

function toolOf(snapshot: NativeCodexTuiRootFactsSnapshot): NativeCodexTuiRootToolFact | undefined {
  return snapshot.tool;
}

/* ================================================================= tests */

test("a genuine initialize establishes one generation and publishes no root", () => {
  const binder = createNativeCodexTuiRootFactsBinder();
  assert.deepEqual(binder.current(), { phase: "empty" });

  binder.observe(initialize());
  assert.deepEqual(binder.current(), { phase: "connected", connectionId: C });
  assert.equal("rootThreadId" in binder.current(), false);
  assert.equal("tool" in binder.current(), false);

  // A duplicate initialize on the same generation changes nothing.
  binder.observe(initialize());
  assert.deepEqual(binder.current(), { phase: "connected", connectionId: C });

  // A non-genuine initialize (no human-approval capability) never fences.
  binder.observe(initialize("connection-other", false));
  assert.deepEqual(binder.current(), { phase: "connected", connectionId: C });
});

test("binding requires the empty owned-backend witness and the first own work, not the candidate", () => {
  const withoutAttestation = createNativeCodexTuiRootFactsBinder();
  withoutAttestation.observe(initialize());
  withoutAttestation.observe(startCandidate(A));
  // Without the empty-backend witness no fresh candidate binding is named.
  assert.deepEqual(withoutAttestation.current(), { phase: "candidate", connectionId: C });
  withoutAttestation.observe(work(A, "turn-1"));
  assert.deepEqual(withoutAttestation.current(), {
    phase: "withdrawn",
    connectionId: C,
    withdrawal: "backend-attestation-unavailable",
  });
  // Attesting after the withdrawal can never revive the source.
  withoutAttestation.attestEmptyBackend();
  withoutAttestation.observe(work(A, "turn-2"));
  assert.equal(withoutAttestation.current().phase, "withdrawn");

  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate(A));
  // A start response alone is a candidate, never a root publication. With the
  // whole fresh proof short of the first own turn it names the owner-private
  // fresh candidate binding, and its async queue is positively empty.
  assert.deepEqual(binder.current(), { phase: "candidate", connectionId: C, candidateThreadId: A, asyncInput: "none" });
  assert.equal("rootThreadId" in binder.current(), false);
  assert.equal("rootTurnId" in binder.current(), false);

  binder.observe(work(A, "turn-1"));
  assert.deepEqual(binder.current(), {
    phase: "bound",
    connectionId: C,
    rootThreadId: A,
    rootTurnId: "turn-1",
    asyncInput: "none",
  });
});

test("helper and child traffic never becomes the root and never withdraws an ordinary root", () => {
  const binder = attested();
  binder.observe(initialize());

  // Helper-labelled starts, ephemeral starts, and parented starts are all
  // structural non-candidates.
  binder.observe(startCandidate("helper-thread", { requestIdKind: "native-helper" }));
  binder.observe(startCandidate("ephemeral-thread", { ephemeral: true }));
  binder.observe(startCandidate("child-thread", { parentThreadId: A }));
  assert.deepEqual(binder.current(), { phase: "connected", connectionId: C });

  binder.observe(startCandidate(A));
  assert.equal(binder.current().phase, "candidate");

  // Helper selection and helper work are ignored while the candidate is private.
  binder.observe(advancedCandidate("helper-resume", "thread-resume", "native-helper"));
  binder.observe(advancedCandidate("helper-fork", "thread-fork", "native-helper"));
  binder.observe(work("helper-thread", "helper-turn", "native-helper"));
  assert.deepEqual(binder.current(), { phase: "candidate", connectionId: C, candidateThreadId: A, asyncInput: "none" });

  binder.observe(work(A, "turn-1"));
  assert.deepEqual(binder.current(), {
    phase: "bound",
    connectionId: C,
    rootThreadId: A,
    rootTurnId: "turn-1",
    asyncInput: "none",
  });

  // A default helper (native-helper, ephemeral, parentless) must not withdraw
  // the ordinary rooted row.
  binder.observe(startCandidate("helper-ephemeral", { requestIdKind: "native-helper", ephemeral: true }));
  binder.observe(advancedCandidate("helper-resume", "thread-resume", "native-helper"));
  binder.observe(work("child-thread", "child-turn", "native-helper"));
  assert.equal(binder.current().phase, "bound");
  assert.equal(binder.current().rootThreadId, A);
  assert.equal(binder.current().rootTurnId, "turn-1");
});

test("a second primary start and advanced thread selection withdraw permanently", () => {
  const secondStart = attested();
  secondStart.observe(initialize());
  secondStart.observe(startCandidate(A));
  secondStart.observe(startCandidate("thread-b"));
  assert.deepEqual(secondStart.current(), {
    phase: "withdrawn",
    connectionId: C,
    withdrawal: "second-primary-thread-start",
  });
  secondStart.observe(work(A, "turn-late"));
  assert.equal(secondStart.current().phase, "withdrawn");
  assert.equal("rootThreadId" in secondStart.current(), false);

  for (const origin of ["thread-resume", "thread-fork"] as const) {
    const binder = boundBinder();
    binder.observe(advancedCandidate("thread-other", origin));
    assert.deepEqual(binder.current(), {
      phase: "withdrawn",
      connectionId: C,
      withdrawal: "thread-selection-advanced",
    });
    assert.equal("rootThreadId" in binder.current(), false);
    assert.equal("rootTurnId" in binder.current(), false);
  }
});

test("work on another thread or work without a fresh start withdraws", () => {
  const otherThread = boundBinder();
  otherThread.observe(work("thread-b", "turn-2"));
  assert.equal(otherThread.current().phase, "withdrawn");
  assert.equal(otherThread.current().withdrawal, "work-on-another-thread");
  assert.equal("rootThreadId" in otherThread.current(), false);

  const noStart = attested();
  noStart.observe(initialize());
  noStart.observe(work(A, "turn-1"));
  assert.equal(noStart.current().phase, "withdrawn");
  assert.equal(noStart.current().withdrawal, "work-without-fresh-thread");
});

test("connection loss, metadata loss, and a second connection are sticky withdrawals", () => {
  const cases: Array<{
    readonly label: string;
    readonly event: NativeCodexTuiRelayMetadataEvent;
    readonly reason: string;
    readonly closeReason?: string;
  }> = [
    {
      label: "message metadata loss",
      event: {
        kind: "metadata-unavailable",
        connectionId: C,
        sequence: 5,
        scope: "message",
        reason: "json-unreadable",
      },
      reason: "metadata-unavailable",
    },
    {
      label: "connection metadata loss",
      event: {
        kind: "metadata-unavailable",
        connectionId: C,
        sequence: 5,
        scope: "connection",
        reason: "compressed-stream",
      },
      reason: "metadata-unavailable",
    },
    {
      label: "generation closed",
      event: { kind: "generation-closed", connectionId: C, sequence: 5, reason: "client-closed" },
      reason: "generation-closed",
      closeReason: "client-closed",
    },
    {
      label: "second genuine connection",
      event: initialize(C2),
      reason: "second-connection",
    },
    {
      label: "unknown generation",
      event: item(A, "command", "started", { connectionId: C2 }),
      reason: "metadata-unavailable",
    },
  ];

  for (const { label, event, reason, closeReason } of cases) {
    const binder = boundBinder();
    binder.observe(event);
    assert.deepEqual(
      binder.current(),
      { phase: "withdrawn", connectionId: C, withdrawal: reason, ...(closeReason === undefined ? {} : { closeReason }) },
      label,
    );
    assert.equal("rootThreadId" in binder.current(), false, label);
    assert.equal("rootTurnId" in binder.current(), false, label);
    assert.equal("tool" in binder.current(), false, label);
  }

  const beforeInitialize = createNativeCodexTuiRootFactsBinder();
  beforeInitialize.observe(item(A, "command", "started"));
  assert.equal(beforeInitialize.current().phase, "withdrawn");
  assert.equal(beforeInitialize.current().withdrawal, "metadata-unavailable");
});

test("only current root-scoped canonical tool facts are retained, and a new root turn clears them", () => {
  const binder = boundBinder();

  binder.observe(item(A, "command", "started", { itemId: "item-1", turnId: "turn-1" }));
  assert.deepEqual(toolOf(binder.current()), {
    itemId: "item-1",
    category: "command",
    phase: "started",
    turnId: "turn-1",
  });
  assert.ok(Object.isFrozen(binder.current()));
  assert.ok(Object.isFrozen(binder.current().tool));

  // Unrelated, missing, and non-tool item phases are never attributed.
  const beforeUnrelated = binder.current();
  binder.observe(item("thread-b", "command", "started", { itemId: "child", turnId: "turn-1" }));
  binder.observe(item(undefined, "command", "started", { itemId: "missing", turnId: "turn-1" }));
  binder.observe(item(A, undefined, "started", { itemId: "message", turnId: "turn-1" }));
  assert.equal(binder.current(), beforeUnrelated);

  // The current tool's own completion is a rooted fact, not a new tool.
  binder.observe(item(A, "command", "completed", { itemId: "item-1", turnId: "turn-1" }));
  assert.equal(toolOf(binder.current())?.phase, "completed");
  assert.notEqual(binder.current(), beforeUnrelated);

  // The current turn's next start is a scalar replacement.
  binder.observe(item(A, "file-change", "started", { itemId: "item-2", turnId: "turn-1" }));
  assert.deepEqual(toolOf(binder.current()), {
    itemId: "item-2",
    category: "file-change",
    phase: "started",
    turnId: "turn-1",
  });

  // A completion of the previous item (or from an old turn) is rejected.
  binder.observe(item(A, "command", "completed", { itemId: "item-1", turnId: "turn-1" }));
  assert.equal(toolOf(binder.current())?.itemId, "item-2");
  assert.equal(toolOf(binder.current())?.phase, "started");

  // A new root turn clears the old tool.
  binder.observe(work(A, "turn-2"));
  assert.equal(binder.current().rootTurnId, "turn-2");
  assert.equal(toolOf(binder.current()), undefined);

  // A late start from the previous turn cannot repopulate it.
  binder.observe(item(A, "command", "started", { itemId: "stale", turnId: "turn-1" }));
  assert.equal(toolOf(binder.current()), undefined);

  binder.observe(item(A, "mcp-tool", "started", { itemId: "item-3", turnId: "turn-2" }));
  assert.deepEqual(toolOf(binder.current()), {
    itemId: "item-3",
    category: "mcp-tool",
    phase: "started",
    turnId: "turn-2",
  });

  // An old turn's completion is rejected; the current turn's is applied.
  binder.observe(item(A, "mcp-tool", "completed", { itemId: "item-3", turnId: "turn-1" }));
  assert.equal(toolOf(binder.current())?.phase, "started");
  binder.observe(item(A, "mcp-tool", "completed", { itemId: "item-3", turnId: "turn-2" }));
  assert.equal(toolOf(binder.current())?.phase, "completed");
});

test("a later turn's rooted tool start preceding its work response is retained provisionally", () => {
  const binder = boundBinder();

  // The item notification arrives before the turn/start response projection.
  binder.observe(item(A, "command", "started", { itemId: "item-t2", turnId: "turn-2" }));
  // The confirmed current state is still turn 1; the provisional fact is not
  // published as though turn 2 had been selected.
  assert.equal(binder.current().rootTurnId, "turn-1");
  assert.equal(binder.current().tool, undefined);

  binder.observe(work(A, "turn-2"));
  assert.deepEqual(binder.current(), {
    phase: "bound",
    connectionId: C,
    rootThreadId: A,
    rootTurnId: "turn-2",
    tool: { itemId: "item-t2", category: "command", phase: "started", turnId: "turn-2" },
    asyncInput: "none",
  });

  // A later attach sees the positively running current tool immediately.
  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  const unsubscribe = binder.watch((snapshot) => seen.push(snapshot));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.tool, {
    itemId: "item-t2",
    category: "command",
    phase: "started",
    turnId: "turn-2",
  });

  // An old turn's completion still cannot change the current T2 tool.
  binder.observe(item(A, "command", "completed", { itemId: "item-t2", turnId: "turn-1" }));
  assert.equal(binder.current().tool?.phase, "started");
  // The current turn's completion applies.
  binder.observe(item(A, "command", "completed", { itemId: "item-t2", turnId: "turn-2" }));
  assert.equal(binder.current().tool?.phase, "completed");
  unsubscribe();
});

test("a provisional tool is adopted only by its own confirmed turn and keeps a known completion", () => {
  const binder = boundBinder();
  binder.observe(item(A, "file-change", "started", { itemId: "item-t2", turnId: "turn-2" }));
  binder.observe(item(A, "file-change", "completed", { itemId: "item-t2", turnId: "turn-2" }));
  binder.observe(work(A, "turn-2"));
  assert.deepEqual(toolOf(binder.current()), {
    itemId: "item-t2",
    category: "file-change",
    phase: "completed",
    turnId: "turn-2",
  });

  const other = boundBinder();
  other.observe(item(A, "command", "started", { itemId: "provisional-t2", turnId: "turn-2" }));
  other.observe(work(A, "turn-3"));
  assert.equal(other.current().rootTurnId, "turn-3");
  assert.equal(other.current().tool, undefined);
});

test("a private pre-bind tool is published at binding only when it can belong to the first root turn", () => {
  const sameTurn = attested();
  sameTurn.observe(initialize());
  sameTurn.observe(startCandidate(A));
  sameTurn.observe(item(A, "command", "started", { itemId: "pre-bind", turnId: "turn-1" }));
  // The candidate snapshot does not publish private root observations.
  assert.deepEqual(sameTurn.current(), { phase: "candidate", connectionId: C, candidateThreadId: A, asyncInput: "none" });
  assert.equal("tool" in sameTurn.current(), false);

  sameTurn.observe(work(A, "turn-1"));
  assert.deepEqual(toolOf(sameTurn.current()), {
    itemId: "pre-bind",
    category: "command",
    phase: "started",
    turnId: "turn-1",
  });

  const staleTurn = attested();
  staleTurn.observe(initialize());
  staleTurn.observe(startCandidate(A));
  staleTurn.observe(item(A, "command", "started", { itemId: "stale", turnId: "turn-old" }));
  staleTurn.observe(work(A, "turn-1"));
  assert.equal(toolOf(staleTurn.current()), undefined);
});

test("watch delivers the current snapshot once, then changes only, with no event replay", () => {
  const binder = boundBinder();
  binder.observe(item(A, "command", "started", { itemId: "item-1", turnId: "turn-1" }));

  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  const unsubscribe = binder.watch((snapshot) => seen.push(snapshot));
  assert.equal(seen.length, 1);
  assert.equal(seen[0], binder.current());
  assert.deepEqual(seen[0], {
    phase: "bound",
    connectionId: C,
    rootThreadId: A,
    rootTurnId: "turn-1",
    tool: { itemId: "item-1", category: "command", phase: "started", turnId: "turn-1" },
    asyncInput: "none",
  });

  // A second concurrent watcher is refused and sees nothing.
  let secondSeen = 0;
  const secondUnsubscribe = binder.watch(() => {
    secondSeen += 1;
  });
  assert.equal(secondSeen, 0);

  binder.observe(item(A, "web-search", "started", { itemId: "item-2", turnId: "turn-1" }));
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.tool?.itemId, "item-2");

  // An event with no observable change does not emit.
  binder.observe(item("thread-child", "command", "started", { itemId: "child" }));
  assert.equal(seen.length, 2);

  unsubscribe();
  secondUnsubscribe();
  binder.observe(work(A, "turn-2"));
  assert.equal(seen.length, 2);
  assert.equal(secondSeen, 0);

  // A later watcher gets exactly one current snapshot: no stored history.
  const late: NativeCodexTuiRootFactsSnapshot[] = [];
  const lateUnsubscribe = binder.watch((snapshot) => late.push(snapshot));
  assert.equal(late.length, 1);
  assert.deepEqual(late[0], binder.current());
  assert.equal(late[0]?.rootTurnId, "turn-2");
  assert.equal(late[0]?.tool, undefined);
  binder.observe(item(A, "dynamic-tool", "started", { itemId: "item-3", turnId: "turn-2" }));
  assert.equal(late.length, 2);
  lateUnsubscribe();

  // A throwing consumer cannot corrupt later relay metadata delivery.
  const throwing = binder.watch(() => {
    throw new Error("consumer boom");
  });
  assert.doesNotThrow(() => binder.observe(item(A, "command", "started", { itemId: "item-4", turnId: "turn-2" })));
  throwing();
});

test("input request and response facts are deliberately unretained", () => {
  const binder = boundBinder();
  const before = binder.current();
  binder.observe({
    kind: "input-request",
    connectionId: C,
    sequence: 5,
    requestId: "1",
    method: "item/tool/requestUserInput",
    threadId: A,
  });
  binder.observe({
    kind: "input-response",
    connectionId: C,
    sequence: 6,
    requestId: "1",
    method: "item/tool/requestUserInput",
    hasError: false,
  });
  assert.equal(binder.current(), before);
  assert.equal("tool" in binder.current(), false);
});

test("withdrawal discards every retained root fact", () => {
  const binder = boundBinder();
  binder.observe(item(A, "command", "started", { itemId: "item-1", turnId: "turn-1" }));
  assert.ok(binder.current().tool);

  binder.observe({ kind: "generation-closed", connectionId: C, sequence: 7, reason: "relay-stopped" });
  assert.deepEqual(binder.current(), {
    phase: "withdrawn",
    connectionId: C,
    withdrawal: "generation-closed",
    closeReason: "relay-stopped",
  });
  assert.equal("rootThreadId" in binder.current(), false);
  assert.equal("rootTurnId" in binder.current(), false);
  assert.equal("tool" in binder.current(), false);
});

/* ======================================== fresh candidate binding + async queue */

function questionsEvent(
  threadId: string | undefined,
  itemId: string,
  questionCount: number,
  turnId: string | undefined = "turn-1",
  connectionId = C,
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "async-questions",
    connectionId,
    sequence: 10,
    itemId,
    questionCount,
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function replyEvent(
  threadId: string | undefined,
  answers: readonly { readonly itemId: string; readonly index?: number }[],
  connectionId = C,
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "async-question-reply",
    connectionId,
    sequence: 11,
    answers,
    ...(threadId === undefined ? {} : { threadId }),
    turnId: "turn-1",
  };
}

function unreadableEvent(
  source: "questions" | "user-input",
  threadId: string | undefined,
  turnId: string | undefined = "turn-1",
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "async-input-unreadable",
    connectionId: C,
    sequence: 12,
    source,
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function terminalEvent(threadId: string, turnId = "turn-1"): NativeCodexTuiRelayMetadataEvent {
  return { kind: "turn-terminal", connectionId: C, sequence: 13, threadId, turnId, status: "completed" };
}

test("the fresh candidate binding is named only with the whole fresh proof and stays fenced", () => {
  // No connection, no attestation: nothing is named.
  const early = createNativeCodexTuiRootFactsBinder();
  early.observe(initialize());
  early.observe(startCandidate(A));
  assert.equal(early.current().candidateThreadId, undefined);
  assert.equal(early.current().asyncInput, undefined);

  // A non-empty backend withdraws: no candidate binding, ever.
  const notEmpty = createNativeCodexTuiRootFactsBinder();
  notEmpty.withdraw("backend-not-empty");
  notEmpty.observe(initialize());
  notEmpty.observe(startCandidate(A));
  assert.equal(notEmpty.current().phase, "withdrawn");
  assert.equal(notEmpty.current().candidateThreadId, undefined);

  // Helper, ephemeral, and parented starts never become the candidate.
  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate("helper", { requestIdKind: "native-helper" }));
  binder.observe(startCandidate("ephemeral", { ephemeral: true }));
  binder.observe(startCandidate("child", { parentThreadId: "parent" }));
  assert.equal(binder.current().candidateThreadId, undefined);
  binder.observe(startCandidate(A));
  assert.equal(binder.current().candidateThreadId, A);
  assert.equal(binder.current().rootThreadId, undefined, "a candidate is never a root");

  // The first own turn binds the SAME thread; the candidate field is gone.
  binder.observe(work(A, "turn-1"));
  assert.equal(binder.current().phase, "bound");
  assert.equal(binder.current().rootThreadId, A);
  assert.equal("candidateThreadId" in binder.current(), false);

  // Second primary, advanced selection, and foreign work withdraw before binding.
  const second = attested();
  second.observe(initialize());
  second.observe(startCandidate(A));
  second.observe(startCandidate("thread-b"));
  assert.deepEqual(second.current(), { phase: "withdrawn", connectionId: C, withdrawal: "second-primary-thread-start" });
  const foreign = attested();
  foreign.observe(initialize());
  foreign.observe(startCandidate(A));
  foreign.observe(work("thread-b", "turn-x"));
  assert.deepEqual(foreign.current(), { phase: "withdrawn", connectionId: C, withdrawal: "work-on-another-thread" });
});

test("an own async question stays pending through root work and unrelated traffic until its exact reply", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-q", 2));
  assert.equal(binder.current().asyncInput, "pending");

  // Root work, tool completion, unrelated items, legacy input traffic, a new
  // own turn start response for the same turn, and helper traffic never clear it.
  binder.observe(item(A, "command", "started", { itemId: "tool-1", turnId: "turn-1" }));
  binder.observe(item(A, "command", "completed", { itemId: "tool-1", turnId: "turn-1" }));
  binder.observe(item("helper-thread", "command", "started", { itemId: "tool-h", turnId: "turn-h" }));
  binder.observe({ kind: "input-request", connectionId: C, sequence: 20, requestId: "0", method: "item/tool/requestUserInput", threadId: A });
  binder.observe({ kind: "input-response", connectionId: C, sequence: 21, requestId: "0", method: "item/tool/requestUserInput", hasError: false });
  binder.observe(work(A, "turn-1"));
  binder.observe(terminalEvent("helper-thread", "turn-h"));
  assert.equal(binder.current().asyncInput, "pending");
  assert.equal(binder.current().tool?.phase, "completed", "existing tool semantics are unchanged");

  // Replies that are not this root's exact identities never clear anything.
  binder.observe(replyEvent("helper-thread", [{ itemId: "call-q" }]));
  binder.observe(replyEvent(A, [{ itemId: "call-other" }, { itemId: "call-q", index: 7 }]));
  assert.equal(binder.current().asyncInput, "pending");

  // A partial answer clears only its own question.
  binder.observe(replyEvent(A, [{ itemId: "call-q", index: 0 }]));
  assert.equal(binder.current().asyncInput, "pending", "the other question remains");
  binder.observe(replyEvent(A, [{ itemId: "call-q", index: 1 }]));
  assert.equal(binder.current().asyncInput, "none");

  // The older whole-item identity answers every question of that item only.
  binder.observe(questionsEvent(A, "call-r", 3));
  binder.observe(questionsEvent(A, "call-s", 1));
  binder.observe(replyEvent(A, [{ itemId: "call-r" }]));
  assert.equal(binder.current().asyncInput, "pending", "call-s still waits");
  binder.observe(replyEvent(A, [{ itemId: "call-s", index: 0 }]));
  assert.equal(binder.current().asyncInput, "none");

  // A replay of an already answered item never resurrects it.
  binder.observe(questionsEvent(A, "call-q", 2));
  binder.observe(questionsEvent(A, "call-r", 3));
  assert.equal(binder.current().asyncInput, "none");
});

test("a candidate's questions count, helpers cannot, and an old connection withdraws", () => {
  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate(A));
  // The item notification may precede the first own turn/start response.
  binder.observe(questionsEvent(A, "call-early", 1));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(questionsEvent("helper-thread", "call-helper", 4));
  binder.observe(work(A, "turn-1"));
  assert.equal(binder.current().phase, "bound");
  assert.equal(binder.current().asyncInput, "pending", "the binding carries the same queue");
  binder.observe(replyEvent(A, [{ itemId: "call-helper" }]));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(replyEvent(A, [{ itemId: "call-early", index: 0 }]));
  assert.equal(binder.current().asyncInput, "none");

  binder.observe(questionsEvent(A, "call-late", 1, "turn-1", C2));
  assert.equal(binder.current().phase, "withdrawn", "another generation's metadata is a stream loss");
  assert.equal(binder.current().asyncInput, undefined);
});

test("only the matching live root terminal retires the queue, and late items never resurrect", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-q", 2, "turn-1"));
  // A terminal for another thread or another turn retires nothing.
  binder.observe(terminalEvent("helper-thread", "turn-1"));
  binder.observe(terminalEvent(A, "turn-0"));
  assert.equal(binder.current().asyncInput, "pending");

  binder.observe(terminalEvent(A, "turn-1"));
  assert.equal(binder.current().asyncInput, "none", "the native queue retired on its live terminal");
  // Late started/completed replays of the retired turn's item never resurrect.
  binder.observe(questionsEvent(A, "call-q", 2, "turn-1"));
  binder.observe(questionsEvent(A, "call-late", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "none");

  // A new turn's question is a new pending fact.
  binder.observe(work(A, "turn-2"));
  binder.observe(questionsEvent(A, "call-t2", 1, "turn-2"));
  assert.equal(binder.current().asyncInput, "pending");
});

test("unreadable question or user metadata makes input unknown, never none, and touches nothing else", () => {
  const binder = boundBinder();
  binder.observe(item(A, "command", "started", { itemId: "tool-1", turnId: "turn-1" }));
  const tool = binder.current().tool;

  // Foreign-thread gaps are not this root's.
  binder.observe(unreadableEvent("questions", "helper-thread"));
  assert.equal(binder.current().asyncInput, "none");

  binder.observe(unreadableEvent("questions", A));
  assert.equal(binder.current().asyncInput, "unknown");
  assert.deepEqual(binder.current().tool, tool, "the tool fact is intact");
  assert.equal(binder.current().phase, "bound");

  // A positively known own question still proves pending.
  binder.observe(questionsEvent(A, "call-q", 1));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(replyEvent(A, [{ itemId: "call-q", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown", "an answer cannot restore lost knowledge");

  // Only the affected turn's positive terminal restores complete knowledge.
  binder.observe(terminalEvent(A, "turn-0"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-1"));
  assert.equal(binder.current().asyncInput, "none");

  // An unreadable committed user item could have answered a pending question:
  // the retained pending is no longer proof, and it becomes unknown.
  binder.observe(work(A, "turn-2"));
  binder.observe(questionsEvent(A, "call-u", 1, "turn-2"));
  binder.observe(unreadableEvent("user-input", A, "turn-2"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-2"));
  assert.equal(binder.current().asyncInput, "none");

  // A reply whose thread is unknown that names a pending question is a gap too.
  binder.observe(work(A, "turn-3"));
  binder.observe(questionsEvent(A, "call-v", 1, "turn-3"));
  binder.observe(replyEvent(undefined, [{ itemId: "call-v", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown");

  // Unattributed questions might be this root's: unknown until a root terminal.
  const other = boundBinder();
  other.observe(questionsEvent(undefined, "call-x", 1));
  assert.equal(other.current().asyncInput, "unknown");
  other.observe(terminalEvent(A, "turn-1"));
  assert.equal(other.current().asyncInput, "none");
});

test("withdrawal discards the async queue and the candidate binding", () => {
  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate(A));
  binder.observe(questionsEvent(A, "call-q", 1));
  binder.observe({ kind: "metadata-unavailable", connectionId: C, sequence: 30, scope: "message", reason: "json-unreadable" });
  assert.deepEqual(binder.current(), { phase: "withdrawn", connectionId: C, withdrawal: "metadata-unavailable" });
  binder.observe(questionsEvent(A, "call-r", 1));
  assert.equal(binder.current().asyncInput, undefined);
});

test("a question-metadata gap drops the affected pre-gap pending witness instead of keeping it as proof", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-q", 2, "turn-1"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(unreadableEvent("questions", A, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown", "retained pre-gap pending is no longer proof");
  // A replay of the dropped item never resurrects it; a fresh question does prove pending.
  binder.observe(questionsEvent(A, "call-q", 2, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(questionsEvent(A, "call-fresh", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(replyEvent(A, [{ itemId: "call-fresh", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown");

  // Unattributed question metadata (no thread, or no turn) drops every pending witness.
  const noTurn: NativeCodexTuiRelayMetadataEvent = {
    kind: "async-questions",
    connectionId: C,
    sequence: 10,
    itemId: "call-y",
    questionCount: 1,
    threadId: A,
  };
  for (const gap of [questionsEvent(undefined, "call-x", 1), noTurn, unreadableEvent("questions", undefined)]) {
    const other = boundBinder();
    other.observe(item(A, "command", "started", { itemId: "tool-1", turnId: "turn-1" }));
    other.observe(questionsEvent(A, "call-q", 1, "turn-1"));
    other.observe(gap);
    assert.equal(other.current().asyncInput, "unknown");
    assert.equal(other.current().tool?.itemId, "tool-1", "an input-only gap leaves the tool fact intact");
    assert.equal(other.current().phase, "bound");
  }
});

test("late replays across completed turns never resurrect, and stale terminals never rewind", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-q", 1, "turn-1"));
  binder.observe(terminalEvent(A, "turn-1"));
  binder.observe(work(A, "turn-2"));
  binder.observe(terminalEvent(A, "turn-2"));
  assert.equal(binder.current().asyncInput, "none");
  // Replay of turn 1's completion after turn 2 also finished.
  binder.observe(questionsEvent(A, "call-q", 1, "turn-1"));
  binder.observe(unreadableEvent("questions", A, "turn-1"));
  assert.equal(binder.current().asyncInput, "none");

  // During a newer turn, stale terminals neither retire its questions nor
  // clear its unattributed knowledge loss.
  binder.observe(work(A, "turn-3"));
  binder.observe(questionsEvent(A, "call-t3", 1, "turn-3"));
  binder.observe(terminalEvent(A, "turn-1"));
  binder.observe(terminalEvent(A, "turn-never-seen"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(questionsEvent(undefined, "call-unattributed", 1));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-2"));
  binder.observe(terminalEvent(A, "turn-never-seen"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-3"));
  assert.equal(binder.current().asyncInput, "none");
  // A repeated current terminal changes nothing.
  binder.observe(terminalEvent(A, "turn-3"));
  assert.equal(binder.current().asyncInput, "none");
});

test("another turn's questions are provisional: unknown until that exact turn is confirmed", () => {
  const binder = boundBinder();
  binder.observe(terminalEvent(A, "turn-1"));
  // The next own turn's question can precede its turn/start projection.
  binder.observe(questionsEvent(A, "call-next", 2, "turn-2"));
  assert.equal(binder.current().asyncInput, "unknown", "not yet pending proof, never none");
  binder.observe(replyEvent(A, [{ itemId: "call-next", index: 0 }]));
  binder.observe(work(A, "turn-2"));
  assert.equal(binder.current().asyncInput, "pending", "the confirmed turn promotes the unanswered question");
  binder.observe(replyEvent(A, [{ itemId: "call-next", index: 1 }]));
  assert.equal(binder.current().asyncInput, "none");

  // A replay older than the bounded retired-turn window can only reach the
  // provisional slot, never pending, and the next confirmed turn discards it.
  const old = boundBinder();
  old.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  old.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 12; turn += 1) {
    old.observe(work(A, `turn-${turn}`));
    old.observe(terminalEvent(A, `turn-${turn}`));
  }
  old.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  assert.equal(old.current().asyncInput, "unknown");
  old.observe(work(A, "turn-13"));
  assert.equal(old.current().asyncInput, "none");
});

test("gaps invalidate provisional questions too: unknown, never pending or none, until resolved", () => {
  const gaps: readonly [string, NativeCodexTuiRelayMetadataEvent, "finite" | "coverage"][] = [
    ["attributed question gap", unreadableEvent("questions", A, "turn-2"), "coverage"],
    ["unattributed question gap", unreadableEvent("questions", undefined), "coverage"],
    ["unreadable committed user item", unreadableEvent("user-input", A, "turn-2"), "finite"],
    ["matching whole-item reply without thread identity", replyEvent(undefined, [{ itemId: "call-next" }]), "finite"],
  ];
  for (const [label, gap, kind] of gaps) {
    const binder = boundBinder();
    // Turn 1 is current; turn 2's question precedes its own start projection.
    binder.observe(questionsEvent(A, "call-next", 2, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: provisional before the gap`);
    binder.observe(gap);
    binder.observe(questionsEvent(A, "call-next", 2, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: a replay restores nothing`);
    binder.observe(work(A, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: confirmation promotes no pre-gap witness`);
    binder.observe(questionsEvent(A, "call-next", 2, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: still no resurrection`);
    // A scoped committed reply resolves finite uncertainty at once, but never
    // proves that a publication gap hid no other question.
    binder.observe(replyEvent(A, [{ itemId: "call-next" }]));
    assert.equal(binder.current().asyncInput, kind === "finite" ? "none" : "unknown", `${label}: scoped reply`);
    binder.observe(terminalEvent(A, "turn-1"));
    assert.equal(binder.current().asyncInput, kind === "finite" ? "none" : "unknown", `${label}: an old terminal`);
    binder.observe(terminalEvent(A, "turn-2"));
    assert.equal(binder.current().asyncInput, "none", `${label}: the current terminal retires the queue`);
  }

  // In the provider's other order the CURRENT turn's live terminal comes
  // first: the native UI clears its whole queue there, so every held
  // uncertainty and gap retires, and the held identities still fence replays.
  for (const [label, gap] of gaps) {
    const binder = boundBinder();
    binder.observe(questionsEvent(A, "call-next", 2, "turn-2"));
    binder.observe(gap);
    binder.observe(terminalEvent(A, "turn-1"));
    assert.equal(binder.current().asyncInput, "none", `${label}: the current terminal is a complete boundary`);
    binder.observe(work(A, "turn-2"));
    binder.observe(questionsEvent(A, "call-next", 2, "turn-2"));
    assert.equal(binder.current().asyncInput, "none", `${label}: no replay reopens a retired question`);
  }

  // A reply without thread identity is scoped to the index it named: the
  // other question of that item is still positively pending once confirmed.
  const indexed = boundBinder();
  indexed.observe(questionsEvent(A, "call-next", 2, "turn-2"));
  indexed.observe(replyEvent(undefined, [{ itemId: "call-next", index: 0 }]));
  indexed.observe(work(A, "turn-2"));
  assert.equal(indexed.current().asyncInput, "pending");
  indexed.observe(replyEvent(A, [{ itemId: "call-next", index: 1 }]));
  assert.equal(indexed.current().asyncInput, "unknown", "index 0 may or may not have been answered");
  indexed.observe(replyEvent(A, [{ itemId: "call-next", index: 0 }]));
  assert.equal(indexed.current().asyncInput, "none", "its scoped reply resolves it before any terminal");
});

test("a competing turn never silently evicts an unanswered provisional question", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  binder.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 12; turn += 1) {
    binder.observe(work(A, `turn-${turn}`));
    binder.observe(terminalEvent(A, `turn-${turn}`));
  }
  // Turn 13's question precedes its start projection; then a turn-1 replay
  // from outside the retired-turn window competes for the one slot.
  binder.observe(questionsEvent(A, "call-13", 1, "turn-13"));
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(work(A, "turn-13"));
  assert.equal(binder.current().asyncInput, "pending", "turn 13's unanswered question is still represented");
  binder.observe(replyEvent(A, [{ itemId: "call-13", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown", "the collision's coverage loss is never a none");
  binder.observe(terminalEvent(A, "turn-13"));
  assert.equal(binder.current().asyncInput, "none");
});

/* ============================================ ordinary-prompt queue cancellation */

function ordinaryInput(
  threadId: string | undefined,
  requestIdKind: "native" | "native-helper" = "native",
  connectionId = C,
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "ordinary-input",
    connectionId,
    sequence: 14,
    requestIdKind,
    ...(threadId === undefined ? {} : { threadId }),
  };
}

test("a first ordinary prompt with nothing held keeps input none and the fresh binding unchanged", () => {
  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate(A));
  const candidate = binder.current();
  assert.equal(candidate.asyncInput, "none");
  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  binder.watch((snapshot) => seen.push(snapshot));
  // The first prompt's own client frame precedes its turn/start response.
  binder.observe(ordinaryInput(A));
  assert.strictEqual(binder.current(), candidate, "no uncertainty for a healthy first prompt");
  binder.observe(work(A, "turn-1"));
  assert.deepEqual(binder.current(), { phase: "bound", connectionId: C, rootThreadId: A, rootTurnId: "turn-1", asyncInput: "none" });
  binder.observe(ordinaryInput(A));
  assert.equal(binder.current().asyncInput, "none");
  assert.equal(seen.length, 2, "only the binding was a change");
});


test("an own ordinary prompt makes held questions uncertain; scoped replies recover none before any terminal", () => {
  const binder = boundBinder();
  binder.observe(item(A, "command", "started", { itemId: "tool-1", turnId: "turn-1" }));
  binder.observe(questionsEvent(A, "call-q1", 1));
  binder.observe(questionsEvent(A, "call-q2", 2));
  assert.equal(binder.current().asyncInput, "pending");
  const before = binder.current();

  // Helper and foreign-thread submissions are not this TUI's root input.
  binder.observe(ordinaryInput(A, "native-helper"));
  binder.observe(ordinaryInput("helper-thread"));
  assert.strictEqual(binder.current(), before);

  // The genuine own ordinary prompt: which held question the UI dropped is not
  // provable (one could still be in flight), so pending is never kept and never
  // guessed as none. Every other fact is unchanged.
  binder.observe(ordinaryInput(A));
  assert.equal(binder.current().asyncInput, "unknown");
  assert.deepEqual(binder.current().tool, before.tool);
  assert.equal(binder.current().rootTurnId, "turn-1");
  assert.equal(binder.current().phase, "bound");

  // Replays of the invalidated witnesses are never fresh proof.
  binder.observe(questionsEvent(A, "call-q1", 1));
  assert.equal(binder.current().asyncInput, "unknown");

  // A question published after the submission is fresh pending proof, and a
  // repeated acknowledgement of the same own turn cannot clear it.
  binder.observe(questionsEvent(A, "call-fresh", 1));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(work(A, "turn-1"));
  assert.equal(binder.current().asyncInput, "pending");
  // Once it is answered, the older real uncertainty is what remains.
  binder.observe(replyEvent(A, [{ itemId: "call-fresh", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown");

  // Partial resolution keeps unknown; resolving every uncertain question
  // recovers none immediately, before any terminal.
  binder.observe(replyEvent(A, [{ itemId: "call-q1", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown", "call-q2 is still uncertain");
  binder.observe(replyEvent(A, [{ itemId: "call-q2", index: 1 }]));
  assert.equal(binder.current().asyncInput, "unknown", "call-q2 index 0 is still uncertain");
  binder.observe(replyEvent(A, [{ itemId: "call-q2", index: 0 }]));
  assert.equal(binder.current().asyncInput, "none");
  assert.deepEqual(binder.current().tool, before.tool, "no cross-axis change");

  // A whole-item reply resolves every uncertain index of that item only.
  binder.observe(questionsEvent(A, "call-r", 3));
  binder.observe(questionsEvent(A, "call-s", 1));
  binder.observe(ordinaryInput(A));
  binder.observe(replyEvent(A, [{ itemId: "call-r" }]));
  assert.equal(binder.current().asyncInput, "unknown", "call-s remains uncertain");
  binder.observe(replyEvent(A, [{ itemId: "call-s" }]));
  assert.equal(binder.current().asyncInput, "none");
  // Answered or resolved identities never reopen.
  binder.observe(questionsEvent(A, "call-r", 3));
  binder.observe(questionsEvent(A, "call-q2", 2));
  assert.equal(binder.current().asyncInput, "none");
});

test("ordinary-prompt cancellation is scoped, never restores knowledge alone, and never promotes provisional witnesses", () => {
  // An unscoped own submission could be the root's: unknown, never stale pending.
  const unscoped = boundBinder();
  unscoped.observe(questionsEvent(A, "call-q", 1));
  unscoped.observe(ordinaryInput(undefined));
  assert.equal(unscoped.current().asyncInput, "unknown");
  unscoped.observe(replyEvent(A, [{ itemId: "call-q", index: 0 }]));
  assert.equal(unscoped.current().asyncInput, "none");

  // A publication gap stays unknown through a submission; only a complete
  // boundary (the current live terminal) recovers it.
  const lost = boundBinder();
  lost.observe(unreadableEvent("questions", undefined));
  lost.observe(ordinaryInput(A));
  assert.equal(lost.current().asyncInput, "unknown");
  lost.observe(terminalEvent(A, "turn-1"));
  assert.equal(lost.current().asyncInput, "none");

  // A provisional next-turn question held at submission is invalidated too:
  // its confirmation promotes uncertainty, never pending, and its scoped reply
  // resolves it.
  const provisional = boundBinder();
  provisional.observe(questionsEvent(A, "call-next", 1, "turn-2"));
  provisional.observe(ordinaryInput(A));
  provisional.observe(work(A, "turn-2"));
  assert.equal(provisional.current().asyncInput, "unknown");
  provisional.observe(questionsEvent(A, "call-next", 1, "turn-2"));
  assert.equal(provisional.current().asyncInput, "unknown", "the replay is not fresh proof");
  provisional.observe(replyEvent(A, [{ itemId: "call-next", index: 0 }]));
  assert.equal(provisional.current().asyncInput, "none");

  // A candidate's held question is covered the same way before binding.
  const candidate = attested();
  candidate.observe(initialize());
  candidate.observe(startCandidate(A));
  candidate.observe(questionsEvent(A, "call-early", 1));
  candidate.observe(ordinaryInput(A));
  assert.equal(candidate.current().asyncInput, "unknown");
  assert.equal(candidate.current().candidateThreadId, A);

  // Another generation's projection is a stream loss, never a clear.
  const foreign = boundBinder();
  foreign.observe(questionsEvent(A, "call-q", 1));
  foreign.observe(ordinaryInput(A, "native", C2));
  assert.equal(foreign.current().phase, "withdrawn");
  assert.equal(foreign.current().asyncInput, undefined);
  foreign.observe(ordinaryInput(A));
  assert.equal(foreign.current().phase, "withdrawn");
});

test("an unreadable user item or a reply without thread identity is recoverable by the matching scoped reply", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-q1", 1));
  binder.observe(questionsEvent(A, "call-q2", 1));
  binder.observe(unreadableEvent("user-input", A));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(replyEvent("helper-thread", [{ itemId: "call-q1" }, { itemId: "call-q2" }]));
  assert.equal(binder.current().asyncInput, "unknown", "a foreign reply is not recovery data");
  binder.observe(replyEvent(A, [{ itemId: "call-q1", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown", "call-q2 is still uncertain");
  binder.observe(replyEvent(A, [{ itemId: "call-q2", index: 0 }]));
  assert.equal(binder.current().asyncInput, "none", "recovered before any terminal");

  const unthreaded = boundBinder();
  unthreaded.observe(questionsEvent(A, "call-v", 1));
  unthreaded.observe(replyEvent(undefined, [{ itemId: "call-v", index: 0 }]));
  assert.equal(unthreaded.current().asyncInput, "unknown");
  unthreaded.observe(replyEvent(A, [{ itemId: "call-v", index: 0 }]));
  assert.equal(unthreaded.current().asyncInput, "none");
});

test("publication gaps prevent a false none; an item-scoped gap recovers from its own reply or full read", () => {
  // A turn-scoped gap names no item: no reply to another question proves none.
  const turnGap = boundBinder();
  turnGap.observe(questionsEvent(A, "call-q1", 1));
  turnGap.observe(unreadableEvent("questions", A));
  turnGap.observe(replyEvent(A, [{ itemId: "call-q1", index: 0 }]));
  assert.equal(turnGap.current().asyncInput, "unknown");
  turnGap.observe(terminalEvent(A, "turn-1"));
  assert.equal(turnGap.current().asyncInput, "none");

  const itemGap = (itemId: string): NativeCodexTuiRelayMetadataEvent => ({
    kind: "async-input-unreadable",
    connectionId: C,
    sequence: 12,
    source: "questions",
    itemId,
    threadId: A,
    turnId: "turn-1",
  });

  // An indexed reply to an item-scoped gap cannot prove its whole set answered;
  // the item's whole-item reply does.
  const whole = boundBinder();
  whole.observe(itemGap("call-g"));
  whole.observe(replyEvent(A, [{ itemId: "call-g", index: 0 }]));
  assert.equal(whole.current().asyncInput, "unknown");
  whole.observe(replyEvent(A, [{ itemId: "call-g" }]));
  assert.equal(whole.current().asyncInput, "none");
  whole.observe(questionsEvent(A, "call-g", 2));
  assert.equal(whole.current().asyncInput, "none", "an answered item never reopens");

  // A later full read of the same item on its current turn repairs it: its
  // unanswered questions are pending proof again, minus answered indices.
  const repaired = boundBinder();
  repaired.observe(itemGap("call-g"));
  repaired.observe(replyEvent(A, [{ itemId: "call-g", index: 1 }]));
  repaired.observe(questionsEvent(A, "call-g", 2));
  assert.equal(repaired.current().asyncInput, "pending");
  repaired.observe(replyEvent(A, [{ itemId: "call-g", index: 0 }]));
  assert.equal(repaired.current().asyncInput, "none", "index 1 was already answered");
  // Replays of an item already registered change nothing, readable or not.
  repaired.observe(itemGap("call-g"));
  repaired.observe(questionsEvent(A, "call-g", 2));
  assert.equal(repaired.current().asyncInput, "none");

  // If something since could have cleared it, the repair yields uncertainty.
  const cleared = boundBinder();
  cleared.observe(itemGap("call-g"));
  cleared.observe(ordinaryInput(A));
  cleared.observe(questionsEvent(A, "call-g", 1));
  assert.equal(cleared.current().asyncInput, "unknown");
  cleared.observe(replyEvent(A, [{ itemId: "call-g", index: 0 }]));
  assert.equal(cleared.current().asyncInput, "none");

  // A full read on a different turn, or after its turn is no longer current,
  // is not repair proof.
  const wrongTurn = boundBinder();
  wrongTurn.observe(itemGap("call-g"));
  wrongTurn.observe(questionsEvent(A, "call-g", 1, "turn-other"));
  assert.equal(wrongTurn.current().asyncInput, "unknown");
  wrongTurn.observe(work(A, "turn-2"));
  wrongTurn.observe(questionsEvent(A, "call-g", 1, "turn-1"));
  assert.equal(wrongTurn.current().asyncInput, "unknown");
  // The current live terminal is a complete boundary for everything held.
  wrongTurn.observe(terminalEvent(A, "turn-2"));
  assert.equal(wrongTurn.current().asyncInput, "none");
  wrongTurn.observe(questionsEvent(A, "call-g", 1, "turn-1"));
  assert.equal(wrongTurn.current().asyncInput, "none", "a retired gap item never reopens");
});

test("a fresh current question proves pending over old uncertainty; the live terminal recovers all", () => {
  const binder = boundBinder();
  binder.observe(item(A, "command", "started", { itemId: "tool-1", turnId: "turn-1" }));
  binder.observe(questionsEvent(A, "call-old", 1));
  binder.observe(ordinaryInput(A));
  // Turn 2 is confirmed without turn 1's terminal: turn 1's uncertainty stays.
  binder.observe(work(A, "turn-2"));
  binder.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(binder.current().asyncInput, "unknown", "the older real uncertainty is unresolved");
  binder.observe(questionsEvent(A, "call-q4", 1, "turn-2"));
  binder.observe(unreadableEvent("questions", undefined));
  assert.equal(binder.current().asyncInput, "unknown");
  // The current own live terminal clears the whole native queue.
  binder.observe(terminalEvent(A, "turn-2"));
  assert.equal(binder.current().asyncInput, "none");
  assert.equal(binder.current().phase, "bound");
  assert.equal(binder.current().rootTurnId, "turn-2");
  // Retired and resolved identities never reopen.
  binder.observe(questionsEvent(A, "call-old", 1));
  binder.observe(questionsEvent(A, "call-q4", 1, "turn-2"));
  assert.equal(binder.current().asyncInput, "none");
  // Without an answer, a new current turn's question is pending again.
  binder.observe(work(A, "turn-3"));
  binder.observe(questionsEvent(A, "call-q5", 1, "turn-3"));
  assert.equal(binder.current().asyncInput, "pending");
});

test("an old replay beyond the retired-turn window never latches unknown past the current live terminal", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  binder.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 10; turn += 1) {
    binder.observe(work(A, `turn-${turn}`));
    if (turn < 10) binder.observe(terminalEvent(A, `turn-${turn}`));
  }
  // Turn 1 fell out of the bounded fence: its replay is held provisionally,
  // never pending, and is unknown.
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(item(A, "command", "started", { itemId: "tool-10", turnId: "turn-10" }));
  binder.observe(questionsEvent(A, "call-t10", 1, "turn-10"));
  binder.observe(ordinaryInput(A));
  binder.observe(unreadableEvent("questions", undefined));
  assert.equal(binder.current().asyncInput, "unknown");

  // Stale terminals (an already retired turn, a turn never seen) during the
  // current turn retire nothing: current and provisional uncertainty stay.
  binder.observe(terminalEvent(A, "turn-9"));
  binder.observe(terminalEvent(A, "turn-never-seen"));
  binder.observe(terminalEvent("helper-thread", "turn-10"));
  assert.equal(binder.current().asyncInput, "unknown");

  // The CURRENT turn's live terminal clears the native UI's whole queue: every
  // question, uncertainty, and gap observed before it retires, including the
  // provisional replay whose own (long ended) terminal will never come.
  binder.observe(terminalEvent(A, "turn-10"));
  assert.equal(binder.current().asyncInput, "none");
  assert.equal(binder.current().tool?.itemId, "tool-10", "no cross-axis change");
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  binder.observe(questionsEvent(A, "call-t10", 1, "turn-10"));
  assert.equal(binder.current().asyncInput, "none", "retired questions never reopen");

  // Data after the boundary keeps its own admission fences: the next turn's
  // question is provisional (unknown) until confirmed, then pending; the
  // emptied old slot never turns it into a collision gap.
  binder.observe(questionsEvent(A, "call-t11", 1, "turn-11"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(work(A, "turn-11"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(replyEvent(A, [{ itemId: "call-t11", index: 0 }]));
  assert.equal(binder.current().asyncInput, "none");
});

test("a terminal matching an unconfirmed provisional replay is not retirement proof", () => {
  const binder = boundBinder();
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  binder.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 10; turn += 1) {
    binder.observe(work(A, `turn-${turn}`));
    if (turn < 10) binder.observe(terminalEvent(A, `turn-${turn}`));
  }
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  // A stale copy of turn 1's terminal: no current-queue boundary, so unknown stays.
  binder.observe(terminalEvent(A, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-1"));
  binder.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown", "neither a repeat nor a replay restores anything");
  // The current turn's live terminal is the complete boundary.
  binder.observe(terminalEvent(A, "turn-10"));
  assert.equal(binder.current().asyncInput, "none");

  // A positively scoped committed reply still recovers before any terminal.
  const replied = boundBinder();
  replied.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  replied.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 10; turn += 1) {
    replied.observe(work(A, `turn-${turn}`));
    if (turn < 10) replied.observe(terminalEvent(A, `turn-${turn}`));
  }
  replied.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  replied.observe(terminalEvent(A, "turn-1"));
  replied.observe(replyEvent(A, [{ itemId: "call-old", index: 0 }]));
  assert.equal(replied.current().asyncInput, "none");

  // A genuine next turn whose terminal precedes its own start projection:
  // unknown until that exact turn is confirmed, then none at once — no second
  // terminal or reply is needed, and a later duplicate changes nothing.
  const early = boundBinder();
  early.observe(terminalEvent(A, "turn-1"));
  early.observe(questionsEvent(A, "call-next", 1, "turn-2"));
  early.observe(terminalEvent(A, "turn-2"));
  assert.equal(early.current().asyncInput, "unknown");
  early.observe(work(A, "turn-2"));
  assert.equal(early.current().asyncInput, "none");
  assert.equal(early.current().rootTurnId, "turn-2");
  early.observe(terminalEvent(A, "turn-2"));
  early.observe(questionsEvent(A, "call-next", 1, "turn-2"));
  assert.equal(early.current().asyncInput, "none", "a duplicate or replay reopens nothing");
});

test("a stale terminal cannot resolve an unconfirmed turn-only publication gap", () => {
  const binder = boundBinder();
  binder.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 10; turn += 1) {
    binder.observe(work(A, `turn-${turn}`));
    if (turn < 10) binder.observe(terminalEvent(A, `turn-${turn}`));
  }
  binder.observe(unreadableEvent("questions", A, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-1"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-10"));
  assert.equal(binder.current().asyncInput, "none");
});

/* ================================== early provisional terminal reconciliation */

function itemGapEvent(itemId: string, turnId: string): NativeCodexTuiRelayMetadataEvent {
  return { kind: "async-input-unreadable", connectionId: C, sequence: 12, source: "questions", itemId, threadId: A, turnId };
}

/** Turn 1 is confirmed and ended; turn 2's question precedes its own start projection. */
function earlyTurnTwo(): NativeCodexTuiRootFactsBinder {
  const binder = boundBinder();
  binder.observe(terminalEvent(A, "turn-1"));
  binder.observe(questionsEvent(A, "call-q2", 1, "turn-2"));
  return binder;
}

test("an early terminal becomes the whole-queue boundary only on its own exact turn confirmation", () => {
  // The confirmation publishes one consistent change: none on the new turn.
  const binder = earlyTurnTwo();
  binder.observe(terminalEvent(A, "turn-2"));
  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  binder.watch((snapshot) => seen.push(snapshot));
  binder.observe(work(A, "turn-2"));
  assert.deepEqual(seen.map((snapshot) => [snapshot.rootTurnId, snapshot.asyncInput]), [
    ["turn-1", "unknown"],
    ["turn-2", "none"],
  ]);

  // Held current-turn knowledge stays authoritative until that confirmation:
  // an unconfirmed terminal, helper work, and repeats retire nothing.
  const whole = boundBinder();
  whole.observe(questionsEvent(A, "call-q1", 1, "turn-1"));
  whole.observe(questionsEvent(A, "call-q2", 1, "turn-2"));
  whole.observe(terminalEvent(A, "turn-2"));
  assert.equal(whole.current().asyncInput, "pending", "an unconfirmed terminal is no authority");
  whole.observe(work(A, "turn-2", "native-helper"));
  whole.observe(terminalEvent("helper-thread", "turn-2"));
  whole.observe(terminalEvent(A, "turn-2"));
  assert.equal(whole.current().asyncInput, "pending");
  assert.equal(whole.current().rootTurnId, "turn-1");
  // The exact own confirmation: the native UI cleared its WHOLE root queue at
  // that terminal, so the earlier turn's held question retired too.
  whole.observe(work(A, "turn-2"));
  assert.equal(whole.current().asyncInput, "none");
  whole.observe(terminalEvent(A, "turn-2"));
  whole.observe(questionsEvent(A, "call-q1", 1, "turn-1"));
  whole.observe(questionsEvent(A, "call-q2", 1, "turn-2"));
  assert.equal(whole.current().asyncInput, "none", "retired identities never resurrect");
  // A later turn's question is fresh pending proof once confirmed.
  whole.observe(work(A, "turn-3"));
  whole.observe(questionsEvent(A, "call-q3", 1, "turn-3"));
  assert.equal(whole.current().asyncInput, "pending");

  // Pre-boundary publication gaps (unattributed, item-scoped) are covered.
  const gaps = earlyTurnTwo();
  gaps.observe(questionsEvent(undefined, "call-x", 1));
  gaps.observe(itemGapEvent("call-g", "turn-2"));
  gaps.observe(unreadableEvent("questions", A, "turn-2"));
  gaps.observe(terminalEvent(A, "turn-2"));
  assert.equal(gaps.current().asyncInput, "unknown");
  gaps.observe(work(A, "turn-2"));
  assert.equal(gaps.current().asyncInput, "none");
  gaps.observe(questionsEvent(A, "call-g", 2, "turn-2"));
  assert.equal(gaps.current().asyncInput, "none", "a full read of a retired gap item never reopens");
});

test("a held early terminal is consumed by no foreign, helper, or wrong-turn work", () => {
  // Wrong-turn confirmation discards the slot and its witness unused: the
  // still-current turn's held question is not retired by it.
  const wrong = boundBinder();
  wrong.observe(questionsEvent(A, "call-q1", 1, "turn-1"));
  wrong.observe(questionsEvent(A, "call-q2", 1, "turn-2"));
  wrong.observe(terminalEvent(A, "turn-2"));
  wrong.observe(work(A, "turn-3"));
  assert.equal(wrong.current().asyncInput, "pending");
  wrong.observe(work(A, "turn-2"));
  assert.equal(wrong.current().asyncInput, "pending", "the dropped witness never revives");
  wrong.observe(replyEvent(A, [{ itemId: "call-q1", index: 0 }]));
  assert.equal(wrong.current().asyncInput, "none");

  // A pre-boundary gap likewise stays unknown until a usable boundary.
  const gap = earlyTurnTwo();
  gap.observe(unreadableEvent("questions", undefined));
  gap.observe(terminalEvent(A, "turn-2"));
  gap.observe(work(A, "turn-2", "native-helper"));
  assert.equal(gap.current().asyncInput, "unknown");
  gap.observe(work(A, "turn-3"));
  assert.equal(gap.current().asyncInput, "unknown");
  gap.observe(terminalEvent(A, "turn-3"));
  assert.equal(gap.current().asyncInput, "none");

  // Foreign-thread work or another connection's work is a withdrawal, never a confirmation.
  const foreign = earlyTurnTwo();
  foreign.observe(terminalEvent(A, "turn-2"));
  foreign.observe(work("thread-b", "turn-2"));
  assert.deepEqual(foreign.current(), { phase: "withdrawn", connectionId: C, withdrawal: "work-on-another-thread" });
  const otherConnection = earlyTurnTwo();
  otherConnection.observe(terminalEvent(A, "turn-2"));
  otherConnection.observe({ kind: "turn-work-target", connectionId: C2, sequence: 3, requestIdKind: "native", threadId: A, turnId: "turn-2" });
  assert.equal(otherConnection.current().phase, "withdrawn");
  otherConnection.observe(work(A, "turn-2"));
  assert.equal(otherConnection.current().asyncInput, undefined);

  // An old replay's terminal held beyond the retired-turn window never clears
  // current knowledge, and the next confirmed turn drops it unused.
  const stale = boundBinder();
  stale.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 10; turn += 1) {
    stale.observe(work(A, `turn-${turn}`));
    if (turn < 10) stale.observe(terminalEvent(A, `turn-${turn}`));
  }
  stale.observe(questionsEvent(A, "call-old", 1, "turn-1"));
  stale.observe(questionsEvent(A, "call-t10", 1, "turn-10"));
  stale.observe(terminalEvent(A, "turn-1"));
  assert.equal(stale.current().asyncInput, "pending");
  stale.observe(questionsEvent(undefined, "call-x", 1));
  stale.observe(work(A, "turn-11"));
  assert.equal(stale.current().asyncInput, "unknown");
  stale.observe(terminalEvent(A, "turn-11"));
  assert.equal(stale.current().asyncInput, "none");
});

test("knowledge first observed after an early terminal survives its confirmation", () => {
  // A fresh question for the confirmed turn after its early terminal.
  const fresh = earlyTurnTwo();
  fresh.observe(questionsEvent(undefined, "call-x", 1));
  fresh.observe(terminalEvent(A, "turn-2"));
  fresh.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  fresh.observe(work(A, "turn-2"));
  assert.equal(fresh.current().asyncInput, "pending");
  fresh.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(fresh.current().asyncInput, "none", "only pre-boundary knowledge retired");

  // A repeated early terminal never widens the boundary over later evidence:
  // the question between the two copies is uncertain, never retired.
  const repeated = earlyTurnTwo();
  repeated.observe(terminalEvent(A, "turn-2"));
  repeated.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  repeated.observe(terminalEvent(A, "turn-2"));
  repeated.observe(work(A, "turn-2"));
  assert.equal(repeated.current().asyncInput, "unknown");
  repeated.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(repeated.current().asyncInput, "none");

  // Publication gaps after the boundary: unattributed, turn-scoped, item-scoped.
  const later: readonly [string, NativeCodexTuiRelayMetadataEvent][] = [
    ["unattributed gap", unreadableEvent("questions", undefined)],
    ["turn-scoped gap", unreadableEvent("questions", A, "turn-2")],
    ["item-scoped gap", itemGapEvent("call-h", "turn-2")],
    ["unattributed question", questionsEvent(undefined, "call-y", 1)],
  ];
  for (const [label, gap] of later) {
    const binder = earlyTurnTwo();
    binder.observe(terminalEvent(A, "turn-2"));
    binder.observe(gap);
    binder.observe(work(A, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: never emptied by the confirmation`);
    binder.observe(terminalEvent(A, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: a repeat terminal is no new boundary`);
    binder.observe(work(A, "turn-3"));
    binder.observe(terminalEvent(A, "turn-3"));
    assert.equal(binder.current().asyncInput, "none", `${label}: the next live terminal retires it`);
  }
  const itemScoped = earlyTurnTwo();
  itemScoped.observe(terminalEvent(A, "turn-2"));
  itemScoped.observe(itemGapEvent("call-h", "turn-2"));
  itemScoped.observe(work(A, "turn-2"));
  itemScoped.observe(replyEvent(A, [{ itemId: "call-h" }]));
  assert.equal(itemScoped.current().asyncInput, "none", "its own whole-item reply resolves it");

  // Its own authoritative full read still repairs it after confirmation.
  const emptyRead = earlyTurnTwo();
  emptyRead.observe(terminalEvent(A, "turn-2"));
  emptyRead.observe(itemGapEvent("call-h", "turn-2"));
  emptyRead.observe(work(A, "turn-2"));
  emptyRead.observe(questionsEvent(A, "call-h", 0, "turn-2"));
  assert.equal(emptyRead.current().asyncInput, "none", "a complete empty read resolves it at once");

  const fullRead = earlyTurnTwo();
  fullRead.observe(terminalEvent(A, "turn-2"));
  fullRead.observe(itemGapEvent("call-h", "turn-2"));
  fullRead.observe(work(A, "turn-2"));
  fullRead.observe(questionsEvent(A, "call-h", 2, "turn-2"));
  assert.equal(fullRead.current().asyncInput, "pending", "a nonempty repair is pending proof");
  // Retired pre-boundary identities, new items of the retired turn, and a
  // second copy of the repaired item all stay fenced.
  fullRead.observe(questionsEvent(A, "call-q2", 1, "turn-2"));
  fullRead.observe(questionsEvent(A, "call-new", 1, "turn-2"));
  fullRead.observe(itemGapEvent("call-h", "turn-2"));
  fullRead.observe(questionsEvent(A, "call-h", 3, "turn-2"));
  fullRead.observe(replyEvent(A, [{ itemId: "call-h", index: 0 }, { itemId: "call-h", index: 1 }]));
  assert.equal(fullRead.current().asyncInput, "none");

  // Possible clearing since the gap makes the repair uncertain, never pending.
  const clearedRead = earlyTurnTwo();
  clearedRead.observe(terminalEvent(A, "turn-2"));
  clearedRead.observe(itemGapEvent("call-h", "turn-2"));
  clearedRead.observe(work(A, "turn-2"));
  clearedRead.observe(ordinaryInput(A));
  clearedRead.observe(questionsEvent(A, "call-h", 1, "turn-2"));
  assert.equal(clearedRead.current().asyncInput, "unknown");
  clearedRead.observe(replyEvent(A, [{ itemId: "call-h", index: 0 }]));
  assert.equal(clearedRead.current().asyncInput, "none");

  // Once a later turn is current, that read is no repair proof.
  const laterRead = earlyTurnTwo();
  laterRead.observe(terminalEvent(A, "turn-2"));
  laterRead.observe(itemGapEvent("call-h", "turn-2"));
  laterRead.observe(work(A, "turn-2"));
  laterRead.observe(work(A, "turn-3"));
  laterRead.observe(questionsEvent(A, "call-h", 0, "turn-2"));
  assert.equal(laterRead.current().asyncInput, "unknown");
  laterRead.observe(terminalEvent(A, "turn-3"));
  assert.equal(laterRead.current().asyncInput, "none");

  // Uncertainty arising after the boundary on a post-boundary question.
  const uncertain = earlyTurnTwo();
  uncertain.observe(terminalEvent(A, "turn-2"));
  uncertain.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  uncertain.observe(ordinaryInput(A));
  uncertain.observe(work(A, "turn-2"));
  assert.equal(uncertain.current().asyncInput, "unknown");
  uncertain.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(uncertain.current().asyncInput, "none");

  // A competing turn's question after the boundary is a coverage loss that survives.
  const competing = earlyTurnTwo();
  competing.observe(terminalEvent(A, "turn-2"));
  competing.observe(questionsEvent(A, "call-q4", 1, "turn-4"));
  competing.observe(work(A, "turn-2"));
  assert.equal(competing.current().asyncInput, "unknown");
});

test("slot replacement and withdrawal drop a held early terminal witness", () => {
  // Once its slot holds nothing unresolved, a newer provisional turn replaces
  // it and the witness goes with it: confirming turn 2 then proves nothing,
  // and the now-current turn's own live terminal still recovers.
  const replaced = earlyTurnTwo();
  replaced.observe(unreadableEvent("questions", undefined));
  replaced.observe(terminalEvent(A, "turn-2"));
  replaced.observe(replyEvent(A, [{ itemId: "call-q2", index: 0 }]));
  replaced.observe(questionsEvent(A, "call-q3", 1, "turn-3"));
  replaced.observe(work(A, "turn-2"));
  assert.equal(replaced.current().asyncInput, "unknown");
  replaced.observe(terminalEvent(A, "turn-2"));
  assert.equal(replaced.current().asyncInput, "none");

  const withdrawn = earlyTurnTwo();
  withdrawn.observe(terminalEvent(A, "turn-2"));
  withdrawn.observe({ kind: "metadata-unavailable", connectionId: C, sequence: 30, scope: "message", reason: "json-unreadable" });
  withdrawn.observe(work(A, "turn-2"));
  assert.deepEqual(withdrawn.current(), { phase: "withdrawn", connectionId: C, withdrawal: "metadata-unavailable" });
});

/* ============================== gap-only early provisional terminal reconciliation */

/** Turn 1 is confirmed and ended; turn 2's unreadable publication (no item) precedes its start projection. */
function gapOnlyTurnTwo(): NativeCodexTuiRootFactsBinder {
  const binder = boundBinder();
  binder.observe(terminalEvent(A, "turn-1"));
  binder.observe(unreadableEvent("questions", A, "turn-2"));
  return binder;
}

test("a gap-only early terminal recovers on its own exact turn confirmation without a duplicate", () => {
  const binder = gapOnlyTurnTwo();
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(terminalEvent(A, "turn-2"));
  assert.equal(binder.current().asyncInput, "unknown", "the terminal alone could be stale");
  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  binder.watch((snapshot) => seen.push(snapshot));
  binder.observe(work(A, "turn-2"));
  assert.deepEqual(seen.map((snapshot) => [snapshot.rootTurnId, snapshot.asyncInput]), [
    ["turn-1", "unknown"],
    ["turn-2", "none"],
  ]);
  // A duplicate terminal or gap copy for the retired turn reopens nothing.
  binder.observe(terminalEvent(A, "turn-2"));
  binder.observe(unreadableEvent("questions", A, "turn-2"));
  assert.equal(binder.current().asyncInput, "none");
  binder.observe(work(A, "turn-3"));
  binder.observe(questionsEvent(A, "call-q3", 1, "turn-3"));
  assert.equal(binder.current().asyncInput, "pending", "a later fresh question is pending proof");

  // Negative control: confirmation alone is no boundary. Without the held
  // terminal the gap stays unknown until the now-current turn's live terminal.
  const noTerminal = gapOnlyTurnTwo();
  noTerminal.observe(work(A, "turn-2"));
  assert.equal(noTerminal.current().asyncInput, "unknown");
  noTerminal.observe(terminalEvent(A, "turn-2"));
  assert.equal(noTerminal.current().asyncInput, "none");

  // An old confirmed turn's held question is not retired by the unconfirmed
  // gap or its terminal; the exact own confirmation makes that terminal the
  // whole-root queue boundary for everything held before it.
  const whole = boundBinder();
  whole.observe(questionsEvent(A, "call-q1", 1, "turn-1"));
  whole.observe(unreadableEvent("questions", A, "turn-2"));
  assert.equal(whole.current().asyncInput, "pending", "a gap on another turn is no cancellation");
  whole.observe(terminalEvent(A, "turn-2"));
  assert.equal(whole.current().asyncInput, "pending", "an unconfirmed terminal is no authority");
  whole.observe(work(A, "turn-2", "native-helper"));
  whole.observe(terminalEvent("helper-thread", "turn-2"));
  whole.observe(terminalEvent(A, "turn-2"));
  assert.equal(whole.current().asyncInput, "pending");
  assert.equal(whole.current().rootTurnId, "turn-1");
  whole.observe(work(A, "turn-2"));
  assert.equal(whole.current().asyncInput, "none");
  assert.equal(whole.current().rootTurnId, "turn-2");
  whole.observe(questionsEvent(A, "call-q1", 1, "turn-1"));
  whole.observe(unreadableEvent("questions", A, "turn-2"));
  assert.equal(whole.current().asyncInput, "none", "retired identities never resurrect");

  // Pre-boundary unattributed and item-scoped gaps are covered too.
  const gaps = gapOnlyTurnTwo();
  gaps.observe(unreadableEvent("questions", undefined));
  gaps.observe(itemGapEvent("call-g", "turn-2"));
  gaps.observe(terminalEvent(A, "turn-2"));
  assert.equal(gaps.current().asyncInput, "unknown");
  gaps.observe(work(A, "turn-2"));
  assert.equal(gaps.current().asyncInput, "none");
  gaps.observe(questionsEvent(A, "call-g", 2, "turn-2"));
  assert.equal(gaps.current().asyncInput, "none", "a full read of a retired gap item never reopens");

  // Pre-boundary ordinary input made the held question uncertain; the boundary covers it.
  const prompted = boundBinder();
  prompted.observe(questionsEvent(A, "call-q1", 1, "turn-1"));
  prompted.observe(ordinaryInput(A));
  prompted.observe(unreadableEvent("questions", A, "turn-2"));
  prompted.observe(terminalEvent(A, "turn-2"));
  assert.equal(prompted.current().asyncInput, "unknown");
  prompted.observe(work(A, "turn-2"));
  assert.equal(prompted.current().asyncInput, "none");
});

test("a gap-only early terminal is consumed by no stale, foreign, helper, or wrong-turn evidence", () => {
  // Wrong-turn confirmation drops the witness; it never revives.
  const wrong = gapOnlyTurnTwo();
  wrong.observe(terminalEvent(A, "turn-2"));
  wrong.observe(work(A, "turn-3"));
  assert.equal(wrong.current().asyncInput, "unknown");
  wrong.observe(work(A, "turn-2"));
  assert.equal(wrong.current().asyncInput, "unknown", "the dropped witness never revives");
  wrong.observe(terminalEvent(A, "turn-2"));
  assert.equal(wrong.current().asyncInput, "none", "the current turn's own live terminal recovers");

  // Foreign-thread and helper terminals are never the witness.
  const foreign = gapOnlyTurnTwo();
  foreign.observe(terminalEvent("thread-b", "turn-2"));
  foreign.observe(terminalEvent("helper-thread", "turn-2"));
  foreign.observe(work(A, "turn-2", "native-helper"));
  assert.equal(foreign.current().asyncInput, "unknown");
  foreign.observe(work(A, "turn-2"));
  assert.equal(foreign.current().asyncInput, "unknown", "no own terminal was witnessed");

  // Other-connection terminals or work withdraw; nothing is ever confirmed.
  const otherConnection = gapOnlyTurnTwo();
  otherConnection.observe({ kind: "turn-terminal", connectionId: C2, sequence: 13, threadId: A, turnId: "turn-2", status: "completed" });
  assert.equal(otherConnection.current().phase, "withdrawn");
  otherConnection.observe(work(A, "turn-2"));
  assert.equal(otherConnection.current().asyncInput, undefined);

  // An unattributed gap never claims a turn's slot, so a terminal it might
  // explain is stale and the gap stays until a usable boundary.
  const unattributed = boundBinder();
  unattributed.observe(terminalEvent(A, "turn-1"));
  unattributed.observe(unreadableEvent("questions", undefined));
  unattributed.observe(terminalEvent(A, "turn-2"));
  unattributed.observe(work(A, "turn-2"));
  assert.equal(unattributed.current().asyncInput, "unknown");
  unattributed.observe(terminalEvent(A, "turn-2"));
  assert.equal(unattributed.current().asyncInput, "none");

  // A stale old-turn gap beyond the retired-turn window: its terminal is held
  // untrusted, retires nothing, and the next confirmed turn drops it unused.
  const stale = boundBinder();
  stale.observe(terminalEvent(A, "turn-1"));
  for (let turn = 2; turn <= 10; turn += 1) {
    stale.observe(work(A, `turn-${turn}`));
    if (turn < 10) stale.observe(terminalEvent(A, `turn-${turn}`));
  }
  stale.observe(questionsEvent(A, "call-t10", 1, "turn-10"));
  stale.observe(unreadableEvent("questions", A, "turn-1"));
  stale.observe(terminalEvent(A, "turn-1"));
  assert.equal(stale.current().asyncInput, "pending", "current knowledge is untouched");
  stale.observe(work(A, "turn-11"));
  stale.observe(replyEvent(A, [{ itemId: "call-t10", index: 0 }]));
  assert.equal(stale.current().asyncInput, "unknown", "the stale gap was never retired");
  stale.observe(terminalEvent(A, "turn-11"));
  assert.equal(stale.current().asyncInput, "none");
});

test("knowledge first observed after a gap-only early terminal survives its confirmation", () => {
  // A renewed same-turn gap after the terminal keeps its own knowledge, and a
  // repeated terminal is no new boundary.
  const renewed = gapOnlyTurnTwo();
  renewed.observe(terminalEvent(A, "turn-2"));
  renewed.observe(unreadableEvent("questions", A, "turn-2"));
  renewed.observe(work(A, "turn-2"));
  assert.equal(renewed.current().asyncInput, "unknown");
  renewed.observe(terminalEvent(A, "turn-2"));
  assert.equal(renewed.current().asyncInput, "unknown");
  renewed.observe(work(A, "turn-3"));
  renewed.observe(terminalEvent(A, "turn-3"));
  assert.equal(renewed.current().asyncInput, "none");

  // A fresh question for the confirmed turn after its terminal is pending proof.
  const fresh = gapOnlyTurnTwo();
  fresh.observe(terminalEvent(A, "turn-2"));
  fresh.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  fresh.observe(work(A, "turn-2"));
  assert.equal(fresh.current().asyncInput, "pending");
  fresh.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(fresh.current().asyncInput, "none", "only pre-boundary knowledge retired");

  // The first stored terminal is the cutoff: a repeat never widens it over
  // the question between the copies, which stays uncertain until answered.
  const repeated = gapOnlyTurnTwo();
  repeated.observe(terminalEvent(A, "turn-2"));
  repeated.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  repeated.observe(terminalEvent(A, "turn-2"));
  repeated.observe(work(A, "turn-2"));
  assert.equal(repeated.current().asyncInput, "unknown");
  repeated.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(repeated.current().asyncInput, "none");

  // Post-boundary unattributed and item gaps, and post-boundary uncertainty.
  const later: readonly [string, NativeCodexTuiRelayMetadataEvent][] = [
    ["unattributed gap", unreadableEvent("questions", undefined)],
    ["item-scoped gap", itemGapEvent("call-h", "turn-2")],
    ["unattributed question", questionsEvent(undefined, "call-y", 1)],
  ];
  for (const [label, gap] of later) {
    const binder = gapOnlyTurnTwo();
    binder.observe(terminalEvent(A, "turn-2"));
    binder.observe(gap);
    binder.observe(work(A, "turn-2"));
    assert.equal(binder.current().asyncInput, "unknown", `${label}: never emptied by the confirmation`);
    binder.observe(work(A, "turn-3"));
    binder.observe(terminalEvent(A, "turn-3"));
    assert.equal(binder.current().asyncInput, "none", `${label}: the next live terminal retires it`);
  }
  const uncertain = gapOnlyTurnTwo();
  uncertain.observe(terminalEvent(A, "turn-2"));
  uncertain.observe(questionsEvent(A, "call-q3", 1, "turn-2"));
  uncertain.observe(ordinaryInput(A));
  uncertain.observe(work(A, "turn-2"));
  assert.equal(uncertain.current().asyncInput, "unknown");
  uncertain.observe(replyEvent(A, [{ itemId: "call-q3", index: 0 }]));
  assert.equal(uncertain.current().asyncInput, "none");
});

test("slot replacement and withdrawal drop a gap-only early terminal witness", () => {
  // A newer turn's question takes the gap-only slot: the witness never leaks.
  const question = gapOnlyTurnTwo();
  question.observe(terminalEvent(A, "turn-2"));
  question.observe(questionsEvent(A, "call-q3", 1, "turn-3"));
  question.observe(work(A, "turn-2"));
  assert.equal(question.current().asyncInput, "unknown");
  question.observe(terminalEvent(A, "turn-2"));
  assert.equal(question.current().asyncInput, "none");

  // A newer turn's gap takes the slot: the old witness never applies to it.
  const newerGap = gapOnlyTurnTwo();
  newerGap.observe(terminalEvent(A, "turn-2"));
  newerGap.observe(unreadableEvent("questions", A, "turn-3"));
  newerGap.observe(work(A, "turn-3"));
  assert.equal(newerGap.current().asyncInput, "unknown");
  newerGap.observe(work(A, "turn-2"));
  assert.equal(newerGap.current().asyncInput, "unknown");

  // A slot holding another turn's unresolved question is never displaced by a
  // turn-only gap, so that gap's terminal stays stale until a usable boundary.
  const competing = boundBinder();
  competing.observe(terminalEvent(A, "turn-1"));
  competing.observe(questionsEvent(A, "call-q3", 1, "turn-3"));
  competing.observe(unreadableEvent("questions", A, "turn-2"));
  competing.observe(terminalEvent(A, "turn-2"));
  competing.observe(work(A, "turn-2"));
  assert.equal(competing.current().asyncInput, "unknown");
  competing.observe(terminalEvent(A, "turn-2"));
  assert.equal(competing.current().asyncInput, "none");

  const withdrawn = gapOnlyTurnTwo();
  withdrawn.observe(terminalEvent(A, "turn-2"));
  withdrawn.observe({ kind: "metadata-unavailable", connectionId: C, sequence: 30, scope: "message", reason: "json-unreadable" });
  withdrawn.observe(work(A, "turn-2"));
  assert.deepEqual(withdrawn.current(), { phase: "withdrawn", connectionId: C, withdrawal: "metadata-unavailable" });
});

test("a complete empty copy resolves its own item-scoped gap, never an unrelated one", () => {
  const itemGap = (itemId: string): NativeCodexTuiRelayMetadataEvent => ({
    kind: "async-input-unreadable",
    connectionId: C,
    sequence: 12,
    source: "questions",
    itemId,
    threadId: A,
    turnId: "turn-1",
  });
  const binder = boundBinder();
  binder.observe(itemGap("call-g"));
  assert.equal(binder.current().asyncInput, "unknown");
  binder.observe(questionsEvent(A, "call-g", 0));
  assert.equal(binder.current().asyncInput, "none", "resolved before any terminal");
  // An empty list alone registers nothing, and never reopens a known item.
  binder.observe(questionsEvent(A, "call-empty", 0));
  binder.observe(questionsEvent(A, "call-g", 2));
  assert.equal(binder.current().asyncInput, "none");
  binder.observe(questionsEvent(A, "call-empty", 1));
  assert.equal(binder.current().asyncInput, "pending", "the native queue never registered the empty item");

  // Another item's empty copy, or one on another turn, resolves nothing.
  const unrelated = boundBinder();
  unrelated.observe(itemGap("call-g"));
  unrelated.observe(questionsEvent(A, "call-h", 0));
  unrelated.observe(questionsEvent(A, "call-g", 0, "turn-other"));
  assert.equal(unrelated.current().asyncInput, "unknown");
  // Nor does it clear a turn-scoped gap or other uncertainty.
  unrelated.observe(questionsEvent(A, "call-q", 1));
  unrelated.observe(ordinaryInput(A));
  unrelated.observe(unreadableEvent("questions", A));
  unrelated.observe(questionsEvent(A, "call-g", 0));
  assert.equal(unrelated.current().asyncInput, "unknown");
  unrelated.observe(replyEvent(A, [{ itemId: "call-q", index: 0 }]));
  assert.equal(unrelated.current().asyncInput, "unknown", "the turn-scoped gap remains");
  unrelated.observe(terminalEvent(A, "turn-1"));
  assert.equal(unrelated.current().asyncInput, "none");
});

/* ============================================ exact restored root (restore mode) */

const B = "019a0000-0000-7000-8000-00000000000b";

interface ResumeOptions {
  /** The request's own `params.threadId`; `null` omits it. Defaults to the response id. */
  readonly requested?: string | null;
  readonly origin?: "thread-resume" | "thread-fork";
  readonly requestIdKind?: "native" | "native-helper";
  readonly parentThreadId?: string;
  readonly ephemeral?: boolean;
}

function resumeCandidate(threadId: string, options: ResumeOptions = {}): NativeCodexTuiRelayMetadataEvent {
  const requested = options.requested === undefined ? threadId : options.requested;
  return {
    kind: "thread-candidate",
    connectionId: C,
    sequence: 2,
    origin: options.origin ?? "thread-resume",
    requestIdKind: options.requestIdKind ?? "native",
    threadId,
    ...(requested === null ? {} : { requestedThreadId: requested }),
    ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
    ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
  };
}

/** Restore-mode binder with the empty witness and the genuine generation. */
function restoring(): NativeCodexTuiRootFactsBinder {
  const binder = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  binder.attestEmptyBackend();
  binder.observe(initialize());
  return binder;
}

/** Restore-mode binder holding the exact restored candidate B. */
function restored(): NativeCodexTuiRootFactsBinder {
  const binder = restoring();
  binder.observe(resumeCandidate(B, { ephemeral: false }));
  return binder;
}

function withdrawnWith(withdrawal: NativeCodexTuiRootWithdrawalReason): NativeCodexTuiRootFactsSnapshot {
  return { phase: "withdrawn", connectionId: C, withdrawal };
}

test("restore options are validated, and absent options keep the exact fresh-only binder", () => {
  for (const bad of ["", "x".repeat(257), "bad\nid", "bad\u007Fid", 42, null]) {
    assert.throws(
      () => createNativeCodexTuiRootFactsBinder({ resumeConversationId: bad as unknown as string }),
      TypeError,
    );
  }
  assert.throws(() => createNativeCodexTuiRootFactsBinder(null as unknown as undefined), TypeError);
  assert.doesNotThrow(() => createNativeCodexTuiRootFactsBinder({ resumeConversationId: "x".repeat(256) }));

  // Absent and undefined options both keep the fresh rule: a start is the
  // candidate and any resume (even of an id it asked for) withdraws.
  for (const binder of [createNativeCodexTuiRootFactsBinder(), createNativeCodexTuiRootFactsBinder({})]) {
    binder.attestEmptyBackend();
    binder.observe(initialize());
    binder.observe(startCandidate(A));
    assert.equal(binder.current().candidateThreadId, A);
  }
  const fresh = attested();
  fresh.observe(initialize());
  fresh.observe(resumeCandidate(B));
  assert.deepEqual(fresh.current(), withdrawnWith("thread-selection-advanced"));
});

test("an expected restored id alone selects nothing; the exact resume names B before any prompt with input none", () => {
  const binder = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  const seen: NativeCodexTuiRootFactsSnapshot[] = [];
  binder.watch((snapshot) => seen.push(snapshot));
  assert.deepEqual(binder.current(), { phase: "empty" });
  binder.attestEmptyBackend();
  binder.observe(initialize());
  assert.deepEqual(binder.current(), { phase: "connected", connectionId: C });

  binder.observe(resumeCandidate(B));
  assert.deepEqual(binder.current(), { phase: "candidate", connectionId: C, candidateThreadId: B, asyncInput: "none" });
  assert.equal("rootThreadId" in binder.current(), false, "a restored candidate is not yet a root");
  assert.deepEqual(seen.map((snapshot) => snapshot.phase), ["empty", "connected", "candidate"]);

  // The first own successful turn on the SAME B binds it exactly as fresh A.
  binder.observe(work(B, "turn-1"));
  assert.deepEqual(binder.current(), { phase: "bound", connectionId: C, rootThreadId: B, rootTurnId: "turn-1", asyncInput: "none" });

  // Without the empty witness, the candidate is not named and binding withdraws.
  const unattested = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  unattested.observe(initialize());
  unattested.observe(resumeCandidate(B));
  assert.deepEqual(unattested.current(), { phase: "candidate", connectionId: C });
  unattested.observe(work(B, "turn-1"));
  assert.deepEqual(unattested.current(), withdrawnWith("backend-attestation-unavailable"));

  // A late witness completes the proof and names the same candidate.
  const late = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  late.observe(initialize());
  late.observe(resumeCandidate(B));
  late.attestEmptyBackend();
  assert.equal(late.current().candidateThreadId, B);
  assert.equal(late.current().asyncInput, "none");
});

test("requested, response, and expected ids must all be B with a primary root shape", () => {
  const cases: readonly [string, NativeCodexTuiRelayMetadataEvent][] = [
    ["response names another thread", resumeCandidate("thread-other", { requested: B })],
    ["request asked for another thread", resumeCandidate(B, { requested: "thread-other" })],
    ["request and response agree on a non-expected thread", resumeCandidate("thread-other")],
    ["request id missing (never copied from the response)", resumeCandidate(B, { requested: null })],
    ["parented resume", resumeCandidate(B, { parentThreadId: "thread-parent" })],
    ["ephemeral resume", resumeCandidate(B, { ephemeral: true })],
  ];
  for (const [label, event] of cases) {
    const binder = restoring();
    binder.observe(event);
    assert.deepEqual(binder.current(), withdrawnWith("restored-thread-mismatch"), label);
    binder.observe(resumeCandidate(B));
    binder.observe(work(B, "turn-1"));
    assert.equal(binder.current().phase, "withdrawn", `${label}: withdrawal is sticky`);
    assert.equal(binder.current().candidateThreadId, undefined);
  }
});

test("restore mode never adopts a start or fork, and helpers stay ignored in both modes", () => {
  const startFirst = restoring();
  startFirst.observe(startCandidate(A));
  assert.deepEqual(startFirst.current(), withdrawnWith("thread-selection-advanced"));

  const startAfter = restored();
  startAfter.observe(startCandidate(A));
  assert.deepEqual(startAfter.current(), withdrawnWith("second-primary-thread-start"));

  const forkFirst = restoring();
  forkFirst.observe(resumeCandidate(B, { origin: "thread-fork" }));
  assert.deepEqual(forkFirst.current(), withdrawnWith("thread-selection-advanced"));

  const forkAfterBind = restored();
  forkAfterBind.observe(work(B, "turn-1"));
  forkAfterBind.observe(resumeCandidate("thread-forked", { origin: "thread-fork", requested: B, parentThreadId: B }));
  assert.deepEqual(forkAfterBind.current(), withdrawnWith("thread-selection-advanced"));

  // Helper traffic and child/ephemeral starts are ignored before and after.
  const helpers = restoring();
  helpers.observe(startCandidate("helper", { requestIdKind: "native-helper" }));
  helpers.observe(resumeCandidate("helper-r", { requestIdKind: "native-helper" }));
  helpers.observe(resumeCandidate("helper-f", { origin: "thread-fork", requestIdKind: "native-helper" }));
  helpers.observe(startCandidate("ephemeral", { ephemeral: true }));
  helpers.observe(startCandidate("child", { parentThreadId: "parent" }));
  assert.deepEqual(helpers.current(), { phase: "connected", connectionId: C });
  helpers.observe(resumeCandidate(B));
  helpers.observe(resumeCandidate(B, { requestIdKind: "native-helper" }));
  helpers.observe(startCandidate("helper-2", { requestIdKind: "native-helper" }));
  helpers.observe(work("helper-thread", "turn-h", "native-helper"));
  assert.equal(helpers.current().candidateThreadId, B);
  helpers.observe(work(B, "turn-1"));
  helpers.observe(resumeCandidate("helper-3", { requestIdKind: "native-helper" }));
  assert.equal(helpers.current().rootThreadId, B);
});

test("one candidate per restore: a second resume, other work, another connection, or loss withdraws", () => {
  // A native pagination retry projects one success (the relay drops the error
  // response), so exactly one candidate event names B; a second success is a
  // second selection.
  const again = restored();
  again.observe(resumeCandidate(B));
  assert.deepEqual(again.current(), withdrawnWith("thread-selection-advanced"));

  const child = restored();
  child.observe(work(B, "turn-1"));
  child.observe(resumeCandidate("thread-child", { parentThreadId: B }));
  assert.deepEqual(child.current(), withdrawnWith("thread-selection-advanced"));

  const other = restored();
  other.observe(work("thread-other", "turn-x"));
  assert.deepEqual(other.current(), withdrawnWith("work-on-another-thread"));

  const early = restoring();
  early.observe(work(B, "turn-1"));
  assert.deepEqual(early.current(), withdrawnWith("work-without-fresh-thread"));

  const second = restored();
  second.observe(initialize(C2));
  assert.deepEqual(second.current(), withdrawnWith("second-connection"));

  const lost = restored();
  lost.observe({ kind: "metadata-unavailable", connectionId: C, sequence: 9, scope: "message", reason: "json-unreadable" });
  assert.deepEqual(lost.current(), withdrawnWith("metadata-unavailable"));

  const closed = restored();
  closed.observe(work(B, "turn-1"));
  closed.observe({ kind: "generation-closed", connectionId: C, sequence: 9, reason: "client-closed" });
  assert.deepEqual(closed.current(), { ...withdrawnWith("generation-closed"), closeReason: "client-closed" });

  const stray = restored();
  stray.observe(questionsEvent(B, "call-q", 1, "turn-g", C2));
  assert.deepEqual(stray.current(), withdrawnWith("metadata-unavailable"));
});

test("live B questions after the candidate go pending; a live goal turn's terminal and a steer behave as for any current turn", () => {
  const binder = restored();
  assert.equal(binder.current().asyncInput, "none");

  // A restored active goal runs turn turn-g server-side with no own turn/start.
  binder.observe(questionsEvent(B, "call-g", 2, "turn-g"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(questionsEvent("helper-thread", "call-h", 1, "turn-h"));
  binder.observe(terminalEvent("helper-thread", "turn-h"));
  binder.observe(replyEvent("helper-thread", [{ itemId: "call-g" }]));
  assert.equal(binder.current().asyncInput, "pending", "helper and foreign traffic clear nothing");
  binder.observe(terminalEvent(B, "turn-g"));
  assert.equal(binder.current().asyncInput, "none", "with no own root turn yet, the goal turn's live terminal is the current boundary");
  binder.observe(questionsEvent(B, "call-g", 2, "turn-g"));
  binder.observe(questionsEvent(B, "call-g2", 1, "turn-g"));
  assert.equal(binder.current().asyncInput, "none", "the retired goal turn never resurrects");

  // A second goal turn asks; the user steers it with ordinary input.
  binder.observe(questionsEvent(B, "call-s", 1, "turn-s"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(ordinaryInput(B, "native-helper"));
  assert.equal(binder.current().asyncInput, "pending", "helper input clears nothing");
  binder.observe(ordinaryInput(B));
  assert.equal(binder.current().asyncInput, "unknown", "a steer makes held questions uncertain, not none");
  binder.observe(terminalEvent(B, "turn-s"));
  assert.equal(binder.current().asyncInput, "none");
  assert.equal(binder.current().phase, "candidate", "no own prompt was needed for any of this");

  // The first own prompt binds the same B; its question is pending proof.
  binder.observe(work(B, "turn-1"));
  assert.equal(binder.current().phase, "bound");
  binder.observe(questionsEvent(B, "call-1", 1, "turn-1"));
  assert.equal(binder.current().asyncInput, "pending");
  binder.observe(replyEvent(B, [{ itemId: "call-1", index: 0 }]));
  assert.equal(binder.current().asyncInput, "none");
});

test("pre-candidate live B evidence is held privately and carried into the candidate without duplicates", () => {
  // A held complete question publishes nothing before the proof, then pending.
  const held = restoring();
  held.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  assert.deepEqual(held.current(), { phase: "connected", connectionId: C });
  held.observe(resumeCandidate(B));
  assert.equal(held.current().asyncInput, "pending");
  held.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  held.observe(replyEvent(B, [{ itemId: "call-q", index: 0 }]));
  assert.equal(held.current().asyncInput, "none", "the observed committed reply resolves it, no duplicate needed");

  // An observed committed reply before the response already resolved it.
  const replied = restoring();
  replied.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  replied.observe(replyEvent(B, [{ itemId: "call-q", index: 0 }]));
  replied.observe(resumeCandidate(B));
  assert.equal(replied.current().asyncInput, "none");

  // A live terminal before the response retired it; replays never resurrect.
  const ended = restoring();
  ended.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  ended.observe(terminalEvent(B, "turn-g"));
  ended.observe(resumeCandidate(B));
  assert.equal(ended.current().asyncInput, "none");
  ended.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  ended.observe(questionsEvent(B, "call-late", 1, "turn-g"));
  assert.equal(ended.current().asyncInput, "none");

  // A held gap is unknown, and the turn's live terminal recovers it.
  const gap = restoring();
  gap.observe(unreadableEvent("questions", B, "turn-g"));
  gap.observe(resumeCandidate(B));
  assert.equal(gap.current().asyncInput, "unknown");
  gap.observe(terminalEvent(B, "turn-g"));
  assert.equal(gap.current().asyncInput, "none");

  // An unattributed question could be B's: unknown, never pending or none.
  const unattributed = restoring();
  unattributed.observe(questionsEvent(undefined, "call-x", 1));
  unattributed.observe(resumeCandidate(B));
  assert.equal(unattributed.current().asyncInput, "unknown");

  // A held ordinary steer makes the held question uncertain.
  const steered = restoring();
  steered.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  steered.observe(ordinaryInput(B));
  steered.observe(resumeCandidate(B));
  assert.equal(steered.current().asyncInput, "unknown");
  steered.observe(replyEvent(B, [{ itemId: "call-q", index: 0 }]));
  assert.equal(steered.current().asyncInput, "none");

  // Helper and foreign threads add nothing.
  const foreign = restoring();
  foreign.observe(questionsEvent("thread-other", "call-o", 1, "turn-o"));
  foreign.observe(unreadableEvent("questions", "thread-other", "turn-o"));
  foreign.observe(resumeCandidate(B));
  assert.equal(foreign.current().asyncInput, "none");

  // A failed proof publishes none of the held knowledge.
  const mismatched = restoring();
  mismatched.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  mismatched.observe(resumeCandidate("thread-other", { requested: B }));
  assert.deepEqual(mismatched.current(), withdrawnWith("restored-thread-mismatch"));
  const disconnected = restoring();
  disconnected.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  disconnected.observe(initialize(C2));
  assert.deepEqual(disconnected.current(), withdrawnWith("second-connection"));

  // The fresh binder is unchanged: nothing is attributed before its start.
  const fresh = attested();
  fresh.observe(initialize());
  fresh.observe(questionsEvent(A, "call-q", 1, "turn-g"));
  fresh.observe(startCandidate(A));
  assert.equal(fresh.current().asyncInput, "none");
});

test("B question evidence before the empty witness becomes a conservative gap, recovered only by a live terminal", () => {
  const binder = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  binder.observe(initialize());
  binder.observe(questionsEvent(B, "call-q", 1, "turn-g"));
  // A reply cannot be attributed to an item that was never retained.
  binder.observe(replyEvent(B, [{ itemId: "call-q", index: 0 }]));
  binder.attestEmptyBackend();
  binder.observe(resumeCandidate(B));
  assert.equal(binder.current().asyncInput, "unknown", "never invented pending, never a false none");
  binder.observe(terminalEvent(B, "turn-g"));
  assert.equal(binder.current().asyncInput, "none");

  // Unreadable B question metadata is the same gap; foreign and user-input
  // unreadability before the witness are not.
  const unreadable = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  unreadable.observe(initialize());
  unreadable.observe(unreadableEvent("questions", B, "turn-g"));
  unreadable.attestEmptyBackend();
  unreadable.observe(resumeCandidate(B));
  assert.equal(unreadable.current().asyncInput, "unknown");
  const unrelated = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
  unrelated.observe(initialize());
  unrelated.observe(questionsEvent("thread-other", "call-o", 1, "turn-o"));
  unrelated.observe(unreadableEvent("user-input", B, "turn-g"));
  unrelated.attestEmptyBackend();
  unrelated.observe(resumeCandidate(B));
  assert.equal(unrelated.current().asyncInput, "none");
});

test("restore binding keeps early provisional terminal reconciliation immediate", () => {
  const binder = restored();
  binder.observe(work(B, "turn-1"));
  binder.observe(terminalEvent(B, "turn-1"));
  binder.observe(questionsEvent(B, "call-q2", 1, "turn-2"));
  assert.equal(binder.current().asyncInput, "unknown", "another turn's question is provisional");
  binder.observe(terminalEvent(B, "turn-2"));
  binder.observe(work(B, "turn-2"));
  assert.equal(binder.current().rootTurnId, "turn-2");
  assert.equal(binder.current().asyncInput, "none", "the held terminal is the boundary at confirmation");
  binder.observe(questionsEvent(B, "call-q2", 1, "turn-2"));
  assert.equal(binder.current().asyncInput, "none");
});

/* ======================================== closed generation evidence lifetime */

test("a generation close carries its closed reason only until any later event, and status stays withdrawn", () => {
  const delivered: NativeCodexTuiRootFactsSnapshot[] = [];
  const binder = boundBinder();
  binder.watch((snapshot) => delivered.push(snapshot));
  binder.observe({ kind: "generation-closed", connectionId: C, sequence: 9, reason: "client-closed" });
  assert.deepEqual(binder.current(), { phase: "withdrawn", connectionId: C, withdrawal: "generation-closed", closeReason: "client-closed" });

  // A later connection drops the evidence; it never rebinds a root or status.
  binder.observe(initialize(C2));
  assert.deepEqual(binder.current(), { phase: "withdrawn", connectionId: C, withdrawal: "generation-closed" });
  assert.equal(delivered.length, 3, "current, the close, and exactly one evidence drop");
  binder.observe(startCandidate(A, { connectionId: C2 }));
  binder.observe(item(A, "command", "started", { connectionId: C2 }));
  assert.deepEqual(binder.current(), { phase: "withdrawn", connectionId: C, withdrawal: "generation-closed" });
  assert.equal(delivered.length, 3, "nothing further is published");

  // Any later event at all — even on the closed connection — also drops it.
  const stray = boundBinder();
  stray.observe({ kind: "generation-closed", connectionId: C, sequence: 9, reason: "client-closed" });
  stray.observe(item(A, "command", "started"));
  assert.equal(stray.current().closeReason, undefined);
  assert.equal(stray.current().withdrawal, "generation-closed");

  // Other withdrawals, and a close after another withdrawal, carry no reason.
  const lost = boundBinder();
  lost.observe({ kind: "metadata-unavailable", connectionId: C, sequence: 5, scope: "message", reason: "json-unreadable" });
  lost.observe({ kind: "generation-closed", connectionId: C, sequence: 6, reason: "client-closed" });
  assert.deepEqual(lost.current(), { phase: "withdrawn", connectionId: C, withdrawal: "metadata-unavailable" });
  const external = boundBinder();
  external.withdraw("generation-closed");
  assert.equal(external.current().closeReason, undefined, "only the relay's own close carries evidence");

  // A reason outside the relay's closed vocabulary is never recorded.
  const odd = boundBinder();
  odd.observe({ kind: "generation-closed", connectionId: C, sequence: 9, reason: "user-quit" as never });
  assert.deepEqual(odd.current(), { phase: "withdrawn", connectionId: C, withdrawal: "generation-closed" });
});

/* ================================================= callback root facts (#682) */

/**
 * Callback fixtures carry realistic relay order: every event takes the next
 * strictly increasing sequence, and an own work target names the sequence
 * position of its REQUEST frame (`requestAfterSequence`), defaulting to "the
 * request was just observed".
 */
let relaySequence = 1_000;
const nextSequence = (): number => (relaySequence += 1);
/** The position a request frame observed right now would carry. */
const requestNow = (): number => relaySequence;

function turnStarted(threadId: string, turnId: string, connectionId = C): NativeCodexTuiRelayMetadataEvent {
  return { kind: "turn-started", connectionId, sequence: nextSequence(), threadId, turnId };
}

function turnEnded(
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" | "failed" = "completed",
): NativeCodexTuiRelayMetadataEvent {
  return { kind: "turn-terminal", connectionId: C, sequence: nextSequence(), threadId, turnId, status };
}

function stopRequest(
  threadId: string | undefined,
  turnId: string | undefined,
  requestIdKind: "native" | "native-helper" = "native",
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "turn-interrupt-request",
    connectionId: C,
    sequence: nextSequence(),
    requestIdKind,
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function lifecycleGap(method: "turn/started" | "turn/completed", threadId?: string): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "turn-lifecycle-unreadable",
    connectionId: C,
    sequence: nextSequence(),
    method,
    ...(threadId === undefined ? {} : { threadId }),
  };
}

/** This connection's own successful `turn/start`, whose request was observed at `requestedAfter`. */
function ownWork(
  threadId: string,
  turnId: string,
  requestedAfter: number | null = requestNow(),
  requestIdKind: "native" | "native-helper" = "native",
): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "turn-work-target",
    connectionId: C,
    sequence: nextSequence(),
    requestIdKind,
    threadId,
    turnId,
    ...(requestedAfter === null ? {} : { requestAfterSequence: requestedAfter }),
  };
}

/** A bound fresh root A whose first own turn is `turn-1`. */
function cbBound(): NativeCodexTuiRootFactsBinder {
  const binder = attested();
  binder.observe(initialize());
  binder.observe(startCandidate(A));
  binder.observe(ownWork(A, "turn-1"));
  return binder;
}

const busy = (turnId: string) => ({ state: "busy", turnId });
const idle = (lastTurnId: string | null) => ({ state: "idle", lastTurnId });
const UNKNOWN = { state: "unknown" };

function factsOf(binder: NativeCodexTuiRootFactsBinder): unknown {
  return binder.callbackFacts();
}

function stopOf(binder: NativeCodexTuiRootFactsBinder): string | undefined {
  return binder.callbackFacts()?.userStop;
}

test("callback facts exist only for the bound root and name its thread and connection generation", () => {
  const binder = createNativeCodexTuiRootFactsBinder();
  assert.equal(binder.callbackFacts(), null, "empty");
  binder.attestEmptyBackend();
  binder.observe(initialize());
  assert.equal(binder.callbackFacts(), null, "connected");
  binder.observe(startCandidate(A));
  // A candidate is not a root: even a live start on it publishes nothing yet.
  binder.observe(turnStarted(A, "turn-1"));
  assert.equal(binder.current().phase, "candidate");
  assert.equal(binder.callbackFacts(), null, "candidate");

  binder.observe(ownWork(A, "turn-1"));
  const facts = binder.callbackFacts();
  assert.deepEqual(facts, { threadId: A, runId: C, activity: busy("turn-1"), userStop: "none" });
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts?.activity), "an immutable read");

  // The exact restored root is the same shape.
  const restore = restored();
  restore.observe(ownWork(B, "turn-r"));
  assert.deepEqual(restore.callbackFacts(), { threadId: B, runId: C, activity: busy("turn-r"), userStop: "none" });
});

test("normal completion is known idle; lifecycle facts never change the snapshot or wake the watcher", () => {
  const binder = cbBound();
  binder.observe(item(A, "command", "started", { turnId: "turn-1" }));
  const delivered: NativeCodexTuiRootFactsSnapshot[] = [];
  binder.watch((snapshot) => delivered.push(snapshot));
  const before = binder.current();

  binder.observe(turnStarted(A, "turn-1"));
  binder.observe(stopRequest(A, "turn-1"));
  binder.observe(lifecycleGap("turn/started", A));
  binder.observe(lifecycleGap("turn/completed", A));
  binder.observe(turnStarted(A, "turn-1"));
  assert.equal(binder.current(), before, "the published snapshot object is unchanged");
  assert.equal(delivered.length, 1, "only the attach delivery");

  const clean = cbBound();
  clean.observe(turnStarted(A, "turn-1"));
  clean.observe(turnEnded(A, "turn-1", "completed"));
  assert.deepEqual(factsOf(clean), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "none" });
  // The existing snapshot keeps its exact current-turn telemetry.
  assert.equal(clean.current().rootTurnId, "turn-1");
  assert.equal(clean.current().asyncInput, "none");
});

test("sibling, helper, and child lifecycle traffic never changes the exact root's callback facts", () => {
  const binder = cbBound();
  const expected = { threadId: A, runId: C, activity: busy("turn-1"), userStop: "none" };
  binder.observe(turnStarted("thread-child", "child-turn"));
  binder.observe(turnEnded("thread-child", "child-turn", "interrupted"));
  binder.observe(turnEnded("thread-child", "child-turn-2", "failed"));
  binder.observe(stopRequest("thread-child", "child-turn"));
  binder.observe(stopRequest("thread-helper", "helper-turn", "native-helper"));
  binder.observe(stopRequest("thread-helper", undefined, "native-helper"));
  binder.observe(lifecycleGap("turn/started", "thread-child"));
  binder.observe(lifecycleGap("turn/completed", "thread-child"));
  // A helper's own turn/start never counts as the root's own work.
  binder.observe(ownWork(A, "helper-on-root", requestNow(), "native-helper"));
  assert.deepEqual(factsOf(binder), expected);
  binder.observe(turnEnded(A, "turn-1"));
  assert.deepEqual(factsOf(binder), { ...expected, activity: idle("turn-1") });
});

test("an own stop request fences immediately, its terminal keeps it stopped, and only a later own request clears it", () => {
  const binder = cbBound();
  binder.observe(turnStarted(A, "turn-1"));
  binder.observe(stopRequest(A, "turn-1"));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: busy("turn-1"), userStop: "stopped" },
    "stopped at the request, before any acknowledgement or terminal");
  binder.observe(turnEnded(A, "turn-1", "interrupted"));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "stopped" });

  // A turn started by anyone else (for example a host queue start) is not the
  // user's own work and never clears the stop.
  binder.observe(turnStarted(A, "turn-queued"));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: busy("turn-queued"), userStop: "stopped" });
  binder.observe(turnEnded(A, "turn-queued", "completed"));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: idle("turn-queued"), userStop: "stopped" });

  // The user's next own prompt, requested after the stop, is new own work.
  const request = requestNow();
  binder.observe(turnStarted(A, "turn-2"));
  assert.equal(stopOf(binder), "stopped", "a live start alone clears nothing");
  binder.observe(ownWork(A, "turn-2", request));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: busy("turn-2"), userStop: "none" });

  // A stop naming an older or stale turn of the root still stops.
  binder.observe(stopRequest(A, "turn-1"));
  assert.equal(stopOf(binder), "stopped");
  // An interrupted terminal alone (stop requested elsewhere) also stops.
  const external = cbBound();
  external.observe(turnEnded(A, "turn-1", "interrupted"));
  assert.deepEqual(factsOf(external), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "stopped" });
});

test("a delayed start reply never clears a stop observed after its request; a genuinely later request does", () => {
  // The reviewer's ordering: B's live start, then a root stop naming the OLDER
  // turn A, then B's own start reply for a request sent before that stop.
  const stale = cbBound();
  const requestB = requestNow();
  stale.observe(turnStarted(A, "turn-2"));
  stale.observe(stopRequest(A, "turn-1"));
  stale.observe(ownWork(A, "turn-2", requestB));
  assert.deepEqual(factsOf(stale), { threadId: A, runId: C, activity: busy("turn-2"), userStop: "stopped" });
  // A genuinely new own request after the stop clears it.
  stale.observe(ownWork(A, "turn-3"));
  assert.deepEqual(factsOf(stale), { threadId: A, runId: C, activity: busy("turn-3"), userStop: "none" });
  // A later-arriving reply for an even older request never rewinds the position.
  stale.observe(stopRequest(A, "turn-3"));
  stale.observe(ownWork(A, "turn-old", requestB));
  assert.equal(stopOf(stale), "stopped");

  // A stop for the very turn being confirmed survives its own confirmation.
  const same = cbBound();
  same.observe(turnEnded(A, "turn-1"));
  const request2 = requestNow();
  same.observe(turnStarted(A, "turn-2"));
  same.observe(stopRequest(A, "turn-2"));
  same.observe(ownWork(A, "turn-2", request2));
  assert.deepEqual(factsOf(same), { threadId: A, runId: C, activity: busy("turn-2"), userStop: "stopped" });

  // A terminal that precedes its own confirmation leaves the turn ended.
  const early = cbBound();
  const requestEarly = requestNow();
  early.observe(turnStarted(A, "turn-2"));
  early.observe(turnEnded(A, "turn-2", "interrupted"));
  early.observe(ownWork(A, "turn-2", requestEarly));
  assert.deepEqual(factsOf(early), { threadId: A, runId: C, activity: idle("turn-2"), userStop: "stopped" });

  // Pre-bind stop evidence after the first turn's request is kept through binding.
  const first = attested();
  first.observe(initialize());
  first.observe(startCandidate(A));
  const requestFirst = requestNow();
  first.observe(turnStarted(A, "turn-1"));
  first.observe(stopRequest(A, "turn-1"));
  first.observe(ownWork(A, "turn-1", requestFirst));
  assert.deepEqual(factsOf(first), { threadId: A, runId: C, activity: busy("turn-1"), userStop: "stopped" });

  // A work target without request-order evidence proves no order: it clears nothing.
  const unordered = cbBound();
  unordered.observe(stopRequest(A, "turn-1"));
  unordered.observe(ownWork(A, "turn-2", null));
  assert.equal(stopOf(unordered), "stopped");
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    unordered.observe(ownWork(A, `turn-bad-${String(bad)}`, bad));
    assert.equal(stopOf(unordered), "stopped", `request position ${String(bad)} is not evidence`);
  }
  // An unorderable stop sequence can never be cleared.
  const unorderable = cbBound();
  unorderable.observe({ kind: "turn-interrupt-request", connectionId: C, sequence: Number.NaN, requestIdKind: "native", threadId: A, turnId: "turn-1" });
  unorderable.observe(ownWork(A, "turn-2"));
  assert.equal(stopOf(unorderable), "stopped");
});

test("a delayed reply cannot assert current activity across a newer lifecycle observation", () => {
  for (const intervene of ["live-start", "unreadable-start", "terminal"] as const) {
    const binder = cbBound();
    const request = requestNow();
    if (intervene === "live-start") binder.observe(turnStarted(A, "turn-new"));
    else if (intervene === "unreadable-start") binder.observe(lifecycleGap("turn/started", A));
    else binder.observe(turnEnded(A, "turn-1"));
    binder.observe(ownWork(A, "turn-delayed", request));
    assert.deepEqual(binder.callbackFacts()?.activity, UNKNOWN, `${intervene}: no stale steer target or stale idle`);
    // An exact live start restores activity.
    binder.observe(turnStarted(A, "turn-current"));
    assert.deepEqual(binder.callbackFacts()?.activity, busy("turn-current"), intervene);
    // So does a genuinely later own request.
    binder.observe(turnEnded(A, "turn-current"));
    binder.observe(ownWork(A, "turn-later"));
    assert.deepEqual(binder.callbackFacts()?.activity, busy("turn-later"), intervene);
  }

  // A reply naming the turn already live-busy keeps it, whatever its order.
  const matching = cbBound();
  const request = requestNow();
  matching.observe(turnStarted(A, "turn-2"));
  matching.observe(ownWork(A, "turn-2", request));
  assert.deepEqual(matching.callbackFacts()?.activity, busy("turn-2"));

  // A reply for a request no newer than the latest own request, or with no
  // usable order, proves nothing about the current turn.
  const older = cbBound();
  const olderRequest = requestNow();
  older.observe(ownWork(A, "turn-2"));
  older.observe(ownWork(A, "turn-older", olderRequest));
  assert.deepEqual(older.callbackFacts()?.activity, UNKNOWN);
  const unordered = cbBound();
  unordered.observe(ownWork(A, "turn-2", null));
  assert.deepEqual(unordered.callbackFacts()?.activity, UNKNOWN);
  const future = cbBound();
  future.observe({ kind: "turn-work-target", connectionId: C, sequence: 5_000_000, requestIdKind: "native", threadId: A, turnId: "turn-2", requestAfterSequence: 5_000_000 });
  assert.deepEqual(future.callbackFacts()?.activity, UNKNOWN, "a request cannot be positioned at or after its own reply");
});

test("many later stop targets cannot evict the stop a delayed reply still needs", () => {
  const binder = cbBound();
  const requestB = requestNow();
  binder.observe(turnStarted(A, "turn-b"));
  binder.observe(stopRequest(A, "turn-b"));
  // Interrupt requests count even when the backend rejects them.
  for (let index = 0; index < 40; index += 1) binder.observe(stopRequest(A, `turn-x-${index}`));
  binder.observe(ownWork(A, "turn-b", requestB));
  assert.equal(stopOf(binder), "stopped");

  // Pre-root per-thread overflow folds the evicted evidence into the root's,
  // so the root's own pre-candidate stop is never lost to sibling volume.
  const fresh = attested();
  fresh.observe(initialize());
  const beforeAll = requestNow();
  fresh.observe(stopRequest(A, "turn-a"));
  for (let index = 0; index < 40; index += 1) fresh.observe(stopRequest(`thread-sibling-${index}`, `turn-s-${index}`));
  fresh.observe(startCandidate(A));
  fresh.observe(ownWork(A, "turn-1", beforeAll));
  assert.equal(stopOf(fresh), "stopped", "overflow loses scoping, never a stop");
  fresh.observe(ownWork(A, "turn-2"));
  assert.equal(stopOf(fresh), "none");
});

test("a pre-candidate sibling terminal cannot mask a root stop with the same turn id", () => {
  const binder = attested();
  binder.observe(initialize());
  binder.observe(turnEnded("thread-sibling", "shared-turn", "interrupted"));
  binder.observe(startCandidate(A));
  const request = requestNow();
  binder.observe(turnStarted(A, "shared-turn"));
  binder.observe(turnEnded(A, "shared-turn", "interrupted"));
  binder.observe(ownWork(A, "shared-turn", request));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: idle("shared-turn"), userStop: "stopped" });
  // A later externally started root turn does not hide that stop.
  binder.observe(turnStarted(A, "turn-external"));
  assert.deepEqual(factsOf(binder), { threadId: A, runId: C, activity: busy("turn-external"), userStop: "stopped" });

  // Bound root: a sibling's terminal with the root's turn id neither ends the
  // root turn nor deduplicates the root's own terminal.
  const bound = cbBound();
  bound.observe(turnEnded("thread-sibling", "turn-1", "completed"));
  assert.deepEqual(bound.callbackFacts()?.activity, busy("turn-1"));
  bound.observe(turnEnded(A, "turn-1", "completed"));
  assert.deepEqual(factsOf(bound), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "none" });
});

test("pre-candidate sibling evidence never blocks the root, while the root's own pre-candidate evidence is kept", () => {
  // Fresh mode: before the candidate is known, readable sibling evidence is
  // held per thread and dropped once the root thread is known.
  const fresh = attested();
  fresh.observe(initialize());
  const earlyRequest = requestNow();
  fresh.observe(lifecycleGap("turn/completed", "thread-sibling"));
  fresh.observe(stopRequest("thread-sibling", "turn-s"));
  fresh.observe(turnEnded("thread-sibling", "turn-s2", "interrupted"));
  fresh.observe(turnEnded("thread-sibling", "turn-s3", "failed"));
  fresh.observe(startCandidate(A));
  fresh.observe(ownWork(A, "turn-1", earlyRequest));
  fresh.observe(turnEnded(A, "turn-1"));
  assert.deepEqual(factsOf(fresh), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "none" });

  // The matching root's own pre-candidate evidence is kept.
  const matching = attested();
  matching.observe(initialize());
  const matchingRequest = requestNow();
  matching.observe(stopRequest(A, "turn-0"));
  matching.observe(startCandidate(A));
  matching.observe(ownWork(A, "turn-1", matchingRequest));
  assert.equal(stopOf(matching), "stopped");

  // Unattributable pre-candidate evidence may be the root's.
  const unattributed = attested();
  unattributed.observe(initialize());
  const unattributedRequest = requestNow();
  unattributed.observe(lifecycleGap("turn/completed"));
  unattributed.observe(startCandidate(A));
  unattributed.observe(ownWork(A, "turn-1", unattributedRequest));
  assert.equal(stopOf(unattributed), "unknown");

  // Restore mode before the empty witness: B is not yet attributable, so
  // evidence is held per thread; only B's survives the candidate response.
  const restoreFor = (threadId: string): NativeCodexTuiRootFactsBinder => {
    const binder = createNativeCodexTuiRootFactsBinder({ resumeConversationId: B });
    binder.observe(initialize());
    const request = requestNow();
    binder.observe(lifecycleGap("turn/completed", threadId));
    binder.attestEmptyBackend();
    binder.observe(resumeCandidate(B, { ephemeral: false }));
    binder.observe(ownWork(B, "turn-r", request));
    return binder;
  };
  assert.equal(stopOf(restoreFor("thread-sibling")), "none", "a sibling's gap never blocks B");
  assert.equal(stopOf(restoreFor(B)), "unknown", "B's own gap is kept");

  // Restore mode after the witness but before the candidate response: the
  // expected B scopes evidence exactly, and B's live start is tracked.
  const attestedRestore = restoring();
  const restoreRequest = requestNow();
  attestedRestore.observe(lifecycleGap("turn/completed", "thread-sibling"));
  attestedRestore.observe(stopRequest("thread-sibling", "turn-s"));
  attestedRestore.observe(turnStarted(B, "turn-goal"));
  attestedRestore.observe(resumeCandidate(B, { ephemeral: false }));
  attestedRestore.observe(turnEnded(B, "turn-goal"));
  attestedRestore.observe(turnStarted(B, "turn-r"));
  attestedRestore.observe(ownWork(B, "turn-r", restoreRequest));
  assert.deepEqual(factsOf(attestedRestore), { threadId: B, runId: C, activity: busy("turn-r"), userStop: "none" });
  const stoppedRestore = restoring();
  const stoppedRequest = requestNow();
  stoppedRestore.observe(stopRequest(B, "turn-goal"));
  stoppedRestore.observe(resumeCandidate(B, { ephemeral: false }));
  stoppedRestore.observe(ownWork(B, "turn-r", stoppedRequest));
  assert.equal(stopOf(stoppedRestore), "stopped");
});

test("failure, unscoped, and unreadable evidence are unknown until a later own request, never none", () => {
  const failed = cbBound();
  failed.observe(turnEnded(A, "turn-1", "failed"));
  assert.deepEqual(factsOf(failed), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "unknown" });
  failed.observe(ownWork(A, "turn-2"));
  assert.equal(stopOf(failed), "none", "a later own request is new own work");

  // A stop request with no readable thread may be the root's.
  const unscoped = cbBound();
  unscoped.observe(stopRequest(undefined, "turn-1"));
  assert.equal(stopOf(unscoped), "unknown");
  unscoped.observe(ownWork(A, "turn-2"));
  assert.equal(stopOf(unscoped), "none");

  // A root stop naming no readable turn is still a stop, ordered like any other.
  const noTurn = cbBound();
  const beforeStop = requestNow();
  noTurn.observe(stopRequest(A, undefined));
  assert.equal(stopOf(noTurn), "stopped");
  noTurn.observe(ownWork(A, "turn-2", beforeStop));
  assert.equal(stopOf(noTurn), "stopped", "a reply for a pre-stop request clears nothing");
  noTurn.observe(ownWork(A, "turn-3"));
  assert.equal(stopOf(noTurn), "none");

  // An unreadable completion may have hidden a stop.
  for (const threadId of [A, undefined]) {
    const hidden = cbBound();
    const request = requestNow();
    hidden.observe(lifecycleGap("turn/completed", threadId));
    assert.deepEqual(factsOf(hidden), { threadId: A, runId: C, activity: UNKNOWN, userStop: "unknown" });
    hidden.observe(turnStarted(A, "turn-2"));
    hidden.observe(ownWork(A, "turn-2", request));
    assert.deepEqual(factsOf(hidden), { threadId: A, runId: C, activity: busy("turn-2"), userStop: "unknown" });
    hidden.observe(ownWork(A, "turn-3"));
    assert.equal(stopOf(hidden), "none");
  }

  // An unreadable start only loses activity until the next positive start.
  const gap = cbBound();
  gap.observe(turnEnded(A, "turn-1"));
  gap.observe(lifecycleGap("turn/started"));
  assert.deepEqual(factsOf(gap), { threadId: A, runId: C, activity: UNKNOWN, userStop: "none" });
  gap.observe(turnEnded(A, "turn-x"));
  assert.deepEqual(gap.callbackFacts()?.activity, UNKNOWN, "an untracked end never proves idle");
  gap.observe(turnStarted(A, "turn-2"));
  assert.deepEqual(gap.callbackFacts()?.activity, busy("turn-2"));
});

test("exact terminal replays are idempotent, but conflicting terminals are stop evidence", () => {
  const replay = cbBound();
  replay.observe(turnEnded(A, "turn-1", "completed"));
  replay.observe(turnEnded(A, "turn-1", "completed"));
  replay.observe(turnStarted(A, "turn-1"));
  assert.deepEqual(factsOf(replay), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "none" },
    "an identical replay and a late start change nothing");

  const conflict = cbBound();
  conflict.observe(turnEnded(A, "turn-1", "completed"));
  conflict.observe(turnEnded(A, "turn-1", "interrupted"));
  assert.deepEqual(factsOf(conflict), { threadId: A, runId: C, activity: idle("turn-1"), userStop: "stopped" });

  const failedAfter = cbBound();
  failedAfter.observe(turnEnded(A, "turn-1", "completed"));
  failedAfter.observe(turnEnded(A, "turn-1", "failed"));
  assert.equal(stopOf(failedAfter), "unknown");

  const completedAfter = cbBound();
  completedAfter.observe(turnEnded(A, "turn-1", "interrupted"));
  completedAfter.observe(turnEnded(A, "turn-1", "completed"));
  assert.equal(stopOf(completedAfter), "stopped", "a later completion never withdraws a stop");
  // An identical replay after a later own request is idempotent, not a new stop.
  completedAfter.observe(ownWork(A, "turn-2"));
  completedAfter.observe(turnEnded(A, "turn-1", "completed"));
  assert.equal(stopOf(completedAfter), "none");
});

test("untracked and late lifecycle evidence never fabricates idle or revives an ended turn", () => {
  const binder = cbBound();
  binder.observe(turnEnded(A, "turn-1"));
  assert.deepEqual(binder.callbackFacts()?.activity, idle("turn-1"));
  // A root turn this source never saw active ended while idle: activity was missed.
  binder.observe(turnEnded(A, "turn-unseen"));
  assert.deepEqual(binder.callbackFacts()?.activity, UNKNOWN);
  // An ended turn's late own confirmation never makes it busy again.
  binder.observe(ownWork(A, "turn-unseen"));
  assert.deepEqual(binder.callbackFacts()?.activity, UNKNOWN);

  // While busy, another turn's terminal does not end the busy turn.
  const busyRoot = cbBound();
  busyRoot.observe(turnEnded(A, "turn-old"));
  assert.deepEqual(busyRoot.callbackFacts()?.activity, busy("turn-1"));
  // A later live start replaces a busy turn whose end was not seen.
  busyRoot.observe(turnStarted(A, "turn-2"));
  assert.deepEqual(busyRoot.callbackFacts()?.activity, busy("turn-2"));
  busyRoot.observe(turnEnded(A, "turn-1"));
  assert.deepEqual(busyRoot.callbackFacts()?.activity, busy("turn-2"));
  busyRoot.observe(turnEnded(A, "turn-2"));
  assert.deepEqual(busyRoot.callbackFacts()?.activity, idle("turn-2"));
});

test("a withdrawn generation never yields callback facts again", () => {
  const withdrawals: Array<[string, (binder: NativeCodexTuiRootFactsBinder) => void]> = [
    ["generation closed", (binder) => binder.observe({ kind: "generation-closed", connectionId: C, sequence: nextSequence(), reason: "client-closed" })],
    ["metadata loss", (binder) => binder.observe({ kind: "metadata-unavailable", connectionId: C, sequence: nextSequence(), scope: "message", reason: "json-unreadable" })],
    ["second connection", (binder) => binder.observe(initialize(C2))],
    ["another connection's event", (binder) => binder.observe(turnStarted(A, "turn-2", C2))],
    ["work on another thread", (binder) => binder.observe(ownWork("thread-b", "turn-b"))],
    ["owner withdrawal", (binder) => binder.withdraw("metadata-unavailable")],
  ];
  for (const [label, withdraw] of withdrawals) {
    const binder = cbBound();
    binder.observe(turnEnded(A, "turn-1"));
    assert.notEqual(binder.callbackFacts(), null, label);
    withdraw(binder);
    assert.equal(binder.current().phase, "withdrawn", label);
    assert.equal(binder.callbackFacts(), null, `${label}: withdrawn`);
    // Nothing afterwards revives it: not a new connection, start, or own work.
    binder.observe(initialize(C2));
    binder.observe(startCandidate(A, { connectionId: C2 }));
    binder.observe({ kind: "turn-work-target", connectionId: C2, sequence: nextSequence(), requestIdKind: "native", threadId: A, turnId: "turn-9", requestAfterSequence: requestNow() });
    binder.observe(turnStarted(A, "turn-9"));
    binder.observe(ownWork(A, "turn-9"));
    assert.equal(binder.callbackFacts(), null, `${label}: never revived`);
  }
});

test("callback facts plug into the composer's fail-closed facts reader without touching a lane", async () => {
  const { createNativeCodexCallbackComposer, NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP } = await import(
    "../src/session-host/native-codex-callback-composition"
  );
  let laneCalls = 0;
  const composerFor = (binder: NativeCodexTuiRootFactsBinder, runId: string) => createNativeCodexCallbackComposer({
    owned: { threadId: A, runId },
    readFacts: () => binder.callbackFacts(),
    steerLane: {} as never,
    queueLane: {
      ownership: NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP,
      request: async () => {
        laneCalls += 1;
        return { kind: "not-sent" as const };
      },
    },
  });
  const request = { clientUserMessageId: "callback-1", text: "synthetic callback" };
  const binder = cbBound();
  binder.observe(turnStarted(A, "turn-1"));
  binder.observe(stopRequest(A, "turn-1"));
  assert.deepEqual(await composerFor(binder, C).deliver(request), { route: "declined", reason: "user-stopped", delivery: "not-delivered" });
  assert.deepEqual(await composerFor(binder, "another-run").deliver(request), { route: "declined", reason: "facts-stale", delivery: "not-delivered" });
  const gap = cbBound();
  gap.observe(lifecycleGap("turn/started"));
  assert.deepEqual(await composerFor(gap, C).deliver(request), { route: "declined", reason: "facts-unknown", delivery: "not-delivered" });
  binder.withdraw("generation-closed");
  assert.deepEqual(await composerFor(binder, C).deliver(request), { route: "declined", reason: "facts-unknown", delivery: "not-delivered" });
  assert.equal(laneCalls, 0, "no queue request was made");
});

/* ---------------------------------------------- #682 backend version proof */

function backendInitialize(backendVersion: string | undefined, connectionId = C): NativeCodexTuiRelayMetadataEvent {
  return {
    kind: "backend-initialize",
    connectionId,
    sequence: 2,
    ...(backendVersion === undefined ? {} : { backendVersion }),
  };
}

test("backend version proof exists only for the bound root of the generation whose own initialize was answered", () => {
  const binder = createNativeCodexTuiRootFactsBinder();
  const delivered: NativeCodexTuiRootFactsSnapshot[] = [];
  binder.watch((snapshot) => delivered.push(snapshot));
  binder.attestEmptyBackend();
  binder.observe(initialize());
  const connected = binder.current();
  const deliveredBefore = delivered.length;
  binder.observe(backendInitialize("0.171.0"));
  assert.equal(binder.current(), connected, "the handshake changes no published fact");
  assert.equal(delivered.length, deliveredBefore, "and wakes no watcher");
  assert.equal(binder.callbackBackendVersion(), null, "connected, not bound: no proof");
  binder.observe(startCandidate(A));
  assert.equal(binder.callbackBackendVersion(), null, "a candidate is not a root");
  binder.observe(work(A, "turn-1"));
  const proof = binder.callbackBackendVersion();
  assert.deepEqual(proof, { version: "0.171.0", runId: C, threadId: A });
  assert.ok(Object.isFrozen(proof));

  // A displaced generation (second connection) withdraws: the proof is gone for good.
  binder.observe(initialize(C2));
  assert.equal(binder.callbackFacts(), null);
  assert.equal(binder.callbackBackendVersion(), null);
  binder.observe(backendInitialize("0.171.0", C2));
  assert.equal(binder.callbackBackendVersion(), null, "never revived");
});

test("an error, malformed, foreign-generation, or duplicate backend handshake proves no version", () => {
  const missing = boundBinder();
  assert.equal(missing.callbackBackendVersion(), null, "no handshake observed");

  const errored = attested();
  errored.observe(initialize());
  errored.observe(backendInitialize(undefined));
  errored.observe(startCandidate(A));
  errored.observe(work(A, "turn-1"));
  assert.notEqual(errored.callbackFacts(), null);
  assert.equal(errored.callbackBackendVersion(), null);

  for (const malformed of ["0.171", "0.171.0-alpha", "v0.171.0", "", "0.171.0 "]) {
    const binder = attested();
    binder.observe(initialize());
    binder.observe(backendInitialize(malformed));
    binder.observe(startCandidate(A));
    binder.observe(work(A, "turn-1"));
    assert.equal(binder.callbackBackendVersion(), null, JSON.stringify(malformed));
  }

  // The binder never decides support: an unsupported stable triple is carried for the owner to refuse.
  const other = attested();
  other.observe(initialize());
  other.observe(backendInitialize("0.170.0"));
  other.observe(startCandidate(A));
  other.observe(work(A, "turn-1"));
  assert.equal(other.callbackBackendVersion()?.version, "0.170.0");

  const duplicate = boundBinder();
  duplicate.observe(backendInitialize("0.171.0"));
  assert.equal(duplicate.callbackBackendVersion()?.version, "0.171.0");
  duplicate.observe(backendInitialize("0.171.0"));
  assert.equal(duplicate.callbackBackendVersion(), null, "a second handshake answer clears the proof permanently");
  duplicate.observe(backendInitialize("0.171.0"));
  assert.equal(duplicate.callbackBackendVersion(), null);
  assert.notEqual(duplicate.callbackFacts(), null, "callback facts themselves are unaffected");

  const foreign = boundBinder();
  foreign.observe(backendInitialize("0.171.0", C2));
  assert.equal(foreign.current().phase, "withdrawn", "a foreign generation's projection withdraws, as every other one");
  assert.equal(foreign.callbackBackendVersion(), null);

  const closed = boundBinder();
  closed.observe(backendInitialize("0.171.0"));
  closed.observe({ kind: "generation-closed", connectionId: C, sequence: 9, reason: "client-closed" });
  assert.equal(closed.callbackBackendVersion(), null, "a closed generation proves nothing");
});

test("the root-free discovery version exists from the genuine generation's own answered initialize, before any root, and only for that generation", () => {
  const binder = createNativeCodexTuiRootFactsBinder();
  assert.equal(binder.discoveryBackendVersion(), null, "nothing connected");
  binder.attestEmptyBackend();
  binder.observe(initialize());
  assert.equal(binder.discoveryBackendVersion(), null, "initialize not yet answered");
  binder.observe(backendInitialize("0.171.0"));
  const early = binder.discoveryBackendVersion();
  assert.deepEqual(early, { version: "0.171.0", runId: C }, "no root needed");
  assert.ok(Object.isFrozen(early));
  assert.equal(binder.callbackFacts(), null, "no root yet");
  assert.equal(binder.callbackBackendVersion(), null, "the call/delivery proof still needs the bound root");
  binder.observe(startCandidate(A));
  assert.deepEqual(binder.discoveryBackendVersion(), { version: "0.171.0", runId: C });
  assert.equal(binder.callbackBackendVersion(), null, "a candidate is still not a root");
  binder.observe(work(A, "turn-1"));
  assert.deepEqual(binder.discoveryBackendVersion(), { version: "0.171.0", runId: C });
  assert.deepEqual(binder.callbackBackendVersion(), { version: "0.171.0", runId: C, threadId: A });

  // A second connection withdraws: neither read survives or revives.
  binder.observe(initialize(C2));
  assert.equal(binder.discoveryBackendVersion(), null);
  binder.observe(backendInitialize("0.171.0", C2));
  assert.equal(binder.discoveryBackendVersion(), null, "never revived");
});

test("an error, malformed, duplicate, foreign, withdrawn, or closed handshake proves no discovery version", () => {
  const errored = attested();
  errored.observe(initialize());
  errored.observe(backendInitialize(undefined));
  assert.equal(errored.discoveryBackendVersion(), null);

  for (const malformed of ["0.171", "0.171.0-alpha", "v0.171.0", "", "0.171.0 "]) {
    const binder = attested();
    binder.observe(initialize());
    binder.observe(backendInitialize(malformed));
    assert.equal(binder.discoveryBackendVersion(), null, JSON.stringify(malformed));
  }

  // Support is the owner's decision: an unsupported stable triple is carried for it to refuse.
  const other = attested();
  other.observe(initialize());
  other.observe(backendInitialize("0.170.0"));
  assert.equal(other.discoveryBackendVersion()?.version, "0.170.0");

  const duplicate = attested();
  duplicate.observe(initialize());
  duplicate.observe(backendInitialize("0.171.0"));
  duplicate.observe(backendInitialize("0.171.0"));
  assert.equal(duplicate.discoveryBackendVersion(), null, "a second answer clears it permanently");

  const foreign = attested();
  foreign.observe(initialize());
  foreign.observe(backendInitialize("0.171.0", C2));
  assert.equal(foreign.current().phase, "withdrawn");
  assert.equal(foreign.discoveryBackendVersion(), null);

  const withdrawn = attested();
  withdrawn.observe(initialize());
  withdrawn.observe(backendInitialize("0.171.0"));
  withdrawn.withdraw("metadata-unavailable");
  assert.equal(withdrawn.discoveryBackendVersion(), null);

  const closed = attested();
  closed.observe(initialize());
  closed.observe(backendInitialize("0.171.0"));
  closed.observe({ kind: "generation-closed", connectionId: C, sequence: 9, reason: "client-closed" });
  assert.equal(closed.discoveryBackendVersion(), null, "a closed generation proves nothing");
});
