/**
 * Internal canonical JSON serialization shared by config and session-state:
 * session-state sidecar integrity, config and reviewer-selection digests,
 * reviewer and executor fingerprints, and checkpoint descriptor identity.
 *
 * Byte contract — changing this can invalidate existing digests:
 * - Object keys are sorted with the default UTF-16 code-unit sort; source
 *   object key order is irrelevant.
 * - Arrays preserve element order and recurse.
 * - No whitespace is emitted.
 * - Primitives retain JSON.stringify behavior, with `null` as the fallback
 *   when it returns undefined. Undefined object properties serialize as
 *   explicit `null` entries, not omitted; callers filter before calling
 *   when omission is required. Unsupported inputs still throw as before.
 */
export function canonicalStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalStableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
