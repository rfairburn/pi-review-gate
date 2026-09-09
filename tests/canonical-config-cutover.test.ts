import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  resolveReviewers,
  resolvedWorkerResources,
} from "../src/config";

const CANONICAL_REVIEW = {
  enabled: true,
  externalAgents: [
    {
      id: "reviewer",
      adapter: "generic-cli",
      command: "node",
      args: [],
      review: {},
    },
  ],
  review: { activeReviewers: [{ source: "external", id: "reviewer" }] },
};

const CANONICAL_EXECUTION = {
  enabled: true,
  execution: {
    workerResources: [
      { resourceId: "primary", selection: { source: "external", id: "exec" }, maxConcurrent: 1 },
      { resourceId: "spare", selection: { source: "external", id: "exec2" }, maxConcurrent: 1 },
    ],
  },
  externalAgents: [
    {
      id: "exec",
      adapter: "run-as-binary",
      command: "node",
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    },
    {
      id: "exec2",
      adapter: "run-as-binary",
      command: "node",
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    },
  ],
};

// ── old-only reviewer records are rejected with actionable diagnostics ──────

test("old-only decider field is rejected with an actionable diagnostic", () => {
  assert.throws(
    () => normalizeConfig({ ...CANONICAL_REVIEW, review: undefined, decider: { id: "d", adapter: "generic-cli", command: "node" } }),
    (error: Error) => /unsupported legacy reviewer configuration.*decider.*no longer accepted.*review\.activeReviewers/.test(error.message),
  );
});

test("old-only reviewers field is rejected with an actionable diagnostic", () => {
  assert.throws(
    () => normalizeConfig({ ...CANONICAL_REVIEW, review: undefined, reviewers: [{ id: "d", adapter: "generic-cli", command: "node" }] }),
    (error: Error) => /unsupported legacy reviewer configuration.*reviewers.*no longer accepted.*review\.activeReviewers/.test(error.message),
  );
});

test("old-only enabledReviewerIds field is rejected with an actionable diagnostic", () => {
  assert.throws(
    () => normalizeConfig({ ...CANONICAL_REVIEW, review: undefined, enabledReviewerIds: ["d"] }),
    (error: Error) => /unsupported legacy reviewer configuration.*enabledReviewerIds.*no longer accepted.*review\.activeReviewers/.test(error.message),
  );
});

// ── old-only execution records are rejected with actionable diagnostics ─────

test("old-only execution.activeExecutor field is rejected with an actionable diagnostic", () => {
  assert.throws(
    () => normalizeConfig({
      ...CANONICAL_EXECUTION,
      execution: { ...CANONICAL_EXECUTION.execution, workerResources: undefined, activeExecutor: { source: "external", id: "exec" } },
    }),
    (error: Error) => /unsupported legacy executor configuration.*activeExecutor.*no longer accepted.*workerResources/.test(error.message),
  );
});

test("old-only execution.executorPool field is rejected with an actionable diagnostic", () => {
  assert.throws(
    () => normalizeConfig({
      ...CANONICAL_EXECUTION,
      execution: { ...CANONICAL_EXECUTION.execution, workerResources: undefined, executorPool: [] },
    }),
    (error: Error) => /unsupported legacy executor configuration.*executorPool.*no longer accepted.*workerResources/.test(error.message),
  );
});

test("old-only execution.externalExecutors field is rejected with an actionable diagnostic", () => {
  assert.throws(
    () => normalizeConfig({
      ...CANONICAL_EXECUTION,
      execution: { ...CANONICAL_EXECUTION.execution, workerResources: undefined, externalExecutors: [] },
    }),
    (error: Error) => /unsupported legacy executor configuration.*externalExecutors.*no longer accepted.*workerResources/.test(error.message),
  );
});

// ── doubled records: the canonical data alone is authoritative ──────────────

test("doubled reviewer record ignores malformed obsolete copies and normalizes without legacy fields", () => {
  const config = normalizeConfig({
    ...CANONICAL_REVIEW,
    decider: 42,
    reviewers: "stale",
    enabledReviewerIds: [null],
  });

  assert.ok(!("decider" in config), "normalized config must not carry decider");
  assert.ok(!("reviewers" in config), "normalized config must not carry reviewers");
  assert.ok(!("enabledReviewerIds" in config), "normalized config must not carry enabledReviewerIds");
  const resolution = resolveReviewers(config);
  assert.deepEqual(resolution.reviewers.map((reviewer) => reviewer.id), ["reviewer"]);
  assert.ok(config.review!.activeReviewers!.length > 0, "canonical selection is preserved");
});

test("doubled execution record ignores stale obsolete copies and normalizes without legacy fields", () => {
  const config = normalizeConfig({
    ...CANONICAL_EXECUTION,
    execution: {
      ...CANONICAL_EXECUTION.execution,
      activeExecutor: { source: "external", id: "obsolete" },
      executorPool: [{ entryId: "obsolete" }],
      externalExecutors: [{ id: "obsolete", adapter: "codex-cli" }],
    },
  });

  const execution = config.execution! as Record<string, unknown>;
  assert.equal(execution.activeExecutor, undefined, "normalized execution must not carry activeExecutor");
  assert.equal(execution.executorPool, undefined, "normalized execution must not carry executorPool");
  assert.equal(execution.externalExecutors, undefined, "normalized execution must not carry externalExecutors");
  assert.deepEqual(
    resolvedWorkerResources(config).map((entry) => entry.entryId),
    ["primary", "spare"],
  );
});

// ── genuinely current canonical configs behave as before ────────────────────

test("canonical empty and optional configuration normalizes to defaults without rejection", () => {
  const config = normalizeConfig({});
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(config.review, undefined);
  assert.equal(config.execution, undefined);
});

test("canonical optional execution fields normalize without legacy requirements", () => {
  const config = normalizeConfig({ execution: {} });
  assert.equal(config.execution!.workerResources, undefined);
  assert.equal(config.execution!.routes, undefined);
  assert.deepEqual(resolvedWorkerResources(config), []);
});

test("canonical review selection with no active reviewers normalizes as before", () => {
  const config = normalizeConfig({ review: { activeReviewers: [] } });
  assert.deepEqual(config.review!.activeReviewers, []);
});