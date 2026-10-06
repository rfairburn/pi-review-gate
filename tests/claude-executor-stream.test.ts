import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Query, SDKMessage, SDKResultError, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";
import type { ExecutorLiveControl } from "../src/execution/types";

test("Claude executor uses Agent SDK streaming input for acknowledged live steering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-sdk-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return createFakeQuery(params.prompt, inputs);
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.steer("steered", "instruction-1")).status, "acknowledged");
    const result = await run;
    assert.equal(result.text, "claude complete");
    assert.equal(result.session.id, "claude-session");
    assert.equal(result.usage?.inputTokens, 20);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]?.priority, "now");
    assert.equal(capturedOptions?.permissionMode, "auto");
    assert.deepEqual(capturedOptions?.tools, { type: "preset", preset: "claude_code" });
    assert.equal(capturedOptions?.includePartialMessages, true);
    assert.ok(activity.some((message) => /streaming session initialized/.test(message)));
    assert.ok(activity.some((message) => /bash/.test(message)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude research executor exposes the full supported parent-authorized catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-research-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let capturedOptions: Record<string, any> | undefined;
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return createFakeQuery(params.prompt, inputs);
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "research",
      artifactDir,
      turn: 1,
      workspaceAccess: "read-only",
      executorToolCatalog: {
        allowedToolCatalog: ["read", "grep", "find", "WebFetch", "WebSearch", "BrowserExtract", "bash"],
        initialActiveTools: ["read", "WebFetch"],
      },
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    await control.steer("finish", "instruction-1");
    await run;

    assert.equal(capturedOptions?.permissionMode, "dontAsk");
    assert.deepEqual(capturedOptions?.tools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    assert.deepEqual(capturedOptions?.allowedTools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    assert.deepEqual(capturedOptions?.settingSources, []);
    assert.deepEqual(capturedOptions?.plugins, []);
    assert.deepEqual(capturedOptions?.mcpServers, {});
    assert.equal(capturedOptions?.strictMcpConfig, true);
    assert.equal((await capturedOptions?.canUseTool("Read", {}, {})).behavior, "allow");
    // WebSearch is allowed but intentionally absent from the durable future
    // initial set, so this proves that set does not activate tools yet.
    assert.equal((await capturedOptions?.canUseTool("WebSearch", {}, {})).behavior, "allow");
    // The research-role projection still cannot widen into implementation or
    // unsupported tools from the parent catalog.
    assert.equal((await capturedOptions?.canUseTool("Bash", {}, {})).behavior, "deny");
    assert.equal((await capturedOptions?.canUseTool("BrowserExtract", {}, {})).behavior, "deny");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude research maps authorized discovery onto native Grep/Glob and keeps excluded names absent (#72)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-discovery-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let capturedOptions: Record<string, any> | undefined;
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return createFakeQuery(params.prompt, inputs);
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "research",
      artifactDir,
      turn: 1,
      workspaceAccess: "read-only",
      executorToolCatalog: {
        // Authorized native discovery plus read-only web observation.
        allowedToolCatalog: ["read", "grep", "glob", "find", "ls", "WebFetch", "WebSearch"],
        initialActiveTools: ["read", "grep", "find", "ls"],
      },
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    await control.steer("finish", "instruction-1");
    await run;

    // The native adapter mappings reuse Claude's own Grep/Glob; the durable
    // initial subset never changes what the read-only role may call.
    assert.deepEqual(capturedOptions?.tools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    assert.deepEqual(capturedOptions?.allowedTools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    assert.equal((await capturedOptions?.canUseTool("Grep", {}, {})).behavior, "allow");
    assert.equal((await capturedOptions?.canUseTool("Glob", {}, {})).behavior, "allow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // A parent launch that removed discovery from the inherited catalog keeps
  // Claude's native Grep/Glob out of the read-only profile.
  const excludedDir = await mkdtemp(join(tmpdir(), "pi-review-claude-excluded-"));
  try {
    const artifactDir = join(excludedDir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let capturedOptions: Record<string, any> | undefined;
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return createFakeQuery(params.prompt, inputs);
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "research",
      artifactDir,
      turn: 1,
      workspaceAccess: "read-only",
      executorToolCatalog: {
        allowedToolCatalog: ["read", "WebFetch", "WebSearch"],
        initialActiveTools: ["read"],
      },
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    await control.steer("finish", "instruction-1");
    await run;
    assert.deepEqual(capturedOptions?.tools, ["Read", "WebFetch", "WebSearch"]);
    assert.equal((await capturedOptions?.canUseTool("Grep", {}, {})).behavior, "deny");
    assert.equal((await capturedOptions?.canUseTool("Glob", {}, {})).behavior, "deny");
  } finally {
    await rm(excludedDir, { recursive: true, force: true });
  }
});

test("Claude research executor fails closed without a parent tool allowlist", async () => {
  const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" });
  await assert.rejects(adapter.run({
    cwd: process.cwd(),
    prompt: "research",
    artifactDir: join(tmpdir(), "pi-review-claude-missing-tools"),
    turn: 1,
    workspaceAccess: "read-only",
  }), /requires an authoritative parent tool allowlist/);
});

test("Claude research executor rejects configured arguments that could widen its tools", async () => {
  const adapter = new ClaudeExecutorAdapter({
    id: "claude",
    adapter: "claude-cli",
    command: "claude",
    model: "sonnet",
    args: ["--effort", "high", "--tools=Bash,Read"],
  });
  await assert.rejects(adapter.run({
    cwd: process.cwd(),
    prompt: "research",
    artifactDir: join(tmpdir(), "pi-review-claude-policy-override"),
    turn: 1,
    workspaceAccess: "read-only",
    executorToolCatalog: {
      allowedToolCatalog: ["read"],
      initialActiveTools: ["read"],
    },
  }), /rejects tool-policy argument --tools=Bash,Read/);
});

test("Claude interrupt waits for a terminal SDK result and reports interruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createFakeQuery(params.prompt, inputs, true)) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor delivers turn-interrupt steering to the same session (#63)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-steer-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let interruptCalls = 0;
    let inputsAtInterrupt: number | undefined;
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      const query = createFakeQuery(params.prompt, inputs, true);
      const originalInterrupt = query.interrupt.bind(query);
      query.interrupt = async () => { interruptCalls += 1; inputsAtInterrupt = inputs.length; return originalInterrupt(); };
      return query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    const acknowledgement = await control.steer("steered", "steer-interrupt-1", { interrupt: true });
    assert.equal(acknowledgement.status, "acknowledged");
    assert.match(acknowledgement.message, /turn-interrupt steering/);
    const result = await run;
    // The interrupted turn's error result must not end the run; the steered
    // message's result is the terminal one in the same session.
    assert.equal(result.failure, undefined);
    assert.equal(result.aborted, false);
    assert.equal(result.text, "claude complete");
    assert.equal(result.session.id, "claude-session");
    assert.equal(interruptCalls, 1);
    // Interrupt-before-delivery: the native interrupt fired before the
    // steered message entered the streaming input.
    assert.equal(inputsAtInterrupt, 1);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]?.uuid, acknowledgement.turnId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor acknowledges turn-interrupt steering before the replacement result and accepts a second steer (#63)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-steer-ack-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const events: string[] = [];
    let interruptCalls = 0;
    const inputsAtInterrupt: number[] = [];
    // A local fake that only settles the final steered message, so earlier
    // replacement turns stay running after their steering acknowledgement.
    const output = new AsyncOutputQueue();
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) {
          inputs.push(message);
          events.push(`enqueue:${message.uuid}`);
          if (inputs.length === 1) {
            output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
            output.push({
              type: "assistant",
              session_id: "claude-session",
              uuid: "assistant-1",
              parent_tool_use_id: null,
              message: { role: "assistant", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } }] },
            } as unknown as SDKMessage);
          } else if (message.message.content === "second steer") {
            output.push({
              type: "result",
              subtype: "success",
              is_error: false,
              result: "claude final",
              user_message_uuid: message.uuid,
              session_id: "claude-session",
              uuid: "result-final",
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              stop_reason: null,
              total_cost_usd: 0,
              usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              modelUsage: {},
              permission_denials: [],
            } as unknown as SDKMessage);
          }
        }
      })();
      const iterator = output[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => ({ value: undefined, done: true }),
        throw: async (error?: unknown) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
        interrupt: async () => {
          interruptCalls += 1;
          inputsAtInterrupt.push(inputs.length);
          events.push("interrupt");
          return { still_queued: [] };
        },
        close: () => output.close(),
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.deepEqual(control.capabilities, { steer: true, interrupt: true });
    let settled = false;
    const done = run.finally(() => { settled = true; });
    // The first replacement turn deliberately stays running after acceptance.
    const first = await control.steer("steer one", "claude-steer-1", { interrupt: true });
    assert.equal(first.status, "acknowledged");
    assert.match(first.message, /turn-interrupt steering/);
    // The acknowledgement establishes transport acceptance only: the adapter
    // run must still be pending while its replacement turn is unfinished.
    assert.equal(settled, false, "steering ACK must not await replacement turn completion");
    // A second interrupt-steer retargets again and interrupts the in-flight
    // replacement, not the original message.
    const second = await control.steer("second steer", "claude-steer-2", { interrupt: true });
    assert.equal(second.status, "acknowledged");
    assert.match(second.message, /turn-interrupt steering/);
    const result = await done;
    // The last steered message's result is the terminal one in the same
    // session; earlier replacement turns never produced a result.
    assert.equal(result.failure, undefined);
    assert.equal(result.aborted, false);
    assert.equal(result.text, "claude final");
    assert.equal(result.session.id, "claude-session");
    assert.equal(interruptCalls, 2);
    // Each native interrupt fired before its own steering delivery.
    assert.deepEqual(inputsAtInterrupt, [1, 2]);
    assert.deepEqual(events, [
      `enqueue:${inputs[0]!.uuid}`,
      "interrupt",
      `enqueue:${first.turnId}`,
      "interrupt",
      `enqueue:${second.turnId}`,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor reports a throwing SDK stream as a bounded protocol failure (#63)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-stream-throw-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let nextCalls = 0;
    // The SDK stream delivers initialization and the initial prompt's first
    // activity, then fails on the next read with a transport error.
    const output = new AsyncOutputQueue();
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) {
          inputs.push(message);
          if (inputs.length === 1) {
            output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
            output.push({
              type: "assistant",
              session_id: "claude-session",
              uuid: "assistant-1",
              parent_tool_use_id: null,
              message: { role: "assistant", content: [{ type: "text", text: "working" }] },
            } as unknown as SDKMessage);
          }
        }
      })();
      const iterator = output[Symbol.asyncIterator]();
      return {
        next: () => {
          nextCalls += 1;
          if (nextCalls <= 2) return iterator.next();
          return Promise.reject(new Error("synthetic SDK stream failure"));
        },
        return: async () => ({ value: undefined, done: true }),
        throw: async (error?: unknown) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
        interrupt: async () => ({ still_queued: [] }),
        close: () => output.close(),
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    // A rejecting SDK iterator must surface as a handled protocol failure,
    // never as an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const stranded = new Promise<never>((_, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("run stranded after SDK stream failure")), 5000);
        timer.unref?.();
      });
      const result = await Promise.race([adapter.run({ cwd: dir, prompt: "initial", artifactDir, turn: 1 }), stranded]);
      // Give any (incorrect) unhandled rejection a chance to surface.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      assert.equal(nextCalls, 3);
      assert.deepEqual(unhandled, []);
      assert.equal(result.code, 1);
      assert.equal(result.aborted, false);
      assert.equal(result.failure?.category, "protocol");
      assert.match(result.failure?.message ?? "", /synthetic SDK stream failure/);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor restores original completion tracking when the native interrupt is rejected (#63)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-interrupt-reject-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let interruptCalls = 0;
    // The original turn's terminal result arrives while the native interrupt
    // request is still pending, and the SDK then rejects the interrupt.
    const output = new AsyncOutputQueue();
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) {
          inputs.push(message);
          if (inputs.length === 1) {
            output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
            output.push({
              type: "assistant",
              session_id: "claude-session",
              uuid: "assistant-1",
              parent_tool_use_id: null,
              message: { role: "assistant", content: [{ type: "text", text: "working" }] },
            } as unknown as SDKMessage);
          }
        }
      })();
      const iterator = output[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => ({ value: undefined, done: true }),
        throw: async (error?: unknown) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
        interrupt: async () => {
          interruptCalls += 1;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
          output.push({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "claude complete",
            user_message_uuid: inputs[0]!.uuid,
            session_id: "claude-session",
            uuid: "result-1",
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            stop_reason: null,
            total_cost_usd: 0,
            usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: {},
            permission_denials: [],
          } as unknown as SDKMessage);
          throw new Error("synthetic interrupt rejection");
        },
        close: () => output.close(),
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    const acknowledgement = await control.steer("steered", "steer-reject-1", { interrupt: true });
    assert.equal(acknowledgement.status, "failed");
    assert.match(acknowledgement.message, /synthetic interrupt rejection/);
    // The rejected interruption must not strand completion tracking: the
    // original turn's result — received while the request was pending —
    // settles the run promptly and truthfully.
    const stranded = new Promise<never>((_, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("run stranded after rejected interrupt")), 5000);
      timer.unref?.();
    });
    const result = await Promise.race([run, stranded]);
    assert.equal(interruptCalls, 1);
    assert.equal(result.failure, undefined);
    assert.equal(result.aborted, false);
    assert.equal(result.text, "claude complete");
    assert.equal(result.session.id, "claude-session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor settles with a concrete failure when replacement delivery fails after a verified interrupt (#63)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-delivery-fail-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    let interruptCalls = 0;
    let releaseClosedGate: (() => void) | undefined;
    const closedGate = new Promise<void>((resolvePromise) => { releaseClosedGate = resolvePromise; });
    // The steer-initiated interrupt holds until the query is closed by the
    // run's own shutdown, so its replacement delivery lands on a closed
    // streaming input after the interruption was verified.
    const output = new AsyncOutputQueue();
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) {
          inputs.push(message);
          if (inputs.length === 1) {
            output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
            output.push({
              type: "assistant",
              session_id: "claude-session",
              uuid: "assistant-1",
              parent_tool_use_id: null,
              message: { role: "assistant", content: [{ type: "text", text: "working" }] },
            } as unknown as SDKMessage);
          }
        }
      })();
      const iterator = output[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => ({ value: undefined, done: true }),
        throw: async (error?: unknown) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
        interrupt: async () => {
          interruptCalls += 1;
          if (interruptCalls === 1) await closedGate;
          return { still_queued: [] };
        },
        close: () => { output.close(); releaseClosedGate?.(); },
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const runAbort = new AbortController();
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      signal: runAbort.signal,
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    const steerPromise = control.steer("steered", "steer-delivery-fail-1", { interrupt: true });
    // Let the steer's interrupt reach the SDK, then shut the run down so the
    // streaming input closes before the replacement is delivered.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    runAbort.abort();
    const acknowledgement = await steerPromise;
    assert.equal(acknowledgement.status, "failed");
    assert.match(acknowledgement.message, /Claude streaming session is closed/);
    // The verified-but-undelivered steering settles the run with a concrete
    // failure instead of waiting for an undelivered result.
    const stranded = new Promise<never>((_, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("run stranded after failed replacement delivery")), 5000);
      timer.unref?.();
    });
    const result = await Promise.race([run, stranded]);
    assert.equal(interruptCalls, 2);
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "protocol");
    assert.match(result.failure?.message ?? "", /replacement delivery failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Contract-checked SDKResultError fixture: the installed SDK's error-result
// type carries no user_message_uuid field. Positive interruption evidence is
// supplied explicitly via terminal_reason where a test establishes an
// interruption.
// Usage accounting is boilerplate for these fixtures; the fields under test
// are subtype, terminal_reason, and errors.
const fixtureUsage = {
  input_tokens: 1,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
} as SDKResultError["usage"];

function interruptedTurnResult(overrides: Partial<SDKResultError> = {}): SDKResultError {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: fixtureUsage,
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "claude-session",
    ...overrides,
  };
}

