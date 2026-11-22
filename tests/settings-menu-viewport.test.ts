/**
 * Issue #653 refinement: the shared settings lists size themselves to a
 * host-bounded render (the session-host sidebar pane) while every native Pi
 * popup keeps its ten-row list.
 *
 * Each case drives the shared renderers through their real custom-component
 * contract with the project's pinned pi-tui SelectList, Input, Text, and
 * Container: the retained menus (`retainedSelect`), the search-capable deny
 * picker (`retainedDenySelect`), and the sidebar's simple select/confirm
 * screens (`createSidebarReviewSettingsUi`). The SelectList is only wrapped to
 * record its constructions, so a rebuild (and its visible-row limit) is
 * observable. Everything is synthetic; nothing is persisted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  Container as PinnedContainer,
  Input as PinnedInput,
  SelectList as PinnedSelectList,
  Text as PinnedText,
} from "pi-session-host-tui";

import { boundedMenuListLimit, retainedSelect, type MenuSelectItem, type MenuSelectListTheme, type MenuTuiHost } from "../src/settings/menu";
import { retainedDenySelect, type DenyPickerRow } from "../src/settings/deny-picker";
import { createSidebarReviewSettingsUi } from "../src/session-host/review-settings-ui";
import { IDENTITY_THEME, stripAnsi } from "./menu-tui-fakes";

const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";

interface Screen {
  render(width: number, maxRows?: number): string[];
  handleInput(data: string): void;
  focused?: boolean;
}

/**
 * The pinned pi-tui host, recording the visible-row limit the live list ends up
 * with. A construction and a later `maxVisible` assignment both change that
 * limit; only a construction replaces the list, and a resize must never do so
 * while a pointer press is in progress (#723).
 */
function recordingHost(): { host: MenuTuiHost; limits: number[]; lists: PinnedSelectList[] } {
  const limits: number[] = [];
  const lists: PinnedSelectList[] = [];
  class RecordingSelectList extends PinnedSelectList {
    constructor(items: MenuSelectItem[], maxVisible: number, theme: MenuSelectListTheme) {
      super(items, maxVisible, theme);
      limits.push(maxVisible);
      lists.push(this);
      // Every later resize of THIS list is a change of its public visible-row
      // limit, recorded beside the constructions so the sequence is the limit the
      // operator was actually shown, however it was reached.
      let visible = maxVisible;
      Object.defineProperty(this, "maxVisible", {
        get: () => visible,
        set: (next: number) => {
          if (next !== visible) {
            visible = next;
            limits.push(next);
          }
        },
        configurable: true,
      });
    }
  }
  return {
    limits,
    lists,
    host: {
      SelectList: RecordingSelectList as unknown as MenuTuiHost["SelectList"],
      Container: PinnedContainer as unknown as MenuTuiHost["Container"],
      Text: PinnedText as unknown as MenuTuiHost["Text"],
      Input: PinnedInput as unknown as MenuTuiHost["Input"],
    },
  };
}

/** A per-UI custom slot that hands back the live screen and its settle promise. */
function slot(host: MenuTuiHost): {
  ui: {
    mode: string;
    menuTuiHost: MenuTuiHost;
    custom(factory: (...args: unknown[]) => unknown): Promise<string | undefined>;
    select(): Promise<string | undefined>;
    notify(): void;
  };
  screen(): Screen;
} {
  let shown: Screen | undefined;
  const ui = {
    mode: "tui",
    menuTuiHost: host,
    custom(factory: (...args: unknown[]) => unknown): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        shown = factory({ requestRender() {} }, IDENTITY_THEME, null, resolve) as Screen;
        if ("focused" in shown) shown.focused = true;
      });
    },
    async select(): Promise<string | undefined> {
      throw new Error("the plain selector must not be used");
    },
    notify(): void {},
  };
  return {
    ui,
    screen: () => {
      assert.ok(shown !== undefined, "a screen is shown");
      return shown;
    },
  };
}

const plain = (lines: readonly string[]): string[] => lines.map((line) => stripAnsi(line).trimEnd());
const itemRows = (lines: readonly string[], prefix: string): string[] => plain(lines).filter((line) => line.replace(/^\s*(→\s*)?/, "").startsWith(prefix));
const highlighted = (lines: readonly string[]): string | undefined => plain(lines).find((line) => line.trimStart().startsWith("→"))?.replace(/^\s*→\s*/, "").trim();
const scrollCue = (lines: readonly string[]): string | undefined => plain(lines).find((line) => /^\s*\(\d+\/\d+\)$/.test(line))?.trim();

