import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import type { OperatingMode } from "../src/config";
import { DeferredToolManager } from "../src/deferred-tools";
import { ExecutionToolManager } from "../src/execution/tool";
import {
  defaultExecutorInitialActiveTools,
  type ExecutorToolCatalog,
} from "../src/execution/tool-catalog";
import { EVIDENCE_COMMAND_TOOL_NAMES } from "../src/execution/evidence/types";
import { PiJsonlActivityExtractor } from "../src/execution/progress";
import { extractCandidatePaths, shouldRecordToolCallEvidence } from "../src/evidence";
import { createState } from "../src/state";

/**
 * Native shell-tool parity (#94): wherever Bash is permitted, Pi's optional
 * native `powershell` tool (Windows; docs/windows.md) is recognized and
 * permitted under the same role rules when the host actually exposes and
 * authorizes it. Bash-only hosts stay byte-compatible, explicit
 * authorization ceilings hold, and the research role gains neither shell.
 */

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

function executionTool(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

interface DispatchHarness {
  tools: Array<Record<string, any>>;
  manager: ExecutionToolManager;
}

function dispatchHarness(activeTools: string[]): DispatchHarness {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools: () => [...activeTools],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      // The research-capable codex adapter routes research groups through the
      // read-only research intersection, mirroring real role rules.
      adapter: "codex-cli",
      command: process.execPath,
      execution: {},
    }],
    execution: {
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "fake" }, maxConcurrent: 4 }],
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
    notify: () => {},
  });
  manager.sync();
  return { tools, manager };
}

async function durableCatalog(
  harness_: DispatchHarness,
  params: Record<string, unknown>,
): Promise<{ catalog: ExecutorToolCatalog; shutdown: () => Promise<void> }> {
  const start = executionTool(harness_.tools, "SubtasksStart").execute as ExecuteTool;
  const started = await start("shell-parity", params, undefined, undefined, {});
  return {
    catalog: started.details.tasks[0].definition.executorToolCatalog as ExecutorToolCatalog,
    shutdown: () => harness_.manager.shutdown(),
  };
}

test("deferred default initial sets cover powershell-only, bash-only, and both-tools hosts", () => {
  const base = ["read", "edit", "write", "ApplyPatch", "SubtasksStart"];
  // Powershell-only Windows host exposing powershell instead of bash.
  assert.deepEqual(
    defaultExecutorInitialActiveTools([...base, "powershell", "grep", "find", "ls"]),
    ["read", "grep", "find", "ls", "powershell", "edit", "write", "ApplyPatch", "SubtasksStart"],
  );
  // Bash-only macOS/Linux host: unchanged behavior, no synthesized powershell.
  assert.deepEqual(
    defaultExecutorInitialActiveTools([...base, "bash", "grep"]),
    ["read", "grep", "bash", "edit", "write", "ApplyPatch", "SubtasksStart"],
  );
  // Both tools: each host-authorized shell stays part of the startup subset.
  assert.deepEqual(
    defaultExecutorInitialActiveTools([...base, "bash", "powershell"]),
    ["read", "bash", "powershell", "edit", "write", "ApplyPatch", "SubtasksStart"],
  );
  // Neither name is ever granted without host authorization.
  assert.deepEqual(defaultExecutorInitialActiveTools(base), base);
});

test("execution worker catalogs keep host-authorized shells under the parent ceiling", async () => {
  const base = ["read", "edit", "write", ...executionToolNames];
  const both = await durableCatalog(await dispatchHarness([...base, "bash", "powershell"]), {
    tasks: [{ title: "Both", instructions: "Do it", acceptanceCriteria: ["done"] }],
  });
  assert.ok(both.catalog.allowedToolCatalog.includes("bash"));
  assert.ok(both.catalog.allowedToolCatalog.includes("powershell"));
  assert.ok(both.catalog.initialActiveTools.includes("bash"));
  assert.ok(both.catalog.initialActiveTools.includes("powershell"));
  await both.shutdown();

  const powershellOnly = await durableCatalog(await dispatchHarness([...base, "powershell"]), {
    tasks: [{ title: "Powershell only", instructions: "Do it", acceptanceCriteria: ["done"] }],
  });
  assert.ok(powershellOnly.catalog.allowedToolCatalog.includes("powershell"));
  assert.ok(powershellOnly.catalog.initialActiveTools.includes("powershell"));
  assert.equal(powershellOnly.catalog.allowedToolCatalog.includes("bash"), false);
  await powershellOnly.shutdown();

  const bashOnly = await durableCatalog(await dispatchHarness([...base, "bash"]), {
    tasks: [{ title: "Bash only", instructions: "Do it", acceptanceCriteria: ["done"] }],
  });
  assert.ok(bashOnly.catalog.allowedToolCatalog.includes("bash"));
  assert.equal(bashOnly.catalog.allowedToolCatalog.includes("powershell"), false);
  assert.equal(bashOnly.catalog.initialActiveTools.includes("powershell"), false);
  await bashOnly.shutdown();
});

