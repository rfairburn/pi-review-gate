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
      allowedTools: ["read", "grep", "find", "WebFetch", "WebSearch", "BrowserExtract", "bash"],
      initialActiveTools: ["read", "WebFetch"],
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
    allowedTools: ["read"],
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
