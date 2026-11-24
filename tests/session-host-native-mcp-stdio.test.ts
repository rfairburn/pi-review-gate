import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  NATIVE_MCP_ERROR,
  NATIVE_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  NativeMcpStdioSession,
  startNativeMcpStdioSession,
  type NativeMcpCallToolRequest,
  type NativeMcpCallToolResult,
  type NativeMcpStdioLimits,
  type NativeMcpToolDescriptor,
  type NativeMcpToolEndpoint,
} from "../src/session-host/native-mcp-stdio";

type Json = Record<string, any>;

const TOOLS: NativeMcpToolDescriptor[] = [
  { name: "SubtasksStart", description: "start", inputSchema: { type: "object", properties: { kind: { type: "string" } } } },
  { name: "SubtasksInspect", description: "inspect", inputSchema: { type: "object" } },
];

/** A complete MCP InitializeRequest params object. */
function initParams(protocolVersion = "2025-06-18"): Json {
  return { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Recording endpoint; each call can be answered immediately or held open. */
class FakeEndpoint implements NativeMcpToolEndpoint {
  readonly listCalls: AbortSignal[] = [];
  readonly calls: NativeMcpCallToolRequest[] = [];
  tools: unknown = TOOLS;
  respond: (request: NativeMcpCallToolRequest) => Promise<NativeMcpCallToolResult | undefined> = async (request) => ({
    content: [{ type: "text", text: `ran ${request.name}` }],
    isError: false,
  });

  async listTools(request: { signal: AbortSignal }): Promise<readonly NativeMcpToolDescriptor[]> {
    this.listCalls.push(request.signal);
    return this.tools as NativeMcpToolDescriptor[];
  }

  callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    this.calls.push(request);
    return this.respond(request);
  }
}

class Harness {
  readonly input = new PassThrough();
  readonly output: PassThrough;
  readonly endpoint: FakeEndpoint;
  readonly session: NativeMcpStdioSession;
  readonly frames: string[] = [];
  private buffer = "";
  private waiters: Array<() => void> = [];

  constructor(options: { endpoint?: FakeEndpoint; limits?: Partial<NativeMcpStdioLimits>; output?: PassThrough; instructions?: string } = {}) {
    this.endpoint = options.endpoint ?? new FakeEndpoint();
    this.output = options.output ?? new PassThrough();
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        this.frames.push(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.session = startNativeMcpStdioSession({
      input: this.input,
      output: this.output,
      endpoint: this.endpoint,
      serverInfo: { name: "prg-native-tools", version: "1.0.0" },
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    });
  }

  write(message: unknown): void {
    this.input.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  /** Every response written so far, parsed. */
  get responses(): Json[] {
    return this.frames.map((frame) => JSON.parse(frame) as Json);
  }

  /** Waits until at least `count` responses exist. */
  async waitFor(count: number): Promise<Json[]> {
    const deadline = Date.now() + 2000;
    while (this.frames.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} responses; have ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return this.responses;
  }

  /** Sends a request and returns its response. */
  async request(id: string | number, method: string, params?: unknown): Promise<Json> {
    const before = this.frames.length;
    this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    const responses = await this.waitFor(before + 1);
    return responses[before]!;
  }

  async initialize(protocolVersion = "2025-06-18"): Promise<void> {
    const response = await this.request(0, "initialize", initParams(protocolVersion));
    assert.ok(response.result, JSON.stringify(response));
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    assert.equal(this.session.phase, "ready");
  }

  dispose(): void {
    this.session.dispose();
  }
}

/** Lets queued stream callbacks and promise reactions run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Claude Code-shaped session: initialize, initialized, tools/list, tools/call, ping", async () => {
  const harness = new Harness({ instructions: "hosted native tools" });
  try {
    // Shape: Claude Code sends method before params, numeric ids from 0, roots/elicitation capabilities.
    harness.input.write(`${JSON.stringify({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { roots: {}, elicitation: {} }, clientInfo: { name: "claude-code", version: "2.0.0" } }, jsonrpc: "2.0", id: 0 })}\n`);
    const [init] = await harness.waitFor(1);
    assert.deepEqual(init, {
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "prg-native-tools", version: "1.0.0" },
        instructions: "hosted native tools",
      },
    });
    assert.equal(harness.session.phase, "awaiting_initialized");
    assert.equal(harness.session.protocolVersion, "2025-06-18");
    harness.input.write(`${JSON.stringify({ method: "notifications/initialized", jsonrpc: "2.0" })}\n`);
    await settle();
    assert.equal(harness.session.phase, "ready");
    assert.equal(harness.frames.length, 1, "a notification is never answered");

    const listed = await harness.request(1, "tools/list", {});
    assert.deepEqual(listed, { jsonrpc: "2.0", id: 1, result: { tools: TOOLS } });
    assert.equal(harness.endpoint.listCalls.length, 1);

    // Claude Code attaches its tool_use id under `_meta`: only that one bounded
    // matching key (#682) reaches the endpoint; every other `_meta` field stays out.
    const called = await harness.request(2, "tools/call", {
      name: "SubtasksStart",
      arguments: { kind: "research", nested: { list: [1, "two"] } },
      _meta: { "claudecode/toolUseId": "toolu_01ABC", ownerId: "attacker", toolCallId: "attacker" },
    });
    assert.deepEqual(called, { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ran SubtasksStart" }], isError: false } });
    assert.equal(harness.endpoint.calls.length, 1);
    const request = harness.endpoint.calls[0]!;
    assert.deepEqual(Object.keys(request).sort(), ["arguments", "name", "signal", "toolUseId"]);
    assert.equal(request.name, "SubtasksStart");
    assert.equal(request.toolUseId, "toolu_01ABC");
    assert.deepEqual(request.arguments, { kind: "research", nested: { list: [1, "two"] } });
    assert.equal(request.signal.aborted, false);

    // A malformed key is dropped, never refused: the call runs exactly as without one.
    let id = 10;
    for (const bad of ["", "toolu 01", "toolu/01", "t".repeat(129), 7, null, { id: "toolu_01" }]) {
      id += 1;
      const answered = await harness.request(id, "tools/call", { name: "SubtasksStart", arguments: {}, _meta: { "claudecode/toolUseId": bad } });
      assert.equal((answered as { result?: unknown }).result !== undefined, true, JSON.stringify(bad));
      assert.deepEqual(Object.keys(harness.endpoint.calls.at(-1)!).sort(), ["arguments", "name", "signal"], JSON.stringify(bad));
    }

    assert.deepEqual(await harness.request(3, "ping"), { jsonrpc: "2.0", id: 3, result: {} });
    assert.equal(harness.session.inFlightCount, 0);
  } finally {
    harness.dispose();
  }
});

test("Codex-shaped session: numeric ids, title in clientInfo, null cursor, progress _meta", async () => {
  const harness = new Harness();
  try {
    const init = await harness.request(0, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: { name: "codex-mcp-client", title: "Codex", version: "0.50.0" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.instructions, undefined, "no instructions unless configured");
    harness.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    const listed = await harness.request(1, "tools/list", { cursor: null });
    assert.deepEqual(listed.result.tools.map((tool: Json) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
    const called = await harness.request(2, "tools/call", { name: "SubtasksInspect", arguments: { executionId: "exec-x" }, _meta: { progressToken: 2 } });
    assert.deepEqual(called.result, { content: [{ type: "text", text: "ran SubtasksInspect" }], isError: false });
    assert.deepEqual(harness.endpoint.calls[0]!.arguments, { executionId: "exec-x" });
    // Omitted arguments become an empty object.
    await harness.request("abc", "tools/call", { name: "SubtasksInspect" });
    assert.deepEqual(harness.endpoint.calls[1]!.arguments, {});
    assert.equal(harness.responses.at(-1)!.id, "abc");
  } finally {
    harness.dispose();
  }
});

test("protocol version negotiation echoes supported versions and answers others with the newest", async () => {
  for (const version of NATIVE_MCP_SUPPORTED_PROTOCOL_VERSIONS) {
    const harness = new Harness();
    try {
      assert.equal((await harness.request(1, "initialize", initParams(version))).result.protocolVersion, version);
    } finally {
      harness.dispose();
    }
  }
  const harness = new Harness();
  try {
    assert.equal((await harness.request(1, "initialize", initParams("1999-01-01"))).result.protocolVersion, "2025-11-25");
    const missing = new Harness();
    try {
      const response = await missing.request(1, "initialize", {});
      assert.equal(response.error.code, NATIVE_MCP_ERROR.invalidParams);
      assert.equal(missing.session.phase, "awaiting_initialize");
    } finally {
      missing.dispose();
    }
  } finally {
    harness.dispose();
  }
});

test("native tool result content, structuredContent, and isError are forwarded; extra fields are not", async () => {
  const harness = new Harness();
  try {
    await harness.initialize();
    harness.endpoint.respond = async () => ({
      content: [{ type: "text", text: "Invalid SubtasksStart request: tasks must be non-empty" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { ok: false },
      isError: true,
      details: { internal: "/opaque-internal/secret/path" },
    } as NativeMcpCallToolResult);
    const response = await harness.request(5, "tools/call", { name: "SubtasksStart", arguments: {} });
    assert.deepEqual(response.result, {
      content: [{ type: "text", text: "Invalid SubtasksStart request: tasks must be non-empty" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { ok: false },
      isError: true,
    });
    harness.endpoint.respond = async () => ({ content: [] });
    assert.deepEqual((await harness.request(6, "tools/call", { name: "SubtasksStart" })).result, { content: [], isError: false });
  } finally {
    harness.dispose();
  }
});

test("endpoint failures and invalid shapes answer with fixed errors that leak no internals", async () => {
  const harness = new Harness();
  try {
    await harness.initialize();
    harness.endpoint.respond = async () => { throw new Error("EACCES /opaque-internal/secret/.config/token=abc123"); };
    const thrown = await harness.request(1, "tools/call", { name: "SubtasksStart", arguments: {} });
    assert.equal(thrown.error.code, NATIVE_MCP_ERROR.internalError);
    assert.doesNotMatch(JSON.stringify(thrown), /secret|EACCES|abc123/);
    assert.match(thrown.error.message, /not retried/);
    assert.equal(harness.endpoint.calls.length, 1, "a failed call is never retried");

    harness.endpoint.respond = (() => { throw new Error("sync /opaque-internal/secret"); }) as never;
    const syncThrown = await harness.request(2, "tools/call", { name: "SubtasksStart" });
    assert.equal(syncThrown.error.code, NATIVE_MCP_ERROR.internalError);
    assert.doesNotMatch(JSON.stringify(syncThrown), /secret/);

    for (const [index, bad] of [{ content: "text" }, { content: [{ text: "no type" }] }, { content: [], isError: "yes" }, null, { content: [], structuredContent: [1] }].entries()) {
      harness.endpoint.respond = async () => bad as never;
      const response = await harness.request(10 + index, "tools/call", { name: "SubtasksStart" });
      assert.equal(response.error?.code, NATIVE_MCP_ERROR.internalError, JSON.stringify(bad));
    }

    harness.endpoint.respond = async () => undefined;
    const unknown = await harness.request(20, "tools/call", { name: "Bash", arguments: {} });
    assert.deepEqual(unknown.error, { code: NATIVE_MCP_ERROR.invalidParams, message: "Unknown tool" });

    harness.endpoint.tools = [{ name: "A", inputSchema: { type: "object" } }, { name: "A", inputSchema: { type: "object" } }];
    assert.equal((await harness.request(21, "tools/list")).error.code, NATIVE_MCP_ERROR.internalError, "duplicate tool names");
    harness.endpoint.tools = [{ name: "A", inputSchema: { type: "string" } }];
    assert.equal((await harness.request(22, "tools/list")).error.code, NATIVE_MCP_ERROR.internalError, "non-object input schema");
    harness.endpoint.tools = [{ name: "", inputSchema: { type: "object" } }];
    assert.equal((await harness.request(23, "tools/list")).error.code, NATIVE_MCP_ERROR.internalError, "empty name");
    harness.endpoint.tools = [{ name: "A", inputSchema: { type: "object" }, secretHandle: "x" }];
    assert.deepEqual((await harness.request(24, "tools/list")).result.tools, [{ name: "A", inputSchema: { type: "object" } }], "unknown descriptor fields dropped");
    harness.endpoint.listTools = async () => { throw new Error("/opaque-internal/secret"); };
    const listFailure = await harness.request(25, "tools/list");
    assert.deepEqual(listFailure.error, { code: NATIVE_MCP_ERROR.internalError, message: "Internal error" });
    assert.equal(harness.session.phase, "ready", "endpoint failures do not close the session");
  } finally {
    harness.dispose();
  }
});

test("malformed frames and envelopes get closed errors and never reach the endpoint", async () => {
  const harness = new Harness();
  try {
    await harness.initialize();
    const call = { name: "SubtasksStart", arguments: { kind: "research" } };
    const malformed: unknown[] = [
      "{ not json",
      "[]",
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: call }]),
      JSON.stringify("tools/call"),
      { jsonrpc: "1.0", id: 1, method: "tools/call", params: call },
      { id: 1, method: "tools/call", params: call },
      { jsonrpc: "2.0", id: null, method: "tools/call", params: call },
      { jsonrpc: "2.0", id: { nested: 1 }, method: "tools/call", params: call },
      { jsonrpc: "2.0", id: true, method: "tools/call", params: call },
      { jsonrpc: "2.0", id: 1, params: call },
      { jsonrpc: "2.0", id: 1, method: 7, params: call },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: call, result: {} },
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 1, error: { code: 1, message: "x" } },
    ];
    const start = harness.frames.length;
    for (const message of malformed) harness.write(message);
    const responses = (await harness.waitFor(start + malformed.length)).slice(start);
    responses.forEach((response, index) => {
      assert.equal(response.id, null, JSON.stringify(malformed[index]));
      assert.equal(response.error.code, index === 0 ? NATIVE_MCP_ERROR.parseError : NATIVE_MCP_ERROR.invalidRequest, JSON.stringify(malformed[index]));
    });
    assert.equal(harness.endpoint.calls.length, 0);

    const before = harness.frames.length;
    for (const params of [[call], "x", { arguments: {} }, { name: "" }, { name: 42 }, { name: "x".repeat(129) }, { name: "SubtasksStart", arguments: [] }, { name: "SubtasksStart", arguments: "{}" }, { name: "SubtasksStart", arguments: null }]) {
      harness.write({ jsonrpc: "2.0", id: 7, method: "tools/call", params });
    }
    const invalidParams = (await harness.waitFor(before + 9)).slice(before);
    for (const response of invalidParams) {
      assert.equal(response.id, 7);
      assert.equal(response.error.code, NATIVE_MCP_ERROR.invalidParams);
    }
    assert.equal(harness.endpoint.calls.length, 0, "invalid params never call the endpoint");
    assert.equal(harness.endpoint.listCalls.length, 0);
    // The session survives non-fatal protocol errors.
    assert.equal((await harness.request(8, "tools/call", call)).result.isError, false);
    assert.equal(harness.endpoint.calls.length, 1);
  } finally {
    harness.dispose();
  }
});

test("notifications, including request methods without an id, never respond or call the endpoint", async () => {
  const harness = new Harness();
  try {
    await harness.initialize();
    const before = harness.frames.length;
    const notifications: unknown[] = [
      { jsonrpc: "2.0", method: "tools/call", params: { name: "SubtasksStart", arguments: { kind: "research" } } },
      { jsonrpc: "2.0", method: "tools/list" },
      { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: { x: 1 } } },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: "x" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999 } },
      { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
      { jsonrpc: "2.0", method: "notifications/whatever", params: [1, 2] },
    ];
    for (const message of notifications) harness.write(message);
    await settle();
    assert.equal(harness.frames.length, before);
    assert.equal(harness.endpoint.calls.length, 0);
    assert.equal(harness.endpoint.listCalls.length, 0);
    assert.equal(harness.session.phase, "ready");
  } finally {
    harness.dispose();
  }
});

test("lifecycle: tools wait for initialized, initialize happens once, notification names are not requests", async () => {
  const harness = new Harness();
  try {
    assert.deepEqual((await harness.request(1, "ping")).result, {}, "ping works before initialize");
    const early = await harness.request(2, "tools/call", { name: "SubtasksStart", arguments: {} });
    assert.equal(early.error.code, NATIVE_MCP_ERROR.notInitialized);
    assert.equal((await harness.request(3, "tools/list")).error.code, NATIVE_MCP_ERROR.notInitialized);
    // initialized before initialize is ignored.
    harness.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    assert.equal(harness.session.phase, "awaiting_initialize");
    await harness.request(4, "initialize", initParams());
    assert.equal((await harness.request(5, "tools/call", { name: "SubtasksStart" })).error.code, NATIVE_MCP_ERROR.notInitialized, "requires notifications/initialized");
    // A notification method sent as a request is unknown and does not advance the lifecycle.
    assert.equal((await harness.request(6, "notifications/initialized")).error.code, NATIVE_MCP_ERROR.methodNotFound);
    assert.equal(harness.session.phase, "awaiting_initialized");
    harness.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    assert.equal((await harness.request(7, "initialize", initParams())).error.code, NATIVE_MCP_ERROR.invalidRequest);
    for (const method of ["resources/list", "prompts/list", "logging/setLevel", "tools/unknown", "sampling/createMessage"]) {
      assert.deepEqual((await harness.request(8, method, {})).error, { code: NATIVE_MCP_ERROR.methodNotFound, message: "Method not found" }, method);
    }
    assert.equal((await harness.request(9, "tools/list", { cursor: "page-2" })).error.code, NATIVE_MCP_ERROR.invalidParams);
    assert.equal(harness.endpoint.calls.length, 0);
    assert.equal(harness.endpoint.listCalls.length, 0);
  } finally {
    harness.dispose();
  }
});

test("frames split across chunks, CRLF endings, and blank lines are handled", async () => {
  const harness = new Harness();
  try {
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ü-client", version: "1" } } });
    const bytes = Buffer.from(`\n\r\n${frame}\r\n`, "utf8");
    // Split inside the multi-byte character as well.
    const split = bytes.indexOf(Buffer.from("ü", "utf8")) + 1;
    harness.input.write(bytes.subarray(0, split));
    await settle();
    assert.equal(harness.frames.length, 0);
    harness.input.write(bytes.subarray(split));
    const [response] = await harness.waitFor(1);
    assert.equal(response!.result.protocolVersion, "2025-06-18");
    assert.equal(harness.frames.length, 1, "blank lines are not frames");
  } finally {
    harness.dispose();
  }
});

test("client cancellation aborts the endpoint call, suppresses the response, and holds the slot until it settles", async () => {
  const harness = new Harness({ limits: { maxInFlightRequests: 1 } });
  try {
    await harness.initialize();
    const held = deferred<NativeMcpCallToolResult | undefined>();
    harness.endpoint.respond = () => held.promise;
    harness.write({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "SubtasksStart", arguments: {} } });
    await settle();
    assert.equal(harness.endpoint.calls.length, 1);
    const signal = harness.endpoint.calls[0]!.signal;
    const before = harness.frames.length;

    // A duplicate id while in flight is refused uncorrelated, without a second call.
    const duplicate = await harness.request(40, "tools/call", { name: "SubtasksStart", arguments: {} });
    assert.deepEqual(duplicate, { jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.invalidRequest, message: "Duplicate request id" } });

    harness.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 40, reason: "user interrupted" } });
    await settle();
    assert.equal(signal.aborted, true);
    assert.equal(harness.session.inFlightCount, 1, "the cancelled call keeps its slot until the endpoint settles");
    const busy = await harness.request(41, "tools/call", { name: "SubtasksStart", arguments: {} });
    assert.equal(busy.error.code, NATIVE_MCP_ERROR.serverBusy);
    assert.equal(harness.endpoint.calls.length, 1);

    held.resolve({ content: [{ type: "text", text: "late" }] });
    await settle();
    assert.equal(harness.session.inFlightCount, 0);
    assert.equal(harness.frames.length, before + 2, "no response for the cancelled request");
    assert.ok(!harness.frames.some((frame) => frame.includes("late")));
    harness.endpoint.respond = async () => ({ content: [] });
    assert.equal((await harness.request(40, "tools/call", { name: "SubtasksStart" })).result.isError, false, "the id is reusable after settlement");
    assert.equal(harness.endpoint.calls.length, 2);
  } finally {
    harness.dispose();
  }
});

test("the in-flight bound refuses excess requests before the endpoint is called", async () => {
  const harness = new Harness({ limits: { maxInFlightRequests: 2 } });
  try {
    await harness.initialize();
    const held = deferred<NativeMcpCallToolResult | undefined>();
    harness.endpoint.respond = () => held.promise;
    for (const id of [1, 2, 3]) harness.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "SubtasksStart", arguments: { id } } });
    const responses = await harness.waitFor(2);
    assert.deepEqual(responses[1], { jsonrpc: "2.0", id: 3, error: { code: NATIVE_MCP_ERROR.serverBusy, message: "Too many concurrent requests; nothing was run" } });
    assert.deepEqual(harness.endpoint.calls.map((call) => call.arguments.id), [1, 2]);
    assert.equal((await harness.request(4, "tools/list")).error.code, NATIVE_MCP_ERROR.serverBusy, "tools/list shares the bound");
    assert.deepEqual((await harness.request(5, "ping")).result, {}, "ping is not delegated and stays available");
    held.resolve({ content: [{ type: "text", text: "done" }] });
    const done = await harness.waitFor(6);
    assert.deepEqual(done.slice(4).map((response) => response.id).sort(), [1, 2]);
  } finally {
    harness.dispose();
  }
});

test("an oversized inbound frame closes the session fail-closed, aborting in-flight calls", async () => {
  const harness = new Harness({ limits: { maxInboundFrameBytes: 1024 } });
  await harness.initialize();
  const held = deferred<NativeMcpCallToolResult | undefined>();
  harness.endpoint.respond = () => held.promise;
  harness.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart", arguments: {} } });
  await settle();
  const signal = harness.endpoint.calls[0]!.signal;
  const before = harness.frames.length;
  const oversized = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksStart", arguments: { pad: "x".repeat(2000) } } });
  const after = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "SubtasksStart", arguments: {} } });
  harness.input.write(`${oversized}\n${after}\n`);
  assert.equal(await harness.session.closed, "oversized_frame");
  await settle();
  assert.deepEqual(harness.responses.slice(before), [{ jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.frameTooLarge, message: "Frame exceeds the size limit" } }]);
  assert.equal(harness.endpoint.calls.length, 1, "neither the oversized frame nor later frames were dispatched");
  assert.equal(signal.aborted, true);
  assert.equal(harness.session.phase, "closed");
  held.resolve({ content: [{ type: "text", text: "late" }] });
  harness.write({ jsonrpc: "2.0", id: 9, method: "ping" });
  await settle();
  assert.equal(harness.frames.length, before + 1, "nothing is written after close");
});

test("an unterminated frame that grows past the bound closes the session without waiting for a newline", async () => {
  const harness = new Harness({ limits: { maxInboundFrameBytes: 1024 } });
  harness.input.write(`{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${"y".repeat(600)}`);
  await settle();
  assert.equal(harness.session.phase, "awaiting_initialize");
  harness.input.write("z".repeat(600));
  assert.equal(await harness.session.closed, "oversized_frame");
  assert.equal(harness.endpoint.calls.length + harness.endpoint.listCalls.length, 0);
});

test("a frame exactly at the inbound bound is accepted", async () => {
  const harness = new Harness({ limits: { maxInboundFrameBytes: 1024 } });
  try {
    const base = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "" } });
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "p".repeat(1024 - Buffer.byteLength(base)) } });
    assert.equal(Buffer.byteLength(frame), 1024);
    harness.input.write(`${frame}\n`);
    assert.deepEqual((await harness.waitFor(1))[0], { jsonrpc: "2.0", id: 1, result: {} });
  } finally {
    harness.dispose();
  }
});

test("invalid UTF-8 closes the session", async () => {
  const harness = new Harness();
  harness.input.write(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
  assert.equal(await harness.session.closed, "invalid_encoding");
  await settle();
  assert.deepEqual(harness.responses, [{ jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.parseError, message: "Parse error" } }]);
});

test("an oversized outbound tool result is withheld with an explicit not-retried error result", async () => {
  const harness = new Harness({ limits: { maxOutboundFrameBytes: 2048 } });
  try {
    await harness.initialize();
    harness.endpoint.respond = async () => ({ content: [{ type: "text", text: "r".repeat(4096) }] });
    const response = await harness.request(1, "tools/call", { name: "SubtasksStart", arguments: {} });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /^Tool result withheld: it exceeded the 2048-byte transport limit\. The call was not retried/);
    assert.equal(harness.endpoint.calls.length, 1);
    harness.endpoint.tools = [{ name: "Big", description: "d".repeat(4096), inputSchema: { type: "object" } }];
    const listed = await harness.request(2, "tools/list");
    assert.equal(listed.error.code, NATIVE_MCP_ERROR.internalError);
    const cyclic: Record<string, unknown> = { type: "text" };
    cyclic.self = cyclic;
    harness.endpoint.respond = async () => ({ content: [cyclic] });
    const unserializable = await harness.request(3, "tools/call", { name: "SubtasksStart" });
    assert.equal(unserializable.result.isError, true, "an unserializable result is withheld, not thrown");
    assert.equal(harness.session.phase, "ready");
  } finally {
    harness.dispose();
  }
});

test("input end aborts in-flight calls and drops late results", async () => {
  const harness = new Harness();
  await harness.initialize();
  const held = deferred<NativeMcpCallToolResult | undefined>();
  harness.endpoint.respond = () => held.promise;
  harness.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart", arguments: {} } });
  await settle();
  const before = harness.frames.length;
  harness.input.end();
  assert.equal(await harness.session.closed, "input_ended");
  assert.equal(harness.endpoint.calls[0]!.signal.aborted, true);
  assert.equal(harness.session.inFlightCount, 0);
  held.resolve({ content: [{ type: "text", text: "late" }] });
  await settle();
  assert.equal(harness.frames.length, before);
  assert.equal(harness.endpoint.calls.length, 1, "nothing is retried");
});

test("an unterminated final frame at input end is discarded, not dispatched", async () => {
  const harness = new Harness();
  await harness.initialize();
  harness.input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } }));
  assert.equal(await harness.session.closed, "input_ended");
  assert.equal(harness.endpoint.calls.length, 0);
});

test("dispose and output close abort in-flight work; endpoint rejections after close stay silent", async () => {
  const disposed = new Harness();
  await disposed.initialize();
  const held = deferred<NativeMcpCallToolResult | undefined>();
  disposed.endpoint.respond = () => held.promise;
  disposed.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } });
  await settle();
  const before = disposed.frames.length;
  disposed.dispose();
  disposed.dispose();
  assert.equal(await disposed.session.closed, "disposed");
  assert.equal(disposed.endpoint.calls[0]!.signal.aborted, true);
  held.reject(new Error("aborted"));
  await settle();
  assert.equal(disposed.frames.length, before);

  const closedOutput = new Harness();
  await closedOutput.initialize();
  const pending = deferred<NativeMcpCallToolResult | undefined>();
  closedOutput.endpoint.respond = () => pending.promise;
  closedOutput.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksStart" } });
  await settle();
  closedOutput.output.destroy();
  assert.equal(await closedOutput.session.closed, "output_closed");
  assert.equal(closedOutput.endpoint.calls[0]!.signal.aborted, true);

  const erroredInput = new Harness();
  erroredInput.input.destroy(new Error("EPIPE /opaque-internal/secret"));
  assert.equal(await erroredInput.session.closed, "input_error");
});

test("output backpressure pauses input reading until drain", async () => {
  let release: (() => void) | undefined;
  const written: string[] = [];
  const slow = new Writable({
    highWaterMark: 16,
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString("utf8"));
      release = callback;
    },
  });
  const input = new PassThrough();
  const session = new NativeMcpStdioSession({ input, output: slow, endpoint: new FakeEndpoint(), serverInfo: { name: "s", version: "1" } });
  try {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await settle();
    assert.equal(written.length, 1);
    assert.equal(input.isPaused(), true, "input pauses while output is not drained");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    await settle();
    assert.equal(written.length, 1, "no new frame is read while paused");
    release!();
    await settle();
    release?.();
    await settle();
    assert.equal(written.length, 2);
    assert.deepEqual(written.map((frame) => JSON.parse(frame).id), [1, 2]);
  } finally {
    session.dispose();
  }
});

test("construction validates the endpoint, serverInfo, instructions, and limits", () => {
  const base = { input: new PassThrough(), output: new PassThrough(), endpoint: new FakeEndpoint(), serverInfo: { name: "s", version: "1" } };
  assert.throws(() => new NativeMcpStdioSession({ ...base, endpoint: {} as NativeMcpToolEndpoint }), /tool endpoint/);
  assert.throws(() => new NativeMcpStdioSession({ ...base, serverInfo: { name: "", version: "1" } }), /serverInfo/);
  assert.throws(() => new NativeMcpStdioSession({ ...base, instructions: 5 as unknown as string }), /instructions/);
  for (const limits of [
    { maxInboundFrameBytes: 0 },
    { maxOutboundFrameBytes: 1.5 },
    { maxInFlightRequests: 0 },
    { maxInFlightRequests: 10_000 },
    { maxInboundFrameBytes: Number.NaN },
    { maxInboundFrameBytes: 4096, maxPendingInboundBytes: 2048 },
    { maxOutboundFrameBytes: 4096, maxPendingOutboundBytes: 2048 },
  ]) {
    assert.throws(() => new NativeMcpStdioSession({ ...base, limits }), /native MCP stdio limit/, JSON.stringify(limits));
  }
  assert.throws(
    () => new NativeMcpStdioSession({ ...base, instructions: "i".repeat(2048), limits: { maxOutboundFrameBytes: 1024 } }),
    /too small for the initialize result/,
    "an initialize result that could never be delivered is refused at construction",
  );
});

/**
 * Writable whose completions can be held, so tests control backpressure.
 * While stalled, writes that reach `highWaterMark` report backpressure (a
 * synchronously completed write does not).
 */
class ControlledWritable extends Writable {
  readonly frames: string[] = [];
  stalled = false;
  private held: Array<() => void> = [];

  constructor(highWaterMark: number) {
    super({ highWaterMark, decodeStrings: false });
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.frames.push(chunk.toString());
    if (this.stalled) this.held.push(() => callback());
    else callback();
  }

  release(): void {
    this.stalled = false;
    for (const done of this.held.splice(0)) done();
  }

  get responses(): Json[] {
    return this.frames.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json);
  }
}

function frameLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

test("a write that closes the session during initialize keeps it closed; later frames in the chunk never dispatch", async () => {
  class ThrowingWritable extends Writable {
    override write(): boolean {
      throw new Error("EPIPE /opaque-internal/secret");
    }
  }
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const session = new NativeMcpStdioSession({ input, output: new ThrowingWritable(), endpoint, serverInfo: { name: "s", version: "1" } });
  input.write(
    frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() })
    + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" })
    + frameLine({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart", arguments: {} } })
    + frameLine({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  );
  assert.equal(await session.closed, "output_error");
  await settle();
  assert.equal(session.phase, "closed", "closed is terminal");
  assert.equal(session.protocolVersion, undefined, "initialization did not advance");
  assert.equal(endpoint.calls.length, 0);
  assert.equal(endpoint.listCalls.length, 0);
});

test("malformed lifecycle messages change nothing", async () => {
  const harness = new Harness();
  try {
    const malformedInit: unknown[] = [
      { protocolVersion: "2025-06-18", clientInfo: { name: "c", version: "1" } },
      { protocolVersion: "2025-06-18", capabilities: [], clientInfo: { name: "c", version: "1" } },
      { protocolVersion: "2025-06-18", capabilities: {} },
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: "claude-code" },
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c" } },
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: 1, version: "1" } },
      { protocolVersion: "", capabilities: {}, clientInfo: { name: "c", version: "1" } },
      { protocolVersion: 20250618, capabilities: {}, clientInfo: { name: "c", version: "1" } },
    ];
    for (const [index, params] of malformedInit.entries()) {
      const response = await harness.request(100 + index, "initialize", params);
      assert.equal(response.error?.code, NATIVE_MCP_ERROR.invalidParams, JSON.stringify(params));
      assert.equal(harness.session.phase, "awaiting_initialize", JSON.stringify(params));
    }
    harness.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    assert.equal((await harness.request(1, "tools/call", { name: "SubtasksStart" })).error.code, NATIVE_MCP_ERROR.notInitialized,
      "a refused initialize leaves tools unavailable");

    await harness.request(2, "initialize", initParams());
    for (const params of ["ready", [1], 0, true, null, { _meta: [] }, { _meta: "x" }, { _meta: { progressToken: 1.5 } }]) {
      harness.write({ jsonrpc: "2.0", method: "notifications/initialized", params });
      await settle();
      assert.equal(harness.session.phase, "awaiting_initialized", `initialized with params ${JSON.stringify(params)}`);
    }
    assert.equal((await harness.request(3, "tools/list")).error.code, NATIVE_MCP_ERROR.notInitialized);
    harness.write({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: {} } });
    await settle();
    assert.equal(harness.session.phase, "ready", "an object params with _meta is valid");

    const held = deferred<NativeMcpCallToolResult | undefined>();
    harness.endpoint.respond = () => held.promise;
    harness.write({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "SubtasksStart" } });
    await settle();
    const signal = harness.endpoint.calls[0]!.signal;
    for (const params of [{ requestId: 50, reason: 7 }, { requestId: 50, reason: { text: "x" } }, { requestId: 50, reason: null }, { requestId: [50] }, { requestId: "50" }, { requestId: 50, _meta: false }, { requestId: 50, _meta: [] }]) {
      harness.write({ jsonrpc: "2.0", method: "notifications/cancelled", params });
      await settle();
      assert.equal(signal.aborted, false, `cancelled with ${JSON.stringify(params)}`);
    }
    const before = harness.frames.length;
    held.resolve({ content: [{ type: "text", text: "kept" }] });
    const responses = await harness.waitFor(before + 1);
    assert.equal(responses[before]!.id, 50);
    assert.equal(responses[before]!.result.content[0].text, "kept");
    assert.equal(harness.endpoint.calls.length, 1);
  } finally {
    harness.dispose();
  }
});

