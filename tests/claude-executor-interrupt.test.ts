import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeExecutorAdapter, type ClaudeExecutorDependencies } from "../src/execution/adapters/claude-cli";
import type { ExecutorLiveControl, ExecutorRequest, ExecutorTurn } from "../src/execution/types";
import { mockRootPid, readMockEvents, writeMockClaudeCli } from "./helpers/claude-mock-cli";

// Issue #310: a running Claude worker receives a non-interrupting (deferred)
// steer, then an explicit Interrupt arrives before the current work ends. The
// interrupt must settle promptly on its own terms instead of waiting for the
// superseded steering target's result or the executor timeout, surviving
// queued steering must not execute afterwards, and acknowledgement requires
// verified owned shutdown.

type Receipt = { still_queued: string[] } | undefined;

interface ScriptOptions {
  /** Native interrupt behavior. */
  interrupt:
    | { kind: "receipt"; receipt: (state: SessionState) => Receipt }
    | { kind: "never" }
    | { kind: "reject"; message: string };
  /** Terminal result the CLI emits after acknowledging the interrupt. */
  terminal?: "original-tagged" | "untagged" | "api-error-before-ack";
  /**
   * The CLI drain loop: once the interrupted turn ends, a queued steer that
   * survived the interrupt starts a model request and runs a tool.
   */
  drainSurvivors?: boolean;
  /** Spawn the configured command through the production spawn hook. */
  spawn?: boolean;
  /** Pull only the initial prompt; later input is never consumed. */
  pullInitialOnly?: boolean;
  /** The SDK stream fails with this message when the interrupt is requested. */
  streamFailureOnInterrupt?: string;
}

interface SessionState {
  inputs: SDKUserMessage[];
  closed: boolean;
  interruptCalls: number;
  postInterruptModelRequests: number;
  postInterruptToolStarts: number;
  spawned?: SpawnedProcess;
}

const quietUsage = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function interruptedResult(userMessageUuid: string | undefined, overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
    terminal_reason: "aborted_streaming",
    ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: quietUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-0000000003a0",
    session_id: "claude-session",
    ...overrides,
  } as unknown as SDKMessage;
}

function createScriptedSdk(script: ScriptOptions): { state: SessionState; query: typeof import("@anthropic-ai/claude-agent-sdk")["query"] } {
  const state: SessionState = {
    inputs: [],
    closed: false,
    interruptCalls: 0,
    postInterruptModelRequests: 0,
    postInterruptToolStarts: 0,
  };
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const output = new OutputQueue();
    const push = (message: SDKMessage) => { if (!state.closed) output.push(message); };
    if (script.spawn) {
      const options = params.options;
      state.spawned = options.spawnClaudeCodeProcess!({
        command: options.pathToClaudeCodeExecutable!,
        args: [],
        cwd: options.cwd,
        env: { ...process.env },
        signal: options.abortController!.signal,
      });
    }
    void (async () => {
      const prompt = script.pullInitialOnly
        ? { async *[Symbol.asyncIterator]() {
            const iterator = params.prompt[Symbol.asyncIterator]();
            const first = await iterator.next();
            if (!first.done) yield first.value;
            // Never pull again: later input stays undelivered.
            await new Promise<never>(() => undefined);
          } }
        : params.prompt;
      for await (const message of prompt) {
        state.inputs.push(message);
        if (state.inputs.length === 1) {
          push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
          // The original turn is running a long tool; steering queues behind it.
          push({
            type: "assistant",
            session_id: "claude-session",
            uuid: "assistant-1",
            parent_tool_use_id: null,
            message: { role: "assistant", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "sleep 600" } }] },
          } as unknown as SDKMessage);
        }
      }
    })();
    const drain = () => {
      if (!script.drainSurvivors) return;
      setTimeout(() => {
        if (state.closed) return;
        const survivor = state.inputs[1];
        state.postInterruptModelRequests += 1;
        state.postInterruptToolStarts += 1;
        push({
          type: "assistant",
          session_id: "claude-session",
          uuid: "assistant-survivor",
          parent_tool_use_id: null,
          message: { role: "assistant", content: [{ type: "tool_use", id: "bash-survivor", name: "Bash", input: { command: "touch after-interrupt" } }] },
        } as unknown as SDKMessage);
        push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "survivor ran",
          user_message_uuid: survivor?.uuid,
          session_id: "claude-session",
          uuid: "result-survivor",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0,
          usage: quietUsage,
          modelUsage: {},
          permission_denials: [],
        } as unknown as SDKMessage);
      }, 5);
    };
    const emitTerminal = () => {
      if (script.terminal === "original-tagged") push(interruptedResult(state.inputs[0]?.uuid));
      if (script.terminal === "untagged") push(interruptedResult(undefined));
      if (script.terminal) drain();
    };
    const iterator = output[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: async () => ({ value: undefined, done: true }),
      throw: async (error?: unknown) => { throw error; },
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
      interrupt: async () => {
        state.interruptCalls += 1;
        if (script.streamFailureOnInterrupt) output.fail(new Error(script.streamFailureOnInterrupt));
        if (script.terminal === "api-error-before-ack") {
          push(interruptedResult(undefined, {
            terminal_reason: "api_error",
            errors: ["API Error: 429 rate limit exceeded"],
          }));
        }
        if (script.interrupt.kind === "never") return new Promise<never>(() => undefined);
        if (script.interrupt.kind === "reject") throw new Error(script.interrupt.message);
        const receipt = script.interrupt.receipt(state);
        // The receipt is written before the interrupted turn's result.
        setTimeout(emitTerminal, 0);
        return receipt;
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        output.close();
      },
    } as unknown as Query;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
  return { state, query };
}

