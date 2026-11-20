/**
 * Session-host sidebar presenter for the LOCAL review settings (issue #653).
 *
 * The sidebar is only a configuration vessel for the ONE shared persisted
 * `/review-settings` transaction that Main opens through
 * `openLocalReviewSettings`: this module owns no settings data, no option
 * list, no menu definition, and no IO. It composes the structural
 * {@link UiContext} that transaction takes from three primitives the sidebar
 * supplies — its own in-pane `custom` screen host, its shared
 * SessionHostTextField (`editText`), and a bounded notice sink with its
 * optional single-slot section help — plus a
 * {@link MenuTuiHost} built from this project's pinned `pi-session-host-tui`
 * components, supplied per UI (never through the process-global
 * `setMenuTuiHost` test seam).
 *
 * The host deliberately has no `setKeybindings` member: the shared menus would
 * otherwise install the live manager process-globally and leave it there. The
 * sidebar instead runs every factory, render, and input of a screen inside
 * {@link SidebarMenuKeybindings.run}, which Main backs with the existing
 * `withNativeFieldKeybindings` scope, so configured `tui.select.*` and editing
 * bindings apply while nothing stays installed afterwards.
 *
 * `select` and `confirm` are small list screens on the same `custom` host and
 * the same pinned SelectList. They never latch a save; a confirm defaults to
 * No, and a cancel (or an aborted pane) is always No. Like the shared menus,
 * their list follows the rows the pane measured for the screen. A confirm's
 * message is the screen's mandatory `disclosure` metadata: the pane shows it
 * whole as the screen's one notice and accepts Yes only from a written frame
 * that shows it.
 */
import {
  Container,
  Input,
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  SelectList,
  Text,
} from "pi-session-host-tui";
import {
  claimMenuAction,
  consumeMenuActionFence,
  createMenuListViewport,
  fitMenuListViewport,
  MENU_NATIVE_MAX_VISIBLE,
  menuRenderTheme,
  resolveMenuActionMatcher,
  type MenuCustomFactory,
  type MenuSelectItem,
  type MenuTuiHost,
} from "../settings/menu";
import type { SettingTextEditor } from "../settings/text-input";
import type { SettingsSectionHelpPort, UiContext } from "../settings/ui";

/** The live native keybinding manager surface the sidebar's settings screens use. */
export interface SidebarMenuKeybindingsManager {
  matches(data: string, keybinding: string): boolean;
  getKeys?(keybinding: string): readonly string[];
  getDefinition?(keybinding: string): unknown;
}

/**
 * The native keybindings of ONE review-settings open. `run` scopes the
 * manager for components that read pi-tui's global keybindings and must
 * restore the previous manager when it returns (Main: the existing
 * `withNativeFieldKeybindings`).
 */
export interface SidebarMenuKeybindings {
  readonly manager: SidebarMenuKeybindingsManager;
  run<T>(operation: () => T): T;
  /** Bounded notice when the native keybindings file could not be used. */
  readonly notice?: string;
}

/**
 * Main's narrow review-settings port for the sidebar. `open` runs the shared
 * LOCAL transaction once over the given UI and resolves when it ends; it never
 * receives selected-session or remote-row data. `loadKeybindings` reads the
 * native keybindings fresh for each open.
 */
export interface SidebarReviewSettingsHost {
  open(ui: UiContext): Promise<void>;
  loadKeybindings?(): SidebarMenuKeybindings;
}

/** The sidebar primitives one review-settings UI is composed from. */
export interface SidebarReviewSettingsUiPorts {
  custom(factory: MenuCustomFactory): Promise<string | undefined>;
  editText: SettingTextEditor;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** The pane's single contextual-notice slot for a running settings section (#653). */
  sectionHelp?: SettingsSectionHelpPort;
  menuTuiHost: MenuTuiHost;
}

/**
 * The pinned pi-tui components as a per-UI menu host. Key hints follow the
 * live manager, so a remapped binding is described truthfully.
 */
export function createSidebarMenuTuiHost(manager: SidebarMenuKeybindingsManager): MenuTuiHost {
  const ctrlS = Key.ctrl("s");
  return {
    SelectList: SelectList as unknown as MenuTuiHost["SelectList"],
    Container: Container as unknown as MenuTuiHost["Container"],
    Text: Text as unknown as MenuTuiHost["Text"],
    Input: Input as unknown as MenuTuiHost["Input"],
    matchesCtrlS: (data) => matchesKey(data, ctrlS),
    rawKeyHint: (keys, description) => `${keys} ${description}`,
    keyHint: (keybinding, description) => `${keyLabel(manager, keybinding)} ${description}`,
  };
}

function keyLabel(manager: SidebarMenuKeybindingsManager, keybinding: string): string {
  try {
    const keys = manager.getKeys?.(keybinding) ?? [];
    if (keys.length > 0) return keys.join("/");
  } catch {
    // A failing manager falls back to the action name.
  }
  return keybinding;
}

