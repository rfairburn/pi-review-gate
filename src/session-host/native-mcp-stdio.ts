/**
 * #682: transport-only MCP stdio protocol adapter for hosted native tools.
 *
 * Serves the MCP server side of newline-delimited JSON-RPC 2.0 over one
 * caller-supplied input/output stream pair (normally the process's own stdio
 * as launched by a native Claude or Codex CLI). It implements only the MCP
 * envelope:
 *
 * - `initialize` (protocol version negotiation, fixed tools-only capability),
 *   `notifications/initialized`, `ping`, `tools/list`, `tools/call`, and
 *   `notifications/cancelled`;
 * - fixed, non-diagnostic JSON-RPC errors for malformed frames, invalid
 *   envelopes, unknown methods, and lifecycle violations.
 *
 * `tools/list` and `tools/call` are delegated verbatim to an injected
 * {@link NativeMcpToolEndpoint}, supplied later by the trusted owner
 * transport. This module holds no tool schemas, parses no per-tool
 * arguments, applies no permission policy, and grants no authority: the
 * JSON-RPC request id, `_meta`, `clientInfo`, and every other caller-supplied
 * field are correlation or protocol data only and are never passed to the
 * endpoint. It opens no listener and creates no second IPC channel.
 *
 * Fail-closed lifecycle:
 * - Closing is terminal: once closed, nothing is dispatched or written and
 *   the lifecycle never advances again.
 * - An oversized frame or invalid UTF-8 closes the session (after one
 *   `id: null` error) because the byte stream can no longer be trusted.
 * - Input end/error, output close/error/overflow, and
 *   {@link NativeMcpStdioSession.dispose} close the session. Closing aborts
 *   every in-flight endpoint call through its `AbortSignal`, drops any late
 *   result and any frame not yet dispatched, and never retries.
 * - Lifecycle messages are validated before they change state: a malformed
 *   `initialize`, `notifications/initialized`, or `notifications/cancelled`
 *   changes nothing. Request ids must be strings or safe integers, a `_meta`
 *   envelope must be well formed (it is never interpreted or passed on), and
 *   task-augmented `tools/call` (`params.task`, not advertised) is refused.
 * - Output `finish`, like `close`, closes the session; no request is
 *   dispatched once the output can no longer be written.
 * - A `notifications/cancelled` for an in-flight request aborts that call and
 *   suppresses its response, per the MCP cancellation rules; the slot and id
 *   are released only when the endpoint settles.
 * - Response correlation: a request whose id is already active is refused
 *   with an uncorrelated (`id: null`) error before any dispatch, so no second
 *   response is ever written under an active id. Request ids are bounded so a
 *   fixed correlated failure response always fits the outbound bound.
 * - Concurrency is bounded: a request beyond `maxInFlightRequests` is refused
 *   before the endpoint is called.
 * - Backpressure: once the output reports backpressure, no further inbound
 *   frame is dispatched (even from the chunk being processed) and input
 *   reading pauses; undispatched frames and replies from calls that settle
 *   meanwhile are queued under explicit byte bounds and flushed in order on
 *   `drain`. Exceeding either queue bound closes the session.
 */
import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import { BoundedJsonlDecoder, MEBIBYTE } from "../jsonl";

/**
 * Versions this adapter negotiates, newest first. They match the set the
 * native Claude and Codex CLIs were exercised against through the #682 MCP
 * smoke; an unknown requested version is answered with the newest one, as the
 * MCP lifecycle specifies.
 */
export const NATIVE_MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** MCP tool name bound (the MCP tool-name guidance allows 1..128 characters). */
export const NATIVE_MCP_MAX_TOOL_NAME_LENGTH = 128;