class OutputQueue implements AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = [];
  private waiters: Array<{ resolve: (value: IteratorResult<SDKMessage>) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private failure: Error | undefined;
  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }
  push(value: SDKMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter.resolve({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (this.failure) return Promise.reject(this.failure);
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    } };
  }
}

interface Harness {
  dir: string;
  control: ExecutorLiveControl;
  run: Promise<ExecutorTurn>;
  activity: string[];
  abort: AbortController;
  processEvents: string[];
}

async function startRun(
  // Undefined runs the installed Agent SDK.
  query: typeof import("@anthropic-ai/claude-agent-sdk")["query"] | undefined,
  dependencies: Partial<ClaudeExecutorDependencies> = {},
  config: { command?: string; args?: string[]; env?: Record<string, string> } = {},
  dirPrefix = "pi-review-claude-310-",
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), dirPrefix));
  const artifactDir = join(dir, "artifacts");
  await mkdir(artifactDir);
  let resolveControl!: (control: ExecutorLiveControl) => void;
  const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
  const activity: string[] = [];
  const processEvents: string[] = [];
  const abort = new AbortController();
  // The executor timeout stays at its long default: settlement must never
  // depend on it.
  const adapter = new ClaudeExecutorAdapter({
    id: "claude",
    adapter: "claude-cli",
    command: config.command ?? "claude",
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    model: "sonnet",
  }, { ...(query ? { loadSdk: async () => ({ query }) } : {}), ...dependencies });
  const request: ExecutorRequest = {
    cwd: dir,
    prompt: "initial",
    artifactDir,
    turn: 1,
    signal: abort.signal,
    onUpdate: (message) => activity.push(message),
    onLiveControl: (control) => { if (control) resolveControl(control); },
    onProcessStart: (owned) => { processEvents.push(`start:${owned.pid}`); },
    onProcessExit: (owned) => { processEvents.push(`exit:${owned.pid}`); },
  };
  const run = adapter.run(request);
  const control = await bounded(controlReady, 5_000, "live control was never published");
  return { dir, control, run, activity, abort, processEvents };
}

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} (bounded ${ms} ms)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

async function timed<T>(promise: Promise<T>, ms: number, label: string): Promise<{ value: T; elapsedMs: number }> {
  const started = Date.now();
  const value = await bounded(promise, ms, label);
  return { value, elapsedMs: Date.now() - started };
}

