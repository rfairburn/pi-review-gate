/**
 * Search-capable multi-select for the settings deny pickers (issue #463).
 *
 * The two scoped deny pickers (Top-level tools, Executor tools) open large
 * candidate inventories. This module gives them the SAME live search UX the
 * saved-conversation picker already uses: a native single-line query field
 * above the result list, live filtering as the query changes, a truthful
 * no-match state, and a result list the user navigates with the ordinary
 * select keys.
 *
 * The shape mirrors Pi's own session selector and this project's saved
 * picker:
 *
 * - The query is edited by a NATIVE pi-tui `Input` (the same component the
 *   saved-conversation picker uses), rendered as the first line of the
 *   picker, above a blank line, above the result rows.
 * - The query is a pure VIEW filter. It never changes the staged selection:
 *   the caller's denied set stays the single source of truth, a row hidden by
 *   the query keeps its checked state, and Save persists the whole set.
 * - Navigation (up/down) and activation (Enter) belong to the RESULT list;
 *   every other key belongs to the query field. Escape leaves the picker
 *   (Back) and is never inserted as query text.
 * - The Back row is never filtered away: the nested navigation out of the
 *   picker stays available under any query, including a query that matches
 *   no tool at all.
 * - The query is transient UI state. It is never persisted, never staged
 *   into the settings draft, and each picker keeps its own — the Top-level
 *   and Executor pickers never share a query.
 * - A bracketed paste is opaque query text. It never toggles a row, never
 *   saves, and never leaves the picker, even when the pasted body happens to
 *   contain a control byte that looks like a host chord. A paste delivered
 *   in several chunks is tracked as one paste.
 * - A held key's repeat/release never repeats a host action (toggle, save,
 *   back); navigation and ordinary query-editing repeats are preserved.
 *
 * The matching itself uses the project's shared saved-conversation search
 * grammar (src/session-host/saved-search.ts): `re:` patterns, quoted phrases,
 * and whitespace-separated fuzzy tokens, all of which must match. The picker
 * matches with that module's generic single-text matcher, and only the tool
 * NAME is searched — never a tool's description or purpose — so a query can
 * never match text that is not a tool name. The saved-conversation catalog's
 * Pi 1.5 per-field session matcher is deliberately NOT used here: deny
 * candidates are one name, and fuzzy tool-name matching is the contract.
 *
 * Non-TUI hosts (RPC, print, test mocks) and any host without a resolvable
 * pi-tui Input keep the existing retained full-list selector: the same
 * labels in the same order, with no query field at all.
 */

import { isKeyRelease, isKeyRepeat } from "pi-session-host-tui";
import { filterBySavedSearch } from "../session-host/saved-search";
import {
  nativeMouseHandled,
  routeNativeTextFieldMouse,
  type NativeTextFieldRegion,
  type TextFieldMouseEvent,
  type TextFieldMouseResult,
} from "../text-field-mouse";
import {
  claimMenuAction,
  consumeMenuActionFence,
  createMenuListPointer,
  createMenuListViewport,
  isLiveMenuKeybindingsManager,
  MENU_NATIVE_MAX_VISIBLE,
  menuMatchesCtrlS,
  menuPartRows,
  menuRenderBound,
  menuRenderTheme,
  menuSaveIsRequested,
  resolveMenuActionMatcher,
  resolveMenuTuiHostForRenderers,
  retainedSelect,
  type MenuInput,
  type MenuSelectItem,
  type MenuTuiHost,
  type RetainedUi,
} from "./menu";

/** One selectable row: a stable logical key plus its rendered label. */
export interface DenyPickerRow {
  /** Stable identity of the row; must not change with displayed state. */
  key: string;
  /** Label shown to the user; may change between redraws. */
  label: string;
  /**
   * The text the query matches against. For the deny pickers this is the
   * tool NAME only, so a query can never match a description or purpose.
   */
  searchText: string;
  /**
   * A row that is never filtered away (the Back row). It stays the last
   * visible row so the nested navigation out of the picker survives any
   * query, including a query that matches no tool.
   */
  alwaysVisible?: boolean;
}

