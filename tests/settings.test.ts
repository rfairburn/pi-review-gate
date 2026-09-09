import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executorEntryId, normalizeConfig, resolvedWorkerRoute, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { scopedModelChoices } from "../src/settings/models";

test("/review-settings stages executor and reviewer changes and saves them together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    customFutureKey: { keep: true },
    externalAgents: [
      { id: "one", adapter: "generic-cli", command: process.execPath, args: [], review: {} },
      { id: "two", adapter: "generic-cli", command: process.execPath, args: [], review: {} },
      { id: "fake", adapter: "run-as-binary", command: process.execPath, args: [], execution: { protocol: "pi-review-executor-jsonl-v1" } },
    ],
    review: { activeReviewers: [{ source: "external", id: "one" }] },
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
  // The canonical catalog keeps the configured agent order; settings saves
  // never reorder or migrate the shared external agent list.
  assert.deepEqual(saved.externalAgents.map((agent: { id: string }) => agent.id), ["one", "two", "fake"]);
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
    execution: {
workerResources: [],
    },
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
workerResources: [
        { resourceId: "qwen", selection: { source: "external", id: "qwen" }, maxConcurrent: 1 },
        { resourceId: "deepseek", selection: { source: "external", id: "deepseek" }, maxConcurrent: 2 },
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
externalAgents: [
      {
        id: "one",
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
      review: {}}
    ],
review: { activeReviewers: [
      { source: "external", id: "one" }
    ] },
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
externalAgents: [
      {
        id: "one",
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
      review: {}}
    ],
review: { activeReviewers: [
      { source: "external", id: "one" }
    ] },
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
    review: { activeReviewers: [] },
    execution: {},
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

test("first settings save persists the normalized shared external catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-catalog-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
enabled: true,
externalAgents: [
      {
        id: "legacy",
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
        review: {
          args: ["legacy-reviewer.cjs"],
        },
      }
    ],
review: { activeReviewers: [
      { source: "external", id: "legacy" }
    ] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections(["Save changes"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review.activeReviewers, [{ source: "external", id: "legacy" }]);
  // The canonical config is persisted as configured; review defaults are
  // applied at resolution time, never rewritten into the stored record.
  assert.deepEqual(saved.externalAgents, [{
    id: "legacy",
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["legacy-reviewer.cjs"],
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
    execution: {},
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
    execution: {},
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

test("browser idle expiry validates, stages, cancels and reloads through Web settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-idle-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify({ enabled: false, review: { activeReviewers: [] }, web: { future: true } });
  await writeFile(configPath, original);
  const config = normalizeConfig(JSON.parse(original));
  const registered = commandHarness();
  const reloaded: number[] = [];
  registerReviewSettings({ pi: registered.pi, config, configPath, onSaved: (next) => { reloaded.push(next.web!.browserIdleExpiryMinutes); } });
  const webRow = rootSettingsRow("Web", "50 MiB max download");
  const idleRow = webSettingsRow("Browser idle expiry", "15 minutes");
  await registered.handler("", contextWithSelections([webRow, idleRow, "Back", "Cancel"], [], ["30"]));
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.equal(config.web!.browserIdleExpiryMinutes, 15);
  assert.deepEqual(reloaded, []);

  const invalid = ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "", "abc"];
  const errors: string[] = [];
  const ctx = contextWithSelections([
    webRow, ...invalid.map(() => idleRow), idleRow, idleRow,
    webSettingsRow("Browser idle expiry", "30 minutes"), "Back", "Save changes",
  ], [], [...invalid, undefined, "30", undefined]) as { ui: { notify: (message: string, type?: string) => void } };
  ctx.ui.notify = (message, type) => { if (type === "error") errors.push(message); };
  await registered.handler("", ctx);
  assert.equal(errors.length, invalid.length);
  assert.ok(errors.every((message) => message.includes("positive safe whole number of minutes")));
  assert.equal(config.web!.browserIdleExpiryMinutes, 30);
  assert.deepEqual(reloaded, [30]);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.web.browserIdleExpiryMinutes, 30);
  assert.equal(saved.web.future, true);
  assert.equal(saved.web.browserInteractionApproval, "ask");
  assert.equal(saved.web.fetch.maxDownloadBytes, 50 * 1024 * 1024);
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
      workerResources: [{ selection: { source: "pi", model: "openai-codex/gpt-5.6-luna" }, maxConcurrent: 4 }],
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
    execution: {},
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
    execution: {},
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
    execution: {},
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

test("switching a worker model normalizes stale route reasoning to a supported level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-switch-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-luna";
  const nextModel = "openai-codex/gpt-5.6-nano";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  await writeFile(configPath, JSON.stringify({
    // This test exercises settings serialization, not executable discovery.
    // Keep the master gate disabled so it is portable to hosts where the
    // pi launcher is not installed on PATH.
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: [{ resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 }],
      routes: {
        execute: [{ resourceId, thinkingLevel: "high" }],
        research: [{ resourceId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: restrictedReasoningModel("openai-codex", "gpt-5.6-nano", ["off", "minimal"]) },
  ];
  const errors: string[] = [];
  const ctx = contextWithSelections([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "gpt-5.6-nano [openai-codex]",
    "Back",
    "Back",
    // The displayed level must already be the supported fallback, not the stale stored value.
    rootSettingsRow("Execution priority", "gpt-5.6-nano"),
    "1. gpt-5.6-nano [openai-codex] · Minimal · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped) as { ui: { notify: (message: string, type?: string) => void } };
  ctx.ui.notify = (message, type) => { if (type === "error") errors.push(message); };

  await registered.handler("", ctx);

  assert.deepEqual(errors, []);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [{
    resourceId,
    selection: { source: "pi", model: nextModel },
    maxConcurrent: 1,
  }]);
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId, thinkingLevel: "minimal" }],
    research: [{ resourceId, thinkingLevel: "minimal" }],
  });
  // Effective launch resolution must agree with the persisted values.
  for (const kind of ["execute", "research"] as const) {
    assertEffectiveReasoningSupported(saved, scoped, kind);
  }

  // Reopen and restart: the normalized choice is displayed consistently and a
  // second save is idempotent.
  const reopened = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const reopenedBefore = await readFile(configPath, "utf8");
  const reopenedRegistered = commandHarness();
  registerReviewSettings({ pi: reopenedRegistered.pi, config: reopened, configPath });
  await reopenedRegistered.handler("", contextWithSelections([
    rootSettingsRow("Execution priority", "gpt-5.6-nano"),
    "1. gpt-5.6-nano [openai-codex] · Minimal · shared max 1",
    "Back",
    "Back",
    rootSettingsRow("Research priority", "gpt-5.6-nano"),
    "1. gpt-5.6-nano [openai-codex] · Minimal · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));
  assert.equal(await readFile(configPath, "utf8"), reopenedBefore);
});

test("switching a worker model discards prior reasoning even when the new model supports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-preserve-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-luna";
  const nextModel = "openai-codex/gpt-5.6-nova";
  const otherModel = "openai-codex/gpt-5.6-sol";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  const otherResourceId = executorEntryId({ source: "pi", model: otherModel });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: [
        { resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 },
        { resourceId: otherResourceId, selection: { source: "pi", model: otherModel }, maxConcurrent: 2 },
      ],
      routes: {
        execute: [{ resourceId, thinkingLevel: "medium" }, { resourceId: otherResourceId, thinkingLevel: "xhigh" }],
        research: [{ resourceId }, { resourceId: otherResourceId, thinkingLevel: "max" }],
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
    // The switched resource displays the new model's own default, not the prior level.
    rootSettingsRow("Execution priority", "gpt-5.6-nova → gpt-5.6-sol"),
    "1. gpt-5.6-nova [openai-codex] · High · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources.map((entry: { selection: { model?: string } }) => entry.selection), [
    { source: "pi", model: nextModel },
    { source: "pi", model: otherModel },
  ]);
  // The previous model's level is never carried over, even though the new model
  // supports it: both retained entries take the new model's own default. The
  // unrelated resource's explicit overrides are untouched.
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId, thinkingLevel: "high" }, { resourceId: otherResourceId, thinkingLevel: "xhigh" }],
    research: [{ resourceId, thinkingLevel: "high" }, { resourceId: otherResourceId, thinkingLevel: "max" }],
  });
  for (const kind of ["execute", "research"] as const) {
    assertEffectiveReasoningSupported(saved, scoped, kind);
  }
});

test("switching a worker model selects the new model's pinned reasoning over a supported prior level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-pinned-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-luna";
  const nextModel = "openai-codex/gpt-5.6-low";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: [{ resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 }],
      routes: {
        execute: [{ resourceId, thinkingLevel: "high" }],
        research: [{ resourceId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    // Pinned to low while still supporting the prior high level.
    { model: restrictedReasoningModel("openai-codex", "gpt-5.6-low", ["off", "minimal", "low", "medium", "high"]), thinkingLevel: "low" },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "gpt-5.6-low [openai-codex]",
    "Back",
    "Back",
    rootSettingsRow("Execution priority", "gpt-5.6-low"),
    "1. gpt-5.6-low [openai-codex] · Low · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [{
    resourceId,
    selection: { source: "pi", model: nextModel },
    maxConcurrent: 1,
  }]);
  // The new model's configured/pinned reasoning governs both routes even though
  // it also supports the prior level.
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId, thinkingLevel: "low" }],
    research: [{ resourceId, thinkingLevel: "low" }],
  });
  for (const kind of ["execute", "research"] as const) {
    assertEffectiveReasoningSupported(saved, scoped, kind);
  }

  // Reopen and restart: the paired choice displays consistently and a second
  // save is idempotent.
  const reopened = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const reopenedBefore = await readFile(configPath, "utf8");
  const reopenedRegistered = commandHarness();
  registerReviewSettings({ pi: reopenedRegistered.pi, config: reopened, configPath });
  await reopenedRegistered.handler("", contextWithSelections([
    rootSettingsRow("Execution priority", "gpt-5.6-low"),
    "1. gpt-5.6-low [openai-codex] · Low · shared max 1",
    "Back",
    "Back",
    rootSettingsRow("Research priority", "gpt-5.6-low"),
    "1. gpt-5.6-low [openai-codex] · Low · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));
  assert.equal(await readFile(configPath, "utf8"), reopenedBefore);
});

test("switching a worker from a minimal-only model selects the new model's own default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-default-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-nano";
  const nextModel = "openai-codex/gpt-5.6-sol";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: [{ resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 }],
      routes: {
        execute: [{ resourceId, thinkingLevel: "minimal" }],
        research: [{ resourceId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: restrictedReasoningModel("openai-codex", "gpt-5.6-nano", ["off", "minimal"]) },
    { model: reasoningModel("openai-codex", "gpt-5.6-sol") },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. gpt-5.6-nano [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-nano [openai-codex]"),
    "gpt-5.6-sol [openai-codex]",
    "Back",
    "Back",
    rootSettingsRow("Execution priority", "gpt-5.6-sol"),
    "1. gpt-5.6-sol [openai-codex] · High · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // The prior model's minimal level is not carried over: with no pinned value on
  // the new model, its own supported default governs both routes.
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId, thinkingLevel: "high" }],
    research: [{ resourceId, thinkingLevel: "high" }],
  });
  for (const kind of ["execute", "research"] as const) {
    assertEffectiveReasoningSupported(saved, scoped, kind);
  }
});

