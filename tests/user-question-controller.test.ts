import assert from "node:assert/strict";
import test from "node:test";
import { UserQuestionController, formatAnswerDelivery } from "../src/user-question/controller";
import { createUserQuestionTool } from "../src/user-question/tool";
import { JUST_OVER_REMOVED_CAP, LARGE_QUESTION_PARAGRAPHS, longFormQuestion } from "./long-question-fixtures";

interface FakeHost {
  sent: Array<{ message: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  pi: unknown;
}

function fakeHost(idle = true): FakeHost {
  const sent: FakeHost["sent"] = [];
  return {
    sent,
    pi: {
      sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }) {
        sent.push({ message, options });
        return Promise.resolve();
      },
      isIdle: () => idle,
    },
  };
}

function makeController(host: FakeHost, uiAvailable = true) {
  const changes: number[] = [];
  const controller = new UserQuestionController({
    pi: host.pi,
    uiAvailable: () => uiAvailable,
    onStateChange: () => changes.push(controller.listPending().length),
  });
  return { controller, changes };
}

const SESSION_A = { id: "A" };
const SESSION_B = { id: "B" };

test("registration fails closed before a session binds the controller", () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  const result = controller.register(
    { toolCallId: "t1", question: "Which option?", mode: "async" },
    SESSION_A,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unavailable");
});

test("registration fails closed when the UI surface is unavailable", () => {
  const host = fakeHost();
  const { controller } = makeController(host, false);
  controller.beginSession(SESSION_A);
  const result = controller.register(
    { toolCallId: "t1", question: "Which option?", mode: "async" },
    SESSION_A,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unavailable");
    assert.match(result.message, /not available/i);
  }
});

test("registration rejects a context that does not belong to the bound session", () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const result = controller.register(
    { toolCallId: "t1", question: "Which option?", mode: "async" },
    SESSION_B,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "identity-mismatch");
});

test("async answer delivery is plain when idle and steering while busy", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", choices: ["SQLite", "Postgres"], mode: "async" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;

  const idle = fakeHost();
  const idleController = new UserQuestionController({ pi: idle.pi, uiAvailable: () => true });
  idleController.beginSession(SESSION_A);
  const idleRegistered = idleController.register(
    { toolCallId: "t2", question: "Which database?", mode: "async" },
    SESSION_A,
  );
  assert.ok(idleRegistered.ok);
  if (!idleRegistered.ok) return;

  // Busy probe at submission time: steering.
  const busy = controller.submitAnswer(registered.question.id, "Postgres", { isIdle: () => false });
  assert.deepEqual(busy, { status: "delivered", empty: true });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.sent.length, 1);
  assert.match(host.sent[0]!.message, /Answer to pending question "Which database\?": Postgres/);
  assert.deepEqual(host.sent[0]!.options, { deliverAs: "steer" });

  // Idle probe at submission time: plain send.
  idleController.submitAnswer(idleRegistered.question.id, "SQLite", { isIdle: () => true });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(idle.sent.length, 1);
  assert.deepEqual(idle.sent[0]!.options, undefined);
});

test("async decline removes the question without sending any message", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "async" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const result = controller.submitDecline(registered.question.id);
  assert.deepEqual(result, { status: "declined", empty: true });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.sent.length, 0, "no fabricated or implied answer is delivered");
  assert.equal(controller.listPending().length, 0);
});

test("sync wait resolves with the user's choice and wasChoice flag", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", choices: ["SQLite", "Postgres"], mode: "sync" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const waiting = controller.waitForAnswer(registered.question.id);
  const submitted = controller.submitAnswer(registered.question.id, "SQLite");
  assert.deepEqual(submitted, { status: "delivered", empty: true });
  await assert.doesNotReject(waiting);
  const result = await waiting;
  assert.deepEqual(result, { outcome: "answered", answer: "SQLite", wasChoice: true });
});

test("sync wait resolves declined without a terminating hint for the controller", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "sync" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const waiting = controller.waitForAnswer(registered.question.id);
  controller.submitDecline(registered.question.id);
  await assert.doesNotReject(waiting);
  assert.deepEqual(await waiting, { outcome: "declined" });
});

test("session shutdown settles every remaining sync waiter", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "sync" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const waiting = controller.waitForAnswer(registered.question.id);
  controller.endSession();
  await assert.doesNotReject(waiting);
  assert.deepEqual(await waiting, { outcome: "settled" });
  assert.equal(controller.listPending().length, 0);
});

test("run abort settles the sync wait as interrupted", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "sync" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const abortController = new AbortController();
  const waiting = controller.waitForAnswer(registered.question.id, abortController.signal);
  abortController.abort();
  await assert.doesNotReject(waiting);
  assert.deepEqual(await waiting, { outcome: "interrupted" });
  // The interrupted wait must not leave a phantom [waiting] question behind:
  // no waiter remains that a later answer could reach.
  assert.equal(controller.listPending().length, 0, "the record is removed on interruption");
  const late = controller.submitAnswer(registered.question.id, "too late");
  assert.equal(late.status, "rejected", "a later answer cannot be delivered to a gone wait");
});

