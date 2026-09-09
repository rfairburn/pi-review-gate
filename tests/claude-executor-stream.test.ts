import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
