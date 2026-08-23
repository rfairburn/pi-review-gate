import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeExternalExecutor, automaticReviewEnabled, loadConfig, materializeReviewConfig, normalizeConfig, resolveReviewers, resolvedExecutorPool, resolvedWorkerResources, resolvedWorkerRoute } from "../src/config";

test("loadConfig prefers PI_REVIEW_GATE_CONFIG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        enabled: true,
        decider: {
          id: "fake",
          adapter: "generic-cli",
          command: "node",
        },
      }),
      "utf8",
    );

    const loaded = loadConfig({
      PI_REVIEW_GATE_CONFIG: path,
    });

    assert.equal(loaded.path, path);
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.config.decider?.id, "fake");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig supports PI_REVIEW_GATE_DISABLED", () => {
  const loaded = loadConfig({
    PI_REVIEW_GATE_DISABLED: "1",
  });

  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.disabledReason, "PI_REVIEW_GATE_DISABLED is set");
});

test("normalizeConfig preserves the global subtasks view preference", () => {
  const config = normalizeConfig({ enabled: true, ui: { subtasksViewExpanded: true } });
  assert.equal(config.ui?.subtasksViewExpanded, true);
  assert.equal(materializeReviewConfig(config, []).ui, undefined, "UI state is not frozen into a conversation review window");
  assert.throws(
    () => normalizeConfig({ enabled: true, ui: { subtasksViewExpanded: "yes" } }),
    /ui\.subtasksViewExpanded must be a boolean/,
  );
});

test("subtask notifications default to quiet and validate the noisy alternative", () => {
  assert.equal(normalizeConfig({ enabled: true }).execution, undefined);
  assert.equal(normalizeConfig({ enabled: true, execution: {} }).execution?.subtaskNotifications, "quiet");
  assert.equal(
    normalizeConfig({ enabled: true, execution: { subtaskNotifications: "noisy" } }).execution?.subtaskNotifications,
    "noisy",
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { subtaskNotifications: "sometimes" } }),
    /execution\.subtaskNotifications must be quiet or noisy/,
  );
});

test("normalizeConfig supplies defaults for typed reviewer adapters", () => {
  const codex = normalizeConfig({
    enabled: true,
    decider: {
      id: "codex",
      adapter: "codex-cli",
    },
  });

  assert.deepEqual(codex.decider, {
    id: "codex",
    adapter: "codex-cli",
    command: "codex",
    args: [],
    model: undefined,
    timeoutMs: 600000,
  });
  assert.equal(codex.implementationGuidanceAfterCorrectionAttempts, 1);
  assert.equal(codex.reviewerTimeoutMs, 600000);
  assert.equal(codex.executorTimeoutMs, 1800000);

  const claude = normalizeConfig({
    enabled: true,
    decider: {
      id: "claude",
      adapter: "claude-cli",
    },
  });

  assert.deepEqual(claude.decider, {
    id: "claude",
    adapter: "claude-cli",
    command: "claude",
    args: [],
    model: undefined,
    timeoutMs: 600000,
  });
});

test("configured timeouts apply to internal models and unoverridden external roles", () => {
  const config = normalizeConfig({
    enabled: true,
    reviewerTimeoutMs: 900000,
    executorTimeoutMs: 3600000,
    review: {
      activeReviewers: [
        { source: "pi", model: "openai-codex/gpt-5.6-luna" },
        { source: "external", id: "codex" },
      ],
    },
    execution: { activeExecutor: { source: "external", id: "codex" } },
    externalAgents: [{
      id: "codex",
      adapter: "codex-cli",
      review: {},
      execution: {},
    }],
  });

  const reviewers = resolveReviewers(config, ["openai-codex/gpt-5.6-luna"]).reviewers;
  assert.equal(reviewers[0]?.timeoutMs, 900000);
  assert.equal(reviewers[1]?.timeoutMs, 900000);
  assert.equal(activeExternalExecutor(config)?.timeoutMs, 3600000);
});

test("normalizeConfig validates implementation guidance escalation thresholds", () => {
  const configured = normalizeConfig({
    enabled: true,
    implementationGuidanceAfterCorrectionAttempts: 0,
    decider: {
      id: "codex",
      adapter: "codex-cli",
    },
  });
  assert.equal(configured.implementationGuidanceAfterCorrectionAttempts, 0);
  assert.throws(() => normalizeConfig({
    enabled: true,
    implementationGuidanceAfterCorrectionAttempts: 1.5,
    decider: {
      id: "codex",
      adapter: "codex-cli",
    },
  }), /implementationGuidanceAfterCorrectionAttempts/);
});

