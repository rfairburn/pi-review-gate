/**
 * #84: accurate human-card reporting of model-stream failures, plus the
 * bounded model-visible diagnostic note.
 *
 * Everything here runs against the production surfaces: the real public
 * extension event handlers (`message_end`, `context`, `tool_execution_start`,
 * `agent_end`, `session_start`, `session_shutdown`) exactly as the installed Pi
 * host emits them, and the real registered renderers (including the shared
 * `expandableResult` wrapper and the real `registerBackgroundShell`
 * registrations). Host shapes are mirrored from the installed host: the
 * synthetic stream-failure result is `{ content, isError: true }` with no
 * details, and the render context carries `toolCallId`, `isError`, and an
 * explicit boolean `executionStarted`.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { expect } from "./helpers/expect";
import registerBackgroundShell from "../src/background-shell";
import { expandableResult } from "../src/tool-result-expansion";
import { renderSubtaskResultCollapsed } from "../src/execution/subtask-result-collapsed";
import { renderSubtaskResultExpanded } from "../src/execution/subtask-result-expanded";
import {
  MODEL_NOTE_MARKER,
  buildModelDiagnosticNote,
  observeAgentEnd,
  observeAssistantMessageEnd,
  observeContextBuild,
  observeToolExecutionStart,
  registerStreamFailureReporting,
  resetStreamFailureRecords,
  restoreStreamFailureRecords,
  streamFailureRecordCount,
  streamFailureRecordFor,
  streamFailureReportFor,
} from "../src/stream-failure-report";

const THEME = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

/** Renders through the production callbacks and returns plain text lines. */
type AnyRenderer = (result: unknown, options: unknown, theme: unknown, context?: unknown) => unknown;

function renderLines(callback: unknown, result: unknown, options: unknown, context?: unknown, width = 220): string[] {
  const renderer = callback as AnyRenderer;
  const component = renderer(result, options, THEME, context) as { render(w: number): string[] };
  assert.ok(component && typeof component.render === "function", "renderer must return a text component");
  return component.render(width) as string[];
}

function joined(text: string): string {
  return text;
}

/** The host's synthetic stream-failure result (no details, isError stripped
 *  from the renderer input and reported via context instead). */
function syntheticResult(text = "WebSocket error"): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

/** The host render context for a pending card that was never dispatched. */
function pendingContext(toolCallId: string, executionStarted: unknown = false): Record<string, unknown> {
  return { toolCallId, isError: true, executionStarted, args: { tasks: [{ title: "x" }] } };
}

/** An errored assistant message carrying tool calls and pi-ai diagnostics,
 *  shaped exactly as the public `message_end` event delivers it. */
function erroredAssistantMessage(toolCallIds: Array<{ id: string; name: string }>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    stopReason: "error",
    provider: "openai",
    model: "gpt-test-1",
    api: "openai-responses",
    errorMessage: "WebSocket error",
    timestamp: 1234,
    content: [
      { type: "text", text: "" },
      ...toolCallIds.map(({ id, name }) => ({ type: "toolCall", id, name, arguments: {} })),
    ],
    usage: {},
    diagnostics: [
      {
        type: "provider_transport_failure",
        timestamp: 5678,
        error: { name: "WebSocketError", message: "connection reset", code: "ECONNRESET" },
        details: {
          configuredTransport: "websocket",
          fallbackTransport: "sse",
          eventsEmitted: false,
          phase: "before_message_stream_start",
          requestBytes: 1234,
        },
      },
    ],
    ...overrides,
  };
}

function captureFailure(toolCallId: string, toolName = "SubtasksStart", overrides: Record<string, unknown> = {}): void {
  observeAssistantMessageEnd({
    type: "message_end",
    message: erroredAssistantMessage([{ id: toolCallId, name: toolName }], overrides),
  });
}

beforeEach(() => {
  resetStreamFailureRecords();
});

afterEach(() => {
  resetStreamFailureRecords();
});

// ── Event → renderer integration, host-shaped (both families) ───────────

