/**
 * #682 slice 1b: TEST/DEVELOPMENT-ONLY loopback mock model providers for the
 * shared Subtasks MCP smoke (see ./managed-tool-mcp-smoke.ts).
 *
 * One scripted plan drives both native CLIs, so a run needs no provider
 * account, no credential, and no live prompt. The mock listens on 127.0.0.1
 * only, accepts one synthetic API key, and answers:
 * - Anthropic Messages (`POST /v1/messages`) for Claude Code;
 * - OpenAI Responses (`POST /v1/responses`) for Codex.
 *
 * The plan step is derived from the conversation history the CLI sends, so a
 * retried request replays the same step. Each step issues one tool call:
 *  0. (Claude only, when the MCP tools are deferred) native ToolSearch
 *     `select:` for the two smoke tools — Claude's default ToolSearch path;
 *  1. (second launch only) SubtasksInspect with the FIRST launch's handles,
 *     which belong to another owner and must be denied;
 *  2. SubtasksStart with kind execute, which smoke authority must refuse;
 *  3. SubtasksStart with kind research — the real admission;
 *  4. SubtasksInspect with the handles step 3 returned;
 *  5. SubtasksInspect without taskId — canonical validation must reject it;
 * then a final `SMOKE-DONE` text. The journal records, in sanitized form,
 * every request and every tool result the CLI delivered back.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SMOKE_MCP_KEY, classifyResult, type SmokeResultClass } from "./managed-tool-mcp-smoke-owner";

export const SMOKE_SYNTHETIC_API_KEY = "prg-smoke-synthetic-key-not-a-credential";
export const SMOKE_DONE_TEXT = "SMOKE-DONE";
export const SMOKE_TASK_TITLE = "prg smoke research probe";
const EXECUTION_HANDLE = /exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const TASK_HANDLE = /task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface SmokeHandles {
  executionId: string;
  taskId: string;
}

export type SmokeStepName = "tool_search" | "inspect_foreign" | "start_execute" | "start_research" | "inspect_own" | "inspect_invalid";

export interface SmokePlanCall {
  step: SmokeStepName;
  /** Bare smoke tool name, or ToolSearch. */
  tool: "ToolSearch" | "SubtasksStart" | "SubtasksInspect";
  input: Record<string, unknown>;
}

export interface JournalEntry {
  event: string;
  [key: string]: unknown;
}

export interface MockProvider {
  readonly baseUrl: string;
  readonly journal: JournalEntry[];
  /** Plan for the next launch; replaces the previous one. */
  setLaunch(label: string, foreign?: SmokeHandles): void;
  close(): Promise<void>;
}

export interface ObservedToolResult {
  step: SmokeStepName;
  text: string;
  isError?: boolean;
}

/** Steps after any ToolSearch, given the foreign handles (second launch) and the Start result. */
export function nextSmokeCall(results: ObservedToolResult[], foreign: SmokeHandles | undefined, needsToolSearch: boolean): SmokePlanCall | undefined {
  const done = new Set(results.map((result) => result.step));
  if (needsToolSearch && !done.has("tool_search")) {
    return {
      step: "tool_search",
      tool: "ToolSearch",
      input: { query: `select:mcp__${SMOKE_MCP_KEY}__SubtasksStart,mcp__${SMOKE_MCP_KEY}__SubtasksInspect`, max_results: 5 },
    };
  }
  if (foreign && !done.has("inspect_foreign")) {
    return { step: "inspect_foreign", tool: "SubtasksInspect", input: { executionId: foreign.executionId, taskId: foreign.taskId } };
  }
  const task = { title: SMOKE_TASK_TITLE, instructions: "Read-only smoke probe; never dispatched.", acceptanceCriteria: ["queued"] };
  if (!done.has("start_execute")) return { step: "start_execute", tool: "SubtasksStart", input: { kind: "execute", tasks: [task] } };
  if (!done.has("start_research")) return { step: "start_research", tool: "SubtasksStart", input: { kind: "research", tasks: [task] } };
  const started = results.find((result) => result.step === "start_research");
  const handles = started ? handlesInText(started.text) : undefined;
  if (!handles) return undefined;
  if (!done.has("inspect_own")) return { step: "inspect_own", tool: "SubtasksInspect", input: { ...handles } };
  if (!done.has("inspect_invalid")) return { step: "inspect_invalid", tool: "SubtasksInspect", input: { executionId: handles.executionId } };
  return undefined;
}

