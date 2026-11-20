/**
 * Issue #653: per-UI native menu components for standalone hosts.
 *
 * A standalone host that owns its own TUI components (the session-host
 * sidebar builds a pinned pi-tui `MenuTuiHost`) supplies it explicitly per UI
 * through `ui.menuTuiHost`. These tests pin that seam on BOTH settings
 * renderers — the retained-selection menu (`src/settings/menu.ts`) and the
 * search-capable deny picker (`src/settings/deny-picker.ts`):
 *
 * - Two `UiContext`s carrying different hosts render their own components and
 *   never interfere, including their live keybinding sync, and each renderer
 *   call prefers the host of the UI it was handed even on a shared slot.
 * - The injected host drives the SAME select component, native `Input`, live
 *   `tui.select.*` keybindings, Ctrl+S save latch, held-action fence,
 *   bracketed-paste fence, and theme seams as the existing Pi peer paths:
 *   live search, navigation, identity retention, and no-match handling all
 *   behave as they do for a Pi host.
 * - The no-injection defaults are unchanged: the process-global
 *   {@link setMenuTuiHost} test override still drives both renderers, an
 *   injected host wins over it, and resolution without an injected host is
 *   the same resolution the renderers used before this seam existed.
 * - Plain/RPC hosts stay guarded by `mode === "tui"` plus a working `custom`:
 *   an injected host never turns an RPC host into a fake TUI.
 *
 * Every injected-host test here never calls `setMenuTuiHost`, so nothing can
 * leak a global override into another UI's menus. The real-component case
 * pins a host built straight from this project's own pi-tui dependency, which
 * is exactly what the sidebar supplies.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  Container as PinnedContainer,
  Input as PinnedInput,
  Key,
  KeybindingsManager,
  matchesKey,
  SelectList as PinnedSelectList,
  Text as PinnedText,
  TUI_KEYBINDINGS,
} from "pi-session-host-tui";
import {
  filterDenyPickerRows,
  NO_MATCHING_TOOLS_MESSAGE,
  retainedDenySelect,
  type DenyPickerRow,
} from "../src/settings/deny-picker";
import {
  createMenuActionFence,
  retainedChoice,
  retainedSelect,
  resolveMenuTuiHostForRenderers,
  setMenuTuiHost,
  type MenuTuiHost,
  type RetainedUi,
  type SettingsSaveControl,
} from "../src/settings/menu";
import type { UiContext } from "../src/settings/ui";
import {
  createFakeMenuTuiHost,
  createTuiSettingsContext,
  IDENTITY_THEME,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_UP,
  stripAnsi,
  type FakeSelectList,
  type TuiSettingsHarness,
} from "./menu-tui-fakes";

const CTRL_S = "\x13";
const CTRL_C = "\x03";
// Kitty keyboard-protocol held-key events (event type 2 = repeat, 3 = release).
const REPEAT_ESCAPE = "\x1b[27;1:2u";
const RELEASE_ESCAPE = "\x1b[27;1:3u";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** A bounded per-test deadline: a scripted UI test must fail, not hang. */
const TEST_TIMEOUT_MS = 30_000;

/** The rows of one retained menu; the two UIs use different rows on purpose. */
const UI_A_ROWS = [
  { key: "a1", label: "Alpha one" },
  { key: "a2", label: "Alpha two" },
  { key: "a3", label: "Alpha three" },
];
const UI_B_ROWS = [
  { key: "b1", label: "Bravo one" },
  { key: "b2", label: "Bravo two" },
];