test("switching a worker to a single-level model normalizes both routes to that level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-single-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-luna";
  const nextModel = "openai-codex/gpt-5.6-solo";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: [{ resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 }],
      routes: {
        execute: [{ resourceId, thinkingLevel: "high" }],
        research: [{ resourceId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: restrictedReasoningModel("openai-codex", "gpt-5.6-solo", ["medium"]) },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "gpt-5.6-solo [openai-codex]",
    "Back",
    "Back",
    rootSettingsRow("Execution priority", "gpt-5.6-solo"),
    "1. gpt-5.6-solo [openai-codex] · Medium · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId, thinkingLevel: "medium" }],
    research: [{ resourceId, thinkingLevel: "medium" }],
  });
  for (const kind of ["execute", "research"] as const) {
    assertEffectiveReasoningSupported(saved, scoped, kind);
  }
});

test("switching a worker to a model without configurable reasoning normalizes to off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-none-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-luna";
  const nextModel = "llamacpp/local-7b";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: [{ resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 }],
      routes: {
        execute: [{ resourceId, thinkingLevel: "high" }],
        research: [{ resourceId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [
    { model: reasoningModel("openai-codex", "gpt-5.6-luna") },
    { model: { provider: "llamacpp", id: "local-7b", reasoning: false } },
  ];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "local-7b [llamacpp]",
    "Back",
    "Back",
    rootSettingsRow("Execution priority", "local-7b"),
    "1. local-7b [llamacpp] · Off · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId, thinkingLevel: "off" }],
    research: [{ resourceId, thinkingLevel: "off" }],
  });
  for (const kind of ["execute", "research"] as const) {
    assertEffectiveReasoningSupported(saved, scoped, kind);
  }
});

