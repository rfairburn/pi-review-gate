/** Shared text wrapping for the ApplyPatch and tool-discovery result views. */

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