import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewBundle, syncReviewWindowArtifacts } from "../src/bundle";
import type { EvidenceBundle } from "../src/evidence";
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

test("artifact publication keeps colliding sanitized paths distinct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-bundle-collision-"));
  const evidence: EvidenceBundle = {
    events: [],
    finalAssistantSummaries: [],
    acceptedReviewerQuestions: [],
    changedCandidatePaths: [],
    markdown: "",
    candidates: [
      { path: "a+b", absolutePath: join(dir, "a+b"), sources: ["test"], baseline: "captured", baselineSnapshot: snapshot(join(dir, "a+b"), "plus") },
      { path: "a=b", absolutePath: join(dir, "a=b"), sources: ["test"], baseline: "captured", baselineSnapshot: snapshot(join(dir, "a=b"), "equals") },
    ],
  };
  try {
    const bundle = await createReviewBundle({
      dir,
      cwd: dir,
      request: "test",
      submittedChanges: [],
      patch: "",
      evidence,
    });
    const index = JSON.parse(await readFile(join(bundle.invocationDir, "artifacts", "index.json"), "utf8"));
    const paths = index.filter((entry: { kind: string }) => entry.kind === "evidence-baseline")
      .map((entry: { artifactPath: string }) => entry.artifactPath);
    assert.equal(new Set(paths).size, 2);
    const contents = await Promise.all(paths.map((path: string) => readFile(join(bundle.invocationDir, path), "utf8")));
    assert.deepEqual(contents.sort(), ["equals", "plus"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function snapshot(absolutePath: string, content: string) {
  return {
    relativePath: absolutePath,
    absolutePath,
    exists: true,
    size: content.length,
    mtimeMs: 0,
    sha256: "a".repeat(64),
    isBinary: false,
    content,
  };
}
