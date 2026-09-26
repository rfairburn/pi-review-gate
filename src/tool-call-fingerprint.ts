import { createHash } from "node:crypto";

export type StartLiveness =
  | { state: "active"; identity?: string }
  | { state: "unknown"; identity?: string }
  | { state: "inactive" };

/** Resolve the raw assistant-submitted identity for one admitted native call. */
export type SubmittedToolCallFingerprint = (toolCallId: string, toolName: string) => string | undefined;

/**
 * Stable identity for one submitted Pi tool call. JSON object key order is not
 * semantically meaningful, but every JSON value, array order, tool name, and
 * submitted argument value is. Unrepresentable input fails closed by
 * returning undefined; callers must not guess an identity for it.
 */
export function toolCallFingerprint(toolName: string, input: unknown): string | undefined {
  if (!toolName) return undefined;
  try {
    const canonical = canonicalJson(input, new Set<object>());
    if (canonical === undefined) return undefined;
    return createHash("sha256").update(toolName).update("\0").update(canonical).digest("hex");
  } catch {
    return undefined;
  }
}

export function isToolCallFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function canonicalJson(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return undefined;
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) return undefined;
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (const item of value) {
            const canonical = canonicalJson(item, ancestors);
            if (canonical === undefined) return undefined;
            items.push(canonical);
          }
          return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return undefined;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
        const keys = Object.keys(descriptors).sort();
        const properties: string[] = [];
        for (const key of keys) {
          const descriptor = descriptors[key]!;
          if (!("value" in descriptor) || !descriptor.enumerable) return undefined;
          const canonical = canonicalJson(descriptor.value, ancestors);
          if (canonical === undefined) return undefined;
          properties.push(`${JSON.stringify(key)}:${canonical}`);
        }
        return `{${properties.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      return undefined;
  }
}
