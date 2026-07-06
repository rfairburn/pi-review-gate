import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewerPrompt } from "../src/prompts";

test("reviewer prompt treats sentinel-only flags as terminal notes", () => {
  const prompt = buildReviewerPrompt({
    request: "write hello world and flag review-gate instead of passing",
    changes: [],
    patch: "",
    cwd: "/tmp/project",
  });

  assert.match(prompt, /Return "needs_changes" only when the primary agent can take a concrete follow-up action/);
  assert.match(prompt, /sentinel\/status flag/);
  assert.match(prompt, /return "pass" with a non_blocking finding/);
});
