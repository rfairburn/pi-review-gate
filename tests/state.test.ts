import assert from "node:assert/strict";
import test from "node:test";
import { createState, resetRunEvidence } from "../src/state";

test("resetRunEvidence clears per-run evidence without resetting correction cycles", () => {
  const state = createState();
  state.latestRequest = "original";
  state.correctionCycles = 1;
  state.touchedPaths.add("a.txt");
  state.evidence.events.push({
    sequence: 1,
    phase: "tool_call",
    toolName: "write",
    summary: "write a.txt",
    candidatePaths: ["a.txt"],
    riskSignals: [],
  });

  resetRunEvidence(state);

  assert.equal(state.latestRequest, "original");
  assert.equal(state.correctionCycles, 1);
  assert.equal(state.touchedPaths.size, 0);
  assert.equal(state.evidence.events.length, 0);
});
