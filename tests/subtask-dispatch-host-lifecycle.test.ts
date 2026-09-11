// Real-host lifecycle coverage for #93 original SubtasksStart/SubtasksAdd cards.
//
// Mounts the installed Pi host's REAL ToolExecutionComponent with the ACTUAL
// registered SubtasksStart entry point and a real controller/executor
// transport, then proves that an already-mounted queued row re-renders to the
// captured dispatch provenance when the actual dispatch event fires — through
// the native `context.invalidate()` route only. After the initial mount no
// test code calls renderResult, updateResult, or setExpanded: the row's
// content changes because the host component invalidated itself in response
// to the dispatch event and re-ran the registered renderer with a freshly
// projected live view. No polling, no fetching, no expansion toggle.
//
// The installed host is discovered from standard global package roots (or an
// explicit PI_CODING_AGENT_DIR override pointing at a node_modules root that
// contains @earendil-works/pi-coding-agent). When no installation is found the
// file skips with a reason instead of fabricating coverage.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import { resetDispatchCardsForTests } from "../src/execution/dispatch-cards";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// ── Installed-host discovery (read-only; mirrors tool-result-hints-host) ───

interface HostBundle {
  agent: {
    initTheme(themeName: string, enableWatcher?: boolean): void;
    keyHint(keybinding: string, description: string): string;
    keyText(keybinding: string): string;
    ToolExecutionComponent: new (
      toolName: string,
      toolCallId: string,
      args: unknown,
      options: Record<string, unknown>,
      toolDefinition: Record<string, unknown>,
      ui: { requestRender(): void },
      cwd: string,
    ) => {
      expanded: boolean;
      rendererState: Record<string, unknown>;
      updateResult(result: unknown, isPartial?: boolean): void;
      setExpanded(expanded: boolean): void;
      invalidate(): void;
      render(width: number): string[];
    };
  };
  tui: {
    KeybindingsManager: new (definitions: Record<string, unknown>) => {
      setUserBindings(bindings: Record<string, string | string[]>): void;
    };
    setKeybindings(manager: unknown): void;
  };
  coreKeybindings: { KEYBINDINGS: Record<string, unknown> };
}

function discoverInstalledHost(): HostBundle | undefined {
  const candidates = [
    process.env.PI_CODING_AGENT_DIR,
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
  ].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  for (const root of candidates) {
    const agentDir = path.join(root, "@earendil-works", "pi-coding-agent");
    if (!fs.existsSync(path.join(agentDir, "package.json"))) continue;
    // Anchor inside the agent package so both the agent and its own nested
    // pi-tui resolve to the installed host's copies (same module instances).
    const req = createRequire(path.join(agentDir, "node_modules", "__pi_host_anchor__.js"));
    try {
      const agent = req(path.join(agentDir, "dist", "index.js")) as HostBundle["agent"] & Record<string, unknown>;
      const tui = req("@earendil-works/pi-tui") as HostBundle["tui"];
      if (typeof agent?.initTheme !== "function" || typeof agent.ToolExecutionComponent !== "function") continue;
      const coreKeybindings = req(path.join(agentDir, "dist", "core", "keybindings.js")) as HostBundle["coreKeybindings"];
      return { agent: agent as HostBundle["agent"], tui, coreKeybindings };
    } catch {
      // Unreadable installation: try the next candidate.
    }
  }
  return undefined;
}

const host = discoverInstalledHost();
const SKIP_REASON =
  "installed Pi host not found (set PI_CODING_AGENT_DIR to a node_modules root containing @earendil-works/pi-coding-agent)";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Real transport harness (same shape as subtask-dispatch-lifecycle) ──────

const execFileAsync = promisify(execFile);

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

async function mkRepo(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "base.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

async function writeRecordingExecutor(root: string, options: { stdinCapture: string; delayMs?: number }): Promise<void> {
  const executor = path.join(root, "dispatch-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');",
    `const capture=${JSON.stringify(options.stdinCapture)};`,
    "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    `  const delay=${options.delayMs ?? 0};`,
    "  fs.writeFileSync(capture,prompt);",
    "  const finish=()=>{",
    "    try{fs.writeFileSync('worker-output.txt','worker done\\n');}catch(e){}",
    "    console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "    console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "  };",
    "  if(delay>0){setTimeout(finish,delay);}else{finish();}",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
}

function controllerConfig(root: string, executorPath: string, maxConcurrent = 1): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: executorPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const },
    }],
    execution: {
      maxWorkers: maxConcurrent,
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "fake" }, maxConcurrent }],
    },
  });
}

type ManagerInternals = { controller: BackgroundExecutionController };

