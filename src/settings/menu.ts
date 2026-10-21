/**
 * Retained-selection selector for re-shown settings menus (issue #140).
 *
 * The plain host selector (`ctx.ui.select`) always opens at the first row and
 * exposes no initial-row option (verified in pi 0.85.1: ExtensionUIDialogOptions
 * carries only signal/timeout, and ExtensionSelectorComponent hardcodes
 * selectedIndex = 0). Every settings menu that re-shows after a staged change
 * therefore dropped the user's position on each redraw.
 *
 * This module is the one shared mechanism for all of those loops:
 *
 * - Rows carry a stable logical key (section names, permission fields,
 *   resource/route/reviewer ids) that never changes with displayed state
 *   (On/Off flips, counts, alignment). Each caller stores the last chosen key
 *   locally per loop and passes it back as `initialKey` on the next show.
 * - In an interactive Pi TUI (`mode === "tui"` plus a working `ui.custom`) the
 *   menu renders the host's own pi-tui `SelectList` inside a `Container` with
 *   title, borders, and key hints — tui.md Pattern 1 — and preselects through
 *   the public `SelectList.setSelectedIndex()`, the same mechanism pi's own
 *   settings submenu and theme selector use. Navigation, confirm, and cancel
 *   resolve through the host's live `tui.select.*` keybindings (built-in
 *   defaults plus the user's keybindings.json), so keyboard semantics match
 *   the native selector.
 * - Everywhere else (RPC hosts, print mode, test mocks, a host without the
 *   pi-tui alias) it falls back to the plain `ctx.ui.select` with the same
 *   labels in the same order and maps the returned label back to a key by
 *   first match — byte-identical to the previous label-based dispatch. RPC
 *   hosts keep today's behavior; `custom()` is never required of them.
 *
 * The pi packages are host-provided peers, never hard dependencies: they are
 * loaded with the shared two-step peer loader (src/host-peer-loader.ts, issue
 * #185 — soft require first, then host-relative resolution from the running
 * Pi install, with the agent package's import-only exports resolved through
 * its own package.json main field) and degrade to the plain selector on any
 * failure. pi >= 0.86 runs its bundled chunk with pi-tui inlined, so that
 * standalone module's global keybinding state is a fresh default-only copy
 * rather than the app's live manager: user tui.select.* overrides would not
 * reach an extension-built SelectList on their own. The adapter therefore
 * points the loaded module at the live KeybindingsManager the host injects
 * into every custom component (the public setKeybindings() export), so
 * navigation, confirm, and cancel — and the agent package's keyHint() hint
 * text — resolve exactly as they do in the app. No installed path is
 * hard-coded: the entry is discovered from the running process itself, and
 * anything that cannot be resolved (outside Pi, SEA/binary hosts) degrades to
 * the plain selector.
 *
 * A key that no longer exists in the current rows keeps the default first
 * row: safe, with no invented reorder. Selection position is UI-only state;
 * it is never persisted as a product setting.
 */

import { loadHostPeerModule } from "../host-peer-loader";
import { isRecord } from "../record-guard";
import { isKeyRelease, isKeyRepeat, matchesKey } from "pi-session-host-tui";

/** One selectable row: a stable logical key plus its rendered label. */
export interface RetainedRow {
  /** Stable identity of the row; must not change with displayed state. */
  key: string;
  /** Label shown to the user; may change between redraws. */
  label: string;
}

export interface RetainedSelectInput {
  title: string;
  rows: readonly RetainedRow[];
  /** Row to highlight when re-shown; ignored when absent from `rows`. */
  initialKey?: string;
  /** Caller-owned meaning of the native cancel key (root Escape applies). */
  cancelHint?: string;
}

/** Per-root-transaction save signal shared by settings menus and hotkeys. */
export interface SettingsSaveControl {
  saveRequested: boolean;
  suspended: number;
  /**
   * The held-action fence shared by every nested settings menu of ONE
   * transaction (issue #463).
   *
   * A held key's repeat/release must never replay a host action. The fence
   * lives on the root-owned control — not on one menu's local state — so the
   * claim survives the transition from a nested menu back to its parent: a
   * held Escape that closed the deny picker cannot also close the Tools menu
   * and then apply the staged draft at the root.
   *
   * The entries are opaque matchers, not key data, so the fence can never
   * leak what was pressed.
   */
  actionFence?: MenuActionFence;
}

