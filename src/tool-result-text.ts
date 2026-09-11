/**
 * Shared display encoding for recorded tool-result text (#93).
 *
 * Tool results and recorded model inputs can contain terminal control bytes
 * (ANSI escape sequences, carriage returns, NULs, C1 controls). Renderers must
 * never execute those bytes against the user's terminal, but silently
 * deleting them is display loss, not safety: the human view would no longer
 * match what the model actually supplied or received.
 *
 * `visibleTerminalText` is an unambiguous, reversible display encoding, not a
 * redaction:
 *
 * - Literal backslashes are escaped first (`\` becomes `\\`), so every single
 *   backslash in the encoded output starts exactly one encoded sequence and
 *   literal text such as `\r` or `\u001b` (typed by the model as ordinary
 *   characters) renders as `\\r` / `\\u001b` — visually distinct from an
 *   encoded CR or ESC.
 * - ESC and every C0/C1 control byte become `\u00XX` notation (ESC as
 *   `\u001b`), shown instead of executed or deleted; CR becomes `\r`.
 * - LF and TAB are structural whitespace: preserved as-is so multiline
 *   rendering and width wrapping keep working unchanged.
 * - All printable characters, including astral-plane glyphs, are copied
 *   byte-for-byte.
 *
 * Decoding the notation with a sequential scanner always recovers the input
 * exactly (see the focused tests). The encoding is applied ONCE at the
 * raw-text display boundary; it is not idempotent by design (a second
 * application would escape the notation's backslashes), so renderers must not
 * re-encode already-encoded strings.
 *
 * Nothing here filters, masks, or truncates content; upstream protections
 * that run before data reaches the model remain separate and unchanged.
 */

/** C1 control bytes (0x80–0x9f) are non-printing terminal controls too. */
function isControlCodePoint(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Encodes non-printing control bytes as unambiguous visible escape notation.
 * Literal backslashes are escaped (`\` → `\\`) so encoded sequences can never
 * collide with literally submitted `\r`- or `\u001b`-shaped text.
 */
export function visibleTerminalText(value: string): string {
  let encoded = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") {
      encoded += "\\\\";
    } else if (ch === "\n" || ch === "\t") {
      encoded += ch;
    } else if (ch === "\r") {
      encoded += "\\r";
    } else if (isControlCodePoint(code)) {
      encoded += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      encoded += ch;
    }
  }
  return encoded;
}