export interface NativeMcpStdioLimits {
  /** Largest accepted inbound frame, excluding its newline. Exceeding it closes the session. */
  maxInboundFrameBytes: number;
  /** Largest outbound frame, including its newline. A larger response is replaced by a bounded error. */
  maxOutboundFrameBytes: number;
  /** Concurrent delegated requests (`tools/list` + `tools/call`). Excess requests are refused. */
  maxInFlightRequests: number;
  /**
   * Complete inbound frames held undispatched while the output is backed up
   * (or within one oversized input chunk). Exceeding it closes the session.
   * Must be at least `maxInboundFrameBytes`.
   */
  maxPendingInboundBytes: number;
  /**
   * Replies held while the output is backed up, on top of the output stream's
   * own buffer. Exceeding it closes the session. Must be at least
   * `maxOutboundFrameBytes`.
   */
  maxPendingOutboundBytes: number;
}

export const DEFAULT_NATIVE_MCP_STDIO_LIMITS: Readonly<NativeMcpStdioLimits> = Object.freeze({
  maxInboundFrameBytes: 4 * MEBIBYTE,
  maxOutboundFrameBytes: 16 * MEBIBYTE,
  maxInFlightRequests: 16,
  maxPendingInboundBytes: 8 * MEBIBYTE,
  maxPendingOutboundBytes: 32 * MEBIBYTE,
});

const LIMIT_RANGES: Record<keyof NativeMcpStdioLimits, [number, number]> = {
  maxInboundFrameBytes: [1024, 64 * MEBIBYTE],
  maxOutboundFrameBytes: [1024, 64 * MEBIBYTE],
  maxInFlightRequests: [1, 256],
  maxPendingInboundBytes: [1024, 128 * MEBIBYTE],
  maxPendingOutboundBytes: [1024, 128 * MEBIBYTE],
};

/**
 * Largest accepted request id, measured as its serialized JSON bytes. A
 * larger id is refused uncorrelated before dispatch, which guarantees every
 * fixed correlated failure response fits even the minimum outbound bound.
 */
export const NATIVE_MCP_MAX_REQUEST_ID_BYTES = 256;

/** A tool as the endpoint advertises it. Only these fields are forwarded. */
export interface NativeMcpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** An MCP CallToolResult produced by the endpoint. `content`/`isError` are forwarded as given. */
export interface NativeMcpCallToolResult {
  content: ReadonlyArray<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface NativeMcpListToolsRequest {
  /** Aborted when the session closes or the client cancels the request. */
  signal: AbortSignal;
}

export interface NativeMcpCallToolRequest {
  /** MCP tool name: a non-empty string of at most {@link NATIVE_MCP_MAX_TOOL_NAME_LENGTH} characters. */
  name: string;
  /**
   * The caller's `arguments` object exactly as decoded from this frame
   * (`{}` when omitted). It is freshly parsed and owned by the endpoint; the
   * adapter keeps no reference to it.
   */
  arguments: Record<string, unknown>;
  /** Aborted when the session closes or the client cancels the request. */
  signal: AbortSignal;
}

/**
 * The narrow, trusted delegation surface. The owner transport decides which
 * tools exist, binds authority, and shapes results; the adapter only frames.
 *
 * - `listTools` must be side-effect free; its result is forwarded after a
 *   generic shape check.
 * - `callTool` returns a CallToolResult, or `undefined` when the name is not a
 *   tool the endpoint exposes (answered as JSON-RPC `-32602`). A rejection is
 *   answered with a fixed JSON-RPC error; its message never reaches the client.
 *   The adapter calls it at most once per request and never retries.
 */
export interface NativeMcpToolEndpoint {
  listTools(request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]>;
  callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined>;
}

export interface NativeMcpStdioSessionOptions {
  input: Readable;
  output: Writable;
  endpoint: NativeMcpToolEndpoint;
  serverInfo: { name: string; version: string };
  /** Optional server instructions returned from `initialize`. */
  instructions?: string;
  limits?: Partial<NativeMcpStdioLimits>;
}

export type NativeMcpStdioCloseReason =
  | "input_ended"
  | "input_error"
  | "input_overflow"
  | "output_closed"
  | "output_error"
  | "output_overflow"
  | "oversized_frame"
  | "invalid_encoding"
  | "response_unsendable"
  | "disposed";

export type NativeMcpStdioPhase = "awaiting_initialize" | "awaiting_initialized" | "ready" | "closed";

/** JSON-RPC and MCP error codes used by the adapter. */
export const NATIVE_MCP_ERROR = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Implementation-defined server error: refused before any delegation. */
  serverBusy: -32000,
  /** Implementation-defined server error: frame exceeded the inbound bound. */
  frameTooLarge: -32001,
  /** Implementation-defined server error: request outside the MCP lifecycle. */
  notInitialized: -32002,
});

