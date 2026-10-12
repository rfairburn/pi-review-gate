/**
 * Pending-question list UI (issue #95).
 *
 * One plain structural Component (render/handleInput/invalidate) with shared
 * list/question-answer/notice-detail modes in the shared public custom
 * overlay. The host leaves the underlying editor in place; the native-editor
 * bridge restores its captured draft when this interaction closes. While the
 * overlay has focus, all input — including Escape — is handled by this
 * component, so it never triggers Pi's abort.
 *
 * - List mode: every pending question of the current session, in creation
 *   order, read live from the controller on each render (a question that
 *   becomes waiting while the list is open appears without re-opening).
 * - Answer mode: the selected question's supplied choices plus a free-text
 *   row and an explicit Decline row. Declining is one deliberate action
 *   (select Decline, confirm) with no second confirmation; Escape only goes
 *   back, so nothing declines by accident. There is no length cap on
 *   answers — a long paste or typed draft is kept in full and can be
 *   submitted as-is (the controller applies no answer bound).
 * - Notice mode: the selected notice's complete Markdown body and optional
 *   context use the same host Markdown component as question content and have
 *   exactly More details and Close actions. More details closes this popup and
 *   reports the exact selected notice snapshot for ordinary owner-session
 *   delivery; the controller consumes it before sending. Close removes only
 *   it. Full-width top and bottom rules and theme-background-filled
 *   one-cell side padding frame every shared-content row, with no side
 *   borders; the overlay's public maxHeight and vertical margins define the
 *   responsive viewport inside it.
 *
 * Navigation, confirm, cancel, cursor movement, and deletion resolve through
 * the host's live KeybindingsManager (`tui.select.*`, `tui.editor.*`), so
 * user keybindings.json overrides are honored. The extension's own shortcut
 * chord (Ctrl+Alt+Up) is matched with the host pi-tui's matchesKey when
 * loadable; without it, Escape still closes the list.
 *
 * Free-text editing: the free-text row embeds the SAME host-wired native
 * editor instance the /review-settings text fields use — acquired through
 * the shared host-wired bridge (src/native-editor-bridge.ts) before this
 * component's `ctx.ui.custom` overlay opens, so no nested second modal and no
 * second editing engine exist. The instance is the single source of truth
 * for the draft text and cursor: native main-chat Tab path/subpath/`~/`
 * completion, the fd-backed `@` picker, Ctrl+C clears (never cancels),
 * Ctrl+G external editing, image paste to a temp path, Shift+Enter/Ctrl+J
 * newlines, cursor/history/kill-ring/undo — all of Pi's own editor code
 * running unmodified under the live KeybindingsManager, including user
 * keybindings.json overrides. Enter submits the whole answer through the
 * native submit path (it is never executed as a chat message or command);
 * Escape first dismisses a visible completion list, then returns to the
 * option rows with the draft kept; Ctrl+D on an empty editor returns to the
 * option rows instead of exiting Pi.
 *
 * When the host's native seams are unavailable (no
 * setEditorComponent/getEditorComponent, or the agent module cannot be
 * loaded) the free-text row renders an unavailable line: the question stays
 * pending, and the choices and Decline still work. No non-parity fallback
 * buffer is offered.
 */

import type { FieldEditorInstance } from "../native-editor-bridge";
import { safeMarkdownDisplaySource } from "../markdown-safety";
import { visibleTerminalText } from "../tool-result-text";
import type { QuestionMarkdownComponent, QuestionScrollViewComponent, QuestionTuiHost } from "./pi-tui-host";
import type { PendingNotice, PendingUserInput, SubmitResult, UserQuestionController } from "./controller";

/** The approved chord; the label shown to users is platform-specific. */
export const QUESTION_LIST_SHORTCUT_KEY = "ctrl+alt+up";

export interface QuestionUiKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export interface QuestionUiTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  /** Pi's public background formatter, used to make every overlay cell opaque. */
  bg?(color: string, text: string): string;
}

export type QuestionListDone =
  | { kind: "closed" }
  | { kind: "submitted"; result: SubmitResult }
  | { kind: "notice-details"; noticeId: string; expectedNotice: PendingNotice };

export interface QuestionListComponentOptions {
  controller: UserQuestionController;
  keybindings: QuestionUiKeybindings;
  theme: QuestionUiTheme;
  /** Host pi-tui helpers; every member optional (degraded rendering without). */
  tuiHost?: QuestionTuiHost;
  /** Platform label for the shortcut, e.g. "Ctrl+Alt+Up" or "Ctrl+Option+Up". */
  shortcutLabel: string;
  /**
   * The host-wired native editor instance for the free-text row, acquired
   * through the shared bridge before this component's custom slot opened
   * (undefined when the host's native seams are unavailable — the free-text
   * row then renders an unavailable line and the question stays pending).
   */
  nativeField?: FieldEditorInstance;
  /**
   * True once the session rebound while this UI was opening or open (the
   * same SessionManager object may be reused across /new/resume, so the
   * controller's identity check alone cannot see it). A stale UI closes
   * without submitting and never displays another session's questions.
   */
  isStale?: () => boolean;
  /** Row budget matching the custom overlay's public maxHeight. */
  getViewportRows?: () => number | undefined;
  /** Invalidate the live TUI after component/controller state changes. */
  requestRender?: () => void;
  /** Test seam for exercising native ScrollView outside the custom overlay. */
  scrollable?: boolean;
  onDone: (result: QuestionListDone) => void;
}

export interface QuestionListComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  /** Installs the live idle probe used for async answer delivery. */
  setSourceProbe(probe: { isIdle?: () => boolean } | undefined): void;
}

