/**
 * Pure source witnesses for the shared rendered-roster parser. These tests do
 * not start a PTY, SDK, child process, command, install, or home/Git read: they
 * exercise the parser against synthetic frames and real pure-controller
 * renders, so they add no runtime or native claim.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "pi-session-host-tui";
import { NATIVE_STATUS_NOT_APPLICABLE_TEXT } from "../src/session-host/native-status";
import { SidebarController, type SidebarItem } from "../src/session-host/sidebar";
import type { PeerUiConsent, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

import {
  NATIVE_PANE_START,
  NETWORK_ACTION,
  SETTINGS_ACTION,
  type OwnedRosterLabel,
  type RosterActionLabel,
  ROSTER_ACTIONS,
  SIDEBAR_COLUMNS,
  frameHeader,
  frameHeaderMatches,
  isSidebarFocusedFrame,
  nextRosterNavigationTarget,
  parseRosterFrame,
  renderedTitleMatches,
  rosterActionOrder,
  rosterCards,
  rosterNavigationDirection,
  rosterNavigationTargets,
  selectedRosterCard,
  selectedRosterEntry,
  sidebarPaneLines,
  sidebarRosterHidden,
} from "./helpers/session-host-native-roster-witness";

const HEADER = (count: number): string => ` Sessions (${count}) `;
const ACTIONS = ["  Saved conversations", "  New session", "  Quit host"];
/** The required tail with the one optional grouped Settings row (#613). */
const ACTIONS_WITH_SETTINGS = ["  Saved conversations", "  New session", "  Settings", "  Quit host"];
const SETTINGS_LABELS = rosterActionOrder(true);

/** Fixed injected clock for the pure network DTO; no real clock is read. */
const PEER_NOW = 1_700_000_000_000;
const PEER_WINDOW_MS = 120_000;
const OWNED: readonly OwnedRosterLabel[] = [
  { rowProbe: "owned-a", displayName: "Native A" },
  { rowProbe: "owned-b", displayName: "Native B" },
];

/** Coordinator-shaped display DTO; nothing here opens a socket or a file. */
function peerSnapshot(overrides: Partial<PeerUiSnapshot> = {}): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: {
      hostingEnabled: false,
      bindHost: "127.0.0.1",
      bindPort: 8443,
      autoReconnect: false,
      bellEnabled: true,
      viewerNativeInputEnabled: true,
      remoteHistoryDeleteEnabled: true,
    },
    identityFingerprint: "SHA256:local-identity",
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [],
    trustedPeers: [],
    consents: [],
    notice: null,
    ...overrides,
  };
}

function peerConsent(id: string): PeerUiConsent {
  return {
    id,
    kind: "incoming",
    label: `peer-${id}`,
    fingerprint: `SHA256:${id}`,
    endpoint: "192.0.2.1:51234",
    requestedAt: PEER_NOW,
    expiresAt: PEER_NOW + PEER_WINDOW_MS,
  };
}

function nativeItem(id: string): SidebarItem {
  return {
    id: `native-${id}`,
    label: `Native ${id}`,
    workspace: `/workspace/${id}`,
    agentDir: "/agents",
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  };
}

function rosterController(options: {
  readonly width?: number;
  readonly settingsAvailable: boolean;
  readonly legacyToggleOverride: boolean;
  readonly items?: readonly SidebarItem[];
  readonly snapshot?: PeerUiSnapshot;
}): SidebarController {
  const controller = new SidebarController({
    toggleKey: "f8",
    settingsAvailable: options.settingsAvailable,
    legacyToggleOverride: options.legacyToggleOverride,
    now: () => PEER_NOW,
  });
  if (options.items !== undefined) controller.updateItems(options.items);
  if (options.snapshot !== undefined) controller.setPeerUiSnapshot(options.snapshot);
  return controller;
}

const renderRoster = (controller: SidebarController, width = SIDEBAR_COLUMNS): string =>
  controller.renderRoster(width, 40).lines.join("\n");


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
/**
 * The exact both-unknown count row the shared formatter draws at the witness
 * width. Both labeled cells are always present; the second value is clipped by
 * the renderer's existing pane-edge ellipsis, never replaced by a combined word.
 */
