/**
 * Focused New-form layout/input regressions for the New form's Provider line
 * (issue #277 host-UI slice).
 *
 * The New form kept one reserved spacer row below its editor for as long as the
 * session host has had a New form, and the row budget handed to the native
 * `Editor` is part of that form's contract: the pinned Editor derives its scroll
 * window and completion room from the rows it is rendered into. These tests pin
 * three things that the Provider line must never disturb:
 *
 * - the native field is rendered with byte-for-byte the same `(cols, rows)`
 *   budget with a Provider line as without one, at every tested geometry;
 * - the Provider line occupies the reserved spacer row, so the pane keeps its
 *   exact row count and the hint footer keeps the last rows;
 * - a pending "Starting"/error status always keeps its own row beside the
 *   Provider line, and a pane with no spare row draws no Provider row at all
 *   rather than displacing the status, the footer, or the field; and
 * - a Provider row the layout suppressed never owns the keyboard: the focus
 *   ring cannot stop on it, an existing focus is released by the render that
 *   lost the space, and typing plus Enter keep reaching the workspace editor.
 *
 * The last case uses the REAL pinned native field adapter, so the default Pi
 * Workspace focus, typing, and single-Enter submission are proven against the
 * actual Editor while a Provider line is drawn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";

import { createSessionHostTextField } from "../src/session-host/field-editor";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarFieldFactoryOptions,
  type SidebarFieldFactoryResult,
  type SidebarItem,
  type SidebarNativeCliTarget,
  SidebarController,
} from "../src/session-host/sidebar";
import type { SessionHostFieldRender, SessionHostFieldSubmission } from "../src/session-host/field-editor";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ENTER = "\r";
const ALT_LEFT = "\x1b[1;3D";
const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";
const DOWN = "\x1b[B";

/** The two default native targets a production host offers. */
const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
];

/** The real session-host New-form pane: 120x50 outer minus sidebar and chrome. */
const MAIN_PANE_COLS = 87;
const MAIN_PANE_ROWS = 47;

