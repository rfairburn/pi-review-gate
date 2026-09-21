import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { EXECUTION_TOOL_NAMES, ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";
import {
  SubtaskEventMessage,
  completionEvents,
  failureEvents,
  initGitRepo,
  waitForAsync,
} from "./helpers/background-controller-fixtures";

const EXECUTION_TOOL_NAME_LIST = Object.values(EXECUTION_TOOL_NAMES);


type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

function toolExecute(tools: Array<Record<string, any>>, name: string): ExecuteTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool.execute as ExecuteTool;
}

/**
 * #117 harness (registered tools): the same git/executor fixtures as the
 * controller-level scenarios above, driven through the real registered
 * Subtasks* tools (ExecutionToolManager) so the folded aggregate is asserted
 * on the exact direct tool results the model receives.
 */
async function setupToolHarness(
  unique: string,
  options: { conflict?: boolean; executorLines: string[] | ((root: string) => string[]) },
): Promise<{
  root: string;
  manager: ExecutionToolManager;
  tools: Array<Record<string, any>>;
  messages: SubtaskEventMessage[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-background-dedupe-tools-${unique}-`));
  await initGitRepo(root, options.conflict ? { "base.txt": "base\n", "shared.txt": "base shared\n" } : { "base.txt": "base\n" });
  const executor = join(root, `tool-executor-${unique}.cjs`);
  const lines = typeof options.executorLines === "function" ? options.executorLines(root) : options.executorLines;
  await writeFile(executor, lines.join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      [`tools-${unique}`]: {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" }
      }
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: `tools-${unique}` }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  const tools: Array<Record<string, any>> = [];
  const messages: SubtaskEventMessage[] = [];
  const manager = new ExecutionToolManager({
    pi: {
      registerTool: (tool: Record<string, any>) => { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools: () => ["read", "bash", ...EXECUTION_TOOL_NAME_LIST],
      sendMessage: (message: SubtaskEventMessage) => messages.push(message),
    },
    config,
    state: createState(),
    cwd: () => root,
  });
  manager.sync();
  return {
    root,
    manager,
    tools,
    messages,
    cleanup: async () => {
      await manager.shutdown().catch(() => undefined);
      await manager.detach().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("#117 registered SubtasksInterrupt interrupt_with_merge returns the folded aggregate with no duplicate completion", async () => {
  const scenario = await setupToolHarness("tool-intmerge", {
    executorLines: [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','recover me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ],
  });
  try {
    const { tools, messages } = scenario;
    const start = toolExecute(tools, "SubtasksStart");
    const inspect = toolExecute(tools, "SubtasksInspect");
    const started = await start("tool-intmerge-start", {
      tasks: [{ title: "interrupt-with-merge target", instructions: "write draft.txt", acceptanceCriteria: ["draft.txt exists"] }],
    }, undefined, undefined, {});
    assert.equal(started.isError, false);
    const executionId = started.details.executionId;
    const taskId = started.details.tasks[0].taskId;

    await waitForAsync(async () => {
      const polled = await inspect("tool-intmerge-poll", { executionId, taskId }, undefined, undefined, {});
      const waveRoot = polled.details.tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return access(join(waveRoot, "workers", taskId, "draft.txt")).then(() => true, () => false);
    });

    const interrupt = toolExecute(tools, "SubtasksInterrupt");
    const merged = await interrupt("tool-intmerge-merge", {
      executionId,
      taskId,
      interruptMode: "interrupt_with_merge",
    }, undefined, undefined, {});
    assert.equal(merged.isError, false);
    const text = merged.content[0].text;
    // The direct tool result confirms the landing and carries the group
    // aggregate instead of a separate completion notification.
    assert.ok(text.includes("Group aggregate for this synchronous landing, folded into this result instead of a separate completion notification:"));
    assert.ok(text.includes(`Execution ${executionId} COMPLETE: 1/1 tasks landed.`));
    assert.ok(text.includes("All requested task outputs have landed; aggregate verification is now appropriate."));
    // The mechanical-landing caveat is preserved.
    assert.match(text, /inspect the main workspace manually/i);
    assert.ok(typeof merged.details.completionAggregate === "string" && merged.details.completionAggregate.length > 0, "the details carry the folded aggregate");
    assert.ok(text.includes(merged.details.completionAggregate), "the rendered result embeds the exact folded aggregate");
    assert.equal(completionEvents(messages).length, 0, "no duplicate completion notification follows the registered tool result");
  } finally {
    await scenario.cleanup();
  }
});

test("#117 registered SubtasksForceMerge result renders the folded group aggregate", async () => {
  const scenario = await setupToolHarness("tool-forcemerge", {
    executorLines: [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','recover me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ],
  });
  try {
    const { tools, messages } = scenario;
    const start = toolExecute(tools, "SubtasksStart");
    const inspect = toolExecute(tools, "SubtasksInspect");
    const started = await start("tool-force-start", {
      tasks: [{ title: "force-merge target", instructions: "write draft.txt", acceptanceCriteria: ["draft.txt exists"] }],
    }, undefined, undefined, {});
    assert.equal(started.isError, false);
    const executionId = started.details.executionId;
    const taskId = started.details.tasks[0].taskId;

    await waitForAsync(async () => {
      const polled = await inspect("tool-force-poll", { executionId, taskId }, undefined, undefined, {});
      const waveRoot = polled.details.tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return access(join(waveRoot, "workers", taskId, "draft.txt")).then(() => true, () => false);
    });

    // Stop the task first (interrupt_as_failure never lands, so no wake).
    const interrupt = toolExecute(tools, "SubtasksInterrupt");
    const stopped = await interrupt("tool-force-stop", {
      executionId,
      taskId,
      interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    assert.equal(stopped.isError, false);

    const forceMerge = toolExecute(tools, "SubtasksForceMerge");
    const landed = await forceMerge("tool-force-merge", { executionId, taskId }, undefined, undefined, {});
    assert.equal(landed.isError, false);
    const text = landed.content[0].text;
    assert.ok(text.includes("Group aggregate for this synchronous landing, folded into this result instead of a separate completion notification:"));
    assert.ok(text.includes(`Execution ${executionId} COMPLETE: 1/1 tasks landed.`));
    // The mechanical-landing caveat is preserved.
    assert.match(text, /Force-merge only reports a mechanical landing attempt/i);
    assert.ok(typeof landed.details.completionAggregate === "string" && landed.details.completionAggregate.length > 0, "the details carry the folded aggregate");
    assert.equal(completionEvents(messages).length, 0, "no duplicate completion notification follows the registered tool result");
  } finally {
    await scenario.cleanup();
  }
});

test("#117 registered SubtasksMarkClean result renders each landed task's folded aggregate", async () => {
  const scenario = await setupToolHarness("tool-markclean", {
    conflict: true,
    executorLines: (root) => [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      `if(prompt.includes('TOOL_MARKCLEAN_SENTINEL')){`,
      "fs.writeFileSync('marker.txt','landed\\n');",
      "fs.writeFileSync('shared.txt','candidate shared\\n');",
      `fs.writeFileSync(${JSON.stringify(join(root, "shared.txt"))},'current shared\\n');}`,
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "});",
    ],
  });
  try {
    const { tools, messages } = scenario;
    const start = toolExecute(tools, "SubtasksStart");
    const inspect = toolExecute(tools, "SubtasksInspect");
    const started = await start("tool-markclean-start", {
      tasks: [{ title: "conflict target", instructions: "TOOL_MARKCLEAN_SENTINEL", acceptanceCriteria: ["marker.txt exists"] }],
    }, undefined, undefined, {});
    assert.equal(started.isError, false);
    const executionId = started.details.executionId;
    const taskId = started.details.tasks[0].taskId;

    // Wait for the genuine conflicted landing and its (delivered) failure wake.
    await waitForAsync(async () => {
      const polled = await inspect("tool-markclean-poll", { executionId, taskId }, undefined, undefined, {});
      return polled.details.tasks[0]?.state === "conflicted" && failureEvents(messages).length === 1;
    });

    await writeFile(join(scenario.root, "shared.txt"), "resolved\n", "utf8");
    const markClean = toolExecute(tools, "SubtasksMarkClean");
    const cleared = await markClean("tool-markclean-run", {}, undefined, undefined, {});
    assert.equal(cleared.isError, false);
    const text = cleared.content[0].text;
    assert.ok(text.includes("Conflict gate cleared for 1 path(s); each landed task's group aggregate is included below instead of a separate completion notification."));
    assert.ok(text.includes(`Group aggregate for ${executionId} / ${taskId}:`));
    assert.ok(text.includes(`Execution ${executionId} COMPLETE: 1/1 tasks landed.`));
    assert.equal(failureEvents(messages).length, 1, "the conflicted failure wake is untouched");
    assert.equal(completionEvents(messages).length, 0, "no completion notification follows the model-confirmed validated landing");
  } finally {
    await scenario.cleanup();
  }
});
