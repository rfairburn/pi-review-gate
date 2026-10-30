/** Shared text wrapping for the ApplyPatch and tool-discovery result views. */

import { visibleLineWidth, wrapAnsiAwareRows } from "./presentation-hints";

/**
 * Code-point width count kept for {@link wrapPreserving}, whose ApplyPatch and
 * tool-discovery callers keep their existing behaviour unchanged.
 */
function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    if ((code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x1f000 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Word-boundary wrapping for one already-encoded display line (no ANSI).
 *
 * Added for the tool-protection audit rows (#547): a hard character break in
 * the middle of a word made the gate's own status rows unreadable, while the
 * native tool rows around them reflow at word boundaries. Breaking happens at
 * whitespace; a token wider than the width still has to be broken (the
 * unavoidable long-token behavior of {@link wrapPreserving}), and no non-space
 * character is ever dropped. Whitespace that lands on a break is not carried
 * to the start of the next row, exactly like the host's own wrapping, so no
 * row exceeds the width; leading indentation of the line itself is preserved.
 *
 * Cells, not code points: the per-token measurement and the accumulated row
 * width both use the shared host-aware {@link visibleLineWidth} (the running
 * Pi host's own pi-tui `visibleWidth`, with the shared conservative count only
 * when no host measurement is resolvable), and an oversized token is split
 * with the shared {@link wrapAnsiAwareRows} (the host's own ANSI-aware and
 * grapheme-aware `wrapTextWithAnsi`). The rows produced here are measured and
 * padded downstream by the same host helpers, so a wide-emoji auditor reason —
 * one `✅` counts one cell in a code-point count and two cells in the host —
 * can never emit a row wider than the card and trip the host's width guard.
 * No second width algorithm is introduced.
 *
 * Only the tool-protection display rows use this. The ApplyPatch and
 * tool-discovery result views keep {@link wrapPreserving} unchanged.
 */
export function wrapAtWordBoundaries(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  if (width <= 0) return [value];
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  const endRow = (): void => {
    if (current.length > 0) rows.push(current.trimEnd());
    current = "";
    currentWidth = 0;
  };
  for (const token of value.split(/(\s+)/)) {
    if (token.length === 0) continue;
    const tokenWidth = visibleLineWidth(token);
    if (tokenWidth === 0) {
      // Zero-width run (combining marks only): keep it attached to the row.
      current += token;
      continue;
    }
    if (/\s/.test(token[0]!)) {
      // Whitespace run. Never start a continuation row with it, but keep the
      // line's own leading indentation on the first row.
      if (currentWidth === 0 && rows.length > 0) continue;
      current += token;
      currentWidth += tokenWidth;
      continue;
    }
    if (tokenWidth > width) {
      if (currentWidth > 0) endRow();
      // The host's own ANSI-aware, grapheme-aware splitter: its pieces fit the
      // width by the host's own measurement, and a multi-code-point emoji
      // grapheme is never broken apart.
      const pieces = wrapAnsiAwareRows(token, width);
      for (let index = 0; index < pieces.length - 1; index += 1) rows.push(pieces[index]!);
      current = pieces[pieces.length - 1]!;
      currentWidth = visibleLineWidth(current);
      continue;
    }
    if (currentWidth > 0 && currentWidth + tokenWidth > width) endRow();
    current += token;
    currentWidth += tokenWidth;
  }
  if (current.length > 0) rows.push(current.trimEnd());
  return rows.length > 0 ? rows : [""];
}

/** Wraps without clipping: every code point remains in the returned rows. */
export function wrapPreserving(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  if (width <= 0) return [value];
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (current.length > 0 && characterWidth > 0 && currentWidth + characterWidth > width) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += character;
    currentWidth += characterWidth;
  }
  if (current.length > 0) rows.push(current);
  return rows.length > 0 ? rows : [""];
}