function controllerOf(manager: ExecutionToolManager): BackgroundExecutionController {
  const controller = (manager as unknown as ManagerInternals).controller;
  assert.ok(controller, "ExecutionToolManager did not expose its controller");
  return controller;
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000, label = "host lifecycle condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function toolOf(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

if (!host) {
  test("real-host original-card lifecycle coverage", { skip: SKIP_REASON }, () => {});
} else {
  const h = host; // narrowed for the closures below

  test("real host row: a mounted queued Start card re-renders to captured dispatch on the actual event", async () => {
    resetDispatchCardsForTests();
    h.agent.initTheme("dark", false); // built-in theme JSON, no watcher
    const managerBindings = new h.tui.KeybindingsManager(h.coreKeybindings.KEYBINDINGS);
    h.tui.setKeybindings(managerBindings);
    const root = await mkRepo("pi-review-dispatch-host-");
    let manager: ExecutionToolManager | undefined;
    try {
      const stdinCapture = path.join(root, "executor-stdin.json");
      await writeRecordingExecutor(root, { stdinCapture, delayMs: 250 });
      const tools: Array<Record<string, any>> = [];
      const pi: Record<string, any> = {
        registerTool(tool: Record<string, any>) { tools.push(tool); },
        registerCommand() {},
        setToolActive() {},
        getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksAdd"]; },
      };
      const config = controllerConfig(root, path.join(root, "dispatch-executor.cjs"), 1);
      manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
      manager.sync();
      const controller = controllerOf(manager);
      const start = toolOf(tools, "SubtasksStart");

      const params = {
        // The first task occupies the sole executor slot. The second is
        // genuinely queued when this call returns, rather than assuming the
        // first task cannot already have entered capture before mounting.
        tasks: [
          { title: "Slot predecessor", instructions: "Complete the predecessor task.", acceptanceCriteria: ["completed"] },
          { title: "Host lifecycle task", instructions: "HOST_LIFECYCLE_SENTINEL prompt body.", acceptanceCriteria: ["dispatched"] },
        ],
      };
      const started = await (start.execute as ExecuteTool)("host-lifecycle-call", params, undefined, undefined, {});
      assert.equal(started.isError, false);
      const executionId = started.details.executionId as string;
      const taskId = started.details.tasks[1].taskId as string;
      assert.equal(controller.liveDispatchView(executionId)?.tasks.find((task) => task.taskId === taskId)?.state, "queued");

      // Mount the REAL host component with the ACTUAL registered tool
      // definition — exactly what interactive mode does for a tool row.
      let renderRequests = 0;
      const ui = { requestRender: () => { renderRequests += 1; } };
      const comp = new h.agent.ToolExecutionComponent(
        "SubtasksStart",
        "host-lifecycle-call",
        params,
        {},
        start,
        ui,
        root,
      );
      // Deliver the real returned result once. This initial display renders
      // the queued card and registers the row's dispatch subscription through
      // the native per-row renderer context (state + invalidate).
      comp.updateResult(started, false);

      const before = comp.render(200).map(stripAnsi);
      assert.ok(before.some((line) => line.includes(taskId)), "the mounted row shows its task");
      const queuedTaskRow = before.findIndex((line) => line.includes(taskId));
      assert.ok(before[queuedTaskRow + 1]?.includes("dispatch: not yet sent"), "the mounted target task is honestly queued");
      assert.equal(comp.expanded, false);
      // The subscription lives on the component's own per-row renderer state.
      assert.equal(comp.rendererState.__piReviewGateDispatchWatchExecutionId, executionId);

      // Wait for the ACTUAL dispatch at the transport boundary. The dispatch
      // event invalidates this mounted row through the native context route —
      // nothing below calls renderResult, updateResult, or setExpanded again.
      await waitFor(
        () => Boolean(controller.liveDispatchView(executionId)?.tasks.find((candidate) => candidate.taskId === taskId)?.dispatch),
        30_000,
        "actual dispatch record",
      );
      await waitFor(() => renderRequests > 0, 5_000, "host frame re-render requested by the invalidated row");

      const after = comp.render(200).map(stripAnsi);
      assert.ok(
        after[after.findIndex((line) => line.includes(taskId)) + 1]?.includes("dispatch: prompt delivered to transport"),
        "the mounted row now shows the captured dispatch provenance with no manual re-render call",
      );
      assert.equal(comp.expanded, false, "the row stayed collapsed; no expansion toggle was involved");
      // The expanded arm of the SAME mounted row carries the full actual
      // prompt — toggling it is pure presentation on the refreshed projection.
      comp.setExpanded(true);
      const expanded = comp.render(200).map(stripAnsi);
      assert.ok(expanded.some((line) => line.includes("Prompt provenance: captured at dispatch")));
      assert.ok(expanded.some((line) => line.includes("HOST_LIFECYCLE_SENTINEL prompt body.")));
    } finally {
      if (manager) {
        await manager.shutdown();
        await manager.detach();
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
