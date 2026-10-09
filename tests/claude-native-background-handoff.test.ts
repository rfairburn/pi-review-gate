/**
 * Issue #218: native Claude background-task handoff before settlement.
 *
 * These regressions drive the real `ClaudeExecutorAdapter` against a hermetic
 * in-process fake of the installed Agent SDK streaming `Query`. No provider,
 * network, or CLI process is involved: the fake emits the documented
 * `system/background_tasks_changed` level signal, assistant `tool_use` blocks,
 * `tool_result` blocks, and terminal result messages exactly as the adapter
 * consumes them, and records every user message the SDK pulled.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeExecutorConfig } from "../src/config";
import {
  ClaudeExecutorAdapter,
  type ClaudeExecutorDependencies,
} from "../src/execution/adapters/claude-cli";
import type { ExecutorLiveControl, ExecutorTurn } from "../src/execution/types";

const SESSION_ID = "claude-background-session";

/** Records every user message the fake SDK pulls, and emits SDK messages on demand. */
class ClaudeFakeHarness {
  private readonly output = new AsyncOutputQueue();
  private readonly outputIterator = this.output[Symbol.asyncIterator]();
  private readonly inputs: SDKUserMessage[] = [];
  private readonly inputWaiters: Array<() => void> = [];
  private closed = false;
  /** Invoked (before the receipt) for every native `interrupt()` request. */
  onInterrupt: ((input: SDKUserMessage | undefined) => void | Promise<void>) | undefined;
  /** When set, every native `interrupt()` request rejects with this error. */
  interruptError: Error | undefined;

  private readonly queryObject: Query = {
    next: () => this.outputIterator.next(),
    return: async () => ({ value: undefined, done: true }),
    throw: async (error?: unknown) => { throw error; },
    initializationResult: async () => ({
      commands: [],
      agents: [],
      output_style: "",
      available_output_styles: [],
      models: [],
      account: {} as never,
    }),
    interrupt: async () => {
      await this.onInterrupt?.(this.inputs.at(-1));
      if (this.interruptError) throw this.interruptError;
      return { still_queued: [] };
    },
    close: () => this.closeStream(),
  } as unknown as Query;

  readonly query: typeof import("@anthropic-ai/claude-agent-sdk")["query"] = ((params: {
    prompt: AsyncIterable<SDKUserMessage>;
  }) => {
    void this.consumeInputs(params.prompt);
    // Share the single output iterator so the query surface stays one stream.
    return {
      ...this.queryObject,
      next: () => this.outputIterator.next(),
      [Symbol.asyncIterator]() { return this as unknown as AsyncIterator<SDKMessage>; },
    } as unknown as Query;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];

  /** User messages the SDK pulled, in order. */
  pulledInputs(): readonly SDKUserMessage[] {
    return this.inputs;
  }

  emit(message: unknown): void {
    this.output.push(message as SDKMessage);
  }

  closeStream(): void {
    this.closed = true;
    this.output.close();
  }

  get streamClosed(): boolean {
    return this.closed;
  }

  async waitForInputs(count: number, what = `${count} SDK input message(s)`): Promise<void> {
    await waitUntil(() => this.inputs.length >= count, `the adapter to enqueue ${what}`);
  }

  private async consumeInputs(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) {
      this.inputs.push(message);
      for (const resolve of this.inputWaiters.splice(0)) resolve();
    }
  }
}

class AsyncOutputQueue implements AsyncIterable<SDKMessage> {
  private readonly values: SDKMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private closed = false;

  push(value: SDKMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
      },
    };
  }
}

function initMessage(): SDKMessage {
  return { type: "system", subtype: "init", session_id: SESSION_ID, uuid: "system-init", tools: [], model: "mock" } as unknown as SDKMessage;
}

/** The documented REPLACE level signal for the full live background task set. */
function backgroundLevel(taskIds: readonly string[]): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: taskIds.map((taskId) => ({ task_id: taskId, task_type: "shell", description: `job ${taskId}` })),
    uuid: `level-${taskIds.join("-") || "empty"}`,
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function malformedBackgroundLevel(): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "level-malformed",
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function unreadableBackgroundLevel(): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_type: "shell", description: "missing task id" }],
    uuid: "level-unreadable",
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

function backgroundBashLaunch(id: string, command = "npm test"): SDKMessage {
  return {
    type: "assistant",
    session_id: SESSION_ID,
    uuid: `assistant-${id}`,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command, run_in_background: true } }] },
  } as unknown as SDKMessage;
}

