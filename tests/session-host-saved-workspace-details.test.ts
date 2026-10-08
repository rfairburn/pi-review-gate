/**
 * Saved conversation workspace details tests for the optional custom session
 * host sidebar (#323 alpha).
 *
 * The saved pane now carries the recorded workspace (cwd) from the catalog:
 *  - Each saved row renders as ONE line: `caption | cwd` (fair bounded width,
 *    visible ellipsis) or just `caption` when no cwd was recorded.
 *  - A fixed DETAILS area (3 rows) below the list shows more of the selected
 *    public caption and a bounded portion of the recorded workspace (wrapped,
 *    visibly ellipsized when it cannot fit), updating with selection.
 *  - Missing cwd shows "unavailable", never a fabricated currentWorkspace.
 *  - Long paths/public captions show explicit ellipsis; the pane guards the footer and
 *    selection at narrow widths.
 *
 * Display-only: clipping never changes the opaque id/file, admission order, or
 * persisted name. Everything is pure frontend.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  type SidebarSavedRow,
  SidebarController,
} from "../src/session-host/sidebar";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT_LEGACY = "\x1b[1;3D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

function makeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: `label-${overrides.id}`,
    workspace: `/ws/${overrides.id}`,
    agentDir: `/agents/${overrides.id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    ...overrides,
  };
}

function makeRow(overrides: Partial<SidebarSavedRow> & { id: string }): SidebarSavedRow {
  return {
    file: `${overrides.id}.jsonl`,
    caption: `Conversation ${overrides.id}`,
    ...overrides,
  };
}

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  sinceActions(): SidebarAction[];
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  return {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
    sinceActions: () => actions.slice(0),
  };
}

/** Opens the saved picker and completes it with the given rows (request-fenced). */
function openSavedPane(rows: readonly SidebarSavedRow[], options: SidebarControllerOptions = {}): Harness {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(UP); // default selection "new" -> Saved entry
  // Render the roster so the complete-card action fence knows the Saved entry
  // was fully drawn; without this, Enter refuses to open the picker.
  void harness.controller.render(40, 30);
  harness.send(ENTER); // emit saved-list, open the picker (form focus)
  assert.equal(harness.controller.focus, "form", "the picker occupies the form pane slot");
  const listAction = harness.actions.at(-1);
  assert.ok(listAction?.type === "saved-list", `expected saved-list, got ${JSON.stringify(listAction)}`);
  const requestId = listAction!.type === "saved-list" ? listAction.requestId : -1;
  assert.equal(harness.controller.completeSavedList(requestId, rows.map((row) => ({ ...row })), 0), true);
  return harness;
}