const ROWS = Array.from({ length: 15 }, (_, index) => ({ key: `k${index}`, label: `Item ${String(index).padStart(2, "0")}` }));

test("boundedMenuListLimit uses every row for a complete list and reserves one for the scroll cue otherwise", () => {
  assert.equal(boundedMenuListLimit(15, 15), 15, "a complete list draws no cue");
  assert.equal(boundedMenuListLimit(15, 40), 15);
  assert.equal(boundedMenuListLimit(15, 14), 13, "a partial list leaves one row for its cue");
  assert.equal(boundedMenuListLimit(15, 2), 1);
  assert.equal(boundedMenuListLimit(15, 0), 1, "one item stays visible; the host reports too small");
  assert.equal(boundedMenuListLimit(0, 5), 0);
  assert.equal(boundedMenuListLimit(2, 1), 2, "two items take the rows of one item plus a cue");
  assert.equal(boundedMenuListLimit(2, 0), 2);
  assert.equal(boundedMenuListLimit(1, 0), 1);
  assert.equal(boundedMenuListLimit(3, 2), 1);
});

test("a native retained menu keeps the exact ten-row list and scroll cue without a bound", async () => {
  const { host, limits } = recordingHost();
  const { ui, screen } = slot(host);
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lines = screen().render(80);
  const direct = new PinnedSelectList(ROWS.map((row) => ({ value: row.key, label: row.label })), 10, {
    selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text,
  }).render(80);
  assert.deepEqual(lines.slice(1, 1 + direct.length), direct, "the native list renders byte-identically");
  assert.equal(itemRows(lines, "Item").length, 10);
  assert.equal(scrollCue(lines), "(1/15)");
  screen().handleInput(PAGE_DOWN);
  assert.equal(highlighted(screen().render(80)), "Item 10", "native page size is ten");
  assert.deepEqual(limits, [10], "one native list, never rebuilt");
  screen().handleInput(ENTER);
  assert.equal(await chosen, "k10");
});

test("a bounded retained menu shows every row when tall, scrolls when short, and keeps the selected row and page size", async () => {
  const { host, limits, lists } = recordingHost();
  const { ui, screen } = slot(host);
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS, initialKey: "k2" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let lines = screen().render(80, 30);
  assert.equal(itemRows(lines, "Item").length, 15, "more than ten rows where the pane has room");
  assert.equal(scrollCue(lines), undefined, "a complete list has no stale scroll cue");
  assert.equal(lines.length, 17, "title, every row, hint");
  assert.equal(highlighted(lines), "Item 02");
  screen().render(80, 30);
  screen().render(80, 31);
  assert.deepEqual(limits, [10, 15], "a stable limit never rebuilds the list");

  lines = screen().render(80, 6);
  assert.equal(lines.length, 6, "the measured title and hint plus three rows and the cue fill the bound");
  assert.equal(itemRows(lines, "Item").length, 3);
  assert.equal(scrollCue(lines), "(3/15)");
  assert.equal(highlighted(lines), "Item 02", "a resize keeps the selected row");
  for (let step = 0; step < 11; step += 1) screen().handleInput(DOWN);
  assert.equal(highlighted(screen().render(80, 6)), "Item 13");
  lines = screen().render(80, 40);
  assert.equal(highlighted(lines), "Item 13", "growing keeps a selection near the bottom");
  assert.equal(itemRows(lines, "Item").length, 15);
  lines = screen().render(80, 6);
  assert.equal(highlighted(lines), "Item 13");
  assert.deepEqual(limits, [10, 15, 3, 15, 3]);
  assert.equal(lists.length, 1, "every resize resized the SAME list; none replaced it");

  // Page navigation uses the visible size of the current list.
  screen().handleInput("\x1b[5~");
  assert.equal(highlighted(screen().render(80, 6)), "Item 10", "page up moves by the three visible rows");
  screen().handleInput(ENTER);
  assert.equal(await chosen, "k10", "Enter answers the row the resized list kept");
});