/**
 * The held-action fence of one settings transaction.
 *
 * A claim records the matcher of an action that has just been performed. A
 * later event that matches the claim is consumed: a repeat is swallowed
 * outright, and a release ends the claim. A FRESH press of the same action
 * ends the claim and is handled normally, so the user is never stuck.
 */
export interface MenuActionFence {
  /** Record that an action was just performed. */
  claim(matches: (data: string) => boolean): void;
  /**
   * Consume a held-key event that replays a claimed action.
   * Returns true when the event was consumed by the fence.
   */
  consume(data: string): boolean;
  /** Drop every claim (used when the whole transaction ends). */
  clear(): void;
}

/**
 * The maximum number of live claims. A claim lives only until the matching
 * key is released (or a fresh press supersedes it), so this bound is a
 * safety net against an unbounded claim list, never a behavior limit.
 */
const MAX_ACTION_FENCE_CLAIMS = 8;

/**
 * Create the held-action fence for one settings transaction.
 *
 * The fence is the same mechanism the session-host sidebar uses for its
 * held-key claims: a claim is consumed by a repeat of the claimed action
 * and ended by its release, while a fresh press of the same action ends the
 * claim and proceeds normally.
 */
export function createMenuActionFence(): MenuActionFence {
  const claims: Array<(data: string) => boolean> = [];
  return {
    claim(matches: (data: string) => boolean): void {
      claims.push(matches);
      if (claims.length > MAX_ACTION_FENCE_CLAIMS) claims.splice(0, claims.length - MAX_ACTION_FENCE_CLAIMS);
    },
    consume(data: string): boolean {
      let consumed = false;
      for (const matches of [...claims]) {
        let matched = false;
        try {
          matched = matches(data);
        } catch {
          // A malformed event is not a match.
        }
        if (!matched) continue;
        const index = claims.indexOf(matches);
        if (isKeyRelease(data)) {
          // The key was released: the hold is over, so the claim ends.
          if (index >= 0) claims.splice(index, 1);
          consumed = true;
        } else if (isKeyRepeat(data)) {
          // A held-key repeat never replays the action.
          consumed = true;
        } else if (index >= 0) {
          // A fresh press of the same action supersedes the claim and is
          // handled normally by the caller.
          claims.splice(index, 1);
        }
      }
      return consumed;
    },
    clear(): void {
      claims.length = 0;
    },
  };
}

/** The theme passed to custom component factories (the host Theme). */
export interface MenuTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type MenuCustomFactory = (
  tui: { requestRender?(force?: boolean): void },
  theme: MenuTheme,
  keybindings: unknown,
  done: (result: string | undefined) => void,
) => unknown;

/** The UI surface retainedSelect needs (host ctx.ui or a structural mock). */
export interface RetainedUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  /** Host custom TUI component (Pi hosts only); guarded by `mode === "tui"`. */
  custom?(factory: MenuCustomFactory): Promise<string | undefined>;
  /** Host run mode ("tui" | "rpc" | ...); absent outside Pi. */
  mode?: string;
  /** Optional root-owned Ctrl+S signal; never copied into settings drafts. */
  saveControl?: SettingsSaveControl;
}

/** pi-tui SelectItem shape. */
export interface MenuSelectItem {
  value: string;
  label: string;
  description?: string;
}

/** pi-tui SelectListTheme shape. */
export interface MenuSelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