function makeItem(id: string): SidebarItem {
  return {
    id,
    label: `label-${id}`,
    workspace: `/ws/${id}`,
    agentDir: `/agents/${id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  };
}

/**
 * Deterministic native-field stand-in that records every render budget it is
 * given. `renderedRows` models a field that actually fills its budget (a long
 * wrapped value plus a completion list) instead of the ordinary three rows.
 */
class BudgetField {
  readonly budgets: string[] = [];
  private text: string;
  constructor(
    initialText: string,
    private readonly renderedRows: number | null,
    private readonly onSubmit: (submission: SessionHostFieldSubmission) => void,
  ) {
    this.text = initialText;
  }
  handleInput(data: string): void {
    if (data === ENTER) {
      this.onSubmit({ text: this.text, value: this.text, source: "typed" });
      return;
    }
    if (!data.startsWith("\x1b")) this.text += data;
  }
  getValue(): string { return this.text; }
  dispose(): void { /* owns nothing */ }
  render(cols: number, rows: number): SessionHostFieldRender {
    this.budgets.push(`${cols}x${rows}`);
    const count = Math.max(2, this.renderedRows ?? 3);
    const body = `${this.text.slice(0, Math.max(0, cols - 1))}${" ".repeat(cols)}`;
    const lines = ["─".repeat(cols)];
    for (let index = 1; index < count - 1; index += 1) lines.push(index === 1 ? body : " ".repeat(cols));
    lines.push("─".repeat(cols));
    return { lines, cursor: { column: 1, row: 1, visible: true }, contentRow: 1 };
  }
}

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  budgets: string[];
  send(data: string): void;
  pane(cols: number, rows: number): string[];
}

function makeHarness(options: {
  readonly targets?: readonly SidebarNativeCliTarget[];
  readonly renderedRows?: number | null;
}): Harness {
  const actions: SidebarAction[] = [];
  let field: BudgetField | undefined;
  const controllerOptions: SidebarControllerOptions = {
    workspaceBasePath: "/pi-review-gate-test-missing-workspace",
    initialVisible: false,
    ...(options.targets === undefined ? {} : { nativeCliTargets: options.targets }),
    createTextField: (fieldOptions: SidebarFieldFactoryOptions): SidebarFieldFactoryResult => {
      field = new BudgetField(
        fieldOptions.initialText ?? "",
        options.renderedRows ?? null,
        fieldOptions.onSubmit,
      );
      return { field: field as unknown as SidebarFieldFactoryResult["field"] };
    },
    onAction: (action: SidebarAction) => actions.push(action),
  };
  const controller = new SidebarController(controllerOptions);
  controller.updateItems([makeItem("a")]);
  controller.handleInput(ALT_LEFT); // show the sidebar and focus the roster
  void controller.render(40, 20);
  controller.handleInput(ENTER); // the default "New session" row opens the form
  assert.equal(controller.focus, "form");
  return {
    controller,
    actions,
    get budgets() { return field?.budgets ?? []; },
    send: (data: string) => controller.handleInput(data),
    pane: (cols: number, rows: number) => checkPane(controller.render(cols, rows).lines, cols),
  };
}

/** Rejects out-of-band escapes/over-wide rows, then returns plain pane text. */
function checkPane(lines: readonly string[], cols: number): string[] {
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`);
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than the pane: ${JSON.stringify(line)}`);
  }
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

const trimmed = (lines: readonly string[]): string[] => lines.map((line) => line.replace(/\s+$/g, ""));

// ---------------------------------------------------------------------------
// The native field's render budget is the form's contract.
// ---------------------------------------------------------------------------

test("the Provider line never changes the native field's render budget, at any geometry", () => {
  for (const [cols, rows] of [[MAIN_PANE_COLS, MAIN_PANE_ROWS], [87, 20], [87, 10], [48, 14], [40, 9]] as const) {
    const without = makeHarness({});
    const withProvider = makeHarness({ targets: TARGETS });
    const plainPane = without.pane(cols, rows);
    const providerPane = withProvider.pane(cols, rows);

    assert.deepEqual(withProvider.budgets, without.budgets,
      `a drawn Provider line changed the native field budget at ${cols}x${rows}`);
    assert.equal(withProvider.budgets.length, without.budgets.length);
    assert.ok(withProvider.budgets.length > 0, "the New form rendered its native field");
    // The pane's own row count is unchanged, and the footer keeps the last rows.
    assert.equal(providerPane.length, plainPane.length);
    assert.equal(providerPane.length, rows);
    assert.equal(trimmed(providerPane).at(-1), trimmed(plainPane).at(-1));
    assert.equal(withProvider.pane(cols, rows).some((line) => line.includes("Provider:")), true,
      `the offered Provider line disappeared at ${cols}x${rows}`);
  }
  // The exact budget the real 120x50 Main pane gives the pinned Editor.
  const real = makeHarness({ targets: TARGETS });
  real.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS);
  assert.deepEqual(real.budgets, [`${MAIN_PANE_COLS - "> Workspace: ".length}x${MAIN_PANE_ROWS - 4}`],
    "the real Main New-form pane keeps its pre-native native-field budget");
});

test("the Provider line takes the reserved spacer row and keeps the pre-native row layout", () => {
  const without = makeHarness({});
  const withProvider = makeHarness({ targets: TARGETS });
  const plain = trimmed(without.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  const provider = trimmed(withProvider.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));

  assert.equal(plain[5].trim(), "", "the pre-native New form leaves the row below the editor empty");
  assert.equal(provider[5].trim(), "Provider: [ Pi ]", JSON.stringify(provider));
  // Every other drawn row — header, Host line, the Editor's own rules, its
  // labelled body row, the filler, and the footer — stays at its exact index.
  for (let index = 0; index < plain.length; index += 1) {
    if (index === 5) continue;
    assert.equal(provider[index], plain[index], `row ${index} moved: ${JSON.stringify({ plain: plain[index], provider: provider[index] })}`);
  }
});

// ---------------------------------------------------------------------------
// Pending and error statuses keep their own row.
// ---------------------------------------------------------------------------

test("a pending create keeps its Starting row beside the drawn Provider line", () => {
  const harness = makeHarness({ targets: TARGETS });
  harness.send("/workspace");
  harness.send(ENTER);
  const pane = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  const providerRow = pane.findIndex((line) => line.trim() === "Provider: [ Pi ]");
  const startingRow = pane.findIndex((line) => line.includes("Starting (request 1)"));
  assert.ok(providerRow >= 0, JSON.stringify(pane));
  assert.ok(startingRow >= 0, `a pending create lost its status row: ${JSON.stringify(pane)}`);
  assert.notEqual(startingRow, providerRow);
  assert.equal(pane.length, MAIN_PANE_ROWS);
  assert.ok(pane.at(-1)!.includes("enter create"), "the hint footer stayed on the last row");
});

test("a create error keeps its notice row beside the drawn Provider line", () => {
  const harness = makeHarness({ targets: TARGETS });
  harness.send("/workspace");
  harness.send(ENTER);
  const create = harness.actions.find((action) => action.type === "create");
  assert.ok(create?.type === "create");
  harness.controller.failCreate(create.requestId, "workspace could not be opened");
  const pane = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(pane.some((line) => line.includes("! workspace could not be opened")),
    `the create error disappeared: ${JSON.stringify(pane)}`);
  assert.ok(pane.some((line) => line.trim() === "Provider: [ Pi ]"),
    `the Provider line disappeared behind an error: ${JSON.stringify(pane)}`);
  assert.equal(pane.length, MAIN_PANE_ROWS);
});

test("a pane with no spare row draws no Provider row and never displaces the status or footer", () => {
  // The field drew every row it was budgeted, so nothing is left to give: the
  // status row and the footer win, and no provider control is claimed.
  const harness = makeHarness({ targets: TARGETS, renderedRows: MAIN_PANE_ROWS - 4 });
  harness.send("/workspace");
  harness.send(ENTER);
  const pending = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.equal(pending.some((line) => line.includes("Provider:")), false,
    `a provider row was drawn into a full pane: ${JSON.stringify(pending)}`);
  assert.ok(pending.some((line) => line.includes("Starting (request 1)")),
    `the pending status was displaced: ${JSON.stringify(pending)}`);
  assert.equal(pending.length, MAIN_PANE_ROWS);
  assert.ok(pending.at(-1)!.includes("enter create"), "the hint footer stayed on the last row");

  // The same pane with a real error status instead of a pending one.
  harness.controller.failCreate(1, "workspace could not be opened");
  const errored = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(errored.some((line) => line.includes("! workspace could not be opened")),
    `the create error disappeared: ${JSON.stringify(errored)}`);
  assert.equal(errored.some((line) => line.includes("Provider:")), false,
    `a provider row was drawn behind the error: ${JSON.stringify(errored)}`);
  assert.equal(errored.length, MAIN_PANE_ROWS);
  assert.ok(errored.at(-1)!.includes("enter create"), "the hint footer stayed on the last row");

  // The focus ring still works and stops before a row nobody can see.
  harness.send(SHIFT_TAB);
  const onHost = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(onHost.some((line) => line.startsWith("> Host: [ Local ]")),
    `the Host line stopped being reachable: ${JSON.stringify(onHost)}`);
  harness.send(SHIFT_TAB);
  const afterRing = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.equal(afterRing.some((line) => line.startsWith("> Provider:")), false,
    `an undrawn Provider line took the focus ring: ${JSON.stringify(afterRing)}`);
  assert.equal(afterRing.some((line) => line.startsWith("> Host:")), false,
    "the ring returns to the workspace editor, exactly as a form with no Provider line");

  // Arrows cannot change an invisible provider, and typing plus Enter still
  // reach the workspace editor as an ordinary Pi create.
  harness.send(DOWN);
  harness.send(DOWN);
  harness.send("/x");
  const typed = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(typed.some((line) => line.startsWith("> Workspace: /workspace/x")),
    `typed input never reached the workspace editor: ${JSON.stringify(typed)}`);
  harness.send(ENTER);
  assert.deepEqual(harness.actions.filter((action) => action.type === "create").at(-1),
    { type: "create", requestId: 2, workspace: "/workspace/x" },
    "a suppressed provider stayed Pi and the workspace still submitted");

  // And the drawn-geometry pointer rule refuses a row that was never drawn.
  const presentation = harness.controller.captureMousePresentation();
  assert.equal(presentation.activateFormProviderAt?.(20, 5, MAIN_PANE_COLS, MAIN_PANE_ROWS), false);
});

test("losing the Provider row while it holds focus hands keyboard ownership back to the workspace", () => {
  // The field fills its budget from the second row on, so a single status row is
  // exactly what decides whether this pane can still fit the Provider line.
  const harness = makeHarness({ targets: TARGETS, renderedRows: MAIN_PANE_ROWS - 5 });
  harness.send("/workspace");
  harness.send(ENTER);
  harness.controller.failCreate(1, "workspace could not be opened");

  // The wider pane has the one filler row to spare, so the control is drawn and
  // the focus ring reaches it (Main renders between keystrokes).
  const wide = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(wide.some((line) => line.trim() === "Provider: [ Pi ]"), JSON.stringify(wide));
  harness.send(SHIFT_TAB);
  void harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS);
  harness.send(SHIFT_TAB);
  const focused = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(focused.some((line) => line.startsWith("> Provider: [ Pi ]")),
    `the drawn Provider line never took the focus ring: ${JSON.stringify(focused)}`);

  // One row narrower and the Provider line no longer fits: it disappears, and so
  // must the keyboard ownership it held.
  const narrow = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS - 1));
  assert.equal(narrow.some((line) => line.includes("Provider:")), false,
    `a provider row survived the narrower pane: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.some((line) => line.includes("! workspace could not be opened")),
    `the error status disappeared in the narrower pane: ${JSON.stringify(narrow)}`);
  assert.equal(narrow.length, MAIN_PANE_ROWS - 1);

  // Arrows and Enter belong to the workspace editor again, and the provider
  // choice is untouched: one ordinary Pi create, no backend fields.
  harness.send(DOWN);
  harness.send(ENTER);
  assert.deepEqual(harness.actions.filter((action) => action.type === "create").at(-1),
    { type: "create", requestId: 2, workspace: "/workspace" },
    "a released invisible provider kept no keyboard ownership");
  const presentation = harness.controller.captureMousePresentation();
  assert.equal(presentation.activateFormProviderAt?.(20, 5, MAIN_PANE_COLS, MAIN_PANE_ROWS - 1), false);
});

