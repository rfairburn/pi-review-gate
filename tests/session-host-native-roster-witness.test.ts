/**
 * Pure source witnesses for the shared rendered-roster parser. These tests do
 * not start a PTY, SDK, child process, command, install, or home/Git read: they
 * exercise the parser against synthetic frames only, so they add no runtime
 * or native claim.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";

import {
  NATIVE_PANE_START,
  ROSTER_ACTIONS,
  SIDEBAR_COLUMNS,
  frameHeader,
  frameHeaderMatches,
  isSidebarFocusedFrame,
  parseRosterFrame,
  renderedTitleMatches,
  rosterCards,
  selectedRosterCard,
  selectedRosterEntry,
  sidebarPaneLines,
  sidebarRosterHidden,
} from "./helpers/session-host-native-roster-witness";

const HEADER = (count: number): string => ` Sessions (${count}) `;
const ACTIONS = ["  Saved conversations", "  New session", "  Quit host"];

/** Compose a synthetic host frame exactly like the real compositor. */
function compose(sidebar: readonly string[], right: readonly string[] = ["native pane"]): string {
  const rows = Math.max(sidebar.length, right.length);
  return ["Session host", ...Array.from({ length: rows }, (_, index) =>
    `${(sidebar[index] ?? "").padEnd(SIDEBAR_COLUMNS)}│${right[index] ?? ""}`)].join("\n");
}

/** Compose with terminal-cell padding (wide/combining safe), like the real compositor. */
function composeCells(sidebar: readonly string[], right: readonly string[] = ["native pane"]): string {
  const rows = Math.max(sidebar.length, right.length);
  return ["Session host", ...Array.from({ length: rows }, (_, index) => {
    const left = sidebar[index] ?? "";
    return `${left}${" ".repeat(Math.max(0, SIDEBAR_COLUMNS - visibleWidth(left)))}│${right[index] ?? ""}`;
  })].join("\n");
}
function pane(sidebar: readonly string[]): string {
  return compose(sidebar).split("\n").slice(1).join("\n");
}

const IDLE_STATUS = "  agent idle | input none";
const SELECTED_IDLE_STATUS = "> agent idle | input none";
const BACKGROUND = "  background unknown";

function expandedCard(title: string, status = IDLE_STATUS, activity: readonly string[] = ["", ""]): string[] {
  return [title, status, BACKGROUND, ...activity];
}
function collapsedCard(title: string, status = IDLE_STATUS): string[] {
  return [title, status, BACKGROUND];
}

test("the parser reads a complete expanded default card as title/status/background/activity", () => {
  const frame = compose([
    HEADER(1),
    ...expandedCard("Canonical title", "> agent running | input pending", ["    compiling", "    waiting"]),
    ...ACTIONS,
  ]);
  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.cards.length, 1);
  const card = parsed.cards[0]!;
  assert.equal(card.title, "Canonical title");
  assert.equal(card.rows, 5);
  assert.equal(card.selected, true);
  assert.equal(card.status, "agent running | input pending");
  assert.equal(card.background, "background unknown");
  assert.deepEqual(card.activity, ["compiling", "waiting"]);
  assert.equal(card.position, 0);
  assert.deepEqual(parsed.actions.map((entry) => entry.label), [...ROSTER_ACTIONS]);
  assert.deepEqual(parsed.actions.map((entry) => entry.position), [1, 2, 3]);
  // The title row never carries a marker, badge, or status text.
  assert.ok(!/[>[\]|]|agent|input|background|exited/.test(card.title), card.title);
});

test("the parser reads a collapsed card as exactly three rows and keeps the next card's extent", () => {
  const frame = compose([
    HEADER(2),
    ...collapsedCard("Short card"),
    ...expandedCard("Tall card"),
    ...ACTIONS,
  ]);
  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.cards.map((card) => [card.title, card.rows, card.position]), [
    ["Short card", 3, 0],
    ["Tall card", 5, 1],
  ]);
});