test("normalizeConfig rejects coercible booleans and invalid retention values", () => {
  assert.throws(() => normalizeConfig({ enabled: "false" }), /enabled must be a boolean/);
  assert.throws(() => normalizeConfig({ retainBundles: "sometimes" }), /retainBundles/);
  assert.throws(() => normalizeConfig({ reviewerTimeoutMs: 0 }), /reviewerTimeoutMs/);
  assert.throws(() => normalizeConfig({ waveArtifactTtlMs: -1 }), /waveArtifactTtlMs/);
  assert.throws(() => normalizeConfig({
    decider: { id: "bad", adapter: "codex-cli", args: ["ok", 1] },
  }), /args must be an array of strings/);
});

test("normalizeConfig keeps pi model selection generic", () => {
  const loaded = normalizeConfig({
    enabled: true,
    decider: {
      id: "glm",
      adapter: "pi-model",
      model: "ollama/glm-5.2",
      thinkingLevel: "medium",
    },
  });

  assert.deepEqual(loaded.decider, {
    id: "glm",
    adapter: "pi-model",
    command: "pi",
    args: [],
    model: "ollama/glm-5.2",
    thinkingLevel: "medium",
    timeoutMs: 600000,
  });
});

test("normalizeConfig rejects unsupported internal thinking levels", () => {
  assert.throws(() => normalizeConfig({
    enabled: true,
    review: {
      activeReviewers: [{
        source: "pi",
        model: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "ultra",
      }],
    },
  }), /thinkingLevel must be one of/);
});

test("normalizeConfig supports multiple reviewers without legacy decider", () => {
  const loaded = normalizeConfig({
    enabled: true,
    reviewers: [
      {
        id: "codex",
        adapter: "codex-cli",
      },
      {
        id: "claude",
        adapter: "claude-cli",
      },
    ],
  });

  assert.equal(loaded.decider, undefined);
  assert.deepEqual(loaded.reviewers?.map((reviewer) => reviewer.id), ["codex", "claude"]);
});

test("normalizeConfig rejects duplicate reviewer ids", () => {
  assert.throws(
    () => normalizeConfig({
      enabled: true,
      reviewers: [
        {
          id: "same",
          adapter: "codex-cli",
        },
        {
          id: "same",
          adapter: "claude-cli",
        },
      ],
    }),
    /reviewer id must be unique: same/,
  );
});

test("normalizeConfig rejects reviewer ids that could share an output directory", () => {
  for (const id of ["review/a", "review?a"]) {
    assert.throws(
      () => normalizeConfig({
        enabled: true,
        reviewers: [
          {
            id,
            adapter: "codex-cli",
          },
        ],
      }),
      /reviewer id may contain only letters, numbers, underscores, periods, and hyphens/,
    );
  }
});

test("normalizeConfig rejects path-reserved reviewer ids", () => {
  for (const id of [".", ".."]) {
    assert.throws(
      () => normalizeConfig({
        enabled: true,
        decider: {
          id,
          adapter: "codex-cli",
        },
      }),
      /reviewer id may contain only letters, numbers, underscores, periods, and hyphens/,
    );
  }
});

test("normalizeConfig permits zero enabled reviewers as an explicit review opt-out", () => {
  const config = normalizeConfig({
    enabled: true,
    enabledReviewerIds: [],
    reviewers: [{ id: "codex", adapter: "codex-cli" }],
  });

  assert.deepEqual(resolveReviewers(config).reviewers, []);
  assert.equal(automaticReviewEnabled(config), false);
});

test("resolveReviewers filters the catalog in stable config order", () => {
  const config = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["third", "first"],
    reviewers: [
      { id: "first", adapter: "codex-cli" },
      { id: "second", adapter: "claude-cli" },
      { id: "third", adapter: "generic-cli", command: "review" },
    ],
  });

  assert.deepEqual(resolveReviewers(config).reviewers.map((reviewer) => reviewer.id), ["first", "third"]);
  assert.equal(automaticReviewEnabled(config), true);
});