// ---------------------------------------------------------------------------
// The default Pi New form still submits through the real native field.
// ---------------------------------------------------------------------------

test("the real native field keeps default Workspace focus, typing, and single-Enter create with a Provider line", () => {
  const actions: SidebarAction[] = [];
  const budgets: string[] = [];
  const controller = new SidebarController({
    workspaceBasePath: "/pi-review-gate-test-missing-workspace",
    initialVisible: false,
    nativeCliTargets: TARGETS,
    createTextField: (fieldOptions: SidebarFieldFactoryOptions): SidebarFieldFactoryResult => {
      const field = createSessionHostTextField({
        kind: "path",
        workspaceBasePath: "/pi-review-gate-test-missing-workspace",
        initialText: fieldOptions.initialText,
        onInvalidate: fieldOptions.onInvalidate,
        onSubmit: fieldOptions.onSubmit,
        onCancel: fieldOptions.onCancel,
        onReject: fieldOptions.onReject,
      });
      const original = field.render.bind(field);
      field.render = (cols: number, rows: number) => {
        budgets.push(`${cols}x${rows}`);
        return original(cols, rows);
      };
      return { field };
    },
    onAction: (action: SidebarAction) => actions.push(action),
  });
  controller.updateItems([makeItem("a")]);
  controller.handleInput(ALT_LEFT);
  void controller.render(40, 20);
  controller.handleInput(ENTER); // open the ordinary New form
  assert.equal(controller.focus, "form");

  const opened = controller.render(MAIN_PANE_COLS, MAIN_PANE_ROWS);
  const openedText = trimmed(checkPane(opened.lines, MAIN_PANE_COLS));
  const workspaceRow = openedText.findIndex((line) => line.startsWith("> Workspace:"));
  assert.ok(workspaceRow >= 0, JSON.stringify(openedText));
  // The workspace editor — not the Provider line — owns the form and its caret.
  assert.deepEqual(opened.cursor, { column: 13, row: workspaceRow });
  assert.equal(openedText.some((line) => line.startsWith("> Provider:")), false);
  assert.equal(openedText.some((line) => line.startsWith("> Host:")), false);

  controller.handleInput("/workspace");
  controller.handleInput(ENTER);
  assert.deepEqual(actions.filter((action) => action.type === "create"),
    [{ type: "create", requestId: 1, workspace: "/workspace" }],
    "the default Pi submission is byte-for-byte the existing local create action");
  // The real pinned Editor was rendered with the pane's full pre-native budget.
  assert.deepEqual(budgets.at(-1), `${MAIN_PANE_COLS - 13}x${MAIN_PANE_ROWS - 4}`,
    `the real native field got a different budget: ${JSON.stringify(budgets)}`);
});