function toolResult(id: string, content: string, isError = false): SDKMessage {
  return {
    type: "user",
    session_id: SESSION_ID,
    uuid: `tool-result-${id}`,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  } as unknown as SDKMessage;
}

function successResult(userMessageUuid: string, text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    user_message_uuid: userMessageUuid,
    session_id: SESSION_ID,
    uuid: `result-${userMessageUuid}`,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

function errorResult(userMessageUuid: string, errors: string[]): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors,
    user_message_uuid: userMessageUuid,
    session_id: SESSION_ID,
    uuid: `result-error-${userMessageUuid}`,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

function createAdapter(
  harness: ClaudeFakeHarness,
  config: Partial<ClaudeExecutorConfig> = {},
  dependencies: ClaudeExecutorDependencies = {},
): ClaudeExecutorAdapter {
  return new ClaudeExecutorAdapter(
    { id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet", ...config },
    { loadSdk: async () => ({ query: harness.query }), ...dependencies },
  );
}

interface RunContext {
  readonly dir: string;
  readonly artifactDir: string;
  readonly harness: ClaudeFakeHarness;
  readonly activity: string[];
  liveControl(): ExecutorLiveControl | undefined;
  run: Promise<ExecutorTurn>;
}

async function startRun(options: {
  harness: ClaudeFakeHarness;
  config?: Partial<ClaudeExecutorConfig>;
  dependencies?: ClaudeExecutorDependencies;
  prompt?: string;
  signal?: AbortSignal;
} ): Promise<RunContext> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-background-"));
  const artifactDir = join(dir, "artifacts");
  await mkdir(artifactDir);
  const activity: string[] = [];
  let control: ExecutorLiveControl | undefined;
  const adapter = createAdapter(options.harness, options.config, options.dependencies);
  const run = adapter.run({
    cwd: dir,
    prompt: options.prompt ?? "do the task",
    artifactDir,
    turn: 1,
    ...(options.signal ? { signal: options.signal } : {}),
    onUpdate: (message) => activity.push(message),
    onLiveControl: (next) => { control = next; },
  });
  await options.harness.waitForInputs(1, "the task prompt");
  return { dir, artifactDir, harness: options.harness, activity, liveControl: () => control, run };
}

async function stopRun(context: RunContext): Promise<void> {
  if (!context.harness.streamClosed) context.harness.closeStream();
  await context.run.catch(() => undefined);
  await rm(context.dir, { recursive: true, force: true });
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
}

/** Whether the run promise settled within a bounded window, without awaiting it. */
async function settledWithin(run: Promise<unknown>, windowMs: number): Promise<boolean> {
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, windowMs));
  return settled;
}

test("Claude holds a successful turn result while native background work is live, then inspects before settling (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundBashLaunch("bash-1"));
    harness.emit(toolResult("bash-1", "Command running in background with ID: task-1", false));
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));

    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the held-result activity");
    assert.equal(await settledWithin(context.run, 50), false, "a live native background task must keep the run open");
    assert.ok(context.liveControl(), "live control stays published while the background wait runs");

    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the background inspection turn");
    const inspection = harness.pulledInputs()[1]!;
    assert.notEqual(inspection.uuid, promptUuid, "the inspection turn is a distinct completion target");
    assert.match(String((inspection.message as { content?: unknown }).content), /Inspect the completed task results/);

    harness.emit(successResult(inspection.uuid!, "inspected background results"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "inspected background results");
    assert.equal(result.aborted, false);
    assert.equal(harness.pulledInputs().length, 2, "exactly one inspection turn is requested");
  } finally {
    await stopRun(context);
  }
});

test("Claude does not settle on an untagged automatic result while an inspection turn is outstanding (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the background inspection turn");
    // An untagged automatic completion-turn result is ambiguous, so it must not
    // stand in for the inspection turn's own tagged result.
    const untagged = successResult("automatic-uuid", "automatic turn text") as unknown as Record<string, unknown>;
    delete untagged.user_message_uuid;
    harness.emit(untagged);
    assert.equal(await settledWithin(context.run, 40), false, "an untagged automatic result must not settle a pending inspection");

    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "inspected background results"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "inspected background results");
  } finally {
    await stopRun(context);
  }
});

test("Claude inspects an already-drained fast background job exactly once (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    // The job starts and completes before the turn result: the level signal
    // reports it and then reports the empty set.
    harness.emit(backgroundLevel(["task-fast"]));
    harness.emit(backgroundLevel([]));
    harness.emit(successResult(promptUuid, "first turn text"));

    await harness.waitForInputs(2, "the background inspection turn");
    assert.equal((await settledWithin(context.run, 30)), false, "a drained background job still earns an inspection turn");
    const inspection = harness.pulledInputs()[1]!;
    harness.emit(successResult(inspection.uuid!, "checked the fast job"));

    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(harness.pulledInputs().length, 2, "an inspected fast job must not repeat the follow-up");
  } finally {
    await stopRun(context);
  }
});

