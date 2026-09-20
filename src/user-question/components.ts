/**
 * Pending-question list UI (issue #95).
 *
 * One plain structural Component (render/handleInput/invalidate) with two
 * modes, shown through `ctx.ui.custom()` from the pending-question shortcut.
 * The host's showExtensionCustom saves and restores the editor text around
 * the component, so opening and closing the list preserves the user's draft
 * without any work here; while it has focus, all input — including Escape —
 * is handled by this component, so it never triggers Pi's abort.
 *
 * - List mode: every pending question of the current session, in creation
 *   order, read live from the controller on each render (a question that
 *   becomes waiting while the list is open appears without re-opening).
 * - Answer mode: the selected question's supplied choices plus a free-text
 *   row and an explicit Decline row. Declining is one deliberate action
 *   (select Decline, confirm) with no second confirmation; Escape only goes
 *   back, so nothing declines by accident.
 *
 * Navigation, confirm, cancel, cursor movement, and deletion resolve through
 * the host's live KeybindingsManager (`tui.select.*`, `tui.editor.*`), so
 * user keybindings.json overrides are honored. The extension's own shortcut
 * chord (Ctrl+Alt+Up) is matched with the host pi-tui's matchesKey when
 * loadable; without it, Escape still closes the list.
 */

import type { QuestionTuiHost } from "./pi-tui-host";
import type { SubmitResult, UserQuestionController } from "./controller";

/** The approved chord; the label shown to users is platform-specific. */
export const QUESTION_LIST_SHORTCUT_KEY = "ctrl+alt+up";

export interface QuestionUiKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export interface QuestionUiTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type QuestionListDone =
  | { kind: "closed" }
  | { kind: "submitted"; result: SubmitResult };

export interface QuestionListComponentOptions {
  controller: UserQuestionController;
  keybindings: QuestionUiKeybindings;
  theme: QuestionUiTheme;
  /** Host pi-tui helpers; every member optional (degraded rendering without). */
  tuiHost?: QuestionTuiHost;
  /** Platform label for the shortcut, e.g. "Ctrl+Alt+Up" or "Ctrl+Option+Up". */
  shortcutLabel: string;
  onDone: (result: QuestionListDone) => void;
}

export interface QuestionListComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  /** Installs the live idle probe used for async answer delivery. */
  setSourceProbe(probe: { isIdle?: () => boolean } | undefined): void;
}

const TYPE_ROW = "__type__";
const DECLINE_ROW = "__decline__";
const MAX_FREE_TEXT_CHARS = 4000;