const BACKGROUND = "  bg tasks unknown | shells u...";

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
  assert.equal(card.background, BACKGROUND.slice(2));
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

  const settingsAfterQuit = compose([HEADER(1), ...expandedCard("Card"), ...ACTIONS_WITH_SETTINGS.slice(0, 2),
    "  Quit host", "  Settings"]);
  assert.equal(parseRosterFrame(settingsAfterQuit).complete, false,
    "Settings after the destructive Quit host action is never accepted");

  const settingsBeforeNew = compose([HEADER(1), ...expandedCard("Card"), "  Saved conversations",
    "  Settings", "  New session", "  Quit host"]);
  assert.equal(parseRosterFrame(settingsBeforeNew).complete, false,
    "Settings before New session is never accepted");

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

  for (const bad of ["background unknown", "background unknown garbage", "bg tasks  | shells", "bg tasks 2 | shells", "bg tasks 2 | shells 3 extra", "background", "bg tasks unk | shells 12345..."]) {
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

test("production-rendered grouped Settings roster rows parse at wide and narrow pane widths", () => {
  for (const width of [32, 24]) {
    const withoutSettings = new SidebarController({
      toggleKey: "f8",
      settingsAvailable: false,
      legacyToggleOverride: false,
    });
    const noSettingsFrame = withoutSettings.renderRoster(width, 40).lines.join("\n");
    const noSettings = parseRosterFrame(noSettingsFrame, width);
    assert.equal(noSettings.complete, true);
    assert.deepEqual(noSettings.actions.map((entry) => entry.label), rosterActionOrder(false),
      "the production renderer keeps the existing three-action roster when settings are unavailable");
    assert.equal(isSidebarFocusedFrame(noSettingsFrame, width), true);

    for (const legacyToggleOverride of [false, true]) {
      const controller = new SidebarController({
        toggleKey: "f8",
        settingsAvailable: true,
        legacyToggleOverride,
      });
      const frame = controller.renderRoster(width, 40).lines.join("\n");
      const parsed = parseRosterFrame(frame, width);
      assert.equal(parsed.complete, true, `complete production roster at width ${width}, override=${legacyToggleOverride}`);
      assert.deepEqual(parsed.actions.map((entry) => entry.label), rosterActionOrder(true));
      assert.deepEqual(parsed.actions.map((entry) => entry.position),
        parsed.actions.map((entry) => parsed.entries.indexOf(entry)),
      "each action position comes from its actual rendered entry order");
      assert.equal(isSidebarFocusedFrame(frame, width), true,
        "the complete sidebar-focus footer follows the actual optional action row");

      const settingsAction = parsed.actions.find((entry) => entry.label === SETTINGS_ACTION);
      assert.ok(settingsAction, "the grouped Settings row is drawn between New session and Quit host");
      assert.equal(parsed.actions.at(-1)?.label, "Quit host",
        "the destructive Quit host action remains LAST");
      const settingsRow = settingsAction.raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      // Grouping keeps the roster row short: the legacy --sidebar-key override
      // is stated inside the Settings submenu and the shortcuts editor, never
      // annotated onto the roster's one Settings row.
      assert.equal(settingsRow, "  Settings",
        `the grouped Settings row is identical at width ${width} (override=${legacyToggleOverride})`);
      assert.equal(sidebarRosterHidden(settingsAction.raw, width), false,
        "a stale Settings row alone is not mistaken for a hidden sidebar");
    }
  }
});

test("production grouped Settings selection navigation uses its actual parsed entry position", () => {
  for (const width of [32, 24]) {
    const controller = new SidebarController({
      toggleKey: "f8",
      settingsAvailable: true,
      legacyToggleOverride: true,
    });
    void controller.renderRoster(width, 40);
    controller.handleInput("\x1b[B"); // New session -> Settings
    const frame = controller.renderRoster(width, 40).lines.join("\n");
    const parsed = parseRosterFrame(frame, width);
    const selected = selectedRosterEntry(frame, width);
    assert.equal(parsed.complete, true);
    assert.ok(selected);
    assert.equal(selected.kind, "action");
    assert.equal(selected.label, "Settings");
    const renderedPosition = parsed.entries.findIndex((entry) => entry.kind === "action"
      && entry.label === "Settings");
    assert.notEqual(renderedPosition, -1);
    assert.equal(selected.position, renderedPosition);
    assert.equal(parsed.entries[selected.position]?.label, "Settings",
      "keyboard navigation and the witness agree on the rendered entry index");
  }
});

test("production-rendered roster navigation wraps through Settings and handles a three-action tail", () => {
  const pressAndAssertNext = (
    controller: SidebarController,
    width: number,
    owned: readonly OwnedRosterLabel[],
  ): string => {
    const before = controller.renderRoster(width, 40).lines.join("\n");
    const parsed = parseRosterFrame(before, width);
    const selected = selectedRosterEntry(before, width);
    assert.equal(parsed.complete, true);
    assert.ok(selected);
    const targets = rosterNavigationTargets(parsed, owned);
    assert.ok(targets);
    const expected = nextRosterNavigationTarget(targets, selected.position);
    assert.ok(expected);
    controller.handleInput("\x1b[B");
    const after = controller.renderRoster(width, 40).lines.join("\n");
    const actual = selectedRosterEntry(after, width);
    assert.ok(actual);
    assert.equal(actual.position, expected.position);
    const actualTarget = targets.find((target) => target.position === actual.position);
    assert.ok(actualTarget);
    assert.equal(actualTarget.label, expected.label);
    return actualTarget.label;
  };

  for (const width of [32]) {
    const owned: readonly OwnedRosterLabel[] = [
      { rowProbe: "owned-a", displayName: "Native A" },
      { rowProbe: "owned-b", displayName: "Native B" },
    ];
    const nativeItems = [
      {
        id: "native-a",
        label: "Native A",
        workspace: "/workspace/a",
        agentDir: "/agents",
        lifecycle: "alive" as const,
        busy: false,
        pendingInput: false,
        inputSurface: false,
        activity: [],
      },
      {
        id: "native-b",
        label: "Native B",
        workspace: "/workspace/b",
        agentDir: "/agents",
        lifecycle: "alive" as const,
        busy: false,
        pendingInput: false,
        inputSurface: false,
        activity: [],
      },
    ];
    const withSettings = new SidebarController({
      toggleKey: "f8",
      settingsAvailable: true,
      legacyToggleOverride: true,
    });
    withSettings.updateItems(nativeItems);
    assert.equal(pressAndAssertNext(withSettings, width, owned), "Settings",
      "New session advances to the optional Settings action");
    assert.equal(pressAndAssertNext(withSettings, width, owned), "Quit host",
      "Settings advances to the final Quit host action");
    assert.equal(pressAndAssertNext(withSettings, width, owned), "owned-a",
      "the final Quit host row wraps to the first owned native entry");

    const startingOnShortcuts = new SidebarController({
      toggleKey: "f8",
      settingsAvailable: true,
      legacyToggleOverride: true,
    });
    startingOnShortcuts.updateItems(nativeItems);
    void startingOnShortcuts.renderRoster(width, 40);
    startingOnShortcuts.handleInput("\x1b[B"); // New session -> Settings
    const hostFrame = startingOnShortcuts.renderRoster(width, 40).lines.join("\n");
    const hostParsed = parseRosterFrame(hostFrame, width);
    assert.equal(selectedRosterEntry(hostFrame, width)?.label, "Settings");
    assert.ok(rosterNavigationTargets(hostParsed, owned)?.some((target) => target.label === "Settings"),
      "the known-highlight fence includes the actual optional action");
    assert.equal(pressAndAssertNext(startingOnShortcuts, width, owned), "Quit host",
      "navigation can start on Settings and advance to the final Quit host action");
    assert.equal(pressAndAssertNext(startingOnShortcuts, width, owned), "owned-a",
      "the final Quit host row then wraps to the first owned native entry");

    const withoutSettings = new SidebarController({
      toggleKey: "f8",
      settingsAvailable: false,
      legacyToggleOverride: false,
    });
    withoutSettings.updateItems(nativeItems);
    assert.equal(pressAndAssertNext(withoutSettings, width, owned), "Quit host");
    const noSettingsFrame = withoutSettings.renderRoster(width, 40).lines.join("\n");
    const noSettingsParsed = parseRosterFrame(noSettingsFrame, width);
    assert.deepEqual(noSettingsParsed.actions.map((entry) => entry.label), rosterActionOrder(false));
    assert.equal(pressAndAssertNext(withoutSettings, width, owned), "owned-a",
      "the no-settings three-action tail wraps directly from Quit to the first owned native entry");
  }
});

test("navigation targets retain one-to-one owned-session correlation", () => {
  const controller = new SidebarController({
    toggleKey: "f8",
    settingsAvailable: true,
    legacyToggleOverride: true,
  });
  controller.updateItems([{
    id: "native-a",
    label: "Native A",
    workspace: "/workspace/a",
    agentDir: "/agents",
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  }]);
  const frame = controller.renderRoster(32, 40).lines.join("\n");
  const parsed = parseRosterFrame(frame, 32);
  assert.equal(parsed.complete, true);
  const targets = rosterNavigationTargets(parsed, [{ rowProbe: "owned-a", displayName: "Native A" }]);
  assert.ok(targets);
  const card = parsed.cards[0]!;
  assert.equal(targets.find((target) => target.position === card.position)?.label, "owned-a");
  assert.equal(rosterNavigationTargets(parsed, []), undefined,
    "an actual native card without one owned-session witness cannot enter the navigation order");
  assert.equal(rosterNavigationTargets(parsed, [{ rowProbe: "owned-a", displayName: "Other" }]), undefined,
    "a nonmatching owned-session title cannot be guessed into the navigation order");
});

test("Settings tails reject partial, unknown, out-of-order, and duplicate rows", () => {
  for (const width of [32, 24]) {
    const controller = new SidebarController({
      toggleKey: "f8",
      settingsAvailable: true,
      legacyToggleOverride: true,
    });
    const renderedLines = controller.renderRoster(width, 40).lines;
    const completeFrame = renderedLines.join("\n");
    const complete = parseRosterFrame(completeFrame, width);
    assert.equal(complete.complete, true);
    const rowFor = (label: RosterActionLabel): string => {
      const action = complete.actions.find((entry) => entry.label === label);
      assert.ok(action, `the complete renderer draws ${label}`);
      return renderedLines[1 + action.position]!;
    };
    const savedRow = rowFor("Saved conversations");
    const newRow = rowFor("New session");
    const settingsRow = rowFor(SETTINGS_ACTION);
    const quitRow = rowFor("Quit host");
    const footer = renderedLines.slice(1 + complete.entryEnd);
    const frameWithTail = (tail: readonly string[]): string => [renderedLines[0]!, ...tail, ...footer].join("\n");
    const plainSettings = settingsRow.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    assert.equal(plainSettings, "  Settings");
    const partialSettings = "  Setting";

    const malformedTails: readonly (readonly string[])[] = [
      [savedRow, newRow, partialSettings, quitRow],
      [savedRow, newRow, "  Unknown action", quitRow],
      [savedRow, newRow, "  Settings (unknown suffix)", quitRow],
      [savedRow, newRow, quitRow, settingsRow],
      [savedRow, settingsRow, newRow, quitRow],
      [savedRow, newRow, settingsRow, settingsRow, quitRow],
      [settingsRow, savedRow, newRow, quitRow],
      [savedRow, quitRow],
      [savedRow, newRow, settingsRow],
      [savedRow, newRow, settingsRow, quitRow, settingsRow],
    ];
    for (const tail of malformedTails) {
      const frame = frameWithTail(tail);
      const parsed = parseRosterFrame(frame, width);
      assert.equal(parsed.complete, false, `rejects malformed tail at width ${width}: ${JSON.stringify(tail)}`);
      assert.deepEqual(parsed.entries, []);
      assert.deepEqual(parsed.actions, []);
      assert.equal(rosterNavigationTargets(parsed, []), undefined);
      assert.equal(selectedRosterEntry(frame, width), undefined);
      assert.equal(isSidebarFocusedFrame(frame, width), false);
    }

    assert.equal(sidebarRosterHidden(partialSettings, width), false,
      "a partially painted settings row remains a visible remnant, not a hidden witness");
  }
});

test("an attached network snapshot adds no roster row; Settings is the one entry point", () => {
  for (const settingsAvailable of [false, true]) {
    for (const legacyToggleOverride of [false, true]) {
      const controller = rosterController({
        settingsAvailable,
        legacyToggleOverride,
        items: [nativeItem("A")],
      });
      const before = renderRoster(controller);
      const beforeParsed = parseRosterFrame(before);
      assert.equal(beforeParsed.complete, true, "the roster keeps parsing unchanged");
      assert.deepEqual(beforeParsed.actions.map((entry) => entry.label),
        rosterActionOrder(settingsAvailable),
      `no snapshot means no extra roster row (settings=${settingsAvailable})`);

      // Arrival of the coordinator DTO stays presentation only. It never adds a
      // top-level Network row; where settings were unavailable it only makes the
      // ONE grouped Settings entry available, between New session and Quit host.
      controller.setPeerUiSnapshot(peerSnapshot());
      const after = renderRoster(controller);
      const parsed = parseRosterFrame(after);
      const flags = `settings=${settingsAvailable}, override=${legacyToggleOverride}`;
      assert.equal(parsed.complete, true, `complete roster after the snapshot (${flags})`);
      assert.equal(parsed.count, 1);
      assert.deepEqual(parsed.cards.map((card) => card.title), ["Native A"]);
      assert.deepEqual(parsed.actions.map((entry) => entry.label),
        rosterActionOrder(true),
      `the grouped Settings entry is the only settings row (${flags})`);
      assert.deepEqual(parsed.actions.map((entry) => entry.position),
        parsed.actions.map((_, index) => parsed.cards.length + index),
      `every action keeps its actual rendered entry position (${flags})`);
      assert.equal(parsed.actions.filter((entry) => entry.raw.includes(NETWORK_ACTION)).length, 0,
      `no Network row is drawn in the roster (${flags})`);
      assert.equal(parsed.actions.find((entry) => entry.label === SETTINGS_ACTION)?.selected, false,
        "the new Settings row is not secretly highlighted");
      assert.equal(selectedRosterEntry(after)?.label, "New session",
        "an arriving snapshot never moves the existing highlight");
      assert.equal(isSidebarFocusedFrame(after), true, `the footer still follows the optional row (${flags})`);
    }
  }
});

test("the empty Sessions (0) roster with an attached snapshot parses at wide and narrow pane widths", () => {
  for (const width of [SIDEBAR_COLUMNS, 24]) {
    for (const legacyToggleOverride of [false, true]) {
      const controller = rosterController({
        settingsAvailable: true,
        legacyToggleOverride,
        snapshot: peerSnapshot(),
      });
      const frame = renderRoster(controller, width);
      const parsed = parseRosterFrame(frame, width);
      const flags = `width=${width}, override=${legacyToggleOverride}`;
      assert.equal(parsed.complete, true, `the observed empty-with-network frame parses (${flags})`);
      assert.equal(parsed.count, 0);
      assert.deepEqual(parsed.cards, []);
      assert.deepEqual(parsed.actions.map((entry) => entry.label), SETTINGS_LABELS);
      assert.deepEqual(parsed.actions.map((entry) => entry.position), [0, 1, 2, 3]);
      assert.equal(selectedRosterEntry(frame, width)?.label, "New session");
      assert.equal(selectedRosterEntry(frame, width)?.position, 1);
      assert.equal(isSidebarFocusedFrame(frame, width), true);
      assert.equal(sidebarRosterHidden(frame, width), false,
        "the drawn Settings row is a visible sidebar remnant, never a hidden witness");
    }
  }
});

test("grouped Settings navigation reports its actual parsed position in both directions", () => {
  const controller = rosterController({
    settingsAvailable: true,
    legacyToggleOverride: false,
    items: [nativeItem("A"), nativeItem("B")],
    snapshot: peerSnapshot(),
  });
  const before = renderRoster(controller);
  const beforeParsed = parseRosterFrame(before);
  const beforeTargets = rosterNavigationTargets(beforeParsed, OWNED);
  assert.ok(beforeTargets);
  const settings = beforeTargets.find((target) => target.label === SETTINGS_ACTION);
  assert.ok(settings, "the grouped Settings entry is part of the real navigation order");
  assert.equal(beforeTargets[settings.position]?.label, SETTINGS_ACTION,
    "the navigation position is the rendered entry index, not a guessed offset");
  assert.equal(beforeTargets.filter((target) => target.label === NETWORK_ACTION).length, 0,
    "Network is a Settings submenu, never a roster navigation target");

  controller.handleInput("\x1b[B"); // New session -> the grouped Settings entry
  const onSettings = renderRoster(controller);
  const parsed = parseRosterFrame(onSettings);
  const selected = selectedRosterEntry(onSettings);
  assert.equal(parsed.complete, true);
  assert.equal(selected?.label, SETTINGS_ACTION);
  assert.equal(selected?.position, settings.position);
  assert.equal(parsed.entries[selected!.position]?.label, SETTINGS_ACTION);
  const targets = rosterNavigationTargets(parsed, OWNED);
  assert.ok(targets);
  assert.equal(nextRosterNavigationTarget(targets, selected!.position)?.label, "Quit host",
    "Down steps from Settings to the final Quit host action");
  assert.equal(nextRosterNavigationTarget(targets, selected!.position, "up")?.label, "New session",
    "Up steps back from Settings to New session");
  const quit = targets.find((target) => target.label === "Quit host");
  assert.ok(quit);
  assert.equal(nextRosterNavigationTarget(targets, quit.position)?.label, "owned-a",
    "Down wraps from the final entry to the first owned native entry");
});

test("misplaced, duplicated, partial, annotated, and unknown Network rows stay fail-closed", () => {
  const card = expandedCard("Card");
  const malformedTails: readonly (readonly string[])[] = [
    [HEADER(1), ...card, "  Network", ...ACTIONS],
    [HEADER(1), ...card, "  Saved conversations", "  Network", "  New session", "  Quit host"],
    [HEADER(1), ...card, ...ACTIONS, "  Network"],
    [HEADER(1), ...card, ...ACTIONS_WITH_SETTINGS, "  Network"],
    [HEADER(1), ...card, "  Saved conversations", "  New session", "  Networ", "  Quit host"],
    [HEADER(1), ...card, "  Saved conversations", "  New session", "  Network (1 request)", "  Quit host"],
    [HEADER(1), ...card, "  Saved conversations", "  New session", "  Networks", "  Quit host"],
    [HEADER(1), ...card, "  Saved conversations", "  New session", "  network", "  Quit host"],
    [HEADER(1), ...card, "  Saved conversations", "  New session", "> Network", "  Quit host", "  Network"],
  ];
  for (const tail of malformedTails) {
    const frame = compose(tail);
    const parsed = parseRosterFrame(frame);
    assert.equal(parsed.complete, false, `rejects ${JSON.stringify(tail.slice(2))}`);
    assert.deepEqual(parsed.entries, []);
    assert.deepEqual(parsed.cards, []);
    assert.deepEqual(parsed.actions, []);
    assert.equal(selectedRosterEntry(frame), undefined);
    assert.equal(rosterNavigationTargets(parsed, OWNED), undefined);
    assert.equal(isSidebarFocusedFrame(frame), false);
  }

  // Grouping (#613) means the renderer draws NO Network row in the roster at
  // all: the pending request stays in the roster's own bounded alert band, and
  // the Network submenu inside Settings keeps the request-count annotation. Any
  // Network-shaped row is therefore only ever a visible sidebar remnant.
  const annotated = rosterController({
    settingsAvailable: true,
    legacyToggleOverride: false,
    items: [nativeItem("A")],
    snapshot: peerSnapshot({ consents: [peerConsent("a")] }),
  });
  const annotatedFrame = renderRoster(annotated);
  assert.ok(annotatedFrame.includes("  Settings"), annotatedFrame);
  assert.equal(annotatedFrame.split("\n").some((line) =>
    /^\s*(> )?(Network|Host shortcuts)/.test(line.replace(/\x1b\[[0-9;]*m/g, ""))), false,
    "the roster draws no Network or Host shortcuts row, annotated or otherwise");
  assert.ok(annotatedFrame.includes("Incoming connection request"),
    "the pending request keeps its own notification band, so grouping loses no discoverability");
  assert.equal(parseRosterFrame(annotatedFrame).complete, false,
    "the reserved alert band rows are not cards, so the strict parse stays incomplete (unchanged by #613)");
  for (const remnant of [
    "  Network",
    "> Network",
    "  Networ",
    "  Network (1 request)",
    "  Network (2 requ...",
    "  Host shortcuts",
  ]) {
    assert.equal(sidebarRosterHidden(remnant, SIDEBAR_COLUMNS), false,
      `${JSON.stringify(remnant)} is a visible submenu remnant, not a hidden sidebar`);
  }
  for (const remnant of ["  Settings", "> Setting", "  Setti"]) {
    assert.equal(sidebarRosterHidden(remnant, SIDEBAR_COLUMNS), false,
      `${JSON.stringify(remnant)} is a visible Settings remnant, not a hidden sidebar`);
  }
  assert.equal(sidebarRosterHidden(["Canonical title", "native content row"].join("\n")), true,
    "a settings-row-free, divider-free frame is still witnessed as hidden");
});

test("navigation direction chooses the shortest known cyclic step and refuses ambiguous steps", () => {
  const controller = rosterController({
    settingsAvailable: true,
    legacyToggleOverride: true,
    items: [nativeItem("A"), nativeItem("B")],
    snapshot: peerSnapshot(),
  });
  const parsed = parseRosterFrame(renderRoster(controller));
  assert.equal(parsed.complete, true);
  const targets = rosterNavigationTargets(parsed, OWNED);
  assert.ok(targets);
  assert.deepEqual(targets.map((target) => target.label),
    ["owned-a", "owned-b", "Saved conversations", "New session", SETTINGS_ACTION, "Quit host"]);
  const positionOf = (label: string): number => targets.find((target) => target.label === label)!.position;

  assert.equal(rosterNavigationDirection(targets, positionOf("owned-b"), "owned-a"), "up",
    "the six-entry roster reaches the first card in one Up instead of five Downs");
  assert.equal(nextRosterNavigationTarget(targets, positionOf("owned-b"), "up")?.label, "owned-a");
  assert.equal(nextRosterNavigationTarget(targets, positionOf("owned-b"))?.label, "Saved conversations",
    "the default direction stays Down");
  assert.equal(nextRosterNavigationTarget(targets, positionOf("owned-b"), "down")?.label,
    nextRosterNavigationTarget(targets, positionOf("owned-b"))?.label,
  "an explicit Down matches the default");
  let cursor = positionOf("owned-b");
  let downs = 0;
  for (;;) {
    const step = nextRosterNavigationTarget(targets, cursor, "down");
    assert.ok(step);
    downs += 1;
    assert.ok(downs <= 6, "the Down path is bounded by the rendered entry count");
    if (step.label === "owned-a") break;
    cursor = step.position;
  }
  assert.equal(downs, 5, "five Down presses are needed where one Up step suffices");

  assert.equal(rosterNavigationDirection(targets, positionOf("New session"), SETTINGS_ACTION), "down",
    "the grouped entry sits between New session and the final Quit host");
  assert.equal(rosterNavigationDirection(targets, positionOf("owned-a"), "Settings"), "up",
    "the shorter Up path reaches Settings through the final entry");
  assert.equal(nextRosterNavigationTarget(targets, positionOf("owned-a"), "up")?.label, "Quit host",
    "Up wraps from the first rendered entry to the final Quit host action");
  assert.equal(nextRosterNavigationTarget(targets, positionOf("Settings"), "down")?.label, "Quit host",
    "Down steps from Settings to the final Quit host action");
  assert.equal(nextRosterNavigationTarget(targets, positionOf("Quit host"), "down")?.label, "owned-a",
    "Down still wraps from the final entry to the first");

  // Equal-length steps go Down, the direction every existing driver can press.
  const legacy = rosterController({ settingsAvailable: false, legacyToggleOverride: false, items: [nativeItem("A")] });
  const legacyParsed = parseRosterFrame(renderRoster(legacy));
  const legacyTargets = rosterNavigationTargets(legacyParsed, [OWNED[0]!]);
  assert.ok(legacyTargets);
  assert.deepEqual(legacyTargets.map((target) => target.label),
    ["owned-a", "Saved conversations", "New session", "Quit host"]);
  assert.equal(rosterNavigationDirection(legacyTargets, 0, "New session"), "down", "a tie steps Down");
  assert.equal(rosterNavigationDirection(legacyTargets, 0, NETWORK_ACTION), undefined,
    "a label that is not rendered cannot be a navigation target");

  assert.equal(rosterNavigationDirection([], 0, "owned-a"), undefined);
  assert.equal(rosterNavigationDirection(targets, 99, "owned-a"), undefined,
    "an unobserved highlight cannot be stepped from");
  assert.equal(rosterNavigationDirection(targets, positionOf("owned-a"), "Not rendered"), undefined);
  assert.equal(rosterNavigationDirection(targets, positionOf("owned-a"), "owned-a"), undefined,
    "an already-selected target needs no step");
  assert.equal(nextRosterNavigationTarget([], 0, "up"), undefined);
  assert.equal(nextRosterNavigationTarget(targets, 99, "up"), undefined);
  assert.equal(nextRosterNavigationTarget(targets, positionOf("owned-a"), "sideways" as "down"), undefined,
    "an unknown direction is refused instead of defaulting");

  const duplicatedHighlight = [...targets, { position: positionOf("owned-a"), label: "duplicate" }];
  assert.equal(rosterNavigationDirection(duplicatedHighlight, positionOf("owned-a"), "owned-b"), undefined,
    "two entries claiming one highlight position are ambiguous");
  assert.equal(nextRosterNavigationTarget(duplicatedHighlight, positionOf("owned-a"), "up"), undefined);
  assert.equal(nextRosterNavigationTarget(duplicatedHighlight, positionOf("owned-b"), "up")?.label,
    "owned-a", "an unrelated step from an unambiguous highlight still resolves");
  const duplicatedLabel = [...targets, { position: 7, label: "owned-b" }];
  assert.equal(rosterNavigationDirection(duplicatedLabel, positionOf("owned-a"), "owned-b"), undefined,
    "one label drawn at two positions is ambiguous");
});

/* -------------------------------------------------------------------------- *
 * Not-applicable card values (native status applicability, issue #277).      *
 *                                                                            *
 * A category the row's own observer positively declared unreportable renders *
 * the shared not-applicable word in the agent cell, the input cell, or       *
 * either count cell. Those are REAL rendered values, so the ONE shared       *
 * witness must read them: every native acceptance harness acknowledges its   *
 * focus, selection, and navigation frames through this parser, and a roster  *
 * holding such a card is either a complete parse for all of them or no parse *
 * at all.                                                                    *
 *                                                                            *
 * What follows pins the accepted forms against the actual production         *
 * renderer and the exact clipped forms, and proves the closed set stays      *
 * closed: a lookalike (`n/a`, `NA`, an annotated cell), a half-painted cell, *
 * and a partial card remain no parse. Nothing here widens anything to free   *
 * text.                                                                      *
 * -------------------------------------------------------------------------- */

/** The production not-applicable word, imported rather than retyped. */
const NA = NATIVE_STATUS_NOT_APPLICABLE_TEXT;

/** One display DTO shaped like a hosted provider row's own card facts. */
function statusItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: overrides.id,
    workspace: `/workspace/${overrides.id}`,
    agentDir: "/agents",
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    ...overrides,
  };
}

