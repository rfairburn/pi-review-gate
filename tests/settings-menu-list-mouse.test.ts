/**
 * Issue #723: native row clicks and wheel routing on the shared Review settings
 * surfaces.
 *
 * Every case drives a REAL shared renderer (`retainedSelect`, `retainedDenySelect`)
 * through its custom-component contract with the project's PINNED pi-tui
 * `SelectList`, `Input`, `Text`, and `Container`, and delivers the same
 * normalized events Pi's own TUI would deliver. The pinned list is the only
 * authority on what a pointer does: a left `press` on a drawn row highlights it,
 * a completed left `click` activates exactly once, one `wheel` report steps the
 * highlight one row inside the clamped range, and hover, motion, a bare release,
 * or a non-primary button consume nothing. This file proves the wrappers route
 * through the list's REAL rendered bounds (measured from its own render, so a
 * wrapped title or a scroll cue never shifts the mapping) and never invent a
 * handled result for an event the native list refused.
 *
 * Nothing is persisted and no real config, provider, or Pi session is touched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  Container as PinnedContainer,
  CURSOR_MARKER,
  Input as PinnedInput,
  SelectList as PinnedSelectList,
  Text as PinnedText,
} from "pi-session-host-tui";

import { retainedSelect, setMenuTuiHost, menuRenderTheme, createMenuListViewport, createMenuListPointer, boundedMenuListLimit, type MenuTuiHost } from "../src/settings/menu";
import { retainedDenySelect, type DenyPickerRow } from "../src/settings/deny-picker";
import type { TextFieldMouseEvent } from "../src/text-field-mouse";
import { IDENTITY_THEME, stripAnsi } from "./menu-tui-fakes";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";

/** One normalized pointer event, in the receiving component's own coordinates. */
function mouse(
  type: TextFieldMouseEvent["type"],
  x: number,
  y: number,
  width: number,
  height: number,
  extra: { button?: TextFieldMouseEvent["button"]; wheelDelta?: number } = {},
): TextFieldMouseEvent {
  return {
    type,
    button: extra.button ?? "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === "click" ? { clickCount: 1 } : {}),
    ...(type === "wheel" ? { wheelDelta: extra.wheelDelta ?? 0 } : {}),
  };
}