/** The input of one deny-picker presentation. */
export interface DenyPickerInput {
  title: string;
  rows: readonly DenyPickerRow[];
  /** The query to start with; the picker returns the final query. */
  query?: string;
  /** Row to highlight when shown; ignored when absent from the rows. */
  initialKey?: string;
  /** Caller-owned meaning of the native cancel key (root Escape applies). */
  cancelHint?: string;
}

/** The result of one deny-picker presentation. */
export interface DenyPickerResult {
  /** The chosen row's key, or undefined when the picker was cancelled. */
  key: string | undefined;
  /** The query the user left behind (carried into the next presentation). */
  query: string;
}

/** The filtered view of one deny picker's rows. */
export interface DenyPickerFilter {
  /** The rows that matched the query, in relevance order. */
  matches: DenyPickerRow[];
  /** The rows that are always shown (the Back row), in inventory order. */
  persistent: DenyPickerRow[];
  /** The full visible list: the matches followed by the persistent rows. */
  visible: DenyPickerRow[];
}

/**
 * The rows a query keeps.
 *
 * The empty query keeps every row in its original order. A nonempty query
 * keeps the rows whose tool name matches, ordered by the shared generic
 * single-text score (lower is better) with the incoming order preserved for
 * equal scores — so an empty query shows the inventory in its original order
 * and a narrowed query keeps the inventory order among equal matches. An
 * unparsable `re:` query matches nothing.
 *
 * The always-visible rows (the Back row) are kept in their inventory order
 * behind the matches, so the navigation out of the picker is never lost.
 *
 * This is a pure function over the displayed rows: it never touches the
 * staged selection.
 */
export function filterDenyPickerRows(
  rows: readonly DenyPickerRow[],
  query: string,
): DenyPickerFilter {
  if (!Array.isArray(rows)) return { matches: [], persistent: [], visible: [] };
  const persistent = rows.filter((row) => row.alwaysVisible === true);
  const filterable = rows.filter((row) => row.alwaysVisible !== true);
  const matches = filterBySavedSearch(filterable, typeof query === "string" ? query : "", (row) => row.searchText);
  return { matches, persistent, visible: [...matches, ...persistent] };
}

/** The truthy no-match line rendered when a query hides every tool row. */
export const NO_MATCHING_TOOLS_MESSAGE = "  No matching tools";

/**
 * Shows the deny picker and resolves with the chosen row's key and the query
 * the user left behind.
 *
 * In an interactive Pi TUI the picker renders the native query field above
 * the result list. Everywhere else — an RPC or print host, a mock, or a host
 * peer without the native Input — it keeps the existing retained selector
 * with the FULL, unfiltered row list: the same labels in the same order as
 * before this search field existed.
 */
export async function retainedDenySelect(
  ui: RetainedUi,
  input: DenyPickerInput,
): Promise<DenyPickerResult> {
  const initialQuery = typeof input.query === "string" ? input.query : "";
  // A latched request unwinds one selector at a time through its normal
  // cancellation return path, preserving the caller's staged fields.
  if (menuSaveIsRequested(ui.saveControl)) return { key: undefined, query: initialQuery };
  if (ui.mode === "tui" && typeof ui.custom === "function") {
    const host = await resolveMenuTuiHostForRenderers(ui);
    if (host !== undefined && host.Input !== undefined) {
      const view = { query: initialQuery };
      try {
        const key = await customDenySelect(ui, host, input, view);
        return { key, query: view.query };
      } catch {
        // A failing custom surface must not lose the menu: degrade to the
        // existing full-list selector below.
      }
    }
  }
  const key = await retainedSelect(ui, {
    title: input.title,
    rows: input.rows.map((row) => ({ key: row.key, label: row.label })),
    ...(input.initialKey === undefined ? {} : { initialKey: input.initialKey }),
    ...(input.cancelHint === undefined ? {} : { cancelHint: input.cancelHint }),
  });
  return { key, query: initialQuery };
}

/**
 * Renders the search-capable picker through the host's custom component slot.
 *
 * The host's own completion contract is used unchanged: the picker resolves
 * by calling `done()` with the chosen row key (or undefined for Back/Escape
 * and for a Ctrl+S save request), and the host promise settles exactly as it
 * does for every other settings menu. The live query is written to `view`
 * as it changes, so the caller can carry it into the next presentation.
 */
