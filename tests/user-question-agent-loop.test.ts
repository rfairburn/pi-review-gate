import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { UserQuestionController } from "../src/user-question/controller";
import { createUserQuestionTool, USER_QUESTION_TOOL_NAME, type UserQuestionTool } from "../src/user-question/tool";

/**
 * Decline and continuation semantics against the real Pi agent loop with a
 * controlled provider that counts model calls. The runtime is the installed
 * pi-agent-core dist (CI sets PI_BROWSER_AGENT_RUNTIME; locally point it at
 * an installed Pi's node_modules/@earendil-works/pi-agent-core/dist/index.js).
 * Skipped when unset, like the browser native-error regression.
 */
const runtime = process.env.PI_BROWSER_AGENT_RUNTIME;

interface ScriptedResponse {
  stopReason: "toolUse" | "stop";
  content: Array<Record<string, unknown>>;
}

function makeModel() {
  return {
    id: "fixture", name: "fixture", provider: "fixture", api: "fixture",
    input: ["text"], reasoning: false, contextWindow: 10_000, maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function usage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistantResponse(script: ScriptedResponse) {
  return {
    role: "assistant", content: script.content, api: "fixture", provider: "fixture", model: "fixture",
    stopReason: script.stopReason, timestamp: 0, usage: usage(),
  };
}

/**
 * Wraps the production tool exactly like Pi's wrapRegisteredTools does: the
 * host resolves the runner context at call time and passes it as the fifth
 * execute argument. Everything else runs through production code.
 */
function withSessionContext(tool: UserQuestionTool, sessionManager: unknown): Record<string, any> {
  return {
    ...tool,
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown) =>
      tool.execute(id, params, signal, onUpdate, { sessionManager }),
  };
}

async function loadAgentLoop(): Promise<(...args: any[]) => AsyncIterable<any>> {
  const load = new Function("url", "return import(url)") as (url: string) => Promise<any>;
  const mod = await load(pathToFileURL(runtime!).href);
  return mod.agentLoop;
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: arguments_ };
}

interface LoopRun {
  events: any[];
  modelCalls: number;
  contexts: Array<{ messages: unknown[] }>;
}

async function runLoop(
  tools: Record<string, any>[],
  script: ScriptedResponse[],
): Promise<LoopRun & { done: Promise<void> }> {
  const agentLoop = await loadAgentLoop();
  let modelCalls = 0;
  const contexts: LoopRun["contexts"] = [];
  const streamFn = (_model: any, llmContext: { messages: unknown[] }) => {
    modelCalls += 1;
    const scriptEntry = script[Math.min(modelCalls - 1, script.length - 1)]!;
    contexts.push({ messages: [...llmContext.messages] });
    const message = assistantResponse(scriptEntry);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: scriptEntry.stopReason, message };
      },
      result: async () => message,
    };
  };
  const events: any[] = [];
  const done = (async () => {
    for await (const event of agentLoop(
      [{ role: "user", content: "fixture only", timestamp: 0 }],
      { systemPrompt: "fixture", messages: [], tools },
      { model: makeModel(), convertToLlm: (messages: unknown[]) => messages, shouldStopAfterTurn: () => false },
      undefined,
      streamFn,
    )) {
      events.push(event);
    }
  })();
  return { events, get modelCalls() { return modelCalls; }, contexts, done };
}

async function waitForPending(controller: UserQuestionController, timeoutMs = 2000): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const pending = controller.listPending();
    if (pending.length > 0) return pending[0]!.id;
    if (Date.now() - startedAt > timeoutMs) throw new Error("question never became pending");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function toolResultsOf(events: any[]): any[] {
  return events.filter((event) => event.type === "message_end" && event.message?.role === "toolResult").map((event) => event.message);
}

test("sync decline in a question-only batch ends the run after one model call", { skip: !runtime }, async () => {
  const sessionManager = { id: "solo-decline" };
  const controller = new UserQuestionController({ pi: {}, uiAvailable: () => true });
  controller.beginSession(sessionManager);
  const tool = withSessionContext(createUserQuestionTool(controller, { shortcutLabel: "Ctrl+Alt+Up" }), sessionManager);
  const run = await runLoop([tool], [
    { stopReason: "toolUse", content: [toolCall("c1", USER_QUESTION_TOOL_NAME, { question: "Which database?", mode: "sync" })] },
    { stopReason: "stop", content: [{ type: "text", text: "must not be reached" }] },
  ]);
  try {
    const id = await waitForPending(controller);
    // Give the production execute() a moment to install its waiter.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    controller.submitDecline(id);
    await run.done;
    assert.equal(run.modelCalls, 1, "a declined question-only batch must not trigger another model call");
    const results = toolResultsOf(run.events);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0].content), /declined to answer/);
  } finally {
    controller.endSession();
  }
});