const TOOL_CALL_FAILED = "Tool call failed in the host; it was not retried and its effects are unknown";

type JsonRpcId = string | number;

/** `sent` includes a reply queued behind output backpressure. */
type SendOutcome = "sent" | "too_large" | "closed";

interface InFlight {
  controller: AbortController;
  /** Cancelled by the client: the response is suppressed, but the slot and id stay held until the endpoint settles. */
  cancelled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP request ids are strings or integers. */
function isRequestId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

/**
 * Common MCP params envelope: absent, or an object whose optional `_meta` is
 * an object with an optional string/integer `progressToken`. `_meta` is
 * validated for shape only; it is never interpreted further or passed on.
 */
function validEnvelopeParams(value: unknown): value is Record<string, unknown> | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const meta = value._meta;
  return meta === undefined || (isRecord(meta) && (meta.progressToken === undefined || isRequestId(meta.progressToken)));
}

function idKey(id: JsonRpcId): string {
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

function serializedIdBytes(id: JsonRpcId): number {
  return Buffer.byteLength(JSON.stringify(id));
}

function resolveLimits(overrides: Partial<NativeMcpStdioLimits> | undefined): NativeMcpStdioLimits {
  const limits = { ...DEFAULT_NATIVE_MCP_STDIO_LIMITS, ...(overrides ?? {}) };
  for (const key of Object.keys(LIMIT_RANGES) as Array<keyof NativeMcpStdioLimits>) {
    const [min, max] = LIMIT_RANGES[key];
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`native MCP stdio limit ${key} must be an integer between ${min} and ${max}`);
    }
  }
  if (limits.maxPendingInboundBytes < limits.maxInboundFrameBytes) {
    throw new Error("native MCP stdio limit maxPendingInboundBytes must be at least maxInboundFrameBytes");
  }
  if (limits.maxPendingOutboundBytes < limits.maxOutboundFrameBytes) {
    throw new Error("native MCP stdio limit maxPendingOutboundBytes must be at least maxOutboundFrameBytes");
  }
  return limits;
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= NATIVE_MCP_MAX_TOOL_NAME_LENGTH;
}

/** MCP `Implementation`: required string name and version. */
function validImplementation(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && typeof value.version === "string";
}

/** Generic MCP Tool shape check; copies only the forwarded fields. */
function toolDescriptors(value: unknown): NativeMcpToolDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  const tools: NativeMcpToolDescriptor[] = [];
  for (const tool of value) {
    if (!isRecord(tool) || !validToolName(tool.name) || names.has(tool.name)) return undefined;
    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== "object") return undefined;
    if (tool.description !== undefined && typeof tool.description !== "string") return undefined;
    if (tool.title !== undefined && typeof tool.title !== "string") return undefined;
    if (tool.outputSchema !== undefined && (!isRecord(tool.outputSchema) || tool.outputSchema.type !== "object")) return undefined;
    if (tool.annotations !== undefined && !isRecord(tool.annotations)) return undefined;
    names.add(tool.name);
    tools.push({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations as Record<string, unknown> } : {}),
    });
  }
  return tools;
}

/** Generic CallToolResult shape check; forwards content, structuredContent, and isError. */
function callToolResult(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  if (!value.content.every((item) => isRecord(item) && typeof item.type === "string")) return undefined;
  if (value.isError !== undefined && typeof value.isError !== "boolean") return undefined;
  if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) return undefined;
  return {
    content: value.content,
    ...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
    isError: value.isError === true,
  };
}

