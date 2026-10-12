import { visibleTerminalText } from "./tool-result-text";

const registeredHosts = new WeakSet<object>();

/**
 * Prepare Markdown only for terminal display: keep CRLF line structure and
 * ordinary Markdown/backslashes, while making every other control visible.
 * The retained message and any model delivery always remain untouched.
 */
export function safeMarkdownDisplaySource(markdown: string): string {
  return markdown.replace(/\r\n/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (control) =>
    visibleTerminalText(control));
}

/**
 * Register the display-only adapter when the host exposes Pi's optional
 * native Markdown transformer API. The receiver is preserved and repeated
 * calls for the same ExtensionAPI object do not register duplicate work.
 */
export function registerSafeMarkdownDisplayTransformer(pi: unknown): boolean {
  if (!isRecord(pi)) return false;
  if (registeredHosts.has(pi)) return true;
  let register: unknown;
  try {
    register = pi.registerMarkdownTransformer;
  } catch {
    return false;
  }
  if (typeof register !== "function") return false;
  try {
    register.call(pi, safeMarkdownDisplaySource);
    registeredHosts.add(pi);
    return true;
  } catch {
    // Older or partial hosts keep the protected extension-owned popup; no
    // request data is changed and no model call is blocked.
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
