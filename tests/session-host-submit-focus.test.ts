/**
 * Focused regressions for automatic Main ownership on a successful explicit
 * New or Saved submission (#323).
 *
 * Agreed behavior: a New path -> Enter whose created session succeeds, and a
 * deliberate saved-row Enter whose restored session succeeds, both make that
 * child the active Main input owner WITHOUT a second host-row Enter. The
 * sidebar stays visible exactly as it was, and the submission Enter's held
 * repeat/release is fenced so it is never replayed into the newly focused
 * child. Failures, cancellations, superseded/stale requests, and
 * navigation-only selection never activate; the pre-existing request/stale
 * guards are unchanged.
 *
 * Pure and inert: no filesystem, process, PTY, Git, network, config, or
 * cleanup work. The native-field contract is isolated behind a deterministic
 * stand-in so only the sidebar's completion/ownership wiring is exercised.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isKittyProtocolActive,
  matchesKey,
  setKittyProtocolActive,
} from "pi-session-host-tui";
import {
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarFieldFactoryOptions,
  type SidebarFieldFactoryResult,
  type SidebarItem,
} from "../src/session-host/sidebar";
import type { SessionHostFieldSubmission, SessionHostTextField } from "../src/session-host/field-editor";

const ALT_LEFT = "\x1b[1;3D";
const UP = "\x1b[A";
const ENTER = "\r";
const KITTY_ENTER = "\x1b[13u";
const KITTY_ENTER_REPEAT = "\x1b[13;1:2u";
const KITTY_ENTER_RELEASE = "\x1b[13;1:3u";
const KITTY_CTRL_S = "\x1b[115;5u";
const KITTY_CTRL_S_REPEAT = "\x1b[115;5:2u";
const KITTY_CTRL_S_RELEASE = "\x1b[115;5:3u";
const ESC = "\x1b";

const SAVED_ROWS = [
  { id: "conv-1", file: "/agents/a/sessions/proj/one.jsonl", caption: "First conversation" },
] as const;

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

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  sinceActions(): SidebarAction[];
  focusedActions(): SidebarAction[];
  forwards(): SidebarAction[];
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
    sinceActions: () => actions.slice(harness.baseline),
    focusedActions: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
    forwards: () => actions.slice(harness.baseline).filter((action) => action.type === "forward"),
  };
  return harness;
}

/** Deterministic native-field stand-in: the configured submit key submits. */
class SubmitField {
  submitCalls = 0;
  private text: string;
  constructor(
    initialText: string,
    private readonly matchesSubmit: (data: string) => boolean,
    private readonly onSubmit: (submission: SessionHostFieldSubmission) => void,
  ) {
    this.text = initialText;
  }
  handleInput(data: string): void {
    if (this.matchesSubmit(data)) {
      this.submitCalls += 1;
      this.onSubmit({ text: this.text, value: this.text, source: "typed" });
      return;
    }
    if (!data.startsWith("\x1b")) this.text += data;
  }
  getValue(): string { return this.text; }
  dispose(): void { /* owns nothing */ }
  render(cols: number, _rows: number): {
    lines: string[];
    cursor: { column: number; row: number; visible: boolean };
  } {
    const text = this.text.slice(0, Math.max(0, cols - 1));
    return {
      lines: [`${text}${" ".repeat(Math.max(0, cols - text.length))}`],
      cursor: { column: text.length, row: 0, visible: true },
    };
  }
}

/** Visible sidebar holding one roster item, ready for a deliberate New/Saved action. */
function makeRoster(
  items: SidebarItem[] = [makeItem({ id: "a" })],
  options: { readonly matchesSubmit?: (data: string) => boolean } = {},
): Harness {
  const matchesSubmit = options.matchesSubmit ?? ((data: string) => matchesKey(data, "enter"));
  const harness = makeController({
    initialVisible: false,
    createTextField: (fieldOptions: SidebarFieldFactoryOptions): SidebarFieldFactoryResult => ({
      field: new SubmitField(fieldOptions.initialText, matchesSubmit, fieldOptions.onSubmit) as unknown as SessionHostTextField,
      matchesCancel: (data: string) => data === ESC,
      matchesSubmit,
    }),
  });
  harness.controller.updateItems(items);
  harness.send(ALT_LEFT); // hidden -> show and focus the roster
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return harness;
}

/** Opens the New form, types a workspace, and submits request 1. */
function submitNew(harness: Harness, workspace = "/w"): number {
  harness.send(ENTER); // default selection "New session"
  assert.equal(harness.controller.focus, "form");
  harness.send(workspace);
  harness.send(ENTER); // submit
  const create = harness.sinceActions().find((action) => action.type === "create");
  assert.ok(create?.type === "create", `expected a create request, got ${JSON.stringify(harness.sinceActions())}`);
  return create.requestId;
}

