/**
 * Focused regressions for the New workspace form owning Escape (#323):
 *
 * A deliberate Escape in the New session form cancels ONLY that form and
 * returns to the VISIBLE roster (sidebar focus) without hiding, without
 * emitting any create/stop/select/visibility action, and without forwarding
 * native input. The held key's repeat/release stay fenced across focus
 * domains — including after a native completion-list dismissal, a pending
 * create, a reserved toggle to Main, and a completed create — so the same
 * press can never also hide the roster or leak into the child. A distinct
 * fresh roster Escape still hides, and the native field's own completion-list
 * Escape precedence is untouched.
 *
 * Pure and inert: no filesystem, process, PTY, Git, network, or config work.
 * Keyboard paths use REAL pinned pi-tui key matching (legacy and Kitty CSI-u),
 * never mock key algorithms. The native Editor's completion-list precedence is
 * covered in tests/session-host-field-editor.test.ts; here a deterministic
 * stand-in field models exactly that contract ("first Escape dismisses the
 * list, the next fresh Escape cancels") so the sidebar's own precedence and
 * provenance fence are what is exercised — a frontend wiring regression, not a
 * native runtime proof.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarFieldFactoryOptions,
  type SidebarFieldFactoryResult,
  type SidebarItem,
  SidebarController,
} from "../src/session-host/sidebar";
import type { SessionHostFieldSubmission, SessionHostTextField } from "../src/session-host/field-editor";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT_LEGACY = "\x1b[1;3D";
const ALT_RIGHT_LEGACY = "\x1b[1;3C";
const ENTER = "\r";
const ESC = "\x1b";
const ESC_REPEAT = "\x1b[27;1:2u";
const ESC_RELEASE = "\x1b[27;1:3u";

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
    forwards: () =>
      actions.slice(harness.baseline).filter((action) => action.type === "forward"),
  };
  return harness;
}

/** Builds a roster and moves focus to the sidebar pane (one toggle show). */
function makeRoster(ids: string[], options: SidebarControllerOptions = {}): Harness {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems(ids.map((id) => makeItem({ id })));
  harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
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

function rosterTexts(controller: SidebarController, cols = 40, rows = 20): string[] {
  return assertPaneSafe(controller.render(cols, rows).lines, cols);
}

/**
 * Deterministic stand-in for the native field adapter. It models the real
 * Editor's completion-first contract and a plain submit, so the sidebar's own
 * Escape precedence and cross-domain fence are isolated from native runtime
 * behavior. It owns no resources and touches nothing outside its own fields.
 */
class CompletionFirstField {
  completionsOpen = true;
  cancelCalls = 0;
  submitCalls = 0;
  private text: string;
  constructor(
    initialText: string,
    private readonly onCancel: () => void,
    private readonly onSubmit: (submission: SessionHostFieldSubmission) => void,
  ) {
    this.text = initialText;
  }
  handleInput(data: string): void {
    if (data === ESC) {
      // Native list-first dismissal: the first Escape never cancels the field.
      if (this.completionsOpen) { this.completionsOpen = false; return; }
      this.cancelCalls += 1;
      this.onCancel();
      return;
    }
    if (data === ENTER) {
      this.submitCalls += 1;
      this.onSubmit({ text: this.text, value: this.text, source: "typed" });
      return;
    }
    if (!data.startsWith("\x1b")) this.text += data;
  }
  getValue(): string { return this.text; }
  dispose(): void { /* no owned resources in the stand-in */ }
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

/** Shows the sidebar with the New row fully drawn over a completion-first stand-in field. */
function makeCompletionFormHarness(): { harness: Harness; fields: CompletionFirstField[] } {
  const fields: CompletionFirstField[] = [];
  const harness = makeController({
    initialVisible: false,
    createTextField: (options: SidebarFieldFactoryOptions): SidebarFieldFactoryResult => {
      const field = new CompletionFirstField(options.initialText, options.onCancel, options.onSubmit);
      fields.push(field);
      return { field: field as unknown as SessionHostTextField, matchesCancel: (data: string) => data === ESC };
    },
  });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT_LEGACY); // show -> focus sidebar
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return { harness, fields };
}

// ---------------------------------------------------------------------------
// Deliberate New-form Escape is local cancellation
// ---------------------------------------------------------------------------

test("Escape in the New form cancels only the form and returns to the visible roster", () => {
  const harness = makeRoster(["a"]);
  harness.controller.setActiveMainOwner("a"); // the actual Main owner must survive
  harness.send(ENTER); // default selection "new" -> form focus
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;
  harness.send(ESC);
  assert.equal(harness.controller.focus, "sidebar", "focus returns to the roster");
  assert.equal(harness.controller.visible, true, "the sidebar stays visible (not hidden)");
  assert.equal(harness.controller.activeMainOwnerID, "a", "the active owner is preserved");
  assert.equal(harness.controller.selectedId, undefined, "navigation stays on the New row");
  assert.deepEqual(harness.sinceActions(), [],
    "cancel emits no create/stop/quit/select/visibility or forwarded native input");
  const texts = rosterTexts(harness.controller);
  assert.ok(!texts.some((line) => line.includes("Workspace:")), "the New form is gone");
  assert.ok(texts.some((line) => line.includes("Sessions (1)")), "the roster is restored");
});

test("a held Escape that canceled the New form does not hide the roster; a fresh Escape still hides", () => {
  const harness = makeRoster(["a"]);
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.send(ESC); // cancel only the New form -> visible roster
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  harness.send(ESC_REPEAT); // held repeat: consumed, never a roster hide
  assert.equal(harness.controller.visible, true, "a held Escape repeat does not hide the roster");
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(ESC_RELEASE); // held release: consumed, clears the fence
  assert.equal(harness.controller.visible, true);
  // A fresh, deliberate roster Escape still hides (existing semantics).
  harness.send(ESC);
  assert.equal(harness.controller.visible, false, "a fresh roster Escape hides the sidebar");
  assert.equal(harness.controller.focus, "main");
});

test("a held Escape repeat/release after New cancel never leaks into Main input", () => {
  const harness = makeRoster(["a"]);
  harness.send(ENTER);
  harness.send(ESC); // cancel only the New form -> visible roster, claim set
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30); // host re-renders the visible roster before a targeted key
  harness.send(ALT_RIGHT_LEGACY); // move to Main while the Escape is still held
  assert.equal(harness.controller.focus, "main");
  harness.baseline = harness.actions.length;
  harness.send(ESC_REPEAT); // held repeat in Main: consumed, not forwarded
  harness.send(ESC_RELEASE); // held release in Main: consumed, clears the claim
  assert.deepEqual(harness.forwards(), [], "held Escape repeat/release never become child input");
});