test("output backpressure stops dispatch within the current chunk and resumes in order on drain", async () => {
  const output = new ControlledWritable(1);
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const session = new NativeMcpStdioSession({ input, output, endpoint, serverInfo: { name: "s", version: "1" } });
  try {
    input.write(frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() }) + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await settle();
    assert.equal(session.phase, "ready");
    output.stalled = true;
    input.write(
      frameLine({ jsonrpc: "2.0", id: 1, method: "ping" })
      + frameLine({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksStart", arguments: { n: 2 } } })
      + frameLine({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "SubtasksStart", arguments: { n: 3 } } })
      + frameLine({ jsonrpc: "2.0", id: 4, method: "ping" }),
    );
    await settle();
    assert.deepEqual(output.responses.map((response) => response.id), [0, 1]);
    assert.equal(endpoint.calls.length, 0, "frames after the backed-up reply in the same chunk were not dispatched");
    assert.equal(input.isPaused(), true);
    for (let round = 0; round < 10 && output.responses.length < 5; round += 1) {
      output.release();
      await settle();
    }
    assert.deepEqual(endpoint.calls.map((call) => call.arguments.n), [2, 3], "dispatched once, in order, after drain");
    assert.deepEqual(output.responses.map((response) => response.id), [0, 1, 4, 2, 3],
      "requests were dispatched in order; tool replies queued behind backpressure followed");
    assert.equal(session.phase, "ready");
    assert.equal(input.isPaused(), false, "reading resumed");
  } finally {
    session.dispose();
  }
});

