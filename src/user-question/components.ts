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
 * Shared viewport (issue #413): one authoritative scroll offset per open
 * mode. All body content — question/notice text, context, choices, Type,
 * Decline, and actions — scrolls together; only the keyboard hint is laid out
 * in a fixed area below it, so it stays visible (tight budgets fall back to
 * a compact or truncated hint and drop the blank padding rows first; below
 * three rows the rules give way to content, and a one-row content budget keeps
 * only the body). Opening a
 * question or notice starts at its beginning; Up/Down (even at a bound) and
 * editing input bring the selected row or native cursor into view; keyboard
 * paging moves only the offset. Resize clamps the offset to the new bounds
 * and re-reveals only the list selection or an active editing cursor. The
 * popup keeps its content-sized height up to the overlay's row budget.
 * Scrolling is keyboard-only: wheel events are never handled here, so Pi and
 * the terminal keep their native wheel behavior.
 *
 * Fullscreen pointer input (#431): the public custom overlay hands this
 * component to pi-tui directly, so pointer events arrive in coordinates local
 * to the last frame it returned. The same render pass that lays out that
 * frame maps every drawn row of a list row, answer choice, Type something,
 * Decline, or notice action back to the exact controller record it showed —
 * through content wrapping, the authoritative scroll offset's body slice, the
 * fixed hint area (never an item), and the padded/ruled or tiny unruled
 * framing — covering only the row's drawn prefix and text. A left press
 * highlights that item without moving the viewport or reflowing rows (while
 * editing, or for notice actions narrower than three cells, a transient
 * highlight leaves the selection untouched); the completed
 * native click on the same live item, in a frame with unchanged bounds,
 * viewport budget, and live terminal size, runs the item's existing confirm
 * action, exactly as Enter on that selection would. A menu click while
 * editing first leaves editing with the draft kept; the editor box is not a
 * menu entry and never submits by pointer. Every non-wheel pointer event
 * inside the popup is consumed, keyboard input cancels a pending gesture, and
 * a closed popup intercepts nothing. Regular mode delivers no pointer input.
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
import type { QuestionMarkdownComponent, QuestionTuiHost } from "./pi-tui-host";
import type { PendingNotice, PendingQuestion, PendingUserInput, SubmitResult, UserQuestionController } from "./controller";

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
  /**
   * Row budget matching the custom overlay's public maxHeight: the framed
   * popup's rules, padding, scrolled body, and fixed hint area.
   */
  getViewportRows?: () => number | undefined;
  /**
   * Live terminal dimensions. The host only schedules a redraw on resize, so
   * a pointer gesture can complete before the popup's geometry is redrawn;
   * each published frame snapshots this probe and a gesture is rejected when
   * the live size no longer matches. Undefined (or a throwing probe) means
   * the size is unknown, which never matches a known snapshot.
   */
  getTerminalSize?: () => { columns: number; rows: number } | undefined;
  /** Invalidate the live TUI after component/controller state changes. */
  requestRender?: () => void;
  onDone: (result: QuestionListDone) => void;
}

/**
 * Structural subset of pi-tui's normalized fullscreen mouse event. The public
 * custom overlay passes this component to the host compositor directly, so
 * `x`/`y` are local to its last drawn frame and `width`/`height` are that
 * frame's composited bounds (or, while a gesture is active, the bounds
 * captured when its press was dispatched).
 */
export interface QuestionMouseEvent {
  type: "press" | "release" | "move" | "drag" | "click" | "wheel";
  button: "left" | "middle" | "right" | "none";
  x: number;
  y: number;
  width: number;
  height: number;
  screenX?: number;
  screenY?: number;
  /** Ignored: like the native SelectList, every completed click is one activation. */
  clickCount?: number;
}

/** Structural subset of pi-tui's mouse handler result. */
export interface QuestionMouseResult {
  handled?: boolean;
  render?: boolean;
}

export interface QuestionListComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  /**
   * Fullscreen pointer input. A left press highlights a visible menu item; a
   * completed left click on the same live item runs that item's existing
   * confirm action. Non-wheel pointer events inside the popup are consumed so
   * nothing reaches the background; wheel events are left to the host.
   */
  handleMouse(event: QuestionMouseEvent): QuestionMouseResult | undefined;
  invalidate(): void;
  /** Installs the live idle probe used for async answer delivery. */
  setSourceProbe(probe: { isIdle?: () => boolean } | undefined): void;
}