function customDenySelect(
  ui: RetainedUi,
  host: MenuTuiHost,
  input: DenyPickerInput,
  view: { query: string },
): Promise<string | undefined> {
  return ui.custom!((tui, theme, keybindings, done) => {
    // Point the standalone pi-tui module at the host's live KeybindingsManager
    // so the native Input's editing keys resolve through the user's
    // keybindings.json exactly as in the plain retained menus.
    if (typeof host.setKeybindings === "function" && isLiveMenuKeybindingsManager(keybindings)) {
      try {
        host.setKeybindings(keybindings);
      } catch {
        // A failing sync must not break the picker: keep component defaults.
      }
    }

    // The action chords are resolved through the host's LIVE keybindings
    // manager, so a user's remap of tui.select.* (navigation, confirm, and
    // cancel) reaches the picker, with Pi's native defaults as the fallback.
    const upMatch = resolveMenuActionMatcher(keybindings, "tui.select.up");
    const downMatch = resolveMenuActionMatcher(keybindings, "tui.select.down");
    const confirmMatch = resolveMenuActionMatcher(keybindings, "tui.select.confirm");
    const cancelMatch = resolveMenuActionMatcher(keybindings, "tui.select.cancel");

    // The picker answers exactly once; a key that arrives after the answer
    // (the host is already tearing the slot down) is ignored.
    let closed = false;
    const close = (key: string | undefined): void => {
      if (closed) return;
      closed = true;
      done(key);
    };

    // The native single-line query field: the same component the
    // saved-conversation picker uses. Its focus follows the picker's own
    // focus (see `focused` below), so the IME cursor lands in the query.
    const queryInput = new host.Input!();
    queryInput.focused = false;
    restoreQuery(queryInput, view.query);

    const titleLine = new host.Text(menuRenderTheme.titleText(theme, input.title), 1, 0);
    const hintLine = new host.Text(denyHintText(host, theme, ui, input.cancelHint), 1, 0);
    const listTheme = menuRenderTheme.selectListTheme(host, theme);
    const noMatchLine = new host.Text(noMatchText(listTheme), 0, 0);
    const border = host.DynamicBorder ? new host.DynamicBorder(menuRenderTheme.borderColor(theme)) : undefined;

    // The visible rows and the highlighted index are the picker's view state.
    let filter = filterDenyPickerRows(input.rows, view.query);
    let selectedIndex = 0;
    if (input.initialKey !== undefined) {
      const initialIndex = filter.visible.findIndex((row) => row.key === input.initialKey);
      if (initialIndex >= 0) selectedIndex = initialIndex;
    }

    // The result list only renders the visible rows; navigation and
    // activation are routed by this picker, never by the list itself, so the
    // query field and the result list cannot both consume one key. The
    // picker's own index stays the only selection authority, including when a
    // bounded host render resizes the list (#653).
    const visibleItems = (): MenuSelectItem[] => filter.visible.map((row) => ({ value: row.key, label: row.label }));
    const viewport = createMenuListViewport({
      host,
      theme: listTheme,
      items: visibleItems(),
      nativeLimit: (count) => Math.min(count, MENU_NATIVE_MAX_VISIBLE),
      selectedIndex: () => selectedIndex,
    });
    if (filter.visible.length > 0) {
      viewport.list.setSelectedIndex(Math.min(Math.max(selectedIndex, 0), filter.visible.length - 1));
    }
    // The pointer routes through the pinned list's own handling, so the list
    // owns press / click / wheel semantics, while the picker stays the OWNER of
    // the selection by adopting whatever the list reports (#723): keyboard
    // navigation continues from a clicked row and the drawn cursor always
    // matches the row that will be toggled. The list's own `setSelectedIndex`
    // never notifies, so mirroring here cannot loop.
    viewport.list.onSelectionChange = (item): void => {
      const index = filter.visible.findIndex((row) => row.key === item.value);
      if (index >= 0) selectedIndex = index;
    };
    // A completed left click is the only pointer event the list reports as an
    // activation; it toggles exactly the row the press highlighted, through the
    // same single-answer path the Enter key uses.
    viewport.list.onSelect = (item): void => close(item.value);

    const applyQuery = (query: string): void => {
      view.query = query;
      const next = filterDenyPickerRows(input.rows, query);
      // The highlighted row identity is preserved when it is still visible;
      // otherwise the first visible row is highlighted, so the index is
      // always clamped to the visible set.
      //
      // Recovering from a zero-match state (an incomplete `re:` or quoted
      // phrase, or a cleared no-match query) highlights the first match:
      // Back was only highlighted because it was the sole row, so keeping it
      // would make Enter leave the picker instead of toggling the match.
      const recovering = filter.matches.length === 0 && next.matches.length > 0;
      const previousKey = recovering ? undefined : filter.visible[selectedIndex]?.key;
      filter = next;
      const retainedIndex = previousKey === undefined ? -1 : next.visible.findIndex((row) => row.key === previousKey);
      selectedIndex = retainedIndex >= 0 ? retainedIndex : 0;
      // The result list is REPLACED on every query change: the pi-tui
      // SelectList's own filter is prefix-only and resets the selection, so
      // rebuilding keeps the shared saved-conversation semantics and the
      // retained highlighted identity. The replacement list is a different
      // instance, so the shared pointer seam refuses any press or click aimed at
      // it until this picker renders again (#723).
      viewport.replace(visibleItems(), selectedIndex);
    };

    // Every non-action key edits the query through the native Input; the
    // result set is recomputed only when the text actually changed.
    const feedQuery = (data: string): void => {
      const before = queryInput.getValue();
      try {
        queryInput.handleInput(data);
      } catch {
        return;
      }
      const after = queryInput.getValue();
      if (after !== before) applyQuery(after);
      tui.requestRender?.();
    };

    const moveSelection = (delta: number): void => {
      const count = filter.visible.length;
      if (count === 0) return;
      selectedIndex = (selectedIndex + delta + count) % count;
      try {
        viewport.list.setSelectedIndex(selectedIndex);
      } catch {
        // A list that refuses the index keeps its own selection; the
        // picker's identity tracking stays authoritative.
      }
      tui.requestRender?.();
    };

    // A bracketed paste is tracked as one paste even when the terminal
    // delivers it in several chunks (the sidebar uses the same routing).
    let pasteActive = false;
    let pasteCarry = "";
    const routePaste = (data: string): boolean => {
      let owned = pasteActive;
      let combined = pasteCarry + data;
      pasteCarry = "";
      for (;;) {
        const marker = owned ? BRACKETED_PASTE_END : BRACKETED_PASTE_START;
        const index = combined.indexOf(marker);
        if (index < 0) {
          // A lone Escape is the cancel key, never a paste prefix: it is
          // also the first byte of the paste-start marker, so it is
          // explicitly excluded (the sidebar routes it the same way).
          if (!owned && combined === "\x1b") return false;
          const suffixLength = markerSuffixLength(combined, marker);
          pasteCarry = suffixLength === 0 ? "" : combined.slice(-suffixLength);
          return owned || suffixLength > 0;
        }
        owned = true;
        pasteActive = !pasteActive;
        combined = combined.slice(index + marker.length);
      }
    };

    let focused = false;
    // Where the native query Input's row and the result list's rows were
    // written by the last render (#714, #723): geometry only, never a copy of
    // the query, the caret, or the highlighted row.
    let queryRegion: NativeTextFieldRegion | undefined;
    const listPointer = createMenuListPointer(viewport);
    return {
      // Focusable: the host focuses this component when it shows it, and the
      // focus is propagated to the embedded Input so the hardware cursor and
      // the IME candidate window are placed in the query field.
      get focused(): boolean {
        return focused;
      },
      set focused(value: boolean) {
        focused = value === true;
        queryInput.focused = focused;
      },
      // `maxRows` is supplied only by a host that measured its own pane (the
      // session-host sidebar, #653); a Pi popup renders natively.
      render: (width: number, maxRows?: number): string[] => {
        const lines: string[] = [];
        if (border) lines.push(...menuPartRows(border, width));
        lines.push(...menuPartRows(titleLine, width));
        const queryTop = lines.length;
        const queryRows = menuPartRows(queryInput, width);
        queryRegion = queryRows.length === 1
          ? { left: 0, top: queryTop, width: Math.max(1, width), rows: 1, firstRow: 0, height: 1 }
          : undefined;
        lines.push(...queryRows);
        lines.push("");
        if (filter.matches.length === 0 && view.query.trim().length > 0) {
          // A query that hides every tool row renders a truthful no-match
          // line instead of an empty list, and the picker stays open and
          // editable (the Back row is still offered below it).
          lines.push(...menuPartRows(noMatchLine, width));
        }
        const footer = [...menuPartRows(hintLine, width), ...(border ? menuPartRows(border, width) : [])];
        // The rows actually rendered above and below the list are measured,
        // never assumed, before the list takes the rest of a bounded render.
        const bound = menuRenderBound(maxRows);
        if (bound !== undefined) viewport.fit(bound - lines.length - footer.length);
        // The result rows' pointer bounds are recorded from THIS render, after
        // the fit: a wrapped title, a no-match line, or a shorter list never
        // leaves them pointing at rows that are not drawn (#723).
        const listTop = lines.length;
        lines.push(...menuPartRows(viewport.list, width));
        listPointer.track(width, listTop);
        lines.push(...footer);
        return lines;
      },
      invalidate: (): void => {
        for (const component of [border, titleLine, queryInput, noMatchLine, viewport.list, hintLine]) invalidateComponent(component);
      },
      /**
       * Pi's own pointer events (#714, #723). The query row and the result
       * rows are disjoint drawn regions and each event reaches exactly ONE
       * native component unchanged in type, so a row click can never also
       * dispatch the editor. The query keeps the caret rules; the result list
       * keeps the row rules: a left press highlights, a completed left click
       * activates once, one wheel report steps one clamped row, and hover,
       * motion, a bare release, or a non-primary button consume nothing.
       * Nothing is forwarded once the picker answered, during a bracketed
       * paste, or at a width the last render did not use.
       */
      handleMouse: (event: TextFieldMouseEvent): TextFieldMouseResult | undefined => {
        if (closed || pasteActive || pasteCarry.length > 0) return undefined;
        if (typeof event !== "object" || event === null) return undefined;
        const region = queryRegion;
        if (region !== undefined && event.width === region.width) {
          const query = routeNativeTextFieldMouse(queryInput, event, region);
          if (query !== undefined) {
            // A press or a wheel that reached the QUERY row is not a row press:
            // any row press still held completes nothing (#723).
            if (event.type === "press" || event.type === "wheel") listPointer.cancelPress();
            if (nativeMouseHandled(query)) tui.requestRender?.();
            return query;
          }
        }
        // The shared seam owns the press: it only forwards a click for the press
        // it accepted, on the list and at the coordinate it accepted, and it
        // refuses a press whose live list or selection window is no longer the
        // one this picker rendered (#723).
        const result = listPointer.route(event);
        if (result !== undefined && result.render !== false) tui.requestRender?.();
        return result;
      },
      /**
       * Where THIS picker's result rows actually landed in its last render, in
       * the picker's own coordinates (#723). A host that owns a whole gesture
       * (the session-host sidebar) uses these to tell a row press from a
       * query-row press before it holds the button, so a query, a hint, or a
       * border is never read as a row.
       */
      listMouseRegion: (): NativeTextFieldRegion | undefined => listPointer.region(),
      handleInput: (data: string): void => {
        if (closed) return;
        // Any key is unrelated to a row press the pointer is still holding
        // (#723): the picker's own selection or query may move, so the matching
        // click can no longer be proven to mean the row it landed on.
        listPointer.cancelPress();
        // A bracketed paste is opaque query text: it never toggles a row,
        // never saves, and never leaves the picker. The native Input owns
        // the pasted text.
        if (routePaste(data)) {
          feedQuery(data);
          return;
        }
        // A held-key event that replays an action this transaction already
        // performed is consumed by the shared fence BEFORE any action runs,
        // so a held Escape cannot close the picker, then the Tools menu,
        // and then apply the staged draft at the root.
        if (consumeMenuActionFence(ui.saveControl, data)) return;
        // A held key's release never replays an action.
        if (isKeyRelease(data)) return;
        const saveChord = ui.saveControl !== undefined
          && ui.saveControl.suspended === 0
          && menuMatchesCtrlS(host, data);
        // A held key's repeat never replays a save, a toggle, or a back.
        // Navigation and query-editing repeats stay ordinary repeats, as in
        // the saved-conversation picker.
        if (isKeyRepeat(data) && (saveChord || confirmMatch(data) || cancelMatch(data))) return;
        if (saveChord) {
          ui.saveControl!.saveRequested = true;
          claimMenuAction(ui.saveControl, (event) => menuMatchesCtrlS(host, event));
          close(undefined);
          return;
        }
        if (upMatch(data)) {
          moveSelection(-1);
          return;
        }
        if (downMatch(data)) {
          moveSelection(1);
          return;
        }
        if (confirmMatch(data)) {
          const row = filter.visible[selectedIndex];
          if (row === undefined) return;
          // The toggle claims the action so its held repeat cannot toggle a
          // second row in the re-shown picker.
          claimMenuAction(ui.saveControl, confirmMatch);
          close(row.key);
          return;
        }
        if (cancelMatch(data)) {
          // The cancel claims the action so its held repeat cannot close the
          // parent menu or apply the staged draft.
          claimMenuAction(ui.saveControl, cancelMatch);
          close(undefined);
          return;
        }
        feedQuery(data);
      },
    };
  });
}