// ---------------------------------------------------------------------------
// Pending create and cross-domain transitions
// ---------------------------------------------------------------------------

test("New cancel while creation is pending keeps the roster visible and the create alive", () => {
  const harness = makeRoster(["a"], { workspaceBasePath: "/nonexistent-pi-review-workspace-base" });
  harness.send(ENTER); // New form
  assert.equal(harness.controller.focus, "form");
  harness.send("/pending/workspace");
  harness.send(ENTER); // submit -> create request 1, pendingCreate set
  const creates = harness.sinceActions().filter((action) => action.type === "create");
  assert.equal(creates.length, 1, "the submit emitted the create request");
  assert.equal(harness.controller.focus, "form");
  harness.send(ESC); // cancel while the backend create is still in flight
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true, "the roster stays visible");
  assert.deepEqual(
    harness.sinceActions().filter((action) => action.type === "quit"
      || action.type === "stop-remove" || action.type === "select" || action.type === "visibility"),
    [],
    "cancel emits no stop, quit, activation, or visibility action",
  );
  // The same held key: its repeat/release stay fenced in the visible roster.
  harness.send(ESC_REPEAT);
  harness.send(ESC_RELEASE);
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "sidebar");
  // The retained workspace draft is restored when New is reopened.
  void harness.controller.render(40, 30); // the restored roster is drawn before Enter
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  const form = assertPaneSafe(harness.controller.render(44, 16).lines, 44);
  // The sidebar prefixes only the first Editor row with the field label; the
  // native Editor renders its own input viewport below it, so check the label
  // and the retained path independently rather than on one line.
  assert.ok(form.some((line) => line.includes("Workspace:")),
    `the New form shows its workspace label: ${JSON.stringify(form)}`);
  assert.ok(form.join("\n").includes("/pending/workspace"),
    `the retained workspace draft survives the cancel: ${JSON.stringify(form)}`);
  // A late completion of the cancelled create never steals the reopened form.
  harness.controller.completeCreate(1, "late-row");
  assert.equal(harness.controller.focus, "form", "a late create result is fenced");
});

