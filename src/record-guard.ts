/**
 * Shared strict shape guard for unknown values that must be read as keyed
 * records. Dependency-free so any module can import it without pulling in
 * domain code.
 *
 * Contract: rejects only non-objects, `null`, and arrays (including arrays that
 * carry extra properties). Every other object is accepted unchanged — plain and
 * null-prototype objects as well as non-plain objects such as `Date`, `Buffer`,
 * `Map`, or class instances. Callers that need stricter plain-object or
 * prototype checks must apply them separately.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