/** A small synthetic deny inventory plus the always-visible Back row. */
const DENY_NAMES = [
  "mcp__alpha__read_0",
  "mcp__alpha__read_1",
  "mcp__beta__read_0",
  "mcp__beta__read_1",
  "mcp__beta__write_0",
  "read",
  "bash",
  "WebFetch",
];
const DENY_ROWS: DenyPickerRow[] = [
  ...DENY_NAMES.map((name) => ({
    key: `tool:${name}`,
    label: `${name}  ✗ allowed`,
    searchText: name,
  })),
  { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
];
const DENY_TITLE = "Top-level tools — Enter toggles — 0 denied";

/** The names the shared saved-conversation grammar keeps for the query "beta". */
const NARROWED_BY_BETA = ["mcp__beta__read_0", "mcp__beta__read_1", "mcp__beta__write_0"];

const typed = (text: string): string[] => [...text];

/** The tool NAMES one rendered deny-picker frame lists, in order. */
function toolNamesOf(frame: readonly string[]): string[] {
  return frame
    .map((line) => stripAnsi(line))
    .filter((line) => /(✓ denied|✗ allowed)\s*$/.test(line))
    .map((line) => line.replace(/^\s*(→\s*)?/, "").split(/\s/)[0]!);
}

/** The highlighted row label of one rendered frame. */
function highlightedOf(frame: readonly string[]): string | undefined {
  const line = frame.map((entry) => stripAnsi(entry)).find((entry) => /^\s*→/.test(entry));
  return line?.replace(/^\s*→\s*/, "").trim();
}

/** The query line rendered by the native Input ("> query"). */
function queryLineOf(frame: readonly string[]): string | undefined {
  return frame.map((line) => stripAnsi(line)).find((line) => line.startsWith("> ") || line === ">");
}

/** A component the host slot is holding open. */
interface HostedComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate?(): void;
  focused?: boolean;
}

interface HostedUi {
  ui: UiContext & RetainedUi;
  /** Every component the renderers opened through this UI, in order. */
  slots: HostedComponent[];
  /** Every plain-selector call; must stay empty on the TUI paths. */
  plainCalls: Array<{ title: string; options: string[] }>;
}

/**
 * A host-faithful UI whose components stay drivable by the test, so one flow
 * can hold a parent menu open while its nested deny picker is shown and
 * settled. Like the production host's showExtensionCustom, the slot resolves
 * ONLY when the renderer calls `done()`, and it focuses a Focusable component
 * once it is shown.
 */
function hostedUi(
  host: MenuTuiHost,
  options: { keybindings?: unknown; saveControl?: SettingsSaveControl; mode?: string } = {},
): HostedUi {
  const slots: HostedComponent[] = [];
  const plainCalls: HostedUi["plainCalls"] = [];
  const ui: UiContext & RetainedUi = {
    mode: options.mode ?? "tui",
    menuTuiHost: host,
    ...(options.saveControl === undefined ? {} : { saveControl: options.saveControl }),
    custom(factory) {
      return new Promise<string | undefined>((resolve) => {
        const component = factory(
          { requestRender(): void {} },
          IDENTITY_THEME,
          options.keybindings ?? null,
          resolve,
        ) as HostedComponent;
        if ("focused" in component) component.focused = true;
        slots.push(component);
      });
    },
    async select(title: string, selectOptions: string[]): Promise<string | undefined> {
      plainCalls.push({ title, options: selectOptions });
      return undefined;
    },
    notify(): void {},
  };
  return { ui, slots, plainCalls };
}

/**
 * Waits for renderer `index` to have opened its component. The renderers open
 * it right after their (already settled) host resolution, so this drains
 * bounded ticks instead of sleeping.
 */
