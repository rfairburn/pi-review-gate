import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, recoverConfig } from "../src/config";

const resources = [{ resourceId: "worker", selection: { source: "pi", model: "test/model", thinkingLevel: "low" }, maxConcurrent: 2 }];
const reviewers = [{ source: "pi", model: "test/reviewer", thinkingLevel: "high" }];
const configured = {
  review: { activeReviewers: reviewers },
  execution: { workerResources: resources, routes: { execute: [{ resourceId: "worker" }] } },
};

test("valid configuration uses the same strict normalization without warnings", () => {
  assert.deepEqual(recoverConfig(configured), { config: normalizeConfig(configured) });
});

test("invalid scalar and nested web value preserve configured reviewers, workers and sibling values", () => {
  const input = {
    ...configured,
    maxPatchBytes: -1,
    web: { enabled: false, search: { timeoutMs: "bad", maxResults: 7 }, fetch: { timeoutMs: 4567 } },
  };
  const before = JSON.stringify(input);
  const { config, warnings } = recoverConfig(input);
  assert.deepEqual(config.execution, normalizeConfig(configured).execution);
  assert.deepEqual(config.review?.activeReviewers, reviewers);
  assert.equal(config.maxPatchBytes, DEFAULT_CONFIG.maxPatchBytes);
  assert.equal(config.web?.enabled, false);
  assert.equal(config.web?.search.timeoutMs, DEFAULT_CONFIG.web!.search.timeoutMs);
  assert.equal(config.web?.search.maxResults, 7);
  assert.equal(config.web?.fetch.timeoutMs, 4567);
  assert.deepEqual(warnings, ["maxPatchBytes is invalid or unsupported; using its default.", "web.search.timeoutMs is invalid or unsupported; using its default."]);
  assert.equal(JSON.stringify(input), before);
});

test("invalid execution setting preserves resources and routes regardless of input key order", () => {
  const { config } = recoverConfig({ execution: {
    routes: configured.execution.routes,
    maxWorkers: -1,
    workerResources: resources,
    deferredPiTools: false,
  } });
  assert.deepEqual(config.execution?.workerResources, resources);
  assert.deepEqual(config.execution?.routes, normalizeConfig(configured).execution?.routes);
  assert.equal(config.execution?.deferredPiTools, false);
  assert.equal(config.execution?.maxWorkers, undefined);
});

test("invalid collection entries do not discard healthy siblings or invent replacement selections", () => {
  const { config, warnings } = recoverConfig({
    review: { activeReviewers: [...reviewers, { source: "pi", model: "other", thinkingLevel: "invalid" }] },
    execution: {
      routes: { execute: [{ resourceId: "missing" }, { resourceId: "worker" }] },
      workerResources: [null, ...resources],
    },
  });
  assert.deepEqual(config.review?.activeReviewers, reviewers);
  assert.deepEqual(config.execution?.workerResources, resources);
  assert.deepEqual(config.execution?.routes?.execute, [{ resourceId: "worker", thinkingLevel: undefined }]);
  assert.equal(warnings?.length, 3);
});

test("recovery preserves valid coupled delay bounds and ignores obsolete copies when canonical data exists", () => {
  const { config, warnings } = recoverConfig({
    ...configured,
    decider: { secret: "must-not-appear" },
    execution: { ...configured.execution, retryPolicy: { baseDelayMs: 1, maxDelayMs: 2, jitter: "bad" } },
  });
  assert.equal(config.execution?.retryPolicy?.baseDelayMs, 1);
  assert.equal(config.execution?.retryPolicy?.maxDelayMs, 2);
  assert.equal(config.execution?.retryPolicy?.jitter, true);
  assert.deepEqual(config.review?.activeReviewers, reviewers);
  assert.equal(warnings?.length, 1);
  assert.ok(!JSON.stringify(warnings).includes("must-not-appear"));
  assert.ok(!("decider" in config));
});

test("file loading recovers without overwriting settings and keeps the explicit kill switch", () => {
  const dir = mkdtempSync(join(tmpdir(), "config-recovery-"));
  const path = join(dir, "config.json");
  try {
    for (const text of [JSON.stringify({ ...configured, maxFileBytes: -1 }), "{broken", "null"]) {
      writeFileSync(path, text);
      const loaded = loadConfig({ PI_REVIEW_GATE_CONFIG: path });
      assert.equal(loaded.path, path);
      assert.ok(loaded.warnings?.length);
      assert.equal(loaded.globallyDisabled, undefined);
      assert.equal(loaded.config.web?.enabled, true);
      assert.equal(readFileSync(path, "utf8"), text);
      if (text.startsWith('{"')) assert.deepEqual(loaded.config.execution?.workerResources, resources);
    }
    assert.equal(loadConfig({ PI_REVIEW_GATE_CONFIG: path, PI_REVIEW_GATE_DISABLED: "1" }).globallyDisabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