export function createQuestionListComponent(options: QuestionListComponentOptions): QuestionListComponent {
  const { controller, keybindings, theme, tuiHost, shortcutLabel } = options;
  let mode: "list" | "answer" = "list";
  let selectedId: string | undefined;
  let answerIndex = 0;
  let editing = false;
  let buffer = "";
  let cursor = 0;
  let closed = false;
  let cachedLines: string[] | undefined;
  // The shortcut handler installs a live idle probe before the component is
  // shown; it stays valid for the whole UI session because this component
  // consumes all input while open, so no session replacement can happen.
  let activeSourceProbe: { isIdle?: () => boolean } | undefined;

  const invalidate = () => {
    cachedLines = undefined;
  };

  // Live questions (registered while the list is open) must refresh the view.
  const unsubscribeState = controller.addStateListener(invalidate);

  const close = (result?: SubmitResult) => {
    if (closed) return;
    closed = true;
    unsubscribeState();
    options.onDone(result ? { kind: "submitted", result } : { kind: "closed" });
  };

  const pendingNow = () => controller.listPending();

  /** Keep the list selection on a live question; fall back to the first. */
  function currentListSelection(): string | undefined {
    const pending = pendingNow();
    if (pending.length === 0) return undefined;
    if (selectedId && pending.some((question) => question.id === selectedId)) return selectedId;
    return pending[0]!.id;
  }

  function answerRows(): string[] {
    const record = selectedId ? controller.get(selectedId) : undefined;
    const choices = record?.choices ?? [];
    return [...choices, TYPE_ROW, DECLINE_ROW];
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
    editing = false;
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
      if (!controller.get(id)) return;
      mode = "answer";
      selectedId = id;
      answerIndex = 0;
      editing = false;
      buffer = "";
      cursor = 0;
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
      handleEditingInput(data, id);
      return;
    }
    const rows = answerRows();
    if (keybindings.matches(data, "tui.select.up")) {
      if (answerIndex > 0) answerIndex -= 1;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (answerIndex < rows.length - 1) answerIndex += 1;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const row = rows[answerIndex];
      if (row === undefined) return;
      if (row === TYPE_ROW) {
        editing = true;
        invalidate();
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
      invalidate();
      return;
    }
    if (matchesShortcut(data)) {
      close();
    }
  }

  function handleEditingInput(data: string, id: string): void {
    if (keybindings.matches(data, "tui.select.confirm")) {
      const text = buffer.trim();
      if (text.length === 0) return;
      submitFromAnswer(controller.submitAnswer(id, text, sourceProbe()));
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      // Back to the option rows; the draft text is kept for this question.
      editing = false;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.editor.cursorLeft")) {
      if (cursor > 0) cursor -= 1;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.editor.cursorRight")) {
      if (cursor < buffer.length) cursor += 1;
      invalidate();
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      if (cursor > 0) {
        buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
        cursor -= 1;
      }
      invalidate();
      return;
    }
    const printable = printableText(data);
    if (printable.length === 0) return;
    if (buffer.length >= MAX_FREE_TEXT_CHARS) return;
    buffer = buffer.slice(0, cursor) + printable + buffer.slice(cursor);
    cursor += printable.length;
    invalidate();
  }

  function matchesShortcut(data: string): boolean {
    return typeof tuiHost?.matchesKey === "function" && tuiHost.matchesKey(data, QUESTION_LIST_SHORTCUT_KEY);
  }

  /** Live idle probe for async delivery; the UI carries no session state of its own. */
  function sourceProbe(): { isIdle?: () => boolean } | undefined {
    return activeSourceProbe;
  }

  const handleInput = (data: string) => {
    if (closed) return;
    if (mode === "list") handleListInput(data);
    else handleAnswerInput(data);
  };

  const render = (width: number): string[] => {
    if (cachedLines) return cachedLines;
    const lines = mode === "list" ? renderList(width) : renderAnswer(width);
    cachedLines = lines;
    return lines;
  };

  function renderList(width: number): string[] {
    const pending = pendingNow();
    const lines: string[] = [];
    if (pending.length === 0) {
      lines.push(theme.fg("dim", "No pending questions."));
      return lines;
    }
    const selection = currentListSelection() ?? undefined;
    const header = theme.bold(`Pending questions (${pending.length})`)
      + theme.fg("dim", ` · ${shortcutLabel} to close`);
    for (const line of wrapLine(header, width)) lines.push(line);
    lines.push("");
    for (const record of pending) {
      const tag = record.mode === "sync" ? theme.fg("warning", " [waiting]") : "";
      const prefix = record.id === selection ? theme.fg("accent", "> ") : "  ";
      const text = `${record.id}: ${record.question}` + tag;
      const first = wrapLine(text, Math.max(1, width - visibleWidth(prefix)));
      lines.push(prefix + first[0]!);
      for (const rest of first.slice(1)) {
        lines.push(" ".repeat(visibleWidth(prefix)) + rest);
      }
    }
    lines.push("");
    lines.push(theme.fg("dim", "arrows select · Enter answer · Esc defer and close"));
    return lines;
  }

  function renderAnswer(width: number): string[] {
    const record = selectedId ? controller.get(selectedId) : undefined;
    if (!record) {
      // Defensive: the question vanished (stale state); leave on next key.
      linesOnce(theme.fg("dim", "This question is no longer pending."));
      return cachedLines!;
    }
    const rows = answerRows();
    const lines: string[] = [];
    for (const line of wrapLine(`${record.id}: ${record.question}`, width)) {
      lines.push(line);
    }
    lines.push("");
    rows.forEach((row, index) => {
      const selected = index === answerIndex;
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      let text: string;
      if (row === TYPE_ROW) {
        text = editing
          ? renderEditorLine()
          : theme.fg("muted", "Type something…");
      } else if (row === DECLINE_ROW) {
        text = theme.fg("warning", "Decline (no answer will be sent)");
      } else {
        text = `${index + 1}. ${row}`;
      }
      const wrapped = wrapLine(text, Math.max(1, width - visibleWidth(prefix)));
      lines.push(prefix + wrapped[0]!);
      for (const rest of wrapped.slice(1)) {
        lines.push(" ".repeat(visibleWidth(prefix)) + rest);
      }
    });
    lines.push("");
    lines.push(theme.fg("dim", editing
      ? "Enter submit · Esc back to options"
      : "arrows select · Enter confirm · Esc back"));
    return lines;
  }

  function linesOnce(line: string): void {
    cachedLines = [line];
  }

  function renderEditorLine(): string {
    const atCursor = cursor < buffer.length ? buffer[cursor]! : " ";
    const before = buffer.slice(0, cursor);
    const after = buffer.slice(cursor + 1);
    return theme.fg("muted", "Your answer: ") + before + "\x1b[7m" + atCursor + "\x1b[27m" + after;
  }

  // ------------------------------------------------------------------
  // Width-safe text helpers (host pi-tui when loadable, naive fallback)
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
    // Degraded fallback (no host helpers): plain visible-text wrap. Styles do
    // not survive this path, which only matters outside a real Pi TUI.
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

  function naiveVisibleWidth(text: string): number {
    let width = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
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

  function printableText(data: string): string {
    if (data.length === 0) return "";
    // The host forwards bracketed-paste markers verbatim to the focused
    // component; drop them so a paste inserts its payload, not escape text.
    const cleaned = data.replace(/\x1b\[20[01]~/g, "");
    let out = "";
    for (const char of cleaned) {
      const code = char.codePointAt(0)!;
      if (code < 32 || code === 0x7f) continue;
      out += char;
    }
    return out;
  }

  const setSourceProbe = (probe: { isIdle?: () => boolean } | undefined): void => {
    activeSourceProbe = probe;
  };

  return {
    render,
    handleInput,
    invalidate,
    setSourceProbe,
  };
}
