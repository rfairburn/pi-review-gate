import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executorEntryId, normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";

// Focused behavior-preserving regressions for the shared explicit-Add worker
// enrollment rule (#249) and its insertion priority (#370): every case drives
// the real /review-settings menu entrypoint with controlled UI actions and
// asserts independent expected route arrays, resource ids, and reasoning
// selections.

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
  // order: enrollment must follow action order (most recent Add first, #370),
  // not sorted catalog order. Each resource appears once; the agent is not
  // research-capable.
  assert.deepEqual(saved.execution.workerResources, {
    "external-fake": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
    [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
  });
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: "external-fake" },
    { resourceId: lunaId, thinkingLevel: "high" },
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
    // Both Adds inserted at slot 1 (#370), so sol leads both routes; the
    // manual moves below land on the original final per-route expectations.
    rootSettingsRow("Execution priority", "gpt-5.6-sol → gpt-5.6-luna"),
    "1. gpt-5.6-sol [openai-codex] · High · shared max 1",
    "Move down",
    "Move up",
    "Back",
    "1. gpt-5.6-sol [openai-codex] · High · shared max 1",
    "Thinking  High",
    "Max",
    "Back",
    "Back",
    rootSettingsRow("Research priority", "gpt-5.6-sol → gpt-5.6-luna"),
    "2. gpt-5.6-luna [openai-codex] · High · shared max 1",
    "Move up",
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

test("successive explicit Adds insert at slot 1 in both routes while prior order and reasoning stay intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-slot1-"));
  const configPath = join(dir, "review-gate.json");
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  const solId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-sol" });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: {
        [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
        [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 2 },
      },
      // The two routes deliberately disagree about the seeded pair's order
      // and reasoning, so any reordering can only come from the Adds.
      routes: {
        execute: [{ resourceId: lunaId, thinkingLevel: "minimal" }, { resourceId: solId, thinkingLevel: "max" }],
        research: [{ resourceId: solId, thinkingLevel: "high" }, { resourceId: lunaId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
    { model: reasoningModel("openai-codex", "gpt-5.6-nova") },
    { model: reasoningModel("openai-codex", "gpt-5.6-drift") },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "2 models · 3 slots"),
    "Add worker resource",
    "gpt-5.6-nova [openai-codex]",
    "1  current",
    "Add worker resource",
    "gpt-5.6-drift [openai-codex]",
    "1  current",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  const novaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-nova" });
  const driftId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-drift" });
  assert.deepEqual(saved.execution.workerResources, {
    [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
    [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 2 },
    [novaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-nova" }, maxConcurrent: 1 },
    [driftId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-drift" }, maxConcurrent: 1 },
  });
  // [A,B]+C=>[C,A,B], then D=>[D,C,A,B] in each route: the later Add leads
  // with its model's default reasoning, and the seeded pair keeps its
  // per-route relative order and explicit levels.
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: driftId, thinkingLevel: "high" },
    { resourceId: novaId, thinkingLevel: "high" },
    { resourceId: lunaId, thinkingLevel: "minimal" },
    { resourceId: solId, thinkingLevel: "max" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: driftId, thinkingLevel: "high" },
    { resourceId: novaId, thinkingLevel: "high" },
    { resourceId: solId, thinkingLevel: "high" },
    { resourceId: lunaId },
  ]);
});

test("route-specific Add resource inserts the new entry at slot 1 for both roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-route-add-"));
  const configPath = join(dir, "review-gate.json");
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  const solId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-sol" });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: {
        [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
        [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 2 },
      },
      routes: {
        execute: [{ resourceId: lunaId, thinkingLevel: "minimal" }],
        research: [{ resourceId: solId, thinkingLevel: "max" }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Execution priority", "gpt-5.6-luna"),
    "Add resource",
    "gpt-5.6-sol [openai-codex]",
    "Back",
    rootSettingsRow("Research priority", "gpt-5.6-sol"),
    "Add resource",
    "gpt-5.6-luna [openai-codex]",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // Each route-specific Add prepends the newly listed resource with the
  // model's default reasoning; the preexisting entry retains its relative
  // order and reasoning, and the other route is untouched.
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: solId, thinkingLevel: "high" },
    { resourceId: lunaId, thinkingLevel: "minimal" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: lunaId, thinkingLevel: "high" },
    { resourceId: solId, thinkingLevel: "max" },
  ]);
});