describe("#84 model-stream failure cards from real public events", () => {
  it("SubtasksStart: message_end capture renders the not-dispatched card in collapsed and expanded states", () => {
    captureFailure("call-1");
    const context = pendingContext("call-1");
    const collapsed = renderLines(
      expandableResult(renderSubtaskResultCollapsed, renderSubtaskResultExpanded),
      syntheticResult(),
      { expanded: false, isPartial: false },
      context,
    ).join("\n");
    expect(collapsed).toContain("SubtasksStart");
    expect(collapsed).toContain("model stream failed before dispatch");
    expect(collapsed).toContain("not dispatched");
    expect(collapsed).toContain("WebSocket error");
    expect(collapsed).toContain("provider_transport_failure");
    expect(collapsed).toContain("WebSocketError");
    expect(collapsed).toContain("… 6 more diagnostic detail line(s) in the expanded view");
    // The phase detail is disclosed in the expanded view (collapsed is bounded
    // and truthfully reports what it omits).
    // The recorded fallback transport is described as recorded, never as a
    // completed switch or a performed retry.
    expect(collapsed).toContain("fallback transport sse recorded");
    expect(collapsed).toContain("switch not confirmed");
    expect(collapsed).not.toContain("performed");

    const expanded = renderLines(
      expandableResult(renderSubtaskResultCollapsed, renderSubtaskResultExpanded),
      syntheticResult(),
      { expanded: true, isPartial: false },
      context,
    ).join("\n");
    expect(expanded).toContain("model: openai/gpt-test-1");
    expect(expanded).toContain("api: openai-responses");
    expect(expanded).toContain("phase: before_message_stream_start");
    expect(expanded).toContain("request size at failure: 1234 bytes");
    expect(expanded).toContain("message stream events emitted before the failure: no");
    expect(expanded).toContain("before_message_stream_start");
    expect(expanded).toContain("redacted");
    // No fabricated execution result, no invented retryability or blame.
    expect(expanded).not.toContain("retry");
    expect(expanded).not.toContain("exit code");
  });

  it("ShellStart through the real registered renderer: collapsed and expanded failure cards", () => {
    const tools: Record<string, any> = {};
    registerBackgroundShell({
      registerTool: (t: any) => { tools[t.name] = t; },
      on: () => ({}),
      sendMessage: () => ({}),
    } as any);
    captureFailure("call-2", "ShellStart");
    const context = pendingContext("call-2");
    const collapsed = renderLines(tools.ShellStart.renderResult, syntheticResult("WebSocket error 42"), { expanded: false, isPartial: false }, context).join("\n");
    expect(collapsed).toContain("ShellStart · model stream failed before dispatch");
    expect(collapsed).toContain("WebSocket error 42");
    expect(collapsed).toContain("not dispatched");
    const expanded = renderLines(tools.ShellStart.renderResult, syntheticResult("WebSocket error 42"), { expanded: true, isPartial: false }, context).join("\n");
    expect(expanded).toContain("ShellStart · model stream failed before dispatch");
    expect(expanded).toContain("provider_transport_failure");
    expect(expanded).toContain("ECONNRESET");
    // Legacy and normal Shell views are untouched by the new branch.
    const normal = renderLines(tools.ShellStart.renderResult, { content: [{ type: "text", text: "x" }], details: { kind: "pi-review-bg-shell", tool: "ShellStart", id: "j1", label: "j1", state: "running", command: "echo hi", pid: 5, startedAt: 1, watching: "" } }, { expanded: false, isPartial: false }, { toolCallId: "call-x", isError: false, executionStarted: true }).join("\n");
    expect(normal).toContain("ShellStart · j1");
    expect(normal).not.toContain("stream failed");
  });

  it("event order: the message_end capture precedes the card render (host fires extensions first)", () => {
    const handlers: Record<string, Array<(event: unknown, ctx?: unknown) => unknown>> = {};
    const registered = registerStreamFailureReporting({
      on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
        (handlers[name] ??= []).push(handler);
        return () => undefined;
      },
    });
    expect(registered).toContain("message_end");
    expect(registered).toContain("context");
    expect(registered).toContain("tool_execution_start");
    expect(registered).toContain("agent_end");
    expect(registered).toContain("session_start");
    expect(registered).toContain("session_tree");
    expect(registered).toContain("session_shutdown");
    expect(registered.length).toBe(7);

    // 1. host emits message_end to extensions BEFORE UI handling.
    handlers.message_end![0]({ type: "message_end", message: erroredAssistantMessage([{ id: "call-3", name: "SubtasksStart" }]) });
    // 2. the host then renders the card with the synthetic result.
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult(), { expanded: false, isPartial: false }, pendingContext("call-3")).join("\n");
    expect(card).toContain("not dispatched");

    // 3. a real dispatch event clears the record; the stale error can no
    //    longer claim "not dispatched".
    handlers.tool_execution_start![0]({ type: "tool_execution_start", toolCallId: "call-3", toolName: "SubtasksStart" });
    expect(streamFailureRecordCount()).toBe(0);
  });

  it("registration hooks rebuild from the session branch on session_start and clear on session_shutdown", () => {
    const handlers: Record<string, Array<(event: unknown, ctx?: unknown) => unknown>> = {};
    registerStreamFailureReporting({
      on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
        (handlers[name] ??= []).push(handler);
        return () => undefined;
      },
    });
    const entries = [
      { type: "message", message: { role: "user", content: "go" } },
      { type: "message", message: erroredAssistantMessage([{ id: "call-4", name: "ShellStart" }]) },
    ];
    handlers.session_start![0]({}, { sessionManager: { getBranch: () => entries } });
    expect(streamFailureRecordCount()).toBe(1);
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult(), { expanded: false, isPartial: false }, pendingContext("call-4")).join("\n");
    expect(card).toContain("not dispatched");
    handlers.session_shutdown![0]({}, {});
    expect(streamFailureRecordCount()).toBe(0);
  });

  it("a fork-shaped session_start clears and rebuilds only the new branch", () => {
    const handlers: Record<string, Array<(event: unknown, ctx?: unknown) => unknown>> = {};
    registerStreamFailureReporting({
      on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
        (handlers[name] ??= []).push(handler);
        return () => undefined;
      },
    });
    captureFailure("call-fork-1", "SubtasksStart");
    expect(streamFailureRecordCount()).toBe(1);
    // The host emits session_start with reason "fork" through the same
    // clear-and-rebuild path; the handler is reason-independent by design.
    handlers.session_start![0]({ type: "session_start", reason: "fork" }, { sessionManager: { getBranch: () => [] } });
    expect(streamFailureRecordCount()).toBe(0);
  });

  it("session_tree (branch navigation) clears and rebuilds from the new branch; session ids never cross branches", () => {
    const handlers: Record<string, Array<(event: unknown, ctx?: unknown) => unknown>> = {};
    registerStreamFailureReporting({
      on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
        (handlers[name] ??= []).push(handler);
        return () => undefined;
      },
    });
    // Session/branch A: a live capture with a pending note.
    captureFailure("call-shared", "SubtasksStart");
    expect(streamFailureRecordCount()).toBe(1);
    assert.ok(buildModelDiagnosticNote() !== undefined);
    // /tree navigation to branch B (no failures): pi emits only session_tree,
    // never session_start — the branch-A record must not cross branches.
    handlers.session_tree![0]({ type: "session_tree", newLeafId: "leaf-b", oldLeafId: "leaf-a" }, { sessionManager: { getBranch: () => [] } });
    expect(streamFailureRecordCount()).toBe(0);
    expect(buildModelDiagnosticNote()).toBeUndefined();
    expect(observeContextBuild({ type: "context", messages: [{ role: "user", content: "go", timestamp: 1 }] })).toBeUndefined();
    // Same-id reuse on branch B: the record is restored from the branch's own
    // entries and is note-terminal (never injected for restored history).
    handlers.session_tree![0]({ type: "session_tree", newLeafId: "leaf-b2", oldLeafId: "leaf-b" }, { sessionManager: { getBranch: () => [{ type: "message", message: erroredAssistantMessage([{ id: "call-shared", name: "ShellStart" }]) }] } });
    expect(streamFailureRecordCount()).toBe(1);
    expect(streamFailureRecordFor("call-shared")!.noteState).toBe("done");
    expect(observeContextBuild({ type: "context", messages: [{ role: "user", content: "go", timestamp: 1 }] })).toBeUndefined();
  });
});