test("switching a worker to an external agent drops its reasoning overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-reasoning-external-"));
  const configPath = join(dir, "review-gate.json");
  const priorModel = "openai-codex/gpt-5.6-luna";
  const resourceId = executorEntryId({ source: "pi", model: priorModel });
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      workerResources: [{ resourceId, selection: { source: "pi", model: priorModel }, maxConcurrent: 1 }],
      routes: {
        execute: [{ resourceId, thinkingLevel: "high" }],
        research: [{ resourceId }],
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const scoped = [{ model: reasoningModel("openai-codex", "gpt-5.6-luna") }];

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "1 model · 1 slot"),
    "1. gpt-5.6-luna [openai-codex] · shared max 1",
    executorEntryRow("Model", "gpt-5.6-luna [openai-codex]"),
    "fake [run-as-binary]",
    "Back",
    "Back",
    rootSettingsRow("Execution priority", "fake"),
    "1. fake [run-as-binary] · Configured by agent · shared max 1",
    "Back",
    "Back",
    "Save changes",
  ], scoped));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, [{
    resourceId,
    selection: { source: "external", id: "fake" },
    maxConcurrent: 1,
  }]);
  // External agents own their configuration; the stale pi reasoning override is
  // dropped, and the non-research-capable agent leaves the research route empty.
  assert.deepEqual(saved.execution.routes, {
    execute: [{ resourceId }],
    research: [],
  });
});

