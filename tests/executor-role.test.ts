import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];
const backgroundShellToolNames = ["ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"];
const webToolNames = ["WebSearch", "WebFetch", "BrowserExtract"];

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRole: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
});

interface ActivationCapture {
  hooks: Map<string, unknown[]>;
  tools: Set<string>;
  commands: string[];
  notices: string[];
}

function captureHost(): { pi: Record<string, unknown>; captured: ActivationCapture } {
  const captured: ActivationCapture = {
    hooks: new Map(),
    tools: new Set(),
    commands: [],
    notices: [],
  };
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      captured.hooks.set(name, [...(captured.hooks.get(name) ?? []), handler]);
    },
    registerTool(tool: { name: string }) {
      captured.tools.add(tool.name);
    },
    registerCommand(name: string) {
      captured.commands.push(name);
    },
    notify(message: string) {
      captured.notices.push(message);
    },
  };
  return { pi, captured };
}

async function writeConfig(dir: string): Promise<string> {
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ enabled: true }), "utf8");
  return configPath;
}

test("executor role registers web tools and background shell without orchestration or review machinery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-executor-role-"));
  try {
    process.env.PI_REVIEW_GATE_CONFIG = await writeConfig(dir);
    delete process.env.PI_REVIEW_GATE_DISABLED;
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";

    const { pi, captured } = captureHost();
    await activate(pi);

    for (const tool of webToolNames) {
      assert.ok(captured.tools.has(tool), `expected executor child to register ${tool}`);
    }
    for (const tool of backgroundShellToolNames) {
      assert.ok(captured.tools.has(tool), `expected executor child to register ${tool}`);
    }
    for (const tool of executionToolNames) {
      assert.equal(captured.tools.has(tool), false, `executor child must not register ${tool}`);
    }
    // Only the background shell's own lifecycle hooks may be present (its
    // session hooks plus agent_start/agent_settled, which gate nonurgent wake
    // coalescing); the review machinery (agent_end, before_agent_start,
    // input, tool_call, tool_result) and command surface must stay out of
    // executor children.
    assert.deepEqual([...captured.hooks.keys()].sort(), [
      "agent_settled",
      "agent_start",
      "session_shutdown",
      "session_start",
    ]);
    assert.deepEqual(captured.commands, [], "executor child must not register review commands");
    assert.ok(!captured.notices.some((notice) => notice.includes("disabled")), "executor child must not report the gate disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PI_REVIEW_GATE_DISABLED still short-circuits activation before executor-role registration", async () => {
  // Documents the kill-switch behavior that previously broke Pi executor
  // children: when the disablement reaches the child, activate() returns
  // before the executor-role branch and no web tools are registered.
  const dir = await mkdtemp(join(tmpdir(), "pi-review-executor-disabled-"));
  try {
    process.env.PI_REVIEW_GATE_CONFIG = await writeConfig(dir);
    process.env.PI_REVIEW_GATE_DISABLED = "1";
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";

    const { pi, captured } = captureHost();
    await activate(pi);

    assert.equal(captured.tools.size, 0, "disabled activation must not register any tools");
    assert.deepEqual([...captured.hooks.keys()], []);
    assert.match(captured.notices.join("\n"), /review gate: disabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