/** Compose the structural settings UI over the sidebar's primitives. */
export function createSidebarReviewSettingsUi(ports: SidebarReviewSettingsUiPorts): UiContext {
  const ui: UiContext = {
    mode: "tui",
    menuTuiHost: ports.menuTuiHost,
    custom: (factory) => ports.custom(factory),
    editText: (request) => ports.editText(request),
    notify: (message, type) => ports.notify(message, type),
    ...(ports.sectionHelp !== undefined ? { settingsSectionHelp: ports.sectionHelp } : {}),
    select: (title, options) => listScreen(ui, ports.menuTuiHost, {
      title,
      rows: options.map((option) => ({ value: option, label: option })),
    }),
    confirm: async (title, message) => await listScreen(ui, ports.menuTuiHost, {
      title,
      message,
      rows: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      initialValue: "no",
    }) === "yes",
  };
  return ui;
}

interface ListScreenInput {
  readonly title: string;
  readonly message?: string;
  readonly rows: readonly MenuSelectItem[];
  readonly initialValue?: string;
}

/** One plain list screen (host selector or confirmation) on the sidebar's custom host. */
function listScreen(ui: UiContext, host: MenuTuiHost, input: ListScreenInput): Promise<string | undefined> {
  const custom = ui.custom;
  if (typeof custom !== "function") return Promise.resolve(undefined);
  return custom((tui, theme, keybindings, done) => {
    const confirmMatch = resolveMenuActionMatcher(keybindings, "tui.select.confirm");
    const cancelMatch = resolveMenuActionMatcher(keybindings, "tui.select.cancel");
    const container = new host.Container();
    // Every part except the list: the pane's bounded render measures them (#653).
    const chrome: unknown[] = [];
    const add = (part: unknown, isChrome = true): void => {
      container.addChild(part);
      if (isChrome) chrome.push(part);
    };
    add(new host.Text(menuRenderTheme.titleText(theme, input.title), 1, 0));
    // The message is not drawn here: it is the pane's single notice (#653).
    const disclosure = input.message !== undefined && input.message.length > 0 ? input.message : undefined;
    const items = [...input.rows];
    const viewport = createMenuListViewport({
      host,
      theme: menuRenderTheme.selectListTheme(host, theme),
      items,
      nativeLimit: (count) => Math.min(Math.max(count, 1), MENU_NATIVE_MAX_VISIBLE),
    });
    if (input.initialValue !== undefined) {
      const index = items.findIndex((item) => item.value === input.initialValue);
      if (index >= 0) viewport.list.setSelectedIndex(index);
    }
    let closed = false;
    const close = (value: string | undefined): void => {
      if (closed) return;
      closed = true;
      done(value);
    };
    viewport.list.onSelect = (item) => close(item.value);
    viewport.list.onCancel = () => close(undefined);
    add(viewport.component, false);
    add(new host.Text(`${host.rawKeyHint?.("↑↓", "navigate") ?? "↑↓ navigate"} · ${host.keyHint?.("tui.select.confirm", "select") ?? "enter select"} · ${host.keyHint?.("tui.select.cancel", "cancel") ?? "esc cancel"}`, 1, 0));
    return {
      ...(disclosure !== undefined ? { disclosure } : {}),
      // The sidebar pane passes the rows it measured for this screen (#653).
      render: (width: number, maxRows?: number): string[] => {
        fitMenuListViewport(viewport, width, maxRows, chrome);
        return container.render(width);
      },
      invalidate: (): void => container.invalidate(),
      handleInput: (data: string): void => {
        if (closed) return;
        // The transaction's shared held-action fence: a held key that already
        // acted in a parent screen cannot answer this one.
        if (consumeMenuActionFence(ui.saveControl, data)) return;
        if (isKeyRelease(data)) return;
        if (isKeyRepeat(data) && (confirmMatch(data) || cancelMatch(data))) return;
        // The pane forwards Cancel without requiring a written disclosure and
        // treats a key bound to both as Cancel; SelectList would check Confirm
        // first, so a disclosure screen settles that key as Cancel (No) here —
        // before the save chord, which may itself be the configured Cancel.
        if (disclosure !== undefined && cancelMatch(data)) {
          claimMenuAction(ui.saveControl, cancelMatch);
          close(undefined);
          return;
        }
        // A list screen never saves: Ctrl+S is inert unless it answered No above.
        if (host.matchesCtrlS?.(data) === true) return;
        if (confirmMatch(data)) claimMenuAction(ui.saveControl, confirmMatch);
        else if (cancelMatch(data)) claimMenuAction(ui.saveControl, cancelMatch);
        viewport.list.handleInput(data);
        tui.requestRender?.();
      },
    };
  });
}