test("a maximum-size outbound frame fits an empty queue with equal limits", async () => {
  const output = new ControlledWritable(16);
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const session = new NativeMcpStdioSession({
    input, output, endpoint, serverInfo: { name: "s", version: "1" },
    limits: { maxOutboundFrameBytes: 1024, maxPendingOutboundBytes: 1024 },
  });
  try {
    input.write(frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() })
      + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await settle();
    assert.equal(session.phase, "ready");
    const held = deferred<NativeMcpCallToolResult>();
    endpoint.respond = () => held.promise;
    input.write(frameLine({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } }));
    output.stalled = true;
    input.write(frameLine({ jsonrpc: "2.0", id: 2, method: "ping" }));
    await settle();
    assert.equal(endpoint.calls.length, 1);
    assert.equal(input.isPaused(), true);
    const result = { content: [{ type: "text", text: "" }], isError: false };
    const reply = { jsonrpc: "2.0", id: 1, result };
    const padding = 1024 - Buffer.byteLength(frameLine(reply));
    result.content[0]!.text = "x".repeat(padding + 1);
    held.resolve(result);
    await settle();
    assert.equal(session.phase, "ready", "an oversized reply must be withheld, not close the queue");
    assert.deepEqual(output.responses.map((response) => response.id), [0, 2]);
    output.release();
    await settle();
    assert.match(output.responses.at(-1)!.result.content[0].text, /^Tool result withheld/);

    const second = deferred<NativeMcpCallToolResult>();
    endpoint.respond = () => second.promise;
    input.write(frameLine({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "SubtasksStart" } }));
    output.stalled = true;
    input.write(frameLine({ jsonrpc: "2.0", id: 4, method: "ping" }));
    await settle();
    reply.id = 3;
    result.content[0]!.text = "x".repeat(padding);
    assert.equal(Buffer.byteLength(frameLine(reply)), 1024);
    second.resolve(result);
    await settle();
    assert.equal(session.phase, "ready");
    assert.equal(output.responses.at(-1)!.id, 4);
    output.release();
    await settle();
    assert.deepEqual(output.responses.at(-1), reply);
  } finally {
    session.dispose();
  }
});

