/**
 * Shared fixture for issue #661: a project-owned tool call that tool protection
 * refused BEFORE the tool was entered, rendered the way the installed host
 * renders it.
 *
 * Every assertion built on this pipeline runs the production pieces end to end:
 *
 * - the real admission coordinator (`admitToolCall`), with an injected auditor so
 *   the refusal is a real recorded decision rather than a hand-written string;
 * - the real renderer decoration the coordinator installs through the host's own
 *   `registerToolRenderer` seam, which draws the gate's rows and hands the tool's
 *   own renderer a copy of the result with that same recorded text removed, plus
 *   the call-bound refusal provenance (#661);
 * - a real family renderer as the base definition the host resolves.
 *
 * Nothing here executes, retries, or re-audits a call, and no fixture invents an
 * execution or task handle: a refused call has none.
 */
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type ReviewGateConfig } from "../src/config";
import { createToolProtectionCoordinator } from "../src/tool-protection/coordinator";
import type { ProtectionAuditorPiModelRegistry, ProtectionAuditorResult } from "../src/tool-protection/runner";

type HookHandler = (...args: unknown[]) => unknown;

/** A theme that keeps the text plain, so assertions read the rendered content. */
export const PLAIN_THEME = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

/** Tool protection On, auditing every tool, with an injected auditor runner. */
export function blockedCallConfig(): ReviewGateConfig {
  return {
    ...DEFAULT_CONFIG,
    toolProtection: {
      level: "aligned",
      auditor: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
      scope: "all",
      toolNames: [],
      timeoutMs: 5_000,
      maxContextChars: 200_000,
      retainAuditorSessions: false,
      debug: false,
    },
  } as ReviewGateConfig;
}

const registry: ProtectionAuditorPiModelRegistry = {
  find: (provider: string, modelId: string) => ({ id: modelId, provider }),
  getAll: () => [{ id: "model", provider: "synthetic" }],
  streamSimple() {
    throw new Error("the injected auditor runner never uses the registry stream");
  },
};

/** The host context the admission seam reads for the governing prompt. */
function admissionContext(): Record<string, unknown> {
  return {
    ui: {},
    cwd: process.cwd(),
    getSystemPrompt: () => "GOVERNING: complete the bounded synthetic task.",
    modelRegistry: registry,
    sessionManager: { buildContextEntries: () => [] },
  };
}

export interface RefusedCall {
  /** The exact refusal text this gate handed the host. */
  reason: string;
  /** The host-issued tool call id of the refused call. */
  callId: string;
  /** The arguments exactly as they were submitted. */
  args: Record<string, unknown>;
}

export interface BlockedCallPipeline {
  pi: Record<string, unknown>;
  config: ReviewGateConfig;
  /**
   * Run one proposal through the production admission seam with an injected
   * auditor. Returns the refusal the gate handed back, or `undefined` when the
   * call was allowed.
   */
  submit(options: {
    toolName: string;
    callId: string;
    input: Record<string, unknown>;
    auditorReply: { output?: string; error?: string };
    parentToolCallId?: string;
  }): Promise<RefusedCall | undefined>;
  /**
   * `submit` plus the assertion that this proposal really was refused before
   * execution, which is what every blocked-call test needs.
   */
  refuse(options: {
    toolName: string;
    callId: string;
    input: Record<string, unknown>;
    auditorReply: { output?: string; error?: string };
    parentToolCallId?: string;
  }): Promise<RefusedCall>;
  /**
   * Wrap a family's own registered `renderResult` definition in the decoration
   * the coordinator installed on the host, exactly as the host resolves it.
   */
  decorate<T>(baseDefinition: T, toolName: string): T;
}

/**
 * One pipeline per test: the coordinator is the same object that recorded the
 * refusal, so the provenance the renderer receives is the provenance the gate
 * published for that call id.
 */