interface PointerScreen {
  render(width: number, maxRows?: number): readonly string[];
  handleInput(data: string): void;
  handleMouse?(event: TextFieldMouseEvent): { handled?: boolean } | undefined;
  focused?: boolean;
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
  screen(): PointerScreen;
} {
  let shown: PointerScreen | undefined;
  const ui = {
    mode: "tui",
    menuTuiHost: host,
    custom(factory: (...args: unknown[]) => unknown): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        shown = factory({ requestRender() {} }, IDENTITY_THEME, null, resolve) as PointerScreen;
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

const PINNED_HOST: MenuTuiHost = {
  SelectList: PinnedSelectList as unknown as MenuTuiHost["SelectList"],
  Container: PinnedContainer as unknown as MenuTuiHost["Container"],
  Text: PinnedText as unknown as MenuTuiHost["Text"],
  Input: PinnedInput as unknown as MenuTuiHost["Input"],
};

const plain = (lines: readonly string[]): string[] => lines.map((line) => stripAnsi(line).trimEnd());
const highlighted = (lines: readonly string[]): string | undefined =>
  plain(lines).find((line) => line.trimStart().startsWith("→"))?.replace(/^\s*→\s*/, "").trim();
/** The component-local row this render drew the given label on (-1 when absent). */
function rowOf(lines: readonly string[], label: string): number {
  return plain(lines).findIndex((line) => line.trimStart().replace(/^→\s*/, "") === label);
}

/** True once `promise` settled, without ever awaiting it. */
function settled(promise: Promise<unknown>, sink: (value: unknown) => void): void {
  void promise.then(sink, sink);
}

/**
 * The plain-text column the NATIVE Input renders its own caret marker at on
 * this raw line (-1 when the line carries none). The marker is pi-tui's own
 * zero-width cursor, so this reads where the editor put the caret without the
 * test changing what is typed.
 */
function caretColumn(lines: readonly string[], row: number): number {
  const marker = (lines[row] ?? "").indexOf(CURSOR_MARKER);
  return marker < 0 ? -1 : stripAnsi((lines[row] ?? "").slice(0, marker)).length;
}

const ROWS = Array.from({ length: 15 }, (_, index) => ({
  key: `k${String(index).padStart(2, "0")}`,
  label: `Item ${String(index).padStart(2, "0")}`,
}));

test("a retained menu: a left press highlights the drawn row and answers nothing", async () => {
  const { ui, screen } = slot(PINNED_HOST);
  const answers: unknown[] = [];
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS });
  settled(chosen, (value) => answers.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const width = 80;
  const lines = screen().render(width);
  const row = rowOf(lines, "Item 04");
  assert.ok(row > 0, lines.join("\n"));
  assert.equal(highlighted(lines), "Item 00", "the menu opens on its first row");

  const result = screen().handleMouse?.(mouse("press", 4, row, width, lines.length));
  assert.equal(result?.handled, true, "the native list consumed the press");
  assert.equal(highlighted(screen().render(width)), "Item 04", "the press highlighted the row under the pointer");
  assert.deepEqual(answers, [], "a press activates nothing");

  // The row the press landed on is exactly the drawn row, not an assumed offset:
  // a press one row lower moves the highlight one row lower.
  screen().handleMouse?.(mouse("press", 4, row + 1, width, lines.length));
  assert.equal(highlighted(screen().render(width)), "Item 05");
  void chosen;
});

test("a retained menu: a completed left click activates exactly once", async () => {
  const { ui, screen } = slot(PINNED_HOST);
  const answers: unknown[] = [];
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS });
  settled(chosen, (value) => answers.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const width = 80;
  const lines = screen().render(width);
  const row = rowOf(lines, "Item 07");
  assert.ok(row > 0);
  screen().handleMouse?.(mouse("press", 3, row, width, lines.length));
  screen().handleMouse?.(mouse("click", 3, row, width, lines.length));
  assert.equal(await chosen, "k07");

  // Nothing is forwarded once the menu answered: a second completed click, a
  // press, and a key all leave the single answer alone.
  screen().handleMouse?.(mouse("press", 3, row, width, lines.length));
  screen().handleMouse?.(mouse("click", 3, row, width, lines.length));
  screen().handleInput(ENTER);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(answers, ["k07"], "the menu answered once");
});

test("a retained menu: hover, motion, a bare release, and a non-primary button do nothing", async () => {
  const { ui, screen } = slot(PINNED_HOST);
  const answers: unknown[] = [];
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS });
  settled(chosen, (value) => answers.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const width = 80;
  const lines = screen().render(width);
  const row = rowOf(lines, "Item 03");
  assert.ok(row > 0);
  for (const event of [
    mouse("move", 3, row, width, lines.length),
    mouse("drag", 3, row, width, lines.length),
    mouse("release", 3, row, width, lines.length),
    mouse("press", 3, row, width, lines.length, { button: "right" }),
    mouse("click", 3, row, width, lines.length, { button: "right" }),
    mouse("press", 3, row, width, lines.length, { button: "middle" }),
  ]) {
    assert.equal(screen().handleMouse?.(event), undefined, `${event.type}/${event.button} is refused`);
  }
  assert.equal(highlighted(screen().render(width)), "Item 00", "nothing moved the highlight");
  assert.deepEqual(answers, [], "nothing activated");
  void chosen;
});

