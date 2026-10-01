import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executorEntryId, normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";

// Focused behavior-preserving regressions for the shared explicit-Add worker
// enrollment rule (#249): every case drives the real /review-settings menu
// entrypoint with controlled UI actions and asserts independent expected
// route arrays, resource ids, and reasoning selections.

test("explicit Adds enroll each supported role in action order with one entry per resource", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-order-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {},
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [{ model: reasoningModel("openai-codex", "gpt-5.6-luna") }];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "gpt-5.6-luna [openai-codex]",
    "1  current",
    "Add worker resource",
    "fake [run-as-binary]",
    "1  current",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  // Add the Pi model before the agent, opposite their alphabetical display
  // order: enrollment must follow action order, not sorted catalog order.
  // Each resource appears once; the agent is not research-capable.
  assert.deepEqual(saved.execution.workerResources, {
    "external-fake": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
    [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
  });
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: lunaId, thinkingLevel: "high" },
    { resourceId: "external-fake" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: lunaId, thinkingLevel: "high" },
  ]);
});

test("a session-added Pi model switched to a research-incapable agent loses its research enrollment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-switch-out-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {},
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [{ model: reasoningModel("openai-codex", "gpt-5.6-luna") }];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "gpt-5.6-luna [openai-codex]",
    "1  current",
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "fake [run-as-binary]",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // The stable Add-time identity survives the switch; enrollment follows the
  // final selection: execute keeps the resource (external agents own their
  // reasoning), and the research-incapable switch removes the incompatible
  // entry through the existing reconciliation.
  const stableId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  assert.deepEqual(saved.execution.workerResources, {
    [stableId]: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
  });
  assert.deepEqual(saved.execution.routes.execute, [{ resourceId: stableId }]);
  assert.deepEqual(saved.execution.routes.research, []);
});

test("independent per-route reasoning and route order survive a later pool re-visit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-routes-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {},
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "gpt-5.6-luna [openai-codex]",
    "1  current",
    "Add worker resource",
    "gpt-5.6-sol [openai-codex]",
    "1  current",
    "Back",
    rootSettingsRow("Execution priority", "gpt-5.6-luna → gpt-5.6-sol"),
    "1. gpt-5.6-luna [openai-codex] · High · shared max 1",
    "Move down",
    "Back",
    "1. gpt-5.6-sol [openai-codex] · High · shared max 1",
    "Thinking  High",
    "Max",
    "Back",
    "Back",
    rootSettingsRow("Research priority", "gpt-5.6-luna → gpt-5.6-sol"),
    "1. gpt-5.6-luna [openai-codex] · High · shared max 1",
    "Thinking  High",
    "Minimal",
    "Back",
    "Back",
    rootSettingsRow("Worker resources", "2 models · 2 slots"),
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  const solId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-sol" });
  assert.deepEqual(saved.execution.workerResources, {
    [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
    [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 1 },
  });
  // The explicit Execute order/reasoning and the independent Research
  // order/reasoning both survive the later pool re-visit without a model
  // change.
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: solId, thinkingLevel: "max" },
    { resourceId: lunaId, thinkingLevel: "high" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: lunaId, thinkingLevel: "minimal" },
    { resourceId: solId, thinkingLevel: "high" },
  ]);
});

test("a passive save with a populated catalog and missing routes keeps both routes empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-passive-"));
  const configPath = join(dir, "review-gate.json");
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: { [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 2 } },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [{ model: reasoningModel("openai-codex", "gpt-5.6-luna") }];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Global concurrency", "4"),
    "2",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // Loading and saving never infer role priorities from the catalog: missing
  // routes persist as empty, and a defined-but-unactivated external agent
  // stays out of the pool.
  assert.deepEqual(saved.execution.workerResources, {
    [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 2 },
  });
  assert.deepEqual(saved.execution.routes, { execute: [], research: [] });
  assert.equal("external-fake" in saved.execution.workerResources, false);
  assert.deepEqual(Object.keys(saved.externalAgents), ["fake"]);
  assert.equal(saved.execution.maxWorkers, 2);
});

test("cancel discards staged worker Adds without touching the file or in-memory config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-cancel-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {},
  }), "utf8");
  const original = await readFile(configPath, "utf8");
  const config = normalizeConfig(JSON.parse(original));
  const before = JSON.parse(JSON.stringify(config));
  const registered = commandHarness();
  const savedCalls: unknown[] = [];
  registerReviewSettings({ pi: registered.pi, config, configPath, onSaved: (next) => { savedCalls.push(next); } });
  const scoped = [{ model: reasoningModel("openai-codex", "gpt-5.6-luna") }];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "gpt-5.6-luna [openai-codex]",
    "1  current",
    "Back",
    "Cancel",
  ], scoped));

  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), before);
  assert.deepEqual(savedCalls, []);
});

const ROOT_SETTING_LABELS = [
  "Operating mode",
  "Mode cycle hotkey",
  "Worker resources",
  "Execution priority",
  "Research priority",
  "Reviewers",
  "Timeouts",
  "Review policy",
  "Bundle retention",
  "Global concurrency",
  "Retry policy",
  "Subtask notifications",
  "Deferred Pi tools",
  "Subtasks view",
  "Scheduled tasks",
  "Web",
] as const;

function rootSettingsRow(label: typeof ROOT_SETTING_LABELS[number], value: string): string {
  return alignedTestRow(label, value, ROOT_SETTING_LABELS);
}

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function executorEntryRow(label: string, value: string): string {
  const width = Math.max("Model".length, "Maximum concurrency".length);
  return `${label.padEnd(width)}  ${value}`;
}

function reasoningModel(provider: string, id: string): Record<string, unknown> {
  return {
    provider,
    id,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
}

function commandHarness(): {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void };
  handler: (args: string, ctx: unknown) => Promise<void>;
} {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  return {
    pi: {
      registerCommand(name, options) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    handler: async (args, ctx) => {
      assert.ok(handler);
      await handler(args, ctx);
    },
  };
}

function contextWithSelections(
  values: Array<string | undefined>,
  scopedModels: unknown[] = [],
): unknown {
  let index = 0;
  return {
    scopedModels,
    ui: {
      async select(_title: string, options: string[]) {
        const value = values[index++];
        if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
        return value;
      },
      async input() {
        return undefined;
      },
      async confirm(_title: string, _message: string) {
        return false;
      },
      notify() {},
    },
  };
}