test("an already-aborted signal settles interrupted and removes the record", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "sync" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const abortController = new AbortController();
  abortController.abort();
  const result = await controller.waitForAnswer(registered.question.id, abortController.signal);
  assert.deepEqual(result, { outcome: "interrupted" });
  assert.equal(controller.listPending().length, 0);
});

test("a session switch clears pending state and rejects stale submissions", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "async" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const id = registered.question.id;

  // A stale callback from the old session's UI is rejected after the switch.
  controller.beginSession(SESSION_B);
  assert.equal(controller.listPending().length, 0, "questions never cross sessions");
  const answer = controller.submitAnswer(id, "SQLite", { isIdle: () => true });
  assert.deepEqual(answer, { status: "rejected", empty: true });
  const decline = controller.submitDecline(id);
  assert.deepEqual(decline, { status: "rejected", empty: true });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.sent.length, 0, "no message reaches the new session");
});

test("delivery rechecks identity at send time", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register(
    { toolCallId: "t1", question: "Which database?", mode: "async" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  // Simulate the session being replaced between submission and the async send.
  controller.beginSession(SESSION_B);
  // Re-register under B is irrelevant: submitting the stale id must be a no-op.
  const result = controller.submitAnswer(registered.question.id, "SQLite", { isIdle: () => true });
  assert.equal(result.status, "rejected");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.sent.length, 0);
});

test("invalid questions and choices are rejected before registration", () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  // Empty and whitespace-only questions stay invalid; a non-string is rejected
  // rather than thrown (#396 removed only the question-only 2,000 ceiling).
  for (const question of ["", "   "]) {
    const result = controller.register({ toolCallId: "t", question, mode: "async" }, SESSION_A);
    assert.equal(result.ok, false, JSON.stringify(question));
    if (!result.ok) assert.equal(result.reason, "invalid");
  }
  for (const question of [42, null, undefined, {}, ["a?"]] as unknown as string[]) {
    const result = controller.register({ toolCallId: "t", question, mode: "async" }, SESSION_A);
    assert.equal(result.ok, false, String(question));
    if (!result.ok) assert.equal(result.reason, "invalid");
  }
  for (const choices of [["ok", ""], ["a".repeat(301)], new Array(13).fill("x"), [42], "not-an-array" as unknown as string[]]) {
    const result = controller.register({ toolCallId: "t", question: "q?", choices, mode: "async" }, SESSION_A);
    assert.equal(result.ok, false, JSON.stringify(choices));
    if (!result.ok) assert.equal(result.reason, "invalid");
  }
  // Absent and empty choice lists are valid (free text only).
  for (const choices of [undefined, []]) {
    const result = controller.register({ toolCallId: "t", question: "q?", choices, mode: "async" }, SESSION_A);
    assert.ok(result.ok, JSON.stringify(choices));
  }
  const ok = controller.register(
    { toolCallId: "t", question: "q?", choices: ["a", "b"], mode: "async" },
    SESSION_A,
  );
  assert.ok(ok.ok);
});

test("ids are stable per session and reset on a new session", () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const first = controller.register({ toolCallId: "t1", question: "one?", mode: "async" }, SESSION_A);
  const second = controller.register({ toolCallId: "t2", question: "two?", mode: "async" }, SESSION_A);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.question.id, "q1");
  assert.equal(second.question.id, "q2");
  controller.beginSession(SESSION_B);
  const third = controller.register({ toolCallId: "t3", question: "three?", mode: "async" }, SESSION_B);
  assert.ok(third.ok);
  if (!third.ok) return;
  assert.equal(third.question.id, "q1", "handles restart per session");
});

test("empty answers are rejected and keep the question pending", () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const registered = controller.register({ toolCallId: "t1", question: "q?", mode: "async" }, SESSION_A);
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const result = controller.submitAnswer(registered.question.id, "   ");
  assert.deepEqual(result, { status: "rejected", empty: false });
  assert.equal(controller.listPending().length, 1);
});

test("state change notifications track the pending count", () => {
  const host = fakeHost();
  const { controller, changes } = makeController(host);
  controller.beginSession(SESSION_A); // notifies with an empty pending set
  const registered = controller.register({ toolCallId: "t1", question: "q?", mode: "async" }, SESSION_A);
  assert.ok(registered.ok);
  if (!registered.ok) return;
  controller.submitDecline(registered.question.id);
  assert.deepEqual(changes, [0, 1, 0]);
});

