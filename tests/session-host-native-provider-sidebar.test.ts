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
 * - the Provider line offers only the CHOSEN destination's own targets, so a
 *   native-less remote owner keeps Pi-only behavior, an explicit native choice is
 *   never reinterpreted for another destination or owner run, and nothing is ever
 *   silently converted into a Pi submission.
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
  type SidebarFieldFactoryOptions,
  type SidebarFieldFactoryResult,
  type SidebarItem,
  type SidebarNativeCliTarget,
  SidebarController,
} from "../src/session-host/sidebar";
import type {
  SessionHostFieldRender,
  SessionHostFieldSubmission,
} from "../src/session-host/field-editor";
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

/**
 * A destination whose owner really negotiated the native lane and advertises this
 * catalog, so its New form can offer those owner targets and only those.
 */
function peerHostNative(
  id: string,
  label: string,
  targets: readonly SidebarNativeCliTarget[] = [
    { id: "claude", backend: "claude", label: "Claude (owner)" },
  ],
  state: PeerUiHost["state"] = "connected",
): PeerUiHost {
  return { ...peerHost(id, label), state, nativeCli: { supported: true, targets } };
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

test("Shift+Tab walks Provider then Host, cycles the drawn choice, and Tab follows the drawn order", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.send("/draft");
  // The drawn order is Header, Host, Provider, Workspace, and the ring follows
  // it: one Shift+Tab from the workspace field reaches the Provider line drawn
  // directly above it, a second reaches the Host line above that.
  harness.send(SHIFT_TAB);
  let texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("  Host: [ Local ]")), JSON.stringify(texts));
  assert.ok(texts.some((line) => line.startsWith("> Provider: [ Pi ]")),
    `the first Shift+Tab owns the control drawn above the field: ${JSON.stringify(texts)}`);

  harness.send(SHIFT_TAB);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Host: [ Local ]")),
    "continuing the focus ring reaches the Host line");
  assert.ok(texts.some((line) => line.startsWith("  Provider: [ Pi ]")), JSON.stringify(texts));

  // Tab forward from Host steps down onto the Provider line, not past it.
  harness.send(TAB);
  texts = paneTexts(harness);
  assert.ok(texts.some((line) => line.startsWith("> Provider: [ Pi ]")),
    `Tab follows the drawn order into the Provider line: ${JSON.stringify(texts)}`);

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
  // The destination advertises its OWN native lane, so the Provider line stays
  // drawn across the Host cycle and this test keeps exercising focus ownership.
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha")]));
  const drawn = paneTexts(harness);
  const hostRow = drawn.findIndex((line) => line.startsWith("  Host: [ Local ]"));
  const providerRow = drawn.findIndex((line) => line.startsWith("  Provider: [ Pi ]"));
  assert.ok(hostRow >= 0 && providerRow >= 0, JSON.stringify(drawn));

  // Keyboard focus reaches the Provider line, then a mouse press on the HOST
  // label transfers the single focus: the drawn marker moves, and the very same
  // keys now act on Host instead of the previously focused Provider.
  harness.send(SHIFT_TAB); // Provider line (drawn directly above the field)
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
    "a Host change never reinterprets the provider selection: it stays Pi");

  // The reverse transition: a forward Tab from the Host line steps back down
  // onto the Provider line it precedes, and a mouse press on the Host label
  // again leaves exactly one focused control.
  harness.send(TAB); // Host -> Provider (keyboard, following the drawn order)
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

/** Give the currently drawn New form the writer receipt Main would report. */
function settleNewForm(harness: Harness): void {
  void paneTexts(harness);
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "the drawn New form must be capturable");
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
}

/** Give the currently drawn REMOTE Edit form the writer receipt Main would report. */
function settleEditForm(harness: Harness): void {
  void paneTexts(harness);
  const drawn = harness.controller.captureEditFormPresentation();
  assert.ok(drawn !== undefined, "the drawn remote Edit form must be capturable");
  assert.equal(harness.controller.settleEditFormRender(drawn!.renderToken), true);
}