test("Claude inspects a successful launch covered only by drained membership (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundBashLaunch("bash-fast"));
    harness.emit(toolResult("bash-fast", "Background task completed", false));
    // The authoritative membership is empty, but the observed launch still
    // requires inspection even without a nonempty payload.
    harness.emit(backgroundLevel([]));
    harness.emit(successResult(promptUuid, "first turn text"));

    await harness.waitForInputs(2, "the fast-job inspection turn");
    assert.equal(await settledWithin(context.run, 30), false);
    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "checked fast-job results"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "checked fast-job results");
    assert.equal(harness.pulledInputs().length, 2);
  } finally {
    await stopRun(context);
  }
});

test("Claude settles a turn that never observed native background work unchanged (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(successResult(promptUuid, "plain answer"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "plain answer");
    assert.equal(harness.pulledInputs().length, 1, "no background work means no inspection turn");
  } finally {
    await stopRun(context);
  }
});

test("Claude waits for new background work started by the inspection turn (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the first hold");

    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the first inspection turn");
    // The inspection turn launches genuinely new background work and returns
    // while it is still live: it must be waited for and inspected too.
    harness.emit(backgroundLevel(["task-2"]));
    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "inspected the first job"));
    await waitUntil(
      () => context.activity.filter((line) => /turn result held/.test(line)).length >= 2,
      "the second hold",
    );

    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(3, "the second inspection turn");
    harness.emit(successResult(harness.pulledInputs()[2]!.uuid!, "final text"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "final text");
    assert.equal(harness.pulledInputs().length, 3);
  } finally {
    await stopRun(context);
  }
});

test("Claude keeps a failed turn result terminal instead of masking it behind a later turn (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(errorResult(promptUuid, ["Claude API 429: Rate limited"]));
    const result = await context.run;
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "provider");
    assert.match(result.failure?.message ?? "", /Rate limited/);
    assert.equal(harness.pulledInputs().length, 1, "a failed turn result is not held for an inspection turn");
  } finally {
    await stopRun(context);
  }
});

test("Claude keeps the steering target's completion ownership while background work drains (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    const control = context.liveControl();
    assert.ok(control, "live control is published while the background wait runs");
    const steered = await control.steer("try the other approach", "instruction-1");
    assert.equal(steered.status, "acknowledged");
    await harness.waitForInputs(2, "the steering instruction");

    // The background drains, but the steering turn owns completion now: the
    // inspection turn is deferred until that target's own result is handled.
    harness.emit(backgroundLevel([]));
    assert.equal(await settledWithin(context.run, 30), false);
    harness.emit(successResult(steered.turnId!, "steered turn text"));
    await harness.waitForInputs(3, "the post-steering inspection turn");
    harness.emit(successResult(harness.pulledInputs()[2]!.uuid!, "final after steering"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "final after steering");
    assert.equal(harness.pulledInputs().length, 3);
  } finally {
    await stopRun(context);
  }
});

test("Claude keeps a failed steering result terminal when background work drained first (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    const control = context.liveControl();
    assert.ok(control);
    const steered = await control.steer("switch approach", "instruction-3");
    assert.equal(steered.status, "acknowledged");
    await harness.waitForInputs(2, "the steering instruction");

    // The drain lands before the steered turn finishes: the inspection turn must
    // not replace the steered target, so its failure stays the terminal outcome
    // instead of being buffered behind a later successful inspection.
    harness.emit(backgroundLevel([]));
    harness.emit(errorResult(steered.turnId!, ["Claude API 500: overloaded"]));
    const result = await context.run;
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "provider");
    assert.match(result.failure?.message ?? "", /overloaded/);
    assert.equal(harness.pulledInputs().length, 2, "no inspection turn replaces the failed steered target");
  } finally {
    await stopRun(context);
  }
});