test("a retained menu: a click on a title, hint, border, or undrawn row is refused", async () => {
  const { ui, screen } = slot(PINNED_HOST);
  const answers: unknown[] = [];
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS });
  settled(chosen, (value) => answers.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const width = 80;
  const lines = screen().render(width);
  const first = rowOf(lines, "Item 00");
  const last = rowOf(lines, "Item 09");
  assert.ok(first > 0 && last > first, lines.join("\n"));
  // Every row above the first drawn list row (border, wrapped title) and below
  // the last one (the scroll cue, the hint, the closing border) is chrome.
  for (const y of [0, first - 1, last + 1, last + 2, lines.length - 1]) {
    assert.equal(screen().handleMouse?.(mouse("press", 4, y, width, lines.length)), undefined,
      `row ${y} is not a drawn row`);
    assert.equal(screen().handleMouse?.(mouse("click", 4, y, width, lines.length)), undefined,
      `row ${y} is not a drawn row`);
  }
  // A width the last render did not use describes nothing the operator was shown.
  assert.equal(screen().handleMouse?.(mouse("press", 4, first, width - 10, lines.length)), undefined);
  assert.equal(highlighted(screen().render(width)), "Item 00");
  assert.deepEqual(answers, []);
  void chosen;
});

test("a retained menu: one wheel report steps one clamped row and activates nothing", async () => {
  const { ui, screen } = slot(PINNED_HOST);
  const answers: unknown[] = [];
  const chosen = retainedSelect(ui as never, { title: "Root", rows: ROWS });
  settled(chosen, (value) => answers.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const width = 80;
  const lines = screen().render(width);
  const row = rowOf(lines, "Item 02");
  assert.ok(row > 0);
  const wheel = (delta: number): void => {
    assert.equal(screen().handleMouse?.(mouse("wheel", 4, row, width, lines.length, { wheelDelta: delta }))?.handled, true);
  };

  // Up at the top stays clamped at the first row.
  wheel(-1);
  assert.equal(highlighted(screen().render(width)), "Item 00");
  // Each report is exactly one row down.
  wheel(1);
  assert.equal(highlighted(screen().render(width)), "Item 01");
  wheel(1);
  assert.equal(highlighted(screen().render(width)), "Item 02");
  // And one row up.
  wheel(-1);
  assert.equal(highlighted(screen().render(width)), "Item 01");
  // A report with no delta is not a notch.
  assert.equal(screen().handleMouse?.(mouse("wheel", 4, row, width, lines.length, { wheelDelta: 0 })), undefined);
  assert.equal(highlighted(screen().render(width)), "Item 01");

  // Down past the end of the list clamps at the last row.
  for (let step = 0; step < 40; step += 1) wheel(1);
  assert.equal(highlighted(screen().render(width)), "Item 14", "the highlight clamps at the last row");
  assert.deepEqual(answers, [], "a wheel activates nothing");
  void chosen;
});

test("a bounded retained menu routes to the rows IT drew after a wrapped title", async () => {
  const host: MenuTuiHost = {
    ...PINNED_HOST,
    Text: class extends PinnedText {
      constructor(text: string, paddingX = 0, paddingY = 0) {
        // A title that wraps to several rows: the list's first row moves down.
        super(text.startsWith("Long title") ? "Long title ".repeat(12) : text, paddingX, paddingY);
      }
    } as unknown as MenuTuiHost["Text"],
  };
  const { ui, screen } = slot(host);
  const answers: unknown[] = [];
  const chosen = retainedSelect(ui as never, { title: "Long title", rows: ROWS });
  settled(chosen, (value) => answers.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const width = 40;
  const lines = screen().render(width, 12);
  const first = rowOf(lines, "Item 00");
  const second = rowOf(lines, "Item 01");
  assert.ok(first > 1 && second === first + 1, lines.join("\n"));
  screen().handleMouse?.(mouse("press", 4, first, width, lines.length));
  assert.equal(highlighted(screen().render(width, 12)), "Item 00");
  screen().handleMouse?.(mouse("press", 4, second, width, lines.length));
  assert.equal(highlighted(screen().render(width, 12)), "Item 01");
  screen().handleMouse?.(mouse("click", 4, second, width, lines.length));
  assert.equal(await chosen, "k01", "the click activated the drawn row under the pointer");
  assert.deepEqual(answers, ["k01"]);
});

const DENY_ROWS: DenyPickerRow[] = Array.from({ length: 12 }, (_, index) => ({
  key: `tool:${index}`,
  label: `tool_${String(index).padStart(2, "0")}`,
  searchText: `tool_${String(index).padStart(2, "0")}`,
}));
DENY_ROWS.push({ key: "back", label: "Back", searchText: "back", alwaysVisible: true });

/** The deny picker under the pinned host, with its live screen exposed. */
function denyPicker(query = ""): {
  picked: Promise<{ key: string | undefined; query: string }>;
  screen: () => PointerScreen;
  width: number;
} {
  const width = 60;
  let shown: PointerScreen | undefined;
  const ui = {
    mode: "tui",
    custom(factory: (...args: unknown[]) => unknown): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        shown = factory({ requestRender() {} }, IDENTITY_THEME, null, resolve) as PointerScreen;
        if ("focused" in shown) shown.focused = true;
      });
    },
    async select(): Promise<string | undefined> {
      throw new Error("the plain selector must not be used");
    },
    notify(): void {},
  };
  setMenuTuiHost(PINNED_HOST);
  const picked = retainedDenySelect(ui as never, { title: "Top-level tools", rows: DENY_ROWS, query });
  return { picked, screen: () => shown!, width };
}

