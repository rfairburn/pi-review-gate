import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import type { ExecutorLiveControl } from "../src/execution/types";
import { EXECUTION_TOOL_NAMES, ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";

// Production registered commands + real controller/persistence, recording only
// the host message boundary. These are dispatch proofs, not native model proof.
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "prg-human-notices-"));
  await initGitRepo(root);
  const hold = join(root, "hold");
  await writeFile(hold, "hold");
  const executor = join(root, "executor.cjs");
  await writeFile(executor, `const fs=require('node:fs');
console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));
fs.writeFileSync(${JSON.stringify(join(root, "ready"))},'ready');
const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(hold)})){clearInterval(timer);console.log(JSON.stringify({type:'assistant',text:'done'}));}},20);
`);
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const feedback: Array<{ content: string; level: string }> = [];
  const config = normalizeConfig({
    enabled: true, review: { activeReviewers: [] },
    externalAgents: { fake: { adapter: "run-as-binary", command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] } } },
    execution: { deferredPiTools: false, workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] } },
  });
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    getActiveTools: () => ["read", "bash", ...Object.values(EXECUTION_TOOL_NAMES)],
    setToolActive: () => {},
    sendMessage: (message: any, options: unknown): unknown => { messages.push({ ...message, options }); return undefined; },
  };
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  const ui = {
    select: async (_title: string, choices: string[]) => choices[0],
    notify: (content: string, level: string) => { feedback.push({ content, level }); },
  };
  const run = (name: string, args = "", customUi: object = ui, ctx: object = {}) => commands.get(name)!(args, { ...ctx, ui: customUi });
  const notices = (type: "launch" | "steer") => messages.filter((message) => message.customType === `pi-review-subtask-${type}`);
  const start = async () => (await tools.get("SubtasksStart").execute("seed", {
    kind: "inplace", tasks: [{ title: "Held task", instructions: "Wait", acceptanceCriteria: ["done"] }],
  }, undefined, undefined, {})).details;
  const scriptedUi = (destination: "new" | "existing", changes: Record<string, string | undefined> = {}, confirmed = true) => ({
    ...ui,
    select: async (title: string, choices: string[]) => title === "Submit a subtask"
      ? choices[destination === "new" ? 0 : 1] : title === "Execution kind" ? "inplace — write in a selected directory (no capture/landing)" : choices[0],
    editor: async (title: string) => title in changes ? changes[title] : ({
      "Task title": "Staged sk-ABCDEFGHIJKLMN", "Task instructions": "Do not dump FULL-INSTRUCTIONS", "Acceptance criteria (one per line)": "Done", "Relevant context (optional)": "",
    }[title] ?? ""),
    confirm: async () => confirmed,
  });
  return { root, hold, pi, manager, controller, messages, feedback, notices, run, start, ui, scriptedUi,
    close: async () => { await rm(hold, { force: true }); await manager.shutdown(); await manager.detach(); await rm(root, { recursive: true, force: true }); } };
}

function liveControl(h: Awaited<ReturnType<typeof harness>>, taskId: string, steer: ExecutorLiveControl["steer"]) {
  const runtimes = (h.controller as unknown as { runtimes: Map<string, { control?: ExecutorLiveControl }> }).runtimes;
  const runtime = runtimes.get(taskId);
  assert.ok(runtime);
  runtime.control = { adapter: "run-as-binary", generation: 1, capabilities: { steer: true, interrupt: true },
    steer, interrupt: async () => ({ status: "acknowledged", message: "unused" }) };
}