test("Claude does not let an untagged superseded result bypass a steering retarget (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");
    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the background inspection turn");

    const control = context.liveControl();
    assert.ok(control);
    const steered = await control.steer("switch approach", "instruction-2");
    assert.equal(steered.status, "acknowledged");
    await harness.waitForInputs(3, "the steering instruction");

    const untagged = successResult("superseded", "superseded text") as unknown as Record<string, unknown>;
    delete untagged.user_message_uuid;
    harness.emit(untagged);
    assert.equal(await settledWithin(context.run, 40), false, "an untagged superseded result must not settle the steered target");

    // The steered target succeeded, but it superseded the inspection turn that
    // was already running: it earns a replacement inspection rather than
    // settling with no completed inspection turn (#218).
    harness.emit(successResult(steered.turnId!, "steered final text"));
    await harness.waitForInputs(4, "the replacement inspection turn");
    assert.equal(await settledWithin(context.run, 30), false, "the steered success must not settle an interrupted inspection");
    harness.emit(successResult(harness.pulledInputs()[3]!.uuid!, "replacement inspection text"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "replacement inspection text");
  } finally {
    await stopRun(context);
  }
});

test("Claude requires a replacement inspection after interrupting steering supersedes one (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");
    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the first inspection turn");
    const inspectionUuid = harness.pulledInputs()[1]!.uuid!;

    const control = context.liveControl();
    assert.ok(control);
    const steered = await control.steer("switch approach", "instruction-5", { interrupt: true });
    assert.equal(steered.status, "acknowledged");
    await harness.waitForInputs(3, "the steering instruction");

    // Interrupting steering superseded the in-flight inspection turn.
    harness.emit(errorResult(inspectionUuid, ["interrupted"]));
    harness.emit(successResult(steered.turnId!, "steered text"));
    await harness.waitForInputs(4, "the replacement inspection turn");
    assert.equal(await settledWithin(context.run, 30), false, "the steered success must not settle without an inspection");
    harness.emit(successResult(harness.pulledInputs()[3]!.uuid!, "replacement inspection text"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "replacement inspection text");
  } finally {
    await stopRun(context);
  }
});

test("Claude resumes inspection when rejected steering restored a drained held target (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    // Exactly one original success result exists: it is held, never buffered.
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    const control = context.liveControl();
    assert.ok(control);
    let releaseInterrupt!: () => void;
    const interruptPending = new Promise<void>((resolvePromise) => { releaseInterrupt = resolvePromise; });
    harness.onInterrupt = () => interruptPending;
    harness.interruptError = new Error("interrupt rejected");
    const steering = control.steer("try the other approach", "instruction-6", { interrupt: true });
    // Membership drains while the interrupt is still pending and steering owns
    // completion; the held target's obligation must survive that ownership change.
    harness.emit(backgroundLevel([]));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    releaseInterrupt();
    const steered = await steering;
    assert.equal(steered.status, "failed");
    assert.equal(await settledWithin(context.run, 40), false, "the restored target's drain obligation must resume, not strand");

    // No duplicate original result is emitted: the retained obligation alone must
    // request the inspection turn.
    await harness.waitForInputs(2, "the resumed inspection turn");
    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "resumed inspection text"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "resumed inspection text");
  } finally {
    await stopRun(context);
  }
});

test("Claude re-gates a buffered result restored by rejected steering interruption (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    const control = context.liveControl();
    assert.ok(control);
    let releaseInterrupt!: () => void;
    const interruptPending = new Promise<void>((resolvePromise) => { releaseInterrupt = resolvePromise; });
    harness.onInterrupt = () => interruptPending;
    harness.interruptError = new Error("interrupt rejected");
    const steering = control.steer("try the other approach", "instruction-4", { interrupt: true });
    // The steer has retargeted completion; the original success result arrives
    // while its interrupt is still pending and is buffered as a foreign result.
    harness.emit(successResult(promptUuid, "original success during steering"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    releaseInterrupt();
    const steered = await steering;
    assert.equal(steered.status, "failed");
    assert.equal(await settledWithin(context.run, 40), false, "the restored result must re-enter the background gate");

    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the inspection turn after the restored result");
    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "inspected after rejected steering"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "inspected after rejected steering");
  } finally {
    await stopRun(context);
  }
});

test("Claude explicit interruption terminates a background hold as an interruption (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness, dependencies: { interruptSettleMs: 100 } });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    const control = context.liveControl();
    assert.ok(control);
    const acknowledgement = await control.interrupt();
    assert.equal(acknowledgement.status, "acknowledged");
    const result = await context.run;
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.equal(result.code, 0, "interruption is classified by its failure category, not the exit code");
  } finally {
    await stopRun(context);
  }
});

test("Claude runtime cancellation ends a background hold as a non-success interruption (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const controller = new AbortController();
  const context = await startRun({ harness, signal: controller.signal });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    controller.abort(new Error("interrupt_as_failure"));
    const result = await context.run;
    assert.equal(result.aborted, true, "a cancellation during a background hold never normalizes");
    assert.equal(result.timedOut, false);
  } finally {
    await stopRun(context);
  }
});