test("the deny picker: a row click toggles exactly the row the press highlighted", async () => {
  const { picked, screen, width } = denyPicker();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lines = screen().render(width);
  const queryRow = plain(lines).findIndex((line) => line.trimEnd() === ">");
  const row = rowOf(lines, "tool_04");
  assert.ok(queryRow >= 0 && row > queryRow, lines.join("\n"));

  const answers: unknown[] = [];
  settled(picked, (value) => answers.push(value));

  screen().handleMouse?.(mouse("press", 6, row, width, lines.length));
  assert.equal(highlighted(screen().render(width)), "tool_04", "the press highlighted the drawn row");
  assert.deepEqual(answers, [], "a press toggles nothing");
  screen().handleMouse?.(mouse("click", 6, row, width, lines.length));
  const result = await picked;
  assert.equal(result.key, "tool:4");
  assert.deepEqual(answers, [result], "the picker answered once");
});

test("the deny picker: a row press adopts the selection, so the keyboard continues from it", async () => {
  const { picked, screen, width } = denyPicker();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lines = screen().render(width);
  const row = rowOf(lines, "tool_05");
  assert.ok(row > 0, lines.join("\n"));

  screen().handleMouse?.(mouse("press", 6, row, width, lines.length));
  // The picker stays the selection OWNER: Enter toggles the row the press
  // highlighted, and one more Down continues from there rather than from 0.
  screen().handleInput(ENTER);
  assert.equal((await picked).key, "tool:5");
});

