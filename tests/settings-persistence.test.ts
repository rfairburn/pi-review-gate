import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistReviewSettings, type ReviewSettingsSelection } from "../src/settings/persistence";

const selection: ReviewSettingsSelection = {
  activeExecutor: null,
  activeReviewers: [],
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  retainBundles: "on-failure",
  maxWorkers: 2,
  parallelEnabled: false,
};

test("persistReviewSettings preserves restrictive configuration permissions", async (t) => {
  if (process.platform === "win32") t.skip("POSIX modes are required");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-mode-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    await chmod(configPath, 0o600);
    await persistReviewSettings(configPath, selection);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, true);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
    await chmod(configPath, 0o644);
    await persistReviewSettings(configPath, selection);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