/** True when a drawn notice line contains this exact phrase (notices clip). */
function showsNotice(texts: string[], phrase: string): boolean {
  return texts.map((line) => line.trim()).some((line) => line.startsWith("! ") && line.includes(phrase));
}

test("a native-less remote owner offers no native choice and keeps Pi-only behavior", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  void paneTexts(harness);
  harness.send(SHIFT_TAB); // Provider line (the control drawn above the field)
  harness.send(SHIFT_TAB); // Host line
  harness.send(DOWN); // -> Lab Alpha
  harness.send(TAB); // the focus ring skips the undrawn Provider and reaches Workspace
  harness.baseline = harness.actions.length;
  harness.send("/srv/app");
  settleNewForm(harness);
  harness.send(ENTER);
  // This owner never advertised native targets, so the form drew no Provider line
  // for it at all: no native choice exists to make, and the submission stays the
  // ordinary Pi remote create this owner has always answered.
  const drawn = paneTexts(harness);
  assert.equal(drawn.some((line) => line.includes("Provider:")), false,
    `a native-less owner draws no Provider line: ${JSON.stringify(drawn)}`);
  const actions = harness.focusedActions();
  assert.deepEqual(actions.map((action) => action.type), ["create-on-peer"],
    `an unchanged remote submission keeps its exact Pi shape: ${JSON.stringify(actions)}`);
});

test("an explicit native choice is never reinterpreted for another destination", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHost("lab-a", "Lab Alpha")]));
  void paneTexts(harness);
  // Choose a LOCAL native target first.
  harness.send(SHIFT_TAB); // Provider line
  harness.send(DOWN); // -> Claude (this host's own target)
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Claude Code (default) ]")));
  harness.baseline = harness.actions.length;
  // Now change the Host to an owner that never advertised native targets. The
  // explicit choice is dropped AND stated: it is never quietly kept as if the
  // owner had a same-named configuration, and never quietly relabelled as Pi.
  harness.send(SHIFT_TAB); // Host line
  harness.send(DOWN); // -> Lab Alpha
  const drawn = paneTexts(harness);
  assert.ok(showsNotice(drawn, "is not available on"),
    JSON.stringify(drawn));
  assert.equal(drawn.some((line) => line.startsWith("> Provider: [ Claude")), false,
    `the stale native choice is not drawn as if it still applied: ${JSON.stringify(drawn)}`);
  assert.deepEqual(harness.focusedActions(), [],
    "a Host change never submits or launches anything");
});

test("a target the owner withdrew is refused instead of silently becoming Pi", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha")]));
  void paneTexts(harness);
  // Select the OWNER destination first, then pick the target it advertises.
  harness.send(SHIFT_TAB); // Provider line
  harness.send(SHIFT_TAB); // Host line
  harness.send(DOWN); // -> Lab Alpha
  harness.send(TAB); // Host -> Provider, following the drawn order
  harness.send(DOWN); // -> Claude (owner)
  assert.ok(paneTexts(harness).some((line) => line.startsWith("> Provider: [ Claude (owner) ]")),
    JSON.stringify(paneTexts(harness)));
  harness.send(TAB); // back to the workspace field
  harness.send("/srv/app");
  // The owner still advertises the native lane, but no longer this target.
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", [])]));
  harness.baseline = harness.actions.length;
  settleNewForm(harness);
  harness.send(ENTER);
  const drawn = paneTexts(harness);
  assert.deepEqual(harness.focusedActions(), [],
    "a withdrawn owner target is never submitted, and never quietly answered by a Pi create");
  assert.ok(showsNotice(drawn, "Provider choice no longer applies to this"),
    JSON.stringify(drawn));
});

/**
 * Select one owner destination and the native target it advertises, then fill the
 * workspace. Leaves the form open with the native choice held.
 */