test("formatAnswerDelivery quotes the accepted question in full (#396)", () => {
  const short = formatAnswerDelivery("Which database?", "SQLite");
  assert.equal(short, 'Answer to pending question "Which database?": SQLite');
  const longQuestion = longFormQuestion(30);
  const delivered = formatAnswerDelivery(longQuestion, "yes");
  assert.equal(delivered, `Answer to pending question "${longQuestion}": yes`);
  assert.equal(delivered.includes("…"), false, "no ellipsis replaces any part of the accepted question");
  assert.equal(delivered.includes(longQuestion), true, "the complete question reaches the model in the settlement message");
});

test("long-form questions pass admission and are retained in full (#396)", () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);

  // Just over the removed 2,000-character ceiling, and a substantially larger
  // multiline Unicode question: both are ordinary questions now.
  const justOver = JUST_OVER_REMOVED_CAP;
  const large = longFormQuestion(LARGE_QUESTION_PARAGRAPHS);
  assert.ok(justOver.length > 2_000 && justOver.length < 2_200, `the just-over fixture is ${justOver.length} characters`);
  assert.ok(large.length > 12_000, `the multiline/Unicode fixture is substantially larger (${large.length})`);

  const first = controller.register({ toolCallId: "t1", question: justOver, mode: "async" }, SESSION_A);
  assert.ok(first.ok, "a 2,001-character question is admitted");
  const second = controller.register(
    { toolCallId: "t2", question: `  \n${large}\n  `, choices: ["Alpha", "Beta"], mode: "async" },
    SESSION_A,
  );
  assert.ok(second.ok, "a substantially larger multiline/Unicode question is admitted");
  if (!first.ok || !second.ok) return;

  // Normalization is ends-only: the accepted text survives in full, in order,
  // with every embedded newline, combining mark, and emoji untouched.
  assert.equal(first.question.question, justOver);
  assert.equal(second.question.question, large);
  assert.equal(second.question.question.length, large.length);
  assert.equal(controller.get(second.question.id)!.question, large, "pending storage keeps the complete question");
});

test("async settlement delivers the complete long question with the answer (#396)", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const question = longFormQuestion(40);
  const registered = controller.register(
    { toolCallId: "t1", question, choices: ["Alpha"], mode: "async" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;

  const result = controller.submitAnswer(registered.question.id, "Alpha", { isIdle: () => true });
  assert.equal(result.status, "delivered");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]!.message, `Answer to pending question "${question}": Alpha`);
  assert.equal(host.sent[0]!.message.includes("…"), false, "nothing in the delivered answer is elided");
});

test("sync settlement returns the complete long question to the waiting call (#396)", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const question = longFormQuestion(40);
  const registered = controller.register(
    { toolCallId: "t1", question, choices: ["Alpha"], mode: "sync" },
    SESSION_A,
  );
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const waiting = controller.waitForAnswer(registered.question.id);
  controller.submitAnswer(registered.question.id, "Alpha");
  const wait = await waiting;
  assert.deepEqual(wait, { outcome: "answered", answer: "Alpha", wasChoice: true });

  // The tool maps that wait result into the model-facing text; assert the full
  // question survives there too (no question-only quote bound on either path).
  const tool = createUserQuestionTool(controller, { shortcutLabel: "Ctrl+Alt+Up" });
  const running = tool.execute(
    "call-2",
    { question, mode: "sync" },
    undefined,
    undefined,
    { sessionManager: SESSION_A },
  );
  const waitingRecord = controller.listPending().find((record) => !("kind" in record) && record.mode === "sync");
  assert.ok(waitingRecord, "the sync tool call registered its question and holds the wait");
  controller.submitAnswer(waitingRecord!.id, "go");
  const settled = await running;
  assert.deepEqual(settled.content, [{ type: "text", text: `The user answered "${question}": go` }]);
  assert.equal(String((settled.details as Record<string, unknown>).answer), "go");
});

test("a stale or foreign session still cannot settle a long question (#396)", async () => {
  const host = fakeHost();
  const { controller } = makeController(host);
  controller.beginSession(SESSION_A);
  const question = longFormQuestion(20);
  const registered = controller.register({ toolCallId: "t1", question, mode: "async" }, SESSION_A);
  assert.ok(registered.ok);
  if (!registered.ok) return;

  // Registration from another session's context is rejected outright.
  const foreign = controller.register({ toolCallId: "t2", question, mode: "async" }, SESSION_B);
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.reason, "identity-mismatch");

  // And after the session is replaced, the old question cannot be answered or
  // declined into the new session.
  controller.beginSession(SESSION_B);
  assert.equal(controller.submitAnswer(registered.question.id, "Alpha").status, "rejected");
  assert.equal(controller.submitDecline(registered.question.id).status, "rejected");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(host.sent.length, 0, "nothing is delivered into another session");
});