test("the parser correlates the selected marker on the status row, never the title row", () => {
  const frame = compose([
    HEADER(2),
    ...collapsedCard("First card"),
    ...expandedCard("Second card", SELECTED_IDLE_STATUS),
    ...ACTIONS,
  ]);
  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.cards[0]!.selected, false);
  assert.equal(parsed.cards[1]!.selected, true);
  assert.equal(selectedRosterEntry(frame)?.label, "Second card");
  assert.equal(selectedRosterCard(frame)?.title, "Second card");

  // An action can be the highlight too; it is never mistaken for a card.
  const actionSelected = compose([
    HEADER(2),
    ...collapsedCard("First card"),
    ...expandedCard("Second card"),
    "  Saved conversations",
    "> New session",
    "  Quit host",
  ]);
  assert.equal(selectedRosterEntry(actionSelected)?.label, "New session");
  assert.equal(selectedRosterCard(actionSelected), undefined);
});

test("canonical title text may begin with printable marker-like text without inventing selection", () => {
  for (const title of ["> canonical name", "  canonical name", "    canonical name"]) {
    const frame = compose([HEADER(1), ...expandedCard(title, IDLE_STATUS), ...ACTIONS]);
    assert.equal(parseRosterFrame(frame).complete, true);
    assert.equal(rosterCards(frame)[0]?.title, title);
    assert.equal(selectedRosterEntry(frame), undefined, "only the status row establishes selection");
  }
});

test("old inline title+badge cards are rejected, not silently accepted", () => {
  const frame = compose([
    HEADER(1),
    "  legacy-title [AGENT: running]",
    "  [exited (code 0)]",
    ...ACTIONS,
  ]);
  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.complete, false);
  assert.deepEqual(parsed.cards, []);
  assert.deepEqual(parsed.entries, []);
});

test("missing background, missing activity, and partial extents fail closed", () => {
  const missingBackground = compose([HEADER(1), "Title", IDLE_STATUS, ...ACTIONS]);
  assert.equal(parseRosterFrame(missingBackground).complete, false);
  assert.deepEqual(parseRosterFrame(missingBackground).cards, []);

  const truncatedExpanded = compose([HEADER(1), "Title", IDLE_STATUS, BACKGROUND, "    only-one-activity", ...ACTIONS]);
  assert.equal(parseRosterFrame(truncatedExpanded).complete, false);

  const backgroundIsStatus = compose([HEADER(1), "Title", IDLE_STATUS, IDLE_STATUS, ...ACTIONS]);
  assert.equal(parseRosterFrame(backgroundIsStatus).complete, false);
});

test("a partial roster, a header/count mismatch, and duplicate actions are all incomplete", () => {
  const partial = compose([HEADER(2), ...expandedCard("Only one card"), ...ACTIONS]);
  assert.equal(parseRosterFrame(partial).complete, false);

  const duplicateActions = compose([HEADER(1), ...expandedCard("Card"), ...ACTIONS, "  New session"]);
  assert.equal(parseRosterFrame(duplicateActions).complete, false);

  const missingAction = compose([HEADER(1), ...expandedCard("Card"), "  Saved conversations", "  New session"]);
  assert.equal(parseRosterFrame(missingAction).complete, false);

  const wrongOrder = compose([HEADER(1), ...expandedCard("Card"), "  New session", "  Saved conversations", "  Quit host"]);
  assert.equal(parseRosterFrame(wrongOrder).complete, false);

  const noHeader = compose(["not a roster header", ...expandedCard("Card"), ...ACTIONS]);
  assert.equal(parseRosterFrame(noHeader).complete, false);
  assert.equal(parseRosterFrame(noHeader).count, undefined);
});

test("only the actual sidebar columns are read; the right pane and outer header never match", () => {
  const frame = compose(
    [HEADER(1), ...expandedCard("Sidebar title"), ...ACTIONS],
    ["> Right pane caption", "Session host · Right pane · alive", "exited (code 0)"],
  );
  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.cards.map((card) => card.title), ["Sidebar title"]);
  assert.equal(frameHeader(frame), "Session host");
  assert.equal(frameHeaderMatches(frame, "Right pane caption"), false);
  // A right-pane marker alone (no complete sidebar roster) yields no card.
  const nativeOnly = compose(["  native content", "> Right pane caption", ...ACTIONS], ["> native selected row"]);
  assert.deepEqual(rosterCards(nativeOnly), []);
});

