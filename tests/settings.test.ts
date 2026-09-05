import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { scopedModelChoices } from "../src/settings/models";

test("/review-settings stages executor and reviewer changes and saves them together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    customFutureKey: { keep: true },
    enabledReviewerIds: ["one"],
    reviewers: [
      { id: "one", adapter: "generic-cli", command: process.execPath },
      { id: "two", adapter: "generic-cli", command: process.execPath },
    ],
    execution: {
      activeExecutor: null,
      externalExecutors: [{
        id: "fake",
        adapter: "run-as-binary",
        protocol: "pi-review-executor-jsonl-v1",
        command: process.execPath,
      }],
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const selections = [
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "fake [run-as-binary]",
    "1  current",
    "Back",
    rootSettingsRow("Reviewers", "1/2 selected"),
    "two [generic-cli] ✗",
    "Back",
    rootSettingsRow("Global concurrency", "4"),
    "2",
    "Save changes",
  ];

  await registered.handler("", contextWithSelections(selections));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [{
    resourceId: "external-fake",
    selection: { source: "external", id: "fake" },
    maxConcurrent: 1,
  }]);
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId: "external-fake" }],
    research: [],
  });
  assert.equal(saved.execution.activeExecutor, undefined);
  assert.equal(saved.execution.maxWorkers, 2);
  assert.deepEqual(saved.review.activeReviewers, [
    { source: "external", id: "one" },
    { source: "external", id: "two" },
  ]);
  assert.deepEqual(saved.externalAgents.map((agent: { id: string }) => agent.id), ["fake", "one", "two"]);
  assert.equal(saved.reviewers, undefined);
  assert.equal(saved.enabledReviewerIds, undefined);
  assert.deepEqual(saved.customFutureKey, { keep: true });
  assert.deepEqual(config.execution?.workerResources, [{
    resourceId: "external-fake",
    selection: { source: "external", id: "fake" },
    maxConcurrent: 1,
  }]);
});

test("/review-settings builds and reorders an executor pool with per-model concurrency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-pool-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: ["qwen", "deepseek"].map((id) => ({
      id,
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    })),
    execution: { executorPool: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "qwen [run-as-binary]",
    "1  current",
    "Add worker resource",
    "deepseek [run-as-binary]",
    "3",
    "2. deepseek [run-as-binary] · shared max 3",
    "Move up",
    "Back",
    "Back",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [
    { resourceId: "external-deepseek", selection: { source: "external", id: "deepseek" }, maxConcurrent: 3 },
    { resourceId: "external-qwen", selection: { source: "external", id: "qwen" }, maxConcurrent: 1 },
  ]);
  assert.equal(saved.execution.activeExecutor, undefined);
});

test("/review-settings independently excludes a shared worker resource from research", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-routes-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: ["qwen", "deepseek"].map((id) => ({
      id,
      adapter: "codex-cli",
      command: process.execPath,
      execution: {},
    })),
    execution: {
      executorPool: [
        { entryId: "qwen", selection: { source: "external", id: "qwen" }, maxConcurrent: 1 },
        { entryId: "deepseek", selection: { source: "external", id: "deepseek" }, maxConcurrent: 2 },
      ],
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Research priority", "qwen → deepseek"),
    "2. deepseek [codex-cli] · Configured by agent · shared max 2",
    "Exclude from this route",
    "Back",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.routes.execute, [{ resourceId: "qwen" }, { resourceId: "deepseek" }]);
  assert.deepEqual(saved.execution.routes.research, [{ resourceId: "qwen" }]);
  assert.equal(saved.execution.workerResources[1].maxConcurrent, 2);
});

test("/review-settings clear-all saves a valid review-disabled configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-empty-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    reviewers: [{ id: "one", adapter: "generic-cli", command: process.execPath }],
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Reviewers", "1/1 selected"),
    "Clear all",
    "Back",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review.activeReviewers, []);
});

test("root Escape leaves the settings file unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-cancel-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify({
    enabled: true,
    reviewers: [{ id: "one", adapter: "generic-cli", command: process.execPath }],
  });
  await writeFile(configPath, original, "utf8");
  const config: ReviewGateConfig = normalizeConfig(JSON.parse(original));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Bundle retention", "On failure"),
    "Always",
    undefined,
  ]));

  assert.equal(await readFile(configPath, "utf8"), original);
});

