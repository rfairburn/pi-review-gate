/**
 * Focused UI tests for the New form's native provider selection and the honest
 * display of native Claude/Codex rows (issue #277 host-UI slice).
 *
 * Everything here is pure frontend: the controller only renders and emits action
 * DTOs, so no process, PTY, filesystem, config, or provider work happens. The
 * assertions pin the four behaviours the feature promises:
 *
 * - a host that offers no native target draws the exact pre-native New form;
 * - a host that offers targets defaults to Pi at EVERY opening and only an
 *   explicit native choice travels on the create action;
 * - a native row's card states its provider and nothing invented, with every
 *   Pi-only control refused truthfully;
 * - a native choice plus a remote Host is a truthful refusal, never a silent
 *   Pi submission.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import { MAX_NATIVE_CLI_TARGET_CHARS } from "../src/session-host/session-backend";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
  type SidebarNativeCliTarget,
  SidebarController,
} from "../src/session-host/sidebar";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT = "\x1b[1;3D";
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

/** The two default targets plus one explicit configured shared-CLI target. */
const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
  { id: "external:review-box", backend: "codex", label: "review-box (Codex CLI)" },
];

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  focusedActions(): SidebarAction[];
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
  };
  return harness;
}

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

/** Show the roster (sidebar focus) with the given rows already drawn. */
function rosterWith(items: SidebarItem[], options: SidebarControllerOptions = {}): Harness {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems(items);
  harness.send(ALT_LEFT);
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return harness;
}

/** Open the New form and return the drawn pane text plus the harness. */
function newForm(options: SidebarControllerOptions = {}, cols = 48, rows = 14): { harness: Harness; texts: string[] } {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT); // show -> focus sidebar (New row selected)
  void harness.controller.render(40, 20);
  harness.send(ENTER); // New session -> the form
  assert.equal(harness.controller.focus, "form");
  const texts = paneTexts(harness, cols, rows);
  harness.baseline = harness.actions.length;
  return { harness, texts };
}