test("the wide sidebar boundary excludes the divider column and everything to its right", () => {
  const frame = compose([HEADER(0), ...ACTIONS]);
  const lines = sidebarPaneLines(frame);
  for (const line of lines) {
    assert.ok(Array.from(line).length <= SIDEBAR_COLUMNS, JSON.stringify(line));
    assert.ok(!line.includes("│"), JSON.stringify(line));
  }
  assert.equal(NATIVE_PANE_START, SIDEBAR_COLUMNS + 1);
  // The 33rd column of a composed row is the divider, never sidebar content.
  assert.equal(lines[1]!.length, SIDEBAR_COLUMNS);
});

test("the sidebar-only footer proves focus and a plain native pane does not", () => {
  const focused = compose([
    HEADER(1),
    ...expandedCard("Canonical title"),
    ...ACTIONS,
    "F8 toggle | enter open",
    "e edit name",
    "d stop/remove | esc hide",
    "q quit | space expand",
  ]);
  assert.equal(isSidebarFocusedFrame(focused), true);
  const nativeFocused = compose([
    HEADER(1),
    ...expandedCard("Canonical title"),
    ...ACTIONS,
    "F8 toggle | enter open",
    "esc hide | q quit",
  ]);
  assert.equal(isSidebarFocusedFrame(nativeFocused), false);
  // A card title claiming the footer text cannot fake sidebar focus.
  const fakedTitle = compose([HEADER(1), ...collapsedCard("e edit name q quit"), ...ACTIONS, "F8 toggle | esc hide"]);
  assert.equal(isSidebarFocusedFrame(fakedTitle), false);
});

test("sidebar focus requires every footer action, not a partially updated footer", () => {
  const roster = [HEADER(1), ...expandedCard("Canonical title"), ...ACTIONS];
  const hints = [
    "F8 toggle", "enter open", "e edit name",
    "d stop/remove", "esc hide", "q quit", "space expand",
  ];
  assert.equal(isSidebarFocusedFrame(compose([...roster, ...hints])), true);
  for (const missing of hints) {
    assert.equal(isSidebarFocusedFrame(compose([
      ...roster, ...hints.filter((hint) => hint !== missing),
    ])), false, `missing footer action: ${missing}`);
  }
  assert.equal(isSidebarFocusedFrame(compose([
    ...roster, "F8 toggle | enter open", "e edit name", "", "esc hide | q quit",
  ])), false, "new edit hint plus stale Main footer is not completed sidebar focus");
  assert.equal(isSidebarFocusedFrame(compose([
    HEADER(0), ...ACTIONS, ...hints.filter((hint) => hint !== "space expand"),
  ])), true, "an empty roster has no card expansion hint");
});

test("clipped canonical titles match only their own canonical title", () => {
  assert.equal(renderedTitleMatches("Canonical title", "Canonical title"), true);
  assert.equal(renderedTitleMatches("Canonical ti...", "Canonical title"), true);
  assert.equal(renderedTitleMatches("Canonical ti...", "Canonical other"), false);
  assert.equal(renderedTitleMatches("Other", "Canonical title"), false);
  assert.equal(renderedTitleMatches(undefined, "Canonical title"), false);
  const clippedTitle = `${"A".repeat(29)}...`;
  const clipped = compose([HEADER(1), ...collapsedCard(clippedTitle), ...ACTIONS]);
  assert.equal(rosterCards(clipped)[0]?.title, clippedTitle);
  assert.equal(renderedTitleMatches(rosterCards(clipped)[0]?.title, "A".repeat(60)), true);
  assert.equal(renderedTitleMatches(rosterCards(clipped)[0]?.title, "B".repeat(60)), false);
});