test("internal executor uses the exact Pi model label and canonical value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-model-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    // This test exercises model selection and persistence, not executable discovery.
    // Keep the master gate disabled so it does not require a full Pi CLI on PATH.
    enabled: false,
    enabledReviewerIds: [],
    reviewers: [],
    execution: { activeExecutor: null, externalExecutors: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "gpt-5.6-sol [openai-codex]",
    "1  current",
    "Back",
    "Save changes",
  ], [{ model: reasoningModel("openai-codex", "gpt-5.6-sol") }]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [{
    resourceId: "pi-b3BlbmFpLWNvZGV4L2dwdC01LjYtc29s",
    selection: {
      source: "pi",
      model: "openai-codex/gpt-5.6-sol",
    },
    maxConcurrent: 1,
  }]);
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId: "pi-b3BlbmFpLWNvZGV4L2dwdC01LjYtc29s", thinkingLevel: "high" }],
    research: [{ resourceId: "pi-b3BlbmFpLWNvZGV4L2dwdC01LjYtc29s", thinkingLevel: "high" }],
  });
});

test("first settings save migrates a legacy decider into the shared external catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-legacy-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    decider: {
      id: "legacy",
      adapter: "generic-cli",
      command: process.execPath,
      args: ["legacy-reviewer.cjs"],
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections(["Save changes"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.decider, undefined);
  assert.deepEqual(saved.review.activeReviewers, [{ source: "external", id: "legacy" }]);
  assert.deepEqual(saved.externalAgents, [{
    id: "legacy",
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["legacy-reviewer.cjs"],
      timeoutMs: 600000,
      protocol: "pi-reviewer-json-v1",
    },
  }]);
});

test("reviewer picker includes scoped models and shared review-capable external agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-review-models-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "codex",
      adapter: "codex-cli",
      command: "codex",
      review: { timeoutMs: 300000 },
      execution: { timeoutMs: 1800000 },
    }],
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Reviewers", "0/2 selected — review disabled by master setting"),
    "gpt-5.6-sol [openai-codex] ✗",
    "High  current",
    "codex [codex-cli] ✗",
    "Back",
    "Save changes",
  ], [{ model: reasoningModel("openai-codex", "gpt-5.6-sol") }]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review.activeReviewers, [
    { source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
    { source: "external", id: "codex" },
  ]);
});

test("review policy values are staged and saved atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-policy-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    maxCorrectionCycles: 1,
    implementationGuidanceAfterCorrectionAttempts: 1,
    review: { activeReviewers: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Review policy", "1 corrections · concrete after 1"),
    "Automatic correction attempts  1",
    "Concrete guidance after        1",
    "Back",
    "Save changes",
  ], [], ["4", "2"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.maxCorrectionCycles, 4);
  assert.equal(saved.implementationGuidanceAfterCorrectionAttempts, 2);
});

test("reviewer and executor timeouts are staged and saved together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-timeouts-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    reviewerTimeoutMs: 600000,
    executorTimeoutMs: 1800000,
    review: { activeReviewers: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Timeouts", "review 10m · executor 30m"),
    "Reviewer timeout  10m",
    "Executor timeout  30m",
    "Back",
    "Save changes",
  ], [], ["20", "90"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.reviewerTimeoutMs, 1_200_000);
  assert.equal(saved.executorTimeoutMs, 5_400_000);
  assert.equal(config.reviewerTimeoutMs, 1_200_000);
  assert.equal(config.executorTimeoutMs, 5_400_000);
});

test("bundle retention is staged and saved from review settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-retention-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    retainBundles: "on-failure",
    review: { activeReviewers: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Bundle retention", "On failure"),
    "Always",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.retainBundles, "always");
  assert.equal(config.retainBundles, "always");
});

test("subtasks view is staged and saved as a global review setting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-subtasks-view-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    ui: { subtasksViewExpanded: false },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Subtasks view", "Collapsed"),
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.ui.subtasksViewExpanded, true);
  assert.equal(config.ui?.subtasksViewExpanded, true);
});