function chooseNativeOnOwner(harness: Harness, label = "Claude (owner)"): void {
  void paneTexts(harness);
  harness.send(SHIFT_TAB); // Provider line
  harness.send(SHIFT_TAB); // Host line
  harness.send(DOWN); // -> the owner destination
  harness.send(TAB); // Host -> Provider, following the drawn order
  harness.send(DOWN); // -> the owner's advertised target
  assert.ok(paneTexts(harness).some((line) => line.startsWith(`> Provider: [ ${label} ]`)),
    JSON.stringify(paneTexts(harness)));
  harness.send(TAB); // back to the workspace field
  harness.send("/srv/app");
  void paneTexts(harness);
}

test("reconnecting the same owner run never revives a native provider choice", () => {
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha")]));
  chooseNativeOnOwner(harness);
  // The destination drops and comes straight back with the SAME owner run, state,
  // fingerprint, and advertised catalog. Every value the choice is compared against
  // is identical again, so a comparison of present values would call it current.
  harness.controller.setPeerUiSnapshot(
    peerSnapshot([peerHostNative("lab-a", "Lab Alpha", [], "disconnected")]),
  );
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha")]));
  harness.baseline = harness.actions.length;
  // Redraw and settle exactly as Main would, so the refusal below cannot be blamed
  // on a missing writer receipt.
  void paneTexts(harness);
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "the drawn New form must be capturable");
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
  harness.send(ENTER);
  const after = paneTexts(harness);
  assert.deepEqual(harness.focusedActions(), [],
    "a reconnect to the same run submits nothing, and never quietly becomes a Pi create");
  assert.ok(showsNotice(after, "Provider choice no longer applies to this"),
    JSON.stringify(after));
});

test("a target withdrawn and then restored never revives a native provider choice", () => {
  const catalog = [{ id: "claude", backend: "claude" as const, label: "Claude (owner)" }];
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", catalog)]));
  chooseNativeOnOwner(harness);
  // Withdraw the target, then advertise it again byte-for-byte.
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", [])]));
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", catalog)]));
  harness.baseline = harness.actions.length;
  // The scope move already retired the receipt the earlier frame had earned, so the
  // form is redrawn and settled again here: the refusal below is the provider-scope
  // latch, never a missing writer receipt.
  void paneTexts(harness);
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "the drawn New form must be capturable");
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
  harness.send(ENTER);
  const after = paneTexts(harness);
  assert.deepEqual(harness.focusedActions(), [],
    "a restored target is not the same grant as the withdrawn one, and nothing is sent");
  assert.ok(showsNotice(after, "Provider choice no longer applies to this"),
    JSON.stringify(after));
});

/**
 * A workspace field that can overflow its own row budget by one row. That is the
 * layout condition under which the New form gives up the Provider line: the field,
 * a pending/error status, and the hint footer are never displaced by a provider
 * control, so the provider control is the one that disappears.
 */
class BudgetField {
  /** When true this render fills its budget plus one row. */
  overflow = false;
  private text: string;
  constructor(
    initialText: string,
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
    // The New form gives up its Provider line exactly when the field fills its own
    // budget AND a pending/error status row is present: neither may be displaced.
    const count = Math.max(3, this.overflow ? rows : 3);
    const body = `${this.text.slice(0, Math.max(0, cols - 1))}${" ".repeat(cols)}`;
    const lines = ["\u2500".repeat(cols)];
    for (let index = 1; index < count - 1; index += 1) lines.push(index === 1 ? body : " ".repeat(cols));
    lines.push("\u2500".repeat(cols));
    return { lines, cursor: { column: 1, row: 1, visible: true }, contentRow: 1 };
  }
}