test("research role never gains bash or powershell even when the host exposes both", async () => {
  const base = ["read", "grep", "find", "ls", "edit", "write", "WebSearch", "WebFetch", "BrowserExtract", ...executionToolNames];
  const research = await durableCatalog(await dispatchHarness([...base, "bash", "powershell"]), {
    kind: "research",
    tasks: [{
      title: "Read-only research",
      instructions: "Investigate read-only",
      acceptanceCriteria: ["Report only"],
    }],
  });
  assert.equal(research.catalog.allowedToolCatalog.includes("bash"), false);
  assert.equal(research.catalog.allowedToolCatalog.includes("powershell"), false);
  assert.equal(research.catalog.initialActiveTools.includes("bash"), false);
  assert.equal(research.catalog.initialActiveTools.includes("powershell"), false);
  await research.shutdown();
});

interface RegisteredTool {
  name: string;
  description: string;
}

function deferredFixture(activeNames: string[], allNames: RegisteredTool[] = activeNames.map((name) => ({ name, description: `${name} tool.` }))) {
  const active = [...activeNames];
  const setCalls: string[][] = [];
  const sessionIdentity = {};
  const pi = {
    registerTool(definition: RegisteredTool) {
      if (!allNames.some((candidate) => candidate.name === definition.name)) allNames.push(definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...allNames],
    setActiveTools(names: string[]) {
      active.splice(0, active.length, ...names);
      setCalls.push([...names]);
    },
  };
  return { pi, sessionIdentity, setCalls, active: () => [...active], allNames };
}

test("top-level deferred capture treats powershell like bash when the host exposes it", () => {
  // Both tools exposed: both stay launch-active and authorized.
  const both = deferredFixture(["read", "bash", "powershell", "edit"]);
  const bothManager = new DeferredToolManager(both.pi);
  assert.equal(bothManager.register(), true);
  assert.equal(bothManager.sessionStart(both.sessionIdentity), true);
  assert.ok(both.active().includes("bash"));
  assert.ok(both.active().includes("powershell"));
  assert.ok(bothManager.authorizedToolNames()?.includes("powershell"));

  // Powershell-only Windows host: powershell replaces bash everywhere.
  const only = deferredFixture(["read", "powershell", "edit"]);
  const onlyManager = new DeferredToolManager(only.pi);
  onlyManager.register();
  onlyManager.sessionStart(only.sessionIdentity);
  assert.ok(only.active().includes("powershell"));
  assert.equal(only.active().includes("bash"), false);
  assert.ok(onlyManager.authorizedToolNames()?.includes("powershell"));

  // Bash-only host: unchanged behavior, no synthesized powershell.
  const bashOnly = deferredFixture(["read", "bash", "edit"]);
  const bashOnlyManager = new DeferredToolManager(bashOnly.pi);
  bashOnlyManager.register();
  bashOnlyManager.sessionStart(bashOnly.sessionIdentity);
  assert.ok(bashOnly.active().includes("bash"));
  assert.equal(bashOnly.active().includes("powershell"), false);
  assert.equal(bashOnlyManager.authorizedToolNames()?.includes("powershell"), false);
});

test("an explicit Bash-only worker allowlist never activates registered-but-unauthorized powershell", async () => {
  // The host registers powershell (as a Windows host would) but the parent
  // launched with an explicit Bash-only allowlist, leaving powershell
  // launch-inactive and outside the durable ceiling.
  const fixture = deferredFixture(["read", "bash"], [
    { name: "read", description: "read tool." },
    { name: "bash", description: "bash tool." },
    { name: "powershell", description: "powershell tool." },
  ]);
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  const result = manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read", "bash"],
  }, true);
  assert.equal(result, true);
  assert.deepEqual(fixture.active(), ["read", "bash", "search_tools"]);
  assert.ok(manager.authorizedToolNames()?.includes("bash"));
  assert.equal(manager.authorizedToolNames()?.includes("powershell"), false);
  const search = fixture.allNames.find((candidate) => candidate.name === "search_tools") as
    | { execute?: (id: string, params: unknown) => Promise<Record<string, any>> }
    | undefined;
  assert.ok(search?.execute);
  const powershellSearch = await search.execute("shell-search", { query: "powershell" });
  assert.match(JSON.stringify(powershellSearch), /No authorized tools matched/);
  assert.equal(fixture.active().includes("powershell"), false);
});