test("replies from calls settling behind backpressure are bounded; overflow closes the session", async () => {
  // A 16-byte high-water mark makes even the ping reply report backpressure.
  const output = new ControlledWritable(16);
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const session = new NativeMcpStdioSession({
    input, output, endpoint, serverInfo: { name: "s", version: "1" },
    limits: { maxOutboundFrameBytes: 1024, maxPendingOutboundBytes: 1024 },
  });
  input.write(frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() }) + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await settle();
  assert.equal(session.phase, "ready");
  const held = [deferred<NativeMcpCallToolResult | undefined>(), deferred<NativeMcpCallToolResult | undefined>(), deferred<NativeMcpCallToolResult | undefined>()];
  endpoint.respond = () => held[endpoint.calls.length - 1]!.promise;
  input.write([1, 2, 3].map((id) => frameLine({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "SubtasksStart" } })).join(""));
  await settle();
  assert.equal(endpoint.calls.length, 3);
  output.stalled = true;
  input.write(frameLine({ jsonrpc: "2.0", id: 9, method: "ping" }));
  await settle();
  assert.equal(input.isPaused(), true, "the stalled ping reply put the session behind backpressure");
  const writtenBefore = output.frames.length;
  const result = () => ({ content: [{ type: "text", text: "r".repeat(600) }] });
  held[0]!.resolve(result());
  await settle();
  assert.equal(session.phase, "ready", "the first reply fits the pending bound and is queued");
  assert.equal(output.frames.length, writtenBefore, "queued replies are not written while backed up");
  held[1]!.resolve(result());
  assert.equal(await session.closed, "output_overflow");
  assert.equal(endpoint.calls[2]!.signal.aborted, true, "overflow aborts the remaining in-flight call");
  assert.ok(output.writableLength <= 16 + 1024 + 1, `output buffer stays bounded (${output.writableLength})`);
  output.release();
  held[2]!.resolve(result());
  await settle();
  assert.ok(!output.responses.some((response) => response.id === 1 || response.id === 2 || response.id === 3), "nothing queued is written after close");
});