for (const destination of ["new", "existing"] as const) {
  test(`staged human add to ${destination} sends exactly one bounded shared launch with only the admitted task`, async () => {
    const h = await harness();
    try {
      const seed = destination === "existing" ? await h.start() : undefined;
      await h.run("subtask-add", "", h.scriptedUi(destination));
      const [notice] = h.notices("launch");
      assert.equal(h.notices("launch").length, 1);
      assert.equal(notice.details.origin, "human-command");
      assert.deepEqual(notice.options, { deliverAs: "steer", triggerTurn: true });
      assert.equal(notice.details.tasks.length, 1);
      assert.ok(!JSON.stringify(notice).includes("sk-ABCDEFGHIJKLMN"));
      assert.ok(!JSON.stringify(notice).includes("FULL-INSTRUCTIONS"));
      const inspection = h.controller.inspect(notice.details.executionId);
      assert.equal(inspection.tasks.length, destination === "existing" ? 2 : 1);
      assert.equal(inspection.tasks.at(-1)!.definition.instructions, "Do not dump FULL-INSTRUCTIONS");
      if (seed) {
        assert.equal(notice.details.executionId, seed.executionId);
        assert.deepEqual(notice.details.addedTaskIds, [inspection.tasks.at(-1)!.taskId]);
        assert.notEqual(notice.details.tasks[0].taskId, seed.tasks[0].taskId);
      }
      assert.equal(h.feedback.at(-1)!.level, "info");
    } finally { await h.close(); }
  });
}

test("immediate add redacts before the 80-character cut without changing canonical instructions or UI title", async () => {
  const h = await harness();
  try {
    await h.start(); // Occupy capacity so the immediate execute stays queued.
    const instructions = "x".repeat(72) + " sk-ABCDEFGHIJKLMN" + " z".repeat(2_000);
    await h.run("subtask-add", instructions);
    const [notice] = h.notices("launch");
    assert.equal(h.notices("launch").length, 1);
    assert.ok(!JSON.stringify(notice).includes("sk-ABC"), "neither content nor details leaks the clipped token");
    assert.ok(notice.content.length <= 2_000);
    assert.ok(notice.details.tasks[0].title.length <= 80, "no full instruction dump");
    const task = h.controller.inspect(notice.details.executionId).tasks[0]!;
    assert.equal(task.definition.instructions, instructions);
    assert.equal(task.definition.title, instructions.slice(0, 79) + "…", "existing UI task title is byte-identical");
    assert.ok(h.feedback.at(-1)!.content.includes(task.definition.title));
  } finally { await h.close(); }
});

for (const style of ["explicit", "picker-input", "picker-editor", "picker-interrupt"] as const) {
  test(`human steer ${style} reports exactly one truthful acceptance with canonical status and redacted text`, async () => {
    const h = await harness();
    try {
      const started = await h.start();
      const taskId = started.tasks[0].taskId;
      const calls: unknown[] = [];
      liveControl(h, taskId, async (...args) => { calls.push(args); return { status: "acknowledged", message: "accepted transport" }; });
      const text = "Change  direction " + "x".repeat(970) + " sk-ABCDEFGHIJKLMN " + "x".repeat(5_000);
      const ui = { ...h.ui,
        select: async (title: string, choices: string[]) => choices[title === "Steering mode" && style === "picker-interrupt" ? 1 : 0],
        input: async () => style === "picker-editor" ? undefined : text,
        editor: async () => text,
      };
      await h.run("subtask-steer", style === "explicit" ? `${started.executionId} ${taskId} ${text}` : "", ui);
      assert.equal(calls.length, 1);
      assert.equal((calls[0] as unknown[])[0], text, "worker gets unchanged submitted text");
      const [notice] = h.notices("steer");
      assert.equal(h.notices("steer").length, 1);
      assert.equal(notice.details.taskId, taskId);
      assert.equal(notice.details.status, "acknowledged");
      assert.equal(notice.details.origin, "human-command");
      assert.ok(notice.content.length < 2_000);
      assert.ok(!JSON.stringify(notice).includes("sk-ABC"), "redact before the steer excerpt bound, including fragments");
      assert.equal(notice.details.interrupt, style === "picker-interrupt");
      assert.deepEqual((calls[0] as unknown[])[2], style === "picker-interrupt" ? { interrupt: true } : undefined);
      assert.match(notice.content, /not proof that the worker has applied/);
      assert.deepEqual(notice.options, { deliverAs: "steer", triggerTurn: true });
      assert.match(h.feedback.at(-1)!.content, /latest command: steer acknowledged/);
      const command = h.controller.inspect(started.executionId, taskId).tasks[0]!.commands.at(-1)!;
      assert.equal(command.instructionId, notice.details.instructionId);
      assert.equal(command.text, text);
    } finally { await h.close(); }
  });
}

