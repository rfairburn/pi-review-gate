const SENSITIVE_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|cookie)`;

// A generated "[REDACTED]" marker is matched explicitly as the first value
// alternative so repeated redaction consumes its closing bracket idempotently.
// Any attached non-delimited suffix (e.g. password=[REDACTED]-hunter2) remains
// part of the sensitive value and is redacted as well.
const ASSIGNMENT_RE = new RegExp(
  String.raw`(["']?${SENSITIVE_KEY}["']?\s*[:=]\s*)(["']?)(\[REDACTED\][^\s,"'\]}]*|[^\s,"'\]}]+|[^"']*)(\2)`,
  "gi",
);

const MAX_PEM_PRIVATE_KEY_BODY_LENGTH = 64 * 1024;
const PEM_PRIVATE_KEY_LABEL = String.raw`(?:[A-Z0-9][A-Z0-9-]{0,31} ){0,3}PRIVATE KEY`;
// Accepts real newlines as well as JSON-escaped "\\n" sequences (private keys
// embedded in tool stdout that captured a JSON-encoded string).
const PEM_PRIVATE_KEY_RE = new RegExp(
  String.raw`-----BEGIN (${PEM_PRIVATE_KEY_LABEL})-----[ \t]*(?:\r?\n|\\n)[\s\S]{1,${MAX_PEM_PRIVATE_KEY_BODY_LENGTH}}?-----END \1-----`,
  "g",
);

const MAX_JWT_HEADER_LENGTH = 2_048;
const MAX_JWT_PAYLOAD_LENGTH = 16 * 1024;
const MAX_JWT_SIGNATURE_LENGTH = 4_096;
const JWT_CANDIDATE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{15,${MAX_JWT_HEADER_LENGTH}}\.[A-Za-z0-9_-]{3,${MAX_JWT_PAYLOAD_LENGTH}}\.[A-Za-z0-9_-]{16,${MAX_JWT_SIGNATURE_LENGTH}}(?![A-Za-z0-9_-])`,
  "g",
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
  // Whole-token matchers run before the generic TOKEN_PATTERNS loop so that
  // patterns like /(?:sk|rk|pk)-.../ or /xox[baprs]-.../ cannot partially
  // rewrite a base64url JWT segment and stop the whole-token matcher from
  // recognizing (and fully redacting) the token.
  redacted = redacted.replace(PEM_PRIVATE_KEY_RE, "[REDACTED]");
  redacted = redacted.replace(JWT_CANDIDATE_RE, (candidate) =>
    isStructurallyPlausibleJwt(candidate) ? "[REDACTED]" : candidate);
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

function isStructurallyPlausibleJwt(candidate: string): boolean {
  const [encodedHeader, encodedPayload, encodedSignature] = candidate.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;

  const header = decodeJsonSegment(encodedHeader);
  const payload = decodeJsonSegment(encodedPayload);
  return isRecord(header)
    && typeof header.alg === "string"
    && header.alg.length > 0
    && isRecord(payload);
}

function decodeJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}