test("request ids are bounded so a correlated fallback always fits the outbound bound", async () => {
  const harness = new Harness({ limits: { maxOutboundFrameBytes: 1024 } });
  try {
    await harness.initialize();
    harness.endpoint.respond = async () => ({ content: [{ type: "text", text: "r".repeat(4096) }] });
    for (const id of ["x".repeat(255), "\u0001".repeat(50), "y".repeat(400)]) {
      const before = harness.frames.length;
      harness.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "SubtasksStart" } });
      const response = (await harness.waitFor(before + 1))[before]!;
      assert.deepEqual(response, { jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.invalidRequest, message: "Invalid Request" } });
    }
    assert.equal(harness.endpoint.calls.length, 0, "an over-long id is refused before the endpoint is called");
    const nearLimit = "x".repeat(254);
    assert.equal(Buffer.byteLength(JSON.stringify(nearLimit)), 256);
    const response = await harness.request(nearLimit, "tools/call", { name: "SubtasksStart" });
    assert.equal(response.id, nearLimit);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /^Tool result withheld/);
    harness.endpoint.respond = async () => { throw new Error("boom"); };
    const failed = await harness.request(nearLimit, "tools/call", { name: "SubtasksStart" });
    assert.equal(failed.id, nearLimit);
    assert.equal(failed.error.code, NATIVE_MCP_ERROR.internalError);
    assert.equal(harness.endpoint.calls.length, 2);
    assert.equal(harness.session.phase, "ready");
  } finally {
    harness.dispose();
  }
});