test("queued human steering reports queued, not applied; model-facing steering gets no human notice", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.run("subtask-add", "Queued target");
    const launch = h.notices("launch")[0];
    const taskId = launch.details.tasks[0].taskId;
    await h.run("subtask-steer", `${launch.details.executionId} ${taskId} Adjust queued work`);
    assert.equal(h.notices("steer").length, 1);
    assert.equal(h.notices("steer")[0].details.status, "queued");
    await h.controller.steer({ executionId: launch.details.executionId, taskId, instructions: "model request", instructionId: "model-1", actor: "model" });
    assert.equal(h.notices("steer").length, 1, "no model-tool echo");
  } finally { await h.close(); }
});

test("cancelled, empty, rejected and failed commands never send a success notice", async () => {
  const h = await harness();
  try {
    const started = await h.start();
    const taskId = started.tasks[0].taskId;
    for (const stage of ["picker", "mode", "input", "empty"]) {
      await h.run("subtask-steer", "", { ...h.ui,
        select: async (title: string, choices: string[]) => stage === "picker" || (stage === "mode" && title === "Steering mode") ? undefined : choices[0],
        input: async () => stage === "empty" ? "  " : undefined,
      });
    }
    await h.run("subtask-steer", `${started.executionId} ${taskId}`);
    await h.run("subtask-steer", "exec-missing task-missing change work");
    for (const throwing of [false, true]) {
      liveControl(h, taskId, async () => { if (throwing) throw new Error("transport failed"); return { status: "failed", message: "rejected" }; });
      await h.run("subtask-steer", `${started.executionId} ${taskId} Refused work`);
      assert.equal(h.feedback.at(-1)!.level, "error");
    }
    assert.equal(h.notices("steer").length, 0);
    await h.run("subtask-add", "", { ...h.ui, select: async () => undefined });
    await h.run("subtask-add", "", h.scriptedUi("new", {}, false));
    await h.run("subtask-add", "", h.scriptedUi("new", { "Task instructions": "  " }));
    // Admission rejection, not just form validation.
    await h.run("subtask-add", "", h.scriptedUi("new", {
      "In-place workspace directory (optional; leave blank to use the current session workspace)": join(h.root, "missing-workspace"),
    }));
    assert.equal(h.feedback.at(-1)!.level, "error");
    assert.equal(h.notices("launch").length, 0);
  } finally { await h.close(); }
});