export function createBlockedCallPipeline(
  options: { config?: ReviewGateConfig } = {},
): BlockedCallPipeline {
  const config = options.config ?? blockedCallConfig();
  const hooks = new Map<string, HookHandler[]>();
  let resolver: ((toolName: string, next: () => unknown) => unknown) | undefined;
  const pi: Record<string, unknown> = {
    on(name: string, handler: HookHandler) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    appendEntry() {},
    registerEntryRenderer() {},
    registerToolRenderer(next: (toolName: string, next: () => unknown) => unknown) {
      resolver = next;
    },
  };
  let pendingReply: { output?: string; error?: string } = {};
  const runAuditor = async (): Promise<ProtectionAuditorResult> => ({ durationMs: 1, ...pendingReply });
  const coordinator = createToolProtectionCoordinator({
    config: () => config,
    cwd: () => process.cwd(),
    role: "primary",
    runAuditor,
    now: () => 1_000,
  });
  // The real registration path: evidence, presentation, and the renderer
  // decoration the host resolves through.
  coordinator.registerHooks(pi);

  return {
    pi,
    config,
    async submit({ toolName, callId, input, auditorReply, parentToolCallId }) {
      pendingReply = auditorReply;
      const refusal = await coordinator.admitToolCall([{
        toolCallId: callId,
        toolName,
        input,
        ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      }, admissionContext()]);
      if (refusal === undefined) return undefined;
      return { reason: refusal.reason, callId, args: input };
    },
    async refuse(options) {
      const refusal = await this.submit(options);
      assert.ok(refusal !== undefined, `${options.toolName}: the proposal is refused before execution`);
      return refusal;
    },
    decorate<T>(baseDefinition: T, toolName: string): T {
      assert.ok(resolver !== undefined, "the coordinator installed its renderer decoration on the host");
      const decorated = resolver!(toolName, () => baseDefinition);
      assert.ok(decorated && typeof decorated === "object", `${toolName}: the host resolves a decorated definition`);
      return decorated as T;
    },
  };
}

/**
 * Exactly what the installed host hands a blocked call's renderer: the refusal
 * text and an empty details record (its own error-result shape), because the
 * tool's `execute` never began. The host reports the error state on the render
 * context rather than on the result object.
 */
export function blockedResult(call: RefusedCall): Record<string, unknown> {
  return { content: [{ type: "text", text: call.reason }], details: {} };
}

/** The host's per-row render context for a call that never started: the recorded
 * submitted arguments, the host's error flag, and `executionStarted: false`. */
export function blockedContext(call: RefusedCall, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    args: call.args,
    toolCallId: call.callId,
    cwd: process.cwd(),
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: true,
    state: {},
    invalidate() {},
    ...overrides,
  };
}

/** Render through the decorated definition and return plain text. */
export function renderDecorated(
  decorated: unknown,
  result: unknown,
  context: unknown,
  theme: unknown = PLAIN_THEME,
  width = 200,
  options: unknown = { expanded: true, isPartial: false },
): string {
  assert.ok(decorated && typeof decorated === "object", "the decorated definition exists");
  const renderResult = (decorated as Record<string, unknown>).renderResult;
  assert.equal(typeof renderResult, "function", "the decorated definition carries a renderResult");
  const component = (renderResult as (...args: unknown[]) => { render(w: number): string[] })(
    result,
    options,
    theme,
    context,
  );
  assert.ok(component && typeof component.render === "function", "the decorated renderer returned a component");
  return component.render(width).join("\n");
}

/** Render the collapsed arm of the same decorated definition. */
export function renderDecoratedCollapsed(
  decorated: unknown,
  result: unknown,
  context: unknown,
  theme: unknown = PLAIN_THEME,
  width = 120,
): string {
  const row = { ...(context as Record<string, unknown>), expanded: false };
  return renderDecorated(decorated, result, row, theme, width, { expanded: false, isPartial: false });
}

/** Strip ANSI styling so assertions can compare plain rendered text. */
export function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