// A fake streaming session whose interrupt acknowledgement precedes the
// interrupted turn's terminal result, matching the CLI's ordering: the ack
// resolves first, then the error result is emitted, then (for steering) the
// replacement turn runs.
function createInterruptingFakeQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  inputs: SDKUserMessage[],
  interruptBehavior: "ack-then-result" | "result-before-ack" | "reject-then-result" | "ack-then-max-turns" | "ack-then-model-error" | "ack-then-no-reason" | "ack-then-reported" | "ack-survivor-then-reported" | "ack-then-abort-no-receipt",
  withReceipt = true,
): Query {
  const output = new AsyncOutputQueue();
  void (async () => {
    for await (const message of prompt) {
      inputs.push(message);
      if (inputs.length === 1) {
        output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
        output.push({
          type: "assistant",
          session_id: "claude-session",
          uuid: "assistant-1",
          parent_tool_use_id: null,
          message: { role: "assistant", content: [{ type: "text", text: "working" }] },
        } as unknown as SDKMessage);
      } else {
        // The replacement turn's result follows the interrupted turn's.
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
        output.push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "claude complete",
          user_message_uuid: message.uuid,
          session_id: "claude-session",
          uuid: "result-1",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
        } as unknown as SDKMessage);
      }
    }
  })();
  const iterator = output[Symbol.asyncIterator]();
  return {
    next: () => iterator.next(),
    return: async () => ({ value: undefined, done: true }),
    throw: async (error?: unknown) => { throw error; },
    [Symbol.asyncIterator]() { return this; },
    initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
    interrupt: async () => {
      if (interruptBehavior === "ack-then-result") {
        setTimeout(() => output.push(interruptedTurnResult({ terminal_reason: "aborted_streaming" })), 0);
        return { still_queued: [] };
      }
      if (interruptBehavior === "result-before-ack") {
        // The turn's genuine API failure beats the interrupt acknowledgement.
        output.push(interruptedTurnResult({
          terminal_reason: "api_error",
          errors: ["API Error: 429 rate limit exceeded"],
          uuid: "00000000-0000-4000-8000-000000000002",
        }));
        return { still_queued: [] };
      }
      if (interruptBehavior === "reject-then-result") {
        setTimeout(() => output.push(interruptedTurnResult({
          terminal_reason: "api_error",
          errors: ["API Error: 429 rate limit exceeded"],
          uuid: "00000000-0000-4000-8000-000000000002",
        })), 0);
        throw new Error("synthetic interrupt rejection");
      }
      if (interruptBehavior === "ack-then-model-error") {
        // A genuine same-subtype execution failure after a verified ack.
        setTimeout(() => output.push(interruptedTurnResult({
          terminal_reason: "model_error",
          errors: ["synthetic model failure detail"],
          uuid: "00000000-0000-4000-8000-000000000003",
        })), 0);
        return { still_queued: [] };
      }
      if (interruptBehavior === "ack-then-no-reason") {
        // An execution error without any terminal reason after a verified ack.
        setTimeout(() => output.push(interruptedTurnResult({
          errors: ["synthetic undiagnosed termination"],
          uuid: "00000000-0000-4000-8000-000000000004",
        })), 0);
        return { still_queued: [] };
      }
      if (interruptBehavior === "ack-then-reported") {
        // The exact reported steering-correlated raw result: SDK-mode
        // interrupted turn results carry no terminal_reason, only the CLI's
        // internal cutoff diagnostic in errors[].
        setTimeout(() => output.push(interruptedTurnResult({
          stop_reason: "tool_use",
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
          uuid: "00000000-0000-4000-8000-000000000006",
        })), 0);
        return withReceipt ? { still_queued: [] } : undefined;
      }
      if (interruptBehavior === "ack-then-abort-no-receipt") {
        // Legacy CLIs resolve the interrupt without a receipt; an explicit
        // abort terminal reason still classifies the result on its own.
        setTimeout(() => output.push(interruptedTurnResult({
          terminal_reason: "aborted_streaming",
          uuid: "00000000-0000-4000-8000-000000000008",
        })), 0);
        return undefined;
      }
      if (interruptBehavior === "ack-survivor-then-reported") {
        // The receipt reports the target uuid as a survivor (still queued
        // when the abort landed, per the interrupt_receipt_v1 contract): it
        // was never interrupted and will run. Its later diagnostic-only EDE
        // must not gain interruption authority from this request.
        setTimeout(() => output.push(interruptedTurnResult({
          stop_reason: "tool_use",
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
          uuid: "00000000-0000-4000-8000-000000000007",
        })), 0);
        return { still_queued: [inputs[0]?.uuid ?? ""] };
      }
      setTimeout(() => output.push(interruptedTurnResult({
        subtype: "error_max_turns",
        errors: ["max turns reached"],
        uuid: "00000000-0000-4000-8000-000000000005",
      })), 0);
      return { still_queued: [] };
    },
    close: () => output.close(),
  } as unknown as Query;
}