test("normalizeConfig preserves internal and external executor selections", () => {
  const internal = normalizeConfig({
    enabled: true,
    enabledReviewerIds: [],
    execution: {
      activeExecutor: { source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
      externalExecutors: [
        { id: "codex", adapter: "codex-cli", command: "codex", model: "gpt-5.6-sol" },
        {
          id: "fake",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: "fake-agent",
        },
      ],
    },
  });

  assert.deepEqual(internal.execution?.activeExecutor, {
    source: "pi",
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "high",
  });
  assert.deepEqual(internal.execution?.externalExecutors?.map((executor) => executor.id), ["codex", "fake"]);
});

test("normalizeConfig preserves an ordered executor pool with per-model capacity", () => {
  const config = normalizeConfig({
    enabled: true,
    execution: {
      executorPool: [
        {
          entryId: "local-primary",
          selection: { source: "pi", model: "qwen/local", thinkingLevel: "high" },
          maxConcurrent: 1,
        },
        {
          entryId: "cloud-overflow",
          selection: { source: "external", id: "deepseek" },
          maxConcurrent: 3,
        },
      ],
    },
  });

  assert.deepEqual(resolvedExecutorPool(config), [
    {
      entryId: "local-primary",
      selection: { source: "pi", model: "qwen/local", thinkingLevel: "high" },
      maxConcurrent: 1,
    },
    {
      entryId: "cloud-overflow",
      selection: { source: "external", id: "deepseek" },
      maxConcurrent: 3,
    },
  ]);
});

test("research routing excludes generic binary resources until their protocol can enforce the contract", () => {
  const config = normalizeConfig({
    enabled: true,
    externalAgents: [{
      id: "binary",
      adapter: "run-as-binary",
      command: "binary",
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      workerResources: [{
        resourceId: "binary",
        selection: { source: "external", id: "binary" },
        maxConcurrent: 1,
      }],
      routes: { execute: [{ resourceId: "binary" }], research: [{ resourceId: "binary" }] },
    },
  });
  assert.equal(resolvedWorkerRoute(config, "execute").length, 1);
  assert.equal(resolvedWorkerRoute(config, "research").length, 0);
});

test("worker resources have shared capacity and independently ordered, excluding routes", () => {
  const config = normalizeConfig({
    enabled: true,
    externalAgents: ["deepseek", "luna"].map((id) => ({
      id,
      adapter: "codex-cli",
      command: "codex",
      execution: {},
    })),
    execution: {
      workerResources: [
        {
          resourceId: "qwen",
          selection: { source: "pi", model: "qwen/local", thinkingLevel: "high" },
          maxConcurrent: 1,
        },
        {
          resourceId: "deepseek",
          selection: { source: "external", id: "deepseek" },
          maxConcurrent: 3,
        },
        {
          resourceId: "luna",
          selection: { source: "external", id: "luna" },
          maxConcurrent: 4,
        },
      ],
      routes: {
        execute: [
          { resourceId: "qwen", thinkingLevel: "max" },
          { resourceId: "deepseek" },
        ],
        research: [
          { resourceId: "luna" },
          { resourceId: "qwen", thinkingLevel: "medium" },
        ],
      },
    },
  });

  assert.deepEqual(resolvedWorkerResources(config).map((entry) => [entry.entryId, entry.maxConcurrent]), [
    ["qwen", 1], ["deepseek", 3], ["luna", 4],
  ]);
  assert.deepEqual(resolvedWorkerRoute(config, "execute").map((entry) => [entry.entryId, entry.selection]), [
    ["qwen", { source: "pi", model: "qwen/local", thinkingLevel: "max" }],
    ["deepseek", { source: "external", id: "deepseek" }],
  ]);
  assert.deepEqual(resolvedWorkerRoute(config, "research").map((entry) => [entry.entryId, entry.selection]), [
    ["luna", { source: "external", id: "luna" }],
    ["qwen", { source: "pi", model: "qwen/local", thinkingLevel: "medium" }],
  ]);
  assert.equal(resolvedWorkerRoute(config, "research").some((entry) => entry.entryId === "deepseek"), false);
});

test("worker routes reject unknown and duplicate resource references", () => {
  const resources = [{
    resourceId: "qwen",
    selection: { source: "external", id: "qwen" },
    maxConcurrent: 1,
  }];
  assert.throws(() => normalizeConfig({
    enabled: true,
    execution: { workerResources: resources, routes: { research: [{ resourceId: "missing" }] } },
  }), /unknown worker resource missing/);
  assert.throws(() => normalizeConfig({
    enabled: true,
    execution: { workerResources: resources, routes: { research: [{ resourceId: "qwen" }, { resourceId: "qwen" }] } },
  }), /execution\.routes\.research resource id must be unique/);
});

test("normalizeConfig rejects invalid or duplicate executor pool entries", () => {
  assert.throws(() => normalizeConfig({
    enabled: true,
    execution: {
      executorPool: [{
        entryId: "bad-capacity",
        selection: { source: "external", id: "deepseek" },
        maxConcurrent: 17,
      }],
    },
  }), /maxConcurrent/);
  assert.throws(() => normalizeConfig({
    enabled: true,
    execution: {
      executorPool: [
        { entryId: "first", selection: { source: "external", id: "deepseek" }, maxConcurrent: 1 },
        { entryId: "second", selection: { source: "external", id: "deepseek" }, maxConcurrent: 2 },
      ],
    },
  }), /duplicate executor pool selection/);
});

test("resolveReviewers reports stale and duplicate enabled ids without rejecting config loading", () => {
  const config = normalizeConfig({
    enabled: true,
    enabledReviewerIds: ["codex", "missing", "codex"],
    reviewers: [{ id: "codex", adapter: "codex-cli" }],
  });
  const resolution = resolveReviewers(config);

  assert.deepEqual(resolution.unknownIds, ["missing"]);
  assert.deepEqual(resolution.duplicateEnabledIds, ["codex"]);
  assert.equal(automaticReviewEnabled(config), false);
});

test("shared external agents resolve independently for review and execution", () => {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [{ source: "external", id: "codex" }] },
    externalAgents: [{
      id: "codex",
      adapter: "codex-cli",
      command: "codex",
      model: "base-model",
      review: { model: "review-model", timeoutMs: 300000, args: ["--review"] },
      execution: { model: "execution-model", timeoutMs: 1800000, args: ["--execute"] },
    }],
    execution: { activeExecutor: { source: "external", id: "codex" } },
  });

  assert.deepEqual(resolveReviewers(config).reviewers[0], {
    id: "codex",
    adapter: "codex-cli",
    command: "codex",
    args: ["--review"],
    env: {},
    model: "review-model",
    timeoutMs: 300000,
  });
  assert.deepEqual(activeExternalExecutor(config), {
    id: "codex",
    adapter: "codex-cli",
    command: "codex",
    args: ["--execute"],
    env: {},
    model: "execution-model",
    timeoutMs: 1800000,
  });
});