/** The serializer-generated SGR pattern, stripped exactly as the witness strips it. */
const DRAWN_SGR = /\x1b\[[0-9;]*m/g;

/** One background row exactly as the renderer draws it in a `width`-cell pane. */
const drawnBackground = (text: string, width = SIDEBAR_COLUMNS): string =>
  truncateToWidth(`  ${text}`, width, "...", true).replace(DRAWN_SGR, "");

/**
 * A hand-made clipped count row's TEXT (no selection marker, so every caller adds
 * its own) whose `...` sits exactly at the pane edge. Without that exact width a
 * fixture would be rejected by the pane-boundary rule instead of by the count
 * grammar, which is the whole point of the negative cases.
 */
function fakeClippedCounts(core: string): string {
  assert.equal(visibleWidth(`  ${core}...`), SIDEBAR_COLUMNS,
    `test fixture: ${JSON.stringify(core)} is not an exact pane-edge clip, so it would prove nothing`);
  return `${core}...`;
}

/**
 * One drawn card row from a status or count VALUE, with the two-cell unselected
 * marker. A fixture that already carried its own marker would land at the
 * four-cell activity indent and would then "prove" a rejection for never being a
 * marker row at all, so this refuses that mistake outright.
 */
function drawnRow(value: string): string {
  const row = `  ${value}`;
  assert.ok(row.slice(2).length > 0 && !row.slice(2, 3).startsWith(" "),
    `test fixture ${JSON.stringify(value)} would draw an activity row, not a marker row`);
  return row;
}

/** A pane-only frame whose every row is exactly `width` cells, clipped like the renderer. */
function paneFrame(width: number, rows: readonly string[]): string {
  return rows.map((row) => truncateToWidth(row, width, "...", true).replace(DRAWN_SGR, "")).join("\n");
}

test("the shared witness reads the production renderer's not-applicable card values", () => {
  const controller = rosterController({
    settingsAvailable: true,
    legacyToggleOverride: false,
    items: [
      // A Pi row and a claude-backed row carry no unreportable declaration.
      statusItem({ id: "Pi conversation" }),
      statusItem({ id: "Claude", backend: "claude" }),
      // The armed codex-backed row: input and both counts positively unreportable.
      statusItem({
        id: "Codex",
        backend: "codex",
        statusSupport: { input: "unsupported", tasks: "unsupported", shells: "unsupported" },
      }),
      // One unreportable agent/input pair, and one count paired with an observed number.
      statusItem({
        id: "Mixed",
        backend: "codex",
        activeShells: 2,
        statusSupport: { agent: "unsupported", input: "unsupported", tasks: "unsupported" },
      }),
    ],
  });
  const frame = renderRoster(controller);
  assert.ok(frame.includes(`input ${NA}`), "the renderer really drew the not-applicable input cell");
  assert.ok(frame.includes(`bg tasks ${NA} | shells ${NA}`),
    "the renderer really drew both not-applicable count cells");

  const parsed = parseRosterFrame(frame);
  assert.equal(parsed.complete, true, "an armed native row is not a partial roster");
  assert.equal(parsed.count, 4);
  assert.deepEqual(parsed.cards.map((card) => [card.title, card.status, card.background]), [
    ["Pi conversation", "agent unknown | input unknown", BACKGROUND.slice(2)],
    ["Claude", "agent unknown | input unknown", BACKGROUND.slice(2)],
    ["Codex", `agent unknown | input ${NA}`, `bg tasks ${NA} | shells ${NA}`],
    ["Mixed", `agent ${NA} | input ${NA}`, `bg tasks ${NA} | shells 2`],
  ], "each card keeps its own drawn status and count cells, with an unknown never rewritten");

  // The exact witness `MainPtyDriver.ensureSidebarFocus()` asserts on this frame.
  assert.equal(isSidebarFocusedFrame(frame), true,
    "a complete roster holding a not-applicable card still proves real sidebar focus");
  const targets = rosterNavigationTargets(parsed, [
    { rowProbe: "pi", displayName: "Pi conversation" },
    { rowProbe: "claude", displayName: "Claude" },
    { rowProbe: "codex", displayName: "Codex" },
    { rowProbe: "mixed", displayName: "Mixed" },
  ]);
  assert.ok(targets);
  assert.equal(nextRosterNavigationTarget(targets, 0)?.label, "claude",
    "navigation steps across a roster that contains not-applicable cards");
});

test("the shared status and count grammars admit the exact not-applicable forms", () => {
  for (const status of [
    `starting | input ${NA}`,
    `agent ${NA} | input ${NA}`,
    `agent unknown | input ${NA}`,
    `agent idle | input ${NA}`,
    `agent ${NA} | input none`,
    "agent running | input pending",
  ]) {
    const frame = compose([HEADER(1), "Card", `  ${status}`, BACKGROUND, ...ACTIONS]);
    const parsed = parseRosterFrame(frame);
    assert.equal(parsed.complete, true, `accepts the drawn status ${JSON.stringify(status)}`);
    assert.equal(parsed.cards[0]?.status, status);
  }

  for (const background of [
    BACKGROUND.slice(2),
    "bg tasks 0 | shells 0",
    `bg tasks ${NA} | shells ${NA}`,
    `bg tasks ${NA} | shells 0`,
    "bg tasks 3 | shells unknown",
    `bg tasks unknown | shells ${NA}`,
    `bg tasks ${NA} | shells unknown`,
  ]) {
    const frame = compose([HEADER(1), "Card", IDLE_STATUS, `  ${background}`, "", "", ...ACTIONS]);
    const parsed = parseRosterFrame(frame);
    assert.equal(parsed.complete, true, `accepts the drawn counts ${JSON.stringify(background)}`);
    assert.equal(parsed.cards[0]?.background, background);
  }

  // The canonical both-unknown row is two independently named cells, never a
  // combined phrase: a wider pane draws it whole.
  const wide = paneFrame(40, [
    HEADER(1), "Card", IDLE_STATUS, "  bg tasks unknown | shells unknown", "", "", ...ACTIONS,
  ]);
  const parsedWide = parseRosterFrame(wide, 40);
  assert.equal(parsedWide.complete, true);
  assert.equal(parsedWide.cards[0]?.background, "bg tasks unknown | shells unknown",
    "both unobserved counts keep their own labeled cells instead of one aggregate word");

  // One roster with both-unknown, observed-zero, not-applicable, and half-known count cards at once.
  const mixed = compose([
    HEADER(4),
    "Pi row", IDLE_STATUS, BACKGROUND,
    "Observed zeros", "  agent idle | input none", "  bg tasks 0 | shells 0",
    "Not applicable", `  agent ${NA} | input ${NA}`, `  bg tasks ${NA} | shells ${NA}`,
    "Half known", IDLE_STATUS, `  bg tasks unknown | shells ${NA}`,
    ...ACTIONS,
  ]);
  const parsedMixed = parseRosterFrame(mixed);
  assert.equal(parsedMixed.complete, true);
  assert.deepEqual(parsedMixed.cards.map((card) => card.background), [
    BACKGROUND.slice(2),
    "bg tasks 0 | shells 0",
    `bg tasks ${NA} | shells ${NA}`,
    `bg tasks unknown | shells ${NA}`,
  ], "one roster can carry every honest count shape at once");
  assert.deepEqual(parsedMixed.cards.map((card) => card.status), [
    "agent idle | input none",
    "agent idle | input none",
    `agent ${NA} | input ${NA}`,
    "agent idle | input none",
  ]);
  assert.equal(selectedRosterCard(mixed), undefined, "no card is highlighted in this frame");
});

test("not-applicable count cells survive the renderer's clipped forms", () => {
  // Clipped inside the observed shells count, with a complete not-applicable cell first.
  const clippedCounts = drawnBackground("bg tasks N/A | shells 1234567890123456789");
  assert.ok(clippedCounts.endsWith("..."), clippedCounts);
  const countsFrame = compose([HEADER(1), "Codex", IDLE_STATUS, clippedCounts, "", "", ...ACTIONS]);
  const counts = parseRosterFrame(countsFrame);
  assert.equal(counts.complete, true);
  assert.equal(counts.cards[0]?.background, clippedCounts.slice(2),
    "the parsed background is the drawn row minus its two-cell marker");

  // Clipped mid-word in the second cell, at the narrow overlay pane width, where the
  // renderer's only drawing of that row is `bg tasks N/A | sh...`.
  const narrow = 20;
  const clippedCells = drawnBackground(`bg tasks ${NA} | shells ${NA}`, narrow);
  assert.equal(visibleWidth(clippedCells), narrow, "the renderer drew the row at the pane edge");
  assert.ok(clippedCells.endsWith("..."), clippedCells);
  const narrowFrame = paneFrame(narrow, [
    HEADER(1), "Codex", "  exited (code 0)", clippedCells,
    "  Saved conversations", "  New session", "  Quit host",
  ]);
  const parsedNarrow = parseRosterFrame(narrowFrame, narrow);
  assert.equal(parsedNarrow.complete, true, "the clipped not-applicable cells are a complete card");
  assert.equal(parsedNarrow.cards[0]?.background, clippedCells.slice(2));
  assert.equal(parsedNarrow.cards[0]?.status, "exited (code 0)");

  // A clipped cell that stops inside the not-applicable word is still that word.
  const clippedToken = `  ${fakeClippedCounts(`bg tasks ${NA} | shells 12345`)}`;
  assert.equal(parseRosterFrame(compose([
    HEADER(1), "Codex", IDLE_STATUS, clippedToken, "", "", ...ACTIONS,
  ])).complete, true);
});

test("not-applicable lookalikes, half-painted cells, and partial cards stay no parse", () => {
  // The closed word set: only the production spelling, never an annotation or case variant.
  for (const status of [
    "agent unknown | input n/a",
    "agent unknown | input NA",
    "agent unknown | input N/A (unreportable)",
    "agent unknown | input N/A/",
    "agent unknown|input N/A",
    `agent unknown | input ${NA} | extra`,
    `agent N/ | input ${NA}`,
    `agent ${NA}`,
    `input ${NA}`,
  ]) {
    const frame = compose([HEADER(1), "Card", drawnRow(status), BACKGROUND, "", "", ...ACTIONS]);
    assert.equal(parseRosterFrame(frame).complete, false, `rejects the status ${JSON.stringify(status)}`);
    assert.deepEqual(rosterCards(frame), [], `no card leaks out of ${JSON.stringify(status)}`);
    assert.equal(selectedRosterCard(frame), undefined);
  }

  for (const background of [
    `bg tasks ${NA}`,
    "bg tasks n/a | shells n/a",
    "bg tasks NA | shells 1",
    "bg tasks N/ | shells 1",
    "bg tasks N/A/ | shells 1",
    "bg tasks N/A | shell 1",
    "bg tasks N/A | shells 1 2",
    `bg tasks ${NA} | shells ${NA} extra`,
    fakeClippedCounts("bg tasks N/ | shells 123456"),
    fakeClippedCounts("bg tasks NA | shells 123456"),
    fakeClippedCounts("bg tasks n/a | shells 12345"),
    fakeClippedCounts("bg tasks N/A | shell 123456"),
  ]) {
    const frame = compose([HEADER(1), "Card", IDLE_STATUS, drawnRow(background), "", "", ...ACTIONS]);
    assert.equal(parseRosterFrame(frame).complete, false, `rejects the counts ${JSON.stringify(background)}`);
    assert.deepEqual(rosterCards(frame), [], `no card leaks out of ${JSON.stringify(background)}`);
  }

  // A half-painted not-applicable cell is not a clipped one: the renderer's ellipsis
  // is the only accepted evidence of clipping, and a status row is never clipped.
  for (const partial of [
    "agent unknown | input N/",
    "agent unknown | input N",
    `agent ${NA} | input N/`,
    `bg tasks ${NA} | shells N/`,
    `bg tasks ${NA} | shells`,
  ]) {
    const frame = compose([HEADER(1), "Card", drawnRow(partial), BACKGROUND, "", "", ...ACTIONS]);
    assert.equal(parseRosterFrame(frame).complete, false, `rejects the half-painted ${JSON.stringify(partial)}`);
  }
  const statusTooWideForItsPane = paneFrame(20, [
    HEADER(1), "Codex", `  agent unknown | input ${NA}`, drawnBackground("bg tasks 0 | shells 0", 20),
    "  Saved conversations", "  New session", "  Quit host",
  ]);
  assert.equal(parseRosterFrame(statusTooWideForItsPane, 20).complete, false,
    "a status row the renderer had to clip is never accepted");

  // A not-applicable card missing its count row, or missing its second activity row.
  assert.equal(parseRosterFrame(compose([
    HEADER(1), "Codex", `  agent unknown | input ${NA}`, ...ACTIONS,
  ])).complete, false, "a card without its third row is not complete");
  assert.equal(parseRosterFrame(compose([
    HEADER(1), "Codex", `  agent unknown | input ${NA}`, `  bg tasks ${NA} | shells ${NA}`, "    one activity",
    ...ACTIONS,
  ])).complete, false, "a half-drawn expanded card is not complete");
});

test("a stale not-applicable row is never witnessed as a hidden sidebar", () => {
  for (const remnant of [
    `> agent unknown | input ${NA}`,
    `  bg tasks ${NA} | shells ${NA}`,
    `  ${fakeClippedCounts(`bg tasks ${NA} | shells 12345`)}`,
    `> agent ${NA} | input ${NA}`,
  ]) {
    assert.equal(sidebarRosterHidden(remnant), false, `${JSON.stringify(remnant)} is still drawn`);
  }
  assert.equal(sidebarRosterHidden("Codex\nnative content row"), true,
    "a divider-free frame with no such row is still hidden");
});