test("no method may answer under an active request id", async () => {
  const harness = new Harness();
  try {
    await harness.initialize();
    const held = deferred<NativeMcpCallToolResult | undefined>();
    harness.endpoint.respond = () => held.promise;
    harness.write({ jsonrpc: "2.0", id: "op-1", method: "tools/call", params: { name: "SubtasksStart" } });
    await settle();
    for (const [method, params] of [["ping", undefined], ["tools/list", undefined], ["tools/call", { name: "SubtasksStart" }], ["initialize", initParams()], ["resources/list", {}]] as const) {
      const response = await harness.request("op-1", method, params);
      assert.deepEqual(response, { jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.invalidRequest, message: "Duplicate request id" } }, method);
    }
    assert.equal(harness.endpoint.calls.length, 1);
    assert.equal(harness.endpoint.listCalls.length, 0);
    assert.ok(!harness.responses.some((response) => response.id === "op-1"), "nothing was answered under the active id");
    const before = harness.frames.length;
    held.resolve({ content: [{ type: "text", text: "the real outcome" }] });
    const responses = await harness.waitFor(before + 1);
    assert.deepEqual(responses.filter((response) => response.id === "op-1").map((response) => response.result.content[0].text), ["the real outcome"]);
  } finally {
    harness.dispose();
  }
});