test("incomplete rosters and duplicate highlights never authorize a selection or card", () => {
  const missingAction = compose([
    HEADER(1),
    ...expandedCard("Card", "> agent idle | input none"),
    "  Saved conversations",
    "  New session",
  ]);
  assert.equal(parseRosterFrame(missingAction).complete, false);
  assert.equal(selectedRosterEntry(missingAction), undefined);
  assert.deepEqual(rosterCards(missingAction), []);

  const partial = compose([HEADER(2), ...expandedCard("Only one", "> agent idle | input none"), ...ACTIONS]);
  assert.equal(parseRosterFrame(partial).complete, false);
  assert.equal(selectedRosterEntry(partial), undefined);
  assert.deepEqual(rosterCards(partial), []);

  const duplicate = compose([
    HEADER(2),
    ...expandedCard("First", "> agent idle | input none"),
    ...expandedCard("Second", "> agent idle | input none"),
    ...ACTIONS,
  ]);
  assert.equal(parseRosterFrame(duplicate).complete, true);
  assert.equal(selectedRosterEntry(duplicate), undefined, "two highlights are ambiguous");
  assert.equal(selectedRosterCard(duplicate), undefined);
});

test("hide witness rejects partial hide repaints and accepts a divider-free native frame", () => {
  const partial = compose([HEADER(1), ...expandedCard("Only card")]);
  assert.equal(parseRosterFrame(partial).complete, false);
  assert.equal(sidebarRosterHidden(partial), false, "the roster header is still drawn");

  const headerErased = compose(["native content row", ...expandedCard("Only card"), ...ACTIONS]);
  assert.equal(sidebarRosterHidden(headerErased), false,
    "erasing the header does not hide the remaining cards/actions/divider");
  const dividerOnly = compose(["native content row", "another native row"]);
  assert.equal(sidebarRosterHidden(dividerOnly), false,
    "a remaining wide-layout divider is not a completed hide");
  const overlayRemnant = ["Canonical title", "native content row", ...ACTIONS].join("\n");
  assert.equal(sidebarRosterHidden(overlayRemnant, 52), false,
    "a narrow header-erased repaint still contains sidebar actions");

  const hidden = ["Canonical title", "native content row", "another native row"].join("\n");
  assert.equal(parseRosterFrame(hidden).complete, false);
  assert.equal(sidebarRosterHidden(hidden), true, "a genuinely divider-free native frame is hidden");
});

test("background rows validate the complete nullable grammar and the renderer's ellipsis clipping", () => {
  const clipped = compose([
    HEADER(1),
    "Clipped",
    IDLE_STATUS,
    "  bg tasks 9007199254740991 |...",
    "",
    "",
    ...ACTIONS,
  ]);
  const parsed = parseRosterFrame(clipped);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.cards[0]!.background, "bg tasks 9007199254740991 |...");

  for (const bad of ["background unknown garbage", "bg tasks  | shells", "bg tasks 2 | shells", "bg tasks 2 | shells 3 extra", "background", "bg tasks unk | shells 12345..."]) {
    const frame = compose([HEADER(1), "Bad", IDLE_STATUS, `  ${bad}`, "", "", ...ACTIONS]);
    assert.equal(parseRosterFrame(frame).complete, false, `rejects ${JSON.stringify(bad)}`);
    assert.deepEqual(rosterCards(frame), []);
  }
});

test("wide and combining-character sidebar cells never leak the divider or right pane", () => {
  const frame = composeCells(
    [HEADER(1), "セッション", IDLE_STATUS, BACKGROUND, "", "", ...ACTIONS],
    ["> native selected row", "native right pane"],
  );
  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.cards.length, 1, "the marker in the right pane never becomes a second card");
  assert.equal(parsed.cards[0]!.title, "セッション");
  assert.equal(selectedRosterEntry(frame), undefined, "no sidebar row is selected in this frame");
  assert.notEqual(selectedRosterEntry(frame)?.label, "native selected row");

  const combining = composeCells([HEADER(1), "e\u0301", IDLE_STATUS, BACKGROUND, "", "", ...ACTIONS]);
  assert.equal(rosterCards(combining)[0]?.title, "e\u0301");
});

test("pane-only renderer output parses without an outer composed header", () => {
  const rendered = pane([HEADER(1), ...expandedCard("Rendered title"), ...ACTIONS]);
  assert.equal(parseRosterFrame(rendered).complete, true);
  assert.equal(rosterCards(rendered)[0]!.title, "Rendered title");
});