function assertEffectiveReasoningSupported(savedConfig: unknown, scopedModels: unknown[], kind: "execute" | "research"): void {
  const config = normalizeConfig(savedConfig);
  const choices = scopedModelChoices({ scopedModels })!;
  for (const entry of resolvedWorkerRoute(config, kind)) {
    const selection = entry.selection;
    if (selection.source !== "pi") continue;
    const choice = choices.find((candidate) => candidate.model === selection.model);
    assert.ok(choice, `effective ${kind} model is scoped: ${selection.model}`);
    assert.ok(
      selection.thinkingLevel === undefined || choice.supportedThinkingLevels.includes(selection.thinkingLevel),
      `effective ${kind} reasoning ${String(selection.thinkingLevel)} is supported by ${selection.model}`,
    );
  }
}

const ROOT_SETTING_LABELS = [
  "Operating mode",
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

const WEB_SETTING_LABELS = ["Maximum download", "Browser interaction approval", "Browser idle expiry"] as const;

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

function restrictedReasoningModel(
  provider: string,
  id: string,
  supported: Array<"off" | "minimal" | "low" | "medium" | "high">,
): Record<string, unknown> {
  const thinkingLevelMap: Record<string, unknown> = {};
  for (const level of ["off", "minimal", "low", "medium", "high"] as const) {
    if (!supported.includes(level)) thinkingLevelMap[level] = null;
  }
  return { provider, id, reasoning: true, thinkingLevelMap };
}

function executorEntryRow(label: string, value: string): string {
  const width = Math.max("Model".length, "Maximum concurrency".length);
  return `${label.padEnd(width)}  ${value}`;
}