test("a bounded render measures wrapped chrome at its width and never under-fills or overflows", async () => {
  const { host } = recordingHost();
  const { ui, screen } = slot(host);
  void retainedSelect(ui as never, { title: "A long settings title that wraps across several narrow rows", rows: ROWS });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const chrome = screen().render(24, 100).length - ROWS.length;
  assert.ok(chrome > 2, "the title and hint wrap at this width");
  for (const bound of [chrome + 2, chrome + 5, chrome + 14]) {
    const lines = screen().render(24, bound);
    assert.equal(lines.length, bound, `bound ${bound} is filled exactly`);
    assert.ok(scrollCue(lines) !== undefined);
  }
  const tooSmall = screen().render(24, chrome + 1);
  assert.equal(tooSmall.length, chrome + 2, "an impossible bound renders taller so the host shows too small");
});

const TOOL_ROWS: DenyPickerRow[] = [
  ...Array.from({ length: 30 }, (_, index) => ({ key: `tool:t${index}`, label: `tool_${String(index).padStart(2, "0")}  ✗ allowed`, searchText: `tool_${String(index).padStart(2, "0")}` })),
  { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
];

test("the deny picker list follows the bound while its query, filter, and selection stay its own", async () => {
  const { host, limits, lists } = recordingHost();
  const { ui, screen } = slot(host);
  const picked = retainedDenySelect(ui as never, { title: "Top-level tools", rows: TOOL_ROWS });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const native = screen().render(80);
  assert.equal(itemRows(native, "tool_").length, 10, "the native picker keeps ten rows");
  let lines = screen().render(80, 40);
  assert.equal(itemRows(lines, "tool_").length + itemRows(lines, "Back").length, 31, "every row fits a tall pane");
  assert.equal(scrollCue(lines), undefined);

  for (const key of ["t", "o", "o", "l", "_", "1"]) screen().handleInput(key);
  lines = screen().render(80, 40);
  assert.equal(plain(lines)[1], "> tool_1", "the query row stays where the caret route expects it");
  const matches = itemRows(lines, "tool_").length;
  assert.ok(matches >= 10, "the narrowed list is complete");
  screen().handleInput(DOWN);
  screen().handleInput(DOWN);
  const target = highlighted(screen().render(80, 40));
  const before = limits.length;
  const built = lists.length;
  lines = screen().render(80, 8);
  assert.equal(lines.length, 8);
  assert.equal(plain(lines)[1], "> tool_1");
  assert.equal(highlighted(lines), target, "shrinking keeps the picker's own selection");
  assert.ok(scrollCue(lines) !== undefined);
  screen().render(80, 8);
  assert.equal(limits.length, before + 1, "one new visible-row limit for the new size, none for a stable one");
  assert.equal(lists.length, built, "the resize reassigned the SAME list's limit instead of replacing it");

  screen().handleInput("\x7f"); // Backspace widens the filter; the row stays highlighted.
  lines = screen().render(80, 8);
  assert.equal(highlighted(lines), target);
  assert.equal(lines.length, 8);
  screen().handleInput(ENTER);
  const result = await picked;
  assert.equal(result.query, "tool_");
  assert.equal(TOOL_ROWS.find((row) => row.key === result.key)?.label.split(" ")[0], target?.split(" ")[0]);
});

test("the sidebar's simple select and confirm screens follow the bound and keep their answer", async () => {
  const { host, limits } = recordingHost();
  let shown: Screen | undefined;
  const ui = createSidebarReviewSettingsUi({
    custom: (factory) => new Promise<string | undefined>((resolve) => {
      shown = factory({ requestRender() {} }, IDENTITY_THEME, null, resolve) as Screen;
    }),
    editText: async () => undefined,
    notify: () => {},
    menuTuiHost: host,
  });
  const options = Array.from({ length: 25 }, (_, index) => `Option ${String(index).padStart(2, "0")}`);
  const selected = ui.select("Pick one", options);
  assert.ok(shown !== undefined);
  assert.equal(itemRows(shown.render(80), "Option").length, 10, "an unbounded render keeps ten rows");
  assert.equal(itemRows(shown.render(80, 40), "Option").length, 25);
  for (let step = 0; step < 22; step += 1) shown.handleInput(DOWN);
  const short = shown.render(80, 7);
  assert.equal(short.length, 7);
  assert.equal(highlighted(short), "Option 22");
  shown.handleInput(ENTER);
  assert.equal(await selected, "Option 22");
  assert.deepEqual(limits, [10, 25, 4]);

  const confirmed = ui.confirm!("Really?", "A message");
  const confirmLines = shown.render(80, 20);
  assert.equal(highlighted(confirmLines), "No", "a confirm still defaults to No");
  assert.equal(scrollCue(confirmLines), undefined);
  shown.handleInput(ENTER);
  assert.equal(await confirmed, false);
});