function withheldResult(maxOutboundFrameBytes: number): Record<string, unknown> {
  return {
    content: [{ type: "text", text: `Tool result withheld: it exceeded the ${maxOutboundFrameBytes}-byte transport limit. The call was not retried and its effects may have been applied.` }],
    isError: true,
  };
}

/** Bounded FIFO of serialized frames with byte accounting. */
class FrameQueue {
  private items: string[] = [];
  private head = 0;
  bytes = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(frame: string, bytes: number): void {
    this.items.push(frame);
    this.bytes += bytes;
  }

  shift(): string | undefined {
    if (this.head >= this.items.length) return undefined;
    const frame = this.items[this.head]!;
    this.items[this.head] = "";
    this.head += 1;
    this.bytes -= Buffer.byteLength(frame);
    if (this.head === this.items.length) this.clear();
    return frame;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.bytes = 0;
  }
}

/**
 * One MCP stdio server session over a caller-owned stream pair. The session
 * attaches on construction and never ends or destroys the streams itself; the
 * owner observes {@link closed} and decides process teardown.
 */
export class NativeMcpStdioSession {
  /** Settles once with the first close reason. */
  readonly closed: Promise<NativeMcpStdioCloseReason>;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly endpoint: NativeMcpToolEndpoint;
  private readonly serverInfo: { name: string; version: string };
  private readonly instructions: string | undefined;
  private readonly limits: NativeMcpStdioLimits;
  private readonly decoder: BoundedJsonlDecoder;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private readonly inFlight = new Map<string, InFlight>();
  /** Complete inbound frames not yet dispatched. */
  private readonly inbox = new FrameQueue();
  /** Serialized replies (with newline) held behind output backpressure. */
  private readonly outbox = new FrameQueue();
  private phaseValue: NativeMcpStdioPhase = "awaiting_initialize";
  private negotiatedVersion: string | undefined;
  private awaitingDrain = false;
  private pumping = false;
  /** Set when a decoded line would exceed the inbound queue bound; the chunk is then never dispatched. */
  private inboxOverflowed = false;
  private resolveClosed!: (reason: NativeMcpStdioCloseReason) => void;
  private readonly detachers: Array<() => void> = [];

  constructor(options: NativeMcpStdioSessionOptions) {
    if (!options || typeof options.endpoint?.listTools !== "function" || typeof options.endpoint?.callTool !== "function") {
      throw new Error("native MCP stdio session requires a tool endpoint");
    }
    if (!validServerInfo(options.serverInfo)) throw new Error("native MCP stdio session requires serverInfo name and version");
    if (options.instructions !== undefined && typeof options.instructions !== "string") throw new Error("instructions must be a string");
    this.limits = resolveLimits(options.limits);
    this.input = options.input;
    this.output = options.output;
    this.endpoint = options.endpoint;
    this.serverInfo = { name: options.serverInfo.name, version: options.serverInfo.version };
    this.instructions = options.instructions;
    this.assertFixedResponsesFit();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.decoder = new BoundedJsonlDecoder((line) => this.enqueue(line), this.limits.maxInboundFrameBytes);
    this.attach();
  }

  get phase(): NativeMcpStdioPhase {
    return this.phaseValue;
  }

  /** The negotiated MCP protocol version, once `initialize` succeeded. */
  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  /** Delegated requests whose endpoint call has not settled (including client-cancelled ones). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Closes the session: aborts in-flight endpoint calls, stops reading, and writes nothing further. */
  dispose(): void {
    this.close("disposed");
  }