test("the human-steer gate precedes rapid dependent outcomes and survives an overlapping launch gate", async () => {
  const h = await harness();
  let release!: () => void;
  try {
    const started = await h.start();
    const taskId = started.tasks[0].taskId;
    // This goes through the real controller's wake path at the transport seam;
    // no send-options assertion alone can establish this causal ordering.
    const wake = (h.controller as any).wake.bind(h.controller);
    const task = (h.controller as any).groups.get(started.executionId).tasks[0];
    liveControl(h, taskId, async () => {
      void wake(task, "failure", "Dependent outcome");
      return { status: "acknowledged", message: "accepted" };
    });
    const original = h.pi.sendMessage;
    h.pi.sendMessage = (message, options) => {
      original(message, options);
      if (message.customType === "pi-review-subtask-steer") return new Promise<void>((resolve) => { release = resolve; });
      return undefined;
    };
    const pending = h.run("subtask-steer", `${started.executionId} ${taskId} New request`);
    await waitFor(() => h.notices("steer").length === 1);
    assert.equal(h.messages.filter((m) => m.customType === "pi-review-subtask-event").length, 0);
    // A concurrent command adds another gate to the SAME lane, not a second
    // notification state. It must not overwrite this pending steer notice.
    await h.run("subtask-add", "", h.scriptedUi("existing"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.messages.filter((m) => m.customType === "pi-review-subtask-event").length, 0);
    release();
    await pending;
    await waitFor(() => h.messages.some((m) => m.customType === "pi-review-subtask-event"));
    assert.ok(h.messages.findIndex((m) => m.customType === "pi-review-subtask-event") > h.messages.findIndex((m) => m.customType === "pi-review-subtask-steer"));
  } finally { release?.(); await h.close(); }
});

test("an actual fast worker completion stays behind the human steer acknowledgement notice", async () => {
  const h = await harness();
  let release!: () => void;
  try {
    const started = await h.start();
    const taskId = started.tasks[0].taskId;
    await waitFor(() => existsSync(join(h.root, "ready")));
    liveControl(h, taskId, async () => {
      await rm(h.hold);
      return { status: "acknowledged", message: "accepted" };
    });
    const original = h.pi.sendMessage;
    h.pi.sendMessage = (message, options) => {
      original(message, options);
      return message.customType === "pi-review-subtask-steer"
        ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
    };
    const pending = h.run("subtask-steer", `${started.executionId} ${taskId} Finish now`);
    await waitFor(() => Boolean(release));
    await waitFor(() => h.controller.inspect(started.executionId).tasks[0]!.state === "reported", 30_000);
    assert.equal(h.messages.filter((m) => m.customType === "pi-review-subtask-event").length, 0);
    release();
    await pending;
    await waitFor(() => h.messages.some((m) => m.customType === "pi-review-subtask-event" && /COMPLETE/.test(m.content)));
    assert.equal(h.notices("steer").length, 1);
    assert.equal(h.messages[0].customType, "pi-review-subtask-steer");
  } finally { release?.(); await h.close(); }
});

test("failed model notice delivery never changes successful command feedback or worker control", async () => {
  const h = await harness();
  try {
    const started = await h.start();
    const taskId = started.tasks[0].taskId;
    liveControl(h, taskId, async () => ({ status: "acknowledged", message: "accepted" }));
    h.pi.sendMessage = () => { throw new Error("host unavailable"); };
    await h.run("subtask-steer", `${started.executionId} ${taskId} Accepted worker request`);
    assert.equal(h.feedback.at(-1)!.level, "info");
    assert.match(h.feedback.at(-1)!.content, /steer acknowledged/);
    assert.equal(h.controller.inspect(started.executionId, taskId).tasks[0]!.commands.at(-1)!.status, "acknowledged");
  } finally { await h.close(); }
});

for (const guard of ["detach", "session", "invalidated-context"] as const) {
  test(`a stale ${guard} origin cannot enqueue a delayed human admission notice`, async () => {
    const h = await harness();
    let finish!: () => void;
    try {
      const start = h.controller.start.bind(h.controller);
      h.controller.start = async (...args) => {
        const admitted = await start(...args);
        await new Promise<void>((resolve) => { finish = resolve; });
        return admitted;
      };
      let sessionId = "session-one";
      const ctx = { sessionManager: {
        getSessionId: () => { if (sessionId === "retired") throw new Error("stale native context"); return sessionId; },
        getSessionFile: () => join(h.root, "session.jsonl"),
      } };
      const pending = h.run("subtask-add", "", h.scriptedUi("new"), ctx);
      await waitFor(() => Boolean(finish));
      if (guard === "detach") await h.manager.detach(); else sessionId = guard === "session" ? "session-two" : "retired";
      finish();
      await pending;
      assert.equal(h.notices("launch").length, 0);
      assert.equal(h.feedback.at(-1)!.level, "info");
    } finally { finish?.(); await h.close(); }
  });

  test(`a stale ${guard} origin cannot enqueue a human steer notice after acknowledgement`, async () => {
    const h = await harness();
    let finish!: () => void;
    try {
      const started = await h.start();
      const taskId = started.tasks[0].taskId;
      liveControl(h, taskId, async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { status: "acknowledged", message: "accepted" }; });
      let sessionId = "session-one";
      const ctx = { sessionManager: {
        getSessionId: () => { if (sessionId === "retired") throw new Error("stale native context"); return sessionId; },
        getSessionFile: () => join(h.root, "session.jsonl"),
      } };
      const pending = h.run("subtask-steer", `${started.executionId} ${taskId} Request`, h.ui, ctx);
      await waitFor(() => Boolean(finish));
      if (guard === "detach") await h.manager.detach(); else sessionId = guard === "session" ? "session-two" : "retired";
      finish();
      await pending;
      assert.equal(h.notices("steer").length, 0);
      if (guard !== "detach") assert.equal(h.feedback.at(-1)!.level, "info");
    } finally { finish?.(); await h.close(); }
  });
}