for (const terminal of ["original-tagged", "untagged"] as const) {
  test(`Claude explicit Interrupt after deferred steering settles on the ${terminal} interrupted result without the steering target (#310)`, async () => {
    const sdk = createScriptedSdk({ interrupt: { kind: "receipt", receipt: () => ({ still_queued: [] }) }, terminal });
    // A long settle bound proves settlement comes from the interrupted
    // result, not from the fallback.
    const harness = await startRun(sdk.query, { interruptSettleMs: 30_000 });
    try {
      const steer = await timed(harness.control.steer("deferred steering", "steer-310"), 1_000, "deferred steer did not return");
      assert.equal(steer.value.status, "acknowledged");
      assert.equal(sdk.state.inputs.length, 2);

      const interrupt = await timed(harness.control.interrupt(), 2_000, "explicit interrupt blocked on the superseded steering target");
      assert.equal(interrupt.value.status, "acknowledged");
      assert.match(interrupt.value.message, /acknowledged interruption; 0 message\(s\) remain queued/);
      assert.ok(interrupt.elapsedMs < 2_000);

      const result = await bounded(harness.run, 2_000, "run did not settle after explicit interrupt");
      assert.equal(result.aborted, true);
      assert.equal(result.failure?.category, "interruption");
      assert.equal(sdk.state.closed, true);
      // The interrupted turn is a truthful interruption, not an API failure.
      assert.ok(harness.activity.includes("model turn interrupted"));
      assert.equal(harness.activity.some((message) => message.startsWith("model failed")), false);
    } finally {
      await rm(harness.dir, { recursive: true, force: true });
    }
  });
}