test("subtask notification mode is staged and saved with quiet as the default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-subtask-notifications-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: null },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Subtask notifications", "Quiet"),
    "Noisy — include running and reviewing",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.execution.subtaskNotifications, "noisy");
  assert.equal(config.execution?.subtaskNotifications, "noisy");
});

test("deferred Pi tools toggle is staged, persisted, and labeled for local/new-subtask application", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-deferred-tools-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: null },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  let appliedImmediately: boolean | undefined;
  registerReviewSettings({
    pi: registered.pi,
    config,
    configPath,
    onSaved: (saved) => { appliedImmediately = saved.execution?.deferredPiTools; },
  });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Deferred Pi tools", "On · local now, new subtasks"),
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.execution.deferredPiTools, false);
  assert.equal(config.execution?.deferredPiTools, false);
  assert.equal(appliedImmediately, false);
});

test("web settings stage and save the maximum download size in MiB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-web-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    web: { search: { maxResults: 7 } },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Web", "50 MiB max download"),
    webSettingsRow("Maximum download", "50 MiB"),
    "Back",
    "Save changes",
  ], [], ["96"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.web.fetch.maxDownloadBytes, 96 * 1024 * 1024);
  assert.equal(saved.web.search.maxResults, 7);
  assert.equal(config.web?.fetch.maxDownloadBytes, 96 * 1024 * 1024);
});

test("internal executor and reviewers persist independent per-model reasoning levels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    // This test exercises settings serialization, not executable discovery.
    // Keep the master gate disabled so it is portable to hosts where the
    // pi launcher is not installed on PATH.
    enabled: false,
    execution: {
      activeExecutor: { source: "pi", model: "openai-codex/gpt-5.6-luna" },
    },
    review: {
      activeReviewers: [
        { source: "pi", model: "openai-codex/gpt-5.6-luna" },
        { source: "pi", model: "openai-codex/gpt-5.6-sol" },
      ],
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
    "1. gpt-5.6-luna [openai-codex] · High · shared max 4",
    "Thinking  High",
    "Max",
    "Back",
    "Back",
    rootSettingsRow("Reviewers", "2/2 selected — review disabled by master setting"),
    "Reasoning · gpt-5.6-luna [openai-codex]  High",
    "Max",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [{
    resourceId: "pi-b3BlbmFpLWNvZGV4L2dwdC01LjYtbHVuYQ",
    selection: {
      source: "pi",
      model: "openai-codex/gpt-5.6-luna",
    },
    maxConcurrent: 4,
  }]);
  assert.deepEqual(saved.execution.routes, {
    execute: [{
      resourceId: "pi-b3BlbmFpLWNvZGV4L2dwdC01LjYtbHVuYQ",
      thinkingLevel: "max",
    }],
    research: [{
      resourceId: "pi-b3BlbmFpLWNvZGV4L2dwdC01LjYtbHVuYQ",
    }],
  });
  assert.deepEqual(saved.review.activeReviewers, [
    { source: "pi", model: "openai-codex/gpt-5.6-luna", thinkingLevel: "max" },
    { source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
  ]);
});

test("scoped model reasoning choices omit unsupported extended levels", () => {
  const [local] = scopedModelChoices({
    scopedModels: [{ model: { provider: "llamacpp", id: "local", reasoning: true } }],
  })!;
  assert.deepEqual(local.supportedThinkingLevels, ["off", "minimal", "low", "medium", "high"]);
});

test("executor concurrency is staged and saved atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-workers-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: null },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Global concurrency", "4"),
    "12",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.execution.maxWorkers, 12);
  assert.equal(config.execution?.maxWorkers, 12);
});

test("retry policy is staged and saved atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-parallel-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: null },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Retry policy", "2 retries · 1s base"),
    retrySettingsRow("Retries after initial attempt", "2"),
    "Back",
    "Save changes",
  ], [], ["5"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.execution.retryPolicy.maxRetries, 5);
  assert.equal(config.execution?.retryPolicy?.maxRetries, 5);
});