test("the deny picker: the query row and the rows never both take one press", async () => {
  // A query that keeps result rows drawn, so one coordinate is always either
  // the editor's row or a list row, and the two routes can be compared.
  const { picked, screen, width } = denyPicker("tool_0");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const answers: unknown[] = [];
  settled(picked, (value) => answers.push(value));

  let lines = screen().render(width);
  const queryRow = plain(lines).findIndex((line) => line.trimEnd() === "> tool_0");
  const row = rowOf(lines, "tool_04");
  assert.ok(queryRow >= 0 && row > queryRow, plain(lines).join("\n"));
  const caretAtOpen = caretColumn(lines, queryRow);
  const highlightedAtOpen = highlighted(lines);
  assert.ok(caretAtOpen > 0, `the picker opens with its caret on the query: ${lines[queryRow]}`);

  // A press inside the query row is the editor's, and it changes nothing else:
  // the native Input moves its own caret marker, the highlighted row stays, and
  // no row is toggled.
  assert.equal(screen().handleMouse?.(mouse("press", 3, queryRow, width, lines.length))?.handled, true,
    "the native Input took the query press");
  lines = screen().render(width);
  const caretInQuery = caretColumn(lines, queryRow);
  assert.ok(caretInQuery >= 0 && caretInQuery < caretAtOpen, "the caret moved inside the query");
  assert.equal(plain(lines)[queryRow]?.trimEnd(), "> tool_0", "the query text is unchanged");
  assert.equal(highlighted(lines), highlightedAtOpen, "a query press highlights no row");
  assert.deepEqual(answers, [], "a query press never toggles a row");

  // A press on a row is the list's: it highlights that row and moves no caret.
  assert.equal(screen().handleMouse?.(mouse("press", 6, row, width, lines.length))?.handled, true);
  lines = screen().render(width);
  assert.equal(highlighted(lines), "tool_04");
  assert.equal(caretColumn(lines, queryRow), caretInQuery, "the caret did not move");

  screen().handleMouse?.(mouse("click", 6, row, width, lines.length));
  const result = await picked;
  assert.equal(result.key, "tool:4", "the row click toggled the row, not the query");
  assert.equal(result.query, "tool_0", "the query survived the row click unchanged");
});

test("the shared seam refuses a press against a replacement list, even an identical-looking one", () => {
  const items = Array.from({ length: 12 }, (_unused, index) => ({ value: `v${index}`, label: `row_${index}` }));
  const viewport = createMenuListViewport({
    host: PINNED_HOST,
    theme: menuRenderTheme.selectListTheme(PINNED_HOST, IDENTITY_THEME),
    items,
    nativeLimit: (count) => Math.min(Math.max(count, 1), 10),
  });
  const pointer = createMenuListPointer(viewport);
  // The seam measures exactly what a render would: the list's own rows.
  void viewport.component.render(30);
  pointer.track(30, 0);

  // The consumer replaces the rows. These are the SAME item objects, so the
  // selected item is identical; only the list instance differs, and the drawn
  // bounds were measured from the instance that no longer exists.
  const before = viewport.list;
  viewport.replace(items, 0);
  assert.notEqual(viewport.list, before, "replace really built a new list");
  assert.equal(viewport.list.getSelectedItem?.(), before.getSelectedItem?.(),
    "the selection identity alone cannot tell the two lists apart");
  assert.equal(pointer.route(mouse("press", 2, 2, 30, 11)), undefined,
    "a press is refused against a list the bounds were never measured from");

  // Once the consumer renders and records the new list, the same press works.
  void viewport.component.render(30);
  pointer.track(30, 0);
  assert.equal(pointer.route(mouse("press", 2, 2, 30, 11))?.handled, true);
});

test("a bounded resize keeps the same native list, so an in-progress press keeps its row", () => {
  const items = Array.from({ length: 12 }, (_unused, index) => ({ label: `row_${index}`, value: `v${index}` }));
  const viewport = createMenuListViewport({
    host: PINNED_HOST,
    theme: menuRenderTheme.selectListTheme(PINNED_HOST, IDENTITY_THEME),
    items,
    nativeLimit: (count) => Math.min(Math.max(count, 1), 10),
  });
  const before = viewport.list;
  // A pointer press that has not completed yet, on the row drawn third.
  assert.equal(viewport.list.handleMouse?.(mouse("press", 2, 2, 30, 4))?.handled, true);

  // The host bounds the list for a shorter render. Only its visible-row limit
  // changes: the SAME list carries its selection, its scroll window, and the
  // press that is still in progress.
  viewport.fit(3);
  assert.equal(viewport.list, before, "the resize resizes the SAME native list");
  assert.equal(
    (viewport.list as unknown as { maxVisible: number }).maxVisible,
    boundedMenuListLimit(items.length, 3),
    "the pinned list's own public limit is what changed",
  );

  let activated: string | undefined;
  viewport.list.onSelect = (item: { value: string }): void => { activated = item.value; };
  // The window moved with the selection, so this cell now holds a different row:
  // only the identity the press established can answer correctly.
  viewport.list.handleMouse?.(mouse("click", 2, 0, 30, 4));
  assert.equal(activated, "v2", "the click completes the row the press highlighted, not the cell it lands in");
});

