/**
 * Focused UI tests for naming one native Claude/Codex sidebar row (issue #277
 * host-UI slice).
 *
 * The contract these tests pin is deliberately narrow. `E` on a live native row
 * opens the SAME Edit editor the host already has, and what it edits is a
 * host-side CAPTION of this host's own row:
 *
 * - no Pi native-session tuple, provider rename call, status registration, or
 *   PTY keystroke is needed for a native row to be nameable;
 * - the submitted intent is its own `rename-native` action carrying only the row
 *   id and the complete replacement name — never the Pi `rename` action, and
 *   never anything aimed at the provider or the child's input;
 * - an empty, oversized, control-bearing, or whitespace-padded caption emits
 *   nothing at all and leaves the row and the form untouched;
 * - the drawn card title is the caption when one exists and the stable provider
 *   label when it does not, and a remembered placeholder keeps its caption while
 *   still stating that it is unavailable; and
 * - a Pi row's `E` still emits the ordinary `edit` intent with its observed
 *   native tuple, so the authenticated Pi rename path is unchanged.
 *
 * Everything here is pure frontend: the controller renders and emits action DTOs,
 * so no process, PTY, filesystem, config, or provider work happens.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { MAX_NATIVE_DISPLAY_NAME_CHARS } from "../src/session-host/session-backend";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  SidebarController,
} from "../src/session-host/sidebar";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT = "\x1b[1;3D";
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";

/** One live native Claude row, exactly as the host projects it. */
function nativeItem(overrides: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id: "native-1",
    label: "Claude",
    backend: "claude",
    workspace: "/srv/app",
    agentDir: "",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    ...overrides,
  };
}

/** One ordinary Pi row with an observed native conversation. */
function piItem(): SidebarItem {
  return {
    id: "pi-1",
    label: "pi-label",
    workspace: "/ws/pi-1",
    agentDir: "/agents/pi-1",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    nativeSession: { sessionId: "11111111-1111-4111-8111-111111111111", epoch: 1, name: "old name" },
  };
}

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  focusedActions(): SidebarAction[];
  text(cols?: number, rows?: number): string[];
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    workspaceBasePath: join(process.cwd(), ".pi-session-host-test-missing-workspace"),
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
    focusedActions: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
    text: (cols = 60, rows = 30) => {
      const rendered = controller.render(cols, rows).lines;
      for (const line of rendered) {
        for (const sgr of line.match(SGR_PATTERN) ?? []) {
          assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
            `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`);
        }
        assert.ok(!line.replace(SGR_PATTERN, "").includes("\x1b"),
          `raw ESC outside a generated SGR: ${JSON.stringify(line)}`);
      }
      return rendered.map((line) => line.replace(SGR_PATTERN, ""));
    },
  };
  return harness;
}

/** Draw the roster with these rows, sidebar-focused, with the LAST card highlighted. */
function rosterWith(items: SidebarItem[]): Harness {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems(items);
  harness.send(ALT_LEFT);
  assert.equal(harness.controller.focus, "sidebar");
  void harness.text();
  // Walk up the action tail onto the last session card.
  for (let step = 0; step < 2; step += 1) harness.send(UP);
  assert.equal(harness.controller.selectedId, items.at(-1)?.id);
  void harness.text();
  harness.baseline = harness.actions.length;
  return harness;
}

const drawnText = (harness: Harness): string => harness.text().join("\n");

// ---------------------------------------------------------------------------
// E opens the naming editor on a native row without any Pi conversation.
// ---------------------------------------------------------------------------

test("E on a live native row opens the Edit form and emits nothing on its own", () => {
  const harness = rosterWith([nativeItem()]);
  harness.send("e");

  assert.equal(harness.controller.focus, "form",
    "a native row is nameable with no native tuple, provider call, or registration");
  assert.deepEqual(harness.focusedActions(), [], "opening the editor emits no rename, edit, create, or select");
  const text = drawnText(harness);
  assert.ok(text.includes(" Edit native session name "), text);
  assert.ok(text.includes("Current name (display only"), text);
  assert.ok(text.includes("Claude"), "the row's current caption is shown, not an invented conversation name");
});

test("submitting a native name emits one rename-native intent and nothing that could reach a provider", () => {
  const harness = rosterWith([nativeItem()]);
  harness.send("e");
  harness.send("Fleet work");
  harness.send(ENTER);

  const actions = harness.focusedActions();
  assert.deepEqual(actions, [{ type: "rename-native", requestId: 1, id: "native-1", name: "Fleet work" }],
    "the intent names only this host's row id and the complete replacement caption");
  assert.equal(actions.some((action) => action.type === "rename"), false,
    "a native caption is never emitted as the Pi conversation rename");
  assert.equal(actions.some((action) => action.type === "edit"), false);
  assert.ok(drawnText(harness).includes("Saving native name..."), "the request is honestly pending");

  harness.baseline = harness.actions.length;
  harness.controller.completeRename(1, "renamed");
  assert.equal(harness.controller.focus, "sidebar", "the rename closes the editor back onto the roster");
  assert.deepEqual(harness.focusedActions(), [], "completion emits nothing further");
});

