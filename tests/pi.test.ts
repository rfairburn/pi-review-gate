import assert from "node:assert/strict";
import test from "node:test";
import { extractInputSource, extractInputText } from "../src/pi";
import { createState, rememberUserRequest } from "../src/state";

test("extractInputSource reads pi input event source", () => {
  assert.equal(
    extractInputSource([{ type: "input", text: "fix it", source: "extension" }]),
    "extension",
  );
});

test("extension follow-up input should not reset correction cycle state", () => {
  const state = createState();
  rememberUserRequest(state, "original user request");
  state.correctionCycles = 1;

  const event = {
    type: "input",
    text: "Review found blocking issues in your last changes.",
    source: "extension",
  };

  if (extractInputSource([event]) !== "extension") {
    rememberUserRequest(state, extractInputText([event]));
  }

  assert.equal(state.latestRequest, "original user request");
  assert.equal(state.correctionCycles, 1);
});
