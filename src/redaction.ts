const SENSITIVE_KEY = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|cookie)`;

// A generated "[REDACTED]" marker is matched explicitly as the first value
// alternative so repeated redaction consumes its closing bracket idempotently.
// Any attached non-delimited suffix (e.g. password=[REDACTED]-hunter2) remains
// part of the sensitive value and is redacted as well.
// Groups: 1 leading quote, 2 sensitive key, 3 trailing quote + separator,
// 4 value quote, 5 value, 6 closing quote (backreference to 4).
const ASSIGNMENT_RE = new RegExp(
  String.raw`(["']?)(${SENSITIVE_KEY})(["']?\s*[:=]\s*)(["']?)(\[REDACTED\][^\s,"'\]}]*|[^\s,"'\]}]+|[^"']*)(\4)`,
  "gi",
);

// #55: GitHub Actions workflow files declare job permissions with scope keys
// such as `id-token` whose values are permission levels, not credentials. The
// unanchored `token` alternative in SENSITIVE_KEY otherwise matches inside
// `id-token` and redacts the harmless declaration. The approved exception is
// deliberately narrow: it preserves ONLY a bare, unquoted `id-token: write`
// line in multiline block YAML whose nearest enclosing (strictly less-indented)
// mapping key is exactly `permissions:` — the representative workflow form,
// including realistic sibling scopes and CRLF endings. Everything else keeps
// the default redaction: `id-token: read`, quoted or inline/flow values, list
// items, an `id-token` outside such a permissions mapping (including under a
// stale earlier one), longer keys containing the run (`my-id-token`), and any
// credential value such as a provider token or JWT.
const GITHUB_ACTIONS_ID_TOKEN_KEY = "id-token";
const GITHUB_ACTIONS_WRITE_LEVEL = "write";
// A block-mapping line that declares the permissions mapping: exactly
// `permissions:` plus an optional trailing comment (CRLF already stripped).
const PERMISSIONS_KEY_LINE_RE = /^permissions:(?:[ \t]+#.*)?[ \t]*$/;
// The enclosing-context scan is bounded on purpose: a real permissions block
// keeps its entries within a handful of lines, and redaction inputs are capped
// upstream. Walking more physical lines above a candidate can never reach a
// realistic enclosing mapping, so stop there (fail closed) instead of scanning
// unrelated content.
const MAX_ENCLOSING_SCAN_LINES = 256;

function isIdentifierCharCode(code: number): boolean {
  return (code >= 97 && code <= 122) // a-z
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 48 && code <= 57) // 0-9
    || code === 95 // _
    || code === 45; // -
}

// The identifier run ending at `end`, scanned backward character by character
// so no prefix of the input is copied for each candidate match.
function identifierRunBefore(text: string, end: number): string {
  let start = end;
  while (start > 0 && isIdentifierCharCode(text.charCodeAt(start - 1))) start--;
  return text.slice(start, end);
}

function leadingWhitespaceLength(line: string): number {
  let n = 0;
  while (n < line.length) {
    const code = line.charCodeAt(n);
    if (code !== 32 && code !== 9) break;
    n++;
  }
  return n;
}

// True when the nearest preceding structural line indented strictly less than
// `idTokenIndent` is exactly a `permissions:` mapping key. Blank and comment
// lines carry no YAML structure and are skipped; the scan is bounded by
// MAX_ENCLOSING_SCAN_LINES and fails closed.
function hasEnclosingPermissionsMapping(text: string, lineStart: number, idTokenIndent: number): boolean {
  let cursor = lineStart; // start of the candidate's line; the previous line ends at cursor - 1 ("\n")
  let examined = 0;
  while (cursor > 0 && examined < MAX_ENCLOSING_SCAN_LINES) {
    const prevLineStart = text.lastIndexOf("\n", cursor - 2) + 1;
    let line = text.slice(prevLineStart, cursor - 1);
    if (line.endsWith("\r")) line = line.slice(0, -1); // CRLF ending
    examined++;
    cursor = prevLineStart;
    const indent = leadingWhitespaceLength(line);
    const rest = line.slice(indent);
    if (rest === "" || rest.startsWith("#")) continue; // blank or comment: not structural
    if (indent < idTokenIndent) return PERMISSIONS_KEY_LINE_RE.test(rest);
  }
  return false;
}

function isGitHubActionsIdTokenPermission(
  text: string,
  matchOffset: number,
  matchLength: number,
  leadQuote: string,
  key: string,
  separator: string,
  valueQuote: string,
  value: string,
): boolean {
  // Exact documented form: the key is lowercase `id-token` (ID-TOKEN and
  // Id-Token variants are not the GitHub Actions permission key).
  if (key !== "token") return false;
  const keyStart = matchOffset + leadQuote.length;
  const preceding = identifierRunBefore(text, keyStart);
  if (`${preceding}token` !== GITHUB_ACTIONS_ID_TOKEN_KEY) return false;
  // Bare block-YAML form only: unquoted key and value, exactly the permission
  // level `write`, and a colon + whitespace separator (no `=`, no flow).
  if (leadQuote !== "" || valueQuote !== "") return false;
  if (value !== GITHUB_ACTIONS_WRITE_LEVEL) return false;
  if (!/^[ \t]*:[ \t]+$/.test(separator)) return false;
  // The rest of the candidate line must be blank or a trailing comment: any
  // other same-line continuation means the value is not the bare level.
  const newlineAt = text.indexOf("\n", matchOffset + matchLength);
  let remainder = text.slice(matchOffset + matchLength, newlineAt === -1 ? undefined : newlineAt);
  if (remainder.endsWith("\r")) remainder = remainder.slice(0, -1); // CRLF ending
  if (!/^[ \t]*(?:#.*)?$/.test(remainder)) return false;
  // The candidate must sit alone on its line: only whitespace between the line
  // start and the full key (no list dash, flow brace, or other content).
  const lineStart = text.lastIndexOf("\n", matchOffset - 1) + 1;
  const fullKeyStart = keyStart - preceding.length;
  if (!/^[ \t]*$/.test(text.slice(lineStart, fullKeyStart))) return false;
  const idTokenIndent = fullKeyStart - lineStart;
  if (idTokenIndent === 0) return false; // top-level: nothing less-indented can enclose it
  return hasEnclosingPermissionsMapping(text, lineStart, idTokenIndent);
}

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
  redacted = redacted.replace(
    ASSIGNMENT_RE,
    (match, leadQuote: string, key: string, separator: string, valueQuote: string, value: string, _closingQuote: string, offset: number, text: string) => {
      if (isGitHubActionsIdTokenPermission(text, offset, match.length, leadQuote, key, separator, valueQuote, value)) return match;
      return `${leadQuote}${key}${separator}${valueQuote}[REDACTED]${valueQuote}`;
    },
  );
  return redacted;
}

export function redactBrowserToolInput(toolName: string, value: unknown): unknown {
  if (!isRecord(value)) return redactSensitiveValue(value);
  const normalized = toolName.trim().toLocaleLowerCase("en-US");
  const secretFields = normalized === "browserfill"
    ? new Set(["value"])
    : normalized === "browsertype"
      ? new Set(["text"])
      : normalized === "browserselect"
        ? new Set(["values"])
        : undefined;
  if (!secretFields) return redactSensitiveValue(value);
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    secretFields.has(childKey) ? "[REDACTED]" : redactSensitiveValue(child, childKey),
  ]));
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
