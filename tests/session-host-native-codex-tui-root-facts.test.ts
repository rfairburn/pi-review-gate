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
  const cases: Array<{ readonly label: string; readonly event: NativeCodexTuiRelayMetadataEvent; readonly reason: string }> = [
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

  for (const { label, event, reason } of cases) {
    const binder = boundBinder();
    binder.observe(event);
    assert.deepEqual(
      binder.current(),
      { phase: "withdrawn", connectionId: C, withdrawal: reason },
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

  // A genuine next turn whose terminal precedes its own start projection never
  // leaves a stale pending once that turn is confirmed.
  const early = boundBinder();
  early.observe(terminalEvent(A, "turn-1"));
  early.observe(questionsEvent(A, "call-next", 1, "turn-2"));
  early.observe(terminalEvent(A, "turn-2"));
  early.observe(work(A, "turn-2"));
  assert.equal(early.current().asyncInput, "unknown");
  early.observe(terminalEvent(A, "turn-2"));
  assert.equal(early.current().asyncInput, "none");
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