/** The pi-tui SelectList surface this adapter drives. */
export interface MenuSelectList {
  setSelectedIndex(index: number): void;
  onSelect?: (item: MenuSelectItem) => void;
  onCancel?: () => void;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

/** The pi-tui Input surface the search-capable picker drives (issue #463). */
export interface MenuInput {
  getValue(): string;
  setValue(value: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
  focused: boolean;
}

/** The pi-tui Container surface this adapter builds into. */
export interface MenuContainer {
  addChild(component: unknown): void;
  render(width: number): string[];
  invalidate(): void;
}

/**
 * The host TUI surface the adapter needs. Injectable through
 * {@link setMenuTuiHost} for tests; loaded from the running Pi's own modules
 * (host alias first, then host-relative resolution) otherwise.
 */
export interface MenuTuiHost {
  SelectList: new (items: MenuSelectItem[], maxVisible: number, theme: MenuSelectListTheme) => MenuSelectList;
  Container: new () => MenuContainer;
  Text: new (text: string, x?: number, y?: number) => unknown;
  /**
   * The pi-tui single-line Input the search-capable deny picker uses
   * (issue #463). Optional: a host peer without it degrades to the plain
   * selector, exactly like a peer without SelectList.
   */
  Input?: new () => MenuInput;
  /**
   * The loaded pi-tui module's public setKeybindings(); points that module's
   * global keybinding state at the host's live manager so embedded components
   * resolve tui.select.* through the app's user keybindings.json.
   */
  setKeybindings?: (keybindings: unknown) => void;
  /** Public pi-tui matchesKey(Key.ctrl("s")) matcher, when available. */
  matchesCtrlS?: (data: string) => boolean;
  /** Host DynamicBorder; an explicit color function is always passed. */
  DynamicBorder?: new (color?: (segment: string) => string) => unknown;
  /** Host getSelectListTheme(); used when loadable and render-safe. */
  getSelectListTheme?: () => MenuSelectListTheme | undefined;
  rawKeyHint?: (keys: string, description: string) => string;
  keyHint?: (keybinding: string, description: string) => string;
}


/** Host peer package names: pi-tui plus the running agent package. */
const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";
const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

let hostOverride: MenuTuiHost | undefined;
let hostLoadPromise: Promise<MenuTuiHost | undefined> | undefined;
let hostEntryProvider: (() => string | undefined) | undefined;
/** Test seam: inject a fake TUI host, or clear the override with undefined. */
export function setMenuTuiHost(host: MenuTuiHost | undefined): void {
  hostOverride = host;
  hostLoadPromise = undefined;
}

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation.
 */
export function setMenuTuiHostEntryProvider(provider: (() => string | undefined) | undefined): void {
  hostEntryProvider = provider;
  hostLoadPromise = undefined;
}

function resolveMenuTuiHost(): Promise<MenuTuiHost | undefined> {
  if (hostOverride !== undefined) return Promise.resolve(hostOverride);
  hostLoadPromise ??= loadMenuTuiHost();
  return hostLoadPromise;
}

/**
 * The shared host resolution for the settings renderers (issue #463).
 *
 * The deny picker's search-capable renderer resolves the SAME host through
 * this seam, so an injected fake or the running Pi's own modules are used
 * identically by every settings menu, and the load failure mode stays the
 * same: a rejecting or unloadable peer resolves to undefined and the caller
 * degrades to the plain selector.
 */
export function resolveMenuTuiHostForRenderers(): Promise<MenuTuiHost | undefined> {
  return resolveMenuTuiHost().catch(() => undefined);
}

/**
 * True only for an injected live KeybindingsManager (the host's own manager
 * with the user's keybindings.json). The search-capable renderer uses it to
 * resolve tui.select.* through the same live manager the plain menus use.
 */
export function isLiveMenuKeybindingsManager(
  value: unknown,
): value is { matches(data: string, keybinding: string): boolean } {
  return isLiveKeybindingsManager(value);
}

async function loadMenuTuiHost(): Promise<MenuTuiHost | undefined> {
  const tui = await loadHostPeerModule(PI_TUI_PACKAGE_NAME, { entryProvider: hostEntryProvider, packageMainFallback: true });
  if (!isSelectListProvider(tui)) {
    // Outside Pi (unit tests, tooling) or an unloadable peer: the menu
    // simply degrades to the plain selector.
    return undefined;
  }
  const host: MenuTuiHost = {
    SelectList: tui.SelectList as MenuTuiHost["SelectList"],
    Container: tui.Container as MenuTuiHost["Container"],
    Text: tui.Text as MenuTuiHost["Text"],
  };
  // The public single-line Input backs the deny picker's search field
  // (issue #463). It is optional: a peer without it keeps the plain selector.
  if (typeof tui.Input === "function") {
    host.Input = tui.Input as MenuTuiHost["Input"];
  }
  if (typeof tui.setKeybindings === "function") {
    host.setKeybindings = tui.setKeybindings as MenuTuiHost["setKeybindings"];
  }
  const matchesKey = tui.matchesKey;
  const key = tui.Key as { ctrl?: (name: string) => unknown } | undefined;
  if (typeof matchesKey === "function" && typeof key?.ctrl === "function") {
    try {
      const ctrlS = key.ctrl("s");
      host.matchesCtrlS = (data) => Boolean(matchesKey(data, ctrlS));
    } catch {
      // A partial peer can still render menus, just without the save chord.
    }
  }
  const agent = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, { entryProvider: hostEntryProvider, packageMainFallback: true });
  if (agent) {
    if (typeof agent.DynamicBorder === "function") host.DynamicBorder = agent.DynamicBorder as MenuTuiHost["DynamicBorder"];
    if (typeof agent.getSelectListTheme === "function") host.getSelectListTheme = agent.getSelectListTheme as MenuTuiHost["getSelectListTheme"];
    if (typeof agent.rawKeyHint === "function") host.rawKeyHint = agent.rawKeyHint as MenuTuiHost["rawKeyHint"];
    if (typeof agent.keyHint === "function") host.keyHint = agent.keyHint as MenuTuiHost["keyHint"];
  }
  return host;
}

/**
 * True when the injected keybindings argument is a live KeybindingsManager.
 */
function isLiveKeybindingsManager(
  value: unknown,
): value is { matches(data: string, keybinding: string): boolean } {
  return isRecord(value) && typeof (value as Record<string, unknown>).matches === "function";
}

/**
 * The public pi-tui action ids the settings menus resolve through the host's
 * live keybindings.
 */
export type MenuActionId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.confirm"
  | "tui.select.cancel";

/**
 * The native default chords for the settings menus' actions, used when the
 * host injects no live keybindings manager (an RPC host, a test mock, or a
 * host that injects none). These are Pi's own published defaults.
 */
const MENU_ACTION_DEFAULT_KEYS: Readonly<Record<MenuActionId, readonly string[]>> = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
};