test("configured worker catalogs fail closed when the host does not provide powershell", () => {
  const fixture = deferredFixture(["read", "bash"]);
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(
    manager.sessionStart(fixture.sessionIdentity, {
      allowedToolCatalog: ["read", "powershell"],
      initialActiveTools: ["read", "powershell"],
    }, true),
    false,
    "an unavailable tool must fail closed instead of being synthesized",
  );
  assert.equal(fixture.active().includes("powershell"), false);
});

test("plan-research mode hides both shells from visibility, inventory, and discovery", async () => {
  const fixture = deferredFixture(["read", "bash", "powershell", "edit", "WebSearch"]);
  let mode: OperatingMode = "orchestrate";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  mode = "plan-research";
  manager.reapply();
  assert.ok(!fixture.active().includes("bash"));
  assert.ok(!fixture.active().includes("powershell"));
  const inventory = manager.startupGuidance() ?? "";
  assert.doesNotMatch(inventory, /"(?:bash|powershell)"/);
  const search = fixture.allNames.find((candidate) => candidate.name === "search_tools") as
    | { execute?: (id: string, params: unknown) => Promise<Record<string, any>> }
    | undefined;
  assert.ok(search?.execute);
  for (const name of ["bash", "powershell"]) {
    const result = await search.execute("shell-hidden", { query: name });
    assert.match(JSON.stringify(result), /No authorized tools matched/);
  }
  assert.equal(fixture.active().includes("bash"), false);
  assert.equal(fixture.active().includes("powershell"), false);
});

test("powershell command evidence receives the same extraction as bash", () => {
  const command = "Get-Content notes.txt | tee logs/out.txt\nSelect-String x > generated/report.txt";
  const powershellResult = extractCandidatePaths("powershell", { command });
  const bashResult = extractCandidatePaths("bash", { command });
  // Identical extraction treatment (the recorded source label is the tool name).
  assert.deepEqual(powershellResult.paths.map((item) => ({ path: item.path, source: item.source.split(":")[1] })),
    bashResult.paths.map((item) => ({ path: item.path, source: item.source.split(":")[1] })));
  assert.deepEqual(powershellResult.riskSignals, bashResult.riskSignals);
  assert.deepEqual(powershellResult.paths.map((item) => item.path), ["generated/report.txt", "logs/out.txt"]);
  assert.ok(powershellResult.riskSignals.includes("shell_redirection"));
  assert.ok(powershellResult.riskSignals.includes("tee_write"));
  assert.deepEqual(extractCandidatePaths("powershell", { command: "Remove-Item /tmp/a" }).paths, []);
  assert.equal(shouldRecordToolCallEvidence("powershell"), true);
  assert.equal(EVIDENCE_COMMAND_TOOL_NAMES.has("powershell"), true);
});

test("powershell tool activity renders the command like bash", () => {
  const messages: string[] = [];
  const extractor = new PiJsonlActivityExtractor((message) => messages.push(message));
  extractor.push([
    JSON.stringify({ type: "tool_execution_start", toolName: "powershell", args: { command: "Get-ChildItem src" } }),
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "powershell",
      result: { content: [{ type: "text", text: "3 files\nupdated manifest" }] },
      isError: false,
    }),
  ].join("\n") + "\n");
  extractor.finish();
  assert.deepEqual(messages, [
    "powershell · Get-ChildItem src",
    "powershell completed · updated manifest",
  ]);
});