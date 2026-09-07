import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistReviewSettings, persistSubtasksViewPreference, updateReviewGateConfig, type ReviewSettingsSelection } from "../src/settings/persistence";

const selection: ReviewSettingsSelection = {
  executorPool: [],
  activeReviewers: [],
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  retainBundles: "on-failure",
  maxWorkers: 2,
  retryPolicy: {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
    jitter: true,
    maxSameIncidentRepeats: 2,
  },
  subtaskNotifications: "quiet",
  deferredPiTools: true,
  subtasksViewExpanded: false,
};

test("browser approval persistence round-trips every mode and preserves unrelated Web settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-browser-approval-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ web: { enabled: false, future: "keep", fetch: { timeoutMs: 12345 } } }));
    for (const browserInteractionApproval of ["ask", "automatically-accept", "automatically-deny"] as const) {
      const normalized = await persistReviewSettings(configPath, { ...selection, browserInteractionApproval });
      assert.equal(normalized.web!.browserInteractionApproval, browserInteractionApproval);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(saved.web, { enabled: false, future: "keep", fetch: { timeoutMs: 12345 }, browserInteractionApproval });
      const unchanged = await persistReviewSettings(configPath, { ...selection, webMaxDownloadBytes: 1024 });
      assert.equal(unchanged.web!.browserInteractionApproval, browserInteractionApproval);
      await updateReviewGateConfig(configPath, (config) => { (config.web as any).fetch = { timeoutMs: 12345 }; });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle expiry persists safely and omitted or invalid updates preserve existing settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-idle-expiry-"));
  const configPath = join(dir, "config.json");
  try {
    const web = { enabled: false, future: { keep: true }, browserInteractionApproval: "automatically-deny", search: { maxResults: 7 }, fetch: { timeoutMs: 12345 } };
    await writeFile(configPath, JSON.stringify({ futureRoot: true, web }));
    const normalized = await persistReviewSettings(configPath, { ...selection, browserIdleExpiryMinutes: 42 });
    assert.equal(normalized.web!.browserIdleExpiryMinutes, 42);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.futureRoot, true);
    assert.deepEqual(saved.web, { ...web, browserIdleExpiryMinutes: 42 });
    assert.equal((await persistReviewSettings(configPath, selection)).web!.browserIdleExpiryMinutes, 42);
    const before = await readFile(configPath, "utf8");
    for (const minutes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(persistReviewSettings(configPath, { ...selection, browserIdleExpiryMinutes: minutes }), /web.browserIdleExpiryMinutes/);
      assert.equal(await readFile(configPath, "utf8"), before);
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistReviewSettings preserves restrictive configuration permissions", async (t) => {
  if (process.platform === "win32") t.skip("POSIX modes are required");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-mode-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    await chmod(configPath, 0o600);
    await persistReviewSettings(configPath, selection);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const firstSaved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(firstSaved.enabled, true);
    assert.equal(firstSaved.execution.deferredPiTools, true);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
    await chmod(configPath, 0o644);
    await persistReviewSettings(configPath, selection);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subtasks view preference persists globally without replacing unrelated settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-subtasks-view-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true,"customFutureKey":{"keep":true}}\n', "utf8");
    const expanded = await persistSubtasksViewPreference(configPath, true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.ui.subtasksViewExpanded, true);
    assert.deepEqual(saved.customFutureKey, { keep: true });
    assert.equal(expanded.ui?.subtasksViewExpanded, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("global config updates serialize without losing unrelated concurrent changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-config-update-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    await Promise.all([
      updateReviewGateConfig(configPath, (config) => { config.firstUpdate = true; }),
      updateReviewGateConfig(configPath, (config) => { config.secondUpdate = true; }),
    ]);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.firstUpdate, true);
    assert.equal(saved.secondUpdate, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
