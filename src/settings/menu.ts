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
 *   settings submenu and theme selector use. Arrow navigation, Enter, and
 *   Esc/Ctrl+C come from the host's `tui.select.*` keybindings, so keyboard
 *   semantics match the native selector.
 * - Everywhere else (RPC hosts, print mode, test mocks, a host without the
 *   pi-tui alias) it falls back to the plain `ctx.ui.select` with the same
 *   labels in the same order and maps the returned label back to a key by
 *   first match — byte-identical to the previous label-based dispatch. RPC
 *   hosts keep today's behavior; `custom()` is never required of them.
 *
 * The pi packages are host-provided peers, never hard dependencies: both are
 * soft-required inside try/catch exactly like ./tool-result-hints (the Pi
 * loader aliases them to the running host's modules), and any load failure
 * degrades to the plain selector instead of breaking the menu. A key that no
 * longer exists in the current rows keeps the default first row: safe, with
 * no invented reorder. Selection position is UI-only state; it is never
 * persisted as a product setting.
 */

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

/** The pi-tui Container surface this adapter builds into. */
export interface MenuContainer {
  addChild(component: unknown): void;
  render(width: number): string[];
  invalidate(): void;
}

/**
 * The host TUI surface the adapter needs. Injectable through
 * {@link setMenuTuiHost} for tests; loaded from the host-aliased pi packages
 * otherwise.
 */
export interface MenuTuiHost {
  SelectList: new (items: MenuSelectItem[], maxVisible: number, theme: MenuSelectListTheme) => MenuSelectList;
  Container: new () => MenuContainer;
  Text: new (text: string, x?: number, y?: number) => unknown;
  /** Host DynamicBorder; an explicit color function is always passed. */
  DynamicBorder?: new (color?: (segment: string) => string) => unknown;
  /** Host getSelectListTheme(); used when loadable and render-safe. */
  getSelectListTheme?: () => MenuSelectListTheme | undefined;
  rawKeyHint?: (keys: string, description: string) => string;
  keyHint?: (keybinding: string, description: string) => string;
}

let hostOverride: MenuTuiHost | undefined;
let loadedHost: MenuTuiHost | undefined;
let hostLoadAttempted = false;

/** Test seam: inject a fake TUI host, or clear the override with undefined. */
export function setMenuTuiHost(host: MenuTuiHost | undefined): void {
  hostOverride = host;
}

function resolveMenuTuiHost(): MenuTuiHost | undefined {
  if (hostOverride !== undefined) return hostOverride;
  if (!hostLoadAttempted) {
    loadedHost = loadMenuTuiHost();
    hostLoadAttempted = true;
  }
  return loadedHost;
}

function loadMenuTuiHost(): MenuTuiHost | undefined {
  try {
    // Loaded inside Pi: the extension loader aliases @earendil-works/pi-coding-agent
    // and @earendil-works/pi-tui to the running host's modules (verified in pi
    // 0.85.1, dist/core/extensions/loader.js). Never a hard import: both are
    // host-provided peers, not dependencies of this extension.
    const tui = require("@earendil-works/pi-tui") as Record<string, unknown>;
    if (typeof tui?.SelectList !== "function" || typeof tui?.Container !== "function" || typeof tui?.Text !== "function") {
      return undefined;
    }
    const host: MenuTuiHost = {
      SelectList: tui.SelectList as MenuTuiHost["SelectList"],
      Container: tui.Container as MenuTuiHost["Container"],
      Text: tui.Text as MenuTuiHost["Text"],
    };
    try {
      const agent = require("@earendil-works/pi-coding-agent") as Record<string, unknown>;
      if (typeof agent?.DynamicBorder === "function") host.DynamicBorder = agent.DynamicBorder as MenuTuiHost["DynamicBorder"];
      if (typeof agent?.getSelectListTheme === "function") host.getSelectListTheme = agent.getSelectListTheme as MenuTuiHost["getSelectListTheme"];
      if (typeof agent?.rawKeyHint === "function") host.rawKeyHint = agent.rawKeyHint as MenuTuiHost["rawKeyHint"];
      if (typeof agent?.keyHint === "function") host.keyHint = agent.keyHint as MenuTuiHost["keyHint"];
    } catch {
      // Borders and key hints are cosmetic: degrade without them.
    }
    return host;
  } catch {
    // Outside Pi (unit tests, tooling) the peer is simply not resolvable.
    return undefined;
  }
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
  const host = resolveMenuTuiHost();
  if (ui.mode === "tui" && typeof ui.custom === "function" && host !== undefined) {
    try {
      return await customSelect(ui, host, input);
    } catch {
      // A failing custom surface must not lose the menu: degrade to the plain selector.
    }
  }
  return plainSelect(ui, input);
}

/** Renders the menu with the host SelectList and resolves on Enter/Esc. */
function customSelect(ui: RetainedUi, host: MenuTuiHost, input: RetainedSelectInput): Promise<string | undefined> {
  const custom = ui.custom!;
  return custom((tui, theme, _keybindings, done) => {
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
    container.addChild(new host.Text(hintText(host), 1, 0));
    if (host.DynamicBorder) container.addChild(new host.DynamicBorder(borderColor(theme)));

    return {
      render: (width: number): string[] => container.render(width),
      invalidate: (): void => container.invalidate(),
      handleInput: (data: string): void => {
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

function hintText(host: MenuTuiHost): string {
  try {
    if (typeof host.rawKeyHint === "function" && typeof host.keyHint === "function") {
      // The host's live keybinding text, so user keybindings.json overrides
      // are honored instead of hard-coded keys.
      return `${host.rawKeyHint("↑↓", "navigate")}  ${host.keyHint("tui.select.confirm", "select")}  ${host.keyHint("tui.select.cancel", "cancel")}`;
    }
  } catch {
    // Fall through to the static hint.
  }
  return "↑↓ navigate · enter select · esc cancel";
}
