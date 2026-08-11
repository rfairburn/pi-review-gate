const SENSITIVE_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|cookie)`;

const ASSIGNMENT_RE = new RegExp(
  String.raw`(["']?${SENSITIVE_KEY}["']?\s*[:=]\s*)(["']?)([^\s,"'\]}]+|[^"']*)(\2)`,
  "gi",
);

const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  redacted = redacted.replace(ASSIGNMENT_RE, (_match, prefix: string, quote: string) =>
    `${prefix}${quote}[REDACTED]${quote}`);
  return redacted;
}

export function redactSensitiveValue(value: unknown, key?: string): unknown {
  if (key && new RegExp(`^${SENSITIVE_KEY}$`, "i").test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
      [childKey, redactSensitiveValue(child, childKey)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
