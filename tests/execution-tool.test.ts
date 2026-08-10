import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

test("execute_subtask is registered only while a configured executor is active", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools = ["read"];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      activeExecutor: null,
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });

  manager.sync();
  assert.equal(registered.length, 0);
  assert.deepEqual(activeTools, ["read"]);

  config.execution!.activeExecutor = { source: "external", id: "fake" };
  manager.sync();
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, "execute_subtask");
  assert.equal(registered[1].name, "execute_subtasks");
  // execute_subtasks is inactive by default (requires parallelEnabled=true)
  assert.deepEqual(activeTools, ["read", "execute_subtask"]);

  const theme = {
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
  };
  type TestTheme = { bold(value: string): string; fg(color: string, value: string): string };
  const renderCall = registered[0].renderCall as (args: unknown, value: TestTheme) => { render(width: number): string[] };
  const renderResult = registered[0].renderResult as (
    result: unknown,
    options: unknown,
    value: TestTheme,
  ) => { render(width: number): string[] };
  assert.match(renderCall({ title: "Implement reconnect tests" }, theme).render(100).join("\n"), /execute_subtask Implement reconnect tests/);
  const live = renderResult({
    content: [{ type: "text", text: "Reviewing" }],
    details: {
      state: "running",
      progress: {
        title: "Implement reconnect tests",
        startedAt: new Date().toISOString(),
        phase: "reviewing",
        message: "openai-codex/gpt-5.6-luna finished · pass",
        model: "llamacpp/Qwen3.6-27B-Q8_0-ROCM-TP2",
        reviewers: ["openai-codex/gpt-5.6-luna (max)"],
        activity: ["bash · npx playwright test", "openai-codex/gpt-5.6-luna finished · pass"],
      },
    },
  }, { expanded: true, isPartial: true }, theme).render(120).join("\n");
  assert.match(live, /Reviewing/);
  assert.match(live, /Recent activity/);
  assert.match(live, /npx playwright test/);
  assert.match(live, /reviewers: openai-codex\/gpt-5\.6-luna \(max\)/);

  const narrowWidth = 80;
  const completed = renderResult({
    content: [{ type: "text", text: "All delegated test files completed successfully." }],
    details: {
      kind: "accepted",
      summary: "All delegated test files completed successfully.",
      changedFiles: Array.from(
        { length: 12 },
        (_, index) => `test/browser/very-long-integration-test-name-${index}.spec.js`,
      ),
      bundleDir: "/tmp/pi-review-subtask-with-a-deliberately-long-artifact-directory-name",
    },
  }, { expanded: true }, theme).render(narrowWidth);
  assert.ok(completed.every((line) => line.length <= narrowWidth - 2), completed.join("\n"));
  assert.match(completed.join("\n"), /changed: .*…/);

  const wide = renderResult({
    content: [{ type: "text", text: "done" }],
    details: {
      state: "running",
      progress: {
        title: "wide activity",
        startedAt: new Date().toISOString(),
        phase: "executing",
        message: `\u001b[31m${"界".repeat(100)}\u001b[0m`,
        activity: [`tool · ${"🧪".repeat(100)}`],
      },
    },
  }, { expanded: true, isPartial: true }, theme).render(narrowWidth);
  assert.ok(wide.every((line) => testVisibleWidth(line) <= narrowWidth - 2), wide.join("\n"));
  assert.equal(wide.some((line) => line.includes("\u001b")), false);

  config.execution!.activeExecutor = null;
  manager.sync();
  assert.equal(registered.length, 2);
  assert.deepEqual(activeTools, ["read"]);
});

function testVisibleWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    width += codePoint >= 0x1100 ? 2 : 1;
  }
  return width;
}