/** Opens the Saved picker, accepts one listing row, and returns the open request id. */
function openSaved(harness: Harness): { listRequestId: number; openRequestId: number } {
  harness.send(UP); // New session -> Saved conversations
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(ENTER); // open the picker
  assert.equal(harness.controller.focus, "form");
  const list = harness.sinceActions().find((action) => action.type === "saved-list");
  assert.ok(list?.type === "saved-list", `expected a saved-list request, got ${JSON.stringify(harness.sinceActions())}`);
  const accepted = harness.controller.completeSavedList(list.requestId, [...SAVED_ROWS], 0);
  assert.equal(accepted, true);
  harness.controller.render(40, 20); // the picker records its displayed rows
  harness.send(ENTER); // deliberate open of the highlighted row
  const open = harness.sinceActions().find((action) => action.type === "saved-open");
  assert.ok(open?.type === "saved-open", `expected a saved-open request, got ${JSON.stringify(harness.sinceActions())}`);
  return { listRequestId: list.requestId, openRequestId: open.requestId };
}

// ---------------------------------------------------------------------------
// Successful New / Saved submissions activate Main
// ---------------------------------------------------------------------------

test("a successful New submission activates the created child and keeps the visible sidebar", () => {
  const harness = makeRoster();
  const requestId = submitNew(harness);
  harness.baseline = harness.actions.length;

  harness.controller.completeCreate(requestId, "created");
  assert.equal(harness.controller.focus, "main", "the created child owns Main input");
  assert.equal(harness.controller.visible, true, "the sidebar visibility is unchanged");
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "created" }]);
  assert.equal(harness.controller.selectedId, undefined, "the row arrives through the roster snapshot");

  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "created" })]);
  assert.equal(harness.controller.selectedId, "created", "the created row is the highlighted active owner");
});

test("a successful Saved open activates the restored child and keeps the visible sidebar", () => {
  const harness = makeRoster();
  const { openRequestId } = openSaved(harness);
  harness.baseline = harness.actions.length;

  harness.controller.updateItems([makeItem({ id: "a" }), makeItem({ id: "restored" })]);
  harness.controller.completeSavedOpen(openRequestId, "restored");
  assert.equal(harness.controller.focus, "main", "the restored child owns Main input");
  assert.equal(harness.controller.visible, true, "the sidebar visibility is unchanged");
  assert.equal(harness.controller.selectedId, "restored");
  assert.deepEqual(harness.focusedActions(), [{ type: "select", id: "restored" }]);
});

// ---------------------------------------------------------------------------
// Failures, cancellation, and stale/superseded requests never activate
// ---------------------------------------------------------------------------

test("a failed New submission never autoactivates through a late completion", () => {
  const harness = makeRoster();
  const requestId = submitNew(harness);
  harness.controller.failCreate(requestId, "boom");
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;

  harness.controller.completeCreate(requestId, "created");
  assert.equal(harness.controller.focus, "form", "a failed request cannot activate");
  assert.deepEqual(harness.focusedActions(), []);
});

test("a cancelled New form never autoactivates through a late completion", () => {
  const harness = makeRoster();
  const requestId = submitNew(harness);
  harness.send(ESC); // local cancel of the pending New form
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  harness.baseline = harness.actions.length;

  harness.controller.completeCreate(requestId, "created");
  assert.equal(harness.controller.focus, "sidebar", "a cancelled request cannot activate");
  assert.deepEqual(harness.focusedActions(), []);
});

test("a stale or superseded New completion never activates the current form", () => {
  const harness = makeRoster();
  const first = submitNew(harness, "/first");
  harness.controller.select("elsewhere"); // supersedes UI ownership of the first request
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;

  harness.controller.completeCreate(first, "stale-row");
  assert.equal(harness.controller.focus, "form");
  assert.deepEqual(harness.focusedActions(), []);
});

test("a stale or dismissed Saved open never activates and never seizes a later pane", () => {
  const harness = makeRoster();
  const { openRequestId } = openSaved(harness);
  harness.send(ESC); // dismiss while the open is pending
  assert.equal(harness.controller.focus, "sidebar");
  harness.baseline = harness.actions.length;

  harness.controller.completeSavedOpen(openRequestId, "ghost");
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), []);
});