test("the drawn Provider line still selects an explicit native target", () => {
  const harness = makeHarness({ targets: TARGETS });
  harness.send("/workspace");
  harness.send(SHIFT_TAB); // Host line
  // Main renders between keystrokes; the focus ring only ever reaches a control
  // the current render actually drew.
  assert.ok(trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS))
    .some((line) => line.startsWith("> Host: [ Local ]")), "the first Shift+Tab owns the Host line");
  harness.send(SHIFT_TAB); // Provider line
  const focused = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(focused.some((line) => line.startsWith("> Provider: [ Pi ]")), JSON.stringify(focused));
  harness.send(DOWN); // one deliberate cycle to the first offered target
  const chosen = trimmed(harness.pane(MAIN_PANE_COLS, MAIN_PANE_ROWS));
  assert.ok(chosen.some((line) => line.startsWith("> Provider: [ Claude Code (default) ]")),
    JSON.stringify(chosen));
  harness.send(TAB); // back to the workspace editor, which still submits
  harness.send(ENTER);
  const create = harness.actions.find((action) => action.type === "create");
  assert.ok(create?.type === "create");
  assert.deepEqual(create, {
    type: "create", requestId: 1, workspace: "/workspace", backend: "claude", nativeCliTarget: "claude",
  });
});