/**
 * Restore a query into the native input with the caret at its end.
 *
 * The pi-tui Input exposes no public cursor setter, so the text is restored
 * through the component's own insert path: the caret then sits exactly where
 * the user left it, and the component's undo history covers the restored
 * text. A character the native input refuses to insert (a control byte that
 * arrived through a paste) cannot be retyped, so the exact text is set
 * directly instead and the component's own caret placement is kept.
 */
function restoreQuery(input: MenuInput, value: string): void {
  if (value.length === 0) return;
  input.setValue("");
  for (const character of value) input.handleInput(character);
  if (input.getValue() === value) return;
  input.setValue(value);
}

/** Invalidates one host component, tolerating a component that cannot. */
function invalidateComponent(component: unknown): void {
  const invalidate = (component as { invalidate?: () => void }).invalidate;
  if (typeof invalidate !== "function") return;
  try {
    invalidate.call(component);
  } catch {
    // A failing invalidate must not break the picker.
  }
}

/** The themed no-match line. */
function noMatchText(theme: { noMatch(text: string): string }): string {
  try {
    return theme.noMatch(NO_MATCHING_TOOLS_MESSAGE);
  } catch {
    return NO_MATCHING_TOOLS_MESSAGE;
  }
}

/**
 * The key hint line under the result list. It names the search field first
 * (the picker's distinguishing control) and then the ordinary navigation
 * keys, using the host's live keybinding text where it is available.
 */