interface RenderedMarkdown {
  lines: string[];
  native: boolean;
}

const TYPE_ROW = Symbol("type-answer");
const DECLINE_ROW = Symbol("decline-answer");
const NOTICE_MORE_DETAILS = "__more_details__";
const NOTICE_CLOSE = "__close_notice__";
const SCROLL_PAGE_UP_KEYS = ["ctrl+alt+pageup", "shift+alt+up"] as const;
const SCROLL_PAGE_DOWN_KEYS = ["ctrl+alt+pagedown", "shift+alt+down"] as const;
const POPUP_SCROLL_HINT = "Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll";
const POPUP_HORIZONTAL_PADDING = 1;
const POPUP_VERTICAL_PADDING = 1;
const POPUP_BACKGROUND_FULL_RESET_SPLIT = /(\x1b\[0?m|\x1b\[49m)/;
export function createQuestionListComponent(options: QuestionListComponentOptions): QuestionListComponent {
  const { controller, keybindings, theme, tuiHost, shortcutLabel } = options;
  const isStale = options.isStale ?? (() => false);
  let mode: "list" | "answer" | "notice" = "list";
  let selectedId: string | undefined;
  let answerIndex = 0;
  let noticeActionIndex = 0;
  let manualScrollOffset = 0;
  let answerViewportFocus: { start: number; end: number; anchor: number } | undefined;
  let answerFocusPending = false;
  let listViewportFocus: { start: number; end: number; anchor: number } | undefined;
  let listFocusPending = true;
  let lastViewportRows: number | undefined;
  let lastListViewportRows: number | undefined;
  let lastRenderedWidth: number | undefined;
  let lastNativeViewportHeight = 0;
  let editing = false;
  let closed = false;
  let cachedContent: { width: number; lines: string[] } | undefined;
  let nativeScrollView: QuestionScrollViewComponent | undefined;
  let invalidateNativeScrollView: (() => void) | undefined;
  const markdownComponents = new Map<string, QuestionMarkdownComponent | null>();
  // The shortcut handler installs a live idle probe before the component is
  // shown; if the session rebinds while open, the stale fence closes this UI
  // before any submission can use the probe.
  let activeSourceProbe: { isIdle?: () => boolean } | undefined;

  const invalidateContent = () => {
    cachedContent = undefined;
  };

  const invalidate = () => {
    if (mode === "answer") answerFocusPending = true;
    if (mode === "list") listFocusPending = true;
    invalidateContent();
    for (const component of markdownComponents.values()) {
      try {
        component?.invalidate();
      } catch {
        // Discard a failing Markdown instance without blocking popup refresh.
      }
    }
    markdownComponents.clear();
    invalidateNativeScrollView?.();
    options.requestRender?.();
  };

  // Live questions (registered while the list is open) must refresh the view.
  const unsubscribeState = controller.addStateListener(invalidate);

  const close = (result?: SubmitResult | { kind: "notice-details"; noticeId: string; expectedNotice: PendingNotice }) => {
    if (closed) return;
    closed = true;
    // End any open editing episode so the bridge's settle callback is
    // cleared: a late or stale settle must never act through this UI.
    endEditingEpisode();
    unsubscribeState();
    if (result && "status" in result) options.onDone({ kind: "submitted", result });
    else options.onDone(result ?? { kind: "closed" });
  };

  const pendingNow = (): readonly PendingUserInput[] => controller.listPending();

  /** Keep the list selection on a live question; fall back to the first. */
  function currentListSelection(): string | undefined {
    const pending = pendingNow();
    if (pending.length === 0) return undefined;
    if (selectedId && pending.some((question) => question.id === selectedId)) return selectedId;
    return pending[0]!.id;
  }

  function answerRows(): Array<string | typeof TYPE_ROW | typeof DECLINE_ROW> {
    const record = selectedId ? controller.get(selectedId) : undefined;
    const choices = record?.choices ?? [];
    return [...choices, TYPE_ROW, DECLINE_ROW];
  }

  function noticeRows(): string[] {
    return [NOTICE_MORE_DETAILS, NOTICE_CLOSE];
  }

  function submitFromAnswer(result: SubmitResult): void {
    if (result.status === "rejected") {
      // Stale state (session changed or question vanished): leave the UI.
      close();
      return;
    }
    if (result.empty) {
      close(result);
      return;
    }
    mode = "list";
    resetScroll();
    endEditingEpisode();
  }

  /** Open an editing episode around the shared native field instance. */
  function beginEditingEpisode(): void {
    const field = options.nativeField;
    if (!field || editing) return;
    // The bridge-owned flags gate the instance's intercepted keys and route
    // its settled submit through this component.
    field.fieldActive = true;
    field.onFieldSettle = (value) => handleFieldSettle(value);
    setEditing(true);
  }

  /** End the episode; idempotent (the bridge also clears fieldActive on settle). */
  function endEditingEpisode(): void {
    const field = options.nativeField;
    if (field) {
      field.fieldActive = false;
      field.onFieldSettle = undefined;
    }
    setEditing(false);
  }

  /** Settle of the native submit path or an intercepted cancel-equivalent. */
  function handleFieldSettle(value: string | undefined): void {
    if (closed || isStale()) {
      // A closed or rebound UI must never settle into the current session:
      // beginSession resets IDs, so this UI's selected question could resolve
      // to the replacement session's question. Close without submitting;
      // ending the episode clears the bridge callbacks.
      close();
      return;
    }
    if (value === undefined) {
      // Esc (after any visible completion list) or empty-editor Ctrl+D:
      // back to the option rows with the draft kept in the instance.
      endEditingEpisode();
      return;
    }
    const id = selectedId;
    if (!id || !controller.get(id)) {
      // Stale state (session changed or question vanished): leave the UI.
      close();
      return;
    }
    // The native submit path already cleared the instance's text.
    endEditingEpisode();
    submitFromAnswer(controller.submitAnswer(id, value, sourceProbe()));
  }

  /** Enter/leave editing, keeping the native field's focus flag in step. */
  function setEditing(value: boolean): void {
    if (editing !== value && mode === "answer") answerFocusPending = true;
    editing = value;
    const field = options.nativeField;
    if (field) {
      try {
        field.focused = value;
      } catch {
        // Focus propagation is best-effort; input still reaches the editor.
      }
    }
    invalidate();
  }

  function handleListInput(data: string): void {
    if (keybindings.matches(data, "tui.select.up")) {
      const pending = pendingNow();
      const index = pending.findIndex((question) => question.id === currentListSelection());
      if (index > 0) selectedId = pending[index - 1]!.id;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      const pending = pendingNow();
      const index = pending.findIndex((question) => question.id === currentListSelection());
      if (index >= 0 && index < pending.length - 1) selectedId = pending[index + 1]!.id;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const id = currentListSelection();
      if (!id) return;
      const record = controller.getPending(id);
      if (!record) return;
      selectedId = id;
      resetScroll();
      if (isNotice(record)) {
        mode = "notice";
        noticeActionIndex = 0;
      } else {
        mode = "answer";
        answerIndex = 0;
        answerFocusPending = true;
        // A new answer-view session starts fresh — the shared instance's text
        // is cleared so a previous question's draft never shows or submits as
        // this one's (the host undo history has no public clear, so an earlier
        // deliberate Ctrl+- could still surface prior text — same as settings).
        const field = options.nativeField;
        if (field) {
          try {
            field.setText("");
          } catch {
            // A failing clear must not block entering the answer view.
          }
        }
        endEditingEpisode();
      }
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel") || matchesShortcut(data)) {
      close();
    }
  }

  function handleAnswerInput(data: string): void {
    const id = selectedId;
    if (!id) return;
    if (!controller.get(id)) {
      // The question vanished while open (session switch/new/fork): leave
      // without touching the model.
      close();
      return;
    }
    if (editing) {
      handleEditingInput(data);
      return;
    }
    const rows = answerRows();
    if (keybindings.matches(data, "tui.select.up")) {
      if (answerIndex > 0) {
        answerIndex -= 1;
        answerFocusPending = true;
      }
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (answerIndex < rows.length - 1) {
        answerIndex += 1;
        answerFocusPending = true;
      }
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const row = rows[answerIndex];
      if (row === undefined) return;
      if (row === TYPE_ROW) {
        // No-op when the native field is unavailable: the question stays
        // pending and the choices/Decline remain usable.
        beginEditingEpisode();
        return;
      }
      if (row === DECLINE_ROW) {
        submitFromAnswer(controller.submitDecline(id));
        return;
      }
      submitFromAnswer(controller.submitAnswer(id, row, sourceProbe()));
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      mode = "list";
      resetScroll();
      invalidate();
      return;
    }
    if (matchesShortcut(data)) {
      close();
    }
  }

  function handleNoticeInput(data: string): void {
    const id = selectedId;
    const record = id ? controller.getPending(id) : undefined;
    if (!id || !record || !isNotice(record)) {
      close();
      return;
    }
    const rows = noticeRows();
    if (keybindings.matches(data, "tui.select.up")) {
      if (noticeActionIndex > 0) noticeActionIndex -= 1;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (noticeActionIndex < rows.length - 1) noticeActionIndex += 1;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      if (rows[noticeActionIndex] === NOTICE_MORE_DETAILS) {
        // Closing first restores Pi's normal editor/transcript surface. The
        // owner then sends only after this custom interaction has resolved.
        close({ kind: "notice-details", noticeId: id, expectedNotice: record });
        return;
      }
      if (rows[noticeActionIndex] === NOTICE_CLOSE) {
        if (!controller.closeNotice(id)) {
          close();
          return;
        }
        if (controller.listPending().length === 0) close();
        else {
          mode = "list";
          resetScroll();
          invalidate();
        }
        return;
      }
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      mode = "list";
      resetScroll();
      invalidate();
      return;
    }
    if (matchesShortcut(data)) close();
  }

  function handleEditingInput(data: string): void {
    const field = options.nativeField;
    if (!field) {
      // Defensive: editing can only be entered with a native field.
      endEditingEpisode();
      return;
    }
    // The approved collapse chord works in editing mode just like in list
    // and answer modes: it closes the UI without submitting; the question
    // stays pending. Pre-checked so the chord never reaches the instance's
    // extension-shortcut path (which would re-trigger this same surface).
    if (matchesShortcut(data)) {
      close();
      return;
    }
    // Back to the option rows with the draft kept — but only when no
    // completion list is visible (while it is, the key belongs to the editor
    // and dismisses the list first; the bridge then sees the next press as
    // cancel-equivalent), and only for keys that are NOT also the native
    // clear: tui.select.cancel defaults include ctrl+c, which must reach the
    // instance so Pi's own app.clear handler clears the draft instead of
    // cancelling. A rebound app.interrupt is still caught by the bridge.
    const listVisible = typeof field.isShowingAutocomplete === "function" && field.isShowingAutocomplete();
    if (!listVisible && keybindings.matches(data, "tui.select.cancel") && !keybindings.matches(data, "app.clear")) {
      endEditingEpisode();
      return;
    }
    // Everything else is the host-wired native editor's own business:
    // completion, `@` picking, movement, word/line edits, deletion, yank,
    // undo, newlines, paste, Ctrl+C clear, Ctrl+G external editing — all
    // through the live KeybindingsManager, exactly as in the main chat.
    field.focused = true;
    field.handleInput(data);
    if (editing && mode === "answer") answerFocusPending = true;
    invalidate();
  }

  function matchesPopupScroll(data: string, direction: "up" | "down"): boolean {
    const nativeBinding = direction === "up" ? "tui.editor.pageUp" : "tui.editor.pageDown";
    if (keybindings.matches(data, nativeBinding)) return true;
    const keyIds = direction === "up" ? SCROLL_PAGE_UP_KEYS : SCROLL_PAGE_DOWN_KEYS;
    return keyIds.some((keyId) => matchesHostKey(data, keyId));
  }

  function matchesHostKey(data: string, keyId: string): boolean {
    try {
      return typeof tuiHost?.matchesKey === "function" && tuiHost.matchesKey(data, keyId);
    } catch {
      return false;
    }
  }

  function matchesShortcut(data: string): boolean {
    return matchesHostKey(data, QUESTION_LIST_SHORTCUT_KEY);
  }

  /** Live idle probe for async delivery; the UI carries no session state of its own. */
  function sourceProbe(): { isIdle?: () => boolean } | undefined {
    return activeSourceProbe;
  }

  const handleInput = (data: string) => {
    if (closed) return;
    if (isStale()) {
      close(); // A rebound session's UI never acts on input.
      return;
    }
    // Reserve the open/close chord before page movement or list navigation;
    // even a user binding that overlaps it must not turn it into scrolling.
    if (matchesShortcut(data)) {
      close();
      return;
    }
    if (!editing && matchesPopupScroll(data, "up")) {
      if (nativeScrollView && nativeScrollView.viewportHeight > 0) scrollNativeBy(-pageStep());
      else manualScrollOffset = Math.max(0, manualScrollOffset - pageStep());
      if (mode === "answer") answerFocusPending = false;
      if (mode === "list") listFocusPending = false;
      options.requestRender?.();
      return;
    }
    if (!editing && matchesPopupScroll(data, "down")) {
      if (nativeScrollView && nativeScrollView.viewportHeight > 0) scrollNativeBy(pageStep());
      else manualScrollOffset += pageStep();
      if (mode === "answer") answerFocusPending = false;
      if (mode === "list") listFocusPending = false;
      options.requestRender?.();
      return;
    }
    if (mode === "list") handleListInput(data);
    else if (mode === "answer") handleAnswerInput(data);
    else handleNoticeInput(data);
  };

  const renderContent = (width: number): string[] => {
    if (lastRenderedWidth !== undefined && lastRenderedWidth !== width && mode === "answer") {
      answerFocusPending = true;
    }
    if (lastRenderedWidth !== undefined && lastRenderedWidth !== width && mode === "list") {
      listFocusPending = true;
    }
    lastRenderedWidth = width;
    if (isStale()) {
      // The session rebound while this UI was open or opening: close without
      // submitting; the new session presents its own questions through its
      // own press. Never display another session's questions here — even if
      // a stale input or settle callback already closed this component (its
      // close cleared the cache, so the check must not depend on !closed).
      close();
      return [theme.fg("dim", "Session changed; question list closed.")];
    }
    if (closed) return []; // A closed component never renders live controller state.
    if (cachedContent?.width === width) return cachedContent.lines;
    const rawLines = mode === "list"
      ? renderList(width)
      : mode === "answer"
        ? renderAnswer(width)
        : renderNotice(width);
    const lineCounts: number[] = [];
    const lines = rawLines.flatMap((line) => {
      const fitted = visibleWidth(line) <= width ? [line] : wrapNoticeLine(line, width);
      lineCounts.push(fitted.length);
      return fitted;
    });
    if (lineCounts.some((count) => count !== 1)) {
      listViewportFocus = remapViewportFocus(listViewportFocus, lineCounts);
      answerViewportFocus = remapViewportFocus(answerViewportFocus, lineCounts);
    }
    cachedContent = { width, lines };
    return lines;
  };

  function remapViewportFocus(
    focus: { start: number; end: number; anchor: number } | undefined,
    lineCounts: readonly number[],
  ): { start: number; end: number; anchor: number } | undefined {
    if (!focus) return undefined;
    const offset = (line: number): number => lineCounts.slice(0, Math.max(0, line)).reduce((sum, count) => sum + count, 0);
    const start = offset(focus.start);
    const end = Math.max(start, offset(focus.end + 1) - 1);
    const anchor = Math.min(end, offset(focus.anchor));
    return { start, end, anchor };
  }

  /**
   * The frame has full-width top and bottom rules only; content rows keep one
   * opaque padding cell on each side when the width allows, so the body gains
   * the columns side borders would otherwise occupy.
   */
  function popupContentWidth(width: number): number {
    const boundedWidth = Math.max(1, Math.floor(width));
    const paddingCells = boundedWidth >= 3 ? POPUP_HORIZONTAL_PADDING * 2 : 0;
    return Math.max(1, boundedWidth - paddingCells);
  }

  function popupContentRows(height: number): number {
    const boundedHeight = Math.max(1, Math.floor(height));
    const borderRows = boundedHeight >= 2 ? 2 : 1;
    const paddingRows = boundedHeight >= 4 ? POPUP_VERTICAL_PADDING * 2 : 0;
    return Math.max(0, boundedHeight - borderRows - paddingRows);
  }

  function framePopup(content: readonly string[], width: number, maxHeight?: number): string[] {
    const boundedWidth = Math.max(1, Math.floor(width));
    const padding = boundedWidth >= 3 ? POPUP_HORIZONTAL_PADDING : 0;
    const innerWidth = popupContentWidth(boundedWidth);
    const framedContent = content.flatMap((line) =>
      visibleWidth(line) <= innerWidth ? [line] : wrapNoticeLine(line, innerWidth));
    const height = maxHeight === undefined ? undefined : Math.max(1, Math.floor(maxHeight));
    const verticalPadding = height === undefined || height >= 4 ? POPUP_VERTICAL_PADDING : 0;
    const contentLimit = height === undefined ? Number.POSITIVE_INFINITY : popupContentRows(height);
    const visible = framedContent.slice(0, contentLimit);
    const rule = opaquePopupLine(theme.fg("borderMuted", "─".repeat(boundedWidth)));
    const row = (line: string): string => {
      const inner = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      return opaquePopupLine(" ".repeat(padding) + inner + " ".repeat(padding));
    };

    if (height === 1) return [rule];
    if (height === 2) return [rule, rule];
    const output = [rule];
    if (verticalPadding > 0) output.push(row(""));
    for (const line of visible) output.push(row(line));
    if (verticalPadding > 0) output.push(row(""));
    output.push(rule);
    return height === undefined ? output : output.slice(0, height);
  }

  /**
   * Fill every rendered cell with Pi's native custom-message surface. Reopen
   * the background after full SGR resets in nested foreground styling so the
   * frame rules and side padding remain opaque as well as the text itself.
   */
  function opaquePopupLine(line: string): string {
    const bg = theme.bg;
    if (typeof bg !== "function") return line;
    const parts = line.split(POPUP_BACKGROUND_FULL_RESET_SPLIT);
    if (parts.length === 1) return bg("customMessageBg", line);
    let output = "";
    for (const part of parts) {
      if (part === "\x1b[0m" || part === "\x1b[m" || part === "\x1b[49m") {
        output += part;
      } else if (part.length > 0) {
        output += bg("customMessageBg", part);
      }
    }
    return output;
  }

  const renderFallback = (width: number): string[] => {
    if (closed) return [];
    const height = options.getViewportRows ? viewportRows() : undefined;
    const contentWidth = popupContentWidth(width);
    const lines = renderContent(contentWidth);
    if (height === undefined) return framePopup(lines, width);
    const contentHeight = popupContentRows(height);
    manualScrollOffset = Math.min(Math.max(0, manualScrollOffset), Math.max(0, lines.length - contentHeight));
    if (contentHeight > 0
      && ((mode === "answer" && (answerFocusPending || editing)) || (mode === "list" && listFocusPending))) {
      manualScrollOffset = offsetForAnswerFocus(
        manualScrollOffset,
        contentHeight,
        lines.length,
        mode === "list" ? listViewportFocus : answerViewportFocus,
      );
      answerFocusPending = false;
      listFocusPending = false;
    }
    return framePopup(lines.slice(manualScrollOffset, manualScrollOffset + contentHeight), width, height);
  };

  const renderNativeScrollView = (width: number): string[] => {
    if (closed) return [];
    const scrollView = nativeScrollView!;
    const height = scrollView.viewportHeight;
    if (height <= 0) {
      lastNativeViewportHeight = 0;
      return renderFallback(width);
    }
    const contentWidth = popupContentWidth(width);
    const lines = renderContent(contentWidth);
    const outerHeight = Math.max(1, Math.floor(height));
    const contentHeight = popupContentRows(outerHeight);
    if (lastNativeViewportHeight !== height && mode === "list") listFocusPending = true;
    if (lastNativeViewportHeight <= 0) {
      scrollView.scrollToStart();
      manualScrollOffset = 0;
      if (mode === "answer") answerFocusPending = true;
    } else if (lastNativeViewportHeight !== height && mode === "answer") {
      answerFocusPending = true;
    }
    lastNativeViewportHeight = height;
    manualScrollOffset = Math.min(Math.max(0, manualScrollOffset), Math.max(0, lines.length - contentHeight));
    if (contentHeight > 0
      && ((mode === "answer" && (answerFocusPending || editing)) || (mode === "list" && listFocusPending))) {
      const desiredOffset = offsetForAnswerFocus(
        manualScrollOffset,
        contentHeight,
        lines.length,
        mode === "list" ? listViewportFocus : answerViewportFocus,
      );
      const delta = desiredOffset - manualScrollOffset;
      if (delta !== 0) scrollNativeBy(delta);
      answerFocusPending = false;
      listFocusPending = false;
    }
    return framePopup(scrollView.render(contentWidth).slice(0, contentHeight), width, outerHeight);
  };

  function scrollNativeBy(amount: number): void {
    const scrollView = nativeScrollView;
    if (!scrollView || scrollView.viewportHeight <= 0) return;
    scrollView.scrollBy(amount);
    const lineCount = cachedContent?.lines.length;
    const height = popupContentRows(scrollView.viewportHeight);
    const maximum = lineCount === undefined ? Number.POSITIVE_INFINITY : Math.max(0, lineCount - height);
    manualScrollOffset = Math.min(Math.max(0, manualScrollOffset + amount), maximum);
  }

  function offsetForAnswerFocus(
    currentOffset: number,
    height: number,
    lineCount: number,
    focus = answerViewportFocus,
  ): number {
    const maximum = Math.max(0, lineCount - height);
    let offset = Math.min(Math.max(0, currentOffset), maximum);
    if (!focus || lineCount === 0) return offset;

    let start = Math.min(Math.max(0, focus.start), lineCount - 1);
    let end = Math.min(Math.max(start, focus.end), lineCount - 1);
    const anchor = Math.min(Math.max(start, focus.anchor), end);
    if (end - start + 1 > height) start = end = anchor;
    if (start < offset) offset = start;
    else if (end >= offset + height) offset = end - height + 1;
    return Math.min(Math.max(0, offset), maximum);
  }

  /**
   * Locate the active row from the public Editor cursor and text APIs. The
   * editor box can be taller than this overlay (especially with completions),
   * so anchoring to its last rendered row can hide a cursor at the top.
   */
  function nativeFieldCursorBoxRow(field: FieldEditorInstance, editorWidth: number, boxLineCount: number): number {
    const fallbackRow = Math.max(0, boxLineCount - 2);
    try {
      const cursor = field.getCursor?.();
      const sourceLines = field.getLines?.();
      if (!cursor || !Array.isArray(sourceLines) || sourceLines.length === 0
        || !Number.isFinite(cursor.line) || !Number.isFinite(cursor.col)) return fallbackRow;

      const reportedPadding = field.getPaddingX?.() ?? 0;
      const maxPadding = Math.max(0, Math.floor((editorWidth - 1) / 2));
      const padding = Math.min(maxPadding, Math.max(0, Math.floor(reportedPadding)));
      const contentWidth = Math.max(1, editorWidth - padding * 2);
      // The public Editor reserves one cell for its cursor when horizontal
      // padding is zero; with padding, its layout uses the full content width.
      const layoutWidth = Math.max(1, contentWidth - (padding === 0 ? 1 : 0));
      const cursorLine = Math.min(sourceLines.length - 1, Math.max(0, Math.floor(cursor.line)));
      let visualRow = 0;
      for (let index = 0; index < cursorLine; index += 1) {
        const source = sourceLines[index] ?? "";
        const chunks = tuiHost?.wrapEditorLine?.(source, layoutWidth);
        visualRow += chunks?.length ?? wrapLine(source, layoutWidth).length;
      }
      const line = sourceLines[cursorLine] ?? "";
      const cursorColumn = Math.min(line.length, Math.max(0, Math.floor(cursor.col)));
      const chunks = tuiHost?.wrapEditorLine?.(line, layoutWidth);
      if (chunks?.length) {
        const cursorChunk = chunks.findIndex((chunk, index) =>
          cursorColumn >= chunk.startIndex
          && (index === chunks.length - 1 || cursorColumn < chunk.endIndex));
        visualRow += Math.max(0, cursorChunk);
      } else {
        visualRow += Math.max(0, wrapLine(line.slice(0, cursorColumn), layoutWidth).length - 1);
      }
      // Convert the absolute visual row to this rendered box's coordinates.
      // The public protected border hook reports its hidden text prefix.
      const hiddenRows = field.getRenderedHiddenLineCount?.() ?? 0;
      return Math.min(Math.max(1, 1 + visualRow - hiddenRows), fallbackRow);
    } catch {
      return fallbackRow;
    }
  }

  function renderList(width: number): string[] {
    listViewportFocus = undefined;
    const pending = pendingNow();
    const lines: string[] = [];
    if (pending.length === 0) {
      lines.push(theme.fg("dim", "No pending input."));
      return lines;
    }
    const selection = currentListSelection() ?? undefined;
    const hasNotice = pending.some(isNotice);
    const hasQuestion = pending.some((record) => !isNotice(record));
    const header = theme.bold(`Pending input (${pending.length})`)
      + theme.fg("dim", ` · ${shortcutLabel} to close`);
    for (const line of wrapLine(header, width)) lines.push(line);
    lines.push("");
    for (const record of pending) {
      const rowStart = lines.length;
      const prefix = record.id === selection ? theme.fg("accent", "> ") : "  ";
      const tag = isNotice(record)
        ? theme.fg("muted", " [notice]")
        : record.mode === "sync" ? theme.fg("warning", " [waiting]") : "";
      const label = isNotice(record) ? visibleTerminalText(record.title) : safeMarkdownDisplaySource(record.question);
      const text = `${record.id}: ${label}` + tag;
      const first = wrapLine(text, Math.max(1, width - visibleWidth(prefix)));
      lines.push(prefix + first[0]!);
      for (const rest of first.slice(1)) {
        lines.push(" ".repeat(visibleWidth(prefix)) + rest);
      }
      if (record.id === selection) {
        listViewportFocus = { start: rowStart, end: rowStart, anchor: rowStart };
      }
    }
    lines.push("");
    lines.push(theme.fg("dim", hasNotice
      ? `arrows select · Enter ${hasQuestion ? "open question/notice" : "open notice"} · ${POPUP_SCROLL_HINT} · Esc defer and close`
      : `arrows select · Enter answer · ${POPUP_SCROLL_HINT} · Esc defer and close`));
    return lines;
  }

  function renderAnswer(width: number): string[] {
    answerViewportFocus = undefined;
    const record = selectedId ? controller.get(selectedId) : undefined;
    if (!record) {
      // Defensive: the question vanished (stale state); leave on next key.
      answerViewportFocus = { start: 0, end: 0, anchor: 0 };
      return [theme.fg("dim", "This question is no longer pending.")];
    }
    const rows = answerRows();
    const lines: string[] = [];
    const question = renderMarkdown(record.question, width);
    lines.push(theme.bold(`${record.id}:`));
    if (!question.native) {
      lines.push(...wrapLine(theme.fg("warning", "Native Markdown unavailable; showing the complete question as plain text."), width));
      lines.push("");
    }
    lines.push(...question.lines);
    lines.push("");
    rows.forEach((row, index) => {
      const selected = index === answerIndex;
      const rowStart = lines.length;
      if (row === TYPE_ROW && editing && options.nativeField) {
        // The native editor renders its own bordered box; indent it like the
        // other rows. Every line is padded to the box width, so each total
        // line stays within `width`. Focus follows its public cursor location,
        // never a parsed terminal cursor-marker escape.
        const editorWidth = Math.max(1, width - 2);
        const box = options.nativeField.renderForPopup?.(editorWidth)
          ?? options.nativeField.render(editorWidth);
        lines.push(`  ${box[0] ?? ""}`);
        for (const rest of box.slice(1)) lines.push(`  ${rest}`);
        if (selected) {
          const cursorRow = rowStart + nativeFieldCursorBoxRow(options.nativeField, editorWidth, box.length);
          answerViewportFocus = {
            start: cursorRow,
            end: Math.max(cursorRow, rowStart + box.length - 1),
            anchor: cursorRow,
          };
        }
        return;
      }
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      let text: string;
      if (row === TYPE_ROW) {
        text = options.nativeField
          ? theme.fg("muted", "Type something…")
          : theme.fg("dim", "Free text unavailable — the host's native editor is unavailable for safe popup editing; choices and Decline still work");
      } else if (row === DECLINE_ROW) {
        text = theme.fg("warning", "Decline (no answer will be sent)");
      } else {
        // Choice labels are plain text, not Markdown. Apply only the existing
        // reversible display encoding; the original stored label is still
        // submitted unchanged when selected.
        text = `${index + 1}. ${visibleTerminalText(row)}`;
      }
      const wrapped = wrapLine(text, Math.max(1, width - visibleWidth(prefix)));
      lines.push(prefix + wrapped[0]!);
      for (const rest of wrapped.slice(1)) {
        lines.push(" ".repeat(visibleWidth(prefix)) + rest);
      }
      if (selected) {
        answerViewportFocus = { start: rowStart, end: lines.length - 1, anchor: rowStart };
      }
    });
    lines.push("");
    lines.push(theme.fg("dim", editing
      ? "Enter submit · Esc back to options"
      : `arrows select · Enter confirm · ${POPUP_SCROLL_HINT} · Esc back`));
    return lines;
  }

  function renderNotice(width: number): string[] {
    const record = selectedId ? controller.getPending(selectedId) : undefined;
    if (!record || !isNotice(record)) return [theme.fg("dim", "This notice is no longer pending.")];
    const body = renderMarkdown(record.body, width);
    const context = record.context === undefined ? undefined : renderMarkdown(record.context, width);
    const hasPlainFallback = !body.native || (context !== undefined && !context.native);
    const bodyLines = hasPlainFallback ? renderPlainText(visibleTerminalText(record.body), width) : body.lines;
    const contextLines = hasPlainFallback && record.context !== undefined
      ? renderPlainText(visibleTerminalText(record.context), width)
      : context?.lines ?? [];
    const lines = [...wrapNoticeLine(theme.bold(`${record.id}: ${visibleTerminalText(record.title)}`), width), ""];
    if (hasPlainFallback) {
      lines.push(
        ...wrapNoticeLine(theme.fg("warning", "Native Markdown unavailable; showing the complete notice as plain text."), width),
        "",
      );
    }
    lines.push(...bodyLines);
    if (record.context !== undefined) {
      lines.push("", ...wrapNoticeLine(theme.bold("Relevant context"), width), ...contextLines);
    }
    lines.push("");
    noticeRows().forEach((row, index) => {
      appendNoticeAction(lines, row === NOTICE_MORE_DETAILS ? "More details" : "Close", index === noticeActionIndex, width);
    });
    lines.push("");
    lines.push(...wrapNoticeLine(theme.fg("dim", `arrows select · Enter choose · ${POPUP_SCROLL_HINT} · Esc back`), width));
    return lines;
  }

  function viewportRows(): number {
    let rows: number | undefined;
    try {
      rows = options.getViewportRows?.();
    } catch {
      rows = undefined;
    }
    const resolved = typeof rows === "number" && Number.isFinite(rows) && rows > 0
      ? Math.max(1, Math.floor(rows))
      : 1;
    if (lastViewportRows !== undefined && lastViewportRows !== resolved && mode === "answer") {
      answerFocusPending = true;
      // The host editor sizes its own text viewport from terminal rows. Rebuild
      // its rendered box before applying the resized popup's focus offset.
      cachedContent = undefined;
    }
    lastViewportRows = resolved;
    if (mode === "list" && lastListViewportRows !== resolved) listFocusPending = true;
    lastListViewportRows = resolved;
    return resolved;
  }

  function pageStep(): number {
    const nativeHeight = nativeScrollView?.viewportHeight;
    // The custom overlay uses the owned manual viewport, so no measured
    // ScrollView height is available. Advance one line rather than skipping
    // unseen content with a terminal-sized page. A layout-backed view pages
    // only its inner content area, excluding the popup rules and padding.
    if (nativeHeight === undefined || nativeHeight <= 0) return 1;
    return Math.max(1, popupContentRows(nativeHeight) - 1);
  }

  function resetScroll(): void {
    manualScrollOffset = 0;
    answerViewportFocus = undefined;
    answerFocusPending = false;
    listFocusPending = true;
    nativeScrollView?.scrollToStart();
  }

  function renderMarkdown(source: string, width: number): RenderedMarkdown {
    let component = markdownComponents.get(source);
    if (component === undefined) {
      try {
        component = tuiHost?.createMarkdown?.(safeMarkdownDisplaySource(source)) ?? null;
      } catch {
        component = null;
      }
      markdownComponents.set(source, component);
    }
    if (component) {
      try {
        const rendered = component.render(Math.max(1, width));
        if (Array.isArray(rendered) && rendered.every((line) => typeof line === "string")) {
          return { lines: rendered, native: true };
        }
      } catch {
        // The shared question/notice view discloses the complete plain-text
        // fallback below.
      }
    }
    return {
      lines: renderPlainText(visibleTerminalText(source), width),
      native: false,
    };
  }

  function renderPlainText(source: string, width: number): string[] {
    return source.split("\n").flatMap((line) => wrapPlainTextLine(line, width));
  }

  // ------------------------------------------------------------------
  // Width-safe text helpers (host pi-tui when loadable, grapheme fallback)
  // ------------------------------------------------------------------

  function visibleWidth(text: string): number {
    if (typeof tuiHost?.visibleWidth === "function") return tuiHost.visibleWidth(text);
    return naiveVisibleWidth(text);
  }

  function wrapLine(text: string, width: number): string[] {
    const bounded = Math.max(1, Math.floor(width));
    if (typeof tuiHost?.wrapTextWithAnsi === "function") {
      const wrapped = tuiHost.wrapTextWithAnsi(text, bounded);
      return wrapped.length > 0 ? wrapped : [""];
    }
    const plain = stripAnsi(text);
    if (naiveVisibleWidth(plain) <= bounded) return [text];
    const words = plain.split(/(\s+)/).filter((part) => part.length > 0);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
        continue;
      }
      if (naiveVisibleWidth(current + word) <= bounded) {
        current += word;
        continue;
      }
      lines.push(current);
      current = /^\s+$/.test(word) ? "" : word;
    }
    if (current.length > 0) lines.push(current);
    return lines.length > 0 ? lines : [""];
  }

  /** Wrap complete notice fallback text without parsing Markdown or dropping characters. */
  function wrapPlainTextLine(text: string, width: number): string[] {
    const bounded = Math.max(1, Math.floor(width));
    const tokens = text.match(/\s+|\S+/gu) ?? [];
    const lines: string[] = [];
    let current = "";
    let currentWidth = 0;
    for (const token of tokens) {
      const tokenWidth = visibleWidth(token);
      if (tokenWidth <= bounded) {
        if (currentWidth > 0 && currentWidth + tokenWidth > bounded) {
          lines.push(current);
          current = "";
          currentWidth = 0;
        }
        current += token;
        currentWidth += tokenWidth;
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      for (const grapheme of graphemeSegments(token)) {
        const graphemeWidth = visibleWidth(grapheme);
        if (current.length > 0 && currentWidth + graphemeWidth > bounded) {
          lines.push(current);
          current = "";
          currentWidth = 0;
        }
        current += grapheme;
        currentWidth += graphemeWidth;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines.length > 0 ? lines : [""];
  }

  function wrapNoticeLine(text: string, width: number): string[] {
    const bounded = Math.max(1, Math.floor(width));
    if (typeof tuiHost?.wrapTextWithAnsi === "function") {
      const wrapped = tuiHost.wrapTextWithAnsi(text, bounded);
      if (wrapped.length > 0 && wrapped.every((line) => visibleWidth(line) <= bounded)) return wrapped;
    }
    // Plain fallback loses ANSI styling rather than risking malformed escape
    // sequences; host column helpers still measure emoji and combining marks.
    return wrapPlainTextLine(stripAnsi(text), bounded);
  }

  function appendNoticeAction(lines: string[], label: string, selected: boolean, width: number): void {
    if (width < 3) {
      if (selected) lines.push(theme.fg("accent", ">"));
      lines.push(...wrapNoticeLine(label, width));
      return;
    }
    const prefix = selected ? theme.fg("accent", "> ") : "  ";
    const prefixWidth = visibleWidth(prefix);
    const wrapped = wrapNoticeLine(label, Math.max(1, width - prefixWidth));
    lines.push(prefix + wrapped[0]!);
    for (const rest of wrapped.slice(1)) lines.push(" ".repeat(prefixWidth) + rest);
  }

  function graphemeSegments(text: string): string[] {
    const intl = Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: "grapheme" },
      ) => { segment(value: string): Iterable<{ segment: string }> };
    };
    if (typeof intl.Segmenter === "function") {
      return Array.from(new intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
    }
    return Array.from(text);
  }

  function naiveVisibleWidth(text: string): number {
    let width = 0;
    for (const grapheme of graphemeSegments(stripAnsi(text))) {
      if (/^\p{Mark}+$/u.test(grapheme)) continue;
      if (/\p{Extended_Pictographic}/u.test(grapheme)) {
        width += 2;
        continue;
      }
      const base = Array.from(grapheme).find((char) => !/\p{Mark}/u.test(char) && char !== "\u200d");
      if (!base) continue;
      const code = base.codePointAt(0)!;
      if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
      width += isWideCodePoint(code) ? 2 : 1;
    }
    return width;
  }

  function isWideCodePoint(code: number): boolean {
    return (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xa000 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0x20000 && code <= 0x3fffd);
  }

  function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
  }

  function isNotice(record: PendingUserInput): record is PendingNotice {
    return "kind" in record && record.kind === "notice";
  }

  const setSourceProbe = (probe: { isIdle?: () => boolean } | undefined): void => {
    activeSourceProbe = probe;
  };

  const content: QuestionMarkdownComponent = {
    render: renderContent,
    invalidate: invalidateContent,
  };
  try {
    nativeScrollView = options.scrollable
      ? tuiHost?.createScrollView?.(content, viewportRows)
      : undefined;
  } catch {
    nativeScrollView = undefined;
  }
  if (nativeScrollView) {
    invalidateNativeScrollView = nativeScrollView.invalidate.bind(nativeScrollView);
    return {
      render: renderNativeScrollView,
      handleInput,
      invalidate,
      setSourceProbe,
    };
  }
  return {
    render: renderFallback,
    handleInput,
    invalidate,
    setSourceProbe,
  };
}