/**
 * Resolves the settings menus' action chords through the host's LIVE
 * keybindings manager, with Pi's native defaults as the fallback.
 *
 * The host injects its live KeybindingsManager (built-in defaults plus the
 * user's keybindings.json) into every custom component, so a user remap of
 * `tui.select.*` must reach the menus. When a live manager is present it is
 * AUTHORITATIVE: the native defaults are consulted only when the host
 * injects no manager at all. A user who rebinds `tui.select.cancel` — or
 * disables it with an empty list — therefore gets exactly that behavior,
 * and the menus never silently keep the old chord.
 *
 * The returned matcher is safe to call with any raw key data: a manager that
 * throws (an uninitialized theme or a partial peer) falls back to the
 * defaults instead of eating the key.
 */
export function resolveMenuActionMatcher(
  keybindings: unknown,
  action: MenuActionId,
): (data: string) => boolean {
  const defaults = MENU_ACTION_DEFAULT_KEYS[action] ?? [];
  if (isLiveKeybindingsManager(keybindings)) {
    return (data: string): boolean => {
      try {
        return keybindings.matches(data, action);
      } catch {
        // A failing manager must not eat the key: use the native default.
        return defaults.some((key) => matchesKey(data, key as Parameters<typeof matchesKey>[1]));
      }
    };
  }
  return (data: string): boolean => defaults.some((key) => matchesKey(data, key as Parameters<typeof matchesKey>[1]));
}

/** The pi-tui exports the adapter actually drives. */
function isSelectListProvider(
  mod: Record<string, unknown> | undefined,
): mod is Record<string, unknown> & {
  SelectList: MenuTuiHost["SelectList"];
  Container: MenuTuiHost["Container"];
  Text: MenuTuiHost["Text"];
  Input?: MenuTuiHost["Input"];
} {
  return (
    mod !== undefined &&
    typeof mod.SelectList === "function" &&
    typeof mod.Container === "function" &&
    typeof mod.Text === "function"
  );
}

/**
 * Shows one retained-selection menu and resolves with the chosen row's key.
 *
 * Resolves `undefined` when the user cancels (Esc/Back, or an empty plain
 * selection). Through the plain fallback only, a host value that matches no
 * row is returned as-is so each menu's existing fall-through handling behaves
 * exactly as it did with label-based dispatch.
 */
export async function retainedSelect(ui: RetainedUi, input: RetainedSelectInput): Promise<string | undefined> {
  // A latched request unwinds one selector at a time through its normal
  // cancellation return path, preserving each caller's local staged fields.
  if (saveIsRequested(ui.saveControl)) return undefined;
  if (ui.mode === "tui" && typeof ui.custom === "function") {
    // Resolution must stay fail-safe at the call site: any future loader
    // rejection degrades to the plain selector instead of breaking the menu.
    const host = await resolveMenuTuiHost().catch(() => undefined);
    if (host !== undefined) {
      try {
        return await customSelect(ui, host, input);
      } catch {
        // A failing custom surface must not lose the menu: degrade to the plain selector.
      }
    }
  }
  return plainSelect(ui, input);
}

/**
 * Choice-only host selectors use the same retainedSelect seam, gaining the
 * custom-TUI save signal without changing labels, order, cancellation, or the
 * plain/RPC fallback. Typed fields deliberately continue to use their native
 * editor seams instead.
 */
