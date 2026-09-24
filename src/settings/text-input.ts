/**
 * The one editable text seam for every /review-settings field (issue #26).
 *
 * Every settings text field goes through {@link editSettingText}, which
 * prefers Pi's public `ctx.ui.editor(title, currentValue)` — a real multi-line
 * editor with an *editable* prefill and the host's native text controls
 * (including Ctrl+G external editing) — and falls back to the legacy
 * single-line `ui.input` when the host offers no editor. The legacy seam only
 * shows the current value as placeholder text; the editor seam makes it
 * editable content, which is the point of this correction.
 *
 * `undefined` always means cancel: the caller leaves the staged value
 * unchanged, exactly as with the old input seam. A host with neither seam
 * fails closed with an error notice and a `undefined` result — nothing is
 * ever staged from a missing UI.
 */

/** The structural UI surface the text seam needs (host ctx.ui or a mock). */
export interface SettingTextInputUi {
  /** Legacy single-line input; the current value is passed as placeholder. */
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  /** Pi's public multi-line editor with editable prefill. */
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * Edits one settings text value. Prefers the public editor (true editable
 * prefill plus native controls such as Ctrl+G external editing); falls back
 * to the legacy input seam with identical title/placeholder semantics when no
 * editor is available. Resolves `undefined` on cancel, or when neither seam
 * exists (with an error notice in the latter case).
 */
export async function editSettingText(
  ui: SettingTextInputUi,
  title: string,
  currentValue: string,
  unavailableMessage = "This UI does not support text input.",
): Promise<string | undefined> {
  if (typeof ui.editor === "function") return ui.editor(title, currentValue);
  if (typeof ui.input !== "function") {
    ui.notify?.(unavailableMessage, "error");
    return undefined;
  }
  return ui.input(title, currentValue);
}
