/**
 * Issue #623: an audit-provider HTTP failure must reach the acting model as a
 * compact host-authored summary, never as the upstream error message, body, or
 * an excerpt of either — while every ordinary non-HTTP auditor diagnostic stays
 * as useful as it was.
 *
 * The contract proven here is deliberately narrow:
 * - an evidenced provider HTTP failure (a structured status, a native
 *   `*_response_failure` diagnostic, an SDK-composed status line, or an HTML
 *   gateway page inside the message) is payload-free in the acting model's
 *   refusal, in a nested refusal, and in the evidence carried to the next audit,
 *   whether or not the status survived;
 * - anything that is not evidenced as an HTTP failure — a provider error
 *   message, a thrown launch or registry failure, a local setup failure, an
 *   opaque word like `terminated` — keeps its own wording, and no cause is
 *   invented for it.
 *
 * Every case runs the production transport and gate: the real
 * `runProtectionAuditor` in-process Pi route plus the real
 * `ToolProtectionCoordinator`, driven to the value the acting model receives.
 * Only the model registry and the host session manager are owned synthetic
 * fixtures, except the final proof, which drives the installed host
 * `SessionManager` itself into a temporary store. All payloads are invented in
 * this file — no real provider traffic, session, credential or host identifier
 * appears anywhere in it.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG, type ReviewGateConfig } from "../src/config";
import { createToolProtectionCoordinator } from "../src/tool-protection/coordinator";
import {
  runProtectionAuditor,
  type ProtectionAuditorObservation,
  type ProtectionAuditorPiModelRegistry,
  type ProtectionAuditorRequest,
} from "../src/tool-protection/runner";
import {
  TOOL_PROTECTION_RECORD_CUSTOM_TYPE,
  type HostAuditorSessionManager,
  type HostAuditorSessionManagerConstructor,
} from "../src/tool-protection/session-record";
import { skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/**
 * A large synthetic gateway page. Markers sit at the head, the middle and the
 * tail, so an assertion can prove no leading excerpt survived either. The host
 * name is reserved by RFC 2606.
 */
const HTML_FILLER = "<p>upstream proxy stall detail</p>".repeat(120);
const LARGE_HTML_BODY = `<html><head><title>504 Gateway Time-out</title></head><body><h1>HEAD-MARKER</h1>${HTML_FILLER}<b>MIDDLE-MARKER</b>${HTML_FILLER}<i>TAIL-MARKER</i></body></html>`;
const UPSTREAM_MESSAGE = `504 Gateway Time-out: ${LARGE_HTML_BODY} (synthetic-upstream-code)`;
const DIAGNOSTIC_URL = "https://auditor.synthetic.invalid/v1/messages";

/** Text that must never reach the acting model for the 504 fixture. */
const FORBIDDEN_PAYLOAD_MARKERS = [
  "HEAD-MARKER",
  "MIDDLE-MARKER",
  "TAIL-MARKER",
  "<html>",
  "<b>",
  "Gateway Time-out",
  "upstream proxy stall detail",
  "synthetic-upstream-code",
  "auditor.synthetic.invalid",
] as const;

function assertNoneOf(text: string, label: string, markers: readonly string[]): void {
  for (const marker of markers) {
    assert.ok(!text.includes(marker), `${label} leaked the payload marker "${marker}": ${text}`);
  }
}

function assertNoPayload(text: string, label: string): void {
  assertNoneOf(text, label, FORBIDDEN_PAYLOAD_MARKERS);
}

/**
 * A JSON error body of the shape the installed `@anthropic-ai/sdk` and `openai`
 * `APIError.makeMessage()` folds into `${status} ${JSON.stringify(body)}`.
 * There is no HTML anywhere in it: this is the native non-HTML HTTP shape.
 */
const UPSTREAM_JSON_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "server_error",
    message: `JSON-HEAD-MARKER upstream json detail ${"json filler.".repeat(200)} JSON-TAIL-MARKER`,
  },
});
const FORBIDDEN_JSON_PAYLOAD_MARKERS = [
  "JSON-HEAD-MARKER",
  "JSON-TAIL-MARKER",
  "upstream json detail",
  "server_error",
] as const;

/**
 * A plain-text failed-response body of the kind a gateway or proxy returns, which
 * `APIError.makeMessage()` folds into `${status} ${msg}` verbatim because
 * `safeJSON()` yields nothing for it. No document marker survives anywhere in it.
 */
const UPSTREAM_PLAIN_BODY = `PLAIN-HEAD-MARKER upstream edge stalled behind the synthetic load balancer, page ops@synthetic.invalid (request 8f2c9a) ${"plain filler. ".repeat(200)}PLAIN-TAIL-MARKER`;
const FORBIDDEN_PLAIN_PAYLOAD_MARKERS = [
  "PLAIN-HEAD-MARKER",
  "PLAIN-TAIL-MARKER",
  "upstream edge stalled",
  "ops@synthetic.invalid",
  "request 8f2c9a",
] as const;

/**
 * The envelope `@google/genai` `throwErrorIfNotOK()` serializes for any non-2xx
 * response — `code` is the response status even when the body was plain text.
 */
const GOOGLE_PAYLOAD_MARKER = "GOOGLE-HTTP-PAYLOAD";
const FORBIDDEN_GOOGLE_PAYLOAD_MARKERS = [GOOGLE_PAYLOAD_MARKER, "upstream google detail"] as const;

function googleEnvelopeText(code: number | undefined): string {
  return JSON.stringify({
    error: {
      message: `${GOOGLE_PAYLOAD_MARKER} upstream google detail`,
      ...(code === undefined ? {} : { code }),
      status: "Gateway Timeout",
    },
  });
}

/** The terminal message of the shape one native-SDK route produces. */
function nativeApiErrorEvent(api: string, provider: string, errorMessage: string): unknown {
  const event = terminalMessageEvent(errorMessage) as { error: Record<string, unknown> };
  event.error.api = api;
  event.error.provider = provider;
  return event;
}

/** A terminal message of the shape pi-ai's google routes produce. */
function googleHttpFailureEvent(api: string, envelope: string): unknown {
  const event = terminalMessageEvent(envelope) as { error: Record<string, unknown> };
  event.error.api = api;
  return event;
}

/** The error event the installed Pi `pi-messages` route produces for an HTTP 504. */
function httpFailureEvent(options: {
  status?: number;
  message?: string;
  withDiagnostic?: boolean;
} = {}): unknown {
  const status = options.status ?? 504;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: [],
    api: "pi-messages",
    provider: "synthetic",
    model: "model",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: options.message ?? UPSTREAM_MESSAGE,
    timestamp: 1,
  };
  if (options.withDiagnostic !== false) {
    // The shape `pi-messages` attaches: the numeric status beside a request URL
    // and the raw body. The gate reads the number and nothing else.
    message.diagnostics = [{
      type: "pi_messages_response_failure",
      timestamp: 1,
      details: {
        version: 1,
        provider: "synthetic",
        model: "model",
        url: DIAGNOSTIC_URL,
        status,
        statusText: "Gateway Time-out",
        body: LARGE_HTML_BODY,
        timestampMs: 1,
      },
    }];
  }
  return { type: "error", reason: "error", error: message };
}