// ---------------------------------------------------------------------------
// Completion-list dismissal and its held key across transitions
// ---------------------------------------------------------------------------

test("a completion-list Escape dismissal, its held repeat, and a later cancel never hide the roster", () => {
  const { harness, fields } = makeCompletionFormHarness();
  harness.send(ENTER); // New form over a field whose completion list is open
  assert.equal(harness.controller.focus, "form");
  const field = fields.at(-1);
  assert.ok(field, "the host field was created");
  harness.send(ESC); // first press: the native field dismisses its list only
  assert.equal(harness.controller.focus, "form", "completion dismissal retains form ownership");
  assert.equal(harness.controller.visible, true);
  assert.equal(field.cancelCalls, 0, "the first Escape never cancels the form");
  harness.send(ESC_REPEAT); // held repeat: refused before the field can cancel
  assert.equal(harness.controller.focus, "form");
  assert.equal(field.cancelCalls, 0);
  harness.send(ESC_RELEASE); // held release: consumed
  assert.equal(harness.controller.focus, "form");
  harness.send(ESC); // a fresh press now cancels the form locally
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true, "New cancel keeps the roster visible");
  assert.equal(field.cancelCalls, 1);
  harness.send(ESC_REPEAT); // the cancel's held repeat stays fenced
  assert.equal(harness.controller.visible, true);
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(ESC); // a fresh roster Escape still hides
  assert.equal(harness.controller.visible, false);
});

test("a completion-dismissal Escape held through a reserved toggle to Main never leaks", () => {
  const { harness, fields } = makeCompletionFormHarness();
  harness.send(ENTER); // New form over a field whose completion list is open
  assert.equal(harness.controller.focus, "form");
  const field = fields.at(-1);
  assert.ok(field, "the host field was created");
  harness.send(ESC); // fresh press: the native field dismisses its list only
  assert.equal(harness.controller.focus, "form", "completion dismissal retains form ownership");
  assert.equal(field.cancelCalls, 0, "the first Escape never cancels the form");
  // The reserved toggle still abandons the form and hides while the Escape is held.
  harness.send(ALT_LEFT_LEGACY);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.visible, false);
  harness.baseline = harness.actions.length;
  harness.send(ESC_REPEAT); // held repeat in Main: consumed, never native input
  harness.send(ESC_RELEASE); // held release in Main: consumed, clears the fence
  assert.deepEqual(
    harness.sinceActions().filter((action) => action.type === "forward"),
    [],
    "the completion-dismissal Escape repeat/release never become child input",
  );
});

test("a completion-dismissal Escape held through a completed create never hides the roster", () => {
  const { harness, fields } = makeCompletionFormHarness();
  harness.send(ENTER); // New form over a field whose completion list is open
  const field = fields.at(-1);
  assert.ok(field, "the host field was created");
  harness.send("/w");
  harness.send(ESC); // fresh press: the native field dismisses its list only
  assert.equal(harness.controller.focus, "form");
  assert.equal(field.cancelCalls, 0);
  harness.send(ENTER); // submit -> create request 1
  assert.equal(field.submitCalls, 1, "the form submitted the typed workspace");
  harness.controller.completeCreate(1, "created-row"); // roster focus before the key is released
  assert.equal(harness.controller.focus, "sidebar");
  assert.equal(harness.controller.visible, true);
  harness.send(ESC_REPEAT); // held repeat in the roster: consumed, never a hide
  assert.equal(harness.controller.visible, true, "the held repeat cannot hide the roster");
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(ESC_RELEASE); // held release: consumed, clears the fence
  assert.equal(harness.controller.visible, true);
  // A fresh roster Escape still hides (the fence ended on the release).
  harness.send(ESC);
  assert.equal(harness.controller.visible, false);
});