test("Claude explicit Interrupt with no terminal output falls back within the bound and closes the session (#310)", async () => {
  const sdk = createScriptedSdk({ interrupt: { kind: "receipt", receipt: () => ({ still_queued: [] }) } });
  const harness = await startRun(sdk.query, { interruptSettleMs: 200 });
  try {
    assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
    const interrupt = await timed(harness.control.interrupt(), 3_000, "explicit interrupt waited past its bound");
    assert.equal(interrupt.value.status, "acknowledged");
    assert.match(interrupt.value.message, /no terminal result arrived within 200 ms, so the session was closed/);
    const result = await bounded(harness.run, 2_000, "run did not settle after the fallback");
    assert.equal(sdk.state.closed, true);
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.equal(result.failure?.message, "Claude query was interrupted.");
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt reports a never-settling SDK interrupt as failed after a bounded shutdown (#310)", async () => {
  const sdk = createScriptedSdk({ interrupt: { kind: "never" } });
  const harness = await startRun(sdk.query, { interruptSettleMs: 200 });
  try {
    assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
    const interrupt = await timed(harness.control.interrupt(), 3_000, "explicit interrupt hung on the SDK request");
    // No native acknowledgement is fabricated.
    assert.equal(interrupt.value.status, "failed");
    assert.match(interrupt.value.message, /did not acknowledge the interrupt within 200 ms; closed the session/);
    const result = await bounded(harness.run, 2_000, "run did not settle");
    assert.equal(sdk.state.closed, true);
    assert.equal(result.failure?.category, "interruption");
    assert.equal(harness.activity.includes("model turn interrupted"), false);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt keeps a rejected SDK interrupt's diagnostic and still shuts the session down (#310)", async () => {
  const sdk = createScriptedSdk({ interrupt: { kind: "reject", message: "synthetic interrupt transport failure" } });
  const harness = await startRun(sdk.query, { interruptSettleMs: 30_000 });
  try {
    assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
    const interrupt = await timed(harness.control.interrupt(), 2_000, "explicit interrupt hung after rejection");
    assert.equal(interrupt.value.status, "failed");
    assert.match(interrupt.value.message, /^synthetic interrupt transport failure; closed the session\.$/);
    const result = await bounded(harness.run, 2_000, "run did not settle after a rejected interrupt");
    assert.equal(sdk.state.closed, true);
    assert.equal(result.failure?.category, "interruption");
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt stops a steer that survived the native interrupt behind a running tool (#310)", async () => {
  const sdk = createScriptedSdk({
    interrupt: { kind: "receipt", receipt: (state) => ({ still_queued: [state.inputs[1]!.uuid!] }) },
    terminal: "untagged",
    drainSurvivors: true,
  });
  const harness = await startRun(sdk.query, { interruptSettleMs: 30_000 });
  try {
    const steer = await harness.control.steer("queued behind the running tool", "steer-310");
    assert.equal(steer.status, "acknowledged");
    const interrupt = await timed(harness.control.interrupt(), 2_000, "explicit interrupt waited for the survivor");
    assert.equal(interrupt.value.status, "acknowledged");
    assert.match(interrupt.value.message, /closed the session so 1 surviving queued message\(s\) cannot run/);
    const result = await bounded(harness.run, 2_000, "run did not settle");
    // Give the scripted drain loop its chance to run the survivor.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(sdk.state.postInterruptModelRequests, 0);
    assert.equal(sdk.state.postInterruptToolStarts, 0);
    assert.equal(result.text.includes("survivor ran"), false);
    assert.equal(result.failure?.category, "interruption");
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt closes on the interrupted result before an unlisted queued steer can drain (#310)", async () => {
  // Older CLIs return no receipt, so survivors are unknown: the interrupted
  // result itself closes the session before the drain loop starts work.
  const sdk = createScriptedSdk({
    interrupt: { kind: "receipt", receipt: () => undefined },
    terminal: "untagged",
    drainSurvivors: true,
  });
  const harness = await startRun(sdk.query, { interruptSettleMs: 30_000 });
  try {
    assert.equal((await harness.control.steer("queued behind the running tool", "steer-310")).status, "acknowledged");
    const interrupt = await timed(harness.control.interrupt(), 2_000, "explicit interrupt waited for the survivor");
    assert.equal(interrupt.value.status, "acknowledged");
    await bounded(harness.run, 2_000, "run did not settle");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(sdk.state.closed, true);
    assert.equal(sdk.state.postInterruptModelRequests, 0);
    assert.equal(sdk.state.postInterruptToolStarts, 0);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt settles with a concurrent controller-style runtime abort (#310)", async () => {
  for (const interrupt of [{ kind: "never" } as const, { kind: "receipt", receipt: () => ({ still_queued: [] }) } as const]) {
    const sdk = createScriptedSdk({ interrupt, terminal: "untagged" });
    const harness = await startRun(sdk.query, { interruptSettleMs: 200 });
    try {
      assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
      // The controller invokes the adapter interrupt, then aborts the
      // runtime signal, then awaits both.
      const transport = harness.control.interrupt();
      harness.abort.abort(new Error("interrupt_as_failure"));
      const [acknowledgement, result] = await bounded(
        Promise.all([transport, harness.run]),
        3_000,
        `controller-style interrupt (${interrupt.kind}) did not settle`,
      );
      assert.equal(acknowledgement.status, interrupt.kind === "never" ? "failed" : "acknowledged");
      assert.equal(result.aborted, true);
      assert.equal(result.failure?.category, "interruption");
      assert.equal(sdk.state.closed, true);
    } finally {
      await rm(harness.dir, { recursive: true, force: true });
    }
  }
});

test("Claude steering during or after explicit interruption reports truthful non-delivery (#310)", async () => {
  const sdk = createScriptedSdk({ interrupt: { kind: "never" } });
  const harness = await startRun(sdk.query, { interruptSettleMs: 200 });
  try {
    const transport = harness.control.interrupt();
    const during = await harness.control.steer("while interrupting", "steer-during");
    assert.equal(during.status, "blocked");
    assert.match(during.message, /explicitly interrupted; steering was not delivered/);
    assert.equal((await bounded(transport, 3_000, "interrupt did not settle")).status, "failed");
    await bounded(harness.run, 2_000, "run did not settle");
    const after = await harness.control.steer("after shutdown", "steer-after");
    assert.equal(after.status, "blocked");
    const again = await harness.control.interrupt();
    assert.equal(again.status, "blocked");
    // Only the initial prompt ever reached the transport.
    assert.equal(sdk.state.inputs.length, 1);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt after deferred steering keeps a racing genuine API failure's diagnostics (#310)", async () => {
  const sdk = createScriptedSdk({
    interrupt: { kind: "receipt", receipt: () => ({ still_queued: [] }) },
    terminal: "api-error-before-ack",
  });
  const harness = await startRun(sdk.query, { interruptSettleMs: 30_000 });
  try {
    assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
    assert.equal((await bounded(harness.control.interrupt(), 2_000, "interrupt did not settle")).status, "acknowledged");
    const result = await bounded(harness.run, 2_000, "run did not settle");
    // The failure arrived before the interrupt was verified: it keeps its
    // provider diagnostics and is not relabeled as an interruption.
    assert.ok(harness.activity.includes("model failed · Claude error (error_during_execution): API Error: 429 rate limit exceeded"));
    assert.equal(harness.activity.includes("model turn interrupted"), false);
    assert.equal(result.failure?.category, "interruption");
    assert.match(result.failure?.message ?? "", /API Error: 429 rate limit exceeded/);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt rejects a verified turn-interrupt steer whose input the SDK never pulls and settles promptly (#310)", async () => {
  const sdk = createScriptedSdk({
    interrupt: { kind: "receipt", receipt: () => ({ still_queued: [] }) },
    terminal: "untagged",
    pullInitialOnly: true,
  });
  const harness = await startRun(sdk.query, { interruptSettleMs: 30_000 });
  try {
    const steer = harness.control.steer("interrupt then steer", "steer-interrupting-310", { interrupt: true });
    // The steer's own native interrupt is verified, then its replacement
    // waits on input the SDK never consumes.
    await bounded((async () => {
      while (sdk.state.interruptCalls < 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    })(), 2_000, "turn-interrupt steer never reached the native interrupt");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const interrupt = await timed(harness.control.interrupt(), 2_000, "explicit interrupt hung behind undelivered steering");
    assert.equal(interrupt.value.status, "acknowledged");
    const steerResult = await bounded(steer, 2_000, "undelivered steer never settled");
    assert.equal(steerResult.status, "failed");
    assert.equal(steerResult.message, "Claude streaming input closed before the message was delivered.");
    const result = await bounded(harness.run, 2_000, "run hung behind undelivered steering");
    assert.equal(result.failure?.category, "interruption");
    // Only the initial prompt was ever consumed.
    assert.equal(sdk.state.inputs.length, 1);
    assert.equal(sdk.state.closed, true);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt keeps an SDK stream failure that precedes session closure (#310)", async () => {
  const sdk = createScriptedSdk({ interrupt: { kind: "never" }, streamFailureOnInterrupt: "synthetic SDK stream failure" });
  const harness = await startRun(sdk.query, { interruptSettleMs: 200 });
  try {
    assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
    const interrupt = await bounded(harness.control.interrupt(), 3_000, "explicit interrupt did not settle");
    assert.equal(interrupt.status, "failed");
    const result = await bounded(harness.run, 2_000, "run did not settle");
    // The genuine failure happened before shutdown closed the session: its
    // exact protocol diagnostic survives the pending interrupt.
    assert.deepEqual(result.failure, { category: "protocol", message: "synthetic SDK stream failure" });
    assert.equal(result.code, 1);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("Claude explicit Interrupt with the installed Agent SDK stops a local CLI that drains surviving steering after stdin EOF (#310)", { skip: process.platform === "win32" }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-claude-310-sdk-"));
  const marker = join(scratch, "events.log");
  let harness: Harness | undefined;
  let rootPid: number | undefined;
  try {
    const cli = await writeMockClaudeCli(scratch);
    harness = await startRun(
      undefined,
      { interruptSettleMs: 5_000, processCleanupGraceMs: 1_000 },
      { command: cli, env: { CLAUDE_MOCK_MARKER: marker, CLAUDE_MOCK_DRAIN_MS: "150" } },
    );
    assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");
    await bounded((async () => {
      while (!(await readMockEvents(marker)).includes("user:2")) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    })(), 5_000, "steering never reached the local CLI");
    rootPid = mockRootPid(await readMockEvents(marker));
    assert.ok(rootPid !== undefined && isAlive(rootPid));

    const interrupt = await timed(harness.control.interrupt(), 5_000, "explicit interrupt did not settle with the installed SDK");
    assert.equal(interrupt.value.status, "acknowledged", interrupt.value.message);
    assert.match(interrupt.value.message, /owned Claude process shutdown verified\.$/);
    assert.equal(isAlive(rootPid), false);
    const result = await bounded(harness.run, 5_000, "run did not settle");
    assert.equal(result.failure?.category, "interruption");
    assert.deepEqual(harness.processEvents, [`start:${rootPid}`, `exit:${rootPid}`]);

    // Give the CLI's drain loop well past its delay: the surviving steering
    // never issued a request or started a tool after the interrupt.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const events = await readMockEvents(marker);
    assert.ok(events.includes("control:interrupt"));
    assert.equal(events.includes("post-interrupt-request"), false, events.join(","));
    assert.equal(events.includes("post-interrupt-tool"), false, events.join(","));
  } finally {
    if (rootPid !== undefined) {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        // Already gone (ESRCH): nothing of ours remains.
      }
    }
    if (harness) await rm(harness.dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

// Production-spawn cleanup: the scripted SDK launches the configured command
// through the adapter's real spawnClaudeCodeProcess hook. The owned root
// starts a same-group descendant that ignores SIGTERM (like a tool child), so
// acknowledgement must prove the whole owned group is gone.
const ownedTreeScript = `
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const ready = process.env.CLAUDE_310_PID_FILE + ".ready";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);", ready], { stdio: "ignore" });
process.stdin.resume();
const wait = setInterval(() => {
  if (!existsSync(ready)) return;
  clearInterval(wait);
  writeFileSync(process.env.CLAUDE_310_PID_FILE, JSON.stringify({ root: process.pid, descendant: descendant.pid }));
}, 10);
setInterval(() => {}, 1000);
`;

// Running (not exited or reaped-pending zombie) according to ps.
function isAlive(pid: number): boolean {
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const state = status.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

async function readPids(file: string): Promise<{ root: number; descendant: number }> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { root: number; descendant: number };
      if (Number.isSafeInteger(parsed.root) && Number.isSafeInteger(parsed.descendant)) return parsed;
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) throw new Error("owned process tree did not report its pids");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

for (const interrupt of [
  { kind: "receipt", receipt: () => ({ still_queued: [] }) } as const,
  { kind: "never" } as const,
]) {
  test(`Claude explicit Interrupt verifies owned process-group shutdown before reporting (${interrupt.kind}) (#310)`, { skip: process.platform === "win32" }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "pi-review-claude-310-spawn-"));
    const scriptPath = join(scratch, "owned-tree.cjs");
    const pidFile = join(scratch, "pids.json");
    await writeFile(scriptPath, ownedTreeScript);
    process.env.CLAUDE_310_PID_FILE = pidFile;
    let pids: { root: number; descendant: number } | undefined;
    let harness: Harness | undefined;
    try {
      const sdk = createScriptedSdk({ interrupt, terminal: "untagged", spawn: true });
      harness = await startRun(
        sdk.query,
        { interruptSettleMs: 200, processCleanupGraceMs: 300 },
        { command: process.execPath, args: [scriptPath] },
      );
      pids = await readPids(pidFile);
      assert.equal(pids.root, (sdk.state.spawned as unknown as { pid?: number } | undefined)?.pid);
      assert.ok(isAlive(pids.root) && isAlive(pids.descendant));
      assert.equal((await harness.control.steer("deferred steering", "steer-310")).status, "acknowledged");

      const transport = harness.control.interrupt();
      harness.abort.abort(new Error("interrupt_as_failure"));
      const acknowledgement = await bounded(transport, 5_000, "explicit interrupt did not verify shutdown in bound");
      // Shutdown is verified before the acknowledgement is reported: the
      // SIGTERM-ignoring descendant required SIGKILL escalation.
      assert.equal(isAlive(pids.root), false);
      assert.equal(isAlive(pids.descendant), false);
      assert.match(acknowledgement.message, /owned Claude process shutdown verified\.$/);
      assert.equal(acknowledgement.status, interrupt.kind === "never" ? "failed" : "acknowledged");
      const result = await bounded(harness.run, 2_000, "run did not settle after verified shutdown");
      assert.equal(result.failure?.category, "interruption");
      assert.equal(result.failure?.message.includes("not verified"), false);
      assert.deepEqual(harness.processEvents, [`start:${pids.root}`, `exit:${pids.root}`]);
    } finally {
      delete process.env.CLAUDE_310_PID_FILE;
      // Positive cleanup of this test's own detached process group only.
      if (pids) {
        try {
          process.kill(-pids.root, "SIGKILL");
        } catch {
          // Already gone (ESRCH): nothing of ours remains.
        }
      }
      if (harness) await rm(harness.dir, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