/** One actionable popup item, bound to the exact controller record it rendered. */
type PopupItemRef =
  | { kind: "list"; record: PendingUserInput }
  | { kind: "answer"; record: PendingQuestion; row: number }
  | { kind: "notice"; record: PendingNotice; action: number };

/** The drawn cells of one item on one frame row (local columns, end exclusive). */
interface PopupFrameRow {
  ref: PopupItemRef;
  start: number;
  end: number;
}

/** Item geometry of the frame most recently returned to the host compositor. */
interface PopupFrame {
  width: number;
  height: number;
  viewportRows: number | undefined;
  /** Live terminal size when this frame was produced ("unprobed" without a probe). */
  terminal: string;
  rows: ReadonlyArray<PopupFrameRow | undefined>;
}

interface RenderedMarkdown {
  lines: string[];
  native: boolean;
}

interface ViewportFocus {
  start: number;
  end: number;
  anchor: number;
}

/** Scrollable body lines plus the plain-text keyboard hint kept outside them. */
interface PopupContent {
  lines: string[];
  /** The item that drew each body line (aligned with `lines`; absent means none). */
  owners?: ReadonlyArray<PopupItemRef | undefined>;
  hint?: string;
  /** Shorter hint for tight budgets: the keys needed to reach hidden content. */
  compactHint?: string;
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
  // The single authoritative viewport: the first visible body line, the
  // current mode's selected row (or native cursor) range, and whether the next
  // layout should bring that range into view. Keyboard paging moves only the
  // offset; selection/editing input requests a reveal.
  let scrollOffset = 0;
  let viewportFocus: ViewportFocus | undefined;
  let focusPending = true;
  let lastViewportRows: number | undefined;
  let lastRenderedWidth: number | undefined;
  let lastMaxScrollOffset: number | undefined;
  let editing = false;
  let closed = false;
  let cachedContent: { width: number; content: PopupContent } | undefined;
  // Item ranges recorded by the active list/answer/notice renderer, in its
  // raw line coordinates, before content wrapping, scrolling, and framing
  // remap them.
  let renderedItemRanges: Array<{ start: number; end: number; ref: PopupItemRef }> = [];
  // Mouse gesture state: the frame last returned to the compositor, the item a
  // left press resolved in it, the same press once released (consumed by the
  // native click that immediately follows a stationary release), and the
  // transient editing-mode highlight that must not move the native field focus.
  let lastFrame: PopupFrame | undefined;
  let pressedItem: { ref: PopupItemRef; frame: PopupFrame } | undefined;
  let releasedItem: { ref: PopupItemRef; frame: PopupFrame } | undefined;
  let pressHighlight: PopupItemRef | undefined;
  const markdownComponents = new Map<string, QuestionMarkdownComponent | null>();
  // The shortcut handler installs a live idle probe before the component is
  // shown; if the session rebinds while open, the stale fence closes this UI
  // before any submission can use the probe.
  let activeSourceProbe: { isIdle?: () => boolean } | undefined;

  const invalidateContent = () => {
    cachedContent = undefined;
  };

  /** Rebuild cached content; never moves the viewport by itself. */
  const invalidate = () => {
    invalidateContent();
    for (const component of markdownComponents.values()) {
      try {
        component?.invalidate();
      } catch {
        // Discard a failing Markdown instance without blocking popup refresh.
      }
    }
    markdownComponents.clear();
    options.requestRender?.();
  };

  // Live questions (registered while the list is open) must refresh the view;
  // the list keeps its live selection visible as entries come and go.
  const unsubscribeState = controller.addStateListener(() => {
    if (mode === "list") focusPending = true;
    invalidate();
  });

