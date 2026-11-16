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
  // A start response alone is a private candidate, never a publication.
  assert.deepEqual(binder.current(), { phase: "candidate", connectionId: C });
  assert.equal("rootThreadId" in binder.current(), false);
  assert.equal("rootTurnId" in binder.current(), false);

  binder.observe(work(A, "turn-1"));
  assert.deepEqual(binder.current(), {
    phase: "bound",
    connectionId: C,
    rootThreadId: A,
    rootTurnId: "turn-1",
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
  assert.deepEqual(binder.current(), { phase: "candidate", connectionId: C });

  binder.observe(work(A, "turn-1"));
  assert.deepEqual(binder.current(), {
    phase: "bound",
    connectionId: C,
    rootThreadId: A,
    rootTurnId: "turn-1",
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
  assert.deepEqual(sameTurn.current(), { phase: "candidate", connectionId: C });
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