async function openedSlot(slots: HostedComponent[], index: number): Promise<HostedComponent> {
  for (let attempt = 0; attempt < 50 && slots.length <= index; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(slots.length > index, `renderer ${index} never opened a component`);
  return slots[index]!;
}

/** True while the promise has not settled yet (a slot that must stay open). */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const outcome = await Promise.race([
    promise.then(() => "settled"),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  return outcome === "pending";
}

/** A fake host with its own observable construction counters. */
function observedHost(): { host: MenuTuiHost; lists: FakeSelectList[]; setKeybindingsCalls: unknown[] } {
  const lists: FakeSelectList[] = [];
  const setKeybindingsCalls: unknown[] = [];
  const host = createFakeMenuTuiHost({ lists, setKeybindingsCalls });
  return { host, lists, setKeybindingsCalls };
}

/** The same host plus the public Ctrl+S matcher (the Pi host parity). */
function saveCapableHost(): { host: MenuTuiHost; lists: FakeSelectList[]; setKeybindingsCalls: unknown[] } {
  const observed = observedHost();
  return {
    ...observed,
    host: { ...observed.host, matchesCtrlS: (data: string) => matchesKey(data, Key.ctrl("s")) },
  };
}

/** A host built straight from this project's pi-tui dependency, as the sidebar does. */
function pinnedRealHost(): MenuTuiHost {
  return {
    SelectList: PinnedSelectList as unknown as MenuTuiHost["SelectList"],
    Container: PinnedContainer as unknown as MenuTuiHost["Container"],
    Text: PinnedText as unknown as MenuTuiHost["Text"],
    Input: PinnedInput as unknown as MenuTuiHost["Input"],
  };
}

function saveControl(): SettingsSaveControl {
  return { saveRequested: false, suspended: 0, actionFence: createMenuActionFence() };
}

/** The RetainedUi view of a fake harness context, with the harness host injected. */
function injectedTuiUi(harness: TuiSettingsHarness): UiContext & RetainedUi {
  const ui = (harness.context as { ui: UiContext & RetainedUi }).ui;
  ui.mode = "tui";
  ui.menuTuiHost = harness.host;
  return ui;
}

// ---------------------------------------------------------------------------
// Two UIs, two hosts: no interference
// ---------------------------------------------------------------------------

/**
 * A custom slot plus the components it opened, shareable by several UI
 * objects: one host UI, two different injected menu hosts.
 */
function createSharedSlot(): { custom: NonNullable<RetainedUi["custom"]>; components: HostedComponent[] } {
  const components: HostedComponent[] = [];
  const custom: NonNullable<RetainedUi["custom"]> = (factory) =>
    new Promise<string | undefined>((resolve) => {
      const component = factory({ requestRender(): void {} }, IDENTITY_THEME, null, resolve) as HostedComponent;
      if ("focused" in component) component.focused = true;
      components.push(component);
    });
  return { custom, components };
}

test("two UiContexts with separate injected hosts render their own menus concurrently", { timeout: TEST_TIMEOUT_MS }, async () => {
  // No setMenuTuiHost anywhere in this test: each UI's injected host is the
  // only host either menu can see.
  const managerA = { id: "manager-a", matches: (): boolean => false };
  const managerB = { id: "manager-b", matches: (): boolean => false };
  const harnessA = createTuiSettingsContext([[KEY_DOWN, KEY_ENTER]], { keybindings: managerA });
  const harnessB = createTuiSettingsContext([[KEY_ENTER]], { keybindings: managerB });
  const uiA = injectedTuiUi(harnessA);
  const uiB = injectedTuiUi(harnessB);

  const [pickedA, pickedB] = await Promise.all([
    retainedSelect(uiA, { title: "UI A menu", rows: UI_A_ROWS }),
    retainedSelect(uiB, { title: "UI B menu", rows: UI_B_ROWS }),
  ]);

  // Each menu resolved through its OWN host's own component and key sequence.
  assert.equal(pickedA, "a2", "UI A's down-then-enter moved its own list");
  assert.equal(pickedB, "b1", "UI B's enter confirmed its own first row");
  assert.equal(harnessA.lists.length, 1);
  assert.equal(harnessB.lists.length, 1);
  assert.deepEqual(harnessA.lists[0]!.items.map((item) => item.value), UI_A_ROWS.map((row) => row.key));
  assert.deepEqual(harnessB.lists[0]!.items.map((item) => item.value), UI_B_ROWS.map((row) => row.key));
  assert.equal(harnessA.lists[0]!.selectedIndex, 1);
  assert.equal(harnessB.lists[0]!.selectedIndex, 0);
  // Neither menu fell through to the plain selector.
  assert.equal(harnessA.selectCalls.length, 0);
  assert.equal(harnessB.selectCalls.length, 0);
  // Each host received only its own UI's live keybindings manager.
  assert.deepEqual(harnessA.setKeybindingsCalls, [managerA]);
  assert.deepEqual(harnessB.setKeybindingsCalls, [managerB]);
});

test("each renderer call uses the host of its own UI, even on a shared custom slot", { timeout: TEST_TIMEOUT_MS }, async () => {
  const slot = createSharedSlot();
  const slotComponents = slot.components;
  const plainCalls: Array<{ title: string; options: string[] }> = [];
  const custom = slot.custom;
  const select = async (title: string, options: string[]): Promise<string | undefined> => {
    plainCalls.push({ title, options });
    return undefined;
  };

  const hostA = observedHost();
  const hostB = observedHost();
  const uiA: UiContext & RetainedUi = { mode: "tui", menuTuiHost: hostA.host, custom, select };
  const uiB: UiContext & RetainedUi = { mode: "tui", menuTuiHost: hostB.host, custom, select };

  const first = retainedSelect(uiA, { title: "UI A menu", rows: UI_A_ROWS });
  const firstComponent = await openedSlot(slotComponents, 0);
  firstComponent.handleInput(KEY_UP); // wraps to the last row of A's own list
  firstComponent.handleInput(KEY_ENTER);
  assert.equal(await first, "a3");

  const second = retainedSelect(uiB, { title: "UI B menu", rows: UI_B_ROWS });
  const secondComponent = await openedSlot(slotComponents, 1);
  secondComponent.handleInput(KEY_ENTER);
  assert.equal(await second, "b1");

  // A one-shot choice on the same UI reuses that UI's injected host.
  const choice = retainedChoice(uiB, "One-shot picker", ["Choice one", "Choice two"]);
  const thirdComponent = await openedSlot(slotComponents, 2);
  thirdComponent.handleInput(KEY_DOWN);
  thirdComponent.handleInput(KEY_ENTER);
  assert.equal(await choice, "Choice two");

  assert.deepEqual(hostA.lists.map((list) => list.items.map((item) => item.value)), [["a1", "a2", "a3"]]);
  assert.deepEqual(
    hostB.lists.map((list) => list.items.map((item) => item.value)),
    [["b1", "b2"], ["Choice one", "Choice two"]],
  );
  assert.equal(plainCalls.length, 0, "no plain selector was used");
});

// ---------------------------------------------------------------------------
// The no-injection defaults stay exactly as they were
// ---------------------------------------------------------------------------

test("an injected host wins over the process-global test override, which still works alone", { timeout: TEST_TIMEOUT_MS }, async () => {
  const globalHost = observedHost();
  const injected = observedHost();
  setMenuTuiHost(globalHost.host);
  try {
    const slot = createSharedSlot();
    const withHost: UiContext & RetainedUi = {
      mode: "tui",
      menuTuiHost: injected.host,
      custom: slot.custom,
      select: async () => undefined,
    };
    const preferred = retainedSelect(withHost, { title: "Injected", rows: UI_A_ROWS });
    (await openedSlot(slot.components, 0)).handleInput(KEY_ENTER);
    assert.equal(await preferred, "a1");
    assert.equal(injected.lists.length, 1, "the injected host rendered the menu");
    assert.equal(globalHost.lists.length, 0, "the global override was not consulted");

    // Without an injected host the global override still drives BOTH renderers
    // — the retained menu and the search-capable deny picker.
    const noHost: UiContext & RetainedUi = { mode: "tui", custom: slot.custom, select: async () => undefined };
    const menu = retainedSelect(noHost, { title: "Global", rows: UI_B_ROWS });
    const globalMenuComponent = await openedSlot(slot.components, 1);
    globalMenuComponent.handleInput(KEY_DOWN);
    globalMenuComponent.handleInput(KEY_ENTER);
    assert.equal(await menu, "b2");

    const picker = retainedDenySelect(noHost, { title: DENY_TITLE, rows: DENY_ROWS });
    const pickerComponent = await openedSlot(slot.components, 2);
    for (const key of typed("beta")) pickerComponent.handleInput(key);
    pickerComponent.handleInput(KEY_ENTER);
    assert.deepEqual(await picker, { key: `tool:${NARROWED_BY_BETA[0]}`, query: "beta" });
    // The override served the menu AND the picker's own query-filtered list.
    assert.equal(globalHost.lists.length > 1, true, "the override served the menu and the picker");
    assert.deepEqual(
      globalHost.lists.at(-1)!.items.map((item) => item.value),
      [...NARROWED_BY_BETA.map((name) => `tool:${name}`), "back"],
    );
  } finally {
    setMenuTuiHost(undefined);
  }
});

test("resolution without an injected host is exactly the default resolution", async () => {
  const injected = createFakeMenuTuiHost();
  assert.equal(await resolveMenuTuiHostForRenderers({ menuTuiHost: injected }), injected);
  // No host member, an empty UI, and no argument at all all resolve the same
  // way they did before the seam existed (override, then the Pi peer load).
  const fallback = await resolveMenuTuiHostForRenderers();
  assert.equal(await resolveMenuTuiHostForRenderers({}), fallback);
  assert.equal(await resolveMenuTuiHostForRenderers({ mode: "tui" } as RetainedUi), fallback);
});

// ---------------------------------------------------------------------------
// The injected deny picker keeps the live search UX
// ---------------------------------------------------------------------------

test("an injected host gives the deny picker its native search field and live filtering", { timeout: TEST_TIMEOUT_MS }, async () => {
  const observed = observedHost();
  const { ui, slots, plainCalls } = hostedUi(observed.host);

  const picker = retainedDenySelect(ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const component = await openedSlot(slots, 0);
  const initial = component.render(80);
  assert.equal(queryLineOf(initial)?.trim(), ">", "the native query field renders above the list");
  assert.deepEqual(toolNamesOf(initial), DENY_NAMES);

  for (const key of typed("beta")) component.handleInput(key);
  const narrowed = component.render(80);
  assert.equal(queryLineOf(narrowed)?.trim(), "> beta");
  assert.deepEqual(toolNamesOf(narrowed), NARROWED_BY_BETA);
  assert.equal(highlightedOf(narrowed), "mcp__beta__read_0  ✗ allowed");
  assert.ok(narrowed.map((line) => stripAnsi(line)).some((line) => line.trim() === "Back"), "Back stays reachable");

  // Navigation belongs to the result list, activation toggles the highlighted
  // match, and the picker returns the query the user left behind.
  component.handleInput(KEY_DOWN);
  assert.equal(highlightedOf(component.render(80)), "mcp__beta__read_1  ✗ allowed");
  component.handleInput(KEY_ENTER);
  assert.deepEqual(await picker, { key: "tool:mcp__beta__read_1", query: "beta" });
  assert.equal(plainCalls.length, 0, "the injected host served the picker");

  // A re-shown presentation restores the query, the narrowed set, and the
  // highlighted row through the same injected host.
  const again = retainedDenySelect(ui, {
    title: DENY_TITLE,
    rows: DENY_ROWS,
    query: "beta",
    initialKey: "tool:mcp__beta__write_0",
  });
  const reshownComponent = await openedSlot(slots, 1);
  const reshown = reshownComponent.render(80);
  assert.equal(queryLineOf(reshown)?.trim(), "> beta");
  assert.equal(highlightedOf(reshown), "mcp__beta__write_0  ✗ allowed");
  reshownComponent.handleInput(KEY_ESCAPE);
  assert.deepEqual(await again, { key: undefined, query: "beta" });
});

test("a zero-match query on an injected host shows the truthful no-match state", { timeout: TEST_TIMEOUT_MS }, async () => {
  const observed = observedHost();
  const { ui, slots } = hostedUi(observed.host);
  const picker = retainedDenySelect(ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const component = await openedSlot(slots, 0);
  for (const key of typed("zzz")) component.handleInput(key);
  const frame = component.render(80).map((line) => stripAnsi(line));
  assert.ok(frame.some((line) => line.includes(NO_MATCHING_TOOLS_MESSAGE.trim())), frame.join("\n"));
  assert.equal(toolNamesOf(frame).length, 0, "no tool row is shown");
  assert.equal(highlightedOf(frame), "Back", "only Back is offered, so Enter cannot toggle a hidden tool");
  component.handleInput(KEY_ESCAPE);
  assert.deepEqual(await picker, { key: undefined, query: "zzz" });
});

// ---------------------------------------------------------------------------
// Save, held-action fence, and native keybindings across nesting
// ---------------------------------------------------------------------------

test("Ctrl+S in the injected nested picker latches the shared save and unwinds the parent", { timeout: TEST_TIMEOUT_MS }, async () => {
  const control = saveControl();
  const parentHost = saveCapableHost();
  const nestedHost = saveCapableHost();
  const parent = hostedUi(parentHost.host, { saveControl: control });
  const nested = hostedUi(nestedHost.host, { saveControl: control });

  const parentMenu = retainedSelect(parent.ui, {
    title: "Tools",
    rows: [{ key: "topLevel", label: "Top-level tools" }, { key: "back", label: "Back" }],
  });
  const parentComponent = await openedSlot(parent.slots, 0);
  assert.ok(parentComponent.render(80).some((line) => line.includes("Ctrl+S save")), "the parent offers the save chord");
  parentComponent.handleInput(KEY_ENTER); // open the nested picker
  assert.equal(await parentMenu, "topLevel");

  const picker = retainedDenySelect(nested.ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const pickerComponent = await openedSlot(nested.slots, 0);
  assert.ok(pickerComponent.render(80).some((line) => line.includes("Ctrl+S save")), "the nested picker offers the save chord");
  for (const key of typed("beta")) pickerComponent.handleInput(key);
  pickerComponent.handleInput(CTRL_S);
  assert.deepEqual(await picker, { key: undefined, query: "beta" });
  assert.equal(control.saveRequested, true, "the root-owned latch was set from the nested picker");

  // The latched request unwinds the parent loop through its normal
  // cancellation return: no new menu, no plain selector, no second picker.
  assert.equal(await retainedSelect(parent.ui, { title: "Tools", rows: [{ key: "topLevel", label: "Top-level tools" }] }), undefined);
  assert.equal(parent.slots.length, 1);
  assert.equal(nested.slots.length, 1);
  assert.equal(parent.plainCalls.length, 0);
  assert.equal(nested.plainCalls.length, 0);
});

test("a held Escape from the injected nested picker cannot also close its parent", { timeout: TEST_TIMEOUT_MS }, async () => {
  const control = saveControl();
  const parent = hostedUi(saveCapableHost().host, { saveControl: control });
  const nested = hostedUi(saveCapableHost().host, { saveControl: control });

  const parentMenu = retainedSelect(parent.ui, {
    title: "Tools",
    rows: [{ key: "topLevel", label: "Top-level tools" }, { key: "back", label: "Back" }],
  });
  (await openedSlot(parent.slots, 0)).handleInput(KEY_ENTER);
  assert.equal(await parentMenu, "topLevel");

  const picker = retainedDenySelect(nested.ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const pickerComponent = await openedSlot(nested.slots, 0);
  pickerComponent.handleInput(KEY_ESCAPE); // leaves the picker and claims the cancel
  assert.deepEqual(await picker, { key: undefined, query: "" });
  assert.equal(control.saveRequested, false, "Escape applies nothing");

  // The parent re-shows. The held repeat and the release of that same Escape
  // are consumed by the transaction's shared fence, so the parent survives.
  const parentAgain = retainedSelect(parent.ui, {
    title: "Tools",
    rows: [{ key: "topLevel", label: "Top-level tools" }, { key: "back", label: "Back" }],
  });
  const parentAgainComponent = await openedSlot(parent.slots, 1);
  parentAgainComponent.handleInput(REPEAT_ESCAPE);
  parentAgainComponent.handleInput(RELEASE_ESCAPE);
  assert.equal(await isPending(parentAgain), true, "the held Escape did not close the parent menu");

  // A fresh press is never stuck: it closes the parent normally.
  parentAgainComponent.handleInput(KEY_ESCAPE);
  assert.equal(await parentAgain, undefined);
});

test("the injected picker resolves tui.select.* through the host's live keybindings", { timeout: TEST_TIMEOUT_MS }, async () => {
  const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "ctrl+p",
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+o",
    "tui.select.cancel": "ctrl+g",
  });
  const observed = observedHost();
  const { ui, slots } = hostedUi(observed.host, { keybindings: manager });

  const picker = retainedDenySelect(ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const component = await openedSlot(slots, 0);
  // The injected host's setKeybindings got the live manager, so the native
  // Input's own editing keys resolve through the user's keybindings.json too.
  assert.deepEqual(observed.setKeybindingsCalls, [manager]);

  for (const key of typed("beta")) component.handleInput(key);
  const visible = filterDenyPickerRows(DENY_ROWS, "beta").visible;
  // The default down arrow is inert under the remap; the remapped chord moves.
  component.handleInput(KEY_DOWN);
  assert.equal(highlightedOf(component.render(80)), visible[0]!.label);
  component.handleInput("\x0e"); // ctrl+n
  assert.equal(highlightedOf(component.render(80)), visible[1]!.label);
  // The default Escape is inert under the remap: the picker stays open.
  component.handleInput(KEY_ESCAPE);
  assert.equal(await isPending(picker), true, "the default cancel chord is inert under the remap");
  component.handleInput("\x10"); // ctrl+p back to the first match
  component.handleInput("\x10"); // wraps to the always-visible Back row
  component.handleInput("\x0f"); // ctrl+o confirms Back
  assert.deepEqual(await picker, { key: "back", query: "beta" });
});

test("a bracketed paste in the injected picker stays opaque query text", { timeout: TEST_TIMEOUT_MS }, async () => {
  const control = saveControl();
  const observed = saveCapableHost();
  const { ui, slots } = hostedUi(observed.host, { saveControl: control });

  // The body carries Enter, Escape, Ctrl+S, and Ctrl+C bytes: none of them may
  // toggle, save, or leave the picker, and the pasted text is exactly what the
  // native Input keeps.
  const paste = `${PASTE_START}beta\r\x1b${CTRL_S}${CTRL_C}${PASTE_END}`;
  const reference = new PinnedInput();
  reference.handleInput(paste);

  const picker = retainedDenySelect(ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const component = await openedSlot(slots, 0);
  component.handleInput(paste);
  assert.equal(control.saveRequested, false, "a pasted Ctrl+S byte never saves");
  assert.equal(await isPending(picker), true, "a pasted Enter or Escape never leaves the picker");
  assert.equal(queryLineOf(component.render(80))?.trim(), `> ${reference.getValue()}`);
  component.handleInput(KEY_ESCAPE);
  const settled = await picker;
  assert.equal(settled.key, undefined);
  // The pasted text is exactly what the native field kept: no confirm byte,
  // and the save latch stayed clear (asserted above).
  assert.equal(settled.query, reference.getValue());
  assert.ok(!settled.query.includes("\r"), "a pasted Enter is never a confirm");
  assert.equal(slots.length, 1, "the paste stayed in the one picker");
});

// ---------------------------------------------------------------------------
// Guards and real components
// ---------------------------------------------------------------------------

test("an injected host never fakes the RPC path", { timeout: TEST_TIMEOUT_MS }, async () => {
  const observed = saveCapableHost();
  const plainCalls: Array<{ title: string; options: string[] }> = [];
  let customCalls = 0;
  const rpcUi: UiContext & RetainedUi = {
    mode: "rpc",
    menuTuiHost: observed.host,
    custom: () => {
      customCalls += 1;
      return Promise.resolve(undefined);
    },
    async select(title: string, options: string[]): Promise<string | undefined> {
      plainCalls.push({ title, options });
      return title === "UI A menu" ? "Alpha two" : "Back";
    },
  };

  assert.equal(await retainedSelect(rpcUi, { title: "UI A menu", rows: UI_A_ROWS }), "a2");
  const picker = await retainedDenySelect(rpcUi, { title: DENY_TITLE, rows: DENY_ROWS, query: "beta" });
  assert.deepEqual(picker, { key: "back", query: "beta" });
  assert.equal(customCalls, 0, "an RPC host is never handed a custom TUI slot");
  assert.equal(observed.lists.length, 0, "the injected host never renders for RPC");
  assert.deepEqual(
    plainCalls.map((call) => call.options),
    [UI_A_ROWS.map((row) => row.label), DENY_ROWS.map((row) => row.label)],
    "the plain fallback keeps the full, unfiltered labels in the original order",
  );

  // A TUI-mode UI without a custom slot also keeps the plain fallback even
  // with an injected host.
  const noCustom: UiContext & RetainedUi = {
    mode: "tui",
    menuTuiHost: observed.host,
    select: async () => "Bravo two",
  };
  assert.equal(await retainedSelect(noCustom, { title: "UI B menu", rows: UI_B_ROWS }), "b2");
  assert.equal(observed.lists.length, 0);
});

test("an injected host built from the pinned pi-tui package drives the real components", { timeout: TEST_TIMEOUT_MS }, async () => {
  const host = pinnedRealHost();
  const { ui, slots, plainCalls } = hostedUi(host);

  const menu = retainedSelect(ui, { title: "Pick", rows: UI_A_ROWS, initialKey: "a2" });
  const menuComponent = await openedSlot(slots, 0);
  const menuFrame = menuComponent.render(80).join("\n");
  assert.ok(/→\s*Alpha two/.test(menuFrame), `the real SelectList preselects the retained row:\n${menuFrame}`);
  menuComponent.handleInput(KEY_DOWN);
  menuComponent.handleInput(KEY_ENTER);
  assert.equal(await menu, "a3");

  const picker = retainedDenySelect(ui, { title: DENY_TITLE, rows: DENY_ROWS });
  const pickerComponent = await openedSlot(slots, 1);
  for (const key of typed("beta")) pickerComponent.handleInput(key);
  const narrowed = pickerComponent.render(80);
  assert.equal(queryLineOf(narrowed)?.trim(), "> beta");
  assert.deepEqual(toolNamesOf(narrowed), NARROWED_BY_BETA);
  pickerComponent.handleInput(KEY_ENTER);
  assert.deepEqual(await picker, { key: `tool:${NARROWED_BY_BETA[0]}`, query: "beta" });
  assert.equal(plainCalls.length, 0, "the real host served both renderers");
});