  /**
   * The initialize result and every fixed correlated failure must fit the
   * outbound bound with the largest accepted id, so a request the adapter
   * accepted can always be answered.
   */
  private assertFixedResponsesFit(): void {
    const id = "x".repeat(NATIVE_MCP_MAX_REQUEST_ID_BYTES - 2);
    const frames = [
      { jsonrpc: "2.0", id, result: this.initializeResult(NATIVE_MCP_SUPPORTED_PROTOCOL_VERSIONS[0]) },
      { jsonrpc: "2.0", id, result: withheldResult(this.limits.maxOutboundFrameBytes) },
      { jsonrpc: "2.0", id, error: { code: NATIVE_MCP_ERROR.internalError, message: TOOL_CALL_FAILED } },
    ];
    for (const frame of frames) {
      if (Buffer.byteLength(JSON.stringify(frame)) + 1 > this.limits.maxOutboundFrameBytes) {
        throw new Error("native MCP stdio maxOutboundFrameBytes is too small for the initialize result or fixed failure responses");
      }
    }
  }

  private attach(): void {
    const on = (stream: Readable | Writable, event: string, listener: (...args: any[]) => void) => {
      stream.on(event, listener);
      this.detachers.push(() => stream.off(event, listener));
    };
    on(this.input, "data", (chunk: Buffer | string) => this.onData(chunk));
    on(this.input, "end", () => this.close("input_ended"));
    on(this.input, "close", () => this.close("input_ended"));
    on(this.input, "error", () => this.close("input_error"));
    on(this.output, "error", () => this.close("output_error"));
    on(this.output, "close", () => this.close("output_closed"));
    // `finish` need not be followed by `close` (for example without autoDestroy).
    on(this.output, "finish", () => this.close("output_closed"));
    on(this.output, "drain", () => this.onDrain());
    if (this.input.readableEnded || this.input.destroyed) {
      queueMicrotask(() => this.close("input_ended"));
    } else if (!this.output.writable) {
      queueMicrotask(() => this.close("output_closed"));
    } else {
      this.input.resume();
    }
  }

  private get isClosed(): boolean {
    return this.phaseValue === "closed";
  }