test("changed-final-model reconciliation prepends a newly eligible route entry without duplicating or promoting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-reconcile-"));
  const configPath = join(dir, "review-gate.json");
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  const solId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-sol" });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: {
        [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
        [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 2 },
      },
      routes: {
        execute: [{ resourceId: lunaId, thinkingLevel: "minimal" }, { resourceId: solId, thinkingLevel: "max" }],
        research: [{ resourceId: lunaId, thinkingLevel: "minimal" }, { resourceId: solId, thinkingLevel: "max" }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
    { model: reasoningModel("openai-codex", "gpt-5.6-nova") },
    { model: reasoningModel("openai-codex", "gpt-5.6-drift") },
  ];

  // Add the research-incapable agent, then a Pi resource (so the agent's
  // Execute entry is no longer in slot 1), then switch the agent to a Pi
  // model before leaving the pool editor: the changed-final-model
  // reconciliation must enroll the now-research-capable resource in Research
  // at slot 1 while its existing Execute entry is neither duplicated nor
  // promoted ahead of the later Add.
  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "2 models · 3 slots"),
    "Add worker resource",
    "fake [run-as-binary]",
    "1  current",
    "Add worker resource",
    "gpt-5.6-nova [openai-codex]",
    "1  current",
    "1. fake [run-as-binary] · shared max 1",
    executorEntryRow("Model", "fake [run-as-binary]"),
    "gpt-5.6-drift [openai-codex]",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources["external-fake"], {
    selection: { source: "pi", model: "openai-codex/gpt-5.6-drift" },
    maxConcurrent: 1,
  });
  // One entry per role. Execute keeps the Add-time order (the later nova Add
  // leads, the reconciled agent stays behind it); Research prepends the
  // newly eligible agent; the seeded pair keeps its order and reasoning.
  const novaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-nova" });
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: novaId, thinkingLevel: "high" },
    { resourceId: "external-fake", thinkingLevel: "high" },
    { resourceId: lunaId, thinkingLevel: "minimal" },
    { resourceId: solId, thinkingLevel: "max" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: "external-fake", thinkingLevel: "high" },
    { resourceId: novaId, thinkingLevel: "high" },
    { resourceId: lunaId, thinkingLevel: "minimal" },
    { resourceId: solId, thinkingLevel: "max" },
  ]);
});

test("changing a preexisting resource's model never promotes its existing route entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-no-promote-"));
  const configPath = join(dir, "review-gate.json");
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  const solId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-sol" });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: {
        [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
        [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 2 },
      },
      // luna sits in slot 2 of both routes; a model change must re-pair its
      // reasoning in place, not promote it to slot 1.
      routes: {
        execute: [{ resourceId: solId, thinkingLevel: "max" }, { resourceId: lunaId, thinkingLevel: "minimal" }],
        research: [{ resourceId: solId, thinkingLevel: "max" }, { resourceId: lunaId, thinkingLevel: "minimal" }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
    { model: reasoningModel("openai-codex", "gpt-5.6-nova") },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "2 models · 3 slots"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "gpt-5.6-nova [openai-codex]",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // The stable identity survives the switch; both entries stay in slot 2 with
  // reasoning re-paired to the new model's default, and sol keeps slot 1.
  assert.deepEqual(saved.execution.workerResources[lunaId], {
    selection: { source: "pi", model: "openai-codex/gpt-5.6-nova" },
    maxConcurrent: 1,
  });
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: solId, thinkingLevel: "max" },
    { resourceId: lunaId, thinkingLevel: "high" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: solId, thinkingLevel: "max" },
    { resourceId: lunaId, thinkingLevel: "high" },
  ]);
});

test("a passive pool re-visit with an ordinary capacity edit keeps route membership and order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-worker-enroll-passive-order-"));
  const configPath = join(dir, "review-gate.json");
  const lunaId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-luna" });
  const solId = executorEntryId({ source: "pi", model: "openai-codex/gpt-5.6-sol" });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: {
        [lunaId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 1 },
        [solId]: { selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 2 },
      },
      // luna is deliberately absent from Research; the capacity edit must
      // neither enroll it nor touch either route's order or reasoning.
      routes: {
        execute: [{ resourceId: lunaId, thinkingLevel: "minimal" }, { resourceId: solId, thinkingLevel: "max" }],
        research: [{ resourceId: solId, thinkingLevel: "max" }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "2 models · 3 slots"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Maximum concurrency", "1"),
    "2",
    "Back",
    "Back",
    rootSettingsRow("Global concurrency", "4"),
    "2",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.execution.workerResources[lunaId].maxConcurrent, 2);
  // Membership and order are exactly as seeded: no auto-enrollment of luna
  // into Research and no reordering from the visit or the capacity edit.
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: lunaId, thinkingLevel: "minimal" },
    { resourceId: solId, thinkingLevel: "max" },
  ]);
  assert.deepEqual(saved.execution.routes.research, [
    { resourceId: solId, thinkingLevel: "max" },
  ]);
  assert.equal(saved.execution.maxWorkers, 2);
});

const ROOT_SETTING_LABELS = [
  "Operating mode",
  "Mode cycle hotkey",
  "Worker resources",
  "External workers",
  "Execution priority",
  "Research priority",
  "Reviewers",
  "Timeouts",
  "Review policy",
  "Bundle retention",
  "Global concurrency",
  "Retry policy",
  "Subtask notifications",
  "Tools",
  "Subtasks view",
  "Scheduled tasks",
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