  const close = (result?: SubmitResult | { kind: "notice-details"; noticeId: string; expectedNotice: PendingNotice }) => {
    if (closed) return;
    closed = true;
    // A closed popup owns no pointer gesture or item geometry.
    clearMouseGesture();
    lastFrame = undefined;
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
    if (editing !== value && mode === "answer") focusPending = true;
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
      focusPending = true;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      const pending = pendingNow();
      const index = pending.findIndex((question) => question.id === currentListSelection());
      if (index >= 0 && index < pending.length - 1) selectedId = pending[index + 1]!.id;
      focusPending = true;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const id = currentListSelection();
      if (!id) return;
      const record = controller.getPending(id);
      if (!record) return;
      openPendingRecord(id, record);
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel") || matchesShortcut(data)) {
      close();
    }
  }

  /** The list confirm action: open the selected question's answer view or notice details. */
  function openPendingRecord(id: string, record: PendingUserInput): void {
    selectedId = id;
    if (isNotice(record)) {
      mode = "notice";
      noticeActionIndex = 0;
      resetScroll(); // A long notice opens at its beginning.
    } else {
      mode = "answer";
      answerIndex = 0;
      // A long question opens at its beginning; Up/Down later reveals the
      // selected row instead of jumping past the question on open.
      resetScroll();
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
  }

  /** The answer-view confirm action for one row of the selected question. */
  function confirmAnswerRow(id: string, row: string | typeof TYPE_ROW | typeof DECLINE_ROW | undefined): void {
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
  }

  /** The notice-view confirm action for More details or Close. */
  function confirmNoticeAction(id: string, record: PendingNotice, action: string | undefined): void {
    if (action === NOTICE_MORE_DETAILS) {
      // Closing first restores Pi's normal editor/transcript surface. The
      // owner then sends only after this custom interaction has resolved.
      close({ kind: "notice-details", noticeId: id, expectedNotice: record });
      return;
    }
    if (action === NOTICE_CLOSE) {
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
    // Selection movement always reveals the selected row, including a
    // boundary press that cannot move further.
    if (keybindings.matches(data, "tui.select.up")) {
      if (answerIndex > 0) answerIndex -= 1;
      focusPending = true;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (answerIndex < rows.length - 1) answerIndex += 1;
      focusPending = true;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      confirmAnswerRow(id, rows[answerIndex]);
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
      focusPending = true;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (noticeActionIndex < rows.length - 1) noticeActionIndex += 1;
      focusPending = true;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const action = rows[noticeActionIndex];
      if (action === NOTICE_MORE_DETAILS || action === NOTICE_CLOSE) {
        confirmNoticeAction(id, record, action);
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
    // Editing input keeps the native cursor row in view.
    if (editing && mode === "answer") focusPending = true;
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
    // Keyboard input ends any pointer gesture: a later click can never act on
    // a press resolved before the keyboard changed selection, mode, or scroll.
    if (clearMouseGesture()) invalidateContent();
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
    // While editing, every key (including PageUp/PageDown) belongs to the
    // native field; popup paging resumes after Esc returns to the options.
    if (!editing && matchesPopupScroll(data, "up")) {
      scrollViewportBy(-pageStep());
      options.requestRender?.();
      return;
    }
    if (!editing && matchesPopupScroll(data, "down")) {
      scrollViewportBy(pageStep());
      options.requestRender?.();
      return;
    }
    if (mode === "list") handleListInput(data);
    else if (mode === "answer") handleAnswerInput(data);
    else handleNoticeInput(data);
  };

  /** Move the viewport by whole lines within the last laid-out bounds. */
  function scrollViewportBy(amount: number): void {
    const maximum = lastMaxScrollOffset ?? Number.POSITIVE_INFINITY;
    scrollOffset = Math.min(Math.max(0, scrollOffset + amount), maximum);
    // Explicit scrolling wins over a pending reveal until the next selection
    // or editing input asks for one again.
    focusPending = false;
  }

  // ------------------------------------------------------------------
  // Fullscreen pointer input (native-style single click)
  // ------------------------------------------------------------------

  /** Drop the gesture; true when a visible transient highlight was removed. */
  function clearMouseGesture(): boolean {
    pressedItem = undefined;
    releasedItem = undefined;
    const hadHighlight = pressHighlight !== undefined;
    pressHighlight = undefined;
    return hadHighlight;
  }

  function sameItem(left: PopupItemRef, right: PopupItemRef): boolean {
    if (left.kind !== right.kind || left.record !== right.record) return false;
    if (left.kind === "answer" && right.kind === "answer") return left.row === right.row;
    if (left.kind === "notice" && right.kind === "notice") return left.action === right.action;
    return true;
  }

  /**
   * The item still exists exactly as rendered: the same controller record
   * object (never just a reused per-session ID), in the view it was drawn
   * for. The editor box replaces the type row while editing and is not a
   * menu entry, so that row is never live then.
   */
  function isLiveItem(ref: PopupItemRef): boolean {
    if (ref.kind === "list") {
      return mode === "list" && controller.getPending(ref.record.id) === ref.record;
    }
    if (selectedId !== ref.record.id || controller.getPending(ref.record.id) !== ref.record) return false;
    if (ref.kind === "notice") return mode === "notice" && noticeRows()[ref.action] !== undefined;
    if (mode !== "answer") return false;
    const row = answerRows()[ref.row];
    if (row === undefined) return false;
    return !(row === TYPE_ROW && editing);
  }

  /** Resolve the drawn item under a local cell of the last composited frame. */
  function itemAt(frame: PopupFrame | undefined, event: QuestionMouseEvent): PopupItemRef | undefined {
    if (!frame || event.width !== frame.width || event.height !== frame.height) return undefined;
    const { x, y } = event;
    if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= frame.height || x < 0 || x >= frame.width) {
      return undefined;
    }
    const row = frame.rows[y];
    return row && x >= row.start && x < row.end ? row.ref : undefined;
  }

  /** Same bounds, viewport budget, and terminal: the compositor placed both frames at one origin. */
  function sameGeometry(left: PopupFrame, right: PopupFrame): boolean {
    return left.width === right.width && left.height === right.height && left.viewportRows === right.viewportRows
      && left.terminal === right.terminal;
  }

  /** Press feedback: move the existing selection, never the viewport. */
  function highlightItem(ref: PopupItemRef): void {
    if (ref.kind === "answer" && editing) {
      // The native field keeps its selection, focus, and draft while the
      // pointer is down; only the pressed menu row shows as highlighted.
      pressHighlight = ref;
      invalidateContent();
      return;
    }
    if (ref.kind === "notice" && lastRenderedWidth !== undefined && lastRenderedWidth < 3) {
      // Below three content cells the selected notice action draws its marker
      // on a row of its own, so moving the selection would reflow the wrapped
      // actions under the pointer. The press shows a layout-neutral transient
      // highlight instead; the completed click still selects and confirms.
      pressHighlight = ref;
      invalidateContent();
      return;
    }
    // A press never scrolls or reveals: the item under the pointer must stay
    // put until the click that completes it, so the single authoritative
    // offset and any pending reveal are left exactly as they were.
    const keepFocusPending = focusPending;
    if (ref.kind === "list") selectedId = ref.record.id;
    else if (ref.kind === "answer") answerIndex = ref.row;
    else noticeActionIndex = ref.action;
    invalidate();
    focusPending = keepFocusPending;
  }

  /** Run the item's existing confirm action, exactly as Enter on that selection. */
  function activateItem(ref: PopupItemRef): void {
    if (ref.kind === "list") {
      openPendingRecord(ref.record.id, ref.record);
      return;
    }
    if (ref.kind === "notice") {
      noticeActionIndex = ref.action;
      confirmNoticeAction(ref.record.id, ref.record, noticeRows()[ref.action]);
      return;
    }
    // A visible choice/Decline clicked while editing first leaves editing
    // with the draft kept (as Escape does); the draft is never submitted.
    if (editing) endEditingEpisode();
    answerIndex = ref.row;
    confirmAnswerRow(ref.record.id, answerRows()[ref.row]);
  }

  const handleMouse = (event: QuestionMouseEvent): QuestionMouseResult | undefined => {
    // A closed popup intercepts nothing: ordinary routing resumes at once.
    if (closed || typeof event !== "object" || event === null) return undefined;
    // Scrolling is keyboard-only: the wheel keeps Pi's native behavior.
    if (event.type === "wheel") return undefined;
    if (event.type !== "press" && event.type !== "release" && event.type !== "click"
      && event.type !== "move" && event.type !== "drag") return undefined;
    if (isStale()) {
      close(); // A rebound session's popup never acts on pointer input.
      return { handled: true };
    }
    if (event.type === "press") {
      const hadHighlight = clearMouseGesture();
      if (hadHighlight) invalidateContent();
      // A resize that has not been redrawn yet invalidates every drawn cell.
      const frame = lastFrame && frameIsCurrent(lastFrame) ? lastFrame : undefined;
      const ref = event.button === "left" ? itemAt(frame, event) : undefined;
      if (!ref || !frame || !isLiveItem(ref)) return { handled: true, render: hadHighlight };
      pressedItem = { ref, frame };
      highlightItem(ref);
      return { handled: true, render: true };
    }
    if (event.type === "release") {
      releasedItem = event.button === "left" ? pressedItem : undefined;
      pressedItem = undefined;
      const hadHighlight = pressHighlight !== undefined;
      pressHighlight = undefined;
      if (hadHighlight) invalidateContent();
      return { handled: true, render: hadHighlight };
    }
    if (event.type === "click") {
      const candidate = releasedItem;
      releasedItem = undefined;
      // Only a stationary left press-release on one live item activates; the
      // click count is ignored like the native SelectList. The release/click
      // carry press-time bounds; a resize since then (even one the host has
      // not redrawn yet) leaves no trustworthy geometry.
      if (event.button !== "left" || !candidate || !lastFrame || !sameGeometry(lastFrame, candidate.frame)
        || !frameIsCurrent(lastFrame)) {
        return { handled: true, render: false };
      }
      const ref = itemAt(lastFrame, event);
      if (!ref || !sameItem(ref, candidate.ref) || !isLiveItem(ref)) return { handled: true, render: false };
      activateItem(ref);
      return { handled: true, render: true };
    }
    // Pointer motion inside the popup never reaches the background.
    return { handled: true, render: false };
  };

  const renderContent = (width: number): PopupContent => {
    if (lastRenderedWidth !== undefined && lastRenderedWidth !== width && (mode === "list" || editing)) {
      focusPending = true;
    }
    lastRenderedWidth = width;
    if (isStale()) {
      // The session rebound while this UI was open or opening: close without
      // submitting; the new session presents its own questions through its
      // own press. Never display another session's questions here — even if
      // a stale input or settle callback already closed this component (its
      // close cleared the cache, so the check must not depend on !closed).
      close();
      return { lines: [theme.fg("dim", "Session changed; question list closed.")] };
    }
    if (closed) return { lines: [] }; // A closed component never renders live controller state.
    if (cachedContent?.width === width) return cachedContent.content;
    renderedItemRanges = [];
    const raw = mode === "list"
      ? renderList(width)
      : mode === "answer"
        ? renderAnswer(width)
        : renderNotice(width);
    const rawOwners: Array<PopupItemRef | undefined> = raw.lines.map(() => undefined);
    for (const range of renderedItemRanges) {
      for (let line = range.start; line < range.end && line < rawOwners.length; line += 1) rawOwners[line] = range.ref;
    }
    renderedItemRanges = [];
    const lineCounts: number[] = [];
    const owners: Array<PopupItemRef | undefined> = [];
    const lines = raw.lines.flatMap((line, index) => {
      const fitted = visibleWidth(line) <= width ? [line] : wrapNoticeLine(line, width);
      lineCounts.push(fitted.length);
      for (let count = 0; count < fitted.length; count += 1) owners.push(rawOwners[index]);
      return fitted;
    });
    if (lineCounts.some((count) => count !== 1)) viewportFocus = remapViewportFocus(viewportFocus, lineCounts);
    const content = { lines, owners, hint: raw.hint, compactHint: raw.compactHint };
    cachedContent = { width, content };
    return content;
  };

  function remapViewportFocus(
    focus: ViewportFocus | undefined,
    lineCounts: readonly number[],
  ): ViewportFocus | undefined {
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

  function popupContentRows(height: number, padded = true, ruled = true): number {
    const boundedHeight = Math.max(1, Math.floor(height));
    const borderRows = !ruled ? 0 : boundedHeight >= 2 ? 2 : 1;
    const paddingRows = padded && boundedHeight >= 4 ? POPUP_VERTICAL_PADDING * 2 : 0;
    return Math.max(0, boundedHeight - borderRows - paddingRows);
  }

  /**
   * Frame content rows and, in the same pass, map every drawn row back to the
   * item that rendered it. A row's hit cells are exactly its drawn prefix and
   * text inside the side padding; rules, padding rows, side padding, trailing
   * blank cells, and rows without an owner (the fixed hint area, headings,
   * body text) belong to no item.
   *
   * `ruled: false` renders the padded content rows without the top and bottom
   * rules: below three rows the decorative rules give way to content.
   */
  function framePopup(
    content: readonly string[],
    width: number,
    maxHeight?: number,
    padded = true,
    ruled = true,
    owners: ReadonlyArray<PopupItemRef | undefined> = [],
  ): { lines: string[]; rows: Array<PopupFrameRow | undefined> } {
    const boundedWidth = Math.max(1, Math.floor(width));
    const padding = boundedWidth >= 3 ? POPUP_HORIZONTAL_PADDING : 0;
    const innerWidth = popupContentWidth(boundedWidth);
    const framedContent = content.flatMap((line, index) =>
      (visibleWidth(line) <= innerWidth ? [line] : wrapNoticeLine(line, innerWidth))
        .map((fitted) => ({ line: fitted, owner: owners[index] })));
    const height = maxHeight === undefined ? undefined : Math.max(1, Math.floor(maxHeight));
    const verticalPadding = padded && (height === undefined || height >= 4) ? POPUP_VERTICAL_PADDING : 0;
    const contentLimit = height === undefined ? Number.POSITIVE_INFINITY : popupContentRows(height, padded, ruled);
    const visible = framedContent.slice(0, contentLimit);
    const rule = opaquePopupLine(theme.fg("borderMuted", "─".repeat(boundedWidth)));
    const row = (line: string): string => {
      const inner = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      return opaquePopupLine(" ".repeat(padding) + inner + " ".repeat(padding));
    };
    const itemCells = (line: string, owner: PopupItemRef | undefined): PopupFrameRow | undefined => {
      if (!owner) return undefined;
      const drawn = Math.min(innerWidth, visibleWidth(stripAnsi(line).replace(/\s+$/u, "")));
      return drawn > 0 ? { ref: owner, start: padding, end: padding + drawn } : undefined;
    };

    if (!ruled) {
      return {
        lines: visible.map(({ line }) => row(line)),
        rows: visible.map(({ line, owner }) => itemCells(line, owner)),
      };
    }
    if (height === 1) return { lines: [rule], rows: [undefined] };
    if (height === 2) return { lines: [rule, rule], rows: [undefined, undefined] };
    const output = [rule];
    const rows: Array<PopupFrameRow | undefined> = [undefined];
    if (verticalPadding > 0) {
      output.push(row(""));
      rows.push(undefined);
    }
    for (const { line, owner } of visible) {
      output.push(row(line));
      rows.push(itemCells(line, owner));
    }
    if (verticalPadding > 0) {
      output.push(row(""));
      rows.push(undefined);
    }
    output.push(rule);
    rows.push(undefined);
    return height === undefined
      ? { lines: output, rows }
      : { lines: output.slice(0, height), rows: rows.slice(0, height) };
  }

  /** Record the frame just returned to the compositor as the only clickable geometry. */
  function publishFrame(
    framed: { lines: string[]; rows: Array<PopupFrameRow | undefined> },
    width: number,
    viewportRows: number | undefined,
  ): string[] {
    lastFrame = closed
      ? undefined
      : {
          width: Math.max(1, Math.floor(width)),
          height: framed.lines.length,
          viewportRows,
          terminal: liveTerminalSize(),
          rows: framed.rows,
        };
    return framed.lines;
  }

  /**
   * The live terminal size as a comparable key. Without a probe the frame is
   * "unprobed" (component-only hosts); a missing, malformed, or throwing
   * probe reports "unknown", which never equals a recorded size.
   */
  function liveTerminalSize(): string {
    if (!options.getTerminalSize) return "unprobed";
    try {
      const size = options.getTerminalSize();
      const columns = size?.columns;
      const rows = size?.rows;
      return typeof columns === "number" && typeof rows === "number" && Number.isFinite(columns) && Number.isFinite(rows)
        ? `${Math.floor(columns)}x${Math.floor(rows)}`
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  /** The frame still describes the live terminal: no resize awaits a redraw. */
  function frameIsCurrent(frame: PopupFrame): boolean {
    return frame.terminal !== "unknown" && frame.terminal === liveTerminalSize();
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

  /**
   * Lay out the keyboard hint below the scrolled body, outside it, so it never
   * scrolls away. At least one body row always remains. The complete wrapped
   * hint (after a blank separator when it fits) is preferred; tighter budgets
   * fall back to the compact hint, wrapped or finally truncated to one row; a
   * one-row budget keeps only the body so a tiny terminal never loses access
   * to content.
   */
  function fixedHintRows(content: PopupContent, width: number, contentRows: number): string[] {
    if (content.hint === undefined || contentRows < 2) return [];
    const budget = contentRows - 1;
    const full = wrapNoticeLine(theme.fg("dim", content.hint), width);
    if (full.length + 1 <= budget) return ["", ...full];
    if (full.length <= budget) return full;
    const compactHint = content.compactHint ?? content.hint;
    const compact = wrapNoticeLine(theme.fg("dim", compactHint), width);
    if (compact.length <= budget) return compact;
    return [theme.fg("dim", truncatePlain(compactHint, width))];
  }

  const renderPopup = (width: number): string[] => {
    if (closed) {
      lastFrame = undefined;
      return [];
    }
    const height = options.getViewportRows ? viewportRows() : undefined;
    const contentWidth = popupContentWidth(width);
    const content = renderContent(contentWidth);
    const owners = content.owners ?? [];
    if (height === undefined) {
      // Unbounded (no row budget): the complete content and hint, framed.
      const hint = content.hint === undefined ? [] : ["", ...wrapNoticeLine(theme.fg("dim", content.hint), contentWidth)];
      return publishFrame(framePopup([...content.lines, ...hint], width, undefined, true, true, owners), width, undefined);
    }
    // Tiny budgets give up the blank vertical padding rows before the fixed
    // hint, and below three rows the rules too, so at least one content row
    // always remains visible and scrollable.
    const ruled = height >= 3;
    const padded = ruled && popupContentRows(height) >= 2;
    const contentRows = popupContentRows(height, padded, ruled);
    const hint = fixedHintRows(content, contentWidth, contentRows);
    const bodyRows = Math.max(0, contentRows - hint.length);
    const maximum = Math.max(0, content.lines.length - bodyRows);
    scrollOffset = Math.min(Math.max(0, scrollOffset), maximum);
    if (bodyRows > 0 && focusPending) {
      scrollOffset = offsetForFocus(scrollOffset, bodyRows, content.lines.length, viewportFocus);
      focusPending = false;
    }
    lastMaxScrollOffset = maximum;
    const body = content.lines.slice(scrollOffset, scrollOffset + bodyRows);
    // The same authoritative offset slices the drawn body and its item owners,
    // so a scrolled row maps to exactly the item it shows; the fixed hint rows
    // below the body own no item.
    const bodyOwners = owners.slice(scrollOffset, scrollOffset + bodyRows);
    return publishFrame(
      framePopup([...body, ...hint], width, height, padded, ruled, bodyOwners),
      width,
      height,
    );
  };

  function offsetForFocus(
    currentOffset: number,
    height: number,
    lineCount: number,
    focus: ViewportFocus | undefined,
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

  function renderList(width: number): PopupContent {
    viewportFocus = undefined;
    const pending = pendingNow();
    const lines: string[] = [];
    if (pending.length === 0) {
      lines.push(theme.fg("dim", "No pending input."));
      return { lines };
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
      renderedItemRanges.push({ start: rowStart, end: lines.length, ref: { kind: "list", record } });
      if (record.id === selection) {
        viewportFocus = { start: rowStart, end: rowStart, anchor: rowStart };
      }
    }
    const hint = hasNotice
      ? `arrows select · Enter ${hasQuestion ? "open question/notice" : "open notice"} · ${POPUP_SCROLL_HINT} · Esc defer and close`
      : `arrows select · Enter answer · ${POPUP_SCROLL_HINT} · Esc defer and close`;
    return { lines, hint, compactHint: POPUP_SCROLL_HINT };
  }

  function renderAnswer(width: number): PopupContent {
    viewportFocus = undefined;
    const record = selectedId ? controller.get(selectedId) : undefined;
    if (!record) {
      // Defensive: the question vanished (stale state); leave on next key.
      viewportFocus = { start: 0, end: 0, anchor: 0 };
      return { lines: [theme.fg("dim", "This question is no longer pending.")] };
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
          viewportFocus = {
            start: cursorRow,
            end: Math.max(cursorRow, rowStart + box.length - 1),
            anchor: cursorRow,
          };
        }
        return;
      }
      // While editing, a pressed menu row shows the press highlight without
      // moving the native field's selection, focus, or draft.
      const pressed = pressHighlight?.kind === "answer" && pressHighlight.record === record && pressHighlight.row === index;
      const prefix = selected || pressed ? theme.fg("accent", "> ") : "  ";
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
      renderedItemRanges.push({ start: rowStart, end: lines.length, ref: { kind: "answer", record, row: index } });
      if (selected) {
        viewportFocus = { start: rowStart, end: lines.length - 1, anchor: rowStart };
      }
    });
    // The native field owns every key while editing, so keyboard scrolling is
    // advertised only after Esc.
    const hint = editing
      ? "Enter submit · Esc back to options to scroll"
      : `arrows select · Enter confirm · ${POPUP_SCROLL_HINT} · Esc back`;
    return { lines, hint, compactHint: editing ? "Enter submit · Esc back to options" : POPUP_SCROLL_HINT };
  }

  function renderNotice(width: number): PopupContent {
    viewportFocus = undefined;
    const record = selectedId ? controller.getPending(selectedId) : undefined;
    if (!record || !isNotice(record)) return { lines: [theme.fg("dim", "This notice is no longer pending.")] };
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
      const rowStart = lines.length;
      const selected = index === noticeActionIndex;
      const pressed = pressHighlight?.kind === "notice" && pressHighlight.record === record && pressHighlight.action === index;
      appendNoticeAction(lines, row === NOTICE_MORE_DETAILS ? "More details" : "Close", selected, width, pressed);
      renderedItemRanges.push({ start: rowStart, end: lines.length, ref: { kind: "notice", record, action: index } });
      if (selected) viewportFocus = { start: rowStart, end: lines.length - 1, anchor: rowStart };
    });
    return {
      lines,
      hint: `arrows select · Enter choose · ${POPUP_SCROLL_HINT} · Esc back`,
      compactHint: POPUP_SCROLL_HINT,
    };
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
    if (lastViewportRows !== undefined && lastViewportRows !== resolved) {
      // The host editor sizes its own text viewport from terminal rows. Rebuild
      // its rendered box before applying the resized popup's offset.
      if (mode === "answer") cachedContent = undefined;
      // Resize keeps the authoritative offset (clamped to the new bounds);
      // only the list selection and an active editing cursor are re-revealed.
      if (mode === "list" || editing) focusPending = true;
    }
    lastViewportRows = resolved;
    return resolved;
  }

  /**
   * Keyboard scrolling keeps its existing one-line step, so successive views
   * overlap and no unseen line is skipped; the offset is bounded by the body
   * viewport that remains after the rules, padding, and fixed hint area.
   */
  function pageStep(): number {
    return 1;
  }

  /** Start a mode's view at its beginning; only the list reveals its selection. */
  function resetScroll(): void {
    scrollOffset = 0;
    viewportFocus = undefined;
    lastMaxScrollOffset = undefined; // The new view's bounds come from its next layout.
    focusPending = mode === "list";
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

  /**
   * `pressed` is the transient pointer-press highlight: it never adds or
   * removes a row, so the drawn actions stay where the press landed.
   */
  function appendNoticeAction(lines: string[], label: string, selected: boolean, width: number, pressed = false): void {
    if (width < 3) {
      if (selected) lines.push(theme.fg("accent", ">"));
      const wrapped = wrapNoticeLine(label, width);
      lines.push(...(pressed && !selected ? wrapped.map((line) => theme.fg("accent", line)) : wrapped));
      return;
    }
    const prefix = selected || pressed ? theme.fg("accent", "> ") : "  ";
    const prefixWidth = visibleWidth(prefix);
    const wrapped = wrapNoticeLine(label, Math.max(1, width - prefixWidth));
    lines.push(prefix + wrapped[0]!);
    for (const rest of wrapped.slice(1)) lines.push(" ".repeat(prefixWidth) + rest);
  }

  /** Truncate plain text to a column budget with a trailing ellipsis. */
  function truncatePlain(text: string, width: number): string {
    const bounded = Math.max(1, Math.floor(width));
    if (visibleWidth(text) <= bounded) return text;
    if (typeof tuiHost?.truncateToWidth === "function") {
      try {
        const truncated = tuiHost.truncateToWidth(text, bounded, "…");
        if (visibleWidth(truncated) <= bounded) return truncated;
      } catch {
        // Fall back to grapheme truncation below.
      }
    }
    let output = "";
    let used = 0;
    for (const grapheme of graphemeSegments(text)) {
      const graphemeWidth = visibleWidth(grapheme);
      if (used + graphemeWidth > bounded - 1) break;
      output += grapheme;
      used += graphemeWidth;
    }
    return `${output}…`;
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

  return {
    render: renderPopup,
    handleInput,
    handleMouse,
    invalidate,
    setSourceProbe,
  };
}