test("navigation-only selection still does not activate any row", () => {
  const harness = makeRoster([makeItem({ id: "a" }), makeItem({ id: "b" })]);
  harness.controller.setActiveMainOwner("a");
  harness.send(UP); // New session -> Saved conversations
  harness.send(UP); // -> b
  assert.equal(harness.controller.focus, "sidebar", "navigation never transfers Main ownership");
  assert.deepEqual(harness.focusedActions(), []);
});

// ---------------------------------------------------------------------------
// The submission Enter is fenced out of the newly focused child
// ---------------------------------------------------------------------------

test("the New submission Enter's repeat/release is fenced; a fresh Enter is native input", () => {
  const harness = makeRoster();
  const requestId = submitNew(harness);
  harness.controller.completeCreate(requestId, "created");
  assert.equal(harness.controller.focus, "main");
  harness.baseline = harness.actions.length;

  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    harness.send(KITTY_ENTER_REPEAT);
    harness.send(KITTY_ENTER_RELEASE);
    assert.deepEqual(harness.forwards(), [], "the held submission Enter never reaches the child");
    harness.send(KITTY_ENTER); // a fresh press is ordinary native input
    assert.deepEqual(harness.forwards(), [{ type: "forward", data: KITTY_ENTER }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("the Saved-open Enter's repeat/release is fenced; a fresh Enter is native input", () => {
  const harness = makeRoster();
  const { openRequestId } = openSaved(harness);
  harness.controller.completeSavedOpen(openRequestId, "restored");
  assert.equal(harness.controller.focus, "main");
  harness.baseline = harness.actions.length;

  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    harness.send(KITTY_ENTER_REPEAT);
    harness.send(KITTY_ENTER_RELEASE);
    assert.deepEqual(harness.forwards(), [], "the held submission Enter never reaches the child");
    harness.send(KITTY_ENTER);
    assert.deepEqual(harness.forwards(), [{ type: "forward", data: KITTY_ENTER }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

// ---------------------------------------------------------------------------
// A remapped submit binding claims exactly its own key
// ---------------------------------------------------------------------------

test("a remapped submit key (ctrl+s) fences its own repeat/release without claiming Enter", () => {
  const submitMatcher = (data: string): boolean => matchesKey(data, "ctrl+s");
  const harness = makeRoster(undefined, { matchesSubmit: submitMatcher });
  harness.send(ENTER); // open the New form
  assert.equal(harness.controller.focus, "form");
  harness.send("/w"); // a nonempty workspace is required to submit
  harness.send(KITTY_CTRL_S); // the configured submit key is a deliberate press
  const create = harness.sinceActions().find((action) => action.type === "create");
  assert.ok(create?.type === "create", `expected a create request, got ${JSON.stringify(harness.sinceActions())}`);
  harness.controller.completeCreate(create.requestId, "created");
  assert.equal(harness.controller.focus, "main", "the remapped submission still activates the child");
  harness.baseline = harness.actions.length;

  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    // A held, unrelated Enter repeat is not part of the ctrl+s claim.
    harness.send(KITTY_ENTER_REPEAT);
    assert.deepEqual(harness.forwards(), [{ type: "forward", data: KITTY_ENTER_REPEAT }]);
    harness.baseline = harness.actions.length;
    // The held ctrl+s repeat/release is fenced out of the newly focused child.
    harness.send(KITTY_CTRL_S_REPEAT);
    harness.send(KITTY_CTRL_S_RELEASE);
    assert.deepEqual(harness.forwards(), [], "the remapped submission key never reaches the child");
    // A fresh ctrl+s press is ordinary native input.
    harness.send(KITTY_CTRL_S);
    assert.deepEqual(harness.forwards(), [{ type: "forward", data: KITTY_CTRL_S }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("another submit binding does not release the actual held submission key", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    const harness = makeRoster(undefined, {
      matchesSubmit: (data) => matchesKey(data, "enter") || matchesKey(data, "ctrl+s"),
    });
    const requestId = submitNew(harness); // submits with Enter
    harness.controller.completeCreate(requestId, "created");
    harness.baseline = harness.actions.length;
    // A fresh ctrl+s is a different binding and must not clear the held-Enter claim.
    harness.send(KITTY_CTRL_S);
    assert.deepEqual(harness.forwards(), [{ type: "forward", data: KITTY_CTRL_S }]);
    harness.baseline = harness.actions.length;
    // The held Enter's repeat/release stays fenced.
    harness.send(KITTY_ENTER_REPEAT);
    harness.send(KITTY_ENTER_RELEASE);
    assert.deepEqual(harness.forwards(), []);
    harness.send(KITTY_ENTER);
    assert.deepEqual(harness.forwards(), [{ type: "forward", data: KITTY_ENTER }]);
  } finally {
    setKittyProtocolActive(previous);
  }
});