function denyHintText(
  host: MenuTuiHost,
  theme: { fg(color: string, text: string): string },
  ui: RetainedUi,
  cancelHint = "cancel",
): string {
  const saveHintAvailable = ui.saveControl !== undefined
    && ui.saveControl.suspended === 0
    && host.matchesCtrlS !== undefined;
  let hints: string;
  try {
    if (typeof host.rawKeyHint === "function" && typeof host.keyHint === "function") {
      hints = `type to search · ${host.rawKeyHint("↑↓", "navigate")}  ${host.keyHint("tui.select.confirm", "toggle")}  ${host.keyHint("tui.select.cancel", cancelHint)}`;
    } else {
      hints = "type to search · ↑↓ navigate · enter toggle · esc " + cancelHint;
    }
  } catch {
    hints = "type to search · ↑↓ navigate · enter toggle · esc " + cancelHint;
  }
  const text = saveHintAvailable ? `${hints} · Ctrl+S save` : hints;
  try {
    return theme.fg("muted", text);
  } catch {
    return text;
  }
}

/** The bracketed-paste markers the terminal sends. */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * The length of the longest partial marker suffix at the end of a value, so
 * a paste marker split across two chunks is still recognized.
 */
function markerSuffixLength(value: string, marker: string): number {
  const limit = Math.min(value.length, marker.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