test("a rejected native rename leaves the draft and reports the failure without retrying", () => {
  const harness = rosterWith([nativeItem()]);
  harness.send("e");
  harness.send("Fleet work");
  harness.send(ENTER);
  harness.controller.failRename(1, "That row is no longer here; nothing was renamed");

  const text = drawnText(harness);
  assert.ok(text.includes("! That row is no longer here; nothing was renamed"), text);
  assert.equal(harness.controller.focus, "form", "the operator keeps the editor and the draft");
  assert.deepEqual(harness.focusedActions(),
    [{ type: "rename-native", requestId: 1, id: "native-1", name: "Fleet work" }],
    "a refusal never re-emits the intent");
});

// ---------------------------------------------------------------------------
// An unusable caption updates nothing.
// ---------------------------------------------------------------------------

test("empty, control-bearing, and oversized captions emit nothing and keep the row's name", () => {
  for (const [label, typed, notice] of [
    ["empty", "", "! New name is required"],
    ["whitespace only", "   ", "! New name must be valid and at most 1024 UTF-8 bytes"],
    ["surrounding whitespace", " Fleet ", `! Name must be one line of at most ${MAX_NATIVE_DISPLAY_NAME_CHARS} characters`],
    ["one character past the bound", "x".repeat(MAX_NATIVE_DISPLAY_NAME_CHARS + 1),
      `! Name must be one line of at most ${MAX_NATIVE_DISPLAY_NAME_CHARS} characters`],
  ] as const) {
    const harness = rosterWith([nativeItem()]);
    harness.send("e");
    if (typed.length > 0) harness.send(typed);
    harness.send(ENTER);

    assert.deepEqual(harness.focusedActions(), [], `${label}: nothing is emitted`);
    assert.equal(harness.controller.focus, "form", `${label}: the editor stays open`);
    assert.ok(drawnText(harness).includes(notice), `${label}: the refusal is drawn: ${drawnText(harness)}`);
  }
});

test("a control character in a native caption is refused before anything is emitted", () => {
  const harness = rosterWith([nativeItem()]);
  harness.send("e");
  // The field itself never accepts a control byte, so the refusal is proven at
  // the boundary that validates the submitted value.
  harness.send("Fleet\u0007work");
  harness.send(ENTER);
  const emitted = harness.focusedActions();
  assert.equal(emitted.filter((action) => action.type === "rename-native").length, 0,
    "no caption containing a control character is ever emitted");
  for (const action of emitted) {
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(JSON.stringify(action)),
      `an emitted action carries a control character: ${JSON.stringify(action)}`);
  }
});

// ---------------------------------------------------------------------------
// The card title follows the caption, and a placeholder stays honest.
// ---------------------------------------------------------------------------

test("the native card title is the operator's caption, or the stable provider label without one", () => {
  const titles = (items: SidebarItem[]): string => {
    const harness = makeController({ initialVisible: false });
    harness.controller.updateItems(items);
    harness.send(ALT_LEFT);
    return harness.text(60, 30).join("\n");
  };

  const unnamed = titles([nativeItem()]);
  assert.ok(unnamed.includes("Claude"), unnamed);
  assert.equal(unnamed.includes("Fleet work"), false);

  const named = titles([nativeItem({ label: "Fleet work" })]);
  assert.ok(named.includes("Fleet work"), named);

  const placeholder = titles([nativeItem({
    label: "Fleet work",
    lifecycle: "error",
    hasLiveProcess: false,
    unavailable: true,
    activity: ["Claude sessions are not restored; open New to start one"],
  })]);
  assert.ok(placeholder.includes("Fleet work (unavailable)"),
    `a remembered placeholder keeps its caption and still states it is unavailable: ${placeholder}`);

  const unnamedPlaceholder = titles([nativeItem({
    lifecycle: "error",
    hasLiveProcess: false,
    unavailable: true,
    activity: ["Claude sessions are not restored; open New to start one"],
  })]);
  assert.ok(unnamedPlaceholder.includes("Claude (unavailable)"), unnamedPlaceholder);
});

test("E on a remembered native placeholder refuses instead of captioning a stale slot", () => {
  const harness = rosterWith([nativeItem({
    lifecycle: "error",
    hasLiveProcess: false,
    unavailable: true,
    activity: ["Claude sessions are not restored; open New to start one"],
  })]);
  assert.equal(drawnText(harness).includes("e edit name"), false,
    "the footer advertises no naming affordance the placeholder would refuse");
  harness.send("e");
  assert.deepEqual(harness.focusedActions(), [], "a placeholder owns no row to caption");
  assert.equal(harness.controller.focus, "sidebar", "no editor opens on a stale slot");
  assert.ok(drawnText(harness).includes("A remembered native row is not a live session to name"),
    drawnText(harness));

  // A live native row keeps the affordance, because there E is honored.
  const live = rosterWith([nativeItem()]);
  assert.ok(drawnText(live).includes("e edit name"), drawnText(live));
});

// ---------------------------------------------------------------------------
// The Pi rename path is untouched.
// ---------------------------------------------------------------------------

test("E on a Pi row still emits the ordinary edit intent with its observed native tuple", () => {
  const harness = rosterWith([piItem()]);
  harness.send("e");
  assert.deepEqual(harness.focusedActions(), [{
    type: "edit",
    id: "pi-1",
    nativeSession: { sessionId: "11111111-1111-4111-8111-111111111111", epoch: 1, name: "old name" },
  }], "the Pi conversation rename keeps its authenticated tuple-carrying intent");
  assert.equal(harness.focusedActions().some((action) => action.type === "rename-native"), false,
    "a Pi row never takes the host-side caption path");
});