function piDone(text: string): unknown {
  return { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/**
 * The error event the installed host runtime produces for a local setup
 * failure: `api/pi-messages.js` throws inside its stream body and `api/lazy.js`
 * converts it into this same terminal shape, with no status and no diagnostic.
 */
function terminalMessageEvent(
  errorMessage: string,
  options: {
    /** Omitted means the event carries no `reason` field at all. */
    reason?: "error" | "aborted";
    /** Defaults to the value the installed SDK pairs with `reason`. */
    stopReason?: "error" | "aborted";
    diagnostics?: unknown[];
  } = {},
): unknown {
  return {
    type: "error",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    error: {
      role: "assistant",
      content: [],
      api: "pi-messages",
      provider: "synthetic",
      model: "model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: options.stopReason ?? (options.reason === "aborted" ? "aborted" : "error"),
      errorMessage,
      timestamp: 1,
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    },
  };
}

interface RegistryCall {
  /** The one user message the runner actually sent. */
  prompt: string;
}

function fakeRegistry(
  getEvents: () => unknown[],
  captured?: RegistryCall[],
  options: { thrown?: unknown; throwWhileStreaming?: unknown } = {},
): ProtectionAuditorPiModelRegistry {
  return {
    find: (provider, modelId) => ({ provider, id: modelId }),
    getAll: () => [{ provider: "synthetic", id: "model" }],
    streamSimple(_model, context, streamOptions) {
      captured?.push({ prompt: context.messages[0]?.content ?? "" });
      // A throw before the stream exists is a launch failure; a throw from
      // inside the iterator is a decision that died mid-transport.
      if (options.thrown !== undefined) throw options.thrown;
      const events = getEvents();
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
          if (options.throwWhileStreaming !== undefined) throw options.throwWhileStreaming;
          if (events.length === 0) {
            // Never terminates on its own: only the runner's deadline ends this.
            await new Promise<void>((resolve) => {
              if (streamOptions?.signal?.aborted) resolve();
              else streamOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      };
    },
  };
}

function enabledConfig(options: { retain?: boolean; timeoutMs?: number } = {}): ReviewGateConfig {
  return {
    ...DEFAULT_CONFIG,
    toolProtection: {
      level: "aligned",
      auditor: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
      scope: "all",
      toolNames: [],
      timeoutMs: options.timeoutMs ?? 5_000,
      maxContextChars: 200_000,
      debug: false,
      retainAuditorSessions: options.retain === true,
    },
  } as ReviewGateConfig;
}

function hostContext(registry: ProtectionAuditorPiModelRegistry, cwd: string): Record<string, unknown> {
  return {
    ui: {},
    cwd,
    getSystemPrompt: () => "GOVERNING: complete the bounded synthetic task.",
    modelRegistry: registry,
    sessionManager: { buildContextEntries: () => [] },
  };
}

/** One appended entry of the fake host session manager, as the writer called it. */
interface RecordedEntry {
  kind: string;
  payload: unknown;
}

function fakeSessionManager(options: { failOn?: string } = {}): {
  manager: HostAuditorSessionManager;
  entries: RecordedEntry[];
} {
  const entries: RecordedEntry[] = [];
  const push = (kind: string, payload: unknown): void => {
    if (options.failOn === kind) throw new Error(`synthetic: cannot write ${kind}`);
    entries.push({ kind, payload });
  };
  return {
    entries,
    manager: {
      appendSessionInfo: (name: string) => { push("sessionInfo", name); return null; },
      appendThinkingLevelChange: (level: string) => { push("thinkingLevel", level); return null; },
      appendMessage: (message: unknown) => { push("message", message); return null; },
      appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
        push("customMessage", { customType, content, display, details });
        return null;
      },
      appendCustomEntry: (customType: string, data?: unknown) => { push("custom", { customType, data }); return null; },
      getSessionFile: () => undefined,
    },
  };
}

/** The outcome entry one stand-in writer received. */
function recordedOutcome(records: RecordedEntry[]): Record<string, unknown> {
  const outcome = records.find((entry) => entry.kind === "custom"
    && (entry.payload as { customType?: string }).customType === TOOL_PROTECTION_RECORD_CUSTOM_TYPE);
  assert.ok(outcome, "no outcome entry was written");
  return (outcome!.payload as { data: Record<string, unknown> }).data;
}

interface Refusal {
  block?: boolean;
  reason?: string;
  auditTimeout?: boolean;
}

interface Harness {
  coordinator: ReturnType<typeof createToolProtectionCoordinator>;
  /** Admit one synthetic bash proposal through the production runner and gate. */
  admit(callId: string, options?: { parentToolCallId?: string }): Promise<Refusal | undefined>;
  /** Replace what the next audit's transport answers with, keeping this coordinator's state. */
  setEvents(next: unknown[]): void;
  /** Every user message the production runner sent, in order. */
  sent: RegistryCall[];
  records: RecordedEntry[];
  recordLoads: () => number;
}

function harness(options: {
  events?: unknown[];
  retain?: boolean;
  timeoutMs?: number;
  failRecordOn?: string;
  noWriter?: boolean;
  thrown?: unknown;
  throwWhileStreaming?: unknown;
  cwd?: string;
  sessionManager?: HostAuditorSessionManagerConstructor;
} = {}): Harness {
  const cwd = options.cwd ?? "/work";
  const sent: RegistryCall[] = [];
  let events = options.events ?? [];
  const registry = fakeRegistry(() => events, sent, {
    ...(options.thrown === undefined ? {} : { thrown: options.thrown }),
    ...(options.throwWhileStreaming === undefined ? {} : { throwWhileStreaming: options.throwWhileStreaming }),
  });
  const session = fakeSessionManager(options.failRecordOn === undefined ? {} : { failOn: options.failRecordOn });
  let loads = 0;
  const coordinator = createToolProtectionCoordinator({
    config: () => enabledConfig({ retain: options.retain, timeoutMs: options.timeoutMs }),
    cwd: () => cwd,
    role: "primary",
    now: () => 1_000,
    // No runAuditor seam: the production runner drives the production route.
    auditorRecordDependencies: {
      loadSessionManager: async () => {
        loads += 1;
        if (options.sessionManager) return options.sessionManager;
        return options.noWriter ? undefined : { create: () => session.manager };
      },
    },
  });
  return {
    coordinator,
    admit: (callId, admitOptions) => coordinator.admitToolCall([
      {
        toolCallId: callId,
        toolName: "bash",
        input: { command: "echo synthetic" },
        ...(admitOptions?.parentToolCallId ? { parentToolCallId: admitOptions.parentToolCallId } : {}),
      },
      hostContext(registry, cwd),
    ]) as Promise<Refusal | undefined>,
    setEvents: (next: unknown[]) => { events = next; },
    sent,
    records: session.entries,
    recordLoads: () => loads,
  };
}

type HookHandler = (...args: unknown[]) => unknown;

function fakeHost(): { pi: Record<string, unknown>; emit(name: string, ...args: unknown[]): Promise<unknown[]> } {
  const hooks = new Map<string, HookHandler[]>();
  return {
    pi: {
      on(name: string, handler: HookHandler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
      appendEntry: () => undefined,
      registerEntryRenderer: () => undefined,
    },
    async emit(name, ...args) {
      const results: unknown[] = [];
      for (const handler of hooks.get(name) ?? []) results.push(await handler(...args));
      return results.filter((value) => value !== undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// What the acting model receives for an evidenced provider HTTP failure
// ---------------------------------------------------------------------------

test("an audit-provider HTTP 504 with a large HTML body reaches the acting model as a compact summary (#623)", async () => {
  const h = harness({ events: [httpFailureEvent()] });
  const decision = await h.admit("call-504");

  assert.equal(decision?.block, true, "the proposed call stays blocked");
  assert.match(decision?.reason ?? "", /audit unavailable/i);
  assert.match(decision?.reason ?? "", /HTTP 504/, "the reliably known status is still reported");
  assert.match(decision?.reason ?? "", /provider request failed/, "the summary names the failing audit stage");
  assert.match(decision?.reason ?? "", /not run/, "the refusal states the proposed call did not run");
  assertNoPayload(decision?.reason ?? "", "the acting model's refusal");
  assert.ok((decision?.reason ?? "").length < 400, `the refusal is not compact: ${(decision?.reason ?? "").length} chars`);
  assert.equal(h.sent.length, 1, "a failed audit is never retried or re-routed");
  assert.equal(decision?.auditTimeout, undefined, "an upstream 504 is not a confirmed pre-execution timeout");
});

test("the reliable status alone decides what is reported", async () => {
  const unauthorized = harness({
    events: [httpFailureEvent({ status: 401, message: `401 Unauthorized: ${LARGE_HTML_BODY}` })],
  });
  const denied = await unauthorized.admit("call-401");
  assert.match(denied?.reason ?? "", /HTTP 401/);
  assertNoPayload(denied?.reason ?? "", "the 401 refusal");

  const rateLimited = harness({
    events: [httpFailureEvent({ status: 429, message: `429 Too Many Requests: ${LARGE_HTML_BODY}` })],
  });
  const limited = await rateLimited.admit("call-429");
  assert.match(limited?.reason ?? "", /HTTP 429/);
  assertNoPayload(limited?.reason ?? "", "the 429 refusal");
});

test("a gateway status line without a failure diagnostic still reports its reliable status", async () => {
  // `pi-messages` composes `<status> <statusText>: <body>`; the diagnostic is
  // absent, so the anchored status line is the reliable evidence.
  const h = harness({ events: [httpFailureEvent({ withDiagnostic: false })] });
  const decision = await h.admit("call-status-line");
  assert.equal(decision?.block, true);
  assert.match(decision?.reason ?? "", /HTTP 504/);
  assertNoPayload(decision?.reason ?? "", "the status-line refusal");
});

test("a provider HTTP failure with no status anywhere invents no status and carries no payload", async () => {
  // The worst case: a raw HTML body with no status in the message and no
  // structured status on the transport at all.
  const h = harness({ events: [terminalMessageEvent(LARGE_HTML_BODY)] });
  const decision = await h.admit("call-no-status");
  assert.equal(decision?.block, true);
  assert.doesNotMatch(decision?.reason ?? "", /HTTP \d/, "no status is invented");
  assert.match(decision?.reason ?? "", /no HTTP status/, "the absence of a status is stated");
  assertNoPayload(decision?.reason ?? "", "the status-unknown refusal");
  assert.ok((decision?.reason ?? "").length < 400, `the refusal is not compact: ${(decision?.reason ?? "").length} chars`);
});

test("an HTTP failure thrown while the decision stream is being consumed stays payload-free", async () => {
  const withStatus = harness({
    throwWhileStreaming: Object.assign(new Error(`502 Bad Gateway: ${LARGE_HTML_BODY}`), { status: 502 }),
  });
  const decision = await withStatus.admit("call-stream-throw");
  assert.equal(decision?.block, true, "a mid-transport throw still refuses the call");
  assert.match(decision?.reason ?? "", /in-process decision failed \(HTTP 502\)/);
  assertNoPayload(decision?.reason ?? "", "the mid-transport refusal");

  // The same throw with no structured status: payload-free, and no status made up.
  const withoutStatus = harness({ throwWhileStreaming: new Error(`Bad gateway: ${LARGE_HTML_BODY}`) });
  const bare = await withoutStatus.admit("call-stream-throw-bare");
  assert.equal(bare?.block, true);
  assert.doesNotMatch(bare?.reason ?? "", /HTTP \d/, "no status is invented for a thrown body");
  assert.match(bare?.reason ?? "", /no HTTP status/);
  assertNoPayload(bare?.reason ?? "", "the bare mid-transport refusal");
});

test("an auditor invocation that throws an HTTP failure cannot forward its payload through the coordinator catch either", async () => {
  // The coordinator's own catch around the auditor invocation, driven through
  // the supported `runAuditor` seam: a transport failure that escapes the
  // runner is reduced by the same single rule, while any other failure keeps
  // its message.
  const throwing = (error: unknown) => createToolProtectionCoordinator({
    config: () => enabledConfig(),
    cwd: () => "/work",
    role: "primary",
    now: () => 1_000,
    runAuditor: async () => { throw error; },
  });
  const httpCall = await throwing(Object.assign(new Error(`503 Service Unavailable: ${LARGE_HTML_BODY}`), { status: 503 }))
    .admitToolCall([
      { toolCallId: "call-invoke-throw", toolName: "bash", input: { command: "echo synthetic" } },
      hostContext(fakeRegistry(() => []), "/work"),
    ]) as Refusal | undefined;
  assert.equal(httpCall?.block, true, "an auditor that threw fails closed");
  assert.match(httpCall?.reason ?? "", /auditor invocation failed \(HTTP 503\)/);
  assertNoPayload(httpCall?.reason ?? "", "the invocation-throw refusal");

  const plainCall = await throwing(new Error("synthetic auditor seam failure"))
    .admitToolCall([
      { toolCallId: "call-invoke-throw-plain", toolName: "bash", input: { command: "echo synthetic" } },
      hostContext(fakeRegistry(() => []), "/work"),
    ]) as Refusal | undefined;
  assert.equal(plainCall?.block, true);
  assert.match(plainCall?.reason ?? "", /auditor invocation failed \(synthetic auditor seam failure\)/,
    "an ordinary thrown failure keeps its own diagnostic");
});

test("the retained audit evidence and a nested model-visible refusal carry no payload either", async () => {
  const h = harness({ events: [httpFailureEvent()] });
  const host = fakeHost();
  h.coordinator.registerHooks(host.pi as never);

  const nested = await h.admit("call-nested", { parentToolCallId: "root-call" });
  assert.equal(nested?.block, true, "the nested proposal is refused before execution");
  assertNoPayload(nested?.reason ?? "", "the nested refusal");

  // The root call's model-visible content is what the acting model actually reads.
  const annotated = await host.emit("tool_result", {
    toolCallId: "root-call",
    toolName: "SubtasksStart",
    input: {},
    content: [{ type: "text", text: "native tool output" }],
    isError: false,
  }) as Array<Record<string, unknown>>;
  assert.equal(annotated.length, 1, "the nested refusal is disclosed to the acting model");
  const modelText = JSON.stringify(annotated[0]!.content);
  assert.match(modelText, /nested call\(s\) refused/);
  assert.match(modelText, /HTTP 504/);
  assertNoPayload(modelText, "the acting model's nested refusal text");

  // The next audit carries the previous refusal as gate evidence: the auditor
  // model must not receive the payload either.
  h.setEvents([piDone('{"decision":"PASS"}')]);
  const followUp = await h.admit("call-after-refusal");
  assert.equal(followUp, undefined, "the follow-up proposal is audited on its own merits");
  assert.equal(h.sent.length, 2);
  const evidencePrompt = h.sent[1]!.prompt;
  assertNoPayload(evidencePrompt, "the auditor request built from retained evidence");
  assert.match(evidencePrompt, /HTTP 504/, "the refusal evidence keeps its compact summary");
});

test("a native non-HTML HTTP failure is payload-free at the root, when nested, and in later evidence (#623 review)", async () => {
  // The exact terminal shape the installed `@anthropic-ai/sdk` and `openai`
  // `APIError.makeMessage()` composes — `${status} ${JSON.stringify(body)}` —
  // with no HTML anywhere and no structured status on the terminal message,
  // because `api/anthropic-messages.js` copies only `error.message` there.
  const h = harness({ events: [terminalMessageEvent(`504 ${UPSTREAM_JSON_BODY}`)] });
  const host = fakeHost();
  h.coordinator.registerHooks(host.pi as never);

  const direct = await h.admit("call-json-root");
  assert.equal(direct?.block, true, "the proposed call stays blocked");
  assert.match(direct?.reason ?? "", /HTTP 504/, "the reliable status from the folded status line is reported");
  assertNoneOf(direct?.reason ?? "", "the root refusal", FORBIDDEN_JSON_PAYLOAD_MARKERS);
  assert.ok((direct?.reason ?? "").length < 400, `the refusal is not compact: ${(direct?.reason ?? "").length} chars`);

  const nested = await h.admit("call-json-nested", { parentToolCallId: "root-call" });
  assert.equal(nested?.block, true);
  assertNoneOf(nested?.reason ?? "", "the nested refusal", FORBIDDEN_JSON_PAYLOAD_MARKERS);

  const annotated = await host.emit("tool_result", {
    toolCallId: "root-call",
    toolName: "SubtasksStart",
    input: {},
    content: [{ type: "text", text: "native tool output" }],
    isError: false,
  }) as Array<Record<string, unknown>>;
  const modelText = JSON.stringify(annotated[0]!.content);
  assert.match(modelText, /nested call\(s\) refused/);
  assertNoneOf(modelText, "the acting model's nested refusal text", FORBIDDEN_JSON_PAYLOAD_MARKERS);

  h.setEvents([piDone('{"decision":"PASS"}')]);
  const followUp = await h.admit("call-json-after-refusal");
  assert.equal(followUp, undefined, "the follow-up proposal is audited on its own merits");
  const evidencePrompt = h.sent[h.sent.length - 1]!.prompt;
  assertNoneOf(evidencePrompt, "the auditor request built from retained evidence", FORBIDDEN_JSON_PAYLOAD_MARKERS);
  assert.match(evidencePrompt, /HTTP 504/, "the evidence keeps the compact summary");
});

test("a native plain-text HTTP body is payload-free at the root, when nested, and in later evidence (#623 correction)", async () => {
  // `@anthropic-ai/sdk` 0.129.0 and `openai` 7.19.0 `APIError.makeMessage()`
  // compose `${status} ${msg}` with a non-JSON response body copied verbatim, and
  // the terminal message carries no structured status and no
  // `*_response_failure` diagnostic. Each case below is the exact text the tagged
  // route assigns to `errorMessage`: unchanged where the route passes no prefix to
  // `formatProviderError()`, and `<provider tag> API error (${status}): …` where it
  // does — that prefix comes from `model.provider`, so a tag with a digit or an
  // underscore, or longer than 48 characters, is outside
  // `NORMALIZED_STATUS_LINE`'s letter-only prefix class. The status is the failed
  // response's own, so it is reported; the text after it is never read.
  for (const { api, provider, message } of [
    { api: "anthropic-messages", provider: "anthropic", message: `504 ${UPSTREAM_PLAIN_BODY}` },
    { api: "openai-completions", provider: "openai", message: `504 ${UPSTREAM_PLAIN_BODY}` },
    { api: "openai-responses", provider: "openai", message: `OpenAI API error (504): 504 ${UPSTREAM_PLAIN_BODY}` },
    { api: "openai-responses", provider: "proxy2", message: `proxy2 API error (504): 504 ${UPSTREAM_PLAIN_BODY}` },
    { api: "openai-responses", provider: "edge_v2.internal-gateway-for-synthetic-traffic-01", message: `edge_v2.internal-gateway-for-synthetic-traffic-01 API error (504): 504 ${UPSTREAM_PLAIN_BODY}` },
    // The same prefix when the SDK body was extracted separately, so no second
    // status follows it.
    { api: "openai-responses", provider: "proxy2", message: `proxy2 API error (504): ${UPSTREAM_PLAIN_BODY}` },
    // Azure composes a constant prefix, which the normalized status line already
    // reads; the body after it is plain text here.
    { api: "azure-openai-responses", provider: "azure-openai", message: `Azure OpenAI API error (504): 504 ${UPSTREAM_PLAIN_BODY}` },
  ]) {
    const label = `${api}/${provider}`;
    const h = harness({ events: [nativeApiErrorEvent(api, provider, message)], retain: true });
    const host = fakeHost();
    h.coordinator.registerHooks(host.pi as never);

    const root = await h.admit(`call-plain-${label}-root`);
    assert.equal(root?.block, true, "the proposed call stays blocked");
    assert.match(root?.reason ?? "", /HTTP 504/, `${label}: the reliable status from the native composed message is reported`);
    assertNoneOf(root?.reason ?? "", `the ${label} root refusal`, FORBIDDEN_PLAIN_PAYLOAD_MARKERS);
    assert.ok((root?.reason ?? "").length < 400, `the ${label} refusal is not compact: ${(root?.reason ?? "").length} chars`);

    const nested = await h.admit(`call-plain-${label}-nested`, { parentToolCallId: "root-call" });
    assert.equal(nested?.block, true);
    assertNoneOf(nested?.reason ?? "", `the ${label} nested refusal`, FORBIDDEN_PLAIN_PAYLOAD_MARKERS);

    const annotated = await host.emit("tool_result", {
      toolCallId: "root-call",
      toolName: "SubtasksStart",
      input: {},
      content: [{ type: "text", text: "native tool output" }],
      isError: false,
    }) as Array<Record<string, unknown>>;
    const modelText = JSON.stringify(annotated[0]!.content);
    assert.match(modelText, /nested call\(s\) refused/);
    assertNoneOf(modelText, `the acting model's ${label} nested refusal text`, FORBIDDEN_PLAIN_PAYLOAD_MARKERS);

    // The private record keeps what the transport actually carried.
    assert.ok(JSON.stringify(h.records).includes("PLAIN-HEAD-MARKER"),
      `${label}: the retained record lost the body the transport carried`);

    // The next audit carries the refusal as gate evidence: no payload there either.
    h.setEvents([piDone('{"decision":"PASS"}')]);
    assert.equal(await h.admit(`call-plain-${label}-follow-up`), undefined);
    const evidencePrompt = h.sent[h.sent.length - 1]!.prompt;
    assertNoneOf(evidencePrompt, `the ${label} auditor request built from retained evidence`, FORBIDDEN_PLAIN_PAYLOAD_MARKERS);
    assert.match(evidencePrompt, /HTTP 504/, "the evidence keeps the compact summary");
  }
});

test("a route that composes no native status line keeps its wording, prefixed or not (#623 correction)", async () => {
  // `api/pi-messages.js` composes `${status} ${statusText}: ${body}` and attaches a
  // `pi_messages_response_failure` diagnostic carrying the status for a real failed
  // response; `api/openai-codex-responses.js` composes its own friendly text. A
  // leading number there — or an `… API error:` sentence without the composed
  // `(${status}):` — is not the native shape, so the message survives as the
  // diagnostic it is rather than being silenced.
  for (const { api, provider, message } of [
    { api: "pi-messages", provider: "synthetic", message: "504 still warming up: synthetic note" },
    { api: "pi-messages", provider: "proxy2", message: "proxy2 API error (504): 504 still warming up: synthetic note" },
    { api: "openai-codex-responses", provider: "openai", message: "504 still warming up: synthetic note" },
    { api: "openai-responses", provider: "proxy2", message: "proxy2 API error: upstream refused the synthetic handshake" },
  ]) {
    const h = harness({ events: [nativeApiErrorEvent(api, provider, message)] });
    const decision = await h.admit(`call-plain-control-${api}-${provider}`);
    assert.equal(decision?.block, true, "the proposed call still fails closed");
    assert.match(decision?.reason ?? "", new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the wording survives");
    assert.doesNotMatch(decision?.reason ?? "", /HTTP \d|no HTTP status/, "no status is invented for another route's prose");
  }
});

test("the native Google HTTP error envelope stays payload-free (#623 review)", async () => {
  // `api/google-generative-ai.js` and `api/google-vertex.js` both copy the SDK's
  // serialized envelope into `errorMessage` after dropping the outer status, so
  // neither the composed status lines nor the HTML page check can see it.
  for (const api of ["google-generative-ai", "google-vertex"]) {
    const h = harness({ events: [googleHttpFailureEvent(api, googleEnvelopeText(504))], retain: true });

    const root = await h.admit(`call-${api}-root`);
    assert.equal(root?.block, true, "the proposed call stays blocked");
    assert.match(root?.reason ?? "", /HTTP 504/, "the envelope's structured status is reported");
    assertNoneOf(root?.reason ?? "", "the Google-envelope refusal", FORBIDDEN_GOOGLE_PAYLOAD_MARKERS);

    const nested = await h.admit(`call-${api}-nested`, { parentToolCallId: "root-call" });
    assert.equal(nested?.block, true);
    assertNoneOf(nested?.reason ?? "", "the nested Google-envelope refusal", FORBIDDEN_GOOGLE_PAYLOAD_MARKERS);

    // The private record keeps what the transport actually carried.
    assert.ok(JSON.stringify(h.records).includes(GOOGLE_PAYLOAD_MARKER),
      "the retained record lost the envelope the transport carried");

    // The next audit carries the refusal as gate evidence: no payload there either.
    h.setEvents([piDone('{"decision":"PASS"}')]);
    assert.equal(await h.admit(`call-${api}-follow-up`), undefined);
    assertNoneOf(h.sent[h.sent.length - 1]!.prompt, "the auditor request built from retained evidence", FORBIDDEN_GOOGLE_PAYLOAD_MARKERS);
  }
});

test("a Google-routed message is only read as HTTP when the envelope is complete (#623 review)", async () => {
  // Same route tag, incomplete envelope: an ordinary diagnostic, not a status.
  const incomplete = harness({ events: [googleHttpFailureEvent("google-generative-ai", '{"error":{"message":"synthetic google note","status":"Unavailable"}}')] });
  const incompleteDecision = await incomplete.admit("call-google-no-code");
  assert.equal(incompleteDecision?.block, true);
  assert.match(incompleteDecision?.reason ?? "", /synthetic google note/, "the wording survives");
  assert.doesNotMatch(incompleteDecision?.reason ?? "", /HTTP \d|no HTTP status/, "no status is invented");

  // A success-range code is not a failed response either.
  const successCode = harness({ events: [googleHttpFailureEvent("google-generative-ai", googleEnvelopeText(200))] });
  const successDecision = await successCode.admit("call-google-success-code");
  assert.equal(successDecision?.block, true);
  assert.doesNotMatch(successDecision?.reason ?? "", /HTTP \d|no HTTP status/, "a 200 in a body is not a failure status");
  assert.match(successDecision?.reason ?? "", new RegExp(GOOGLE_PAYLOAD_MARKER), "the wording survives");

  // The same text on another route is not reclassified by tag-free guessing.
  const otherRoute = harness({ events: [terminalMessageEvent(googleEnvelopeText(504))] });
  const otherDecision = await otherRoute.admit("call-google-envelope-other-route");
  assert.equal(otherDecision?.block, true);
  assert.doesNotMatch(otherDecision?.reason ?? "", /HTTP 504/, "the envelope is honoured only on the routes that produce it");
});

test("the other installed status lines are read as HTTP failures too (#623 review)", async () => {
  // `utils/error-body.js` without a prefix, as `api/openai-completions.js`
  // composes it after reading the structured status off the SDK error.
  const normalized = harness({
    events: [terminalMessageEvent(`400: ${JSON.stringify({ error: { message: "JSON-HEAD-MARKER normalized detail" } })}`)],
  });
  const normalizedDecision = await normalized.admit("call-normalized-line");
  assert.equal(normalizedDecision?.block, true);
  assert.match(normalizedDecision?.reason ?? "", /HTTP 400/);
  assertNoneOf(normalizedDecision?.reason ?? "", "the normalized-line refusal", FORBIDDEN_JSON_PAYLOAD_MARKERS);

  // `utils/error-body.js` with its optional provider prefix.
  const prefixed = harness({
    events: [terminalMessageEvent(`Azure OpenAI API error (502): ${JSON.stringify({ error: { message: "JSON-HEAD-MARKER prefixed detail" } })}`)],
  });
  const prefixedDecision = await prefixed.admit("call-prefixed-line");
  assert.equal(prefixedDecision?.block, true);
  assert.match(prefixedDecision?.reason ?? "", /HTTP 502/);
  assertNoneOf(prefixedDecision?.reason ?? "", "the prefixed-line refusal", FORBIDDEN_JSON_PAYLOAD_MARKERS);

  // A status line whose phrase is not the real reason phrase for that status is
  // not a gateway status line, so the diagnostic survives.
  const notAGateway = harness({ events: [terminalMessageEvent("504 still warming up: synthetic note")] });
  const honestDecision = await notAGateway.admit("call-not-a-gateway");
  assert.equal(honestDecision?.block, true);
  assert.match(honestDecision?.reason ?? "", /504 still warming up: synthetic note/, "the wording survives");
  assert.doesNotMatch(honestDecision?.reason ?? "", /HTTP \d|no HTTP status/);
});

// ---------------------------------------------------------------------------
// Negative controls: the diagnostics that were already useful stay useful
// ---------------------------------------------------------------------------

test("an ordinary provider diagnostic reaches the acting model with its own wording (#623 review)", async () => {
  const h = harness({ events: [terminalMessageEvent("synthetic provider error")] });
  const decision = await h.admit("call-plain-provider-error");
  assert.equal(decision?.block, true, "the proposed call still fails closed");
  assert.match(decision?.reason ?? "", /synthetic provider error/, "the provider diagnostic survives");
  assert.doesNotMatch(decision?.reason ?? "", /HTTP \d/, "no status is invented for a non-HTTP failure");
  assert.doesNotMatch(decision?.reason ?? "", /no HTTP status/, "a known diagnostic is not reported as unknown");
  assert.equal(decision?.auditTimeout, undefined, "a provider error is not a pre-execution timeout");
});

test("a non-response-failure diagnostic does not silence a useful message (#623 review)", async () => {
  // `provider_transport_failure` in the installed SDK records a websocket-to-sse
  // transport fallback, not a failed HTTP response, so it is not evidence to
  // reduce: only a `*_response_failure` diagnostic is.
  const h = harness({
    events: [terminalMessageEvent("synthetic websocket transport fell back to sse", {
      diagnostics: [{ type: "provider_transport_failure", timestamp: 1, details: { phase: "before_message_stream_start" } }],
    })],
  });
  const decision = await h.admit("call-transport-fallback-diagnostic");
  assert.equal(decision?.block, true);
  assert.match(decision?.reason ?? "", /synthetic websocket transport fell back to sse/, "the diagnostic stays readable");
  assert.doesNotMatch(decision?.reason ?? "", /HTTP \d|no HTTP status/, "a fallback diagnostic is not a failed response");
});

test("a local setup failure keeps the host runtime's own actionable sentence", async () => {
  // Exact wording `api/pi-messages.js` throws, delivered as the error event its
  // own `lazyStream` builds: no status, no diagnostic, no HTML.
  for (const wording of [
    'No API key provided for provider "synthetic"',
    "No API key for provider: synthetic",
    "Provider is not configured: synthetic",
    "Unknown provider: synthetic",
  ]) {
    const h = harness({ events: [terminalMessageEvent(wording)] });
    const decision = await h.admit(`call-setup-${wording.length}`);
    assert.equal(decision?.block, true, "the proposed call stays blocked");
    assert.match(decision?.reason ?? "", new RegExp(wording.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the setup diagnostic was not forwarded: ${decision?.reason}`);
    assert.doesNotMatch(decision?.reason ?? "", /HTTP \d|no HTTP status/, "no status is invented");
    assert.doesNotMatch(decision?.reason ?? "", /cancel|aborted|timed out/i, "a setup failure is not a cancellation or timeout");
  }
});

test("an explicit native abort classifies as cancelled, the same opaque word without it does not (#623 review)", async () => {
  // One opaque provider wording, three native metadata states. Only the explicit
  // abort metadata may classify a cancellation, and none of them may invent a
  // timeout or a status.
  const noReason = harness({ events: [terminalMessageEvent("terminated")], retain: true });
  const noReasonDecision = await noReason.admit("call-word-no-reason");
  assert.equal(noReasonDecision?.block, true);
  assert.match(noReasonDecision?.reason ?? "", /terminated/, "the provider's word is kept as the diagnostic");
  assert.doesNotMatch(noReasonDecision?.reason ?? "", /cancel|aborted|timed out|HTTP \d/i,
    "a bare 'terminated' proves neither a cancellation nor a transport stall nor a status");
  assert.equal(recordedOutcome(noReason.records).status, "transport-error",
    "no cancellation is invented for a failure the transport did not mark");

  const aborted = harness({ events: [terminalMessageEvent("terminated", { reason: "aborted" })], retain: true });
  const abortedDecision = await aborted.admit("call-word-aborted");
  assert.equal(abortedDecision?.block, true);
  assert.match(abortedDecision?.reason ?? "", /Auditor was aborted\./,
    "the native reason classifies the cancellation the transport reported");
  assert.doesNotMatch(abortedDecision?.reason ?? "", /timed out|HTTP \d/, "a cancellation is never a timeout or a status");
  assert.equal(abortedDecision?.auditTimeout, undefined, "a cancellation keeps no duplicate-accounting timeout marker");
  assert.equal(recordedOutcome(aborted.records).status, "cancelled", "the record keeps the reported cancellation");

  // The terminal message's own `stopReason` carries the same metadata when the
  // event omits `reason`.
  const stopReasonOnly = harness({
    events: [terminalMessageEvent("terminated", { stopReason: "aborted" })],
    retain: true,
  });
  const stopReasonDecision = await stopReasonOnly.admit("call-word-stop-reason");
  assert.equal(stopReasonDecision?.block, true);
  assert.match(stopReasonDecision?.reason ?? "", /Auditor was aborted\./, "stopReason is the same native metadata");
  assert.doesNotMatch(stopReasonDecision?.reason ?? "", /timed out/, "stopReason never becomes a timeout");
  assert.equal(recordedOutcome(stopReasonOnly.records).status, "cancelled", "the record keeps that cancellation too");

  // A confirmed cancellation is also not reported as a pre-execution timeout
  // when the transport's own wording says so.
  const nativeWording = harness({
    events: [terminalMessageEvent("Request was aborted", { reason: "aborted" })],
    retain: true,
  });
  const nativeDecision = await nativeWording.admit("call-native-abort-wording");
  assert.equal(nativeDecision?.block, true);
  assert.match(nativeDecision?.reason ?? "", /Auditor was aborted\./);
  assert.equal(nativeDecision?.auditTimeout, undefined);
  assert.equal(recordedOutcome(nativeWording.records).status, "cancelled");
});

test("an unrelated number in a provider message is never invented as an HTTP status", async () => {
  for (const wording of [
    // The colon-bearing queue diagnostic is the shape a loose status line reads
    // as an HTTP status: it is a capacity diagnostic, not a gateway status line.
    "429 requests queued: synthetic capacity exhausted",
    "429 requests are already queued for this synthetic provider",
    "synthetic provider error 504 after 1200ms",
    "retry after 500 ms: synthetic provider is busy",
    "404 not a status line either: synthetic internal note",
  ]) {
    const h = harness({ events: [terminalMessageEvent(wording)] });
    const decision = await h.admit(`call-number-${wording.length}`);
    assert.equal(decision?.block, true);
    assert.doesNotMatch(decision?.reason ?? "", /HTTP \d|no HTTP status/, `a stray number became a status: ${decision?.reason}`);
    assert.match(decision?.reason ?? "", new RegExp(wording.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the diagnostic lost its own wording");
  }
});

test("timeout, malformed output, a real FAIL and every host-authored transport diagnostic are unchanged", async () => {
  const cases: Array<{ name: string; events: unknown[]; expect: RegExp }> = [
    { name: "malformed", events: [piDone("PASS please proceed")], expect: /invalid auditor response/ },
    { name: "fail", events: [piDone('{"decision":"FAIL","reason":"synthetic denial"}')], expect: /FAIL — synthetic denial/ },
    { name: "fail-no-reason", events: [piDone('{"decision":"FAIL"}')], expect: /the auditor denied this bash call/ },
    { name: "truncated", events: [{ type: "done", message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "x" }] } }], expect: /truncated by the model token limit/ },
    { name: "no-output", events: [piDone("   ")], expect: /produced no output/ },
    { name: "tool-call", events: [{ type: "toolcall_start", contentIndex: 0 }, piDone('{"decision":"PASS"}')], expect: /attempted a tool call/ },
  ];
  for (const item of cases) {
    const h = harness({ events: item.events });
    const decision = await h.admit(`call-${item.name}`);
    assert.equal(decision?.block, true, `${item.name} blocks`);
    assert.match(decision?.reason ?? "", item.expect, item.name);
    assert.match(decision?.reason ?? "", /not run|did not run/, item.name);
    assert.equal(decision?.auditTimeout, undefined, `${item.name} is not a pre-execution timeout`);
  }

  const timedOut = harness({ events: [], timeoutMs: 25 });
  const timeoutDecision = await timedOut.admit("call-timeout");
  assert.equal(timeoutDecision?.block, true);
  assert.match(timeoutDecision?.reason ?? "", /timed out after 25ms/, "the auditor's own deadline is still named");
  assert.equal(timeoutDecision?.auditTimeout, true, "the confirmed timeout keeps its duplicate-accounting marker");
});

test("the runner keeps non-HTTP diagnostics, reduces only evidenced HTTP failures, and leaves the observation untouched", async () => {
  const base: ProtectionAuditorRequest = {
    selection: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
    config: enabledConfig(),
    prompt: "Synthetic decision prompt with no live data.",
    input: { proposal: { tool: "synthetic", args: {} } },
    cwd: "/work",
    timeoutMs: 5_000,
  };

  const registryUnavailable = await runProtectionAuditor({
    ...base,
    modelRegistry: {
      find: () => ({ provider: "synthetic", id: "model" }),
      getAll: () => { throw new Error("synthetic registry failure"); },
      streamSimple: () => fakeRegistry(() => []) as unknown as AsyncIterable<unknown>,
    },
  });
  assert.match(registryUnavailable.error ?? "", /model registry is unavailable: synthetic registry failure/,
    "an actionable model-registry diagnostic survives unchanged");

  // A live host registry can also fail with a gateway page; the same rule
  // applies to that throw, and only to it.
  const registryLookup = await runProtectionAuditor({
    ...base,
    modelRegistry: {
      find: () => { throw Object.assign(new Error(`503 Service Unavailable: ${LARGE_HTML_BODY}`), { status: 503 }); },
      getAll: () => [{ provider: "synthetic", id: "model" }],
      streamSimple: () => fakeRegistry(() => []) as unknown as AsyncIterable<unknown>,
    },
  });
  assert.match(registryLookup.error ?? "", /model registry lookup failed \(HTTP 503/);
  assertNoPayload(registryLookup.error ?? "", "the registry-throw summary");

  const launchWithHttpBody = await runProtectionAuditor({
    ...base,
    modelRegistry: fakeRegistry(() => [], undefined, { thrown: Object.assign(new Error(`502 Bad Gateway: ${LARGE_HTML_BODY}`), { status: 502 }) }),
  });
  assert.match(launchWithHttpBody.error ?? "", /in-process launch failed \(HTTP 502/);
  assertNoPayload(launchWithHttpBody.error ?? "", "the launch-failure summary");

  const launchPlain = await runProtectionAuditor({
    ...base,
    modelRegistry: fakeRegistry(() => [], undefined, { thrown: new Error("synthetic auth failure") }),
  });
  assert.match(launchPlain.error ?? "", /in-process launch failed: synthetic auth failure/,
    "an ordinary thrown launch diagnostic keeps its wording");

  let observed: unknown;
  const providerFailure = await runProtectionAuditor({
    ...base,
    modelRegistry: fakeRegistry(() => [httpFailureEvent()]),
    observe: (value: ProtectionAuditorObservation) => { observed = value; },
  });
  assert.match(providerFailure.error ?? "", /provider request failed \(HTTP 504/);
  assertNoPayload(providerFailure.error ?? "", "the runner's model-facing error");
  // The retention sink still receives exactly what the transport carried.
  const serialized = JSON.stringify(observed);
  assert.ok(serialized.includes("MIDDLE-MARKER"), "the observation stopped reporting what the transport carried");
  assert.ok(serialized.includes(DIAGNOSTIC_URL), "the observation stopped reporting the transport's diagnostic detail");
});

// ---------------------------------------------------------------------------
// Retention with a stand-in writer: what the record keeps, and what Off never touches
// ---------------------------------------------------------------------------

test("retention On keeps the transport's original terminal diagnostics in the private record (#623)", async () => {
  const h = harness({ events: [httpFailureEvent()], retain: true });
  const decision = await h.admit("call-retain");

  assert.equal(h.recordLoads(), 1, "an opted-in record loads the host session writer once");
  assert.equal(decision?.block, true);
  assertNoPayload(decision?.reason ?? "", "the refusal even with retention On");
  assert.match(decision?.reason ?? "", /HTTP 504/);

  const serialized = JSON.stringify(h.records);
  // The transport DID expose the upstream text, so the record keeps it verbatim.
  assert.ok(serialized.includes("MIDDLE-MARKER"), "the retained record lost the provider's terminal message");
  assert.ok(serialized.includes("HEAD-MARKER"), "the retained record kept only an excerpt of the terminal message");
  assert.ok(serialized.includes(DIAGNOSTIC_URL), "the retained record lost the transport's own diagnostic detail");

  const outcome = h.records.find((entry) => entry.kind === "custom"
    && (entry.payload as { customType?: string }).customType === TOOL_PROTECTION_RECORD_CUSTOM_TYPE);
  assert.ok(outcome, "no outcome entry was written");
  const outcomeData = (outcome!.payload as { data: Record<string, unknown> }).data;
  assert.equal(outcomeData.status, "transport-error", "the audit failure keeps its recorded classification");
  assert.match(String(outcomeData.hostError), /HTTP 504/);
  assert.ok(!String(outcomeData.hostError).includes("MIDDLE-MARKER"),
    "the outcome entry repeats the upstream payload instead of the compact summary");
});

test("retention Off reaches no session storage, and an unavailable writer changes neither verdict nor refusal", async () => {
  const off = harness({ events: [httpFailureEvent()] });
  const offDecision = await off.admit("call-off");
  assert.equal(off.recordLoads(), 0, "Off never loads the session writer");
  assert.deepEqual(off.records, [], "Off writes no session entries");
  assert.equal(offDecision?.block, true);
  assertNoPayload(offDecision?.reason ?? "", "the refusal with retention Off");
  assert.match(offDecision?.reason ?? "", /HTTP 504/);
  assert.doesNotMatch(offDecision?.reason ?? "", /saved/, "no recording claim is made when nothing was recorded");

  const noWriter = harness({ events: [httpFailureEvent()], retain: true, noWriter: true });
  const decision = await noWriter.admit("call-no-writer");
  assert.equal(decision?.block, true);
  assert.match(decision?.reason ?? "", /could not be saved/, "the recording failure is disclosed inline");
  assert.match(decision?.reason ?? "", /gate decision is unchanged/);
  assert.match(decision?.reason ?? "", /HTTP 504/, "the audit summary is still reported");
  assertNoPayload(decision?.reason ?? "", "the refusal beside a failed record");
});

test("a failing record keeps its honest warning and the unchanged compact verdict", async () => {
  const h = harness({ events: [httpFailureEvent()], retain: true, failRecordOn: "message" });
  const decision = await h.admit("call-record-fails");
  assert.equal(decision?.block, true);
  assert.match(decision?.reason ?? "", /could not be saved/, "the save failure stays visible");
  assert.match(decision?.reason ?? "", /HTTP 504/, "the audit summary is still reported");
  assertNoPayload(decision?.reason ?? "", "the refusal beside a failed record");
  assert.ok(h.records.some((entry) => entry.kind === "sessionInfo"), "the record was opened before the failure");
});

// ---------------------------------------------------------------------------
// The same proof through the installed host SessionManager, reading the .jsonl
// that was actually written
// ---------------------------------------------------------------------------

interface NativeSessionManagerModule {
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: Record<string, unknown>): unknown;
  };
}

// tsc rewrites `await import(x)` in CommonJS output to require(x), which cannot
// load the installed package's ESM entry. Compile a native dynamic import the
// transpiler leaves untouched (the established technique in this repository).
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * The installed host's own `SessionManager`, resolved the same way the product
 * resolves an installed host peer. Nothing is installed or updated here, and no
 * ambient path is hardcoded: the discovery is the repository's existing
 * installed-agent resolution, which honours `PI_REVIEW_GATE_INSTALLED_AGENT`.
 * The reason for an unavailable host is reported, never guessed at.
 */
async function loadNativeSessionManager(): Promise<{
  mod?: NativeSessionManagerModule;
  reason: string;
}> {
  const dirs = findInstalledAgentDirs();
  if (dirs.length === 0) return { reason: "no installed Pi is resolvable in this environment" };
  let lastFailure = "no installed Pi package exposes dist/core/session-manager.js";
  for (const agentDir of dirs) {
    const entry = join(agentDir, "dist", "core", "session-manager.js");
    if (!existsSync(entry)) continue;
    try {
      const loaded = await nativeDynamicImport(pathToFileURL(entry).href) as Partial<NativeSessionManagerModule>;
      if (typeof loaded?.SessionManager?.create === "function") {
        return { mod: loaded as NativeSessionManagerModule, reason: "" };
      }
      lastFailure = "the installed Pi SessionManager has no static create()";
    } catch (error) {
      lastFailure = `the installed Pi session SDK could not be imported (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return { reason: lastFailure };
}

function nativeConstructor(mod: NativeSessionManagerModule, sessionDir: string): HostAuditorSessionManagerConstructor {
  return {
    // Only the store directory is redirected, into this test's own temporary
    // tree; the manager, its appends, and its file are entirely the host's.
    create: (cwd, _sessionDir, options) =>
      mod.SessionManager.create(cwd, sessionDir, (options ?? {}) as Record<string, unknown>) as HostAuditorSessionManager,
  };
}

async function listSessionFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
}

test("the installed host SessionManager writes the terminal diagnostics to the saved .jsonl, and Off writes nothing (#623)", async (t: TestContext) => {
  const host = await loadNativeSessionManager();
  const native = host.mod;
  if (!native) {
    skipOrFail(t, host.reason);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "prg-623-native-record-"));
  try {
    const workspace = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const offDir = join(root, "sessions-off");
    await mkdir(workspace);
    await mkdir(sessionDir);
    await mkdir(offDir);

    // 1. Retention On: the production coordinator and runner record through the
    //    real host writer, and the file that actually exists on disk keeps the
    //    transport's original terminal message and diagnostics.
    const on = harness({
      events: [httpFailureEvent()],
      retain: true,
      cwd: workspace,
      sessionManager: nativeConstructor(native, sessionDir),
    });
    const onDecision = await on.admit("call-native-on");
    assert.equal(onDecision?.block, true);
    assert.match(onDecision?.reason ?? "", /HTTP 504/);
    assertNoPayload(onDecision?.reason ?? "", "the refusal beside a real saved record");

    const files = await listSessionFiles(sessionDir);
    assert.equal(files.length, 1, `one saved session was expected, found: ${files.join(", ")}`);
    const raw = await readFile(join(sessionDir, files[0]!), "utf8");
    assert.ok(raw.includes("MIDDLE-MARKER"), "the saved .jsonl lost the provider's terminal message");
    assert.ok(raw.includes("HEAD-MARKER"), "the saved .jsonl kept only an excerpt of the terminal message");
    assert.ok(raw.includes(DIAGNOSTIC_URL), "the saved .jsonl lost the transport's own failure diagnostic");
    assert.ok(raw.includes(TOOL_PROTECTION_RECORD_CUSTOM_TYPE), "the saved .jsonl has no outcome entry");
    assert.ok(/"status":"transport-error"/.test(raw), "the saved outcome invented another classification");

    // The compact summary reaches the record too — as host status text, never as
    // a second copy of the payload.
    const outcomeLines = raw
      .split("\n")
      .filter((line) => line.includes(TOOL_PROTECTION_RECORD_CUSTOM_TYPE));
    assert.ok(outcomeLines.length >= 1);
    assert.ok(outcomeLines.some((line) => /HTTP 504/.test(line)), "the outcome entry lost the reliable status");
    assert.ok(!outcomeLines.some((line) => line.includes("MIDDLE-MARKER")),
      "the outcome entry repeated the upstream payload");

    // 2. Retention Off: the writer is never loaded and no new file appears.
    const off = harness({
      events: [httpFailureEvent()],
      cwd: workspace,
      sessionManager: nativeConstructor(native, offDir),
    });
    const offDecision = await off.admit("call-native-off");
    assert.equal(offDecision?.block, true);
    assertNoPayload(offDecision?.reason ?? "", "the refusal with retention Off");
    assert.equal(off.recordLoads(), 0, "Off never loads the host session writer");
    assert.deepEqual(await listSessionFiles(offDir), [], "Off created no saved session");

    // 3. A recording failure is disclosed truthfully and changes nothing else:
    //    the session store path is under a regular file, so the host writer
    //    really cannot create it.
    const blocker = join(root, "blocked");
    await writeFile(blocker, "not a directory");
    const failing = harness({
      events: [httpFailureEvent()],
      retain: true,
      cwd: workspace,
      sessionManager: nativeConstructor(native, join(blocker, "sessions")),
    });
    const failingDecision = await failing.admit("call-native-failing");
    assert.equal(failingDecision?.block, true, "a recording problem never changes the verdict");
    assert.match(failingDecision?.reason ?? "", /HTTP 504/, "the audit summary is still reported");
    assert.match(failingDecision?.reason ?? "", /could not be saved|only partially saved/,
      `the recording failure was not disclosed honestly: ${failingDecision?.reason}`);
    assertNoPayload(failingDecision?.reason ?? "", "the refusal beside a failed record");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