test("invalid envelope fields and task-augmented calls never delegate", async () => {
  const harness = new Harness();
  try {
    await harness.initialize();
    const fractional = await harness.request(1.5, "tools/call", { name: "SubtasksStart" });
    assert.deepEqual(fractional, { jsonrpc: "2.0", id: null, error: { code: NATIVE_MCP_ERROR.invalidRequest, message: "Invalid Request" } });
    for (const params of [
      { name: "SubtasksStart", arguments: {}, task: {} },
      { name: "SubtasksStart", arguments: {}, task: { ttl: 1000 } },
      { name: "SubtasksStart", arguments: {}, _meta: [] },
      { name: "SubtasksStart", arguments: {}, _meta: false },
      { name: "SubtasksStart", arguments: {}, _meta: { progressToken: 1.5 } },
      { name: "SubtasksStart", arguments: {}, _meta: { progressToken: { x: 1 } } },
    ]) {
      const response = await harness.request(2, "tools/call", params);
      assert.equal(response.error?.code, NATIVE_MCP_ERROR.invalidParams, JSON.stringify(params));
      assert.equal(response.id, 2);
    }
    assert.equal((await harness.request(3, "tools/list", { _meta: [] })).error.code, NATIVE_MCP_ERROR.invalidParams);
    assert.equal(harness.endpoint.calls.length, 0);
    assert.equal(harness.endpoint.listCalls.length, 0);
    // Valid provider metadata is accepted; only the bounded tool-use matching key
    // (#682) reaches the endpoint, never the progress token or anything else.
    const ok = await harness.request(4, "tools/call", { name: "SubtasksStart", arguments: {}, _meta: { progressToken: "tok", "claudecode/toolUseId": "toolu_1" } });
    assert.equal(ok.result.isError, false);
    assert.deepEqual(Object.keys(harness.endpoint.calls[0]!).sort(), ["arguments", "name", "signal", "toolUseId"]);
    assert.equal(harness.endpoint.calls[0]!.toolUseId, "toolu_1");
  } finally {
    harness.dispose();
  }
});