function paneTexts(harness: Harness, cols = 48, rows = 14): string[] {
  const rendered = harness.controller.render(cols, rows);
  for (const line of rendered.lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than the pane: ${JSON.stringify(line)}`);
  }
  return rendered.lines.map((line) => line.replace(SGR_PATTERN, ""));
}

/** The complete `! <message>` refusal drawn in a pane, across word wraps. */
function drawnNotice(texts: string[], message: string): boolean {
  const target = `! ${message}`;
  const rows = texts.map((line) => line.trim());
  for (let start = 0; start < rows.length; start += 1) {
    if (!rows[start]!.startsWith("! ")) continue;
    let joined = rows[start]!;
    if (joined === target) return true;
    for (let cursor = start + 1; cursor < rows.length && rows[cursor] !== ""; cursor += 1) {
      joined = `${joined} ${rows[cursor]}`;
      if (joined === target) return true;
      if (joined.length > target.length) break;
    }
  }
  return false;
}

function peerHost(id: string, label: string): PeerUiHost {
  return {
    id, label, host: "10.0.0.5", port: 8443, state: "connected", fingerprint: null,
    message: null, reconnectSuppressed: false, previouslyConnected: true,
    roster: { state: "current", rows: [], hostRunId: "run-a" },
  };
}

function peerSnapshot(hosts: readonly PeerUiHost[]): PeerUiSnapshot {
  return {
    revision: 1, status: "ready", settings: null, identityFingerprint: null,
    listener: { state: "off", host: null, port: null, message: null },
    hosts, trustedPeers: [], consents: [], notice: null,
  };
}

// --- The New form's Provider line. ---

test("a host with no native target draws no Provider line and submits the unchanged Pi create", () => {
  const { harness, texts } = newForm();
  assert.ok(texts.some((line) => line.includes("New session")));
  assert.ok(texts.some((line) => line.startsWith("  Host: [ Local ]")), JSON.stringify(texts));
  assert.equal(texts.some((line) => line.includes("Provider:")), false,
    "without an offered target the New form keeps its exact pre-native layout");

  harness.send("/workspace");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "create", requestId: 1, workspace: "/workspace" }],
    "an ordinary submission is byte-for-byte the existing local create action");
});

test("the Provider line offers Pi first and an ordinary submission still carries no provider", () => {
  const { harness, texts } = newForm({ nativeCliTargets: TARGETS });
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Pi ]")), JSON.stringify(texts));
  assert.equal(texts.some((line) => line.includes("Claude Code")), false,
    "the default choice is Pi, not the first offered native target");

  harness.send("/workspace");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "create", requestId: 1, workspace: "/workspace" }],
    "a default Pi submission keeps the exact existing action shape");
});

test("Shift+Tab walks Host then Provider, cycles the drawn choice, and Tab returns to the workspace", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.send("/draft");
  harness.send(SHIFT_TAB);
  let texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Host: [ Local ]")), JSON.stringify(texts));
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Pi ]")));

  harness.send(SHIFT_TAB);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("  Host: [ Local ]")),
    "continuing the focus ring leaves the Host line unfocused");
  assert.ok(texts.some((line) => line.startsWith("> Provider: [ Pi ]")), JSON.stringify(texts));

  harness.send(DOWN);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Provider: [ Claude Code (default) ]")), JSON.stringify(texts));
  harness.send(DOWN);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Provider: [ Codex CLI (default) ]")), JSON.stringify(texts));
  harness.send(DOWN);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Provider: [ review-box (Codex CLI) ]")), JSON.stringify(texts));
  harness.send(UP);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Codex CLI (default) ]")),
    "the cycle is bounded and reversible");

  harness.send(TAB);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Codex CLI (default) ]")),
    "Tab returns the focus to the workspace editor without changing the choice");
  assert.equal(texts.some((line) => line.includes("> Provider:")), false);
  assert.equal(harness.focusedActions().length, 0, "cycling a provider emits no backend action by itself");

  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "create",
    requestId: 1,
    workspace: "/draft",
    backend: "codex",
    nativeCliTarget: "codex",
  }], "the selected default target travels as its own stable id plus the backend");
});

test("an explicit configured target travels unchanged as backend plus target id", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.send("/srv/app");
  harness.send(SHIFT_TAB); // Host
  harness.send(SHIFT_TAB); // Provider
  harness.send(DOWN); // claude
  harness.send(DOWN); // codex
  harness.send(DOWN); // external:review-box
  harness.send(TAB); // back to the workspace field
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{
    type: "create",
    requestId: 1,
    workspace: "/srv/app",
    backend: "codex",
    nativeCliTarget: "external:review-box",
  }], "the operator's exact target id and backend are echoed, never re-derived");
});

test("every New opening resets the provider to Pi", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.send("/keep");
  harness.send(SHIFT_TAB);
  harness.send(SHIFT_TAB);
  harness.send(DOWN);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Claude Code (default) ]")));

  harness.send(ESC); // leave the selection control
  assert.ok(paneTexts(harness).some((line) => line.startsWith("  Provider: [ Claude Code (default) ]")));
  harness.send(ESC); // cancel the form back to the visible roster
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 20);
  harness.send(ENTER); // reopen New
  assert.equal(harness.controller.focus, "form");
  const texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Pi ]")),
    `a native choice is never the remembered default of the next New form: ${JSON.stringify(texts)}`);
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [{ type: "create", requestId: 1, workspace: "/keep" }],
    "the retained workspace draft still submits as plain Pi");
});

test("a drawn Provider value click cycles only the drawn provider control", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  const texts = paneTexts(harness);
  const providerRow = texts.findIndex((line) => line.startsWith("  Provider: [ Pi ]"));
  assert.ok(providerRow >= 0, JSON.stringify(texts));
  const presentation = harness.controller.captureMousePresentation();
  assert.equal(presentation.activateFormProviderAt?.(4, providerRow, 48, 14), true,
    "a press on the drawn row focuses the control");
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Pi ]")));

  const focused = harness.controller.captureMousePresentation();
  assert.equal(focused.activateFormProviderAt?.(14, providerRow, 48, 14), true,
    "a press on the drawn value span cycles the provider");
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Claude Code (default) ]")));
  assert.equal(focused.activateFormProviderAt?.(14, providerRow, 48, 14), false,
    "the same written frame cannot cycle the provider again after its option list changed");
  assert.equal(focused.activateFormProviderAt?.(14, providerRow + 1, 48, 14), false,
    "a press on another row acts on nothing");
});

/** Which of the two selector lines the drawn frame marks as focused. */
function focusedSelectors(lines: string[]): string[] {
  return lines
    .filter((line) => line.startsWith("> Host: ") || line.startsWith("> Provider: "))
    .map((line) => line.slice(2, line.indexOf(":")));
}

test("a label click owns exactly one selector, and the keys follow the drawn marker", () => {
  const { harness, texts } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  const drawn = paneTexts(harness);
  const hostRow = drawn.findIndex((line) => line.startsWith("  Host: [ Local ]"));
  const providerRow = drawn.findIndex((line) => line.startsWith("  Provider: [ Pi ]"));
  assert.ok(hostRow >= 0 && providerRow >= 0, JSON.stringify(drawn));

  // Keyboard focus reaches the Provider line, then a mouse press on the HOST
  // label transfers the single focus: the drawn marker moves, and the very same
  // keys now act on Host instead of the previously focused Provider.
  harness.send(SHIFT_TAB); // Host line
  harness.send(SHIFT_TAB); // Provider line
  assert.deepEqual(focusedSelectors(paneTexts(harness)), ["Provider"]);
  const shown = harness.controller.captureMousePresentation();
  assert.equal(shown.activateFormHostAt?.(0, hostRow, 48, 14), true,
    "a press on the drawn Host label focuses that control");
  assert.deepEqual(focusedSelectors(paneTexts(harness)), ["Host"],
    "the Provider line loses its focus in the same act, so one control owns the keys");
  harness.send(DOWN); // must act on Host, not on the previously focused Provider
  const afterHostCycle = paneTexts(harness);
  assert.ok(afterHostCycle.some((line) => line.startsWith("> Host: [ Lab Alpha ]")),
    JSON.stringify(afterHostCycle));
  assert.ok(afterHostCycle.some((line) => line.startsWith("  Provider: [ Pi ]")),
    "the provider selection is untouched by the Host cycle");

  // The reverse transition: keyboard focus lands back on the Provider line, and
  // a mouse press on the Host label again leaves exactly one focused control.
  harness.send(SHIFT_TAB); // Host -> Provider (keyboard)
  assert.deepEqual(focusedSelectors(paneTexts(harness)), ["Provider"]);
  const relabel = harness.controller.captureMousePresentation();
  assert.equal(relabel.activateFormHostAt?.(0, hostRow, 48, 14), true);
  assert.deepEqual(focusedSelectors(paneTexts(harness)), ["Host"]);
  harness.send(DOWN); // cycles Host back to Local; the provider never moves
  const afterSecondHostCycle = paneTexts(harness);
  assert.ok(afterSecondHostCycle.some((line) => line.startsWith("> Host: [ Local ]")),
    JSON.stringify(afterSecondHostCycle));
  assert.ok(afterSecondHostCycle.some((line) => line.startsWith("  Provider: [ Pi ]")));

  // A Provider label click transfers focus the other way, and its keys act on
  // the Provider line alone.
  const providerShown = harness.controller.captureMousePresentation();
  assert.equal(providerShown.activateFormProviderAt?.(0, providerRow, 48, 14), true,
    "a press on the drawn Provider label focuses that control");
  assert.deepEqual(focusedSelectors(paneTexts(harness)), ["Provider"]);
  harness.send(DOWN); // -> Claude, and Host stays Local
  const afterProviderCycle = paneTexts(harness);
  assert.ok(afterProviderCycle.some((line) => line.startsWith("> Provider: [ Claude Code (default) ]")),
    JSON.stringify(afterProviderCycle));
  assert.ok(afterProviderCycle.some((line) => line.startsWith("  Host: [ Local ]")));

  // Tab from a mouse-focused control returns to the ordinary workspace field.
  harness.send(TAB);
  assert.equal(harness.controller.focus, "form");
  harness.baseline = harness.actions.length;
  harness.send("/srv/app");
  assert.ok(paneTexts(harness).some((line) => line.includes("/srv/app")),
    "the field owns typing again after the selector focus");
  assert.deepEqual(harness.focusedActions(), [],
    "focus transfers and cycles never submit or launch anything");
});

test("a native provider choice with a remote Host refuses truthfully and emits nothing", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  void paneTexts(harness);
  harness.send(SHIFT_TAB); // Host line
  harness.send(DOWN); // -> Lab Alpha
  harness.send(SHIFT_TAB); // Provider line
  harness.send(DOWN); // -> Claude
  harness.send(TAB); // back to the workspace field
  harness.baseline = harness.actions.length;
  harness.send("/srv/app");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [],
    "a native choice is never converted into a remote create or a local Pi create");
  assert.ok(drawnNotice(paneTexts(harness), "Claude is local only; choose Local or Pi"),
    JSON.stringify(paneTexts(harness)));
});

// --- Native row display and the Pi-only controls. ---

const NATIVE_ITEM: SidebarItem = {
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
};

function rosterText(harness: Harness, cols = 32, rows = 24): string {
  return harness.controller.renderRoster(cols, rows).lines.map((line) => line.replace(SGR_PATTERN, "")).join("\n");
}

test("a native row is titled by its provider and stays honestly unknown", () => {
  const harness = rosterWith([NATIVE_ITEM]);
  const text = rosterText(harness);
  assert.ok(text.includes("Claude"), `the provider names the card: ${JSON.stringify(text)}`);
  assert.ok(text.includes("agent unknown | input unknown"),
    "missing telemetry is never rendered as idle or none");
  assert.ok(text.includes("background unknown"), "missing counts are never rendered as zero");

  // The same row with the Pi telemetry a native child can never produce.
  const pi = rosterWith([{ ...NATIVE_ITEM, backend: undefined, busy: false, pendingInput: false,
    backgroundTasks: 0, backgroundShells: 0, activeTasks: 0, activeShells: 0 }]);
  const piText = rosterText(pi);
  assert.ok(piText.includes("agent idle | input none"), piText);
  assert.ok(piText.includes("bg tasks 0 | shells 0"), piText);
});

test("rename, exited resume, and unavailable activation all refuse a native row without a Pi path", () => {
  const harness = rosterWith([
    NATIVE_ITEM,
    { ...NATIVE_ITEM, id: "native-2", label: "Codex", backend: "codex", lifecycle: "exited", hasLiveProcess: false },
    { ...NATIVE_ITEM, id: "native-3", label: "Claude (unavailable)", backend: "claude", lifecycle: "error",
      hasLiveProcess: false, unavailable: true, activity: ["Claude sessions are not restored; open New to start one"] },
  ]);
  void rosterText(harness);

  harness.send(UP); // New -> Saved conversations
  harness.send(UP); // -> the last card (native-3, the unavailable placeholder)
  assert.equal(harness.controller.selectedId, "native-3");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [], "an unavailable native placeholder is never activated");
  assert.ok(drawnNotice(
    harness.controller.render(40, 30).lines.map((line) => line.replace(SGR_PATTERN, "")),
    "Claude sessions are not restored; open New to start one",
  ), "the refusal states why, without offering a Pi resume");

  harness.send(UP); // -> native-2 (exited)
  assert.equal(harness.controller.selectedId, "native-2");
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions(), [], "an exited native row emits no resume-row request");
  assert.ok(drawnNotice(
    harness.controller.render(40, 30).lines.map((line) => line.replace(SGR_PATTERN, "")),
    "A Codex row cannot be resumed; open New to start one",
  ));

  harness.send(UP); // -> native-1 (alive)
  assert.equal(harness.controller.selectedId, "native-1");
  harness.send("e");
  assert.deepEqual(harness.focusedActions(), [], "a native row emits no rename/edit request");
  assert.ok(drawnNotice(
    harness.controller.render(40, 30).lines.map((line) => line.replace(SGR_PATTERN, "")),
    "Claude rows have no renameable Pi session name",
  ));
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "native-1" },
    "selecting a live native row stays the ordinary select");
});

test("a live native row still requires the existing stop confirmation", () => {
  const harness = rosterWith([NATIVE_ITEM]);
  void rosterText(harness);
  harness.send(UP); // New -> Saved
  harness.send(UP); // -> native-1
  assert.equal(harness.controller.selectedId, "native-1");
  harness.baseline = harness.actions.length;
  harness.send("d");
  assert.deepEqual(harness.focusedActions(), [],
    "unknown telemetry is never treated as idle, so no unconfirmed stop is requested");
  assert.equal(harness.controller.focus, "confirm", "the frozen confirmation is the ordinary path");
  // The confirmation only confirms from the frame that actually drew it whole.
  assert.ok(paneTexts(harness).some((line) => line.includes("stop")),
    "the drawn warning is the operator's own confirmation target");
  harness.baseline = harness.actions.length;
  harness.send("y");
  assert.deepEqual(harness.focusedActions(), [{ type: "stop-remove", id: "native-1", confirmed: true }],
    "the confirmed stop is the same existing action");
});

test("a malformed provider identity is dropped rather than guessed", () => {
  const harness = makeController({
    initialVisible: false,
    nativeCliTargets: [
      { id: "", backend: "claude", label: "no id" },
      { id: "bad", backend: "kittens", label: "no backend" },
      { id: "dup", backend: "claude", label: "first wins" },
      { id: "dup", backend: "codex", label: "duplicate id" },
      { id: "blank", backend: "codex", label: "   " },
    ] as unknown as readonly SidebarNativeCliTarget[],
  });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 20);
  harness.send(ENTER);
  const texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Pi ]")), JSON.stringify(texts));
  harness.send(SHIFT_TAB);
  harness.send(SHIFT_TAB);
  harness.send(DOWN);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ first wins ]")),
    "only the first entry of a duplicated id survives, and malformed ids and backends are gone");
  harness.send(DOWN);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Codex ]")),
    "a blank label falls back to the backend's stable provider label");
  harness.send(DOWN);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Pi ]")),
    "the cycle stays bounded to Pi plus the two surviving targets");
  assert.equal(paneTexts(harness).some((line) => line.includes("no id") || line.includes("no backend")), false);
});

test("a target the manager would refuse is dropped at the exact shared bound", () => {
  // The same bound the manager validates a create against: a 128-character id is
  // offered, one character more is not, and neither is a C1 control character.
  const targets: readonly SidebarNativeCliTarget[] = [
    { id: "x".repeat(MAX_NATIVE_CLI_TARGET_CHARS), backend: "claude", label: "at the bound" },
    { id: "x".repeat(MAX_NATIVE_CLI_TARGET_CHARS + 1), backend: "claude", label: "one over" },
    { id: "c1\u0080target", backend: "codex", label: "c1 control" },
    { id: "del\u007ftarget", backend: "codex", label: "del control" },
  ];
  const harness = makeController({ initialVisible: false, nativeCliTargets: targets });
  harness.controller.updateItems([makeItem({ id: "a" })]);
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 20);
  harness.send(ENTER);
  const texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Pi ]")), JSON.stringify(texts));
  harness.send(SHIFT_TAB);
  harness.send(SHIFT_TAB);
  harness.send(DOWN);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ at the bound ]")),
    "an id exactly at the manager's bound is a real offer");
  harness.send(DOWN);
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Pi ]")),
    "the cycle holds only Pi plus the one target inside the bound");
  const drawn = paneTexts(harness).join("\n");
  assert.equal(drawn.includes("one over"), false, "an id past the bound would fail create, so it is never drawn");
  assert.equal(drawn.includes("c1 control"), false, "a C1 control character is not a target id");
  assert.equal(drawn.includes("del control"), false, "DEL is not a target id");
});
