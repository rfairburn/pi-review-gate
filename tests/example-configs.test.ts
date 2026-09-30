/**
 * The shipped standalone example configs and the
 * runnable JSON blocks in README.md, docs/getting-started.md, and
 * docs/configuration.md must normalize through the production strict
 * validator and resolve to their intended reviewers/workers.
 *
 * Everything here is hermetic: no provider, model, or process is invoked to
 * validate an example. Pi-model availability is supplied as a plain scoped
 * model fixture array to the production resolver, and the scheduled-tasks
 * illustrative fragment is wrapped in a minimal test-context worker resource
 * (clearly labeled below) because the documented fragment alone does not
 * define its pinned `local-research` reference.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  effectiveReviewSettings,
  internalReviewerId,
  normalizeConfig,
  resolveReviewers,
  reviewerSelectionKey,
  resolvedWorkerResources,
  resolvedWorkerRoute,
  type DeciderConfig,
  type ReviewGateConfig,
} from "../src/config";

const ROOT = join(__dirname, "..", "..");

/** Canonical page for the scheduledTasks fragment, classified by fence content. */
const SCHEDULED_FRAGMENT_PAGE = "docs/configuration.md";

type SelectionExpectation =
  | { source: "pi"; model: string; thinkingLevel?: string }
  | { source: "external"; id: string };

interface ReviewerExpectation {
  id: string;
  adapter: string;
  command?: string;
  model?: string;
  timeoutMs: number;
}

interface ExampleSettings {
  enabled?: boolean;
  reviewerTimeoutMs?: number;
  executorTimeoutMs?: number;
  maxCorrectionCycles?: number;
  implementationGuidanceAfterCorrectionAttempts?: number;
  maxPatchBytes?: number;
  maxFileBytes?: number;
  maxSnapshotBytes?: number;
  retainBundles?: string;
}

interface ExampleExecution {
  resourceKeys: string[];
  resources: Array<{ entryId: string; selection: SelectionExpectation; maxConcurrent: number }>;
  executeRoute: Array<{ entryId: string; selection: SelectionExpectation }>;
  researchRoute: Array<{ entryId: string; selection: SelectionExpectation }>;
  maxWorkers?: number;
}

interface ExampleContract {
  /** Hermetic scoped-model fixture for pi selections (no provider access). */
  scopedModels: string[];
  primary: SelectionExpectation[];
  subtask: SelectionExpectation[];
  reviewers: ReviewerExpectation[];
  settings?: ExampleSettings;
  execution?: ExampleExecution;
}

const glmSelection: SelectionExpectation = { source: "pi", model: "ollama/glm-5.2" };
const deepseekSelection: SelectionExpectation = { source: "pi", model: "ollama/deepseek-v4-flash:0731-cloud" };
const codexExternal: SelectionExpectation = { source: "external", id: "codex" };
const claudeExternal: SelectionExpectation = { source: "external", id: "claude" };

/**
 * Independent intended-contract oracles for every shipped standalone example.
 * Constructed from the advertised intent of each file, not copied from the
 * example objects themselves.
 */
