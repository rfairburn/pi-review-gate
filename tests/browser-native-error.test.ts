import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import type { InteractiveBrowserManager } from "../src/web/interactive-browser";
import { WebToolManager } from "../src/web/tools";

// Point at a scratch/installed agent-core dist/index.js. Do not copy its error
// loop into a mock: this regression must exercise the actual Pi outer result.
const runtime = process.env.PI_BROWSER_AGENT_RUNTIME;
test("interactive Browser failures set native Pi outer isError with text only", { skip: !runtime }, async () => {
  const load = new Function("url", "return import(url)") as (url: string) => Promise<any>;
  const { agentLoop } = await load(pathToFileURL(runtime!).href);
  const tools: any[] = [];
  const privateMarker = "customer-marker-742";
  const scenarios = [
    ["BrowserOpen", "open", { url: "https://example.com/" }, "DNS ENOTFOUND"],
    ["BrowserSnapshot", "snapshot", { session: "owned", tab: "tab" }, "Invalid or stale browser session/tab handle"],
    ["BrowserInspect", "inspect", { session: "owned", tab: "tab", ref: "stale" }, "Invalid or stale browser semantic ref"],
    ["BrowserScreenshot", "screenshot", { session: "owned", tab: "tab" }, "unsupported vision"],
    ["BrowserClick", "click", { session: "owned", tab: "tab", ref: "ref" }, "not_started: policy denied"],
    ["BrowserWait", "wait", { session: "owned", tab: "tab", condition: "duration", durationMs: 1 }, "deadline exceeded"],
    ["BrowserFill", "fill", { session: "owned", tab: "tab", ref: "ref", value: privateMarker }, "failed after dispatch; effect status is unknown; Session teardown is confirmed"],
  ] as const;
  const fake: Record<string, unknown> = { shutdown: async () => {}, updateConfig: () => {} };
  for (const [, method, , reason] of scenarios) fake[method] = async () => { throw new Error(`${reason}: ${privateMarker} ${"page exception ".repeat(1_000)}`); };
  const manager = new WebToolManager({ registerTool: tool => tools.push(tool) }, normalizeConfig({}), undefined, undefined, fake as unknown as InteractiveBrowserManager);
  manager.register();
  // This control proves that a fulfilled result with nested isError does NOT
  // satisfy the runtime contract (and that the runtime is really executing).
  tools.push({ name: "NestedErrorControl", description: "control", label: "control", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "nested error" }], details: {}, isError: true }) });
  const calls = [...scenarios.map(([name, , args], index) => ({ type: "toolCall", id: `call-${index}`, name, arguments: args })),
    { type: "toolCall", id: "control", name: "NestedErrorControl", arguments: {} }];
  const model = { id: "fixture", name: "fixture", provider: "fixture", api: "fixture", input: ["text"], reasoning: false, contextWindow: 10_000, maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const response = { role: "assistant", content: calls, api: "fixture", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  let modelCalls = 0;
  const streamFn = () => {
    modelCalls++;
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "toolUse", message: response }; }, result: async () => response };
  };
  const results: any[] = [];
  try {
    for await (const event of agentLoop([{ role: "user", content: "fixture only", timestamp: 0 }], { systemPrompt: "fixture", messages: [], tools },
      { model, convertToLlm: (messages: unknown[]) => messages, shouldStopAfterTurn: () => true }, undefined, streamFn)) {
      if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
    }
    assert.equal(modelCalls, 1, "only a local mock model was invoked");
    assert.equal(results.length, scenarios.length + 1);
    for (const result of results.slice(0, -1)) {
      assert.equal(result.isError, true, result.toolName);
      assert.deepEqual(result.content.map((part: any) => part.type), ["text"]);
      assert.ok(result.content[0].text.length < 512);
      assert.doesNotMatch(JSON.stringify(result), /customer-marker-742|page exception/);
    }
    assert.match(results.find(result => result.toolName === "BrowserFill").content[0].text, /effect status is unknown.*no rollback/);
    assert.equal(results.at(-1).isError, false, "Pi ignores the nested success-shaped isError field");
  } finally { await manager.cleanup(); }
});