// ── Honesty states: aborted vs failure vs unknown vs real errors ────────

describe("#84 honest failure states", () => {
  it("an aborted stream is reported as a cancellation, never a provider outage", () => {
    captureFailure("call-5", "SubtasksStart", { stopReason: "aborted", errorMessage: "Operation aborted", diagnostics: [] });
    const report = streamFailureReportFor(syntheticResult(), pendingContext("call-5"))!;
    expect(report.kind).toBe("aborted_not_dispatched");
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult(), { expanded: false, isPartial: false }, pendingContext("call-5")).join("\n");
    expect(card).toContain("model stream aborted before dispatch");
    expect(card).toContain("cancellation, not a provider failure");
    expect(card).not.toContain("provider_transport_failure");
    expect(card).not.toContain("stream failed before dispatch");
  });

  it("missing correlation renders an honest unknown card, with no fabricated diagnostics or invented stream claim", () => {
    const collapsed = renderLines(renderSubtaskResultCollapsed, syntheticResult("WebSocket error"), { expanded: false, isPartial: false }, pendingContext("call-6")).join("\n");
    expect(collapsed).toContain("failure · execution status unknown");
    // The unknown status never invents a stream/provider cause.
    expect(collapsed).not.toContain("stream failure detected");
    expect(collapsed).not.toContain("model stream");
    expect(collapsed).toContain("no stream-failure record is correlated");
    expect(collapsed).toContain("WebSocket error");
    expect(collapsed).not.toContain("provider_transport_failure");
    const expanded = renderLines(renderSubtaskResultExpanded, syntheticResult("WebSocket error"), { expanded: true, isPartial: false }, pendingContext("call-6")).join("\n");
    expect(expanded).toContain("No diagnostic data is available for this failure");
    expect(expanded).not.toContain("provider_transport_failure");
    expect(expanded).not.toContain("not dispatched");
  });

  it("a missing executionStarted field never asserts not-dispatched", () => {
    captureFailure("call-7");
    // Explicitly ABSENT (not merely falsy): the host must report the boolean.
    const missingContext = { toolCallId: "call-7", isError: true, args: { tasks: [] } };
    const report = streamFailureReportFor(syntheticResult(), missingContext)!;
    expect(report.kind).toBe("unknown");
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult(), { expanded: false, isPartial: false }, missingContext).join("\n");
    expect(card).toContain("execution status unknown");
    expect(card).not.toContain("not dispatched");
  });

  it("an actual tool execution error after dispatch keeps the existing error rendering", () => {
    captureFailure("call-8");
    // Host: the tool actually ran (executionStarted true) and failed.
    const context = { toolCallId: "call-8", isError: true, executionStarted: true };
    expect(streamFailureReportFor(syntheticResult(), context)).toBeUndefined();
    const envelope = { content: [{ type: "text", text: "SubtasksSteer failed: no such execution" }], details: { action: "steer", diagnostic: "no such execution", executionId: "exec-1" }, isError: true };
    const card = renderLines(renderSubtaskResultCollapsed, envelope, { expanded: false, isPartial: false }, context).join("\n");
    expect(card).toContain("SubtasksSteer · failed");
    expect(card).toContain("diagnostic: no such execution");
    expect(card).not.toContain("model stream failed");
    const expanded = renderLines(renderSubtaskResultExpanded, envelope, { expanded: true, isPartial: false }, context).join("\n");
    expect(expanded).not.toContain("model stream failed");
    // A real envelope (structured details) never becomes a stream-failure card.
    expect(streamFailureReportFor(envelope, { toolCallId: "call-8", isError: true, executionStarted: false })).toBeUndefined();
  });

  it("the preserved host error summary is kept when no diagnostics were recorded", () => {
    captureFailure("call-9", "SubtasksStart", { diagnostics: [] });
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult("WebSocket error"), { expanded: false, isPartial: false }, pendingContext("call-9")).join("\n");
    expect(card).toContain("WebSocket error");
    expect(card).toContain("No transport diagnostics were recorded");
    const expanded = renderLines(renderSubtaskResultExpanded, syntheticResult("WebSocket error"), { expanded: true, isPartial: false }, pendingContext("call-9")).join("\n");
    expect(expanded).toContain("the underlying cause is not retained");
    expect(expanded).toContain("WebSocket error");
  });
});