test("scoped pi models resolve as reviewers only when currently available", () => {
  const config = normalizeConfig({
    enabled: true,
    review: {
      activeReviewers: [{ source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "max" }],
    },
  });

  assert.equal(automaticReviewEnabled(config), false);
  assert.deepEqual(resolveReviewers(config).unknownIds, ["pi:openai-codex/gpt-5.6-sol"]);
  const resolved = resolveReviewers(config, ["openai-codex/gpt-5.6-sol"]);
  assert.equal(resolved.unknownIds.length, 0);
  assert.equal(resolved.reviewers[0]?.adapter, "pi-model");
  assert.equal("model" in resolved.reviewers[0]! ? resolved.reviewers[0].model : undefined, "openai-codex/gpt-5.6-sol");
  assert.equal("thinkingLevel" in resolved.reviewers[0]! ? resolved.reviewers[0].thinkingLevel : undefined, "max");
  assert.equal(automaticReviewEnabled(config, ["openai-codex/gpt-5.6-sol"]), true);
});

test("normalizeConfig accepts execution.maxWorkers 1..16", () => {
  for (const w of [1, 2, 4, 8, 12, 16]) {
    const config = normalizeConfig({
      enabled: true,
      execution: { maxWorkers: w },
    });
    assert.equal(config.execution?.maxWorkers, w);
  }
});

test("normalizeConfig rejects invalid execution.maxWorkers", () => {
  assert.throws(() => normalizeConfig({ enabled: true, execution: { maxWorkers: 0 } }), /maxWorkers must be between 1 and 16/);
  assert.throws(() => normalizeConfig({ enabled: true, execution: { maxWorkers: 17 } }), /maxWorkers must be between 1 and 16/);
  assert.throws(() => normalizeConfig({ enabled: true, execution: { maxWorkers: 2.5 } }), /maxWorkers must be an integer/);
  assert.throws(() => normalizeConfig({ enabled: true, execution: { maxWorkers: "2" } }), /maxWorkers must be an integer/);
});

test("normalizeConfig omits execution.maxWorkers when not provided", () => {
  const config = normalizeConfig({ enabled: true, execution: { activeExecutor: null } });
  assert.equal(config.execution?.maxWorkers, undefined);
});