/** Open the New form with a workspace field the test can make overflow its budget. */
function budgetNewForm(): { harness: Harness; field: () => BudgetField | undefined } {
  let field: BudgetField | undefined;
  const harness = makeController({
    nativeCliTargets: TARGETS,
    createTextField: (options: SidebarFieldFactoryOptions): SidebarFieldFactoryResult => {
      field = new BudgetField(options.initialText ?? "", options.onSubmit);
      return { field: field as unknown as SidebarFieldFactoryResult["field"] };
    },
  });
  void harness.controller.render(40, 20);
  harness.send(ENTER); // the default "New session" row opens the form
  assert.equal(harness.controller.focus, "form");
  return { harness, field: () => field };
}

test("a provider scope that moves after submission retires the in-flight native create", () => {
  const catalog = [{ id: "claude", backend: "claude" as const, label: "Claude (owner)" }];
  const { harness } = newForm({ nativeCliTargets: TARGETS });
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", catalog)]));
  chooseNativeOnOwner(harness);
  settleNewForm(harness);
  harness.send(ENTER);
  const actions = harness.focusedActions();
  assert.deepEqual(actions.map((action) => action.type), ["create-native-on-peer"],
    JSON.stringify(actions));
  const submitted = actions[0] as Extract<SidebarAction, { type: "create-native-on-peer" }>;
  const proof = (): boolean => harness.controller.createOnPeerStillCurrent({
    requestId: submitted.requestId,
    formGeneration: submitted.formGeneration,
    hostId: submitted.hostId,
    hostRunId: submitted.hostRunId,
    workspace: submitted.workspace,
  });
  // Main evaluates exactly this proof inside the ordered write that reaches the
  // transport, so it starts out true for the request that owns this form.
  assert.equal(proof(), true, "the submitted request owns this form before anything moves");
  // Withdraw the advertised target and advertise it again, byte for byte. The owner
  // run, the connection state, and the destination fingerprint never change, so the
  // run/connection retirement branch alone would never notice this transition.
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", [])]));
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha", catalog)]));
  // The in-flight native create is retired through the existing uncertainty path, so
  // a held or delayed write can no longer launch on a choice the operator never
  // re-confirmed. Nothing is re-sent, retried, or retargeted by this side.
  assert.equal(proof(), false,
    "a provider scope that moved retires the pending native create's last-instant proof");
});

test("a Provider line this pane suppressed never authorizes a native create", () => {
  const { harness, field } = budgetNewForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha")]));
  chooseNativeOnOwner(harness);
  // An earlier failed create leaves a status row, and the field now fills its whole
  // budget. Neither may be displaced, so the provider control is what disappears
  // from a pane that still holds the native selection underneath.
  settleNewForm(harness);
  harness.send(ENTER);
  const first = harness.focusedActions();
  assert.deepEqual(first.map((action) => action.type), ["create-native-on-peer"],
    JSON.stringify(first));
  harness.controller.failCreateOnPeer(
    (first[0] as { readonly requestId: number }).requestId,
    "the owner refused that session",
  );
  const editor = field();
  assert.ok(editor !== undefined, "the New form must own a workspace field");
  editor!.overflow = true;
  const narrow = paneTexts(harness);
  assert.equal(narrow.some((line) => line.includes("Provider:")), false,
    `an overflowing field must suppress the Provider line: ${JSON.stringify(narrow)}`);
  harness.baseline = harness.actions.length;
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "the drawn New form must be capturable");
  // The receipt describes what was DRAWN: no Provider line means no provider.
  assert.equal(drawn!.providerKey, undefined,
    `a suppressed Provider line leaves no provider receipt: ${JSON.stringify(drawn)}`);
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
  harness.send(ENTER);
  const after = paneTexts(harness);
  assert.deepEqual(harness.focusedActions(), [],
    "a frame that never displayed the provider launches nothing");
  assert.ok(showsNotice(after, "No Provider line is drawn here"), JSON.stringify(after));
});