// ── Sanitization, allowlisting, and boundedness ─────────────────────────

describe("#84 captured diagnostics are allowlisted, redacted, and bounded", () => {
  it("tokens and URLs are redacted; stacks, headers, private paths, and unknown fields are never retained", () => {
    captureFailure("call-10", "ShellStart", {
      diagnostics: [{
        type: "provider_transport_failure",
        timestamp: 1,
        error: {
          name: "WebSocketError",
          message: "connect ghp_abcdefghijklmnopqrst failed https://api.example.com/v1/secret?token=abc /Users/robert/private/file",
          code: "ECONNRESET",
          stack: "at secret stack",
        },
        details: {
          configuredTransport: "websocket",
          fallbackTransport: "sse",
          phase: "before_message_stream_start",
          requestBytes: 12,
          headers: { authorization: "Bearer secret" },
          privatePath: "/Users/robert/private",
          stack: "raw stack",
          unknownField: "leak",
        },
      }],
    });
    const record = streamFailureRecordFor("call-10")!;
    expect(record.diagnostics.length).toBe(1);
    const text = JSON.stringify(record);
    expect(text).not.toContain("ghp_abcdefghijklmnopqrst");
    expect(text).not.toContain("api.example.com");
    expect(text).not.toContain("/Users/robert");
    expect(text).not.toContain("secret stack");
    expect(text).not.toContain("authorization");
    expect(text).not.toContain("leak");
    expect(text).not.toContain("headers");
    expect(record.diagnostics[0]!.errorMessage).toContain("[REDACTED]");
    expect(record.diagnostics[0]!.errorMessage).toContain("[URL REDACTED]");
    expect(Object.keys(record.diagnostics[0]!).every((key) =>
      ["type", "errorName", "errorCode", "errorMessage", "phase", "configuredTransport", "fallbackTransport", "eventsEmitted", "requestBytes"].includes(key),
    )).toBe(true);
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult(), { expanded: false, isPartial: false }, pendingContext("call-10")).join("\n");
    expect(card).not.toContain("ghp_");
    expect(card).not.toContain("/Users/robert");
  });

  it("the displayed host error text is redacted and bounded like every other retained text (including Windows private paths)", () => {
    const result = syntheticResult("boom ghp_abcdefghijklmnopqrst https://api.example.com/v1?token=abc /Users/robert/private/file C:\\Users\\robert\\secret\\file");
    const card = renderLines(renderSubtaskResultCollapsed, result, { expanded: false, isPartial: false }, pendingContext("call-redact-host")).join("\n");
    expect(card).not.toContain("ghp_");
    expect(card).not.toContain("api.example.com");
    expect(card).not.toContain("robert");
    expect(card).toContain("[REDACTED]");
    expect(card).toContain("[URL REDACTED]");
    expect(card).toContain("[PATH REDACTED]");
    // The sanitized error is preserved, not dropped: the card still carries
    // the failure's own text.
    expect(card).toContain("boom [REDACTED]");
    const expanded = renderLines(renderSubtaskResultExpanded, result, { expanded: true, isPartial: false }, pendingContext("call-redact-host")).join("\n");
    expect(expanded).not.toContain("ghp_");
    expect(expanded).not.toContain("api.example.com");
  });

  it("an over-long tool call id is never retained (fail-honest unknown card, no truncated id)", () => {
    const longId = `call-${"x".repeat(200)}`;
    captureFailure(longId);
    expect(streamFailureRecordCount()).toBe(0);
    const report = streamFailureReportFor(syntheticResult(), pendingContext(longId))!;
    expect(report.kind).toBe("unknown");
    expect(report.correlated).toBe(false);
    expect(buildModelDiagnosticNote()).toBeUndefined();
  });

  it("the store is bounded and evicts the oldest records", () => {
    for (let i = 0; i < 40; i += 1) {
      captureFailure(`call-old-${i}`);
    }
    expect(streamFailureRecordCount()).toBe(32);
    expect(streamFailureRecordFor("call-old-0")).toBeUndefined();
    assert.ok(streamFailureRecordFor("call-old-39") !== undefined);
  });

  it("restore from session entries keeps actual results in charge and isolates sessions", () => {
    const errored = erroredAssistantMessage([{ id: "call-11", name: "SubtasksStart" }]);
    const entries = [
      { type: "message", message: errored },
      { type: "message", message: { role: "toolResult", toolCallId: "call-12", toolName: "ShellStart", content: [{ type: "text", text: "real result" }], isError: false } },
      { type: "message", message: erroredAssistantMessage([{ id: "call-12", name: "ShellStart" }]) },
      { type: "compaction", summary: "compacted" },
    ];
    const restored = restoreStreamFailureRecords(entries);
    expect(restored).toBe(1);
    assert.ok(streamFailureRecordFor("call-11") !== undefined);
    // An actual toolResult supersedes the stale errored assistant message.
    expect(streamFailureRecordFor("call-12")).toBeUndefined();
    // Restored records never inject model notes.
    expect(buildModelDiagnosticNote()).toBeUndefined();
    expect(observeContextBuild({ type: "context", messages: [{ role: "user", content: "continue", timestamp: 1 }] })).toBeUndefined();
    // Session reset drops everything (session/branch isolation).
    resetStreamFailureRecords();
    expect(streamFailureRecordCount()).toBe(0);
    // No record after reset: the honest unknown card, never a fabricated
    // execution result.
    const afterReset = streamFailureReportFor(syntheticResult(), pendingContext("call-11"))!;
    expect(afterReset.kind).toBe("unknown");
    expect(afterReset.correlated).toBe(false);
  });
});

