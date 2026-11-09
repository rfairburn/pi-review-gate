/**
 * Owned synthetic long-form question fixtures for issue #396.
 *
 * These are sanitized, invented texts — no real session content, credentials,
 * or private paths. They exist so the schema, controller, and shared-popup
 * tiers can admit and read a question that the removed 2,000-character
 * question-only ceiling would have rejected, and then compare the retained and
 * delivered text byte for byte.
 */

/** Every paragraph marker, in order, e.g. `Q001` … for `longFormQuestion(n)`. */
export function longFormMarkers(paragraphs: number): string[] {
  return Array.from({ length: paragraphs }, (_, index) => `Q${String(index + 1).padStart(3, "0")}`);
}

/**
 * A multiline, mixed-script question with one paragraph per marker: printable
 * ASCII plus CJK, an emoji/ZWJ family sequence, combining marks, and a
 * right-to-left run. It starts and ends with printable text, so the
 * controller's ends-only trim is a no-op and the accepted text can be compared
 * exactly. Paragraphs are blank-line separated, so each marker begins its own
 * rendered block.
 */
export function longFormQuestion(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, index) => {
    const marker = longFormMarkers(paragraphs)[index]!;
    return `${marker}: align the retry budget for the payment worker with the checkout queue — 重试预算 🔒 `
      + `👨‍👩‍👧 café naïve ‎مرحبا‎ — decide before the release ships.`;
  }).join("\n\n");
}

/**
 * A single-line question just past the removed 2,000-character ceiling, with a
 * distinctive head and tail so retention can be checked at both ends.
 */
export const JUST_OVER_REMOVED_CAP: string = Array.from(
  { length: 48 },
  (_, index) => `S${String(index + 1).padStart(2, "0")} keep-the-full-context-evidence-segment`,
).join(" ");

/** The paragraph count used by the "substantially larger" cases. */
export const LARGE_QUESTION_PARAGRAPHS = 120;
