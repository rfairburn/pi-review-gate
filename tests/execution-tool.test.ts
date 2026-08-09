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
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "execute_subtask");
  assert.deepEqual(activeTools, ["read", "execute_subtask"]);

  config.execution!.activeExecutor = null;
  manager.sync();
  assert.equal(registered.length, 1);
  assert.deepEqual(activeTools, ["read"]);
});