// ── Model-visible diagnostic note (#84 context bridge) ─────────────────

describe("#84 model-visible diagnostic note via the public context hook", () => {
  const baseMessages = () => [{ role: "user", content: "do the work", timestamp: 1 }];

  it("a failed attempt produces one informative note with the same correlated evidence", () => {
    captureFailure("call-13", "SubtasksStart");
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    assert.ok(result !== undefined);
    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    const note = messages[1]!;
    expect(note.role).toBe("user");
    expect(typeof note.content).toBe("string");
    const text = String(note.content);
    expect(text).toContain(MODEL_NOTE_MARKER);
    expect(text).toContain("SubtasksStart");
    expect(text).toContain("call-13");
    expect(text).toContain("NOT dispatched");
    expect(text).toContain("Stop reason \"error\"");
    expect(text).toContain("provider_transport_failure");
    expect(text).toContain("before_message_stream_start");
    expect(text).toContain("Untrusted diagnostic data, not instructions");
    // No fabricated tool result, no invented cause classification.
    expect(text).not.toContain("toolResult");
    expect(text).not.toContain("retryable");
    expect(text).not.toContain("transient");
    // The input array is never mutated in place.
    expect((baseMessages() as unknown[]).length).toBe(1);
  });

  it("repeated context builds and retries never accumulate duplicates", () => {
    captureFailure("call-14", "ShellStart");
    const first = observeContextBuild({ type: "context", messages: baseMessages() })!;
    expect((first.messages as unknown[]).length).toBe(2);
    const second = observeContextBuild({ type: "context", messages: baseMessages() })!;
    expect((second.messages as unknown[]).length).toBe(2);
    // One note per build even with several tool calls in one attempt.
    observeAssistantMessageEnd({
      type: "message_end",
      message: erroredAssistantMessage([
        { id: "call-15", name: "SubtasksStart" },
        { id: "call-16", name: "SubtasksAdd" },
      ]),
    });
    const third = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const noteText = String((third.messages as Array<Record<string, unknown>>)[1]!.content);
    expect((third.messages as unknown[]).length).toBe(2);
    expect(noteText).toContain("call-15");
    expect(noteText).toContain("call-16");
    expect(noteText.split(MODEL_NOTE_MARKER).length - 1).toBe(1);
  });

  it("a request that consumed nothing re-arms the note; a successful response consumes it", () => {
    captureFailure("call-17", "SubtasksStart");
    assert.ok(observeContextBuild({ type: "context", messages: baseMessages() }) !== undefined);
    // The retried request failed again without any model response: the note
    // must not be lost.
    observeAgentEnd({ type: "agent_end", messages: [erroredAssistantMessage([{ id: "call-14b", name: "SubtasksStart" }], { timestamp: 999 })] });
    assert.ok(observeContextBuild({ type: "context", messages: baseMessages() }) !== undefined);
    // A successful assistant response consumes the note.
    observeAssistantMessageEnd({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: {} } });
    expect(observeContextBuild({ type: "context", messages: baseMessages() })).toBeUndefined();
  });

  it("a real later dispatch supersedes the failed attempt; the note never misattributes it", () => {
    captureFailure("call-17", "ShellStart");
    observeToolExecutionStart({ type: "tool_execution_start", toolCallId: "call-17", toolName: "ShellStart" });
    expect(observeContextBuild({ type: "context", messages: baseMessages() })).toBeUndefined();
    // And the human card can no longer claim the failed attempt's status.
    const card = renderLines(renderSubtaskResultCollapsed, syntheticResult(), { expanded: false, isPartial: false }, pendingContext("call-17")).join("\n");
    expect(card).toContain("execution status unknown");
  });

  it("an actual toolResult in the built context suppresses the note", () => {
    captureFailure("call-18", "ShellStart");
    const messages = [...baseMessages(), { role: "toolResult", toolCallId: "call-18", toolName: "ShellStart", content: [{ type: "text", text: "ran later" }], isError: false }];
    expect(observeContextBuild({ type: "context", messages })).toBeUndefined();
  });

  it("an actual toolResult in the built context supersedes the uncertain record itself (mixed real result and failed call)", () => {
    observeAssistantMessageEnd({
      type: "message_end",
      message: erroredAssistantMessage([
        { id: "call-mix-a", name: "SubtasksStart" },
        { id: "call-mix-b", name: "SubtasksAdd" },
      ]),
    });
    const messages = [...baseMessages(), { role: "toolResult", toolCallId: "call-mix-a", toolName: "SubtasksStart", content: [{ type: "text", text: "real output" }], isError: false }];
    const result = observeContextBuild({ type: "context", messages })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[2]!.content);
    // The note covers exactly the still-uncertain call, never one with an
    // observed actual result.
    expect(text).toContain("call-mix-b");
    expect(text).not.toContain("call-mix-a");
    // The superseded record is removed, so no card can claim it "not
    // dispatched" either; the included attempt is the one marked inflight.
    expect(streamFailureRecordFor("call-mix-a")).toBeUndefined();
    expect(streamFailureRecordFor("call-mix-b")!.noteState).toBe("inflight");
  });

  it("records dropped by the attempt bound stay pending and are described by a later build (no loss, no premature consumption)", () => {
    // Minimal sections (no diagnostics/provider/model/error text) keep four
    // attempts within the character budget, so the fourth is dropped by the
    // MAX_NOTE_ATTEMPTS bound itself, not by clipping.
    for (let i = 0; i < 4; i += 1) {
      captureFailure(`call-life-${i}`, "SubtasksStart", { responseId: `resp-life-${i}`, diagnostics: [], provider: undefined, model: undefined, errorMessage: undefined });
    }
    const first = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const firstText = String((first.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(firstText).toContain("call-life-0");
    expect(firstText).toContain("call-life-2");
    expect(firstText).not.toContain("call-life-3");
    expect(firstText).toContain("further unresolved failed tool call");
    expect(streamFailureRecordFor("call-life-2")!.noteState).toBe("inflight");
    expect(streamFailureRecordFor("call-life-3")!.noteState).toBe("pending");
    // The delivered attempts are consumed by the successful response that
    // followed their delivery; the never-included one stays pending.
    observeAssistantMessageEnd({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: {} } });
    expect(streamFailureRecordFor("call-life-0")!.noteState).toBe("done");
    expect(streamFailureRecordFor("call-life-3")!.noteState).toBe("pending");
    // The next build describes exactly the previously-dropped attempt.
    const second = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const secondText = String((second.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(secondText).toContain("call-life-3");
    expect(secondText).not.toContain("call-life-0");
    expect(secondText.split(MODEL_NOTE_MARKER).length - 1).toBe(1);
  });

  it("records dropped by the note's character bound stay pending and are described by a later build", () => {
    captureFailure("call-char-a", "SubtasksStart", { responseId: "resp-char-a", errorMessage: "e".repeat(600) });
    captureFailure("call-char-b", "ShellStart", { responseId: "resp-char-b", errorMessage: "e".repeat(600) });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toContain("call-char-a");
    expect(text).not.toContain("call-char-b");
    expect(text).toContain("further unresolved failed tool call");
    expect(streamFailureRecordFor("call-char-a")!.noteState).toBe("inflight");
    expect(streamFailureRecordFor("call-char-b")!.noteState).toBe("pending");
  });

  it("an attempt whose full section exceeds the note's character bound is still described minimally (never silently lost)", () => {
    // A 600-char reported error plus two fat recorded diagnostics push the
    // full section past the note budget; the note must still name the call.
    captureFailure("call-huge", "SubtasksStart", {
      responseId: "resp-huge",
      provider: "p".repeat(120),
      model: "m".repeat(120),
      errorMessage: "e".repeat(600),
      diagnostics: [0, 1].map((i) => ({
        type: "provider_transport_failure",
        error: { name: "E".repeat(64), code: i, message: "m".repeat(240) },
        details: { phase: "p".repeat(64), configuredTransport: "c".repeat(32) },
      })),
    });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(result.messages.length).toBe(2);
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toContain("call-huge");
    expect(text).toContain("NOT dispatched and never ran");
    expect(streamFailureRecordFor("call-huge")!.noteState).toBe("inflight");
    // The minimal note is a real delivered note: a rebuilt context that
    // already carries it (persisted copy or chained handler) never gets a
    // second one for the same call.
    expect(observeContextBuild({ type: "context", messages: result.messages })).toBeUndefined();
  });

  it("the oversized-attempt fallback keeps the aborted-attempt contract parity (cancellation, not a provider failure)", () => {
    resetStreamFailureRecords();
    captureFailure("call-huge-aborted", "SubtasksStart", {
      stopReason: "aborted",
      responseId: "resp-huge-aborted",
      provider: "p".repeat(120),
      model: "m".repeat(120),
      errorMessage: "e".repeat(600),
      diagnostics: [0, 1].map((i) => ({
        type: "provider_transport_failure",
        error: { name: "E".repeat(64), code: i, message: "m".repeat(240) },
        details: { phase: "p".repeat(64), configuredTransport: "c".repeat(32) },
      })),
    });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(text).toContain("call-huge-aborted");
    expect(text).toContain('Stop reason "aborted"');
    expect(text).toContain("a cancellation, not a provider failure");
    expect(text).not.toContain("provider failure occurred");
    expect(streamFailureRecordFor("call-huge-aborted")!.noteState).toBe("inflight");
  });

  it("the omission marker is never silently dropped when the note budget is tight", () => {
    // Attempt A's full section fits only without the truthfulness marker: the
    // composition must shrink the description (keeping the oldest attempt's
    // call id) so the marker still counts the dropped attempt truthfully.
    captureFailure("call-tight-a", "SubtasksStart", {
      responseId: "resp-tight-a",
      provider: "p".repeat(120),
      model: "m".repeat(120),
      errorMessage: "e".repeat(600),
      diagnostics: [{ type: "provider_transport_failure", error: { name: "E", code: 1, message: "x".repeat(21) }, details: { phase: "p".repeat(64), configuredTransport: "c".repeat(32), fallbackTransport: "f".repeat(32) } }],
    });
    captureFailure("call-tight-b", "ShellStart", { responseId: "resp-tight-b", errorMessage: "e".repeat(600) });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toContain("call-tight-a");
    expect(text).not.toContain("call-tight-b");
    expect(text).toContain("(+ 1 further unresolved failed tool call(s) not described here.)");
    expect(streamFailureRecordFor("call-tight-a")!.noteState).toBe("inflight");
    expect(streamFailureRecordFor("call-tight-b")!.noteState).toBe("pending");
  });

  it("a pending note is never consumed by an unrelated or earlier-turn success", () => {
    captureFailure("call-pending", "SubtasksStart");
    // A successful assistant response that never saw this note does not
    // consume it: the failure was never placed into any request.
    observeAssistantMessageEnd({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: {} } });
    expect(streamFailureRecordFor("call-pending")!.noteState).toBe("pending");
    assert.ok(observeContextBuild({ type: "context", messages: baseMessages() }) !== undefined);
  });

  it("multi-turn ordering: an earlier-turn success never consumes a note delivered into a later failed request", () => {
    const successfulTurn = { role: "assistant", stopReason: "toolUse", content: [], usage: {} };
    // Turn 1 succeeds.
    observeAssistantMessageEnd({ type: "message_end", message: successfulTurn });
    // Turn 2 fails; the note is delivered into the auto-retry request.
    observeAssistantMessageEnd({ type: "message_end", message: erroredAssistantMessage([{ id: "call-mt", name: "SubtasksStart" }]) });
    assert.ok(observeContextBuild({ type: "context", messages: baseMessages() }) !== undefined);
    expect(streamFailureRecordFor("call-mt")!.noteState).toBe("inflight");
    // Turn 3 (the retry) fails again: the run ends with an earlier success in
    // its message list but no successful response after the delivery.
    observeAssistantMessageEnd({ type: "message_end", message: erroredAssistantMessage([{ id: "call-mt2", name: "SubtasksStart" }], { responseId: "resp-mt2" }) });
    observeAgentEnd({
      type: "agent_end",
      messages: [successfulTurn, erroredAssistantMessage([{ id: "call-mt", name: "SubtasksStart" }]), erroredAssistantMessage([{ id: "call-mt2", name: "SubtasksStart" }], { responseId: "resp-mt2" })],
    });
    // The delivered-but-unanswered note is re-armed, never consumed by the
    // earlier success.
    expect(streamFailureRecordFor("call-mt")!.noteState).toBe("pending");
    // The note is still delivered, never lost and never duplicated.
    const retry = observeContextBuild({ type: "context", messages: baseMessages() })!;
    expect((retry.messages as unknown[]).length).toBe(2);
    expect(String((retry.messages as Array<Record<string, unknown>>)[1]!.content)).toContain("call-mt");
    // A successful response AFTER delivery consumes it.
    observeAssistantMessageEnd({ type: "message_end", message: successfulTurn });
    expect(streamFailureRecordFor("call-mt")!.noteState).toBe("done");
    expect(observeContextBuild({ type: "context", messages: baseMessages() })).toBeUndefined();
  });

  it("a later-turn stream failure keeps its note even when an earlier turn succeeded", () => {
    // Real host shape: agent-loop accumulates every turn of the run, so
    // agent_end carries a successful turn AND the failed turn of the same run.
    const successfulTurn = { role: "assistant", stopReason: "toolUse", content: [], usage: {} };
    const failedTurn = erroredAssistantMessage([{ id: "call-21", name: "SubtasksStart" }]);
    observeAssistantMessageEnd({ type: "message_end", message: successfulTurn });
    observeAssistantMessageEnd({ type: "message_end", message: failedTurn });
    observeAgentEnd({ type: "agent_end", messages: [successfulTurn, failedTurn] });
    // The host's auto-retry rebuilds the request without the failed message:
    // the note must still be delivered, never silently lost.
    assert.ok(observeContextBuild({ type: "context", messages: [{ role: "user", content: "go", timestamp: 1 }] }) !== undefined);
  });

  it("the note reports the host error text even when no transport diagnostics exist", () => {
    captureFailure("call-22", "SubtasksStart", { diagnostics: [], errorMessage: "WebSocket error 77" });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(text).toContain("Reported error: WebSocket error 77");
    expect(text).toContain("only the reported error above");
  });

  it("the note never leaks the raw reported error text", () => {
    captureFailure("call-23", "SubtasksStart", {
      diagnostics: [],
      errorMessage: "failed ghp_abcdefghijklmnopqrst https://api.example.com/v1 /Users/robert/private/file",
    });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(text).not.toContain("ghp_abcdefghijklmnopqrst");
    expect(text).not.toContain("api.example.com");
    expect(text).not.toContain("/Users/robert");
    expect(text).toContain("[REDACTED]");
  });

  it("session/reset isolation and missing evidence stay truthful", () => {
    captureFailure("call-19", "SubtasksStart");
    assert.ok(buildModelDiagnosticNote() !== undefined);
    resetStreamFailureRecords();
    expect(observeContextBuild({ type: "context", messages: baseMessages() })).toBeUndefined();
    expect(buildModelDiagnosticNote()).toBeUndefined();
    // No fabricated note when nothing failed.
    const untouched = observeContextBuild({ type: "context", messages: baseMessages() });
    expect(untouched).toBeUndefined();
  });

  it("an aborted attempt's note states the cancellation, not a provider failure", () => {
    captureFailure("call-20", "SubtasksStart", { stopReason: "aborted", diagnostics: [] });
    const result = observeContextBuild({ type: "context", messages: baseMessages() })!;
    const text = String((result.messages as Array<Record<string, unknown>>)[1]!.content);
    expect(text).toContain("Stop reason \"aborted\"");
    expect(text).toContain("cancellation, not a provider failure");
    expect(text).not.toContain("provider_transport_failure");
  });
});