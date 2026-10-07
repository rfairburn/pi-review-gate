import assert from "node:assert/strict";
import test from "node:test";
import { nativeFormFieldIsEmpty } from "./helpers/session-host-native-main-harness";

// Pure fixture-observation predicates only; no SDK, PTY or native runtime proof.
function frame(marker: "> Workspace:" | "> New name:", value: string): string {
  const roster = "  sibling                       │";
  const padding = " ".repeat(marker.length + 1);
  return [
    "Session host",
    `${roster}${marker} ───────────────`,
    `${roster}${padding}${value.padEnd(15)}`,
    `${roster}${padding}───────────────`,
    `${roster}enter submit | escape cancel`,
  ].join("\n");
}

test("native form witness observes empty Editor content below the top border", () => {
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", ""), "> Workspace:"), true);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", ""), "> New name:"), true);
});

test("native form witness rejects retained drafts and wrong field kinds", () => {
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", "/retained/path"), "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", "old caption"), "> New name:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", ""), "> Workspace:"), false);
});

test("native form witness rejects missing borders/content rather than assuming empty", () => {
  assert.equal(nativeFormFieldIsEmpty("> Workspace: ", "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", "").replace(/─/g, " "), "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty("Session host\n> Workspace: ─────\n", "> Workspace:"), false);
});