test("Claude keeps the configured timeout as an absolute bound over a never-draining background hold (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness, config: { timeoutMs: 150 } });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-never" + "-drains"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    const result = await context.run;
    assert.equal(result.timedOut, true, "the existing timeout is the absolute bound; it is never suspended");
    assert.equal(harness.pulledInputs().length, 1);
  } finally {
    await stopRun(context);
  }
});

test("Claude fails closed when the SDK stream ends while native background work is outstanding (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");

    // End of stream without the native completion transition.
    harness.closeStream();
    const result = await context.run;
    assert.equal(result.code, 1, "an unsettled background hold cannot normalize on success");
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /outstanding native background work/);
  } finally {
    await stopRun(context);
  }
});

test("Claude fails closed on a successful background launch the SDK never reported (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundBashLaunch("bash-unreported"));
    harness.emit(toolResult("bash-unreported", "Command running in background with ID: task-x", false));
    // No background_tasks_changed level signal ever arrives.
    harness.emit(successResult(promptUuid, "first turn text"));
    const result = await context.run;
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /never reported in a later background task membership update/);
  } finally {
    await stopRun(context);
  }
});

test("Claude fails closed when a fresh launch is covered only by stale level support (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    // A first background job that is reported and inspected successfully.
    harness.emit(backgroundBashLaunch("bash-1"));
    harness.emit(toolResult("bash-1", "Command running in background with ID: task-1", false));
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");
    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the inspection turn");

    // The inspection turn launches another background command without any fresh
    // membership evidence: the earlier level support must not discharge it.
    harness.emit(backgroundBashLaunch("bash-2"));
    harness.emit(toolResult("bash-2", "Command running in background with ID: task-2", false));
    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "inspection turn text"));
    const result = await context.run;
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /never reported in a later background task membership update/);
  } finally {
    await stopRun(context);
  }
});

test("Claude accepts a fresh launch that a later membership update reports (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundBashLaunch("bash-1"));
    harness.emit(toolResult("bash-1", "Command running in background with ID: task-1", false));
    harness.emit(backgroundLevel(["task-1"]));
    harness.emit(successResult(promptUuid, "first turn text"));
    await waitUntil(() => context.activity.some((line) => /turn result held/.test(line)), "the hold");
    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(2, "the inspection turn");

    harness.emit(backgroundBashLaunch("bash-2"));
    harness.emit(toolResult("bash-2", "Command running in background with ID: task-2", false));
    // Fresh membership evidence covers the new launch.
    harness.emit(backgroundLevel(["task-2"]));
    harness.emit(successResult(harness.pulledInputs()[1]!.uuid!, "interim inspection text"));
    await waitUntil(
      () => context.activity.filter((line) => /turn result held/.test(line)).length >= 2,
      "the second hold",
    );
    harness.emit(backgroundLevel([]));
    await harness.waitForInputs(3, "the second inspection turn");
    harness.emit(successResult(harness.pulledInputs()[2]!.uuid!, "verified inspection text"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.text, "verified inspection text");
  } finally {
    await stopRun(context);
  }
});

test("Claude does not treat a rejected background launch as in-flight (#218)", async () => {
  const harness = new ClaudeFakeHarness();
  const context = await startRun({ harness });
  try {
    const promptUuid = harness.pulledInputs()[0]!.uuid!;
    harness.emit(initMessage());
    harness.emit(backgroundBashLaunch("bash-rejected"));
    harness.emit(toolResult("bash-rejected", "Error: background execution is unavailable", true));
    harness.emit(successResult(promptUuid, "plain answer"));
    const result = await context.run;
    assert.equal(result.code, 0);
    assert.equal(result.failure, undefined);
    assert.equal(harness.pulledInputs().length, 1);
  } finally {
    await stopRun(context);
  }
});

test("Claude fails closed on malformed native background membership evidence (#218)", async () => {
  for (const [label, payload] of [["missing tasks", malformedBackgroundLevel()], ["unreadable task entry", unreadableBackgroundLevel()]] as const) {
    const harness = new ClaudeFakeHarness();
    const context = await startRun({ harness });
    try {
      const promptUuid = harness.pulledInputs()[0]!.uuid!;
      harness.emit(initMessage());
      harness.emit(payload);
      harness.emit(successResult(promptUuid, "first turn text"));
      const result = await context.run;
      assert.equal(result.code, 1, label);
      assert.equal(result.failure?.category, "protocol", label);
      assert.match(result.failure?.message ?? "", /malformed native background task membership/, label);
    } finally {
      await stopRun(context);
    }
  }
});