test("Claude executor reports owned turn-interrupt steering as an interruption, not an API failure (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-steer-interrupt-activity-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-result")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.steer("steered", "steer-interrupt-activity-1", { interrupt: true })).status, "acknowledged");
    const result = await run;

    // The interrupted turn's contract-shaped (unkeyed) error result is a
    // truthful interruption; the replacement turn completes normally. No
    // fabricated API failure.
    assert.equal(result.failure, undefined);
    assert.ok(activity.includes("model turn interrupted"));
    assert.ok(activity.includes("model turn completed"));
    assert.equal(activity.some((message) => message.startsWith("model failed")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor reports an explicit Interrupt as an interruption, not an API failure (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-interrupt-activity-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-result")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // The owned interruption keeps its category and truthful activity; the
    // interrupted turn's contract-shaped (unkeyed) error result is not a
    // model/API failure.
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model turn interrupted"));
    assert.equal(activity.some((message) => message.startsWith("model failed")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor reports the reported SDK-mode cutoff payload as an interruption for turn-interrupt steering (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-reported-steer-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-reported")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.steer("steered", "reported-steer-1", { interrupt: true })).status, "acknowledged");
    const result = await run;

    // The exact reported payload (no terminal_reason) is the interrupted
    // turn's truthful cutoff; the replacement turn completes normally.
    assert.equal(result.failure, undefined);
    assert.ok(activity.includes("model turn interrupted"));
    assert.ok(activity.includes("model turn completed"));
    assert.equal(activity.some((message) => message.startsWith("model failed")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor reports the reported SDK-mode cutoff payload as an interruption for an explicit Interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-reported-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-reported")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // The owned interruption keeps its category and truthful activity for the
    // exact reported payload.
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model turn interrupted"));
    assert.equal(activity.some((message) => message.startsWith("model failed")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps a surviving target's diagnostic-only result failing after turn-interrupt steering (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-survivor-steer-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-survivor-then-reported")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    const acknowledgement = await control.steer("steered", "survivor-steer-1", { interrupt: true });
    assert.equal(acknowledgement.status, "acknowledged");
    assert.ok(acknowledgement.message.includes("survives the interrupt"));
    const result = await run;

    // The receipt proves the previous turn survived the abort (it was still
    // queued), so its later diagnostic-only EDE keeps its failure label; the
    // replacement turn completes normally.
    assert.equal(result.failure, undefined);
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps a surviving target's diagnostic-only result failing after an explicit Interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-survivor-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-survivor-then-reported")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // The receipt proves the target survived the abort (first-command
    // prewait window), so its diagnostic-only EDE is a failure, not an
    // interruption; the run keeps its existing control-cancellation
    // settlement.
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps a no-receipt diagnostic-only result failing after turn-interrupt steering (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-noreceipt-steer-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    // Legacy CLIs resolve the interrupt without a survivor receipt.
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-reported", false)) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.steer("steered", "noreceipt-steer-1", { interrupt: true })).status, "acknowledged");
    const result = await run;

    // Without a survivor receipt the diagnostic-only shape is not
    // abort-specific: the failure label stands and the replacement turn
    // completes normally.
    assert.equal(result.failure, undefined);
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps a no-receipt diagnostic-only result failing after an explicit Interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-noreceipt-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    // Legacy CLIs resolve the interrupt without a survivor receipt.
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-reported", false)) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // Without a survivor receipt the diagnostic-only shape is not
    // abort-specific: the failure label stands; the run keeps its existing
    // control-cancellation settlement.
    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps legacy abort-terminal-reason classification working without a receipt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-noreceipt-abort-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    // Legacy CLIs resolve the interrupt without a receipt; an explicit abort
    // terminal reason still classifies the result as an interruption.
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-abort-no-receipt")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    assert.equal(result.aborted, true);
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model turn interrupted"));
    assert.equal(activity.some((message) => message.startsWith("model failed")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps a racing genuine API failure failing while the interrupt acknowledgement is pending (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-racing-failure-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "result-before-ack")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.steer("steered", "racing-failure-1", { interrupt: true })).status, "acknowledged");
    const result = await run;

    // The same turn's genuine API failure arrived before the interrupt was
    // verified: it keeps its failure diagnostics and is not an interruption.
    assert.equal(result.failure, undefined);
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): API Error: 429 rate limit exceeded"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps same-turn failures failing after a rejected interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-rejected-interrupt-failure-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "reject-then-result")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    const acknowledgement = await control.steer("steered", "rejected-interrupt-failure-1", { interrupt: true });
    assert.equal(acknowledgement.status, "failed");
    const result = await run;

    // The rejected interruption was withdrawn; the original turn's genuine
    // API failure keeps its failure label and settles the restored tracking.
    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "provider");
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): API Error: 429 rate limit exceeded"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps non-interruption subtypes failing after a verified Interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-max-turns-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-max-turns")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // A verified interrupt whose turn ended for a different reason keeps the
    // failure label with subtype detail.
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model failed · Claude error (error_max_turns): max turns reached"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps same-subtype genuine failures failing after a verified Interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-model-error-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-model-error")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // error_during_execution with a non-abort terminal reason is a genuine
    // failure even though the interrupt was acknowledged.
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): synthetic model failure detail"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps unexplained execution errors failing after a verified Interrupt (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-no-reason-interrupt-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    const fakeQuery = ((paramsArg: { prompt: AsyncIterable<SDKUserMessage> }) =>
      createInterruptingFakeQuery(paramsArg.prompt, inputs, "ack-then-no-reason")) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    assert.equal((await control.interrupt()).status, "acknowledged");
    const result = await run;

    // Without positive abort evidence the failure diagnostics are preserved.
    assert.equal(result.failure?.category, "interruption");
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): synthetic undiagnosed termination"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps genuine API failures failing after nearby non-interrupting steering (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-nearby-steer-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    // The steered replacement turn fails with a genuine API error.
    const output = new AsyncOutputQueue();
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) {
          inputs.push(message);
          if (inputs.length === 1) {
            output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
            output.push({
              type: "assistant",
              session_id: "claude-session",
              uuid: "assistant-1",
              parent_tool_use_id: null,
              message: { role: "assistant", content: [{ type: "text", text: "working" }] },
            } as unknown as SDKMessage);
          } else {
            output.push({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              api_error_status: 429,
              errors: [],
              result: "Rate limited",
              user_message_uuid: message.uuid,
              session_id: "claude-session",
              uuid: "result-429",
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              stop_reason: null,
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              modelUsage: {},
              permission_denials: [],
            } as unknown as SDKMessage);
          }
        }
      })();
      const iterator = output[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => ({ value: undefined, done: true }),
        throw: async (error?: unknown) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
        interrupt: async () => ({ still_queued: [] }),
        close: () => output.close(),
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    let resolveControl!: (control: ExecutorLiveControl) => void;
    const controlReady = new Promise<ExecutorLiveControl>((resolvePromise) => { resolveControl = resolvePromise; });
    const activity: string[] = [];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const run = adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
      onLiveControl: (control) => { if (control) resolveControl(control); },
    });
    const control = await controlReady;
    // Ordinary steering interrupts nothing and must not suppress the real error.
    assert.equal((await control.steer("steered", "nearby-steer-1")).status, "acknowledged");
    const result = await run;

    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "provider");
    assert.ok(activity.includes("model failed · Claude API 429: Rate limited"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude executor keeps an uncorrelated error_during_execution a failure with subtype and errors detail (#305)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-uncorrelated-error-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    const inputs: SDKUserMessage[] = [];
    // No control event: the turn ends in an error_during_execution result on
    // its own. The subtype alone must not read as an owned interruption.
    const output = new AsyncOutputQueue();
    const fakeQuery = ((params: { prompt: AsyncIterable<SDKUserMessage> }) => {
      void (async () => {
        for await (const message of params.prompt) {
          inputs.push(message);
          if (inputs.length === 1) {
            output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
            output.push({
              type: "assistant",
              session_id: "claude-session",
              uuid: "assistant-1",
              parent_tool_use_id: null,
              message: { role: "assistant", content: [{ type: "text", text: "working" }] },
            } as unknown as SDKMessage);
            output.push({
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
              user_message_uuid: message.uuid,
              session_id: "claude-session",
              uuid: "result-ede",
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              stop_reason: null,
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              modelUsage: {},
              permission_denials: [],
            } as unknown as SDKMessage);
          }
        }
      })();
      const iterator = output[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => ({ value: undefined, done: true }),
        throw: async (error?: unknown) => { throw error; },
        [Symbol.asyncIterator]() { return this; },
        initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
        interrupt: async () => ({ still_queued: [] }),
        close: () => output.close(),
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"];
    const adapter = new ClaudeExecutorAdapter({ id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" }, {
      loadSdk: async () => ({ query: fakeQuery }),
    });
    const activity: string[] = [];
    const result = await adapter.run({
      cwd: dir,
      prompt: "initial",
      artifactDir,
      turn: 1,
      onUpdate: (message) => activity.push(message),
    });

    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "provider");
    assert.ok(activity.includes("model failed · Claude error (error_during_execution): [ede_diagnostic] result_type=user stop_reason=tool_use"));
    assert.equal(activity.includes("model turn interrupted"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createFakeQuery(prompt: AsyncIterable<SDKUserMessage>, inputs: SDKUserMessage[], finishOnInterrupt = false): Query {
  const output = new AsyncOutputQueue();
  let closed = false;
  let activeUuid: string | undefined;
  void (async () => {
    for await (const message of prompt) {
      inputs.push(message);
      activeUuid = message.uuid;
      if (inputs.length === 1) {
        output.push({ type: "system", subtype: "init", session_id: "claude-session", uuid: "system-1" } as unknown as SDKMessage);
        output.push({
          type: "assistant",
          session_id: "claude-session",
          uuid: "assistant-1",
          parent_tool_use_id: null,
          message: { role: "assistant", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } }] },
        } as unknown as SDKMessage);
      } else {
        output.push({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "claude complete",
          user_message_uuid: message.uuid,
          session_id: "claude-session",
          uuid: "result-1",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
        } as unknown as SDKMessage);
      }
    }
  })();
  const iterator = output[Symbol.asyncIterator]();
  return {
    next: () => iterator.next(),
    return: async () => ({ value: undefined, done: true }),
    throw: async (error?: unknown) => { throw error; },
    [Symbol.asyncIterator]() { return this; },
    initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} as never }),
    interrupt: async () => {
      if (finishOnInterrupt) {
        output.push({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["interrupted"],
          user_message_uuid: activeUuid,
          session_id: "claude-session",
          uuid: "result-interrupted",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
        } as unknown as SDKMessage);
      }
      return { still_queued: [] };
    },
    close: () => { if (!closed) { closed = true; output.close(); } },
  } as unknown as Query;
}

class AsyncOutputQueue implements AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = [];
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
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
    } };
  }
}
