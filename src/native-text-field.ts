/**
 * The one editable text seam for every extension-owned interactive TUI text
 * field (issue #26) — /review-settings fields, the staged subtask form
 * (title, instructions, acceptance criteria, relevant context, target
 * workspace), the steering instruction, and the private reviewer answer
 * editor alike — plus the AskUserQuestion free-text row through the same
 * native editor bridge directly.
 *
 * In an interactive Pi TUI (mode "tui") every field opens through the
 * host-wired native editor bridge (src/native-editor-bridge.ts): the host's
 * own main-prompt editor — acquired temporarily through the public
 * setEditorComponent seam — with native Tab completion, the shared
 * absolute-path file routing for first-line leading-slash tokens (never
 * slash-command items; the main chat prompt is untouched), the fd-backed `@`
 * picker, Ctrl+C clear, Ctrl+G external editing, image paste, and an editable
 * prefill. An interactive host missing the required native seams fails
 * closed: no non-parity fallback field is presented, and the caller's
 * unavailable handling (the default is an error notice) runs instead.
 *
 * Non-interactive hosts (RPC/print) keep their clearly identified public
 * chain: Pi's public `ui.editor(title, prefill)` — a real multi-line editor
 * with an editable prefill — first (or the legacy single-line `ui.input`
 * first when the caller opts in, with the editor behind a cancelled input,
 * matching the pre-bridge steering chain), then the legacy single-line
 * `ui.input`, which only shows the current value as placeholder text.
 *
 * `undefined` always means the value was not changed: the caller keeps its
 * own cancel semantics, exactly as with the old input seam. A host with no
 * usable seam never stages anything.
 */

import { editTextWithNativeEditor } from "./native-editor-bridge";
import type { NativeEditorCustomFactory, NativeEditorFactory } from "./native-editor-bridge";

/** The structural UI surface the shared text seam needs (host ctx.ui or a mock). */
export interface NativeTextFieldUi {
  /** Legacy single-line input; the current value is passed as placeholder. */
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  /** Pi's public multi-line editor with editable prefill. */
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  /** Host run mode ("tui" | "rpc" | ...); carried from the command context. */
  mode?: string;
  /** Non-overlay custom component slot (Pi TUI hosts only). */
  custom?(factory: NativeEditorCustomFactory): Promise<string | undefined>;
  /** Public Pi seam: install/replace the main editor factory (TUI hosts). */
  setEditorComponent?(factory: NativeEditorFactory | undefined): void;
  /** Public Pi seam: read the installed main editor factory (TUI hosts). */
  getEditorComponent?(): NativeEditorFactory | undefined;
}

/** Notice for an interactive TUI whose native editor seams are missing. */
export const NATIVE_FIELD_UNAVAILABLE_MESSAGE =
  "The native text editor is not available in this host; the value was left unchanged.";

/** Options for one shared text field. */
export interface NativeTextFieldOptions {
  /**
   * Observation-only native paste seam (TUI bridge fields only): reports
   * exactly the text Pi's own handlers insert through the editor's public
   * `insertTextAtCursor` (for an image paste: the temp file path). Pure
   * observation — no clipboard access, no path interpretation, no copying.
   */
  onHostInsert?: (text: string) => void;
  /**
   * Non-interactive host with neither editor nor input: notice text shown
   * instead of staging anything. Default: silent `undefined` (the old
   * optional-input chains returned undefined without a notice).
   */
  missingSeamNotice?: string;
  /**
   * Non-interactive hosts only: try the legacy single-line input before the
   * multi-line editor (the pre-bridge steering chain, where a cancelled input
   * fell through to the editor). Default: editor first.
   */
  preferInputFirst?: boolean;
  /**
   * Interactive host whose native editor seams are unavailable: the default
   * handling is the fail-closed error notice plus `undefined`. A caller may
   * instead supply its own degraded delivery (the reviewer answer notice, for
   * example). This hook is never a second editor: the field is simply not
   * presented, and whatever the hook returns (usually `undefined`) settles
   * the edit.
   */
  onUnavailable?: (reason: string) => Promise<string | undefined> | string | undefined;
}

/**
 * Edits one text value in an extension-owned field. In an interactive TUI the
 * field opens through the host-wired native editor bridge (the host's own
 * main-prompt editor with native completion and controls; the shared
 * leading-`/` file routing included); on any unavailable outcome the field
 * fails closed — the standard error notice, or the caller's `onUnavailable`
 * delivery — and nothing is staged. Non-interactive hosts prefer the public
 * editor (true editable prefill plus native controls such as Ctrl+G external
 * editing) and fall back to the legacy input seam with identical
 * title/placeholder semantics when no editor is available (input first when
 * `preferInputFirst` is set). Resolves `undefined` on cancel or when no
 * usable seam exists.
 */
export async function editNativeTextField(
  ui: NativeTextFieldUi,
  title: string,
  currentValue: string,
  options: NativeTextFieldOptions = {},
): Promise<string | undefined> {
  if (ui.mode === "tui") {
    const result = await editTextWithNativeEditor(ui, {
      title,
      prefill: currentValue,
      ...(options.onHostInsert ? { onHostInsert: options.onHostInsert } : {}),
    });
    if (result.kind === "value") return result.value;
    if (result.kind === "cancel") return undefined;
    if (options.onUnavailable) return await options.onUnavailable(result.reason);
    ui.notify?.(`${NATIVE_FIELD_UNAVAILABLE_MESSAGE} (${result.reason})`, "error");
    return undefined;
  }
  const editor = typeof ui.editor === "function" ? ui.editor : undefined;
  const input = typeof ui.input === "function" ? ui.input : undefined;
  if (options.preferInputFirst && input) {
    // The pre-bridge steering chain: a cancelled input fell through to the
    // editor; preserve that exactly.
    const viaInput = await input(title, currentValue);
    if (viaInput !== undefined) return viaInput;
  }
  if (editor) return editor(title, currentValue);
  if (!options.preferInputFirst && input) return input(title, currentValue);
  if (options.missingSeamNotice) ui.notify?.(options.missingSeamNotice, "error");
  return undefined;
}