export async function retainedChoice(
  ui: RetainedUi,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  return retainedSelect(ui, {
    title,
    rows: options.map((label) => ({ key: label, label })),
  });
}

/** Renders the menu with the host SelectList and resolves on Enter/Esc. */
function customSelect(ui: RetainedUi, host: MenuTuiHost, input: RetainedSelectInput): Promise<string | undefined> {
  const custom = ui.custom!;
  return custom((tui, theme, keybindings, done) => {
    // The host injects its live KeybindingsManager (built-in defaults plus
    // the user's keybindings.json). On pi >= 0.86 the SelectList comes from
    // the standalone pi-tui module, whose global keybinding state is a fresh
    // default-only copy; point it at the injected manager through the public
    // setKeybindings() so tui.select.* resolves exactly as in the app (and
    // the agent package's keyHint() text matches). No-op when the host
    // aliases this module to its own (jiti path) or injects no manager.
    if (typeof host.setKeybindings === "function" && isLiveKeybindingsManager(keybindings)) {
      try {
        host.setKeybindings(keybindings);
      } catch {
        // A failing sync must not break the menu: keep component defaults.
      }
    }
    // The action chords are resolved through the host's LIVE manager, so a
    // user's remap of tui.select.* reaches the menu, with Pi's native
    // defaults as the fallback (issue #463).
    const confirmMatch = resolveMenuActionMatcher(keybindings, "tui.select.confirm");
    const cancelMatch = resolveMenuActionMatcher(keybindings, "tui.select.cancel");
    const container = new host.Container();
    if (host.DynamicBorder) container.addChild(new host.DynamicBorder(borderColor(theme)));
    container.addChild(new host.Text(titleText(theme, input.title), 1, 0));

    const items: MenuSelectItem[] = input.rows.map((row) => ({ value: row.key, label: row.label }));
    const selectList = new host.SelectList(items, Math.min(items.length, 10), selectListTheme(host, theme));
    if (input.initialKey !== undefined) {
      const index = items.findIndex((item) => item.value === input.initialKey);
      // A key no longer present in the rows keeps the default first row.
      if (index >= 0) selectList.setSelectedIndex(index);
    }
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    const saveHintAvailable = ui.saveControl !== undefined
      && ui.saveControl.suspended === 0
      && host.matchesCtrlS !== undefined;
    container.addChild(new host.Text(hintText(host, saveHintAvailable, input.cancelHint), 1, 0));
    if (host.DynamicBorder) container.addChild(new host.DynamicBorder(borderColor(theme)));

    return {
      render: (width: number): string[] => container.render(width),
      invalidate: (): void => container.invalidate(),
      handleInput: (data: string): void => {
        // A held-key event that replays an action this transaction already
        // performed is consumed by the shared fence BEFORE any action runs,
        // so a held Escape cannot close this menu, then its parent, and then
        // apply the staged draft at the root (issue #463).
        if (consumeMenuActionFence(ui.saveControl, data)) return;
        // A held key's release never replays an action.
        if (isKeyRelease(data)) return;
        const saveChord = ui.saveControl !== undefined
          && ui.saveControl.suspended === 0
          && matchesCtrlS(host, data);
        // A held key's repeat never replays a save, a confirm, or a cancel;
        // the SelectList's own navigation repeats stay ordinary navigation.
        if (isKeyRepeat(data) && (saveChord || confirmMatch(data) || cancelMatch(data))) return;
        if (saveChord) {
          ui.saveControl!.saveRequested = true;
          claimMenuAction(ui.saveControl, (event) => menuMatchesCtrlS(host, event));
          done(undefined);
          return;
        }
        // A confirm or a cancel claims the action so its held repeat and
        // release cannot replay it in the parent menu.
        if (confirmMatch(data)) {
          claimMenuAction(ui.saveControl, confirmMatch);
        } else if (cancelMatch(data)) {
          claimMenuAction(ui.saveControl, cancelMatch);
        }
        selectList.handleInput(data);
        tui.requestRender?.();
      },
    };
  });
}

/** Plain-selector fallback: same labels, same order, first-match mapping. */
async function plainSelect(ui: RetainedUi, input: RetainedSelectInput): Promise<string | undefined> {
  const labels = input.rows.map((row) => row.label);
  const selected = await ui.select(input.title, labels);
  if (selected === undefined) return undefined;
  // First-match label→key mapping preserves the previous exact-label dispatch,
  // including duplicate labels. A value matching no row is returned as-is so
  // each menu's existing fall-through handling stays byte-identical.
  const index = labels.indexOf(selected);
  return index >= 0 ? input.rows[index]!.key : selected;
}