function assertPaneSafe(lines: string[], cols: number): string[] {
  for (const line of lines) {
    const sgrs = line.match(SGR_PATTERN) ?? [];
    for (const sgr of sgrs) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in line ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than pane`);
  }
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

function savedTexts(controller: SidebarController, cols = 40, rows = 12): string[] {
  return assertPaneSafe(controller.render(cols, rows).lines, cols);
}

test("a saved row with cwd renders one line as caption | cwd", () => {
  const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/a" })]);
  const texts = savedTexts(harness.controller);
  assert.ok(
    texts.some((line) => /Conversation a\s*\|\s*\/work\/a/.test(line)),
    `missing single-line caption | cwd: ${JSON.stringify(texts)}`,
  );
});

test("a saved row without cwd renders just the caption (no separator)", () => {
  const harness = openSavedPane([makeRow({ id: "a" })]);
  const texts = savedTexts(harness.controller);
  assert.ok(
    texts.some((line) => line.includes("> Conversation a") && !line.includes("|")),
    `missing caption-only row: ${JSON.stringify(texts)}`,
  );
});

test("two rows with the same caption but different cwd stay distinct single lines", () => {
  const harness = openSavedPane([
    makeRow({ id: "a", caption: "Same name", cwd: "/work/a" }),
    makeRow({ id: "b", caption: "Same name", cwd: "/work/b" }),
  ]);
  const texts = savedTexts(harness.controller);
  assert.ok(texts.some((line) => /Same name\s*\|\s*\/work\/a/.test(line)), JSON.stringify(texts));
  assert.ok(texts.some((line) => /Same name\s*\|\s*\/work\/b/.test(line)), JSON.stringify(texts));
});

test("the details area shows the selected caption and recorded workspace", () => {
  const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/a" })]);
  const texts = savedTexts(harness.controller);
  assert.ok(
    texts.some((line) => line.includes("/work/a") && !line.includes("|")),
    `details should show the full workspace (wrapped, no separator): ${JSON.stringify(texts)}`,
  );
});

test("selection changes update the details area to the new row's workspace", () => {
  const harness = openSavedPane([
    makeRow({ id: "a", caption: "First", cwd: "/work/a" }),
    makeRow({ id: "b", caption: "Second", cwd: "/work/b" }),
  ]);
  let texts = savedTexts(harness.controller);
  assert.ok(texts.some((line) => line.includes("/work/a")), `initial details should show /work/a`);
  harness.send(DOWN); // select the second row
  texts = savedTexts(harness.controller);
  assert.ok(
    texts.some((line) => line.includes("/work/b") && !line.includes("|")),
    `details should update to /work/b: ${JSON.stringify(texts)}`,
  );
});

test("missing cwd shows unavailable in the details area (never fabricated)", () => {
  const harness = openSavedPane([makeRow({ id: "a" })]);
  const texts = savedTexts(harness.controller);
  assert.ok(
    texts.some((line) => line.includes("unavailable")),
    `missing cwd should show unavailable: ${JSON.stringify(texts)}`,
  );
});

test("a long workspace path is ellipsized in the single line and wrapped in details", () => {
  const longPath = `/work/${"deeply-nested-directory".repeat(20)}`;
  const harness = openSavedPane([makeRow({ id: "a", cwd: longPath })]);
  const texts = savedTexts(harness.controller, 40, 12);
  const rowLine = texts.find((line) => line.includes("Conversation a"));
  assert.ok(rowLine, `missing saved row: ${JSON.stringify(texts)}`);
  assert.ok(rowLine.includes("..."), `long cwd should be ellipsized in the single line: ${JSON.stringify(rowLine)}`);
  assert.ok(
    texts.some((line) => line.includes("deeply-nested-directory")),
    `bounded details should show wrapped workspace content: ${JSON.stringify(texts)}`,
  );
});

test("a workspace path longer than one row but fitting two is fully wrapped, not ellipsized", () => {
  // 45 chars: wider than one 40-col row but fits across the two reserved rows.
  const path = `/work/${"abcdefghij".repeat(4)}`; // /work/ + 40 = 46 chars
  assert.ok(visibleWidth(path) > 40 && visibleWidth(path) <= 80, `path width ${visibleWidth(path)}`);
  const harness = openSavedPane([makeRow({ id: "a", cwd: path })]);
  const texts = savedTexts(harness.controller, 40, 12);
  // The details area wraps the full path across two rows with no ellipsis.
  const detailLines = texts.filter((line) => line.includes("abcdefghij"));
  assert.ok(detailLines.length >= 1, `path should be wrapped in details: ${JSON.stringify(texts)}`);
  assert.ok(
    !detailLines.some((line) => line.includes("...")),
    `a path fitting two rows must not be ellipsized: ${JSON.stringify(detailLines)}`,
  );
});

test("a long multiword caption is capped so the workspace stays visible", () => {
  const longCaption = "a very long conversation caption that keeps going and going";
  const harness = openSavedPane([makeRow({ id: "a", caption: longCaption, cwd: "/short" })]);
  const texts = savedTexts(harness.controller, 40, 12);
  // The workspace is reserved its own capacity and is shown in full.
  assert.ok(
    texts.some((line) => line.trim() === "/short"),
    `workspace should be visible despite the long caption: ${JSON.stringify(texts)}`,
  );
});

test("repeated spaces in a recorded workspace are preserved, not collapsed", () => {
  const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/a  b" })]);
  const texts = savedTexts(harness.controller, 40, 12);
  assert.ok(
    texts.some((line) => line.includes("/work/a  b")),
    `repeated spaces should be preserved: ${JSON.stringify(texts)}`,
  );
});

test("wide Unicode in the workspace is column-safe and bounded", () => {
  const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/日本語" })]);
  const texts = savedTexts(harness.controller, 40, 12);
  assert.ok(
    texts.some((line) => line.includes("日本語")),
    `wide Unicode should be preserved: ${JSON.stringify(texts)}`,
  );
  // Every rendered row stays within the pane width.
  for (const line of savedTexts(harness.controller, 40, 12)) {
    assert.ok(visibleWidth(line) <= 40, `row wider than pane: ${JSON.stringify(line)}`);
  }
});

test("the saved pane stays usable at a narrow width (footer and selection preserved)", () => {
  const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/a" })]);
  const texts = savedTexts(harness.controller, 26, 10);
  assert.ok(texts.some((line) => line.includes("Saved conversations")), JSON.stringify(texts));
  // The single-line summary uses a fair half-width allocation, so at this
  // narrow width the caption is visibly ellipsized while the workspace stays.
  const selected = texts.find((line) => line.startsWith("> "));
  assert.ok(selected, `missing selected row: ${JSON.stringify(texts)}`);
  assert.ok(selected.includes("..."), `caption should be ellipsized: ${JSON.stringify(selected)}`);
  assert.ok(selected.includes("/work/a"), `workspace should be visible: ${JSON.stringify(selected)}`);
  // The details area shows the exact recorded workspace for the selected row.
  assert.ok(
    texts.some((line) => line.trim() === "/work/a"),
    `details should show the exact workspace: ${JSON.stringify(texts)}`,
  );
  assert.ok(texts.some((line) => line.includes("enter open")), "footer preserved");
});

test("the saved pane is honestly too-small when it cannot fit list + details + footer", () => {
  const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/a" })]);
  const texts = savedTexts(harness.controller, 26, 7);
  assert.ok(texts.some((line) => line.includes("too small")), JSON.stringify(texts));
});

test("Saved Enter refuses a selection after every too-small fallback", () => {
  for (const [cols, rows] of [[20, 12], [40, 5], [26, 7]]) {
    const harness = openSavedPane([makeRow({ id: "a", cwd: "/work/a" })]);
    savedTexts(harness.controller, 40, 12);
    const fallback = savedTexts(harness.controller, cols, rows);
    assert.ok(fallback.some((line) => line.includes("too small")));
    harness.send(ENTER);
    assert.equal(
      harness.actions.some((action) => action.type === "saved-open"),
      false,
      `Enter after too-small fallback (${cols}x${rows}) must not open`,
    );
  }
});

test("Saved Enter refuses an undrawn selection until redraw", () => {
  const harness = openSavedPane([
    makeRow({ id: "a" }), makeRow({ id: "b" }), makeRow({ id: "c" }),
  ]);
  // Before any picker render, the display record is empty; Enter is refused.
  harness.send(ENTER);
  assert.equal(
    harness.actions.some((action) => action.type === "saved-open"),
    false,
    "Enter before a picker render must not open",
  );
  // Render at a narrow width that draws only the first row(s).
  savedTexts(harness.controller, 26, 9);
  harness.send(DOWN);
  harness.send(DOWN); // select row "c", which was not drawn
  harness.send(ENTER);
  assert.equal(
    harness.actions.some((action) => action.type === "saved-open"),
    false,
    "Enter on an undrawn row must not open",
  );
  // Redraw so the selected row is now displayed; Enter now opens it.
  savedTexts(harness.controller, 26, 9);
  harness.send(ENTER);
  assert.deepEqual(harness.actions.at(-1), {
    type: "saved-open", requestId: 2, file: "c.jsonl", sessionId: "c",
  });
});

test("workspace wrapping preserves a width-changing grapheme at the boundary", () => {
  const prefix = "/" + "a".repeat(38);
  const suffix = "\u2764\uFE0F/b";
  const harness = openSavedPane([makeRow({ id: "a", cwd: prefix + suffix })]);
  const texts = savedTexts(harness.controller, 40, 12);
  assert.deepEqual(texts.slice(8, 10).map((line) => line.trimEnd()), [prefix, suffix]);
});
