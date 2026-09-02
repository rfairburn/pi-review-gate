import assert from "node:assert/strict";

export function expect(actual: unknown, message?: string) {
  const includes = (expected: unknown) => {
    if (typeof actual === "string") assert.ok(actual.includes(String(expected)), message);
    else if (Array.isArray(actual)) assert.ok(actual.includes(expected), message);
    else throw new assert.AssertionError({ message: message ?? "value does not support containment" });
  };
  const throws = () => assert.throws(actual as () => unknown, message);
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected, message),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected, message),
    toBeNull: () => assert.equal(actual, null, message),
    toBeUndefined: () => assert.equal(actual, undefined, message),
    toBeLessThan: (expected: number) => assert.ok(typeof actual === "number" && actual < expected, message),
    toBeLessThanOrEqual: (expected: number) =>
      assert.ok(typeof actual === "number" && actual <= expected, message),
    toContain: includes,
    toMatchObject: (expected: Record<string, unknown>) => {
      assert.ok(actual && typeof actual === "object", message);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual((actual as Record<string, unknown>)[key], value, message);
      }
    },
    toThrow: throws,
    not: {
      toBeNull: () => assert.notEqual(actual, null, message),
      toContain: (expected: unknown) => {
        if (typeof actual === "string") assert.ok(!actual.includes(String(expected)), message);
        else if (Array.isArray(actual)) assert.ok(!actual.includes(expected), message);
        else throw new assert.AssertionError({ message: message ?? "value does not support containment" });
      },
      toThrow: () => assert.doesNotThrow(actual as () => unknown, message),
    },
  };
}
