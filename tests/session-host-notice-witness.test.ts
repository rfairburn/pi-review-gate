/**
 * Pure no-IO regressions for the sidebar refusal-notice witness. These tests
 * do not start a PTY, SDK, child process, command, install, or home/Git read:
 * they exercise the witness against synthetic frames only, so they add no
 * runtime or native claim.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SIDEBAR_COLUMNS } from "./helpers/session-host-native-roster-witness";
import { sidebarNoticeRows } from "./helpers/session-host-notice-witness";

const MESSAGE = "Session not removed; it may be live, unconfirmed, or no longer available.";

/** The actual 32-column word wrap of the complete notice. */
const WRAPPED = [
  "! Session not removed; it may be",
  "live, unconfirmed, or no longer",
  "available.",
];

/** A roster body with no notice rows, like the real sidebar render. */
const ROSTER = [
  " Sessions (1) ",
  "Native native-1",
  "> exited",
  "  background unknown",
  "    Waiting for input",
  "",
  "  Saved conversations",
  "  New session",
  "  Quit host",
];

/** Compose a synthetic host frame exactly like the real compositor. */
function compose(sidebar: readonly string[], right: readonly string[] = ["native pane"]): string {
  const rows = Math.max(sidebar.length, right.length);
  return ["Session host", ...Array.from({ length: rows }, (_, index) =>
    `${(sidebar[index] ?? "").padEnd(SIDEBAR_COLUMNS)}│${right[index] ?? ""}`)].join("\n");
}

test("the witness admits the actual complete wrapped notice in the sidebar columns", () => {
  const frame = compose([...ROSTER, ...WRAPPED, "", "F8 toggle | enter open"]);
  assert.deepEqual(sidebarNoticeRows(frame, MESSAGE), WRAPPED);
});

test("a clipped notice missing its final row is refused", () => {
  const frame = compose([...ROSTER, WRAPPED[0]!, WRAPPED[1]!, "", "F8 toggle | enter open"]);
  assert.equal(sidebarNoticeRows(frame, MESSAGE), undefined);
});

test("a notice with a missing word is refused", () => {
  const dropped = [
    "! Session not removed; it may be live,",
    "or no longer available.",
  ];
  const frame = compose([...ROSTER, ...dropped, "", "F8 toggle | enter open"]);
  assert.equal(sidebarNoticeRows(frame, MESSAGE), undefined);
});

test("a notice with an altered word is refused", () => {
  const altered = [
    "! Session not kept; it may be live,",
    "unconfirmed, or no longer available.",
  ];
  const frame = compose([...ROSTER, ...altered, "", "F8 toggle | enter open"]);
  assert.equal(sidebarNoticeRows(frame, MESSAGE), undefined);
});

test("a notice without its final punctuation is refused", () => {
  const unpunctuated = [
    "! Session not removed; it may be live,",
    "unconfirmed, or no longer available",
  ];
  const frame = compose([...ROSTER, ...unpunctuated, "", "F8 toggle | enter open"]);
  assert.equal(sidebarNoticeRows(frame, MESSAGE), undefined);
});

test("native-pane-only text cannot stand in for the sidebar notice", () => {
  const frame = compose(
    [...ROSTER, "", ""],
    ["! Session not removed; it may be live,", "unconfirmed, or no longer available."],
  );
  assert.equal(sidebarNoticeRows(frame, MESSAGE), undefined);
});

test("a notice row split across the divider is refused when the sidebar half is incomplete", () => {
  // The sidebar columns hold only the first wrap; the remainder sits in the
  // native pane and must not complete the message.
  const frame = compose(
    [...ROSTER, "! Session not removed; it may be", ""],
    ["live, unconfirmed, or no longer available."],
  );
  assert.equal(sidebarNoticeRows(frame, MESSAGE), undefined);
});