test("the inbound queue bound is enforced per line; blank lines never occupy it", async () => {
  const blank = new Harness({ limits: { maxInboundFrameBytes: 1024, maxPendingInboundBytes: 1024 } });
  try {
    blank.input.write(`${"\n".repeat(5000)}${"   \r\n".repeat(500)}${frameLine({ jsonrpc: "2.0", id: 1, method: "ping" })}`);
    assert.deepEqual((await blank.waitFor(1))[0], { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(blank.session.phase, "awaiting_initialize");
  } finally {
    blank.dispose();
  }

  const harness = new Harness({ limits: { maxInboundFrameBytes: 1024, maxPendingInboundBytes: 1024 } });
  await harness.initialize();
  const frames = [1, 2, 3, 4, 5].map((id) => frameLine({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "SubtasksStart", arguments: { pad: "p".repeat(200) } } }));
  assert.ok(frames.every((frame) => Buffer.byteLength(frame) < 1024), "each frame is individually valid");
  assert.ok(Buffer.byteLength(frames.join("")) > 1024);
  const before = harness.frames.length;
  harness.input.write(frames.join(""));
  assert.equal(await harness.session.closed, "input_overflow");
  await settle();
  assert.equal(harness.endpoint.calls.length, 0, "no frame from the overflowing chunk was dispatched");
  assert.equal(harness.frames.length, before);
});

test("ending the output stops dispatch and aborts in-flight calls even without a close event", async () => {
  const harness = new Harness({ output: new PassThrough({ autoDestroy: false }) });
  await harness.initialize();
  const held = deferred<NativeMcpCallToolResult | undefined>();
  harness.endpoint.respond = () => held.promise;
  harness.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } });
  await settle();
  assert.equal(harness.endpoint.calls.length, 1);
  harness.output.end();
  harness.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "SubtasksStart" } });
  assert.equal(await harness.session.closed, "output_closed");
  await settle();
  assert.equal(harness.endpoint.calls[0]!.signal.aborted, true);
  assert.equal(harness.endpoint.calls.length, 1, "no call starts once the output cannot answer");
  assert.equal(harness.output.destroyed, false, "the stream was not auto-destroyed, so only finish signalled the end");
});

test("destroying input during a reply prevents the next queued tool call", async () => {
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (JSON.parse(chunk.toString()).id === 9) input.destroy();
      done();
    },
  });
  const session = new NativeMcpStdioSession({ input, output, endpoint, serverInfo: { name: "s", version: "1" } });
  input.write(
    frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() })
    + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  await settle();
  assert.equal(session.phase, "ready");
  input.write(
    frameLine({ jsonrpc: "2.0", id: 9, method: "ping" })
    + frameLine({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "SubtasksStart" } }),
  );
  assert.equal(await session.closed, "input_ended");
  assert.equal(endpoint.calls.length, 0);
});

test("destroying input during the initialize reply keeps initialization from advancing", async () => {
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const output = new Writable({
    write(_chunk, _encoding, done) {
      input.destroy(new Error("EPIPE"));
      done();
    },
  });
  const session = new NativeMcpStdioSession({ input, output, endpoint, serverInfo: { name: "s", version: "1" } });
  input.write(
    frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() })
    + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" })
    + frameLine({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } }),
  );
  assert.equal(await session.closed, "input_error");
  await settle();
  assert.equal(session.phase, "closed");
  assert.equal(session.protocolVersion, undefined);
  assert.equal(endpoint.calls.length, 0);
});

test("a pause listener that disposes during a backpressured initialize write leaves the session closed", async () => {
  const output = new ControlledWritable(1);
  const input = new PassThrough();
  const endpoint = new FakeEndpoint();
  const session = new NativeMcpStdioSession({ input, output, endpoint, serverInfo: { name: "s", version: "1" } });
  output.stalled = true;
  let paused = 0;
  input.once("pause", () => { paused += 1; session.dispose(); });
  input.write(
    frameLine({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams() })
    + frameLine({ jsonrpc: "2.0", method: "notifications/initialized" })
    + frameLine({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SubtasksStart" } }),
  );
  assert.equal(await session.closed, "disposed");
  await settle();
  assert.equal(paused, 1, "the initialize reply hit backpressure and paused input");
  assert.equal(output.frames.length, 1, "only the initialize reply was written");
  assert.equal(session.phase, "closed");
  assert.equal(session.protocolVersion, undefined, "initialization did not advance after the session closed");
  assert.equal(endpoint.calls.length, 0);
});