  private close(reason: NativeMcpStdioCloseReason): void {
    if (this.isClosed) return;
    this.phaseValue = "closed";
    for (const detach of this.detachers.splice(0)) detach();
    // Keep a sink for late stream errors so they never surface as uncaught.
    this.input.on("error", ignore);
    this.output.on("error", ignore);
    if (!this.input.destroyed) this.input.pause();
    this.inbox.clear();
    this.outbox.clear();
    const pending = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const entry of pending) entry.controller.abort();
    this.resolveClosed(reason);
  }

  private onData(chunk: Buffer | string): void {
    if (this.isClosed) return;
    let text: string;
    try {
      text = typeof chunk === "string" ? chunk : this.utf8.decode(chunk, { stream: true });
    } catch {
      this.failStream("invalid_encoding", NATIVE_MCP_ERROR.parseError, "Parse error");
      return;
    }
    this.decoder.push(text);
    // Frames decoded alongside an oversized one, or in a chunk that overflowed
    // the inbound queue, are never dispatched.
    if (this.decoder.stats().oversizedRecords > 0) {
      this.failStream("oversized_frame", NATIVE_MCP_ERROR.frameTooLarge, "Frame exceeds the size limit");
      return;
    }
    if (this.inboxOverflowed) {
      this.close("input_overflow");
      return;
    }
    this.pump();
  }

  /** Decoder callback: blank lines are dropped; the queue bound is enforced before every enqueue. */
  private enqueue(line: string): void {
    if (this.isClosed || this.inboxOverflowed || line.trim().length === 0) return;
    const bytes = Buffer.byteLength(line);
    if (this.inbox.bytes + bytes > this.limits.maxPendingInboundBytes) {
      this.inboxOverflowed = true;
      return;
    }
    this.inbox.push(line, bytes);
  }

  private failStream(reason: NativeMcpStdioCloseReason, code: number, message: string): void {
    if (this.isClosed) return;
    this.inbox.clear();
    this.send({ jsonrpc: "2.0", id: null, error: { code, message } });
    this.close(reason);
  }

  /** Dispatches queued inbound frames in order until output backs up or the session closes. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.isClosed && !this.awaitingDrain) {
        const line = this.inbox.shift();
        if (line === undefined) break;
        this.onFrame(line);
      }
    } finally {
      this.pumping = false;
    }
    if (this.isClosed) return;
    if (this.awaitingDrain) this.input.pause();
    else this.input.resume();
  }

  private onDrain(): void {
    if (!this.awaitingDrain || this.isClosed) return;
    this.awaitingDrain = false;
    // Replies held during backpressure go first, in order.
    while (!this.isClosed && !this.awaitingDrain) {
      const frame = this.outbox.shift();
      if (frame === undefined) break;
      this.write(frame);
    }
    this.pump();
  }

  /**
   * Synchronous stream-state check. Stream `close`/`end` events are deferred,
   * so a stream destroyed or ended mid-chunk (for example by a write
   * callback) is detected here before any further dispatch or write.
   */
  private streamsOpen(): boolean {
    if (this.isClosed) return false;
    if (this.input.destroyed || this.input.readableEnded) {
      this.close(this.input.errored ? "input_error" : "input_ended");
      return false;
    }
    if (!this.output.writable) {
      this.close(this.output.errored ? "output_error" : "output_closed");
      return false;
    }
    return true;
  }

  private onFrame(line: string): void {
    // A request is never dispatched once the client disconnected or its
    // answer could not be written.
    if (!this.streamsOpen()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.sendError(null, NATIVE_MCP_ERROR.parseError, "Parse error");
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: unknown): void {
    // Batches (removed from MCP in 2025-06-18) and non-objects are invalid.
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || "result" in message || "error" in message) {
      this.sendError(null, NATIVE_MCP_ERROR.invalidRequest, "Invalid Request");
      return;
    }
    const method = message.method;
    if (!("id" in message)) {
      this.handleNotification(method, message.params);
      return;
    }
    if (!isRequestId(message.id) || serializedIdBytes(message.id) > NATIVE_MCP_MAX_REQUEST_ID_BYTES) {
      this.sendError(null, NATIVE_MCP_ERROR.invalidRequest, "Invalid Request");
      return;
    }
    const id = message.id;
    // Never answer under an id that is still active, whatever the method:
    // the client would take it as the outcome of the running request.
    if (this.inFlight.has(idKey(id))) {
      this.sendError(null, NATIVE_MCP_ERROR.invalidRequest, "Duplicate request id");
      return;
    }
    const params = message.params;
    if (!validEnvelopeParams(params)) {
      this.sendError(id, NATIVE_MCP_ERROR.invalidParams, "Invalid params");
      return;
    }
    switch (method) {
      case "ping":
        this.sendResult(id, {});
        return;
      case "initialize":
        this.handleInitialize(id, params);
        return;
      case "tools/list":
      case "tools/call":
        if (this.phaseValue !== "ready") {
          this.sendError(id, NATIVE_MCP_ERROR.notInitialized, "Session is not initialized");
          return;
        }
        if (method === "tools/list") this.handleToolsList(id, params);
        else this.handleToolsCall(id, params);
        return;
      default:
        this.sendError(id, NATIVE_MCP_ERROR.methodNotFound, "Method not found");
    }
  }

  /**
   * Notifications never produce a response and never reach the endpoint. A
   * malformed lifecycle notification changes nothing.
   */
  private handleNotification(method: string, params: unknown): void {
    if (!validEnvelopeParams(params)) return;
    if (method === "notifications/initialized") {
      if (this.phaseValue === "awaiting_initialized") this.phaseValue = "ready";
      return;
    }
    if (method === "notifications/cancelled") {
      if (!isRecord(params) || !isRequestId(params.requestId)) return;
      if (params.reason !== undefined && typeof params.reason !== "string") return;
      const entry = this.inFlight.get(idKey(params.requestId));
      if (!entry || entry.cancelled) return;
      // The cancelled request gets no response; any late result is dropped.
      // Its slot and id stay held until the endpoint settles, so an endpoint
      // that is slow to honor the abort cannot exceed the in-flight bound.
      entry.cancelled = true;
      entry.controller.abort();
    }
    // Every other notification (including request methods sent without an id) is ignored.
  }

  private initializeResult(protocolVersion: string): Record<string, unknown> {
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { ...this.serverInfo },
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
    };
  }

  private handleInitialize(id: JsonRpcId, params: Record<string, unknown> | undefined): void {
    if (this.phaseValue !== "awaiting_initialize") {
      this.sendError(id, NATIVE_MCP_ERROR.invalidRequest, "Session is already initialized");
      return;
    }
    // MCP InitializeRequest requires protocolVersion, capabilities, and
    // clientInfo. They are validated for shape only: clientInfo and client
    // capabilities carry no authority and are never read further.
    if (!params || typeof params.protocolVersion !== "string" || params.protocolVersion.length === 0
      || !isRecord(params.capabilities) || !validImplementation(params.clientInfo)) {
      this.sendError(id, NATIVE_MCP_ERROR.invalidParams, "Invalid params");
      return;
    }
    const requested = params.protocolVersion;
    const supported = NATIVE_MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[];
    const protocolVersion = supported.includes(requested) ? requested : supported[0]!;
    // Only a delivered (or queued) result advances the lifecycle; a write
    // that closed the session leaves it closed.
    if (this.sendResult(id, this.initializeResult(protocolVersion)) !== "sent") return;
    this.negotiatedVersion = protocolVersion;
    this.phaseValue = "awaiting_initialized";
  }

  private handleToolsList(id: JsonRpcId, params: Record<string, unknown> | undefined): void {
    // The adapter never issues a cursor, so a supplied one cannot be valid
    // (an explicit null is the same as no cursor).
    if (params?.cursor !== undefined && params.cursor !== null) {
      this.sendError(id, NATIVE_MCP_ERROR.invalidParams, "Invalid params");
      return;
    }
    this.delegate(id, (signal) => this.endpoint.listTools({ signal }), (value) => {
      const tools = toolDescriptors(value);
      if (!tools) {
        this.sendError(id, NATIVE_MCP_ERROR.internalError, "Internal error");
        return;
      }
      if (this.sendResult(id, { tools }) === "too_large") {
        this.sendError(id, NATIVE_MCP_ERROR.internalError, "Tool list exceeds the transport size limit");
      }
    }, () => this.sendError(id, NATIVE_MCP_ERROR.internalError, "Internal error"));
  }

  private handleToolsCall(id: JsonRpcId, params: Record<string, unknown> | undefined): void {
    // `task` requests task-augmented execution, which this adapter does not
    // advertise; it is refused rather than run as an ordinary call.
    if (!params || params.task !== undefined || !validToolName(params.name)) {
      this.sendError(id, NATIVE_MCP_ERROR.invalidParams, "Invalid params");
      return;
    }
    if (params.arguments !== undefined && !isRecord(params.arguments)) {
      this.sendError(id, NATIVE_MCP_ERROR.invalidParams, "Invalid params");
      return;
    }
    const name = params.name;
    // Only the name and arguments cross: `_meta`, the request id, and any
    // other field never reach the endpoint.
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    this.delegate(id, (signal) => this.endpoint.callTool({ name, arguments: args, signal }), (value) => {
      if (value === undefined) {
        this.sendError(id, NATIVE_MCP_ERROR.invalidParams, "Unknown tool");
        return;
      }
      const result = callToolResult(value);
      if (!result) {
        this.sendError(id, NATIVE_MCP_ERROR.internalError, TOOL_CALL_FAILED);
        return;
      }
      if (this.sendResult(id, result) === "too_large") {
        // The call already ran; say so instead of inviting a blind retry.
        // The fallback always fits (see assertFixedResponsesFit).
        if (this.sendResult(id, withheldResult(this.limits.maxOutboundFrameBytes)) === "too_large") this.close("response_unsendable");
      }
    }, () => this.sendError(id, NATIVE_MCP_ERROR.internalError, TOOL_CALL_FAILED));
  }

  /**
   * Runs one endpoint call with its own abort controller. Settlement after
   * close or cancellation is dropped; the endpoint is never called twice.
   * The caller has already refused active-id collisions.
   */
  private delegate<T>(
    id: JsonRpcId,
    invoke: (signal: AbortSignal) => Promise<T>,
    onValue: (value: T) => void,
    onFailure: () => void,
  ): void {
    if (this.inFlight.size >= this.limits.maxInFlightRequests) {
      this.sendError(id, NATIVE_MCP_ERROR.serverBusy, "Too many concurrent requests; nothing was run");
      return;
    }
    const key = idKey(id);
    const entry: InFlight = { controller: new AbortController(), cancelled: false };
    this.inFlight.set(key, entry);
    // Releases the slot; true only when the response should still be sent.
    const settle = (): boolean => {
      if (this.inFlight.get(key) !== entry) return false;
      this.inFlight.delete(key);
      return !this.isClosed && !entry.cancelled;
    };
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(invoke(entry.controller.signal));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then((value) => {
      if (!settle()) return;
      try {
        onValue(value);
      } catch {
        onFailure();
      }
    }, () => {
      if (!settle()) return;
      onFailure();
    });
  }

  private sendResult(id: JsonRpcId, result: unknown): SendOutcome {
    return this.send({ jsonrpc: "2.0", id, result });
  }

  /**
   * Fixed errors always fit for an accepted id; if one ever cannot be sent,
   * the session closes visibly rather than leaving a request unanswered.
   */
  private sendError(id: JsonRpcId | null, code: number, message: string): void {
    if (this.send({ jsonrpc: "2.0", id, error: { code, message } }) === "too_large") this.close("response_unsendable");
  }

  /**
   * Serializes and writes (or, behind backpressure, queues) one frame.
   * `too_large` writes nothing; `closed` means the session is or became closed.
   */
  private send(message: Record<string, unknown>): SendOutcome {
    if (this.isClosed) return "closed";
    let frame: string;
    try {
      frame = JSON.stringify(message);
    } catch {
      return "too_large";
    }
    if (typeof frame !== "string") return "too_large";
    // Wire bytes, newline included: the same count bounds the frame and the
    // queue, so any admitted frame fits an empty queue.
    const bytes = Buffer.byteLength(frame) + 1;
    if (bytes > this.limits.maxOutboundFrameBytes) return "too_large";
    const line = `${frame}\n`;
    if (this.awaitingDrain) {
      if (this.outbox.bytes + bytes > this.limits.maxPendingOutboundBytes) {
        this.close("output_overflow");
        return "closed";
      }
      this.outbox.push(line, bytes);
      return "sent";
    }
    return this.write(line) ? "sent" : "closed";
  }

  /** Writes one serialized line; returns false when the write closed the session. */
  private write(line: string): boolean {
    if (!this.streamsOpen()) return false;
    let flushed: boolean;
    try {
      flushed = this.output.write(line);
    } catch {
      this.close("output_error");
      return false;
    }
    // A write callback may synchronously destroy either stream.
    if (!this.streamsOpen()) return false;
    if (!flushed && !this.awaitingDrain) {
      this.awaitingDrain = true;
      // A caller-provided pause listener may close the session synchronously.
      this.input.pause();
    }
    return this.streamsOpen();
  }
}

function validServerInfo(value: unknown): value is { name: string; version: string } {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0 && typeof value.version === "string" && value.version.length > 0;
}

function ignore(): void {}

/** Starts one MCP stdio session over the given streams. */
export function startNativeMcpStdioSession(options: NativeMcpStdioSessionOptions): NativeMcpStdioSession {
  return new NativeMcpStdioSession(options);
}