export function handlesInText(text: string): SmokeHandles | undefined {
  const executionId = EXECUTION_HANDLE.exec(text)?.[0];
  const taskId = TASK_HANDLE.exec(text)?.[0];
  return executionId && taskId ? { executionId, taskId } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sanitized view of one tool result the CLI delivered back: the plan step,
 * the result class, and validated handles only. Raw text is never journaled,
 * because canonical errors can echo caller-supplied values.
 */
export function deliveredResult(result: ObservedToolResult): { step: SmokeStepName; isError: boolean | null; resultClass: SmokeResultClass | "tool_search_loaded"; handles: SmokeHandles | null } {
  // Codex prefixes MCP results with a wall-time header.
  const text = result.text.replace(/^Wall time:[^\n]*\nOutput:\n/, "");
  const resultClass = result.step === "tool_search" && /tool_reference:mcp__/.test(text) ? "tool_search_loaded" : classifyResult(text, result.isError);
  return { step: result.step, isError: result.isError ?? null, resultClass, handles: handlesInText(text) ?? null };
}

/** Call ids encode the plan step so history can be replayed without server state. */
function callId(step: SmokeStepName): string {
  return `prgsmoke_${step}`;
}

function stepOfCallId(id: unknown): SmokeStepName | undefined {
  if (typeof id !== "string" || !id.startsWith("prgsmoke_")) return undefined;
  // Only fixed plan step names; any other suffix is not one of our calls.
  const step = id.slice("prgsmoke_".length);
  switch (step) {
    case "tool_search":
    case "inspect_foreign":
    case "start_execute":
    case "start_research":
    case "inspect_own":
    case "inspect_invalid":
      return step;
    default:
      return undefined;
  }
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (value.type === "tool_reference" && typeof value.tool_name === "string") return `tool_reference:${value.tool_name}`;
    if ("content" in value) return flattenText(value.content);
    return JSON.stringify(value);
  }
  return "";
}

// ---------------------------------------------------------------- Anthropic

function anthropicResults(body: Record<string, unknown>): ObservedToolResult[] {
  const results: ObservedToolResult[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const step = stepOfCallId(block.tool_use_id);
      if (step) results.push({ step, text: flattenText(block.content), isError: block.is_error === true });
    }
  }
  return results;
}

function anthropicToolNames(body: Record<string, unknown>): Array<{ name: string; deferred: boolean }> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((tool) => isRecord(tool) && typeof tool.name === "string" ? [{ name: tool.name, deferred: tool.defer_loading === true }] : []);
}

function writeAnthropic(res: ServerResponse, model: unknown, block: Record<string, unknown>, stream: boolean): void {
  const stopReason = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = { id: `msg_prgsmoke_${Date.now()}`, type: "message", role: "assistant", model: typeof model === "string" ? model : "mock" };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (block.type === "tool_use") {
    send("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  res.end();
}

// ------------------------------------------------------------------ OpenAI

interface ResponsesToolShape {
  /** "namespace" when the CLI groups MCP tools under `mcp__<server>`; "flat" for `mcp__<server>__<tool>` functions. */
  form: "namespace" | "flat";
  names: string[];
}

function responsesToolShape(body: Record<string, unknown>): ResponsesToolShape | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const namespace = `mcp__${SMOKE_MCP_KEY}`;
  for (const tool of tools) {
    if (isRecord(tool) && tool.type === "namespace" && tool.name === namespace && Array.isArray(tool.tools)) {
      return { form: "namespace", names: tool.tools.flatMap((inner) => isRecord(inner) && typeof inner.name === "string" ? [inner.name] : []) };
    }
  }
  const flat = tools.flatMap((tool) => isRecord(tool) && typeof tool.name === "string" && tool.name.startsWith(`${namespace}__`) ? [tool.name.slice(namespace.length + 2)] : []);
  return flat.length > 0 ? { form: "flat", names: flat } : undefined;
}

function responsesResults(body: Record<string, unknown>): ObservedToolResult[] {
  const input = Array.isArray(body.input) ? body.input : [];
  const results: ObservedToolResult[] = [];
  for (const item of input) {
    if (!isRecord(item) || item.type !== "function_call_output") continue;
    const step = stepOfCallId(item.call_id);
    if (!step) continue;
    let text = flattenText(item.output);
    // Some Codex releases wrap MCP results as a JSON-encoded CallToolResult.
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) || Array.isArray(parsed)) text = flattenText(parsed);
    } catch {
      // Plain text output.
    }
    results.push({ step, text });
  }
  return results;
}

function writeResponses(res: ServerResponse, item: Record<string, unknown>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `resp_prgsmoke_${Date.now()}`;
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("response.created", { response: { id } });
  send("response.output_item.added", { output_index: 0, item });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", {
    response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } },
  });
  res.end();
}

