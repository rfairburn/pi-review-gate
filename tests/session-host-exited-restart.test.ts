import assert from "node:assert/strict";
import test from "node:test";
import { chooseExitedRestart } from "../src/session-host/exited-restart";
import type { SavedSessionRow } from "../src/session-host/saved-sessions";

const saved = (id: string): SavedSessionRow => ({ id, file: `/native/sessions/project/${id}.jsonl`, cwd: "/saved-workspace", caption: "canonical", projectDir: "/native/sessions/project" });
const safeEmpty = () => ({ rows: [] as SavedSessionRow[], issues: [], issueCount: 0 });

test("pure exited restart chooses current binding rather than original or newest saved conversation", () => {
  const current = saved("current");
  const catalog = { ...safeEmpty(), rows: [saved("original"), saved("newest"), current] };
  const result = chooseExitedRestart({ sessionId: "current", persistence: "saved" }, "/launch-workspace", catalog);
  assert.equal(result.kind, "saved");
  if (result.kind === "saved") assert.equal(result.row, current);
});

test("pure known never-saved binding starts fresh in exactly the same owned workspace", () => {
  assert.deepEqual(chooseExitedRestart({ sessionId: "current", persistence: "unsaved" }, "/same-workspace", safeEmpty()), { kind: "fresh", cwd: "/same-workspace" });
});

test("pure newly saved catalog row overrides an earlier planned-file absence", () => {
  const row = saved("current");
  assert.deepEqual(chooseExitedRestart({ sessionId: "current", persistence: "unsaved" }, "/workspace", { ...safeEmpty(), rows: [row] }), { kind: "saved", row });
});

test("pure missing known-saved data never silently becomes a fresh conversation", () => {
  assert.deepEqual(chooseExitedRestart({ sessionId: "current", persistence: "saved" }, "/workspace", safeEmpty()), { kind: "refused", reason: "missing-saved" });
});

test("pure unknown binding or persistence cannot establish never-saved fallback", () => {
  for (const binding of [undefined, { sessionId: "current", persistence: "unknown" as const }]) {
    assert.deepEqual(chooseExitedRestart(binding, "/workspace", safeEmpty()), { kind: "refused", reason: "unknown-binding" });
  }
});

test("pure malformed/unreadable/unsafe catalog issues prevent fresh fallback", () => {
  const binding = { sessionId: "current", persistence: "unsaved" as const };
  for (const catalog of [{ ...safeEmpty(), issueCount: 1 }, { ...safeEmpty(), issues: [{ projectDir: "/unsafe", reason: "unreadable" }] }]) {
    assert.deepEqual(chooseExitedRestart(binding, "/workspace", catalog), { kind: "refused", reason: "unsafe-absence" });
  }
});

test("pure ambiguous current IDs are refused instead of picking an arbitrary file", () => {
  assert.deepEqual(chooseExitedRestart({ sessionId: "current", persistence: "saved" }, "/workspace", { ...safeEmpty(), rows: [saved("current"), saved("current")] }), { kind: "refused", reason: "ambiguous-binding" });
});