function borderColor(theme: MenuTheme): (segment: string) => string {
  return (segment: string): string => {
    try {
      // An explicit color function is required for extension use: the host's
      // default may reference a theme global that jiti-loaded extensions do
      // not share (verified in pi 0.85.1 DynamicBorder docs).
      return theme.fg("border", segment);
    } catch {
      return segment;
    }
  };
}

/**
 * Shared render helpers for the settings renderers (issue #463). The
 * search-capable deny picker reuses these so its border, title, and list
 * theme are byte-identical to the plain retained menus.
 */
export const menuRenderTheme = {
  borderColor,
  titleText,
  selectListTheme,
};

function titleText(theme: MenuTheme, title: string): string {
  try {
    return theme.fg("accent", theme.bold(title));
  } catch {
    return title;
  }
}

function selectListTheme(host: MenuTuiHost, theme: MenuTheme): MenuSelectListTheme {
  if (typeof host.getSelectListTheme === "function") {
    try {
      const styled = host.getSelectListTheme();
      if (styled && typeof styled.selectedPrefix === "function" && typeof styled.selectedText === "function") {
        return styled;
      }
    } catch {
      // The host theme may be uninitialized outside an interactive session.
    }
  }
  const fg = (color: string): ((text: string) => string) => (text: string): string => {
    try {
      return theme.fg(color, text);
    } catch {
      return text;
    }
  };
  return {
    selectedPrefix: fg("accent"),
    selectedText: fg("accent"),
    description: fg("muted"),
    scrollInfo: fg("dim"),
    noMatch: fg("warning"),
  };
}

function hintText(host: MenuTuiHost, saveHintAvailable: boolean, cancelHint = "cancel"): string {
  let hints: string;
  try {
    if (typeof host.rawKeyHint === "function" && typeof host.keyHint === "function") {
      // The host's live keybinding text, so user keybindings.json overrides
      // are honored instead of hard-coded keys.
      hints = `${host.rawKeyHint("↑↓", "navigate")}  ${host.keyHint("tui.select.confirm", "select")}  ${host.keyHint("tui.select.cancel", cancelHint)}`;
    } else {
      hints = `↑↓ navigate · enter select · esc ${cancelHint}`;
    }
  } catch {
    hints = `↑↓ navigate · enter select · esc ${cancelHint}`;
  }
  return saveHintAvailable ? `${hints} · Ctrl+S save` : hints;
}

function saveIsRequested(control: SettingsSaveControl | undefined): boolean {
  return control?.saveRequested === true && control.suspended === 0;
}

/** True when a latched Ctrl+S save request must unwind this selector. */
export function menuSaveIsRequested(control: SettingsSaveControl | undefined): boolean {
  return saveIsRequested(control);
}

/** True when the host's Ctrl+S matcher recognizes the raw key data. */
export function menuMatchesCtrlS(host: MenuTuiHost, data: string): boolean {
  return matchesCtrlS(host, data);
}

/**
 * The shared held-action fence of one settings transaction, created on first
 * use. Every nested menu of the transaction resolves the SAME fence through
 * the root-owned save control, so a claim made in a nested menu is still
 * honored by its parent.
 */
export function menuActionFence(control: SettingsSaveControl | undefined): MenuActionFence | undefined {
  if (!control) return undefined;
  control.actionFence ??= createMenuActionFence();
  return control.actionFence;
}

/**
 * Claim a performed action on the transaction's shared fence, so its held
 * repeat and release cannot replay it in a parent menu.
 */
export function claimMenuAction(
  control: SettingsSaveControl | undefined,
  matches: (data: string) => boolean,
): void {
  menuActionFence(control)?.claim(matches);
}

/**
 * Consume a held-key event that replays an already-performed action.
 * Returns true when the event was consumed by the fence.
 */
export function consumeMenuActionFence(
  control: SettingsSaveControl | undefined,
  data: string,
): boolean {
  const fence = control?.actionFence;
  if (!fence) return false;
  return fence.consume(data);
}

function matchesCtrlS(host: MenuTuiHost, data: string): boolean {
  try {
    return host.matchesCtrlS?.(data) === true;
  } catch {
    // A broken/unavailable public host parser must not eat an ordinary key.
    return false;
  }
}