// ------------------------------------------------------------------ server

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function authorized(req: IncomingMessage): boolean {
  const bearer = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  return bearer === `Bearer ${SMOKE_SYNTHETIC_API_KEY}` || apiKey === SMOKE_SYNTHETIC_API_KEY;
}

export async function startMockProvider(): Promise<MockProvider> {
  const journal: JournalEntry[] = [];
  let launch = "unset";
  let foreign: SmokeHandles | undefined;
  const record = (entry: JournalEntry) => journal.push({ ...entry, launch });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?", 1)[0] ?? "";
      if (req.method !== "POST" || (path !== "/v1/messages" && path !== "/v1/responses")) {
        record({ event: "request_unhandled" });
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (!authorized(req)) {
        record({ event: "request_unauthorized", path });
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: "synthetic smoke key required" } }));
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (!isRecord(body)) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (path === "/v1/messages") handleAnthropic(body, res);
      else handleResponses(body, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const handleAnthropic = (body: Record<string, unknown>, res: ServerResponse) => {
    const tools = anthropicToolNames(body);
    const smokeTools = tools.filter((tool) => tool.name.startsWith(`mcp__${SMOKE_MCP_KEY}__`));
    const hasToolSearch = tools.some((tool) => tool.name === "ToolSearch");
    const stream = body.stream === true;
    if (!hasToolSearch && smokeTools.length === 0) {
      // Side request (titles, classification, quota): not part of the plan.
      record({ event: "anthropic_side_request", stream, toolCount: tools.length });
      writeAnthropic(res, body.model, { type: "text", text: "ok" }, stream);
      return;
    }
    const results = anthropicResults(body);
    const loadedDirectly = smokeTools.some((tool) => !tool.deferred);
    const needsToolSearch = !loadedDirectly && hasToolSearch;
    const next = nextSmokeCall(results, foreign, needsToolSearch);
    record({
      event: "anthropic_turn",
      stream,
      toolSearchOffered: hasToolSearch,
      smokeToolCount: smokeTools.length,
      smokeToolsDeferred: smokeTools.filter((tool) => tool.deferred).length,
      resultsSeen: results.map(deliveredResult),
      next: next ? { step: next.step, tool: next.tool, input: next.input } : null,
    });
    if (!next) {
      writeAnthropic(res, body.model, { type: "text", text: results.some((r) => r.step === "inspect_invalid") ? SMOKE_DONE_TEXT : "SMOKE-BLOCKED: plan did not complete" }, stream);
      return;
    }
    const name = next.tool === "ToolSearch" ? "ToolSearch" : `mcp__${SMOKE_MCP_KEY}__${next.tool}`;
    writeAnthropic(res, body.model, { type: "tool_use", id: callId(next.step), name, input: next.input }, stream);
  };

  const handleResponses = (body: Record<string, unknown>, res: ServerResponse) => {
    const shape = responsesToolShape(body);
    if (!shape) {
      record({ event: "responses_side_request" });
      writeResponses(res, { type: "message", role: "assistant", id: `msg_prgsmoke_${Date.now()}`, content: [{ type: "output_text", text: "SMOKE-BLOCKED: smoke tools not exposed" }] });
      return;
    }
    const results = responsesResults(body);
    const next = nextSmokeCall(results, foreign, false);
    record({
      event: "responses_turn",
      toolForm: shape.form,
      smokeToolCount: shape.names.length,
      resultsSeen: results.map(deliveredResult),
      next: next ? { step: next.step, tool: next.tool, input: next.input } : null,
    });
    if (!next) {
      const text = results.some((r) => r.step === "inspect_invalid") ? SMOKE_DONE_TEXT : "SMOKE-BLOCKED: plan did not complete";
      writeResponses(res, { type: "message", role: "assistant", id: `msg_prgsmoke_${Date.now()}`, content: [{ type: "output_text", text }] });
      return;
    }
    const call = shape.form === "namespace"
      ? { namespace: `mcp__${SMOKE_MCP_KEY}`, name: next.tool }
      : { name: `mcp__${SMOKE_MCP_KEY}__${next.tool}` };
    writeResponses(res, {
      type: "function_call",
      id: `fc_${callId(next.step)}`,
      call_id: callId(next.step),
      ...call,
      arguments: JSON.stringify(next.input),
      status: "completed",
    });
  };

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    journal,
    setLaunch(label, foreignHandles) {
      launch = label;
      foreign = foreignHandles;
    },
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}