test("sync decline in a mixed batch still delivers the other results and continues once", { skip: !runtime }, async () => {
  const sessionManager = { id: "mixed-decline" };
  const controller = new UserQuestionController({ pi: {}, uiAvailable: () => true });
  controller.beginSession(sessionManager);
  const questionTool = withSessionContext(createUserQuestionTool(controller, { shortcutLabel: "Ctrl+Alt+Up" }), sessionManager);
  const probeTool = {
    name: "Probe", label: "Probe", description: "probe", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "probe-ok" }], details: {} }),
  };
  const run = await runLoop([questionTool, probeTool], [
    {
      stopReason: "toolUse",
      content: [
        toolCall("c1", USER_QUESTION_TOOL_NAME, { question: "Which database?", mode: "sync" }),
        toolCall("c2", "Probe", {}),
      ],
    },
    { stopReason: "stop", content: [{ type: "text", text: "continued with the probe result" }] },
  ]);
  try {
    const id = await waitForPending(controller);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    controller.submitDecline(id);
    await run.done;
    assert.equal(run.modelCalls, 2, "a mixed batch continues with its non-terminating results");
    const results = toolResultsOf(run.events);
    assert.equal(results.length, 2);
    const secondContextText = JSON.stringify(run.contexts[1]?.messages ?? []);
    assert.match(secondContextText, /declined to answer/);
    assert.match(secondContextText, /probe-ok/, "the other result is delivered alongside the decline");
  } finally {
    controller.endSession();
  }
});

test("sync answer continues the run with the answer visible to the model", { skip: !runtime }, async () => {
  const sessionManager = { id: "sync-answer" };
  const controller = new UserQuestionController({ pi: {}, uiAvailable: () => true });
  controller.beginSession(sessionManager);
  const tool = withSessionContext(
    createUserQuestionTool(controller, { shortcutLabel: "Ctrl+Alt+Up" }),
    sessionManager,
  );
  const run = await runLoop([tool], [
    { stopReason: "toolUse", content: [toolCall("c1", USER_QUESTION_TOOL_NAME, { question: "Which database?", choices: ["SQLite", "Postgres"], mode: "sync" })] },
    { stopReason: "stop", content: [{ type: "text", text: "proceeded with the answer" }] },
  ]);
  try {
    const id = await waitForPending(controller);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    controller.submitAnswer(id, "Postgres");
    await run.done;
    assert.equal(run.modelCalls, 2);
    const secondMessages = (run.contexts[1]?.messages ?? []) as Array<Record<string, unknown>>;
    const toolResult = secondMessages.find((message) => message.role === "toolResult");
    assert.ok(toolResult, "the answered result is in the model's next context");
    const resultText = JSON.parse(JSON.stringify(toolResult.content)).map((part: { text?: string }) => part.text ?? "").join(" ");
    assert.match(resultText, /The user answered "Which database\?": Postgres/);
  } finally {
    controller.endSession();
  }
});

test("async question returns immediately and the run continues without any user action", { skip: !runtime }, async () => {
  const sessionManager = { id: "async-question" };
  const controller = new UserQuestionController({ pi: {}, uiAvailable: () => true });
  controller.beginSession(sessionManager);
  const tool = withSessionContext(createUserQuestionTool(controller, { shortcutLabel: "Ctrl+Alt+Up" }), sessionManager);
  const run = await runLoop([tool], [
    { stopReason: "toolUse", content: [toolCall("c1", USER_QUESTION_TOOL_NAME, { question: "Which database?", choices: ["SQLite", "Postgres"] })] },
    { stopReason: "stop", content: [{ type: "text", text: "continued while the question stays pending" }] },
  ]);
  try {
    await run.done;
    assert.equal(run.modelCalls, 2, "async registration must not block the loop");
    const results = toolResultsOf(run.events);
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0].content), /Question registered as q1/);
    assert.equal(controller.listPending().length, 1, "the question stays pending and discoverable");
  } finally {
    controller.endSession();
  }
});
