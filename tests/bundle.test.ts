import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncReviewWindowArtifacts } from "../src/bundle";
import type { ReviewExchangeContext } from "../src/state";

test("completed exchange artifacts are not rewritten during later synchronization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-bundle-"));
  const exchange: ReviewExchangeContext = {
    sequence: 1,
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: "2026-08-04T00:01:00.000Z",
    workspaceChanges: [],
    sideEffectChanges: [],
    workspacePatch: "first patch",
    sideEffectPatch: "",
    evidenceEvents: [],
    assistantSummaries: ["first summary"],
    userRequests: [{ sequence: 1, phase: "initial", text: "first request" }],
  };

  try {
    await syncReviewWindowArtifacts({ dir, cwd: dir, currentReviewSequence: 1, exchanges: [exchange] });
    const exchangeDir = join(dir, "exchanges", "0001");
    await access(join(exchangeDir, ".complete"));

    exchange.workspacePatch = "replacement patch";
    exchange.assistantSummaries = ["replacement summary"];
    await syncReviewWindowArtifacts({ dir, cwd: dir, currentReviewSequence: 2, exchanges: [exchange] });

    assert.equal(await readFile(join(exchangeDir, "submitted.patch"), "utf8"), "first patch");
    assert.equal(await readFile(join(exchangeDir, "assistant-summary.md"), "utf8"), "first summary");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