test("the deny picker: a click after a filter change activates nothing", async () => {
  const { picked, screen, width } = denyPicker();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const answers: unknown[] = [];
  settled(picked, (value) => answers.push(value));

  let lines = screen().render(width);
  const row = rowOf(lines, "tool_00");
  assert.ok(row > 0, plain(lines).join("\n"));
  // Pi keeps THIS wrapper as the press target and still delivers the stationary
  // click after whatever happened in between, so a click cannot be trusted on
  // its own.
  assert.equal(screen().handleMouse?.(mouse("press", 6, row, width, lines.length))?.handled, true);
  lines = screen().render(width);
  assert.equal(highlighted(lines), "tool_00");

  // The query edit REPLACES the result list: the list the press landed on is
  // gone, and a different tool now occupies the pressed cell.
  screen().handleInput("1");
  lines = screen().render(width);
  const nowAtRow = highlighted(lines);
  assert.ok(nowAtRow !== undefined && nowAtRow !== "tool_00", plain(lines).join("\n"));

  screen().handleMouse?.(mouse("release", 6, row, width, lines.length));
  assert.equal(screen().handleMouse?.(mouse("click", 6, row, width, lines.length)), undefined,
    "a click whose list no longer exists is never forwarded");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(answers, [], "nothing toggled");

  // The picker's own pointer route still answers a press and click that belong
  // to the live list.
  const fresh = screen().render(width);
  const target = rowOf(fresh, nowAtRow);
  assert.ok(target >= 0, plain(fresh).join("\n"));
  assert.equal(screen().handleMouse?.(mouse("press", 6, target, width, fresh.length))?.handled, true);
  screen().handleMouse?.(mouse("click", 6, target, width, fresh.length));
  const result = await picked;
  assert.equal(result.key, `tool:${Number(nowAtRow.slice("tool_".length))}`, `the live list answers its own press: ${nowAtRow}`);
  assert.equal(result.query, "1", "the query survived unchanged");
});

test("the deny picker: its rows wheel one clamped row and activate nothing", async () => {
  const { picked, screen, width } = denyPicker();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const answers: unknown[] = [];
  settled(picked, (value) => answers.push(value));
  const lines = screen().render(width);
  const row = rowOf(lines, "tool_00");
  assert.ok(row > 0, lines.join("\n"));

  assert.equal(highlighted(screen().render(width)), "tool_00");
  // Up at the first row stays clamped.
  assert.equal(screen().handleMouse?.(mouse("wheel", 6, row, width, lines.length, { wheelDelta: -1 }))?.handled, true);
  assert.equal(highlighted(screen().render(width)), "tool_00");
  for (const expected of ["tool_01", "tool_02"]) {
    assert.equal(screen().handleMouse?.(mouse("wheel", 6, row, width, lines.length, { wheelDelta: 1 }))?.handled, true);
    assert.equal(highlighted(screen().render(width)), expected);
  }
  // Down to the last row (the always-visible Back row) and past it: clamped.
  for (let step = 0; step < 30; step += 1) {
    screen().handleMouse?.(mouse("wheel", 6, row, width, lines.length, { wheelDelta: 1 }));
  }
  assert.equal(highlighted(screen().render(width)), "Back", "the highlight clamps at the last row");
  assert.deepEqual(answers, [], "a wheel activates nothing");
  // The query row is not part of the list: a wheel there is refused.
  const queryRow = plain(screen().render(width)).findIndex((line) => line.trimEnd() === ">");
  assert.equal(screen().handleMouse?.(mouse("wheel", 2, queryRow, width, lines.length, { wheelDelta: 1 })), undefined);
});
