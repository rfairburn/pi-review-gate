/**
 * Issue #222 (partial #215 integration): the shared non-model-initiated
 * subtask-launch delivery abstraction. Both successful human /subtask-add
 * admissions and successful scheduled-subtask admissions ride through this
 * one module — the same lane, bounds, redaction, origin metadata, and causal
 * ordering — so these tests pin the shared contract, the gate that keeps a
 * fast completion behind the notice, and the human command wiring.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import {
  launchNoticeGate,
  deliverSubtaskLaunchNotice,
  formatSubtaskLaunchNotice,
  LAUNCH_NOTICE_DELIVERY_TIMEOUT_MS,
  SUBTASK_LAUNCH_NOTICE_MAX_CHARS,
  type SubtaskLaunchNotice,
} from "../src/execution/launch-notice";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { ExecutionToolManager, EXECUTION_TOOL_NAMES } from "../src/execution/tool";
import { createState } from "../src/state";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";

const scheduledNotice: SubtaskLaunchNotice = {
  origin: "scheduled",
  executionId: "exec-1",
  kind: "execute",
  tasks: [{ taskId: "task-1", title: "Scheduled execute task task-nightly: Nightly docs check" }],
  scheduled: {
    entryId: "task-nightly",
    entryName: "Nightly docs check",
    dueAt: new Date(2024, 0, 15, 2, 30),
    cron: "30 2 * * *",
  },
};

const humanNotice: SubtaskLaunchNotice = {
  origin: "human-command",
  executionId: "exec-2",
  kind: "research",
  tasks: [{ taskId: "task-2", title: "Summarize upstream releases" }],
};

interface DeliveredMessage {
  customType?: string;
  content: string;
  details?: {
    executionId?: string;
    origin?: string;
    kind?: string;
    tasks?: Array<{ taskId: string; title: string }>;
    scheduled?: { entryId: string };
  };
}
interface Delivery {
  deliverAs: string;
  triggerTurn: boolean;
}
interface MessageWithDelivery extends DeliveredMessage {
  delivery?: Delivery;
}

function recordingPi() {
  const messages: Array<MessageWithDelivery> = [];
  return {
    messages,
    pi: {
      sendMessage: (message: DeliveredMessage, delivery: Delivery) => {
        messages.push({ ...message, delivery });
      },
    },
  };
}

test("the shared launch notice formats both origins with origin metadata and only a concise acknowledgement cue", () => {
  const scheduled = formatSubtaskLaunchNotice(scheduledNotice);
  assert.match(scheduled.content, /^Scheduled task task-nightly \(Nightly docs check\) was admitted as execution exec-1 \(execute\)\./);
  assert.match(scheduled.content, /Due occurrence: 2024-01-15 02:30 .* for cron "30 2 \* \* \*"\./);
  assert.match(scheduled.content, /- task-1 · Scheduled execute task task-nightly: Nightly docs check/);
  assert.match(scheduled.content, /^Acknowledge briefly\.$/m, "the only prose is the short acknowledgement cue");
  assert.ok(!scheduled.content.includes("dispatched"), "the notice says admitted, never a dispatched/running state");
  assert.equal(scheduled.details.origin, "scheduled");
  assert.equal(scheduled.details.executionId, "exec-1");
  assert.equal((scheduled.details.scheduled as { entryId: string }).entryId, "task-nightly");

  const human = formatSubtaskLaunchNotice(humanNotice);
  assert.match(human.content, /^A new background research execution exec-2 was admitted from a human \/subtask-add command\./);
  assert.ok(!human.content.includes("cron"), "a human notice carries no schedule identity");
  assert.equal(human.details.origin, "human-command");
  assert.equal(human.details.kind, "research");
  // Both origins share the same concise close from the same mechanism.
  assert.match(scheduled.content, /Acknowledge briefly\./);
  assert.match(human.content, /Acknowledge briefly\./);
});

test("the shared launch notice carries no narrative boilerplate", () => {
  for (const formatted of [formatSubtaskLaunchNotice(scheduledNotice), formatSubtaskLaunchNotice(humanNotice)]) {
    assert.ok(!formatted.content.includes("This notice only reports the launch"));
    assert.ok(!formatted.content.includes("No outcome is known"));
    assert.ok(!formatted.content.includes("ordinary subtask notifications"));
    assert.ok(!formatted.content.includes("Do not treat this launch"));
    assert.ok(!formatted.content.includes("duplicate"));
    assert.ok(!formatted.content.includes("No tool action is necessary"));
    assert.ok(!formatted.content.includes("quiet/noisy"));
    assert.ok(!formatted.content.includes("triggered a turn"));
    assert.ok(!formatted.content.includes("empty response"));
  }
});

test("a human add-to-existing notice keeps the factual added-task ids line", () => {
  const notice = formatSubtaskLaunchNotice({
    ...humanNotice,
    tasks: [{ taskId: "task-9", title: "Follow-up scan" }],
    addedTaskIds: ["task-9"],
  });
  assert.match(notice.content, /Added in this submission: task-9/);
  assert.match(notice.content, /^Acknowledge briefly\.$/m);
});

test("the shared launch notice redacts sensitive token material from model-controlled fields", () => {
  const notice = formatSubtaskLaunchNotice({
    ...humanNotice,
    tasks: [{ taskId: "task-3", title: "Run with GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890" }],
  });
  assert.ok(!notice.content.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"), `content was redacted: ${notice.content}`);
  assert.ok(((notice.details.tasks as Array<{ title: string }>)[0]!.title).includes("[REDACTED]"));
});

test("title truncation cannot expose a credential fragment", () => {
  const notice = formatSubtaskLaunchNotice({
    ...humanNotice,
    tasks: [{ taskId: "task-3", title: `${"x".repeat(93)} sk-ABCDEFGHIJKLMN` }],
  });
  assert.ok(!notice.content.includes("sk-ABCDEFGHIJK"));
  assert.ok(notice.content.includes("[REDACTED]"));
});

test("a credential straddling the title bound is redacted before the cut, never leaked as a fragment", () => {
  // The token starts inside the 120-character bound and would be CUT by it:
  // bounding first would leave "sk-ABCDEF" (too short to match the token
  // pattern) as plaintext; redacting first removes the whole credential.
  const straddling = `${"x".repeat(105)} sk-ABCDEFGHIJKLMN`;
  assert.ok(straddling.length > 120, `the credential crosses the title bound: ${straddling.length}`);
  const notice = formatSubtaskLaunchNotice({
    ...humanNotice,
    tasks: [{ taskId: "task-4", title: straddling }],
  });
  const fragment = "sk-ABCDEF"; // the fragment bound-first would leak at the cut
  assert.ok(!notice.content.includes(fragment), `no credential fragment in the content: ${notice.content}`);
  assert.ok(notice.content.includes("[REDACTED]"), `the whole credential was redacted before bounding: ${notice.content}`);
  const detailsTitle = (notice.details.tasks as Array<{ title: string }>)[0]!.title;
  assert.ok(!detailsTitle.includes(fragment), "the bounded details title carries no fragment either");
});

test("the shared launch notice bounds a hostile task title and the whole content", () => {
  const notice = formatSubtaskLaunchNotice({ ...humanNotice, tasks: [{ taskId: "task-4", title: "x".repeat(5_000) }] });
  assert.ok(notice.content.length <= SUBTASK_LAUNCH_NOTICE_MAX_CHARS + 10, `content bounded, got ${notice.content.length}`);
  const title = (notice.details.tasks as Array<{ title: string }>)[0]!.title;
  assert.ok(title.length <= 200, "the details title is bounded");
  assert.ok(title.endsWith("…[truncated]"), "the bounded title carries the truncation marker");
});

test("the shared launch notice is delivered on the non-interrupting triggered-turn lane", async () => {
  const { pi, messages } = recordingPi();
  assert.equal(await deliverSubtaskLaunchNotice(pi, scheduledNotice), "delivered");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.customType, "pi-review-subtask-launch");
  assert.deepEqual(messages[0]!.delivery, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(messages[0]!.details?.origin, "scheduled");

  // A host without a model message channel is honestly "unavailable" — the
  // caller reports the limitation; never a silent success claim.
  assert.equal(await deliverSubtaskLaunchNotice({}, scheduledNotice), "unavailable");
  const rejecting = { sendMessage: () => { throw new Error("host rejected"); } };
  assert.equal(await deliverSubtaskLaunchNotice(rejecting, scheduledNotice), "unavailable");
  assert.ok(LAUNCH_NOTICE_DELIVERY_TIMEOUT_MS > 0);
});

test("a host whose send promise never settles is bounded, uncertain, and never unhandled", async () => {
  const deliveries: Array<DeliveredMessage> = [];
  let settleSend: (() => void) | undefined;
  const slow = {
    sendMessage: (message: DeliveredMessage) => {
      deliveries.push(message);
      return new Promise<void>((resolve) => {
        settleSend = resolve;
      });
    },
  };
  const outcome = await deliverSubtaskLaunchNotice(slow, scheduledNotice, { timeoutMs: 30 });
  assert.equal(outcome, "uncertain", "an unacknowledged send is uncertain — it may still arrive");
  assert.equal(deliveries.length, 1, "the send itself was attempted");
  // A late acknowledgement is suppressed internally; no unhandled rejection
  // and no retroactive delivered claim must surface.
  settleSend!();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // A DEFINITE rejection stays "unavailable" (definitely not delivered).
  const rejectingLate = { sendMessage: () => Promise.reject(new Error("host rejected the queued send")) };
  assert.equal(await deliverSubtaskLaunchNotice(rejectingLate, scheduledNotice, { timeoutMs: 5_000 }), "unavailable");
});

test("a host whose send promise settles inside the bound reports the attempt outcome", async () => {
  const deliveries: Array<DeliveredMessage> = [];
  const delayed = {
    sendMessage: (message: DeliveredMessage) => {
      deliveries.push(message);
      return new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });
    },
  };
  assert.equal(await deliverSubtaskLaunchNotice(delayed, scheduledNotice, { timeoutMs: 5_000 }), "delivered");
  assert.equal(deliveries.length, 1);

  const rejectingLate = { sendMessage: () => Promise.reject(new Error("host rejected the queued send")) };
  assert.equal(await deliverSubtaskLaunchNotice(rejectingLate, scheduledNotice, { timeoutMs: 5_000 }), "unavailable");
});

test("the launch-notice gate holds until released and no result notification is pre-released", async () => {
  const gate = launchNoticeGate();
  let released = false;
  void gate.pending.then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(released, false, "the gate holds until an explicit release after the delivery attempt");
  gate.resolve();
  await gate.pending;
  assert.equal(released, true);
});

test("a fast-settling subtask cannot deliver its outcome before the launch notice gate resolves", async () => {
  const controllerHarness = await fastExecutorHarness("gate");
  try {
    const gate = launchNoticeGate();
    const started = await controllerHarness.controller.start([{
      title: "notice gate ordering",
      instructions: "write notice-ordering.txt",
      acceptanceCriteria: ["notice-ordering.txt exists"],
    }], "execute", undefined, { launchNoticeGate: gate.pending });
    // The subtask settles while the gate is still pending.
    await waitFor(() => controllerHarness.controller.inspect(started.executionId).tasks[0]!.state === "landed", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const eventsBeforeNotice = controllerHarness.messages
      .filter((message) => message.customType === "pi-review-subtask-event")
      .filter((message) => message.details?.executionId === started.executionId);
    assert.equal(eventsBeforeNotice.length, 0, "result wakes are held behind the pending notice gate with no timeout that can pre-release them");

    // The bounded delivery attempt (a hung host cannot strand notifications
    // forever) runs while the wake stays held; the gate releases only after
    // the attempt settles.
    const delivery = deliverSubtaskLaunchNotice(controllerHarness.pi, {
      origin: "scheduled",
      executionId: started.executionId,
      kind: "execute",
      tasks: [{ taskId: started.tasks[0]!.taskId, title: started.tasks[0]!.definition.title }],
      scheduled: { entryId: "entry-1", entryName: "Entry", dueAt: new Date(0), cron: "* * * * *" },
    }, { timeoutMs: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(controllerHarness.messages.filter((message) => message.customType === "pi-review-subtask-event").length, 0, "the wake stays held while the delivery attempt runs");
    assert.equal(await delivery, "delivered");
    gate.resolve();
    await waitFor(() => controllerHarness.messages.some((message) =>
      message.customType === "pi-review-subtask-event"
      && message.details?.executionId === started.executionId), 30_000);
    const launchIndex = controllerHarness.messages.findIndex((message) => message.customType === "pi-review-subtask-launch");
    const eventIndex = controllerHarness.messages.findIndex((message) =>
      message.customType === "pi-review-subtask-event" && message.details?.executionId === started.executionId);
    assert.ok(launchIndex >= 0, "the launch notice was delivered");
    assert.ok(eventIndex > launchIndex, "no subtask event preceded the shared launch notice");
  } finally {
    await controllerHarness.close();
  }
});

test("a human /subtask-add delivers the shared launch notice; a fast outcome follows it", async () => {
  const harness = await managerHarness("human-notice", "notice-ordering-human.txt");
  try {
    const handler = await harness.subtaskAddHandler();
    assert.ok(handler, "/subtask-add was registered");
    // The command result is formatted as a UI notice by the host wrapper; the
    // model-facing handles are carried by the shared launch notice itself.
    await handler("write notice-ordering-human.txt", { scopedModels: [] });
    await waitFor(() => harness.messages.some((message) => message.customType === "pi-review-subtask-launch"), 30_000);
    await waitFor(() => harness.messages.some((message) =>
      message.customType === "pi-review-subtask-event"
      && /COMPLETE/.test(message.content)), 30_000);
    const launch = harness.messages.find((message) => message.customType === "pi-review-subtask-launch")!;
    assert.equal(launch.details?.origin, "human-command");
    assert.equal(launch.details?.kind, "execute");
    assert.ok(launch.details?.executionId, "the notice carries the execution handle");
    const executionId = launch.details!.executionId!;
    assert.ok((launch.details!.tasks as Array<{ taskId: string }>)[0]?.taskId, "the notice carries the task handle");
    assert.match(launch.content, /from a human \/subtask-add command\./);
    const launchIndex = harness.messages.findIndex((message) => message.customType === "pi-review-subtask-launch");
    const completionIndex = harness.messages.findIndex((message) =>
      message.customType === "pi-review-subtask-event"
      && message.details?.executionId === executionId
      && /COMPLETE/.test(message.content));
    assert.ok(completionIndex > launchIndex, "the execution outcome followed the human launch notice");
  } finally {
    await harness.close();
  }
});

// ── fast-executor harnesses ──────────────────────────────────────────────────

interface MessageWithDelivery extends DeliveredMessage {
  delivery?: Delivery;
}

interface ManagerHarness {
  messages: Array<MessageWithDelivery>;
  close(): Promise<void>;
  subtaskAddHandler(): Promise<((args: string, ctx: unknown) => Promise<unknown> | unknown) | undefined>;
}

async function fastExecutorHarness(unique: string): Promise<{
  controller: BackgroundExecutionController;
  pi: { sendMessage: (message: DeliveredMessage, delivery: Delivery) => void };
  messages: Array<MessageWithDelivery>;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-launch-notice-${unique}-`));
  await initGitRepo(root);
  const executor = join(root, `executor-${unique}.cjs`);
  await writeFile(executor, [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(join(root, "notice-ordering.txt"))},'done\\n');`,
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'notice-session'}));",
    "console.log(JSON.stringify({type:'assistant',text:'done'}));",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      [`notice-${unique}`]: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
      }
    },
    execution: {
      maxWorkers: 2,
      workerResources: { "default": { selection: { source: "external", id: `notice-${unique}` }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "never",
  });
  const messages: Array<MessageWithDelivery> = [];
  const pi = {
    sendMessage: (message: DeliveredMessage, delivery: Delivery) => {
      messages.push({ ...message, delivery });
    },
  };
  const controller = new BackgroundExecutionController({
    pi,
    config,
    state: createState(),
    cwd: () => root,
  });
  return {
    controller,
    pi,
    messages,
    close: async () => {
      await controller.shutdown().catch(() => undefined);
      await controller.detach().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function managerHarness(unique: string, outputName: string): Promise<ManagerHarness> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-launch-notice-${unique}-`));
  await initGitRepo(root);
  const executor = join(root, `executor-${unique}.cjs`);
  await writeFile(executor, [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(join(root, outputName))},'done\\n');`,
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'notice-human-session'}));",
    "console.log(JSON.stringify({type:'assistant',text:'done'}));",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      [`notice-${unique}`]: {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
      }
    },
    execution: {
      maxWorkers: 2,
      workerResources: { "default": { selection: { source: "external", id: `notice-${unique}` }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "never",
  });
  const registeredCommands = new Map<string, (args: string, ctx: unknown) => Promise<unknown> | unknown>();
  const messages: Array<MessageWithDelivery> = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => unknown }) => {
      registeredCommands.set(name, options.handler);
    },
    setToolActive: () => {},
    getActiveTools: () => ["read", "bash", ...Object.values(EXECUTION_TOOL_NAMES)],
    sendMessage: (message: MessageWithDelivery, delivery?: Delivery) => {
      messages.push({ ...message, delivery });
    },
  };
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => root,
  });
  manager.sync();
  return {
    messages,
    close: async () => {
      await manager.shutdown().catch(() => undefined);
      await manager.detach().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
    subtaskAddHandler: async () => {
      for (let attempt = 0; attempt < 100 && !registeredCommands.has("subtask-add"); attempt++) {
        if (registeredCommands.has("subtask-add")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        manager.sync();
      }
      return registeredCommands.get("subtask-add");
    },
  };
}