const CONTRACTS: Record<string, ExampleContract> = {
  "delegated-execution.json": {
    scopedModels: [],
    // Legacy review.activeReviewers import: the same set becomes both layers.
    primary: [{ source: "external", id: "codex-sol" }],
    subtask: [{ source: "external", id: "codex-sol" }],
    reviewers: [
      { id: "codex-sol", adapter: "codex-cli", command: "codex", model: "gpt-5.6-sol", timeoutMs: 600000 },
    ],
    settings: {
      enabled: true,
      reviewerTimeoutMs: 600000,
      executorTimeoutMs: 1800000,
      maxCorrectionCycles: 3,
      implementationGuidanceAfterCorrectionAttempts: 1,
      retainBundles: "on-failure",
    },
    execution: {
      resourceKeys: ["local-primary", "codex-cloud-overflow", "claude-overflow"],
      resources: [
        { entryId: "local-primary", selection: { source: "pi", model: "openai-codex/gpt-5.6-sol" }, maxConcurrent: 1 },
        { entryId: "codex-cloud-overflow", selection: { source: "external", id: "codex-luna" }, maxConcurrent: 3 },
        { entryId: "claude-overflow", selection: claudeExternal, maxConcurrent: 4 },
      ],
      executeRoute: [
        { entryId: "local-primary", selection: { source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" } },
        { entryId: "codex-cloud-overflow", selection: { source: "external", id: "codex-luna" } },
        { entryId: "claude-overflow", selection: claudeExternal },
      ],
      researchRoute: [
        { entryId: "codex-cloud-overflow", selection: { source: "external", id: "codex-luna" } },
        { entryId: "local-primary", selection: { source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "medium" } },
      ],
      maxWorkers: 4,
    },
  },
  "double-deepseek-v4-flash-review.json": {
    scopedModels: ["ollama/deepseek-v4-flash:0731-cloud"],
    primary: [codexExternal, deepseekSelection],
    subtask: [codexExternal, deepseekSelection],
    reviewers: [
      { id: "codex", adapter: "codex-cli", command: "codex", timeoutMs: 600000 },
      {
        id: internalReviewerId("ollama/deepseek-v4-flash:0731-cloud"),
        adapter: "pi-model",
        command: "pi",
        model: "ollama/deepseek-v4-flash:0731-cloud",
        // Pi selections take the explicit global reviewer timeout.
        timeoutMs: 600000,
      },
    ],
    settings: {
      enabled: true,
      reviewerTimeoutMs: 600000,
      maxCorrectionCycles: 30,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
  "double-review.json": {
    scopedModels: ["ollama/glm-5.2"],
    primary: [codexExternal, glmSelection],
    subtask: [codexExternal, glmSelection],
    reviewers: [
      { id: "codex", adapter: "codex-cli", command: "codex", timeoutMs: 600000 },
      { id: internalReviewerId("ollama/glm-5.2"), adapter: "pi-model", command: "pi", model: "ollama/glm-5.2", timeoutMs: 600000 },
    ],
    settings: {
      enabled: true,
      maxCorrectionCycles: 30,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
  "fake-reviewer.json": {
    scopedModels: [],
    primary: [{ source: "external", id: "fake-reviewer" }],
    subtask: [{ source: "external", id: "fake-reviewer" }],
    reviewers: [
      { id: "fake-reviewer", adapter: "generic-cli", command: "node", timeoutMs: 5000 },
    ],
    settings: {
      enabled: true,
      maxCorrectionCycles: 1,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
  "single-claude.json": {
    scopedModels: [],
    primary: [claudeExternal],
    subtask: [claudeExternal],
    reviewers: [
      { id: "claude", adapter: "claude-cli", command: "claude", timeoutMs: 600000 },
    ],
    settings: {
      enabled: true,
      maxCorrectionCycles: 30,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
  "single-codex.json": {
    scopedModels: [],
    primary: [codexExternal],
    subtask: [codexExternal],
    reviewers: [
      { id: "codex", adapter: "codex-cli", command: "codex", timeoutMs: 600000 },
    ],
    settings: {
      enabled: true,
      maxCorrectionCycles: 30,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
  "single-pi-model.json": {
    scopedModels: ["ollama/glm-5.2"],
    primary: [glmSelection],
    subtask: [glmSelection],
    reviewers: [
      { id: internalReviewerId("ollama/glm-5.2"), adapter: "pi-model", command: "pi", model: "ollama/glm-5.2", timeoutMs: 600000 },
    ],
    settings: {
      enabled: true,
      maxCorrectionCycles: 30,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
  "triple-review.json": {
    scopedModels: ["ollama/glm-5.2"],
    primary: [codexExternal, glmSelection, claudeExternal],
    subtask: [codexExternal, glmSelection, claudeExternal],
    reviewers: [
      { id: "codex", adapter: "codex-cli", command: "codex", timeoutMs: 600000 },
      { id: internalReviewerId("ollama/glm-5.2"), adapter: "pi-model", command: "pi", model: "ollama/glm-5.2", timeoutMs: 600000 },
      { id: "claude", adapter: "claude-cli", command: "claude", timeoutMs: 600000 },
    ],
    settings: {
      enabled: true,
      maxCorrectionCycles: 30,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "on-failure",
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fence-aware markdown read: returns every top-level ```json fence's parsed
 * object. Fences are classified by content by the callers; this helper only
 * tracks fence state, so relocated or reordered blocks keep working.
 */
function extractJsonFences(markdown: string): Array<Record<string, unknown>> {
  const fences: Array<Record<string, unknown>> = [];
  let inside = false;
  let language = "";
  let buffer: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!inside) {
      const open = line.match(/^```([A-Za-z0-9_-]*)/);
      if (open) {
        inside = true;
        language = open[1] ?? "";
        buffer = [];
      }
      continue;
    }
    if (/^```\s*$/.test(line)) {
      inside = false;
      if (language === "json") {
        const parsed: unknown = JSON.parse(buffer.join("\n"));
        assert.ok(isRecord(parsed), "json fence must hold an object");
        fences.push(parsed);
      }
      continue;
    }
    buffer.push(line);
  }
  assert.equal(inside, false, "unterminated code fence in markdown");
  return fences;
}

/** Asserts the expected block truly exists: exactly one fence matches. */
function findUniqueFence(
  fences: Array<Record<string, unknown>>,
  predicate: (fence: Record<string, unknown>) => boolean,
  label: string,
): Record<string, unknown> {
  const matches = fences.filter(predicate);
  assert.equal(matches.length, 1, `expected exactly one ${label} json fence, found ${matches.length}`);
  return matches[0]!;
}

function selectionKey(expectation: SelectionExpectation): string {
  return expectation.source === "pi" ? `pi:${expectation.model}` : `external:${expectation.id}`;
}

function assertSelection(actual: unknown, expected: SelectionExpectation, label: string): void {
  const record = actual as Record<string, unknown>;
  assert.equal(record.source, expected.source, `${label}: source`);
  if (expected.source === "pi") {
    assert.equal(record.model, expected.model, `${label}: model`);
    assert.equal(record.thinkingLevel ?? undefined, expected.thinkingLevel, `${label}: thinkingLevel`);
  } else {
    assert.equal(record.id, expected.id, `${label}: id`);
  }
}

/** `model` exists only on the codex-cli, claude-cli, and pi-model variants. */
function reviewerModel(reviewer: DeciderConfig): string | undefined {
  return "model" in reviewer ? reviewer.model : undefined;
}

function assertResolvedReviewers(
  config: ReviewGateConfig,
  contract: ExampleContract,
  label: string,
): void {
  for (const layer of ["primary", "subtask"] as const) {
    const resolution = resolveReviewers(config, contract.scopedModels, layer);
    assert.deepEqual(resolution.unknownIds, [], `${label}: ${layer} unresolved reviewer selections`);
    assert.deepEqual(resolution.duplicateEnabledIds, [], `${label}: ${layer} duplicate selections`);
    assert.equal(
      resolution.reviewers.length,
      contract.reviewers.length,
      `${label}: ${layer} resolved reviewer count`,
    );
    resolution.reviewers.forEach((reviewer, index) => {
      const expected = contract.reviewers[index]!;
      assert.equal(reviewer.id, expected.id, `${label}: ${layer}[${index}] id`);
      assert.equal(reviewer.adapter, expected.adapter, `${label}: ${layer}[${index}] adapter`);
      if (expected.command !== undefined) {
        assert.equal(reviewer.command, expected.command, `${label}: ${layer}[${index}] command`);
      }
      if (expected.model !== undefined) {
        assert.equal(reviewerModel(reviewer), expected.model, `${label}: ${layer}[${index}] model`);
      }
      assert.equal(reviewer.timeoutMs, expected.timeoutMs, `${label}: ${layer}[${index}] timeoutMs`);
    });
  }
}

function assertSettings(config: ReviewGateConfig, settings: ExampleSettings | undefined, label: string): void {
  if (!settings) return;
  if (settings.enabled !== undefined) assert.equal(config.enabled, settings.enabled, `${label}: enabled`);
  if (settings.reviewerTimeoutMs !== undefined) {
    assert.equal(config.reviewerTimeoutMs, settings.reviewerTimeoutMs, `${label}: reviewerTimeoutMs`);
  }
  if (settings.executorTimeoutMs !== undefined) {
    assert.equal(config.executorTimeoutMs, settings.executorTimeoutMs, `${label}: executorTimeoutMs`);
  }
  if (settings.maxCorrectionCycles !== undefined) {
    assert.equal(config.maxCorrectionCycles, settings.maxCorrectionCycles, `${label}: maxCorrectionCycles`);
  }
  if (settings.implementationGuidanceAfterCorrectionAttempts !== undefined) {
    assert.equal(
      config.implementationGuidanceAfterCorrectionAttempts,
      settings.implementationGuidanceAfterCorrectionAttempts,
      `${label}: implementationGuidanceAfterCorrectionAttempts`,
    );
  }
  if (settings.maxPatchBytes !== undefined) assert.equal(config.maxPatchBytes, settings.maxPatchBytes, `${label}: maxPatchBytes`);
  if (settings.maxFileBytes !== undefined) assert.equal(config.maxFileBytes, settings.maxFileBytes, `${label}: maxFileBytes`);
  if (settings.maxSnapshotBytes !== undefined) {
    assert.equal(config.maxSnapshotBytes, settings.maxSnapshotBytes, `${label}: maxSnapshotBytes`);
  }
  if (settings.retainBundles !== undefined) assert.equal(config.retainBundles, settings.retainBundles, `${label}: retainBundles`);
}

function assertExecutionContract(config: ReviewGateConfig, execution: ExampleExecution, label: string): void {
  const resources = resolvedWorkerResources(config);
  assert.deepEqual(
    resources.map((resource) => resource.entryId),
    execution.resourceKeys,
    `${label}: worker resource keys`,
  );
  for (const expected of execution.resources) {
    const actual = resources.find((resource) => resource.entryId === expected.entryId);
    assert.ok(actual, `${label}: missing worker resource ${expected.entryId}`);
    assert.equal(actual.maxConcurrent, expected.maxConcurrent, `${label}: ${expected.entryId} maxConcurrent`);
    assertSelection(actual.selection, expected.selection, `${label}: ${expected.entryId} selection`);
  }
  for (const [kind, expectedRoute] of [
    ["execute", execution.executeRoute],
    ["research", execution.researchRoute],
  ] as const) {
    const route = resolvedWorkerRoute(config, kind);
    // No unknown-resource or research-capability omission: every configured
    // route entry resolves.
    assert.equal(
      route.length,
      (config.execution?.routes?.[kind] ?? []).length,
      `${label}: ${kind} route entries omitted`,
    );
    assert.deepEqual(
      route.map((entry) => entry.entryId),
      expectedRoute.map((entry) => entry.entryId),
      `${label}: ${kind} route order`,
    );
    route.forEach((entry, index) => {
      assertSelection(entry.selection, expectedRoute[index]!.selection, `${label}: ${kind}[${index}] selection`);
    });
  }
  if (execution.maxWorkers !== undefined) {
    assert.equal(config.execution?.maxWorkers, execution.maxWorkers, `${label}: maxWorkers`);
  }
}

test("examples directory ships exactly the eight contracted standalone configs", async () => {
  const entries = await readdir(join(ROOT, "examples"));
  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  assert.deepEqual(jsonFiles, Object.keys(CONTRACTS).sort());
});

for (const [name, contract] of Object.entries(CONTRACTS)) {
  test(`example ${name} strictly normalizes and resolves its intended reviewers`, async () => {
    const raw = await readFile(join(ROOT, "examples", name), "utf8");
    const config = normalizeConfig(JSON.parse(raw));

    const settings = effectiveReviewSettings(config);
    assert.deepEqual(settings.primaryReviewers, contract.primary, `${name}: primary selection`);
    assert.deepEqual(settings.subtaskReviewers, contract.subtask, `${name}: subtask selection`);
    for (const [layer, selections] of [
      ["primary", settings.primaryReviewers],
      ["subtask", settings.subtaskReviewers],
    ] as const) {
      assert.deepEqual(
        selections.map((selection) => reviewerSelectionKey(selection)),
        contract[layer].map(selectionKey),
        `${name}: ${layer} selection keys`,
      );
    }

    assertResolvedReviewers(config, contract, name);
    assertSettings(config, contract.settings, name);
    if (contract.execution) assertExecutionContract(config, contract.execution, name);
  });
}

/**
 * The README and getting-started minimal blocks are first-use onboarding
 * configs: they must be independently strictly valid AND resolve to a usable
 * Codex review role — not merely parse or recover to an empty config.
 */
async function assertMinimalCodexBlock(
  page: string,
  label: string,
  settings: ExampleSettings,
): Promise<void> {
  const markdown = await readFile(join(ROOT, page), "utf8");
  const fences = extractJsonFences(markdown);
  const block = findUniqueFence(
    fences,
    (fence) => isRecord(fence.externalAgents)
      && isRecord(fence.review)
      && Array.isArray((fence.review as Record<string, unknown>).primaryReviewers),
    `${label} minimal config`,
  );

  const config = normalizeConfig(block);
  const effective = effectiveReviewSettings(config);
  assert.deepEqual(effective.primaryReviewers, [codexExternal], `${label}: primary selection`);
  assert.deepEqual(effective.subtaskReviewers, [codexExternal], `${label}: subtask selection`);

  for (const layer of ["primary", "subtask"] as const) {
    const resolution = resolveReviewers(config, [], layer);
    assert.deepEqual(resolution.unknownIds, [], `${label}: ${layer} unresolved selections`);
    assert.equal(resolution.reviewers.length, 1, `${label}: ${layer} usable reviewer count`);
    const reviewer = resolution.reviewers[0]!;
    assert.equal(reviewer.id, "codex", `${label}: ${layer} reviewer id`);
    assert.equal(reviewer.adapter, "codex-cli", `${label}: ${layer} reviewer adapter`);
    assert.equal(reviewer.command, "codex", `${label}: ${layer} reviewer command`);
    assert.equal(reviewer.timeoutMs, 600000, `${label}: ${layer} reviewer timeout`);
  }

  assertSettings(config, settings, label);
}

test("README minimal config block is a runnable Codex review config", async () => {
  await assertMinimalCodexBlock("README.md", "README", {
    enabled: true,
    reviewerTimeoutMs: 600000,
    maxCorrectionCycles: 3,
    retainBundles: "on-failure",
  });
});

test("getting-started minimal config block is a runnable Codex review config", async () => {
  await assertMinimalCodexBlock("docs/getting-started.md", "getting-started", {
    enabled: true,
    reviewerTimeoutMs: 600000,
    maxCorrectionCycles: 3,
    retainBundles: "on-failure",
  });
});

test("configuration multi-reviewer example resolves both layers to codex and claude", async () => {
  const markdown = await readFile(join(ROOT, "docs/configuration.md"), "utf8");
  const fences = extractJsonFences(markdown);
  const block = findUniqueFence(
    fences,
    (fence) => isRecord(fence.externalAgents)
      && Object.keys(fence.externalAgents).includes("claude")
      && isRecord(fence.review)
      && Array.isArray((fence.review as Record<string, unknown>).primaryReviewers),
    "multi-reviewer example",
  );

  const config = normalizeConfig(block);
  const effective = effectiveReviewSettings(config);
  assert.deepEqual(effective.primaryReviewers, [codexExternal, claudeExternal], "multi-reviewer: primary selection");
  assert.deepEqual(effective.subtaskReviewers, [codexExternal, claudeExternal], "multi-reviewer: subtask selection");

  for (const layer of ["primary", "subtask"] as const) {
    const resolution = resolveReviewers(config, [], layer);
    assert.deepEqual(resolution.unknownIds, [], `multi-reviewer: ${layer} unresolved selections`);
    assert.deepEqual(
      resolution.reviewers.map((reviewer) => reviewer.id),
      ["codex", "claude"],
      `multi-reviewer: ${layer} order`,
    );
    assert.equal(resolution.reviewers[0]!.adapter, "codex-cli", "multi-reviewer: codex adapter");
    assert.equal(resolution.reviewers[0]!.command, "codex", "multi-reviewer: codex command");
    assert.equal(resolution.reviewers[0]!.timeoutMs, 600000, "multi-reviewer: codex timeout");
    assert.equal(resolution.reviewers[1]!.adapter, "claude-cli", "multi-reviewer: claude adapter");
    assert.equal(resolution.reviewers[1]!.command, "claude", "multi-reviewer: claude command");
    assert.equal(resolution.reviewers[1]!.timeoutMs, 600000, "multi-reviewer: claude timeout");
  }

  assertSettings(config, {
    enabled: true,
    maxCorrectionCycles: 3,
    implementationGuidanceAfterCorrectionAttempts: 1,
    retainBundles: "on-failure",
  }, "multi-reviewer");
});

test("configuration legacy activeReviewers fragment normalizes and imports into both layers", async () => {
  const markdown = await readFile(join(ROOT, "docs/configuration.md"), "utf8");
  const fences = extractJsonFences(markdown);
  // Selection-layer fragment: its only top-level key is `review` and it
  // carries the legacy single set. Its external reference assumes a catalog
  // entry the fragment does not define, so this asserts normalization and
  // the documented both-layer import — not full resolution.
  const block = findUniqueFence(
    fences,
    (fence) => Object.keys(fence).length === 1
      && isRecord(fence.review)
      && Array.isArray((fence.review as Record<string, unknown>).activeReviewers),
    "legacy activeReviewers fragment",
  );

  const config = normalizeConfig(block);
  const effective = effectiveReviewSettings(config);
  const imported: SelectionExpectation[] = [
    { source: "pi", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
    { source: "external", id: "codex-sol" },
  ];
  assert.deepEqual(effective.primaryReviewers, imported, "legacy fragment: primary import");
  assert.deepEqual(effective.subtaskReviewers, imported, "legacy fragment: subtask import");
});

test("configuration scheduledTasks fragment is illustrative and needs its documented worker context", async () => {
  const markdown = await readFile(join(ROOT, SCHEDULED_FRAGMENT_PAGE), "utf8");
  const fences = extractJsonFences(markdown);
  const fragment = findUniqueFence(
    fences,
    (fence) => Object.keys(fence).length === 1 && isRecord(fence.scheduledTasks),
    "scheduledTasks fragment",
  );

  // The documented fragment alone is not a runnable config: its pinned
  // worker reference does not resolve against an empty catalog.
  assert.throws(
    () => normalizeConfig(fragment),
    /references unknown worker resource local-research/,
    "bare scheduledTasks fragment must fail strict normalization",
  );

  // Test-context wrap (not shipped behavior): the minimal production-supported
  // research-capable context the docs say the fragment assumes — a Pi-model
  // `local-research` worker resource plus a usable research route.
  const wrapped: Record<string, unknown> = {
    ...fragment,
    execution: {
      workerResources: {
        "local-research": { selection: { source: "pi", model: "ollama/glm-5.2" }, maxConcurrent: 1 },
      },
      routes: { research: [{ resourceId: "local-research" }] },
    },
  };
  const config = normalizeConfig(wrapped);

  const tasks = config.scheduledTasks!;
  assert.deepEqual(Object.keys(tasks).sort(), ["task-nightly", "task-research"], "fragment: entry keys");
  assert.equal(tasks["task-nightly"]!.kind, "execute", "fragment: nightly kind");
  assert.equal(tasks["task-nightly"]!.workspace, "/work/pi-review-gate", "fragment: nightly workspace");
  assert.equal(tasks["task-research"]!.kind, "research", "fragment: research kind");
  assert.equal(tasks["task-research"]!.workerResourceId, "local-research", "fragment: pinned worker");
  assert.deepEqual(tasks["task-research"]!.review, { mode: "off" }, "fragment: review override");

  const route = resolvedWorkerRoute(config, "research");
  assert.deepEqual(
    route.map((entry) => entry.entryId),
    ["local-research"],
    "fragment context: research route resolves",
  );
});

test("configuration web fields fragment is a valid partial field reference", async () => {
  const markdown = await readFile(join(ROOT, "docs/configuration.md"), "utf8");
  const fences = extractJsonFences(markdown);
  const block = findUniqueFence(
    fences,
    (fence) => Object.keys(fence).length === 1 && isRecord(fence.web),
    "web fields fragment",
  );

  // Honestly partial: only the web subtree is shown, and it normalizes on its
  // own against production defaults.
  const config = normalizeConfig(block);
  assert.equal(config.web!.browserInteractionApproval, "ask", "web fragment: approval policy");
  assert.equal(config.web!.fetch.maxDownloadBytes, 52428800, "web fragment: max download bytes");
});
