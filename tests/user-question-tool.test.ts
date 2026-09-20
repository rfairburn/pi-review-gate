import assert from "node:assert/strict";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
import { createUserQuestionTool, USER_QUESTION_TOOL_NAME } from "../src/user-question/tool";

const SESSION_MANAGER = { id: "S" };

/** The tool context Pi passes: its sessionManager is the session identity. */
const SESSION = { sessionManager: SESSION_MANAGER };

function makeFixture(uiAvailable = true) {
  const sent: Array<{ message: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
  const controller = new UserQuestionController({
    pi: {
      sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }) {
        sent.push({ message, options });
        return Promise.resolve();
      },
    },
    uiAvailable: () => uiAvailable,
  });
  controller.beginSession(SESSION_MANAGER);
  const tool = createUserQuestionTool(controller, { shortcutLabel: "Ctrl+Alt+Up" });
  return { controller, sent, tool };
}

test("the tool exposes the approved schema surface", () => {
  const { tool } = makeFixture();
  assert.equal(tool.name, USER_QUESTION_TOOL_NAME);
  assert.equal(tool.executionMode, "sequential");
  const parameters = tool.parameters as Record<string, any>;
  assert.equal(parameters.type, "object");
  assert.deepEqual(parameters.required, ["question"]);
  assert.equal(parameters.properties.question.type, "string");
  assert.deepEqual(parameters.properties.mode.enum, ["async", "sync"]);
  assert.equal(parameters.properties.mode.default, "async");
  assert.equal(parameters.properties.choices.maxItems, 12);
  assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
});

test("async mode returns a pending handle immediately without waiting", async () => {
  const { controller, tool } = makeFixture();
  let resolved = false;
  const running = tool.execute(
    "call-1",
    { question: "Which database?", choices: ["SQLite", "Postgres"] },
    undefined,
    undefined,
    SESSION,
  );
  const result = await Promise.race([
    running.then((value) => ({ done: true as const, value })),
    new Promise<{ done: false }>((resolvePromise) => setTimeout(() => resolvePromise({ done: false }), 25)),
  ]);
  assert.equal(result.done, true, "async registration must not block");
  if (!result.done) return;
  resolved = true;
  const details = result.value.details as Record<string, unknown>;
  assert.equal(details.status, "pending");
  assert.equal(details.id, "q1");
  const text = (result.value.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /Question registered as q1/);
  assert.match(text, /Ctrl\+Alt\+Up/);
  assert.match(text, /do not assume an answer/i);
  assert.equal(controller.listPending().length, 1);
  assert.ok(resolved);
});

test("sync mode waits and returns the user's answer", async () => {
  const { controller, tool } = makeFixture();
  const running = tool.execute(
    "call-1",
    { question: "Which database?", choices: ["SQLite", "Postgres"], mode: "sync" },
    undefined,
    undefined,
    SESSION,
  );
  // The call must still be pending before any user action.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(controller.listPending().length, 1);
  const id = controller.listPending()[0]!.id;
  void controller.submitAnswer(id, "Postgres");
  const result = await running;
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "answered");
  assert.equal(details.answer, "Postgres");
  assert.equal(details.wasChoice, true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /The user answered "Which database\?": Postgres/);
  assert.equal(result.terminate, undefined, "an answer never terminates the batch");
});

test("sync decline returns a terminating declined result", async () => {
  const { controller, tool } = makeFixture();
  const running = tool.execute(
    "call-1",
    { question: "Which database?", mode: "sync" },
    undefined,
    undefined,
    SESSION,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  const id = controller.listPending()[0]!.id;
  void controller.submitDecline(id);
  const result = await running;
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "declined");
  assert.equal(result.terminate, true, "decline terminates question-only batches");
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /declined to answer/);
  assert.match(text, /Do not proceed with the work this question gated/);
});

test("sync wait settles when the session ends", async () => {
  const { controller, tool } = makeFixture();
  const running = tool.execute(
    "call-1",
    { question: "Which database?", mode: "sync" },
    undefined,
    undefined,
    SESSION,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  controller.endSession();
  const result = await running;
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "interrupted");
  assert.equal(result.terminate, undefined);
});

test("sync wait settles on run abort", async () => {
  const { controller, tool } = makeFixture();
  const abortController = new AbortController();
  const running = tool.execute(
    "call-1",
    { question: "Which database?", mode: "sync" },
    abortController.signal,
    undefined,
    SESSION,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  abortController.abort();
  const result = await running;
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "interrupted");
  // No phantom [waiting] question survives the interruption.
  assert.equal(controller.listPending().length, 0);
});

test("registration is rejected when the context has no session identity", async () => {
  const { controller, tool } = makeFixture();
  const result = await tool.execute("call-1", { question: "Which database?" }, undefined, undefined, undefined);
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "rejected");
  assert.equal(details.reason, "identity-mismatch");
  assert.equal(controller.listPending().length, 0);
});

test("registration is rejected when the context belongs to another session", async () => {
  const { controller, tool } = makeFixture();
  const result = await tool.execute(
    "call-1",
    { question: "Which database?" },
    undefined,
    undefined,
    { sessionManager: "OTHER" },
  );
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "rejected");
  assert.equal(details.reason, "identity-mismatch");
});

test("the tool fails closed when the UI surface is unavailable", async () => {
  const { controller, tool } = makeFixture(false);
  const result = await tool.execute("call-1", { question: "Which database?" }, undefined, undefined, SESSION);
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "rejected");
  assert.equal(details.reason, "unavailable");
  assert.equal(controller.listPending().length, 0);
});

test("invalid input is rejected with an explicit diagnostic", async () => {
  const { controller, tool } = makeFixture();
  const result = await tool.execute("call-1", { question: "" }, undefined, undefined, SESSION);
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "rejected");
  assert.equal(details.reason, "invalid");
  assert.equal(controller.listPending().length, 0);
});
