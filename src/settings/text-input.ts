/**
 * The one editable text seam for every /review-settings field (issue #26).
 *
 * Every settings text field goes through {@link editSettingText}, a thin
 * settings-shaped wrapper over the shared extension-field seam
 * (src/native-text-field.ts):
 *
 * - Interactive Pi TUI hosts present the field through the host-wired native
 *   editor bridge (src/native-editor-bridge.ts): the host's own main-prompt
 *   editor — acquired temporarily through the public setEditorComponent seam
 *   and embedded in a non-overlay custom slot — with native Tab completion,
 *   the fd-backed `@` picker, Ctrl+C clear, Ctrl+G external editing, image
 *   paste, and an editable prefill. Every field shares the same native
 *   absolute-path completion for first-line leading-slash tokens — `/`,
 *   `/se`, `/var`, nested absolute paths — through the host provider's own
 *   file branch in its ordinary file-list layout, never slash-command items.
 *   An interactive host missing the required
 *   native seams fails closed with an error notice: no non-parity fallback
 *   field is presented in the TUI.
 * - Non-interactive hosts (RPC/print) keep their clearly identified public
 *   chain: `ctx.ui.editor(title, currentValue)` — a real multi-line editor
 *   with an *editable* prefill and the host's native text controls — first,
 *   then the legacy single-line `ui.input`, which only shows the current
 *   value as placeholder text.
 *
 * `undefined` always means cancel: the caller leaves the staged value
 * unchanged, exactly as with the old input seam. A host with no usable seam
 * fails closed with an error notice — nothing is ever staged from a missing
 * UI.
 */

import { editNativeTextField } from "../native-text-field";
import type { NativeEditorCustomFactory, NativeEditorFactory } from "../native-editor-bridge";

/** The structural UI surface the text seam needs (host ctx.ui or a mock). */
export interface SettingTextInputUi {
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

/** Per-field options for the shared text seam. */
export interface SettingTextInputOptions {
  /**
   * Observation-only native paste seam (TUI bridge fields only): forwarded to
   * the native editor bridge's `onHostInsert`, which reports exactly the text
   * Pi's own handlers insert through the editor's public
   * `insertTextAtCursor` (for an image paste: the temp file path). Pure
   * observation — no clipboard access, no path interpretation, no copying;
   * the non-interactive editor/input fallback has no such seam and never
   * reports inserts.
   */
  onHostInsert?: (text: string) => void;
}

/**
 * Edits one settings text value. In an interactive TUI the field opens through
 * the host-wired native editor bridge (the host's own main-prompt editor with
 * native completion and controls); on any unavailable outcome it fails closed
 * with an error notice. Non-interactive hosts prefer the public editor (true
 * editable prefill plus native controls such as Ctrl+G external editing) and
 * fall back to the legacy input seam with identical title/placeholder
 * semantics when no editor is available. Resolves `undefined` on cancel or
 * when no usable seam exists. The optional options carry the observation-only
 * paste seam for fields that must learn native paste provenance (scheduled
 * instruction images); it is never a second editor, clipboard, or matcher.
 */
export async function editSettingText(
  ui: SettingTextInputUi,
  title: string,
  currentValue: string,
  unavailableMessage = "This UI does not support text input.",
  options: SettingTextInputOptions = {},
): Promise<string | undefined> {
  return editNativeTextField(ui, title, currentValue, {
    ...(options.onHostInsert ? { onHostInsert: options.onHostInsert } : {}),
    // The per-field unavailableMessage describes a missing input capability;
    // it applies to the non-interactive no-seam case. An interactive host
    // without the native editor seams fails closed with the shared seam's
    // standard notice, which names the real situation.
    missingSeamNotice: unavailableMessage,
  });
}