test("a suppressed Provider line still submits the ordinary Pi remote create", () => {
  const { harness, field } = budgetNewForm();
  harness.controller.setPeerUiSnapshot(peerSnapshot([peerHostNative("lab-a", "Lab Alpha")]));
  // Select the owner WITHOUT touching the provider, so the choice stays Pi.
  void paneTexts(harness);
  harness.send(SHIFT_TAB); // Provider line
  harness.send(SHIFT_TAB); // Host line
  harness.send(DOWN); // -> the owner destination
  harness.send(TAB); // -> Provider, still Pi
  harness.send(TAB); // -> Workspace
  harness.send("/srv/app");
  settleNewForm(harness);
  harness.send(ENTER);
  const first = harness.focusedActions();
  assert.deepEqual(first.map((action) => action.type), ["create-on-peer"], JSON.stringify(first));
  harness.controller.failCreateOnPeer(
    (first[0] as { readonly requestId: number }).requestId,
    "the owner refused that session",
  );
  const editor = field();
  assert.ok(editor !== undefined, "the New form must own a workspace field");
  editor!.overflow = true;
  const narrow = paneTexts(harness);
  assert.equal(narrow.some((line) => line.includes("Provider:")), false,
    `an overflowing field must suppress the Provider line: ${JSON.stringify(narrow)}`);
  harness.baseline = harness.actions.length;
  const drawn = harness.controller.captureCreateFormPresentation();
  assert.ok(drawn !== undefined, "the drawn New form must be capturable");
  assert.equal(harness.controller.settleCreateFormRender(drawn!.renderToken), true);
  harness.send(ENTER);
  // A Pi submission is what this frame always was: the suppressed line names no
  // provider, and the ordinary remote create is unaffected.
  assert.deepEqual(harness.focusedActions().map((action) => action.type), ["create-on-peer"],
    JSON.stringify(harness.focusedActions()));
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
  const text = rosterText(harness, 40);
  assert.ok(text.includes("Claude"), `the provider names the card: ${JSON.stringify(text)}`);
  assert.ok(text.includes("agent unknown | input unknown"),
    "missing telemetry is never rendered as idle or none");
  assert.ok(text.includes("background unknown"),
    "missing counts use the one shared card summary and are never rendered as zero");

  // The same row with the Pi telemetry a native child can never produce.
  const pi = rosterWith([{ ...NATIVE_ITEM, backend: undefined, busy: false, pendingInput: false,
    backgroundTasks: 0, backgroundShells: 0, activeTasks: 0, activeShells: 0 }]);
  const piText = rosterText(pi, 40);
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
  // E on a native row opens the host-side naming editor: no Pi rename/edit intent
  // is emitted, and nothing is sent until the operator submits a name.
  assert.deepEqual(harness.focusedActions(), [], "a native row emits no Pi rename/edit request");
  assert.equal(harness.controller.focus, "form", "the existing Edit form owns the native row's name");
  harness.send(ESC);
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focusedActions(), [], "cancelling the naming editor emits nothing");
  void rosterText(harness); // the roster must be drawn whole again before a row key acts
  harness.send(ENTER);
  assert.deepEqual(harness.focusedActions().at(-1), { type: "select", id: "native-1" },
    "selecting a live native row stays the ordinary select");
});

test("E on a remembered native placeholder refuses instead of captioning a stale slot", () => {
  const harness = rosterWith([
    { ...NATIVE_ITEM, id: "native-3", lifecycle: "error", hasLiveProcess: false, unavailable: true,
      activity: ["Claude sessions are not restored; open New to start one"] },
  ]);
  void rosterText(harness);
  harness.send(UP); // New -> Saved conversations
  harness.send(UP); // -> the unavailable placeholder
  assert.equal(harness.controller.selectedId, "native-3");
  harness.send("e");
  assert.deepEqual(harness.focusedActions(), [], "a placeholder owns no row to caption");
  assert.equal(harness.controller.focus, "sidebar", "no editor opens on a stale slot");
  assert.ok(drawnNotice(
    harness.controller.render(40, 30).lines.map((line) => line.replace(SGR_PATTERN, "")),
    "A remembered native row is not a live session to name",
  ));
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