test("Web approval choices stage, cancel, persist, and immediately notify the local sync hook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-approval-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ enabled: true, review: { activeReviewers: [] } }));
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  const savedPolicies: string[] = [];
  registerReviewSettings({ pi: registered.pi, config, configPath, onSaved: (next) => { savedPolicies.push(next.web!.browserInteractionApproval); } });
  let currentLabel = "Ask";
  for (const [label, policy] of [["Automatically Accept", "automatically-accept"], ["Automatically Deny", "automatically-deny"], ["Ask", "ask"]]) {
    const choices = [
      rootSettingsRow("Web", "50 MiB max download"),
      webSettingsRow("Browser interaction approval", currentLabel),
      label, "Back",
    ];
    const before = await readFile(configPath, "utf8");
    await registered.handler("", contextWithSelections([...choices, "Cancel"]));
    assert.equal(await readFile(configPath, "utf8"), before);
    await registered.handler("", contextWithSelections([...choices, "Save changes"]));
    assert.equal(config.web!.browserInteractionApproval, policy);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).web.browserInteractionApproval, policy);
    assert.equal(savedPolicies.at(-1), policy);
    currentLabel = label;
  }
  assert.deepEqual(savedPolicies, ["automatically-accept", "automatically-deny", "ask"]);
});

test("/review-settings aligns every settings value column from the full label set", async () => {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: null },
  });
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath: "/unused/review-gate.json" });
  let rootRows: string[] = [];
  let retryRows: string[] = [];
  let webRows: string[] = [];
  let selection = 0;

  await registered.handler("", {
    scopedModels: [],
    ui: {
      async select(title: string, options: string[]) {
        if (title === "Review settings") {
          const rootSelection = selection++;
          if (rootSelection === 0) {
            rootRows = options.slice(0, ROOT_SETTING_LABELS.length);
            return rootSettingsRow("Retry policy", "2 retries · 1s base");
          }
          if (rootSelection === 1) return rootSettingsRow("Web", "50 MiB max download");
          return undefined;
        }
        if (title === "Executor retry policy") {
          retryRows = options.slice(0, RETRY_SETTING_LABELS.length);
          return undefined;
        }
        if (title === "Web settings") {
          webRows = options.slice(0, WEB_SETTING_LABELS.length);
          return undefined;
        }
        return undefined;
      },
      notify() {},
    },
  });

  assertAlignedValueColumn(rootRows, ROOT_SETTING_LABELS);
  assertAlignedValueColumn(retryRows, RETRY_SETTING_LABELS);
  assertAlignedValueColumn(webRows, WEB_SETTING_LABELS);
});

const ROOT_SETTING_LABELS = [
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
  "Web",
] as const;

const RETRY_SETTING_LABELS = [
  "Retries after initial attempt",
  "Base delay",
  "Maximum delay",
  "Same-incident repeat limit",
  "Delay jitter",
] as const;

const WEB_SETTING_LABELS = ["Maximum download", "Browser interaction approval"] as const;

function rootSettingsRow(label: typeof ROOT_SETTING_LABELS[number], value: string): string {
  return alignedTestRow(label, value, ROOT_SETTING_LABELS);
}

function retrySettingsRow(label: typeof RETRY_SETTING_LABELS[number], value: string): string {
  return alignedTestRow(label, value, RETRY_SETTING_LABELS);
}

function webSettingsRow(label: typeof WEB_SETTING_LABELS[number], value: string): string {
  return alignedTestRow(label, value, WEB_SETTING_LABELS);
}

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function assertAlignedValueColumn(rows: string[], labels: readonly string[]): void {
  assert.equal(rows.length, labels.length);
  const expectedColumn = Math.max(...labels.map((label) => label.length)) + 2;
  rows.forEach((row, index) => {
    const label = labels[index];
    const valueOffset = row.slice(label.length).search(/\S/);
    assert.equal(label.length + valueOffset, expectedColumn, row);
  });
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
  inputs: Array<string | undefined> = [],
): unknown {
  let index = 0;
  let inputIndex = 0;
  return {
    scopedModels,
    ui: {
      async select(_title: string, options: string[]) {
        const value = values[index++];
        if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
        return value;
      },
      async input() {
        return inputs[inputIndex++];
      },
      notify() {},
    },
  };
}

function reasoningModel(provider: string, id: string): Record<string, unknown> {
  return {
    provider,
    id,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
}
